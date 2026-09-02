import { fileURLToPath } from 'node:url';
import path from 'node:path';
import api, { route } from '@forge/api';
// Import pdf-parse's inner module directly, not the package entrypoint.
// The entrypoint runs a debug self-test guarded by `!module.parent`, which
// is true under Forge's bundler and throws trying to read a test fixture
// that isn't part of the bundle.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { createWorker } from 'tesseract.js';

// NOTE ON tesseract.js IN FORGE: tesseract.js's Node build loads its WASM
// engine and spawns its recognizer on a worker_threads.Worker pointed at a
// *separate file* inside node_modules, and loads the WASM core binary via a
// runtime fs.readFileSync() call rather than a static import. Forge's
// function bundler compiles each handler into a single JS file following
// static import/require references, so it is not guaranteed to carry along
// files that are only ever referenced via a dynamic runtime path (the
// worker-script file, the .wasm binaries). This is a known pain point for
// tesseract.js on other single-file bundlers/serverless platforms (hence the
// existence of third-party "serverless-tesseract" packaging plugins).
// Everything below is implemented against tesseract.js's documented API and
// works locally under plain Node, but this integration MUST be verified with
// `forge deploy` + a real test issue before being relied on — if the worker
// or core fails to load in Forge's sandbox, readAttachment() below reports
// that per-image as a clean "Failed to extract content" error rather than
// crashing the whole request.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Bundled English language data (avoids any network fetch at runtime, which
// would otherwise need an egress permission entry in manifest.yml).
const TESSDATA_PATH = path.join(__dirname, 'tessdata');

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB
// OCR is much slower than the other parsers and Forge functions have a hard
// ~25s execution timeout, so images get a smaller cap to keep recognition
// time (plus cold-start engine load) comfortably inside that budget.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB
const MAX_TEXT_CHARS = 20000;

const SUPPORTED_PARSERS = {
  'application/pdf': parsePdf,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': parseDocx,
  'text/plain': parseText,
  'text/markdown': parseText,
  'text/x-markdown': parseText,
  'text/csv': parseText,
  'application/json': parseText,
  'image/png': parseImage,
  'image/jpeg': parseImage,
  // Modern .xlsx only. Legacy binary .xls (application/vnd.ms-excel) isn't
  // supported — exceljs doesn't read that format.
  //
  // Deliberately using exceljs here instead of the more commonly reached-for
  // "xlsx" (SheetJS) package: the last version SheetJS published to npm,
  // 0.18.5, has two unpatched high-severity advisories (prototype pollution
  // GHSA-4r6h-8v6p-xvw6 and ReDoS GHSA-5pgg-2g8v-p4x9) that are directly
  // triggerable by a crafted file — exactly the input this handler feeds it,
  // since every spreadsheet here comes from a Jira attachment any issue
  // watcher could have uploaded. SheetJS's fix only ships from their own CDN,
  // not npm. exceljs has no vulnerability in its own parsing path.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    parseExcel,
};

export async function handler(payload) {
  const { issueIdOrKey, attachmentId } = payload ?? {};

  if (!issueIdOrKey) {
    return { success: false, error: 'issueIdOrKey is required.' };
  }

  let attachments;
  try {
    attachments = await getIssueAttachments(issueIdOrKey);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const targets = attachmentId
    ? attachments.filter((a) => String(a.id) === String(attachmentId))
    : attachments;

  if (attachmentId && targets.length === 0) {
    return {
      success: false,
      error: `Attachment ${attachmentId} not found on issue ${issueIdOrKey}.`,
    };
  }

  const results = await Promise.all(targets.map(readAttachment));

  return {
    success: true,
    issueIdOrKey,
    attachmentCount: attachments.length,
    attachments: results,
  };
}

async function getIssueAttachments(issueIdOrKey) {
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=attachment`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to load issue ${issueIdOrKey}: ${res.status} ${body}`
    );
  }

  const { fields } = await res.json();
  return fields?.attachment ?? [];
}

async function readAttachment(attachment) {
  const { id, filename, mimeType, size } = attachment;
  const base = { id, filename, mimeType, size };

  const parser = SUPPORTED_PARSERS[mimeType];
  if (!parser) {
    return {
      ...base,
      supported: false,
      reason: `Unsupported attachment type: ${mimeType}`,
    };
  }

  const maxBytes = mimeType.startsWith('image/')
    ? MAX_IMAGE_BYTES
    : MAX_ATTACHMENT_BYTES;
  if (size > maxBytes) {
    return {
      ...base,
      supported: true,
      error: `Attachment exceeds ${
        maxBytes / (1024 * 1024)
      }MB limit (${(size / (1024 * 1024)).toFixed(1)}MB) and was skipped.`,
    };
  }

  try {
    const buffer = await downloadAttachmentContent(id);
    let text = await parser(buffer);
    const truncated = text.length > MAX_TEXT_CHARS;
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
    return { ...base, supported: true, text, truncated };
  } catch (err) {
    return {
      ...base,
      supported: true,
      error: `Failed to extract content: ${err.message}`,
    };
  }
}

async function downloadAttachmentContent(attachmentId) {
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/attachment/content/${attachmentId}`);

  if (!res.ok) {
    throw new Error(`Download failed with status ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function parseText(buffer) {
  return buffer.toString('utf-8');
}

async function parsePdf(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

async function parseDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

function excelCellToText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((run) => run.text).join('');
    }
    // Formula cell: prefer the cached result; fall back to the formula
    // itself if the workbook was saved without one.
    if ('result' in value) return excelCellToText(value.result);
    if ('formula' in value) return `=${value.formula}`;
    if ('text' in value) return String(value.text); // hyperlink
    if ('error' in value) return `#ERROR(${value.error})`;
  }
  return String(value);
}

async function parseExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheetTexts = [];
  workbook.eachSheet((worksheet) => {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(excelCellToText(cell.value));
      });
      rows.push(cells.join('\t'));
    });
    sheetTexts.push(`# Sheet: ${worksheet.name}\n${rows.join('\n')}`);
  });

  const text = sheetTexts.join('\n\n').trim();
  if (!text) {
    throw new Error('No readable content found in the spreadsheet.');
  }
  return text;
}

// Reused across attachments (and, on a warm Forge invocation, across
// requests) so multiple images in one call don't each pay engine load cost.
let ocrWorkerPromise;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker('eng', 1, {
      langPath: TESSDATA_PATH,
      gzip: true,
      cacheMethod: 'none', // read the bundled traineddata directly, no cache r/w
    }).catch((err) => {
      // Let the next call retry instead of permanently caching a failed init.
      ocrWorkerPromise = undefined;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

async function parseImage(buffer) {
  const worker = await getOcrWorker();
  const {
    data: { text },
  } = await worker.recognize(buffer);
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error('No readable text was detected in the image.');
  }
  return trimmed;
}
