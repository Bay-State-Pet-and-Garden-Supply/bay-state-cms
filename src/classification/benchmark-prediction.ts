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
import fs from 'node:fs';
import path from 'node:path';
import { hashCanonicalJson, sha256Hex } from '../shared/stable-id';
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
  return getModelCallsByRun(runId).some(call => call.status === 'failed' || call.status === 'cancelled'
    || (call.operation === 'product_type_ranking' && call.status === 'policy_denied'));
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
    const code = codeFromValue(abstention.proposedValue);
    if (code && !['no_fit', 'no_match', 'insufficient_evidence'].includes(code)) {
      return { ...failPreReviewPrediction(base, code), provenance };
    }
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

  // Dependent refreshes intentionally consume human type review. They are not
  // uncorrected model predictions. An original immutable artifact remains
  // readable, but recapturing this changed run cannot qualify raw accuracy.
  if (classRunRepo.runHasDependentRefreshOutputs(run.id)) {
    return { ...failPreReviewPrediction(base, 'post_review_refresh'), provenance };
  }
  const proposals = classRunRepo.getProposalsByRun(run.id);
  if (proposals.some(proposal => proposal.isStale || proposal.status === 'stale' || proposal.supersededAt)) {
    return { ...failPreReviewPrediction(base, 'post_review_invalidation'), provenance };
  }
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
  resolveProductTypeDecision,
  type ProductTypeChoiceQuestionPlan,
} from './product-type-decision';
import {
  buildAttributeChoiceQuestion,
  buildAttributeNoulQuestions,
  evaluateMultiValueSelectionPolicy,
  JEV_ATTRIBUTE_MIN_PROBABILITY,
  resolveAttributeDecision,
  type AttributeChoiceQuestionPlan,
  type AttributeNoulQuestionPlan,
} from './attribute-decision';
import {
  buildPageChoiceQuestion,
  JEV_PAGE_SINGLE_THRESHOLD,
  PAGE_QUESTION_VERSION,
  PAGE_JUDGMENT_VERSION,
  NO_MATCH_CHOICE_KEY as PAGE_NO_MATCH_CHOICE_KEY,
  INSUFFICIENT_EVIDENCE_CHOICE_KEY as PAGE_INSUFFICIENT_EVIDENCE_CHOICE_KEY,
  type PageChoiceQuestionPlan,
} from './page-decision';
import type { ResolvedTarget } from './curation-target-resolver';
import type {
  ProductAttributeConfig,
  ModelPolicyConfigV2,
  FrozenTaxonomySnapshot,
  ClassificationEvidence,
} from '../shared/schemas/classification';
import { validateQualificationGoldFieldShapes } from '../shared/schemas/classification';
import { createRun, completeRun } from '../db/repositories/classification-run-repo';
import { getDb } from '../db/connection';
import {
  buildModelExecutionPlan,
  buildRuntimeRuleVersions,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
} from './model-operation-registry';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { executeSystemOne, TYPESAFE_EVALUATED_MODEL, type SystemOneAttemptBudget } from '../ai/systemone-transport';
import type { SystemOneAnswer } from '../shared/schemas/systemone';
import type { ProviderConnection } from '../ai/provider-connections';
import {
  requireChoiceAnswer,
  requireNoulAnswer,
  choiceKeyToCanonicalId,
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
  SYSTEMONE_MULTI_MIN_PROBABILITY,
} from './systemone-decision-core';
import { llmRankOptions, type LlmRankResult } from './curation-target-ranker';
import { normalizeAttributeId } from './evidence-targeting';
import { mapRankedLabelToOptionExactlyOne } from './cohort-product-type-resolver';
import {
  buildModelPolicyView,
  redactTransportText,
  ModelPolicyDeniedError,
  type ModelPolicyView,
  type ProtectedOperation,
} from './model-policy-gateway';
import { getLlmConfigForTask, getLlmCredentialReference, getLlmDispatchIdentityHash, LlmDispatchGuardError, type LlmConfig, type LlmDispatchGuard } from '../onboarding/llm-client';
import type { LlmTask } from '../db/repositories/llm-task-config-repo';
import { evaluateAttributeApplicability } from './applicability-evaluator';
import { buildFrozenTaxonomyCandidates } from './benchmark-exporter';

/** Honest capture v6: v5 plus per-target/page raw outcome metadata (coded semantic
 * abstention proof with probability, unresolved Noul/matcher silence) hashed into the artifact. */
export const QUALIFICATION_PREDICTOR_VERSION = 'code-executed-v7' as const;

/**
 * Explicit prediction-source contract for qualification captures.
 * - `live_captured`: a model SPOKE — the live path executed against frozen
 *   gold evidence, a run-bound model-call audit row terminalized with
 *   success, and `resolvedModel` + `usage` are present (never null). An
 *   abstention with a speaking model is still `live_captured` (abstained=true,
 *   failureCode null — an honest abstention, not a failure). A
 *   provider-selected-but-silent outcome (no success audit row, null
 *   resolvedModel/usage) is NEVER `live_captured` — it is `blocked` (failure)
 *   or the deterministic floor.
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
/**
 * Fail-closed applicability block (issue #302): the frozen Product Type →
 * profile → attribute mapping is absent or unresolvable for an entry, so no
 * attribute judgment can be grounded. Never silently broadened to all frozen
 * attributes.
 */
export const QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE = 'qualification_applicability_unresolvable' as const;

/** Gold-only entry: adjudicated labels + evidence. Never carries predictions. */
export interface QualificationGoldOnlyEntry extends QualificationGoldCore {}

/**
 * Per-target raw outcome from ACTUAL decision/answer interpretation (never a
 * label, never a prediction-as-answer):
 * - `predicted`: a value cleared the shipped probability floor.
 * - `abstained-semantic`: the decision explicitly selected a semantic
 *   abstention code (`no_match` / `insufficient_evidence`) — the ONLY outcome
 *   that can credit no-fit / insufficient-evidence gold, and only with the
 *   matching code at sufficient probability.
 * - `unresolved`: matcher silence, below-floor values, Noul selections the
 *   shipped policy left unresolved, or refusals — proves nothing and can never
 *   credit no-fit / insufficient-evidence gold (Noul has no explicit
 *   no-match/insufficient proof by construction).
 */
export type QualificationFieldOutcome = 'predicted' | 'abstained-semantic' | 'unresolved';

/** One executed field assignment with its raw outcome proof (additive metadata). */
export interface QualificationFieldAssignment {
  targetId: string;
  value?: string;
  values?: string[];
  outcome?: QualificationFieldOutcome;
  abstentionCode?: string | null;
  probability?: number | null;
  /**
   * Per-Noul-value P(yes) keyed by canonical configured value (actual model
   * probabilities, never renormalized) + their canonical digest for the
   * calibration audit. Additive: scoring reads outcome/values only.
   */
  candidateProbabilities?: Record<string, number> | null;
  probabilityDigest?: string | null;
}

/**
 * Canonical per-candidate P(yes) map (canonical configured value → actual
 * probability, insertion order = option order) + its digest for the
 * calibration audit. Never renormalized, never invented confidence.
 */
function hashNoulCandidateProbabilities(
  candidates: Array<{ optionValue: string; prob: number }>,
): { candidateProbabilities: Record<string, number>; probabilityDigest: string } {
  const candidateProbabilities: Record<string, number> = {};
  for (const c of candidates) candidateProbabilities[c.optionValue] = c.prob;
  const sorted = Object.entries(candidateProbabilities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { candidateProbabilities, probabilityDigest: sha256Hex(JSON.stringify(sorted)) };
}

/**
 * Target-permitted evidence for one qualification target (exported for
 * wiring tests): the shipped visual-eligibility rule (ineligible drops
 * visual clips) plus explicit-attribute isolation — clips naming another
 * attribute never support this target (no ingredient/claim leakage), while
 * unattributed clips stay eligible for the packet builder's per-citation
 * source-field check. Never gold, never annotations, never dummy blanks.
 */
export function permittedEvidenceForQualificationTarget(
  evidence: ClassificationEvidence[],
  attribute: ProductAttributeConfig | null | undefined,
  targetId: string,
): ClassificationEvidence[] {
  const eligible = attribute?.visualEvidenceEligibility === 'ineligible'
    ? evidence.filter(e => e.source !== 'visual_product_evidence')
    : evidence;
  const normTarget = normalizeAttributeId(targetId);
  return eligible.filter(e => e.attributeId == null || normalizeAttributeId(e.attributeId) === normTarget);
}

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
  abstentionCode?: string | null;
  fieldAssignments: Array<QualificationFieldAssignment>;
  pageIds: string[];
  /** Raw page outcome proof (additive; absent on legacy artifacts). */
  pageOutcome?: QualificationFieldOutcome | null;
  pageAbstentionCode?: string | null;
  pageProbability?: number | null;
  /**
   * REAL product-type outcome probability (additive): the actual selected P
   * pulled from the typed transport answer BEFORE abstention branching —
   * persisted for predicted AND semantic-abstention outcomes (no_fit /
   * insufficient_evidence keep their P for future prob refit). Absent
   * (legacy, blocked, over-limit, silent) stays unknown — never P=0.
   * `confidence` keeps its legacy floor semantics (0 when abstained).
   */
  typeProbability?: number | null;
  /**
   * Full canonical Choice set (canonical id-or-literal → actual P) retained
   * only when the transport answer provided it; unknown when missing. Never
   * renormalized, never invented.
   */
  typeCandidateProbabilities?: Record<string, number> | null;
  typeProbabilityDigest?: string | null;
  confidence: number;
  latencyMs: number;
  source?: QualificationPredictionSource;
  blockedCode?: string | null;
  blockedDetail?: string | null;
  failureCode?: string | null;
  requestedModel?: string | null;
  resolvedModel?: string | null;
  provider?: string | null;
  /** Actual verified existing-store credential source; never the credential value. */
  credentialRef?: string | null;
  routeIdentityHash?: string | null;
  usage?: { inputTokens: number | null; outputTokens: number | null } | null;
}

type QualificationProductTypePrediction = Pick<ExecutedQualificationPrediction, 'productType' | 'abstained' | 'abstentionCode' | 'confidence'>;

/** One frozen profile attribute entry carried in qualification taxonomies. */
export interface QualificationFrozenProfileAttribute {
  attributeId: string;
  cardinality: 'single' | 'multiple';
  required: boolean;
  applicabilityConditions: unknown[];
}

/** One frozen Attribute Profile carried in qualification taxonomies. */
export interface QualificationFrozenAttributeProfile {
  id: string;
  productTypeId: string;
  attributes: QualificationFrozenProfileAttribute[];
}

/** Closed-world candidate sets derived globally from adjudicated gold labels. */
export interface QualificationTaxonomies {
  productTypes: Array<{ id: string; label: string; description?: string | null; attributeProfileId?: string | null; invariantAttributes?: Record<string, string | string[]> }>;
  attributeTargets: Array<{ targetId: string; cardinality: 'single' | 'multiple'; options: string[]; isUniversal?: boolean }>;
  pages: Array<{ pageId: string; pageName: string }>;
  /**
   * REAL frozen Product Type → attributeProfileId pointer (additive, issue
   * #302): typeId → profileId (`null` = legitimately EMPTY profile,
   * universal-only, never "all fields"). Absent means the mapping was never
   * captured — callers fail closed (blocked with
   * `qualification_applicability_unresolvable`), never broaden to all frozen
   * attributes. Gold labels never decide WHAT is predicted.
   */
  typeAttributeProfiles?: Record<string, string | null> | null;
  /**
   * REAL frozen Attribute Profiles (additive): profile members carry
   * per-profile cardinality (wins over the global target mode) plus
   * applicabilityConditions evaluated by the shipped
   * `evaluateAttributeApplicability` helper (missing reviewed facts →
   * `unknown` → withheld, production parity).
   */
  attributeProfiles?: QualificationFrozenAttributeProfile[] | null;
  /**
   * REAL frozen universal tier (additive): attribute ids that proceed without
   * a Product Type (production parity via the shipped `isUniversalAttribute`
   * helper + this explicit list). Null-type entries yield universals only.
   */
  universalAttributeIds?: string[] | null;
  /**
   * REAL frozen invariant values by Product Type (additive): deterministic
   * values implied by the effective type, resolved before the variable-field
   * loop (production parity — zero model calls, excluded from Jev questions).
   */
  invariantAttributesByType?: Record<string, Record<string, string | string[]>> | null;
  /**
   * Legacy frozen type→targets mapping (deprecated, read-only compat): when
   * the REAL mapping above is present it wins; a legacy-only input without
   * the REAL mapping still fails closed (it lacks conditions/universals/
   * cardinality/invariants and cannot evidence production parity).
   */
  typeProfiles?: Record<string, string[]> | null;
  /**
   * REAL frozen authority details (additive): per-target catalog-field
   * mapping + attribute grounding flags (aliases, claim/composition,
   * visual eligibility) carried from the approved frozen bundle. They ride
   * the resolved targets into the shipped question builders and the shipped
   * multi-value policy (permission/grounding parity) — never gold, never
   * invented. Absent means stubs (prior behavior, documented weaker
   * grounding).
   */
  frozenAuthorityDetails?: FrozenAuthorityDetails | null;
}

/** Per-target grounding flags from the frozen bundle (aliases stay canonical). */
export interface FrozenAuthorityAttributeDetail {
  valueAliases: Array<{ alias: string; mapsTo: string }>;
  isClaim: boolean;
  isCompositionAttribute: boolean;
  visualEvidenceEligibility: ProductAttributeConfig['visualEvidenceEligibility'];
}

/** Frozen bundle details that the snapshot schema has no slot for (sidecar, never gold). */
export interface FrozenAuthorityDetails {
  catalogFieldByTarget?: Record<string, string | null>;
  attributeConfigByTarget?: Record<string, FrozenAuthorityAttributeDetail>;
  /**
   * REAL configured attribute names from the frozen bundle (production
   * question builders address attributes by configured name, never opaque
   * ids). Keyed by canonical target id; absent ⇒ stub id (weaker meaning).
   */
  attributeNameByTarget?: Record<string, string>;
  /**
   * REAL configured attribute definitions (null = explicitly empty, never
   * faked). Preserved for meaning parity; questions never invent copy.
   */
  attributeDescriptionByTarget?: Record<string, string | null>;
  /**
   * REAL configured target labels from the frozen curation targets
   * (model-visible question text uses these, never opaque ids).
   */
  targetLabelByTarget?: Record<string, string>;
  /**
   * FULL canonical authority hash (hashCanonicalJson over
   * {bundle, pages, binding-minus-capturedAt} from the approved public
   * taxonomy file). Binds the replay to the exact frozen authority; carried
   * into the artifact identity below. Null when the caller never proved an
   * authority (legacy inputs) — never invented.
   */
  authorityHash?: string | null;
}

/** Versioned canonical hash domain for authority details (bump on shape change). */
export const FROZEN_AUTHORITY_DETAILS_HASH_VERSION = 2 as const;

/**
 * Strict validation for authority details (fail-closed, never silent):
 * canonical non-empty target/attribute ids, string-or-null catalog slots,
 * well-formed alias defs ({alias, mapsTo} non-empty strings), boolean claim
 * flags, a known visual eligibility, and a 64-hex authority hash when
 * present. Missing permission policy is NEVER invented — callers fall back
 * to stubs (documented weaker grounding).
 */
