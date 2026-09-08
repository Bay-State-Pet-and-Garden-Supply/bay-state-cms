/**
 * Slice 1 — v2 stage-read service (council plan §4.1).
 *
 * Server-authoritative, stage-filtered reads for the linear six-stage
 * navigation. Reuses the canonical v1 projection (`deriveItemWorkState`,
 * `matchesFilters`, bulk loaders, pure cohort evaluators) — no parallel
 * classifier. Read-only: never starts the worker, never mutates rows.
 *
 * Predicate split: workspace/batch ownership + stage + stageStatus are SQL
 * WHERE (bound params, stored-vocabulary aliases); category/reviewState/
 * sourceType/domain/cohortId/q remain post-projection via the SAME
 * matchesFilters function the v1 path uses.
 */
import {
  toCanonicalStage,
  V2_TO_V1,
  isStageV1String,
  isStageV2String,
  StageVocabularyError,
  parseV2StageInput,
  type StageV2,
} from '../shared/onboarding-stage-vocabulary';
import {
  computeStageReadFilterHashV2,
  encodeStageReadCursor,
  validateStageReadCursor,
  emptyStageStatusMatrix,
  emptyWorkStateCounts,
  sumStageStatusMatrix,
  STAGE_READ_SCHEMA_VERSION,
  STAGE_READ_VOCABULARY_VERSION,
  STAGE_READ_LIMIT_DEFAULT,
  STAGE_READ_LIMIT_MAX,
  STAGE_READ_CHUNK_SIZE,
  STAGE_READ_ENDPOINT,
  STAGE_READ_CURSOR_VERSION,
  type StageReadFilters,
  type StageReadCountsResponse,
  type StageReadItemsResponse,
  type StageReadScope,
} from '../shared/schemas/onboarding-stage-read';
import { StageStatusEnum } from '../shared/schemas/onboarding';
import {
  WorkStateCategoryEnum,
  ReviewStateEnum,
} from '../shared/schemas/onboarding-work-state';
import { SourceTypeEnum } from '../shared/schemas/onboarding';
import {
  listItemsByBatchStageChunked,
  type OnboardingItemWithEntryPolicy,
} from '../db/repositories/onboarding-item-repo';
import {
  resetStageReadStatementCount,
  getStageReadStatementCount,
  trackExternalStatements,
  withStageReadTransaction,
  readStageStorageVersion,
  checkStageReadScope,
  loadV2ReviewStates,
  loadV2Cohorts,
  loadV2CohortMembers,
  loadV2ExtractionBindings,
  loadV2ChangeSetStatusBySkus,
} from '../db/repositories/onboarding-stage-read-repo';
import {
  resetWorkStateQueryCount,
  getWorkStateQueryCount,
  bulkCountDiscoveryCandidatesWithHealth,
  bulkLoadVariantResolutionsWithHealth,
  bulkGetCohortRunStatusByItemWithHealth,
  bulkGetLatestClassificationRunIdByItemWithHealth,
  bulkGetClassificationStageResultsWithHealth,
} from '../db/repositories/onboarding-work-state-repo';
import {
  deriveItemWorkState,
  buildProjectionHealth,
  matchesFilters,
  type FamilyCohortState,
  type WorkStateContext,
} from './onboarding-work-state';
import type { WorkStateProjectionHealthIssue } from '../shared/schemas/onboarding-work-state';
import { evaluateCohortReadiness } from './curation-cohort-service';
import {
  derivePreparationForItems,
  type PreparationFactsInput,
} from './onboarding-preparation-read';
import type { PreparationSummary } from '../shared/schemas/onboarding-preparation';
import type { OnboardingWorkState } from '../shared/schemas/onboarding-work-state';
import type { OnboardingReviewState } from '../db/repositories/onboarding-review-repo';

export class StageReadInputError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_filters' | 'invalid_version' | 'step_zero_not_a_stage' | 'unknown_stage',
  ) {
    super(message);
    this.name = 'StageReadInputError';
  }
}

export class StageReadScopeError extends Error {
  constructor() {
    super('Batch not found');
    this.name = 'StageReadScopeError';
  }
}

export class StageReadProjectionError extends Error {
  public readonly health: ReturnType<typeof buildProjectionHealth>;
  constructor(
    message: string,
    public readonly code: string,
    health: ReturnType<typeof buildProjectionHealth>,
  ) {
    super(message);
    this.name = 'StageReadProjectionError';
    this.health = health;
  }
}

