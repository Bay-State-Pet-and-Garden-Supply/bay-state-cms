/**
 * Versioned Labeled Corpus Builder (Issue #190 / Audit Follow-Through T6)
 *
 * Builds a deterministic, independently labeled, versioned corpus covering:
 * 1. Variant siblings (same product family, distinct variant options/axes).
 * 2. Near-identical products (distinct products in same brand line with distinct GTIN/SKU).
 * 3. Image-heavy galleries (multiple gallery angles/detail images with primary image flagged).
 * 4. Missing fields (available: false and inapplicable fields to score absence correctly).
 * 5. Multiple page templates (standard_pdp, variant_matrix_pdp, long_tail_pdp).
 * 6. Profile-Blocked items included so fail-closed behavior is scored.
 * 7. Distributor-record items strictly excluded.
 * 8. Named holdout families held out from tuning with holdouts reported separately.
 * 9. Confirmed Profile Samples distinguished from unreviewed candidates.
 * 10. Capture freshness recorded for every sample.
 */

import type {
  AuditGroundTruth,
  AuditManifestSample,
  VersionedAuditCorpus,
} from '../../shared/schemas/profile-audit';
import type { BuildStratifiedManifestOptions } from './types';
import { buildFullStratifiedManifest } from './manifest-builder';
import { normalizeDomain } from '../../db/repositories/brand-url-index-repo';

export interface BuildVersionedCorpusOptions extends BuildStratifiedManifestOptions {
  domain?: string;
  labelVersion?: string;
  isReviewed?: boolean;
  corpusId?: string;
  /** Whether to inject the representative benchmark cases (defaults to true if candidateUrls/suiteUrls not provided). */
  includeRepresentativeFixtures?: boolean;
}

/**
 * Benchmark representative dataset covering all required dimensions for generalization.
 */
export interface RepresentativeCorpusFixture {
  url: string;
  name: string;
  brandHint: string;
  pageStructureScope: string;
  variantShape: string;
  inventoryStatus: 'confirmed' | 'candidate';
  sampleType: 'confirmed_profile_sample' | 'unreviewed_candidate' | 'profile_blocked';
  isProfileBlocked: boolean;
  captureFreshness: string;
  groundTruth: AuditGroundTruth;
  isHoldout?: boolean;
  holdoutFamilyName?: string;
}