export function validateFrozenAuthorityDetails(details: FrozenAuthorityDetails): void {
  const fail = (why: string): never => {
    throw new Error(`frozen_authority_malformed: ${why}`);
  };
  if (!details || typeof details !== 'object' || Array.isArray(details)) fail('details must be an object');
  const { catalogFieldByTarget, attributeConfigByTarget, authorityHash } = details;  if (catalogFieldByTarget !== undefined) {
    if (!catalogFieldByTarget || typeof catalogFieldByTarget !== 'object' || Array.isArray(catalogFieldByTarget)) {
      fail('catalogFieldByTarget must be a record');
    }
    for (const [targetId, slot] of Object.entries(catalogFieldByTarget)) {
      if (targetId.length === 0) fail('catalog slot target id must be canonical non-empty');
      if (slot !== null && (typeof slot !== 'string' || slot.length === 0)) fail(`catalog slot for "${targetId}" must be a string or null`);
    }
  }
  if (attributeConfigByTarget !== undefined) {
    if (!attributeConfigByTarget || typeof attributeConfigByTarget !== 'object' || Array.isArray(attributeConfigByTarget)) {
      fail('attributeConfigByTarget must be a record');
    }
    for (const [targetId, flag] of Object.entries(attributeConfigByTarget)) {
      if (targetId.length === 0) fail('attribute target id must be canonical non-empty');
      if (!flag || typeof flag !== 'object') fail(`attribute flags for "${targetId}" must be an object`);
      if (!Array.isArray(flag.valueAliases)) fail(`valueAliases for "${targetId}" must be an array`);
      for (const alias of flag.valueAliases) {
        if (!alias || typeof alias.alias !== 'string' || alias.alias.length === 0
          || typeof alias.mapsTo !== 'string' || alias.mapsTo.length === 0) {
          fail(`alias def for "${targetId}" must carry non-empty alias + mapsTo`);
        }
      }
      if (typeof flag.isClaim !== 'boolean' || typeof flag.isCompositionAttribute !== 'boolean') {
        fail(`claim flags for "${targetId}" must be booleans`);
      }
      if (flag.visualEvidenceEligibility !== 'eligible' && flag.visualEvidenceEligibility !== 'ineligible') {
        fail(`visual eligibility for "${targetId}" must be eligible|ineligible`);
      }
    }
  }
  if (authorityHash !== undefined && authorityHash !== null && !/^[0-9a-f]{64}$/.test(authorityHash)) {
    fail('authorityHash must be 64-hex when present');
  }
  const { attributeNameByTarget, attributeDescriptionByTarget, targetLabelByTarget } = details;
  for (const [mapName, map] of [
    ['attributeNameByTarget', attributeNameByTarget],
    ['targetLabelByTarget', targetLabelByTarget],
  ] as const) {
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(`${mapName} must be a record`);
    for (const [targetId, name] of Object.entries(map)) {
      if (targetId.length === 0) fail(`${mapName} target id must be canonical non-empty`);
      if (typeof name !== 'string' || name.length === 0) fail(`${mapName} for "${targetId}" must be a non-empty string`);
    }
  }
  if (attributeDescriptionByTarget !== undefined) {
    if (!attributeDescriptionByTarget || typeof attributeDescriptionByTarget !== 'object' || Array.isArray(attributeDescriptionByTarget)) {
      fail('attributeDescriptionByTarget must be a record');
    }
    for (const [targetId, definition] of Object.entries(attributeDescriptionByTarget)) {
      if (targetId.length === 0) fail('attribute definition target id must be canonical non-empty');
      if (definition !== null && typeof definition !== 'string') fail(`attribute definition for "${targetId}" must be a string or explicit null`);
    }
  }
}

/**
 * Canonical versioned hash of authority details (null when absent). Part of
 * the artifact identity: same predictions + altered alias/claim/catalog
 * permission ⇒ different artifact. Uses hashCanonicalJson (canonical key
 * order), never insertion-order JSON.
 */
export function frozenAuthorityDetailsHash(details: FrozenAuthorityDetails | null | undefined): string | null {
  if (!details) return null;
  validateFrozenAuthorityDetails(details);
  return hashCanonicalJson({
    version: FROZEN_AUTHORITY_DETAILS_HASH_VERSION,
    catalogFieldByTarget: details.catalogFieldByTarget ?? null,
    attributeConfigByTarget: details.attributeConfigByTarget ?? null,
    attributeNameByTarget: details.attributeNameByTarget ?? null,
    attributeDescriptionByTarget: details.attributeDescriptionByTarget ?? null,
    targetLabelByTarget: details.targetLabelByTarget ?? null,
    authorityHash: details.authorityHash ?? null,
  });
}

/**
 * Attach frozen authority details to taxonomies (pure copy). The snapshot
 * hash covers the candidate pool; details extend the artifact hash via the
 * resolved targets + field assignments (extended, never weakened).
 */
export function attachFrozenAuthorityDetails(
  taxonomies: QualificationTaxonomies,
  details: FrozenAuthorityDetails | null | undefined,
): QualificationTaxonomies {
  if (!details) return taxonomies;
  validateFrozenAuthorityDetails(details);
  return { ...taxonomies, frozenAuthorityDetails: details };
}

/**
 * Attach frozen authority details to a validated snapshot as a sidecar for
 * capture (post-schema-validation — the strict snapshot schema has no slot
 * for aliases/catalog fields/guidance, which stay preserved in the source
 * bundle). `qualificationTaxonomiesFromFrozenSnapshot` carries the sidecar
 * into the resolved taxonomies; the frozen_snapshot contract + hash are
 * unchanged.
 */
export function withFrozenAuthorityDetails(
  snapshot: FrozenTaxonomySnapshot,
  details: FrozenAuthorityDetails | null | undefined,
): FrozenTaxonomySnapshot {
  if (!details) return snapshot;
  validateFrozenAuthorityDetails(details);
  return { ...snapshot, frozenAuthorityDetails: details } as FrozenTaxonomySnapshot;
}

/** Read a well-formed authority sidecar off a snapshot (null when absent). */
function readFrozenAuthoritySidecar(snapshot: FrozenTaxonomySnapshot): FrozenAuthorityDetails | null {
  const sidecar = (snapshot as unknown as { frozenAuthorityDetails?: unknown }).frozenAuthorityDetails;
  if (sidecar === null || sidecar === undefined) return null;
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    throw new Error('Qualification frozen authority sidecar is malformed.');
  }
  validateFrozenAuthorityDetails(sidecar as FrozenAuthorityDetails);
  return sidecar as FrozenAuthorityDetails;
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
  decisionPolicyHash: string;
  predictedAt: string;
  entryCount: number;
  captureMode: QualificationCaptureMode;
  taxonomySource: QualificationTaxonomySource;
  frozenTaxonomyHash: string | null;
  /**
   * FULL canonical authority binding (additive identity): the frozen
   * bundle/pages/binding hash plus the versioned authority-details hash.
   * Altered aliases/claim flags/catalog slots change the artifact even when
   * predictions are identical; gold labels never enter (same labels-outcome
   * ⇒ same hash contribution: none).
   */
  authorityHash: string | null;
  authorityDetailsHash: string | null;
  /**
   * Canonical source-input digest (finding 2, additive): hash of the LOADED
   * capture inputs (identity + evidence + resolved taxonomy provenance),
   * computed before dispatch via `hashQualificationSourceInputs`. Gold labels
   * never enter. Captures predating this field carry `null` (legacy,
   * unverifiable — rescoring must fail this proof or mark it unverified).
   */
  sourceInputsHash: string | null;
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
const QUALIFICATION_GOLD_TYPE_KINDS = new Set(['known-type', 'no-fit', 'insufficient-evidence', 'unlabeled']);
const QUALIFICATION_GOLD_FIELD_STATES = new Set([
  'known',
  'no-fit',
  'insufficient-evidence',
  'inapplicable',
  'not_applicable',
  'unlabeled',
]);
const QUALIFICATION_GOLD_PAGE_STATES = new Set(['known', 'unknown', 'partial', 'unlabeled']);
const QUALIFICATION_GOLD_PAGE_COMPLETENESS = new Set(['complete', 'partial', 'unknown']);

/**
 * Strictly validate one gold-only entry; present-but-invalid states throw
 * (never reinterpreted). ABSENT markers stay readable as legacy bytes — they
 * fail closed later at qualification (never silently qualify).
 */
function validateQualificationGoldEntry(e: Record<string, unknown> & {
  sku: string;
  gold: QualificationGoldOnlyEntry['gold'];
}): void {
  const gold = e.gold as QualificationGoldOnlyEntry['gold'];
  const kind: unknown = (gold.productType as { kind?: unknown } | undefined)?.kind;
  if (kind !== undefined && kind !== null &&
    (typeof kind !== 'string' || !QUALIFICATION_GOLD_TYPE_KINDS.has(kind))) {
    throw new Error(`Qualification gold entry "${e.sku}" has invalid productType.kind.`);
  }
  for (const field of gold.fieldAssignments ?? []) {
    const state: unknown = (field as { state?: unknown }).state;
    if (state !== undefined && state !== null &&
      (typeof state !== 'string' || !QUALIFICATION_GOLD_FIELD_STATES.has(state))) {
      throw new Error(`Qualification gold entry "${e.sku}" has invalid field state for "${field.targetId}".`);
    }
  }
  const pages = gold.categoryPages as { state?: unknown; completeness?: unknown } | undefined;
  if (pages && pages.state !== undefined && pages.state !== null &&
    (typeof pages.state !== 'string' || !QUALIFICATION_GOLD_PAGE_STATES.has(pages.state))) {
    throw new Error(`Qualification gold entry "${e.sku}" has invalid page state.`);
  }
  if (pages && pages.completeness !== undefined && pages.completeness !== null &&
    (typeof pages.completeness !== 'string' || !QUALIFICATION_GOLD_PAGE_COMPLETENESS.has(pages.completeness))) {
    throw new Error(`Qualification gold entry "${e.sku}" has invalid page completeness.`);
  }
}

/** True when every field assignment carries a valid adjudication state. */
function hasCompleteFieldMarkers(entry: QualificationGoldOnlyEntry): boolean {
  for (const field of entry.gold.fieldAssignments ?? []) {
    const state: unknown = (field as { state?: unknown }).state;
    if (typeof state !== 'string' || !QUALIFICATION_GOLD_FIELD_STATES.has(state)) return false;
  }
  return true;
}

/**
 * Raw-accuracy eligibility for one gold entry (the conservative qualifier's
 * fail-closed guard — legacy bytes load, but marker-less rows never qualify):
 * a adjudicated type kind (never unlabeled/missing), valid states on every
 * field assignment, strict field value shapes, and explicit complete page
 * adjudication (never unknown/partial/missing). Explicit legacy reader
 * versions and shape violations are never eligible. Scoring independently
 * excludes the same rows.
 */
export function isRawQualificationEntryEligible(entry: QualificationGoldOnlyEntry): boolean {
  if (entry.readerVersion === QUALIFICATION_GOLD_LEGACY_READER_VERSION) return false;
  const kind: unknown = (entry.gold.productType as { kind?: unknown } | undefined)?.kind;
  if (kind !== 'known-type' && kind !== 'no-fit' && kind !== 'insufficient-evidence') return false;
  if (!hasCompleteFieldMarkers(entry)) return false;
  if (validateQualificationGoldFieldShapes(
    entry.gold.fieldAssignments as unknown,
    entry.sku,
  ).length > 0) return false;
  const pages = entry.gold.categoryPages as { state?: unknown; completeness?: unknown } | undefined;
  if (!pages || pages.state !== 'known' || pages.completeness !== 'complete') return false;
  return true;
}

/** Explicit legacy reader version: old bytes stay readable, never qualify. */
export const QUALIFICATION_GOLD_LEGACY_READER_VERSION = 'legacy' as const;

/**
 * Resolve the legacy reader flag from the fixture root or the entry (entry
 * wins when both declare). Absent on both means the new marker contract:
 * strict. Any other spelling throws fail-closed (never silently tolerated).
 */
function resolveQualificationLegacyReader(fixture: unknown, raw: unknown): boolean {
  const versions = [
    (fixture as { readerVersion?: unknown } | null)?.readerVersion,
    (raw as { readerVersion?: unknown } | null)?.readerVersion,
  ];
  for (const version of versions) {
    if (version === undefined || version === null) continue;
    if (version !== QUALIFICATION_GOLD_LEGACY_READER_VERSION) {
      throw new Error(
        `Qualification gold fixture has unknown readerVersion ${JSON.stringify(version)} (expected "legacy" or absent).`,
      );
    }
    return true;
  }
  return false;
}

/** Throw on the first strict field-shape violation for one entry. */
function throwOnQualificationFieldShapeIssues(
  fieldAssignments: unknown,
  sku: string,
): void {
  const issues = validateQualificationGoldFieldShapes(fieldAssignments, sku);
  if (issues.length === 0) return;
  const first = issues[0];
  throw new Error(
    `Qualification gold entry "${sku}" field "${first.targetId}": ${first.message}`,
  );
}

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
    const legacy = resolveQualificationLegacyReader(value, raw);
    if (!legacy) {
      // Strict marker contract: shared shape gate first (clear field errors),
      // then state spelling — malformed v2 bytes throw before any scoring.
      throwOnQualificationFieldShapeIssues(
        (e.gold as { fieldAssignments?: unknown } | undefined)?.fieldAssignments,
        e.sku,
      );
      validateQualificationGoldEntry(e);
    }
    // Gold-only: baseline/candidate keys stay unread (never prediction inputs).
    return {
      sku: e.sku,
      familyId: e.familyId,
      split: e.split,
      assortment: e.assortment,
      gold: e.gold,
      evidence: e.evidence,
      ...(legacy ? { readerVersion: QUALIFICATION_GOLD_LEGACY_READER_VERSION } : {}),
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
 *
 * REAL mapping (issue #302): carries the frozen Product Type →
 * attributeProfileId pointer, the frozen Attribute Profiles (per-profile
 * cardinality + applicabilityConditions), the frozen universal tier, and the
 * frozen invariant values — never derived from gold. The artifact hash covers
 * all of it (extended, never weakened).
 */
export function qualificationTaxonomiesFromFrozenSnapshot(
  snapshot: FrozenTaxonomySnapshot,
): QualificationTaxonomies {
  // Base candidate pools come from the exporter's single construction site
  // (no drift between gold-containment and prediction pools); the REAL
  // applicability mapping rides along from the same snapshot (never gold).
  const candidates = buildFrozenTaxonomyCandidates(snapshot);
  const legacySidecar = snapshot as unknown as {
    typeProfiles?: unknown;
    typeAttributeMap?: unknown;
  };
  const legacyTypeProfiles = readQualificationLegacyTypeProfiles(legacySidecar);
  const { typeAttributeProfiles, attributeProfiles, universalAttributeIds, invariantAttributesByType } =
    readQualificationFrozenApplicability(snapshot);
  const productTypes = candidates.productTypes.map(t => {
    const frozen = snapshot.productTypes.find(p => p.id === t.id);
    // REAL configured definition reconstructed from the frozen snapshot
    // (v8+ sidecar/slot; absent/null stay omitted for legacy snapshots).
    // Malformed (present non-string) fails closed — never silently dropped.
    const rawDescription = (frozen as unknown as { description?: unknown } | undefined)?.description;
    if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== 'string') {
      throw new Error(`Qualification frozen product type "${t.id}" carries a malformed non-string description.`);
    }
    return {
      ...t,
      ...(typeof rawDescription === 'string' && rawDescription.length > 0 ? { description: rawDescription } : {}),
      ...(frozen?.invariantAttributes !== undefined ? { invariantAttributes: frozen.invariantAttributes } : {}),
    };
  });
  return {
    productTypes,
    attributeTargets: candidates.attributeTargets,
    pages: candidates.pages,
    ...(legacyTypeProfiles ? { typeProfiles: legacyTypeProfiles } : {}),
    ...(typeAttributeProfiles ? { typeAttributeProfiles } : {}),
    ...(attributeProfiles ?? candidates.attributeProfiles
      ? { attributeProfiles: (attributeProfiles ?? candidates.attributeProfiles) as QualificationFrozenAttributeProfile[] }
      : {}),
    ...(universalAttributeIds ?? candidates.universalAttributeIds
      ? { universalAttributeIds: (universalAttributeIds ?? candidates.universalAttributeIds) as string[] }
      : {}),
    ...(invariantAttributesByType ?? candidates.invariantAttributesByType
      ? {
        invariantAttributesByType: (invariantAttributesByType ??
          candidates.invariantAttributesByType) as Record<string, Record<string, string | string[]>>,
      }
      : {}),
    // Frozen authority sidecar (aliases/catalog fields/grounding flags):
    // carried from the validated bundle, never gold, never invented.
    ...(readFrozenAuthoritySidecar(snapshot)
      ? { frozenAuthorityDetails: readFrozenAuthoritySidecar(snapshot) as FrozenAuthorityDetails }
      : {}),
  };
}

/**
 * Read the REAL frozen applicability mapping from a validated snapshot.
 * Returns null fields when the snapshot predates the mapping (legacy) —
 * callers fail closed (blocked), never broaden. Malformed mappings throw
 * fail-closed (never a silent substitution). Gold labels are never read.
 */
/** True when a snapshot carries any REAL mapping signal (else legacy, unresolvable). */
function hasQualificationMappingSignal(snapshot: FrozenTaxonomySnapshot): boolean {
  return (
    Array.isArray((snapshot as { attributeProfiles?: unknown }).attributeProfiles) ||
    Array.isArray((snapshot as { universalAttributeIds?: unknown }).universalAttributeIds) ||
    snapshot.productTypes.some(t => (t as { attributeProfileId?: unknown }).attributeProfileId !== undefined) ||
    snapshot.productTypes.some(t => (t as { invariantAttributes?: unknown }).invariantAttributes !== undefined) ||
    snapshot.attributeTargets.some(t => (t as { isUniversal?: unknown }).isUniversal !== undefined)
  );
}

/** Empty (legacy) applicability mapping — callers fail closed, never broaden. */
function emptyQualificationApplicability(): {
  typeAttributeProfiles: Record<string, string | null> | null;
  attributeProfiles: QualificationFrozenAttributeProfile[] | null;
  universalAttributeIds: string[] | null;
  invariantAttributesByType: Record<string, Record<string, string | string[]>> | null;
} {
  return {
    typeAttributeProfiles: null,
    attributeProfiles: null,
    universalAttributeIds: null,
    invariantAttributesByType: null,
  };
}

/** Type→profile pointers for a snapshot (malformed → throw fail-closed). */
function readQualificationTypePointers(snapshot: FrozenTaxonomySnapshot): Record<string, string | null> {
  const pointers: Record<string, string | null> = {};
  for (const t of snapshot.productTypes) {
    const pointer = (t as { attributeProfileId?: unknown }).attributeProfileId;
    if (pointer === undefined) {
      throw new Error(`Qualification frozen applicability mapping is malformed: type "${t.id}" lacks attributeProfileId.`);
    }
    if (pointer !== null && typeof pointer !== 'string') {
      throw new Error(`Qualification frozen applicability mapping is malformed: type "${t.id}" pointer.`);
    }
    pointers[t.id] = pointer;
  }
  return pointers;
}

/** Universal attribute ids for a snapshot (malformed → throw fail-closed). */
function readQualificationUniversals(snapshot: FrozenTaxonomySnapshot): string[] {
  const universalSet = new Set<string>();
  for (const t of snapshot.attributeTargets) {
    if ((t as { isUniversal?: unknown }).isUniversal === true) universalSet.add(t.targetId);
  }
  const listed = (snapshot as { universalAttributeIds?: unknown }).universalAttributeIds;
  if (Array.isArray(listed)) {
    for (const id of listed) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('Qualification frozen applicability mapping is malformed: universalAttributeIds.');
      }
      universalSet.add(id);
    }
  }
  return [...universalSet].sort();
}

