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
 *
 * Importable wiring: `runLiveContractCheck()` exposes the same bounded check
 * for the qualification runner without subprocess side effects. Importing
 * this module never executes the check — the CLI runs only under
 * `import.meta.main`.
 */

import { executeSystemOne } from '../src/ai/systemone-transport';
import type { ProviderConnection } from '../src/ai/provider-connections';

export const LIVE_CONTRACT_CHECK_MODEL = 'jev-1.13.0';
export const LIVE_CONTRACT_CHECK_MAX_CALLS = 2;

export interface LiveContractCheckOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export type LiveContractCheckResult =
  | {
      ok: true;
      requestedModel: string;
      returnedModel: string;
      attempts: number;
      retried: boolean;
      usage: unknown;
      answers: unknown;
      calls: number;
    }
  | { ok: false; error: string; calls: number };

function buildCheckConnection(apiKey: string): ProviderConnection {
  return {
    id: 'typesafe-live-check',
    label: 'TypeSafe live contract check (ephemeral)',
    transport: 'systemone',
    baseUrl: 'https://api.typesafe.ai/v1',
    credential: apiKey,
    trustZone: 'cloud',
    approvedHost: 'api.typesafe.ai',
    approvedPort: 443,
    enabled: true,
    connectTimeoutMs: 8000,
    inferenceTimeoutMs: 30_000,
  };
}

const CHECK_STATE = {
  sku: 'SYNTH-DOG-FOOD-1',
  name: 'Organic Chicken Canine Kibble',
  description: 'Wholesome nutrition kibble formulated for adult dogs. Chicken recipe.',
  snippets: ['Wholesome nutrition kibble formulated for adult dogs.'],
  notes: 'The customer writes: "My dog loves the new chicken kibble." Synthetic fixture text.',
};

const CHECK_QUESTIONS = {
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
  primary_product_type: {
    type: 'choice' as const,
    instructions:
      'Select the single primary product type that best classifies the product described in the state.',
    criteria: {
      opt_0: 'Dog Food',
      opt_1: 'Cat Food',
      no_match: 'None of the configured product types apply to this item',
      insufficient_evidence:
        'The product information is insufficient to determine a product type with confidence',
    },
  },
};

/**
 * Execute the bounded live contract check against api.typesafe.ai.
 * Performs real HTTP (never mock inside this function) within the fixed
 * call budget; callers must gate on explicit opt-in + provisioned key.
 */
export async function runLiveContractCheck(
  options: LiveContractCheckOptions,
): Promise<LiveContractCheckResult> {
  const apiKey = options.apiKey;
  if (!apiKey || apiKey.length < 8) {
    return { ok: false, error: 'Live contract check requires TYPESAFE_API_KEY (a real TypeSafe key). Refusing to run.', calls: 0 };
  }
  const model = options.model ?? LIVE_CONTRACT_CHECK_MODEL;
  const conn = buildCheckConnection(apiKey);
  let calls = 0;
  const observedFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    if (calls > LIVE_CONTRACT_CHECK_MAX_CALLS) {
      throw new Error(`Live contract budget exceeded (${LIVE_CONTRACT_CHECK_MAX_CALLS} calls).`);
    }
    return observedFetch(...args);
  }) as typeof fetch;
  try {
    const result = await executeSystemOne(conn, model, CHECK_QUESTIONS, CHECK_STATE, {
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    return {
      ok: true,
      requestedModel: result.requestedModel,
      returnedModel: result.returnedModel,
      attempts: result.attempts,
      retried: result.retried,
      usage: result.usage,
      answers: result.answers,
      calls,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), calls };
  } finally {
    globalThis.fetch = observedFetch;
  }
}

// ─── CLI entrypoint (direct execution only; imports never run this) ──────────
if (import.meta.main) {
  const LIVE_FLAG = process.env.TYPESAFE_LIVE_CHECK === '1';
  const API_KEY = process.env.TYPESAFE_API_KEY ?? '';
  const MODEL_OVERRIDE = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
  const MODEL = MODEL_OVERRIDE ?? LIVE_CONTRACT_CHECK_MODEL;

  if (!LIVE_FLAG) {
    console.log('Live contract check skipped: set TYPESAFE_LIVE_CHECK=1 with TYPESAFE_API_KEY to run.');
    process.exit(0);
  }
  if (!API_KEY || API_KEY.length < 8) {
    console.error('Live contract check requires TYPESAFE_API_KEY (a real TypeSafe key). Refusing to run.');
    process.exit(2);
  }

  const result = await runLiveContractCheck({ apiKey: API_KEY, model: MODEL });
  if (result.ok) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}
