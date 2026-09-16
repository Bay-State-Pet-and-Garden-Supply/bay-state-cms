// Issue #205 — Nylabone single Sitecore draft (5 items).
//
// A single AI-assisted draft for nylabone.com treated as a coverage
// experiment: generate, then prove the shared-template assumption by
// validating across distinct product templates before activation. Per-field
// approve/reject preserved; partial generations still yield usable profiles.
//
// Inputs (consumed, never re-probed):
// - #201 (`product-page-verdicts-201.ts`): nylabone.com verdict `ai_draft`
//   (single; shared SXA template fingerprinted on 2 power-chew pages) with
//   one CORRECTION recorded here: the JSON-LD `@type:Product` nodes are not
//   empty shells. Sitecore emits capitalized keys (`Name`, `Sku`,
//   `Gtin12`, `Image.Url`, `Description`, `Brand.Name`) carrying
//   variant-discriminating identity per variant node (see
//   SITECORE_JSONLD_CORRECTION_205). The production worker's `jsonld:`
//   selectors and variant-matrix parser use lowercase schema.org keys
//   (`name`, `sku`, `hasVariant`), so they cannot resolve these nodes —
//   the draft carries fields via CSS + meta selectors, and the JSON-LD
//   serves as authoring-time cross-evidence only (never a runtime
//   dependency, never a `jsonld:` selector).
// - #198 (`domain-release.ts` `getDomainReleaseHealth`): the release guard
//   this ticket's selective release runs behind — no auto-requeue before
//   reviewed health; selected retry only for failed-extraction items in
//   the requesting workspace.
//
// Method (2026-09-16, authoring-time live validation; committed tests use
// only the transcribed evidence below — no network, no DB):
// - Started the repo's own extraction worker locally and POSTed candidate
//   draft v1 (runtime `static`, selectors below, `allowedSourceDomains:
//   ['www.nylabone.com', 'nylabone.com']`) for 6 real Nylabone product
//   URLs spanning 4 product lines and 2 URL shapes (power-chew, puppy-chew,
//   moderate-chew at depth-8; edible-chew-treats and dental-solutions at
//   depth-7). The worker fetched each page itself with production headers,
//   the variant gate ran in its default mode, and results below are the
//   worker's verbatim verdicts (ok / failureCode / provenance / content
//   hash / matrix decision).
// - The shared-template assumption is PROVEN, not fingerprinted: all four
//   lines share the identical SXA theme fingerprint AND identical
//   structural surfaces (bare `h1` ×1, `.body-copy`, `.product-image-
//   gallery`, `select#primaryvariationvalue`, no price surface, no
//   `og:site_name`). Multi-structure dispatch is not needed; the finding
//   is recorded explicitly in TEMPLATE_FINDING_205 (acceptance: templates
//   genuinely sharing one structure are covered by the single draft, and
//   the record says so instead of silently covering one).
//
// This module moves no items, writes no profiles, performs no network I/O,
// and touches no DB rows (dependency-free pure data + pure helpers, like
// the #199 resolutions, #201 verdicts, #202 alignment, #203 routing, and
// #204 static-profile modules). Activation (per-field Builder approval,
// image-preview attestation, version activation) and selective release are
// operator acts in the live system; this record proves they are unblocked
// and states their exact eligibility rule.

/** Profile domain key (worker fetch host; www-served per #201). */
export const NYLABONE_205_DOMAIN = 'www.nylabone.com';

/** Blocked Nylabone items this draft unblocks. */
export const NYLABONE_205_TOTAL_ITEMS = 5;

/** Candidate draft version validated through the worker. */
export const NYLABONE_205_PROFILE_VERSION = 1;

/** Draft runtime: static fetch only (no rendered browser needed). */
export const NYLABONE_205_RUNTIME = 'static' as const;

