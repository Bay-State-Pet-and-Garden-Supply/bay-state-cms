# Cohort Curation deepening plan

## Status and scope

**Planning artifact only; no implementation or activation is authorized by this document.** Candidate 1 is the existing **Curation: Cohort freeze → coordinated title / coordinated Category Page assignment → member draft** cluster. The change replaces its scattered execution plumbing with one deeper module; it does not replace the classification pipeline or add a second orchestrator.

The deliverable is a smaller execution interface backed by the existing durable authorities, with fewer independently implemented lifecycle rules. Merely moving `cohort-curator.ts` into a directory, adding a facade over unchanged coordinators, or sharing a hashing utility does not meet acceptance.

### Inputs and interpretation

Read for this plan:

- `CONTEXT.md`: Onboarding Pipeline; Classification Stage, Stage Dependency, Stage Abstention and Reviewable Abstention; Product Draft Projection; Family Readiness Barrier; automation-owned progression and durable Review.
- `docs/plans/classification-system-implementation-plan.md`: safety boundary, immutable runtime snapshots, repository/configuration authority, review and Page identity contracts.
- ADRs `0004`, `0013` **including PR3–PR13 amendments**, `0016`, and `0033`.
- Scout handoff `/Users/nickborrello/.pi/agent/sessions/--Users-nickborrello-Desktop-Projects-bay-state-cms--/subagent-artifacts/outputs/3518d6fc-3c9c-4f34-a332-a52df358da71/context.md`, candidate 1 and coverage gaps.
- All requested cohort source modules, their worker/stage/repository consumers, relevant test suites and runner configuration.
- `/tmp/review-correctness.md`, `/tmp/review-tests.md` and `/tmp/audit-102.md`: these concern the stage-vocabulary rewrite and manual evidence, not a newer cohort-architecture verdict. Applicable cautions are runner registration, explicit fault seams, immutable history, and preserving manual-evidence source semantics.

Use **Cohort** for the durable, versioned candidate family; its readiness is not execution state. `CONTEXT.md` currently names the readiness concept **Family Readiness Barrier**. ADR 0013 supplies coordinated decision ownership and target scopes. A **Product Draft Projection** is a preview, not a CMS product draft. Current classification metadata can contain explicitly provisional preview supplements; only reviewed/accepted decisions can authorize Promotion.

The inspected worktree already has **220 dirty entries**. This is not a clean-HEAD refactor. All baselines below must be captured from the writer's actual starting worktree, not reconstructed from HEAD.

## 1. Constraints, dependencies and fail-closed invariants

### 1.1 Operating constraints

1. One sequential writer. Before each slice, record its exact allowlist, starting file hashes, status and index manifests for the outer repository and nested catalog repository. Preserve unrelated hunks, untracked files and existing staged content; do not clear the index to manufacture a clean baseline.
2. No reset, clean, stash, checkout/restore-based rollback, broad staging, commits or pushes. The governing plan's exact-path nested-catalog commit exception is for its sanctioned configuration activation only; **this refactor has no catalog commit to make**.
3. No network, paid crawl, model download, live model/OCR request or ShopSite operation. Use synthetic fixtures and transport fakes. No real credentials in fixtures or logs.
4. No live-DB writes, schema migration, repair, backfill, activation or production cohort rerun. Tests initialize an explicitly named disposable SQLite database and temporary workspace. Any later separately sanctioned repair/activation requires verified backups and its own approval/runbook; it is not a step here.
5. Preserve persisted schemas, output kinds, rule versions, hash compositions, stage identifiers and source dispatch. Do not mix this work with the dirty stage-vocabulary/shell rewrite. Existing canonical stage encoding and SSE shapes remain unchanged.
6. New or relocated SQL belongs in `src/db/repositories/`; do not carry inline SQL into new orchestration modules. Existing transaction boundaries may compose repository operations synchronously; never hold a transaction across a model call or another `await`.

### 1.2 Authority contracts

| Boundary | Required behavior |
| --- | --- |
| Candidate readiness | `curation-cohort-service.ts` remains the readiness authority. All active members must satisfy the source/extraction/provenance barrier. Waiting and blocked remain distinct and mutually exclusive with ready. A pre-Curation failure blocks; a Curation failure is not an Extraction-readiness failure. No partial-family escape hatch. |
| Candidate vs run revision | Membership changes supersede the candidate cohort; ordinary evidence progress updates candidate readiness in place. Evidence/configuration drift supersedes the **run**, not candidate identity. Preserve the one-current-non-superseded-run index and terminal-current history. |
| Freeze | One two-phase freeze: capture shared authority, prepare children/snapshots and settle permitted OCR outside the final transaction, then re-read and compare at final CAS. Only that transaction may move `freezing → running`. A conflicting Execution Product Type takes the existing direct `freezing → failed` path, never briefly runs. |
| Shared authority | Retain configuration snapshot references and focused-file/catalog-evidence hashes, verified Page import identity and records, frozen field options, model/data-sharing policies, execution plan and runtime rule versions. Preserve the actual H1–H5 fields and combined H5 digest; do not substitute a new umbrella hash. |
| Evidence projection | New freezes still write `execution-evidence-v3`. Preserve `buildExecutionEvidenceProjectionV3`'s ordering, schema validation, source bindings, imported-identity envelope, per-member evidence hash, merchandising/manual provenance and authoritative nulls. Historical v1/v2 adaptation is in-memory only; no historical JSON rewrite or version bump. |
| OCR | Preserve existing input-hash and execution-digest checks, stale markers, rerun cap, source exclusions, run-bound audit and packaging-OCR flag behavior. Shadow observations cannot create reusable OCR authority. This slice relocates freeze wiring, not the OCR algorithm or stage. |
| Prepared member | Construct semantic fields from the persisted projection, not a live-item spread. Only the current identity/pipeline fields explicitly allowed by `buildFrozenItem` remain live. Preserve its current allowlist exactly. Null source URL remains null; no live sibling/config/Page/source-attempt fallback. |
| Source variants | Official-page, qualified `distributor_record_v1/v2`, and attested `manual_evidence_v1` keep their existing distinct provenance rules. Do not add a source type or require a URL/profile for a valid null-URL source. Verified distributor merchandising stays frozen; price/inventory/image-rights authority is not expanded. |
| Classification | Keep ADR 0004's replaceable `StageDefinition`s and **one** `composeCurationPipelineStages` composition point. Keep the seven required stages and existing optional packaging-OCR/value-gap-stage conditions. No giant combined prompt, new assistant, or changed fallback/authority policy. |
| Type authority | Execution Product Type is a frozen proposal-driving authority, not reviewed catalog truth. Preserve reviewed-first effective type, reviewed-facts-only applicability conditions, conflict/abstention rules and exact type dependency hashes. |

The final CAS must retain membership, member evidence/OCR-input, configuration, Page and model-authority comparisons and their observed-owner supersession behavior. Initial authority capture is not sufficient proof of a coherent freeze.

### 1.3 Lease, expiry and recovery

