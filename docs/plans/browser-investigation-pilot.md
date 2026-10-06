# Browser Investigation real thin-slice pilot (#239)

Status: **performed and passed** on 2026-09-18 against a real Shopify domain
(`allbirds.com`). This document is the pilot's evidence record: what ran, what
it produced, and what was explicitly NOT done.

Companion documents:

- `docs/plans/browser-investigation-design.md` — design baseline (Tier 0/Tier 1
  network shape, budgets, grammar, holdout governance).
- `docs/plans/browser-investigation-t6-closeout.md` — T6 closeout (drift,
  telemetry, opt-in live smoke).
- ADR 0038 — browser agents investigate; deterministic adapters extract.

## What the pilot proves

One opt-in run of `bun run browser-investigation:pilot` against
`www.allbirds.com` exercised the **real** stack, not a double:

1. **Explicit operator request** through the lifecycle service
   (`requestAndRunInvestigation`, mode `domain_onboarding`, two representative
   PDPs).
2. **Containerized Tier 0 investigation**: the host performed broker-mediated
   captures only; analysis ran inside `baystate/investigation-browser:1`
   (`--network=none`, non-root, read-only root, all caps dropped). The
   container launched zero fetches of its own; typed observations came back on
   stdout and the container was removed on the run's exit path.
3. **Deterministic compilation** of the stored (untrusted) result into an
   Extraction Policy Proposal — adapter-first Shopify sources, no selector
   exceptions claimed where none were supplied.