// ─── Strict query parsing ─────────────────────────────────────────────────────

const ALLOWED_QUERY_KEYS = new Set([
  'stage',
  'stageStatus',
  'category',
  'reviewState',
  'sourceType',
  'domain',
  'cohortId',
  'q',
  'cursor',
  'limit',
  'stageVocabularyVersion',
]);

function singleString(raw: string[] | undefined, key: string): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length !== 1) {
    throw new StageReadInputError(`Duplicate query parameter '${key}' — pass it at most once`, 'invalid_filters');
  }
  return raw[0];
}

export interface ParsedStageReadQuery {
  filters: StageReadFilters;
  limit: number;
}

/** Strict parse of the raw multi-valued query map. Unknown keys, duplicates,
 * out-of-range limits, v1 stage strings, and Step 0 all fail 400. */
export function parseStageReadQueryParams(queries: Record<string, string[] | undefined>): ParsedStageReadQuery {
  for (const key of Object.keys(queries)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new StageReadInputError(`Unknown query parameter '${key}'`, 'invalid_filters');
    }
  }
  const vocabRaw = singleString(queries['stageVocabularyVersion'], 'stageVocabularyVersion');
  if (vocabRaw !== undefined && vocabRaw !== '2') {
    throw new StageReadInputError(
      `Unsupported stageVocabularyVersion '${vocabRaw}' — this endpoint serves vocabulary 2 only`,
      'invalid_version',
    );
  }
  const stageRaw = singleString(queries['stage'], 'stage');
  let stage: StageV2 | undefined;
  if (stageRaw !== undefined) {
    try {
      stage = parseV2StageInput(stageRaw);
    } catch (err) {
      if (err instanceof StageVocabularyError) {
        if (err.code === 'invalid_version') throw new StageReadInputError(err.message, 'invalid_version');
        if (err.code === 'step_zero_not_a_stage') throw new StageReadInputError(err.message, 'step_zero_not_a_stage');
        throw new StageReadInputError(err.message, 'unknown_stage');
      }
      throw err;
    }
  }
  const enumField = <T>(key: string, parse: (v: string) => T | undefined): T | undefined => {
    const raw = singleString(queries[key], key);
    if (raw === undefined) return undefined;
    const parsed = parse(raw);
    if (parsed === undefined) throw new StageReadInputError(`Invalid ${key}: '${raw}'`, 'invalid_filters');
    return parsed;
  };
  const stageStatus = enumField('stageStatus', v => StageStatusEnum.safeParse(v).success ? (v as StageReadFilters['stageStatus']) : undefined);
  const category = enumField('category', v => WorkStateCategoryEnum.safeParse(v).success ? (v as NonNullable<StageReadFilters['category']>) : undefined);
  const reviewState = enumField('reviewState', v => ReviewStateEnum.safeParse(v).success ? (v as NonNullable<StageReadFilters['reviewState']>) : undefined);
  const sourceType = enumField('sourceType', v => SourceTypeEnum.safeParse(v).success ? (v as NonNullable<StageReadFilters['sourceType']>) : undefined);
  const blankToAbsent = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    return raw.trim().length === 0 ? undefined : raw;
  };
  const domain = blankToAbsent(singleString(queries['domain'], 'domain'));
  const cohortId = blankToAbsent(singleString(queries['cohortId'], 'cohortId'));
  const q = blankToAbsent(singleString(queries['q'], 'q'));
  const cursor = singleString(queries['cursor'], 'cursor');
  const limitRaw = singleString(queries['limit'], 'limit');
  let limit: number = STAGE_READ_LIMIT_DEFAULT;
  if (limitRaw !== undefined) {
    // Strict integer syntax: rejects fractional, NaN, text, signs, whitespace.
    if (!/^\d+$/.test(limitRaw)) {
      throw new StageReadInputError(`Invalid limit '${limitRaw}' — integer 1–${STAGE_READ_LIMIT_MAX}`, 'invalid_filters');
    }
    const n = Number(limitRaw);
    if (!Number.isSafeInteger(n) || n < 1 || n > STAGE_READ_LIMIT_MAX) {
      throw new StageReadInputError(`Invalid limit '${limitRaw}' — integer 1–${STAGE_READ_LIMIT_MAX}`, 'invalid_filters');
    }
    limit = n;
  }
  return {
    filters: { stage, stageStatus, category, reviewState, sourceType, domain, cohortId, q, cursor },
    limit,
  };
}

