/**
 * Store Manager bulk-review service tests (operations console, Issue 8).
 *
 * DB-backed (bun test): fail-closed eligibility, deterministic grouping,
 * immutable batch previews + digest binding, transaction apply with
 * whole-batch rollback on any stale item, per-item decisions + Change Set
 * staging + verification, deny with zero catalog effect. Disposable DB and
 * temp workspace only — no network/model/ShopSite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { unlinkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace, findWorkspace } from '../../db/repositories/workspace-repo';
import { insertProposal, findProposalById, listProposals, updateProposalStatus } from '../../db/repositories/catalog-health-proposal-repo';
import { createChangeSet, listChangeSetItems } from '../../db/repositories/change-set-repo';
import {
  deriveBulkReviewGroup,
  previewBulkReviewBatch,
  revalidateBulkReviewBatch,
  applyBulkReviewBatch,
  denyBulkReviewBatch,
  BulkReviewDisabledError,
  BulkReviewError,
} from '../../server/services/store-manager-bulk-review-service';
import {
  findBulkReviewBatch,
  listBulkReviewBatchItems,
  countBulkReviewDecisions,
} from '../../db/repositories/store-manager-bulk-review-repo';
import { overrideStoreManagerFlags, resetStoreManagerFlagsOverride } from '../../store-manager/flags';
import { writeProductFile, createWorkspaceDirs } from '../../git/workspace-files';
import type { Product } from '../../shared/types';

function makeProduct(sku: string, fieldValue: string): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sku,
    status: 'active',
    core: {
      name: `Product ${sku}`, price: null, salePrice: null, description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null, weight: null, taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: { ProductField24: fieldValue },
    shopsite: {
      productId: null, productGuid: null, xmlVersion: '15.0',
      lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

function insertCasingProposal(workspaceId: string, oldValue: string, skus: string[], newValue = 'Cat Supplies') {
  return insertProposal({
    workspaceId,
    field: 'ProductField24',
    oldValue,
    newValue,
    affectedSkus: skus,
    reason: 'casing normalization',
    confidence: 0.95,
    source: 'deterministic',
    status: 'proposed',
    normalizationKind: 'casing',
    ruleVersion: 'deterministic:casing:v1',
    evidenceKey: 'casing_normalization',
    manualReviewRequired: false,
  });
}

describe('Store Manager bulk-review service (Issue 8)', () => {
  const dbPath = path.join(os.tmpdir(), `baystate-cms-bulk-svc-${process.pid}.db`);
  const wsPath = path.join(os.tmpdir(), `baystate-cms-bulk-ws-${process.pid}`);
  const wsId = randomUUID();
  const wsIdB = randomUUID();

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    const now = new Date().toISOString();
    insertWorkspace({ id: wsId, name: 'Bulk Svc A', workspacePath: wsPath, gitPath: wsPath, createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null });
    insertWorkspace({ id: wsIdB, name: 'Bulk Svc B', workspacePath: wsPath, gitPath: wsPath, createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null });
    createWorkspaceDirs(wsPath);
    overrideStoreManagerFlags({ bulkReviewEnabled: true });
  });

  afterAll(() => {
    resetStoreManagerFlagsOverride();
    closeDb();
    try { unlinkSync(dbPath); } catch { /* ok */ }
    try { rmSync(wsPath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  beforeEach(() => {
    // Reset catalog proposals + change sets for a clean field each test.
    getDb().run('DELETE FROM catalog_health_proposals');
    getDb().run('DELETE FROM change_set_items');
    getDb().run('DELETE FROM change_sets');
    getDb().run('DELETE FROM store_manager_bulk_review_batches');
    getDb().run('DELETE FROM store_manager_bulk_review_items');
    getDb().run('DELETE FROM store_manager_bulk_review_decisions');
  });

  it('fails closed when the bulk-review flag is off (disabled error)', () => {
    overrideStoreManagerFlags({ bulkReviewEnabled: false });
    try {
      expect(() => deriveBulkReviewGroup(wsId, { field: 'ProductField24' })).toThrow(BulkReviewDisabledError);
      expect(() => applyBulkReviewBatch(wsId, wsPath, 'any', 'operator')).toThrow(BulkReviewDisabledError);
    } finally {
      overrideStoreManagerFlags({ bulkReviewEnabled: true });
    }
  });

  it('derives a homogeneous casing group and explicitly excludes typo/AI/legacy/manual rows', () => {
    writeProductFile(wsPath, makeProduct('SKU-1', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-2', 'Cat Supplies '));
    insertCasingProposal(wsId, 'cat supplies', ['SKU-1']);
    insertCasingProposal(wsId, 'CAT SUPPLIES', ['SKU-2']);
    // Typo (manual review required) — ineligible.
    insertProposal({
      workspaceId: wsId, field: 'ProductField24', oldValue: 'Cat Suplies', newValue: 'Cat Supplies',
      affectedSkus: ['SKU-3'], reason: 'typo correction', confidence: 0.85, source: 'deterministic',
      status: 'proposed', normalizationKind: 'typo', ruleVersion: 'deterministic:typo:v1',
      evidenceKey: 'typo_consensus', manualReviewRequired: true,
    });
    // AI proposal — never eligible even with metadata.
    insertProposal({
      workspaceId: wsId, field: 'ProductField24', oldValue: 'x', newValue: 'y',
      affectedSkus: ['SKU-4'], reason: 'ai suggestion', confidence: 0.99, source: 'ai', status: 'proposed',
      normalizationKind: 'casing', ruleVersion: 'deterministic:casing:v1', evidenceKey: 'casing_normalization', manualReviewRequired: false,
    });
    // Legacy row without metadata — defaults to manual review required.
    insertProposal({
      workspaceId: wsId, field: 'ProductField24', oldValue: 'legacy', newValue: 'legacy ok',
      affectedSkus: ['SKU-5'], reason: 'old row', confidence: 0.9, source: 'deterministic', status: 'proposed',
    });

    const group = deriveBulkReviewGroup(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    expect(group.normalizationKind).toBe('casing');
    expect(group.proposalCount).toBe(2);
    expect(group.distinctSkuCount).toBe(2);
    const reasons = group.exclusions.map((e) => e.reason).join(' | ');
    expect(reasons).toMatch(/typo|manual review/i);
    expect(reasons).toMatch(/AI/i);
    expect(reasons).toMatch(/legacy/i);
  });

  it('previews an immutable batch with deterministic digests and binds the exact set', () => {
    writeProductFile(wsPath, makeProduct('SKU-10', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-11', 'CAT SUPPLIES'));
    const p1 = insertCasingProposal(wsId, 'cat supplies', ['SKU-10']);
    const p2 = insertCasingProposal(wsId, 'CAT SUPPLIES', ['SKU-11']);

    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    expect(preview.diffHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.batch.proposalCount).toBe(2);
    expect(preview.batch.diffHash).toBe(preview.diffHash);
    expect(preview.items).toHaveLength(2);
    const ids = preview.items.map((i) => i.proposalId).sort();
    expect(ids).toEqual([p1.id, p2.id].sort());
    expect(preview.diffSummary.affectedSkuCount).toBe(2);
    expect(preview.diffSummary.networkActivity).toBe('none');

    // Deterministic: a second preview of unchanged state yields the same diff hash.
    const preview2 = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    expect(preview2.diffHash).toBe(preview.diffHash);

    // Revalidation is fresh.
    const reval = revalidateBulkReviewBatch(wsId, preview.batch.id);
    expect(reval.fresh).toBe(true);
    expect(reval.currentProposalCount).toBe(2);
  });

  it('marks a batch stale when any underlying proposal changes after the preview', () => {
    writeProductFile(wsPath, makeProduct('SKU-20', 'cat supplies'));
    const p1 = insertCasingProposal(wsId, 'cat supplies', ['SKU-20']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    // Change the mapping (simulated drift).
    updateProposalStatus(wsId, p1.id, 'dismissed');
    const reval = revalidateBulkReviewBatch(wsId, preview.batch.id);
    expect(reval.fresh).toBe(false);
    expect(reval.reason).toMatch(/dismissed|no longer bulk-eligible|no longer exists|changed/);
  });

  it('applies the exact batch: stages drafts, marks proposals applied, records per-item decisions, verifies SKUs', () => {
    writeProductFile(wsPath, makeProduct('SKU-30', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-31', 'CAT SUPPLIES'));
    writeProductFile(wsPath, makeProduct('SKU-32', 'Cat Supplies')); // already correct → skipped
    insertCasingProposal(wsId, 'cat supplies', ['SKU-30']);
    insertCasingProposal(wsId, 'CAT SUPPLIES', ['SKU-31']);
    insertCasingProposal(wsId, 'Cat Supplies ', ['SKU-32']);

    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    const emitted: string[] = [];
    const result = applyBulkReviewBatch(wsId, wsPath, preview.batch.id, 'operator', 'run-bulk-1', {
      emit: (e) => emitted.push(e.type),
    });

    expect(result.status).toBe('applied');
    expect(result.appliedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.changeSetId).toBeTruthy();
    expect(result.items).toHaveLength(3);
    expect(result.items.every((i) => i.decisionId && i.changeSetItemRef)).toBe(true);
    expect(result.verification).not.toBeNull();
    expect(result.verification!.verifiedSkuCount).toBe(3);
    expect(result.verification!.perSku.every((v) => v.status === 'verified')).toBe(true);

    // Batch + per-item state.
    const batch = findBulkReviewBatch(wsId, preview.batch.id)!;
    expect(batch.status).toBe('applied');
    expect(listBulkReviewBatchItems(wsId, preview.batch.id).every((i) => i.decision === 'applied')).toBe(true);
    expect(countBulkReviewDecisions(wsId, preview.batch.id)).toBe(3);

    // Proposals transitioned to applied and reference the Change Set.
    for (const p of listProposals(wsId, { field: 'ProductField24' })) {
      expect(p.status).toBe('applied');
      expect(p.changeSetId).toBe(result.changeSetId);
    }

    // Change Set contains draft items carrying the NEW value.
    const csItems = listChangeSetItems(result.changeSetId);
    expect(csItems.length).toBe(2); // SKU-32 was already correct → no draft row
    for (const item of csItems) {
      const draft = JSON.parse(item.draftJson) as Product;
      expect(draft.customFields.ProductField24).toBe('Cat Supplies');
    }

    // Per-item runtime events emitted (artifact_created per item + verification_diff).
    expect(emitted.filter((e) => e === 'artifact_created')).toHaveLength(3);
    expect(emitted).toContain('verification_diff');

    // Verification diff persisted as a run artifact.
    const artifact = getDb().query("SELECT content_hash FROM store_manager_run_artifacts WHERE run_id = 'run-bulk-1' AND kind = 'verification_diff'").get() as { content_hash: string } | undefined;
    expect(artifact).toBeTruthy();
  });

  it('refuses the WHOLE batch when one item is stale after the preview (rollback, zero side effects)', () => {
    writeProductFile(wsPath, makeProduct('SKU-40', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-41', 'CAT SUPPLIES'));
    const p1 = insertCasingProposal(wsId, 'cat supplies', ['SKU-40']);
    insertCasingProposal(wsId, 'CAT SUPPLIES', ['SKU-41']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });

    // Drift: dismiss ONE proposal after the preview.
    updateProposalStatus(wsId, p1.id, 'dismissed');

    expect(() => applyBulkReviewBatch(wsId, wsPath, preview.batch.id, 'operator')).toThrow(BulkReviewError);
    try {
      applyBulkReviewBatch(wsId, wsPath, preview.batch.id, 'operator');
    } catch (err) {
      expect((err as BulkReviewError).code).toBe('stale');
    }

    // Nothing changed: batch still pending, no decisions, no Change Set items,
    // surviving proposal untouched.
    expect(findBulkReviewBatch(wsId, preview.batch.id)!.status).toBe('pending');
    expect(countBulkReviewDecisions(wsId, preview.batch.id)).toBe(0);
    expect(getDb().query('SELECT COUNT(*) as c FROM change_set_items').get() as { c: number }).toEqual({ c: 0 });
    const survivor = listProposals(wsId, { field: 'ProductField24' }).find((p) => p.id !== p1.id)!;
    expect(survivor.status).toBe('proposed');
  });

  it('refuses applying an already-decided batch', () => {
    writeProductFile(wsPath, makeProduct('SKU-50', 'cat supplies'));
    insertCasingProposal(wsId, 'cat supplies', ['SKU-50']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    denyBulkReviewBatch(wsId, preview.batch.id, 'operator', 'run-deny-1', 'operator decision');
    expect(() => applyBulkReviewBatch(wsId, wsPath, preview.batch.id, 'operator')).toThrow(/already denied/);
    const batch = findBulkReviewBatch(wsId, preview.batch.id)!;
    expect(batch.status).toBe('denied');
    expect(countBulkReviewDecisions(wsId, preview.batch.id)).toBe(1);
    // Proposals untouched.
    expect(listProposals(wsId, { field: 'ProductField24' })[0].status).toBe('proposed');
  });

  it('deny records per-item decisions with zero catalog effect and proposals stay proposed', () => {
    writeProductFile(wsPath, makeProduct('SKU-60', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-61', 'CAT SUPPLIES'));
    insertCasingProposal(wsId, 'cat supplies', ['SKU-60']);
    insertCasingProposal(wsId, 'CAT SUPPLIES', ['SKU-61']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });

    const denied = denyBulkReviewBatch(wsId, preview.batch.id, 'operator', 'run-deny-2');
    expect(denied.status).toBe('denied');
    expect(denied.itemCount).toBe(2);
    expect(countBulkReviewDecisions(wsId, preview.batch.id)).toBe(2);
    expect(getDb().query('SELECT COUNT(*) as c FROM change_set_items').get() as { c: number }).toEqual({ c: 0 });
    for (const p of listProposals(wsId, { field: 'ProductField24' })) {
      expect(p.status).toBe('proposed');
    }
  });

  it('is workspace-isolated: a foreign workspace cannot see or apply the batch', () => {
    writeProductFile(wsPath, makeProduct('SKU-70', 'cat supplies'));
    insertCasingProposal(wsId, 'cat supplies', ['SKU-70']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    expect(findBulkReviewBatch(wsIdB, preview.batch.id)).toBeNull();
    expect(() => applyBulkReviewBatch(wsIdB, wsPath, preview.batch.id, 'operator')).toThrow(/not found/);
    expect(() => revalidateBulkReviewBatch(wsIdB, preview.batch.id)).toThrow(/not found/);
    expect(findBulkReviewBatch(wsId, preview.batch.id)!.status).toBe('pending');
  });

  it('uses the active Change Set when one exists (draft state from the preview)', () => {
    writeProductFile(wsPath, makeProduct('SKU-80', 'cat supplies'));
    insertCasingProposal(wsId, 'cat supplies', ['SKU-80']);
    const activeCs = createChangeSet({ workspaceId: wsId, title: 'Existing CS', baseCommit: 'head' });
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    expect(preview.diffSummary.changeSetCurrentState).toBe('draft');
    const result = applyBulkReviewBatch(wsId, wsPath, preview.batch.id, 'operator');
    expect(result.changeSetId).toBe(activeCs.id);
  });
});
