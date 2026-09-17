// Fix 3 — explicit unresolved variant-identity disposition for the
// no-matrix Sitecore case (Nylabone precedent).
//
// A size-specific item parked as profile-blocked carries NEITHER a variant
// resolution row NOR a `variant:`-prefixed gate error, and the worker gate
// returns no failure when no matrix exists — so the pre-fix predicate
// passes it as eligible. The explicit persisted disposition closes that
// gap: the arrange state below is a REAL profile-blocked size-specific row
// (never a fabricated `variant:` error), and only the recorded disposition
// holds it.
//
// Convention: bun:sqlite DB-backed, run under `bun test` (same as
// variant-identity-release-hold-218.test.ts). Lifecycle + seeds via
// helpers/release-db-suite; only disposition seeding is local.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getDb } from '../../db/connection';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  listItemsByBatch,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import {
  buildBatchWorkStateContext,
  deriveItemWorkState,
  getItemWorkState,
} from '../../onboarding/onboarding-work-state';
import {
  markVariantIdentityUnresolved,
  clearVariantIdentityDisposition,
  getVariantIdentityDisposition,
  listVariantIdentityDispositions,
} from '../../db/repositories/variant-identity-disposition-repo';
import { makeDomainHealthy } from './helpers/domain-health-fixture';
import {
  setupReleaseDb,
  teardownReleaseDb,
  cleanReleaseDomain,
  seedProfileBlockedItem,
  type ReleaseDbSetup,
} from './helpers/release-db-suite';
import {
  releaseDomainExtractionItems,
  sweepDomainReleases,
} from '../../onboarding/domain-release';
import {
  VARIANT_INELIGIBILITY_REASON_PREFIX,
  UNRESOLVED_VARIANT_IDENTITY_DISPOSITION,
  variantIdentityEligibilityForItem,
} from '../../onboarding/variant-identity-eligibility';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';

const WS_MAIN = 'ws-variant-disposition-main';
const DOMAIN = 'sitecore-hold-218.example.com';

/**
 * A REAL profile-blocked size-specific Nylabone row: the ordinary missing-
 * profile error (never a fabricated `variant:` error), a size-bearing name
 * on the shared Sitecore family page, and no resolution row.
 */
function seedSizeSpecificProfileBlockedItem(batchId: string, upc: string, sizeName: string) {
  const [item] = insertItems(batchId, [
    {
      upc,
      name: `Nylabone Power Chew Groove Bone Dog Chew Toy ${sizeName}`,
      rowNumber: 1,
      stage: 'extraction',
      stageStatus: 'failed',
      sourceUrl: `https://${DOMAIN}/products/product-type/chew-toys/power-chew/dura-chew-power-chew-textured-bone`,
    },
  ]);
  updateItemStageStatus(item.id, 'failed', `No extractor profile for ${DOMAIN} — profile required`);
  return item;
}

