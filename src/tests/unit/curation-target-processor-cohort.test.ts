import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageContext, StageInput } from '../../classification/types';

const mocks = vi.hoisted(() => ({
  coordinate: vi.fn(),
  perItem: vi.fn(),
}));

vi.mock('@/classification/config-loader', () => ({ loadClassificationConfig: vi.fn() }));
vi.mock('@/classification/curation-target-resolver', () => ({
  resolveEnabledTargets: vi.fn(),
  resolveTargetsFromSnapshot: vi.fn(() => ({
    pages: [{
      config: { id: 'pages', kind: 'page', label: 'Pages', enabled: true, selectionMode: 'multiple' },
      options: [],
    }],
    productTypes: [],
  })),
}));
vi.mock('@/classification/detail-enrichment', () => ({ enrichProductDetails: vi.fn(() => []) }));
vi.mock('@/classification/curation-target-ranker', () => ({ llmRankOptions: vi.fn() }));
vi.mock('@/classification/cohort-page-proposal-engine', () => ({
  coordinateCohortPagesOnce: mocks.coordinate,
}));
vi.mock('@/classification/page-assignment-llm', () => ({
  buildPageHierarchy: vi.fn((options: Array<{ value: string; label: string }>) =>
    options.map(option => ({ id: option.value, name: option.label, parentName: null }))),
  extractProductContext: vi.fn(() => ({
    productName: 'Acme Cat Pate',
    productDescription: 'Wet cat food',
    ocrSummary: { species: ['Cat'], flavor: null, lifeStage: null, productForm: 'Pate', healthConcern: [], productName: null, brand: 'Acme' },
    productType: null,
  })),
  llmAssignCategoryPages: mocks.perItem,
}));

vi.mock('@/classification/runtime-snapshot', () => ({ buildModelCallContext: vi.fn(() => null) }));
import { processPageTarget, materializeCoordinatedPages } from '../../classification/curation-target-processor';
import { categoryPageProposalsStage } from '../../classification/stages/category-page-proposals';

const products = [
  { sku: 'SKU1', name: 'Acme Cat Pate Chicken', webTitle: null, brand: 'Acme', description: '', species: ['Cat'], flavor: 'Chicken', lifeStage: null, productForm: 'Pate', healthConcern: [] },
  { sku: 'SKU2', name: 'Acme Cat Pate Salmon', webTitle: null, brand: 'Acme', description: '', species: ['Cat'], flavor: 'Salmon', lifeStage: null, productForm: 'Pate', healthConcern: [] },
];

const context: StageContext = {
  workspacePath: '/tmp/workspace',
  workspaceId: 'workspace',
  runId: 'run-SKU1',
  configSnapshotRef: { id: 'snapshot', hash: 'hash', sourceCommit: null, createdAt: '' },
  productLineContext: {
    groupId: 'group-acme-pate', groupLabel: 'Acme Pate', siblingNames: products.map(p => p.name),
    siblingWebTitles: [], siblingOcrTitles: [], siblingSkus: products.map(p => p.sku),
  },
  productLineItems: products,
};

const input: StageInput = {
  sku: 'SKU1', onboardingItemId: 'item-1', evidence: [], acceptedProposals: [], allProposals: [],
};

const target = {
  config: { id: 'pages', kind: 'page', label: 'Pages', enabled: true, selectionMode: 'multiple' },
  options: [{ value: 'cat-wet', label: 'Cat Food Wet' }],
};

describe('grouped page target processing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses only the current SKU result and never invokes per-item LLM', async () => {
    mocks.coordinate.mockResolvedValue(new Map([
      ['SKU1', { status: 'assigned', pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] }],
      ['SKU2', { status: 'assigned', pages: [{ pageId: 'other', pageName: 'Other', confidence: 0.7 }] }],
    ]));
    const result = await processPageTarget(target as any, input, context);
    expect(mocks.coordinate).toHaveBeenCalledTimes(1);
    expect(mocks.perItem).not.toHaveBeenCalled();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].productSku).toBe('SKU1');
    expect(result.proposals[0].targetId).toBe('cat-wet');
  });

  it('returns zero proposals on cohort abstention without per-item fallback', async () => {
    mocks.coordinate.mockResolvedValue(new Map([
      ['SKU1', { status: 'abstained', reason: 'invalid group response' }],
      ['SKU2', { status: 'abstained', reason: 'invalid group response' }],
    ]));
    const result = await processPageTarget(target as any, input, context);
    expect(result.proposals).toEqual([]);
    expect(result.message).toContain('Cohort page coordination abstained');
    expect(mocks.perItem).not.toHaveBeenCalled();
  });
});

// ─── PR7 C5 (issue #30): the child materializer ───────────────────────────────
// The durable parent page outputs (`coordinatedPages` on the stage context)
// turn `category_page_proposals` into a MATERIALIZER: assigned → proposals
// from the STORED row, abstained → the stored reason, missing/corrupt rows →
// deterministic abstain + warn. NEVER a Page LLM call, never an invented
// assignment; legacy behavior is unchanged when `coordinatedPages` is absent.

const verifiedSnapshot = {
  snapshotHash: 'snap-hash-1',
  pages: {
    state: 'verified',
    records: [
      {
        pageId: 'cat-wet',
        pageName: 'Cat Food Wet',
        parentPageId: null,
        parentPageName: null,
        verified: true,
        identityKind: 'page_id',
        identityKey: 'cat-wet',
        sourceHash: 'import-hash',
      },
    ],
  },
} as any;

