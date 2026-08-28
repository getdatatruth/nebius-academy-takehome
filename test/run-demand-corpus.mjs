/**
 * IDEA THREE - demand language harvesting.
 *
 * Every assessment submission appends its free-text stated priority to a
 * corpus. This job clusters that corpus and converts it into ad angles,
 * landing page headlines and an answer-engine prompt list, all in the words
 * buyers actually used rather than words marketing invented.
 *
 * SCOPE NOTE: the recurrence is stubbed. In production this is a weekly cron
 * over the accumulated corpus, not a script anyone runs by hand.
 *
 * This is also the seam between Track A and Track C. The hardest problem in
 * answer engine optimisation is knowing which prompts to monitor. Most teams
 * guess them. Track A generates them from real buyer language for free.
 *
 * Run: npm run demand
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from '../lib/csv.js';
import { DEMAND_CLUSTER_SYSTEM } from '../lib/prompts.js';
import { callAnthropic, DRAFT_MODEL, hasCredentials } from '../lib/llm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = join(ROOT, 'out/demand_corpus.csv');
const corpus = parseCsv(await readFile(corpusPath, 'utf8'));

console.log(`Clustering ${corpus.length} stated priorities`);
console.log(`LLM: ${hasCredentials() ? 'LIVE' : 'REPLAYED from test/fixtures'}\n`);

const { result, source } = await callAnthropic({
  model: DRAFT_MODEL,
  system: DEMAND_CLUSTER_SYSTEM,
  max_tokens: 4000,
  user: JSON.stringify(corpus.map((r) => ({ industry: r.industry, stated_priority: r.stated_priority })), null, 2),
  fixture: 'demand-clusters',
});

console.log(`(${source})\n`);
console.log('DEMAND THEMES, in buyer language');
for (const t of result.themes) {
  console.log(`\n  ${t.theme}  [n=${t.count}, ${t.industries.join(', ')}]`);
  t.buyer_phrases.forEach((p) => console.log(`    "${p}"`));
}

console.log('\n\nAD ANGLES');
for (const a of result.ad_angles) console.log(`  ${a.channel.padEnd(9)} ${a.headline}`);

console.log('\nLANDING PAGE HEADLINE VARIANTS, for the assessment itself');
for (const h of result.landing_page_headlines) console.log(`  ${h}`);

console.log('\nAEO PROMPT LIST, derived from buyer language rather than guessed keywords');
for (const p of result.aeo_prompt_list) console.log(`  ${p}`);

await writeFile(join(ROOT, 'out/demand_themes.json'), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(
  join(ROOT, 'out/aeo_prompt_list.csv'),
  toCsv(['prompt', 'source'], result.aeo_prompt_list.map((p) => ({ prompt: p, source: 'derived from assessment demand corpus' }))),
);
console.log('\nwrote out/demand_themes.json and out/aeo_prompt_list.csv');
