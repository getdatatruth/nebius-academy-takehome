/**
 * Evaluation harness.
 *
 * The build can tell you the gate blocks things. Without this it cannot tell
 * you how often, on what grounds, at what cost, or whether a prompt change made
 * anything better. That gap is the difference between wiring an agent up and
 * operating one.
 *
 * Runs every sample lead N times, plus the adversarial red team payload, and
 * reports:
 *   - gate pass rate, overall and per lane
 *   - distribution of block reasons, by layer
 *   - red team catch rate, which is the number that must stay at 100 percent
 *   - cost and token spend per lead
 *   - latency per stage, p50 and p95
 *   - style autofix frequency
 *
 * Writes out/eval-report.json and out/eval-report.md, and diffs against the
 * previous report when one exists, so a prompt change can be judged rather
 * than guessed at.
 *
 *   npm run eval            3 runs per lead
 *   npm run eval -- 10      10 runs per lead
 */
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processLead, blockReasons } from '../lib/pipeline.js';
import { hasCredentials, DRAFT_MODEL } from '../lib/llm.js';
import { parseCsv } from '../lib/csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.argv[2]) || 3;

const laneRows = parseCsv(await readFile(join(ROOT, 'data/sheets/lane_state.csv'), 'utf8'));
const laneState = Object.fromEntries(laneRows.map((r) => [r.lane, {
  lane: r.lane, mode: r.mode,
  consecutive_unchanged: Number(r.consecutive_unchanged), threshold: Number(r.threshold),
}]));

const files = (await readdir(join(ROOT, 'data/sample-leads'))).filter((f) => f.endsWith('.json')).sort();
const leads = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(ROOT, 'data/sample-leads', f), 'utf8'))));
const redTeam = JSON.parse(await readFile(join(ROOT, 'data/demo/lead-4-daniel-LOOSENED.json'), 'utf8'));

console.log(`Evaluation harness`);
console.log(`${RUNS} runs x ${leads.length} leads, plus the red team payload each run`);
console.log(`Mode: ${hasCredentials() ? `LIVE against ${DRAFT_MODEL}` : 'REPLAYED from fixtures, cost and latency will read as zero'}`);
console.log('');

const observations = [];
const errors = [];

/**
 * An evaluation harness that dies on the first anomaly measures nothing. A
 * malformed model response, a rate limit, a dropped connection: all routine at
 * volume, all recorded as observations rather than allowed to end the run.
 */
async function observe(run, kind, lead, opts) {
  try {
    const r = await processLead(lead, laneState, opts);
    observations.push({ run, kind, ...r });
    if (kind === 'red_team') return r.gate_verdict === 'FAIL' ? '!' : '?';
    return r.gate_verdict === 'PASS' ? '.' : (r.gate_verdict === 'n/a' ? '-' : 'x');
  } catch (err) {
    errors.push({
      run, kind, submission_id: lead.submission_id,
      code: err.code || 'UNKNOWN', message: String(err.message).slice(0, 300),
    });
    observations.push({ run, kind, submission_id: lead.submission_id, errored: true, error_code: err.code || 'UNKNOWN' });
    return 'E';
  }
}

for (let run = 1; run <= RUNS; run++) {
  process.stdout.write(`run ${run}/${RUNS} `);
  for (const lead of leads) process.stdout.write(await observe(run, 'sample', lead, {}));
  process.stdout.write(await observe(run, 'red_team', redTeam, { loosened: true, fixtureSuffix: '-loosened' }));
  console.log('');
}
console.log('');

/* ---------------- aggregation ---------------- */

const drafted = observations.filter((o) => o.drafting_required && o.kind === 'sample' && !o.errored);
const redTeamRuns = observations.filter((o) => o.kind === 'red_team' && !o.errored);
const attempted = observations.filter((o) => !o.errored || o.kind !== 'sample' || true).length;

const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
};

const passRate = pct(drafted.filter((o) => o.gate_verdict === 'PASS').length, drafted.length);

const perLane = {};
for (const o of drafted) {
  const key = o.lane?.lane || 'unknown';
  perLane[key] ??= { lane: key, mode: o.lane?.mode, total: 0, passed: 0 };
  perLane[key].total++;
  if (o.gate_verdict === 'PASS') perLane[key].passed++;
}
for (const l of Object.values(perLane)) l.pass_rate = pct(l.passed, l.total);

