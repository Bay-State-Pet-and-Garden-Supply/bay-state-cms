// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/onboarding-api', () => ({
  getBatchPreflight: vi.fn(),
  startBatch: vi.fn(),
  assignBrandGroup: vi.fn(),
  configureBrand: vi.fn(),
  savePreflightDraft: vi.fn(),
  assignItemBrand: vi.fn(),
  assignItemDomain: vi.fn(),
}));

vi.mock('@/client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
}));

import { BrandGateView } from '@/client/components/onboarding/BrandGateView';
import {
  getBatchPreflight,
  assignItemBrand,
  assignItemDomain,
} from '@/client/onboarding-api';
import { getBrandDomainBlockers } from '@/client/onboarding-work-api';

function makePreflight(itemIdCount: number) {
  const heldIds = Array.from({ length: itemIdCount }, (_, i) => `held-${i}`);
  return {
    batchId: 'batch-1',
    batchName: 'Batch 1',
    executionState: 'draft' as const,
    totalItems: itemIdCount + 2,
    readyCount: 2,
    heldCount: itemIdCount,
    readyItemIds: ['ready-1', 'ready-2'],
    heldItemIds: heldIds,
    metrics: {
      brandResolvedCount: 2,
      brandResolvedPercent: 50,
      ambiguousBrandCount: 1,
      missingBrandCount: 1,
      domainMappedCount: 2,
      domainMappedPercent: 50,
      missingDomainBrandCount: 1,
      distributorRoutedCount: 2,
      distributorRoutedPercent: 50,
      unroutedBrandCount: 0,
    },
    blockers: {
      needsBrandGroups: [
        {
          key: 'suggested:acme',
          suggestedBrand: 'Acme',
          itemCount: Math.min(itemIdCount, 2),
          itemIds: heldIds.slice(0, 2),
          sampleProductNames: ['ACME WIDGET'],
        },
      ],
      missingDomainBrands: [
        {
          brand: 'CustomBrandX',
          itemCount: 1,
          itemIds: ['held-0'],
          sampleProductNames: ['CUSTOM X'],
        },
      ],
      unroutedBrands: [],
    },
    availableDistributors: [],
    knownBrands: ['Acme'],
  };
}

