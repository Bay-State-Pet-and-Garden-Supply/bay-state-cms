/**
 * Epic #46 — onboarding telemetry tests.
 *
 * Seeded temp DB; every describe re-initializes a fresh workspace so global
 * metrics are isolated per describe. Covers: automation completion math,
 * attention rate by reason, review throughput/edit rate, distributor-only
 * completion, official-site requirement, export success (batch + global),
 * cohort Curation success, family wait duration, derivation honesty markers,
 * batch vs global scoping, and the workspace guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { overrideManualEvidenceFlags, resetManualEvidenceFlagsOverride } from '../../onboarding/flags';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources } from '../../db/repositories/onboarding-source-repo';
import {
  markReviewed,
  markApproved,
  markReviewInvalidated,
} from '../../db/repositories/onboarding-review-repo';
import {
  createChangeSet,
  upsertChangeSetItem,
  updateChangeSetStatus,
} from '../../db/repositories/change-set-repo';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { getOnboardingMetrics } from '../../onboarding/onboarding-telemetry';

let workspaceId: string;
let workspacePath: string;

/** Fresh temp workspace (re-inits the shared DB). Call per describe. */
function makeWorkspace() {
  overrideManualEvidenceFlags({ enabled: false });
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-telemetry-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

afterAll(() => {
  resetManualEvidenceFlagsOverride();
});

function makeBatch(): string {
  const batch = createBatch({ workspaceId, name: 'Test Batch', fileName: 'test.csv', totalItems: 0 });
  return batch.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function createItem(
  batchId: string,
  overrides: {
    upc: string;
    name: string;
    stage: string;
    stageStatus: string;
    sourceType?: 'official_page' | 'distributor_record';
    errorMessage?: string | null;
  },
): string {
  const inserted = insertItems(batchId, [{
    upc: overrides.upc,
    name: overrides.name,
    brandHint: 'Blue Buffalo',
    sourceUrl: null,
    rowNumber: 1,
    stage: overrides.stage as any,
    stageStatus: overrides.stageStatus as any,
  }], overrides.stage as any, 1);
  const id = inserted[0].id;
  const db = getDb();
  if (overrides.sourceType === 'distributor_record') {
    db.query("UPDATE onboarding_items SET source_type = 'distributor_record', source_url = NULL WHERE id = ?").run(id);
  }
  if (overrides.errorMessage) {
    db.query('UPDATE onboarding_items SET error_message = ? WHERE id = ?').run(overrides.errorMessage, id);
  }
  return id;
}

/** Insert a candidate source row so discovery/needs_input projects as verify_official_url. */
function addCandidateSource(itemId: string): void {
  insertSources(itemId, [{
    url: 'https://brand.example/p/1',
    title: 'Official page',
    snippet: 'snippet',
    domain: 'brand.example',
    confidence: 0.9,
  }]);
}

/** Insert a durable ready cohort row + optional run rows (raw SQL, deterministic). */
function insertCohortWithRuns(batchId: string, runStatuses: string[], createdHoursAgo: number): string {
  const db = getDb();
  const cohortId = randomUUID();
  const base = nowIso();
  db.query(
    `INSERT INTO curation_cohorts
       (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'product-family-v1', 'mh', 'ready', ?, ?)`,
  ).run(cohortId, workspaceId, batchId, `g-${cohortId.slice(0, 6)}`, 'Blue Buffalo Life Protection', hoursAgoIso(createdHoursAgo), base);
  for (const status of runStatuses) {
    db.query(
      `INSERT INTO classification_cohort_runs
         (id, workspace_id, cohort_id, candidate_membership_hash, evidence_snapshot_hash, status, created_at, completed_at)
       VALUES (?, ?, ?, 'm1', 'e1', ?, ?, ?)`,
    ).run(randomUUID(), workspaceId, cohortId, status, hoursAgoIso(1), nowIso());
  }
  return cohortId;
}

describe('telemetry — automation completion + distributor/official-source split', () => {
  beforeAll(makeWorkspace);

  it('computes automationToReviewRate over active (non-skipped) items', () => {
    const batchId = makeBatch();
    // 2 curation-completed → ready_for_review; 1 promotion-completed → ready_to_export;
    // 1 skipped; 2 extraction-pending → processing.
    createItem(batchId, { upc: 'A1', name: 'X', stage: 'curation', stageStatus: 'completed' });
    createItem(batchId, { upc: 'A2', name: 'X', stage: 'curation', stageStatus: 'completed' });
    createItem(batchId, { upc: 'A3', name: 'X', stage: 'promotion', stageStatus: 'completed' });
    createItem(batchId, { upc: 'A4', name: 'X', stage: 'sourcing', stageStatus: 'skipped' });
    createItem(batchId, { upc: 'A5', name: 'X', stage: 'extraction', stageStatus: 'pending' });
    createItem(batchId, { upc: 'A6', name: 'X', stage: 'extraction', stageStatus: 'pending' });

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.scope).toBe('batch');
    expect(metrics.batchId).toBe(batchId);
    expect(metrics.metrics.automationToReviewRate.value).toBeCloseTo(3 / 5, 5);
    expect(metrics.metrics.automationToReviewRate.derivation).toBe('exact');
    expect(metrics.metrics.productsReadyForReview.value).toBe(2);
  });

  it('distributor-only completions and official-site completions are split honestly', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'D1', name: 'X', stage: 'review', stageStatus: 'completed', sourceType: 'distributor_record' });
    createItem(batchId, { upc: 'D2', name: 'X', stage: 'review', stageStatus: 'completed', sourceType: 'official_page' });
    createItem(batchId, { upc: 'D3', name: 'X', stage: 'extraction', stageStatus: 'pending', sourceType: 'official_page' });

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.distributorRecordShareOfReviewReady.value).toBeCloseTo(0.5, 5);
    expect(metrics.metrics.productsRequiringOfficialSite.value).toBeCloseTo(0.5, 5);
    // Breakdown lists both source categories.
    const breakdown = metrics.metrics.productsRequiringOfficialSite.breakdown ?? [];
    expect(breakdown.find(b => b.key === 'distributor_record')?.value).toBe(1);
    expect(breakdown.find(b => b.key === 'official_page')?.value).toBe(1);
  });
});

