# Issue #90 — Multi-Variant Product Page Resolution Implementation Plan

**Status:** implementation-ready plan only; no production implementation is part of this artifact  
**Planning baseline:** current `main` worktree inspected on 2026-03-11  
**Source:** GitHub issue #90 as represented by `docs/plans/issue-variant-page-resolution.md:1-68`  
**Primary owners:** Onboarding Discovery, Extraction Worker, operator work-state/API/UI  
**Delivery style:** TDD-first, one sequential writer, small reviewable milestones
> [!NOTE] ADR 0043 supersedes all price-related requirements in this plan. Variant workflows use identity and option evidence only; the onboarding price remains unchanged.

---

## 1. Goal and outcome

When several onboarding items represent variants on one official product page (for example BetterBone Hard Beef `SM`, `LG`, and `MINI`), each item must:

1. discover or synthesize its own identity-preserving deep link;
2. bind to one normalized variant using deterministic, reviewable evidence;
3. extract only that variant's identifiers, options, weight, and primary image;
4. retain product-level description/media only where the variant payload does not provide a conflicting variant-specific value;
5. stop, without copying the page's default variant, when the evidence is ambiguous; and
6. let an operator choose from the exact detected matrix without entering or trusting arbitrary variant payload data from the browser.

The system must not infer success merely because the parent page title is similar or the parent URL is official. A successful extraction requires a positive selected-variant linkage receipt.

---

## 2. The six issue acceptance criteria, made testable

The implementation must preserve the issue's six-item order and report against these stable IDs.

| ID | Issue criterion | Executable interpretation |
|---|---|---|
| **AC-1** | Multi-variant pages extract the variant matching UPC, SKU, or attributes rather than the first/default variant. | A successful extraction contains `selectedVariant.variantKey`, its identity receipt, and variant-scoped field provenance. Ambiguous/no-match matrices return a structured blocker and write no completed extraction. |
| **AC-2** | Parse JSON-LD `hasVariant`/`offers` and Shopify/Woo variant arrays; match UPC/SKU/options before generic DOM scraping. | One canonical matrix schema and matcher is shared by Discovery and the worker. Precedence is exact identifiers, then complete exact option tuple, then bounded scored evidence; DOM interaction is last and separately gated. |
| **AC-3** | Resolve variant-specific images. | The chosen variant's explicitly associated image is primary. A sibling's associated image can never be substituted. Product-level gallery images may only be appended after the selected image and are marked product-level. |
| **AC-4** | Discovery generates/attaches variant deep links from sitemaps or feeds. | Product URL identity retains `?variant=`, `?variation_id=`, `?sku=`, attribute parameters, and non-empty fragments while removing only known tracking parameters. Three BetterBone siblings resolve to three distinct source URLs. |
| **AC-5** | Needs Attention exposes **Choose Variant** when automation cannot disambiguate. | A durable unresolved resolution projects as `attentionReason/action = choose_variant`; the focus-trapped resolution workspace lists server-supplied candidates and a guarded decision route resumes Extraction. |
| **AC-6** | Unit/integration coverage for Shopify, ProductGroup, and option-swatch DOM structures. | Committed local fixtures cover BetterBone Shopify SM/LG/MINI, JSON-LD ProductGroup, Woo `data-product_variations`, large image maps, duplicate GTINs, query preservation, and a swatch DOM action plan. No test uses the public network. |

---

## 3. Governing constraints and ADR interpretation

### 3.1 ADR constraints

| Authority | Constraint applied by this plan |
|---|---|
| `docs/adr/0003-make-classification-runs-reproducible.md` | Persist parser version, canonical matrix identity hash, selected candidate key, decision origin, and evidence paths. Do not reinterpret an earlier selection with a changed matrix/parser. |
| `docs/adr/0004-compose-classification-from-replaceable-stages.md` | Variant resolution remains a replaceable pre-extraction capability. It must not leak platform branches into Curation stages. |
| `docs/adr/0008-scope-domain-extractor-profiles-to-page-structures.md` | Profiles describe page structure and optional interaction selectors, not product-specific IDs/options. A BetterBone profile remains reusable across products. |
| `docs/adr/0009-run-browser-profile-tooling-in-a-separate-worker.md` | Any click/select interaction runs only in `src/extraction-worker`, never in the Bun API or Discovery process. |
| `docs/adr/0013-cohort-centric-type-first-curation.md` | Variant resolution is member-local pre-Curation evidence. A blocked sibling remains blocked at Extraction; it must not contaminate the cohort barrier or sibling payloads. |
| `docs/adr/0024-deterministic-extraction-evidence.md` | Record exact source URL/final URL, matrix identity hash, variant key, parser version, field source paths, and source content/artifact hashes. No untraceable overwrite. |
| `docs/adr/0031-extraction-ladder-wiring.md` | Keep `applyLadderEnrichment` additive-only and no-new-network-by-default. Selected-variant materialization is a separate, explicit composition step; it does not silently turn the enrichment ladder into an overwriting layer. Shopify `.js` uses the caller's guarded transport and only under the variant-resolution rollout mode. |

If reviewers determine that an authoritative variant overlay replacing profile-derived `primaryImage` or `weight` is incompatible with ADR-0031 rather than merely outside its additive enrichment scope, **stop Milestone 4 and add an ADR-0031 amendment before code proceeds**. Prices are excluded from variant resolution; the onboarding price remains unchanged.

### 3.2 Operational and repository constraints

- Preserve the dirty worktree. Several relevant files already have unrelated edits; the implementation writer must diff every target before editing and retain those changes.
- One writer applies milestones sequentially. Do not launch concurrent writers against shared schema, migration, route, or worker files.
- Do not stage, commit, reset, clean, checkout, or restore unrelated paths. No broad `git add .` or `git add -A`.
- The issue does **not** require a catalog workspace commit. Therefore the sanctioned scoped catalog commit path is not used.
- No network or paid crawl. All tests and the BetterBone smoke cohort use local fixtures/injected transports.
- No live-DB writes during development. Migration and route tests use temporary SQLite files. Before any later production migration/activation, make and verify a backup using the deployment runbook.
- No credentials or raw authorization material in fixtures, logs, persisted candidate JSON, screenshots, or acceptance artifacts.

---

## 4. Current-state audit and review findings

### 4.1 Relevant code anchors

Line ranges are the inspected baseline; use symbols as the durable anchors if unrelated dirty-worktree edits shift them.

