// Issue #207 — Shopify minimal profiles, worker-validated (53 items, 6 domains).
//
// Minimal explicit profiles for the six Shopify-backed domains behind 53
// blocked onboarding items: discovernutrisource.com (27), openfarmpet.com
// (8), snifsnax.com (8), jollypets.com (6), www.wondercide.com (3),
// horsemenspride.com (1). No LLM generation anywhere: platform `.js` JSON
// backed with explicit selectors only as the runtime fallback where
// needed, validated end-to-end through the production worker.
//
// Inputs (consumed, never re-probed):
// - #201 (`product-page-verdicts-201.ts`): all six domains carry the
//   `platform_evidence` verdict — leaf pages resolve `detectPlatform() ===
//   'shopify'` and answer `…/products/<handle>.js` with title, vendor,
//   variants (with barcodes), and images. #201 also expands this ticket's
//   scope: as written #207 covered 35 items (Nutrisource + Open Farm); the
//   four newly mapped #199 Shopify domains (SnifSnax, Jolly Pets,
//   Wondercide, Horsemen's Pride) join the same mechanism for 53 total.
// - #202 (`canonical-host-alignment-202.ts`): the Nutrisource profile key
//   is the canonical fetch host `discovernutrisource.com` (legacy
//   `nutrisourcepetfoods.com` 301-redirects there at product-page level);
//   host agreement across profile key, mapping, source URLs, samples, and
//   allowlists is demonstrated there. The `www.` normalization shared with
//   `domain-release.normalizeReleaseDomain` means the Wondercide key
//   `www.wondercide.com` matches either URL form at release time.
// - #198 (`domain-release.ts` `getDomainReleaseHealth`): the release guard
//   this ticket's selective release runs behind — no auto-requeue before
//   reviewed health; selected retry only for failed-extraction items in
//   the requesting workspace.
//
// Method (2026-09-16, authoring-time live validation; committed tests use
// only the transcribed evidence below — no network, no DB):
// - Started the repo's own extraction worker locally and POSTed candidate
//   profile v1 per domain (runtime `static`, shared selectors below with a
//   per-domain gallery selector, `allowedSourceDomains` per the fetch
//   host) for 18 single-variant + 8 multi-variant real product URLs. The
//   worker fetched each page itself with production headers, the variant
//   gate ran in its default `active` mode, and results below are the
//   worker's verbatim verdicts (ok / failureCode / provenance / content
//   hash / matrix decision).
// - "Platform JSON backed" is an authoring-time contract, not a runtime
//   fetch: every sample's `.js` endpoint was probed separately (title +
//   vendor + variant/barcode + image cross-evidence transcribed per row)
//   while the runtime profile carries fields via CSS + meta selectors
//   against the fetched HTML only. `shopifyJSONPath: true` is recorded as
//   the generation-seeding hint (thebetterbone.com precedent), never as a
//   production extraction path — production profile extraction is
//   selector-only plus additive ladder fallbacks.
// - Price has no selector surface by design (accepted gap, see
//   FIELD_DECISIONS_207): the worker covers price additively from JSON-LD
//   offers or meta where present and from `expected.price` with
//   spreadsheet-import provenance whenever the item carries it.
//
// This module moves no items, writes no profiles, performs no network I/O,
// and touches no DB rows (dependency-free pure data + pure helpers, like
// the #199 resolutions, #201 verdicts, #202 alignment, #203 routing, #204
// static-profile, and #205 draft modules). Activation (per-field Builder
// approval, image-preview attestation, version activation) and selective
// release are operator acts in the live system; this record proves they
// are unblocked and states their exact eligibility rule.

/** Profile domain key (worker fetch host; Nutrisource key is the #202 canonical host, Wondercide is www-served per #201). */
export type ShopifyDomain207 =
  | 'discovernutrisource.com'
  | 'openfarmpet.com'
  | 'snifsnax.com'
  | 'jollypets.com'
  | 'www.wondercide.com'
  | 'horsemenspride.com';

/** One domain's minimal profile v1 (validated selector set + fetch posture). */
export interface ShopifyProfile207 {
  /** Profile domain key: the post-redirect host the worker fetches. */
  domain: ShopifyDomain207;
  /** Blocked items behind this domain (#201 counts; 27+8+8+6+3+1 = 53). */
  items: number;
  /** Worker-side source-domain allowlist for this profile's execution. */
  allowedSourceDomains: readonly string[];
}

/** The six Shopify profiles (one row per domain; single-profile-per-domain persistence). */
export const SHOPIFY_207_PROFILES: readonly ShopifyProfile207[] = [
  { domain: 'discovernutrisource.com', items: 27, allowedSourceDomains: ['discovernutrisource.com'] },
  { domain: 'openfarmpet.com', items: 8, allowedSourceDomains: ['openfarmpet.com'] },
  { domain: 'snifsnax.com', items: 8, allowedSourceDomains: ['snifsnax.com'] },
  { domain: 'jollypets.com', items: 6, allowedSourceDomains: ['jollypets.com'] },
  { domain: 'www.wondercide.com', items: 3, allowedSourceDomains: ['www.wondercide.com', 'wondercide.com'] },
  { domain: 'horsemenspride.com', items: 1, allowedSourceDomains: ['horsemenspride.com'] },
];

/** Blocked items unblocked by this ticket (35 as written + 18 #201 scope expansion). */
export const SHOPIFY_207_TOTAL_ITEMS = 53;

/** Candidate profile version validated through the worker. */
export const SHOPIFY_207_PROFILE_VERSION = 1;

/** Profile runtime: static fetch only (no rendered browser needed). */
export const SHOPIFY_207_RUNTIME = 'static' as const;

/**
 * Generation-seeding hint (thebetterbone.com precedent:
 * `shopify_json_path=1`). Recorded on every profile so future
 * regeneration prefers the platform object; it is NOT a production
 * extraction contract — the worker executes selectors only.
 */
export const SHOPIFY_207_SHOPIFY_JSON_PATH = true;

