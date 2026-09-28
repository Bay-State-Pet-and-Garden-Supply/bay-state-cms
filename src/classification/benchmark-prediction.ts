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

// ─── Honest Captured Qualification Predictions (Issue #293 blocker fix) ────
//
// The qualification runner must evidence the shipped classification code, not
// replay per-entry authored answers. Frozen gold fixtures therefore carry ONLY
// adjudicated gold labels + evidence snippets (no `baseline`/`candidate`
// predictions). This section captures both prediction sides by executing the
// actual shipped decision logic against that frozen gold evidence:
//
// - Baseline (incumbent path): the deterministic matcher precedence the
//   pipeline applies before any model dispatch — `matchKeywordOptions`
//   (product types, pages) gated by the shipped
//   `PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE` floor, and
//   `matchAttributeOptions` (attributes) with word-boundary grounding. When the
//   deterministic matcher abstains and a baseline chat route was explicitly
//   opted in, the legacy chat-LLM ranker (`llmRankOptions` — the exact
//   function production's non-SystemOne fallback invokes) is attempted with
//   credentials resolved from the existing provider store.
// - Candidate (Jev decision path): shipped question builders
//   (`buildProductTypeChoiceQuestion`, `buildAttributeChoiceQuestion` /
//   `buildAttributeNoulQuestions`, `buildPageChoiceQuestion`), the shipped
//   transport (`executeSystemOne`), shipped answer extraction
//   (`requireChoiceAnswer` / `requireNoulAnswer`), shipped canonical mapping
//   (`choiceKeyToCanonicalId`, `mapRankedLabelToOptionExactlyOne`), shipped
//   probability floors (`JEV_PRODUCT_TYPE_MIN_PROBABILITY`,
//   `JEV_ATTRIBUTE_MIN_PROBABILITY`, `JEV_MULTI_VALUE_MIN_PROBABILITY`,
//   `JEV_PAGE_SINGLE_THRESHOLD`), and the shipped multi-value selection
//   policy (`evaluateMultiValueSelectionPolicy`).
//
// Honesty contract (fail-closed):
// - Model judgments require explicit live credentials (`TYPESAFE_API_KEY` for
//   Jev, passed explicitly by the caller — never read implicitly here; the
//   existing provider credential store for the chat baseline). Captured model
//   judgments record requested/resolved model identity and token usage on the
//   immutable artifact (`source: 'live_captured'`).
// - WITHOUT credentials the affected side is recorded as `source: 'blocked'`
//   with a coded reason (`blockedCode`) — never simulated, never mocked into
//   a passing number. Blocked sides also carry their blocked code as
//   `failureCode`, so the existing evaluator's zero-service-failures gate
//   treats unevidenced predictions as failures (fail-closed); the precise
//   reason stays in `blockedCode`/`blockedDetail`.
// - Deterministic-only execution (`buildQualificationPredictionsFromCode`,
//   CI-safe, no network) remains available: the baseline side is the real
//   deterministic matcher labeled `source: 'deterministic_floor'` — a
//   lower-bound floor, never candidate quality evidence — and the candidate
//   side is `blocked` (`jev_credentials_absent`). The deterministic report
//   therefore cannot qualify candidate quality; it fails closed by construction.

import {
  matchKeywordOptions,
  matchAttributeOptions,
} from './curation-target-matcher';
import {
  buildProductTypeChoiceQuestion,
  JEV_PRODUCT_TYPE_MIN_PROBABILITY,
  PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE,
  type ProductTypeChoiceQuestionPlan,
} from './product-type-decision';
import {
  buildAttributeChoiceQuestion,
  buildAttributeNoulQuestions,
  evaluateMultiValueSelectionPolicy,
  JEV_ATTRIBUTE_MIN_PROBABILITY,
  type AttributeChoiceQuestionPlan,
  type AttributeNoulQuestionPlan,
} from './attribute-decision';
import {
  buildPageChoiceQuestion,
  JEV_PAGE_SINGLE_THRESHOLD,
  NO_MATCH_CHOICE_KEY as PAGE_NO_MATCH_CHOICE_KEY,
  INSUFFICIENT_EVIDENCE_CHOICE_KEY as PAGE_INSUFFICIENT_EVIDENCE_CHOICE_KEY,
  type PageChoiceQuestionPlan,
} from './page-decision';
import type { ResolvedTarget } from './curation-target-resolver';
import type {
  ProductAttributeConfig,
  ModelPolicyConfigV2,
  FrozenTaxonomySnapshot,
} from '../shared/schemas/classification';
import { executeSystemOne, TYPESAFE_EVALUATED_MODEL } from '../ai/systemone-transport';
import type { SystemOneAnswer } from '../shared/schemas/systemone';
import type { ProviderConnection } from '../ai/provider-connections';
import {
  requireChoiceAnswer,
  requireNoulAnswer,
  choiceKeyToCanonicalId,
} from './systemone-decision-core';
import { llmRankOptions, type LlmRankResult } from './curation-target-ranker';
import { mapRankedLabelToOptionExactlyOne } from './cohort-product-type-resolver';
import {
  buildModelPolicyView,
  redactTransportText,
  ModelPolicyDeniedError,
  type ModelPolicyView,
  type ProtectedOperation,
} from './model-policy-gateway';
import { getLlmConfigForTask, type LlmConfig } from '../onboarding/llm-client';
import type { LlmTask } from '../db/repositories/llm-task-config-repo';

/** Version of the honest-capture qualification predictor (v2: no simulator). */
export const QUALIFICATION_PREDICTOR_VERSION = 'code-executed-v2' as const;

