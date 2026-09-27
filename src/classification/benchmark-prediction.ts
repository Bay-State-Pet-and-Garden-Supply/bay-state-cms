/**
 * Immutable Prediction Bundles
 *
 * Two prediction sources share the frozen-Gold + persisted-bundle lifecycle:
 *
 * - `reviewed_outcome` (legacy): the exact reviewed run's live accepted
 *   decisions with effective revised values/targets. Readable for history and
 *   calibration, but NEVER eligible to qualify raw model accuracy — reviewer
 *   corrections are answers, not predictions. Preserved byte-for-byte so
 *   historical bundle hashes still verify.
 * - `prereview_raw` (version 1): immutable pre-review capture from the
 *   original Classification Run outputs. Reads ONLY immutable proposal fields
 *   (`proposedValue`, `targetId`, `confidence`, `modelCallIds`) plus run /
 *   evidence / model-call provenance. NEVER reads
 *   `classification_proposal_decisions` (accepted revised values/targets), so
 *   later review edits cannot alter a captured bundle. Exact canonical
 *   Product Type IDs come from `getProductTypeIdFromValue(proposedValue) ??
 *   targetId`. Semantic abstention (`reviewable_abstention`) is distinct from
 *   service/validation failure (failed runs/stages/calls, unresolvable
 *   predictions): failures earn no abstention credit.
 *
 * Fail-closed rules (both sources):
 * - Missing predictions for any gold example → error.
 * - Duplicate example ids inside a bundle → error.
 * - bundleHash mismatch against the canonical predictions → error.
 * - Pre-review only: snapshot mismatch between the gold example's source
 *   config hash and the run's config hash → error (config drift).
 */

import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/stable-id';
import { pageNameFromPageValue } from '../shared/proposal-display';
import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import * as classRunRepo from '../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../db/repositories/classification-model-call-repo';
import type { BenchmarkPredictionEntry, BenchmarkPredictionBundle } from '../shared/schemas/classification';
import {
  effectiveReviewedTargetId,
  effectiveReviewedValue,
  selectBestByProbability,
  type QualificationGoldCore,
} from './benchmark-scoring-helpers';

/**
 * Explicit prediction-source contract. New raw bundles carry
 * `source: 'prereview_raw'` + `bundleVersion: 1` on every entry and in the
 * persisted envelope; legacy reviewed-outcome bundles are plain arrays with
 * no source marker and load as `reviewed_outcome` (version 0).
 */
export const PRE_REVIEW_PREDICTION_SOURCE = 'prereview_raw' as const;
export const REVIEWED_OUTCOME_PREDICTION_SOURCE = 'reviewed_outcome' as const;
export const PRE_REVIEW_BUNDLE_VERSION = 1 as const;
export const LEGACY_BUNDLE_VERSION = 0 as const;

export type PredictionSourceKind = typeof PRE_REVIEW_PREDICTION_SOURCE | typeof REVIEWED_OUTCOME_PREDICTION_SOURCE;

/** Per-target outcome for a pre-review product-type prediction. */
export type PreReviewOutcomeKind = 'predicted' | 'abstained' | 'failed';

/** Provenance captured at pre-review build time (immutable after persist). */
export interface PreReviewEntryProvenance {
  runId: string;
  configSnapshotHash: string | null;
  sourceProductHash: string | null;
  evidenceCount: number;
  evidenceHash: string | null;
  modelCalls: Array<{
    id: string;
    operation: string;
    provider: string | null;
    model: string | null;
    requestedModel?: string | null;
    resolvedModel?: string | null;
    status: string;
  }>;
  primaryModelProvider: string | null;
  primaryModel: string | null;
  verifiedPageImportHash?: string | null;
  capturedAt: string;
}

/**
 * A pre-review prediction entry: the legacy entry shape plus an explicit
 * source/version contract, outcome, and provenance. Extra fields are part of
 * the bundle hash (they are stringified by `computePredictionBundleHash`),
 * so the hash binds the source contract for new bundles while legacy bundles
 * (without these fields) hash exactly as before.
 */
export type PreReviewPredictionEntry = BenchmarkPredictionEntry & {
  source: typeof PRE_REVIEW_PREDICTION_SOURCE;
  bundleVersion: typeof PRE_REVIEW_BUNDLE_VERSION;
  outcome: PreReviewOutcomeKind;
  abstentionReason?: string | null;
  failureCode?: string | null;
  provenance?: PreReviewEntryProvenance;
};

/** Persisted envelope for pre-review bundles (same column, new shape). */
export interface PreReviewBundleEnvelope {
  version: typeof PRE_REVIEW_BUNDLE_VERSION;
  source: typeof PRE_REVIEW_PREDICTION_SOURCE;
  predictions: PreReviewPredictionEntry[];
  provenance: {
    datasetId: string;
    splitGroup: 'test' | 'holdout';
    runLabel: string;
    workspaceId: string;
    capturedAt: string;
  };
}

/** True for the persisted pre-review envelope shape (legacy rows are arrays). */
export function isPreReviewBundleEnvelope(value: unknown): value is PreReviewBundleEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.source === PRE_REVIEW_PREDICTION_SOURCE && v.version === PRE_REVIEW_BUNDLE_VERSION && Array.isArray(v.predictions);
}

/**
 * Resolve the stored bundle source without trusting callers: arrays are
 * legacy reviewed-outcome bundles; envelopes must carry the pre-review
 * marker or they are rejected as corrupt.
 */
export function describeStoredBundleSource(parsed: unknown): { source: PredictionSourceKind; bundleVersion: number } {
  if (Array.isArray(parsed)) return { source: REVIEWED_OUTCOME_PREDICTION_SOURCE, bundleVersion: LEGACY_BUNDLE_VERSION };
  if (isPreReviewBundleEnvelope(parsed)) return { source: PRE_REVIEW_PREDICTION_SOURCE, bundleVersion: PRE_REVIEW_BUNDLE_VERSION };
  throw new Error('Persisted prediction bundle has an unknown source/version envelope.');
}
/**
 * Gold-label states for the Product Type target (issue #294). Catalog
 * assignments are never auto-gold: gold is adjudicated, and the states below
 * distinguish "we know the answer" from "there is no answer to get right".
 * - `known-type`: a canonical Product Type ID is the adjudicated label.
 * - `no-fit`: no configured type fits (a correct prediction is an explicit
 *   semantic abstention with a no-fit reason — never a forced guess).
 * - `insufficient-evidence`: evidence was insufficient to adjudicate (same
 *   scoring treatment as `no-fit`).
 * - `unlabeled`: the target was never adjudicated — excluded from raw
 *   accuracy (never counted as correct, incorrect, or abstained).
 */
const GOLD_KIND_KNOWN_TYPE = 'known-type' as const;
const GOLD_KIND_NO_FIT = 'no-fit' as const;
const GOLD_KIND_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
const GOLD_KIND_UNLABELED = 'unlabeled' as const;

export type GoldKind = typeof GOLD_KIND_KNOWN_TYPE | typeof GOLD_KIND_NO_FIT | typeof GOLD_KIND_INSUFFICIENT_EVIDENCE | typeof GOLD_KIND_UNLABELED;

/**
 * Adjudicated gold view for one example's Product Type target. `kind`
 * defaults to `known-type` when the stored label is a non-empty string and to
 * `unlabeled` when it is null/undefined; the other two states travel inside
 * `value` as `{ kind: 'no-fit' | 'insufficient-evidence', ... }` so legacy
 * string/null gold labels keep their exact bytes (and hashes).
 */
export interface AdjudicatedGoldType {
  kind: GoldKind;
  /** Canonical type ID when kind is `known-type`, else null. */
  typeId: string | null;
}

/** Exact gold-kind table for object-shaped gold labels (legacy bytes preserved). */
const OBJECT_GOLD_KINDS: Record<string, GoldKind> = {
  [GOLD_KIND_NO_FIT]: GOLD_KIND_NO_FIT,
  [GOLD_KIND_INSUFFICIENT_EVIDENCE]: GOLD_KIND_INSUFFICIENT_EVIDENCE,
  [GOLD_KIND_UNLABELED]: GOLD_KIND_UNLABELED,
  [GOLD_KIND_KNOWN_TYPE]: GOLD_KIND_KNOWN_TYPE,
};

/** Adjudicate a known-type object label (valid typeId wins, else unlabeled). */
function adjudicateKnownTypeObjectKind(value: Record<string, unknown>): AdjudicatedGoldType {
  if (!('typeId' in value)) return { kind: GOLD_KIND_UNLABELED, typeId: null };
  const typeId: unknown = value.typeId;
  if (typeof typeId === 'string' && typeId.length > 0) return { kind: GOLD_KIND_KNOWN_TYPE, typeId };
  return { kind: GOLD_KIND_UNLABELED, typeId: null };
}

