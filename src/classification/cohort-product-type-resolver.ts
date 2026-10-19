/**
 * Cohort-level Execution Product Type resolver (issue #30 PR4 C3).
 *
 * PURE module: builds per-member frozen evidence (the read-only freeze-scan
 * side of the shared frozen-evidence mapping in
 * `./frozen-evidence-mapping`), runs the deterministic keyword match, and
 * maps ranked labels — with NO DB reads, NO model calls, and NO persistence.
 *
 * Inputs are fully frozen: per-member `execution-evidence` projections
 * (`spreadsheetIdentity` + `extraction` + frozen packaging OCR) plus each
 * member's immutable runtime snapshot (product type options resolved via
 * `resolveTargetsFromSnapshot` — a pure snapshot reader; the DB-backed
 * `resolveEnabledTargets` is never called here).
 *
 * PR5 hardening (P1-2): a member's compatible reviewed Primary Product Type
 * (from its snapshot's provenance-compatible reviewed facts) participates at
 * coherence time as a family_invariant — any reviewed-vs-reviewed or
 * reviewed-vs-confident-inference disagreement is `conflicted` (never
 * silently coexist), an agreeing reviewed type contributes with source
 * 'reviewed', and a reviewed type may resolve an otherwise-abstaining member.
 */
import { randomUUID } from 'node:crypto';
import type {
  ClassificationEvidence,
} from '../shared/schemas/classification';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
  ExecutionEvidenceProjectionMemberV3,
} from '../shared/schemas/cohorts';
import { matchKeywordOptions } from './curation-target-matcher';
import { buildEvidenceTargetPacket } from './evidence-targeting';
import { type ResolvedTargetOption } from './curation-target-resolver';
import { packagingOcrDataToEvidence } from './ocr-evidence';
import {
  buildFrozenProjectionEntries,
  frozenOcrModelParams,
  isFrozenOcrEligible,
  type FrozenEvidenceEntry,
} from './frozen-evidence-mapping';

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
   * The EXPECTED OCR execution-authority digest for the snapshot the
   * evidence is being built under. OCR materializes ONLY on exact
   * non-null equality with the projection's frozen `ocrExecutionDigest`.
   * Absent/null/mismatch excludes OCR (fail closed); plaintext callers
   * without an authority digest never acquire OCR participation.
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
 * `execution-evidence` projection member — the read-only freeze-scan mirror
 * of the frozen-mode evidence stage (`executeFrozenEvidenceExtraction`)
 * WITHOUT persistence: no `onboarding_items` reads, no model calls, no
 * write-back. Text field selection, source/provenance labeling, and OCR
 * eligibility are the shared frozen-evidence mapping
 * (`./frozen-evidence-mapping`); conversion stays the shared PURE converter
 * in `./ocr-evidence`.
 *
 * The OCR is materialized ONLY when the projection's own input-hash binding
 * still matches (recomputed purely from frozen fields) AND the expected
 * execution-authority digest exactly equals the stored digest (both
 * non-null; absent/null/mismatch excludes OCR).
 */
export function evidenceFromProjection(
  memberProjection: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2 | ExecutionEvidenceProjectionMemberV3,
  options: EvidenceFromProjectionOptions = {},
): ClassificationEvidence[] {
  const evidence: ClassificationEvidence[] = [];
  const sku = options.productSku ?? memberProjection.productSku ?? '';
  const runId = options.runId ?? '';
  const push = (entry: FrozenEvidenceEntry): void => {
    evidence.push({
      ...entry,
      id: randomUUID(),
      runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      capturedAt: now(),
    } as ClassificationEvidence);
  };
  for (const entry of buildFrozenProjectionEntries(memberProjection)) {
    push(entry);
  }
  if (memberProjection.extraction.ocr?.packagingOcrData && isFrozenOcrEligible(memberProjection, options.expectedOcrExecutionDigest ?? null)) {
    const ocrParams = frozenOcrModelParams(memberProjection);
    evidence.push(...packagingOcrDataToEvidence(memberProjection.extraction.ocr.packagingOcrData, {
      runId,
      sku,
      model: ocrParams.model,
      ...(ocrParams.modelCallIds ? { modelCallIds: ocrParams.modelCallIds } : {}),
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
// ─── C3c: family-aware ranker context (issue #304) ────────────────────────────
// SKU-local factual authority is preserved: every member is still classified
// from its OWN evidence (no borrowing, no family conclusion, no force-type,
// no veto). The context below is PROMPT context only for the run-bound
// ranker: when a terse member title cannot carry the dry/wet signal on its
// own, the ranker sees the family's confident verdicts as disambiguating
// context. The model still decides from the member's own evidence.
// Sibling divergence without consensus, and own-evidence deterministic
// matches, are never touched by this context.

/** Confident sibling verdicts for ranker context (strongest first). */
export interface SiblingProductTypeContext {
  siblings: Array<{ productTypeId: string; label: string; confidence: number }>;
}

/**
 * Derive confident sibling types from frozen product-line snapshots (the
 * same `productLineItems` the pipeline already threads). Each sibling's
 * frozen name/webTitle/brand/description/flavor/productForm text is scored
 * with the shared keyword matcher; only matches clearing
 * `KEYWORD_MATCH_MIN_CONFIDENCE` contribute. Returns null when no sibling is
 * confident (the ranker then runs exactly as today). Pure: no DB, no model.
 */
export function buildSiblingProductTypeContextFromLineItems(
  productLineItems: ReadonlyArray<{
    sku: string;
    name: string;
    webTitle: string | null;
    brand: string | null;
    description: string;
    flavor: string | null;
    productForm: string | null;
  }> | undefined,
  currentSku: string,
  options: ResolvedTargetOption[],
): SiblingProductTypeContext | null {
  if (!productLineItems || productLineItems.length === 0 || options.length === 0) return null;
  const siblings: Array<{ productTypeId: string; label: string; confidence: number }> = [];
  for (const item of productLineItems) {
    if (!item.sku || item.sku === currentSku) continue;
    const text = [item.name, item.webTitle, item.brand, item.description, item.flavor, item.productForm]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' ');
    if (text.trim().length < 3) continue;
    const matches = matchKeywordOptions({ options, text, selectionMode: 'single' });
    const top = matches[0];
    if (top && top.confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
      siblings.push({ productTypeId: top.value, label: top.label, confidence: top.confidence });
    }
  }
  if (siblings.length === 0) return null;
  siblings.sort((a, b) => b.confidence - a.confidence || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { siblings: siblings.slice(0, 3) };
}

// ─── C3b: aggregation REMOVED (issue #351 SKU-local evidence) ─────────────────
// Cross-member aggregation to a cohort/family Product Type conclusion lived
// here and is removed as factual authority — each SKU is classified from
// its own evidence. Per-member deterministic matching
// (`matchMemberDeterministically`, `scoreTypeMatch`) stays above for
// SKU-local reuse; label mapping stays below. Sibling divergence remains a
// read-only advisory (consistency-validator), never a freeze failure or
// readiness veto.

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

// ─── C3b: family invariant validator REMOVED (issue #351 SKU-local evidence) ───
// `validateCohortFamilyInvariants` + `canonicalBrandIdentity` lived here.
// Cross-member Brand/type agreement is never a freeze failure — Brand
// coherence stays in `cohort-semantic-validator.validateCohortBrandCoherence`
// (post-loop, member-scoped) and type divergence stays a read-only advisory.
