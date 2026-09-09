/**
 * Cohort-level Execution Product Type resolver (issue #30 PR4 C3).
 *
 * PURE module: builds per-member frozen evidence, runs the deterministic
 * keyword match, aggregates the family outcome, and validates family
 * invariants — with NO DB reads, NO model calls, and NO persistence. The
 * freeze-time integration (write-once `execution_product_type_id` +
 * `final_membership_hash` in the final CAS transaction) lives in the next
 * commit (C4a); this module is only invoked from there.
 *
 * Inputs are fully frozen (architecture-report §2.1):
 * - per-member `execution-evidence-v1` projections (`spreadsheetIdentity` +
 *   `extraction` + frozen packaging OCR);
 * - each member's immutable runtime snapshot (product type options resolved
 *   via `resolveTargetsFromSnapshot` — a pure snapshot reader; the
 *   DB-backed `resolveEnabledTargets` is never called here).
 *
 * Aggregation (architecture-report §2.2, DECISION-C; no majority forcing):
 * - all confident members agree               -> `coherent`
 * - >=1 confident match, >=1 abstainer, no
 *   contradiction                             -> `coherent_with_abstentions`
 * - >=2 confident DISTINCT ids                -> `conflicted` (id never picked)
 * - no confident match                        -> `abstained`
 * A member result below `confidenceFloor` counts as an abstention.
 *
 * PR5 hardening (P1-2): a member's compatible reviewed Primary Product Type
 * (from its snapshot's provenance-compatible reviewed facts) participates at
 * coherence time as a family_invariant — any reviewed-vs-reviewed or
 * reviewed-vs-confident-inference disagreement is `conflicted` (never
 * silently coexist), an agreeing reviewed type contributes with source
 * 'reviewed', and a reviewed type may resolve an otherwise-abstaining member.
 */
import { randomUUID } from 'node:crypto';
import { hashCanonicalJson } from '../shared/stable-id';
import { sourceProvenanceFromMember } from './cohort-decision-authority';
import type {
  ClassificationEvidence,
  BrandConfig,
} from '../shared/schemas/classification';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
  ExecutionEvidenceProjection,
} from '../shared/schemas/cohorts';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { matchKeywordOptions } from './curation-target-matcher';
import { buildEvidenceTargetPacket } from './evidence-targeting';
import { resolveTargetsFromSnapshot, type ResolvedTargetOption } from './curation-target-resolver';
import { resolveBrand } from './brand-resolution';
import { packagingOcrDataToEvidence } from './ocr-evidence';
import { getReviewedTypeFromSnapshot } from './effective-curation-type';

const now = () => new Date().toISOString();

/**
 * Deterministic keyword-match confidence floor. Mirrors the per-SKU stage
 * constant (`KEYWORD_MATCH_MIN_CONFIDENCE = 0.7`,
 * `src/classification/curation-target-processor.ts:47`), which is not
 * exported. The cohort floor is an additional caller-supplied tunable
 * (`confidenceFloor`); a member match must clear BOTH the matcher floor here
 * and the caller's `confidenceFloor` to count as confident.
 */
export const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

// ─── C3a: per-member frozen evidence ─────────────────────────────────────────

export interface EvidenceFromProjectionOptions {
  /** Run id stamped on the produced records (default '' — pure builder, no run yet). */
  runId?: string;
  /** Product SKU stamped on the produced records (default: the projection's productSku). */
  productSku?: string;
  /**
   * PR12 review R1: the EXPECTED OCR execution-authority digest for the
   * snapshot the evidence is being built under. When supplied (`!==
   * undefined`), OCR materializes ONLY when the projection's frozen
   * `ocrExecutionDigest` EXACTLY equals it — a stored digest computed under
   * a DIFFERENT authority (stale OCR) is rejected even though it is non-null
   * and its input hash matches. `null` (a snapshot whose digest cannot be
   * computed) rejects OCR ENTIRELY — fail closed, and the PR13 C4 literal
   * contract means an explicitly-supplied `null` NEVER matches a stored
   * `null` (no digest comparison can bless OCR without an expected
   * authority). Absent (the freeze path, whose pull-forward already re-ran
   * OCR under the current authority) keeps the pre-PR12 non-null check
   * byte-identically.
   */
  expectedOcrExecutionDigest?: string | null;
}

export interface DeterministicTypeMatchResult {
  /** The matched product type id, or null when no confident keyword match. */
  productTypeId: string | null;
  /** The keyword-match confidence (0..1), or null when no confident match. */
  confidence: number | null;
  /** 'keyword' when the deterministic matcher produced the match, else null. */
  source: 'keyword' | null;
}

/**
 * Build the per-member evidence records purely from a frozen
 * `execution-evidence-v1` projection member — a projection-only mirror of the
 * frozen-mode evidence stage (`executeFrozenEvidenceExtraction`,
 * `src/classification/stages/evidence-extraction.ts:28-137`) WITHOUT
 * persistence: no `onboarding_items` reads, no model calls, no write-back.
 *
 * Field mapping mirrors the frozen stage exactly:
 * - `spreadsheetIdentity` -> `spreadsheet` source records (name, expected_name,
 *   brand);
 * - normalized `extraction` fields -> `official_product_page` source records
 *   (name, brand, weight, description, bullet_point, search_keywords [low],
 *   custom fields);
 * - frozen packaging OCR -> `visual_product_evidence` records (the frozen
 *   stage's conversion, via the shared PURE converter in
 *   `./ocr-evidence` — P2-T1 removed this module's mirrored copy).
 *
 * The OCR is materialized ONLY when the projection's own input-hash binding
 * still matches (recomputed purely from frozen fields) AND the projection
 * carries a non-null `ocrExecutionDigest` (the execution-authority binding the
 * freeze verified against the member snapshot's plan/rule digest — immutable
 * in the content-addressed projection). The frozen stage additionally
 * re-derives the snapshot digest at stage time; this builder cannot (no
 * snapshot in scope) and trusts the digest frozen at freeze time.
 */
