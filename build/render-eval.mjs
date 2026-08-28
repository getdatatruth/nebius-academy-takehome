/**
 * Renders out/eval-report.md as a browser page for easier reading.
 * Run: npm run evalpage
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = await readFile(join(ROOT, 'out/eval-report.md'), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const out = [];
let inTable = false;
for (const raw of md.split('\n')) {
  const line = raw.trimEnd();
  const isRow = /^\|.*\|$/.test(line);
  const isSep = /^\|[\s\-:|]+\|$/.test(line);
  if (isRow && isSep) continue;
  if (isRow) {
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (!inTable) { out.push('<table><tbody>'); inTable = true; }
    const tag = out[out.length - 1] === '<table><tbody>' ? 'th' : 'td';
    out.push(`<tr>${cells.map((c) => `<${tag}>${esc(c).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')}</${tag}>`).join('')}</tr>`);
    continue;
  }
  if (inTable) { out.push('</tbody></table>'); inTable = false; }
  if (!line) { continue; }
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) { out.push(`<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`); continue; }
  out.push(`<p>${esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')}</p>`);
}
if (inTable) out.push('</tbody></table>');

await writeFile(join(ROOT, 'out/eval-report.html'), `<title>Evaluation report</title>
<style>
  :root { --bg:#fff; --ink:#141c1f; --muted:#5f7074; --grid:#dbe2e4; --head:#f2f5f6; --accent:#1d5b6e; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#101819; --ink:#e6eeee; --muted:#93a6a8; --grid:#243233; --head:#16211f; --accent:#6fb9cc; } }
  :root[data-theme="dark"] { --bg:#101819; --ink:#e6eeee; --muted:#93a6a8; --grid:#243233; --head:#16211f; --accent:#6fb9cc; }
  body { background:var(--bg); color:var(--ink); margin:0; padding:2.5rem 1.5rem 6rem;
    font:16px/1.6 ui-serif, Georgia, serif; }
  main { max-width:52rem; margin:0 auto; }
  h1 { font:650 1.9rem/1.15 ui-sans-serif,-apple-system,sans-serif; margin:0 0 1.5rem; letter-spacing:-0.02em; }
  h2 { font:650 1.25rem/1.2 ui-sans-serif,-apple-system,sans-serif; margin:2.5rem 0 0.9rem; letter-spacing:-0.01em; }
  p { margin:0 0 0.8rem; color:var(--ink); }
  table { border-collapse:collapse; width:100%; margin:0.6rem 0 1.4rem; font:14px/1.45 ui-sans-serif,-apple-system,sans-serif; }
  th,td { border:1px solid var(--grid); padding:0.55rem 0.75rem; text-align:left; }
  th { background:var(--head); font-size:0.7rem; letter-spacing:0.07em; text-transform:uppercase; color:var(--muted); }
  td b { color:var(--accent); }
  code { font-family:ui-monospace,Menlo,monospace; font-size:0.88em; background:var(--head); padding:0.1em 0.3em; }
</style>
<main>${out.join('\n')}</main>
`);
console.log('wrote out/eval-report.html');