- Parent runs own the lease, not items, a module singleton or an in-memory promise cache. Preserve the current 15-minute default TTL and `max(1, floor(TTL / 3))` scoped renewal cadence.
- Assert ownership synchronously before starting long work, periodically while it is pending, after awaited continuations, and immediately before subsequent audit/output/member/terminal writes. Timers must be stopped in `finally` on success, ordinary failure, simulated crash and ownership loss.
- Preserve repository semantics: expiry makes a run **eligible for reclaim** (`lease_expires_at < now`, also the existing null-lease case), not `now - TTL`. Equality is not yet expired. `heartbeatCohortRun` currently guards owner plus active status, not an additional wall-clock expiry predicate. Do not silently introduce lease revocation semantics during this refactor.
- Reclaim uses CAS on observed owner, lease and status. Match resumes the same parent; drift supersedes that observed parent. A stale verification verdict must never supersede a newly reclaimed run. A null-hash run vacuously matches only while `freezing`.
- A lost owner raises the existing `HeartbeatLostError` and performs **no further terminal/item/output writes**; do not turn it into title fallback, page abstention, member failure or parent completion.
- Be precise about delivery: zero further parent coordination calls after a kind's complete durable set commits. Pre-commit crashes may cause multiple independently audited calls on recovery; there is no provider exactly-once guarantee, retry cap, or cancellation guarantee for an already dispatched transport. Never promise physical transport exclusivity after process suspension merely because writes are owner-fenced.
- Preserve per-kind transactions: titles may already be committed when page coordination crashes. Do **not** make title and page sets one all-or-nothing super-transaction.

### 1.4 Hash and decision asymmetries that must not be generalized away

| Property | Coordinated title | Coordinated Category Pages |
| --- | --- | --- |
| Persisted kind | `curated_title` | `coordinated_page` |
| Expected set | Members of actual frozen multi-item groups only; true singleton titles remain member-local | All members, including singleton groups, when the target has verified candidates |
| Current payload/hash version | Title hash payload version 2 | Page hash payload version 1 |
| Same-parent reuse | Exact expected set + every input hash matches + every payload parses | Same rule, with assigned/abstained payloads |
| Cross-parent reuse | Only latest superseded run of this cohort; exact set/hash; preserve original row-level `model_call_id`; corrupt source set causes fresh coordination | **None** |
| Config-level absence | No multi-item group: expect zero rows; unexpected rows are drift | Disabled target or no verified Pages: expect zero rows; unexpected rows are drift |
| Model unavailability | Preserve audited existing parent fallback behavior and `cohort_fallback` source | Persist a coded/reasoned abstention per member; retry consumes it without transport |
| Materialization | Multi-member row required; missing/empty result must not trigger child title generation | Stored assigned/abstained row or explicit expected-empty result required; never invent an assignment |

Hash preservation means literal output equality, not “equivalent ingredients.” Keep sorting/comparators, null/empty handling, truncation and canonical serialization unchanged:

- **T-hash:** final membership; current frozen title slices; source provenance; Execution Product Type id/label/confidence/outcome; FORMAT_RULES digest; family-title-consistency and title-lint versions; operation-specific title plan entry and executed title parameters. No reintroduction of the old broad policy digest.
- **P-hash:** sorted SKU/member slices; source provenance; frozen Page id/name/parentName list and selection/maxPages; the same Execution Product Type object rendered by the parent prompt; operation-specific frozen `cohort_page_assignment_parent` authority; category-page-correctness version.
- Page prompt normalization and hash input must keep using the same authority bundle. Title normalization must retain shared title cutoffs. Do not “clean up” either hash by changing order, grouping, adding imported identity, normalizing URLs differently, hashing the whole snapshot or including unrelated model routes.
- The concrete source-provenance accessor includes URL values, not merely URL null-ness. Some old hash comments describe narrower exclusions; source plus golden fixtures are the baseline.
- Fresh audited calls still pass frozen-plan/operation/registry compatibility checks. No live credential lookup may recalculate a reuse hash. Preserve C6b's narrowly scoped page-proposal linkage exception: same parent and SKU, `coordinated_page` kind, `category_page` proposal, existing terminal-success call. A copied title call id is row provenance, not permission to widen proposal linkage.

### 1.5 Materialization, synthesis and publication boundaries

1. Title coordination precedes Page coordination; both settle before any member pipeline executes. Member execution stays ordinal and sequential.
2. `product_draft_projection` still declares `name_consolidation`, Page and attribute proposal dependencies. Projection metadata and CurationData read the **same** name-consolidation title/source output, not separate derivations.
3. Description/search-keyword assembly stays strictly after `runPipeline`. `assertCohortSynthesisOrdering` still requires each of the seven required stages to have a stage-output entry or a matching Reviewable Abstention. Missing terminal evidence fails the member; do not replace this guard with “pipeline promise resolved.”
4. Member semantic validation precedes its commit. Atomically commit CurationData, item completion, child terminal status and proposal dependency metadata. Preserve universal-attribute exclusions; page dependencies follow the parent's Execution Product Type even when the member's fields follow a compatible reviewed type. Include prior persisted proposal rows from a pre-crash attempt, not just the latest in-memory list.
5. Resume skips a member only with the existing three-part proof: terminal-success child, matching `classificationRunId` in committed CurationData, and completed item status. Otherwise reuse/recreate the child with freeze-persisted snapshot references and execute again.
6. Semantic blocks preserve their draft/proposals for Review; they are not payload corruption. Restore blocked-member failure summaries on resume. Run post-loop frozen Brand coherence over committed members, preserve cohort-atomic owner-guarded updates, dedupe findings/failures and emit final follow-up SSE state before parent completion.
7. Parent output **set corruption** or drift supersedes the parent and terminalizes running children atomically; old rows remain immutable. Missing/corrupt member materialization input fails that member closed. Never use usable fragments from a corrupt durable parent set to continue the run.
8. The module stops at committed Curation results. `sweepAutoAdvance` owns progression; Review completion, Approval, Promotion and export gates remain untouched. Parent-running or superseded children must remain non-reviewable even if one member has committed.
9. Retry determinism is the **canonical draft artifact**, not full JSON identity: retain the PR8 signature over title/source, suggested Pages/type, keywords/description/weight/OCR title and projection fields/Pages/title. Run/proposal/evidence IDs, timestamps and audit history are intentionally excluded. Compare added semantic/source-provenance fields separately where their meaning must also stay stable.

## 2. Target module and small external seam

### 2.1 External API

Create `src/onboarding/cohort-curation/index.ts` as the actual execution owner, not a permanent re-export facade. Bind workspace identity/path once with `createCohortCuration`; keep construction side-effect-free, with no worker or timer started by importing/constructing it.

Its core public operations are:

| Operation | Input | Output / responsibilities |
| --- | --- | --- |
| `executeClaim` | Parent `runId` and expected `workerId`; no caller-built projection, hashes, maps, snapshots or member list | Load and validate persisted workspace/run/owner. Freeze if `freezing`; execute if `running`; return completion summary or an explicit not-executed terminal disposition. Missing/foreign/stale-owner inputs fail without mutation. Never claim a cohort or manufacture a retry. |
| `verifyFrozen` | The repository's observed `CohortRun` | Synchronous `match`/`drift` verdict using the existing verification semantics. Retain the observed row for the repository CAS; do not make this an async callback or silently replace it with a newer owner observation. It does not reclaim/supersede itself. |

