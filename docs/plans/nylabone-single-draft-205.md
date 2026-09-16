# Issue #205 — Nylabone single Sitecore draft (5 items)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** live production-worker validation —
the repo's own extraction worker (`POST /profile-runner/extract`, runtime
`static`) fetched 6 real Nylabone product URLs itself with production
headers; the variant gate ran in its default mode. Nothing here rests on
tooling previews or homepage signals.
**Code:** `src/onboarding/brand-hub/nylabone-single-draft-205.ts` (draft
v1 + evidence table + per-field approve/reject + activation evaluation +
release predicate), `src/tests/unit/nylabone-single-draft-205.test.ts`
(17 tests).
**No production writes** (record-only; `extractor_profiles`,
`domain_status`, and items untouched — activation and release are
operator acts queued in §5).

## Draft v1 (validated selector set)

| Field | Decision | Selector / owner | Provenance (worker-observed) |
|---|---|---|---|
| title | ✅ approve | `h1` (exactly one per page, all templates) | profile-selector |
| description | ✅ approve | `meta[property="og:description"]` (125–157 chars) | meta |
| images | ✅ approve + preview caveats | `.product-image-gallery img` (9–13 shots/page) | profile-selector |
| brand | ❌ reject (no surface) | brand assignment, not extraction | n/a (worker null) |
| price | ❌ reject (accepted gap) | spreadsheet-import via `expected.price` | n/a |
| variants | conditional | operator variant-selection flow for size-specific items | n/a (no matrix) |

## 1. Worker validation — 6 clean confirmations across 3 templates (no waiver needed)

| URL (template) | Title (h1) | Desc | Imgs | Content hash |
|---|---|---|---|---|
| `…/chew-toys/power-chew/dura-chew-power-chew-textured-bone` (power-chew) | Power Chew Groove Bone Dog Chew Toy | 147 chars | 1 primary + 12 additional | `608bad86…` (prefix) |
| `…/chew-toys/power-chew/durachew-cheese-bone` (power-chew) | Power Chew Cheese Bone Dog Chew Toy | 147 chars | 1 + 10 | `1a0cd8d3…` (prefix) |
| `…/edible-chew-treats/healthy-edibles-all-natural-long-lasting-bacon-chew-treats` (edible) | Healthy Edibles All-Natural Long Lasting Chew Treats | 151 chars | 1 + 11 | `404cce1c…` (prefix) |
| `…/dental-solutions/advanced-oral-care-dog-dental-kit` (dental) | Advanced Oral Care Dog Dental Kit | 157 chars | 1 + 11 | `972e8968…` (prefix) |
| `…/chew-toys/puppy-chew/classic-puppy-chew-flavored-durable-dog-chew-toy` (puppy-chew) | Puppy Power Chew Stages Teething Bone & Original Bone Dog Chew Toy | 147 chars | 1 + 10 | `7f0f7bed…` (prefix) |
| `…/chew-toys/moderate-chew/flexichew-bone-dog-chew-toys` (moderate-chew) | Flexi Chew Gumabone Textured Dental Bone Dog Chew Toy | 125 chars | 1 + 8 | `6682ad75…` (prefix) |

All six: `ok=true`, `failureCode=null`, `matrixDecision=null`, brand
null. Five product lines, two URL shapes (depth-8 `chew-toys/<line>/`,
depth-7 `<line>/`), one selector set, zero template-specific
adjustments. The three-confirmation rule is satisfied twice over on
evidence (6 confirmations, 3+ templates spanned against a 2-template
minimum).

## 2. Shared-template finding — proven, not fingerprinted (acceptance §1)

#201 fingerprinted the shared SXA theme on 2 power-chew pages
(`experience-accelerator`, `sxa-base-theme`, `oneweb/nylabone`). This
ticket extends the evidence to 4 more pages on 3 further lines and finds
the fingerprint AND every extraction surface identical everywhere: one
bare `h1`, `.body-copy`, `.component.productimage.product-image-gallery.
col-12`, `select#primaryvariationvalue`, `og:title`/`og:description`/
`og:image`, no `meta[name=description]`, no `og:site_name`, no price
surface of any kind. **One draft covers nylabone.com; multi-structure
dispatch (out of scope per #197) is not needed** — recorded here
explicitly (`TEMPLATE_FINDING_205`) instead of silently covering one
template.

## 3. Correction to #201: the JSON-LD nodes are not empty shells

#201 reported "9 / 2 @type:Product nodes but ALL empty shells (null
name/sku/gtin/offers/images)". That reading matched lowercase
schema.org keys against Sitecore's capitalized emission and missed the
data. Every validated page carries one primary Product node plus one
node per size variant with **`Name`** (variant-specific, e.g. "…
Groove Bone … Flavor Medley Small (1 Count)"), **`Sku`** (e.g.
`NCF302PR`), **`Gtin12`** (e.g. `018214822950`), **`Image.Url`**,
**`Description`**, and **`Brand.Name`** — variant nodes carry DISTINCT
Sku+Gtin12+Name per size (groove: 8 variant nodes; bacon: 10).

