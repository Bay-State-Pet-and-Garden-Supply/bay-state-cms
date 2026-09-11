/**
 * B3 — pure builder-model coverage (Vitest).
 *
 * Canonical keys, approved-first initialization, proposal application,
 * include/mapping effects, payload shape, and validation bounds.
 */
import { describe, it, expect } from 'vitest';
import type { BrandStrategy, StrategySourceRef } from '../../shared/schemas/brand-strategy';
import {
  applyProposalToEdit,
  buildSavePayload,
  canonicalizeSources,
  initEditFromApproved,
  rebaseEditOntoLatest,
  sourceKey,
  sourceSetsEqual,
  stageRemoveMapping,
  summarizeEdit,
  toggleIncluded,
  validateEdit,
} from '../../client/components/brand-strategy/brand-strategy-builder-model';

function strategy(overrides: Partial<BrandStrategy> = {}): BrandStrategy {
  return {
    brandKey: 'Acme',
    normalizedBrand: 'acme',
    officialDomains: [{ domain: 'acme.com', sitemap: { totalUrls: 10, freshCount: 10, lastRefreshAt: null, freshness: 'fresh' } }],
    proposalSources: [{ kind: 'distributor_record', distributorId: 'bci' }],
    sourceOptions: [
      { kind: 'official_page', ref: 'acme.com', displayName: 'acme.com', selectable: true, reason: 'mapped', available: false },
      { kind: 'distributor_record', ref: 'phillips', displayName: 'Phillips', selectable: true, reason: 'enabled', available: true },
      { kind: 'distributor_record', ref: 'bci', displayName: 'BCI', selectable: true, reason: 'enabled', available: true },
    ],
    configurationToken: 'tok-1',
    approval: { approved: true, revision: 3, approvedAt: '2026-01-01', approvedBy: 'op' },
    approvedSources: [
      { kind: 'official_page', domain: 'acme.com' },
      { kind: 'distributor_record', distributorId: 'phillips' },
    ],
    sourceAvailability: [
      { kind: 'official_page', ref: 'acme.com', available: false, reason: 'not_supported' },
      { kind: 'distributor_record', ref: 'phillips', available: true, reason: 'ready' },
    ],
    collectionReadiness: 'ready_partial',
    extractorReadiness: 'active',
    ambiguous: [],
    unmatched: false,
    possibleMatches: [],
    ...overrides,
  } as BrandStrategy;
}

describe('builder model keys', () => {
  it('normalizes official domains and dedupes by typed identity', () => {
    const refs: StrategySourceRef[] = [
      { kind: 'official_page', domain: 'ACME.com' },
      { kind: 'official_page', domain: ' acme.com ' },
      { kind: 'distributor_record', distributorId: 'Phillips' },
      { kind: 'distributor_record', distributorId: 'Phillips' },
    ];
    expect(canonicalizeSources(refs)).toEqual([
      { kind: 'official_page', domain: 'acme.com' },
      { kind: 'distributor_record', distributorId: 'Phillips' },
    ]);
  });

  it('distinguishes kinds and compares sets order-insensitively', () => {
    const a: StrategySourceRef[] = [
      { kind: 'official_page', domain: 'acme.com' },
      { kind: 'distributor_record', distributorId: 'phillips' },
    ];
    const b: StrategySourceRef[] = [...a].reverse();
    expect(sourceSetsEqual(a, b)).toBe(true);
    expect(sourceSetsEqual(a, [{ kind: 'distributor_record', distributorId: 'acme.com' }])).toBe(false);
    expect(sourceKey({ kind: 'official_page', domain: 'Acme.COM' })).toBe('official_page:acme.com');
  });
});

