# Distributor Scrapers Migration — Implementation-Ready Plan

**Project:** Bay State CMS (`/Users/nickborrello/Desktop/Projects/shopsite-cms`)  
**Authority:** ADR 0014 Amendment B, `CONTEXT.md`, and the ratified handoff in `docs/plans/distributor-scrapers-migration-plan.md`  
**Plan status:** Ready for sequential implementation and required review  
**Scope:** Five `html_scraper` connectors (`orgill`, `pet_food_experts`, `phillips_storefront`, `bradley`, `central_pet`) plus merchandising-depth distributor-record materialization

## 1. Governing decisions and interpretation

This plan implements, without reopening, these ratified decisions:

- Connectors run in-process in TypeScript and implement `DistributorConnector.lookupByGtin`; there is no Python sidecar.
- The closed connector type set gains `html_scraper`. Existing `api` connectors remain (`phillips` and `bci`), and registry selection is by the pair `(connectorType, distributorId)`.
- The five scraper provider IDs are exactly `orgill`, `pet_food_experts`, `phillips_storefront`, `bradley`, and `central_pet`. The provenance IDs deliberately do not collide with REST IDs (`phillips` versus `phillips_storefront`, `bci` versus `bradley`).
- Crawlee is the runtime: Playwright for login/JS flows and Cheerio for static extraction. Cookies and session state remain process-memory-only. There are no proxies in v1.
- Exact UPC/GTIN equality remains the authority. Brand/name hints cannot turn a mismatch into `found`.
- Distributor-record materialization becomes merchandising-depth: identity plus description, features, distributor category text, dimensions, case pack, unit of measure, ingredients, and display-only image candidates. Price, inventory, stock status, pallet quantity, arbitrary provider fields, and commerce images remain excluded.
- The item and extraction row retain a null source URL. Real distributor URLs remain only on immutable evidence attempts.
- Merchandising disagreement never creates or blocks a hard conflict. Identity disagreement remains governed by the existing hard-field and variant-axis rules.
- Every connector is tested offline from provenance-stamped fixture HTML. Live smoke is explicit, environment-gated, and never runs in CI.
- Every new connection is created disabled. Rollout remains provider-by-provider and mode-by-mode (`observe` → `manual` → `automatic`).

### Result terminology

The current `SourcingLookupResult` union has only `found`, `not_stocked`, and `source_error`. Tests and reports must map scenarios as follows rather than inventing new union members:

| Scenario | Contract result |
|---|---|
| Exact product found | `found` |
| Explicit no-results page (“not_found” test case) | `not_stocked`, bounded reason `no_exact_match` |
| Search/PDP contains only a different UPC/GTIN or variant | `not_stocked`, bounded reason `wrong_variant` |
| Authentication cannot be established after the one permitted re-login | `source_error`, stable code `auth_failed` (or `auth_expired` when a formerly valid cached session repeatedly expires) |
| Missing required secret | Engine-written `source_error`, code `secret_missing` |
| Malformed credential JSON | `source_error`, code `credential_invalid` |
| Timeout/caller abort/origin violation/body cap/unexpected markup/parser failure | `source_error` with the corresponding stable non-secret code |

An ambiguous page with neither a recognized result nor an explicit no-result marker is `source_error:unexpected_markup`, never `not_stocked`.

## 2. Verified baseline and mandatory preflight

Planning observed Shopsite CMS HEAD `29c8c4c8975aa4777691869365753434ce45c78a` on `main`. The worktree is already dirty and must be preserved in place:

- Modified: `CONTEXT.md`, `docs/adr/0014-multi-distributor-sourcing.md`, `src/client/onboarding-api.ts`, `src/db/distributor-v2-migration.sql`, `src/db/migrations.ts`, `src/onboarding/sourcing/connector-registry.ts`, `src/onboarding/sourcing/contracts.ts`, `src/shared/schemas/distributor.ts`, `src/tests/unit/db-migration.test.ts`, `src/tests/unit/sourcing-contracts.test.ts`.
- Untracked: `docs/plans/distributor-scrapers-migration-plan.md`.
- Staged paths: none.
- No `/tmp/*.md` scout report was present.

The BayState migration source was inspected at HEAD `2a5c9a5f55644a50bee3f23e9d3f819eb10639f0`; its unrelated untracked files must not be touched. Historical YAML authority is the tree at `5619f6a4^`.

### Current blocking defect in the partial M1 work

The current dirty `src/db/migrations.ts` change adds `html_scraper` inside the already-versioned `default_on_sourcing_schema_version` block. That cannot upgrade an installation whose Amendment A marker is already present. M1 must replace that coupling with a new, independent marker-gated migration. Merely keeping the current conditional is not acceptable.

### Preflight gate before the first implementation edit

One sequential writer must:

1. Record HEAD, `git status --short`, `git diff --cached --name-only`, and hashes of every target file.
2. Classify every existing dirty path as this migration’s partial work or unrelated work; patch the current bytes, never reset/restore/stash/clean them.
3. Confirm all DB tests use temporary or in-memory databases. Do not open or mutate `src/db/shopsite-cms.db`, a workspace DB, the catalog, or ShopSite.
4. Use no network during implementation or automated tests. The only sanctioned network actions are the later manual fixture-capture procedure and the explicit live-smoke/rollout steps.
5. Do not stage or commit. The only sanctioned catalog commit path is unrelated and must not be invoked.

Preflight commands:

```bash
git rev-parse HEAD
git status --short
git diff --cached --name-only
find /tmp -maxdepth 1 -type f -name '*.md' -print | sort
```

## 3. Dependency order

`Preflight → M1 schema/type/registry key → M2 bounded scraper/auth core → M3 public connectors → M4 authenticated connectors → M5 v2 projection/materializer/consumers → M6 live-smoke tooling → M7 offline release integration and disabled-row readiness → M8 operator rollout`

M3 and M4 both depend on M2. M5 deliberately follows all connector field maps so its projection is tested against actual normalized connector output. M8 cannot begin until every M1–M7 definition of done passes review.

## 4. Cross-cutting fail-closed invariants

These apply to every milestone and test suite:

1. A `found` record requires an exact normalized 8–14 digit UPC/GTIN and a nonblank product name. A provider SKU, URL token, image filename, brand, or name similarity is never sufficient.
2. Unknown registry pairs return no connector and become durable `connector_not_registered`; there is no default connector.
3. Every browser/document navigation, redirect, PDP link, and extracted image URL is HTTPS and allowlisted. Main-frame navigation is limited to the connector’s fixed storefront origin; separately declared asset hosts may be used only for display-only image candidates/subresources.
4. Every call uses the minimum of the engine deadline and connector-local bound, listens to the caller `AbortSignal`, and closes crawlers/pages/contexts/session state in `finally`.
5. Crawlee uses `useSessionPool: true`, `persistCookiesPerSession: false`, and session-pool persistence disabled. No cookie, credential, raw HTML, response header, or raw response is written to DB, logs, API responses, artifacts, or Crawlee state.
6. Runtime selector/login/origin/proxy overrides are rejected. Selectors and auth workflows are reviewed typed constants.
7. Production connector methods do not throw across the engine boundary. Unknown/oversized/malformed content returns a bounded stable `source_error`.
8. Evidence remains immutable and generation-scoped. All enabled providers are queried within the existing bounded generation; one provider does not short-circuit another.
9. Only identity fields participate in hard conflict detection. Merchandising fields may contribute warnings and provenance but never conflict rows or qualification blockers.
10. Materialization is deterministic, fetch-free, profile-free, OCR/model-free, URL-null, and atomic. New writes use `distributor_record_v2`; existing v1 rows are never rewritten.
11. Display-only distributor image candidates never populate `primaryImage`, `additionalImages`, `images_json`, OCR inputs, the downloader, a draft, or ShopSite without the existing PI-6 commerce approval boundary.
12. Price/inventory/stock status and arbitrary provider data remain absent even if fixture HTML contains them.
13. Mandatory Review, promotion provenance revalidation, the Sourcing route table, marker-v0 behavior, and the `bundle_to_curation` prohibition do not change.

---

# M1 — Connector type, independent schema migration, client type, and pair-keyed registry

## Files to modify

- `src/db/distributor-v2-migration.sql`
- `src/db/migrations.ts`
- `src/onboarding/sourcing/contracts.ts`
- `src/shared/schemas/distributor.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx`
- `src/onboarding/sourcing/connector-registry.ts`
- `src/tests/unit/db-migration.test.ts`
- `src/tests/unit/sourcing-contracts.test.ts`
- `src/tests/unit/sourcing-engine.test.ts`
- `src/tests/unit/distributor-v2.test.ts`
- `src/tests/unit/distributor-settings-panel.test.tsx`

## File-level work

### `src/db/distributor-v2-migration.sql`

Change the fresh-table `connector_type` CHECK to the exact closed set `api | ftp_catalog | csv | html_scraper | legacy_adapter`. Keep `enabled INTEGER NOT NULL DEFAULT 0`, all FKs, columns, and indexes unchanged.

### `src/db/migrations.ts`

Add a separate migration named by app-meta marker `distributor_html_scraper_schema_version = 1`. It must run after the distributor-v2 table exists and independently of both `distributor_v2_schema_version` and `default_on_sourcing_schema_version`.

Migration algorithm:

