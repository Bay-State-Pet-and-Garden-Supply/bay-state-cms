import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb, isDbInitialized } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import {
  upsertProviderConnection,
  upsertWorkloadRoute,
  deleteProviderConnection,
} from '../../db/repositories/provider-connection-repo';
import {
  listUsableStoreManagerModels,
  resolveAiSdkModel,
  resolveAiSdkModelWithFallback,
  createResilientModel,
  buildConnectionGuardedFetch,
  ModelUnavailableError,
} from '../../server/services/ai-sdk-model-resolver';
import { AiAvailabilityError, AiPolicyDeniedError } from '../../ai/network-transport';
import storeManagerRoutes from '../../server/routes/store-manager-routes';

describe('Store Manager model descriptor endpoint (epic #42, #32)', () => {
  const testDbPath = 'src/tests/unit/store-manager-models-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'gemma4:12b-mlx');
    upsertApiKey('deepseek', 'sk-deepseek-test', 'https://api.deepseek.com', 'deepseek-v4-flash');
    upsertApiKey('openai', 'sk-openai-test', 'https://api.openai.com/v1', 'gpt-4o-mini');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function withTaskConfig(body: () => void) {
    upsertLlmTaskConfig({ task: 'store_manager_assistant', provider: 'deepseek', model: 'deepseek-v4-flash' });
    try {
      body();
    } finally {
      deleteLlmTaskConfig('store_manager_assistant');
    }
  }

  describe('listUsableStoreManagerModels', () => {
    test('normally configured install exposes exactly one usable default', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        expect(result.models.length).toBeGreaterThan(0);
        expect(result.defaultModelId).toBe('deepseek-v4-flash');
        const defaults = result.models.filter(m => m.isDefault);
        expect(defaults.length).toBe(1);
        expect(defaults[0].id).toBe('deepseek-v4-flash');
        expect(defaults[0].provider).toBe('deepseek');
        expect(defaults[0].locality).toBe('cloud');
      });
    });

    test('every returned model resolves through resolveAiSdkModel and supports tools', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        expect(result.models.length).toBeGreaterThan(0);
        for (const m of result.models) {
          const resolved = resolveAiSdkModel(m.id);
          expect(resolved.modelId).toBe(m.id);
          expect(resolved.provider).toBe(m.provider);
          expect(resolved.locality).toBe(m.locality);
          expect(resolved.resolutionReason).toBe('explicit');
          expect(resolved.modelInstance).toBeDefined();
        }
      });
    });

    test('omitted selection resolves to the same default the endpoint marks', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        const resolved = resolveAiSdkModel();
        expect(resolved.resolutionReason).toBe('task_config');
        expect(result.defaultModelId).toBe(resolved.modelId);
        const defaultOption = result.models.find(m => m.isDefault);
        expect(defaultOption?.id).toBe(resolved.modelId);
      });
    });

    test('never leaks credentials or base URLs', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        const json = JSON.stringify(result);
        expect(json).not.toContain('sk-');
        expect(json).not.toContain('apiKey');
        expect(json).not.toContain('baseUrl');
        expect(json).not.toContain('http');
      });
    });
  });

  describe('unconfigured install fails closed', () => {
    test('empty/unconfigured state returns empty list plus setup message', () => {
      const db = getDb();
      db.query('DELETE FROM api_keys').run();
      try {
        const result = listUsableStoreManagerModels();
        expect(result.models).toEqual([]);
        expect(result.defaultModelId).toBeNull();
        expect(result.setupMessage).toBeDefined();
        expect(result.setupMessage?.length).toBeGreaterThan(0);
        expect(() => resolveAiSdkModel()).toThrow(ModelUnavailableError);
      } finally {
        upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'gemma4:12b-mlx');
        upsertApiKey('deepseek', 'sk-deepseek-test', 'https://api.deepseek.com', 'deepseek-v4-flash');
        upsertApiKey('openai', 'sk-openai-test', 'https://api.openai.com/v1', 'gpt-4o-mini');
      }
    });
  });

  describe('GET /store-manager/models route', () => {
    test('returns the descriptor payload without secrets', async () => {
      await withTaskConfigAsync(async () => {
        const res = await storeManagerRoutes.request('/store-manager/models');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          models: unknown[];
          defaultModelId: string | null;
          setupMessage?: string;
        };
        expect(Array.isArray(body.models)).toBe(true);
        expect(body.models.length).toBeGreaterThan(0);
        expect(body.defaultModelId).toBe('deepseek-v4-flash');
        expect(body.setupMessage).toBeUndefined();
        const json = JSON.stringify(body);
        expect(json).not.toContain('sk-');
        expect(json).not.toContain('apiKey');
        expect(json).not.toContain('baseUrl');
      });
    });
  });
});

