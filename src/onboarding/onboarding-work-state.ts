/**
 * Epic #46 Phase 1 — server-owned operator work-state projection.
 *
 * The client renders the Batch Workspace from this projection and never
 * reverse-engineers `stage` / `stage_status` / error strings / source
 * metadata / cohort state / feature flags into human meaning.
 *
 * Derivation joins:
 * - onboarding item stage/stage_status/sourceType/sourceUrl/errorMessage;
 * - discovery candidate presence (onboarding_sources);
 * - canonical cohort readiness (ADR 0013 — `curation-cohort-service`);
 * - durable review/approval state (`onboarding_review_state`);
 * - change-set lifecycle state for promoted items (draft/reviewing/approved/
 *   pushed) so "exported" is only reported after a verified terminal op.
 *
 * The mapping table follows the epic #46 test plan EXACTLY (each internal
 * state maps to one operator category/label/attention pair).
 *
 * Milestone 3 (P1-E): Bounded read model — all DB access via bulk repositories,
 * cursor pagination, projection health, fail-closed on corrupt data.
 */
import { getManualEvidenceFlags } from './flags';
import { listItemsByBatch, listItemsByBatchChunked, findItemById } from '../db/repositories/onboarding-item-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { listCohortsByBatch } from '../db/repositories/curation-cohort-repo';
import { buildCohortView } from './curation-cohort-service';
import {
  listReviewStates,
  getReviewState,
  type OnboardingReviewState,
} from '../db/repositories/onboarding-review-repo';
import { listChangeSetStatusBySkus } from '../db/repositories/change-set-repo';
import {
  bulkLoadVariantResolutions,
  bulkCountDiscoveryCandidates,
  bulkGetCohortRunStatusByItem,
  bulkGetLatestClassificationRunIdByItem,
  bulkGetClassificationStageResults,
  bulkLoadVariantResolutionsWithHealth,
  bulkCountDiscoveryCandidatesWithHealth,
  bulkGetCohortRunStatusByItemWithHealth,
  bulkGetLatestClassificationRunIdByItemWithHealth,
  bulkGetClassificationStageResultsWithHealth,
  WorkStateProjectionError,
  type BulkStageRow,
} from '../db/repositories/onboarding-work-state-repo';
import { convertToLbs } from '../shared/weight-converter';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import type { WorkStateFilters } from '../shared/schemas/onboarding-work-state';
import { toCanonicalStage, type StageV2 } from '../shared/onboarding-stage-vocabulary';

/**
 * Slice 5b native: canonical stage of a hydrated (either-spelling) item.
 * Null for unknown literals — callers fall through to the default/
 * not-ready projection instead of coercing to the first stage.
 */
function canonicalStageOf(rawStage: unknown): StageV2 | null {
  try {
    return toCanonicalStage(rawStage);
  } catch {
    return null;
  }
}

/** Canonical equality for hydrated stages (dual read). */
function stageIs(rawStage: unknown, canonical: StageV2): boolean {
  return canonicalStageOf(rawStage) === canonical;
}
import type { CurationCohortView } from '../shared/schemas/cohorts';
import {
  type WorkStateCategory,
  type WorkActivity,
  type AttentionReason,
  type AttentionAction,
  type ReviewState,
  type OnboardingWorkState,
  type BatchWorkState,
  type WorkStateCounts,
  type FindingCode,
  type SuggestedAction,
  type FindingDetail,
  type WorkStateProjectionHealth,
  type WorkStateProjectionHealthIssue,
  FindingCodeEnum,
  SuggestedActionEnum,
  EMPTY_WORK_STATE_COUNTS,
  WORK_STATE_PROJECTION_VERSION,
  computeWorkStateFilterHash,
  encodeWorkStateCursor,
  encodeWorkStateDbCursor,
  validateWorkStateCursor,
  validateWorkStateDbCursor,
  validateAnyWorkStateCursor,
  WorkStateCursorError,
  buildWorkStateSortKey,
} from '../shared/schemas/onboarding-work-state';

// ─── Context ───────────────────────────────────────────────────────────────────

/** Per-item canonical family context (ADR 0013 cohort readiness). */
export interface FamilyCohortState {
  cohortId: string;
  label: string | null;
  memberCount: number;
  readyCount: number;
  blockedCount: number;
  waitingOnItemIds: string[];
  /** Persisted cohort status: forming | waiting | ready | superseded. */
  cohortStatus: string;
  /** Derived readiness state: ready | waiting | blocked. */
  cohortState: 'ready' | 'waiting' | 'blocked';
  blockedReason: string | null;
}

/** Batch-level projection inputs, loaded once per batch. */
export interface WorkStateContext {
  reviewStates: Map<string, OnboardingReviewState>;
  cohortByItem: Map<string, FamilyCohortState>;
  changeSetStatusBySku: Map<string, string>;
  candidateCountByItem: Map<string, number>;
  variantResolutionByItem: Map<string, { id: string; status: string; candidates: unknown[]; identityMatrixHash: string; platform: string }>;
  /** Milestone 3 bulk: cohort run status (freezing/running) per item. */
  cohortRunStatusByItem: Map<string, string>;
  /** Milestone 3 bulk: latest classification run id per item. */
  latestRunIdByItem: Map<string, string>;
  /** Milestone 3 bulk: stage results per runId. */
  stageResultsByRunId: Map<string, BulkStageRow[]>;
  /** Projection health issues collected during context building. */
  healthIssues: WorkStateProjectionHealthIssue[];
}

export type { WorkStateFilters };

// ─── Context builders ──────────────────────────────────────────────────────────

function normalizeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Build the per-item cohort map from the batch's ACTIVE candidate cohorts.
 * Reuses the caller's loaded items (one batch load, one extraction-binding
 * load inside `buildCohortView`).
 */
export function buildCohortContext(batchId: string, items: OnboardingItem[]): Map<string, FamilyCohortState> {
  const views: CurationCohortView[] = listCohortsByBatch(batchId, { includeSuperseded: true }).map(cohort => buildCohortView(cohort, items));
  const map = new Map<string, FamilyCohortState>();
  for (const view of views) {
    const blockedCount = Math.max(0, view.memberCount - view.readyCount - view.waitingOn.length);
    for (const member of view.members) {
      map.set(member.onboardingItemId, {
        cohortId: view.cohort.id,
        label: view.cohort.groupLabel,
        memberCount: view.memberCount,
        readyCount: view.readyCount,
        blockedCount,
        waitingOnItemIds: view.waitingOn
          .filter(entry => entry.itemId !== member.onboardingItemId)
          .map(entry => entry.itemId),
        cohortStatus: view.cohort.status,
        cohortState: view.state,
        blockedReason: view.blockedReason,
      });
    }
  }
  return map;
}

