// @vitest-environment jsdom
/**
 * Mounted strategy-readiness coverage (spec #120, tickets #121/#125).
 *
 * Mounts StageItemsView in route_sources with a URL-routed fetch mock:
 * the strategy endpoint returns an approved distributor-only brand (Acme)
 * plus an unapproved proposal brand (Beta); every other fetch returns the
 * stage-items payload. Asserts the strategy label cell, the approve-button
 * request contract (brand + sources + expectedRevision), and Missing-Domain
 * suppression for the approved distributor-only brand.
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
}));

vi.mock('../../client/onboarding-work-api', () => ({
  getBrandDomainBlockers: vi.fn(),
  assignBatchBrandDomain: vi.fn(),
  approveBrandStrategy: vi.fn(),
}));

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StageItemsView } from '../../client/components/onboarding/StageItemsView';
import { getBrandSites, getExtractorProfiles } from '../../client/onboarding-api';
import {
  approveBrandStrategy,
  getBrandDomainBlockers,
} from '../../client/onboarding-work-api';
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

const STRATEGIES = [
  {
    brandKey: 'Acme',
    normalizedBrand: 'acme',
    aliases: [],
    preferredDistributorIds: ['Phillips', 'BCI'],
    sourcingPolicy: 'preferred_then_fallback',
    fallbackTier: [],
    officialDomains: [],
    extractorReadiness: 'profile_bypass_eligible',
    ambiguous: [],
    unmatched: false,
    possibleMatches: [],
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
  },
  {
    brandKey: 'Beta',
    normalizedBrand: 'beta',
    aliases: [],
    preferredDistributorIds: ['Phillips'],
    sourcingPolicy: 'advisory',
    fallbackTier: [],
    officialDomains: [],
    extractorReadiness: 'not_configured',
    ambiguous: [],
    unmatched: true,
    possibleMatches: [],
    approval: { approved: false, revision: 0, approvedAt: null, approvedBy: null },
    sourceAvailability: [
      { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
    ],
    collectionReadiness: 'awaiting_approval',
  },
];

describe('Stage 1 strategy readiness (mounted)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrandOptionsCache();
    vi.mocked(getBrandSites).mockResolvedValue({ brandSites: [], catalogBrands: ['Acme', 'Beta'] } as never);
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    vi.mocked(getBrandDomainBlockers).mockResolvedValue({ blockers: [] } as never);
    vi.mocked(approveBrandStrategy).mockResolvedValue({ strategy: { revision: 1 } } as never);
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '');
      if (url.includes('/api/onboarding/brands/strategy')) {
        return { ok: true, status: 200, json: async () => ({ strategies: STRATEGIES }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2,
          stageVocabularyVersion: 2,
          batchId: 'b1',
          filterFingerprint: 'a'.repeat(32),
          projectionHealth: healthy(),
          items: [row('item_acme', 'Acme'), row('item_beta', 'Beta')],
          nextCursor: null,
          scannedRows: 2,
          queryCount: 1,
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

  it('shows the approved strategy label, suppresses Missing Domain, and dispatches approval with expectedRevision', async () => {
    await act(async () => {
      root.render(<StageItemsView batchId="b1" stage="route_sources" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Approved distributor-only brand: strategy label from the approved boundary.
    const acmeCell = container.querySelector('[data-testid="intake-strategy-item_acme"]');
    expect(acmeCell?.textContent).toMatch(/Phillips \+ BCI/);
    // Missing Domain is suppressed for the approved distributor-only brand…
    expect(container.querySelector('[data-testid="intake-missing-domain-item_acme"]')).toBeNull();
    // …but still shown for the unapproved brand.
    expect(container.querySelector('[data-testid="intake-missing-domain-item_beta"]')).not.toBeNull();
    // No approve button for the already-approved brand.
    expect(container.querySelector('[data-testid="intake-strategy-approve-item_acme"]')).toBeNull();

    // Unapproved proposal brand offers approval; dispatch carries the
    // proposal sources plus the optimistic-concurrency revision.
    const approveBtn = container.querySelector(
      '[data-testid="intake-strategy-approve-item_beta"]',
    ) as HTMLButtonElement;
    expect(approveBtn).not.toBeNull();
    await act(async () => {
      approveBtn.click();
    });
    expect(approveBrandStrategy).toHaveBeenCalledWith({
      brand: 'Beta',
      sources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
      expectedRevision: 0,
    });
  });
});