1. Read the new marker and the stored table DDL from `sqlite_master`; inspect columns/defaults through `PRAGMA table_info(distributor_connections)`.
2. If marker `1` exists, verify the stored CHECK contains the exact `html_scraper` member and `enabled` still defaults to `0`. Marker/schema drift throws; it is not silently repaired.
3. If the marker is absent, run one transaction with deferred FK checking. If the stored CHECK lacks `html_scraper` (or the enabled default is not the current fail-closed default), rebuild into a new table with the exact current schema.
4. Copy every named column explicitly. Preserve all row IDs and every row’s current `enabled` value, including operator-controlled enabled rows. Do not rewrite connector types or secret refs.
5. Recreate `idx_distributor_connections_workspace` and every currently defined table index.
6. Verify before/after row count and sorted IDs, then run `PRAGMA foreign_key_check`. Any mismatch or FK result throws and rolls the transaction back.
7. Insert the new marker last. A failed rebuild leaves the old table intact and the marker absent.
8. A fresh DB already has the correct CHECK from the SQL file; the block validates shape and writes only its marker. Fresh and legacy-upgrade DDL must converge exactly.

Do not leave the Amendment B rebuild gated only by the old Amendment A marker.

### `src/onboarding/sourcing/contracts.ts`

Add `html_scraper` to the closed tuple/type guard and update comments. Do not add `not_found`, `auth_failed`, or `wrong_variant` as outcome literals.

### `src/shared/schemas/distributor.ts`

Add `html_scraper` to `DistributorConnectorTypeEnum`. Retain recursive credential rejection and opaque `secretRef` validation. `legacy_adapter` remains parse-compatible but unregistered.

### `src/client/onboarding-api.ts` and `DistributorConnectionsPanel.tsx`

Add `html_scraper` to the client union and selectable connector list. When selected, the form must explain that storefront URL, origins, selectors, login flow, and proxy policy are fixed in code; hide/disable the generic base-URL override for this type. The form continues to send `enabled` only through the later explicit PATCH, never on create.

### `src/onboarding/sourcing/connector-registry.ts`

Replace the hidden `configuration.__distributorId` dispatch with an explicit signature taking `connectorType`, `distributorId`, and non-secret configuration separately. Back the default registry with exact pair keys.

M1 registers/preserves existing API mappings only:

- `api + phillips` and existing `endless_aisles` compatibility alias → Phillips REST connector (`providerId=phillips`).
- `api + bci` and existing `ordercloud` compatibility alias → BCI REST connector (`providerId=bci`).

M3/M4 add scraper factories. Until then an `html_scraper` pair remains deliberately unregistered and fails closed. `FixedConnectorRegistry` must adopt the new signature while remaining a deterministic test seam.

## Tests

### `src/tests/unit/db-migration.test.ts`

Add cases that assert:

- Fresh schema accepts `html_scraper` and rejects an unknown value such as `browser_scraper`.
- A pre-Amendment-B DB with `default_on_sourcing_schema_version` already present still runs the new migration (the regression the current dirty implementation misses).
- Upgrade preserves rows, IDs, every enabled value, secret refs, config JSON, and authority JSON.
- The new marker is written once and only after success.
- A second migration run is a no-op.
- Injected FK failure rolls back the table swap and leaves the new marker absent.
- `PRAGMA foreign_keys` remains enabled.
- Fresh and upgraded `sqlite_master` table/index definitions converge, not merely their column lists.

### Contract/UI/registry tests

- `sourcing-contracts.test.ts`: exact closed set and rejection of `browser_scraper`/unknown types.
- `sourcing-engine.test.ts`: engine passes explicit distributor ID to the registry; no `__distributorId` key enters connector configuration.
- `distributor-v2.test.ts`: an `html_scraper` connection creates disabled by default; raw username/password keys or credential-bearing URLs in configuration still fail.
- `distributor-settings-panel.test.tsx`: selector includes `html_scraper`, base URL is not offered for it, creation remains disabled, and enablement remains a separate confirmation.
- Add `src/tests/unit/sourcing-connector-registry.test.ts`: exact pair dispatch, API/scraper collision resistance, aliases only where explicitly declared, unknown pair/null behavior, and `legacy_adapter` never registered.

## Verification

```bash
bunx vitest run src/tests/unit/sourcing-contracts.test.ts src/tests/unit/db-migration.test.ts src/tests/unit/distributor-settings-panel.test.tsx src/tests/unit/sourcing-connector-registry.test.ts
bun test src/tests/unit/distributor-v2.test.ts src/tests/unit/sourcing-engine.test.ts
bun run typecheck
git diff --check
```

## M1 definition of done

- A previously marked Amendment A installation gains the new CHECK through the independent marker.
- Fresh and upgraded DBs have identical final distributor-connection DDL.
- No existing row value changes.
- Server, shared schema, client, and UI agree on the exact connector set.
- Registry identity is an explicit pair; no pair can silently collide or fall back.

---

# M2 — Bounded Crawlee session/auth core and normalized merchandising contract

## Files to create

- `src/onboarding/sourcing/html-scraper/contracts.ts`
- `src/onboarding/sourcing/html-scraper/login-config.ts`
- `src/onboarding/sourcing/html-scraper/session-runner.ts`
- `src/onboarding/sourcing/html-scraper/html-utils.ts`
- `src/tests/unit/sourcing-html-scraper-auth.test.ts`
- `src/tests/unit/sourcing-html-scraper-session.test.ts`
- `src/tests/unit/sourcing-html-scraper-html-utils.test.ts`
- `src/tests/unit/sourcing-secret-resolver.test.ts`

## Files to modify

- `src/onboarding/sourcing/contracts.ts`
- `src/shared/schemas/distributor-evidence.ts`
- `src/onboarding/sourcing/engine.ts`
- `src/onboarding/sourcing/secret-resolver.ts`
- `src/onboarding/sourcing/connectors/phillips.ts`
- `src/onboarding/sourcing/connectors/bci.ts`
- `src/server/routes/distributor-routes.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx`
- `src/server/index.ts`
- `src/tests/unit/sourcing-contracts.test.ts`
- `src/tests/unit/sourcing-engine.test.ts`
- `src/tests/unit/sourcing-phillips-connector.test.ts`
- `src/tests/unit/sourcing-bci-connector.test.ts`
- `src/tests/unit/distributor-routes.test.ts`

## Core contracts

### `html-scraper/contracts.ts`

Define server-only types for:

- `LoginAutomationConfig`: fixed login URL; ordered username, password, submit, success, and failure selector chains; login-URL failure indicators; timeout.
- `HtmlScraperRuntimePolicy`: provider ID, one fixed navigation origin, separately fixed asset-host allowlist, response cap, max requests, request/navigation timeout, per-provider requests/minute, session TTL, retry count, and whether Playwright/Browser fallback is permitted.
- A strict non-secret connection config. Permit only bounded operational reductions (for example, a lower timeout/rate). Reject selectors, login URLs, origins, proxy fields, headers/cookies, and values above code-owned ceilings.
- A runner result that contains only final allowlisted URL, sanitized HTML passed directly to a parser callback, stable telemetry, and stable failure code. It must not expose cookies, credentials, headers, or raw responses outside the in-memory callback.

Hard defaults/ceilings for v1:

- One request at a time per connection.
- Session TTL 15 minutes (recovered from BayState auth manager).
- At most one normal request retry and exactly one authentication re-login; no unbounded Crawlee session rotation.
- `retryOnBlocked: true`, but bounded by the above retry/session limits.
- HTML cap 6 MiB (raised from 2 MiB after live smoke: SFCC renders ~2.9 MiB; see html-scraper/contracts.ts).
- Default maximum 12 requests/minute for public connectors and 6 requests/minute for authenticated connectors; configuration may lower these values, not raise them.
- No proxy configuration.

### `login-config.ts`

Port the current `auth.py` constants as primary authority, using legacy YAML only for ordered fallback failure indicators:

| Provider | Login URL | Username | Password | Submit | Success | Failure | Timeout |
|---|---|---|---|---|---|---|---|
| `orgill` | `https://www.orgill.com/index.aspx?tab=8` | `#cphMainContent_ctl00_loginOrgillxs_UserName` | `#cphMainContent_ctl00_loginOrgillxs_Password` | `#cphMainContent_ctl00_loginOrgillxs_LoginButton` | `#btnMyProfile` | `#cphMainContent_ctl00_loginOrgillxs_FailureText`, `.validation-summary-errors`, then YAML `.login-error` | 60 s, always capped by remaining engine deadline |
| `phillips_storefront` | `https://shop.phillipspet.com/ccrz__CCSiteLogin` | `#emailField` | `#passwordField` | `#send2Dsk` | `a.doLogout.cc_do_logout` | `.cc-error-message`, `.login-error`, then YAML `.sfdc_notificationToastMessage` | 60 s, capped |
| `pet_food_experts` | `https://orders.petfoodexperts.com/SignIn` | `#userName` | `#password` | `button[data-test-selector='signIn_submit']` | `[data-test-selector='header_userName']` | `[data-test-selector='signIn_error']`, then YAML `.validation-summary-errors`, `.login-error` | 30 s, capped |

Bradley and Central Pet have no login config.

### `secret-resolver.ts`

Keep existing environment-then-`api_keys` resolution. Add a strict parser for the resolved `html_scraper` secret JSON. It accepts exactly nonblank string fields `username` and `password`; it does not coerce, echo Zod issues, trim/alter a valid password, or accept extra credential fields. Missing/masked remains `secret_missing`; malformed JSON/object/blank fields becomes `credential_invalid` without including the input in logs/messages.

The `api_keys.service` value is the opaque `secret_ref`; its secret value is JSON. No endpoint returns either the ref or the parsed credentials.

### Public connections and engine behavior

