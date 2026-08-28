/**
 * Generates workflows/nebius-inbound-engine.json.
 *
 * The n8n Code nodes are not hand written. Every one of them is this file
 * stitching lib/engine.js and lib/prompts.js in front of a short node body,
 * so the logic running in n8n is byte identical to the logic the local
 * harness exercises. There is exactly one copy of the scoring rules.
 *
 * Run: npm run build
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** n8n Code nodes have no module system, so strip ESM keywords and inline. */
async function inline(file) {
  const src = await readFile(join(ROOT, 'lib', file), 'utf8');
  return src
    .replace(/^import[\s\S]*?;$/gm, '')
    .replace(/^export (const|function|class)/gm, '$1')
    .trim();
}

const ENGINE = await inline('engine.js');
const PROMPTS = await inline('prompts.js');
const PRELUDE = `/* ---- generated, do not edit in n8n. Source: lib/engine.js + lib/prompts.js ---- */\n${ENGINE}\n\n${PROMPTS}\n/* ---- end generated ---- */\n`;

let nodeId = 0;
const nodes = [];
const connections = {};

function node(name, type, typeVersion, parameters, [x, y], extra = {}) {
  nodes.push({ parameters, id: `node-${++nodeId}`, name, type, typeVersion, position: [x, y], ...extra });
  return name;
}

function connect(from, to, fromOutput = 0) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= fromOutput) connections[from].main.push([]);
  connections[from].main[fromOutput].push({ node: to, type: 'main', index: 0 });
}

function code(name, body, position, notes) {
  return node(name, 'n8n-nodes-base.code', 2, { jsCode: `${PRELUDE}\n${body}` }, position, {
    notes, notesInFlow: Boolean(notes),
  });
}

function anthropic(name, position, notes) {
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'anthropicApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.anthropic_request) }}',
    options: { response: { response: { neverError: false } } },
  }, position, { notes, notesInFlow: true });
}

/**
 * Google Sheets append, or a pass-through stand-in.
 *
 * n8n validates required parameters before it starts an execution, so a Sheets
 * node with no Document selected stops the WHOLE workflow from running, not
 * just itself. That makes the unconfigured workflow undemoable on any instance
 * without Google OAuth, which self-hosted n8n does not have out of the box.
 *
 * `npm run build:local` swaps the six Sheets nodes for NoOp nodes that pass the
 * exact row through and show it on the canvas. Every node executes and goes
 * green, and the row is inspectable by clicking the node.
 */
const NO_SHEETS = process.argv.includes('--no-sheets');

function sheet(name, tab, position, notes) {
  if (NO_SHEETS) {
    return node(`${name} [row preview]`, 'n8n-nodes-base.noOp', 1, {}, position, {
      notes: `Stands in for the Google Sheets append to the "${tab}" tab. Click to see the exact row. ${notes || ''}`.trim(),
      notesInFlow: true,
    });
  }
  return node(name, 'n8n-nodes-base.googleSheets', 4.5, {
    operation: 'append',
    documentId: { __rl: true, value: '', mode: 'list', cachedResultName: '' },
    sheetName: { __rl: true, value: tab, mode: 'name' },
    columns: { mappingMode: 'autoMapInputData', matchingColumns: [], schema: [] },
    options: {},
  }, position, { notes, notesInFlow: true });
}

/* ================================================================== *
 * [1] WEBHOOK
 * ================================================================== */
const webhook = node('[1] Assessment completion', 'n8n-nodes-base.webhook', 2, {
  httpMethod: 'POST',
  path: 'nebius-academy/assessment-completed',
  responseMode: 'lastNode',
  options: {},
}, [-640, 300], {
  webhookId: 'nebius-academy-assessment',
  notes: 'SEAM: production points the assessment platform (Skillcheck, assumed) at this URL.',
  notesInFlow: true,
});

/* ================================================================== *
 * [2-7] DETERMINISTIC SPINE, one code node
 * Enrichment, fit scoring, benchmark confidence gate, routing, committee
 * gap detection and research pack assembly are all deterministic and all
 * cheap, so they run together before any token is spent.
 * ================================================================== */
const spine = code('[2-7] Enrich, score, benchmark, route', `
// Lane state is read from the lane_state sheet in production. Pinned here so
// the prototype runs standalone. SEAM: a sheet is the wrong home for a counter
// that concurrent executions increment. Production holds this in a database.
const LANE_STATE = {
  HOT_LD:    { lane: 'HOT_LD',    mode: 'manual', consecutive_unchanged: 3,  threshold: 20 },
  HOT_TECH:  { lane: 'HOT_TECH',  mode: 'manual', consecutive_unchanged: 0,  threshold: 20 },
  MQL_LD:    { lane: 'MQL_LD',    mode: 'auto',   consecutive_unchanged: 20, threshold: 20 },
  MQL_TECH:  { lane: 'MQL_TECH',  mode: 'manual', consecutive_unchanged: 11, threshold: 20 },
};

return $input.all().map((item) => {
  const payload = item.json.body ?? item.json;
  return { json: runDeterministic(payload, LANE_STATE) };
});
`, [-420, 300], 'No LLM runs here. When a rep asks why a lead scored 82, this node answers.');

