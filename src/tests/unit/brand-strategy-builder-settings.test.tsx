// @vitest-environment jsdom
/**
 * B4 — Settings full-builder integration (Vitest jsdom).
 *
 * The Brands table mounts the shared builder in Edit/New flows, displays
 * approval/revision/readiness, saves mappings + preferences + sources in one
 * guarded call, refreshes server facts, permits distributor-only brands
 * without Missing Domain/Profile warnings, and handles 409s like the
 * builder. No upsertBrandProfile Save path and no advisory Delete remain.
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
    aliases: [],
    preferredDistributorIds: ['phillips'],
    sourcingPolicy: 'preferred_then_fallback',
    fallbackTier: [],
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
    expect(container.textContent).not.toMatch(/No advisory profile/);
    // No misleading Delete control.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Delete')).toBe(false);
  });

  it('Edit flow uses the shared builder and saves mappings + preferences + sources in one call', async () => {
    await renderView();
    const edit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit strategy') as HTMLButtonElement;
    await act(async () => {
      edit.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container.textContent).toMatch(/Included vs Preferred/);
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveBrandStrategy).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ brand: 'Acme', expectedRevision: 1, expectedConfigurationToken: 'tok-1' });
    expect(payload.configuration).toMatchObject({ preferredDistributorIds: ['phillips'] });
    // Saved → dialog closed + server facts refreshed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getBrandStrategies).toHaveBeenCalledTimes(2);
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
