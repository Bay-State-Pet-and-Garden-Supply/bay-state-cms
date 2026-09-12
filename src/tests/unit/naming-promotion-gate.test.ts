/**
 * Issue #106 SEQUENCE 2a — Promotion naming gate behavior (TDD, DB-backed).
 *
 * The gate is the non-bypassable guarantee point: naming-invariant holds in
 * phase (a) (before image side effects) and re-checked in phase (c) (final
 * authority). Review cannot waive these predicates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  promoteItems,
  computePromotionGate,
  buildFilenameOwnershipSnapshot,
  buildNamingAssessmentBase,
} from '../../onboarding/draft-promoter';
import { markReviewed, markApproved } from '../../db/repositories/onboarding-review-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { type ExtractionData, ExtractionDataSchema } from '../../shared/schemas/onboarding';

describe('Promotion naming gate (issue #106)', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'naming-gate-test.db');
  const tempWorkspaceDir = path.resolve(import.meta.dirname, 'naming-gate-workspace');
  const wsId = 'ws-naming-gate';

  function seedApproved(itemId: string, batchId: string): void {
    markReviewed({ itemId, batchId, reviewedBy: 'naming-gate' });
    markApproved({ itemId, batchId, approvedBy: 'naming-gate' });
  }

  function seedItem(batchId: string, sku: string, opts: {
    title?: string;
    brandHint?: string | null;
    weight?: string | null;
    variantAttributes?: Record<string, string>;
    color?: string | null;
    seoFileName?: string | null;
  } = {}) {
    const title = opts.title ?? `Test Brand ${sku} Product 5 LB`;
    const [item] = insertItems(batchId, [{
      upc: sku, name: title, price: '$9.99',
      ...(opts.brandHint === null ? {} : { brandHint: opts.brandHint ?? 'Test Brand' }),
      rowNumber: 1,
    }]);
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title, brand: opts.brandHint ?? 'Test Brand',
      description: 'Gate test product.', bulletPoints: [],
      primaryImage: `products/${sku}/images/primary.jpg`, additionalImages: [],
      price: '$9.99', weight: opts.weight ?? null, dimensions: null,
      seoFileName: opts.seoFileName ?? null, searchKeywords: null,
      packagingTitle: null, packagingOcrData: null, customFields: {},
      ...(opts.variantAttributes ? { variantAttributes: opts.variantAttributes } : {}),
      ...(opts.color ? { color: opts.color } : {}),
      sourceUrl: `https://example.test/${sku}`, confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    getDb().query(
      `UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?`,
    ).run(JSON.stringify(extractionData), JSON.stringify({
      curatedTitle: title, titleSource: 'web', suggestedPages: ['Shoes'],
      suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'manual',
    }), item.id);
    return item;
  }

  function seedGateReady(batchId: string, sku: string) {
    const db = getDb();
    const page = listVerifiedPageOptions(wsId).find(p => p.name === 'Shoes');
    if (!page) throw new Error('verified page missing');
    const runId = `run-gate-${sku}`;
    const now = new Date().toISOString();
    const item = db.query('SELECT id FROM onboarding_items WHERE upc = ? ORDER BY created_at DESC LIMIT 1').get(sku) as { id: string };
    db.run(`INSERT OR IGNORE INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, wsId, item.id, sku, 'completed', now]);
    const curation = JSON.parse((db.query('SELECT curation_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { curation_data_json: string }).curation_data_json);
    curation.classificationRunId = runId;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(curation), item.id]);
    const proposalId = `prop-gate-${sku}`;
    db.run(`INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [proposalId, runId, sku, 'category_page', page.id, JSON.stringify({ pageId: page.id, pageName: 'Shoes' }), 1.0, 'accepted', now]);
    db.run(`INSERT OR IGNORE INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at) VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now]);
  }

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
      [wsId, 'Gate WS', tempWorkspaceDir, path.join(tempWorkspaceDir, '.git'), now, now, 'complete'],
    );
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: createHash('sha256').update('naming-gate-shoes').digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid', key: 'naming-gate-shoes', status: 'verified' },
        name: 'Shoes', parentRef: null, availability: 'available',
      }],
      activatedBy: 'test',
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('blocks missing_brand with evidence_absent (no hint anywhere)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g1', fileName: 'g1.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-001', { brandHint: null, title: 'Unbranded Product 5 LB' });
    seedGateReady(batch.id, 'GATE-001');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures[0].error).toContain('naming_invariant_blocked: missing_brand');
  });

  it('blocks duplicate_brand without rewriting history', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g2', fileName: 'g2.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-002', { title: 'Test Brand Test Brand Bucket 5 LB' });
    seedGateReady(batch.id, 'GATE-002');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures[0].error).toContain('duplicate_brand');
    // History untouched: the curated title is not rewritten by the hold.
    expect((findItemById(item.id)?.curationData as { curatedTitle?: string })?.curatedTitle)
      .toBe('Test Brand Test Brand Bucket 5 LB');
  });

  it('blocks absent measurement evidence with a coded reason', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g3', fileName: 'g3.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-003', { title: 'Test Brand Gate Product' });
    seedGateReady(batch.id, 'GATE-003');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures[0].error).toContain('missing_size');
  });

  it('accepts capacity-only evidence', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g4', fileName: 'g4.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-004', {
      title: 'Test Brand Pond Clarifier 5 gal',
      variantAttributes: { capacity: '5 gal' },
    });
    seedGateReady(batch.id, 'GATE-004');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.failures).toEqual([]);
    expect(res.count).toBe(1);
  });

  it('pack count cannot excuse a dropped capacity token', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g5', fileName: 'g5.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-005', {
      title: 'Test Brand Pond Clarifier 2 Pack',
      variantAttributes: { capacity: '5 gal', count: '2 Pack' },
    });
    seedGateReady(batch.id, 'GATE-005');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures[0].error).toContain('missing_size(capacity)');
  });

  it('multicolor family with unknown own color holds', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g6', fileName: 'g6.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-006', {
      title: 'Test Brand Collar 5 LB',
      variantAttributes: { color: 'Red' },
      color: 'Blue',
    });
    seedGateReady(batch.id, 'GATE-006');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.count).toBe(0);
    expect(res.failures[0].error).toContain('missing_color');
  });

  it('duplicate frozen-sibling titles hold without regrouping', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const batch = createBatch({ workspaceId: wsId, name: 'g7', fileName: 'g7.csv', totalItems: 2 });
    const a = seedItem(batch.id, 'GATE-007A', { title: 'Test Brand Twin Product 5 LB' });
    const b = seedItem(batch.id, 'GATE-007B', { title: 'Test Brand Twin Product 5 LB' });
    for (const sku of ['GATE-007A', 'GATE-007B']) seedGateReady(batch.id, sku);
    seedApproved(a.id, batch.id);
    seedApproved(b.id, batch.id);
    // Frozen cohort membership over both items; runs point at the cohort run.
    const cohortId = 'cohort-gate-7';
    db.run(`INSERT INTO curation_cohorts (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, 'k', 'l', 'product-family-v1', 'h', 'ready', ?, ?)`, [cohortId, wsId, batch.id, now, now]);
    for (const m of [a, b]) {
      db.run(`INSERT INTO curation_cohort_members (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem, membership_reason_json, extraction_hash, ordinal, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?)`,
        [cohortId, m.id, findItemById(m.id)!.upc, 'test brand', 'twin', now]);
      const cur = JSON.parse((db.query('SELECT curation_data_json FROM onboarding_items WHERE id = ?').get(m.id) as { curation_data_json: string }).curation_data_json);
      cur.semanticValidation = { status: 'passed', findings: [] };
      db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(cur), m.id]);
    }
    const runId = 'cohort-run-gate-7';
    db.run(`INSERT INTO classification_cohort_runs (id, workspace_id, cohort_id, candidate_membership_hash, evidence_snapshot_hash, status, created_at)
      VALUES (?, ?, ?, 'h', 'e', 'completed', ?)`, [runId, wsId, cohortId, now]);
    db.run(`UPDATE classification_runs SET cohort_run_id = ? WHERE id LIKE 'run-gate-GATE-007%'`, [runId]);
    // Reviewed Product Type for both members (earlier gate): accepted
    // primary_product_type decisions on their runs.
    for (const sku of ['GATE-007A', 'GATE-007B']) {
      const pid = `prop-type-${sku}`;
      db.run(`INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
        VALUES (?, ?, ?, 'primary_product_type', 'dry-dog-food', ?, 0.9, 'accepted', ?)`,
        [pid, `run-gate-${sku}`, sku, JSON.stringify({ productTypeId: 'dry-dog-food' }), now]);
      db.run(`INSERT OR IGNORE INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
        VALUES (?, ?, 'accepted', ?, ?)`, [`decision-${pid}`, pid, `key-${pid}`, now]);
    }
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [a.id, b.id]);
    expect(res.count).toBe(0);
    expect(res.failures).toHaveLength(2);
    expect(res.failures[0].error).toContain('duplicate_sibling');
  });

  it('foreign filename ownership holds; self-update passes', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g8', fileName: 'g8.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-008', { seoFileName: 'taken-name' });
    seedGateReady(batch.id, 'GATE-008');
    seedApproved(item.id, batch.id);
    // Another SKU's pending draft reserves the seo-derived base.
    const cs = createChangeSet({ workspaceId: wsId, title: 'other', description: null, baseCommit: 'c0' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'FOREIGN-SKU', operation: 'create',
      draftJson: JSON.stringify({ sku: 'FOREIGN-SKU', core: { name: 'Other' }, customFields: { FileName: 'taken-name.html' } }),
      baseJson: null, draftHash: 'h',
    });
    const blocked = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(blocked.count).toBe(0);
    expect(blocked.failures[0].error).toContain('duplicate_filename');
    // The same name owned by THIS sku is a self-update: clear. Reset the
    // failed promotion stage left by the blocked attempt first.
    getDb().query(`UPDATE change_set_items SET sku = ? WHERE change_set_id = ?`).run('GATE-008', cs.id);
    getDb().query(`UPDATE onboarding_items SET stage_status = 'pending', error_message = NULL WHERE id = ?`).run(item.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.failures).toEqual([]);
    expect(res.count).toBe(1);
  });

  it('second promotion before approval keeps assignments stable', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g9', fileName: 'g9.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-009', {});
    seedGateReady(batch.id, 'GATE-009');
    seedApproved(item.id, batch.id);
    const first = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(first.failures).toEqual([]);
    // Re-queue for a second promotion before approval (stage reset only).
    getDb().query(`UPDATE onboarding_items SET stage_status = 'pending', error_message = NULL WHERE id = ?`).run(item.id);
    const second = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(second.failures).toEqual([]);
    expect(second.count).toBe(1);
    const names = (changeSetId: string | null) => {
      if (!changeSetId) return [];
      return getDb().query('SELECT draft_json FROM change_set_items WHERE change_set_id = ?').all(changeSetId)
        .map((r) => (JSON.parse((r as { draft_json: string }).draft_json) as { customFields: { FileName: string } }).customFields['FileName']);
    };
    expect(names(second.changeSetId)).toEqual(names(first.changeSetId));
  });

  it('phase-c recheck refuses on a fresh foreign owner (computePromotionGate seam)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g10', fileName: 'g10.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-010', { seoFileName: 'recheck-base' });
    // Pipeline item (run pointer): the naming gate applies. Legacy items
    // bypass it byte-identical (see the FIX0 regression test below).
    seedGateReady(batch.id, 'GATE-010');
    const fresh = findItemById(item.id)!;
    const before = computePromotionGate(fresh, wsId, buildFilenameOwnershipSnapshot(wsId));
    expect(before.ok).toBe(true);
    const cs = createChangeSet({ workspaceId: wsId, title: 'late', description: null, baseCommit: 'c0' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'LATE-SKU', operation: 'create',
      draftJson: JSON.stringify({ sku: 'LATE-SKU', core: { name: 'Late' }, customFields: { FileName: 'recheck-base.html' } }),
      baseJson: null, draftHash: 'h',
    });
    const after = computePromotionGate(findItemById(item.id)!, wsId, buildFilenameOwnershipSnapshot(wsId));
    expect(after.ok).toBe(false);
    expect(after.reason).toContain('duplicate_filename');
  });

  it('persists a replayable naming audit with the draft', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g11', fileName: 'g11.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-011', {});
    seedGateReady(batch.id, 'GATE-011');
    seedApproved(item.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(res.failures).toEqual([]);
    const audit = (findItemById(item.id)?.curationData as { namingAudit?: {
      version: number; findings: unknown[]; allocation: { assigned: string; snapshotRef: string } | null;
      snapshotRef: string; finalTitle: string;
    } })?.namingAudit;
    expect(audit?.version).toBe(1);
    expect(audit?.findings).toEqual([]);
    expect(audit?.allocation?.assigned).toMatch(/\.html$/);
    expect(audit?.snapshotRef).toBe(audit?.allocation?.snapshotRef);
    expect(audit?.finalTitle).toBe('Test Brand GATE-011 Product 5 LB');
  });

  it('legacy items (no run pointer) bypass the naming gate byte-identical (FIX0 regression)', () => {
    // Naming-deficient title (no brand anywhere, no measurement) that would
    // hold any pipeline item — legacy promotes exactly as before, with or
    // without a snapshot.
    const batch = createBatch({ workspaceId: wsId, name: 'g12', fileName: 'g12.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-012', { title: 'Bare Widget', brandHint: null });
    const fresh = findItemById(item.id)!;
    expect(fresh.curationData?.classificationRunId).toBeUndefined();
    expect(computePromotionGate(fresh, wsId, buildFilenameOwnershipSnapshot(wsId)).ok).toBe(true);
    expect(computePromotionGate(fresh, wsId, null).ok).toBe(true);
  });

  it('single multi-word structured color is one family member, never multicolor (C1)', () => {
    // Distributor "Navy Blue" is a single structured value: the item is not
    // a multicolor family even though the title carries no color.
    const batch = createBatch({ workspaceId: wsId, name: 'g13', fileName: 'g13.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-013', {
      title: 'Test Brand Navy Widget 5 LB', color: 'Navy Blue',
    });
    seedGateReady(batch.id, 'GATE-013');
    const gate = computePromotionGate(findItemById(item.id)!, wsId, buildFilenameOwnershipSnapshot(wsId));
    expect(gate.ok).toBe(true);
  });

  it('genuine two-colorway structured family still holds without own color (C1)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g14', fileName: 'g14.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-014', {
      title: 'Test Brand Duo Widget 5 LB',
      variantAttributes: { color: 'Red' },
      color: 'Blue',
    });
    seedGateReady(batch.id, 'GATE-014');
    const gate = computePromotionGate(findItemById(item.id)!, wsId, buildFilenameOwnershipSnapshot(wsId));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('missing_color');
  });

  it('pipeline items fail closed without a filename ownership snapshot (C3)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g15', fileName: 'g15.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-015', {});
    seedGateReady(batch.id, 'GATE-015');
    const gate = computePromotionGate(findItemById(item.id)!, wsId, null);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('naming_snapshot_missing');
  });

  it('assessment token refs resolve to the live classification run (T1 story 20)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g16', fileName: 'g16.csv', totalItems: 1 });
    const item = seedItem(batch.id, 'GATE-016', {});
    seedGateReady(batch.id, 'GATE-016');
    const base = buildNamingAssessmentBase(findItemById(item.id)!, wsId);
    const runId = 'run-gate-GATE-016';
    const runRow = getDb().query('SELECT id FROM classification_runs WHERE id = ?').get(runId) as
      | { id: string }
      | undefined;
    expect(runRow?.id).toBe(runId);
    for (const token of base.measurementTokens) {
      for (const ref of token.refs ?? []) {
        if (ref === 'title-embedded') continue;
        expect(ref).toBe(`run:${runId}`);
      }
    }
    expect(base.measurementTokens.length).toBeGreaterThan(0);
  });

  it('allocation recomputed from the persisted snapshotRef assigns identically (T2a true replay)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g17', fileName: 'g17.csv', totalItems: 2 });
    const a = seedItem(batch.id, 'GATE-017A', { title: 'Test Brand Replay Widget 5 LB' });
    const b = seedItem(batch.id, 'GATE-017B', { title: 'Test Brand Replay Widget 5 LB' });
    for (const sku of ['GATE-017A', 'GATE-017B']) seedGateReady(batch.id, sku);
    seedApproved(a.id, batch.id);
    seedApproved(b.id, batch.id);
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [a.id, b.id]);
    expect(res.failures).toEqual([]);
    const { assignPromotionFileNamesWithAudit } =
      await import('../../onboarding/draft-promoter');
    const { listItemsByBatch } = await import('../../db/repositories/onboarding-item-repo');
    // True replay: rebuild the snapshot from live state and re-run the
    // allocation over the same items — identical assignment. The rebuilt
    // taken set is a superset (it now reserves the just-written pending
    // drafts as self-owned), so the ref differs by design; the ASSIGNMENT
    // is what must replay identically (self-owned kept path).
    const replaySnapshot = buildFilenameOwnershipSnapshot(wsId, tempWorkspaceDir);
    const audit = (findItemById(a.id)?.curationData as { namingAudit?: { snapshotRef: string } })?.namingAudit;
    expect(audit?.snapshotRef).toBeTruthy();
    expect(replaySnapshot.taken.length).toBeGreaterThan(0);
    const { assigned } = assignPromotionFileNamesWithAudit(
      listItemsByBatch(batch.id), tempWorkspaceDir, undefined, replaySnapshot,
    );
    const persisted = (id: string) => (findItemById(id)?.curationData as {
      namingAudit?: { allocation: { assigned: string } | null };
    })?.namingAudit?.allocation?.assigned;
    expect(assigned.get(a.id)).toBe(persisted(a.id));
    expect(assigned.get(b.id)).toBe(persisted(b.id));
  });

  it('persisted audit allocation matches the pre-promotion preview per item (T2b audit replay)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g19', fileName: 'g19.csv', totalItems: 2 });
    const a = seedItem(batch.id, 'GATE-019A', { title: 'Test Brand Audit Alpha Widget 5 LB' });
    const b = seedItem(batch.id, 'GATE-019B', { title: 'Test Brand Audit Beta Widget 5 LB' });
    for (const sku of ['GATE-019A', 'GATE-019B']) seedGateReady(batch.id, sku);
    seedApproved(a.id, batch.id);
    seedApproved(b.id, batch.id);
    const { previewBatchFilenamesWithSummary } = await import('../../onboarding/filename-review');
    const preview = previewBatchFilenamesWithSummary(tempWorkspaceDir, batch.id, wsId);
    const previewById = new Map(preview.items.map((i) => [i.itemId, i.fileName]));
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [a.id, b.id]);
    expect(res.failures).toEqual([]);
    // Rebuild from persisted audit: every promoted item's audit allocation
    // equals the pre-promotion preview name, and the ready set matches.
    const readyFromAudit: string[] = [];
    for (const id of [a.id, b.id]) {
      const audit = (findItemById(id)?.curationData as {
        namingAudit?: { allocation: { assigned: string } | null; snapshotRef: string };
      })?.namingAudit;
      expect(audit?.allocation?.assigned).toBe(previewById.get(id));
      expect(audit?.snapshotRef).toBe(preview.summary.snapshotRef);
      readyFromAudit.push(id);
    }
    expect(new Set(preview.summary.readyItemIds)).toEqual(new Set(readyFromAudit));
  });

  it('ten identical titles promote to ten distinct FileNames with contiguous suffixes (T5 Chris-shaped)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'g18', fileName: 'g18.csv', totalItems: 10 });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const sku = `GATE-018-${i}`;
      const item = seedItem(batch.id, sku, { title: 'Test Brand Bulk Widget 5 LB' });
      seedGateReady(batch.id, sku);
      seedApproved(item.id, batch.id);
      ids.push(item.id);
    }
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, ids);
    expect(res.failures).toEqual([]);
    expect(res.count).toBe(10);
    const names = getDb().query('SELECT draft_json FROM change_set_items WHERE change_set_id = ?').all(res.changeSetId!)
      .map((r) => (JSON.parse((r as { draft_json: string }).draft_json) as { customFields: { FileName: string } }).customFields['FileName']);
    expect(new Set(names).size).toBe(10);
    // Suffix contiguity: base + -2 .. -10 (set check; string sort orders
    // '-10' before '-2', so no positional assertion).
    const nameSet = new Set(names);
    expect(nameSet.has('test-brand-bulk-widget-5-lb.html')).toBe(true);
    for (let n = 2; n <= 10; n++) {
      expect(nameSet.has(`test-brand-bulk-widget-5-lb-${n}.html`)).toBe(true);
    }
  });
});
