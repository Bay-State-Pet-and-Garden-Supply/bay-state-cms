# Issue #206 — Blue Buffalo full AI draft (7 items)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** live production-worker validation —
the repo's own extraction worker (`POST /profile-runner/extract`, runtime
`static`) fetched 6 real Blue Buffalo product URLs itself with production
headers; the variant gate ran in its default mode. Nothing here rests on
tooling previews or homepage signals.
**Code:** `src/onboarding/brand-hub/blue-buffalo-full-draft-206.ts` (draft
v1 + evidence table + per-field approve/reject + activation evaluation +
release predicate), `src/tests/unit/blue-buffalo-full-draft-206.test.ts`
(20 tests).
**No production writes** (record-only; `extractor_profiles`,
`domain_status`, and items untouched — activation and release are
operator acts queued in §5).

## Draft v1 (validated selector set)

| Field | Decision | Selector / owner | Provenance (worker-observed) |
|---|---|---|---|
| title | ✅ approve (og:title fallback) | `meta[property="og:title"]` (distinct full title per recipe) | meta |
| description | ✅ approve | `meta[property="og:description"]` (132–260 chars) | meta |
| images | ✅ approve + preview attestation | `.Hero--product img` (2 hero shots/page) | profile-selector |
| brand | ❌ reject (no surface) | brand assignment, not extraction | n/a (worker null) |
| price | ❌ reject (accepted gap) | spreadsheet-import via `expected.price` | n/a |
| variants | conditional | operator variant-selection flow for size-specific items | n/a (no matrix) |

## 1. Worker validation — 6 clean confirmations across 4 templates (no waiver needed)

| URL (template) | Title (og:title) | Desc | Imgs | Content hash |
|---|---|---|---|---|
| `…/dry-dog-food/life-protection-formula/chicken-brown-rice-recipe/` (lpf-dry) | Life Protection Formula Adult Dry Dog Food - Chicken & Brown Rice | 260 chars | 1 primary + 1 additional | `b8e35556…` (full) |
| `…/dry-dog-food/life-protection-formula/salmon-brown-rice-recipe/` (lpf-dry) | BLUE Life Protection Formula Adult Dog Food Salmon & Brown Rice | 151 chars | 1 + 1 | `e63759d5…` (full) |
| `…/dry-dog-food/wilderness/adult-chicken-grain-free-recipe/` (wilderness-dry) | BLUE Wilderness™ Adult Dog Grain-Free Chicken Recipe | 182 chars | 1 + 1 | `1c2d11d6…` (full) |
| `…/dry-dog-food/wilderness/adult-salmon-grain-free-recipe/` (wilderness-dry) | BLUE Wilderness™ Adult Dog Grain-Free Salmon Recipe | 171 chars | 1 + 1 | `2d151b68…` (full) |
| `…/wet-dog-food/blue-specialty/senior-homestyle-recipe-beef-dinner/` (wet-homestyle) | BLUE Homestyle Recipe Senior Dog Food Beef & Vegetable Dinner | 191 chars | 1 + 1 | `4ec1a003…` (full) |
| `…/dog-treats/health-bars/soft-and-chewy-chicken-and-apple/` (treats-healthbars) | BLUE Soft & Chewy Health Bars | 132 chars | 1 + 1 | `fd95d939…` (full) |

All six: `ok=true`, `failureCode=null`, `matrixDecision=null`, brand
null. Four product lines, one selector set, zero template-specific
adjustments. The three-confirmation rule is satisfied twice over on
evidence (6 confirmations, 4 templates spanned against a 2-template
minimum).

## 2. Shared-template finding — proven, not asserted (acceptance §1)

