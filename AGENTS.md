# AI Agent Guidelines (AGENTS.md)

Welcome! This document provides the necessary context and rules for AI agents working on the **Baystate CMS** project.

## Project Context
Baystate CMS is a standalone local content management system for ShopSite 15 stores.
- **Backend:** Bun + Hono API (`src/server`).
- **Frontend:** React + Vite SPA (`src/client`).
- **Local State:** SQLite via `bun:sqlite` (`src/db`).
- **Canonical Storage:** Git CLI manages the approved catalog state in a "workspace" directory.
- **Integration:** Adapter-based sync with ShopSite CGI endpoints (`db_xml.cgi`, `dbupload.cgi`, etc.).

## Security Mandates
1. **No Hardcoded Credentials:** NEVER hardcode ShopSite merchant IDs, passwords, or API tokens.
2. **Environment Variables:** Use `process.env.BAYSTATE_CMS_API_TOKEN` for server-side mutating request authentication.
3. **Sensitive Files:** Ensure files like `.baystate-cms-dev-token`, `.env`, and database files containing secrets are ignored by Git.
4. **Log Redaction:** When logging or displaying ShopSite communication, always redact passwords and sensitive identifiers using `src/shopsite/multipart-upload.ts` or similar sanitization patterns.

## Architectural Guidelines
1. **Database Interactions:** Use the repository pattern located in `src/db/repositories`. Avoid direct SQL queries outside of these repositories.
2. **ShopSite XML:** Use `src/shopsite/xml-builder.ts` for generating XML and `src/shopsite/product-parser.ts` for parsing. Preserving unknown fields is a core requirement—always use the established normalizer/denormalizer patterns.
3. **Git Workspaces:** The system treats a Git repository as the source of truth for the catalog. All approved changes must be committed to Git.
4. **Shared Schemas:** Use Zod schemas in `src/shared/schemas` for data validation across both frontend and backend.

## Development & Testing Commands
- `bun run dev`: Starts the API server and Vite dev server.
- `bun run test`: Runs the Vitest suite.
- `bun run typecheck`: Runs TypeScript compiler checks.
- `bun run lint`: Runs ESLint for code style enforcement.

## Working with ShopSite
ShopSite's XML schema is complex and often undocumented. When adding support for new fields:
1. Identify the field name from a `db_xml.cgi` export.
2. Update the Zod schemas in `src/shared/schemas/product.ts`.
3. Update `src/shopsite/product-normalizer.ts` and `src/shopsite/product-denormalizer.ts`.
4. Add unit tests in `src/tests/unit/shopsite-normalizer.test.ts`.

## Onboarding Pipeline & Curation Stage
Six stages: Sourcing → Discovery → Extraction → Curation → Review → Promotion. See `CONTEXT.md` for authoritative domain model, stage terminology, and sourcing modes.

- **Sourcing:** `src/onboarding/sourcing/` — DEFAULT ON, `sourcing_entry_policy_version = 1` (marker-v0 legacy rows never claimed). Generation-scoped evidence, hard-conflict resolution, projection qualification; routes: evidence→Discovery, fallbacks, qualified `distributor_record→extraction` (skips Discovery, URL-null), never to Curation. Modes: observe/manual/automatic. See CONTEXT.md Sourcing + `docs/runbooks/sourcing-engine-rollout.md`.
- **Discovery / Extraction:** Brand Hub domains (`src/onboarding/brand-hub/`), extractor profiles per domain (`src/onboarding/extraction-ladder/` via `page-extractor.ts`). `distributor_record` skips Discovery (Amendment B).
- **Curation → Review → Promotion:** Cohort-aware 7-stage pipeline (`src/classification/stages/*` via `product-curator.ts`) → durable review (`onboarding_review_state`) → `draft-promoter.ts`.

### Extractor Profiles (Profile Builder)
- Official-page extraction requires an **extractor profile** per domain (CSS selectors for title, description, images). Distributor-record materialization (Amendment B) is profile-free: merchandising-depth, URL-null, zero fetch/profile/OCR/model/image — a profile is never required for `distributor_record` sources.
- **Build tab** (default): Enter a product URL, load the page, then use 🖱️ **Visually Select** buttons to click on elements in a live browser — the system generates stable CSS selectors automatically.
- **Review tab**: See proposed selectors, preview extraction results, approve/reject per field.
- **Advanced tab**: Contains the deprecated AI-generated proposal feature (unreliable for complex pages).
- Access from: **Settings → Profiles tab → Domain Configuration → "Open Profile Builder"**, or via the **"⚠ Profile required" badge** on items in the Pipeline Board extraction stage.

### Vision-Language Models (VLM OCR)
- Local VLMs (e.g. `qwen2.5vl:latest`) are used to run text OCR on the product's primary package image.
- Configure local VLM settings in the `api_keys` table under the service name `'ollama_vlm'`.
- The native Ollama `/api/chat` API is invoked via `src/onboarding/vlm-client.ts`.

### Curation Architecture
- **Curator Orchestrator:** `src/onboarding/product-curator.ts` is the cohort-aware orchestrator that composes the 7 replaceable stages (`src/classification/stages/*`) and enforces frozen-vs-live snapshot discipline (`src/classification/runtime-snapshot.ts`) (ADR 0004, ADR 0013).
- **Worker Queue:** `src/onboarding/job-queue.ts` polls pending items and dispatches cohorts/items per flags; see `CONTEXT.md` for stage transitions.
- **Draft Promoter:** `src/onboarding/draft-promoter.ts` reads the item's curation data to set product draft names and assign `product_pages` db rows.

### Reference
- See `CONTEXT.md` for the authoritative domain model and precise terminology for all pipeline stages, entities, and classification concepts.
- See `docs/adr/` for architectural decision records that document design decisions for the classification system and extraction worker.

## Image Verification & Rights Provenance (relocated)

Deterministic image verification lives at `src/onboarding/image-verification/` (ADR 0030). See `CONTEXT.md` naming footnote for `product_intelligence_assets` retention.

## Agent Lab Decommissioned (ADR 0030)

Product Intelligence / Agent Lab (epic #28) removed per ADR 0030 (rollback: `pre-agent-lab-decommission`). Salvage map in ADR 0030; ladder wiring in ADR 0031.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