4. **Real production worker validation**: the compiled draft profile executed
   through the production profile runner (`runProfileExtraction` →
   `/profile-runner/extract` → the worker's Shopify policy path) on two
   representatives **plus one truly blind holdout** that never appeared in the
   investigation input.
5. **Governed inactive draft**: server-authoritative apply bound the persisted
   validation record by proposal/policy/validation hashes and published a
   sanitized **inactive** draft with `imageRuleOk: false` and blockers
   preserved. No activation pointer, no release, no attestation.

Recorded report (verbatim fields from the run):

```json
{
  "schemaVersion": 1,
  "domain": "allbirds.com",
  "workspaceId": "ws-pilot-allbirds-com",
  "representativeUrls": [
    "https://www.allbirds.com/products/womens-wool-runners-natural-black",
    "https://www.allbirds.com/products/mens-wool-runners-natural-white"
  ],
  "holdoutUrls": [
    "https://www.allbirds.com/products/trino-tubers-onyx"
  ],
  "investigationId": "binv_945455209_mu6ksrnk",
  "runId": "binvrun_20260918062651_1732319121",
  "provider": "local_browser_harness",
  "actingModel": {
    "provider": "local_browser_harness",
    "model": "app-authored-read-plan-v1"
  },
  "modelCalls": 0,
  "startedAt": "2026-09-18T06:26:51.265Z",
  "endedAt": "2026-09-18T06:26:55.440Z",
  "durationMs": 4175,
  "isolation": {
    "verified": true,
    "detail": "isolated Docker runtime reachable"
  },
  "stepsPerformed": [
    "isolation_verified",
    "investigation_completed",
    "proposal_compiled",
    "validation_passed",
    "draft_applied"
  ],
  "proposalHash": "f107df6d1b8bb806c220ff7b2805a98df9a765401719c3c5863fd8fb75c4ab97",
  "policyHash": "73a0b16af90e5c1b42e0b7f400fa61e31b5175a6c8dcd0149179d00e66e16c48",
  "validation": {
    "status": "passed",
    "holdoutsRequired": 1,
    "holdoutsPassed": 1,
    "holdoutSampleIds": [
      "https://www.allbirds.com/products/trino-tubers-onyx"
    ],
    "blockers": []
  },
  "draft": {
    "appliedVersionId": "ver_pilot_mu6ksuha_1",
    "inactive": true,
    "imageRuleOk": false,
    "blockers": [
      "gap:missing_field_evidence:price",
      "gap:missing_field_evidence:gtin",
      "gap:missing_field_evidence:availability"
    ]
  },
  "usage": {
    "pagesVisited": 2,
    "readsPerformed": 20,
    "durationMs": 1648,
    "modelCalls": 0
  },
  "activationPerformed": false,
  "releasePerformed": false,
  "attestationPerformed": false,
  "passed": true,
  "failureCode": null,
  "notes": [
    "draft ver_pilot_mu6ksuha_1 is inactive with imageRuleOk false; blockers preserved (3)",
    "workspace proposal available; automatic activation absent; telemetry validation passed",
    "no activation, release, or image attestation was performed or claimed"
  ]
}
```

Validation sample outcomes (from the persisted validation record of the same
run): both representatives and the blind holdout returned `status: "pass"`,
`identityOutcome: "match"`, with the exact parent product id observed
(`1878275686469`, `1878194389061`) and the exact platform variant id resolved
from the trusted GTIN/SKU. Every compiled policy field — `title`, `brand`,
`description`, `images`, `sku`, `variants` — was present with
`shopify_product_json` provenance except `description` (`meta`).

## What the pilot does NOT claim

- **No activation.** The applied draft is inactive; no active-profile pointer
  was written anywhere in the run.
- **No release.** No item was released, and no release path was invoked.
- **No attestation.** `imageRuleOk` is `false`; no image review was attested.
- **No model reasoning.** `modelCalls: 0`, `actingModel:
  app-authored-read-plan-v1`: this is deterministic Tier 0, not Tier 1
  reasoning. Tier 1 remains behind its own opt-in and was not exercised here.
- **Not statistical coverage.** One blind holdout is an independent check, not
  proof of whole-domain coverage. The draft still carries the compiler's
  coverage gaps (`price`, `gtin`, `availability` had no observed evidence), and
  those blockers are preserved rather than waived.
- **No CI involvement.** The pilot refuses to run under `CI` and requires
  `BAYSTATE_CMS_BROWSER_INVESTIGATION_PILOT=1` plus available isolation; the
  deterministic suites never launch it.

## Tier-1 rendered pilot status (#237, Worker C)

Status: **not yet exercised live — the default gate stays deferred**
(`render_deferred`). The pilot above remains Tier-0-only evidence
(`modelCalls: 0`, `renderOptIn` absent/false). This section records what
was done toward a Tier-1 pilot, what blocks it, and what is explicitly
not claimed.

What was done (Worker C slice):

1. **Tier-1 opt-in passthrough**: `scripts/browser-investigation-pilot.ts`
   now constructs the real harness with `{ allowTier1Render: true }`
   when — and only when — the operator exports
   `BAYSTATE_INVESTIGATION_ALLOW_RENDER=1`, and passes `renderOptIn`
   through `runPilot` so the report records it verbatim. Without the
   switch the pilot behaves exactly as the recorded Tier-0 run above.
2. **Tier-1 → validation integration** (deterministic, fakes):
   `src/tests/unit/browser-investigation-tier1-validate.test.ts` proves a
   Tier-1-flavored completed result (merged `page_rendered` observations,
   truthful `modelCalls: 1` with the acting model) flows through the
   UNCHANGED compile → production-worker representative + blind-holdout
   validation → governed inactive draft path, and that a Tier-1
   observation leaking holdout material fails closed with
   `holdout_exposed` before any worker call.
3. **Gate decision: LEFT DEFERRED.** Lifting the default
   `render_deferred` gate requires all three proofs, and none is complete:
   - (a) Proxy-only egress for the rendered path is being re-proven at
     container level alongside the in-flight CONNECT-interception work
     (sibling slice; `render-proxy.ts`, `isolation.ts`,
     `camoufox-launch.ts`/`config.ts` all have uncommitted changes at the
     time of writing).
   - (b) Holdout-blindness + budgets are being re-proven: the staged
     `model-context.ts` fix (probing `investigationId` as a
     model-visible surface) shows the blindness proof is still in flux.
   - (c) No passing Tier-1 Shopify compile exists locally or in a pilot:
     the render image does not build in this environment
     (`better-sqlite3` postinstall needs Python via node-gyp; the
     `oven/bun:1.3.5` build step has none), so no live render container
     could be launched here, and no Tier-1 pilot has been recorded.

What this section does NOT claim:

- **No rendered navigation proof.** No real HTTPS product page has been
  rendered through the validating boundary in any run recorded here.
- **No gate change.** `local-harness.ts` still refuses
  rendered-required work with `render_deferred` by default; ADR 0038's
  addendum and `CONTEXT.md` carry the same reason, unchanged.
- **No Tier-1 pilot report.** There is no `renderOptIn: true` run to
  quote. When the three proofs land, the Tier-1 pilot is:
  `BAYSTATE_INVESTIGATION_ALLOW_RENDER=1` plus the reproduce steps above,
  and its report (with `renderOptIn: true`, actual `modelCalls`, and the
  acting model) will be appended here verbatim.

## How to reproduce

```sh
# 1. Isolation + runtime prerequisites
docker build -t baystate/investigation-browser:1 -f docker/investigation-browser/Dockerfile .
export BAYSTATE_INVESTIGATION_ISOLATION=ready

# 2. Extraction worker on the API server's expected address
export BAYSTATE_CMS_WORKER_TOKEN=<token> BAYSTATE_CMS_WORKER_PORT=3032
node --import ./preload/crawlee-storage.mjs --import tsx src/extraction-worker/server.ts &

# 3. Explicit opt-in pilot (representatives investigated; holdouts validated blind)
BAYSTATE_CMS_BROWSER_INVESTIGATION_PILOT=1 \
  bun run browser-investigation:pilot \
  --domain www.allbirds.com \
  --rep-url https://www.allbirds.com/products/womens-wool-runners-natural-black \
  --rep-url https://www.allbirds.com/products/mens-wool-runners-natural-white \
  --holdout-url https://www.allbirds.com/products/trino-tubers-onyx \
  --expected-json /tmp/pilot-expected.json --actor operator-pilot
```

`--expected-json` maps each validation URL to its trusted expected identity
(`name`, `gtin`, `sku`, `platformVariantId`, `productId`). The pilot refuses to
run without a name, a trusted variant identifier, and a parent product id for
every sample — names alone cannot prove identity — and it refuses when a
holdout is also a representative.

## Defects the pilot exposed (all fixed in the same change)

The pilot's value was proving the stack rather than the doubles: four real
defects only appear when the production runtime, the real container, a real
storefront, and the real worker all run together.

1. **Broker transport broke under Bun** (`src/onboarding/browser-investigation/broker.ts`).
   `node:https`'s per-request `lookup` contract is not implemented by Bun
   (it assumes the `all: true` array form and fails the connect), so every
   brokered fetch from the Bun API server — the production runtime — failed
   with `ECONNREFUSED`. The transport now binds the connection with
   `createConnection`, dialing the broker-validated address directly while
   keeping TLS SNI/hostname verification against the request host. Pinned by
   `browser-investigation-transport-bun.test.ts`, which runs under the Bun
   test runner (Vitest runs under Node and cannot see this).
2. **Rich observations were rejected as malformed**
   (`src/onboarding/browser-investigation/local-harness.ts`). The in-container
   analyzer caps an observation at the run's per-operation budget (up to
   32 KiB) while the stored-result schema caps `detail` at 4 000 characters, so
   a real page with a large JSON-LD block produced a result the service
   rejected (`malformed_result`). The harness now clamps to the shared
   `MAX_RESULT_OBSERVATION_DETAIL_CHARS` and marks the observation
   `incomplete` instead of silently truncating.
