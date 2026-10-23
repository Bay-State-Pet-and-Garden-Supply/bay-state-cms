import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { findExtractionSourceRowById, setItemExtractionDataJson } from '../../db/repositories/onboarding-item-repo';
import { extractProductEvidence, packagingOcrDataToEvidence } from '../product-evidence-extractor';
import type { NormalizedEvidenceInput, EvidenceInputField } from '../product-evidence-extractor';
import { resolveBrand } from '../brand-resolution';
import { CanonicalBrandEvidenceValueSchema } from '../../shared/schemas/classification';
import { computeOcrExecutionDigest } from '../runtime-snapshot';
import { getAuthoritativePackagingOcrStageOutput } from './packaging-ocr-stage';
import type { ExecutionEvidenceProjectionMemberV2 } from '../../shared/schemas/cohorts';
import type { ClassificationEvidence } from '../../shared/types';
import * as crypto from 'node:crypto';
import {
  buildFrozenProjectionEntries,
  buildManualEvidenceEntries,
  frozenOcrModelParams,
  isFrozenOcrEligible,
  type FrozenEvidenceEntry,
} from '../frozen-evidence-mapping';

const now = () => new Date().toISOString();

/**
 * Prepared-cohort (frozen) evidence extraction (issue #30 PR3 M2, amendment 4).
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
  const ext = frozen.extraction;
  const identity = frozen.spreadsheetIdentity;

  const push = (entry: FrozenEvidenceEntry): void => {
    evidence.push({
      ...entry,
      id: crypto.randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      capturedAt: now(),
    } as ClassificationEvidence);
  };

  // ── Frozen own-SKU text evidence (issue #361): the shared frozen
  //    projection mapping owns supplied-identity, distributor
  //    merchandising, official-page field selection and
  //    source/provenance labeling — the same meaning the read-only freeze
  //    scan computes. This consumer only stamps execution bookkeeping.
  for (const entry of buildFrozenProjectionEntries(frozen)) {
    push(entry);
  }

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
  // Eligibility (input-hash binding + execution-authority digest) is the
  // shared frozen-mapping predicate; conversion stays the shared
  // `packagingOcrDataToEvidence` mapping. A stored OCR executed under a
  // DIFFERENT authority (model policy / local-VLM route) is never
  // materialized even when the input hash matches — provenance always
  // follows the authority that produced it.
  const expectedDigest = context.snapshot != null ? computeOcrExecutionDigest(context.snapshot) : null;
  const frozenOcr = ext.ocr;
  if (frozenOcr.packagingOcrData && isFrozenOcrEligible(frozen, expectedDigest)) {
    const ocrParams = frozenOcrModelParams(frozen);
    const visualEvidence = packagingOcrDataToEvidence(frozenOcr.packagingOcrData, {
      runId: context.runId,
      sku,
      model: ocrParams.model,
      ...(ocrParams.modelCallIds ? { modelCallIds: ocrParams.modelCallIds } : {}),
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
      // Distributor runs take the early return below — push the spreadsheet
      // identity rows here too, or downstream detectors that read the
      // 'spreadsheet' source (naming variant guarantee, brand matching) starve
      // on distributor items whose distributor title lacks size tokens.
      // Same shape + provenance as the official_page path below.
      const distSheetName = itemRow.name ? String(itemRow.name) : null;
      const distSheetExpected = itemRow.expected_name ? String(itemRow.expected_name) : null;
      const distSheetBrand = itemRow.brand_hint ? String(itemRow.brand_hint) : null;
      const pushSheet = (sourceField: string, value: string | null, extra: Record<string, unknown> = {}): void => {
        if (!value) return;
        evidence.push({
          id: crypto.randomUUID(),
          runId: context.runId,
          stageName: 'evidence_extraction',
          productSku: input.sku,
          attributeId: null,
          source: 'spreadsheet',
          reliability: 'medium',
          sourceUrl: null,
          sourceField,
          snippet: value.slice(0, 300),
          value,
          metadata: { provenance: 'spreadsheet_import', ...extra },
          capturedAt: now(),
        } as ClassificationEvidence);
      };
      pushSheet('name', distSheetName);
      if (distSheetExpected && distSheetExpected !== distSheetName) pushSheet('expected_name', distSheetExpected, { refinement: 'discovery_consolidation' });
      pushSheet('brand', distSheetBrand);
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
