/**
 * One lead, end to end, instrumented.
 *
 * Extracted so the interactive harness and the evaluation harness run the
 * identical path. If they each had their own copy, the numbers the evaluator
 * reports would eventually stop describing the thing that actually runs, which
 * is the failure mode that makes eval suites worse than useless.
 *
 * Every stage records its wall time, and every model call records its token
 * usage and cost, so the evaluator can report per-stage latency and cost per
 * lead without instrumenting anything itself.
 */
import { runDeterministic, deterministicGate, normaliseStyle } from './engine.js';
import {
  DRAFT_SYSTEM, DRAFT_SYSTEM_LOOSENED, FORWARDABLE_SYSTEM, VERIFIER_SYSTEM,
  draftUserMessage, forwardableUserMessage, verifierUserMessage,
} from './prompts.js';
import { callAnthropic, DRAFT_MODEL, VERIFY_MODEL } from './llm.js';

async function timed(label, timings, fn) {
  const t0 = performance.now();
  const value = await fn();
  timings[label] = performance.now() - t0;
  return value;
}

/**
 * @param {object} payload   inbound assessment completion
 * @param {object} laneState lane_state rows keyed by lane
 * @param {object} opts      { loosened, fixtureSuffix }
 */
export async function processLead(payload, laneState = {}, opts = {}) {
  const timings = {};
  const calls = [];
  const t0 = performance.now();

  const state = await timed('deterministic', timings, async () => runDeterministic(payload, laneState));
  const { enrichment, fit, sections, benchmark, gap, pack, lane } = state;

  const base = {
    submission_id: payload.submission_id,
    loosened: Boolean(opts.loosened),
    enrichment, fit, sections, benchmark, gap, pack, lane,
    firewall: state.firewall,
    demand_corpus_row: state.demand_corpus_row,
    drafting_required: state.drafting_required,
    timings, calls,
  };

  if (!state.drafting_required) {
    base.outcome = state.firewall.blocked ? 'blocked by personal contact firewall' : 'newsletter only';
    base.gate_verdict = 'n/a';
    base.total_ms = performance.now() - t0;
    base.total_cost = 0;
    return base;
  }

  const suffix = opts.fixtureSuffix || '';

  // The two drafts are independent of each other, so they go concurrently.
  // Measured at ~13s sequential, ~7s in parallel.
  const [draftCall, fwdCall] = await timed('drafts', timings, () => Promise.all([
    callAnthropic({
      model: DRAFT_MODEL,
      system: opts.loosened ? DRAFT_SYSTEM_LOOSENED : DRAFT_SYSTEM,
      user: draftUserMessage(pack, payload),
      fixture: `${payload.submission_id}-draft${suffix}`,
    }),
    callAnthropic({
      model: DRAFT_MODEL, system: FORWARDABLE_SYSTEM,
      user: forwardableUserMessage(pack, payload),
      fixture: `${payload.submission_id}-forwardable`,
    }),
  ]));
  calls.push({ stage: 'draft', ...pick(draftCall) });
  calls.push({ stage: 'forwardable', ...pick(fwdCall) });

  const artifacts = { primary: draftCall.result, forwardable: fwdCall.result };
  const gates = {};

  // Style normalisation is deterministic and free, so it happens up front.
  const styleByLabel = {};
  for (const [label, artifact] of Object.entries(artifacts)) {
    const subj = normaliseStyle(artifact.subject);
    const body = normaliseStyle(artifact.body);
    styleByLabel[label] = [...subj.fixes, ...body.fixes];
    if (styleByLabel[label].length) { artifact.subject = subj.text; artifact.body = body.text; }
  }

  // Both artifacts verify concurrently. Neither depends on the other's verdict.
  const verified = await timed('verify', timings, () => Promise.all(
    Object.entries(artifacts).map(async ([label, artifact]) => {
      const det = deterministicGate(artifact, pack);
      const verifyCall = await callAnthropic({
        model: VERIFY_MODEL, system: VERIFIER_SYSTEM,
        user: verifierUserMessage(artifact, pack, label),
        fixture: `${payload.submission_id}-verify-${label}${suffix}`,
      });
      return { label, det, verifyCall };
    }),
  ));

  for (const { label, det, verifyCall } of verified) {
    calls.push({ stage: `verify_${label}`, ...pick(verifyCall) });
    const findings = verifyCall.result.findings || [];
    const blocks = findings.filter((f) => f.severity === 'block');
    const notes = findings.filter((f) => f.severity !== 'block');
    gates[label] = {
      verdict: det.verdict === 'PASS' && blocks.length === 0 ? 'PASS' : 'FAIL',
      deterministic: det.verdict,
      deterministic_blocking: det.blocking,
      style_fixes: styleByLabel[label],
      llm_blocks: blocks,
      llm_notes: notes,
      source: verifyCall.source,
    };
  }

  const passed = Object.values(gates).every((g) => g.verdict === 'PASS');

  base.artifacts = artifacts;
  base.gates = gates;
  base.gate_verdict = passed ? 'PASS' : 'FAIL';
  base.outcome = passed ? lane.action_taken : 'routed to human review';
  base.total_ms = performance.now() - t0;
  base.total_cost = calls.reduce((sum, c) => sum + (c.cost || 0), 0);
  base.total_tokens = calls.reduce((sum, c) => sum + (c.usage?.input_tokens || 0) + (c.usage?.output_tokens || 0), 0);
  return base;
}

function pick(call) {
  return { source: call.source, ms: call.ms, usage: call.usage || null, cost: call.cost || 0 };
}

/** Every distinct reason a send was stopped, flattened for aggregation. */
export function blockReasons(result) {
  if (!result.gates) return [];
  const out = [];
  for (const [artifact, g] of Object.entries(result.gates)) {
    for (const b of g.deterministic_blocking) out.push({ artifact, layer: 'deterministic', reason: normaliseReason(b) });
    for (const b of g.llm_blocks) out.push({ artifact, layer: 'llm', reason: normaliseReason(b.why || b.claim) });
  }
  return out;
}

/** Collapse specifics so reasons group into categories worth counting. */
export function normaliseReason(text) {
  const t = String(text).toLowerCase();
  if (t.includes('orphan number')) return 'orphan number not in permitted facts';
  if (t.includes('blocklisted authority claim')) return 'blocklisted authority claim';
  if (t.includes('comparative language')) return 'comparative language with no benchmark';
  if (t.includes('peer group') || t.includes('comparison group') || t.includes('broader universe')) return 'benchmark peer group widened';
  if (t.includes('statistic') || t.includes('percent')) return 'invented statistic';
  if (t.includes('not supported') || t.includes('no permitted fact') || t.includes('unsupported')) return 'claim not in permitted facts';
  return 'other';
}
