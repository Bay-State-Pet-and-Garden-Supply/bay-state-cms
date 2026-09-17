// Issue #218 — variant-identity rollout hold as a runtime predicate.
//
// Proves variant-unidentifiable items are excluded from BOTH the automatic
// sweep and bulk (`releaseAllBlocked`) activation-triggered release with a
// clear `variant_resolution_required` reason, while identifiable siblings
// still release — and that completed/in-review/skipped items stay untouched.
//
// Convention: bun:sqlite DB-backed, run under `bun test` (same as
// domain-release-guard.test.ts / domain-version-health-evaluator.test.ts).
// Lifecycle + seeds via helpers/release-db-suite (one definition shared by
// the three release suites); only variant-resolution seeding is local.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDb } from '../../db/connection';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { createVariantResolutionRepo } from '../../db/repositories/onboarding-variant-resolution-repo';
import { makeDomainHealthy } from './helpers/domain-health-fixture';
import {
  setupReleaseDb,
  teardownReleaseDb,
  cleanReleaseDomain,
  seedProfileBlockedItem,
  seedTerminalFixture,
  readTerminalFixtureState,
  type ReleaseDbSetup,
  type TerminalFixture,
} from './helpers/release-db-suite';
import {
  releaseDomainExtractionItems,
  sweepDomainReleases,
} from '../../onboarding/domain-release';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';

const WS_MAIN = 'ws-variant-hold-218-main';
const DOMAIN = 'variant-hold-218.example.com';

function seedVariantParkedItem(batchId: string, upc: string, domain: string = DOMAIN) {
  const [item] = insertItems(batchId, [
    {
      upc,
      name: `Variant Parked Product ${upc}`,
      rowNumber: 1,
      stage: 'extraction',
      stageStatus: 'needs_input',
      sourceUrl: `https://${domain}/products/${upc.toLowerCase()}`,
    },
  ]);
  updateItemStageStatus(
    item.id,
    'needs_input',
    'variant:variant_selection_required: family page cannot prove single-variant identity — operator selection required',
  );
  return item;
}

function seedResolution(itemId: string, sourceUrl: string, status: string, selectedKey: string | null) {
  const now = new Date().toISOString();
  createVariantResolutionRepo(getDb()).create({
    id: `vr-218-${itemId}-${status}`,
    onboarding_item_id: itemId,
    source_url: sourceUrl,
    canonical_parent_key: sourceUrl,
    platform: 'test',
    parser_version: 1,
    identity_matrix_hash: 'a'.repeat(64),
    source_content_hash: null,
    status,
    reason_codes_json: JSON.stringify([status]),
    candidates_json: JSON.stringify([{ variantKey: 'size-s', deepLink: sourceUrl }]),
    automatic_variant_key: status === 'resolved' ? 'size-s' : null,
    selected_variant_key: selectedKey,
    decision_origin: status === 'selected' ? 'operator' : null,
    decided_at: status === 'selected' ? now : null,
    superseded_at: null,
    created_at: now,
    updated_at: now,
  });
}

describe('variant-identity rollout hold (#218)', () => {
  let tempDir: string;
  let mainBatchId: string;

  beforeAll(() => {
    const setup: ReleaseDbSetup = setupReleaseDb({
      tmpPrefix: 'variant-hold-218-test-',
      workspaceIds: [WS_MAIN],
      batch: { workspaceId: WS_MAIN, name: 'VariantHold', fileName: 'vh.csv', totalItems: 10 },
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

  it('bulk activation releases identifiable items but holds variant-parked ones with a clear reason', async () => {
    const blocked = seedProfileBlockedItem(mainBatchId, 'VH218-BULK-OK', DOMAIN);
    const parked = seedVariantParkedItem(mainBatchId, 'VH218-BULK-HOLD');
    await makeDomainHealthy(DOMAIN);

    const res = releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true });
    expect(res.profileAvailable).toBe(true);
    expect(res.releasedIds).toEqual([blocked.id]);
    expect(res.skipped.map(s => s.itemId)).toContain(parked.id);
    const hold = res.skipped.find(s => s.itemId === parked.id)!;
    expect(hold.reason).toMatch(/variant_resolution_required/);

    expect(findItemById(blocked.id)!.stageStatus).toBe('pending');
    expect(findItemById(parked.id)!.stageStatus).toBe('needs_input');
  });

  it('automatic sweep holds profile-blocked items with unresolved variant identity', async () => {
    const ambiguous = seedProfileBlockedItem(mainBatchId, 'VH218-SWEEP-HOLD', DOMAIN);
    seedResolution(ambiguous.id, `https://${DOMAIN}/products/vh218-sweep-hold`, 'ambiguous', null);
    const selected = seedProfileBlockedItem(mainBatchId, 'VH218-SWEEP-OK', DOMAIN);
    seedResolution(selected.id, `https://${DOMAIN}/products/vh218-sweep-ok`, 'selected', 'size-s');
    // Pure no-matrix Sitecore case: variant-gate error, no resolution row —
    // the default sweep pre-filter must not drop it silently either.
    const parked = seedVariantParkedItem(mainBatchId, 'VH218-SWEEP-PARKED');
    await makeDomainHealthy(DOMAIN);

    const sweep = sweepDomainReleases(WS_MAIN);
    expect(sweep.releasedIds).toEqual([selected.id]);
    expect(findItemById(selected.id)!.stageStatus).toBe('pending');
    expect(findItemById(ambiguous.id)!.stageStatus).toBe('failed');
    expect(findItemById(parked.id)!.stageStatus).toBe('needs_input');

    // The hold is visible with its reason on the direct primitive too — on
    // the default path, not just the bulk one.
    const direct = releaseDomainExtractionItems(WS_MAIN, DOMAIN);
    expect(direct.releasedIds).toEqual([]);
    for (const held of [ambiguous, parked]) {
      expect(direct.skipped.map(s => s.itemId)).toContain(held.id);
      expect(direct.skipped.find(s => s.itemId === held.id)!.reason).toMatch(/variant_resolution_required/);
    }
  });

  it('completed, in-review, and skipped items are untouched by holds and sweeps', async () => {
    const batch = createBatch({ workspaceId: WS_MAIN, name: 'Terminal218', fileName: 't218.csv', totalItems: 3 });
    const terminal: TerminalFixture = seedTerminalFixture(batch.id, DOMAIN, ['VH218-TERM-1', 'VH218-TERM-2', 'VH218-TERM-3']);
    const parked = seedVariantParkedItem(mainBatchId, 'VH218-TERM-HOLD');

    await makeDomainHealthy(DOMAIN);
    const bulk = releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true });
    expect(bulk.skipped.map(s => s.itemId)).toContain(parked.id);
    expect(sweepDomainReleases(WS_MAIN).releasedIds).toEqual([]);

    expect(readTerminalFixtureState(terminal.ids)).toEqual(terminal.before);
  });
});