/** Invariant values by type for a snapshot (malformed → throw fail-closed). */
function readQualificationInvariants(
  snapshot: FrozenTaxonomySnapshot,
): Record<string, Record<string, string | string[]>> {
  const byType: Record<string, Record<string, string | string[]>> = {};
  for (const t of snapshot.productTypes) {
    const inv = (t as { invariantAttributes?: unknown }).invariantAttributes;
    if (inv === undefined) continue;
    if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
      throw new Error(`Qualification frozen applicability mapping is malformed: type "${t.id}" invariants.`);
    }
    byType[t.id] = inv as Record<string, string | string[]>;
  }
  return byType;
}

function readQualificationFrozenApplicability(snapshot: FrozenTaxonomySnapshot): {
  typeAttributeProfiles: Record<string, string | null> | null;
  attributeProfiles: QualificationFrozenAttributeProfile[] | null;
  universalAttributeIds: string[] | null;
  invariantAttributesByType: Record<string, Record<string, string | string[]>> | null;
} {
  if (!hasQualificationMappingSignal(snapshot)) return emptyQualificationApplicability();
  // Partial mapping is malformed (fail closed): a real snapshot carries the
  // full pipeline (type pointers + profiles + universals), never a fragment.
  const rawProfiles = (snapshot as { attributeProfiles?: unknown }).attributeProfiles;
  if (!Array.isArray(rawProfiles)) {
    throw new Error('Qualification frozen applicability mapping is malformed: attributeProfiles missing.');
  }
  return {
    typeAttributeProfiles: readQualificationTypePointers(snapshot),
    attributeProfiles: rawProfiles.map(parseQualificationFrozenProfile),
    universalAttributeIds: readQualificationUniversals(snapshot),
    invariantAttributesByType: readQualificationInvariants(snapshot),
  };
}

/** Parse one frozen profile entry (malformed → throw fail-closed). */
function parseQualificationFrozenProfile(entry: unknown): QualificationFrozenAttributeProfile {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Qualification frozen applicability mapping is malformed: profile entry.');
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.productTypeId !== 'string' || !Array.isArray(e.attributes)) {
    throw new Error('Qualification frozen applicability mapping is malformed: profile shape.');
  }
  return {
    id: e.id,
    productTypeId: e.productTypeId,
    attributes: (e.attributes as unknown[]).map(parseQualificationFrozenProfileAttribute),
  };
}

/** Parse one frozen profile attribute (malformed → throw fail-closed). */
function parseQualificationFrozenProfileAttribute(entry: unknown): QualificationFrozenProfileAttribute {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Qualification frozen applicability mapping is malformed: profile attribute.');
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.attributeId !== 'string' || (e.cardinality !== 'single' && e.cardinality !== 'multiple')) {
    throw new Error('Qualification frozen applicability mapping is malformed: profile attribute shape.');
  }
  const conditions = e.applicabilityConditions ?? [];
  if (!Array.isArray(conditions)) {
    throw new Error('Qualification frozen applicability mapping is malformed: applicabilityConditions.');
  }
  return {
    attributeId: e.attributeId,
    cardinality: e.cardinality,
    required: e.required === true,
    applicabilityConditions: conditions,
  };
}

/** Legacy type→targets sidecar (read-only compat, never satisfies the REAL mapping). */
function readQualificationLegacyTypeProfiles(sidecar: {
  typeProfiles?: unknown;
  typeAttributeMap?: unknown;
}): Record<string, string[]> | null {
  return normalizeTypeProfilesRecord(sidecar.typeProfiles ?? sidecar.typeAttributeMap);
}

/** Normalize a typeId → targetIds record sidecar (null when absent). */
function normalizeTypeProfilesRecord(value: unknown): Record<string, string[]> | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Qualification type-profile sidecar is malformed.');
  }
  const out: Record<string, string[]> = {};
  for (const [typeId, targets] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(targets) || !targets.every(t => typeof t === 'string')) {
      throw new Error('Qualification type-profile sidecar is malformed.');
    }
    out[typeId] = [...new Set(targets as string[])].sort();
  }
  return out;
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

/**
 * Production Product-Type authority for Category Pages (issue #302, parity
 * with `checkProductTypeAuthority` in `page-decision.ts`): page proposals
 * require a reviewed/effective Primary Product Type whenever product_type is
 * an enabled target. Qualification always enables the PT target (frozen
 * taxonomy), so a null effective type (abstained/unknown) MUST abstain pages
 * — never construct a page Choice. Production code/reason, quoted verbatim:
 * `no_reviewed_product_type` /
 * 'No reviewed Primary Product Type. Page assignment requires an accepted
 * Product Type and a verified Page catalog.'
 */
export const QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_CODE = 'no_reviewed_product_type' as const;
export const QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_REASON =
  'No reviewed Primary Product Type. Page assignment requires an accepted Product Type and a verified Page catalog.' as const;

/** True when pages must abstain for a missing effective type (production parity). */
function isQualificationPageAbstainedForMissingType(effectiveTypeId: string | null): boolean {
  return effectiveTypeId === null;
}

/** Universal attribute ids for a taxonomy (explicit list ∪ per-target flags, sorted). */
function qualificationUniversalIds(taxonomies: QualificationTaxonomies): string[] {
  const set = new Set<string>(taxonomies.universalAttributeIds ?? []);
  for (const t of taxonomies.attributeTargets) {
    if (t.isUniversal === true) set.add(t.targetId);
  }
  return [...set].sort();
}

/** True when the REAL frozen applicability mapping is present (profiles + type pointers). */
function hasQualificationApplicabilityMapping(taxonomies: QualificationTaxonomies): boolean {
  return (
    taxonomies.attributeProfiles !== null &&
    taxonomies.attributeProfiles !== undefined &&
    taxonomies.typeAttributeProfiles !== null &&
    taxonomies.typeAttributeProfiles !== undefined
  );
}

/** Frozen profile for an effective type (null = legitimately EMPTY profile, universal-only). */
function qualificationProfileForType(
  taxonomies: QualificationTaxonomies,
  effectiveTypeId: string,
): { profileId: string | null; profile: QualificationFrozenAttributeProfile | null } {
  const pointer = taxonomies.typeAttributeProfiles?.[effectiveTypeId];
  if (pointer === undefined) {
    throw new Error(
      `${QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE}: effective type "${effectiveTypeId}" has no frozen profile pointer.`,
    );
  }
  if (pointer === null) return { profileId: null, profile: null };
  const profile = taxonomies.attributeProfiles?.find(p => p.id === pointer) ?? null;
  if (!profile) {
    throw new Error(
      `${QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE}: effective type "${effectiveTypeId}" declares profile "${pointer}" missing from the frozen snapshot.`,
    );
  }
  return { profileId: pointer, profile };
}

/** Stub ProductAttributeConfig for one frozen target (carries the universal flag for the shipped helper). */
function qualificationAttributeStub(
  target: QualificationTaxonomies['attributeTargets'][number],
  universalIds: Set<string>,
): ProductAttributeConfig {
  const stub = stubAttributeConfig(target.targetId, target.options);
  (stub as { isUniversal?: boolean }).isUniversal =
    target.isUniversal === true || universalIds.has(target.targetId);
  return stub;
}

/**
 * Applicable attribute targets for a frozen effective Product Type — the
 * production replay rule (effective type → Attribute Profile → applicability
 * → invariants pipeline) via the SHIPPED `evaluateAttributeApplicability`
 * helper (never reimplemented).
 *
 * DELIBERATE metric impact (issue #302): replacing the legacy
 * all-attributes fallback NARROWS the predicted attribute pool to the
 * applicable set, so fixed-population precision/recall now penalize extra
 * proposals to inapplicable targets (false positives lower precision) and
 * uncovered applicable targets count as misses (lower recall/coverage).
 * Reported attribute precision/recall/F1 move DOWN vs the legacy inflated
 * numbers by design — the legacy numbers hid inapplicable extras.
 *
 * - Null effective type (abstained/unknown) yields UNIVERSALS only
 *   (production parity: universals proceed without a type; type-gated
 *   attributes stay `unknown` → withheld).
 * - Missing mapping (legacy snapshot without the REAL profile pool) throws
 *   with `qualification_applicability_unresolvable` — callers map it to a
 *   coded `blocked` side, never silently broaden to all frozen attributes.
 * - Unknown effective type / missing declared profile throws the same coded
 *   error (frozen snapshot inconsistency; never live-config fallback).
 * - Per-profile cardinality wins over the global target mode; profile-entry
 *   applicabilityConditions run against empty reviewed facts (no accepted
 *   facts in replay → conditional attributes stay `unknown` → withheld,
 *   production parity). Gold labels are NEVER consulted.
 */
/** Universals-only applicable set for a null effective type (production parity). */
function qualificationUniversalsOnly(
  taxonomies: QualificationTaxonomies,
  universalIds: Set<string>,
): QualificationTaxonomies['attributeTargets'] {
  const byTargetId = new Map(taxonomies.attributeTargets.map(t => [t.targetId, t]));
  return [...universalIds]
    .map(id => byTargetId.get(id))
    .filter((t): t is QualificationTaxonomies['attributeTargets'][number] => !!t)
    .sort((a, b) => a.targetId.localeCompare(b.targetId));
}

/** Profile lookup maps for one effective type (ids + conditions + cardinality). */
function qualificationProfileLookups(
  profile: QualificationFrozenAttributeProfile | null,
): {
  profileIds: Set<string>;
  conditionsById: Map<string, unknown[]>;
  cardinalityById: Map<string, 'single' | 'multiple'>;
} {
  return {
    profileIds: new Set((profile?.attributes ?? []).map(a => a.attributeId)),
    conditionsById: new Map((profile?.attributes ?? []).map(a => [a.attributeId, a.applicabilityConditions ?? []])),
    cardinalityById: new Map((profile?.attributes ?? []).map(a => [a.attributeId, a.cardinality])),
  };
}

/** True for one target under the shipped applicability helper (production parity). */
function isQualificationTargetApplicable(
  target: QualificationTaxonomies['attributeTargets'][number],
  universalIds: Set<string>,
  profile: QualificationFrozenAttributeProfile | null,
  profileIds: Set<string>,
  conditionsById: Map<string, unknown[]>,
  effectiveTypeId: string,
): boolean {
  const attribute = qualificationAttributeStub(target, universalIds);
  return evaluateAttributeApplicability({
    attribute,
    profileAttributeIds: profile ? profileIds : new Set<string>(),
    conditions: conditionsById.get(target.targetId) ?? [],
    acceptedTypeId: effectiveTypeId,
    typeTargetEnabled: true,
    reviewedFacts: [],
    widenedUniversal: false,
  }).state === 'applicable';
}

/** Applicable set for a non-null effective type (profile-gated, cardinality-adjusted). */
function qualificationApplicableForType(
  taxonomies: QualificationTaxonomies,
  universalIds: Set<string>,
  effectiveTypeId: string,
): QualificationTaxonomies['attributeTargets'] {
  const { profile } = qualificationProfileForType(taxonomies, effectiveTypeId);
  const { profileIds, conditionsById, cardinalityById } = qualificationProfileLookups(profile);
  const applicable: QualificationTaxonomies['attributeTargets'][number][] = [];
  for (const target of taxonomies.attributeTargets) {
    if (!isQualificationTargetApplicable(target, universalIds, profile, profileIds, conditionsById, effectiveTypeId)) {
      continue;
    }
    const profileCardinality = cardinalityById.get(target.targetId);
    applicable.push(
      profileCardinality && profileCardinality !== target.cardinality
        ? { ...target, cardinality: profileCardinality }
        : target,
    );
  }
  return applicable.sort((a, b) => a.targetId.localeCompare(b.targetId));
}

function applicableQualificationAttributeTargets(
  taxonomies: QualificationTaxonomies,
  effectiveTypeId: string | null,
): QualificationTaxonomies['attributeTargets'] {
  if (!hasQualificationApplicabilityMapping(taxonomies)) {
    throw new Error(
      `${QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE}: frozen applicability mapping absent; refusing to broaden to all frozen attributes.`,
    );
  }
  const universalIds = new Set(qualificationUniversalIds(taxonomies));
  if (effectiveTypeId === null) return qualificationUniversalsOnly(taxonomies, universalIds);
  return qualificationApplicableForType(taxonomies, universalIds, effectiveTypeId);
}

/**
 * Deterministic invariant field assignments for a frozen effective type
 * (production parity with `resolveProductTypeInvariants`: zero model calls,
 * excluded from the variable loop / Jev questions). Returns sorted
 * assignments for invariant targets that are APPLICABLE (in-profile or
 * universal); invariants for inapplicable targets are skipped (frozen
 * inconsistency is surfaced by applicability, never silently proposed).
 * Null effective type yields none. Gold labels are NEVER consulted.
 */
/** One invariant entry as a field assignment (null when empty/unusable). */
function qualificationInvariantAssignment(
  targetId: string,
  raw: string | string[],
  cardinality: 'single' | 'multiple' | undefined,
): { targetId: string; value?: string; values?: string[] } | null {
  if (Array.isArray(raw)) {
    const values = [...new Set(raw.map(String))].sort().filter(v => v.length > 0);
    return values.length > 0 ? { targetId, values } : null;
  }
  const value = String(raw);
  if (value.length === 0) return null;
  return cardinality === 'multiple' ? { targetId, values: [value] } : { targetId, value };
}

function qualificationInvariantFieldAssignments(
  taxonomies: QualificationTaxonomies,
  effectiveTypeId: string | null,
  applicableTargets: QualificationTaxonomies['attributeTargets'],
): Array<{ targetId: string; value?: string; values?: string[] }> {
  if (effectiveTypeId === null) return [];
  const invariants = taxonomies.invariantAttributesByType?.[effectiveTypeId];
  if (!invariants) return [];
  const applicableIds = new Set(applicableTargets.map(t => t.targetId));
  const cardinalityById = new Map(applicableTargets.map(t => [t.targetId, t.cardinality]));
  const out: Array<{ targetId: string; value?: string; values?: string[] }> = [];
  for (const [targetId, raw] of Object.entries(invariants)) {
    if (!applicableIds.has(targetId)) continue;
    const assignment = qualificationInvariantAssignment(targetId, raw, cardinalityById.get(targetId));
    if (assignment) out.push(assignment);
  }
  return out.sort((a, b) => a.targetId.localeCompare(b.targetId));
}

/**
 * Split applicable targets into invariants + variable sets (production
 * parity: invariants resolve first, excluded from matchers/Jev). Shared by
 * the deterministic and live baseline legs so the split cannot drift.
 */
function splitQualificationApplicableAndInvariants(
  taxa: QualificationTaxonomies,
  effectiveTypeId: string | null,
  applicable: QualificationTaxonomies['attributeTargets'],
): {
  invariants: Array<{ targetId: string; value?: string; values?: string[] }>;
  variableApplicable: QualificationTaxonomies['attributeTargets'];
} {
  const invariants = qualificationInvariantFieldAssignments(taxa, effectiveTypeId, applicable);
  const invariantIds = new Set(invariants.map(f => f.targetId));
  return { invariants, variableApplicable: applicable.filter(t => !invariantIds.has(t.targetId)) };
}

/**
 * Applicable target ids for scoring/reporting (exported for the evaluator
 * workstream): the same REAL mapping as prediction (never gold). Throws the
 * coded unresolvable error when the mapping is absent — scoring callers fall
 * back to their legacy pool only when they explicitly opt out of the frozen
 * contract (documented weaker separation).
 */
export function qualificationApplicableTargetIds(
  taxonomies: QualificationTaxonomies,
  effectiveTypeId: string | null,
): string[] {
  return applicableQualificationAttributeTargets(taxonomies, effectiveTypeId).map(t => t.targetId);
}

/**
 * Rich product name for Jev state (mirrors production's first-wins name slot:
 * first evidence snippet, else the SKU fallback). Never a gold label.
 */