// ─── Chunk-scoped v2 context (same evaluators as v1, tracked loads) ──────────

interface V2ChunkProjected {
  state: OnboardingWorkState;
  canonicalStage: StageV2;
}

function buildV2ChunkContext(
  batchId: string,
  workspaceId: string,
  items: OnboardingItemWithEntryPolicy[],
): { ctx: WorkStateContext; critical: { source: string; code: string } | null } {
  const healthIssues: WorkStateProjectionHealthIssue[] = [];
  let critical: { source: string; code: string } | null = null;
  const fail = (source: string, code: string, affectedCount: number) => {
    healthIssues.push({ source, code, affectedCount });
    critical = { source, code };
  };

  // IIFE form: single const assignment satisfies both definite-assignment
  // and no-useless-assignment (a bare let + try/catch trips one or the other).
  const reviewStates: Map<string, OnboardingReviewState> = (() => {
    try {
      return loadV2ReviewStates(batchId);
    } catch {
      fail('onboarding_review_state', 'review_state_failed', items.length);
      return new Map<string, OnboardingReviewState>();
    }
  })();

  // Cohort context with bulk member/extraction loads (same pure evaluators as
  // buildCohortContext/buildCohortView; getCurrentCohortRun intentionally
  // omitted — its fields never reach deriveItemWorkState).
  const cohortByItem: Map<string, FamilyCohortState> = (() => {
    const byItem = new Map<string, FamilyCohortState>();
    try {
      const cohorts = loadV2Cohorts(batchId);
      const membersByCohort = loadV2CohortMembers(cohorts.map(c => c.id));
      const extractionSources = loadV2ExtractionBindings(items.map(i => i.id));
      for (const cohort of cohorts) {
      const members = membersByCohort.get(cohort.id) ?? [];
      const evaluation = evaluateCohortReadiness(cohort, members, items, extractionSources);
      // NOTE: per-member evaluateItemReadiness is intentionally not run here:
      // buildCohortContext's downstream projection (deriveItemWorkState via
      // FamilyCohortState) consumes only waitingOn/member counts per member.
      // evaluateItemReadiness stays pure and is covered by existing v1 suites.
      const memberViews = members.map(member => ({
        onboardingItemId: member.onboardingItemId,
        waitingOn: evaluation.waitingOn.filter(entry => entry.itemId !== member.onboardingItemId),
      }));
      const memberCount = evaluation.memberCount;
      const readyCount = evaluation.readyCount;
      const blockedCount = Math.max(0, memberCount - readyCount - evaluation.waitingOn.length);
      for (const member of memberViews) {
        byItem.set(member.onboardingItemId, {
          cohortId: cohort.id,
          label: cohort.groupLabel,
          memberCount,
          readyCount,
          blockedCount,
          waitingOnItemIds: member.waitingOn
            .filter(entry => entry.itemId !== member.onboardingItemId)
            .map(entry => entry.itemId),
          cohortStatus: cohort.status,
          cohortState: evaluation.state,
          blockedReason: evaluation.blockedReason,
        });
      }
    }
      return byItem;
    } catch {
      fail('curation_cohorts', 'cohort_context_failed', items.length);
      return new Map<string, FamilyCohortState>();
    }
  })();

  // Slice 5b native: canonical promotion check (dual read — either stored spelling).
  const promotedSkus = items.filter(item => { try { return toCanonicalStage(item.stage) === 'create_drafts'; } catch { return false; } }).map(item => item.upc);
  const changeSetStatusBySku: Map<string, string> = (() => {
    try {
      return loadV2ChangeSetStatusBySkus(workspaceId, promotedSkus);
    } catch {
      if (promotedSkus.length > 0) fail('change_sets', 'change_set_lookup_failed', promotedSkus.length);
      return new Map<string, string>();
    }
  })();

  const itemIds = items.map(i => i.id);
  const candidateRes = bulkCountDiscoveryCandidatesWithHealth(itemIds);
  if (candidateRes.issue) fail(candidateRes.issue.source, candidateRes.issue.code, itemIds.length);
  const variantRes = bulkLoadVariantResolutionsWithHealth(itemIds);
  if (variantRes.issue) fail(variantRes.issue.source, variantRes.issue.code, itemIds.length);
  const cohortRunRes = bulkGetCohortRunStatusByItemWithHealth(itemIds);
  if (cohortRunRes.issue) fail(cohortRunRes.issue.source, cohortRunRes.issue.code, itemIds.length);
  const latestRes = bulkGetLatestClassificationRunIdByItemWithHealth(itemIds);
  if (latestRes.issue) fail(latestRes.issue.source, latestRes.issue.code, itemIds.length);

  const effectiveRunIds: string[] = [];
  const runIdByItem = new Map<string, string>();
  for (const item of items) {
    const curData = item.curationData as Record<string, unknown> | null;
    const explicitRunId =
      curData && typeof curData.classificationRunId === 'string' && (curData.classificationRunId as string).trim().length > 0
        ? (curData.classificationRunId as string).trim()
        : null;
    const runId = explicitRunId ?? latestRes.data.get(item.id) ?? null;
    if (runId) {
      runIdByItem.set(item.id, runId);
      effectiveRunIds.push(runId);
    }
    if (curData !== null && typeof curData !== 'object') {
      healthIssues.push({ source: 'onboarding_items', code: 'corrupt_curation_data', affectedCount: 1 });
    }
  }
  const stageRes = bulkGetClassificationStageResultsWithHealth(effectiveRunIds);
  if (stageRes.issue) fail(stageRes.issue.source, stageRes.issue.code, itemIds.length);

  return {
    ctx: {
      reviewStates,
      cohortByItem,
      changeSetStatusBySku,
      candidateCountByItem: candidateRes.data,
      variantResolutionByItem: variantRes.data as unknown as WorkStateContext['variantResolutionByItem'],
      cohortRunStatusByItem: cohortRunRes.data,
      latestRunIdByItem: runIdByItem,
      stageResultsByRunId: stageRes.data as unknown as WorkStateContext['stageResultsByRunId'],
      healthIssues,
    },
    critical,
  };
}

