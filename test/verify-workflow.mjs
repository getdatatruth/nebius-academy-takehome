/**
 * Executes the generated n8n Code nodes outside n8n.
 *
 * Building a workflow JSON proves nothing on its own. This harness pulls each
 * Code node's jsCode straight out of workflows/nebius-inbound-engine.json,
 * runs it against a simulated n8n runtime ($input, $(nodeName)) with the
 * sample payloads and mocked Anthropic responses, and asserts the outcome.
 *
 * Run: npm test
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = JSON.parse(await readFile(join(ROOT, 'workflows/nebius-inbound-engine.json'), 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

const store = {};          // node name -> output items, for the $() accessor
const $ = (name) => ({ all: () => store[name] ?? [] });

function runCode(name, inputItems) {
  const node = byName[name];
  assert.ok(node, `node "${name}" is missing from the workflow`);
  assert.equal(node.type, 'n8n-nodes-base.code', `${name} is not a Code node`);
  const fn = new Function('$input', '$', 'items', node.parameters.jsCode);
  const out = fn({ all: () => inputItems }, $, inputItems);
  store[name] = out;
  return out;
}

/** Mock of what the Anthropic HTTP Request node hands to the next node. */
const anthropicResponse = (obj) => [{ json: { content: [{ type: 'text', text: JSON.stringify(obj) }] } }];
const fixture = async (n) => JSON.parse(await readFile(join(ROOT, 'test/fixtures', `${n}.json`), 'utf8'));

const files = (await readdir(join(ROOT, 'data/sample-leads'))).filter((f) => f.endsWith('.json')).sort();
const payloads = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(ROOT, 'data/sample-leads', f), 'utf8'))));

let checks = 0;
const ok = (label) => { checks++; console.log(`  ok  ${label}`); };

console.log(`Executing generated n8n Code nodes against ${payloads.length} sample leads\n`);

for (const payload of payloads) {
  const id = payload.submission_id;
  console.log(`${id}  ${payload.first_name} ${payload.last_name}`);

  // [2-7] the deterministic spine, fed exactly as the Webhook node feeds it
  const spineOut = runCode('[2-7] Enrich, score, benchmark, route', [{ json: { body: payload } }]);
  const s = spineOut[0].json;
  assert.equal(s.submission_id, id);
  ok(`spine ran: fit ${s.fit.fit_score} band ${s.fit.band}, benchmark ${s.benchmark.benchmark_available ? 'permitted' : 'withheld'}`);

  // [12] demand corpus, which runs for every submission including newsletter
  const corpusOut = runCode('[12] Append to demand corpus', spineOut);
  assert.equal(corpusOut[0].json.stated_priority, payload.assessment.stated_priority);
  ok('demand corpus row emitted');

  if (s.fit.band === 'NEWSLETTER') {
    const nl = runCode('[5] Newsletter only', spineOut);
    assert.equal(nl[0].json.draft_subject, '');
    assert.equal(nl[0].json.action_taken, 'added to newsletter only');
    ok('newsletter path: no draft, no committee logic, no tokens spent');
    console.log('');
    continue;
  }

  // [8] draft request built, then the mocked model reply flows on
  const draftReq = runCode('[8] Build draft request', spineOut);
  assert.equal(draftReq[0].json.anthropic_request.model, 'claude-sonnet-4-6');
  assert.ok(draftReq[0].json.anthropic_request.system.includes('ABSOLUTE RULES'));
  ok('draft request built with the allow list in the user message');

  const fwdReq = runCode('[8b] Parse draft, build forwardable request', anthropicResponse(await fixture(`${id}-draft`)));
  assert.ok(fwdReq[0].json.draft.subject, 'draft failed to parse');
  assert.ok(fwdReq[0].json.anthropic_request.system.includes('forwardable'));
  ok(`draft parsed, forwardable request built for the missing ${s.gap.missing_seat} seat`);

  const verifyReq = runCode('[9] Deterministic gate, build verifier request', anthropicResponse(await fixture(`${id}-forwardable`)));
  const det = verifyReq[0].json.det_primary;
  assert.equal(det.verdict, 'PASS', `layer 1 unexpectedly blocked a compliant draft: ${det.blocking.join(', ')}`);
  ok('layer 1 deterministic gate PASS on both artifacts');

  const outcome = runCode('[10] Gate outcome and lane resolution', anthropicResponse(await fixture(`${id}-verify-primary`)));
  const row = outcome[0].json.row;
  assert.equal(row.gate_verdict, 'PASS');
  assert.equal(row.lane, `${s.fit.band}_${s.enrichment.buyer_model === 'OTHER' ? 'LD' : s.enrichment.buyer_model}`);
  ok(`gate PASS, lane ${row.lane} (${row.mode}), action "${row.action_taken}"`);

  if (row.mode === 'auto') {
    const sent = runCode('[10] Auto send with spot check', outcome);
    assert.match(sent[0].json.action_taken, /^sent automatically/);
    ok('auto lane: sent without approval, spot check sampled');
  } else {
    const queued = runCode('[10] Queue for approval', outcome);
    assert.equal(queued[0].json.status, 'pending');
    ok('manual lane: written to approval_queue as pending');
  }
  console.log('');
}

