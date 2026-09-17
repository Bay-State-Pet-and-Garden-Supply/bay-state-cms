/**
 * Milestone 3 (P1-E) — Bounded work-state bulk repository.
 *
 * All work-state derivation queries are batched per batch (O(1) statements)
 * regardless of item count. No per-item N+1 fan-out. Each method is
 * workspace-agnostic and fail-closed (returns empty map on DB error or corrupt
 * rows, never throws into the projection).
 *
 * This module is the ONLY place work-state code may issue direct SQL for the
 * tables it owns; `src/onboarding/onboarding-work-state.ts` must not call
 * `getDb()` at all.
 */
import { getDb } from '../connection';
import type { WorkStateProjectionHealthIssue } from '../../shared/schemas/onboarding-work-state';

export class WorkStateProjectionError extends Error {
  constructor(public source: string, public code: string, message?: string) {
    super(message ?? `${source}:${code}`);
    this.name = 'WorkStateProjectionError';
  }
}

export type BulkResult<T> = { data: Map<string, T>; issue: WorkStateProjectionHealthIssue | null };
export type BulkCountResult = { data: Map<string, number>; issue: WorkStateProjectionHealthIssue | null };
export type BulkStageResult = { data: Map<string, BulkStageRow[]>; issue: WorkStateProjectionHealthIssue | null };

// ─── Bulk variant resolutions ───────────────────────────────────────────────

export interface BulkVariantResolution {
  id: string;
  status: string;
  candidates: unknown[];
  identityMatrixHash: string;
  platform: string;
}

/**
 * Bulk load current (non-superseded) variant resolutions for a set of itemIds.
 * Single SELECT ... WHERE onboarding_item_id IN (...) AND superseded_at IS NULL.
 */
export function bulkLoadVariantResolutions(
  itemIds: string[],
): Map<string, BulkVariantResolution> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(',');
  let rows: Array<{
    id: string;
    onboarding_item_id: string;
    status: string;
    candidates_json: string;
    identity_matrix_hash: string;
    platform: string;
  }>;
  try {
    rows = db
      .query(
        `SELECT id, onboarding_item_id, status, candidates_json, identity_matrix_hash, platform
         FROM onboarding_variant_resolutions
         WHERE onboarding_item_id IN (${placeholders}) AND superseded_at IS NULL`,
      )
      .all(...itemIds) as any;
  } catch (e) {
    throw new WorkStateProjectionError('onboarding_variant_resolutions', 'variant_resolution_failed', String(e));
  }
  const map = new Map<string, BulkVariantResolution>();
  for (const r of rows) {
    let candidates: unknown[] = [];
    try {
      candidates = JSON.parse(r.candidates_json);
    } catch {
      candidates = [];
    }
    map.set(r.onboarding_item_id, {
      id: r.id,
      status: r.status,
      candidates,
      identityMatrixHash: r.identity_matrix_hash,
      platform: r.platform,
    });
  }
  return map;
}

export function bulkLoadVariantResolutionsWithHealth(
  itemIds: string[],
): BulkResult<BulkVariantResolution> {
  if (itemIds.length === 0) return { data: new Map(), issue: null };
  try {
    return { data: bulkLoadVariantResolutions(itemIds), issue: null };
  } catch (e) {
    const err = e as WorkStateProjectionError;
    return {
      data: new Map(),
      issue: { source: err.source ?? 'onboarding_variant_resolutions', code: err.code ?? 'variant_resolution_failed', affectedCount: itemIds.length },
    };
  }
}

// ─── Bulk variant-identity dispositions (issue #220) ────────────────────────

export interface BulkVariantDisposition {
  disposition: string;
  reason: string | null;
  markedBy: string | null;
  updatedAt: string;
}

/**
 * Bulk load explicit unresolved variant-identity dispositions for a set of
 * item ids. Display-only projection read (the release hold re-reads the
 * single-item repo inside its own fail-closed try) — one statement per
 * call, chunked past SQLite's variable limit. Missing table (predates the
 * migration on old fixtures) degrades to empty, never throws into the
 * projection; the WithHealth wrapper reports it.
 */