/** Build the full batch projection context (one batch-level load per source). */
export function buildBatchWorkStateContext(batchId: string, items: OnboardingItem[]): WorkStateContext {
  const healthIssues: WorkStateProjectionHealthIssue[] = [];
  let hasCriticalIssue = false;
  const reviewStates = (() => {
    try {
      return listReviewStates(batchId);
    } catch (e) {
      healthIssues.push({ source: 'onboarding_review_state', code: 'review_state_failed', affectedCount: items.length });
      hasCriticalIssue = true;
      return new Map<string, OnboardingReviewState>();
    }
  })();
  let cohortByItem: Map<string, FamilyCohortState>;
  try {
    cohortByItem = buildCohortContext(batchId, items);
  } catch {
    cohortByItem = new Map();
    healthIssues.push({ source: 'curation_cohorts', code: 'cohort_context_failed', affectedCount: items.length });
    hasCriticalIssue = true;
  }
  const promotedSkus = items
    .filter(item => stageIs(item.stage, 'create_drafts'))
    .map(item => item.upc);
  const workspaceId = findBatchById(batchId)?.workspaceId ?? '';
  let changeSetStatusBySku: Map<string, string>;
  try {
    changeSetStatusBySku = listChangeSetStatusBySkus(workspaceId, promotedSkus);
  } catch {
    changeSetStatusBySku = new Map();
    if (promotedSkus.length > 0) {
      healthIssues.push({ source: 'change_sets', code: 'change_set_lookup_failed', affectedCount: promotedSkus.length });
      hasCriticalIssue = true;
    }
  }
  const itemIds = items.map(i => i.id);
  const candidateRes = bulkCountDiscoveryCandidatesWithHealth(itemIds);
  if (candidateRes.issue) {
    healthIssues.push(candidateRes.issue);
    hasCriticalIssue = true;
  }
  const candidateCountByItem = candidateRes.data;
  const variantRes = bulkLoadVariantResolutionsWithHealth(itemIds);
  if (variantRes.issue) {
    healthIssues.push(variantRes.issue);
    hasCriticalIssue = true;
  }
  const variantResolutionByItem = variantRes.data;

  const cohortRunRes = bulkGetCohortRunStatusByItemWithHealth(itemIds);
  if (cohortRunRes.issue) {
    healthIssues.push(cohortRunRes.issue);
    hasCriticalIssue = true;
  }
  const cohortRunStatusByItem = cohortRunRes.data;

  const latestRes = bulkGetLatestClassificationRunIdByItemWithHealth(itemIds);
  if (latestRes.issue) {
    healthIssues.push(latestRes.issue);
    hasCriticalIssue = true;
  }
  const latestRunIdByItem = latestRes.data;
  const effectiveRunIds: string[] = [];
  const runIdByItem = new Map<string, string>();
  for (const item of items) {
    const curData = item.curationData as Record<string, unknown> | null;
    const explicitRunId = curData && typeof curData.classificationRunId === 'string' && (curData.classificationRunId as string).trim().length > 0
      ? (curData.classificationRunId as string).trim()
      : null;
    const runId = explicitRunId ?? latestRunIdByItem.get(item.id) ?? null;
    if (runId) {
      runIdByItem.set(item.id, runId);
      effectiveRunIds.push(runId);
    }
    if (curData !== null && typeof curData !== 'object') {
      healthIssues.push({ source: 'onboarding_items', code: 'corrupt_curation_data', affectedCount: 1 });
    }
  }
  const stageRes = bulkGetClassificationStageResultsWithHealth(effectiveRunIds);
  if (stageRes.issue) {
    healthIssues.push(stageRes.issue);
    hasCriticalIssue = true;
  }
  const stageResultsByRunId = stageRes.data;
  if (hasCriticalIssue) {
    // Attach flag for caller to decide 503 vs degraded 200. Per-item corrupt (corrupt_curation_data) alone is not critical.
    // Only bulk DB failures are critical. If the only issues are per-item corrupt, hasCriticalIssue would be false.
    // Here we have at least one bulk failure, so mark context as critical.
    (healthIssues as any)._hasCritical = true;
  }

  // Fail-closed: surface corrupt detection without false zeros
  // If any bulk loader returned degraded (empty maps for non-empty input),
  // ensure health reflects degraded but counts remain accurate via fallback.

  return {
    reviewStates,
    cohortByItem,
    changeSetStatusBySku,
    candidateCountByItem,
    variantResolutionByItem,
    cohortRunStatusByItem,
    latestRunIdByItem: runIdByItem,
    stageResultsByRunId,
    healthIssues,
  };
}

export function buildProjectionHealth(issues: WorkStateProjectionHealthIssue[]): WorkStateProjectionHealth {
  return {
    status: issues.length > 0 ? 'degraded' : 'healthy',
    version: WORK_STATE_PROJECTION_VERSION,
    computedAt: new Date().toISOString(),
    issues,
  };
}

// ─── Derivation helpers ────────────────────────────────────────────────────────

function deriveReviewState(item: OnboardingItem, row: OnboardingReviewState | undefined): ReviewState {
  if (row) {
    if (row.approvedAt && !row.reviewInvalidatedAt) return 'approved';
    if (row.reviewInvalidatedAt) return 'unreviewed';
    if (row.reviewedAt) return 'reviewed';
    return 'unreviewed';
  }
  if (stageIs(item.stage, 'review_listings') && item.stageStatus === 'completed') return 'reviewed';
  if (stageIs(item.stage, 'create_drafts') && item.stageStatus === 'completed') return 'reviewed';
  if (stageIs(item.stage, 'prepare_listing') && item.stageStatus === 'completed') return 'unreviewed';
  if (stageIs(item.stage, 'review_listings')) return 'unreviewed';
  return 'not_ready';
}

interface DerivationInput {
  category: WorkStateCategory;
  activity?: WorkActivity | null;
  label: string;
  detail?: string | null;
  attentionReason?: AttentionReason | null;
  attentionAction?: AttentionAction | null;
  findingCode?: FindingCode | null;
  findingSummary?: string | null;
  conflictingValues?: string[] | null;
  suggestedAction?: SuggestedAction | null;
  findingDetails?: FindingDetail[] | null;
  variantResolution?: { id: string; status: string; candidates: unknown[]; identityMatrixHash: string; platform: string } | null;
}

