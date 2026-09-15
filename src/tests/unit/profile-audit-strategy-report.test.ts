import { describe, it, expect } from 'vitest';
import { generateAdapterStrategyReport } from '../../onboarding/profile-audit/adapter-strategy-report';
import { buildVersionedCorpus } from '../../onboarding/profile-audit/versioned-corpus';
import type {
  AuditManifestSample,
  AuditScoredRow,
  ReplayConfiguration,
} from '../../shared/schemas/profile-audit';
import { profileInspectRoutes } from '../../server/routes/profile-inspect-routes';

describe('Evidence-Chosen Adapter Strategy Report (Issue #192 / Audit Follow-Through T8)', () => {
  const domain = 'earthbath.com';
  const labelVersion = '2.2.0';

  function createScoredRow(
    sample: AuditManifestSample,
    configuration: ReplayConfiguration,
    overrides: Partial<AuditScoredRow> = {},
  ): AuditScoredRow {
    const isHybrid = configuration === 'hybrid_identity_first';
    const isBlocked = sample.isProfileBlocked;

    return {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration,
      identityVerdict: isBlocked ? 'unidentified' : 'correct_match',
      fieldCorrectnessScore: isBlocked ? 0 : (isHybrid ? 0.95 : 0.8),
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: isBlocked ? null : sample.groundTruth.identity.productName,
          expectedValue: sample.groundTruth.identity.productName,
          provenance: isHybrid ? 'structured' : 'custom-selector',
          status: isBlocked ? 'missing' : 'correct',
          correct: !isBlocked,
        },
        brand: {
          field: 'brand',
          available: true,
          extractedValue: isBlocked ? null : sample.groundTruth.identity.brand,
          expectedValue: sample.groundTruth.identity.brand,
          provenance: isHybrid ? 'structured' : 'custom-selector',
          status: isBlocked ? 'missing' : 'correct',
          correct: !isBlocked,
        },
        price: {
          field: 'price',
          available: true,
          extractedValue: isBlocked ? null : '15.99',
          expectedValue: '15.99',
          provenance: isHybrid ? 'structured' : 'custom-selector',
          status: isBlocked ? 'missing' : 'correct',
          correct: !isBlocked,
        },
      },
      imageScores: {
        extractedImages: isBlocked ? [] : sample.groundTruth.images.admissibleImages,
        admittedImages: isBlocked ? [] : sample.groundTruth.images.admissibleImages,
        rejectedImages: [],
        primaryImage: isBlocked ? null : sample.groundTruth.images.primaryImage,
        primaryAccuracy: isBlocked ? 0 : 1,
        precision: isBlocked ? 0 : (isHybrid ? 0.95 : 0.8),
        recall: isBlocked ? 0 : (isHybrid ? 0.9 : 0.85),
      },
      failureCodes: isBlocked ? ['MISSING_AVAILABLE_FIELD'] : ['NONE'],
      isEvidenceGap: false,
      extractedProductPreview: {
        title: isBlocked ? null : sample.groundTruth.identity.productName,
        brand: isBlocked ? null : sample.groundTruth.identity.brand,
      },
      ...overrides,
    };
  }

  it('records all required comparison fields per scope: time to first profile, manual corrections, sibling pass rate, wrong product/image counts, and operator minutes', async () => {
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: true,
    });

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        rows.push(createScoredRow(s, cfg));
      }
    }

    const report = generateAdapterStrategyReport({
      manifest: corpus,
      rows,
      options: {
        workspaceFlows: {
          standard_pdp: {
            timeToFirstWorkingProfileMs: 45000,
            timeToFirstWorkingProfileProvenance: 'measured',
            manualCorrectionsPerProfile: 1,
            manualCorrectionsProvenance: 'measured',
            siblingPassRate: 0.95,
            siblingPassRateUncertainty: 0.04,
            siblingPassRateProvenance: 'measured',
            wrongProductCount: 0,
            wrongImageCount: 0,
          },
        },
      },
    });

    expect(report.domain).toBe(domain);
    expect(report.labelVersion).toBe(labelVersion);
    expect(Object.keys(report.recommendationsByScope)).toContain('standard_pdp');

    const standardScope = report.recommendationsByScope.standard_pdp;
    expect(standardScope).toBeDefined();

    // 1. Time to first working profile
    expect(standardScope.adapterMetrics.timeToFirstWorkingProfileMs).toBe(45000);
    expect(standardScope.adapterMetrics.timeToFirstWorkingProfileProvenance).toBe('measured');
    expect(standardScope.selectorMetrics.timeToFirstWorkingProfileMs).toBeGreaterThan(0);
    expect(standardScope.selectorMetrics.timeToFirstWorkingProfileProvenance).toBe('modeled');

    // 2. Manual corrections per profile
    expect(standardScope.adapterMetrics.manualCorrectionsPerProfile).toBe(1);
    expect(standardScope.adapterMetrics.manualCorrectionsProvenance).toBe('measured');
    expect(standardScope.selectorMetrics.manualCorrectionsPerProfile).toBe(5);
    expect(standardScope.selectorMetrics.manualCorrectionsProvenance).toBe('modeled');

    // 3. Sibling-page pass rate
    expect(standardScope.adapterMetrics.siblingPassRate).toBe(0.95);
    expect(standardScope.adapterMetrics.siblingPassRateUncertainty).toBe(0.04);
    expect(standardScope.adapterMetrics.siblingPassRateProvenance).toBe('measured');
    expect(standardScope.selectorMetrics.siblingPassRate).toBeDefined();

    // 4. Wrong product and wrong image counts
    expect(standardScope.adapterMetrics.wrongProductCount).toBe(0);
    expect(standardScope.adapterMetrics.wrongImageCount).toBe(0);
    expect(standardScope.selectorMetrics.wrongProductCount).toBeDefined();
    expect(standardScope.selectorMetrics.wrongImageCount).toBeDefined();

    // 5. Operator minutes (modeled values explicitly labeled)
    expect(standardScope.adapterMetrics.operatorMinutes).toBeGreaterThan(0);
    expect(standardScope.adapterMetrics.operatorMinutesProvenance).toBe('modeled');
    expect(standardScope.selectorMetrics.operatorMinutes).toBeGreaterThan(0);
    expect(standardScope.selectorMetrics.operatorMinutesProvenance).toBe('modeled');
  });

  it('derives strategy recommendation from baseline numbers with uncertainty and records thresholds and label version for exact reproduction', async () => {
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: true,
    });

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        rows.push(createScoredRow(s, cfg));
      }
    }

    const report1 = generateAdapterStrategyReport({ manifest: corpus, rows });
    const report2 = generateAdapterStrategyReport({ manifest: corpus, rows });

    // Exact reproduction check
    expect(report1.labelVersion).toBe(report2.labelVersion);
    expect(report1.overallRecommendation).toBe(report2.overallRecommendation);

    const scope1 = report1.recommendationsByScope.standard_pdp;
    const scope2 = report2.recommendationsByScope.standard_pdp;

    expect(scope1.recommendation).toBe(scope2.recommendation);
    expect(scope1.labelVersion).toBe(labelVersion);
    expect(scope1.thresholds.length).toBe(scope2.thresholds.length);

    for (let i = 0; i < scope1.thresholds.length; i++) {
      expect(scope1.thresholds[i].name).toBe(scope2.thresholds[i].name);
      expect(scope1.thresholds[i].baselineValue).toBe(scope2.thresholds[i].baselineValue);
      expect(scope1.thresholds[i].thresholdValue).toBe(scope2.thresholds[i].thresholdValue);
      expect(scope1.thresholds[i].actualValue).toBe(scope2.thresholds[i].actualValue);
      expect(scope1.thresholds[i].passed).toBe(scope2.thresholds[i].passed);
    }

    // Recommendation was chosen as adapter_with_css_exceptions on valid reviewed samples
    expect(scope1.recommendation).toBe('adapter_with_css_exceptions');
    expect(scope1.recommendationBadge).toContain('ADAPTER');
    expect(scope1.allThresholdsPassed).toBe(true);
  });

  it('recommends needs_review when ground truth labels are unreviewed or auto-derived (never promotes by fiat)', async () => {
    // Unreviewed corpus with auto-derived label provenance
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: false,
    });

    // Mark samples as auto-derived / unreviewed
    for (const s of corpus.samples) {
      s.isReviewed = false;
      s.groundTruthSource = 'auto-derived';
    }

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        rows.push(createScoredRow(s, cfg));
      }
    }

    const report = generateAdapterStrategyReport({ manifest: corpus, rows });
    const standardScope = report.recommendationsByScope.standard_pdp;

    expect(standardScope.recommendation).toBe('needs_review');
    expect(standardScope.recommendationBadge).toContain('NEEDS REVIEW');
    expect(standardScope.recommendationRationale.some(r => r.includes('unreviewed') || r.includes('auto-derived'))).toBe(true);

    const provCheck = standardScope.thresholds.find(t => t.dimension === 'label_provenance');
    expect(provCheck).toBeDefined();
    expect(provCheck?.passed).toBe(false);
  });

  it('recommends custom_selectors when platform structured data regresses/fails on that scope while selectors pass', async () => {
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: true,
    });

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        if (cfg === 'hybrid_identity_first') {
          // Structured data failed / wrong product identity error
          rows.push(
            createScoredRow(s, cfg, {
              identityVerdict: 'wrong_product',
              failureCodes: ['WRONG_PRODUCT'],
            }),
          );
        } else if (cfg === 'current_extraction') {
          // Custom selectors succeed cleanly
          rows.push(
            createScoredRow(s, cfg, {
              identityVerdict: 'correct_match',
              fieldCorrectnessScore: 0.95,
              failureCodes: ['NONE'],
            }),
          );
        } else {
          rows.push(createScoredRow(s, cfg));
        }
      }
    }

    const report = generateAdapterStrategyReport({
      manifest: corpus,
      rows,
      options: {
        workspaceFlows: {
          standard_pdp: {
            siblingPassRate: 0.2, // Adapter sibling validation failed
            wrongProductCount: 2, // Adapter has wrong products
          },
        },
      },
    });

    const standardScope = report.recommendationsByScope.standard_pdp;
    expect(standardScope.recommendation).toBe('custom_selectors');
    expect(standardScope.recommendationBadge).toContain('SELECTOR-LED');
    expect(standardScope.recommendationRationale.some(r => r.includes('regressed') || r.includes('failed'))).toBe(true);
  });

  it('draws on workspace flow measurements end to end and labels measured values explicitly', async () => {
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: true,
    });

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        rows.push(createScoredRow(s, cfg));
      }
    }

    const report = generateAdapterStrategyReport({
      manifest: corpus,
      rows,
      options: {
        operatorMinutesOverride: {
          [domain]: {
            current_extraction: 18.5,
            current_strict_images: 14.0,
            structured_only: 4.0,
            hybrid_identity_first: 1.2,
          },
        },
        workspaceFlows: {
          standard_pdp: {
            timeToFirstWorkingProfileMs: 32000,
            timeToFirstWorkingProfileProvenance: 'measured',
            manualCorrectionsPerProfile: 2,
            manualCorrectionsProvenance: 'measured',
            siblingPassRate: 0.98,
            siblingPassRateUncertainty: 0.02,
            siblingPassRateConfidenceInterval: { lower: 0.94, upper: 1.0 },
            siblingPassRateProvenance: 'measured',
            wrongProductCount: 0,
            wrongImageCount: 0,
          },
        },
      },
    });

    const s = report.recommendationsByScope.standard_pdp;
    expect(s.adapterMetrics.timeToFirstWorkingProfileProvenance).toBe('measured');
    expect(s.adapterMetrics.timeToFirstWorkingProfileMs).toBe(32000);
    expect(s.adapterMetrics.manualCorrectionsProvenance).toBe('measured');
    expect(s.adapterMetrics.manualCorrectionsPerProfile).toBe(2);
    expect(s.adapterMetrics.siblingPassRateProvenance).toBe('measured');
    expect(s.adapterMetrics.siblingPassRate).toBe(0.98);
    expect(s.adapterMetrics.siblingPassRateConfidenceInterval).toEqual({ lower: 0.94, upper: 1.0 });

    // Operator minutes override labeled as measured
    expect(s.adapterMetrics.operatorMinutes).toBe(1.2);
    expect(s.adapterMetrics.operatorMinutesProvenance).toBe('measured');
    expect(s.selectorMetrics.operatorMinutes).toBe(18.5);
    expect(s.selectorMetrics.operatorMinutesProvenance).toBe('measured');

    // Markdown rendered correctly
    expect(report.markdown).toContain('Evidence-Chosen Adapter Strategy Report');
    expect(report.markdown).toContain('standard_pdp');
    expect(report.markdown).toContain('ADAPTER (STRUCTURE + CSS EXCEPTIONS)');
    expect(report.markdown).toContain('1.2m (measured)');
    expect(report.markdown).toContain('18.5m (measured)');
  });

  it('renders markdown tables with proper headers, alignment, and badges', async () => {
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: true,
    });

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        rows.push(createScoredRow(s, cfg));
      }
    }

    const report = generateAdapterStrategyReport({ manifest: corpus, rows });

    expect(report.markdown).toContain('| Scope | Platform | Recommendation | Time to 1st Profile (Sel → Adp) |');
    expect(report.markdown).toContain('## Derived Strategy Thresholds & Uncertainty Audit');
    expect(report.markdown).toContain('## Actionable Scope Recommendations & Rationale');
  });

  it('serves strategy report via POST /domains/:domain/profile/strategy-report endpoint', async () => {
    const corpus = await buildVersionedCorpus({
      domain,
      labelVersion,
      isReviewed: true,
    });

    const rows: AuditScoredRow[] = [];
    const configs: ReplayConfiguration[] = [
      'current_extraction',
      'current_strict_images',
      'structured_only',
      'hybrid_identity_first',
    ];

    for (const s of corpus.samples) {
      for (const cfg of configs) {
        rows.push(createScoredRow(s, cfg));
      }
    }

    const res = await profileInspectRoutes.request(
      `/domains/${domain}/profile/strategy-report`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: corpus,
          rows,
        }),
      },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.domain).toBe(domain);
    expect(json.labelVersion).toBe(labelVersion);
    expect(json.recommendationsByScope.standard_pdp.recommendation).toBe('adapter_with_css_exceptions');
    expect(json.overallRecommendation).toBe('needs_review');
    expect(json.markdown).toContain('Evidence-Chosen Adapter Strategy Report');
  });
});
