import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildVersionedCorpus,
  getRepresentativeCorpusFixtures,
} from '../../onboarding/profile-audit/versioned-corpus';
import {
  evaluateGateArithmetic,
  evaluateScopeGate,
} from '../../onboarding/profile-audit/gate-arithmetic';
import {
  generatePromotionReport,
  formatScopePromotionTable,
  formatCostAnalysisTable,
} from '../../onboarding/profile-audit/promotion-report';
import {
  formatReviewableManifest,
} from '../../onboarding/profile-audit/reviewable-table';
import {
  formatSideBySideFieldEvidenceTable,
  formatImageContactSheetMarkdown,
  buildSideBySideFieldEvidence,
  buildImageContactSheet,
} from '../../onboarding/profile-audit/operator-review';
import { scoreExtraction } from '../../onboarding/profile-audit/scorer';
import type {
  AuditManifestSample,
  AuditScoredRow,
  ReplayConfiguration,
} from '../../shared/schemas/profile-audit';
import type { ExtractionOutcome } from '../../onboarding/profile-audit/types';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';

describe('Profile Audit Versioned Labeled Corpus with Holdouts (Issue #190 / Audit Follow-Through T6)', () => {
  const domain = 'earthbath.com';
  const labelVersion = '2.1.0';

  // Helper to create synthetic scored rows for a sample
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

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 1: Deterministic Corpus Builder with Reviewed Labels,
  // Holdouts, Exclusion of Distributor Records, and Profile-Blocked Fail-Closed
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 1: Deterministic corpus builder with reviewed, versioned labels and holdouts', () => {
    it('builds deterministically with reviewed, versioned labels and disjoint holdout families', async () => {
      const corpusA = await buildVersionedCorpus({
        domain,
        labelVersion,
        splitSeed: 42,
        holdoutPercent: 25,
      });

      const corpusB = await buildVersionedCorpus({
        domain,
        labelVersion,
        splitSeed: 42,
        holdoutPercent: 25,
      });

      // 1. Determinism: identical options produce identical corpus
      expect(corpusA.corpusId).toBe(`${domain}:corpus:${labelVersion}`);
      expect(corpusA.labelVersion).toBe(labelVersion);
      expect(corpusA.isReviewed).toBe(true);
      expect(corpusA.samples.length).toBe(corpusB.samples.length);
      expect(getRepresentativeCorpusFixtures(domain).length).toBeGreaterThan(0);
      expect(corpusA.samples.map(s => s.sampleId)).toEqual(corpusB.samples.map(s => s.sampleId));
      expect(corpusA.samples.map(s => s.url)).toEqual(corpusB.samples.map(s => s.url));
      expect(corpusA.holdoutFamilies).toEqual(corpusB.holdoutFamilies);
      expect(corpusA.tuningFamilies).toEqual(corpusB.tuningFamilies);

      // 2. Every sample carries labelVersion and isReviewed
      for (const sample of corpusA.samples) {
        expect(sample.labelVersion).toBe(labelVersion);
        expect(sample.isReviewed).toBe(true);
        expect(sample.groundTruthSource).toBe('independent');
      }

      // 3. Holdout families are named and untouched by tuning (strictly disjoint)
      expect(corpusA.holdoutFamilies.length).toBeGreaterThan(0);
      expect(corpusA.tuningFamilies.length).toBeGreaterThan(0);
      expect(corpusA.metadata?.holdoutUntouched).toBe(true);

      const holdoutSet = new Set(corpusA.holdoutFamilies);
      for (const tf of corpusA.tuningFamilies) {
        expect(holdoutSet.has(tf)).toBe(false);
      }

      // 4. Samples in holdout families have isHoldout: true and correct holdoutFamilyName
      for (const sample of corpusA.samples) {
        const expectedHoldout = holdoutSet.has(sample.productFamily || '');
        expect(sample.isHoldout).toBe(expectedHoldout);
        if (expectedHoldout) {
          expect(sample.holdoutFamilyName).toBe(sample.productFamily);
        }
      }
    });

    it('never marks auto-derived rows reviewed, even under an explicit reviewed assertion (finding 3)', async () => {
      const tempDir = join(tmpdir(), `corpus-finding3-${randomUUID()}`);
      const domainDir = join(tempDir, domain);
      mkdirSync(domainDir, { recursive: true });
      const snap = join(domainDir, 'snap-probe');
      mkdirSync(snap);
      const probeUrl = `https://${domain}/products/finding3-probe`;
      writeFileSync(
        join(snap, 'page.html'),
        `<!DOCTYPE html><html><head><link rel="canonical" href="${probeUrl}">` +
          `<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product",` +
          `"name":"Finding3 Probe Collar","brand":{"@type":"Brand","name":"Earthbath"},` +
          `"image":"https://${domain}/images/probe.jpg"}</script></head>` +
          `<body><h1>Finding3 Probe Collar</h1></body></html>`,
      );
      try {
        const corpus = await buildVersionedCorpus({
          domain,
          labelVersion,
          artifactRoot: tempDir,
          suiteUrls: [probeUrl],
          includeRepresentativeFixtures: false,
          holdoutFamilies: [],
          // Explicit reviewed assertion must NOT elevate auto-derived rows.
          isReviewed: true,
        });
        const probe = corpus.samples.find(s => s.url === probeUrl);
        expect(probe).toBeDefined();
        expect(probe!.groundTruthSource).toBe('auto-derived');
        expect(probe!.isReviewed).toBe(false);
        expect(corpus.isReviewed).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('covers variant siblings, near-identical products, image-heavy galleries, missing fields, and multiple templates', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });

      // 1. Variant siblings: multiple items sharing the same product family but different variants
      const familyCounts: Record<string, number> = {};
      for (const s of corpus.samples) {
        if (s.productFamily) {
          familyCounts[s.productFamily] = (familyCounts[s.productFamily] || 0) + 1;
        }
      }
      const hasVariantSiblings = Object.values(familyCounts).some(c => c >= 2);
      expect(hasVariantSiblings).toBe(true);

      // 2. Near-identical products: Shampoo vs Conditioner in same line
      const hasShampoo = corpus.samples.some(s => s.url.includes('shampoo'));
      const hasConditioner = corpus.samples.some(s => s.url.includes('conditioner'));
      expect(hasShampoo).toBe(true);
      expect(hasConditioner).toBe(true);

      // 3. Image-heavy galleries: sample with >= 3 admissible images
      const gallerySample = corpus.samples.find(s => (s.groundTruth.images.admissibleImages?.length ?? 0) >= 3);
      expect(gallerySample).toBeDefined();
      expect(gallerySample?.groundTruth.images.primaryImage).toBeDefined();

      // 4. Missing fields & inapplicable fields: sample with available: false
      const missingFieldSample = corpus.samples.find(s =>
        Object.values(s.groundTruth.fields).some(f => !f.available || f.inapplicable),
      );
      expect(missingFieldSample).toBeDefined();

      // 5. Multiple page templates
      const scopes = new Set(corpus.samples.map(s => s.pageStructureScope));
      expect(scopes.has('standard_pdp')).toBe(true);
      expect(scopes.has('variant_matrix_pdp') || scopes.has('long_tail_pdp')).toBe(true);
    });

    it('strictly excludes distributor-record items and includes Profile-Blocked Items with fail-closed scoring', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });

      // 1. Distributor-record items must be strictly excluded
      expect(corpus.metadata?.totalExcludedDistributorRecords).toBeGreaterThan(0);
      for (const s of corpus.samples) {
        expect(s.url).not.toContain('distributor');
        expect(s.sampleId).not.toContain('distributor');
      }

      // 2. Profile-Blocked items must be included to score fail-closed behavior
      const blockedSample = corpus.samples.find(s => s.isProfileBlocked);
      expect(blockedSample).toBeDefined();
      expect(blockedSample?.sampleType).toBe('profile_blocked');
      expect(blockedSample?.pageStructureScope).toBe('profile_blocked_pdp');
      expect(corpus.metadata?.totalBlocked).toBeGreaterThan(0);

      // 3. Scored for fail-closed behavior: when extraction fails on blocked items,
      // scorer scores it as missing available fields and unidentified rather than crashing or skipping
      const emptyOutcome: ExtractionOutcome = {
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
        isEvidenceGap: false,
      };

      const scoredBlocked = scoreExtraction(emptyOutcome, blockedSample!);
      expect(scoredBlocked.identityVerdict).toBe('unidentified');
      expect(scoredBlocked.fieldCorrectnessScore).toBe(0);
      expect(scoredBlocked.failureCodes).toContain('MISSING_AVAILABLE_FIELD');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 2: Confirmed Profile Samples Distinguished from Candidates,
  // and Every Sample Carries Capture Freshness
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 2: Confirmed profile samples distinguished from candidates with freshness', () => {
    it('distinguishes Confirmed Profile Samples from unreviewed candidates and blocked items', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });

      const confirmedSamples = corpus.samples.filter(
        s => s.sampleType === 'confirmed_profile_sample' || s.inventoryStatus === 'confirmed',
      );
      const candidateSamples = corpus.samples.filter(
        s => s.sampleType === 'unreviewed_candidate' || (s.inventoryStatus === 'candidate' && !s.isProfileBlocked),
      );
      const blockedSamples = corpus.samples.filter(s => s.isProfileBlocked);

      expect(confirmedSamples.length).toBeGreaterThan(0);
      expect(candidateSamples.length).toBeGreaterThan(0);
      expect(blockedSamples.length).toBeGreaterThan(0);

      expect(corpus.metadata?.totalConfirmed).toBe(confirmedSamples.length);
      expect(corpus.metadata?.totalCandidates).toBe(candidateSamples.length);
      expect(corpus.metadata?.totalBlocked).toBe(blockedSamples.length);
    });

    it('guarantees every sample carries valid capture freshness', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });

      for (const sample of corpus.samples) {
        expect(sample.captureFreshness).not.toBeNull();
        expect(typeof sample.captureFreshness).toBe('string');
        const parsed = Date.parse(sample.captureFreshness!);
        expect(isNaN(parsed)).toBe(false);
      }
    });

    it('distinguishes Confirmed Profile Samples from candidates and renders freshness in all review surfaces', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });
      const sample1 = corpus.samples.find(s => s.sampleType === 'confirmed_profile_sample')!;
      const sample2 = corpus.samples.find(s => s.sampleType === 'unreviewed_candidate')!;
      expect(sample2.sampleType).toBe('unreviewed_candidate');

      // 1. Reviewable Manifest Table distinguishes them and renders freshness
      const manifestMd = formatReviewableManifest(corpus);
      expect(manifestMd).toContain('★ Confirmed');
      expect(manifestMd).toContain('Candidate');
      expect(manifestMd).toContain(sample1.captureFreshness!);

      // 2. Promotion Report renders Confirmed Profile Sample vs Unreviewed Candidate with freshness
      const rows = corpus.samples.flatMap(s => [
        createScoredRow(s, 'current_extraction'),
        createScoredRow(s, 'hybrid_identity_first'),
      ]);
      const report = generatePromotionReport({ manifest: corpus, rows });

      expect(report.markdown).toContain('Confirmed Profile Sample');
      expect(report.markdown).toContain('Unreviewed Candidate');
      expect(report.markdown).toContain(sample1.captureFreshness!);
      expect(report.markdown).toContain(labelVersion);

      // 3. Side-by-Side Field Evidence renders sample type and capture freshness
      const sampleRows = rows.filter(r => r.sampleId === sample1.sampleId);
      const evidence = buildSideBySideFieldEvidence(sample1, sampleRows);
      const fieldTableMd = formatSideBySideFieldEvidenceTable(evidence);

      expect(fieldTableMd).toContain('Sample Type');
      expect(fieldTableMd).toContain('Confirmed Profile Sample');
      expect(fieldTableMd).toContain('Capture Freshness');
      expect(fieldTableMd).toContain(sample1.captureFreshness!);
      expect(fieldTableMd).toContain('Label Version');
      expect(fieldTableMd).toContain(labelVersion);

      // 4. Image Contact Sheet renders sample type and capture freshness
      const contactSheet = buildImageContactSheet(sample1, sampleRows[0], 'hybrid_identity_first');
      const contactSheetMd = formatImageContactSheetMarkdown(contactSheet);

      expect(contactSheetMd).toContain('Sample Type');
      expect(contactSheetMd).toContain('Confirmed Profile Sample');
      expect(contactSheetMd).toContain('Capture Freshness');
      expect(contactSheetMd).toContain(sample1.captureFreshness!);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 3: Holdout-Scoped Verdicts Reported Separately,
  // Label Version on Every Verdict, and Modeled Operator Minutes Explicitly Labeled
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 3: Holdout-scoped verdicts reported separately, label version carried, modeled values labeled', () => {
    it('evaluates and reports holdout-scoped verdicts separately from tuning-scoped verdicts', async () => {
      const corpus = await buildVersionedCorpus({
        domain,
        labelVersion,
        splitSeed: 42,
        holdoutPercent: 30,
      });

      const rows = corpus.samples.flatMap(s => [
        createScoredRow(s, 'current_extraction'),
        createScoredRow(s, 'hybrid_identity_first'),
      ]);

      const gateResult = evaluateGateArithmetic(corpus.samples, rows, {
        minSamplesForPromote: 1,
      });

      // 1. Separate holdout and tuning verdict sets
      expect(gateResult.tuningVerdictsByScope).toBeDefined();
      expect(gateResult.holdoutVerdictsByScope).toBeDefined();
      expect(Object.keys(gateResult.tuningVerdictsByScope).length).toBeGreaterThan(0);
      expect(Object.keys(gateResult.holdoutVerdictsByScope).length).toBeGreaterThan(0);

      // 2. Partition tags on verdicts
      for (const tv of Object.values(gateResult.tuningVerdictsByScope)) {
        expect(tv.partition).toBe('tuning');
        expect(tv.labelVersion).toBe(labelVersion);
      }
      for (const hv of Object.values(gateResult.holdoutVerdictsByScope)) {
        expect(hv.partition).toBe('holdout');
        expect(hv.labelVersion).toBe(labelVersion);
      }

      // 3. Promotion report renders holdout-scoped verdicts separately
      const report = generatePromotionReport({ manifest: corpus, rows, gateOptions: { minSamplesForPromote: 1 } });

      expect(report.tuningVerdictsByScope).toBeDefined();
      expect(report.holdoutVerdictsByScope).toBeDefined();
      expect(report.labelVersion).toBe(labelVersion);

      expect(report.markdown).toContain('Holdout-Scoped Promotion Verdicts');
      expect(report.markdown).toContain('Holdout Partition Verdicts');
      expect(report.markdown).toContain('Label Version');
    });

    it('guarantees every scope verdict carries its label version', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });
      const rows = corpus.samples.flatMap(s => [
        createScoredRow(s, 'current_extraction'),
        createScoredRow(s, 'hybrid_identity_first'),
      ]);

      const gateResult = evaluateGateArithmetic(corpus.samples, rows);

      expect(gateResult.labelVersion).toBe(labelVersion);
      for (const [_scope, verdict] of Object.entries(gateResult.verdictsByScope)) {
        expect(verdict.labelVersion).toBe(labelVersion);
      }

      const singleScopeVerdict = evaluateScopeGate('standard_pdp', corpus.samples, rows, { labelVersion });
      expect(singleScopeVerdict.labelVersion).toBe(labelVersion);
    });

    it('explicitly labels modeled operator minutes as (modeled) when computed by formula', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });
      const rows = corpus.samples.flatMap(s => [
        createScoredRow(s, 'current_extraction'),
        createScoredRow(s, 'hybrid_identity_first'),
      ]);

      const gateResult = evaluateGateArithmetic(corpus.samples, rows, { minSamplesForPromote: 1 });
      const scopeTableMd = formatScopePromotionTable(gateResult.verdictsByScope);
      const costTableMd = formatCostAnalysisTable(gateResult.domainCostMetrics, gateResult.verdictsByScope);
      const report = generatePromotionReport({ manifest: corpus, rows, gateOptions: { minSamplesForPromote: 1 } });

      // Both scope table and cost table explicitly label (modeled)
      expect(scopeTableMd).toContain('(modeled)');
      expect(costTableMd).toContain('(modeled)');
      expect(report.markdown).toContain('(modeled)');
    });

    it('allows measured operator minutes to override modeled estimates and explicitly labels them as (measured)', async () => {
      const corpus = await buildVersionedCorpus({ domain, labelVersion });
      const rows = corpus.samples.flatMap(s => [
        createScoredRow(s, 'current_extraction'),
        createScoredRow(s, 'hybrid_identity_first'),
      ]);

      const measuredOverride = {
        [domain]: {
          current_extraction: 25.5,
          current_strict_images: 20.0,
          structured_only: 12.0,
          hybrid_identity_first: 7.5,
        },
      };

      const gateResult = evaluateGateArithmetic(corpus.samples, rows, {
        minSamplesForPromote: 1,
        operatorMinutesOverride: measuredOverride,
      });

      const scopeTableMd = formatScopePromotionTable(gateResult.verdictsByScope);
      const costTableMd = formatCostAnalysisTable(gateResult.domainCostMetrics, gateResult.verdictsByScope);
      const report = generatePromotionReport({
        manifest: corpus,
        rows,
        gateOptions: {
          minSamplesForPromote: 1,
          operatorMinutesOverride: measuredOverride,
        },
      });

      // Measured values are applied
      const firstVerdict = Object.values(gateResult.verdictsByScope)[0];
      expect(firstVerdict.costMetrics.baselineOperatorMinutes).toBe(25.5);
      expect(firstVerdict.costMetrics.hybridOperatorMinutes).toBe(7.5);
      expect(firstVerdict.costMetrics.operatorMinutesSaved).toBe(18);

      // Tables explicitly label (measured)
      expect(scopeTableMd).toContain('25.5m (measured)');
      expect(scopeTableMd).toContain('7.5m (measured)');
      expect(costTableMd).toContain('25.5m (measured)');
      expect(costTableMd).toContain('7.5m (measured)');
      expect(report.markdown).toContain('(measured)');
    });
  });
});