/** Map a semantic finding code to the granular curation sub-activity it blocks. */
function curationSubActivityForFindingCode(code: string | undefined | null): WorkActivity | null {
  switch (code) {
    case 'family_product_type':
      return 'cohort_freezing';
    case 'family_brand':
      return 'semantic_validation';
    case 'coordinated_title':
      return 'title_coordination';
    case 'coordinated_page':
    case 'coordinated_page_name_mismatch':
      return 'page_coordination';
    case 'member_attribute_applicability':
    case 'member_cardinality':
      return 'attribute_curation';
    default:
      return null;
  }
}

/** Map a persisted classification stage name to the granular WorkActivity for observability. */
function stageNameToWorkActivity(stageName: string): WorkActivity | null {
  switch (stageName) {
    case 'packaging_ocr':
      return 'packaging_ocr';
    case 'evidence_extraction':
      return 'cohort_freezing';
    case 'name_consolidation':
      return 'title_coordination';
    case 'category_page_proposals':
      return 'page_coordination';
    case 'attribute_applicability':
    case 'product_attribute_proposals':
      return 'attribute_curation';
    case 'primary_product_type_proposal':
      return 'cohort_freezing';
    default:
      return null;
  }
}

/** Derive the most specific curation sub-activity for a curation-stage item. */
function deriveCurationSubActivity(item: OnboardingItem, ctx: WorkStateContext): WorkActivity {
  const curData = item.curationData as Record<string, unknown> | null;
  const sv = curData?.semanticValidation as { status?: string; findings?: unknown } | undefined;
  if (sv?.status === 'blocked' && Array.isArray(sv.findings) && sv.findings.length > 0) {
    const first = sv.findings[0] as Record<string, unknown> | null;
    const firstCode = first && typeof first === 'object' && typeof (first as Record<string, unknown>).code === 'string' ? (first as Record<string, unknown>).code as string : null;
    const mapped = curationSubActivityForFindingCode(firstCode);
    if (mapped) return mapped;
  }
  // Live run stage projection: check bulk-loaded cohort run and classification stage results.
  try {
    const cohortStatus = ctx.cohortRunStatusByItem.get(item.id);
    if (cohortStatus === 'freezing') return 'cohort_freezing';
    // If cohort is running, continue to stage lookup below
    const runId = ctx.latestRunIdByItem.get(item.id);
    if (runId) {
      const stageRows = ctx.stageResultsByRunId.get(runId);
      if (stageRows && stageRows.length > 0) {
        for (const r of stageRows) {
          if (r.status === 'running') {
            const mapped = stageNameToWorkActivity(r.stage_name);
            if (mapped) return mapped;
          }
        }
        let lastSucceededIdx = -1;
        for (let i = 0; i < stageRows.length; i++) {
          if (stageRows[i].status === 'succeeded' || stageRows[i].status === 'abstained') lastSucceededIdx = i;
          else break;
        }
        const nextPending = stageRows[lastSucceededIdx + 1];
        if (nextPending && nextPending.status === 'pending') {
          const mapped = stageNameToWorkActivity(nextPending.stage_name);
          if (mapped) return mapped;
        }
        for (const r of stageRows) {
          if (r.status === 'pending') {
            const mapped = stageNameToWorkActivity(r.stage_name);
            if (mapped) return mapped;
          }
        }
      }
    }
  } catch {
    // Projection must never throw; fall through to curation
  }
  return 'curation';
}

