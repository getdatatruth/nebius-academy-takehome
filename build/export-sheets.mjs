/**
 * Generates the Google Sheets seed tabs from the engine tables, so the sheet
 * and the scoring code can never drift apart. Run: npm run sheets
 */
import { writeFile } from 'node:fs/promises';
import { BENCHMARK_TABLE, INDUSTRY_LABELS } from '../lib/engine.js';
import { toCsv } from '../lib/csv.js';

const SECTIONS = ['strategy', 'skills', 'tooling', 'governance'];
const headers = ['segment_key', 'n', ...SECTIONS.flatMap((s) => [`p25_${s}`, `p50_${s}`, `p75_${s}`])];

const rows = Object.entries(BENCHMARK_TABLE).map(([segment_key, row]) => {
  const out = { segment_key, n: row.n };
  for (const s of SECTIONS) {
    const [p25, p50, p75] = row[s];
    out[`p25_${s}`] = p25; out[`p50_${s}`] = p50; out[`p75_${s}`] = p75;
  }
  return out;
});

await writeFile(new URL('../data/sheets/benchmark.csv', import.meta.url), toCsv(headers, rows));

/* A pre-seeded slice of the demand corpus. In production every completion
 * appends here, including the leads that are never emailed. */
const corpus = [
  ['seed_0001', 'financial_services', 'We bought licences for everyone and usage fell off a cliff after month two'],
  ['seed_0002', 'financial_services', 'Compliance will not sign off on anything customer facing until someone owns the risk'],
  ['seed_0003', 'logistics', 'Pilots keep dying when the person who championed them moves on'],
  ['seed_0004', 'software', 'Engineers are shipping AI features faster than we can review them'],
  ['seed_0005', 'gaming', 'Nobody can tell me which of our AI experiments are actually worth continuing'],
  ['seed_0006', 'telecommunications', 'Our managers do not know what to delegate to AI and what to keep'],
  ['seed_0007', 'professional_services', 'Clients are asking what our AI capability is and we do not have a straight answer'],
  ['seed_0008', 'software', 'We have the models, we do not have people who can redesign the workflow around them'],
  ['seed_0009', 'financial_services', 'Training happened, nothing changed in how the work is actually done'],
  ['seed_0010', 'logistics', 'Every team is doing its own thing with AI and none of it joins up'],
  ['seed_0011', 'gaming', 'We need our leads to be able to tell good AI output from plausible rubbish'],
  ['seed_0012', 'telecommunications', 'The tools moved on again and the training we ran last year is already out of date'],
  ['seed_0013', 'professional_services', 'Getting the team using AI without everything sounding the same'],
  ['seed_0014', 'financial_services', 'We cannot measure whether any of this has made anyone more productive'],
].map(([submission_id, industry, stated_priority]) => ({
  submission_id, timestamp: '2026-08-20T00:00:00Z',
  industry: INDUSTRY_LABELS[industry], stated_priority,
}));

await writeFile(
  new URL('../data/sheets/demand_corpus.csv', import.meta.url),
  toCsv(['submission_id', 'timestamp', 'industry', 'stated_priority'], corpus),
);

console.log(`wrote benchmark.csv (${rows.length} segments) and demand_corpus.csv (${corpus.length} seed statements)`);