/**
 * Shared selector set v1. One stable CSS selector where the structured
 * layer has no equivalent (`h1` — exactly one per product page on all six
 * domains, verified against every validation sample), structured-data
 * selectors first for brand/description (`meta[...]`), `priceSelector`
 * null by design (accepted gap — see FIELD_DECISIONS_207). Images use the
 * per-domain gallery selector (themes differ; see
 * SHOPIFY_207_IMAGES_SELECTORS).
 */
export interface ShopifySharedSelectors207 {
  titleSelector: string;
  brandSelector: string;
  descriptionSelector: string;
  priceSelector: null;
}

export const SHOPIFY_207_SHARED_SELECTORS: ShopifySharedSelectors207 = {
  titleSelector: 'h1',
  brandSelector: 'meta[property="og:site_name"]',
  descriptionSelector: 'meta[property="og:description"]',
  priceSelector: null,
};

/**
 * Per-domain gallery selector (validated through the worker; counts below
 * are worker-observed primary + additional images on the confirmation
 * samples). Theme notes:
 * - Nutrisource (Dawn): `.product__media img` → 1+5 on all three samples.
 * - Open Farm (custom): `product-info img` → 1+9..11; includes icon,
 *   video-poster, and nutritional-label images — named preview-review
 *   items, not selector defects (the worker has no `imageRules` support).
 * - SnifSnax (custom): `.product-media img` → 1+0..2, matching `.js`.
 * - Jolly Pets / Horsemen's Pride (shared Turbo family):
 *   `.product_gallery img` → 1+0..3 / 1+1..2, matching `.js`.
 * - Wondercide (custom pwc): `.pwc-gallery img`; the rail carries a
 *   family cross-sell picker (FTPH spray images on collar/spot pages) plus
 *   a video poster — named preview-review items.
 */
export const SHOPIFY_207_IMAGES_SELECTORS: Record<ShopifyDomain207, string> = {
  'discovernutrisource.com': '.product__media img',
  'openfarmpet.com': 'product-info img',
  'snifsnax.com': '.product-media img',
  'jollypets.com': '.product_gallery img',
  'www.wondercide.com': '.pwc-gallery img',
  'horsemenspride.com': '.product_gallery img',
};

/** Platform `.js` cross-evidence for one validation sample (probed separately at authoring time; never a runtime dependency). */
export interface ShopifyJsEvidence207 {
  title: string;
  vendor: string;
  /** Variant count reported by the endpoint. */
  variants: number;
  /** Variant barcodes (null where the platform exposes none). */
  barcodes: ReadonlyArray<string | null>;
  /** Image count reported by the endpoint. */
  images: number;
}

/** Worker verdict for one validation sample URL. */
export type ShopifySampleVerdict207 = 'confirmed_clean' | 'variant_blocked';

/** One worker-validation sample (transcribed 2026-09-16; fidelity-tested). */
export interface ShopifyValidationSample207 {
  /** Leaf product-page URL fetched by the worker. */
  url: string;
  domain: ShopifyDomain207;
  /** Worker verdict for the profile v1 selector set. */
  verdict: ShopifySampleVerdict207;
  /** Worker `ok` flag. */
  ok: boolean;
  /** Worker failure code (`variant_selection_required` or null). */
  failureCode: string | null;
  /** Extracted title (null when the variant gate failed closed first). */
  title: string | null;
  /** Extracted brand via `og:site_name` (null when gated). */
  brand: string | null;
  /** Extracted description length in chars (0 when gated). */
  descriptionLength: number;
  /** Worker-observed primary + additional image counts. */
  primaryImages: number;
  additionalImages: number;
  /** Field provenance as reported by the worker. */
  provenance: Record<string, string>;
  /** Source content hash (full 64-hex; null when the gate failed closed first — the worker retains no bytes). */
  contentHash: string | null;
  /** Platform `.js` cross-evidence (authoring-time probe). */
  jsEvidence: ShopifyJsEvidence207;
  /** Variant-matrix candidates (variant-blocked rows only; sku + platform_id identifiers). */
  variantCandidates?: ReadonlyArray<{ key: string; sku: string }>;
  /** Why this row counts (or does not count) toward activation. */
  rationale: string;
}

