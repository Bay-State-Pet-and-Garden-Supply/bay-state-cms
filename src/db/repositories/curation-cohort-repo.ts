/**
 * Curation cohort repository (issue #30, PR1+PR2).
 *
 * Function module (no class): snake_case row interfaces + camelCase mappers,
 * `randomUUID()` ids, ISO `now()` timestamps, positional `?` params, and
 * `db.transaction(() => {})()` for multi-table writes — following the
 * classification-run-repo / onboarding-item-repo conventions.
 *
 * Supersession semantics: a cohort revision is created ONLY when the member
 * IDENTITY set changes (member added/removed) or the group is orphaned. The
 * old row is marked `superseded` and a NEW cohort row is inserted with fresh
 * members. Evidence progress (an updated `extraction_hash`) is candidate
 * readiness state and refreshes member rows in place — it never supersedes a
 * cohort. The unique partial index `idx_curation_cohorts_active_group`
 * enforces at most one active cohort per (batch, group_key, grouping_version).
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  knownBrandsForBatch,
  familyGroupingIdentityFor,
} from '../../onboarding/product-line-grouper';
import { stemsWithinTypoTolerance } from '../../onboarding/product-line-token-normalizer';
import { GROUPING_VERSION } from '../../shared/schemas/cohorts';
import type { CurationCohort, CurationCohortMember } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';

const now = () => new Date().toISOString();

// ─── Row interfaces (snake_case) ───────────────────────────────────────────────

export interface CurationCohortRow {
  id: string;
  workspace_id: string;
  batch_id: string;
  group_key: string;
  group_label: string;
  grouping_version: string;
  membership_hash: string;
  status: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
}

export interface CurationCohortMemberRow {
  cohort_id: string;
  onboarding_item_id: string;
  product_sku: string | null;
  normalized_brand: string;
  normalized_name_stem: string;
  membership_reason_json: string | null;
  extraction_hash: string | null;
  ordinal: number;
  created_at: string;
}

// ─── Mappers (snake → camel) ──────────────────────────────────────────────────

export function mapCohortRow(row: Record<string, any>): CurationCohort {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    batchId: row.batch_id,
    groupKey: row.group_key,
    groupLabel: row.group_label,
    groupingVersion: row.grouping_version,
    membershipHash: row.membership_hash,
    status: row.status,
    blockedReason: row.blocked_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededAt: row.superseded_at ?? null,
  };
}

export function mapCohortMemberRow(row: Record<string, any>): CurationCohortMember {
  let membershipReasonJson: Record<string, unknown> | null = null;
  if (row.membership_reason_json) {
    try {
      membershipReasonJson = JSON.parse(row.membership_reason_json);
    } catch {
      membershipReasonJson = null;
    }
  }
  return {
    cohortId: row.cohort_id,
    onboardingItemId: row.onboarding_item_id,
    productSku: row.product_sku ?? null,
    normalizedBrand: row.normalized_brand,
    normalizedNameStem: row.normalized_name_stem,
    membershipReasonJson,
    extractionHash: row.extraction_hash ?? null,
    ordinal: row.ordinal,
    createdAt: row.created_at,
  };
}

// ─── Pure hash helpers ─────────────────────────────────────────────────────────

/**
 * Canonical hash of an item's frozen extraction evidence: the full
 * `extractionData` object, the `sourcingDecision`, the selected `sourceUrl`
 * (round-3 R4 — a source change rebinds the hash), and the sorted
 * `productIntelligenceEvidence[].resultHash` list (PI imports participate in
 * evidence stability per issue #30's extraction completeness contract).
 *
 * Amendment A: the hash ALSO binds the item `sourceType` and sorted
 * distributor provenance (the sourcing generation id carried by the routing
 * decision and the sorted accepted-evidence-attempt ids) — an item whose
 * source switched from `official_page` to `distributor_record`, or whose
 * accepted evidence set changed, rebinds the hash. Provenance is sorted so
 * the hash is order-insensitive.
 *
 * Post-review fixup: the observation-only `shadowPackagingOcrData` key is
 * EXCLUDED from the hashed object. It is written by shadow-mode packaging-OCR
 * stage runs and bumps `updated_at`, so letting it participate would change
 * the evidence identity on the first shadow write and spuriously supersede a
 * ready cohort. Observation payloads must never influence candidate/evidence
 * identity. Safe: the key is brand-new behind a default-OFF flag — no
 * pre-existing rows carry it, so no stored hashes can shift.
 *
 * Returns NULL when the item has no extraction data yet.
 */
