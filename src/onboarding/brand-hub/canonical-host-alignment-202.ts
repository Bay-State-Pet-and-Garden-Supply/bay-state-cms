// Issue #202 — canonical-host alignment (Nutrisource + reusable rule).
//
// End-to-end host agreement for a redirect-split domain: the profile domain
// key, the approved brand mapping/strategy, stored source URLs, validation
// samples, and worker network allowlists must ALL agree on the host the
// worker actually fetches (post-redirect final host) — established through
// supported mapping/strategy flows, never blind host rewrites, never
// touching historical generation pins.
//
// This module is the executable form of that rule plus the Nutrisource
// demonstration. It is dependency-free (pure data + pure helpers, like the
// #199 resolutions and #201 verdicts modules): it moves no items, writes no
// profiles, and performs no network I/O. Live writes belong downstream:
// the profile row itself is #207's job (after the #198 release guard), the
// mapping move goes through `saveBrandStrategy`, source URLs through the
// assign-domain surface, and samples through the representative-suite
// surface — see docs/plans/canonical-host-alignment-202.md for the ordered
// handoff.
//
// Grounding: redirect evidence is consumed from the #201 verdict table
// (the input artifact — no re-probing here). Normalization follows the
// production profile-key path (`extractor-profile-repo` /
// `domain-release.normalizeReleaseDomain`) with one hardening: trim runs
// before the `www.` strip so whitespace-plus-`www.` inputs still converge
// (see `normalizeAlignmentHost`).

import {
  verdict201ByDomain,
  type ProductPageProbe201,
} from './product-page-verdicts-201';

/** Single normalization shared by all five alignment surfaces.
 *
 *  Order is lowercase → trim → strip leading `www.`. The trim comes
 *  FIRST deliberately: production's profile-key path strips before
 *  trimming, so a stored value with leading whitespace plus `www.` keeps
 *  a stale `www.` prefix and silently misses. Alignment hardens the order
 *  so every surface converges on one key even for messy inputs. */
export function normalizeAlignmentHost(host: string | null | undefined): string {
  if (!host) return '';
  return host.toLowerCase().trim().replace(/^www\./, '');
}

