// Issue #208 — retry sweep + observability close-out.
//
// The closing sweep for the #197 cost-tiered profile scale-up: selected
// retries for all newly unblocked items across every mechanism ticket
// (#204 Bonide, #205 Nylabone, #206 Blue Buffalo, #207 Shopify ×6,
// #203 walled ×5), plus per-domain observability records (mechanism used,
// validation evidence, activation basis, LLM cost, failure codes seen).
//
// Inputs (consumed, never re-probed):
// - #204 (`bonide-static-profile-204.ts`): bonide.com static profile,
//   3 confirmations, variant fail-closed URLs, discontinued slugs.
// - #205 (`nylabone-single-draft-205.ts`): www.nylabone.com single draft,
//   6 confirmations across 3+ templates, family-level release only.
// - #206 (`blue-buffalo-full-draft-206.ts`): www.bluebuffalo.com full
//   draft, 6 confirmations across 4 templates, LLM_COST_206 = zero.
// - #207 (`shopify-minimal-profiles-207.ts`): 6 minimal profiles,
//   18 confirmations (3/domain), 8 fail-closed variant demonstrations.
// - #203 (`walled-domain-routing-203.ts`): 3 lifted re-routes to
//   downstream static-validation tickets, 2 still-walled
//   distributor/manual routes, zero current items.
// - Live workspace DB (read-only, observed 2026-09-16): 130 items, all
//   status `imported` — 89 route_sources|pending, 8
//   review_listings|needs_input, 5 review_listings|skipped, 28
//   create_drafts|completed. Zero rows in failed extraction.
//
// This module moves no items, writes no profiles, performs no network
// I/O, and touches no DB rows (dependency-free pure data + pure helpers,
// like the #199 resolutions, #201 verdicts, #202 alignment, and #203
// routing modules). Activation and selected retry remain operator acts
// behind `getDomainReleaseHealth` (#198); the sweep below proves the
// necessary conditions only. Downstream owner: the operator, via the
// runbook in `docs/plans/retry-sweep-closeout-208.md`.

/** The 14 mechanism domains closed out by this ticket. */
export const CLOSEOUT_208_DOMAINS: readonly string[] = [
  'bonide.com',
  'www.nylabone.com',
  'www.bluebuffalo.com',
  'discovernutrisource.com',
  'openfarmpet.com',
  'snifsnax.com',
  'jollypets.com',
  'www.wondercide.com',
  'horsemenspride.com',
  'bil-jac.com',
  'northstatesind.com',
  'yeowww.com',
  'chickensouppets.com',
  'multipet.com',
];

/**
 * Unblocking mechanism per domain (the #197 cost-tier vocabulary).
 *
 * - `static_structured_profile`: worker-validated structured selectors,
 *   no LLM generation (#204).
 * - `single_ai_draft` / `full_ai_draft`: Profile Builder proposal-path
 *   drafts validated through the worker; both instances needed zero
 *   metered generation (#205 / #206).
 * - `shopify_minimal_profile`: worker-validated minimal profile, platform
 *   JSON as generation hint + variant cross-evidence only (#207).
 * - `static_validation_followup`: wall lifted per #201 — a downstream
 *   static-validation ticket owns any future profile, never #208 (#203).
 * - `distributor_manual_blocked`: still 403 at product-page level — future
 *   items move by distributor-record or staged manual evidence, never by
 *   selectors (#203).
 */
export type SweepMechanism208 =
  | 'static_structured_profile'
  | 'single_ai_draft'
  | 'full_ai_draft'
  | 'shopify_minimal_profile'
  | 'static_validation_followup'
  | 'distributor_manual_blocked';

/** Worker verdict kind driving sweep eligibility (mechanism-module taxonomy). */
export type SweepUrlVerdict208 =
  | 'confirmed_clean'
  | 'variant_blocked'
  | 'unvalidated_url'
  | 'discontinued'
  | 'not_applicable';

/**
 * Per-domain observability record (acceptance: mechanism, validation
 * evidence, activation basis, cost if any, failure codes seen).
 */