| Surface | Baseline range | Finding |
|---|---:|---|
| `src/onboarding/source-discovery.ts` | `140-266` | Sitemap candidates are deduped by raw string (`200-224`), then every result enters `resolveVariantsForCandidates` (`235-245`). No durable resolution summary is returned. |
| `src/onboarding/variant-url-resolver.ts` | `1-285`, `291-390` | Shopify-specific candidate types/scoring overlap the generic resolver. The claimed bounded set (`311-327`) adds all sitemap/official candidates, so it is not a hard network bound. |
| `src/onboarding/variant-resolver.ts` | `1-360` | Already parses Shopify, Woo, and JSON-LD and contains useful aliases, but uses a second incompatible candidate/result model and name-diff matcher. |
| `src/onboarding/sitemap-matcher.ts` | `34-221`, `329-370`, `452-463` | `SitemapLlmContext.variantTokens` exists but Discovery does not populate it. `extractSlug` intentionally ignores query identity. |
| `src/onboarding/sitemap-fetcher.ts` | `652-666`, `752-766` | Full URLs are retained today, but lowercasing a full URL is not the desired product identity contract and does not remove tracking-only differences. |
| `src/onboarding/sitemap-sync-service.ts` | Shopify indexing path (symbol `shopify` / `variant`) | It already indexes Shopify deep links; new code must consume them rather than invent a second index format. |
| `src/onboarding/image-utils.ts` | `127-190` (`canonicalizeUrl`) | This is image canonicalization and may strip image transforms/query data. It must never be reused for product/source URL identity. |
| `src/onboarding/extraction-ladder/enrich.ts` | `1-18`, `51-64`, `85-219`, `272-279` | `allowShopifyProductJson` defaults false and correctly requires injected fetch. `normalizeForDedupe` strips query/fragment, but is image-only and should be renamed to make misuse difficult. |
| `src/onboarding/extraction-ladder/platforms.ts` | `17-90`, Shopify helpers below `260` | Existing guarded parsing/fetch seams should be reused. The canonical variant parser must not fork yet another Shopify shape. |
| `src/onboarding/extraction-ladder/result-shape.ts` | `14-102`, `140-229` | Identity classification has `selectedVariantLinkage`, but the current data flow does not produce a cryptographic/deterministic linkage receipt. Diagnostics currently do not gate extraction. |
| `src/shared/schemas/onboarding.ts` | `240-371`, `999-1035`, `1465-1483` | Extraction supports diagnostics and profiles contain a loose variant strategy. Discovery already has `variant_resolution`/`needs_input_ambiguous` audit enums. |
| `src/shared/schemas/extraction-worker.ts` | `146-152`, `253-299` | Worker strategy/request/response schemas exist, but no selected-variant identity/matrix receipt is carried end to end. |
| `src/onboarding/profile-runner-client.ts` | `64-112` | It forwards the profile's strategy, but not a durable variant selection or structured failure code. |
| `src/extraction-worker/routes/extract.ts` | `612-666`, `681-957`, `990-1090`, `1522-1535` | `safeProfileFetch` is the required transport. Static/rendered ladder calls do not opt into Shopify `.js`. Rendered mode currently performs fragile full-name substring interaction whenever a strategy exists, without a dedicated rollout flag, and returns a generic failed result on no match. |
| `src/onboarding/page-extractor.ts` | `233-354` | Profile extraction delegates correctly to the worker, but catches only generic worker success/failure and has no selected-variant contract. |
| `src/onboarding/job-queue.ts` | `1185-1465`, `1500-1640` | Discovery suppresses ambiguous metadata from auto-selection, but Extraction retries generic failures and can complete without a positive variant receipt. |
| `src/db/onboarding-migration.sql` | `15-114` | No durable variant matrix/decision storage exists. |
| `src/db/migrations.ts` | `40-144` and end-of-file migration ledger | Additive idempotent migration pattern exists; a version marker is required. |
| `src/server/routes/onboarding-routes.ts` | `2376-2430` | Generic `select-source` and manual URL routes validate ownership, but the source body is not Zod-validated and there is no stale-safe variant decision route. |
| `src/onboarding/onboarding-work-state.ts` | `475-650` | Projection mostly derives attention from item state/error strings and has no structured unresolved-variant join. |
| `src/shared/schemas/onboarding-work-state.ts` | `94-128`, `169-235` | `choose_variant` is absent from reason/action enums and item work-state lacks a resolution summary. |
| `src/client/components/onboarding/attention/OfficialSiteResolutionWorkspace.tsx` | `1-205` and phase render branches | Existing focus-trapped drawer is the correct operator integration point. Do not add a second nested modal. |
| `src/client/components/onboarding/attention/attention-logic.ts` | `20-175` | Additive reason/action labels and consequences have a central deterministic mapping and tests. |

### 4.2 Review findings that change the implementation approach

1. **Consolidate, do not add a third resolver.** `variant-resolver.ts` and `variant-url-resolver.ts` overlap. The former becomes the canonical pure parser/matcher; the latter remains the bounded network/candidate orchestration adapter.
2. **The current fetch set is not actually bounded.** `candidates.slice(0, 3)` is followed by adding every official and sitemap candidate. Replace it with a hard cap after deterministic sort/dedupe.
3. **Duplicate GTIN is not proof.** If two candidates carry the same normalized GTIN, GTIN alone must produce `ambiguous`. A candidate may be selected only when a second independent exact identifier (trusted SKU/MPN) or a complete exact option tuple points uniquely to the same row.
4. **Do not use similarity alone to complete extraction.** Resolve only when a unique trusted identifier or complete exact option tuple selects one candidate. Page prices are never retrieved or used.
5. **`allowShopifyProductJson` must remain explicit.** Enable it only in variant observe/active modes, through injected `safeProfileFetch`, for one same-origin `.js` endpoint, with current response/time limits. Never flip its default in generic ladder callers.
6. **Image and product URL canonicalization are different.** Keep `canonicalizeUrl` in `image-utils.ts` image-only. Rename ladder's local `normalizeForDedupe` to `normalizeImageForDedupe`. Add a separate product URL identity helper with tests proving `?variant=` survives.
7. **Existing browser interaction is too permissive.** It compares the full expected name to option text by substring. First place it behind a default-off flag; later execute an exact, per-axis action plan derived from a positively selected variant. It must never guess directly from the whole item name.
8. **A source candidate row alone is not enough for durable fallback.** Extraction can discover a hidden matrix after Discovery, and operator decisions need stale-matrix protection. Add a dedicated repository-backed resolution record; do not store the only copy in opaque `metadata_json` or an error string.
9. **ADR-0031 separation matters.** Generic ladder enrichment remains additive. Variant-authoritative field composition is an explicit selected-variant step with narrow fields and provenance, not a change to the ladder's fill semantics.
10. **The old issue note names stale files.** `docs/plans/issue-variant-page-resolution.md:16-43` references `product-discovery.ts`/`sitemap-indexer.ts`; current implementation paths are those listed above. Do not create those stale paths.

---

## 5. Target contracts and fail-closed invariants

### 5.1 Canonical variant matrix

Create `src/shared/schemas/variant-resolution.ts` with strict Zod contracts (all persisted/API/worker boundaries parse these):

- `VariantPlatform`: `shopify | jsonld | woocommerce | bigcommerce | magento | unknown`.
- `VariantIdentifier`: `{ kind: gtin | sku | mpn | platform_id, value, normalizedValue, sourcePath }`.
- `VariantOption`: `{ axis, value, normalizedAxis, normalizedValue, sourcePath }`.
- `VariantImage`: `{ url, role: primary | gallery, width?, height?, sourcePath }`.
- `NormalizedVariantCandidate`: stable `variantKey`, platform ID, title, identifiers, ordered options, availability, weight, dimensions, images, deep link, and field evidence paths. It has no price field.
- `VariantMatrix`: schema/parser version, platform, canonical parent URL, source final URL/content hash, bounded candidates, and parse warnings (stable codes, no raw HTML).
- `VariantMatchInput`: expected GTIN/SKU/MPN only when independently trusted, item/register name, brand, and deterministic `variantTokens`/option hints. Price is never a matching input.
- `VariantMatchDecision`: `resolved | ambiguous | no_match | unsupported | too_many_variants | stale_selection`, ranked diagnostics, unique selected key when resolved, stable reason codes, and `matchedBy` evidence.
- `VariantSelectionReceipt`: resolution ID, identity-matrix hash, parser version, selected key, decision origin `automatic | operator`, selected deep link, and matched evidence paths.
- `VariantResolutionSummary`: client-safe persisted view with candidates, excluding raw source payload.

**Hash contract:** canonical JSON with sorted object keys; candidates sorted by `variantKey`; identifier/option arrays sorted by kind/axis/value. The **identity matrix hash** includes parser version, parent identity URL, variant keys/IDs, identifiers, options, and deep links; excludes volatile stock and image bytes. Page price data is never included in the matrix or used to invalidate a selection. Source content hash remains separate for evidence.

**Bounds:** maximum 250 normalized variants, 8 options, 12 identifiers, 32 images per variant, 2,048 characters per URL, and 512 characters per label. Overflow produces a stable unresolved status; it never truncates then auto-selects.

### 5.2 Deterministic matching contract

Implement one matcher in `src/onboarding/variant-resolver.ts` with this ordered policy:

1. Normalize GTIN by digits and checksum-valid length; normalize SKU/MPN by Unicode NFKC, trim, and case-fold without deleting meaningful punctuation.
2. A **unique exact GTIN** resolves.
3. If GTIN occurs on multiple rows, mark `duplicate_identifier`; do not resolve from GTIN alone. Resolve only if a trusted exact SKU/MPN or complete exact option tuple independently identifies one of those rows.
4. Otherwise, a **unique exact trusted SKU or MPN** resolves.
5. Otherwise, a **complete exact option tuple** resolves only when each supplied axis maps to one normalized axis and exactly one candidate matches. Size aliases (`SM ↔ small`, `LG ↔ large`, `MINI`) are versioned dictionaries; substring matching is prohibited.
6. Otherwise compute deterministic ranking from exact option tokens, explicit variant title tokens, and availability. Resolve only with an option/identifier signal, score at or above a named constant, and a named margin over runner-up. Name similarity alone remains `ambiguous` or `no_match`; page prices are never retrieved or used.
7. Unavailable candidates remain visible, but automatic selection prefers/permits them only if an exact trusted identifier proves identity; UI labels them unavailable.
8. Any tie, malformed duplicate key, conflicting identifiers, incomplete axis map, or parser disagreement fails closed.

