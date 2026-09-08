import { describe, test, expect, beforeEach } from 'bun:test';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
  completeSourcingWithDecision,
  completeSourcingViaProjection,
  advanceItemsToNextStage,
} from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  insertEvidenceAttempt,
  startSourcingGeneration,
  supersedeCurrentSourcingGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import {
  insertConflictWithCandidates,
  listConflictsForItem,
  resolveConflict,
  hasUnresolvedHardConflicts,
} from '../../db/repositories/onboarding-conflict-repo';
import { createConnection } from '../../db/repositories/distributor-repo';
import { getAcceptedAttemptIdsForItem } from '../../db/repositories/onboarding-acceptance-repo';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';

describe('Conflict Resolution & Multi-Conflict Stage Isolation Tests', () => {
  const connectionCache = new Map<string, string>();
  beforeEach(() => {
    connectionCache.clear();
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: 'w1',
      name: 'Test Workspace',
      workspacePath: '/tmp/test-ws',
      gitPath: '/tmp/test-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  function makeItemWithConflicts() {
    const batch = createBatch({ workspaceId: 'w1', name: 'B1', fileName: 'b1.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678901', name: 'Multi Conflict Product', rowNumber: 1, stage: 'sourcing' },
    ]);

    // Put item in needs_input stage status
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const att1 = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'p1',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ brand: 'Brand A', weight: '10 lbs' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
    });

    const att2 = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'p2',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.85,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ brand: 'Brand B', weight: '20 lbs' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
    });

    // Create 2 hard conflicts: one on 'brand', one on 'weight'
    const brandConflict = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"Brand A"' },
      { evidenceAttemptId: att2.id, valueJson: '"Brand B"' },
    ]);

    const weightConflict = insertConflictWithCandidates(item.id, 'weight', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"10 lbs"' },
      { evidenceAttemptId: att2.id, valueJson: '"20 lbs"' },
    ]);

    return { item, att1, att2, brandConflict, weightConflict };
  }

  test('resolving 1 of 2 hard conflicts does NOT advance stage while other hard conflict remains open', () => {
    const { item, att1, brandConflict, weightConflict } = makeItemWithConflicts();

    const initialConflicts = listConflictsForItem(item.id);
    expect(initialConflicts.length).toBe(2);

    // Resolve ONLY brand conflict
    resolveConflict(brandConflict.id, {
      action: 'resolve_candidate',
      candidateId: brandConflict.candidates[0].id,
    });

    // Verify brand conflict is resolved
    const brandUpdated = listConflictsForItem(item.id).find((c) => c.id === brandConflict.id);
    expect(brandUpdated?.status).toBe('resolved');

    // CRITICAL MULTI-CONFLICT ISOLATION GUARDRAIL:
    // Item stageStatus MUST REMAIN 'needs_input' because weight conflict is still open!
    const itemAfterFirstResolution = findItemById(item.id);
    expect(itemAfterFirstResolution?.stage).toBe('sourcing');
    expect(itemAfterFirstResolution?.stageStatus).toBe('needs_input');

    // Now resolve the remaining weight conflict
    resolveConflict(weightConflict.id, {
      action: 'resolve_candidate',
      candidateId: weightConflict.candidates[0].id,
    });

    // ADR 0014: the LAST resolution completes Sourcing with an
    // `evidence_to_discovery` operator-override decision and lands in
    // discovery/pending — it NEVER targets Curation.
    const itemAfterSecondResolution = findItemById(item.id);
    expect(itemAfterSecondResolution?.stage).toBe('discovery');
    expect(itemAfterSecondResolution?.stageStatus).toBe('pending');
    expect(itemAfterSecondResolution?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(itemAfterSecondResolution?.sourcingDecision?.origin).toBe('operator_override');

    // Verify accepted evidence was recorded
    const acceptedIds = getAcceptedAttemptIdsForItem(item.id);
    expect(acceptedIds).toContain(att1.id);
  });

  test('generic advance endpoint never advances an item with open hard conflicts', () => {
    const { item, brandConflict, weightConflict } = makeItemWithConflicts();

    // Even if the item were marked completed, open hard conflicts block the
    // generic advancement path (ADR 0014).
    updateItemStageStatus(item.id, 'completed', null);
    const res = advanceItemsToNextStage([item.id]);
    expect(res.advanced).toBe(0);
    expect(res.skipped).toBe(1);
    expect(findItemById(item.id)?.stage).toBe('sourcing');

    // Back to needs_input: resolving BOTH conflicts completes via the
    // guarded transition and lands in discovery/pending.
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');
    resolveConflict(brandConflict.id, { action: 'dismiss' });
    resolveConflict(weightConflict.id, { action: 'dismiss' });
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
  });

  test('completeSourcingWithDecision route/target matrix is closed and Curation-unreachable', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B2', fileName: 'b2.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678902', name: 'Matrix', rowNumber: 1, stage: 'sourcing' },
    ]);
    const now = new Date().toISOString();

    // bundle_to_curation is prohibited outright.
    expect(
      completeSourcingWithDecision(
        item.id,
        { route: 'bundle_to_curation', origin: 'operator_override', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: now },
        'route_sources',
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('prohibited') });

    // Route/target mismatch fails closed.
    expect(
      completeSourcingWithDecision(
        item.id,
        { route: 'evidence_to_discovery', origin: 'automatic_policy', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: now },
        'route_sources',
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('targets find_product_page') });

    // needs_input_conflict requires the item to be needs_input.
    expect(
      completeSourcingWithDecision(
        item.id,
        { route: 'needs_input_conflict', origin: 'automatic_policy', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: now },
        'route_sources',
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('needs_input') });

    // evidence_to_discovery lands in find_product_page/pending (stored v1
    // spelling on v1 storage).
    expect(
      completeSourcingWithDecision(
        item.id,
        { route: 'evidence_to_discovery', origin: 'automatic_policy', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: now },
        'find_product_page',
      ),
    ).toEqual({ ok: true });
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');

    // A non-route_sources row can never be completed through the helper.
    expect(
      completeSourcingWithDecision(
        item.id,
        { route: 'fallback_to_discovery', origin: 'operator_override', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: now },
        'find_product_page',
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('not_eligible') });
  });

  test('conflict insert is idempotent per (item, field, generation) and rejects differing sets', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B3', fileName: 'b3.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678903', name: 'Idem', rowNumber: 1, stage: 'sourcing' },
    ]);
    const gen = startSourcingGeneration(item.id);
    const att1 = insertEvidenceAttempt({
      itemId: item.id, providerId: 'p1', lookupUpc: item.upc, outcome: 'found', confidence: 0.9,
      evidenceUrl: null, matchedFields: ['upc'], identityJson: null, warningsJson: null,
      errorCode: null, errorMessage: null, sourcingGenerationId: gen.id,
    });
    const att2 = insertEvidenceAttempt({
      itemId: item.id, providerId: 'p2', lookupUpc: item.upc, outcome: 'found', confidence: 0.8,
      evidenceUrl: null, matchedFields: ['upc'], identityJson: null, warningsJson: null,
      errorCode: null, errorMessage: null, sourcingGenerationId: gen.id,
    });

    const first = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"A"' },
      { evidenceAttemptId: att2.id, valueJson: '"B"' },
    ], gen.id);

    // Identical candidate set → returns the SAME conflict (worker retry-safe).
    const second = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"A"' },
      { evidenceAttemptId: att2.id, valueJson: '"B"' },
    ], gen.id);
    expect(second.id).toBe(first.id);

    // Different candidate set for the same open field/generation → throws.
    expect(() =>
      insertConflictWithCandidates(item.id, 'brand', 'hard', [
        { evidenceAttemptId: att1.id, valueJson: '"A"' },
        { evidenceAttemptId: att2.id, valueJson: '"C"' },
      ], gen.id),
    ).toThrow(/different candidate set/);

    // A superseded generation starts fresh conflicts.
    const gen2 = supersedeCurrentSourcingGeneration(item.id);
    const third = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"A"' },
      { evidenceAttemptId: att2.id, valueJson: '"C"' },
    ], gen2.id);
    expect(third.id).not.toBe(first.id);
  });

  test('a legacy NULL-generation conflict is audit-only once a current generation exists (no deadlock)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-LEG', fileName: 'bleg.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678907', name: 'Legacy', rowNumber: 1, stage: 'sourcing' },
    ]);
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    // Legacy conflict: created with NO generation (pre-generation artifact).
    const legacyAttempt = insertEvidenceAttempt({
      itemId: item.id, providerId: 'p1', lookupUpc: item.upc, outcome: 'found', confidence: 0.9,
      evidenceUrl: null, matchedFields: ['upc'], identityJson: JSON.stringify({ brand: 'A' }),
      warningsJson: null, errorCode: null, errorMessage: null,
    });
    const legacy = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: legacyAttempt.id, valueJson: '"A"' },
    ]);
    expect(legacy.sourcingGenerationId).toBeNull();

    // With NO generation yet, the legacy conflict is the operative conflict
    // (and IS resolvable in that state — resolveConflict allows it).
    expect(hasUnresolvedHardConflicts(item.id)).toBe(true);

    // Once a current generation exists, the legacy conflict is audit-only:
    // it never blocks routing/finalization (ADR 0014 generation authority), so
    // it cannot deadlock against resolveConflict's refusal to touch it.
    const gen = startSourcingGeneration(item.id);
    expect(hasUnresolvedHardConflicts(item.id)).toBe(false);
    expect(() => resolveConflict(legacy.id, { action: 'dismiss' })).toThrow(/legacy conflict and the item now has a sourcing generation/);

    // Finalization proceeds under the current generation (no hard conflicts).
    const ok = completeSourcingWithDecision(
      item.id,
      { route: 'evidence_to_discovery', origin: 'automatic_policy', acceptedEvidenceAttemptIds: [], providerIds: ['p1'], conflicts: [], warnings: [], decidedAt: new Date().toISOString() },
      'find_product_page',
    );
    expect(ok).toEqual({ ok: true });
    expect(findItemById(item.id)?.stage).toBe('discovery');
  });

  test('resolveConflict rejects stale generations and already-resolved races', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B4', fileName: 'b4.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678904', name: 'Stale', rowNumber: 1, stage: 'sourcing' },
    ]);
    updateItemStageStatus(item.id, 'needs_input', 'conflict');

    const gen1 = startSourcingGeneration(item.id);
    const att1 = insertEvidenceAttempt({
      itemId: item.id, providerId: 'p1', lookupUpc: item.upc, outcome: 'found', confidence: 0.9,
      evidenceUrl: null, matchedFields: ['upc'], identityJson: null, warningsJson: null,
      errorCode: null, errorMessage: null, sourcingGenerationId: gen1.id,
    });
    const conflict = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"A"' },
    ], gen1.id);

    // Retry supersedes the generation → the conflict is no longer resolvable.
    supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    expect(() => resolveConflict(conflict.id, { action: 'dismiss' })).toThrow(/current sourcing generation/);

    // A resolved conflict cannot be resolved twice.
    const gen3 = startSourcingGeneration(item.id);
    const att2 = insertEvidenceAttempt({
      itemId: item.id, providerId: 'p2', lookupUpc: item.upc, outcome: 'found', confidence: 0.9,
      evidenceUrl: null, matchedFields: ['upc'], identityJson: null, warningsJson: null,
      errorCode: null, errorMessage: null, sourcingGenerationId: gen3.id,
    });
    const conflict2 = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att2.id, valueJson: '"B"' },
    ], gen3.id);
    resolveConflict(conflict2.id, { action: 'dismiss' });
    expect(() => resolveConflict(conflict2.id, { action: 'dismiss' })).toThrow(/already resolved/);
    expect(hasUnresolvedHardConflicts(item.id)).toBe(false);
  });

  /** Fully-provenanced found attempt (observation floor for qualification). */
  function ensureConnection(providerId: string): string {
    const cached = connectionCache.get(providerId);
    if (cached) return cached;
    const conn = createConnection({
      workspaceId: 'w1',
      distributorId: providerId,
      connectorType: 'api',
    });
    connectionCache.set(providerId, conn.id);
    return conn.id;
  }
  function madeFound(
    itemId: string,
    providerId: string,
    generationId: string,
    identity: Record<string, unknown>,
  ) {
    return insertEvidenceAttempt({
      itemId,
      providerId,
      distributorConnectionId: ensureConnection(providerId),
      lookupUpc: '012345678901',
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify(identity),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: generationId,
    });
  }

  test('final conflict resolution reruns the projection: qualified candidate resolution routes to Extraction (marker-v1)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-EX1', fileName: 'bex1.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id);
    const att1 = madeFound(item.id, 'phillips', gen.id, { upc: '012345678901', name: 'Dog Food', attributes: { flavor: 'chicken' } });
    const att2 = madeFound(item.id, 'bci', gen.id, { upc: '012345678901', name: 'Dog Food', attributes: { flavor: 'beef' } });
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const conflict = insertConflictWithCandidates(item.id, 'flavor', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"chicken"' },
      { evidenceAttemptId: att2.id, valueJson: '"beef"' },
    ], gen.id);

    // Resolving the LAST hard conflict completes Sourcing through the
    // canonical projection: qualified → Extraction (marker-v1).
    resolveConflict(conflict.id, {
      action: 'resolve_candidate',
      candidateId: conflict.candidates[0].id,
    });

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(after?.sourcingDecision?.origin).toBe('operator_override');
    expect(after?.sourcingDecision?.acceptedEvidenceAttemptIds).toContain(att1.id);
    // Evidence hash travels with the V2 decision (materialization authority).
    const decision = after?.sourcingDecision;
    expect(decision && 'evidenceHash' in decision ? decision.evidenceHash : null).toMatch(/^[0-9a-f]{64}$/);
    // Atomic distributor-record binding: source type set, source_url stays null.
    expect(after?.sourceType).toBe('distributor_record');
    expect(after?.sourceUrl).toBeNull();
  });

  test('custom_value + candidate resolution recomputes the projection and routes a qualified bundle to Extraction', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-EX2', fileName: 'bex2.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id);
    const att1 = madeFound(item.id, 'phillips', gen.id, { upc: '012345678901', name: 'Dog Food', weight: '10 lb', brand: 'Acme' });
    const att2 = madeFound(item.id, 'bci', gen.id, { upc: '012345678901', name: 'Dog Food', weight: '20 lb', brand: 'Beta' });
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const weightConflict = insertConflictWithCandidates(item.id, 'weight', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"10 lb"' },
      { evidenceAttemptId: att2.id, valueJson: '"20 lb"' },
    ], gen.id);
    const brandConflict = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"Acme"' },
      { evidenceAttemptId: att2.id, valueJson: '"Beta"' },
    ], gen.id);

    // Brand resolved via candidate (records an acceptance → provenance for the
    // projection); weight resolved via the operator's reviewed custom value.
    resolveConflict(brandConflict.id, {
      action: 'resolve_candidate',
      candidateId: brandConflict.candidates[0].id,
    });
    resolveConflict(weightConflict.id, { action: 'custom_value', customValue: '15 lb' });

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(after?.sourcingDecision?.acceptedEvidenceAttemptIds).toContain(att1.id);
    const decision2 = after?.sourcingDecision;
    expect(decision2 && 'evidenceHash' in decision2 ? decision2.evidenceHash : null).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a custom_value-only resolution without any accepted attempt stays insufficient (Discovery, never Extraction)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-EX2B', fileName: 'bex2b.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id);
    const att1 = madeFound(item.id, 'phillips', gen.id, { upc: '012345678901', name: 'Dog Food', weight: '10 lb' });
    const att2 = madeFound(item.id, 'bci', gen.id, { upc: '012345678901', name: 'Dog Food', weight: '20 lb' });
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const conflict = insertConflictWithCandidates(item.id, 'weight', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"10 lb"' },
      { evidenceAttemptId: att2.id, valueJson: '"20 lb"' },
    ], gen.id);

    // Only a custom value: no attempt is ever accepted, so the projection has
    // zero provenance and cannot qualify (fail closed — never a fabricated
    // distributor record).
    resolveConflict(conflict.id, { action: 'custom_value', customValue: '15 lb' });

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(after?.sourceType).toBe('official_page');
  });

  test('final resolution with insufficient evidence (missing name) routes to Discovery, never Curation', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-DISC', fileName: 'bdisc.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id);
    // Identity records carry NO name → the qualification floor (nonblank name)
    // is unmet even after resolving the brand conflict.
    const att1 = madeFound(item.id, 'phillips', gen.id, { upc: '012345678901', brand: 'Acme' });
    const att2 = madeFound(item.id, 'bci', gen.id, { upc: '012345678901', brand: 'Beta' });
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const conflict = insertConflictWithCandidates(item.id, 'brand', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"Acme"' },
      { evidenceAttemptId: att2.id, valueJson: '"Beta"' },
    ], gen.id);

    resolveConflict(conflict.id, { action: 'dismiss' });

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(after?.sourceType).toBe('official_page');
  });

  test('marker-v0 items never route to Extraction through final resolution (legacy Continue-to-Discovery)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-V0', fileName: 'bv0.csv', totalItems: 1 });
    // Omitted entry-policy version → marker-v0 (legacy cohort).
    const [item] = insertItems(batch.id, [
      { upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' },
    ]);
    const gen = startSourcingGeneration(item.id);
    const att1 = madeFound(item.id, 'phillips', gen.id, { upc: '012345678901', name: 'Dog Food', attributes: { flavor: 'chicken' } });
    const att2 = madeFound(item.id, 'bci', gen.id, { upc: '012345678901', name: 'Dog Food', attributes: { flavor: 'beef' } });
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const conflict = insertConflictWithCandidates(item.id, 'flavor', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"chicken"' },
      { evidenceAttemptId: att2.id, valueJson: '"beef"' },
    ], gen.id);

    resolveConflict(conflict.id, {
      action: 'resolve_candidate',
      candidateId: conflict.candidates[0].id,
    });

    // Even though the evidence WOULD qualify, marker-v0 never targets
    // Extraction — the legacy cohort is operator-controlled Discovery.
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(after?.sourceType).toBe('official_page');
  });

  test('cross-item candidate resolution fails closed (acceptance ownership)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-XITEM', fileName: 'bxitem.csv', totalItems: 2 });
    const [itemA, itemB] = insertItems(
      batch.id,
      [
        { upc: '012345678901', name: 'Item A', rowNumber: 1, stage: 'sourcing' },
        { upc: '012345678901', name: 'Item B', rowNumber: 2, stage: 'sourcing' },
      ],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const genB = startSourcingGeneration(itemB.id);
    const foreign = madeFound(itemB.id, 'phillips', genB.id, { upc: '012345678901', name: 'Item B', attributes: { flavor: 'chicken' } });
    updateItemStageStatus(itemA.id, 'needs_input', 'Identity conflict detected');

    // A conflict on item A whose candidate references item B's attempt is
    // fabricated (the writer stores candidates without ownership validation)
    // and must fail closed at resolution time (recordAcceptances ownership).
    const conflict = insertConflictWithCandidates(itemA.id, 'flavor', 'hard', [
      { evidenceAttemptId: foreign.id, valueJson: '"chicken"' },
    ]);
    expect(() =>
      resolveConflict(conflict.id, {
        action: 'resolve_candidate',
        candidateId: conflict.candidates[0].id,
      }),
    ).toThrow(/Cannot accept evidence attempt/);
    expect(findItemById(itemA.id)?.stage).toBe('sourcing');
  });

  test('completeSourcingViaProjection requires needs_input and fails closed otherwise', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-GUARD', fileName: 'bguard.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    // Item is sourcing/pending (not needs_input): the manual completion
    // authority refuses.
    const res = completeSourcingViaProjection(item.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('needs_input');
    expect(findItemById(item.id)?.stage).toBe('sourcing');
  });
});