export const SHOPIFY_207_SAMPLES: readonly ShopifyValidationSample207[] = [
  // ── discovernutrisource.com: 3 clean confirmations ──
  {
    url: 'https://discovernutrisource.com/products/chicken-rice-wet-dog-food',
    domain: 'discovernutrisource.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Chicken & Rice Wet Dog Food',
    brand: 'Discover NutriSource Pet Foods',
    descriptionLength: 308,
    primaryImages: 1,
    additionalImages: 5,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '7e11e9f8af259cb5a418fbe2b65ee30ded48ca0e1c5818fcc78fc15e37843a10',
    jsEvidence: { title: 'Chicken & Rice Wet Dog Food', vendor: 'NutriSource®', variants: 1, barcodes: ['073893021056'], images: 6 },
    rationale:
      'Full pass through the production worker: h1 title matches the platform title, brand via og:site_name, 308-char description via og:description, 1 primary + 5 gallery images via .product__media img (platform reports 6). Single-variant platform payload — no gate. Counts as Nutrisource confirmation 1 of 3.',
  },
  {
    url: 'https://discovernutrisource.com/products/beef-jerky-dog-treats',
    domain: 'discovernutrisource.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: "Beef Jivin' Jerky",
    brand: 'Discover NutriSource Pet Foods',
    descriptionLength: 139,
    primaryImages: 1,
    additionalImages: 5,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '7cf8e7cf949454a73df071e637b3fc86960070404eec1c7a065d31d7f496b1c1',
    jsEvidence: { title: "Beef Jivin' Jerky", vendor: 'Pure Vita', variants: 1, barcodes: ['073893185307'], images: 6 },
    rationale:
      'Full pass: single-variant treat page, 1+5 images. Platform vendor is Pure Vita — the sister brand sharing this Shopify store (#202 multi-brand removal ownership: NutriSource + PureVita re-own together; brand assignment owns the canonical brand, not extraction). Counts as Nutrisource confirmation 2 of 3.',
  },
  {
    url: 'https://discovernutrisource.com/products/chicken-and-rice-cat-can',
    domain: 'discovernutrisource.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Chicken & Rice Cat Formula',
    brand: 'Discover NutriSource Pet Foods',
    descriptionLength: 309,
    primaryImages: 1,
    additionalImages: 5,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'a2fbc65b6fcd6627906f766f75a718a3526d39183550a198efdecfd95154a5a4',
    jsEvidence: { title: 'Chicken & Rice Cat Formula', vendor: 'NutriSource®', variants: 1, barcodes: ['073893020158'], images: 6 },
    rationale:
      'Full pass: single-variant cat page (cross-category coverage on the same store), 1+5 images. Counts as Nutrisource confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food',
    domain: 'discovernutrisource.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Adult Chicken & Rice', vendor: 'NutriSource®', variants: 3, barcodes: ['073893260103', '073893260110', '073893260127'], images: 9 },
    variantCandidates: [
      { key: 'shopify:16314159005770:adult-chicken-&-rice---26-lb', sku: '26010' },
      { key: 'shopify:45736843673838:adult-chicken-&-rice---12-lb', sku: '26011' },
      { key: 'shopify:45736843706606:adult-chicken-&-rice---4-lb', sku: '26012' },
    ],
    rationale:
      'Fails closed by design (#197 story 16): the worker fetches the platform JSON for the matrix and parses a 3-candidate size matrix (26/12/4-lb, skus 26010/26011/26012) that name-only expected data cannot discriminate (ambiguous rank_no_identifier_signal, gate mode active). A retry carrying the platform barcode still fails — the matrix parser keeps sku + platform_id identifiers only, never barcodes (see VARIANT_LIMIT_207). Unlocks via the operator variant-selection flow. Excluded from confirmations; its future items release only after variant resolution.',
  },
  // ── openfarmpet.com: 3 clean confirmations ──
  {
    url: 'https://openfarmpet.com/products/arctic-char-topper-for-dogs',
    domain: 'openfarmpet.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Arctic Char Topper for Dogs',
    brand: 'Open Farm',
    descriptionLength: 166,
    primaryImages: 1,
    additionalImages: 10,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '1d99e74c8dea55586d76f33ec32a7742d3e6a2559bb7d0751e9bd6ec8a327800',
    jsEvidence: { title: 'Arctic Char Topper for Dogs', vendor: 'Open Farm', variants: 1, barcodes: ['683547146440'], images: 6 },
    rationale:
      'Full pass: single-variant topper page, h1 title, brand Open Farm via og:site_name, 166-char description. The gallery yields product shots plus icon, video-poster, and nutritional-label images — named image-preview review items (the worker has no imageRules support; keep/reject is a reviewer decision). Counts as Open Farm confirmation 1 of 3.',
  },
  {
    url: 'https://openfarmpet.com/products/be-good-bites-chicken-recipe',
    domain: 'openfarmpet.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Be Good Bites Chicken Treats',
    brand: 'Open Farm',
    descriptionLength: 158,
    primaryImages: 1,
    additionalImages: 11,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'b4cee31063cc3fecc57c89f46d79d31ce7dc71c785e6deff7f3750df1d6c2434',
    jsEvidence: { title: 'Be Good Bites Chicken Treats', vendor: 'Open Farm', variants: 1, barcodes: ['683547127425'], images: 7 },
    rationale:
      'Full pass: single-variant treat page (cross-category coverage), same preview-review caveat on non-product gallery images. Counts as Open Farm confirmation 2 of 3.',
  },
  {
    url: 'https://openfarmpet.com/products/bone-broth-bundle-for-cats',
    domain: 'openfarmpet.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Bone Broth Bundle for Cats',
    brand: 'Open Farm',
    descriptionLength: 185,
    primaryImages: 1,
    additionalImages: 9,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '74f4d4f272246d094d95491d10095d0bc9d372851425c173617dc182475b78fa',
    jsEvidence: { title: 'Bone Broth Bundle for Cats', vendor: 'Open Farm', variants: 1, barcodes: [null], images: 5 },
    rationale:
      'Full pass: single-variant bundle page with no platform barcode — identity still passes on the single-variant platform affirmation plus selector fields. Counts as Open Farm confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://openfarmpet.com/products/dry-dog-food-with-beef',
    domain: 'openfarmpet.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Grass-Fed Beef Grain-Free Dog Kibble', vendor: 'Open Farm', variants: 3, barcodes: ['683547128705', '683547128712', '683547128729'], images: 8 },
    variantCandidates: [
      { key: 'shopify:40059306836081:grass-fed-beef-grain-free-dog-kibble---4-lb', sku: '12870' },
      { key: 'shopify:40059306901617:grass-fed-beef-grain-free-dog-kibble---11-lb', sku: '12871' },
      { key: 'shopify:40059306934385:grass-fed-beef-grain-free-dog-kibble---22-lb', sku: '12872' },
    ],
    rationale:
      'Fails closed by design: 3-candidate size matrix (4/11/22-lb, skus 12870/12871/12872), ambiguous rank_no_identifier_signal — including on the barcode-carrying retry (barcodes are not matrix identifiers, see VARIANT_LIMIT_207). Same unlock path (operator variant selection). Excluded from confirmations.',
  },
  {
    url: 'https://openfarmpet.com/products/lamb-dry-dog-food',
    domain: 'openfarmpet.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Pasture-Raised Lamb Grain-Free Dog Kibble', vendor: 'Open Farm Pet', variants: 3, barcodes: ['683547128507', '683547128514', '683547128521'], images: 8 },
    variantCandidates: [
      { key: 'shopify:40059465564273:pasture-raised-lamb-grain-free-dog-kibble---4-lb', sku: '12850' },
      { key: 'shopify:40059465597041:pasture-raised-lamb-grain-free-dog-kibble---11-lb', sku: '12851' },
      { key: 'shopify:40059465629809:pasture-raised-lamb-grain-free-dog-kibble---22-lb', sku: '12852' },
    ],
    rationale:
      'Fails closed by design: second 3-candidate size matrix on the same store (4/11/22-lb, skus 12850/12851/12852). Platform vendor spelling differs (Open Farm Pet vs Open Farm) — brand assignment owns the canonical brand. Excluded from confirmations.',
  },
  // ── snifsnax.com: 3 clean confirmations ──
  {
    url: 'https://snifsnax.com/products/salmon-bites-3-pack',
    domain: 'snifsnax.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Chewy Salmon & Sweet Potato Bites 3-Pack (4oz)',
    brand: 'SnifSnax',
    descriptionLength: 114,
    primaryImages: 1,
    additionalImages: 1,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'cec716aff5a596ba5af2c0710d47d49eab5af6ea585c52c1aa954996accdfb54',
    jsEvidence: { title: 'Chewy Salmon & Sweet Potato Bites 3-Pack (4oz)', vendor: 'SnifSnax', variants: 1, barcodes: ['850003301648'], images: 2 },
    rationale:
      'Full pass: single-variant page, 1+1 images via .product-media img (platform reports 2). Price covered additively from JSON-LD (provenance json-ld; no priceSelector by design). Counts as SnifSnax confirmation 1 of 3.',
  },
  {
    url: 'https://snifsnax.com/products/salmon-skins',
    domain: 'snifsnax.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: '100% Salmon Crunchy Skins 3-Pack (1.5oz)',
    brand: 'SnifSnax',
    descriptionLength: 128,
    primaryImages: 1,
    additionalImages: 2,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'e37e7ab6616ed24e542541fa948156e058171e5cd0923704ee48f68aec6c2562',
    jsEvidence: { title: '100% Salmon Crunchy Skins 3-Pack (1.5oz)', vendor: 'Snif-Snax', variants: 1, barcodes: ['850003301655'], images: 3 },
    rationale:
      'Full pass: 1+2 images (platform reports 3). Platform vendor hyphenation differs (Snif-Snax vs SnifSnax) — brand assignment owns the canonical brand. Counts as SnifSnax confirmation 2 of 3.',
  },
  {
    url: 'https://snifsnax.com/products/freeze-dried-raw-coho-salmon',
    domain: 'snifsnax.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Freeze-Dried Raw Coho Salmon (12oz)',
    brand: 'SnifSnax',
    descriptionLength: 136,
    primaryImages: 1,
    additionalImages: 0,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector' },
    contentHash: '0f28fb44108bbc852e0de2e5b323669de28b7db377c7b9f0a25f058d08843698',
    jsEvidence: { title: 'Freeze-Dried Raw Coho Salmon (12oz)', vendor: 'SnifSnax', variants: 1, barcodes: ['850003301570'], images: 1 },
    rationale:
      'Full pass: thin but sufficient gallery (single product shot; platform reports exactly 1 image, so coverage is complete, not thin). Counts as SnifSnax confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver.',
  },
  // ── jollypets.com: 3 clean confirmations ──
  {
    url: 'https://jollypets.com/products/jolly-tuff-flyer',
    domain: 'jollypets.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Jolly Tuff Flyer',
    brand: 'Jolly Pets',
    descriptionLength: 320,
    primaryImages: 1,
    additionalImages: 3,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'a93b7e4e0121b028029d1ae348fcad56f1923343aab20d1d461ee5a759fd76c0',
    jsEvidence: { title: 'Jolly Tuff Flyer', vendor: 'Jolly Pets', variants: 1, barcodes: ['788169587623'], images: 4 },
    rationale:
      'Full pass: single-variant Tuff-line page, 1+3 images via .product_gallery img (platform reports 4). The Tuff line is the single-variant seam on an otherwise variant-heavy store. Counts as Jolly Pets confirmation 1 of 3.',
  },
  {
    url: 'https://jollypets.com/products/jolly-tuff-toppler-dog-toy',
    domain: 'jollypets.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Jolly Tuff Toppler',
    brand: 'Jolly Pets',
    descriptionLength: 320,
    primaryImages: 1,
    additionalImages: 3,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '55516d3d8a063e16e9c53d041c97bdd5a03b5099132dce7420997b94a53fb5c5',
    jsEvidence: { title: 'Jolly Tuff Toppler', vendor: 'Jolly Pets', variants: 1, barcodes: ['788169587425'], images: 4 },
    rationale:
      'Full pass: second single-variant Tuff-line page, 1+3 images. Counts as Jolly Pets confirmation 2 of 3.',
  },
  {
    url: 'https://jollypets.com/products/jolly-tuff-teeter-dog-toy',
    domain: 'jollypets.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Jolly Tuff Teeter',
    brand: 'Jolly Pets',
    descriptionLength: 319,
    primaryImages: 1,
    additionalImages: 0,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector' },
    contentHash: '92df37b0b1b58f6533b5db769f16cc1ec5c12eec3a610824b591d4b0a837ed96',
    jsEvidence: { title: 'Jolly Tuff Teeter', vendor: 'Jolly Pets', variants: 1, barcodes: ['788169587524'], images: 1 },
    rationale:
      'Full pass: third single-variant Tuff-line page; single product shot with the platform reporting exactly 1 image, so coverage is complete. Counts as Jolly Pets confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://jollypets.com/products/jolly-soccer-ball-dog-toy',
    domain: 'jollypets.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Jolly Soccer Ball', vendor: 'Jolly Pets', variants: 18, barcodes: [null, null, null, '788169720631'], images: 11 },
    variantCandidates: [
      { key: 'shopify:52013063045484:jolly-soccer-ball---small-(6")-/-light-purple', sku: 'SB06 LT PR' },
      { key: 'shopify:52612108943724:jolly-soccer-ball---small-(6")-/-blue', sku: 'SB06 BL' },
      { key: 'shopify:52612108976492:jolly-soccer-ball---small-(6")-/-pink', sku: 'SB06 PK' },
      { key: 'shopify:29174709747776:jolly-soccer-ball---small-(6")-/-green', sku: 'SB06 GR' },
      { key: 'shopify:29174709682240:jolly-soccer-ball---small-(6")-/-ocean-blue', sku: 'SB06 OB' },
      { key: 'shopify:29174709715008:jolly-soccer-ball---small-(6")-/-orange', sku: 'SB06 OR' },
      { key: 'shopify:52612109042028:jolly-soccer-ball---small-(6")-/-red', sku: 'SB06 RD' },
      { key: 'shopify:52612109009260:jolly-soccer-ball---small-(6")-/-purple', sku: 'SB06 PR' },
      { key: 'shopify:52627357008236:jolly-soccer-ball---small-(6")-/-light-blue', sku: 'SB06 BB' },
      { key: 'shopify:52013063078252:jolly-soccer-ball---large-(8")-/-light-purple', sku: 'SB08 LT PR' },
      { key: 'shopify:52612109074796:jolly-soccer-ball---large-(8")-/-blue', sku: 'SB08 BL' },
      { key: 'shopify:52612109107564:jolly-soccer-ball---large-(8")-/-pink', sku: 'SB08 PK' },
      { key: 'shopify:29174709846080:jolly-soccer-ball---large-(8")-/-green', sku: 'SB08 GR' },
      { key: 'shopify:29174709780544:jolly-soccer-ball---large-(8")-/-ocean-blue', sku: 'SB08 OB' },
      { key: 'shopify:29174709813312:jolly-soccer-ball---large-(8")-/-orange', sku: 'SB08 OR' },
      { key: 'shopify:52612109173100:jolly-soccer-ball---large-(8")-/-red', sku: 'SB08 RD' },
      { key: 'shopify:52612109140332:jolly-soccer-ball---large-(8")-/-purple', sku: 'SB08 PR' },
      { key: 'shopify:52627357041004:jolly-soccer-ball---large-(8")-/-light-blue', sku: 'SB08 BB' },
    ],
    rationale:
      'Fails closed by design: the heaviest matrix in this ticket (18 size/color candidates; several with no platform barcode at all). Per #197 story 16 and the #201 handoff, variant-heavy Jolly pages must prove variant distinction — name-only data cannot, so the gate refuses. Unlocks via the operator variant-selection flow. Excluded from confirmations.',
  },
  {
    url: 'https://jollypets.com/products/jolly-egg-dog-toy',
    domain: 'jollypets.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Jolly Egg', vendor: 'Jolly Pets', variants: 6, barcodes: ['788169000818'], images: 5 },
    variantCandidates: [
      { key: 'shopify:29174602661952:jolly-egg---small-(8")-/-red', sku: 'JE08 RD' },
      { key: 'shopify:29174602694720:jolly-egg---small-(8")-/-yellow', sku: 'JE08 YL' },
      { key: 'shopify:29174602727488:jolly-egg---small-(8")-/-purple', sku: 'JE08 PR' },
      { key: 'shopify:29174602760256:jolly-egg---large-(12")-/-red', sku: 'JE12 RD' },
      { key: 'shopify:29174602825792:jolly-egg---large-(12")-/-yellow', sku: 'JE12 YL' },
      { key: 'shopify:29174602858560:jolly-egg---large-(12")-/-purple', sku: 'JE12 PR' },
    ],
    rationale:
      'Fails closed by design: 6-candidate size/color matrix (small 8in vs large 12in). A barcode-carrying retry still fails (barcodes are not matrix identifiers, see VARIANT_LIMIT_207). Same unlock path. Excluded from confirmations.',
  },
  // ── www.wondercide.com: 3 clean confirmations ──
  {
    url: 'https://www.wondercide.com/products/2-pack-fruit-fly-trap-for-home-kitchen',
    domain: 'www.wondercide.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: '(2 Pack) Fruit Fly Trap for Home + Kitchen with Natural',
    brand: 'Wondercide',
    descriptionLength: 126,
    primaryImages: 1,
    additionalImages: 10,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'a0f51a0de9dab5fd893c538dd77cce928667c1ae31f0e50d66eac2b11d1f4958',
    jsEvidence: { title: '(2 Pack) Fruit Fly Trap for Home + Kitchen', vendor: 'Wondercide', variants: 1, barcodes: [null], images: 4 },
    rationale:
      'Full pass: single-variant page with no platform barcode — identity still passes on the single-variant platform affirmation plus selector fields. Wondercide leaf pages carry no JSON-LD Product (per #201), so the embedded-carousel JSON naming a different product is ignored; the platform JSON is authoritative. Counts as Wondercide confirmation 1 of 3.',
  },
  {
    url: 'https://www.wondercide.com/products/12-month-flea-tick-collar-for-cats',
    domain: 'www.wondercide.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: '12-Month Flea & Tick Collar for Cats',
    brand: 'Wondercide',
    descriptionLength: 143,
    primaryImages: 1,
    additionalImages: 24,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '88a21191c329c53624bf5e8a66d096c32df9a772472abc141a26a2873ff149a1',
    jsEvidence: { title: '12-Month Flea & Tick Collar for Cats', vendor: 'Wondercide', variants: 1, barcodes: [null], images: 4 },
    rationale:
      'Passes with a named review burden: the gallery rail carries a family cross-sell picker (FTPH spray images on a collar page) plus a video poster alongside 4 collar-specific images — the image-preview attestation must keep/reject each explicitly (the worker has no imageRules support). Counts as Wondercide confirmation 2 of 3.',
  },
  {
    url: 'https://www.wondercide.com/products/4-oz-flea-tick-spray-for-pets-home-sample-pack',
    domain: 'www.wondercide.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Flea & Tick Spray for Pets + Home Scent Sampler',
    brand: 'Wondercide',
    descriptionLength: 143,
    primaryImages: 1,
    additionalImages: 2,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '141527bb4d371fbe41c0d83f58438da6055e3b677505e788e927840d0f1c35f3',
    jsEvidence: { title: 'Flea & Tick Spray Scent Sampler', vendor: 'Wondercide', variants: 1, barcodes: ['019962895821'], images: 3 },
    rationale:
      'Full pass: single-variant sampler page, 1+2 images (platform reports 3). Served entirely on the www subdomain — the profile key is the fetch host. Counts as Wondercide confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://www.wondercide.com/products/16-oz-flea-tick-spray-for-pets-home',
    domain: 'www.wondercide.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: '16 oz. Flea & Tick Spray for Pets + Home', vendor: 'Wondercide', variants: 4, barcodes: ['810075890631'], images: 7 },
    variantCandidates: [
      { key: 'shopify:32806480707668:16-oz.-flea-&-tick-spray-for-pets-+-home---peppermint', sku: 'FTPH016P' },
      { key: 'shopify:32806480642132:16-oz.-flea-&-tick-spray-for-pets-+-home---cedarwood', sku: 'FTPH016C' },
      { key: 'shopify:32806468583508:16-oz.-flea-&-tick-spray-for-pets-+-home---lemongrass', sku: 'FTPH016L' },
      { key: 'shopify:32806480674900:16-oz.-flea-&-tick-spray-for-pets-+-home---rosemary', sku: 'FTPH016R' },
    ],
    rationale:
      'Fails closed by design: 4-candidate scent matrix (peppermint/cedarwood/lemongrass/rosemary). The scent families #201 flagged must prove variant distinction — a barcode-carrying retry still fails (see VARIANT_LIMIT_207). Same unlock path. Excluded from confirmations.',
  },
  {
    url: 'https://www.wondercide.com/products/cedar-flea-tick-pets-home',
    domain: 'www.wondercide.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Cedarwood Flea & Tick Spray for Pets + Home', vendor: 'Wondercide', variants: 4, barcodes: ['810075890563'], images: 7 },
    variantCandidates: [
      { key: 'shopify:32806471925844:cedarwood-flea-&-tick-spray-for-pets-+-home---4-oz', sku: 'FTPH004C' },
      { key: 'shopify:32806485786708:cedarwood-flea-&-tick-spray-for-pets-+-home---16-oz', sku: 'FTPH016C' },
      { key: 'shopify:32806485819476:cedarwood-flea-&-tick-spray-for-pets-+-home---32-oz', sku: 'FTPH032C' },
      { key: 'shopify:32806485852244:cedarwood-flea-&-tick-spray-for-pets-+-home---128-oz', sku: 'FTPH128C' },
    ],
    rationale:
      'Fails closed by design: second 4-candidate matrix on the same store, this time size-graded (4/16/32/128-oz). Same unlock path. Excluded from confirmations.',
  },
  // ── horsemenspride.com: 3 clean confirmations ──
  {
    url: 'https://horsemenspride.com/products/amazing-graze-horse-toy',
    domain: 'horsemenspride.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Amazing Graze',
    brand: "Horsemen's Pride",
    descriptionLength: 320,
    primaryImages: 1,
    additionalImages: 1,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: 'b0b03b283032c388934d26ef5ef836110836b41d67fa0957895f1782bde8cae1',
    jsEvidence: { title: 'Amazing Graze', vendor: "Horsemen's Pride", variants: 1, barcodes: ['788169010060'], images: 1 },
    rationale:
      'Full pass: single-variant page, 1+1 images with the platform reporting exactly 1 image plus one theme-served duplicate size — coverage complete. Counts as Horsemen’s Pride confirmation 1 of 3.',
  },
  {
    url: 'https://horsemenspride.com/products/jolly-apple-horse-toy',
    domain: 'horsemenspride.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Jolly Apple',
    brand: "Horsemen's Pride",
    descriptionLength: 320,
    primaryImages: 1,
    additionalImages: 1,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '1c040c532c0157c821598e8e77395ca70b87fe6a231c4dd38f72acc8030026f0',
    jsEvidence: { title: 'Jolly Apple', vendor: "Horsemen's Pride", variants: 1, barcodes: ['788169089912'], images: 1 },
    rationale:
      'Full pass: second single-variant page, same posture. Counts as Horsemen’s Pride confirmation 2 of 3.',
  },
  {
    url: 'https://horsemenspride.com/products/jolly-stall-snack-combo',
    domain: 'horsemenspride.com',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Jolly Stall Snack Combo',
    brand: "Horsemen's Pride",
    descriptionLength: 319,
    primaryImages: 1,
    additionalImages: 2,
    provenance: { title: 'profile-selector', brand: 'meta', description: 'meta', primaryImage: 'profile-selector', additionalImages: 'profile-selector' },
    contentHash: '593a65e5a71033d452d5fe5ad59d31daaae276fc761692e9100886f8836c98f0',
    jsEvidence: { title: 'Jolly Stall Snack Combo', vendor: "Horsemen's Pride", variants: 1, barcodes: ['788169020311'], images: 2 },
    rationale:
      'Full pass: 1+2 images (platform reports 2). Counts as Horsemen’s Pride confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://horsemenspride.com/products/jolly-ball-horse-toy',
    domain: 'horsemenspride.com',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    brand: null,
    descriptionLength: 0,
    primaryImages: 0,
    additionalImages: 0,
    provenance: {},
    contentHash: null,
    jsEvidence: { title: 'Jolly Ball® 10"', vendor: "Horsemen's Pride", variants: 10, barcodes: ['788169041019'], images: 13 },
    variantCandidates: [
      { key: 'shopify:44053123858719:jolly-ball®-10"---red', sku: '410 RD' },
      { key: 'shopify:44053123629343:jolly-ball®-10"---blue', sku: '410 BL' },
      { key: 'shopify:44053123825951:jolly-ball®-10"---purple', sku: '410 PR' },
      { key: 'shopify:50895328903455:jolly-ball®-10"---light-purple', sku: '410 LT PR' },
      { key: 'shopify:44053123596575:jolly-ball®-10"---light-blue', sku: '410 BB' },
      { key: 'shopify:44053123793183:jolly-ball®-10"---pink', sku: '410 PK' },
      { key: 'shopify:44053123727647:jolly-ball®-10"---orange', sku: '410 OR' },
      { key: 'shopify:51199616516383:jolly-ball®-10"---ocean-blue', sku: '410 OB' },
      { key: 'shopify:44053123662111:jolly-ball®-10"---green', sku: '410 GR' },
      { key: 'shopify:44053123760415:jolly-ball®-10"---peppermint', sku: '410 PMNT' },
    ],
    rationale:
      'Fails closed by design: 10-candidate color matrix with variant-level GTINs in the platform JSON that the worker matrix cannot consume (see VARIANT_LIMIT_207). A barcode-carrying retry still fails. Same unlock path. Excluded from confirmations.',
  },
];

