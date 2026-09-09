import { describe, it, expect } from 'vitest';
import {
  deriveStrategyReadiness,
  strategySummaryLabel,
  strategySourcesEqual,
  INTAKE_KPI_FILTERS,
} from '../../client/components/onboarding/StageItemsView';

describe('strategy readiness (spec #120, ticket #125)', () => {
  it('unloaded strategies read as loading, never ready', () => {
    const r = deriveStrategyReadiness(null, false);
    expect(r.canCollect).toBe(false);
    expect(r.label).toMatch(/Loading/);
  });

  it('unapproved strategy awaits approval', () => {
    const r = deriveStrategyReadiness(null, true);
    expect(r.label).toBe('Awaiting strategy approval');
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
    expect(r.label).toMatch(/Ready · 2 available/);
    expect(r.label).toMatch(/acme\.com needs setup/);
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
    expect(r.label).toMatch(/Setup attention/);
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

  it('KPI quick filters have no strategy states yet (explicit follow-up gap)', () => {
    // Strategy readiness is visible per row but not quick-filterable:
    // no chip exists for awaiting_approval or setup_attention.
    expect([...INTAKE_KPI_FILTERS]).toEqual(['all', 'missing-brand', 'missing-domain', 'distributor', 'ready']);
  });

  it.todo('strategy readiness quick filters (awaiting_approval / setup_attention chips)');
});
