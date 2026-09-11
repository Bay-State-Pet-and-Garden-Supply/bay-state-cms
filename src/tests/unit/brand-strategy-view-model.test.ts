// Issue #150 — deriveBrandStrategies exact authority without advisory inputs
import { describe, it, expect } from 'vitest';
import { deriveBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-derive';

describe('deriveBrandStrategies', () => {
  it('derives domain, readiness, and live proposal from mappings + enabled connections', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Fromm', domain: 'frommfamily.com' }],
      sitemapByDomain: new Map([['frommfamily.com', { totalUrls: 142, lastRefreshAt: new Date().toISOString(), activeCount: 142 }]]),
      readinessByDomain: new Map([['frommfamily.com', 'active']]),
      enabledDistributorIds: ['phillips', 'bradley'],
    });
    const fromm = strategies.find((s) => s.normalizedBrand === 'fromm');
    expect(fromm).toBeDefined();
    expect(fromm!.officialDomains[0].domain).toBe('frommfamily.com');
    expect(fromm!.officialDomains[0].sitemap.totalUrls).toBe(142);
    expect(fromm!.extractorReadiness).toBe('active');
    // Live proposal: mapped domains plus every enabled distributor, deduplicated.
    expect(fromm!.proposalSources).toEqual([
      { kind: 'official_page', domain: 'frommfamily.com' },
      { kind: 'distributor_record', distributorId: 'phillips' },
      { kind: 'distributor_record', distributorId: 'bradley' },
    ]);
  });

  it('advisory-only brands no longer create strategy-list rows', () => {
    const strategies = deriveBrandStrategies({ brandSites: [] });
    expect(strategies).toEqual([]);
  });

  it('ambiguous whitespace/punct not silently joined, surfaced as diagnostic', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [
        { brandName: 'three dog', domain: 'threedog.com' },
        { brandName: 'threedog', domain: 'threedog-shop.com' },
      ],
    });
    // Exact keys are "three dog" and "threedog" — distinct
    expect(strategies.map((s) => s.normalizedBrand).sort()).toEqual(['three dog', 'threedog']);
    const threeDog = strategies.find((s) => s.normalizedBrand === 'three dog')!;
    const threedog = strategies.find((s) => s.normalizedBrand === 'threedog')!;
    // Both should have ambiguous diagnostic pointing to the other
    expect(threeDog.ambiguous.length).toBe(1);
    expect(threeDog.ambiguous[0].candidateBrand).toBe('threedog');
    expect(threedog.ambiguous.length).toBe(1);
    expect(threedog.ambiguous[0].candidateBrand).toBe('three dog');
  });

  it('unmatched means no mapped domain and no approved distributor source', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [],
      approvals: new Map([['solo', { approved: true, revision: 1, approvedAt: null, approvedBy: null, brand: 'Solo', sources: [] }]]),
    });
    expect(strategies.length).toBe(1);
    expect(strategies[0].unmatched).toBe(true);
  });

  it('mapped brand without approval is matched, not unmatched', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Solo', domain: 'solo.example.com' }],
    });
    expect(strategies.length).toBe(1);
    expect(strategies[0].unmatched).toBe(false);
  });

  it('approval-only brand retains stored display spelling', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [],
      approvals: new Map([['acme', {
        approved: true, revision: 1, approvedAt: null, approvedBy: null,
        brand: 'ACME Co.', sources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
      }]]),
      enabledDistributorIds: ['phillips'],
    });
    const s = strategies.find((x) => x.normalizedBrand === 'acme')!;
    expect(s.brandKey).toBe('ACME Co.');
    expect(s.normalizedBrand).toBe('acme');
    // Approved distributor-only boundary is profile_bypass_eligible.
    expect(s.extractorReadiness).toBe('profile_bypass_eligible');
    expect(s.unmatched).toBe(false);
    expect(s.sourceAvailability).toEqual([
      { kind: 'distributor_record', ref: 'phillips', available: true, reason: 'ready' },
    ]);
  });

  it('display fallback prefers mapping spelling over stored approval spelling', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'FROMM', domain: 'frommfamily.com' }],
      approvals: new Map([['fromm', {
        approved: true, revision: 1, approvedAt: null, approvedBy: null,
        brand: 'Fromm', sources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
      }]]),
    });
    const s = strategies.find((x) => x.normalizedBrand === 'fromm')!;
    expect(s.brandKey).toBe('FROMM');
    expect(s.normalizedBrand).toBe('fromm');
  });

  it('no-domain unapproved brand with enabled connections stays not_configured', () => {
    // Enabled connections alone never confer bypass eligibility.
    const strategies = deriveBrandStrategies({
      brandSites: [],
      approvals: new Map([['solo', { approved: false, revision: 0, approvedAt: null, approvedBy: null, brand: 'Solo' }]]),
      enabledDistributorIds: ['phillips'],
    });
    expect(strategies[0].extractorReadiness).toBe('not_configured');
    expect(strategies[0].unmatched).toBe(true);
  });

  it('approved official_page refs stay not_supported, never ready', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Acana', domain: 'acana.com' }],
      approvals: new Map([['acana', {
        approved: true, revision: 1, approvedAt: null, approvedBy: null,
        brand: 'Acana', sources: [{ kind: 'official_page', domain: 'acana.com' }],
      }]]),
      readinessByDomain: new Map([['acana.com', 'active']]),
    });
    const acana = strategies.find((s) => s.normalizedBrand === 'acana')!;
    expect(acana.sourceAvailability).toEqual([
      { kind: 'official_page', ref: 'acana.com', available: false, reason: 'not_supported' },
    ]);
    expect(acana.collectionReadiness).toBe('setup_attention');
  });
});
