# ADR 0032: Deprecating SERP API and Migrating Fully to Indexed Sitemaps & Local Brand URL Indexing

**Status:** Accepted (2026-09-01)  
**Supersedes:** Legacy SERP / Serper Search Architecture  
**Related:** ADR 0007 (Item-Centric Onboarding Pipeline), ADR 0017 (Brand Resolution & Source Authority), ADR 0030 (Agent Lab Decommission)

## Context

Historically, the onboarding discovery stage depended on external search engines (such as Serper / Google Search API) to resolve candidate product URLs from item metadata (UPC, SKU, brand hint, raw name). This approach had several fundamental drawbacks:
1. **Recurring API costs & rate limits:** External search queries incurred ongoing financial costs and could be throttled or degraded.
2. **Non-deterministic & noisy discovery:** Web search results frequently returned irrelevant third-party marketplaces, aggregator blogs, affiliate pages, or forum threads rather than official brand product detail pages.
3. **Data privacy & outbound leakage:** Transmitting product GTINs, internal SKU numbers, and catalog names to third-party search APIs conflicted with strict enterprise data classification policies (`dataSharingPolicy: 'local_only'`).
4. **Fragility & network latency:** Synchronous outbound search queries added latency and an external failure dependency to the discovery worker.

## Decision

Bay State CMS fully deprecates all external search engines and SERP API usage across the entire platform. The application standardizes 100% on a local, two-tier indexed discovery system:

### 1. Tier 1: Local Brand URL Index (`brand_url_index`)
- Official brand domains are registered and configured by the operator in Brand Hub (`brand_sites`).
- The system synchronizes sitemaps and ingests platform product endpoints (e.g. Shopify `/products.json`) into SQLite (`brand_url_index` and FTS5 `brand_url_fts`).
- Fast local queries perform tiered matching:
  - **Tier 1 (UPC Exact):** Direct GTIN/UPC barcode match (0.95 confidence).
  - **Tier 2 (SKU Exact):** Exact SKU lookup (0.92 confidence).
  - **Tier 3 (Token Overlap & LLM Selection):** Lexical token matching and protected LLM selection over candidate URLs.
- A high-confidence match (>= 0.85) validated via a lightweight HTTP `HEAD`/`GET` check short-circuits discovery immediately, requiring zero sitemap XML parsing.

### 2. Tier 2: Sitemap Fetch & Parse (`sitemap-fetcher.ts` & `sitemap-matcher.ts`)
- On local cache misses, the system fetches the official domain's sitemap (supporting standard XML, sitemap indexes, gzipped sitemaps, robots.txt declarations, and Camoufox rendered fallback for bot-protected origins).
- Three-pass matching strategy:
  1. **UPC Exact Match:** Digits match in the URL path.
  2. **Product URL Path Filter:** Profile regex or heuristic filtering to isolate product detail pages.
  3. **Token Overlap & LLM Selection:** Name-token overlap ranking + structured LLM candidate selection.
- All candidate URLs pass through variant deep-link resolution (`variant-url-resolver.ts`) and page verification before auto-selection.

### 3. Cleanup & Deprecation Safeguards
- The legacy `serper_cache` SQLite table was dropped in migrations.
- Outdated test suite references, stale exclusion configurations in `vitest.config.ts`, and legacy Google-search-oriented LLM prompt wording are permanently removed.
- Historical `source_method` values (such as `serper_upc`, `serper_name`) are retained strictly for backward compatibility and honest display in audit logs (`Legacy web search`).
- No external search engine API keys or network requests are used anywhere in the runtime discovery pipeline.

## Consequences

- **100% Deterministic & Local Discovery:** Zero runtime external search API dependencies, zero per-item search API costs, and full compatibility with air-gapped or `local_only` data governance models.
- **Enhanced Accuracy:** Candidates are restricted strictly to operator-configured official brand domains and verified sitemap URLs, preventing third-party marketplace pollution.
- **Observability:** Discovery telemetry (`sitemap_discovery_events`, `sitemap_refresh_history`) tracks local hit rates, sitemap freshness, and domain health across all brand catalogs.
