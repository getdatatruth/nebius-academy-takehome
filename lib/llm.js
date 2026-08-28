/**
 * Anthropic Messages API caller for the local harness.
 *
 * In n8n these three calls are HTTP Request nodes. This module exists so the
 * pipeline can be run and re-run outside n8n while iterating on prompts.
 *
 * If ANTHROPIC_API_KEY is set the call is live. If it is not, the call is
 * served from a recorded fixture in test/fixtures so the run still completes
 * and the verification gate still executes against real draft text. Fixture
 * mode is labelled in the output, never silently substituted.
 */
import { readFile } from 'node:fs/promises';
import { parseModelJson, anthropicText } from './engine.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'test', 'fixtures');

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/* Model is specified by the build brief. Sonnet is the right tier here:
 * drafting under a tight allow list is a constrained task, and the verifier
 * is a classification call. Cost per lead matters at volume. */
export const DRAFT_MODEL = 'claude-sonnet-4-6';
export const VERIFY_MODEL = 'claude-sonnet-4-6';

/** USD per million tokens, claude-sonnet-4-6. */
export const PRICING = { input: 3.00, output: 15.00 };

export function costOf(usage) {
  if (!usage) return 0;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (input / 1e6) * PRICING.input + ((usage.output_tokens || 0) / 1e6) * PRICING.output;
}

export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/* Parsing lives in lib/engine.js so the n8n Code nodes share it. */
export { extractJsonObject, parseModelJson as parseJsonResponse } from './engine.js';

export async function callAnthropic({ model, system, user, max_tokens = 1000, fixture }) {
  const startedAt = performance.now();
  if (!hasCredentials()) {
    const raw = await readFile(join(FIXTURE_DIR, `${fixture}.json`), 'utf8');
    return { source: 'fixture', fixture, result: JSON.parse(raw), ms: performance.now() - startedAt, usage: null, cost: 0 };
  }
  const response = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = await response.json();
  const text = anthropicText(body);
  return {
    source: 'live', fixture, result: parseModelJson(text),
    usage: body.usage, cost: costOf(body.usage), ms: performance.now() - startedAt,
  };
}