/**
 * Validated selector set v1. Structured-data selectors first
 * (`meta[property="og:description"]`), one stable CSS selector where the
 * worker-resolvable structured layer has no equivalent (`h1` — exactly one
 * per product page on all four validated lines), SXA gallery CSS for
 * images. `brandSelector` and `priceSelector` are null by design (per-field
 * reject with rationale, see FIELD_DECISIONS_205): no worker-resolvable
 * brand surface exists (no `og:site_name`, no `product:brand` meta, and the
 * JSON-LD `Brand.Name` key is capitalized-unreadable to the worker), and no
 * static price surface exists. The draft remains usable without them: the
 * worker leaves brand null (non-fatal; brand is supplied by brand
 * assignment) and covers price from `expected.price` with
 * spreadsheet-import provenance whenever the item carries it.
 */
export interface NylaboneDraftSelectors205 {
  titleSelector: string;
  brandSelector: null;
  descriptionSelector: string;
  priceSelector: null;
  imagesSelector: string;
}

export const NYLABONE_205_SELECTORS: NylaboneDraftSelectors205 = {
  titleSelector: 'h1',
  brandSelector: null,
  descriptionSelector: 'meta[property="og:description"]',
  priceSelector: null,
  imagesSelector: '.product-image-gallery img',
};

/**
 * Correction to the #201 input artifact (transcribed from live leaf pages
 * 2026-09-16; the #201 "empty shells" reading came from matching lowercase
 * schema.org keys against Sitecore's capitalized emission).
 *
 * Every validated page carries one primary JSON-LD Product node plus one
 * node per size variant, each with `Name` (variant-specific, e.g.
 * "Nylabone Power Chew Groove Bone Dog Chew Toy Flavor Medley Small
 * (1 Count)"), `Sku` (e.g. `NCF302PR`), `Gtin12` (e.g. `018214822950`),
 * `Image.Url`, `Description`, and `Brand.Name`. Variant nodes carry
 * DISTINCT Sku+Gtin12+Name per size (groove: 8 variant nodes; bacon: 10).
 * The worker cannot consume them: `evaluateSelectorCheerio` resolves only
 * lowercase `name`/`description`/`offers.price`/`brand.name`, and
 * `parseJsonLdMatrix` requires `ProductGroup` or `Product.hasVariant`
 * (lowercase) wrappers Nylabone never emits. Consequence: no `jsonld:`
 * selector appears in this draft, and variant distinction is NOT enforced
 * by the worker gate on Nylabone pages (see VARIANT_CAVEAT_205).
 */
export const SITECORE_JSONLD_CORRECTION_205 =
  'Sitecore capitalized-key Product nodes (Name/Sku/Gtin12/Image.Url/Description/Brand.Name) ' +
  'carry variant-discriminating identity on every validated page; worker lowercase jsonld: selectors ' +
  'and the hasVariant-matrix parser cannot resolve them — authoring-time cross-evidence only.';

/** Distinct product-template shape validated (URL depth + product line). */
export interface NylaboneTemplate205 {
  /** Short template label used in sample rows. */
  label: string;
  /** Representative product line (sitemap group). */
  line: string;
  /** URL shape: path segments after the host. */
  urlShape: string;
}

/** Templates covered by worker validation (acceptance: 2+ distinct). */
export const NYLABONE_205_TEMPLATES: readonly NylaboneTemplate205[] = [
  {
    label: 'power-chew',
    line: 'chew-toys/power-chew',
    urlShape: '/products/product-type/chew-toys/power-chew/<slug> (depth-8)',
  },
  {
    label: 'puppy-chew',
    line: 'chew-toys/puppy-chew',
    urlShape: '/products/product-type/chew-toys/puppy-chew/<slug> (depth-8)',
  },
  {
    label: 'moderate-chew',
    line: 'chew-toys/moderate-chew',
    urlShape: '/products/product-type/chew-toys/moderate-chew/<slug> (depth-8)',
  },
  {
    label: 'edible-chew-treats',
    line: 'edible-chew-treats/<slug>',
    urlShape: '/products/product-type/edible-chew-treats/<slug> (depth-7)',
  },
  {
    label: 'dental-solutions',
    line: 'dental-solutions/<slug>',
    urlShape: '/products/product-type/dental-solutions/<slug> (depth-7)',
  },
];

