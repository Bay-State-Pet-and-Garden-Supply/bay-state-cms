# Tech Stack — Bay State CMS

> Exhaustive scan 2026-08-19 — 1,076 source files (~80k lines), 27 ADRs, 120+ test suites. Inferred draft replaced by `map-codebase`.

## Stack

| Layer | Tech | Version / Notes |
|-------|------|-----------------|
| Runtime | Bun | 1.3.5 (`packageManager: bun@1.3.5`), TypeScript 5.9, `tsc --noEmit --skipLibCheck` |
| Backend | Hono 4 | `src/server` — `serve({ fetch: app.fetch, port:3030, hostname:127.0.0.1 })` |
| Frontend | React 19 + Vite 6 | `src/client` SPA (`App.tsx`, `main.tsx`), `@vitejs/plugin-react` |
| DB | SQLite | `bun:sqlite` + 30+ repositories (`src/db/repositories/*-repo.ts` + `store-manager-*-repo.ts`) |
| Canonical | Git CLI | Workspace dir (`workspaces/`) — approved catalog truth, every approval → commit |
| Schemas | Zod 4 + TypeBox 1.3.7 | `src/shared/schemas` (product), PI `StructuredSubmissionSchema` + TypeBox mirror |
| ShopSite | CGI adapter | `db_xml.cgi` / `dbupload.cgi` / `dbmake.cgi` / `generate.cgi` — `product-codec.ts` (`ShopSiteProductCodec.decode`/`encode`, owns unknown-field preservation) + `xml-builder.ts` (thin delegate) + `shopsite-http-client.ts`, `multipart-upload.ts` (redaction), `zip-generator.ts`, Basic auth v1 |
| Scraping | Crawlee 3 + Playwright 1.58 + Camoufox-js + Cheerio 1 | `src/extraction-worker/server.ts` (separate worker, `preload/crawlee-storage.mjs`), `src/onboarding/extraction/`, `src/shopsite/page-*.ts`, `sharp` for images |
| AI — routing | `src/ai` | `model-registry.ts` + `provider-registry.ts` + `provider-connections.ts` + `inference-dispatcher.ts` + `network-transport.ts` + `local-runtime-coordinator.ts` + `evals/*-scorer.ts` |
| AI — VLM OCR | Ollama native `/api/chat` | `src/onboarding/vlm-client.ts` + `cloud-vlm-client.ts`, `api_keys.service='ollama_vlm'`, `qwen2.5vl:latest` |
| Onboarding | Pipeline | `src/onboarding/{job-queue,product-curator,draft-promoter,sourcing,discovery,extraction,normalization}` + `src/classification/stages/*` (ADR 0004 replaceable stages) |
| Classification | Cohort + stages | `src/classification/{stages,taxonomy,releases/bay-state-v3+v4,curation,benchmarks,embedding,config-store}` — Attribute Profiles, Product Types, Category Page identity (ADR 0005) |
| Tests | Vitest 3 + bun:test | `vitest.config.ts` (`include: src/tests/**/*.test.ts`, 30+ DB suites excluded → `test:db`), `bun run test` = `vitest run && bun run test:db` (150+ suites) |
| Lint | ESLint 9 + typescript-eslint 8 | `eslint.config.mjs` |
| Design | DESIGN.md "The General Store" | Uniform Green #14532D / Burgundy #760C19 / Gold #F6DB12, Arvo + Inter + JetBrains Mono, soft shadows |

## Architecture — modules & relationships

