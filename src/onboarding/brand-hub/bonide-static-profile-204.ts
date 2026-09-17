// Issue #204 — Bonide static structured-data profile (5 items).
//
// A minimal static structured-data profile for bonide.com: explicit
// structured-data field selectors validated through the production worker
// (POST /profile-runner/extract, runtime static) against real Bonide
// product URLs — not tooling previews — then handed to the governed
// activation path. Only fields the structured layer provably cannot carry
// would escalate to a light AI draft; none do (see FIELD_GAPS_204).
//
// Inputs (consumed, never re-probed):
// - #201 (`product-page-verdicts-201.ts`): bonide.com verdict
//   `static_profile` — WooCommerce markers with a public Store API that
//   answers by slug (`?slug=eight-insect-control-garden-dust` → name +
//   sku 784-P + type variable + 4 images + variation ids). Settles the
//   WooCommerce-vs-plain-WordPress question as WooCommerce.
// - #198 (`domain-release.ts` `getDomainReleaseHealth`): the release guard
//   this ticket's selective release runs behind — no auto-requeue before
//   reviewed health; selected retry only for failed-extraction items in
//   the requesting workspace.
//
// Method (2026-09-16, authoring-time live validation; committed tests use
// only the transcribed evidence below — no network, no DB):
// - Started the repo's own extraction worker locally and POSTed candidate
//   profile v1 (runtime `static`, selectors below, `allowedSourceDomains:
//   ['bonide.com']`) for 10 real Bonide product URLs. The worker fetched
//   each page itself with production headers, the variant gate ran in its
//   default `active` mode, and results below are the worker's verbatim
//   verdicts (ok / failureCode / provenance / content hash).
// - Mechanism reflects the #201 finding with NO assumed endpoint
//   fetching: the profile carries fields via CSS + meta selectors against
//   the fetched HTML only. The public Store API was used purely as
//   cross-evidence at authoring time (name/SKU corroboration) and appears
//   nowhere in the profile — the ladder/worker never fetch hinted
//   endpoints, and neither does this profile.
//
// This module moves no items, writes no profiles, performs no network I/O,
// and touches no DB rows (dependency-free pure data + pure helpers, like
// the #199 resolutions, #201 verdicts, #202 alignment, and #203 routing
// modules). Activation (per-field Builder approval, image-preview
// attestation, version activation) and selective release are operator acts
// in the live system; this record proves they are unblocked and states
// their exact eligibility rule.

/** Profile domain key (worker fetch host; no redirect split per #201). */
export const BONIDE_204_DOMAIN = 'bonide.com';

/** Blocked Bonide items this profile unblocks. */
export const BONIDE_204_TOTAL_ITEMS = 5;

/** Candidate profile version validated through the worker. */
export const BONIDE_204_PROFILE_VERSION = 1;

/** Profile runtime: static fetch only (no rendered browser needed). */
export const BONIDE_204_RUNTIME = 'static' as const;

/**
 * Validated selector set v1. Explicit structured-data selectors first
 * (`meta[...]`), one stable CSS selector where the structured layer has
 * no equivalent (`h1` — exactly one per product page, verified on both
 * #201 probe pages plus bonide2 re-check), Woo gallery CSS for images.
 * `priceSelector` is null by design (accepted gap, see FIELD_GAPS_204).
 */
export interface BonideProfileSelectors204 {
  titleSelector: string;
  brandSelector: string;
  descriptionSelector: string;
  priceSelector: null;
  imagesSelector: string;
}

export const BONIDE_204_SELECTORS: BonideProfileSelectors204 = {
  titleSelector: 'h1',
  brandSelector: 'meta[property="og:site_name"]',
  descriptionSelector: 'meta[property="og:description"]',
  priceSelector: null,
  imagesSelector: '.woocommerce-product-gallery__image',
};

/** Worker verdict for one validation sample URL. */
export type BonideSampleVerdict204 =
  | 'confirmed_clean'
  | 'variant_blocked'
  | 'discontinued_excluded';

/** One worker-validation sample (transcribed 2026-09-16; fidelity-tested). */
export interface BonideValidationSample204 {
  /** Leaf product-page URL fetched by the worker. */
  url: string;
  /** Worker verdict for the profile v1 selector set. */
  verdict: BonideSampleVerdict204;
  /** Worker `ok` flag. */
  ok: boolean;
  /** Worker failure code (`variant_selection_required` or null). */
  failureCode: string | null;
  /** Extracted title (null when the variant gate failed closed first). */
  title: string | null;
  /** Field provenance as reported by the worker (empty when gated). */
  provenance: Record<string, string>;
  /** Source content hash (full 64-hex where observed, else observed prefix). */
  contentHash: string | null;
  /** Woo variation candidates (variant-blocked rows only). */
  variantCandidates?: Array<{ key: string; sku: string }>;
  /** Why this row counts (or does not count) toward activation. */
  rationale: string;
}