export function evidenceFromProjection(
  memberProjection: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
  options: EvidenceFromProjectionOptions = {},
): ClassificationEvidence[] {
  const evidence: ClassificationEvidence[] = [];
  const sku = options.productSku ?? memberProjection.productSku ?? '';
  const runId = options.runId ?? '';
  const sourceUrl = memberProjection.sourceUrl;
  const ext = memberProjection.extraction;
  const identity = memberProjection.spreadsheetIdentity;
  // V2 members carry the distributor identity fields (SKU/MPN/variants); V1
  // members normalize to official-page provenance and have none.
  const extV2 =
    'itemSourceType' in memberProjection
      ? (memberProjection as ExecutionEvidenceProjectionMemberV2).extraction
      : null;

  // Milestone E: source-kind/provenance binding of the frozen member. A
  // distributor-record member is a THIRD-PARTY evidence source: its
  // classification evidence uses source='distributor_record', a null
  // classification URL, identity-only fields, and provenance metadata — and
  // is NEVER labeled 'official_product_page'. V1 members normalize to
  // official-page provenance (distributor routing did not exist then).
  const sourceProvenance = sourceProvenanceFromMember(memberProjection);
  const distributorSource = sourceProvenance.itemSourceType === 'distributor_record';
  const distributorMetadata = distributorSource
    ? {
        provenance: 'distributor_record',
        providerIds: sourceProvenance.providerIds,
        acceptedEvidenceAttemptIds: sourceProvenance.acceptedEvidenceAttemptIds,
        sourcingGenerationId: sourceProvenance.sourcingGenerationId,
        evidenceHash: sourceProvenance.distributorEvidenceHash,
        // Per-field provenance from the frozen member (Milestone E review):
        // distributor identity evidence carries the same field-level
        // provenance the main evidence-extraction stage emits.
        fieldProvenance: ext.fieldProvenance ?? {},
      }
    : undefined;
  const pageSource: ClassificationEvidence['source'] = distributorSource
    ? 'distributor_record'
    : 'official_product_page';
  // Distributor evidence carries NO classification URL (identity-only; the
  // real distributor page URL stays on the immutable evidence attempt).
  const pageEvidenceUrl = distributorSource ? null : sourceUrl;

  const push = (entry: Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>): void => {
    evidence.push({
      ...entry,
      id: randomUUID(),
      runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      capturedAt: now(),
    } as ClassificationEvidence);
  };

  // ── Spreadsheet identity (frozen spreadsheet hints) ────────────────────
  push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: identity.name.slice(0, 300), value: identity.name, metadata: { provenance: 'spreadsheet_import' } });
  if (identity.expectedName && identity.expectedName !== identity.name) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'expected_name', snippet: identity.expectedName.slice(0, 300), value: identity.expectedName, metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' } });
  }
  if (identity.brandHint) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'brand', snippet: identity.brandHint.slice(0, 300), value: identity.brandHint, metadata: { provenance: 'spreadsheet_import' } });
  }

  // ── Normalized extraction fields ────────────────────────────────────────
  // Distributor-record members carry IDENTITY-ONLY extraction data: title/
  // brand/weight only — never description, bullets, search keywords, or
  // arbitrary custom fields (those would elevate third-party copy into
  // classification evidence). Official-page members keep the full mapping.
  const identityFields: Array<{ field: string; value: string; sourceField: string; snippet: string }> = [];
  if (ext.title && ext.title.trim()) {
    identityFields.push({ field: 'name', value: ext.title, sourceField: 'name', snippet: ext.title.slice(0, 300) });
  }
  if (ext.brand && ext.brand.trim()) {
    identityFields.push({ field: 'brand', value: ext.brand, sourceField: 'brand', snippet: ext.brand.slice(0, 300) });
  }
  if (ext.weight && ext.weight.trim()) {
    identityFields.push({ field: 'weight', value: ext.weight, sourceField: 'weight', snippet: ext.weight.slice(0, 300) });
  }
  // Milestone E review: distributor identity evidence includes the frozen
  // distributor SKU, MPN, and whitelisted variant attributes (identity fields
  // present in the V2 member extraction) — matching the main evidence-
  // extraction stage's distributor mapping. Never copy/images/claims.
  if (distributorSource) {
    if (extV2?.distributorSku && extV2.distributorSku.trim()) {
      identityFields.push({ field: 'distributorSku', value: extV2.distributorSku, sourceField: 'distributor_sku', snippet: extV2.distributorSku.slice(0, 300) });
    }
    if (extV2?.manufacturerPartNumber && extV2.manufacturerPartNumber.trim()) {
      identityFields.push({ field: 'manufacturerPartNumber', value: extV2.manufacturerPartNumber, sourceField: 'manufacturer_part_number', snippet: extV2.manufacturerPartNumber.slice(0, 300) });
    }
    for (const [key, rawVal] of Object.entries(extV2?.variantAttributes ?? {})) {
      const value = String(rawVal ?? '').trim();
      if (!value) continue;
      identityFields.push({ field: key, value, sourceField: key, snippet: value.slice(0, 300) });
    }
  }
  for (const f of identityFields) {
    push({
      attributeId: null,
      source: pageSource,
      reliability: 'medium',
      sourceUrl: pageEvidenceUrl,
      sourceField: f.sourceField,
      snippet: f.snippet,
      value: f.value,
      metadata: distributorMetadata ?? { provenance: 'official_product_page' },
    });
  }

  // Amendment B merchandising mirror (M5b-1): a VERIFIED v2 distributor member
  // (`extractionMethod === 'distributor_record_v2'`) emits the SAME explicit
  // merchandising fields as the frozen evidence stage — description, each
  // feature as bullet_point, distributor_category, dimensions, case_pack,
  // unit_of_measure, ingredients — so freeze-time deterministic matching and
  // run-time evidence extraction cannot diverge. V1 members stay identity-only;
  // price/inventory/images/search-keywords/arbitrary fields never appear.
  const isV2Distributor =
    distributorSource &&
    extV2 != null &&
    (memberProjection as ExecutionEvidenceProjectionMemberV2).extractionMethod === 'distributor_record_v2';
  if (isV2Distributor && extV2) {
    const merchMetadata = {
      ...(distributorMetadata ?? {}),
      merchandisingProvenance: (extV2 as { merchandisingProvenance?: Record<string, unknown> }).merchandisingProvenance ?? {},
    };
    if (extV2.description && extV2.description.trim()) {
      push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl: pageEvidenceUrl, sourceField: 'description', snippet: extV2.description.slice(0, 500), value: extV2.description, metadata: merchMetadata });
    }
    for (const bullet of extV2.bulletPoints ?? []) {
      if (!bullet || !String(bullet).trim()) continue;
      push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl: pageEvidenceUrl, sourceField: 'bullet_point', snippet: String(bullet).slice(0, 300), value: String(bullet), metadata: merchMetadata });
    }
    const merchScalars: Array<{ sourceField: string; value: string | null }> = [
      { sourceField: 'distributor_category', value: (extV2 as { distributorCategory?: string | null }).distributorCategory ?? null },
      { sourceField: 'dimensions', value: (extV2 as { dimensions?: string | null }).dimensions ?? null },
      { sourceField: 'case_pack', value: (extV2 as { casePack?: string | null }).casePack ?? null },
      { sourceField: 'unit_of_measure', value: (extV2 as { unitOfMeasure?: string | null }).unitOfMeasure ?? null },
      { sourceField: 'ingredients', value: (extV2 as { ingredients?: string | null }).ingredients ?? null },
    ];
    for (const item of merchScalars) {
      const trimmed = (item.value ?? '').trim();
      if (!trimmed) continue;
      push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl: pageEvidenceUrl, sourceField: item.sourceField, snippet: trimmed.slice(0, 300), value: trimmed, metadata: merchMetadata });
    }
  }

  if (!distributorSource) {
    if (ext.description && ext.description.trim()) {
      push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'description', snippet: ext.description.slice(0, 500), value: ext.description, metadata: { provenance: 'official_product_page' } });
    }
    for (const bullet of ext.bulletPoints) {
      if (!bullet || !bullet.trim()) continue;
      push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'bullet_point', snippet: String(bullet).slice(0, 300), value: String(bullet), metadata: { provenance: 'official_product_page' } });
    }
    if (ext.searchKeywords && ext.searchKeywords.trim()) {
      push({ attributeId: null, source: pageSource, reliability: 'low', sourceUrl, sourceField: 'search_keywords', snippet: ext.searchKeywords.slice(0, 300), value: ext.searchKeywords, metadata: { provenance: 'product_data' } });
    }
    for (const [key, rawVal] of Object.entries(ext.customFields)) {
      const value = String(rawVal ?? '').trim();
      if (!value) continue;
      push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: key, snippet: value.slice(0, 300), value, metadata: { provenance: 'product_data' } });
    }
  }

  // ── FROZEN packaging OCR materialization (NO model call) ────────────────
  const frozenOcr = ext.ocr;
  const ocrInputHashMatches =
    frozenOcr.packagingOcrData != null &&
    hashCanonicalJson({
      sourceUrl: memberProjection.sourceUrl,
      extractionSourceUrl: memberProjection.extractionSourceUrl,
      primaryImage: ext.primaryImage,
      additionalImages: ext.additionalImages,
    }) === frozenOcr.ocrInputHash;
  // Execution-authority binding: the freeze verified the stored OCR against
  // the member snapshot's plan/rule digest and persisted the digest into the
  // content-addressed projection. A projection without a digest predates the
  // binding (PR3 hardening) and is never materialized (fail-closed mirror).
  // PR12 review R1: when an EXPECTED digest is supplied, the stored digest
  // must EXACTLY equal the CURRENT authority's digest — stale persisted OCR
  // (non-null but computed under an older authority) is rejected read-only.
  // PR13 C4 (the literal contract): `expected !== undefined ?
  // expected !== null && stored === expected : stored !== null` — an
  // explicitly supplied `null` expected digest rejects OCR ENTIRELY and can
  // NEVER match a stored `null` (a digest comparison under no expected
  // authority would bless unverifiable OCR).
  const executionDigestBound =
    options.expectedOcrExecutionDigest !== undefined
      ? options.expectedOcrExecutionDigest !== null &&
        frozenOcr.ocrExecutionDigest === options.expectedOcrExecutionDigest
      : frozenOcr.ocrExecutionDigest !== null;
  if (frozenOcr.packagingOcrData && ocrInputHashMatches && executionDigestBound) {
    const modelCallIds = frozenOcr.packagingOcrData.metadata?.modelCallIds;
    evidence.push(...packagingOcrDataToEvidence(frozenOcr.packagingOcrData, {
      runId,
      sku,
      model: frozenOcr.outcome?.model ?? 'unknown',
      ...(Array.isArray(modelCallIds) && modelCallIds.length > 0 ? { modelCallIds } : {}),
    }));
  }

  return evidence;
}