Retain the existing deterministic shadow observation capability as a separately named compatibility export, `observeCohortShadowTypeResolution`, from this module. Its implementation may live beside freeze authority construction; it is not part of `executeClaim`, does not claim/coordinate, and is not a new rollout mode. Preserve current observation output and worker persistence behavior.

`executeClaim` replaces the worker's current freeze/process branch. Exceptions that currently leave an unfinished claim for expiry recovery remain exceptions; do not add catch-all completion, cleanup, automatic release or fallback. A completed/failed/current historical parent is not re-executed by this API. Freeze conflict/supersession is a normal not-executed result; output-integrity failure retains a specific diagnostic/cause after the owner-guarded supersession path. Report completion only when the terminal write was accepted.

The worker continues to own startup/poll reclaim, reconcile-before-claimable, claim concurrency, batch execution gates, dispatch tracking, event integration and Stage Advancement. Routes/read models do not gain access to execution through this work.

### 2.2 Internal structure

These are package-internal seams, **not public workflow steps**:

| New file | Owned responsibility |
| --- | --- |
| `src/onboarding/cohort-curation/index.ts` | Load/validate claim; freeze-or-resume; require settled parent decisions; sequential member execution; final Brand/parent completion. Own ordering and failure disposition formerly spread between worker and curator. |
| `src/onboarding/cohort-curation/freeze.ts` | `captureCohortAuthorities`, OCR/type freeze wiring, final CAS, verification and existing shadow observation implementation. No new source acquisition. |
| `src/onboarding/cohort-curation/frozen-evidence.ts` | V3 projection construction, historical in-memory adapters, `buildFrozenItem`, frozen sibling/group views and the internal immutable execution-window data. No mutable catalog reads during member execution. |
| `src/onboarding/cohort-curation/decisions.ts` | One durable decision-set lifecycle shared by exactly two known kinds: inspect expected-empty/exact-set/hash/schema state → optionally reuse → coordinate under ownership → insert once → return settled member inputs. Centralize common corruption/drift classification and commit-race handling. |
| `src/onboarding/cohort-curation/titles.ts` | T-hash and title-specific authority preparation, actual multi-member target set, latest-superseded-copy policy, audited title engine invocation, title input selection for members. |
| `src/onboarding/cohort-curation/pages.ts` | P-hash and canonical Page authority bundle, all-member target set, audited group/singleton Page engine invocation, durable abstentions/expected-empty and member Page input selection. No cross-parent copy branch. |
| `src/onboarding/cohort-curation/members.ts` | Prepare a frozen per-member pipeline input, invoke the existing pipeline, enforce ordering/semantic completion and atomic materialization/dependencies, reconstruct resume outcomes. No parent coordination from a child. |
| `src/onboarding/cohort-curation/execution-lease.ts` | Existing scoped keeper, ownership error identity and timer lifetime used by freeze, decisions and members. Private implementation detail, not a new public service. |
| `src/classification/cohort-decision-authority.ts` | Pure shared prompt-input vocabulary: current title/Page truncation/normalization, source-provenance slice/accessor and Execution Product Type display authority. This is the leaf seam legitimately shared by semantic engines, hashes and the pure type resolver; it has no lease, output persistence, config loading or orchestration. |

Use explicit title and Page implementations and a closed two-kind branch in the shared lifecycle. **Do not introduce** a plugin registry, configurable strategy catalogue, callback-heavy generic `DecisionSpec`, event-sourced workflow, new service container or externally supplied “hash/parse/persist” policy. Reuse the repository's existing kind-parameterized insert machinery rather than recreating it above the repository.

Remove coordinator parameters accepted only “for symmetry” (`workspacePath`, candidate/member collections where not actually read). Load the ordinal-0 snapshot/audit binding and immutable execution window at their owner boundary; downstream decisions consume only what they use. Keep operational and semantic state distinct, rather than passing a mutable `CohortRun` plus multiple redundant reconstructions everywhere.

For each decision kind, the internal flow is **freeze authority → coordinate/reuse its durable set → materialize its member input**. The actual member-local stage still executes at the Classification Stage seam. Distinguish explicit title-member-local and Page-expected-empty outcomes from missing output; never infer expected-empty from a map that might be incomplete.

### 2.3 Classification and legacy seams

- Keep `src/onboarding/cohort-name-coordinator.ts` as the lower-level title generation/grouping/formatting engine needed by the current non-cohort path and `title-consolidation.ts`. It no longer supplies hash/lease/persistence authority to public callers. Its normalization imports point to the new pure classification leaf, not back to parent execution.
- Rename `src/classification/cohort-page-coordinator.ts` to **`src/classification/cohort-page-proposal-engine.ts`**. Its real responsibility is bounded prompt/render/response validation and current legacy cache behavior, not parent lifecycle. Preserve the existing v1 legacy prompt/cache entry and v2 parent core exactly; update `curation-target-processor.ts` to import the renamed engine. There must be no remaining classification import of onboarding title/Page hash modules or cohort orchestration.
- `src/classification/cohort-product-type-resolver.ts` imports source provenance from the pure leaf, not a title hash. Leave the type resolver, semantic validators and all seven stages independently replaceable.
- `src/onboarding/product-curator.ts` retains `composeCurationPipelineStages`, shared pipeline/result assembly and the existing non-cohort `curateItemWithPipeline` entry. Introduce a narrowly typed `curatePreparedMember` entry used only by `members.ts`: a constructed frozen item, persisted child identity, immutable runtime snapshot, effective/execution type, frozen sibling context actually used, settled **member** title/Page inputs, and ownership assertion. It must not recapture authority or accept caller-built whole-cohort output maps as proof of correctness.
- Internally, adapt those member inputs to existing `StageContext.preComputedTitle`, `coordinatedPages` and `pageCoordinationAbsent` contracts. A one-member Page map is sufficient for the unchanged materializer. Do not require a new stage API merely to rename these fields. Preserve `materializeCoordinatedPages`, the serializer, dependency order and model-call linkage safeguards.
- Keep a single pipeline execution/assembly body used by both preparation paths; do not copy a cohort-only fork of `curateItemWithPipeline`. Move frozen-item construction and parent-row selection out of this shared body. The broad `PreparedCohortContext` becomes internal/transitional and is removed from the production-facing API at completion.
- Production imports of new internals are limited to the new package. The shared product-curator and classification leaf are intentional lower-level dependencies, not reverse dependencies. Tests may directly exercise pure hash/freeze internals where the persisted protocol itself is the subject.

## 3. Replace-don't-layer verification

### 3.1 Tests that survive

Preserve these files and their distinct guarantees; migrate imports/entry calls without weakening assertions:

