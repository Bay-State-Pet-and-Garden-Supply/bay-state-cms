/**
 * Ticket #124: durable gap correction/resume loop.
 *
 * DB-backed (real SQLite + migrations). Covers: blocking-field derivation
 * (no hardcoded checklist), correction record/resolve lifecycle, command
 * security (derived actor, forbidden fields, wrong scope, stale guards),
 * receipt idempotency, overlay application, downstream guards, read
 * sidecar, and the worker re-preparation loop (correction → resume →
 * validation-gated resolve).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildFocusedFiles } from '../../classification/config-generator';
import { createRuntimeActivationContext, loadActiveClassificationConfigBundleV2, saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { ClassificationFocusedFileNames, ClassificationManifestV2Schema, type ClassificationConfigBundleV2 } from '../../shared/schemas/classification';
import { sha256Hex } from '../../shared/stable-id';
import { getEvidenceByRun, getProposalsByRun, getRun } from '../../db/repositories/classification-run-repo';
import { getCurrentItemEvidenceView, refreshItemEvidence } from '../../onboarding/item-evidence';
import { promoteItems } from '../../onboarding/draft-promoter';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { prepareListingEvidenceWorkspace, refreshListingEvidenceRunCurrentness, seedListingEvidenceItem } from './helpers/listing-evidence-authority';
import { seedCanonicalPromotionAuthority } from './helpers/seed-canonical-promotion-authority';
import { withdrawManualEvidence } from '../../onboarding/manual-evidence-service';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { loadItemAcquisitionPolicy, readItemAcquisitionPolicy } from '../../onboarding/item-acquisition-budget';
import { Hono } from 'hono';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { preparationGapRoutes } from '../../server/routes/preparation-gap-routes';
import { getStageReadItems } from '../../onboarding/onboarding-stage-read';
import { insertWorkspace, updateWorkspacePaths } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  completeSourcingWithDecision,
  claimItemsForProcessing,
  updateItemCurationData,
  updateItemStageStatus,
  advanceReviewedItemsToPromotion,
  type OnboardingItemWithEntryPolicy,
} from '../../db/repositories/onboarding-item-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import { startSourcingGeneration, getCurrentSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import {
  assessListingEvidenceGap,
  openPreparationGap,
  getPreparationGap,
  hasUnresolvedPreparationGap,
  blockingPreparationFields,
  recordGapCorrection,
  resolveAfterValidation,
  listGapsByBatch,
  markCorrectionRun,
} from '../../db/repositories/preparation-gap-repo';
import {
  claimReceipt,
  completeReceipt,
  computeGapCorrectionHash,
  findByScopedIdempotencyKey,
} from '../../db/repositories/onboarding-operation-receipt-repo';
import { recordCorrectionAndResume } from '../../onboarding/gap-correction-service';
import { materializeStrategyCollectionExtraction } from '../../onboarding/sourcing/distributor-record-materializer';
import { finalizeStrategyCollectionForGeneration } from '../../db/repositories/strategy-collection-result-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import { applyGapCorrectionOverlay } from '../../onboarding/product-curator';
import { markReviewed, approveAndAdvanceItems, getReviewState } from '../../db/repositories/onboarding-review-repo';
import { listVerifiedPageOptions, assignProductToPageId } from '../../db/repositories/page-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import onboardingRoutes from '../../server/routes/onboarding-routes';
import { derivePreparationSummary } from '../../onboarding/onboarding-preparation-read';
import { PreparationSummarySchema } from '../../shared/schemas/onboarding-preparation';

class MockConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  lookups = 0;
  constructor(readonly distributorId: string, private readonly name: string | null, private readonly description: string | null) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.lookups += 1;
    return {
      outcome: 'found',
      record: {
        matchedIdentifier: request.upc,
        distributorUpc: request.upc,
        gtin: request.upc,
        distributorSku: `SKU_${this.distributorId}`,
        name: this.name,
        description: this.description,
        brand: 'Acana',
        manufacturerPartNumber: null,
        weight: null,
        features: [],
        category: null,
        dimensions: null,
        casePack: null,
        unitOfMeasure: null,
        ingredients: null,
        attributes: {},
        imageUrls: [],
        sourceUrl: null,
        catalogVersion: null,
        observedAt: new Date().toISOString(),
        expiresAt: null,
      },
      matchedFields: ['upc'],
      warnings: [],
    };
  }
}

class TestRegistry implements ConnectorRegistry {
  private connectors = new Map<string, DistributorConnector>();
  register(distributorId: string, connector: DistributorConnector) {
    this.connectors.set(distributorId, connector);
  }
  createConnector(_type: string, distributorId: string): DistributorConnector | null {
    return this.connectors.get(distributorId) ?? null;
  }
}

const workspaceId = 'ws-124-gap';
const ACTOR = 'catalog_approver:abc123';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'Gap WS',
    workspacePath: '/tmp/test-124-ws',
    gitPath: '/tmp/test-124-ws/.git',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect((err as Error & { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected throw with code ${code}`);
}

function seedItem(upc = '012345678905', name = 'Acana Food') {
  const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [{ upc, name, brandHint: 'Acana', rowNumber: 1 }], 'route_sources', 1);
  return { batch, item };
}

/**
 * Review-fix helper (T-2/T-4/T-6/T-7): run a full distributor_record
 * strategy loop (engine → finalize → accept → decide → materialize) and
 * park the item in Prepare listing. No gap is opened here — callers
 * decide whether the worker must auto-open one (T-6) or they open/record
 * explicitly. Returns the finalized envelope hash, generation id, and the
 * counting connectors for no-refetch assertions.
 */
async function seedStrategyLoop(args: {
  upc?: string;
  itemName?: string;
  distributors: Array<{ id: string; name: string | null; description: string | null }>;
}): Promise<{
  batch: { id: string };
  item: { id: string };
  finalizedHash: string;
  generationId: string;
  connectors: MockConnector[];
}> {
  const upc = args.upc ?? '012345678905';
  for (const dist of args.distributors) {
    try { createDistributor({ id: dist.id, name: dist.id }); } catch { /* seeded */ }
    const c = createConnection({ workspaceId, distributorId: dist.id, connectorType: 'api', configuration: {} });
    updateConnection(c.id, workspaceId, { enabled: true });
  }
  saveBrandStrategy(workspaceId, {
    brand: 'Acana',
    sources: args.distributors.map((d) => ({ kind: 'distributor_record' as const, distributorId: d.id })),
    expectedRevision: 0,
  });
  const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [{ upc, name: args.itemName ?? 'Acana Wild Coast', brandHint: 'Acana', rowNumber: 1 }], 'route_sources', 1);
  const registry = new TestRegistry();
  const connectors: MockConnector[] = [];
  for (const dist of args.distributors) {
    const connector = new MockConnector(dist.id, dist.name, dist.description);
    connectors.push(connector);
    registry.register(dist.id, connector);
  }
  const generation = startSourcingGeneration(item.id);
  const engine = new DefaultSourcingEngine(registry);
  await engine.runGeneration({
    itemId: item.id, generationId: generation.id, workspaceId, upc,
    brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
  });
  const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
  const attemptIds = finalized.attemptInputs.filter((a) => a.outcome === 'found').map((a) => a.attemptId).sort();
  const providers = finalized.attemptInputs.filter((a) => a.outcome === 'found').map((a) => a.providerId).sort();
  recordAcceptances(item.id, attemptIds, 'system', 'test');
  const decided = completeSourcingWithDecision(item.id, {
    schemaVersion: 2 as const,
    route: 'completed_strategy_collection' as const,
    origin: 'automatic_policy' as const,
    acceptedEvidenceAttemptIds: attemptIds,
    providerIds: providers,
    sourcingGenerationId: generation.id,
    evidenceHash: finalized.hash,
    sourceType: 'distributor_record' as const,
    target: 'extraction' as const,
    conflicts: [],
    warnings: [],
    decidedAt: new Date().toISOString(),
  }, 'collect_details');
  expect(decided.ok).toBe(true);
  updateItemStageStatus(item.id, 'in_progress');
  const materialized = materializeStrategyCollectionExtraction(item.id, workspaceId);
  expect(materialized.ok).toBe(true);
  getDb().query(`UPDATE onboarding_items SET stage = 'prepare_listing', stage_status = 'pending' WHERE id = ?`).run(item.id);
  return { batch, item, finalizedHash: finalized.hash, generationId: generation.id, connectors };
}

describe('ticket #124: blocking requirements derive gaps, never a checklist', () => {
  it('defaults require title only; description gaps only when configured blocking', () => {
    expect(blockingPreparationFields()).toEqual(['title']);
    expect(blockingPreparationFields({ MISSING_DESCRIPTION: 'blocker' })).toEqual(['title', 'description']);
    expect(blockingPreparationFields({ MISSING_NAME: 'disabled', MISSING_DESCRIPTION: 'blocker' })).toEqual(['description']);
    expect(blockingPreparationFields({ MISSING_NAME: 'disabled' })).toEqual([]);
    // Assessment honors the derived requirements: a missing description
    // alone is not an interruption by default.
    expect(assessListingEvidenceGap({
      consolidatedFields: { title: 'T', description: '  ' },
      requiredFields: blockingPreparationFields(),
    }).missing).toEqual([]);
    expect(assessListingEvidenceGap({
      consolidatedFields: { title: '  ', description: 'D' },
      requiredFields: blockingPreparationFields(),
    }).missing).toEqual(['title']);
  });
});

