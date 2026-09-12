import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { promoteItems } from '../../onboarding/draft-promoter';
import {
  markReviewed,
  markApproved,
  markReviewInvalidated,
} from '../../db/repositories/onboarding-review-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { type ExtractionData, ExtractionDataSchema } from '../../shared/schemas/onboarding';

/**
 * Epic #46 — reviewer round-2 regression: promotion requires durable review +
 * approval at the FINAL transactional authority in `promoteItems`.
 *
 * (a) promotion/pending WITHOUT durable approval → refused with an
 *     approval-related reason, count 0, NO change-set row.
 * (b) promotion/pending WITH durable review + approval → count 1, change-set
 *     row created.
 * (c) approval invalidated AND the item moved back to review/pending (the
 *     consequential-edit path) → refused, and the item's stage_status is NOT
 *     'failed' (it stays review/pending awaiting re-approval) — proving the
 *     "only mark failed in the promotion stage" guard.
 */

const testDbPath = path.resolve(import.meta.dirname, 'durable-approval-test.db');
const tempWorkspaceDir = path.resolve(import.meta.dirname, 'durable-approval-ws');
const wsId = 'ws-durable-approval';

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  initDb(testDbPath);
  runMigrations();
  try { mkdirSync(tempWorkspaceDir, { recursive: true }); } catch { /* ok */ }
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [wsId, 'Durable Approval WS', tempWorkspaceDir, path.join(tempWorkspaceDir, '.git'), now, now, 'complete'],
  );
});

afterAll(() => {
  closeDb();
  try { unlinkSync(testDbPath); } catch { /* ok */ }
  try { rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* ok */ }
});

/** Sets the item to promotion/pending with extraction + curation data and a
 *  raw page_index row (the real operating state a Test item is promoted in). */
function seedPromotionReadyItem(sku: string): { batch: { id: string }; item: { id: string } } {
  const batch = createBatch({ workspaceId: wsId, name: `DA ${sku}`, fileName: `${sku}.csv`, totalItems: 1 });
  const [item] = insertItems(batch.id, [{
    upc: sku,
    name: `Test Brand Product ${sku} 5 LB`,
    price: '$9.99',
    brandHint: 'Test Brand',
    rowNumber: 1,
  }]);
  const extractionData: ExtractionData = ExtractionDataSchema.parse({
    title: `Test Brand Product ${sku} 5 LB`,
    brand: 'Test Brand',
    description: 'Durable approval regression product.',
    bulletPoints: [],
    primaryImage: `products/${sku}/images/primary.jpg`,
    additionalImages: [],
    price: '$9.99',
    weight: null,
    dimensions: null,
    seoFileName: null,
    searchKeywords: null,
    packagingTitle: null,
    packagingOcrData: null,
    customFields: {},
    sourceUrl: `https://example.test/${sku}`,
    confidence: 0.9,
    fieldProvenance: { title: 'fixture' },
  });
  const curationData = {
    curatedTitle: `Test Brand Product ${sku} 5 LB`,
    titleSource: 'web',
    suggestedPages: ['Toys'],
    suggestedProductType: null,
    curatedAt: new Date().toISOString(),
    curationMethod: 'manual',
  };
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO page_index (id, name, file_name, page_hash, created_at, updated_at)
     VALUES ('promotion-toys-page', 'Toys', 'toys.html', 'promotion-toys-hash', ?, ?)`,
    [now, now],
  );
  db.run(
    `UPDATE onboarding_items
     SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion',
         stage_status = 'pending', status = 'ready'
     WHERE id = ?`,
    [JSON.stringify(extractionData), JSON.stringify(curationData), item.id],
  );
  return { batch, item };
}

/** Activate a verified import containing one page; returns its verified ID. */
function activateVerifiedPage(pageName: string, suffix: string): string {
  const key = `da-vp-${suffix}-${pageName.replace(/\s+/g, '-').toLowerCase()}`;
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: createHash('sha256').update(key).digest('hex'),
    parserFormatVersion: 'pages-xml-1',
    records: [{
      identity: { kind: 'exported_guid', key, status: 'verified' },
      name: pageName,
      parentRef: null,
      availability: 'available',
    }],
    activatedBy: 'test',
  });
  const verified = listVerifiedPageOptions(wsId).find(p => p.name === pageName);
  if (!verified) throw new Error(`verified page not created: ${pageName}`);
  return verified.id;
}

/** Accepted category-page proposal against a VERIFIED page (Pages gate). */
function acceptCategoryPage(sku: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = `da-run-${sku}`;
  const item = db.query(
    'SELECT id FROM onboarding_items WHERE upc = ? LIMIT 1',
  ).get(sku) as { id: string };
  db.run(
    `INSERT OR IGNORE INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
     VALUES (?, ?, ?, ?, 'completed', ?)`,
    [runId, wsId, item.id, sku, now],
  );
  // The promotion page gate reads accepted proposals via the item's ACTIVE
  // classification run — point curationData.classificationRunId at the
  // fixture run so the accepted category-page proposal is visible.
  const curationRow = db.query(
    'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
  ).get(item.id) as { curation_data_json: string | null } | undefined;
  if (curationRow?.curation_data_json) {
    const curationData = JSON.parse(curationRow.curation_data_json) as Record<string, unknown>;
    curationData.classificationRunId = runId;
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(curationData), item.id],
    );
  }
  const pageId = activateVerifiedPage('Toys', sku);
  const proposalId = `da-prop-${sku}`;
  db.run(
    `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
    [proposalId, runId, sku, pageId, JSON.stringify({ pageId, pageName: 'Toys' }), now],
  );
  db.run(
    `INSERT OR IGNORE INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
     VALUES (?, ?, 'accepted', ?, ?)`,
    [`da-dec-${proposalId}`, proposalId, `da-token-${proposalId}`, now],
  );
}