/** Project one chunk with v1-identical fallback semantics. Unknown stored
 * stage/status is a critical projection failure (503), never a manufactured
 * needs_attention row. Returns raw issues; the caller builds health once. */
function projectChunk(
  batchId: string,
  workspaceId: string,
  items: OnboardingItemWithEntryPolicy[],
): { projected: V2ChunkProjected[]; issues: WorkStateProjectionHealthIssue[]; ctx: WorkStateContext } {
  const { ctx, critical } = buildV2ChunkContext(batchId, workspaceId, items);
  if (critical) {
    const issues =
      ctx.healthIssues.length > 0
        ? ctx.healthIssues
        : [{ source: critical.source, code: critical.code, affectedCount: items.length }];
    throw new StageReadProjectionError('critical_projection_failure', critical.code, buildProjectionHealth(issues));
  }
  const projected: V2ChunkProjected[] = [];
  const issues = [...ctx.healthIssues];
  let corruptCount = 0;
  for (const item of items) {
    // Either stored spelling is projectable: v1 (pre-migration) or v2
    // (migrated). Hydration preserves the stored spelling and already
    // rejected null/empty/unknown; toCanonicalStage below maps both.
    if ((!isStageV1String(item.stage) && !isStageV2String(item.stage)) || !StageStatusEnum.safeParse(item.stageStatus).success) {
      issues.push({ source: 'onboarding_items', code: 'unknown_stage', affectedCount: 1 });
      throw new StageReadProjectionError('critical_projection_failure', 'unknown_stage', buildProjectionHealth(issues));
    }
    try {
      const state = deriveItemWorkState(item, ctx);
      projected.push({ state, canonicalStage: toCanonicalStage(item.stage) });
    } catch {
      corruptCount += 1;
      projected.push({
        state: {
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
          stage: item.stage,
          stageStatus: item.stageStatus,
          variantResolution: null,
          upc: item.upc,
          name: item.name,
          brand: item.brandHint ?? null,
          sourceType: item.sourceType,
          domain: null,
          curatedTitle: null,
          imageUrl: null,
          description: null,
          weight: null,
        },
        canonicalStage: toCanonicalStage(item.stage),
      });
    }
  }
  if (corruptCount > 0) {
    issues.push({ source: 'onboarding_items', code: 'corrupt_projection', affectedCount: corruptCount });
  }
  return { projected, issues, ctx };
}

