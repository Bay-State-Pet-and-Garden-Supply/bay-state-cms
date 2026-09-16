// Issue #201 — representative product-page verification verdicts.
//
// Per-domain mechanism decisions grounded in real representative product
// pages (not homepage signals). Each entry records redirect chains,
// platform markers, structured-data presence, and public product-endpoint
// responses observed 2026-09-16, ending in a routing verdict of platform
// evidence, static profile, AI draft, or distributor/manual route.
//
// This table is the input artifact for the mechanism tickets (#202–#207
// plus the follow-ups named in docs/plans/product-page-verification-201.md)
// so no re-probing is needed downstream. Probe-only: this module moves no
// items and writes no profiles.
//
// The table is dependency-free (pure data + pure helpers) like the #199
// resolutions module; behavior tests live in
// src/tests/unit/product-page-verification-201.test.ts.

export type ProductPageVerdictKind =
  | 'platform_evidence'
  | 'static_profile'
  | 'ai_draft'
  | 'distributor_manual';

/** One leaf product-page observation (plain-fetch, redirect chain followed). */
export interface ProductPageProbe201 {
  /** Representative leaf product URL as probed. */
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  /** Host the worker actually fetches (post-redirect). */
  finalHost: string;
  /** HTTP status of the final hop (403 = still walled). */
  status: number;
  /** SHA-256 (first 16 hex) of the retained page bytes, for re-verification. */
  contentHash: string | null;
  /** Ladder detectPlatform() result on the leaf page. */
  platform: string;
}

/** Public product-endpoint evidence (Shopify .js or Woo Store API by slug). */
export interface ProductEndpoint201 {
  kind: 'shopify_js' | 'woo_store_api' | 'none';
  /** Endpoint URL shape that answered (with an example slug). */
  url: string | null;
  /** Observed payload contents (title/vendor/variants/images/barcode/sku). */
  evidence: string;
}

export interface ProductPageVerdict201 {
  /** Registrable domain identity (matches #199 handoff spellings).
   *
   *  This is NOT necessarily the profile key: use `fetchHost` for that.
   *  The two differ on www-served sites (e.g. wondercide.com is served —
   *  and must be keyed — as www.wondercide.com). */
  domain: string;
  /** Agreed post-redirect host the worker actually fetches — the profile
   *  domain key. Every status-200 probe in this row lands here. */
  fetchHost: string;
  /** Blocked items behind this domain (0 = future-only, walled brands). */
  items: number;
  verdict: ProductPageVerdictKind;
  probes: ProductPageProbe201[];
  endpoint: ProductEndpoint201;
  /** Structured-data presence on leaf pages (JSON-LD Product nodes?). */
  structuredData: string;
  /** Consuming mechanism ticket or named follow-up. */
  downstream: string;
  /** Why this verdict and not the alternatives. */
  rationale: string;
}

