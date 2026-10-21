import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  isLoopbackHost,
  isPrivateLanHost,
  isLinkLocalOrMetadataHost,
  validateConnectionTrustZone,
  isTargetPermittedByPolicy,
  toClientProviderConnection,
  type ProviderConnection,
  type AiRoutingConfig,
} from '../../ai/provider-connections';
import {
  AiPolicyDeniedError,
  executeOpenAiChat,
} from '../../ai/network-transport';
import { dispatchWorkloadChat } from '../../ai/inference-dispatcher';
import {
  probeConnectionHealth,
  getCachedConnectionHealth,
  clearHealthCache,
} from '../../ai/connection-health-monitor';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import {
  upsertProviderConnection,
  getProviderConnection,
  listProviderConnections,
  deleteProviderConnection,
  saveAiRoutingDefaults,
  upsertWorkloadRoute,
  getFullAiRoutingConfig,
} from '../../db/repositories/provider-connection-repo';
import { upsertApiKey, getApiKey, deleteApiKey } from '../../db/repositories/api-key-repo';
import { resolveSystemOneCredential } from '../../classification/systemone-decision-core';

describe('Provider Connections & Trust Zone Governance', () => {
  describe('IP & Host Classification', () => {
    it('identifies loopback hosts correctly', () => {
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('127.0.0.50')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('sub.localhost')).toBe(true);
      expect(isLoopbackHost('192.168.1.50')).toBe(false);
      expect(isLoopbackHost('api.openai.com')).toBe(false);
    });

    it('identifies private LAN hosts correctly', () => {
      expect(isPrivateLanHost('192.168.1.100')).toBe(true);
      expect(isPrivateLanHost('10.0.0.5')).toBe(true);
      expect(isPrivateLanHost('172.16.0.1')).toBe(true);
      expect(isPrivateLanHost('172.31.255.255')).toBe(true);
      expect(isPrivateLanHost('desktop.local')).toBe(true);
      expect(isPrivateLanHost('172.32.0.1')).toBe(false);
      expect(isPrivateLanHost('8.8.8.8')).toBe(false);
      expect(isPrivateLanHost('localhost')).toBe(false);
    });

    it('identifies link-local and metadata addresses', () => {
      expect(isLinkLocalOrMetadataHost('169.254.169.254')).toBe(true);
      expect(isLinkLocalOrMetadataHost('169.254.1.1')).toBe(true);
      expect(isLinkLocalOrMetadataHost('100.64.0.1')).toBe(true);
      expect(isLinkLocalOrMetadataHost('0.0.0.0')).toBe(true);
      expect(isLinkLocalOrMetadataHost('192.168.1.50')).toBe(false);
      expect(isLinkLocalOrMetadataHost('api.openai.com')).toBe(false);
    });

    it('enforces trust zone validation for this_device', () => {
      const conn: ProviderConnection = {
        id: 'test-local',
        label: 'Local',
        transport: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        trustZone: 'this_device',
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(conn)).not.toThrow();

      const invalidConn: ProviderConnection = {
        ...conn,
        baseUrl: 'http://192.168.1.50:1234/v1',
      };
      expect(() => validateConnectionTrustZone(invalidConn)).toThrowError(/not a loopback address/);
    });

    it('enforces trust zone validation for trusted_lan', () => {
      const conn: ProviderConnection = {
        id: 'test-lan',
        label: 'LAN Desktop',
        transport: 'openai-compatible',
        baseUrl: 'http://192.168.1.50:1234/v1',
        trustZone: 'trusted_lan',
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(conn)).not.toThrow();

      const invalidConn: ProviderConnection = {
        ...conn,
        baseUrl: 'https://api.openai.com/v1',
      };
      expect(() => validateConnectionTrustZone(invalidConn)).toThrowError(/not a private LAN/);
    });

    it('enforces strict cloud validation (HTTPS required, blocks internal/metadata IPs)', () => {
      const validCloud: ProviderConnection = {
        id: 'valid-cloud',
        label: 'Valid Cloud',
        transport: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        trustZone: 'cloud',
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(validCloud)).not.toThrow();

      // Insecure HTTP to cloud rejected
      const httpCloud: ProviderConnection = {
        ...validCloud,
        baseUrl: 'http://api.openai.com/v1',
      };
      expect(() => validateConnectionTrustZone(httpCloud)).toThrowError(/must use https:/);

      // Cloud pointing to LAN rejected
      const lanCloud: ProviderConnection = {
        ...validCloud,
        baseUrl: 'https://192.168.1.50/v1',
      };
      expect(() => validateConnectionTrustZone(lanCloud)).toThrowError(/cannot point to local\/private\/metadata/);

      // Cloud pointing to AWS metadata IP rejected
      const metadataCloud: ProviderConnection = {
        ...validCloud,
        baseUrl: 'https://169.254.169.254/latest/meta-data',
      };
      expect(() => validateConnectionTrustZone(metadataCloud)).toThrowError(/cannot point to local\/private\/metadata/);
    });

    it('enforces operator host and port pinning (Anti-SSRF)', () => {
      const conn: ProviderConnection = {
        id: 'test-pinned',
        label: 'Pinned Desktop',
        transport: 'openai-compatible',
        baseUrl: 'http://192.168.1.50:1234/v1',
        trustZone: 'trusted_lan',
        approvedHost: '192.168.1.50',
        approvedPort: 1234,
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(conn)).not.toThrow();

      const mismatchedHost: ProviderConnection = {
        ...conn,
        baseUrl: 'http://192.168.1.99:1234/v1',
      };
      expect(() => validateConnectionTrustZone(mismatchedHost)).toThrowError(/does not match approved host/);

      const mismatchedPort: ProviderConnection = {
        ...conn,
        baseUrl: 'http://192.168.1.50:5678/v1',
      };
      expect(() => validateConnectionTrustZone(mismatchedPort)).toThrowError(/does not match approved port/);
    });
  });

  describe('Data Sharing Policy Permissions', () => {
    it('enforces this_device_only', () => {
      expect(isTargetPermittedByPolicy('this_device', 'this_device_only')).toBe(true);
      expect(isTargetPermittedByPolicy('trusted_lan', 'this_device_only')).toBe(false);
      expect(isTargetPermittedByPolicy('cloud', 'this_device_only')).toBe(false);
    });

    it('enforces trusted_lan_allowed', () => {
      expect(isTargetPermittedByPolicy('this_device', 'trusted_lan_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('trusted_lan', 'trusted_lan_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('cloud', 'trusted_lan_allowed')).toBe(false);
    });

    it('enforces cloud_allowed', () => {
      expect(isTargetPermittedByPolicy('this_device', 'cloud_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('trusted_lan', 'cloud_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('cloud', 'cloud_allowed')).toBe(true);
    });
  });
});

describe('Inference Dispatcher & Availability Failover', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    clearHealthCache();
  });

  const mockConfig: AiRoutingConfig = {
    connections: {
      'desktop-lm': {
        id: 'desktop-lm',
        label: 'Desktop LM Studio',
        transport: 'openai-compatible',
        baseUrl: 'http://192.168.1.50:1234/v1',
        trustZone: 'trusted_lan',
        approvedHost: '192.168.1.50',
        approvedPort: 1234,
        enabled: true,
        connectTimeoutMs: 100,
        inferenceTimeoutMs: 500,
      },
      'openai-cloud': {
        id: 'openai-cloud',
        label: 'OpenAI Cloud',
        transport: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        credential: 'sk-mock-key',
        trustZone: 'cloud',
        approvedHost: 'api.openai.com',
        approvedPort: 443,
        enabled: true,
        connectTimeoutMs: 100,
        inferenceTimeoutMs: 500,
      },
    },
    defaults: {
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
      catalogTarget: { connectionId: 'desktop-lm', modelId: 'qwen3.8:27b' },
      catalogFallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
    },
    workloads: {
      discovery: {
        primary: 'inherit',
        fallback: 'inherit',
        terminalBehavior: 'heuristic',
      },
      curation: {
        primary: 'inherit',
        fallback: 'inherit',
        terminalBehavior: 'defer',
      },
      visionOcr: {
        primary: { connectionId: 'desktop-lm', modelId: 'gemma-4-26b-a4b-qat' },
        fallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o' },
        imageDataSharing: 'trusted_lan_allowed',
        terminalBehavior: 'heuristic',
      },
      profileBuilder: {
        primary: 'inherit',
        fallback: 'inherit',
        terminalBehavior: 'fail_closed',
      },
      storeManager: {
        primary: { connectionId: 'desktop-lm', modelId: 'muse-glimmer' },
        fallback: 'inherit',
        terminalBehavior: 'unavailable',
      },
    },
  };

  it('rejects HTTP 3xx redirects to prevent SSRF and trust zone bypass', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 307,
      statusText: 'Temporary Redirect',
    } as any);

    const conn = mockConfig.connections['desktop-lm'];
    await expect(
      executeOpenAiChat(conn, 'qwen3.8:27b', [{ role: 'user', content: 'test prompt' }]),
    ).rejects.toThrowError(/AI endpoints forbid redirects/);
  });

  it('successfully executes primary target when online', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Consolidated Title Output' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as any);

    const result = await dispatchWorkloadChat(
      'curation',
      [{ role: 'user', content: 'test prompt' }],
      { routingConfig: mockConfig },
    );

    expect(result.content).toBe('Consolidated Title Output');
    expect(result.executedTarget).toEqual({ connectionId: 'desktop-lm', modelId: 'qwen3.8:27b' });
    expect(result.wasFallback).toBe(false);
  });

  it('fails over immediately when desktop connection is refused (offline PC)', async () => {
    let callCount = 0;
    (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('192.168.1.50')) {
        const err = new Error('fetch failed: Connection refused');
        (err as any).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      // Cloud Fallback Succeeds
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Fallback Cloud Result' } }],
        }),
      };
    });

    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'find brand' }],
      { routingConfig: mockConfig },
    );

    expect(callCount).toBe(2);
    expect(result.content).toBe('Fallback Cloud Result');
    expect(result.executedTarget).toEqual({ connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' });
    expect(result.wasFallback).toBe(true);
  });

  it('fails closed and NEVER falls back on Policy Denial', async () => {
    const policyRestrictedConfig: AiRoutingConfig = {
      ...mockConfig,
      defaults: {
        ...mockConfig.defaults,
        textDataSharing: 'this_device_only', // Disallows LAN and Cloud!
      },
    };

    await expect(
      dispatchWorkloadChat(
        'curation',
        [{ role: 'user', content: 'test' }],
        { routingConfig: policyRestrictedConfig },
      ),
    ).rejects.toThrowError(AiPolicyDeniedError);
  });

  it('falls over and warns when model is missing (HTTP 404 misconfiguration)', async () => {
    (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('192.168.1.50')) {
        return {
          ok: false,
          status: 404,
          text: async () => 'Model qwen3.8:27b not loaded',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Fallback from cloud' } }],
        }),
      };
    });

    const result = await dispatchWorkloadChat(
      'curation',
      [{ role: 'user', content: 'test' }],
      { routingConfig: mockConfig },
    );

    expect(result.wasFallback).toBe(true);
    expect(result.warning?.toLowerCase()).toContain('misconfigured');
    expect(result.executedTarget).toEqual({ connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' });
  });

  it('never converts a cached misconfigured LAN state into an availability failure', async () => {
    clearHealthCache();
    let mode: 'probe' | 'dispatch' = 'probe';
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (mode === 'probe') {
        // Health probe against /models → HTTP 401 (bad credential) → cached 'misconfigured'.
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'invalid api key',
        } as any;
      }
      if (url.includes('192.168.1.50')) {
        // Dispatch: the LAN transport is RE-VALIDATED (not skipped as an
        // availability failure) and re-classified as a misconfiguration.
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'invalid api key',
        } as any;
      }
      // Cloud fallback succeeds.
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Fallback Cloud Result' } }] }),
      } as any;
    });

    const conn = mockConfig.connections['desktop-lm'];
    const report = await probeConnectionHealth(conn, true);
    expect(report.status).toBe('misconfigured');
    expect(getCachedConnectionHealth('desktop-lm')).toBe('misconfigured');

    mode = 'dispatch';
    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'test' }],
      { routingConfig: mockConfig },
    );

    // The primary chat/completions transport WAS attempted — a cached
    // 'misconfigured' state must never be silently converted into an
    // availability-style fast failover. The transport then classified it as
    // a misconfiguration and fell back with a visible warning.
    expect(result.wasFallback).toBe(true);
    expect(result.warning?.toLowerCase()).toContain('misconfigured');
    expect(calls.filter(u => u.includes('/chat/completions') && u.includes('192.168.1.50')).length).toBe(1);
    expect(calls.some(u => u.includes('api.openai.com'))).toBe(true);
    clearHealthCache();
  });

  it('fast-fails from a cached unreachable LAN state without attempting primary transport', async () => {
    clearHealthCache();
    let mode: 'probe' | 'dispatch' = 'probe';
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (mode === 'probe') {
        const err = new Error('fetch failed: Connection refused');
        (err as any).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Fallback Cloud Result' } }] }),
      } as any;
    });

    const conn = mockConfig.connections['desktop-lm'];
    const report = await probeConnectionHealth(conn, true);
    expect(report.status).toBe('unreachable');
    expect(getCachedConnectionHealth('desktop-lm')).toBe('unreachable');

    mode = 'dispatch';
    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'test' }],
      { routingConfig: mockConfig },
    );
    expect(result.wasFallback).toBe(true);
    expect(result.executedTarget.connectionId).toBe('openai-cloud');
    // Availability fast-failover: the primary transport was never attempted.
    expect(calls.filter(u => u.includes('/chat/completions') && u.includes('192.168.1.50')).length).toBe(0);
    clearHealthCache();
  });

  it('blocks image dispatch to cloud when image sharing is trusted_lan_allowed', async () => {
    // Desktop offline -> Fallback is openai-cloud
    // But visionOcr requires image, and image policy is trusted_lan_allowed -> Cloud fallback denied!
    (globalThis as any).fetch = vi.fn().mockImplementation(async () => {
      throw new Error('Connection refused');
    });

    await expect(
      dispatchWorkloadChat(
        'visionOcr',
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } }] }],
        { requiresImage: true, routingConfig: mockConfig },
      ),
    ).rejects.toThrowError(AiPolicyDeniedError);
  });
});

