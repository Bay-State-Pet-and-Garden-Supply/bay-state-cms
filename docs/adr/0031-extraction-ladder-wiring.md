# ADR 0031: Wiring the Extraction Ladder into the Onboarding Page Extractor

**Status:** Accepted (2026-08-24)
**Supersedes:** none. Price-extraction behavior described here is superseded by ADR 0043.
**Related:** ADR 0030 (Agent Lab decommission — salvaged the deterministic extraction ladder as layers 1–4, production-unwired), ADR 0009 (browser tooling lives in the extraction worker)

## Context

ADR 0030 relocated the PI-11 extraction ladder (`src/onboarding/extraction-ladder/`) but left it with zero production consumers. Meanwhile the live extractor, `src/onboarding/page-extractor.ts`, already implements layered extraction (custom CSS profile → JSON-LD → meta → microdata → heuristics) over HTTP/Playwright, and carries a **dead** Shopify in-page `productJSON` path ("deprecated, variant logic removed") whose remaining plumbing — `RawExtraction.productJSON`, `mergeExtractionLayers` variant matching — was unreachable.

The ladder contributes two things page-extractor lacks:

1. **Platform payload parsing** — embedded `__NEXT_DATA__`, Nuxt hydration state, WooCommerce Store API JSON blocks, and (network) Shopify `/products/<handle>.js` — with maintained variant/GTIN handling.
2. **Deterministic identity classification** — `classifyPageIdentity` distinguishing retrieval success from correct-product extraction, with per-status reasons.

## Decision

**Enrichment, not replacement.** The ladder runs at TWO production entry points:

1. **HTTP fast path** — `extractViaHttpDetailed` calls `applyLadderEnrichment` after its own layer merge (no-profile extractions; page-price lookups are disabled by ADR 0043).
2. **Extraction-worker profile path — the production official-page route** — `doStaticExtract` and `doRenderedExtract` (`src/extraction-worker/routes/extract.ts`) call `applyLadderEnrichment` after profile values are assembled, reusing the HTML each handler already fetched (the rendered runner ships its captured DOM back as `renderedHtml`). There is no second fetch and profile execution remains single-authority (ADR 0009). The worker's `ExtractRequest.expected.upc` — forwarded by `runProfileExtraction` from `extractProductData(..., { gtin })`, which the onboarding worker populates from `item.upc` — feeds real identity classification.

- Profile-Builder CSS profiles remain PRIMARY for domains with approved profiles; the ladder never overwrites a value any earlier layer produced.
- The ladder fills only EMPTY fields (`title`, `brand`, `description`) from structured/platform signals — including JSON-LD brands nested under `WebPage.mainEntity` graphs — recording provenance under new `ladder-*` keys. Page prices are excluded under ADR 0043.
- Platform gallery images are appended to `additionalImages` (deduped, capped at 16); plain og:image/JSON-LD image handling is untouched to avoid changing primary-image selection.
- `identityStatus` + `identityReasons` are attached additively to `ExtractionData` (new optional schema fields). They are diagnostics only — they gate nothing today.
- `extractProductData`'s `expected` accepts an optional `gtin`; the onboarding worker passes `item.upc`, enabling real exact-match identity when a platform payload affirmatively proves single-variant state.

**Dead code removed:** `RawExtraction.productJSON`, the always-null Layer 6 assignment, the Playwright-path `productJSON` variable, and all unreachable `matchedVariant` logic (variant-title enrichment, variant price override, variant featured-image selection).

**Shopify layer is opt-in.** Unlike the embedded parsers, Shopify's product `.js` endpoint requires one extra network request. Per the compatibility rule "no new network calls beyond what page-extractor already performs", `applyLadderEnrichment` parses embedded content only by default; the maintained Shopify fetch runs only when callers pass `allowShopifyProductJson: true` together with their own `fetchFn` transport (preserving whatever SSRF/policy posture the caller enforces). This replaces the dead in-page path with the ladder's maintained implementation without changing default traffic behavior.

## Compatibility guarantees

0. **Curation-hash blast radius.** `computeExtractionHash` (`src/db/repositories/curation-cohort-repo.ts`) hashes the FULL `extractionData` object, so the new `identityStatus` / `identityReasons` fields participate in evidence identity: any change to reason TEXT (not just values) rebinds an item's extraction hash and can supersede ready curation cohorts. This is intentional (identity IS evidence), but reviewers should expect hash churn on re-extraction as classification reasons evolve. If churn becomes noisy, exclude the two keys explicitly in `computeExtractionHash` — do not silently change reason wording.

1. **Additive only** — no existing `ExtractionData` field is removed or overwritten by the ladder; new schema fields default to null/[] so persisted old records remain valid.
2. **Failure isolation** — each enrichment layer runs in its own try/catch; any failure degrades to "no enrichment" and can never fail extraction. `applyLadderEnrichment` additionally honors a NEVER-THROWS contract for `data` mutations (including the identity fields): even a frozen/sealed target only degrades enrichment — the returned outcome stays authoritative.
3. **No new network by default** — zero additional requests unless `allowShopifyProductJson` is explicitly enabled.
4. **Profile execution stays singular** — approved profiles continue to execute exclusively via the extraction worker (Crawlee/Camoufox, ADR 0009). We deliberately did NOT route profiles through the ladder's static-cheerio layer-4 seam: a second execution path with different rendering semantics would produce inconsistent results for the same profile. The seam remains available for future lightweight static validation probes.
5. **Residual unenriched path (accepted):** the no-profile direct-Playwright fallback inside `extractProductData` remains UNENRICHED. It is only reachable for domains without an approved profile before the profile-required block, and enrichment there would widen the change surface without a production consumer today. It never extracts a page price; absent onboarding input remains absent from extraction data.

## Consequences

- Platform-hosted catalogs (Next.js/Nuxt/WooCommerce storefronts) now get titles, brands, descriptions, and variant-mapped galleries that heuristic parsing missed. Page prices remain excluded under ADR 0043.
- Extraction results carry machine-readable identity diagnostics, unblocking future routing (e.g., flagging `parent_product_only` pages for variant-aware handling).
- The ladder module now has a production consumer; its test suite plus the new wiring tests guard both sides of the contract.
