import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CurationCohort, CurationCohortMember } from '../../shared/schemas/cohorts';
import {
  buildCohortView,
  evaluateCohortReadiness,
} from '../../onboarding/curation-cohort-service';

function createMockItem(id: string, batchId: string, sku: string): OnboardingItem {
  return {
    id,
    batchId,
    upc: sku,
    name: `Test Product ${sku}`,
    brandHint: 'TestBrand',
    sourceType: 'official_page',
    sourceUrl: `https://brand.example/products/${sku}`,
    stage: 'prepare_listing',
    stageStatus: 'pending',
    isHeld: false,
    heldReason: null,
    errorMessage: null,
    curationData: {
      curatedTitle: `Test Product ${sku}`,
    },
    extractionData: {
      title: `Test Product ${sku}`,
      primaryImage: `https://brand.example/images/${sku}.jpg`,
      ocrOutcome: { status: 'succeeded' },
      packagingOcrData: { brand: 'TestBrand' },
    },
    sourcingDecision: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as OnboardingItem;
}

describe('Cohort projection benchmark & correctness', () => {
  it('benchmarks cohort batch projection performance for 1,000 items across 100 cohorts', () => {
    const batchId = 'batch_bench_1000';
    const cohortCount = 100;
    const itemsPerCohort = 10;
    const totalItems = cohortCount * itemsPerCohort;

    const items: OnboardingItem[] = [];
    const cohorts: CurationCohort[] = [];
    const membersByCohortId = new Map<string, CurationCohortMember[]>();
    const dummyExtractionSources = new Map();
    const dummyCurrentRuns = new Map();

    for (let c = 0; c < cohortCount; c++) {
      const cohortId = `cohort_${c}`;
      cohorts.push({
        id: cohortId,
        workspaceId: 'ws_bench',
        batchId,
        groupKey: `brand:testbrand:group_${c}`,
        groupLabel: `Test Group ${c}`,
        groupingVersion: 'v1',
        membershipHash: 'hash123',
        status: 'waiting',
        blockedReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        supersededAt: null,
      });

      const members: CurationCohortMember[] = [];
      for (let m = 0; m < itemsPerCohort; m++) {
        const index = c * itemsPerCohort + m;
        const itemId = `item_${index}`;
        const sku = `1000000000${index}`.slice(-12);
        const item = createMockItem(itemId, batchId, sku);
        items.push(item);

        members.push({
          cohortId,
          onboardingItemId: itemId,
          productSku: sku,
          normalizedBrand: 'testbrand',
          normalizedNameStem: `group_${c}`,
          membershipReasonJson: null,
          extractionHash: 'hash1234567890123456789012345678901234567890123456789012345678901234',
          ordinal: m,
          createdAt: new Date().toISOString(),
        });
      }
      membersByCohortId.set(cohortId, members);
    }

    expect(items.length).toBe(totalItems);
    expect(cohorts.length).toBe(cohortCount);

    // Warmup
    for (let i = 0; i < 3; i++) {
      for (const cohort of cohorts) {
        evaluateCohortReadiness(cohort, membersByCohortId.get(cohort.id)!, items, dummyExtractionSources);
        buildCohortView(cohort, items, membersByCohortId, dummyExtractionSources, dummyCurrentRuns);
      }
    }

    // Benchmark buildCohortView across all cohorts
    const iterations = 10;
    const startTime = performance.now();
    for (let iter = 0; iter < iterations; iter++) {
      for (const cohort of cohorts) {
        buildCohortView(cohort, items, membersByCohortId, dummyExtractionSources, dummyCurrentRuns);
      }
    }
    const endTime = performance.now();
    const durationMs = (endTime - startTime) / iterations;

    console.log(`[Benchmark Baseline] Average time per batch cohort projection (1000 items, 100 cohorts): ${durationMs.toFixed(2)} ms`);
    expect(durationMs).toBeGreaterThan(0);
  });
});
