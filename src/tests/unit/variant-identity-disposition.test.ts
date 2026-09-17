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
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  markVariantIdentityUnresolved,
  clearVariantIdentityDisposition,
  getVariantIdentityDisposition,
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
});
