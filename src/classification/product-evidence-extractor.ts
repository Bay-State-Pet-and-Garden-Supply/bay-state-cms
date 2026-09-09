/**
 * Shared evidence extraction logic for classification pipelines.
 *
 * This module provides a source-neutral extraction function that takes
 * a NormalizedEvidenceInput and produces ClassificationEvidence entries.
 * It is used by both the onboarding evidence extraction stage and the
 * catalog product evidence extraction stage.
 */
import { randomUUID } from 'node:crypto';
import { getVlmConfig } from '../onboarding/vlm-client';
import { runPackagingOcrAttempt, mergeOcrResults } from '../onboarding/packaging-ocr';
import { getLlmConfigForTask, callLlmForTaskWithProvenance } from '../onboarding/llm-client';
import { redactTransportText } from './model-policy-gateway';
import { MODEL_CALL_STATUS } from './model-operation-registry';
import { recordTerminalPreflight } from '../db/repositories/classification-model-call-repo';
import { modelPolicyViewFromConfig } from '../onboarding/model-policy-snapshot';
import { buildModelCallContext, requireModelCallContext, getModelExecutionPlanEntry } from './runtime-snapshot';
import { getCachedBrands, getCachedDataSharingPolicy } from '../db/repositories/classification-config-repo';
import { resolveBrand } from './brand-resolution';
import type { StageInput, StageContext } from './types';
import type { ClassificationEvidence } from '../shared/types';
import { CanonicalBrandEvidenceValueSchema } from '../shared/schemas/classification';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import type { PackagingOcrData, OcrAttemptOutcome } from '../shared/schemas/onboarding';
export type { OcrAttemptOutcome };

const now = () => new Date().toISOString();

export interface EvidenceInputField<T = string> {
  value: T | null;
  source?: ClassificationEvidence['source'];
  sourceUrl?: string | null;
  sourceField?: string | null;
  reliability?: ClassificationEvidence['reliability'];
  metadata?: Record<string, unknown>;
}

// ─── Normalized Evidence Input ────────────────────────────────────────────────

/**
 * Source-neutral input for product evidence extraction.
 * Populated by either the onboarding adapter (from onboarding_items)
 * or the catalog adapter (from Product object).
 */
export interface NormalizedEvidenceInput {
  /** Product name/title */
  title: string | EvidenceInputField<string> | null;
  /** Product description */
  description: string | EvidenceInputField<string> | null;
  /** Brand name (free text) */
  brand: string | EvidenceInputField<string> | null;
  /** Product weight string */
  weight: string | EvidenceInputField<string> | null;
  /** Bullet-point features */
  bulletPoints: string[] | EvidenceInputField<string[]>;
  /** SEO / search keywords */
  searchKeywords: string | EvidenceInputField<string> | null;
  /** Custom fields key-value pairs */
  customFields: Record<string, string | EvidenceInputField<string>>;
  /** Primary product image URL or path */
  primaryImage: string | null;
  /** Additional gallery image URLs or paths */
  additionalImages: string[];
  /** Source URL of the product page (null for catalog products) */
  sourceUrl: string | null;
  /** Existing category page names the product is assigned to */
  existingPageNames: string[];
  /** Workspace path for local file resolution */
  workspacePath: string;
  /** Override for default text evidence source label */
  evidenceSourceOverride?: ClassificationEvidence['source'];
  /** Distributor provider ID for metadata provenance */
  distributorProviderId?: string | null;
}

/**
 * Canonical provenance label for a text-evidence source (Amendment A).
 * Distributor-record evidence is labeled `distributor_record` — it must never
 * fall through to the `official_product_page` metadata label.
 */
export function sourceProvenanceLabel(source: ClassificationEvidence['source']): string {
  if (source === 'catalog_product') return 'catalog_product';
  if (source === 'spreadsheet') return 'spreadsheet_import';
  if (source === 'distributor_record') return 'distributor_record';
  return 'official_product_page';
}


export interface EvidenceExtractionResult {
  /** All evidence collected during extraction */
  evidence: ClassificationEvidence[];
  /** Optional packaging OCR data (not persisted by this function) */
  packagingOcrData?: PackagingOcrData;
  /** Detailed outcome status and provenance of the OCR extraction attempt */
  ocrOutcome?: OcrAttemptOutcome;
}

