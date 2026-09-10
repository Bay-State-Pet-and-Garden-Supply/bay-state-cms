// @vitest-environment jsdom
/**
 * B5 — Stage 1 shared expander coverage (mounted StageItemsView).
 *
 * Review strategy opens the SAME builder/command as Settings for
 * approved/drifted/new brands; the compact shortcut stages the live
 * proposal locally (still requiring explicit Save); two rows of one brand
 * share a single editor/refresh; a save resolving after the editor closed
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
  getBrandSites,
  getBrandStrategyDetail,
  getExtractorProfiles,
  saveBrandStrategy,
} from '../../client/onboarding-api';
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
  aliases: [],
  preferredDistributorIds: ['Phillips'],
  sourcingPolicy: 'advisory',
  fallbackTier: [],
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

describe('Stage 1 strategy expander (mounted)', () => {
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

    const acmeCell = container.querySelector('[data-testid="intake-strategy-item_acme"]');
    expect(acmeCell?.textContent).toMatch(/Phillips \+ BCI/);
    expect(container.querySelector('[data-testid="intake-missing-domain-item_acme"]')).toBeNull();
    expect(container.querySelector('[data-testid="intake-missing-domain-item_beta"]')).not.toBeNull();
    // No direct approve button remains — only the Review strategy expander.
    expect(container.querySelector('[data-testid="intake-strategy-approve-item_beta"]')).toBeNull();
    const review = container.querySelector('[data-testid="intake-strategy-review-item_beta"]') as HTMLButtonElement;
    expect(review).not.toBeNull();
    expect(review.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      review.click();
    });
    await settle();
    expect(review.getAttribute('aria-expanded')).toBe('true');
    const region = container.querySelector('[data-testid="intake-strategy-editor-item_beta"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('role')).toBe('region');
    // Same builder copy as Settings: Included vs Preferred + save-approves note.
    expect(container.textContent).toMatch(/Included vs Preferred/);
    expect(container.textContent).toMatch(/Saving approves this strategy immediately/);
    expect(getBrandStrategyDetail).toHaveBeenCalledWith('Beta');
  });

  it('Save current proposal shortcut stages the proposal and saves through the same guarded contract', async () => {
    await renderStage();
    const shortcut = container.querySelector('[data-testid="intake-strategy-use-proposal-item_beta"]') as HTMLButtonElement;
    expect(shortcut).not.toBeNull();
    await act(async () => {
      shortcut.click();
    });
    await settle();
    expect(container.querySelector('[data-testid="intake-strategy-editor-item_beta"]')).not.toBeNull();

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
        aliases: [],
        preferredDistributorIds: ['Phillips'],
        sourcingPolicy: 'advisory',
      },
      expectedConfigurationToken: 'tok-beta',
    });
    // Successful Save reloads intake references (no requeue/recollection path touched).
    await settle();
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBeGreaterThan(blockersBefore);
  });

  it('two rows of the same brand share one editor and one refresh', async () => {
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
    // One mounted editor (first row) + a shared-editor note in the second.
    expect(container.querySelectorAll('[data-testid^="intake-strategy-editor-"]').length).toBe(1);
    expect(container.textContent).toMatch(/one editor per brand/);
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
    // Operator reassigns the brand (editor unmounts) before the save resolves.
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
    // Stale response dropped: no intake refresh from the abandoned editor.
    expect(vi.mocked(getBrandDomainBlockers).mock.calls.length).toBe(blockersBefore);
    expect(container.querySelector('[data-testid^="intake-strategy-editor-"]')).toBeNull();
  });
});