/** Normalized hostname of a URL (lowercase, `www.` stripped); '' when unparsable. */
export function hostOfUrl(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Exact-or-subdomain authority predicate shared by the allowlist and the
 * approved-mapping checks: the candidate equals the authority or lives
 * under it (`shop.x` matches `x`), never a bare substring match (so
 * `notx` never matches `x`). Both sides are alignment-normalized.
 */
export function isSameOrSubdomainHost(
  candidate: string | null | undefined,
  authority: string | null | undefined,
): boolean {
  const cand = normalizeAlignmentHost(candidate);
  const auth = normalizeAlignmentHost(authority);
  if (!cand || !auth) return false;
  return cand === auth || cand.endsWith(`.${auth}`);
}

/** True for a leaf product-page URL (anything below the site root). */
export function isLeafPageUrl(url: string): boolean {
  try {
    return new URL(url).pathname !== '/';
  } catch {
    return false;
  }
}

export type CanonicalEvidenceFailure =
  | 'no_leaf_product_page'
  | 'split_fetch_hosts';

export type CanonicalEvidenceResult =
  | { ok: true; canonicalHost: string }
  | { ok: false; reason: CanonicalEvidenceFailure };

/**
 * Reusable rule step 1 — qualify the canonical host from redirect evidence.
 *
 * Requires at least one status-200 LEAF product-page probe (homepage
 * evidence alone never qualifies) and unanimity: every status-200 probe
 * must land on the same final host. Both ends of the redirect must be
 * leaf pages — a leaf URL that 200-redirects onto a homepage proves
 * nothing about product extraction. That unanimous final host is the only
 * acceptable profile domain key (rule step 2).
 */
export function qualifyCanonicalHost(
  probes: readonly ProductPageProbe201[],
): CanonicalEvidenceResult {
  const fetched = probes.filter(
    (p) => p.status === 200 && isLeafPageUrl(p.url) && isLeafPageUrl(p.finalUrl),
  );
  if (fetched.length === 0) return { ok: false, reason: 'no_leaf_product_page' };
  const hosts = new Set(fetched.map((p) => normalizeAlignmentHost(p.finalHost)));
  if (hosts.size !== 1) return { ok: false, reason: 'split_fetch_hosts' };
  return { ok: true, canonicalHost: [...hosts][0]! };
}

/**
 * Worker allowlist predicate, mirroring the extraction worker's
 * `assertSafeProfileDestination` suffix rule: exact match or subdomain
 * suffix, both sides `www.`-normalized. An empty allowlist admits nothing
 * here — alignment always names the canonical host explicitly (the worker
 * additionally auto-includes the profile's own domain; see
 * `effectiveAllowlistFor`).
 */
export function allowlistAdmits(
  allowlist: readonly string[],
  url: string,
): boolean {
  const host = hostOfUrl(url);
  if (!host) return false;
  return allowlist.some((entry) => isSameOrSubdomainHost(host, entry));
}

/** Effective worker allowlist: the profile's approved domain is always included. */
export function effectiveAllowlistFor(
  profileDomain: string,
  extraAllowed: readonly string[] = [],
): string[] {
  return [...new Set([normalizeAlignmentHost(profileDomain), ...extraAllowed.map(normalizeAlignmentHost)].filter(Boolean))];
}

/**
 * Approved-mapping coverage, mirroring the discovery/collection authority
 * predicate (`isOfficialDomainMatch`): exact equality or subdomain suffix.
 * The fetched host is the candidate, the approved domain is the authority.
 */
export function approvedMappingCoversHost(
  approvedDomains: readonly string[],
  fetchHost: string,
): boolean {
  return approvedDomains.some((raw) => isSameOrSubdomainHost(fetchHost, raw));
}

export interface HostAgreementSurfaces {
  /** Profile domain key (`extractor_profiles.domain` — #207 writes this). */
  profileDomain: string;
  /** Approved official domains for the brand (`saveBrandStrategy` configuration). */
  approvedDomains: string[];
  /** Stored item source URLs (`onboarding_items.source_url` — release matching keys on these pre-redirect). */
  sourceUrls: string[];
  /** Representative-suite key plus confirmed sample URLs (validation/activation evidence). */
  suiteDomain: string;
  sampleUrls: string[];
  /** Explicit worker allowlist entries (profile domain auto-included on top). */
  allowlist: string[];
}

export interface HostAgreementFailure {
  surface: 'profile_key' | 'approved_mapping' | 'source_urls' | 'validation_samples' | 'worker_allowlist';
  reason: string;
}

export interface HostAgreementResult {
  agreed: boolean;
  /** Normalized canonical host all surfaces agree on ('' when not agreed). */
  canonicalHost: string;
  failures: HostAgreementFailure[];
}

/**
 * Reusable rule steps 2–6 — check all five surfaces against one host.
 *
 * Simulates the exact production predicates: release/profile lookup keys on
 * the stored-URL hostname (`job-queue` extraction gate,
 * `domain-release.releaseDomainExtractionItems` host filter), collection
 * stays inside the frozen approved domain (`official-collector`), and the
 * worker denies fetches outside the allowlist. Demonstrated agreement here
 * is what makes release matching succeed downstream — assertion alone is
 * not acceptance.
 */
export function checkHostAgreement(surfaces: HostAgreementSurfaces): HostAgreementResult {
  const failures: HostAgreementFailure[] = [];
  const key = normalizeAlignmentHost(surfaces.profileDomain);
  if (!key) {
    failures.push({ surface: 'profile_key', reason: 'empty profile domain key' });
    return { agreed: false, canonicalHost: '', failures };
  }

  if (!approvedMappingCoversHost(surfaces.approvedDomains, key)) {
    failures.push({
      surface: 'approved_mapping',
      reason: `approved domains [${surfaces.approvedDomains.join(', ')}] do not cover profile key ${key}`,
    });
  }

  const offHostSources = surfaces.sourceUrls.filter((u) => hostOfUrl(u) !== key);
  if (surfaces.sourceUrls.length === 0 || offHostSources.length > 0) {
    failures.push({
      surface: 'source_urls',
      reason:
        surfaces.sourceUrls.length === 0
          ? 'no stored source URLs to match'
          : `${offHostSources.length} source URL(s) off the profile key (e.g. ${offHostSources[0]})`,
    });
  }

  const suiteKey = normalizeAlignmentHost(surfaces.suiteDomain);
  const offHostSamples = surfaces.sampleUrls.filter((u) => hostOfUrl(u) !== key);
  if (suiteKey !== key) {
    failures.push({
      surface: 'validation_samples',
      reason: `suite key ${suiteKey || '(empty)'} is not the profile key ${key}`,
    });
  } else if (surfaces.sampleUrls.length === 0 || offHostSamples.length > 0) {
    failures.push({
      surface: 'validation_samples',
      reason:
        surfaces.sampleUrls.length === 0
          ? 'no confirmed validation samples on the canonical host'
          : `${offHostSamples.length} sample URL(s) off the profile key (e.g. ${offHostSamples[0]})`,
    });
  }

  const effective = effectiveAllowlistFor(surfaces.profileDomain, surfaces.allowlist);
  const denied = [...surfaces.sourceUrls, ...surfaces.sampleUrls].filter((u) => !allowlistAdmits(effective, u));
  if (denied.length > 0) {
    failures.push({
      surface: 'worker_allowlist',
      reason: `${denied.length} URL(s) denied by the effective allowlist [${effective.join(', ')}] (e.g. ${denied[0]})`,
    });
  }

  return { agreed: failures.length === 0, canonicalHost: failures.length === 0 ? key : '', failures };
}

export interface ReleaseMatchRow {
  id: string;
  sourceUrl: string;
}

/**
 * Demonstrates release matching the way production computes it: an item
 * releases on a domain exactly when the stored source-URL hostname
 * (pre-redirect) equals the normalized profile domain key
 * (`domain-release` host filter). Returns the matched/missed split so the
 * Nutrisource agreement is demonstrated, not asserted.
 */
export function demonstrateReleaseMatching(
  profileDomain: string,
  rows: readonly ReleaseMatchRow[],
): { matched: string[]; missed: string[] } {
  const key = normalizeAlignmentHost(profileDomain);
  const matched: string[] = [];
  const missed: string[] = [];
  for (const row of rows) {
    (hostOfUrl(row.sourceUrl) === key && key !== '' ? matched : missed).push(row.id);
  }
  return { matched, missed };
}

// ── Nutrisource demonstration ──────────────────────────────────────────
// Redirect evidence below is transcribed from the #201 verdict table (the
// input artifact); the alignment test asserts transcription fidelity so
// drift fails loudly instead of silently diverging.

/** Legacy mapped host that 301-redirects to the canonical host at product-page level. */
export const NUTRISOURCE_MAPPED_HOST = 'nutrisourcepetfoods.com';

/** Canonical served host: final host, canonical link, and working `.js` endpoint agree here (#201 §1). */
export const NUTRISOURCE_CANONICAL_HOST = 'discovernutrisource.com';

/** Blocked items behind this alignment (per #201 verdict row). */
export const NUTRISOURCE_ITEM_COUNT = 27;

/**
 * Brands sharing the legacy mapped host (brand_sites seed rows). Both map
 * to `nutrisourcepetfoods.com` today, so the supported-flow mapping move
 * must re-own BOTH rows — the legacy host must never be removed for one
 * brand while the other still claims it (removal-ownership rule in
 * `saveBrandStrategy`).
 */
export const NUTRISOURCE_BRANDS_ON_MAPPED_HOST: readonly string[] = ['NutriSource', 'PureVita'];

export interface NutrisourceAlignment202 {
  mappedHost: string;
  canonicalHost: string;
  itemCount: number;
  brandsOnMappedHost: readonly string[];
  /** Leaf product-page redirect observations proving the canonical host (from #201). */
  redirectEvidence: ReadonlyArray<{ url: string; finalUrl: string; finalHost: string; status: number; contentHash: string | null }>;
  /** Working platform endpoint shape on the canonical host (from #201). */
  endpoint: { kind: 'shopify_js'; url: string };
  /**
   * Supported-flow mapping move (NOT executed here — operator/#207 step):
   * `saveBrandStrategy` with an officialDomains configuration per brand.
   * Never a blind brand_sites UPDATE; never touches historical
   * sourcing-generation frozen pins.
   */
  approvedMappingPlan: {
    flow: 'saveBrandStrategy';
    configuration: { officialDomains: string[] };
    brands: readonly string[];
    removalOwnershipNote: string;
  };
  /** Aligned surfaces for `checkHostAgreement` (profile row itself written by #207). */
  alignedSurfaces: HostAgreementSurfaces;
  /** Profile creation owner (blocked on the #198 release guard — no live profile row here). */
  profileOwner: '#207';
}

export const NUTRISOURCE_ALIGNMENT_202: NutrisourceAlignment202 = (() => {
  const verdict = verdict201ByDomain('discovernutrisource.com');
  if (!verdict) throw new Error('[alignment-202] #201 Nutrisource verdict missing — input artifact required');
  const probes = verdict.probes.map((p: ProductPageProbe201) => ({
    url: p.url,
    finalUrl: p.finalUrl,
    finalHost: p.finalHost,
    status: p.status,
    contentHash: p.contentHash,
  }));
  const canonicalSamples = verdict.probes.filter((p) => p.status === 200).map((p) => p.finalUrl);
  return {
    mappedHost: NUTRISOURCE_MAPPED_HOST,
    canonicalHost: NUTRISOURCE_CANONICAL_HOST,
    itemCount: NUTRISOURCE_ITEM_COUNT,
    brandsOnMappedHost: NUTRISOURCE_BRANDS_ON_MAPPED_HOST,
    redirectEvidence: probes,
    endpoint: { kind: 'shopify_js', url: 'https://discovernutrisource.com/products/<handle>.js' },
    approvedMappingPlan: {
      flow: 'saveBrandStrategy',
      configuration: { officialDomains: [NUTRISOURCE_CANONICAL_HOST] },
      brands: NUTRISOURCE_BRANDS_ON_MAPPED_HOST,
      removalOwnershipNote:
        'PureVita shares the legacy mapped host: move/re-own its mapping row in the same brand-scoped saves — ' +
        'never delete the legacy host for one brand while the other still claims it, and never rewrite ' +
        'historical sourcing-generation frozen pins.',
    },
    alignedSurfaces: {
      profileDomain: NUTRISOURCE_CANONICAL_HOST,
      approvedDomains: [NUTRISOURCE_CANONICAL_HOST],
      sourceUrls: canonicalSamples,
      suiteDomain: NUTRISOURCE_CANONICAL_HOST,
      sampleUrls: canonicalSamples,
      allowlist: [NUTRISOURCE_CANONICAL_HOST],
    },
    profileOwner: '#207',
  };
})();

/**
 * Reusable alignment rule for any future redirect-split domain (written
 * down so the next split follows it without rediscovery):
 *
 * 1. PROVE with leaf product-page redirect chains (`qualifyCanonicalHost`):
 *    ≥1 status-200 leaf probe, unanimous final host, canonical link +
 *    working endpoint agree — never homepage canonical metadata alone.
 * 2. KEY the profile on the fetch host (post-redirect final host).
 * 3. MOVE the approved mapping/strategy through `saveBrandStrategy`
 *    configuration (brand-scoped; respect multi-brand removal ownership).
 * 4. CONVERGE stored source URLs to the canonical host via the
 *    assign-domain surface (release matching keys on the stored hostname).
 * 5. CONFIRM validation samples on the canonical host under the canonical
 *    suite key.
 * 6. ALLOWLIST the canonical host on the worker path (profile domain is
 *    auto-included; pass the canonical host explicitly too).
 * 7. NEVER rewrite historical generation pins; NEVER touch unrelated
 *    domains; NEVER write the live profile row before the release guard
 *    (#198) lands.
 */
export const ALIGNMENT_RULE_202: readonly string[] = [
  'PROVE with leaf product-page redirect chains — homepage evidence alone never qualifies',
  'KEY the profile on the post-redirect fetch host',
  'MOVE the approved mapping through the brand-strategy approval flow (brand-scoped, removal-owned)',
  'CONVERGE stored source URLs to the canonical host (release keys on the stored hostname)',
  'CONFIRM validation samples on the canonical host under the canonical suite key',
  'ALLOWLIST the canonical host on every worker fetch path',
  'NEVER rewrite historical generation pins, touch unrelated domains, or write live profiles pre-guard',
];