/**
 * Explicit prediction-source contract for qualification captures.
 * - `live_captured`: the live path executed against frozen gold evidence and
 *   its outcome was recorded (requested route always recorded; resolved
 *   model + usage recorded when a model judgment spoke — null when the
 *   incumbent path abstained without a judgment).
 * - `deterministic_floor`: the real deterministic matcher ran with no model
 *   consulted — a lower-bound floor, never candidate quality evidence.
 * - `blocked`: no judgment was captured (coded reason in `blockedCode`) —
 *   never scored as quality evidence; also surfaced as `failureCode` so the
 *   evaluator's zero-service-failures gate fails closed.
 */
export const QUALIFICATION_SOURCE_LIVE_CAPTURED = 'live_captured' as const;
export const QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR = 'deterministic_floor' as const;
export const QUALIFICATION_SOURCE_BLOCKED = 'blocked' as const;
export type QualificationPredictionSource =
  | typeof QUALIFICATION_SOURCE_LIVE_CAPTURED
  | typeof QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR
  | typeof QUALIFICATION_SOURCE_BLOCKED;

/** Coded blocked reasons (never free-form prose in `blockedCode`). */
export const QUALIFICATION_BLOCKED_JEV_CREDENTIALS_ABSENT = 'jev_credentials_absent' as const;
export const QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT = 'baseline_model_credentials_absent' as const;
export const QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED = 'live_dispatch_failed' as const;
export const QUALIFICATION_BLOCKED_QUESTION_CONSTRUCTION_FAILED = 'question_construction_failed' as const;

/** Gold-only entry: adjudicated labels + evidence. Never carries predictions. */
export interface QualificationGoldOnlyEntry extends QualificationGoldCore {}

/**
 * Executed prediction for one side (baseline or candidate) of one entry.
 *
 * Additive prediction-source marking (all new fields optional): `source`
 * distinguishes `live_captured` (real model judgment, identity + usage
 * recorded) from `deterministic_floor` (real deterministic matcher, no model
 * consulted) and `blocked` (coded reason in `blockedCode`, never quality
 * evidence). `failureCode` carries the blocked code for blocked sides so the
 * existing evaluator's zero-service-failures gate fails closed.
 */
export interface ExecutedQualificationPrediction {
  productType: string | null;
  abstained: boolean;
  fieldAssignments: Array<{ targetId: string; value?: string; values?: string[] }>;
  pageIds: string[];
  confidence: number;
  latencyMs: number;
  source?: QualificationPredictionSource;
  blockedCode?: string | null;
  blockedDetail?: string | null;
  failureCode?: string | null;
  requestedModel?: string | null;
  resolvedModel?: string | null;
  provider?: string | null;
  usage?: { inputTokens: number | null; outputTokens: number | null } | null;
}

/** Closed-world candidate sets derived globally from adjudicated gold labels. */
export interface QualificationTaxonomies {
  productTypes: Array<{ id: string; label: string }>;
  attributeTargets: Array<{ targetId: string; cardinality: 'single' | 'multiple'; options: string[] }>;
  pages: Array<{ pageId: string; pageName: string }>;
}

/**
 * Capture mode for the whole artifact (additive): `deterministic_floor` when
 * no live model was attempted for either side (CI-safe sync build), else
 * `live_captured` when a live attempt was made (per-side `source` fields
 * carry the per-entry outcome — a live attempt may still record `blocked`
 * sides when credentials or dispatch fail).
 */
export type QualificationCaptureMode = 'deterministic_floor' | 'live_captured';

/**
 * Where an artifact's candidate option sets came from (additive):
 * `frozen_snapshot` (production taxonomy — the required contract) or
 * `gold_union` (legacy fallback deriving the closed world from adjudicated
 * gold labels; weaker separation, labeled as such).
 */
export type QualificationTaxonomySource = 'frozen_snapshot' | 'gold_union';

/** Immutable artifact binding executed predictions to their inputs. */
export interface QualificationPredictionArtifact {
  predictorVersion: typeof QUALIFICATION_PREDICTOR_VERSION;
  artifactHash: string;
  predictedAt: string;
  entryCount: number;
  captureMode: QualificationCaptureMode;
  taxonomySource: QualificationTaxonomySource;
  frozenTaxonomyHash: string | null;
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
 * still be performed by the decision logic; sorted for determinism. LEGACY
 * fallback only — prefer the frozen production taxonomy snapshot (gold
 * labels are answers and must never define the candidate pool).
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

/**
 * Candidate option sets straight from the frozen production taxonomy
 * snapshot (the required contract: gold labels are validated WITHIN these
 * sets but never define them). Sorted copies so artifact construction stays
 * deterministic regardless of snapshot order.
 */
export function qualificationTaxonomiesFromFrozenSnapshot(
  snapshot: FrozenTaxonomySnapshot,
): QualificationTaxonomies {
  return {
    productTypes: [...snapshot.productTypes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(t => ({ id: t.id, label: t.label })),
    attributeTargets: [...snapshot.attributeTargets]
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map(t => ({ targetId: t.targetId, cardinality: t.cardinality, options: [...t.options].sort() })),
    pages: [...snapshot.pages]
      .sort((a, b) => a.pageId.localeCompare(b.pageId))
      .map(p => ({ pageId: p.pageId, pageName: p.pageName })),
  };
}

/** Structural check for the frozen-taxonomy snapshot shape (legacy taxonomy inputs lack `snapshotHash`). */
function isFrozenTaxonomySnapshot(value: unknown): value is FrozenTaxonomySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.snapshotHash === 'string'
    && Array.isArray(v.productTypes)
    && Array.isArray(v.attributeTargets)
    && Array.isArray(v.pages);
}

/** Structural check for a caller-built legacy taxonomy input. */
function isLegacyQualificationTaxonomies(value: unknown): value is QualificationTaxonomies {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.productTypes) && Array.isArray(v.attributeTargets) && Array.isArray(v.pages);
}

/** Taxonomy input for both capture builders: frozen snapshot, legacy sets, or omitted (gold-union fallback). */
export type QualificationTaxonomyInput = QualificationTaxonomies | FrozenTaxonomySnapshot | null | undefined;

