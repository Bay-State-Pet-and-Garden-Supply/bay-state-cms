import { describe, expect, it, vi } from 'bun:test';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';

function localOnlyView() {
  return buildModelPolicyView({
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-v4-flash',
    providerLocalities: { deepseek: 'cloud' },
    stageOverrides: {},
    textDataSharing: 'local_only',
    imageDataSharing: 'local_only',
  } as never);
}

describe('profile generation model policy', () => {
  it('denies cloud routing under local_only without any model transport', async () => {
    const transport = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport as never;
    try {
      const { suggestSelectorsForField } = await import('../../server/services/profile-builder/generateSelectorsService');
      await expect(suggestSelectorsForField({
        fieldKey: 'titleSelector', htmlRefs: ['a'], snapshotHtmls: ['<html><body><h1>Product</h1></body></html>'],
        sourceUrl: 'https://acme.com/p/1', runtime: 'rendered',
      }, { userId: 'u1', requestId: 'policy-denied', modelPolicy: localOnlyView() })).rejects.toMatchObject({ name: 'ModelPolicyDeniedError' });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('denies missing policy context without any model transport', async () => {
    const transport = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport as never;
    try {
      const { suggestSelectorsForField } = await import('../../server/services/profile-builder/generateSelectorsService');
      await expect(suggestSelectorsForField({
        fieldKey: 'titleSelector', htmlRefs: ['a'], snapshotHtmls: ['<html><body><h1>Product</h1></body></html>'],
        sourceUrl: 'https://acme.com/p/1', runtime: 'rendered',
      }, { userId: 'u1', requestId: 'policy-absent', modelPolicy: undefined })).rejects.toMatchObject({ name: 'ModelPolicyDeniedError' });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