export function computeExtractionHash(item: OnboardingItem): string | null {
  let extractionData = item.extractionData;
  if (!extractionData) return null;
  // Both OCR bookkeeping keys are EXCLUDED from evidence identity: the shadow
  // observation payload (established precedent below) and the P2 drift-guard
  // marker (packagingOcrStageRunId varies per authoring run and must never
  // make two otherwise-identical extractions hash differently).
  if ('shadowPackagingOcrData' in extractionData || 'packagingOcrStageRunId' in extractionData) {
    const { shadowPackagingOcrData: _shadow, packagingOcrStageRunId: _stageMarker, ...rest } = extractionData as Record<string, unknown>;
    extractionData = rest as typeof extractionData;
  }
  const piResultHashes = ((extractionData as any).productIntelligenceEvidence ?? [])
    .map((entry: any) => (entry && typeof entry.resultHash === 'string' ? entry.resultHash : null))
    .filter((hash: string | null): hash is string => hash !== null)
    .sort();
  // V2 routing decisions carry `sourcingGenerationId`; read it defensively
  // (legacy decisions may not) so provenance is never fabricated.
  const decision = item.sourcingDecision as (Record<string, unknown> & { sourcingGenerationId?: string | null }) | null;
  const sourcingGenerationId =
    decision && typeof decision.sourcingGenerationId === 'string' ? decision.sourcingGenerationId : null;
  const acceptedEvidenceAttemptIds = [...(item.acceptedEvidenceAttemptIds ?? [])].sort();
  const cleanSourcingDecision = item.sourcingDecision
    ? JSON.parse(JSON.stringify(item.sourcingDecision))
    : null;
  return hashCanonicalJson({
    extractionData,
    sourcingDecision: cleanSourcingDecision,
    sourceUrl: item.sourceUrl ?? null,
    productIntelligenceResultHashes: piResultHashes,
    sourceType: item.sourceType ?? 'official_page',
    distributorProvenance: {
      sourcingGenerationId,
      acceptedEvidenceAttemptIds,
    },
  });
}

/**
 * Order-insensitive canonical membership hash: hashes the sorted member
 * IDENTITIES (onboarding item ids). Membership identity is the item set only —
 * `extraction_hash` is candidate readiness state and must never change
 * membership (issue #30 round-2 F4). Evidence/config drift supersedes the
 * cohort RUN at PR3 via an independent `evidence_snapshot_hash`.
 */
export function computeMembershipHash(memberItemIds: string[]): string {
  const sorted = [...memberItemIds].sort((a, b) => a.localeCompare(b));
  return hashCanonicalJson(sorted);
}

// ─── Candidate grouping (deterministic, v1) ───────────────────────────────────

interface FamilyGroupMember {
  item: OnboardingItem;
  extractionHash: string | null;
}

interface FamilyGroup {
  groupKey: string;
  groupLabel: string;
  normalizedBrand: string;
  normalizedNameStem: string;
  members: FamilyGroupMember[];
}

/**
 * Deterministic candidate grouping reusing the product-line-grouper kernel
 * (`normalizeBrand` + `extractNameStem`). Every item with a non-empty name
 * stem forms or joins a family group — singletons are one-member cohorts
 * (issue #30, "Singleton behavior"). Items whose current stage is `skipped`
 * are excluded from candidate membership: skipping a member is itself a
 * membership revision (issue #30 round-2 F5).
 */