```
src/server (app.ts, routes/*, middleware/*, services/*)
  ↕ Hono routes ↔ src/db/repositories/* ↔ SQLite (bun:sqlite)
  ↕ Git workspaces (src/git, src/db/repositories/workspace-repo) ↔ src/shopsite (XML ↔ CGI)
  ↕ src/shared/schemas (Zod) shared client+server
  ↕ src/validation (change-set + product)
src/client (App.tsx → components/*: Catalog, PipelineBoard, Settings, onboarding/*, store-manager/*, profile-builder/*)
  ↕ fetch api.ts ↔ src/server/routes
src/onboarding
  job-queue → sourcing engine (src/onboarding/sourcing/{engine,generations,proofing,scrapers: bradley/central_pet/orgill/pet_food_experts/phillips_storefront,html-scraper/session-runner})
          → discovery (source-discovery, sitemap-fetcher/matcher, sitemap-health-evaluator, local-brand-url-finder, domain-config-service, brand-inferrer)
          → extraction (page-extractor, extraction-validator, profile-generator/promoter/governance, extractor-profiles)
          → curation (product-curator orchestrator + classification/stages/*: name-consolidation, primary-product-type, attribute-*, category-page-proposals, evidence-extraction)
          → review (onboarding-review-repo, onboarding-work-state) → draft-promoter (product_pages rows)
  VLM: packaging-ocr ↔ vlm-client / cloud-vlm-client ↔ Ollama
src/classification (1,000+ lines catalog-* + curation + releases/bay-state-v3+v4 + stages/*) — cohort-centric, type-first (ADR 0013), taxonomy freeze (v3/v4 manifests)
<!-- ADR-0030 (2026-08): src/product-intelligence/** (Agent Lab / PI) DELETED. Salvage homes:
  image verification/rights → src/onboarding/image-verification/ (deterministic network gate, no policy runtime)
  imported-result gate → src/onboarding/imported-result-gate.ts (retired in Phase 4 with the pi_* tables)
  SSRF classifier → src/shared/ssrf.ts; Wilson interval → src/onboarding/ocr-eval/stats.ts
  extraction ladder layers 1–4 → src/onboarding/extraction-ladder/ (unwired; see ADR-0030)
  slim live repos: onboarding-pi-asset-repo + image-reuse-policy-repo (tables product_intelligence_assets, pi_reuse_policies kept)
-->
src/ai (provider-registry/model-registry/inference-dispatcher/local-runtime-coordinator/network-transport) + src/benchmarks
src/store-manager (flags + tool-registry + event-worker + scheduler + playbook-*) — ops console (ADRs 0015, 0018)
src/db (30+ repos: onboarding-*, classification-*, pi-*, benchmark, brand, drift, change-set, audit-log, api-key)
src/extraction-worker (standalone Node — Crawlee + Playwright) ↔ profile-runner-client ↔ main server
```

**Key flows:**
- **CSV/Sheets import** → `onboarding/batch-repo` → Sourcing (provider-neutral, generation-scoped evidence, default-on `BAYSTATE_CMS_SOURCING_*`) → Discovery (brand official URL, sitemap + Serper cache) → Extraction (per-domain profile or distributor_record profile-free) → Curation (OCR + consolidation + classification stages → cohort) → Review drawer → Promotion (Git commit + product draft + `product_pages`).
- **Direct edit** → `change-set-repo` → validation (`product-validation.ts`, blockers/warnings) → approval → Git commit → `shopsite/publish` (Basic auth) or `export-package` zip fallback.
- ~~**Agent Lab**~~ **RETIRED (ADR-0030)** — the Pi runtime, run-service, tool registry, and `verifyImportedResultGate` promotion gate were deleted. Distributor imagery is verified by the deterministic gate in `src/onboarding/image-verification/` (`POST /api/onboarding/batches/:id/verify-distributor-imagery`).

## Commands

