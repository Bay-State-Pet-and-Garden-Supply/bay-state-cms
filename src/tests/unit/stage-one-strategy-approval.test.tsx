// @vitest-environment jsdom
/**
 * B5 — Stage 1 shared dialog coverage (mounted StageItemsView).
 *
 * Review strategy opens the SAME builder/command as Settings for
 * approved/drifted/new brands; the live proposal is staged from inside the
 * dialog (still requiring explicit Save); two rows of one brand
 * share a single dialog/refresh; a save resolving after the dialog closed
 * cannot apply; successful Save reloads intake references without
 * requeue/recollection. No direct approve call remains in this surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));

vi.mock('../../client/onboarding-api', () => ({
  assignItemBrand: vi.fn(),
  assignItemDomain: vi.fn(),
  assignBrandGroup: vi.fn(),
  getBrandSites: vi.fn(),
  getExtractorProfiles: vi.fn(),
  getBrandStrategyDetail: vi.fn(),
  saveBrandStrategy: vi.fn(),
}));

vi.mock('../../client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import {
  assignItemBrand,
  getBrandSites,
  getBrandStrategyDetail,
  getExtractorProfiles,
  saveBrandStrategy,
} from '../../client/onboarding-api';
import { readinessText } from '../../client/components/brand-strategy/BrandStrategyBuilder';
import { getBrandDomainBlockers } from '../../client/onboarding-work-api';
import { resetBrandOptionsCache } from '../../client/components/onboarding/brand-combobox-logic';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function healthy() {
  return { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] };
}

function row(itemId: string, brand: string | null) {
  return {
    itemId,
    category: 'processing',
    activity: null,
    label: 'Working',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    variantResolution: null,
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    family: null,
    reviewState: 'unreviewed',
    stage: 'sourcing',
    stageStatus: 'pending',
    upc: `0000000${itemId.length}01`,
    name: `Product ${itemId}`,
    brand,
    sourceType: 'official_page',
    domain: null,
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
  };
}

const ACME = {
  brandKey: 'Acme',
  normalizedBrand: 'acme',
  officialDomains: [],
  proposalSources: [
    { kind: 'distributor_record', distributorId: 'Phillips' },
    { kind: 'distributor_record', distributorId: 'BCI' },
  ],
  sourceOptions: [
    { kind: 'distributor_record', ref: 'Phillips', displayName: 'Phillips', selectable: true, reason: 'enabled', available: true },
    { kind: 'distributor_record', ref: 'BCI', displayName: 'BCI', selectable: true, reason: 'enabled', available: true },
  ],
  configurationToken: 'tok-acme',
  approval: { approved: true, revision: 1, approvedAt: '2026-01-01', approvedBy: 'op' },
  approvedSources: [
    { kind: 'distributor_record', distributorId: 'Phillips' },
    { kind: 'distributor_record', distributorId: 'BCI' },
  ],
  sourceAvailability: [
    { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
    { kind: 'distributor_record', ref: 'BCI', available: true, reason: 'ready' },
  ],
  collectionReadiness: 'ready',
  extractorReadiness: 'profile_bypass_eligible',
  ambiguous: [],
  unmatched: false,
  possibleMatches: [],
};

const BETA = {
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
  sourceAvailability: [
    { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
  ],
  collectionReadiness: 'awaiting_approval',
  extractorReadiness: 'not_configured',
  ambiguous: [],
  unmatched: true,
  possibleMatches: [],
};

function itemsPayload() {
  return {
    schemaVersion: 2,
    stageVocabularyVersion: 2,
    batchId: 'b1',
    filterFingerprint: 'a'.repeat(32),
    projectionHealth: healthy(),
    items: [row('item_acme', 'Acme'), row('item_beta', 'Beta')],
    nextCursor: null,
    scannedRows: 2,
    queryCount: 1,
  };
}

describe('Stage 1 strategy dialog (mounted)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchCalls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrandOptionsCache();
    fetchCalls = [];
    vi.mocked(getBrandSites).mockResolvedValue({ brandSites: [], catalogBrands: ['Acme', 'Beta'] } as never);
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({ blockers: [] } as never);
    vi.mocked(getBrandStrategyDetail).mockImplementation(async (brand: string) => ({
      strategy: brand.trim().toLowerCase() === 'acme' ? ACME : BETA,
    }) as never);
    vi.mocked(saveBrandStrategy).mockResolvedValue({ strategy: { revision: 1 } } as never);
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '');
      fetchCalls.push(url);
      if (url.includes('/api/onboarding/brands/strategy')) {
        return { ok: true, status: 200, json: async () => ({ strategies: [ACME, BETA] }) } as any;
      }
      return { ok: true, status: 200, json: async () => itemsPayload() } as any;
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

  it('shows the approved label, suppresses Missing Domain for distributor-only brands, and expands the shared builder', async () => {
    await renderStage();

    // Compact strategy column: readiness status + Review trigger, no verbose labels.
    expect(container.querySelector('[data-testid="intake-strategy-item_acme"]')?.textContent).toMatch(/Ready.*2 sources available/);
    expect(container.querySelector('[data-testid="intake-strategy-approved-item_acme"]')).toBeNull();
    expect(container.querySelector('[data-testid="intake-readiness-item_beta"]')?.textContent).toMatch(/Awaiting approval/);
    expect(container.querySelector('[data-testid="intake-missing-domain-item_acme"]')).toBeNull();
    expect(container.querySelector('[data-testid="intake-missing-domain-item_beta"]')).not.toBeNull();
    // No direct approve button remains — only the Review strategy dialog trigger.
    expect(container.querySelector('[data-testid="intake-strategy-approve-item_beta"]')).toBeNull();
    const review = container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement;
    expect(review).not.toBeNull();
    expect(review.getAttribute('aria-haspopup')).toBe('dialog');

    await act(async () => {
      review.click();
    });
    await settle();
    const dialog = container.querySelector('[data-testid="intake-strategy-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // Same builder copy as Settings: Included sources + save-approves note.
    expect(container.textContent).toMatch(/Approved sources/);
    expect(container.textContent).toMatch(/Saving approves this strategy immediately/);
    expect(getBrandStrategyDetail).toHaveBeenCalledWith('Beta');
  });

  it('"Use current proposal" inside the dialog stages the proposal and saves through the same guarded contract', async () => {
    await renderStage();
    await act(async () => {
      (container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement).click();
    });
    await settle();
    expect(container.querySelector('[data-testid="intake-strategy-dialog"]')).not.toBeNull();
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal') as HTMLButtonElement).click();
    });

    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    const blockersBefore = vi.mocked(getBrandDomainBlockers).mock.calls.length;
    await act(async () => {
      saveBtn.click();
    });
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    expect(saveBrandStrategy).toHaveBeenCalledWith({
      brand: 'Beta',
      sources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
      expectedRevision: 0,
      configuration: {
        officialDomains: [],
                        },
      expectedConfigurationToken: 'tok-beta',
    });
    // Successful Save reloads intake references (no requeue/recollection path touched).
    await settle();
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBeGreaterThan(blockersBefore);
  });

  it('two rows of the same brand share one dialog and one detail load', async () => {
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '');
      if (url.includes('/api/onboarding/brands/strategy')) {
        return { ok: true, status: 200, json: async () => ({ strategies: [ACME, BETA] }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...itemsPayload(),
          items: [row('item_beta_1', 'Beta'), row('item_beta_2', 'Beta')],
        }),
      } as any;
    });
    await renderStage();
    const review1 = container.querySelector('[data-testid="intake-strategy-review-item_beta_1"]') as HTMLButtonElement;
    await act(async () => {
      review1.click();
    });
    await settle();
    // One mounted dialog for the brand (no per-row inline editors).
    expect(container.querySelectorAll('[data-testid="intake-strategy-dialog"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="intake-strategy-editor-"]')).toHaveLength(0);
    expect(getBrandStrategyDetail).toHaveBeenCalledTimes(1);
  });

  it('a save resolving after brand reassignment cannot apply the stale response', async () => {
    let resolveSave!: (v: { strategy: { revision: number } }) => void;
    vi.mocked(saveBrandStrategy).mockImplementationOnce(
      () => new Promise((resolve) => { resolveSave = resolve as never; }),
    );
    await renderStage();
    const review = container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement;
    await act(async () => {
      review.click();
    });
    await settle();
    // Stage the live proposal first (unapproved brands start empty).
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal') as HTMLButtonElement).click();
    });
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    expect(saveBrandStrategy).toHaveBeenCalledTimes(1);
    const blockersBefore = vi.mocked(getBrandDomainBlockers).mock.calls.length;
    // Operator closes the dialog (editor unmounts) before the save resolves.
    // The edit is dirty, so Cancel first arms discard confirmation.
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discard edits') as HTMLButtonElement).click();
    });
    await act(async () => {
      resolveSave({ strategy: { revision: 1 } });
    });
    await settle();
    // Stale response dropped: no intake refresh from the abandoned dialog.
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBe(blockersBefore);
    expect(container.querySelector('[data-testid="intake-strategy-dialog"]')).toBeNull();
  });
});

describe('Stage 1 ticket #125 follow-ups (mounted)', () => {
  let container: HTMLDivElement;
  let root: Root;

  function settle() {
    return act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrandOptionsCache();
    vi.mocked(getBrandSites).mockResolvedValue({ brandSites: [], catalogBrands: ['Acme', 'Beta'] } as never);
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({ blockers: [] } as never);
    vi.mocked(getBrandStrategyDetail).mockImplementation(async (brand: string) => ({
      strategy: brand.trim().toLowerCase() === 'acme' ? ACME : BETA,
    }) as never);
    vi.mocked(saveBrandStrategy).mockResolvedValue({ strategy: { revision: 1 } } as never);
    vi.mocked(assignItemBrand).mockResolvedValue({ success: true } as never);
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '');
      if (url.includes('/api/onboarding/brands/strategy')) {
        return { ok: true, status: 200, json: async () => ({ strategies: [ACME, BETA] }) } as any;
      }
      return { ok: true, status: 200, json: async () => itemsPayload() } as any;
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

  it('unavailable-only sets stay selectable but never Ready (F3 copy)', () => {
    // Exact ladder wording pinned without mounting the dialog.
    expect(readinessText({
      approval: { approved: true, revision: 2, approvedAt: '2026-01-01', approvedBy: 'op' },
      collectionReadiness: 'setup_attention',
      sourceAvailability: [
        { kind: 'distributor_record', ref: 'ghost', available: false, reason: 'Distributor connection not enabled' },
      ],
    } as never)).toBe(
      'Approved revision 2 · Setup attention · No usable sources. Saving an unavailable-only set stays selectable but never Ready.',
    );
    expect(readinessText({
      approval: { approved: true, revision: 1, approvedAt: '2026-01-01', approvedBy: 'op' },
      collectionReadiness: 'ready',
      sourceAvailability: [
        { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
      ],
    } as never)).toBe('Approved revision 1 · Ready · 1 source available');
    expect(readinessText(null)).toBe('Collection readiness unavailable · Retry');
  });

  it('brand switch while the builder is dirty holds Save: no cross-brand write (F4)', async () => {
    let resolveAssign!: (v: unknown) => void;
    vi.mocked(assignItemBrand).mockImplementationOnce(
      () => new Promise((resolve) => { resolveAssign = resolve as never; }),
    );
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage="route_sources" />);
    });
    await settle();
    // Open the Beta strategy dialog first.
    const review = container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement;
    await act(async () => {
      review.click();
    });
    await settle();
    expect(container.querySelector('[data-testid="intake-strategy-dialog"]')).not.toBeNull();
    // Commit a brand change on the Beta row; the assignment stays
    // in-flight while the dialog is open.
    const input = container.querySelector('[data-testid="stage-brand-input-item_beta"]') as HTMLInputElement;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      const setter = descriptor?.set;
      if (typeof setter !== 'function') throw new Error('HTMLInputElement value setter missing');
      setter.call(input, 'Beta New');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(vi.mocked(assignItemBrand)).toHaveBeenCalledTimes(1);
    // The approval must pin a settled brand: Save stays disabled with the
    // hold reason while the assignment is in flight.
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save strategy',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    // The hold reason is the Save button's title (not body text).
    expect(saveBtn.title).toMatch(/Brand assignment in progress/);
    // Settle the assignment: the hold lifts and no strategy write happened
    // for either brand along the way.
    await act(async () => {
      resolveAssign({ success: true });
    });
    await settle();
    expect(vi.mocked(saveBrandStrategy)).not.toHaveBeenCalled();
    const saveAfter = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save strategy',
    ) as HTMLButtonElement;
    // The hold lifted (title falls back to validation state — this Beta
    // dialog still has no sources selected, which is orthogonal).
    expect(saveAfter.title).not.toMatch(/Brand assignment in progress/);
  });
});
