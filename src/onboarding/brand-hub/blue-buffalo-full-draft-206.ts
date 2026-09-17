// Issue #206 — Blue Buffalo full AI draft (7 items).
//
// A full AI-assisted draft for bluebuffalo.com treated as a coverage
// experiment: generate, then prove the shared-template assumption by
// validating across distinct product-line templates before activation.
// Per-field approve/reject preserved; partial generations still yield
// usable profiles. Visual-select fallback applied per field: the obvious
// visual title pick (`h1`) is REJECTED here because it extracts the same
// generic family name for different recipes (see H1_GENERIC_FINDING_206);
// the title field falls back to the structured `og:title` surface instead.
//
// Inputs (consumed, never re-probed):
// - #201 (`product-page-verdicts-201.ts`): bluebuffalo.com verdict
//   `ai_draft` (Optimizely DXP, zero structured data on both probed lines)
//   with one EXTENSION recorded here: the zero-`ld+json` finding now holds
//   across 6 leaf pages on 4 product lines (not just the 2 probed), and the
//   h1-generic finding below is new (see H1_GENERIC_FINDING_206).
// - #198 (`domain-release.ts` `getDomainReleaseHealth`): the release guard
//   this ticket's selective release runs behind — no auto-requeue before
//   reviewed health; selected retry only for failed-extraction items in
//   the requesting workspace.
//
// Method (2026-09-16, authoring-time live validation; committed tests use
// only the transcribed evidence below — no network, no DB):
// - Started the repo's own extraction worker locally and POSTed candidate
//   draft v1 (runtime `static`, selectors below, `allowedSourceDomains:
//   ['www.bluebuffalo.com', 'bluebuffalo.com']`) for 6 real Blue Buffalo
//   product URLs spanning 4 product lines (life-protection-formula dry,
//   wilderness dry, homestyle-recipe wet, health-bars treats). The worker
//   fetched each page itself with production headers, the variant gate ran
//   in its default mode, and results below are the worker's verbatim
//   verdicts (ok / failureCode / provenance / content hash / matrix
//   decision).
// - The shared-template assumption is PROVEN, not fingerprinted: all four
//   lines share the identical Optimizely DXP hero structure (`.Hero.
//   Hero--product` with `.Hero-image` desktop shot + `picture` mobile shot,
//   `.Hero-text` with generic `h1` + `.Hero-flag .Subtitle` + `.Hero-info
//   h3[itemprop="name"]`, no price surface, no `<select>`, no `ld+json`).
//   Multi-structure dispatch is not needed; the finding is recorded
//   explicitly in TEMPLATE_FINDING_206 (acceptance: templates genuinely
//   sharing one structure are covered by the single draft, and the record
//   says so instead of silently covering one).
//
// This module moves no items, writes no profiles, performs no network I/O,
// and touches no DB rows (dependency-free pure data + pure helpers, like
// the #199 resolutions, #201 verdicts, #202 alignment, #203 routing, #204
// static-profile, and #205 single-draft modules). Activation (per-field
// Builder approval, image-preview attestation, version activation) and
// selective release are operator acts in the live system; this record
// proves they are unblocked and states their exact eligibility rule.

/** Profile domain key (worker fetch host; www-served per #201). */
export const BLUEBUFFALO_206_DOMAIN = 'www.bluebuffalo.com';

/** Blocked Blue Buffalo items this draft unblocks. */
export const BLUEBUFFALO_206_TOTAL_ITEMS = 7;

/** Candidate draft version validated through the worker. */
export const BLUEBUFFALO_206_PROFILE_VERSION = 1;

/** Draft runtime: static fetch only (no rendered browser needed). */
export const BLUEBUFFALO_206_RUNTIME = 'static' as const;

/**
 * LLM cost for this draft (acceptance: cost recorded for observability).
 *
 * Zero: no LLM generation was used. The selectors below were hand-authored
 * from observed DOM structure (authoring-time page reads) and validated
 * through the production worker — there was no generator run, no proposal
 * pass, and no token spend to amortize. Recorded explicitly so the
 * per-domain observability ledger (#197 story 13) can distinguish this
 * zero-cost hand draft from metered AI generations.
 */
