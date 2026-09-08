// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/onboarding-api', () => ({
  getBatchPreflight: vi.fn(),
  assignBrandGroup: vi.fn(),
}));

import { BrandAssignmentPanel } from '../../client/components/onboarding/attention/BrandAssignmentPanel';
import { getBatchPreflight, assignBrandGroup } from '../../client/onboarding-api';

describe('BrandAssignmentPanel', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  it('renders nothing when no items need brands', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce({
      batchId: 'b1',
      batchName: 'Batch 1',
      executionState: 'running',
      totalItems: 5,
      readyCount: 5,
      heldCount: 0,
      readyItemIds: ['i1', 'i2', 'i3', 'i4', 'i5'],
      heldItemIds: [],
      metrics: {
        brandResolvedCount: 5,
        brandResolvedPercent: 100,
        ambiguousBrandCount: 0,
        missingBrandCount: 0,
        domainMappedCount: 5,
        domainMappedPercent: 100,
        missingDomainBrandCount: 0,
        distributorRoutedCount: 5,
        distributorRoutedPercent: 100,
        unroutedBrandCount: 0,
      },
      blockers: {
        needsBrandGroups: [],
        missingDomainBrands: [],
        unroutedBrands: [],
      },
      availableDistributors: [],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<BrandAssignmentPanel batchId="b1" />);
    });

    expect(container.innerHTML).toBe('');
  });

  it('renders brand assignment cluster cards with sample items and direct assign button', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValueOnce({
      batchId: 'b1',
      batchName: 'Batch 1',
      executionState: 'draft',
      totalItems: 4,
      readyCount: 1,
      heldCount: 3,
      readyItemIds: ['i1'],
      heldItemIds: ['i2', 'i3', 'i4'],
      metrics: {
        brandResolvedCount: 1,
        brandResolvedPercent: 25,
        ambiguousBrandCount: 0,
        missingBrandCount: 3,
        domainMappedCount: 1,
        domainMappedPercent: 25,
        missingDomainBrandCount: 0,
        distributorRoutedCount: 1,
        distributorRoutedPercent: 25,
        unroutedBrandCount: 0,
      },
      blockers: {
        needsBrandGroups: [
          {
            key: 'suggested:ACANA',
            suggestedBrand: 'ACANA',
            itemCount: 2,
            itemIds: ['i2', 'i3'],
            sampleProductNames: ['Acana Wild Prairie 25lb', 'Acana Meadowland 15lb'],
          },
          {
            key: 'unknown',
            suggestedBrand: null,
            itemCount: 1,
            itemIds: ['i4'],
            sampleProductNames: ['Mystery Chew Sticks 3pk'],
          },
        ],
        missingDomainBrands: [],
        unroutedBrands: [],
      },
      availableDistributors: [],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<BrandAssignmentPanel batchId="b1" />);
    });

    expect(container.textContent).toContain('Assign Missing Brands');
    expect(container.textContent).toContain('3 products need a brand');
    expect(container.textContent).toContain('Suggested: ACANA');
    expect(container.textContent).toContain('Acana Wild Prairie 25lb · Acana Meadowland 15lb');
    expect(container.textContent).toContain('Unassigned Brand');
    expect(container.textContent).toContain('Assign all 2');
    expect(container.textContent).toContain('Assign all 1');
  });

  it('invokes assignBrandGroup on button click and calls onBrandAssigned', async () => {
    vi.mocked(getBatchPreflight).mockResolvedValue({
      batchId: 'b1',
      batchName: 'Batch 1',
      executionState: 'draft',
      totalItems: 2,
      readyCount: 0,
      heldCount: 2,
      readyItemIds: [],
      heldItemIds: ['i2', 'i3'],
      metrics: {
        brandResolvedCount: 0,
        brandResolvedPercent: 0,
        ambiguousBrandCount: 0,
        missingBrandCount: 2,
        domainMappedCount: 0,
        domainMappedPercent: 0,
        missingDomainBrandCount: 0,
        distributorRoutedCount: 0,
        distributorRoutedPercent: 0,
        unroutedBrandCount: 0,
      },
      blockers: {
        needsBrandGroups: [
          {
            key: 'suggested:ACANA',
            suggestedBrand: 'ACANA',
            itemCount: 2,
            itemIds: ['i2', 'i3'],
            sampleProductNames: ['Acana Wild Prairie 25lb'],
          },
        ],
        missingDomainBrands: [],
        unroutedBrands: [],
      },
      availableDistributors: [],
    });

    vi.mocked(assignBrandGroup).mockResolvedValueOnce({
      success: true,
      preflight: {
        batchId: 'b1',
        batchName: 'Batch 1',
        executionState: 'draft',
        totalItems: 2,
        readyCount: 2,
        heldCount: 0,
        readyItemIds: ['i2', 'i3'],
        heldItemIds: [],
        metrics: {
          brandResolvedCount: 2,
          brandResolvedPercent: 100,
          ambiguousBrandCount: 0,
          missingBrandCount: 0,
          domainMappedCount: 2,
          domainMappedPercent: 100,
          missingDomainBrandCount: 0,
          distributorRoutedCount: 2,
          distributorRoutedPercent: 100,
          unroutedBrandCount: 0,
        },
        blockers: {
          needsBrandGroups: [],
          missingDomainBrands: [],
          unroutedBrands: [],
        },
        availableDistributors: [],
      },
    });

    const onBrandAssigned = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<BrandAssignmentPanel batchId="b1" onBrandAssigned={onBrandAssigned} />);
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('Assign all 2');

    await act(async () => {
      button.click();
    });

    expect(assignBrandGroup).toHaveBeenCalledWith('b1', ['i2', 'i3'], 'ACANA');
    expect(onBrandAssigned).toHaveBeenCalled();
  });
});
