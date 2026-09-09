/**
 * Pure OCR→evidence conversion (P2-T1 of the packaging-OCR overhaul plan).
 *
 * Canonical home of `packagingOcrDataToEvidence`: converts a stored
 * `PackagingOcrData` object into `ClassificationEvidence` entries. This module
 * is PURE by contract — no DB, no model calls, no persistence, no I/O of any
 * kind — so both the DB/model-coupled extractor
 * (`product-evidence-extractor.ts`) and the pure cohort resolver
 * (`cohort-product-type-resolver.ts`) can share one field mapping instead of
 * keeping a mirrored copy.
 */
import { randomUUID } from 'node:crypto';
import type { ClassificationEvidence } from '../shared/types';
import type { PackagingOcrData } from '../shared/schemas/onboarding';

const now = () => new Date().toISOString();

export interface OcrToEvidenceParams {
  runId: string;
  sku: string;
  model: string;
  /** Durable model-call IDs that produced the OCR evidence (issue #17 E). */
  modelCallIds?: string[];
}

/**
 * Convert a stored PackagingOcrData object into ClassificationEvidence entries.
 * Each visible field produces one or more evidence records with appropriate
 * sourceField, attributeId, and reliability derived from per-field confidence.
 * Exported so the cohort frozen-mode evidence stage can materialize evidence
 * from a FROZEN packagingOcrData snapshot without a new model call (issue #30
 * PR3 M2 amendment 4).
 */