async function withTaskConfigAsync(body: () => Promise<void>) {
  upsertLlmTaskConfig({ task: 'store_manager_assistant', provider: 'deepseek', model: 'deepseek-v4-flash' });
  try {
    await body();
  } finally {
    deleteLlmTaskConfig('store_manager_assistant');
  }
}

// ---------------------------------------------------------------------------
// AI Compute connections: capability validation, picker parity, and resilient
// fallback (review remediation). Own DB file so the registry/api_keys suites
// above are fully isolated.
// ---------------------------------------------------------------------------

describe('AI Compute connections: capability validation, picker parity & resilient fallback', () => {
  const testDbPath = 'src/tests/unit/store-manager-models-connections-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    // Registry credential for the legacy string-selection test (connection
    // suite keeps no other api_keys rows).
    upsertApiKey('deepseek', 'sk-deepseek-connections', 'https://api.deepseek.com', 'deepseek-v4-flash');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  afterEach(() => {
    if (isDbInitialized()) {
      try { deleteProviderConnection('office-pc'); } catch { /* ok */ }
      try { deleteProviderConnection('office-pc-2'); } catch { /* ok */ }
    }
  });

  function upsertLanConnection(id: string, baseUrl: string): void {
    if (!isDbInitialized()) {
      try { resetDb(); } catch { /* ok */ }
      initDb(testDbPath);
      runMigrations();
    }
    upsertProviderConnection({
      id,
      label: id === 'office-pc' ? 'Office PC' : 'Office PC 2',
      transport: 'openai-compatible',
      baseUrl,
      trustZone: 'trusted_lan',
      approvedHost: new URL(baseUrl).hostname,
      approvedPort: 1234,
      enabled: true,
    });
  }

  function fakeV4Model(opts: {
    throwOnStream?: boolean;
    streamErrorOnFirstRead?: boolean;
    parts?: Array<{ type: string; id?: string; delta?: string }>;
  } = {}) {
    const parts = opts.parts ?? [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'primary text' },
      { type: 'text-end', id: 't1' },
    ];
    return {
      specificationVersion: 'v4' as const,
      provider: 'fake-provider',
      modelId: 'fake-model',
      supportedUrls: {},
      async doGenerate() {
        if (opts.throwOnStream) throw new Error('primary generate failed');
        return {
          content: [],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          warnings: [],
        };
      },
      async doStream() {
        if (opts.throwOnStream) throw new Error('primary stream call failed');
        if (opts.streamErrorOnFirstRead) {
          return {
            stream: new ReadableStream({
              pull(controller) {
                controller.error(new Error('primary stream died before output'));
              },
            }),
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const p of parts) controller.enqueue(p);
              controller.close();
            },
          }),
        };
      },
    };
  }

  async function readAllParts(stream: ReadableStream<unknown>): Promise<unknown[]> {
    const reader = stream.getReader();
    const out: unknown[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  }

  test('LAN connection default appears in the picker and resolves', () => {
    upsertLanConnection('office-pc', 'http://192.168.1.75:1234/v1');
    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'office-pc', modelId: 'muse-glimmer' },
      fallback: null,
      // LAN primary requires a route policy permitting trusted_lan text (the
      // primary resolver now enforces the route's text data-sharing policy;
      // the seeded default is this_device_only).
      textDataSharing: 'trusted_lan_allowed',
      terminalBehavior: 'unavailable',
    });

    const resolved = resolveAiSdkModel();
    expect(resolved.provider).toBe('office-pc');
    expect(resolved.modelId).toBe('muse-glimmer');
    expect(resolved.locality).toBe('local');

    const picker = listUsableStoreManagerModels();
    expect(picker.defaultModelId).toBe('muse-glimmer');
    const descriptor = picker.models.find((m) => m.id === 'muse-glimmer');
    expect(descriptor).toBeDefined();
    expect(descriptor?.provider).toBe('office-pc');
    expect(descriptor?.providerLabel).toBe('Office PC');
    expect(descriptor?.locality).toBe('local');
    expect(descriptor?.isDefault).toBe(true);
  });

  test('non-tool model on a connection is rejected', () => {
    upsertLanConnection('office-pc', 'http://192.168.1.75:1234/v1');
    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'office-pc', modelId: 'text-embedding-model' },
      fallback: null,
      terminalBehavior: 'unavailable',
    });

    expect(() => resolveAiSdkModel()).toThrow(ModelUnavailableError);
    try {
      resolveAiSdkModel();
    } catch (err) {
      expect((err as ModelUnavailableError).message).toMatch(/tool calling/i);
    }
  });

  test('resilient wrapper retries the fallback when the primary stream dies before output', async () => {
    let fallbackUsed = 0;
    const primary = fakeV4Model({ streamErrorOnFirstRead: true });
    const fallback = fakeV4Model({
      parts: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'fallback text' },
        { type: 'text-end', id: 't1' },
      ],
    });
    const wrapped = createResilientModel(
      primary as unknown as Parameters<typeof createResilientModel>[0],
      fallback as unknown as Parameters<typeof createResilientModel>[1],
      () => { fallbackUsed += 1; },
    );

    const result = await (wrapped as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream<unknown> }> }).doStream({ prompt: [] });
    const parts = await readAllParts(result.stream);

    expect(fallbackUsed).toBe(1);
    expect(parts.some((p) => (p as { type?: string; delta?: string }).type === 'text-delta' && (p as { delta?: string }).delta === 'fallback text')).toBe(true);
  });

  test('resilient wrapper does not use the fallback when the primary succeeds', async () => {
    let fallbackUsed = 0;
    const primary = fakeV4Model();
    const fallback = fakeV4Model({ parts: [{ type: 'text-delta', id: 't1', delta: 'SHOULD NOT APPEAR' }] });
    const wrapped = createResilientModel(
      primary as unknown as Parameters<typeof createResilientModel>[0],
      fallback as unknown as Parameters<typeof createResilientModel>[1],
      () => { fallbackUsed += 1; },
    );

    const result = await (wrapped as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream<unknown> }> }).doStream({ prompt: [] });
    const parts = await readAllParts(result.stream);

    expect(fallbackUsed).toBe(0);
    expect(parts.some((p) => (p as { type?: string; delta?: string }).type === 'text-delta' && (p as { delta?: string }).delta === 'primary text')).toBe(true);
    expect(parts.some((p) => (p as { delta?: string }).delta === 'SHOULD NOT APPEAR')).toBe(false);
  });

  test('resilient wrapper never retries on caller abort', async () => {
    let fallbackUsed = 0;
    const primary = fakeV4Model({ throwOnStream: true });
    const fallback = fakeV4Model();
    const wrapped = createResilientModel(
      primary as unknown as Parameters<typeof createResilientModel>[0],
      fallback as unknown as Parameters<typeof createResilientModel>[1],
      () => { fallbackUsed += 1; },
    );

    await expect(
      (wrapped as unknown as { doStream: (o: unknown) => Promise<unknown> }).doStream({ prompt: [], abortSignal: AbortSignal.abort() }),
    ).rejects.toThrow(/primary stream call failed/);
    expect(fallbackUsed).toBe(0);
  });

  test('resolveAiSdkModelWithFallback wires executedFallback when the primary fails end-to-end', async () => {
    upsertLanConnection('office-pc', 'http://192.168.1.75:1234/v1');
    upsertLanConnection('office-pc-2', 'http://192.168.1.76:1234/v1');
    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'office-pc', modelId: 'muse-glimmer' },
      fallback: { connectionId: 'office-pc-2', modelId: 'gpt-4o-mini' },
      textDataSharing: 'trusted_lan_allowed',
      terminalBehavior: 'unavailable',
    });

    const resolved = resolveAiSdkModelWithFallback();
    expect(resolved.provider).toBe('office-pc');
    expect(resolved.fallback).toBeDefined();
    expect(resolved.fallback?.provider).toBe('office-pc-2');
    expect(resolved.fallback?.modelId).toBe('gpt-4o-mini');
    expect(resolved.executedFallback).toBeUndefined();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('192.168.1.75')) {
        const err = new TypeError('fetch failed: Connection refused');
        (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      if (urlStr.includes('192.168.1.76')) {
        const sse = [
          'data: {"choices":[{"delta":{"role":"assistant","content":"fallback text"},"finish_reason":null,"index":0}]}',
          '',
          'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');
        return new Response(new TextEncoder().encode(sse), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    try {
      const result = await (resolved.modelInstance as unknown as {
        doStream: (o: unknown) => Promise<{ stream: ReadableStream<unknown> }>;
      }).doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      });
      const parts = await readAllParts(result.stream);
      expect(parts.some((p) => (p as { type?: string; delta?: string }).type === 'text-delta' && (p as { delta?: string }).delta === 'fallback text')).toBe(true);
      expect(resolved.executedFallback).toBeDefined();
      expect(resolved.executedFallback?.provider).toBe('office-pc-2');
      expect(resolved.executedFallback?.modelId).toBe('gpt-4o-mini');
      expect(resolved.executedFallback?.locality).toBe('local');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('route_default keeps the configured fallback; explicit and legacy selections never fall back', () => {
    upsertLanConnection('office-pc', 'http://192.168.1.75:1234/v1');
    upsertLanConnection('office-pc-2', 'http://192.168.1.76:1234/v1');
    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'office-pc', modelId: 'muse-glimmer' },
      fallback: { connectionId: 'office-pc-2', modelId: 'gpt-4o-mini' },
      textDataSharing: 'trusted_lan_allowed',
      terminalBehavior: 'unavailable',
    });

    // { mode: 'route_default' } (the UI default) keeps fallback semantics.
    const routeDefault = resolveAiSdkModelWithFallback({ mode: 'route_default' });
    expect(routeDefault.provider).toBe('office-pc');
    expect(routeDefault.modelId).toBe('muse-glimmer');
    expect(routeDefault.fallback).toBeDefined();
    expect(routeDefault.fallback?.provider).toBe('office-pc-2');
    expect(routeDefault.fallback?.modelId).toBe('gpt-4o-mini');

    // Connection-addressed explicit override: never falls back.
    const explicit = resolveAiSdkModelWithFallback({
      mode: 'explicit',
      target: { connectionId: 'office-pc', modelId: 'muse-glimmer' },
    });
    expect(explicit.provider).toBe('office-pc');
    expect(explicit.modelId).toBe('muse-glimmer');
    expect(explicit.fallback).toBeUndefined();

    // Legacy bare model-id string: registry-resolved, never falls back.
    const legacy = resolveAiSdkModelWithFallback('deepseek-v4-flash');
    expect(legacy.provider).toBe('deepseek');
    expect(legacy.modelId).toBe('deepseek-v4-flash');
    expect(legacy.fallback).toBeUndefined();
  });

  test('a cloud primary denied by the route text data-sharing policy fails closed', () => {
    upsertProviderConnection({
      id: 'cloud-openai',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-test-openai-conn',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
    });
    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'cloud-openai', modelId: 'gpt-4o-mini' },
      fallback: null,
      textDataSharing: 'this_device_only',
      terminalBehavior: 'unavailable',
    });
    try {
      expect(() => resolveAiSdkModelWithFallback({ mode: 'route_default' })).toThrow(ModelUnavailableError);
      try {
        resolveAiSdkModelWithFallback({ mode: 'route_default' });
      } catch (err) {
        expect((err as ModelUnavailableError).message).toMatch(/this_device_only/i);
      }
    } finally {
      deleteProviderConnection('cloud-openai');
    }
  });

  test('guarded fetch rejects trust-zone-violating connections before any request', async () => {
    const conn = {
      id: 'bad-pin-conn',
      label: 'Bad Pin',
      transport: 'openai-compatible' as const,
      baseUrl: 'http://192.168.1.50:1234/v1',
      trustZone: 'trusted_lan' as const,
      approvedHost: '192.168.1.99',
      approvedPort: 1234,
      enabled: true,
    };
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('should not be reached');
    }) as unknown as typeof fetch;
    try {
      const guarded = buildConnectionGuardedFetch(conn);
      await expect(guarded('http://192.168.1.50:1234/v1/chat/completions')).rejects.toThrow(/approved host/);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('guarded fetch denies redirects (anti-SSRF) and classifies network failures as availability', async () => {
    const conn = {
      id: 'guard-conn',
      label: 'Guard',
      transport: 'openai-compatible' as const,
      baseUrl: 'http://192.168.1.75:1234/v1',
      trustZone: 'trusted_lan' as const,
      approvedHost: '192.168.1.75',
      approvedPort: 1234,
      enabled: true,
    };
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('redirect', { status: 307 })) as unknown as typeof fetch;
      const guarded = buildConnectionGuardedFetch(conn);
      await expect(guarded('http://192.168.1.75:1234/v1/chat/completions')).rejects.toThrow(/redirect/i);

      globalThis.fetch = (async () => {
        throw new TypeError('fetch failed: Connection refused');
      }) as unknown as typeof fetch;
      await expect(guarded('http://192.168.1.75:1234/v1/chat/completions')).rejects.toThrow(AiAvailabilityError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resilient wrapper never falls back on policy-denial errors, including wrapped causes', async () => {
    const policyDenied = new AiPolicyDeniedError('redirect rejected (anti-SSRF)', 'office-pc', 'muse-glimmer');
    const makePrimary = (error: unknown) => ({
      ...fakeV4Model(),
      doStream: async () => {
        throw error;
      },
      doGenerate: async () => {
        throw error;
      },
    });
    const fallback = fakeV4Model({ parts: [{ type: 'text-delta', id: 't1', delta: 'SHOULD NOT APPEAR' }] });

    // Direct AiPolicyDeniedError: no fallback.
    let fallbackUsed = 0;
    const wrappedDirect = createResilientModel(
      makePrimary(policyDenied) as unknown as Parameters<typeof createResilientModel>[0],
      fallback as unknown as Parameters<typeof createResilientModel>[1],
      () => { fallbackUsed += 1; },
    );
    await expect(
      (wrappedDirect as unknown as { doStream: (o: unknown) => Promise<unknown> }).doStream({ prompt: [] }),
    ).rejects.toBe(policyDenied);
    expect(fallbackUsed).toBe(0);

    // Error wrapped by the AI SDK (APICallError carries the original as cause).
    const sdkWrapped = new Error('APICallError: fetch failed');
    sdkWrapped.cause = policyDenied;
    fallbackUsed = 0;
    const wrappedCause = createResilientModel(
      makePrimary(sdkWrapped) as unknown as Parameters<typeof createResilientModel>[0],
      fallback as unknown as Parameters<typeof createResilientModel>[1],
      () => { fallbackUsed += 1; },
    );
    await expect(
      (wrappedCause as unknown as { doStream: (o: unknown) => Promise<unknown> }).doStream({ prompt: [] }),
    ).rejects.toBe(sdkWrapped);
    expect(fallbackUsed).toBe(0);
  });
});
