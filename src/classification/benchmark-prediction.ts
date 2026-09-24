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
export const GOLD_KIND_KNOWN_TYPE = 'known-type' as const;
export const GOLD_KIND_NO_FIT = 'no-fit' as const;
export const GOLD_KIND_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
export const GOLD_KIND_UNLABELED = 'unlabeled' as const;

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

/** Normalize a stored gold productType label to its adjudicated kind. */
export function adjudicateGoldProductType(value: unknown): AdjudicatedGoldType {
  if (typeof value === 'string') {
    return value.length > 0
      ? { kind: GOLD_KIND_KNOWN_TYPE, typeId: value }
      : { kind: GOLD_KIND_UNLABELED, typeId: null };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value) {
    const kind: unknown = value.kind;
    if (kind === GOLD_KIND_NO_FIT) return { kind: GOLD_KIND_NO_FIT, typeId: null };
    if (kind === GOLD_KIND_INSUFFICIENT_EVIDENCE) return { kind: GOLD_KIND_INSUFFICIENT_EVIDENCE, typeId: null };
    if (kind === GOLD_KIND_UNLABELED) return { kind: GOLD_KIND_UNLABELED, typeId: null };
    if (kind === GOLD_KIND_KNOWN_TYPE && 'typeId' in value) {
      const typeId: unknown = value.typeId;
      if (typeof typeId === 'string' && typeId.length > 0) return { kind: GOLD_KIND_KNOWN_TYPE, typeId };
      return { kind: GOLD_KIND_UNLABELED, typeId: null };
    }
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
 * `assessPredictionSourceEligibility`). Preserved byte-for-byte so historical
 * bundle hashes still verify. New captures MUST use
 * `extractPreReviewPredictionForSku` instead.
 */
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

  let productType: string | null = null;
  const pageAssignments: string[] = [];
  const fieldAssignments: Array<{ targetId: string; value: string | null }> = [];
  let abstained = false;
  let confidence: number | null = null;

  for (const proposal of proposals) {
    // Exclude stale/config-drift/source-drift records at extraction time.
    if (proposal.isStale) continue;
    if (proposal.proposalType === 'reviewable_abstention') {
      abstained = true;
      continue;
    }

    const decision = decisions.find(d => d.proposalId === proposal.id);
    if (!decision || decision.decision !== 'accepted') continue;

    const val = effectiveValue(decision, proposal);
    const effectiveTarget = decision.hasRevisedTargetId && decision.revisedTargetId !== undefined
      ? decision.revisedTargetId
      : proposal.targetId;

    if (proposal.proposalType === 'primary_product_type') {
      productType = val;
      confidence = proposal.confidence;
    } else if (proposal.proposalType === 'category_page') {
      // Page labels use the display name from the effective value — never the
      // stable Page ID (issue #17 D1).
      const pageName = pageNameFromPageValue(
        decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
      );
      if (pageName) pageAssignments.push(pageName);
    } else if (proposal.proposalType === 'field_assignment' && effectiveTarget) {
      fieldAssignments.push({ targetId: effectiveTarget, value: val });
    }
  }

  if (!productType && pageAssignments.length === 0 && fieldAssignments.length === 0 && !abstained) {
    return null;
  }

  return {
    exampleId: '', // filled by the builder against the gold example id
    productSku: sku,
    productType,
    pageAssignments: [...new Set(pageAssignments)],
    fieldAssignments,
    abstained,
    confidence,
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
export const PRE_REVIEW_FAILURE_NO_RUN = 'no_run' as const;
export const PRE_REVIEW_FAILURE_RUN_FAILED = 'run_failed' as const;
export const PRE_REVIEW_FAILURE_RUN_INCOMPLETE = 'run_incomplete' as const;
export const PRE_REVIEW_FAILURE_STAGE_FAILED = 'stage_failed' as const;
export const PRE_REVIEW_FAILURE_CALL_FAILED = 'call_failed' as const;
export const PRE_REVIEW_FAILURE_NO_PREDICTION = 'no_prediction' as const;
export const PRE_REVIEW_FAILURE_AMBIGUOUS_PREDICTION = 'ambiguous_prediction' as const;

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
export function capturePreReviewPrediction(input: PreReviewCaptureInput): PreReviewPredictionEntry {
  const claimTargets = input.claimTargets ?? [];
  const capturedAt = new Date().toISOString();
  const base = {
    exampleId: '',
    productSku: input.productSku,
    pageAssignments: [] as string[],
    fieldAssignments: [] as Array<{ targetId: string; value: string | null }>,
    abstained: false,
    confidence: null as number | null,
    claimTargets,
    source: PRE_REVIEW_PREDICTION_SOURCE,
    bundleVersion: PRE_REVIEW_BUNDLE_VERSION,
  };

  const fail = (failureCode: string): PreReviewPredictionEntry => ({
    ...base,
    productType: null,
    outcome: 'failed',
    failureCode,
    abstentionReason: null,
  });

  const run = classRunRepo.getRun(input.runId);
  if (!run || run.workspaceId !== input.workspaceId || run.productSku !== input.productSku) return fail(PRE_REVIEW_FAILURE_NO_RUN);

  const terminalOk = run.status === 'completed' || run.status === 'completed_with_abstentions';
  if (run.status === 'failed' || run.status === 'cancelled') return fail(PRE_REVIEW_FAILURE_RUN_FAILED);

  const evidence = classRunRepo.getEvidenceByRun(run.id);
  const evidencePrint = evidenceFingerprint(evidence.map(e => ({
    source: e.source,
    snippet: e.snippet,
    reliability: e.reliability,
    attributeId: e.attributeId,
  })));

  const calls = getModelCallsByRun(run.id);
  const primaryCall = [...calls]
    .filter(c => c.operation === 'product_type_ranking')
    .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))[0]
    ?? [...calls].sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))[0]
    ?? null;
  const callFailed = calls.some(c => c.status === 'failed' || c.status === 'cancelled');

  const provenance: PreReviewEntryProvenance = {
    runId: run.id,
    configSnapshotHash: run.configSnapshotHash,
    sourceProductHash: run.sourceProductHash,
    evidenceCount: evidencePrint.count,
    evidenceHash: evidencePrint.hash,
    modelCalls: calls.map(c => ({
      id: c.id,
      operation: c.operation,
      provider: c.provider,
      model: c.model,
      requestedModel: c.requested_model ?? null,
      resolvedModel: c.resolved_model ?? null,
      status: c.status,
    })),
    primaryModelProvider: primaryCall?.provider ?? null,
    primaryModel: primaryCall?.model ?? null,
    capturedAt,
  };

  const stageFailed = classRunRepo.getStageResults(run.id).some(s => {
    const stageName: unknown = s.stage_name;
    return stageName === 'primary_product_type_proposal' && s.status === 'failed';
  });
  if (!terminalOk) return { ...fail(PRE_REVIEW_FAILURE_RUN_INCOMPLETE), provenance };
  if (stageFailed) return { ...fail(PRE_REVIEW_FAILURE_STAGE_FAILED), provenance };
  if (callFailed) return { ...fail(PRE_REVIEW_FAILURE_CALL_FAILED), provenance };

  const proposals = classRunRepo.getProposalsByRun(run.id).filter(p => !p.isStale);

  const fieldProposalsByTarget = new Map<string, { value: string | null; values?: string[]; confidence: number; proposalType: string }>();
  for (const p of proposals) {
    if (p.proposalType === 'field_assignment' && p.targetId) {
      let val: string | null = null;
      let values: string[] | undefined = undefined;
      if (Array.isArray(p.proposedValue)) {
        values = p.proposedValue.map(v => typeof v === 'string' ? v : (v != null ? String(v) : '')).filter(Boolean);
        val = values.join(', ');
      } else if (typeof p.proposedValue === 'string') {
        val = p.proposedValue;
        values = [p.proposedValue];
      } else if (p.proposedValue != null) {
        val = String(p.proposedValue);
        values = [val];
      }
      const existing = fieldProposalsByTarget.get(p.targetId);
      if (!existing || existing.proposalType !== 'field_assignment' || (p.confidence ?? 0) > existing.confidence) {
        fieldProposalsByTarget.set(p.targetId, { value: val, values, confidence: p.confidence ?? 0, proposalType: 'field_assignment' });
      }
    } else if (p.proposalType === 'reviewable_abstention' && p.targetId) {
      const isTypeOrPage =
        p.targetId === 'primary_product_type_proposal' ||
        p.targetId === 'primary_product_type' ||
        p.targetId === 'product_type_ranking' ||
        p.targetId === 'category_page_assignment';
      if (!isTypeOrPage) {
        if (!fieldProposalsByTarget.has(p.targetId)) {
          fieldProposalsByTarget.set(p.targetId, { value: null, confidence: 0, proposalType: 'reviewable_abstention' });
        }
      }
    }
  }

  base.fieldAssignments = [...fieldProposalsByTarget.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetId, { value, values }]) => ({ targetId, value, ...(values ? { values } : {}) }));

  const typeProposals = proposals
    .filter(p => p.proposalType === 'primary_product_type')
    .sort((a, b) =>
      b.confidence - a.confidence
      || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  if (typeProposals.length > 0) {
    const winner = typeProposals[0];
    const winnerId = canonicalPreReviewTypeId(winner);
    if (!winnerId) return { ...fail(PRE_REVIEW_FAILURE_NO_PREDICTION), provenance };
    const contender = typeProposals.find(
      p => p.confidence === winner.confidence && p.id !== winner.id && canonicalPreReviewTypeId(p) !== winnerId,
    );
    if (contender) return { ...fail(PRE_REVIEW_FAILURE_AMBIGUOUS_PREDICTION), provenance };
    const winnerCallCode = codeFromValue(winner.proposedValue);
    return {
      ...base,
      productType: winnerId,
      abstained: false,
      confidence: winner.confidence,
      outcome: 'predicted',
      abstentionReason: null,
      failureCode: winnerCallCode,
      provenance,
    };
  }

  // No type proposal: explicit semantic abstention only when a
  // `reviewable_abstention` names the product-type stage/target.
  const abstention = proposals.find(
    p => p.proposalType === 'reviewable_abstention'
      && (p.targetId === 'primary_product_type_proposal' || p.targetId === 'primary_product_type' || p.targetId === 'product_type_ranking'),
  );
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
  return { ...fail(PRE_REVIEW_FAILURE_NO_PREDICTION), provenance };
}