describe('ticket #124: correction record/resolve lifecycle', () => {
  it('durable gap survives reload; refresh preserves correction audit; stale callers fail closed', () => {
    const { batch, item } = seedItem();
    const gap = openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    });
    // Reload persistence (new connection read in the same DB).
    expect(getPreparationGap(item.id)?.id).toBe(gap.id);
    expect(hasUnresolvedPreparationGap(item.id)).toBe(true);

    const recorded = recordGapCorrection({
      itemId: item.id, values: { description: 'Operator text' },
      actor: ACTOR, role: 'catalog_approver',
      expectedEvidenceHash: 'a'.repeat(64), expectedUpdatedAt: gap.updatedAt,
    });
    expect(recorded.envelope.revision).toBe(1);
    expect(recorded.envelope.actor).toBe(ACTOR);
    expect(recorded.envelope.status).toBe('recorded');
    expect(getPreparationGap(item.id)?.status).toBe('open');

    // Stale bindings fail closed.
    expectCode(() => recordGapCorrection({
      itemId: item.id, values: { description: 'Other' }, actor: ACTOR, role: 'catalog_approver',
      expectedEvidenceHash: 'b'.repeat(64),
    }), 'stale_gap');
    // Forbidden fields (identity/variant/rights) never pass the merchandising path.
    expectCode(() => recordGapCorrection({
      itemId: item.id, values: { description: 'x', upc: '999' }, actor: ACTOR, role: 'catalog_approver',
    }), 'invalid_field');
    // Incomplete correction keeps the gap open.
    expectCode(() => recordGapCorrection({
      itemId: item.id, values: {}, actor: ACTOR, role: 'catalog_approver',
    }), 'correction_incomplete');

    // Refresh with a narrowed missing set keeps the still-covering
    // correction; a widened set supersedes it (audit retained in place).
    const refreshed = openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    });
    expect(refreshed.correctionEnvelope?.status).toBe('recorded');
    const widened = openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description', 'title'],
      reason: 'Still missing more.', evidenceHash: 'a'.repeat(64),
    });
    expect(widened.correctionEnvelope?.status).toBe('superseded');
    expect(widened.correctionEnvelope?.values).toEqual({ description: 'Operator text' });
    expect(widened.status).toBe('open');
  });

  it('resolveAfterValidation binds revision, hash, and binding; stale workers cannot clear', () => {
    const { batch, item } = seedItem();
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description.', evidenceHash: 'a'.repeat(64),
    });
    const { envelope } = recordGapCorrection({
      itemId: item.id, values: { description: 'Operator text' }, actor: ACTOR, role: 'catalog_approver',
    });
    markCorrectionRun({ itemId: item.id, revision: envelope.revision, runId: 'run-1', status: 'preparing' });
    // Wrong revision / hash / binding all fail closed.
    expectCode(() => resolveAfterValidation({
      itemId: item.id, revision: 99, correctionHash: envelope.correctionHash,
      evidenceHash: 'a'.repeat(64), resolvedBy: ACTOR,
    }), 'stale_gap');
    expectCode(() => resolveAfterValidation({
      itemId: item.id, revision: envelope.revision, correctionHash: 'f'.repeat(64),
      evidenceHash: 'a'.repeat(64), resolvedBy: ACTOR,
    }), 'stale_gap');
    expectCode(() => resolveAfterValidation({
      itemId: item.id, revision: envelope.revision, correctionHash: envelope.correctionHash,
      evidenceHash: 'b'.repeat(64), resolvedBy: ACTOR,
    }), 'stale_gap');
    expect(hasUnresolvedPreparationGap(item.id)).toBe(true);
    const resolved = resolveAfterValidation({
      itemId: item.id, revision: envelope.revision, correctionHash: envelope.correctionHash,
      evidenceHash: 'a'.repeat(64), resolvedBy: ACTOR,
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.correctionEnvelope?.status).toBe('applied');
    expect(hasUnresolvedPreparationGap(item.id)).toBe(false);
  });

  it('listGapsByBatch returns open gaps for review/attention surfaces', () => {
    const { batch, item } = seedItem();
    expect(listGapsByBatch(batch.id)).toEqual([]);
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['title'],
      reason: 'No title.', evidenceHash: null,
    });
    expect(listGapsByBatch(batch.id).map((g) => g.itemId)).toEqual([item.id]);
  });
});

describe('ticket #124: command security and idempotency', () => {
  function seedCorrectable() {
    for (const dist of ['dist_phillips']) {
      createDistributor({ id: dist, name: dist });
    }
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'prepare_listing', 1);
    getDb().query(`UPDATE onboarding_items SET stage_status = 'completed' WHERE id = ?`).run(item.id);
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description.', evidenceHash: 'a'.repeat(64),
    });
    return { batch, item };
  }

  it('records with the derived actor, invalidates review, and replays idempotently', () => {
    const { batch, item } = seedCorrectable();
    const first = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator text' }, idempotencyKey: 'key-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replay).toBe(false);
    expect(first.envelope.actor).toBe(ACTOR);
    expect(first.envelope.values).toEqual({ description: 'Operator text' });
    expect(findItemById(item.id)?.stageStatus).toBe('pending');
    // Same key + same command replays the acceptance without a new revision.
    const replay = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator text' }, idempotencyKey: 'key-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replay).toBe(true);
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(getPreparationGap(item.id)?.correctionRevision).toBe(1);
    // Same key + different payload conflicts.
    const conflict = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Changed' }, idempotencyKey: 'key-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict');
    void batch;
  });

  it('wrong scope, forbidden fields, and stale bindings fail closed', () => {
    const { item } = seedCorrectable();
    const scope = recordCorrectionAndResume(
      { workspaceId: 'ws-foreign', itemId: item.id, values: { description: 'x' }, idempotencyKey: 'k-scope' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(scope.ok).toBe(false);
    const forbidden = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { upc: '1' }, idempotencyKey: 'k-field' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe('invalid_field');
    const stale = recordCorrectionAndResume(
      {
        workspaceId, itemId: item.id, values: { description: 'x' }, idempotencyKey: 'k-stale',
        expectedEvidenceHash: 'z'.repeat(64),
      },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_gap');
    // Nothing was recorded by the failures.
    expect(getPreparationGap(item.id)?.correctionEnvelope).toBeNull();
  });

  it('receipt hash binds scope, binding, values, and principal', () => {
    const receiptBatch = createBatch({ workspaceId, name: 'receipt-b', fileName: 'receipt.csv', totalItems: 1 });
    const bid = receiptBatch.id;
    const base = {
      workspaceId, batchId: bid, itemId: 'i1',
      expectedEvidenceHash: 'a'.repeat(64), expectedUpdatedAt: 't',
      values: { description: 'x' }, principal: ACTOR,
    };
    const h1 = computeGapCorrectionHash(base);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeGapCorrectionHash({ ...base, values: { description: 'y' } })).not.toBe(h1);
    expect(computeGapCorrectionHash({ ...base, principal: 'other' })).not.toBe(h1);
    // claimReceipt replay/conflict semantics carry over to gap_correction.
    const claimed = claimReceipt({
      workspaceId, batchId: bid, operation: 'gap_correction', principal: ACTOR,
      role: 'catalog_approver', idempotencyKey: 'k-h', requestHash: h1,
    });
    expect(claimed.isNew).toBe(true);
    completeReceipt(claimed.receipt.id, JSON.stringify({ revision: 1 }));
    const replay = claimReceipt({
      workspaceId, batchId: bid, operation: 'gap_correction', principal: ACTOR,
      role: 'catalog_approver', idempotencyKey: 'k-h', requestHash: h1,
    });
    expect(replay.isReplay).toBe(true);
    expect(findByScopedIdempotencyKey(workspaceId, bid, 'gap_correction', 'k-h')?.id).toBe(claimed.receipt.id);
  });
});

describe('ticket #124: overlay application is narrow and attributed', () => {
  it('fills only blank title/description, never pipeline values or other fields', () => {
    const overlay = { values: { description: 'Operator text', title: 'Operator title', upc: '999' }, correctionHash: 'a'.repeat(64), actor: ACTOR, revision: 1 };
    expect(applyGapCorrectionOverlay(overlay, { title: null, description: null }))
      .toEqual({ title: 'Operator title', description: 'Operator text', appliedFields: ['title', 'description'] });
    // Pipeline values win; upc is never a correctable field.
    expect(applyGapCorrectionOverlay(overlay, { title: 'Pipe title', description: '  ' }))
      .toEqual({ title: 'Pipe title', description: 'Operator text', appliedFields: ['description'] });
    expect(applyGapCorrectionOverlay(null, { title: null, description: null }))
      .toEqual({ title: null, description: null, appliedFields: [] });
  });
});