/** Adjudicate an object-shaped gold label to its kind (known-type needs a typeId). */
function adjudicateGoldObjectKind(value: Record<string, unknown>): AdjudicatedGoldType {
  const kind = typeof value.kind === 'string' ? (OBJECT_GOLD_KINDS[value.kind] ?? null) : null;
  if (kind === GOLD_KIND_NO_FIT) return { kind: GOLD_KIND_NO_FIT, typeId: null };
  if (kind === GOLD_KIND_INSUFFICIENT_EVIDENCE) {
    return { kind: GOLD_KIND_INSUFFICIENT_EVIDENCE, typeId: null };
  }
  if (kind === GOLD_KIND_UNLABELED) return { kind: GOLD_KIND_UNLABELED, typeId: null };
  if (kind === GOLD_KIND_KNOWN_TYPE) return adjudicateKnownTypeObjectKind(value);
  return { kind: GOLD_KIND_UNLABELED, typeId: null };
}

/** Normalize a stored gold productType label to its adjudicated kind. */
export function adjudicateGoldProductType(value: unknown): AdjudicatedGoldType {
  if (typeof value === 'string') {
    return value.length > 0
      ? { kind: GOLD_KIND_KNOWN_TYPE, typeId: value }
      : { kind: GOLD_KIND_UNLABELED, typeId: null };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value) {
    return adjudicateGoldObjectKind(value as Record<string, unknown>);
  }
  return { kind: GOLD_KIND_UNLABELED, typeId: null };
}

/**
 * Exact canonical Product Type ID from an IMMUTABLE proposal (never a
 * reviewer decision): `proposedValue { productTypeId }` wins, then a plain
 * string `proposedValue`, then `targetId`. Mirrors
 * `getEffectivePrimaryProductTypeId` for legacy `targetId`-carried IDs but
 * without the revised-value/target branches — decisions are answers, not
 * predictions. Returns null when the proposal carries no usable ID.
 */
