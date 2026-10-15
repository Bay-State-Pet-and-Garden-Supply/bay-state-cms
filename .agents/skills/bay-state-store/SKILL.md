---
name: bay-state-store
description: Bay State Pet & Garden house style for ShopSite products — naming, taxonomy, brands, images, and new-product workflow. Use this skill whenever the user mentions Bay State, baystate, Pet & Garden, drafting a new product, onboarding a distributor product, checking a product against store conventions, ProductField1, ProductField16, ProductField24, ProductField25, brand normalization, new-arrival codes, or enabling products on ShopSite. Even if the user does not say "house style" explicitly, apply these conventions to any new-product or product-review task for this store.
---

# Bay State Pet & Garden Store Conventions

Use this skill when drafting, reviewing, or answering questions about **products for this store's ShopSite catalog**. It encodes the merchandising conventions observed across the store's real exports so every new product matches house style on the first pass.

This is **not** a CGI/upload skill (see `shopsite-database`), **not** a field-mechanics reference (see `shopsite-product-fields`), and **not** a page skill (see `shopsite-page-fields`). It also never touches live upload content or credentials — drafts and validation only.

## Store identity

Bay State Pet & Garden sells pet supplies (dog/cat food, treats, health: Esbilac, Greenies, Churu, RESCUE!, Standlee, Manna Pro, Instinct, Fresh News, The Missing Link, Polkadog) plus pest control and garden. SKUs are 12-digit UPCs that double as `GTIN`.

## House style for a new product draft

Apply every rule below when drafting. The reason for the rigidity is downstream: FileName feeds SEO URLs, PF24/25 feed taxonomy, and ShopSite matching keys off SKU — a malformed draft creates cleanup work on the live store.

- **Name:** `BRAND product size` — brand first, then product, then size/weight (e.g. `PET AG Esbilac Puppy Milk Replacer RTU 16 oz`). Never lead with the size.
- **SKU + GTIN:** 12-digit UPC in both `<SKU>` and `<GTIN>`. They mirror each other on this store.
- **FileName:** slugified lowercase name + `.html` (`pet-ag-esbilac-puppy-milk-replacer-rtu-16-oz.html`).
- **ProductField1:** multi-use slot — live values include operations flags (`skufix…`, `needfix…`, `instock…`, `disabled…`) alongside `newMMDDYY` new-arrival markers (892 rows in the 2026-10-13 full-catalog census). Set the `newMMDDYY` date code from the onboarding date (e.g. `new080126`) on **new** products only; never overwrite an existing PF1 value as a classification action.
- **ProductField16:** brand, normalized to distributor casing (`RESCUE!`, not `rescue!`). This normalization is CMS drafting policy, not a fact about the live catalog: the 2026-10-13 census shows 1,004 distinct PF16 values with systematic `Kong`/`KONG` splits, ~30% empty, and 97 piped multi-brand values. Never have the classifier invent or overwrite Brand; multi-brand values need an explicit rule, not silent normalization.
- **ProductField24 / ProductField25:** category / product-type taxonomy — **required on every new product, and must be clean** (owner decisions). Live labels certified 2026-10-15 (`Facet - Category` / `Facet - Product Type`; see `docs/audits/extra-fields-certification-2026-10-15.md`). The live taxonomy is known-messy, so existing PF24/25 values on sibling products are evidence of the mess, never precedent: always derive the correct category/product type from the product itself, and propose clean values even when they differ from what similar products carry. This is store drafting policy, not live-confirmed labeling: the 2026-10-13 full-catalog census shows PF24 58.7% / PF25 57.2% populated with live `Food`/`Treats`/`toys` values that are not clean subcategories.
- **ProductOnPages:** assign only pages from the store's defined page list (211 pages in the ShopSite pages table) — page names are **not free text**. Every assigned name must match a real page `Name` exactly; never invent one. Validate against `references/store-pages.md` (bootstrap list harvested from real exports + fixture — partial, not authoritative); anything not on that list must be verified against verified-options before use. For the full 211-page list, run POST `/pages/import/download` (`dbname=pages`) → preview → activate, then read `GET /pages/verified-options`. Emit uses the modern `<ProductOnPages><PageLink><Name>` layout (see `shopsite-product-fields`).
- **SearchKeywords:** `Name, breadcrumb path` (e.g. `RESCUE! Reusable Yellowjacket Trap, Mosquito, Paper wasp, Pest Control, Pest Control & Animal Repellents`).
- **Images:** primary in a `brand/` subdirectory (`rescue/rescue-reusable-yellowjacket-trap.jpg`); additional images as numbered sequences (`-2.jpg`, `-3.jpg`, … → `MoreInfoImage1`–`N`).
- **New products ship disabled:** `<ProductDisabled>checked</ProductDisabled>`. The owner enables products manually on ShopSite after reviewing them there — never draft or flip a product to enabled.
- **Observed safe defaults:** `<MinimumQuantity>0</MinimumQuantity>`, `<ProductType>Tangible</ProductType>`, `<Taxable>checked</Taxable>`. Keep them unless the product says otherwise.

## Taxonomy improvement mandate

The live taxonomy is known-messy — treat all existing category data (PF24/25 values, ProductOnPages assignments, page names) as suspect, never as ground truth. When drafting or reviewing:
- Derive PF24/25 from the product itself; propose clean values even when siblings disagree.
- Flag incoherent taxonomy found on existing products as review notes (the owner fixes live data separately).
- Page-tree redesign (merges, renames, dead pages) is out of scope for now — improve values within the existing structure.

## Known open question — do not enforce either way

- **Availability values** (`instock` vs `in_stock`): all 26 real-export products use `instock`; `in_stock` appears only in test fixtures. Whether ShopSite actually consumes this field is unresolved. Mention the discrepancy when asked, but do not fail validation over it. Ground truth is obtainable via a full-catalog `db_xml.cgi` download on any sync — prefer that over guessing.

## Validation checklist (new or distributor products)

1. Name matches `BRAND product size`; FileName is its slug.
2. SKU/GTIN are matching 12-digit UPCs.
3. PF16 brand correctly cased; PF24/25 present **and coherent** on new drafts (fail if missing; propose clean values when siblings disagree rather than copying them). PF1 `newMMDDYY` on new products only — never overwrite an existing PF1 operations value.
4. Every ProductOnPages name exists in the defined ShopSite page list (fail on unknown names; propose the right existing page, do not copy messy existing assignments).
5. SearchKeywords follow the `Name, breadcrumb` pattern.
6. Images in `brand/` paths with clean `-N` sequences.
7. `ProductDisabled` is `checked` (new drafts must never be pre-enabled).
8. Report Availability discrepancies as notes, not failures.

## Response structure

1. **Draft or verdict** — the product XML (or pass/fail per checklist item)
2. **Fixes applied** — what was normalized and why
3. **Open items** — anything needing the owner's eye (usually taxonomy proposals and the ShopSite review-before-enable step)

## Test prompts

See `evals/evals.json` for the standing evaluation set: a house-style draft task, a convention-violation review, and a taxonomy question.