// ─── Packaging OCR evidence conversion ────────────────────────────────────────
// P2-T1: the canonical pure converter now lives in `./ocr-evidence` (shared
// with the cohort resolver, which previously kept a mirrored copy). Re-exported
// here so existing consumers (`stages/evidence-extraction.ts`) keep compiling.
import { packagingOcrDataToEvidence } from './ocr-evidence';
export { packagingOcrDataToEvidence };
export type { OcrToEvidenceParams } from './ocr-evidence';

function parseFieldInput<T>(
  fieldInput: T | EvidenceInputField<T> | null | undefined,
  defaultSource: ClassificationEvidence['source'],
  defaultUrl: string | null = null,
): {
  value: T | null;
  source: ClassificationEvidence['source'];
  sourceUrl: string | null;
  reliability: ClassificationEvidence['reliability'];
  metadata: Record<string, unknown>;
} {
  if (fieldInput == null) {
    return { value: null, source: defaultSource, sourceUrl: defaultUrl, reliability: 'medium', metadata: {} };
  }
  if (typeof fieldInput === 'object' && fieldInput !== null && 'value' in fieldInput) {
    const inputObj = fieldInput as EvidenceInputField<T>;
    return {
      value: inputObj.value,
      source: inputObj.source ?? defaultSource,
      sourceUrl: inputObj.sourceUrl !== undefined ? inputObj.sourceUrl : defaultUrl,
      reliability: inputObj.reliability ?? 'medium',
      metadata: inputObj.metadata ?? {},
    };
  }
  return {
    value: fieldInput as T,
    source: defaultSource,
    sourceUrl: defaultUrl,
    reliability: 'medium',
    metadata: {},
  };
}

/** Scalar OCR fields whose non-null presence counts as usable content. */
const OCR_CONTENT_SCALAR_FIELDS = [
  'productName', 'brand', 'upc', 'size', 'weight', 'count',
  'flavorVariety', 'color', 'material', 'lifeStage', 'breedSize', 'productForm',
  'packagingType', 'npkRatio',
] as const;

/** Array OCR fields whose non-empty presence counts as usable content. */
const OCR_CONTENT_ARRAY_FIELDS = [
  'species', 'healthConcernFunction', 'dietaryLabels',
  'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
] as const;

/** True when a parsed OCR result carries usable content (same rule as the
 *  packaging-ocr stage and cohort curator). */
