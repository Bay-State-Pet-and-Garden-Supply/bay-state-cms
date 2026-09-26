/**
 * TypeSafe System One protocol tests (ticket #295) — HTTP-boundary mocks.
 *
 * Deterministic: every test stubs `globalThis.fetch` at the HTTP boundary.
 * No API key, no paid call, no live network. The single opt-in live contract
 * check lives in `scripts/typesafe-live-contract-check.ts` and never runs here.
 *
 * Covers (against observable behavior, not internals):
 * - Choice + Noul round-trips validate and persist model-call provenance
 *   (requested/returned model, usage, no secrets/raw bodies).
 * - Invalid responses: missing/extra answers, unknown choices, invalid
 *   probabilities, type mismatch, model-identity absence.
 * - Auth/validation errors never retry; rate-limit (429) / overload (529)
 *   retry at most once with bounded backoff; timeout/cancellation semantics.
 * - Unsupported use: score questions, non-System One transports, disabled
 *   connections, unknown pins (never alias-substituted).
 * - Capability: chat dispatcher routes reject System One connections at
 *   server validation (route PUT) and at dispatch.
 * - Discovery: `models[].name` aliases parse; the versioned pin stays
 *   selectable/available when discovery lists only aliases.
 * - Connection health is distinct from stage capability: a healthy System
 *   One probe does not make a chat workload activatable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import type { ProviderConnection } from '../../ai/provider-connections';
import { isConnectionUsable } from '../../ai/provider-connections';
import {
  executeSystemOne,
  validateSystemOneRequest,
  validateSystemOneResponse,
  checkSystemOneModelPin,
  assertSystemOneModelPin,
  isSystemOneModelMatch,
  assertSystemOneModelMatch,
  parseRetryAfterMs,
  TYPESAFE_EVALUATED_MODEL,
  SYSTEMONE_CHOICE_SUM_TOLERANCE,
} from '../../ai/systemone-transport';
import { SystemOneUnsupportedError } from '../../ai/systemone-transport';
import {
  AiAvailabilityError,
  AiMisconfigurationError,
  AiPolicyDeniedError,
} from '../../ai/network-transport';
import { probeConnectionHealth, checkModelAvailability, clearHealthCache } from '../../ai/connection-health-monitor';
import {
  insertAiModelCallStart,
  completeAiModelCall,
  getAiModelCallById,
} from '../../db/repositories/ai-model-call-repo';
import { computeApiCost } from '../../ai/model-pricing';

const TYPESAFE_CONN: ProviderConnection = {
  id: 'typesafe-jev',
  label: 'TypeSafe Jev (Cloud)',
  transport: 'systemone',
  baseUrl: 'https://api.typesafe.ai/v1',
  credential: 'ts-test-key',
  trustZone: 'cloud',
  approvedHost: 'api.typesafe.ai',
  approvedPort: 443,
  enabled: true,
  connectTimeoutMs: 2000,
  inferenceTimeoutMs: 5000,
};

const CHOICE_QUESTION = {
  department: {
    type: 'choice' as const,
    instructions: 'Which team should handle this?',
    criteria: {
      billing: 'Payments, invoicing, refunds',
      technical: 'Bugs, outages, integrations',
      sales: 'Pricing, upgrades, new accounts',
    },
  },
};

const NOUL_QUESTION = {
  is_urgent: {
    type: 'noul' as const,
    instructions: 'Does this convey urgency?',
  },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function validChoiceBody() {
  return {
    model: 'jev-1.13.0',
    answers: {
      department: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 },
        confidence: 0.81,
      },
    },
    usage: { input_tokens: 318, output_tokens: 34 },
  };
}

/**
 * Stub fetch with real Response objects so `fetchWithDeadlines` redirect
 * and status handling behaves exactly as in production.
 */