export const PRODUCT_PAGE_VERDICTS_201: readonly ProductPageVerdict201[] = [
  {
    domain: 'discovernutrisource.com',
    fetchHost: 'discovernutrisource.com',
    items: 27,
    verdict: 'platform_evidence',
    probes: [
      {
        url: 'https://nutrisourcepetfoods.com/our-food/nutrisource/nutrisource-dogs/nutrisource-grain-inclusive-dogs-wet/chicken-rice-recipe/',
        finalUrl: 'https://discovernutrisource.com/products/chicken-rice-wet-dog-food',
        finalHost: 'discovernutrisource.com',
        status: 200,
        contentHash: 'cf2e0329ea12cfa9',
        platform: 'shopify',
      },
      {
        url: 'https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food',
        finalUrl: 'https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food',
        finalHost: 'discovernutrisource.com',
        status: 200,
        contentHash: '45bd713bad5cfb7c',
        platform: 'shopify',
      },
    ],
    endpoint: {
      kind: 'shopify_js',
      url: 'https://discovernutrisource.com/products/<handle>.js',
      evidence: 'title + vendor NutriSource®, 1–3 variants with barcodes, 6–9 images (status 200)',
    },
    structuredData: 'JSON-LD Product with sku + gtin + offers (e.g. gtin 073893260103)',
    downstream: '#207 pattern (Shopify minimal profiles) + #202 (canonical-host alignment)',
    rationale:
      'Legacy mapped host 301-redirects to the canonical host at product-page level; final host, canonical link, and the working .js endpoint all agree on discovernutrisource.com. Confirms the research finding — profile key must be the canonical host.',
  },
  {
    domain: 'openfarmpet.com',
    fetchHost: 'openfarmpet.com',
    items: 8,
    verdict: 'platform_evidence',
    probes: [
      {
        url: 'https://openfarmpet.com/products/dry-dog-food-with-beef',
        finalUrl: 'https://openfarmpet.com/products/dry-dog-food-with-beef',
        finalHost: 'openfarmpet.com',
        status: 200,
        contentHash: '04e99af0132555f9',
        platform: 'shopify',
      },
      {
        url: 'https://openfarmpet.com/products/lamb-dry-dog-food',
        finalUrl: 'https://openfarmpet.com/products/lamb-dry-dog-food',
        finalHost: 'openfarmpet.com',
        status: 200,
        contentHash: 'ca68ed714ae09dc0',
        platform: 'shopify',
      },
    ],
    endpoint: {
      kind: 'shopify_js',
      url: 'https://openfarmpet.com/products/<handle>.js',
      evidence: 'title + vendor Open Farm, 3 variants with barcodes, 8 images (status 200)',
    },
    structuredData: 'JSON-LD Product with sku + gtin + offers (e.g. gtin 683547128705)',
    downstream: '#207 (Shopify minimal profiles)',
    rationale: 'Shopify markers + working product JSON on leaf pages; self-canonical, no redirect split.',
  },
  {
    domain: 'snifsnax.com',
    fetchHost: 'snifsnax.com',
    items: 8,
    verdict: 'platform_evidence',
    probes: [
      {
        url: 'https://snifsnax.com/products/salmon-bites-3-pack',
        finalUrl: 'https://snifsnax.com/products/salmon-bites-3-pack',
        finalHost: 'snifsnax.com',
        status: 200,
        contentHash: 'ecda60232ee6205a',
        platform: 'shopify',
      },
      {
        url: 'https://snifsnax.com/products/salmon-skins',
        finalUrl: 'https://snifsnax.com/products/salmon-skins',
        finalHost: 'snifsnax.com',
        status: 200,
        contentHash: '45ef64a3b15652f7',
        platform: 'shopify',
      },
    ],
    endpoint: {
      kind: 'shopify_js',
      url: 'https://snifsnax.com/products/<handle>.js',
      evidence: 'title + vendor SnifSnax, single variant with barcode, 2–3 images (status 200)',
    },
    structuredData: 'JSON-LD Product with sku + gtin + offers (e.g. gtin 850003301648)',
    downstream: '#207 scope expansion (new — #199 mapped domain)',
    rationale: 'Newly mapped #199 domain; leaf pages prove Shopify platform evidence, so it joins the #207 mechanism instead of any draft.',
  },
  {
    domain: 'jollypets.com',
    fetchHost: 'jollypets.com',
    items: 6,
    verdict: 'platform_evidence',
    probes: [
      {
        url: 'https://jollypets.com/products/jolly-soccer-ball-dog-toy',
        finalUrl: 'https://jollypets.com/products/jolly-soccer-ball-dog-toy',
        finalHost: 'jollypets.com',
        status: 200,
        contentHash: '45c0a6f1943a1ebd',
        platform: 'shopify',
      },
      {
        url: 'https://jollypets.com/products/jolly-egg-dog-toy',
        finalUrl: 'https://jollypets.com/products/jolly-egg-dog-toy',
        finalHost: 'jollypets.com',
        status: 200,
        contentHash: '5b866868b057e09e',
        platform: 'shopify',
      },
    ],
    endpoint: {
      kind: 'shopify_js',
      url: 'https://jollypets.com/products/<handle>.js',
      evidence: '18 variants (soccer ball) / 6 variants (egg) with barcodes, 11 / 5 images (status 200)',
    },
    structuredData: 'JSON-LD enumerates per-variant sku + some gtins (18 nodes on soccer ball)',
    downstream: '#207 scope expansion (new — #199 mapped domain)',
    rationale:
      'Shopify platform evidence on leaf pages. Variant-heavy (18 variants): downstream acceptance must prove variant distinction. Legacy Yoast/wp-content markup coexists in the theme but the detector still resolves shopify.',
  },
  {
    domain: 'wondercide.com',
    fetchHost: 'www.wondercide.com',
    items: 3,
    verdict: 'platform_evidence',
    probes: [
      {
        url: 'https://www.wondercide.com/products/16-oz-flea-tick-spray-for-pets-home',
        finalUrl: 'https://www.wondercide.com/products/16-oz-flea-tick-spray-for-pets-home',
        finalHost: 'www.wondercide.com',
        status: 200,
        contentHash: 'c617f193b1f4f70a',
        platform: 'shopify',
      },
      {
        url: 'https://www.wondercide.com/products/cedar-flea-tick-pets-home',
        finalUrl: 'https://www.wondercide.com/products/cedar-flea-tick-pets-home',
        finalHost: 'www.wondercide.com',
        status: 200,
        contentHash: 'f63b1a8407cdfa5f',
        platform: 'shopify',
      },
    ],
    endpoint: {
      kind: 'shopify_js',
      url: 'https://www.wondercide.com/products/<handle>.js',
      evidence: 'title + vendor Wondercide, 4 scent/size variants with barcodes, 7 images (status 200)',
    },
    structuredData:
      'No JSON-LD Product on leaf pages; embedded application/json names a DIFFERENT product (carousel payload) — the .js endpoint is authoritative, embedded JSON must be ignored',
    downstream: '#207 scope expansion (new — #199 mapped domain)',
    rationale:
      'Variant-bearing Shopify pages with a working product JSON. The cross-product embedded JSON is a worker caution, not a mechanism change. Served entirely on the www subdomain — see fetchHost (www.wondercide.com), which is the profile key, not the apex.',
  },
  {
    domain: 'horsemenspride.com',
    fetchHost: 'horsemenspride.com',
    items: 1,
    verdict: 'platform_evidence',
    probes: [
      {
        url: 'https://horsemenspride.com/products/jolly-ball-horse-toy',
        finalUrl: 'https://horsemenspride.com/products/jolly-ball-horse-toy',
        finalHost: 'horsemenspride.com',
        status: 200,
        contentHash: '2bd7a16dda8a7177',
        platform: 'shopify',
      },
      {
        url: 'https://horsemenspride.com/products/jolly-tug-horse-toy',
        finalUrl: 'https://horsemenspride.com/products/jolly-tug-horse-toy',
        finalHost: 'horsemenspride.com',
        status: 200,
        contentHash: '1610e08ed8cc6e8a',
        platform: 'shopify',
      },
    ],
    endpoint: {
      kind: 'shopify_js',
      url: 'https://horsemenspride.com/products/<handle>.js',
      evidence: '10 / 2 variants with barcodes, 13 / 3 images (status 200)',
    },
    structuredData: 'JSON-LD enumerates variants with gtins (e.g. gtin 788169014105)',
    downstream: '#207 scope expansion (new — #199 mapped domain)',
    rationale: 'Shopify platform evidence with variant-level GTINs in both the JSON endpoint and JSON-LD.',
  },
  {
    domain: 'bonide.com',
    fetchHost: 'bonide.com',
    items: 5,
    verdict: 'static_profile',
    probes: [
      {
        url: 'https://bonide.com/product/eight-insect-control-garden-dust',
        finalUrl: 'https://bonide.com/product/eight-insect-control-garden-dust/',
        finalHost: 'bonide.com',
        status: 200,
        contentHash: 'b942e37042f67806',
        platform: 'woocommerce',
      },
      {
        url: 'https://bonide.com/product/pyrethrin-garden-spray-conc/',
        finalUrl: 'https://bonide.com/product/pyrethrin-garden-spray-conc/',
        finalHost: 'bonide.com',
        status: 200,
        contentHash: '57c7af489f3cdd9d',
        platform: 'woocommerce',
      },
    ],
    endpoint: {
      kind: 'woo_store_api',
      url: 'https://bonide.com/wp-json/wc/store/v1/products?slug=<leaf-slug>',
      evidence: 'name + sku 784-P + type variable + 4 images + variation ids (status 200, unauthenticated)',
    },
    structuredData: 'No JSON-LD Product node (Yoast WebPage/Breadcrumb/Org only); no embedded wc/store payload',
    downstream: '#204 (Bonide static structured-data profile)',
    rationale:
      'WooCommerce markers with a public Store API that answers by slug — settles the Woo-vs-plain-WordPress question as WooCommerce. Static profile must still be validated through the production worker per #204.',
  },
  {
    domain: 'hummzinger.com',
    fetchHost: 'hummzinger.com',
    items: 4,
    verdict: 'static_profile',
    probes: [
      {
        url: 'https://hummzinger.com/product/hummzinger-ultra-12-oz/',
        finalUrl: 'https://hummzinger.com/product/hummzinger-ultra-12-oz/',
        finalHost: 'hummzinger.com',
        status: 200,
        contentHash: '7e374f725f9a7ea0',
        platform: 'woocommerce',
      },
      {
        url: 'https://hummzinger.com/product/hummzinger-highview-8-oz/',
        finalUrl: 'https://hummzinger.com/product/hummzinger-highview-8-oz/',
        finalHost: 'hummzinger.com',
        status: 200,
        contentHash: 'eda6daaebe156597',
        platform: 'woocommerce',
      },
    ],
    endpoint: {
      kind: 'woo_store_api',
      url: 'https://hummzinger.com/wp-json/wc/store/v1/products?slug=<leaf-slug>',
      evidence: 'name + sku 367 + type simple + 1 image (status 200, unauthenticated)',
    },
    structuredData: 'No JSON-LD Product node (BreadcrumbList/ItemPage only); no embedded wc/store payload',
    downstream: 'new ticket: Hummzinger static structured-data profile (no existing owner)',
    rationale:
      'Triage-unknown mechanism now resolved: WooCommerce with a public Store API. Static profile, not AI — no draft may start here.',
  },
  {
    domain: 'ocraw.com',
    fetchHost: 'www.ocraw.com',
    items: 1,
    verdict: 'static_profile',
    probes: [
      {
        url: 'https://www.ocraw.com/product/chicken-fish-produce-freeze-dried/',
        finalUrl: 'https://www.ocraw.com/product/chicken-fish-produce-freeze-dried/',
        finalHost: 'www.ocraw.com',
        status: 200,
        contentHash: 'b370b89112ad2064',
        platform: 'woocommerce',
      },
      {
        url: 'https://www.ocraw.com/product/duck-produce/',
        finalUrl: 'https://www.ocraw.com/product/duck-produce/',
        finalHost: 'www.ocraw.com',
        status: 200,
        contentHash: '07c58ddff931daa4',
        platform: 'woocommerce',
      },
    ],
    endpoint: {
      kind: 'woo_store_api',
      url: 'https://www.ocraw.com/wp-json/wc/store/v1/products?slug=<leaf-slug>',
      evidence: 'name + empty sku + type simple + 7 images (status 200, unauthenticated)',
    },
    structuredData: 'No ld+json at all and no OG tags on product pages — the Store API is the only structured layer',
    downstream: 'new ticket: OC Raw static profile (after #199 OC-identity confirmation)',
    rationale:
      'WooCommerce with a public Store API carrying 7 images per product. Worker validation is load-bearing for images since no OG/JSON-LD fallback exists.',
  },
  {
    domain: 'bluebuffalo.com',
    fetchHost: 'www.bluebuffalo.com',
    items: 7,
    verdict: 'ai_draft',
    probes: [
      {
        url: 'https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/chicken-brown-rice-recipe/',
        finalUrl: 'https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/chicken-brown-rice-recipe/',
        finalHost: 'www.bluebuffalo.com',
        status: 200,
        contentHash: '9923fcbfff49952a',
        platform: 'generic',
      },
      {
        url: 'https://www.bluebuffalo.com/dry-dog-food/wilderness/adult-chicken-grain-free-recipe/',
        finalUrl: 'https://www.bluebuffalo.com/dry-dog-food/wilderness/adult-chicken-grain-free-recipe/',
        finalHost: 'www.bluebuffalo.com',
        status: 200,
        contentHash: 'c17aeb24cc69d145',
        platform: 'generic',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'No platform endpoint mappable (bespoke URL shape, no /products/ handle)' },
    structuredData: 'Zero ld+json blocks of any kind on both product lines; OG/meta present for selector fallback',
    downstream: '#206 (Blue Buffalo full AI draft)',
    rationale:
      'Optimizely DXP (EPiServerMonitoring DxP verbatim), no platform markers, no structured product data on either line — full AI draft with visual-select fallback stands.',
  },
  {
    domain: 'nylabone.com',
    fetchHost: 'www.nylabone.com',
    items: 5,
    verdict: 'ai_draft',
    probes: [
      {
        url: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/dura-chew-power-chew-textured-bone',
        finalUrl: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/dura-chew-power-chew-textured-bone',
        finalHost: 'www.nylabone.com',
        status: 200,
        contentHash: '608bad86b2212c41',
        platform: 'generic',
      },
      {
        url: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/durachew-cheese-bone',
        finalUrl: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/durachew-cheese-bone',
        finalHost: 'www.nylabone.com',
        status: 200,
        contentHash: '1a0cd8d3e270898e',
        platform: 'generic',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'No platform endpoint mappable (Sitecore path shape, not /products/<handle>)' },
    structuredData: '9 / 2 @type:Product nodes but ALL empty shells (null name/sku/gtin/offers/images) — structured layer carries nothing',
    downstream: '#205 (Nylabone single Sitecore draft)',
    rationale:
      'Sitecore SXA with an identical theme fingerprint (experience-accelerator, sxa-base-theme, oneweb/nylabone) on both pages — shared-template assumption fingerprinted. Empty schema shells force a selector draft; #205 still owes second-template validation.',
  },
  {
    domain: 'gardentech.com',
    fetchHost: 'www.gardentech.com',
    items: 3,
    verdict: 'ai_draft',
    probes: [
      {
        url: 'https://www.gardentech.com/products/sevin/sevin-concentrate-bug-killer',
        finalUrl: 'https://www.gardentech.com/products/sevin/sevin-concentrate-bug-killer',
        finalHost: 'www.gardentech.com',
        status: 200,
        contentHash: '98e54dc2c522fb22',
        platform: 'generic',
      },
      {
        url: 'https://www.gardentech.com/products/sevin/sevin-ready-to-use',
        finalUrl: 'https://www.gardentech.com/products/sevin/sevin-ready-to-use',
        finalHost: 'www.gardentech.com',
        status: 200,
        contentHash: '33692fe8bc8a4294',
        platform: 'generic',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'No platform endpoint mappable (Sitecore path shape)' },
    structuredData: '3–4 @type:Product nodes, all empty shells — structured layer carries nothing',
    downstream: 'new ticket: Sevin AI draft on gardentech.com, Sevin-pages scope only (no existing owner)',
    rationale:
      'Sitecore SXA house theme (oneweb/gardentech), identical fingerprint on both Sevin pages. Multi-brand house site: any draft scope must be Sevin pages, never the whole domain.',
  },
  {
    domain: 'yowup.com',
    fetchHost: 'yowup.com',
    items: 3,
    verdict: 'ai_draft',
    probes: [
      {
        url: 'https://yowup.com/en/productos/yogurt-digestive-natural/',
        finalUrl: 'https://yowup.com/en/productos/yogurt-digestive-natural/',
        finalHost: 'yowup.com',
        status: 200,
        contentHash: 'dc423ce88699520f',
        platform: 'generic',
      },
      {
        url: 'https://yowup.com/en/productos/flora-plus-prepostbiotics-duck-pumpkin/',
        finalUrl: 'https://yowup.com/en/productos/flora-plus-prepostbiotics-duck-pumpkin-en/',
        finalHost: 'yowup.com',
        status: 200,
        contentHash: '76da5961b56b6765',
        platform: 'generic',
      },
    ],
    endpoint: {
      kind: 'none',
      url: null,
      evidence: 'Woo Store API absent (?slug=… → 404 rest_no_route); no other platform endpoint',
    },
    structuredData: 'No JSON-LD Product node (WebPage/Breadcrumb/Org only); no meta description on the product page',
    downstream: 'new ticket: YowUp AI draft (no existing owner)',
    rationale:
      'Plain WordPress custom theme with the Store API provably absent and no Product schema — static structured-data provably cannot carry this domain, so it proceeds straight to AI draft with no further static attempt owed.',
  },
  {
    domain: 'bil-jac.com',
    fetchHost: 'www.bil-jac.com',
    items: 0,
    verdict: 'static_profile',
    probes: [
      {
        url: 'https://www.bil-jac.com/products/picky-no-more-medium-large-breed-dog-food/',
        finalUrl: 'https://www.bil-jac.com/products/picky-no-more-medium-large-breed-dog-food/',
        finalHost: 'www.bil-jac.com',
        status: 200,
        contentHash: 'a9947dca3f1af016',
        platform: 'generic',
      },
      {
        url: 'https://www.bil-jac.com/products/picky-no-more-small-breed-dog-food/',
        finalUrl: 'https://www.bil-jac.com/products/picky-no-more-small-breed-dog-food/',
        finalHost: 'www.bil-jac.com',
        status: 200,
        contentHash: '1eb09766e6b1b0c4',
        platform: 'generic',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'No platform endpoint (WordPress Elementor, no Woo)' },
    structuredData: 'No JSON-LD Product node; OG title + OG image present on leaf pages (meta-backed static candidate)',
    downstream: '#203 re-route: worker-validate a static profile first, distributor only on validation failure',
    rationale:
      'Crawler wall LIFTED (homepage, listing, and two leaf pages return 200 with real catalog content). Zero current items, so this re-routes future items — #203 as written (distributor) is stale for Bil-Jac.',
  },
  {
    domain: 'northstatesind.com',
    fetchHost: 'northstatesind.com',
    items: 0,
    verdict: 'static_profile',
    probes: [
      {
        url: 'https://northstatesind.com/north-states-mypet-petgate-essential/',
        finalUrl: 'https://northstatesind.com/north-states-mypet-petgate-essential/',
        finalHost: 'northstatesind.com',
        status: 200,
        contentHash: '89bbe50dfac940d2',
        platform: 'generic',
      },
      {
        url: 'https://northstatesind.com/north-states-mypet-paws-portable-petgate-fieldstone/',
        finalUrl: 'https://northstatesind.com/north-states-mypet-paws-portable-petgate-fieldstone/',
        finalHost: 'northstatesind.com',
        status: 200,
        contentHash: 'fa9c0099e841384b',
        platform: 'generic',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'BigCommerce platform (cdn11.bigcommerce.com) — no Shopify-style public .js; ladder has no BC adapter (generic, recorded)' },
    structuredData: 'Full JSON-LD Product per leaf: name + sku (8739/8874) + gtin (00026107087393…) + 1 offer + 1 image, plus OG title/image',
    downstream: '#203 re-route: worker-validate a JSON-LD-backed static profile first',
    rationale:
      'Wall lifted for plain fetch; www → apex 301 is the only redirect. JSON-LD carries identity-grade fields (sku + gtin + offer), making this the strongest static candidate of the three lifted domains.',
  },
  {
    domain: 'yeowww.com',
    fetchHost: 'yeowww.com',
    items: 0,
    verdict: 'static_profile',
    probes: [
      {
        url: 'https://yeowww.com/our-products/catnip-pouch/',
        finalUrl: 'https://yeowww.com/our-products/catnip-pouch/',
        finalHost: 'yeowww.com',
        status: 200,
        contentHash: '1936ead4bd6a5a6c',
        platform: 'generic',
      },
      {
        url: 'https://yeowww.com/our-products/holiday/candy-cane/',
        finalUrl: 'https://yeowww.com/our-products/holiday/candy-cane/',
        finalHost: 'yeowww.com',
        status: 200,
        contentHash: '58b30de183324dbe',
        platform: 'generic',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'BigCommerce platform — no public product JSON; ladder has no BC adapter (generic, recorded)' },
    structuredData: 'No JSON-LD on probed pages; leaf catnip-pouch has OG title/image (37 imgs), candy-cane page has neither (category-shaped)',
    downstream: '#203 re-route: worker-validate a meta-backed static profile first (weakest lifted candidate)',
    rationale:
      'Wall lifted for plain fetch, but the structured layer is thin (OG only, uneven across pages) — worker validation is the gate before any profile commitment.',
  },
  {
    domain: 'chickensouppets.com',
    fetchHost: 'www.chickensouppets.com',
    items: 0,
    verdict: 'distributor_manual',
    probes: [
      {
        url: 'https://www.chickensouppets.com/dogs/classic-adult-natural-dry-dog-food-chicken-brown-rice-turkey-recipe',
        finalUrl: 'https://www.chickensouppets.com/dogs/classic-adult-natural-dry-dog-food-chicken-brown-rice-turkey-recipe',
        finalHost: 'www.chickensouppets.com',
        status: 403,
        contentHash: null,
        platform: 'unfetched',
      },
      {
        url: 'https://www.chickensouppets.com/',
        finalUrl: 'https://www.chickensouppets.com/',
        finalHost: 'www.chickensouppets.com',
        status: 403,
        contentHash: null,
        platform: 'unfetched',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'Unreachable — HTTP 403 Cloudflare challenge on homepage AND leaf product page' },
    structuredData: 'Unobservable (blocked)',
    downstream: '#203 as written (distributor-record or staged manual evidence)',
    rationale: 'Still Cloudflare-403, confirmed at leaf product-page level (/dogs/classic-adult-natural-dry-dog-food-…) as well as the homepage. No selector can ever work here — zero profile rows.',
  },
  {
    domain: 'multipet.com',
    fetchHost: 'www.multipet.com',
    items: 0,
    verdict: 'distributor_manual',
    probes: [
      {
        url: 'https://www.multipet.com/shop/tpr-spike-bone/',
        finalUrl: 'https://www.multipet.com/shop/tpr-spike-bone/',
        finalHost: 'www.multipet.com',
        status: 403,
        contentHash: null,
        platform: 'unfetched',
      },
    ],
    endpoint: { kind: 'none', url: null, evidence: 'Unreachable — HTTP 403 Cloudflare challenge on the product page itself' },
    structuredData: 'Unobservable (blocked)',
    downstream: '#203 as written (distributor-record or staged manual evidence)',
    rationale: 'Still Cloudflare-403 confirmed at product-page level, not just the homepage. No profile rows.',
  },
];

/** Domains in this record (18: 5 original + 5 walled + 8 newly mapped). */
export const VERDICT_201_DOMAINS: readonly string[] = PRODUCT_PAGE_VERDICTS_201.map((v) => v.domain);

/** Blocked items behind official domains covered by product-page evidence. */
export const VERDICT_201_TOTAL_ITEMS: number = PRODUCT_PAGE_VERDICTS_201.reduce((n, v) => n + v.items, 0);

export function verdict201ByDomain(domain: string): ProductPageVerdict201 | undefined {
  return PRODUCT_PAGE_VERDICTS_201.find((v) => v.domain === domain);
}
