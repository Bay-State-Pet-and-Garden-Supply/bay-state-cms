// @vitest-environment jsdom
/**
 * BatchExecutionControls — always-reachable batch execution surface
 * (replaces the deleted Preflight Review modal's Start/Pause entry points).
 * Pins: the control renders Start ready/all from a draft state, Pause from
 * running, and Resume from paused — driven by executionState alone, never
 * gated on a feature flag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/client/onboarding-api', () => ({
  getBatch: vi.fn(),
  pauseBatch: vi.fn(),
  resumeBatch: vi.fn(),
  startBatch: vi.fn(),
}));

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BatchExecutionControls } from '@/client/components/onboarding/BatchExecutionControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderControls(executionState: string | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<BatchExecutionControls batchId="batch-1" executionState={executionState} />);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe('BatchExecutionControls', () => {
  it('renders Start ready + Start all from draft (not flag-gated)', () => {
    const el = renderControls('draft');
    expect(el.querySelector('[data-testid="batch-start-ready"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-start-all"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-pause"]')).toBeNull();
    expect(el.querySelector('[data-testid="batch-resume"]')).toBeNull();
  });

  it('renders Pause (not Start) from running', () => {
    const el = renderControls('running');
    expect(el.querySelector('[data-testid="batch-pause"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-start-ready"]')).toBeNull();
    expect(el.querySelector('[data-testid="batch-start-all"]')).toBeNull();
  });

  it('renders Resume from paused', () => {
    const el = renderControls('paused');
    expect(el.querySelector('[data-testid="batch-resume"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-pause"]')).toBeNull();
  });
});
