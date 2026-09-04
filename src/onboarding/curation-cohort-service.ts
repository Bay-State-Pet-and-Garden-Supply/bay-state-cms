/**
 * Curation cohort service (issue #30, PR2 — candidate cohort formation +
 * readiness).
 *
 * Responsibilities:
 * - `refreshCandidateCohorts(workspaceId, batchId)` — idempotently refresh the
 *   batch's candidate cohorts (grouping + supersede-on-change in the repo) and
 *   transition their status to `waiting`/`ready` from the extraction
 *   completeness contract.
 * - `evaluateCohortReadiness(...)` — the "Extraction completeness contract":
 *   source finalized + extraction completed + PI import done + evidence hash
 *   computed + selected-source provenance consistent (packaging OCR is
 *   informational and non-blocking in this round; it finalizes lazily inside
 *   per-SKU curation and gates at PR3). Failed members produce a deterministic
 *   `blocked` state instead of a wait; `ready` and `blocked` are mutually
 *   exclusive by construction (round-3 R1).
 * - `sourceProvenanceConsistent(item, latestExtractionSourceUrl)` — binds the
 *   item's selected source to the source recorded on its latest extraction
 *   row (round-3 R4); a mismatch blocks the member until re-extraction.
 * - `getDerivedCohortStateForItem(item, items?)` — derived "Waiting for N
 *   family members to finish Extraction" state for the Pipeline Board;
 *   callers may pass the already-loaded batch items to avoid an extra load.
 * - `transitionCohortToReadyIfComplete(...)` — ready transition only; no
 *   claiming/execution yet (PR3).
 *
 * Items stay in `curation / pending` while siblings wait; `needs_input` is
 * never used for sibling waiting (issue #30, "Curation readiness barrier").
 */
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import {
  getLatestExtractionBindingsByItemIds,
  getLatestExtraction,
  type ExtractionBinding,
} from '../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts as repoRefreshCandidateCohorts,
  listCohortsByBatch,
  getCohortById,
  getCohortMembers,
  getActiveCohortForItem,
  updateCohortStatus,
  computeExtractionHash,
} from '../db/repositories/curation-cohort-repo';
import { getCurrentCohortRun } from '../db/repositories/classification-cohort-run-repo';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import {
  GROUPING_VERSION,
} from '../shared/schemas/cohorts';
import type {
  CohortWaitingOnItem,
  CurationCohort,
  CurationCohortMember,
  CurationCohortView,
  DerivedCohortStateForItem,
  ReadinessState,
} from '../shared/schemas/cohorts';

export { GROUPING_VERSION };

// ─── Item-level extraction readiness (completeness contract) ──────────────────

export interface ItemExtractionReadiness {
  ready: boolean;
  /** Derived state: `blocked` when the member failed in a pipeline stage. */
  state: ReadinessState;
  blockedReason: string | null;
  sourceFinalized: boolean;
  extractionCompleted: boolean;
  ocrSettled: boolean;
  piImported: boolean;
  extractionHashComputed: boolean;
  /** True when the item's selected source still matches the source bound to its latest extraction row. */
  sourceProvenanceConsistent: boolean;
}

/**
 * A member counts as Curation-ready only when its semantic evidence is stable
 * enough to freeze (issue #30, "Extraction completeness contract"):
 * - selected source state finalized — a persisted `source_url` AND Discovery
 *   completion (advanced past discovery, or `discovery/completed`); a
 *   `sourcingDecision` is the distributor-evidence path, not the ordinary
 *   spreadsheet-import path;
 * - extraction stage completed (or the item advanced beyond extraction);
 * - a Product Intelligence import, when attached, is present;
 * - a current source/evidence hash can be computed.
 *
 * Packaging OCR is informational, not blocking, in this round: OCR finalizes
 * lazily during per-SKU curation and must not gate candidate readiness until
 * PR3 pulls OCR forward (`ocrSettled` is reported for visibility only). A
 * member that failed in a pre-Curation barrier stage (sourcing | discovery |
 * extraction) is deterministically `blocked` (never a wait); a Curation-stage
 * failure is NOT a readiness blocker — the item is past the barrier.
 */