const perLead = {};
for (const o of drafted) {
  perLead[o.submission_id] ??= { submission_id: o.submission_id, total: 0, passed: 0, costs: [], ms: [] };
  const p = perLead[o.submission_id];
  p.total++;
  if (o.gate_verdict === 'PASS') p.passed++;
  p.costs.push(o.total_cost || 0);
  p.ms.push(o.total_ms || 0);
}
for (const p of Object.values(perLead)) {
  p.pass_rate = pct(p.passed, p.total);
  p.mean_cost = p.costs.reduce((a, b) => a + b, 0) / p.costs.length;
  p.p50_ms = quantile(p.ms, 0.5);
}

const reasonCounts = {};
for (const o of [...drafted, ...redTeamRuns]) {
  for (const r of blockReasons(o)) {
    const key = `${r.layer} | ${r.reason}`;
    reasonCounts[key] ??= { layer: r.layer, reason: r.reason, count: 0, on_red_team: 0 };
    reasonCounts[key].count++;
    if (o.kind === 'red_team') reasonCounts[key].on_red_team++;
  }
}
const reasons = Object.values(reasonCounts).sort((a, b) => b.count - a.count);

const styleFixCount = drafted.filter((o) =>
  Object.values(o.gates || {}).some((g) => g.style_fixes.length)).length;

const redTeamCaught = redTeamRuns.filter((o) => o.gate_verdict === 'FAIL').length;
const redTeamDeterministicCaught = redTeamRuns.filter((o) =>
  Object.values(o.gates || {}).some((g) => g.deterministic === 'BLOCK')).length;

const stageTimes = {};
for (const o of [...drafted, ...redTeamRuns]) {
  for (const [stage, ms] of Object.entries(o.timings || {})) {
    (stageTimes[stage] ??= []).push(ms);
  }
}

const costs = [...drafted, ...redTeamRuns].map((o) => o.total_cost || 0).filter((c) => c > 0);
const meanCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;

const report = {
  generated_for_runs: RUNS,
  mode: hasCredentials() ? 'live' : 'fixture',
  model: DRAFT_MODEL,
  drafted_observations: drafted.length,
  gate_pass_rate: passRate,
  per_lane: Object.values(perLane),
  per_lead: Object.values(perLead).map(({ costs: _c, ms: _m, ...rest }) => rest),
  block_reasons: reasons,
  style_autofix_rate: pct(styleFixCount, drafted.length),
  red_team: {
    runs: redTeamRuns.length,
    caught: redTeamCaught,
    catch_rate: pct(redTeamCaught, redTeamRuns.length),
    caught_by_deterministic_layer: redTeamDeterministicCaught,
  },
  cost: {
    mean_per_qualified_lead_usd: Number(meanCost.toFixed(5)),
    per_1000_leads_usd: Number((meanCost * 1000).toFixed(2)),
  },
  reliability: {
    attempted: observations.length,
    errored: errors.length,
    error_rate: pct(errors.length, observations.length),
    by_code: errors.reduce((acc, e) => ({ ...acc, [e.code]: (acc[e.code] || 0) + 1 }), {}),
  },
  latency_ms: Object.fromEntries(Object.entries(stageTimes).map(([k, v]) => [k, { p50: quantile(v, 0.5), p95: quantile(v, 0.95) }])),
};

/* ---------------- diff against the previous report ---------------- */

const reportPath = join(ROOT, 'out/eval-report.json');
let previous = null;
try { await access(reportPath); previous = JSON.parse(await readFile(reportPath, 'utf8')); } catch { /* first run */ }

const delta = (now, before) => {
  if (before === undefined || before === null) return '';
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return ' (no change)';
  return ` (${d > 0 ? '+' : ''}${d} vs previous)`;
};

/* ---------------- output ---------------- */