| Action | Command | Notes |
|--------|---------|-------|
| Dev (API+Vite) | `bun run dev` | `bun run scripts/dev.ts` → API :3030 + Vite :5173 |
| Test | `bun run test` | `vitest run && bun run test:db` — vitest + 120+ bun:test DB suites |
| Watch | `bun run test:watch` | `vitest` |
| Unit only | `bun run test:unit` | `vitest run` |
| DB suites | `bun run test:db` | chained `bun test` of 150+ unit/DB/integration files |
| Typecheck | `bun run typecheck` | `tsc --noEmit --skipLibCheck` |
| Lint | `bun run lint` | `eslint . --ext .ts,.tsx` (~2,600 errors outside issue-17 — advisory) |
| Build | `bun run build` | `vite build && tsc --noEmit` |
| Worker dev | `bun run worker:dev` | `node --import ./preload/crawlee-storage.mjs --import tsx src/extraction-worker/server.ts` |
| Worker start | `bun run worker:start` | `node --import ./preload/crawlee-storage.mjs dist/extraction-worker/server.js` |
| Verify | `bash scripts/verify.sh` | wrapper over typecheck + tests |
| Release integrity | `bun run classification:integrity` | `scripts/classification-integrity.ts` |

## Config & env

- `PORT`/`HOST` (server), `BAYSTATE_CMS_API_TOKEN` (mutating auth), `BAYSTATE_CMS_SOURCING_ENABLED`/`BAYSTATE_CMS_SOURCING_MODE` (observe/manual/automatic, default-on), `BAYSTATE_CMS_OCR_KILL_SWITCH` (alias `BAYSTATE_CMS_PI_KILL_SWITCH`, deprecated until next release cycle), `api_keys.service='ollama_vlm'` for VLM.
- Gitignored secrets: `.baystate-cms-dev-token`, `.env`, `*.db*`, `workspaces/`, `storage/`, `exports/`, `.recent-workspaces.json`.

## Infra & CI

- **CI:** `.github/workflows/ci.yml` — `push: [main]` + `pull_request` — `oven-sh/setup-bun@v2@1.3.5` → `bun install --frozen-lockfile` → `typecheck` → `vitest run` → `test:db` — 30 min timeout. Lint intentionally excluded (debt tracked in `docs/adr` + review handoff).
- **Scripts:** `scripts/dev.ts`, `scripts/verify.sh`, `scripts/validate-specs-yaml.sh` + `bp-yaml-set.sh` (copied from bigpowers for `specs/` YAML gates), `scripts/sourcing-live-smoke.ts`, `scripts/classification-integrity.ts`.
- **ADRs:** 28 (`docs/adr/0001–0029`) — sourcing (0014), PI boundary (0010), cohort curation (0013), replaceable stages (0004), page identity (0005), brand resolution (0017), specialist registry (0018), batch intelligence (0021), evals/shadow/rollout/legacy-migration (0029, #60).

## Gray areas & debt

- **ShopSite XML** partial/undocumented — unknown fields MUST be preserved (`ShopSiteProductCodec` in `src/shopsite/product-codec.ts` + `src/tests/unit/shopsite-normalizer.test.ts`).
- **Lint debt** ~2,600 errors outside issue-17 — CI skips lint; do not gate unrelated work on lint.
- **Classification releases** bay-state-v3/v4 snapshots in `src/classification/releases` + `snapshots/` — frozen manifests; new taxonomy goes via `config-loader` + `config-store`.
- **Sourcing generations** — amendment B: merchandising-depth distributor images are display-only until PI-6 rights verification; promotion revalidates provenance.
- **PI shadow mode** — many suites run under flags; `local_only` denies remote models; `maxCostUsd` enforced server-side.
- **File-size** — several modules >300 lines (`product-curator`, large repos), monitored but justified.

## Entry points for agents

- **Spec:** `CONTEXT.md` (authoritative language) → `AGENTS.md` (security + arch mandates) → `specs/product/SCOPE_LATEST.yaml` + `VISION_LATEST.yaml` + `GLOSSARY_LATEST.yaml` → `specs/tech-architecture/*` → `docs/adr/*`.
- **Code:** `src/server/routes`, `src/db/repositories`, `src/shopsite/product-codec.ts`, `src/onboarding/job-queue.ts`, `src/onboarding/image-verification/*`.
- **Never:** hardcode credentials; raw SQL outside repos; drop unknown XML fields; invent taxonomy IDs in PI.