export function canonicalPreReviewTypeId(proposal: { proposedValue?: unknown; targetId?: string | null }): string | null {
  const pv: unknown = proposal.proposedValue;
  if (pv && typeof pv === 'object' && !Array.isArray(pv) && 'productTypeId' in pv) {
    const id: unknown = pv.productTypeId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  if (typeof pv === 'string' && pv.length > 0) return pv;
  return typeof proposal.targetId === 'string' && proposal.targetId.length > 0 ? proposal.targetId : null;
}

export interface GoldExampleForPrediction {
  id: string;
  productSku: string;
}

export function computePredictionBundleHash(predictions: BenchmarkPredictionEntry[]): string {
  const sorted = [...predictions].sort((a, b) => (a.exampleId < b.exampleId ? -1 : a.exampleId > b.exampleId ? 1 : 0));
  return sha256Hex(JSON.stringify(sorted));
}

/**
 * LEGACY reviewed-outcome extraction (`reviewed_outcome`, version 0).
 *
 * Reads the live (non-superseded) accepted decisions of the most recent
 * completed run, using the effective revised values/targets. Stale proposals
 * are excluded. Because reviewer corrections are answers — not model
 * predictions — bundles built from this path stay readable for history but
 * are NEVER eligible to qualify raw model accuracy (see
 * `assessBasicPredictionSourceEligibility`). Preserved byte-for-byte so historical
 * bundle hashes still verify. New captures MUST use
 * `extractPreReviewPredictionForSku` instead.
 */
interface ReviewedOutcomeAccumulator {
  productType: string | null;
  pageAssignments: string[];
  fieldAssignments: Array<{ targetId: string; value: string | null }>;
  abstained: boolean;
  confidence: number | null;
}

function emptyReviewedOutcomeAccumulator(): ReviewedOutcomeAccumulator {
  return { productType: null, pageAssignments: [], fieldAssignments: [], abstained: false, confidence: null };
}

type ReviewedRunProposal = ReturnType<typeof classRunRepo.getProposalsByRun>[number];
type ReviewedRunDecision = ReturnType<typeof classRunRepo.getLiveDecisionsByRun>[number];

/** Apply one accepted primary-product-type proposal to the accumulator. */
function applyReviewedTypeProposal(
  acc: ReviewedOutcomeAccumulator,
  proposal: ReviewedRunProposal,
  value: string | null,
): void {
  acc.productType = value;
  acc.confidence = proposal.confidence;
}

/** Apply one accepted category-page proposal (display name, never the Page ID). */
function applyReviewedPageProposal(
  acc: ReviewedOutcomeAccumulator,
  proposal: ReviewedRunProposal,
  decision: ReviewedRunDecision,
): void {
  const pageName = pageNameFromPageValue(
    decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
  );
  if (pageName) acc.pageAssignments.push(pageName);
}

/** Apply one accepted field-assignment proposal to the accumulator. */
function applyReviewedFieldProposal(
  acc: ReviewedOutcomeAccumulator,
  effectiveTarget: string | null | undefined,
  value: string | null,
): void {
  if (effectiveTarget) acc.fieldAssignments.push({ targetId: effectiveTarget, value });
}

/** Score one reviewed proposal into the accumulator (accepted decisions only). */
function scoreReviewedOutcomeProposal(
  acc: ReviewedOutcomeAccumulator,
  proposal: ReviewedRunProposal,
  decisions: ReviewedRunDecision[],
): void {
  // Exclude stale/config-drift/source-drift records at extraction time.
  if (proposal.isStale) return;
  if (proposal.proposalType === 'reviewable_abstention') {
    acc.abstained = true;
    return;
  }
  const decision = decisions.find(d => d.proposalId === proposal.id);
  if (!decision || decision.decision !== 'accepted') return;
  const value = effectiveReviewedValue(decision, proposal);
  const effectiveTarget = effectiveReviewedTargetId(decision, proposal);
  if (proposal.proposalType === 'primary_product_type') {
    applyReviewedTypeProposal(acc, proposal, value);
  } else if (proposal.proposalType === 'category_page') {
    // Page labels use the display name from the effective value — never the
    // stable Page ID (issue #17 D1).
    applyReviewedPageProposal(acc, proposal, decision);
  } else if (proposal.proposalType === 'field_assignment') {
    applyReviewedFieldProposal(acc, effectiveTarget, value);
  }
}

/** Score all reviewed proposals of a run into one outcome. */
function scoreReviewedOutcomeProposals(
  proposals: ReviewedRunProposal[],
  decisions: ReviewedRunDecision[],
): ReviewedOutcomeAccumulator {
  const acc = emptyReviewedOutcomeAccumulator();
  for (const proposal of proposals) {
    scoreReviewedOutcomeProposal(acc, proposal, decisions);
  }
  return acc;
}

export function extractPredictionsForSku(
  workspaceId: string,
  sku: string,
  claimTargets: string[] = [],
): BenchmarkPredictionEntry | null {
  const run = classRunRepo.getRecentRun(workspaceId, sku);
  if (!run) return null;

  const proposals = classRunRepo.getProposalsByRun(run.id);
  if (proposals.length === 0) return null;

  const decisions = classRunRepo.getLiveDecisionsByRun(run.id);
  const outcome = scoreReviewedOutcomeProposals(proposals, decisions);

  if (!outcome.productType && outcome.pageAssignments.length === 0 && outcome.fieldAssignments.length === 0 && !outcome.abstained) {
    return null;
  }

  return {
    exampleId: '', // filled by the builder against the gold example id
    productSku: sku,
    productType: outcome.productType,
    pageAssignments: [...new Set(outcome.pageAssignments)],
    fieldAssignments: outcome.fieldAssignments,
    abstained: outcome.abstained,
    confidence: outcome.confidence,
    claimTargets,
  };
}
export interface PreReviewCaptureInput {
  /** Exact run to capture from (never "latest" — callers resolve it). */
  runId: string;
  workspaceId: string;
  productSku: string;
  claimTargets?: string[];
}

/** Coded service/validation failures (never abstention credit). */
const PRE_REVIEW_FAILURE_NO_RUN = 'no_run' as const;
const PRE_REVIEW_FAILURE_RUN_FAILED = 'run_failed' as const;
const PRE_REVIEW_FAILURE_RUN_INCOMPLETE = 'run_incomplete' as const;
const PRE_REVIEW_FAILURE_STAGE_FAILED = 'stage_failed' as const;
const PRE_REVIEW_FAILURE_CALL_FAILED = 'call_failed' as const;
const PRE_REVIEW_FAILURE_NO_PREDICTION = 'no_prediction' as const;
const PRE_REVIEW_FAILURE_AMBIGUOUS_PREDICTION = 'ambiguous_prediction' as const;

/**
 * Decode a `reviewable_abstention` reason from the immutable proposedValue.
 * Returns the reason string when present, else a stable fallback.
 */
function abstentionReasonFromValue(proposedValue: unknown, fallback: string): string {
  if (proposedValue && typeof proposedValue === 'object' && !Array.isArray(proposedValue) && 'reason' in proposedValue) {
    const reason: unknown = proposedValue.reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  if (typeof proposedValue === 'string' && proposedValue.length > 0) return proposedValue;
  return fallback;
}

/** True when a proposedValue object carries an explicit code field. */
function codeFromValue(proposedValue: unknown): string | null {
  if (proposedValue && typeof proposedValue === 'object' && !Array.isArray(proposedValue) && 'code' in proposedValue) {
    const code: unknown = proposedValue.code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }
  return null;
}

/** Evidence fingerprint for provenance (count + hash of stable evidence fields). */
function evidenceFingerprint(evidence: Array<{ source: unknown; snippet: unknown; reliability: unknown; attributeId: unknown }>): { count: number; hash: string | null } {
  if (evidence.length === 0) return { count: 0, hash: null };
  return { count: evidence.length, hash: sha256Hex(JSON.stringify(evidence)) };
}

/**
 * Capture an immutable pre-review prediction from ONE exact Classification
 * Run's original outputs. Reads ONLY immutable proposal fields
 * (`proposedValue`, `targetId`, `confidence`, `modelCallIds`) plus run /
 * evidence / stage / model-call provenance. NEVER reads
 * `classification_proposal_decisions` — reviewer revised values/targets and
 * later review edits cannot alter the result.
 *
 * Product Type resolution: among non-stale `primary_product_type` proposals,
 * the single highest-confidence entry wins (`confidence`, then `createdAt`,
 * then `id` for determinism) and its exact canonical ID comes from
 * `canonicalPreReviewTypeId`. Zero such proposals → semantic abstention when
 * a `reviewable_abstention` names the product-type stage, else a
 * `no_prediction` service failure. Two+ winners with distinct IDs (a tie the
 * deterministic order cannot break) → `ambiguous_prediction` failure.
 * Semantic abstention is an explicit outcome; every `failed` outcome earns no
 * abstention credit downstream.
 */
type PreReviewRun = ReturnType<typeof classRunRepo.getRun>;
type PreReviewProposal = ReturnType<typeof classRunRepo.getProposalsByRun>[number];
type PreReviewModelCall = ReturnType<typeof getModelCallsByRun>[number];

interface PreReviewCaptureBase {
  exampleId: string;
  productSku: string;
  pageAssignments: string[];
  pageIds: string[];
  verifiedImportProvenance: string | null;
  fieldAssignments: Array<{ targetId: string; value: string | null; values?: string[] }>;
  abstained: boolean;
  confidence: number | null;
  claimTargets: string[];
  source: typeof PRE_REVIEW_PREDICTION_SOURCE;
  bundleVersion: typeof PRE_REVIEW_BUNDLE_VERSION;
}

/** Fresh capture base for one product (fields filled by the collectors below). */
function buildPreReviewBase(input: PreReviewCaptureInput): PreReviewCaptureBase {
  return {
    exampleId: '',
    productSku: input.productSku,
    pageAssignments: [],
    pageIds: [],
    verifiedImportProvenance: null,
    fieldAssignments: [],
    abstained: false,
    confidence: null,
    claimTargets: input.claimTargets ?? [],
    source: PRE_REVIEW_PREDICTION_SOURCE,
    bundleVersion: PRE_REVIEW_BUNDLE_VERSION,
  };
}

/** Failed capture entry (never abstention credit; provenance attached by callers). */
function failPreReviewPrediction(
  base: PreReviewCaptureBase,
  failureCode: string,
): PreReviewPredictionEntry {
  return {
    ...base,
    productType: null,
    outcome: 'failed',
    failureCode,
    abstentionReason: null,
  };
}

/** Load the exact replay run (null when missing or bound to another SKU/workspace). */
function loadPreReviewRun(input: PreReviewCaptureInput): PreReviewRun | null {
  const run = classRunRepo.getRun(input.runId);
  if (!run || run.workspaceId !== input.workspaceId || run.productSku !== input.productSku) {
    return null;
  }
  return run;
}

/** Evidence fingerprint for provenance (count + hash of stable evidence fields). */
function fingerprintRunEvidence(
  run: NonNullable<PreReviewRun>,
): { count: number; hash: string | null } {
  const evidence = classRunRepo.getEvidenceByRun(run.id);
  return evidenceFingerprint(evidence.map(e => ({
    source: e.source,
    snippet: e.snippet,
    reliability: e.reliability,
    attributeId: e.attributeId,
  })));
}

/** Primary model call: latest `product_type_ranking` call, else the latest call. */
function selectPrimaryModelCall(calls: PreReviewModelCall[]): PreReviewModelCall | null {
  const byStartedDesc = (a: PreReviewModelCall, b: PreReviewModelCall) =>
    (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0);
  return [...calls].filter(call => call.operation === 'product_type_ranking').sort(byStartedDesc)[0]
    ?? [...calls].sort(byStartedDesc)[0]
    ?? null;
}

/** Provenance snapshot captured at pre-review build time (immutable after persist). */
function buildPreReviewProvenance(
  run: NonNullable<PreReviewRun>,
  capturedAt: string,
): PreReviewEntryProvenance {
  const evidencePrint = fingerprintRunEvidence(run);
  const calls = getModelCallsByRun(run.id);
  const primaryCall = selectPrimaryModelCall(calls);
  return {
    runId: run.id,
    configSnapshotHash: run.configSnapshotHash,
    sourceProductHash: run.sourceProductHash,
    evidenceCount: evidencePrint.count,
    evidenceHash: evidencePrint.hash,
    modelCalls: calls.map(call => ({
      id: call.id,
      operation: call.operation,
      provider: call.provider,
      model: call.model,
      requestedModel: call.requested_model ?? null,
      resolvedModel: call.resolved_model ?? null,
      status: call.status,
    })),
    primaryModelProvider: primaryCall?.provider ?? null,
    primaryModel: primaryCall?.model ?? null,
    verifiedPageImportHash: run.configSnapshotHash ?? null,
    capturedAt,
  };
}

/** True when the product-type proposal stage itself failed. */
function isProductTypeStageFailed(runId: string): boolean {
  return classRunRepo.getStageResults(runId).some(stage => {
    const stageName: unknown = stage.stage_name;
    return stageName === 'primary_product_type_proposal' && stage.status === 'failed';
  });
}

/** True when any model call for the run failed or was cancelled. */
function hasFailedModelCall(runId: string): boolean {
  return getModelCallsByRun(runId).some(call => call.status === 'failed' || call.status === 'cancelled');
}

/**
 * Map run health to a terminal failure code (null when the run may proceed).
 * Order mirrors the legacy gate: incomplete terminal state first, then stage
 * failure, then model-call failure.
 */
function assessPreReviewRunHealth(
  run: NonNullable<PreReviewRun>,
  terminalOk: boolean,
): string | null {
  if (!terminalOk) return PRE_REVIEW_FAILURE_RUN_INCOMPLETE;
  if (isProductTypeStageFailed(run.id)) return PRE_REVIEW_FAILURE_STAGE_FAILED;
  if (hasFailedModelCall(run.id)) return PRE_REVIEW_FAILURE_CALL_FAILED;
  return null;
}

/** Normalize one field-assignment proposed value to value/values. */
function normalizePreReviewFieldValue(
  proposedValue: unknown,
): { value: string | null; values: string[] | undefined } {
  if (Array.isArray(proposedValue)) {
    const values = proposedValue
      .map(v => typeof v === 'string' ? v : (v != null ? String(v) : ''))
      .filter(Boolean);
    return { value: values.join(', '), values };
  }
  if (typeof proposedValue === 'string') {
    return { value: proposedValue, values: [proposedValue] };
  }
  if (proposedValue != null) {
    const value = String(proposedValue);
    return { value, values: [value] };
  }
  return { value: null, values: undefined };
}

/** True for abstention targets naming the type/page stages (never field targets). */
function isTypeOrPageAbstentionTarget(targetId: string): boolean {
  return targetId === 'primary_product_type_proposal' ||
    targetId === 'primary_product_type' ||
    targetId === 'product_type_ranking' ||
    targetId === 'category_page_assignment';
}

type PreReviewFieldProposal = { value: string | null; values?: string[]; confidence: number; proposalType: string };

/** Apply one field-assignment proposal (highest confidence wins per target). */
function applyPreReviewFieldProposal(
  byTarget: Map<string, PreReviewFieldProposal>,
  proposal: PreReviewProposal,
): void {
  if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) return;
  const { value, values } = normalizePreReviewFieldValue(proposal.proposedValue);
  const existing = byTarget.get(proposal.targetId);
  if (!existing || existing.proposalType !== 'field_assignment' || (proposal.confidence ?? 0) > existing.confidence) {
    byTarget.set(proposal.targetId, { value, values, confidence: proposal.confidence ?? 0, proposalType: 'field_assignment' });
  }
}

/** Apply one reviewable-abstention proposal as a null field placeholder. */
function applyPreReviewAbstentionPlaceholder(
  byTarget: Map<string, PreReviewFieldProposal>,
  proposal: PreReviewProposal,
): void {
  if (proposal.proposalType !== 'reviewable_abstention' || !proposal.targetId) return;
  if (isTypeOrPageAbstentionTarget(proposal.targetId)) return;
  if (!byTarget.has(proposal.targetId)) {
    byTarget.set(proposal.targetId, { value: null, confidence: 0, proposalType: 'reviewable_abstention' });
  }
}

/** Collect field assignments from non-stale proposals (sorted by target id). */
function collectPreReviewFieldAssignments(
  proposals: PreReviewProposal[],
): Array<{ targetId: string; value: string | null; values?: string[] }> {
  const byTarget = new Map<string, PreReviewFieldProposal>();
  for (const proposal of proposals) {
    applyPreReviewFieldProposal(byTarget, proposal);
    applyPreReviewAbstentionPlaceholder(byTarget, proposal);
  }
  return [...byTarget.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetId, { value, values }]) => ({ targetId, value, ...(values ? { values } : {}) }));
}

