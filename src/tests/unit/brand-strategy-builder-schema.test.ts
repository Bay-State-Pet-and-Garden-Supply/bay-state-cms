// Builder slice B1 — pure contract tests (no bun:sqlite; runs under Vitest).
import { describe, it, expect } from 'vitest';
import {
  ApproveBrandStrategySchema,
  BrandStrategySchema,
  StrategyConfigurationSchema,
} from '../../shared/schemas/brand-strategy';
import { normalizeOfficialDomainInput } from '../../shared/schemas/brand-strategy-domain';

const distributor = (distributorId: string) => ({ kind: 'distributor_record' as const, distributorId });

describe('ApproveBrandStrategySchema guards', () => {
  it('requires expectedRevision (missing guard never writes)', () => {
    expect(
      ApproveBrandStrategySchema.safeParse({ brand: 'Acana', sources: [distributor('phillips')] }).success,
    ).toBe(false);
    expect(
      ApproveBrandStrategySchema.safeParse({ brand: 'Acana', sources: [distributor('phillips')], expectedRevision: 0 }).success,
    ).toBe(true);
  });

  it('requires expectedConfigurationToken whenever configuration is present', () => {
    const configuration = { officialDomains: [], aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory' as const };
    expect(
      ApproveBrandStrategySchema.safeParse({ brand: 'Acana', sources: [distributor('phillips')], expectedRevision: 1, configuration }).success,
    ).toBe(false);
    expect(
      ApproveBrandStrategySchema.safeParse({
        brand: 'Acana', sources: [distributor('phillips')], expectedRevision: 1, configuration, expectedConfigurationToken: 'tok',
      }).success,
    ).toBe(true);
  });

  it('rejects empty, oversized, cross-kind, and unknown-key sources', () => {
    const base = { brand: 'Acana', expectedRevision: 0 };
    expect(ApproveBrandStrategySchema.safeParse({ ...base, sources: [] }).success).toBe(false);
    expect(
      ApproveBrandStrategySchema.safeParse({
        ...base,
        sources: Array.from({ length: 26 }, (_, i) => distributor(`d${i}`)),
      }).success,
    ).toBe(false);
    // Cross-kind extra field passes the shape schema but the repository
    // canonicalizer rejects it (official_page must not carry distributorId
    // and vice versa) — covered by the Bun suite's unknown-refs case.
    // Unknown key rejected by strict().
    expect(
      ApproveBrandStrategySchema.safeParse({ ...base, sources: [{ kind: 'distributor_record', distributorId: 'phillips', bogus: 1 }] }).success,
    ).toBe(false);
    // Missing kind-specific ref rejected.
    expect(
      ApproveBrandStrategySchema.safeParse({ ...base, sources: [{ kind: 'official_page' }] }).success,
    ).toBe(false);
  });

  it('bounds configuration arrays instead of truncating', () => {
    expect(
      StrategyConfigurationSchema.safeParse({
        officialDomains: Array.from({ length: 26 }, (_, i) => `d${i}.example.com`),
        aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory',
      }).success,
    ).toBe(false);
  });
});

describe('normalizeOfficialDomainInput', () => {
  it('accepts hostnames and URLs, normalizing case/www/path', () => {
    expect(normalizeOfficialDomainInput('Acme.COM')).toBe('acme.com');
    expect(normalizeOfficialDomainInput('https://www.acme.com/products/1?x=2')).toBe('acme.com');
    expect(normalizeOfficialDomainInput('http://shop.acme.com')).toBe('shop.acme.com');
  });

  it('rejects credentials, ports, wildcards, IPs, localhost, and non-http schemes', () => {
    expect(normalizeOfficialDomainInput('https://user:pass@acme.com')).toBeNull();
    expect(normalizeOfficialDomainInput('acme.com:8080')).toBeNull();
    expect(normalizeOfficialDomainInput('*.acme.com')).toBeNull();
    expect(normalizeOfficialDomainInput('192.168.1.10')).toBeNull();
    expect(normalizeOfficialDomainInput('localhost')).toBeNull();
    expect(normalizeOfficialDomainInput('intranet')).toBeNull();
    expect(normalizeOfficialDomainInput('ftp://acme.com/file')).toBeNull();
    expect(normalizeOfficialDomainInput('acme .com')).toBeNull();
    expect(normalizeOfficialDomainInput('?x=1')).toBeNull();
  });
});

describe('BrandStrategy read-model additions', () => {
  it('parses proposal sources, options, token, and execution availability', () => {
    const parsed = BrandStrategySchema.safeParse({
      brandKey: 'Acana',
      normalizedBrand: 'acana',
      aliases: [],
      preferredDistributorIds: ['phillips'],
      sourcingPolicy: 'advisory',
      fallbackTier: ['bci'],
      officialDomains: [],
      extractorReadiness: 'profile_bypass_eligible',
      ambiguous: [],
      unmatched: false,
      possibleMatches: [],
      approval: { approved: true, revision: 2, approvedAt: null, approvedBy: null },
      approvedSources: [distributor('phillips')],
      sourceAvailability: [{ kind: 'distributor_record', ref: 'phillips', available: true, reason: 'ready' }],
      collectionReadiness: 'ready',
      proposalSources: [distributor('phillips'), distributor('bci')],
      sourceOptions: [
        { kind: 'distributor_record', ref: 'phillips', displayName: 'phillips', selectable: true, reason: 'ready', available: true },
        { kind: 'distributor_record', ref: 'bci', displayName: 'bci', selectable: true, reason: 'connection_not_configured', available: false },
      ],
      configurationToken: 'tok',
      executionAvailability: { enabled: true, reason: 'default_on' },
    });
    expect(parsed.success).toBe(true);
  });
});