function stubFetch(handler: (url: unknown, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

describe('TypeSafe System One protocol (HTTP boundary)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    clearHealthCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    clearHealthCache();
    closeDb();
  });

  it('Choice round-trip validates and persists model-call provenance without secrets', async () => {
    stubFetch(() => jsonResponse(validChoiceBody()));

    const callId = insertAiModelCallStart({
      workspaceId: 'ws-1',
      task: 'product_type_classification',
      provider: TYPESAFE_CONN.id,
      model: TYPESAFE_EVALUATED_MODEL,
      locality: 'cloud',
    });

    const startedAt = Date.now();
    const result = await executeSystemOne(
      TYPESAFE_CONN,
      TYPESAFE_EVALUATED_MODEL,
      CHOICE_QUESTION,
      'Help! My payouts have been failing for 3 days.',
    );

    expect(result.requestedModel).toBe('jev-1.13.0');
    expect(result.returnedModel).toBe('jev-1.13.0');
    expect(result.answers.department).toMatchObject({ type: 'choice', choice: 'billing' });
    expect(result.usage).toEqual({ inputTokens: 318, outputTokens: 34 });
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);

    const cost = computeApiCost(TYPESAFE_CONN.id, result.returnedModel, 'cloud', 318, 34);
    completeAiModelCall(callId, {
      status: 'success',
      durationMs: Date.now() - startedAt,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      estimatedApiCostUsd: cost.estimatedApiCostUsd,
      costBasis: cost.costBasis,
    });

    const row = getAiModelCallById(callId);
    expect(row?.status).toBe('success');
    expect(row?.provider).toBe('typesafe-jev');
    expect(row?.model).toBe('jev-1.13.0');
    expect(row?.prompt_tokens).toBe(318);
    expect(row?.cost_basis).toBe('published_rate');
    expect(JSON.stringify(row)).not.toContain('ts-test-key');
  });

  it('Noul round-trip validates P(yes) and usage identity', async () => {
    stubFetch(() =>
      jsonResponse({
        model: 'jev-1.13.0',
        answers: { is_urgent: { type: 'noul', noul: 0.95 } },
        usage: { input_tokens: 296, output_tokens: 20 },
      }));

    const result = await executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Help!');
    expect(result.answers.is_urgent).toEqual({ type: 'noul', noul: 0.95 });
    expect(result.usage).toEqual({ inputTokens: 296, outputTokens: 20 });
  });

  it('records requested vs returned identity when an alias resolves to the pin (no substitution)', async () => {
    stubFetch(() =>
      jsonResponse({
        model: 'jev-1.13.0',
        answers: { is_urgent: { type: 'noul', noul: 0.2 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }));

    const result = await executeSystemOne(TYPESAFE_CONN, 'jev-latest', NOUL_QUESTION, 'Hi');
    expect(result.requestedModel).toBe('jev-latest');
    expect(result.returnedModel).toBe('jev-1.13.0');
  });

  it('trust-zone validation blocks evil baseUrl before any network use (no credential leak)', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return jsonResponse(validChoiceBody());
    });

    const evilConn: ProviderConnection = { ...TYPESAFE_CONN, baseUrl: 'https://evil.example/v1' };
    const callId = insertAiModelCallStart({
      workspaceId: 'ws-1',
      task: 'product_type_classification',
      provider: evilConn.id,
      model: TYPESAFE_EVALUATED_MODEL,
      locality: 'cloud',
    });

    const error = await executeSystemOne(evilConn, 'jev-1.13.0', NOUL_QUESTION, 'Hi').catch((e) => e);
    expect(error).toBeInstanceOf(AiPolicyDeniedError);
    expect(String(error.message)).toMatch(/trust zone|approved host|does not match/i);
    expect(calls).toBe(0);
    expect(String(error.message)).not.toContain('ts-test-key');

    const row = getAiModelCallById(callId);
    expect(JSON.stringify(row)).not.toContain('ts-test-key');
    expect(JSON.stringify(row)).not.toContain('evil.example');
  });

  it('alias pin semantics: alias→evaluated-pin matches, genuine mismatches reject', () => {
    // Exact pin match.
    expect(isSystemOneModelMatch('jev-1.13.0', 'jev-1.13.0')).toBe(true);
    // Documented alias resolution (request alias → versioned pin).
    expect(isSystemOneModelMatch('jev-latest', 'jev-1.13.0')).toBe(true);
    expect(isSystemOneModelMatch('jev-preview', 'jev-1.13.0')).toBe(true);
    // Genuinely unexpected models still reject.
    expect(isSystemOneModelMatch('jev-latest', 'jev-9.99.9')).toBe(false);
    expect(isSystemOneModelMatch('jev-1.13.0', 'jev-9.99.9')).toBe(false);
    expect(isSystemOneModelMatch('jev-1.13.0', 'jev-latest')).toBe(false);
    expect(isSystemOneModelMatch('jev-latest', 'jev-preview')).toBe(false);

    expect(() => assertSystemOneModelMatch('jev-latest', 'jev-1.13.0')).not.toThrow();
    expect(() => assertSystemOneModelMatch('jev-1.13.0', 'jev-1.13.0')).not.toThrow();
    expect(() => assertSystemOneModelMatch('jev-latest', 'jev-9.99.9')).toThrow(/Model mismatch/);
    expect(() => assertSystemOneModelMatch('jev-1.13.0', 'jev-9.99.9')).toThrow(/Model mismatch/);
  });

  it('default/production pin is the evaluated versioned model', () => {
    expect(TYPESAFE_EVALUATED_MODEL).toBe('jev-1.13.0');
    const pin = checkSystemOneModelPin(TYPESAFE_EVALUATED_MODEL);
    expect(pin.ok).toBe(true);
    expect(pin.kind).toBe('known_pin');
    expect(isSystemOneModelMatch(TYPESAFE_EVALUATED_MODEL, TYPESAFE_EVALUATED_MODEL)).toBe(true);
  });

  it('rejects missing answers, extra answers, and type mismatches', () => {
    const request = { model: 'jev-1.13.0', questions: CHOICE_QUESTION };
    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: {},
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/missing answers/);

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: {
          department: validChoiceBody().answers.department,
          intruder: { type: 'noul', noul: 0.5 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/unexpected answers/);

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: { department: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(SystemOneUnsupportedError);
  });

  it('rejects unknown choices, incomplete distributions, bad probabilities, and argmax violations', () => {
    const request = { model: 'jev-1.13.0', questions: CHOICE_QUESTION };
    const base = validChoiceBody().answers.department;

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: { department: { ...base, choice: 'unknown-team' } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/unknown option/);

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: { department: { ...base, probabilities: { billing: 1.0 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/incomplete Choice distribution/);

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: { department: { ...base, probabilities: { billing: 0.9, technical: NaN as unknown as number, sales: 0.1 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(AiMisconfigurationError);

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: { department: { ...base, probabilities: { billing: 0.5, technical: 0.3, sales: 0.1 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(new RegExp(`tolerance|sum to`));

    expect(() =>
      validateSystemOneResponse(request, {
        model: 'jev-1.13.0',
        answers: { department: { ...base, choice: 'technical' } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/argmax/);

    expect(SYSTEMONE_CHOICE_SUM_TOLERANCE).toBe(0.01);
  });

  it('rejects non-finite Noul probabilities and missing model identity', () => {
    const request = { model: 'jev-1.13.0', questions: NOUL_QUESTION };
    for (const bad of [1.5, -0.1]) {
      expect(() =>
        validateSystemOneResponse(request, {
          model: 'jev-1.13.0',
          answers: { is_urgent: { type: 'noul', noul: bad } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ).toThrow(/Noul probability/);
    }
    // NaN/Infinity never reach range validation: the shared shape schema
    // rejects non-JSON numbers first. Either way they fail closed.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validateSystemOneResponse(request, {
          model: 'jev-1.13.0',
          answers: { is_urgent: { type: 'noul', noul: bad } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ).toThrow();
    }
    expect(() =>
      validateSystemOneResponse(request, {
        model: '',
        answers: { is_urgent: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow();
  });

  it('authentication failures never retry and surface an actionable message', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return new Response('invalid api key', { status: 401 });
    });

    await expect(executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Hi')).rejects.toThrow(
      AiMisconfigurationError,
    );
    expect(calls).toBe(1);
  });

  it('validation failures (422) never retry and are unsupported-use errors', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return new Response('malformed question', { status: 422 });
    });

    await expect(executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Hi')).rejects.toThrow(
      SystemOneUnsupportedError,
    );
    expect(calls).toBe(1);
  });

  it('rate limits retry exactly once with bounded backoff then succeed', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      return jsonResponse(validChoiceBody());
    });

    const result = await executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', CHOICE_QUESTION, 'Hi');
    expect(calls).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('persistent overload fails after exactly one retry (two attempts total)', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return new Response('overloaded', { status: 529 });
    });

    await expect(executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Hi')).rejects.toThrow(
      AiAvailabilityError,
    );
    expect(calls).toBe(2);
  });

  it('timeout failures retry once; caller cancellation never retries', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      if (calls === 1) throw new Error('Request timed out after 5000ms');
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: { is_urgent: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    });

    const result = await executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Hi');
    expect(calls).toBe(2);
    expect(result.retried).toBe(true);

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    let cancelCalls = 0;
    stubFetch(() => {
      cancelCalls += 1;
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: { is_urgent: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    });

    await expect(
      executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Hi', { signal: controller.signal }),
    ).rejects.toThrow();
    expect(cancelCalls).toBe(0);
  });

  it('redirects fail closed via the shared network controls', async () => {
    stubFetch(() => new Response('redirect', { status: 307, headers: { location: 'https://evil.example/x' } }));
    await expect(executeSystemOne(TYPESAFE_CONN, 'jev-1.13.0', NOUL_QUESTION, 'Hi')).rejects.toThrow();
  });

  it('disabled connections block dispatch before any network use', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return jsonResponse(validChoiceBody());
    });

    const disabled: ProviderConnection = { ...TYPESAFE_CONN, enabled: false };
    await expect(executeSystemOne(disabled, 'jev-1.13.0', CHOICE_QUESTION, 'Hi')).rejects.toThrow(
      /disabled/,
    );
    expect(calls).toBe(0);
    expect(isConnectionUsable(disabled)).toBe(false);
  });

  it('non-System One transports are unsupported for typed judgments', async () => {
    const chatConn: ProviderConnection = {
      ...TYPESAFE_CONN,
      id: 'openai-cloud',
      label: 'OpenAI (Cloud)',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      approvedHost: 'api.openai.com',
    };
    await expect(executeSystemOne(chatConn, 'gpt-4o-mini', NOUL_QUESTION, 'Hi')).rejects.toThrow(
      /cannot serve/,
    );
  });

  it('score questions and unknown pins fail closed without substitution', () => {
    expect(() =>
      validateSystemOneRequest({
        state: 'Hi',
        model: 'jev-1.13.0',
        questions: { s: { type: 'score', instructions: 'Rate this', criteria: ['low', 'high'] } },
      }),
    ).toThrow();

    expect(checkSystemOneModelPin('jev-1.13.0').ok).toBe(true);
    expect(checkSystemOneModelPin('jev-latest').ok).toBe(true);
    const unknown = checkSystemOneModelPin('jev-9.99.9');
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('never silently substituted');
    expect(() => assertSystemOneModelPin('jev-9.99.9', 'typesafe-jev')).toThrow(/not a recognized/);
  });

  it('Request/response bodies stay within documented bounds or fail with actionable errors', () => {
    expect(() =>
      validateSystemOneRequest({ state: 'x'.repeat(40_000), model: 'jev-1.13.0', questions: NOUL_QUESTION }),
    ).toThrow(/state payload exceeds/);

    const manyOptions: Record<string, string> = {};
    for (let i = 0; i < 260; i++) manyOptions[`option_${i}`] = `Option ${i}`;
    expect(() =>
      validateSystemOneRequest({
        state: 'Hi',
        model: 'jev-1.13.0',
        questions: { big: { type: 'choice', instructions: 'Pick', criteria: manyOptions } },
      }),
    ).toThrow(/candidate-limit/);
  });

  it('Retry-After parsing is bounded and Backoff stays within budget', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('9999')).toBeLessThanOrEqual(10_000);
    expect(parseRetryAfterMs('garbage')).toBeNull();
  });

  it('discovery parses models[].name aliases and the versioned pin stays available', async () => {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('/models')) {
        return jsonResponse({
          models: [
            { name: 'jev-latest', description: 'Latest stable', release_date: '2026-09-01' },
            { name: 'jev-preview', description: 'Preview', release_date: '2026-09-01' },
          ],
        });
      }
      return validChoiceBody();
    }) as unknown as typeof fetch;

    const health = await probeConnectionHealth(TYPESAFE_CONN, true);
    expect(health.status).toBe('online');
    expect(health.models.map((m) => m.id)).toEqual(['jev-latest', 'jev-preview']);

    const pin = await checkModelAvailability(TYPESAFE_CONN, 'jev-1.13.0');
    expect(pin.available).toBe(true);
    expect(pin.isModelPresent).toBe(true);

    const unknown = await checkModelAvailability(TYPESAFE_CONN, 'jev-9.99.9');
    expect(unknown.available).toBe(false);
    expect(unknown.warning).toContain('never silently substituted');
  });

  it('connection health does not imply chat-stage capability (healthy ≠ activatable)', async () => {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('/models')) {
        return jsonResponse({ models: [{ name: 'jev-latest', description: 'x', release_date: '2026-09-01' }] });
      }
      return validChoiceBody();
    }) as unknown as typeof fetch;

    const health = await probeConnectionHealth(TYPESAFE_CONN, true);
    expect(health.status).toBe('online');

    const { dispatchWorkloadChat } = await import('../../ai/inference-dispatcher');
    const { upsertProviderConnection, saveAiRoutingDefaults } = await import(
      '../../db/repositories/provider-connection-repo'
    );
    upsertProviderConnection(TYPESAFE_CONN);
    saveAiRoutingDefaults({
      catalogTarget: { connectionId: 'typesafe-jev', modelId: 'jev-1.13.0' },
      catalogFallback: null,
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    });

    await expect(
      dispatchWorkloadChat('curation', [{ role: 'user', content: 'classify' }]),
    ).rejects.toThrow(AiPolicyDeniedError);
  });

  it('chat/vision workload routes reject System One connections at server validation', async () => {
    const { upsertProviderConnection } = await import(
      '../../db/repositories/provider-connection-repo'
    );
    upsertProviderConnection(TYPESAFE_CONN);

    const routes = (await import('../../server/routes/onboarding-routes')).default;
    const res = await routes.request('/onboarding/settings/ai/workload-routes/curation', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primary: { connectionId: 'typesafe-jev', modelId: 'jev-1.13.0' },
        fallback: null,
        terminalBehavior: 'defer',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('systemone_chat_unsupported');
    expect(body.error).toContain('typed-judgment');
  });

  it('connection PUT validates transport, requires TypeSafe credentials, and preserves redacted secrets', async () => {
    const routes = (await import('../../server/routes/onboarding-routes')).default;

    const badTransport = await routes.request('/onboarding/settings/ai/connections/typesafe-jev', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'TypeSafe Jev (Cloud)',
        transport: 'carrier-pigeon',
        baseUrl: 'https://api.typesafe.ai/v1',
        credential: 'ts-key-1',
        trustZone: 'cloud',
        approvedHost: 'api.typesafe.ai',
        approvedPort: 443,
        enabled: true,
      }),
    });
    expect(badTransport.status).toBe(400);

    const noKey = await routes.request('/onboarding/settings/ai/connections/typesafe-jev', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'TypeSafe Jev (Cloud)',
        transport: 'systemone',
        baseUrl: 'https://api.typesafe.ai/v1',
        trustZone: 'cloud',
        approvedHost: 'api.typesafe.ai',
        approvedPort: 443,
        enabled: true,
      }),
    });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error?: string }).error).toContain('API key');

    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('api.typesafe.ai')) {
        return jsonResponse({ models: [{ name: 'jev-latest', description: 'x', release_date: '2026-09-01' }] });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const created = await routes.request('/onboarding/settings/ai/connections/typesafe-jev', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'TypeSafe Jev (Cloud)',
        transport: 'systemone',
        baseUrl: 'https://api.typesafe.ai/v1',
        credential: 'ts-test-fake-credential',
        trustZone: 'cloud',
        approvedHost: 'api.typesafe.ai',
        approvedPort: 443,
        enabled: true,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      connection?: { hasCredential?: boolean; credential?: string };
    };
    expect(createdBody.connection?.hasCredential).toBe(true);
    expect(createdBody.connection?.credential).toBeUndefined();

    const resaved = await routes.request('/onboarding/settings/ai/connections/typesafe-jev', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'TypeSafe Jev (Cloud) — relabeled',
        transport: 'systemone',
        baseUrl: 'https://api.typesafe.ai/v1',
        credential: '[REDACTED]',
        trustZone: 'cloud',
        approvedHost: 'api.typesafe.ai',
        approvedPort: 443,
        enabled: true,
      }),
    });
    expect(resaved.status).toBe(200);

    const { getProviderConnection } = await import(
      '../../db/repositories/provider-connection-repo'
    );
    expect(getProviderConnection('typesafe-jev')?.credential).toBe('ts-test-fake-credential');
  });
});