const materializedContext: StageContext = {
  workspacePath: '/tmp/workspace',
  workspaceId: 'workspace',
  runId: 'run-SKU1',
  configSnapshotRef: { id: 'snapshot', hash: 'hash', sourceCommit: null, createdAt: '' },
  snapshot: verifiedSnapshot,
  productLineContext: {
    groupId: 'group-acme-pate',
    groupLabel: 'Acme Pate',
    siblingNames: ['Acme Cat Pate Chicken'],
    siblingWebTitles: [],
    siblingOcrTitles: [],
    siblingSkus: ['SKU1'],
  },
  coordinatedPages: new Map([
    ['SKU1', {
      output: {
        status: 'assigned',
        pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }],
        source: 'llm_cohort',
      },
      modelCallId: 'parent-call-1',
    }],
  ]),
};

describe('PR7 C5 — materializeCoordinatedPages (durable parent outputs, zero Page LLM)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assigned: builds proposals from the STORED row (pageId/pageName/confidence, verified identity, stored modelCallIds, packet evidence) with zero Page LLM calls', async () => {
    const result = await materializeCoordinatedPages(target as any, input, materializedContext);
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal.proposalType).toBe('category_page');
    expect(proposal.productSku).toBe('SKU1');
    expect(proposal.targetId).toBe('cat-wet');
    expect(proposal.confidence).toBe(0.8);
    expect((proposal.proposedValue as any).pageId).toBe('cat-wet');
    expect((proposal.proposedValue as any).pageName).toBe('Cat Food Wet');
    expect((proposal.proposedValue as any).identityVerified).toBe(true);
    expect(proposal.modelCallIds).toEqual(['parent-call-1']);
    expect(proposal.snapshotHash).toBe('snap-hash-1');
    expect(proposal.evidenceIds).toEqual([]);
    expect(result.message).toContain('Cohort page assignment materialized from parent coordination (cohort LLM)');
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('abstained: returns the STORED reason with zero proposals and zero Page LLM calls', async () => {
    const context: StageContext = {
      ...materializedContext,
      coordinatedPages: new Map([
        ['SKU1', { output: { status: 'abstained', reason: 'Cohort page LLM policy denied.' }, modelCallId: null }],
      ]),
    };
    const result = await materializeCoordinatedPages(target as any, input, context);
    expect(result.proposals).toEqual([]);
    expect(result.message).toBe('Cohort page LLM policy denied.');
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('PR8 DECISION-B: missing row (no pageCoordinationAbsent marker) => THROW — the member fails closed, zero Page LLM calls', async () => {
    const context: StageContext = { ...materializedContext, coordinatedPages: new Map() };
    await expect(materializeCoordinatedPages(target as any, input, context)).rejects.toThrow(
      /no parent page output row in active cohort mode/,
    );
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('PR8 DECISION-B: corrupt row => THROW — the member fails closed, zero Page LLM calls', async () => {
    const context: StageContext = {
      ...materializedContext,
      coordinatedPages: new Map([
        ['SKU1', { output: { status: 'assigned', pages: [{ pageId: 42 }] }, modelCallId: 'x' } as any],
      ]),
    };
    await expect(materializeCoordinatedPages(target as any, input, context)).rejects.toThrow(
      /corrupt parent page output payload/,
    );
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('PR8 review R1 (BLOCKER 2c): an ASSIGNED row with an EMPTY page list THROWS — the member fails closed, never a deterministic abstention / partial no-page draft', async () => {
    const context: StageContext = {
      ...materializedContext,
      coordinatedPages: new Map([
        ['SKU1', { output: { status: 'assigned', pages: [], source: 'llm_cohort' }, modelCallId: 'x' } as any],
      ]),
    };
    // The tightened `CohortPageOutputSchema` (pages.min(1)) rejects
    // assigned-empty at parse time, so the deterministic fail-closed throw is
    // the schema-violation message — the member FAILS either way (never the
    // old deterministic-abstention conversion).
    await expect(materializeCoordinatedPages(target as any, input, context)).rejects.toThrow(
      /corrupt parent page output payload/,
    );
    await expect(materializeCoordinatedPages(target as any, input, context)).rejects.toThrow(
      /SKU1/,
    );
    await expect(materializeCoordinatedPages(target as any, input, context)).rejects.toThrow(
      /run-SKU1/,
    );
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('PR8 DECISION-B: missing row WITH the pageCoordinationAbsent expected-empty marker => clean deterministic abstain (unchanged PR7 R2 F3.3 semantics)', async () => {
    const context: StageContext = {
      ...materializedContext,
      coordinatedPages: new Map(),
      pageCoordinationAbsent: true,
    };
    const result = await materializeCoordinatedPages(target as any, input, context);
    expect(result.proposals).toEqual([]);
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('singleton member in cohort mode: exactly ONE proposal from its single stored row, zero Page LLM calls', async () => {
    const result = await materializeCoordinatedPages(target as any, input, materializedContext);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].productSku).toBe('SKU1');
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });

  it('PR7 review R2 (F3.3): expected-empty (pageCoordinationAbsent) — the stage abstains with the clean legacy reason, NO console.warn, zero Page LLM calls', async () => {
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => {
      warns.push(args.map(String).join(' '));
    });
    try {
      const stageContext: StageContext = {
        ...materializedContext,
        // The parent page op chose expected-empty (page target enabled but NO
        // verified pages): the coordinatedPages map is empty BY DESIGN and
        // pageCoordinationAbsent marks that — the child must NOT warn about a
        // missing parent page output.
        coordinatedPages: new Map(),
        pageCoordinationAbsent: true,
      };
      const result = await categoryPageProposalsStage.execute(input, stageContext);
      expect(result.status).toBe('abstained');
      if (result.status === 'abstained') {
        expect(result.reason).toBe('No verified store pages available. Page assignment requires a verified ShopSite Pages import.');
      }
    } finally {
      warnSpy.mockRestore();
    }
    expect(warns).toHaveLength(0);
    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.perItem).not.toHaveBeenCalled();
  });
});