export function evaluateItemReadiness(
  item: OnboardingItem,
  extractionSourcesByItemId?: Map<string, ExtractionBinding>,
): ItemExtractionReadiness {
  const extractionCompleted = hasCompletedExtraction(item);
  const ocrSettled = isOcrSettled(item);
  const piImported = isPiImportComplete(item);
  // Round-3 R4 source binding (Amendment A): batch evaluation paths pass the
  // batched extraction-binding map once; direct per-item callers fall back to
  // a single lookup. Provenance consistency applies ONLY once the item has
  // extraction evidence — a sibling that has not completed extraction is
  // WAITING, never blocked by an absent binding (the worker always inserts a
  // row when evidence is finalized; an evidence-bearing item with a missing or
  // mismatched binding BLOCKS — absence cannot prove a match).
  const binding = extractionSourcesByItemId
    ? extractionSourcesByItemId.get(item.id)
    : getLatestExtractionBindingForItem(item.id);
  const sourceFinalized = isSourceFinalized(item, binding);
  const extractionHashComputed = computeExtractionHash(item) != null;
  const blocked = isFailedMember(item);
  const hasEvidence = hasCompletedExtraction(item) && extractionHashComputed;
  const provenanceConsistent = hasEvidence ? sourceProvenanceConsistent(item, binding) : true;
  // Invariant (round-3 R1): ready = !blocked && every completeness condition
  // holds — `ready` and `state === 'blocked'` are mutually exclusive by
  // construction. Provenance inconsistency is a blocking condition (a change
  // requiring re-extraction), not ordinary waiting.
  const ready = !blocked && sourceFinalized && extractionCompleted && piImported && extractionHashComputed && provenanceConsistent;
  const state: ReadinessState = blocked || !provenanceConsistent ? 'blocked' : ready ? 'ready' : 'waiting';
  return {
    ready,
    state,
    // A barrier failure (sourcing/discovery/extraction failed) is the
    // deterministic reason and takes precedence over provenance
    // inconsistency (pre-barrier items have no extraction binding at all).
    blockedReason: blocked
      ? buildMemberFailedReason(item)
      : !provenanceConsistent
        ? SOURCE_CHANGED_BLOCKED_REASON
        : ready
          ? null
          : buildBlockedReason({ sourceFinalized, extractionCompleted, piImported, extractionHashComputed }),
    sourceFinalized,
    extractionCompleted,
    ocrSettled,
    piImported,
    extractionHashComputed,
    sourceProvenanceConsistent: provenanceConsistent,
  };
}

/** Single-item extraction binding (per-item readiness fallback). */
function getLatestExtractionBindingForItem(itemId: string): ExtractionBinding | undefined {
  const row = getLatestExtraction(itemId);
  if (!row) return undefined;
  return {
    sourceUrl: row.source_url,
    sourceType: (row.source_type ?? 'official_page') as 'official_page' | 'distributor_record',
    extractionMethod: row.extraction_method,
    sourcingGenerationId: row.sourcing_generation_id ?? null,
    acceptedEvidenceAttemptIds: safeParseJsonArray(row.accepted_evidence_attempt_ids_json),
    evidenceHash: row.evidence_hash ?? null,
    // Parent #101: manual attestation link for manual-evidence rows (the
    // column is absent on pre-foundation rows — treated as null).
    manualAttestationId: (row as { manual_attestation_id?: string | null }).manual_attestation_id ?? null,
  };
}

function safeParseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Canonical "selected source state finalized" check (Amendment A):
 * - official source: a persisted `source_url` plus Discovery completion (the
 *   item advanced past discovery, or it is still in discovery with
 *   `discovery/completed`); an arbitrary non-null historical sourcing
 *   decision is NOT enough;
 * - distributor source: a VALID distributor extraction binding (source type
 *   `distributor_record`, null URL, distributor_record_v1 OR v2 method,
 *   generation, and evidence hash all present and consistent).
 */