Add explicit connector metadata such as `requiresSecret` to the registry/connector contract. The engine resolves a secret only when required. Bradley and Central Pet must be invokable with `secretRef=null`; the current unconditional `secret_missing` behavior must not remain. Existing Phillips/BCI API connectors and the three authenticated scrapers require secrets.

Expose `secretRequired` in the server/client connection view. For public connectors, the UI displays “no secret required,” not a misleading “secret missing.” Unknown/unregistered pairs remain fail-closed and are never presented as healthy.

### Normalized record extension

Extend `DistributorCatalogRecord` and `ProductIdentityEvidenceSchema` with explicit, bounded fields rather than placing merchandising data in `attributes`:

- `distributorSku` (retain `distributorUpc` only as backward-compatible REST input during the transition; engine persistence prefers explicit `distributorSku`).
- `features: string[]`.
- `category`, `dimensions`, `casePack`, `unitOfMeasure`, and `ingredients` as nullable strings.
- Existing `description` and `imageUrls/images` remain.
- Connector variant-axis declarations may be carried explicitly and persisted through `InsertEvidenceAttempt.variantAxisDeclarations`; remove the current type-cast escape hatch.

`attributes` is reserved for built-in or explicitly declared variant axes. Merchandising keys in `attributes` would be treated as unknown variant axes and are therefore forbidden.

Apply bounded schema validation: HTTPS URLs only; finite list sizes; bounded strings/attribute counts; valid observation timestamps. An oversized record fails as `source_error:record_too_large`; it is not silently truncated into authoritative evidence.

Update existing REST connectors to populate the new fields with their current data or explicit null/empty values, preserving their provider IDs and behavior.

### `session-runner.ts`

Implement a dedicated sourcing runner; do not reuse `src/extraction-worker/browser/rendered-page-runner.ts` because that runner enables cookie persistence and proxy support.

Required behavior:

1. Set/create a unique per-run Crawlee storage directory under the already ignored `.baystate-cms/artifacts/crawlee-storage/sourcing/` before lazily importing Crawlee. Supply a per-instance `Configuration`; delete the directory in `finally`.
2. Configure `useSessionPool: true`, `persistCookiesPerSession: false`, and `sessionPoolOptions.persistenceOptions.enable=false`. Keep cookie headers/browser contexts only in a process-local map keyed by connection ID and an in-memory secret digest; credential rotation invalidates the prior session.
3. Serialize login per connection so concurrent item lookups cannot stampede a portal. Reuse a valid session up to the 15-minute TTL.
4. For authenticated static requests, copy cookies from the successful Playwright context into an in-memory request header; do not ask Crawlee to persist them.
5. If search/PDP returns a recognized login page or auth status, retire/clear the session and perform exactly one re-login, then retry the interrupted flow once. A repeat becomes durable `auth_failed`/`auth_expired`.
6. Compose the caller signal and absolute deadline. A pre-aborted or expired request starts no crawler. During abort/timeout, stop the crawler, close page/context/browser, clear per-call state, and return `cancelled` or `timeout`.
7. Validate the initial URL, every redirect `Location`, final URL, clicked/enqueued PDP URL, and browser main-frame navigation. Block an off-origin navigation before following it. Browser subrequests are limited to fixed page/asset hosts; unknown hosts are aborted.
8. Check `Content-Length` when available and actual Cheerio raw-body / rendered `page.content()` byte length before parsing. Over-cap content becomes `body_too_large`.
9. Emit only structured events (`providerId`, stable code, retry count, duration). Redact error text and never log username, password, cookies, authorization headers, raw markup, response snippets, or resolved query values.
10. Export a bounded `closeAllHtmlScraperSessions()` and invoke it from an asynchronous server shutdown path before process exit.

### `html-utils.ts`

Provide pure helpers for ordered selector fallback, text/list extraction, GTIN normalization/equality, same-origin URL resolution, HTTPS image filtering, duplicate removal, and result/no-result/auth marker detection. These helpers must accept fixture strings and have no network, DB, env, or logging side effects.

## Tests

- Credential JSON: valid object, malformed JSON, array, extra key, blank user/password, UI mask, and sentinel-secret redaction.
- Public secret behavior: Bradley/Central connector is called with `secret=null`; required connectors still persist `secret_missing` before execution.
- Session reuse, 15-minute expiry, credential-change invalidation, per-connection login lock, exactly one re-login, and second failure code.
- Assert the constructed Crawlee options have cookie persistence false, session persistence disabled, no proxy, bounded retries/concurrency/rate.
- Pre-abort and expired deadline create no crawler; mid-flight abort/timeout closes all injected resources.
- Same-origin redirects pass; cross-origin initial URL/redirect/PDP/main-frame navigation fails `origin_blocked`.
- Declared asset URL passes; HTTP, userinfo, unknown host, and overlong/over-cap content fail/drop as specified.
- Capture logger output with unique username/password/cookie/HTML sentinels and assert none appears.
- Runtime record schema rejects invalid URLs, unbounded lists/strings, merchandising fields hidden in variant `attributes`, and malformed found results.
- Existing REST connector fixture expectations remain unchanged apart from explicit new null/empty fields.

## Verification

```bash
bunx vitest run \
  src/tests/unit/sourcing-secret-resolver.test.ts \
  src/tests/unit/sourcing-html-scraper-auth.test.ts \
  src/tests/unit/sourcing-html-scraper-session.test.ts \
  src/tests/unit/sourcing-html-scraper-html-utils.test.ts \
  src/tests/unit/sourcing-contracts.test.ts \
  src/tests/unit/sourcing-phillips-connector.test.ts \
  src/tests/unit/sourcing-bci-connector.test.ts
bun test src/tests/unit/sourcing-engine.test.ts src/tests/unit/distributor-routes.test.ts
bun run typecheck
git diff --check
```

## M2 definition of done

- Public scrapers no longer require fake secrets.
- Auth credentials parse only from server-resolved JSON and never cross/log/persist.
- Cookie/session persistence is disabled by construction and proven by tests.
- Deadline, abort, origin, redirect, response-size, retry, and rate limits fail closed.
- The normalized record can carry every Amendment B field without weakening variant conflict semantics.

---

# M3 — Tier 1 public connectors: Bradley and Central Pet

## Files to create

- `src/onboarding/sourcing/connectors/bradley.ts`
- `src/onboarding/sourcing/connectors/central-pet.ts`
- `src/tests/unit/sourcing-bradley-connector.test.ts`
- `src/tests/unit/sourcing-central-pet-connector.test.ts`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/manifest.json`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/found-search.html`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/found-pdp.html`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/not-found.html`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/wrong-variant-pdp.html`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/unexpected-markup.html`
- `src/tests/fixtures/sourcing/html-scrapers/bradley/expected.json`
- Equivalent `manifest.json`, search/PDP outcome HTML, and `expected.json` files under `src/tests/fixtures/sourcing/html-scrapers/central_pet/`.

## Files to modify

- `src/onboarding/sourcing/connector-registry.ts`
- `src/tests/unit/sourcing-connector-registry.test.ts`

## Fixture capture contract (applies to M3 and M4)

Fixtures are manually captured, sanitized DOM snapshots—not automated production response persistence. For every HTML file, the provider manifest records:

- schema version, provider ID, fixture filename, scenario, source URL, capture date/time, TEST_SKU, expected product name/brand, BayState source revision, capture method (`manual_sanitized_dom` or clearly marked `synthetic_captured_shape`), SHA-256, redactions performed, and `containsCredentials=false`.
- The source URL must pass that connector’s navigation allowlist. Authenticated captures remove account names, form values, hidden anti-CSRF values, cookies, order data, and unrelated account navigation.
- Store the smallest DOM fragment that preserves result/no-result/auth/PDP selectors. Never store response headers or browser storage.
- `expected.json` freezes the reviewed field-level ground truth produced by the old Python adapter against the same sanitized snapshot. It includes exact expected values for all nonblank supported fields and explicit absence of price/inventory/stock/arbitrary data.
- Tests verify manifest hash, timestamp syntax, source host, scenario coverage, and expected-file schema before parsing HTML.

No automated test may recapture or contact a site.

## Bradley connector design

**Registration:** `html_scraper + bradley`; `providerId=bradley`; `requiresSecret=false`.  
**Navigation origin:** `https://www.bradleycaldwell.com`.  
**Asset hosts:** only the Bradley/BigCommerce hosts recovered in `distributor-catalog.ts`; asset permission never grants document navigation.  
**Search template:** `https://www.bradleycaldwell.com/search?term={encodedIdentifier}`.  
**Engine:** Cheerio search and PDP; one Playwright fallback only when recognized static-shell/blocked markers show the page needs rendering.

Field map:

| Normalized field | Recovered source |
|---|---|
| name | non-search `main h1`; BigCommerce product-link/aria-label fallback |
| brand | link in paragraph preceding PDP `h1`; product-card `text-sm` fallback |
| exact UPC/GTIN | `dt/dd` UPC or `UPC Code` text; this alone establishes the engine match |
| distributor SKU | `BCI Item Number` / `BCI#`; never a lookup authority |
| MPN | `Manufacturer #`, `MFG #`, or `Model #` |
| weight | labeled Weight element |
| built-in variants | `Size`; `Case Pack` also maps to identity `packCount` when numeric/meaningful |
| description | product-description/prose, then bounded main-section paragraph fallback |
| category | breadcrumb text (noncanonical distributor category) |
| dimensions | labeled Dimensions text |
| case pack / UOM | `dt/dd` or reviewed labeled-text fallback |
| ingredients | labeled Ingredients text |
| features | empty unless a reviewed Bradley fixture exposes an explicit feature list |
| images | product gallery / provider BigCommerce CDN URLs, HTTPS + asset allowlist only |

