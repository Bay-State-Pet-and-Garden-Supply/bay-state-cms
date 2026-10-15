# Live Storefront Product-Field Map — 2026-10-13

Evidence-backed inventory and working map of the Bay State live store's numbered additional product fields
(`ProductField1`–`ProductField32`), merging the **fresh 2026-10-13 census** (parent-owned
authenticated export) with **actual current storefront observation** (this pass, read-only).
Supersedes the cached-export scout findings where they differ; provisional scout labels are
treated skeptically throughout.

**Update 2026-10-15:** the authenticated Extra Product Fields screenshot (user-supplied,
2026-10-15; see `docs/audits/extra-fields-certification-2026-10-15.md`) certifies the
live admin labels for PF16–PF32 exactly as the repo declared them (17/17 match, including
`Lifestage` single word, `Product Cross Sell`, PF31 `Product Category` vs PF24
`Facet - Category`). PF16–PF32 rows below are now `CERTIFIED (2026-10-15)`; the
`UNCONFIRMED`/`UNRESOLVED` language in the original 2026-10-13 pass below applies only to
PF1–PF15, whose labels were not shown in the screenshot and remain uncertified. The
2026-10-13 census/storefront value evidence is unchanged.

**Original headline (2026-10-13 pass):** no `ProductFieldN` literal appears anywhere in
observed storefront output
(`category HTML`, product HTML, `app.js`, `wl.js`, `reviews.js` — all zero hits), so numbered
bindings were inferred from **facet-parameter ↔ census-value correspondence**, not proven by literal tags.
Strongest new result: the observed product page's *"You may also like"* block renders exactly
the 4-SKU set of one fresh-census PF32 sample value — PF32 carries **identifiers, not names** —
but PF32's top values are shared verbatim by thousands of products, so its exact semantic role
(cross-sell source vs. pack/group data) stayed unresolved in that pass. The export carries values
only, and the full export XML contains no `ProductFieldN` name/label tags (parent-verified, see §1).

## 1. Method (reproducible, read-only)

- **Census (parent):** fresh authenticated read-only `db_xml.cgi` products export, no fields
  filter — `retrievedAt 2026-10-13T18:24:05.084Z`, 179,650,504 bytes, 22,178 `Product` rows,
  32 observed fields. Parsed with fast-xml-parser; only export containers + `ProductFieldN`
  retained; text values not numerically coerced. Saved by parent at
  `local://live-productfield-census.json` (`adminLabelsConfirmed: false`). Raw XML and
  credentials stay in parent memory; nothing raw is reproduced here.
- **Export-header negative evidence (parent, 2026-10-13):** the full export XML header
  contains `ResponseCode`/`ResponseDescription` and `Products`; **no
  `ProductFieldN`-name/label tags were observed anywhere in the full XML** — configured
  Extra-Field labels are not recoverable from any observed export surface. A parent
  authenticated GET of the configured CGI base directory returned HTTP 500 (no admin
  navigation or login form), so the Extra-Fields UI remains unobserved. **No admin label is
  claimed as confirmed for any slot in this report.**
- **Storefront (this pass, all GET, no login, no mutation):**
  - `https://www.baystatepet.com/dry-cat-food.html` — 200, 815,536 B, retrieved
    2026-10-13T18:28:53Z (`curl`, saved to local temp only, not the repo). Filter nav parsed
    from `<nav id="filters">`; product tiles + quickview attributes inspected.
  - `https://www.baystatepet.com/dog-toys.html` — 200, 3,461,935 B, retrieved ~18:29Z. Second
    category to cover non-food facets (Size/Material/Color/Product Feature).
  - `https://www.baystatepet.com/blue-tastefuls-adult-cat-7-chicken-brown-rice-7-lb.html`
    (product page reached via the category tile link) — 200, 57,380 B, retrieved ~18:28Z.
    *"You may also like"* block extracted.
  - Linked scripts **discovered from the category HTML** (not guessed):
    `/media/js/app.js?3` (200, 51,436 B), `/media/js/wl.js` (200, 18,649 B),
    `/media/js/reviews.js` (200, 14,053 B), all retrieved ~18:28–18:30Z.
  - Filtered-URL probe (`?brand[]=fromm`) returned a Cloudflare challenge (403, 5,557 B) —
    server-side filter behavior **not** verified; facet evidence is static-HTML only.
  - `browser-use` was **not** needed: plain static reads sufficed (per skill, no browser when
    fetch works). The installed `browser-use` binary rejects skill-documented `--doctor`
    (parent-observed); no relay target was used. No browser tab opened; nothing to close.