describe('ticket #124: downstream guards refuse unresolved gaps', () => {
  function seedReviewable(openGap: boolean) {
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'review_listings', 1);
    getDb().query(`UPDATE onboarding_items SET stage_status = 'completed' WHERE id = ?`).run(item.id);
    if (openGap) {
      openPreparationGap({
        workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['title'],
        reason: 'No title.', evidenceHash: null,
      });
    }
    return { batch, item };
  }

  it('markReviewed throws on an open gap; clear items pass', () => {
    const blocked = seedReviewable(true);
    expect(() => markReviewed({ itemId: blocked.item.id, batchId: blocked.batch.id, reviewedBy: 'op' }))
      .toThrow(/preparation_gap_unresolved/);
    const clear = seedReviewable(false);
    expect(markReviewed({ itemId: clear.item.id, batchId: clear.batch.id, reviewedBy: 'op' }).reviewedBy).toBe('op');
  });

  it('promotion advancement refuses unresolved gaps', () => {
    const { item } = seedReviewable(true);
    getDb().query(`UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`).run(
      JSON.stringify({ suggestedPages: ['Deals'] }), item.id,
    );
    const result = advanceReviewedItemsToPromotion([item.id]);
    expect(result.advanced).toEqual([]);
    expect(result.refused).toEqual([{ itemId: item.id, reason: expect.stringContaining('preparation_gap_unresolved') }]);
    // Without a gap the same item advances.
    getDb().query(`DELETE FROM preparation_gaps WHERE item_id = ?`).run(item.id);
    const retry = advanceReviewedItemsToPromotion([item.id]);
    expect(retry.advanced).toEqual([item.id]);
  });

  it('approveAndAdvanceItems rejects gapped items with preparation_gap_unresolved', () => {
    const { batch, item } = seedReviewable(true);
    // Review state present so the gap (not review absence) is the refusal.
    getDb().query(`INSERT INTO onboarding_review_state
      (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason,
       approved_at, approved_by, approval_origin, created_at, updated_at)
      VALUES (?, ?, ?, 'op', NULL, NULL, NULL, NULL, 'bulk', ?, ?)`).run(
      item.id, batch.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
    );
    const result = approveAndAdvanceItems({ itemIds: [item.id], batchId: batch.id, approvedBy: 'op', requestHash: 'f'.repeat(64) });
    expect(result.rejected.some((r) => r.itemId === item.id && r.reason === 'preparation_gap_unresolved')).toBe(true);
  });
});

describe('ticket #124: read sidecar projects persisted facts, never invents', () => {
  it('open gap, confirmed absence, and unknown reads stay distinct; sections intact', () => {
    const base = {
      itemId: 'item-1',
      stageRows: null, cohort: null, cohortRunStatus: null,
      curatedTitle: 'T', imageUrl: null, semanticBlocked: false,
    };
    const withGap = derivePreparationSummary({
      ...base,
      gap: {
        missingFields: ['description'], reason: 'No description.', evidenceHash: 'a'.repeat(64),
        updatedAt: '2026-09-11T00:00:00.000Z', correctionRevision: 1, correctionStatus: 'recorded' as const,
      },
    });
    expect(withGap.gap?.missingFields).toEqual(['description']);
    expect(withGap.gap?.correctionRevision).toBe(1);
    expect(withGap.sections).toHaveLength(5);
    expect(() => PreparationSummarySchema.parse(withGap)).not.toThrow();

    const clear = derivePreparationSummary({ ...base, gap: null });
    expect(clear.gap).toBeNull();
    expect(() => PreparationSummarySchema.parse(clear)).not.toThrow();

    const unknown = derivePreparationSummary({ ...base });
    expect(unknown.gap).toBeUndefined();
    expect(() => PreparationSummarySchema.parse(unknown)).not.toThrow();
  });
});

  // Minimal valid legacy v1 classification config (mirrors the default-on
  // e2e suite) so processCuration can run the pipeline in these tests.
  const V1_CONFIG = {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-01T12:00:00.000Z', fileVersions: {} },
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
    ],
    attributeProfiles: [
      { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dry Dog Food Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
    ],
    attributeMappings: [
      { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: true, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
      { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: true, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
      { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
    dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
  };

  async function prepareWorkspace() {
    setTaxonomyFreezeForTests(false);
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-worker-')));
    const wsPath = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: wsPath, stdio: 'ignore' });
    saveClassificationConfig(wsPath, V1_CONFIG as never);
    const acquisitionLimits = {
      attempts: 10, pages: 10, actions: 10, redirects: 10, bytes: 1_000_000,
      artifacts: 10, durationMs: 60_000, inputTokens: 10_000, outputTokens: 10_000,
      maxConcurrent: 10, maxCostMicros: null,
    };
    const acquisitionPolicy = {
      schemaVersion: 1,
      policy: {
        recordVersion: 1,
        enabled: true,
        itemLimits: acquisitionLimits,
        batchLimits: acquisitionLimits,
        models: [],
        services: [{ service: 'browser', costMicrosPerAttempt: 0 }],
      },
      approvedBy: 'gap-test',
      approvedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.join(wsPath, 'store', 'item-acquisition'), { recursive: true });
    fs.writeFileSync(
      path.join(wsPath, 'store', 'item-acquisition', 'policy.json'),
      `${JSON.stringify(acquisitionPolicy, null, 2)}\n`,
    );
    execFileSync('git', ['add', '-A'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['add', '-f', 'store/item-acquisition/policy.json'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'Fixture config'], {
      cwd: wsPath,
      stdio: 'ignore',
    });
    updateWorkspacePaths(workspaceId, wsPath, path.join(wsPath, '.git'));
    expect(readItemAcquisitionPolicy(wsPath).policy).toBeTruthy();
    expect(loadItemAcquisitionPolicy(workspaceId).status).toBe('available');
    syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));
    return {
      wsPath,
      cleanup: () => {
        setTaxonomyFreezeForTests(true);
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

async function makeClaimedCurationWorker(wsPath: string): Promise<{
  claimItems: (limit: number) => OnboardingItemWithEntryPolicy[];
  processClaimed: (item: OnboardingItemWithEntryPolicy) => Promise<void>;
  processCuration: (item: unknown) => Promise<void>;
  stop: () => void;
}> {
  const worker = new OnboardingWorker(workspaceId, wsPath);
  const workerId = Reflect.get(worker, 'workerId');
  const processCuration = Reflect.get(worker, 'processCuration');
  if (typeof workerId !== 'string' || typeof processCuration !== 'function') {
    throw new Error('Onboarding worker curation test seam is unavailable');
  }
  const processClaimed = async (item: OnboardingItemWithEntryPolicy): Promise<void> => {
    await Reflect.apply(processCuration, worker, [item]);
  };
  return {
    claimItems: (limit: number) => claimItemsForProcessing('prepare_listing', limit, workspaceId, workerId),
    processClaimed,
    stop: () => worker.stop(),
    processCuration: async (item: unknown) => {
      if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') {
        throw new Error('Curation test input has no onboarding item id');
      }
      const itemId = item.id;
      const claimed = claimItemsForProcessing('prepare_listing', 1, workspaceId, workerId)
        .find((candidate) => candidate.id === itemId);
      if (!claimed) throw new Error(`Could not claim item ${itemId} for curation`);
      await processClaimed(claimed);
    },
  };
}

function writeActiveWorkerBundle(workspacePath: string, bundle: ClassificationConfigBundleV2): void {
  const focusedFiles = buildFocusedFiles(bundle);
  const xmlFields = [...new Set([
    ...bundle.attributeMappings.map((mapping) => mapping.catalogField),
    ...(bundle.classificationOutputBindings ?? []).map((binding) => binding.catalogField),
  ])];
  const catalogEvidenceContent = JSON.stringify({ schemaVersion: 1, xmlFields });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'store', 'field-registry.json'),
    JSON.stringify({ entries: xmlFields.map((xmlField) => ({ xmlField })) }),
  );
  fs.writeFileSync(path.join(workspacePath, 'store', 'classification', 'catalog-evidence.json'), catalogEvidenceContent);
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'Fixture catalog authority'], {
    cwd: workspacePath,
    stdio: 'ignore',
  });
  const sourceCatalogCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspacePath,
    encoding: 'utf-8',
  }).trim();
  const manifestWithoutHash = {
    ...bundle.manifest,
    activeRevision: 'listing-evidence-worker-active',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit,
    catalogEvidenceHash: sha256Hex(catalogEvidenceContent),
    fileVersions: Object.fromEntries(
      ClassificationFocusedFileNames.map((fileName) => [fileName, sha256Hex(focusedFiles[fileName])]),
    ),
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const classificationPath = path.join(workspacePath, 'store', 'classification');
  fs.writeFileSync(path.join(classificationPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [fileName, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(classificationPath, fileName), content);
  }
  loadActiveClassificationConfigBundleV2(
    workspacePath,
    createRuntimeActivationContext(workspacePath, workspaceId),
  );
}

function ensureWorkerRunAuthority(itemId: string, workspacePath: string): void {
  const item = findItemById(itemId);
  const runId = item?.curationData?.classificationRunId;
  if (!item || typeof runId !== 'string') throw new Error(`Worker did not publish a classification run for ${itemId}`);
  const hasAcceptedPair = getProposalsByRun(runId).some(
    (proposal) => proposal.proposalType === 'product_classification' && proposal.status === 'accepted',
  );
  if (hasAcceptedPair) return;
  seedCanonicalPromotionAuthority({
    db: getDb(),
    workspaceId,
    workspacePath,
    sku: item.upc,
    runId,
  });
  refreshListingEvidenceRunCurrentness(workspaceId, itemId, runId);
}

function captureOwnItemAuthority(itemId: string) {
  const item = findItemById(itemId);
  const runId = item?.curationData?.classificationRunId;
  if (!item || typeof runId !== 'string') throw new Error(`Item ${itemId} has no current classification run`);
  const accepted = getCurrentItemEvidenceView(workspaceId, itemId);
  if (!accepted.evidence || accepted.status !== 'accepted') {
    throw new Error(`Item ${itemId} has no current accepted evidence: ${accepted.status}`);
  }
  const evidenceRows = getEvidenceByRun(runId);
  return {
    evidenceIds: evidenceRows.map((evidence) => evidence.id).sort(),
    evidenceSkus: evidenceRows.map((evidence) => evidence.productSku).sort(),
    proposals: getProposalsByRun(runId).sort((left, right) => left.id.localeCompare(right.id)),
    classificationRunId: runId,
    receipt: structuredClone(item.curationData?.itemExecutionCurrentness),
    acceptedEvidenceId: accepted.evidence.id,
    acceptedFactIds: accepted.evidence.facts.map((fact) => fact.id).sort(),
  };
}

  it('correction resumes preparation from retained evidence and resolves when sufficient', async () => {
    for (const dist of ['dist_phillips', 'dist_bci']) {
      createDistributor({ id: dist, name: dist });
      const c = createConnection({ workspaceId, distributorId: dist, connectorType: 'api', configuration: {} });
      updateConnection(c.id, workspaceId, { enabled: true });
    }
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
        { kind: 'distributor_record', distributorId: 'dist_bci' },
      ],
      expectedRevision: 0,
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Wild Coast', brandHint: 'Acana', rowNumber: 1 }], 'route_sources', 1);
    const registry = new TestRegistry();
    // Found records WITHOUT descriptions: title qualifies, description gaps.
    registry.register('dist_phillips', new MockConnector('dist_phillips', 'Acana Wild Coast', null));
    registry.register('dist_bci', new MockConnector('dist_bci', 'Acana Wild Coast', null));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    const { finalizeStrategyCollectionForGeneration: finalize } = await import('../../db/repositories/strategy-collection-result-repo');
    const finalized = finalize({ workspaceId, itemId: item.id, generationId: generation.id });
    const attemptIds = finalized.attemptInputs.filter((a) => a.outcome === 'found').map((a) => a.attemptId).sort();
    const providers = finalized.attemptInputs.filter((a) => a.outcome === 'found').map((a) => a.providerId).sort();
    const { recordAcceptances: accept } = await import('../../db/repositories/onboarding-acceptance-repo');
    accept(item.id, attemptIds, 'system', 'test');
    const decided = completeSourcingWithDecision(item.id, {
      schemaVersion: 2 as const,
      route: 'completed_strategy_collection' as const,
      origin: 'automatic_policy' as const,
      acceptedEvidenceAttemptIds: attemptIds,
      providerIds: providers,
      sourcingGenerationId: generation.id,
      evidenceHash: finalized.hash,
      sourceType: 'distributor_record' as const,
      target: 'extraction' as const,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    }, 'collect_details');
    expect(decided.ok).toBe(true);
    updateItemStageStatus(item.id, 'in_progress');
    const materialized = materializeStrategyCollectionExtraction(item.id, workspaceId);
    expect(materialized.ok).toBe(true);
    // Move to Prepare listing and open a description gap (store configured
    // description as blocking for this scenario).
    getDb().query(`UPDATE onboarding_items SET stage = 'prepare_listing', stage_status = 'pending' WHERE id = ?`).run(item.id);
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      const worker = await makeClaimedCurationWorker(wsPath);
    // Direct curation would gap on title only by default; open the
    // description gap explicitly (store-configured blocking in production).
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: finalized.hash,
    });
    // Operator corrects with the missing description.
    const corrected = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator-supplied description' }, idempotencyKey: 'loop-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    // Worker re-preparation consumes the overlay and resolves on success.
    await worker.processCuration(findItemById(item.id));
    const after = getPreparationGap(item.id);
    expect(after?.status).toBe('resolved');
    expect(after?.correctionEnvelope?.status).toBe('applied');
    expect(hasUnresolvedPreparationGap(item.id)).toBe(false);
    // The corrected description reached the prepared output with operator
    // attribution (never rewritten into source evidence).
    const curated = findItemById(item.id)?.curationData as { curatedDescription?: string; correctionProvenance?: { actor: string; fields: string[] } } | null;
    expect(curated?.curatedDescription).toBe('Operator-supplied description');
    expect(curated?.correctionProvenance).toMatchObject({ actor: ACTOR, fields: ['description'] });
    } finally {
      cleanup();
    }
  });

  it('insufficient correction keeps the gap open with an actionable reason', async () => {
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678906', name: '', brandHint: 'Acana', rowNumber: 1 }], 'prepare_listing', 1);
    getDb().query(`UPDATE onboarding_items SET stage_status = 'pending', extraction_data_json = ? WHERE id = ?`)
      .run(JSON.stringify({ title: null, brand: null, description: null }), item.id);
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['title'],
      reason: 'No title from collected sources.', evidenceHash: null,
    });
    // Blank-only correction values are rejected before any write.
    const blank = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { title: '   ' }, idempotencyKey: 'loop-blank' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(blank.ok).toBe(false);
    expect(hasUnresolvedPreparationGap(item.id)).toBe(true);
  });

