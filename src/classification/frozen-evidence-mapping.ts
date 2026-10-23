/**
 * Shared frozen own-SKU evidence projection mapping (issue #361).
 *
 * One implementation owns repeated frozen-projection field selection,
 * source-specific provenance, and OCR input-hash/execution-digest
 * eligibility for BOTH the read-only freeze scan
 * (`evidenceFromProjection` in `cohort-product-type-resolver.ts`) and the
 * persisted member execution
 * (`executeFrozenEvidenceExtraction` in `stages/evidence-extraction.ts`).
 *
 * PURE by contract: no DB reads, no model calls, no persistence, no run
 * stamping, no brand resolution, no leases. Callers keep their read-only
 * versus persisted execution responsibilities and stamp
 * id/runId/stageName/productSku/capturedAt themselves; OCR conversion stays
 * in the shared `./ocr-evidence` converter (`packagingOcrDataToEvidence`),
 * which callers invoke with their own stamping after the shared
 * eligibility predicate passes.
 *
 * Semantics preserved verbatim from the two consumers:
 * - spreadsheet identity (name/expected_name/brand, `spreadsheet` source);
 * - operator-manual members (`manual_evidence_v1`) emit ONLY
 *   `operator_manual` entries with NULL URL + attestation metadata;
 * - distributor members emit ONLY identity fields (title/name, brand,
 *   weight, distributor SKU, MPN, variant attributes) plus, for verified
 *   `distributor_record_v2`, the explicit merchandising fields — all with
 *   `distributor_record` source, NULL URL, and distributor provenance;
 *   never `official_product_page`;
 * - official-page members emit identity + description/bullets/
 *   search_keywords (low)/custom fields with `official_product_page`
 *   source and the page URL;
 * - absent facts are skipped (never inferred); sibling facts are never
 *   read (SKU isolation is structural — the input is one member);
 * - frozen OCR materializes only when its recorded `ocrInputHash` matches
 *   the projection's own input set AND the execution-authority digest
 *   matches exactly (both non-null and equal; absent/null/mismatch
 *   excludes OCR);
 */

import { hashCanonicalJson } from '../shared/stable-id';
import type { ClassificationEvidence } from '../shared/schemas/classification';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
  ExecutionEvidenceProjectionMemberV3,
} from '../shared/schemas/cohorts';

/** Any versioned frozen member the mapping consumes (V1 normalizes to official-page). */
export type FrozenProjectionMember =
  | ExecutionEvidenceProjectionMemberV1
  | ExecutionEvidenceProjectionMemberV2
  | ExecutionEvidenceProjectionMemberV3;

/** Evidence entries without execution bookkeeping (owners stamp id/runId/stageName/productSku/capturedAt). */
export type FrozenEvidenceEntry = Omit<
  ClassificationEvidence,
  'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'
>;

/**
 * Manual-evidence entries (parent #101, ticket #104 full set).
 *
 * Builds operator-manual evidence for the supplied fields ONLY (title,
 * brand, description, bullets, weight, dimensions, approved images; never
 * family-page facts, never synthesized copy). Every entry carries source
 * `operator_manual`, low reliability (manual transcription requires
 * Review), a NULL source URL, and attestation metadata. Pure helper —
 * unit-tested in isolation and wired into both the frozen and live
 * evidence paths.
 */
export interface ManualEvidenceEntryInput {
  title?: string | null;
  brand?: string | null;
  description?: string | null;
  bulletPoints?: string[] | null;
  weight?: string | null;
  dimensions?: string | null;
  primaryImage?: string | null;
  additionalImages?: string[] | null;
  attestationId: string;
  /**
   * Caller-supplied per-field attribution (may carry nulls for unattributed
   * distributor fields). Accepted but currently unused: emitted entries carry
   * a constant operator-manual provenance marker instead.
   */
  fieldProvenance: Record<string, string | null>;
  manualReferenceUrl: string | null;
}