describe('Durable approval is the final promotion authority (epic #46 review round-2)', () => {
  it('(a) refuses promotion without durable approval and creates NO change-set row', async () => {
    const { batch, item } = seedPromotionReadyItem('DA-NO-APPROVAL');
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].error).toMatch(/approval/i);
    expect(res.changeSetId).toBeNull();
    expect(listChangeSetItems(res.changeSetId ?? 'none')).toHaveLength(0);
  });

  it('(b) promotes after durable review + approval, creating a change-set row', async () => {
    const { batch, item } = seedPromotionReadyItem('DA-APPROVED');
    markReviewed({ itemId: item.id, batchId: batch.id, reviewedBy: 'test' });
    markApproved({ itemId: item.id, batchId: batch.id, approvedBy: 'test' });
    acceptCategoryPage('DA-APPROVED');
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.failures).toEqual([]);
    expect(res.count).toBe(1);
    expect(res.changeSetId).not.toBeNull();
    expect(listChangeSetItems(res.changeSetId!).length).toBe(1);
  });

  it('(c) invalidated approval + return to review refuses AND does not mark the item failed', async () => {
    const { batch, item } = seedPromotionReadyItem('DA-INVALIDATED');
    markReviewed({ itemId: item.id, batchId: batch.id, reviewedBy: 'test' });
    markApproved({ itemId: item.id, batchId: batch.id, approvedBy: 'test' });
    acceptCategoryPage('DA-INVALIDATED');
    // Consequential edit: durable approval invalidated AND item returned to
    // review/pending (the real invalidation path).
    markReviewInvalidated(item.id, 'consequential_edit');
    getDb().run(
      "UPDATE onboarding_items SET stage = 'review', stage_status = 'pending' WHERE id = ?",
      [item.id],
    );

    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures).toHaveLength(1);
    // The item is NOT marked failed — it legitimately awaits re-approval in review.
    const row = findItemById(item.id)!;
    expect(row.stage).toBe('review');
    expect(row.stageStatus).toBe('pending');
  });
});