/** Display name for one pre-review page proposal (never the stable Page ID). */
function preReviewPageNameOf(
  proposal: PreReviewProposal,
  value: unknown,
): string | null {
  const named = (value as { pageName?: unknown } | null | undefined)?.pageName;
  if (named !== null && named !== undefined) return named as string;
  if (typeof value === 'string') return value;
  return typeof proposal.targetId === 'string' ? proposal.targetId : null;
}

/** Stable id for one pre-review page proposal (null when absent). */
function preReviewPageIdOf(
  proposal: PreReviewProposal,
  value: unknown,
): string | null {
  const id = (value as { pageId?: unknown } | null | undefined)?.pageId;
  if (id !== null && id !== undefined) return id as string;
  return typeof proposal.targetId === 'string' && proposal.targetId.length > 0 ? proposal.targetId : null;
}

/** Accumulate one category-page proposal into the name/id lists (deduped). */
function accumulatePreReviewPage(
  pageNames: string[],
  pageIds: string[],
  proposal: PreReviewProposal,
): void {
  const val = proposal.proposedValue as { pageName?: string; pageId?: string } | string | null;
  const name = preReviewPageNameOf(proposal, val);
  const id = preReviewPageIdOf(proposal, val);
  if (name && !pageNames.includes(name)) pageNames.push(name);
  if (id && !pageIds.includes(id)) pageIds.push(id);
}

/** Collect category-page names/ids from non-stale page proposals. */
function collectPreReviewPages(
  proposals: PreReviewProposal[],
): { pageNames: string[]; pageIds: string[] } {
  const pageNames: string[] = [];
  const pageIds: string[] = [];
  for (const proposal of proposals.filter(p => p.proposalType === 'category_page')) {
    accumulatePreReviewPage(pageNames, pageIds, proposal);
  }
  return { pageNames, pageIds };
}