function hasOcrContent(ocr: PackagingOcrData | undefined | null): boolean {
  if (!ocr) return false;
  for (const field of OCR_CONTENT_SCALAR_FIELDS) {
    const value = ocr[field];
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  for (const field of OCR_CONTENT_ARRAY_FIELDS) {
    const arr = ocr[field];
    if (Array.isArray(arr) && arr.some((b: string) => b && b.trim().length > 0)) return true;
  }
  return false;
}

/**
 * Shared, source-neutral product evidence extractor.
 */
export async function extractProductEvidence(
  input: NormalizedEvidenceInput,
  stageInput: StageInput,
  context: StageContext,
): Promise<EvidenceExtractionResult> {
  const evidence: ClassificationEvidence[] = [];
  const sku = stageInput.sku;
  const sourceUrl = input.sourceUrl;

  const defaultTextSource = stageInput.sourceKind === 'catalog_product'
    ? ('catalog_product' as const)
    : ('official_product_page' as const);

  // 1. Title
  const titleInfo = parseFieldInput(input.title, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (titleInfo.value && typeof titleInfo.value === 'string' && titleInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: titleInfo.source,
      reliability: titleInfo.reliability,
      sourceUrl: titleInfo.sourceUrl,
      sourceField: 'name',
      snippet: titleInfo.value.slice(0, 300),
      value: titleInfo.value,
      metadata: { provenance: sourceProvenanceLabel(titleInfo.source), ...titleInfo.metadata },
      capturedAt: now(),
    });
  }

  // 2. Brand
  const brandInfo = parseFieldInput(input.brand, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (brandInfo.value && typeof brandInfo.value === 'string' && brandInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: brandInfo.source,
      reliability: brandInfo.reliability,
      sourceUrl: brandInfo.sourceUrl,
      sourceField: 'brand',
      snippet: brandInfo.value.slice(0, 300),
      value: brandInfo.value,
      metadata: { provenance: sourceProvenanceLabel(brandInfo.source), ...brandInfo.metadata },
      capturedAt: now(),
    });
  }

  // 3. Weight
  const weightInfo = parseFieldInput(input.weight, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (weightInfo.value && typeof weightInfo.value === 'string' && weightInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: weightInfo.source,
      reliability: weightInfo.reliability,
      sourceUrl: weightInfo.sourceUrl,
      sourceField: 'weight',
      snippet: weightInfo.value.slice(0, 300),
      value: weightInfo.value,
      metadata: { provenance: sourceProvenanceLabel(weightInfo.source), ...weightInfo.metadata },
      capturedAt: now(),
    });
  }

  // 4. Description
  const descInfo = parseFieldInput(input.description, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (descInfo.value && typeof descInfo.value === 'string' && descInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: descInfo.source,
      reliability: descInfo.reliability,
      sourceUrl: descInfo.sourceUrl,
      sourceField: 'description',
      snippet: descInfo.value.slice(0, 500),
      value: descInfo.value,
      metadata: { provenance: sourceProvenanceLabel(descInfo.source), extractedAt: now(), ...descInfo.metadata },
      capturedAt: now(),
    });
  }

  // 5. Bullet points
  const bulletInfo = parseFieldInput(input.bulletPoints, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (Array.isArray(bulletInfo.value) && bulletInfo.value.length > 0) {
    for (const bullet of bulletInfo.value) {
      if (!bullet?.trim()) continue;
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: sku,
        attributeId: null,
        source: bulletInfo.source,
        reliability: bulletInfo.reliability,
        sourceUrl: bulletInfo.sourceUrl,
        sourceField: 'bullet_point',
        snippet: String(bullet).slice(0, 300),
        value: String(bullet),
        metadata: { provenance: sourceProvenanceLabel(bulletInfo.source), extractedAt: now(), ...bulletInfo.metadata },
        capturedAt: now(),
      });
    }
  }

  // 6. Custom fields
  if (input.customFields && typeof input.customFields === 'object') {
    for (const [key, rawVal] of Object.entries(input.customFields)) {
      const fieldInfo = parseFieldInput(rawVal, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
      if (fieldInfo.value && String(fieldInfo.value).trim().length > 0) {
        evidence.push({
          id: randomUUID(),
          runId: context.runId,
          stageName: 'evidence_extraction',
          productSku: sku,
          attributeId: null,
          source: fieldInfo.source,
          reliability: fieldInfo.reliability,
          sourceUrl: fieldInfo.sourceUrl,
          sourceField: key,
          snippet: String(fieldInfo.value),
          value: String(fieldInfo.value),
          metadata: { provenance: fieldInfo.source === 'catalog_product' ? 'catalog_product' : 'product_data', ...fieldInfo.metadata },
          capturedAt: now(),
        });
      }
    }
  }

  // 7. Search keywords
  const kwInfo = parseFieldInput(input.searchKeywords, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (kwInfo.value && typeof kwInfo.value === 'string' && kwInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: kwInfo.source,
      reliability: 'low' as ClassificationEvidence['reliability'],
      sourceUrl: kwInfo.sourceUrl,
      sourceField: 'search_keywords',
      snippet: kwInfo.value.slice(0, 300),
      value: kwInfo.value,
      metadata: { provenance: 'product_data', ...kwInfo.metadata },
      capturedAt: now(),
    });
  }

  // 8. Existing page context — name-only review context with LOW reliability.
  //    Page context never supports claims or composition (pageContextReliability
  //    is fixed to 'low' and verified identity is false until a real export).
  if (input.existingPageNames?.length) {
    for (const pageName of input.existingPageNames) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: sku,
        attributeId: null,
        source: 'page_context' as ClassificationEvidence['source'],
        reliability: 'low' as ClassificationEvidence['reliability'],
        sourceUrl: null,
        sourceField: 'page_name',
        snippet: pageName.slice(0, 300),
        value: pageName,
        metadata: {
          provenance: 'existing_assignment',
          pageContextReliability: 'low',
          verifiedPageIdentity: false,
        },
        capturedAt: now(),
      });
    }
  }

  // 9. Resolve brand to canonical brand evidence using CanonicalBrandEvidenceValueSchema
  const rawBrandStr = typeof titleInfo.value === 'string' ? titleInfo.value : (typeof brandInfo.value === 'string' ? brandInfo.value : null);
  if (rawBrandStr || input.brand) {
    const brandToResolve = typeof input.brand === 'string' ? input.brand : (typeof input.brand === 'object' && input.brand?.value ? String(input.brand.value) : rawBrandStr);
    if (brandToResolve) {
      try {
        const brands = context.snapshot
          ? context.snapshot.brands
          : getCachedBrands(context.workspaceId);
        const resolved = resolveBrand(brandToResolve, brands);
        if (resolved) {
          const brandValue = CanonicalBrandEvidenceValueSchema.parse({
            brandId: resolved.brandId,
            brandName: resolved.brandName,
            confidence: resolved.confidence,
            matchedBy: resolved.matchedBy,
          });
          evidence.push({
            id: randomUUID(),
            runId: context.runId,
            stageName: 'evidence_extraction',
            productSku: sku,
            attributeId: null,
            source: 'catalog_manager_guidance' as ClassificationEvidence['source'],
            reliability: 'high' as ClassificationEvidence['reliability'],
            sourceUrl: null,
            sourceField: 'resolved_brand',
            snippet: resolved.brandName.slice(0, 300),
            value: brandValue,
            metadata: { provenance: 'brand_resolution', matchedBy: resolved.matchedBy },
            capturedAt: now(),
          });
        }
      } catch (err: any) {
        console.warn(`[EvidenceExtraction] Brand resolution failed: ${redactTransportText(err.message)}`);
      }
    }
  }

  // ── VLM OCR and LLM Enrichment ──────────────────────────────────────────
  let localOcrSucceeded = false;
  let packagingOcrData: PackagingOcrData | undefined = undefined;
  const ocrResults: PackagingOcrData[] = [];

  const vlmConfig = getVlmConfig();
  const canUseLocalVlm = vlmConfig?.enabled === true;
  let dataPolicy: any = null;
  try {
    dataPolicy = context.snapshot
      ? context.snapshot.dataSharing
      : getCachedDataSharingPolicy(context.workspaceId);
  } catch {
    // Use defaults
  }
  const canUseCloudText = dataPolicy?.textPolicy === 'cloud_allowed';
  const canUseCloudImages = dataPolicy?.imagePolicy === 'cloud_allowed';

  let localStatus: OcrAttemptOutcome['status'] = canUseLocalVlm ? 'skipped' : 'disabled';
  let cloudStatus: OcrAttemptOutcome['status'] = canUseCloudImages ? 'skipped' : 'disabled';
  // P1-T5 fixup: persist the coded local failure reason + transport attempt
  // count on ordinary failures so the outcome carries WHY the local leg
  // failed (additive fields; success behavior unchanged).
  let localFailureReason: OcrAttemptOutcome['localFailureReason'] = null;
  let localAttempts = 0;
  let llmStatus: OcrAttemptOutcome['llmStatus'] = canUseCloudText ? 'skipped' : 'disabled';

  const imageUrls: string[] = [];
  if (input.primaryImage) imageUrls.push(input.primaryImage);
  if (input.additionalImages && Array.isArray(input.additionalImages)) {
    for (const img of input.additionalImages) {
      if (imageUrls.length >= 2) break;
      if (img && String(img).trim()) {
        imageUrls.push(String(img));
      }
    }
  }

  // 1. Local VLM OCR
  if (canUseLocalVlm) {
    if (imageUrls.length > 0) {
      console.log(`[EvidenceExtraction] Running VLM OCR on ${imageUrls.length} image(s) for SKU ${sku}`);
      localStatus = 'failed';
    } else {
      localStatus = 'no_image';
    }

    // Build the frozen evidence-extraction policy view + run-bound call
    // context ONCE before the image loop. Run-bound calls REQUIRE a compatible
    // frozen plan: a legacy/no-plan snapshot fails closed (abstain, no
    // transport, no evidence). The frozen local VLM route comes from the
    // snapshot plan entry so the transport can never read mutable settings.
    const evidencePolicyView = context.snapshot
      ? modelPolicyViewFromConfig(
          context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
          context.snapshot.snapshotHash,
        )
      : null;
    let localModelCall: import('../classification/model-operation-registry').ModelCallContext | null = null;
    let localFrozenRoute: { baseUrl: string; model: string } | null = null;
    if (context.snapshot) {
      try {
        localModelCall = requireModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1);
        const entry = getModelExecutionPlanEntry(context.snapshot, 'evidence_extraction');
        if (entry?.localVlmBaseUrl && entry?.localVlmModel) {
          localFrozenRoute = { baseUrl: entry.localVlmBaseUrl, model: entry.localVlmModel };
        }
      } catch (err: any) {
        localStatus = 'failed';
        console.warn(
          `[EvidenceExtraction] Local VLM OCR abstained for SKU ${sku}: no compatible frozen plan — ${redactTransportText(err.message)}`,
        );
      }
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      // When run-bound but no compatible plan, skip every image (no transport,
      // no evidence from the model call).
      if (context.snapshot && !localModelCall) continue;
      try {
        // Run-bound local VLM calls are audited (issue #17 E): the call
        // context binds the transport to the run snapshot plan and the
        // resulting callId flows into the OCR evidence metadata.
        const attempt = await runPackagingOcrAttempt({
          imageUrl: imgUrl,
          workspacePath: input.workspacePath,
          imageSourceUrl: imgUrl,
          sku,
          ...(localModelCall && context.snapshot
            ? {
                modelCall: localModelCall,
                snapshot: context.snapshot,
                frozenVlmRoute: localFrozenRoute,
                modelPolicyDigest: evidencePolicyView?.policyDigest ?? '',
              }
            : {}),
        });

        if (attempt.ok) {
          const ocrResult = attempt.data;
          if (hasOcrContent(ocrResult)) {
            ocrResults.push(ocrResult);
            console.log(`[EvidenceExtraction] VLM OCR completed for image ${i + 1}/${imageUrls.length} of SKU ${sku}`);
          } else {
            console.warn(`[EvidenceExtraction] VLM OCR returned no text content for image ${i + 1}/${imageUrls.length} of SKU ${sku}`);
          }
        } else {
          localFailureReason = attempt.reasonCode;
          localAttempts = Math.max(localAttempts, attempt.attempts);
          console.warn(`[EvidenceExtraction] VLM OCR failed (${attempt.reasonCode}) for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${attempt.redactedMessage}`);
        }
      } catch (err: any) {
        console.warn(`[EvidenceExtraction] VLM OCR failed for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${redactTransportText(err.message)}`);
      }
    }

    if (ocrResults.length > 0) {
      const mergedOcr = ocrResults.length === 1 ? ocrResults[0] : mergeOcrResults(ocrResults);
      if (hasOcrContent(mergedOcr)) {
        localOcrSucceeded = true;
        localStatus = 'succeeded';
        packagingOcrData = mergedOcr;

        const visualEvidence = packagingOcrDataToEvidence(mergedOcr, {
          runId: context.runId,
          sku,
          model: mergedOcr.metadata?.model ?? 'unknown',
          ...(Array.isArray((mergedOcr.metadata as { modelCallIds?: string[] } | undefined)?.modelCallIds)
            ? { modelCallIds: (mergedOcr.metadata as unknown as { modelCallIds: string[] }).modelCallIds }
            : {}),
        });
        evidence.push(...visualEvidence);
        console.log(`[EvidenceExtraction] Added ${visualEvidence.length} evidence entries from local packaging OCR`);
      }
    }
  }

  // 2. Cloud multimodal VLM fallback (runs if local OCR did not succeed and cloud images are allowed)
  if (!localOcrSucceeded && input.primaryImage && canUseCloudImages) {
    cloudStatus = 'failed';
    try {
      // Protected operation: route through the frozen classification policy
      // (issue #17 pass 1b). Without a snapshot, no policy exists → disabled
      // → no transport.
      const evidencePolicyView = context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null;
      const { extractPackagingOcrFromCloud } = await import('../onboarding/cloud-vlm-client');
      // Run-bound cloud VLM calls REQUIRE a compatible frozen plan: a
      // legacy/no-plan snapshot abstains (no transport).
      let cloudModelCall: import('../classification/model-operation-registry').ModelCallContext | null = null;
      if (context.snapshot) {
        try {
          cloudModelCall = requireModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1);
        } catch (err: any) {
          cloudStatus = 'failed';
          console.warn(
            `[EvidenceExtraction] Cloud VLM OCR abstained for SKU ${sku}: no compatible frozen plan — ${redactTransportText(err.message)}`,
          );
          cloudModelCall = null;
        }
      }
      if (context.snapshot && !cloudModelCall) {
        // No compatible plan: no transport, no evidence from the call.
      } else {
        const cloudOcrResult = await extractPackagingOcrFromCloud({
          imageUrl: String(input.primaryImage),
          modelPolicy: evidencePolicyView,
          ...(cloudModelCall && context.snapshot
            ? {
                modelCall: cloudModelCall,
                snapshot: context.snapshot,
              }
            : {}),
        });

        if (cloudOcrResult && hasOcrContent(cloudOcrResult)) {
          packagingOcrData = cloudOcrResult;
          cloudStatus = 'succeeded';
          const cloudModelCallIds = (cloudOcrResult as { metadata?: { modelCallIds?: string[] } }).metadata?.modelCallIds;
          const cloudEvidence = packagingOcrDataToEvidence(cloudOcrResult, {
            runId: context.runId,
            sku,
            model: (cloudOcrResult as any).metadata?.model ?? 'cloud-vision',
            ...(cloudModelCallIds?.length ? { modelCallIds: cloudModelCallIds } : {}),
          });
          evidence.push(...cloudEvidence);
          console.log(`[EvidenceExtraction] Added ${cloudEvidence.length} evidence entries from cloud packaging OCR`);
        }
      }
    } catch (err: any) {
      console.warn(`[EvidenceExtraction] Cloud packaging OCR failed: ${redactTransportText(err.message)}`);
    }
  }

  // 3. LLM-based text extraction for richer attributes (decoupled from OCR)
  if (canUseCloudText) {
    // Protected operation: route through the frozen classification policy
    // (issue #17 item A). Without a snapshot, no policy exists → disabled →
    // no transport.
    const evidencePolicyView = context.snapshot
      ? modelPolicyViewFromConfig(
          context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
          context.snapshot.snapshotHash,
        )
      : null;
    const preflightModelCall = context.snapshot
      ? buildModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1)
      : null;
    // Track whether a preflight terminal row was already written so a denied
    // attempt never records BOTH policy_denied and unavailable (one attempt =
    // exactly one terminal row, issue #17 pass 4c).
    let preflightRecorded = false;
    let llmConfig: import('../onboarding/llm-client').LlmConfig | null;
    try {
      llmConfig = getLlmConfigForTask('classification_evidence_extraction', {
        allowFallback: true,
        modelPolicy: evidencePolicyView,
        protectedOperation: 'evidence_extraction',
      });
    } catch (err) {
      recordTerminalPreflight(
        preflightModelCall,
        evidencePolicyView?.policyDigest ?? '',
        MODEL_CALL_STATUS.policyDenied,
        `Model policy denied text evidence extraction (${err instanceof Error ? err.message : String(err)}).`,
      );
      preflightRecorded = true;
      llmConfig = null;
    }
    if (llmConfig) {
      const titleStr = typeof titleInfo.value === 'string' ? titleInfo.value : '';
      const descStr = typeof descInfo.value === 'string' ? descInfo.value : '';
      const allText = [
        titleStr,
        descStr,
        Array.isArray(bulletInfo.value) ? bulletInfo.value.join(' ') : '',
        typeof kwInfo.value === 'string' ? kwInfo.value : '',
      ].filter(Boolean).join('\n');

      if (allText.length > 10) {
        // Durable model-call audit context (issue #17 E): bound to the run
        // snapshot plan. Run-bound calls REQUIRE a compatible frozen plan — a
        // legacy/no-plan snapshot abstains (no transport).
        let modelCall: import('../classification/model-operation-registry').ModelCallContext | null = null;
        let planBlocked = false;
        if (context.snapshot) {
          try {
            modelCall = requireModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1);
          } catch (err: any) {
            planBlocked = true;
            llmStatus = 'failed';
            console.warn(
              `[EvidenceExtraction] LLM text extraction abstained for SKU ${sku}: no compatible frozen plan — ${redactTransportText(err.message)}`,
            );
          }
        }
        if (!planBlocked) try {
          const prompt = `Extract the following attributes from this product text. Return ONLY valid JSON with these keys (omit any you cannot determine): {"flavor": "..." | null, "color": "..." | null, "material": "..." | null, "size": "..." | null, "lifeStage": "..." | null, "breedSize": "..." | null, "productForm": "..." | null, "healthConcern": "..." | null, "ingredientKeywords": ["..."]}. Do not guess. Only include values that are explicitly mentioned.\n\nProduct text:\n${allText.slice(0, 3000)}`;

          const response = await callLlmForTaskWithProvenance('classification_evidence_extraction', prompt, 'You are a precise product data extraction assistant. Return only valid JSON.', {
            allowFallback: true,
            modelPolicy: evidencePolicyView,
            protectedOperation: 'evidence_extraction',
            ...(modelCall ? { modelCall, snapshot: context.snapshot } : {}),
          });
          if (response == null) {
            throw new Error('LLM call returned null');
          }
          const parsed = JSON.parse(response.content.trim());
          let addedLlmEvidence = false;
          for (const [key, val] of Object.entries(parsed)) {
            if (val === null || val === undefined) continue;
            if (Array.isArray(val) && val.length === 0) continue;
            if (typeof val === 'string' && val.trim().length === 0) continue;

            addedLlmEvidence = true;
            evidence.push({
              id: randomUUID(),
              runId: context.runId,
              stageName: 'evidence_extraction',
              productSku: sku,
              attributeId: key,
              source: (input.evidenceSourceOverride ?? defaultTextSource) as ClassificationEvidence['source'],
              reliability: 'medium' as ClassificationEvidence['reliability'],
              sourceUrl,
              sourceField: `llm_${key}`,
              snippet: typeof val === 'string' ? val.slice(0, 300) : JSON.stringify(val).slice(0, 300),
              value: val,
              metadata: { provenance: defaultTextSource, model: llmConfig.model, modelCallIds: [response.callId] },
              capturedAt: now(),
            });
          }
          llmStatus = addedLlmEvidence ? 'succeeded' : 'failed';
        } catch (err: any) {
          llmStatus = 'failed';
          console.warn(`[EvidenceExtraction] LLM extraction failed: ${redactTransportText(err.message)}`);
        }
      } else {
        llmStatus = 'no_text';
      }
    } else {
      // Preflight decided not to call the model: the attempted call is still
      // observable via exactly ONE durable terminal row. If a policy denial
      // was already recorded above, do not also write `unavailable`.
      llmStatus = 'failed';
      if (!preflightRecorded) {
        recordTerminalPreflight(
          preflightModelCall,
          evidencePolicyView?.policyDigest ?? '',
          MODEL_CALL_STATUS.unavailable,
          'No LLM config available for text evidence extraction.',
        );
      }
    }
  }

  const overallStatus: OcrAttemptOutcome['status'] =
    (localStatus === 'succeeded' || cloudStatus === 'succeeded')
      ? 'succeeded'
      : (imageUrls.length === 0)
        ? 'no_image'
        : (!canUseLocalVlm && !canUseCloudImages)
          ? 'disabled'
          : 'failed';

  const ocrOutcome: OcrAttemptOutcome = {
    status: overallStatus,
    localStatus,
    cloudStatus,
    llmStatus,
    model: packagingOcrData?.metadata?.model ?? vlmConfig?.model ?? null,
    imageCount: imageUrls.length,
    ...(localFailureReason ? { localFailureReason } : {}),
    ...(localAttempts > 0 ? { attempts: localAttempts } : {}),
  };

  return { evidence, packagingOcrData, ocrOutcome };
}