Every reason and threshold is exported/named and unit tested. No LLM/model call participates in variant selection. The sitemap LLM may receive safe variant tokens for page ranking, but cannot manufacture a variant resolution.

### 5.3 Product URL identity contract

Create `src/onboarding/product-url-identity.ts`:

- Accept only absolute `http:`/`https:` URLs.
- Normalize scheme/hostname casing, default ports, dot segments, and query ordering.
- Remove only a versioned known tracking set (`utm_*`, `gclid`, `fbclid`, `msclkid`); preserve all unknown parameters fail-closed.
- Explicitly preserve platform identity: `variant`, `variation_id`, `sku`, `attribute_*`, `option*`, `options[...]`, and non-empty fragments.
- `buildVariantDeepLink(parent, candidate)` removes/replaces only that platform's own variant keys and retains unrelated non-tracking parameters.
- Expose two keys: `productUrlIdentityKey` (retains variant identity) and `parentProductKey` (removes only recognized variant selectors, used solely to group sibling deep links).
- Never import image `canonicalizeUrl` or ladder image-dedupe helpers.

### 5.4 Selected-variant extraction contract

A multi-variant extraction may complete only when the worker returns a receipt matching the request's resolution ID/hash/key or independently resolves a unique current candidate and returns a new receipt for persistence.

`materializeSelectedVariant` (new `src/onboarding/selected-variant-materializer.ts`) applies only these variant-authoritative fields:

- title: deterministic parent + non-default variant label; no duplicated title;
- Page prices are never extracted or included in selected-variant payloads.
- `primaryImage` and variant-associated additional images;
- `weight`, dimensions, SKU/MPN/GTIN;
- normalized `variantAttributes` option map;
- `selectedVariant` receipt and field-level source paths.

Description, brand, ingredients, and product-level gallery remain base/product fields unless the candidate explicitly contains a variant-specific value. Base profile fields may be retained in evidence but cannot overwrite explicit selected-variant values. A candidate lacking a variant-specific field leaves that field unchanged rather than copying the first sibling's field.

**Hard gate:** when a matrix has more than one real variant, no completed extraction is written without `selectedVariantLinkage = true` and a valid receipt. `identityStatus` remains diagnostic for legacy/single-variant pages; the new variant gate is explicit and does not silently change ADR-0031 diagnostic semantics.

### 5.5 Durable resolution/decision model

Add `onboarding_variant_resolutions` rather than columns on `onboarding_items`:

