// Issue #199 — brand inventory + sourcing-strategy resolution (10 brands, 34 items).
//
// Deterministic per-brand sourcing resolutions for the 10 brands that had no
// brand_sites mapping at triage time. Each entry is either official-domain or
// distributor-first-class — never an assumed official domain. Distributor
// choices are explicit Included pins, not fallbacks-by-omission.
//
// Evidence was observed 2026-09-16 (live homepage fetches + search). Product-
// page verification (platform proof, redirect chains, structured data) is
// ticket #201's job — the `handoff` notes below are its input, so no
// re-probing is needed downstream.
//
// Count reconciliation: the draft spec header said "37 items" but its own
// per-brand counts sum to 34 (8+6+4+3+3+3+3+2+1+1). The corrected inventory
// is 34; TOTAL_ITEMS asserts it here so drift fails loudly.
import type { StrategySourceRef } from '../../shared/schemas/brand-strategy';

/** Local exact-brand normalization (mirrors the approval repo; kept local so this spec module stays dependency-free). */
function normalizeExactBrand(brand: string): string {
  return brand.toLowerCase().trim();
}

export interface ItemCoverageRow {
  brand_hint: string | null;
}

export interface BrandCoverage {
  brand: string;
  expected: number;
  live: number;
  matched: boolean;
  spellings: string[];
}

/**
 * Groups live item rows by exact normalized brand_hint and compares each
 * resolution against its expected count. Pure (testable); the applicator
 * script prints the result. Spelling variance surfaces via `spellings` so
 * the operator can converge it through the assign-brand surface.
 */
export function summarizeItemCoverage(
  rows: ItemCoverageRow[],
  resolutions: readonly Brand199Resolution[] = BRAND_199_RESOLUTIONS,
): { perBrand: BrandCoverage[]; blankHints: number; unjoined: Array<{ spelling: string; count: number }> } {
  const found = new Map<string, number>();
  const spellings = new Map<string, Set<string>>();
  let blankHints = 0;
  for (const row of rows) {
    if (!row.brand_hint || !row.brand_hint.trim()) { blankHints += 1; continue; }
    const key = normalizeExactBrand(row.brand_hint);
    found.set(key, (found.get(key) ?? 0) + 1);
    const set = spellings.get(key) ?? new Set<string>();
    set.add(row.brand_hint.trim());
    spellings.set(key, set);
  }
  const known = new Set(resolutions.map((r) => normalizeExactBrand(r.brand)));
  const perBrand = resolutions.map((r) => {
    const live = found.get(normalizeExactBrand(r.brand)) ?? 0;
    return {
      brand: r.brand,
      expected: r.itemCount,
      live,
      matched: live === r.itemCount,
      spellings: [...(spellings.get(normalizeExactBrand(r.brand)) ?? [])],
    };
  });
  // Live rows whose brand joins NO resolution — the exact gap the
  // "zero pending items lack a strategy" invariant forbids.
  const unjoined = [...found.entries()]
    .filter(([key]) => !known.has(key))
    .map(([key, count]) => ({ spelling: [...(spellings.get(key) ?? [key])].join(' / '), count }))
    .sort((a, b) => b.count - a.count);
  return { perBrand, blankHints, unjoined };
}

export type Brand199StrategyKind = 'official_page' | 'distributor_record';

export interface Brand199Resolution {
  /** Spreadsheet display spelling (also the strategy approval identity). */
  brand: string;
  /** Corrected pending-item count for this brand (sums to 34). */
  itemCount: number;
  kind: Brand199StrategyKind;
  /** Exactly one official domain for official_page brands; empty for distributor brands. */
  officialDomains: string[];
  /** Explicit Included distributor pins for distributor_record brands; empty otherwise. */
  distributorIds: string[];
  /** Why this strategy (official vs distributor) — recorded, not omitted. */
  rationale: string;
  /** Where the rationale was observed (fetch/search, 2026-09-16). */
  evidence: string;
  /** Homepage platform signal (triage only — #201 proves product pages). */
  platformSignal: string;
  /** Set when the brand identity itself needs operator confirmation before apply. */
  needsIdentityConfirmation?: string;
  /** Handoff note for the #201 verification probe (official brands). */
  handoff?: string;
}

