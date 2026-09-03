// One-off generator: builds RUNBOOK.xlsx from the same content as RUNBOOK.md.
// Re-run after editing either source of truth to keep them in sync:
//   node gen_runbook_xlsx.mjs
import ExcelJS from 'exceljs';

const GENERATED_AT = new Date();

const workbook = new ExcelJS.Workbook();
workbook.creator = 'Attachment Reader deploy runbook';
workbook.created = GENERATED_AT;

// ---------------------------------------------------------------- Steps ---
const steps = workbook.addWorksheet('Deploy Steps', {
  views: [{ state: 'frozen', ySplit: 3 }],
});

steps.mergeCells('A1:F1');
steps.getCell('A1').value = 'Attachment Reader — Production Deploy Runbook';
steps.getCell('A1').font = { bold: true, size: 14 };

steps.mergeCells('A2:F2');
steps.getCell('A2').value = `Generated: ${GENERATED_AT.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
steps.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };

const headerRow = steps.getRow(3);
headerRow.values = ['#', 'Phase', 'Action', 'Command / Details', 'Est. Time', 'Notes'];
headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
headerRow.eachCell((cell) => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  cell.alignment = { vertical: 'middle', wrapText: true };
});

const rows = [
  [1, '0. Prerequisites', 'Check Forge CLI is current', 'forge --version (update: npm install -g @forge/cli@latest)', '2 min', ''],
  [2, '0. Prerequisites', 'Confirm logged-in account has contributor access', 'forge whoami', '2 min', 'Wrong account is the most common cause of step 4 failures'],
  [3, '1. Confirm target app', 'Check App ID in Developer Console matches manifest.yml', 'Console → org → app → App details → App ID', '3 min', 'Different orgs can each have their own registration of this code'],
  [4, '1. Confirm target app', 'Sanity-check CLI can see the app', 'forge environments list / forge install list', '2 min', 'Must succeed before proceeding — auth error means wrong app ID or wrong account'],
  [5, '2. Pre-flight', 'Lint the app', 'forge lint', '1 min', 'Fix any findings before deploying'],
  [6, '2. Pre-flight', 'Sync dependencies', 'npm install', '2 min', 'Ensures node_modules matches package-lock.json'],
  [7, '3. Deploy', 'Deploy to development', 'forge deploy -e development', '2 min', ''],
  [8, '3. Deploy', 'Smoke test on development', 'Exercise the agent/action against a real issue', '10 min', 'Whatever site already has development installed'],
  [9, '3. Deploy', 'Deploy to staging', 'forge deploy -e staging', '2 min', ''],
  [10, '3. Deploy', 'Smoke test on staging', 'Exercise the agent/action against a real issue', '10 min', ''],
  [11, '3. Deploy', 'Deploy to production', 'forge deploy -e production', '2 min', 'Only after dev + staging both pass'],
  [12, '4. Install', 'Install or upgrade on target site (admin)', 'forge install -e production -s <site> -p Jira --confirm-scopes\n(add --upgrade for an existing install)', '3 min', 'Use the "you have admin" path'],
  [13, '4. Install', 'Install on target site (no admin)', 'Share the distribution link from the Developer Console with a site admin', 'Depends on admin', 'developer.atlassian.com/console/myapps/<app-id>/distribution'],
  [14, '5. Verify', 'Functional test every attachment type', 'PDF, DOCX, XLSX, TXT/CSV/JSON/Markdown, PNG/JPEG (OCR)', '15 min', 'Image OCR is the highest-risk path — see Known Risks tab'],
  [15, '5. Verify', 'Check logs for errors', 'forge logs -e production -s <site> -g', '5 min', ''],
  [16, '5. Verify', 'Roll back if needed', 'forge deploy list --json → forge deploy -e production -t <tag>', '5 min', 'Redeploys old code only; does not touch data'],
];

rows.forEach((r) => {
  const row = steps.addRow(r);
  row.alignment = { vertical: 'top', wrapText: true };
});

steps.columns = [
  { width: 4 },
  { width: 16 },
  { width: 30 },
  { width: 48 },
  { width: 14 },
  { width: 40 },
];

const totalMin = 2 + 2 + 3 + 2 + 1 + 2 + 2 + 10 + 2 + 10 + 2 + 3 + 15 + 5 + 5; // excludes "depends on admin" step
const totalRow = steps.addRow(['', '', '', 'Estimated active hands-on time (excludes admin wait)', `~${totalMin} min`, '']);
totalRow.font = { bold: true };
steps.getCell(`E${totalRow.number}`).alignment = { horizontal: 'right' };

// ------------------------------------------------------------ Risks tab ---
const risks = workbook.addWorksheet('Known Risks');
risks.mergeCells('A1:C1');
risks.getCell('A1').value = 'Known Risks';
risks.getCell('A1').font = { bold: true, size: 14 };

const riskHeader = risks.getRow(2);
riskHeader.values = ['Risk', 'Detail', 'Mitigation'];
riskHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
riskHeader.eachCell((cell) => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  cell.alignment = { vertical: 'middle', wrapText: true };
});

const riskRows = [
  [
    'Image OCR — bundling failure, refixed, needs redeploy to confirm',
    "Two real, distinct __dirname-based path failures hit in production (tesseract.js's own workerPath default, then our own import.meta.url-based override) proved Forge's bundler preserves no module's real self-location. An earlier 'confirmed working' note was based on a chat success that was likely Rovo's native image-viewing, not this action.",
    'Fixed by never computing a path to an existing file: gen_ocr_assets.mjs embeds a custom worker bundle + WASM core + trained data as base64; index.js writes them to os.tmpdir() at call time and spawns from there. Validated locally end-to-end (PNG+JPEG) but NOT yet confirmed on a real Forge deploy — redeploy and re-test before trusting it.',
  ],
  [
    'Image size / OCR timeout',
    'Images are capped at 3MB (vs 5MB for other types) and OCR runs inside Forge’s ~25s function timeout.',
    'Keep test images small; a dense/large image can still time out even under the cap.',
  ],
  [
    'Legacy .xls not supported',
    'Only modern .xlsx is read (via exceljs) — legacy binary Excel (.xls, application/vnd.ms-excel) is not.',
    'Ask users to re-save as .xlsx, or add a legacy-format library if this becomes a real need.',
  ],
  [
    'Read-only scope',
    'The app only requests read:jira-work.',
    'It cannot write back to issues — no scope changes needed for this deploy.',
  ],
];

riskRows.forEach((r) => {
  const row = risks.addRow(r);
  row.alignment = { vertical: 'top', wrapText: true };
});

risks.columns = [{ width: 30 }, { width: 60 }, { width: 45 }];

await workbook.xlsx.writeFile('RUNBOOK.xlsx');
console.log('Wrote RUNBOOK.xlsx');
