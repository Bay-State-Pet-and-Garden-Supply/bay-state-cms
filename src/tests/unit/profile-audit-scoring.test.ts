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

  // ──────────────────────────────────────────────────────────────────────────
  // Issue #189: Acceptance Criterion 1 — Discriminating Identity Scoring
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 1: Generic title fragments never score accepted identity match or correct title', () => {
    it('stays unidentified and scores title incorrect when extracted title is a generic fragment with no identifying codes', () => {
      const fragmentSample: AuditManifestSample = {
        ...sample,
        groundTruth: {
          ...sample.groundTruth,
          identity: {
            brand: 'earthbath',
            productName: 'Hot Spot Relief Spray',
            gtin: null,
            sku: null,
          },
          fields: {
            ...sample.groundTruth.fields,
            title: { available: true, expectedValue: 'Hot Spot Relief Spray' },
          },
        },
      };

      const outcome: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Spray', // Bare category word / generic title fragment
          brand: 'earthbath',
          confidence: 1,
        }),
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(outcome, fragmentSample);

      // Identity stays unidentified, never scores correct_match
      expect(scored.identityVerdict).toBe('unidentified');
      expect(scored.identityVerdict).not.toBe('correct_match');
      expect(scored.failureCodes).toContain('IDENTITY_MISMATCH');

      // Title field is judged incorrect, never scores correct
      expect(scored.fieldScores.title.correct).toBe(false);
      expect(scored.fieldScores.title.status).toBe('incorrect');
      expect(scored.failureCodes).toContain('MISSING_AVAILABLE_FIELD');
      expect(scored.fieldCorrectnessScore).toBeLessThan(1.0);
    });

    it('stays unidentified when extracted title is bare category word "Dog Food" against full product name', () => {
      const dogFoodSample: AuditManifestSample = {
        ...sample,
        groundTruth: {
          ...sample.groundTruth,
          identity: {
            brand: 'Acme',
            productName: 'Acme Ultra Dog Food 5lb Bag',
          },
          fields: {
            title: { available: true, expectedValue: 'Acme Ultra Dog Food 5lb Bag' },
            brand: { available: true, expectedValue: 'Acme' },
          },
        },
      };

      const outcome: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Dog Food',
          brand: 'Acme',
          confidence: 1,
        }),
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(outcome, dogFoodSample);
      expect(scored.identityVerdict).toBe('unidentified');
      expect(scored.fieldScores.title.correct).toBe(false);
    });

    it('resolves identity via deterministic GTIN match but generic title fragment still scores title incorrect', () => {
      const gtinSample: AuditManifestSample = {
        ...sample,
        groundTruth: {
          ...sample.groundTruth,
          identity: {
            brand: 'earthbath',
            productName: 'Hot Spot Relief Spray',
            gtin: '0012345678901',
          },
          fields: {
            title: { available: true, expectedValue: 'Hot Spot Relief Spray' },
            brand: { available: true, expectedValue: 'earthbath' },
          },
        },
      };

      const outcome: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Spray', // Generic fragment
          brand: 'earthbath',
          confidence: 1,
        }),
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };
      (outcome.data as Record<string, unknown>).gtin = '012345678901'; // Canonical GTIN match

      const scored = scoreExtraction(outcome, gtinSample);

      // Identity resolved deterministically by GTIN code
      expect(scored.identityVerdict).toBe('correct_match');

      // But title field itself is STILL evaluated by its own rule and fails
      expect(scored.fieldScores.title.correct).toBe(false);
      expect(scored.fieldScores.title.status).toBe('incorrect');
      expect(scored.failureCodes).toContain('MISSING_AVAILABLE_FIELD');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Issue #189: Acceptance Criterion 2 — Field Comparison Rules & Conflicts
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 2: Selector-versus-structured conflicts and individual field rules', () => {
    it('judges title, price, brand, and identifiers each by their own rule', () => {
      const rulesSample: AuditManifestSample = {
        ...sample,
        groundTruth: {
          ...sample.groundTruth,
          identity: {
            brand: 'Earthbath',
            productName: 'Hot Spot Relief Spray 8oz',
            gtin: '0012345678901',
            sku: 'SKU-SPRAY-8',
          },
          fields: {
            title: { available: true, expectedValue: 'Hot Spot Relief Spray 8oz' },
            brand: { available: true, expectedValue: 'Earthbath' },
            price: { available: true, expectedValue: '$14.99' },
            gtin: { available: true, expectedValue: '0012345678901' },
            sku: { available: true, expectedValue: 'SKU-SPRAY-8' },
          },
        },
      };

      // 1. Exact / canonical matches for each field
      const outcomeMatching: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Hot Spot Relief Spray 8oz',
          brand: 'Earthbath',
          price: '14.99', // Numeric equality matches $14.99
          confidence: 1,
        }),
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };
      (outcomeMatching.data as Record<string, unknown>).gtin = '012345678901'; // Canonical 12 vs 13 digits
      (outcomeMatching.data as Record<string, unknown>).sku = 'sku-spray-8'; // Case-insensitive normalized SKU

      const scoredMatching = scoreExtraction(outcomeMatching, rulesSample);
      expect(scoredMatching.fieldScores.title.correct).toBe(true);
      expect(scoredMatching.fieldScores.brand.correct).toBe(true);
      expect(scoredMatching.fieldScores.price.correct).toBe(true);
      expect(scoredMatching.fieldScores.gtin.correct).toBe(true);
      expect(scoredMatching.fieldScores.sku.correct).toBe(true);
      expect(scoredMatching.fieldCorrectnessScore).toBe(1.0);

      // 2. Substrings and price differences must NOT match
      const outcomeSubstrings: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Spray', // Fragment
          brand: 'Earth', // Substring of Earthbath
          price: '19.99', // Price disagreement
          confidence: 1,
        }),
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };
      (outcomeSubstrings.data as Record<string, unknown>).gtin = '1234'; // Substring of GTIN
      (outcomeSubstrings.data as Record<string, unknown>).sku = 'SKU'; // Substring of SKU

      const scoredSubstrings = scoreExtraction(outcomeSubstrings, rulesSample);
      expect(scoredSubstrings.fieldScores.title.correct).toBe(false);
      expect(scoredSubstrings.fieldScores.brand.correct).toBe(false);
      expect(scoredSubstrings.fieldScores.price.correct).toBe(false);
      expect(scoredSubstrings.fieldScores.gtin.correct).toBe(false);
      expect(scoredSubstrings.fieldScores.sku.correct).toBe(false);
      expect(scoredSubstrings.fieldCorrectnessScore).toBe(0.0);
    });

    it('surfaces selector-versus-structured disagreements as conflicts with provenance', () => {
      const conflictOutcome: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Selector Title 16oz',
          brand: 'Selector Brand',
          price: '$12.99',
          confidence: 1,
          fieldProvenance: {
            title: 'custom-selector',
            brand: 'custom-selector',
            price: 'custom-selector',
          },
        }),
        raw: {
          custom: {
            title: 'Selector Title 16oz',
            brand: 'Selector Brand',
            price: '$12.99',
            sku: 'SEL-SKU-1',
          },
          jsonLd: {
            name: 'Structured JSON-LD Title 32oz',
            brand: { name: 'Structured Brand' },
            offers: { price: '24.99' },
            sku: 'STR-SKU-2',
          },
        },
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(conflictOutcome, sample);

      expect(scored.failureCodes).toContain('FIELD_CONFLICT');
      expect(scored.conflicts).toBeDefined();
      expect(scored.conflicts!.length).toBeGreaterThanOrEqual(3);

      const titleConflict = scored.conflicts!.find(c => c.field === 'title');
      expect(titleConflict).toBeDefined();
      expect(titleConflict?.selectorSource).toBe('custom-selector');
      expect(titleConflict?.structuredSource).toBe('json-ld');
      expect(titleConflict?.selectorValue).toBe('Selector Title 16oz');
      expect(titleConflict?.structuredValue).toBe('Structured JSON-LD Title 32oz');

      const priceConflict = scored.conflicts!.find(c => c.field === 'price');
      expect(priceConflict).toBeDefined();
      expect(priceConflict?.selectorValue).toBe('$12.99');
      expect(priceConflict?.structuredValue).toBe('24.99');

      expect(scored.fieldScores.title.status).toBe('conflict');
      expect(scored.fieldScores.title.conflictDetails).toContain('Selector (custom-selector): "Selector Title 16oz"');
      expect(scored.fieldScores.title.conflictDetails).toContain('Structured (json-ld): "Structured JSON-LD Title 32oz"');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Issue #189: Acceptance Criterion 3 — Duplicate-Fair Image Scores
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 3: Duplicate-fair image recall and duplicate contamination reporting', () => {
    it('scores half recall with duplicate contamination reported when 10 admissions of one hero image occur with second expected image missing', () => {
      const twoImageSample: AuditManifestSample = {
        ...sample,
        groundTruth: {
          ...sample.groundTruth,
          images: {
            primaryImage: 'https://example.com/hero.jpg',
            admissibleImages: [
              'https://example.com/hero.jpg',
              'https://example.com/gallery-back.jpg',
            ],
            inadmissibleImages: [
              'https://example.com/unrelated-banner.jpg',
            ],
          },
        },
      };

      // 10 admissions of one hero image, with gallery-back.jpg missing
      const tenHeroAdmissions: string[] = Array(10).fill('https://example.com/hero.jpg');

      const outcome: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Hot Spot Relief Spray',
          brand: 'earthbath',
          confidence: 1,
        }),
        admittedImages: tenHeroAdmissions,
        rejectedImages: [],
        primaryImage: 'https://example.com/hero.jpg',
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(outcome, twoImageSample);

      // Recall must be exactly 0.5 (half recall), NOT ~0.909 (10/11) from duplicate inflation!
      expect(scored.imageScores.recall).toBe(0.5);

      // Precision over unique canonical set is 1.0 (hero image is admissible)
      expect(scored.imageScores.precision).toBe(1.0);

      // Primary image matches
      expect(scored.imageScores.primaryAccuracy).toBe(1);

      // Duplicate contamination is reported separately
      expect(scored.imageScores.duplicateContamination).toBe(true);
      expect(scored.imageScores.duplicateContaminationCount).toBe(9);
      expect(scored.duplicateContamination).toBe(true);
      expect(scored.duplicateContaminationCount).toBe(9);
    });
  });
});