export const BONIDE_204_SAMPLES: readonly BonideValidationSample204[] = [
  {
    url: 'https://bonide.com/product/eight-insect-control-garden-dust/',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Eight® Insect Control Garden Dust',
    provenance: {
      title: 'profile-selector',
      brand: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '28b0ee4b6c2f622616ae86c291bc084b72fa4b1f77c6218c286deb529757d358',
    rationale:
      'Full pass through the production worker: h1 title matches the Store API name, brand "Bonide" via og:site_name, Yoast description via og:description, primary Plytix 784_Front plus 2 lifestyle additional images via the Woo gallery. No variant gate (static HTML carries no parseable variation options on this page despite the Store API "variable" type). Counts as confirmation 1 of 3.',
  },
  {
    url: 'https://bonide.com/product/eight-insect-control-home-garden-rtu/',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Eight Insect Control Home & Garden Ready-to-Use',
    provenance: {
      title: 'profile-selector',
      brand: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '6105f702642e',
    rationale:
      'Full pass: correct product title via h1, brand via og:site_name, 157-char description via og:description, 5 gallery images. No variant gate. Counts as confirmation 2 of 3. (Hash recorded as the observed 12-hex prefix.)',
  },
  {
    url: 'https://bonide.com/product/neem-oil-conc/',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    title: 'Captain Jack’s Neem Oil Concentrate',
    provenance: {
      title: 'profile-selector',
      brand: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '1e012193d69e',
    rationale:
      'Full pass: correct product title via h1, brand via og:site_name, 158-char description via og:description, 8 gallery images. No variant gate. Counts as confirmation 3 of 3 — the three-confirmation rule is satisfied on evidence with no waiver. (Hash recorded as the observed 12-hex prefix.)',
  },
  {
    url: 'https://bonide.com/product/pyrethrin-garden-spray-conc/',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    provenance: {},
    contentHash: null,
    variantCandidates: [
      { key: 'woocommerce:74137:8-oz', sku: '857' },
      { key: 'woocommerce:74141:pint', sku: '858' },
    ],
    rationale:
      'Fails closed by design (#197 story 16): the static HTML parses a 2-candidate Woo variation matrix (8-oz sku 857, pint sku 858) that name-only expected data cannot discriminate (no_match rank_below_threshold, gate mode active). Not a profile defect — a draft cannot resolve size identity either. Unlocks via a variant-discriminating item identifier (variation SKU) or the operator variant-selection flow. Excluded from confirmations; its future item releases only after variant resolution.',
  },
  {
    url: 'https://bonide.com/product/captain-jacks-neem-max-conc/',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    provenance: {},
    contentHash: null,
    variantCandidates: [
      { key: 'woocommerce:92622:8-oz', sku: '020' },
      { key: 'woocommerce:92623:16-oz', sku: '026' },
    ],
    rationale:
      'Fails closed by design: 2-candidate Woo variation matrix (8-oz sku 020, 16-oz sku 026), no_match rank_below_threshold. Same unlock path as pyrethrin (variation SKU or operator selection). Excluded from confirmations. Note: this is a different page than the confirmed neem-oil-conc sample.',
  },
  {
    url: 'https://bonide.com/product/sulfur-plant-fungicide-dust/',
    verdict: 'variant_blocked',
    ok: false,
    failureCode: 'variant_selection_required',
    title: null,
    provenance: {},
    contentHash: null,
    variantCandidates: [
      { key: 'woocommerce:72882:1lb', sku: '141' },
      { key: 'woocommerce:72886:4lb', sku: '1428' },
    ],
    rationale:
      'Fails closed by design: 2-candidate Woo variation matrix (1lb sku 141, 4lb sku 1428), no_match rank_below_threshold. Same unlock path. Excluded from confirmations.',
  },
  {
    url: 'https://bonide.com/product/roach-powder/',
    verdict: 'discontinued_excluded',
    ok: true,
    failureCode: null,
    title: 'Discontinued Products',
    provenance: { title: 'profile-selector', brand: 'meta' },
    contentHash: '24d53f6acfa02a6cabb42811bda66b7273b74ff3d227e785f90a2049a537c2f8',
    rationale:
      'Excluded as wrong-product: the slug serves the shared "Discontinued Products" page (identical content hash on all four discontinued probes). The worker reports ok (non-empty title) so hash-identity against this known page — not the ok flag — is the exclusion signal. Never a confirmation.',
  },
  {
    url: 'https://bonide.com/product/spider-killer-rtu/',
    verdict: 'discontinued_excluded',
    ok: true,
    failureCode: null,
    title: 'Discontinued Products',
    provenance: { title: 'profile-selector', brand: 'meta' },
    contentHash: '24d53f6acfa02a6cabb42811bda66b7273b74ff3d227e785f90a2049a537c2f8',
    rationale:
      'Excluded as wrong-product: same shared discontinued page and content hash as roach-powder. Never a confirmation.',
  },
  {
    url: 'https://bonide.com/product/captan-fruit-ornamental-wp/',
    verdict: 'discontinued_excluded',
    ok: true,
    failureCode: null,
    title: 'Discontinued Products',
    provenance: { title: 'profile-selector', brand: 'meta' },
    contentHash: '24d53f6acfa02a6cabb42811bda66b7273b74ff3d227e785f90a2049a537c2f8',
    rationale:
      'Excluded as wrong-product: same shared discontinued page and content hash. Never a confirmation.',
  },
  {
    url: 'https://bonide.com/product/mite-x-rtu/',
    verdict: 'discontinued_excluded',
    ok: true,
    failureCode: null,
    title: 'Discontinued Products',
    provenance: { title: 'profile-selector', brand: 'meta' },
    contentHash: '24d53f6acfa02a6cabb42811bda66b7273b74ff3d227e785f90a2049a537c2f8',
    rationale:
      'Excluded as wrong-product: same shared discontinued page and content hash. Never a confirmation.',
  },
];

/** Per-field outcome for the static structured layer. */
export type BonideFieldStatus204 = 'carried' | 'accepted_gap' | 'conditional';

/**
 * Field-by-field gap enumeration (acceptance: gaps enumerated before any
 * draft is considered). `draftNeeded` is false on every row — no field
 * escalates to even a light AI draft.
 */
export interface BonideFieldGap204 {
  field: 'title' | 'brand' | 'description' | 'images' | 'price' | 'variants';
  status: BonideFieldStatus204;
  /** Worker-observed evidence carrying (or limiting) this field. */
  evidence: string;
  /** Whether any AI draft is needed for this field. Always false. */
  draftNeeded: false;
}

export const FIELD_GAPS_204: readonly BonideFieldGap204[] = [
  {
    field: 'title',
    status: 'carried',
    evidence:
      'Worker extracted the exact product name via h1 on all 3 confirmations (single h1 per page, verified on both #201 probe pages; matches Store API names). Explicit exception to structured-only: no structured title surface carries the product name (og:title is the SEO title, not the product name; no JSON-LD Product exists). Provenance profile-selector.',
    draftNeeded: false,
  },
  {
    field: 'brand',
    status: 'carried',
    evidence:
      'Worker extracted "Bonide" via meta[property="og:site_name"] on all 3 confirmations. Provenance meta. No JSON-LD brand exists (Yoast WebPage/Breadcrumb/Org only) and none is needed.',
    draftNeeded: false,
  },
  {
    field: 'description',
    status: 'carried',
    evidence:
      'Worker extracted the Yoast SEO description via meta[property="og:description"] on all 3 confirmations (157–158 chars on the two measured pages). Richer Woo tab content exists but uses per-template tab IDs; the stable structured surface suffices.',
    draftNeeded: false,
  },
  {
    field: 'images',
    status: 'carried',
    evidence:
      'Worker extracted 4–8 gallery images per confirmation via .woocommerce-product-gallery__image (Plytix CDN product shots). Explicit exception to structured-only: the single og:image was passed over for multi-image gallery coverage. Caveats for preview review: the eight gallery also yields 1 YouTube video-poster additional image, and the worker has no imageRules support (schema field only, unused in extract.ts), so poster exclusion is a reviewer decision, not a selector rule. Preview attestation itself is an operator act (see activation).',
    draftNeeded: false,
  },
  {
    field: 'price',
    status: 'accepted_gap',
    evidence:
      'Static HTML carries only the JS variation template {{{ data.variation.price_html }}}; no JSON-LD offers and no product:price meta exist, so no static selector can carry price. Accepted (not drafted): the worker covers price from expected.price with spreadsheet-import provenance whenever the item carries it. A draft could not do better — there is no static price surface to select.',
    draftNeeded: false,
  },
  {
    field: 'variants',
    status: 'conditional',
    evidence:
      'Single-candidate pages (all 3 confirmations) pass with no gate. Multi-size-variation pages (pyrethrin 857/858, neem-max 020/026, sulfur 141/1428) fail closed with variant_selection_required until the item carries a discriminating identifier (Woo variation SKU) or an operator completes variant selection. Per #197 story 16 this is correct behavior — the wrong SKU is never extracted with confidence — and no selector draft can resolve size identity.',
    draftNeeded: false,
  },
];

/** Activation basis under the authoritative rule (3 confirmations or audited waiver). */
export type BonideActivationBasis204 = 'three_confirmations' | 'audited_waiver';

/**
 * Final release-health authority at release time. The eligibility
 * predicate below is necessary but NOT sufficient: the live release path
 * (`releaseDomainExtractionItems`) enforces this gate, and nothing in
 * this record may be wired as a release gate on its own.
 */
export const BONIDE_204_RELEASE_HEALTH_AUTHORITY =
  'getDomainReleaseHealth (src/onboarding/domain-release.ts) — final authority at release time';

/** Activation-evidence evaluation for the Bonide static profile. */
export interface BonideActivation204 {
  /**
   * True: the confirmation-count evidence satisfies the count basis with
   * no waiver. Evidence only — NOT the authoritative gate: the live
   * system still runs version activation (active version, matching
   * artifact hashes, passing title matrix, imageRuleOk) before anything
   * releases.
   */
  evidenceSatisfied: boolean;
  basis: BonideActivationBasis204;
  waiver: false;
  /** The three confirmed sample URLs. */
  confirmations: readonly string[];
  /**
   * Operator-only steps remaining in the live system (governance:
   * proposals-only promotion, per-field approval, image-preview
   * attestation). Evidence cannot satisfy these — a human must.
   */
  pendingOperatorSteps: readonly string[];
}

export function evaluateActivation204(): BonideActivation204 {
  const confirmations = BONIDE_204_SAMPLES.filter((s) => s.verdict === 'confirmed_clean').map((s) => s.url);
  return {
    evidenceSatisfied: confirmations.length >= 3,
    basis: 'three_confirmations',
    waiver: false,
    confirmations,
    pendingOperatorSteps: [
      'Approve title/brand/description/images selectors per field in the Profile Builder (proposal-only governance; this record is the proposal evidence).',
      'Attest image-preview review for the gallery sets (including the YouTube video-poster additional image on the eight page — keep or reject explicitly). Agent-side preview was impossible in this environment (image reading disabled); the preview URLs are recorded in the plan doc.',
      'Activate the profile version, then selectively release eligible Bonide items via the selected-retry path: this record proves the necessary conditions only — getDomainReleaseHealth is the final authority at release time (#198).',
    ],
  };
}

/** Source-URL kind driving release eligibility (worker verdict taxonomy). */
export type BonideUrlKind204 = 'confirmed_clean' | 'variant_blocked' | 'discontinued_excluded' | 'unknown';

/** Selective-release eligibility outcome for one Bonide item. */
export interface BonideReleaseEligibility204 {
  eligible: boolean;
  reason: string;
}

/**
 * Selective-release eligibility (#198 hardening + #204 worker verdicts).
 * Eligible only for failed-extraction items in the requesting workspace
 * whose source URL validated clean. Variant-blocked URLs unlock after
 * variant resolution; discontinued URLs never release; nothing
 * auto-runs outside this predicate.
 */
export function selectiveReleaseEligibility204(input: {
  stageStatus: string;
  sameWorkspace: boolean;
  urlKind: BonideUrlKind204;
}): BonideReleaseEligibility204 {
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
      return { eligible: false, reason: 'variant_resolution_required: source page needs a discriminating SKU or operator variant selection first' };
    case 'discontinued_excluded':
      return { eligible: false, reason: 'wrong_product: source URL serves the shared discontinued page' };
    case 'unknown':
    default:
      return { eligible: false, reason: 'unvalidated_url: run worker validation on the item source URL before release' };
  }
}

/** Look up a validation sample by product-page URL. */
export function sample204ByUrl(url: string): BonideValidationSample204 | undefined {
  return BONIDE_204_SAMPLES.find((s) => s.url === url);
}

/**
 * No-assumed-endpoint-fetching seam (acceptance: the WooCommerce finding
 * is reflected in the mechanism). The profile must reference no network
 * endpoints — fields come from the fetched HTML only.
 */
export function profile204ReferencesNoEndpoints(): boolean {
  return Object.values(BONIDE_204_SELECTORS).every(
    (sel) => sel === null || (!sel.includes('wp-json') && !sel.includes('http') && !sel.includes('/products?')),
  );
}