/**
 * Resolve the candidate option sets for a capture. A frozen snapshot wins
 * (recorded on the artifact with its hash); an explicit legacy input is used
 * as-is and labeled `gold_union`; an omitted input falls back to the legacy
 * gold-union derivation. A present-but-malformed input throws fail-closed —
 * silently substituting the gold union would launder the candidate pool.
 */
function resolveQualificationTaxonomies(
  input: QualificationTaxonomyInput,
  entries: QualificationGoldOnlyEntry[],
): { taxonomies: QualificationTaxonomies; taxonomySource: QualificationTaxonomySource; frozenTaxonomyHash: string | null } {
  if (input === null || input === undefined) {
    return { taxonomies: deriveQualificationTaxonomies(entries), taxonomySource: 'gold_union', frozenTaxonomyHash: null };
  }
  if (isFrozenTaxonomySnapshot(input)) {
    return {
      taxonomies: qualificationTaxonomiesFromFrozenSnapshot(input),
      taxonomySource: 'frozen_snapshot',
      frozenTaxonomyHash: input.snapshotHash,
    };
  }
  if (isLegacyQualificationTaxonomies(input)) {
    return { taxonomies: input, taxonomySource: 'gold_union', frozenTaxonomyHash: null };
  }
  throw new Error('Qualification taxonomy input is neither a frozen snapshot nor legacy taxonomies.');
}

