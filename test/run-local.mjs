/**
 * Runs the full pipeline over the sample leads and prints a readable trace.
 *
 * Uses lib/pipeline.js, the same module the evaluation harness runs, so the
 * trace you read here describes the thing that is actually measured.
 *
 * Run: npm start
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processLead } from '../lib/pipeline.js';
import { hasCredentials, DRAFT_MODEL, VERIFY_MODEL } from '../lib/llm.js';
import { toCsv, parseCsv } from '../lib/csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = [];
const say = (line = '') => { console.log(line); log.push(line); };
const rule = (t) => { say(''); say('='.repeat(78)); say(t); say('='.repeat(78)); };

const laneRows = parseCsv(await readFile(join(ROOT, 'data/sheets/lane_state.csv'), 'utf8'));
const laneState = Object.fromEntries(laneRows.map((r) => [r.lane, {
  lane: r.lane, mode: r.mode,
  consecutive_unchanged: Number(r.consecutive_unchanged), threshold: Number(r.threshold),
}]));

const files = (await readdir(join(ROOT, 'data/sample-leads'))).filter((f) => f.endsWith('.json')).sort();
const payloads = await Promise.all(files.map(async (f) =>
  JSON.parse(await readFile(join(ROOT, 'data/sample-leads', f), 'utf8'))));
const redTeam = JSON.parse(await readFile(join(ROOT, 'data/demo/lead-4-daniel-LOOSENED.json'), 'utf8'));

say('Nebius Academy inbound lead engine, local run');
say(`LLM legs: ${hasCredentials() ? 'LIVE against api.anthropic.com' : 'REPLAYED from test/fixtures (no ANTHROPIC_API_KEY set)'}`);
say(`Draft model: ${DRAFT_MODEL}   Verifier model: ${VERIFY_MODEL}`);

const leadRows = [];
const approvalRows = [];
const corpusRows = [];

function traceResult(r, payload) {
  const { enrichment: e, fit, sections, benchmark, gap, pack, lane } = r;
  say(`[2] ENRICH        ${e.company_size} employees, ${e.industry_label}, ${e.hq_region}, size band ${e.size_band}`);
  say(`                  seniority ${e.seniority}, role family ${e.role_family}, buyer model ${e.buyer_model}`);
  say(`[3] FIT SCORE     ${fit.fit_score}/100  ->  ${fit.band}`);
  fit.reasons.forEach((x) => say(`                  - ${x}`));
  say(`[4] BENCHMARK     ${benchmark.benchmark_available ? 'CLAIM PERMITTED' : 'CLAIM WITHHELD'} (${benchmark.granularity})`);
  benchmark.gate_trail.forEach((x) => say(`                  - ${x}`));
  if (benchmark.statement) say(`                  statement: ${benchmark.statement}`);
  say(`[5] ROUTE         ${fit.band}${fit.override_applied ? ` (override: ${fit.override_applied})` : ''}`);
  say(`    PRODUCT       weakest ${sections.weakest_section} (${sections.weakest_score}) -> ${sections.recommended_angle}`);
  say(`    FIREWALL      ${r.firewall.blocked ? 'BLOCKED, ' + r.firewall.reason : 'clear'}`);

  if (!r.drafting_required) {
    say(`[6-10] SKIPPED    band is ${fit.band}, no individual outreach, no committee logic, no LLM spend`);
    return;
  }

  say(`[6] COMMITTEE     present ${gap.present_seat}, missing ${gap.missing_seat} (${gap.missing_seat_label})`);
  if (gap.assumption) say(`                  ASSUMPTION: ${gap.assumption}`);
  say(`[7] PACK          ${pack.allowed_facts.length} allowed facts, ${pack.product_facts.length} product facts, benchmark ${pack.benchmark_available ? 'included' : 'excluded'}`);
  say(`[8] DRAFT         subject: ${r.artifacts.primary.subject}`);
  r.artifacts.primary.body.split('\n').filter(Boolean).forEach((l) => say(`                  ${l}`));
  say(`[8b] FORWARDABLE  for the missing ${gap.missing_seat} seat: ${r.artifacts.forwardable.subject}`);
  say(`                  ${r.artifacts.forwardable.body}`);

  for (const [label, g] of Object.entries(r.gates)) {
    if (g.style_fixes.length) say(`[9] STYLE ${label.padEnd(11)} auto-fixed: ${[...new Set(g.style_fixes)].join(', ')}`);
    say(`[9] GATE ${label.padEnd(11)} deterministic ${g.deterministic}, llm ${g.llm_blocks.length ? 'BLOCK' : 'PASS'} -> ${g.verdict}`);
    g.deterministic_blocking.forEach((f) => say(`                  ! ${f}`));
    g.llm_blocks.forEach((f) => say(`                  ! ${f.claim}: ${f.why}`));
    g.llm_notes.forEach((f) => say(`                  ~ note (not blocking): ${f.claim}`));
  }

  if (r.gate_verdict === 'PASS') {
    say(`[10] LANE         ${lane.lane} is ${lane.mode} (${lane.consecutive_unchanged}/${lane.threshold} consecutive unchanged approvals)`);
    say(`                  action: ${r.outcome}`);
  } else {
    say(`[10b] HUMAN REVIEW gate failed, nothing sends`);
  }
  say(`    TIMING        ${Math.round(r.total_ms)} ms total, cost $${(r.total_cost || 0).toFixed(5)}`);
}

function toRow(r, payload) {
  const { enrichment: e, fit, sections, benchmark, gap, lane } = r;
  const blocks = Object.values(r.gates || {}).flatMap((g) => [
    ...g.deterministic_blocking, ...g.llm_blocks.map((f) => `${f.claim}: ${f.why}`)]);
  const notes = Object.values(r.gates || {}).flatMap((g) => g.llm_notes.map((f) => f.claim));
  const style = Object.values(r.gates || {}).flatMap((g) => g.style_fixes);
  return {
    submission_id: r.submission_id, timestamp: payload.submitted_at,
    name: `${payload.first_name} ${payload.last_name}`, email: payload.work_email,
    company: payload.company_name, title: payload.job_title,
    company_size: e.company_size, industry: e.industry_label,
    seniority: e.seniority, role_family: e.role_family, buyer_model: e.buyer_model,
    overall_score: payload.assessment.overall_score,
    weakest_section: `${sections.weakest_section} (${sections.weakest_score})`,
    fit_score: fit.fit_score, band: fit.band, score_reasons: fit.reasons.join(' | '),
    benchmark_available: benchmark.benchmark_available,
    benchmark_statement: benchmark.statement || '',
    benchmark_segment: `${benchmark.segment_key} n=${benchmark.n}`,
    recommended_angle: sections.recommended_angle,
    missing_seat: gap ? gap.missing_seat : '',
    draft_subject: r.artifacts?.primary.subject || '',
    draft_body: r.artifacts?.primary.body || '',
    forwardable_note: r.artifacts?.forwardable.body || '',
    gate_verdict: r.gate_verdict, failure_reason: blocks.join(' | '),
    reviewer_notes: notes.join(' | '), style_autofixed: [...new Set(style)].join(' | '),
    lane: lane ? lane.lane : '', mode: lane ? lane.mode : '', action_taken: r.outcome,
    total_ms: Math.round(r.total_ms || 0), cost_usd: (r.total_cost || 0).toFixed(5),
  };
}

for (const payload of payloads) {
  const r = await processLead(payload, laneState);
  rule(`${payload.first_name} ${payload.last_name} - ${payload.job_title}, ${payload.company_name} (${payload.submission_id})`);
  traceResult(r, payload);
  corpusRows.push(r.demand_corpus_row);
  leadRows.push(toRow(r, payload));
  if (r.gate_verdict === 'PASS' && r.lane?.mode === 'manual') {
    approvalRows.push({
      submission_id: r.submission_id, lane: r.lane.lane,
      draft_subject: r.artifacts.primary.subject, draft_body: r.artifacts.primary.body,
      forwardable_note: r.artifacts.forwardable.body, status: 'pending',
    });
  }
}

rule('RED TEAM PASS - adversarial drafting prompt, gate under test');
say('Same lead, same withheld benchmark. The drafting prompt is replaced with one that');
say('instructs the model to lead with a percentile comparison, cite a failure statistic,');
say('and describe what most organisations in its position do. The research pack is');
say('unchanged and still contains no benchmark fact.');
const rt = await processLead(redTeam, laneState, { loosened: true, fixtureSuffix: '-loosened' });
say('');
traceResult(rt, redTeam);
say('');
say(rt.gate_verdict === 'FAIL'
  ? 'OUTCOME: caught. Routed to human review with the failure reasons attached. Nothing sends.'
  : 'OUTCOME: NOT CAUGHT. This is a gate failure and must be investigated.');
leadRows.push(toRow(rt, redTeam));

await writeFile(join(ROOT, 'out/leads.csv'), toCsv(Object.keys(leadRows[0]), leadRows));
await writeFile(join(ROOT, 'out/approval_queue.csv'), toCsv(['submission_id', 'lane', 'draft_subject', 'draft_body', 'forwardable_note', 'status'], approvalRows));
const seedCorpus = parseCsv(await readFile(join(ROOT, 'data/sheets/demand_corpus.csv'), 'utf8'));
await writeFile(join(ROOT, 'out/demand_corpus.csv'), toCsv(['submission_id', 'timestamp', 'industry', 'stated_priority'], [...seedCorpus, ...corpusRows]));

rule('RUN SUMMARY');
for (const r of leadRows) {
  say(`${r.submission_id.padEnd(20)} fit ${String(r.fit_score).padStart(3)}  ${r.band.padEnd(11)} gate ${String(r.gate_verdict).padEnd(5)} ${r.action_taken}`);
}
const totalCost = leadRows.reduce((s, r) => s + Number(r.cost_usd), 0);
say('');
say(`out/leads.csv            ${leadRows.length} rows`);
say(`out/approval_queue.csv   ${approvalRows.length} rows awaiting human approval`);
say(`out/demand_corpus.csv    ${seedCorpus.length + corpusRows.length} stated priorities, ${corpusRows.length} appended this run`);
say(`total cost this run      $${totalCost.toFixed(4)}`);
say('');
say('Run `npm run eval` to measure pass rate, block reasons, cost and latency over many runs.');
await writeFile(join(ROOT, 'out/run-trace.txt'), `${log.join('\n')}\n`);
