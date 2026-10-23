> [!NOTE] Superseded by Onboarding Hardening Plan M6 — see `docs/plans/onboarding-hardening-plan.md`.
> **Partial supersession:** Deterministic worker/profile governance remains valid. Runtime LLM extraction and agent orchestration remain prohibited by ADR 0030/ADR 0033 — do not use this plan to reintroduce them. ADR 0043 supersedes any page-price extraction or override behavior described below.

# Domain Extractor Profile Worker Plan

## Goal

Add a second, separable worker process for browser-heavy profile tooling while keeping trusted Extraction deterministic and fail-closed.

The main Bun API server remains the owner of:

- SQLite state and repository access
- Pipeline state transitions
- Domain Extractor Profile matching
- Profile Health decisions
- Reviewer approval workflows
- Trusted Extraction orchestration

The worker owns browser/crawler execution:

- Playwright page loading and deterministic replay
- Crawlee sample collection and validation sweeps
- Screenshots, DOM snapshots, image previews
- Optional Stagehand/LLM proposal assistance for Profile Builder only
- Browser pooling/session/proxy concerns

## Runtime split

| Responsibility | Bun API server | Node worker |
| --- | --- | --- |
| API routes and UI-facing state | Yes | No |
| SQLite reads/writes | Yes | No |
| Artifact metadata persistence | Yes | Returns artifact refs only |
| Profile Match decision | Yes | No |
| Profile Health decision | Yes | No |
| Trusted extraction orchestration | Yes | Executes requested deterministic profile run |
| Generic/Profile Tooling Extraction | Requests jobs | Executes jobs |
| Playwright runtime | Avoid in main path | Yes |
| Crawlee validation sweeps | No | Yes |
| Stagehand/LLM browser proposals | No | Optional, proposal-only |

The worker should return structured results to the Bun server. The Bun server persists results and decides whether an item advances, stays blocked, or needs reviewer action. The worker must not open the project SQLite database directly; this keeps all product, profile, approval, and artifact metadata writes behind the existing repository layer.

## Communication model

Start with a local HTTP sidecar because it is easy to inspect, test, restart, and later deploy separately.

Default binding:

```txt
BAYSTATE_CMS_WORKER_HOST=127.0.0.1
BAYSTATE_CMS_WORKER_PORT=3032
BAYSTATE_CMS_WORKER_TOKEN=<random dev token or configured secret>
```

Security rules:

- Bind to `127.0.0.1` by default.
- Require `Authorization: Bearer <worker token>` for every request.
- Do not expose the worker to the LAN or internet.
- Treat all source-page content as untrusted data.
- Do not send ShopSite credentials, merchant IDs, API keys, or local secrets to worker tasks.

## Job execution model

Use mixed execution:

- Synchronous HTTP calls for quick health checks, single-page snapshots, single-page previews, and deterministic extraction requests after Profile Match succeeds.
- Queued jobs for Crawlee validation sweeps and profile proposal runs because they can fetch many pages, call LLM proposal tooling, and produce many artifacts.
- Bun owns queue state, job records, cancellation state, retry policy, SSE/polling updates, and final persistence.
- The worker receives job payloads, executes them, writes approved artifact files, and reports structured progress/results back to Bun.
- If the worker crashes or a queued job fails, Bun marks the job failed and trusted Extraction remains fail-closed.

## Worker API surface v0

### `GET /health`

Returns worker version and available capabilities.

```json
{
  "ok": true,
  "capabilities": {
    "playwright": true,
    "crawlee": true,
    "stagehand": false
  }
}
```

### `POST /profile-tooling/snapshot`

Fetch one page for Profile Builder diagnostics.

Input:

```json
{
  "url": "https://brand.com/products/foo",
  "runtime": "static|rendered",
  "captureScreenshot": true
}
```

Output:

```json
{
  "url": "https://brand.com/products/foo",
  "finalUrl": "https://brand.com/products/foo",
  "htmlRef": "artifact://...",
  "screenshotRef": "artifact://...",
  "jsonLd": [],
  "embeddedProductData": [],
  "imageCandidates": [],
  "pageStructureSignals": [],
  "warnings": []
}
```

### `POST /profile-tooling/propose`

