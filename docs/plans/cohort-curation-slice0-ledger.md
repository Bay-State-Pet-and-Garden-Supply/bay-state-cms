# Slice 0 — case-transfer ledger (replacement manifest)

Baseline: HEAD `b1782f5`, 222 dirty entries (221 pre-existing + 1 Slice 0
fixture), index empty (`git diff --cached --name-only` = 0 lines).
Rule: a file is deleted only after every unique contract below has a named
replacement passing in the same slice. Test-count reduction alone is not success.

## Corrected case count: 55, not 50

The prior draft headered the title suite as "34 cases". Recount by `it(`:
`cohort-title-coordinator.test.ts` contains **39** cases (28 in the PR6-C4
describe, 11 in the PR13-C2 describe). The draft grouped the five P1-3
PARITY cases (lines 1676–1734) into one table row and dropped four more in
the row tally. Corrected totals: **11 + 39 + 5 = 55**.

## 1. `src/tests/unit/cohort-lease-keeper.test.ts` (11 cases) → DELETE after transfer

Private timer/`lost`/`stopped` field assertions have no replacement value;
their public-behavior equivalents go to `cohort-curation-recovery.test.ts`:

| Old case (line) | Replacement target | Boundary asserted |
|---|---|---|
| calculates intervalMs (25) | harness clock config assertion in `helpers/cohort-curation-harness.ts` self-test | renewal cadence = max(1, floor(TTL/3)) without touching private fields |
| start() sync renewal + timer (37) | recovery: slow-live-owner scenario | second worker cannot reclaim renewed row; no scheduled renewal after terminal |
| start() idempotent (54) | recovery: duplicate executeClaim on running parent | second claim is not-executed disposition, zero writes |
| start() initial-renewal failure → HeartbeatLostError (69) | recovery: reclaim-before-transport | A makes no post-loss writes; B alone finishes |
| periodically renews via timer (79) | recovery: slow-live-owner + controlled time | renewals visible in repo lease columns only |
| renew() updates lost on heartbeat fail (94) | recovery: expired/reclaimed mid-title | lost owner raises HeartbeatLostError, zero further writes |
| renew() short-circuits stopped/lost (107) | recovery: completion leaves no scheduled renewal; advancing time performs no lease writes | timer lifetime via observable lease columns |
| assertHeld() success (122) | interface: normal multi-member run | ownership asserted at commit boundaries (observable commit) |
| assertHeld() throws mid-execution (132) | recovery: mid-singleton-Page ownership loss | no Page insert under stale owner |
| assertHeld() throws when previously lost (143) | recovery: release-then-write attempt | post-loss audit/terminal/output/item/child/parent writes = 0 |
| stop() clears timer + stopped (151) | recovery: success + crash paths | `finally` stops timers (no lease writes after terminal) |

## 2. `src/tests/unit/cohort-title-coordinator.test.ts` (39 cases) → DELETE after transfer

### PR6-C4 describe (28 cases, lines 609–1776)

