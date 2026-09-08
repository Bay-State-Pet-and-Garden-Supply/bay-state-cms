import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeBrandHubDomain } from '../../onboarding/brand-hub/normalizeDomain';

// story: e06s01 — use hoisted mock to avoid bun:sqlite in vitest (node) environment
vi.mock('@/db/connection', () => {
  const fakeDb = {
    query: (sql: string) => {
      if (sql.includes('FROM extractor_profiles')) {
        return { get: () => ({ updated_at: '2026-08-20T10:00:00.000Z', id: 'p_test' }) };
      }
      if (sql.includes('FROM brand_sites')) {
        return { all: () => [{ brand_name: 'acme' }] };
      }
      if (sql.includes('FROM brand_url_index')) {
        return { get: () => ({ total: 1, active: 1, freshness: '2026-08-20T10:00:00.000Z' }) };
      }
      if (sql.includes('FROM onboarding_items')) {
        return { get: () => ({ c: 5 }) };
      }
      return { get: () => null, all: () => [] };
    },
    exec: () => {},
    prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
    transaction: (fn: () => unknown) => fn,
  };
  return { getDb: () => fakeDb, isDbInitialized: () => true };
});

// story: e06s01
describe('domain profile state (e06s01)', () => {
  it('normalizes WWW, scheme, path variants identically', async () => {
    expect(normalizeBrandHubDomain('WWW.EXAMPLE.COM/')).toBe('example.com');
    expect(normalizeBrandHubDomain('https://www.example.com/path')).toBe('example.com');
    expect(normalizeBrandHubDomain('https://EXAMPLE.com')).toBe('example.com');
    expect(normalizeBrandHubDomain('example.com')).toBe('example.com');
  });

  it('GET profile-state returns identical header for variant domains', async () => {
    const { getDomainProfileState } = await import('../../db/repositories/domain-profile-state-repo');
    const a = getDomainProfileState('WWW.EXAMPLE.COM');
    const b = getDomainProfileState('https://www.example.com/path');
    expect(a.domain).toBe('example.com');
    expect(b.domain).toBe('example.com');
    expect(a.domain).toBe(b.domain);
    expect(a.activeVersion).toBe(b.activeVersion);
    expect(a.productCount).toBe(1);
  });

  it('returns header with brandAssociations, activeVersion, freshness, blockedCount', async () => {
    const { getDomainProfileState } = await import('../../db/repositories/domain-profile-state-repo');
    const state = getDomainProfileState('example.com');
    expect(state.domain).toBe('example.com');
    expect(state.brandAssociations).toContain('acme');
    expect(state.activeVersion).not.toBeNull();
    expect(state.freshness).not.toBeNull();
    expect(typeof state.blockedCount).toBe('number');
    expect(typeof state.productCount).toBe('number');
  });
});