/** Evidence text for one entry (joined snippets, exactly what scoring sees). */
function qualificationEvidenceText(entry: QualificationGoldOnlyEntry): string {
  return entry.evidence.map(ev => ev.snippet ?? '').join(' ').trim();
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
 * Shipped Jev Choice abstention literals for product types and single-value
 * attributes (mirrors the module-private routing constants in
 * `product-type-decision` and `attribute-decision`; page literals are
 * imported from `page-decision` because that boundary exports them).
 */
const JEV_NO_MATCH_KEY = 'no_match';
const JEV_INSUFFICIENT_EVIDENCE_KEY = 'insufficient_evidence';

/** Ordinary Choice capacity mirrored from production (255 total − 2 abstention). */
const JEV_MAX_ORDINARY_CHOICE_CANDIDATES = 253;

/** One entry's full shipped-question construction (pure — no model, no network). */
export interface QualificationCandidateAttributePlan {
  targetId: string;
  cardinality: 'single' | 'multiple';
  resolved: ResolvedTarget;
  choicePlan?: AttributeChoiceQuestionPlan;
  noulPlans?: AttributeNoulQuestionPlan[];
}

export interface QualificationCandidateQuestionSet {
  productTypePlan: ProductTypeChoiceQuestionPlan;
  attributePlans: QualificationCandidateAttributePlan[];
  pagePlan: PageChoiceQuestionPlan | null;
}

/**
 * Build every shipped Jev question for one gold entry (pure construction —
 * the same builders production dispatches). Exported so wiring/shape tests
 * can prove criteria/key parity without credentials or network. Throws on
 * malformed taxonomy input; callers map that to a coded `blocked` side
 * (fail-closed), never to a guessed judgment.
 */
export function buildQualificationCandidateQuestionSet(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
): QualificationCandidateQuestionSet {
  const productTypePlan = buildProductTypeChoiceQuestion(
    taxonomies.productTypes.map(t => ({ value: t.id, label: t.label })),
  );
  const attributePlans: QualificationCandidateAttributePlan[] = [];
  for (const target of taxonomies.attributeTargets) {
    if (!goldHasFieldTarget(entry, target.targetId)) continue;
    const { resolved } = stubAttributeTarget(target);
    if (target.cardinality === 'multiple') {
      attributePlans.push({
        targetId: target.targetId,
        cardinality: target.cardinality,
        resolved,
        noulPlans: buildAttributeNoulQuestions(resolved, entry.sku, {}),
      });
    } else {
      attributePlans.push({
        targetId: target.targetId,
        cardinality: target.cardinality,
        resolved,
        choicePlan: buildAttributeChoiceQuestion(resolved),
      });
    }
  }
  const pagePlan = taxonomies.pages.length > 0
    ? buildPageChoiceQuestion(
      taxonomies.pages.map(p => ({ pageId: p.pageId, pageName: p.pageName, parentId: null, parentName: null, path: p.pageName })),
      null,
    )
    : null;
  return { productTypePlan, attributePlans, pagePlan };
}

/** Null model-identity fields for non-model sides (floor / blocked). */
function emptyQualificationModelIdentity(): Pick<
  ExecutedQualificationPrediction,
  'requestedModel' | 'resolvedModel' | 'provider' | 'usage'
> {
  return { requestedModel: null, resolvedModel: null, provider: null, usage: null };
}

/**
 * Blocked side: no judgment captured (coded reason, never a passing number).
 * Carries the blocked code as `failureCode` so the existing evaluator's
 * zero-service-failures gate treats unevidenced predictions as failures.
 */
export function blockedQualificationPrediction(
  code: string,
  detail: string,
): ExecutedQualificationPrediction {
  return {
    productType: null,
    abstained: true,
    fieldAssignments: [],
    pageIds: [],
    confidence: 0,
    latencyMs: 0,
    source: QUALIFICATION_SOURCE_BLOCKED,
    blockedCode: code,
    blockedDetail: detail,
    failureCode: code,
    ...emptyQualificationModelIdentity(),
  };
}

/** Deterministic-floor side: the real matcher ran, no model was consulted. */
function floorQualificationPrediction(input: {
  productType: string | null;
  abstained: boolean;
  fieldAssignments: Array<{ targetId: string; value?: string; values?: string[] }>;
  pageIds: string[];
  confidence: number;
  latencyMs: number;
}): ExecutedQualificationPrediction {
  return {
    ...input,
    source: QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR,
    blockedCode: null,
    blockedDetail: null,
    failureCode: null,
    ...emptyQualificationModelIdentity(),
  };
}

/**
 * Candidate side without live credentials: exercise the real Jev question
 * construction (wiring proof — a builder throw becomes a coded blocked side),
 * but record NO probabilities. There is no deterministic candidate quality
 * signal; the deterministic floor belongs to the baseline side only.
 */
function blockedCandidateWithoutCredentials(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
): ExecutedQualificationPrediction {
  try {
    buildQualificationCandidateQuestionSet(entry, taxa);
  } catch (err) {
    return blockedQualificationPrediction(
      QUALIFICATION_BLOCKED_QUESTION_CONSTRUCTION_FAILED,
      redactTransportText(err instanceof Error ? err.message : String(err)),
    );
  }
  return blockedQualificationPrediction(
    QUALIFICATION_BLOCKED_JEV_CREDENTIALS_ABSENT,
    'Candidate Jev judgments require explicit live credentials (TYPESAFE_API_KEY); deterministic mode records no candidate probabilities.',
  );
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
 * Candidate attributes from LIVE Jev answers: single-value targets use the
 * shipped Choice floor (`JEV_ATTRIBUTE_MIN_PROBABILITY`) after the shipped
 * canonical mapping; multi-value targets run the shipped
 * `evaluateMultiValueSelectionPolicy` over the answered Noul probabilities
 * (its own `JEV_MULTI_VALUE_MIN_PROBABILITY` gate applies inside).
 */
function interpretLiveCandidateAttributes(
  plans: QualificationCandidateAttributePlan[],
  answers: Record<string, SystemOneAnswer>,
): Array<{ targetId: string; value?: string; values?: string[] }> {
  const out: Array<{ targetId: string; value?: string; values?: string[] }> = [];
  for (const plan of plans) {
    if (plan.choicePlan) {
      const answer = requireChoiceAnswer(answers, plan.choicePlan.questionId);
      const choiceKey = answer.choice;
      const prob = answer.probabilities[choiceKey] ?? 0;
      if (choiceKey === JEV_NO_MATCH_KEY || choiceKey === JEV_INSUFFICIENT_EVIDENCE_KEY) continue;
      const canonicalValue = choiceKeyToCanonicalId(plan.choicePlan.keyToIdMap, choiceKey, 'option value');
      if (prob >= JEV_ATTRIBUTE_MIN_PROBABILITY) out.push({ targetId: plan.targetId, value: canonicalValue });
    } else {
      const candidates = (plan.noulPlans ?? []).map(p => ({
        optionValue: p.optionValue,
        optionLabel: p.optionLabel,
        optionIndex: p.optionIndex,
        prob: requireNoulAnswer(answers, p.questionId).noul,
      }));
      const outcome = evaluateMultiValueSelectionPolicy({
        target: plan.resolved,
        candidates,
        permittedEvidence: [],
        catalogField: null,
      });
      if (outcome.outcome === 'resolved') out.push({ targetId: plan.targetId, values: outcome.selectedValues });
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

/** Confidence for the artifact (abstained sides carry zero confidence). */
function artifactConfidence(abstained: boolean, confidence: number): number {
  return abstained ? 0 : Number(confidence.toFixed(4));
}

/** Deterministic baseline stages for one entry (unlabeled — callers add the source). */
function runDeterministicBaselineStages(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  evidenceText: string,
): {
  type: { productType: string | null; abstained: boolean; confidence: number };
  fields: Array<{ targetId: string; value?: string; values?: string[] }>;
  pages: string[];
} {
  return {
    type: predictBaselineProductType(entry, taxa, evidenceText),
    fields: predictBaselineAttributes(entry, taxa, evidenceText),
    pages: predictBaselinePages(entry, taxa, evidenceText),
  };
}

/** Execute the deterministic baseline + blocked candidate for one gold entry. */
function executeDeterministicFloorEntryPredictions(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
): { sku: string; baseline: ExecutedQualificationPrediction; candidate: ExecutedQualificationPrediction } {
  const evidenceText = qualificationEvidenceText(entry);
  const started = Date.now();
  const stages = runDeterministicBaselineStages(entry, taxa, evidenceText);
  const baseline = floorQualificationPrediction({
    productType: stages.type.productType,
    abstained: stages.type.abstained,
    fieldAssignments: stages.fields,
    pageIds: stages.pages,
    confidence: artifactConfidence(stages.type.abstained, stages.type.confidence),
    latencyMs: Math.max(0, Date.now() - started),
  });
  return { sku: entry.sku, baseline, candidate: blockedCandidateWithoutCredentials(entry, taxa) };
}

// ─── Live capture (opt-in, explicit credentials, real transports) ────────────

export interface QualificationJevLiveCredentials {
  /** Explicit TypeSafe key (TYPESAFE_API_KEY) — never read implicitly here. */
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export interface QualificationBaselineLiveRoute {
  /** Chat provider for the incumbent ranker leg (credential from the existing store). */
  provider: string;
  model: string;
}

export interface QualificationLiveCaptureOptions {
  jev?: QualificationJevLiveCredentials | null;
  baselineRoute?: QualificationBaselineLiveRoute | null;
}

interface ResolvedJevLiveTarget {
  conn: ProviderConnection;
  model: string;
  timeoutMs?: number;
}

/**
 * Ephemeral Jev connection for qualification capture (mirrors the bounded
 * live-contract check — no persisted secrets, no DB). The key travels only
 * in the Authorization header of the live dispatch.
 */
function buildQualificationJevConnection(apiKey: string): ProviderConnection {
  return {
    id: 'typesafe-qualification-capture',
    label: 'TypeSafe qualification capture (ephemeral)',
    transport: 'systemone',
    baseUrl: 'https://api.typesafe.ai/v1',
    credential: apiKey,
    trustZone: 'cloud',
    approvedHost: 'api.typesafe.ai',
    approvedPort: 443,
    enabled: true,
    connectTimeoutMs: 8000,
    inferenceTimeoutMs: 30_000,
  };
}

/** Resolve explicit Jev credentials (null when absent — the side stays blocked). */
function resolveJevLiveTarget(jev: QualificationJevLiveCredentials | null | undefined): ResolvedJevLiveTarget | null {
  const apiKey = jev?.apiKey ?? '';
  if (apiKey.length < 8) return null;
  return {
    conn: buildQualificationJevConnection(apiKey),
    model: jev?.model && jev.model.length > 0 ? jev.model : TYPESAFE_EVALUATED_MODEL,
    ...(jev?.timeoutMs !== undefined ? { timeoutMs: jev.timeoutMs } : {}),
  };
}

/**
 * Frozen-evidence Jev state for one gold entry: SKU + evidence snippets only.
 * Gold labels never enter the state — the model judges from evidence alone.
 */
function qualificationJevState(entry: QualificationGoldOnlyEntry): {
  sku: string;
  snippets: string[];
  evidenceCount: number;
} {
  return {
    sku: entry.sku,
    snippets: entry.evidence.map(ev => ev.snippet ?? '').filter(s => s.length > 0).slice(0, 15),
    evidenceCount: entry.evidence.length,
  };
}

type QualificationLiveQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } };

/** Assemble one entry's candidate questions into transport records (stable order). */
function assembleCandidateLiveQuestions(
  questions: QualificationCandidateQuestionSet,
): Array<{ questionId: string; question: QualificationLiveQuestion }> {
  const records: Array<{ questionId: string; question: QualificationLiveQuestion }> = [];
  records.push({
    questionId: questions.productTypePlan.questionId,
    question: {
      type: 'choice',
      instructions: questions.productTypePlan.instructions,
      criteria: questions.productTypePlan.criteria,
    },
  });
  for (const plan of questions.attributePlans) {
    if (plan.choicePlan) {
      records.push({
        questionId: plan.choicePlan.questionId,
        question: {
          type: 'choice',
          instructions: plan.choicePlan.instructions,
          criteria: plan.choicePlan.criteria,
        },
      });
    }
    for (const noul of plan.noulPlans ?? []) {
      records.push({
        questionId: noul.questionId,
        question: { type: 'noul', instructions: noul.instructions, criteria: noul.criteria },
      });
    }
  }
  if (questions.pagePlan) {
    records.push({
      questionId: questions.pagePlan.questionId,
      question: {
        type: 'choice',
        instructions: questions.pagePlan.instructions,
        criteria: questions.pagePlan.criteria,
      },
    });
  }
  return records;
}

interface MergedLiveAnswers {
  answers: Record<string, SystemOneAnswer>;
  requestedModel: string;
  resolvedModel: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Dispatch one entry's candidate questions in transport-sized chunks and
 * merge the validated answers. Usage sums across chunks; model identity comes
 * from the first dispatch (a single entry always targets one model).
 */
async function dispatchCandidateLiveQuestions(
  target: ResolvedJevLiveTarget,
  records: Array<{ questionId: string; question: QualificationLiveQuestion }>,
  state: unknown,
): Promise<MergedLiveAnswers> {
  const CHUNK_SIZE = 32;
  let merged: Record<string, SystemOneAnswer> | null = null;
  let requestedModel = target.model;
  let resolvedModel = target.model;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
    const chunk = records.slice(offset, offset + CHUNK_SIZE);
    const questions: Record<string, QualificationLiveQuestion> = {};
    for (const record of chunk) questions[record.questionId] = record.question;
    const result = await executeSystemOne(
      target.conn,
      target.model,
      questions,
      state,
      target.timeoutMs !== undefined ? { timeoutMs: target.timeoutMs } : {},
    );
    merged = { ...(merged ?? {}), ...result.answers };
    requestedModel = result.requestedModel;
    if (offset === 0) resolvedModel = result.returnedModel;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
  }
  return { answers: merged ?? {}, requestedModel, resolvedModel, inputTokens, outputTokens };
}

/**
 * Capture one entry's candidate side from LIVE Jev judgments: shipped
 * question builders → shipped transport → shipped extraction/mapping →
 * shipped floors + shipped multi-value policy. Any dispatch/validation
 * failure blocks the side with a coded reason (never a partial guess).
 */
async function captureCandidateEntryLive(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  target: ResolvedJevLiveTarget,
): Promise<ExecutedQualificationPrediction> {
  const started = Date.now();
  const fail = (detail: string): ExecutedQualificationPrediction => ({
    ...blockedQualificationPrediction(QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED, detail),
    latencyMs: Math.max(0, Date.now() - started),
  });
  try {
    const questions = buildQualificationCandidateQuestionSet(entry, taxa);
    const records = assembleCandidateLiveQuestions(questions);
    // Mirror production's candidate-limit abstention for product types: an
    // oversized closed world abstains the type stage (no first-N clipping)
    // while attributes/pages still capture from the live model.
    const typeOverLimit = taxa.productTypes.length > JEV_MAX_ORDINARY_CHOICE_CANDIDATES;
    const dispatchRecords = typeOverLimit ? records.slice(1) : records;
    const merged = await dispatchCandidateLiveQuestions(target, dispatchRecords, qualificationJevState(entry));

    let productType: string | null = null;
    let typeAbstained = true;
    let typeProb = 0;
    if (!typeOverLimit) {
      const answer = requireChoiceAnswer(merged.answers, questions.productTypePlan.questionId);
      const choiceKey = answer.choice;
      typeProb = answer.probabilities[choiceKey] ?? 0;
      if (choiceKey !== JEV_NO_MATCH_KEY && choiceKey !== JEV_INSUFFICIENT_EVIDENCE_KEY) {
        const canonicalId = choiceKeyToCanonicalId(questions.productTypePlan.keyToIdMap, choiceKey, 'option ID');
        if (typeProb >= JEV_PRODUCT_TYPE_MIN_PROBABILITY) {
          productType = canonicalId;
          typeAbstained = false;
        }
      }
    }

    const fieldAssignments = interpretLiveCandidateAttributes(questions.attributePlans, merged.answers);

    let pageIds: string[] = [];
    if (questions.pagePlan) {
      const answer = requireChoiceAnswer(merged.answers, questions.pagePlan.questionId);
      const choiceKey = answer.choice;
      const pageProb = answer.probabilities[choiceKey] ?? 0;
      if (choiceKey !== PAGE_NO_MATCH_CHOICE_KEY && choiceKey !== PAGE_INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
        const pageId = choiceKeyToCanonicalId(questions.pagePlan.keyToIdMap, choiceKey, 'option ID');
        if (pageProb >= JEV_PAGE_SINGLE_THRESHOLD) pageIds = [pageId];
      }
    }

    return {
      productType,
      abstained: typeAbstained,
      fieldAssignments,
      pageIds,
      confidence: artifactConfidence(typeAbstained, typeProb),
      latencyMs: Math.max(0, Date.now() - started),
      source: QUALIFICATION_SOURCE_LIVE_CAPTURED,
      blockedCode: null,
      blockedDetail: null,
      failureCode: null,
      requestedModel: merged.requestedModel,
      resolvedModel: merged.resolvedModel,
      provider: 'typesafe',
      usage: { inputTokens: merged.inputTokens, outputTokens: merged.outputTokens },
    };
  } catch (err) {
    return fail(redactTransportText(err instanceof Error ? err.message : String(err)));
  }
}

// ─── Baseline live leg (incumbent: deterministic first, then chat ranker) ────

type BaselineChatOperation = 'product_type_ranking' | 'attribute_ranking' | 'page_assignment';

/** Stages whose deterministic matcher abstained and that gold adjudicates. */
interface BaselineLiveNeeds {
  type: boolean;
  attrs: string[];
  pages: boolean;
}

/** Which baseline stages genuinely need a model judgment (mirrors incumbent precedence). */
function baselineLiveNeeds(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  evidenceText: string,
  stages: ReturnType<typeof runDeterministicBaselineStages>,
): BaselineLiveNeeds {
  const typeAttemptable = !isQualificationPredictionEmpty(taxa.productTypes.length, evidenceText);
  const pagesAttemptable = !isQualificationPredictionEmpty(taxa.pages.length, evidenceText);
  const matchedAttrTargets = new Set(stages.fields.map(f => f.targetId));
  return {
    type: typeAttemptable && stages.type.abstained,
    attrs: taxa.attributeTargets
      .filter(t => goldHasFieldTarget(entry, t.targetId) && !matchedAttrTargets.has(t.targetId))
      .map(t => t.targetId),
    pages: pagesAttemptable
      && stages.pages.length === 0
      && (entry.gold.categoryPages.pageIds.length > 0 || entry.gold.categoryPages.pageAssignments.length > 0),
  };
}

/** Operator-supplied chat routing for the baseline leg (names only — credentials stay in the store). */
function buildBaselineChatPolicyView(route: QualificationBaselineLiveRoute): ModelPolicyView {
  const locality = route.provider === 'ollama' ? 'local' : 'cloud';
  const stageOverride = {
    provider: route.provider,
    model: route.model,
    fallbackProvider: null,
    fallbackModel: null,
  };
  const policy: ModelPolicyConfigV2 = {
    defaultProvider: route.provider,
    defaultModel: route.model,
    providerLocalities: { [route.provider]: locality },
    stageOverrides: {
      primary_product_type_proposal: stageOverride,
      product_attribute_proposals: stageOverride,
      category_page_proposals: stageOverride,
    },
    textDataSharing: 'cloud_allowed',
    imageDataSharing: 'local_only',
    mlFeatures: {
      productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    },
  };
  return buildModelPolicyView(policy);
}

const BASELINE_CHAT_TASKS: Record<BaselineChatOperation, { task: string; label: string }> = {
  product_type_ranking: { task: 'product_type_classification', label: 'product type' },
  attribute_ranking: { task: 'attribute_value_classification', label: 'attribute' },
  page_assignment: { task: 'category_page_assignment', label: 'category page' },
};

/**
 * Resolve the incumbent chat config for one protected operation from the
 * EXISTING provider store (the same resolution the ranker performs
 * internally). Null/denial means no usable baseline model exists here — the
 * caller records `blocked`, never a guessed judgment.
 */
function resolveBaselineChatConfig(
  operation: BaselineChatOperation,
  view: ModelPolicyView,
): LlmConfig | null {
  const { task } = BASELINE_CHAT_TASKS[operation];
  return getLlmConfigForTask(task as LlmTask, {
    allowFallback: true,
    modelPolicy: view,
    protectedOperation: operation,
  });
}

/** Attempt the real legacy chat ranker for one needy baseline stage (null when the model abstains). */
async function attemptBaselineChatStage(input: {
  operation: BaselineChatOperation;
  targetLabel: string;
  options: Array<{ value: string; label: string }>;
  selectionMode: 'single' | 'multiple';
  evidenceText: string;
  view: ModelPolicyView;
}): Promise<LlmRankResult | null> {
  return llmRankOptions({
    targetLabel: input.targetLabel,
    options: input.options,
    selectionMode: input.selectionMode,
    evidenceText: input.evidenceText,
    task: BASELINE_CHAT_TASKS[input.operation].task,
    modelPolicy: input.view,
    protectedOperation: input.operation,
  });
}

/**
 * Capture one entry's baseline side with the incumbent precedence:
 * deterministic matcher first; the legacy chat ranker only for stages the
 * matcher left unresolved AND gold adjudicates. Without an opted-in route
 * (or when nothing needs a model) the side is the deterministic floor.
 * Missing credentials block the side; a consulted-but-abstaining ranker
 * records a live abstention (the incumbent genuinely abstains there —
 * production maps every ranker null to abstention, whatever its cause).
 *
 * Audit-provenance note: the legacy ranker fail-closes to null before any
 * transport when no run-bound audit context is present (its own design —
 * model output requires a durable start row). Qualification never fabricates
 * runs, so the ranker outcome here is its real fail-closed/abstention
 * outcome for these inputs, recorded with the requested route
 * (`requestedModel`/`provider`) and null `resolvedModel`/`usage`. A side
 * whose requested route resolved but no model spoke is still
 * `live_captured` (the live path executed and its outcome recorded) — the
 * reading rule is: `resolvedModel === null` means no model judgment spoke.
 */
async function captureBaselineEntryLive(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  evidenceText: string,
  route: QualificationBaselineLiveRoute | null,
  view: ModelPolicyView | null,
): Promise<ExecutedQualificationPrediction> {
  const started = Date.now();
  const latency = (): number => Math.max(0, Date.now() - started);
  const stages = runDeterministicBaselineStages(entry, taxa, evidenceText);
  const asFloor = (): ExecutedQualificationPrediction => floorQualificationPrediction({
    productType: stages.type.productType,
    abstained: stages.type.abstained,
    fieldAssignments: stages.fields,
    pageIds: stages.pages,
    confidence: artifactConfidence(stages.type.abstained, stages.type.confidence),
    latencyMs: latency(),
  });
  if (!route || !view) return asFloor();
  const needs = baselineLiveNeeds(entry, taxa, evidenceText, stages);
  if (!needs.type && needs.attrs.length === 0 && !needs.pages) return asFloor();

  const block = (code: string, detail: string): ExecutedQualificationPrediction => ({
    ...blockedQualificationPrediction(code, detail),
    latencyMs: latency(),
  });
  // Credential pre-check (same resolution the ranker uses): no usable
  // baseline model here means the side is blocked — the deterministic values
  // are discarded fail-closed rather than mixed with a guess. The resolved
  // config's model is what the ranker will request (factual provenance).
  let requestedModel: string = route.model;
  try {
    const firstOperation: BaselineChatOperation = needs.type
      ? 'product_type_ranking'
      : needs.attrs.length > 0 ? 'attribute_ranking' : 'page_assignment';
    const config = resolveBaselineChatConfig(firstOperation, view);
    if (!config) {
      return block(
        QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
        `No usable chat provider for the baseline ranker leg (provider "${route.provider}"); configure existing provider credentials to capture baseline model judgments.`,
      );
    }
    requestedModel = config.model ?? route.model;
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) {
      return block(
        QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
        `Baseline ranker route denied (${err.code}); configure existing provider credentials to capture baseline model judgments.`,
      );
    }
    return block(
      QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
      `Baseline ranker credentials unresolvable here: ${redactTransportText(err instanceof Error ? err.message : String(err))}`,
    );
  }

  try {
    let productType = stages.type.productType;
    let abstained = stages.type.abstained;
    let confidence = stages.type.confidence;
    if (needs.type) {
      const typeOptions = taxa.productTypes.map(t => ({ value: t.id, label: t.label }));
      const ranked = await attemptBaselineChatStage({
        operation: 'product_type_ranking',
        targetLabel: 'product type',
        options: typeOptions,
        selectionMode: 'single',
        evidenceText,
        view,
      });
      // Shipped incumbent mapping: ranker labels → exactly-one option value.
      const mapped = ranked && ranked.values.length > 0
        ? mapRankedLabelToOptionExactlyOne(ranked.values[0], typeOptions)
        : null;
      if (mapped) {
        productType = mapped;
        abstained = false;
        confidence = ranked?.confidence ?? 0;
      } else {
        productType = null;
        abstained = true;
        confidence = 0;
      }
    }

    const fields = [...stages.fields];
    for (const targetId of needs.attrs) {
      const target = taxa.attributeTargets.find(t => t.targetId === targetId);
      if (!target) continue;
      const ranked = await attemptBaselineChatStage({
        operation: 'attribute_ranking',
        targetLabel: targetId,
        options: target.options.map(v => ({ value: v, label: v })),
        selectionMode: target.cardinality,
        evidenceText,
        view,
      });
      // Shipped incumbent mapping: ranker values are used directly (mirrors
      // `mapAttributeLlmResult` — single takes values[0], multiple takes values).
      if (ranked && ranked.values.length > 0) {
        if (target.cardinality === 'multiple') {
          fields.push({ targetId, values: ranked.values });
        } else {
          fields.push({ targetId, value: ranked.values[0] });
        }
      }
    }
    fields.sort((a, b) => a.targetId.localeCompare(b.targetId));

    let pages = [...stages.pages];
    if (needs.pages) {
      const pageOptions = taxa.pages.map(p => ({ value: p.pageId, label: p.pageName }));
      const ranked = await attemptBaselineChatStage({
        operation: 'page_assignment',
        targetLabel: 'category page',
        options: pageOptions,
        selectionMode: 'single',
        evidenceText,
        view,
      });
      const mapped = ranked && ranked.values.length > 0
        ? mapRankedLabelToOptionExactlyOne(ranked.values[0], pageOptions)
        : null;
      pages = mapped ? [mapped] : [];
    }

    return {
      productType,
      abstained,
      fieldAssignments: fields,
      pageIds: pages,
      confidence: artifactConfidence(abstained, confidence),
      latencyMs: latency(),
      source: QUALIFICATION_SOURCE_LIVE_CAPTURED,
      blockedCode: null,
      blockedDetail: null,
      failureCode: null,
      requestedModel,
      resolvedModel: null,
      provider: route.provider,
      usage: null,
    };
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) {
      return block(
        QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
        `Baseline ranker route denied (${err.code}); configure existing provider credentials to capture baseline model judgments.`,
      );
    }
    return block(
      QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED,
      redactTransportText(err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Hash semantic predictions only: per-entry wall-clock latency and
 * diagnostic `blockedDetail` text are real telemetry recorded on the
 * artifact, but they must not affect identity — the same gold entries always
 * yield the same artifact hash. Source/identity markers (source, blockedCode,
 * requested/resolved model, provider, usage) ARE semantic and ARE hashed.
 */
function hashQualificationPredictions(
  predictions: Array<{
    sku: string;
    baseline: ExecutedQualificationPrediction;
    candidate: ExecutedQualificationPrediction;
  }>,
  resolved: {
    taxonomySource: QualificationTaxonomySource;
    frozenTaxonomyHash: string | null;
    taxonomies: QualificationTaxonomies;
  },
): string {
  const hashableSide = (side: ExecutedQualificationPrediction): Record<string, unknown> => ({
    productType: side.productType,
    abstained: side.abstained,
    fieldAssignments: side.fieldAssignments,
    pageIds: side.pageIds,
    confidence: side.confidence,
    source: side.source ?? null,
    blockedCode: side.blockedCode ?? null,
    failureCode: side.failureCode ?? null,
    requestedModel: side.requestedModel ?? null,
    resolvedModel: side.resolvedModel ?? null,
    provider: side.provider ?? null,
    usage: side.usage ?? null,
  });
  const sorted = [...predictions].sort((a, b) => a.sku.localeCompare(b.sku));
  const hashable = sorted.map(p => ({
    sku: p.sku,
    baseline: hashableSide(p.baseline),
    candidate: hashableSide(p.candidate),
  }));
  return sha256Hex(JSON.stringify({ predictions: hashable, taxonomy: hashableTaxonomyProvenance(resolved) }));
}

/** Hashable taxonomy provenance (same entries + different pool = different artifact). */
function hashableTaxonomyProvenance(resolved: {
  taxonomySource: QualificationTaxonomySource;
  frozenTaxonomyHash: string | null;
  taxonomies: QualificationTaxonomies;
}): Record<string, unknown> {
  return {
    taxonomySource: resolved.taxonomySource,
    frozenTaxonomyHash: resolved.frozenTaxonomyHash,
    taxonomies: resolved.taxonomies,
  };
}

/**
 * Deterministic-floor capture (CI-safe, no network, no credentials): the
 * baseline side executes the real deterministic matcher (labeled
 * `deterministic_floor` — a lower bound, never candidate evidence) and the
 * candidate side exercises the real Jev question construction but records
 * `blocked` (`jev_credentials_absent`). Deterministic: the same gold entries
 * always yield the same artifact hash. Fail-closed: every entry produces both
 * sides (abstention/blocked are valid predictions; throwing is not).
 */
export function buildQualificationPredictionsFromCode(
  entries: QualificationGoldOnlyEntry[],
  taxonomies?: QualificationTaxonomyInput,
): QualificationPredictionArtifact {
  const resolved = resolveQualificationTaxonomies(taxonomies, entries);
  const predictedAt = new Date().toISOString();
  const predictions = entries.map(entry => executeDeterministicFloorEntryPredictions(entry, resolved.taxonomies));
  if (predictions.length !== entries.length) {
    throw new Error('Qualification prediction artifact incomplete: missing entries.');
  }
  return {
    predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
    artifactHash: hashQualificationPredictions(predictions, resolved),
    predictedAt,
    entryCount: entries.length,
    captureMode: 'deterministic_floor',
    taxonomySource: resolved.taxonomySource,
    frozenTaxonomyHash: resolved.frozenTaxonomyHash,
    predictions,
  };
}

/**
 * Honest live capture (opt-in, explicit credentials, real transports):
 * the candidate side captures real Jev judgments when `options.jev` carries
 * an explicit key (else `blocked`), and the baseline side follows incumbent
 * precedence — deterministic first, then the legacy chat ranker for stages
 * the matcher left unresolved when `options.baselineRoute` is provided (else
 * the deterministic floor). Without credentials the affected side is
 * `blocked` with a coded reason — never simulated. Fail-closed like the
 * deterministic builder; `captureMode` is `live_captured` whenever a live
 * attempt was made for either side (per-side `source` fields carry the
 * per-entry outcome).
 */
export async function captureQualificationPredictionsLive(
  entries: QualificationGoldOnlyEntry[],
  options: QualificationLiveCaptureOptions = {},
  taxonomies?: QualificationTaxonomyInput,
): Promise<QualificationPredictionArtifact> {
  const resolved = resolveQualificationTaxonomies(taxonomies, entries);
  const taxa = resolved.taxonomies;
  const predictedAt = new Date().toISOString();
  const jev = resolveJevLiveTarget(options.jev);
  const view = options.baselineRoute ? buildBaselineChatPolicyView(options.baselineRoute) : null;
  const predictions: Array<{
    sku: string;
    baseline: ExecutedQualificationPrediction;
    candidate: ExecutedQualificationPrediction;
  }> = [];
  for (const entry of entries) {
    const evidenceText = qualificationEvidenceText(entry);
    const baseline = await captureBaselineEntryLive(entry, taxa, evidenceText, options.baselineRoute ?? null, view);
    const candidate = jev
      ? await captureCandidateEntryLive(entry, taxa, jev)
      : blockedCandidateWithoutCredentials(entry, taxa);
    predictions.push({ sku: entry.sku, baseline, candidate });
  }
  if (predictions.length !== entries.length) {
    throw new Error('Qualification prediction artifact incomplete: missing entries.');
  }
  return {
    predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
    artifactHash: hashQualificationPredictions(predictions, resolved),
    predictedAt,
    entryCount: entries.length,
    captureMode: jev || view ? 'live_captured' : 'deterministic_floor',
    taxonomySource: resolved.taxonomySource,
    frozenTaxonomyHash: resolved.frozenTaxonomyHash,
    predictions,
  };
}



