/**
 * Slice 1 — v2 stage-read repository seam (council plan §4.1/§5.2).
 *
 * All v2 stage-read SQL lives here (never in services/routes). Provides:
 * - explicit per-request executed-statement counting (no N+1 false-greens:
 *   the counter observes actual query executions, not prepared statements);
 * - repository-managed read transactions (BEGIN/COMMIT counted as overhead);
 * - per-transaction storage-version read (NO process/singleton cache — the
 *   metadata row is read inside each transaction; Slice 1 storage is v1);
 * - chunk-scoped bulk acceptance hydration (one marker read + one IN query
 *   per chunk instead of per-row marker+query).
 */
import { getDb } from '../connection';
import { mapCohortRow, mapCohortMemberRow } from './curation-cohort-repo';
import type { CurationCohort, CurationCohortMember } from '../../shared/schemas/cohorts';
import type { OnboardingReviewState } from './onboarding-review-repo';
import type { ExtractionBinding } from './onboarding-extraction-repo';

export interface ExecutedStatement {
  kind: 'all' | 'get' | 'run' | 'tx' | 'external';
  sql: string;
}

let _statementCount = 0;
let _statementLog: ExecutedStatement[] = [];

export function resetStageReadStatementCount(): void {
  _statementCount = 0;
  _statementLog = [];
}

export function getStageReadStatementCount(): number {
  return _statementCount;
}

export function getStageReadExecutedStatements(): ExecutedStatement[] {
  return [..._statementLog];
}

function tracked<T>(kind: ExecutedStatement['kind'], sql: string, fn: () => T): T {
  _statementCount += 1;
  _statementLog.push({ kind, sql });
  return fn();
}

/**
 * Ledger entry for a DB statement executed outside tracked() by a call the
 * v2 path provably makes exactly once per invocation (verified by code
 * inspection + the query-plan test's empirical totals). Used ONLY for the
 * item-repo chunk reader (exactly one `.all` per call). Everything else in
 * the v2 path flows through tracked(). `noteExternalStatements` never
 * estimates: the count is a structural property of the callee.
 */
export function trackExternalStatements(count: number, label: string): void {
  for (let i = 0; i < count; i += 1) {
    _statementCount += 1;
    _statementLog.push({ kind: 'external', sql: label });
  }
}

/** Read the storage vocabulary version inside the current transaction.
 * absent/1 = v1 storage, 2 = v2 storage. Never cached across transactions. */
export function readStageStorageVersion(): 1 | 2 {
  const row = tracked(
    'get',
    'SELECT value FROM app_meta WHERE key = onboarding_stage_vocabulary_version',
    () =>
      getDb().query('SELECT value FROM app_meta WHERE key = ?').get('onboarding_stage_vocabulary_version') as
        | { value: string }
        | undefined,
  );
  return row && row.value === '2' ? 2 : 1;
}

/** Repository-managed read transaction. Rolls back on throw; the caller's
 * error propagates unchanged (route maps projection errors to 503). */
export function withStageReadTransaction<T>(fn: () => T): T {
  const db = getDb();
  tracked('tx', 'BEGIN', () => db.exec('BEGIN'));
  try {
    const result = fn();
    tracked('tx', 'COMMIT', () => db.exec('COMMIT'));
    return result;
  } catch (err) {
    try {
      tracked('tx', 'ROLLBACK', () => db.exec('ROLLBACK'));
    } catch {
      // Rollback failure must not mask the original error.
    }
    throw err;
  }
}

export interface StageReadScopeCheck {
  batchId: string;
  workspaceId: string;
}

/**
 * Authorize a batch read: batch exists AND belongs to the workspace.
 * Returns false (route renders 404) without running any work query.
 */
export function checkStageReadScope(batchId: string, workspaceId: string): boolean {
  const row = tracked(
    'get',
    'SELECT id, workspace_id FROM onboarding_batches WHERE id = ?',
    () =>
      getDb().query('SELECT id, workspace_id FROM onboarding_batches WHERE id = ?').get(batchId) as
        | { id: string; workspace_id: string }
        | undefined,
  );
  if (!row) return false;
  return row.workspace_id === workspaceId;
}