Use deterministic artifacts plus optional LLM/Stagehand assistance to propose a Domain Extractor Profile draft. Proposal output is never healthy by itself. This should run as a Bun-owned queued job once proposal runs include multiple samples or LLM assistance; the direct HTTP shape below is the worker execution payload.

Input:

```json
{
  "domain": "brand.com",
  "seedSamples": [
    {
      "url": "https://brand.com/products/foo",
      "expectedName": "Foo 12oz Blue",
      "upc": "...",
      "spreadsheetHints": { "size": "12oz", "color": "Blue" }
    }
  ],
  "allowLlm": true
}
```

Output:

```json
{
  "proposal": {
    "domain": "brand.com",
    "urlPatterns": [],
    "pageStructureSignals": [],
    "runtime": "static|rendered",
    "selectors": {},
    "imageRules": {},
    "variantSelectionStrategy": null,
    "warnings": []
  },
  "sampleArtifacts": []
}
```

### `POST /profile-tooling/validate`

Run a proposed or approved profile across samples. This is validation evidence, not a health decision. Multi-sample validation sweeps should run as Bun-owned queued jobs; the direct HTTP shape below is the worker execution payload.

Input:

```json
{
  "profileDraft": {},
  "samples": [
    {
      "url": "https://brand.com/products/foo",
      "confirmed": true,
      "expectedName": "Foo 12oz Blue",
      "upc": "...",
      "spreadsheetHints": {}
    }
  ]
}
```

Output:

```json
{
  "summary": {
    "sampleCount": 2,
    "confirmedSampleCount": 2,
    "passingSamples": 2,
    "failingSamples": 0,
    "variantSamplesPassing": 1
  },
  "results": []
}
```

### `POST /profile-runner/extract`

Execute an already matched healthy profile deterministically. The Bun server performs Profile Match first and passes the exact profile/version to run.

Input:

```json
{
  "profileId": "...",
  "profileVersion": 3,
  "sourceUrl": "https://brand.com/products/foo",
  "expected": {
    "name": "Foo 12oz Blue",
    "brandHint": "Foo",
    "upc": "...",
    "spreadsheetHints": {},
    "price": "19.99"
  },
  "profile": {
    "runtime": "static|rendered",
    "selectors": {},
    "imageRules": {},
    "variantSelectionStrategy": null
  }
}
```

Output:

```json
{
  "ok": true,
  "extractionData": {},
  "fieldProvenance": {},
  "profileRuntime": "static|rendered",
  "profileId": "...",
  "profileVersion": 3,
  "warnings": []
}
```

If deterministic execution cannot select the correct variant, match the page structure, or extract required fields, the worker returns `ok: false`; the Bun server keeps the item blocked or failed in Extraction.

## Artifact handling

The worker should not stream large HTML/screenshots through API responses by default. It should write artifacts under a workspace-scoped directory and return artifact references.

Proposed local path:

```txt
<workspace>/.baystate-cms/artifacts/profile-builder/<domain>/<job-id>/
```

Artifact types:

- `page.html`
- `page.min.html`
- `screenshot.png`
- `network.json`
- `image-candidates.json`
- `validation-results.json`

The Bun server decides which artifact references to persist in SQLite and which are temporary. The worker writes artifact files only to paths supplied or approved by the Bun server and returns references; it does not persist artifact metadata itself.

## Process lifecycle

Development:

- `bun run dev` should eventually spawn the worker alongside the API server and Vite.
- The worker can initially be optional; API calls that require it should surface a clear "worker unavailable" error.

Production/local app:

- The main server starts or connects to the worker on startup.
- Worker health is shown in Onboarding Settings / Domain Diagnostics.
- If the worker crashes, trusted extraction should fail closed rather than falling back to generic extraction.

## Implementation phases

### Phase 1 — contract and client

Files to add:

```txt
src/shared/schemas/extraction-worker.ts
src/server/extraction-worker-client.ts
```

Work:

- Define Zod schemas for worker requests/responses.
- Define queued job payload/result schemas for profile proposal and validation sweep jobs.
- Add a typed client with timeout handling and bearer token auth.
- Add `/api/onboarding/settings/extraction-worker/health` route in the Bun server.
- No extraction behavior changes yet.

### Phase 2 — worker shell ✅ DONE

