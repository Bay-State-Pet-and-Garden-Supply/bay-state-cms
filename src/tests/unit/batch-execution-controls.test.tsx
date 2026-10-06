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
  it('renders Start branded products with overflow-collapsed Start all from draft', () => {
    const el = renderControls('draft');
    const ready = el.querySelector('[data-testid="batch-start-ready"]');
    expect(ready).not.toBeNull();
    expect(ready?.textContent).toContain('Start branded products');
    expect(ready?.getAttribute('title')).toContain('Start branded products');
    // Advanced action starts collapsed in the overflow disclosure.
    expect(el.querySelector('[data-testid="batch-start-all"]')).toBeNull();
    const toggle = el.querySelector('[data-testid="batch-start-overflow-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[data-testid="batch-pause"]')).toBeNull();
    expect(el.querySelector('[data-testid="batch-resume"]')).toBeNull();
  });

  it('opens the overflow disclosure to reach Start all products (confirm-guarded)', () => {
    const el = renderControls('draft');
    const toggle = el.querySelector('[data-testid="batch-start-overflow-toggle"]') as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const all = el.querySelector('[data-testid="batch-start-all"]');
    expect(all).not.toBeNull();
    expect(all?.textContent).toContain('Start all products');
    expect(all?.getAttribute('title')).toContain('requires confirmation');
  });

  it('keeps Start branded + overflow reachable while running (held items releasable)', () => {
    const el = renderControls('running');
    expect(el.querySelector('[data-testid="batch-start-ready"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-start-overflow-toggle"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-pause"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-start-all"]')).toBeNull();
  });

  it('renders Resume alongside Start actions from paused', () => {
    const el = renderControls('paused');
    expect(el.querySelector('[data-testid="batch-resume"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-start-ready"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="batch-pause"]')).toBeNull();
  });

  it('collapses the overflow on Escape', () => {
    const el = renderControls('draft');
    const toggle = el.querySelector('[data-testid="batch-start-overflow-toggle"]') as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(el.querySelector('[data-testid="batch-start-overflow"]')).not.toBeNull();
    act(() => {
      el.querySelector('[data-testid="batch-start-overflow"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(el.querySelector('[data-testid="batch-start-overflow"]')).toBeNull();
  });
});
