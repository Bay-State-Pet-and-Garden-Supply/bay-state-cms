# Jev guarded-capture committed verification — 2026-10-06

## Source and isolation

Source commit: `5c295d40b74b08db4315321f522ef7d7e5504b75`
(`fix(benchmark): bind incumbent routing and request budgets`), based on
`9d2441d8`. The scoped commit contains 19 source/test/runbook/audit files;
86 concurrent worktree entries were excluded. No push occurred.
Staged inspection found zero forbidden DB/credential/custody paths and zero
credential-shaped matches. Both independent review axes had no remaining
confirmed hard findings after the candidate guard fix.

All checks below ran in the new detached checkout
`/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/jev-qualified-5c295d40`.
Only installed dependencies were linked through ignored `node_modules`.
Tracked/untracked status was clean before and after execution. No mixed-root
source changes or operational database were copied into the checkout.

## TypeScript and full test command

- `bun run typecheck`: **passed**, completed `2026-10-06T01:42:20.477Z`.
- `bun run test`: **exit 1**, completed `2026-10-06T01:48:02.026Z`.
  - Vitest: **330 files, 4250 tests passed, 1 skipped**.
  - Executed Bun groups in that full command: **2831 passed, 1 skipped,
    4 failed**. Later `&&` groups did not execute after failure.
  - Captured output also contained disk-I/O/uninitialized-DB diagnostics.
    Those are not a separately passed DB check; the full command is not green.

The smallest sourcing-observe rerun independently reproduced **2 pass, 4 fail**
at `2026-10-06T01:50:09.919Z`:

`bun test --timeout 30000 src/tests/unit/sourcing-observe-mode.test.ts`

The failing cases are found-evidence zero-mutation, conflict zero-mutation,
provider-error/timeout handling, and repeat-poll idempotency. These are the
same four sourcing-observe failures already reproduced at detached `e431eb35`,
not a new all-suite pass or a request to change unrelated sourcing behavior.

The previous affected WIP group passed 272 tests with one skip; the existing
local coordinator suite passed eight tests. Focused lint matched all 11
findings at clean `9d2441d8`, with zero new findings; lint was not green.
The clean preparation/replay/collector group independently passed **86 tests,
zero failures** at `2026-10-06T01:57:56.934Z`. Clean runner coverage passed:
657 suites scanned, 183 Bun suites, zero new violations, 30 documented-baseline.
The three JSON receipts below were checked against the strict compatibility
schema, actual exact pin, source hashes and recorded successful boundaries.

## Required commit-bound compatibility

All four suites ran with `bun test --timeout 30000`, using the exact file
populations listed in `jev-commit-verification-5907853b-2026-10-03.md`.
`cohort-page-hash.test.ts` ran in a separate process for mock isolation.

| Suite | Pass | Skip | Completed (UTC) |
|---|---:|---:|---|
| other-providers | 145 | 0 | 2026-10-06T01:50:20.505Z |
| deterministic-rules | 189 | 0 | 2026-10-06T01:50:40.354Z |
| frozen-snapshots | 247 (203 + 44) | 0 | 2026-10-06T01:50:50.505Z |
| legacy-reads | 151 | 1 | 2026-10-06T01:51:36.127Z |

Total **732 pass, 1 skip, 0 fail**. Strict receipt:
`jev-compatibility-5c295d40-2026-10-06.json`.
These counts overlap the full/affected test populations and are not added as
unique-test counts. The receipt certifies this source commit, not dirty main.

## Actual bounded live contract and disablement

The clean commit's opt-in `scripts/typesafe-live-contract-check.ts` ran with
`TYPESAFE_LIVE_CHECK=1`, `--model=jev-1.13.0`, and the already provisioned key
consumed internally. Actual returned model: **`jev-1.13.0`**, one HTTP attempt,
no retry, 551 input tokens / 109 output tokens. The state is the approved
synthetic contract fixture, not representative product/holdout data.
Receipt: `jev-live-contract-5c295d40-2026-10-06.json`.

A separate isolated process imported this exact commit's transport,
repository, protected-dispatch helper and lease error. It initialized only
`:memory:` and used a real loopback server; no fetch mocks or vendor inference.
Stored disablement before dispatch produced **0 requests**. Disablement after
HTTP 429 produced **1 request/no retry**. Lease loss after HTTP 429 produced
**1 request/no retry**. Actual errors were `AiPolicyDeniedError`,
`AiPolicyDeniedError`, `HeartbeatLostError`; all three boundaries passed.
Source hashes and commit are in `jev-disablement-5c295d40-2026-10-06.json`.

## Standards

The independent Standards review found the public candidate capture could
dispatch with a key but no bound guard. Its red regression sent two requests;
the corrected API returns `jev_runtime_guard_unwired` with zero. The final
review has **zero confirmed hard findings**. A semaphore fallthrough finding
was withdrawn after control-flow verification; optional design/dynamic-limit
observations remain judgments, not release approval.

## Spec

The independent Spec review reports **zero new incorrect implementations or
unauthorized scope** in the reviewed guard patch. Actual source/model/endpoint
identity, null unknown usage, repair-inclusive budgeting, monotonic deadlines,
DB context/alias checks and immutable output behavior are implemented.
True #302 requirements still missing are a provisioned real incumbent/full
comparison, faithful full-runtime context, actual Page/cohort evaluation,
adequate source/gold support, fitted published policies and human canaries.

## Decision

**#302 blocked; #312 gated; review required.** The active V8 authority remains
`78f550f0b31c51c5a3c4b5f614e0bc953a90fdbe49749b7b39d6cd2ceeeef2de`, with catalog
pin `9d8b54cf83d42e00e988f08efae7f280ebd76b69`. No new V8 accuracy, holdout unseal,
policy publication, human approval, promotion or ShopSite publishing is claimed.
Manufacturer/store source accounting remains 3107/3200, 93 remaining.
Historical receipts/captures retain their original byte identities and scope.