| Old case (line) | Replacement target | Boundary asserted |
|---|---|---|
| fresh run 1-call/2-rows/audit pair (610) | `cohort-curation-interface.test.ts` normal family | freeze→title→page→member ordering; audit pair on ordinal-0 child |
| e09 fallback validation fail → zero llm rows (651) | interface: fallback family validation | all-or-nothing deterministic fallback; no stale llm row resurrection |
| lint-blocked → zero llm rows (700) | interface: lint-blocked family | deterministic fallback committed; reuse cannot resurrect |
| same-run reuse zero calls (748) | recovery: post-commit re-entry | call-free reuse of committed decisions |
| corrupt row → CohortTitleOutputCorruptError (778) | recovery: current-output-integrity matrix | parent superseded + children terminalized; old bytes unchanged |
| empty row → CorruptError (831) | recovery: integrity matrix (empty title) | schema-violation cause; member failure, not usable draft |
| stale-hash nonempty set → DriftError (868) | recovery: drift + integrity matrix | set untouched, zero new calls |
| incomplete set → DriftError (924) | recovery: integrity matrix (missing row) | all-or-nothing; no partial rows |
| persistence failure → zero rows (966) | recovery: title pre-commit crash | crash-twice; reclaim re-invokes once then call-free |
| HeartbeatLost after LLM → no rows (995) | recovery: expired/reclaimed mid-title | zero post-loss writes |
| LLM failure → cohort_fallback row (1018) | interface: model-unavailability | audited fallback; model_call_id NULL |
| policy-denied terminal row (1044) | interface: expected-empty vs abstention | durable audited denial; retry consumes without transport |
| unavailable terminal row (1074) | interface: expected-empty vs abstention | durable audited unavailability |
| singleton: no row, no call (1101) | interface: singleton/mixed-group | member-local naming; grouped member cannot fall back |
| PR13 C1 authority slice (1119) | `cohort-title-hash.test.ts` + interface | op-specific authority only; plan-entry change re-coordinates |
| reuse-path pure read (1215) | recovery: reuse scenarios | terminal child never replaced |
| missing audit authority fail-closed (1262) | interface: input authority | fail before transport |
| missing plan fail-closed (1284) | interface: input authority | never non-audited live call |
| per-group call ids (1319) | interface: multi-group run | per-group provenance |
| crash→reclaim→commit→reuse (1371) | recovery: title pre-commit crash | re-invoke once, then call-free |
| prompt == hash authority (1474) | `cohort-title-hash.test.ts` parity + pure leaf | OCR/type lines identical in both |
| extra-row corruption → drift (1543) | recovery: integrity (extra row) | never reused, zero calls |
| no-group-but-rows → fail-closed (1591) | recovery: integrity (unexpected rows) | never silent empty-map |
| P1-3 PARITY id-only mutation (1676) | `cohort-title-hash.test.ts` + classification leaf | id change moves both T-hash and prompted authority |
| P1-3 PARITY label-only mutation (1687) | `cohort-title-hash.test.ts` + classification leaf | label change moves both T-hash and prompted authority |
| P1-3 PARITY webBrand-only mutation (1712) | `cohort-title-hash.test.ts` + classification leaf | webBrand change moves both T-hash and prompted authority |
| P1-3 PARITY weight-only mutation (1723) | `cohort-title-hash.test.ts` + classification leaf | weight change moves both T-hash and prompted authority |
| P1-3 PARITY flavor-only mutation (1734) | `cohort-title-hash.test.ts` + classification leaf | flavor change moves both T-hash and prompted authority |

### PR13-C2 describe (11 cases, lines 1778–2110)

| Old case (line) | Replacement target | Boundary asserted |
|---|---|---|
| same authority copies superseded set (1779) | recovery: cross-parent title copy | zero calls, original model-call ids, old rows untouched |
| different authority → fresh (1810) | recovery: cross-parent copy negative | one call, no copy |
| incomplete superseded → fresh (1833) | recovery: cross-parent copy negative | no reuse of corrupt set |
| foreign cohort → fresh (1853) | recovery: cross-parent copy negative | cohort-scoped lookup |
| stale-hash sibling commit → drift (1918) | recovery: commit-race | never copies over non-empty set |
| copy-race → DriftError (1947) | recovery: commit-race via beforeTitleCopyInsert | sibling rows intact |
| latest-only reuse (1985) | recovery: cross-parent copy negative | older matching set never consulted |
| never non-superseded candidate (2013) | repository suite | running sibling not a candidate |
| superseded_at tie id-breaker (2025) | repository suite | deterministic DESC/id-DESC |
| param-set mismatch → fresh (2043) | recovery: cross-parent copy negative | P1 vs P2 no copy |
| same params → reuse (2079) | recovery: cross-parent copy positive | economics preserved |

## 3. `src/tests/unit/synthesis-ordering-guard.test.ts` (5 cases) → DELETE after transfer

All go to `cohort-curation-interface.test.ts` executed-member scenarios
through the real guard at the shared result-to-synthesis boundary:

| Old case (line) | Replacement target | Boundary asserted |
|---|---|---|
| all stages terminal → pass (42) | member happy path | 7 required stages each have output or Reviewable Abstention |
| abstention satisfies terminality (46) | member with valid abstention | abstention proposal counts as terminal |
| silent stage → fail closed (68) | per-stage omission matrix (each of 7) | no synthesis/projection commit; error names run/SKU/stage |
| silent draft projection → fail (75) | omission matrix: draft_projection | same title/source in stage projection and assembled draft |
| error carries run+member id (81) | omission error identity | diagnostic names run/SKU/stage |