describe('telemetry — attention volume, reasons, profile blocks', () => {
  beforeAll(makeWorkspace);

  it('groups attention by reason and computes extractor-profile block rate', () => {
    const batchId = makeBatch();
    createItem(batchId, {
      upc: 'N1', name: 'X', stage: 'extraction', stageStatus: 'failed',
      errorMessage: 'No extractor profile configured for domain',
    });
    createItem(batchId, {
      upc: 'N2', name: 'X', stage: 'extraction', stageStatus: 'failed',
      errorMessage: 'structure mismatch',
    });
    const noCandidate = createItem(batchId, { upc: 'N3', name: 'X', stage: 'discovery', stageStatus: 'needs_input' });
    void noCandidate; // zero candidates → no_official_url
    createItem(batchId, {
      upc: 'N4', name: 'X', stage: 'sourcing', stageStatus: 'needs_input',
      errorMessage: 'Identity conflict detected',
    });

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    const attention = metrics.metrics.attentionVolume;
    expect(attention.value).toBe(4);
    expect(metrics.metrics.attentionRateByReason.value).toBe(4);
    const breakdown = metrics.metrics.attentionRateByReason.breakdown ?? [];
    expect(breakdown.length).toBe(4);
    expect(breakdown.find(b => b.key === 'extractor_profile_required')?.value).toBe(1);
    expect(breakdown.find(b => b.key === 'extraction_profile_failed')?.value).toBe(1);
    expect(breakdown.find(b => b.key === 'no_official_url')?.value).toBe(1);
    expect(breakdown.find(b => b.key === 'source_conflict')?.value).toBe(1);
    // 2 profile-related reasons over 4 attention items.
    expect(metrics.metrics.extractorProfileBlockRate.value).toBeCloseTo(0.5, 5);
  });

  it('reports attention resolution time as not_available (no entry timestamps)', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'R1', name: 'X', stage: 'extraction', stageStatus: 'needs_input' });
    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.attentionResolutionTime.value).toBeNull();
    expect(metrics.metrics.attentionResolutionTime.derivation).toBe('not_available');
  });

  it('resolves a discovery candidate as verify_official_url (candidate present)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R2', name: 'X', stage: 'discovery', stageStatus: 'needs_input' });
    addCandidateSource(id);
    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    const breakdown = metrics.metrics.attentionRateByReason.breakdown ?? [];
    expect(breakdown.find(b => b.key === 'verify_official_url')?.value).toBe(1);
  });

  it('counts domain-release audit ops globally but not per batch', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'N5', name: 'X', stage: 'extraction', stageStatus: 'pending' });
    addAuditLog({
      workspaceId,
      entityType: 'extractor_profile_domain',
      entityId: 'brand.example',
      action: 'domain_release',
      message: 'Released 3 blocked extraction item(s)',
    });
    const batchMetrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(batchMetrics.metrics.extractorProfileDomainUnblockCount.derivation).toBe('not_available');
    const globalMetrics = getOnboardingMetrics({ workspaceId });
    expect(globalMetrics.metrics.extractorProfileDomainUnblockCount.value).toBe(1);
    expect(globalMetrics.metrics.extractorProfileDomainUnblockCount.derivation).toBe('exact');
  });
});