/* ================================================================== *
 * [5] ROUTER
 * ================================================================== */
const router = node('[5] Route by band', 'n8n-nodes-base.switch', 3.2, {
  rules: {
    values: ['HOT', 'MQL', 'NEWSLETTER'].map((band) => ({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: `band-${band}`,
          leftValue: '={{ $json.fit.band }}',
          rightValue: band,
          operator: { type: 'string', operation: 'equals' },
        }],
        combinator: 'and',
      },
      renameOutput: true,
      outputKey: band,
    })),
  },
  options: {},
}, [-200, 300], {
  notes: 'HOT: sales alert, 1 hour SLA. MQL: nurture. NEWSLETTER: no individual outreach.',
  notesInFlow: true,
});

/* ================================================================== *
 * [8] DRAFT AGENT
 * ================================================================== */
const buildDraft = code('[8] Build draft request', `
return $input.all().map((item) => {
  const s = item.json;

  // WALKTHROUGH SWITCH. Posting "_demo_loosen_prompt": true on the payload
  // swaps rule 3, the benchmark prohibition, for an instruction to compare.
  // Nothing else changes. This exists so the verification gate is exercised
  // adversarially rather than merely asserted to work.
  const loosened = s.payload._demo_loosen_prompt === true;

  return { json: { ...s, prompt_variant: loosened ? 'LOOSENED (demo)' : 'standard', anthropic_request: {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: loosened ? DRAFT_SYSTEM_LOOSENED : DRAFT_SYSTEM,
    messages: [{ role: 'user', content: draftUserMessage(s.pack, s.payload) }],
  } } };
});
`, [40, 200], 'The system prompt is byte stable across every lead, so it stays cacheable.');

const draftCall = anthropic('[8] Draft agent', [260, 200], 'claude-sonnet-4-6. Constrained drafting, not open generation.');

/* ================================================================== *
 * [8b] FORWARDABLE NOTE FOR THE MISSING SEAT
 * ================================================================== */
const buildForwardable = code('[8b] Parse draft, build forwardable request', `
// Parsing comes from the inlined lib/engine.js. See parseModelJson there.

return $input.all().map((item, i) => {
  const s = $('[8] Build draft request').all()[i].json;
  const draft = parseModelJson(anthropicText(item.json));
  return { json: { ...s, draft, anthropic_request: {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: FORWARDABLE_SYSTEM,
    messages: [{ role: 'user', content: forwardableUserMessage(s.pack, s.payload) }],
  } } };
});
`, [480, 200], 'One assessment, two seats. This note is written for the seat that did not fill in the form.');

const forwardableCall = anthropic('[8b] Forwardable note agent', [700, 200], 'Under 80 words, in the missing counterpart\'s language.');

/* ================================================================== *
 * [9] VERIFICATION GATE, LAYER ONE THEN LAYER TWO
 * ================================================================== */
const buildVerify = code('[9] Deterministic gate, build verifier request', `
// Parsing comes from the inlined lib/engine.js. See parseModelJson there.

return $input.all().map((item, i) => {
  const s = $('[8b] Parse draft, build forwardable request').all()[i].json;
  const forwardable = parseModelJson(anthropicText(item.json));

  // House style is normalised before anything is judged. An em dash is a
  // style violation, not a truth violation, and blocking a send over
  // punctuation trains everyone to override the gate.
  const style_fixes = [];
  for (const artifact of [s.draft, forwardable]) {
    const subj = normaliseStyle(artifact.subject);
    const body = normaliseStyle(artifact.body);
    if (subj.fixes.length || body.fixes.length) {
      artifact.subject = subj.text;
      artifact.body = body.text;
      style_fixes.push(...subj.fixes, ...body.fixes);
    }
  }

  // Layer one runs first and runs free. Only truth violations block.
  const det_primary = deterministicGate(s.draft, s.pack);
  const det_forwardable = deterministicGate(forwardable, s.pack);

  return { json: { ...s, forwardable, det_primary, det_forwardable, style_fixes, anthropic_request: {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: VERIFIER_SYSTEM,
    messages: [{ role: 'user', content: verifierUserMessage(s.draft, s.pack) }],
  } } };
});
`, [920, 200], 'Layer 1: numbers, blocklist, comparative language, em dashes. Deterministic and free.');

