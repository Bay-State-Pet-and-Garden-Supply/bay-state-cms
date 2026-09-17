// Issue #203 — walled-domain distributor routing (5 domains).
//
// Distributor-record (or staged manual-evidence) routing for the five
// crawler-walled domains, executed against the verified readiness from the
// checklist ticket (#200). No profile row is created or attempted for any
// of them; missing sitemaps are not treated as page inaccessibility.
//
// Inputs (consumed, never re-probed):
// - #201 (`product-page-verdicts-201.ts`): leaf product-page wall evidence.
//   SCOPE CHANGE from #201: three of the five walls have LIFTED for plain
//   fetch (bil-jac, northstatesind, yeowww — all status-200 leaf pages with
//   real catalog content). Only chickensouppets + multipet remain
//   distributor/manual certainties (403 at product-page level). The three
//   lifted domains re-route to worker-validated static profiles FIRST,
//   distributor only on validation failure — #203-as-written (distributor
//   for all five) is stale for them, and this record supersedes it.
// - #200 (`docs/plans/distributor-readiness-200.md`): distributor readiness.
//   Mechanical floor ready (mode automatic, 5/5 connections enabled, 3/3
//   secrets usable, zero profile collisions) but qualification UNPROVEN:
//   zero sourcing generations, zero attempts, zero strategy pins for any
//   walled brand, zero rollout-gate observations, zero current items.
//   Consequence recorded here: NO domain routes as "distributor flowing"
//   today — all five are blocked-with-reason plus owner follow-up.
//
// This module moves no items, writes no profiles, performs no network I/O,
// and touches no DB rows (dependency-free pure data + pure helpers, like
// the #199 resolutions, #201 verdicts, and #202 alignment modules).
// Downstream owners: static-validation tickets (new, no existing owner per
// #201 §5) for the three lifted domains; distributor-qualification
// follow-ups (FU-1/FU-4 per #200) for the two still-walled domains.

import {
  verdict201ByDomain,
  type ProductPageVerdict201,
} from './product-page-verdicts-201';

/** The five crawler-walled domains in #203 scope. */
export const WALLED_203_DOMAINS: readonly string[] = [
  'bil-jac.com',
  'chickensouppets.com',
  'multipet.com',
  'northstatesind.com',
  'yeowww.com',
];

/** Current blocked items behind walled domains: zero (all five are future-only). */
export const WALLED_203_TOTAL_ITEMS = 0;

/** Leaf wall evidence: lifted (plain fetch returns 200 catalog pages) or still walled (403). */
export type WalledWallStatus203 = 'lifted' | 'still_walled';

/**
 * Routed mechanism for (present or future) items of this brand.
 *
 * - `static_profile_validation`: wall lifted per #201 — worker-validate a
 *   static profile first; distributor only on validation failure. Any
 *   future profile write belongs to the downstream validation ticket,
 *   never to #203 (zero rows here).
 * - `distributor_manual_blocked`: still Cloudflare-403 at product-page
 *   level — no selector can ever work here. Future items move by
 *   distributor-record qualification or staged manual evidence, never by
 *   selector work. Blocked today (see `blockedReason` + `followUps`).
 */
export type WalledRoute203 = 'static_profile_validation' | 'distributor_manual_blocked';

/**
 * Acceptance-trichotomy outcome (ticket #203: distributor flowing /
 * manual-evidence staged with eligibility confirmed / blocked-with-reason
 * plus owner follow-up). All five record `blocked_with_reason` — honestly:
 * distributor cannot flow with zero generations/pins/items/gate
 * observations (#200 verdict: none routable today), and manual evidence
 * cannot be staged with zero failed items (entry is only from
 * extraction/failed). Claiming either would be fabrication.
 */
export type WalledSpecOutcome203 =
  | 'distributor_flowing'
  | 'manual_evidence_staged'
  | 'blocked_with_reason';

/** Selector-work posture for this domain. */
export type WalledSelectorPosture203 =
  | 'forbidden'
  | 'downstream_gated';

