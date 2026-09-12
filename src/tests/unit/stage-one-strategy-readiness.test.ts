import { describe, it, expect } from 'vitest';
import {
  deriveStrategyReadiness,
  strategySummaryLabel,
  strategySourcesEqual,
  INTAKE_KPI_FILTERS,
} from '../../client/components/onboarding/StageItemsView';
import type { CollectionReadiness } from '../../shared/schemas/onboarding-stage-read';

function perItemDecision(overrides: Partial<CollectionReadiness> = {}): CollectionReadiness {
  return {
    itemId: 'item-1',
    path: 'approved_strategy',
    readiness: 'ready',
    canCollect: true,
    canExecuteNow: true,
    effectiveRevision: 1,
    reasons: [],
    requires: 'pinned_resume',
    effectiveSources: [
      { kind: 'distributor_record', ref: 'phillips' },
      { kind: 'distributor_record', ref: 'bci' },
    ],
    sourceAvailability: [
      { kind: 'distributor_record', ref: 'phillips', distributorId: 'phillips', usable: true, reason: 'Available' },
      { kind: 'distributor_record', ref: 'bci', distributorId: 'bci', usable: true, reason: 'Available' },
    ],
    label: 'Ready · 2 sources available',
    explanation: 'Ready means collection can run.',
    strategyLabel: 'phillips + bci',
    ...overrides,
  };
}