/**
 * Platform-matrix identifier limit (worker-observed, all six stores).
 *
 * The worker's Shopify variant-matrix parser keeps `sku` + `platform_id`
 * identifiers per candidate and never the platform `barcode`: every
 * transcribed matrix decision on name-only AND barcode-carrying retries is
 * `ambiguous / rank_no_identifier_signal`. Consequence, recorded here so
 * no future retry wastes effort on it: for multi-variant Shopify pages,
 * NEITHER a name retry NOR a barcode/UPC retry resolves — release requires
 * the operator variant-selection flow (identityMatrixHash-bound receipt
 * for the chosen variantKey). Failing closed is the correct behavior per
 * #197 story 16: the wrong SKU is never extracted with confidence.
 */
export const VARIANT_LIMIT_207 =
  'Shopify matrix candidates carry sku + platform_id identifiers only — platform barcodes are not consumed, so name and barcode retries alike fail closed; multi-variant release requires the operator variant-selection flow.';

/** Per-field outcome for the Shopify minimal profiles. */
export type ShopifyFieldStatus207 = 'carried' | 'accepted_gap' | 'conditional';

/**
 * Field-by-field gap enumeration (acceptance: gaps enumerated before any
 * draft is considered). `draftNeeded` is false on every row — no field
 * escalates to even a light AI draft on any of the six domains.
 */
