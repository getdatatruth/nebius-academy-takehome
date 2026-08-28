/**
 * Renders out/leads.csv as a spreadsheet-style page.
 *
 * The local n8n build writes rows to pass-through nodes rather than Google
 * Sheets, so there is nothing spreadsheet-shaped to inspect. This
 * renders the real output file, unmodified, into the view the `leads` tab
 * would show. No data is invented here: it reads whatever the last run wrote.
 *
 * Run: npm run sheet
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Proper CSV parse: quoted fields contain commas and newlines. */
function parseCsvStrict(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const rows = parseCsvStrict(await readFile(join(ROOT, 'out/leads.csv'), 'utf8'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Column order chosen for the walkthrough: identity, the score and its working,
// the benchmark decision, the two artifacts, then the gate outcome.
const COLS = [
  ['name', 'Name', 11],
  ['company', 'Company', 12],
  ['title', 'Title', 14],
  ['fit_score', 'Fit', 4],
  ['band', 'Band', 8],
  ['score_reasons', 'Score reasons (the working)', 30],
  ['benchmark_available', 'Bench?', 6],
  ['benchmark_segment', 'Segment', 16],
  ['benchmark_statement', 'Benchmark statement', 30],
  ['missing_seat', 'Missing seat', 7],
  ['draft_subject', 'Draft subject', 24],
  ['forwardable_note', 'Forwardable note', 30],
  ['gate_verdict', 'Gate', 6],
  ['failure_reason', 'Why it was blocked', 30],
  ['lane', 'Lane', 9],
  ['mode', 'Mode', 7],
  ['action_taken', 'Action taken', 18],
  ['cost_usd', 'Cost', 6],
];

const cell = (r, key) => {
  const v = r[key];
  if (key === 'gate_verdict') {
    const cls = v === 'PASS' ? 'ok' : v === 'FAIL' ? 'bad' : 'mute';
    return `<span class="pill ${cls}">${esc(v)}</span>`;
  }
  if (key === 'band') {
    const cls = v === 'HOT' ? 'hot' : v === 'MQL' ? 'mql' : 'mute';
    return `<span class="pill ${cls}">${esc(v)}</span>`;
  }
  if (key === 'benchmark_available') {
    return `<span class="pill ${v === 'true' ? 'ok' : 'warn'}">${v === 'true' ? 'YES' : 'WITHHELD'}</span>`;
  }
  if (key === 'mode') return `<span class="pill ${v === 'auto' ? 'ok' : 'mute'}">${esc(v)}</span>`;
  if (key === 'cost_usd' && v) return `$${esc(v)}`;
  return esc(v);
};

const html = `<title>leads</title>
<style>
  :root {
    --grid: #d7dde0; --head: #f1f4f5; --surface: #fff; --ink: #141c1f; --muted: #64757a;
    --ok: #1b7355; --ok-bg: #e2f1eb; --bad: #a32f2f; --bad-bg: #fae6e4;
    --warn: #96600f; --warn-bg: #fbf0da; --hot: #1d5b6e; --hot-bg: #e2edf1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --grid: #24312f; --head: #16211f; --surface: #101a19; --ink: #e6eeec; --muted: #93a6a3;
      --ok: #57c398; --ok-bg: #113026; --bad: #e5837a; --bad-bg: #341a19;
      --warn: #d9a44e; --warn-bg: #322610; --hot: #6fb9cc; --hot-bg: #16303a;
    }
  }
  :root[data-theme="dark"] {
    --grid: #24312f; --head: #16211f; --surface: #101a19; --ink: #e6eeec; --muted: #93a6a3;
    --ok: #57c398; --ok-bg: #113026; --bad: #e5837a; --bad-bg: #341a19;
    --warn: #d9a44e; --warn-bg: #322610; --hot: #6fb9cc; --hot-bg: #16303a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface); color: var(--ink);
    font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
  .bar { padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--grid); display: flex;
    align-items: baseline; gap: 1rem; flex-wrap: wrap; position: sticky; top: 0; background: var(--surface); z-index: 3; }
  .bar h1 { margin: 0; font-size: 1rem; font-weight: 650; }
  .bar span { color: var(--muted); font-size: 0.8rem; }
  .scroll { overflow: auto; max-height: calc(100vh - 3.4rem); }
  table { border-collapse: separate; border-spacing: 0; }
  th, td { border-right: 1px solid var(--grid); border-bottom: 1px solid var(--grid);
    padding: 0.5rem 0.6rem; vertical-align: top; text-align: left; }
  thead th { position: sticky; top: 0; background: var(--head); z-index: 2;
    font-size: 0.68rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted);
    font-weight: 600; white-space: nowrap; }
  tbody td { font-size: 0.78rem; }
  tbody td:first-child, thead th:first-child { position: sticky; left: 0; background: var(--surface); z-index: 1; font-weight: 600; }
  thead th:first-child { background: var(--head); z-index: 3; }
  tbody tr:hover td { background: var(--head); }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .wrap-cell { white-space: normal; min-width: 15rem; max-width: 26rem; color: var(--muted); }
  .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 2px; font-size: 0.68rem;
    font-weight: 700; letter-spacing: 0.04em; }
  .ok { background: var(--ok-bg); color: var(--ok); }
  .bad { background: var(--bad-bg); color: var(--bad); }
  .warn { background: var(--warn-bg); color: var(--warn); }
  .hot { background: var(--hot-bg); color: var(--hot); }
  .mql { background: var(--hot-bg); color: var(--hot); }
  .mute { background: var(--head); color: var(--muted); }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.95em; }
</style>
<div class="bar">
  <h1>leads</h1>
  <span>${rows.length} rows &middot; written by the workflow &middot; this is <code>out/leads.csv</code> rendered as the sheet tab</span>
</div>
<div class="scroll">
<table>
  <thead><tr>${COLS.map(([k, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
  <tbody>
    ${rows.map((r) => `<tr>${COLS.map(([k, , w]) => {
      const long = w >= 24;
      const cls = ['fit_score', 'cost_usd'].includes(k) ? 'num' : long ? 'wrap-cell' : '';
      return `<td class="${cls}">${cell(r, k)}</td>`;
    }).join('')}</tr>`).join('\n    ')}
  </tbody>
</table>
</div>
`;

await writeFile(join(ROOT, 'out/leads-sheet.html'), html);
console.log(`wrote out/leads-sheet.html: ${rows.length} rows, ${COLS.length} columns`);
