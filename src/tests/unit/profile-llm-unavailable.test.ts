// story: e06s03 — LLM unavailability fails clearly, deterministic path still works
import { describe, it, expect, vi } from 'vitest';

describe('profile-llm-unavailable', () => {
  it('Generate/Suggest/Revise deny clearly when no credential exists (policy gate, no mutation)', async () => {
    vi.resetModules();
    vi.doMock('../../db/repositories/llm-task-config-repo', () => ({ getLlmTaskConfig: vi.fn(() => null) }));
    vi.doMock('../../db/repositories/api-key-repo', () => ({ getApiKey: vi.fn(() => null) }));
    const { suggestSelectorsForField } = await import('../../server/services/profile-builder/generateSelectorsService');
    const { buildModelPolicyView, ModelPolicyDeniedError } = await import('../../classification/model-policy-gateway');
    const policy = buildModelPolicyView({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o-mini',
      providerLocalities: { openai: 'cloud' },
      stageOverrides: {},
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'cloud_allowed',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    });
    await expect(suggestSelectorsForField({ fieldKey: 'titleSelector', htmlRefs: ['a'], snapshotHtmls: ['<html></html>'], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered' }, { userId: 'u1', requestId: 'r1', modelPolicy: policy })).rejects.toBeInstanceOf(ModelPolicyDeniedError);
  });

  it('deterministic validation still works without LLM', async () => {
    const { validateAndRankSelectors } = await import('../../server/services/profile-builder/selectorValidator');
    const html = '<html><body><h1 class="product-title">Hello</h1></body></html>';
    const res = validateAndRankSelectors(html, { titleSelector: { notFound: false, candidates: [{ selector: 'h1.product-title', evidence: 'local' }] } }, [{ key: 'titleSelector', valueType: 'text', multiple: false }]);
    expect(res.titleSelector.status).toBe('suggested');
  });
});
