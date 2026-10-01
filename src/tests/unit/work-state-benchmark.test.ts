import { describe, it, expect } from 'bun:test';
import { buildCohortView } from '../../onboarding/curation-cohort-service';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CurationCohort, CurationCohortMember, CohortRun } from '../../shared/schemas/cohorts';
import type { ExtractionBinding } from '../../db/repositories/onboarding-extraction-repo';

describe('Work State & Cohort Benchmark Baseline', () => {
  it('measures execution time and call counts for batch cohort context derivation', () => {
    // Construct 50 cohorts with 10 members each (500 items total)
    const items: OnboardingItem[] = [];
    const cohorts: CurationCohort[] = [];
    const membersByCohortId = new Map<string, CurationCohortMember[]>();
    const extractionSourcesByItemId = new Map<string, ExtractionBinding>();
    const currentRunsByCohortId = new Map<string, CohortRun>();

    for (let c = 0; c < 50; c++) {
      const cohortId = `cohort-${c}`;
      const cohort: CurationCohort = {
        id: cohortId,
        workspaceId: 'ws-1',
        batchId: 'batch-1',
        groupKey: `key-${c}`,
        groupLabel: `Cohort ${c}`,
        status: 'ready',
        groupingVersion: '1',
        membershipHash: 'memhash123',
        supersededAt: null,
        blockedReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      cohorts.push(cohort);

      const members: CurationCohortMember[] = [];
      for (let m = 0; m < 10; m++) {
        const itemId = `item-${c}-${m}`;
        const item: OnboardingItem = {
          id: itemId,
          batchId: 'batch-1',
          rowNumber: c * 10 + m + 1,
          upc: `10000000${c}${m}`,
          name: `Product ${c}-${m}`,
          price: null,
          quantity: null,
          brandHint: 'Acme',
          departmentHint: null,
          sourceType: 'official_page',
          sourceUrl: `https://example.com/product-${c}-${m}`,
          stage: 'prepare_listing',
          stageStatus: 'pending',
          retryCount: 0,
          errorMessage: null,
          extractionData: {
            title: `Product ${c}-${m}`,
            brand: 'Acme',
            productIntelligenceEvidence: [],
          } as any,
          curationData: null,
          sourcingDecision: null,
          isHeld: false,
          heldReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as OnboardingItem;
        items.push(item);
        members.push({
          cohortId,
          onboardingItemId: itemId,
          productSku: item.upc,
          normalizedBrand: 'acme',
          normalizedNameStem: `product ${c} ${m}`,
          membershipReasonJson: null,
          extractionHash: 'hash123',
          ordinal: m,
          createdAt: new Date().toISOString(),
        });
        extractionSourcesByItemId.set(itemId, {
          sourceUrl: item.sourceUrl,
          sourceType: 'official_page',
          extractionMethod: 'standard',
          sourcingGenerationId: null,
          acceptedEvidenceAttemptIds: [],
          evidenceHash: 'hash123',
          manualAttestationId: null,
        });
      }
      membersByCohortId.set(cohortId, members);
    }

    // Run baseline timing for 100 iterations
    const iterations = 100;
    const start = performance.now();

    for (let iter = 0; iter < iterations; iter++) {
      for (const cohort of cohorts) {
        buildCohortView(cohort, items, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId);
      }
    }

    const elapsedMs = performance.now() - start;
    const avgMs = elapsedMs / iterations;

    console.log(`[Benchmark Baseline] ${iterations} iterations of 500 items across 50 cohorts: total ${elapsedMs.toFixed(2)}ms (avg ${avgMs.toFixed(3)}ms / iter)`);
    expect(avgMs).toBeGreaterThan(0);
  });
});