Do not copy price, availability, stock, recommendation-card images, `type`, or unreviewed text fields.

### Item-number exact-match directive (2026-08-15)

PFX lookups accept an 8–14 digit identifier that EXACTLY equals the PDP Item # (digits-only) when the page also carries a real UPC/EA — `33011808` now resolves to the Dave's product (EA 685038118080) instead of `wrong_variant`. Exact equality only; UPC-less pages never match; `distributorUpc` carries the real barcode through the identity schema. See ADR 0014 Amendment B addendum.

### Bradley `001135` ruling

`001135` is six digits and cannot pass the existing 8–14 digit `normalizeGtin` contract. It is retained only as a parser/search-URL regression fixture for the historical BCI-number logic. It must never be used as an engine lookup identifier, and the extracted BCI number flows only to `distributorSku`.

The end-to-end `found` fixture and live smoke require a verified 8–14 digit UPC from a Bradley PDP, with PDP URL and capture date in the manifest. If no real UPC is available during offline fixture work, a clearly labeled synthetic valid UPC may be inserted into captured-shape unit HTML, but it cannot satisfy live-smoke or rollout evidence.

## Central Pet connector design

**Registration:** `html_scraper + central_pet`; `providerId=central_pet`; `requiresSecret=false`.  
**Navigation origin/assets:** `https://www.centralpet.com` only unless a reviewed fixture proves another catalog-approved asset host.  
**Search template:** `https://www.centralpet.com/Search?criteria={encodedIdentifier}`.  
**Engine:** Playwright renders the Angular search/PDP; pure Cheerio parsing runs on the bounded rendered HTML. Wait for one of `#tst_productDetail_erpDescription`, `.isc-productContainer`/product list, `span.no-results-found`, or `.no-results` within the remaining deadline. Stealth/proxy behavior is not ported.

Field map:

| Normalized field | Recovered source |
|---|---|
| name | `#tst_productDetail_erpDescription`, fallback `h1` |
| brand | `a[ng-if='vm.product.brand.detailPagePath']`, rejecting Angular template artifacts |
| exact UPC/GTIN | product-spec label containing UPC, fallback `.upc span` |
| distributor SKU | Central `Product #` (kept as distributor SKU, never the UPC lookup proof) |
| MPN | product-spec `Mfg Part #`, fallback `.mfg-part-num span` |
| weight | `Product Gross Weight` labeled item |
| case pack / packCount | product-spec `Case Qty`; preserve explicit case-pack copy and built-in pack axis |
| description | `#tst_productDetail_htmlContent` |
| features | feature list, then reviewed responsive-accordion labeled values |
| dimensions | deterministic Height/Length/Width list, then reviewed Dimension fallback |
| category | breadcrumb text |
| UOM / ingredients | null unless a reviewed current fixture exposes a dedicated label |
| images | `#tst_productDetail_imageZoom img`, then reviewed product-image fallbacks |

Exclude sell-pack quantity and pallet quantity unless the former is explicitly reviewed as the same semantic case-pack field; pallet quantity, safety info, stock, price, and other provider fields never materialize.

**Recovered test case:** `38777520`, expected name `KONG Air Dog Squeaker Tennis Ball Dog Toy`, brand `KONG`.

## Required tests per connector

For Bradley and Central Pet:

- `found`: exact requested UPC in parsed PDP, expected name/brand, full field map, HTTPS display-only images, and correct provider ID.
- `not_found`: only explicit no-result fixture yields `not_stocked:no_exact_match`.
- `wrong_variant`: valid page with a different UPC/GTIN yields `not_stocked:wrong_variant`; name/brand similarity cannot override it.
- `source_error`: unexpected shell, body cap, off-origin PDP, parser exception, or injected transport failure becomes the expected stable code.
- Auth is not applicable: assert `requiresSecret=false`, no login runner call, and null/malformed optional secret material is ignored rather than parsed.
- Bradley-specific: static path succeeds without Playwright; recognized JS shell invokes exactly one browser fallback; unrecognized markup does not trigger unlimited fallback.
- Central-specific: wait markers, final navigation origin, and no-result behavior are tested with injected rendered HTML.
- Assert no record contains price, inventory, stock status, pallet quantity, cookies, or raw HTML.

## Verification

```bash
bunx vitest run \
  src/tests/unit/sourcing-bradley-connector.test.ts \
  src/tests/unit/sourcing-central-pet-connector.test.ts \
  src/tests/unit/sourcing-connector-registry.test.ts \
  src/tests/unit/sourcing-html-scraper-session.test.ts
bun run typecheck
git diff --check
```

## M3 definition of done

- Both exact registry pairs return their own provider IDs and run with no secret.
- Every result path is offline-fixture tested and exact-identifier safe.
- Bradley browser fallback and Central JS rendering remain bounded.
- Fixture provenance and reviewed ground truth are complete; `001135` is not used as a GTIN.

---

# M4 — Tier 2 authenticated connectors: Orgill, Pet Food Experts, Phillips Storefront

## Files to create

- `src/onboarding/sourcing/connectors/orgill.ts`
- `src/onboarding/sourcing/connectors/pet-food-experts.ts`
- `src/onboarding/sourcing/connectors/phillips-storefront.ts`
- `src/tests/unit/sourcing-orgill-connector.test.ts`
- `src/tests/unit/sourcing-pet-food-experts-connector.test.ts`
- `src/tests/unit/sourcing-phillips-storefront-connector.test.ts`
- For each provider ID under `src/tests/fixtures/sourcing/html-scrapers/`: `manifest.json`, `found-search.html` where applicable, `found-pdp.html`, `not-found.html`, `wrong-variant-pdp.html`, `auth-required.html`, `auth-failed.html`, `unexpected-markup.html`, and `expected.json`.

## Files to modify

- `src/onboarding/sourcing/connector-registry.ts`
- `src/tests/unit/sourcing-connector-registry.test.ts`

## Orgill

**Pair/provider:** `html_scraper + orgill`; `providerId=orgill`; secret required.  
**Origin:** `https://www.orgill.com`.  
**Search:** `https://www.orgill.com/SearchResultN.aspx?ddlhQ={encodedIdentifier}`.  
**Flow:** Playwright performs the ASP.NET login by loading the fixed page and clicking the real submit control so hidden postback/viewstate fields remain browser-owned. After the success indicator, authenticated static pages are parsed with Cheerio. A returned login form (`UserName`/`Password` selectors) triggers the one re-login.

Field map:

- Name: `#cphMainContent_ctl00_lblDescription`, then `h1`, then reviewed YAML `[data-product-name]`.
- Brand: `#cphMainContent_ctl00_lblVendorName`.
- Exact UPC: `#cphMainContent_ctl00_lblUPCCode`, fallback retail UPC/reviewed labeled value.
- Distributor SKU: `#cphMainContent_ctl00_lblOrgillItemNumber`.
- MPN: `#cphMainContent_ctl00_lblModelNumber`.
- Weight/Dimensions: reviewed strong-label sibling chains.
- Description: long then short description, followed by reviewed YAML fallbacks.
- Category: department then breadcrumb.
- Features: features list and ordered reviewed fallbacks.
- Case pack and UOM: reviewed strong-label sibling values; case pack also supplies built-in `packCount` when semantically valid.
- Images: multiple-image carousel then product-detail images, same provider host only.
- Ingredients: null unless a reviewed explicit current selector exists.

Material/NPK and all arbitrary fields are excluded.

**TEST_SKU:** `755625321923`; expected name and brand from `run_adapter_test.py` (`Landscapers Select … 45 in L Handle`, `LANDSCAPERS SELECT`).

## Pet Food Experts

**Pair/provider:** `html_scraper + pet_food_experts`; `providerId=pet_food_experts`; secret required.  
**Origin:** `https://orders.petfoodexperts.com`; approved asset hosts are restricted to the current catalog list, including `cdn.insitecloud.net`.  
**Search:** `https://orders.petfoodexperts.com/Search?query={encodedIdentifier}`.  
**Flow:** Playwright login, then authenticated rendered/static search and PDP extraction. Search links must contain an exact candidate in their card; final `found` still requires the PDP’s extracted UPC/EA field to equal the requested normalized identifier. Item number or image filename alone cannot establish the match.

Field map:

- Name: `h1`, then `[data-test-selector='product-name']`.
- Brand: parsed from the specifications block’s `Brand:` label using the bounded reviewed regex.
- Exact UPC/GTIN: product-meta `UPC#`/`EA` expression; this is the match authority.
- Distributor SKU: product-meta `Item #`.
- Weight: labeled specification value.
- UOM: `[data-test-selector='productPrice_unitOfMeasureLabel']`, stripping only the presentation slash.
- Description, features, ingredients: their dedicated `data-test-selector` chains and reviewed class fallbacks.
- Category: breadcrumb.
- Images: main/product image selector chain, normalized quality suffixes, HTTPS and approved assets only.
- Built-in variants: only reviewed built-ins such as flavor; other pet facets are excluded unless deliberately declared as identity axes and covered by conflict tests.
- Dimensions/case pack: null unless current reviewed fixture exposes dedicated fields.

Stock status/add-to-cart inference, price, and unreviewed facets are excluded.

**TEST_SKU:** `33011808`; expected name `Wellness CORE Grain Free`, brand `Wellness`. If live HTML exposes only a distributor item number and no exact UPC/EA, the connector must return non-found rather than weaken the contract.

## Phillips Storefront