/**
 * Slice 4-SERVER — build preparation facts for matched items from the
 * ALREADY-LOADED chunk context. Pure mapping: zero new SQL statements.
 * Run/run-id resolution mirrors buildV2ChunkContext's effective-run rule
 * (explicit curation-data run id, else latest bulk run id).
 */
export function buildPreparationByItem(
  items: OnboardingItemWithEntryPolicy[],
  projectedById: Map<string, V2ChunkProjected>,
  ctx: WorkStateContext,
): Record<string, PreparationSummary> {
  const entries: Array<{ itemId: string; facts: PreparationFactsInput }> = [];
  for (const item of items) {
    const projected = projectedById.get(item.id);
    if (!projected) continue;
    const curData = item.curationData as Record<string, unknown> | null;
    const explicitRunId =
      curData && typeof curData.classificationRunId === 'string' && (curData.classificationRunId as string).trim().length > 0
        ? (curData.classificationRunId as string).trim()
        : null;
    const runId = explicitRunId ?? ctx.latestRunIdByItem.get(item.id) ?? null;
    const stageRows = runId ? (ctx.stageResultsByRunId.get(runId) ?? null) : null;
    const semantic = curData?.semanticValidation as { status?: unknown } | undefined;
    entries.push({
      itemId: item.id,
      facts: {
        stageRows,
        cohort: ctx.cohortByItem.get(item.id) ?? null,
        cohortRunStatus: ctx.cohortRunStatusByItem.get(item.id) ?? null,
        curatedTitle: projected.state.curatedTitle,
        imageUrl: projected.state.imageUrl,
        semanticBlocked: semantic?.status === 'blocked',
      },
    });
  }
  const derived = derivePreparationForItems(entries);
  const out: Record<string, PreparationSummary> = {};
  for (const [itemId, summary] of derived) out[itemId] = summary;
  return out;
}

/** Shared post-projection predicate: v1 facet semantics + canonical stage/status. */
function matchesStageReadFilters(
  projected: V2ChunkProjected,
  filters: Omit<StageReadFilters, 'cursor' | 'limit'>,
): boolean {
  if (filters.stage && projected.canonicalStage !== filters.stage) return false;
  if (filters.stageStatus && projected.state.stageStatus !== filters.stageStatus) return false;
  return matchesFilters(projected.state, {
    category: filters.category,
    reviewState: filters.reviewState ?? undefined,
    sourceType: filters.sourceType,
    domain: filters.domain,
    cohortId: filters.cohortId,
    q: filters.q,
  });
}

// ─── Public endpoints ─────────────────────────────────────────────────────────

function requireStageReadScope(batchId: string, scope: StageReadScope): void {
  if (!checkStageReadScope(batchId, scope.workspaceId)) {
    throw new StageReadScopeError();
  }
}

/** Total executed statements for the current request: tracked v2 statements
 * (including external chunk-reader statements) + shared bulk-counter delta
 * + 1 for the COMMIT that closes this read transaction (it always executes
 * on the success path that returns this count; on failure no response — and
 * no count — is returned, so the +1 never misattributes a ROLLBACK). */
function currentQueryCount(): number {
  return getStageReadStatementCount() + getWorkStateQueryCount() + 1;
}

export function getStageReadCounts(
  batchId: string,
  filters: Omit<StageReadFilters, 'cursor' | 'limit'>,
  scope: StageReadScope,
): StageReadCountsResponse {
  resetStageReadStatementCount();
  resetWorkStateQueryCount();
  const fingerprint = computeStageReadFilterHashV2(filters, scope);
  return withStageReadTransaction(() => {
    requireStageReadScope(batchId, scope);
    const storageVersion = readStageStorageVersion();
    // API speaks v2; storage may be v1 (pre-migration) or v2 (migrated).
    // Encode the filter to the storage spelling so the SQL predicate matches
    // actually-stored rows. Projection canonicalizes from either spelling,
    // so counts/matrix stay v2 in both worlds. Never throw here merely
    // because storage is v2 — that stranded migrated databases.
    const stages = filters.stage ? [storageVersion === 2 ? filters.stage : V2_TO_V1[filters.stage]] : null;
    const stageStatuses = filters.stageStatus ? [filters.stageStatus] : null;
    const counts = emptyWorkStateCounts();
    const matrix = emptyStageStatusMatrix();
    let matchingTotal = 0;
    const allIssues: WorkStateProjectionHealthIssue[] = [];
    let cursor: { rowNumber: number; id: string } | null = null;
    for (;;) {
      // One candidate chunk per loop iteration (bounded, ≤50 rows).
      const chunk = listItemsByBatchStageChunked(batchId, {
        stages,
        stageStatuses,
        limit: STAGE_READ_CHUNK_SIZE,
        cursor,
      });
      trackExternalStatements(chunk.statementsExecuted, 'SELECT onboarding_items stage/status chunk (item-repo)');
      const { projected, issues } = projectChunk(batchId, scope.workspaceId, chunk.items);
      allIssues.push(...issues);
      for (const p of projected) {
        if (!matchesStageReadFilters(p, filters)) continue;
        matchingTotal += 1;
        counts[p.state.category] += 1;
        (matrix[p.canonicalStage] as Record<string, number>)[p.state.stageStatus] += 1;
      }
      if (!chunk.hasMore) break;
      cursor = chunk.lastCursor;
      if (cursor === null) break;
    }
    return {
      schemaVersion: STAGE_READ_SCHEMA_VERSION,
      stageVocabularyVersion: STAGE_READ_VOCABULARY_VERSION,
      batchId,
      filterFingerprint: fingerprint,
      matchingTotal,
      counts,
      stageStatusMatrix: matrix,
      projectionHealth: buildProjectionHealth(allIssues),
    };
  });
}