// ─── C3a: deterministic per-member match ─────────────────────────────────────

interface ScoredTypeMatch {
  match: DeterministicTypeMatchResult;
  /** The bounded evidence packet the keyword match was scored against. */
  packet: ReturnType<typeof buildEvidenceTargetPacket>;
}

/**
 * Shared scoring core: mirrors the per-SKU `processTargetInternal` keyword
 * path (`curation-target-processor.ts:585-610`) — a bounded general-text
 * evidence packet, `matchKeywordOptions` token-overlap scoring, and the
 * `KEYWORD_MATCH_MIN_CONFIDENCE` gate. No LLM fallback in this module (the
 * LLM ranker is run-bound and belongs to the freeze integration, C4a).
 */
function scoreTypeMatch(evidence: ClassificationEvidence[], options: ResolvedTargetOption[]): ScoredTypeMatch {
  const packet = buildEvidenceTargetPacket(evidence, {
    attributeId: null,
    sourceField: null,
    selectionMode: 'single',
    includeProductTypeContext: true,
  });
  const text = packet.promptText;
  if (options.length === 0 || !text || text.length < 3) {
    return { match: { productTypeId: null, confidence: null, source: null }, packet };
  }
  const keywordMatches = matchKeywordOptions({ options, text, selectionMode: 'single' });
  if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
    const top = keywordMatches[0];
    return { match: { productTypeId: top.value, confidence: top.confidence, source: 'keyword' }, packet };
  }
  return { match: { productTypeId: null, confidence: null, source: null }, packet };
}

