import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { findExtractionSourceRowById, setItemExtractionDataJson } from '../../db/repositories/onboarding-item-repo';
import { extractProductEvidence, packagingOcrDataToEvidence } from '../product-evidence-extractor';
import type { NormalizedEvidenceInput, EvidenceInputField } from '../product-evidence-extractor';
import { resolveBrand } from '../brand-resolution';
import { CanonicalBrandEvidenceValueSchema } from '../../shared/schemas/classification';
import { hashCanonicalJson } from '../../shared/stable-id';
import { computeOcrExecutionDigest } from '../runtime-snapshot';
import { getAuthoritativePackagingOcrStageOutput } from './packaging-ocr-stage';
import type { ExecutionEvidenceProjectionMemberV2 } from '../../shared/schemas/cohorts';
import type { ClassificationEvidence } from '../../shared/types';
import * as crypto from 'node:crypto';

const now = () => new Date().toISOString();

/**
 * Manual-evidence entries (parent #101, ticket #104 full set).
 *
 * Builds operator-manual evidence for the supplied fields ONLY (title,
 * brand, description, bullets, weight, dimensions, approved images; never
 * family-page facts, never synthesized copy). Every entry carries source
 * `operator_manual`, low reliability (manual transcription requires
 * Review), a NULL source URL, and attestation metadata. Pure helper —
 * unit-tested in isolation and wired into both the frozen and live
 * evidence paths below.
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
  fieldProvenance: Record<string, string>;
  manualReferenceUrl: string | null;
}

export function buildManualEvidenceEntries(
  input: ManualEvidenceEntryInput,
): Array<Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>> {
  const metadata = {
    provenance: 'manual_evidence',
    attestationId: input.attestationId,
    fieldProvenance: 'user',
    manualReferenceUrl: input.manualReferenceUrl,
  };
  const entries: Array<Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>> = [];
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

/**
 * Prepared-cohort (frozen) evidence extraction (issue #30 PR3 M2, amendment 4).
 *
 * When `StageContext` carries the member's frozen execution-evidence
 * projection (`cohortFrozenEvidence`), this stage builds evidence ONLY from
 * the projection's `spreadsheetIdentity` + `extraction` fields — it must NOT
 * query `onboarding_items` for semantic evidence, and it materializes
 * `classification_evidence` from the FROZEN stored packaging OCR via
 * `packagingOcrDataToEvidence` WITHOUT a model call. The OCR is trusted only
 * when its recorded `ocrInputHash` still matches the projection's own input
 * set (source/image set the attempt was started against) — a mismatch means
 * the stored OCR belongs to different inputs and is never materialized.
 */