// ─── Tracked v2 context loaders ─────────────────────────────────────────────
//
// Same tables, same predicates, same row mappings as the v1 projection path
// (listReviewStates, listCohortsByBatch/getCohortMembers,
// getLatestExtractionBindingsByItemIds, listChangeSetStatusBySkus), but every
// statement flows through tracked() so the v2 query budget is complete by
// construction. Mapping parity is proved by equivalence tests against the v1
// functions on identical fixtures (see onboarding-stage-read-query-plan).
//
// Deliberate divergences from buildCohortView (both projection-neutral):
// - getCurrentCohortRun is NOT loaded: buildCohortContext drops its fields
//   (executionProductType*) before deriveItemWorkState ever sees them.
// - Cohort members for the whole chunk batch load once (IN query) instead of
//   once per cohort; evaluation still runs per cohort through the same pure
//   evaluateCohortReadiness/evaluateItemReadiness evaluators.

function safeJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Bulk review states for a batch. One statement. */
export function loadV2ReviewStates(batchId: string): Map<string, OnboardingReviewState> {
  const rows = tracked(
    'all',
    'SELECT * FROM onboarding_review_state WHERE batch_id = ?',
    () =>
      getDb().query('SELECT * FROM onboarding_review_state WHERE batch_id = ?').all(batchId) as Array<{
        item_id: string;
        batch_id: string;
        reviewed_at: string | null;
        reviewed_by: string | null;
        review_invalidated_at: string | null;
        review_invalidation_reason: string | null;
        approved_at: string | null;
        approved_by: string | null;
        approval_origin: string;
        created_at: string;
        updated_at: string;
      }>,
  );
  return new Map(
    rows.map(row => [
      row.item_id,
      {
        itemId: row.item_id,
        batchId: row.batch_id,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by,
        reviewInvalidatedAt: row.review_invalidated_at,
        reviewInvalidationReason: row.review_invalidation_reason,
        approvedAt: row.approved_at,
        approvedBy: row.approved_by,
        approvalOrigin: row.approval_origin,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ]),
  );
}

/** All cohorts for a batch (including superseded, like the v1 context). One statement. */
export function loadV2Cohorts(batchId: string): CurationCohort[] {
  const rows = tracked(
    'all',
    'SELECT * FROM curation_cohorts WHERE batch_id = ? ORDER BY created_at ASC',
    () =>
      getDb().query('SELECT * FROM curation_cohorts WHERE batch_id = ? ORDER BY created_at ASC').all(batchId) as Array<
        Record<string, unknown>
      >,
  );
  return rows.map(row => mapCohortRow(row));
}

/** Members for a set of cohorts. One IN statement (empty input: zero statements). */
export function loadV2CohortMembers(cohortIds: string[]): Map<string, CurationCohortMember[]> {
  const map = new Map<string, CurationCohortMember[]>();
  for (const id of cohortIds) map.set(id, []);
  if (cohortIds.length === 0) return map;
  const placeholders = cohortIds.map(() => '?').join(', ');
  const rows = tracked(
    'all',
    `SELECT * FROM curation_cohort_members WHERE cohort_id IN (<${cohortIds.length}>) ORDER BY ordinal ASC`,
    () =>
      getDb().query(
        `SELECT * FROM curation_cohort_members WHERE cohort_id IN (${placeholders}) ORDER BY ordinal ASC`,
      ).all(...cohortIds) as Array<Record<string, unknown>>,
  );
  for (const row of rows) {
    const member = mapCohortMemberRow(row);
    map.get(member.cohortId)?.push(member);
  }
  return map;
}

/** Latest extraction binding per item. One window-function statement (empty: zero). */
export function loadV2ExtractionBindings(itemIds: string[]): Map<string, ExtractionBinding> {
  const bindings = new Map<string, ExtractionBinding>();
  if (itemIds.length === 0) return bindings;
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = tracked(
    'all',
    `SELECT latest onboarding_extractions per item WHERE item_id IN (<${itemIds.length}>)`,
    () =>
      getDb().query(
        `SELECT * FROM (
           SELECT e.*, ROW_NUMBER() OVER (
             PARTITION BY e.item_id
             ORDER BY e.created_at DESC, e.rowid DESC
           ) AS rn
           FROM onboarding_extractions e
           WHERE e.item_id IN (${placeholders})
         ) WHERE rn = 1`,
      ).all(...itemIds) as Array<Record<string, unknown>>,
  );
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    bindings.set(String(r['item_id']), {
      sourceUrl: (r['source_url'] as string | null) ?? null,
      sourceType: ((r['source_type'] as string | null) ?? 'official_page') as 'official_page' | 'distributor_record',
      extractionMethod: r['extraction_method'] as string,
      sourcingGenerationId: (r['sourcing_generation_id'] as string | null) ?? null,
      acceptedEvidenceAttemptIds: safeJsonStringArray(r['accepted_evidence_attempt_ids_json']),
      evidenceHash: (r['evidence_hash'] as string | null) ?? null,
      manualAttestationId: (r['manual_attestation_id'] as string | null) ?? null,
    });
  }
  return bindings;
}