- `src/tests/unit/cohort-freeze.test.ts`: two-phase CAS, H1–H5, current v3 and historical adapters, OCR authority/fault injection, conflict terminal path, field-option freeze and source-purity cases. This remains the detailed freeze protocol suite, not replaced by one happy-path API test.
- `src/tests/unit/cohort-worker.test.ts`: active exclusive claiming, existing OFF/shadow behavior, startup/poll reclaim, reconcile-before-claim, member commit/dependency fault injection, frozen execution purity, semantic blocks and post-loop Brand recovery. Worker scheduling tests still invoke the worker; lifecycle tests should increasingly invoke the new public execution seam.
- `src/tests/unit/cohort-title-hash.test.ts` and `cohort-page-hash.test.ts`: exact canonical goldens, inclusion/exclusion, prompt normalization and version authority. These test durable compatibility, not thin wrappers. Point them at internal title/Page hash functions and the pure leaf as appropriate.
- `cohort-name-coordinator.test.ts`, `cohort-page-coordinator.test.ts`, `cohort-page-prompt.test.ts`: retain substantive title formatting, prompt/parser, SKU coverage, species/Page safety and legacy-cache tests. The similarly named Page test exercises the **classification core**, not the onboarding parent wrapper; do not delete it by filename analogy.
- `classification-cohort-run-repo.test.ts`, `cohort-output-repo.test.ts`, `curation-cohort-repo.test.ts`, `curation-cohort-service.test.ts`, `cohort-v6-migration.test.ts`, `cohort-v7-migration.test.ts`: durability, query/CAS, readiness and history guarantees stay separate.
- `pr6-acceptance.test.ts` through `pr13-acceptance.test.ts`: retain milestone-specific semantics, review/promotion protections and canonical-draft tests. Replace duplicate direct parent-op crash scenarios with new-interface invocations or transfer them to the new suite, with a case-level mapping. Do not preserve duplicated fixtures/assertions indefinitely merely to keep old function names tested.

Paths in the remainder of this testing section are under `src/tests/unit/` unless fully qualified.

### 3.2 New interface-level tests and explicit retirements

Create:

1. **`cohort-curation-interface.test.ts`** — public execution, freeze→both decisions→member artifact, input authority, expected-empty, singleton/mixed-group behavior and corruption/drift lifecycle.
2. **`cohort-curation-recovery.test.ts`** — real persisted output sets/audit rows with deterministic crash, time, reclaim and supersession scenarios through `executeClaim` and the production `verifyFrozen` callback.
3. **`cohort-curation-boundary.test.ts`** — local TypeScript-AST import/export checks over the scoped production modules, including static imports, re-exports and literal dynamic imports. Verify no classification dependency on cohort execution/hash internals, no legacy-cache use from active parent/member paths, no old public adapter imports and one stage-composition owner. Include synthetic positive/negative cases so a broken checker cannot silently pass.
4. **`helpers/cohort-curation-harness.ts`** — test-only disposable workspace/DB setup, deterministic fixture data, controlled clock/checkpoints and transport recorder; not an alternate implementation of cohort execution.
5. **`src/tests/fixtures/cohort-curation-authority-golden.json`** — small synthetic v1/v2/v3 authority examples with literal current H2/T/P and canonical-draft expected values. Do not regenerate expected hashes from the changed implementation during assertions.

Retire after replacement assertions pass in the same slice:

- **`cohort-lease-keeper.test.ts`**: replace private timer/`lost`/`stopped` field and method-count assertions with public in-flight execution/reclaim/cleanup behavior. Delete the file; do not rename it to another wrapper suite.
- **`cohort-title-coordinator.test.ts`**: transfer unique persisted-set, fallback/audit, exact-set, copy/race and prompt/hash correspondence cases to interface/recovery or existing pure-core/hash suites. Delete this old parent-wrapper suite after the transfer manifest accounts for each unique contract.
- **`synthesis-ordering-guard.test.ts`**: transfer the required-stage/missing-output/abstention/identity cases to the executed member-interface scenario. Delete the isolated guard suite once it is demonstrated that the guard is actually invoked before synthesis/commit.

A replacement manifest belongs in this plan's implementation evidence: old test name → surviving/new test name → boundary asserted. Test-count reduction alone is not success; neither is adding broad coverage while leaving every redundant wrapper test and adapter behind.

### 3.3 Harness and fault model

- Bun DB suites run in separate processes where their module mocks/global DB connection could interfere. Each fixture path must be beneath a newly created temp root; fail setup if it resolves to the real workspace/catalog/database. Clean only that exact temp root.
- Default-deny transport; explicitly fake LLM/OCR replies at the transport boundary. At least recovery/audit acceptance cases exercise the actual `callLlmForTaskWithProvenance` and repository writes with a fake provider transport. Do not manufacture successful model-call rows as the only proof that production auditing works. Existing audited-wrapper mocks may remain for unrelated characterization suites.
- Use deferred transport promises to pause genuine execution. Use a controlled time source visible to lease creation/reclaim and a deterministic timer scheduler; never sleep for the production TTL or inspect private keeper fields.
- Expose **test-only named checkpoints**, not a public workflow-hooks API: freeze `beforeFinalCas`, parent `afterCoordinatedCall` (kind/group identified), `beforeTitleCopyInsert`, member `afterMemberPipeline`, `afterMemberProjectionDependencyInsert`, `afterMemberCommit`, and the existing semantic/ownership race points. Reuse existing faults and error identity. Production package exports neither test controls nor arbitrary “skip validation” callbacks.
- A process-death checkpoint stops further work with the documented crash signal, leaving already committed audit/history intact and making no synthetic member/parent failure writes. An actual subprocess restart case must open the same disposable DB to prove no process cache is the durable authority. No process is killed outside the test harness.
- Thread parent checkpoints through the new **public execution invocation**. A test that directly calls `ensureCohortTitlesCoordinated`/`ensureCohortPagesCoordinated` or mocks those functions is not evidence that the new orchestration handles that crash.
- If checkpoint plumbing introduces an `await`, reassert ownership after it and before writes; do not create a test-only stale-owner loophole. Preserve current production sync transaction boundaries.

### 3.4 Acceptance matrix through the new seam

