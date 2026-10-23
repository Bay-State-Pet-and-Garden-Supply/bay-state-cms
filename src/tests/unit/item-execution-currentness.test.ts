import { describe, expect, it } from 'vitest';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/schemas/classification';
import {
  buildItemExecutionCurrentness,
  hashClassificationRunOutput,
  validateItemExecutionCurrentness,
} from '../../classification/item-execution-currentness';

const evidence: ClassificationEvidence[] = [{
  id: 'evidence-1', runId: 'run-1', stageName: 'evidence_extraction', productSku: 'SKU-1',
  attributeId: 'flavor', source: 'official_product_page', reliability: 'high',
  sourceUrl: 'https://example.test/item', sourceField: 'flavor', snippet: 'Chicken',
  value: 'Chicken', metadata: { locator: 'p' }, capturedAt: '2026-01-01T00:00:00.000Z',
}];

const proposal: ClassificationProposal = {
  id: 'proposal-1', runId: 'run-1', productSku: 'SKU-1', proposalType: 'field_assignment',
  targetId: 'flavor', proposedValue: 'Chicken', confidence: 0.9, evidenceIds: ['evidence-1'],
  status: 'pending', isBulkAcceptable: false, isStale: false, stalenessReason: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const output = {
  evidence,
  proposals: [proposal],
  stageResults: [{ stage_name: 'product_attribute_proposals', output_json: '{"flavor":"Chicken"}' }],
};

const receiptFields = {
  recordVersion: 1 as const,
  inputRevision: 'a'.repeat(64),
  evidenceId: 'accepted-1',
  evidenceRevision: 2,
  evidenceHash: 'b'.repeat(64),
  inputHash: 'c'.repeat(64),
  sourceStateHash: 'd'.repeat(64),
  authorityHash: 'e'.repeat(64),
  configSnapshotId: 'config-1',
  configSnapshotHash: 'f'.repeat(64),
  runtimeSnapshotId: null,
  runtimeSnapshotHash: '1'.repeat(64),
  policyDigest: '2'.repeat(64),
  classificationRunId: 'run-1',
  classificationOutputHash: hashClassificationRunOutput(output),
};

describe('item execution currentness', () => {
  it('hashes immutable proposal meaning and stage output, not reviewer-mutated decisions', () => {
    const initial = hashClassificationRunOutput(output);
    expect(hashClassificationRunOutput({
      ...output,
      proposals: [{ ...proposal, status: 'accepted', isStale: true, revisedValue: 'Turkey', currentDecisionId: 'decision-1' }],
    })).toBe(initial);
    expect(hashClassificationRunOutput({
      ...output,
      proposals: [{ ...proposal, proposedValue: 'Turkey' }],
    })).not.toBe(initial);
    expect(hashClassificationRunOutput({
      ...output,
      stageResults: [{ stage_name: 'product_attribute_proposals', output_json: '{"flavor":"Turkey"}' }],
    })).not.toBe(initial);
  });

  it('requires a valid currentness receipt bound to current output and rejects absent or stale receipts', () => {
    const currentness = buildItemExecutionCurrentness(receiptFields);
    expect(validateItemExecutionCurrentness({
      currentness,
      expected: receiptFields,
      classificationOutputHash: receiptFields.classificationOutputHash,
    })).toBe(true);
    expect(validateItemExecutionCurrentness({
      currentness: null,
      expected: receiptFields,
      classificationOutputHash: receiptFields.classificationOutputHash,
    })).toBe(false);
    expect(validateItemExecutionCurrentness({
      currentness,
      expected: { ...receiptFields, inputRevision: '3'.repeat(64) },
      classificationOutputHash: receiptFields.classificationOutputHash,
    })).toBe(false);
    expect(validateItemExecutionCurrentness({
      currentness,
      expected: receiptFields,
      classificationOutputHash: '4'.repeat(64),
    })).toBe(false);
  });
});
