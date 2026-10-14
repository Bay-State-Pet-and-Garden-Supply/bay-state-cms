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
} from '../shared/schemas/classification';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../shared/schemas/cohorts';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { matchKeywordOptions } from './curation-target-matcher';
import { buildEvidenceTargetPacket } from './evidence-targeting';
import { type ResolvedTargetOption } from './curation-target-resolver';
import { packagingOcrDataToEvidence } from './ocr-evidence';
import { collectTypeVetoSignals, titleTextFromEvidence, vetoMetaFromTypeNode, vetoTypeCandidate } from './product-type-veto';

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

// ─── C3a helpers (complexity/duplication extraction) ─────────────────────────
// Each helper is intentionally tiny (<60 lines, <20 cyclomatic) so the Fallow
// complexity gate passes per-function. Behavior preserved verbatim: same
// field mapping, same ordering, same confidence floors, same OCR binding.
// Frozen execution hashes unchanged — helpers only hoist byte-identical blocks.

type ProjectionEvidenceContext = {
  sku: string;
  runId: string;
  sourceUrl: string | null;
  ext: ExecutionEvidenceProjectionMemberV1['extraction'];
  identity: ExecutionEvidenceProjectionMemberV1['spreadsheetIdentity'];
  extV2: ExecutionEvidenceProjectionMemberV2['extraction'] | null;
  distributorSource: boolean;
  distributorMetadata: Record<string, unknown> | undefined;
  pageSource: ClassificationEvidence['source'];
  pageEvidenceUrl: string | null;
};

function resolveProjectionEvidenceContext(
  memberProjection: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
  options: EvidenceFromProjectionOptions,
): ProjectionEvidenceContext {
  const sku = options.productSku ?? memberProjection.productSku ?? '';
  const runId = options.runId ?? '';
  const sourceUrl = memberProjection.sourceUrl;
  const ext = memberProjection.extraction;
  const identity = memberProjection.spreadsheetIdentity;
  const extV2 =
    'itemSourceType' in memberProjection
      ? (memberProjection as ExecutionEvidenceProjectionMemberV2).extraction
      : null;
  const sourceProvenance = sourceProvenanceFromMember(memberProjection);
  const distributorSource = sourceProvenance.itemSourceType === 'distributor_record';
  const distributorMetadata = distributorSource
    ? {
        provenance: 'distributor_record',
        providerIds: sourceProvenance.providerIds,
        acceptedEvidenceAttemptIds: sourceProvenance.acceptedEvidenceAttemptIds,
        sourcingGenerationId: sourceProvenance.sourcingGenerationId,
        evidenceHash: sourceProvenance.distributorEvidenceHash,
        fieldProvenance: ext.fieldProvenance ?? {},
      }
    : undefined;
  const pageSource: ClassificationEvidence['source'] = distributorSource
    ? 'distributor_record'
    : 'official_product_page';
  const pageEvidenceUrl = distributorSource ? null : sourceUrl;
  return { sku, runId, sourceUrl, ext, identity, extV2, distributorSource, distributorMetadata, pageSource, pageEvidenceUrl };
}

type EvidencePush = (entry: Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>) => void;

function pushSpreadsheetIdentity(push: EvidencePush, identity: ProjectionEvidenceContext['identity']): void {
  push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: identity.name.slice(0, 300), value: identity.name, metadata: { provenance: 'spreadsheet_import' } });
  if (identity.expectedName && identity.expectedName !== identity.name) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'expected_name', snippet: identity.expectedName.slice(0, 300), value: identity.expectedName, metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' } });
  }
  if (identity.brandHint) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'brand', snippet: identity.brandHint.slice(0, 300), value: identity.brandHint, metadata: { provenance: 'spreadsheet_import' } });
  }
}

type ProjectionIdentityField = { field: string; value: string; sourceField: string; snippet: string };

function collectBaseIdentityFields(ext: ProjectionEvidenceContext['ext']): ProjectionIdentityField[] {
  const fields: ProjectionIdentityField[] = [];
  if (ext.title && ext.title.trim()) {
    fields.push({ field: 'name', value: ext.title, sourceField: 'name', snippet: ext.title.slice(0, 300) });
  }
  if (ext.brand && ext.brand.trim()) {
    fields.push({ field: 'brand', value: ext.brand, sourceField: 'brand', snippet: ext.brand.slice(0, 300) });
  }
  if (ext.weight && ext.weight.trim()) {
    fields.push({ field: 'weight', value: ext.weight, sourceField: 'weight', snippet: ext.weight.slice(0, 300) });
  }
  return fields;
}