describe('Database Repository Integration & Redaction', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('persists connections, redacts credentials for client, and preserves secrets on edit', () => {
    const testConn: ProviderConnection = {
      id: 'test-secure-conn',
      label: 'Secure Cloud Provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-secret-key-12345',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
    };

    upsertProviderConnection(testConn);

    // Database row contains raw secret
    const saved = getProviderConnection('test-secure-conn');
    expect(saved?.credential).toBe('sk-secret-key-12345');

    // Client view is redacted
    const clientView = toClientProviderConnection(saved!);
    expect((clientView as any).credential).toBeUndefined();
    expect(clientView.hasCredential).toBe(true);

    // Re-saving with masked credential '[REDACTED]' preserves the stored secret!
    upsertProviderConnection({
      ...testConn,
      label: 'Updated Label',
      credential: '[REDACTED]',
    });

    const reloaded = getProviderConnection('test-secure-conn');
    expect(reloaded?.label).toBe('Updated Label');
    expect(reloaded?.credential).toBe('sk-secret-key-12345');
  });

  it('persists defaults and workload routes with safe deletion repair', () => {
    saveAiRoutingDefaults({
      catalogTarget: { connectionId: 'desktop-lmstudio', modelId: 'qwen3.8:27b' },
      catalogFallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    });

    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'desktop-lmstudio', modelId: 'muse-glimmer' },
      fallback: 'inherit',
      terminalBehavior: 'unavailable',
    });

    const full = getFullAiRoutingConfig();
    expect(full.defaults.catalogTarget.modelId).toBe('qwen3.8:27b');
    expect(full.workloads.storeManager.primary).toEqual({
      connectionId: 'desktop-lmstudio',
      modelId: 'muse-glimmer',
    });

    // Delete connection and verify routes AND defaults are safely repaired
    deleteProviderConnection('desktop-lmstudio');
    const repaired = getFullAiRoutingConfig();
    expect(repaired.connections['desktop-lmstudio']).toBeUndefined();
    expect(repaired.workloads.storeManager.primary).toBe('inherit');
    expect(repaired.defaults.catalogTarget.connectionId).not.toBe('desktop-lmstudio');
    expect(repaired.defaults.catalogTarget.modelId).toBeTruthy();
  });

  it('reconciles missing built-in connections (openai-cloud) on existing installs without clobbering operator edits', () => {
    // Operator relabel + credential on an existing built-in row: must survive
    // the reconciliation untouched.
    upsertProviderConnection({
      id: 'deepseek-cloud',
      label: 'DeepSeek (Cloud) — operator relabeled',
      transport: 'openai-compatible',
      baseUrl: 'https://custom.deepseek.example/v1',
      credential: 'sk-operator-key',
      trustZone: 'cloud',
      approvedHost: 'custom.deepseek.example',
      approvedPort: 443,
      enabled: true,
    });

    // Simulate an install whose provider_connections table was seeded before
    // `openai-cloud` joined the built-in set: the row is absent from the DB.
    // Written directly because the repo API self-heals on every access — the
    // old empty-table guard left such installs permanently missing the
    // built-in.
    getDb().query("DELETE FROM provider_connections WHERE id = 'openai-cloud'").run();
    expect(
      getDb().query("SELECT id FROM provider_connections WHERE id = 'openai-cloud'").get(),
    ).toBeNull();

    // Self-healing reconcile: the missing built-in is re-added on next access...
    const connections = listProviderConnections();
    const openai = connections.find(c => c.id === 'openai-cloud');
    expect(openai).toBeDefined();
    expect(openai?.baseUrl).toBe('https://api.openai.com/v1');
    expect(openai?.approvedHost).toBe('api.openai.com');
    expect(openai?.approvedPort).toBe(443);
    expect(openai?.enabled).toBe(true);

    // ...and operator edits on existing rows are preserved.
    const deepseek = connections.find(c => c.id === 'deepseek-cloud');
    expect(deepseek?.label).toBe('DeepSeek (Cloud) — operator relabeled');
    expect(deepseek?.credential).toBe('sk-operator-key');
    expect(deepseek?.baseUrl).toBe('https://custom.deepseek.example/v1');
  });
  it('resolves a TypeSafe credential from the disposable api_keys row and removes the fake key', () => {
    const fakeKey = 'fake-typesafe-key-for-unit-test';
    runMigrations();
    upsertApiKey('typesafe', fakeKey, 'https://api.typesafe.ai/v1');

    try {
      expect(resolveSystemOneCredential('typesafe')).toEqual({
        provider: 'typesafe',
        apiKey: fakeKey,
        baseUrl: 'https://api.typesafe.ai/v1',
        model: null,
      });
    } finally {
      deleteApiKey('typesafe');
    }

    expect(getApiKey('typesafe')).toBeFalsy();
  });

});
describe('End-to-End Production Routing, Failover & Authority Integration', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    clearHealthCache();
  });

  it('routes production text call through InferenceDispatcher and falls over from desktop LAN to cloud fallback', async () => {
    // 1. Setup SQLite with primary Desktop LM Studio and fallback OpenAI Cloud
    upsertProviderConnection({
      id: 'desktop-lmstudio',
      label: 'Desktop LM Studio',
      transport: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:1234/v1',
      trustZone: 'trusted_lan',
      approvedHost: '192.168.1.50',
      approvedPort: 1234,
      enabled: true,
    });

    upsertProviderConnection({
      id: 'openai-cloud',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-test-openai-key',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
    });

    saveAiRoutingDefaults({
      catalogTarget: { connectionId: 'desktop-lmstudio', modelId: 'qwen3.8:27b' },
      catalogFallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    });

    // 2. Mock fetch: Desktop LAN is offline (ECONNREFUSED / fetch failure), OpenAI Cloud succeeds
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; auth?: string; model?: string }> = [];

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = String(url);
      const auth = init?.headers?.Authorization || init?.headers?.authorization;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url: urlStr, auth, model: body?.model });

      if (urlStr.includes('192.168.1.50')) {
        const err = new TypeError('Failed to fetch: Connection refused');
        (err as any).code = 'ECONNREFUSED';
        throw err;
      }

      if (urlStr.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Consolidated Product Title from Fallback' } }],
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return originalFetch(url, init);
    }) as any;

    try {
      // 3. Execute dispatchWorkloadChat for discovery workload
      const res = await dispatchWorkloadChat('discovery', [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Infer brand for Purina' },
      ]);
      expect(res.content).toBe('Consolidated Product Title from Fallback');
      expect(res.wasFallback).toBe(true);
      expect(res.executedTarget.connectionId).toBe('openai-cloud');

      // Verify failover happened: primary was attempted, then fallback was executed
      expect(fetchCalls.some(c => c.url.includes('192.168.1.50'))).toBe(true);
      const fallbackCall = fetchCalls.find(c => c.url.includes('api.openai.com'));
      expect(fallbackCall).toBeDefined();
      expect(fallbackCall?.model).toBe('gpt-4o-mini');
      expect(fallbackCall?.auth).toBe('Bearer sk-test-openai-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records dispatcher telemetry rows for primary failure and fallback success in ai_model_calls', async () => {
    clearHealthCache();
    // The E2E describe uses an un-migrated in-memory DB; the telemetry table
    // must exist for dispatcher telemetry rows.
    runMigrations();
    upsertProviderConnection({
      id: 'desktop-lmstudio',
      label: 'Desktop LM Studio',
      transport: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:1234/v1',
      trustZone: 'trusted_lan',
      approvedHost: '192.168.1.50',
      approvedPort: 1234,
      enabled: true,
    });
    upsertProviderConnection({
      id: 'openai-cloud',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-test-openai-key',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
    });
    saveAiRoutingDefaults({
      catalogTarget: { connectionId: 'desktop-lmstudio', modelId: 'qwen3.8:27b' },
      catalogFallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('192.168.1.50')) {
        const err = new TypeError('Failed to fetch: Connection refused');
        (err as any).code = 'ECONNREFUSED';
        throw err;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Fallback Cloud Result' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    try {
      const res = await dispatchWorkloadChat('discovery', [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Infer brand for Purina' },
      ], { telemetry: { task: 'discovery' } });
      expect(res.wasFallback).toBe(true);
      expect(res.executedTarget.connectionId).toBe('openai-cloud');

      const rows = getAiModelCallsByWorkspace('default');
      const primary = rows.find(r => !r.fallback_from_call_id);
      const fallback = rows.find(r => r.fallback_from_call_id);
      expect(primary).toBeDefined();
      expect(fallback).toBeDefined();
      if (primary && fallback) {
        expect(primary.task).toBe('discovery');
        expect(primary.provider).toBe('desktop-lmstudio');
        expect(primary.status).toBe('failed');
        expect(fallback.task).toBe('discovery');
        expect(fallback.provider).toBe('openai-cloud');
        expect(fallback.status).toBe('success');
        expect(fallback.fallback_from_call_id).toBe(primary.id);
        expect(fallback.retry_count).toBe(1);
        expect(fallback.prompt_tokens).toBe(10);
        expect(fallback.completion_tokens).toBe(5);
      }
    } finally {
      globalThis.fetch = originalFetch;
      clearHealthCache();
    }
  });

  it('Store Manager directly resolves custom LAN connection and model from AI Compute settings', async () => {
    const { resolveAiSdkModel } = await import('../../server/services/ai-sdk-model-resolver');

    upsertProviderConnection({
      id: 'custom-lan-box',
      label: 'Custom Office PC',
      transport: 'openai-compatible',
      baseUrl: 'http://192.168.1.75:1234/v1',
      trustZone: 'trusted_lan',
      approvedHost: '192.168.1.75',
      approvedPort: 1234,
      enabled: true,
    });

    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'custom-lan-box', modelId: 'muse-glimmer' },
      fallback: 'inherit',
      // LAN primary requires a route policy that permits trusted_lan text
      // (the seeded default is this_device_only — the primary resolver now
      // enforces the route's text data-sharing policy).
      textDataSharing: 'trusted_lan_allowed',
      terminalBehavior: 'unavailable',
    });

    const resolved = resolveAiSdkModel();
    expect(resolved.provider).toBe('custom-lan-box');
    expect(resolved.modelId).toBe('muse-glimmer');
    expect(resolved.locality).toBe('local');
    expect(resolved.modelInstance).toBeDefined();
  });

  it('Vision / OCR resolves desktop-lmstudio connection and model from AI Compute visionOcr route', async () => {
    const { getVlmConfig } = await import('../../onboarding/vlm-client');

    upsertProviderConnection({
      id: 'desktop-lmstudio',
      label: 'Desktop LM Studio',
      transport: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:1234/v1',
      trustZone: 'trusted_lan',
      approvedHost: '192.168.1.50',
      approvedPort: 1234,
      enabled: true,
    });

    upsertWorkloadRoute('visionOcr', {
      primary: { connectionId: 'desktop-lmstudio', modelId: 'gemma-4-26b-a4b-qat' },
      fallback: 'inherit',
      terminalBehavior: 'fail_closed',
    });

    const vlmConfig = getVlmConfig();
    expect(vlmConfig).not.toBeNull();
    expect(vlmConfig?.baseUrl).toBe('http://192.168.1.50:1234/v1');
    expect(vlmConfig?.model).toBe('gemma-4-26b-a4b-qat');
    expect(vlmConfig?.enabled).toBe(true);
    expect(vlmConfig?.transport).toBe('openai-compatible');
  });
});