describe('telemetry — review state, edits, approval', () => {
  beforeAll(makeWorkspace);

  it('derives review throughput, edit rate and bulk approval success rate', () => {
    const batchId = makeBatch();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = createItem(batchId, { upc: `V${i}`, name: 'X', stage: 'review', stageStatus: 'completed' });
      markReviewed({ itemId: id, batchId, reviewedBy: 'tester' });
      ids.push(id);
    }
    markApproved({ itemId: ids[0], batchId, approvedBy: 'tester' });
    markApproved({ itemId: ids[1], batchId, approvedBy: 'tester' });
    markReviewInvalidated(ids[2], 'edited during review');

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    const throughput = metrics.metrics.reviewThroughputProductsPerMinute;
    expect(throughput.value).toBeGreaterThan(0);
    // Epic #46 fix 6: the denominator is batch-creation time (includes
    // automation lead time), so the metric is an approximation, not exact.
    expect(throughput.derivation).toBe('approximation');
    expect(throughput.note).toContain('Reviewed 4');
    // 1 of 4 reviews invalidated; 2 of 4 approved.
    expect(metrics.metrics.reviewEditRate.value).toBeCloseTo(0.25, 5);
    // Epic #46 fix 6: the invalidation ratio is CURRENT state (re-review
    // clears the marker), so it is an approximation, not a historical rate.
    expect(metrics.metrics.reviewEditRate.derivation).toBe('approximation');
    expect(metrics.metrics.approvalRate.value).toBeCloseTo(0.5, 5);
    expect(metrics.metrics.approvalRate.derivation).toBe('approximation');
    expect(metrics.metrics.productsReadyForReview.value).toBe(4);
  });

  it('reports approvalRate as not_available when nothing was reviewed', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'V9', name: 'X', stage: 'curation', stageStatus: 'completed' });
    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.reviewEditRate.value).toBe(0);
    // Epic #46 follow-up: with zero reviews the rate is undefined — a 0
    // value read like "approvals failed" (GPT review finding).
    expect(metrics.metrics.approvalRate.value).toBeNull();
    expect(metrics.metrics.approvalRate.derivation).toBe('not_available');
  });
});

describe('telemetry — cohort Curation success + family wait duration', () => {
  beforeAll(makeWorkspace);

  it('computes cohortCurationSuccessRate from terminal run outcomes', () => {
    const batchId = makeBatch();
    insertCohortWithRuns(batchId, ['completed'], 20);
    insertCohortWithRuns(batchId, ['failed'], 20);
    insertCohortWithRuns(batchId, ['freezing'], 20); // non-terminal: excluded

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.cohortCurationSuccessRate.value).toBeCloseTo(0.5, 5);
    expect(metrics.metrics.cohortCurationSuccessRate.derivation).toBe('exact');
    expect(metrics.metrics.cohortCurationSuccessRate.note).toContain('1 success / 1 failed');
  });

  it('estimates family wait duration for cohorts that reached ready', () => {
    const batchId = makeBatch();
    // Cohort created ~2h before ready (updated_at ≈ ready time).
    insertCohortWithRuns(batchId, [], 2);

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    const wait = metrics.metrics.familyWaitDurationHours;
    expect(wait.derivation).toBe('approximation');
    expect(wait.value).not.toBeNull();
    expect(wait.value!).toBeGreaterThan(1.5);
    expect(wait.value!).toBeLessThan(2.5);
  });

  it('reports not_available when no cohort has reached ready', () => {
    const batchId = makeBatch();
    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.familyWaitDurationHours.value).toBeNull();
    expect(metrics.metrics.familyWaitDurationHours.derivation).toBe('not_available');
  });
});

describe('telemetry — export success (batch + global) and scoping', () => {
  beforeAll(makeWorkspace);

  it('batch export success counts pushed vs in-flight promoted SKUs', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'E1', name: 'X', stage: 'promotion', stageStatus: 'completed' });
    createItem(batchId, { upc: 'E2', name: 'X', stage: 'promotion', stageStatus: 'completed' });
    const cs = createChangeSet({ workspaceId, title: 'Aug', baseCommit: 'abc123' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'E1', operation: 'upsert', draftJson: '{}', baseJson: null, draftHash: 'h1' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'E2', operation: 'upsert', draftJson: '{}', baseJson: null, draftHash: 'h2' });
    updateChangeSetStatus(cs.id, 'pushed');

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.exportSuccessRate.value).toBeCloseTo(1, 5);
    expect(metrics.metrics.exportSuccessRate.derivation).toBe('exact');
  });

  it('global export success counts workspace change sets; batch metric only covers promoted batches', () => {
    // One pushed change set from the previous test + one draft from this batch.
    const cs = createChangeSet({ workspaceId, title: 'Sep', baseCommit: 'def456' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'E9', operation: 'upsert', draftJson: '{}', baseJson: null, draftHash: 'h9' });

    const global = getOnboardingMetrics({ workspaceId });
    // Previous test pushed 1 change set; this one is still draft → 1/2.
    expect(global.metrics.exportSuccessRate.value).toBeCloseTo(0.5, 5);
    expect(global.metrics.exportSuccessRate.derivation).toBe('exact');
  });
});