// ─── Ticket #125: collection-read bulk loaders ─────────────────────────────
//
// Read-only: raw SELECTs with try/catch (a missing table yields empty maps,
// never ensureTables() DDL and never throws). Every statement flows through
// tracked() so the v2 query budget stays complete by construction.

export interface V2CollectionApproval {
  normalizedBrand: string;
  approved: boolean;
  revision: number;
  sourcesJson: string;
}

/** All stored strategy rows for a workspace. One statement. */
export function loadV2StrategyApprovals(workspaceId: string): Map<string, V2CollectionApproval> {
  const out = new Map<string, V2CollectionApproval>();
  let rows: Array<{ normalized_brand: string; approved: number; revision: number; sources_json: string }>;
  try {
    rows = tracked(
      'all',
      'SELECT normalized_brand, approved, revision, sources_json FROM brand_sourcing_strategies WHERE workspace_id = ?',
      () =>
        getDb().query(
          'SELECT normalized_brand, approved, revision, sources_json FROM brand_sourcing_strategies WHERE workspace_id = ?',
        ).all(workspaceId) as Array<{ normalized_brand: string; approved: number; revision: number; sources_json: string }>,
    );
  } catch {
    return out;
  }
  for (const row of rows) {
    out.set(row.normalized_brand, {
      normalizedBrand: row.normalized_brand,
      approved: row.approved === 1,
      revision: row.revision,
      sourcesJson: row.sources_json,
    });
  }
  return out;
}

export interface V2CollectionGeneration {
  itemId: string;
  generationId: string;
  status: string;
  attemptCount: number;
  /** Raw binding row (null = no captured binding; corrupt flagged by parse). */
  binding: {
    mode: string;
    strategyRevision: number | null;
    normalizedBrand: string | null;
    sourcesJson: string;
    bindingVersion: string;
  } | null;
}

/** Latest generation + attempt counts + bindings per item. Three statements (empty: zero). */
export function loadV2CollectionGenerations(itemIds: string[]): Map<string, V2CollectionGeneration> {
  const out = new Map<string, V2CollectionGeneration>();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => '?').join(', ');
  let gens: Array<{ id: string; item_id: string; status: string }>;
  try {
    gens = tracked(
      'all',
      `SELECT latest sourcing_generations per item WHERE item_id IN (<${itemIds.length}>)`,
      () =>
        getDb().query(
          `SELECT * FROM (
             SELECT g.*, ROW_NUMBER() OVER (
               PARTITION BY g.item_id
               ORDER BY g.rowid DESC
             ) AS rn
             FROM sourcing_generations g
             WHERE g.item_id IN (${placeholders})
           ) WHERE rn = 1`,
        ).all(...itemIds) as Array<{ id: string; item_id: string; status: string }>,
    );
  } catch {
    return out;
  }
  for (const g of gens) {
    out.set(g.item_id, {
      itemId: g.item_id,
      generationId: g.id,
      status: g.status,
      attemptCount: 0,
      binding: null,
    });
  }
  const genIds = [...out.values()].map((g) => g.generationId);
  if (genIds.length === 0) return out;
  const genPlaceholders = genIds.map(() => '?').join(', ');
  try {
    const counts = tracked(
      'all',
      `SELECT sourcing_generation_id, COUNT(*) FROM onboarding_evidence_attempts WHERE sourcing_generation_id IN (<${genIds.length}>) GROUP BY sourcing_generation_id`,
      () =>
        getDb().query(
          `SELECT sourcing_generation_id AS generationId, COUNT(*) AS n
           FROM onboarding_evidence_attempts WHERE sourcing_generation_id IN (${genPlaceholders})
           GROUP BY sourcing_generation_id`,
        ).all(...genIds) as Array<{ generationId: string; n: number }>,
    );
    const byGen = new Map(counts.map((c) => [c.generationId, c.n]));
    for (const entry of out.values()) {
      entry.attemptCount = byGen.get(entry.generationId) ?? 0;
    }
  } catch {
    // Attempt counts unavailable: keep zeros (fail closed downstream).
  }
  try {
    const bindings = tracked(
      'all',
      `SELECT * FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id IN (<${genIds.length}>)`,
      () =>
        getDb().query(
          `SELECT sourcing_generation_id AS generationId, mode, strategy_revision AS strategyRevision,
                  normalized_brand AS normalizedBrand, sources_json AS sourcesJson, binding_version AS bindingVersion
           FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id IN (${genPlaceholders})`,
        ).all(...genIds) as Array<{
          generationId: string;
          mode: string;
          strategyRevision: number | null;
          normalizedBrand: string | null;
          sourcesJson: string;
          bindingVersion: string;
        }>,
    );
    const byGen = new Map(bindings.map((b) => [b.generationId, b]));
    for (const entry of out.values()) {
      const b = byGen.get(entry.generationId);
      if (b) {
        entry.binding = {
          mode: b.mode,
          strategyRevision: b.strategyRevision,
          normalizedBrand: b.normalizedBrand,
          sourcesJson: b.sourcesJson,
          bindingVersion: b.bindingVersion,
        };
      }
    }
  } catch {
    // Binding table absent/unreadable: bindings stay null (fresh-work path).
  }
  return out;
}