/* The one that matters: the gate under test, inside the generated nodes. */
console.log('sub_0004 second pass, loosened prompt, gate under test');
const daniel = payloads.find((p) => p.submission_id === 'sub_0004');
runCode('[2-7] Enrich, score, benchmark, route', [{ json: { body: daniel } }]);
runCode('[8] Build draft request', store['[2-7] Enrich, score, benchmark, route']);
runCode('[8b] Parse draft, build forwardable request', anthropicResponse(await fixture('sub_0004-draft-loosened')));
const looseVerify = runCode('[9] Deterministic gate, build verifier request', anthropicResponse(await fixture('sub_0004-forwardable')));
assert.equal(looseVerify[0].json.det_primary.verdict, 'BLOCK');
assert.ok(looseVerify[0].json.det_primary.blocking.length >= 5);
ok(`layer 1 BLOCKED the loosened draft on ${looseVerify[0].json.det_primary.blocking.length} truth violations`);

const looseOutcome = runCode('[10] Gate outcome and lane resolution', anthropicResponse(await fixture('sub_0004-verify-loosened')));
assert.equal(looseOutcome[0].json.row.gate_verdict, 'FAIL');
assert.equal(looseOutcome[0].json.row.action_taken, 'routed to human review');
ok('gate FAIL, routed to human review, nothing sends');

const reviewRow = runCode('[10b] Human review row', looseOutcome);
assert.equal(reviewRow[0].json.status, 'blocked by verification gate');
assert.ok(reviewRow[0].json.failure_reason.length > 0);
ok('human review row carries the failure reasons');

/* The severity split: a style violation must never stop a send. */
console.log('\nseverity split');
{
  const { deterministicGate, normaliseStyle } = await import('../lib/engine.js');
  const pack = { allowed_facts: ['weakest_section: governance (58)', 'strongest_section: tooling (74)'], product_facts: [], benchmark_available: true };
  const dashed = { subject: 'Governance at 58', body: 'The tools are there \u2014 the oversight is not.' };
  const g1 = deterministicGate(dashed, pack);
  assert.equal(g1.verdict, 'PASS');
  assert.equal(g1.style.length, 1);
  ok('em dash is a style finding, not a block');
  assert.equal(normaliseStyle(dashed.body).text, 'The tools are there, the oversight is not.');
  ok('em dash normalises to a comma');
  const derived = deterministicGate({ subject: '', body: 'a 16 point gap between 74 and 58' }, pack);
  assert.equal(derived.verdict, 'PASS');
  ok('arithmetic derived from permitted scores is allowed');
  const invented = deterministicGate({ subject: '', body: 'around 70 percent never reach production' }, pack);
  assert.equal(invented.verdict, 'BLOCK');
  ok('an invented statistic still blocks');
}

/* Structural checks on the workflow itself. */
console.log('\nworkflow structure');
const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
for (const n of codeNodes) new Function(n.parameters.jsCode); // syntax check every node
ok(`${codeNodes.length} Code nodes parse`);
assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.webhook'));
assert.equal(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').length, 3);
assert.equal(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets').length, 6);
ok('1 webhook, 3 Anthropic calls, 6 sheet writes');
const reachable = new Set(['[1] Assessment completion']);
let grew = true;
while (grew) {
  grew = false;
  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!reachable.has(from)) continue;
    for (const out of conn.main) for (const c of out) if (!reachable.has(c.node)) { reachable.add(c.node); grew = true; }
  }
}
const orphans = wf.nodes.map((n) => n.name).filter((n) => !reachable.has(n));
assert.deepEqual(orphans, [], `unreachable nodes: ${orphans.join(', ')}`);
ok('every node is reachable from the webhook');

console.log(`\n${checks} checks passed`);