Why the draft still uses CSS/meta selectors: the worker resolves only
lowercase `jsonld:` keys (`name`, `offers.price`, `brand.name`) and its
variant-matrix parser requires `ProductGroup`/`hasVariant` wrappers
Nylabone never emits — so no `jsonld:` selector and no matrix can consume
these nodes today (fidelity-tested in code:
`draft205UsesNoUnresolvableJsonLd`). The JSON-LD serves as
authoring-time cross-evidence (variant existence, Sku/Gtin
corroboration), never a runtime dependency.

## 4. Variant posture — scoped, not waived (acceptance: story 16)

Every family page is variant-bearing (size select + per-size Sku/Gtin
nodes), but the worker parses **no** variant matrix on Sitecore pages
(`matrixDecision: null` on all 6 samples — the `<select>` and the
capitalized-key flat nodes match none of the five matrix parsers). The
gate therefore cannot fail closed here as it does on Bonide: family
extraction passes without discriminating sizes, and galleries may serve
wrong-variant images — observed verbatim: the Small/Medley groove page
galleries the **X-Large silo** (`018214822974-silo.jpg`).

Rule: **family-level items may release** under the predicate in §5;
**size-specific items wait for operator variant selection** (or a future
Sitecore matrix parser — out of scope). No waiver of this step exists in
this record. The wrong SKU is never extracted with confidence because
size-specific release is refused, not because the gate catches it.

## 5. Activation + selective release (operator runbook)

Activation-evidence evaluation (`evaluateActivation205()`): the count
basis is satisfied on six confirmations spanning three templates,
waiver false. This is evidence only — the authoritative gate (active
version, matching artifact hashes over full 64-hex values, passing
title matrix, imageRuleOk) runs in the live system at activation time,
as does `getDomainReleaseHealth`, the final authority at release time.
Remaining steps are human-only:

1. **Per-field approval** in the Profile Builder (proposal-only
   governance) — this record is the proposal evidence. Brand and price
   stay rejected: approving them would fabricate a surface that does not
   exist.
2. **Image-preview attestation** for the gallery sets, deciding each
   named review item explicitly:
   - UGC photos: groove `lunathelittlemini-…`, `weeklywalter-…`; bacon
     3× `healthy-edibles-xs-ugc…` (plus cross-line `nbq101vp8p` UGC on
     the `neb101tpp` page).
   - Cross-product images: X-Large silo on the Small/Medley groove page;
     `npd303p`-line images (family pic, puppy-kit informational,
     made-in-USA) on the `npd301p` dental page.
   - Generic story images: brand-story, sustainability, when-to-replace,
     size-chart, cares.
   - Video poster: bacon `i.ytimg.com/vi/9vhjqwespo4/default.jpg` (the
     worker has no `imageRules` support — keep/reject is a reviewer
     decision, not a selector rule).
   
   Agent-side preview was impossible in this environment (image reading
   disabled); primary + additional URLs per confirmation are in the
   module rows and §1. The image bar (two passing image samples plus
   this attestation) is satisfied on evidence only once the attestation
   is recorded — until then it is queued, not assumed.
3. **Variant-posture check**: confirm each releasing item is family-level;
   size-specific items go through operator variant selection first (§4).
4. **Version activation**, then **selected retry**. Eligibility
   (`selectiveReleaseEligibility205`): `failed_extraction` + own
   workspace + `confirmed_clean` family-level URL only — necessary, not
   sufficient: `getDomainReleaseHealth` is the final authority at
   release time (#198).

No live profile rows were written before *or* by this ticket: the
release guard (#198) has landed, but governance still requires the
operator's per-field approval and preview attestation above. The 5
Nylabone items move only through that path.

## Acceptance mapping

- [x] Validation spans 3 distinct product templates (power-chew,
  edible-chew-treats, dental-solutions — plus puppy-chew and
  moderate-chew lines) with passing worker results on each (§1); the
  single-template assumption is proven and the no-multi-structure
  finding recorded explicitly (§2).
- [~] Activation count basis satisfied on evidence (6 confirmations, no
  waiver); image-preview review queued as an explicit operator step with
  every review item named (§5.2) — attestable, not assumed.
  Live-system activation (version, matrix, imageRuleOk) and preview
  attestation remain operator acts.
- [~] Selective-release predicate admits eligible family-level items
  only; size-specific items wait for variant selection (§4–§5, tested).
  Execution (approval → attestation → activation → selected retry) is an
  operator act in the production workspace — no live DB exists in this
  environment.
- [x] Per-field approve/reject preserved (`FIELD_DECISIONS_205`):
  title/description/images approved with selectors; brand/price rejected
  with named non-draft owners; variants conditional. The partial
  generation (no brand, no price selector) is a usable profile — the
  worker leaves brand null (non-fatal) and covers price from
  `expected.price`.