| Scenario | Required observation |
| --- | --- |
| Normal multi-member family | Claim via real repo, execute from `freezing`, actual stages run; title then Page durable sets precede first member pipeline; child proposals carry exact frozen identities/audit/dependencies; parent terminal only after semantic finalization. |
| True singleton and mixed groups | Singleton has no durable title and keeps member-local naming; every eligible SKU has a Page result; grouped member cannot fall back to per-item title generation. Freeze-time grouping and per-kind expected membership agree. |
| Expected-empty vs abstention | Disabled/no-verified-Page state writes zero rows and has explicit expected-empty member input. Policy-denied, unavailable, invalid response and safety abstentions persist complete rows. No retry Page calls; neither case invents Pages. Unexpected rows in expected-empty state supersede. |
| Title pre-commit crash | Fake transport succeeds and actual audited success is durable; checkpoint aborts before title insert. No title/Page/member projection commit. Reclaim after expiry with production verifier resumes same parent, re-invokes title once for that recovery attempt, commits; later re-entry is call-free for committed decisions. Repeat the pre-commit crash twice to avoid a false “at most two calls” guarantee. |
| Page pre-commit crash | Titles remain committed. Crash after a group or singleton Page transport but before Page-set commit leaves zero Page rows. Recovery reuses titles, retries the Page operation, then materializes members. Include a later group in a multi-group run to prove no partial Page set. |
| Crash after both sets, before member commit | Both parent kinds reused with zero new coordination on recovery. Pipeline audit/proposals may survive but CurationData + child success + dependencies must commit atomically. Canonical draft matches the reference run. |
| Crash after member commit, before Brand finalization | Committed member skipped; blocked findings/failure count reconstructed; post-loop Brand check still runs; Review gate refuses while parent is running and accepts only the final allowed state. |
| Slow live owner | Advance beyond the original lease while renewals run; second worker cannot reclaim the renewed row. Completion/failure leaves no scheduled renewal; advancing time later performs no lease writes. |
| Expired/reclaimed owner | Advance past expiry with worker A's renewal paused, reclaim via real repository under B, then release A's pending transport/checkpoint. A makes no post-loss audit terminal/output/item/child/parent write. B alone can finish. Test before initial transport, mid-title, mid-singleton-Page, before output copy/insert and before member commit. |
| Exact expiry / stale verdict | At expiry equality no reclaim; just after expiry reclaim is eligible. A changed observed owner/lease/status causes reclaim/supersede CAS to no-op. No second TTL wait. |
| Freeze drift | Mutate membership, evidence/extraction source binding, config, Page catalog or model authority before final CAS in separate cases. No mixed-time execution; old run superseded, new claim uses a new run. Conflicting types fail directly without `running` or parent decisions. |
| Post-freeze mutable state | Change live name/brand/extraction/sibling/Pages/cache/model config after the freeze checkpoint; executed inputs remain frozen, and subsequent production verification detects relevant drift rather than reinterpretation. Include distributor/manual null URLs and v3 imported-identity freeze bytes. |
| Current output integrity | Independently test missing, extra, wrong-hash, invalid JSON, empty title and assigned-empty Page rows. Parent superseded + running children terminalized, zero recoordination under old parent, every old output byte unchanged, fresh run claimable. Wrong owner cannot supersede. |
| Cross-parent title copy | Latest superseded matching T-set copied under current owner; original model-call IDs retained, old rows unchanged, zero title calls, Pages still follow their own new-parent policy. Different title parameters/provenance/hash, incomplete/corrupt latest set, foreign cohort or only an older matching set forces fresh titles. Concurrent insert preserves winner and takes documented drift path. |
| Synthesis ordering | For each required stage, remove its terminal contribution at the runner-result boundary before the real guard; no synthesis/projection commit follows and error identifies run/SKU/stage. Valid Reviewable Abstention satisfies terminality. Retain same title/source in stage projection and assembled draft. Do not bypass the pipeline entirely for this test. |
| Semantic vs structural failure | Invalid/missing parent materialization is not a usable draft. Legitimate semantic block keeps evidence/proposals/CurationData for Review with blocked status and correct parent failure summary. Stable Page IDs, not labels or sibling equality, govern correspondence. |
| Boundary rejection | Missing/foreign run, mismatched workspace/owner, and historical terminal invocation cause no unintended write/call. Missing frozen snapshot/plan never falls back to live authority. |

## 4. Sequenced implementation slices

Each slice is independently testable, has one writer, and records a scoped diff/status delta plus baseline-vs-new validation results. Stop on an unexplained hash, durable outcome or source-provenance change; do not fix the golden to match it.

### Slice 0 — Baseline and replacement ledger

**Depends on:** nothing. **Production edits:** none.

- Capture worktree/index manifests, target hashes, scoped binary diffs, installed Bun/TypeScript versions and a temp evidence directory. Snapshot both old hashes and resulting prompts/draft signatures from synthetic cases.
- Confirm all proposed files/exports/consumers against the current dirty tree, including dynamic imports and test mocks. Capture baseline targeted suite results and existing lint/type/runner failures.
- Create the golden fixture and case-transfer ledger before refactoring. Inventory current direct SQL in cohort-curator for repository relocation; do not change SQL ordering or CAS predicates in this slice.
- Document the source/ADR tensions in §7 as accepted planning boundaries or unresolved release risks, not quietly corrected history.

**Acceptance:** unrelated work byte-identical; new fixture contains literal outputs from the baseline; no real DB/network access; exact replacement coverage is enumerable. A baseline failure is recorded as a failure, not declared green.

**Rollback:** remove only newly created fixture/evidence artifacts if unneeded; preserve the original worktree.

### Slice 1 — Break the circular dependency and extract the frozen contract

**Touch:** `cohort-curator.ts`, `product-curator.ts`, `cohort-name-coordinator.ts`, both old hash files, `src/classification/cohort-page-coordinator.ts`, `src/classification/cohort-product-type-resolver.ts`, `src/db/repositories/classification-cohort-run-repo.ts`, `src/db/repositories/classification-run-repo.ts`.

**Create:** `cohort-curation/frozen-evidence.ts`, `cohort-curation/freeze.ts`, `cohort-curation/execution-lease.ts`, `src/classification/cohort-decision-authority.ts`.

- Move projection construction and frozen-item/sibling reconstruction together; temporarily forward old imports to the one moved implementation. Product-curator stops runtime-importing the large orchestrator just to construct an item.
- Move common authority/plan freeze code and the lease implementation without changing composition/version/flags. Keep all existing freeze test fault points.
- Move shared source-provenance/Execution Type/normalization definitions into the pure classification leaf. Both hashes and both prompt paths use the same definitions; no cycle through a parent coordinator.
- Replace cohort-curator inline SQL with narrow repository functions for child-side-effect existence, latest member child, prior snapshot refs/rebinding, proposal rows needed for dependency stamping, and first committed child's snapshot. Reuse existing `getCohortMemberRunForTitleAudit` where semantically identical; do not swap “latest child” for “latest refs-bearing child” accidentally. Preserve statement ordering and transaction membership.

**Tests:** surviving `cohort-freeze`, T/P hashes, runtime snapshot, type resolver, source-specific freeze tests and repository tests. Assert source-byte/history/hash equality and no live evidence overlay. Extend repository tests only for relocated query contracts.

**Acceptance:** freeze remains the only transition authority; all H2/T/P goldens match; existing OCR/source fault cases survive; no new raw SQL outside repositories. Temporary forwarders own no independent implementation and are listed for Slice 6 deletion.

**Rollback:** hand-apply only this slice's saved inverse hunks; data compatibility is unchanged.

### Slice 2 — Install the actual claim-execution seam and test it

**Touch:** `src/onboarding/job-queue.ts`, transitional `cohort-curator.ts`; existing freeze/worker tests where needed; `package.json`, `vitest.config.ts`.

**Create:** `cohort-curation/index.ts`, interface/recovery/boundary suites and test harness.

