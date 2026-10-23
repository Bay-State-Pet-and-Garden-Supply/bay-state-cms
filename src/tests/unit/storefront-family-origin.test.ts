import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as familyOriginRepo from '../../db/repositories/storefront-family-origin-repo';
import * as itemRepo from '../../db/repositories/onboarding-item-repo';
import * as classificationRunRepo from '../../db/repositories/classification-run-repo';
import * as itemEvidence from '../../onboarding/item-evidence';
import * as reviewCompletionGate from '../../classification/review-completion-gate';

const WORKSPACE = 'storefront-origin-test-workspace';
const ITEM = 'storefront-origin-test-item';
const SKU = 'storefront-origin-test-sku';
const RUN = 'storefront-origin-test-run';

const realFamilyOriginRepo = { ...familyOriginRepo };
const realItemRepo = { ...itemRepo };
const realClassificationRunRepo = { ...classificationRunRepo };
const realItemEvidence = { ...itemEvidence };
const realReviewCompletionGate = { ...reviewCompletionGate };

const findFamilyOnboardingOrigin = mock((..._args: Parameters<typeof familyOriginRepo.findFamilyOnboardingOrigin>) => null);
const findItemById = mock((..._args: Parameters<typeof itemRepo.findItemById>) => null);
const getRun = mock((..._args: Parameters<typeof classificationRunRepo.getRun>) => null);
const getCurrentItemEvidenceView = mock((..._args: Parameters<typeof itemEvidence.getCurrentItemEvidenceView>) => null);
const validateReviewCompletionGate = mock((..._args: Parameters<typeof reviewCompletionGate.validateReviewCompletionGate>) => null);

mock.module('../../db/repositories/storefront-family-origin-repo', () => ({
  ...realFamilyOriginRepo,
  findFamilyOnboardingOrigin: (...args: Parameters<typeof familyOriginRepo.findFamilyOnboardingOrigin>) =>
    args[0] === WORKSPACE && args[1] === ITEM
      ? findFamilyOnboardingOrigin(...args)
      : realFamilyOriginRepo.findFamilyOnboardingOrigin(...args),
}));
mock.module('../../db/repositories/onboarding-item-repo', () => ({
  ...realItemRepo,
  findItemById: (...args: Parameters<typeof itemRepo.findItemById>) =>
    args[0] === ITEM ? findItemById(...args) : realItemRepo.findItemById(...args),
}));
mock.module('../../db/repositories/classification-run-repo', () => ({
  ...realClassificationRunRepo,
  getRun: (...args: Parameters<typeof classificationRunRepo.getRun>) =>
    args[0] === RUN ? getRun(...args) : realClassificationRunRepo.getRun(...args),
}));
mock.module('../../onboarding/item-evidence', () => ({
  ...realItemEvidence,
  getCurrentItemEvidenceView: (...args: Parameters<typeof itemEvidence.getCurrentItemEvidenceView>) =>
    args[0] === WORKSPACE && args[1] === ITEM
      ? getCurrentItemEvidenceView(...args)
      : realItemEvidence.getCurrentItemEvidenceView(...args),
}));
mock.module('../../classification/review-completion-gate', () => ({
  ...realReviewCompletionGate,
  validateReviewCompletionGate: (...args: Parameters<typeof reviewCompletionGate.validateReviewCompletionGate>) =>
    args[0].workspaceId === WORKSPACE && args[0].onboardingItemId === ITEM && args[0].activeRunId === RUN
      ? validateReviewCompletionGate(...args)
      : realReviewCompletionGate.validateReviewCompletionGate(...args),
}));

// Register Bun module mocks before loading the dependent module.
const { validateFamilyMemberOrigin } = await import('../../classification/storefront-family-origin');

const origin = {
  kind: 'onboarding' as const,
  itemId: ITEM,
  runId: RUN,
  runCurrentnessHash: 'a'.repeat(64),
  evidenceId: 'storefront-origin-test-evidence',
  evidenceHash: 'b'.repeat(64),
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    itemId: ITEM, batchId: 'storefront-origin-test-batch', workspaceId: WORKSPACE, sku: SKU, inputRevision: 'revision-a',
    runId: origin.runId, runCurrentnessHash: origin.runCurrentnessHash, evidenceId: origin.evidenceId,
    evidenceHash: origin.evidenceHash, curationJson: JSON.stringify({ purchasable: true }), ...overrides,
  };
}

afterAll(() => mock.restore());

describe('family member source authority', () => {
  beforeEach(() => {
    findFamilyOnboardingOrigin.mockReset();
    findFamilyOnboardingOrigin.mockReturnValue(record() as never);
    findItemById.mockReset();
    findItemById.mockReturnValue({ id: ITEM } as never);
    getRun.mockReset();
    getRun.mockReturnValue({ id: RUN, workspaceId: WORKSPACE, productSku: SKU, status: 'completed' } as never);
    getCurrentItemEvidenceView.mockReset();
    getCurrentItemEvidenceView.mockReturnValue({ evidence: { id: origin.evidenceId, evidenceHash: origin.evidenceHash } } as never);
    validateReviewCompletionGate.mockReset();
    validateReviewCompletionGate.mockReturnValue({ ok: true, proposalCount: 1 } as never);
  });

  it('accepts the exact current item/run/evidence binding and returns its explicit purchasability decision', () => {
    expect(validateFamilyMemberOrigin({ workspaceId: WORKSPACE, workspacePath: '/workspace', sku: SKU, origin }))
      .toEqual({ ok: true, classificationRunId: RUN, purchasable: true });
    expect(validateReviewCompletionGate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE, onboardingItemId: ITEM, productSku: SKU, activeRunId: RUN,
    });
  });

  it('refuses a cross-item SKU binding rather than resolving another item by SKU', () => {
    findFamilyOnboardingOrigin.mockReturnValue(record({ sku: 'sku-other' }) as never);
    expect(validateFamilyMemberOrigin({ workspaceId: WORKSPACE, workspacePath: '/workspace', sku: SKU, origin }))
      .toMatchObject({ ok: false, code: 'onboarding_origin_mismatch' });
    expect(validateReviewCompletionGate).not.toHaveBeenCalled();
  });

  it('refuses stale accepted evidence even when the item and run still exist', () => {
    getCurrentItemEvidenceView.mockReturnValue({ evidence: { id: 'new-evidence', evidenceHash: 'c'.repeat(64) } } as never);
    expect(validateFamilyMemberOrigin({ workspaceId: WORKSPACE, workspacePath: '/workspace', sku: SKU, origin }))
      .toMatchObject({ ok: false, code: 'onboarding_origin_stale' });
    expect(validateReviewCompletionGate).not.toHaveBeenCalled();
  });

  it('keeps absent purchasability actionable instead of treating unknown as true or false', () => {
    findFamilyOnboardingOrigin.mockReturnValue(record({ curationJson: JSON.stringify({}) }) as never);
    expect(validateFamilyMemberOrigin({ workspaceId: WORKSPACE, workspacePath: '/workspace', sku: SKU, origin }))
      .toMatchObject({ ok: false, code: 'purchasability_unknown' });
  });
});