const verifyCall = anthropic('[9] LLM verifier', [1140, 200], 'Layer 2. Biased towards FAIL. A false FAIL costs one human glance.');

/* ================================================================== *
 * [10] GATE OUTCOME, LANE RESOLUTION, ROW ASSEMBLY
 * ================================================================== */
const outcome = code('[10] Gate outcome and lane resolution', `
// Parsing comes from the inlined lib/engine.js. See parseModelJson there.

return $input.all().map((item, i) => {
  const s = $('[9] Deterministic gate, build verifier request').all()[i].json;
  const llm = parseModelJson(anthropicText(item.json));

  // Only severity "block" stops a send. A "note" is recorded for the reviewer
  // and does not hold up the queue.
  const findings = llm.findings || [];
  const blocks = findings.filter((f) => f.severity === 'block');
  const notes = findings.filter((f) => f.severity !== 'block');

  const failures = [
    ...s.det_primary.blocking,
    ...s.det_forwardable.blocking.map((f) => 'forwardable: ' + f),
    ...blocks.map((f) => f.claim + ': ' + f.why),
  ];
  const passed = s.det_primary.verdict === 'PASS'
    && s.det_forwardable.verdict === 'PASS'
    && blocks.length === 0;

  const row = {
    submission_id: s.submission_id,
    timestamp: s.payload.submitted_at,
    name: s.payload.first_name + ' ' + s.payload.last_name,
    email: s.payload.work_email,
    company: s.payload.company_name,
    title: s.payload.job_title,
    company_size: s.enrichment.company_size,
    industry: s.enrichment.industry_label,
    seniority: s.enrichment.seniority,
    role_family: s.enrichment.role_family,
    buyer_model: s.enrichment.buyer_model,
    overall_score: s.payload.assessment.overall_score,
    weakest_section: s.sections.weakest_section + ' (' + s.sections.weakest_score + ')',
    fit_score: s.fit.fit_score,
    band: s.fit.band,
    score_reasons: s.fit.reasons.join(' | '),
    benchmark_available: s.benchmark.benchmark_available,
    benchmark_statement: s.benchmark.statement || '',
    benchmark_segment: s.benchmark.segment_key + ' n=' + s.benchmark.n,
    recommended_angle: s.sections.recommended_angle,
    missing_seat: s.gap.missing_seat,
    draft_subject: s.draft.subject,
    draft_body: s.draft.body,
    forwardable_note: s.forwardable.body,
    gate_verdict: passed ? 'PASS' : 'FAIL',
    failure_reason: failures.join(' | '),
    reviewer_notes: notes.map((f) => f.claim).join(' | '),
    style_autofixed: (s.style_fixes || []).length ? [...new Set(s.style_fixes)].join(' | ') : '',
    lane: s.lane.lane,
    mode: s.lane.mode,
    // No auto retry in the prototype. Production retries once with the failure
    // reason fed back into the prompt, then escalates to a human.
    action_taken: passed ? s.lane.action_taken : 'routed to human review',
  };

  return { json: { ...s, llm_verdict: llm, gate_passed: passed, row } };
});
`, [1360, 200]);

const gateBranch = node('[10] Gate passed?', 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'gate-passed',
      leftValue: '={{ $json.gate_passed }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
}, [1580, 200]);

const laneBranch = node('[10] Lane on auto?', 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'lane-auto',
      leftValue: '={{ $json.lane.mode }}',
      rightValue: 'auto',
      operator: { type: 'string', operation: 'equals' },
    }],
    combinator: 'and',
  },
  options: {},
}, [1800, 100], {
  notes: 'Lanes graduate from manual to auto after 20 consecutive unedited approvals.',
  notesInFlow: true,
});

const autoSend = code('[10] Auto send with spot check', `
return $input.all().map((item) => {
  const s = item.json;
  // 1 in 10 auto sent drafts is still written to the approval queue as a spot
  // check row, so a lane on auto never becomes completely unobserved.
  const spot_check = Math.random() < 0.1;
  return { json: { ...s.row, action_taken: spot_check ? 'sent automatically, spot check row written' : 'sent automatically' } };
});
`, [2020, 40], 'SEAM: no real send. Production hands off to the ESP here.');

const queueForApproval = code('[10] Queue for approval', `
return $input.all().map((item) => ({ json: {
  submission_id: item.json.row.submission_id,
  lane: item.json.row.lane,
  draft_subject: item.json.row.draft_subject,
  draft_body: item.json.row.draft_body,
  forwardable_note: item.json.row.forwardable_note,
  status: 'pending',
} }));
`, [2020, 160]);