describe('explicit unresolved variant-identity disposition (no-matrix Sitecore case)', () => {
  let tempDir: string;
  let mainBatchId: string;

  beforeAll(() => {
    const setup: ReleaseDbSetup = setupReleaseDb({
      tmpPrefix: 'variant-disposition-test-',
      workspaceIds: [WS_MAIN],
      batch: { workspaceId: WS_MAIN, name: 'Disposition', fileName: 'd.csv', totalItems: 10 },
    });
    tempDir = setup.tempDir;
    mainBatchId = setup.batchId;
  });

  afterAll(() => {
    teardownReleaseDb(tempDir);
  });

  beforeEach(() => {
    resetActiveWorkerForTest();
    cleanReleaseDomain(DOMAIN);
  });

  it('predicate: profile-blocked error with no resolution and no disposition stays eligible (the gap)', () => {
    const r = variantIdentityEligibilityForItem({
      itemId: 'nylabone-size-s',
      errorMessage: `No extractor profile for ${DOMAIN} — profile required`,
      variantResolution: null,
      variantDisposition: null,
    });
    expect(r.eligible).toBe(true);
  });

  it('predicate: the recorded disposition holds that same item fail-closed', () => {
    const r = variantIdentityEligibilityForItem({
      itemId: 'nylabone-size-s',
      errorMessage: `No extractor profile for ${DOMAIN} — profile required`,
      variantResolution: null,
      variantDisposition: { disposition: UNRESOLVED_VARIANT_IDENTITY_DISPOSITION, reason: 'size-specific row on no-matrix family page' },
    });
    expect(r.eligible).toBe(false);
    expect(r.reason.startsWith(VARIANT_INELIGIBILITY_REASON_PREFIX)).toBe(true);
  });

  it('predicate: proven operator selection still releases despite a stale disposition', () => {
    const r = variantIdentityEligibilityForItem({
      itemId: 'nylabone-size-s',
      errorMessage: `No extractor profile for ${DOMAIN} — profile required`,
      variantResolution: { status: 'selected', selected_variant_key: 'size-s', automatic_variant_key: null },
      variantDisposition: { disposition: UNRESOLVED_VARIANT_IDENTITY_DISPOSITION, reason: 'stale' },
    });
    expect(r.eligible).toBe(true);
  });

  it('disposition repo round-trips mark/get/clear', () => {
    const [item] = insertItems(mainBatchId, [
      {
        upc: 'DISP-REPO-1',
        name: 'Nylabone Power Chew Groove Bone Dog Chew Toy Small',
        rowNumber: 1,
        stage: 'extraction',
        stageStatus: 'failed',
        sourceUrl: `https://${DOMAIN}/products/repo-1`,
      },
    ]);
    expect(getVariantIdentityDisposition(item.id)).toBeNull();
    const marked = markVariantIdentityUnresolved(item.id, 'size-specific row on no-matrix family page');
    expect(marked.disposition).toBe(UNRESOLVED_VARIANT_IDENTITY_DISPOSITION);
    expect(getVariantIdentityDisposition(item.id)?.reason).toBe('size-specific row on no-matrix family page');
    clearVariantIdentityDisposition(item.id);
    expect(getVariantIdentityDisposition(item.id)).toBeNull();
  });

  it('bulk release holds the disposition-marked size-specific item while the family sibling releases', async () => {
    const sized = seedSizeSpecificProfileBlockedItem(mainBatchId, 'DISP-BULK-S', 'Small');
    const family = seedProfileBlockedItem(mainBatchId, 'DISP-BULK-FAM', DOMAIN);
    await makeDomainHealthy(DOMAIN);

    // Baseline: with no recorded disposition the predicate has no signal.
    const baseline = releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true });
    expect(baseline.releasedIds).toContain(sized.id);
    expect(baseline.releasedIds).toContain(family.id);

    // Re-park both rows, then record the explicit disposition for the
    // size-specific one only (still no resolution row, still the real
    // profile-blocked error).
    updateItemStageStatus(sized.id, 'failed', `No extractor profile for ${DOMAIN} — profile required`);
    updateItemStageStatus(family.id, 'failed', `No extractor profile for ${DOMAIN} — profile required`);
    markVariantIdentityUnresolved(sized.id, 'size-specific row on no-matrix Sitecore family page (VARIANT_CAVEAT_205)');

    const res = releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true });
    expect(res.profileAvailable).toBe(true);
    expect(res.releasedIds).toEqual([family.id]);
    expect(res.skipped.map((s) => s.itemId)).toContain(sized.id);
    const hold = res.skipped.find((s) => s.itemId === sized.id)!;
    expect(hold.reason).toMatch(/variant_resolution_required/);

    expect(findItemById(family.id)!.stageStatus).toBe('pending');
    expect(findItemById(sized.id)!.stageStatus).toBe('failed');
  });

  it('automatic sweep holds the disposition-marked item with a clear reason', async () => {
    const sized = seedSizeSpecificProfileBlockedItem(mainBatchId, 'DISP-SWEEP-S', 'Medium');
    markVariantIdentityUnresolved(sized.id, 'size-specific row on no-matrix Sitecore family page');
    await makeDomainHealthy(DOMAIN);

    const sweep = sweepDomainReleases(WS_MAIN);
    expect(sweep.releasedIds).toEqual([]);
    expect(findItemById(sized.id)!.stageStatus).toBe('failed');

    const direct = releaseDomainExtractionItems(WS_MAIN, DOMAIN);
    expect(direct.releasedIds).toEqual([]);
    expect(direct.skipped.map((s) => s.itemId)).toContain(sized.id);
    expect(direct.skipped.find((s) => s.itemId === sized.id)!.reason).toMatch(/variant_resolution_required/);
  });

  describe('board surfacing seam (issue #220: audited mark/clear + projection)', () => {
    const BOARD_DOMAIN = 'nylabone-board-220.example.com';

    let boardApp: Hono | null = null;
    function app(): Hono {
      if (!boardApp) {
        boardApp = new Hono();
        boardApp.route('/api', onboardingWorkRoutes);
      }
      return boardApp;
    }

    async function markViaRoute(itemId: string, body: unknown): Promise<{ status: number; body: any }> {
      const res = await app().request(`/api/onboarding/items/${itemId}/variant-identity-disposition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    async function readViaRoute(itemId: string): Promise<{ status: number; body: any }> {
      const res = await app().request(`/api/onboarding/items/${itemId}/variant-identity-disposition`);
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    async function clearViaRoute(itemId: string): Promise<{ status: number; body: any }> {
      const res = await app().request(`/api/onboarding/items/${itemId}/variant-identity-disposition`, { method: 'DELETE' });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    function auditRows(entityId: string, action: string): any[] {
      return getDb().query(`SELECT * FROM audit_log WHERE entity_id = ? AND action = ? ORDER BY created_at ASC`).all(entityId, action) as any[];
    }

    /** Real Nylabone size-row shape on the board domain (same family page as the #205 precedent). */
    function seedBoardSizeRow(upc: string, sizeName: string) {
      const [item] = insertItems(mainBatchId, [
        {
          upc,
          name: `Nylabone Power Chew Groove Bone Dog Chew Toy ${sizeName}`,
          rowNumber: 1,
          stage: 'extraction',
          stageStatus: 'failed',
          sourceUrl: `https://${BOARD_DOMAIN}/products/product-type/chew-toys/power-chew/dura-chew-power-chew-textured-bone`,
        },
      ]);
      updateItemStageStatus(item.id, 'failed', `No extractor profile for ${BOARD_DOMAIN} — profile required`);
      return item;
    }

    beforeEach(() => {
      cleanReleaseDomain(BOARD_DOMAIN);
    });

    it('repo audit: mark records who/when; re-mark updates the identity', () => {
      const [item] = insertItems(mainBatchId, [
        {
          upc: 'BOARD-AUDIT-1',
          name: 'Nylabone Power Chew Groove Bone Dog Chew Toy Small',
          rowNumber: 1,
          stage: 'extraction',
          stageStatus: 'failed',
          sourceUrl: `https://${BOARD_DOMAIN}/products/audit-1`,
        },
      ]);
      const first = markVariantIdentityUnresolved(item.id, 'size row, first mark', { markedBy: 'catalog_approver:aaa' });
      expect(first.markedBy).toBe('catalog_approver:aaa');
      const stored = getVariantIdentityDisposition(item.id)!;
      expect(stored.markedBy).toBe('catalog_approver:aaa');
      expect(stored.reason).toBe('size row, first mark');
      expect(stored.createdAt).toBe(first.createdAt);

      const second = markVariantIdentityUnresolved(item.id, 'size row, re-mark', { markedBy: 'catalog_approver:bbb' });
      expect(second.markedBy).toBe('catalog_approver:bbb');
      // Re-marking preserves the original creation timestamp.
      expect(second.createdAt).toBe(first.createdAt);
      expect(getVariantIdentityDisposition(item.id)?.reason).toBe('size row, re-mark');
      expect(getVariantIdentityDisposition(item.id)?.markedBy).toBe('catalog_approver:bbb');
    });

    it('repo: pre-audit rows (null marked_by) read honestly as unknown', () => {
      const [item] = insertItems(mainBatchId, [
        {
          upc: 'BOARD-AUDIT-2',
          name: 'Nylabone Power Chew Groove Bone Dog Chew Toy Medium',
          rowNumber: 1,
          stage: 'extraction',
          stageStatus: 'failed',
          sourceUrl: `https://${BOARD_DOMAIN}/products/audit-2`,
        },
      ]);
      // A pre-audit mark (no recorded identity) reads back null — the
      // repo itself writes this shape when no markedBy is supplied.
      markVariantIdentityUnresolved(item.id, 'legacy mark');
      expect(getVariantIdentityDisposition(item.id)?.markedBy).toBeNull();
    });

    it('repo: bulk loader returns only marked items in one read', () => {
      const mk = (upc: string) => insertItems(mainBatchId, [
        { upc, name: `Bulk ${upc}`, rowNumber: 1, stage: 'extraction', stageStatus: 'failed', sourceUrl: `https://${BOARD_DOMAIN}/products/${upc.toLowerCase()}` },
      ])[0];
      const a = mk('BOARD-BULK-A');
      const b = mk('BOARD-BULK-B');
      const c = mk('BOARD-BULK-C');
      markVariantIdentityUnresolved(a.id, 'a', { markedBy: 'op' });
      markVariantIdentityUnresolved(c.id, 'c', { markedBy: 'op' });
      const map = listVariantIdentityDispositions([a.id, b.id, c.id]);
      expect(map.size).toBe(2);
      expect(map.get(a.id)?.reason).toBe('a');
      expect(map.has(b.id)).toBe(false);
      expect(listVariantIdentityDispositions([]).size).toBe(0);
    });

    it('projection: board work-state carries the disposition state (marked and unmarked)', () => {
      const marked = seedBoardSizeRow('BOARD-WS-M', 'Small');
      const plain = seedBoardSizeRow('BOARD-WS-P', 'Medium');
      markVariantIdentityUnresolved(marked.id, 'board surfacing check', { markedBy: 'catalog_approver:ws' });

      const items = listItemsByBatch(mainBatchId);
      const ctx = buildBatchWorkStateContext(mainBatchId, items);
      const markedState = deriveItemWorkState(items.find((i) => i.id === marked.id)!, ctx);
      expect(markedState.variantDisposition).toMatchObject({
        disposition: UNRESOLVED_VARIANT_IDENTITY_DISPOSITION,
        reason: 'board surfacing check',
        markedBy: 'catalog_approver:ws',
      });
      const plainState = deriveItemWorkState(items.find((i) => i.id === plain.id)!, ctx);
      expect(plainState.variantDisposition).toBeNull();

      // Single-item projection agrees (the resolution drawer read path).
      expect(getItemWorkState(marked.id)?.variantDisposition?.reason).toBe('board surfacing check');
      expect(getItemWorkState(plain.id)?.variantDisposition).toBeNull();
    });

    it('routes: mark/get/clear are audited operator acts with validation', async () => {
      const item = seedBoardSizeRow('BOARD-RT-1', 'Small');

      const bad = await markViaRoute(item.id, {});
      expect(bad.status).toBe(400);
      const tooLong = await markViaRoute(item.id, { reason: 'x'.repeat(501) });
      expect(tooLong.status).toBe(400);
      const missing = await markViaRoute('no-such-item', { reason: 'r' });
      expect(missing.status).toBe(404);

      const marked = await markViaRoute(item.id, { reason: 'size-specific row on no-matrix family page' });
      expect(marked.status).toBe(200);
      expect(marked.body.disposition.reason).toBe('size-specific row on no-matrix family page');
      // Dev/test principal (no API token configured) acts as system — the
      // server-derived identity, never client input.
      expect(marked.body.disposition.markedBy).toBe('system');
      const markAudits = auditRows(item.id, 'mark_variant_identity_unresolved');
      expect(markAudits.length).toBe(1);
      expect(markAudits[0].message).toMatch(/system/);

      const read = await readViaRoute(item.id);
      expect(read.status).toBe(200);
      expect(read.body.disposition.reason).toBe('size-specific row on no-matrix family page');

      const cleared = await clearViaRoute(item.id);
      expect(cleared.status).toBe(200);
      expect(cleared.body.disposition).toBeNull();
      expect(getVariantIdentityDisposition(item.id)).toBeNull();
      const clearAudits = auditRows(item.id, 'clear_variant_identity_disposition');
      expect(clearAudits.length).toBe(1);
      expect(clearAudits[0].message).toMatch(/system/);

      // Clearing an unmarked item is idempotent (still audited).
      const again = await clearViaRoute(item.id);
      expect(again.status).toBe(200);
      expect(auditRows(item.id, 'clear_variant_identity_disposition').length).toBe(2);
    });

    it('routes: foreign-workspace items are 404, never mutated', async () => {
      const otherWs = `ws-board-foreign-${Date.now()}`;
      const now = new Date().toISOString();
      insertWorkspace({
        id: otherWs,
        name: otherWs,
        workspacePath: `/tmp/${otherWs}`,
        gitPath: `/tmp/${otherWs}/.git`,
        createdAt: now,
        updatedAt: now,
        bootstrapStatus: 'complete',
        baselineCommit: 'baseline-sha',
      });
      const foreignBatch = createBatch({ workspaceId: otherWs, name: 'Foreign', fileName: 'f.csv', totalItems: 1 });
      const [foreign] = insertItems(foreignBatch.id, [
        { upc: 'BOARD-FOREIGN', name: 'Foreign Row', rowNumber: 1, stage: 'extraction', stageStatus: 'failed', sourceUrl: `https://${BOARD_DOMAIN}/products/foreign` },
      ]);
      const res = await markViaRoute(foreign.id, { reason: 'attempt' });
      expect(res.status).toBe(404);
      expect(getVariantIdentityDisposition(foreign.id)).toBeNull();
    });

    it('route marks engage the release hold; route clear restores prior behavior', async () => {
      const sized = seedBoardSizeRow('BOARD-HOLD-S', 'Small');
      await makeDomainHealthy(BOARD_DOMAIN);

      // Baseline: unmarked, the real profile-blocked size row releases.
      const baseline = releaseDomainExtractionItems(WS_MAIN, BOARD_DOMAIN, { releaseAllBlocked: true });
      expect(baseline.releasedIds).toContain(sized.id);

      // Operator marks via the board route → hold engages with the
      // machine-readable reason, item stays failed.
      updateItemStageStatus(sized.id, 'failed', `No extractor profile for ${BOARD_DOMAIN} — profile required`);
      const marked = await markViaRoute(sized.id, { reason: 'size-specific Nylabone row (VARIANT_CAVEAT_205)' });
      expect(marked.status).toBe(200);
      const held = releaseDomainExtractionItems(WS_MAIN, BOARD_DOMAIN, { releaseAllBlocked: true });
      expect(held.releasedIds).not.toContain(sized.id);
      expect(held.skipped.map((s) => s.itemId)).toContain(sized.id);
      expect(held.skipped.find((s) => s.itemId === sized.id)!.reason).toMatch(/variant_resolution_required/);
      expect(findItemById(sized.id)!.stageStatus).toBe('failed');

      // Operator clears via the board route → prior behavior restored.
      const cleared = await clearViaRoute(sized.id);
      expect(cleared.status).toBe(200);
      const released = releaseDomainExtractionItems(WS_MAIN, BOARD_DOMAIN, { releaseAllBlocked: true });
      expect(released.releasedIds).toContain(sized.id);
      expect(findItemById(sized.id)!.stageStatus).toBe('pending');
    });
  });
});
