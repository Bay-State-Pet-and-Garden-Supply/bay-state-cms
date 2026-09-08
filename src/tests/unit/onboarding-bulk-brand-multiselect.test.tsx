// @vitest-environment jsdom
/**
 * UI-only slice: route_sources checkbox multiselect → existing
 * assignBrandGroup endpoint, plus mapped_official override affordance.
 *
 * Pins:
 * - multiselect-to-group-endpoint wiring (batchId, itemIds, brand)
 * - refresh-epoch reload on bulk success (stage list re-read)
 * - route_sources scope (no multiselect affordance on other stages)
 * - Step 0 mapped_official rows expose an editable brand input over the
 *   existing runRowMutation path with the role=alert server-error pattern
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));

vi.mock('../../client/onboarding-api', () => ({
  assignItemBrand: vi.fn(),
  assignItemDomain: vi.fn(),
  assignBrandGroup: vi.fn(),
  getBatchPreflight: vi.fn(),
}));

vi.mock('../../client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import { BrandGateView } from '../../client/components/onboarding/BrandGateView';
import { assignBrandGroup, assignItemBrand, getBatchPreflight } from '../../client/onboarding-api';
import { getBrandDomainBlockers } from '../../client/onboarding-work-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function healthy() {
  return { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] };
}

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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('StageItemsView route_sources multiselect bulk assign', () => {
  let container: HTMLDivElement;
  let root: Root;
  let seenUrls: string[];

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
    vi.clearAllMocks();
    vi.mocked(assignItemBrand).mockResolvedValue({ success: true } as never);
    vi.mocked(assignBrandGroup).mockResolvedValue({ success: true, preflight: {} } as never);
    seenUrls = [];
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      seenUrls.push(String(url));
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

  it('per-row checkboxes + bulk bar call assignBrandGroup(batchId, itemIds, brand)', async () => {
    await mountStage('route_sources');
    const rowBox = container.querySelector('[data-testid="stage-select-item_1"]') as HTMLInputElement;
    const bulkBar = container.querySelector('[data-testid="stage-bulk-bar"]');
    const bulkInput = container.querySelector('[data-testid="stage-bulk-brand-input"]') as HTMLInputElement;
    const bulkBtn = container.querySelector('[data-testid="stage-bulk-assign"]') as HTMLButtonElement;
    expect(rowBox).not.toBeNull();
    expect(bulkBar).not.toBeNull();
    expect(bulkInput).not.toBeNull();
    expect(bulkBtn).not.toBeNull();
    // No selection yet: action disabled, count copy honest.
    expect(container.querySelector('[data-testid="stage-bulk-count"]')?.textContent).toMatch(/No rows selected/);
    expect(bulkBtn.disabled).toBe(true);

    await act(async () => {
      rowBox.click();
    });
    expect(container.querySelector('[data-testid="stage-bulk-count"]')?.textContent).toMatch(/1 selected/);
    await act(async () => {
      setInputValue(bulkInput, 'Acme');
    });
    await act(async () => {
      bulkBtn.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(assignBrandGroup).toHaveBeenCalledTimes(1);
    expect(assignBrandGroup).toHaveBeenCalledWith('b1', ['item_1'], 'Acme');
  });

  it('bulk success triggers the refresh-epoch stage list reload', async () => {
    await mountStage('route_sources');
    const readsBefore = stageReads().length;
    expect(readsBefore).toBeGreaterThan(0);
    const rowBox = container.querySelector('[data-testid="stage-select-item_2"]') as HTMLInputElement;
    const bulkInput = container.querySelector('[data-testid="stage-bulk-brand-input"]') as HTMLInputElement;
    const bulkBtn = container.querySelector('[data-testid="stage-bulk-assign"]') as HTMLButtonElement;
    await act(async () => {
      rowBox.click();
    });
    await act(async () => {
      setInputValue(bulkInput, 'Acme');
    });
    await act(async () => {
      bulkBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(stageReads().length).toBeGreaterThan(readsBefore);
    // Selection clears after the epoch; no stale checked boxes.
    expect(container.querySelector('[data-testid="stage-bulk-count"]')?.textContent).toMatch(/No rows selected/);
  });

  it('bulk failure surfaces a role=alert error and leaves the list unrefreshed', async () => {
    vi.mocked(assignBrandGroup).mockRejectedValueOnce(new Error('group refused'));
    await mountStage('route_sources');
    const readsBefore = stageReads().length;
    const rowBox = container.querySelector('[data-testid="stage-select-item_1"]') as HTMLInputElement;
    const bulkInput = container.querySelector('[data-testid="stage-bulk-brand-input"]') as HTMLInputElement;
    const bulkBtn = container.querySelector('[data-testid="stage-bulk-assign"]') as HTMLButtonElement;
    await act(async () => {
      rowBox.click();
    });
    await act(async () => {
      setInputValue(bulkInput, 'Acme');
    });
    await act(async () => {
      bulkBtn.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const alert = container.querySelector('[data-testid="stage-bulk-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('group refused');
    expect(stageReads().length).toBe(readsBefore);
  });

  it('multiselect is route_sources-scoped: other stages render no bulk affordance', async () => {
    await mountStage('review_listings');
    expect(container.querySelector('[data-testid="stage-bulk-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="stage-bulk-assign"]')).toBeNull();
    expect(container.querySelector('[data-testid^="stage-select-"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Assign to selected/);
  });
});

describe('BrandGateView mapped_official override affordance', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  function stageRow(i: number, overrides: Record<string, unknown> = {}) {
    return {
      itemId: `row-${i}`,
      category: 'needs_attention',
      activity: null,
      label: 'Needs attention',
      detail: null,
      attentionReason: null,
      attentionAction: null,
      stage: 'sourcing',
      stageStatus: 'pending',
      upc: `000000000${i}`,
      name: `PRODUCT ${i}`,
      brand: null,
      sourceType: null,
      domain: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
    vi.mocked(getBatchPreflight).mockResolvedValue({
      batchId: 'batch-1',
      batchName: 'Batch 1',
      executionState: 'draft',
      totalItems: 3,
      readyCount: 2,
      heldCount: 1,
      readyItemIds: ['ready-1', 'ready-2'],
      heldItemIds: ['held-0'],
      metrics: {},
      blockers: { needsBrandGroups: [], missingDomainBrands: [], unroutedBrands: [] },
      availableDistributors: [],
      knownBrands: ['Acme'],
    } as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({ blockers: [] } as never);
    vi.mocked(assignItemBrand).mockResolvedValue({ success: true } as never);
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        // row-3 classifies mapped_official: brand + domain, no blocker lists.
        items: [
          stageRow(3, { brand: 'Acme', domain: 'acme.com', sourceType: 'official_page' }),
        ],
        nextCursor: null,
        projectionHealth: healthy(),
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    root = createRoot(container);
    await act(async () => {
      root!.render(<BrandGateView batchId="batch-1" onBack={vi.fn()} />);
    });
  }

  it('mapped_official row keeps its advisory copy and offers an editable brand override over runRowMutation', async () => {
    await mount();
    const row = container.querySelector('[data-testid="brand-fix-row-row-3"]');
    expect(row?.getAttribute('data-row-kind')).toBe('mapped_official');
    expect(row?.textContent).toContain('No action needed.');
    const input = row?.querySelector('input[aria-label="Brand for PRODUCT 3"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Acme');
    const assignBtn = container.querySelector('[data-testid="brand-row-assign-brand-row-3"]') as HTMLButtonElement;
    expect(assignBtn).not.toBeNull();
    const preflightBefore = vi.mocked(getBatchPreflight).mock.calls.length;
    await act(async () => {
      assignBtn.click();
    });
    expect(assignItemBrand).toHaveBeenCalledTimes(1);
    expect(assignItemBrand).toHaveBeenCalledWith('row-3', 'Acme');
    expect(vi.mocked(getBatchPreflight).mock.calls.length).toBe(preflightBefore + 1);
  });

  it('override failure surfaces the existing role=alert server-error pattern', async () => {
    vi.mocked(assignItemBrand).mockRejectedValueOnce(new Error('server still rejects'));
    await mount();
    const assignBtn = container.querySelector('[data-testid="brand-row-assign-brand-row-3"]') as HTMLButtonElement;
    await act(async () => {
      assignBtn.click();
    });
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.some((a) => a.textContent?.includes('server still rejects'))).toBe(true);
  });
});
