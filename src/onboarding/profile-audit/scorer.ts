/**
 * Profile Audit Scorer
 *
 * Scores extraction outcomes against independently labeled ground truth:
 * 1. Per-field correctness evaluated against `available: true/false`
 *    (unavailable fields never penalize the score when correctly empty).
 * 2. Image precision, recall, and primary accuracy.
 * 3. Product and variant identity verdicts.
 * 4. Machine-readable failure codes.
 * 5. Evidence gaps tracked explicitly, never as parser failures.
 *
 * Deterministic: same inputs in, same scored row out — EXCLUDING wall-clock
 * latencyMs (fix #8). latencyMs is transport timing passthrough from the
 * replay runner; determinism comparisons MUST use
 * getDeterministicScoredRowIdentity() (shared-metrics.ts), which strips it.
 */

import type {
  AuditManifestSample,
  AuditScoredRow,
  IdentityVerdict,
  AuditFailureCode,
  FieldScoreDetail,
  ImageScoreDetail,
  MissingFieldReason,
  HybridConflict,
} from '../../shared/schemas/profile-audit';
import type { ExtractionOutcome } from './types';
import { canonicalizeUrl } from '../image-utils';
import { canonicalGtinMatch } from '../../shared/gtin';

export function normalizeText(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePrice(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[^\d.]/g, '').trim();
}

/**
 * Checks whether an extracted title is a generic fragment or bare category word
 * relative to the expected full product name.
 */
export function isGenericTitleFragment(extracted: string, expected: string): boolean {
  const normExt = normalizeText(extracted);
  const normExp = normalizeText(expected);
  if (!normExt || !normExp) return true;
  if (normExt === normExp) return false;

  // Strict substring within the expected full product name (e.g. "spray" within "hot spot relief spray")
  if (normExp.includes(normExt)) {
    return true;
  }

  // Token subset with fewer tokens than the full expected name
  const extTokens = normExt.split(/\s+/).filter(Boolean);
  const expTokens = normExp.split(/\s+/).filter(Boolean);
  if (extTokens.length < expTokens.length && extTokens.every(t => expTokens.includes(t))) {
    return true;
  }

  return false;
}

/**
 * Detects disagreements between custom selectors and structured sources
 * from raw extraction layers when conflicts were not pre-calculated.
 */