**Pair/provider:** `html_scraper + phillips_storefront`; `providerId=phillips_storefront`; secret required. The existing `api + phillips` connector remains untouched and can run in the same generation.  
**Origin:** `https://shop.phillipspet.com`; display-only assets may use the reviewed `d56ygyjv466yj.cloudfront.net` host.  
**Search:** `https://shop.phillipspet.com/ccrz__ProductList?cartID=&operation=quickSearch&searchText={encodedIdentifier}&portalUser=&store=DefaultStore&cclcl=en_US`.  
**Flow:** Playwright login and SFCC/Backbone search interaction; rendered search/PDP HTML is fed to pure parsers. Follow a reviewed product link or the recovered `ccrz__ProductDetails?sku={itemNumber}` template only after the search candidate has an exact UPC match and the URL passes the origin policy.

Field map:

- Search card: name, brand, UPC, item number (distributor SKU), weight, description, feature list, and candidate images from the recovered `#plp-desktop-row`/row-container selector chain.
- PDP: detailed description/features, weight/ship weight, dimensions, UPC, breadcrumb category, built-in flavor/formula/size fields when explicitly labeled, and filtered detail/alternate images.
- MPN, case pack, UOM, and ingredients remain null unless a reviewed fixture exposes dedicated semantics.

Do **not** port the Python adapter’s brand/name heuristic acceptance. Exact identifier mismatch always returns `not_stocked:wrong_variant`, even if brand and title overlap. Hidden scanner/template rows cannot win or synthesize a product result.

**TEST_SKU:** `072705115310`; expected name `Fromm Gold Large Breed Dog 30 lb`, brand `FROMM FAMILY FOODS LLC`.

## Required tests per authenticated connector

Each connector must cover:

1. `found` with exact UPC/GTIN and reviewed full field map.
2. Explicit `not_found` → `not_stocked:no_exact_match`.
3. Wrong UPC/variant → `not_stocked:wrong_variant`; advisory name/brand never rescues it.
4. Missing secret, malformed credential JSON, invalid login, login-form return, expired cached session, one successful re-login, and failure after exactly one re-login.
5. Transport timeout, caller cancellation, blocked response, origin/redirect violation, body cap, parser error, and unexpected markup → bounded `source_error`.
6. Selector fallback order: primary selector wins; each recovered fallback is exercised; an unrecognized DOM fails closed.
7. Search→PDP stays within provider navigation origin, while only validated image URLs use asset hosts.
8. Credentials/cookies/raw HTML and price/inventory fields are absent from result, logs, storage, and thrown text.
9. Provider IDs are exact, especially `phillips_storefront` rather than `phillips`.

## Verification

```bash
bunx vitest run \
  src/tests/unit/sourcing-orgill-connector.test.ts \
  src/tests/unit/sourcing-pet-food-experts-connector.test.ts \
  src/tests/unit/sourcing-phillips-storefront-connector.test.ts \
  src/tests/unit/sourcing-html-scraper-auth.test.ts \
  src/tests/unit/sourcing-html-scraper-session.test.ts \
  src/tests/unit/sourcing-connector-registry.test.ts
bun run typecheck
git diff --check
```

## M4 definition of done

- All three connectors reuse memory-only sessions, perform at most one re-login, and return stable redacted failures.
- Every selector/search/PDP/field mapping is covered by provenance-stamped offline fixtures.
- Phillips heuristic matching is removed at the TS boundary.
- Existing Phillips REST and BCI REST connectors remain registered and behaviorally unchanged.

---

# M5 — Amendment B projection, v2 materializer, frozen evidence, Curation, and promotion compatibility

## Files to modify

- `src/shared/schemas/distributor-evidence.ts`
- `src/shared/schemas/onboarding.ts`
- `src/onboarding/sourcing/engine.ts`
- `src/onboarding/sourcing/distributor-record-projection.ts`
- `src/onboarding/sourcing/distributor-record-materializer.ts`
- `src/db/repositories/onboarding-extraction-repo.ts`
- `src/onboarding/curation-cohort-service.ts`
- `src/shared/schemas/cohorts.ts`
- `src/onboarding/cohort-curator.ts`
- `src/classification/stages/evidence-extraction.ts`
- `src/classification/cohort-product-type-resolver.ts`
- `src/onboarding/product-curator.ts`
- `src/onboarding/draft-promoter.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/client/components/pipeline-drawer/ExtractionStagePanel.tsx`
- `src/onboarding/job-queue.ts` (comments/telemetry only; no route change)

## Tests to update

- `src/tests/unit/sourcing-distributor-projection.test.ts`
- `src/tests/unit/distributor-record-materializer.test.ts`
- `src/tests/unit/sourcing-default-on-e2e.test.ts`
- `src/tests/unit/sourcing-pass-through.test.ts`
- `src/tests/unit/sourcing-recovery-acceptance.test.ts`
- `src/tests/unit/evidence-extraction.test.ts`
- `src/tests/unit/cohort-product-type-resolver.test.ts`
- `src/tests/unit/cohort-freeze.test.ts`
- `src/tests/unit/cohort-title-hash.test.ts`
- `src/tests/unit/cohort-page-hash.test.ts`
- `src/tests/unit/curation-cohort-service.test.ts`
- `src/tests/unit/distributor-record-extraction-panel.test.tsx`
- `src/tests/unit/draft-promoter.test.ts`
- `src/tests/unit/onboarding-repos.test.ts`
- `src/tests/unit/distributor-v2.test.ts`

## Projection v2 contract

Retain the current v1 projection authority byte-for-byte as a read/verification function for historical materializations. Add v2 as the default authority for every newly computed decision.

- Historical version: `distributor-record-projection-v1`, identity-only.
- New version: `distributor-record-projection-v2`, identity plus Amendment B merchandising fields and provenance.
- `buildDistributorRecordProjection` produces v2 for new reconciliation/manual/automatic decisions.
- A named v1 builder remains for verifying existing v1 extraction rows at promotion/readiness.

V2 projection adds:

- `description`, `features`, `category`, `dimensions`, `casePack`, `unitOfMeasure`, `ingredients`, and `imageUrls`.
- Dedicated merchandising provenance grouped by field and source attempt, with attempt ID, provider ID, catalog version, connection ID, and the values that attempt supplied. Identity field provenance remains unchanged.

Deterministic merge:

1. Trim/drop blank values and validate bounds before projection.
2. Scalars use the existing deterministic lexical selection rule; confidence/model output never chooses a value. Provenance for the selected scalar contains only attempts that supplied that selected value.
3. Features use a case-insensitive sorted-unique union, preserving deterministic display spelling. Images use a sorted-unique HTTPS URL union. Their provenance includes every contributing attempt/value.
4. Different merchandising scalar values add a bounded `merchandising_disagreement:<field>` warning but never `open_hard_conflict`, a conflict row, or a qualification reason.
5. Missing merchandising fields do not block qualification. Exact identifier, name, complete provenance, current generation, and identity conflicts remain the qualification floor.
6. Case-pack data may also populate built-in identity `packCount`; disagreement on that identity axis remains hard even though the copy field itself is soft.
7. The v2 evidence hash covers all selected/merged fields and all associated provenance. Input order cannot alter it.

## Engine evidence persistence

Persist every normalized field into `identity_json` through the shared schema. Persist connector-declared variant axes through the typed repository input. Continue to place the real final source URL only in `evidence_url`. Raw HTML remains absent.

## Materialized `ExtractionData` v2

New materializations write `extraction_method='distributor_record_v2'` and:

| Projection field | Extraction payload |
|---|---|
| name/brand/weight/SKU/MPN/variants | Existing identity fields |
| description | `description` |
| features | `bulletPoints` |
| category | explicit `distributorCategory` (noncanonical text; never a Category Page ID) |
| dimensions | `dimensions` |
| case pack | explicit `casePack` |
| unit of measure | explicit `unitOfMeasure` |
| ingredients | explicit `ingredients` |
| image URLs | `distributorImageCandidates`, each with source attempt/provider IDs |

The payload still sets `price=null`, `primaryImage=null`, `additionalImages=[]`, `distributorImageApprovals=[]`, `sourceUrl=null`, confidence `0`, OCR/package fields null/disabled, and `customFields={}`. The DB row keeps `images_json=NULL`.

Extend `distributorRecordProvenance` with `projectionVersion`, `extractionMethod`, full per-field provenance, sorted provider/attempt/connection/catalog/observation identity, and the evidence hash. Preserve the existing abbreviated `fieldProvenance` only for generic UI compatibility; the dedicated provenance object is authoritative.

`raw_structured_data_json` may store only this normalized provenance, never raw provider data or HTML.

## V1/V2 compatibility and fail-closed dispatch

- Do not update/backfill existing v1 extraction rows or persisted cohort snapshots.
- `onboarding-extraction-repo.ts` accepts recognized methods `distributor_record_v1` and `distributor_record_v2`. Its finder must detect any existing distributor row—including a mis-shaped row with either method—so the materializer cannot insert a second row to hide divergence.
- A new no-row materialization writes v2 only when the decision hash matches the v2 projection. If a pre-deployment pending decision matches only v1, return a stable `projection_version_mismatch` and require an explicit new sourcing generation; do not silently add merchandising to a v1 decision.
- Idempotent retry dispatches by the existing row’s method and deep-compares the correct reconstructed payload.
- Curation readiness and promotion accept both methods but verify each with its corresponding projection/payload authority. Missing/unknown method fails closed.
- Promotion must deep-compare the current item payload and durable extraction JSON with the reconstructed expected v1/v2 payload, in addition to generation/hash/accepted-ID checks. This prevents a post-materialization description or image tamper from drafting.
- Existing v1 rows remain identity-only in classification and promotion. Only a verified v2 method/provenance may contribute merchandising fields.