function effectiveValue(decision: { hasRevisedValue?: boolean; revisedValue?: unknown }, proposal: { proposedValue?: unknown }): string | null {
  if (decision.hasRevisedValue && decision.revisedValue !== undefined) {
    return typeof decision.revisedValue === 'string'
      ? decision.revisedValue
      : decision.revisedValue === null
        ? null
        : JSON.stringify(decision.revisedValue);
  }
  const pv = proposal.proposedValue;
  if (pv === null || pv === undefined) return null;
  return typeof pv === 'string' ? pv : JSON.stringify(pv);
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

export interface GoldExampleForPreReviewBuild {
  id: string;
  product_sku: string;
  source_run_id: string | null;
  source_config_hash: string | null;
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
  const dataset = benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId);
  if (!dataset) throw new Error('Dataset not found or not owned by this workspace.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Predictions require a frozen dataset; dataset is ${dataset.status}.`);
  }

  const goldExamples = benchmarkRepo.getExamples(datasetId, options.splitGroup);
  if (goldExamples.length === 0) {
    throw new Error(`No gold examples in split "${options.splitGroup}".`);
  }

  const claimTargets = options.claimTargets ?? [];
  const capturedAt = new Date().toISOString();
  const predictions: PreReviewPredictionEntry[] = goldExamples.map(example => {
    const runId = resolveReplayRunId(workspaceId, example);
    const entry = capturePreReviewPrediction({ runId, workspaceId, productSku: example.product_sku, claimTargets });
    if (example.source_config_hash && entry.provenance?.configSnapshotHash !== example.source_config_hash) {
      throw new Error(
        `Snapshot mismatch for gold example "${example.id}" (SKU ${example.product_sku}): replay run config does not match the frozen source.`,
      );
    }
    return { ...entry, exampleId: example.id };
  });

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
    bundleHash,
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
  const dataset = benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId);
  if (!dataset) throw new Error('Dataset not found or not owned by this workspace.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Predictions require a frozen dataset; dataset is ${dataset.status}.`);
  }

  const goldExamples = benchmarkRepo.getExamples(datasetId, options.splitGroup);
  if (goldExamples.length === 0) {
    throw new Error(`No gold examples in split "${options.splitGroup}".`);
  }

  const claimTargets = options.claimTargets ?? [];
  const predictions: BenchmarkPredictionEntry[] = goldExamples.map(example => {
    const entry = extractPredictionsForSku(workspaceId, example.product_sku, claimTargets);
    if (!entry) {
      throw new Error(
        `No reviewed-run prediction available for gold example "${example.id}" (SKU ${example.product_sku}).`,
      );
    }
    return { ...entry, exampleId: example.id };
  });

  const bundleHash = computePredictionBundleHash(predictions);

  const bundle: BenchmarkPredictionBundle = {
    id: randomUUID(),
    datasetId,
    workspaceId,
    runLabel: options.runLabel,
    splitGroup: options.splitGroup,
    predictions,
    bundleHash,
    createdAt: new Date().toISOString(),
  };

  // Fail closed BEFORE persisting: the persisted bundle must be complete and
  // self-consistent, otherwise no evaluation can ever be run against it.
  validatePredictionBundle(
    predictions,
    goldExamples.map(e => ({ id: e.id, productSku: e.product_sku })),
    bundleHash,
  );

  benchmarkRepo.createPredictionBundle(
    datasetId,
    workspaceId,
    options.runLabel,
    options.splitGroup,
    JSON.stringify(predictions),
    bundleHash,
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
export function assessPredictionSourceEligibility(source: PredictionSourceKind): { eligible: boolean; reason: string } {
  if (source === PRE_REVIEW_PREDICTION_SOURCE) {
    return { eligible: true, reason: 'prereview_raw_v1_eligible' };
  }
  return { eligible: false, reason: 'reviewed_outcome_ineligible_for_raw_accuracy' };
}