export function detectRawConflicts(raw: any): HybridConflict[] {
  if (!raw || !raw.custom) return [];
  const conflicts: HybridConflict[] = [];

  function getStructuredVal(field: 'title' | 'brand' | 'price' | 'sku' | 'gtin'): { value: string | null; source: string } {
    if (field === 'title') {
      const j = raw.jsonLd?.name;
      if (typeof j === 'string' && j.trim()) return { value: j.trim(), source: 'json-ld' };
      const m = raw.microdata?.name;
      if (typeof m === 'string' && m.trim()) return { value: m.trim(), source: 'microdata' };
      const o = raw.metaTags?.['og:title'];
      if (typeof o === 'string' && o.trim()) return { value: o.trim(), source: 'meta' };
    }
    if (field === 'brand') {
      const j = typeof raw.jsonLd?.brand === 'string'
        ? raw.jsonLd.brand
        : (typeof raw.jsonLd?.brand === 'object' && raw.jsonLd?.brand?.name ? raw.jsonLd.brand.name : null);
      if (typeof j === 'string' && j.trim()) return { value: j.trim(), source: 'json-ld' };
      const m = raw.microdata?.brand;
      if (typeof m === 'string' && m.trim()) return { value: m.trim(), source: 'microdata' };
    }
    if (field === 'price') {
      const jOffers = raw.jsonLd?.offers;
      const jPrice = jOffers?.price ?? jOffers?.lowPrice;
      if (jPrice !== undefined && String(jPrice).trim()) return { value: String(jPrice).trim(), source: 'json-ld' };
      const m = raw.microdata?.price;
      if (typeof m === 'string' && m.trim()) return { value: m.trim(), source: 'microdata' };
    }
    if (field === 'sku') {
      const j = raw.jsonLd?.sku;
      if (typeof j === 'string' && j.trim()) return { value: j.trim(), source: 'json-ld' };
      const m = raw.microdata?.sku;
      if (typeof m === 'string' && m.trim()) return { value: m.trim(), source: 'microdata' };
    }
    if (field === 'gtin') {
      const j = raw.jsonLd?.gtin13 || raw.jsonLd?.gtin12 || raw.jsonLd?.gtin;
      if (typeof j === 'string' && j.trim()) return { value: j.trim(), source: 'json-ld' };
      const m = raw.microdata?.gtin13 || raw.microdata?.gtin12 || raw.microdata?.gtin;
      if (typeof m === 'string' && m.trim()) return { value: m.trim(), source: 'microdata' };
    }
    return { value: null, source: 'none' };
  }

  const fields: Array<'title' | 'brand' | 'price' | 'sku' | 'gtin'> = ['title', 'brand', 'price', 'sku', 'gtin'];
  for (const f of fields) {
    const customRaw = raw.custom?.[f];
    const selectorVal = typeof customRaw === 'string' && customRaw.trim() ? customRaw.trim() : null;
    const structured = getStructuredVal(f);
    const structuredVal = structured.value;
    if (selectorVal && structuredVal) {
      let isDisagreement = false;
      if (f === 'price') {
        const p1 = normalizePrice(selectorVal);
        const p2 = normalizePrice(structuredVal);
        isDisagreement = Boolean(p1 && p2 && p1 !== p2);
      } else if (f === 'gtin') {
        isDisagreement = !canonicalGtinMatch(selectorVal, structuredVal);
      } else if (f === 'sku' || f === 'brand' || f === 'title') {
        isDisagreement = normalizeText(selectorVal) !== normalizeText(structuredVal);
      }
      if (isDisagreement) {
        conflicts.push({
          field: f,
          selectorValue: selectorVal,
          structuredValue: structuredVal,
          structuredSource: structured.source,
          selectorSource: 'custom-selector',
          resolution: 'selector_preferred_with_conflict',
          severity: 'critical',
          disagreementReason: `Selector value "${selectorVal}" disagrees with ${structured.source} value "${structuredVal}"`,
        });
      }
    }
  }

  return conflicts;
}

