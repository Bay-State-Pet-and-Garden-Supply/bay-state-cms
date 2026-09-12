// @vitest-environment jsdom
/**
 * ReadyToExportView unit test suite.
 *
 * Verifies that the redesigned Create Drafts & Export Catalog page view:
 * 1. Shows finalized curated product titles instead of only initial upload values.
 * 2. Displays the initial upload intake comparison when the product was renamed.
 * 3. Shows product imagery and fallback when not present.
 * 4. Toggles between Cards grid view and dense Table view.
 * 5. Searches across both curated title and raw intake name.
 * 6. Opens the slide-over Product Detail Dossier drawer on inspection.
 * 7. Multi-selects and invokes createExportDrafts.
 * 8. Launches the High-Resolution Packaging Inspection & Verification Studio (PackagingInspectorModal),
 *    allowing operators to zoom into fine package print, cross-check Net Wt & formulas,
 *    and verify names with images.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReadyToExportView } from '../../client/components/onboarding/approved/ReadyToExportView';
import * as workApi from '../../client/onboarding-work-api';
import type { OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(i: number, overrides: Partial<OnboardingWorkState> = {}): OnboardingWorkState {
  return {
    itemId: `item_${i}`,
    category: 'approved',
    activity: 'approval',
    label: 'Approved for export',
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
    reviewState: 'approved',
    stage: 'promotion',
    stageStatus: 'pending',
    upc: `01780000000${i}`,
    name: `RAW_INTAKE_VALUE_${i}`,
    brand: 'Purina Pro Plan',
    sourceType: 'official_page',
    domain: 'purina.com',
    curatedTitle: `Purina Pro Plan Adult Complete Essentials Chicken & Rice Formula - ${i * 5} lb Bag`,
    imageUrl: `https://example.com/images/product-${i}.jpg`,
    description: `Premium dry dog food made with real chicken for product ${i}.`,
    weight: `${i * 5} lbs`,
    ...overrides,
  };
}

describe('ReadyToExportView (Create Drafts Redesign)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    vi.spyOn(workApi, 'getBatchWorkStateCounts').mockResolvedValue({
      processing: 0,
      needs_attention: 0,
      waiting_on_family: 0,
      ready_for_review: 0,
      approved: 1,
      ready_to_export: 1,
      completed: 1,
      skipped: 0,
    } as any);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders the finalized curated product title and initial upload intake comparison', async () => {
    const item1 = makeItem(1, {
      category: 'approved',
      name: 'PUR PRO PLN CHK 34#',
      curatedTitle: 'Purina Pro Plan Complete Essentials Adult Dry Dog Food Chicken & Rice Formula, 34 lb Bag',
      brand: 'Purina Pro Plan',
      upc: '017800109643',
    });

    vi.spyOn(workApi, 'getBatchWorkState').mockImplementation(async (_batchId, params: any): Promise<any> => {
      if (params?.category === 'approved') return { batchId: 'batch-1', counts: {} as any, items: [item1], total: 1 };
      return { batchId: 'batch-1', counts: {} as any, items: [], total: 0 };
    });

    await act(async () => {
      root.render(<ReadyToExportView batchId="batch-1" />);
    });

    // Final curated title is displayed prominently
    expect(container.textContent).toContain('Purina Pro Plan Complete Essentials Adult Dry Dog Food Chicken & Rice Formula, 34 lb Bag');

    // Initial intake value is also displayed in the comparison tag
    expect(container.textContent).toContain('PUR PRO PLN CHK 34#');
    expect(container.textContent).toContain('Intake:');

    // Product brand and UPC
    expect(container.textContent).toContain('Purina Pro Plan');
    expect(container.textContent).toContain('017800109643');

    // Image is rendered
    const img = container.querySelector('img.ow-card-thumb-img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe('https://example.com/images/product-1.jpg');
  });

  it('toggles between Cards Grid view and Data Table view', async () => {
    const item1 = makeItem(1, { category: 'approved' });

    vi.spyOn(workApi, 'getBatchWorkState').mockImplementation(async (_batchId, params: any): Promise<any> => {
      if (params?.category === 'approved') return { batchId: 'batch-1', counts: {} as any, items: [item1], total: 1 };
      return { batchId: 'batch-1', counts: {} as any, items: [], total: 0 };
    });

    await act(async () => {
      root.render(<ReadyToExportView batchId="batch-1" />);
    });

    // Default view is Cards Grid
    expect(container.querySelector('.ow-product-grid')).not.toBeNull();
    expect(container.querySelector('.ow-dense-table-wrap')).toBeNull();

    // Switch to Table view
    const tableToggleBtn = Array.from(container.querySelectorAll('.ow-view-btn')).find(
      (b) => b.textContent?.includes('Table'),
    ) as HTMLButtonElement;
    expect(tableToggleBtn).toBeDefined();

    await act(async () => {
      tableToggleBtn.click();
    });

    // Table view is now active
    expect(container.querySelector('.ow-product-grid')).toBeNull();
    expect(container.querySelector('.ow-dense-table-wrap')).not.toBeNull();
    expect(container.querySelector('.ow-dense-table')).not.toBeNull();
  });

  it('searches across both final curated title and raw intake name', async () => {
    const item1 = makeItem(1, {
      category: 'approved',
      name: 'RAW_DISTRIBUTOR_NAME_AAA',
      curatedTitle: 'Acme Super Premium Organic Dog Chow',
    });
    const item2 = makeItem(2, {
      category: 'approved',
      name: 'RAW_DISTRIBUTOR_NAME_BBB',
      curatedTitle: 'Beacon Valley Farm Fresh Cat Feast',
    });

    vi.spyOn(workApi, 'getBatchWorkState').mockImplementation(async (_batchId, params: any): Promise<any> => {
      if (params?.category === 'approved') return { batchId: 'batch-1', counts: {} as any, items: [item1, item2], total: 2 };
      return { batchId: 'batch-1', counts: {} as any, items: [], total: 0 };
    });

    await act(async () => {
      root.render(<ReadyToExportView batchId="batch-1" />);
    });

    const searchInput = container.querySelector('.ow-search-input') as HTMLInputElement;
    const setValue = (val: string) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(searchInput, val);
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Search by curated title word
    await act(async () => {
      setValue('Organic');
    });

    expect(container.textContent).toContain('Acme Super Premium Organic Dog Chow');
    expect(container.textContent).not.toContain('Beacon Valley Farm Fresh Cat Feast');

    // Search by raw intake string
    await act(async () => {
      setValue('NAME_BBB');
    });

    expect(container.textContent).not.toContain('Acme Super Premium Organic Dog Chow');
    expect(container.textContent).toContain('Beacon Valley Farm Fresh Cat Feast');
  });

  it('opens the slide-over Product Detail Dossier drawer when Inspect Draft is clicked', async () => {
    const item1 = makeItem(1, {
      category: 'approved',
      name: 'DIS_INTAKE_001',
      curatedTitle: 'Royal Canin Breed Health Nutrition German Shepherd Adult Dry Dog Food',
      description: 'Tailored nutrition created for pure breed German Shepherds over 15 months old.',
    });

    vi.spyOn(workApi, 'getBatchWorkState').mockImplementation(async (_batchId, params: any): Promise<any> => {
      if (params?.category === 'approved') return { batchId: 'batch-1', counts: {} as any, items: [item1], total: 1 };
      return { batchId: 'batch-1', counts: {} as any, items: [], total: 0 };
    });

    await act(async () => {
      root.render(<ReadyToExportView batchId="batch-1" />);
    });

    // Drawer is closed initially
    expect(container.querySelector('.ow-drawer')).toBeNull();

    // Click "Inspect Draft →"
    const inspectBtn = Array.from(container.querySelectorAll('.ow-btn-link')).find(
      (b) => b.textContent?.includes('Inspect Draft'),
    ) as HTMLButtonElement;
    expect(inspectBtn).toBeDefined();

    await act(async () => {
      inspectBtn.click();
    });

    // Drawer is now open
    const drawer = container.querySelector('.ow-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain('Product Draft Dossier');
    expect(drawer?.textContent).toContain('Listing Transformation');
    expect(drawer?.textContent).toContain('Royal Canin Breed Health Nutrition German Shepherd Adult Dry Dog Food');
    expect(drawer?.textContent).toContain('DIS_INTAKE_001');
    expect(drawer?.textContent).toContain('Tailored nutrition created for pure breed German Shepherds');

    // Close drawer
    const closeBtn = container.querySelector('.ow-drawer-close') as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });

    expect(container.querySelector('.ow-drawer')).toBeNull();
  });

  it('allows selection and calls createExportDrafts with selected item IDs', async () => {
    const item1 = makeItem(1, { category: 'approved' });
    const createDraftsMock = vi.spyOn(workApi, 'createExportDrafts').mockResolvedValue({
      createdCount: 1,
      changeSetId: 'cs-test-1234',
    } as any);

    vi.spyOn(workApi, 'getBatchWorkState').mockImplementation(async (_batchId, params: any): Promise<any> => {
      if (params?.category === 'approved') return { batchId: 'batch-1', counts: {} as any, items: [item1], total: 1 };
      return { batchId: 'batch-1', counts: {} as any, items: [], total: 0 };
    });

    await act(async () => {
      root.render(<ReadyToExportView batchId="batch-1" />);
    });

    // Select the approved item
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();

    await act(async () => {
      checkbox.click();
    });

    // Primary action button should reflect selected count
    const createBtn = Array.from(container.querySelectorAll('button.btn-primary')).find(
      (b) => b.textContent?.includes('Create ShopSite Drafts (1)'),
    ) as HTMLButtonElement;
    expect(createBtn).toBeDefined();

    await act(async () => {
      createBtn.click();
    });

    expect(createDraftsMock).toHaveBeenCalledWith('batch-1', ['item_1'], expect.any(Object));
  });

  it('opens the Packaging Verification Studio modal and provides interactive zoom & checklist', async () => {
    const item1 = makeItem(1, {
      category: 'approved',
      name: 'PRO_PLAN_CHK_34',
      curatedTitle: 'Purina Pro Plan Adult Complete Essentials Chicken & Rice Formula - 34 lb Bag',
      weight: '34 lb',
      brand: 'Purina Pro Plan',
      imageUrl: 'https://example.com/packaging-front.jpg',
    });

    vi.spyOn(workApi, 'getBatchWorkState').mockImplementation(async (_batchId, params: any): Promise<any> => {
      if (params?.category === 'approved') return { batchId: 'batch-1', counts: {} as any, items: [item1], total: 1 };
      return { batchId: 'batch-1', counts: {} as any, items: [], total: 0 };
    });

    await act(async () => {
      root.render(<ReadyToExportView batchId="batch-1" />);
    });

    // Modal is initially not open
    expect(container.querySelector('[data-testid="packaging-inspector-modal"]')).toBeNull();

    // Click "Verify Packaging" button on the card
    const verifyBtn = Array.from(container.querySelectorAll('.ow-btn-link')).find(
      (b) => b.textContent?.includes('Verify Packaging'),
    ) as HTMLButtonElement;
    expect(verifyBtn).toBeDefined();

    await act(async () => {
      verifyBtn.click();
    });

    // Packaging Verification Studio modal is now open!
    const modal = container.querySelector('[data-testid="packaging-inspector-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('Packaging Verification Studio');
    expect(modal?.textContent).toContain('Purina Pro Plan Adult Complete Essentials Chicken & Rice Formula - 34 lb Bag');
    expect(modal?.textContent).toContain('PRO_PLAN_CHK_34');
    expect(modal?.textContent).toContain('34 lb');

    // Verification checklist items are present
    expect(modal?.textContent).toContain('Brand typography');
    expect(modal?.textContent).toContain('Formula & flavor');
    expect(modal?.textContent).toContain('Net weight / package size');

    // Zoom HUD is present with initial 100%
    const hudLevel = modal?.querySelector('.ow-pi-hud-level');
    expect(hudLevel?.textContent).toBe('100%');

    // Click zoom in (+) button
    const zoomInBtn = Array.from(modal?.querySelectorAll('.ow-pi-hud-btn') ?? []).find(
      (b) => b.getAttribute('aria-label') === 'Zoom In',
    ) as HTMLButtonElement;
    expect(zoomInBtn).toBeDefined();

    await act(async () => {
      zoomInBtn.click();
    });

    // Zoom increases to 150%
    expect(modal?.querySelector('.ow-pi-hud-level')?.textContent).toBe('150%');

    // Click 1:1 Actual size button
    const actualBtn = Array.from(modal?.querySelectorAll('.ow-pi-hud-btn--text') ?? []).find(
      (b) => b.textContent?.includes('1:1 Actual'),
    ) as HTMLButtonElement;
    expect(actualBtn).toBeDefined();

    await act(async () => {
      actualBtn.click();
    });

    // Close the modal
    const closeBtn = modal?.querySelector('.ow-pi-close-btn') as HTMLButtonElement;
    expect(closeBtn).toBeDefined();

    await act(async () => {
      closeBtn.click();
    });

    expect(container.querySelector('[data-testid="packaging-inspector-modal"]')).toBeNull();
  });
});