- `id TEXT PRIMARY KEY`
- `onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE`
- `source_url TEXT NOT NULL`
- `canonical_parent_key TEXT NOT NULL`
- `platform TEXT NOT NULL`
- `parser_version INTEGER NOT NULL`
- `identity_matrix_hash TEXT NOT NULL`
- `source_content_hash TEXT NULL`
- `status TEXT NOT NULL` (`resolved`, `ambiguous`, `no_match`, `unsupported`, `too_many_variants`, `selected`, `stale`)
- `reason_codes_json TEXT NOT NULL`
- `candidates_json TEXT NOT NULL`
- `automatic_variant_key TEXT NULL`
- `selected_variant_key TEXT NULL`
- `decision_origin TEXT NULL` (`automatic`, `operator`)
- `decided_at TEXT NULL`
- `superseded_at TEXT NULL`
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`

Indexes: item/latest, `(onboarding_item_id, identity_matrix_hash)`, and current status. Enforce one current row per item with a partial unique index on `onboarding_item_id WHERE superseded_at IS NULL` if the bundled SQLite version supports it; otherwise supersede+insert in one `IMMEDIATE` transaction and repository tests prove no two current rows.

Repository boundaries always parse JSON with the shared schemas. Never persist raw HTML, complete third-party scripts, request headers, or credentials.

### 5.6 Feature flags and rollback — deprecated/ignored (always-on follow-up)

`src/onboarding/variant-flags.ts` now always returns `active` (interaction default-off unless test override) — env `BAYSTATE_CMS_VARIANT_RESOLUTION_MODE` and `BAYSTATE_CMS_VARIANT_INTERACTION_ENABLED` are ignored; test overrides retain `off|observe` for isolated unit tests. Real rollback is revert commit `f53fcdc`/`7163062`, not env. Old binaries ignore the new table/optional JSON fields. Do not down-migrate or destroy rows during incident rollback.

---

## 6. TDD-first milestone plan

No production-code item begins until its named failing tests/fixtures are committed in the implementation branch. Within each milestone use red → smallest green → refactor → full targeted suite. Milestones are dependency ordered.

### Milestone 0 — Preserve baseline and add characterization tests

**Dependencies:** none.  
**Purpose:** lock down current additive ladder, guarded transport, source authority, and legacy behavior before refactoring.

#### 0.1 Worktree and baseline discipline

- Record `git status --short`, `git diff -- <target>` and `git diff --cached -- <target>` before each relevant edit.
- Do not modify or stage unrelated current edits in `job-queue.ts`, routes, work-state, shared schemas, or the attention workspace.
- Run the existing variant, extraction ladder, worker/profile, sitemap, work-state, and attention tests before changing code. If a baseline test fails, record it and do not “fix” unrelated behavior under #90.

#### 0.2 Characterization tests (tests first)

Modify:

- `src/tests/unit/variant-resolver.test.ts:1-end`
- `src/tests/unit/variant-url-resolver.test.ts:1-end`
- `src/tests/unit/page-extractor-variant-inference.test.ts:1-end`
- `src/tests/unit/extraction-ladder.test.ts` around Shopify opt-in and additive-only cases
- `src/tests/unit/profile-runner-client.test.ts` request forwarding cases
- `src/tests/unit/profile-runner.test.ts` static/rendered profile cases

Assert before refactor:

- generic ladder does not issue Shopify `.js` with `allowShopifyProductJson` absent/false;
- enabling it still requires the injected fetch and never calls `globalThis.fetch` behind the caller;
- existing profile selector values are not overwritten by ladder enrichment;
- current source authority permits only mapped official domains for auto-selection;
- query-bearing sitemap entries survive sitemap parsing;
- a rendered profile strategy's current behavior is captured, then explicitly changed under Milestone 5 rather than accidentally.

**Acceptance criteria:** targeted baseline command results are recorded; all failures are classified as pre-existing or introduced; zero production behavior changed.

---

### Milestone 1 — Shared contracts, flags, URL identity, fixtures, and migration

**Dependencies:** Milestone 0.

#### 1.1 Write canonical local fixtures first

Create:

- `src/tests/fixtures/variants/betterbone-shopify-product.json`
- `src/tests/fixtures/variants/betterbone-product-page.html`
- `src/tests/fixtures/variants/jsonld-product-group.html`
- `src/tests/fixtures/variants/woocommerce-product-variations.html`
- `src/tests/fixtures/variants/bigcommerce-embedded-matrix.html`
- `src/tests/fixtures/variants/magento-swatch-config.html`
- `src/tests/fixtures/variants/option-swatches.html`
- `src/tests/fixtures/variants/duplicate-gtin-shopify-product.json`
- `src/tests/fixtures/variants/large-image-map-shopify-product.json`

Fixture contracts:

- BetterBone has exactly three target variants `SM`, `LG`, `MINI`, distinct platform IDs/deep links, SKU/GTIN, grams/weight, and images. At least one parent default is deliberately **not** the requested variant.
- Duplicate-GTIN fixture has two variants sharing a GTIN and distinguishable only by SKU/options.
- Large-image fixture includes product-level images plus explicit per-variant image/`variant_ids` associations and transform queries.
- ProductGroup fixture includes `gtin12`, SKU, `variesBy`, `additionalProperty`, image, weight, and absolute variant URL; page price fields are ignored.
- Woo fixture uses HTML-escaped/single-quoted `data-product_variations` and includes `variation_id`, attributes, SKU, stock, dimensions/weight where present, and image; display prices are ignored.
- BigCommerce/Magento fixtures cover only safely embedded public matrices. No Storefront API, GraphQL, session token, or live endpoint is introduced.
- Swatch fixture has two axes and deceptive substring labels (`Small`/`Small Breed`, `Beef`/`Beef & Chicken`) to prove exact option selection.

No fixture is copied from a paid/live crawl; values are synthetic but realistic.

#### 1.2 Contract and URL tests first

Create:

- `src/tests/unit/product-url-identity.test.ts`
- `src/tests/unit/variant-resolution-schema.test.ts`
- `src/tests/unit/variant-flags.test.ts`

Tests assert:

- `?variant=SM-ID`, `?variant=LG-ID`, and `?variant=MINI-ID` remain distinct;
- parameter order and tracking-only differences dedupe, while unknown/query/hash identity does not;
- `buildVariantDeepLink` replaces an old platform variant selector without deleting non-tracking parameters;
- image `canonicalizeUrl` remains image-only and is not used by product identity;
- malformed/oversized candidate payloads fail Zod parsing;
- default/malformed flags fail closed; observe/active and test override semantics are exact.

Then create/modify:

- **Create** `src/shared/schemas/variant-resolution.ts`
- **Create** `src/onboarding/product-url-identity.ts`
- **Create** `src/onboarding/variant-flags.ts`
- **Modify** `src/onboarding/extraction-ladder/enrich.ts:107-129,272-279` only to rename `normalizeForDedupe` to `normalizeImageForDedupe` and document its image-only contract; do not alter output.

#### 1.3 Migration/repository tests first

Create:

- `src/tests/unit/onboarding-variant-resolution-migration.test.ts`
- `src/tests/unit/onboarding-variant-resolution-repo.test.ts`

Tests assert:

- fresh DB creates table, indexes, FKs, and schema marker;
- upgrade from the immediately prior schema is idempotent across two `runMigrations()` calls;
- malformed persisted JSON fails closed at repository read/write boundaries;
- supersede+insert leaves exactly one current row per item;
- stale matrix decisions cannot update a newer row;
- cascade deletes only an item's resolution rows;
- no backfill infers decisions from old `metadata_json` or error strings.

Then modify/create:

- `src/db/onboarding-migration.sql:15-114` — fresh-install table/index definitions.
- `src/db/migrations.ts` — append version marker `onboarding_variant_resolution_schema_version=1`; additive transaction only.
- **Create** `src/db/repositories/onboarding-variant-resolution-repo.ts` — repository-only SQL and schema parsing.

**Migration safety:** no destructive DDL, no rewrite/backfill of existing items, no migration-time network. Before activation on a real DB: stop writer, copy DB plus `-wal`/`-shm` safely or use SQLite backup API, run `PRAGMA quick_check` on the backup, record size/hash, then migrate. This plan authorizes no live migration.

**Acceptance criteria:** all new contract/flag/URL/migration tests pass; old DB opens with mode off; no behavior outside schemas/migration changes.

---

### Milestone 2 — Canonical parsers and deterministic matcher

**Dependencies:** Milestone 1.

#### 2.1 Red tests: parser conformance

Rewrite/extend `src/tests/unit/variant-resolver.test.ts` to run every adapter through the same conformance assertions:

- Shopify public `.js` product payload and supported embedded product JSON;
- JSON-LD `ProductGroup.hasVariant`, nested `@graph`, Product + `isVariantOf`, and offer arrays;
- WooCommerce `data-product_variations`;
- bounded BigCommerce `BCData` embedded form;
- bounded Magento `spConfig`/swatch JSON embedded form;
- malformed JSON/script, duplicate platform IDs, excessive variant count, unsupported/incomplete matrix.

Every parser must produce the same normalized candidate shape and exact source paths. JSON-LD or platform records missing a stable key are visible as warnings but cannot be auto-selected.

Implement in `src/onboarding/variant-resolver.ts:1-end`:

- replace the incompatible legacy candidate/result types with imports from the shared schema;
- retain/refactor useful alias/token helpers;
- add an ordered adapter registry with explicit detector and parser version;
- parse structured content already in memory; no network in this module;
- eliminate duplicate Shopify scoring logic from this pure core.

Update `src/onboarding/extraction-ladder/platforms.ts` to reuse/export low-level safe parsers where appropriate. Do not create circular imports: platform byte decoding/fetch helpers stay in the ladder platform module; normalized matrix adapters/matcher stay in `variant-resolver.ts`.

#### 2.2 Red tests: matching and ambiguity

Add table tests for:

- each BetterBone item uniquely resolves from its unique GTIN;
- unique trusted SKU resolves when GTIN absent;
- exact `SM`, `LG`, and `MINI` option aliases resolve correctly;
- full two/three-axis tuples resolve regardless of input order;
- incomplete one-axis input remains ambiguous when two candidates share it;
- duplicate GTIN remains ambiguous with GTIN only;
- duplicate GTIN resolves only when an independent exact trusted SKU/MPN or complete tuple selects the same candidate;
- SKU text merely appearing inside an arbitrary product name is not a trusted SKU input;
- Name similarity alone can never resolve a candidate; price is never a matching signal.
- ties, conflicts, unavailable variants, malformed keys, parser disagreements, and >250 variants fail closed;
- output ordering and diagnostics are byte-stable across input candidate ordering.

Implement named matching stages/thresholds and `deriveVariantTokens`. Token derivation must use a versioned exact alias/measurement parser and product/brand stopwords; do not treat arbitrary leftovers from the full product name as authoritative options.

#### 2.3 Adapter boundary/non-goals

BigCommerce/Magento support in this issue is limited to complete public matrices already embedded in fetched HTML. Incomplete detections return `unsupported`/`no_matrix`; they do not trigger storefront APIs, GraphQL, cookies, cart operations, or additional credentials. This preserves a bounded adapter seam without widening MVP network scope.

**Acceptance criteria:** one canonical matrix/matcher serves all implemented adapters; duplicate GTIN cannot auto-select; parser/matcher tests use only fixtures and pass deterministically.

---

### Milestone 3 — Variant-aware Discovery and query-preserving identity

**Dependencies:** Milestones 1-2.

#### 3.1 Red tests: bounded resolver orchestration

Rewrite/extend `src/tests/unit/variant-url-resolver.test.ts` and add `src/tests/unit/source-discovery-variant-resolution.test.ts`.

Assert:

- a hard `MAX_VARIANT_PARENT_FETCHES = 3` after sorting by confidence desc, official-domain status, then product identity key;
- already deep-linked candidates are retained without parent re-fetch when metadata is sufficient;
- only exact/subdomain matches of configured official domains are eligible for variant feed fetch and auto-resolution;
- duplicate parent URLs/tracking variants consume one budget slot;
- fetch uses only injected transport, timeout, redirect/domain policy, and 5 MB limit;
- HTTP/malformed/timeout failures degrade to the original candidate and stable diagnostics, not a Discovery crash;
- Shopify `.js` is fetched at most once for a selected parent and only in observe/active mode;
- three BetterBone calls return three distinct deep links and each candidate carries validated resolution metadata;
- ambiguous candidate expansion is bounded to 250 and is never auto-selected;
- mode off is byte-compatible/no new fetch; observe records result but leaves candidate URL/ranking unchanged; active applies deep links.

Refactor `src/onboarding/variant-url-resolver.ts:1-end`:

- remove its independent Shopify candidate/scorer;
- call canonical adapters/matcher;
- return `{ candidates, resolution }` instead of burying the only outcome in `metadataJson`;
- retain a small compatibility projection in each source's metadata for existing candidate diagnostics;
- call `buildVariantDeepLink`/identity keys;
- use `shopifyProductUrl` and existing public `.js` parser through injected transport;
- enforce hard fetch/size/variant bounds and stable diagnostics.

#### 3.2 Red tests: sitemap tokens and URL scoring

Modify:

- `src/tests/unit/sitemap-matcher.test.ts`
- add cases to existing sitemap fetch/sync tests (locate symbols `dedupeEntries`, `shopify variant`)

Assert:

- Discovery passes deterministic `variantTokens` (`small`, `large`, `mini`, measurements/options) into `SitemapLlmContext`;
- `extractSlug` remains a base-path text helper, but a separate variant identity signal distinguishes deep links;
- LLM page ranking cannot override deterministic variant ambiguity;
- query-bearing variant sitemap entries remain distinct after dedupe/reconcile;
- tracking-only duplicate URLs collapse;
- `?variant=` survives fetch → sync/index → match → candidate → selected source round trip.

Modify:

- `src/onboarding/sitemap-matcher.ts:34-60,97-221,329-370,452-463` — accept caller context, populate/use `variantTokens`, export/test base slug helper if needed, and keep query identity separate from slug text.
- `src/onboarding/sitemap-fetcher.ts:652-666,752-766` — use product URL identity key for product entries without merging distinct variants.
- `src/onboarding/sitemap-sync-service.ts` Shopify deep-link indexing path — normalize with the same helper and preserve variant parameters.
- `src/onboarding/source-discovery.ts:191-266` — use identity-key dedupe, pass context/tokens, call the structured resolver, and return `variantResolution` summary.

#### 3.3 Discovery persistence and transition

Add tests around `src/onboarding/job-queue.ts:1185-1465` proving:

- active-mode resolved selection persists a current automatic resolution row, selects the exact synthesized source, stamps discovery run step `variant_resolution`, and advances normally;
- ambiguous/no-match multi-variant results persist candidates and complete Discovery as `needs_input_ambiguous` without calling page verification to auto-select a parent/default variant;
- observe mode writes only approved diagnostics/telemetry, not source/stage/decision changes (if durable observe rows are judged to be a “write,” store only local logs/metrics; do not violate observe semantics);
- no-domain and distributor-record routes remain byte-compatible.

Modify `src/onboarding/job-queue.ts` only in the Discovery branch and repository/service calls. Do not add direct SQL.

**Acceptance criteria:** AC-4 is satisfied in unit/integration tests; hard network bound is enforceable; mode off adds zero requests; ambiguous parents never auto-select.

---

### Milestone 4 — Extraction linkage and variant-specific payload composition

**Dependencies:** Milestones 1-3.

#### 4.1 Red tests: worker wire contract

Modify/create:

- `src/tests/unit/profile-runner-client.test.ts`
- `src/tests/unit/profile-runner.test.ts`
- **Create** `src/tests/unit/extraction-worker-variant-selection.test.ts`
- modify `src/tests/unit/extraction-ladder.test.ts`

Assert:

- request carries optional selection receipt/expected trusted identifiers and flag mode;
- response carries validated matrix decision, selected receipt, structured failure code, and exact field provenance;
- legacy request/response remains valid with optional fields absent in mode off;
- `allowShopifyProductJson` false/absent performs no `.js` fetch;
- observe/active can make exactly one same-origin `.js` call via injected `safeProfileFetch`; redirect to an unallowed/private destination is denied;
- ladder remains additive and failure-isolated;
- ambiguous/no-match/stale selection returns `ok:false` plus `failureCode = variant_selection_required | variant_selection_stale | variant_matrix_invalid`, not an unstructured parsed error;
- unrelated network/enrichment failures still follow existing behavior.

Modify:

- `src/shared/schemas/extraction-worker.ts:146-152,253-299` — reuse shared strategy/variant schemas; add optional request selection and response outcome/failure code.
- `src/onboarding/profile-runner-client.ts:64-112` — forward selection and preserve structured failure details.
- `src/onboarding/page-extractor.ts:233-354` — extend expected/options with trusted selection; return/throw a typed variant failure rather than flattening it to text.
- `src/extraction-worker/routes/extract.ts:612-666,681-957,1522-1535` — call canonical parser/matcher, use `safeProfileFetch` for Shopify `.js`, and return typed outcome.

`allowShopifyProductJson` implementation rule: generic `applyLadderEnrichment` callers retain default false. The worker's explicit variant-resolution pre-step may opt in in observe/active mode using a fetch adapter over `safeProfileFetch`; it must not globally flip the ladder option or use bare `fetch`.

#### 4.2 Red tests: materialization and images

Create `src/tests/unit/selected-variant-materializer.test.ts` and replace deprecated expectations in `src/tests/unit/page-extractor-variant-inference.test.ts`.

Assert for all BetterBone siblings:

- requested selected key equals response receipt key/matrix hash;
- selected title/GTIN/SKU/options/weight are distinct and correct;
- selected variant image is primary even when page `og:image` and default variant point to another sibling;
- large image-map association uses explicit variant IDs and retains transform query when it matters to retrieval;
- a sibling-associated image is excluded from that item's variant-specific set;
- product-level gallery may follow the selected image with product-level provenance and image dedupe remains image-specific;
- missing selected image/weight does not copy the first/default variant's value; no page price enters any payload;
- base description/brand remains when non-conflicting;
- variant materialization does not mutate the generic ladder fill helper;
- malformed or mismatched receipt fails before completed payload creation.

Create `src/onboarding/selected-variant-materializer.ts`; extend `ExtractionDataSchema` at `src/shared/schemas/onboarding.ts:240-371` with optional `selectedVariant` and typed variant identifiers/attributes/provenance. Keep defaults backward-compatible for old persisted rows.

#### 4.3 Job queue gate and persistence

Add `src/tests/unit/onboarding-variant-extraction-flow.test.ts` covering:

- current persisted selection is loaded and forwarded;
- fresh matrix identity hash/key must match persisted receipt;
- source URL's variant identity agrees with selected candidate deep link;
- success persists resolution + extraction + item completion coherently;
- ambiguous/no-match/stale creates/supersedes resolution evidence, writes no completed extraction/item payload, does not consume blind retry budget, and sets `extraction/needs_input`;
- ordinary transient worker failures retain existing bounded retry behavior;
- distributor-record materialization never enters this official-page branch;
- sibling item extraction rows cannot reuse another item's receipt.

Modify `src/onboarding/job-queue.ts:1500-1640` and use repository/service transactions; do not add SQL outside repositories. If atomicity requires a service transaction, create `src/onboarding/variant-selection-service.ts` now and share it with Milestone 6.

**Acceptance criteria:** AC-1 and AC-3 pass for the three-item fixture; no completed multi-variant extraction exists without linkage; ladder additive contract remains green.

---

### Milestone 5 — Profile strategy and separately gated browser fallback

**Dependencies:** Milestones 2 and 4. May ship later than structured MVP.

#### 5.1 Disable unsafe implicit interaction first

Add failing worker tests showing that, with test override `interactionEnabled:false` (env now always `active` default-off), the current block at `src/extraction-worker/routes/extract.ts:1009-1089` does not click/select even when a profile strategy exists. Structured resolution remains active.

Then gate/remove the current full-name substring implementation. No behavior that clicks a merchant page may be default-on.

#### 5.2 Strict profile strategy contract

Modify:

- `src/shared/schemas/onboarding.ts:999-1035`
- `src/shared/schemas/extraction-worker.ts:146-152`
- relevant mapping/controller files under `src/client/components/profile-builder/` (`profileBuilderTypes.ts`, `profileBuilderMapping.ts`, `hooks/useProfileBuilderController.ts`, and `ProfileBuilder.tsx`) only if needed to author/review the strategy
- profile repository serialization tests

Replace loose record usage with one shared strict structure:

- per-axis selector and option type;
- option value selector/text/value attribute;
- exact mapping from normalized candidate axis/value to DOM value;
- optional settled-state selector/attribute;
- bounded timeout;
- no scripts, arbitrary expressions, URLs, or product-specific variant IDs.

Profiles describe structure. The request's selected candidate supplies actual option values.

#### 5.3 Pure action-plan tests, then worker execution

Create:

- `src/extraction-worker/variant-interaction.ts`
- `src/tests/unit/variant-interaction.test.ts`

Use `option-swatches.html` to assert:

- exact per-axis option plan (`Size=Small`, `Flavor=Beef`), deterministic axis order;
- no substring confusion (`Small` does not match `Small Breed`);
- missing/duplicate controls, disabled options, changed URL to the wrong key, or unsettled page fail closed;
- no action occurs without an already resolved/persisted candidate;
- after action, reparse DOM/URL and verify selected key/options before extracting selectors;
- click count/axes/timeouts are bounded and all browser execution remains worker-side.

Integrate into `src/extraction-worker/routes/extract.ts` only behind the interaction flag. Structured payload selection stays preferred. Interaction is fallback for fields that require rendered selection, not a replacement for identity resolution.

Profile Builder preview/validation should expose detected axes and validate a strategy against fixture/snapshot samples, but must not auto-promote an unreviewed strategy. Respect ADR-0008 revision lifecycle and ADR-0009 worker boundary.

**Acceptance criteria:** swatch DOM AC-6 case passes when explicitly enabled; the default path makes no click; disabling the flag is an immediate rollback.

---

### Milestone 6 — Durable Choose Variant operator fallback

**Dependencies:** Milestones 1-4. Does not depend on browser interaction.

#### 6.1 Service and route tests first

Create `src/tests/unit/onboarding-variant-selection-route.test.ts` (Bun/Hono temp DB) and service/repository tests.

Add request schema to `src/shared/schemas/variant-resolution.ts`:

```ts
{ resolutionId: string; identityMatrixHash: sha256; variantKey: string }
```

Add route near `src/server/routes/onboarding-routes.ts:2376-2430`:

`POST /onboarding/items/:id/select-variant`

Tests assert:

- API mutation auth is enforced by existing server middleware in the real app composition;
- missing/foreign item and foreign resolution are 404 (no existence leak);
- malformed body is 400 from Zod;
- mode not active is 409/feature-disabled;
- wrong/superseded resolution or matrix hash is 409 stale;
- candidate key must exist in the current server-stored matrix; client cannot submit URL, price, image, identifiers, or payload;
- unsupported stage/status and resolved extraction are 409;
- server derives trusted deep link/payload from persisted candidate, selects or inserts the corresponding source, updates item source URL/type, records operator decision, and sets Extraction pending in one transaction;
- unavailable choice is either rejected or explicitly allowed by one documented policy; recommended default is reject unless exact item identity requires it and UI confirms (product decision must be recorded before implementation);
- idempotent retry with the same resolution/hash/key succeeds without duplicate source/decision; a different second choice uses an explicit replacement decision and invalidates any downstream extraction/review state;
- worker is kicked only after commit.

Implement/shared transaction in `src/onboarding/variant-selection-service.ts`; use item/source/variant repositories only. Harden generic `select-source`: if a source represents an unresolved matrix, delegate to or reject in favor of `select-variant`; it must not bypass the stale-safe decision contract.

Return the latest `variantResolution` from the existing item-detail route using the client-safe schema.

#### 6.2 Work-state projection tests first

Modify:

- `src/tests/unit/onboarding-work-state.test.ts`
- `src/tests/unit/attention-logic.test.ts`
- `src/tests/unit/attention-action-mapping.test.ts`

Then modify:

- `src/shared/schemas/onboarding-work-state.ts:94-128,169-235` — add `choose_variant` to reason/action and optional client-safe resolution summary/reference.
- `src/onboarding/onboarding-work-state.ts:475-650` — add `variantResolutionByItem` to context and derive from a current unresolved row, not from string parsing.
- `src/client/components/onboarding/attention/attention-logic.ts:20-175` — labels/group/order/action/consequence.

Required projection:

- current `ambiguous | no_match | stale` active-mode multi-variant record + `discovery|extraction needs_input` => `needs_attention`, `choose_variant`, label `Choose product variant`;
- resolution selected/superseded => no `choose_variant`;
- mode off does not expose the action;
- source conflict, missing profile, no URL, semantic conflict, and generic processing failures keep their existing precedence.

#### 6.3 UI tests first

Create:

- `src/client/components/onboarding/attention/ChooseVariantPanel.tsx`
- `src/tests/unit/choose-variant-panel.test.tsx`

Modify:

- `src/client/onboarding-api.ts:484-560` — typed resolution in item detail and `selectVariant` mutation.
- `src/client/components/onboarding/attention/OfficialSiteResolutionWorkspace.tsx:1-205` plus phase render — add `variant` phase and submit handler.
- `src/client/components/onboarding/attention/attention.css` — minimal existing-token styles only.

The panel renders inside the existing focus-trapped drawer (satisfies “modal” without nested focus traps). It must show option labels, SKU/MPN, masked/complete GTIN as permitted by existing product UI policy, availability, and thumbnail with alt/fallback; it must not display a page price. It uses a radio group or selectable cards, keyboard navigation, explicit confirmation, saving/success/error states, and stale reload behavior.

UI tests assert:

- all detected BetterBone variants render and the recommended candidate is explained, not pre-submitted;
- duplicate GTIN candidates remain separate and no automatic choice occurs;
- submit contains only resolution ID/hash/key;
- double submit is disabled/idempotent;
- 409 stale reloads the current matrix and preserves no stale selection;
- successful choice closes/resolves and Extraction is pending;
- empty/oversized/unsupported matrices show safe fallback to verify/retry, not arbitrary payload entry;
- Escape/focus behavior remains owned by the parent drawer.

**Acceptance criteria:** AC-5 passes end to end; operator choice is durable, stale-safe, auditable, and cannot inject a variant URL/payload.

---

### Milestone 7 — Integration, smoke cohort, rollout, and docs

**Dependencies:** Milestones 0-6; interaction sub-rollout may remain disabled after Milestone 5 tests.

#### 7.1 End-to-end fixture integration test

Create `src/tests/integration/onboarding-betterbone-variant-flow.test.ts` using a temp DB, seeded workspace/brand/profile, local fixture HTTP transport/worker adapter, and one three-item cohort.

The test must prove:

1. import items `BetterBone Hard Beef SM`, `LG`, `MINI` with distinct trusted identities;
2. one official parent page is discovered;
3. Discovery persists three distinct `?variant=<id>` URLs and three current selection receipts;
4. profile request/response round trip retains each selected key/hash;
5. Extraction produces three distinct payloads (SKU/GTIN/options/weight/primary image), not three copies of the default;
6. source/final URLs retain variant identity after persistence/API serialization;
7. all three become extraction-completed and can satisfy the existing cohort barrier;
8. replacing one item with duplicate-GTIN ambiguous evidence parks only that member in `needs_attention/choose_variant`; siblings remain correct; selecting it resumes Extraction.

No live server, ShopSite, model, browser, paid service, or public network is required.

#### 7.2 API/profile round-trip smoke

With a disposable local DB and fixture transport:

- create/load a profile containing the strict strategy;
- call the trusted profile runner request schema and parse its response;
- GET item detail and work state;
- for an ambiguous item, POST the exact resolution ID/hash/key;
- poll/reinvoke the worker locally and GET item detail;
- verify receipt, source URL, extraction fields, attention clearance, and audit row.

Capture redacted request/response shape only; no credentials or raw third-party payload.

#### 7.3 Rollout sequence — **Historical (pre-always-on, env flags deprecated)**

> Flags are now always-on (`src/onboarding/variant-flags.ts`); `BAYSTATE_CMS_VARIANT_RESOLUTION_MODE`/`BAYSTATE_CMS_VARIANT_INTERACTION_ENABLED` are ignored. Below is the historical env-based rollout for reference; current procedure is revert-based (revert commit), not mode progression.

1. **Code deployed, mode off (historical):** migrations/contracts present, zero behavior/network change.
2. **Observe on fixture/internal workspace (historical):** compare parser decisions to manually labeled BetterBone/JSON-LD/Woo corpus. Interaction remains false.
3. **Observe production read path only after verified DB backup (historical):** monitor parse success, ambiguity, duplicate identifier, fetch count/latency, and disagreement; no source/stage/extraction mutations.
4. **Active allowlisted workspace/domain cohort (historical):** structured parsing/deep links/materialization/operator fallback. Require zero wrong-auto-selection in reviewed sample and bounded latency/error rates.
5. **Broaden active (historical):** only after acceptance report/reviewer sign-off.
6. **Optional interaction canary (historical):** separate approval and flag; never coupled to structured activation.

Telemetry must use stable reason/platform/count/latency fields and hashed/non-secret IDs. Do not log full product JSON, query secrets, GTINs if existing logging policy treats them as sensitive, or credentials.

#### 7.4 Documentation

Modify only after behavior is green:

- `CONTEXT.md` — add concise authoritative variant-resolution lifecycle, durable selection, stage transition, and flag semantics.
- `docs/runbooks/variant-resolution-rollout.md` — create backup/observe/activate/monitor/rollback procedure and smoke checklist.
- `docs/adr/0031-extraction-ladder-wiring.md` — only via a separately reviewed amendment if the ADR compatibility checkpoint in §3.1 requires it.

Do not rewrite `docs/plans/issue-variant-page-resolution.md`; preserve it as the issue/problem note unless separately requested.

**Acceptance criteria:** all six AC mappings pass; smoke produces three distinct BetterBone URLs/payloads; active and interaction rollback paths are demonstrated; no staged files are introduced by implementation automation.

---

## 7. Exact planned file inventory

This inventory is intentionally conservative. “Conditional” means touch only if its milestone proves necessary; do not perform drive-by cleanup.

### 7.1 New production files

- `src/shared/schemas/variant-resolution.ts`
- `src/onboarding/product-url-identity.ts`
- `src/onboarding/variant-flags.ts`
- `src/onboarding/selected-variant-materializer.ts`
- `src/onboarding/variant-selection-service.ts`
- `src/db/repositories/onboarding-variant-resolution-repo.ts`
- `src/extraction-worker/variant-interaction.ts` (Milestone 5, default-off)
- `src/client/components/onboarding/attention/ChooseVariantPanel.tsx`
- `docs/runbooks/variant-resolution-rollout.md`

### 7.2 Existing production files to modify

- `src/onboarding/variant-resolver.ts`
- `src/onboarding/variant-url-resolver.ts`
- `src/onboarding/source-discovery.ts`
- `src/onboarding/sitemap-matcher.ts`
- `src/onboarding/sitemap-fetcher.ts`
- `src/onboarding/sitemap-sync-service.ts`
- `src/onboarding/extraction-ladder/platforms.ts`
- `src/onboarding/extraction-ladder/enrich.ts`
- `src/onboarding/extraction-ladder/result-shape.ts`
- `src/shared/schemas/onboarding.ts`
- `src/shared/schemas/extraction-worker.ts`
- `src/onboarding/profile-runner-client.ts`
- `src/onboarding/page-extractor.ts`
- `src/extraction-worker/routes/extract.ts`
- `src/onboarding/job-queue.ts`
- `src/db/onboarding-migration.sql`
- `src/db/migrations.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/shared/schemas/onboarding-work-state.ts`
- `src/onboarding/onboarding-work-state.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/onboarding/attention/OfficialSiteResolutionWorkspace.tsx`
- `src/client/components/onboarding/attention/attention-logic.ts`
- `src/client/components/onboarding/attention/attention.css`
- `CONTEXT.md`

### 7.3 Conditional Profile Builder files (Milestone 5 only)

- `src/client/components/profile-builder/profileBuilderTypes.ts`
- `src/client/components/profile-builder/profileBuilderMapping.ts`
- `src/client/components/profile-builder/hooks/useProfileBuilderController.ts`
- `src/client/components/profile-builder/ProfileBuilder.tsx`

### 7.4 New fixture/test files

- all fixtures listed in §6.1.1
- `src/tests/unit/product-url-identity.test.ts`
- `src/tests/unit/variant-resolution-schema.test.ts`
- `src/tests/unit/variant-flags.test.ts`
- `src/tests/unit/onboarding-variant-resolution-migration.test.ts`
- `src/tests/unit/onboarding-variant-resolution-repo.test.ts`
- `src/tests/unit/source-discovery-variant-resolution.test.ts`
- `src/tests/unit/extraction-worker-variant-selection.test.ts`
- `src/tests/unit/selected-variant-materializer.test.ts`
- `src/tests/unit/onboarding-variant-extraction-flow.test.ts`
- `src/tests/unit/variant-interaction.test.ts`
- `src/tests/unit/onboarding-variant-selection-route.test.ts`
- `src/tests/unit/choose-variant-panel.test.tsx`
- `src/tests/integration/onboarding-betterbone-variant-flow.test.ts`

### 7.5 Existing tests to modify

- `src/tests/unit/variant-resolver.test.ts`
- `src/tests/unit/variant-url-resolver.test.ts`
- `src/tests/unit/page-extractor-variant-inference.test.ts`
- `src/tests/unit/extraction-ladder.test.ts`
- `src/tests/unit/profile-runner-client.test.ts`
- `src/tests/unit/profile-runner.test.ts`
- `src/tests/unit/sitemap-matcher.test.ts`
- relevant existing sitemap fetch/sync tests located by symbol
- `src/tests/unit/onboarding-work-state.test.ts`
- `src/tests/unit/attention-logic.test.ts`
- `src/tests/unit/attention-action-mapping.test.ts`

---

## 8. Dependency ordering and safe change sequence

```text
M0 characterize
  └─ M1 schemas + URL identity + flags + migration/repository
       └─ M2 pure adapters/matcher
            ├─ M3 Discovery/deep links/persistence
            │    └─ M4 worker linkage/materialization/job gate
            │         ├─ M5 browser interaction (independent default-off rollout)
            │         └─ M6 operator fallback
            └──────────────────────────────┘
                         └─ M7 integration/smoke/docs/rollout