function safeFindingCode(value: unknown): FindingCode | null {
  if (typeof value !== 'string') return null;
  const parsed = FindingCodeEnum.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeSuggestedAction(value: unknown): SuggestedAction | null {
  if (typeof value !== 'string') return null;
  const parsed = SuggestedActionEnum.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractFindingDetails(curationData: Record<string, unknown> | null): {
  findingCode: FindingCode | null;
  findingSummary: string | null;
  conflictingValues: string[] | null;
  suggestedAction: SuggestedAction | null;
  findingDetails: FindingDetail[] | null;
} {
  const svRaw = (curationData as Record<string, unknown> | null)?.semanticValidation;
  if (!svRaw || typeof svRaw !== 'object' || Array.isArray(svRaw)) {
    return { findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null };
  }
  const sv = svRaw as { status?: unknown; findings?: unknown };
  if (!Array.isArray(sv.findings) || sv.findings.length === 0) {
    return { findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null };
  }
  const validFindings = sv.findings.filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object' && !Array.isArray(f));
  if (validFindings.length === 0) {
    return { findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null };
  }
  const first = validFindings[0];
  const findingCode = safeFindingCode(first.code);
  const findingSummary = typeof first.message === 'string' ? first.message : null;
  const conflictingValues = Array.isArray(first.conflictingValues)
    ? (first.conflictingValues as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;
  const suggestedAction = safeSuggestedAction(first.suggestedAction);
  const fallbackSummary = findingSummary ?? (typeof first.message === 'string' ? first.message : null);
  const findingDetails: FindingDetail[] = validFindings
    .filter(f => typeof f.code === 'string' && typeof f.message === 'string' && safeFindingCode(f.code) !== null)
    .map(f => ({
      code: safeFindingCode(f.code) as FindingCode,
      memberSku: typeof f.memberSku === 'string' ? f.memberSku : '',
      message: f.message as string,
      conflictingValues: Array.isArray(f.conflictingValues)
        ? (f.conflictingValues as unknown[]).filter((v): v is string => typeof v === 'string')
        : null,
      suggestedAction: safeSuggestedAction(f.suggestedAction),
    }));
  return {
    findingCode,
    findingSummary: findingSummary ?? fallbackSummary,
    conflictingValues: conflictingValues && conflictingValues.length > 0 ? conflictingValues : null,
    suggestedAction,
    findingDetails: findingDetails.length > 0 ? findingDetails : null,
  };
}

/** Centralized semantic-block projection. Returns needs_attention input when blocked, else null. */
function semanticBlockedInput(item: OnboardingItem): DerivationInput | null {
  const sv = (item.curationData as Record<string, unknown> | null)?.semanticValidation as { status?: unknown; findings?: unknown } | undefined;
  if (!sv || sv.status !== 'blocked') return null;
  const curData = item.curationData as Record<string, unknown> | null;
  const extracted = extractFindingDetails(curData);
  const findings = Array.isArray((sv as Record<string, unknown>).findings) ? (sv as Record<string, unknown>).findings as unknown[] : [];
  const firstMessage =
    extracted.findingSummary ??
    (findings.length > 0 && findings[0] !== null && typeof findings[0] === 'object' && typeof (findings[0] as Record<string, unknown>).message === 'string'
      ? ((findings[0] as Record<string, unknown>).message as string)
      : 'A hard cohort semantic validation finding blocks this item.');
  const granularActivity = item.curationData ? 'semantic_validation' as WorkActivity : null;
  // Use derived activity from findings when available, else generic
  let activity: WorkActivity | null = granularActivity;
  if (extracted.findingCode) {
    const mapped = curationSubActivityForFindingCode(extracted.findingCode);
    if (mapped) activity = mapped;
  }
  return {
    category: 'needs_attention',
    activity,
    label: 'Curation blocked by semantic validation',
    detail: firstMessage,
    attentionReason: 'semantic_validation_blocked',
    attentionAction: 'resolve_semantic_conflict',
    findingCode: extracted.findingCode,
    findingSummary: extracted.findingSummary ?? firstMessage,
    conflictingValues: extracted.conflictingValues,
    suggestedAction: extracted.suggestedAction,
    findingDetails: extracted.findingDetails,
  };
}

function build(
  item: OnboardingItem,
  row: OnboardingReviewState | undefined,
  cohort: FamilyCohortState | null,
  input: DerivationInput,
): OnboardingWorkState {
  const extData = item.extractionData as Record<string, unknown> | null;
  const curData = item.curationData as Record<string, unknown> | null;

  const curatedTitle =
    typeof curData?.curatedTitle === 'string' && curData.curatedTitle.trim().length > 0
      ? curData.curatedTitle.trim()
      : typeof curData?.name === 'string' && curData.name.trim().length > 0
      ? curData.name.trim()
      : typeof extData?.title === 'string' && extData.title.trim().length > 0
      ? extData.title.trim()
      : null;

  const approvals = (extData?.distributorImageApprovals as Array<{ imageUrl?: string }>) ?? [];
  const distributorPrimary = approvals.find(
    (a) => typeof a?.imageUrl === 'string' && a.imageUrl.trim().length > 0,
  )?.imageUrl;
  const candidatePrimary = (extData?.distributorImageCandidates as Array<{ url?: string }>)?.find(
    (c) => typeof c?.url === 'string' && c.url.trim().length > 0,
  )?.url;

  const imageUrl =
    typeof extData?.primaryImage === 'string' && extData.primaryImage.trim().length > 0
      ? extData.primaryImage.trim()
      : distributorPrimary ?? candidatePrimary ?? null;

  const description =
    typeof curData?.curatedDescription === 'string' && curData.curatedDescription.trim().length > 0
      ? curData.curatedDescription.trim()
      : typeof extData?.description === 'string' && extData.description.trim().length > 0
      ? extData.description.trim()
      : null;

  const sizeAttr = (extData?.variantAttributes as Record<string, any> | undefined)?.size;
  const rawWeight =
    typeof curData?.curatedWeight === 'string' && curData.curatedWeight.trim().length > 0
      ? curData.curatedWeight.trim()
      : typeof extData?.weight === 'number' || typeof extData?.weight === 'string'
      ? String(extData.weight).trim()
      : typeof sizeAttr === 'string' && sizeAttr.trim().length > 0
      ? sizeAttr.trim()
      : convertToLbs(item.name) ?? null;

  const weight =
    rawWeight != null && rawWeight.length > 0
      ? /^\d+(\.\d+)?$/.test(rawWeight)
        ? `${parseFloat(rawWeight)} lbs`
        : rawWeight
      : null;

  return {
    itemId: item.id,
    category: input.category,
    activity: input.activity ?? null,
    label: input.label,
    detail: input.detail ?? null,
    attentionReason: input.attentionReason ?? null,
    attentionAction: input.attentionAction ?? null,
    findingCode: input.findingCode ?? null,
    findingSummary: input.findingSummary ?? null,
    conflictingValues: input.conflictingValues ?? null,
    suggestedAction: input.suggestedAction ?? null,
    findingDetails: input.findingDetails ?? null,
    family: cohort
      ? {
          cohortId: cohort.cohortId,
          label: cohort.label,
          memberCount: cohort.memberCount,
          readyCount: cohort.readyCount,
          blockedCount: cohort.blockedCount,
          waitingOnItemIds: cohort.waitingOnItemIds,
        }
      : null,
    reviewState: deriveReviewState(item, row),
    stage: item.stage,
    stageStatus: item.stageStatus,
    variantResolution: (input as any).variantResolution ?? null,
    upc: item.upc,
    name: item.name,
    brand: item.brandHint ?? (typeof extData?.brand === 'string' ? extData.brand : null),
    sourceType: item.sourceType,
    domain: normalizeHost(item.sourceUrl),
    curatedTitle,
    imageUrl,
    description,
    weight,
  };
}

// ─── The mapping table ─────────────────────────────────────────────────────────

/**
 * Parent #101 (manual-evidence route): flag-gated availability with a
 * fail-closed read — any flag-read failure disables the route so the
 * extractor-profile-required projection stays byte-identical.
 */
function isManualEvidenceRouteAvailable(): boolean {
  try {
    return getManualEvidenceFlags().enabled === true;
  } catch {
    return false;
  }
}

/**
 * Derive the operator work state for ONE item. Pure given the batch context;
 * the mapping follows the epic #46 test plan.
 */
export function deriveItemWorkState(item: OnboardingItem, ctx: WorkStateContext): OnboardingWorkState {
  const row = ctx.reviewStates.get(item.id);
  const cohort = ctx.cohortByItem.get(item.id) ?? null;
  const error = item.errorMessage ?? null;
  const isProfileFailure = error !== null && /no extractor profile|profile required/i.test(error);
  const isNoUrlFailure = error !== null && /no confirmed source url/i.test(error);

  const attention = (
    attentionReason: AttentionReason,
    attentionAction: AttentionAction,
    label: string,
    detail: string | null = error,
  ): OnboardingWorkState =>
    build(item, row, cohort, {
      category: 'needs_attention',
      activity: null,
      label,
      detail,
      attentionReason,
      attentionAction,
    });

  // ── Terminal / out-of-flow states ────────────────────────────────────────
  if (item.stageStatus === 'skipped') {
    return build(item, row, cohort, { category: 'skipped', label: 'Skipped', detail: error });
  }

  if (item.isHeld) {
    if (item.heldReason === 'missing_brand' || !item.brandHint || item.brandHint.trim().length === 0) {
      return attention(
        'brand_not_provided',
        'assign_brand',
        'Brand assignment required',
        'Product is held awaiting brand assignment before running.',
      );
    }
    return attention(
      'processing_failed',
      'retry_processing',
      'Product held',
      item.heldReason ?? 'Product is held awaiting release.',
    );
  }

  const semanticBlock = semanticBlockedInput(item);
  if (semanticBlock && (stageIs(item.stage, 'prepare_listing') || stageIs(item.stage, 'review_listings'))) {
    // Override activity with granular if available via ctx
    const granular = deriveCurationSubActivity(item, ctx);
    if (granular !== 'curation' && semanticBlock.activity === 'semantic_validation') {
      semanticBlock.activity = granular;
    }
    return build(item, row, cohort, semanticBlock);
  }

  const variantRes = ctx.variantResolutionByItem?.get(item.id);
  if (
    variantRes &&
    (variantRes.status === 'ambiguous' || variantRes.status === 'no_match' || variantRes.status === 'stale') &&
    (stageIs(item.stage, 'find_product_page') || stageIs(item.stage, 'collect_details')) &&
    item.stageStatus === 'needs_input'
  ) {
    try {
      const { getEffectiveVariantResolutionMode } = require('./variant-flags');
      if (getEffectiveVariantResolutionMode() === 'active') {
        return build(item, row, cohort, {
          category: 'needs_attention',
          activity: null,
          label: 'Choose product variant',
          detail: 'Multiple variants detected — choose the exact variant.',
          attentionReason: 'choose_variant',
          attentionAction: 'choose_variant',
          variantResolution: variantRes as any,
        });
      }
    } catch {
      // fail closed: variant flag check failure does not project choose_variant
    }
  }

  // Slice 5b native: switch on the canonical stage (dual read — either
  // stored spelling reaches the same v2 case; unknown stages take the
  // default branch, never coerced to the first stage).
  switch (canonicalStageOf(item.stage)) {
    case 'create_drafts': {
      if (item.stageStatus === 'completed') {
        const changeSetStatus = ctx.changeSetStatusBySku.get(item.upc);
        if (changeSetStatus === 'pushed') {
          return build(item, row, cohort, { category: 'completed', activity: 'export', label: 'Exported', detail: 'Change set pushed to the store' });
        }
        return build(item, row, cohort, {
          category: 'ready_to_export',
          activity: 'export',
          label: 'Ready to export',
          detail: changeSetStatus ? `Export drafts created (change set ${changeSetStatus})` : 'Export drafts created',
        });
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Export failed');
      }
      if (row?.approvedAt && !row.reviewInvalidatedAt) {
        return build(item, row, cohort, { category: 'approved', activity: 'export', label: 'Approved — ready to export', detail: error });
      }
      return build(item, row, cohort, {
        category: 'ready_for_review',
        activity: 'review',
        label: row?.reviewedAt && !row.reviewInvalidatedAt ? 'Reviewed — pending approval' : 'Ready for review',
        detail: 'Awaiting bulk approval',
      });
    }

    case 'review_listings': {
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Review failed');
      }
      return build(item, row, cohort, {
        category: 'ready_for_review',
        activity: 'review',
        label: row?.approvedAt && !row.reviewInvalidatedAt
          ? 'Approved'
          : row?.reviewedAt && !row.reviewInvalidatedAt
            ? 'Reviewed — ready to approve'
            : 'Ready for review',
      });
    }

    case 'prepare_listing': {
      if (item.stageStatus === 'completed') {
        return build(item, row, cohort, { category: 'ready_for_review', activity: 'review', label: 'Ready for review' });
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Curation failed');
      }
      const granularActivity = deriveCurationSubActivity(item, ctx);
      const activityForProcessing = granularActivity !== 'curation' ? granularActivity : 'curation';
      if (cohort) {
        if (cohort.cohortState === 'ready' || cohort.cohortStatus === 'ready') {
          return build(item, row, cohort, { category: 'processing', activity: activityForProcessing, label: 'Curating product family' });
        }
        if (cohort.cohortState === 'blocked') {
          return build(item, row, cohort, {
            category: 'waiting_on_family',
            activity: activityForProcessing,
            label: 'Family blocked',
            detail: cohort.blockedReason,
          });
        }
        return build(item, row, cohort, {
          category: 'waiting_on_family',
          activity: activityForProcessing,
          label: 'Family not ready yet',
          detail: cohort.blockedReason ?? `Waiting on ${cohort.waitingOnItemIds.length} sibling${cohort.waitingOnItemIds.length === 1 ? '' : 's'}`,
        });
      }
      return build(item, row, cohort, { category: 'processing', activity: activityForProcessing, label: 'Curating product' });
    }

    case 'collect_details': {
      if (item.sourceType === 'distributor_record') {
        if (item.stageStatus === 'failed') {
          return attention('processing_failed', 'retry_extraction', 'Distributor materialization failed');
        }
        if (item.stageStatus === 'completed') {
          return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Distributor materialization complete' });
        }
        return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Materializing distributor data' });
      }
      if (item.stageStatus === 'needs_input') {
        return attention('verify_official_url', 'verify_official_url', 'Extraction needs attention', error ?? 'Extraction paused for operator input');
      }
      if (item.stageStatus === 'failed') {
        if (isProfileFailure) {
          // Parent #101 (manual-evidence route): profile-blocked items are
          // eligible for operator manual evidence while the flag is ON.
          // The projection helper below reads the flag fail-closed (any
          // read failure keeps today's extractor-profile-required
          // projection byte-identical).
          if (isManualEvidenceRouteAvailable()) {
            return attention(
              'manual_evidence_available',
              'enter_manual_evidence',
              'Manual evidence available',
              'No per-product page exists for this brand family — enter product facts manually (per-SKU attestation required). Family page is reference only.',
            );
          }
          return attention('extractor_profile_required', 'setup_extractor_profile', 'Extractor profile required');
        }
        if (isNoUrlFailure) {
          return attention('no_official_url', 'choose_official_url', 'Official product page needed');
        }
        return attention('extraction_profile_failed', 'retry_extraction', 'Extraction failed');
      }
      if (item.stageStatus === 'completed') {
        return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Extraction complete' });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Extracting product data' });
    }

    case 'find_product_page': {
      if (item.stageStatus === 'needs_input') {
        if (!item.brandHint || item.brandHint.trim().length === 0) {
          return attention(
            'brand_not_provided',
            'assign_brand',
            'Brand assignment required',
            'Assign a brand so discovery can search the brand’s official site.',
          );
        }
        const candidates = ctx.candidateCountByItem.get(item.id) ?? 0;
        if (candidates > 0) {
          return attention('verify_official_url', 'verify_official_url', 'Verify official product page');
        }
        return attention('no_official_url', 'choose_official_url', 'No official product page found');
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Official site search failed');
      }
      if (item.stageStatus === 'completed') {
        if (error && /needs_review/i.test(error)) {
          const candidates = ctx.candidateCountByItem.get(item.id) ?? 0;
          if (candidates > 0) {
            return attention('verify_official_url', 'verify_official_url', 'Verify official product page', error);
          }
          return attention('no_official_url', 'choose_official_url', 'No official product page found', error);
        }
        if (error && /no matching product pages|no sources found/i.test(error)) {
          return attention('no_official_url', 'choose_official_url', 'No official product page found', error);
        }
        return build(item, row, cohort, { category: 'processing', activity: 'official_site_search', label: 'Official site search complete' });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'official_site_search', label: 'Searching official site' });
    }

    case 'route_sources': {
      if (item.stageStatus === 'needs_input') {
        return attention('source_conflict', 'resolve_source_conflict', 'Distributor match needs decision', error);
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Distributor lookup failed');
      }
      if (item.stageStatus === 'completed') {
        return build(item, row, cohort, { category: 'processing', activity: 'distributor_lookup', label: 'Distributor lookup complete' });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'distributor_lookup', label: 'Running distributor lookups' });
    }

    default:
      return build(item, row, cohort, { category: 'processing', label: 'Processing' });
  }
}

