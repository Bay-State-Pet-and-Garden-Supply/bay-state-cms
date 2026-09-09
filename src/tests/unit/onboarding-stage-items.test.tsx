// @vitest-environment jsdom
/**
 * Slice 2 — stage/outcome item view tests.
 *
 * Server-filtered reads: every facet travels in the request URL (stage,
 * reviewState, category, q, cursor, limit 50); totals are never derived from
 * fetched-page lengths; batch/stage switches discard stale responses; cursor
 * continuation appends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// See onboarding-linear-shell.test.tsx: stub the schema const whose named-zod
// chain vite-node cannot collect; the schema itself is covered under Bun.
vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));
vi.mock('../../client/onboarding-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/onboarding-api')>();
  return { ...actual, assignItemBrand: vi.fn(), assignItemDomain: vi.fn() };
});
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import { OutcomeItemsView } from '../../client/components/onboarding/OutcomeItemsView';
import { assignItemBrand } from '../../client/onboarding-api';
import * as workApi from '../../client/onboarding-work-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    itemId: `item_${i}`,
    category: 'processing',
    activity: null,
    label: 'Working',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    variantResolution: null,
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    family: null,
    reviewState: 'unreviewed',
    stage: 'sourcing',
    stageStatus: 'pending',
    upc: `0000000000${i}`,
    name: `Product ${i}`,
    brand: 'Acme',
    sourceType: 'official_page',
    domain: 'acme.example',
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
    ...overrides,
  };
}

function healthy() {
  return { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] };
}

describe('StageItemsView (server-filtered v2 reads)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const seenUrls: string[] = [];
  let responder: (url: string) => unknown[];

  function installFetch() {
    seenUrls.length = 0;
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      seenUrls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2,
          stageVocabularyVersion: 2,
          batchId: 'b1',
          filterFingerprint: 'a'.repeat(32),
          projectionHealth: healthy(),
          items: responder(u),
          nextCursor: null,
          scannedRows: 2,
          queryCount: 3,
        }),
      } as any;
    });
  }

  async function mountStage(stage: 'route_sources' | 'review_listings' = 'route_sources') {
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage={stage} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  beforeEach(() => {
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    responder = () => [makeRow(1), makeRow(2)];
    installFetch();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('sends stage + explicit limit 50 server-side and labels scope honestly', async () => {
    await mountStage('route_sources');
    const calls = seenUrls.filter((u) => u.includes('/stage-work-state/items'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain('stage=route_sources');
    expect(calls[0]).toContain('limit=50');
    const scope = container.querySelector('[data-testid="stage-scope-label"]');
    expect(scope?.textContent).toMatch(/server-filtered/);
    // Loaded rows shown as loaded rows — never as a batch total.
    expect(scope?.textContent).toMatch(/2 loaded rows/);
    expect(scope?.textContent).not.toMatch(/total/i);
  });

  it('separates Reviewed from Unreviewed via distinct server requests (no client filtering)', async () => {
    responder = (u) => (u.includes('reviewState=reviewed') ? [makeRow(7, { reviewState: 'reviewed' })] : [makeRow(1)]);
    await mountStage('review_listings');
    const buttons = Array.from(container.querySelectorAll('[data-testid="review-facet-row"] button'));
    const reviewed = buttons.find((b) => b.textContent === 'Reviewed');
    expect(reviewed).toBeTruthy();
    await act(async () => {
      reviewed!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const calls = seenUrls.filter((u) => u.includes('/stage-work-state/items'));
    expect(calls.some((u) => u.includes('reviewState=reviewed'))).toBe(true);
  });

  it('renders an empty state (not zero counts) when the server returns no rows', async () => {
    responder = () => [];
    await mountStage('route_sources');
    expect(container.querySelector('[data-testid="stage-empty"]')).not.toBeNull();
  });
});

describe('StageItemsView route_sources inline brand assignment', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const seenUrls: string[] = [];

  function stageReads() {
    return seenUrls.filter((u) => u.includes('/stage-work-state/items'));
  }

  async function mountStage(stage: 'route_sources' | 'review_listings' = 'route_sources') {
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage={stage} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  beforeEach(() => {
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    vi.mocked(assignItemBrand).mockReset();
    vi.mocked(assignItemBrand).mockResolvedValue({ success: true } as never);
    seenUrls.length = 0;
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      seenUrls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2,
          stageVocabularyVersion: 2,
          batchId: 'b1',
          filterFingerprint: 'a'.repeat(32),
          projectionHealth: healthy(),
          items: [makeRow(1), makeRow(2)],
          nextCursor: null,
          scannedRows: 2,
          queryCount: 3,
        }),
      } as any;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('per-row brand selector commits via assignItemBrand and refreshes the stage list', async () => {
    await mountStage('route_sources');
    // No redundant per-row assign button is rendered
    expect(container.querySelector('[data-testid="stage-brand-assign-item_1"]')).toBeNull();
    // Prefilled from the server-reported brand (mirrors BrandFixRow drafts).
    const brandInput = container.querySelector('input[aria-label="Brand for Product 1"]') as HTMLInputElement;
    expect(brandInput).not.toBeNull();
    expect(brandInput.value).toBe('Acme');
    const readsBefore = stageReads().length;
    expect(readsBefore).toBeGreaterThan(0);
    await act(async () => {
      brandInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    // EXACT Step 0 BrandGateView mutation path: (itemId, brand).
    expect(assignItemBrand).toHaveBeenCalledTimes(1);
    expect(assignItemBrand).toHaveBeenCalledWith('item_1', 'Acme');
    // Refresh epoch: the stage list is re-read so counts/badges update.
    expect(stageReads().length).toBeGreaterThan(readsBefore);
  });

  it('mutation failure surfaces the error and leaves the list unrefreshed', async () => {
    vi.mocked(assignItemBrand).mockRejectedValueOnce(new Error('server refused'));
    await mountStage('route_sources');
    const readsBefore = stageReads().length;
    const brandInput = container.querySelector('input[aria-label="Brand for Product 1"]') as HTMLInputElement;
    await act(async () => {
      brandInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toContain('server refused');
    expect(stageReads().length).toBe(readsBefore);
  });

  it('other stages render no brand action (route_sources scope only)', async () => {
    await mountStage('review_listings');
    expect(container.querySelector('input[aria-label^="Brand for"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Assign brand/);
  });
});

describe('OutcomeItemsView (Completed/Skipped, no decisions)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const seenUrls: string[] = [];

  async function mountOutcome(outcome: 'completed' | 'skipped') {
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      seenUrls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2,
          stageVocabularyVersion: 2,
          batchId: 'b1',
          filterFingerprint: 'c'.repeat(32),
          projectionHealth: healthy(),
          items: [makeRow(1, { category: outcome })],
          nextCursor: null,
          scannedRows: 1,
          queryCount: 2,
        }),
      } as any;
    });
    await act(async () => {
      root.render(<OutcomeItemsView batchId="b1" outcome={outcome} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('filters Completed server-side with no export action', async () => {
    await mountOutcome('completed');
    expect(seenUrls.some((u) => u.includes('category=completed'))).toBe(true);
    expect(container.querySelector('[data-testid="outcome-items-completed"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/Create export drafts|Open Change Set/i);
  });

  it('filters Skipped server-side with no Approved destination', async () => {
    await mountOutcome('skipped');
    expect(seenUrls.some((u) => u.includes('category=skipped'))).toBe(true);
    expect(container.querySelector('[data-testid="outcome-items-skipped"]')).not.toBeNull();
    // Intentional copy states the negative outright: skipped never opens Approved.
    expect(container.textContent).toMatch(/no Approved destination/);
    // No approve affordance: no button or link offering approval, no Approved view.
    const approveControls = Array.from(container.querySelectorAll('button, a')).filter((el) =>
      /approv/i.test(el.textContent ?? ''),
    );
    expect(approveControls).toEqual([]);
    expect(container.querySelector('[data-testid="approved-view"]')).toBeNull();
  });
});