## 4. Golden fixture

`src/tests/fixtures/cohort-curation-authority-golden.json` (new, Slice 0):
synthetic two-member official_page v1 projection; literal titleHashV2
`ab424543…6a4685`, pageHashV1 `819a7c49…a63dc`, extractionHashH2
`cc94ea34…96c600`, membershipHash `4a0afc55…8985a4f`; canonical-draft
contract = PR8 DECISION-E field list (ids/timestamps excluded), proven by
`pr8-acceptance.test.ts` retry byte-identity (not re-derived here).

### Reproduction (verified 2026-09-08)

Generator: `docs/plans/cohort-curation-slice0-gen-golden.ts` (in-repo copy of
the Slice 0 script; pure hash functions only, no DB, no network).
Command: `bun docs/plans/cohort-curation-slice0-gen-golden.ts`.
Re-running it reproduces all four `expected` hashes byte-identically
(titleHashV2, pageHashV1, extractionHashH2, membershipHash — all match).
Seed = hardcoded synthetic inputs in the script (run-slice0 / SKU-1 / SKU-2).

### Why golden inputs diverge from unit fixtures

Unit suites build full DB-backed cohorts (workspace, items, snapshots, model
calls); the golden uses minimal synthetic members exercising only the pure
hash functions (`computeCohortTitleInputHash`,
`buildCohortPageAuthorityBundle`/`computeCohortPageInputHash`,
`computeExtractionHash`/`computeMembershipHash`). It pins hash bytes, not
pipeline behavior — pipeline behavior stays pinned by the suites in §5.

## 5. Baseline evidence (this worktree, not HEAD reconstruction)

| Suite | Command | Result |
|---|---|---|
| cohort-freeze | `bun test --timeout 30000 src/tests/unit/cohort-freeze.test.ts` | 49 pass, 0 fail, exit 0 |
| cohort-worker | `bun test --timeout 30000 src/tests/unit/cohort-worker.test.ts` | 53 pass, 0 fail, exit 0 |
| cohort-title-hash | `bun test --timeout 30000 src/tests/unit/cohort-title-hash.test.ts` | 51 pass, 0 fail, exit 0 |
| cohort-page-hash | `bun test --timeout 30000 src/tests/unit/cohort-page-hash.test.ts` | 44 pass, 0 fail, exit 0 |

Total 197 pass, 0 fail. Toolchain: `bun@1.3.5`, `tsc 5.9.3`.
Raw logs: out-of-repo evidence dir (path recorded in
`/tmp/cohort-slice0-evidence-path.txt` — ephemeral; copy before eviction); no live-DB writes, no network.

Retiring suites (`cohort-lease-keeper`, `cohort-title-coordinator`,
`synthesis-ordering-guard`) were counted by `it()` (11/39/5) but NOT
executed in this slice; execution is deferred to the Slice 1 pre-delete
gate — recount + execute before any DELETE. Risk: line-number drift or a
silently failing retiring suite; mitigation is that gate.

`implementationHashes` in the fixture are pinned literals, not derived by
the generator — a re-run reproduces them trivially without proving source
identity. Verify separately (e.g. `sha256sum src/onboarding/cohort-*.ts`)
so a future edit cannot silently keep stale hashes.

## 6. Slice 3 actuals — `cohort-title-coordinator.test.ts` transfer + delete

Pre-delete gate: old suite executed at slice start — **39/39 green** (355
expects). New seam suite `src/tests/unit/cohort-curation-titles.test.ts`
executes **41/41 green** (385 expects): all 39 transferred + 2 new
public-seam crash tests. Old file deleted; `test:db` + vitest exclude
registration renamed to the new filename (same isolated invocation slot;
runner-coverage: 0 new violations).

Transfer mode: the 39 cases kept their fixture builders + counting
llm-client mock (moved with the file) and were re-pointed from the old
transitional entry to the new-seam entry `ensureCohortTitles`
(`src/onboarding/cohort-curation/titles.ts`); the two symmetry-only params
(`workspacePath`, `members`) were dropped at all 39 call sites. Pure
PARITY mirrors already existed in `cohort-title-hash.test.ts` (id / label /
webBrand / weight / flavor + truncation) — only the stale file pointer was
updated there. `pr6-acceptance.test.ts` comment pointers updated (no
behavior change).