3. **The harness claimed selector sources it could not supply**
   (`local-harness.ts`). Recommending `title`/`images` with a `selector`
   source and no selector made the compiler drop those fields
   (`selector_missing`), so the compiled policy never contained a title on a
   real page. Recommendations now list only sources the fixed read plan can
   actually back; on a proven Shopify platform the coded adapter leads.
4. **The Shopify runtime could not bind endpoint images**
   (`src/extraction-worker/routes/extract-shopify-policy.ts`). The public
   Shopify product endpoint returns `images` as a plain string array, but the
   mapper only read `{ src }` objects, so the `images` policy field always
   failed to bind. Both shapes are now accepted.
5. **The read budget could not cover a second page**
   (`src/onboarding/browser-investigation/tier0-analyzer.mjs`). Image
   attribute reads on an image-heavy storefront consumed the whole 20-read run
   budget, so a two-page investigation failed closed with
   `budget_exhausted`. The analyzer now reserves the measured fixed-plan cost
   for the pages still to come, clips the image surface honestly (gap +
   `incomplete`), and skips a page with an explicit gap only when its fixed
   plan cannot fit the remaining budget.
6. **Parent product identity never reached callers**
   (`src/shared/schemas/extraction-worker.ts`,
   `src/extraction-worker/routes/extract.ts`,
   `src/onboarding/profile-runner-client.ts`). The Shopify policy extractor
   computes the parent product id and attaches it to its extension payload,
   but the worker response schema dropped it, so the validation path could
   never verify product identity against `expected.productId`. The id now
   rides the response (additive, optional) and the pilot's product-identity
   check sees it (`parent=1878275686469` for the representative,
   `parent=3687618936912` for the holdout).

## Relationship to the fake-based thin slice

`src/tests/unit/browser-investigation-thin-slice.test.ts` remains as a
**contract test** — fast, deterministic, memory-store coverage of the same
lifecycle with an explicitly injected fake provider. It is labeled as such in
its header and describe block and is **not** the acceptance proof for the real
pilot; it is strictly stronger than it on nothing and strictly weaker on
everything the real run proves.
