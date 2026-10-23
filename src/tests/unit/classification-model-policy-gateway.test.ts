/**
 * Unit tests for `src/classification/model-policy-gateway.ts` (issue #17
 * work item A). Pure tests: provider credentials are injected through the
 * gateway deps, so this suite runs under Vitest without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  ModelPolicyDeniedError,
  assertModelPolicyIntact,
  buildModelPolicyView,
  isLoopbackBaseUrl,
  redactIdentifier,
  redactImageUrl,
  redactTransportText,
  resolveFallbackRoute,
  resolveModelRoute,
  type ModelPolicyGatewayDeps,
  type ModelPolicyView,
} from '../../classification/model-policy-gateway';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';

const OLLAMA_LOCAL_POLICY: ModelPolicyConfigV2 = {
  defaultProvider: 'ollama',
  defaultModel: 'qwen2.5vl:latest',
  providerLocalities: { ollama: 'local' },
  stageOverrides: {},
  imageDataSharing: 'local_only',
  textDataSharing: 'local_only',
  mlFeatures: {
    productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
  },
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
};

function deps(keys: Record<string, { apiKey: string; baseUrl: string | null; model?: string | null }>): ModelPolicyGatewayDeps {
  return {
    getCredential: provider => {
      const cred = keys[provider];
      return cred
        ? { provider, apiKey: cred.apiKey, baseUrl: cred.baseUrl, model: cred.model ?? null }
        : null;
    },
    defaultBaseUrls: DEFAULT_BASE_URLS,
  };
}

const LOCAL_KEYS = deps({ ollama: { apiKey: 'ollama-default', baseUrl: 'http://localhost:11434/v1' } });

describe('isLoopbackBaseUrl', () => {
  it('accepts localhost, 127.0.0.1, ::1 and *.localhost over http/https', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackBaseUrl('https://localhost:443')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.0.0.1:8000')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.0.0.2:8000')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:11434/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://api.localhost/v1')).toBe(true);
  });

  it('rejects remote hosts, bare domains, non-http schemes and malformed URLs', () => {
    expect(isLoopbackBaseUrl('https://api.deepseek.com')).toBe(false);
    expect(isLoopbackBaseUrl('https://api.example.com')).toBe(false);
    expect(isLoopbackBaseUrl('api.deepseek.com')).toBe(false);
    expect(isLoopbackBaseUrl('file:///tmp/x')).toBe(false);
    expect(isLoopbackBaseUrl('ftp://localhost/x')).toBe(false);
    expect(isLoopbackBaseUrl('not a url')).toBe(false);
    expect(isLoopbackBaseUrl('http://256.1.1.1')).toBe(false);
  });
});

describe('buildModelPolicyView / assertModelPolicyIntact', () => {
  it('produces a stable digest and detects tampering', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 'abc' });
    expect(view.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertModelPolicyIntact(view)).not.toThrow();

    // Tampered view (mutated locality) must fail the transport-boundary check.
    const tampered = {
      ...view,
      providerLocalities: { ...view.providerLocalities, ollama: 'cloud' },
    } as unknown as ModelPolicyView;
    expect(() => assertModelPolicyIntact(tampered)).toThrow(ModelPolicyDeniedError);
    try {
      assertModelPolicyIntact(tampered);
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('policy_tampered');
    }
  });
});
describe('distributor copy route — separate explicit authority', () => {
  it('denies an unconfigured writer instead of inheriting the stage or default route', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 'copy-disabled' });
    try {
      resolveModelRoute(view, 'distributor_copy_consolidation', LOCAL_KEYS);
      expect.unreachable('copy generation must have an explicit authority');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('policy_disabled');
    }
    expect(resolveFallbackRoute(view, 'distributor_copy_consolidation', LOCAL_KEYS)).toBeNull();
  });

  it('uses only the explicit writer model and sharing authority', () => {
    const view = buildModelPolicyView({
      ...OLLAMA_LOCAL_POLICY,
      stageOverrides: {
        name_consolidation: {
          provider: 'ollama',
          model: 'judgment-model',
          fallbackProvider: null,
          fallbackModel: null,
        },
      },
      copyGeneration: {
        provider: 'ollama',
        model: 'qwen2.5:14b',
        textDataSharing: 'local_only',
      },
    } as ModelPolicyConfigV2, { snapshotHash: 'copy-explicit' });
    const route = resolveModelRoute(view, 'distributor_copy_consolidation', LOCAL_KEYS);
    expect(route.model).toBe('qwen2.5:14b');
    expect(route.provider).toBe('ollama');
    expect(route.locality).toBe('local');
    expect(view.copyGeneration?.textDataSharing).toBe('local_only');
    expect(route.fallbackProvider).toBeNull();
    expect(route.fromOverride).toBe(false);
  });
});

describe('resolveModelRoute — locality and endpoint enforcement', () => {
  it('resolves a declared-local provider with a loopback endpoint under local_only', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 's1' });
    const route = resolveModelRoute(view, 'evidence_extraction', LOCAL_KEYS);
    expect(route.provider).toBe('ollama');
    expect(route.model).toBe('qwen2.5vl:latest');
    expect(route.locality).toBe('local');
    expect(route.baseUrl).toBe('http://localhost:11434/v1');
    expect(route.fromOverride).toBe(false);
  });

  it('denies a cloud provider under text local_only with zero fallback', () => {
    const view = buildModelPolicyView(
      {
        ...OLLAMA_LOCAL_POLICY,
        defaultProvider: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
        providerLocalities: { deepseek: 'cloud' },
      },
      { snapshotHash: 's2' },
    );
    try {
      resolveModelRoute(view, 'evidence_extraction', deps({ deepseek: { apiKey: 'sk', baseUrl: 'https://api.deepseek.com' } }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ModelPolicyDeniedError);
      expect((err as ModelPolicyDeniedError).code).toBe('text_local_only_non_local_provider');
    }
  });

  it('denies an undeclared provider locality', () => {
    const view = buildModelPolicyView(
      { ...OLLAMA_LOCAL_POLICY, providerLocalities: {} },
      { snapshotHash: 's3' },
    );
    try {
      resolveModelRoute(view, 'evidence_extraction', LOCAL_KEYS);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('locality_undeclared');
    }
  });

  it('denies a declared-local provider whose resolved endpoint is remote', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 's4' });
    try {
      resolveModelRoute(
        view,
        'evidence_extraction',
        deps({ ollama: { apiKey: 'ollama-default', baseUrl: 'https://api.example.com/v1' } }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('endpoint_non_loopback');
    }
  });

  it('denies when the provider credential is missing', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 's5' });
    try {
      resolveModelRoute(view, 'evidence_extraction', deps({}));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('credential_missing');
    }
  });

  it('denies an unknown/empty route', () => {
    const view = buildModelPolicyView(
      { ...OLLAMA_LOCAL_POLICY, defaultProvider: '', defaultModel: '' },
      { snapshotHash: 's6' },
    );
    try {
      resolveModelRoute(view, 'evidence_extraction', LOCAL_KEYS);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('route_unknown');
    }
  });

  it('prefers the stage override provider/model when present', () => {
    const view = buildModelPolicyView(
      {
        ...OLLAMA_LOCAL_POLICY,
        stageOverrides: {
          evidence_extraction: {
            provider: 'ollama',
            model: 'llama3',
            fallbackProvider: null,
            fallbackModel: null,
          },
        },
      },
      { snapshotHash: 's7' },
    );
    const route = resolveModelRoute(view, 'evidence_extraction', LOCAL_KEYS);
    expect(route.model).toBe('llama3');
    expect(route.fromOverride).toBe(true);
  });

  it('denies a cloud provider for an image-bearing call under image local_only (pass 1c)', () => {
    const view = buildModelPolicyView(
      {
        defaultProvider: 'deepseek',
        defaultModel: 'deepseek-chat',
        providerLocalities: { deepseek: 'cloud' },
        stageOverrides: {},
        imageDataSharing: 'local_only',
        textDataSharing: 'cloud_allowed',
      } as any,
      { snapshotHash: 's8' },
    );
    // Without requiresImage the text policy is cloud_allowed so the route
    // resolves; with requiresImage the image policy denies before transport.
    const textOnly = resolveModelRoute(
      view,
      'evidence_extraction',
      deps({ deepseek: { apiKey: 'sk', baseUrl: 'https://api.deepseek.com' } }),
    );
    expect(textOnly.provider).toBe('deepseek');
    try {
      resolveModelRoute(
        view,
        'evidence_extraction',
        deps({ deepseek: { apiKey: 'sk', baseUrl: 'https://api.deepseek.com' } }),
        true,
      );
      expect.unreachable('should have thrown for image-bearing call');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('image_local_only_non_local_provider');
    }
  });

  it('allows a declared-local provider for an image-bearing call under image local_only (pass 1c)', () => {
    const view = buildModelPolicyView(
      {
        ...OLLAMA_LOCAL_POLICY,
        imageDataSharing: 'local_only',
        textDataSharing: 'cloud_allowed',
      },
      { snapshotHash: 's9' },
    );
    const route = resolveModelRoute(view, 'evidence_extraction', LOCAL_KEYS, true);
    expect(route.provider).toBe('ollama');
    expect(route.locality).toBe('local');
  });
});

describe('resolveFallbackRoute — explicit fallback only', () => {
  it('returns null when no fallback pair is declared (implicit fallback impossible)', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 's8' });
    expect(resolveFallbackRoute(view, 'evidence_extraction', LOCAL_KEYS)).toBeNull();
  });

  it('validates an explicit local fallback pair', () => {
    const view = buildModelPolicyView(
      {
        ...OLLAMA_LOCAL_POLICY,
        stageOverrides: {
          evidence_extraction: {
            provider: 'ollama',
            model: 'qwen2.5vl:latest',
            fallbackProvider: 'ollama',
            fallbackModel: 'llama3',
          },
        },
      },
      { snapshotHash: 's9' },
    );
    const fallback = resolveFallbackRoute(view, 'evidence_extraction', LOCAL_KEYS);
    expect(fallback).not.toBeNull();
    expect(fallback!.model).toBe('llama3');
    expect(fallback!.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('denies a fallback without an explicit model (implicit fallback forbidden)', () => {
    const view = buildModelPolicyView(
      {
        ...OLLAMA_LOCAL_POLICY,
        stageOverrides: {
          evidence_extraction: {
            provider: 'ollama',
            model: 'qwen2.5vl:latest',
            fallbackProvider: 'ollama',
            fallbackModel: null,
          },
        },
      },
      { snapshotHash: 's10' },
    );
    try {
      resolveFallbackRoute(view, 'evidence_extraction', LOCAL_KEYS);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ModelPolicyDeniedError).code).toBe('implicit_fallback_forbidden');
    }
  });

  it('deep-freezes the policy view so nested maps cannot be tampered with', () => {
    const view = buildModelPolicyView(OLLAMA_LOCAL_POLICY, { snapshotHash: 'deep-freeze-1' });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.providerLocalities)).toBe(true);
    expect(Object.isFrozen(view.stageOverrides)).toBe(true);
    // Mutation attempts fail (the digest would also be invalidated).
    expect(() => {
      (view.providerLocalities as Record<string, string>).ollama = 'cloud';
    }).toThrow();
    expect(view.providerLocalities.ollama).toBe('local');
    // assertModelPolicyIntact still passes on the intact frozen view.
    expect(() => assertModelPolicyIntact(view)).not.toThrow();
  });

  it('redactTransportText strips credentials and bounds length', () => {
    const text = 'Bearer sk-abcdef1234567890 with api_key=secret-value and a lot of extra content'.repeat(3);
    const redacted = redactTransportText(text);
    expect(redacted).not.toContain('sk-abcdef1234567890');
    expect(redacted).not.toContain('secret-value');
    expect(redacted.length).toBeLessThanOrEqual(201);
  });

  it('redactTransportText strips quoted JSON and Basic-auth credentials (pass 1c)', () => {
    const quotedJson = '{"error":{"api_key":"supersecret","token":"tok_abcdef123456","access_token":"abc","refresh_token":"xyz"}}';
    const redacted = redactTransportText(quotedJson);
    expect(redacted).not.toContain('supersecret');
    expect(redacted).not.toContain('tok_abcdef123456');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('xyz');
    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).toContain('token=[REDACTED]');

    // JSON.stringify escaped-quote form (\\" inside string values).
    const escapedJson = '{"error":{"message":"api_key:\\"supersecret\\" token:\\"tok_abcdef123456\\""}}';
    const escapedRedacted = redactTransportText(escapedJson);
    expect(escapedRedacted).not.toContain('supersecret');
    expect(escapedRedacted).not.toContain('tok_abcdef123456');

    const basicHeader = 'Authorization: Basic dXNlcjpwYXNz';
    const headerRedacted = redactTransportText(basicHeader);
    expect(headerRedacted).not.toContain('dXNlcjpwYXNz');
    expect(headerRedacted).toContain('[REDACTED]');

    const quotedBasic = '{"authorization":"Basic dXNlcjpwYXNz"}';
    expect(redactTransportText(quotedBasic)).not.toContain('dXNlcjpwYXNz');

    const standaloneBasic = 'Credentials: Basic dXNlcjpwYXNz then more';
    expect(redactTransportText(standaloneBasic)).not.toContain('dXNlcjpwYXNz');

    const unquoted = 'api_key=plainsecret token=plaintoken';
    const unquotedRedacted = redactTransportText(unquoted);
    expect(unquotedRedacted).not.toContain('plainsecret');
    expect(unquotedRedacted).not.toContain('plaintoken');
  });

  it('redactTransportText strips doubly-stringified (nested-escape) credentials (pass 1d)', () => {
    // Provider bodies may be nested JSON.stringify'd; the credential only
    // appears after peeling multiple escaped-quote layers.
    const doubleNested = JSON.stringify({
      error: { message: JSON.stringify(JSON.stringify({ api_key: 'supersecret' })) },
    });
    const doubleRedacted = redactTransportText(doubleNested);
    expect(doubleRedacted).not.toContain('supersecret');
    expect(doubleRedacted).toContain('api_key=[REDACTED]');
  });

  it('redactTransportText strips triply-stringified credentials and nested tokens/Basic (pass 1d)', () => {
    const tripleNested = JSON.stringify({
      error: { message: JSON.stringify(JSON.stringify(JSON.stringify({ token: 'tok_nested123456' }))) },
    });
    const tripleRedacted = redactTransportText(tripleNested);
    expect(tripleRedacted).not.toContain('tok_nested123456');
    expect(tripleRedacted).toContain('token=[REDACTED]');

    const nestedBasic = JSON.stringify({
      error: { message: JSON.stringify(JSON.stringify({ authorization: 'Basic dXNlcjpwYXNz' })) },
    });
    const basicRedacted = redactTransportText(nestedBasic);
    expect(basicRedacted).not.toContain('dXNlcjpwYXNz');
    expect(basicRedacted).toContain('[REDACTED]');
  });

  it('redactTransportText leaves benign quoted content usable (safe direction only)', () => {
    // Over-redaction is acceptable, but normal non-secret values must survive.
    const benign = 'Normal error: the value is "quoted" and fine';
    const redacted = redactTransportText(benign);
    expect(redacted).toContain('Normal error');
    expect(redacted).toContain('quoted');
  });

  it('redactImageUrl strips query strings and hashes', () => {
    const url = 'https://cdn.example.com/img/1.jpg?Signature=abc&Expires=123#frag';
    const redacted = redactImageUrl(url);
    expect(redacted).not.toContain('Signature=abc');
    expect(redacted).not.toContain('#frag');
    expect(redacted).toBe('https://cdn.example.com/img/1.jpg');
  });

  it('redactImageUrl strips userinfo credentials (P2 metadata-redaction pass)', () => {
    const url = 'https://key-123:secret@example.com/signed/img.jpg?token=xyz';
    const redacted = redactImageUrl(url);
    expect(redacted).toBe('https://example.com/signed/img.jpg');
    expect(redacted).not.toContain('key-123');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('token=xyz');
  });

  it('redactIdentifier returns a bounded non-sensitive form', () => {
    expect(redactIdentifier('850067859598')).toContain('…');
    expect(redactIdentifier('850067859598')).not.toContain('5067859');
    expect(redactIdentifier('short')).toBe('[id]');
    expect(redactIdentifier('')).toBe('');
  });
});