- Move the worker's freeze/process branch into `executeClaim`, using persisted run identity and expected owner. Initially it may call the single existing process implementation, but that forwarding is temporary and not final deepening acceptance.
- Worker dispatch, startup/poll reclaim and terminal reconciliation retain their current order and flags; replace only imports/calls and verifier adaptation. Keep the synchronous observed-run callback.
- Pass named test checkpoints to the existing real parent operations through the same execution invocation. Do not expose parent coordinators to the worker or test around the interface.
- Register **every new Bun suite both** in an isolated `test:db` invocation and the explicit Vitest exclude list. The boundary AST suite is Vitest-only and never imports application execution.

**Tests:** interface normal/frozen input/terminal cases; title and Page pre-commit crashes; actual audit rows; worker exclusive-claim and reclaim regressions. Include at least one real process restart over the disposable DB.

**Acceptance:** the production worker supplies no hashes/projections/maps and no longer sequences freeze and process itself. New crash tests fail when checkpoint threading is removed. No new flag, runtime mode, claim loop or fallback.

**Rollback:** restore only worker wiring/new entry changes. The prior implementations can still read all rows because no durable format changed. No runtime dual-dispatch switch is added.

### Slice 3 — Deepen titles and shared durable lifecycle

**Touch:** transitional `cohort-curator.ts`, `cohort-title-coordinator.ts`, `cohort-title-hash.ts`, `cohort-name-coordinator.ts`, interface/recovery/hash/core tests and runner entries.

**Create:** `cohort-curation/decisions.ts`, `cohort-curation/titles.ts`.

- Move title-specific hash/target-set/copy/materialization policy into `titles.ts` and make it the first user of the closed durable-set lifecycle.
- Centralize exact-set/schema/hash inspection, expected-empty validation, lease-scoped generation/insert and commit-race disposition. Use existing typed repository operations, with ownership reasserted at commit boundaries; no broad repository adapter framework.
- Keep title singleton semantics, per-group call IDs, T-hash parameters/versions, latest-only cross-parent copy and existing generation/fallback validation behavior unchanged.
- Route parent title faults through the public API. Transfer all unique `cohort-title-coordinator.test.ts` cases, then delete that file and its runner registration. Retain pure formatting/hash cases in their proper surviving suites.

**Tests:** all title rows/reuse/corruption/copy/fault matrix cases, actual audited denial/unavailability behavior, prompt normalization and canonical golden. Verify old rows untouched and stale owners unable to copy/insert.

**Acceptance:** no external caller chooses title hashes, expected SKUs or reuse policy; one title lifecycle implementation; no public thin hash/lease wrapper added. All transferred cases have a named replacement, not just similar line coverage.

**Rollback:** undo this slice's implementation/import changes only; title rows remain readable by the prior path.

### Slice 4 — Bring Pages onto the same lifecycle and clarify the classification seam

**Touch:** transitional `cohort-curator.ts`, onboarding `cohort-page-coordinator.ts`, `cohort-page-hash.ts`, `decisions.ts`, `src/classification/curation-target-processor.ts`; Page hash/core/prompt, PR7, interface and recovery tests.

**Create:** `cohort-curation/pages.ts`. **Rename:** classification `cohort-page-coordinator.ts → cohort-page-proposal-engine.ts`.

- Delete the duplicate Page lifecycle after migrating it to the shared decision-set flow. Keep all-member coverage, explicit expected-empty and durable abstention, separate Page transaction and no cross-parent reuse.
- Parent groups and singletons use the same v2 core and `cohort_page_assignment_parent` operation. Legacy callers retain the v1 prompt/cache behavior in the renamed semantic engine. Do not reimplement the prompt in the new onboarding package.
- Pair P-hash authority construction with rendered input; remove dummy symmetry-only parameters. Preserve current Page-correctness checks at core and persistence boundaries.
- Move PR7's direct-parent crash cases to public-interface invocation (or transfer and remove duplicate cases); do not delete its review/linkage/legacy invariants.

**Tests:** full Page matrix including singleton in-flight ownership loss, second-group crash, config absence vs abstention, canonical P-hash/prompt equality, Page-ID correspondence and narrow linkage exception.

**Acceptance:** title/Page common lifecycle is implemented once, while each asymmetry in §1.4 has a negative test. No classification import of onboarding hashes or cohort execution; no second parent Page coordinator survives.

**Rollback:** restore only scoped Page wiring/rename changes. Existing per-kind rows are unchanged; do not delete them to make rollback succeed.

### Slice 5 — Make prepared member execution consume settled decisions

**Touch:** `cohort-curation/index.ts`, `frozen-evidence.ts`, `titles.ts`, `pages.ts`, transitional `cohort-curator.ts`, `src/onboarding/product-curator.ts`; repository files only as required for the previously inventoried transaction operations.

**Create:** `cohort-curation/members.ts`.

- Move parent-to-member preparation, resume proof, semantic validation and dependency/commit assembly behind the module. Select title/Page member inputs once from settled parent decisions before running the child.
- Add the narrow `curatePreparedMember` input contract in product-curator; both preparation paths share its existing stage composition/execution/result assembly. Cohort input construction occurs before this seam, never by spreading live semantic state.
- Keep `assertCohortSynthesisOrdering` at the shared executed result-to-synthesis boundary; make it private once tests cover invocation through the interface. Preserve all seven checks and optional-stage behavior.
- Preserve member commit atomicity and post-loop Brand finalization, error identity, events and reviewability timing. No title/Page transport from grouped prepared members.
- Transfer the isolated synthesis guard assertions to interface tests, then delete `synthesis-ordering-guard.test.ts`. Complete lease timer/ownership replacements and delete `cohort-lease-keeper.test.ts`.

**Tests:** member/dependency transaction rollback, every resume-proof component, canonical draft retry equality, all required-stage omissions/valid abstention, frozen sources, semantic blocked-not-destroyed, post-loop Brand crash and Review/Promotion regressions. Retain `packaging-ocr-consumer-wiring.test.ts` and `classification-pipeline.test.ts` to prove one composition point.

**Acceptance:** product-curator no longer imports cohort orchestrator/projection builders, selects whole-cohort output sets, or reconstructs group size. Member pipeline remains replaceable and cannot start on partial parent authority. Parent completion cannot make a partially finalized semantic result reviewable.

**Rollback:** reverse only the narrow prepared-entry/member wiring edits. Never use deletion of audit/proposals/outputs or a live item reset as code rollback.

### Slice 6 — Remove temporary compatibility scaffolding and close evidence

**Delete after zero-import proof:**

- `src/onboarding/cohort-curator.ts`
- `src/onboarding/cohort-title-coordinator.ts`
- `src/onboarding/cohort-page-coordinator.ts`
- `src/onboarding/cohort-title-hash.ts`
- `src/onboarding/cohort-page-hash.ts`
- `src/onboarding/cohort-lease-keeper.ts`

The old classification Page path has already been renamed. Remove transitional exports/optional prepared-context compatibility parameters; move retained shadow observation callers to its compatibility export. No placeholder files or public “forward all old helpers” barrel remain.