/** #200 readiness snapshot shared by all five routes (transcribed 2026-09-16; fidelity-tested). */
export interface DistributorReadiness203 {
  /** Effective sourcing mode (`loadSourcingFlags` with no env keys set). */
  sourcingMode: string;
  /** Enabled workspace connections (`distributor_connections`). */
  connectionsEnabled: string;
  /** Usable secrets, shape-verified without disclosure. */
  secretsUsable: string;
  /** Sourcing generations observed in this workspace. */
  generations: number;
  /** Evidence attempts observed. */
  attempts: number;
  /** Approved strategy pins for walled brands (`brand_sourcing_strategies`). */
  walledStrategyPins: number;
  /** Rollout-gate observations per connector (need 100/connector). */
  gateObservations: number;
  /** Per-connector live smoke (`BAYSTATE_CMS_SOURCING_LIVE_SMOKE=1`) run? */
  liveSmokeRun: boolean;
}

export const DISTRIBUTOR_READINESS_203: DistributorReadiness203 = {
  sourcingMode: 'automatic (default_on — no SOURCING env keys set)',
  connectionsEnabled: '5/5 html_scraper (bradley, central_pet, orgill, pet_food_experts, phillips_storefront)',
  secretsUsable: '3/3 auth-required secrets parse as exactly-{username,password} (lengths only, never disclosed); 2 public need none',
  generations: 0,
  attempts: 0,
  walledStrategyPins: 0,
  gateObservations: 0,
  liveSmokeRun: false,
};

/**
 * Sitemap posture for one walled domain. `sitemap_cache` holds 32 domains
 * and NONE of the five walled domains (verified 2026-09-16) — and that
 * absence decided nothing: every routing call below cites leaf HTTP
 * status (+ structured layer for lifted domains) as its deciding
 * evidence. Sitemap absence is a discovery inconvenience, never proof of
 * impossibility (#197 story 11).
 */
export interface WalledSitemap203 {
  /** Row in `sitemap_cache`? (false for all five — verified, not assumed). */
  cached: boolean;
  /** Was sitemap absence the sole justification for this routing call? Must be false. */
  soleJustification: boolean;
  /** The non-sitemap evidence that actually decided the call. */
  decidingEvidence: string;
}

export interface WalledManualEvidence203 {
  /** `extractor_profiles` row for this domain? (false for all five — the no-profile rule passes vacuously). */
  profileRowExists: boolean;
  /** Prior eligible extraction failure on an item? (false — zero items, so nothing to stage). */
  priorFailureExists: boolean;
  /** Stageable today? False for all five: staging requires a failed item + an explicit operator act. */
  stageableToday: boolean;
  /** When a future item fails closed here, what unlocks staging. */
  unlockNote: string;
}

/**
 * #201 input-artifact gate shared by both route builders (and
 * `verdict201ForRoute` below): the verdict row this route transcribes.
 * Throws when the artifact is missing so drift fails loudly instead of
 * silently diverging — never silently re-probed here.
 */
function requireVerdict201(domain: string): ProductPageVerdict201 {
  const verdict = verdict201ByDomain(domain);
  if (!verdict) throw new Error(`[routing-203] #201 verdict missing for ${domain} — input artifact required`);
  return verdict;
}

/**
 * Production profile-key normalization, copied from
 * `extractor-profile-repo.findProfileByDomain` (lowercase → strip leading
 * `www.` → trim, in that order): the verifier below applies the same ops
 * so stub-seam results mean the same thing as the live query.
 */
