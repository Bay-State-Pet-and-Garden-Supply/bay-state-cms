# Issue #204 — Bonide static structured-data profile (5 items)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** live production-worker validation —
the repo's own extraction worker (`POST /profile-runner/extract`, runtime
`static`) fetched 10 real Bonide product URLs itself with production
headers; the variant gate ran in its default `active` mode. Nothing here
rests on tooling previews or homepage signals.
**Code:** `src/onboarding/brand-hub/bonide-static-profile-204.ts` (profile
v1 + evidence table + gap enumeration + activation evaluation + release
predicate), `src/tests/unit/bonide-static-profile-204.test.ts` (15 tests).
**No production writes** (record-only; `extractor_profiles`,
`domain_status`, and items untouched — activation and release are
operator acts queued in §5).

## Profile v1 (validated selector set)

| Field | Selector | Provenance (worker-observed) |
|---|---|---|
| title | `h1` (exactly one per product page) | profile-selector |
| brand | `meta[property="og:site_name"]` → "Bonide" | meta |
| description | `meta[property="og:description"]` (Yoast) | meta |
| images | `.woocommerce-product-gallery__image` (Plytix CDN shots) | profile-selector |
| price | null (accepted gap — §3) | spreadsheet-import via `expected.price` |

## 1. Worker validation — 3 clean confirmations (no waiver needed)

| URL | Title (h1) | Desc | Imgs | Content hash |
|---|---|---|---|---|
| `…/eight-insect-control-garden-dust/` | Eight® Insect Control Garden Dust | Yoast meta | 1 primary + 3 additional | `28b0ee4b…575d358` (full) |
| `…/eight-insect-control-home-garden-rtu/` | Eight Insect Control Home & Garden Ready-to-Use | 157 chars | 5 | `6105f702642e` (prefix) |
| `…/neem-oil-conc/` | Captain Jack's Neem Oil Concentrate | 158 chars | 8 | `1e012193d69e` (prefix) |

All three: `ok=true`, no variant gate (static HTML carries no parseable
variation options on these pages — note the dust page is Store API type
"variable" yet parses ≤1 candidate, so variant behavior is
page-structural, not API-type-driven), brand "Bonide" via
`og:site_name`. The three-confirmation rule is satisfied on evidence.

## 2. Variant-blocked pages — fail closed by design (3 URLs, not confirmations)

| URL | Candidates (worker-parsed) | Worker verdict |
|---|---|---|
| `…/pyrethrin-garden-spray-conc/` | 8-oz sku `857`, pint sku `858` | `variant_selection_required` (no_match rank_below_threshold) |
| `…/captain-jacks-neem-max-conc/` | 8-oz sku `020`, 16-oz sku `026` | same |
| `…/sulfur-plant-fungicide-dust/` | 1lb sku `141`, 4lb sku `1428` | same |

A name+price+UPC retry on pyrethrin still failed — but the UPC was an
unverified guess, not item data, so that attempt proves nothing either
way. Per #197 story 16 this fail-closed behavior is correct (the wrong
SKU is never extracted with confidence) and no selector draft — AI or
otherwise — can resolve size identity. Unlock path: the item carries a
discriminating Woo variation SKU, or the operator completes the
variant-selection flow. These URLs' future items release only afterward.

## 3. Field-by-field gaps (no draft started blind — none needed)

- **title / brand / description / images: carried** by the structured
  layer (§1). No JSON-LD Product exists (Yoast WebPage/Breadcrumb/Org
  only) and none is needed.
- **price: accepted gap.** Static HTML carries only the JS variation
  template `{{{ data.variation.price_html }}}`; no JSON-LD offers, no
  `product:price` meta. The worker covers price from `expected.price`
  (spreadsheet-import) when the item carries it. A draft could not do
  better — there is no static price surface to select.
- **variants: conditional** (§2).
- `draftNeeded: false` on all six rows — **no AI draft is started**,
  light or otherwise.

## 4. WooCommerce-vs-plain-WordPress reflected in the mechanism

Bonide is WooCommerce (GeneratePress theme, `wp-content/plugins/
woocommerce` markers, public Store API answering by slug — #201), and
the profile leans on exactly that: Woo gallery CSS + Yoast meta
structured selectors. **No endpoint fetching is assumed anywhere**:
the selector set contains no `wp-json`, URL, or endpoint reference
(fidelity-tested); the Store API served only as authoring-time
cross-evidence for names/SKUs, never as a runtime dependency — matching
the ladder/worker reality that hinted endpoints are never fetched.

## 5. Activation + selective release (operator runbook)

Activation-evidence evaluation (`evaluateActivation204()`): the count
basis is satisfied on three confirmations, waiver false. This is
evidence only — the authoritative gate (active version, matching
artifact hashes over full 64-hex values, passing title matrix,
imageRuleOk) runs in the live system at activation time, as does
`getDomainReleaseHealth`, the final authority at release time.
Remaining steps are human-only:

1. **Per-field approval** in the Profile Builder (proposal-only
   governance) — this record is the proposal evidence.
2. **Image-preview attestation** for the gallery sets. Known review
   item: the eight page's additional images include 1 YouTube
   video-poster; the worker has no `imageRules` support (schema field
   only), so keep/reject is a reviewer decision. Agent-side preview was
   impossible in this environment (image reading disabled); preview
   URLs: `784_Front.jpg`, `784_LifeStyle_01/02.jpg`, `yYtA3-widsE`
   poster (Plytix `…/images/17|99|a1/…`, `img.youtube.com/vi/
   yYtA3-widsE/maxresdefault.jpg`).
3. **Version activation**, then **selected retry**. Eligibility
   (`selectiveReleaseEligibility204`): `failed_extraction` + own
   workspace + `confirmed_clean` URL only — necessary, not sufficient:
   `getDomainReleaseHealth` is the final authority at release time
   (#198).
   Variant-blocked items wait for variant resolution; discontinued
   slugs (roach-powder, spider-killer-rtu, captan, mite-x — all serving
   the shared discontinued page hash `24d53f6a…`) never release.

No live profile rows were written before *or* by this ticket: the
release guard (#198) has landed, but governance still requires the
operator's per-field approval and preview attestation above. The 5
Bonide items move only through that path.

## Acceptance mapping

- [x] Worker validation passes on real Bonide product URLs; gaps
  enumerated field by field (§1–§3) before any draft is considered —
  and no draft is needed.
- [~] Activation count basis satisfied on evidence (3 confirmations,
  no waiver); image-preview review is queued as an explicit operator
  step with the exact review item named (§5.2) — attestable, not
  assumed. Live-system activation (version, matrix, imageRuleOk) and
  preview attestation remain operator acts.
- [~] Selective-release predicate admits eligible items only; no draft
  started blind (§5.3, tested). Execution (approval → activation →
  selected retry) is an operator act in the production workspace — no
  live DB exists in this environment.
- [x] The WooCommerce finding is reflected in the mechanism with no
  assumed endpoint fetching (§4, tested).