/**
 * Deterministically match one member's evidence to the resolved product type
 * options (keyword/token overlap only; the LLM ranker fallback is run-bound
 * and lives in the freeze integration). Returns the matched id + confidence
 * when the top keyword match clears `KEYWORD_MATCH_MIN_CONFIDENCE`, else a
 * null result (abstention candidate — the caller's `confidenceFloor` may still
 * downgrade a confident match to an abstention).
 */
export function matchMemberDeterministically(
  memberEvidence: ClassificationEvidence[],
  options: ResolvedTargetOption[],
): DeterministicTypeMatchResult {
  return scoreTypeMatch(memberEvidence, options).match;
}

// ─── C3b: aggregation ────────────────────────────────────────────────────────

export interface CohortMemberInput {
  /** Frozen per-member execution-evidence projection (`execution-evidence-v1`). */
  projection: ExecutionEvidenceProjectionMemberV1;
  /** The member's immutable runtime snapshot (carries productTypes/curationTargets). */
  memberSnapshot: RuntimeClassificationSnapshot;
  /**
   * PR5 hardening (P1-2): the member's compatible reviewed Primary Product
   * Type id, derived from `memberSnapshot.reviewedFacts` (the freeze extracts
   * it via `getReviewedTypeFromSnapshot`; the resolver falls back to deriving
   * it from the snapshot when the caller omits it). Null/absent when the
   * member carries no reviewed type. Reviewed facts are provenance-compatible
   * BY CONSTRUCTION of the runtime snapshot, so no live-config re-check is
   * needed here.
   */
  reviewedTypeId?: string | null;
  /**
   * PR12 review R1: the CURRENT OCR execution-authority digest for the
   * member's snapshot, supplied by READ-ONLY callers (the shadow observer)
   * so persisted OCR is materialized ONLY when its stored
   * `ocrExecutionDigest` exactly equals the current authority — stale OCR is
   * rejected read-only, never re-run, never written. Absent for the freeze
   * (whose pull-forward already re-ran OCR under the current authority).
   */
  expectedOcrExecutionDigest?: string | null;
}

/**
 * A run-bound LLM ranker result for ONE member (PR4 C4a freeze integration,
 * DECISION-A: the model call is attached to the member child run via
 * `buildModelCallContext(memberSnapshot, childRunId, 'product_type_ranking', 1)`
 * — provenance identical to the member SKU stage). The LLM is a FALLBACK: it
 * is applied only when the deterministic keyword match is absent or below the
 * caller's confidence floor, and a failing/unavailable LLM path abstains
 * (fail-closed — no silent type from a failed model path).
 */
export interface MemberLlmRankResult {
  /** The LLM-chosen product type id (one of the member's resolved options). */
  productTypeId: string;
  /** The LLM ranker confidence (0..1). */
  confidence: number;
}

export interface ResolveCohortProductTypeInput {
  /** One entry per finalized cohort member, any order. */
  members: CohortMemberInput[];
  /**
   * Confidence floor (0..1) — a member result below it counts as an
   * abstention (architecture-report §2.2; env-tunable in C5). The matcher's
   * own `KEYWORD_MATCH_MIN_CONFIDENCE` gate still applies per member.
   */
  confidenceFloor: number;
  /**
   * Optional per-member LLM ranker results (PR4 C4a freeze integration): the
   * freeze runs the run-bound `product_type_ranking` fallback for members
   * whose deterministic keyword match is absent or below the floor, then
   * passes the results here. Aligned with `members` (same length + order;
   * null entry = no LLM result for that member). The aggregation applies an
   * LLM result ONLY when the member's deterministic match is absent or below
   * the floor — a confident keyword match always wins (deterministic-first,
   * exactly like the per-SKU `processTargetInternal`). Pure input: the caller
   * already made the run-bound model call; this module never invokes a model.
   */
  memberLlmResults?: Array<MemberLlmRankResult | null>;
}

/**
 * Per-member resolution result. `productTypeId`/`confidence`/`source` carry
 * the RAW deterministic match (null when the keyword matcher produced no
 * confident match); `isAbstention` is the floor-normalized view used by the
 * aggregation — a raw match below `confidenceFloor` counts as an abstention
 * while its values stay visible for diagnostics.
 */
