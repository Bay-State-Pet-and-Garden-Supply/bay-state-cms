# Browser Investigation T6 closeout — drift repair, observability, and thin-slice demonstration

Parent: #224 (spec). Ticket: #230. Blocked by #227 (T3) and #229 (T5) — both landed.

## What was built

- **Drift repair** (`src/onboarding/browser-investigation/drift.ts`): pure smallest-change derivation from the frozen last-healthy baseline policy content to a freshly compiled proposal. Field-level source-order / selector diffs only; platform shifts and missing baselines become honest `full_replacement`; `requires_code_adapter` / `unresolved` outcomes become `unrepairable`. Every outcome carries `requiresValidation: true`, `automaticRerun: false`, `automaticPromotion: false` — repairs travel the same compile → validate → human-review → governed-activation path. No provider calls, no automatic reruns, no auto-promotion. Served read-only at `GET /api/domains/:domain/investigations/:id/drift-proposal`.
- **Observability** (`src/onboarding/browser-investigation/telemetry.ts`): operator telemetry derived from persisted investigation + validation state at query time — lifecycle, provider/domain, mode, duration, sample counts, run identity, usage/cost, recommended strategy, rendered-browser need, gap counts, validation outcomes, wrong-product / wrong-variant signals. Missing usage is explicit `unavailable` (never zero, never fabricated); billed cost stays distinct from estimates. Never carries keys, prompts, page content, or `knownContext` values (key names only). Served read-only at `GET /api/domains/:domain/investigations/:id/telemetry`.
- **Opt-in live smoke** (`src/onboarding/browser-investigation/live-smoke.ts` + `scripts/browser-investigation-live-smoke.ts` + `browser-investigation:live-smoke` package script): requires `BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE=1` exactly, refuses under `CI`, requires available isolation (`BAYSTATE_INVESTIGATION_ISOLATION=ready` + reachable runtime) and explicit model config (`--model` / `BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE_MODEL`, never secret material), plus an explicit domain with 1–5 in-domain public sample URLs. Reports record only performed steps plus explicit `activationPerformed: false` / `releasePerformed: false` / `attestationPerformed: false`. Gate refusals never touch the harness. No live browser was launched during implementation; the deterministic suites prove the gates.

## Thin-slice demonstration (recorded) — contract test

`src/tests/unit/browser-investigation-thin-slice.test.ts` (Vitest, memory
stores, deterministic fake provider) is retained explicitly as a **contract
test**, not the acceptance proof. Completion proof for the completion work is
the recorded opt-in pilot in `docs/plans/browser-investigation-pilot.md`: a
real containerized investigation of a live Shopify domain through the real
production worker with a genuinely blind holdout and a governed inactive
draft.

The contract test still covers the same lifecycle deterministically:

1. Explicit operator request (`requestAndRunInvestigation`, `domain_onboarding`, two Shopify representatives).
2. Bounded investigation completes with a Shopify platform result.
3. Deterministic compilation to a Shopify policy proposal (no selector exceptions).
4. Production-worker validation on two representatives plus one blind holdout → `passed` with holdout coverage.
5. Apply to draft with validation binding → sanitized inactive version, `imageRuleOk: false`, blockers preserved.
6. Workspace view shows the proposal with `automaticActivation: false`, `automaticRelease: false`, and no computed health verdict; telemetry and drift derivations agree (`no_change` against its own draft content).

## Negative invariant (recorded)

- Source-level: `browser-investigation-provider-isolation.test.ts` pins the provider-seam allowlist (only explicit investigate/repair seams reference it) and forbids Cloud SDK plumbing.
- Runtime: `browser-investigation-fake-provider.test.ts` asserts zero provider calls before the explicit run path; the thin-slice test asserts validation and apply make zero additional provider calls.

## What was NOT performed

No live profile activation, image attestation, selective release, or operator act was performed or claimed. No live browser investigation was launched (isolation not enabled in this environment). No Cloud browser integration was built — Cloud remains disabled by owner decision. Costs in fixtures are `unavailable` or test values, never billed amounts.

## Verification evidence (this session, no live runs)

- `bun run typecheck` — green.
- `bunx vitest run` — 315 files, 4050 passed, 1 skipped.
- Bun DB suites — investigation lifecycle/policy-drafts/validation-routes/workspace-routes (25 pass); health/activation/release-guard/variant-identity suites (48 pass).
- `bun run test:runner-coverage` — 0 new violations (new pure-Vitest suites need no `test:db` registration).
- `bunx fallow audit` (dead-code/health/dupes baselines) — exit 0: dead code 0, complexity 0, duplication warnings only (route boilerplate + test fixtures).
- Changed-file eslint — clean.

## Review dispositions (Standards + Spec parallel review)

- Standards: clean, no findings.
- Spec `sampleInDomain` substring match admitted lookalike domains — fixed to dot-boundary (`host === domain || host.endsWith('.' + domain)`), regression-tested with `evil-shop.example.com` (rejected) and `store.shop.example.com` (accepted).
- Spec field-diff blind spot: structure/identity/rendered-browser drift with identical field sources reported `no_change` — fixed via `nonFieldChanges` (structures, identity, renderedBrowserRequired), reported as `minimal_change` with `non_field_drift:*` blockers.
- `affectedFields`/`failureCodes` are intentionally echoed context (computed from matrix failures by the T5 drift-entry builder), not re-derived: the diff itself is the proposal; the failure context tells the reviewer what to look at.
- Route baseline is the current active version policy (the T5 frozen last-healthy baseline source), read by value into a pure function — never mutated, never auto-promoted.
- Live-smoke URL policy is hostname-only (literal IPs refused): intentional hardening beyond the service boundary, fail-closed direction; the operator uses hostnames. The shipped CLI probe verifies isolation only and says so in its report — live browser execution stays an explicit Profile Workspace launch, never an automated smoke.
