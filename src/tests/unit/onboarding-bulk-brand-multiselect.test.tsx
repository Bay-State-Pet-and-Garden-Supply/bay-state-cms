// @vitest-environment jsdom
/**
 * UI-only slice: route_sources checkbox multiselect → existing
 * assignBrandGroup endpoint.
 *
 * Pins:
 * - multiselect-to-group-endpoint wiring (batchId, itemIds, brand)
 * - refresh-epoch reload on bulk success (stage list re-read)
 * - route_sources scope (no multiselect affordance on other stages)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));

vi.mock('../../client/onboarding-api', () => ({
  assignItemBrand: vi.fn(),
  assignItemDomain: vi.fn(),
  assignBrandGroup: vi.fn(),
}));

vi.mock('../../client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import { assignBrandGroup, assignItemBrand } from '../../client/onboarding-api';

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