- **Local comparisons:** `scripts/realign-classification-mappings.ts:42-59`
  (`SHOP_SITE_FIELD_LABELS`, PF16–PF32), `docs/audits/classification-mapping-audit.md`
  (live-registry labels, 2026-08-24), scout findings at `agent://LiveAdditionalFieldMap`
  (cached 2026-10-11 export, 22,178 products).

**Provenance key (used in every row):** `LIVE-XML` = fresh-census values/population ·
`LIVE-PAGE` = literal storefront text or markup observed this pass · `LOCAL` =
repo-declared label (unconfirmed live) · `INFER` = analyst guess from values (never a label).

## 2. Storefront binding evidence

### 2.1 Facet groups are literal; numbered bindings are inferred from value correspondence

The category pages render a `<nav id="filters">` block ("NARROW YOUR SEARCH") with literal
group headings and query-param links. Zero `ProductField` literals occur in any fetched
resource (dry-cat HTML, dog-toys HTML, product HTML, `app.js`, `wl.js`, `reviews.js`).

**Dry-cat-food facet groups (`LIVE-PAGE`, 2026-10-13T18:28:53Z):**

| # | Literal heading | Param | Options observed |
|---|---|---|---|
| 1 | Brand | `brand[]` | 29: blue (10), fromm (11), science diet (7), … (all lowercase) |
| 2 | Pet Type | `pettype[]` | 1: cat (84) |
| 3 | Lifestage | `lifestage[]` | 4: adult (35), all life stages (13), kitten (12), mature (1) |
| 4 | Pet Size | `petsize[]` | 1: all breeds (1) |
| 5 | Special Diet | `specialdiet[]` | 4: grain-free (20), indoor (1), no corn, wheat or soy (2), weight management (1) |
| 6 | Health Feature | `healthfeature[]` | 6: digestive health (2), high protein (6), urinary care (1), urinary tract health (5), hairball control (2), weight management (3) |
| 7 | Food Form | `foodform[]` | 1: dry food (73) |
| 8 | Flavor | `flavor[]` | 12: chicken (57), salmon (15), fish (8), turkey (5), … |
| 9 | Category | `category[]` | 2: cat food (70), dog food (2) |
| 10 | Product Type | `producttype[]` | 1: food (72) |
| 11 | Price | `price[]` | buckets 10/20/30 (price ranges, not a product field) |
| 12 | Packaging Type | `packagingtype[]` | 1: bag (42) |

**Dog-toys extra groups (`LIVE-PAGE`, ~18:29Z):** Brand (29) · Pet Type: dog (387), cat (1) ·
Lifestage: puppy (8) · Health Feature: dental (3), teething (8) · Flavor: bacon (7), beef (3),
chicken (2), … · Category: dog supplies (362), dog toys (18), dog treats (27), toys (7),
cat supplies (1) · Product Type: toys (346), toy (31), treats (27), dog toys (12), … (10 opts) ·
Product Feature: squeak (10), squeaky (6), stuffing-free (6), glow (2), squeaker (1) ·
Size: large (14), medium (16), small (12), x-small (7), x-large (5), regular (3), petite (1),
wolf (1), 19" (1), 11" / 27.9 cm (1) · Material: rubber (39), felt (13), fabric (8), nylon (7),
polyester (6), plastic (6), plush (3), cotton (1) · Color: swatch links
(`color[]`=assorted/black/blue/brown/green/yellow/orange/… with counts as image `alt` text) ·
Price buckets.

### 2.2 PF24 ≈ Category, PF25 ≈ Product Type (inferred correspondence, bindings unconfirmed)