export function buildManualEvidenceEntries(
  input: ManualEvidenceEntryInput,
): FrozenEvidenceEntry[] {
  const metadata = {
    provenance: 'manual_evidence',
    attestationId: input.attestationId,
    fieldProvenance: 'user',
    manualReferenceUrl: input.manualReferenceUrl,
  };
  const entries: FrozenEvidenceEntry[] = [];
  if (input.title && input.title.trim()) {
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'name',
      snippet: input.title.slice(0, 300),
      value: input.title,
      metadata,
    });
  }
  if (input.brand && input.brand.trim()) {
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'brand',
      snippet: input.brand.slice(0, 300),
      value: input.brand,
      metadata,
    });
  }
  if (input.description && input.description.trim()) {
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'description',
      snippet: input.description.slice(0, 500),
      value: input.description,
      metadata,
    });
  }
  for (const bullet of input.bulletPoints ?? []) {
    if (!bullet || !String(bullet).trim()) continue;
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'bullet_point',
      snippet: String(bullet).slice(0, 300),
      value: String(bullet),
      metadata,
    });
  }
  if (input.weight && input.weight.trim()) {
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'weight',
      snippet: input.weight.slice(0, 300),
      value: input.weight,
      metadata,
    });
  }
  if (input.dimensions && input.dimensions.trim()) {
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'dimensions',
      snippet: input.dimensions.slice(0, 300),
      value: input.dimensions,
      metadata,
    });
  }
  // Operator-approved images only: submit-time rights approvals are
  // enforced by the service and re-verified by the review gate. The URLs
  // are operator-supplied evidence, never distributor candidates.
  if (input.primaryImage && input.primaryImage.trim()) {
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'primary_image',
      snippet: input.primaryImage.slice(0, 300),
      value: input.primaryImage,
      metadata,
    });
  }
  for (const image of input.additionalImages ?? []) {
    if (!image || !String(image).trim()) continue;
    entries.push({
      attributeId: null,
      source: 'operator_manual',
      reliability: 'low',
      sourceUrl: null,
      sourceField: 'additional_image',
      snippet: String(image).slice(0, 300),
      value: String(image),
      metadata,
    });
  }
  return entries;
}

type FrozenV2Member = ExecutionEvidenceProjectionMemberV2 | ExecutionEvidenceProjectionMemberV3;

function isV2Member(member: FrozenProjectionMember): member is FrozenV2Member {
  return 'version' in member
    && (member.version === 'execution-evidence-v2' || member.version === 'execution-evidence-v3');
}

/** True when the member carries operator manual evidence (never automated/distributor mapping). */
export function isManualFrozenMember(member: FrozenProjectionMember): member is FrozenV2Member {
  return isV2Member(member) && member.extractionMethod === 'manual_evidence_v1';
}

/**
 * True for distributor-record members. Either the item-level or the
 * extraction-level source type selects distributor handling (the stronger,
 * claim-restricting side): such members are never labeled
 * `official_product_page`. V1 members (no source-type fields) normalize to
 * official-page.
 */
export function isDistributorFrozenMember(member: FrozenProjectionMember): member is FrozenV2Member {
  return isV2Member(member)
    && (member.itemSourceType === 'distributor_record' || member.extractionSourceType === 'distributor_record');
}

/** True for verified v2 distributor members that contribute explicit merchandising fields. */
function isMerchandisingDistributorMember(member: FrozenProjectionMember): member is FrozenV2Member {
  return isDistributorFrozenMember(member) && member.extractionMethod === 'distributor_record_v2';
}

type FrozenExtraction = ExecutionEvidenceProjectionMemberV2['extraction'];
type FrozenCommonExtraction = ExecutionEvidenceProjectionMemberV1['extraction'];

function memberStringArray(member: FrozenProjectionMember, key: 'acceptedEvidenceAttemptIds' | 'acceptedProviderIds'): string[] {
  if (!isV2Member(member)) return [];
  const values: unknown = member[key];
  if (!Array.isArray(values)) return [];
  return [...values].filter((v): v is string => typeof v === 'string').sort();
}

