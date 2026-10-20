import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { OnboardingSource } from '../../shared/schemas/onboarding';

/**
 * Discovery run traceability (epic #46 batch-analysis follow-up).
 *
 * The current discovery path (source-discovery + the worker's
 * processDiscovery) persisted candidate sources but never a run-level trace:
 * the `onboarding_discovery_runs` table existed only in legacy live databases
 * (no migration created it, no code wrote it). Every discovery execution now
 * records one run row (trigger/status/steps/outcome) and stamps each
 * candidate source with `discovery_run_id` so provenance is auditable.
 */
export interface DiscoveryRunRow {
  id: string;
  item_id: string;
  trigger: string;
  status: string;
  request_json: string;
  current_step: string | null;
  outcome: string | null;
  outcome_message: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  retry_count: number;
  retry_request_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type DiscoveryRunStep =
  // Active steps in sitemap & local-index discovery pipeline
  | 'preflight'
  | 'sitemap_fetch'
  | 'sitemap_match'
  | 'variant_resolution'
  | 'page_verification'
  | 'ranking'
  | 'applying_outcome'
  // Legacy SERP-era steps retained for historical discovery trace audit
  | 'official_search'
  | 'identifier_search'
  | 'name_consolidation'
  | 'name_search';

export type DiscoveryRunOutcome =
  | 'auto_selected'
  | 'needs_input_candidates'
  | 'needs_input_no_candidates'
  | 'needs_input_ambiguous'
  | 'needs_input_setup'
  | 'failed';

/**
 * Create a discovery run row for an item (status 'running'). Returns the run id.
 *
 * One active run per item: legacy live databases enforce this with unique
 * partial indexes (`idx_discovery_runs_one_running` / `_one_queued`), and the
 * discovery-run migration v2 recreates them on fresh installs. A retry or
 * re-execution must therefore never collide with a stale 'running'/'queued'
 * run left behind by an interrupted attempt (e.g. the process died mid-run) —
 * without this, the INSERT raises
 * `UNIQUE constraint failed: onboarding_discovery_runs.item_id` and the whole
 * item processing fails. Any stale active run is superseded first (marked
 * 'failed' with the reason preserved on the old row), then the new run is
 * inserted, atomically.
 */
export function createDiscoveryRun(itemId: string, request: {
  trigger: 'automatic' | 'refinement' | 'direct_url';
  upc: string;
  name: string;
  brandHint?: string | null;
}): string {
  const db = getDb();
  const id = `dr_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const create = db.transaction(() => {
    // Supersede any stale active run so the new execution owns the trace.
    // The `status = 'running'` guards on the step/complete/fail updates make
    // the superseded row inert: a late completion from the old attempt is a
    // no-op and can never overwrite the new run's outcome.
    db.query(
      `UPDATE onboarding_discovery_runs
       SET status = 'failed', outcome = 'failed',
           outcome_message = 'Superseded by a newer discovery run',
           completed_at = ?
       WHERE item_id = ? AND status IN ('queued', 'running')`,
    ).run(now, itemId);
    db.query(
      `INSERT INTO onboarding_discovery_runs
        (id, item_id, trigger, status, request_json, current_step, created_at, started_at)
       VALUES (?, ?, ?, 'running', ?, 'preflight', ?, ?)`,
    ).run(id, itemId, request.trigger, JSON.stringify(request), now, now);
  });
  create();
  return id;
}

/** Record the current pipeline step of a run (no-op when the run is not running). */
export function updateDiscoveryRunStep(runId: string, step: DiscoveryRunStep): void {
  const db = getDb();
  db.query("UPDATE onboarding_discovery_runs SET current_step = ? WHERE id = ? AND status = 'running'").run(step, runId);
}

/** Complete a run with a terminal outcome. */
export function completeDiscoveryRun(runId: string, outcome: DiscoveryRunOutcome, message: string | null = null): void {
  const db = getDb();
  db.query(
    `UPDATE onboarding_discovery_runs
     SET status = 'completed', outcome = ?, outcome_message = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(outcome, message, new Date().toISOString(), runId);
}

/** Fail a run (status 'failed', outcome 'failed'). */
export function failDiscoveryRun(runId: string, message: string | null = null): void {
  const db = getDb();
  db.query(
    `UPDATE onboarding_discovery_runs
     SET status = 'failed', outcome = 'failed', outcome_message = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(message, new Date().toISOString(), runId);
}

/** Stamp every candidate source of an item with the discovery run that produced it. */
export function stampSourcesWithDiscoveryRun(itemId: string, runId: string): void {
  const db = getDb();
  db.query('UPDATE onboarding_sources SET discovery_run_id = ? WHERE item_id = ? AND discovery_run_id IS NULL').run(
    runId,
    itemId,
  );
}

/** Stamp one candidate row with its producing run (no-op when already bound). */
export function stampSourceWithDiscoveryRun(sourceId: string, runId: string): void {
  getDb().query('UPDATE onboarding_sources SET discovery_run_id = ? WHERE id = ? AND discovery_run_id IS NULL').run(runId, sourceId);
}

/** Latest run for an item (most recently created), or null. */
export function getLatestDiscoveryRunForItem(itemId: string): DiscoveryRunRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM onboarding_discovery_runs WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(itemId) as DiscoveryRunRow | undefined;
  return row ?? null;
}

/** All runs for a batch (join via onboarding_items), newest first. */
export function listDiscoveryRunsForBatch(batchId: string): DiscoveryRunRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT r.* FROM onboarding_discovery_runs r
       JOIN onboarding_items i ON i.id = r.item_id
       WHERE i.batch_id = ?
       ORDER BY r.created_at DESC`,
    )
    .all(batchId) as DiscoveryRunRow[];
}

export interface OnboardingSourceRow {
  id: string;
  item_id: string;
  url: string;
  title: string | null;
  snippet: string | null;
  domain: string | null;
  confidence: number;
  is_selected: number;
  source_method: string;
  metadata_json: string | null;
  discovery_run_id?: string | null;
  review_status?: string | null;
  decision_origin?: string | null;
  decision_reason?: string | null;
  reviewed_at?: string | null;
  created_at: string;
}

export interface InsertSourceData {
  url: string;
  title?: string | null;
  snippet?: string | null;
  domain?: string | null;
  confidence: number;
  sourceMethod?: string;
  metadataJson?: string | null;
  /** Owning discovery run; stamped at insert so currentness checks never see NULL on live rows. */
  discoveryRunId?: string | null;
}

function mapRowToSource(row: OnboardingSourceRow): OnboardingSource {
  return {
    id: row.id,
    itemId: row.item_id,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    domain: row.domain,
    confidence: row.confidence,
    isSelected: row.is_selected === 1,
    sourceMethod: row.source_method,
    metadataJson: row.metadata_json,
    discoveryRunId: row.discovery_run_id ?? null,
    reviewStatus: row.review_status ?? 'pending',
    decisionOrigin: row.decision_origin ?? null,
    decisionReason: row.decision_reason ?? null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
  };
}

export function insertSources(itemId: string, sources: InsertSourceData[]): OnboardingSource[] {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.query(
    `INSERT INTO onboarding_sources
      (id, item_id, url, title, snippet, domain, confidence, is_selected, source_method, metadata_json, discovery_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  );

  const inserted: OnboardingSource[] = [];

  const insertAll = db.transaction(() => {
    for (const source of sources) {
      const id = randomUUID();
      stmt.run(
        id,
        itemId,
        source.url,
        source.title ?? null,
        source.snippet ?? null,
        source.domain ?? null,
        source.confidence,
        source.sourceMethod ?? 'unknown',
        source.metadataJson ?? null,
        source.discoveryRunId ?? null,
        now,
      );
      inserted.push({
        id,
        itemId,
        url: source.url,
        title: source.title ?? null,
        snippet: source.snippet ?? null,
        domain: source.domain ?? null,
        confidence: source.confidence,
        isSelected: false,
        sourceMethod: source.sourceMethod ?? 'unknown',
        metadataJson: source.metadataJson ?? null,
        discoveryRunId: source.discoveryRunId ?? null,
        reviewStatus: 'pending',
        createdAt: now,
      });
    }
  });
  insertAll();

  return inserted;
}

export function listSourcesByItem(itemId: string): OnboardingSource[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_sources WHERE item_id = ? ORDER BY confidence DESC',
  ).all(itemId) as OnboardingSourceRow[];
  return rows.map(mapRowToSource);
}

export function selectSource(sourceId: string): void {
  const db = getDb();
  const source = db.query('SELECT item_id FROM onboarding_sources WHERE id = ?').get(sourceId) as
    | { item_id: string }
    | undefined;
  if (!source) return;

  db.transaction(() => {
    db.query('UPDATE onboarding_sources SET is_selected = 0 WHERE item_id = ?').run(source.item_id);
    db.query('UPDATE onboarding_sources SET is_selected = 1 WHERE id = ?').run(sourceId);
  })();
}

// fallow-ignore-next-line unused-export
export function getSelectedSource(itemId: string): OnboardingSource | undefined {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM onboarding_sources WHERE item_id = ? AND is_selected = 1',
  ).get(itemId) as OnboardingSourceRow | undefined;
  return row ? mapRowToSource(row) : undefined;
}

export function deleteSourcesByItem(itemId: string): void {
  const db = getDb();
  db.query('DELETE FROM onboarding_sources WHERE item_id = ?').run(itemId);
}

/** Lightweight sample used by the profile governance service's
 *  cross-sample validation. Joins `onboarding_sources` to
 *  `onboarding_items` so the caller has the expected product name,
 *  brand hint, and item id for the URL. Used to verify that a
 *  generated selector set generalizes across multiple product pages
 *  on the same domain before a human operator is allowed to approve
 *  it. Promotion still requires explicit per-field approval
 *  regardless of multi-sample results (profile-governance invariant,
 *  Phase 3 task 13). */
export interface ValidationSampleRow {
  url: string;
  expectedName: string;
  brandHint: string | null;
  itemId: string;
  isSelected: number;
  confidence: number;
}

/**
 * List URLs from a domain that are good candidates for cross-page
 * profile validation.
 *
 * Policy (Phase 3 task 14, decision 8):
 *   - Only sources the operator has confirmed (`is_selected = 1`).
 *     Random high-confidence-but-unselected URLs are excluded.
 *   - Exact-match or suffix-match domain comparison: `domain = ?`
 *     or `domain LIKE '%.domain'`. The previous broad `%domain%`
 *     match is removed because it was allowing unrelated domains
 *     (e.g. `notmywoof.com` matching `mywoof.com`) to bleed into
 *     validation samples.
 *   - URL deduplication within the result.
 *   - `expectedName` prefers `expected_name` when present, otherwise
 *     falls back to the raw `name` column.
 *   - `brandHint` is `brand_hint` and may be null.
 *
 * The function does not fetch HTML. The caller is expected to do a
 * separate HTTP fetch (using the same headers as the page extractor)
 * and pair the URL with the fetched HTML before running
 * `validateRevisionAcrossConfirmedSamples`.
 */
export function listValidationSamplesByDomain(
  domain: string,
  limit = 5,
): ValidationSampleRow[] {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));

  // Selected sources for the exact domain, plus subdomain suffix
  // (e.g. `us.mywoof.com` should still match `mywoof.com`). The
  // previous `LIKE '%mywoof%'` implementation matched `notmywoof.com`
  // too, which produced cross-brand pollution; the explicit suffix
  // match closes that gap.
  const rows = db
    .query(
      `SELECT s.url AS url,
              COALESCE(i.expected_name, i.name) AS expectedName,
              i.brand_hint AS brandHint,
              i.id AS itemId,
              s.is_selected AS isSelected,
              s.confidence AS confidence
         FROM onboarding_sources s
         JOIN onboarding_items i ON s.item_id = i.id
        WHERE s.is_selected = 1
          AND s.domain IS NOT NULL
          AND (LOWER(s.domain) = ? OR LOWER(s.domain) LIKE ?)
        ORDER BY s.confidence DESC, s.created_at DESC
        LIMIT ?`,
    )
    .all(
      normalizedDomain,
      `%.${normalizedDomain}`,
      safeLimit * 2, // over-fetch a little; we will dedupe and trim below
    ) as ValidationSampleRow[];

  // Deduplicate by URL and cap to the requested limit. Confirmed
  // sources for the same product can appear multiple times if the
  // same URL was inserted on different scans.
  const seen = new Set<string>();
  const deduped: ValidationSampleRow[] = [];
  for (const row of rows) {
    if (!row.url) continue;
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    deduped.push(row);
    if (deduped.length >= safeLimit) break;
  }
  return deduped;
}