/**
 * Shared-template finding (acceptance: if templates genuinely differ in
 * structure, the ticket records the finding instead of silently covering
 * one — here they do NOT differ, and the record says exactly that).
 *
 * "Template" here means product-line/URL-shape template at the Sitecore
 * presentation level (the level #201's "second-template validation"
 * requirement addresses) — not extraction structure. The experiment's
 * positive result is that these distinct presentation templates share one
 * extraction structure, so one draft covers them all.
 *
 * All five lines share: the identical SXA theme fingerprint
 * (`experience-accelerator`, `sxa-base-theme`, `oneweb/nylabone`); exactly
 * one bare `h1`; `.body-copy` description container; `.component
 * .productimage.product-image-gallery.col-12` gallery; a size
 * `select#primaryvariationvalue`; `og:title`/`og:description`/`og:image`
 * meta; no `meta[name=description]`; no `og:site_name`; no price meta and
 * no price classes. One draft covers all five lines; per-template profiles
 * (multi-structure dispatch, out of scope per #197) are not needed.
 */
export const TEMPLATE_FINDING_205 =
  'Single shared SXA structure proven across 5 lines / 2 URL shapes (identical theme fingerprint and ' +
  'identical extraction surfaces on all 6 worker-validated pages): one draft covers nylabone.com; ' +
  'no multi-structure dispatch needed.';

/**
 * Variant caveat (acceptance: variant-bearing pages prove correct variant
 * distinction before health — here distinction is scoped, honestly).
 *
 * Every validated family page is variant-bearing: a size
 * `select#primaryvariationvalue` (Small/Regular, Medium/Wolf,
 * Large/Giant, X-Large/Souper) plus per-size JSON-LD nodes with distinct
 * Sku+Gtin12. But the worker parsed NO variant matrix on any Nylabone page
 * (`matrixDecision: null` on all 6 samples): the Sitecore `<select>` and
 * capitalized-key flat Product nodes match none of the five matrix parsers
 * (shopify/jsonld/woo/bigcommerce/magento). So the gate cannot fail closed
 * here the way it does on Bonide — family-level extraction passes without
 * discriminating sizes, and the gallery may serve wrong-variant images
 * (observed: the Small/Medley groove page galleries the X-Large silo
 * `018214822974-silo.jpg`). Consequence: size-specific items release only
 * after operator variant selection (or a future Sitecore matrix parser, out
 * of scope); family-level items may release under the predicate below.
 * This caveat travels with every confirmation — it is not a waiver.
 */
export const VARIANT_CAVEAT_205 =
  'Worker parses no variant matrix on Sitecore pages (matrixDecision null on all 6 samples): ' +
  'family-level extraction cannot discriminate sizes and galleries may mix variant images — ' +
  'size-specific items require operator variant selection first; no silent confident wrong-SKU extraction.';

/** Worker verdict for one validation sample URL. */
export type NylaboneSampleVerdict205 = 'confirmed_clean';

/** One worker-validation sample (transcribed 2026-09-16; fidelity-tested). */
export interface NylaboneValidationSample205 {
  /** Leaf product-page URL fetched by the worker. */
  url: string;
  /** Template label from NYLABONE_205_TEMPLATES. */
  template: string;
  /** Worker verdict for draft v1. All six validate clean. */
  verdict: NylaboneSampleVerdict205;
  /** Worker `ok` flag. */
  ok: boolean;
  /** Worker failure code (null on every sample). */
  failureCode: string | null;
  /** Worker variant-matrix decision (null on every sample — see VARIANT_CAVEAT_205). */
  matrixDecision: null;
  /** Extracted family title via `h1`. */
  title: string;
  /** Brand as returned by the worker (null on every sample — no resolvable surface). */
  brand: string | null;
  /** Length of the worker-extracted `og:description` text. */
  descriptionLength: number;
  /** Primary gallery image URL path (imedia `/-/media/` product shot). */
  primaryImage: string;
  /** Count of additional gallery images. */
  additionalImageCount: number;
  /** Field provenance as reported by the worker. */
  provenance: Record<string, string>;
  /** Source content hash (observed 16-hex prefix). */
  contentHash: string;
  /** Why this row counts toward activation. */
  rationale: string;
}