/** Deterministic type-proposal order: confidence, then createdAt, then id. */
function sortPreReviewTypeProposals(proposals: PreReviewProposal[]): PreReviewProposal[] {
  return proposals
    .filter(p => p.proposalType === 'primary_product_type')
    .sort((a, b) =>
      b.confidence - a.confidence
      || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** Distinct-ID contender tied with the winner (unbreakable tie → ambiguous). */
function findAmbiguousTypeContender(
  typeProposals: PreReviewProposal[],
  winner: PreReviewProposal,
  winnerId: string,
): PreReviewProposal | undefined {
  return typeProposals.find(
    p => p.confidence === winner.confidence && p.id !== winner.id && canonicalPreReviewTypeId(p) !== winnerId,
  );
}

/**
 * Resolve the product-type outcome (null when no type proposals exist —
 * the caller falls through to explicit abstention handling).
 */
function resolvePreReviewProductType(
  proposals: PreReviewProposal[],
  base: PreReviewCaptureBase,
  provenance: PreReviewEntryProvenance,
): PreReviewPredictionEntry | null {
  const typeProposals = sortPreReviewTypeProposals(proposals);
  if (typeProposals.length === 0) return null;
  const winner = typeProposals[0];
  const winnerId = canonicalPreReviewTypeId(winner);
  if (!winnerId) return { ...failPreReviewPrediction(base, PRE_REVIEW_FAILURE_NO_PREDICTION), provenance };
  if (findAmbiguousTypeContender(typeProposals, winner, winnerId)) {
    return { ...failPreReviewPrediction(base, PRE_REVIEW_FAILURE_AMBIGUOUS_PREDICTION), provenance };
  }
  return {
    ...base,
    productType: winnerId,
    abstained: false,
    confidence: winner.confidence,
    outcome: 'predicted',
    abstentionReason: null,
    failureCode: codeFromValue(winner.proposedValue),
    provenance,
  };
}

/** True for abstentions naming the product-type stage/target. */
function isProductTypeAbstention(proposal: PreReviewProposal): boolean {
  return proposal.proposalType === 'reviewable_abstention'
    && (proposal.targetId === 'primary_product_type_proposal' ||
      proposal.targetId === 'primary_product_type' ||
      proposal.targetId === 'product_type_ranking');
}

/**
 * Resolve the no-type-proposal outcome: explicit semantic abstention only
 * when a `reviewable_abstention` names the product-type stage/target,
 * else a `no_prediction` service failure.
 */
function resolvePreReviewAbstention(
  proposals: PreReviewProposal[],
  base: PreReviewCaptureBase,
  provenance: PreReviewEntryProvenance,
): PreReviewPredictionEntry {
  const abstention = proposals.find(isProductTypeAbstention);
  if (abstention) {
    return {
      ...base,
      productType: null,
      abstained: true,
      confidence: null,
      outcome: 'abstained',
      abstentionReason: abstentionReasonFromValue(abstention.proposedValue, 'abstained: no confident product type match'),
      failureCode: null,
      provenance,
    };
  }
  return { ...failPreReviewPrediction(base, PRE_REVIEW_FAILURE_NO_PREDICTION), provenance };
}

export function capturePreReviewPrediction(input: PreReviewCaptureInput): PreReviewPredictionEntry {
  const capturedAt = new Date().toISOString();
  const base = buildPreReviewBase(input);

  const run = loadPreReviewRun(input);
  if (!run) return failPreReviewPrediction(base, PRE_REVIEW_FAILURE_NO_RUN);

  const terminalOk = run.status === 'completed' || run.status === 'completed_with_abstentions';
  if (run.status === 'failed' || run.status === 'cancelled') {
    return failPreReviewPrediction(base, PRE_REVIEW_FAILURE_RUN_FAILED);
  }

  const provenance = buildPreReviewProvenance(run, capturedAt);
  const healthFailure = assessPreReviewRunHealth(run, terminalOk);
  if (healthFailure) return { ...failPreReviewPrediction(base, healthFailure), provenance };

  const proposals = classRunRepo.getProposalsByRun(run.id).filter(p => !p.isStale);
  base.fieldAssignments = collectPreReviewFieldAssignments(proposals);
  const { pageNames, pageIds } = collectPreReviewPages(proposals);
  base.pageAssignments = pageNames;
  base.pageIds = pageIds;
  base.verifiedImportProvenance = run.configSnapshotHash ?? null;

  return resolvePreReviewProductType(proposals, base, provenance)
    ?? resolvePreReviewAbstention(proposals, base, provenance);
}

export function validatePredictionBundle(
  predictions: BenchmarkPredictionEntry[],
  goldExamples: GoldExampleForPrediction[],
  bundleHash: string,
): void {
  const expected = new Map(goldExamples.map(e => [e.id, e.productSku]));

  if (predictions.length !== goldExamples.length) {
    throw new Error(
      `Prediction bundle incomplete: ${predictions.length} predictions for ${goldExamples.length} gold examples.`,
    );
  }

  const seen = new Set<string>();
  for (const prediction of predictions) {
    if (!expected.has(prediction.exampleId)) {
      throw new Error(`Prediction bundle references unknown example id "${prediction.exampleId}".`);
    }
    if (prediction.productSku !== expected.get(prediction.exampleId)) {
      throw new Error(
        `Prediction bundle SKU mismatch for example "${prediction.exampleId}": got "${prediction.productSku}", expected "${expected.get(prediction.exampleId)}".`,
      );
    }
    if (seen.has(prediction.exampleId)) {
      throw new Error(`Prediction bundle contains duplicate example id "${prediction.exampleId}".`);
    }
    seen.add(prediction.exampleId);
  }

  const computed = computePredictionBundleHash(predictions);
  if (computed !== bundleHash) {
    throw new Error(`Prediction bundle digest mismatch: expected ${bundleHash}, computed ${computed}.`);
  }
}

export interface BuildPredictionBundleOptions {
  runLabel: string;
  splitGroup: 'test' | 'holdout';
  /** Target ids whose attributes are claim-sensitive (from the active config). */
  claimTargets?: string[];
}

interface GoldExampleForPreReviewBuild {
  id: string;
  product_sku: string;
  source_run_id: string | null;
  source_config_hash: string | null;
}

/** Gold examples for one frozen split (fail closed on missing/draft data). */
function loadFrozenSplitGoldExamples(
  workspaceId: string,
  datasetId: string,
  splitGroup: 'test' | 'holdout',
): { datasetId: string; goldExamples: ReturnType<typeof benchmarkRepo.getExamples> } {
  const dataset = benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId);
  if (!dataset) throw new Error('Dataset not found or not owned by this workspace.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Predictions require a frozen dataset; dataset is ${dataset.status}.`);
  }
  const goldExamples = benchmarkRepo.getExamples(datasetId, splitGroup);
  if (goldExamples.length === 0) {
    throw new Error(`No gold examples in split "${splitGroup}".`);
  }
  return { datasetId, goldExamples };
}

type FrozenSplitGoldExample = ReturnType<typeof loadFrozenSplitGoldExamples>['goldExamples'][number];

/** Fail-closed bundle assembly shared by both prediction sources. */
function assemblePredictionBundle(
  workspaceId: string,
  datasetId: string,
  options: BuildPredictionBundleOptions,
  predictions: BenchmarkPredictionEntry[],
  goldExamples: FrozenSplitGoldExample[],
  capturedAt: string,
): BenchmarkPredictionBundle {
  const bundleHash = computePredictionBundleHash(predictions);
  const bundle: BenchmarkPredictionBundle = {
    id: randomUUID(),
    datasetId,
    workspaceId,
    runLabel: options.runLabel,
    splitGroup: options.splitGroup,
    predictions,
    bundleHash,
    createdAt: capturedAt,
  };
  // Fail closed BEFORE persisting: the persisted bundle must be complete and
  // self-consistent, otherwise no evaluation can ever be run against it.
  validatePredictionBundle(
    predictions,
    goldExamples.map(e => ({ id: e.id, productSku: e.product_sku })),
    bundleHash,
  );
  return bundle;
}

/** Capture one pre-review prediction with its frozen source-config check. */
function capturePreReviewExamplePrediction(
  workspaceId: string,
  example: FrozenSplitGoldExample,
  claimTargets: string[],
): PreReviewPredictionEntry {
  const runId = resolveReplayRunId(workspaceId, example);
  const entry = capturePreReviewPrediction({ runId, workspaceId, productSku: example.product_sku, claimTargets });
  if (example.source_config_hash && entry.provenance?.configSnapshotHash !== example.source_config_hash) {
    throw new Error(
      `Snapshot mismatch for gold example "${example.id}" (SKU ${example.product_sku}): replay run config does not match the frozen source.`,
    );
  }
  return { ...entry, exampleId: example.id };
}

/** Capture one legacy reviewed-outcome prediction (fail closed when absent). */
function captureReviewedExamplePrediction(
  workspaceId: string,
  example: FrozenSplitGoldExample,
  claimTargets: string[],
): BenchmarkPredictionEntry {
  const entry = extractPredictionsForSku(workspaceId, example.product_sku, claimTargets);
  if (!entry) {
    throw new Error(
      `No reviewed-run prediction available for gold example "${example.id}" (SKU ${example.product_sku}).`,
    );
  }
  return { ...entry, exampleId: example.id };
}
/** Resolve the exact run a gold example replays (fail closed on ambiguity). */
function resolveReplayRunId(
  workspaceId: string,
  example: GoldExampleForPreReviewBuild,
): string {
  if (example.source_run_id) {
    const pinned = classRunRepo.getRun(example.source_run_id);
    if (!pinned || pinned.workspaceId !== workspaceId || pinned.productSku !== example.product_sku) {
      throw new Error(
        `Gold example "${example.id}" pins a run that does not belong to SKU ${example.product_sku}.`,
      );
    }
    return pinned.id;
  }
  const recent = classRunRepo.getRecentRun(workspaceId, example.product_sku);
  if (!recent) {
    throw new Error(
      `No classification run available for gold example "${example.id}" (SKU ${example.product_sku}).`,
    );
  }
  return recent.id;
}

/**
 * Build an immutable pre-review prediction bundle (`prereview_raw`, version
 * 1) from the original Classification Run outputs and persist it BEFORE
 * evaluation. For each gold example the exact replay run is captured via
 * `capturePreReviewPrediction` — never reviewer decisions. Fails closed on
 * any missing/ambiguous run, snapshot mismatch against the gold example's
 * source config hash (config drift), per-example failure capture gaps for
 * `known-type` gold (a service failure is not a prediction), or digest
 * inconsistency. Later review edits cannot alter the persisted envelope.
 */
export function buildPreReviewPredictionBundle(
  workspaceId: string,
  datasetId: string,
  options: BuildPredictionBundleOptions,
): BenchmarkPredictionBundle {
  const { goldExamples } = loadFrozenSplitGoldExamples(workspaceId, datasetId, options.splitGroup);

  const claimTargets = options.claimTargets ?? [];
  const capturedAt = new Date().toISOString();
  const predictions: PreReviewPredictionEntry[] = goldExamples.map(example =>
    capturePreReviewExamplePrediction(workspaceId, example, claimTargets),
  );

  const bundle = assemblePredictionBundle(
    workspaceId,
    datasetId,
    options,
    predictions,
    goldExamples,
    capturedAt,
  );

  const envelope: PreReviewBundleEnvelope = {
    version: PRE_REVIEW_BUNDLE_VERSION,
    source: PRE_REVIEW_PREDICTION_SOURCE,
    predictions,
    provenance: {
      datasetId,
      splitGroup: options.splitGroup,
      runLabel: options.runLabel,
      workspaceId,
      capturedAt,
    },
  };

  benchmarkRepo.createPredictionBundle(
    datasetId,
    workspaceId,
    options.runLabel,
    options.splitGroup,
    JSON.stringify(envelope),
    bundle.bundleHash,
    bundle.id,
  );

  return bundle;
}

/**
 * Build a prediction bundle from the exact reviewed runs and persist it BEFORE
 * evaluation. LEGACY `reviewed_outcome` path (version 0): readable for
 * history and calibration, but NEVER eligible to qualify raw model accuracy —
 * reviewer corrections are answers, not predictions. Fails closed on any gold
 * example without a prediction or on any digest inconsistency. New captures
 * MUST use `buildPreReviewPredictionBundle` instead.
 */
export function buildPredictionBundle(
  workspaceId: string,
  datasetId: string,
  options: BuildPredictionBundleOptions,
): BenchmarkPredictionBundle {
  const { goldExamples } = loadFrozenSplitGoldExamples(workspaceId, datasetId, options.splitGroup);

  const claimTargets = options.claimTargets ?? [];
  const predictions: BenchmarkPredictionEntry[] = goldExamples.map(example =>
    captureReviewedExamplePrediction(workspaceId, example, claimTargets),
  );

  const bundle = assemblePredictionBundle(
    workspaceId,
    datasetId,
    options,
    predictions,
    goldExamples,
    new Date().toISOString(),
  );

  benchmarkRepo.createPredictionBundle(
    datasetId,
    workspaceId,
    options.runLabel,
    options.splitGroup,
    JSON.stringify(predictions),
    bundle.bundleHash,
    bundle.id,
  );

  return bundle;
}

export interface LoadedPredictionBundle {
  bundleId: string;
  predictions: BenchmarkPredictionEntry[];
  bundleHash: string;
  /** Explicit source contract: legacy rows load as `reviewed_outcome`. */
  source: PredictionSourceKind;
  /** Explicit version contract: legacy rows load as version 0. */
  bundleVersion: typeof PRE_REVIEW_BUNDLE_VERSION | typeof LEGACY_BUNDLE_VERSION;
}

/**
 * Load a persisted bundle and re-verify its digest. Returns the explicit
 * source/version contract additively: legacy rows (a JSON array) load as
 * `reviewed_outcome`/0 with unchanged hash semantics; pre-review envelopes
 * load as `prereview_raw`/1, hashed over `envelope.predictions`. Unknown
 * envelopes throw. Existing `{ bundleId, predictions, bundleHash }`
 * destructuring keeps working.
 */
export function loadPredictionBundle(
  workspaceId: string,
  datasetId: string,
  bundleId: string | undefined,
  splitGroup: 'test' | 'holdout',
): LoadedPredictionBundle {
  const row = bundleId
    ? benchmarkRepo.getPredictionBundle(bundleId)
    : benchmarkRepo.getLatestPredictionBundle(datasetId, splitGroup);
  if (!row) {
    throw new Error('No prediction bundle found; build one before evaluating.');
  }
  if (row.workspace_id !== workspaceId) {
    throw new Error('Prediction bundle belongs to a different workspace.');
  }
  if (row.dataset_id !== datasetId) {
    throw new Error('Prediction bundle belongs to a different dataset.');
  }
  if (row.split_group !== splitGroup) {
    throw new Error(`Prediction bundle split "${row.split_group}" does not match requested "${splitGroup}".`);
  }
  const parsed: unknown = JSON.parse(row.predictions_json);
  const described = describeStoredBundleSource(parsed);
  const predictions: BenchmarkPredictionEntry[] = isPreReviewBundleEnvelope(parsed)
    ? parsed.predictions
    : (parsed as BenchmarkPredictionEntry[]);
  // Re-verify the persisted digest against the exact predictions.
  if (computePredictionBundleHash(predictions) !== row.bundle_hash) {
    throw new Error('Persisted prediction bundle digest mismatch.');
  }
  return {
    bundleId: row.id,
    predictions,
    bundleHash: row.bundle_hash,
    source: described.source,
    bundleVersion: described.bundleVersion as typeof PRE_REVIEW_BUNDLE_VERSION | typeof LEGACY_BUNDLE_VERSION,
  };
}

/**
 * Source eligibility for raw-accuracy qualification. Only `prereview_raw`
 * (version 1) bundles may qualify raw model accuracy; legacy
 * `reviewed_outcome` bundles stay readable but are explicitly labeled
 * ineligible because they contain reviewer answers, not predictions.
 */
export function assessBasicPredictionSourceEligibility(source: PredictionSourceKind): { eligible: boolean; reason: string } {
  if (source === PRE_REVIEW_PREDICTION_SOURCE) {
    return { eligible: true, reason: 'prereview_raw_v1_eligible' };
  }
  return { eligible: false, reason: 'reviewed_outcome_ineligible_for_raw_accuracy' };
}

// ─── Offline Qualification Predictions From Code (Issue #293 blocker fix) ────
//
// The qualification runner must evidence the shipped classification code, not
// replay per-entry authored answers. Frozen gold fixtures therefore carry ONLY
// adjudicated gold labels + evidence snippets (no `baseline`/`candidate`
// predictions). This section builds both prediction sides deterministically
// from that gold + evidence by executing the actual shipped decision logic:
//
// - Baseline: the deterministic matcher precedence the pipeline applies
//   before any model dispatch — `matchKeywordOptions` (product types, pages)
//   gated by the shipped `PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE` floor, and
//   `matchAttributeOptions` (attributes) with word-boundary grounding. No
//   model probabilities, no recovery.
// - Candidate: the TypeSafe Jev decision path — shipped question builders
//   (`buildProductTypeChoiceQuestion`, `buildAttributeChoiceQuestion` /
//   `buildAttributeNoulQuestions`, `buildPageChoiceQuestion`), shipped
//   probability floors (`JEV_PRODUCT_TYPE_MIN_PROBABILITY`,
//   `JEV_ATTRIBUTE_MIN_PROBABILITY`, `JEV_MULTI_VALUE_MIN_PROBABILITY`,
//   `JEV_PAGE_SINGLE_THRESHOLD`), and the shipped multi-value selection
//   policy (`evaluateMultiValueSelectionPolicy`).
//
// Offline determinism note: without live credentials there is no Jev model to
// answer the built questions, so per-option probabilities come from a generic
// evidence-overlap simulator (`simulateOfflineOptionSupport`) applied
// UNIFORMLY to every entry — never per-entry authored answers. It is an
// explicitly documented lower-bound stand-in for semantic judgment (it cannot
// use synonyms the evidence does not contain); live model compatibility is
// proven separately by the bounded opt-in live-contract check, and production
// quality by staged canaries. What this path DOES evidence: question
// construction, threshold/abstention policy, cardinality handling, and the
// deterministic precedence shared with production.

import {
  matchKeywordOptions,
  matchAttributeOptions,
  tokenize as tokenizeEvidenceText,
} from './curation-target-matcher';
import {
  buildProductTypeChoiceQuestion,
  JEV_PRODUCT_TYPE_MIN_PROBABILITY,
  PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE,
} from './product-type-decision';
import {
  buildAttributeChoiceQuestion,
  buildAttributeNoulQuestions,
  evaluateMultiValueSelectionPolicy,
  JEV_ATTRIBUTE_MIN_PROBABILITY,
} from './attribute-decision';
import {
  buildPageChoiceQuestion,
  JEV_PAGE_SINGLE_THRESHOLD,
} from './page-decision';
import type { ResolvedTarget } from './curation-target-resolver';
import type { ProductAttributeConfig } from '../shared/schemas/classification';

/** Version of the offline code-executed qualification predictor. */
export const QUALIFICATION_PREDICTOR_VERSION = 'code-executed-v1' as const;

/** Gold-only entry: adjudicated labels + evidence. Never carries predictions. */
export interface QualificationGoldOnlyEntry extends QualificationGoldCore {}

/** Executed prediction for one side (baseline or candidate) of one entry. */
export interface ExecutedQualificationPrediction {
  productType: string | null;
  abstained: boolean;
  fieldAssignments: Array<{ targetId: string; value?: string; values?: string[] }>;
  pageIds: string[];
  confidence: number;
  latencyMs: number;
}

/** Closed-world candidate sets derived globally from adjudicated gold labels. */
export interface QualificationTaxonomies {
  productTypes: Array<{ id: string; label: string }>;
  attributeTargets: Array<{ targetId: string; cardinality: 'single' | 'multiple'; options: string[] }>;
  pages: Array<{ pageId: string; pageName: string }>;
}

/** Immutable artifact binding executed predictions to their inputs. */
export interface QualificationPredictionArtifact {
  predictorVersion: typeof QUALIFICATION_PREDICTOR_VERSION;
  artifactHash: string;
  predictedAt: string;
  entryCount: number;
  predictions: Array<{
    sku: string;
    baseline: ExecutedQualificationPrediction;
    candidate: ExecutedQualificationPrediction;
  }>;
}

/**
 * Parse a gold-only qualification fixture. Legacy `baseline`/`candidate`
 * keys (pre-authored predictions) are IGNORED when present — they stay
 * readable as bytes but never become predictions — so old artifacts remain
 * loadable while reports cannot silently replay them.
 */
export function parseQualificationGoldOnly(value: unknown): QualificationGoldOnlyEntry[] {
  const root = value as { entries?: unknown };
  if (!root || !Array.isArray(root.entries)) {
    throw new Error('Qualification gold fixture has no entries array.');
  }
  return root.entries.map((raw: unknown) => {
    const e = raw as Record<string, unknown> & {
      sku: string;
      familyId: string;
      split: 'dev' | 'holdout';
      assortment: string;
      gold: QualificationGoldOnlyEntry['gold'];
      evidence: QualificationGoldOnlyEntry['evidence'];
    };
    if (typeof e.sku !== 'string' || !e.gold || !Array.isArray(e.evidence)) {
      throw new Error('Qualification gold entry is missing sku/gold/evidence.');
    }
    return {
      sku: e.sku,
      familyId: e.familyId,
      split: e.split,
      assortment: e.assortment,
      gold: e.gold,
      evidence: e.evidence,
    };
  });
}

/** Humanize a slug id for closed-world candidate labels (global, not per-entry). */
function humanizeSlug(id: string): string {
  return id
    .split('_')
    .map(w => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

interface RawTaxonomyCollections {
  typeIds: Set<string>;
  attrValues: Map<string, Set<string>>;
  attrUsesValuesArray: Set<string>;
  pages: Map<string, string>;
}

function emptyTaxonomyCollections(): RawTaxonomyCollections {
  return { typeIds: new Set(), attrValues: new Map(), attrUsesValuesArray: new Set(), pages: new Map() };
}

/** Collect one entry's product-type id into the taxonomy sets. */
function collectEntryTypeId(collections: RawTaxonomyCollections, entry: QualificationGoldOnlyEntry): void {
  if (entry.gold.productType.typeId) collections.typeIds.add(entry.gold.productType.typeId);
}

/** Collect one entry's field values into the taxonomy sets. */
function collectEntryFieldValues(collections: RawTaxonomyCollections, entry: QualificationGoldOnlyEntry): void {
  for (const field of entry.gold.fieldAssignments ?? []) {
    if (!collections.attrValues.has(field.targetId)) {
      collections.attrValues.set(field.targetId, new Set<string>());
    }
    const set = collections.attrValues.get(field.targetId)!;
    if (Array.isArray(field.values)) {
      collections.attrUsesValuesArray.add(field.targetId);
      for (const value of field.values) set.add(value);
    } else if (typeof field.value === 'string') {
      set.add(field.value);
    }
  }
}

/** Collect one entry's category pages into the taxonomy sets. */
function collectEntryPages(collections: RawTaxonomyCollections, entry: QualificationGoldOnlyEntry): void {
  for (const page of entry.gold.categoryPages?.pageAssignments ?? []) {
    if (!collections.pages.has(page.pageId)) collections.pages.set(page.pageId, page.pageName);
  }
  for (const pageId of entry.gold.categoryPages?.pageIds ?? []) {
    if (!collections.pages.has(pageId)) collections.pages.set(pageId, humanizeSlug(pageId.replace(/^page-/, '')));
  }
}

/** Assemble sorted closed-world candidate sets from the raw collections. */
function assembleQualificationTaxonomies(collections: RawTaxonomyCollections): QualificationTaxonomies {
  return {
    productTypes: [...collections.typeIds].sort().map(id => ({ id, label: humanizeSlug(id) })),
    attributeTargets: [...collections.attrValues.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([targetId, set]) => ({
        targetId,
        cardinality: (collections.attrUsesValuesArray.has(targetId) ? 'multiple' : 'single') as 'single' | 'multiple',
        options: [...set].sort(),
      })),
    pages: [...collections.pages.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pageId, pageName]) => ({ pageId, pageName })),
  };
}

/**
 * Derive closed-world candidate sets from the union of adjudicated gold
 * labels. Global (same options for every entry) so per-entry selection must
 * still be performed by the decision logic; sorted for determinism.
 */
function deriveQualificationTaxonomies(entries: QualificationGoldOnlyEntry[]): QualificationTaxonomies {
  const collections = emptyTaxonomyCollections();
  for (const entry of entries) {
    collectEntryTypeId(collections, entry);
    collectEntryFieldValues(collections, entry);
    collectEntryPages(collections, entry);
  }
  return assembleQualificationTaxonomies(collections);
}

/** Evidence text for one entry (joined snippets, exactly what scoring sees). */
function qualificationEvidenceText(entry: QualificationGoldOnlyEntry): string {
  return entry.evidence.map(ev => ev.snippet ?? '').join(' ').trim();
}

/** Plural-tolerant token normalization for the OFFLINE simulator only. */
function singularizeToken(t: string): string {
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('es') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && t.length > 3) return t.slice(0, -1);
  return t;
}

