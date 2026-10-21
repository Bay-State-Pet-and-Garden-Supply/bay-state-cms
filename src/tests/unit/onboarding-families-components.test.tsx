// @vitest-environment jsdom
/**
 * Epic #46 Phase 5 — Processing + Waiting on Family view smoke tests.
 *
 * Verifies the cross-agent contract exports render, handle loading/empty
 * states, and show no fake progression controls. API module is mocked.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { BatchWorkState, OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';

vi.mock('@/client/onboarding-work-api', () => ({
  getBatchWorkState: vi.fn(),
  getBatchWorkStateCounts: vi.fn(),
  getBatchWorkStateItems: vi.fn(),
  subscribeBatchEvents: vi.fn(() => () => {}),
}));

import { getBatchWorkState, subscribeBatchEvents, getBatchWorkStateCounts, getBatchWorkStateItems } from '../../client/onboarding-work-api';
import { ProcessingView } from '../../client/components/onboarding/processing/ProcessingView';

function workItem(partial: Partial<OnboardingWorkState>): OnboardingWorkState {
  return {
    itemId: 'item-1',
    category: 'processing',
    activity: null,
    label: 'Processing',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    family: null,
    reviewState: null,
    stage: 'extraction',
    stageStatus: 'in_progress',
    upc: '012345678905',
    name: 'Test Product',
    brand: null,
    sourceType: 'official_page',
    domain: 'example.com',
    ...partial,
  } as OnboardingWorkState;
}

async function renderAsync(component: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('ProcessingView (contract export)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders processing rows grouped by activity with no progression controls', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 1, needs_attention: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [
        workItem({ itemId: 'p1', activity: 'extraction', label: 'Extracting product data', name: 'Chicken Treats', upc: '100000000001', brand: 'Blue Buffalo', stage: 'extraction', stageStatus: 'in_progress' }),
      ],
      total: 1,
    };
    vi.mocked(getBatchWorkState).mockResolvedValue(payload);

    const { container, unmount } = await renderAsync(<ProcessingView batchId="batch-1" />);

    expect(container.textContent).toContain('Extracting Product Data');
    expect(container.textContent).toContain('Chicken Treats');
    expect(container.textContent).toContain('100000000001');
    expect(container.textContent).toContain('Extracting product data');
    // Diagnostics-only stage badge is subtle, but the primary activity header is there.
    expect(container.textContent).toContain('extraction / in_progress');
    // NO fake progression controls.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((b) => !/advance|reset|skip/i.test(b.textContent ?? ''))).toBe(true);
    expect(vi.mocked(subscribeBatchEvents)).toHaveBeenCalledWith('batch-1', expect.any(Function));
    unmount();
  });

  it('renders an honest empty state', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 0, needs_attention: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [],
      total: 0,
    };
    vi.mocked(getBatchWorkState).mockResolvedValue(payload);
    const { container, unmount } = await renderAsync(<ProcessingView batchId="batch-1" />);
    expect(container.textContent).toContain('Nothing processing right now');
    unmount();
  });
});