export const NYLABONE_205_SAMPLES: readonly NylaboneValidationSample205[] = [
  {
    url: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/dura-chew-power-chew-textured-bone',
    template: 'power-chew',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Power Chew Groove Bone Dog Chew Toy',
    brand: null,
    descriptionLength: 147,
    primaryImage:
      'https://www.nylabone.com/-/media/project/oneweb/nylabone/images/our-products/all-products/ncf302pr/018214822950-nylabone-medley-textured-small-bone-inpackagingfront.jpg',
    additionalImageCount: 12,
    provenance: {
      title: 'profile-selector',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '608bad86b2212c41',
    rationale:
      'Full pass through the production worker on template power-chew (depth-8): exact family title via h1, 147-char description via og:description, primary in-packaging shot plus 12 gallery images via .product-image-gallery img. Known gallery impurity, dispositioned to preview attestation (not counted against the family-level pass): the set includes the X-Large silo 018214822974-silo.jpg on this Small/Medley page — see VARIANT_CAVEAT_205. Counts as confirmation 1 of 3+ (family level; size-specific items still owe operator variant selection per VARIANT_CAVEAT_205).',
  },
  {
    url: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/durachew-cheese-bone',
    template: 'power-chew',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Power Chew Cheese Bone Dog Chew Toy',
    brand: null,
    descriptionLength: 147,
    primaryImage:
      'https://www.nylabone.com/-/media/project/oneweb/nylabone/images/our-products/all-products/ncbg404p/018214841050-nylabone-dura-chew-cheese-bone-flavor-giant-inpackagingfront.jpg',
    additionalImageCount: 10,
    provenance: {
      title: 'profile-selector',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '1a0cd8d3e270898e',
    rationale:
      'Full pass on the second power-chew page (the #201 fingerprinted pair, now worker-validated): correct family title, meta description, primary plus 10 gallery images. Distinct content hash from the groove page — two different products, same structure. Counts as confirmation 2 of 3+ (family level; variant caveat applies).',
  },
  {
    url: 'https://www.nylabone.com/products/product-type/edible-chew-treats/healthy-edibles-all-natural-long-lasting-bacon-chew-treats',
    template: 'edible-chew-treats',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Healthy Edibles All-Natural Long Lasting Chew Treats',
    brand: null,
    descriptionLength: 151,
    primaryImage:
      'https://www.nylabone.com/-/media/project/oneweb/nylabone/images/our-products/all-products/neb101tpp/018214813149-nylabone-healthy-edibles-bacon-2ct-petite-inpackagingfront.jpg',
    additionalImageCount: 11,
    provenance: {
      title: 'profile-selector',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '404cce1cfb2c5709',
    rationale:
      'Full pass on the SECOND template (edible-chew-treats, depth-7 URL shape — the acceptance requirement): the identical selector set extracts the correct family title, 151-char description, and 12 images with no template-specific adjustment. The shared-template assumption holds past power-chew. Counts as confirmation 3 of 3+ — the three-confirmation count basis is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://www.nylabone.com/products/product-type/dental-solutions/advanced-oral-care-dog-dental-kit',
    template: 'dental-solutions',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Advanced Oral Care Dog Dental Kit',
    brand: null,
    descriptionLength: 157,
    primaryImage:
      'https://www.nylabone.com/-/media/project/oneweb/nylabone/images/our-products/all-products/npd301p/018214827962-nylabone-aoc-adult-dental-kit-inpackagingfront.jpg',
    additionalImageCount: 11,
    provenance: {
      title: 'profile-selector',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '972e8968da3f5a96',
    rationale:
      'Full pass on the THIRD template (dental-solutions, depth-7): correct kit title, 157-char description, primary plus 11 gallery images (out-of-package, directions, lifestyle, brand-story). Three distinct templates pass with one selector set — coverage is proven, not assumed. Confirmation 4 (family level; variant caveat applies).',
  },
  {
    url: 'https://www.nylabone.com/products/product-type/chew-toys/puppy-chew/classic-puppy-chew-flavored-durable-dog-chew-toy',
    template: 'puppy-chew',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Puppy Power Chew Stages Teething Bone & Original Bone Dog Chew Toy',
    brand: null,
    descriptionLength: 147,
    primaryImage:
      'https://www.nylabone.com/-/media/project/oneweb/nylabone/images/our-products/all-products/npp101tppr/018214832423-npp101tppr-front.jpg',
    additionalImageCount: 10,
    provenance: {
      title: 'profile-selector',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '7f0f7bed4b8fa3c0',
    rationale:
      'Full pass on the FOURTH line (puppy-chew, depth-8): correct family title, 147-char description, primary plus 10 gallery images; worker brand null observed verbatim (no resolvable brand surface — the per-field brand reject below is observed, not assumed). Confirmation 5.',
  },
  {
    url: 'https://www.nylabone.com/products/product-type/chew-toys/moderate-chew/flexichew-bone-dog-chew-toys',
    template: 'moderate-chew',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Flexi Chew Gumabone Textured Dental Bone Dog Chew Toy',
    brand: null,
    descriptionLength: 125,
    primaryImage:
      'https://www.nylabone.com/-/media/project/oneweb/nylabone/images/our-products/all-products/nx933pr/018214812784-flex-dent-chew-petite-bl-inpackagingfront.jpg',
    additionalImageCount: 8,
    provenance: {
      title: 'profile-selector',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '6682ad75b2c770b3',
    rationale:
      'Full pass on the FIFTH line (moderate-chew, depth-8): correct family title, 125-char description, primary plus 8 gallery images. Five lines, two URL shapes, one selector set, six confirmations — the coverage experiment concludes: the single-draft assumption is proven. Confirmation 6.',
  },
];

/** Per-field approve/reject decision for the AI draft (acceptance: preserved; partial generations usable). */
export type NylaboneFieldDecision205 = 'approve' | 'reject' | 'conditional';

/**
 * Per-field approve/reject table. Approved fields form the committable
 * draft v1; rejected fields carry an explicit rationale and a non-draft
 * owner (brand assignment, spreadsheet import, operator flow) so the
 * partial generation is still a usable profile — exactly the
 * partial-generation acceptance requirement.
 */
export interface NylaboneFieldRow205 {
  field: 'title' | 'brand' | 'description' | 'images' | 'price' | 'variants';
  decision: NylaboneFieldDecision205;
  /** Draft selector committed for this field (null when rejected). */
  selector: string | null;
  /** Worker-observed evidence behind the decision. */
  evidence: string;
  /** Non-draft owner carrying the field when the draft does not. */
  carriedBy: string;
}

export const FIELD_DECISIONS_205: readonly NylaboneFieldRow205[] = [
  {
    field: 'title',
    decision: 'approve',
    selector: 'h1',
    evidence:
      'Worker extracted the exact family name via h1 on all 6 samples across 5 lines (single bare h1 per page on every template). Provenance profile-selector throughout.',
    carriedBy: 'draft v1 (this record)',
  },
  {
    field: 'description',
    decision: 'approve',
    selector: 'meta[property="og:description"]',
    evidence:
      'Worker extracted 125–157-char merchandising descriptions via og:description on all 6 samples. Provenance meta throughout. (Richer .body-copy tab content exists per page but uses per-template prose; the stable structured surface suffices and matches the #204 precedent.)',
    carriedBy: 'draft v1 (this record)',
  },
  {
    field: 'images',
    decision: 'approve',
    selector: '.product-image-gallery img',
    evidence:
      'Worker extracted 9–13 /-/media/ product shots per sample via the SXA gallery on all 6 samples. Provenance profile-selector throughout. Explicit exception to structured-only: the single og:image was passed over for multi-image gallery coverage. Caveats for preview review (NOT auto-filtered — the worker has no imageRules support): UGC photos (groove: lunathelittlemini, weeklywalter; bacon: 3 healthy-edibles-xs-ugc shots), cross-product images (groove galleries the X-Large 018214822974 silo; bacon carries nbq101vp8p-line UGC; dental carries npd303p-line images on the npd301p page), generic story images (brand-story, sustainability, made-in-USA, when-to-replace, size-chart), and one YouTube video-poster (bacon: i.ytimg.com/vi/9vhjqwespo4). Keep/reject is a reviewer decision per image — see the operator runbook in the plan doc.',
    carriedBy: 'draft v1 (this record), subject to image-preview attestation',
  },
  {
    field: 'brand',
    decision: 'reject',
    selector: null,
    evidence:
      'No worker-resolvable brand surface exists: no og:site_name, no product:brand meta, no microdata brand — and the JSON-LD Brand.Name key is capitalized-unreadable to the worker (lowercase brand.name lookup returns null; worker brand null observed verbatim on the puppy and flexi samples). A draft could not do better — there is no brand surface to select.',
    carriedBy: 'brand assignment (not extraction)',
  },
  {
    field: 'price',
    decision: 'reject',
    selector: null,
    evidence:
      'No static price surface exists: no price meta, no price classes, no JSON-LD offers on any validated page. Accepted (not drafted): the worker covers price from expected.price with spreadsheet-import provenance whenever the item carries it.',
    carriedBy: 'spreadsheet import via expected.price',
  },
  {
    field: 'variants',
    decision: 'conditional',
    selector: null,
    evidence:
      'Every family page is variant-bearing (size select#primaryvariationvalue plus per-size JSON-LD nodes with distinct Sku+Gtin12), but the worker parses no variant matrix on Sitecore pages (matrixDecision null on all 6 samples — none of the five matrix parsers match the <select> or the capitalized-key flat Product nodes), so the gate cannot fail closed here. Family-level items: carried by the draft. Size-specific items: require operator variant selection (or a future Sitecore matrix parser, out of scope) before release — the wrong SKU is never extracted with confidence (see VARIANT_CAVEAT_205).',
    carriedBy: 'operator variant-selection flow for size-specific items; draft v1 for family-level items',
  },
];

/** Activation basis under the authoritative rule (3 confirmations or audited waiver). */
export type NylaboneActivationBasis205 = 'three_confirmations' | 'audited_waiver';

/**
 * Final release-health authority at release time. The eligibility
 * predicate below is necessary but NOT sufficient: the live release path
 * (`releaseDomainExtractionItems`) enforces this gate, and nothing in
 * this record may be wired as a release gate on its own.
 */
export const NYLABONE_205_RELEASE_HEALTH_AUTHORITY =
  'getDomainReleaseHealth (src/onboarding/domain-release.ts) — final authority at release time';

/** Activation-evidence evaluation for the Nylabone single draft. */
export interface NylaboneActivation205 {
  /**
   * True: the confirmation-count evidence satisfies the count basis with
   * no waiver (6 confirmations across 3 templates, minimum was 3 across
   * 2). Evidence only — NOT the authoritative gate: the live system still
   * runs version activation (active version, matching artifact hashes,
   * passing title matrix, imageRuleOk) before anything releases.
   */
  evidenceSatisfied: boolean;
  basis: NylaboneActivationBasis205;
  waiver: false;
  /** The six confirmed sample URLs. */
  confirmations: readonly string[];
  /** Distinct templates spanned by the confirmations (acceptance: 2+). */
  templatesSpanned: readonly string[];
  /**
   * Operator-only steps remaining in the live system (governance:
   * proposals-only promotion, per-field approval, image-preview
   * attestation). Evidence cannot satisfy these — a human must.
   */
  pendingOperatorSteps: readonly string[];
}

export function evaluateActivation205(): NylaboneActivation205 {
  const confirmations = NYLABONE_205_SAMPLES.filter((s) => s.verdict === 'confirmed_clean').map((s) => s.url);
  const templatesSpanned = Array.from(new Set(NYLABONE_205_SAMPLES.filter((s) => s.verdict === 'confirmed_clean').map((s) => s.template)));
  return {
    evidenceSatisfied: confirmations.length >= 3 && templatesSpanned.length >= 2,
    basis: 'three_confirmations',
    waiver: false,
    confirmations,
    templatesSpanned,
    pendingOperatorSteps: [
      'Approve title/description/images selectors per field in the Profile Builder (proposal-only governance; this record is the proposal evidence). Brand and price stay rejected per FIELD_DECISIONS_205 — approving them would fabricate a surface that does not exist.',
      'Attest image-preview review for the gallery sets, deciding the named review items explicitly: UGC photos, cross-product/cross-line images (including the X-Large silo on the Small/Medley groove page), generic story images, and the bacon YouTube video-poster (keep or reject each explicitly). Agent-side preview was impossible in this environment (image reading disabled); the preview URLs are recorded in the plan doc.',
      'Confirm the item-level variant posture before release: family-level items may release under the predicate below; size-specific items require operator variant selection first (VARIANT_CAVEAT_205) — no waiver of this step exists in this record.',
      'Activate the profile version, then selectively release eligible Nylabone items via the selected-retry path: this record proves the necessary conditions only — getDomainReleaseHealth is the final authority at release time (#198).',
    ],
  };
}

/** Source-URL kind driving release eligibility (worker verdict taxonomy). */
export type NylaboneUrlKind205 = 'confirmed_clean' | 'size_specific_pending_selection' | 'unknown';

/** Selective-release eligibility outcome for one Nylabone item. */
export interface NylaboneReleaseEligibility205 {
  eligible: boolean;
  reason: string;
}

/**
 * Selective-release eligibility (#198 hardening + #205 worker verdicts).
 * Eligible only for failed-extraction items in the requesting workspace
 * whose source URL validated clean at family level. Size-specific items
 * wait for operator variant selection; unvalidated URLs never release;
 * nothing auto-runs outside this predicate.
 */
export function selectiveReleaseEligibility205(input: {
  stageStatus: string;
  sameWorkspace: boolean;
  urlKind: NylaboneUrlKind205;
}): NylaboneReleaseEligibility205 {
  if (input.stageStatus !== 'failed_extraction') {
    return { eligible: false, reason: `retry_ineligible_stage: stage is ${input.stageStatus}, not failed_extraction` };
  }
  if (!input.sameWorkspace) {
    return { eligible: false, reason: 'foreign_workspace: item belongs to another workspace' };
  }
  switch (input.urlKind) {
    case 'confirmed_clean':
      return { eligible: true, reason: 'eligible: failed item, own workspace, worker-validated clean URL (family level) — subject to getDomainReleaseHealth at release time' };
    case 'size_specific_pending_selection':
      return { eligible: false, reason: 'variant_resolution_required: size-specific item needs operator variant selection first (VARIANT_CAVEAT_205)' };
    case 'unknown':
    default:
      return { eligible: false, reason: 'unvalidated_url: run worker validation on the item source URL before release' };
  }
}

/** Look up a validation sample by product-page URL. */
export function sample205ByUrl(url: string): NylaboneValidationSample205 | undefined {
  return NYLABONE_205_SAMPLES.find((s) => s.url === url);
}

/**
 * No-assumed-endpoint-fetching seam (acceptance: fields come from the
 * fetched HTML only). The draft must reference no network endpoints.
 */
export function draft205ReferencesNoEndpoints(): boolean {
  return Object.values(NYLABONE_205_SELECTORS).every(
    (sel) => sel === null || (!sel.includes('wp-json') && !sel.includes('http') && !sel.includes('/products?') && !sel.includes('/-/media/')),
  );
}

/**
 * No-unresolvable-structured-selector seam (acceptance: the Sitecore
 * capitalized-key correction is reflected in the mechanism). The worker
 * resolves only lowercase `jsonld:` keys, so the draft must contain no
 * `jsonld:` selector — JSON-LD serves as authoring-time cross-evidence
 * only (Sku/Gtin corroboration) and never as a runtime dependency.
 */
export function draft205UsesNoUnresolvableJsonLd(): boolean {
  return Object.values(NYLABONE_205_SELECTORS).every(
    (sel) => sel === null || !sel.startsWith('jsonld:'),
  );
}