| Old case | New home | Boundary asserted (unchanged) |
|---|---|---|
| fresh run 1-call/2-rows/audit pair | titles suite, same name | ordering; audit pair on ordinal-0 child |
| e09 fallback validation → zero llm rows | titles suite, same name | all-or-nothing deterministic fallback |
| lint-blocked → zero llm rows | titles suite, same name | fallback committed; reuse cannot resurrect |
| same-run reuse zero calls | titles suite, same name | call-free reuse of committed decisions |
| corrupt row → CorruptError | titles suite, same name | supersede + children terminalized; bytes unchanged |
| empty row → CorruptError | titles suite, same name | schema-violation cause |
| stale-hash set → DriftError | titles suite, same name | set untouched, zero calls |
| incomplete set → DriftError | titles suite, same name | all-or-nothing; no partial rows |
| persistence failure → zero rows | titles suite, same name | crash-twice covered at seam (new tests below) |
| HeartbeatLost after LLM → no rows | titles suite, same name | zero post-loss writes |
| LLM failure → cohort_fallback row | titles suite, same name | audited fallback; model_call_id NULL |
| policy-denied terminal row | titles suite, same name | durable denial; retry without transport |
| unavailable terminal row | titles suite, same name | durable unavailability |
| singleton: no row, no call | titles suite, same name | member-local naming |
| PR13 C1 authority slice | titles suite, same name | op-specific authority only |
| reuse-path pure read | titles suite, same name | terminal child never replaced |
| missing audit authority fail-closed | titles suite, same name | fail before transport |
| missing plan fail-closed | titles suite, same name | never non-audited live call |
| per-group call ids | titles suite, same name | per-group provenance |
| crash→reclaim→commit→reuse (op-level) | titles suite, same name, PLUS new public-seam crash-twice test below | re-invoke once, then call-free |
| prompt == hash authority | titles suite, same name | OCR/type lines identical in both |
| extra-row corruption → drift | titles suite, same name | never reused, zero calls |
| no-group-but-rows → fail-closed | titles suite, same name | never silent empty-map |
| P1-3 PARITY id-only | titles suite (full) + hash suite (pure mirror, pre-existing) | id moves hash + prompt |
| P1-3 PARITY label-only | titles suite (full) + hash suite (pure mirror, pre-existing) | label moves hash + prompt |
| P1-3 PARITY webBrand-only | titles suite (full) + hash suite (pure mirror, pre-existing) | webBrand moves hash + prompt |
| P1-3 PARITY weight-only | titles suite (full) + hash suite (pure mirror, pre-existing) | weight moves hash + prompt |
| P1-3 PARITY flavor-only | titles suite (full) + hash suite (pure mirror, pre-existing) | flavor moves hash + prompt |
| copy same-authority superseded set | titles suite, same name | zero calls, original call ids |
| different authority → fresh | titles suite, same name | one call, no copy |
| incomplete superseded → fresh | titles suite, same name | no corrupt-set reuse |
| foreign cohort → fresh | titles suite, same name | cohort-scoped lookup |
| stale-hash sibling commit → drift | titles suite, same name | never copies over non-empty set |
| copy-race → DriftError | titles suite, same name | sibling rows intact |
| latest-only reuse | titles suite, same name | older set never consulted |
| never non-superseded candidate | titles suite, same name | running sibling not a candidate |
| superseded_at tie id-breaker | titles suite, same name | deterministic DESC/id-DESC |
| param-set mismatch → fresh | titles suite, same name | P1 vs P2 no copy |
| same params → reuse | titles suite, same name | economics preserved |
| (new) title pre-commit crash ×2 → commit → call-free reuse | titles suite, NEW via `executeClaim` | §3.3 public-seam evidence; fulfills deferred Slice 2 item |
| (new) ownership lost in title window | titles suite, NEW via `executeClaim` | zero post-loss writes; reclaimer alone finishes |