## Frozen cohort/classification behavior

Add the explicit merchandising fields and dedicated provenance to the additive `execution-evidence-v2` member extraction schema with safe defaults so already persisted v2 bytes remain parseable. Do not rewrite old snapshots. New freezes include the fields in their content-addressed hash.

For verified v2 distributor members, live and frozen evidence extraction emits:

- source `distributor_record`, reliability unchanged, classification URL null;
- identity fields plus `description`, each feature as `bullet_point`, `distributor_category`, `dimensions`, `case_pack`, `unit_of_measure`, and `ingredients`;
- per-field distributor provenance on each evidence entry.

It still emits no search-keyword/custom arbitrary fields, price, inventory, claims inferred from copy, or image evidence. It never labels distributor data `official_product_page` and never treats distributor category text as a canonical taxonomy/Page identifier.

`cohort-product-type-resolver.ts` must mirror exactly the same source/field mapping so freeze-time deterministic matching and run-time evidence extraction cannot diverge.

## Curation and draft consumption

- `product-curator.ts` removes Amendment A’s blanket distributor-description suppression only for verified v2 materializations. It may use the materialized description/features/other explicit fields in classification/search-keyword synthesis and set `curatedDescription` deterministically from the materialized description with the corresponding source attempt IDs.
- Do not re-enable the model-backed `distributor-copy-consolidator.ts`; this migration’s merge authority is deterministic projection v2.
- Draft promotion prefers reviewed Curation description when present, then the verified v2 extraction description. V1/tampered/unverified distributor copy remains blocked.
- Price continues to come only from existing spreadsheet/manual authority, never distributor HTML.
- Distributor sources continue to pass null/empty image arguments to `downloadAndProcessImages` regardless of candidate URLs or payload tampering. PI-6 commerce-approved assets remain the only distributor-image commerce path.

## Extraction UI

Rename the distributor section from “identity-only” to “merchandising-depth.” Render the explicit description/features/category/dimensions/case/UOM/ingredients and full field provenance. Render image candidate URLs as text under an unmistakable “display only—not approved for catalog use” label; do not render `<img>` elements that would fetch them. Never render price/inventory/arbitrary fields. Official-page UI remains unchanged.

## Precise test changes

### Projection tests

- Replace “projection is identity-only” with v2 inclusion assertions.
- Assert stable order-independent scalar/list merge and per-field/per-value provenance.
- Assert merchandising disagreement warns but qualifies; identity/variant disagreement still blocks.
- Assert price/inventory/arbitrary fields never enter projection.
- Assert merchandising drift changes v2 hash; input ordering does not.
- Retain v1 golden-hash/shape tests for historical verification.

### Materializer tests

Update the main success fixture to include all Amendment B fields. Assert:

- method `distributor_record_v2`, URL null, row provenance exact;
- description, bullet points, distributor category, dimensions, case pack, UOM, ingredients, and candidate URLs are present;
- candidate URLs carry attempt/provider provenance;
- price, primary/additional commerce images, approvals, `images_json`, OCR, arbitrary fields, stock, and inventory are absent;
- full per-field provenance matches the source attempt;
- no page extractor/profile lookup/OCR/VLM/model/image downloader is invoked.

Add multi-provider merchandising disagreement/union tests, v1 row compatibility, pre-deployment v1 pending-decision refusal, unknown method refusal, v2 idempotent retry, and tampered merchandising/provenance/image-candidate deep-compare failures.

Change the existing arbitrary-field test so reviewed description now materializes while price/inStock/leadTime/raw fields remain excluded.

### End-to-end/cohort/evidence/promotion tests

- Update `sourcing-default-on-e2e.test.ts` materialization/freeze assertions to v2 fields and method.
- Assert frozen/live distributor evidence contains supported merchandising fields with null URL and never official source labels/images/price/inventory.
- Assert candidate URLs survive only in display-only payload/provenance and cause zero fetches/OCR/downloads.
- Assert a reviewed valid v2 item can draft its verified description while mandatory image/review gates remain; tampering any v2 payload field blocks promotion.
- Assert historical v1 rows still pass their old authority checks and remain identity-only.
- Assert cohort/title/page hashes change when a v2 merchandising field changes, and historical snapshot parsing remains stable.
- Update UI tests to show merchandising fields/candidate labels while excluding commerce images and arbitrary data.

## Verification

```bash
bunx vitest run \
  src/tests/unit/sourcing-distributor-projection.test.ts \
  src/tests/unit/evidence-extraction.test.ts \
  src/tests/unit/cohort-product-type-resolver.test.ts \
  src/tests/unit/cohort-title-hash.test.ts \
  src/tests/unit/cohort-page-hash.test.ts \
  src/tests/unit/distributor-record-extraction-panel.test.tsx
bun test \
  src/tests/unit/distributor-record-materializer.test.ts \
  src/tests/unit/sourcing-default-on-e2e.test.ts \
  src/tests/unit/sourcing-pass-through.test.ts \
  src/tests/unit/sourcing-recovery-acceptance.test.ts \
  src/tests/unit/cohort-freeze.test.ts \
  src/tests/unit/curation-cohort-service.test.ts \
  src/tests/unit/draft-promoter.test.ts \
  src/tests/unit/onboarding-repos.test.ts
bun run typecheck
git diff --check
```

## M5 definition of done

- New decisions/hashes/materializations are v2 and carry all allowed merchandising fields with precise provenance.
- Merchandising never changes conflict/qualification authority.
- V1 rows remain readable/verifiable and are never rewritten or silently upgraded.
- Curation/classification can use verified v2 merchandising data; price/inventory/images/arbitrary data remain blocked.
- Promotion recomputes and deep-verifies the exact method-specific payload before drafting.

---

# M6 — Environment-gated live smoke tooling

## Files to create

- `scripts/sourcing-live-smoke.ts`
- `src/tests/unit/sourcing-live-smoke.test.ts`

## Files to modify

- `package.json` (add `sourcing:live-smoke` script only; do not add it to `test`/CI)
- Optionally `src/onboarding/sourcing/html-scraper/live-smoke-catalog.ts` if shared TEST_SKU metadata is needed by the CLI and tests.

## CLI contract

Invocation is explicit, for example through `bun run sourcing:live-smoke -- --provider <id> ...`. The script:

1. Refuses to run unless `BAYSTATE_CMS_SOURCING_LIVE_SMOKE=1` exactly.
2. Refuses when `CI` is set.
3. Accepts only one exact provider ID per invocation; there is no accidental default “all.” An explicit repeated/`--all` operation, if provided, remains sequential.
4. Never accepts username/password/cookie/token as CLI arguments. Auth uses an opaque `--secret-ref` resolved through the same secret resolver (environment or an explicitly opened read-only DB/repository path). Public providers require no ref.
5. Calls the connector directly—not `DefaultSourcingEngine`—so it writes no generation/evidence/decision/extraction rows. Any DB used for `api_keys` lookup is opened read-only and no migrations run.
6. Uses the recovered TEST_SKUs, except Bradley: `001135` is refused as an engine identifier; Bradley requires the manifest’s verified real 8–14 digit UPC or an explicit verified `--upc`.
7. Uses the normal origin/deadline/rate/auth code, not a special permissive smoke transport.
8. Closes all sessions and exits nonzero on failed identity/expected-field checks.

## Report format

Print one JSON document and optionally write it to a mode-0600 `--report` path. Include:

- report schema version; provider/connector type; test UPC; expected name/brand when available;
- start/end timestamps and duration;
- terminal contract outcome and stable error code;
- exact-identifier-match boolean; matched field names; presence/count/length summaries for merchandising fields and images;
- evidence URL origin (not credentials/query secrets); login attempted, cache reused, and re-login count as booleans/counts only;
- redacted warnings; pass/fail and failed assertions.

Do not print credentials, cookies, headers, raw HTML, full descriptions/ingredients, or account identifiers. Exit `0` only for a passing expected result, `1` for a completed failing smoke, and `2` for gate/configuration refusal.

## Tests

With an injected fake registry/runner and no network, assert:

- gate/CI/provider/argument refusal;
- no credential CLI flags exist;
- Bradley `001135` refusal;
- expected report schema, redaction, exit codes, mode-0600 report file, and cleanup;
- script calls no DB writer/engine evidence writer;
- auth missing/malformed and connector failure remain stable report codes.

## Verification

```bash
bunx vitest run src/tests/unit/sourcing-live-smoke.test.ts
bun run typecheck
# Deliberately proves the default is inert; it must refuse before network:
bun run sourcing:live-smoke -- --provider bradley
git diff --check
```

The actual live command is a manual rollout action and is not run during implementation review.

## M6 definition of done

- Smoke is impossible without the explicit gate and impossible in CI.
- It reuses production policies but performs no CMS DB mutation.
- Reports are machine-readable, bounded, and credential-safe.

---

# M7 — Offline release integration, documentation convergence, and disabled-row readiness

## Files to create

- `src/tests/unit/distributor-scrapers-acceptance.test.ts` (Bun/SQLite, temporary DB, all connectors injected from fixtures)

## Files to modify

- `docs/runbooks/sourcing-engine-rollout.md`
- `docs/plans/distributor-scrapers-migration-plan.md` (implementation checklist/status only; do not rewrite ratified decisions)
- `CONTEXT.md`
- `AGENTS.md`
- `package.json` (register the new Bun DB acceptance file in `test:db` if automatic discovery does not run it)
- `src/tests/unit/distributor-routes.test.ts`
- `src/tests/unit/distributor-settings-panel.test.tsx`
- `src/tests/unit/sourcing-observe-mode.test.ts`