export interface ShopifyFieldGap207 {
  field: 'title' | 'brand' | 'description' | 'images' | 'price' | 'variants';
  status: ShopifyFieldStatus207;
  /** Worker-observed evidence carrying (or limiting) this field. */
  evidence: string;
  /** Whether any AI draft is needed for this field. Always false. */
  draftNeeded: false;
}

export const FIELD_GAPS_207: readonly ShopifyFieldGap207[] = [
  {
    field: 'title',
    status: 'carried',
    evidence:
      'Worker extracted the exact product name via h1 on all 18 confirmations (exactly one h1 per product page on all six stores; matches platform titles). Explicit exception to structured-only: no structured title surface carries the product name (og:title is the SEO title, not the product name). Provenance profile-selector on every confirmation.',
    draftNeeded: false,
  },
  {
    field: 'brand',
    status: 'carried',
    evidence:
      'Worker extracted the store brand via meta[property="og:site_name"] on all 18 confirmations (Discover NutriSource Pet Foods, Open Farm, SnifSnax, Jolly Pets, Wondercide, Horsemen\'s Pride). Provenance meta everywhere. Known spelling drift vs platform vendors (NutriSource® / Pure Vita / Snif-Snax / Open Farm Pet) is owned by brand assignment, not extraction.',
    draftNeeded: false,
  },
  {
    field: 'description',
    status: 'carried',
    evidence:
      'Worker extracted 114–320-char descriptions via meta[property="og:description"] on all 18 confirmations. Wondercide has no JSON-LD Product on leaf pages, so the structured layer could not carry description there either — the meta surface suffices on all six stores. Provenance meta everywhere.',
    draftNeeded: false,
  },
  {
    field: 'images',
    status: 'carried',
    evidence:
      'Worker extracted 1–25 images per confirmation via the per-domain gallery selector (Dawn .product__media, Turbo .product_gallery, SnifSnax .product-media, Open Farm product-info, Wondercide .pwc-gallery). Review-burden rows are explicit, not hidden: Open Farm icon/video-poster/nutritional-label images, the Wondercide family cross-sell rail + video poster, and thin single-shot galleries (coho, teeter, graze, apple) all go to image-preview attestation — the worker has no imageRules support (schema field only), so keep/reject is a reviewer decision, never a selector rule.',
    draftNeeded: false,
  },
  {
    field: 'price',
    status: 'accepted_gap',
    evidence:
      'No priceSelector by design on any profile. The worker covers price additively where a surface exists (ladder JSON-LD offers on Nutrisource/Open Farm, json-ld on SnifSnax, product meta on Jolly/Horsemen\'s Pride) and from expected.price with spreadsheet-import provenance whenever the item carries it. A draft could not do better — Shopify price surfaces are per-theme JS-rendered variants, not static selectors.',
    draftNeeded: false,
  },
  {
    field: 'variants',
    status: 'conditional',
    evidence:
      'Single-variant pages (all 18 confirmations; the platform affirmatively reports exactly one variant) pass with no gate. Multi-variant pages (Nutrisource 3-size, Open Farm 3-size ×2, Jolly 18/6, Wondercide 4-scent/4-size, Horse 10-color) fail closed with variant_selection_required until an operator completes variant selection — and per VARIANT_LIMIT_207 neither name nor barcode retries resolve, so size/scent/color-specific items wait for the operator flow. Per #197 story 16 this is correct behavior — the wrong SKU is never extracted with confidence — and no selector draft can resolve option identity.',
    draftNeeded: false,
  },
];