function executeFrozenEvidenceExtraction(
  input: StageInput,
  context: StageContext,
  frozen: ExecutionEvidenceProjectionMemberV2,
): StageResult {
  const evidence: ClassificationEvidence[] = [];
  const sku = input.sku;
  const sourceUrl = frozen.sourceUrl;
  const ext = frozen.extraction;
  const identity = frozen.spreadsheetIdentity;

  const push = (entry: Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>): void => {
    evidence.push({
      ...entry,
      id: crypto.randomUUID(),
      runId: context.runId,
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

  // ── Normalized extraction fields (source-aware, Amendment A) ───────────
  // Distributor-record sources emit ONLY identity fields (title/name, brand,
  // weight, distributor SKU, MPN, whitelisted variant attributes) with source
  // `distributor_record`, a NULL classification URL, and metadata carrying the
  // sorted attempt/provider ids, generation, evidence hash, and per-field
  // provenance. Description/bullets/search-keywords/copy are NEVER emitted
  // for distributor sources, and nothing is ever labeled
  // `official_product_page` for them.
  // Parent #101 (manual-evidence route): operator-transcribed members emit
  // ONLY operator-manual evidence (full set in ticket #104) with a NULL
  // classification URL and the attestation id in metadata. The automated
  // and distributor branches below are byte-identical for all non-manual
  // members; the review gate re-verifies the attestation join.
  const isManualEvidence = frozen.extractionMethod === 'manual_evidence_v1';
  if (isManualEvidence) {
    const manualExt = frozen.extraction as typeof frozen.extraction & {
      manualEvidenceAttestationId?: string | null;
      manualReferenceUrl?: string | null;
    };
    for (const entry of buildManualEvidenceEntries({
      title: ext.title,
      brand: ext.brand,
      description: ext.description,
      bulletPoints: ext.bulletPoints,
      weight: ext.weight,
      dimensions: (ext as { dimensions?: string | null }).dimensions ?? null,
      primaryImage: ext.primaryImage,
      additionalImages: ext.additionalImages,
      attestationId: manualExt.manualEvidenceAttestationId ?? 'unknown',
      fieldProvenance: ext.fieldProvenance ?? {},
      manualReferenceUrl: manualExt.manualReferenceUrl ?? null,
    })) {
      push(entry);
    }
  }
  const isDistributor = frozen.itemSourceType === 'distributor_record' || frozen.extractionSourceType === 'distributor_record';
  if (!isManualEvidence && isDistributor) {
    const distributorMetadata = {
      provenance: 'distributor_record',
      sourcingGenerationId: frozen.sourcingGenerationId ?? null,
      acceptedEvidenceAttemptIds: frozen.acceptedEvidenceAttemptIds,
      acceptedProviderIds: frozen.acceptedProviderIds,
      distributorEvidenceHash: frozen.distributorEvidenceHash ?? null,
      fieldProvenance: ext.fieldProvenance ?? {},
    };
    const distributorSource: ClassificationEvidence['source'] = 'distributor_record';
    if (ext.title && ext.title.trim()) {
      push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: ext.title.slice(0, 300), value: ext.title, metadata: distributorMetadata });
    }
    if (ext.brand && ext.brand.trim()) {
      push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'brand', snippet: ext.brand.slice(0, 300), value: ext.brand, metadata: distributorMetadata });
    }
    if (ext.weight && ext.weight.trim()) {
      push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'weight', snippet: ext.weight.slice(0, 300), value: ext.weight, metadata: distributorMetadata });
    }
    if (ext.distributorSku && ext.distributorSku.trim()) {
      push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'distributor_sku', snippet: ext.distributorSku.slice(0, 300), value: ext.distributorSku, metadata: distributorMetadata });
    }
    if (ext.manufacturerPartNumber && ext.manufacturerPartNumber.trim()) {
      push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'manufacturer_part_number', snippet: ext.manufacturerPartNumber.slice(0, 300), value: ext.manufacturerPartNumber, metadata: distributorMetadata });
    }
    for (const [key, rawVal] of Object.entries(ext.variantAttributes ?? {})) {
      const value = String(rawVal ?? '').trim();
      if (!value) continue;
      push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: key, snippet: value.slice(0, 300), value, metadata: distributorMetadata });
    }
    // Amendment B merchandising fields (M5b-1): a VERIFIED v2 distributor
    // member (`distributor_record_v2`) contributes the explicit merchandising
    // fields with the same distributor provenance — description, each feature
    // as bullet_point, distributor_category, dimensions, case_pack,
    // unit_of_measure, ingredients. V1 members stay identity-only. Price,
    // inventory, images, search keywords, claims inferred from copy, and
    // arbitrary fields are NEVER emitted; the classification URL stays null;
    // nothing is labeled `official_product_page`.
    if (frozen.extractionMethod === 'distributor_record_v2') {
      const merchMetadata = {
        ...distributorMetadata,
        merchandisingProvenance: (ext as { merchandisingProvenance?: Record<string, unknown> }).merchandisingProvenance ?? {},
      };
      if (ext.description && ext.description.trim()) {
        push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'description', snippet: ext.description.slice(0, 500), value: ext.description, metadata: merchMetadata });
      }
      for (const bullet of ext.bulletPoints ?? []) {
        if (!bullet || !String(bullet).trim()) continue;
        push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: 'bullet_point', snippet: String(bullet).slice(0, 300), value: String(bullet), metadata: merchMetadata });
      }
      const merchScalars: Array<{ sourceField: string; value: string }> = [
        { sourceField: 'distributor_category', value: (ext as { distributorCategory?: string | null }).distributorCategory ?? '' },
        { sourceField: 'dimensions', value: (ext as { dimensions?: string | null }).dimensions ?? '' },
        { sourceField: 'case_pack', value: (ext as { casePack?: string | null }).casePack ?? '' },
        { sourceField: 'unit_of_measure', value: (ext as { unitOfMeasure?: string | null }).unitOfMeasure ?? '' },
        { sourceField: 'ingredients', value: (ext as { ingredients?: string | null }).ingredients ?? '' },
      ];
      for (const item of merchScalars) {
        const trimmed = item.value.trim();
        if (!trimmed) continue;
        push({ attributeId: null, source: distributorSource, reliability: 'medium', sourceUrl: null, sourceField: item.sourceField, snippet: trimmed.slice(0, 300), value: trimmed, metadata: merchMetadata });
      }
    }
  } else if (!isManualEvidence) {
  // Official-page branch: skipped for manual-evidence members (their only
  // evidence is the operator-manual entries pushed above).
  const pageSource: ClassificationEvidence['source'] = 'official_product_page';
  if (ext.title && ext.title.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'name', snippet: ext.title.slice(0, 300), value: ext.title, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.brand && ext.brand.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'brand', snippet: ext.brand.slice(0, 300), value: ext.brand, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.weight && ext.weight.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'weight', snippet: ext.weight.slice(0, 300), value: ext.weight, metadata: { provenance: 'official_product_page' } });
  }
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
  } // end official-page branch (skipped for manual members via !isManualEvidence above)

  // ── Canonical brand resolution from the FROZEN snapshot brands (parity
  //    with the non-cohort path; never a DB read). ────────────────────────
  const brandToResolve = ext.brand ?? identity.brandHint ?? null;
  if (brandToResolve && context.snapshot) {
    try {
      const resolved = resolveBrand(brandToResolve, context.snapshot.brands);
      if (resolved) {
        const brandValue = CanonicalBrandEvidenceValueSchema.parse({
          brandId: resolved.brandId,
          brandName: resolved.brandName,
          confidence: resolved.confidence,
          matchedBy: resolved.matchedBy,
        });
        push({ attributeId: null, source: 'catalog_manager_guidance', reliability: 'high', sourceUrl: null, sourceField: 'resolved_brand', snippet: resolved.brandName.slice(0, 300), value: brandValue, metadata: { provenance: 'brand_resolution', matchedBy: resolved.matchedBy } });
      }
    } catch (err) {
      console.warn(`[EvidenceExtraction] Frozen brand resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── FROZEN packaging OCR materialization (NO model call) ────────────────
  // The stored OCR is trusted only when its recorded ocrInputHash matches the
  // projection's own input set (recomputed from frozen fields — never a live
  // onboarding_items read) AND its execution-authority digest is non-null AND
  // equals the member runtime snapshot's plan/rule digest (PR3 hardening C / R4
  // fail-closed): a stored OCR executed under a DIFFERENT authority (model
  // policy / local-VLM route) is never materialized even when the input hash
  // matches — provenance always follows the authority that produced it.
  const frozenOcr = ext.ocr;
  const ocrInputHashMatches =
    frozenOcr.packagingOcrData != null &&
    hashCanonicalJson({
      sourceUrl: frozen.sourceUrl,
      extractionSourceUrl: frozen.extractionSourceUrl,
      primaryImage: ext.primaryImage,
      additionalImages: ext.additionalImages,
    }) === frozenOcr.ocrInputHash;
  const executionDigestMatches =
    frozenOcr.ocrExecutionDigest != null &&
    context.snapshot != null &&
    computeOcrExecutionDigest(context.snapshot) === frozenOcr.ocrExecutionDigest;
  if (frozenOcr.packagingOcrData && ocrInputHashMatches && executionDigestMatches) {
    const modelCallIds = frozenOcr.packagingOcrData.metadata?.modelCallIds;
    const visualEvidence = packagingOcrDataToEvidence(frozenOcr.packagingOcrData, {
      runId: context.runId,
      sku,
      model: frozenOcr.outcome?.model ?? 'unknown',
      ...(Array.isArray(modelCallIds) && modelCallIds.length > 0 ? { modelCallIds } : {}),
    });
    evidence.push(...visualEvidence);
  }

  if (evidence.length === 0) {
    return {
      status: 'abstained',
      reason: 'No new evidence extracted from the frozen cohort projection.',
      output: {
        evidence: [],
        proposals: [],
        abstained: true,
        // P1-T3 (metadata only): surface the digest-staleness marker so an
        // abstention caused by stale-marked OCR is observable. The hash-gate
        // semantics above are UNCHANGED (defense in depth stays).
        metadata: { ocrOutcome: frozenOcr.outcome, ocrStale: frozenOcr.outcome?.stale === true, frozenProjection: true },
      },
    };
  }

  return {
    status: 'succeeded',
    output: {
      evidence,
      proposals: [],
      abstained: false,
      metadata: { ocrOutcome: frozenOcr.outcome, ocrStale: frozenOcr.outcome?.stale === true, frozenProjection: true },
    },
  };
}

/**
 * Evidence Extraction Stage
 *
 * Gathers textual and visual product evidence from an onboarding item.
 * Adapted to use the shared extractor from product-evidence-extractor.ts.
 *
 * Onboarding-specific behavior preserved:
 * - Reads from onboarding_items table (NON-cohort mode only)
 * - Uses 'spreadsheet' source for import fields
 * - Persists VLM/cloud OCR results back to extraction_data_json (NON-cohort
 *   mode only)
 *
 * Prepared-cohort (frozen) mode (PR3 M2): when `context.cohortFrozenEvidence`
 * is present the stage builds evidence ONLY from the frozen projection (see
 * `executeFrozenEvidenceExtraction`) — no onboarding_items read, no model
 * calls, no write-back.
 */
export const evidenceExtractionStage: StageDefinition = {
  // P2-T2 (packaging-OCR overhaul): the packaging_ocr stage runs BEFORE this
  // stage and its fresh output is consumed below (zero inline OCR re-runs).
  // The dependency is honored by `resolveStageOrder` only when the
  // packaging_ocr stage is included in the pipeline's stage list; absent (flag
  // OFF / legacy consumers) this stage keeps today's behavior byte-identical.
  name: 'evidence_extraction',
  requires: ['packaging_ocr'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    if (context.cohortFrozenEvidence) {
      return executeFrozenEvidenceExtraction(input, context, context.cohortFrozenEvidence);
    }

    // Read the onboarding item's extraction data
    if (!input.onboardingItemId) {
      return { status: 'abstained', reason: 'No onboarding item ID available for evidence extraction.' };
    }

    const itemRow = findExtractionSourceRowById(input.onboardingItemId);

    if (!itemRow) {
      return { status: 'abstained', reason: 'No onboarding item found for evidence extraction.' };
    }

    const extData: Record<string, any> = itemRow.extraction_data_json
      ? JSON.parse(String(itemRow.extraction_data_json))
      : {};
    const sourceUrl = itemRow.source_url ? String(itemRow.source_url) : null;
    const itemSourceType: 'official_page' | 'distributor_record' =
      itemRow.source_type === 'distributor_record' ? 'distributor_record' : 'official_page';

    // Amendment A distributor-record source: identity-only evidence labeled
    // `distributor_record` with a NULL classification URL. Description,
    // bullets, keywords, and images are NEVER emitted for distributor sources
    // (the materializer keeps them empty anyway — this is defense in depth).
    if (itemSourceType === 'distributor_record') {
      const distributorProvenance =
        (extData as { distributorRecordProvenance?: { sourcingGenerationId?: string; evidenceHash?: string; acceptedEvidenceAttemptIds?: string[]; providerIds?: string[]; catalogVersions?: string[] } | null })
          .distributorRecordProvenance ?? null;
      const distributorMetadata = {
        provenance: 'distributor_record',
        sourcingGenerationId: distributorProvenance?.sourcingGenerationId ?? null,
        acceptedEvidenceAttemptIds: distributorProvenance?.acceptedEvidenceAttemptIds ?? [],
        acceptedProviderIds: distributorProvenance?.providerIds ?? [],
        distributorEvidenceHash: distributorProvenance?.evidenceHash ?? null,
        fieldProvenance: extData.fieldProvenance ?? {},
      };
      const distributorInput: NormalizedEvidenceInput = {
        title: { value: extData.title ?? null, source: 'distributor_record' as const, sourceUrl: null, metadata: distributorMetadata },
        description: null,
        brand: { value: extData.brand ?? null, source: 'distributor_record' as const, sourceUrl: null, metadata: distributorMetadata },
        weight: { value: extData.weight ?? null, source: 'distributor_record' as const, sourceUrl: null, metadata: distributorMetadata },
        bulletPoints: [],
        searchKeywords: null,
        customFields: {},
        primaryImage: null,
        additionalImages: [],
        sourceUrl: null,
        existingPageNames: [],
        workspacePath: context.workspacePath,
        evidenceSourceOverride: 'distributor_record',
      };
      const result = await extractProductEvidence(distributorInput, input, context);
      const evidence = result.evidence;

      // ── Distributor identity facts (SKU / MPN / variants) with provenance ──
      const pushDistributor = (sourceField: string, value: unknown): void => {
        if (value == null || String(value).trim().length === 0) return;
        evidence.push({
          id: crypto.randomUUID(),
          runId: context.runId,
          stageName: 'evidence_extraction',
          productSku: input.sku,
          attributeId: null,
          source: 'distributor_record' as const,
          reliability: 'medium',
          sourceUrl: null,
          sourceField,
          snippet: String(value).slice(0, 300),
          value,
          metadata: distributorMetadata,
          capturedAt: now(),
        } as ClassificationEvidence);
      };
      pushDistributor('distributor_sku', extData.distributorSku ?? null);
      pushDistributor('manufacturer_part_number', extData.manufacturerPartNumber ?? null);
      for (const [key, rawVal] of Object.entries(extData.variantAttributes ?? {})) {
        pushDistributor(key, rawVal);
      }
      // Amendment B merchandising fields (M5b-1): a verified v2
      // materialization (`distributorRecordProvenance.extractionMethod ===
      // 'distributor_record_v2'`) emits the explicit merchandising fields with
      // distributor provenance. V1 stays identity-only; price/inventory/
      // images/search-keywords/arbitrary copy are never emitted.
      const provMethod =
        (distributorProvenance as { extractionMethod?: string | null } | null)?.extractionMethod ?? null;
      if (provMethod === 'distributor_record_v2') {
        const merchMetadata = {
          ...distributorMetadata,
          merchandisingProvenance:
            (distributorProvenance as { merchandisingProvenance?: Record<string, unknown> } | null)?.merchandisingProvenance ?? {},
        };
        const pushMerch = (sourceField: string, value: unknown): void => {
          if (value == null || String(value).trim().length === 0) return;
          evidence.push({
            id: crypto.randomUUID(),
            runId: context.runId,
            stageName: 'evidence_extraction',
            productSku: input.sku,
            attributeId: null,
            source: 'distributor_record' as const,
            reliability: 'medium',
            sourceUrl: null,
            sourceField,
            snippet: String(value).slice(0, 300),
            value,
            metadata: merchMetadata,
            capturedAt: now(),
          } as ClassificationEvidence);
        };
        pushMerch('description', extData.description ?? null);
        for (const bullet of Array.isArray(extData.bulletPoints) ? extData.bulletPoints : []) {
          pushMerch('bullet_point', bullet);
        }
        pushMerch('distributor_category', extData.distributorCategory ?? null);
        pushMerch('dimensions', extData.dimensions ?? null);
        pushMerch('case_pack', extData.casePack ?? null);
        pushMerch('unit_of_measure', extData.unitOfMeasure ?? null);
        pushMerch('ingredients', extData.ingredients ?? null);
      }
      return { status: 'succeeded', output: { evidence, proposals: [], abstained: false } };
    }

    // Parent #101 (manual-evidence route): operator-transcribed rows emit
    // ONLY operator-manual evidence (full set in ticket #104) with a NULL
    // URL and attestation metadata. Early return mirrors the distributor
    // branch above: manual rows carry no automated artifacts, and their
    // fields must never be labeled `official_product_page`.
    const liveManualAttestationId =
      typeof (extData as { manualEvidenceAttestationId?: unknown }).manualEvidenceAttestationId === 'string'
        ? ((extData as { manualEvidenceAttestationId?: string }).manualEvidenceAttestationId as string)
        : null;
    const liveManualMethod =
      (extData as { extractionMethod?: unknown }).extractionMethod === 'manual_evidence_v1' ||
      (itemRow as { extraction_method?: unknown }).extraction_method === 'manual_evidence_v1';
    if (liveManualMethod || liveManualAttestationId) {
      const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      const asStringList = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null);
      const liveManualEntries = buildManualEvidenceEntries({
        title: asString(extData.title),
        brand: asString(extData.brand),
        description: asString(extData.description),
        bulletPoints: asStringList(extData.bulletPoints),
        weight: asString(extData.weight),
        dimensions: asString((extData as { dimensions?: unknown }).dimensions),
        primaryImage: asString(extData.primaryImage),
        additionalImages: asStringList(extData.additionalImages),
        attestationId: liveManualAttestationId ?? 'unknown',
        fieldProvenance:
          extData.fieldProvenance && typeof extData.fieldProvenance === 'object'
            ? (extData.fieldProvenance as Record<string, string>)
            : {},
        manualReferenceUrl:
          typeof (extData as { manualReferenceUrl?: unknown }).manualReferenceUrl === 'string'
            ? ((extData as { manualReferenceUrl?: string }).manualReferenceUrl as string)
            : null,
      });
      const manualEvidence = liveManualEntries.map((entry) => ({
        ...entry,
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        capturedAt: now(),
      }) as ClassificationEvidence);
      return { status: 'succeeded', output: { evidence: manualEvidence, proposals: [], abstained: false } };
    }

    // Build per-field inputs with explicit source provenance
    const titleField = extData.title
      ? { value: String(extData.title), source: 'official_product_page' as const, sourceUrl }
      : (itemRow.name ? { value: String(itemRow.name), source: 'spreadsheet' as const, sourceUrl: null } : null);

    const descriptionField = extData.description
      ? { value: String(extData.description), source: 'official_product_page' as const, sourceUrl }
      : null;

    const brandField = extData.brand
      ? { value: String(extData.brand), source: 'official_product_page' as const, sourceUrl }
      : (itemRow.brand_hint ? { value: String(itemRow.brand_hint), source: 'spreadsheet' as const, sourceUrl: null } : null);

    const customFieldsMap: Record<string, EvidenceInputField<string>> = {};
    if (extData.customFields && typeof extData.customFields === 'object') {
      for (const [k, v] of Object.entries(extData.customFields)) {
        if (v != null && String(v).trim().length > 0) {
          customFieldsMap[k] = { value: String(v), source: 'official_product_page', sourceUrl };
        }
      }
    }

    // P2-T2 (packaging-OCR overhaul): when the packaging_ocr stage produced a
    // fresh non-shadow result THIS RUN, consume it — the inline VLM OCR is
    // suppressed (images nulled out) and the visual evidence is materialized
    // from the stage output instead. Otherwise fall back to today's inline OCR
    // path UNCHANGED (defense in depth stays).
    const stageOcrOutput = getAuthoritativePackagingOcrStageOutput(input.stageOutputs);

    // Distinguish "stage absent/shadow (legacy inline path OK)" from "stage ran
    // THIS RUN non-shadow but produced NO data (failure outcome)": the latter
    // is detectable when the stage metadata carries an ocrOutcome object and
    // shadowOnly !== true, yet no authoritative packagingOcrData resolved
    // above. In that case the stage ALREADY owns this run's OCR authority keys
    // (it persisted its failure outcome), so the images must NOT be passed to
    // the inline extractor (which would re-run full VLM OCR + cloud fallback)
    // and extraction_data_json must NOT be written back over those keys.
    const stageMetadata = input.stageOutputs?.packaging_ocr?.metadata as Record<string, unknown> | undefined;
    const stageRanNonShadowWithoutData =
      !stageOcrOutput &&
      !!stageMetadata &&
      stageMetadata.shadowOnly !== true &&
      stageMetadata.ocrOutcome != null &&
      typeof stageMetadata.ocrOutcome === 'object';
    const suppressInlineOcr = Boolean(stageOcrOutput) || stageRanNonShadowWithoutData;

    const normalizedInput: NormalizedEvidenceInput = {
      title: titleField,
      description: descriptionField,
      brand: brandField,
      weight: extData.weight ? String(extData.weight) : null,
      bulletPoints: Array.isArray(extData.bulletPoints) ? extData.bulletPoints : [],
      searchKeywords: extData.searchKeywords ? String(extData.searchKeywords) : null,
      customFields: customFieldsMap,
      primaryImage: suppressInlineOcr ? null : (extData.primaryImage ?? null),
      additionalImages: suppressInlineOcr ? [] : (Array.isArray(extData.additionalImages) ? extData.additionalImages : []),
      sourceUrl,
      existingPageNames: [],
      workspacePath: context.workspacePath,
    };

    // Call the shared extractor (this handles LLM extraction, brand resolution;
    // VLM OCR is skipped when fresh stage output is consumed above)
    const result = await extractProductEvidence(normalizedInput, input, context);
    const evidence = result.evidence;

    // P2-T2: materialize the visual evidence from the FRESH packaging_ocr stage
    // output (same conversion as the frozen-projection path) — zero new model
    // calls for OCR this run.
    if (stageOcrOutput) {
      try {
        const visualEvidence = packagingOcrDataToEvidence(stageOcrOutput.packagingOcrData, {
          runId: context.runId,
          sku: input.sku,
          model: (stageOcrOutput.ocrOutcome as { model?: string | null } | null)?.model ?? 'unknown',
        });
        evidence.push(...visualEvidence);
      } catch (err) {
        console.warn(`[EvidenceExtraction] Failed to materialize packaging_ocr stage evidence: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Onboarding-specific: emit spreadsheet fields as 'spreadsheet' source ──
    const spreadsheetName = itemRow.name ? String(itemRow.name) : null;
    const spreadsheetExpectedName = itemRow.expected_name ? String(itemRow.expected_name) : null;
    const spreadsheetBrandHint = itemRow.brand_hint ? String(itemRow.brand_hint) : null;

    const hasSpreadsheetNameEvidence = evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'name');
    if (spreadsheetName && !hasSpreadsheetNameEvidence) {
      evidence.push({
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as any,
        reliability: 'medium' as any,
        sourceUrl: null,
        sourceField: 'name',
        snippet: spreadsheetName.slice(0, 300),
        value: spreadsheetName,
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: now(),
      });
    }

    if (spreadsheetExpectedName && spreadsheetExpectedName !== spreadsheetName) {
      evidence.push({
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as any,
        reliability: 'medium' as any,
        sourceUrl: null,
        sourceField: 'expected_name',
        snippet: spreadsheetExpectedName.slice(0, 300),
        value: spreadsheetExpectedName,
        metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' },
        capturedAt: now(),
      });
    }

    const hasSpreadsheetBrandEvidence = evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'brand');
    if (spreadsheetBrandHint && !hasSpreadsheetBrandEvidence) {
      evidence.push({
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as any,
        reliability: 'medium' as any,
        sourceUrl: null,
        sourceField: 'brand',
        snippet: spreadsheetBrandHint.slice(0, 300),
        value: spreadsheetBrandHint,
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: now(),
      });
    }

    // ── Onboarding-specific: persist OCR data & outcome back to extraction_data_json ────
    // P2-T2: when the packaging_ocr stage owns this run's OCR, it already
    // persisted the live keys through the repository — never clobber them with
    // the extractor's image-less no_image outcome.
    if (!suppressInlineOcr && (result.ocrOutcome || result.packagingOcrData)) {
      try {
        const mergedOcr = result.packagingOcrData;
        const updatedExt = {
          ...extData,
          ...(mergedOcr ? { packagingOcrData: mergedOcr, packagingTitle: mergedOcr.productName } : {}),
          ...(result.ocrOutcome ? { ocrOutcome: result.ocrOutcome } : {}),
          // The legacy inline path is re-authoring the live OCR keys — clear
          // any stale stage-authored marker (P2 baseline-drift guard) so a
          // later dual-run comparison still sees a genuine legacy baseline.
          // JSON.stringify drops undefined-valued keys.
          packagingOcrStageRunId: undefined,
        };
        setItemExtractionDataJson(input.onboardingItemId, JSON.stringify(updatedExt));
      } catch (persistErr: any) {
        console.warn(`[EvidenceExtraction] Failed to persist OCR to onboarding item: ${persistErr.message}`);
      }
    }

    if (evidence.length === 0) {
      return {
        status: 'abstained',
        reason: 'No new evidence extracted from available sources.',
        output: {
          evidence: [],
          proposals: [],
          abstained: true,
          metadata: { ocrOutcome: stageOcrOutput?.ocrOutcome ?? result.ocrOutcome },
        },
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence,
        proposals: [],
        abstained: false,
        metadata: { ocrOutcome: stageOcrOutput?.ocrOutcome ?? result.ocrOutcome },
      },
    };
  },
};
