// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/onboarding-api', () => ({
  getBatchPreflight: vi.fn(),
  startBatch: vi.fn(),
  assignBrandGroup: vi.fn(),
  configureBrand: vi.fn(),
  savePreflightDraft: vi.fn(),
}));

import { BatchPreflightModal } from '@/client/components/onboarding/preflight/BatchPreflightModal';
import {
  getBatchPreflight,
  startBatch,
  assignBrandGroup,
  savePreflightDraft,
} from '@/client/onboarding-api';

describe('BatchPreflightModal Component', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  const mockPreflightData = {
    batchId: 'batch-test-123',
    batchName: 'Weekly Pet Food Catalog',
    executionState: 'draft' as const,
    totalItems: 10,
    readyCount: 6,
    heldCount: 4,
    readyItemIds: ['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6'],
    heldItemIds: ['item-7', 'item-8', 'item-9', 'item-10'],
    metrics: {
      brandResolvedCount: 6,
      brandResolvedPercent: 60,
      ambiguousBrandCount: 2,
      missingBrandCount: 2,
      domainMappedCount: 6,
      domainMappedPercent: 60,
      missingDomainBrandCount: 1,
      distributorRoutedCount: 6,
      distributorRoutedPercent: 60,
      unroutedBrandCount: 1,
    },
    blockers: {
      needsBrandGroups: [
        {
          key: 'suggested:three dog bakery',
          suggestedBrand: 'Three Dog Bakery',
          itemCount: 4,
          itemIds: ['item-7', 'item-8', 'item-9', 'item-10'],
          sampleProductNames: ['THREE DOG BAKERY PET-ZEL BITES 24OZ', 'THREE DOG BAKERY CINNAMUT CRUNCH 25OZ'],
          sampleProducts: [
            { id: 'item-7', name: 'THREE DOG BAKERY PET-ZEL BITES 24OZ', upc: '012345678901' },
            { id: 'item-8', name: 'THREE DOG BAKERY CINNAMUT CRUNCH 25OZ', upc: '012345678902' },
          ],
        },
      ],
      missingDomainBrands: [
        {
          brand: 'CustomBrandX',
          itemCount: 2,
          itemIds: ['item-1', 'item-2'],
          sampleProductNames: ['CUSTOM BRAND X PREMIUM BARK 50LB'],
          sampleProducts: [
            { id: 'item-1', name: 'CUSTOM BRAND X PREMIUM BARK 50LB', upc: '099988877766' },
          ],
        },
      ],
      unroutedBrands: [
        {
          brand: 'CustomBrandX',
          itemCount: 2,
          itemIds: ['item-1', 'item-2'],
          preferredDistributorIds: [],
          sourcingPolicy: 'preferred_then_fallback' as const,
        },
      ],
    },
    availableDistributors: [
      { id: 'dist-1', distributorId: 'phillips', connectorType: 'api', enabled: true },
      { id: 'dist-2', distributorId: 'bci', connectorType: 'api', enabled: true },
    ],
    knownBrands: ['Acana', 'Better Bone', 'Churu', 'Fromm', 'Three Dog Bakery'],
  };

  it('renders preflight readiness metrics and brand blockers with proper Title Case styling and UPCs', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Batch Preflight & Execution Review');
    expect(container.textContent).toContain('Weekly Pet Food Catalog');
    expect(container.textContent).toContain('6 of 10 products ready to run');
    expect(container.textContent).toContain('Needs Brand Assignment');
    expect(container.textContent).toContain('Three Dog Bakery');
    expect(container.textContent).toContain('4 products');
    expect(container.textContent).toContain('UPC: 012345678901');
    expect(container.textContent).toContain('THREE DOG BAKERY PET-ZEL BITES 24OZ');
    expect(container.textContent).toContain('Missing Official Domain');
    expect(container.textContent).toContain('CustomBrandX');
    expect(container.textContent).toContain('UPC: 099988877766');
    expect(container.textContent).toContain('CUSTOM BRAND X PREMIUM BARK 50LB');
    expect(container.textContent).toContain('Search Google ↗');
  });

  it('provides brand autocomplete and quick-pick chips for existing brands', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);
    vi.mocked(assignBrandGroup).mockResolvedValueOnce({
      success: true,
      preflight: {
        ...mockPreflightData,
        readyCount: 10,
        heldCount: 0,
        blockers: {
          ...mockPreflightData.blockers,
          needsBrandGroups: [],
        },
      },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
        />
      );
    });

    // Check quick pick chip is present
    const quickPickChip = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Three Dog Bakery')
    );
    expect(quickPickChip).toBeTruthy();

    // Click assign button
    const assignBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Assign all 4')
    );
    expect(assignBtn).toBeTruthy();

    await act(async () => {
      assignBtn?.click();
    });

    expect(assignBrandGroup).toHaveBeenCalledWith(
      'batch-test-123',
      ['item-7', 'item-8', 'item-9', 'item-10'],
      'Three Dog Bakery'
    );
  });

  it('triggers startBatch when starting ready products', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);
    vi.mocked(startBatch).mockResolvedValueOnce({
      success: true,
      executionState: 'running',
      preflight: mockPreflightData,
    });

    const onBatchStarted = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
          onBatchStarted={onBatchStarted}
        />
      );
    });

    const startBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Start 6 Ready Products')
    );
    expect(startBtn).toBeTruthy();

    await act(async () => {
      startBtn?.click();
    });

    expect(startBatch).toHaveBeenCalledWith('batch-test-123', 'ready_only');
  });

  it('saves all pending distributor selections, domains, and brand assignments on Save Draft & Close', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);
    vi.mocked(savePreflightDraft).mockResolvedValueOnce({
      success: true,
      preflight: mockPreflightData,
    });

    const onClose = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={onClose}
        />
      );
    });

    const saveDraftBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Save Draft & Close')
    );
    expect(saveDraftBtn).toBeTruthy();

    await act(async () => {
      saveDraftBtn?.click();
    });

    expect(savePreflightDraft).toHaveBeenCalledWith(
      'batch-test-123',
      expect.objectContaining({
        brandConfigs: expect.arrayContaining([
          expect.objectContaining({
            brand: 'CustomBrandX',
          }),
        ]),
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('automatically parses a pasted product page URL into a clean domain', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);
    vi.mocked(savePreflightDraft).mockResolvedValueOnce({
      success: true,
      preflight: mockPreflightData,
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
        />
      );
    });

    const domainInput = container.querySelector(
      'input[placeholder*="Paste URL or domain"]'
    ) as HTMLInputElement;
    expect(domainInput).toBeTruthy();

    const patternInput = container.querySelector(
      'input[placeholder*="/brand-product/"]'
    ) as HTMLInputElement;
    expect(patternInput).toBeTruthy();

    await act(async () => {
      // Simulate pasting a full regional product page link with subpath
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      nativeInputValueSetter?.call(domainInput, 'https://companyofanimals.com/us/brand-product/baskerville-ultra-muzzle/');
      domainInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(domainInput.value).toBe('companyofanimals.com');
    expect(patternInput.value).toBe('/brand-product/');

    // Test editing pattern directly
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      nativeInputValueSetter?.call(patternInput, '/custom-products/');
      patternInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(patternInput.value).toBe('/custom-products/');
  });

  it('renders a navigation-only link to the unified Brand setup view when the callback is provided', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
          onOpenBrandSetup={vi.fn()}
        />
      );
    });

    const link = container.querySelector('[data-testid="preflight-open-brand-setup"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Brand setup view');
  });

  it('omits the Brand setup link when no navigation callback is provided', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
        />
      );
    });

    expect(container.querySelector('[data-testid="preflight-open-brand-setup"]')).toBeNull();
  });

  it('the Brand setup link navigates only — it never starts the batch or saves a draft', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce(mockPreflightData);

    const onOpenBrandSetup = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BatchPreflightModal
          batchId="batch-test-123"
          isOpen={true}
          onClose={vi.fn()}
          onOpenBrandSetup={onOpenBrandSetup}
        />
      );
    });

    const link = container.querySelector('[data-testid="preflight-open-brand-setup"]') as HTMLButtonElement;
    expect(link).not.toBeNull();
    await act(async () => {
      link.click();
    });

    expect(onOpenBrandSetup).toHaveBeenCalledTimes(1);
    expect(startBatch).not.toHaveBeenCalled();
    expect(savePreflightDraft).not.toHaveBeenCalled();
  });
});