- `LIVE-PAGE` headings "Category" and "Product Type" match the `LOCAL` labels for PF24/PF25
  (`realign-classification-mappings.ts:51-52`; v10 `export-mappings.json`).
- `[INFERENCE]` Category-facet options overlap PF24 values such as `Dog Food`, `Dog Supplies`,
  and `Dog Treats`; Product-Type-facet options overlap PF25 values such as `Food`, `Treats`,
  and `Toys`. Local export mappings independently declare those field meanings.
  This supports a working map, not a confirmed numbered-field binding: PF31 also contains
  category values, so category-value correspondence alone cannot distinguish PF24 from PF31.
  Exact admin labels "Facet - Category" / "Facet - Product Type" remain **UNCONFIRMED**.
- The sampled facet options are lowercase while XML values include mixed-case variants.
  This shows presentation normalization; server-side case-insensitive matching was **not**
  verified because the filtered request encountered a Cloudflare challenge.

### 2.3 PF32: identifiers, not names — with a same-set cross-sell match

- `LIVE-XML` PF32: 20,799/22,178 populated (93.8%), 4,055 distinct, **20,796 piped**.
  Three populated rows contain single values: `ELEVATOR` (2) and `687035102758` (1). Top lists:
  `850045168018|850007047436|835953000117|840139132117` (7,384 products),
  `09819351|MAPLE16OZ|HONEY1|645397939672` (5,449; mixes UPCs with internal codes),
  `812402000065|077234025147|068328061844|666594207944` (1,312),
  `035307016010|072992800029|755625012388|639751137323` (1,005). No human-readable names
  anywhere in PF32 samples — **"identifiers versus names" is settled as identifiers**.
- `LIVE-PAGE` product page ("Blue Tastefuls Adult Cat 7+ Chicken & Brown Rice 7 lb.",
  retrieved ~18:28Z) renders a *"You may also like"* tab with exactly 4 products whose SKUs
  are `068328061844`, `077234025147`, `666594207944`, `812402000065` (Easy Clean litter,
  Spot toy, Litter Genie, Yeowww! treat). That is **exactly the set** of PF32 sample #3
  (`812402000065|077234025147|068328061844|666594207944`), in different order. This is the
  strongest new binding in this report: a rendered cross-sell block whose membership equals
  a live PF32 identifier set.
- Counterweight (report honestly): each top PF32 value is shared verbatim by hundreds to
  thousands of products (7,384 / 5,449 / 1,312 / …; top-6 values cover ~77% of populated
  PF32). That repetition is compatible with shared default cross-sell lists; it does not
  establish pack/variant-group semantics or disprove cross-sell use. The single observed
  page cannot distinguish "PF32 feeds *You may also like*" from "both derive from the same
  native `Cross Sell Products` assignment." **PF32 semantic role: UNRESOLVED** — needs the
  Extra-Fields admin label plus one product whose native cross-sell assignment is known.
- Never write product names into PF32 (v10 `not_exported` read-only stance stands).

### 2.4 What the storefront does NOT show

- No numbered-field rendering could be traced directly in the sampled product tiles or
  product body. No render path for PF8/PF9/PF10 was identified; this does **not** establish
  that those fields are obsolete or unused elsewhere. PF1–PF15 display bindings remain
  unconfirmed. The linked `app.js`, `wl.js`, and `reviews.js` contain no `ProductFieldN`
  literals. Facet links are plain anchors; their server-side filtering behavior was not
  verified.

## 3. Full mapping table (fresh census + binding evidence)

Census: `retrievedAt 2026-10-13T18:24:05.084Z`, 22,178 rows, every tag observed on all rows
(empty tags prove slot existence only). Percentages = populated ÷ 22,178.

All numbered-field-to-facet associations below are `[INFERENCE]`, supported by local
declarations and current value correspondence, not confirmed template/server bindings.
Confidence describes the observed values and correspondence, not verified admin labels.