const L = [];
L.push('# Evaluation report');
L.push('');
L.push(`${RUNS} runs per lead, ${drafted.length} qualified-lead observations, mode **${report.mode}**, model \`${report.model}\`.`);
L.push('');
L.push('## The numbers that decide whether lanes can graduate');
L.push('');
L.push('| Metric | Value |');
L.push('|---|---|');
L.push(`| Gate pass rate | **${passRate}%**${delta(passRate, previous?.gate_pass_rate)} |`);
L.push(`| Red team catch rate | **${report.red_team.catch_rate}%**${delta(report.red_team.catch_rate, previous?.red_team?.catch_rate)} |`);
L.push(`| Red team caught by the free layer alone | ${redTeamDeterministicCaught} of ${redTeamRuns.length} |`);
L.push(`| Style autofix rate | ${report.style_autofix_rate}% of drafts |`);
L.push(`| Mean cost per qualified lead | $${report.cost.mean_per_qualified_lead_usd} |`);
L.push(`| Pipeline error rate | ${report.reliability.error_rate}% (${report.reliability.errored} of ${report.reliability.attempted}) |`);
L.push(`| Cost per 1,000 qualified leads | $${report.cost.per_1000_leads_usd} |`);
L.push('');
L.push('Red team catch rate is the one that must not move. It is the proportion of');
L.push('adversarially prompted drafts the gate stopped. Anything below 100 percent means');
L.push('a fabricated claim reached the queue.');
L.push('');
if (errors.length) {
  L.push('## Errors');
  L.push('');
  L.push('| Run | Lead | Code | Message |');
  L.push('|---|---|---|---|');
  for (const e of errors) L.push(`| ${e.run} | ${e.submission_id} | \`${e.code}\` | ${e.message.replace(/\|/g, '/')} |`);
  L.push('');
  L.push('These are recorded rather than fatal. A harness that stops at the first');
  L.push('malformed response cannot tell you how often malformed responses happen, which');
  L.push('is one of the things it exists to measure.');
  L.push('');
}
L.push('## Pass rate by lane');
L.push('');
L.push('| Lane | Mode | Observations | Pass rate |');
L.push('|---|---|---|---|');
for (const l of Object.values(perLane).sort((a, b) => a.lane.localeCompare(b.lane))) {
  L.push(`| ${l.lane} | ${l.mode} | ${l.total} | ${l.pass_rate}% |`);
}
L.push('');
L.push('A lane graduates to auto on sustained approvals. This is the measurement that');
L.push('would drive that decision, instead of the counter being set by hand.');
L.push('');
L.push('## Pass rate by lead');
L.push('');
L.push('| Lead | Pass rate | Mean cost | p50 latency |');
L.push('|---|---|---|---|');
for (const p of Object.values(perLead).sort((a, b) => a.submission_id.localeCompare(b.submission_id))) {
  L.push(`| ${p.submission_id} | ${p.pass_rate}% | $${p.mean_cost.toFixed(5)} | ${p.p50_ms} ms |`);
}
L.push('');
L.push('## Why sends were stopped');
L.push('');
L.push('| Layer | Reason | Count | Of which red team |');
L.push('|---|---|---|---|');
for (const r of reasons) L.push(`| ${r.layer} | ${r.reason} | ${r.count} | ${r.on_red_team} |`);
L.push('');
L.push('Reasons concentrated on the red team payload are the gate working. Reasons');
L.push('appearing mostly on ordinary leads are either a prompt that needs tightening or a');
L.push('gate rule that is too strict, and the split tells you which to go and fix.');
L.push('');
L.push('## Latency by stage');
L.push('');
L.push('| Stage | p50 | p95 |');
L.push('|---|---|---|');
for (const [stage, v] of Object.entries(report.latency_ms).sort((a, b) => b[1].p50 - a[1].p50)) {
  L.push(`| ${stage} | ${v.p50} ms | ${v.p95} ms |`);
}
L.push('');
L.push('Speed to first touch is the primary metric in the one-pager. This is where the');
L.push('time actually goes, and the deterministic spine is a rounding error against the');
L.push('model calls.');
L.push('');
if (previous) {
  L.push('## Change since the previous report');
  L.push('');
  L.push(`Pass rate ${previous.gate_pass_rate}% to ${passRate}%. Red team catch ${previous.red_team?.catch_rate}% to ${report.red_team.catch_rate}%.`);
  L.push('');
  L.push('Run this before and after any prompt change. A prompt edit that raises the pass');
  L.push('rate while lowering the red team catch rate has made the system worse, and');
  L.push('without this report that trade is invisible.');
  L.push('');
}

await writeFile(join(ROOT, 'out/eval-report.md'), `${L.join('\n')}\n`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(L.join('\n'));
console.log('');
console.log('wrote out/eval-report.md and out/eval-report.json');