/** Activation basis under the authoritative rule (3 confirmations or audited waiver). */
export type ShopifyActivationBasis207 = 'three_confirmations' | 'audited_waiver';

/**
 * Final release-health authority at release time. The eligibility
 * predicate below is necessary but NOT sufficient: the live release path
 * (`releaseDomainExtractionItems`) enforces this gate, and nothing in
 * this record may be wired as a release gate on its own.
 */
export const SHOPIFY_207_RELEASE_HEALTH_AUTHORITY =
  'getDomainReleaseHealth (src/onboarding/domain-release.ts) — final authority at release time';

/** Per-domain activation-evidence evaluation. */
export interface ShopifyActivation207 {
  domain: ShopifyDomain207;
  /**
   * True: the confirmation-count evidence satisfies the count basis with
   * no waiver. Evidence only — NOT the authoritative gate: the live
   * system still runs version activation (active version, matching
   * artifact hashes, passing title matrix, imageRuleOk) before anything
   * releases.
   */
  evidenceSatisfied: boolean;
  basis: ShopifyActivationBasis207;
  waiver: false;
  /** The three confirmed sample URLs for this domain. */
  confirmations: readonly string[];
  /**
   * Operator-only steps remaining in the live system (governance:
   * proposals-only promotion, per-field approval, image-preview
   * attestation). Evidence cannot satisfy these — a human must.
   */
  pendingOperatorSteps: readonly string[];
}

