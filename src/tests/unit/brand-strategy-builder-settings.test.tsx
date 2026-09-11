// @vitest-environment jsdom
/**
 * B4 — Settings full-builder integration (Vitest jsdom).
 *
 * The Brands table mounts the shared builder in Edit/New flows, displays
 * approval/revision/readiness, saves mappings + sources in one guarded call,
 * refreshes server facts, permits distributor-only brands without Missing
 * Domain/Profile warnings, and handles 409s like the builder. No advisory
 * Save path and no Delete remain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../client/onboarding-api', () => ({
  getBrandStrategies: vi.fn(),
  getBrandStrategyDetail: vi.fn(),
  saveBrandStrategy: vi.fn(),
  OnboardingApiError: class extends Error {
    status: number;
    code: string | null;
    payload: unknown;
    constructor(message: string, status = 500, code: string | null = null, payload: unknown = undefined) {
      super(message);
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  },
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BrandStrategyView } from '../../client/components/brand-strategy/BrandStrategyView';
import { getBrandStrategies, getBrandStrategyDetail, saveBrandStrategy } from '../../client/onboarding-api';
import type { BrandStrategy } from '../../shared/schemas/brand-strategy';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function row(overrides: Partial<BrandStrategy> = {}): BrandStrategy {
  return {
    brandKey: 'Acme',
    normalizedBrand: 'acme',
    officialDomains: [],
    proposalSources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
    sourceOptions: [
      { kind: 'distributor_record', ref: 'phillips', displayName: 'Phillips', selectable: true, reason: 'enabled', available: true },
    ],
    configurationToken: 'tok-1',
    approval: { approved: true, revision: 1, approvedAt: '2026-01-01', approvedBy: 'op' },
    approvedSources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
    sourceAvailability: [{ kind: 'distributor_record', ref: 'phillips', available: true, reason: 'ready' }],
    collectionReadiness: 'ready',
    extractorReadiness: 'profile_bypass_eligible',
    ambiguous: [],
    unmatched: false,
    possibleMatches: [],
    ...overrides,
  } as BrandStrategy;
}

describe('BrandStrategyView settings integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBrandStrategies).mockResolvedValue({ strategies: [row()] });
    vi.mocked(getBrandStrategyDetail).mockImplementation(async (brand: string) => ({
      strategy: row({ brandKey: brand, normalizedBrand: brand.trim().toLowerCase() }),
      strategies: [row()],
    }) as never);
    vi.mocked(saveBrandStrategy).mockResolvedValue({ strategy: { revision: 2 } } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  async function renderView(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(<BrandStrategyView {...props} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  it('shows approval/revision/readiness and distributor-only brands without Missing Domain warnings', async () => {
    await renderView();
    expect(container.textContent).toMatch(/Approved revision 1/);
    expect(container.textContent).toMatch(/Readiness: ready/);
    expect(container.textContent).toMatch(/Distributor \(phillips\)/);
    // Distributor-only brand: no Missing Domain / profile warnings.
    expect(container.textContent).not.toMatch(/Missing Domain/);
    expect(container.textContent).not.toMatch(/No official domain/);
    // No misleading Delete control.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Delete')).toBe(false);
  });

  it('Edit flow uses the shared builder and saves mappings + sources in one call', async () => {
    await renderView();
    const edit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit strategy') as HTMLButtonElement;
    await act(async () => {
      edit.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container.textContent).toMatch(/Approved sources/);
    expect(container.textContent).not.toMatch(/Legacy settings/);
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveBrandStrategy).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ brand: 'Acme', expectedRevision: 1, expectedConfigurationToken: 'tok-1' });
    expect(payload.configuration).toEqual({ officialDomains: [] });
    // Saved → dialog closed + server facts refreshed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getBrandStrategies).toHaveBeenCalledTimes(2);
  });

  it('New flow resolves the typed brand name before the builder can save (review-loop R1 P0-2)', async () => {
    await renderView();
    const create = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '+ New Brand Strategy') as HTMLButtonElement;
    await act(async () => {
      create.click();
    });
    // Name first: no builder, no Save until the brand is resolved.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Save strategy')).toBe(false);
    const input = container.querySelector('input[aria-label="Brand name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'Newbrand');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const lookup = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Look up') as HTMLButtonElement;
    expect(lookup.disabled).toBe(false);
    await act(async () => {
      lookup.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getBrandStrategyDetail).toHaveBeenCalledWith('Newbrand');
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    expect(saveBtn).toBeDefined();
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
    });
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveBrandStrategy).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ brand: 'Newbrand', expectedRevision: 1, expectedConfigurationToken: 'tok-1' });
  });

  it('dirty edits survive Escape/backdrop while a clean dialog closes (review-loop R1 P1-3)', async () => {
    await renderView();
    const edit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit strategy') as HTMLButtonElement;
    await act(async () => {
      edit.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // Clean dialog: Escape closes.
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // Reopen and dirty the edit via the proposal shortcut.
    const edit2 = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit strategy') as HTMLButtonElement;
    await act(async () => {
      edit2.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const stageProposal = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal') as HTMLButtonElement;
    await act(async () => {
      stageProposal.click();
    });
    const dialog2 = container.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      dialog2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Dirty: the shell must not discard — the builder stays open.
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Save strategy')).toBe(true);
  });

  it('prop updates replace table facts without stale state', async () => {
    await renderView({ strategies: [row()], refreshSignal: 0 });
    expect(container.textContent).toMatch(/Approved revision 1/);
    await act(async () => {
      root.render(<BrandStrategyView strategies={[row({ approval: { approved: true, revision: 5, approvedAt: 'x', approvedBy: 'op' } })]} />);
    });
    expect(container.textContent).toMatch(/Approved revision 5/);
  });

});