export interface V2CollectionConnection {
  distributorId: string;
  connectorType: string;
  secretRef: string | null;
}

/** Enabled workspace connections (id/type/secret-ref only, never secrets). One statement. */
export function loadV2EnabledCollectionConnections(workspaceId: string): V2CollectionConnection[] {
  try {
    return tracked(
      'all',
      'SELECT distributor_id, connector_type, secret_ref FROM distributor_connections WHERE workspace_id = ? AND enabled = 1',
      () =>
        getDb().query(
          'SELECT distributor_id AS distributorId, connector_type AS connectorType, secret_ref AS secretRef FROM distributor_connections WHERE workspace_id = ? AND enabled = 1',
        ).all(workspaceId) as V2CollectionConnection[],
    );
  } catch {
    return [];
  }
}

/**
 * Configured extractor-profile presence per domain (scheduling signal
 * only — authoritative profile health stays in the strategies endpoint
 * and the worker enforces it at dispatch). One IN statement (empty: zero).
 */
export function loadV2OfficialProfilePresence(domains: string[]): Set<string> {
  const out = new Set<string>();
  if (domains.length === 0) return out;
  const placeholders = domains.map(() => '?').join(', ');
  try {
    const rows = tracked(
      'all',
      `SELECT domain FROM extractor_profiles WHERE domain IN (<${domains.length}>)`,
      () =>
        getDb().query(`SELECT domain FROM extractor_profiles WHERE domain IN (${placeholders})`).all(...domains) as Array<{
          domain: string;
        }>,
    );
    for (const row of rows) out.add(String(row.domain).toLowerCase());
  } catch {
    // Unreadable: no domain reads as configured (fail closed downstream).
  }
  return out;
}

/**
 * Stored API-key presence per service (secret names only, never values).
 * One IN statement (empty: zero). Lets the collection projection mirror
 * the engine's secret resolution without resolving any secret.
 */
export function loadV2ApiKeyPresence(services: string[]): Set<string> {
  const out = new Set<string>();
  if (services.length === 0) return out;
  const placeholders = services.map(() => '?').join(', ');
  try {
    const rows = tracked(
      'all',
      `SELECT service FROM api_keys WHERE service IN (<${services.length}>)`,
      () =>
        getDb().query(`SELECT service FROM api_keys WHERE service IN (${placeholders})`).all(...services) as Array<{
          service: string;
        }>,
    );
    for (const row of rows) out.add(String(row.service));
  } catch {
    // Unreadable: secrets read as missing (fail closed downstream).
  }
  return out;
}

/** Change-set status by SKU. Zero statements when no promotion SKUs. */
export function loadV2ChangeSetStatusBySkus(workspaceId: string, skus: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (skus.length === 0) return result;
  const placeholders = skus.map(() => '?').join(', ');
  const rows = tracked(
    'all',
    `SELECT change_set_items sku/status WHERE workspace (<${skus.length}> skus)`,
    () =>
      getDb().query(
        `SELECT csi.sku AS sku, cs.status AS status
         FROM change_set_items csi
         JOIN change_sets cs ON cs.id = csi.change_set_id
         WHERE cs.workspace_id = ? AND csi.sku IN (${placeholders}) AND cs.status != 'discarded'`,
      ).all(workspaceId, ...skus) as Array<{ sku: string; status: string }>,
  );
  const RANK: Record<string, number> = { draft: 1, reviewing: 2, approved: 3, pushed: 4 };
  for (const row of rows) {
    const prev = result.get(row.sku);
    if (!prev || (RANK[row.status] ?? 0) > (RANK[prev] ?? 0)) result.set(row.sku, row.status);
  }
  return result;
}