export function bulkLoadVariantDispositions(
  itemIds: string[],
): Map<string, BulkVariantDisposition> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  const db = getDb();
  const map = new Map<string, BulkVariantDisposition>();
  const CHUNK = 900;
  try {
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const chunk = itemIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .query(
          `SELECT item_id as itemId, disposition, reason, marked_by as markedBy, updated_at as updatedAt
           FROM onboarding_variant_identity_dispositions WHERE item_id IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ itemId: string; disposition: string; reason: string | null; markedBy: string | null; updatedAt: string }>;
      for (const r of rows) {
        map.set(r.itemId, { disposition: r.disposition, reason: r.reason, markedBy: r.markedBy, updatedAt: r.updatedAt });
      }
    }
    return map;
  } catch (e) {
    throw new WorkStateProjectionError('onboarding_variant_identity_dispositions', 'variant_disposition_failed', String(e));
  }
}

export function bulkLoadVariantDispositionsWithHealth(
  itemIds: string[],
): BulkResult<BulkVariantDisposition> {
  if (itemIds.length === 0) return { data: new Map(), issue: null };
  try {
    return { data: bulkLoadVariantDispositions(itemIds), issue: null };
  } catch (e) {
    const err = e as WorkStateProjectionError;
    return {
      data: new Map(),
      issue: { source: err.source ?? 'onboarding_variant_identity_dispositions', code: err.code ?? 'variant_disposition_failed', affectedCount: itemIds.length },
    };
  }
}

// ─── Bulk discovery candidate counts ─────────────────────────────────────────

export function bulkCountDiscoveryCandidates(
  itemIds: string[],
): Map<string, number> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(',');
  let rows: Array<{ item_id: string; cnt: number }>;
  try {
    rows = db
      .query(
        `SELECT item_id, COUNT(*) as cnt FROM onboarding_sources WHERE item_id IN (${placeholders}) GROUP BY item_id`,
      )
      .all(...itemIds) as any;
  } catch (e) {
    throw new WorkStateProjectionError('onboarding_sources', 'candidate_count_failed', String(e));
  }
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.item_id, Number(r.cnt));
  }
  for (const id of itemIds) {
    if (!map.has(id)) map.set(id, 0);
  }
  return map;
}

export function bulkCountDiscoveryCandidatesWithHealth(itemIds: string[]): BulkCountResult {
  if (itemIds.length === 0) return { data: new Map(), issue: null };
  try {
    return { data: bulkCountDiscoveryCandidates(itemIds), issue: null };
  } catch (e) {
    const err = e as WorkStateProjectionError;
    return {
      data: new Map(itemIds.map(id => [id, 0])),
      issue: { source: err.source ?? 'onboarding_sources', code: err.code ?? 'candidate_count_failed', affectedCount: itemIds.length },
    };
  }
}

// ─── Bulk cohort run statuses (freezing / running) ──────────────────────────

export function bulkGetCohortRunStatusByItem(
  itemIds: string[],
): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(',');
  let rows: Array<{ item_id: string; status: string }>;
  try {
    rows = db
      .query(
        `SELECT ccm.onboarding_item_id as item_id, ccr.status as status
         FROM classification_cohort_runs ccr
         JOIN curation_cohort_members ccm ON ccm.cohort_id = ccr.cohort_id
         WHERE ccm.onboarding_item_id IN (${placeholders}) AND ccr.status IN ('freezing','running')`,
      )
      .all(...itemIds) as any;
  } catch (e) {
    throw new WorkStateProjectionError('classification_cohort_runs', 'cohort_run_failed', String(e));
  }
  const map = new Map<string, string>();
  for (const r of rows) {
    if (!map.has(r.item_id) || r.status === 'freezing') {
      map.set(r.item_id, r.status);
    }
  }
  return map;
}

export function bulkGetCohortRunStatusByItemWithHealth(itemIds: string[]): BulkResult<string> {
  if (itemIds.length === 0) return { data: new Map(), issue: null };
  try {
    return { data: bulkGetCohortRunStatusByItem(itemIds), issue: null };
  } catch (e) {
    const err = e as WorkStateProjectionError;
    return { data: new Map(), issue: { source: err.source ?? 'classification_cohort_runs', code: err.code ?? 'cohort_run_failed', affectedCount: itemIds.length } };
  }
}

// ─── Bulk latest classification run ids ─────────────────────────────────────

/**
 * Bulk fetch latest classification run id per item (by started_at DESC).
 * Single query fetches all runs for itemIds ordered desc, then dedupes to first per item.
 */
export function bulkGetLatestClassificationRunIdByItem(
  itemIds: string[],
): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(',');
  let rows: Array<{ id: string; onboarding_item_id: string; started_at: string }>;
  try {
    rows = db
      .query(
        `SELECT id, onboarding_item_id, started_at FROM classification_runs WHERE onboarding_item_id IN (${placeholders}) ORDER BY onboarding_item_id, started_at DESC`,
      )
      .all(...itemIds) as any;
  } catch (e) {
    throw new WorkStateProjectionError('classification_runs', 'latest_run_failed', String(e));
  }
  const map = new Map<string, string>();
  for (const r of rows) {
    if (!map.has(r.onboarding_item_id)) {
      map.set(r.onboarding_item_id, r.id);
    }
  }
  return map;
}

export function bulkGetLatestClassificationRunIdByItemWithHealth(itemIds: string[]): BulkResult<string> {
  if (itemIds.length === 0) return { data: new Map(), issue: null };
  try {
    return { data: bulkGetLatestClassificationRunIdByItem(itemIds), issue: null };
  } catch (e) {
    const err = e as WorkStateProjectionError;
    return { data: new Map(), issue: { source: err.source ?? 'classification_runs', code: err.code ?? 'latest_run_failed', affectedCount: itemIds.length } };
  }
}

// ─── Bulk classification stage results ───────────────────────────────────────

export interface BulkStageRow {
  stage_name: string;
  status: string;
}

export function bulkGetClassificationStageResults(
  runIds: string[],
): Map<string, BulkStageRow[]> {
  if (runIds.length === 0) return new Map();
  _incrementQueryCount();
  const db = getDb();
  const CHUNK = 900;
  const map = new Map<string, BulkStageRow[]>();
  try {
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const chunk = runIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .query(
          `SELECT run_id, stage_name, status FROM classification_stage_results WHERE run_id IN (${placeholders}) ORDER BY run_id, started_at ASC`,
        )
        .all(...chunk) as Array<{ run_id: string; stage_name: string; status: string }>;
      for (const r of rows) {
        const list = map.get(r.run_id) ?? [];
        list.push({ stage_name: r.stage_name, status: r.status });
        map.set(r.run_id, list);
      }
    }
    return map;
  } catch (e) {
    throw new WorkStateProjectionError('classification_stage_results', 'stage_results_failed', String(e));
  }
}

export function bulkGetClassificationStageResultsWithHealth(runIds: string[]): BulkStageResult {
  if (runIds.length === 0) return { data: new Map(), issue: null };
  try {
    return { data: bulkGetClassificationStageResults(runIds), issue: null };
  } catch (e) {
    const err = e as WorkStateProjectionError;
    return { data: new Map(), issue: { source: err.source ?? 'classification_stage_results', code: err.code ?? 'stage_results_failed', affectedCount: runIds.length } };
  }
}

// ─── Combined bulk context loader (query budget) ─────────────────────────────

/**
 * Instrumentation counter for query-plan assertions.
 * Each bulk method increments this; tests reset and assert bound.
 */
let _queryCount = 0;
export function _incrementQueryCount(): void {
  _queryCount += 1;
}
export function resetWorkStateQueryCount(): void {
  _queryCount = 0;
}
export function getWorkStateQueryCount(): number {
  return _queryCount;
}


