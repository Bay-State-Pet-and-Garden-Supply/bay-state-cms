// Issue #202 — canonical-host alignment tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: "canonical-host mismatch (no silent miss)"): the reusable alignment
// rule qualifies canonical hosts from product-page redirect evidence, all
// five Nutrisource surfaces agree on the canonical host, release matching
// succeeds on aligned URLs and misses on legacy-host URLs, and scope stays
// bounded (historical pins and unrelated domains untouched, no live profile
// rows written here).
//
// Pure and network-free: redirect evidence comes from the #201 verdict
// table (the input artifact), and every assertion runs against the pure
// alignment helpers. No live database, no profile writes.
import { describe, it, expect } from 'vitest';
import {
  ALIGNMENT_RULE_202,
  NUTRISOURCE_ALIGNMENT_202,
  NUTRISOURCE_BRANDS_ON_MAPPED_HOST,
  NUTRISOURCE_CANONICAL_HOST,
  NUTRISOURCE_ITEM_COUNT,
  NUTRISOURCE_MAPPED_HOST,
  allowlistAdmits,
  approvedMappingCoversHost,
  checkHostAgreement,
  demonstrateReleaseMatching,
  effectiveAllowlistFor,
  hostOfUrl,
  isLeafPageUrl,
  isSameOrSubdomainHost,
  normalizeAlignmentHost,
  qualifyCanonicalHost,
} from '../../onboarding/brand-hub/canonical-host-alignment-202';
import { verdict201ByDomain } from '../../onboarding/brand-hub/product-page-verdicts-201';

describe('issue #202 host normalization (one key for all five surfaces)', () => {
  it('normalizes exactly like the production profile-key path', () => {
    expect(normalizeAlignmentHost('DiscoverNutriSource.com')).toBe('discovernutrisource.com');
    expect(normalizeAlignmentHost('www.discovernutrisource.com')).toBe('discovernutrisource.com');
    expect(normalizeAlignmentHost('  discovernutrisource.com  ')).toBe('discovernutrisource.com');
    // Trim runs before the www. strip: whitespace-plus-www. still converges.
    expect(normalizeAlignmentHost('  www.discovernutrisource.com  ')).toBe('discovernutrisource.com');
    expect(normalizeAlignmentHost(null)).toBe('');
    expect(hostOfUrl('https://WWW.NutrisourcePetfoods.com/our-food/x/')).toBe('nutrisourcepetfoods.com');
    expect(hostOfUrl('not a url')).toBe('');
  });

  it('distinguishes leaf product pages from homepage URLs', () => {
    expect(isLeafPageUrl('https://nutrisourcepetfoods.com/our-food/x/chicken-rice-recipe/')).toBe(true);
    expect(isLeafPageUrl('https://discovernutrisource.com/products/y')).toBe(true);
    expect(isLeafPageUrl('https://discovernutrisource.com/')).toBe(false);
  });
});

describe('issue #202 exact-or-subdomain authority predicate (shared by allowlist and mapping checks)', () => {
  it('matches exact and subdomain hosts, never bare substrings', () => {
    expect(isSameOrSubdomainHost('discovernutrisource.com', 'discovernutrisource.com')).toBe(true);
    expect(isSameOrSubdomainHost('shop.discovernutrisource.com', 'discovernutrisource.com')).toBe(true);
    expect(isSameOrSubdomainHost('notdiscovernutrisource.com', 'discovernutrisource.com')).toBe(false);
    expect(isSameOrSubdomainHost('discovernutrisource.com.evil.example', 'discovernutrisource.com')).toBe(false);
  });

  it('normalizes both sides and fails closed on empty inputs', () => {
    expect(isSameOrSubdomainHost('  www.discovernutrisource.com  ', 'discovernutrisource.com')).toBe(true);
    expect(isSameOrSubdomainHost(null, 'discovernutrisource.com')).toBe(false);
    expect(isSameOrSubdomainHost('discovernutrisource.com', '')).toBe(false);
  });
});

describe('issue #202 canonical-host qualification (product pages, never homepage alone)', () => {
  it('qualifies the Nutrisource canonical host from the #201 redirect evidence', () => {
    const verdict = verdict201ByDomain('discovernutrisource.com')!;
    const result = qualifyCanonicalHost(verdict.probes);
    expect(result).toEqual({ ok: true, canonicalHost: 'discovernutrisource.com' });
  });

  it('rejects homepage-only evidence', () => {
    expect(
      qualifyCanonicalHost([
        { url: 'https://example.com/', finalUrl: 'https://example.com/', finalHost: 'example.com', status: 200, contentHash: 'ab', platform: 'shopify' },
      ]),
    ).toEqual({ ok: false, reason: 'no_leaf_product_page' });
  });

  it('rejects a leaf URL that redirects onto a homepage (no product proof)', () => {
    expect(
      qualifyCanonicalHost([
        { url: 'https://example.com/products/x', finalUrl: 'https://example.com/', finalHost: 'example.com', status: 200, contentHash: 'ab', platform: 'shopify' },
      ]),
    ).toEqual({ ok: false, reason: 'no_leaf_product_page' });
  });

  it('rejects split fetch hosts (no silent choice)', () => {
    expect(
      qualifyCanonicalHost([
        { url: 'https://a.example/p/1', finalUrl: 'https://a.example/p/1', finalHost: 'a.example', status: 200, contentHash: 'a', platform: 'shopify' },
        { url: 'https://b.example/p/2', finalUrl: 'https://b.example/p/2', finalHost: 'b.example', status: 200, contentHash: 'b', platform: 'shopify' },
      ]),
    ).toEqual({ ok: false, reason: 'split_fetch_hosts' });
  });
});