/**
 * Generic offline support simulator: token overlap between an option label
 * and the entry evidence, normalized plural-tolerantly. Applied uniformly —
 * the same function scores every option of every entry. Returns a
 * Choice-style top probability in [0.45, 0.95] and a Noul-style P(yes) in
 * [0.05, 0.95]; both derive from the SAME overlap score so single and
 * multi-value judgments stay consistent.
 */
function simulateOfflineOptionSupport(
  optionLabel: string,
  evidenceTokens: Set<string>,
): { score: number; choiceProb: number; noulProb: number } {
  const labelTokens = tokenizeEvidenceText(optionLabel);
  if (labelTokens.length === 0 || evidenceTokens.size === 0) {
    return { score: 0, choiceProb: 0.45, noulProb: 0.05 };
  }
  const normalizedEvidence = new Set([...evidenceTokens].map(singularizeToken));
  let hits = 0;
  for (const t of labelTokens) {
    if (normalizedEvidence.has(t) || normalizedEvidence.has(singularizeToken(t))) hits++;
  }
  const score = hits / labelTokens.length;
  return { score, choiceProb: 0.45 + 0.5 * score, noulProb: 0.05 + 0.9 * score };
}

function stubAttributeConfig(targetId: string, options: string[]): ProductAttributeConfig {
  return {
    id: targetId,
    name: targetId,
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: options,
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: null,
  };
}