function memberNullableString(member: FrozenProjectionMember, key: 'sourcingGenerationId' | 'distributorEvidenceHash'): string | null {
  if (!isV2Member(member)) return null;
  const value: unknown = member[key];
  return typeof value === 'string' ? value : null;
}
/** Distributor provenance metadata (canonical keys consumed downstream). */
function distributorMetadataFor(member: FrozenV2Member, ext: FrozenExtraction): Record<string, unknown> {
  return {
    provenance: 'distributor_record',
    sourcingGenerationId: memberNullableString(member, 'sourcingGenerationId'),
    acceptedEvidenceAttemptIds: memberStringArray(member, 'acceptedEvidenceAttemptIds'),
    acceptedProviderIds: memberStringArray(member, 'acceptedProviderIds'),
    distributorEvidenceHash: memberNullableString(member, 'distributorEvidenceHash'),
    fieldProvenance: ext.fieldProvenance ?? {},
  };
}

/** Spreadsheet identity entries (`spreadsheet` source, NULL URL). */
export function buildFrozenSpreadsheetIdentity(member: FrozenProjectionMember): FrozenEvidenceEntry[] {
  const identity = member.spreadsheetIdentity;
  const entries: FrozenEvidenceEntry[] = [];
  entries.push({
    attributeId: null,
    source: 'spreadsheet',
    reliability: 'medium',
    sourceUrl: null,
    sourceField: 'name',
    snippet: identity.name.slice(0, 300),
    value: identity.name,
    metadata: { provenance: 'spreadsheet_import' },
  });
  if (identity.expectedName && identity.expectedName !== identity.name) {
    entries.push({
      attributeId: null,
      source: 'spreadsheet',
      reliability: 'medium',
      sourceUrl: null,
      sourceField: 'expected_name',
      snippet: identity.expectedName.slice(0, 300),
      value: identity.expectedName,
      metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' },
    });
  }
  if (identity.brandHint) {
    entries.push({
      attributeId: null,
      source: 'spreadsheet',
      reliability: 'medium',
      sourceUrl: null,
      sourceField: 'brand',
      snippet: identity.brandHint.slice(0, 300),
      value: identity.brandHint,
      metadata: { provenance: 'spreadsheet_import' },
    });
  }
  return entries;
}

function buildManualExtractionEntries(ext: FrozenExtraction): FrozenEvidenceEntry[] {
  return buildManualEvidenceEntries({
    title: ext.title,
    brand: ext.brand,
    description: ext.description,
    bulletPoints: ext.bulletPoints,
    weight: ext.weight,
    dimensions: ext.dimensions ?? null,
    primaryImage: ext.primaryImage,
    additionalImages: ext.additionalImages,
    attestationId: ext.manualEvidenceAttestationId ?? 'unknown',
    fieldProvenance: ext.fieldProvenance ?? {},
    manualReferenceUrl: ext.manualReferenceUrl ?? null,
  });
}

function pushTrimmed(
  entries: FrozenEvidenceEntry[],
  base: Omit<FrozenEvidenceEntry, 'sourceField' | 'snippet' | 'value'>,
  sourceField: string,
  rawValue: unknown,
  snippetLimit: number,
): void {
  const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
  if (!value.trim()) return;
  entries.push({ ...base, sourceField, snippet: value.slice(0, snippetLimit), value });
}

