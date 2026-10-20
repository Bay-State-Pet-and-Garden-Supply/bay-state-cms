/**
 * Authority-preserving name-span contract (issue #365 follow-up).
 *
 * ONE mapping shared by generation (singleton name-consolidation stage,
 * cohort `memberTitleSpans`) and currentness (review-gate
 * `currentNameEligibleSpans`): identical field selection, ordering, and
 * normalization. The official-page `title`-vs-`name` divergence is resolved
 * exactly once here — frozen evidence historically emitted the official
 * title as `name`, live extraction emits it as `title`; readers accept both
 * in canonical-first order so a freshly generated decision hashes the same
 * bundle at review without edits.
 *
 * PURE by contract: no DB, no model calls, no persistence.
 */
import type { ClassificationEvidence } from '../shared/schemas/classification';
import type { NameEvidenceText } from './name-candidates';

/**
 * Shared span normalization: trim + length cap (empty skipped by callers).
 * Conservative by design — no casing or token changes here; candidate
 * assembly owns formatting.
 */
export function normalizeNameSpan(value: string, limit: number = NAME_SPAN_LIMIT): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/** Span text limit everywhere (frozen projection truncation + gate slice). */
export const NAME_SPAN_LIMIT = 500;

/** Register (spreadsheet identity) fields in span order. */
export const REGISTER_SPAN_FIELDS = ['name', 'expected_name'] as const;

/**
 * Official-page title fields in authority order: canonical `title` first,
 * legacy/frozen `name` second. First non-empty hit wins — never unioned.
 */
export const OFFICIAL_TITLE_SPAN_FIELDS = ['title', 'name'] as const;

/** Official-page structured weight field. */
export const OFFICIAL_WEIGHT_SPAN_FIELD = 'weight';

/**
 * Distributor span fields — mirrors the singleton stage
 * (`collectDistributorSignals` title/name + `collectDistributorVariantSignals`
 * size/capacity/weight/count/packCount/color) and the review gate's prior
 * set. Bullet/description text never feeds the title bundle.
 */
export const DISTRIBUTOR_SPAN_FIELDS = [
  'name',
  'title',
  'size',
  'capacity',
  'weight',
  'count',
  'packCount',
  'color',
] as const;

/**
 * OCR span fields in generation order — mirrors the singleton stage and
 * the review gate (`visual_product_evidence` name/weight/size/count/
 * flavor). The frozen cohort projection carries only the title/weight/
 * flavor subset; absent fields are skipped, never synthesized, so the
 * shared order keeps every bundle comparable.
 */
export const OCR_SPAN_FIELDS = ['name', 'weight', 'size', 'count', 'flavor'] as const;
/** Manual-evidence span source + field (operator-attested title). */
export const MANUAL_SPAN_SOURCE = 'operator_manual';
export const MANUAL_SPAN_FIELD = 'name';
/**
 * Authority-specific span inputs for the shared assembler below. Each naming
 * authority (singleton run-gateway evidence, frozen cohort projection,
 * merged title signals, live legacy item state) maps its source into this
 * shape; the assembler applies the ONE canonical eligibility filter,
 * normalization, and ordering so generation and review hash identical
 * bundles. Eligibility that is genuinely authority-specific (frozen vs live
 * vs merged provenance, distributor/manual routing) is resolved by the
 * CALLER when filling these fields — never inside the assembler.
 */
export interface NameSpanDistributorInput {
  value: string;
  evidenceId?: string;
}
export interface NameSpanFieldInput {
  value?: string | null;
  evidenceId?: string;
}
export interface NameSpanAssemblyParts {
  registerName?: string | null;
  expectedName?: string | null;
  registerNameEvidenceId?: string;
  expectedNameEvidenceId?: string;
  officialTitle?: string | null;
  officialWeight?: string | null;
  officialTitleEvidenceId?: string;
  officialWeightEvidenceId?: string;
  /** Distributor merchandising texts in caller order (titles, then variant attributes). */
  distributor?: NameSpanDistributorInput[];
  ocrTitle?: NameSpanFieldInput;
  ocrWeight?: NameSpanFieldInput;
  ocrSize?: NameSpanFieldInput;
  ocrCount?: NameSpanFieldInput;
  ocrFlavor?: NameSpanFieldInput;
  /**
   * OCR structured species values (issue #365, one span per value) and
   * product form (single value). Tagged kind species/form so the
   * candidate builder treats bare values as identity attributes, never
   * bodies — while the spans still join the hashed eligible bundle so
   * species/form drift invalidates reuse.
   */
  ocrSpecies?: NameSpanFieldInput[];
  ocrProductForm?: NameSpanFieldInput;
  manualTitle?: string | null;
  manualEvidenceId?: string;
}
/**
 * Push one normalized span (trim + NAME_SPAN_LIMIT, empty skipped). Shared
 * normalization: every authority's spans pass through exactly this.
 */
