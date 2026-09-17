# Profile platform triage — research findings

**Date:** 2026-09-15
**Question:** For the 5 brand domains blocking 52 onboarding items, which actually need
bespoke AI-drafted CSS profiles, and which can ride generic platform layers?
**Method:** Raw-homepage fetch of all 5 domains + repo source (ladder, platform
adapters, DB). Homepage platform is a triage signal, not proof — each finding
lists its product-page verification step.

## 1. How extraction layering actually works (repo primary source)

`src/onboarding/extraction-ladder/ladder.ts:1-20` — cheapest reliable layer first:

1. Direct HTTP retrieval
2. JSON-LD / microdata / Open Graph / canonical / meta structured data
3. Platform public product representations (Shopify product JSON, WooCommerce
   Store API, Next.js app state, Nuxt hydration state)
4. Domain-specific CSS profiles — **last resort**

Layers 5-8 (rendered browser, interaction, fallbacks, LLM extraction) were
deliberately NOT relocated (same header). Layers 1-4 are deterministic: no
browser, no LLM (`platforms.ts:4`).

Platform detection (`platforms.ts:67-74`, Shopify checked first):

- `shopify` = `/cdn/shop/` or `Shopify.theme` or `shopify.com/s/` in page markup
- `woocommerce` = `wp-content/plugins/woocommerce` or `wc-store-v1|wc/store`
- `nextjs` = `__NEXT_DATA__` or `_next/static`
- `nuxt` = `__NUXT__` markers, else `generic`

Shopify extraction = `shopifyProductUrl()` + `fetchShopifyProductJson()`
(`platforms.ts:256-288`): deterministic fetch of the public product JSON,
yielding title, vendor→brand, GTIN/barcode, variants. Precedent in DB: exactly
1 of 23 profiles uses the generic flag (`thebetterbone.com`, `shopify_json_path=1`).

Constraint that survives all of this: `ladder.ts` notes JSON-LD single-offer is
**corroboration only, never sufficient on its own** — structured data alone does
not clear extraction; a platform API hit or a healthy profile still has to carry
the identity proof.

## 2. Domain verdicts (homepage HTML fetched 2026-09-15)

| Domain | Items | Platform signal (verbatim markers) | Verdict |
|---|---|---|---|
| nutrisourcepetfoods.com | 27 | Canonical `https://discovernutrisource.com/`; `preconnect https://cdn.shopify.com`; assets under `/cdn/shop/files/`; `fonts.shopifycdn.com` | **Shopify (definitive** — matches the `/cdn/shop/` detector verbatim). Flag-profile, no AI draft |
| openfarmpet.com | 8 | `<!-- Start of Shoplift scripts -->` — Shoplift is a Shopify-only theme testing app | **Shopify (strong)**. Flag-profile, verify via detector on product page |
| bluebuffalo.com | 7 | `<!--EPiServerMonitoring DxP-->` (Optimizely DXP), OneTrust consent stack | **Optimizely enterprise CMS, bespoke**. Full AI-draft path |
| nylabone.com | 5 | `/-/media/feature/experience-accelerator/…`, `sxa-base-theme`, `oneweb/nylabone` theme paths | **Sitecore SXA, template-driven**. One AI draft should cover all product pages (shared templates) |
| bonide.com | 5 | Yoast SEO v28.5, `wp-content` assets, homepage `application/ld+json` Yoast graph (WebPage-level, no Product node on homepage) | **WordPress + JSON-LD present**. Check product pages for WooCommerce (`wc/store`) or Product/Offer schema; ladder L2 may carry most fields |

Net: **35 of 52 blocked items (67%) are Shopify flag-profiles**. Only Blue Buffalo
is confirmed-bespoke; Nylabone is one template-driven draft; Bonide is verify-then-decide.

## 3. Traps found (all primary-sourced)

- **Canonical-host mismatch (Nutrisource).** `brand_sites.domain` says
  `nutrisourcepetfoods.com` but the site's canonical host is
  `discovernutrisource.com`. The profile domain key must match the host the
  worker actually fetches — normalize to final/canonical host or the profile
  will never match (`profile_miss`, ladder.ts:520-521 path).
- **Cloudflare-walled domains can't be profiled, period.** `domain_status`
  (DB, read 2026-09-15): `bil-jac.com`, `chickensouppets.com`, `multipet.com`,
  `northstatesind.com`, `yeowww.com` = `blocked — Cloudflare Bot Challenge /
  HTTP 403`. No selector survives a 403. Route: `distributor_record` or manual
  evidence, never the Profile Builder.
- **The unused lever is distribution, not generation.** All 200 `brand_sites`
  rows are `source_strategy=official_first`; all 130 items are
  `source_type=official_page` — yet distributor keys (`orgill`,
  `pet_food_experts`, `phillips_storefront`) are configured. Zero distributor
  usage is a strategy choice, not a capability gap.
- **LLM readiness confirmed.** `llm_task_configs`: `profile_generation` →
  `deepseek/deepseek-v4-flash`, key configured. AI drafts are unblocked for the
  domains that truly need them.
- **10 brands have no domain mapping at all** (Snif-Snax 8, Jolly Pets 6,
  Hummzinger 4, YowUp/Wondercide/Sevin/OurPets 3 each, Coop & Range 2, OC,
  Horsemen's Pride 1 — 37 items). Profile work cannot start there; brand→domain
  resolution (ADR 0017) comes first.

## 4. Recommendation for the spec

Order work by cost tier, not by item count: (0) resolve 10 unmapped brands →
(1) two Shopify flag-profiles + canonical-host normalization (35 items) →
(2) Bonide product-page verification (Woo? Product schema?) → (3) one Sitecore
draft for Nylabone → (4) one Optimizely draft for Blue Buffalo → (5) distributor
routing for the 5 Cloudflare-walled domains. AI selector generation applies to
steps 3–4 only — roughly 12 of 52 items, not all of them.
