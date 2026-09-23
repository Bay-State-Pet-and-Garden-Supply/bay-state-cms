/**
 * Opt-in live contract check for the TypeSafe System One API (ticket #295).
 *
 * Bounded by construction: one synthetic state, one pinned model, at most
 * two questions, at most two HTTP attempts (one retry), hard timeout.
 * Never runs in ordinary CI — requires TYPESAFE_LIVE_CHECK=1 plus a real
 * TYPESAFE_API_KEY. Validates live compatibility only (endpoint shape,
 * Choice/Noul answers, model identity, usage); it is not classification
 * evaluation and its result proves nothing about quality.
 *
 * Usage:
 *   TYPESAFE_LIVE_CHECK=1 TYPESAFE_API_KEY=... \
 *     bun scripts/typesafe-live-contract-check.ts [--model jev-1.13.0]
 */

import { executeSystemOne } from '../src/ai/systemone-transport';
import type { ProviderConnection } from '../src/ai/provider-connections';

const LIVE_FLAG = process.env.TYPESAFE_LIVE_CHECK === '1';
const API_KEY = process.env.TYPESAFE_API_KEY ?? '';
const MODEL_OVERRIDE = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
const MODEL = MODEL_OVERRIDE ?? 'jev-1.13.0';
const MAX_CALLS = 2;

if (!LIVE_FLAG) {
  console.log('Live contract check skipped: set TYPESAFE_LIVE_CHECK=1 with TYPESAFE_API_KEY to run.');
  process.exit(0);
}
if (!API_KEY || API_KEY.length < 8) {
  console.error('Live contract check requires TYPESAFE_API_KEY (a real TypeSafe key). Refusing to run.');
  process.exit(2);
}

const conn: ProviderConnection = {
  id: 'typesafe-live-check',
  label: 'TypeSafe live contract check (ephemeral)',
  transport: 'systemone',
  baseUrl: 'https://api.typesafe.ai/v1',
  credential: API_KEY,
  trustZone: 'cloud',
  approvedHost: 'api.typesafe.ai',
  approvedPort: 443,
  enabled: true,
  connectTimeoutMs: 8000,
  inferenceTimeoutMs: 30_000,
};

const state = 'The customer writes: "My dog loves the new chicken kibble." This is synthetic fixture text.';
const questions = {
  mentions_dog_food: {
    type: 'noul' as const,
    instructions: 'Does the text mention dog food?',
  },
  topic: {
    type: 'choice' as const,
    instructions: 'What is the topic of the text?',
    criteria: {
      pet_food: 'Food, kibble, or treats for pets',
      shipping: 'Delivery status, delays, or lost packages',
    },
  },
};

let calls = 0;
const observedFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  calls += 1;
  if (calls > MAX_CALLS) throw new Error(`Live contract budget exceeded (${MAX_CALLS} calls).`);
  return observedFetch(...args);
}) as typeof fetch;

try {
  const result = await executeSystemOne(conn, MODEL, questions, state, { timeoutMs: 30_000 });
  console.log(
    JSON.stringify(
      {
        ok: true,
        requestedModel: result.requestedModel,
        returnedModel: result.returnedModel,
        attempts: result.attempts,
        retried: result.retried,
        usage: result.usage,
        answers: result.answers,
        calls,
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), calls }, null, 2),
  );
  process.exit(1);
}