export interface PerMemberProductTypeResult {
  onboardingItemId: string;
  productSku: string | null;
  /**
   * The member's contribution id: the compatible reviewed Product Type when
   * present, else the raw inferred match, else null. A below-floor raw match
   * stays visible here (its values are diagnostics; `isAbstention` is the
   * floor-normalized view the aggregation uses).
   */
  productTypeId: string | null;
  /**
   * Contribution confidence: 1.0 for a reviewed contribution (an accepted
   * decision carries maximum certainty — the min-aggregation is unaffected
   * whenever any inferred sibling exists), else the raw inferred confidence.
   */
  confidence: number | null;
  /**
   * 'reviewed' when a compatible reviewed type drives the contribution,
   * 'keyword' when the deterministic matcher produced the match, 'llm' when
   * the freeze-time run-bound ranker did, 'none' when the member has no
   * contribution at all (no match and no reviewed type).
   */
  source: 'reviewed' | 'keyword' | 'llm' | 'none';
  /**
   * PR5 hardening (P1-2): the member's compatible reviewed Primary Product
   * Type id from the snapshot's provenance-compatible reviewed facts, or
   * null. The family_invariant coherence rules (reviewed-vs-reviewed,
   * reviewed-vs-inferred) aggregate over this field.
   */
  reviewedTypeId: string | null;
  /**
   * PR5 hardening: the member's RAW confident inferred type id (keyword/LLM
   * match), retained for conflict diagnostics when a reviewed contribution
   * overrides it. Null for reviewed-driven contributions that had no
   * inference and for members without any confident inference. Never drives
   * aggregation — `productTypeId` is the contribution.
   */
  inferredTypeId: string | null;
  /** True when the member contributes no id (no reviewed type AND no
   *  confident inference). */
  isAbstention: boolean;
  /**
   * Evidence ids that drove the member's raw inferred match (the bounded
   * packet the keyword score was computed over). Empty for abstentions and
   * for reviewed contributions (a reviewed fact carries its own decision
   * provenance, not the evidence packet) — the pure keyword matcher has no
   * contradiction signal, so member-level `contradictingEvidenceIds` is
   * always [].
   */
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

/** Non-abstention refinement used by the aggregation (id + confidence non-null). */
export type ConfidentMemberProductTypeResult = PerMemberProductTypeResult & {
  productTypeId: string;
  confidence: number;
  source: 'reviewed' | 'keyword' | 'llm';
};

/** Member support for the resolved type: confident members vs total members. */
export interface CohortTypeMemberSupport {
  confidentCount: number;
  memberCount: number;
}

interface CohortProductTypeResolutionBase {
  /** The cohort-level outcome (architecture-report §2.4). */
  outcome: 'coherent' | 'coherent_with_abstentions' | 'conflicted' | 'abstained';
  /** The resolved Product Type id — ONLY set for coherent outcomes (never majority-forced). */
  productTypeId: string | null;
  /** min(confident member confidences) — only set for coherent outcomes. */
  confidence: number | null;
  memberSupport: CohortTypeMemberSupport;
  /** Evidence ids supporting the resolved type (union over confident members). */
  supportingEvidenceIds: string[];
  /**
   * Evidence ids contradicting the resolved type: always [] for coherent
   * outcomes; for `conflicted`, the union of every confident member's
   * supporting ids (each side's evidence contradicts the other's — never
   * resolved by source order or majority).
   */
  contradictingEvidenceIds: string[];
  /** Per-member raw results, in input order. */
  perMember: PerMemberProductTypeResult[];
  /** The floor the aggregation applied. */
  confidenceFloor: number;
}

export type CohortProductTypeResolution =
  | (CohortProductTypeResolutionBase & { outcome: 'coherent'; productTypeId: string; confidence: number })
  | (CohortProductTypeResolutionBase & { outcome: 'coherent_with_abstentions'; productTypeId: string; confidence: number })
  | (CohortProductTypeResolutionBase & { outcome: 'conflicted'; productTypeId: null; confidence: null })
  | (CohortProductTypeResolutionBase & { outcome: 'abstained'; productTypeId: null; confidence: null });

/** Confidence assigned to a reviewed contribution: an accepted (reviewed)
 *  decision carries maximum certainty. The cohort min-aggregation is
 *  unaffected whenever any inferred sibling exists, and a fully-reviewed
 *  coherent cohort reports 1.0. */
const REVIEWED_CONTRIBUTION_CONFIDENCE = 1;

/** Normalize a reviewed type id: null/undefined and empty strings are absent
 *  (fail closed, never a lookup key — mirrors `getReviewedTypeFromSnapshot`). */
function normalizeReviewedTypeId(id: string | null | undefined): string | null {
  if (id === null || id === undefined || id.length === 0) return null;
  return id;
}

/**
 * Per-member internal resolution: the compatible reviewed type AND the raw
 * floor-gated inferred match, kept separate so the aggregation can apply the
 * PR5 hardening (P1-2) reviewed-fact coherence rules (a reviewed type and a
 * differing confident inference must conflict, never silently coexist).
 */
interface MemberResolution {
  onboardingItemId: string;
  productSku: string | null;
  /** Compatible reviewed Primary Product Type id (normalized), or null. */
  reviewedTypeId: string | null;
  /** Raw inferred id (keyword/LLM), or null when no match at all. */
  inferredTypeId: string | null;
  /** Raw inferred confidence, or null when no match at all. */
  inferredConfidence: number | null;
  /** Raw inferred source — 'keyword'/'llm', 'none' when no match at all. */
  inferredSource: 'keyword' | 'llm' | 'none';
  /** True when the raw inference contributes no confident id (no match, or confidence < floor). */
  inferredAbstention: boolean;
  /** Evidence packet ids behind the raw match ([] when no confident match). */
  supportingEvidenceIds: string[];
}

/**
 * Resolve the cohort-level Execution Product Type from frozen member evidence.
 * Pure aggregation with NO majority forcing:
 *
 * - every confident member agrees on one id            -> `coherent`
 * - >=1 confident match, >=1 abstainer, no contradiction -> `coherent_with_abstentions`
 *   (DECISION-C: an abstainer carries no counter-evidence)
 * - >=2 confident DISTINCT ids                         -> `conflicted` (id stays null)
 * - no confident match                                 -> `abstained` (incl. empty input)
 *
 * PR5 hardening (P1-2) — reviewed-fact coherence rules (Primary Product Type
 * is a family_invariant: it must resolve identically across finalized
 * members). The member's compatible reviewed type (from its snapshot's
 * provenance-compatible reviewed facts) participates at coherence time:
 *
 * - any two members' compatible reviewed types DIFFER          -> `conflicted`
 * - a member's reviewed type differs from the cohort's confident
 *   inferred type                                             -> `conflicted`
 *   (never silently coexist: the member would curate under one profile while
 *   the cohort execution type drives the siblings' profiles)
 * - a reviewed type agrees with the inferred type             -> `coherent`
 *   (the member's contribution source is 'reviewed')
 * - a reviewed type RESOLVES an otherwise-abstaining member   -> the member
 *   contributes that type; all members resolving to the same id (reviewed
 *   and/or inferred) -> `coherent` with that id.
 *
 * Product type options resolve per member from its frozen runtime snapshot
 * (`resolveTargetsFromSnapshot`); members with no enabled product-type target
 * or no options abstain. An empty members array resolves to `abstained`.
 */
export function resolveCohortProductType(input: ResolveCohortProductTypeInput): CohortProductTypeResolution {
  const { members, confidenceFloor, memberLlmResults } = input;
  const resolutions = members.map((member, index) =>
    resolveMemberResolution(member, confidenceFloor, memberLlmResults?.[index] ?? null),
  );
  const memberCount = resolutions.length;

  // Effective contribution view (reviewed-first — exactly like the PR5
  // effective curation type: a member with a compatible reviewed type
  // contributes that type with source 'reviewed').
  const perMember: PerMemberProductTypeResult[] = resolutions.map(res => ({
    onboardingItemId: res.onboardingItemId,
    productSku: res.productSku,
    productTypeId: res.reviewedTypeId ?? res.inferredTypeId,
    confidence: res.reviewedTypeId !== null ? REVIEWED_CONTRIBUTION_CONFIDENCE : res.inferredConfidence,
    source: res.reviewedTypeId !== null ? 'reviewed' : res.inferredSource,
    reviewedTypeId: res.reviewedTypeId,
    // PR5 hardening: the RAW confident inference stays visible for conflict
    // diagnostics even when a reviewed contribution overrides it (the
    // reviewed-first projection must never hide the inferred side of a
    // reviewed-vs-inference family conflict).
    inferredTypeId: res.reviewedTypeId !== null ? res.inferredTypeId : null,
    isAbstention: res.reviewedTypeId === null && res.inferredAbstention,
    supportingEvidenceIds: res.reviewedTypeId !== null ? [] : res.supportingEvidenceIds,
    contradictingEvidenceIds: [],
  }));

  const confident = perMember.filter(
    (member): member is ConfidentMemberProductTypeResult => !member.isAbstention,
  );
  const memberSupport: CohortTypeMemberSupport = { confidentCount: confident.length, memberCount };

  // ── PR5 hardening (P1-2): reviewed-fact coherence ──────────────────────────
  const reviewedIds = [...new Set(
    resolutions.map(res => res.reviewedTypeId).filter((id): id is string => id !== null),
  )];
  const confidentInferred = resolutions.filter(res => !res.inferredAbstention && res.inferredTypeId !== null);
  const unreviewedConfident = resolutions.filter(res => res.reviewedTypeId === null && !res.inferredAbstention && res.inferredTypeId !== null);
  const unreviewedInferredIds = [...new Set(unreviewedConfident.map(res => res.inferredTypeId as string))];

  // Rule 1: any two members' compatible reviewed types DIFFER -> conflicted.
  if (reviewedIds.length >= 2) {
    return {
      outcome: 'conflicted',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      // The contradicted side's evidence: every confident raw inference
      // (reviewed-first members keep their raw inferred packet on `res`).
      contradictingEvidenceIds: confidentInferred.flatMap(res => res.supportingEvidenceIds),
      perMember,
      confidenceFloor,
    };
  }
  // Rule 2: any member's confident inferred type differs from the cohort's reviewed type -> conflicted
  // (never silently coexist: a reviewed decision and a differing confident inference on any member must conflict).
  if (reviewedIds.length === 1 && confidentInferred.some(res => res.inferredTypeId !== reviewedIds[0])) {
    return {
      outcome: 'conflicted',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: confidentInferred.flatMap(res => res.supportingEvidenceIds),
      perMember,
      confidenceFloor,
    };
  }
  // Legacy rule (when no reviewed facts are present): >=2 confident DISTINCT inferred ids -> conflicted (id stays
  // null; each side's evidence contradicts the other's — never resolved by
  // source order or majority).
  if (reviewedIds.length === 0 && unreviewedInferredIds.length >= 2) {
    return {
      outcome: 'conflicted',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: confident.flatMap(member => member.supportingEvidenceIds),
      perMember,
      confidenceFloor,
    };
  }

  // Contribution ids after reviewed coherence: all reviewed ids agree with
  // each other and with every confident inference (a reviewed type may also
  // RESOLVE an otherwise-abstaining member). Only NON-abstaining members
  // contribute — a below-floor raw match stays visible on its result as a
  // diagnostic but never counts as a contribution.
  const contributionIds = [...new Set(
    confident.map(member => member.productTypeId).filter((id): id is string => id !== null),
  )];
  if (contributionIds.length === 0) {
    return {
      outcome: 'abstained',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      perMember,
      confidenceFloor,
    };
  }
  // Defensive: the reviewed rules above guarantee a single contribution id
  // here (any disagreement is a conflict); the >=2 case is never forced.
  if (contributionIds.length >= 2) {
    return {
      outcome: 'conflicted',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: confident.flatMap(member => member.supportingEvidenceIds),
      perMember,
      confidenceFloor,
    };
  }

  const productTypeId = contributionIds[0];
  const confidence = Math.min(...confident.map(member => member.confidence));
  const outcome = memberCount > confident.length ? 'coherent_with_abstentions' : 'coherent';

  return {
    outcome,
    productTypeId,
    confidence,
    memberSupport,
    supportingEvidenceIds: confident.flatMap(member => member.supportingEvidenceIds),
    contradictingEvidenceIds: [],
    perMember,
    confidenceFloor,
  };
}

function resolveMemberResolution(
  member: CohortMemberInput,
  confidenceFloor: number,
  llmResult?: MemberLlmRankResult | null,
): MemberResolution {
  const evidence = evidenceFromProjection(member.projection, {
    expectedOcrExecutionDigest: member.expectedOcrExecutionDigest,
  });
  const options = resolveProductTypeOptions(member.memberSnapshot);
  const { match, packet } = scoreTypeMatch(evidence, options);
  // LLM ranker fallback (PR4 C4a freeze integration, DECISION-A): applied ONLY
  // when the deterministic keyword match is absent or below the caller's
  // confidence floor — a confident deterministic match always wins, exactly
  // like the per-SKU stage (`processTargetInternal`: deterministic first, LLM
  // fallback). The LLM result's own confidence still passes through the floor
  // gate below (a sub-floor LLM match counts as an abstention).
  const belowFloor = match.productTypeId === null || match.confidence === null || match.confidence < confidenceFloor;
  // PR4 review fix (BLOCKER): `llmRankOptions` returns option LABELS, but the
  // persisted execution Product Type id must be the option's canonical VALUE
  // (pt.id). Map the LLM label back through the member's frozen options; no
  // exact match ⇒ the member abstains (fail closed — never an id guessed from
  // a display label). The freeze integration already canonicalizes, so an
  // already-canonical id passes through unchanged.
  const effective = belowFloor && llmResult
    ? mapLlmRankResultToMemberOption(llmResult, options)
    : match;
  // A null effective result (unmappable LLM label) is an abstention; a
  // below-floor match/LLM confidence also counts as an abstention (the raw
  // values stay visible for diagnostics).
  const isAbstention = effective === null
    || effective.productTypeId === null
    || effective.confidence === null
    || effective.confidence < confidenceFloor;

  // PR5 hardening (P1-2): the member's compatible reviewed Primary Product
  // Type. The freeze passes it explicitly (extracted from the snapshot's
  // provenance-compatible reviewed facts via `getReviewedTypeFromSnapshot`);
  // when omitted the resolver derives it from the snapshot itself so every
  // caller (shadow observer, tests) behaves identically.
  const reviewedTypeId = normalizeReviewedTypeId(
    member.reviewedTypeId ?? getReviewedTypeFromSnapshot(member.memberSnapshot),
  );

  return {
    onboardingItemId: member.projection.onboardingItemId,
    productSku: member.projection.productSku,
    reviewedTypeId,
    inferredTypeId: effective?.productTypeId ?? null,
    inferredConfidence: effective?.confidence ?? null,
    inferredSource: effective?.source ?? 'none',
    inferredAbstention: isAbstention,
    supportingEvidenceIds: isAbstention ? [] : packet.evidenceIds,
  };
}

/**
 * Map a run-bound LLM ranker result back to the member's frozen Product Type
 * option VALUE (pt.id). `llmRankOptions` prompts and normalizes exclusively
 * against `option.label` (`curation-target-ranker.ts`); the stored
 * `execution_product_type_id` must be the canonical `option.value`. An exact
 * value match passes through (the freeze integration already canonicalizes);
 * an exact label match maps to its value. A label matching NO frozen option,
 * or more than one (duplicate display labels are permitted by config
 * validation), is ambiguous → null: the member abstains (fail closed — a
 * label outside the frozen options is never turned into an id, and a
 * duplicate label never silently selects the first match).
 */
function mapLlmRankResultToMemberOption(
  llmResult: MemberLlmRankResult,
  options: ResolvedTargetOption[],
): { productTypeId: string; confidence: number; source: 'llm' } | null {
  const productTypeId = mapRankedLabelToOptionExactlyOne(llmResult.productTypeId, options);
  if (productTypeId === null) return null;
  return { productTypeId, confidence: llmResult.confidence, source: 'llm' as const };
}

/**
 * PR4 review fix (SHOULD-FIX): resolve a ranker-returned LABEL to the frozen
 * Product Type option VALUE, requiring EXACTLY ONE matching option. Duplicate
 * display labels are permitted by config validation (warning, not rejection),
 * so a label matching two options is ambiguous — return null and let the
 * member abstain, never pick the first. An exact canonical VALUE match passes
 * through unchanged (ids are unique by config validation; the exact-one guard
 * is defensive). Shared by the resolver and the freeze integration so both
 * label-mapping sites behave identically.
 */
export function mapRankedLabelToOptionExactlyOne(
  label: string,
  options: ResolvedTargetOption[],
): string | null {
  const byValue = options.filter(option => option.value === label);
  if (byValue.length === 1) return byValue[0].value;
  const byLabel = options.filter(option => option.label === label);
  if (byLabel.length === 1) return byLabel[0].value;
  // No exact match, or an ambiguous one (multiple values/labels) → abstain.
  return null;
}

/**
 * Resolve the member's product type options purely from its frozen runtime
 * snapshot (mirrors `primaryProductTypeStage`: the FIRST enabled product type
 * curation target, `curation-target-processor`/`primary-product-type.ts`).
 * Returns [] when no product type target is enabled or it has no options.
 */
function resolveProductTypeOptions(snapshot: RuntimeClassificationSnapshot): ResolvedTargetOption[] {
  const resolved = resolveTargetsFromSnapshot(snapshot);
  if (resolved.productTypes.length === 0) return [];
  return resolved.productTypes[0].options;
}

// ─── C3b: family invariant validator ─────────────────────────────────────────

export interface FamilyInvariantFinding {
  /** The family invariant target (ADR: Brand + Primary Product Type). */
  invariant: 'product_type' | 'brand';
  /**
   * 'error' = family-invariant violation (Product Type conflict); 'warning' =
   * visible finding only — PR4 never fails the cohort on Brand (Brand
   * coherence is not yet a resolver product; the finding is the PR9 seed).
   */
  severity: 'error' | 'warning';
  /** Machine-readable finding kind. */
  kind: 'disagreement';
  /** Human-readable summary. */
  message: string;
  /** Onboarding item ids of the members contributing to the finding. */
  memberIds: string[];
  /** The disagreeing values (product type ids / canonical brand identities). */
  values: string[];
}

/**
 * Post-hoc PURE family-invariant validator (architecture-report §4): asserts
 * (a) every member's execution type contribution agrees (or is a recorded
 * abstention) and (b) canonical Brand agreement across members via the shared
 * brand canonicalization (`resolveBrand`). Returns findings; NEVER mutates the
 * run/projection. Run in tests and shadow mode (C5); PR4 does not fail the
 * cohort on Brand.
 *
 * @param projection - The frozen `execution-evidence-v1` projection (member
 *   brand inputs come from `extraction.brand ?? spreadsheetIdentity.brandHint`,
 *   mirroring the frozen evidence stage).
 * @param memberResults - The `resolveCohortProductType` per-member results.
 * @param brands - The configured canonical brands (frozen in the member
 *   snapshots). Empty when none are configured: brand resolution yields no
 *   canonical ids and members are compared by their raw normalized brand
 *   strings, so a family mismatch stays visible.
 */
export function validateCohortFamilyInvariants(
  projection: ExecutionEvidenceProjection,
  memberResults: PerMemberProductTypeResult[],
  brands: BrandConfig[] = [],
): FamilyInvariantFinding[] {
  const findings: FamilyInvariantFinding[] = [];

  // (a) Product Type agreement finding — distinct confident ids = violation.
  const confident = memberResults.filter(
    (member): member is ConfidentMemberProductTypeResult => !member.isAbstention,
  );
  const distinctTypeIds = [...new Set(confident.map(member => member.productTypeId))];
  if (distinctTypeIds.length >= 2) {
    findings.push({
      invariant: 'product_type',
      severity: 'error',
      kind: 'disagreement',
      message: `Product Type family invariant violated: members resolved ${distinctTypeIds.length} distinct Product Types (${distinctTypeIds.join(', ')}).`,
      memberIds: confident.map(member => member.onboardingItemId),
      values: distinctTypeIds,
    });
  }

  // (b) Canonical Brand disagreement finding (shared brand canonicalization).
  const identityByMember = new Map<string, string>();
  for (const member of projection.members) {
    const brandInput = member.extraction.brand ?? member.spreadsheetIdentity.brandHint ?? null;
    const identity = canonicalBrandIdentity(brandInput, brands);
    if (identity === null) continue;
    identityByMember.set(member.onboardingItemId, identity);
  }
  const membersByIdentity = new Map<string, string[]>();
  for (const [memberId, identity] of identityByMember) {
    const ids = membersByIdentity.get(identity) ?? [];
    ids.push(memberId);
    membersByIdentity.set(identity, ids);
  }
  if (membersByIdentity.size >= 2) {
    const values = [...membersByIdentity.keys()].sort((a, b) => a.localeCompare(b));
    findings.push({
      invariant: 'brand',
      severity: 'warning',
      kind: 'disagreement',
      message: `Brand family invariant violated: members resolve to ${membersByIdentity.size} distinct canonical brands (${values.join(', ')}).`,
      memberIds: [...identityByMember.keys()],
      values,
    });
  }

  return findings;
}

/**
 * Canonical brand identity for one member: the shared `resolveBrand` result's
 * brandId when a configured canonical brand matches; otherwise a deterministic
 * raw identity (`unresolved:<normalized>`), so a family mismatch is visible
 * even before canonical brands are configured. Members with no brand input at
 * all contribute no identity (never a finding on their own).
 */
function canonicalBrandIdentity(brandInput: string | null, brands: BrandConfig[]): string | null {
  if (!brandInput || brandInput.trim().length === 0) return null;
  const resolved = resolveBrand(brandInput, brands);
  if (resolved) return resolved.brandId;
  return `unresolved:${brandInput.trim().toLowerCase()}`;
}
