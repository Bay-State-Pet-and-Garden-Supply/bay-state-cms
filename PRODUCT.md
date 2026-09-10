# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

ShopSite store managers, catalog curators, and e-commerce operations specialists managing Bay State Pet & Garden Supply catalog inventory, product attributes, spreadsheet onboarding, and ShopSite 15 CGI synchronization.

## Product Purpose

Bay State CMS is a standalone local content management system for ShopSite 15 stores. It bridges bulk spreadsheet product onboarding, OCR package analysis, AI-assisted product intelligence research (Agent Lab), catalog curation, Git-versioned change set promotion, and automated ShopSite XML CGI synchronization.

## Positioning

A local-first, Git-backed catalog management system with evidence-based curation and deterministic ShopSite XML sync. Unlike generic CMS tools, it preserves undocumented ShopSite product/page fields and provides full change-set auditability before publishing.

## Operating Context

Local desktop operation, handling bulk spreadsheets, web scraping extractions, high-density product data tables, image verification, AI agent runs, and ShopSite CGI XML sync pipelines.

## Capabilities and Constraints

- **Local State & Git Source of Truth:** SQLite via `bun:sqlite` for dynamic runtime state; Git CLI workspace directory for canonical catalog approval.
- **5-Stage Onboarding Pipeline:** Discovery -> Extraction -> Curation -> Review -> Promotion.
- **Product Intelligence (Agent Lab):** Bounded AI research sandbox for product attribute discovery and commerce asset verification.
- **ShopSite Integration:** XML normalizer/denormalizer preserving unknown tags, batched `db_xml.cgi` / `dbupload.cgi` syncing.
- **Security & Integrity:** Environment token auth, log redaction of passwords/tokens, strict schema validations.

## Brand Commitments

- **Brand Identity:** Bay State Pet & Garden Supply ("From big to small, we feed them all!").
- **Visual Identity:** Trusted neighborhood pet & garden supply retailer. Forest green primary brand color (`#008850`), warm/clean neutral background tone (`#f8faf7`), ultra-clean modern typography for data clarity.
- **Typography Direction:** Modern geometric sans-serif (Plus Jakarta Sans) for high legibility in dense data tables and forms; monospace (JetBrains Mono) for SKUs, hashes, and XML fields. (Explicitly avoiding `mr-eaves-modern` from the consumer site).

## Product Principles

1. **Operate First:** Frictionless task completion, high-density data legibility, fast search and keyboard affordances outrank visual fluff.
2. **Deterministic Governance:** AI agents research and propose; deterministic CMS code validates, reviews, promotes, and publishes.
3. **Auditability & Integrity:** Every catalog change is backed by Git commits and evidence trails.
4. **Clean Brand Presence:** Professional, state-of-the-art admin interface grounded in Bay State's signature forest green brand palette.