export function scoreExtraction(
  outcome: ExtractionOutcome,
  sample: AuditManifestSample,
): AuditScoredRow {
  const { groundTruth } = sample;
  const failureCodesSet = new Set<AuditFailureCode>();

  // Handle Missing Primary Artifact (Evidence Gap)
  if (outcome.isEvidenceGap) {
    failureCodesSet.add('EVIDENCE_GAP_MISSING_ARTIFACT');

    const fieldScores: Record<string, FieldScoreDetail> = {};
    for (const [field, spec] of Object.entries(groundTruth.fields)) {
      const isInapplicable = Boolean((spec as any).inapplicable || spec.notes?.toLowerCase().includes('inapplicable'));
      const missingReason: MissingFieldReason = isInapplicable
        ? 'inapplicable'
        : (spec.available ? 'failed' : 'absent');
      const missingExplanation = isInapplicable
        ? (spec.notes ? `Inapplicable: ${spec.notes}` : 'Field is inapplicable to this product scope')
        : (spec.available
            ? (outcome.evidenceGapReason || 'Missing primary artifact')
            : (spec.notes ? `Absent from page: ${spec.notes}` : 'Field is absent from source page (unavailable)'));

      fieldScores[field] = {
        field,
        available: spec.available,
        inapplicable: isInapplicable || undefined,
        extractedValue: null,
        expectedValue: spec.expectedValue ?? null,
        provenance: 'none',
        status: isInapplicable ? 'inapplicable' : (spec.available ? 'missing' : 'unavailable'),
        correct: !spec.available,
        missingReason,
        missingExplanation,
      };
    }

    const imageScores: ImageScoreDetail = {
      extractedImages: [],
      admittedImages: [],
      rejectedImages: [],
      primaryImage: null,
      primaryAccuracy: 0,
      precision: 0,
      recall: 0,
      duplicateCount: 0,
      duplicateContaminationCount: 0,
      duplicateContamination: false,
    };

    return {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: outcome.configuration,
      identityVerdict: 'unidentified',
      fieldScores,
      fieldCorrectnessScore: 0,
      imageScores,
      failureCodes: Array.from(failureCodesSet),
      isEvidenceGap: true,
      evidenceGapReason: outcome.evidenceGapReason || 'Missing primary artifact',
      extractedProductPreview: {
        title: null,
        brand: null,
        description: null,
        price: null,
        primaryImage: null,
        additionalImages: [],
        sku: null,
        gtin: null,
      },
      duplicateContamination: false,
      duplicateContaminationCount: 0,
      latencyMs: outcome.latencyMs,
      requestCount: outcome.requestCount,
    };
  }

  // Check for missing supplemental artifacts
  if (!sample.hasSupplementalArtifact) {
    failureCodesSet.add('EVIDENCE_GAP_MISSING_SUPPLEMENTAL');
  }

  // Step 1: Identity Verdict
  // Deterministic identity evidence (GTIN, SKU, variant matrix) resolves first
  let identityVerdict: IdentityVerdict;
  const extractedTitle = outcome.data.title;
  const extractedBrand = outcome.data.brand;
  const extractedGtin = outcome.data.gtin || (outcome.data as Record<string, unknown>).gtin;
  const extractedSku = (outcome.data as Record<string, unknown>).sku;
  const expectedIdentity = groundTruth.identity;

  const normExtTitle = normalizeText(extractedTitle);
  const normExpTitle = normalizeText(expectedIdentity.productName);
  const normExtBrand = normalizeText(extractedBrand);
  const normExpBrand = normalizeText(expectedIdentity.brand);

  let hasMatchingCode = false;
  let hasContradictingCode = false;

  if (expectedIdentity.gtin && extractedGtin) {
    if (canonicalGtinMatch(String(extractedGtin), String(expectedIdentity.gtin))) {
      hasMatchingCode = true;
    } else {
      hasContradictingCode = true;
    }
  }

  if (expectedIdentity.sku && extractedSku) {
    if (normalizeText(extractedSku) === normalizeText(expectedIdentity.sku)) {
      hasMatchingCode = true;
    } else {
      hasContradictingCode = true;
    }
  }

  if (hasContradictingCode) {
    identityVerdict = 'wrong_product';
  } else if (hasMatchingCode) {
    if (expectedIdentity.variantName && !normExtTitle.includes(normalizeText(expectedIdentity.variantName))) {
      identityVerdict = 'wrong_variant';
    } else {
      identityVerdict = 'correct_match';
    }
  } else if (normExtTitle && normExpTitle) {
    const isFragment = isGenericTitleFragment(normExtTitle, normExpTitle);
    const brandMatch = !normExpBrand || !normExtBrand || normExtBrand === normExpBrand || normExtBrand.startsWith(normExpBrand) || normExpBrand.startsWith(normExtBrand);

    if (isFragment) {
      // Vague generic fragment with no identifying codes stays unidentified or ambiguous
      // and never scores an accepted identity match
      identityVerdict = outcome.variantDecision?.status === 'ambiguous' ? 'ambiguous' : 'unidentified';
    } else {
      const titleMatch = normExtTitle === normExpTitle || normExtTitle.includes(normExpTitle);
      if (titleMatch && brandMatch) {
        if (expectedIdentity.variantName && !normExtTitle.includes(normalizeText(expectedIdentity.variantName))) {
          identityVerdict = 'wrong_variant';
        } else {
          identityVerdict = 'correct_match';
        }
      } else {
        identityVerdict = 'wrong_product';
      }
    }
  } else {
    identityVerdict = 'unidentified';
  }

  if (outcome.identityResolution?.confusionDetected) {
    failureCodesSet.add('PARENT_PAGE_VARIANT_CONFUSION');
    if (outcome.identityResolution.confusionType === 'ambiguous_variant') {
      identityVerdict = 'ambiguous';
    } else if (outcome.identityResolution.confusionType === 'unresolved_parent') {
      identityVerdict = 'ambiguous';
    } else if (outcome.identityResolution.confusionType === 'wrong_variant_selected') {
      identityVerdict = 'wrong_variant';
    } else if (
      outcome.identityResolution.confusionType === 'parent_vs_variant' &&
      (expectedIdentity.variantName || identityVerdict === 'correct_match')
    ) {
      identityVerdict = 'wrong_variant';
    } else if (identityVerdict === 'correct_match') {
      identityVerdict = 'wrong_variant';
    }
  }

  if (outcome.variantDecision?.status === 'ambiguous') {
    identityVerdict = 'ambiguous';
  }

  if (identityVerdict === 'wrong_product') failureCodesSet.add('WRONG_PRODUCT');
  if (identityVerdict === 'wrong_variant') failureCodesSet.add('WRONG_VARIANT');
  if (identityVerdict === 'unidentified') failureCodesSet.add('IDENTITY_MISMATCH');
  if (identityVerdict === 'ambiguous') failureCodesSet.add('IDENTITY_MISMATCH');

  // Step 2: Per-Field Correctness
  // Each field is judged by its own comparison rule, cross-source conflicts surface with provenance
  const rawConflicts = (!outcome.conflicts || outcome.conflicts.length === 0) && outcome.raw
    ? detectRawConflicts(outcome.raw)
    : [];
  const activeConflicts = outcome.conflicts && outcome.conflicts.length > 0
    ? outcome.conflicts
    : rawConflicts;

  const fieldScores: Record<string, FieldScoreDetail> = {};
  let totalAvailable = 0;
  let availableCorrect = 0;

  for (const [field, spec] of Object.entries(groundTruth.fields)) {
    const rawDataVal = (outcome.data as Record<string, unknown>)[field];
    let extractedStr = rawDataVal !== undefined && rawDataVal !== null ? String(rawDataVal).trim() : null;

    if (!extractedStr && outcome.raw) {
      if (field === 'sku') {
        const jSku = (outcome.raw.jsonLd as Record<string, unknown> | null)?.sku;
        const mSku = (outcome.raw.microdata as Record<string, unknown> | null)?.sku;
        if (typeof jSku === 'string' && jSku.trim()) extractedStr = jSku.trim();
        else if (typeof mSku === 'string' && mSku.trim()) extractedStr = mSku.trim();
      } else if (field === 'gtin') {
        const jRaw = outcome.raw.jsonLd as Record<string, unknown> | null;
        const g = jRaw?.gtin13 || jRaw?.gtin12 || jRaw?.gtin;
        if (typeof g === 'string' && g.trim()) extractedStr = g.trim();
      }
    }

    const expectedVal = spec.expectedValue ?? (
      field === 'title' ? expectedIdentity.productName :
      field === 'brand' ? expectedIdentity.brand :
      field === 'gtin' ? (expectedIdentity.gtin ?? null) :
      field === 'sku' ? (expectedIdentity.sku ?? null) :
      null
    );
    const provenance = outcome.data.fieldProvenance?.[field] || 'unknown';

    const conflict = activeConflicts.find(c => c.field === field);
    const conflictDetails = conflict
      ? `Selector (${conflict.selectorSource || 'custom-selector'}): "${conflict.selectorValue}" vs Structured (${conflict.structuredSource || 'structured'}): "${conflict.structuredValue}"`
      : null;

    if (conflict) {
      failureCodesSet.add('FIELD_CONFLICT');
    }

    const isInapplicable = Boolean((spec as any).inapplicable || spec.notes?.toLowerCase().includes('inapplicable'));

    if (!spec.available) {
      // Unavailable on the page: should be empty/null
      const isUnavailableSuccess = !extractedStr;
      const missingReason: MissingFieldReason = isInapplicable ? 'inapplicable' : 'absent';
      const missingExplanation = isInapplicable
        ? (spec.notes ? `Inapplicable: ${spec.notes}` : 'Field is inapplicable to this product scope')
        : (spec.notes ? `Absent from page: ${spec.notes}` : 'Field is absent from source page (unavailable)');

      fieldScores[field] = {
        field,
        available: false,
        inapplicable: isInapplicable || undefined,
        extractedValue: extractedStr,
        expectedValue: expectedVal,
        provenance,
        status: isUnavailableSuccess ? (isInapplicable ? 'inapplicable' : 'unavailable') : (conflict ? 'conflict' : 'incorrect'),
        correct: isUnavailableSuccess,
        conflictDetails,
        missingReason: isUnavailableSuccess ? missingReason : (conflict ? 'conflicted' : null),
        missingExplanation: isUnavailableSuccess
          ? missingExplanation
          : (conflict ? `Conflicted: ${conflictDetails}` : null),
      };
    } else {
      // Available on the page: must be extracted and match according to its own rule
      totalAvailable++;
      if (!extractedStr) {
        const missingReason: MissingFieldReason = conflict
          ? 'conflicted'
          : (isInapplicable ? 'inapplicable' : 'failed');
        const missingExplanation = conflict
          ? `Conflicted: ${conflictDetails}`
          : (isInapplicable
              ? (spec.notes || 'Field is inapplicable to this product scope')
              : 'Field is present on page but extraction failed');

        fieldScores[field] = {
          field,
          available: true,
          inapplicable: isInapplicable || undefined,
          extractedValue: null,
          expectedValue: expectedVal,
          provenance,
          status: conflict ? 'conflict' : (isInapplicable ? 'inapplicable' : 'missing'),
          correct: false,
          conflictDetails,
          missingReason,
          missingExplanation,
        };
        failureCodesSet.add('MISSING_AVAILABLE_FIELD');
      } else if (expectedVal !== null) {
        let isMatch: boolean;
        if (field === 'price') {
          isMatch = normalizePrice(extractedStr) === normalizePrice(expectedVal);
        } else if (field === 'gtin') {
          isMatch = canonicalGtinMatch(extractedStr, expectedVal);
        } else if (field === 'sku') {
          isMatch = normalizeText(extractedStr) === normalizeText(expectedVal);
        } else if (field === 'brand') {
          isMatch = normalizeText(extractedStr) === normalizeText(expectedVal);
        } else if (field === 'title') {
          const normExt = normalizeText(extractedStr);
          const normExp = normalizeText(expectedVal);
          if (normExt === normExp) {
            isMatch = true;
          } else if (isGenericTitleFragment(normExt, normExp)) {
            // A generic title fragment never scores a correct title
            isMatch = false;
          } else if (normExt.includes(normExp)) {
            isMatch = true;
          } else {
            isMatch = false;
          }
        } else {
          // Free text (e.g. description)
          const normExt = normalizeText(extractedStr);
          const normExp = normalizeText(expectedVal);
          isMatch = normExt === normExp || normExt.includes(normExp) || normExp.includes(normExt);
        }

        if (isMatch) {
          availableCorrect++;
          fieldScores[field] = {
            field,
            available: true,
            inapplicable: isInapplicable || undefined,
            extractedValue: extractedStr,
            expectedValue: expectedVal,
            provenance,
            status: conflict ? 'conflict' : 'correct',
            correct: true,
            conflictDetails,
            missingReason: conflict ? 'conflicted' : null,
            missingExplanation: conflict ? `Conflicted: ${conflictDetails}` : null,
          };
        } else {
          fieldScores[field] = {
            field,
            available: true,
            inapplicable: isInapplicable || undefined,
            extractedValue: extractedStr,
            expectedValue: expectedVal,
            provenance,
            status: conflict ? 'conflict' : 'incorrect',
            correct: false,
            conflictDetails,
            missingReason: conflict ? 'conflicted' : null,
            missingExplanation: conflict ? `Conflicted: ${conflictDetails}` : null,
          };
          failureCodesSet.add('MISSING_AVAILABLE_FIELD');
        }
      } else {
        // Available, no exact string expected, but non-empty extracted
        availableCorrect++;
        fieldScores[field] = {
          field,
          available: true,
          inapplicable: isInapplicable || undefined,
          extractedValue: extractedStr,
          expectedValue: null,
          provenance,
          status: conflict ? 'conflict' : 'correct',
          correct: true,
          conflictDetails,
          missingReason: conflict ? 'conflicted' : null,
          missingExplanation: conflict ? `Conflicted: ${conflictDetails}` : null,
        };
      }
    }
  }

  const fieldCorrectnessScore = totalAvailable > 0 ? availableCorrect / totalAvailable : 1.0;

  // Step 3: Image Scores
  // Precision, recall, and primary accuracy computed over canonical image sets
  // Duplicate contamination reported separately
  const admitted = outcome.admittedImages || [];
  const rejected = outcome.rejectedImages || [];
  const primary = outcome.primaryImage;

  const expectedPrimary = groundTruth.images.primaryImage;
  const admissibleList = groundTruth.images.admissibleImages || [];
  const inadmissibleList = groundTruth.images.inadmissibleImages || [];

  const admissibleCanonicals = new Set(admissibleList.map(u => canonicalizeUrl(u, sample.url)));
  const inadmissibleCanonicals = new Set(inadmissibleList.map(u => canonicalizeUrl(u, sample.url)));

  let primaryAccuracy = 1;
  if (expectedPrimary) {
    const normPrimary = primary ? canonicalizeUrl(primary, sample.url) : '';
    const normExpPrimary = canonicalizeUrl(expectedPrimary, sample.url);
    if (normPrimary !== normExpPrimary) {
      primaryAccuracy = 0;
      failureCodesSet.add('PRIMARY_IMAGE_MISMATCH');
    }
  }

  // Canonicalize admitted images into a set, tracking duplicate count
  const admittedCanonicalSet = new Set<string>();
  let duplicateCount = 0;
  for (const img of admitted) {
    const canon = canonicalizeUrl(img, sample.url);
    if (admittedCanonicalSet.has(canon)) {
      duplicateCount++;
    } else {
      admittedCanonicalSet.add(canon);
    }
  }

  const hasDuplicateContamination = duplicateCount > 0;

  // True Positives and False Positives computed over canonical admitted set
  let truePositives = 0;
  let falsePositives = 0;

  for (const canon of admittedCanonicalSet) {
    if (admissibleCanonicals.has(canon)) {
      truePositives++;
    } else if (inadmissibleCanonicals.has(canon) || (admissibleCanonicals.size > 0 && !admissibleCanonicals.has(canon))) {
      falsePositives++;
    }
  }

  // False Negatives: expected admissible canonicals missing from admitted canonical set
  let falseNegatives = 0;
  for (const canon of admissibleCanonicals) {
    if (!admittedCanonicalSet.has(canon)) {
      falseNegatives++;
    }
  }

  const precision = (truePositives + falsePositives) > 0
    ? truePositives / (truePositives + falsePositives)
    : (admissibleList.length === 0 ? 1.0 : 0.0);

  const recall = (truePositives + falseNegatives) > 0
    ? truePositives / (truePositives + falseNegatives)
    : 1.0;

  if (precision < 0.7 && admissibleList.length > 0) {
    failureCodesSet.add('LOW_IMAGE_PRECISION');
  }

  if (failureCodesSet.size === 0) {
    failureCodesSet.add('NONE');
  }

  const imageScores: ImageScoreDetail = {
    extractedImages: [...admitted, ...rejected],
    admittedImages: admitted,
    rejectedImages: rejected,
    primaryImage: primary,
    primaryAccuracy,
    precision,
    recall,
    duplicateCount,
    duplicateContaminationCount: duplicateCount,
    duplicateContamination: hasDuplicateContamination,
    rejectionReasons: outcome.imageRejectionReasons,
  };

  return {
    sampleId: sample.sampleId,
    url: sample.url,
    domain: sample.domain,
    configuration: outcome.configuration,
    identityVerdict,
    fieldScores,
    fieldCorrectnessScore,
    imageScores,
    failureCodes: Array.from(failureCodesSet),
    isEvidenceGap: false,
    identityResolution: outcome.identityResolution,
    conflicts: activeConflicts.length > 0 ? activeConflicts : outcome.conflicts,
    imageRejectionReasons: outcome.imageRejectionReasons,
    duplicateContamination: hasDuplicateContamination,
    duplicateContaminationCount: duplicateCount,
    extractedProductPreview: {
      title: outcome.data.title,
      brand: outcome.data.brand,
      description: outcome.data.description,
      price: outcome.data.price,
      primaryImage: outcome.primaryImage,
      additionalImages: outcome.data.additionalImages,
      sku: typeof (outcome.data as Record<string, unknown>).sku === 'string'
        ? (outcome.data as Record<string, unknown>).sku as string
        : typeof (outcome.raw?.jsonLd as Record<string, unknown>)?.sku === 'string'
          ? (outcome.raw.jsonLd as Record<string, unknown>).sku as string
          : null,
      gtin: typeof (outcome.data as Record<string, unknown>).gtin === 'string'
        ? (outcome.data as Record<string, unknown>).gtin as string
        : typeof (outcome.raw?.jsonLd as Record<string, unknown>)?.gtin13 === 'string'
          ? (outcome.raw.jsonLd as Record<string, unknown>).gtin13 as string
          : null,
    },
    latencyMs: outcome.latencyMs,
    requestCount: outcome.requestCount,
  };
}
