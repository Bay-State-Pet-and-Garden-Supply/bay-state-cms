# Issue #207 — Shopify minimal profiles, worker-validated (53 items, 6 domains)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** live production-worker validation —
the repo's own extraction worker (`POST /profile-runner/extract`, runtime
`static`) fetched 26 real product URLs itself with production headers;
the variant gate ran in its default `active` mode. Platform `.js`
endpoints were probed separately as authoring-time cross-evidence (title
+ vendor + variant/barcode + image counts transcribed per sample).
Nothing here rests on tooling previews or homepage signals.
**Code:** `src/onboarding/brand-hub/shopify-minimal-profiles-207.ts`
(6 profile rows + evidence table + gap enumeration + per-domain
activation evaluation + release predicate),
`src/tests/unit/shopify-minimal-profiles-207.test.ts` (18 tests).
**No production writes** (record-only; `extractor_profiles`,
`domain_status`, and items untouched — activation and release are
operator acts queued in §5).

**Scope note:** as written #207 covered 35 items (Nutrisource 27 + Open
Farm 8). The #201 verification verdicts route four newly mapped #199
Shopify domains through the same mechanism (SnifSnax 8, Jolly Pets 6,
Wondercide 3, Horsemen's Pride 1), so this ticket validates all six
domains: **53 items**. No re-probing was needed — probe URLs, endpoint
shapes, and fetch hosts are consumed from #201.

## Profiles v1 (validated selector sets)

Shared: `h1` (title — exactly one per product page on all six stores) ·
`meta[property="og:site_name"]` (brand) ·
`meta[property="og:description"]` (description, 114–320 chars observed) ·
price `null` (accepted gap — §3). `shopifyJSONPath: true` recorded as the
generation-seeding hint (thebetterbone.com precedent), never a runtime
contract. Images per theme:

| Domain | Items | Images selector | Worker-observed |
|---|---|---|---|
| `discovernutrisource.com` | 27 | `.product__media img` (Dawn) | 1+5 on all three samples |
| `openfarmpet.com` | 8 | `product-info img` (custom) | 1+9…11 (icons/posters flagged §5.2) |
| `snifsnax.com` | 8 | `.product-media img` (custom) | 1+0…2, matching platform |
| `jollypets.com` | 6 | `.product_gallery img` (Turbo) | 1+0…3, matching platform |
| `www.wondercide.com` | 3 | `.pwc-gallery img` (custom) | 1+2…24 (family rail flagged §5.2) |
| `horsemenspride.com` | 1 | `.product_gallery img` (Turbo) | 1+1…2, matching platform |

Worker allowlists are the fetch hosts (`discovernutrisource.com` per the
#202 canonical-host rule; `www.wondercide.com` + apex, both forms —
release/profile matching strips `www.` per `normalizeReleaseDomain`, so
either form agrees).

## 1. Worker validation — 18 clean confirmations, 3 per domain (no waiver needed)

All 18: `ok=true`, `failureCode=null`, no variant gate (the platform
affirmatively reports exactly one variant), title via `profile-selector`
(h1), brand/description via `meta`, images via `profile-selector`.

| Domain · URL | Title (h1) | Desc | Imgs | Content hash |
|---|---|---|---|---|
| NS `…/chicken-rice-wet-dog-food` | Chicken & Rice Wet Dog Food | 308 | 1 + 5 | `7e11e9f8…43a10` (full) |
| NS `…/beef-jerky-dog-treats` | Beef Jivin' Jerky (vendor Pure Vita — sister brand, same store) | 139 | 1 + 5 | `7cf8e7cf…6b1c1` |
| NS `…/chicken-and-rice-cat-can` | Chicken & Rice Cat Formula | 309 | 1 + 5 | `a2fbc65b…4a5a4` |
| OF `…/arctic-char-topper-for-dogs` | Arctic Char Topper for Dogs | 166 | 1 + 10 | `1d99e74c…27800` |
| OF `…/be-good-bites-chicken-recipe` | Be Good Bites Chicken Treats | 158 | 1 + 11 | `b4cee310…6c2434` |
| OF `…/bone-broth-bundle-for-cats` | Bone Broth Bundle for Cats (no platform barcode — still passes) | 185 | 1 + 9 | `74f4d4f2…78fa` |
| SN `…/salmon-bites-3-pack` | Chewy Salmon & Sweet Potato Bites 3-Pack (4oz) | 114 | 1 + 1 | `cec716af…dfb54` |
| SN `…/salmon-skins` | 100% Salmon Crunchy Skins 3-Pack (1.5oz) | 128 | 1 + 2 | `e37e7ab6…c2562` |
| SN `…/freeze-dried-raw-coho-salmon` | Freeze-Dried Raw Coho Salmon (12oz) | 136 | 1 + 0 (platform reports exactly 1) | `0f28fb44…43698` |
| JP `…/jolly-tuff-flyer` | Jolly Tuff Flyer | 320 | 1 + 3 | `a93b7e4e…d76c0` |
| JP `…/jolly-tuff-toppler-dog-toy` | Jolly Tuff Toppler | 320 | 1 + 3 | `55516d3d…53fb5c` |
| JP `…/jolly-tuff-teeter-dog-toy` | Jolly Tuff Teeter | 319 | 1 + 0 (platform reports exactly 1) | `92df37b0…37ed96` |
| WC `…/2-pack-fruit-fly-trap-for-home-kitchen` | (2 Pack) Fruit Fly Trap… (no platform barcode — still passes) | 126 | 1 + 10 | `a0f51a0d…4958` |
| WC `…/12-month-flea-tick-collar-for-cats` | 12-Month Flea & Tick Collar for Cats | 143 | 1 + 24 (family rail — §5.2) | `88a21191…149a1` |
| WC `…/4-oz-flea-tick-spray-for-pets-home-sample-pack` | Flea & Tick Spray… Scent Sampler | 143 | 1 + 2 | `141527bb…1c35f3` |
| HP `…/amazing-graze-horse-toy` | Amazing Graze | 320 | 1 + 1 | `b0b03b28…8cae1` |
| HP `…/jolly-apple-horse-toy` | Jolly Apple | 320 | 1 + 1 | `1c040c53…26f0` |
| HP `…/jolly-stall-snack-combo` | Jolly Stall Snack Combo | 319 | 1 + 2 | `593a65e5…c98f0` |

The three-confirmation rule is satisfied per domain on evidence (3 each,
6 domains, no waivers). Title-only presence is nowhere relied on: every
confirmation carries title + brand + description + reviewed-image
coverage with provenance.

## 2. Variant-blocked pages — fail closed by design (8 URLs, not confirmations)

| URL | Matrix (worker-parsed from platform JSON) | Worker verdict |
|---|---|---|
| NS `…/adult-chicken-and-rice-dog-food` | 3 sizes, skus 26010/11/12 | `variant_selection_required` |
| OF `…/dry-dog-food-with-beef` | 3 sizes (4/11/22-lb), skus 12870/71/72 | same |
| OF `…/lamb-dry-dog-food` | 3 sizes, skus 12850/51/52 | same |
| JP `…/jolly-soccer-ball-dog-toy` | **18** colors/sizes (several with no platform barcode) | same |
| JP `…/jolly-egg-dog-toy` | 6 (small-8in vs large-12in) | same |
| WC `…/16-oz-flea-tick-spray-for-pets-home` | 4 scents | same |
| WC `…/cedar-flea-tick-pets-home` | 4 sizes (4–128-oz) | same |
| HP `…/jolly-ball-horse-toy` | 10 colors, variant-level GTINs in platform JSON | same |

Every decision is `ambiguous / rank_no_identifier_signal`. A
barcode-carrying retry was attempted on six of the eight pages and still
fails — the matrix parser keeps `sku` + `platform_id` identifiers only
and never consumes platform barcodes (`VARIANT_LIMIT_207`). So for
multi-variant Shopify pages NEITHER name NOR barcode retries resolve:
size/scent/color-specific items wait for the operator variant-selection
flow (identityMatrixHash-bound receipt). Per #197 story 16 this
fail-closed behavior is correct — the wrong SKU is never extracted with
confidence — and no selector draft, AI or otherwise, can resolve option
identity. If worker validation had failed the platform assumption on any
domain (no `.js`, no matrix, no selectors), that domain would have been
re-routed instead of forced — none did.

## 3. Field-by-field gaps (no draft started blind — none needed)

- **title / brand / description / images: carried** on all six stores
  (§1). Brand spelling drift between `og:site_name` and platform vendors
  (NutriSource® / Pure Vita / Snif-Snax / Open Farm Pet) is owned by
  brand assignment, not extraction.
- **price: accepted gap.** No `priceSelector` by design. The worker
  covers price additively (JSON-LD offers on Nutrisource/Open Farm,
  JSON-LD on SnifSnax, product meta on Jolly/Horsemen's Pride) and from
  `expected.price` with spreadsheet-import provenance whenever the item
  carries it. A draft could not do better — Shopify price surfaces are
  per-theme JS-rendered variant state, not static selectors.
- **variants: conditional** (§2).
- `draftNeeded: false` on all six rows — **no AI draft is started**,
  light or otherwise. Total LLM spend for 53 items: zero.

## 4. Platform handling reflected in the mechanism (acceptance: assumption tested, not forced)

Shopify detection holds on every leaf page (`/cdn/shop/` ±
`Shopify.theme`, `detectPlatform() === 'shopify'`); every `.js` endpoint
answers with title + vendor + variants + images; canonical links are
self-consistent (Nutrisource host agreement per #202; Wondercide keyed
on its www fetch host per #201). **No endpoint fetching is assumed at
runtime**: no selector references a URL, endpoint, or `.js` path
(fidelity-tested); the platform JSON served purely as authoring-time
cross-evidence, matching the ladder/worker reality that hinted endpoints
are never fetched on the profile path (the variant gate's same-origin
`.js` matrix fetch excepted — and that fetch is what enforces §2).

## 5. Activation + selective release (operator runbook)

Activation-evidence evaluation (`evaluateActivation207()`): the count
basis is satisfied per domain (3 confirmations each, waivers false).
This is evidence only — the authoritative gate (active version, matching
artifact hashes over full 64-hex values, passing title matrix,
imageRuleOk) runs in the live system at activation time. Automatic release
is health-gated via `getDomainReleaseHealth`, the final authority at release
time for automatic release only (#198 / #215); selected retry below is a
separate deliberate workspace-scoped failed-extraction-only operator act
intentionally available WITHOUT reviewed health.
Remaining steps are human-only, per domain:

1. **Per-field approval** in the Profile Builder (proposal-only
   governance) — this record is the proposal evidence. For Nutrisource:
   execute the #202 handoff first (re-approve NutriSource + PureVita
   strategies to `discovernutrisource.com`, converge the 27 stored
   source URLs, confirm the suite under the canonical key).
2. **Image-preview attestation** for the gallery sets, deciding each
   named review item explicitly:
   - Open Farm: icon, video-poster, and nutritional-label images inside
     `product-info` galleries.
   - Wondercide collar (and site-wide rail): FTPH family cross-sell
     images + video poster.
   - Thin single-shot galleries: SnifSnax coho, Jolly teeter,
     Horsemen's graze/apple (platform reports exactly 1 image each —
     coverage is complete, attestation confirms it).
   
   Agent-side preview was impossible in this environment (image reading
   disabled); primary + additional URLs per confirmation are in the
   module rows and §1. The image bar (two passing image samples plus
   this attestation) is satisfied on evidence only once the attestation
   is recorded — until then it is queued, not assumed.
3. **Variant-posture check**: confirm each releasing item is
   single-variant (or carries an operator variant-selection receipt);
   size/scent/color-specific items go through operator selection first
   (§2, `VARIANT_LIMIT_207`).
4. **Version activation** (with `shopifyJSONPath` set per the
   thebetterbone precedent), then **selected retry**. Eligibility
   (`selectiveReleaseEligibility207`): `failed_extraction` + own
   workspace + `confirmed_clean` URL only — that is the full selected-retry
   gate, available WITHOUT reviewed health (#198 / #215). Automatic release
   is separately health-gated via `getDomainReleaseHealth` and is never
   implied by this predicate. Variant-blocked items wait for variant resolution;
   unvalidated URLs never release; nothing auto-runs outside this
   predicate.

No live profile rows were written before *or* by this ticket: the
release guard (#198) has landed, but governance still requires the
operator's per-field approval and preview attestation above. The 53
items move only through that path; the 28 completed, 8 in-review, and 5
skipped items are untouched.

## Parent ruling (spec-reviewer note, recorded)

"Platform JSON backed with selectors only as fallback" reads inverted
against the implementation (selector runtime + JSON cross-evidence).
Ruling: the parent spec #197 explicitly corrects this phrasing — "the
platform flag is a generation-seeding hint, not a production extraction
contract" and "original Shopify-flag approach explicitly rejected in
favor of worker-validated minimal profiles" — so the implementation
follows the governing #197 correction. JSON backs evidence (per-sample
cross-evidence) + the variant gate (same-origin `.js` matrix fetch);
selectors carry runtime fields. No change required.

## Acceptance mapping

- [x] Worker validation passes on real product URLs for all required
  fields including images and variant correctness — 18 confirmations
  with title + brand + description + images and provenance (§1), plus 8
  fail-closed variant demonstrations with enumerated matrices (§2).
  Title-only presence is relied on nowhere.
- [~] Activation count basis satisfied on evidence per domain (3
  confirmations each, no waivers); image-preview review queued as an
  explicit operator step with every review item named (§5.2) —
  attestable, not assumed. Live-system activation (version, matrix,
  imageRuleOk) and preview attestation remain operator acts.
- [~] Selective-release predicate admits eligible items only
  (`failed_extraction` + own workspace + validated-clean URL); variant
  holds, unvalidated-URL holds, and no auto-run outside the predicate
  (§5.4, tested). Execution (approval → attestation → activation →
  selected retry) is an operator act in the production workspace — no
  live DB exists in this environment.
- [x] The platform assumption was tested per domain and holds on all
  six (§4); the re-route trigger (no `.js` / no matrix / no selectors)
  never fired, so no domain was forced.
