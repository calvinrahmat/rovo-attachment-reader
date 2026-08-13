import api, { route } from '@forge/api';
// Import pdf-parse's inner module directly, not the package entrypoint.
// The entrypoint runs a debug self-test guarded by `!module.parent`, which
// is true under Forge's bundler and throws trying to read a test fixture
// that isn't part of the bundle.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_TEXT_CHARS = 20000;

const SUPPORTED_PARSERS = {
  'application/pdf': parsePdf,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': parseDocx,
  'text/plain': parseText,
  'text/markdown': parseText,
  'text/x-markdown': parseText,
  'text/csv': parseText,
  'application/json': parseText,
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

  if (size > MAX_ATTACHMENT_BYTES) {
    return {
      ...base,
      supported: true,
      error: `Attachment exceeds ${
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
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
