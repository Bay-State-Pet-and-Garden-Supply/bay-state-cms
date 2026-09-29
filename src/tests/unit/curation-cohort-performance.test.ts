import { describe, it, expect } from 'bun:test';
import { buildCohortView, evaluateCohortReadiness } from '../../onboarding/curation-cohort-service';
import type { CurationCohort, CurationCohortMember, CohortRun } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { ExtractionBinding } from '../../db/repositories/onboarding-extraction-repo';

function createMockItem(id: string, batchId: string, sku: string): OnboardingItem {
  return {
    id,
    batchId,
    upc: sku,
    name: `Test Product ${sku}`,
    brandHint: 'TestBrand',
    stage: 'collect_details',
    stageStatus: 'completed',
    sourceType: 'official_page',
    sourceUrl: `https://example.com/p/${sku}`,
    extractionData: {
      primaryImage: `https://example.com/img/${sku}.jpg`,
      title: `Test Product ${sku}`,
      description: 'Product description',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as OnboardingItem;
}

function createWorkload(cohortCount: number, membersPerCohort: number) {
  const batchId = 'batch_bench_1';
  const items: OnboardingItem[] = [];
  const cohorts: CurationCohort[] = [];
  const membersByCohortId = new Map<string, CurationCohortMember[]>();
  const extractionSourcesByItemId = new Map<string, ExtractionBinding>();
  const currentRunsByCohortId = new Map<string, CohortRun>();

  let itemIdx = 0;
  for (let c = 0; c < cohortCount; c++) {
    const cohortId = `cohort_${c}`;
    const cohortMembers: CurationCohortMember[] = [];

    for (let m = 0; m < membersPerCohort; m++) {
      itemIdx++;
      const itemId = `item_${itemIdx}`;
      const sku = `100000${itemIdx}`;
      const item = createMockItem(itemId, batchId, sku);
      items.push(item);

      cohortMembers.push({
        id: `member_${itemIdx}`,
        cohortId,
        onboardingItemId: itemId,
        productSku: sku,
        normalizedBrand: 'testbrand',
        normalizedNameStem: 'test product',
        extractionHash: `hash_${itemIdx}`,
        ordinal: m + 1,
        createdAt: new Date().toISOString(),
      } as unknown as CurationCohortMember);

      extractionSourcesByItemId.set(itemId, {
        sourceUrl: item.sourceUrl!,
        sourceType: 'official_page',
        extractionMethod: 'selector_v1',
        sourcingGenerationId: null,
        acceptedEvidenceAttemptIds: [],
        evidenceHash: `hash_${itemIdx}`,
        manualAttestationId: null,
      });
    }

    cohorts.push({
      id: cohortId,
      workspaceId: 'ws_1',
      batchId,
      groupKey: `key_${c}`,
      groupLabel: `Group ${c}`,
      status: 'waiting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as CurationCohort);

    membersByCohortId.set(cohortId, cohortMembers);
  }

  return { batchId, items, cohorts, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId };
}

describe('curation cohort service performance & parity', () => {
  it('preserves exact semantic output for cohort views and readiness', () => {
    const { items, cohorts, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId } = createWorkload(10, 5);
    const itemsByIdMap = new Map(items.map(item => [item.id, item]));

    for (const cohort of cohorts) {
      const members = membersByCohortId.get(cohort.id)!;
      const viewUnoptimized = buildCohortView(cohort, items, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId);
      const viewOptimized = buildCohortView(cohort, items, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId, itemsByIdMap);

      expect(viewOptimized.status).toBe(viewUnoptimized.status);
      expect(viewOptimized.state).toBe(viewUnoptimized.state);
      expect(viewOptimized.blockedReason).toBe(viewUnoptimized.blockedReason);
      expect(viewOptimized.readyCount).toBe(viewUnoptimized.readyCount);
      expect(viewOptimized.memberCount).toBe(viewUnoptimized.memberCount);
      expect(viewOptimized.members.length).toBe(viewUnoptimized.members.length);

      for (let i = 0; i < viewOptimized.members.length; i++) {
        expect(viewOptimized.members[i].ready).toBe(viewUnoptimized.members[i].ready);
        expect(viewOptimized.members[i].state).toBe(viewUnoptimized.members[i].state);
        expect(viewOptimized.members[i].blockedReason).toBe(viewUnoptimized.members[i].blockedReason);
        expect(viewOptimized.members[i].onboardingItemId).toBe(viewUnoptimized.members[i].onboardingItemId);
      }

      const evalUnopt = evaluateCohortReadiness(cohort, members, items, extractionSourcesByItemId);
      const evalOpt = evaluateCohortReadiness(cohort, members, items, extractionSourcesByItemId, itemsByIdMap);

      expect(evalOpt.status).toBe(evalUnopt.status);
      expect(evalOpt.state).toBe(evalUnopt.state);
      expect(evalOpt.readyCount).toBe(evalUnopt.readyCount);
      expect(evalOpt.memberCount).toBe(evalUnopt.memberCount);
    }
  });

  it('measures batch cohort projection performance across 100 cohorts', () => {
    const { items, cohorts, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId } = createWorkload(50, 10);
    const itemsByIdMap = new Map(items.map(item => [item.id, item]));

    const iterations = 20;

    const start = performance.now();
    for (let iter = 0; iter < iterations; iter++) {
      for (const cohort of cohorts) {
        buildCohortView(cohort, items, membersByCohortId, extractionSourcesByItemId, currentRunsByCohortId, itemsByIdMap);
      }
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThan(0);
    console.log(`[Performance Test] Projected 500 items across 50 cohorts x ${iterations} iterations in ${elapsed.toFixed(2)} ms`);
  });
});