describe('issue #202 Nutrisource record grounding (no re-probing, no drift)', () => {
  it('transcribes the #201 verdict evidence faithfully', () => {
    const verdict = verdict201ByDomain('discovernutrisource.com')!;
    expect(NUTRISOURCE_ALIGNMENT_202.mappedHost).toBe(NUTRISOURCE_MAPPED_HOST);
    expect(NUTRISOURCE_ALIGNMENT_202.canonicalHost).toBe(verdict.fetchHost);
    expect(NUTRISOURCE_ALIGNMENT_202.canonicalHost).toBe(NUTRISOURCE_CANONICAL_HOST);
    expect(NUTRISOURCE_ALIGNMENT_202.itemCount).toBe(verdict.items);
    expect(NUTRISOURCE_ALIGNMENT_202.itemCount).toBe(NUTRISOURCE_ITEM_COUNT);
    expect(NUTRISOURCE_ALIGNMENT_202.redirectEvidence).toHaveLength(verdict.probes.length);
    for (const [i, probe] of NUTRISOURCE_ALIGNMENT_202.redirectEvidence.entries()) {
      expect(probe.url).toBe(verdict.probes[i]!.url);
      expect(probe.finalUrl).toBe(verdict.probes[i]!.finalUrl);
      expect(probe.finalHost).toBe(verdict.probes[i]!.finalHost);
      expect(probe.contentHash).toBe(verdict.probes[i]!.contentHash);
    }
    expect(NUTRISOURCE_ALIGNMENT_202.endpoint.url).toContain(NUTRISOURCE_CANONICAL_HOST);
    expect(verdict.endpoint.url).toContain(NUTRISOURCE_CANONICAL_HOST);
  });

  it('names the legacy mapped host and every brand sharing it', () => {
    // The legacy probe URL proves the mapped host from observed evidence.
    expect(NUTRISOURCE_ALIGNMENT_202.redirectEvidence[0]!.url).toContain(`${NUTRISOURCE_MAPPED_HOST}/`);
    expect([...NUTRISOURCE_BRANDS_ON_MAPPED_HOST].sort()).toEqual(['NutriSource', 'PureVita']);
    expect(NUTRISOURCE_ALIGNMENT_202.approvedMappingPlan.brands).toEqual(
      expect.arrayContaining(['NutriSource', 'PureVita']),
    );
  });

  it('routes the mapping move through the supported approval flow (never a blind rewrite)', () => {
    const plan = NUTRISOURCE_ALIGNMENT_202.approvedMappingPlan;
    expect(plan.flow).toBe('saveBrandStrategy');
    expect(plan.configuration.officialDomains).toEqual([NUTRISOURCE_CANONICAL_HOST]);
    expect(plan.removalOwnershipNote.length).toBeGreaterThan(80);
    // Profile creation is explicitly owned downstream, after the release guard.
    expect(NUTRISOURCE_ALIGNMENT_202.profileOwner).toBe('#207');
  });
});