export function packagingOcrDataToEvidence(
  ocrData: PackagingOcrData,
  params: OcrToEvidenceParams,
): ClassificationEvidence[] {
  const evidence: ClassificationEvidence[] = [];
  const { runId, sku, model } = params;
  /** Resolve reliability — use per-field confidence when available. */
  const reliability = (field: string, fallback: string): string => {
    const confidence = ocrData.confidenceByField?.[field];
    if (confidence == null) return fallback;
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.4) return 'medium';
    return 'low';
  };

  const base = {
    runId,
    stageName: 'evidence_extraction' as const,
    productSku: sku,
    source: 'visual_product_evidence' as const,
    sourceUrl: null as string | null,
    capturedAt: now(),
  };

  // productName
  if (ocrData.productName) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('productName', 'high') as ClassificationEvidence['reliability'],
      sourceField: 'name',
      snippet: ocrData.productName.slice(0, 300),
      value: ocrData.productName,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.productName ?? null },
    });
  }

  // brand
  if (ocrData.brand) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('brand', 'high') as ClassificationEvidence['reliability'],
      sourceField: 'brand',
      snippet: ocrData.brand.slice(0, 300),
      value: ocrData.brand,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.brand ?? null },
    });
  }

  // species — one entry per value
  if (ocrData.species?.length) {
    for (const val of ocrData.species) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: 'species',
        reliability: reliability('species', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'species',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.species ?? null },
      });
    }
  }

  // flavorVariety
  if (ocrData.flavorVariety) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'flavor',
      reliability: reliability('flavorVariety', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'flavor',
      snippet: ocrData.flavorVariety.slice(0, 300),
      value: ocrData.flavorVariety,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.flavorVariety ?? null },
    });
  }

  // color
  if (ocrData.color) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'color',
      reliability: reliability('color', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'color',
      snippet: ocrData.color.slice(0, 300),
      value: ocrData.color,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.color ?? null },
    });
  }

  // material
  if (ocrData.material) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'material',
      reliability: reliability('material', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'material',
      snippet: ocrData.material.slice(0, 300),
      value: ocrData.material,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.material ?? null },
    });
  }

  // size
  if (ocrData.size) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'size',
      reliability: reliability('size', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'size',
      snippet: ocrData.size.slice(0, 300),
      value: ocrData.size,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.size ?? null },
    });
  }

  // weight
  if (ocrData.weight) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('weight', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'weight',
      snippet: ocrData.weight.slice(0, 300),
      value: ocrData.weight,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.weight ?? null },
    });
  }

  // count
  if (ocrData.count) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('count', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'count',
      snippet: ocrData.count.slice(0, 300),
      value: ocrData.count,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.count ?? null },
    });
  }

  // lifeStage
  if (ocrData.lifeStage) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'life-stage',
      reliability: reliability('lifeStage', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'lifeStage',
      snippet: ocrData.lifeStage.slice(0, 300),
      value: ocrData.lifeStage,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.lifeStage ?? null },
    });
  }

  // breedSize
  if (ocrData.breedSize) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'breed-size',
      reliability: reliability('breedSize', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'breedSize',
      snippet: ocrData.breedSize.slice(0, 300),
      value: ocrData.breedSize,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.breedSize ?? null },
    });
  }

  // productForm
  if (ocrData.productForm) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'food-form',
      reliability: reliability('productForm', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'productForm',
      snippet: ocrData.productForm.slice(0, 300),
      value: ocrData.productForm,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.productForm ?? null },
    });
  }

  // packagingType
  if (ocrData.packagingType) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'packaging-type',
      reliability: reliability('packagingType', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'packagingType',
      snippet: ocrData.packagingType.slice(0, 300),
      value: ocrData.packagingType,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.packagingType ?? null },
    });
  }

  // npkRatio
  if (ocrData.npkRatio) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'npk-ratio',
      reliability: reliability('npkRatio', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'npkRatio',
      snippet: ocrData.npkRatio.slice(0, 300),
      value: ocrData.npkRatio,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.npkRatio ?? null },
    });
  }

  // healthConcernFunction — one entry per value
  if (ocrData.healthConcernFunction?.length) {
    for (const val of ocrData.healthConcernFunction) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: 'health-benefits',
        reliability: reliability('healthConcernFunction', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'healthConcern',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.healthConcernFunction ?? null },
      });
    }
  }

  // dietaryLabels — one entry per label
  if (ocrData.dietaryLabels?.length) {
    for (const val of ocrData.dietaryLabels) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: 'dietary-features',
        reliability: reliability('dietaryLabels', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'dietaryLabel',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.dietaryLabels ?? null },
      });
    }
  }

  // ingredientKeywords — one entry per keyword (low reliability)
  if (ocrData.ingredientKeywords?.length) {
    for (const val of ocrData.ingredientKeywords) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('ingredientKeywords', 'low') as ClassificationEvidence['reliability'],
        sourceField: 'ingredientKeyword',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.ingredientKeywords ?? null },
      });
    }
  }

  // visibleTextLines — emit only first 3 lines to avoid bloat
  if (ocrData.visibleTextLines?.length) {
    const lines = ocrData.visibleTextLines.slice(0, 3);
    for (const val of lines) {
      if (!val?.trim()) continue;
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('visibleTextLines', 'low') as ClassificationEvidence['reliability'],
        sourceField: 'visible_text',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, visibleText: true, confidence: ocrData.confidenceByField?.visibleTextLines ?? null },
      });
    }
  }

  // ingredients — one entry per ingredient
  if (ocrData.ingredients?.length) {
    for (const val of ocrData.ingredients) {
      if (!val?.trim()) continue;
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: 'nutrition',
        reliability: reliability('ingredients', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'ingredient',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.ingredients ?? null },
      });
    }
  }

  // claims — one entry per claim
  if (ocrData.claims?.length) {
    for (const val of ocrData.claims) {
      if (!val?.trim()) continue;
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('claims', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'claim',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.claims ?? null },
      });
    }
  }

  // Propagate the durable model-call IDs that produced this OCR evidence so
  // proposals/stage metadata can trace back to the exact calls (issue #17 E).
  if (params.modelCallIds?.length) {
    for (const e of evidence) {
      e.metadata = { ...(e.metadata ?? {}), modelCallIds: params.modelCallIds };
    }
  }

  return evidence;
}