## Offline acceptance chain

The new acceptance suite must use only fixture-injected transports and a temporary DB. For each provider pair it proves:

1. A workspace-scoped connection creates disabled.
2. Enabling only in the temporary test DB causes the exact registered connector/provider ID to run.
3. A fixture `found` attempt persists the full normalized v2 evidence and accurate evidence URL; no raw HTML/credentials persist.
4. Exact-match qualification routes to `extraction/pending`, never Curation.
5. Materialization writes URL-null `distributor_record_v2` merchandising depth and completes Extraction.
6. Cohort freeze/classification retains distributor source/provenance and merchandising, with image/price/inventory boundaries intact.
7. Observe mode writes only generation/attempt rows even with v2 data; it writes no decision/acceptance/conflict/item transition/extraction.
8. Existing REST API and scraper flavors can both produce attempts in one generation and retain distinct provider IDs.
9. An injected wrong variant, auth failure, source error, and cross-provider identity conflict follow the existing route table.

## Documentation convergence

### `docs/runbooks/sourcing-engine-rollout.md`

Update every stale identity-only/SFTP clause:

- Connector inventory and five scraper IDs; API connectors remain.
- New migration marker `distributor_html_scraper_schema_version` and its verification.
- `distributor_record_v2` fields/provenance and v1 compatibility.
- Display-only `distributorImageCandidates` versus forbidden commerce images.
- Tier 1/Tier 2 provider order and TEST_SKUs, including the Bradley 001135 restriction.
- Secret JSON format described structurally only, with placeholders—not credentials.
- Read-only metrics grouped by connection and provider; permitted image candidates must not trip the forbidden-image audit.
- Rollback inventory includes v1/v2 methods and pending v1-decision `projection_version_mismatch` cases.

### `CONTEXT.md` and `AGENTS.md`

Replace remaining identity-only statements (including the current Extraction definition and AGENTS Sourcing/Profile text) with Amendment B merchandising depth, while retaining zero fetch/profile/OCR/model, null URL, display-only images, and price/inventory exclusion.

## Disabled connection-row checklist

Do not seed workspace-specific rows in a schema migration. After a verified backup, operators use the existing authenticated Settings/repository path to create exactly these rows; creation itself enforces `enabled=false`:

| distributorId | connectorType | secretRef | configuration | initial enabled |
|---|---|---|---|---|
| `bradley` | `html_scraper` | null | `{}` (fixed code constants) | false |
| `central_pet` | `html_scraper` | null | `{}` | false |
| `orgill` | `html_scraper` | `<operator-provisioned-secret-ref>` | `{}` | false |
| `pet_food_experts` | `html_scraper` | `<operator-provisioned-secret-ref>` | `{}` | false |
| `phillips_storefront` | `html_scraper` | `<operator-provisioned-secret-ref>` | `{}` | false |

The create path may ensure the distributor entity exists, as it does today. It must not change existing `phillips/api` or `bci/api` rows. No selector/login URL/proxy/credential is stored in `configuration_json`.

Route/UI tests assert all five payloads remain disabled, public secret status is truthful, auth refs remain masked, and an enable PATCH is separate.

## Verification

```bash
bun test src/tests/unit/distributor-scrapers-acceptance.test.ts src/tests/unit/distributor-routes.test.ts src/tests/unit/sourcing-observe-mode.test.ts
bunx vitest run src/tests/unit/distributor-settings-panel.test.tsx
bun run typecheck
bun run lint
git diff --check
```

## M7 definition of done

- One offline test demonstrates the full engine-to-Curation boundary for all five providers.
- Governing docs contain no stale identity-only/SFTP description for current behavior.
- The only provisioning path creates disabled rows; no migration or startup auto-enables or seeds live workspace state.
- Full implementation remains network-free and live-DB-free.

---

# M8 — Tiered activation, quantitative gates, rollback, and final acceptance

M8 is operator-run after code review; it is not an implementation-time network or DB action.

## Pre-upgrade and migration gate

1. Set `BAYSTATE_CMS_SOURCING_ENABLED=false`, restart, and verify capability reason `env_disabled`.
2. Inventory all enabled connections and all v1/v2 distributor items. Explicitly identify `extraction/pending|in_progress` items whose decision predates projection v2.
3. Stop API/workers, checkpoint WAL, verify free space, and create/verify a backup with:

```bash
bun run classification:integrity backup --db <absolute-app.db> --backup <absolute-timestamped-backup.db>
```

4. Require passing manifest/hash, source identity, `integrity_check`, protected-table counts/digests, and no backup WAL/SHM sidecars.
5. Run only the sanctioned migration startup while still pinned off.
6. Verify old/new markers, exact connector CHECK, enabled-value preservation, row counts, `foreign_key_check`, and disabled capability. Restore the verified backup on failure; never patch rows with ad hoc SQL.
7. Create/verify the five disabled rows listed in M7. Provision auth JSON in `api_keys` behind opaque refs; never enable yet.
8. Run the complete offline suite and the one-provider live smoke for each connector. A failed smoke leaves the row disabled.

## Per-provider quantitative gate

Each connector passes independently; a tier peer cannot vouch for it:

- At least 100 labeled observe-mode attempts.
- At least 30 labeled `found` and 20 labeled negative/wrong-variant cases.
- Zero false `found` results and zero identifier/variant bypasses.
- Zero credential/cookie/raw-HTML leaks in logs, DB, reports, or Crawlee artifacts.
- Source-error rate at or below 10%.
- Measured p95 within the existing 60-second item budget.
- Fixture/live field expectations reviewed, including merchandising provenance and forbidden price/inventory fields.
- Zero distributor candidate URL in `primaryImage`, `additionalImages`, `images_json`, OCR, downloader calls, drafts, or ShopSite.

## Tier 1: public storefronts

Run Bradley and Central Pet one provider at a time:

1. Keep all other new scraper rows disabled; enable only the provider under measurement through the explicit workspace-scoped PATCH.
2. Set mode `observe`. Imports remain on official Discovery; verify only generations/attempts are written. Use the provider’s TEST_SKU checks; Bradley live validation uses the verified 8–14 digit UPC, never `001135`.
3. Label observations and pass every quantitative gate.
4. Move that provider to `manual` for fresh marker-v1 imports. Review every qualification, merchandising merge warning, and conflict; exercise both “Use distributor record” and “Continue to Official Site Discovery.”
5. After manual evidence passes, run `automatic` as a one-workspace canary for at least seven days and 100 real items. Mandatory Review remains required.
6. Disable/quarantine on any false found, leak, unbounded error, or commerce image flow. Complete both providers before Tier 2.

## Tier 2: authenticated storefronts

Repeat the entire observe/manual/automatic sequence independently for `orgill`, then `pet_food_experts`, then `phillips_storefront` (or the operator’s documented one-at-a-time order within Tier 2). Before each enable:

- Verify secret JSON shape and masked API view.
- Run a successful live login/search/PDP smoke and an intentional no-secret/malformed-secret dry check without exposing values.
- Confirm one re-login behavior, stable auth errors, session reuse, and rate limits.
- Watch lockout/captcha/MFA signals; these are source errors and rollout blockers, never reasons to add stealth/proxies or bypass auth.

When `phillips/api` and `phillips_storefront/html_scraper` are both enabled, verify two distinct attempts/provenance IDs and review any genuine identity conflict rather than merging providers by name.

## Incident and rollback

- Immediate action: set the sourcing kill switch false and restart to abort in-flight work; disable the affected connection.
- Inventory Sourcing, distributor Extraction, v1/v2 materializations, reviewed items, current generations, and pending v1 decisions. Quarantine or use the existing guarded Continue action item-by-item; do not bulk rewrite.
- Preserve attempts, generations, decisions, acceptances, conflicts, materializations, smoke reports, and measurements.
- Restore schema/data only from the verified backup under downtime. Code rollback remains pinned off.
- Never delete evidence, backfill marker-v0 rows, rewrite historical v1 cohort snapshots, or introduce a repair script for the 148 legacy rows.

## Final repository validation

```bash
bun run test
bun run typecheck
bun run lint
bun run build
git diff --check
git status --short
git diff --cached --name-only
```

The reviewer must also confirm that no test made a real network call, no live DB/catalog/ShopSite write occurred, and staged paths remain empty.

## M8 definition of done

- All five providers have connector-specific labeled evidence and pass every runbook threshold.
- Tier order and modes were followed; all activation actions are recorded.
- No false exact match, credential leak, or commerce-image escape occurred.
- Rollback was rehearsed from verified evidence, not ad hoc SQL.
- Required reviewer signs off on implementation, tests, docs, and rollout evidence.

---

## 5. Consolidated test matrix

| Area | Required assertion |
|---|---|
| Schema | New marker upgrades a previously marked Amendment A DB; fresh/upgrade DDL converges; unknown type rejected; values/FKs preserved; rerun no-op |
| Registry | Exact `(type,id)` only; API/scraper IDs coexist; unknown/legacy null; no hidden distributor config key |
| Auth | Strict JSON; no secrets in config/log/API; memory-only sessions; one re-login; public connectors need no secret |
| Bounds | Abort/deadline closes resources; HTTPS/origin/redirect enforced; 6 MiB cap; rate/retry/concurrency bounded; no proxy |
| Each connector | Found, explicit not-found, wrong variant, source error; authenticated connectors also auth failure/re-login |
| Fixtures | Hash/provenance/date/URL/source revision; sanitized; expected fields; no credential/account data |
| Projection | V2 fields/provenance/hash; deterministic merge; merchandising warning only; identity conflict unchanged; v1 golden compatibility |
| Materializer | `distributor_record_v2`, null URL, atomic/idempotent, full allowed data, forbidden data absent, zero fetch/profile/OCR/model/image calls |
| Cohort/classification | V2 merchandising frozen and labeled `distributor_record` with null URL; v1 stays identity-only; no image/price/inventory evidence |
| Promotion | Method-specific payload/hash/generation/accepted IDs deep-verified; verified description allowed; candidate images never downloaded |
| Observe mode | Only generations/attempts; no item/decision/acceptance/conflict/extraction mutation |
| Live smoke | Explicit gate, CI refusal, read-only, redacted JSON, TEST_SKUs, Bradley valid-UPC rule |