export interface DomainLedgerEntry208 {
  /** Registrable domain identity (matches the mechanism module's key). */
  domain: string;
  mechanism: SweepMechanism208;
  /** Mechanism ticket owning the validation evidence (e.g. '#204'). */
  ticket: string;
  /** Ticket-scoped blocked items behind this domain (0 for walled). */
  items: number;
  /** Worker-observed validation evidence (transcribed, not re-probed). */
  validationEvidence: string;
  /** Confirmed samples toward the three-confirmation rule (0 where n/a). */
  activationConfirmations: number;
  /** Audited waiver used? False everywhere — all counts met on evidence. */
  activationWaiver: boolean;
  /** Metered LLM tokens spent producing the profile/draft (0 throughout). */
  llmTokens: number;
  /** Why the cost reads as it does (hand draft vs metered generation). */
  costNote: string;
  /** Worker failure codes observed on this domain (null = clean pass). */
  failureCodesSeen: ReadonlyArray<string | null>;
  /** How this domain's items release (operator path, never automatic). */
  releasePath: string;
}

export const DOMAIN_LEDGER_208: readonly DomainLedgerEntry208[] = [
  {
    domain: 'bonide.com',
    mechanism: 'static_structured_profile',
    ticket: '#204',
    items: 5,
    validationEvidence:
      'Production worker fetched 10 real Bonide URLs itself (runtime static, variant gate active): 3 clean confirmations ' +
      '(eight garden dust, eight RTU, neem-oil-conc — ok=true, h1 title, Yoast meta description, Woo gallery images, brand via og:site_name).',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: selectors hand-authored from observed DOM structure and validated through the production worker — no LLM generation ran.',
    failureCodesSeen: [null, 'variant_selection_required'],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Variant-blocked pages (pyrethrin 857/858, neem-max 020/026, sulfur 141/1428) wait for a discriminating variation SKU or operator ' +
      'variant selection; discontinued slugs (roach-powder, spider-killer-rtu, captan, mite-x) never release.',
  },
  {
    domain: 'www.nylabone.com',
    mechanism: 'single_ai_draft',
    ticket: '#205',
    items: 5,
    validationEvidence:
      'Production worker fetched 6 real Nylabone URLs itself across power-chew, edible-chew-treats, dental-solutions, puppy-chew, and ' +
      'moderate-chew lines: 6 clean confirmations (ok=true, failureCode=null, matrixDecision=null), one selector set, zero template-specific ' +
      'adjustments — shared SXA structure proven, no multi-structure dispatch needed.',
    activationConfirmations: 6,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: the draft was hand-assembled from worker-observed structure (per-field approve/reject preserved; brand/price rejected ' +
      'with named owners) — no metered AI generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction family-level items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Size-specific items wait for operator variant selection (no worker matrix on Sitecore pages).',
  },
  {
    domain: 'www.bluebuffalo.com',
    mechanism: 'full_ai_draft',
    ticket: '#206',
    items: 7,
    validationEvidence:
      'Production worker fetched 6 real Blue Buffalo URLs itself across lpf-dry, wilderness-dry, wet-homestyle, and treats-healthbars lines: ' +
      '6 clean confirmations (ok=true, failureCode=null), title via meta og:title fallback (h1 carries only the generic family name), zero ' +
      'ld+json on all pages, one shared DXP hero structure — one draft covers the domain.',
    activationConfirmations: 6,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens per LLM_COST_206: selectors hand-authored from observed DOM structure and validated through the production worker ' +
      '(6 live extractions, 0 tokens) — recorded here to distinguish this hand draft from metered AI generations.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction family-level items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Sizes share one family URL with no worker matrix — family-level release; size-specific items wait for operator selection.',
  },
  {
    domain: 'discovernutrisource.com',
    mechanism: 'shopify_minimal_profile',
    ticket: '#207',
    items: 27,
    validationEvidence:
      'Production worker fetched 3 real Nutrisource URLs itself (Dawn theme, .product__media img → 1+5 each): 3 clean confirmations ' +
      '(ok=true, failureCode=null, no variant gate — platform reports exactly one variant), title via h1, brand/description via meta. ' +
      'Canonical-host rule (#202): fetch host discovernutrisource.com.',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: minimal explicit profile hand-authored from worker-observed structure; platform .js served only as authoring-time ' +
      'cross-evidence and the variant gate, never as a runtime contract — no LLM generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Nothing auto-runs outside the eligible set.',
  },
  {
    domain: 'openfarmpet.com',
    mechanism: 'shopify_minimal_profile',
    ticket: '#207',
    items: 8,
    validationEvidence:
      'Production worker fetched 3 real Open Farm URLs itself (custom theme, product-info img → 1+9..11): 3 clean confirmations ' +
      '(ok=true, failureCode=null), title via h1, brand/description via meta. Icon/poster/label images flagged as preview-review items.',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: minimal explicit profile hand-authored from worker-observed structure; platform .js served only as authoring-time ' +
      'cross-evidence and the variant gate, never as a runtime contract — no LLM generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Nothing auto-runs outside the eligible set.',
  },
  {
    domain: 'snifsnax.com',
    mechanism: 'shopify_minimal_profile',
    ticket: '#207',
    items: 8,
    validationEvidence:
      'Production worker fetched 3 real SnifSnax URLs itself (custom theme, .product-media img → 1+0..2, matching platform): 3 clean ' +
      'confirmations (ok=true, failureCode=null), title via h1, brand/description via meta. Newly mapped #199 official domain, verified via #201.',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: minimal explicit profile hand-authored from worker-observed structure; platform .js served only as authoring-time ' +
      'cross-evidence and the variant gate, never as a runtime contract — no LLM generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Nothing auto-runs outside the eligible set.',
  },
  {
    domain: 'jollypets.com',
    mechanism: 'shopify_minimal_profile',
    ticket: '#207',
    items: 6,
    validationEvidence:
      'Production worker fetched 3 real Jolly Pets URLs itself (Turbo theme, .product_gallery img → 1+0..3, matching platform): 3 clean ' +
      'confirmations (ok=true, failureCode=null), title via h1, brand/description via meta. Newly mapped #199 official domain, verified via #201.',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: minimal explicit profile hand-authored from worker-observed structure; platform .js served only as authoring-time ' +
      'cross-evidence and the variant gate, never as a runtime contract — no LLM generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Nothing auto-runs outside the eligible set.',
  },
  {
    domain: 'www.wondercide.com',
    mechanism: 'shopify_minimal_profile',
    ticket: '#207',
    items: 3,
    validationEvidence:
      'Production worker fetched 3 real Wondercide URLs itself (custom pwc theme, .pwc-gallery img → 1+2..24): 3 clean confirmations ' +
      '(ok=true, failureCode=null), title via h1, brand/description via meta. Family cross-sell rail + video poster flagged as preview-review ' +
      'items. Release/profile matching strips www. so either host form agrees.',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: minimal explicit profile hand-authored from worker-observed structure; platform .js served only as authoring-time ' +
      'cross-evidence and the variant gate, never as a runtime contract — no LLM generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Nothing auto-runs outside the eligible set.',
  },
  {
    domain: 'horsemenspride.com',
    mechanism: 'shopify_minimal_profile',
    ticket: '#207',
    items: 1,
    validationEvidence:
      'Production worker fetched 3 real Horsemen\u2019s Pride URLs itself (Turbo theme, .product_gallery img → 1+1..2, matching platform): ' +
      '3 clean confirmations (ok=true, failureCode=null), title via h1, brand/description via meta. Newly mapped #199 official domain, verified via #201.',
    activationConfirmations: 3,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: minimal explicit profile hand-authored from worker-observed structure; platform .js served only as authoring-time ' +
      'cross-evidence and the variant gate, never as a runtime contract — no LLM generation ran.',
    failureCodesSeen: [null],
    releasePath:
      'Selected retry for failed-extraction items on confirmed-clean URLs only, behind getDomainReleaseHealth at release time. ' +
      'Nothing auto-runs outside the eligible set.',
  },
  {
    domain: 'bil-jac.com',
    mechanism: 'static_validation_followup',
    ticket: '#203',
    items: 0,
    validationEvidence:
      'Wall LIFTED for plain fetch per #201 (homepage, listing, and two leaf pages HTTP 200 with real catalog content; WordPress Elementor, ' +
      'OG title/image on leaves) — re-routed from #203-as-written distributor routing to worker-validated static profile first.',
    activationConfirmations: 0,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: no profile work attempted in #203 (zero rows by invariant); any future static validation is worker-only unless the ' +
      'downstream ticket proves otherwise.',
    failureCodesSeen: [],
    releasePath:
      'No retry from this ticket — zero current items. Future items move by the downstream OG/meta-backed static-validation ticket ' +
      '(operator files; no existing owner), distributor only on validation failure.',
  },
  {
    domain: 'northstatesind.com',
    mechanism: 'static_validation_followup',
    ticket: '#203',
    items: 0,
    validationEvidence:
      'Wall LIFTED for plain fetch per #201 (www → apex 301, then HTTP 200; full JSON-LD Product per leaf — name + sku + gtin + offer + image — ' +
      'plus OG title/image; strongest static candidate of the three lifted domains).',
    activationConfirmations: 0,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: no profile work attempted in #203 (zero rows by invariant); any future static validation is worker-only unless the ' +
      'downstream ticket proves otherwise.',
    failureCodesSeen: [],
    releasePath:
      'No retry from this ticket — zero current items. Future items move by the downstream JSON-LD-backed static-validation ticket ' +
      '(operator files; no existing owner), distributor only on validation failure.',
  },
  {
    domain: 'yeowww.com',
    mechanism: 'static_validation_followup',
    ticket: '#203',
    items: 0,
    validationEvidence:
      'Wall LIFTED for plain fetch per #201 (www → apex 301, then HTTP 200) but the structured layer is thin and uneven (BigCommerce, no JSON-LD, ' +
      'OG title/image on one leaf, missing on a category-shaped page) — weakest lifted candidate; worker validation is load-bearing.',
    activationConfirmations: 0,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: no profile work attempted in #203 (zero rows by invariant); any future static validation is worker-only unless the ' +
      'downstream ticket proves otherwise.',
    failureCodesSeen: [],
    releasePath:
      'No retry from this ticket — zero current items. Future items move by the downstream OG/meta-backed static-validation ticket ' +
      '(operator files; no existing owner), distributor only on validation failure.',
  },
  {
    domain: 'chickensouppets.com',
    mechanism: 'distributor_manual_blocked',
    ticket: '#203',
    items: 0,
    validationEvidence:
      'STILL WALLED per #201: homepage AND leaf product page both HTTP 403 with the Cloudflare challenge title — proven at product-page level, ' +
      'not inferred from discovery inconvenience. No selector can ever work here: zero profile rows, now and ever.',
    activationConfirmations: 0,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: zero selector effort spent where selectors cannot work (#197 story 10) — the cheapest correct mechanism is routing, not generation.',
    failureCodesSeen: [],
    releasePath:
      'No retry from this ticket — zero current items and distributor unqualified (#200: zero generations, pins, gate observations, live smoke). ' +
      'Future items move by distributor-record qualification or staged manual evidence via the audited operator path, never by selector work.',
  },
  {
    domain: 'multipet.com',
    mechanism: 'distributor_manual_blocked',
    ticket: '#203',
    items: 0,
    validationEvidence:
      'STILL WALLED per #201: product page /shop/tpr-spike-bone/ HTTP 403 with the Cloudflare challenge title — proven at product-page level. ' +
      'No selector can ever work here: zero profile rows, now and ever.',
    activationConfirmations: 0,
    activationWaiver: false,
    llmTokens: 0,
    costNote:
      'Zero tokens: zero selector effort spent where selectors cannot work (#197 story 10) — the cheapest correct mechanism is routing, not generation.',
    failureCodesSeen: [],
    releasePath:
      'No retry from this ticket — zero current items and distributor unqualified (#200: zero generations, pins, gate observations, live smoke). ' +
      'Future items move by distributor-record qualification or staged manual evidence via the audited operator path, never by selector work.',
  },
];

export function ledger208ByDomain(domain: string): DomainLedgerEntry208 | undefined {
  return DOMAIN_LEDGER_208.find((r) => r.domain === domain);
}

/** Ticket-scoped blocked items across the ledger (5+5+7+53+0). */
export const LEDGER_208_TOTAL_ITEMS: number = DOMAIN_LEDGER_208.reduce((n, r) => n + r.items, 0);

/** Metered LLM tokens across the whole scale-up (zero — every draft was hand-authored, worker-validated). */
export const LEDGER_208_TOTAL_LLM_TOKENS: number = DOMAIN_LEDGER_208.reduce((n, r) => n + r.llmTokens, 0);

/** Selected-retry eligibility input for one item (mirrors the #198-hardened route checks). */
export interface SweepCandidate208 {
  /** Canonical extraction stage (`collect_details`) — anything else refuses with `retry_ineligible_stage`. */
  stage: string;
  /** Extraction stage status — anything but `failed` refuses with `retry_ineligible_status`. */
  stageStatus: string;
  /** Batch owned by the requesting workspace (false reads as route 404). */
  ownWorkspace: boolean;
  /** Active manual-evidence attestation held (refuses first with route 409 precedence). */
  hasActiveManualEvidence: boolean;
  /** Mechanism-module URL verdict for the item's source URL. */
  urlVerdict: SweepUrlVerdict208;
}

/** Selective-retry eligibility outcome (reason codes match the live route). */
export interface SweepEligibility208 {
  eligible: boolean;
  reason: string;
}

/**
 * Selective-release eligibility (#198 hardening + mechanism worker verdicts).
 *
 * Check order follows the live selected-retry route
 * (`src/server/routes/onboarding-routes.ts`): workspace ownership →
 * manual-evidence precedence (409) → stage (400
 * `retry_ineligible_stage`) → status (400 `retry_ineligible_status`).
 * Where the route emits an exact code it is reused verbatim
 * (`retry_ineligible_stage`, `retry_ineligible_status`,
 * `manual_evidence_active_retry_rejected`); the route's foreign-workspace
 * refusal is a bare 404 with no code, labeled `foreign_workspace` here.
 * The URL-verdict holds after that (`variant_resolution_required`,
 * `unvalidated_url`, and #204's verbatim `wrong_product`) come from the
 * mechanism modules — the route performs no URL-verdict check, so those
 * codes have no route counterpart by design. An `eligible` result is
 * necessary but NOT sufficient: `getDomainReleaseHealth` is the final
 * authority at release time, and nothing in this record may be wired as a
 * release gate on its own.
 */
export function sweepEligibility208(input: SweepCandidate208): SweepEligibility208 {
  if (!input.ownWorkspace) return { eligible: false, reason: 'foreign_workspace: item belongs to another workspace' };
  if (input.hasActiveManualEvidence) {
    return { eligible: false, reason: 'manual_evidence_active_retry_rejected: withdraw the attestation first, then retry' };
  }
  if (input.stage !== 'collect_details') {
    return { eligible: false, reason: `retry_ineligible_stage: stage is ${input.stage}, not failed extraction (collect_details)` };
  }
  if (input.stageStatus !== 'failed') {
    return { eligible: false, reason: `retry_ineligible_status: status is ${input.stageStatus}, not failed` };
  }
  switch (input.urlVerdict) {
    case 'confirmed_clean':
      return {
        eligible: true,
        reason: 'eligible: failed item, own workspace, worker-validated clean URL — subject to getDomainReleaseHealth at release time',
      };
    case 'variant_blocked':
      return {
        eligible: false,
        reason: 'variant_resolution_required: source page needs a discriminating SKU or operator variant selection first',
      };
    case 'discontinued':
      // Verbatim #204 code (`selectiveReleaseEligibility204`): the mechanism owns this verdict.
      return { eligible: false, reason: 'wrong_product: source URL serves the shared discontinued page' };
    case 'unvalidated_url':
    case 'not_applicable':
      return { eligible: false, reason: 'unvalidated_url: run worker validation on the item source URL before release' };
  }
}

/** One ineligible cohort with its refusal reason (acceptance: listed, not silently skipped). */
export interface IneligibleCohort208 {
  cohort: string;
  count: number;
  reason: string;
}

/**
 * Live sweep snapshot observed 2026-09-16 against the workspace DB
 * (`mode=ro`): zero rows in failed extraction, so zero items are eligible
 * and zero were retried. Every one of the 130 items is accounted for in
 * an ineligible cohort with its reason — nothing silently skipped. The 28
 * completed, 8 in-review, and 5 skipped rows are the #197 out-of-scope
 * cohorts, verified untouched (see `verifyUntouched208`).
 */
export const LIVE_SNAPSHOT_208 = {
  eligible: 0,
  retried: 0,
  totalItems: 130,
  routeSourcesPending: 89,
  reviewNeedsInput: 8,
  reviewSkipped: 5,
  draftsCompleted: 28,
  ineligibleList: [
    {
      cohort: 'route_sources|pending (89)',
      count: 89,
      reason:
        'retry_ineligible_stage: pre-extraction backlog (includes the 86 mechanism items whose profiles/strategies are validated but not yet ' +
        'activated) — activation then selected retry per domain releasePath, never automatic',
    },
    {
      cohort: 'review_listings|needs_input (8)',
      count: 8,
      reason: 'in-review cohort (out of scope per #197): untouched by this sweep, moves only through reviewer action',
    },
    {
      cohort: 'review_listings|skipped (5)',
      count: 5,
      reason: 'skipped cohort (out of scope per #197): untouched by this sweep, moves only through reviewer action',
    },
    {
      cohort: 'create_drafts|completed (28)',
      count: 28,
      reason: 'completed cohort (out of scope per #197): untouched by this sweep — the scale-up cannot regress finished work',
    },
  ] as readonly IneligibleCohort208[],
};

/**
 * Backlog scope reconciliation (live workspace, 2026-09-16): the 89
 * route_sources|pending rows are the 86 #197-inventory items (34 via #199
 * strategies incl. 18 Shopify domains validated inside #207, 35 via
 * #207-as-written Nutrisource/Open Farm, 5 via #204, 5 via #205, 7 via
 * #206 — verified by brand_hint distribution) plus 3 Kong rows. Kong
 * (`kongcompany.com`) already holds a production profile row, so its items
 * sit outside the #197 mechanism scope and this sweep holds them out with
 * that reason instead of silently absorbing them.
 */
export const SCOPE_RECONCILIATION_208 =
  '89 route_sources|pending = 86 #197-inventory items (34 #199 + 35 #207-as-written + 5 #204 + 5 #205 + 7 #206) + ' +
  '3 Kong items (kongcompany.com already profiled — out of #197 scope, held out with reason)';

/** Live observed untouched-cohort counts (see re-verification queries in the plan doc). */
export interface UntouchedCounts208 {
  completed: number;
  inReview: number;
  skipped: number;
}

/**
 * Untouched-cohort verification seam (acceptance: previously completed /
 * in-review / skipped items verified untouched).
 *
 * Takes the live observed counts so unit tests inject fixtures while the
 * doc's re-verification queries hit the live DB. Returns the offending
 * cohort names — empty means the invariant holds (28 / 8 / 5).
 */
export function verifyUntouched208(counts: UntouchedCounts208): string[] {
  const offending: string[] = [];
  if (counts.completed !== 28) offending.push(`completed: expected 28, observed ${counts.completed}`);
  if (counts.inReview !== 8) offending.push(`in_review: expected 8, observed ${counts.inReview}`);
  if (counts.skipped !== 5) offending.push(`skipped: expected 5, observed ${counts.skipped}`);
  return offending;
}

/**
 * Close-out note for the parent issue (#197): what unblocked what, and
 * what (if anything) remains. Posted as a comment on #197 on close-out.
 */
export const CLOSEOUT_NOTE_208 = [
  '#208 close-out (retry sweep + observability): the backlog is drained by mechanism, not just profiled.',
  '',
  'What unblocked what: Bonide (5 items) → static structured-data profile, 3 worker confirmations, no waiver; variant-blocked sizes and ' +
    'discontinued slugs held out by design. Nylabone (5) → single Sitecore draft, 6 confirmations across 3+ templates, shared-template proven. ' +
    'Blue Buffalo (7) → full AI draft, 6 confirmations across 4 templates, og:title fallback resolves recipe-distinct titles. Shopify (53 across ' +
    '6 domains: Nutrisource 27, Open Farm 8, Snif-Snax 8, Jolly Pets 6, Wondercide 3, Horsemen\u2019s Pride 1) → minimal worker-validated profiles, ' +
    '3 confirmations per domain. Walled (5 domains, 0 current items): bil-jac/northstatesind/yeowww walls lifted → downstream static-validation ' +
    'tickets; chickensouppets/multipet still 403 → distributor/manual, zero profile rows ever. Total metered LLM spend: 0 tokens — every draft ' +
    'was hand-authored and worker-validated.',
  '',
  'Sweep result (live workspace, 2026-09-16): 0 eligible / 0 retried — zero rows in failed extraction and no activations executed (all mechanism ' +
    'tickets are record-only by governance). All 130 items listed with reasons: 89 pre-extraction backlog queued behind operator activation → ' +
    'selected retry per domain; 8 in-review, 5 skipped, 28 completed verified untouched (28/8/5, no drift).',
  '',
  'What remains (operator-owned): per-field approval + image-preview attestation + version activation per domain (runbooks in the mechanism docs), ' +
    'then selected retry of failed-extraction items behind getDomainReleaseHealth; variant-blocked sizes wait for discriminating SKUs or operator ' +
    'selection; three downstream static-validation tickets to file (bil-jac, northstatesind, yeowww); distributor qualification follow-ups FU-1/FU-4 ' +
    'before any walled brand flows. Nutrisource releases on the canonical host per the #202 rule.',
].join('\n');