function qualificationProductName(entry: QualificationGoldOnlyEntry): string {
  const first = entry.evidence.map(ev => ev.snippet ?? '').find(s => s.trim().length > 0);
  return first?.slice(0, 200) ?? entry.sku;
}

/** Rich Jev state for the product-type phase (mirrors BoundedProductTypeState). */
function buildQualificationTypeState(entry: QualificationGoldOnlyEntry): {
  sku: string;
  name: string;
  brand: string | null;
  description: string | null;
  snippets: string[];
  attributes: Record<string, unknown>;
  evidenceCount: number;
} {
  const snippets = entry.evidence.map(ev => ev.snippet ?? '').filter(s => s.length > 0).slice(0, 15);
  const name = qualificationProductName(entry);
  const description = snippets.length > 1 ? snippets.slice(1).join(' ').slice(0, 4000) : null;
  return {
    sku: entry.sku,
    name: name || entry.sku,
    brand: null,
    description,
    snippets,
    attributes: {},
    evidenceCount: entry.evidence.length,
  };
}

/**
 * Rich Jev state for attribute/page phases (mirrors BoundedAttributeState):
 * name + brand + the FROZEN resolved productType (never run alongside type
 * resolution — callers resolve PT first, freeze the effective type, then build
 * this state). Includes target-permitted evidence text (all frozen evidence is
 * permitted — the frozen taxonomy carries no visual-eligibility policy) plus
 * the joined evidence text production grounds on.
 */
function buildQualificationAttributeState(
  entry: QualificationGoldOnlyEntry,
  effectiveTypeId: string | null,
): {
  sku: string;
  name: string;
  brand: string | null;
  productType: string | null;
  evidenceCount: number;
  evidenceText: string;
  snippets: string[];
} {
  const snippets = entry.evidence.map(ev => ev.snippet ?? '').filter(s => s.length > 0).slice(0, 15);
  return {
    sku: entry.sku,
    name: qualificationProductName(entry) || entry.sku,
    brand: null,
    productType: effectiveTypeId,
    evidenceCount: entry.evidence.length,
    evidenceText: snippets.slice(0, 15).join('; ').slice(0, 4000),
    snippets,
  };
}

/**
 * Source labels that are NOT in the permitted evidence schema, normalized to
 * the explicit public official source they are (never relabeled as a page,
 * never a credibility boost — reliability rides through unchanged):
 * - `official_page` (legacy label) → `official_product_page`.
 * - `official_structured_catalog` (approved public manufacturer catalog
 *   data backing the representative bank) → `catalog_product`, the
 *   permitted explicit public official source. All other labels pass through
 *   untouched (out of scope for this seam — never silently rewritten).
 */
const QUALIFICATION_SOURCE_NORMALIZATION: Record<string, string> = {
  official_page: 'official_product_page',
  official_structured_catalog: 'catalog_product',
};

/**
 * Convert frozen gold evidence to production ClassificationEvidence for real
 * decision-boundary invocation (read-only usage). Exported so wiring tests
 * can prove source normalization + per-target isolation without credentials.
 * Source labels map through QUALIFICATION_SOURCE_NORMALIZATION; the first
 * snippet seeds the `title` slot (production's name slot), the rest seed
 * `description` (mirroring the bounded state builders' first-wins cascade).
 * Gold labels never enter the evidence.
 */