export function pushNameSpan(
  spans: NameEvidenceText[],
  channel: NameEvidenceText['channel'],
  value: string | null | undefined,
  evidenceId?: string,
): void {
  if (typeof value !== 'string') return;
  const span = normalizeNameSpan(value);
  if (!span) return;
  if (evidenceId !== undefined) spans.push({ channel, span, evidenceId });
  else spans.push({ channel, span });
}
/**
 * Push one kind-tagged span (issue #365 species/form): identical
 * normalization to pushNameSpan, plus the semantic kind the candidate
 * builder's attribute-only guard reads. Hash-neutral (the hash maps
 * channel+span only).
 */
export function pushKindSpan(
  spans: NameEvidenceText[],
  channel: NameEvidenceText['channel'],
  kind: 'species' | 'form',
  value: string | null | undefined,
  evidenceId?: string,
): void {
  if (typeof value !== 'string') return;
  const span = normalizeNameSpan(value);
  if (!span) return;
  if (evidenceId !== undefined) spans.push({ channel, span, evidenceId, kind });
  else spans.push({ channel, span, kind });
}
/**
 * Assemble eligible naming spans in the ONE canonical order: register
 * (name, then expected_name when it differs), official (title, then
 * weight), distributor merchandising (caller order), OCR (title, weight,
 * size, count, flavor, species values, form), manual. Bullet/description
 * free text never feeds the title bundle — callers omit it before calling.
 */
export function assembleNameSpans(parts: NameSpanAssemblyParts): NameEvidenceText[] {
  const spans: NameEvidenceText[] = [];
  pushNameSpan(spans, 'register', parts.registerName ?? null, parts.registerNameEvidenceId);
  const expected = typeof parts.expectedName === 'string' ? parts.expectedName.trim() : '';
  const raw = typeof parts.registerName === 'string' ? parts.registerName.trim() : '';
  if (expected && expected !== raw) {
    pushNameSpan(spans, 'register', parts.expectedName ?? null, parts.expectedNameEvidenceId);
  }
  pushNameSpan(spans, 'official', parts.officialTitle ?? null, parts.officialTitleEvidenceId);
  pushNameSpan(spans, 'official', parts.officialWeight ?? null, parts.officialWeightEvidenceId);
  for (const d of parts.distributor ?? []) {
    pushNameSpan(spans, 'distributor', d.value, d.evidenceId);
  }
  pushNameSpan(spans, 'ocr', parts.ocrTitle?.value ?? null, parts.ocrTitle?.evidenceId);
  pushNameSpan(spans, 'ocr', parts.ocrWeight?.value ?? null, parts.ocrWeight?.evidenceId);
  pushNameSpan(spans, 'ocr', parts.ocrSize?.value ?? null, parts.ocrSize?.evidenceId);
  pushNameSpan(spans, 'ocr', parts.ocrCount?.value ?? null, parts.ocrCount?.evidenceId);
  pushNameSpan(spans, 'ocr', parts.ocrFlavor?.value ?? null, parts.ocrFlavor?.evidenceId);
  for (const species of parts.ocrSpecies ?? []) {
    pushKindSpan(spans, 'ocr', 'species', species.value ?? null, species.evidenceId);
  }
  if (parts.ocrProductForm) {
    pushKindSpan(spans, 'ocr', 'form', parts.ocrProductForm.value ?? null, parts.ocrProductForm.evidenceId);
  }
  pushNameSpan(spans, 'manual', parts.manualTitle ?? null, parts.manualEvidenceId);
  return spans;
}

/**
 * First non-empty evidence text for a source across candidate fields in
 * order (authority order — canonical field first, legacy alias second).
 */
export function readFirstEvidenceText(
  evidence: ClassificationEvidence[],
  source: string,
  fields: readonly string[],
  limit: number = NAME_SPAN_LIMIT,
): string | null {
  for (const field of fields) {
    const hit = evidence.find(
      e => e.source === source && e.sourceField === field
        && typeof e.value === 'string' && (e.value as string).trim().length > 0,
    );
    if (hit) {
      const text = normalizeNameSpan(hit.value as string, limit);
      if (text) return text;
    }
  }
  return null;
}