export const LLM_COST_206 =
  'zero — no LLM generation used; selectors hand-authored from observed DOM structure ' +
  'and validated through the production worker (6 live extractions, 0 tokens).';

/**
 * Validated selector set v1. Structured-data selectors first
 * (`meta[property="og:title"]`, `meta[property="og:description"]`), one
 * stable CSS selector where the worker-resolvable structured layer has no
 * equivalent (`.Hero--product img` — exactly the 2 hero product shots per
 * page, no carousel noise). `brandSelector` and `priceSelector` are null
 * by design (per-field reject with rationale, see FIELD_DECISIONS_206):
 * no worker-resolvable brand surface exists (no `og:site_name`, no
 * `product:brand` meta, no JSON-LD, and the hidden microdata brand sits
 * outside any Product itemscope so the worker's microdata fallback never
 * fires), and no static price surface exists (zero `$` amounts in static
 * HTML on all 6 pages; purchase flows through the pearcommerce JS widget
 * only). The draft remains usable without them: the worker leaves brand
 * null (non-fatal; brand is supplied by brand assignment) and covers price
 * from `expected.price` with spreadsheet-import provenance whenever the
 * item carries it.
 */
export interface BlueBuffaloDraftSelectors206 {
  titleSelector: string;
  brandSelector: null;
  descriptionSelector: string;
  priceSelector: null;
  imagesSelector: string;
}

export const BLUEBUFFALO_206_SELECTORS: BlueBuffaloDraftSelectors206 = {
  titleSelector: 'meta[property="og:title"]',
  brandSelector: null,
  descriptionSelector: 'meta[property="og:description"]',
  priceSelector: null,
  imagesSelector: '.Hero--product img',
};

/**
 * h1-generic finding (acceptance: visual-select fallback per field — the
 * naive visual pick is proven wrong, and the record says what replaces
 * it).
 *
 * The visually prominent `h1` carries only the generic family name, and it
 * is IDENTICAL for different recipes on the same line (observed verbatim
 * 2026-09-16): "Life Protection Formula ™" on both the chicken and the
 * salmon LPF pages; "BLUE Wilderness ™" on both the chicken and the salmon
 * Wilderness pages. A draft selecting `h1` would extract recipe-indistinct
 * titles — variant/recipe correctness (acceptance) would fail: two
 * different products would validate with the same title. The recipe
 * distinction exists in-DOM (`h3[itemprop="name"]`: "Chicken and Brown
 * Rice Recipe" vs "Salmon and Brown Rice Recipe") and in full in
 * `og:title` — so the title field falls back to
 * `meta[property="og:title"]`, which the worker resolved to the distinct
 * full title on all 6 samples. Visually selecting `h1` alone is therefore
 * explicitly rejected for this domain.
 */
export const H1_GENERIC_FINDING_206 =
  'h1 carries only the generic family name (identical for chicken vs salmon recipes on the same line): ' +
  'title falls back to meta[property="og:title"], which resolves the distinct full title on every sample.';

/** Distinct product-line template validated (URL shape + product line). */
export interface BlueBuffaloTemplate206 {
  /** Short template label used in sample rows. */
  label: string;
  /** Representative product line (sitemap group). */
  line: string;
  /** URL shape: path segments after the host. */
  urlShape: string;
}

/** Templates covered by worker validation (acceptance: 2+ distinct). */
export const BLUEBUFFALO_206_TEMPLATES: readonly BlueBuffaloTemplate206[] = [
  {
    label: 'lpf-dry',
    line: 'dry-dog-food/life-protection-formula',
    urlShape: '/dry-dog-food/life-protection-formula/<slug>/',
  },
  {
    label: 'wilderness-dry',
    line: 'dry-dog-food/wilderness',
    urlShape: '/dry-dog-food/wilderness/<slug>/',
  },
  {
    label: 'wet-homestyle',
    line: 'wet-dog-food/blue-specialty',
    urlShape: '/wet-dog-food/blue-specialty/<slug>/',
  },
  {
    label: 'treats-healthbars',
    line: 'dog-treats/health-bars',
    urlShape: '/dog-treats/health-bars/<slug>/',
  },
];