export function getStageReadItems(
  batchId: string,
  filters: StageReadFilters,
  limit: number,
  scope: StageReadScope,
): StageReadItemsResponse {
  resetStageReadStatementCount();
  resetWorkStateQueryCount();
  const { cursor: cursorRaw, ...filterOnly } = filters;
  const fingerprint = computeStageReadFilterHashV2(filterOnly, scope);
  return withStageReadTransaction(() => {
    requireStageReadScope(batchId, scope);
    const storageVersion = readStageStorageVersion();
    let cursor: { rowNumber: number; id: string } | null = null;
    if (cursorRaw) {
      cursor = validateStageReadCursor(cursorRaw, filterOnly, scope);
    }
    // Storage-version-aware predicate (see getStageReadCounts): match actually-stored rows.
    const stages = filterOnly.stage ? [storageVersion === 2 ? filterOnly.stage : V2_TO_V1[filterOnly.stage]] : null;
    const stageStatuses = filterOnly.stageStatus ? [filterOnly.stageStatus] : null;
    // Exactly ONE candidate chunk per request — no lookahead, no second chunk.
    const chunk = listItemsByBatchStageChunked(batchId, { stages, stageStatuses, limit, cursor });
    trackExternalStatements(chunk.statementsExecuted, 'SELECT onboarding_items stage/status chunk (item-repo)');
    const { projected, issues, ctx } = projectChunk(batchId, scope.workspaceId, chunk.items);
    const matched = projected.filter(p => matchesStageReadFilters(p, filterOnly));
    // Slice 4-SERVER: preparation sections derived PURELY from the loaded
    // chunk context — zero new statements (budget asserted in tests).
    const nextCursor =
      chunk.hasMore && chunk.lastCursor
        ? encodeStageReadCursor({
            v: STAGE_READ_CURSOR_VERSION,
            rowNumber: chunk.lastCursor.rowNumber,
            id: chunk.lastCursor.id,
            filterHash: fingerprint,
            workspaceId: scope.workspaceId,
            batchId,
            endpoint: STAGE_READ_ENDPOINT,
            stageVocabularyVersion: STAGE_READ_VOCABULARY_VERSION,
          })
        : null;
    // Preparation covers exactly the matched items (same predicates as items[]).
    const matchedIds = new Set(matched.map(p => p.state.itemId));
    const projectedById = new Map(projected.map(p => [p.state.itemId, p]));
    const preparationByItem = buildPreparationByItem(
      chunk.items.filter(item => matchedIds.has(item.id)),
      projectedById,
      ctx,
    );
    return {
      schemaVersion: STAGE_READ_SCHEMA_VERSION,
      stageVocabularyVersion: STAGE_READ_VOCABULARY_VERSION,
      batchId,
      filterFingerprint: fingerprint,
      items: matched.map(p => p.state),
      preparationByItem,
      nextCursor,
      scannedRows: chunk.items.length,
      queryCount: currentQueryCount(),
      projectionHealth: buildProjectionHealth(issues),
    };
  });
}

/** Re-exported from the shared schema (pure) for oracle/test convenience. */
export { sumStageStatusMatrix };