| Tag | Admin label | Value-backed meaning / inferred binding | Representative live values (`LIVE-XML` samples) | Population | Confidence · provenance |
|---|---|---|---|---|---|
| PF1 | UNRESOLVED (`LOCAL`: "Import Status / Flags") | Mixed operations flags and new-arrival date markers; rendering unconfirmed | `skufix032922` 3171, `needfix032922` 2742; 892 rows match `newMMDDYY` across 92 distinct markers | 21,818 (98.4%), 693 distinct, 0 piped | HIGH observed patterns `LIVE-XML`; label UNCONFIRMED |
| PF2 | UNRESOLVED (`LOCAL`: "Status Notes / Flags") | Ops/status notes; not rendered | `needfix040622` 5721, `Discontinued` 2917, `sold0920` 682, `classified101126` 72 | 10,827 (48.8%), 142 distinct, 10 piped | HIGH values `LIVE-XML`; label UNCONFIRMED |
| PF3 | UNRESOLVED (`LOCAL`: "Vendor / Legacy Code") | Sparse fragments; meaning unclear | `BCI` 11, `Wood Pellets` 9, `x` 8, `Mulch` 7, `Stone` 6, `Loam` 4 | 47 (0.2%), 8 distinct | LOW — near-empty, `INFER` only |
| PF4 | UNRESOLVED (`LOCAL`: "Size Abbreviation (S/M/L)") | Single-letter codes; `F`/`H` don't fit size-only reading | `M` 1706, `F` 447, `S` 122, `H` 30 | 2,312 (10.4%), 9 distinct | MEDIUM values; label UNCONFIRMED |
| PF5 | UNRESOLVED (`LOCAL`: "Pricing Display Promo Text") | Promo callouts; render path unconfirmed | `See Low Price In Cart` 1529, `2 for $40` 80, `New!` 15 | 1,735 (7.8%), 42 distinct | MEDIUM-HIGH values; rendering `INFER` |
| PF6 | UNRESOLVED (`LOCAL`: "Special Promo Flag") | Boolean flag | `yes` ×1318 (sole value) | 1,318 (5.9%), 1 distinct | HIGH boolean; label UNCONFIRMED |
| PF7 | UNRESOLVED (`LOCAL`: "Packaging Size / Weight") | Pack size/weight text | `4 lb.` 129, `12 lb.` 74, `Large` 43, `Medium` 42 | 1,892 (8.5%), 413 distinct | MEDIUM-HIGH values; label UNCONFIRMED |
| PF8 | UNRESOLVED (`LOCAL`: "Ingredients & Nutritional Info") | Mixed HTML/prose content; rendering unconfirmed | instructions/size/odor-removal prose; `Instructions\|…`, `Size\|…` tab separators | 101 (0.5%), 58 distinct, 45 piped | HIGH observed content; v10 `not_exported` is LOCAL policy |
| PF9 | UNRESOLVED (`LOCAL`: "Feeding Instructions") | Mixed HTML/prose content; rendering unconfirmed | `FAQ\|…`, ingredient lists, `Feeding Instructions\|…`, `None` | 89 (0.4%), 68 distinct, 35 piped | HIGH observed content; obsolescence not established |
| PF10 | UNRESOLVED (`LOCAL`: "Storage & Usage Instructions") | One storage sentence (×54) + `Y`/`N` flags; mixed use | storage sentence 54, `Y` 20, `How to Use\|…` 3, `N` 2 | 80 (0.4%), 5 distinct | HIGH mixed-use |
| PF11 | UNRESOLVED (`LOCAL`: "Featured Flag") | Boolean flag | `yes` ×699 | 699 (3.2%), 1 distinct | HIGH boolean; label UNCONFIRMED |
| PF12 | UNRESOLVED (`LOCAL`: "Stock Availability Status") | Availability flag, distinct from native `<Availability>` | `yes` 12694, `YES` 18, `out of stock` 1 | 12,713 (57.3%), 3 distinct | HIGH values; binding UNCONFIRMED |
| PF13 | UNRESOLVED (no `LOCAL` label; v10 projection slot) | Live-empty; populating = new live data | — | 0 (0.0%) | HIGH empty `LIVE-XML` |
| PF14 | UNRESOLVED (no `LOCAL` label; v10 projection slot) | Live-empty; populating = new live data | — | 0 (0.0%) | HIGH empty `LIVE-XML` |
| PF15 | UNRESOLVED (`LOCAL`: "Gift Wrap Eligible Flag") | Boolean flag | `yes` 1823, `YES` 1 | 1,824 (8.2%), 2 distinct | HIGH boolean; label UNCONFIRMED |
| PF16 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Brand") | Brand-facet correspondence (`brand[]`); numbered binding unconfirmed | `Kong` 462 + `KONG` 366, `Bay State P&G` 323, `Blue` 287, `Instinct` 272 | 15,468 (69.7%), 1004 distinct, 97 piped | HIGH value correspondence; normalization remains store policy |
| PF17 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Pet Type") | Pet Type/species correspondence (`pettype[]`) | `Dog` 5042 + `dog` 2408, `Cat` 878 + `cat` 511, `Wild Bird` 374, `Horse` 327 | 11,264 (50.8%), 69 distinct, 511 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF18 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Lifestage") | Lifestage correspondence (`lifestage[]`) | `Adult` 932, `Adult\|All Life Stages` 544, `adult` 262, `Puppy` 198, `Kitten` 31 | 2,101 (9.5%), 14 distinct, 547 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF19 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Pet Size") | Pet Size/breed-size correspondence (`petsize[]`); v10 locally retires its mapping | `All Breeds` 1224, `Small Breed` 95, `Large Breed` 78, stray `Adult` 15 | 1,445 (6.5%), 14 distinct, 13 piped | HIGH observed values; export-policy change requires review |
| PF20 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Special Diet") | Special Diet correspondence | `Grain-Free` 954 + `grain-free` 187, `No Corn, Wheat or Soy` 401, typos `Gain-Free`, `Grian-Free` 40 | 1,844 (8.3%), 24 distinct, 163 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF21 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Health Feature") | Health Feature correspondence | `High Protein` 92, `Weight Management` 67, `Digestive Health` 37, `Teething` 29, `Dental` 20 | 410 (1.8%), 44 distinct, 57 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF22 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Food Form") | Food Form correspondence (`foodform[]`) | `Dry Food` 1314, `Treat` 906, `Wet Food` 486, `dry food` 357, `Frozen Raw` 156 | 4,263 (19.2%), 56 distinct, 23 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF23 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Flavor") | Flavor correspondence | `Chicken` 776 + `chicken` 343, `Beef` 302 + `beef` 227, `Lamb` 197, `Turkey` 154 | 3,961 (17.9%), 372 distinct, 748 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF24 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Category") | Category correspondence; PF31 also contains category values (§2.2) | `Dog Food` 1771, `Dog Supplies` 1395, `Dog Treats` 987, `dog supplies` 808, `Household` 778 | 13,019 (58.7%), 131 distinct, 652 piped | HIGH observed values; PF24-versus-PF31 binding unresolved |
| PF25 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Product Type") | Product Type correspondence; not necessarily the CMS Primary Product Type label | `Food` 2743, `Treats` 960, `toys` 677, `treats` 638, `Toys` 614, `food` 582 | 12,689 (57.2%), 377 distinct, 526 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF26 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Product Feature") | Product Feature correspondence | `Squeak` 84, `Catnip` 35, `Organic` 26, `Squeak\|Crinkle` 23, `Heated` 14, `Glow` 11 | 218 (1.0%), 14 distinct, 34 piped | MEDIUM-HIGH correspondence; numbered binding unconfirmed |
| PF27 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Size") | Size correspondence; v10 locally retires its mapping | `Large` 91, `Medium` 86, `Small` 73, `Wolf`/`Souper` 18, `medium` 18 | 434 (2.0%), 46 distinct, 21 piped | HIGH observed values; export-policy change requires review |
| PF28 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Material") | Material correspondence | `Rubber` 122, `Polyester` 120, `Nylon` 105, `fabric` 36, `Felt\|Rubber` 26 | 485 (2.2%), 31 distinct, 35 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF29 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Color") | Color correspondence (public swatch links) | `Assorted` 136, `blue` 58, `black` 46, `purple` 43, `Red` 39, `Brown` 34 | 911 (4.1%), 94 distinct, 101 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF30 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Facet - Packaging Type") | Packaging Type correspondence (`packagingtype[]`) | `Bag` 1693, `Can` 335, `Individual` 143, `Box` 38, `bag` 29 | 2,374 (10.7%), 22 distinct, 1 piped | HIGH value correspondence; numbered binding unconfirmed |
| PF31 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Product Category") | Live-populated category duplicate mirroring PF24 top values; NOT free | `Dog Food` 1476, `Dog Supplies` 1146, `Household` 610, `Dog Treats` 579, `Cat Food` 339 | 6,661 (30.0%), 55 distinct, 452 piped | HIGH `LIVE-XML`; "store does not use it" is FALSE |
| PF32 | CERTIFIED (2026-10-15 Extra Fields screenshot; was `LOCAL`: "Product Cross Sell") | Pipe-joined **identifier** lists (UPCs + internal codes); same-set match with rendered cross-sell block (see §2.3); exact role unresolved | §2.3 samples; top-6 values cover ~77% of populated | 20,799 (93.8%), 4055 distinct, 20,796 piped | HIGH identifiers; semantic role UNRESOLVED; read-only |