describe('telemetry — batch vs global scoping on a fresh workspace', () => {
  beforeAll(makeWorkspace);

  it('batch and global scopes use the right population', () => {
    const batch1 = makeBatch();
    createItem(batch1, { upc: 'G1', name: 'X', stage: 'curation', stageStatus: 'completed' });
    createItem(batch1, { upc: 'G2', name: 'X', stage: 'extraction', stageStatus: 'pending' });

    const batch2 = makeBatch();
    createItem(batch2, { upc: 'G3', name: 'X', stage: 'curation', stageStatus: 'completed' });

    const b1 = getOnboardingMetrics({ workspaceId, batchId: batch1 });
    const b2 = getOnboardingMetrics({ workspaceId, batchId: batch2 });
    const global = getOnboardingMetrics({ workspaceId });

    expect(b1.metrics.automationToReviewRate.value).toBeCloseTo(1 / 2, 5);
    expect(b2.metrics.automationToReviewRate.value).toBeCloseTo(1, 5);
    expect(global.scope).toBe('global');
    expect(global.batchId).toBeNull();
    expect(global.metrics.automationToReviewRate.value).toBeCloseTo(2 / 3, 5);
  });

  it('workspace guard: cross-workspace batchId fails closed', () => {
    const otherWorkspaceId = randomUUID();
    const otherPath = path.join(os.tmpdir(), `baystate-cms-telemetry-other-${otherWorkspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(otherPath, '.baystate-cms'), { recursive: true });
    // Second workspace on the SAME database (shared singleton).
    insertWorkspace({
      id: otherWorkspaceId,
      name: 'other',
      workspacePath: otherPath,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const otherBatch = createBatch({
      workspaceId: otherWorkspaceId,
      name: 'Other Batch',
      fileName: 'x.csv',
      totalItems: 0,
    });

    expect(() => getOnboardingMetrics({ workspaceId, batchId: otherBatch.id })).toThrow(/not found in workspace/);
  });
});

describe('telemetry — empty states and derivation markers', () => {
  beforeAll(makeWorkspace);

  it('global scope with zero batches: throughput/flags are not_available', () => {
    const metrics = getOnboardingMetrics({ workspaceId });
    expect(metrics.metrics.reviewThroughputProductsPerMinute.value).toBeNull();
    expect(metrics.metrics.reviewThroughputProductsPerMinute.derivation).toBe('not_available');
    expect(metrics.metrics.familyWaitDurationHours.derivation).toBe('not_available');
  });

  it('empty batch yields zero honest metrics and null unavailable ones', () => {
    const batchId = makeBatch();
    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.automationToReviewRate.value).toBe(0);
    expect(metrics.metrics.automationToReviewRate.note).toContain('No active items');
    expect(metrics.metrics.attentionVolume.value).toBe(0);
    expect(metrics.metrics.exportSuccessRate.value).toBeNull();
    expect(metrics.metrics.exportSuccessRate.derivation).toBe('not_available');
    expect(metrics.metrics.cohortCurationSuccessRate.value).toBeNull();
    // An empty batch still has a start time: 0 products/min, but the metric
    // is an APPROXIMATION (epic #46 fix 6) — the window is batch-creation
    // based and includes automation lead time, so it is a floor, never exact.
    expect(metrics.metrics.reviewThroughputProductsPerMinute.value).toBe(0);
    expect(metrics.metrics.reviewThroughputProductsPerMinute.derivation).toBe('approximation');
  });

  it('honesty markers: review throughput + edit rate are approximations, domain unblock is operations (epic #46 fix 6)', () => {
    const batchId = makeBatch();
    const id1 = createItem(batchId, { upc: 'M1', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id1, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id1, batchId, approvedBy: 'manager' });
    addAuditLog({
      workspaceId,
      entityType: 'onboarding_batch',
      entityId: batchId,
      action: 'domain_release',
      message: 'release',
      detailsJson: '{}',
    });

    const metrics = getOnboardingMetrics({ workspaceId, batchId });
    expect(metrics.metrics.reviewThroughputProductsPerMinute.derivation).toBe('approximation');
    expect(metrics.metrics.reviewThroughputProductsPerMinute.note).toMatch(/floor/);
    expect(metrics.metrics.reviewEditRate.derivation).toBe('approximation');

    const globalMetrics = getOnboardingMetrics({ workspaceId });
    expect(globalMetrics.metrics.extractorProfileDomainUnblockCount.unit).toBe('operations');
  });
});