## 6. Explicit non-goals and files/boundaries not to widen

- Do not port Amazon or treat retailers/marketplaces as distributors.
- Do not add Python/Crawl4AI, sidecars, external services, paid crawls, proxies, CAPTCHA bypass, MFA bypass, or stealth machinery.
- Do not implement SFTP, EDI 832, CSV/FTP ingestion, or new connector-type members.
- Do not modify `src/extraction-worker/browser/rendered-page-runner.ts` to serve sourcing; its persisted cookies/proxy semantics are intentionally different.
- Do not add runtime selector/login/origin configuration or an admin selector editor for these connectors.
- Do not change `normalizeGtin` or permit distributor SKU/name/brand lookup authority. Bradley `001135` remains parser-only.
- Do not add price, inventory, availability, stock, pallet quantity, provider claims, arbitrary raw fields, or canonical Brand/Category Page authority.
- Do not put distributor URLs on onboarding items/extraction rows or create a fake official URL.
- Do not route Sourcing directly to Curation or make `bundle_to_curation` actionable.
- Do not download, OCR, approve, draft, publish, or commit distributor images through this work.
- Do not backfill/reprocess marker-v0 rows, rewrite v1 materializations/snapshots, or mutate live DB state during implementation.
- Do not modify approved catalog/ShopSite state, stage files, or create commits.

## 7. Residual risks and mitigations

| Risk | Mitigation / residual condition |
|---|---|
| Orgill ASP.NET postback/viewstate changes | Browser-owned form submit; success/failure selectors; fixture coverage; one re-login; unknown markup source-error. MFA/CAPTCHA remains a rollout blocker. |
| Phillips SFCC/Backbone changes | Rendered search/PDP fixtures, exact candidate selection, no heuristic match, live smoke before enable. |
| Markup drift | Ordered code-reviewed selector chains, provenance/hash manifests, unexpected-markup fail-closed, provider-specific live smoke. Fixtures can still lag live markup. |
| Rate limits/account lockout | One per-connection request at a time, conservative rate ceilings, 15-minute reuse, bounded retries, provider-at-a-time rollout. Exact provider tolerances remain operationally measured. |
| Fixture staleness/sanitization | Capture date/hash/source URL/revision, minimal DOM, explicit redaction review, live smoke. Sanitized fragments cannot prove every browser behavior. |
| Bun/Crawlee lifecycle compatibility | Lazy import, isolated config/storage, injected lifecycle tests, explicit shutdown cleanup. Browser/runtime differences remain a canary concern. |
| Cookie persistence regression | Both Crawlee cookie persistence and SessionPool persistence disabled; sentinel/storage scan tests; unique storage removal. Future Crawlee upgrades require re-certification. |
| Multi-provider merchandising disagreement | Deterministic selection/union plus visible warnings and provenance; no automatic quality claim. Human Review decides suitability. |
| API and scraper identity disagreement | Distinct provider IDs and normal hard-conflict workflow; may increase manual holds, which is safer than silent merge. |
| Bradley lacks a verified live 8–14 digit fixture UPC | Synthetic captured-shape fixture may unblock parser work only. Bradley cannot pass live/rollout gates until a real provenance-stamped UPC is captured. |
| V1/v2 authority transition | Frozen v1 builder and method-dispatched verification; pending v1 decisions fail closed for explicit re-run; no backfill. Inventory is mandatory before upgrade. |
| Current partial migration uses the wrong marker | M1 independent marker and explicit regression test. Until fixed, Amendment B is not deployable. |
| Display-only image misunderstanding | Dedicated candidate field/UI label, primary/additional/images_json remain empty, downloader receives no distributor URLs, promotion tests use fetch sentinels. |

## 8. Overall definition of done

Implementation is complete only when:

1. M1–M7 code/tests/docs pass all listed commands with no network and temporary/in-memory DBs.
2. Every five-provider fixture set is provenance-stamped, sanitized, and reviewed against BayState field behavior.
3. The independent DB marker handles fresh, pre-Amendment-B, and already-Amendment-A-marked installations.
4. Every connector is exact-identifier safe, bounded, redacted, and registered only under its exact pair.
5. New v2 materializations supply all allowed Curation data and precise provenance while forbidden data remains absent.
6. Historical v1 rows remain verifiable without rewrite; pending old decisions do not silently upgrade.
7. Offline full-chain acceptance proves route/materialize/freeze/classify/promote boundaries for all providers.
8. M8 provider-specific quantitative gates and reviewer approval are recorded before automatic activation.
9. Dirty baseline is preserved, no staged paths exist, and no catalog/ShopSite commit or live DB mutation occurred during implementation.
---

## Implementation status (tracked by orchestrator)

| Milestone | Status | Notes |
|---|---|---|
| M1 — connector type, independent migration, pair-keyed registry | ✅ DONE (2026-08-15) | Reviewed: 64 vitest + 74 bun tests, typecheck clean; Amendment A block restored; `distributor_html_scraper_schema_version=1` independent marker; registry (type,id) pairs; engine passes explicit distributorId |
| M2 — crawlee session/auth core + merchandising contract | ⏳ NEXT | |
| M3 — tier 1 public connectors (bradley, central_pet) | ✅ DONE (2026-08-15) | Reviewed: 57 tests; REAL live captures (bradley UPC 018653299524, centralpet 035585775210); wrong-variant/not-found fixtures; SHA-verified manifests |
| M4 — tier 2 auth connectors (orgill, pfx, phillips_storefront) | ✅ DONE (2026-08-15) | Reviewed: 93-test M4 suite + 289 sourcing vitest + 25 bun green; runner login-page classification fix (SFCC script-template handling); real auth-page captures; 5 pairs registered |
| M5 — projection v2 + materializer v2 + consumers | ✅ DONE (2026-08-15) | M5a core (31 proj + 143 tests) + M5b-1 cohort/classification (140+21) + M5b-2 curation/promotion/UI (11+123); 5 cohort-freeze OCR failures verified PRE-EXISTING at HEAD |
| M5a — projection v2 + materializer v2 + dispatch core | ✅ DONE (2026-08-15) | Reviewed: 31 projection + 150 bun tests; v1 authority byte-identical; v2 default; projection_version_mismatch/unknown_extraction_method codes; repo finder widens to any distributor row |
| M5b — consumers (classification/cohort + curation/promotion/UI) | ✅ DONE (2026-08-15) | M5b-1: 140+21 tests, additive v2 member schema with safe defaults; M5b-2: 11 panel + 123 tests, promotion deep-compare tamper gate |
| M6 — live smoke tooling | ✅ DONE (2026-08-15) | Reviewed: 29 vitest + 4 bun tests; inert gate exit=2 verified; redacted JSON report; typecheck blockers only in concurrent session files |
| M7 — offline acceptance + docs convergence + disabled rows | ✅ DONE (2026-08-15) | 14-test offline acceptance chain (all five providers, dual flavors, route table); runbook/CONTEXT/AGENTS converged to merchandising-depth; candidate schema key aligned (`sourceProviderIds`); routes test covers five disabled payloads |
| Extraction maximization (2026-08-15) | ✅ DONE | Five parallel workers per distributor against real captures; per-field extraction matrices; forbidden data (price/inventory/stock/reviews/cart/pallet qty/MAP) asserted absent; live smokes ALL pass with maximized fields: bradley (desc/ingredients/UOM/casePack/2 img), central_pet (MPN/weight/dims/casePack/desc/1 img), orgill (desc/6 features/dims/8 img), pfx (brand/SKU/UOM/ingredients/1 img), phillips (brand/Item #727222 scoped away from recommendation cards/1 img). Genuinely-absent fields documented per provider (no fabrication). 102 connector tests + full sweep green. |
| M8 — operator rollout | 🔶 LIVE-VERIFIED (2026-08-15) | All five providers PASSED the env-gated live smoke with real credentials: bradley 018653299524 (found), central_pet 035585775210 (found), orgill 755625321923 (found), pet_food_experts 685038118080 (found; stale SKU 33011808 correctly not_stocked), phillips_storefront 072705115310 (found). Live defects found & fixed: crawlee http2 origin bug (http2:false), SPA login fill timing, login waitForLoadState hang → bounded success/failure race, cookie injection pre-navigation, direct-PDP search recognition (all three storefronts now redirect single-match searches to PDPs), live selector shapes (lblRetailUpc/lblDescriptionxs, productId container EA-over-CAS, .upc-value), SFCC auth-detection content-awareness, browser lifecycle (direct playwright), 6MiB rendered-page cap. Independent reviewer findings (2 blockers + 5 high/medium + 1 lifecycle) ALL remediated. Remaining follow-ups: orgill description/tab content + phillips description images soft fields; live-shape fixtures for orgill/pfx/phillips found pages; cohort-freeze OCR failures pre-existing; M8 quantitative gates + observe→manual→automatic still operator-run |