function stubResolvedTarget(
  id: string,
  label: string,
  kind: 'product_type' | 'product_field' | 'page',
  selectionMode: 'single' | 'multiple',
  attributeId: string | null,
  options: Array<{ value: string; label: string }>,
  attribute?: ProductAttributeConfig,
): ResolvedTarget {
  return {
    config: {
      id,
      kind,
      label,
      enabled: true,
      mandatory: false,
      selectionMode,
      attributeId,
      catalogField: null,
      optionSource: 'configured',
      required: false,
      sortOrder: 0,
    },
    options,
    ...(attribute ? { attribute } : {}),
  };
}

/** True when prediction is impossible: no options or no usable evidence. */
function isQualificationPredictionEmpty(optionCount: number, evidenceText: string): boolean {
  return optionCount === 0 || evidenceText.length < 3;
}

/**
 * Best offline-simulator Choice option (first-wins ties, deterministic input
 * order). Shared by every candidate Choice selection in this module.
 */
function selectBestSimulatorLabel(
  options: Array<{ value: string; label: string }>,
  evidenceTokens: Set<string>,
): { bestValue: string | null; bestProb: number } {
  const { best, bestProb } = selectBestByProbability(
    options,
    option => simulateOfflineOptionSupport(option.label, evidenceTokens).choiceProb,
  );
  return { bestValue: best ? best.value : null, bestProb };
}

/** True when the gold fixture adjudicates this field target for the entry. */
function goldHasFieldTarget(
  entry: QualificationGoldOnlyEntry,
  targetId: string,
): boolean {
  return (entry.gold.fieldAssignments ?? []).some(field => field.targetId === targetId);
}

/** Stub attribute config + resolved target for one closed-world target. */
function stubAttributeTarget(
  target: QualificationTaxonomies['attributeTargets'][number],
): { attribute: ProductAttributeConfig; resolved: ResolvedTarget } {
  const attribute = stubAttributeConfig(target.targetId, target.options);
  const resolved = stubResolvedTarget(
    `target_${target.targetId}`,
    target.targetId,
    'product_field',
    target.cardinality,
    target.targetId,
    target.options.map(v => ({ value: v, label: v })),
    attribute,
  );
  return { attribute, resolved };
}

/** Baseline product type: shipped deterministic keyword precedence + floor. */
function predictBaselineProductType(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): { productType: string | null; abstained: boolean; confidence: number } {
  if (isQualificationPredictionEmpty(taxonomies.productTypes.length, evidenceText)) {
    return { productType: null, abstained: true, confidence: 0 };
  }
  const matches = matchKeywordOptions({
    options: taxonomies.productTypes.map(t => ({ value: t.id, label: t.label })),
    text: evidenceText,
    selectionMode: 'single',
  });
  const top = matches[0];
  if (!top || top.confidence < PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE) {
    return { productType: null, abstained: true, confidence: 0 };
  }
  return { productType: top.value, abstained: false, confidence: top.confidence };
}

/**
 * Candidate product type: builds the shipped Jev Choice question (exercising
 * criteria/key construction), then selects via the offline simulator under
 * the shipped `JEV_PRODUCT_TYPE_MIN_PROBABILITY` floor. Empty evidence maps
 * to insufficient-evidence abstention; zero support maps to no-match
 * abstention — mirroring the shipped abstention routing without claiming a
 * live judgment occurred.
 */
function predictCandidateProductType(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): { productType: string | null; abstained: boolean; confidence: number } {
  if (isQualificationPredictionEmpty(taxonomies.productTypes.length, evidenceText)) {
    return { productType: null, abstained: true, confidence: 0 };
  }
  // Execute the shipped question builder: criteria/key wiring must match production.
  const plan = buildProductTypeChoiceQuestion(
    taxonomies.productTypes.map(t => ({ value: t.id, label: t.label })),
  );
  const evidenceTokens = new Set(tokenizeEvidenceText(evidenceText));
  const options = [...plan.keyToIdMap].map(([, canonicalId]) => ({
    value: canonicalId,
    label: taxonomies.productTypes.find(t => t.id === canonicalId)?.label ?? canonicalId,
  }));
  const { bestValue: bestId, bestProb } = selectBestSimulatorLabel(options, evidenceTokens);
  const bestLabel = taxonomies.productTypes.find(t => t.id === bestId)?.label ?? '';
  const { score } = simulateOfflineOptionSupport(bestLabel, evidenceTokens);
  if (!bestId || score <= 0 || bestProb < JEV_PRODUCT_TYPE_MIN_PROBABILITY) {
    return { productType: null, abstained: true, confidence: 0 };
  }
  return { productType: bestId, abstained: false, confidence: bestProb };
}

/** Baseline attributes: shipped word-boundary alias/direct matching only. */
function predictBaselineAttributes(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): Array<{ targetId: string; value?: string; values?: string[] }> {
  const out: Array<{ targetId: string; value?: string; values?: string[] }> = [];
  for (const target of taxonomies.attributeTargets) {
    if (!goldHasFieldTarget(entry, target.targetId)) continue;
    const { attribute } = stubAttributeTarget(target);
    const found = matchAttributeOptions(attribute, evidenceText, target.options, target.cardinality);
    if (found.length === 0) continue;
    if (target.cardinality === 'multiple') {
      out.push({ targetId: target.targetId, values: found.map(f => f.value) });
    } else {
      out.push({ targetId: target.targetId, value: found[0].value });
    }
  }
  return out.sort((a, b) => a.targetId.localeCompare(b.targetId));
}

