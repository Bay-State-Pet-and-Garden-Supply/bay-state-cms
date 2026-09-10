/**
 * Store Manager bulk-review tool adapter tests (operations console, Issue 8).
 *
 * DB-backed (bun test): the bulk stage adapter registers in the standard
 * registry + policy surface, executes ONLY through the registry dispatch
 * (normal approval/diff path, no direct route mutation), binds the exact
 * batch (any stale item → whole batch policy_denied), stages a Change Set
 * only, and returns per-SKU verification. Disposable DB + temp workspace.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { unlinkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { insertProposal, listProposals, updateProposalStatus } from '../../db/repositories/catalog-health-proposal-repo';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { previewBulkReviewBatch } from '../../server/services/store-manager-bulk-review-service';
import { findBulkReviewBatch } from '../../db/repositories/store-manager-bulk-review-repo';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { createStoreManagerTools, getStoreManagerToolNames } from '../../server/services/store-manager-tools';
import { STORE_MANAGER_TOOL_POLICIES } from '../../server/services/store-manager-tool-policy';
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

function insertCasing(workspaceId: string, oldValue: string, skus: string[]) {
  return insertProposal({
    workspaceId,
    field: 'ProductField24',
    oldValue,
    newValue: 'Cat Supplies',
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

function makeApprovedMessages(toolCallId: string, input: Record<string, unknown>) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId, toolName: 'bulk_apply_stored_proposals', input },
        { type: 'tool-approval-request', approvalId: `ap-${toolCallId}`, toolCallId },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: `ap-${toolCallId}`, approved: true }],
    },
  ];
}

describe('Store Manager bulk-review tool (Issue 8)', () => {
  const dbPath = path.join(os.tmpdir(), `baystate-cms-bulk-tool-${process.pid}.db`);
  const wsPath = path.join(os.tmpdir(), `baystate-cms-bulk-tool-ws-${process.pid}`);
  const wsId = randomUUID();

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    const now = new Date().toISOString();
    insertWorkspace({ id: wsId, name: 'Bulk Tool', workspacePath: wsPath, gitPath: wsPath, createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null });
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
    getDb().run('DELETE FROM catalog_health_proposals');
    getDb().run('DELETE FROM change_set_items');
    getDb().run('DELETE FROM change_sets');
    getDb().run('DELETE FROM store_manager_bulk_review_batches');
    getDb().run('DELETE FROM store_manager_bulk_review_items');
    getDb().run('DELETE FROM store_manager_bulk_review_decisions');
  });

  it('registers the bulk adapter in the registry + policy surface with the exact-set diff', () => {
    const registry = createStoreManagerToolRegistry();
    expect(registry.get('bulk_apply_stored_proposals')).toBeDefined();
    expect(STORE_MANAGER_TOOL_POLICIES['bulk_apply_stored_proposals']).toBeDefined();
    expect(STORE_MANAGER_TOOL_POLICIES['bulk_apply_stored_proposals'].riskClass).toBe('catalog_mutation');
    expect(STORE_MANAGER_TOOL_POLICIES['bulk_apply_stored_proposals'].requiresApproval).toBe(true);
    expect(getStoreManagerToolNames()).toContain('bulk_apply_stored_proposals');

    // Registry/policy surface parity is asserted by the existing exact-set test;
    // here we prove the persistent adapter REQUIRES a previewDiff (registry rule).
    const adapter = registry.get('bulk_apply_stored_proposals')!;
    expect(adapter.riskClass).toBe('catalog_mutation');
    expect(typeof adapter.previewDiff).toBe('function');
  });

  it('executes only through the registry/approval path: stages the exact batch with verification', async () => {
    writeProductFile(wsPath, makeProduct('SKU-T1', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-T2', 'CAT SUPPLIES'));
    insertCasing(wsId, 'cat supplies', ['SKU-T1']);
    insertCasing(wsId, 'CAT SUPPLIES', ['SKU-T2']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });

    const tools = createStoreManagerTools({
      workspaceId: wsId,
      workspacePath: wsPath,
      executionId: 'exec-bulk-1',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const toolCallId = 'bulk-call-1';
    const bulkTool = (tools as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>).bulk_apply_stored_proposals;
    const result = (await bulkTool.execute(
      { batchId: preview.batch.id },
      { toolCallId, messages: makeApprovedMessages(toolCallId, { batchId: preview.batch.id }) } as never,
    )) as unknown as { ok: boolean; status: string; appliedCount: number; skippedCount: number; changeSetId: string; items: Array<{ proposalId: string; status: string; decisionId: string | null }>; verification: { verifiedSkuCount: number; perSku: Array<{ sku: string; status: string }> } };

    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.items).toHaveLength(2);
    expect(result.verification.verifiedSkuCount).toBe(2);
    expect(result.verification.perSku.every((v) => v.status === 'verified')).toBe(true);

    // Change Set staged with draft items; proposals applied; batch applied.
    const applied = listProposals(wsId, { field: 'ProductField24' });
    expect(applied.every((p) => p.status === 'applied')).toBe(true);
    expect(findBulkReviewBatch(wsId, preview.batch.id)!.status).toBe('applied');
    expect(result.changeSetId).toBeTruthy();
    expect(listChangeSetItems(result.changeSetId).length).toBe(2);
  });

  it('denies execution without an approval (fail closed, zero side effects)', async () => {
    writeProductFile(wsPath, makeProduct('SKU-T3', 'cat supplies'));
    insertCasing(wsId, 'cat supplies', ['SKU-T3']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });

    const tools = createStoreManagerTools({
      workspaceId: wsId,
      workspacePath: wsPath,
      executionId: 'exec-bulk-2',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const bulkTool = (tools as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>).bulk_apply_stored_proposals;
    await expect(
      bulkTool.execute({ batchId: preview.batch.id }, { toolCallId: 'bulk-call-2', messages: [] } as never),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    expect(findBulkReviewBatch(wsId, preview.batch.id)!.status).toBe('pending');
    expect(listProposals(wsId, { field: 'ProductField24' })[0].status).toBe('proposed');
  });

  it('binds the exact batch: a stale item refuses the WHOLE batch (policy_denied, zero side effects)', async () => {
    writeProductFile(wsPath, makeProduct('SKU-T4', 'cat supplies'));
    writeProductFile(wsPath, makeProduct('SKU-T5', 'CAT SUPPLIES'));
    const p1 = insertCasing(wsId, 'cat supplies', ['SKU-T4']);
    insertCasing(wsId, 'CAT SUPPLIES', ['SKU-T5']);
    const preview = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });

    // Drift after preview: one proposal is dismissed.
    updateProposalStatus(wsId, p1.id, 'dismissed');

    const tools = createStoreManagerTools({
      workspaceId: wsId,
      workspacePath: wsPath,
      executionId: 'exec-bulk-3',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const toolCallId = 'bulk-call-3';
    const bulkTool = (tools as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>).bulk_apply_stored_proposals;
    const result = (await bulkTool.execute(
      { batchId: preview.batch.id },
      { toolCallId, messages: makeApprovedMessages(toolCallId, { batchId: preview.batch.id }) } as never,
    )) as unknown as { success: false; denial: string; error: string };
    expect(result.success).toBe(false);
    expect(result.denial).toBe('stale_preview');

    // Whole batch untouched: no decisions, no Change Set items, batch pending.
    expect(findBulkReviewBatch(wsId, preview.batch.id)!.status).toBe('pending');
    expect(getDb().query('SELECT COUNT(*) as c FROM change_set_items').get() as { c: number }).toEqual({ c: 0 });
    expect(getDb().query('SELECT COUNT(*) as c FROM store_manager_bulk_review_decisions').get() as { c: number }).toEqual({ c: 0 });
  });

  it('rejects altered arguments after approval (replay/alteration gate)', async () => {
    writeProductFile(wsPath, makeProduct('SKU-T6', 'cat supplies'));
    insertCasing(wsId, 'cat supplies', ['SKU-T6']);
    const previewA = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });
    const previewB = previewBulkReviewBatch(wsId, { field: 'ProductField24', normalizationKind: 'casing' });

    const tools = createStoreManagerTools({
      workspaceId: wsId,
      workspacePath: wsPath,
      executionId: 'exec-bulk-4',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const toolCallId = 'bulk-call-4';
    // Approved for batch A, but executed with batch B: refused before side effects.
    const bulkTool = (tools as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>).bulk_apply_stored_proposals;
    await expect(
      bulkTool.execute(
        { batchId: previewB.batch.id },
        { toolCallId, messages: makeApprovedMessages(toolCallId, { batchId: previewA.batch.id }) } as never,
      ),
    ).rejects.toMatchObject({ code: 'approval_replay_or_altered' });
    expect(findBulkReviewBatch(wsId, previewB.batch.id)!.status).toBe('pending');
  });

  it('returns not_found for a foreign/unknown batch (no ownership disclosure)', async () => {
    const tools = createStoreManagerTools({
      workspaceId: wsId,
      workspacePath: wsPath,
      executionId: 'exec-bulk-5',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const toolCallId = 'bulk-call-5';
    const bulkTool = (tools as unknown as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>).bulk_apply_stored_proposals;
    const result = (await bulkTool.execute(
      { batchId: 'does-not-exist' },
      { toolCallId, messages: makeApprovedMessages(toolCallId, { batchId: 'does-not-exist' }) } as never,
    )) as unknown as { success: false; denial: string };
    expect(result.success).toBe(false);
    expect(result.denial).toBe('not_found');
  });

  it('the bulk adapter file contains no raw SQL, fetch, or filesystem calls', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const source = readFileSync(path.resolve(__dirname, '../../../src/store-manager/tools/bulk-review-tools.ts'), 'utf-8');
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/getDb\(/);
    expect(source).not.toMatch(/writeFileSync|writeFile|mkdirSync/);
    expect(source).not.toMatch(/from '\.\.\/\.\.\/db\/connection'/);
  });
});
