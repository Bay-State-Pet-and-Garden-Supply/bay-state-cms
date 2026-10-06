# Jev incumbent execution guard — 2026-10-06

## Scope and confirmed seam

The owner confirmed `captureQualificationPredictionsLive` as the public
regression seam, with real routing, isolated SQLite, audit and request-budget
behavior, and only provider HTTP mocked. The fixed review baseline is
`5907853b`. This patch follows committed V8 evidence `9d2441d8`; it is execution
plumbing, not a successful current-provider comparison or production release.

## Reproduced failures and fixes

Each listed automated regression was observed failing before its fix:

| Public capture behavior | Observed failure | Corrected behavior |
|---|---|---|
| Wrong explicit credential source | Three requests still sent | Zero requests; `baseline_credential_reference_mismatch` |
| One-request incumbent budget | Four requests including JSON repair | One request; repair denied, `baseline_attempt_budget_exhausted` |
| Missing incumbent token usage | Missing values became zero | Unknown totals remain null, including partially missing totals |
| Returned incumbent model | Requested model substituted for returned revision | Actual `resolved_model` is audited and captured |
| Omitted returned-model identity | Baseline labeled live with assumed identity | `baseline_model_identity_unverified`, unknown returned model |
| Changed credential-source namespace | Identical artifact hash | Verified reference is retained and hashed |
| Waiting local request canceled | Waited for another request to finish | Canceled queue entry removed; zero request from canceled caller |
| Later incumbent service failure | Earlier success masked failed stages | Whole affected baseline side blocked with service-failure proof |
| Wrong declared evaluation store | Three requests still sent | Zero requests/budget consumption; `baseline_store_context_mismatch` |
| Changed endpoint, same provider/model/reference | Identical artifact hash | Non-secret endpoint/pins and policy identity are bound |
| Expired deadline with delayed timer | Three requests after expiry | Monotonic boundary check denies before request; zero consumed |
| Candidate key without budget/deadline | Two requests still sent | Zero requests; `jev_runtime_guard_unwired` |

Additionally, network-free CLI checks reproduced acceptance of
`--max-attempts=NaN`, `--concurrency=0` and `--deadline-ms=NaN`.
All now exit nonzero with shared-schema `invalid_replay_budget` before capture.
The ordinary no-live CLI remains network-free and reports its actual defaults:
600 attempts, concurrency 2, deadline 300000 ms.

## Identity, ownership and bounds

- Exact existing-store references: `api_keys:<provider>` or
  `provider_connections:<id>`. An arbitrary string/database path is not proof
  of the selected credential. System One cannot substitute for an incumbent
  chat transport.
- The requested provider/model, actual credential source, endpoint/pins and
  frozen model-policy digest bind artifact identity. No credential value is
  returned, logged or hashed into this binding.
- File-backed replay verifies the already-open DB against the declared isolated
  path and denies operational/repository-local stores and inode aliases,
  including repositories' other linked worktrees. It never initializes or
  copies a store inside the capture API.
- The validated DB instance is reasserted before dispatch and durable audit
  writes. Context loss aborts; no run completion writes target the replacement
  DB. Local-slot cancellation releases only a slot actually acquired.
- Each real request, including the ranker's JSON-repair request, consumes the
  incumbent budget. CLI guards are separate per leg, have actual monotonic
  deadlines, are disposed in `finally`, and report counters. The conservative
  incumbent plan uses frozen target counts, not gold labels or model outcomes.
- Artifact output refuses an existing file before network and uses exclusive
  creation. Private/custody paths remain prohibited.
- Predictor is now `code-executed-v7`; old v6 captures and all sealed/rejected
  source/gold history remain unchanged. Existing positive HTTP-mocked tests use
  a disposable real guard; the absent-guard negative calls the real API directly.

## Verification and independent review

Before the final candidate fix, the targeted benchmark/capture/provider group
passed 215 tests with one skip. After that fix and its regression, the same
group passed **216 tests, one skip, zero failures**. The existing Vitest local
coordinator suite passed **8 tests**. Mixed-worktree TypeScript reported only
the already-known unrelated browser-investigation error at line 815.
The expanded final affected Bun group (adding preparation, collector and
Product Type/single/multiple attribute seams) passed **272 tests, one skip,
zero failures** at `2026-10-06T01:35:11.793Z`. Focused ESLint reported 11
findings; normalized comparison against the clean `9d2441d8` checkout confirmed
the same 11 baseline findings and **zero new findings**. It is not a lint pass.

Standards and Spec reviewed independently against the confirmed fixed point
and scoped patch. The real candidate guard hole was fixed and rechecked.
The reported guarded-semaphore fallthrough was withdrawn: JS run-to-completion
makes the no-signal legacy branch unreachable for a supplied signal after the
abortable branch. Neither axis has a remaining confirmed hard finding; optional
design/dynamic-limit notes are not qualification approval.

Fresh clean-commit verification is recorded separately after committing the
reviewed implementation. WIP checks above do not certify a future commit.

## Remaining qualification prerequisites

No live incumbent key bridge or representative comparison was provisioned or
executed. No additional manufacturer/store source requests, private labels,
holdout model inference, policy publication, human canary approval, promotion
or publishing occurred in this guard work. Source accounting remains the last
recorded **3107/3200, 93 remaining**.

#302 remains blocked; #312 retirement remains gated. Qualification needs an
explicitly provisioned incumbent context and approved full comparison budget,
faithful full-runtime stage context, actual Page/cohort seams and complete gold,
adequate independently adjudicated family/class support, fitted policies
published before blind holdout, and final Store Manager canaries. The current
five-family corrected holdout and previously inspected historical fixtures
cannot establish those gates.