export function groupItemsByFamily(items: OnboardingItem[]): FamilyGroup[] {
  const knownBrands = knownBrandsForBatch(items);
  const byKey = new Map<string, FamilyGroup>();
  const sorted = [...items].sort((a, b) => a.rowNumber - b.rowNumber);
  for (const item of sorted) {
    if (item.stageStatus === 'skipped') continue; // skipped → not a candidate member
    const identity = familyGroupingIdentityFor(item, knownBrands);
    if (!identity.stem) continue; // no stable name stem → not groupable
    const normalizedBrand = identity.normalizedBrand;
    const normalizedNameStem = identity.stem;
    const groupKey = identity.key;
    let group = byKey.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        groupLabel: (item.name || normalizedNameStem).slice(0, 200),
        normalizedBrand,
        normalizedNameStem,
        members: [],
      };
      byKey.set(groupKey, group);
    }
    group.members.push({ item, extractionHash: computeExtractionHash(item) });
  }

  // Epic #46 Package A (typo tolerance): merge stems within the same brand
  // that differ in exactly one token of length >= 4 with edit distance <= 1
  // ("soft classic veggie" vs "soft classic vegggie"). Deterministic: the
  // more-populous stem wins, ties break to the lexicographically first key.
  // Durable repo merges distance-1 stems via stemsWithinTypoTolerance; transient
  // coordination uses exact keys — intentional until v2 (deferred architecture decision).
  const groups = [...byKey.values()];
  const merged = new Set<FamilyGroup>();
  const result: FamilyGroup[] = [];
  for (const group of groups) {
    if (merged.has(group)) continue;
    const brand = group.groupKey.slice(0, group.groupKey.indexOf('::'));
    const candidates = groups.filter(
      g =>
        !merged.has(g) &&
        g.groupKey.startsWith(`${brand}::`) &&
        g !== group &&
        stemsWithinTypoTolerance(group.normalizedNameStem, g.normalizedNameStem),
    );
    if (candidates.length === 0) {
      merged.add(group);
      result.push(group);
      continue;
    }
    // Canonical stem: most members, ties → lexicographically first key.
    const canonical = [group, ...candidates].sort(
      (a, b) =>
        b.members.length - a.members.length ||
        a.groupKey.localeCompare(b.groupKey),
    )[0];
    const absorb = [group, ...candidates].filter(g => g !== canonical);
    canonical.members.push(...absorb.flatMap(g => g.members));
    merged.add(group);
    for (const g of candidates) merged.add(g);
    result.push(canonical);
  }
  return result;
}

// ─── Cohort CRUD ───────────────────────────────────────────────────────────────

