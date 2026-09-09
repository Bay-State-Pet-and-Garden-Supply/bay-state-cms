// @vitest-environment jsdom
/**
 * Stage 1 "Identify & Route Sources" intake surface (issues #116–#119).
 *
 * UI integration seam over StageItemsView route_sources:
 * - #116 Intake KPI strip: accurate counts + click-to-filter + active-chip
 *   highlight/clear.
 * - #117 Unmapped brand resolution drawer: renders blockers, inline domain
 *   save dispatches assignBatchBrandDomain, failures keep input.
 * - #118 Enhanced bulk bar: checkboxes/select-all, live domain preview,
 *   inline quick-add, server dispatch (assignBrandGroup + optional
 *   assignBatchBrandDomain).
 * - #119 Enriched table: Missing Brand badge, Domain & Profile states
 *   (Profile Ready / Profile Required → Settings / Missing Domain +
 *   Add Domain / distributor-exempt note), Source Route badges.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));

vi.mock('../../client/onboarding-api', () => ({
  assignItemBrand: vi.fn(),
  assignItemDomain: vi.fn(),
  assignBrandGroup: vi.fn(),
  getBrandSites: vi.fn(),
  getExtractorProfiles: vi.fn(),
}));

vi.mock('../../client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import {
  assignBrandGroup,
  getBrandSites,
  getExtractorProfiles,
} from '../../client/onboarding-api';
import {
  assignBatchBrandDomain,
  getBrandDomainBlockers,
} from '../../client/onboarding-work-api';
import { resetBrandOptionsCache } from '../../client/components/onboarding/brand-combobox-logic';

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

// item_1: missing brand · item_2: Acme mapped+profile ·
// item_3: Beta unmapped (blocker) · item_4: distributor exempt
function intakeRows() {
  return [
    makeRow(1, { brand: null, domain: null }),
    makeRow(2, { brand: 'Acme', domain: 'acme.com' }),
    makeRow(3, { brand: 'Beta', domain: null }),
    makeRow(4, { brand: 'Gamma', domain: null, sourceType: 'distributor_record' }),
  ];
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Stage 1 intake surface (#116–#119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(extraProps: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage="route_sources" {...(extraProps as object)} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrandOptionsCache();
    vi.mocked(assignBrandGroup).mockResolvedValue({ success: true, preflight: {} } as never);
    vi.mocked(assignBatchBrandDomain).mockResolvedValue({ success: true, requeued: 1, blockers: [] } as never);
    vi.mocked(getBrandSites).mockResolvedValue({
      brandSites: [{ brandName: 'Acme', domain: 'acme.com' }],
      catalogBrands: ['Acme', 'Beta', 'Gamma'],
    } as never);
    vi.mocked(getExtractorProfiles).mockResolvedValue({
      extractorProfiles: [{ domain: 'acme.com' }],
    } as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({
      blockers: [
        {
          brand: 'Beta',
          blockedItemCount: 1,
          batchId: 'b1',
          itemIds: ['item_3'],
          sampleItems: [],
          existingMapping: null,
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 2,
        stageVocabularyVersion: 2,
        batchId: 'b1',
        filterFingerprint: 'a'.repeat(32),
        projectionHealth: healthy(),
        items: intakeRows(),
        nextCursor: null,
        scannedRows: 4,
        queryCount: 3,
      }),
    }) as any);
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

  it('#116 renders the KPI strip with accurate counts', async () => {
    await mount();
    const strip = container.querySelector('[data-testid="intake-kpi-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute('role')).toBe('group');
    const text = strip?.textContent ?? '';
    expect(text).toMatch(/All Products \(4\)/);
    expect(text).toMatch(/Missing Brand \(1\)/);
    expect(text).toMatch(/Missing Domain \(1\)/);
    expect(text).toMatch(/Distributor Fast-Path \(1\)/);
    expect(text).toMatch(/Ready to Route \(2\)/);
  });

  it('#116 clicking a KPI chip filters rows; clicking the active chip clears', async () => {
    await mount();
    const chip = container.querySelector('[data-testid="intake-kpi-missing-brand"]') as HTMLButtonElement;
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      chip.click();
    });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    // Only the unbranded row remains visible.
    expect(container.querySelector('[data-testid="stage-select-item_1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_2"]')).toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_3"]')).toBeNull();
    // Clicking the active chip clears the filter.
    await act(async () => {
      chip.click();
    });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="stage-select-item_2"]')).not.toBeNull();
  });

  it('#116 distributor + ready filters isolate the expected rows', async () => {
    await mount();
    const dist = container.querySelector('[data-testid="intake-kpi-distributor"]') as HTMLButtonElement;
    await act(async () => {
      dist.click();
    });
    expect(container.querySelector('[data-testid="stage-select-item_4"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_2"]')).toBeNull();
    const ready = container.querySelector('[data-testid="intake-kpi-ready"]') as HTMLButtonElement;
    await act(async () => {
      ready.click();
    });
    // Ready: Acme (mapped) + Gamma (distributor exempt).
    expect(container.querySelector('[data-testid="stage-select-item_2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_4"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_1"]')).toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_3"]')).toBeNull();
  });

  it('#116 does not cap list length at 50, draining cursors so All Products and filter counts show full 130 items', async () => {
    // Generate 130 mock rows: 50 unbranded, 80 branded with Acme
    const mockRows = Array.from({ length: 130 }, (_, i) =>
      makeRow(i + 1, {
        brand: i < 50 ? null : 'Acme',
        sourceType: 'official_page',
        domain: i < 50 ? null : 'acme.com',
      }),
    );

    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/stage-work-state/items')) {
        const urlObj = new URL(u, 'http://localhost');
        const cursor = urlObj.searchParams.get('cursor');
        let chunk: typeof mockRows;
        let nextCursor: string | null = null;
        if (!cursor) {
          chunk = mockRows.slice(0, 50);
          nextCursor = 'c_50';
        } else if (cursor === 'c_50') {
          chunk = mockRows.slice(50, 100);
          nextCursor = 'c_100';
        } else {
          chunk = mockRows.slice(100);
          nextCursor = null;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 2,
            stageVocabularyVersion: 2,
            batchId: 'b1',
            filterFingerprint: 'a'.repeat(32),
            projectionHealth: healthy(),
            items: chunk,
            nextCursor,
            scannedRows: chunk.length,
            queryCount: 3,
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2,
          stageVocabularyVersion: 2,
          batchId: 'b1',
          filterFingerprint: 'a'.repeat(32),
          projectionHealth: healthy(),
          items: [],
          nextCursor: null,
          scannedRows: 0,
          queryCount: 1,
        }),
      } as any;
    });

    await mount();
    const strip = container.querySelector('[data-testid="intake-kpi-strip"]');
    expect(strip).not.toBeNull();
    const text = strip?.textContent ?? '';
    expect(text).toMatch(/All Products \(130\)/);
    expect(text).toMatch(/Missing Brand \(50\)/);
    expect(text).toMatch(/Ready to Route \(80\)/);

    const scope = container.querySelector('[data-testid="stage-scope-label"]');
    expect(scope?.textContent).toMatch(/130 loaded rows/);
    expect(scope?.textContent).not.toMatch(/more available/);
  });

  it('#117 drawer lists the unmapped brand and saves the domain to Brand Hub', async () => {
    await mount();
    const drawer = container.querySelector('[data-testid="unmapped-brand-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toMatch(/Beta/);
    expect(drawer?.textContent).toMatch(/1 product/);
    const input = container.querySelector('[data-testid="unmapped-brand-input-Beta"]') as HTMLInputElement;
    const save = container.querySelector('[data-testid="unmapped-brand-save-Beta"]') as HTMLButtonElement;
    expect(input).not.toBeNull();
    expect(save.disabled).toBe(true);
    await act(async () => {
      setInputValue(input, 'beta.com');
    });
    await act(async () => {
      save.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(assignBatchBrandDomain).toHaveBeenCalledWith('b1', 'Beta', 'beta.com');
    // Post-save refresh: the drawer input clears and intake references
    // (blockers) are re-read from the server.
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((container.querySelector('[data-testid="unmapped-brand-input-Beta"]') as HTMLInputElement)?.value ?? '').toBe('');
  });

  it('#117 failed drawer saves keep the input and show an error', async () => {
    vi.mocked(assignBatchBrandDomain).mockRejectedValueOnce(new Error('hub refused'));
    await mount();
    const input = container.querySelector('[data-testid="unmapped-brand-input-Beta"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'beta.com');
    });
    await act(async () => {
      (container.querySelector('[data-testid="unmapped-brand-save-Beta"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const alert = container.querySelector('[data-testid="unmapped-brand-error-Beta"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('hub refused');
    // Input is preserved for retry.
    expect((container.querySelector('[data-testid="unmapped-brand-input-Beta"]') as HTMLInputElement).value).toBe('beta.com');
  });

  it('#118 bulk bar previews a mapped brand domain and assigns without a domain call', async () => {
    await mount();
    await act(async () => {
      (container.querySelector('[data-testid="stage-select-item_2"]') as HTMLInputElement).click();
    });
    const bulkInput = container.querySelector('[data-testid="stage-bulk-brand-input"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(bulkInput, 'Acme');
    });
    const preview = container.querySelector('[data-testid="stage-bulk-domain-preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toMatch(/acme\.com/);
    expect(preview?.textContent).toMatch(/Active in Brand Hub/);
    expect(preview?.textContent).toMatch(/Profile Ready/);
    await act(async () => {
      (container.querySelector('[data-testid="stage-bulk-assign"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(assignBrandGroup).toHaveBeenCalledWith('b1', ['item_2'], 'Acme');
    expect(assignBatchBrandDomain).not.toHaveBeenCalled();
  });

  it('#118 bulk bar reveals a quick-add domain input for unmapped brands and persists both', async () => {
    await mount();
    await act(async () => {
      (container.querySelector('[data-testid="stage-select-item_3"]') as HTMLInputElement).click();
    });
    await act(async () => {
      setInputValue(container.querySelector('[data-testid="stage-bulk-brand-input"]') as HTMLInputElement, 'Beta');
    });
    expect(container.querySelector('[data-testid="stage-bulk-domain-preview"]')).toBeNull();
    const domainInput = container.querySelector('[data-testid="stage-bulk-domain-input"]') as HTMLInputElement;
    expect(domainInput).not.toBeNull();
    await act(async () => {
      setInputValue(domainInput, 'beta.com');
    });
    await act(async () => {
      (container.querySelector('[data-testid="stage-bulk-assign"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(assignBrandGroup).toHaveBeenCalledWith('b1', ['item_3'], 'Beta');
    expect(assignBatchBrandDomain).toHaveBeenCalledWith('b1', 'Beta', 'beta.com');
  });

  it('#118 select-all covers filtered rows and shows the selected count', async () => {
    await mount();
    await act(async () => {
      (container.querySelector('[data-testid="stage-select-all"]') as HTMLInputElement).click();
    });
    expect(container.querySelector('[data-testid="stage-bulk-count"]')?.textContent).toMatch(/4 selected/);
    // Clear, filter to Missing Brand, then select-all covers only the
    // visible (filtered) row.
    await act(async () => {
      (container.querySelector('[data-testid="stage-select-all"]') as HTMLInputElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="intake-kpi-missing-brand"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="stage-select-all"]') as HTMLInputElement).click();
    });
    expect(container.querySelector('[data-testid="stage-bulk-count"]')?.textContent).toMatch(/1 selected/);
    expect(container.querySelector('[data-testid="stage-select-item_1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_2"]')).toBeNull();
    // Clearing the filter restores all rows.
    await act(async () => {
      (container.querySelector('[data-testid="intake-kpi-missing-brand"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="stage-select-item_2"]')).not.toBeNull();
  });

  it('#119 rows show brand, domain/profile, and source-route states', async () => {
    await mount();
    // Missing brand badge on the unbranded row.
    const missing = container.querySelector('[data-testid="intake-missing-brand-item_1"]');
    expect(missing).not.toBeNull();
    expect(missing?.textContent).toMatch(/Missing Brand/);
    // Acme: domain + Profile Ready.
    expect(container.querySelector('[data-testid="intake-domain-item_2"]')?.textContent).toMatch(/acme\.com/);
    expect(container.querySelector('[data-testid="intake-profile-ready-item_2"]')).not.toBeNull();
    // Beta: Missing Domain + quick-add trigger.
    expect(container.querySelector('[data-testid="intake-missing-domain-item_3"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="intake-add-domain-item_3"]')).not.toBeNull();
    // Gamma: distributor-exempt note, no domain chase.
    expect(container.querySelector('[data-testid="intake-domain-item_4"]')?.textContent).toMatch(/Distributor record/);
    // Source routes.
    expect(container.querySelector('[data-testid="intake-route-item_1"]')?.textContent).toMatch(/Needs Brand\/Domain/);
    expect(container.querySelector('[data-testid="intake-route-item_2"]')?.textContent).toMatch(/Official Site Discovery/);
    expect(container.querySelector('[data-testid="intake-route-item_3"]')?.textContent).toMatch(/Needs Brand\/Domain/);
    expect(container.querySelector('[data-testid="intake-route-item_4"]')?.textContent).toMatch(/Distributor Fast-Path/);
  });

  it('#119 Profile Required links to Settings and Add Domain saves inline', async () => {
    // Drop the acme.com profile so the row reports Profile Required.
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    const onOpenSettings = vi.fn();
    await mount({ onOpenSettings });
    const required = container.querySelector('[data-testid="intake-profile-required-item_2"]') as HTMLButtonElement;
    expect(required).not.toBeNull();
    expect(required.textContent).toMatch(/Profile Required/);
    await act(async () => {
      required.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // Inline + Add Domain on the Beta row.
    await act(async () => {
      (container.querySelector('[data-testid="intake-add-domain-item_3"]') as HTMLButtonElement).click();
    });
    const rowInput = container.querySelector('[data-testid="intake-domain-input-item_3"]') as HTMLInputElement;
    expect(rowInput).not.toBeNull();
    await act(async () => {
      setInputValue(rowInput, 'beta.com');
    });
    await act(async () => {
      (container.querySelector('[data-testid="intake-domain-save-item_3"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(assignBatchBrandDomain).toHaveBeenCalledWith('b1', 'Beta', 'beta.com');
  });

  it('does not display Create new brand for items with existing brands, and syncs item brands into brand pool', async () => {
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 2,
        stageVocabularyVersion: 2,
        batchId: 'b1',
        filterFingerprint: 'a'.repeat(32),
        projectionHealth: healthy(),
        items: [
          makeRow(1, { brand: 'Delta', domain: 'delta.com' }),
          makeRow(2, { brand: 'Acme', domain: 'acme.com' }),
        ],
        nextCursor: null,
        scannedRows: 2,
        queryCount: 1,
      }),
    }) as any);

    await mount();

    // Neither item_1 nor item_2 should show a "Create new brand" nudge
    const input1 = container.querySelector('[data-testid="stage-brand-input-item_1"]') as HTMLInputElement;
    const input2 = container.querySelector('[data-testid="stage-brand-input-item_2"]') as HTMLInputElement;
    expect(input1?.value).toBe('Delta');
    expect(input2?.value).toBe('Acme');
    expect(container.querySelectorAll('[data-testid="brand-combobox-new-nudge"]')).toHaveLength(0);
  });
});