// Ticket #124 T-1: HTTP wire coverage for the correction commands —
// auth, key requirement, replay/conflict, and legacy delegation parity.
// Mirrors onboarding-operation-idempotency.test.ts (Hono app.fetch).
describe('ticket #124: correction HTTP routes authenticate, gate keys, and delegate', () => {
  let app: Hono;
  let origToken: string | undefined;

  function seedHttpItem() {
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'prepare_listing', 1);
    getDb().query(`UPDATE onboarding_items SET stage_status = 'completed' WHERE id = ?`).run(item.id);
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    });
    return { batch, item };
  }

  async function postCorrect(itemId: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await app.fetch(new Request(`http://localhost/api/onboarding/preparation-gaps/${itemId}/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
  }

  async function postResolve(itemId: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await app.fetch(new Request(`http://localhost/api/onboarding/preparation-gaps/${itemId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
  }

  beforeEach(() => {
    origToken = process.env.BAYSTATE_CMS_API_TOKEN;
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-124';
    app = new Hono();
    app.route('/api', preparationGapRoutes);
  });

  afterEach(() => {
    if (origToken === undefined) delete process.env.BAYSTATE_CMS_API_TOKEN;
    else process.env.BAYSTATE_CMS_API_TOKEN = origToken;
  });

  it('missing or wrong token returns 401 without touching the gap', async () => {
    const { item } = seedHttpItem();
    const noAuth = await postCorrect(item.id, { values: { description: 'x' } }, { 'Idempotency-Key': 'k-401a' });
    expect(noAuth.status).toBe(401);
    expect(noAuth.json.code).toBe('unauthorized');
    const wrong = await postCorrect(
      item.id, { values: { description: 'x' } },
      { Authorization: 'Bearer wrong', 'Idempotency-Key': 'k-401b' },
    );
    expect(wrong.status).toBe(401);
    expect(getPreparationGap(item.id)?.correctionEnvelope).toBeNull();
  });

  it('missing Idempotency-Key returns 400 without touching the gap', async () => {
    const { item } = seedHttpItem();
    const res = await postCorrect(
      item.id, { values: { description: 'Operator text' } },
      { Authorization: 'Bearer test-token-124' },
    );
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('idempotency_key_required');
    expect(getPreparationGap(item.id)?.correctionEnvelope).toBeNull();
  });

  it('records, replays identically, and conflicts on payload mismatch', async () => {
    const { batch, item } = seedHttpItem();
    const headers = { Authorization: 'Bearer test-token-124', 'Idempotency-Key': 'k-http-1' };
    const first = await postCorrect(item.id, { values: { description: 'Operator text' } }, headers);
    expect(first.status).toBe(200);
    expect(first.json.receiptId).toBeTruthy();
    expect(first.json.replay).toBe(false);
    // Derived principal wins — the token hash, never a client identity.
    const receipt = findByScopedIdempotencyKey(workspaceId, batch.id, 'gap_correction', 'k-http-1');
    expect(receipt?.principal).toMatch(/^catalog_approver:/);
    const replay = await postCorrect(item.id, { values: { description: 'Operator text' } }, headers);
    expect(replay.status).toBe(200);
    expect(replay.json.replay).toBe(true);
    expect(replay.json.receiptId).toBe(first.json.receiptId);
    expect(getPreparationGap(item.id)?.correctionRevision).toBe(1);
    // Same key + different payload conflicts without recording.
    const conflict = await postCorrect(item.id, { values: { description: 'Changed' } }, headers);
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('idempotency_conflict');
    expect(getPreparationGap(item.id)?.correctionRevision).toBe(1);
  });

  it('a 400 fails the receipt: identical retries re-attempt, new payloads conflict (P2-6)', async () => {
    const { batch, item } = seedHttpItem();
    const headers = { Authorization: 'Bearer test-token-124', 'Idempotency-Key': 'k-http-retry' };
    const bad = await postCorrect(item.id, { values: { upc: '999' } }, headers);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_field');
    expect(findByScopedIdempotencyKey(workspaceId, batch.id, 'gap_correction', 'k-http-retry')?.status).toBe('failed');
    // Identical retry re-attempts the same validation (no
    // 409-interrupted treadmill forcing a new key).
    const retry = await postCorrect(item.id, { values: { upc: '999' } }, headers);
    expect(retry.status).toBe(400);
    expect(retry.json.code).toBe('invalid_field');
    // Same key + different payload still conflicts (key reuse is bound).
    const conflict = await postCorrect(item.id, { values: { description: 'Changed' } }, headers);
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('idempotency_conflict');
    // Fixed values under a fresh key record normally.
    const fixed = await postCorrect(
      item.id, { values: { description: 'Operator text' } },
      { Authorization: 'Bearer test-token-124', 'Idempotency-Key': 'k-http-retry-2' },
    );
    expect(fixed.status).toBe(200);
    expect(getPreparationGap(item.id)?.correctionRevision).toBe(1);
  });

  it('legacy /resolve delegates with stale-binding parity (P1-4)', async () => {
    const { item } = seedHttpItem();
    const headers = { Authorization: 'Bearer test-token-124', 'Idempotency-Key': 'k-legacy-1' };
    // Stale binding through the legacy shape is rejected like /correct.
    const stale = await postResolve(item.id, {
      correction: { description: 'Operator text' }, expectedEvidenceHash: 'z'.repeat(64),
    }, headers);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('stale_gap');
    expect(getPreparationGap(item.id)?.correctionEnvelope).toBeNull();
    // Fresh bindings record through the same workflow.
    const ok = await postResolve(item.id, {
      correction: { description: 'Operator text' },
      expectedEvidenceHash: 'a'.repeat(64),
      expectedUpdatedAt: getPreparationGap(item.id)?.updatedAt,
    }, { Authorization: 'Bearer test-token-124', 'Idempotency-Key': 'k-legacy-2' });
    expect(ok.status).toBe(200);
    // Recorded then marked preparing for resume (service owns the run
    // transition; the gap itself stays open until validation).
    expect(ok.json.envelope).toMatchObject({ revision: 1, status: 'preparing' });
    // The legacy path still needs its key.
    const noKey = await postResolve(item.id, { correction: { description: 'x' } }, { Authorization: 'Bearer test-token-124' });
    expect(noKey.status).toBe(400);
  });
});