/**
 * Shared-template finding (acceptance: if templates genuinely differ in
 * structure, the ticket records the finding instead of silently covering
 * one — here they do NOT differ, and the record says exactly that).
 *
 * All four lines share one Optimizely DXP extraction structure:
 * `.Hero.Hero--product` with a `picture` mobile product shot plus a
 * `.Hero-image` desktop product shot; `.Hero-text` with a generic `h1`, a
 * `.Hero-flag .Subtitle` life-stage flag, and `.Hero-info` carrying
 * `h3[itemprop="name"]` (recipe) with no price surface, no `<select>`, no
 * `ld+json` block of any kind, and size availability as plain `<p>` text
 * ("Available in …"). Byte sizes (524–552KB) and image counts are
 * line-consistent. One draft covers all four lines; per-template profiles
 * (multi-structure dispatch, out of scope per #197) are not needed.
 */
export const TEMPLATE_FINDING_206 =
  'Single shared Optimizely DXP hero structure proven across 4 lines (identical hero markup and ' +
  'identical extraction surfaces on all 6 worker-validated pages): one draft covers bluebuffalo.com; ' +
  'no multi-structure dispatch needed.';

/**
 * Variant caveat (acceptance: variant-bearing pages prove correct variant
 * distinction before health — here distinction is scoped, honestly).
 *
 * Every validated dry-food page is size-bearing in prose ("Available in
 * 4.5, 13 & 24-lb. bags."; LPF salmon lists 5/15/24/30/40-lb), but sizes
 * share ONE family URL: there is no `<select>`, no size link matrix, and
 * no JSON-LD for the worker's five matrix parsers to consume
 * (`matrixDecision: null` on all 6 samples). So the gate cannot fail
 * closed the way it does on Bonide — family-level extraction passes
 * without discriminating bag sizes. Consequence: family-level items may
 * release under the predicate below; size-specific items (e.g. a "24-lb
 * bag" SKU item) require operator variant selection first (or a future
 * matrix/parser path, out of scope) before release — the wrong SKU is
 * never extracted with confidence (see selectiveReleaseEligibility206).
 * This caveat travels with every confirmation — it is not a waiver.
 */
export const VARIANT_CAVEAT_206 =
  'Worker parses no variant matrix on Optimizely DXP pages (matrixDecision null on all 6 samples): ' +
  'sizes share one family URL as plain prose, so family-level extraction cannot discriminate bag sizes — ' +
  'size-specific items require operator variant selection first; no silent confident wrong-SKU extraction.';

/** Worker verdict for one validation sample URL. */
export type BlueBuffaloSampleVerdict206 = 'confirmed_clean';

/** One worker-validation sample (transcribed 2026-09-16; fidelity-tested). */
export interface BlueBuffaloValidationSample206 {
  /** Leaf product-page URL fetched by the worker. */
  url: string;
  /** Template label from BLUEBUFFALO_206_TEMPLATES. */
  template: string;
  /** Worker verdict for draft v1. All six validate clean. */
  verdict: BlueBuffaloSampleVerdict206;
  /** Worker `ok` flag. */
  ok: boolean;
  /** Worker failure code (null on every sample). */
  failureCode: string | null;
  /** Worker variant-matrix decision (null on every sample — see VARIANT_CAVEAT_206). */
  matrixDecision: null;
  /** Extracted distinct full title via `og:title`. */
  title: string;
  /** Brand as returned by the worker (null on every sample — no resolvable surface). */
  brand: string | null;
  /** Length of the worker-extracted `og:description` text. */
  descriptionLength: number;
  /** Primary hero image URL (mobile product shot). */
  primaryImage: string;
  /** Count of additional hero images (desktop product shot). */
  additionalImageCount: number;
  /** Field provenance as reported by the worker. */
  provenance: Record<string, string>;
  /** Source content hash (full 64-hex as observed). */
  contentHash: string;
  /** Why this row counts toward activation. */
  rationale: string;
}

