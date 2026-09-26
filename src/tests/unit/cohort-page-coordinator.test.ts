import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductLineItemSnapshot } from '../../classification/types';

const mocks = vi.hoisted(() => ({
  callLlmForTask: vi.fn(),
  getLlmConfigForTask: vi.fn(),
  callLlmForTaskWithProvenance: vi.fn(),
}));

vi.mock('@/onboarding/llm-client', () => ({
  callLlmForTask: mocks.callLlmForTask,
  getLlmConfigForTask: mocks.getLlmConfigForTask,
  // Route through the test handle so tests can inspect the transport options
  // (e.g. the B3 protectedOperation pin); the default implementation wraps the
  // string content in the enriched result shape the coordinator consumes.
  callLlmForTaskWithProvenance: (...args: unknown[]) => mocks.callLlmForTaskWithProvenance(...args),
}));
vi.mock('@/db/repositories/page-repo', () => ({ listPages: vi.fn(() => []) }));
vi.mock('@/db/repositories/provider-connection-repo', () => ({
  getFullAiRoutingConfig: vi.fn(() => ({ connections: {} })),
}));
vi.mock('@/db/repositories/api-key-repo', () => ({
  getApiKey: vi.fn(() => null),
}));
// The coordinator records terminal preflight rows; mock the repo so the
// bun:sqlite-backed module never loads in the Vitest graph.
vi.mock('@/db/repositories/classification-model-call-repo', () => ({
  recordTerminalPreflight: vi.fn(),
}));
// The page-hash module now derives the P-hash model authority from the frozen
// model-execution-plan entry (PR7 review R2 F2c); mock the DB-backed
// runtime-snapshot module so the Vitest graph never loads bun:sqlite. The
// pure plan-entry lookup is exercised in the bun:test hash suite.
vi.mock('@/classification/runtime-snapshot', () => ({
  getModelExecutionPlanEntry: () => null,
}));

vi.mock('@/classification/page-decision', () => ({
  coordinateCohortPagesWithJev: vi.fn(async (params: any) => {
    return new Map(
      params.products.map((p: any) => [
        p.sku,
        {
          status: 'assigned',
          pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }],
          modelCallIds: ['call-jev-1'],
        },
      ]),
    );
  }),
}));

import {
  clearCohortPageCoordinationCache,
  coordinateCohortPagesOnce,
  coordinateCohortPagesCore,
  type CohortPageCoordinationParams,
} from '../../classification/cohort-page-proposal-engine';
import { coordinateCohortPagesWithJev } from '../../classification/page-decision';

const pages = [
  { id: 'cat-wet', name: 'Cat Food Wet', parentName: 'Cat Food Shop All' },
  { id: 'cat-shop', name: 'Cat Food Shop All', parentName: null },
  { id: 'dog-food', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' },
  { id: 'brand-acme', name: 'Brand - Acme', parentName: null },
  { id: 'cat-treats', name: 'Cat Treats', parentName: null },
];

function product(sku: string, species: string[] = ['Cat']): ProductLineItemSnapshot {
  return {
    sku,
    name: `Acme Pate ${sku}`,
    webTitle: `Acme Pate ${sku}`,
    brand: 'Acme',
    description: 'Complete and balanced nutrition.',
    species,
    flavor: sku,
    lifeStage: null,
    productForm: 'Pate',
    healthConcern: [],
  };
}

function params(products = [product('SKU1'), product('SKU2')]): CohortPageCoordinationParams {
  return { groupId: 'group-acme-pate', products, pages, selectionMode: 'multiple', maxPages: 5 };
}

const mockJevPolicy: any = {
  policyDigest: 'policy-jev',
  defaultProvider: 'typesafe',
  defaultLocality: 'cloud',
  defaultModel: 'jev',
  providerLocalities: { typesafe: 'cloud' },
  stageOverrides: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  clearCohortPageCoordinationCache();
});