// Ticket #124 T-2/T-6/T-7 + P1-1/P1-5/P2-11: worker-loop hardening —
// no-refetch resume, stale-resolve reclaim, store-configured derivation,
// auto-open, repeated resume, and failed-validation reasons.
describe('ticket #124: resume uses retained evidence under frozen discipline', () => {
  type Worker = { processCuration: (item: unknown) => Promise<void> };
  async function makeWorker(wsPath: string): Promise<Worker> {
    return makeClaimedCurationWorker(wsPath);
  }
  const distPair = () => ([
    { id: 'dist_phillips', name: 'Acana Wild Coast', description: null },
    { id: 'dist_bci', name: 'Acana Wild Coast', description: null },
  ]);

  it('re-preparation performs zero refetches on the same generation and consumes the frozen snapshot (T-2)', async () => {
    const loop = await seedStrategyLoop({ distributors: distPair() });
    openPreparationGap({
      workspaceId, itemId: loop.item.id, batchId: loop.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: loop.finalizedHash,
    });
    const lookupsBefore = loop.connectors.reduce((n, c) => n + c.lookups, 0);
    expect(lookupsBefore).toBeGreaterThan(0);
    const corrected = recordCorrectionAndResume(
      { workspaceId, itemId: loop.item.id, values: { description: 'Operator-supplied description' }, idempotencyKey: 't2-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(corrected.ok).toBe(true);
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      await (await makeWorker(wsPath)).processCuration(findItemById(loop.item.id));
      // No silent refetch: same generation, zero new connector lookups,
      // and the run consumed the frozen config snapshot.
      expect(getCurrentSourcingGeneration(loop.item.id)?.id).toBe(loop.generationId);
      expect(loop.connectors.reduce((n, c) => n + c.lookups, 0)).toBe(lookupsBefore);
      expect(getPreparationGap(loop.item.id)?.status).toBe('resolved');
      const curated = findItemById(loop.item.id)?.curationData as {
        curatedDescription?: string; classificationConfigSnapshot?: unknown;
        correctionProvenance?: { actor: string; fields: string[] };
      } | null;
      expect(curated?.curatedDescription).toBe('Operator-supplied description');
      expect(curated?.classificationConfigSnapshot).toBeTruthy();
      expect(curated?.correctionProvenance).toMatchObject({ actor: ACTOR, fields: ['description'] });
    } finally {
      cleanup();
    }
  });

  it('a stale resolve returns the item to pending, never strands it in failed (P1-1/P1-5)', async () => {
    const loop = await seedStrategyLoop({ distributors: distPair() });
    // Gap bound to a superseded hash (re-finalized collection since).
    // The recorded correction binds the stale hash; the worker resolves
    // against the validation-time collection hash and loses the race.
    openPreparationGap({
      workspaceId, itemId: loop.item.id, batchId: loop.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'z'.repeat(64),
    });
    recordGapCorrection({
      itemId: loop.item.id, values: { description: 'Operator text' }, actor: ACTOR, role: 'catalog_approver',
    });
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      await (await makeWorker(wsPath)).processCuration(findItemById(loop.item.id));
      // Reclaimable pending (the poll loop re-runs preparation), not
      // terminal failed; the gap stays open for the newer correction.
      expect(findItemById(loop.item.id)?.stageStatus).toBe('pending');
      expect(getPreparationGap(loop.item.id)?.status).toBe('open');
      expect(getPreparationGap(loop.item.id)?.correctionRevision).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('store-configured blocking severities drive worker gap derivation (P2-11)', async () => {
    const loop = await seedStrategyLoop({
      distributors: [{ id: 'dist_phillips', name: 'Acana Wild Coast', description: null }],
    });
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(
        path.join(wsPath, 'store', 'health-config.json'),
        JSON.stringify({ rules: [{ code: 'MISSING_DESCRIPTION', severity: 'blocker' }] }),
      );
      // No manual gap: title is present, description missing — the worker
      // auto-opens a description gap only because the store configures it
      // blocking (defaults would stay silent).
      await (await makeWorker(wsPath)).processCuration(findItemById(loop.item.id));
      const gap = getPreparationGap(loop.item.id);
      expect(gap?.status).toBe('open');
      expect(gap?.missingFields).toEqual(['description']);
    } finally {
      cleanup();
    }
  });

  it('a second preparation after resolve stays resolved with no new revision (T-7 repeated resume)', async () => {
    const loop = await seedStrategyLoop({ distributors: distPair() });
    openPreparationGap({
      workspaceId, itemId: loop.item.id, batchId: loop.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: loop.finalizedHash,
    });
    const corrected = recordCorrectionAndResume(
      { workspaceId, itemId: loop.item.id, values: { description: 'Operator-supplied description' }, idempotencyKey: 't7-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(corrected.ok).toBe(true);
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      const worker = await makeWorker(wsPath);
      await worker.processCuration(findItemById(loop.item.id));
      expect(getPreparationGap(loop.item.id)?.status).toBe('resolved');
      getDb().query(`UPDATE onboarding_items SET stage_status = 'pending' WHERE id = ?`).run(loop.item.id);
      await worker.processCuration(findItemById(loop.item.id));
      expect(getPreparationGap(loop.item.id)?.status).toBe('resolved');
      expect(getPreparationGap(loop.item.id)?.correctionRevision).toBe(1);
      expect(getPreparationGap(loop.item.id)?.correctionEnvelope?.status).toBe('applied');
      expect(findItemById(loop.item.id)?.stageStatus).toBe('completed');
    } finally {
      cleanup();
    }
  });

  it('a well-formed but insufficient correction keeps an actionable field-naming reason (T-7 failed validation)', async () => {
    // Title missing everywhere (blank item name, nameless records) while
    // the gap only asked for a description: the recorded description
    // applies, the title still fails, and the refreshed reason names it.
    const loop = await seedStrategyLoop({
      itemName: '',
      distributors: [
        { id: 'dist_phillips', name: null, description: null },
        { id: 'dist_bci', name: null, description: null },
      ],
    });
    openPreparationGap({
      workspaceId, itemId: loop.item.id, batchId: loop.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: loop.finalizedHash,
    });
    const corrected = recordCorrectionAndResume(
      { workspaceId, itemId: loop.item.id, values: { description: 'Operator-supplied description' }, idempotencyKey: 't7-2' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(corrected.ok).toBe(true);
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      await (await makeWorker(wsPath)).processCuration(findItemById(loop.item.id));
      const gap = getPreparationGap(loop.item.id);
      expect(gap?.status).toBe('open');
      expect(gap?.correctionEnvelope?.status).toBe('failed');
      expect(gap?.reason).toMatch(/title/);
      expect(gap?.reason.length).toBeLessThanOrEqual(160);
      expect(hasUnresolvedPreparationGap(loop.item.id)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('the worker auto-opens a title gap with no manual openPreparationGap (T-6)', async () => {
    const loop = await seedStrategyLoop({
      itemName: '',
      distributors: [
        { id: 'dist_phillips', name: null, description: null },
        { id: 'dist_bci', name: null, description: null },
      ],
    });
    expect(hasUnresolvedPreparationGap(loop.item.id)).toBe(false);
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      await (await makeWorker(wsPath)).processCuration(findItemById(loop.item.id));
      // Derivation (blockingPreparationFields + post-consolidation
      // assessListingEvidenceGap), never a hardcoded checklist, opened this.
      const gap = getPreparationGap(loop.item.id);
      expect(gap?.status).toBe('open');
      expect(gap?.missingFields).toEqual(['title']);
      expect(gap?.reason).toMatch(/title/);
    } finally {
      cleanup();
    }
  });
});

// Ticket #124 T-3/T-4: post-resolve ordinary review transition, forbidden
// correction fields, and the sparse-single-source non-interruption.
describe('ticket #124: resolved gaps flow through ordinary review; rights never correct', () => {
  it('after a validated resolve, markReviewed and approveAndAdvanceItems succeed with no bypass (T-3)', async () => {
    const loop = await seedStrategyLoop({
      distributors: [{ id: 'dist_phillips', name: 'Acana Wild Coast', description: null }],
    });
    openPreparationGap({
      workspaceId, itemId: loop.item.id, batchId: loop.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: loop.finalizedHash,
    });
    const corrected = recordCorrectionAndResume(
      { workspaceId, itemId: loop.item.id, values: { description: 'Operator-supplied description' }, idempotencyKey: 't3-1' },
      { actor: ACTOR, role: 'catalog_approver', tokenHash: 'abc123' },
    );
    expect(corrected.ok).toBe(true);
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      const worker = await makeClaimedCurationWorker(wsPath);
      await worker.processCuration(findItemById(loop.item.id));
      expect(getPreparationGap(loop.item.id)?.status).toBe('resolved');
      // Ordinary Review listings transition on the prepared result.
      getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(loop.item.id);
      expect(markReviewed({ itemId: loop.item.id, batchId: loop.batch.id, reviewedBy: 'op' }).reviewedBy).toBe('op');
      const approved = approveAndAdvanceItems({
        itemIds: [loop.item.id], batchId: loop.batch.id, approvedBy: 'op', requestHash: 'f'.repeat(64),
      });
      expect(approved.rejected).toEqual([]);
      expect(approved.approved).toEqual([loop.item.id]);
    } finally {
      cleanup();
    }
  });

  it('image/rights/claim fields are rejected and never overlaid (T-4 forbidden set)', () => {
    const seeded = seedItem('012345678906', 'Acana Puppy');
    openPreparationGap({
      workspaceId, itemId: seeded.item.id, batchId: seeded.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: null,
    });
    for (const field of ['imageUrl', 'primaryImage', 'rights', 'claims', 'brand', 'upc']) {
      expectCode(() => recordGapCorrection({
        itemId: seeded.item.id, values: { description: 'x', [field]: 'y' }, actor: ACTOR, role: 'catalog_approver',
      }), 'invalid_field');
    }
    expect(getPreparationGap(seeded.item.id)?.correctionEnvelope).toBeNull();
    // The overlay only reads title/description — foreign keys are inert.
    expect(applyGapCorrectionOverlay(
      { values: { imageUrl: 'u', rights: 'r', claims: 'c' }, correctionHash: 'a'.repeat(64), actor: ACTOR, revision: 1 },
      { title: null, description: null },
    )).toEqual({ title: null, description: null, appliedFields: [] });
  });

  it('a single distributor_record source with a title is sufficient and gap-free (T-4 sparse source)', async () => {
    const loop = await seedStrategyLoop({
      itemName: '',
      distributors: [{ id: 'dist_phillips', name: 'Acana Wild Coast', description: null }],
    });
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      const worker = await makeClaimedCurationWorker(wsPath);
      // One sparse source, no manual gap: a present title satisfies the
      // default blocking requirements — sparsity alone never interrupts.
      await worker.processCuration(findItemById(loop.item.id));
      expect(hasUnresolvedPreparationGap(loop.item.id)).toBe(false);
      expect(getPreparationGap(loop.item.id)).toBeNull();
      expect(findItemById(loop.item.id)?.stageStatus).toBe('completed');
    } finally {
      cleanup();
    }
  });
});

// Ticket #124 T-5: the stage-read contract projects persisted gap facts —
// open rows, confirmed clear, and sections byte-identical either way.
describe('ticket #124: stage-read preparation sidecar projects persisted gaps', () => {
  it('open gap projects; confirmed clear reads null; sections unchanged', () => {
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'prepare_listing', 1);
    const scope = { workspaceId, batchId: batch.id };
    const read = () => getStageReadItems(batch.id, {}, 50, scope).preparationByItem as Record<string, {
      gap?: unknown; sections: unknown;
    } | undefined>;
    // No row: confirmed clear (the chunk load ran and found nothing).
    // (toBeNull also fails if the item itself were absent from the map.)
    expect(read()[item.id]?.gap).toBeNull();
    const baselineSections = JSON.stringify(read()[item.id]?.sections);
    expect(baselineSections).toBeTruthy();
    // Open row with a recorded correction projects persisted facts.
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    });
    recordGapCorrection({
      itemId: item.id, values: { description: 'Operator text' }, actor: ACTOR, role: 'catalog_approver',
    });
    const projected = read()[item.id]?.gap as {
      missingFields: string[]; reason: string; evidenceHash: string | null;
      correctionRevision: number; correctionStatus: string;
    } | null | undefined;
    expect(projected).toMatchObject({
      missingFields: ['description'],
      reason: 'No description from collected sources.',
      evidenceHash: 'a'.repeat(64),
      correctionRevision: 1,
      correctionStatus: 'recorded',
    });
    // The five-section display is untouched by the sidecar.
    expect(JSON.stringify(read()[item.id]?.sections)).toBe(baselineSections);
    const full = (getStageReadItems(batch.id, {}, 50, scope).preparationByItem as Record<string, Record<string, unknown>>)[item.id];
    expect(() => PreparationSummarySchema.parse({ ...full })).not.toThrow();
  });
});

// Ticket #124 follow-ups (re-review): superseded/post-resolve replay can
// never resurrect a dead envelope; legacy review-complete refuses open
// gaps with structured reasons; the revision-0 stale path returns to
// pending instead of stranding the item in failed.
describe('ticket #124: replay never resurrects dead envelopes (P1-3)', () => {
  function seedOpenGap() {
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'prepare_listing', 1);
    getDb().query(`UPDATE onboarding_items SET stage_status = 'completed' WHERE id = ?`).run(item.id);
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    });
    return { batch, item };
  }
  const principal = { actor: ACTOR, role: 'catalog_approver' as const, tokenHash: 'abc123' };

  it('a same-key retry after supersede re-records (never replays the dead envelope)', () => {
    const { batch, item } = seedOpenGap();
    const first = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator text' }, idempotencyKey: 'replay-k1' },
      principal,
    );
    expect(first.ok).toBe(true);
    // Widen the missing set: revision preserved, envelope superseded.
    const widened = openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description', 'title'],
      reason: 'Still missing more.', evidenceHash: 'a'.repeat(64),
    });
    expect(widened.correctionRevision).toBe(1);
    expect(widened.correctionEnvelope?.status).toBe('superseded');
    const retry = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator text' }, idempotencyKey: 'replay-k1' },
      principal,
    );
    // Never a replay:true success on the dead envelope — the retry
    // re-records and fails validation (title is now uncovered).
    expect(retry.ok ? retry.replay : false).toBe(false);
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.code).toBe('correction_incomplete');
      expect(retry.status).toBe(422);
    }
    expect(getPreparationGap(item.id)?.correctionRevision).toBe(1);
    expect(getPreparationGap(item.id)?.correctionEnvelope?.status).toBe('superseded');
  });

  it('a same-key retry after resolve is a 409 gap_not_open, never a replay', () => {
    const { item } = seedOpenGap();
    const first = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator text' }, idempotencyKey: 'replay-k2' },
      principal,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const resolved = resolveAfterValidation({
      itemId: item.id, revision: first.envelope.revision, correctionHash: first.envelope.correctionHash,
      evidenceHash: 'a'.repeat(64), resolvedBy: ACTOR,
    });
    expect(resolved.status).toBe('resolved');
    const retry = recordCorrectionAndResume(
      { workspaceId, itemId: item.id, values: { description: 'Operator text' }, idempotencyKey: 'replay-k2' },
      principal,
    );
    expect(retry.ok ? retry.replay : false).toBe(false);
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.code).toBe('gap_not_open');
      expect(retry.status).toBe(409);
    }
  });
});