describe('builder edit init', () => {
  it('initializes exactly from the approved boundary, not the drifted proposal', () => {
    const edit = initEditFromApproved(strategy(), 'Acme');
    expect(edit.included).toEqual([
      { kind: 'official_page', domain: 'acme.com' },
      { kind: 'distributor_record', distributorId: 'phillips' },
    ]);
    expect(edit.baseRevision).toBe(3);
    expect(edit.baseConfigurationToken).toBe('tok-1');
    const summary = summarizeEdit(edit, strategy());
    expect(summary.sourcesChanged).toBe(false);
    expect(summary.proposalDiffersFromApproved).toBe(true);
  });

  it('Use current proposal changes the local edit only', () => {
    const edit = applyProposalToEdit(initEditFromApproved(strategy(), 'Acme'), strategy());
    expect(edit.included).toEqual([{ kind: 'distributor_record', distributorId: 'bci' }]);
    expect(edit.usedProposal).toBe(true);
    expect(summarizeEdit(edit, strategy()).sourcesChanged).toBe(true);
  });

  it('unapproved strategies start empty', () => {
    const edit = initEditFromApproved(strategy({ approval: { approved: false, revision: 0, approvedAt: null, approvedBy: null }, approvedSources: [] }), 'Beta');
    expect(edit.included).toEqual([]);
    expect(edit.baseRevision).toBe(0);
  });
});

describe('builder edit effects', () => {
  it('include toggle and mapping removal have distinct effects', () => {
    const base = initEditFromApproved(strategy(), 'Acme');
    expect('preferredDistributorIds' in base).toBe(false);
    expect('aliases' in base).toBe(false);
    expect('sourcingPolicy' in base).toBe(false);
    const withoutPhillips = toggleIncluded(base, { kind: 'distributor_record', distributorId: 'phillips' });
    expect(withoutPhillips.included).toEqual([{ kind: 'official_page', domain: 'acme.com' }]);

    const removed = stageRemoveMapping(base, 'acme.com');
    expect(removed.officialDomains).toEqual([]);
    expect(removed.included).toEqual([{ kind: 'distributor_record', distributorId: 'phillips' }]);
  });

  it('rebase keeps selections while adopting the latest guards', () => {
    const base = toggleIncluded(initEditFromApproved(strategy(), 'Acme'), { kind: 'distributor_record', distributorId: 'bci' });
    const rebased = rebaseEditOntoLatest(base, strategy({ approval: { approved: true, revision: 4, approvedAt: '2026-02-01', approvedBy: 'op2' }, configurationToken: 'tok-2' }));
    expect(rebased.baseRevision).toBe(4);
    expect(rebased.baseConfigurationToken).toBe('tok-2');
    expect(rebased.included).toEqual(base.included);
  });
});

describe('builder payload + validation', () => {
  it('emits one combined request with original revision/token, including config-only saves', () => {
    const payload = buildSavePayload(initEditFromApproved(strategy(), 'Acme'));
    expect(payload).toMatchObject({
      brand: 'Acme',
      expectedRevision: 3,
      expectedConfigurationToken: 'tok-1',
    });
    if ('error' in (payload as object)) throw new Error('expected payload');
    expect((payload as { configuration: object }).configuration).toEqual({
      officialDomains: ['acme.com'],
    });
    expect(Object.keys((payload as { configuration: object }).configuration)).toEqual(['officialDomains']);
  });

  it('rejects empty sets, oversized selections, and missing tokens', () => {
    const empty = initEditFromApproved(strategy(), 'Acme');
    empty.included = [];
    expect(validateEdit(empty).ok).toBe(false);
    expect(validateEdit(empty).errors.join(' ')).toMatch(/at least one source/);

    const big = initEditFromApproved(strategy(), 'Acme');
    big.included = Array.from({ length: 26 }, (_, i) => ({ kind: 'distributor_record' as const, distributorId: `d${i}` }));
    expect(validateEdit(big).ok).toBe(false);

    const noToken = initEditFromApproved(strategy({ configurationToken: undefined }), 'Acme');
    expect(buildSavePayload(noToken)).toMatchObject({ error: expect.stringMatching(/token/i) });

    const noBrand = initEditFromApproved(strategy(), '');
    expect(validateEdit(noBrand).ok).toBe(false);
  });
});