```

Within cross-cutting milestones, update in this compile-safe order:

1. shared optional schemas/types;
2. migration + repository;
3. pure implementation and unit tests;
4. worker wire schema, producer, then consumer;
5. server projection/route;
6. client API then UI;
7. integration test/docs.

Do not leave a state where a producer emits required fields an old consumer cannot parse; fields remain optional until every hop is green, then active-mode runtime validation enforces them.

---

## 9. Validation commands

Run from repository root. Tests must not use network; inject fixture transports.

### 9.1 Targeted red/green commands

```bash
bunx vitest run src/tests/unit/product-url-identity.test.ts src/tests/unit/variant-resolution-schema.test.ts src/tests/unit/variant-flags.test.ts
bunx vitest run src/tests/unit/variant-resolver.test.ts src/tests/unit/variant-url-resolver.test.ts src/tests/unit/source-discovery-variant-resolution.test.ts
bunx vitest run src/tests/unit/extraction-ladder.test.ts src/tests/unit/extraction-worker-variant-selection.test.ts src/tests/unit/selected-variant-materializer.test.ts
bunx vitest run src/tests/unit/profile-runner-client.test.ts src/tests/unit/profile-runner.test.ts src/tests/unit/page-extractor-variant-inference.test.ts
bunx vitest run src/tests/unit/onboarding-variant-resolution-migration.test.ts src/tests/unit/onboarding-variant-resolution-repo.test.ts src/tests/unit/onboarding-variant-extraction-flow.test.ts
bunx vitest run src/tests/unit/variant-interaction.test.ts src/tests/unit/choose-variant-panel.test.tsx
bun test src/tests/unit/sitemap-matcher.test.ts src/tests/unit/onboarding-variant-selection-route.test.ts src/tests/unit/onboarding-work-state.test.ts
```

If repository test config routes one of these files to Bun rather than Vitest, use the existing nearest-suite convention; do not force incompatible runners.

### 9.2 Integration and full gates

```bash
bunx vitest run src/tests/integration/onboarding-betterbone-variant-flow.test.ts
bun run test
bun run typecheck
bun run lint
```

### 9.3 Migration verification (temporary DB only)

```bash
BAYSTATE_CMS_DB_PATH=/tmp/baystate-issue-90-migration.db bun test src/tests/unit/onboarding-variant-resolution-migration.test.ts
sqlite3 /tmp/baystate-issue-90-migration.db 'PRAGMA foreign_key_check; PRAGMA integrity_check;'
rm -f /tmp/baystate-issue-90-migration.db /tmp/baystate-issue-90-migration.db-wal /tmp/baystate-issue-90-migration.db-shm
```

The test itself should own cleanup; the explicit `rm` is limited to this known `/tmp` path, never a project/live DB.

### 9.4 Flag/round-trip smoke matrix

```bash
# Flags are always-on (env ignored); use test overrides for mode simulation
# Historical env commands are non-executable — use Vitest -t targeting real test names:
bunx vitest run src/tests/unit/source-discovery-variant-resolution.test.ts -t "mode off is byte-compatible"
bunx vitest run src/tests/unit/source-discovery-variant-resolution.test.ts -t "observe records diagnostics"
bun test src/tests/integration/onboarding-betterbone-variant-flow.test.ts -t "8-step cohort"
bunx vitest run src/tests/unit/variant-interaction.test.ts
# To simulate off/observe in tests, use overrideVariantFlags({mode:'off'}) within test file, not shell
```

### 9.5 Worktree/staging verification

```bash
git status --short
git diff -- docs/plans/issue-90-implementation-plan.md
git diff --cached --name-only
```

Implementation agents must report pre-existing staged entries separately and make no staging changes. The request to “leave no staged files” cannot justify unstaging someone else's existing staged work; acceptance is **no new staged paths or index mutations attributable to issue #90**.

---

## 10. Acceptance mapping and evidence required

| Acceptance | Milestones | Required tests/evidence |
|---|---|---|
| AC-1 targeted variant extraction | M2, M4, M7 | matcher tables; materializer tests; worker receipt/gate tests; BetterBone three-payload integration |
| AC-2 structured parsing/match precedence | M2, M4 | adapter conformance for Shopify/JSON-LD/Woo; duplicate identifier and option tuple tests; DOM only after structured path |
| AC-3 variant-specific images | M4, M7 | large image map fixture; sibling exclusion; three distinct BetterBone primary images/provenance |
| AC-4 deep-link Discovery | M1, M3, M7 | product URL identity tests; sitemap round trip; hard-bounded resolver; three distinct persisted source URLs |
| AC-5 Choose Variant | M6, M7 | projection/action tests; guarded route/service tests; accessible panel tests; ambiguous integration and resumed extraction |
| AC-6 fixture/unit/integration coverage | M0-M7 | all named fixture suites, option-swatch pure/action tests, full test/typecheck/lint results |

A criterion is not complete from unit tests alone if its row requires integration evidence.

---

## 11. Explicit non-goals and boundaries

Do **not**:

- redesign the six-stage onboarding pipeline or Curation/cohort architecture;
- alter distributor-record materialization (URL-null/profile-free path);
- change ShopSite import/export, promotion, catalog Git commits, or product schema normalization unrelated to extracted variant evidence;
- use an LLM/model/OCR for variant identity or option selection;
- scrape arbitrary search results, perform paid crawls, or call live storefront APIs in tests;
- add BigCommerce Storefront API, Magento GraphQL, cart/session mutation, inventory writes, or credentials;
- treat unavailable status or title similarity as sufficient automatic identity;
- reinterpret historical frozen selection receipts with live parser rules;
- merge variant query URLs through image canonicalization;
- replace the extraction ladder's additive fill policy;
- make browser interaction default-on or couple it to structured resolution activation;
- add a nested modal/focus trap; reuse the current drawer workspace;
- trust a client-submitted URL, identifier, image, option map, price, or raw candidate payload;
- mutate/stage/commit unrelated dirty files or run broad cleanup commands;
- modify the existing issue note `docs/plans/issue-variant-page-resolution.md` as part of implementation.

---

## 12. Residual risks and mitigations

| Risk | Mitigation / residual state |
|---|---|
| Merchant payload schemas drift. | Version adapters; fail `unsupported/no_matrix`; preserve parser/source evidence; observe before active. Residual: some pages require profile/operator fallback. |
| Duplicate/reused GTIN data is bad. | Duplicate identifier never resolves alone; require independent exact proof or operator. Residual: human decision may still rely on bad merchant labels, so show all evidence. |
| Volatile Shopify `.js` adds latency/network load. | Default off, guarded/injected fetch, one same-origin call, 3-parent cap, timeout/5 MB bound, observe metrics. |
| Canonical/query links redirect to parent/default. | Persist requested and final URL; reparse and verify selected key/options. Redirect identity loss blocks rather than completes. |
| Variant images are absent or shared. | Use explicit association only for variant-primary; shared product image has product-level provenance. Do not fabricate distinct images. |
| Existing dirty edits conflict with implementation. | One sequential writer; per-file unstaged/staged diff before edits; narrow hunks; reviewer checks unrelated diff preservation. |
| Additive ladder versus variant overlay interpretation. | Separate materializer and explicit ADR checkpoint; amend ADR before weakening any invariant. |
| Operator selection becomes stale after matrix drift. | Identity hash/parser version optimistic concurrency and server-derived payload; stale response reloads current matrix. |
| Browser interactions cause merchant side effects or wrong option. | Default-off separate flag, worker-only exact action plan, no cart actions, bounded controls/time, post-action verification. Residual: interactive support remains canary-only. |
| 250-variant cap excludes legitimate huge catalogs. | Fail closed with operator/setup status; later adapter-specific pagination is separate work. Never silently truncate and resolve. |
| Old binaries ignore new unresolved rows during rollback. | Always-on (revert commit `f53fcdc`/`7163062` to restore legacy); rows are additive. Operational rollback must understand that legacy extraction may again be less safe; pause workers if wrong-default risk prompted rollback. |

---

## 13. Definition of done

Issue #90 is implementation-complete only when all are true:

- six AC rows have passing named evidence;
- BetterBone SM/LG/MINI produce three distinct deep links and payload receipts;
- duplicate GTIN cannot auto-select;
- query identity survives every Discovery/persistence/API hop;
- ambiguous/stale selection writes no completed extraction and projects Choose Variant;
- operator choice is stale-safe, server-derived, auditable, and resumes Extraction;
- generic ladder remains additive and Shopify `.js` remains explicit/injected/bounded;
- browser interaction is worker-only and default-off;
- migration fresh/upgrade/idempotency/foreign-key/integrity tests pass;
- full test, typecheck, and lint gates pass or every pre-existing failure is explicitly separated;
- rollout/rollback runbook is reviewed;
- no live DB was changed without a verified backup;
- no issue #90 file was staged or committed except under an explicit later instruction.

---

## 14. Planning-session acceptance report

This report describes creation of this plan, not implementation completion.

```acceptance-report
{
  "issue": 90,
  "artifact": "docs/plans/issue-90-implementation-plan.md",
  "status": "planned_not_implemented",
  "changedFiles": [
    "docs/plans/issue-90-implementation-plan.md"
  ],
  "implementationFilesChanged": [],
  "commands": {
    "executed": [
      "git status --short",
      "git branch --show-current",
      "git status --short -- docs/plans/issue-90-implementation-plan.md",
      "git diff --cached --name-only",
      "repository file reads/greps for governing plans, ADRs, Discovery, extraction worker, schemas, migrations, routes, work-state, UI, and tests"
    ],
    "testsRun": [],
    "testsNotRunReason": "Planning-only request; no implementation behavior was changed.",
    "plannedValidation": [
      "targeted Bun/Vitest suites listed in section 9.1",
      "bunx vitest run src/tests/integration/onboarding-betterbone-variant-flow.test.ts",
      "bun run test",
      "bun run typecheck",
      "bun run lint",
      "temporary-DB PRAGMA foreign_key_check and integrity_check",
      "off/observe/active and interaction flag smoke matrix"
    ]
  },
  "acceptanceMapping": {
    "AC-1": ["M2", "M4", "M7"],
    "AC-2": ["M2", "M4"],
    "AC-3": ["M4", "M7"],
    "AC-4": ["M1", "M3", "M7"],
    "AC-5": ["M6", "M7"],
    "AC-6": ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"]
  },
  "reviewFindings": [
    "The two current variant resolver modules overlap and must be consolidated rather than extended independently.",
    "resolveVariantsForCandidates is not hard-bounded because it adds all official/sitemap candidates after taking the top three.",
    "SitemapLlmContext.variantTokens exists but is not populated by Discovery.",
    "Product URL identity needs a separate canonicalizer; image canonicalizeUrl and normalizeForDedupe must remain image-only.",
    "Shopify product JSON is already explicitly gated by allowShopifyProductJson and must use injected guarded transport.",
    "Rendered profile interaction currently uses permissive whole-name substring matching and needs a separate default-off flag plus exact per-axis verification.",
    "A dedicated durable resolution row is needed for extraction-discovered ambiguity and stale-safe operator choice.",
    "Variant materialization must remain separate from ADR-0031 additive ladder enrichment."
  ],
  "risks": [
    "merchant schema drift",
    "duplicate or bad identifiers",
    "variant query loss across redirects/canonicalization",
    "variant-image association gaps",
    "ADR-0031 overlay interpretation",
    "stale operator decisions",
    "fragile browser interaction",
    "dirty-worktree merge conflicts"
  ],
  "staging": {
    "branch": "main",
    "planFileState": "untracked",
    "stagingChangedByPlanningSession": false,
    "preExistingStagedFilesObserved": [
      "src/client/components/onboarding/attention/SemanticConflictPanel.tsx",
      "src/client/components/onboarding/attention/semantic-conflict.css",
      "src/client/components/onboarding/families/FamilyInspectorDrawer.tsx",
      "src/client/components/onboarding/families/family-inspector.css"
    ],
    "policy": "Preserve the pre-existing index exactly; implementation must introduce no new staged paths and must not unstage unrelated work."
  }
}
```
