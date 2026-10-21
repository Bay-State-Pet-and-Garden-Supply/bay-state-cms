import { describe, it, expect } from 'vitest';
import { nameConsolidationStage } from '../../classification/stages/name-consolidation';
import type { StageContext, StageInput } from '../../classification/types';
import type { AcceptedItemEvidence } from '../../shared/schemas/item-evidence';

const input = (overrides: Partial<StageInput> = {}): StageInput => ({
  sku: 'test-sku',
  onboardingItemId: 'item-1',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
  ...overrides,
});

const context = (overrides: Partial<StageContext> = {}): StageContext => ({
  workspacePath: '/test/workspace',
  workspaceId: 'ws-1',
  runId: 'run-1',
  configSnapshotRef: { id: 'snap-1', hash: 'snapshot-hash', sourceCommit: null, createdAt: new Date().toISOString() },
  ...overrides,
});

describe('nameConsolidationStage accepted-evidence boundary', () => {
  it('fails closed instead of using raw classification or precomputed cohort titles', async () => {
    const result = await nameConsolidationStage.execute(
      input({ evidence: [{ id: 'raw', runId: 'run-1', stageName: 'evidence_extraction', productSku: 'test-sku', attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: null, value: 'Acme Feeder', metadata: null, capturedAt: new Date().toISOString() }] }),
      context({ preComputedTitle: 'Acme Sibling Feeder', preComputedTitleSource: 'llm_cohort' }),
    );
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected fail-closed abstention');
    expect(result.reason).toMatch(/accepted item evidence is required/i);
  });

  it('requires a frozen run snapshot even when accepted item context exists', async () => {
    const accepted = {
      workspaceId: 'ws-1', itemId: 'item-1', sku: 'test-sku', id: 'accepted-1', revision: 1,
      evidenceHash: 'e'.repeat(64), inputHash: 'i'.repeat(64), sourceStateHash: 's'.repeat(64), authorityHash: 'a'.repeat(64),
      facts: [], observations: [], registerName: 'Acme Feeder',
    } as unknown as AcceptedItemEvidence;
    const result = await nameConsolidationStage.execute(input(), context({ acceptedEvidence: accepted, snapshot: undefined }));
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected fail-closed abstention');
    expect(result.reason).toMatch(/frozen classification snapshot is required/i);
  });
});