describe('ticket #124: legacy review-complete refuses open gaps with structured reasons (P1-2)', () => {
  it('a gapped run-less item fails with preparation_gap_unresolved and nothing mutates', async () => {
    const fs = await import('node:fs');
    fs.mkdirSync('/tmp/test-124-ws', { recursive: true });
    const { createHash: sha, randomUUID: uuid } = await import('node:crypto');
    const upc = `GAPLEGACY-${uuid().slice(0, 6)}`;
    // Verified Category Page authority (mirrors review-completeness-gate
    // fixtures) so the gap refusal — not pages/completeness — is isolated.
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sha('sha256').update('Pets').digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid' as const, key: 'guid-Pets', status: 'verified' as const },
        name: 'Pets',
        parentRef: null,
        availability: 'available' as const,
      }],
      activatedBy: 'test',
    });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets');
    expect(verifiedPage).toBeTruthy();
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{
      upc, name: 'Spreadsheet Name', price: '12.34', brandHint: 'Acme', rowNumber: 1,
    }], 'review_listings', 1);
    assignProductToPageId(upc, verifiedPage!.id, 'Pets');
    getDb().query(`UPDATE onboarding_items SET curation_data_json = ?, extraction_data_json = ? WHERE id = ?`).run(
      JSON.stringify({
        suggestedPages: ['Pets'],
        curatedTitle: 'Reviewed Title',
        curatedDescription: 'Reviewed description',
        searchKeywords: 'kw',
        curatedWeight: '2 lb',
      }),
      JSON.stringify({ title: 'Ext', primaryImage: 'http://img.example/p.jpg' }),
      item.id,
    );
    // No classificationRunId: legacy run-less path — but with an open gap.
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: null,
    });
    const before = findItemById(item.id)!;
    const app = new Hono();
    app.route('/api', onboardingRoutes);
    const res = await app.request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; failures: Array<{ itemId: string; reason: string }> };
    expect(body.error).toContain('None were mutated');
    expect(body.failures.find((f) => f.itemId === item.id)?.reason).toContain('preparation_gap_unresolved');
    // Nothing mutated: same stage/status/curation, no durable review row.
    const after = findItemById(item.id)!;
    expect(after.stage).toBe(before.stage);
    expect(after.stageStatus).toBe(before.stageStatus);
    expect(after.curationData).toEqual(before.curationData);
    expect(getReviewState(item.id)).toBeUndefined();
  });
});