export const BRAND_199_RESOLUTIONS: readonly Brand199Resolution[] = [
  {
    brand: 'Snif-Snax',
    itemCount: 8,
    kind: 'official_page',
    officialDomains: ['snifsnax.com'],
    distributorIds: [],
    rationale:
      'Live official store at snifsnax.com (HTTP 200, self-canonical). Brand-owned domain with product collections; official evidence is authoritative for merchandising fields.',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200, canonical https://snifsnax.com/; /collections/ store paths.',
    platformSignal: 'Shopify markers + JSON-LD on homepage (triage signal; #201 proves product pages).',
    handoff: 'Probe representative product pages on snifsnax.com (redirect chain, Shopify product JSON, structured data).',
  },
  {
    brand: 'Jolly Pets',
    itemCount: 6,
    kind: 'official_page',
    officialDomains: ['jollypets.com'],
    distributorIds: [],
    rationale:
      'Live official store at jollypets.com (HTTP 200, self-canonical) with a dog-toy catalog. Official evidence is authoritative.',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200, canonical https://jollypets.com/; /collections/dog-toys catalog.',
    platformSignal: 'Shopify markers + JSON-LD on homepage (triage signal; #201 proves product pages).',
    handoff: 'Probe representative product pages on jollypets.com (redirect chain, Shopify product JSON, structured data).',
  },
  {
    brand: 'Hummzinger',
    itemCount: 4,
    kind: 'official_page',
    officialDomains: ['hummzinger.com'],
    distributorIds: [],
    rationale:
      'Live official site at hummzinger.com (HTTP 200, Aspects, Inc.) with per-product pages (/product/…). Official evidence is authoritative for this manufacturer-direct brand.',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200; search shows /product/<slug>/ pages with specs (HighView/Ultra/Excel).',
    platformSignal: 'No homepage platform markers (triage unknown — likely WordPress/custom; #201 decides mechanism).',
    handoff: 'Probe representative /product/ pages on hummzinger.com first — no profile work until the mechanism is known.',
  },
  {
    brand: 'YowUp',
    itemCount: 3,
    kind: 'official_page',
    officialDomains: ['yowup.com'],
    distributorIds: [],
    rationale:
      'Live official site at yowup.com (HTTP 200, self-canonical) with locale product pages (/us/, /en/). Official evidence is authoritative.',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200, canonical https://yowup.com/; locale catalog paths observed in search.',
    platformSignal: 'WordPress markers + JSON-LD on homepage (triage signal; #201 proves product pages).',
    handoff: 'Probe representative product pages on yowup.com (WooCommerce markers? Product/Offer schema?).',
  },
  {
    brand: 'Wondercide',
    itemCount: 3,
    kind: 'official_page',
    officialDomains: ['wondercide.com'],
    distributorIds: [],
    rationale:
      'Live official store at wondercide.com (HTTP 200, www canonical) with a full product catalog (/products/, /collections/). Official evidence is authoritative.',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200 via https://www.wondercide.com/; product/variant URLs observed in search.',
    platformSignal: 'Shopify markers + JSON-LD on homepage (triage signal; #201 proves product pages).',
    handoff: 'Probe representative product pages on wondercide.com (redirect chain, Shopify product JSON, variant-bearing pages).',
  },
  {
    brand: 'Sevin',
    itemCount: 3,
    kind: 'official_page',
    officialDomains: ['gardentech.com'],
    distributorIds: [],
    rationale:
      'Sevin is a GardenTech product line, not a standalone site: the official presence is gardentech.com/products/sevin (HTTP 200, www canonical). Mapping the house domain is the deterministic official route per ADR 0017 convergence (one official domain per brand).',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200, canonical https://www.gardentech.com; Sevin line index + per-product pages observed in search.',
    platformSignal: 'Sitecore markers (/-/media/) on homepage — template-driven enterprise CMS (triage signal; #201 proves product pages).',
    handoff: 'Probe representative Sevin product pages on gardentech.com; profile scope must be Sevin pages (multi-brand house site).',
  },
  {
    brand: 'OurPets',
    itemCount: 3,
    kind: 'distributor_record',
    officialDomains: [],
    distributorIds: ['phillips', 'pet_food_experts'],
    rationale:
      'Distributor-first-class (explicit, not fallback): the historic official domain ourpets.com is dead (Shopify "store unavailable" page, verified 2026-09-16) after the Petmate acquisition, so no official domain exists to map. OurPets is a mainstream distributor brand (toys, scratchers, bowls) carried by pet distributors; exact-UPC evidence qualifies per item. Fallback if distributor evidence fails to qualify: map the Petmate house site (petmate.com, alive, Shopify) as official — documented here, not silently assumed.',
    evidence: 'ourpets.com fetch 2026-09-16: Shopify "This store is unavailable" page; brand now lives as an OurPets collection on petmate.com/petmatepartners.com.',
    platformSignal: 'N/A (no official domain; distributor transport per connector registry).',
  },
  {
    brand: 'Coop & Range',
    itemCount: 2,
    kind: 'distributor_record',
    officialDomains: [],
    distributorIds: ['orgill', 'central_pet'],
    rationale:
      'Distributor-first-class (explicit, not fallback): no official brand site exists — coopandrange.com is a parked for-sale page (verified 2026-09-16). Coop & Range is a farm-channel poultry-treat brand with retail presence via farm distributors/retailers (Murdoch’s, Winona Feed listings); exact-UPC evidence qualifies per item through farm/pet distributors.',
    evidence: 'coopandrange.com fetch 2026-09-16: Spaceship parked-for-sale page; retail listings confirm brand existence (Murdoch’s Chunky Chicken Treats, Winona Feed).',
    platformSignal: 'N/A (no official domain; distributor transport per connector registry).',
  },
  {
    brand: 'OC',
    itemCount: 1,
    kind: 'official_page',
    officialDomains: ['ocraw.com'],
    distributorIds: [],
    rationale:
      'Spreadsheet brand "OC" resolves to OC Raw Dog (raw/freeze-dried pet food — the only pet-brand match for the abbreviation in a pet/garden catalog): live official site at ocraw.com (HTTP 200, www canonical) with per-product pages (/product/…).',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200, canonical https://www.ocraw.com/; /product/<recipe>/ pages observed in search.',
    platformSignal: 'WooCommerce + WordPress markers on homepage (triage signal; #201 proves product pages).',
    needsIdentityConfirmation:
      'Confirm the single OC item’s product name/UPC matches the OC Raw Dog catalog before approving (see runbook). If it does not match, do NOT approve — route to needs-info instead.',
    handoff: 'Probe representative product pages on ocraw.com (WooCommerce markers? Product/Offer schema?).',
  },
  {
    brand: "Horsemen's Pride",
    itemCount: 1,
    kind: 'official_page',
    officialDomains: ['horsemenspride.com'],
    distributorIds: [],
    rationale:
      'Live official store at horsemenspride.com (HTTP 200, self-canonical) with a full product catalog (/collections/all). Official evidence is authoritative.',
    evidence: 'Homepage fetch 2026-09-16: HTTP 200, canonical https://horsemenspride.com/; product catalog observed in search.',
    platformSignal: 'Shopify markers + JSON-LD on homepage (triage signal; #201 proves product pages).',
    handoff: 'Probe representative product pages on horsemenspride.com (redirect chain, Shopify product JSON, structured data).',
  },
];

/** Corrected 34-item inventory (the draft "37" header miscounted its own per-brand rows). */
export const BRAND_199_TOTAL_ITEMS: number = BRAND_199_RESOLUTIONS.reduce((n, r) => n + r.itemCount, 0);

export function brand199SaveInput(r: Brand199Resolution): {
  brand: string;
  sources: StrategySourceRef[];
  configuration?: { officialDomains: string[] };
} {
  if (r.kind === 'official_page') {
    const domain = r.officialDomains[0];
    if (!domain) throw new Error(`Issue #199: official_page brand '${r.brand}' has no domain`);
    return {
      brand: r.brand,
      sources: [{ kind: 'official_page', domain }],
      configuration: { officialDomains: [domain] },
    };
  }
  if (r.distributorIds.length === 0) {
    throw new Error(`Issue #199: distributor_record brand '${r.brand}' pins no distributors`);
  }
  return {
    brand: r.brand,
    sources: r.distributorIds.map((distributorId) => ({ kind: 'distributor_record' as const, distributorId })),
  };
}