export function normalizeProfileKey(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

export interface WalledRouteEntry203 {
  /** Registrable domain identity (matches #201 verdict keys and `domain_status` rows). */
  domain: string;
  /** Brand display spelling. */
  brand: string;
  /** Post-redirect host the worker actually fetches (the profile key, if one is ever written downstream). */
  fetchHost: string;
  /** Blocked items behind this domain (0 for all five — future-only). */
  items: number;
  wall: { status: WalledWallStatus203; evidence: string };
  /** Structured layer observed on leaf pages (or unobservable when still walled). */
  structuredLayer: string;
  sitemap: WalledSitemap203;
  manualEvidence: WalledManualEvidence203;
  route: WalledRoute203;
  specOutcome: WalledSpecOutcome203;
  /** Why this route and not the alternatives (including why not distributor-flowing). */
  rationale: string;
  /** The blocking reason (acceptance: blocked-with-reason). */
  blockedReason: string;
  /** Named owner follow-ups — nothing left as "probably fine" (acceptance). */
  followUps: readonly string[];
  selectorPosture: WalledSelectorPosture203;
  /** #203 creates no profile rows — const false on every entry (acceptance). */
  createsProfileRow: false;
  /** Consuming ticket or named follow-up (no re-probing needed downstream). */
  downstream: string;
  /** `domain_status` posture: all five still read `blocked` from a 2026-08-20 check. */
  domainStatusNote: string;
}

function liftedEntry(
  domain: string,
  brand: string,
  structuredLayer: string,
  wallEvidence: string,
  staticBasis: string,
  downstream: string,
  rationale: string,
): WalledRouteEntry203 {
  const verdict = requireVerdict201(domain);
  return {
    domain,
    brand,
    fetchHost: verdict.fetchHost,
    items: 0,
    wall: { status: 'lifted', evidence: wallEvidence },
    structuredLayer,
    sitemap: {
      cached: false,
      soleJustification: false,
      decidingEvidence:
        `Leaf HTTP 200 on every probed product page (see wall evidence) — sitemap_cache has no row for ${domain}, ` +
        `and that absence decided nothing.`,
    },
    manualEvidence: {
      profileRowExists: false,
      priorFailureExists: false,
      stageableToday: false,
      unlockNote:
        'If worker validation of the static profile FAILS and a future item then fails closed with the ' +
        'profile-blocked signature, manual evidence becomes stageable via the audited operator path ' +
        '(extraction/failed + no profile row + attestation) — an explicit operator act, never automatic.',
    },
    route: 'static_profile_validation',
    specOutcome: 'blocked_with_reason',
    rationale,
    blockedReason:
      'Zero current items, zero distributor qualification evidence (#200: no generations, no pins, no gate ' +
      'observations), and a stale `blocked` wall signal — distributor cannot flow today and manual evidence ' +
      'has no failed item to stage. The #203-as-written distributor route is superseded by #201: validate a ' +
      `static profile first (${staticBasis}), distributor only on validation failure.`,
    followUps: [
      `Re-check domain_status for ${domain} (still reads blocked from 2026-08-20; rows older than 7 days ` +
        'expire on next getDomainStatus read per the repo TTL — the re-check self-heals, no hand-edit).',
      `${downstream}: worker-validate the ${staticBasis} static profile through the production worker ` +
        '(title, description, reviewed images, variant correctness) before any profile commitment.',
      'Distributor fallback only on validation failure: FU-1 live smoke + strategy pin + FU-4 observe-mode ' +
        'accumulation per #200 before any distributor flow.',
    ],
    selectorPosture: 'downstream_gated',
    createsProfileRow: false,
    downstream,
    domainStatusNote:
      `Stale: still reads blocked (Cloudflare 403, checked 2026-08-20) but #201 leaf probes returned 200 on ` +
      `2026-09-16. The 7-day getDomainStatus TTL already expired this row — next live read re-checks.`,
  };
}

function stillWalledEntry(
  domain: string,
  brand: string,
  wallEvidence: string,
  rationale: string,
): WalledRouteEntry203 {
  const verdict = requireVerdict201(domain);
  return {
    domain,
    brand,
    fetchHost: verdict.fetchHost,
    items: 0,
    wall: { status: 'still_walled', evidence: wallEvidence },
    structuredLayer: 'Unobservable (blocked — HTTP 403 on homepage AND leaf product page).',
    sitemap: {
      cached: false,
      soleJustification: false,
      decidingEvidence:
        `Leaf HTTP 403 Cloudflare challenge on the product page itself (see wall evidence) — sitemap_cache ` +
        `has no row for ${domain}, and that absence decided nothing. The wall is proven at product-page ` +
        `level, not inferred from discovery inconvenience.`,
    },
    manualEvidence: {
      profileRowExists: false,
      priorFailureExists: false,
      stageableToday: false,
      unlockNote:
        'When a future item for this brand fails closed with the profile-blocked signature ' +
        '(`No extractor profile for …`), manual evidence becomes stageable via the audited operator path ' +
        '(extraction/failed + no profile row + per-SKU attestation) — an explicit operator act, never automatic.',
    },
    route: 'distributor_manual_blocked',
    specOutcome: 'blocked_with_reason',
    rationale,
    blockedReason:
      'HTTP 403 at product-page level (no selector can ever work — zero profile rows, now and ever) combined ' +
      'with zero distributor qualification evidence (#200: no generations, no pins, no gate observations, no ' +
      'live smoke) and zero current items: distributor cannot flow today and manual evidence has no failed ' +
      'item to stage.',
    followUps: [
      'FU-1 (#200): per-connector live smoke (BAYSTATE_CMS_SOURCING_LIVE_SMOKE=1 with the runbook TEST ' +
        'identifiers) + no-secret/malformed-secret dry checks. Not run in #203 (no live vendor calls from ' +
        'the agent sandbox) — explicit operator action.',
      'Record a frozen distributor strategy pin for the brand (saveBrandStrategy approval flow) once FU-1 ' +
        'yields real evidence — no pin exists for any walled brand today.',
      'FU-4 (#200): observe-mode accumulation to the quantitative gates (100 labeled obs/connector) before ' +
        'any automatic canary. When the brand\'s first item arrives, it routes distributor-first-class ' +
        '(Amendment B: URL-null, merchandising-depth, no profile).',
    ],
    selectorPosture: 'forbidden',
    createsProfileRow: false,
    downstream: '#203 as written (distributor-record or staged manual evidence; no profile row, ever)',
    domainStatusNote:
      'Current: reads blocked (Cloudflare 403, checked 2026-08-20) — consistent with the #201 2026-09-16 ' +
      'leaf 403s. Row is past the 7-day getDomainStatus TTL; next live read re-checks.',
  };
}

export const WALLED_ROUTES_203: readonly WalledRouteEntry203[] = [
  liftedEntry(
    'bil-jac.com',
    'Bil-Jac',
    'WordPress Elementor, no Woo, no JSON-LD Product; OG title + OG image present on leaf pages (meta-backed static candidate).',
    'Wall LIFTED: homepage, /products/ listing, and two leaf pages return HTTP 200 with real catalog content ' +
      '(leaf hashes a9947dca…, 1eb09766…); 15 images on leaves, 44 on the listing.',
    'OG/meta-backed',
    'operator files new ticket: Bil-Jac static meta-backed profile via worker validation (no existing owner — operator owns filing)',
    'Crawler wall lifted for plain fetch with OG title/image on leaf pages — #203-as-written distributor routing ' +
      'is stale for Bil-Jac. A meta-backed static profile may carry future items, but only after worker ' +
      'validation proves it; distributor qualification (zero generations, zero pins, zero gate observations) ' +
      'cannot flow today, and manual evidence has no failed item to stage. Zero profile rows in #203 either way.',
  ),
  stillWalledEntry(
    'chickensouppets.com',
    'Chicken Soup for the Soul',
    'STILL WALLED: homepage AND leaf product page (/dogs/classic-adult-natural-dry-dog-food-…) both HTTP 403 ' +
      'with the Cloudflare challenge title — proven at product-page level, not just the homepage.',
    'Still Cloudflare-403 on the leaf product page itself: no selector can ever work here, so zero profile ' +
      'rows — now and ever. Distributor cannot flow today (zero generations, zero pins, zero gate observations, ' +
      'no live smoke), and manual evidence has no failed item to stage. Future items move by ' +
      'distributor-record qualification or staged manual evidence, never by selector work.',
  ),
  stillWalledEntry(
    'multipet.com',
    'Multipet',
    'STILL WALLED: product page /shop/tpr-spike-bone/ HTTP 403 with the Cloudflare challenge title — proven ' +
      'at product-page level, not just the homepage.',
    'Still Cloudflare-403 on the product page itself: no selector can ever work here, so zero profile rows — ' +
      'now and ever. Distributor cannot flow today (zero generations, zero pins, zero gate observations, no ' +
      'live smoke), and manual evidence has no failed item to stage. Future items move by distributor-record ' +
      'qualification or staged manual evidence, never by selector work.',
  ),
  liftedEntry(
    'northstatesind.com',
    'North States',
    'BigCommerce (cdn11.bigcommerce.com; ladder has no BC adapter → generic, recorded); FULL JSON-LD Product ' +
      'per leaf (name + sku 8739/8874 + gtin 00026107087393 + offer + image) plus OG title/image ' +
      '(strongest static candidate of the three lifted domains).',
    'Wall LIFTED for plain fetch: www → apex 301, then HTTP 200; two leaf gate pages carry full JSON-LD ' +
      'Product (leaf hashes 89bbe50d…, fa9c0099…).',
    'JSON-LD-backed',
    'operator files new ticket: North States static JSON-LD-backed profile via worker validation (no existing owner — operator owns filing)',
    'Crawler wall lifted with identity-grade structured data (sku + gtin + offer per leaf) — the strongest ' +
      'static candidate of the three lifted domains. Worker validation still gates any profile commitment; ' +
      'distributor cannot flow today (zero generations, zero pins, zero gate observations), and manual ' +
      'evidence has no failed item to stage. Zero profile rows in #203 either way.',
  ),
  liftedEntry(
    'yeowww.com',
    'Yeowww!',
    'BigCommerce, no JSON-LD on probed pages; leaf catnip-pouch has OG title/image (37 images), the ' +
      'holiday/candy-cane page has neither (6 images, category-shaped) — weakest lifted candidate, uneven ' +
      'across pages.',
    'Wall LIFTED for plain fetch: www → apex 301, then HTTP 200 (leaf hashes 1936ead4…, 58b30de1…).',
    'OG/meta-backed (weakest — worker validation is the gate)',
    'operator files new ticket: Yeowww! static meta-backed profile via worker validation (no existing owner — operator owns filing)',
    'Crawler wall lifted but the structured layer is thin and uneven (OG only, missing on one probed page) — ' +
      'worker validation is load-bearing before any profile commitment. Distributor cannot flow today (zero ' +
      'generations, zero pins, zero gate observations), and manual evidence has no failed item to stage. ' +
      'Zero profile rows in #203 either way.',
  ),
];

export function routing203ByDomain(domain: string): WalledRouteEntry203 | undefined {
  return WALLED_ROUTES_203.find((r) => r.domain === domain);
}

/**
 * Zero-profile-row verification seam (acceptance: zero profile rows created
 * for walled domains, verified by query).
 *
 * Takes the production lookup (`findProfileByDomain` from
 * `extractor-profile-repo`) so unit tests inject a stub while the doc's
 * re-verification query hits the live DB. Candidate keys are normalized
 * with `normalizeProfileKey` — the same ops in the same order as
 * production — so a stub result means the same thing as the live query:
 * no row under any spelling (apex, www., case/whitespace variants) of a
 * walled domain. Returns the offending domains — empty means the
 * invariant holds.
 */
export function verifyZeroProfileRows(
  findProfileByDomain: (domain: string) => unknown,
  routes: readonly WalledRouteEntry203[] = WALLED_ROUTES_203,
): string[] {
  const offending: string[] = [];
  for (const route of routes) {
    const keys = Array.from(
      new Set(
        [route.domain, `www.${route.domain}`, route.domain.toUpperCase(), ` ${route.domain} `].map(
          normalizeProfileKey,
        ),
      ),
    );
    if (keys.some((key) => findProfileByDomain(key) != null)) offending.push(route.domain);
  }
  return offending;
}

/**
 * How (present or future) items for this brand move: the routed mechanism,
 * never unrouted selector work. Still-walled brands move by
 * distributor-record qualification or staged manual evidence; lifted brands
 * move by worker-validated static profile first (distributor only on
 * validation failure). Acceptance: items move by the routed mechanism, not
 * by selector work.
 */
export function futureItemsMoveBy(
  route: WalledRouteEntry203,
): 'distributor_record_or_manual_evidence' | 'static_profile_validation_first' {
  return route.route === 'distributor_manual_blocked'
    ? 'distributor_record_or_manual_evidence'
    : 'static_profile_validation_first';
}

/** #201 input-artifact fidelity: the verdict row this route transcribes (throws when the artifact is missing). */
export function verdict201ForRoute(route: WalledRouteEntry203): ProductPageVerdict201 {
  return requireVerdict201(route.domain);
}