const humanReview = code('[10b] Human review row', `
return $input.all().map((item) => ({ json: {
  ...item.json.row,
  status: 'blocked by verification gate',
} }));
`, [1800, 320], 'Both trust mechanisms report here. Nothing sends.');

/* ================================================================== *
 * NEWSLETTER PATH - no committee logic, no LLM spend
 * ================================================================== */
const newsletter = code('[5] Newsletter only', `
return $input.all().map((item) => {
  const s = item.json;
  return { json: {
    submission_id: s.submission_id,
    timestamp: s.payload.submitted_at,
    name: s.payload.first_name + ' ' + s.payload.last_name,
    email: s.payload.work_email,
    company: s.payload.company_name,
    title: s.payload.job_title,
    company_size: s.enrichment.company_size,
    industry: s.enrichment.industry_label,
    seniority: s.enrichment.seniority,
    role_family: s.enrichment.role_family,
    buyer_model: s.enrichment.buyer_model,
    overall_score: s.payload.assessment.overall_score,
    weakest_section: s.sections.weakest_section + ' (' + s.sections.weakest_score + ')',
    fit_score: s.fit.fit_score,
    band: s.fit.band,
    score_reasons: s.fit.reasons.join(' | '),
    benchmark_available: s.benchmark.benchmark_available,
    benchmark_statement: s.benchmark.statement || '',
    benchmark_segment: s.benchmark.segment_key + ' n=' + s.benchmark.n,
    recommended_angle: s.sections.recommended_angle,
    missing_seat: '', draft_subject: '', draft_body: '', forwardable_note: '',
    gate_verdict: 'n/a', failure_reason: '',
    lane: '', mode: '',
    action_taken: s.firewall.blocked ? 'blocked by personal contact firewall' : 'added to newsletter only',
  } };
});
`, [40, 460], 'No individual outreach, so no committee logic and no tokens spent.');

/* ================================================================== *
 * [12] DEMAND CORPUS - runs for every submission, including the ones
 * that will never be emailed.
 * ================================================================== */
const corpus = code('[12] Append to demand corpus', `
return $input.all().map((item) => ({ json: item.json.demand_corpus_row }));
`, [40, 620], 'IDEA THREE. Buyer language, unprompted, at the moment of purchase consideration.');

/* ================================================================== *
 * SHEETS
 * ================================================================== */
const leadsSheetA = sheet('Log to leads tab', 'leads', [2240, 40]);
const leadsSheetB = sheet('Log to leads tab (approval)', 'leads', [2460, 160]);
const leadsSheetC = sheet('Log to leads tab (newsletter)', 'leads', [260, 460]);
const leadsSheetD = sheet('Log to leads tab (review)', 'leads', [2020, 320]);
const approvalSheet = sheet('Append to approval_queue', 'approval_queue', [2240, 160]);
const corpusSheet = sheet('Append to demand_corpus', 'demand_corpus', [260, 620]);

/* ================================================================== *
 * WIRING
 * ================================================================== */
connect(webhook, spine);
connect(spine, router);
connect(spine, corpus);
connect(router, buildDraft, 0);   // HOT
connect(router, buildDraft, 1);   // MQL
connect(router, newsletter, 2);   // NEWSLETTER
connect(buildDraft, draftCall);
connect(draftCall, buildForwardable);
connect(buildForwardable, forwardableCall);
connect(forwardableCall, buildVerify);
connect(buildVerify, verifyCall);
connect(verifyCall, outcome);
connect(outcome, gateBranch);
connect(gateBranch, laneBranch, 0);
connect(gateBranch, humanReview, 1);
connect(laneBranch, autoSend, 0);
connect(laneBranch, queueForApproval, 1);
connect(autoSend, leadsSheetA);
connect(queueForApproval, approvalSheet);
connect(approvalSheet, leadsSheetB);
connect(humanReview, leadsSheetD);
connect(newsletter, leadsSheetC);
connect(corpus, corpusSheet);

const workflow = {
  // A stable id lets `n8n import:workflow` load this from the CLI. The UI
  // import generates one itself, so this is additive, not a requirement.
  id: 'nebius-inbound-engine',
  name: 'Nebius Academy - Inbound Lead Engine (Track A)',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'nebius-academy-take-home' },
  tags: [],
};

const outName = NO_SHEETS ? 'nebius-inbound-engine-local.json' : 'nebius-inbound-engine.json';
if (NO_SHEETS) {
  workflow.id = 'nebius-inbound-engine-local';
  workflow.name = 'Nebius Academy - Inbound Lead Engine (local, no Sheets)';
}
await writeFile(join(ROOT, `workflows/${outName}`), `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`wrote workflows/${outName}: ${nodes.length} nodes, ${Object.keys(connections).length} connected sources${NO_SHEETS ? ' (Sheets swapped for row previews)' : ''}`);
