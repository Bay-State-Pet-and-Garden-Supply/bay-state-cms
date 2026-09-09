// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/onboarding-api', () => ({
  getMissingBrandGroups: vi.fn(),
  assignBrandGroup: vi.fn(),
}));

import { BrandAssignmentPanel } from '../../client/components/onboarding/attention/BrandAssignmentPanel';
import { getMissingBrandGroups, assignBrandGroup } from '../../client/onboarding-api';

describe('BrandAssignmentPanel', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  it('renders nothing when no items need brands', async () => {
    vi.mocked(getMissingBrandGroups).mockResolvedValueOnce({
      batchId: 'b1',
      groups: [],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<BrandAssignmentPanel batchId="b1" />);
    });

    expect(container.innerHTML).toBe('');
  });

  it('renders brand assignment cluster cards with sample items and direct assign button', async () => {
    vi.mocked(getMissingBrandGroups).mockResolvedValueOnce({
      batchId: 'b1',
      groups: [
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
    vi.mocked(getMissingBrandGroups)
      .mockResolvedValueOnce({
        batchId: 'b1',
        groups: [
          {
            key: 'suggested:ACANA',
            suggestedBrand: 'ACANA',
            itemCount: 2,
            itemIds: ['i2', 'i3'],
            sampleProductNames: ['Acana Wild Prairie 25lb'],
          },
        ],
      })
      // Refetch after assignment returns an empty queue.
      .mockResolvedValue({ batchId: 'b1', groups: [] });

    vi.mocked(assignBrandGroup).mockResolvedValueOnce({ success: true });

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