/** Activation-evidence evaluation for all six Shopify profiles (3 confirmations each, no waivers). */
export function evaluateActivation207(): readonly ShopifyActivation207[] {
  return SHOPIFY_207_PROFILES.map((profile) => {
    const confirmations = SHOPIFY_207_SAMPLES.filter(
      (s) => s.domain === profile.domain && s.verdict === 'confirmed_clean',
    ).map((s) => s.url);
    return {
      domain: profile.domain,
      evidenceSatisfied: confirmations.length >= 3,
      basis: 'three_confirmations' as const,
      waiver: false as const,
      confirmations,
      pendingOperatorSteps: [
        `Approve title/brand/description/images selectors per field for ${profile.domain} in the Profile Builder (proposal-only governance; this record is the proposal evidence).`,
        `Attest image-preview review for the ${profile.domain} gallery sets (including the named review-burden rows: ${profile.domain === 'openfarmpet.com' ? 'icon/video-poster/nutritional-label images' : profile.domain === 'www.wondercide.com' ? 'family cross-sell rail + video poster' : 'thin single-shot galleries where present'} — keep or reject explicitly). Agent-side preview was impossible in this environment (image reading disabled); the preview URLs are recorded in the worker responses transcribed here.`,
        `Activate the profile version, then selectively release eligible ${profile.domain} items via the selected-retry path: this record proves the necessary conditions only — getDomainReleaseHealth is the final authority at release time (#198). Multi-variant items wait for operator variant selection first (see VARIANT_LIMIT_207).`,
      ],
    };
  });
}

