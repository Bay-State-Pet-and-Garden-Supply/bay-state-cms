# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Store managers are the primary users. Workflows must work for people with no prior software or AI experience; technical catalog staff are secondary users.

## Product Purpose

Bay State CMS is a local tool that helps store managers bring products in from spreadsheets, review product details and pictures, and prepare catalog changes for their ShopSite store.

## Positioning

A practical, safe catalog tool that explains each step in familiar words. The system handles its technical work behind the scenes and shows managers what needs attention before a change reaches the store.

## Operating Context

Local desktop use for spreadsheet onboarding, product review, photo checks, and preparing catalog changes for the store.

## Capabilities and Constraints

- **Local State & Git Source of Truth:** SQLite via `bun:sqlite` for dynamic runtime state; Git CLI workspace directory for canonical catalog approval.
- **5-Stage Onboarding Pipeline:** Discovery -> Extraction -> Curation -> Review -> Promotion.
- **Price Authority:** Keep the exact price entered during onboarding. Never read, validate, compare, or replace it using a third-party product page; later workflows cannot change it.
- **ShopSite Integration:** XML normalizer/denormalizer preserving unknown tags, batched `db_xml.cgi` / `dbupload.cgi` syncing.
- **Security & Integrity:** Environment token auth, log redaction of passwords/tokens, strict schema validations.

## Brand Commitments

- **Brand Identity:** Bay State Pet & Garden Supply ("From big to small, we feed them all!").
- **Visual Identity:** Trusted neighborhood pet & garden supply retailer. Forest green primary brand color (`#008850`), warm/clean neutral background tone (`#f8faf7`), ultra-clean modern typography for data clarity.
- **Typography Direction:** Modern geometric sans-serif (Plus Jakarta Sans) for high legibility in dense data tables and forms; monospace (JetBrains Mono) for SKUs, hashes, and XML fields. (Explicitly avoiding `mr-eaves-modern` from the consumer site).

## Product Principles

1. **Manager First:** Use familiar words, explain the next action and its consequence, and never require managers to understand AI, Git, syncing, or internal processing.
2. **Price Stays Fixed:** The onboarding price is the sole authority and remains unchanged in every later step.
3. **Safe Publishing:** Show proposed changes clearly and require review before they reach the store.
4. **Clean Brand Presence:** Ground the admin interface in Bay State's trusted neighborhood-store identity.