describe('issue #202 five-surface agreement (demonstrated, not asserted)', () => {
  it('all Nutrisource surfaces agree on the canonical host', () => {
    const result = checkHostAgreement(NUTRISOURCE_ALIGNMENT_202.alignedSurfaces);
    expect(result.failures).toEqual([]);
    expect(result).toEqual({ agreed: true, canonicalHost: NUTRISOURCE_CANONICAL_HOST, failures: [] });
  });

  it('release matching succeeds for canonical-host source URLs', () => {
    const rows = NUTRISOURCE_ALIGNMENT_202.alignedSurfaces.sourceUrls.map((sourceUrl, i) => ({
      id: `nutrisource-item-${i}`,
      sourceUrl,
    }));
    expect(rows.length).toBeGreaterThan(0);
    const { matched, missed } = demonstrateReleaseMatching(NUTRISOURCE_CANONICAL_HOST, rows);
    expect(missed).toEqual([]);
    expect(matched).toHaveLength(rows.length);
  });

  it('legacy-host source URLs miss a canonical-keyed profile (the failure alignment prevents)', () => {
    const legacyRows = [
      { id: 'legacy-1', sourceUrl: 'https://nutrisourcepetfoods.com/our-food/x/chicken-rice-recipe/' },
      { id: 'legacy-2', sourceUrl: 'https://www.nutrisourcepetfoods.com/products/y' },
    ];
    const { matched, missed } = demonstrateReleaseMatching(NUTRISOURCE_CANONICAL_HOST, legacyRows);
    expect(matched).toEqual([]);
    expect(missed).toEqual(['legacy-1', 'legacy-2']);
  });

  it('each surface failure names its surface (no silent miss)', () => {
    const base = NUTRISOURCE_ALIGNMENT_202.alignedSurfaces;
    expect(
      checkHostAgreement({ ...base, approvedDomains: [NUTRISOURCE_MAPPED_HOST] }).failures.map((f) => f.surface),
    ).toContain('approved_mapping');
    expect(
      checkHostAgreement({
        ...base,
        sourceUrls: ['https://nutrisourcepetfoods.com/our-food/x/'],
      }).failures.map((f) => f.surface),
    ).toContain('source_urls');
    expect(
      checkHostAgreement({ ...base, suiteDomain: NUTRISOURCE_MAPPED_HOST }).failures.map((f) => f.surface),
    ).toContain('validation_samples');
    expect(
      checkHostAgreement({ ...base, sampleUrls: ['https://nutrisourcepetfoods.com/our-food/x/'] }).failures.map(
        (f) => f.surface,
      ),
    ).toContain('validation_samples');
  });
});

describe('issue #202 worker allowlist (canonical host admitted, others denied)', () => {
  it('admits canonical-host fetches through the effective allowlist', () => {
    const effective = effectiveAllowlistFor(NUTRISOURCE_CANONICAL_HOST, [NUTRISOURCE_CANONICAL_HOST]);
    for (const url of NUTRISOURCE_ALIGNMENT_202.alignedSurfaces.sourceUrls) {
      expect(allowlistAdmits(effective, url), url).toBe(true);
    }
  });

  it('the profile domain is always allowlisted (production behavior)', () => {
    expect(effectiveAllowlistFor(NUTRISOURCE_CANONICAL_HOST)).toEqual([NUTRISOURCE_CANONICAL_HOST]);
  });

  it('a legacy-only allowlist denies the canonical fetch host', () => {
    expect(
      allowlistAdmits([NUTRISOURCE_MAPPED_HOST], 'https://discovernutrisource.com/products/x'),
    ).toBe(false);
  });

  it('approved-mapping coverage uses the exact-or-subdomain authority predicate', () => {
    expect(approvedMappingCoversHost([NUTRISOURCE_CANONICAL_HOST], 'discovernutrisource.com')).toBe(true);
    expect(approvedMappingCoversHost([NUTRISOURCE_CANONICAL_HOST], 'shop.discovernutrisource.com')).toBe(true);
    expect(approvedMappingCoversHost([NUTRISOURCE_CANONICAL_HOST], 'notdiscovernutrisource.com')).toBe(false);
    expect(approvedMappingCoversHost([NUTRISOURCE_MAPPED_HOST], NUTRISOURCE_CANONICAL_HOST)).toBe(false);
  });
});

describe('issue #202 scope bounds (pins and unrelated domains untouched)', () => {
  it('the alignment record carries no generation-pin identifiers and names no unrelated domain', () => {
    const serialized = JSON.stringify(NUTRISOURCE_ALIGNMENT_202);
    // No pin handles a careless consumer could write through: no generation
    // ids, no frozen-domain bindings, no pin ids (the prose rule names pins
    // only as a never-touch boundary — see ALIGNMENT_RULE_202 step 7).
    expect(serialized).not.toMatch(/generationId|frozenDomains|pinId/i);
    expect(serialized).not.toContain('openfarmpet.com');
    expect(serialized).not.toContain('extractor_profiles');
  });

  it('an unrelated domain agrees independently on its own host', () => {
    const openfarm = verdict201ByDomain('openfarmpet.com')!;
    const openfarmUrls = openfarm.probes.filter((p) => p.status === 200).map((p) => p.finalUrl);
    const result = checkHostAgreement({
      profileDomain: openfarm.fetchHost,
      approvedDomains: [openfarm.fetchHost],
      sourceUrls: openfarmUrls,
      suiteDomain: openfarm.fetchHost,
      sampleUrls: openfarmUrls,
      allowlist: [openfarm.fetchHost],
    });
    expect(result).toEqual({ agreed: true, canonicalHost: 'openfarmpet.com', failures: [] });
  });

  it('the reusable rule is written down as seven ordered steps', () => {
    expect(ALIGNMENT_RULE_202).toHaveLength(7);
    expect(ALIGNMENT_RULE_202[0]).toMatch(/product-page/i);
    expect(ALIGNMENT_RULE_202[6]).toMatch(/NEVER/i);
  });
});