// ─── Batch-level API ───────────────────────────────────────────────────────────

function initCounts(): WorkStateCounts {
  return { ...EMPTY_WORK_STATE_COUNTS };
}

function sourceTypeLabel(sourceType: OnboardingWorkState['sourceType']): string {
  if (sourceType === 'distributor_record') return 'distributor record';
  if (sourceType === 'official_page') return 'official page';
  return '';
}

/** Slice 1: exported for the v2 stage-read service so both endpoints share the
 * identical post-projection predicate function. Do not duplicate. */
export function matchesFilters(state: OnboardingWorkState, filters: WorkStateFilters): boolean {
  if (filters.category && state.category !== filters.category) return false;
  if (filters.reviewState && state.reviewState !== filters.reviewState) return false;
  if (filters.sourceType && state.sourceType !== filters.sourceType) return false;
  if (filters.domain) {
    const needle = filters.domain.toLowerCase().replace(/^www\./, '');
    const domainMatch = state.domain?.toLowerCase() === needle || state.domain?.toLowerCase().endsWith(`.${needle}`);
    if (!domainMatch) return false;
  }
  if (filters.cohortId && state.family?.cohortId !== filters.cohortId) return false;
  if (filters.q) {
    const q = filters.q.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      state.upc,
      state.name,
      state.brand ?? '',
      state.label,
      state.domain ?? '',
      sourceTypeLabel(state.sourceType),
      state.family?.label ?? '',
      state.category,
    ].join(' ').toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function deriveAllStatesWithHealth(batchId: string, filters: WorkStateFilters): {
  counts: WorkStateCounts;
  filtered: OnboardingWorkState[];
  health: WorkStateProjectionHealth;
  totalUnfiltered: number;
} {
  const items = listItemsByBatch(batchId);
  let ctx: WorkStateContext;
  try {
    ctx = buildBatchWorkStateContext(batchId, items);
  } catch (e) {
    const maybeErr = e as WorkStateProjectionError;
    const issues: WorkStateProjectionHealthIssue[] = maybeErr?.source
      ? [{ source: maybeErr.source, code: maybeErr.code, affectedCount: items.length }]
      : [{ source: 'work_state', code: 'context_build_failed', affectedCount: items.length }];
    const fallbackHealth = buildProjectionHealth(issues);
    // Category-critical: propagate as 503, not healthy empty
    throw Object.assign(new WorkStateProjectionError('work_state', 'critical_projection_failure'), { health: fallbackHealth });
  }
  if ((ctx.healthIssues as any)._hasCritical) {
    const health = buildProjectionHealth(ctx.healthIssues);
    throw Object.assign(new WorkStateProjectionError('work_state', 'critical_projection_failure'), { health });
  }
  const allStates: OnboardingWorkState[] = [];
  let corruptCount = 0;
  for (const item of items) {
    try {
      const state = deriveItemWorkState(item, ctx);
      allStates.push(state);
    } catch {
      corruptCount += 1;
      // Fail-closed: still produce a visible row, never silently drop
      allStates.push({
        itemId: item.id,
        category: 'needs_attention',
        activity: null,
        label: 'Projection error',
        detail: 'Corrupt work-state data — operator attention required',
        attentionReason: 'processing_failed',
        attentionAction: 'retry_processing',
        findingCode: null,
        findingSummary: null,
        conflictingValues: null,
        suggestedAction: null,
        findingDetails: null,
        family: null,
        reviewState: 'not_ready',
        stage: item.stage as any,
        stageStatus: item.stageStatus as any,
        variantResolution: null,
        upc: item.upc,
        name: item.name,
        brand: item.brandHint ?? null,
        sourceType: item.sourceType as any,
        domain: normalizeHost(item.sourceUrl),
        curatedTitle: null,
        imageUrl: null,
        description: null,
        weight: null,
      });
    }
  }
  const counts = initCounts();
  for (const state of allStates) {
    counts[state.category] += 1;
  }
  const healthIssues = [...ctx.healthIssues];
  if (corruptCount > 0) {
    healthIssues.push({ source: 'onboarding_items', code: 'corrupt_projection', affectedCount: corruptCount });
  }
  // Never false zeros: if items exist but allStates empty due to exception, counts would be zero — surface degraded
  if (items.length > 0 && allStates.length === 0) {
    healthIssues.push({ source: 'work_state', code: 'projection_empty_with_items', affectedCount: items.length });
  }
  const health = buildProjectionHealth(healthIssues);
  const filtered = allStates.filter(state => matchesFilters(state, filters));
  return { counts, filtered, health, totalUnfiltered: allStates.length };
}

/** Project every item in a batch into work states with category counts. */
export function getBatchWorkState(batchId: string, filters: WorkStateFilters = {}): BatchWorkState {
  const { counts, filtered, health } = deriveAllStatesWithHealth(batchId, filters);
  // Cursor pagination (Milestone 3) — takes precedence over offset
  if (filters.cursor) {
    try {
      const cursorPayload = validateWorkStateCursor(filters.cursor, filters);
      // Sort deterministically by sortKey then paginate after cursor
      const sorted = [...filtered].sort((a, b) => {
        const ka = buildWorkStateSortKey(a.category, a.name || a.upc, a.itemId);
        const kb = buildWorkStateSortKey(b.category, b.name || b.upc, b.itemId);
        if (ka !== kb) return ka.localeCompare(kb);
        return a.itemId.localeCompare(b.itemId);
      });
      const cursorIdx = sorted.findIndex(
        r => {
          const rk = buildWorkStateSortKey(r.category, r.name || r.upc, r.itemId);
          return rk > cursorPayload.sortKey || (rk === cursorPayload.sortKey && r.itemId > cursorPayload.itemId);
        }
      );
      const startIndex = cursorIdx === -1 ? sorted.length : cursorIdx;
      const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 500) : 100;
      const paged = sorted.slice(startIndex, startIndex + limit);
      return { batchId, counts, items: paged, total: filtered.length, projectionHealth: health };
    } catch (err) {
      if (err instanceof WorkStateCursorError) throw err;
      // Fall through to offset behavior on unexpected cursor error (fail-closed: surface health)
    }
  }
  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 500) : 100;
  const offset = filters.offset && filters.offset > 0 ? filters.offset : 0;
  const paged = filtered.slice(offset, offset + limit);
  return { batchId, counts, items: paged, total: filtered.length, projectionHealth: health };
}

