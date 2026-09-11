// @vitest-environment jsdom
/**
 * B5 — Stage 1 builder integration: 409 handling, keyboard/a11y, drift.
 *
 * A 409 inside the Stage 1 dialog preserves edits and offers
 * reload-discard / rebase without silent retry; the dialog trigger is
 * keyboard-operable with aria-haspopup="dialog" and a labelled modal dialog;
 * the Strategy column stays compact (status + Review button, no inline
 * revision details — those live in the dialog).
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
    getPreparationGap: vi.fn(),
    submitGapCorrection: vi.fn(),
    generateGapIdempotencyKey: vi.fn(() => 'test-gap-key'),
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
  getPreparationGap,
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

  it('strategy column stays compact: status + Review button, no inline revision details', async () => {
    await renderStage();
    // No verbose inline details in the table — revision/proposal text lives in the dialog.
    expect(container.querySelector('[data-testid="intake-strategy-approved-item_gamma"]')).toBeNull();
    expect(container.querySelector('[data-testid="intake-strategy-use-proposal-item_beta"]')).toBeNull();
    expect(container.textContent).not.toMatch(/proposal differs/);
    expect(container.textContent).not.toMatch(/official collection not yet supported/);
    // Compact status + single trigger per row.
    expect(container.querySelector('[data-testid="intake-readiness-item_gamma"]')?.textContent).toMatch(/Ready.*2 sources available/);
    expect(container.querySelector('[data-testid="intake-readiness-item_beta"]')?.textContent).toMatch(/Awaiting strategy approval/);
    expect(container.querySelector('[data-testid="intake-strategy-review-item_gamma"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="intake-strategy-review-item_beta"]')).not.toBeNull();
  });

  it('409 in the expander preserves context and requires an explicit second Save', async () => {
    vi.mocked(saveBrandStrategy).mockRejectedValueOnce(
      new OnboardingApiError('stale', 409, 'stale_revision', { error: 'stale_revision', code: 'stale_revision', revision: 0 }),
    );
    await renderStage();
    // Open the dialog via the single Review trigger, then stage the live
    // proposal inside the builder (still requiring explicit Save).
    await act(async () => {
      (container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement).click();
    });
    await settle();
    expect(container.querySelector('[data-testid="intake-strategy-dialog"]')).not.toBeNull();
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal') as HTMLButtonElement).click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/changed while editing/);
    // No silent retry: exactly one mutation call, dialog still open.
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="intake-strategy-dialog"]')).not.toBeNull();
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Review changes against latest') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/Rebased onto the latest revision/);
  });

  it('dialog trigger is keyboard-operable with a labelled modal dialog and readiness text (no color-only status)', async () => {
    await renderStage();
    const review = container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement;
    review.focus();
    expect(document.activeElement).toBe(review);
    await act(async () => {
      review.click();
    });
    await settle();
    expect(review.getAttribute('aria-haspopup')).toBe('dialog');
    const dialog = container.querySelector('[data-testid="intake-strategy-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toMatch(/Review strategy — Beta/);
    // Text readiness, not color-only: awaiting-approval wording is present.
    expect(container.textContent).toMatch(/Awaiting approval/);
  });

  it('prepare gap dialog opens labelled, Escape closes and restores invoker focus (T-8)', async () => {
    const prepRow = {
      ...betaRow('item_p1'),
      upc: '000000009', name: 'Prep product', brand: 'Prep',
      stage: 'prepare_listing', stageStatus: 'pending',
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '');
      if (url.includes('/api/onboarding/brands/strategy')) {
        return { ok: true, status: 200, json: async () => ({ strategies: [] }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2, stageVocabularyVersion: 2, batchId: 'b1',
          filterFingerprint: 'a'.repeat(32), projectionHealth: healthy(),
          items: [prepRow], nextCursor: null, scannedRows: 1, queryCount: 1,
        }),
      } as any;
    });
    vi.mocked(getPreparationGap).mockResolvedValue({
      gap: {
        id: 'pgap_1', itemId: 'item_p1', batchId: 'b1', missingFields: ['description'],
        reason: 'No description from collected sources.', evidenceHash: null,
        status: 'open', correctionRevision: 0, correctionEnvelope: null,
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    } as never);
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage="prepare_listing" />);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="prepare-gap-open-item_p1"]')).not.toBeNull();
    });
    const opener = container.querySelector('[data-testid="prepare-gap-open-item_p1"]') as HTMLButtonElement;
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog');
    opener.focus();
    await act(async () => { opener.click(); });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="prepare-gap-dialog"]')).not.toBeNull();
    });
    await act(async () => {});
    const dialog = container.querySelector('[data-testid="prepare-gap-dialog"]');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toMatch(/Resolve listing gap — Prep product/);
    // The panel loaded the persisted request for help inside the dialog.
    await vi.waitFor(() => {
      expect(container.querySelector('form[aria-label="Correct listing information for Prep product"]')).not.toBeNull();
    });
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="prepare-gap-dialog"]')).toBeNull();
    });
    // Invoker focus restored — keyboard users land back on the row trigger.
    expect(document.activeElement).toBe(opener);
  });
});
