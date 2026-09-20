import { performance } from 'node:perf_hooks';
import { matchSitemapUrls } from '../onboarding/sitemap-matcher';
import { buildCohortView } from '../onboarding/curation-cohort-service';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import type { CurationCohort, CurationCohortMember } from '../shared/schemas/cohorts';

function generateMockItemsAndCohorts(itemCount: number, cohortCount: number): {
  items: OnboardingItem[];
  cohorts: CurationCohort[];
  membersByCohortId: Map<string, CurationCohortMember[]>;
  extractionSourcesByItemId: Map<string, any>;
  currentRunsByCohortId: Map<string, any>;
} {
  const items: OnboardingItem[] = [];
  const extractionSourcesByItemId = new Map<string, any>();
  const currentRunsByCohortId = new Map<string, any>();

  for (let i = 0; i < itemCount; i++) {
    const itemId = `item_${i}`;
    const upc = `012345678${(i % 1000).toString().padStart(3, '0')}`;
    items.push({
      id: itemId,
      batchId: 'batch_bench',
      upc,
      name: `Benchmark Product ${i}`,
      brandHint: 'BenchmarkBrand',
      sourceType: 'official_page',
      sourceUrl: `https://example.com/p/${upc}`,
      stage: 'prepare_listing',
      stageStatus: 'in_progress',
      isHeld: false,
      heldReason: null,
      errorMessage: null,
      extractionData: {
        title: `Extracted Product ${i}`,
        brand: 'BenchmarkBrand',
        description: 'Description',
        bulletPoints: [],
        primaryImage: 'https://example.com/img.jpg',
        additionalImages: [],
        price: '19.99',
      } as any,
      curationData: null,
      sourcingDecision: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    extractionSourcesByItemId.set(itemId, {
      sourceUrl: `https://example.com/p/${upc}`,
      sourceType: 'official_page',
      extractionMethod: 'custom_v1',
      sourcingGenerationId: null,
      acceptedEvidenceAttemptIds: [],
      evidenceHash: null,
    });
  }

  const cohorts: CurationCohort[] = [];
  const membersByCohortId = new Map<string, CurationCohortMember[]>();

  const itemsPerCohort = Math.ceil(itemCount / cohortCount);
  for (let c = 0; c < cohortCount; c++) {
    const cohortId = `cohort_${c}`;
    const cohort: CurationCohort = {
      id: cohortId,
      workspaceId: 'ws_bench',
      batchId: 'batch_bench',
      groupKey: `key_${c}`,
      groupLabel: `Group ${c}`,
      groupingVersion: 'v1',
      membershipHash: 'hash',
      status: 'waiting',
      blockedReason: null,
      supersededAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    cohorts.push(cohort);

    const members: CurationCohortMember[] = [];
    for (let m = 0; m < itemsPerCohort; m++) {
      const idx = c * itemsPerCohort + m;
      if (idx >= itemCount) break;
      members.push({
        cohortId,
        onboardingItemId: `item_${idx}`,
        productSku: `SKU_${idx}`,
        normalizedBrand: 'benchmarkbrand',
        normalizedNameStem: 'benchmark product stem',
        membershipReasonJson: null,
        extractionHash: 'hash123',
        ordinal: m + 1,
        createdAt: new Date().toISOString(),
      });
    }
    membersByCohortId.set(cohortId, members);
  }

  return { items, cohorts, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId };
}

function generateMockSitemapUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    urls.push(`https://example.com/products/brand-product-category-slug-item-${i}`);
  }
  return urls;
}

export async function runBenchmark() {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  // Benchmark 1: Cohort View & Readiness Evaluation across 100 cohorts / 500 items
  const { items, cohorts, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId } = generateMockItemsAndCohorts(500, 100);
  const cohortRuns = 20;

  const startCohort = performance.now();
  for (let r = 0; r < cohortRuns; r++) {
    const itemsById = new Map(items.map(item => [item.id, item]));
    for (const cohort of cohorts) {
      buildCohortView(cohort, items, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId, itemsById);
    }
  }
  const durationCohort = performance.now() - startCohort;

  // Benchmark 2: Sitemap Matcher Pass 1 (UPC exact hit / digit matching) across 20,000 URLs
  const sitemapUrls = generateMockSitemapUrls(20000);
  const upc = '810001234567';

  const startSitemap = performance.now();
  const sitemapRuns = 100;
  for (let i = 0; i < sitemapRuns; i++) {
    await matchSitemapUrls(sitemapUrls, 'Benchmark Item Name', 'Benchmark Item Name', upc, 'example.com');
  }
  const durationSitemap = performance.now() - startSitemap;

  console.log = origLog;
  console.warn = origWarn;

  console.log('--- Benchmarking Baseline Results ---');
  console.log(`Cohort View Evaluation (${cohortRuns} runs of 100 cohorts x 500 items): ${durationCohort.toFixed(2)} ms (avg ${(durationCohort / cohortRuns).toFixed(2)} ms/run)`);
  console.log(`Sitemap Matcher (${sitemapRuns} runs over 20,000 URLs): ${durationSitemap.toFixed(2)} ms (avg ${(durationSitemap / sitemapRuns).toFixed(2)} ms/run)`);
  console.log('--- Benchmark Complete ---');
}

if (import.meta.main) {
  await runBenchmark();
}