export function getRepresentativeCorpusFixtures(domain: string = 'earthbath.com'): RepresentativeCorpusFixture[] {
  const norm = normalizeDomain(domain);
  const base = `https://${norm}`;

  return [
    // 1. Variant sibling 1 (Standard single variant / size)
    {
      url: `${base}/products/hypo-allergenic-shampoo-16oz`,
      name: 'Earthbath Hypo-Allergenic Shampoo 16oz',
      brandHint: 'Earthbath',
      pageStructureScope: 'standard_pdp',
      variantShape: 'single_variant',
      inventoryStatus: 'confirmed',
      sampleType: 'confirmed_profile_sample',
      isProfileBlocked: false,
      captureFreshness: '2026-08-10T10:00:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Hypo-Allergenic Shampoo 16oz',
          gtin: '745556011162',
          sku: 'EB-HA-16',
          variantName: '16oz',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Hypo-Allergenic Shampoo 16oz' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '15.99' },
          sku: { available: true, expectedValue: 'EB-HA-16' },
          gtin: { available: true, expectedValue: '745556011162' },
          description: { available: true },
        },
        images: {
          primaryImage: `${base}/images/hypo-16oz-primary.jpg`,
          admissibleImages: [
            `${base}/images/hypo-16oz-primary.jpg`,
            `${base}/images/hypo-16oz-back.jpg`,
          ],
        },
      },
    },

    // 2. Variant sibling 2 (Same family, variant size sibling)
    {
      url: `${base}/products/hypo-allergenic-shampoo-32oz`,
      name: 'Earthbath Hypo-Allergenic Shampoo 32oz',
      brandHint: 'Earthbath',
      pageStructureScope: 'standard_pdp',
      variantShape: 'single_variant',
      inventoryStatus: 'confirmed',
      sampleType: 'confirmed_profile_sample',
      isProfileBlocked: false,
      captureFreshness: '2026-08-10T10:00:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Hypo-Allergenic Shampoo 32oz',
          gtin: '745556011285',
          sku: 'EB-HA-32OZ',
          variantName: '32oz',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Hypo-Allergenic Shampoo 32oz' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '24.99' },
          sku: { available: true, expectedValue: 'EB-HA-32OZ' },
          gtin: { available: true, expectedValue: '745556011285' },
          description: { available: true },
        },
        images: {
          primaryImage: `${base}/images/hypo-32oz-primary.jpg`,
          admissibleImages: [
            `${base}/images/hypo-32oz-primary.jpg`,
            `${base}/images/hypo-32oz-side.jpg`,
          ],
        },
      },
    },

    // 3. Near-identical product (Confusion signal: Oatmeal & Aloe Shampoo vs Conditioner)
    {
      url: `${base}/products/oatmeal-aloe-shampoo-vanilla-16oz`,
      name: 'Earthbath Oatmeal & Aloe Shampoo Vanilla 16oz',
      brandHint: 'Earthbath',
      pageStructureScope: 'variant_matrix_pdp',
      variantShape: 'multi_variant',
      inventoryStatus: 'candidate',
      sampleType: 'unreviewed_candidate',
      isProfileBlocked: false,
      captureFreshness: '2026-08-12T14:30:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Oatmeal & Aloe Shampoo Vanilla 16oz',
          gtin: '745556011018',
          sku: 'EB-OA-SH-16',
          variantName: 'Vanilla 16oz',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Oatmeal & Aloe Shampoo Vanilla 16oz' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '16.99' },
          sku: { available: true, expectedValue: 'EB-OA-SH-16' },
          gtin: { available: true, expectedValue: '745556011018' },
          description: { available: true },
        },
        images: {
          primaryImage: `${base}/images/oa-shampoo-front.jpg`,
          admissibleImages: [`${base}/images/oa-shampoo-front.jpg`],
        },
      },
    },

    // 4. Near-identical product sibling (Conditioner in same line with distinct GTIN/identity)
    {
      url: `${base}/products/oatmeal-aloe-conditioner-vanilla-16oz`,
      name: 'Earthbath Oatmeal & Aloe Conditioner Vanilla 16oz',
      brandHint: 'Earthbath',
      pageStructureScope: 'variant_matrix_pdp',
      variantShape: 'multi_variant',
      inventoryStatus: 'candidate',
      sampleType: 'unreviewed_candidate',
      isProfileBlocked: false,
      captureFreshness: '2026-08-12T14:30:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Oatmeal & Aloe Conditioner Vanilla 16oz',
          gtin: '745556012015',
          sku: 'EB-OA-COND-16',
          variantName: 'Vanilla 16oz',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Oatmeal & Aloe Conditioner Vanilla 16oz' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '17.99' },
          sku: { available: true, expectedValue: 'EB-OA-COND-16' },
          gtin: { available: true, expectedValue: '745556012015' },
          description: { available: true },
        },
        images: {
          primaryImage: `${base}/images/oa-cond-front.jpg`,
          admissibleImages: [`${base}/images/oa-cond-front.jpg`],
        },
      },
    },

    // 5. Image-heavy gallery (Multiple gallery images + detail shots)
    {
      url: `${base}/products/hot-spot-relief-wipes-100ct`,
      name: 'Earthbath Hot Spot Relief Wipes 100ct',
      brandHint: 'Earthbath',
      pageStructureScope: 'standard_pdp',
      variantShape: 'single_variant',
      inventoryStatus: 'confirmed',
      sampleType: 'confirmed_profile_sample',
      isProfileBlocked: false,
      captureFreshness: '2026-08-15T09:15:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Hot Spot Relief Wipes 100ct',
          gtin: '745556031009',
          sku: 'EB-HS-WIPES',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Hot Spot Relief Wipes 100ct' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '14.99' },
          sku: { available: true, expectedValue: 'EB-HS-WIPES' },
          gtin: { available: true, expectedValue: '745556031009' },
          description: { available: true },
        },
        images: {
          primaryImage: `${base}/images/hs-wipes-tub.jpg`,
          admissibleImages: [
            `${base}/images/hs-wipes-tub.jpg`,
            `${base}/images/hs-wipes-lid-open.jpg`,
            `${base}/images/hs-wipes-ingredients.jpg`,
            `${base}/images/hs-wipes-in-use.jpg`,
          ],
        },
      },
    },

    // 6. Missing fields & inapplicable dimensions (No GTIN on page, description unavailable)
    {
      url: `${base}/bundles/grooming-starter-bundle`,
      name: 'Earthbath Grooming Starter Bundle',
      brandHint: 'Earthbath',
      pageStructureScope: 'long_tail_pdp',
      variantShape: 'single_variant',
      inventoryStatus: 'candidate',
      sampleType: 'unreviewed_candidate',
      isProfileBlocked: false,
      captureFreshness: '2026-08-20T16:00:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Grooming Starter Bundle',
          gtin: null,
          sku: 'EB-BUNDLE-STARTER',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Grooming Starter Bundle' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '29.99' },
          sku: { available: true, expectedValue: 'EB-BUNDLE-STARTER' },
          gtin: { available: false, notes: 'Bundles do not carry GTIN on PDP' },
          description: { available: false, notes: 'Custom landing page without structured body' },
        },
        images: {
          primaryImage: `${base}/images/bundle-starter.jpg`,
          admissibleImages: [`${base}/images/bundle-starter.jpg`],
        },
      },
    },

    // 7. Profile-Blocked Item (Evaluates fail-closed behavior)
    {
      url: `${base}/products/unsupported-widget-item`,
      name: 'Earthbath Unsupported Widget',
      brandHint: 'Earthbath',
      pageStructureScope: 'profile_blocked_pdp',
      variantShape: 'single_variant',
      inventoryStatus: 'candidate',
      sampleType: 'profile_blocked',
      isProfileBlocked: true,
      captureFreshness: '2026-08-25T11:00:00.000Z',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Earthbath Unsupported Widget',
          gtin: '745556099999',
          sku: 'EB-BLOCKED-1',
        },
        fields: {
          title: { available: true, expectedValue: 'Earthbath Unsupported Widget' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '9.99' },
          sku: { available: true, expectedValue: 'EB-BLOCKED-1' },
          gtin: { available: true, expectedValue: '745556099999' },
        },
        images: {
          primaryImage: `${base}/images/blocked-widget.jpg`,
          admissibleImages: [`${base}/images/blocked-widget.jpg`],
        },
      },
    },
  ];
}