Files added:
- `src/extraction-worker/server.ts`
- `src/extraction-worker/routes/health.ts`
- `src/extraction-worker/auth.ts`
- `package.json` scripts `worker:dev` and `worker:start`  ✅ *implemented*

Files added:

```txt
src/extraction-worker/server.ts
src/extraction-worker/routes/health.ts
src/extraction-worker/auth.ts
```

Implementation details:

- Zero-dependency Node.js HTTP server using `node:http` (not Hono).
- Binds to `127.0.0.1` (env: `BAYSTATE_CMS_WORKER_HOST`, `BAYSTATE_CMS_WORKER_PORT`).
- Bearer token auth via `BAYSTATE_CMS_WORKER_TOKEN`; optional, warns when unset.
- `GET /health` returns capability flags (`playwright: true`, `crawlee: false`, `stagehand: false`).
- Unknown paths return 404.
- Dev script: `node --import tsx src/extraction-worker/server.ts`
- Start script: `node dist/extraction-worker/server.js` (requires separate build path)
- The auth helper returns `{ authorized: true }` or `{ authorized: false, message }`.

### Phase 3 — snapshot tooling ✅ DONE

Files added:

```txt
src/extraction-worker/artifacts.ts
src/extraction-worker/routes/snapshot.ts
```

Files changed:

```txt
src/extraction-worker/server.ts           — registers POST /profile-tooling/snapshot
docs/plans/domain-extractor-profile-worker-plan.md  — marks Phase 3 done
```

Implementation details:

- `artifacts.ts` provides `resolveArtifactDir()`, `writeArtifact()`, `generateJobId()`, and `extractDomainFromUrl()` helpers.
- Artifacts are written to `<cwd>/.baystate-cms/artifacts/profile-builder/<domain>/<job-id>/`.
- `routes/snapshot.ts` handles `POST /profile-tooling/snapshot` with two runtimes:
  - **static**: Uses `fetch()` with HTTP headers from `page-extractor.ts`, parses HTML with regex for JSON-LD, meta tags, embedded Shopify product data (`productJSON`, `ShopifyAnalytics`, `__INITIAL_STATE__`), image candidates, and page structure signals. Writes `page.html` and `page.min.html` (stripped of style/svg/noscript/header/footer/nav/script).
  - **rendered**: Launches headless Playwright Chromium, blocks images/fonts/stylesheets/media/trackers via `page.route()`, navigates with `waitUntil: 'domcontentloaded'` and 25s timeout, dwells 2s for dynamic content. Extracts JSON-LD, embedded product data, image candidates, and page structure signals via `page.evaluate()`. Captures screenshot as PNG if `captureScreenshot` is true.
- Both paths pass output through `SnapshotResponseSchema.parse()` before returning.
- Errors are surfaced in the `warnings` array; never throws uncaught errors.
- Network capture is not implemented (removed as unused).

### Phase 4 — profile validation sweeps ✅ DONE

Files added:
- `src/extraction-worker/routes/validate.ts`
- Server updated to mount `/profile-tooling/validate` ✅ DONE

Files added:
- `src/extraction-worker/routes/validate.ts`

Files changed:
- `src/extraction-worker/server.ts` — registers `POST /profile-tooling/validate`
- `docs/plans/domain-extractor-profile-worker-plan.md` — marks Phase 4 done

Implementation details:

- `routes/validate.ts` handles `POST /profile-tooling/validate` with two runtimes:
  - **static**: Uses `fetch()` with HTTP headers matching `page-extractor.ts` for each sample URL.
  - **rendered**: Launches headless Playwright Chromium per sample, blocks images/fonts/stylesheets/media/trackers, navigates with `waitUntil: 'domcontentloaded'` and 25s timeout, dwells 2s.
- Extracts field values from the fetched page HTML using CSS-selector-based regex extraction for each selector in `profileDraft.selectors`.
- Scores each field result:
  - Empty selector value → `fail`
  - `titleSelector` / `nameSelector` with `expectedName` → word overlap > 15% check; below threshold → `warning`
  - `priceSelector` / page `price` → ignored; price never contributes to profile health or replaces onboarding input (ADR 0043)
  - `imagesSelector` / `images` / `imageSelector` / `image` → non-empty image count check; zero → `warning`
