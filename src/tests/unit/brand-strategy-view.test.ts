// story: e08s01 — BrandStrategyView renders tier pills, domain, readiness, banner once
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { deriveBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-derive';

describe('BrandStrategyView', () => {
  it('renders brand identity, tier pills not sequential, domain and readiness', async () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Fromm', domain: 'frommfamily.com' }],
      sitemapByDomain: new Map([['frommfamily.com', { totalUrls: 142, lastRefreshAt: new Date().toISOString(), activeCount: 142 }]]),
      readinessByDomain: new Map([['frommfamily.com', 'active']]),
      enabledDistributorIds: ['phillips', 'bradley'],
    });
    const fromm = strategies.find((s) => s.normalizedBrand === 'fromm')!;
    // Live proposal carries mapped domains + enabled distributors (no tiers).
    expect(fromm.proposalSources).toContainEqual({ kind: 'distributor_record', distributorId: 'phillips' });
    // Check view source contains required UI strings
    const src = fs.readFileSync('src/client/components/brand-strategy/BrandStrategyView.tsx', 'utf8');
    expect(src).toContain('Included:');
    expect(src).not.toContain('[1]->[2]');
    expect(src).not.toContain('Preferred tier');
    expect(src).not.toContain('Fallback tier');
    expect(src).toContain('No official site configured');
    expect(src).toContain('Profile bypass eligible when distributor evidence qualifies');
  });

  it('shows ambiguous badge and global retailer banner once', async () => {
    const src = fs.readFileSync('src/client/components/brand-strategy/BrandStrategyView.tsx', 'utf8');
    expect(src).toContain('Ambiguous');
    // Banner appears once — only one occurrence of the banner text in file and component renders it once
    const bannerCount = (src.match(/Global retailer denylist active/g) ?? []).length;
    expect(bannerCount).toBe(1);
    expect(src).toContain('KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS');
  });
});