function insertCohortRow(
  workspaceId: string,
  batchId: string,
  group: FamilyGroup,
  membershipHash: string,
  status: string,
): CurationCohort {
  const db = getDb();
  const id = randomUUID();
  const created = now();
  // Schema v4 (issue #31 cleanup F3): no started_at/completed_at columns —
  // execution timestamps belong solely to classification_cohort_runs.
  db.query(
    `INSERT INTO curation_cohorts
      (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
       status, blocked_reason, created_at, updated_at, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
  ).run(id, workspaceId, batchId, group.groupKey, group.groupLabel, GROUPING_VERSION, membershipHash, status, created, created);
  return mapCohortRow(db.query('SELECT * FROM curation_cohorts WHERE id = ?').get(id) as Record<string, any>);
}

function insertCohortMembers(cohortId: string, group: FamilyGroup): void {
  const db = getDb();
  const created = now();
  const stmt = db.query(
    `INSERT INTO curation_cohort_members
      (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem,
       membership_reason_json, extraction_hash, ordinal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  group.members.forEach((member, ordinal) => {
    stmt.run(
      cohortId,
      member.item.id,
      member.item.upc || null,
      group.normalizedBrand,
      group.normalizedNameStem,
      JSON.stringify({ kind: 'deterministic_grouping', groupingVersion: GROUPING_VERSION }),
      member.extractionHash,
      ordinal,
      created,
    );
  });
}

/**
 * Refresh an existing cohort's member rows in place when the member IDENTITY
 * set is unchanged: re-sync `product_sku`, `normalized_*`, `extraction_hash`
 * (candidate readiness state) and `ordinal` to the current items. No new row,
 * no supersession (issue #30 round-2 F4).
 */
function refreshCohortMembersInPlace(cohortId: string, group: FamilyGroup): void {
  const db = getDb();
  const stmt = db.query(
    `UPDATE curation_cohort_members
     SET product_sku = ?, normalized_brand = ?, normalized_name_stem = ?,
         extraction_hash = ?, ordinal = ?
     WHERE cohort_id = ? AND onboarding_item_id = ?`,
  );
  group.members.forEach((member, ordinal) => {
    stmt.run(
      member.item.upc || null,
      group.normalizedBrand,
      group.normalizedNameStem,
      member.extractionHash,
      ordinal,
      cohortId,
      member.item.id,
    );
  });
}

/**
 * Upsert the ACTIVE candidate cohort for every current family group in the
 * batch:
 * - membership unchanged → refresh member rows in place (`extraction_hash`,
 *   `normalized_*`, ordinal — evidence progress is candidate readiness state,
 *   not a membership revision) and touch `updated_at` only;
 * - membership changed    → mark the old active cohort `superseded`, insert a
 *   NEW cohort row with fresh members;
 * - no active cohort      → insert one.
 *
 * Active cohorts whose group_key is no longer produced by the current grouping
 * are superseded as well (supersede-on-change, never in-place mutation).
 *
 * New cohorts start with status `'forming'`; the service
 * (src/onboarding/curation-cohort-service.ts) evaluates readiness afterwards.
 *
 * Concurrent refreshes of the same batch race through the unique active-group
 * index; the loser gets a UNIQUE constraint failure and is retried against the
 * committed state instead of propagating a write error into extraction/
 * curation.
 */
export function refreshCandidateCohorts(
  workspaceId: string,
  batchId: string,
  items: OnboardingItem[],
): CurationCohort[] {
  // Epic #46 batch-analysis follow-up (GPT finding): a family whose members
  // ALL terminally failed (every item at stage_status 'failed') is DEAD — it
  // must not sit in 'waiting' forever and must not be re-created on every
  // refresh (insert/supersede churn). Dead groups are excluded from the
  // grouping entirely: their orphaned active cohort is superseded below
  // (blocked_reason preserved for audit), and recovery still works — when a
  // member is re-extracted (e.g. profile built), the group re-forms and a
  // fresh cohort is created and readiness-evaluated normally.
  const groups = groupItemsByFamily(items).filter(
    g => !g.members.every(m => m.item.stageStatus === 'failed'),
  );
  const activeKeys = new Set(groups.map(g => g.groupKey));

  const run = (): CurationCohort[] => {
    const db = getDb();
    const touched: CurationCohort[] = [];
    db.transaction(() => {
      // Supersede orphaned active cohorts (group no longer formed by grouping).
      // Epic #46 follow-up: an orphan whose members ALL terminally failed is
      // recorded with the deterministic terminal reason (audit trail) instead
      // of a stale "Waiting for N…" text.
      const activeRows = db.query(
        `SELECT * FROM curation_cohorts
         WHERE batch_id = ? AND grouping_version = ? AND status != 'superseded'`,
      ).all(batchId, GROUPING_VERSION) as Record<string, any>[];
      for (const row of activeRows) {
        if (!activeKeys.has(row.group_key)) {
          const failedMembers = db.query(
            `SELECT i.upc FROM curation_cohort_members m
             JOIN onboarding_items i ON i.id = m.onboarding_item_id
             WHERE m.cohort_id = ? AND i.stage_status = 'failed'
             ORDER BY m.ordinal`,
          ).all(row.id) as Array<{ upc: string }>;
          const terminalReason = failedMembers.length > 0
            ? `All ${failedMembers.length} family member(s) terminally failed (SKU: ${failedMembers.map(f => f.upc).join(', ')}) — family superseded`
            : null;
          db.query(
            `UPDATE curation_cohorts SET status = 'superseded', superseded_at = ?, updated_at = ?,
               blocked_reason = COALESCE(?, blocked_reason)
             WHERE id = ?`,
          ).run(now(), now(), terminalReason, row.id);
        }
      }

      for (const group of groups) {
        const membershipHash = computeMembershipHash(group.members.map(m => m.item.id));
        const existing = db.query(
          `SELECT * FROM curation_cohorts
           WHERE batch_id = ? AND group_key = ? AND grouping_version = ? AND status != 'superseded'
           ORDER BY created_at DESC LIMIT 1`,
        ).get(batchId, group.groupKey, GROUPING_VERSION) as Record<string, any> | undefined;

        if (existing) {
          if (existing.membership_hash === membershipHash) {
            refreshCohortMembersInPlace(existing.id, group);
            db.query('UPDATE curation_cohorts SET updated_at = ? WHERE id = ?').run(now(), existing.id);
            touched.push(mapCohortRow(db.query('SELECT * FROM curation_cohorts WHERE id = ?').get(existing.id) as Record<string, any>));
          } else {
            db.query(
              `UPDATE curation_cohorts SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ?`,
            ).run(now(), now(), existing.id);
            const cohort = insertCohortRow(workspaceId, batchId, group, membershipHash, 'forming');
            insertCohortMembers(cohort.id, group);
            touched.push(cohort);
          }
        } else {
          const cohort = insertCohortRow(workspaceId, batchId, group, membershipHash, 'forming');
          insertCohortMembers(cohort.id, group);
          touched.push(cohort);
        }
      }
    })();
    return touched;
  };

  for (let attempt = 0; ; attempt++) {
    try {
      return run();
    } catch (err) {
      const isUniqueRace = err instanceof Error && err.message.includes('UNIQUE constraint failed');
      if (isUniqueRace && attempt < 2) continue;
      throw err;
    }
  }
}

export function getCohortById(id: string): CurationCohort | null {
  const row = getDb().query('SELECT * FROM curation_cohorts WHERE id = ?').get(id) as Record<string, any> | undefined;
  return row ? mapCohortRow(row) : null;
}

export function listCohortsByBatch(
  batchId: string,
  options: { includeSuperseded?: boolean } = {},
): CurationCohort[] {
  const db = getDb();
  const rows = (options.includeSuperseded
    ? db.query('SELECT * FROM curation_cohorts WHERE batch_id = ? ORDER BY created_at ASC').all(batchId)
    : db.query("SELECT * FROM curation_cohorts WHERE batch_id = ? AND status != 'superseded' ORDER BY created_at ASC").all(batchId)) as Record<string, any>[];
  return rows.map(mapCohortRow);
}

export function listCohortsByWorkspace(workspaceId: string): CurationCohort[] {
  const rows = getDb().query(
    `SELECT * FROM curation_cohorts WHERE workspace_id = ? AND status != 'superseded' ORDER BY created_at ASC`,
  ).all(workspaceId) as Record<string, any>[];
  return rows.map(mapCohortRow);
}

/**
 * The active (non-superseded) cohort containing the given onboarding item, if
 * any. Used to derive per-item family state for the Pipeline Board.
 */
export function getActiveCohortForItem(itemId: string): CurationCohort | null {
  const row = getDb().query(
    `SELECT c.* FROM curation_cohorts c
     JOIN curation_cohort_members m ON m.cohort_id = c.id
     WHERE m.onboarding_item_id = ? AND c.status != 'superseded'
     ORDER BY c.created_at DESC LIMIT 1`,
  ).get(itemId) as Record<string, any> | undefined;
  return row ? mapCohortRow(row) : null;
}

/**
 * Item ids that are members of an ACTIVE candidate cohort NOT yet ready —
 * i.e. status `forming` or `waiting` (epic #46 audit fix: the legacy
 * per-item Curation claim path must hold these members so partial-family
 * Curation can never start). Superseded cohorts are excluded, and the unique
 * partial index `idx_curation_cohorts_active_group` guarantees at most one
 * active cohort per (batch, group_key, grouping_version) — so each member
 * appears at most once. Members of `ready` cohorts are NOT returned (they
 * may be claimed/curated).
 */
export function listWaitingCohortMemberIdsByWorkspace(workspaceId: string): string[] {
  const rows = getDb().query(
    `SELECT m.onboarding_item_id AS item_id
     FROM curation_cohort_members m
     JOIN curation_cohorts c ON c.id = m.cohort_id
     WHERE c.workspace_id = ? AND c.status != 'superseded'
       AND c.status IN ('forming', 'waiting')`,
  ).all(workspaceId) as Array<{ item_id: string }>;
  return rows.map(row => row.item_id);
}

export function getCohortMembers(cohortId: string): CurationCohortMember[] {
  const rows = getDb().query(
    'SELECT * FROM curation_cohort_members WHERE cohort_id = ? ORDER BY ordinal ASC',
  ).all(cohortId) as Record<string, any>[];
  return rows.map(mapCohortMemberRow);
}

/**
 * Bulk-load members for multiple cohorts in a single batched query (or chunked queries for large sets).
 */
export function getCohortMembersForCohorts(cohortIds: string[]): Map<string, CurationCohortMember[]> {
  const map = new Map<string, CurationCohortMember[]>();
  for (const id of cohortIds) map.set(id, []);
  if (cohortIds.length === 0) return map;

  const CHUNK_SIZE = 500;
  for (let i = 0; i < cohortIds.length; i += CHUNK_SIZE) {
    const chunk = cohortIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = getDb().query(
      `SELECT * FROM curation_cohort_members WHERE cohort_id IN (${placeholders}) ORDER BY ordinal ASC`,
    ).all(...chunk) as Record<string, any>[];

    for (const row of rows) {
      const member = mapCohortMemberRow(row);
      map.get(member.cohortId)?.push(member);
    }
  }

  return map;
}

export function updateCohortStatus(
  id: string,
  status: string,
  options: { blockedReason?: string | null } = {},
): void {
  const db = getDb();
  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const params: Array<string | null> = [status, now()];
  if (options.blockedReason !== undefined) {
    sets.push('blocked_reason = ?');
    params.push(options.blockedReason);
  }
  params.push(id);
  db.query(`UPDATE curation_cohorts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function markCohortSuperseded(id: string): void {
  getDb().query(
    `UPDATE curation_cohorts SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ? AND status != 'superseded'`,
  ).run(now(), now(), id);
}

// ─── Cohort shadow observations (epic #46 review round, Package B) ──────────
// PR4 C5 shadow mode is currently log-only; these functions make the
// deterministic cohort Execution Product Type observations DURABLE (one row
// per cohort per state CHANGE) so a shadow-enabled live batch is measurable.
// The repo owns the change-dedup: `insertCohortShadowObservationIfChanged`
// compares against the LATEST row for the cohort and skips an identical
// state — idempotent across worker restarts, not just within one poll loop.

export interface CohortShadowObservationRecord {
  id: string;
  workspaceId: string;
  cohortId: string;
  groupKey: string | null;
  groupLabel: string | null;
  status: string | null;
  memberCount: number;
  readyCount: number;
  executionTypeId: string | null;
  productTypeConfidence: number | null;
  outcome: string | null;
  membersJson: string | null;
  groupingVersion: string | null;
  observedAt: string;
}

export interface CohortShadowObservationInput {
  workspaceId: string;
  cohortId: string;
  groupKey: string | null;
  groupLabel: string | null;
  status: string | null;
  memberCount: number;
  readyCount: number;
  executionTypeId: string | null;
  productTypeConfidence: number | null;
  outcome: string | null;
  membersJson: string | null;
  groupingVersion: string | null;
  observedAt: string;
}

function mapShadowObservationRow(row: Record<string, unknown>): CohortShadowObservationRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    cohortId: String(row.cohort_id),
    groupKey: row.group_key as string | null,
    groupLabel: row.group_label as string | null,
    status: row.status as string | null,
    memberCount: Number(row.member_count ?? 0),
    readyCount: Number(row.ready_count ?? 0),
    executionTypeId: row.execution_type_id as string | null,
    productTypeConfidence: row.product_type_confidence === null || row.product_type_confidence === undefined
      ? null
      : Number(row.product_type_confidence),
    outcome: row.outcome as string | null,
    membersJson: row.members_json as string | null,
    groupingVersion: row.grouping_version as string | null,
    observedAt: String(row.observed_at),
  };
}

/** The latest shadow observation for a cohort (null when none exists yet). */
function latestShadowObservationForCohort(cohortId: string): CohortShadowObservationRecord | null {
  const row = getDb()
    .query(
      `SELECT * FROM cohort_shadow_observations
       WHERE cohort_id = ?
       ORDER BY observed_at DESC, id DESC
       LIMIT 1`,
    )
    .get(cohortId) as Record<string, unknown> | null;
  return row ? mapShadowObservationRow(row) : null;
}

/**
 * Persist a shadow observation ONLY when it differs from the latest row for
 * the same cohort (state-change semantics — mirrors the log-on-change
 * behavior of the worker's `shadowObservedOutcomes` map, made durable and
 * restart-safe). Returns true when a row was inserted.
 */
export function insertCohortShadowObservationIfChanged(
  input: CohortShadowObservationInput,
): boolean {
  const db = getDb();
  const latest = latestShadowObservationForCohort(input.cohortId);
  if (latest) {
    const unchanged =
      latest.outcome === input.outcome &&
      latest.executionTypeId === input.executionTypeId &&
      latest.memberCount === input.memberCount &&
      latest.membersJson === input.membersJson &&
      latest.groupKey === input.groupKey &&
      latest.groupingVersion === input.groupingVersion &&
      // Review round 2 (MEDIUM-2): the full observable state participates in
      // the fingerprint — status/readyCount/confidence transitions are
      // rollout-relevant even when members and type are unchanged.
      latest.status === input.status &&
      latest.readyCount === input.readyCount &&
      latest.productTypeConfidence === input.productTypeConfidence;
    if (unchanged) return false;
  }
  const id = randomUUID();
  db.query(
    `INSERT INTO cohort_shadow_observations
     (id, workspace_id, cohort_id, group_key, group_label, status, member_count,
      ready_count, execution_type_id, product_type_confidence, outcome,
      members_json, grouping_version, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.cohortId,
    input.groupKey,
    input.groupLabel,
    input.status,
    input.memberCount,
    input.readyCount,
    input.executionTypeId,
    input.productTypeConfidence,
    input.outcome,
    input.membersJson,
    input.groupingVersion,
    input.observedAt,
  );
  return true;
}

/** Newest-first shadow observations for a workspace (cap = limit). */
export function listCohortShadowObservations(
  workspaceId: string,
  limit = 50,
): CohortShadowObservationRecord[] {
  const rows = getDb()
    .query(
      `SELECT * FROM cohort_shadow_observations
       WHERE workspace_id = ?
       ORDER BY observed_at DESC, id DESC
       LIMIT ?`,
    )
    .all(workspaceId, limit) as Record<string, unknown>[];
  return rows.map(mapShadowObservationRow);
}
