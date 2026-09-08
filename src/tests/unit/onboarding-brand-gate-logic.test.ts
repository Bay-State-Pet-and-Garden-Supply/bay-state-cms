/**
 * Slice 3 — brand gate pure-logic suite (Vitest, DOM-free).
 *
 * Covers the empty/error matrix from the council plan §6 Slice 3:
 * blockers-[] + preflight-error ⇒ unknown (never healthy); mixed
 * ready/blocked ⇒ ready continues; failed blocker read + valid preflight ⇒
 * measured preflight coverage with the parked check unknown; both succeed
 * complete ⇒ measured coverage (never authority approval); plus the
 * per-item row classification (mapped/missing/unmapped/mismatched/
 * distributor-exempt) with policy-v0 and no-inference guarantees.
 */
import { describe, it, expect } from 'vitest';
import type {
  BatchPreflightResponse,
  PreflightDomainBlocker,
} from '../../shared/schemas/onboarding';
import type {
  BrandDomainSetupResponse,
  OnboardingWorkState,
} from '../../shared/schemas/onboarding-work-state';
import {
  BRAND_ROW_KIND_ADVICE,
  buildBrandRowContext,
  classifyBrandRow,
  deriveBrandGateHealth,
  selectBrandGateGroups,
  type BrandRowContext,
} from '../../client/components/onboarding/brand-gate-logic';

function makePreflight(overrides: Partial<BatchPreflightResponse> = {}): BatchPreflightResponse {
  return {
    batchId: 'batch-1',
    batchName: 'Batch 1',
    executionState: 'draft',
    totalItems: 10,
    readyCount: 6,
    heldCount: 4,
    readyItemIds: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    heldItemIds: ['h1', 'h2', 'h3', 'h4'],
    metrics: {
      brandResolvedCount: 6,
      brandResolvedPercent: 60,
      ambiguousBrandCount: 2,
      missingBrandCount: 2,
      domainMappedCount: 6,
      domainMappedPercent: 60,
      missingDomainBrandCount: 1,
      distributorRoutedCount: 6,
      distributorRoutedPercent: 60,
      unroutedBrandCount: 1,
    },
    blockers: {
      needsBrandGroups: [
        {
          key: 'suggested:acme',
          suggestedBrand: 'Acme',
          itemCount: 2,
          itemIds: ['h1', 'h2'],
          sampleProductNames: ['ACME WIDGET'],
        },
      ],
      missingDomainBrands: [
        {
          brand: 'CustomBrandX',
          itemCount: 2,
          itemIds: ['h3', 'h4'],
          sampleProductNames: ['CUSTOM X'],
        },
      ],
      unroutedBrands: [],
    },
    availableDistributors: [],
    knownBrands: ['Acme'],
    ...overrides,
  };
}

