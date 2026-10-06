# Jev committed-code verification — 2026-10-05

## Source and isolation

All checks below executed from a new detached checkout of
`9d2441d828708876760b2b7b0e2952f349c4d958`
(`feat(benchmark): freeze Jev evidence and approved V8 definitions`).
The checkout is
`/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/jev-qualified-9d2441d8`.
Installed dependencies were linked through its ignored `node_modules` directory.
Tracked/untracked Git status was clean before and after the focused and
compatibility checks. No source changes from the mixed main worktree were copied.

## Focused verification

| Command | Result | Completed (UTC) |
|---|---|---|
| `bun run typecheck` | Pass | 2026-10-05T23:28:32.006Z |
| `bun test --timeout 60000 src/tests/unit/jev-benchmark-preparation.test.ts src/tests/unit/jev-benchmark-replay.test.ts src/tests/unit/jev-source-collection.test.ts` | 86 pass, 0 fail | 2026-10-05T23:28:34.724Z |
| `bun test --timeout 30000 src/tests/unit/typesafe-curation-qualification.test.ts src/tests/unit/typesafe-systemone.test.ts src/tests/unit/release-v6.test.ts src/tests/unit/release-v7.test.ts src/tests/unit/release-v8.test.ts src/tests/unit/release-authoring.test.ts` | 125 pass, 1 skip, 0 fail | 2026-10-05T23:29:01.192Z |
| `bun run test:unit -- src/tests/unit/taxonomy-release-client.test.ts` | 7 pass, 0 fail | 2026-10-05T23:29:02.534Z |

The excluded browser-investigation null/number error is absent in this clean
commit. These targeted results are not an assertion that the full test command
passes; the previous full-run and sourcing-observe limitations retain their
recorded meaning.

## Commit-bound compatibility

The four suite populations and process isolation are the same as documented in
`jev-commit-verification-5907853b-2026-10-03.md`, using
`bun test --timeout 30000` and its explicitly enumerated `src/tests/unit/` files.
`cohort-page-hash.test.ts` ran separately to preserve mock isolation.

| Required suite | Passed | Skipped | Completed (UTC) |
|---|---:|---:|---|
| other-providers | 145 | 0 | 2026-10-05T23:30:04.376Z |
| deterministic-rules | 189 | 0 | 2026-10-05T23:30:25.947Z |
| frozen-snapshots | 247 (203 + 44) | 0 | 2026-10-05T23:30:37.537Z |
| legacy-reads | 139 | 1 | 2026-10-05T23:31:12.608Z |

Total: 720 pass, 1 skip, 0 fail. The strict compatibility receipt is
`jev-compatibility-9d2441d8-2026-10-05.json`.
These suites overlap the focused checks; their counts are not added together
as a unique-test population.

## Actual bounded live contract

Executed the clean commit's `scripts/typesafe-live-contract-check.ts` with
explicit `TYPESAFE_LIVE_CHECK=1` and `--model=jev-1.13.0`, consuming the already
provisioned credential internally. The fixture is the script's approved
synthetic contract state, not a qualification product or private holdout.

The actual returned model was `jev-1.13.0`; one HTTP attempt, no retry,
551 input tokens and 109 output tokens. Choice and Noul answers passed the
shipped transport/schema validation. Receipt:
`jev-live-contract-9d2441d8-2026-10-05.json`.
This establishes endpoint compatibility, not product classification quality.

## Actual stored-disablement and lease boundaries

An isolated process imported the clean commit's real transport, repository,
protected-dispatch helper and ownership error class. It initialized only
`:memory:` and used a real loopback HTTP server; `fetch` was not mocked.
The captured connection object remained enabled while the repository authority
was disabled. For retry cases the loopback server changed stored enablement or
lease ownership immediately before returning HTTP 429 with `Retry-After: 0`.

| Boundary | Actual HTTP requests | Actual terminal error |
|---|---:|---|
| Disabled in store before dispatch, captured object enabled | 0 | `AiPolicyDeniedError` |
| Stored disablement after first response | 1; no retry | `AiPolicyDeniedError` |
| Lease loss after first response | 1; no retry | `HeartbeatLostError` |

All three boundaries passed. No vendor inference, provisioned credential or
production connection modification was involved. Source hashes and the exact
tested commit are in `jev-disablement-9d2441d8-2026-10-05.json`.

## Qualification decision

Fresh compatibility/live/disablement prerequisites now have concrete evidence
for `9d2441d8`. This does not clear #302 or authorize #312 retirement. The active
V8 authority, inadequate new holdout support, quarantined source generations,
blocked policy publication, incomplete incumbent and production Page/cohort
evaluation seams, and final human canary decisions remain as recorded in
`jev-v8-activation-and-qualification-status-2026-10-05.md`.
The earlier `5907853b` receipts remain unchanged historical evidence.