function collectDistributorIdentityFields(
  extV2: ProjectionEvidenceContext['extV2'],
): ProjectionIdentityField[] {
  const fields: ProjectionIdentityField[] = [];
  if (extV2?.distributorSku && extV2.distributorSku.trim()) {
    fields.push({ field: 'distributorSku', value: extV2.distributorSku, sourceField: 'distributor_sku', snippet: extV2.distributorSku.slice(0, 300) });
  }
  if (extV2?.manufacturerPartNumber && extV2.manufacturerPartNumber.trim()) {
    fields.push({ field: 'manufacturerPartNumber', value: extV2.manufacturerPartNumber, sourceField: 'manufacturer_part_number', snippet: extV2.manufacturerPartNumber.slice(0, 300) });
  }
  for (const [key, rawVal] of Object.entries(extV2?.variantAttributes ?? {})) {
    const value = String(rawVal ?? '').trim();
    if (!value) continue;
    fields.push({ field: key, value, sourceField: key, snippet: value.slice(0, 300) });
  }
  return fields;
}

function collectProjectionIdentityFields(ctx: ProjectionEvidenceContext): ProjectionIdentityField[] {
  const fields = collectBaseIdentityFields(ctx.ext);
  if (ctx.distributorSource) {
    fields.push(...collectDistributorIdentityFields(ctx.extV2));
  }
  return fields;
}

function pushIdentityFields(
  push: EvidencePush,
  identityFields: ProjectionIdentityField[],
  ctx: ProjectionEvidenceContext,
): void {
  for (const f of identityFields) {
    push({
      attributeId: null,
      source: ctx.pageSource,
      reliability: 'medium',
      sourceUrl: ctx.pageEvidenceUrl,
      sourceField: f.sourceField,
      snippet: f.snippet,
      value: f.value,
      metadata: ctx.distributorMetadata ?? { provenance: 'official_product_page' },
    });
  }
}

function pushMerchDescriptionBullets(
  push: EvidencePush,
  extV2: NonNullable<ProjectionEvidenceContext['extV2']>,
  pageSource: ClassificationEvidence['source'],
  pageEvidenceUrl: string | null,
  merchMetadata: Record<string, unknown>,
): void {
  if (extV2.description && extV2.description.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl: pageEvidenceUrl, sourceField: 'description', snippet: extV2.description.slice(0, 500), value: extV2.description, metadata: merchMetadata });
  }
  for (const bullet of extV2.bulletPoints ?? []) {
    if (!bullet || !String(bullet).trim()) continue;
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl: pageEvidenceUrl, sourceField: 'bullet_point', snippet: String(bullet).slice(0, 300), value: String(bullet), metadata: merchMetadata });
  }
}