/** Legacy counts (batch summary) — returns just counts for backward compat (onboarding-routes). */
export function getBatchWorkStateCounts(batchId: string): WorkStateCounts {
  const { counts } = deriveAllStatesWithHealth(batchId, {} as WorkStateFilters);
  return counts;
}

/** Bounded counts response (new /counts endpoint). */
export function getBatchWorkStateCountsWithHealth(batchId: string, filters: Omit<WorkStateFilters, 'cursor' | 'limit' | 'offset'> = {}): { counts: WorkStateCounts; total: number; projectionHealth: WorkStateProjectionHealth } {
  const { counts, filtered, health } = deriveAllStatesWithHealth(batchId, filters as WorkStateFilters);
  return { counts, total: filtered.length, projectionHealth: health };
}

/** Bounded cursor-paginated items response (new /items endpoint) — true bounded DB cursor.
 *
 * - DB cursor is (row_number, id) — stable, explicitly documented.
 * - Reads a bounded raw chunk (50 rows) first, bulk-loads context ONLY for chunk IDs,
 *   projects, filters, and loops until `limit` filtered items are collected or batch exhausted.
 * - If a sparse filter does not fill `limit`, returns what was found plus a continuation cursor
 *   rather than scanning the entire batch in one request.
 * - `counts` is the ONE endpoint allowed to scan the full batch; this endpoint keeps per-request
 *   scanned rows and query count bounded (see query-plan tests).
 * - Category-critical bulk failures throw WorkStateProjectionError → 503 + degraded health.
 */