describe('cohort page coordinator (input validation & guards)', () => {
  it('abstains when fewer than two products are provided without allowSingleProduct', async () => {
    const result = await coordinateCohortPagesCore(params([product('SKU1')]));
    expect(result.get('SKU1')).toEqual({
      status: 'abstained',
      reason: 'Cohort page coordination requires at least two products.',
    });
  });

  it('allows single product when allowSingleProduct is true', async () => {
    const single = { ...params([product('SKU1')]), modelPolicy: mockJevPolicy };
    const result = await coordinateCohortPagesCore(single, { allowSingleProduct: true });
    expect(coordinateCohortPagesWithJev).toHaveBeenCalledTimes(1);
    expect(result.get('SKU1')?.status).toBe('assigned');
  });

  it('abstains when no category pages are available', async () => {
    const input = { ...params(), pages: [] };
    const result = await coordinateCohortPagesCore(input);
    expect(result.get('SKU1')).toEqual({
      status: 'abstained',
      reason: 'No configured Category Pages are available.',
    });
  });

  it('abstains when input contains duplicate SKUs', async () => {
    const input = params([product('SKU1'), product('SKU1')]);
    const result = await coordinateCohortPagesCore(input);
    expect(result.get('SKU1')).toEqual({
      status: 'abstained',
      reason: 'Cohort input contains duplicate SKUs.',
    });
  });

  it('throws on provenance mismatch between modelCall context and protected operation', async () => {
    const input: CohortPageCoordinationParams = {
      ...params(),
      modelCall: {
        runId: 'run-1',
        stageName: 'category_page_proposals',
        operation: 'cohort_page_assignment_parent',
        attempt: 1,
      } as any,
    };
    await expect(
      coordinateCohortPagesCore(input, { protectedOperation: 'cohort_page_assignment' as any }),
    ).rejects.toThrow('Cohort page coordination provenance mismatch');
  });
});

describe('cohort page coordinator (ADR 0033 retirement & Jev delegation)', () => {
  it('abstains all products when routed to non-Jev provider (chat classifiers retired)', async () => {
    const input = params();
    const result = await coordinateCohortPagesCore(input);
    expect([...result.values()].every(value => value.status === 'abstained')).toBe(true);
    expect(result.get('SKU1')?.status).toBe('abstained');
    if (result.get('SKU1')?.status === 'abstained') {
      expect((result.get('SKU1') as any).reason).toContain('Superseded chat classifiers are retired per ADR 0033');
    }
    expect(coordinateCohortPagesWithJev).not.toHaveBeenCalled();
  });

  it('delegates to coordinateCohortPagesWithJev when provider is typesafe', async () => {
    const input = { ...params(), modelPolicy: mockJevPolicy };
    const result = await coordinateCohortPagesCore(input);
    expect(coordinateCohortPagesWithJev).toHaveBeenCalledTimes(1);
    expect(result.get('SKU1')?.status).toBe('assigned');
    expect(result.get('SKU2')?.status).toBe('assigned');
  });

  it('shares one delegation call across concurrent and sequential calls via cache', async () => {
    const input = { ...params(), modelPolicy: mockJevPolicy };
    const [first, second] = await Promise.all([
      coordinateCohortPagesOnce(input),
      coordinateCohortPagesOnce(input),
    ]);
    const third = await coordinateCohortPagesOnce(input);
    expect(coordinateCohortPagesWithJev).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('invalidates the stable fingerprint when a product or page changes', async () => {
    const first = { ...params(), modelPolicy: mockJevPolicy };
    await coordinateCohortPagesOnce(first);
    const changedProduct = {
      ...params([{ ...first.products[0], description: 'Changed evidence' }, first.products[1]]),
      modelPolicy: mockJevPolicy,
    };
    await coordinateCohortPagesOnce(changedProduct);
    const changedPage = {
      ...changedProduct,
      pages: [...pages, { id: 'new-page', name: 'New Page', parentName: null }],
    };
    await coordinateCohortPagesOnce(changedPage);
    expect(coordinateCohortPagesWithJev).toHaveBeenCalledTimes(3);
  });
});