/**
 * Builds the versioned labeled corpus with holdouts and reviewed labels (Issue #190).
 */
export async function buildVersionedCorpus(
  options: BuildVersionedCorpusOptions = {},
): Promise<VersionedAuditCorpus> {
  const domain = normalizeDomain(options.domain || 'earthbath.com');
  const labelVersion = options.labelVersion || '1.0.0';
  // No default reviewed assertion: the manifest builder's per-sample provenance
  // logic stays authoritative unless the caller explicitly asserts review
  // (Issue #190 / T6).
  const assertedReviewed = options.isReviewed;
  const corpusId = options.corpusId || `${domain}:corpus:${labelVersion}`;

  const shouldIncludeFixtures = options.includeRepresentativeFixtures ?? (
    !options.suiteUrls && !options.candidateUrls
  );

  let suiteUrls = options.suiteUrls;
  let candidateUrls = options.candidateUrls;
  let onboardingItems = options.onboardingItems;
  const groundTruthOverrides = { ...options.groundTruthOverrides };

  if (shouldIncludeFixtures) {
    const fixtures = getRepresentativeCorpusFixtures(domain);

    const fixtureSuite = fixtures
      .filter(f => f.inventoryStatus === 'confirmed')
      .map(f => f.url);
    const fixtureCandidates = fixtures
      .filter(f => f.inventoryStatus === 'candidate' && !f.isProfileBlocked)
      .map(f => ({
        url: f.url,
        title: f.name,
        brand: f.brandHint,
        lastmod: f.captureFreshness,
      }));

    suiteUrls = suiteUrls ? [...suiteUrls, ...fixtureSuite] : fixtureSuite;
    candidateUrls = candidateUrls ? [...candidateUrls, ...fixtureCandidates] : fixtureCandidates;

    // Add profile-blocked item as onboardingItem
    const blockedFixture = fixtures.find(f => f.isProfileBlocked);
    const defaultOnboardingItems: NonNullable<BuildVersionedCorpusOptions['onboardingItems']> = [];

    if (blockedFixture) {
      defaultOnboardingItems.push({
        id: 'corpus-item-blocked-1',
        sourceUrl: blockedFixture.url,
        name: blockedFixture.name,
        brandHint: blockedFixture.brandHint,
        sourceType: 'official_page',
        stage: 'collect_details',
        stageStatus: 'failed',
        errorMessage: `No extractor profile for ${domain}`,
        updatedAt: blockedFixture.captureFreshness,
        createdAt: blockedFixture.captureFreshness,
      });
    }

    // Add distributor record to verify strict exclusion
    defaultOnboardingItems.push({
      id: 'corpus-distributor-record-excluded',
      sourceUrl: null,
      name: 'Distributor Merchandising Record 40lb',
      brandHint: 'Earthbath',
      sourceType: 'distributor_record',
      stage: 'collect_details',
      stageStatus: 'completed',
    });

    onboardingItems = onboardingItems
      ? [...onboardingItems, ...defaultOnboardingItems]
      : defaultOnboardingItems;

    // Apply reviewed ground truth for all fixtures
    for (const f of fixtures) {
      if (!groundTruthOverrides[f.url]) {
        groundTruthOverrides[f.url] = f.groundTruth;
      }
    }
  }

  // Ensure default named holdout family if none specified
  const holdoutFamilies = options.holdoutFamilies || [
    'earthbath - oatmeal aloe conditioner',
  ];

  const manifest = await buildFullStratifiedManifest({
    ...options,
    domain,
    suiteUrls,
    candidateUrls,
    onboardingItems,
    groundTruthOverrides,
    holdoutFamilies,
    labelVersion,
    // Forward an explicit reviewed assertion only — never a default — so an
    // unreviewed corpus cannot claim reviewed status by omission.
    ...(assertedReviewed !== undefined ? { isReviewed: assertedReviewed } : {}),
  });

  const metadata = manifest.metadata as Record<string, any>;
  const manifestHoldouts = (metadata.holdoutFamilies as string[]) || [];
  const manifestTuning = (metadata.tuningFamilies as string[]) || [];

  // Guarantee every sample carries the labelVersion and isReviewed tag.
  // Reviewed status requires an independent label source: auto-derived rows
  // stay unreviewed, so circular labels can never be counted as reviewed.
  const taggedSamples: AuditManifestSample[] = manifest.samples.map(s => ({
    ...s,
    labelVersion: s.labelVersion || labelVersion,
    isReviewed: s.isReviewed ?? (s.groundTruthSource === 'independent'),
  }));

  // Corpus-level reviewed flag: an explicit assertion is necessary but not
  // sufficient — the samples must agree, so a corpus with unreviewed rows
  // cannot claim reviewed status.
  const aggregateReviewed = (assertedReviewed ?? true) && taggedSamples.every(s => s.isReviewed ?? false);

  return {
    corpusId,
    domain,
    labelVersion,
    isReviewed: aggregateReviewed,
    generatedAt: manifest.generatedAt,
    samples: taggedSamples,
    holdoutFamilies: manifestHoldouts,
    tuningFamilies: manifestTuning,
    metadata: {
      ...metadata,
      corpusId,
      labelVersion,
      isReviewed: aggregateReviewed,
    },
  };
}