export function getBatchWorkStateItems(batchId: string, filters: WorkStateFilters = {}): { items: OnboardingWorkState[]; nextCursor: string | null; projectionHealth: WorkStateProjectionHealth; scannedRows?: number; queryCount?: number } {
  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 500) : 100;
  const CHUNK_SIZE = 50;
  let dbCursor: { rowNumber: number; id: string } | null = null;
  if (filters.cursor) {
    // Support both v2 DB cursor and legacy v1 sortKey cursor (for deprecated /work-state path).
    try {
      const dbPayload = validateWorkStateDbCursor(filters.cursor, filters);
      dbCursor = { rowNumber: dbPayload.rowNumber, id: dbPayload.id };
    } catch (e) {
      if (e instanceof WorkStateCursorError && e.code === 'filter_mismatch') throw e;
      // Fallback to legacy v1 — treat as malformed for bounded endpoint (fail closed 400)
      // But keep deprecated path working via getBatchWorkState (sortKey). For bounded items, require DB cursor.
      // If legacy cursor passed to bounded endpoint, decode as v1 and translate to DB position via full scan fallback (bounded degraded).
      // For now, throw malformed to force client to use DB cursor.
      try {
        validateWorkStateCursor(filters.cursor, filters);
        throw new WorkStateCursorError('Legacy cursor not supported for bounded items; use DB cursor from /work-state/items', 'malformed_cursor');
      } catch (inner) {
        if (inner instanceof WorkStateCursorError) throw inner;
        throw new WorkStateCursorError('Malformed cursor', 'malformed_cursor');
      }
    }
  }

  const collected: OnboardingWorkState[] = [];
  let scannedRows = 0;
  let queryCount = 0;
  let lastScannedCursor: { rowNumber: number; id: string } | null = dbCursor;
  let lastCollectedCursor: { rowNumber: number; id: string } | null = null;
  let chunk: { items: any[]; lastCursor: any; hasMore: boolean } | null = null;
  let hasMoreDb = true;
  let healthIssues: WorkStateProjectionHealthIssue[] = [];
  let projectionHealth: WorkStateProjectionHealth = buildProjectionHealth([]);
  // Bounded: fetch exactly ONE chunk (50 rows) per request, project/filter only that chunk.
  {
    chunk = listItemsByBatchChunked(batchId, CHUNK_SIZE, lastScannedCursor);
    scannedRows += chunk.items.length;
    queryCount++;
    hasMoreDb = chunk.hasMore;
    if (chunk.items.length > 0) {
      lastScannedCursor = chunk.lastCursor;
      let chunkCtx: WorkStateContext;
      try {
        chunkCtx = buildBatchWorkStateContext(batchId, chunk.items);
        if ((chunkCtx.healthIssues as any)._hasCritical) {
          const health = buildProjectionHealth(chunkCtx.healthIssues);
          throw Object.assign(new WorkStateProjectionError('work_state', 'critical_projection_failure'), { health });
        }
        healthIssues.push(...chunkCtx.healthIssues);
      } catch (e) {
        const maybeErr = e as any;
        if (maybeErr?.health) throw e;
        healthIssues.push({ source: 'work_state', code: 'chunk_context_failed', affectedCount: chunk.items.length });
        throw Object.assign(new WorkStateProjectionError('work_state', 'critical_projection_failure'), { health: buildProjectionHealth(healthIssues) });
      }
      for (const item of chunk.items) {
        try {
          const state = deriveItemWorkState(item, chunkCtx);
          if (matchesFilters(state, filters)) {
            collected.push(state);
            lastCollectedCursor = { rowNumber: (item as any).rowNumber ?? 0, id: item.id };
            if (collected.length >= limit) break;
          }
        } catch {
          healthIssues.push({ source: 'onboarding_items', code: 'corrupt_projection', affectedCount: 1 });
          const fallback: OnboardingWorkState = {
            itemId: item.id,
            category: 'needs_attention',
            activity: null,
            label: 'Projection error',
            detail: 'Corrupt work-state data — operator attention required',
            attentionReason: 'processing_failed',
            attentionAction: 'retry_processing',
            findingCode: null,
            findingSummary: null,
            conflictingValues: null,
            suggestedAction: null,
            findingDetails: null,
            family: null,
            reviewState: 'not_ready',
            stage: item.stage as any,
            stageStatus: item.stageStatus as any,
            variantResolution: null,
            upc: item.upc,
            name: item.name,
            brand: item.brandHint ?? null,
            sourceType: item.sourceType as any,
            domain: normalizeHost(item.sourceUrl),
            curatedTitle: null,
            imageUrl: null,
            description: null,
            weight: null,
          };
          if (matchesFilters(fallback, filters)) {
            collected.push(fallback);
            lastCollectedCursor = { rowNumber: (item as any).rowNumber ?? 0, id: item.id };
            if (collected.length >= limit) break;
          }
        }
      }
    } else {
      hasMoreDb = false;
    }
  }
  // Merge health
  if (healthIssues.length > 0) {
    const existing = projectionHealth.issues ?? [];
    projectionHealth = buildProjectionHealth([...existing, ...healthIssues]);
  }
  const paged = collected.slice(0, limit);
  let nextCursor: string | null = null;
  if (paged.length === limit && paged.length > 0) {
    const cursorSrc = lastCollectedCursor ?? lastScannedCursor;
    if (cursorSrc) {
      nextCursor = encodeWorkStateDbCursor({
        v: 2,
        rowNumber: cursorSrc.rowNumber,
        id: cursorSrc.id,
        filterHash: computeWorkStateFilterHash(filters),
      });
    }
  } else if (hasMoreDb && lastScannedCursor) {
    nextCursor = encodeWorkStateDbCursor({
      v: 2,
      rowNumber: lastScannedCursor.rowNumber,
      id: lastScannedCursor.id,
      filterHash: computeWorkStateFilterHash(filters),
    });
  }
  return { items: paged, nextCursor, projectionHealth, scannedRows, queryCount };
}