export function qualificationEvidenceForBoundary(
  entry: QualificationGoldOnlyEntry,
  runId: string,
): ClassificationEvidence[] {
  const now = new Date().toISOString();
  return entry.evidence.map((ev, i) => ({
    id: `qual-ev-${entry.sku}-${i}`,
    runId,
    stageName: 'evidence_extraction',
    productSku: entry.sku,
    attributeId: (ev as { attributeId?: string | null }).attributeId ?? null,
    source: QUALIFICATION_SOURCE_NORMALIZATION[ev.source] ?? ev.source,
    reliability: (ev.reliability ?? 'low') as ClassificationEvidence['reliability'],
    sourceUrl: null,
    sourceField: i === 0 ? 'title' : 'description',
    snippet: ev.snippet ?? '',
    value: ev.snippet ?? '',
    metadata: null,
    capturedAt: now,
  } as unknown as ClassificationEvidence));
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

/**
 * REAL attribute config + resolved target for one closed-world target
 * (exported for wiring tests): frozen bundle aliases, claim/composition
 * flags, and visual eligibility ride the attribute; the frozen catalog-field
 * mapping rides `config.catalogField` (production parity for grounding).
 * Without attached authority details this is exactly the stub (documented
 * weaker grounding) — never gold, never invented.
 */
export function resolveQualificationAttributeTarget(
  target: QualificationTaxonomies['attributeTargets'][number],
  taxonomies: QualificationTaxonomies,
): { attribute: ProductAttributeConfig; resolved: ResolvedTarget } {
  const details = taxonomies.frozenAuthorityDetails ?? null;
  const flag = details?.attributeConfigByTarget?.[target.targetId] ?? null;
  if (!flag
    && (details?.catalogFieldByTarget?.[target.targetId] ?? undefined) === undefined
    && (details?.attributeNameByTarget?.[target.targetId] ?? undefined) === undefined
    && (details?.targetLabelByTarget?.[target.targetId] ?? undefined) === undefined) {
    return stubAttributeTarget(target);
  }
  const name = details?.attributeNameByTarget?.[target.targetId] ?? target.targetId;
  const label = details?.targetLabelByTarget?.[target.targetId] ?? target.targetId;
  const description = details?.attributeDescriptionByTarget?.[target.targetId] ?? null;
  const attribute: ProductAttributeConfig = {
    ...stubAttributeConfig(target.targetId, target.options),
    name,
    description,
    valueAliases: (flag?.valueAliases ?? []).filter(
      a => typeof a.alias === 'string' && typeof a.mapsTo === 'string',
    ),
    visualEvidenceEligibility: flag?.visualEvidenceEligibility ?? 'eligible',
    isClaim: flag?.isClaim === true,
    isCompositionAttribute: flag?.isCompositionAttribute === true,
  };
  const base = stubResolvedTarget(
    `target_${target.targetId}`,
    label,
    'product_field',
    target.cardinality,
    target.targetId,
    target.options.map(v => ({ value: v, label: v })),
    attribute,
  );
  const resolved: ResolvedTarget = {
    ...base,
    config: {
      ...base.config,
      catalogField: details?.catalogFieldByTarget?.[target.targetId] ?? null,
    },
  };
  return { attribute, resolved };
}

/** Baseline product type: shipped deterministic keyword precedence + floor. */
function predictBaselineProductType(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
): QualificationProductTypePrediction {
  if (isQualificationPredictionEmpty(taxonomies.productTypes.length, evidenceText)) {
    return { productType: null, abstained: true, confidence: 0, abstentionCode: taxonomies.productTypes.length ? 'insufficient_evidence' : 'missing_configuration' };
  }
  const matches = matchKeywordOptions({
    options: qualificationQuestionTemplates(taxonomies).typeOptions,
    text: evidenceText,
    selectionMode: 'single',
  });
  const top = matches[0];
  if (!top || top.confidence < PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE) {
    return { productType: null, abstained: true, confidence: 0, abstentionCode: top ? 'low_probability' : 'unresolved' };
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
 * Entry-independent question-plan templates, memoized per taxonomies object
 * identity. The product-type Choice, resolved attribute targets, and
 * single-value Choice plans are pure functions of the frozen taxonomy —
 * identical inputs rebuild byte-identical plans per entry. Caching them
 * removes the per-entry object churn over the fixed 74-type / 212-page
 * pools. Page plans additionally key on the effective type (instructions
 * embed the type description; explicit null abstains per #302 parity).
 *
 * FREEZE CONTRACT: cached plans are shared across entries within one
 * capture. Consumers MUST treat them as immutable (all existing consumers —
 * floor wiring proof, live assembly, interpreters — read only). A fresh
 * taxonomies object (new capture, new test) misses the cache and rebuilds.
 */
interface QualificationQuestionTemplates {
  productTypePlan: ProductTypeChoiceQuestionPlan;
  resolvedByTarget: Map<string, ResolvedTarget>;
  choicePlanByTarget: Map<string, AttributeChoiceQuestionPlan>;
  pagePlanByType: Map<string | null, PageChoiceQuestionPlan | null>;
  /** Shared matcher option arrays (built once per taxonomy — callers must not mutate). */
  typeOptions: Array<{ value: string; label: string }>;
  pageOptions: Array<{ value: string; label: string }>;
}
const questionTemplateCache = new WeakMap<QualificationTaxonomies, QualificationQuestionTemplates>();

function qualificationQuestionTemplates(
  taxonomies: QualificationTaxonomies,
): QualificationQuestionTemplates {
  const cached = questionTemplateCache.get(taxonomies);
  if (cached) return cached;
  const typeOptions = taxonomies.productTypes.map(t => ({ value: t.id, label: t.label }));
  const templates: QualificationQuestionTemplates = {
    productTypePlan: buildProductTypeChoiceQuestion(
      taxonomies.productTypes.map(t => ({
        value: t.id,
        label: t.label,
        // REAL configured definitions ride the EXISTING optional criteria
        // slot (`label: description` suffix) — no builder/version change.
        // Absent on legacy snapshots ⇒ byte-identical questions.
        ...(typeof t.description === 'string' && t.description.length > 0 ? { description: t.description } : {}),
      })),
    ),
    resolvedByTarget: new Map(),
    choicePlanByTarget: new Map(),
    pagePlanByType: new Map(),
    typeOptions,
    pageOptions: taxonomies.pages.map(p => ({ value: p.pageId, label: p.pageName })),
  };
  questionTemplateCache.set(taxonomies, templates);
  return templates;
}

function templateCacheKey(
  target: QualificationTaxonomies['attributeTargets'][number],
): string {
  // Profile-adjusted cardinality varies per effective type and rides the
  // resolved config (selectionMode) — key on both so a type-adjusted copy
  // never serves another type's cardinality.
  return `${target.targetId}:${target.cardinality}`;
}

function templateResolvedTarget(
  templates: QualificationQuestionTemplates,
  target: QualificationTaxonomies['attributeTargets'][number],
  taxonomies: QualificationTaxonomies,
): ResolvedTarget {
  const key = templateCacheKey(target);
  const cached = templates.resolvedByTarget.get(key);
  if (cached) return cached;
  const { resolved } = resolveQualificationAttributeTarget(target, taxonomies);
  templates.resolvedByTarget.set(key, resolved);
  return resolved;
}

function templateChoicePlan(
  templates: QualificationQuestionTemplates,
  target: QualificationTaxonomies['attributeTargets'][number],
  resolved: ResolvedTarget,
): AttributeChoiceQuestionPlan {
  const key = templateCacheKey(target);
  const cached = templates.choicePlanByTarget.get(key);
  if (cached) return cached;
  const plan = buildAttributeChoiceQuestion(resolved);
  templates.choicePlanByTarget.set(key, plan);
  return plan;
}

function templatePagePlan(
  templates: QualificationQuestionTemplates,
  taxonomies: QualificationTaxonomies,
  effectiveTypeId: string | null | undefined,
): PageChoiceQuestionPlan | null {
  // PAGE ABSTENTION PARITY (issue #302): explicit null (no reviewed type)
  // abstains — never a constructed Choice. Empty page pool: null.
  if (taxonomies.pages.length === 0 || effectiveTypeId === null) return null;
  const key = effectiveTypeId ?? null;
  const cached = templates.pagePlanByType.get(key);
  if (cached !== undefined) return cached;
  const plan = buildPageChoiceQuestion(
    taxonomies.pages.map(p => ({ pageId: p.pageId, pageName: p.pageName, parentId: null, parentName: null, path: p.pageName })),
    effectiveTypeId ?? null,
  );
  templates.pagePlanByType.set(key, plan);
  return plan;
}

/**
 * Build every shipped Jev question for one gold entry (pure construction —
 * the same builders production dispatches). Exported so wiring/shape tests
 * can prove criteria/key parity without credentials or network. Throws on
 * malformed taxonomy input; callers map that to a coded `blocked` side
 * (fail-closed), never to a guessed judgment.
 *
 * Replay fidelity (no gold leakage): attribute plans cover the APPLICABLE
 * frozen attributes for `effectiveTypeId` (production: effective type →
 * profile → applicability → invariants, via the shipped helper), never the
 * gold-adjudicated targets. Invariant targets resolve deterministically and
 * are EXCLUDED from Jev questions (production parity — zero model calls).
 * When `effectiveTypeId` is omitted (wiring/shape proof without a resolved
 * type), all frozen attributes are built (gold-free, wiring-only — never
 * scoring). Page questions consume the frozen type (never run alongside type
 * resolution — live capture resolves PT first, then builds pages); an
 * explicit null type abstains pages exactly like production
 * (`no_reviewed_product_type`, never a constructed Choice).
 */
export function buildQualificationCandidateQuestionSet(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  effectiveTypeId?: string | null,
): QualificationCandidateQuestionSet {
  const templates = qualificationQuestionTemplates(taxonomies);
  const productTypePlan = templates.productTypePlan;
  // Pure-construction path has no resolved type yet: build all frozen
  // attributes (gold-free, wiring-only). Live capture passes the frozen
  // resolved type to narrow to applicable attributes only (fail-closed when
  // the REAL mapping is absent — never gold).
  const applicable = effectiveTypeId === undefined
    ? [...taxonomies.attributeTargets]
    : applicableQualificationAttributeTargets(taxonomies, effectiveTypeId ?? null);
  const invariantIds = effectiveTypeId === undefined || effectiveTypeId === null
    ? new Set<string>()
    : new Set(
      qualificationInvariantFieldAssignments(
        taxonomies,
        effectiveTypeId,
        applicable,
      ).map(f => f.targetId),
    );
  const variableApplicable = applicable.filter(t => !invariantIds.has(t.targetId));
  const productContext = {
    name: qualificationProductName(entry),
    brand: null,
    productType: effectiveTypeId ?? null,
  };
  const attributePlans: QualificationCandidateAttributePlan[] = [];
  for (const target of variableApplicable) {
    // REAL frozen authority (aliases, claim/composition flags, catalog
    // field) rides the resolved target when attached — the shipped Noul
    // builders and the shipped multi-value policy consume it for
    // permission/grounding. Without details this is the stub (weaker
    // grounding, never gold).
    const resolved = templateResolvedTarget(templates, target, taxonomies);
    if (target.cardinality === 'multiple') {
      attributePlans.push({
        targetId: target.targetId,
        cardinality: target.cardinality,
        resolved,
        noulPlans: buildAttributeNoulQuestions(resolved, entry.sku, productContext),
      });
    } else {
      attributePlans.push({
        targetId: target.targetId,
        cardinality: target.cardinality,
        resolved,
        choicePlan: templateChoicePlan(templates, target, resolved),
      });
    }
  }
  // PAGE ABSTENTION PARITY (issue #302): an explicit null effective type
  // (no reviewed/effective Product Type) abstains pages exactly like
  // production (`no_reviewed_product_type`) — never a constructed Choice.
  // The wiring-proof path (undefined, no resolved type yet) still builds the
  // Choice for shape coverage; live capture always passes an explicit type.
  const pagePlan = templatePagePlan(templates, taxonomies, effectiveTypeId);
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

/**
 * Deterministic-floor side: the real matcher ran, no model was consulted.
 * Matcher silence carries NO semantic-abstention proof (page/field outcomes
 * stay absent/unresolved) — an empty floor set can never credit no-fit /
 * insufficient-evidence gold.
 */
function floorQualificationPrediction(input: {
  productType: string | null;
  abstained: boolean;
  abstentionCode?: string | null;
  fieldAssignments: Array<QualificationFieldAssignment>;
  pageIds: string[];
  pageOutcome?: QualificationFieldOutcome | null;
  pageAbstentionCode?: string | null;
  pageProbability?: number | null;
  confidence: number;
  latencyMs: number;
}): ExecutedQualificationPrediction {
  return {
    pageOutcome: null,
    pageAbstentionCode: null,
    pageProbability: null,
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

/**
 * Baseline attributes: shipped word-boundary alias/direct matching only, over
 * the APPLICABLE frozen attributes for the frozen effective type (never gold).
 * Callers resolve Product Type first and pass the applicable subset.
 */
function predictBaselineAttributes(
  applicableTargets: QualificationTaxonomies['attributeTargets'],
  evidenceText: string,
): Array<{ targetId: string; value?: string; values?: string[] }> {
  const out: Array<{ targetId: string; value?: string; values?: string[] }> = [];
  for (const target of applicableTargets) {
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
 * Single-value attribute from a live Choice answer (ALWAYS returns raw-outcome
 * metadata: explicit no-match/insufficient_evidence selections become
 * `abstained-semantic` proof with the code + probability; below-floor values
 * and refusals become `unresolved` — never abstention credit).
 */
function interpretLiveChoiceAttribute(
  plan: QualificationCandidateAttributePlan,
  answers: Record<string, SystemOneAnswer>,
): QualificationFieldAssignment | null {
  if (!plan.choicePlan) return null;
  const answer = requireChoiceAnswer(answers, plan.choicePlan.questionId);
  const choiceKey = answer.choice;
  const prob = answer.probabilities[choiceKey] ?? 0;
  if (choiceKey === JEV_NO_MATCH_KEY || choiceKey === JEV_INSUFFICIENT_EVIDENCE_KEY) {
    return { targetId: plan.targetId, outcome: 'abstained-semantic', abstentionCode: choiceKey, probability: prob };
  }
  const canonicalValue = choiceKeyToCanonicalId(plan.choicePlan.keyToIdMap, choiceKey, 'option value');
  if (prob < JEV_ATTRIBUTE_MIN_PROBABILITY) {
    return { targetId: plan.targetId, outcome: 'unresolved', abstentionCode: 'low_probability', probability: prob };
  }
  return { targetId: plan.targetId, value: canonicalValue, outcome: 'predicted', probability: prob };
}

/**
 * Multi-value attribute from live Noul answers (ALWAYS returns raw-outcome
 * metadata: Noul carries no explicit no-match/insufficient_evidence proof, so
 * an unresolved policy outcome is `unresolved` — it can never credit no-fit /
 * insufficient-evidence gold rather than inventing a code).
 *
 * Permission/grounding parity: the ACTUAL frozen target-permitted evidence
 * packet and the frozen catalog-field mapping ride the shipped policy (never
 * blank dummies, never disabled guards) — multi-hit selections keep their
 * per-value P(yes) proof + digest even when evidence permission is thin.
 */
function interpretLiveNoulAttributes(
  plan: QualificationCandidateAttributePlan,
  answers: Record<string, SystemOneAnswer>,
  permittedEvidence: ClassificationEvidence[],
): QualificationFieldAssignment | null {
  const candidates = (plan.noulPlans ?? []).map(p => ({
    optionValue: p.optionValue,
    optionLabel: p.optionLabel,
    optionIndex: p.optionIndex,
    prob: requireNoulAnswer(answers, p.questionId).noul,
  }));
  const { candidateProbabilities, probabilityDigest } = hashNoulCandidateProbabilities(candidates);
  const outcome = evaluateMultiValueSelectionPolicy({
    target: plan.resolved,
    candidates,
    permittedEvidence,
    catalogField: plan.resolved.config.catalogField ?? null,
  });
  if (outcome.outcome !== 'resolved') {
    return {
      targetId: plan.targetId,
      outcome: 'unresolved',
      abstentionCode: outcome.abstentionCode ?? 'unresolved',
      probability: null,
      candidateProbabilities,
      probabilityDigest,
    };
  }
  const selectedProbs = candidates
    .filter(c => outcome.selectedValues.includes(c.optionValue))
    .map(c => c.prob);
  return {
    targetId: plan.targetId,
    values: outcome.selectedValues,
    outcome: 'predicted',
    probability: selectedProbs.length > 0 ? Math.min(...selectedProbs) : null,
    candidateProbabilities,
    probabilityDigest,
  };
}

/**
 * Candidate attributes from LIVE Jev answers: every plan yields its raw-outcome
 * metadata (predicted values flow to value/values; abstentions and unresolved
 * targets ride as value-less entries so scoring sees the proof, never an
 * empty set to misread as semantic abstention).
 */
function interpretLiveCandidateAttributes(
  plans: QualificationCandidateAttributePlan[],
  answers: Record<string, SystemOneAnswer>,
  evidence: ClassificationEvidence[],
): Array<QualificationFieldAssignment> {
  const out: Array<QualificationFieldAssignment> = [];
  for (const plan of plans) {
    const interpreted = plan.choicePlan
      ? interpretLiveChoiceAttribute(plan, answers)
      : interpretLiveNoulAttributes(
        plan,
        answers,
        permittedEvidenceForQualificationTarget(evidence, plan.resolved.attribute, plan.targetId),
      );
    if (interpreted) out.push(interpreted);
  }
  return out.sort((a, b) => a.targetId.localeCompare(b.targetId));
}

/**
 * Baseline pages: shipped deterministic keyword matching + floor, gated by
 * Product-Type authority (production parity): a null effective type abstains
 * (`no_reviewed_product_type`) — never a matcher guess. Callers pass the
 * FROZEN effective type (null when the PT stage abstained). Matcher silence
 * is `unresolved` (no semantic proof); only the missing-type abstention is
 * coded (it still never credits page gold — pages have no no-fit state).
 */
function predictBaselinePages(
  entry: QualificationGoldOnlyEntry,
  taxonomies: QualificationTaxonomies,
  evidenceText: string,
  effectiveTypeId: string | null,
): QualificationPageOutcome {
  if (isQualificationPageAbstainedForMissingType(effectiveTypeId)) {
    return { pageIds: [], pageOutcome: 'abstained-semantic', pageAbstentionCode: QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_CODE, pageProbability: null };
  }
  if (isQualificationPredictionEmpty(taxonomies.pages.length, evidenceText)) {
    return { pageIds: [], pageOutcome: 'unresolved', pageAbstentionCode: 'unresolved', pageProbability: null };
  }
  const matches = matchKeywordOptions({
    options: qualificationQuestionTemplates(taxonomies).pageOptions,
    text: evidenceText,
    selectionMode: 'single',
  });
  const top = matches[0];
  if (!top || top.confidence < PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE) {
    return { pageIds: [], pageOutcome: 'unresolved', pageAbstentionCode: 'unresolved', pageProbability: top?.confidence ?? null };
  }
  return { pageIds: [top.value], pageOutcome: 'predicted', pageAbstentionCode: null, pageProbability: top.confidence };
}

/** Confidence for the artifact (abstained sides carry zero confidence). */
function artifactConfidence(abstained: boolean, confidence: number): number {
  return abstained ? 0 : Number(confidence.toFixed(4));
}

/**
 * Deterministic baseline stages for one entry (unlabeled — callers add the
 * source). PRODUCT-TYPE-FIRST replay: resolve Product Type first, freeze the
 * effective type, then evaluate applicability (effective type → profile →
 * applicable attributes, never gold) and run type-dependent attributes and
 * pages. Pages consume the resolved type (never run alongside it).
 */
function runDeterministicBaselineStages(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  evidenceText: string,
): {
  type: QualificationProductTypePrediction;
  effectiveTypeId: string | null;
  fields: Array<{ targetId: string; value?: string; values?: string[] }>;
  pages: QualificationPageOutcome;
} {
  const type = predictBaselineProductType(entry, taxa, evidenceText);
  const effectiveTypeId = type.abstained ? null : type.productType;
  // REAL applicability (fail-closed): throws with the coded unresolvable
  // reason when the frozen mapping is absent — callers map it to blocked.
  // Invariants resolve first (shared split helper), matcher runs on variables.
  const applicable = applicableQualificationAttributeTargets(taxa, effectiveTypeId);
  const { invariants, variableApplicable } = splitQualificationApplicableAndInvariants(taxa, effectiveTypeId, applicable);
  const matched = predictBaselineAttributes(variableApplicable, evidenceText);
  const fields = [...invariants, ...matched].sort((a, b) => a.targetId.localeCompare(b.targetId));
  return {
    type,
    effectiveTypeId,
    fields,
    pages: predictBaselinePages(entry, taxa, evidenceText, effectiveTypeId),
  };
}

/** True for the coded applicability-unresolvable throw (fail-closed, never broadened). */
function isApplicabilityUnresolvableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith(QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE);
}

/** Map an applicability throw to its coded blocked side (fail-closed). */
function blockForApplicabilityError(latencyMs: number): ExecutedQualificationPrediction {
  return {
    ...blockedQualificationPrediction(
      QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE,
      'Frozen Product Type → profile → attribute mapping is absent/unresolvable for this entry; refusing to broaden to all frozen attributes.',
    ),
    latencyMs,
  };
}

/** Execute the deterministic baseline + blocked candidate for one gold entry. */
function executeDeterministicFloorEntryPredictions(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
): { sku: string; baseline: ExecutedQualificationPrediction; candidate: ExecutedQualificationPrediction } {
  const evidenceText = qualificationEvidenceText(entry);
  const started = Date.now();
  const latency = (): number => Math.max(0, Date.now() - started);
  try {
    const stages = runDeterministicBaselineStages(entry, taxa, evidenceText);
    const baseline = floorQualificationPrediction({
      productType: stages.type.productType,
      abstained: stages.type.abstained,
      abstentionCode: stages.type.abstentionCode ?? null,
      fieldAssignments: stages.fields,
      pageIds: stages.pages.pageIds,
      pageOutcome: stages.pages.pageOutcome,
      pageAbstentionCode: stages.pages.pageAbstentionCode,
      pageProbability: stages.pages.pageProbability,
      confidence: artifactConfidence(stages.type.abstained, stages.type.confidence),
      latencyMs: latency(),
    });
    return { sku: entry.sku, baseline, candidate: blockedCandidateWithoutCredentials(entry, taxa) };
  } catch (err) {
    if (isApplicabilityUnresolvableError(err)) {
      return { sku: entry.sku, baseline: blockForApplicabilityError(latency()), candidate: blockedCandidateWithoutCredentials(entry, taxa) };
    }
    throw err;
  }
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
  /** Explicit existing-store reference: api_keys:<provider> or provider_connections:<id>. */
  credentialRef?: string | null;
  isolatedStore?: string | null;
}

export interface QualificationLiveCaptureOptions {
  jev?: QualificationJevLiveCredentials | null;
  baselineRoute?: QualificationBaselineLiveRoute | null;
  /** Separate incumbent-leg budget, consumed at every real request including JSON repair. */
  baselineAttemptBudget?: SystemOneAttemptBudget | null;
  baselineDeadlineSignal?: AbortSignal | null;
  /**
   * Candidate-leg per-HTTP-attempt budget, enforced inside the real request
   * path (before every dispatch + retry). Null/absent means the candidate
   * live leg cannot run under a bound guard (callers fail closed upstream).
   */
  attemptBudget?: SystemOneAttemptBudget | null;
  /** Candidate-leg hard-deadline signal (abort/cancellation propagates, never retries). */
  deadlineSignal?: AbortSignal | null;
}

interface ResolvedJevLiveTarget {
  conn: ProviderConnection;
  model: string;
  timeoutMs?: number;
  attemptBudget?: SystemOneAttemptBudget | null;
  deadlineSignal?: AbortSignal | null;
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
 * Frozen-evidence Jev state for one gold entry: RICH production-equivalent
 * state (name, brand, productType, target-permitted evidence + evidence text),
 * never the legacy thin `{sku, snippets, evidenceCount}`. Gold labels never
 * enter the state — the model judges from evidence alone. Product-type phase
 * uses the type state (no resolved type yet); attribute/page phases use the
 * attribute state built AFTER freezing the resolved effective type.
 */

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
/** Dispatch options for one candidate chunk: bound guard + deadline ride the real request path. */
function candidateDispatchOptions(target: ResolvedJevLiveTarget): { timeoutMs?: number; signal?: AbortSignal; attemptBudget?: SystemOneAttemptBudget } {
  return {
    ...(target.timeoutMs !== undefined ? { timeoutMs: target.timeoutMs } : {}),
    ...(target.deadlineSignal ? { signal: target.deadlineSignal } : {}),
    ...(target.attemptBudget ? { attemptBudget: target.attemptBudget } : {}),
  };
}

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
      candidateDispatchOptions(target),
    );
    merged = { ...(merged ?? {}), ...result.answers };
    requestedModel = result.requestedModel;
    if (offset === 0) resolvedModel = result.returnedModel;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
  }
  return { answers: merged ?? {}, requestedModel, resolvedModel, inputTokens, outputTokens };
}

/** Live candidate product-type stage (typeOverLimit abstains the type stage only). */
function resolveLiveCandidateProductType(
  questions: QualificationCandidateQuestionSet,
  answers: Record<string, SystemOneAnswer>,
  typeOverLimit: boolean,
): {
  productType: string | null;
  abstained: boolean;
  typeProb: number;
  abstentionCode?: string | null;
  /** True when the typed answer actually carried the selected P (else unknown, never 0). */
  typeProbAvailable: boolean;
  typeCandidateProbabilities?: Record<string, number> | null;
  typeProbabilityDigest?: string | null;
} {
  if (typeOverLimit) return { productType: null, abstained: true, typeProb: 0, abstentionCode: 'candidate_limit_exceeded', typeProbAvailable: false };
  const answer = requireChoiceAnswer(answers, questions.productTypePlan.questionId);
  // Full canonical Choice set retained from the ACTUAL typed answer (never
  // renormalized); unknown when the answer carries no usable distribution.
  const rawProbs: unknown = answer.probabilities;
  const hasDistribution = !!rawProbs && typeof rawProbs === 'object' && Object.keys(rawProbs).length > 0;
  const retained = hasDistribution
    ? hashNoulCandidateProbabilities(
      Object.entries(rawProbs as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
        .map(([choiceKey, prob]) => ({
          optionValue: questions.productTypePlan.keyToIdMap.get(choiceKey) ?? choiceKey,
          prob,
        })),
    )
    : { candidateProbabilities: null as Record<string, number> | null, probabilityDigest: null as string | null };
  const choiceKey = answer.choice;
  const rawSelected: unknown = answer.probabilities[choiceKey];
  const typeProb = typeof rawSelected === 'number' ? rawSelected : 0;
  const typeProbAvailable = typeof rawSelected === 'number';
  if (choiceKey === JEV_NO_MATCH_KEY || choiceKey === JEV_INSUFFICIENT_EVIDENCE_KEY) {
    return { productType: null, abstained: true, typeProb, typeProbAvailable, abstentionCode: choiceKey, typeCandidateProbabilities: retained.candidateProbabilities, typeProbabilityDigest: retained.probabilityDigest };
  }
  const canonicalId = choiceKeyToCanonicalId(questions.productTypePlan.keyToIdMap, choiceKey, 'option ID');
  if (typeProb < JEV_PRODUCT_TYPE_MIN_PROBABILITY) {
    return { productType: null, abstained: true, typeProb, typeProbAvailable, abstentionCode: 'low_probability', typeCandidateProbabilities: retained.candidateProbabilities, typeProbabilityDigest: retained.probabilityDigest };
  }
  return { productType: canonicalId, abstained: false, typeProb, typeProbAvailable, typeCandidateProbabilities: retained.candidateProbabilities, typeProbabilityDigest: retained.probabilityDigest };
}

/** Raw page outcome proof from the live candidate page stage (never just an empty set). */
export interface QualificationPageOutcome {
  pageIds: string[];
  pageOutcome: QualificationFieldOutcome;
  pageAbstentionCode: string | null;
  pageProbability: number | null;
}

/** Live candidate page stage (single-choice page plan) with raw-outcome proof. */
function resolveLiveCandidatePages(
  questions: QualificationCandidateQuestionSet,
  answers: Record<string, SystemOneAnswer>,
): QualificationPageOutcome {
  if (!questions.pagePlan) {
    return { pageIds: [], pageOutcome: 'abstained-semantic', pageAbstentionCode: QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_CODE, pageProbability: null };
  }
  const answer = requireChoiceAnswer(answers, questions.pagePlan.questionId);
  const choiceKey = answer.choice;
  const pageProb = answer.probabilities[choiceKey] ?? 0;
  if (choiceKey === PAGE_NO_MATCH_CHOICE_KEY || choiceKey === PAGE_INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
    return { pageIds: [], pageOutcome: 'abstained-semantic', pageAbstentionCode: choiceKey, pageProbability: pageProb };
  }
  const pageId = choiceKeyToCanonicalId(questions.pagePlan.keyToIdMap, choiceKey, 'option ID');
  if (pageProb < JEV_PAGE_SINGLE_THRESHOLD) {
    return { pageIds: [], pageOutcome: 'unresolved', pageAbstentionCode: 'low_probability', pageProbability: pageProb };
  }
  return { pageIds: [pageId], pageOutcome: 'predicted', pageAbstentionCode: null, pageProbability: pageProb };
}

/** Type-phase transport records (empty when the closed world exceeds Choice capacity). */
function buildCandidateTypeRecords(
  typeQuestions: QualificationCandidateQuestionSet,
  typeOverLimit: boolean,
): Array<{ questionId: string; question: QualificationLiveQuestion }> {
  if (typeOverLimit) return [];
  return [{
    questionId: typeQuestions.productTypePlan.questionId,
    question: {
      type: 'choice' as const,
      instructions: typeQuestions.productTypePlan.instructions,
      criteria: typeQuestions.productTypePlan.criteria,
    },
  }];
}

/** Placeholder merged answers when the type stage abstains over-limit (no dispatch). */
function buildCandidateOverLimitPlaceholder(target: ResolvedJevLiveTarget): MergedLiveAnswers {
  return {
    answers: {},
    requestedModel: target.model,
    resolvedModel: target.model,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Phase-1 type judgment: dispatch unless over-limit (placeholder carries no usage). */
async function dispatchCandidateTypeMerged(
  target: ResolvedJevLiveTarget,
  typeRecords: Array<{ questionId: string; question: QualificationLiveQuestion }>,
  typeState: ReturnType<typeof buildQualificationTypeState>,
  typeOverLimit: boolean,
): Promise<MergedLiveAnswers> {
  if (typeOverLimit) return buildCandidateOverLimitPlaceholder(target);
  return dispatchCandidateLiveQuestions(target, typeRecords, typeState);
}

/** Frozen effective type id (null when the type stage abstained). */
function resolveCandidateEffectiveTypeId(
  type: { productType: string | null; abstained: boolean },
): string | null {
  return type.abstained ? null : type.productType;
}

/** Merge phase-1 and phase-2 answers (identity follows the attribute leg). */
function mergeCandidateLiveAnswers(
  typeMerged: MergedLiveAnswers,
  attrMerged: MergedLiveAnswers,
): MergedLiveAnswers {
  return {
    answers: { ...typeMerged.answers, ...attrMerged.answers },
    requestedModel: typeMerged.requestedModel,
    resolvedModel: attrMerged.resolvedModel ?? typeMerged.resolvedModel,
    inputTokens: typeMerged.inputTokens + attrMerged.inputTokens,
    outputTokens: typeMerged.outputTokens + attrMerged.outputTokens,
  };
}

/** True when no model spoke (fail-closed: never live_captured without identity + usage). */
function isCandidateJudgmentSilent(merged: MergedLiveAnswers, typeOverLimit: boolean): boolean {
  if (!merged.resolvedModel) return true;
  return merged.inputTokens === 0 && merged.outputTokens === 0 && !typeOverLimit;
}

/** Blocked side for a silent live path (same coded reason as the inline branch). */
function buildCandidateSilentBlocked(latencyMs: number): ExecutedQualificationPrediction {
  return {
    ...blockedQualificationPrediction(
      QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED,
      'Candidate live path executed but no model judgment spoke (missing resolvedModel/usage).',
    ),
    latencyMs,
  };
}

/** Live-captured side from a speaking model (same shape as the inline return). */
function buildCandidateLiveCaptured(
  type: { productType: string | null; abstained: boolean; typeProb: number; typeProbAvailable: boolean; abstentionCode?: string | null; typeCandidateProbabilities?: Record<string, number> | null; typeProbabilityDigest?: string | null },
  fieldAssignments: Array<QualificationFieldAssignment>,
  pages: QualificationPageOutcome,
  merged: MergedLiveAnswers,
  latencyMs: number,
): ExecutedQualificationPrediction {
  return {
    productType: type.productType,
    abstained: type.abstained,
    abstentionCode: type.abstentionCode ?? null,
    fieldAssignments,
    pageIds: pages.pageIds,
    pageOutcome: pages.pageOutcome,
    pageAbstentionCode: pages.pageAbstentionCode,
    pageProbability: pages.pageProbability,
    // REAL selected-outcome P persisted (predicted AND semantic abstentions);
    // unknown stays unknown — never P=0, never renormalized, never faked.
    typeProbability: type.typeProbAvailable ? type.typeProb : null,
    typeCandidateProbabilities: type.typeCandidateProbabilities ?? null,
    typeProbabilityDigest: type.typeProbabilityDigest ?? null,
    confidence: artifactConfidence(type.abstained, type.typeProb),
    latencyMs,
    source: QUALIFICATION_SOURCE_LIVE_CAPTURED,
    blockedCode: null,
    blockedDetail: null,
    failureCode: null,
    requestedModel: merged.requestedModel,
    resolvedModel: merged.resolvedModel,
    provider: 'typesafe',
    usage: { inputTokens: merged.inputTokens, outputTokens: merged.outputTokens },
  };
}

/**
 * Capture one entry's candidate side from LIVE Jev judgments: shipped
 * question builders → shipped transport → shipped extraction/mapping →
 * shipped floors + shipped multi-value policy. Any dispatch/validation
 * failure blocks the side with a coded reason (never a partial guess).
 *
 * PRODUCT-TYPE-FIRST replay (never parallel): resolve Product Type first with
 * the RICH type state, freeze the effective type, then build RICH attribute
 * state (name, brand, resolved productType, target-permitted evidence +
 * evidence text), evaluate applicability (effective type → profile → applicable
 * attributes, never gold), then capture type-dependent attributes and pages.
 * Page judgments consume the frozen resolved type.
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
    // Mirror production's candidate-limit abstention for product types: an
    // oversized closed world abstains the type stage (no first-N clipping)
    // while attributes/pages still capture from the live model.
    const typeOverLimit = taxa.productTypes.length > JEV_MAX_ORDINARY_CHOICE_CANDIDATES;
    // Phase 1 — Product Type first with the RICH type state.
    const typeQuestions = buildQualificationCandidateQuestionSet(entry, taxa);
    const typeRecords = buildCandidateTypeRecords(typeQuestions, typeOverLimit);
    const typeState = buildQualificationTypeState(entry);
    const typeMerged = await dispatchCandidateTypeMerged(target, typeRecords, typeState, typeOverLimit);
    const type = resolveLiveCandidateProductType(typeQuestions, typeMerged.answers, typeOverLimit);
    const effectiveTypeId = resolveCandidateEffectiveTypeId(type);
    // Phase 2 — freeze the effective type, then build RICH attribute state and
    // evaluate applicability (never gold). Pages consume the frozen type.
    const applicableQuestions = buildQualificationCandidateQuestionSet(entry, taxa, effectiveTypeId);
    const attrPageRecords = assembleCandidateLiveQuestions(applicableQuestions).filter(
      r => r.questionId !== typeQuestions.productTypePlan.questionId,
    );
    const attrState = buildQualificationAttributeState(entry, effectiveTypeId);
    const attrMerged = await dispatchCandidateLiveQuestions(target, attrPageRecords, attrState);
    const merged = mergeCandidateLiveAnswers(typeMerged, attrMerged);
    // `live_captured` guarantees a model spoke: without resolvedModel + usage
    // the side is an abstention/failure, never live_captured (fail-closed).
    if (isCandidateJudgmentSilent(merged, typeOverLimit)) {
      return buildCandidateSilentBlocked(Math.max(0, Date.now() - started));
    }
    // Frozen boundary evidence (actual parsed source clips, never gold):
    // per-target permitted packets + the frozen catalog-field mapping ride
    // the shipped multi-value policy below (never blank dummies, never
    // disabled guards). Deterministic run id — no DB, no new case.
    const boundaryEvidence = qualificationEvidenceForBoundary(entry, `qual-candidate-${entry.sku}`);
    const variableFields = interpretLiveCandidateAttributes(
      applicableQuestions.attributePlans,
      merged.answers,
      boundaryEvidence,
    );
    // Invariants merge deterministically (production parity — never via Jev).
    const applicableForInvariants = applicableQualificationAttributeTargets(taxa, effectiveTypeId);
    const invariants = qualificationInvariantFieldAssignments(taxa, effectiveTypeId, applicableForInvariants);
    const invariantIds = new Set(invariants.map(f => f.targetId));
    const fieldAssignments = [...invariants, ...variableFields.filter(f => !invariantIds.has(f.targetId))]
      .sort((a, b) => a.targetId.localeCompare(b.targetId));
    // Page abstention parity: null effective type yields no pages (the plan
    // is null above, so the resolver records the coded abstention — never a
    // constructed Choice and never a bare empty set).
    const pages = resolveLiveCandidatePages(applicableQuestions, merged.answers);

    return buildCandidateLiveCaptured(type, fieldAssignments, pages, merged, Math.max(0, Date.now() - started));
  } catch (err) {
    if (isApplicabilityUnresolvableError(err)) {
      return {
        ...blockedQualificationPrediction(
          QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE,
          'Frozen Product Type → profile → attribute mapping is absent/unresolvable for this entry; refusing to broaden.',
        ),
        latencyMs: Math.max(0, Date.now() - started),
      };
    }
    return fail(redactTransportText(err instanceof Error ? err.message : String(err)));
  }
}

// ─── Baseline live leg (incumbent: deterministic first, then chat ranker) ────

type BaselineChatOperation = 'product_type_ranking' | 'attribute_ranking' | 'page_assignment';

/** Stages whose deterministic matcher abstained (gold-free: applicability, never gold). */
interface BaselineLiveNeeds {
  type: boolean;
  attrs: string[];
  pages: boolean;
}

/**
 * Which baseline stages genuinely need a model judgment (mirrors incumbent
 * precedence). Attribute needs are the APPLICABLE frozen attributes for the
 * frozen effective type that the matcher left unresolved — never
 * gold-adjudicated targets. Page needs are attemptable + unresolved (gold
 * never gates whether a page judgment is attempted).
 */
function baselineLiveNeeds(
  taxa: QualificationTaxonomies,
  evidenceText: string,
  stages: ReturnType<typeof runDeterministicBaselineStages>,
): BaselineLiveNeeds {
  const typeAttemptable = !isQualificationPredictionEmpty(taxa.productTypes.length, evidenceText);
  const pagesAttemptable = !isQualificationPredictionEmpty(taxa.pages.length, evidenceText);
  const matchedAttrTargets = new Set(stages.fields.map(f => f.targetId));
  const applicable = applicableQualificationAttributeTargets(taxa, stages.effectiveTypeId);
  // PAGE ABSTENTION PARITY: a null effective type never attempts a live page
  // judgment (production `no_reviewed_product_type` abstains before dispatch).
  const pagesNeed = stages.effectiveTypeId === null
    ? false
    : pagesAttemptable && stages.pages.pageIds.length === 0;
  return {
    type: typeAttemptable && stages.type.abstained,
    attrs: applicable
      .filter(t => !matchedAttrTargets.has(t.targetId))
      .map(t => t.targetId),
    pages: pagesNeed,
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

/**
 * Ensure a workspace exists for ephemeral benchmark runs (read-only usage of
 * the workspace table — never mutates user workspaces beyond inserting a
 * clearly-labeled ephemeral row when none exists). Throws when no DB is
 * available — callers map that to a coded `blocked` side (fail-closed).
 */
function ensureQualificationWorkspaceId(): string {
  const db = getDb();
  const existing = db.query('SELECT id FROM workspace LIMIT 1').get() as { id: string } | undefined;
  if (existing?.id) return existing.id;
  const id = `qual-ephemeral-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Qualification Ephemeral', ?, '', ?, ?, 'complete')`,
    [id, `/tmp/${id}`, now, now],
  );
  return id;
}

/**
 * Minimal frozen runtime snapshot for ephemeral benchmark runs — just enough
 * for REAL decision-boundary invocation (`resolveProductTypeDecision` /
 * `resolveAttributeDecision` / audited ranker) with run-bound audit rows.
 * The plan + rule versions are built from the live policy view so
 * `assertModelPlanCompatible` passes; the snapshot hash binds the frozen
 * candidate pool (gold-free). Never reads live config — pure over the frozen
 * qualification taxonomies + policy view.
 */
function buildQualificationBaselineSnapshot(
  view: ModelPolicyView,
  taxa: QualificationTaxonomies,
): RuntimeClassificationSnapshot {
  const modelExecutionPlan = buildModelExecutionPlan(view);
  const runtimeRuleVersions = buildRuntimeRuleVersions();
  const snapshotHash = sha256Hex(JSON.stringify({
    productTypes: taxa.productTypes,
    attributeTargets: taxa.attributeTargets,
    pages: taxa.pages,
    typeProfiles: taxa.typeProfiles ?? null,
    typeAttributeProfiles: taxa.typeAttributeProfiles ?? null,
    attributeProfiles: taxa.attributeProfiles ?? null,
    universalAttributeIds: taxa.universalAttributeIds ?? null,
    invariantAttributesByType: taxa.invariantAttributesByType ?? null,
    policyDigest: view.policyDigest,
  }));
  return {
    schemaVersion: 2,
    snapshotHash,
    createdAt: new Date().toISOString(),
    workspaceId: 'qual-ephemeral',
    workspacePath: '/tmp/qual-ephemeral',
    productSku: '',
    configAuthorityKind: 'v2',
    sourceCatalogCommit: null,
    config: {} as RuntimeClassificationSnapshot['config'],
    configSnapshotRef: { hash: snapshotHash, sourceCommit: null, createdAt: new Date().toISOString() } as RuntimeClassificationSnapshot['configSnapshotRef'],
    focusedFileHashes: {},
    catalogEvidenceHash: null,
    productTypes: [],
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    guidance: [],
    brands: [],
    modelPolicy: {} as RuntimeClassificationSnapshot['modelPolicy'],
    dataSharing: {} as RuntimeClassificationSnapshot['dataSharing'],
    curationTargets: [],
    fieldOptions: {},
    reviewedFacts: [],
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    sourceProductHash: null,
    searchKeywords: null,
    productPageNames: [],
    pageImportId: null,
    pageImportHash: null,
    pageContextReliability: 'low',
    modelExecutionPlan,
    runtimeRuleVersions,
  } as unknown as RuntimeClassificationSnapshot;
}

/**
 * Attempt the real legacy chat ranker for one needy baseline stage WITH
 * run-bound audit context (null when the model abstains). The audit context
 * is what lets the ranker transport — without it the ranker fail-closes
 * before fetch (its own design). Callers MUST supply a frozen snapshot with
 * a compatible plan + ephemeral runId, otherwise this throws fail-closed.
 */
async function attemptBaselineChatStage(input: {
  operation: BaselineChatOperation;
  targetLabel: string;
  options: Array<{ value: string; label: string }>;
  selectionMode: 'single' | 'multiple';
  evidenceText: string;
  view: ModelPolicyView;
  snapshot: RuntimeClassificationSnapshot;
  runId: string;
  dispatchGuard: LlmDispatchGuard;
}): Promise<LlmRankResult | null> {
  const stage = input.operation === 'product_type_ranking'
    ? 'primary_product_type_proposal'
    : input.operation === 'attribute_ranking'
      ? 'product_attribute_proposals'
      : 'category_page_proposals';
  return llmRankOptions({
    targetLabel: input.targetLabel,
    options: input.options,
    selectionMode: input.selectionMode,
    evidenceText: input.evidenceText,
    task: BASELINE_CHAT_TASKS[input.operation].task,
    modelPolicy: input.view,
    protectedOperation: input.operation,
    modelCall: {
      runId: input.runId,
      snapshotHash: input.snapshot.snapshotHash,
      stage,
      operation: input.operation,
      attempt: 1,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[input.operation],
      ruleVersion: RULE_VERSIONS[input.operation],
    },
    snapshot: input.snapshot,
    dispatchGuard: input.dispatchGuard,
  });
}

/** Credential gate for the baseline chat leg (same resolution the ranker uses). */
function checkBaselineChatCredentials(
  route: QualificationBaselineLiveRoute,
  view: ModelPolicyView,
  needs: BaselineLiveNeeds,
): { ok: true; requestedModel: string; dispatchIdentityHash: string } | { ok: false; code: string; detail: string } {
  const blocked = (detail: string): { ok: false; code: string; detail: string } => ({
    ok: false,
    code: QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
    detail,
  });
  const firstOperation: BaselineChatOperation = needs.type
    ? 'product_type_ranking'
    : needs.attrs.length > 0 ? 'attribute_ranking' : 'page_assignment';
  if (!route.credentialRef?.trim()) return blocked('Live incumbent capture requires an explicit existing-store credential reference.');
  try {
    const config = resolveBaselineChatConfig(firstOperation, view);
    if (!config) {
      return blocked(
        `No usable chat provider for the baseline ranker leg (provider "${route.provider}"); configure existing provider credentials to capture baseline model judgments.`,
      );
    }
    if (config.provider !== route.provider || config.model !== route.model ||
        getLlmCredentialReference(config.provider) !== route.credentialRef.trim()) {
      return { ok: false, code: 'baseline_credential_reference_mismatch',
        detail: 'The resolved incumbent provider/model/credential source does not match the explicit route.' };
    }
    const dispatchIdentityHash = getLlmDispatchIdentityHash(config);
    if (!dispatchIdentityHash) return { ok: false, code: 'baseline_chat_transport_required',
      detail: 'The incumbent reference must identify an available chat transport, not System One.' };
    return { ok: true, requestedModel: config.model, dispatchIdentityHash };
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) {
      return blocked(
        `Baseline ranker route denied (${err.code}); configure existing provider credentials to capture baseline model judgments.`,
      );
    }
    return blocked(
      `Baseline ranker credentials unresolvable here: ${redactTransportText(err instanceof Error ? err.message : String(err))}`,
    );
  }
}

/**
 * Baseline product-type stage via the REAL decision boundary
 * (`resolveProductTypeDecision` — read-only usage): deterministic precedence
 * first, then the legacy chat ranker with run-bound audit rows (so the ranker
 * transports when provider credentials exist). Returns the boundary outcome
 * directly (resolved/abstained/failed — callers map failures to blocked).
 */
async function captureBaselineTypeWithRealBoundary(input: {
  entry: QualificationGoldOnlyEntry;
  taxa: QualificationTaxonomies;
  evidenceText: string;
  view: ModelPolicyView;
  snapshot: RuntimeClassificationSnapshot;
  runId: string;
  dispatchGuard: LlmDispatchGuard;
}): Promise<QualificationProductTypePrediction> {
  const { entry, taxa, view, snapshot, runId } = input;
  const evidence = qualificationEvidenceForBoundary(entry, runId);
  const target = stubResolvedTarget(
    'primary_product_type',
    'Primary Product Type',
    'product_type',
    'single',
    null,
    taxa.productTypes.map(t => ({ value: t.id, label: t.label })),
  );
  const decision = await resolveProductTypeDecision({
    target,
    evidence,
    sku: entry.sku,
    runId,
    snapshot,
    modelPolicy: view,
    dispatchGuard: input.dispatchGuard,
    assertHeld: input.dispatchGuard.assertContext,
  });
  if (decision.status === 'resolved' && decision.productTypeId) {
    return { productType: decision.productTypeId, abstained: false, confidence: decision.confidence };
  }
  return { productType: null, abstained: true, confidence: 0, abstentionCode: decision.abstentionCode ?? 'unresolved' };
}

/**
 * Baseline attribute stages via the REAL decision boundary
 * (`resolveAttributeDecision` — read-only usage) for each needy applicable
 * target, with RICH product context (name, brand, frozen resolved
 * productType). Appends resolved stages (abstentions append nothing — the
 * incumbent genuinely abstains there).
 */
async function captureBaselineAttributesWithRealBoundary(input: {
  entry: QualificationGoldOnlyEntry;
  taxa: QualificationTaxonomies;
  view: ModelPolicyView;
  snapshot: RuntimeClassificationSnapshot;
  runId: string;
  effectiveTypeId: string | null;
  attrTargetIds: string[];
  fields: Array<{ targetId: string; value?: string; values?: string[] }>;
  dispatchGuard: LlmDispatchGuard;
}): Promise<void> {
  const { entry, taxa, view, snapshot, runId, effectiveTypeId, attrTargetIds, fields } = input;
  const evidence = qualificationEvidenceForBoundary(entry, runId);
  const productContext = {
    name: qualificationProductName(entry),
    brand: null,
    productType: effectiveTypeId,
  };
  for (const targetId of attrTargetIds) {
    const target = taxa.attributeTargets.find(t => t.targetId === targetId);
    if (!target) continue;
    const { resolved } = stubAttributeTarget(target);
    const decision = await resolveAttributeDecision({
      target: resolved,
      cardinality: target.cardinality,
      evidence,
      sku: entry.sku,
      runId,
      snapshot,
      modelPolicy: view,
      productContext,
      dispatchGuard: input.dispatchGuard,
      assertHeld: input.dispatchGuard.assertContext,
    });
    if (decision.status !== 'resolved') continue;
    if (target.cardinality === 'multiple') {
      const values = decision.values ?? (decision.value ? [decision.value] : []);
      if (values.length > 0) fields.push({ targetId, values });
    } else if (decision.value) {
      fields.push({ targetId, value: decision.value });
    }
  }
}

/**
 * Baseline page stage via the REAL legacy chat ranker WITH run-bound audit
 * context (the same transport the decision boundaries use internally). Pages
 * are attempted AFTER freezing the resolved type (type-dependent sequencing),
 * even though the ranker prompt itself is type-agnostic.
 */
async function captureBaselinePagesWithRealRanker(input: {
  taxa: QualificationTaxonomies;
  evidenceText: string;
  view: ModelPolicyView;
  snapshot: RuntimeClassificationSnapshot;
  runId: string;
  dispatchGuard: LlmDispatchGuard;
}): Promise<string[]> {
  const pageOptions = input.taxa.pages.map(p => ({ value: p.pageId, label: p.pageName }));
  const ranked = await attemptBaselineChatStage({
    operation: 'page_assignment',
    targetLabel: 'category page',
    options: pageOptions,
    selectionMode: 'single',
    evidenceText: input.evidenceText,
    view: input.view,
    snapshot: input.snapshot,
    runId: input.runId,
    dispatchGuard: input.dispatchGuard,
  });
  const mapped = ranked && ranked.values.length > 0
    ? mapRankedLabelToOptionExactlyOne(ranked.values[0], pageOptions)
    : null;
  return mapped ? [mapped] : [];
}

/**
 * Live baseline stages with PRODUCT-TYPE-FIRST sequencing: resolve type first
 * (deterministic, then real boundary when needed), freeze the effective type,
 * recompute applicable attributes for the FROZEN type, then capture
 * type-dependent attributes and pages. Deterministic values are kept for
 * stages that needed no model; live outcomes replace only needy stages.
 */
async function applyBaselineChatStagesWithRun(input: {
  entry: QualificationGoldOnlyEntry;
  taxa: QualificationTaxonomies;
  evidenceText: string;
  view: ModelPolicyView;
  snapshot: RuntimeClassificationSnapshot;
  runId: string;
  needs: BaselineLiveNeeds;
  stages: ReturnType<typeof runDeterministicBaselineStages>;
  dispatchGuard: LlmDispatchGuard;
}): Promise<{
  productType: string | null;
  abstained: boolean;
  confidence: number;
  effectiveTypeId: string | null;
  abstentionCode?: string | null;
  fields: Array<QualificationFieldAssignment>;
  pages: QualificationPageOutcome;
}> {
  const { entry, taxa, evidenceText, view, snapshot, runId, needs, stages } = input;
  let productType = stages.type.productType;
  let abstained = stages.type.abstained;
  let confidence = stages.type.confidence;
  let abstentionCode = stages.type.abstentionCode ?? null;
  if (needs.type) {
    const type = await captureBaselineTypeWithRealBoundary({ entry, taxa, evidenceText, view, snapshot, runId, dispatchGuard: input.dispatchGuard });
    productType = type.productType;
    abstained = type.abstained;
    confidence = type.confidence;
    abstentionCode = type.abstentionCode ?? null;
  }
  const effectiveTypeId = abstained ? null : productType;
  // Recompute applicable attributes for the FROZEN resolved type (the
  // pre-computed `needs.attrs` was based on the deterministic type; a live
  // type resolution may have unlocked a new applicable set — never gold).
  // Shared split helper keeps the invariant/variable division identical to
  // the deterministic leg; deterministic fields for the OLD type that are
  // inapplicable under the NEW type are dropped (never carried across).
  const applicable = applicableQualificationAttributeTargets(taxa, effectiveTypeId);
  const { invariants, variableApplicable } = splitQualificationApplicableAndInvariants(taxa, effectiveTypeId, applicable);
  const invariantIds = new Set(invariants.map(f => f.targetId));
  const applicableIds = new Set(applicable.map(t => t.targetId));
  const retainedDeterministic = stages.fields.filter(
    f => applicableIds.has(f.targetId) && !invariantIds.has(f.targetId),
  );
  const matched = new Set([...retainedDeterministic.map(f => f.targetId), ...invariantIds]);
  const liveAttrIds = variableApplicable.filter(t => !matched.has(t.targetId)).map(t => t.targetId);
  const fields = [...invariants, ...retainedDeterministic];
  await captureBaselineAttributesWithRealBoundary({
    entry, taxa, view, snapshot, runId, effectiveTypeId, attrTargetIds: liveAttrIds, fields,
    dispatchGuard: input.dispatchGuard,
  });
  fields.sort((a, b) => a.targetId.localeCompare(b.targetId));
  // PAGE ABSTENTION PARITY: null effective type never attempts pages (coded
  // abstention, never a bare empty set). Ranker silence is unresolved proof.
  let pages: QualificationPageOutcome = effectiveTypeId === null
    ? { pageIds: [], pageOutcome: 'abstained-semantic', pageAbstentionCode: QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_CODE, pageProbability: null }
    : stages.pages;
  if (needs.pages && effectiveTypeId !== null) {
    const ranked = await captureBaselinePagesWithRealRanker({ taxa, evidenceText, view, snapshot, runId, dispatchGuard: input.dispatchGuard });
    pages = ranked.length > 0
      ? { pageIds: ranked, pageOutcome: 'predicted', pageAbstentionCode: null, pageProbability: null }
      : { pageIds: [], pageOutcome: 'unresolved', pageAbstentionCode: 'unresolved', pageProbability: null };
  }
  return { productType, abstained, abstentionCode, confidence, effectiveTypeId, fields, pages };
}

/**
 * Assemble the live-captured baseline side. `live_captured` GUARANTEES a model
 * spoke: `resolvedModel` + `usage` are always present (read from the run-bound
 * audit rows). Callers MUST NOT label a provider-selected-but-silent outcome
 * as live_captured — without a success audit row the side is `blocked`.
 */
function assembleLiveBaselinePrediction(input: {
  productType: string | null;
  abstained: boolean;
  abstentionCode?: string | null;
  confidence: number;
  fields: Array<QualificationFieldAssignment>;
  pages: QualificationPageOutcome;
  requestedModel: string;
  resolvedModel: string;
  provider: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
}): ExecutedQualificationPrediction {
  return {
    productType: input.productType,
    abstained: input.abstained,
    abstentionCode: input.abstentionCode ?? null,
    fieldAssignments: input.fields,
    pageIds: input.pages.pageIds,
    pageOutcome: input.pages.pageOutcome,
    pageAbstentionCode: input.pages.pageAbstentionCode,
    pageProbability: input.pages.pageProbability,
    confidence: artifactConfidence(input.abstained, input.confidence),
    latencyMs: input.latencyMs,
    source: QUALIFICATION_SOURCE_LIVE_CAPTURED,
    blockedCode: null,
    blockedDetail: null,
    failureCode: null,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    provider: input.provider,
    usage: input.usage,
  };
}

/**
 * Read run-bound audit proof that a model spoke (success rows with token
 * usage). Returns null when no model judgment spoke — the caller records
 * `blocked`, never `live_captured`.
 */
/** Load run-bound model-call rows (null when unreadable — caller records blocked). */
function loadBaselineAuditRows(runId: string): ReturnType<typeof getModelCallsByRun> | null {
  try {
    return getModelCallsByRun(runId);
  } catch {
    return null;
  }
}

/** Token usage summed over success audit rows. */
function sumBaselineAuditUsage(
  successes: ReturnType<typeof getModelCallsByRun>,
): { inputTokens: number | null; outputTokens: number | null } {
  const total = (field: 'prompt_tokens' | 'completion_tokens'): number | null => {
    if (successes.some(row => typeof row[field] !== 'number')) return null;
    return successes.reduce((sum, row) => sum + (row[field] ?? 0), 0);
  };
  return {
    inputTokens: total('prompt_tokens'),
    outputTokens: total('completion_tokens'),
  };
}

/** Model identity from the first success row (null when unresolvable). */
function resolveBaselineAuditIdentity(
  first: ReturnType<typeof getModelCallsByRun>[number],
): { requestedModel: string; resolvedModel: string | null } | null {
  const requestedModel = first.requested_model ?? first.model ?? null;
  // The requested route is not evidence of the provider's returned identity.
  const resolvedModel = first.resolved_model ?? null;
  if (!requestedModel) return null;
  return { requestedModel, resolvedModel };
}

/** Audit proof from success rows (null when no model judgment spoke). */
function buildBaselineAuditProofFromSuccesses(
  successes: ReturnType<typeof getModelCallsByRun>,
): {
  requestedModel: string;
  resolvedModel: string | null;
  provider: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
} | null {
  if (successes.length === 0) return null;
  const first = successes[0];
  const identity = resolveBaselineAuditIdentity(first);
  if (!identity) return null;
  const usage = sumBaselineAuditUsage(successes);
  return {
    requestedModel: identity.requestedModel,
    resolvedModel: successes.every(row => row.resolved_model === identity.resolvedModel &&
      (row.requested_model ?? row.model) === identity.requestedModel && row.provider === first.provider)
      ? identity.resolvedModel : null,
    provider: first.provider ?? 'unknown',
    usage,
  };
}

function readBaselineAuditProof(runId: string): {
  requestedModel: string;
  resolvedModel: string | null;
  provider: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
} | null {
  const rows = loadBaselineAuditRows(runId);
  if (!rows || rows.some(row => row.status !== 'success')) return null;
  const successes = rows.filter(r => r.status === 'success');
  return buildBaselineAuditProofFromSuccesses(successes);
}

/** Map a live baseline capture throw to its coded blocked side. */
function blockBaselineCaptureError(
  err: unknown,
  block: (code: string, detail: string) => ExecutedQualificationPrediction,
): ExecutedQualificationPrediction {
  if (err instanceof LlmDispatchGuardError) return block(`baseline_${err.code}`, err.message);
  if (isApplicabilityUnresolvableError(err)) {
    return block(
      QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE,
      'Frozen Product Type → profile → attribute mapping is absent/unresolvable for this entry; refusing to broaden.',
    );
  }
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

/** True when no live baseline route was opted in (null route or policy view). */
function hasBaselineLiveRoute(
  route: QualificationBaselineLiveRoute | null,
  view: ModelPolicyView | null,
): boolean {
  return !!route && !!view;
}

/** True when the deterministic stages left nothing for the chat ranker to do. */
function isBaselineLiveNeedsEmpty(needs: BaselineLiveNeeds): boolean {
  return !needs.type && needs.attrs.length === 0 && !needs.pages;
}

/** Floor prediction from deterministic stages (same shape as the inline closure). */
function buildBaselineFloorFromStages(
  stages: ReturnType<typeof runDeterministicBaselineStages>,
  latencyMs: number,
): ExecutedQualificationPrediction {
  return floorQualificationPrediction({
    productType: stages.type.productType,
    abstained: stages.type.abstained,
    abstentionCode: stages.type.abstentionCode ?? null,
    fieldAssignments: stages.fields,
    pageIds: stages.pages.pageIds,
    pageOutcome: stages.pages.pageOutcome,
    pageAbstentionCode: stages.pages.pageAbstentionCode,
    pageProbability: stages.pages.pageProbability,
    confidence: artifactConfidence(stages.type.abstained, stages.type.confidence),
    latencyMs,
  });
}

/** Ephemeral workspace + frozen snapshot for run-bound audit rows (throws fail-closed). */
function setupBaselineEphemeralContext(
  view: ModelPolicyView,
  taxa: QualificationTaxonomies,
): { workspaceId: string; snapshot: RuntimeClassificationSnapshot } {
  const workspaceId = ensureQualificationWorkspaceId();
  const snapshot = buildQualificationBaselineSnapshot(view, taxa);
  return { workspaceId, snapshot };
}

/** Coded detail for an ephemeral-setup throw (same message as the inline branch). */
function baselineSetupBlockedDetail(err: unknown): string {
  return `Ephemeral benchmark run setup failed: ${redactTransportText(err instanceof Error ? err.message : String(err))}`;
}

/** Quiet success completion for an ephemeral run (hygiene only, never throws). */
function completeBaselineSuccessQuietly(runId: string, abstained: boolean): void {
  try {
    completeRun(runId, abstained ? 'completed_with_abstentions' : 'completed');
  } catch {
    // Ephemeral run completion is hygiene only — a completion failure never
    // upgrades a blocked side or downgrades a speaking model.
  }
}

/** Live result from applied stages + audit proof (blocked when no model spoke). */
function resolveBaselineLiveResult(
  applied: {
    productType: string | null;
    abstained: boolean;
    abstentionCode?: string | null;
    confidence: number;
    fields: Array<QualificationFieldAssignment>;
    pages: QualificationPageOutcome;
  },
  proof: ReturnType<typeof readBaselineAuditProof>,
  latencyMs: number,
  block: (code: string, detail: string) => ExecutedQualificationPrediction,
): ExecutedQualificationPrediction {
  if (!proof) {
    return block(
      QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED,
      'Baseline live capture lacks complete successful audit proof; failed or missing calls cannot be hidden by an earlier successful stage.',
    );
  }
  if (!proof.resolvedModel) {
    return { ...block('baseline_model_identity_unverified', 'Successful incumbent calls did not establish a consistent provider-returned model identity.'),
      requestedModel: proof.requestedModel, resolvedModel: null, provider: proof.provider, usage: proof.usage };
  }
  return assembleLiveBaselinePrediction({
    productType: applied.productType,
    abstained: applied.abstained,
    abstentionCode: applied.abstentionCode ?? null,
    confidence: applied.confidence,
    fields: applied.fields,
    pages: applied.pages,
    requestedModel: proof.requestedModel,
    resolvedModel: proof.resolvedModel,
    provider: proof.provider,
    usage: proof.usage,
    latencyMs,
  });
}

/** Failure path: mark the ephemeral run failed (hygiene) then map to a coded blocked side. */
function failBaselineLiveRun(
  runId: string | null,
  err: unknown,
  block: (code: string, detail: string) => ExecutedQualificationPrediction,
): ExecutedQualificationPrediction {
  if (runId && !(err instanceof LlmDispatchGuardError && err.code === 'store_context_mismatch')) {
    try { completeRun(runId, 'failed', err instanceof Error ? err.message : String(err)); } catch { /* hygiene */ }
  }
  return blockBaselineCaptureError(err, block);
}

/** Deterministic stages or null when applicability is unresolvable (fail-closed). */
function loadBaselineDeterministicStages(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  evidenceText: string,
): ReturnType<typeof runDeterministicBaselineStages> | null {
  try {
    return runDeterministicBaselineStages(entry, taxa, evidenceText);
  } catch (err) {
    if (isApplicabilityUnresolvableError(err)) return null;
    throw err;
  }
}

/** Live needs or null when applicability is unresolvable (fail-closed). */
function loadBaselineLiveNeeds(
  taxa: QualificationTaxonomies,
  evidenceText: string,
  stages: ReturnType<typeof runDeterministicBaselineStages>,
): BaselineLiveNeeds | null {
  try {
    return baselineLiveNeeds(taxa, evidenceText, stages);
  } catch (err) {
    if (isApplicabilityUnresolvableError(err)) return null;
    throw err;
  }
}

/**
 * Capture one entry's baseline side with the incumbent precedence:
 * deterministic matcher first; REAL decision boundaries
 * (`resolveProductTypeDecision` / `resolveAttributeDecision` / audited legacy
 * ranker for pages) only for stages the matcher left unresolved. Without an
 * opted-in route (or when nothing needs a model) the side is the
 * deterministic floor. Missing credentials block the side (coded reason,
 * never a guess).
 *
 * Ephemeral benchmark runs: each live entry creates a proper ephemeral run
 * with run-bound model-call audit rows, so the legacy chat ranker path
 * transports when provider credentials exist (mocked HTTP in CI tests, never
 * real network). `live_captured` GUARANTEES a model spoke (success audit row
 * with `resolvedModel` + `usage` present); a provider-selected-but-silent
 * outcome (no success row) is `blocked` (`live_dispatch_failed`), never
 * live_captured. An abstention WITH a speaking model stays `live_captured`
 * (abstained=true, failureCode null — an honest abstention, not a failure).
 */
/** Verify the already-open database; never initialize or copy a store here. */
async function verifiedBaselineDatabase(route: QualificationBaselineLiveRoute): Promise<ReturnType<typeof getDb>> {
  const db = getDb();
  if (db.filename === ':memory:') {
    if (route.isolatedStore && route.isolatedStore !== ':memory:') throw new Error('baseline_store_context_mismatch');
    return db;
  }
  if (!route.isolatedStore) throw new Error('baseline_store_context_mismatch');
  const { assertIsolatedBaselineStore } = await import('./jev-benchmark-replay');
  const root = path.resolve(import.meta.dir, '../..');
  const isolated = assertIsolatedBaselineStore(route.isolatedStore, {
    repositoryRoot: root, productionStorePaths: [path.join(root, 'storage/catalog/.shopsite-cms/app.db')],
  });
  if (fs.realpathSync(db.filename) !== isolated || getDb() !== db) throw new Error('baseline_store_context_mismatch');
  return db;
}

async function captureBaselineEntryLive(
  entry: QualificationGoldOnlyEntry,
  taxa: QualificationTaxonomies,
  evidenceText: string,
  route: QualificationBaselineLiveRoute | null,
  view: ModelPolicyView | null,
  dispatchGuard: LlmDispatchGuard | null,
): Promise<ExecutedQualificationPrediction> {
  const started = Date.now();
  const latency = (): number => Math.max(0, Date.now() - started);
  const blockedForApplicability = (): ExecutedQualificationPrediction => ({
    ...blockedQualificationPrediction(
      QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE,
      'Frozen Product Type → profile → attribute mapping is absent/unresolvable for this entry; refusing to broaden.',
    ),
    latencyMs: latency(),
  });
  const stages = loadBaselineDeterministicStages(entry, taxa, evidenceText);
  if (!stages) return blockedForApplicability();
  const asFloor = (): ExecutedQualificationPrediction => buildBaselineFloorFromStages(stages, latency());
  if (!hasBaselineLiveRoute(route, view)) return asFloor();
  const needs = loadBaselineLiveNeeds(taxa, evidenceText, stages);
  if (!needs) return blockedForApplicability();
  if (isBaselineLiveNeedsEmpty(needs)) return asFloor();

  const block = (code: string, detail: string): ExecutedQualificationPrediction => ({
    ...blockedQualificationPrediction(code, detail),
    latencyMs: latency(),
  });
  if (!route!.credentialRef?.trim()) return block(QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
    'Live incumbent capture requires an explicit existing-store credential reference.');
  let evaluationDb: ReturnType<typeof getDb>;
  try {
    evaluationDb = await verifiedBaselineDatabase(route!);
    if (getDb() !== evaluationDb) throw new Error('baseline_store_context_mismatch');
  } catch {
    return block('baseline_store_context_mismatch', 'No verified matching isolated evaluation database is active.');
  }
  // Credential pre-check (same resolution the ranker uses): no usable
  // baseline model here means the side is blocked — the deterministic values
  // are discarded fail-closed rather than mixed with a guess.
  const credentials = checkBaselineChatCredentials(route!, view!, needs);
  if (!credentials.ok) return block(credentials.code, credentials.detail);
  if (!dispatchGuard) return block('baseline_runtime_guard_unwired', 'Live incumbent capture requires a bound attempt budget and deadline.');
  const boundGuard: LlmDispatchGuard = { ...dispatchGuard, dispatchIdentityHash: credentials.dispatchIdentityHash, assertContext: () => {
    try {
      if (getDb() === evaluationDb) return;
    } catch { /* Missing authority also denies dispatch and audit writes. */ }
    throw new LlmDispatchGuardError('store_context_mismatch');
  } };

  // Ephemeral benchmark run with a frozen snapshot carrying a compatible
  // model-execution plan — the REAL boundaries require both for run-bound
  // audit rows (their own fail-closed design). Any setup failure blocks the
  // side (never a partial guess, never live_captured).
  let workspaceId: string;
  let snapshot: RuntimeClassificationSnapshot;
  try {
    boundGuard.assertContext?.();
    ({ workspaceId, snapshot } = setupBaselineEphemeralContext(view!, taxa));
  } catch (err) {
    return block(
      QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED,
      baselineSetupBlockedDetail(err),
    );
  }
  let runId: string | null = null;
  try {
    const run = createRun(workspaceId, entry.sku, null, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
    runId = run.id;
    const applied = await applyBaselineChatStagesWithRun({
      entry, taxa, evidenceText, view: view!, snapshot, runId, needs, stages,
      dispatchGuard: boundGuard,
    });
    boundGuard.assertContext?.();
    const proof = readBaselineAuditProof(runId);
    const result = resolveBaselineLiveResult(applied, proof, latency(), block);
    if (result.source === QUALIFICATION_SOURCE_BLOCKED) {
      try { completeRun(runId, 'failed', result.blockedCode ?? 'baseline_unverified'); } catch { /* hygiene */ }
    } else {
      completeBaselineSuccessQuietly(runId, applied.abstained);
    }
    return { ...result, credentialRef: dispatchGuard.credentialRef,
      routeIdentityHash: hashCanonicalJson({ dispatchIdentityHash: credentials.dispatchIdentityHash, policyDigest: view!.policyDigest }) };
  } catch (err) {
    return failBaselineLiveRun(runId, err, block);
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
    abstentionCode: side.abstentionCode ?? null,
    typeProbability: side.typeProbability ?? null,
    typeCandidateProbabilities: side.typeCandidateProbabilities ?? null,
    typeProbabilityDigest: side.typeProbabilityDigest ?? null,
    fieldAssignments: side.fieldAssignments,
    pageIds: side.pageIds,
    pageOutcome: side.pageOutcome ?? null,
    pageAbstentionCode: side.pageAbstentionCode ?? null,
    pageProbability: side.pageProbability ?? null,
    confidence: side.confidence,
    source: side.source ?? null,
    blockedCode: side.blockedCode ?? null,
    failureCode: side.failureCode ?? null,
    requestedModel: side.requestedModel ?? null,
    resolvedModel: side.resolvedModel ?? null,
    provider: side.provider ?? null,
    ...(side.credentialRef === undefined ? {} : { credentialRef: side.credentialRef }),
    ...(side.routeIdentityHash === undefined ? {} : { routeIdentityHash: side.routeIdentityHash }),
    usage: side.usage ?? null,
  });
  const sorted = [...predictions].sort((a, b) => a.sku.localeCompare(b.sku));
  const hashable = sorted.map(p => ({
    sku: p.sku,
    baseline: hashableSide(p.baseline),
    candidate: hashableSide(p.candidate),
  }));
  const details = resolved.taxonomies.frozenAuthorityDetails ?? null;
  const authorityHash = details?.authorityHash ?? null;
  const authorityDetailsHash = frozenAuthorityDetailsHash(details);
  return sha256Hex(JSON.stringify({
    predictions: hashable,
    taxonomy: hashableTaxonomyProvenance(resolved),
    decisionPolicyHash: qualificationDecisionPolicyHash(),
    authorityHash,
    authorityDetailsHash,
  }));
}

/**
 * Canonical, gold-independent source-input digest for one capture's LOADED
 * inputs (finding 2): identity + evidence + resolved taxonomy provenance.
 * Gold labels (`gold`, `readerVersion`) never enter — the same evidence
 * always yields the same digest, and a changed snippet always changes it.
 * Recomputed from the loaded inputs at capture time and stored on the
 * capture record, so rescoring can prove the preserved `--capture-gold`
 * revision supplied the evidence the predictions ran against.
 */
export const QUALIFICATION_SOURCE_INPUTS_HASH_VERSION = 1 as const;

export function hashQualificationSourceInputs(
  entries: QualificationGoldOnlyEntry[],
  resolved: {
    taxonomySource: QualificationTaxonomySource;
    frozenTaxonomyHash: string | null;
    taxonomies: QualificationTaxonomies;
  },
  authorityHash: string | null,
  authorityDetailsHash: string | null,
): string {
  const sorted = [...entries]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map(entry => ({
      sku: entry.sku,
      familyId: entry.familyId,
      split: entry.split,
      assortment: entry.assortment,
      evidence: entry.evidence,
    }));
  return hashCanonicalJson({
    version: QUALIFICATION_SOURCE_INPUTS_HASH_VERSION,
    entries: sorted,
    taxonomy: hashableTaxonomyProvenance(resolved),
    authorityHash,
    authorityDetailsHash,
  });
}

/**
 * Source-input digest for dev-replay capture inputs: resolves the frozen
 * snapshot + authority sidecar exactly like the capture builders, then
 * hashes identity + evidence + taxonomy provenance (gold-free).
 */
export function hashDevReplaySourceInputs(
  entries: QualificationGoldOnlyEntry[],
  snapshot: FrozenTaxonomySnapshot,
  details: FrozenAuthorityDetails | null | undefined,
): string {
  const taxonomies = qualificationTaxonomiesFromFrozenSnapshot(withFrozenAuthorityDetails(snapshot, details));
  return hashQualificationSourceInputs(entries, {
    taxonomySource: 'frozen_snapshot',
    frozenTaxonomyHash: snapshot.snapshotHash,
    taxonomies,
  }, details?.authorityHash ?? null, frozenAuthorityDetailsHash(details));
}

/**
 * Recompute and validate a stored artifact's semantic identity (finding 3):
 * the caller's taxonomy input must reproduce `artifact.artifactHash`, else
 * the capture is scored under an identity describing different predictions.
 * Fail-closed — a mismatch throws before scoring or reusing the identity.
 */
export function assertQualificationArtifactIntegrity(
  artifact: QualificationPredictionArtifact,
  taxonomies?: QualificationTaxonomyInput,
): void {
  if (!artifact || !Array.isArray(artifact.predictions) || typeof artifact.artifactHash !== 'string') {
    throw new Error('Captured comparison artifact is malformed.');
  }
  if (typeof artifact.entryCount === 'number' && artifact.predictions.length !== artifact.entryCount) {
    throw new Error('Captured comparison artifact identity does not match its predictions.');
  }
  if (artifact.predictorVersion !== QUALIFICATION_PREDICTOR_VERSION ||
    artifact.decisionPolicyHash !== qualificationDecisionPolicyHash()) {
    throw new Error('Captured comparison artifact identity does not match its predictions.');
  }
  const stubEntries = artifact.predictions.map(({ sku }) => ({
    sku,
    familyId: '',
    split: 'dev',
    assortment: '',
    gold: {
      productType: { kind: 'unlabeled', typeId: null },
      fieldAssignments: [],
      categoryPages: { pageIds: [], pageAssignments: [] },
    },
    evidence: [],
  }) as QualificationGoldOnlyEntry);
  const resolved = resolveQualificationTaxonomies(taxonomies, stubEntries);
  const recomputed = hashQualificationPredictions(artifact.predictions, resolved);
  if (recomputed !== artifact.artifactHash) {
    throw new Error('Captured comparison artifact identity does not match its predictions.');
  }
}

function qualificationDecisionPolicyHash(): string {
  return hashCanonicalJson({ predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
    runtimeRules: buildRuntimeRuleVersions().digest,
    pageQuestionVersion: PAGE_QUESTION_VERSION,
    pageJudgmentVersion: PAGE_JUDGMENT_VERSION,
    choiceFloor: SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
    noulFloor: SYSTEMONE_MULTI_MIN_PROBABILITY });
}

/** Authority binding for one resolved capture (additive artifact identity). */
function artifactAuthorityBinding(resolved: {
  taxonomies: QualificationTaxonomies;
}): { authorityHash: string | null; authorityDetailsHash: string | null } {
  const details = resolved.taxonomies.frozenAuthorityDetails ?? null;
  return {
    authorityHash: details?.authorityHash ?? null,
    authorityDetailsHash: frozenAuthorityDetailsHash(details),
  };
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
    decisionPolicyHash: qualificationDecisionPolicyHash(),
    predictedAt,
    entryCount: entries.length,
    captureMode: 'deterministic_floor',
    taxonomySource: resolved.taxonomySource,
    frozenTaxonomyHash: resolved.frozenTaxonomyHash,
    ...artifactAuthorityBinding(resolved),
    sourceInputsHash: hashQualificationSourceInputs(entries, resolved,
      resolved.taxonomies.frozenAuthorityDetails?.authorityHash ?? null,
      frozenAuthorityDetailsHash(resolved.taxonomies.frozenAuthorityDetails)),
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
  const candidateGuardWired = !!options.attemptBudget &&
    typeof options.attemptBudget.tryConsumeAttempt === 'function' && options.deadlineSignal instanceof AbortSignal;
  // The bound attempt guard + deadline ride the real request path end to end:
  // every candidate dispatch (type phase + attribute/page phase, chunked)
  // enforces them inside executeSystemOne. No guard + explicit credentials
  // means the candidate leg cannot run live (callers fail closed upstream).
  if (jev) {
    jev.attemptBudget = options.attemptBudget ?? null;
    jev.deadlineSignal = options.deadlineSignal ?? null;
  }
  const view = options.baselineRoute ? buildBaselineChatPolicyView(options.baselineRoute) : null;
  const baselineGuard: LlmDispatchGuard | null = options.baselineRoute?.credentialRef?.trim() &&
      options.baselineAttemptBudget && typeof options.baselineAttemptBudget.tryConsumeAttempt === 'function' &&
      options.baselineDeadlineSignal instanceof AbortSignal
    ? { provider: options.baselineRoute.provider, model: options.baselineRoute.model,
        credentialRef: options.baselineRoute.credentialRef.trim(),
        attemptBudget: options.baselineAttemptBudget, signal: options.baselineDeadlineSignal }
    : null;
  const predictions: Array<{
    sku: string;
    baseline: ExecutedQualificationPrediction;
    candidate: ExecutedQualificationPrediction;
  }> = [];
  for (const entry of entries) {
    const evidenceText = qualificationEvidenceText(entry);
    const baseline = await captureBaselineEntryLive(entry, taxa, evidenceText, options.baselineRoute ?? null, view, baselineGuard);
    const candidate = jev
      ? candidateGuardWired
        ? await captureCandidateEntryLive(entry, taxa, jev)
        : blockedQualificationPrediction('jev_runtime_guard_unwired', 'Live candidate capture requires a bound attempt budget and deadline.')
      : blockedCandidateWithoutCredentials(entry, taxa);
    predictions.push({ sku: entry.sku, baseline, candidate });
  }
  if (predictions.length !== entries.length) {
    throw new Error('Qualification prediction artifact incomplete: missing entries.');
  }
  return {
    predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
    artifactHash: hashQualificationPredictions(predictions, resolved),
    decisionPolicyHash: qualificationDecisionPolicyHash(),
    predictedAt,
    entryCount: entries.length,
    captureMode: jev || view ? 'live_captured' : 'deterministic_floor',
    taxonomySource: resolved.taxonomySource,
    frozenTaxonomyHash: resolved.frozenTaxonomyHash,
    ...artifactAuthorityBinding(resolved),
    sourceInputsHash: hashQualificationSourceInputs(entries, resolved,
      resolved.taxonomies.frozenAuthorityDetails?.authorityHash ?? null,
      frozenAuthorityDetailsHash(resolved.taxonomies.frozenAuthorityDetails)),
    predictions,
  };
}