function buildDistributorExtractionEntries(
  member: FrozenV2Member,
  ext: FrozenExtraction,
): FrozenEvidenceEntry[] {
  const entries: FrozenEvidenceEntry[] = [];
  const metadata = distributorMetadataFor(member, ext);
  const base = {
    attributeId: null,
    source: 'distributor_record',
    reliability: 'medium',
    sourceUrl: null,
    metadata,
  } as const;
  pushTrimmed(entries, base, 'name', ext.title, 300);
  pushTrimmed(entries, base, 'brand', ext.brand, 300);
  pushTrimmed(entries, base, 'weight', ext.weight, 300);
  pushTrimmed(entries, base, 'distributor_sku', ext.distributorSku, 300);
  pushTrimmed(entries, base, 'manufacturer_part_number', ext.manufacturerPartNumber, 300);
  for (const [key, rawVal] of Object.entries(ext.variantAttributes ?? {})) {
    const value = String(rawVal ?? '').trim();
    if (!value) continue;
    entries.push({
      attributeId: null,
      source: 'distributor_record',
      reliability: 'medium',
      sourceUrl: null,
      sourceField: key,
      snippet: value.slice(0, 300),
      value,
      metadata,
    });
  }
  // Amendment B merchandising fields (M5b-1): a VERIFIED v2 distributor
  // member contributes the explicit merchandising fields with the same
  // distributor provenance — description, each feature as bullet_point,
  // distributor_category, dimensions, case_pack, unit_of_measure,
  // ingredients. V1 members stay identity-only. Price, inventory, images,
  // search keywords, claims inferred from copy, and arbitrary fields are
  // NEVER emitted; the classification URL stays null; nothing is labeled
  // `official_product_page`.
  if (isMerchandisingDistributorMember(member)) {
    const merchMetadata = {
      ...metadata,
      merchandisingProvenance: ext.merchandisingProvenance ?? {},
    };
    const merchBase = {
      attributeId: null,
      source: 'distributor_record',
      reliability: 'medium',
      sourceUrl: null,
      metadata: merchMetadata,
    } as const;
    pushTrimmed(entries, merchBase, 'description', ext.description, 500);
    for (const bullet of ext.bulletPoints ?? []) {
      if (!bullet || !String(bullet).trim()) continue;
      const text = String(bullet);
      entries.push({
        attributeId: null,
        source: 'distributor_record',
        reliability: 'medium',
        sourceUrl: null,
        sourceField: 'bullet_point',
        snippet: text.slice(0, 300),
        value: text,
        metadata: merchMetadata,
      });
    }
    pushTrimmed(entries, merchBase, 'distributor_category', ext.distributorCategory, 300);
    pushTrimmed(entries, merchBase, 'dimensions', ext.dimensions, 300);
    pushTrimmed(entries, merchBase, 'case_pack', ext.casePack, 300);
    pushTrimmed(entries, merchBase, 'unit_of_measure', ext.unitOfMeasure, 300);
    pushTrimmed(entries, merchBase, 'ingredients', ext.ingredients, 300);
  }
  return entries;
}

function buildOfficialPageExtractionEntries(
  member: FrozenProjectionMember,
  ext: FrozenCommonExtraction,
): FrozenEvidenceEntry[] {
  const entries: FrozenEvidenceEntry[] = [];
  const sourceUrl = member.sourceUrl;
  const pageBase = {
    attributeId: null,
    source: 'official_product_page',
    reliability: 'medium',
    sourceUrl,
  } as const;
  const pageProvenance = { provenance: 'official_product_page' };
  const dataProvenance = { provenance: 'product_data' };
  pushTrimmed(entries, { ...pageBase, metadata: pageProvenance }, 'name', ext.title, 300);
  pushTrimmed(entries, { ...pageBase, metadata: pageProvenance }, 'brand', ext.brand, 300);
  pushTrimmed(entries, { ...pageBase, metadata: pageProvenance }, 'weight', ext.weight, 300);
  pushTrimmed(entries, { ...pageBase, metadata: pageProvenance }, 'description', ext.description, 500);
  for (const bullet of ext.bulletPoints ?? []) {
    if (!bullet || !String(bullet).trim()) continue;
    const text = String(bullet);
    entries.push({
      attributeId: null,
      source: 'official_product_page',
      reliability: 'medium',
      sourceUrl,
      sourceField: 'bullet_point',
      snippet: text.slice(0, 300),
      value: text,
      metadata: pageProvenance,
    });
  }
  if (ext.searchKeywords && ext.searchKeywords.trim()) {
    entries.push({
      attributeId: null,
      source: 'official_product_page',
      reliability: 'low',
      sourceUrl,
      sourceField: 'search_keywords',
      snippet: ext.searchKeywords.slice(0, 300),
      value: ext.searchKeywords,
      metadata: dataProvenance,
    });
  }
  for (const [key, rawVal] of Object.entries(ext.customFields ?? {})) {
    const value = String(rawVal ?? '').trim();
    if (!value) continue;
    entries.push({
      attributeId: null,
      source: 'official_product_page',
      reliability: 'medium',
      sourceUrl,
      sourceField: key,
      snippet: value.slice(0, 300),
      value,
      metadata: dataProvenance,
    });
  }
  return entries;
}