- Image validation: counts non-SVG image candidates; sets `primaryImageMatch` if any found.
- Variant validation: if `variantSelectionStrategy` is present, returns `{ selected: true, variantTitle: "not yet implemented" }` (actual running in Phase 5).
- Writes per-sample HTML to artifacts at `<cwd>/.baystate-cms/artifacts/profile-builder/<domain>/<job-id>/sample-<sanitized-url>.html`.
- Returns the full `ValidateResponseSchema`-shaped result with summary and per-sample results.
- Errors surface in per-sample warnings; never throws uncaught errors.
- Follows same patterns as snapshot.ts: HTTP constants, body chunk collection, Zod safeParse, response validation.

### Phase 5 — trusted profile runner ✅ DONE

Files added:
- `src/extraction-worker/routes/extract.ts` (1187 lines)
- Server updated to mount `/profile-runner/extract` ✅ DONE

Files added:
```txt
src/extraction-worker/routes/extract.ts
```

Files changed:
```txt
src/extraction-worker/server.ts           — registers POST /profile-runner/extract
docs/plans/domain-extractor-profile-worker-plan.md  — marks Phase 5 done
```

Implementation details:

- `routes/extract.ts` handles `POST /profile-runner/extract` with two runtimes:
  - **static**: Uses `fetch()` with HTTP headers + Cheerio DOM parsing. Applies profile selectors (titleSelector, brandSelector, descriptionSelector, imagesSelector) via `$(selector).first().text().trim()`. Extracts JSON-LD from `<script type="application/ld+json">`, meta tags (og:*, product:*, description), and microdata as supplementary fallback sources, excluding price fields per ADR 0043. Collects image sources from imagesSelector elements using `collectImageSourcesFromElement` pattern, deduplicating and resolving to absolute URLs.
  - **rendered**: Launches headless Playwright Chromium, blocks images/fonts/stylesheets/media/trackers, navigates with `waitUntil: 'domcontentloaded'` and 25s timeout, dwells 2s for dynamic content. Evaluates each selector via `page.evaluate()`. Extracts JSON-LD, meta tags, and embedded product data (window.productJSON, ShopifyAnalytics, __INITIAL_STATE__). Collects image candidates via `page.evaluate()` with full src/srcset/data-src attribute scanning.
- Title is mandatory: if titleSelector returns empty and no JSON-LD/meta fallback provides one, returns `ok: false`.
- The onboarding price is the sole price source and stays unchanged. Page prices are never extracted or used (ADR 0043).
- All errors surface in warnings; never throws uncaught errors.
- Output passes through `ExtractionDataSchema.parse()` and `ExtractResponseSchema.parse()`.
- Image source helpers are inlined (no import from Bun-only onboarding modules).
- Timeout: 15s HTTP fetch, 30s total for static; 25s navigate + dwell for rendered.
- No LLM calls, no generic fallback, no variant inference.

### Phase 6 — optional Stagehand proposal assistant

Work:

- Add Stagehand only behind an explicit Profile Builder setting.
- Keep it out of trusted extraction endpoints.
- Validate all LLM output against schemas.
- Store as profile proposals only.

## Resolved implementation decisions

- All persistence stays in the Bun server. The worker does not read or write SQLite directly.
- Worker execution uses a mixed model: synchronous HTTP for quick single-page work and deterministic extraction, Bun-owned queued jobs for profile proposal runs and Crawlee validation sweeps.
- Worker artifacts live under the workspace in `<workspace>/.baystate-cms/artifacts/profile-builder/<domain>/<job-id>/`. The directory is Git-ignored.

## Open design questions

1. Should Browserless/Browserbase be supported in v0?
   - Recommended: no; define an interface only.

## Success criteria

- Main Bun server can report worker health.
- Worker can be disabled/unavailable without causing trusted generic fallback.
- Profile Builder can request page snapshots from the worker.
- Crawlee validation can run across multiple samples as a queued job and return per-sample results.
- Bun server owns queued job state, progress, retries, cancellation, and persistence.
- Trusted Extraction can call worker only after Profile Match succeeds.
- No LLM or Stagehand path is reachable from trusted Extraction.
- Every worker result identifies profile ID/version or declares itself tooling-only.
- Worker artifacts are workspace-scoped, predictable, and Git-ignored.