/**
 * Candidate multi-value attributes: shipped Noul questions + the shipped
 * `evaluateMultiValueSelectionPolicy` (null when the policy does not resolve).
 */
function predictCandidateMultiAttributeValues(
  resolved: ResolvedTarget,
  entry: QualificationGoldOnlyEntry,
  evidenceTokens: Set<string>,
): string[] | null {
  // Execute the shipped Noul question builder (questionId wiring parity).
  const plans = buildAttributeNoulQuestions(resolved, entry.sku, {});
  const candidates = plans.map(p => ({
    optionValue: p.optionValue,
    optionLabel: p.optionLabel,
    optionIndex: p.optionIndex,
    prob: simulateOfflineOptionSupport(p.optionLabel, evidenceTokens).noulProb,
  }));
  const outcome = evaluateMultiValueSelectionPolicy({
    target: resolved,
    candidates,
    permittedEvidence: [],
    catalogField: null,
  });
  return outcome.outcome === 'resolved' ? outcome.selectedValues : null;
}

/**
 * Candidate single-value attribute: shipped Choice question + simulation
 * under `JEV_ATTRIBUTE_MIN_PROBABILITY` (null when unsupported).
 */
function predictCandidateSingleAttributeValue(
  resolved: ResolvedTarget,
  evidenceTokens: Set<string>,
): string | null {
  // Execute the shipped Choice question builder for criteria parity.
  const plan = buildAttributeChoiceQuestion(resolved);
  const options = [...plan.keyToIdMap].map(([, canonicalValue]) => ({
    value: canonicalValue,
    label: canonicalValue,
  }));
  const { bestValue, bestProb } = selectBestSimulatorLabel(options, evidenceTokens);
  const { score } = simulateOfflineOptionSupport(bestValue ?? '', evidenceTokens);
  return bestValue && score > 0 && bestProb >= JEV_ATTRIBUTE_MIN_PROBABILITY ? bestValue : null;
}

/**
 * Candidate attributes: shipped Jev question builders + shipped floors and,
 * for multi-value targets, the shipped `evaluateMultiValueSelectionPolicy`.
 * Single-value targets use Choice simulation under
 * `JEV_ATTRIBUTE_MIN_PROBABILITY`; multi-value targets use per-option Noul
 * simulation under the policy's own `JEV_MULTI_VALUE_MIN_PROBABILITY` gate.
 */
function predictCandidateAttributes(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): Array<{ targetId: string; value?: string; values?: string[] }> {
  const out: Array<{ targetId: string; value?: string; values?: string[] }> = [];
  const evidenceTokens = new Set(tokenizeEvidenceText(evidenceText));
  for (const target of taxonomies.attributeTargets) {
    if (!goldHasFieldTarget(entry, target.targetId)) continue;
    const { resolved } = stubAttributeTarget(target);
    if (target.cardinality === 'multiple') {
      const values = predictCandidateMultiAttributeValues(resolved, entry, evidenceTokens);
      if (values) out.push({ targetId: target.targetId, values });
    } else {
      const value = predictCandidateSingleAttributeValue(resolved, evidenceTokens);
      if (value) out.push({ targetId: target.targetId, value });
    }
  }
  return out.sort((a, b) => a.targetId.localeCompare(b.targetId));
}

/** Baseline pages: shipped deterministic keyword matching + floor. */
function predictBaselinePages(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): string[] {
  if (isQualificationPredictionEmpty(taxonomies.pages.length, evidenceText)) return [];
  const matches = matchKeywordOptions({
    options: taxonomies.pages.map(p => ({ value: p.pageId, label: p.pageName })),
    text: evidenceText,
    selectionMode: 'single',
  });
  const top = matches[0];
  if (!top || top.confidence < PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE) return [];
  return [top.value];
}

/**
 * Candidate pages: shipped `buildPageChoiceQuestion` for criteria/key parity,
 * then offline-simulator selection under `JEV_PAGE_SINGLE_THRESHOLD`.
 */
function predictCandidatePages(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): string[] {
  if (isQualificationPredictionEmpty(taxonomies.pages.length, evidenceText)) return [];
  const plan = buildPageChoiceQuestion(
    taxonomies.pages.map(p => ({ pageId: p.pageId, pageName: p.pageName, parentId: null, parentName: null, path: p.pageName })),
    null,
  );
  const evidenceTokens = new Set(tokenizeEvidenceText(evidenceText));
  const options = [...plan.keyToIdMap]
    .map(([, pageId]) => {
      const page = taxonomies.pages.find(p => p.pageId === pageId);
      return { value: pageId, label: page?.pageName ?? pageId };
    })
    .filter(option => simulateOfflineOptionSupport(option.label, evidenceTokens).score > 0);
  const { bestValue: bestId, bestProb } = selectBestSimulatorLabel(options, evidenceTokens);
  if (!bestId || bestProb < JEV_PAGE_SINGLE_THRESHOLD) return [];
  return [bestId];
}

/** Confidence for the artifact (abstained sides carry zero confidence). */
function artifactConfidence(abstained: boolean, confidence: number): number {
  return abstained ? 0 : Number(confidence.toFixed(4));
}

/** Execute baseline + candidate paths for one gold entry (latencies measured). */
function executeEntryPredictions(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
): { sku: string; baseline: ExecutedQualificationPrediction; candidate: ExecutedQualificationPrediction } {
  const evidenceText = qualificationEvidenceText(entry);
  const startedBaseline = Date.now();
  const bType = predictBaselineProductType(entry, taxa, evidenceText);
  const bFields = predictBaselineAttributes(entry, taxa, evidenceText);
  const bPages = predictBaselinePages(entry, taxa, evidenceText);
  const baselineLatency = Math.max(0, Date.now() - startedBaseline);
  const startedCandidate = Date.now();
  const cType = predictCandidateProductType(entry, taxa, evidenceText);
  const cFields = predictCandidateAttributes(entry, taxa, evidenceText);
  const cPages = predictCandidatePages(entry, taxa, evidenceText);
  const candidateLatency = Math.max(0, Date.now() - startedCandidate);
  return {
    sku: entry.sku,
    baseline: {
      productType: bType.productType,
      abstained: bType.abstained,
      fieldAssignments: bFields,
      pageIds: bPages,
      confidence: artifactConfidence(bType.abstained, bType.confidence),
      latencyMs: baselineLatency,
    },
    candidate: {
      productType: cType.productType,
      abstained: cType.abstained,
      fieldAssignments: cFields,
      pageIds: cPages,
      confidence: artifactConfidence(cType.abstained, cType.confidence),
      latencyMs: candidateLatency,
    },
  };
}

/**
 * Hash semantic predictions only: per-entry wall-clock latency is real
 * telemetry recorded on the artifact, but it must not affect identity —
 * the same gold entries always yield the same artifact hash.
 */
function hashQualificationPredictions(
  predictions: Array<{
    sku: string;
    baseline: ExecutedQualificationPrediction;
    candidate: ExecutedQualificationPrediction;
  }>,
): string {
  const sorted = [...predictions].sort((a, b) => a.sku.localeCompare(b.sku));
  const hashable = sorted.map(p => ({
    sku: p.sku,
    baseline: {
      productType: p.baseline.productType,
      abstained: p.baseline.abstained,
      fieldAssignments: p.baseline.fieldAssignments,
      pageIds: p.baseline.pageIds,
      confidence: p.baseline.confidence,
    },
    candidate: {
      productType: p.candidate.productType,
      abstained: p.candidate.abstained,
      fieldAssignments: p.candidate.fieldAssignments,
      pageIds: p.candidate.pageIds,
      confidence: p.candidate.confidence,
    },
  }));
  return sha256Hex(JSON.stringify(hashable));
}

/**
 * Execute the current baseline and candidate classification paths over gold
 * evidence to produce an immutable prediction artifact. Deterministic: the
 * same gold entries always yield the same artifact hash. Fail-closed: every
 * entry must produce both predictions (abstention is a valid prediction;
 * throwing is not).
 */
export function buildQualificationPredictionsFromCode(
  entries: QualificationGoldOnlyEntry[],
  taxonomies?: QualificationTaxonomies,
): QualificationPredictionArtifact {
  const taxa = taxonomies ?? deriveQualificationTaxonomies(entries);
  const predictedAt = new Date().toISOString();
  const predictions = entries.map(entry => executeEntryPredictions(entry, taxa));
  if (predictions.length !== entries.length) {
    throw new Error('Qualification prediction artifact incomplete: missing entries.');
  }
  return {
    predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
    artifactHash: hashQualificationPredictions(predictions),
    predictedAt,
    entryCount: entries.length,
    predictions,
  };
}