Update surviving test imports/mock paths deliberately; do not mass-rewrite assertions. Verify the boundary suite's negative fixtures, test-runner coverage and all targeted/full offline regressions. Update only this plan's completion ledger and directly affected module comments; historical ADRs are not rewritten as if discrepancies never existed.

**Acceptance:** two core execution operations; no exported hash/lease/coordinator workflow API; no new runtime dual path; one durable output lifecycle; stage composition retained; all old unique test contracts accounted for; no unexplained data/hash/output delta; index/unrelated work preserved. Report any baseline failures and unresolved release blockers explicitly.

**Rollback:** apply the recorded slice-level inverse edits in reverse order, with human review where existing dirty hunks overlap. Stop rather than resort to Git restore/reset. Since schemas/hashes are unchanged, no DB rollback should be necessary; inability of the baseline path to read new rows is a refactor failure.

## 5. File-by-file final change inventory

New production files are exactly those in §2.2; new tests/fixture are exactly those in §3.2. Existing production files with a final change:

| File | Final change / boundary |
| --- | --- |
| `src/onboarding/job-queue.ts` | Cohort execution/verifier/observer imports and invocation only; preserve claim/reclaim/poll/advancement behavior. |
| `src/onboarding/product-curator.ts` | Narrow prepared-member entry and common stage/result assembly; remove circular imports and parent coordination selection from prepared mode. Legacy entry remains. |
| `src/onboarding/cohort-name-coordinator.ts` | Shared pure normalization import and minimal internal-call adjustments; keep title generation, formatter and existing legacy cache behavior. |
| `src/classification/cohort-page-coordinator.ts` | Rename to `cohort-page-proposal-engine.ts`; leaf authority imports and minimal type/call adjustments; no semantic rewrite. |
| `src/classification/curation-target-processor.ts` | Update renamed semantic engine import; preserve existing materializer and non-cohort target processing. |
| `src/classification/cohort-product-type-resolver.ts` | Source-provenance accessor import only. |
| `src/db/repositories/classification-cohort-run-repo.ts` | Cohort-specific child/snapshot query operations relocated from curator; preserve lifecycle CAS/order/TTL and existing Brand transaction. No migration. |
| `src/db/repositories/classification-run-repo.ts` | Narrow child side-effect/ref/proposal query operations where they belong; reuse current readers when exact semantics match. No general persistence redesign. |
| `package.json` | Add isolated new Bun suites; remove retired suite invocations. Preserve all unrelated dirty scripts. |
| `vitest.config.ts` | Explicit excludes for new Bun suites and remove stale retired-suite entries; no blanket exclusion. |
| `docs/plans/cohort-curation-deepening-plan.md` | Plan, test-transfer and slice validation ledger only. |

Read/validate but **do not change behavior**: `curation-cohort-service.ts`, `curation-cohort-repo.ts`, `classification-cohort-output-repo.ts`, shared cohort/onboarding schemas, `classification/types.ts`, `pipeline-runner.ts`, runtime snapshot/model-operation registry, all `classification/stages/*`, effective type/semantic validators, `auto-advance.ts`, `draft-promoter.ts`, review/promotion gates, flags, `llm-client.ts`, title prompts/lint/family validation and source services. If a source edit beyond the inventory is necessary, stop and obtain an allowlist expansion; do not hide it as an incidental refactor.

Surviving test files that currently import old orchestration/helpers and need scoped import/entry updates include:

- `cohort-freeze.test.ts`, `cohort-worker.test.ts`, both hash suites;
- `pr6-acceptance.test.ts` through `pr13-acceptance.test.ts`;
- `cohort-name-coordinator.test.ts`, `cohort-page-coordinator.test.ts`, `cohort-page-prompt.test.ts`;
- `curation-target-processor-cohort.test.ts`, `curation-target-processor.test.ts`, `curation-target-product-type-normalization.test.ts` (renamed Page engine mock targets);
- `e04s02-curation-provenance.test.ts` (dynamic frozen-item import);
- `sourcing-default-on-e2e.test.ts`, `distributor-scrapers-acceptance.test.ts`;
- `packaging-ocr-consumer-wiring.test.ts` if its prepared-entry dependency changes.

Repository test additions belong in existing `classification-cohort-run-repo.test.ts` / `cohort-output-repo.test.ts` as appropriate. Freeze/readiness/source/schema suites not importing moved symbols need no source edits just to be run. The Slice 0 import inventory is the definitive check for additional consumers; include literal dynamic imports and `mock.module`/`vi.mock` targets.

## 6. Validation commands and reporting

Use installed tools only (`bun@1.3.5` is the package pin); no package installation or network-enabled `bunx` fallback. These are **implementation validation commands**, not a claim that this planner ran them.

Run DB-heavy suites separately when they install global/module mocks. All test DBs/workspaces must pass the disposable-path guard before execution.

### Every slice

- `bun run test:runner-coverage`
- `bun run typecheck`
- `bun run lint` (record existing unrelated debt; additionally run `./node_modules/.bin/eslint <slice TypeScript paths>` for attribution)
- `git diff --check -- <slice allowlist>`
- `git status --porcelain=v1` and `git diff --cached --name-only` in both repositories; compare with starting manifests, do not require/force a previously dirty index to become empty.

### Durable freeze and recovery spine

- `bun test --timeout 30000 src/tests/unit/cohort-freeze.test.ts`
- `bun test --timeout 30000 src/tests/unit/cohort-worker.test.ts`
- `bun test --timeout 30000 src/tests/unit/cohort-title-hash.test.ts src/tests/unit/cohort-page-hash.test.ts`
- `bun test --timeout 30000 src/tests/unit/classification-cohort-run-repo.test.ts src/tests/unit/cohort-output-repo.test.ts src/tests/unit/curation-cohort-repo.test.ts src/tests/unit/curation-cohort-service.test.ts`
- `bun test --timeout 30000 src/tests/unit/cohort-curation-interface.test.ts` (from Slice 2)
- `bun test --timeout 30000 src/tests/unit/cohort-curation-recovery.test.ts` (from Slice 2)
- `bun run test:unit src/tests/unit/cohort-curation-boundary.test.ts` (from Slice 2)

### Semantic/protocol compatibility

- `bun run test:unit src/tests/unit/cohort-name-coordinator.test.ts src/tests/unit/cohort-page-coordinator.test.ts src/tests/unit/cohort-page-prompt.test.ts`
- Run `bun test --timeout 30000 src/tests/unit/prN-acceptance.test.ts` separately for each **N = 6, 7, 8, 9, 10, 11, 12, 13**; retain canonical artifact/linkage/review/promotion assertions.
- `bun test --timeout 30000 src/tests/unit/classification-pipeline.test.ts`
- `bun test --timeout 30000 src/tests/unit/packaging-ocr-consumer-wiring.test.ts`
- `bun test --timeout 30000 src/tests/unit/runtime-snapshot-v2.test.ts`
- `bun test --timeout 30000 src/tests/unit/sourcing-default-on-e2e.test.ts`
- `bun test --timeout 30000 src/tests/unit/distributor-scrapers-acceptance.test.ts`
- `bun test --timeout 30000 src/tests/unit/manual-evidence-title-source-db.test.ts`
- `bun test --timeout 30000 src/tests/unit/draft-promoter.test.ts`
- `bun test --timeout 30000 src/tests/unit/durable-approval-promote.test.ts`

