import { describe, it, expect } from 'vitest';
import { scoreExtraction } from '../../onboarding/profile-audit/scorer';
import type { AuditManifestSample, ExtractionOutcome } from '../../onboarding/profile-audit/types';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';

describe('profile audit scoring', () => {
  const sample: AuditManifestSample = {
    sampleId: 'sample-1',
    url: 'https://earthbath.com/products/hot-spot-relief-spray',
    domain: 'earthbath.com',
    stratum: 'standard_pdp',
    inventoryStatus: 'confirmed',
    artifactRef: 'earthbath.com/snapshot-1/page.html',
    supplementalArtifactRefs: [],
    hasSupplementalArtifact: false, // tests missing supplemental artifact
    captureFreshness: '2026-08-21T18:06:00Z',
    groundTruth: {
      identity: {
        brand: 'earthbath',
        productName: 'Hot Spot Relief Spray',
      },
      fields: {
        title: { available: true, expectedValue: 'Hot Spot Relief Spray' },
        brand: { available: true, expectedValue: 'earthbath' },
        price: { available: false }, // not available on brand site
        gtin: { available: false },  // not available on brand site
        description: { available: true },
      },
      images: {
        primaryImage: 'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
        admissibleImages: [
          'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
          'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back.png?width=1200',
        ],
        inadmissibleImages: [
          'https://earthbath.com/cdn/shop/files/DogProducts_banner.png?width=1200',
        ],
      },
    },
  };

  it('correctly scores available fields and does not penalize unavailable fields', () => {
    const outcome: ExtractionOutcome = {
      configuration: 'current_extraction',
      data: ExtractionDataSchema.parse({
        title: 'Hot Spot Relief Spray',
        brand: 'earthbath',
        description: 'Soothing spray for dogs with tea tree oil and aloe vera',
        price: null, // unavailable on page, should be marked correct
        primaryImage: 'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
        additionalImages: [
          'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back.png?width=1200',
          'https://earthbath.com/cdn/shop/files/DogProducts_banner.png?width=1200',
        ],
        bulletPoints: [],
        confidence: 1,
      }),
      admittedImages: [
        'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
        'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back.png?width=1200',
        'https://earthbath.com/cdn/shop/files/DogProducts_banner.png?width=1200',
      ],
      rejectedImages: [],
      primaryImage: 'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
      isEvidenceGap: false,
    };

    const scored = scoreExtraction(outcome, sample);

    expect(scored.identityVerdict).toBe('correct_match');
    expect(scored.fieldScores.title.correct).toBe(true);
    expect(scored.fieldScores.brand.correct).toBe(true);
    expect(scored.fieldScores.price.status).toBe('unavailable');
    expect(scored.fieldScores.price.correct).toBe(true);
    expect(scored.fieldScores.gtin.status).toBe('unavailable');
    expect(scored.fieldScores.gtin.correct).toBe(true);
    expect(scored.fieldCorrectnessScore).toBe(1.0);

    // Image metrics: 2 TP, 1 FP (DogProducts_banner) -> precision 2/3 = 0.667, recall 2/2 = 1.0
    expect(scored.imageScores.primaryAccuracy).toBe(1);
    expect(scored.imageScores.precision).toBeCloseTo(0.667, 2);
    expect(scored.imageScores.recall).toBe(1.0);

    // Missing supplemental artifact recorded as failure code
    expect(scored.failureCodes).toContain('EVIDENCE_GAP_MISSING_SUPPLEMENTAL');
    expect(scored.failureCodes).toContain('LOW_IMAGE_PRECISION');
  });

  it('records missing artifact as evidence gap, not parser failure', () => {
    const outcome: ExtractionOutcome = {
      configuration: 'current_extraction',
      data: ExtractionDataSchema.parse({
        title: null,
        brand: null,
        description: null,
        price: null,
        primaryImage: null,
        additionalImages: [],
        bulletPoints: [],
        confidence: 0,
      }),
      admittedImages: [],
      rejectedImages: [],
      primaryImage: null,
      isEvidenceGap: true,
      evidenceGapReason: 'Snapshot artifact not found',
    };

    const scored = scoreExtraction(outcome, sample);

    expect(scored.isEvidenceGap).toBe(true);
    expect(scored.failureCodes).toContain('EVIDENCE_GAP_MISSING_ARTIFACT');
    expect(scored.identityVerdict).toBe('unidentified');
  });

  it('is deterministic: same outcome and sample produce identical score rows', () => {
    const outcome: ExtractionOutcome = {
      configuration: 'current_strict_images',
      data: ExtractionDataSchema.parse({
        title: 'Hot Spot Relief Spray',
        brand: 'earthbath',
        description: 'Soothing spray',
        price: null,
        primaryImage: 'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
        additionalImages: ['https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back.png?width=1200'],
        bulletPoints: [],
        confidence: 1,
      }),
      admittedImages: [
        'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
        'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back.png?width=1200',
      ],
      rejectedImages: ['https://earthbath.com/cdn/shop/files/DogProducts_banner.png?width=1200'],
      primaryImage: 'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front.png?width=1200',
      isEvidenceGap: false,
    };

    const row1 = scoreExtraction(outcome, sample);
    const row2 = scoreExtraction(outcome, sample);

    expect(row1).toEqual(row2);
  });

  it('scores PARENT_PAGE_VARIANT_CONFUSION and surfaces identityResolution', () => {
    const outcome: ExtractionOutcome = {
      configuration: 'hybrid_identity_first',
      data: ExtractionDataSchema.parse({
        title: 'Hot Spot Relief Spray', // Generic parent title, missing expected variant details
        brand: 'earthbath',
        description: 'Soothing spray',
        price: null,
        primaryImage: null,
        additionalImages: [],
        bulletPoints: [],
        confidence: 1,
      }),
      identityResolution: {
        status: 'resolved_variant',
        parentPageUrl: sample.url,
        totalCandidates: 2,
        selectedVariantKey: 'var-1',
        selectedCandidateTitle: 'Hot Spot Relief Spray 8oz',
        parentTitle: 'Hot Spot Relief Spray',
        matchedBy: 'gtin',
        confusionDetected: true,
        confusionType: 'parent_vs_variant',
        confusionDetails: 'Parent title lacks variant distinguishing details',
      },
      admittedImages: [],
      rejectedImages: [],
      primaryImage: null,
      isEvidenceGap: false,
    };

    const scored = scoreExtraction(outcome, sample);

    expect(scored.failureCodes).toContain('PARENT_PAGE_VARIANT_CONFUSION');
    expect(scored.identityResolution?.confusionDetected).toBe(true);
    expect(scored.identityResolution?.confusionType).toBe('parent_vs_variant');
  });

  it('scores FIELD_CONFLICT and attaches detailed conflict provenance to fieldScores', () => {
    const outcome: ExtractionOutcome = {
      configuration: 'hybrid_identity_first',
      data: ExtractionDataSchema.parse({
        title: 'Hot Spot Relief Spray',
        brand: 'earthbath',
        description: 'Soothing spray',
        price: null,
        primaryImage: null,
        additionalImages: [],
        bulletPoints: [],
        confidence: 1,
      }),
      conflicts: [
        {
          field: 'title',
          selectorValue: 'Hot Spot Relief Spray',
          structuredValue: 'Hot Spot Soothing Spray Organic',
          selectorSource: 'custom-selector',
          structuredSource: 'json-ld',
          resolution: 'selector_preferred_with_conflict',
        },
      ],
      admittedImages: [],
      rejectedImages: [],
      primaryImage: null,
      isEvidenceGap: false,
    };

    const scored = scoreExtraction(outcome, sample);

    expect(scored.failureCodes).toContain('FIELD_CONFLICT');
    expect(scored.fieldScores.title.status).toBe('conflict');
    expect(scored.fieldScores.title.conflictDetails).toContain('Selector (custom-selector): "Hot Spot Relief Spray"');
    expect(scored.fieldScores.title.conflictDetails).toContain('Structured (json-ld): "Hot Spot Soothing Spray Organic"');
    expect(scored.conflicts).toHaveLength(1);
  });

  it('maps unresolved_parent and wrong_variant_selected to ambiguous and wrong_variant respectively', () => {
    const unresolvedOutcome: ExtractionOutcome = {
      configuration: 'hybrid_identity_first',
      data: ExtractionDataSchema.parse({
        title: 'Hot Spot Relief Spray',
        brand: 'earthbath',
        confidence: 1,
      }),
      identityResolution: {
        status: 'parent_page',
        parentPageUrl: sample.url,
        totalCandidates: 3,
        selectedVariantKey: null,
        confusionDetected: true,
        confusionType: 'unresolved_parent',
        confusionDetails: 'Multi-variant parent page has 3 variant candidates, but no variant could be resolved.',
      },
      admittedImages: [],
      rejectedImages: [],
      primaryImage: null,
      isEvidenceGap: false,
    };

    const scoredUnresolved = scoreExtraction(unresolvedOutcome, sample);
    expect(scoredUnresolved.identityVerdict).toBe('ambiguous');
    expect(scoredUnresolved.failureCodes).toContain('PARENT_PAGE_VARIANT_CONFUSION');

    const wrongVariantOutcome: ExtractionOutcome = {
      ...unresolvedOutcome,
      identityResolution: {
        ...unresolvedOutcome.identityResolution!,
        status: 'resolved_variant',
        confusionType: 'wrong_variant_selected',
      },
    };

    const scoredWrong = scoreExtraction(wrongVariantOutcome, sample);
    expect(scoredWrong.identityVerdict).toBe('wrong_variant');
    expect(scoredWrong.failureCodes).toContain('WRONG_VARIANT');
    expect(scoredWrong.failureCodes).toContain('PARENT_PAGE_VARIANT_CONFUSION');
  });

  it('evaluates GTIN equivalence with 12 vs 13 digit padding without false wrong_product', () => {
    const gtinSample: AuditManifestSample = {
      ...sample,
      groundTruth: {
        ...sample.groundTruth,
        identity: {
          brand: 'earthbath',
          productName: 'Hot Spot Relief Spray',
          gtin: '0012345678901', // 13-digit EAN
        },
      },
    };

    const outcome: ExtractionOutcome = {
      configuration: 'hybrid_identity_first',
      data: ExtractionDataSchema.parse({
        title: 'Hot Spot Relief Spray',
        brand: 'earthbath',
        confidence: 1,
      }),
      admittedImages: [],
      rejectedImages: [],
      primaryImage: null,
      isEvidenceGap: false,
    };
    (outcome.data as Record<string, unknown>).gtin = '012345678901'; // 12-digit UPC (canonical match)

    const scored = scoreExtraction(outcome, gtinSample);
    expect(scored.identityVerdict).toBe('correct_match');
    expect(scored.failureCodes).not.toContain('WRONG_PRODUCT');
  });
});