export const BLUEBUFFALO_206_SAMPLES: readonly BlueBuffaloValidationSample206[] = [
  {
    url: 'https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/chicken-brown-rice-recipe/',
    template: 'lpf-dry',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'Life Protection Formula Adult Dry Dog Food - Chicken & Brown Rice',
    brand: null,
    descriptionLength: 260,
    primaryImage:
      'https://www.bluebuffalo.com/globalassets/product-detail-pages/dog-dry-food/life-protection-formula/mobile-product-image/lpf_dog_dry_adult_chickenbrownrice_mobile.png',
    additionalImageCount: 1,
    provenance: {
      title: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: 'b8e3555662acba2bca82125dd43937575f3c4b0e3d4631f1e548145a5a6e6111',
    rationale:
      'Full pass through the production worker on template lpf-dry: distinct full title via og:title (h1 reads only the generic "Life Protection Formula" — see H1_GENERIC_FINDING_206), 260-char description via og:description, mobile plus desktop hero product shots via .Hero--product img with no carousel noise. Counts as confirmation 1 of 3+ (family level; size-specific items still owe operator variant selection per VARIANT_CAVEAT_206).',
  },
  {
    url: 'https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/salmon-brown-rice-recipe/',
    template: 'lpf-dry',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'BLUE Life Protection Formula Adult Dog Food Salmon & Brown Rice',
    brand: null,
    descriptionLength: 151,
    primaryImage:
      'https://www.bluebuffalo.com/globalassets/product-detail-pages/dog-dry-food/life-protection-formula/mobile-product-image/pdp_mobile_lpf_dry_dog_salmon.jpg',
    additionalImageCount: 1,
    provenance: {
      title: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: 'e63759d5a1345f26e5e6e78ea7307f537b4fdfc82da672dfd4575fc78b7f1429',
    rationale:
      'Full pass on the second lpf-dry page: the worker resolves a DIFFERENT title ("… Salmon & Brown Rice") where h1 reads identically to the chicken page — the og:title fallback proves recipe distinction (acceptance: variant correctness). Distinct content hash — two different products, same structure. Counts as confirmation 2 of 3+ (family level; variant caveat applies).',
  },
  {
    url: 'https://www.bluebuffalo.com/dry-dog-food/wilderness/adult-chicken-grain-free-recipe/',
    template: 'wilderness-dry',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'BLUE Wilderness™ Adult Dog Grain-Free Chicken Recipe',
    brand: null,
    descriptionLength: 182,
    primaryImage:
      'https://www.bluebuffalo.com/globalassets/product-detail-pages/dog-dry-food/wilderness/mobile-product-image/wild_gf_adult_chicken_mobile.jpg',
    additionalImageCount: 1,
    provenance: {
      title: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '1c2d11d6f42300122a7764be73f3a979f07815024c3d7491a221d8c1946b7821',
    rationale:
      'Full pass on the SECOND template (wilderness-dry): the identical selector set extracts the distinct Wilderness title, 182-char description, and mobile plus desktop hero shots with no template-specific adjustment. The shared-template assumption holds past LPF. Counts as confirmation 3 of 3+ — the three-confirmation count basis is satisfied on evidence with no waiver.',
  },
  {
    url: 'https://www.bluebuffalo.com/dry-dog-food/wilderness/adult-salmon-grain-free-recipe/',
    template: 'wilderness-dry',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'BLUE Wilderness™ Adult Dog Grain-Free Salmon Recipe',
    brand: null,
    descriptionLength: 171,
    primaryImage:
      'https://www.bluebuffalo.com/globalassets/product-detail-pages/dog-dry-food/wilderness/mobile-product-image/wild_gf_adult_salmon_mobile.jpg',
    additionalImageCount: 1,
    provenance: {
      title: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '2d151b68d04be5891e8ece8e1f0bb6ba98fbd477a116369aec8f4aee22ccacb8',
    rationale:
      'Full pass on the second wilderness-dry page: chicken vs salmon resolve to distinct titles ("… Chicken Recipe" vs "… Salmon Recipe") under one selector set — recipe correctness proven twice on this line. Confirmation 4 (family level; variant caveat applies).',
  },
  {
    url: 'https://www.bluebuffalo.com/wet-dog-food/blue-specialty/senior-homestyle-recipe-beef-dinner/',
    template: 'wet-homestyle',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'BLUE Homestyle Recipe Senior Dog Food Beef & Vegetable Dinner',
    brand: null,
    descriptionLength: 191,
    primaryImage:
      'https://www.bluebuffalo.com/globalassets/product-detail-pages/dog-wet-food/blue/mobile-product-image/pdp_mobile_homestylerecipe_wet_dog_snrbeef.jpg',
    additionalImageCount: 1,
    provenance: {
      title: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: '4ec1a00305a14ead7f26cddc3139d604eab577f5447a15ee11d516b4bc3fe356',
    rationale:
      'Full pass on the THIRD template (wet-homestyle, wet-food line with its own asset tree): distinct senior-beef title, 191-char description, mobile plus desktop hero shots. Three distinct templates pass with one selector set — coverage is proven, not assumed. Confirmation 5.',
  },
  {
    url: 'https://www.bluebuffalo.com/dog-treats/health-bars/soft-and-chewy-chicken-and-apple/',
    template: 'treats-healthbars',
    verdict: 'confirmed_clean',
    ok: true,
    failureCode: null,
    matrixDecision: null,
    title: 'BLUE Soft & Chewy Health Bars',
    brand: null,
    descriptionLength: 132,
    primaryImage:
      'https://www.bluebuffalo.com/globalassets/product-detail-pages/dog-treats/health-bars/mobile-product-image/pdp_mobile_softchewy_healthbars_chickenapple.png',
    additionalImageCount: 1,
    provenance: {
      title: 'meta',
      description: 'meta',
      primaryImage: 'profile-selector',
      additionalImages: 'profile-selector',
    },
    contentHash: 'fd95d939ad85a473321f4802553ee6c1615343cef338704577e469122a2fd09a',
    rationale:
      'Full pass on the FOURTH template (treats-healthbars): distinct treats title, 132-char description, mobile plus desktop hero shots. Four lines, one selector set, six confirmations — the coverage experiment concludes: the single-draft assumption is proven. Confirmation 6.',
  },
];

/** Per-field approve/reject decision for the AI draft (acceptance: preserved; partial generations usable). */
export type BlueBuffaloFieldDecision206 = 'approve' | 'reject' | 'conditional';

/**
 * Per-field approve/reject table. Approved fields form the committable
 * draft v1; rejected fields carry an explicit rationale and a non-draft
 * owner (brand assignment, spreadsheet import, operator flow) so the
 * partial generation is still a usable profile — exactly the
 * partial-generation acceptance requirement.
 */
export interface BlueBuffaloFieldRow206 {
  field: 'title' | 'brand' | 'description' | 'images' | 'price' | 'variants';
  decision: BlueBuffaloFieldDecision206;
  /** Draft selector committed for this field (null when rejected). */
  selector: string | null;
  /** Worker-observed evidence behind the decision. */
  evidence: string;
  /** Non-draft owner carrying the field when the draft does not. */
  carriedBy: string;
}

export const FIELD_DECISIONS_206: readonly BlueBuffaloFieldRow206[] = [
  {
    field: 'title',
    decision: 'approve',
    selector: 'meta[property="og:title"]',
    evidence:
      'Worker extracted the distinct full product title via og:title on all 6 samples across 4 lines (LPF chicken vs salmon and Wilderness chicken vs salmon each resolve distinctly). Provenance meta throughout. Explicit visual-select fallback: the prominent h1 was rejected — it reads identically for different recipes on the same line (see H1_GENERIC_FINDING_206) — and the in-DOM h3[itemprop="name"] recipe distinction corroborates the fallback at authoring time.',
    carriedBy: 'draft v1 (this record)',
  },
  {
    field: 'description',
    decision: 'approve',
    selector: 'meta[property="og:description"]',
    evidence:
      'Worker extracted 132–260-char merchandising descriptions via og:description on all 6 samples. Provenance meta throughout. (Richer .Hero-info prose exists per page but varies by line; the stable structured surface suffices and matches the #204/#205 precedent.)',
    carriedBy: 'draft v1 (this record)',
  },
  {
    field: 'images',
    decision: 'approve',
    selector: '.Hero--product img',
    evidence:
      'Worker extracted exactly the 2 hero product shots per sample (mobile + desktop bag/can shots) via the product hero on all 6 samples — no ingredient-carousel or cross-product noise (the selector scopes to the product hero, unlike broader img queries that would sweep 200+ page images). Provenance profile-selector throughout. No UGC or cross-product impurities were observed in the hero sets; keep/reject per page set remains a reviewer decision at preview attestation — see the operator runbook in the plan doc.',
    carriedBy: 'draft v1 (this record), subject to image-preview attestation',
  },
  {
    field: 'brand',
    decision: 'reject',
    selector: null,
    evidence:
      'No worker-resolvable brand surface exists: no og:site_name, no product:brand meta, no JSON-LD of any kind (zero ld+json blocks on all 6 pages), and the hidden microdata brand sits outside any Product itemscope so the worker microdata fallback never fires (worker brand null observed verbatim on all 6 samples). A draft could not do better — there is no brand surface to select.',
    carriedBy: 'brand assignment (not extraction)',
  },
  {
    field: 'price',
    decision: 'reject',
    selector: null,
    evidence:
      'No static price surface exists: zero dollar amounts in static HTML on all 6 pages; purchase flows through the pearcommerce JS retailer widget only. Accepted (not drafted): the worker covers price from expected.price with spreadsheet-import provenance whenever the item carries it.',
    carriedBy: 'spreadsheet import via expected.price',
  },
  {
    field: 'variants',
    decision: 'conditional',
    selector: null,
    evidence:
      'Every dry-food page is size-bearing in prose ("Available in 4.5, 13 & 24-lb. bags."; LPF salmon lists 5/15/24/30/40-lb) with sizes sharing one family URL — but there is no <select>, no size link matrix, and no JSON-LD on any page, so the worker parses no variant matrix (matrixDecision null on all 6 samples) and the gate cannot fail closed here. Family-level items: carried by the draft. Size-specific items: require operator variant selection (or a future matrix/parser path, out of scope) before release — the wrong SKU is never extracted with confidence (see VARIANT_CAVEAT_206).',
    carriedBy: 'operator variant-selection flow for size-specific items; draft v1 for family-level items',
  },
];

/** Activation basis under the authoritative rule (3 confirmations or audited waiver). */
export type BlueBuffaloActivationBasis206 = 'three_confirmations' | 'audited_waiver';

/**
 * Final release-health authority at release time. The eligibility
 * predicate below is necessary but NOT sufficient: the live release path
 * (`releaseDomainExtractionItems`) enforces this gate, and nothing in
 * this record may be wired as a release gate on its own.
 */
export const BLUEBUFFALO_206_RELEASE_HEALTH_AUTHORITY =
  'getDomainReleaseHealth (src/onboarding/domain-release.ts) — final authority at release time';

/** Activation-evidence evaluation for the Blue Buffalo full draft. */
export interface BlueBuffaloActivation206 {
  /**
   * True: the confirmation-count evidence satisfies the count basis with
   * no waiver (6 confirmations across 4 templates, minimum was 3 across
   * 2). Evidence only — NOT the authoritative gate: the live system still
   * runs version activation (active version, matching artifact hashes,
   * passing title matrix, imageRuleOk) before anything releases.
   */
  evidenceSatisfied: boolean;
  basis: BlueBuffaloActivationBasis206;
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

export function evaluateActivation206(): BlueBuffaloActivation206 {
  const clean = BLUEBUFFALO_206_SAMPLES.filter((s) => s.verdict === 'confirmed_clean');
  const confirmations = clean.map((s) => s.url);
  const templatesSpanned = Array.from(new Set(clean.map((s) => s.template)));
  return {
    evidenceSatisfied: confirmations.length >= 3 && templatesSpanned.length >= 2,
    basis: 'three_confirmations',
    waiver: false,
    confirmations,
    templatesSpanned,
    pendingOperatorSteps: [
      'Approve title/description/images selectors per field in the Profile Builder (proposal-only governance; this record is the proposal evidence). Brand and price stay rejected per FIELD_DECISIONS_206 — approving them would fabricate a surface that does not exist. Title approval must confirm the og:title fallback (not h1) per H1_GENERIC_FINDING_206.',
      'Attest image-preview review for the hero image sets (mobile + desktop shots per page), deciding each page set explicitly. Agent-side preview was impossible in this environment (image reading disabled); the preview URLs are the primaryImage values in the sample rows and the plan doc.',
      'Confirm the item-level variant posture before release: family-level items may release under the predicate below; size-specific items require operator variant selection first (VARIANT_CAVEAT_206) — no waiver of this step exists in this record.',
      'Activate the profile version, then selectively release eligible Blue Buffalo items via the selected-retry path: this record proves the necessary conditions only — getDomainReleaseHealth is the final authority at release time (#198).',
    ],
  };
}

/** Source-URL kind driving release eligibility (worker verdict taxonomy). */
export type BlueBuffaloUrlKind206 = 'confirmed_clean' | 'size_specific_pending_selection' | 'unknown';

/** Selective-release eligibility outcome for one Blue Buffalo item. */
export interface BlueBuffaloReleaseEligibility206 {
  eligible: boolean;
  reason: string;
}

/**
 * Selective-release eligibility (#198 hardening + #206 worker verdicts).
 * Eligible only for failed-extraction items in the requesting workspace
 * whose source URL validated clean at family level. Size-specific items
 * wait for operator variant selection; unvalidated URLs never release;
 * nothing auto-runs outside this predicate.
 */
export function selectiveReleaseEligibility206(input: {
  stageStatus: string;
  sameWorkspace: boolean;
  urlKind: BlueBuffaloUrlKind206;
}): BlueBuffaloReleaseEligibility206 {
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
      return { eligible: false, reason: 'variant_resolution_required: size-specific item needs operator variant selection first (VARIANT_CAVEAT_206)' };
    case 'unknown':
    default:
      return { eligible: false, reason: 'unvalidated_url: run worker validation on the item source URL before release' };
  }
}

/** Look up a validation sample by product-page URL. */
export function sample206ByUrl(url: string): BlueBuffaloValidationSample206 | undefined {
  return BLUEBUFFALO_206_SAMPLES.find((s) => s.url === url);
}

/**
 * No-assumed-endpoint-fetching seam (acceptance: fields come from the
 * fetched HTML only). The draft must reference no network endpoints.
 */
export function draft206ReferencesNoEndpoints(): boolean {
  return Object.values(BLUEBUFFALO_206_SELECTORS).every(
    (sel) => sel === null || (!sel.includes('wp-json') && !sel.includes('http') && !sel.includes('/products?') && !sel.includes('/globalassets/')),
  );
}

/**
 * No-unresolvable-structured-selector seam (acceptance: the zero-ld+json
 * reality is reflected in the mechanism). Blue Buffalo serves zero
 * `ld+json` blocks on every validated page, so the draft must contain no
 * `jsonld:` selector — fields come from meta + hero CSS only.
 */
export function draft206UsesNoUnresolvableJsonLd(): boolean {
  return Object.values(BLUEBUFFALO_206_SELECTORS).every(
    (sel) => sel === null || !sel.startsWith('jsonld:'),
  );
}