Schema note: the freshly observed Bay State export contains exactly PF1–PF32 (all 32 tags
present on all 22,178 rows; PF13/PF14 present-but-empty). This states only what Bay State's
export contains — **no ShopSite-generic field cap is asserted**; official ShopSite docs vary
by edition/version, and search results returning Manager 10-field docs describe a different
product. No PF33+ tags were observed in the fresh export's tag set.

## 4. Uncertainty and explicit unresolved slots

1. **Admin labels for PF1–PF15** — still require an authenticated read-only Extra Fields
   settings view covering those slots (the 2026-10-15 screenshot shows PF16–PF32 only).
   The authenticated CGI base-directory GET returned HTTP 500 without
   navigation; Chrome relay discovery timed out, and the installed browser's diagnostic
   advises opening Chrome with its selected profile. No authenticated settings view of
   PF1–PF15 was available. The fresh export has no `ProductFieldN` name/label tags. Every
   PF1–PF15 admin name in this table comes from LOCAL declarations, not live evidence.
   (PF16–PF32 labels: CERTIFIED 2026-10-15 — see the update note at the top of this file.)
2. **PF3/PF4 exact semantics** — too sparse/mixed to infer (PF3 47 rows of fragments; PF4
   `M/F/S/H` single letters where `F`/`H` break the size reading).