Before final acceptance run `bun run test` with the existing required local artifacts/environment (notably the stage-rollback bridge manifest) verified. If that broad suite cannot run without missing external artifacts, report it as blocked and provide targeted results; do not generate a substitute live artifact or silently skip the gate.

For every command record exit code, selected/collected test count, skips, fixture path and captured log location outside the repo. Distinguish baseline failures from new failures. No tests were executed as part of writing this plan.

## 7. Non-goals, ADR compliance, tensions and residual risks

### Explicit non-goals

- No changes to Sourcing, Discovery, Extraction, Variant Selection Strategy, imported-identity normalization, manual evidence qualification, distributor materialization or image rights.
- No grouping-version change, new family identity model, manual membership resolution UI or partial-family Curation.
- No new Classification Stage, prompt/rule/temperature change, OCR redesign, confidence calibration, model route, fallback policy or cross-parent Page reuse.
- No Assistant instrumentation/evaluation/authority rollout under ADR 0033, automatic proposal acceptance, review bypass, promotion/export writes or catalog activation.
- No stage-vocabulary rename, client/shell/read-model redesign, SSE protocol change, job-queue scheduling rewrite or readiness-policy consolidation (candidate 6).
- No new DB schema, output kind, snapshot/hash version, historical rewrite, live repair/backfill or generalized proposal invalidation engine.
- No new rollout feature flag, plugin/agent registry, generic orchestration framework, permanent forwarding facade or alternate implementation of the pipeline. Existing OFF/shadow compatibility is preserved, not expanded or retired here.
- No unrelated test-runner, lint, type, API, ShopSite or dirty-worktree cleanup. Test registration edits are limited to new/retired/moved suites.

### Compliance statement

- **ADR 0004:** preserved. Classification remains focused replaceable stages with declared dependencies. The new module hides execution lifecycle, not semantic stages.
- **ADR 0013:** preserves durable candidate/run separation, freeze/currentness, Execution-vs-Reviewed Product Type, coordinated-variant title/Page ownership, write-once output history, per-member projection/Review/Promotion and the later PR13 title reuse economics. Explicit implementation/document tensions below prevent an unconditional claim of perfect textual alignment.
- **ADR 0016:** preserved. Readiness and worker-owned advancement stay outside the execution module; member Curation completion is not durable Review or Approval; no partial family or automatic export.
- **ADR 0033:** it is **Proposed**, not authorization to implement its Assistant milestones. Respect its frozen, bounded, audited, propose-only and no-new-orchestrator constraints. This is a replacement of current execution plumbing, not a new Assistant/runtime, correction instrumentation, authority-gate rollout or title policy change.

### Tensions to flag, not silently adjudicate

1. **Missing v2 configuration snapshot:** ADR 0013's early freeze amendment says fail closed when no persisted config-snapshot row exists. Current `captureCohortAuthorities` upserts it; `cohort-freeze.test.ts` explicitly asserts automatic persistence. Preserve that characterized behavior for a structural move; do not relabel it strict read-only validation or silently restore the earlier behavior. `verifyFrozen` calls capture and therefore can cause config/cache persistence; keep it restricted to current worker/reclaim use, never advertise it as a pure GET-safe API. Resolving this authority/repair boundary is separately approved work.
2. **Corrupt shared outputs:** ADR PR8 R1 text describes per-member failures using usable rows. Current processCohort and PR8 review-R2 acceptance instead supersede the parent to avoid permanently stranded write-once corruption. Preserve the tested **parent supersession** contract; a documentation amendment, if requested, must be explicit rather than rewriting history in this refactor.
3. **Legacy/shadow paths vs single-path goal:** ADR 0033 rejects maintained dual orchestration for its future Assistant rollout; the current code still has OFF/shadow paths, and active cohort defaults are now ON despite earlier ADR “default OFF” milestone language. Do not add a third mode or a new deepening flag, and do not claim this refactor retires existing legacy functionality. Retirement needs its own compatibility/activation decision. Rollback here is reviewed code rollback or stopping execution, not adding another legacy dispatch branch.
4. **Provisional type proposals:** the older classification recovery plan prohibits pending types unlocking type-gated proposals. Accepted later ADR 0013 PR5/PR7 explicitly permits frozen Execution Product Type to drive active-cohort proposals with reviewed authority retained for publication. Preserve that later scoped behavior; never broaden it to legacy mode, reviewed applicability conditions or Promotion.
5. **Later title validation drift:** `lintAndValidateFallbackTitles` currently logs and returns individually formatted titles when fallback family validation fails, although nearby comments describe throw/zero-write behavior; member commit records a passed family-title marker for stored coordinated/fallback titles. The title hash also excludes some evidence read by current validation helpers. These are pre-existing safety/authority risks, not permission to change fallback or hash composition during relocation. Characterize and report them; if a required fail-closed acceptance test exposes one, block release of that affected slice pending separately approved remediation rather than weaken the assertion or falsely certify the marker.
6. **Grouping equivalence:** current parent engines recompute product-family-v1 subgroups from frozen views. Their comments explicitly limit equivalence to unchanged grouping rules/inputs; `authoritativeCohortId` exists for a future divergent-membership caller. Do not opportunistically switch grouping, change singleton membership or introduce manual family edits. Record this dependency and its mixed-group fixture.

### Residual risks and stop conditions

- Hash-preserving refactors can still alter prompt order, null handling, source provenance, failure disposition or audit ownership. Literal golden bytes plus public-interface tests are mandatory, not optional polish.
- Runtime snapshot/projection adapters and comments have v1/v2/v3 drift and some type suppressions. Relocation must not become an unreviewed historical-normalization or evidence-enrichment change.
- SQL query tie ordering, child reuse and synchronous transaction windows are easy to change accidentally. Preserve existing predicates/order unless a separately identified correctness fix is approved.
- Timer/transport tests cannot prove provider cancellation or distributed exactly-once delivery. The promised boundary is owner-fenced durable effects and post-commit replay safety.
- Model-quality, new fallback economics and production latency are not evaluated by mocked offline tests. No live canary or activation is authorized here.
- Existing broad test-runner/baseline debt may hide uncollected suites. A zero-test selection, exclusion or absent bridge artifact is not a pass.
- Dirty concurrent work is the largest operational risk. If a target hash changes unexpectedly between slices, pause and reconcile with its owner; never overwrite it.

**Final acceptance requires** the smaller public seam, removal of transitional adapters/duplicate lifecycle code and wrapper tests, unchanged durable/prompt/hash contracts, preserved Classification Stage and worker boundaries, complete interface-level crash/reclaim/drift evidence, and an explicit list of unresolved pre-existing risks. A module move with a larger public options bag is not completion.