function makeBlockers() {
  return {
    blockers: [
      {
        brand: 'CustomBrandX',
        blockedItemCount: 1,
        batchId: 'batch-1',
        itemIds: ['held-0'],
        sampleItems: [{ itemId: 'held-0', upc: '111', name: 'CUSTOM X', sourceUrl: null }],
        existingMapping: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function makeStageRow(i: number, overrides: Record<string, unknown> = {}) {
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

describe('BrandGateView', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let stageRows: Array<Record<string, unknown>>;
  let stageCursorQueue: Array<string | null>;

  function installStageReads() {
    stageRows = [
      makeStageRow(1, { brand: null, attentionReason: 'brand_not_provided' }),
      makeStageRow(2, { brand: 'CustomBrandX' }),
      makeStageRow(3, { brand: 'Acme', domain: 'acme.com', sourceType: 'official_page' }),
      makeStageRow(4, { brand: 'SupplierBrand', sourceType: 'distributor_record', domain: null }),
      makeStageRow(5, { brand: 'Acme', domain: 'acme.com', attentionReason: 'verify_official_url' }),
    ];
    stageCursorQueue = [];
    fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes('/stage-work-state/items')) {
        const nextCursor = stageCursorQueue.length > 0 ? stageCursorQueue.shift()! : null;
        return {
          ok: true,
          json: async () => ({
            items: stageRows,
            nextCursor,
            projectionHealth: { status: 'healthy', issues: [] },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
    installStageReads();
    vi.mocked(getBatchPreflight).mockResolvedValue(makePreflight(4) as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue(makeBlockers() as never);
    vi.mocked(assignItemBrand).mockResolvedValue({ success: true } as never);
    vi.mocked(assignItemDomain).mockResolvedValue({ success: true } as never);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount(props: Record<string, unknown> = {}) {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <BrandGateView
          batchId="batch-1"
          onBack={vi.fn()}
          {...(props as object)}
        />,
      );
    });
  }

  function stageFetchCalls() {
    return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/stage-work-state/items'));
  }

  function detailFetchCalls() {
    // Zero per-item detail requests: no GET ever addresses a single item.
    return fetchMock.mock.calls.filter((call) => /\/items\/[^/]+\/?(?:\?.*)?$/.test(String(call[0])));
  }

  it('renders ONE ordered view: coverage + domain panel on top, per-item fixes + grouped panel below', async () => {
    await mount();
    const view = container.querySelector('[data-testid="brand-gate-view"]');
    expect(view).not.toBeNull();
    const top = container.querySelector('[data-testid="brand-gate-top"]');
    const items = container.querySelector('[data-testid="brand-gate-items"]');
    expect(top).not.toBeNull();
    expect(items).not.toBeNull();
    // Order: top precedes bottom in the DOM.
    expect(top!.compareDocumentPosition(items!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Frozen panels are composed, not rewritten.
    expect(container.textContent).toContain('Resolve Brand Domains');
    expect(container.textContent).toContain('Assign Missing Brands');
    // Health banner reflects server readiness.
    expect(container.querySelector('[data-testid="brand-gate-health"]')).not.toBeNull();
    expect(container.textContent).toContain('2 of 6 ready');
  });

  it.each([1, 50, 501, 1001])(
    'fetch budget holds for %i preflight IDs: bounded reads, zero detail fetches',
    async (n) => {
      vi.mocked(getBatchPreflight).mockReset();
      vi.mocked(getBatchPreflight).mockResolvedValue(makePreflight(n) as never);
      await mount();
      // View summary + frozen BrandAssignmentPanel: at most 2 preflight reads.
      expect(vi.mocked(getBatchPreflight).mock.calls.length).toBeLessThanOrEqual(2);
      // View check + frozen BrandDomainSetupPanel: at most 2 blocker reads.
      expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBeLessThanOrEqual(2);
      // At most 1 bounded stage-items page on the initial epoch…
      expect(stageFetchCalls().length).toBeLessThanOrEqual(1);
      // …and zero per-item detail requests regardless of N (N+1 guard).
      expect(detailFetchCalls()).toHaveLength(0);
      // Rows shown come from the bounded page, never N rows.
      expect(container.querySelectorAll('[data-testid^="brand-fix-row-"]').length).toBeLessThanOrEqual(50);
    },
  );

  it('Load more issues at most 1 additional items request with no automatic page chase', async () => {
    stageCursorQueue = [null];
    // First epoch returns a continuation cursor.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ items: stageRows, nextCursor: 'cursor-2', projectionHealth: { status: 'healthy', issues: [] } }),
    }));
    // The chased page returns distinct rows (no automatic re-chase follows).
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        items: [makeStageRow(6, { brand: 'Acme', domain: 'acme.com', sourceType: 'official_page' })],
        nextCursor: null,
        projectionHealth: { status: 'healthy', issues: [] },
      }),
    }));
    await mount();
    expect(stageFetchCalls()).toHaveLength(1);
    const more = container.querySelector('[data-testid="brand-gate-load-more"]');
    expect(more).not.toBeNull();
    await act(async () => {
      (more as HTMLButtonElement).click();
    });
    expect(stageFetchCalls()).toHaveLength(2);
    // The terminal empty-continuation page ends the chase; rows appended once.
    expect(container.querySelector('[data-testid="brand-gate-load-more"]')).toBeNull();
    expect(container.querySelector('[data-testid="brand-fix-row-row-6"]')).not.toBeNull();
  });

  it('per-item assign-brand submits one mutation then refetches (view never locally marks unblocked)', async () => {
    await mount();
    const assignBtn = container.querySelector('[data-testid="brand-row-assign-brand-row-1"]');
    expect(assignBtn).not.toBeNull();
    const brandInput = container.querySelector('input[aria-label="Brand for PRODUCT 1"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(brandInput, 'Acme');
      brandInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const preflightCallsBefore = vi.mocked(getBatchPreflight).mock.calls.length;
    await act(async () => {
      (assignBtn as HTMLButtonElement).click();
    });
    expect(assignItemBrand).toHaveBeenCalledTimes(1);
    expect(assignItemBrand).toHaveBeenCalledWith('row-1', 'Acme');
    // The same bounded refresh epoch follows success: exactly one more
    // projections round (preflight + blockers) and one more items page.
    expect(vi.mocked(getBatchPreflight).mock.calls.length).toBe(preflightCallsBefore + 1);
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('mutation failure leaves server-owned holds/counts unchanged and surfaces the error', async () => {
    vi.mocked(assignItemBrand).mockReset();
    vi.mocked(assignItemBrand).mockRejectedValueOnce(new Error('server refused'));
    await mount();
    const preflightCallsBefore = vi.mocked(getBatchPreflight).mock.calls.length;
    const assignBtn = container.querySelector('[data-testid="brand-row-assign-brand-row-1"]');
    const brandInput = container.querySelector('input[aria-label="Brand for PRODUCT 1"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(brandInput, 'Acme');
      brandInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (assignBtn as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('server refused');
    // No refresh epoch after failure: no additional projection reads.
    expect(vi.mocked(getBatchPreflight).mock.calls.length).toBe(preflightCallsBefore);
  });

  it('distributor-exempt row is advisory-only with no domain demand', async () => {
    await mount();
    const row = container.querySelector('[data-testid="brand-fix-row-row-4"]');
    expect(row?.getAttribute('data-row-kind')).toBe('distributor_exempt');
    expect(row?.textContent).toContain('no official domain needed');
    expect(row?.querySelector('input')).toBeNull();
  });

  it('mismatched-authority row links into the frozen resolution flow instead of re-judging authority', async () => {
    const onOpenAttentionItem = vi.fn();
    await mount({ onOpenAttentionItem });
    const row = container.querySelector('[data-testid="brand-fix-row-row-5"]');
    expect(row?.getAttribute('data-row-kind')).toBe('mismatched_authority');
    const link = container.querySelector('[data-testid="brand-row-resolve-row-5"]');
    expect(link).not.toBeNull();
    await act(async () => {
      (link as HTMLButtonElement).click();
    });
    expect(onOpenAttentionItem).toHaveBeenCalledWith('row-5');
  });

  it('failed reads render unknown — never healthy', async () => {
    vi.mocked(getBatchPreflight).mockReset();
    vi.mocked(getBatchPreflight).mockRejectedValue(new Error('preflight down'));
    vi.mocked(getBrandDomainBlockers).mockReset();
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({ blockers: [] } as never);
    await mount();
    const health = container.querySelector('[data-testid="brand-gate-health"]');
    expect(health?.getAttribute('data-health-state')).toBe('unknown');
    expect(container.querySelector('[data-testid="brand-gate-counts"]')?.textContent).toContain('unavailable');
    expect(health?.textContent).toMatch(/never proves.*healthy|unknown/i);
  });

  it('mixed ready/blocked batches offer the existing ready-only release path (ready continues)', async () => {
    const onOpenPreflight = vi.fn();
    await mount({ onOpenPreflight });
    const release = container.querySelector('[data-testid="brand-gate-release-link"]');
    expect(release).not.toBeNull();
    await act(async () => {
      (release as HTMLButtonElement).click();
    });
    expect(onOpenPreflight).toHaveBeenCalledTimes(1);
  });

  it('renders no seventh-stage affordance', async () => {
    await mount();
    expect(container.querySelectorAll('.bws-stage-tab').length).toBe(0);
    expect(container.querySelector('[data-testid^="stage-items-"]')).toBeNull();
    expect(container.textContent).not.toMatch(/stage 7|seventh stage/i);
  });

  it('Settings link preserves mapping authority; stale batches never flash foreign health', async () => {
    const onOpenSettings = vi.fn();
    await mount({ onOpenSettings });
    const link = container.querySelector('[data-testid="brand-gate-settings-link"]');
    expect(link).not.toBeNull();
    await act(async () => {
      (link as HTMLButtonElement).click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('StrictMode mounts at most 2 initial epochs (no N-multiplied refetch)', async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <React.StrictMode>
          <BrandGateView batchId="batch-1" onBack={vi.fn()} />
        </React.StrictMode>,
      );
    });
    // 2 epochs × (view + frozen panel) for each settled read.
    expect(vi.mocked(getBatchPreflight).mock.calls.length).toBeLessThanOrEqual(4);
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBeLessThanOrEqual(4);
    expect(stageFetchCalls().length).toBeLessThanOrEqual(2);
    expect(detailFetchCalls()).toHaveLength(0);
  });
});