describe('strategy readiness (spec #120, ticket #125)', () => {
  it('unloaded strategies read as loading, never ready', () => {
    const r = deriveStrategyReadiness(null, false);
    expect(r.canCollect).toBe(false);
    expect(r.label).toBe('Loading collection readiness…');
  });

  it('unapproved strategy awaits approval', () => {
    const r = deriveStrategyReadiness(null, true);
    expect(r.label).toBe('Awaiting approval');
    expect(r.strategyLabel).toBe('Suggested sources');
    expect(r.suppressMissingDomain).toBe(false);
  });

  it('approved Phillips + BCI with no official site is ready and excuses Missing Domain', () => {
    const r = deriveStrategyReadiness({
      approved: true,
      revision: 1,
      sources: [
        { kind: 'distributor_record', distributorId: 'Phillips' },
        { kind: 'distributor_record', distributorId: 'BCI' },
      ],
      availability: [
        { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
        { kind: 'distributor_record', ref: 'BCI', available: true, reason: 'ready' },
      ],
      readiness: 'ready',
    }, true);
    expect(r.strategyLabel).toBe('Phillips + BCI');
    expect(r.label).toBe('Ready · 2 sources available');
    expect(r.suppressMissingDomain).toBe(true);
    expect(r.canCollect).toBe(true);
  });

  it('approved official + distributors with broken profile is partial, website needs setup', () => {
    const r = deriveStrategyReadiness({
      approved: true,
      revision: 2,
      sources: [
        { kind: 'official_page', domain: 'acme.com' },
        { kind: 'distributor_record', distributorId: 'Phillips' },
        { kind: 'distributor_record', distributorId: 'BCI' },
      ],
      availability: [
        { kind: 'official_page', ref: 'acme.com', available: false, reason: 'no_profile' },
        { kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' },
        { kind: 'distributor_record', ref: 'BCI', available: true, reason: 'ready' },
      ],
      readiness: 'ready_partial',
    }, true);
    expect(r.strategyLabel).toBe('Official website + Phillips + BCI');
    expect(r.label).toBe('Ready — partial · 2 sources available; website needs setup');
    expect(r.suppressMissingDomain).toBe(false);
    expect(r.canCollect).toBe(true);
  });

  it('approved strategy with no usable sources needs setup and cannot collect', () => {
    const r = deriveStrategyReadiness({
      approved: true,
      revision: 1,
      sources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
      availability: [{ kind: 'distributor_record', ref: 'Phillips', available: false, reason: 'connection_not_configured' }],
      readiness: 'setup_attention',
    }, true);
    expect(r.canCollect).toBe(false);
    expect(r.label).toBe('Setup attention · No usable sources');
    // Ticket #125 (F3): the boundary plans no official collection, so the
    // row still excuses domain/profile work while every leg is down.
    expect(r.suppressMissingDomain).toBe(true);
  });

  it('failed strategy reads never render as loading', () => {
    const r = deriveStrategyReadiness(null, true, true);
    expect(r.label).toBe('Collection readiness unavailable · Retry');
    expect(r.canCollect).toBe(false);
  });

  it('underway collections name the approved revision', () => {
    const r = deriveStrategyReadiness({
      approved: true,
      revision: 3,
      underway: true,
      sources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
      availability: [{ kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' }],
      readiness: 'ready',
    }, true);
    expect(r.label).toBe('Underway · Collecting approved revision 3');
    expect(r.canCollect).toBe(false);
  });

  it('approved rows use strategy readiness in counts and filters, retiring the domain gate', async () => {
    const mod = await import('../../client/components/onboarding/StageItemsView');
    const items = [
      { brand: 'Acana', sourceType: 'distributor_record', domain: null },
      { brand: 'Unknown', sourceType: 'official_page', domain: null },
    ] as never[];
    const domainMap = new Map<string, string>();
    const forBrand = (brand: string | null) =>
      brand === 'Acana' ? { approved: true, canCollect: true, suppressMissingDomain: true } : null;
    const counts = mod.countIntakeKpis(items, domainMap, new Set(), forBrand);
    expect(counts.ready).toBe(1);
    // The approved Acana row contributes no missing-domain; the legacy
    // Unknown row keeps the universal gate.
    expect(counts.missingDomain).toBe(1);
    expect(mod.matchesIntakeFilter(items[0] as never, 'ready', domainMap, new Set(), forBrand)).toBe(true);
    expect(mod.matchesIntakeFilter(items[0] as never, 'missing-domain', domainMap, new Set(), forBrand)).toBe(false);
    // Legacy rows keep the universal gate.
    expect(mod.matchesIntakeFilter(items[1] as never, 'missing-domain', domainMap, new Set(), forBrand)).toBe(true);
  });

  it('strategySummaryLabel falls back for proposals', () => {
    expect(strategySummaryLabel(null)).toBe('Suggested sources');
  });

  it('strategySourcesEqual compares boundaries order-sensitively', () => {
    const a = [
      { kind: 'distributor_record' as const, distributorId: 'Phillips' },
      { kind: 'official_page' as const, domain: 'Acme.com' },
    ];
    expect(strategySourcesEqual(a, [
      { kind: 'distributor_record' as const, distributorId: 'Phillips' },
      { kind: 'official_page' as const, domain: 'acme.com' },
    ])).toBe(true);
    expect(strategySourcesEqual(a, [{ kind: 'distributor_record' as const, distributorId: 'Phillips' }])).toBe(false);
    expect(strategySourcesEqual(a, [a[1], a[0]])).toBe(false);
  });

  it('per-item server decisions govern counts/filters over brand-level facts (F1)', async () => {
    // The brand-level view claims approval, but this item's own generation
    // is retired: the per-item decision (blocked/setup_attention) wins for
    // both counts and filters — brand-level Ready must not overstate it.
    const mod = await import('../../client/components/onboarding/StageItemsView');
    const parked = perItemDecision({
      itemId: 'item-parked',
      path: 'blocked',
      readiness: 'setup_attention',
      canCollect: false,
      canExecuteNow: false,
      effectiveRevision: null,
      requires: 'explicit_retry',
      effectiveSources: [],
      label: 'Setup attention · No usable sources',
      explanation: null,
    });
    const items = [
      { itemId: 'item-parked', brand: 'Acana', sourceType: 'distributor_record', domain: null },
      { itemId: 'item-ready', brand: 'Acana', sourceType: 'distributor_record', domain: null },
    ] as never[];
    const domainMap = new Map<string, string>();
    const forBrand = () => ({ approved: true, canCollect: true, suppressMissingDomain: true });
    const forItem = (id: string) => (id === 'item-parked' ? mod.collectionFactsFor(parked) : mod.collectionFactsFor(perItemDecision({ itemId: id })));
    // collectionFactsFor is authoritative for present decisions:
    // non-approved paths return a non-approved verdict (never a borrowed
    // brand Ready), approved paths return collect/suppress facts.
    expect(mod.collectionFactsFor(parked))
      .toEqual({ approved: false, canCollect: false, suppressMissingDomain: false });
    expect(mod.collectionFactsFor(null)).toBeNull();
    expect(mod.collectionFactsFor(perItemDecision({ itemId: 'item-ready' })))
      .toEqual({ approved: true, canCollect: true, suppressMissingDomain: true });
    const counts = mod.countIntakeKpis(items, domainMap, new Set(), forBrand, forItem);
    expect(counts.ready).toBe(1);
    expect(mod.matchesIntakeFilter(items[0] as never, 'ready', domainMap, new Set(), forBrand, forItem)).toBe(false);
    expect(mod.matchesIntakeFilter(items[1] as never, 'ready', domainMap, new Set(), forBrand, forItem)).toBe(true);
    // Without per-item facts the same rows keep the brand fallback.
    expect(mod.matchesIntakeFilter(items[0] as never, 'ready', domainMap, new Set(), forBrand)).toBe(true);
  });

  it('chip set is unchanged by design; existing chips filter on per-item server facts', () => {
    // Ticket #125 (F1): no new awaiting_approval/setup_attention chips —
    // the five legacy chips stay, but they now read the same per-item
    // server decisions as the table (see 'per-item server decisions govern
    // counts/filters' above and the server collectionReadiness/
    // collectionPath filters). Non-approved rows surface under 'all' with
    // their exact server label instead of a legacy bucket.
    expect([...INTAKE_KPI_FILTERS]).toEqual(['all', 'missing-brand', 'missing-domain', 'distributor', 'ready']);
  });
});
