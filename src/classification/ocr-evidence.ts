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
  /**
   * A3: self-reported VLM confidence caps at medium before independent
   * title/quote corroboration — a structured guess without a matching visible
   * package quotation is never high reliability on its own claim.
   */
  const reliability = (field: string, fallback: string): string => {
    const confidence = ocrData.confidenceByField?.[field];
    if (confidence == null) return fallback === 'high' ? 'medium' : fallback;
    if (confidence >= 0.7) return 'medium';
    if (confidence >= 0.4) return 'medium';
    return 'low';
  };
  /** A3: supplying call IDs for one field — the exact image's calls from the
   * merge provenance, never a union of unrelated image call IDs. */
  const supplyingCallIds = (field: string): string[] | undefined => {
    const provenance = (ocrData.metadata as { fieldProvenance?: Record<string, { imageIndex: number; modelCallIds: string[] }> } | null)?.fieldProvenance?.[field];
    if (provenance && provenance.modelCallIds.length > 0) return provenance.modelCallIds;
    return params.modelCallIds?.length ? params.modelCallIds : undefined;
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

  // visibleTextLines — A3: a bounded set of VALUE-RELEVANT lines across both
  // images rather than a blind first-3 truncation, so a fourth-line quote
  // (e.g. "DOGS & PUPPIES") stays citeable. Cap at 8 lines.
  if (ocrData.visibleTextLines?.length) {
    const values = new Set<string>();
    for (const candidate of [ocrData.productName, ocrData.brand, ocrData.upc, ocrData.flavorVariety, ocrData.color, ocrData.material, ocrData.size, ocrData.weight, ocrData.count, ocrData.lifeStage, ocrData.breedSize, ocrData.productForm, ocrData.packagingType, ocrData.npkRatio, ...(ocrData.species ?? [])]) {
      if (candidate) values.add(String(candidate).trim().toLowerCase());
    }
    const scored = ocrData.visibleTextLines
      .map((line, index) => ({ line, index }))
      .filter(entry => entry.line?.trim())
      .map(entry => {
        const text = entry.line.trim().toLowerCase();
        const relevant = [...values].some(value => value && (text.includes(value) || value.includes(text)));
        return { ...entry, relevant };
      })
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index)
      .slice(0, 8);
    for (const { line: val } of scored) {
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

  // A3: attach the exact supplying image's call IDs per row via the merge
  // provenance (sourceField -> OCR field map). Rows without provenance keep
  // the fallback union below.
  const sourceFieldToOcrField: Record<string, string> = {
    name: 'productName', brand: 'brand', species: 'species', flavor: 'flavorVariety',
    color: 'color', material: 'material', size: 'size', weight: 'weight',
    count: 'count', lifeStage: 'lifeStage', breedSize: 'breedSize',
    productForm: 'productForm', packagingType: 'packagingType', npkRatio: 'npkRatio',
  };
  for (const e of evidence) {
    const ocrField = sourceFieldToOcrField[String((e as { sourceField?: unknown }).sourceField ?? '')];
    if (!ocrField) continue;
    const ids = supplyingCallIds(ocrField);
    if (ids) e.metadata = { ...((e.metadata ?? {}) as Record<string, unknown>), modelCallIds: ids };
  }

  // A3: the merge provenance already scopes each row to its supplying image;
  // the params union is a fallback only when no per-field provenance exists.
  if (params.modelCallIds?.length) {
    for (const e of evidence) {
      const existing = (e.metadata as { modelCallIds?: string[] } | null)?.modelCallIds;
      if (!existing || existing.length === 0) {
        e.metadata = { ...(e.metadata ?? {}), modelCallIds: params.modelCallIds };
      }
    }
  }

  return evidence;
}
