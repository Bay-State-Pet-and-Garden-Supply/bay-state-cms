// @vitest-environment jsdom
/**
 * B5 — Stage 1 builder integration: 409 handling, keyboard/a11y, drift.
 *
 * A 409 inside the Stage 1 expander preserves edits and offers
 * reload-discard / rebase without silent retry; the expander is
 * keyboard-operable with aria-expanded/controls and a labelled region;
 * drifted brands keep the approved boundary as label authority.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));

vi.mock('../../client/onboarding-api', () => {
  class FakeApiError extends Error {
    status: number;
    code: string | null;
    payload: unknown;
    constructor(message: string, status = 500, code: string | null = null, payload: unknown = undefined) {
      super(message);
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  }
  return {
    assignItemBrand: vi.fn(),
    assignItemDomain: vi.fn(),
    assignBrandGroup: vi.fn(),
    getBrandSites: vi.fn(),
    getExtractorProfiles: vi.fn(),
    getBrandStrategyDetail: vi.fn(),
    saveBrandStrategy: vi.fn(),
    OnboardingApiError: FakeApiError,
  };
});

vi.mock('../../client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import {
  getBrandSites,
  getBrandStrategyDetail,
  getExtractorProfiles,
  OnboardingApiError,
  saveBrandStrategy,
} from '../../client/onboarding-api';
import { getBrandDomainBlockers } from '../../client/onboarding-work-api';
import { resetBrandOptionsCache } from '../../client/components/onboarding/brand-combobox-logic';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function healthy() {
  return { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] };
}

const BETA_DETAIL = {
  brandKey: 'Beta',
  normalizedBrand: 'beta',
  aliases: [],
  preferredDistributorIds: ['Phillips'],
  sourcingPolicy: 'preferred_then_fallback',
  fallbackTier: [],
  officialDomains: [],
  proposalSources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
  sourceOptions: [
    { kind: 'distributor_record', ref: 'Phillips', displayName: 'Phillips', selectable: true, reason: 'enabled', available: true },
  ],
  configurationToken: 'tok-beta',
  approval: { approved: false, revision: 0, approvedAt: null, approvedBy: null },
  approvedSources: [],
  sourceAvailability: [{ kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' }],
  collectionReadiness: 'awaiting_approval',
  extractorReadiness: 'not_configured',
  ambiguous: [],
  unmatched: true,
  possibleMatches: [],
};

// Drifted Gamma: approved [phillips], live proposal [phillips + bci].
const GAMMA = {
  brandKey: 'Gamma',
  normalizedBrand: 'gamma',
  aliases: [],
  preferredDistributorIds: ['Phillips', 'BCI'],
  sourcingPolicy: 'preferred_then_fallback',
  fallbackTier: [],
  officialDomains: [],
  proposalSources: [
    { kind: 'distributor_record', distributorId: 'Phillips' },
    { kind: 'distributor_record', distributorId: 'BCI' },
  ],
  sourceOptions: [
    { kind: 'distributor_record', ref: 'Phillips', displayName: 'Phillips', selectable: true, reason: 'enabled', available: true },
    { kind: 'distributor_record', ref: 'BCI', displayName: 'BCI', selectable: true, reason: 'enabled', available: true },
  ],
  configurationToken: 'tok-gamma',
  approval: { approved: true, revision: 2, approvedAt: '2026-01-01', approvedBy: 'op' },
  approvedSources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
  sourceAvailability: [
    { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
    { kind: 'distributor_record', ref: 'BCI', available: true, reason: 'ready' },
  ],
  collectionReadiness: 'ready',
  extractorReadiness: 'active',
  ambiguous: [],
  unmatched: false,
  possibleMatches: [],
};

function betaRow(itemId = 'item_beta') {
  return {
    itemId, category: 'processing', activity: null, label: 'Working', detail: null,
    attentionReason: null, attentionAction: null, variantResolution: null, findingCode: null,
    findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null,
    family: null, reviewState: 'unreviewed', stage: 'sourcing', stageStatus: 'pending',
    upc: '000000001', name: 'Beta product', brand: 'Beta', sourceType: 'official_page',
    domain: null, curatedTitle: null, imageUrl: null, description: null, weight: null,
  };
}

function gammaRow() {
  return { ...betaRow('item_gamma'), upc: '000000002', name: 'Gamma product', brand: 'Gamma' };
}

describe('Stage 1 builder integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrandOptionsCache();
    vi.mocked(getBrandSites).mockResolvedValue({ brandSites: [], catalogBrands: ['Beta', 'Gamma'] } as never);
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({ blockers: [] } as never);
    vi.mocked(getBrandStrategyDetail).mockImplementation(async (brand: string) => ({
      strategy: brand.trim().toLowerCase() === 'gamma' ? GAMMA : BETA_DETAIL,
    }) as never);
    vi.mocked(saveBrandStrategy).mockResolvedValue({ strategy: { revision: 1 } } as never);
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '');
      if (url.includes('/api/onboarding/brands/strategy')) {
        return { ok: true, status: 200, json: async () => ({ strategies: [BETA_DETAIL, GAMMA] }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2, stageVocabularyVersion: 2, batchId: 'b1',
          filterFingerprint: 'a'.repeat(32), projectionHealth: healthy(),
          items: [betaRow(), gammaRow()], nextCursor: null, scannedRows: 2, queryCount: 1,
        }),
      } as any;
    });
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

  async function renderStage() {
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage="route_sources" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  function settle() {
    return act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  it('drifted brands keep the approved boundary as label authority with a proposal-differs note', async () => {
    await renderStage();
    const approved = container.querySelector('[data-testid="intake-strategy-approved-item_gamma"]');
    expect(approved?.textContent).toMatch(/Approved rev 2/);
    expect(approved?.textContent).toMatch(/proposal differs/);
    // Label authority: the strategy cell names the approved boundary only.
    expect(container.querySelector('[data-testid="intake-strategy-item_gamma"]')?.textContent).toMatch(/Phillips/);
  });

  it('409 in the expander preserves context and requires an explicit second Save', async () => {
    vi.mocked(saveBrandStrategy).mockRejectedValueOnce(
      new OnboardingApiError('stale', 409, 'stale_revision', { error: 'stale_revision', code: 'stale_revision', revision: 0 }),
    );
    await renderStage();
    // The compact shortcut enters the shared builder with the proposal
    // staged locally (still requiring explicit Save).
    await act(async () => {
      (container.querySelector('[data-testid="intake-strategy-use-proposal-item_beta"]') as HTMLButtonElement).click();
    });
    await settle();
    expect(container.querySelector('[data-testid="intake-strategy-editor-item_beta"]')).not.toBeNull();
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/changed while editing/);
    // No silent retry: exactly one mutation call, editor still open.
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="intake-strategy-editor-item_beta"]')).not.toBeNull();
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Review changes against latest') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/Rebased onto the latest revision/);
  });

  it('expander is keyboard-operable with labelled region and readiness text (no color-only status)', async () => {
    await renderStage();
    const review = container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement;
    review.focus();
    expect(document.activeElement).toBe(review);
    await act(async () => {
      review.click();
    });
    await settle();
    expect(review.getAttribute('aria-expanded')).toBe('true');
    expect(review.getAttribute('aria-controls')).toBe('strategy-editor-item_beta');
    const region = container.querySelector('[role="region"][aria-label="Strategy editor for Beta"]');
    expect(region).not.toBeNull();
    // Text readiness, not color-only: awaiting-approval wording is present.
    expect(container.textContent).toMatch(/Awaiting approval/);
  });
});
