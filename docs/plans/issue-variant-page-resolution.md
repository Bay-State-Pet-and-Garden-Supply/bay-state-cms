> [!NOTE] Superseded by Onboarding Hardening Plan M6 — see `docs/plans/onboarding-hardening-plan.md`.
> **Historical / partially implemented:** Variant extraction architecture here is superseded. Hash-stability assertions now live in characterization tests `src/tests/unit/variant-resolution-schema.test.ts`, `src/tests/unit/curation-cohort-repo.test.ts`, `src/tests/unit/onboarding-variant-resolution-repo.test.ts`, and `src/tests/integration/onboarding-betterbone-variant-flow.test.ts`. See also `src/db/repositories/curation-cohort-repo.ts:computeExtractionHash` and `src/shared/schemas/variant-resolution.ts:computeIdentityMatrixHash`.
> [!NOTE] ADR 0043 supersedes all price-related requirements in this plan. Variant matching uses identity evidence only; never extract or apply a page price.

## Problem

During Discovery and Official URL selection, the domain sitemap is indexed successfully and a relevant product page is selected. However, when a brand storefront groups multiple product variants (sizes, flavors, densities, colors, pack counts) onto a **single base product page URL** (e.g. `https://betterbone.com/products/the-betterbone-beef` or `https://brand.com/products/chew-toy`), extraction fails to target the specific variant required by the onboarding item.

### Real-World Failure Pattern
1. **Base URL Sharing**: Multiple variant items in an onboarding batch (e.g. `BetterBone Hard Beef SM`, `BetterBone Hard Beef LG`, `BetterBone Hard Beef MINI`) all match and bind to the identical base page URL.
2. **Default Variant Extraction**: When the page extractor runs against the base URL, it extracts whatever variant the storefront displays by default on initial page load (or the first variant in the markup/JSON).
3. **Payload Mismatch**: The resulting extraction data contains the title, hero image, dimensions, and specifications of the default variant rather than the item's actual size/flavor variant.
4. **Cohort Drift**: Sibling items in the same cohort extract identical default attributes, requiring manual overrides or falling back to raw register names.

---

## Current Architecture & Gaps

1. **Discovery & URL Scoring (`src/onboarding/product-discovery.ts` / `src/onboarding/sitemap-indexer.ts`)**:
   - Sitemaps and page crawling generally index base canonical URLs (`/products/<handle>`).
   - Query parameters (e.g. `?variant=123456789`, `?sku=...`) and hash fragments are often stripped or unranked.
   - When scoring URLs against an item (e.g., matching `"BetterBone Hard Beef Small"`), candidate scoring selects the base product handle but has no mechanism to resolve or attach the variant parameter.

2. **Extraction Engine (`src/onboarding/page-extractor.ts` / `src/onboarding/extraction-ladder/`)**:
   - Extractor profiles define static CSS selectors evaluated against the initial page render.
   - Non-interactive extractors (Cheerio / static fetch) cannot trigger DOM option swatches or dropdown changes.
   - While structured data (`JSON-LD`, Shopify `window.__st` / `window.ShopifyAnalytics.meta.product.variants`, or `<script id="product-json">`) often contains the full variant matrix with UPC/barcode, SKU, and variant image associations, the extraction pipeline does not parse this matrix to select the variant matching the onboarding item.

3. **Profile Builder (`src/client/components/profile-builder/`)**:
- The visual Profile Builder records selectors for title, description, and media, but lacks visual variant selector modeling (e.g., identifying option buttons, variant swatches, or variant JSON schemas).

4. **Operator Workflow / Attention Queue**:
   - When automatic variant selection is ambiguous, the operator is only offered "Verify page" or "Choose official URL", with no interactive "Select Variant" interface to pick the exact variant from the page.

---

## Proposed Architecture & Solution

