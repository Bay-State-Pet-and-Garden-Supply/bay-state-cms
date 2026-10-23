import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageContext, StageInput } from '../../classification/types';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => { throw new Error('mutable config must not be loaded'); }),
  resolveEnabledTargets: vi.fn(),
  processProductTypeTarget: vi.fn(),
  processPageTarget: vi.fn(),
  materializeCoordinatedPages: vi.fn(),
}));

vi.mock('@/classification/config-loader', () => ({ loadClassificationConfig: mocks.loadConfig }));
vi.mock('@/classification/curation-target-resolver', () => ({
  resolveEnabledTargets: mocks.resolveEnabledTargets,
  resolveTargetsFromSnapshot: vi.fn(),
}));
vi.mock('@/classification/curation-target-processor', () => ({
  processProductTypeTarget: mocks.processProductTypeTarget,
  processPageTarget: mocks.processPageTarget,
  materializeCoordinatedPages: mocks.materializeCoordinatedPages,
}));

import { categoryPageProposalsStage } from '../../classification/stages/category-page-proposals';
import { primaryProductTypeStage } from '../../classification/stages/primary-product-type';

const input = {
  sku: 'SKU-1',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
} as StageInput;

const context = {
  workspacePath: '/tmp/workspace',
  workspaceId: 'workspace',
  runId: 'run-1',
} as StageContext;

const stages = [
  { name: 'Product Classification', stage: primaryProductTypeStage },
  { name: 'Taxonomy Category Page', stage: categoryPageProposalsStage },
] as const;

describe('frozen target stages require captured configuration', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(stages)('$name abstains without a frozen classification snapshot', async ({ stage }) => {
    const result = await stage.execute(input, context);

    expect(result).toMatchObject({
      status: 'abstained',
      reason: expect.stringContaining('frozen classification snapshot'),
    });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.resolveEnabledTargets).not.toHaveBeenCalled();
    expect(mocks.processProductTypeTarget).not.toHaveBeenCalled();
    expect(mocks.processPageTarget).not.toHaveBeenCalled();
    expect(mocks.materializeCoordinatedPages).not.toHaveBeenCalled();
  });
});