function isSourceFinalized(item: OnboardingItem, binding: ExtractionBinding | undefined): boolean {
  if (item.sourceType === 'distributor_record') {
    if (!binding) return false;
    if (binding.sourceType !== 'distributor_record') return false;
    if (binding.sourceUrl !== null || item.sourceUrl !== null) return false;
    if (binding.extractionMethod !== 'distributor_record_v1' && binding.extractionMethod !== 'distributor_record_v2') return false;
    if (!binding.sourcingGenerationId || !binding.evidenceHash) return false;
    const prov =
      (item.extractionData as { distributorRecordProvenance?: { sourcingGenerationId?: string; evidenceHash?: string; acceptedEvidenceAttemptIds?: string[] } | null } | null)
        ?.distributorRecordProvenance ?? null;
    if (!prov) return false;
    if (binding.sourcingGenerationId !== prov.sourcingGenerationId) return false;
    if (binding.evidenceHash !== prov.evidenceHash) return false;
    // Accepted-attempt set equality (Milestone E review): the durable
    // extraction binding, the materialized payload provenance, and (when
    // present) the item's V2 distributor decision must all agree on the
    // accepted attempt set. A tampered/diverged set means the source is NOT
    // finalized — readiness separately blocks, but finalized must not lie.
    const payloadIds = [...(prov.acceptedEvidenceAttemptIds ?? [])].sort();
    const bindingIds = [...(binding.acceptedEvidenceAttemptIds ?? [])].sort();
    if (payloadIds.length !== bindingIds.length || payloadIds.some((id, i) => id !== bindingIds[i])) {
      return false;
    }
    const decision = item.sourcingDecision;
    if (decision && 'schemaVersion' in decision) {
      const decisionIds = [...((decision as { acceptedEvidenceAttemptIds?: string[] }).acceptedEvidenceAttemptIds ?? [])].sort();
      if (decisionIds.length !== bindingIds.length || decisionIds.some((id, i) => id !== bindingIds[i])) {
        return false;
      }
    }
    return true;
  }
  const discoveryFinalized = item.stage !== 'discovery' || item.stageStatus === 'completed';
  // Parent #101 (manual-evidence route): a manual-complete member has a NULL
  // extraction URL by design (never a fabricated per-SKU URL), so the
  // persisted-URL requirement can never hold. A manual binding (method +
  // attestation link, both from the durable row) finalizes exactly like a
  // URL-bound official source. Non-manual members are byte-identical.
  if (binding?.extractionMethod === 'manual_evidence_v1') {
    return binding.sourceUrl === null && (binding.manualAttestationId ?? null) !== null && discoveryFinalized;
  }
  return Boolean(item.sourceUrl) && discoveryFinalized;
}

/** A member that failed inside a pre-Curation barrier stage is deterministically
 *  blocked, not waiting (issue #30 round-3 R1). Readiness blockers are
 *  sourcing | discovery | extraction failures (pre-Curation barrier); a
 *  Curation-stage failure is NOT a readiness blocker — the item is past the
 *  barrier and its evidence is complete. */
function isFailedMember(item: OnboardingItem): boolean {
  return ['sourcing', 'discovery', 'extraction'].includes(item.stage) && item.stageStatus === 'failed';
}