#201 probed 2 dry-food lines (near-identical byte sizes, shared-template
suggestion). This ticket extends the evidence to 4 more pages on 2
further lines (wet, treats) and finds the structure AND every extraction
surface identical everywhere: `.Hero.Hero--product` with `picture`
mobile shot + `.Hero-image` desktop shot, `.Hero-text` with generic `h1`
+ `.Hero-flag .Subtitle` + `.Hero-info h3[itemprop="name"]`, zero
`ld+json` blocks, zero `<select>`, zero `$` amounts, size availability
as plain `<p>` text. **One draft covers bluebuffalo.com; multi-structure
dispatch (out of scope per #197) is not needed** — recorded here
explicitly (`TEMPLATE_FINDING_206`) instead of silently covering one
template.

## 3. The h1 finding: visual-select fallback per field (new vs #201)

The visually prominent `h1` carries only the generic family name and is
**identical for different recipes on the same line** (observed verbatim):
"Life Protection Formula ™" on both LPF pages; "BLUE Wilderness ™" on
both Wilderness pages. A draft selecting `h1` would validate two
different products under the same title — recipe/variant correctness
(acceptance) would fail. The recipe distinction exists in-DOM
(`h3[itemprop="name"]`: "Chicken and Brown Rice Recipe" vs "Salmon and
Brown Rice Recipe") and in full in `og:title` — so the title field falls
back to `meta[property="og:title"]`, which resolved 6 distinct full
titles through the worker (LPF chicken ≠ LPF salmon, Wilderness chicken
≠ Wilderness salmon). **The naive visual pick is explicitly rejected**
(`H1_GENERIC_FINDING_206`); the fallback is the committable selector.

Extension to #201: the zero-`ld+json` finding now holds across all 6
leaf pages on 4 lines (not just the 2 probed) — no `jsonld:` selector
appears in the draft (fidelity-tested in code:
`draft206UsesNoUnresolvableJsonLd`).

## 4. Variant posture — scoped, not waived (acceptance: story 16)

Every dry-food page is size-bearing in prose ("Available in 4.5, 13 &
24-lb. bags."; LPF salmon lists 5/15/24/30/40-lb), but sizes share ONE
family URL: no `<select>`, no size link matrix, no JSON-LD — so the
worker parses **no** variant matrix (`matrixDecision: null` on all 6
samples) and the gate cannot fail closed the way it does on Bonide.
Family-level extraction passes without discriminating bag sizes.

Rule: **family-level items may release** under the predicate in §5;
**size-specific items wait for operator variant selection** (or a future
matrix/parser path — out of scope). No waiver of this step exists in
this record. The wrong SKU is never extracted with confidence because
size-specific release is refused, not because the gate catches it.

## 5. Activation + selective release (operator runbook)

Activation-evidence evaluation (`evaluateActivation206()`): the count
basis is satisfied on six confirmations spanning four templates,
waiver false. This is evidence only — the authoritative gate (active
version, matching artifact hashes over full 64-hex values, passing
title matrix, imageRuleOk) runs in the live system at activation time.
Automatic release is health-gated via `getDomainReleaseHealth`, the final
authority at release time for automatic release only (#198 / #215);
selected retry below is a separate deliberate workspace-scoped
failed-extraction-only operator act intentionally available WITHOUT
reviewed health.
Remaining steps are human-only:

1. **Per-field approval** in the Profile Builder (proposal-only
   governance) — this record is the proposal evidence. Brand and price
   stay rejected: approving them would fabricate a surface that does not
   exist. Title approval must confirm the **og:title fallback, not h1**
   (§3).
2. **Image-preview attestation** for the hero sets (mobile + desktop
   shots per page; URLs are the `primaryImage` values in the module
   rows). No UGC or cross-product impurities were observed in the hero
   sets, but keep/reject per page set is still a reviewer decision.
   Agent-side preview was impossible in this environment (image reading
   disabled).
3. **Variant-posture check**: confirm each releasing item is family-level;
   size-specific items go through operator variant selection first (§4).
4. **Version activation**, then **selected retry**. Eligibility
   (`selectiveReleaseEligibility206`): `failed_extraction` + own
   workspace + `confirmed_clean` family-level URL only — that is the full
   selected-retry gate, available WITHOUT reviewed health (#198 / #215).
   Automatic release is separately health-gated via `getDomainReleaseHealth`
   and is never implied by this predicate.

No live profile rows were written before *or* by this ticket: the
release guard (#198) has landed, but governance still requires the
operator's per-field approval and preview attestation above. The 7
Blue Buffalo items move only through that path.

## LLM cost (acceptance: recorded for observability)

`LLM_COST_206`: **zero** — no LLM generation was used. Selectors were
hand-authored from observed DOM structure and validated through the
production worker (6 live extractions, 0 tokens). "AI draft" here is the
mechanism-ticket type (the Profile Builder proposal path, as opposed to
platform/static/distributor routes) — this instance simply needed no
metered generation to produce its proposal. The per-domain ledger
(#197 story 13) records this draft at zero cost, distinguishing it from
metered AI generations.

## Acceptance mapping

- [x] Every required field has an approved selector or an explicitly
  accepted gap with rationale (`FIELD_DECISIONS_206`): title/description/
  images approved with selectors (title via the §3 fallback);
  brand/price rejected with named non-draft owners; variants conditional.
- [~] Activation count basis satisfied on evidence (6 confirmations
  across 4 templates, no waiver); image-preview review queued as an
  explicit operator step (§5.2) — attestable, not assumed. Live-system
  activation (version, matrix, imageRuleOk) and preview attestation
  remain operator acts.
- [x] Worker validation passes on real product URLs including variant
  correctness where applicable (§1 + §3 recipe-distinction proof; §4
  variant scoping — the wrong SKU is never extracted with confidence).
- [~] Selective-release predicate admits eligible family-level items
  only; size-specific items wait for variant selection (§4–§5, tested).
  Execution (approval → attestation → activation → selected retry) is an
  operator act in the production workspace — no live DB exists in this
  environment. LLM cost per draft recorded above (zero).