/**
 * Normalized extraction entries for one frozen member (no spreadsheet
 * identity, no OCR, no brand resolution): operator-manual members emit ONLY
 * operator-manual entries; distributor members emit identity-only (+
 * verified-v2 merchandising) `distributor_record` entries; all others emit
 * the official-page mapping. Absent facts are skipped, never inferred.
 */
export function buildFrozenExtractionEntries(member: FrozenProjectionMember): FrozenEvidenceEntry[] {
  if (isManualFrozenMember(member)) return buildManualExtractionEntries(member.extraction);
  if (isDistributorFrozenMember(member)) return buildDistributorExtractionEntries(member, member.extraction);
  return buildOfficialPageExtractionEntries(member, member.extraction);
}

/**
 * Full text-evidence projection for one frozen member: spreadsheet
 * identity + normalized extraction entries. OCR, brand resolution, and all
 * execution bookkeeping stay with the callers.
 */
export function buildFrozenProjectionEntries(member: FrozenProjectionMember): FrozenEvidenceEntry[] {
  return [...buildFrozenSpreadsheetIdentity(member), ...buildFrozenExtractionEntries(member)];
}

// ─── Frozen OCR eligibility ─────────────────────────────────────────────────

/**
 * Consistently enforce frozen image/input-hash plus execution-digest
 * eligibility: stale, mismatched, or tampered OCR is excluded. Eligible
 * explicit package wording is materialized by the caller via the shared
 * `packagingOcrDataToEvidence` converter (which retains provenance).
 * The expected digest is the caller's execution authority (null when it
 * cannot be computed); OCR materializes only on exact non-null equality.
 */

export function isFrozenOcrEligible(
  member: FrozenProjectionMember,
  expectedOcrExecutionDigest: string | null,
): boolean {
  if (member.extraction.ocr?.packagingOcrData == null) return false;
  // Verify this member’s frozen images and source URLs: an execution
  // digest alone cannot authorize OCR captured for different inputs.
  const extraction = member.extraction;
  if (extraction.ocr?.ocrInputHash !== hashCanonicalJson({
    sourceUrl: member.sourceUrl ?? null,
    extractionSourceUrl: member.extractionSourceUrl ?? null,
    primaryImage: extraction.primaryImage ?? null,
    additionalImages: Array.isArray(extraction.additionalImages) ? extraction.additionalImages : [],
  })) return false;
  const stored = member.extraction.ocr?.ocrExecutionDigest ?? null;
  return (
    expectedOcrExecutionDigest !== null &&
    stored !== null &&
    stored === expectedOcrExecutionDigest
  );
}

/** Model attribution for the shared OCR converter (durable call ids ride ON the frozen OCR record). */
export function frozenOcrModelParams(member: FrozenProjectionMember): { model: string; modelCallIds?: string[] } {
  const ocr = member.extraction.ocr;
  const model = typeof ocr?.outcome?.model === 'string' ? ocr.outcome.model : 'unknown';
  const modelCallIds = ocr?.packagingOcrData?.metadata?.modelCallIds;
  if (modelCallIds !== undefined && modelCallIds.length > 0) {
    return { model, modelCallIds: [...modelCallIds] };
  }
  return { model };
}
