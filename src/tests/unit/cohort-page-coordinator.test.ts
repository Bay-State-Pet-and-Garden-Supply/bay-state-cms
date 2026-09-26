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

import {
  clearCohortPageCoordinationCache,
  coordinateCohortPagesOnce,
  coordinateCohortPagesCore,
  type CohortPageCoordinationParams,
} from '../../classification/cohort-page-proposal-engine';
import { llmAssignCategoryPages } from '../../classification/page-assignment-llm';

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

function validResponse(products: ProductLineItemSnapshot[]): string {
  return JSON.stringify(Object.fromEntries(products.map(item => [item.sku, [
    { pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 },
  ]])));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCohortPageCoordinationCache();
  mocks.getLlmConfigForTask.mockReturnValue({ provider: 'openai', model: 'test-model' });
  mocks.callLlmForTaskWithProvenance.mockImplementation(
    async (task: string, prompt: string, system: string) => {
      const content = await mocks.callLlmForTask(task, prompt, system);
      return content == null
        ? null
        : { content, callId: 'cohort-call-1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } };
    },
  );
});

describe('cohort page coordinator', () => {
  it('shares one LLM call across concurrent and sequential calls', async () => {
    const input = params();
    mocks.callLlmForTask.mockResolvedValue(validResponse(input.products));
    const [first, second] = await Promise.all([
      coordinateCohortPagesOnce(input),
      coordinateCohortPagesOnce(input),
    ]);
    const third = await coordinateCohortPagesOnce(input);
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('includes every member of a 16-variant group in one call and result', async () => {
    const products = Array.from({ length: 16 }, (_, index) => product(`SKU${index + 1}`));
    const input = params(products);
    mocks.callLlmForTask.mockResolvedValue(validResponse(products));
    const result = await coordinateCohortPagesOnce(input);
    expect(result.size).toBe(16);
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
    const prompt = mocks.callLlmForTask.mock.calls[0][1] as string;
    for (const item of products) expect(prompt).toContain(`SKU ${item.sku}`);
  });

  it('normalizes exact brand and removes Shop All beside a specific page', async () => {
    const input = params();
    mocks.callLlmForTask.mockResolvedValue(JSON.stringify({
      SKU1: [
        { pageId: 'cat-shop', pageName: 'Cat Food Shop All', confidence: 0.5 },
        { pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 },
      ],
      SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }],
    }));
    const result = await coordinateCohortPagesOnce(input);
    expect(result.get('SKU1')).toEqual({ status: 'assigned', pages: [
      { pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 },
      { pageId: 'brand-acme', pageName: 'Brand - Acme', confidence: 0.95, isBrandShortcut: true },
    ], modelCallIds: ['cohort-call-1'] });
  });

  it('applies species safety per SKU and retains different valid page sets', async () => {
    const input = params([product('CAT', ['Cat']), product('DOG', ['Dog'])]);
    mocks.callLlmForTask.mockResolvedValue(JSON.stringify({
      CAT: [
        { pageId: 'dog-food', pageName: 'Dog Food Dry', confidence: 0.7 },
        { pageId: 'cat-treats', pageName: 'Cat Treats', confidence: 0.8 },
      ],
      DOG: [{ pageId: 'dog-food', pageName: 'Dog Food Dry', confidence: 0.85 }],
    }));
    const result = await coordinateCohortPagesOnce(input);
    const cat = result.get('CAT');
    const dog = result.get('DOG');
    expect(cat?.status).toBe('assigned');
    expect(dog?.status).toBe('assigned');
    if (cat?.status === 'assigned' && dog?.status === 'assigned') {
      expect(cat.pages.map(page => page.pageId)).toEqual(['cat-treats', 'brand-acme']);
      expect(dog.pages.map(page => page.pageId)).toEqual(['dog-food', 'brand-acme']);
      expect(cat.pages).not.toEqual(dog.pages);
    }
  });

  it.each([
    ['missing SKU', JSON.stringify({ SKU1: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['unknown ID', JSON.stringify({ SKU1: [{ pageId: 'missing', pageName: 'Cat Food Wet', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['ID/name mismatch', JSON.stringify({ SKU1: [{ pageId: 'cat-wet', pageName: 'Dog Food Dry', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['missing pageId', JSON.stringify({ SKU1: [{ pageName: 'Cat Food Wet', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['empty assignment', JSON.stringify({ SKU1: [], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['invalid JSON', '{not json'],
    ['wrapper object', JSON.stringify({ assignments: { SKU1: [], SKU2: [] } })],
    ['unknown SKU', JSON.stringify({ SKU1: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }], OTHER: [] })],
    ['duplicate SKU key', '{"SKU1":[{"pageId":"cat-wet","pageName":"Cat Food Wet","confidence":0.8}],"SKU1":[{"pageId":"cat-wet","pageName":"Cat Food Wet","confidence":0.8}],"SKU2":[{"pageId":"cat-wet","pageName":"Cat Food Wet","confidence":0.8}]}'],
  ])('abstains every member for %s', async (_label, response) => {
    const input = params();
    mocks.callLlmForTask.mockResolvedValue(response);
    const result = await coordinateCohortPagesOnce(input);
    expect([...result.values()].every(value => value.status === 'abstained')).toBe(true);
  });

  it('invalidates the stable fingerprint when a product or page changes', async () => {
    const first = params();
    mocks.callLlmForTask.mockResolvedValue(validResponse(first.products));
    await coordinateCohortPagesOnce(first);
    const changedProduct = params([{ ...first.products[0], description: 'Changed evidence' }, first.products[1]]);
    await coordinateCohortPagesOnce(changedProduct);
    const changedPage = { ...changedProduct, pages: [...pages, { id: 'new-page', name: 'New Page', parentName: null }] };
    await coordinateCohortPagesOnce(changedPage);
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(3);
  });

  it('handles markdown-fenced responses, "SKU <sku>" keys, and leading zero variations', async () => {
    const input = params([product('01234'), product('SKU2')]);
    mocks.callLlmForTask.mockResolvedValue(`\`\`\`json
{
  "SKU 01234": [
    { "pageId": "cat-wet", "pageName": "Cat Food Wet", "confidence": 0.85 }
  ],
  "SKU2": [
    { "pageId": "cat-wet", "pageName": "Cat Food Wet", "confidence": 0.8 }
  ]
}
\`\`\``);
    const result = await coordinateCohortPagesOnce(input);
    const item1 = result.get('01234');
    const item2 = result.get('SKU2');
    expect(item1?.status).toBe('assigned');
    expect(item2?.status).toBe('assigned');
  });
});

describe('PR7 review R2 (F2) — singleton parity: parent singletons are ONE-MEMBER core invocations (legacy llmAssignCategoryPages is child-only)', () => {
  it('allowSingleProduct renders the SAME v2 prompt family as a group with a single product block', async () => {
    mocks.callLlmForTask.mockResolvedValue(validResponse([product('SKU1')]));
    const single = params([product('SKU1')]);
    const result = await coordinateCohortPagesCore(
      single,
      {
        allowSingleProduct: true,
        executionTypeContext: { id: 'type-1', label: 'Dry Dog Food', confidence: 0.95, outcome: 'coherent' },
      },
    );
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
    const assigned = result.get('SKU1');
    expect(assigned?.status).toBe('assigned');
    if (assigned?.status === 'assigned') {
      expect(assigned.pages.map(page => page.pageId)).toEqual(['cat-wet', 'brand-acme']);
      expect(assigned.modelCallIds).toEqual(['cohort-call-1']);
    }
    const prompt = mocks.callLlmForTaskWithProvenance.mock.calls[0][1] as string;
    // The one-member prompt is the SAME v2 prompt family as a group call: the
    // Execution Type block (confidence + outcome) and one rendered product.
    expect(prompt).toContain(
      'EXECUTION PRODUCT TYPE CONTEXT:\nProduct Type Context: "type-1 (Dry Dog Food)"\nConfidence: 0.95\nOutcome: coherent',
    );
    expect(prompt).toContain('SKU SKU1');
    expect(prompt).toContain('- Web title: Acme Pate SKU1');
    expect(prompt).not.toContain('SKU SKU2');
  });

  it('WITHOUT allowSingleProduct the one-member guard still abstains (legacy byte-identity)', async () => {
    const result = await coordinateCohortPagesCore(params([product('SKU1')]));
    expect(result.get('SKU1')).toEqual({ status: 'abstained', reason: 'Cohort page coordination requires at least two products.' });
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
  });

  it('legacy callers omit the options → the transport keeps the legacy page_assignment route (byte-identical)', async () => {
    function mockDivergentRoutes(): void {
      mocks.getLlmConfigForTask.mockImplementation((task: string, options: Record<string, unknown>) => {
        const operation = options?.protectedOperation;
        if (operation === 'cohort_page_assignment') return { provider: 'ollama', model: 'qwen2.5vl:latest' };
        if (operation === 'page_assignment') return { provider: 'openai', model: 'gpt-4o-mini' };
        return { provider: 'openai', model: 'test-model' };
      });
    }
    function singletonParams() {
      return {
        productName: 'Acme Pate Chicken',
        productDescription: 'Wet food in a cup.',
        ocrSummary: {
          species: ['Cat'], flavor: 'Chicken', lifeStage: null, productForm: 'Pate',
          healthConcern: [], productName: null, brand: 'Acme',
        },
        productType: 'Dry Dog Food',
        pages,
        selectionMode: 'multiple' as const,
        maxPages: 5,
      };
    }
    mockDivergentRoutes();
    mocks.callLlmForTask.mockResolvedValue(
      JSON.stringify({ pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] }),
    );
    const result = await llmAssignCategoryPages(singletonParams());
    expect(result).not.toBeNull();
    const transportOptions = mocks.callLlmForTaskWithProvenance.mock.calls[0][3] as Record<string, unknown>;
    expect(transportOptions.protectedOperation).toBe('page_assignment');
  });
});
