import { describe, it, expect } from 'bun:test';
import { buildCohortView, evaluateCohortReadiness } from '../../onboarding/curation-cohort-service';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CurationCohort, CurationCohortMember } from '../../shared/schemas/cohorts';

describe('Curation Cohort Service Performance & Equivalence', () => {
  it('verifies deterministic semantic equivalence between supplied itemsById map and default fallback', () => {
    const items: OnboardingItem[] = [
      {
        id: 'item-1',
        batchId: 'batch-1',
        upc: '0000000001',
        name: 'Item 1',
        price: '10.00',
        quantity: 1,
        brandHint: 'Brand A',
        departmentHint: null,
        sourceUrl: 'https://example.com/p/1',
        expectedName: null,
        coordinatedTitle: null,
        sourceType: 'official_page',
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
        extractionData: { title: 'Item 1' } as any,
        curationData: null,
        rowNumber: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'item-2',
        batchId: 'batch-1',
        upc: '0000000002',
        name: 'Item 2',
        price: '12.00',
        quantity: 1,
        brandHint: 'Brand A',
        departmentHint: null,
        sourceUrl: 'https://example.com/p/2',
        expectedName: null,
        coordinatedTitle: null,
        sourceType: 'official_page',
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
        extractionData: { title: 'Item 2' } as any,
        curationData: null,
        rowNumber: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const cohort: CurationCohort = {
      id: 'cohort-1',
      workspaceId: 'ws-1',
      batchId: 'batch-1',
      groupKey: 'brand-a::stem-1',
      groupLabel: 'Group 1',
      groupingVersion: 'v1',
      membershipHash: 'hash-1',
      status: 'ready',
      blockedReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      supersededAt: null,
    };

    const members: CurationCohortMember[] = [
      {
        cohortId: 'cohort-1',
        onboardingItemId: 'item-1',
        productSku: '0000000001',
        normalizedBrand: 'brand a',
        normalizedNameStem: 'stem 1',
        membershipReasonJson: null,
        extractionHash: 'hash1',
        ordinal: 0,
        createdAt: new Date().toISOString(),
      },
      {
        cohortId: 'cohort-1',
        onboardingItemId: 'item-2',
        productSku: '0000000002',
        normalizedBrand: 'brand a',
        normalizedNameStem: 'stem 1',
        membershipReasonJson: null,
        extractionHash: 'hash2',
        ordinal: 1,
        createdAt: new Date().toISOString(),
      },
    ];

    const membersByCohortId = new Map([['cohort-1', members]]);
    const itemsById = new Map(items.map((item) => [item.id, item]));

    // Evaluate readiness with and without explicit itemsById map
    const evalFallback = evaluateCohortReadiness(cohort, members, items, new Map());
    const evalExplicit = evaluateCohortReadiness(cohort, members, items, new Map(), itemsById);
    expect(evalExplicit).toEqual(evalFallback);

    // Build view with and without explicit itemsById map
    const viewFallback = buildCohortView(cohort, items, membersByCohortId, new Map(), new Map());
    const viewExplicit = buildCohortView(cohort, items, membersByCohortId, new Map(), new Map(), itemsById);
    expect(viewExplicit).toEqual(viewFallback);
  });

  it('benchmarks evaluateCohortReadiness and buildCohortView over batch cohorts (non-gating timing)', () => {
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
    console.log(`[BENCHMARK] Measured Speedup: ${(baselineMs / Math.max(1, optimizedMs)).toFixed(2)}x`);

    // Non-gating timing assertion (logging only, no wall-clock threshold in test assertions)
    expect(optimizedMs).toBeGreaterThanOrEqual(0);
    expect(baselineMs).toBeGreaterThanOrEqual(0);
  });
});