3. **PF32 semantic role** — identifiers confirmed; cross-sell-source vs. pack/group-data
   undecided (§2.3 counterweight). Do not write.
4. **PF5/PF12 render paths** — promo/availability values exist live but were not observed
   rendering in the fetched pages.
5. **PF1 policy versus observed use** — a full-census regex sweep found **892 rows**
   matching `newMMDDYY`, across **92 distinct markers**, alongside operations flags.
   Examples include `new062022` (19) and `new092625` (22). The new-product marker pattern
   therefore has live precedent; its intended assignment policy is not established by
   values alone. Do not overwrite existing operations flags as a classification action.
6. **Server-side facet filtering** — untested (filtered-URL probe hit a Cloudflare challenge);
   facet↔field correspondence is value-based, not behaviorally verified.

## 5. Precise skill amendments needed (no edits made — report only)

**FACTUAL claims needing correction** (contradicted by fresh live evidence):

- `bay-state-store/SKILL.md` — the PF24/PF25 "mostly lack these fields" statement describes
  older evidence and is not representative of this full catalog: PF24 is 58.7% populated
  and PF25 is 57.2% populated. Date and scope that observation rather than presenting it
  as current-store coverage.
- `shopsite-product-fields/references/product-field-catalog.md` §12 — "`Product Field 1`–`25`"
  and "`ProductField1`–`ProductField25`": the freshly observed Bay State export contains
  PF1–PF32. Record the Bay State–observed range as 1–32 **without asserting a
  ShopSite-generic cap of 32** — official docs vary by edition/version (and Manager-doc
  search hits describe a different product). This corrects the catalog's stated range against
  live evidence while staying inside what was observed. (`product-xml-mapping.md` Custom
  Fields row, which states no cap, is already correct — keep.)