### 1. Structured Variant Extraction & Matching (Platform & JSON-LD Layer)
- **Parse Embedded Variant Matrices**: Before or alongside DOM CSS evaluation, parse structured data on the page:
  - **JSON-LD**: Extract `@type: "ProductGroup"` or `Product` schemas with `hasVariant` / `offers` arrays containing `gtin12`/`upc`, `sku`, `name`, `image`, `weight`, and `additionalProperty` (Option combinations). Page prices are excluded by ADR 0043.
  - **E-Commerce Platform Feeds**: Detect common platform patterns (Shopify `/products/<handle>.json` / `meta.product.variants`, WooCommerce `data-product_variations`, BigCommerce `bcData`, Magento swatch config).
- **Item-to-Variant Resolution**:
  - Exact match on **UPC / Barcode** or **Manufacturer Part Number / SKU**.
  - Secondary match on **Variant Attribute Dimensions** (e.g. Size: "Small", Flavor: "Beef", Density: "Hard") against the variant option map (`options: ["Small", "Beef"]`).
- **Targeted Payload Composition**: Reconstruct the extraction payload specifically for the matched variant (variant title, variant-specific image URL, variant weight, variant SKU).

### 2. Variant-Aware URL Deep-Linking in Discovery
- During Discovery candidate search, when an official page has known variants (from sitemaps, structured data, or product JSON feeds), score and generate variant deep links (e.g., `https://brand.com/products/handle?variant=4123456789`).
- Allow sibling items in a batch to bind to distinct variant deep links on the same domain.

### 3. Interactive Variant Selection in Headless Browser (Profile Builder / Playwright)
- Support variant interactive actions in extractor profiles:
  - Selector for Option 1 (e.g., Size buttons), Option 2 (Flavor dropdown), Option 3 (Density/Color swatches).
  - Headless Playwright clicks/selects the matching options based on the item's extracted attributes prior to evaluating field selectors.

### 4. Operator "Choose Variant" Modal in Attention Queue & Review Workspace
- When an official URL contains multiple variants and automated resolution cannot reach high confidence:
  - Surface a `choose_variant` attention action in the Needs Attention queue.
-  Present a modal listing all detected variants on the page (Option Name, SKU, UPC/Barcode, Image thumbnail). The onboarding price is shown unchanged and cannot be selected from the page.
  - 1-click operator selection immediately binds the chosen variant ID/data to the item and extracts without requiring manual profile re-authoring.

---

## Acceptance Criteria

- [ ] Multi-variant product pages extract the specific variant matching the onboarding item's UPC, SKU, or attributes rather than defaulting to the first variant.
- [ ] Structured data (`JSON-LD` `hasVariant`/`offers`, Shopify/WooCommerce variant arrays) is parsed and matched on UPC/SKU/Options before falling back to generic DOM scraping.
- [ ] Variant-specific images (e.g., Small vs Large packaging photos, Beef vs Veggie colorways) are correctly resolved for the targeted variant.
- [ ] Discovery supports generating and attaching variant deep-link parameters (`?variant=...`) when variant sitemaps or feeds are available.
- [ ] Needs Attention queue surfaces a "Choose Variant" action when a multi-variant page cannot be disambiguated automatically.
- [ ] Add unit and integration tests covering multi-variant page fixtures (Shopify multi-variant JSON, JSON-LD ProductGroup, and option swatch DOM structures).

---

## Relevant Code & Surfaces

- `src/onboarding/product-discovery.ts` — Discovery candidate scoring and URL matching.
- `src/onboarding/page-extractor.ts` — HTML & DOM page extraction orchestrator.
- `src/onboarding/extraction-ladder/ladder.ts` — Extraction ladder platform detectors and parsers.
- `src/onboarding/extraction-ladder/platforms.ts` — Platform-specific metadata extractors (Shopify, JSON-LD, Microdata).
- `src/onboarding/extractor-profile-builder.ts` & `src/client/components/profile-builder/` — Profile Builder & selector generation.
- `src/client/components/onboarding/attention/` — Operator attention actions and resolution workspaces.
