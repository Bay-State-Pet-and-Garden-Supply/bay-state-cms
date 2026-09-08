/**
 * Integration tests for `processPageTarget()` in `curation-target-processor.ts`.
 *
 * Verifies that the LLM-first path is used (not keyword matching) and that
 * proposals are correctly shaped.
 *
 * Mocks `page-assignment-llm` at the module level to avoid loading
 * bun:sqlite transitive dependencies through `page-repo`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks — mock the entire page-assignment-llm module so its
//    transitive dependencies (page-repo → bun:sqlite) never load ─────

vi.mock('@/classification/page-assignment-llm', () => ({
  buildPageHierarchy: vi.fn(),
  extractProductContext: vi.fn(),
  llmAssignCategoryPages: vi.fn(),
}));

vi.mock('@/classification/runtime-snapshot', () => ({ buildModelCallContext: vi.fn(() => null) }));
vi.mock('@/classification/config-loader', () => ({
  loadClassificationConfig: vi.fn(() => ({
    curationTargets: [
      {
        id: 'page-assignment',
        kind: 'page',
        label: 'Store Category Pages',
        enabled: true,
        selectionMode: 'multiple',
        
      },
    ],
    productTypes: [],
    attributes: [],
  })),
}));

vi.mock('@/classification/curation-target-resolver', () => ({
  resolveEnabledTargets: vi.fn(),
}));

vi.mock('@/classification/curation-target-ranker', () => ({
  llmRankOptions: vi.fn(),
}));

vi.mock('@/classification/cohort-page-proposal-engine', () => ({
  coordinateCohortPagesOnce: vi.fn(),
}));

// Import after mocks
import { processPageTarget, processProductFieldTarget } from '../../classification/curation-target-processor';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
} from '../../classification/page-assignment-llm';
import type { StageInput, StageContext } from '../../classification/types';
import type { ClassificationEvidence } from '../../shared/types';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import { llmRankOptions } from '../../classification/curation-target-ranker';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const makeContext = (overrides: Partial<StageContext> = {}): StageContext => ({
  workspacePath: '/tmp/test-workspace',
  workspaceId: 'test-workspace',
  runId: 'run-test',
  configSnapshotRef: {
    id: 'snap-1',
    hash: 'snap-1',
    sourceCommit: null,
    createdAt: new Date().toISOString(),
  },
  ...overrides,
});

const makeInput = (overrides: Partial<StageInput> = {}): StageInput => ({
  sku: 'test-sku',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
  ...overrides,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('processPageTarget (LLM-first)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty proposals when no options are available', async () => {
    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [],
      },
      input,
      context,
    );

    expect(result.proposals).toEqual([]);
    expect(result.message).toContain('No options available');
    expect(llmAssignCategoryPages).not.toHaveBeenCalled();
  });

  it('calls LLM (not keyword matcher) when page options exist and returns proposals', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' },
      { id: 'dog-food-wet', name: 'Dog Food Wet', parentName: 'Dog Food Shop All' },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test Product',
      productDescription: 'A test product.',
      ocrSummary: {
        species: ['Dog'],
        flavor: null,
        lifeStage: null,
        productForm: null,
        healthConcern: [],
        productName: null,
        brand: null,
      },
      productType: 'Dry Dog Food',
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue({
      pages: [
        { pageId: 'dog-food-dry', pageName: 'Dog Food Dry', confidence: 0.85 },
        { pageId: 'dog-food-wet', pageName: 'Dog Food Wet', confidence: 0.65 },
      ],
    });

    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [
          { value: 'dog-food-dry', label: 'Dog Food Dry' },
          { value: 'dog-food-wet', label: 'Dog Food Wet' },
        ],
      },
      input,
      context,
    );

    expect(llmAssignCategoryPages).toHaveBeenCalledTimes(1);
    expect(buildPageHierarchy).toHaveBeenCalledTimes(1);
    expect(extractProductContext).toHaveBeenCalledTimes(1);
    expect(llmAssignCategoryPages).toHaveBeenCalledWith(
      expect.objectContaining({
        productName: 'Test Product',
        productType: 'Dry Dog Food',
      }),
    );

    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0].proposalType).toBe('category_page');
    // Stable Page ID is the identity; the display name lives in the value.
    expect(result.proposals[0].targetId).toBe('dog-food-dry');
    expect(result.proposals[0].proposedValue).toHaveProperty('pageId');
    expect(result.proposals[0].proposedValue).toHaveProperty('pageName');
  });

  it('returns empty proposals when LLM returns null', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: null },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test',
      productDescription: '',
      ocrSummary: {
        species: [], flavor: null, lifeStage: null, productForm: null,
        healthConcern: [], productName: null, brand: null,
      },
      productType: null,
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue(null);

    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [{ value: 'dog-food-dry', label: 'Dog Food Dry' }],
      },
      input,
      context,
    );

    expect(result.proposals).toEqual([]);
    expect(result.message).toContain('No page assignment from LLM');
  });

  it('proposals include pageId and pageName in proposedValue', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: null },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test',
      productDescription: '',
      ocrSummary: {
        species: [], flavor: null, lifeStage: null, productForm: null,
        healthConcern: [], productName: null, brand: null,
      },
      productType: null,
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue({
      pages: [{ pageId: 'dog-food-dry', pageName: 'Dog Food Dry', confidence: 0.8 }],
    });

    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [{ value: 'dog-food-dry', label: 'Dog Food Dry' }],
      },
      input,
      context,
    );

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal.proposalType).toBe('category_page');
    expect(proposal.targetId).toBe('dog-food-dry');
    expect(proposal.proposedValue).toHaveProperty('pageId', 'dog-food-dry');
    expect(proposal.proposedValue).toHaveProperty('pageName', 'Dog Food Dry');
    expect(proposal.confidence).toBeGreaterThanOrEqual(0);
  });

  it('builds the LLM product context ONLY from the restricted page packet (excludes healthConcern, id-ordered)', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: null },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test',
      productDescription: '',
      ocrSummary: {
        species: [], flavor: null, lifeStage: null, productForm: null,
        healthConcern: [], productName: null, brand: null,
      },
      productType: null,
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue({
      pages: [{ pageId: 'dog-food-dry', pageName: 'Dog Food Dry', confidence: 0.8 }],
    });

    const context = makeContext();
    const base: Partial<ClassificationEvidence> = {
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: 'test-sku',
      reliability: 'high',
      sourceUrl: null,
      snippet: null,
      metadata: {},
      capturedAt: new Date().toISOString(),
    };
    const input = makeInput({
      evidence: [
        { ...base, id: 'ev-z-species-cat', attributeId: 'species', source: 'official_product_page', sourceField: 'species', value: 'Cat' },
        { ...base, id: 'ev-a-species-dog', attributeId: 'species', source: 'official_product_page', sourceField: 'species', value: 'Dog' },
        { ...base, id: 'ev-m-category', attributeId: null, source: 'official_product_page', sourceField: 'category', value: 'Dog Food' },
        { ...base, id: 'ev-n-name', attributeId: null, source: 'spreadsheet', sourceField: 'name', value: 'Test Product' },
        { ...base, id: 'ev-x-health', attributeId: null, source: 'visual_product_evidence', sourceField: 'healthConcern', value: 'Sensitive Stomach' },
      ] as ClassificationEvidence[],
    });

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [{ value: 'dog-food-dry', label: 'Dog Food Dry' }],
      },
      input,
      context,
    );

    expect(result.proposals).toHaveLength(1);
    // The restricted packet reaches extractProductContext: id-ordered, and the
    // excluded healthConcern record never appears (issue #17 pass 5c).
    expect(extractProductContext).toHaveBeenCalledTimes(1);
    const contextEvidence = vi.mocked(extractProductContext).mock.calls[0][0];
    const ids = contextEvidence.map(e => e.id);
    expect(ids).toEqual(['ev-a-species-dog', 'ev-m-category', 'ev-n-name', 'ev-z-species-cat']);
    expect(ids).not.toContain('ev-x-health');
    expect(ids).toEqual([...ids].sort());
  });
});

// ─── Brand shortcut (issue #17 pass 5b) ───────────────────────────────────────

const brandTarget = (): ResolvedTarget => ({
  config: {
    id: 'brand',
    kind: 'product_field',
    label: 'Brand',
    enabled: true,
    mandatory: false,
    selectionMode: 'single',
    attributeId: 'brand',
    catalogField: 'ProductField16',
    optionSource: 'configured',
    required: false,
    sortOrder: 0,
  },
  options: [
    { value: 'Blue Buffalo', label: 'Blue Buffalo' },
    { value: 'Dr. Marty', label: 'Dr. Marty' },
  ],
  attribute: {
    id: 'brand',
    name: 'Brand',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Blue Buffalo', 'Dr. Marty'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Identity',
  },
});

const brandEvidence = (id: string, overrides: Partial<ClassificationEvidence>): ClassificationEvidence => ({
  id,
  runId: 'run-test',
  stageName: 'evidence_extraction' as const,
  productSku: 'test-sku',
  attributeId: null,
  source: 'official_product_page' as const,
  reliability: 'high' as const,
  sourceUrl: null,
  sourceField: 'brand',
  snippet: null,
  value: 'Blue Buffalo',
  metadata: {},
  capturedAt: '2026-08-01T12:00:00.000Z',
  ...overrides,
});

describe('brand shortcut (issue #17 pass 5b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmRankOptions).mockResolvedValue({
      values: ['Blue Buffalo'],
      confidence: 0.9,
      modelCallIds: [],
    });
  });

  it('shortcuts only when EVERY reviewed brand assertion (incl. ordinary scalar brand records) agrees on the exact canonical identity', async () => {
    const resolved = brandEvidence('ev-resolved', {
      sourceField: 'resolved_brand',
      value: { brandId: 'blue-buffalo', brandName: 'Blue Buffalo', confidence: 0.95, matchedBy: 'catalog' },
    });
    const scalar = brandEvidence('ev-scalar', { value: 'Blue Buffalo' });
    const result = await processProductFieldTarget(brandTarget(), makeInput({ evidence: [resolved, scalar] }), makeContext());
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].proposedValue).toBe('Blue Buffalo');
    expect(result.proposals[0].supportingEvidenceIds?.sort()).toEqual(['ev-resolved', 'ev-scalar'].sort());
    expect(llmRankOptions).not.toHaveBeenCalled();
  });

  it('does NOT shortcut when a scalar official-page brand disagrees with the resolved brand — conflict is visible, never first-wins', async () => {
    const resolved = brandEvidence('ev-resolved', {
      sourceField: 'resolved_brand',
      value: { brandId: 'blue-buffalo', brandName: 'Blue Buffalo', confidence: 0.95, matchedBy: 'catalog' },
    });
    const official = brandEvidence('ev-official', { value: 'Dr. Marty' });
    const result = await processProductFieldTarget(brandTarget(), makeInput({ evidence: [resolved, official] }), makeContext());
    // Falls through to the normal matching path; the disagreeing assertions
    // are visible contradicting evidence and the proposal is forced to review.
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].isBulkAcceptable).toBe(false);
    expect(result.proposals[0].contradictingEvidenceIds?.sort()).toEqual(['ev-official', 'ev-resolved'].sort());
  });

  it('treats case-different brand values as DISTINCT identities — no case folding shortcut', async () => {
    const one = brandEvidence('ev-one', { value: 'Blue Buffalo' });
    const two = brandEvidence('ev-two', { value: 'BLUE BUFFALO' });
    const result = await processProductFieldTarget(brandTarget(), makeInput({ evidence: [one, two] }), makeContext());
    expect(result.proposals).toHaveLength(1);
    // Both disagreeing assertions are visible contradicting evidence and the
    // role sets are pairwise DISJOINT: the selected assertion cannot be both
    // supporting and contradicting (issue #17 pass 5c — the pipeline linkage
    // rolls back on overlap, so disjointness is required for a reviewable
    // proposal).
    expect(result.proposals[0].contradictingEvidenceIds?.sort()).toEqual(['ev-one', 'ev-two'].sort());
    expect(result.proposals[0].supportingEvidenceIds ?? []).toEqual([]);
    const support = new Set(result.proposals[0].supportingEvidenceIds ?? []);
    const conflict = new Set(result.proposals[0].contradictingEvidenceIds ?? []);
    for (const id of conflict) {
      expect(support.has(id)).toBe(false);
    }
    expect(result.proposals[0].isBulkAcceptable).toBe(false);
  });
});
