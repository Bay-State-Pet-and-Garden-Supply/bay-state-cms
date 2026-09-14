import { describe, it, expect } from 'bun:test';
import { buildCohortView } from '../../onboarding/curation-cohort-service';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CurationCohort, CurationCohortMember } from '../../shared/schemas/cohorts';

describe('Curation Cohort Service Performance Benchmark', () => {
  it('benchmarks evaluateCohortReadiness and buildCohortView over batch cohorts', () => {
    const itemCount = 500;
    const cohortCount = 250;
    const iterations = 100;

    const items: OnboardingItem[] = Array.from({ length: itemCount }, (_, i) => ({
      id: 'item-' + i,
      batchId: 'batch-perf',
      upc: '0000000000' + i,
      name: 'Test Item ' + i,
      price: '10.00',
      quantity: 1,
      brandHint: 'Brand ' + (i % 50),
      departmentHint: null,
      sourceUrl: 'https://example.com/p/' + i,
      expectedName: null,
      coordinatedTitle: null,
      sourceType: 'official_page',
      sourcingEntryPolicyVersion: 1,
      acceptedEvidenceAttemptIds: [],
      acceptedEvidenceAttemptId: null,
      sourcingDecision: null,
      stage: 'collect_details',
      stageStatus: 'completed',
      isHeld: false,
      heldReason: null,
      status: 'imported',
      errorMessage: null,
      retryCount: 0,
      isDuplicate: false,
      existingSku: null,
      extractionData: { title: 'Test ' + i } as any,
      curationData: null,
      rowNumber: i,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const cohorts: CurationCohort[] = Array.from({ length: cohortCount }, (_, i) => ({
      id: 'cohort-' + i,
      workspaceId: 'ws-perf',
      batchId: 'batch-perf',
      groupKey: 'brand-' + (i % 50) + '::stem-' + i,
      groupLabel: 'Group ' + i,
      groupingVersion: 'v1',
      membershipHash: 'hash-' + i,
      status: 'ready',
      blockedReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      supersededAt: null,
    }));

    const membersByCohortId = new Map<string, CurationCohortMember[]>();
    cohorts.forEach((c, i) => {
      const m1: CurationCohortMember = {
        cohortId: c.id,
        onboardingItemId: 'item-' + (i * 2),
        productSku: '0000000000' + (i * 2),
        normalizedBrand: 'brand',
        normalizedNameStem: 'stem',
        membershipReasonJson: null,
        extractionHash: 'hash',
        ordinal: 0,
        createdAt: new Date().toISOString(),
      };
      const m2: CurationCohortMember = {
        cohortId: c.id,
        onboardingItemId: 'item-' + (i * 2 + 1),
        productSku: '0000000000' + (i * 2 + 1),
        normalizedBrand: 'brand',
        normalizedNameStem: 'stem',
        membershipReasonJson: null,
        extractionHash: 'hash',
        ordinal: 1,
        createdAt: new Date().toISOString(),
      };
      membersByCohortId.set(c.id, [m1, m2]);
    });

    const itemsById = new Map(items.map((item) => [item.id, item]));

    // Baseline: unoptimized path (omitting 6th param)
    const startBaseline = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      const views = cohorts.map(cohort =>
        buildCohortView(cohort, items, membersByCohortId, new Map(), new Map())
      );
      expect(views.length).toBe(cohortCount);
    }
    const baselineMs = performance.now() - startBaseline;

    // Optimized: passing pre-computed itemsById map as 6th param
    const startOptimized = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      const views = cohorts.map(cohort =>
        buildCohortView(cohort, items, membersByCohortId, new Map(), new Map(), itemsById)
      );
      expect(views.length).toBe(cohortCount);
    }
    const optimizedMs = performance.now() - startOptimized;

    console.log(`[BENCHMARK] Baseline (unoptimized map construction per cohort): ${baselineMs.toFixed(2)} ms`);
    console.log(`[BENCHMARK] Optimized (pre-computed itemsById map): ${optimizedMs.toFixed(2)} ms`);
    console.log(`[BENCHMARK] Speedup: ${(baselineMs / optimizedMs).toFixed(2)}x`);

    expect(optimizedMs).toBeLessThan(baselineMs);
  });
});