function makeBlockers(brands: string[] = ['CustomBrandX']): BrandDomainSetupResponse {
  return {
    blockers: brands.map((brand) => ({
      brand,
      blockedItemCount: 2,
      batchId: 'batch-1',
      itemIds: ['h3', 'h4'],
      sampleItems: [{ itemId: 'h3', upc: '123', name: 'CUSTOM X', sourceUrl: null }],
      existingMapping: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  };
}

function makeRow(overrides: Partial<OnboardingWorkState> = {}): OnboardingWorkState {
  return {
    itemId: 'item-1',
    category: 'needs_attention',
    activity: null,
    label: 'Needs attention',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    stage: 'sourcing',
    stageStatus: 'pending',
    upc: '012345678901',
    name: 'ACME WIDGET 10LB',
    brand: null,
    sourceType: null,
    domain: null,
    ...overrides,
  } as OnboardingWorkState;
}

const EMPTY_CTX: BrandRowContext = { unmappedBrands: new Set(), parkedBrands: new Set() };

describe('deriveBrandGateHealth empty/error matrix', () => {
  it('loading with no data yet renders loading (never healthy)', () => {
    const health = deriveBrandGateHealth({
      preflight: null,
      preflightError: null,
      preflightLoading: true,
      blockers: null,
      blockersError: null,
      blockersLoading: true,
    });
    expect(health.state).toBe('loading');
    expect(health.readyCount).toBeNull();
    expect(health.parkedCheckUnknown).toBe(true);
  });

  it('both reads failed renders error (never healthy)', () => {
    const health = deriveBrandGateHealth({
      preflight: null,
      preflightError: 'boom-preflight',
      preflightLoading: false,
      blockers: null,
      blockersError: 'boom-blockers',
      blockersLoading: false,
    });
    expect(health.state).toBe('error');
    expect(health.detail).toContain('boom-preflight');
    expect(health.detail).toContain('boom-blockers');
    expect(health.parkedCheckUnknown).toBe(true);
  });

  it('blockers [] + preflight error renders UNKNOWN, never healthy', () => {
    const health = deriveBrandGateHealth({
      preflight: null,
      preflightError: 'preflight down',
      preflightLoading: false,
      blockers: { blockers: [] },
      blockersError: null,
      blockersLoading: false,
    });
    expect(health.state).toBe('unknown');
    expect(health.state).not.toBe('measured');
    expect(health.readyCount).toBeNull();
    expect(health.detail).toMatch(/never proves.*healthy/i);
  });

  it('blockers [] + preflight still loading renders UNKNOWN, never healthy', () => {
    const health = deriveBrandGateHealth({
      preflight: null,
      preflightError: null,
      preflightLoading: true,
      blockers: { blockers: [] },
      blockersError: null,
      blockersLoading: false,
    });
    expect(health.state).toBe('unknown');
    expect(health.readyCount).toBeNull();
  });

  it('failed blocker read + valid preflight shows only measured preflight coverage with parked check unknown', () => {
    const preflight = makePreflight();
    const health = deriveBrandGateHealth({
      preflight,
      preflightError: null,
      preflightLoading: false,
      blockers: null,
      blockersError: 'blockers down',
      blockersLoading: false,
    });
    expect(health.state).toBe('attention');
    expect(health.parkedCheckUnknown).toBe(true);
    expect(health.readyCount).toBe(6);
    expect(health.detail).toMatch(/measured preflight coverage/i);
  });

  it('blockers [] + successful preflight with missing mappings renders a mapping warning, not all-green', () => {
    const preflight = makePreflight();
    const health = deriveBrandGateHealth({
      preflight,
      preflightError: null,
      preflightLoading: false,
      blockers: { blockers: [] },
      blockersError: null,
      blockersLoading: false,
    });
    expect(health.state).toBe('attention');
    expect(health.state).not.toBe('measured');
    expect(health.headline).toMatch(/attention needed/i);
  });

  it('both reads succeed with complete coverage renders measured mapping coverage, not authority approval', () => {
    const preflight = makePreflight({
      readyCount: 10,
      heldCount: 0,
      heldItemIds: [],
      blockers: { needsBrandGroups: [], missingDomainBrands: [], unroutedBrands: [] },
    });
    const health = deriveBrandGateHealth({
      preflight,
      preflightError: null,
      preflightLoading: false,
      blockers: { blockers: [] },
      blockersError: null,
      blockersLoading: false,
    });
    expect(health.state).toBe('measured');
    expect(health.detail).toMatch(/not worker or source-authority approval/i);
    expect(health.parkedCheckUnknown).toBe(false);
  });

  it('mixed ready/blocked fixtures keep ready continuation available (no batch-wide gate)', () => {
    const health = deriveBrandGateHealth({
      preflight: makePreflight({ readyCount: 6, heldCount: 4 }),
      preflightError: null,
      preflightLoading: false,
      blockers: makeBlockers(),
      blockersError: null,
      blockersLoading: false,
    });
    expect(health.readyCanContinue).toBe(true);
    expect(health.readyCount).toBe(6);
    expect(health.heldCount).toBe(4);
    expect(health.detail).toMatch(/controlled-release/i);
  });

  it('fully held batch does not claim ready continuation', () => {
    const health = deriveBrandGateHealth({
      preflight: makePreflight({ readyCount: 0, heldCount: 10 }),
      preflightError: null,
      preflightLoading: false,
      blockers: makeBlockers(),
      blockersError: null,
      blockersLoading: false,
    });
    expect(health.readyCanContinue).toBe(false);
  });
});

describe('classifyBrandRow server-owned states', () => {
  const ctx = buildBrandRowContext(
    [{ brand: 'CustomBrandX', itemCount: 2, itemIds: ['h3'] } as PreflightDomainBlocker],
    makeBlockers(['ParkedBrand']).blockers,
  );

  it('mapped official item: brand + domain, absent from blocker lists', () => {
    const row = classifyBrandRow(
      makeRow({ brand: 'Acme', domain: 'acme.com', sourceType: 'official_page' }),
      ctx,
    );
    expect(row.kind).toBe('mapped_official');
  });

  it('missing brand item', () => {
    const row = classifyBrandRow(makeRow({ brand: null }), EMPTY_CTX);
    expect(row.kind).toBe('missing_brand');
    expect(row.advice).toBe(BRAND_ROW_KIND_ADVICE.missing_brand);
  });

  it('server brand_not_provided reason is missing brand even with a blank string', () => {
    const row = classifyBrandRow(
      makeRow({ brand: '  ', attentionReason: 'brand_not_provided' }),
      EMPTY_CTX,
    );
    expect(row.kind).toBe('missing_brand');
  });

  it('assigned but unmapped brand via the preflight list', () => {
    const row = classifyBrandRow(makeRow({ brand: 'CustomBrandX' }), ctx);
    expect(row.kind).toBe('unmapped_brand');
  });

  it('assigned but unmapped brand via the parked blocker list', () => {
    const row = classifyBrandRow(makeRow({ brand: 'ParkedBrand' }), ctx);
    expect(row.kind).toBe('unmapped_brand');
  });

  it('unknown/mismatched official authority still blocks official auto-accept', () => {
    for (const reason of ['verify_official_url', 'choose_official_url', 'no_official_url'] as const) {
      const row = classifyBrandRow(
        makeRow({ brand: 'Acme', domain: 'acme.com', attentionReason: reason }),
        EMPTY_CTX,
      );
      expect(row.kind).toBe('mismatched_authority');
      expect(row.advice).toMatch(/blocks official auto-accept/i);
    }
  });

  it('qualified distributor with no official domain/null URL stays extraction-eligible and profile-free', () => {
    const row = classifyBrandRow(
      makeRow({ brand: 'SupplierBrand', sourceType: 'distributor_record', domain: null }),
      ctx,
    );
    expect(row.kind).toBe('distributor_exempt');
    expect(row.advice).toMatch(/extraction-eligible.*profile-free/i);
  });

  it('distributor exemption wins over an unmapped brand name (never forced through a domain)', () => {
    const row = classifyBrandRow(
      makeRow({ brand: 'CustomBrandX', sourceType: 'distributor_record', domain: null }),
      ctx,
    );
    expect(row.kind).toBe('distributor_exempt');
  });

  it('emits no provisional-domain, alias-inference, or new brand_status/source_policy fields (policy-v0 unchanged)', () => {
    const row = classifyBrandRow(
      makeRow({ brand: 'Acme', sourceType: 'official_page', domain: 'acme.com' }),
      ctx,
    );
    const keys = Object.keys(row);
    expect(keys).not.toContain('brand_status');
    expect(keys).not.toContain('source_policy');
    expect(keys).not.toContain('provisionalDomain');
    expect(keys).not.toContain('inferredDomain');
    expect(JSON.stringify(row)).not.toMatch(/provisional|alias|inferred/i);
  });
});

describe('selectBrandGateGroups passes server groups through untouched', () => {
  it('returns the existing preflight groups and held count', () => {
    const preflight = makePreflight();
    const groups = selectBrandGateGroups(preflight);
    expect(groups.needsBrandGroups).toBe(preflight.blockers.needsBrandGroups);
    expect(groups.missingDomainBrands).toBe(preflight.blockers.missingDomainBrands);
    expect(groups.totalHeld).toBe(4);
  });

  it('null preflight yields empty groups without inventing any', () => {
    expect(selectBrandGateGroups(null)).toEqual({
      needsBrandGroups: [],
      missingDomainBrands: [],
      totalHeld: 0,
    });
  });
});
