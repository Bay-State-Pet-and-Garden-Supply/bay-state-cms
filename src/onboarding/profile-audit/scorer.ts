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
 * Deterministic: same inputs in, same scored row out.
 */

import type {
  AuditManifestSample,
  AuditScoredRow,
  IdentityVerdict,
  AuditFailureCode,
  FieldScoreDetail,
  ImageScoreDetail,
  MissingFieldReason,
} from '../../shared/schemas/profile-audit';
import type { ExtractionOutcome } from './types';
import { canonicalizeUrl } from '../image-utils';
import { canonicalGtinMatch } from '../../shared/gtin';

function normalizeText(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePrice(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[^\d.]/g, '').trim();
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
    };
  }

  // Check for missing supplemental artifacts
  if (!sample.hasSupplementalArtifact) {
    failureCodesSet.add('EVIDENCE_GAP_MISSING_SUPPLEMENTAL');
  }

  // Step 1: Identity Verdict
  let identityVerdict: IdentityVerdict = 'unidentified';
  const extractedTitle = outcome.data.title;
  const extractedBrand = outcome.data.brand;
  const extractedGtin = outcome.data.gtin;
  const expectedIdentity = groundTruth.identity;

  const normExtTitle = normalizeText(extractedTitle);
  const normExpTitle = normalizeText(expectedIdentity.productName);
  const normExtBrand = normalizeText(extractedBrand);
  const normExpBrand = normalizeText(expectedIdentity.brand);

  if (expectedIdentity.gtin && extractedGtin) {
    if (canonicalGtinMatch(extractedGtin, expectedIdentity.gtin)) {
      if (expectedIdentity.variantName && !normExtTitle.includes(normalizeText(expectedIdentity.variantName))) {
        identityVerdict = 'wrong_variant';
      } else {
        identityVerdict = 'correct_match';
      }
    } else {
      identityVerdict = 'wrong_product';
    }
  } else if (normExtTitle && normExpTitle) {
    const titleMatch = normExtTitle.includes(normExpTitle) || normExpTitle.includes(normExtTitle);
    const brandMatch = !normExpBrand || !normExtBrand || normExtBrand.includes(normExpBrand) || normExpBrand.includes(normExtBrand);

    if (titleMatch && brandMatch) {
      if (expectedIdentity.variantName && !normExtTitle.includes(normalizeText(expectedIdentity.variantName))) {
        identityVerdict = 'wrong_variant';
      } else {
        identityVerdict = 'correct_match';
      }
    } else if (brandMatch && !titleMatch) {
      identityVerdict = 'wrong_product';
    } else {
      identityVerdict = 'wrong_product';
    }
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

  // Step 2: Per-Field Correctness
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

    const expectedVal = spec.expectedValue ?? null;
    const provenance = outcome.data.fieldProvenance?.[field] || 'unknown';

    const conflict = outcome.conflicts?.find(c => c.field === field);
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
        status: isUnavailableSuccess ? (isInapplicable ? 'inapplicable' : 'unavailable') : 'incorrect',
        correct: isUnavailableSuccess,
        conflictDetails,
        missingReason: isUnavailableSuccess ? missingReason : (conflict ? 'conflicted' : null),
        missingExplanation: isUnavailableSuccess
          ? missingExplanation
          : (conflict ? `Conflicted: ${conflictDetails}` : null),
      };
    } else {
      // Available on the page: must be extracted and match
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
        } else {
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

  // Count True Positives and False Positives among admitted images
  let truePositives = 0;
  let falsePositives = 0;

  for (const img of admitted) {
    const canon = canonicalizeUrl(img, sample.url);
    if (admissibleCanonicals.has(canon)) {
      truePositives++;
    } else if (inadmissibleCanonicals.has(canon) || (admissibleCanonicals.size > 0 && !admissibleCanonicals.has(canon))) {
      falsePositives++;
    }
  }

  // Count False Negatives
  const admittedCanonicals = new Set(admitted.map(u => canonicalizeUrl(u, sample.url)));
  let falseNegatives = 0;
  for (const expImg of admissibleList) {
    const canon = canonicalizeUrl(expImg, sample.url);
    if (!admittedCanonicals.has(canon)) {
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
    conflicts: outcome.conflicts,
    imageRejectionReasons: outcome.imageRejectionReasons,
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
  };
}