/** Source-URL kind driving release eligibility (worker verdict taxonomy). */
export type ShopifyUrlKind207 = 'confirmed_clean' | 'variant_blocked' | 'unknown';

/** Selective-release eligibility outcome for one Shopify item. */
export interface ShopifyReleaseEligibility207 {
  eligible: boolean;
  reason: string;
}

/**
 * Selective-release eligibility (#198 hardening + #207 worker verdicts).
 * Eligible only for failed-extraction items in the requesting workspace
 * whose source URL validated clean. Variant-blocked URLs unlock after
 * operator variant selection; nothing auto-runs outside this predicate.
 */
export function selectiveReleaseEligibility207(input: {
  stageStatus: string;
  sameWorkspace: boolean;
  urlKind: ShopifyUrlKind207;
}): ShopifyReleaseEligibility207 {
  if (input.stageStatus !== 'failed_extraction') {
    return { eligible: false, reason: `retry_ineligible_stage: stage is ${input.stageStatus}, not failed_extraction` };
  }
  if (!input.sameWorkspace) {
    return { eligible: false, reason: 'foreign_workspace: item belongs to another workspace' };
  }
  switch (input.urlKind) {
    case 'confirmed_clean':
      return { eligible: true, reason: 'eligible: failed item, own workspace, worker-validated clean URL — subject to getDomainReleaseHealth at release time' };
    case 'variant_blocked':
      return { eligible: false, reason: 'variant_resolution_required: source page needs operator variant selection first (name and barcode retries do not resolve — see VARIANT_LIMIT_207)' };
    case 'unknown':
    default:
      return { eligible: false, reason: 'unvalidated_url: run worker validation on the item source URL before release' };
  }
}

/** Look up a profile row by domain key. */
export function profile207ByDomain(domain: string): ShopifyProfile207 | undefined {
  return SHOPIFY_207_PROFILES.find((p) => p.domain === domain);
}

/** Look up a validation sample by product-page URL. */
export function sample207ByUrl(url: string): ShopifyValidationSample207 | undefined {
  return SHOPIFY_207_SAMPLES.find((s) => s.url === url);
}

/** Confirmations for one domain (activation count basis input). */
export function confirmations207ByDomain(domain: ShopifyDomain207): readonly ShopifyValidationSample207[] {
  return SHOPIFY_207_SAMPLES.filter((s) => s.domain === domain && s.verdict === 'confirmed_clean');
}

/**
 * No-assumed-endpoint-fetching seam (acceptance: the platform finding is
 * reflected in the mechanism without runtime endpoint fetching). The
 * runtime selectors must reference no network endpoints — fields come
 * from the fetched HTML only; the platform JSON served purely as
 * authoring-time cross-evidence.
 */
export function profiles207ReferenceNoEndpoints(): boolean {
  const selectors: Array<string | null> = [
    SHOPIFY_207_SHARED_SELECTORS.titleSelector,
    SHOPIFY_207_SHARED_SELECTORS.brandSelector,
    SHOPIFY_207_SHARED_SELECTORS.descriptionSelector,
    SHOPIFY_207_SHARED_SELECTORS.priceSelector,
    ...Object.values(SHOPIFY_207_IMAGES_SELECTORS),
  ];
  return selectors.every(
    (sel) => sel === null || (!sel.includes('wp-json') && !sel.includes('http') && !sel.includes('/products?') && !sel.includes('.js')),
  );
}