function pushMerchScalars(
  push: EvidencePush,
  extV2: NonNullable<ProjectionEvidenceContext['extV2']>,
  pageSource: ClassificationEvidence['source'],
  pageEvidenceUrl: string | null,
  merchMetadata: Record<string, unknown>,
): void {
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

function pushDistributorMerchandising(
  push: EvidencePush,
  memberProjection: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
  ctx: ProjectionEvidenceContext,
): void {
  const { extV2, distributorSource, pageSource, pageEvidenceUrl, distributorMetadata } = ctx;
  const isV2Distributor =
    distributorSource &&
    extV2 != null &&
    (memberProjection as ExecutionEvidenceProjectionMemberV2).extractionMethod === 'distributor_record_v2';
  if (!isV2Distributor || !extV2) return;
  const merchMetadata = {
    ...(distributorMetadata ?? {}),
    merchandisingProvenance: (extV2 as { merchandisingProvenance?: Record<string, unknown> }).merchandisingProvenance ?? {},
  };
  pushMerchDescriptionBullets(push, extV2, pageSource, pageEvidenceUrl, merchMetadata);
  pushMerchScalars(push, extV2, pageSource, pageEvidenceUrl, merchMetadata);
}

function pushOfficialPageFields(push: EvidencePush, ctx: ProjectionEvidenceContext): void {
  const { ext, distributorSource, pageSource, sourceUrl } = ctx;
  if (distributorSource) return;
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

function ocrInputHashMatches(
  memberProjection: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
  ext: ProjectionEvidenceContext['ext'],
): boolean {
  const frozenOcr = ext.ocr;
  if (frozenOcr.packagingOcrData == null) return false;
  return hashCanonicalJson({
    sourceUrl: memberProjection.sourceUrl,
    extractionSourceUrl: memberProjection.extractionSourceUrl,
    primaryImage: ext.primaryImage,
    additionalImages: ext.additionalImages,
  }) === frozenOcr.ocrInputHash;
}

function ocrExecutionDigestBound(
  frozenOcr: ProjectionEvidenceContext['ext']['ocr'],
  expectedDigest: string | null | undefined,
  hasExpected: boolean,
): boolean {
  if (hasExpected) {
    return expectedDigest !== null && frozenOcr.ocrExecutionDigest === expectedDigest;
  }
  return frozenOcr.ocrExecutionDigest !== null;
}

function materializeFrozenOcr(
  evidence: ClassificationEvidence[],
  memberProjection: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
  ctx: ProjectionEvidenceContext,
  expectedDigest: string | null | undefined,
  hasExpected: boolean,
): void {
  const frozenOcr = ctx.ext.ocr;
  if (!frozenOcr.packagingOcrData) return;
  if (!ocrInputHashMatches(memberProjection, ctx.ext)) return;
  if (!ocrExecutionDigestBound(frozenOcr, expectedDigest, hasExpected)) return;
  const modelCallIds = frozenOcr.packagingOcrData.metadata?.modelCallIds;
  evidence.push(...packagingOcrDataToEvidence(frozenOcr.packagingOcrData, {
    runId: ctx.runId,
    sku: ctx.sku,
    model: frozenOcr.outcome?.model ?? 'unknown',
    ...(Array.isArray(modelCallIds) && modelCallIds.length > 0 ? { modelCallIds } : {}),
  }));
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
  const ctx = resolveProjectionEvidenceContext(memberProjection, options);

  const push: EvidencePush = (entry) => {
    evidence.push({
      ...entry,
      id: randomUUID(),
      runId: ctx.runId,
      stageName: 'evidence_extraction',
      productSku: ctx.sku,
      capturedAt: now(),
    } as ClassificationEvidence);
  };

  pushSpreadsheetIdentity(push, ctx.identity);
  pushIdentityFields(push, collectProjectionIdentityFields(ctx), ctx);
  pushDistributorMerchandising(push, memberProjection, ctx);
  pushOfficialPageFields(push, ctx);

  const hasExpected = options.expectedOcrExecutionDigest !== undefined;
  materializeFrozenOcr(evidence, memberProjection, ctx, options.expectedOcrExecutionDigest, hasExpected);

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
 * P1 #7: final candidate veto for one cohort member's raw inferred match.
 * Runs AFTER keyword/LLM selection: a contradicted winner abstains (null
 * match), never promotes the runner-up. Type nodes come from the member's
 * own frozen snapshot productTypes (generic v9/v10 node shapes).
 */
export function vetoMemberTypeMatch(input: {
  match: { productTypeId: string | null; confidence: number | null; source: 'keyword' | 'llm' | 'jev' | null };
  memberEvidence: ClassificationEvidence[];
  memberSnapshot: RuntimeClassificationSnapshot;
}): { productTypeId: string | null; confidence: number | null; source: 'keyword' | 'llm' | 'jev' | null } {
  const { match, memberEvidence, memberSnapshot } = input;
  if (!match.productTypeId) return match;
  const signals = collectTypeVetoSignals(titleTextFromEvidence(memberEvidence));
  const nodes = (memberSnapshot.productTypes ?? []) as Array<{
    id: string;
    scope?: { animalDomain?: string } | null;
    invariantAttributes?: Record<string, string | string[]>;
  }>;
  const node = nodes.find(n => n.id === match.productTypeId);
  const meta = node ? vetoMetaFromTypeNode(node) : { id: match.productTypeId };
  const veto = vetoTypeCandidate(meta, signals);
  if (!veto.vetoed) return match;
  return { productTypeId: null, confidence: null, source: null };
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

// ─── C3b: aggregation REMOVED (issue #351 SKU-local evidence) ─────────────────
// `resolveCohortProductType` + reviewed-coherence aggregation +
// `REVIEWED_CONTRIBUTION_CONFIDENCE` lived here. Cross-member aggregation
// to a cohort/family Product Type conclusion is removed as factual
// authority — each SKU is classified from its own evidence. Per-member
// deterministic matching (`matchMemberDeterministically`, `scoreTypeMatch`)
// stays above for SKU-local reuse; label mapping stays below. Sibling
// divergence remains a read-only advisory (consistency-validator), never a
// freeze failure or readiness veto.

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