Deferred Slice 2 item closed: title `afterCoordinatedCall` checkpoints now
thread through the public `executeClaim` invocation (`index.ts` →
`processCohort` → title op); page-kind arm stays inert until Slice 4.
`recovery.test.ts` header updated to point at this file for title
pre-commit coverage.

## Slice 5 gate P1 resolution (member evidence through the public seam)
Tests-reviewer P1: member-phase evidence in `cohort-worker.test.ts` / pr8 / pr9
ran through `processCohort` directly rather than public `executeClaim`.
Resolution (supervisor judgment, accepted):
- No dual dispatch exists: `job-queue.ts` calls ONLY `executeClaim`, which
  delegates to the single `processCohort`. Direct tests exercise byte-identical
  member orchestration; only claim-validation is bypassed, and that wrapper is
  covered independently (interface suite: 4 input-authority + terminal re-entry).
- Migrated 4 representative member-phase tests to `executeClaim`, proving every
  member checkpoint threads publicly: in-transaction observe + throw-rollback
  (`afterMemberProjectionDependencyInsert`), Brand crash + worker-b reclaim
  re-entry (`afterMemberCommit`), B3 blocked-resume restore (`afterMemberCommit`
  + reclaim re-entry). All green (53/53 worker suite).
- Remaining `processCohort`-direct sites (other worker/pr8/pr9 cases) stand as
  valid member-semantics evidence under the no-dual-dispatch proof above.

## Slice 6 completion (remove scaffolding, close evidence)
Executed directly by supervisor (subagent timeouts on long silent commands).

**Deleted (6):** `src/onboarding/cohort-curator.ts` (1658 lines),
`cohort-title-coordinator.ts`, `cohort-page-coordinator.ts`,
`cohort-title-hash.ts`, `cohort-page-hash.ts`, `cohort-lease-keeper.ts`.

**Moved verbatim (no behavior change):**
- T-hash authority → `cohort-curation/titles.ts`; P-hash authority →
  `cohort-curation/pages.ts` (import depths fixed; transitional leaf
  re-exports dropped; externals now import from titles/pages/leaf directly).
- `freezeCohortForExecution` + OCR pull-forward + helpers → `freeze.ts`.
- `processCohort` → module-private in `index.ts` (production enters via
  `executeClaim`; tests via `executeViaSeam`); stale Slice-2/4 comments updated.
- `PreparedCohortContext` + transitional adapter →
  `src/tests/unit/helpers/transitional-prepared-member.ts` (new;
  `curateTransitionalPreparedMember`); production `curateItemWithPipeline`
  drops the 4th param; unused imports pruned from `product-curator.ts`.
- `executeViaSeam` added to `cohort-curation-harness.ts` (public-seam entry
  returning the summary, throws on not-executed dispositions).

**Migrated (~150 sites):** all 18 test consumers of the doomed modules;
116 `processCohort(` direct calls → `executeViaSeam` (nearest-preceding
claim/reclaim owner resolution; two owner bugs found and fixed via test
failures: truncated `worker-b` capture, cross-test `finalized` binding);
10 prepared 4th-arg calls → helper; pr7 adapter calls → `ensureCohortPages`
new shape; worker spy test → `titles.ensureCohortTitles`;
`job-queue` shadow-observation type import → `index.ts`; heartbeat-errors
comment corrected. `e04s02` dynamic import → static frozen-evidence import.

**Validation:** typecheck exit 0; goldens byte-identical (generator repointed);
titles 41, pages 8, interface 14, recovery 9, freeze 49, worker 53, hashes
95+44, repo 91, pr6–pr13 all green (94), pipeline+OCR 56, boundary/page/prompt
49 vitest, name-coord/processor 81 vitest, draft/approval/manual 42,
distributor+sourcing 37, runner-coverage 0 new violations, diff-check clean,
index empty. No registration changes needed (no suite add/removes; new suites
already in test:db).

**Known pre-existing debt (not Slice 6):** `e04s02` 2 failures (legacy V1
projection shape vs V3-era `buildFrozenItem`; function unchanged by Slice 6 —
old module re-exported the identical function); `@ts-ignore`→`@ts-expect-error`
lint notes and misc unused-var notes at untouched lines; full `bun run test`
broad suite not run (missing external artifacts gate, per plan §6).