- `src/classification/config-seeds/bay-state-pet-garden-v1.ts:21` (flagged for parent, not a
  skill): "PF31 … the store does not use it" — fresh census shows PF31 populated on 6,661
  products (30.0%). Comment is wrong (code's reserved-until-verified logic is already correct).

**STORE POLICIES needing clearer labeling, not factual correction** (legit CMS-side rules
currently worded as if live-confirmed):

- `bay-state-store/SKILL.md` — PF24/25 "category / subcategory taxonomy … must be clean":
  fine as CMS drafting policy, but "subcategory" is not the live PF25 name and `Food`/`Treats`/
  `toys` top values are not clean subcategories — label CMS-only.
- Same file — "PF16 brand, normalized … lapses as data errors": live has 1,004 distinct
  brands with systematic `Kong`/`KONG` splits, 30% empty, 97 piped multi-brand values —
  normalization is aspiration; needs a multi-brand rule; label CMS-only.
- Same file — "Taxonomy … never copy omission" + `evals/evals.json` PF24/25-clean-values
  expectation: keep as policy, tag CMS-only.
- PF1 is a multi-use slot, not exclusively a new-arrival date field: both operations flags
  and `newMMDDYY` markers exist live. Preserve the new-product rule as policy, while
  explaining existing-value ownership and prohibiting classifier-generated status markers.
- Requiring PF24/PF25 on new drafts is a store policy, not disproved by missing values in
  historical products. Keep that requirement distinct from descriptions of live coverage.
- `docs/audits/classification-mapping-audit.md` "Live label" column: relabel
  LOCAL-REGISTRY — the registry is locally curated, not live-confirmed (unchanged by this
  pass). Empty values or lack of rendering alone do not establish that a configured slot is free.
- `scripts/realign-classification-mappings.ts:42-59` `SHOP_SITE_FIELD_LABELS` header claim of
  live verification: keep values as binding hypotheses, mark provenance unverified pending §4(1).
- v10 `product-cross-sell` → "UPC List (read-only)" rename and `not_exported` stance: upheld
  by fresh evidence (identifiers, 93.8% populated) — but "UPC" alone is now too narrow
  (PF32 also carries internal codes like `MAPLE16OZ`, `HONEY1`).

## 6. Sources

- Fresh census: `local://live-productfield-census.json` (`retrievedAt 2026-10-13T18:24:05.084Z`,
  179,650,504 B, 22,178 rows). Header/negative evidence (parent): `ResponseCode`/
  `ResponseDescription` + `Products`, no `ProductFieldN` name/label tags in full XML;
  authenticated CGI base-directory GET → HTTP 500, no admin navigation or login form.
- Supplemental full-census checks: `local://live-productfield-extra-evidence.json` — PF1 has
  892 new-date-marker rows / 92 distinct markers; PF32 has three single-code rows; all
  32 numbered tags appear on all 22,178 exported Product rows.
- Live pages (GET, public, no login): `https://www.baystatepet.com/dry-cat-food.html`
  (200, 815,536 B, 2026-10-13T18:28:53Z); `https://www.baystatepet.com/dog-toys.html`
  (200, 3,461,935 B, ~18:29Z); product page via category tile link (200, 57,380 B, ~18:28Z);
  `/media/js/app.js?3` (200, 51,436 B), `/media/js/wl.js` (200, 18,649 B),
  `/media/js/reviews.js` (200, 14,053 B) — all linked from the category HTML.
- Local: `scripts/realign-classification-mappings.ts:42-59`;
  `docs/audits/classification-mapping-audit.md`; `agent://LiveAdditionalFieldMap` (cached
  2026-10-11 scout findings); `src/classification/releases/bay-state-v10/` (manifest,
  attributes, export-mappings); `src/classification/config-seeds/bay-state-pet-garden-v1.ts`.
- Skills compared: `bay-state-store/SKILL.md`,
  `shopsite-product-fields/references/product-field-catalog.md` (§12),
  `shopsite-product-fields/references/product-xml-mapping.md` (Custom Fields row — correct).