describe('ticket #124: revision-0 stale resolve returns to pending (branch-2)', () => {
  it('a stale binding on the no-envelope path returns the item to pending, never failed', async () => {
    const loop = await seedStrategyLoop({
      distributors: [{ id: 'dist_phillips', name: 'Acana Wild Coast', description: null }],
    });
    // Gap bound to a superseded hash; no correction recorded (rev 0, no
    // envelope). The worker resolves against the validation-time
    // collection hash and loses the race — reclaimable pending, never
    // terminal failed.
    openPreparationGap({
      workspaceId, itemId: loop.item.id, batchId: loop.batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'z'.repeat(64),
    });
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      const worker = await makeClaimedCurationWorker(wsPath);
      await worker.processCuration(findItemById(loop.item.id));
      expect(findItemById(loop.item.id)?.stageStatus).toBe('pending');
      expect(getPreparationGap(loop.item.id)?.status).toBe('open');
      expect(getPreparationGap(loop.item.id)?.correctionRevision).toBe(0);
      expect(getPreparationGap(loop.item.id)?.correctionEnvelope).toBeNull();
    } finally {
      cleanup();
    }
  });
});
describe('issue #384 T3: current-worker mixed-peer recovery owns each item authority', () => {
  it('keeps healthy review and draft authority isolated while its peer is blocked, then recovers idempotently', async () => {
    const { wsPath, cleanup } = await prepareWorkspace();
    try {
      // NOTE: no listing-evidence standard preview here — this workspace
      // uses V1 config + canonical promotion authority, not the V2
      // listing-evidence manifest. (previewTitleDescriptionStandard
      // requires the V2 manifest and breaks this fixture.)
      // Verified Category Page authority for the healthy item (mirrors the
      // ticket-#124 fixtures): the universal page requirement must resolve
      // for healthy while the peer stays blocked by its preparation gap.
      const { createHash: t3sha } = await import('node:crypto');
      activatePageImportFromRecords({
        workspaceId,
        sourceHash: t3sha('sha256').update('T3-dog-food').digest('hex'),
        parserFormatVersion: 'pages-xml-1',
        records: [{
          identity: { kind: 'exported_guid' as const, key: 'guid-t3-dog-food', status: 'verified' as const },
          name: 'QA/test-only dog-food category',
          parentRef: null,
          availability: 'available' as const,
        }],
        activatedBy: 'test',
      });
      const t3Page = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'QA/test-only dog-food category');
      if (!t3Page) throw new Error('T3 verified category page missing');
      assignProductToPageId('T3-HEALTHY-01', t3Page.id, 'QA/test-only dog-food category');
      // Versioned listing standard for the seeded dog-food/dog-food-dry
      // pair. Written directly (not via previewListingStandard, which
      // requires the V2 manifest this V1 fixture does not install).
      // Title-only: the worker's V1 world has no description standard.
      {
        const { hashCanonicalJson: t3hash } = await import('../../shared/stable-id');
        const t3requirements = [{
          id: 't3-product-title',
          field: 'title',
          label: 'Product title',
          kind: 'field',
          required: true,
          exceptionEligible: false,
          allowedSourceRoles: ['operator_attested', 'distributor_record', 'manufacturer_official'],
          applicableWhen: null,
        }];
        const t3dir = path.join(wsPath, 'store', 'classification');
        fs.mkdirSync(t3dir, { recursive: true });
        fs.writeFileSync(path.join(t3dir, 'listing-completeness.json'), JSON.stringify({
          recordVersion: 1,
          standards: [{
            recordVersion: 1,
            id: 't3-listing-standard',
            revision: 1,
            categoryId: 'dog-food',
            productTypeId: 'dog-food-dry',
            requirements: t3requirements,
            approvedBy: 't3-fixture',
            approvedAt: new Date().toISOString(),
            standardHash: t3hash({
              categoryId: 'dog-food',
              productTypeId: 'dog-food-dry',
              requirements: t3requirements.map(({ id, field, kind, required, exceptionEligible, allowedSourceRoles, applicableWhen }) =>
                ({ id, field, kind, required, exceptionEligible, allowedSourceRoles: [...allowedSourceRoles].sort(), applicableWhen })),
            }),
          }],
        }, null, 2));
      }
      const batch = createBatch({ workspaceId, name: 'mixed-peer', fileName: 'mixed-peer.csv', totalItems: 2 });
      const [healthy, peer] = insertItems(
        batch.id,
        [
          { upc: 'T3-HEALTHY-01', name: 'Acana Adult Dog Food Healthy 5 lb', brandHint: 'Acana', price: '12.99', rowNumber: 1 },
          { upc: 'T3-PEER-01', name: 'Acana Adult Dog Food Peer', brandHint: 'Acana', price: '12.99', rowNumber: 2 },
        ],
        'review',
        1,
      );
      const healthySeed = seedListingEvidenceItem({
        workspaceId,
        workspacePath: wsPath,
        itemId: healthy.id,
        sku: healthy.upc,
        description: 'Complete adult dog food with chicken and balanced nutrition.',
        extractionData: {
          title: healthy.name,
          brand: 'Acme',
          description: 'Complete adult dog food with chicken and balanced nutrition.',
          weight: '5 lb',
        },
      });
      const peerSeed = seedListingEvidenceItem({
        workspaceId,
        workspacePath: wsPath,
        itemId: peer.id,
        sku: peer.upc,
        extractionData: { title: peer.name, brand: 'Acana' },
      });
      getDb().query(`UPDATE onboarding_items SET stage = 'prepare_listing', stage_status = 'pending' WHERE id = ?`).run(healthy.id);
      getDb().query(`UPDATE onboarding_items SET stage = 'prepare_listing', stage_status = 'pending' WHERE id = ?`).run(peer.id);
      const activeAuthority = seedCanonicalPromotionAuthority({
        db: getDb(),
        workspaceId,
        workspacePath: wsPath,
        sku: healthy.upc,
        runId: healthySeed.runId,
      });
      seedCanonicalPromotionAuthority({
        db: getDb(),
        workspaceId,
        workspacePath: wsPath,
        sku: peer.upc,
        runId: peerSeed.runId,
      });
      writeActiveWorkerBundle(wsPath, activeAuthority.bundle);

      const worker = await makeClaimedCurationWorker(wsPath);
      const claims = worker.claimItems(2);
      const healthyClaim = claims.find((item) => item.id === healthy.id);
      const peerClaim = claims.find((item) => item.id === peer.id);
      if (!healthyClaim || !peerClaim) throw new Error('The production prepare-listing claim did not claim both fixture items.');

      // Prepare the deficient peer first, then keep its review blocked while
      // the independently claimed healthy item continues through the worker.
      await worker.processClaimed(peerClaim);
      expect(findItemById(peer.id)?.stageStatus).toBe('completed');
      ensureWorkerRunAuthority(peer.id, wsPath);
      const peerBeforeRecovery = captureOwnItemAuthority(peer.id);
      const peerEvidenceBeforeRecovery = getCurrentItemEvidenceView(workspaceId, peer.id).evidence;
      if (!peerEvidenceBeforeRecovery) throw new Error('The blocked peer lost its accepted evidence before the gap was recorded.');
      openPreparationGap({
        workspaceId,
        itemId: peer.id,
        batchId: batch.id,
        missingFields: ['description'],
        reason: 'The accepted peer listing has no description.',
        evidenceHash: peerEvidenceBeforeRecovery.evidenceHash,
      });
      expect(hasUnresolvedPreparationGap(peer.id)).toBe(true);

      await worker.processClaimed(healthyClaim);
      expect(findItemById(healthy.id)?.stageStatus).toBe('completed');
      // Reviewer-equivalent page assignment: the worker's page proposal yields
      // none in this fixture, so bind the verified category directly. The
      // assignment resolves against the verified import activated above.
      updateItemCurationData(healthy.id, JSON.stringify({
        ...((findItemById(healthy.id)?.curationData ?? {}) as Record<string, unknown>),
        suggestedPages: ['QA/test-only dog-food category'],
        // Reviewer-equivalent media selection (curation-side; extraction
        // untouched so the manual-evidence hash still matches). Relative
        // path kept verbatim, no fetch.
        reviewedMedia: { primaryImage: 'products/T3-HEALTHY-01/images/primary.jpg', orderedAdditional: [], suppressed: [] },
      }));
      // Ensure the worker's final run authority is selected before stamping
      // currentness; the gate validates against that run and its live inputs.
      ensureWorkerRunAuthority(healthy.id, wsPath);
      refreshListingEvidenceRunCurrentness(
        workspaceId,
        healthy.id,
        (findItemById(healthy.id)?.curationData as Record<string, unknown> | undefined)?.classificationRunId as string,
      );
      const healthyAuthority = captureOwnItemAuthority(healthy.id);
      expect(healthyAuthority.evidenceIds.length).toBeGreaterThan(0);
      expect(healthyAuthority.proposals.length).toBeGreaterThan(0);
      expect(healthyAuthority.evidenceSkus.every((sku) => sku === healthy.upc)).toBe(true);
      expect(healthyAuthority.acceptedEvidenceId).not.toBe(peerBeforeRecovery.acceptedEvidenceId);
      expect(healthyAuthority.acceptedFactIds.some((id) => peerBeforeRecovery.acceptedFactIds.includes(id))).toBe(false);
      expect(healthyAuthority.evidenceIds.some((id) => peerSeed.evidenceIds.includes(id))).toBe(false);
      expect(healthyAuthority.proposals.every((proposal) => proposal.productSku === healthy.upc)).toBe(true);
      expect(healthyAuthority.receipt).toMatchObject({
        evidenceId: healthyAuthority.acceptedEvidenceId,
        classificationRunId: healthyAuthority.classificationRunId,
      });
      const healthyRun = getRun(healthyAuthority.classificationRunId);
      expect(healthyRun).toMatchObject({
        onboardingItemId: healthy.id,
        productSku: healthy.upc,
      });
      expect(['completed', 'completed_with_abstentions']).toContain(healthyRun?.status);
      expect(healthyAuthority.classificationRunId).not.toBe(peerBeforeRecovery.classificationRunId);

      const healthyReview = validateReviewCompletionGate({
        workspaceId,
        onboardingItemId: healthy.id,
        productSku: healthy.upc,
        activeRunId: healthyAuthority.classificationRunId,
      });
      expect(healthyReview.ok).toBe(true);
      expect(hasUnresolvedPreparationGap(peer.id)).toBe(true);
      expect(validateReviewCompletionGate({
        workspaceId,
        onboardingItemId: peer.id,
        productSku: peer.upc,
        activeRunId: peerBeforeRecovery.classificationRunId,
      }).ok).toBe(false);
      expect(() => markReviewed({ itemId: peer.id, batchId: batch.id, reviewedBy: 't3-test' }))
        .toThrow(/preparation_gap_unresolved/);

      markReviewed({ itemId: healthy.id, batchId: batch.id, reviewedBy: 't3-test' });
      getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(healthy.id);
      const approval = approveAndAdvanceItems({
        itemIds: [healthy.id],
        batchId: batch.id,
        workspaceId,
        approvedBy: 't3-test',
        requestHash: 'a'.repeat(64),
      });
      expect(approval.approved).toEqual([healthy.id]);
      const promotion = await promoteItems(workspaceId, wsPath, batch.id, [healthy.id]);
      expect(promotion.count).toBe(1);
      expect(promotion.failures).toEqual([]);
      expect(promotion.changeSetId).toBeTruthy();
      const drafts = listChangeSetItems(promotion.changeSetId!);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        sku: healthy.upc,
        classificationRunId: healthyAuthority.classificationRunId,
      });

      // Correct only the blocked peer's own manual authority. A fresh claimed
      // worker preparation must resolve its gap without disturbing the
      // healthy item's previously reviewed/drafted evidence or receipt.
      const withdrawn = withdrawManualEvidence({
        workspaceId,
        itemId: peer.id,
        operatorId: 'listing-evidence-test-operator',
      });
      expect(withdrawn.ok).toBe(true);
      const recoveredPeerSeed = seedListingEvidenceItem({
        workspaceId,
        workspacePath: wsPath,
        itemId: peer.id,
        sku: peer.upc,
        description: 'Complete adult dog food with chicken and balanced nutrition.',
        extractionData: {
          title: peer.name,
          brand: 'Acme',
          description: 'Complete adult dog food with chicken and balanced nutrition.',
        },
      });
      const recoveredEvidence = getCurrentItemEvidenceView(workspaceId, peer.id).evidence;
      if (!recoveredEvidence) throw new Error('The recovered peer did not acquire current accepted evidence.');
      expect(recoveredEvidence.id).not.toBe(peerBeforeRecovery.acceptedEvidenceId);
      getDb().query(`UPDATE onboarding_items SET stage = 'prepare_listing', stage_status = 'pending' WHERE id = ?`).run(peer.id);
      const recoveredClaim = worker.claimItems(1).find((item) => item.id === peer.id);
      if (!recoveredClaim) throw new Error('The recovered peer was not claimable for preparation.');
      await worker.processClaimed(recoveredClaim);
      // Curation writes during preparation alter source state: re-derive the
      // snapshot before stamping run currentness.
      refreshItemEvidence(workspaceId, peer.id);
      updateItemCurationData(peer.id, JSON.stringify({
        ...((findItemById(peer.id)?.curationData ?? {}) as Record<string, unknown>),
        suggestedPages: ['QA/test-only dog-food category'],
      }));
      ensureWorkerRunAuthority(peer.id, wsPath);
      expect(getPreparationGap(peer.id)?.status).toBe('resolved');
      expect(validateReviewCompletionGate({
        workspaceId,
        onboardingItemId: peer.id,
        productSku: peer.upc,
        activeRunId: captureOwnItemAuthority(peer.id).classificationRunId,
      }).ok).toBe(true);
      // Replaying preparation against the same recovered snapshot is
      // idempotent for evidence and the resolved gap.
      const resolvedGap = getPreparationGap(peer.id);
      if (!resolvedGap) throw new Error('The recovered peer gap disappeared before retry.');
      getDb().query(`UPDATE onboarding_items SET stage_status = 'pending' WHERE id = ?`).run(peer.id);
      const replayClaim = worker.claimItems(1).find((item) => item.id === peer.id);
      if (!replayClaim) throw new Error('The recovered peer was not reclaimable for an idempotent retry.');
      await worker.processClaimed(replayClaim);
      ensureWorkerRunAuthority(peer.id, wsPath);
      const evidenceAfterReplay = getCurrentItemEvidenceView(workspaceId, peer.id).evidence;
      expect(evidenceAfterReplay).toMatchObject({ id: recoveredEvidence.id, revision: recoveredEvidence.revision });
      expect(getPreparationGap(peer.id)).toMatchObject({
        status: 'resolved',
        correctionRevision: resolvedGap.correctionRevision,
      });
      const recoveredPeerAuthority = captureOwnItemAuthority(peer.id);
      expect(recoveredPeerAuthority.evidenceIds.some((id) => recoveredPeerSeed.evidenceIds.includes(id))).toBe(false);
      expect(recoveredPeerAuthority.proposals.every((proposal) => proposal.productSku === peer.upc)).toBe(true);
      expect(recoveredPeerAuthority.evidenceSkus.every((sku) => sku === peer.upc)).toBe(true);

      // Lose this worker's lease while a claimed preparation is in flight.
      // The replacement owner wins; the stale owner cannot publish curation or
      // replace the current classification run/receipt.
      getDb().query(`UPDATE onboarding_items SET stage_status = 'pending' WHERE id = ?`).run(peer.id);
      const staleClaim = worker.claimItems(1).find((item) => item.id === peer.id);
      if (!staleClaim) throw new Error('The recovered peer was not claimable for the stale-owner check.');
      const curationBeforeStaleOwner = findItemById(peer.id)?.curationData;
      const stalePreparation = worker.processClaimed(staleClaim);
      getDb().query(`UPDATE onboarding_items SET claimed_by = 'replacement-worker' WHERE id = ?`).run(peer.id);
      await stalePreparation;
      expect(findItemById(peer.id)?.curationData).toEqual(curationBeforeStaleOwner);
      expect(findItemById(peer.id)?.claimedBy).toBe('replacement-worker');
      getDb().query(
        `UPDATE onboarding_items
         SET stage_status = 'completed', claimed_by = NULL, claimed_at = NULL
         WHERE id = ?`,
      ).run(peer.id);

      markReviewed({ itemId: peer.id, batchId: batch.id, reviewedBy: 't3-test' });
      getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(peer.id);
      const recoveredApproval = approveAndAdvanceItems({
        itemIds: [peer.id],
        batchId: batch.id,
        workspaceId,
        approvedBy: 't3-test',
        requestHash: 'b'.repeat(64),
      });
      expect(recoveredApproval.approved).toEqual([peer.id]);

      const healthyAfterPeerChanges = captureOwnItemAuthority(healthy.id);
      expect(healthyAfterPeerChanges).toEqual(healthyAuthority);
      expect(healthyAfterPeerChanges.evidenceIds.some((id) => peerSeed.evidenceIds.includes(id))).toBe(false);
      expect(healthyAfterPeerChanges.evidenceIds.some((id) => recoveredPeerSeed.evidenceIds.includes(id))).toBe(false);
      expect(healthyAfterPeerChanges.acceptedFactIds.some((id) => recoveredPeerAuthority.acceptedFactIds.includes(id))).toBe(false);
      expect(healthyAfterPeerChanges.acceptedEvidenceId).not.toBe(recoveredEvidence.id);
      expect(healthyAfterPeerChanges.classificationRunId).not.toBe(recoveredPeerAuthority.classificationRunId);
      expect(healthyAfterPeerChanges.receipt).toMatchObject({
        evidenceId: healthyAfterPeerChanges.acceptedEvidenceId,
        classificationRunId: healthyAfterPeerChanges.classificationRunId,
      });
      worker.stop();
    } finally {
      cleanup();
    }
  });
});
