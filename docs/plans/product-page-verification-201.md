# Issue #201 — representative product-page verification probes

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** live fetches of 1–2 representative leaf
product pages per domain with the repo's own ladder functions
(`detectPlatform`, `parseStructuredSignals`, `parseWooCommerceStoreApi`,
`shopifyProductUrl` + public `.js` fetch) and a plain-fetch redirect-chain
recorder. Nothing here rests on homepage evidence alone — every verdict cites
leaf product-page observations.
**Code:** `src/onboarding/brand-hub/product-page-verdicts-201.ts` (verdict
table), `src/tests/unit/product-page-verification-201.test.ts` (16 tests).
**No production writes** (probe-only; `domain_status`, profiles untouched).

## Verdicts (18 domains)

| Domain | Items | Verdict | Downstream |
|---|---|---|---|
| discovernutrisource.com (canonical; legacy `nutrisourcepetfoods.com` 301s here) | 27 | platform evidence (Shopify `.js`) | #207 pattern + #202 alignment |
| openfarmpet.com | 8 | platform evidence (Shopify `.js`) | #207 |
| snifsnax.com | 8 | platform evidence (Shopify `.js`) | #207 scope expansion (new) |
| jollypets.com | 6 | platform evidence (Shopify `.js`, variant-heavy) | #207 scope expansion (new) |
| wondercide.com | 3 | platform evidence (Shopify `.js`, variant-bearing) | #207 scope expansion (new) |
| horsemenspride.com | 1 | platform evidence (Shopify `.js` + JSON-LD variants) | #207 scope expansion (new) |
| bonide.com | 5 | static profile (public Woo Store API) | #204 |
| hummzinger.com | 4 | static profile (public Woo Store API) | new ticket (new) |
| ocraw.com | 1 | static profile (public Woo Store API; OC identity still to confirm per #199) | new ticket (new) |
| bluebuffalo.com | 7 | AI draft (Optimizely DXP, zero structured data) | #206 |
| nylabone.com | 5 | AI draft (single; shared SXA template fingerprinted) | #205 |
| gardentech.com (Sevin pages) | 3 | AI draft (Sitecore SXA, empty schema shells) | new ticket (new) |
| yowup.com | 3 | AI draft (plain WP, no Store API, no Product schema) | new ticket (new) |
| bil-jac.com | 0 (future) | static-profile candidate — **wall lifted**, WP Elementor, OG/meta only | #203 re-route (scope change) |
| northstatesind.com | 0 (future) | static-profile candidate — **wall lifted**, BigCommerce, JSON-LD Product w/ SKU+GTIN | #203 re-route (scope change) |
| yeowww.com | 0 (future) | static-profile candidate — **wall lifted**, BigCommerce, OG/meta, no Product schema | #203 re-route (scope change) |
| chickensouppets.com | 0 (future) | distributor/manual — still 403 at homepage | #203 as written |
| multipet.com | 0 (future) | distributor/manual — still 403 at product page | #203 as written |

Official-domain items covered: **81** (52 original + 29 #199 official).
OurPets / Coop & Range (5 items) are distributor-first-class per #199 — no
domain to probe. Zero profile rows may be created for the two still-walled
domains.

## Acceptance mapping

- [x] Every gap domain (5 original + 5 walled + 8 newly mapped) has a
  recorded verdict with observed evidence attached (§1–§4).
- [x] Nutrisource's canonical-host finding is **confirmed** at product-page
  level: the legacy mapped URL 301-redirects to
  `discovernutrisource.com/products/…`; final host, canonical link, and the
  working `.js` endpoint all agree on `discovernutrisource.com` (§1).
- [x] No domain proceeds on homepage evidence alone — all 16 fetchable
  domains cite ≥1 leaf product page; the 2 still-walled domains cite the
  blocking status itself (§1–§4).
- [x] This record is the input artifact for the mechanism tickets: each
  verdict names its downstream ticket and hands over probe URLs, endpoint
  shapes, and template evidence so no re-probing is needed (§5).

## 1. Platform evidence — Shopify `.js` (6 domains, 53 items)

All six serve `detectPlatform() === 'shopify'` on leaf pages (`/cdn/shop/`
± `Shopify.theme` ± `shopify.com/s/` verbatim) and answer the public
`…/products/<handle>.js` endpoint with title, vendor, variants (with
barcodes), and images. Canonical links are self-consistent; no redirect
splits except Nutrisource (below).

- **discovernutrisource.com (27 items).** Legacy mapped URL
  `nutrisourcepetfoods.com/our-food/…/chicken-rice-recipe/` → **301** →
  `discovernutrisource.com/products/chicken-rice-wet-dog-food` (200).
  Canonical link, final host, and `.js` endpoint agree on
  `discovernutrisource.com` — the research-doc finding is **confirmed at
  product-page level**; the profile domain key must be the canonical host
  (hands to #202). `.js`: vendor `NutriSource®`, 1–3 variants, 6–9 images,
  `hasBarcode`. JSON-LD Product carries sku + gtin + offers
  (e.g. gtin `073893260103`). Hashes: `cf2e0329…`, `45bd713b…`.
- **openfarmpet.com (8).** `.js` 3 variants, vendor `Open Farm` /
  `Open Farm Pet`, 8 images, barcode; JSON-LD Product w/ gtin
  (`683547128705`). Self-canonical, no redirects. Hashes: `04e99af0…`.
- **snifsnax.com (8, #199).** `.js` single-variant, vendor `SnifSnax`,
  JSON-LD w/ gtin `850003301648`. Hashes: `ecda6023…`.
- **jollypets.com (6, #199).** `.js` **18 variants** (soccer ball) / 6
  (egg), barcodes; JSON-LD enumerates per-variant sku + some gtins.
  Variant-heavy: downstream acceptance must prove variant distinction
  (per #197 story 16). Oddity: Yoast/`wp-content` markers coexist with
  Shopify markers (legacy blog markup in theme) — detector still returns
  `shopify` (Shopify checked first). Hashes: `45c0a6f1…`.
- **wondercide.com (3, #199).** `.js` 4 variants (scent/size family),
  barcode, 7 images. **Caution for the worker:** leaf pages carry **no**
  JSON-LD Product, and the embedded `application/json` block that
  `parseWooCommerceStoreApi` picks up names a *different* product
  (`RESCUE™ Ear Drops` / `LGRTU001`) — carousel/recs payload, not the leaf.
  The `.js` endpoint is the authoritative platform evidence, not embedded
  JSON. Hashes: `c617f193…`.
- **horsemenspride.com (1, #199).** `.js` 10 / 2 variants, barcodes,
  13 / 3 images; JSON-LD enumerates variants w/ gtins (`788169014105`…).
  Hashes: `2bd7a16d…`.

## 2. Static profile — public WooCommerce Store API (3 domains, 10 items)

All three return `detectPlatform() === 'woocommerce'`
(`wp-content/plugins/woocommerce` verbatim), carry **no** JSON-LD Product
node, but answer the **public, unauthenticated**
`/wp-json/wc/store/v1/products?slug=<leaf-slug>` endpoint with name, sku
(where present), description, and images. The ladder's embedded-payload
parser finds nothing (no wc/store JSON is embedded), so the static profile
is Store-API-backed and must be validated through the production worker
(acceptance for #204 and the two new tickets) — not assumed from this probe.

- **bonide.com (5 items → #204).** `?slug=eight-insect-control-garden-dust`
  → `{"name":"Eight® Insect Control Garden Dust","sku":"784-P",`
  `"type":"variable","images":4,…}` with `variationIds` (size variants).
  Theme `generatepress`. Settles #204's acceptance question: Bonide is
  **WooCommerce, not plain WordPress** — no assumed endpoint fetching was
  needed; the endpoint was probed, not assumed. Hashes: `b942e370…`.
- **hummzinger.com (4 items, #199 → new ticket).** Mechanism was "unknown"
  at triage; now resolved: `?slug=hummzinger-ultra-12-oz` →
  `{"name":"HummZinger Ultra 12 oz.","sku":"367","type":"simple",`
  `"images":1}`. Theme `green-eco-planet-pro`. Static profile, not AI.
- **ocraw.com (1 item, #199 → new ticket).** `?slug=…` → name, `"sku":""`,
  `"type":"simple"`, **7 images**. No OG tags and no JSON-LD at all on
  product pages — the Store API is the *only* structured layer, which makes
  worker validation load-bearing for images. #199's OC-identity
  confirmation still precedes any approval.

## 3. AI draft — bespoke, no platform endpoint, no Product schema (4 domains, 18 items)

- **bluebuffalo.com (7 items → #206).** `detectPlatform() === 'generic'`;
  only marker is `EPiServerMonitoring DxP` (Optimizely DXP). **Zero**
  `ld+json` blocks of any kind on either product line page; OG/meta
  present (title/image/description surfaces exist for selectors).
  LPF vs Wilderness pages: near-identical byte sizes (545,916 vs 547,624)
  and img counts (217/216) suggest a shared template, but #206 scopes a
  full draft regardless. Hashes: `9923fcbf…`, `c17aeb24…`.
- **nylabone.com (5 items → #205).** Sitecore SXA verbatim
  (`experience-accelerator`, `sxa-base-theme`, `oneweb/nylabone`,
  `/-/media/`). Both probed pages share the **identical SXA theme
  fingerprint** — the shared-template assumption is fingerprinted, not
  asserted; #205 still Owes validation across a second template. The 9
  (groove) / 2 (cheese) `@type:Product` JSON-LD nodes are **empty shells**
  (all name/sku/gtin/offers/images null) — structured layer carries
  nothing. Hashes: `608bad86…`, `1a0cd8d3…`.
- **gardentech.com Sevin pages (3 items, #199 → new ticket).** Same SXA
  signature with the house theme (`oneweb/gardentech`); identical
  fingerprint on both Sevin pages; 3–4 empty Product shells. No platform
  endpoint mappable (non-`/products/` URL shape). **Scope warning:**
  multi-brand house site — any draft's scope must be Sevin pages only.
  There is currently no mechanism ticket for Sevin.
- **yowup.com (3 items, #199 → new ticket).** Plain WordPress (custom
  `yowup` theme), no Woo markers, no JSON-LD Product on either probed
  product page (yogurt `dc423ce8…`, flora `76da5961…`) — and the Store API
  is **absent** (`?slug=…` → 404 `rest_no_route`, Spanish locale message).
  No meta description on the product pages. Static structured-data
  provably cannot carry this domain → AI draft. There is currently no
  mechanism ticket for YowUp.

## 4. Walled-domain re-verification (5 domains, 0 current items)

Method note: a `challenge-platform`/`cf-chl` inline script
(`/cdn-cgi/challenge-platform/…jsd/main.js`, `…/precursor/main.js`) is
present on **all** Cloudflare-fronted pages including plain-200s — the
marker alone is not a block signal. **Status code is the arbiter.**

- **bil-jac.com — WALL LIFTED.** Homepage, `/products/`, and two leaf
  pages (`/products/picky-no-more-…-dog-food/`, hashes `a9947dca…`,
  `1eb09766…`) return 200 with real catalog content (44 imgs on listing,
  15 on leaves). WordPress Elementor (`hello-elementor`), no Woo, no
  JSON-LD Product; OG title/image present on leaves. Verdict:
  **static-profile candidate** (OG/meta-backed), pending worker validation
  — #203's distributor routing for Bil-Jac should be re-scoped, and
  `domain_status` re-checked by its owner.
- **northstatesind.com — WALL LIFTED for plain fetch.** `www` → apex 301,
  then 200. **BigCommerce** (`cdn11.bigcommerce.com` verbatim; the ladder
  detector has no BC adapter → `generic`, recorded, not a failure). Two
  leaf gate pages carry **full JSON-LD Product** (name + sku `8739`/`8874`
  + gtin `00026107087393` + 1 offer + 1 image) with OG title/image.
  Verdict: **static-profile candidate** (JSON-LD-backed) — #203 re-scope.
  Leaf hashes `89bbe50d…`, `fa9c0099…`.
- **yeowww.com — WALL LIFTED for plain fetch.** `www` → apex 301, then
  200. BigCommerce, no JSON-LD on probed pages; leaf `catnip-pouch` has
  OG title/image (37 imgs), `holiday/candy-cane` has neither (6 imgs,
  category-shaped). Verdict: **static-profile candidate** (OG/meta-backed,
  weakest of the three) — #203 re-scope with worker validation as the
  gate. Leaf hashes `1936ead4…`, `58b30de1…`.
- **chickensouppets.com — STILL WALLED.** Homepage **and** leaf product
  page (`/dogs/classic-adult-natural-dry-dog-food-…`) both 403 with the
  Cloudflare challenge title — the wall is proven at product-page level,
  not just the homepage. Verdict: distributor/manual (#203
  as written). No profile row.
- **multipet.com — STILL WALLED.** Product page
  `/shop/tpr-spike-bone/` 403, same Cloudflare title. Verdict:
  distributor/manual (#203 as written). No profile row.

## 5. Downstream handoff (no re-probing needed)

Per-domain probe URLs, fetch hosts, content hashes, endpoint shapes, and
template fingerprints are encoded in
`src/onboarding/brand-hub/product-page-verdicts-201.ts`
(`PRODUCT_PAGE_VERDICTS_201`) — mechanism tickets consume that table.
The `fetchHost` field (not `domain`) is the profile key: www-served sites
(wondercide, bluebuffalo, nylabone, gardentech, ocraw, bil-jac) are keyed
on their www host.

- **#207 (Shopify, 35 items as written): scope expansion required.**
  The same worker-validated minimal-profile treatment now applies to
  snifsnax (8), jollypets (6, variant-heavy), wondercide (3, `.js`-only —
  ignore embedded JSON), horsemenspride (1). New total under the Shopify
  mechanism: **53 items across 6 domains.** Jolly Pets' 18-variant pages
  and Wondercide's scent families must prove variant distinction.
- **#204 (Bonide static):** use `slug=eight-insect-control-garden-dust`
  (variable, sku `784-P`, 4 Plytix images); enumerate per-field gaps
  through the worker before any draft is considered.
- **#205 (Nylabone):** shared-template evidence is fingerprinted (identical
  SXA theme sets on 2 power-chew pages); the ticket still owes validation
  on a second template — the empty Product shells mean selectors carry
  everything.
- **#206 (Blue Buffalo):** zero structured data confirmed on both lines;
  full draft with visual-select fallback stands.
- **#203 (walled routing): scope change.** Only chickensoup + multipet
  remain distributor/manual certainties. Bil-Jac, North States, and Yeowww
  are static-profile candidates now — route them through worker validation
  first, distributor only on validation failure. `domain_status` rows for
  the three should be re-checked (owner: #203; this ticket made no DB
  writes).
- **New tickets needed (no existing owner):** hummzinger static profile
  (4 items, Store API proven), ocraw static profile (1 item, after OC
  identity confirmation), Sevin AI draft on gardentech.com (3 items, Sevin
  scope only), YowUp AI draft (3 items). Until they exist, these 11 items
  stay exactly where they are — this ticket moves nothing.

## Re-verification (read-only; re-run anytime)

```bash
curl -sIL -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' \
  https://nutrisourcepetfoods.com/our-food/nutrisource/nutrisource-dogs/nutrisource-grain-inclusive-dogs-wet/chicken-rice-recipe/ | grep -i 'HTTP/\|location'
curl -s 'https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food.js' | head -c 300
curl -s 'https://bonide.com/wp-json/wc/store/v1/products?slug=eight-insect-control-garden-dust' | head -c 300
curl -s -o /dev/null -w '%{http_code}\n' https://www.chickensouppets.com/
curl -s -o /dev/null -w '%{http_code}\n' https://www.chickensouppets.com/dogs/classic-adult-natural-dry-dog-food-chicken-brown-rice-turkey-recipe
curl -s -o /dev/null -w '%{http_code}\n' https://www.multipet.com/shop/tpr-spike-bone/
curl -s -o /dev/null -w '%{http_code}\n' https://www.bil-jac.com/products/picky-no-more-medium-large-breed-dog-food/
curl -s -o /dev/null -w '%{http_code}\n' https://northstatesind.com/north-states-mypet-petgate-essential/
```
