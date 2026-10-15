/**
 * Issue #350 slice 4 — canonical pair decision seam (TDD).
 *
 * The type decision resolves the canonical pair: the decided Product Type
 * determines its Category through the approved mapping. A decided type with
 * no approved mapping is a configuration gap (explicit abstention), never
 * a silent type-only success. Model routing, keyword order, and veto
 * semantics are unchanged — only the pair outcome is new.
 */
import { describe, it, expect } from 'bun:test';
import { resolveClassificationDecision } from '../../classification/product-type-decision';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';

function target(): ResolvedTarget {
  return {
    config: { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
    options: [
      { value: 'dog-food-dry', label: 'Dry Dog Food' },
      { value: 'cat-food-wet', label: 'Wet Cat Food' },
    ],
  } as ResolvedTarget;
}

function ctx() {
  return {
    workspacePath: '/tmp/pair-decision',
    workspaceId: 'ws-pair',
    runId: 'run-pair',
    configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() },
    snapshot: {
      snapshotHash: 'h',
      categories: [{ id: 'dog-food', name: 'Dog Food' }, { id: 'cat-food', name: 'Cat Food' }],
      productTypes: [
        { id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' },
        { id: 'cat-food-wet', name: 'Wet Cat Food', categoryId: 'cat-food' },
      ],
    } as any,
  } as any;
}

function evidence(text: string) {
  return [{
    id: 'ev-1', runId: 'run-pair', stageName: 'evidence_extraction', productSku: 'SKU-1',
    attributeId: null, source: 'official_product_page', reliability: 'high',
    sourceUrl: null, sourceField: 'description', snippet: text, value: text,
    metadata: {}, capturedAt: new Date().toISOString(),
  } as any];
}

describe('canonical pair decision (issue #350)', () => {
  it('a decided type resolves its approved category into the pair', async () => {
    const decision = await resolveClassificationDecision({
      target: target(), evidence: evidence('Dry Dog Food chicken kibble for dogs'), sku: 'SKU-1', runId: 'run-pair', snapshot: ctx().snapshot,
    } as any);
    expect(decision.status).toBe('resolved');
    if (decision.status === 'resolved') {
      expect(decision.productTypeId).toBe('dog-food-dry');
      expect(decision.categoryId).toBe('dog-food');
    }
  });

  it('a decided type with no approved mapping is an explicit configuration-gap abstention', async () => {
    const snapshot: any = {
      ...ctx().snapshot,
      productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: null }],
    };
    const decision = await resolveClassificationDecision({
      target: target(), evidence: evidence('Dry Dog Food chicken kibble for dogs'), sku: 'SKU-1', runId: 'run-pair', snapshot,
    } as any);
    expect(decision.status).toBe('abstained');
    if (decision.status === 'abstained') {
      expect(decision.abstentionCode).toBe('configuration_gap');
    }
  });

  it('insufficient evidence abstains on both components, never a forced label', async () => {
    const decision = await resolveClassificationDecision({
      target: target(), evidence: [], sku: 'SKU-1', runId: 'run-pair', snapshot: ctx().snapshot,
    } as any);
    expect(decision.status).toBe('abstained');
  });
});