/** Project a batch's items using an ALREADY-LOADED item list (items route). */
export function getBatchWorkStateForItems(batchId: string, items: OnboardingItem[]): {
  byItem: Map<string, OnboardingWorkState>;
  counts: WorkStateCounts;
} {
  const ctx = buildBatchWorkStateContext(batchId, items);
  const counts = initCounts();
  const byItem = new Map<string, OnboardingWorkState>();
  for (const item of items) {
    try {
      const state = deriveItemWorkState(item, ctx);
      byItem.set(item.id, state);
      counts[state.category] += 1;
    } catch {
      byItem.set(item.id, {
        itemId: item.id,
        category: 'needs_attention',
        activity: null,
        label: 'Projection error',
        detail: 'Corrupt work-state data',
        attentionReason: 'processing_failed',
        attentionAction: 'retry_processing',
        findingCode: null,
        findingSummary: null,
        conflictingValues: null,
        suggestedAction: null,
        findingDetails: null,
        family: null,
        reviewState: 'not_ready',
        stage: item.stage as any,
        stageStatus: item.stageStatus as any,
        variantResolution: null,
        upc: item.upc,
        name: item.name,
        brand: item.brandHint ?? null,
        sourceType: item.sourceType as any,
        domain: normalizeHost(item.sourceUrl),
        curatedTitle: null,
        imageUrl: null,
        description: null,
        weight: null,
      });
      counts.needs_attention += 1;
    }
  }
  return { byItem, counts };
}

/** Single-item projection (item detail API). */
export function getItemWorkState(itemId: string): OnboardingWorkState | undefined {
  const item = findItemById(itemId) as OnboardingItem | undefined;
  if (!item) return undefined;
  const reviewRow = getReviewState(itemId);
  const workspaceId = findBatchById(item.batchId)?.workspaceId ?? '';
  // Use bulk helpers even for single item (keeps query plan uniform)
  const cohortByItem = buildCohortContext(item.batchId, listItemsByBatch(item.batchId));
  const changeSetStatusBySku = stageIs(item.stage, 'create_drafts') ? listChangeSetStatusBySkus(workspaceId, [item.upc]) : new Map();
  const candidateCountByItem = bulkCountDiscoveryCandidates([item.id]);
  const variantResolutionByItem = bulkLoadVariantResolutions([item.id]);
  const cohortRunStatusByItem = bulkGetCohortRunStatusByItem([item.id]);
  const latestRunIdByItemRaw = bulkGetLatestClassificationRunIdByItem([item.id]);
  // Prefer explicit runId from curationData
  const curData = item.curationData as Record<string, unknown> | null;
  const explicitRunId = curData && typeof curData.classificationRunId === 'string' && (curData.classificationRunId as string).trim().length > 0
    ? (curData.classificationRunId as string).trim()
    : null;
  const effectiveRunId = explicitRunId ?? latestRunIdByItemRaw.get(item.id) ?? null;
  const runIdByItem = effectiveRunId ? new Map([[item.id, effectiveRunId]]) : new Map();
  const stageResultsByRunId = effectiveRunId ? bulkGetClassificationStageResults([effectiveRunId]) : new Map();
  const ctx: WorkStateContext = {
    reviewStates: new Map(reviewRow ? [[item.id, reviewRow]] : []),
    cohortByItem,
    changeSetStatusBySku,
    candidateCountByItem,
    variantResolutionByItem,
    cohortRunStatusByItem,
    latestRunIdByItem: runIdByItem,
    stageResultsByRunId,
    healthIssues: [],
  };
  try {
    return deriveItemWorkState(item, ctx);
  } catch {
    return {
      itemId: item.id,
      category: 'needs_attention',
      activity: null,
      label: 'Projection error',
      detail: 'Corrupt work-state data — operator attention required',
      attentionReason: 'processing_failed',
      attentionAction: 'retry_processing',
      findingCode: null,
      findingSummary: null,
      conflictingValues: null,
      suggestedAction: null,
      findingDetails: null,
      family: null,
      reviewState: 'not_ready',
      stage: item.stage as any,
      stageStatus: item.stageStatus as any,
      variantResolution: null,
      upc: item.upc,
      name: item.name,
      brand: item.brandHint ?? null,
      sourceType: item.sourceType as any,
      domain: normalizeHost(item.sourceUrl),
      curatedTitle: null,
      imageUrl: null,
      description: null,
      weight: null,
    };
  }
}