function capitalizeStage(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/** Deterministic blocked text: stage from the item, capitalized (round-3 R1). */
function buildMemberFailedReason(item: OnboardingItem): string {
  return `Member failed in ${capitalizeStage(item.stage)} (SKU: ${item.upc ?? ''})`;
}

const SOURCE_CHANGED_BLOCKED_REASON = 'Selected source changed since extraction — re-extraction required';

/**
 * Exact source-binding comparison (Amendment A). Binds the item's selected
 * source to the extraction row that produced its evidence:
 *
 * - official source: the binding must exist with source type `official_page`
 *   and its URL must match the item's source URL (both normalized, trailing
 *   '/' trimmed);
 * - distributor source: the binding must exist with source type
 *   `distributor_record`, both URLs null, extraction method
 *   `distributor_record_v1` or `distributor_record_v2` (Amendment B
 *   merchandising-depth materialization), and matching generation / accepted
 *   attempt ids / evidence hash against the item's
 *   `distributorRecordProvenance`;
 * - a MISSING or malformed binding BLOCKS readiness (absence cannot prove a
 *   match).
 */
export function sourceProvenanceConsistent(
  item: OnboardingItem,
  binding: ExtractionBinding | undefined,
): boolean {
  const normalize = (url: string | null | undefined) => (url ?? '').replace(/\/+$/, '');
  const prov =
    (item.extractionData as { distributorRecordProvenance?: { sourcingGenerationId?: string; evidenceHash?: string; acceptedEvidenceAttemptIds?: string[] } | null } | null)
      ?.distributorRecordProvenance ?? null;

  if (item.sourceType === 'distributor_record') {
    if (!binding) return false;
    if (binding.sourceType !== 'distributor_record') return false;
    if (binding.sourceUrl !== null || item.sourceUrl !== null) return false;
    if (binding.extractionMethod !== 'distributor_record_v1' && binding.extractionMethod !== 'distributor_record_v2') return false;
    if (!prov) return false;
    if (binding.sourcingGenerationId !== prov.sourcingGenerationId) return false;
    if (binding.evidenceHash !== prov.evidenceHash) return false;
    // Accepted-attempt authority lives in the materialized payload provenance
    // (the onboarding_items row has no accepted-ids column).
    const payloadIds = [...(prov.acceptedEvidenceAttemptIds ?? [])].sort();
    const bindingIds = [...(binding.acceptedEvidenceAttemptIds ?? [])].sort();
    if (payloadIds.length !== bindingIds.length || payloadIds.some((id, i) => id !== bindingIds[i])) return false;
    return true;
  }

  // Official source: binding must exist and its URL must match the item URL.
  if (!binding) return false;
  if (binding.sourceType !== 'official_page') return false;
  // Parent #101 (manual-evidence route): manual bindings carry a NULL URL by
  // design, so URL matching can never hold. Consistency instead binds the
  // durable row to the item payload via the attestation link: the row's
  // attestation id must equal the payload's, and both must be non-null. A
  // tampered or unattested manual payload stays inconsistent (blocked).
  if (binding.extractionMethod === 'manual_evidence_v1') {
    const payloadAttestationId =
      (item.extractionData as { manualEvidenceAttestationId?: unknown } | null)?.manualEvidenceAttestationId ?? null;
    return (
      binding.sourceUrl === null &&
      (binding.manualAttestationId ?? null) !== null &&
      binding.manualAttestationId === payloadAttestationId
    );
  }
  return normalize(binding.sourceUrl) === normalize(item.sourceUrl);
}

/** Extraction is complete when the item finished the extraction stage — i.e. it
 *  is `extraction / completed`, or it has advanced to a later stage (which is
 *  only possible from a completed extraction) and still carries extraction data.
 *  The worker refresh runs right after extraction completes AND during curation
 *  polling, so cohorts must stay stable after items advance. */
function hasCompletedExtraction(item: OnboardingItem): boolean {
  if (item.stage === 'extraction') {
    return item.stageStatus === 'completed' && item.extractionData != null;
  }
  return ['curation', 'review', 'promotion'].includes(item.stage) && item.extractionData != null;
}

/** OCR is settled when structured OCR data exists or the OCR attempt reached a
 *  terminal outcome (`succeeded | disabled | failed | no_image`). `no_image`
 *  is terminal — there is no package image to OCR. `skipped` stays unsettled:
 *  it can represent an unperformed operation and is under scrutiny for PR3's
 *  evidence freeze. OCR remains informational (non-blocking) for candidate
 *  readiness in this round.
 *
 *  P1-T3 mirror of the freeze rule (cohort-curator.ts `isOcrSettled`): a
 *  stale-marked OCR outcome (digest-staleness invalidation at freeze) is
 *  NEVER settled, even when prior `packagingOcrData` was preserved intact.
 *  Readiness evaluation has no member runtime snapshot available, so the
 *  persisted stale marker is the observable authority-staleness rule here;
 *  the full digest comparison happens at freeze and in the frozen evidence
 *  stage. */
function isOcrSettled(item: OnboardingItem): boolean {
  const extractionData = item.extractionData;
  if (!extractionData) return false;
  if (extractionData.ocrOutcome?.stale === true) return false;
  if (extractionData.packagingOcrData) return true;
  const status = extractionData.ocrOutcome?.status;
  if (!status) return false;
  return status === 'succeeded' || status === 'disabled' || status === 'failed' || status === 'no_image';
}

/** A PI import, when attached, is complete when every evidence entry carries a
 *  run id + result hash + import record id. Nothing attached → trivially done. */
function isPiImportComplete(item: OnboardingItem): boolean {
  const evidence = item.extractionData?.productIntelligenceEvidence ?? [];
  if (evidence.length === 0) return true;
  return evidence.every(entry => Boolean(entry.runId && entry.resultHash && entry.importRecordId));
}

function buildBlockedReason(checks: {
  sourceFinalized: boolean;
  extractionCompleted: boolean;
  piImported: boolean;
  extractionHashComputed: boolean;
}): string {
  const parts: string[] = [];
  if (!checks.sourceFinalized) parts.push('selected source not finalized');
  if (!checks.extractionCompleted) parts.push('extraction not completed');
  if (!checks.piImported) parts.push('Product Intelligence import not completed');
  if (!checks.extractionHashComputed) parts.push('evidence hash not computed');
  return parts.join('; ');
}

// ─── Cohort readiness ──────────────────────────────────────────────────────────

export interface CohortReadinessEvaluation {
  /** Persisted-status mapping: `ready` when every member is ready, otherwise `waiting`. */
  status: 'ready' | 'waiting';
  /** Derived UI state: `blocked` when any member failed (issue #30 round-2 F5). */
  state: ReadinessState;
  blockedReason: string | null;
  waitingOn: CohortWaitingOnItem[];
  readyCount: number;
  memberCount: number;
}

export function evaluateCohortReadiness(
  _cohort: CurationCohort,
  members: CurationCohortMember[],
  items: OnboardingItem[],
  extractionSourcesByItemId?: Map<string, ExtractionBinding>,
): CohortReadinessEvaluation {
  const itemsById = new Map(items.map(item => [item.id, item]));
  // Single batched load of the latest extraction source per item (round-3 R4)
  // — one query per evaluation, passed through to every member so no per-item
  // provenance lookup runs.
  const extractionSources = extractionSourcesByItemId ?? getLatestExtractionBindingsByItemIds(items.map(item => item.id));
  const readinessByMember = new Map<string, ItemExtractionReadiness>();
  const notReady = members.filter(member => {
    const item = itemsById.get(member.onboardingItemId);
    const readiness: ItemExtractionReadiness = item
      ? evaluateItemReadiness(item, extractionSources)
      : {
          ready: false,
          state: 'waiting',
          blockedReason: 'member item not found',
          sourceFinalized: false,
          extractionCompleted: false,
          ocrSettled: false,
          piImported: false,
          extractionHashComputed: false,
          // No item → nothing to compare; cannot prove a provenance mismatch.
          sourceProvenanceConsistent: true,
        };
    readinessByMember.set(member.onboardingItemId, readiness);
    return !readiness.ready;
  });

  const blockedMembers = members.filter(member => readinessByMember.get(member.onboardingItemId)?.state === 'blocked');

  // Blocked members are surfaced via `blockedMembers`/state, never as ordinary
  // "waiting" entries — a failed member is not in progress (round-3 R1 invariant).
  const waitingOn = notReady
    .filter(member => readinessByMember.get(member.onboardingItemId)?.state !== 'blocked')
    .map(member => {
      const item = itemsById.get(member.onboardingItemId);
      return {
        itemId: member.onboardingItemId,
        upc: item?.upc ?? member.productSku ?? '',
        name: item?.name ?? '',
      };
    });

  const state: ReadinessState = blockedMembers.length > 0 ? 'blocked' : notReady.length === 0 ? 'ready' : 'waiting';
  const blockedReason = state === 'blocked'
    ? buildBlockedMembersReason(blockedMembers, itemsById, readinessByMember)
    : notReady.length === 0
      ? null
      : `Waiting for ${notReady.length} family member${notReady.length === 1 ? '' : 's'} to finish Extraction`;

  return {
    status: notReady.length === 0 ? 'ready' : 'waiting',
    state,
    blockedReason,
    waitingOn,
    readyCount: members.length - notReady.length,
    memberCount: members.length,
  };
}

/** Deterministic blocked text for one or more blocked members (round-3 R1/R4):
 *  each member surfaces its own deterministic reason — a failed member's
 *  `Member failed in <Stage> (SKU: …)`, or the source-change re-extraction
 *  reason when provenance is inconsistent. */
function buildBlockedMembersReason(
  blockedMembers: CurationCohortMember[],
  itemsById: Map<string, OnboardingItem>,
  readinessByMember: Map<string, ItemExtractionReadiness>,
): string {
  return blockedMembers
    .map(member => {
      const readiness = readinessByMember.get(member.onboardingItemId);
      if (readiness?.blockedReason) return readiness.blockedReason;
      const item = itemsById.get(member.onboardingItemId);
      const sku = item?.upc ?? member.productSku ?? member.onboardingItemId;
      const stage = item?.stage ?? '';
      return `Member failed in ${capitalizeStage(stage)} (SKU: ${sku})`;
    })
    .join('; ');
}

// ─── Refresh / transition ──────────────────────────────────────────────────────

/**
 * Idempotently refresh candidate cohorts for a batch and align their status to
 * the current extraction completeness contract. Safe to call on every
 * extraction completion and on every curation poll. Returns the active
 * candidate cohorts for the batch.
 */
export function refreshCandidateCohorts(workspaceId: string, batchId: string): CurationCohort[] {
  const items = listItemsByBatch(batchId);
  const cohorts = repoRefreshCandidateCohorts(workspaceId, batchId, items);
  for (const cohort of cohorts) {
    // Candidate states (forming/waiting/ready) are re-aligned to the current
    // evidence. Superseded rows (schema v3) are never rewritten here — PR3+
    // owns them; the guard below already skips them.
    if (!['forming', 'waiting', 'ready'].includes(cohort.status)) continue;
    const members = getCohortMembers(cohort.id);
    const evaluation = evaluateCohortReadiness(cohort, members, items);
    if (evaluation.status === 'ready') {
      updateCohortStatus(cohort.id, 'ready', { blockedReason: null });
    } else {
      updateCohortStatus(cohort.id, 'waiting', { blockedReason: evaluation.blockedReason ?? null });
    }
  }
  return listCohortsByBatch(batchId);
}

/**
 * Transition a cohort to `ready` when every member's extraction evidence is
 * complete. No claiming or execution happens here — that is PR3+.
 *
 * Guard: only `forming | waiting` cohorts may move to `ready`; every other
 * schema-v3 status (superseded) is never moved back to `ready` (issue #30
 * round-2 F6).
 *
 * @returns true when the cohort was transitioned to `ready`.
 */
export function transitionCohortToReadyIfComplete(cohortId: string): boolean {
  const cohort = getCohortById(cohortId);
  if (!cohort) return false;
  if (cohort.status !== 'forming' && cohort.status !== 'waiting') return false;
  const members = getCohortMembers(cohortId);
  const items = listItemsByBatch(cohort.batchId);
  const evaluation = evaluateCohortReadiness(cohort, members, items);
  if (evaluation.status === 'ready') {
    updateCohortStatus(cohortId, 'ready', { blockedReason: null });
    return true;
  }
  return false;
}

// ─── Derived per-item / cohort state (API + UI) ───────────────────────────────

export function getDerivedCohortStateForItem(item: OnboardingItem, items?: OnboardingItem[]): DerivedCohortStateForItem {
  const cohort = getActiveCohortForItem(item.id);
  if (!cohort) {
    return {
      cohortId: null,
      groupKey: null,
      groupLabel: null,
      status: null,
      state: null,
      blockedReason: null,
      waitingOn: [],
      memberCount: 0,
      readyCount: 0,
    };
  }
  // Callers that already loaded the batch items pass them in (per-item callers
  // should not re-load the whole batch for readiness alone); fall back to a
  // full batch load otherwise so existing call sites keep working. The latest
  // extraction-source map is loaded once per evaluation and passed through;
  // the per-item direct path falls back to a single lookup when no batch map
  // is passed (round-3 R4).
  const batchItems = items ?? listItemsByBatch(item.batchId);
  const extractionSources = getLatestExtractionBindingsByItemIds(batchItems.map(i => i.id));
  const members = getCohortMembers(cohort.id);
  const evaluation = evaluateCohortReadiness(cohort, members, batchItems, extractionSources);
  return {
    cohortId: cohort.id,
    groupKey: cohort.groupKey,
    groupLabel: cohort.groupLabel,
    status: cohort.status,
    state: evaluation.state,
    blockedReason: evaluation.blockedReason,
    // All family members still producing evidence — the "Waiting for N family
    // members to finish Extraction" state (a member's own pending extraction
    // is part of the family wait).
    waitingOn: evaluation.waitingOn,
    memberCount: evaluation.memberCount,
    readyCount: evaluation.readyCount,
  };
}

/**
 * Build the API view for one active candidate cohort: per-member extraction
 * readiness plus cohort-level derived waiting state.
 */
export function buildCohortView(cohort: CurationCohort, items: OnboardingItem[]): CurationCohortView {
  const members = getCohortMembers(cohort.id);
  const itemsById = new Map(items.map(item => [item.id, item]));
  // Single batched extraction-source load shared by cohort + member readiness.
  const extractionSources = getLatestExtractionBindingsByItemIds(items.map(item => item.id));
  const evaluation = evaluateCohortReadiness(cohort, members, items, extractionSources);

  const memberViews = members.map(member => {
    const item = itemsById.get(member.onboardingItemId);
    const readiness = item
      ? evaluateItemReadiness(item, extractionSources)
      : { ready: false, state: 'waiting' as const, blockedReason: 'member item not found' };
    return {
      onboardingItemId: member.onboardingItemId,
      productSku: member.productSku,
      normalizedBrand: member.normalizedBrand,
      normalizedNameStem: member.normalizedNameStem,
      extractionHash: member.extractionHash,
      ordinal: member.ordinal,
      item: {
        id: member.onboardingItemId,
        upc: item?.upc ?? member.productSku ?? '',
        name: item?.name ?? '',
      },
      ready: readiness.ready,
      state: readiness.state,
      blockedReason: readiness.ready ? null : readiness.blockedReason,
      waitingOn: evaluation.waitingOn.filter(entry => entry.itemId !== member.onboardingItemId),
    };
  });

  // PR4 C5: additive read-only Execution Product Type exposure — the cohort's
  // CURRENT run's type state (null when no run exists or the type was never
  // resolved). The run row stays the authority; the view never mutates it.
  const currentRun = getCurrentCohortRun(cohort.id);

  return {
    cohort,
    members: memberViews,
    status: cohort.status,
    state: evaluation.state,
    blockedReason: evaluation.blockedReason,
    memberCount: evaluation.memberCount,
    readyCount: evaluation.readyCount,
    waitingOn: evaluation.waitingOn,
    executionProductTypeId: currentRun?.executionProductTypeId ?? null,
    productTypeConfidence: currentRun?.productTypeConfidence ?? null,
    productTypeOutcome: currentRun?.productTypeOutcome ?? null,
    finalMembershipHash: currentRun?.finalMembershipHash ?? null,
  };
}

/**
 * List active candidate cohort views for a batch (used by
 * `GET /api/onboarding/batches/:id/cohorts`).
 */
export function listCandidateCohortViews(batchId: string): CurationCohortView[] {
  const items = listItemsByBatch(batchId);
  return listCohortsByBatch(batchId).map(cohort => buildCohortView(cohort, items));
}
