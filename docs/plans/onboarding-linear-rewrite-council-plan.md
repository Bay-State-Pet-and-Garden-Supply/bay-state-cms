# Bay State CMS — council-conformant onboarding linear rewrite, v1

**Status: implementation-ready design, conditional on the approvals at the end. PLAN ONLY: no application edits, migrations, DB writes, network calls, or ShopSite sync changes are authorized by this artifact.**

**Review revision:** incorporates `/tmp/review-correctness.md` (OK-with-notes) and `/tmp/review-tests.md` (BLOCK). The P0 acceptance gates and P1/P2 clarifications below are mandatory; editing this plan does not claim the future tests or independent re-review have passed. **Additional binding owner direction:** official product URLs are the main extraction flow; supplier/distributor evidence is a secondary strategy/qualified fast path, not the primary UX narrative. Prepare listing remains one stage and one internally sectioned view, not five new stages or another workspace.

The council memo is binding. This plan replaces conflicting instructions in the existing draft `docs/plans/onboarding-frontend-rewrite-plan.md` and draft ADR 0034; it does not silently adopt their decisions. The existing dirty files are preserved. A later sequential writer must reconcile those drafts in Slice 0 before implementing this plan.

## 1. Authority, findings, and safety envelope

### Governing evidence

- `CONTEXT.md`, Onboarding Pipeline: the main Stage Advancement definition already describes automation-owned sweeps correctly. The remaining contradictory bullet is approximately line 782. Stage names and statuses are separate concepts.
- `docs/plans/classification-system-implementation-plan.md`: preserve dirty worktrees, one sequential writer, no broad staging, immutable provenance, verified SQLite backups, no network/paid/model work, no unauthorized catalog changes.
- ADR 0016: retained behavioral authority; **only its work-state-first navigation and unchanged-stage-vocabulary decisions are superseded**. ADR 0007 remains the item-centric execution foundation, not authority for manual-only advancement. ADR 0017 retains brand/source authority. ADRs 0013 and 0014 with amendments retain cohort and distributor guarantees.
- Direct source checks: `STAGE_ORDER` in `src/db/repositories/onboarding-item-repo.ts:84`; `PipelineStageEnum` in `src/shared/schemas/onboarding.ts` (currently around 203; memo line numbers have drifted); `SOURCING_COMPLETION_TARGETS`, stage distribution, reset/claim/advance paths; work-state schemas/services/routes; BatchWorkspace and helpers; preflight, brand blockers, worker/sweeps, SSE, telemetry, migrations and backup verifier.
- Existing `/tmp/*.md` were inventoried. There is **no relevant onboarding-rewrite scout handoff** in the available files. `/tmp/audit-102.md` concerns manual-evidence/source-type compatibility; it reinforces preserving those paths but is not a rewrite audit. This plan uses direct reads, not a claimed scout consensus.

### Important findings that change implementation choices

1. Draft ADR 0034 currently proposes a new competing `onboarding-v2/` shell, a durable execution tail/heartbeat, backup-only rollback, a prematurely final vocabulary, and excessive CONTEXT edits. Those portions are superseded, not implementation authority.
2. UI flags `shellV2Enabled`, `brandGateV2Enabled`, and `executionStripV2Enabled` already exist, default OFF. Reuse them. The dirty server flags for execution-tail writes and optional tolerant stage reading are scaffolding, not approval to create a tail or make compatibility optional.
3. Existing work-state counts calculate category totals before some filters while `total` reflects matching items. Existing bounded item reads scan one 50-row chunk. No stage/status filters are accepted by the existing read handlers. Do not client-filter a fetched page or use its length as a batch count.
4. Existing `Onboarding.tsx` still mounts PipelineBoard implicitly when BatchWorkspace is disabled. This violates the desired diagnostics-only sequence even though BatchWorkspace is default ON.
5. Existing SSE is process-local and ephemeral. Its `welcome` and 15-second `ping` indicate transport connectivity, not worker liveness. Opening the legacy event endpoint also obtains a worker; do not add that side effect to new polling/read endpoints.
6. `getBrandDomainBlockers` catches errors and returns `[]`. Empty output alone cannot prove healthy mappings. Preflight distinguishes readiness from missing-domain/routing advice: assigned-brand items may be released without an official domain.
7. `src/db/stage-pipeline-migration.sql` adds stage columns with legacy defaults and maps old flat statuses. In `migrations.ts`, some operator-review backfills run before the stage-column migration. Old-schema upgrade ordering needs explicit proof, not only a test on a current schema.
8. Frozen work routes contain live stage guards (`review` around line 445) and an emitted `promotion` value around line 511. **Supervisor-approved D4 interpretation:** allow only inventoried rename-boundary/mechanical substitutions in otherwise frozen files during the rename slice. Preserve URLs, auth, decisions, receipts, v1 response behavior, and request/receipt bytes. New stage/status reads belong in a separate v2 route module; existing work-state read handlers are not expanded.
9. The owner clarified that official product URLs are the main extraction strategy and supplier/distributor records are secondary. The existing default-on engine may still perform distributor lookup for an item. **Do not conflate the UX strategy hierarchy with observed worker scheduling:** present source triage neutrally, report actual work honestly, and preserve all existing routing/entry/qualification/claim semantics in this rewrite. Any requested runtime scheduling/strategy-priority change would require a separate approved behavior change.
10. Existing WorkActivity refinement exposes only one active curation activity at a time; it cannot establish that OCR, grouping, names, product type and fields are all complete. Slice 2 adds explicit read-only section summaries from validated canonical run/evidence/cohort data, never five fictitious progress ticks inferred from that single activity.

### Non-negotiable invariants

- Exactly six execution stages, with a bijective vocabulary change. `pending`, `in_progress`, `completed`, `failed`, `needs_input`, `skipped` remain byte-identical. Same order, exit contracts, skips, retries, claims, holds, authorization and automation behavior.
- Step 0 is a **view**, never a stage, durable gate flag, new batch barrier, or universal official-domain requirement.
- The linear UI presents official URL discovery/verification → collection as the main path. Stage 1 is neutral source triage/routing, **not “everyone checks suppliers first.”** Supplier/distributor evidence remains a secondary extraction strategy and the qualified alternate path remains fully supported. This is a naming/presentation contract, not an unapproved change to engine scheduling or defaults.
- `distributor_record_to_extraction` remains the qualified Discovery bypass. Source URL remains null; materialization stays profile-/fetch-/OCR-/model-free. No Sourcing-to-Curation path. Policy-v0 rows remain unclaimable; observe/manual/automatic behavior is unchanged.
- Work-state projection remains server-owned. Stage navigation does not replace durable review, invalidation, approval, export state, or release verification. A `completed` **stage status** does not imply a `completed` **work-state category**.
- Review completion, approval, creating export drafts, and actual release/export remain separate existing decisions. No auto-approval, no new export action, no ShopSite publishing/sync changes.
- All receipts, immutable evidence, sourcing route identifiers, source identity, snapshots, historical event/audit records, request hashes, and recorded JSON bytes remain unchanged by the rename. Translation occurs only at version-aware interpretation/serialization boundaries.
- No new raw SQL outside repositories. Existing direct-SQL sites are inventoried; any new query belongs in a repository. Never broaden permissions or infer authorization from UI flags.
- Unknown/malformed stage/version/filter data must not be coerced to the first stage, silently ignored, counted as success, or used to authorize an action.

### Worktree and operational boundaries

- Capture outer/nested HEADs, index paths, status including untracked files, scoped binary diffs, and target-file hashes before each writer. Store evidence outside the repo; do not copy secrets into reports.
- Preserve pre-existing dirt byte-for-byte outside the agreed allowlist. Never reset, clean, stash, restore, revert, or broadly stage. **No staging or commits in this work**; the classification plan's exact `storage/catalog/store/classification/**` commit exception is not exercised here.
- One sequential writer across all slices. Stop and seek review for unclassified stage references or allowlist expansion.
- No live DB connection/import that triggers migrations during planning. Future tests use explicitly isolated temporary DBs/workspaces and mocked/injected network/model/browser services. Do not run dev/start/live-smoke against the operator DB.
- Migration execution is a separately approved operational action, outside this planning tranche. Backup verification and quiescence are prerequisites, never implied approval.

## 2. Proposed final vocabulary — owner must approve

Recommended plain-language candidate, deliberately avoiding “Review & approve” and any “publish” promise:

| Order | v1 stored/wire value | Proposed v2 runtime/stored value | Primary label | Unchanged meaning |
|---|---|---|---|---|
| 1 | `sourcing` | `route_sources` | Check source options | Existing source qualification/conflict/routing work, framed as automatic triage; official URL is the main flow, qualified distributor record an alternate fast path |
| 2 | `discovery` | `find_product_page` | Find product page | Official-source authority and product/variant URL discovery |
| 3 | `extraction` | `collect_details` | Collect details | Official-page extraction **or** null-URL distributor materialization |
| 4 | `curation` | `prepare_listing` | Prepare listing | Existing cohort-aware cleanup/classification |
| 5 | `review` | `review_listings` | Review listings | Human review; approval remains an explicit separate action |
| 6 | `promotion` | `create_drafts` | Create drafts | Existing CMS draft/release area; never a claim of publishing |

**Adjusted stage-1 recommendation for owner sign-off:** `sourcing → route_sources`, label **Check source options**. This replaces the earlier supplier-centric candidate. It communicates routing/triage without promising that every item visits a supplier or requires a human choice. Suggested short guidance: “Use the official product page as the main source. A qualified supplier record can provide an alternate path.” Automation still chooses the existing permitted route; only projected exceptions request a decision. No new source-policy switch is implied.

Show the main diagram as source triage → official product page → collect details → prepare listing → review → create drafts. The source-triage→collect-details connector for a qualified distributor record is a **secondary alternate-path annotation**, not the headline or a compulsory first task. A known official-page item keeps its recorded stage/source identity; neither stage 1 completion nor supplier qualification is invented from the diagram. The source-type badge/actual activity must still disclose when the worker really is checking a distributor or using its record.

Step 0 label: **Brand setup**. Suggested URL view identifier `brand-setup`; it is excluded from every stage enum/order/count matrix.

The map is one-to-one in both directions and order is explicit, never alphabetical. No vocabulary is approved merely because it appears in the old draft. Approval must include machine strings and labels together. Domain/file names such as `product-curator`, work activities such as `curation`, source types, review states, and immutable route IDs are not automatically stage identifiers.

## 3. One shell, preserved operations

### Freeze boundary

Keep the following implementations, styling contracts, mutation behavior and hooks intact; rehouse by composition, not rewrite or move directories:

- `src/client/components/onboarding/review/ReviewWorkspace.tsx` and all `review/*`, including `use-review-queue.ts`, `use-review-detail-cache.ts`, queue/inspector, Looks Good & Next, cursor pages, maximum-five-item LRU behavior, decision draining, 409 handling, readiness/confirmation.
- `attention/AttentionQueueView.tsx`, `attention/OfficialSiteResolutionWorkspace.tsx`, every brand/domain/URL/profile/variant/manual-evidence/source-conflict/semantic-conflict panel and `attention-logic.ts`.
- `processing/ProcessingView.tsx` and its processing components/helpers; `families/FamilyWaitingView.tsx`, family cards/inspector/helpers.
- `approved/ApprovedView.tsx`, `approved/ReadyToExportView.tsx`, `approved/ExportActions.tsx`, their queue/helpers.
- `src/server/routes/onboarding-work-routes.ts`: all existing read/mutation URLs, handler semantics, authorization, receipt behavior, and review-queue contract.

**Only exception:** the approved, inventoried stage-vocabulary substitutions needed for D1, plus explicit v1 stage encoding at an existing boundary when necessary. No generic refactor, styling, filter, cursor, caching, decision, export, or health changes inside frozen implementations. Tests must demonstrate unchanged non-stage behavior and exact legacy request/receipt serialization. Most frozen UI files have no actual stage literals and should remain byte-identical.

### Shell behavior

- Evolve `BatchWorkspace.tsx` in place. Its header, batch identity, attention resolution and operational views survive. New small components live beneath `components/onboarding/`, not a second application/shell tree.
- Six stage tabs are primary navigation. Each displays the item's **current** stage count, not a fabricated cumulative completion funnel. Stage 1 is **Check source options**, not a supplier-first instruction. The official product URL path is the main visual flow; the qualified distributor skip is a secondary fast-path annotation and may never visit stage 2. No skipped/unvisited stage is labeled completed merely to fill the strip.
- Prepare listing uses one stage-scoped view with five named internal sections: Packaging OCR evidence, Family/cohort grouping & readiness, Name curation, Product type assignment, and Field classification. They explain inputs, shared readiness and outputs without becoming new stages, independent queues or a second review workspace; exact states/scope are specified in Slice 2.
- Work categories, stage statuses, and review states are independent secondary facets. Present them explicitly, with stage-scoped server results and matching counts. Do not reverse-engineer categories from stage/error strings.
- Preserve all existing full-batch operational surfaces as secondary destinations inside this one shell. Their existing props often accept only `batchId`; label them **“entire batch”**, clear/hide stage-scoped filters while open, and return to the prior stage on close. Do not pretend an unchanged child is stage-filtered or silently drop sibling context to fit a stage tab.
- On Review listings, the default stage list is Unreviewed; Reviewed is a distinct server-filtered list; Not ready/blocked is separately labeled, never included in an “awaiting review” count. An explicit **Open full-batch Review workspace** action opens the frozen queue with its existing independent filters. This is not a replacement review queue or a silent carry-over of shell filters into it.
- Approved, Ready to Export, Completed, and Skipped remain distinct outcomes accessible from secondary outcome selectors/results. Skipped has no Approved destination. Completed has no Ready-to-Export badge membership. Never create export buttons for either based on presentation alone.
- Legacy `?tab=...` links resolve to their corresponding secondary operation/outcome view, not to an inferred stage. Versioned stage URLs have an explicit vocabulary version; unknown versions render an actionable unsupported-link state without mutation.
- PipelineBoard sequence is strict: BatchWorkspace default already → explicit `?board=pipeline` plus diagnostics flag only → remove all mounts/imports → remove file after a verified unreachable interval. No implicit fallback to PipelineBoard.

## 4. Read, pagination, versioning and freshness contracts

### 4.1 Dedicated v2 stage read routes

New module `src/server/routes/onboarding-stage-read-routes.ts`, mounted from `src/server/app.ts`:

- `GET /api/onboarding/v2/batches/:id/stage-work-state/counts`
- `GET /api/onboarding/v2/batches/:id/stage-work-state/items`

Reuse the canonical projection and bulk context loaders. Do not create a parallel work-state classifier. Do not modify the existing `onboarding-work-routes.ts` read handlers to accept new filters.

New shared schema `src/shared/schemas/onboarding-stage-read.ts` defines:

- Strict filters: `stage`, `stageStatus`, existing category/reviewState/sourceType/domain/cohortId/q facets; cursor and bounded limit on items only. **Intentional version divergence:** v2 accepts integer limits 1–100, default 50; frozen v1 continues accepting 1–500, default 100. The v2 client sends 50 explicitly and follows cursors; a request for 100 is a maximum, not a promise to fill it from a single bounded chunk. Invalid, duplicate/conflicting or unknown query fields return 400; no broadening to “all.” A vocabulary-v1 value is accepted only in an explicitly v1 representation, not silently in v2 input.
- Counts response: `schemaVersion: 2`, `stageVocabularyVersion: 2`, batchId, normalized filter fingerprint, `matchingTotal`, work-state category counts, **all 36 stage×status cells**, and existing `projectionHealth` including `computedAt`.
- Items response: same version/fingerprint/health fields, bounded projected rows, `nextCursor`, and instrumentation consistent with current bounded-query tests. Do not embed expensive batch summaries in every page. Slice 2 adds an explicitly typed, bounded `preparationSections` summary to **v2 stage-read rows only** for Prepare listing: five fixed section keys, canonical states/IDs/reasons/counts, no raw evidence/proposal arrays. This uses the same bulk projection/read transaction and total-SQL budget; it does not extend frozen v1 work-state responses.
- Each summary applies exactly the same predicates as its matching item query, before cursor/limit. Sum of the 36 cells and sum of category counts each equals `matchingTotal`; no record is counted twice. Global tab badges use an explicitly separate unfiltered counts request. Stage-filtered summaries are not displayed as batch totals.
- Cursor uses `(row_number,id)` stable ordering. Add **`computeStageReadFilterHashV2`**, not a call to/reuse of the unchanged v1 `computeWorkStateFilterHash`. Hash an explicit canonical envelope containing `workspaceId`, `batchId`, `endpoint: stage-work-state`, `cursorVersion: 3`, `stageVocabularyVersion: 2`, and normalized `stage`, `stageStatus`, `category`, `reviewState`, `sourceType`, `domain`, `cohortId`, `q` (absent fields encoded consistently as null). This **extends** the v1 facet set with stage/status/scope/version fields; cursor version 3 avoids confusion with the existing v1 API's DB cursor `v:2`. Page limit and row position are not filter fields, so the same filtered traversal can change page size safely. The v2 cursor envelope also contains those explicit scope/version fields and the fingerprint; only row position is mutable pagination data. Keep v1 hashes/cursors byte-identical. Wrong/legacy vocabulary, endpoint or cursor version returns HTTP 400 `invalid_version`; valid-version wrong batch/workspace/filter fingerprint returns 400 `filter_mismatch`; malformed/tampered structure or hash returns 400 `malformed_cursor`. Scope authorization still runs first. An empty page with non-null cursor means continue, not “no matching items.”
- **Predicate split, shared by both v2 endpoints:** workspace/batch ownership plus batch ID, `stage` and `stageStatus` belong in the repository SQL `WHERE`, with bound parameters and explicit stored-vocabulary aliases. `category`, `reviewState`, `sourceType`, `domain`, `cohortId`, `q` remain **post-projection** predicates applied to each bounded chunk. Do not opportunistically push sourceType/domain/q into SQL with different normalization; no client-side replacement for these filters.
- **Items budget:** exactly one query for at most 50 candidate item rows (or fewer for a smaller requested limit), **no lookahead row/query and no second chunk**. Cursor points to the last candidate actually consumed; a full chunk returns a continuation even if its projected matches are empty. Exhaustion is detected by a short/empty subsequent chunk, so one final empty page is valid. No eager client chase-to-fill loop. `scannedRows` means primary candidate rows examined, not unrelated contextual sibling rows. SQL filtering must not turn missing sibling context into family readiness; context loaders retain complete relevant family facts.
- **Counts algorithm:** traverse the same authorized, stage/status-selected candidates once, in chunks of at most 50, with the identical post-projection predicate function. Increment the matching total, category bucket and one of the 36 matrix cells during that **single traversal**. Never issue 36 full scans or load every item detail at once. End with a bounded empty/short chunk; no count cache or approximate count becomes authority.
- **Explicit SQL budget:** at most 24 executed SQL statements per authorized items request: fixed overhead at most 6 (scope checks, transaction boundaries and storage-version read included) plus at most 18 for one candidate chunk and all its context/hydration. Counts budget is `6 + 18 × C`, where `C = floor(M / 50) + 1` and `M` is the fixture oracle's SQL-stage/status-selected candidate count; the terminal empty chunk is included. Within each chunk, reuse the existing bulk-query counters and require at most 5 classification/variant/candidate bulk queries (at most 50 distinct active run IDs); additionally instrument **all executed DB statements** so hydration acceptance lookups, review state, batch/cohort/member/extraction queries and transaction overhead cannot disappear from the measurement. No per-item or per-cohort statement fan-out. Queries returning cohort context may return more than 50 related rows; do not claim the primary-candidate bound limits every related row.
- Existing v1 loaders/counters are not proof of this budget: `mapRowToItem` acceptance hydration and `buildCohortContext` cohort loops must be observed too. Add v2-only bulk access seams in the listed repositories, consuming the same pure semantic evaluators, if existing access patterns exceed the bound. Do not relax a bound, omit a counter, change family semantics or alter frozen v1 reads to obtain green tests; an inability to meet the bound is a review blocker.
- Each response is internally consistent using a repository-managed read transaction. Separate counts/items requests are not a persisted snapshot: timestamps/fingerprints expose freshness and the client re-syncs after changes. Do not claim simultaneous consistency across separate HTTP requests.
- Cross-workspace batch is 404 before querying/stream subscription. Category-critical projection failure is 503 with degraded health; unknown/corrupt stage is a projection failure, not a manufactured needs-attention action eligible for retry. Do not render failed counts as zero.

No schema/data migration is needed for these read additions. Characterize existing indexes/query plans first. If a new index proves necessary, specify it in the deferred migration design and obtain the migration gate; do not apply it during early UI slices.

### 4.2 Version-aware transport and legacy artifacts

Create `src/shared/onboarding-stage-vocabulary.ts` as the pure canonical vocabulary/alias authority. The client must not import DB repositories to obtain stage order. `onboarding-item-repo.ts` can re-export its shared order for existing imports, but must not own a second array.

- Explicit namespaces: legacy stage v1, canonical stage v2, **unchanged** StageStatus, WorkActivity, WorkStateCategory and ReviewState.
- New v2 stage reads use the approved new values even while storage is v1; this is a compatibility rollout, **not the completed rename**. Native runtime enum/writers and persisted backfill are mandatory release gates later.
- Existing work-state read URLs and review queue remain v1 contracts. Their exported service boundary encodes canonical stage back to the v1 field; frozen clients keep receiving what they understand. This does not make v1 the runtime authority.
- Existing general onboarding stage-bearing routes get explicit boundary serializers/parsers in `src/server/onboarding-stage-api.ts`; default/unversioned means legacy v1. Add opt-in `stageVocabularyVersion=2` to inventoried general stage-bearing reads/mutations and the existing SSE endpoint where needed. The new shell's stage reads use the dedicated v2 paths; unchanged review/attention actions need not opt in.
- Validate the requested version before any action. A v2 request cannot contain v1 stage strings, and vice versa. Reject mixed/unknown representations. Serialize nested live stage fields, stage-keyed distributions, reset/advance responses and rejection messages consistently; do not recursively replace arbitrary strings in receipt JSON or evidence.
- SSE version is selected at connection creation by URL parameter (EventSource cannot rely on arbitrary headers). Named event types stay unchanged. v1 keeps its current envelope/bytes behavior; v2 uses an explicitly versioned, sanitized bounded envelope. Internal events may normalize to canonical stages; serialize per subscriber. Missing stage on an existing event stays absent, not invented.
- Cached v1 clients and the tested rollback UI continue using v1 routes after storage becomes v2. Unknown v2 capability/version prevents enabling the linear shell; it must not fall back to a client-filtered first page.
- Immutable formats keep their own existing versions. `SourcingDecisionV2Schema` retains the v2 recorded target vocabulary; validate under that version, then map only the interpreted target into canonical runtime stage. Route IDs such as `distributor_record_to_extraction` are stable IDs. **Do not rewrite their names.**
- Keep writing existing immutable decision/receipt formats through explicit serializers during v1 of this rewrite. Introducing a new sourcing-decision/snapshot format is unnecessary and would complicate rollback. The domain/runtime machine rename is still complete: old stage words survive only in named versioned wire/immutable-format adapters and original fixtures, not execution decisions.
- Hash/replay validation runs against original stored bytes and original format interpretation. Do not decode→rename→rehash as though it were the original artifact. Malformed newer artifacts never downgrade to a permissive legacy schema. Historic prohibited routes remain readable and unactionable.

### 4.3 Ephemeral execution strip

Two independent halves:

1. **Server-derived status:** current batch `executionState` from existing batch/preflight read plus the v2 server count matrix. Batch running/paused is execution permission/state, **not worker health**. No worker alive badge, concurrency claim, last-worker-poll or oldest-claim SLA is added in this v1.
2. **Ephemeral live activity:** display-only SSE events received while this view is open; never a source for status/counts/approval/export eligibility.

Required lifecycle:

All proposed timing/buffer budgets live in one injectable `ExecutionStripBudgets` value in `execution-strip-logic.ts` (refreshIntervalMs, staleAfterMs, debounceMs, maxDebounceWaitMs, maxEntries, maxSummaryChars, maxFrameBytes). Defaults remain the owner-proposed values below until approved; tests derive boundary cases from that object and run a second small-budget configuration, rather than duplicating magic numbers. Budget injection is a test/configuration seam, not an API permission, persistence or runtime feature-flag change.

- Initial count/batch refresh; refresh on every connection `open` including reconnect; coalesced event refresh (existing 400ms debounce, with a maximum 2-second wait so continuous events cannot starve it); periodic re-sync proposed every 15 seconds while visible; immediate refresh on visibility/focus/online return.
- Connection states `connecting`, `connected`, `reconnecting`, `closed` are distinct from projection freshness. A connected stream does not mean the projection is current or worker running.
- Keep server `projectionHealth.computedAt` and separately label client **last successful fetch**. Proposed stale threshold: 45 seconds, or immediately degraded on fetch/projection error. Use elapsed client time for staleness; server clock skew/invalid timestamps cannot produce fake fresh data. No successful fetch means “not loaded,” never “0.”
- Retain last successful counts with a conspicuous stale/error badge; do not overwrite them with zero. Guard batch/filter request generations, cancel/discard stale responses, prevent overlap and clear timers/subscriptions on unmount/batch switch. Periodic refresh does not reset a review operation or churn its cache.
- Event buffer proposed maximum 100 summaries, maximum 160 display characters each; maximum accepted wire frame 16 KiB. Keep only allowlisted type/stage/status/item ID and vetted reason codes. Build fixed text templates; never retain/render raw error strings, full product evidence, URLs with credentials/query strings, tokens, HTML, model prompts, cookies, or console logs. Unknown/malformed/oversized frames are dropped or summarized generically and can trigger a safe refetch.
- Label timestamps **“Received at …”**, not execution time. `welcome`/`ping` are connection frames and not worker activity. No occurrence time, event ordering, completeness or exactly-once promise unless explicitly provided by the event contract.
- Visible disclosure: **“Live activity only. Activity during disconnection or before this view opened is unavailable; counts are refreshed from the server.”** Show a gap marker after reconnect. No durable event table, replay endpoint, Last-Event-ID backfill, localStorage/sessionStorage history, worker heartbeat, `/health` change or `/runs` project.
- Existing start/pause/resume controls may be rehoused unchanged; refetch after action success/failure. Never synthesize a batch state from a successful button click.

## 5. Compat-preserving DB migration design — NOT EXECUTED

### 5.1 Inventory and representation policy

The mutable operational column is `onboarding_items.stage`. Stage distributions are derived, not new persisted authorities. Before implementation, the inventory must identify every other operational persisted stage-bearing column/JSON field, constraint, default, trigger, index and caller; Appendix A supplies the verified seed list and classification rules. An unclassified match blocks activation.

Keep `stage_status`, flat legacy `status`, held state/reason, claimed_by/claimed_at, retry/error fields, batch execution state, sourcing policy/generations, review state and all immutable history untouched by the stage backfill. Keep all IDs, row numbers, created_at and updated_at unchanged. A spelling-only backfill must not look like a semantic edit or trigger review invalidation, new cohort snapshots, new classifications or observer events.

New design files, to be implemented only in the later migration slice:

- `src/db/onboarding-stage-vocabulary-migration.sql`: stage-only backfill and explicit predicates; no history-wide replace.
- `src/db/repositories/onboarding-stage-vocabulary-repo.ts`: read/validate storage version, inventory/audit checks, transactional migration seam and counts/digests; all new SQL here or the migration SQL file.
- `src/db/migrations.ts`: `app_meta` integration and precondition/order validation, **not an unconditional live startup backfill**.
- `scripts/onboarding-stage-vocabulary.ts`: explicitly scoped offline maintenance entry, dry-run by default; apply requires an explicit mode, source path, verified backup manifest, expected source identity and exclusive-maintenance proof. It must not import server startup or silently invoke unrelated migration/repair paths.
- `docs/runbooks/onboarding-linear-rewrite-rollout.md`: deployment, compatibility artifacts, quiescence, audit and rollback procedure.

Use a distinct `app_meta` key, proposed `onboarding_stage_vocabulary_version`, absent/`1` = v1 storage and `2` = v2 storage. Keep historical stage-pipeline/operator-state markers intact. The migration receipt records mapping version/digest, old/new storage version, per-stage×status counts, source/backup identity, binary identity, timestamps and invariant verification results. Do not reuse approval/export receipts for maintenance.

### 5.2 Bridge release and dual reads

First deliver a **rollback-capable bridge build**, before native enum cutover:

- It understands both sets of stored literals and normalizes at every repository/raw-row boundary. SQL claim/advance/reset/count/barrier predicates match the semantic stage under either spelling; updating a selected row uses the DB storage version's write encoding.
- While metadata is v1/absent it writes v1; after the separately approved backfill sets v2 it writes v2. **No process/startup/singleton cache of the storage version is permitted.** `onboarding-stage-vocabulary-repo.ts` reads `app_meta.onboarding_stage_vocabulary_version` from the same connection **inside each write transaction**, before encoding any stage; all statements of that transaction share that observed version. Wrap otherwise standalone writes in the same repository transaction, rather than reading metadata outside the statement's locking boundary. Read-only requests observe metadata inside their own read transaction. The migration holds the exclusive writer gate while atomically flipping rows and version. Test one already-running process/connection writing in v1, another connection committing the sanctioned flip while the first is idle, then the original process writing in v2; neither a restarted process nor a cleared module cache can carry that proof. Also test an attempted concurrent flip cannot interleave within a write transaction. No runtime toggle can silently switch only some writers. Read compatibility remains available in the bridge and historical adapters permanently.
- Native v2 build changes `PipelineStageEnum`, STAGE_ORDER consumers, worker dispatch, transition targets and all live stage guards to the new canonical runtime enum. Reads accept valid legacy rows only through the storage adapter. No cast-only or empty-stage fallback to Sourcing is allowed.
- Both builds have identical v1 transport and existing immutable-format serializers. Bridge and new binaries refuse unknown storage versions/invalid stage data before enabling writes/claims.
- Resolve the existing `ONBOARDING_STAGE_RENAME_TOLERANT` scaffolding: compatibility is not optional once a DB can contain v2 values. Remove/retire the unused toggle or make unsupported combinations fail startup; never expose an OFF combination that strands rows. `VITE_*` cannot choose storage behavior.
- Keep a content-hashed bridge server/test harness and matching client bundle outside the dirty source tree; record compiler/runtime versions and all external inputs. A source checkout/backup alone is not the tested rollback artifact.

### 5.3 Legacy defaults, old upgrades, and constraints

- Preserve the original `stage-pipeline-migration.sql:6–30` as an old-status→v1 upgrade step. Do not edit historical migration literals to v2, which would change their meaning/order.
- A fresh or status-only DB first converges through the existing schema chain to the complete v1 schema; the rename then runs as a final, separately gated step. Explicitly verify operator-review/approval backfill prerequisites completed, including the deferred marker-1→2 hop, **before** changing stage values. If a prerequisite is incomplete, stop and report it; do not manufacture durable review as part of the rename.
- Current historical stage-column default is `discovery`. Avoid a high-risk table rebuild solely to change that default. Keep it explicitly classified as a **legacy schema default** interpreted through the dual reader. Every sanctioned insert/upsert writer must always supply a stage using the storage encoder; static/tests must prove no default-dependent writer survives. A late unexpected legacy write is a deployment/inventory incident, not silently hidden by green activation checks.
- No claim of a v2-only SQL CHECK constraint is made while the legacy default exists. If schema inspection discovers a restrictive CHECK that rejects new values, activation blocks for a separately reviewed compatible rebuild design covering full table shape, foreign keys, indexes/triggers and rollback; do not modify `sqlite_master` or use `writable_schema`.
- Do not rerun existing sourcing-decision normalization repairs as part of this operation. Compare immutable-byte baselines after any prerequisite old-schema upgrade and then across the rename separately. Any protected-history mutation discovered in the historical upgrade chain is a blocking prerequisite incident, not an excuse to absorb repair into this rename.

### 5.4 Future sanctioned application sequence

These are design steps, not commands to execute in this tranche:

1. Approve final vocabulary, reviewed inventory, tested binaries, isolated rehearsal evidence and downtime. Verify actual deployment paths/runtime identity. No automatic DB mutation on merely enabling a UI flag.
2. Quiesce **all writers**, not merely pause a batch: drain/stop onboarding workers and in-flight async tasks; stop relevant server instances, extraction callbacks, cohort work, Store Manager scheduler/event/retention workers, operator mutations and repair/import scripts. Protect the DB with exclusive maintenance access. If an in-flight write cannot be proven finished, abort; do not reset live claims casually.
3. Create/verify a consistent standalone backup using `src/db/sqlite-backup-verifier.ts` (VACUUM INTO, immutable artifact verification, source identity/hash, no sidecars, count/digest checks). Confirm storage headroom. Also capture rename-specific protected tables/columns not covered by the verifier's fixed critical-table list, including review state, operation receipts, sourcing generations/acceptances, cohort artifacts and observer cursors. No plain DB-file copy substitute.
4. With writers still quiesced, dry-run inventory: all stages known, statuses valid, required markers complete, DB identity matches verified backup, no conflicting active migration, exact before matrix/digests. Mixed known v1/v2 rows can be normalized idempotently only by the compatible migration path; unknown values stop everything.
5. Run one atomic transaction for stage-only updates plus version marker/maintenance receipt. Preconditions and expected source identity are rechecked at transaction entry. Count semantic rows before and after; preserve IDs, every non-stage item field and protected tables. Failure rolls back the transaction and leaves writers stopped; never mark a partial migration complete.
6. Verify 6×6 count bijection, zero v1 values immediately after backfill, no unknown/null values, immutable bytes/hashes unchanged, FK/integrity checks clean, and read/write encoding matches metadata. Re-running produces no additional stage changes or duplicate receipt. Record elapsed/lock time.
7. Start only the approved v2 or tested bridge binary. Before reopening mutations, run read-only projection/history probes. Resume queued work under existing claim/lease recovery semantics; stale leases follow the existing reclaim/CAS path, not a new migration reset. Only then reopen normal traffic and refresh clients/SSE.

### 5.4a Injectable failure/atomicity proof (isolated tests only)

`onboarding-stage-vocabulary-repo.ts` must accept a test-only optional synchronous failure hook at named transaction checkpoints: `after-preconditions`, after each of the six stage-update statements (`after-stage-1` through `after-stage-6`), `after-invariant-verification`, `after-version-marker`, `after-maintenance-receipt`, and `before-commit`. Production passes no hook; no route, environment variable, or request field can enable it. The SQL runner must expose those statement boundaries rather than hiding an uninterruptible multi-statement `exec` behind a claim of per-point coverage. Hook throws abort the transaction, never commit a progress marker.

`onboarding-stage-migration.test.ts` injects once at **every** checkpoint on v1 and mixed-known fixtures, then reopens a second connection and asserts exact pre-attempt rows/versions/receipt count/protected hashes (absent marker remains absent; existing marker/receipt remains unchanged), no newly partial v1/v2 state, and the maintenance coordinator still stops writers and rejects claims. Success writes the marker and receipt together; re-run is a no-op. Rollback assertions do not merely check the thrown error. After a committed migration, a failure before restart keeps writers stopped for recovery; it must not claim the committed data was rolled back.

### 5.5 Required rollback proof

**Selected supported rollback: the tested bridge binary; backup restore is disaster recovery, not normal rollback.**

- Before any live approval, the **checked-in Bun test** `src/tests/unit/onboarding-stage-rollback-bridge.test.ts` must spawn the actual preserved, emitted bridge executable using the pinned build/protocol in §5.6. It launches that artifact against a disposable DB migrated to v2 and then edited through the native/current implementation: post-migration edits, review invalidation/re-review, approval/export-draft receipts, fresh queued imports and distributor/cohort work. A manually run runbook, source-imported bridge logic, mocked migration/receipt implementation, or skipped artifact test cannot satisfy this gate.
- Prove it reads all history and new rows, replays exact old receipts without duplicating effects, claims/continues eligible queued items, preserves holds and policy-v0 exclusions, and writes new rows in the metadata-selected v2 representation. v1 UI/API remains usable. No inverse rewrite of immutable artifacts is needed.
- For a frontend regression during the grace period, disable shell/brand/strip flags and use the previous BatchWorkspace navigation from the same compatible release. After Slice 7 removes that fallback branch, use the archived matching bridge client instead; the current shell-OFF state is explicitly disabled, not a second navigation system. Do not use PipelineBoard as the rollback shell.
- For a runtime regression, quiesce again, verify a new backup of the current post-cutover state, then switch to the pinned bridge binary/client with metadata/data unchanged. Repeat read-only checks before resuming. **Never run an unmodified pre-bridge binary on v2 storage.**
- A later inverse migration is optional and outside this v1 design. Without a passing actual-bridge rehearsal, migration approval is blocked, regardless of backup availability.

### 5.6 Pinned build and automated emitted-artifact rehearsal

**Checked-in future files:** `scripts/build-onboarding-stage-bridge.ts` (isolated build/package orchestrator), `scripts/onboarding-stage-compat-smoke.ts` (Bun child executable importing the actual bridge repositories/services/app, not reimplementing them), `src/tests/helpers/onboarding-stage-bridge-harness.ts` (spawn/safety/report orchestration), and `src/tests/unit/onboarding-stage-rollback-bridge.test.ts` (Bun acceptance test). The helper is not a separately collected suite; the test file must receive both runner registrations in §6.1.

**Pinned build contract (not TBD):**

- Build from the Slice 5a **bridge** source state, before native enum replacement. Bun compiler/runtime must be **1.3.5** (repo/CI pin); record `bun --version`, `bun --revision`, Bun executable SHA-256, TypeScript compiler version, platform/architecture, `package.json`/`bun.lock`/`tsconfig.json` hashes and the per-input source/asset hashes. Any different runtime requires a new reviewed bridge proof, not an implicit update.
- Inputs are `src/server/index.ts`, `src/server/app.ts`, `scripts/onboarding-stage-compat-smoke.ts`. Exact compiler invocation: `bun build --target=bun --format=esm --splitting --packages=external --root . --outdir "$BRIDGE_ROOT/bun" src/server/index.ts src/server/app.ts scripts/onboarding-stage-compat-smoke.ts`. Output entry paths are `$BRIDGE_ROOT/bun/src/server/index.js`, `$BRIDGE_ROOT/bun/src/server/app.js`, `$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js`; the packaging script asserts these exist and records every emitted shared chunk. No `--compile`, source fallback, or on-demand transpilation in the child.
- Build matching client with `VITE_BATCH_WORKSPACE_ENABLED=true VITE_ONBOARDING_SHELL_V2=false VITE_BRAND_GATE_V2=false VITE_EXECUTION_STRIP_V2=false VITE_PIPELINE_DIAGNOSTICS_ENABLED=false bun node_modules/vite/bin/vite.js build --outDir "$BRIDGE_ROOT/client"`; `VITE_REVIEW_UI_V2` retains its existing default. Record all UI flag values. These commands run with already-installed dependencies, no install/download.
- The packaging script creates a new private external `mkdtemp` directory with prefix `baystate-onboarding-bridge-`, returned as `BRIDGE_ROOT`; it refuses an existing/nonempty output or a path inside the app/catalog/live workspace. For an exact invocation use `bun scripts/build-onboarding-stage-bridge.ts --source-root "$PWD" --output-parent /tmp --prefix baystate-onboarding-bridge- --write-pointer /tmp/baystate-onboarding-bridge-current.json`. The pointer is created exclusively (an existing pointer requires an explicit new evidence path, not clobbering). It names the actual root and manifest; the build command/root are recorded verbatim.
- Manifest/checksum locations are fixed relative to that root: `$BRIDGE_ROOT/bridge-manifest.json`, `$BRIDGE_ROOT/bridge-manifest.sha256`, `$BRIDGE_ROOT/SHA256SUMS`, `$BRIDGE_ROOT/build.log`, `$BRIDGE_ROOT/versions.txt`. Include output entry/chunk/client checksums, exact source-state identity (HEAD **and dirty input hashes**, not HEAD alone), approved mapping digest, schema/storage versions and all runtime asset/dependency inputs. `scripts/build-onboarding-stage-bridge.ts` enumerates filesystem assets such as migration SQL read via `import.meta.dirname` and packages them at the emitted entry/chunk lookup locations; missing or colliding assets fail the build. External packages resolve only through a manifest-pinned, read-only installed dependency tree exposed under `$BRIDGE_ROOT/node_modules`; record its realpath and lock/package integrity. No runtime source lookup outside that audited dependency tree is allowed.
- Freeze this exact artifact/manifest as the rollback input for Slice 5b and later CI. The artifact must be pre-provisioned locally via `ONBOARDING_BRIDGE_MANIFEST`; **missing/checksum-mismatched input fails the Bun suite/CI, never skips or rebuilds current native code and calls it the bridge**. Slice 5a may build it from its current bridge source once; Slice 5b+ verifies the saved build against the reviewed manifest digest. Artifact distribution/storage is an explicit CI prerequisite, not permission for network downloads in this work. Do not insert a large binary or frozen application source copy into the test tree.

**Exact child invocation:** the Bun test creates its own private `FIXTURE_ROOT` (prefix `baystate-onboarding-bridge-case-`) and, using the recorded Bun executable, spawns:

`bun "$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js" --fixture-root "$FIXTURE_ROOT" --db "$FIXTURE_ROOT/db/app.db" --workspace "$FIXTURE_ROOT/workspace" --scenario migrated-edited-v2 --expected-storage-version 2 --manifest "$BRIDGE_ROOT/bridge-manifest.json" --report "$FIXTURE_ROOT/bridge-result.json"`

- Child cwd is `FIXTURE_ROOT`; environment is freshly constructed, not inherited: `NODE_ENV=test`, `TZ=UTC`, `LANG=C`, `LC_ALL=C`, `HOME=$FIXTURE_ROOT/home`, `TMPDIR=$FIXTURE_ROOT/tmp`, `ONBOARDING_COMPAT_FIXTURE_ROOT=$FIXTURE_ROOT`, plus only the manifest-pinned executable `PATH` and a freshly generated in-memory `BAYSTATE_CMS_API_TOKEN`. No live credentials, proxy variables, config/home discovery, or operator feature env leaks; token is never written to logs/manifest. All DB/workspace/report paths must realpath inside the newly created fixture root (reject symlinks/escapes), with a test ownership sentinel. The child calls `initDb` for that DB **before** dynamic-importing app/services; the parent has already initialized all prerequisite schemas and the matching workspace row. Any fallback to catalog initialization/live workspace, omitted argument or mismatched marker is fatal.
- Use the actual emitted Hono app's `fetch(Request)` for v1 route/auth/receipt tests without binding a TCP port; use emitted repositories and worker/transition services for queue continuation. The executable server entry is built/hashed but never imported to start live schedulers. Inject only existing external provider/clock/worker-poll test seams; do not replace stage encoders, DB repositories, auth handlers, receipt logic or migration logic. Block unapproved HTTP/browser/model/ShopSite calls and assert zero outbound calls. Always stop worker timers and close DB handles before exit. Unknown prerequisites fail rather than disabling assertions.
- Parent seeds deterministic v1 history, performs the approved migration and **post-migration edits on v2 storage using the current implementation** (bridge source in Slice 5a; native source in Slice 5b), closes its connection, then runs the child. Slice 5a does not depend on not-yet-written native code; Slice 5b must repeat the proof after actual native edits. Child proves every §5.5 behavior, including mixed history, old receipt replay exact body/hash/id with zero duplicate drafts/audits, denied auth, eligible queue continuation exactly once, held/policy-v0 exclusions, distributor null URL/profile-free behavior, cohort waiting/ready behavior and v2 encoding of a newly inserted row. Parent independently reopens the DB and verifies expected row diffs/protected hashes/side-effect counts; it does not trust an `ok:true` JSON from the child alone. The same source fixture is exercised as a no-op negative/control where relevant.
- Capture child argv, redacted env, exit status, stderr/stdout, bounded structured report, post-DB checks and actual loaded artifact path/checksum under `$FIXTURE_ROOT`; copy the redacted proof bundle to `$BRIDGE_ROOT/rehearsals/<case-id>/`. Nonzero exit, timeout (30s child budget), unexpected network, missing checks/report/artifact or uncollected/skipped tests fail. The orchestration test uses an explicit 120s timeout for build/setup/proof and tests missing-entry, corrupt-checksum, wrong-Bun-version and escaping-path negatives. No executable source import is accepted as substitute.

**Slice 5a P0 acceptance:** both build artifacts and the automated spawned-artifact proof above exist, are registered/collected, and pass; entries/output paths/args/env/manifests/versions are pinned and checked. **Slice 5b acceptance:** re-run the same Bun harness against the frozen bridge artifact after native v2 writes. Source-level suites alone are a false green.

## 6. Phased implementation slices

All slices below describe future work. This planning task creates only this document. Each slice requires its listed tests, reviewer gate, exact changed-file/index evidence and unchanged out-of-scope hashes. **P0 dual runner gate: every new Bun suite file must have BOTH an explicit executable `package.json` `test:db` file entry AND an explicit `vitest.config.ts` exclude entry.** Pure/UI suites use Vitest. A file merely excluded from Vitest, a test glob that does not collect it, or a skipped Bun test is not passed.

### 6.1 Mandatory test-runner registration and CI assertion (all slices)

| Introduced in | Exact new Bun suite requiring both entries |
|---|---|
| 1 | `src/tests/unit/onboarding-stage-read-routes.test.ts` |
| 1 | `src/tests/unit/onboarding-stage-read-query-plan.test.ts` |
| 2 | `src/tests/unit/onboarding-preparation-read.test.ts` — Bun, canonical section/run/projection integration |
| 4 | `src/tests/unit/onboarding-sse-versioning.test.ts` — **Bun unconditionally**, including transitive Hono/SQLite imports |
| 5a | `src/tests/unit/onboarding-stage-migration.test.ts` |
| 5a | `src/tests/unit/onboarding-stage-history-compat.test.ts` |
| 5a | `src/tests/unit/onboarding-stage-queued-continuation.test.ts` |
| 5a | `src/tests/unit/onboarding-stage-rollback-bridge.test.ts` |
| 5b | `src/tests/unit/onboarding-stage-api-compat.test.ts` |

All new Bun file entries use `bun test --timeout 30000` except the spawned-artifact suite, whose **own explicit test:db command** is `bun test --timeout 120000 src/tests/unit/onboarding-stage-rollback-bridge.test.ts` with the required `ONBOARDING_BRIDGE_MANIFEST` environment input. This longer outer budget does not relax the child's 30s timeout or permit a skipped missing artifact.

Slice 0 adds `scripts/check-test-runner-coverage.ts`, its **Vitest** self-test `src/tests/unit/test-runner-coverage.test.ts`, and `package.json` script `test:runner-coverage` = `bun scripts/check-test-runner-coverage.ts`. Wire it as the first step of `package.json` `test` (before Vitest), as a pre-Vitest step in `scripts/verify.sh`, and as a dedicated pre-Vitest step in `.github/workflows/ci.yml`. Do not otherwise change CI/install/lint policy. The new script is read-only and must not import application/DB modules.

The CI assertion walks all candidate `.test.ts/.test.tsx` files and their configured include/exclude membership; **every candidate file containing `bun:test` or `bun:sqlite` must be explicitly excluded from Vitest and explicitly named by a `bun test` invocation in `test:db`**. Detect single/double-quoted static imports, `require`, dynamic imports and unclassified textual occurrences conservatively, not just the string `from 'bun:test'`. Non-suite helpers/source files are never test entries; assert they are not collectable by Vitest and register each Bun suite that imports them, including the nine transitive-DB suites above. Keep a reviewed runner manifest for indirect Bun dependencies; no automatic assumption that absence of a direct import means Vitest-safe. A mock-isolated Vitest importer can remain Vitest only with an explicit tested classification, not a wildcard exemption.

The guard rejects missing/stale/duplicate manifest entries, missing files, registration only in a comment or nonexecuting script branch, Bun suites absent from `test:db`, or a broad exclude concealing new suites. Self-tests use synthetic missing-exclude, missing-test:db, neither, both, transitive-DB, quote/dynamic-import and nonexistent-file cases; the guard itself remains Vitest-collectible. Existing misregistration is reported as a prerequisite blocker, not hidden by disabling the guard or silently swept into unrelated fixes. **Each owning slice's acceptance packet includes both changed entries per new Bun file, guard exit 0, and nonzero collected/executed counts under the intended runner.**

### Slice 0 — Reconcile decisions and freeze the baseline

**Dependencies:** none; owner vocabulary approval is required before vocabulary-dependent code/fixtures are finalized.

**Touch:**

- `docs/adr/0034-onboarding-rename-and-shell-rewrite.md`: replace conflicting draft decisions with the outline in §8; explicitly identify partial supersession of ADR 0016.
- `docs/plans/onboarding-frontend-rewrite-plan.md`: mark superseded by the council-conformant plan, not an implementation authority for tails/heartbeats/new shells.
- `CONTEXT.md`: change **only** the flagged ambiguity bullet around line 782 from always-manual to automation-owned happy-path progression with explicit human decisions.
- `src/onboarding/job-queue.ts`: change **only** the class explanatory comment around 193–196 to acknowledge `sweepAutoAdvance` and `sweepDomainReleases`. No runtime edit in this slice.
- `src/client/onboarding-feature-flags.ts`: retain existing flags/defaults/parser; reconcile misleading board-retention/tail comments.
- `src/onboarding/flags.ts`, `src/tests/unit/onboarding-server-flags.test.ts`: retire unused execution-tail scaffolding after verifying no callers; do not wire it. Keep sourcing/manual-evidence flags and semantics unchanged. Document mandatory version compatibility rather than optional tolerant-read enablement.
- `src/tests/unit/onboarding-feature-flags.test.ts`: pin current defaults and UI/server separation, anticipating the exhaustive rollout matrix in §7.1.
- `package.json`, `scripts/verify.sh`, `.github/workflows/ci.yml`: add the §6.1 runner-coverage command **before Vitest**; preserve all other existing CI steps/policies. `vitest.config.ts` gets each explicit exclude as its Bun suite is introduced, not a blanket new-directory exclusion.

**New:** `docs/plans/onboarding-linear-rewrite-council-plan.md` (sanctioned repo copy of this plan), `docs/plans/onboarding-stage-vocabulary-inventory.md` (Appendix A expanded to the full classified match manifest); `scripts/check-test-runner-coverage.ts`, `src/tests/unit/test-runner-coverage.test.ts` and synthetic non-collectable fixtures under `src/tests/fixtures/test-runner-coverage/` as specified in §6.1.

**Tests/validation:** flag and runner-guard self-tests; source AST/token comparison against the **captured dirty-worktree file**, not merely HEAD, proves the job-queue edit is comment-only; review scoped CONTEXT diff (one bullet, no main definition rewrite). Execute the exact baseline/hash/scoped-diff/log-capture procedure in §7.2 before/after the slice. Record selected/executed counts, exit codes and pre-existing failures separately from new failures; missing logs or zero collected guard tests do not satisfy acceptance.

**Acceptance:** reconciled ADR/plan has no durable tail, fake heartbeat, competing shell or backup-only rollback instruction; exactly the D5 two explanatory sites are reconciled; no runtime progression changes; unrelated dirt/index unchanged. **P0:** runner guard and its synthetic self-tests pass and guard invocation precedes Vitest in package test, verification script and CI. Exact before/after hash/diff/log evidence from §7.2 is present. Vocabulary remains explicitly pending until signed off.

### Slice 1 — Vocabulary adapters and authoritative paginated stage reads

**Dependencies:** Slice 0; approved vocabulary.

**Touch:**

- `src/shared/schemas/onboarding.ts`: explicit legacy-vs-proposed stage schema exports; no runtime enum cutover yet.
- `src/shared/schemas/onboarding-work-state.ts`: expose/reuse existing health/category/status contracts; keep v1 response schemas and cursor hash behavior stable.
- `src/db/repositories/onboarding-item-repo.ts`: additive filtered chunk reader using stage/status aliases; no change to v1 reader/claim behavior. Avoid a new copy of STAGE_ORDER.
- `src/db/repositories/onboarding-work-state-repo.ts`: repository-managed consistent read seam/query instrumentation if needed.
- `src/onboarding/onboarding-work-state.ts`: expose/reuse canonical projection/context helpers without changing their v1 results.
- `src/server/app.ts`: mount the new read-only route module under the same security middleware.
- `package.json` `test:db`: add explicit `bun test` file entries for **both** new Slice 1 Bun suites in §6.1; `vitest.config.ts`: add an explicit per-file exclude for **each same suite**. Run the CI runner guard; neither edit alone is registration.

**New:**

- `src/shared/onboarding-stage-vocabulary.ts`
- `src/shared/schemas/onboarding-stage-read.ts`
- `src/onboarding/onboarding-stage-read.ts`
- `src/server/routes/onboarding-stage-read-routes.ts`
- `src/client/onboarding-stage-api.ts`
- `scripts/audit-onboarding-stage-vocabulary.ts` (read-only source audit, classified inventory check; no DB/application imports)
- `src/tests/unit/onboarding-stage-vocabulary.test.ts` (Vitest)
- `src/tests/unit/onboarding-stage-read-schema.test.ts` (Vitest)
- `src/tests/unit/onboarding-stage-read-routes.test.ts` (Bun)
- `src/tests/unit/onboarding-stage-read-query-plan.test.ts` (Bun)
- `src/tests/unit/onboarding-stage-audit.test.ts` (Vitest; the activation checker's mandatory P0 self-test)
- `src/tests/helpers/onboarding-stage-read-fixtures.ts` (deterministic pure seeded builder/oracle, no Bun imports)
- `src/tests/fixtures/onboarding-stage-audit/` (synthetic non-executable `.fixture` files, not application-stage literals requiring wholesale renaming)

**Deterministic fixture/oracle contract:** `onboarding-stage-read-fixtures.ts` uses a named fixed seed (e.g. `stage-read-v1-001`), fixed IDs/times and deterministic ordering; never random UUIDs/current time as expected results. Build all 36 stage×status cells, >500-row mixed and sparse sets (including zero-match chunks), duplicate row numbers with opposite ID ordering, cross-workspace/batch duplicate UPCs, null URLs/distributor sources, complete sibling families crossing page boundaries, invalidated/unreviewed/reviewed/approved states and critical/degraded context fixtures. A test-only exhaustive in-memory oracle computes expected filtered IDs, category totals and every matrix cell from manually specified semantic fixture expectations; it must **not call the endpoint's filter/matrix/cursor implementation**.

**Parity scope (finite, explicit):** exhaust the 36 stage/status cells, each facet value individually, all stage/status filter-presence combinations, and a deterministic pairwise covering set across category/reviewState/sourceType/domain/cohortId/q. Add named adversarial multi-facet combinations. Compare counts and complete cursor traversal to the oracle for every case. This replaces the unbounded claim to test every possible free-text/filter combination. Test v2 limit 1/49/50/51/100 and reject 0/101/500/fractional/NaN/text; preserve v1 default-100/max-500 acceptance in legacy tests. Verify terminal empty continuation and unchanged ordering when limit changes mid-traversal.

**Adversarial/schema assertions:** six-entry bijection/order/inverse; Step 0 rejected; mixed/unknown vocabularies rejected; wrong-version cursor vs changed-stage-only/status-only/vocab-only/facet-only/batch/workspace fingerprints produce their specified 400 codes. Include malformed base64/JSON, missing/extra cursor fields, altered fingerprint, negative/NaN row numbers, mismatching ID/position types, duplicate query parameters, empty/whitespace/case-normalized search/domain values. Attack payloads include `x' OR 1=1 --`, `'; DROP TABLE onboarding_items; --`, `%`, `_`, backslash, embedded NUL, HTML and credential-looking strings in q/domain/cohort/cursor and enum positions. Invalid fields fail 400; valid free text searches them literally with correct LIKE escaping and cannot widen scope. After every injection case verify table/item digests unchanged and no unauthorized IDs. Cross-workspace 404 precedes work queries; critical projection faults return degraded 503, never false zeros. Existing v1 bodies/cursors remain golden-identical. Reads must not start workers or write DB rows.

**Query-budget assertions:** `onboarding-stage-read-query-plan.test.ts` resets `resetWorkStateQueryCount()` and the new all-statement spy/counter immediately after seeding; reads `getWorkStateQueryCount()` plus executed statement/primary-row logs after **each** request. Assert §4.1 bounds (50 primary rows, 5 existing bulk queries, 24 total statements; counts `6 + 18 × C`) on 1/50/501/1001 candidate sets, sparse filters, acceptance-heavy hydration and one-cohort-per-row fixtures. Assert no per-item/cohort query pattern, no N-sized detail fetch, no 36 repeated count scans, and query counts depend on chunks rather than accepted rows. The all-statement counter observes actual executions (`get/all/run/iterate/exec`), not merely prepared statements or a hand-maintained subset. Keep instrumentation test-owned/wrapped at repository DB boundaries; do not alter the shared driver or weaken frozen v1 counters.

**Inventory checker P0 self-tests:** `onboarding-stage-audit.test.ts` runs the actual read-only checker over synthetic file trees, never a mock of its classifier. Fixtures cover single/double/template literals and SQL interpolation; unquoted/quoted/computed `STAGES` and stage-distribution keys; `.stage`, optional chaining and `['stage']`; concatenated stage values and dynamic `stage_`/computed-key construction; SQL `CHECK`/`DEFAULT` and DDL templates; nested serialized decision targets; runtime stage vs immutable route-ID collisions (including `distributor_record_to_extraction`); independent WorkActivity/ReviewState names; exact valid residual allowlists, stale/missing/overbroad/version-wrong allowlists and changed source hashes. Known operational literals must be found with file/line/role; unresolved dynamic construction must fail as **unclassified**, never silently pass. A properly versioned route-ID/fixture residual passes; reusing that allowance at a runtime stage guard fails. Test CLI exit status, deterministic manifest order, no file/DB mutation, and that deleting an allowance or introducing each evasion changes a previously green tree to nonzero. Checker import must not execute its CLI. AST-based scanning may use already-installed TypeScript; no new parser download.

**Validation:** targeted Vitest/Bun suites plus existing `onboarding-work-state-query-plan.test.ts`, `onboarding-work-routes.test.ts`; typecheck/build; classified source-audit report. No migration/index application.

**Acceptance:** v2 stage/status results and matching summaries are server-authoritative; no client full-batch scan is needed; old API/queue/cursor behavior remains unchanged. **P0 gates:** both new Bun suites have their exact test:db entries **and** Vitest excludes, the CI runner assertion passes, and every inventory-checker evasion/allowlist self-test above is collected and passes. Oracle parity, intentional limit divergence, fingerprint extension and total-SQL budgets are mandatory acceptance evidence, not optional benchmarks.

### Slice 2 — Strangle navigation in BatchWorkspace; fix misleading outcomes

**Dependencies:** Slice 1.

**Touch:**

- `src/client/components/Onboarding.tsx`: remove the implicit flag-disabled PipelineBoard fallback; diagnostics requires both explicit query and enabled flag. Keep existing BatchWorkspace mount as the single normal shell.
- `src/client/components/onboarding/BatchWorkspace.tsx`: flag-controlled primary stage navigation and preserved operation destinations; scope/freshness-aware fetch lifecycle.
- `src/client/components/onboarding/batch-workspace-logic.ts`: stage/operation URL routing, independent category/review facets; fix skipped destination and completed counts in both flag states.
- `src/client/components/onboarding/WorkStateTabs.tsx`: retain as the within-BatchWorkspace rollout fallback/secondary navigation; do not create another root shell.
- `src/client/components/onboarding/onboarding-workspace.css`: scoped stage navigation/status/outcome styling only.
- `src/tests/unit/batch-workspace-logic.test.ts`, `src/tests/unit/onboarding-feature-flags.test.ts`.
- `src/shared/schemas/onboarding-stage-read.ts`, `src/onboarding/onboarding-stage-read.ts`, `src/db/repositories/onboarding-work-state-repo.ts`: additive **v2-only** preparation-section schema/derivation/bulk facts within the existing read budget, reusing canonical classification/cohort semantics; do not modify frozen v1 handlers or broaden worker behavior.
- `src/client/onboarding-stage-api.ts`: consume typed section summaries; `src/client/onboarding-api.ts` existing `getItemDetail` is reused unchanged for one selected item only.
- `package.json` `test:db` and `vitest.config.ts`: respectively add the exact `src/tests/unit/onboarding-preparation-read.test.ts` execution entry **and** explicit exclude; run the §6.1 CI assertion. No other section test is a Bun suite.

**New:**

- `src/client/components/onboarding/StageNavigation.tsx`
- `src/client/components/onboarding/StageItemsView.tsx`
- `src/client/components/onboarding/OutcomeItemsView.tsx` (Completed/Skipped server-filtered results; no new decisions)
- `src/client/components/onboarding/linear-workspace-logic.ts`
- `src/client/components/onboarding/PrepareListingView.tsx` (one stage view with internal sections, not another shell)
- `src/client/components/onboarding/prepare-listing-logic.ts` (presentation of explicit server states, never a second classifier)
- `src/shared/schemas/onboarding-preparation.ts` (read-only five-section summary, separate from PipelineStage/StageStatus)
- `src/onboarding/onboarding-preparation-read.ts` (pure server section derivation from validated canonical inputs)
- `src/tests/unit/onboarding-preparation-schema.test.ts` (Vitest)
- `src/tests/unit/onboarding-prepare-listing.test.tsx` (Vitest/jsdom)
- `src/tests/unit/onboarding-preparation-read.test.ts` (Bun, both runner entries required)
- `src/tests/unit/onboarding-linear-shell.test.tsx`
- `src/tests/unit/onboarding-stage-items.test.tsx`
- `src/tests/fixtures/onboarding-shell-matrix.json` (checked-in, mechanically expanded expected-case ledger from §7.1; includes before/after retirement phases, never derived by calling the production resolver)

**Source-strategy presentation (binding owner input):** the main header/help diagram emphasizes the official product URL workflow. Stage 1 is an automatic source-triage/routing inbox, not a compulsory distributor checklist or a “choose one for every product” gate. Render the existing server activity/source/qualification for each row truthfully, including an actual distributor lookup when it occurs; offer the qualified distributor-record path as secondary context/action through existing resolution flows. Do not relabel a real distributor record as an official page, require an official URL for its materialization, fabricate a supplier visit/completion for official-only items, or change importer entry stages/worker priority. Selecting a stage tab is navigation, never an advance action. Tests cover a directly entered official-page flow, a triage row whose actual activity is distributor lookup, mixed items, and the qualified null-URL fast path without making that path the default explanatory headline.

**Prepare listing granularity — answer to the owner:** **yes, one stage and one view; no, not one undifferentiated task/status.** Keep the stage as the orchestration container and show the following five separately titled landmarks/expandable sections within `PrepareListingView`. They are not primary tabs, execution stages, a prescribed five-step sequence, independent retry queues or new mutation gates. Packaging OCR is evidence; family/cohort state is shared grouping/readiness that can begin before this stage; names, product type and fields are distinguishable outputs with different authority. The existing worker/classification ordering and configuration flags remain unchanged.

| Internal section | What is shown and authoritative source | Explicit states/interpretation | Scope and existing operation boundary |
|---|---|---|---|
| **Packaging OCR evidence** | Current item's recorded packaging-OCR outcome and validated `packaging_ocr` stage/evidence provenance; bounded textual outcome/provenance summary, not raw image fetch/model call | Not recorded/unknown, queued/running when recorded, evidence available, no image, disabled, skipped, failed, stale. “No image”/disabled/abstained is not an OCR success; evidence availability is not accepted classification | Selected item in the stage; OCR for a supplier-record extraction must not be triggered by viewing this section. Existing evidence/attention inspector remains the resolution surface; no OCR button or rights-policy change |
| **Family/cohort grouping & readiness** | Canonical active cohort identity/membership/readiness, ready/blocked/waiting counts, frozen/cohort-run state and affected sibling IDs | No active cohort or per-item mode (not invented grouping); forming/waiting/blocked/ready; freezing/running only when recorded; superseded/stale/unknown shown explicitly. Grouping existence does not imply readiness | Rows/counts are stage-scoped, but the selected item's **complete actual family** may include siblings in other stages; show “family context across stages” and their recorded stages. Full-batch `FamilyWaitingView`/family inspector remains unchanged via an explicit destination; no client regrouping/partial-family run |
| **Name curation** | Current canonical coordinated/consolidated title and `name_consolidation` output/lineage, with original name clearly separate | Not started/unknown, running, proposed output, abstained, failed, stale or semantic conflict; an available name is not human-reviewed/approved | Selected item's output, with shared family coordination provenance when applicable. No inline decision/autosave; open the existing review/conflict flow, keeping its batch scope labeled |
| **Product type assignment** | Current validated primary-product-type proposal/decision and, when applicable, separate frozen cohort execution-type context; `primary_product_type_proposal` and canonical decision lineage | Pending/proposed vs accepted/revised/rejected, unknown/abstained, blocked/conflicted or stale. Frozen **execution type** is not a reviewed assignment; a tentative type does not unlock type-gated field acceptance | Item's assignment plus explicitly labeled family context. Changes/acceptance stay in frozen Review/semantic-conflict operations; no new type-authority shortcut |
| **Field classification** | Canonical `attribute_applicability`/`product_attribute_proposals` results and current proposal counts/decisions; bounded summary of applicable fields, pending/reviewed/stale/abstained/conflicting outputs | Not started/unknown, running, proposed/awaiting decisions, partly decided, current decided output, abstained/skipped, failed or blocked. Applicability from accepted facts is distinct from a preview. Never label the whole section approved because stage_status is completed | Selected item; no bulk field editor. Include a clearly separate **Page placement / draft-readiness** sub-row when canonical `category_page_proposals`/`product_draft_projection` facts exist, so those existing outputs are not lost or mislabeled as attributes. Existing Review pages/fields and approval/export remain full-batch operations |

**State/read contract and boundaries:** all five summary objects are server-derived, read-only display contracts distinct from StageStatus and WorkActivity. Use `schemaVersion`, current item/stage, validated `runId`/cohort ID where available, `computedAt`/projection health, finite state/reason codes and bounded counts/labels. Existing bulk stage names (including optional configured classification stages) are interpreted, **never renamed or forced into a new five-stage order**. No client inference from missing output/error strings/one current activity, no `5/5 done` progress invention, and no percentage that treats skipped/abstained as success. When run linkage is missing, mismatched, historical or invalidated, show unavailable/stale instead of combining outputs from different runs. Keep proposed values, accepted/revised decisions and current preview distinct; classification snapshot/config/source hashes and history bytes are never rewritten by viewing.

`onboarding-preparation-read.ts` takes validated inputs from the stage-read service and reuses canonical classification/cohort meaning (see `onboarding-work-state.ts` existing stage-name/activity mapping, `classification-run-repo.ts` validated-run/stage/proposal/decision readers). Add bulk fact/aggregate access in `onboarding-work-state-repo.ts` rather than an item-by-item call to those detail readers. The v2 row summary contains exactly five fixed sections, at most one bounded reason label per section (160 display characters), optional counts/IDs and existing family context — no evidence/proposal/history arrays. All section data for one chunk must remain within Slice 1's **24 total SQL statement** ceiling; do not attach another per-row detail query. Counts/matrix requests remain counts only. No new read endpoint, DB table, migration, `/runs` history API or change to frozen v1 routes is needed.

The stage view's paginated item list and all default totals are **stage-scoped**. Five sections show summary/provenance for the selected stage item; before selection, show stage-scoped list/help, not a full-batch “all prepared” status. A section's family context may cross stages and is labeled as such; it never changes the stage-list denominator. Selecting a row may issue **one** existing `getItemDetail(itemId)` for current canonical preview/proposals/evidence; only the active item is retained, no page-wide fetch, adjacent prefetch, all-family detail loop or access to the frozen ReviewWorkspace LRU. Do not infer section execution state from this legacy payload when it lacks a validated outcome; summary stays unavailable. Display bounded escaped excerpts; no automatic image/model/profile fetch on opening. Batch/item/run changes discard stale summaries/detail responses using generation guards.

AttentionQueueView, ProcessingView, FamilyWaitingView, ReviewWorkspace, ApprovedView, ReadyToExportView and all resolution panels remain **full-batch** operations reached explicitly from this sectioned stage view. Opening one hides/resets the stage-scoped controls, labels the whole-batch scope, preserves its existing cursor/filter/cache/mutation behavior and returns to the prior selected stage/item when closed. Do not embed an unchanged batch-only child under a badge that pretends it is stage-filtered. The new five-section presentation is read-only; review/approval/export remain distinct durable actions outside it.

**Granularity acceptance tests:** schema tests reject extra section/stage keys and mixed/unknown versions, enforce bounds, and preserve StageStatus/STAGE_ORDER length six. The Bun section projection suite exercises official-page and distributor evidence, no-image/disabled/failed OCR, coherent vs invalidated/mismatched run linkage, per-item/cohort modes, complete families spanning stages (waiting/blocked/frozen), proposed vs accepted/revised/stale product type, type-gated pending fields, name conflict, partial/abstained field outputs, Page placement and unknown facts. Assert server values remain canonical/read-only, no evidence/hash/review mutation or new model/profile/network work, all chunk summaries respect query budgets, and no section state confers approval. The Vitest view suite asserts five landmarks in **one** view, only current-stage rows counted, off-stage siblings explicitly contextual, exactly one selected-item detail request independent of page size, no N+1, stale-response discard, current activity cannot mark all five complete, and full-batch operation links preserve the frozen mounts/scope. Also test the source-strategy narrative/actual-work combinations above. Test that all six tabs remain six under every section expansion/flag combination.

**Assertions:** exactly six execution tabs/order; Step 0 is a view slot only; stage/status/category/review filters sent server-side; badges not derived from fetched page; default Review stage list unreviewed, reviewed/not_ready separated; skipped never opens Approved; Ready-to-Export count excludes completed; full-batch review/attention/processing/family/approved/export views are clearly scoped and mount the unchanged implementations. Preserve history/popstate, batch-switch cancellation, cursor reset on filter changes, keyboard navigation/ARIA/focus and empty/error states. The **explicit exhaustive truth table in §7.1** is the test oracle: expand every shell×brand×strip×workspace×diagnostics×board-query×legacy-tab combination, not only pairwise/happy paths. Test the mount itself, not just flag return values, and prove module-cache/override isolation. Shell OFF+brand ON never mounts the new brand view; workspace OFF+diagnostics ON without query never mounts PipelineBoard.

**Regression:** `review-workspace-loading.test.tsx`, `review-workspace-challenger-stress.test.tsx`, `review-logic.test.ts`, `onboarding-ui-idempotency.test.ts`, attention/family/approved suites that exist in the inventory. Assert review cursor pages, LRU and action bodies unchanged, not only visual snapshots.

**Acceptance:** one BatchWorkspace lineage; operator navigation is linear under the flag; official URL is the main source narrative, stage 1 is neutral triage, and a qualified distributor remains a truthfully labeled secondary fast path with **no runtime routing change**. Prepare listing is one stage/view with all five explicit sections, canonical non-conflated states and clearly stage-scoped vs cross-stage-family/full-batch boundaries; schema/projection/view/query/fetch-budget tests pass. All frozen operations remain reachable; three presentation bugs are fixed even on rollback navigation; no premature claim that temporary display adapters finish D1. The new Bun preparation-read suite has BOTH test:db and Vitest-exclude entries and executes under the §6.1 guard. **P0:** the fully expanded §7.1 matrix is published, collected and green with exact expected root/destination/brand/strip/notice assertions and reset isolation.

### Slice 3 — Step 0 single brand setup view

**Dependencies:** Slice 2; brand flag requires shell flag.

**Touch:**

- `src/client/components/onboarding/BatchWorkspace.tsx`: mount the unified view and route existing preflight/setup entry points into it when enabled.
- `src/client/components/Onboarding.tsx`: pass existing batch/preflight/settings callbacks and preserve controlled-release flow.
- `src/client/onboarding-stage-api.ts`: compose existing typed preflight/brand/domain reads; no new authority or mutation protocol.
- `src/client/components/onboarding/preflight/BatchPreflightModal.tsx`: optional navigation link/callback to the same brand view only; preserve ready-only/all-items release, drafts and existing save/start bodies.
- `src/tests/unit/batch-preflight-modal.test.tsx`: existing Vitest jsdom suite **verified present** (header and imports read during review revision); extend link/navigation assertions and preserve existing release/save request assertions. It is intentionally listed in the Slice 3 command, not an untracked test dependency.

**New:**

- `src/client/components/onboarding/BrandGateView.tsx`
- `src/client/components/onboarding/brand-gate-logic.ts`
- `src/tests/unit/onboarding-brand-gate.test.tsx`
- `src/tests/unit/onboarding-brand-gate-logic.test.ts`

**Composition contract:** top shows preflight mapping coverage/advice and the existing `BrandDomainSetupPanel`; bottom shows per-item brand fixes with existing brand-assignment actions/selector, plus existing grouped `BrandAssignmentPanel` where useful. Load per-item display rows through bounded server reads, not an unbounded detail fetch per preflight ID. Reuse `getBatchPreflight`, `getBrandDomainBlockers`, `assignBrandGroup`, `configureBrand`, per-item assign-brand/domain and existing bulk validation. Settings remains mapping authority. The single new view may link to the same frozen contextual resolution forms; it does not duplicate their policy logic. Do not remove existing frozen contextual actions merely to hide their availability.

**Behavior:** preflight readiness/held IDs remain server-owned. Missing domain can be advisory for supplier-qualified paths; unknown/mismatched official authority still blocks official auto-accept. Empty brand-blocker response is not proof that all mappings are healthy: use successful preflight metrics, show loading/error/unknown for unavailable checks and label parked-item counts as such. No inference from error strings in the browser. No provisional-domain, retailer-source taxonomy, alias-inference or new `brand_status/source_policy` fields.

**Assertions:** mapped official item; missing brand; assigned but unmapped brand; mismatched candidate domain; mixed batch where ready items continue despite blocked siblings; qualified distributor with no official domain/null URL remains extraction-eligible/profile-free; policy-v0 unchanged; no persisted Step-0 stage; failed reads show unknown not healthy; cross-batch/blank brand rejected by existing endpoints. Action success refetches all relevant projections; view does not locally mark an item unblocked.

**Fetch budget (automated):** spy on actual typed-client calls and underlying fetches for 1/50/501/1001 preflight IDs. For one initial load/refresh epoch with both frozen panels mounted: `getBatchPreflight` at most 2 calls (view summary + existing BrandAssignmentPanel), `getBrandDomainBlockers` at most 2 (view check + existing BrandDomainSetupPanel), at most 1 bounded stage-items request and 1 stage-counts request: **at most 6 read requests total independent of N**, zero per-item detail requests. This explicitly permits a bounded duplicate caused by frozen children, not an API-layer global cache/refactor. On each user Load more: at most 1 additional items request, no automatic page chase. At most 1 submitted mutation plus the same bounded refresh epoch after success; stale/failing requests are not multiplied by N. Test StrictMode separately: at most 2 initial epochs, cleanup prevents leaking additional epochs; do not multiply requests by number of IDs. Metadata-only preflight/server panel responses can include ID lists, but that never authorizes N detail fetches. Existing Bun preflight/brand suites protect server authority; new stage reads satisfy Slice 1 SQL budgets.

**Empty/error matrix:** assert blockers `[]` + preflight error/loading => health unknown/error, never healthy; blockers `[]` + successful preflight with missing mappings => mapping warning, not all-green; failed blocker read + valid preflight => only preflight's measured coverage is displayed, parked-item check is unknown; both reads succeed and coverage is complete => measured mapping coverage, **not** worker/source-authority approval; stale prior success on batch switch never flashes another batch's health. Mixed ready/held fixtures still permit existing ready-only release, distributor-only fixtures are not forced through official domains, mutation failure leaves server-owned holds/counts unchanged, and success does not remove blockers until a fresh successful response confirms it. Cover this matrix in `onboarding-brand-gate-logic.test.ts` and rendered/fetch-budget assertions in `onboarding-brand-gate.test.tsx`.

**Validation:** new UI logic suites; Bun `batch-preflight-lifecycle.test.ts`, `brand-authority-gate.test.ts`, `brand-assign-routes.test.ts`, `brand-domain-setup.test.ts`, `distributor-record-materializer.test.ts`, `sourcing-default-on-e2e.test.ts` with fixture services only.

**Acceptance:** one ordered brand view, existing authority/release behavior preserved, no seventh stage or batch-wide gate. Frozen panels remain unchanged. Fetch counts are within the stated budgets on large-ID fixtures; every empty≠healthy/error combination passes; the existing preflight modal test is in both the touch inventory and executed command.

### Slice 4 — Ephemeral execution strip with honest freshness

**Dependencies:** Slices 1–2; can be implemented after Slice 3 by the same sequential writer.

**Touch:**

- `src/client/components/onboarding/BatchWorkspace.tsx`: own the shell/strip count subscription lifecycle; avoid duplicate shell fetch loops.
- `src/client/onboarding-work-api.ts`: backwards-compatible optional subscription lifecycle/options argument; existing two-argument callers and named-event callbacks stay unchanged.
- `src/client/onboarding-stage-api.ts`: typed batch/count fetching for the strip.
- `src/server/routes/onboarding-routes.ts`: explicit v2 SSE representation selection only, retaining ownership guard and v1 behavior.
- `src/onboarding/sse-emitter.ts`: types/boundary support only if needed; no storage, heartbeat, new worker narration or replay.
- `package.json`, `vitest.config.ts`: respectively add the explicit `onboarding-sse-versioning.test.ts` Bun execution entry and the same file's explicit Vitest exclude; no conditional runner choice.

**New:**

- `src/shared/schemas/onboarding-live-activity.ts`
- `src/server/onboarding-event-presentation.ts` (allowlisted v2 serializer)
- `src/client/components/onboarding/ExecutionStrip.tsx`
- `src/client/components/onboarding/use-execution-strip.ts`
- `src/client/components/onboarding/execution-strip-logic.ts`
- `src/tests/unit/onboarding-live-activity.test.ts`
- `src/tests/unit/onboarding-execution-strip.test.tsx`
- `src/tests/unit/onboarding-sse-versioning.test.ts` (**Bun unconditionally**; explicit package test:db entry and Vitest exclude in this slice)
- `src/tests/helpers/onboarding-event-source-harness.ts` (Vitest/jsdom test helper: injectable EventSource factory, deferred fetch queue, fake clock; no production networking)

**Deterministic test harness (mandatory, not manual):** `onboarding-event-source-harness.ts` installs the fake EventSource factory **before** importing/mounting the hook, calls `vi.useFakeTimers()` with a fixed system time, and exposes explicit `open`, named `message`, unnamed fallback message, `error`, and `close` delivery. It never auto-reconnects or emits anything implicitly; tests drive each sequence. Deferred fetch promises can resolve/reject in a chosen order. Advance time inside React `act`, await microtasks, and assert exact fetch/render counts before and after every boundary. Restore real timers, fetch, EventSource, visibility/focus/online listeners and module/flag overrides after each case; a leaked handler/timer is a test failure, not cleanup noise.

**Required automated sequences:** mount at t0 => initial refresh; first `open` => refresh (coalesce only if an equivalent initial fetch is still pending, with one trailing refresh guaranteed); deliver valid named/unnamed activity; advance to debounce−1 and debounce to check no early/fire-once behavior; send activity more frequently than debounce until maxDebounceWait to prove no starvation; advance to refreshInterval−1 and refreshInterval; `error` followed by explicit `open` creates reconnect/gap disclosure and refetch; hidden→visible, focus and online trigger one coalesced refresh. Test connecting with fresh projection vs connected with stale projection independently. Test staleAfter−1/at/+1 and invalid/skewed computedAt; projection error marks degraded immediately, successful fetch resets freshness but never worker liveness.

**Race/teardown assertions:** start batch/filter generation A, switch to B, resolve B then resolve/reject A; neither A's counts, health, error nor events may enter B. Also unmount with pending fetch and scheduled debounce/periodic timer, advance through all budgets and resolve the promise: no further fetch, state write, retained event, active listener or timer; fake EventSource closed exactly once. Continuous SSE cannot reset a frozen review cache or approval token. Failed fetch retains only the current generation's last success. Counts/batch state never derive from received events.

**Cap/security assertions:** use the injected budgets (production proposal and a second small configuration) to test maxEntries−1/exact/+1, maxSummaryChars−1/exact/+1 and maxFrameBytes−1/exact/+1 using UTF-8 byte length, including multi-byte Unicode. Oldest summary is evicted, raw payload is not retained, malformed/oversized events cannot crash or expand state, and HTML/token/credential-URL/error-message strings never reach DOM/history/storage/logs. `welcome`/`ping` are excluded from activity, Received-at uses the controlled receipt clock rather than event-supplied timestamps, missing/disconnected history is disclosed and no false worker-heartbeat label appears.

**Validation:** deterministic automated hook/component/event suites above; Bun SSE versioning/v1 subscriber contract suite and existing `onboarding-telemetry.test.ts`; §6.1 runner guard. An offline manual walkthrough is **supplemental only** (labels, accessibility, gap disclosure, pause/resume presentation); it cannot replace clock/race/cap/teardown assertions. Confirm no `health.ts`, execution-event table, telemetry-denominator or worker poll logic changes.

**Acceptance:** D3 freshness behavior is complete without a DB migration, historical feed or fake heartbeat. Deterministic EventSource/fake-clock tests exercise every specified race/teardown/cap sequence using parameterized budgets; no acceptance depends on a human waiting for a timer. **P0 runner gate:** SSE versioning is executed under Bun, explicitly listed in test:db and explicitly excluded from Vitest; guard passes. Numeric default approval remains on the owner checklist.

### Slice 5a — Complete inventory, bridge and migration rehearsal design implementation

**Dependencies:** Slice 0 approved vocabulary; Slice 1 read contracts. Execute sequentially after UI slices to keep one writer; do not turn flags on by default yet.

**Touch:** exact runtime/DB/API targets in Appendix A, starting with shared authority, repository normalization and transport boundaries. `src/onboarding/flags.ts` compatibility scaffolding; `src/db/migrations.ts` guarded metadata/precondition integration; `src/server/app.ts` version-aware boundary installation; `package.json` `test:db` gets an explicit entry for **each of the four** new Slice 5a Bun suites below and `vitest.config.ts` gets **each same file's explicit exclude**; `.github/workflows/ci.yml`/`scripts/verify.sh` wire the frozen-artifact input/proof gate without skipping it. **Do not mechanically rewrite historical SQL/immutable fixtures.**

**New:** migration/design implementation files in §5.1; `src/server/onboarding-stage-api.ts`; `src/onboarding/onboarding-stage-artifacts.ts` for explicit immutable-format target interpretation/serialization; `scripts/build-onboarding-stage-bridge.ts`, `scripts/onboarding-stage-compat-smoke.ts`, `src/tests/helpers/onboarding-stage-bridge-harness.ts` as pinned in §5.6; tests below. Extend the runbook with those exact build/child contracts and manifests; they are no longer deferred decisions.

**Work:** finish the classified manifest from AST/string/template/SQL/property-key searches and schema inventory. Add version-aware dual reads and storage-version-dependent writes to every guard/query/writer, including raw review guards, observer rows, cohort claim/freeze checks, reset, batch archival/distribution and administrative repair scripts. Preserve the bridge's runtime vocabulary until its mixed-storage tests pass. Build/pin the actual bridge artifact before the native rewrite.

**New Bun tests:**

- `src/tests/unit/onboarding-stage-migration.test.ts`
- `src/tests/unit/onboarding-stage-history-compat.test.ts`
- `src/tests/unit/onboarding-stage-queued-continuation.test.ts`
- `src/tests/unit/onboarding-stage-rollback-bridge.test.ts`

**Update regressions:** `db-migration.test.ts`, `onboarding-repos.test.ts`, `onboarding-operation-idempotency.test.ts`, `onboarding-work-routes.test.ts`, `onboarding-review-state.test.ts`, `onboarding-automation.test.ts`, `onboarding-telemetry.test.ts`, `sourcing-stage-order.test.ts`, `sourcing-policy.test.ts`, `cohort-worker.test.ts`, `cohort-freeze.test.ts`, `durable-approval-promote.test.ts`, `draft-promoter.test.ts`; other stage-dependent fixtures only as classified in the manifest.

**Assertions/rehearsal:**

- Fresh, status-only legacy, current v1, mixed known stages, already-migrated, empty and archived DB fixtures; unknown/null/corrupt stage rejection; old operator-state ordering; rerun idempotency; transaction failure after each update/marker point; all 36 stage/status combinations and row-by-row non-stage parity.
- Byte/hash equality of immutable snapshots, evidence/acceptances, sourcing route IDs/decision JSON, review rows, operation receipts/audit records and recorded request bodies. Existing v2 decision target interpreted under its original schema; forbidden routes remain unactionable; malformed newer schema never legacy-falls-back.
- Pre/post queues: pending automated stages, in_progress/stale leases with existing CAS recovery, failed/needs_input/skipped/completed, paused/held batches, policy-v0 rows, sourcing OFF/observe/manual/automatic, distributor bypass, domain release, waiting/blocked/ready cohort, reviewed but unapproved, approved but unexported.
- Same logical workflow emits the same semantic transitions/side-effect counts before and after mapping; review invalidation/re-review/approval/export idempotency/auth failures unchanged; no rename-induced invalidation or observer automation events.
- Backup/maintenance preconditions fail closed; dry-run writes nothing; apply cannot start on import or UI flag change. Use the injectable named failure checkpoints in §5.4a to prove every update/version/receipt/pre-commit failure rolls back data **and** marker/receipt, including second-connection observation and writers remaining stopped.
- **No cache loophole:** in the same un-restarted process and connection, write v1, commit the exclusive version flip from another connection, then write v2; test a concurrent flip cannot interleave the metadata read/write transaction.
- **Automated artifact proof:** the checked-in Bun rollback test spawns the emitted bridge executable according to §5.6 against a migrated-then-edited DB, checks outputs and independently checks DB effects. Also fail on missing/wrong entry, checksum, runtime, unsafe fixture paths, unexpected network and timeouts. Source logic tests or manual runbook logs are not substitutes.

**Acceptance:** complete classified inventory and passing synthetic checker self-tests; every named failure checkpoint and same-process storage-version flip test passes; maintenance remains explicitly gated. **P0:** all four Bun suites have BOTH file-specific test:db entries AND Vitest excludes, runner guard/collection succeeds, and the checked-in Bun harness actually launches the frozen emitted bridge artifact and proves §5.5 on a disposable migrated-then-edited v2 DB. The exact §5.6 build entries/outdir/child args/env, `bridge-manifest.json`, `SHA256SUMS`, Bun 1.3.5 compiler/runtime revision/executable hash, TS version, source/lock/asset hashes and independent post-DB proof are attached to the acceptance packet. Missing emitted-artifact proof blocks acceptance even when all source-level tests are green. No live DB upgrade has happened.

### Slice 5b — Native rename in code, with deferred storage activation

**Dependencies:** Slice 5a bridge proof and full manifest review. This is the D1 machine rename, not a labels-only acceptance.

**Touch:** Appendix A's operational entries and their classified stage-dependent tests. Specifically change `PipelineStageEnum`, canonical order, insert/claim/update/reset/advance guards, SOURCING_COMPLETION_TARGETS values, batch stage distributions, worker dispatch/sweep targets, cohort predicates, projection live stages, stage-typed route/API/SSE fields, PipelineBoard `STAGES` while it remains mounted, and diagnostics/report consumers. Frozen files receive only the approved rename-boundary substitutions. Retire the stale `onboarding-item-repo.ts:1061` PipelineBoard presentation comment without changing `resetItemsToStage`'s completed-status behavior.

**Do not touch:** independent activity/review/source enums, classification's separate seven stages, historical migration literals, receipt hashes, route IDs, ShopSite sync or new algorithmic policies. Do not rename modules/functions solely because their domain names include Discovery/Extraction/Curation.

**Tests:** all Slice 5a coverage under native enum plus the **same frozen bridge artifact**, never a bridge rebuilt from native source; new `src/tests/unit/onboarding-stage-api-compat.test.ts` (**Bun unconditionally**) for v1/v2 route/distribution/rejection-message bodies and SSE vocabulary consistency. Touch `package.json` to add its exact test:db entry and `vitest.config.ts` to add its exact exclude; require guard and collected/executed count evidence. Preserve v1 fixtures as v1; add v2 fixtures rather than blanket-updating golden history.

**Validation:** classified inventory checker must find no unadapted **operational** old literals; all allowed residuals have version/role/test ownership. Full offline suite ladder and owner/reviewer migration gate. No backfill is executed by this planning tranche or by merely merging the code.

**Acceptance:** native v2 domain/runtime enum is used end-to-end; old DBs remain readable/processable through bridge adapters; new writes respect per-transaction DB storage metadata; v1 UI/API/history remains compatible. **P0:** API-compat suite has both runner entries and executes, inventory self-tests stay green, and the automated bridge test passes against the pinned pre-native artifact after native v2 writes. Future storage activation follows §5 and cannot be inferred from a green UI demo.

### Slice 6 — Controlled default-on, then remove PipelineBoard mounts

**Dependencies:** Slices 2–5b accepted; isolated migration/rollback proof; final vocabulary approved. Production storage activation, if requested, is separately authorized under §5 before declaring D1 fully deployed.

**Touch:** `src/client/onboarding-feature-flags.ts`, `src/client/components/Onboarding.tsx`, `src/client/components/onboarding/BatchWorkspace.tsx`, `src/client/components/onboarding/WorkStateTabs.tsx`, shell tests; `docs/runbooks/onboarding-linear-rewrite-rollout.md`, ADR 0034 decision/acceptance status.

**Rollout:** enable shell, then brand gate/strip for a local operator cohort using Vite build flags; keep the old navigation inside BatchWorkspace as a temporary rollback mode. Explicit diagnostics still requires `?board=pipeline`. Verify offline workflow parity and operator usability. Once the replacement is accepted, disable diagnostics by default and **remove all PipelineBoard mount branches/imports**, including workspace-disabled fallback. An old diagnostic URL resolves to the current shell with a retirement notice, not a dead screen.

**New:** `scripts/audit-onboarding-shell-imports.ts`, `src/tests/unit/onboarding-shell-imports.test.ts` (Vitest), synthetic import trees under `src/tests/fixtures/onboarding-shell-imports/`, and `docs/plans/onboarding-shell-retirement-inventory.md` (exact deletion/behavior/coverage allowlist).

**Automated deletion proof:** the actual audit tool walks `src/client` from `Onboarding.tsx`/`BatchWorkspace.tsx` and all other client entry points, resolving TS path aliases, static imports, re-export barrels, `require`, literal/constant-foldable dynamic `import`, `React.lazy`, import-meta glob patterns and CSS imports/references. Any unresolved computed import that might reach PipelineBoard is an **unclassified blocker**, not an assumed absence. Tests seed direct, aliased, barrel, lazy/dynamic, concatenated/glob and CSS-only reference fixtures and verify detection/CLI nonzero; a clean tree passes deterministically. At mount retirement no production static/dynamic/re-export path may reach PipelineBoard, including a disabled flag branch. File deletion alone or grep for a JSX name is not evidence.

The retirement inventory compares pre/post export names, handler/feature ownership and test/coverage attribution: each unique board behavior is either already exercised in the preserved shell/operation surface or explicitly approved as diagnostics-only retirement. For every candidate helper/style/test deletion, list exact path, all inbound references, behavior owners, existing replacement tests and coverage before/after. A shared inbound edge forbids deletion. No wildcard helper deletion and no loss of unique review/decision/export behavior. This is a coverage/ownership diff, not permission to edit frozen components to simplify removal.

**Tests/acceptance:** §7.1's **entire post-retirement mount matrix** executes, including workspace OFF/diagnostics ON/query present => BatchWorkspace plus retirement notice; no PipelineBoard import/mount. `VITE_BATCH_WORKSPACE_ENABLED` no longer disables the sole shell after retirement (deprecated input is ignored); shell-v2 OFF still selects the within-BatchWorkspace grace fallback, not the board. Import-graph self-tests and the production scan pass; retirement export/coverage ledger is reviewed; frozen operations remain reachable. Keep the now-unreachable board file only for a bounded reviewed interval; it is not an alternate rollback shell.

### Slice 7 — Remove unreachable board and temporary navigation competition

**Dependencies:** Slice 6 zero-mount evidence plus agreed grace interval/manual acceptance; compatible runtime rollback remains available.

**Delete:** `src/client/components/PipelineBoard.tsx` only after the Slice 6 graph/export/coverage proof. Delete tests/styles/helpers **only by exact paths individually approved in `docs/plans/onboarding-shell-retirement-inventory.md`**, with zero remaining static/dynamic/CSS inbound edges and preserved behavior coverage. A newly discovered helper expands that reviewed allowlist before deletion; it is not automatically in scope. Never delete a shared decision helper merely because the board once imported it.

**Touch:** `src/client/components/Onboarding.tsx`, `src/client/onboarding-feature-flags.ts`, `src/client/components/onboarding/BatchWorkspace.tsx`, `src/client/components/onboarding/WorkStateTabs.tsx`, `src/client/components/onboarding/batch-workspace-logic.ts`, shell/flag tests, ADR/runbook as needed to retire diagnostic flag/fallback documentation. Preserve BatchWorkspace itself and every frozen operation view. Remove the temporary work-state-primary navigation branch once the fallback release is archived; retain needed secondary operation navigation/helpers. After that removal, `shellV2Enabled=false` is an emergency **disabled-content state inside BatchWorkspace** (header + clear rollback instruction, no brand/strip/old navigation), not a permanent competing primary shell. To restore classic navigation after Slice 7, serve the archived matching bridge client; do not resurrect PipelineBoard. The §7.1 final-phase matrix pins this change.

**Acceptance:** one shell; no PipelineBoard file, mount or implicit fallback; no permanent competing primary navigation. Production static/dynamic/re-export/glob/CSS import-graph scan and its self-tests pass before and after deletion, the final-phase exhaustive flag/URL matrix passes, and every deleted helper/style/test path is on the reviewed export/coverage allowlist. Current raw execution detail and all 36 stage/status categories remain observable through the stage view/strip. Full regression ladder passes or independently documented baseline failures are unchanged. Index remains untouched.

## 7. Flag rollout, validation and reviewer evidence

### UI flags (only `src/client/onboarding-feature-flags.ts`)

| Flag | Initial/build rollout | Final disposition / rollback |
|---|---|---|
| `VITE_BATCH_WORKSPACE_ENABLED` | Default true; false never implies diagnostics fallback without explicit query | Slice 6 retires the disable branch; deprecated false is ignored so the sole shell always mounts |
| `VITE_PIPELINE_DIAGNOSTICS_ENABLED` | Existing true; effective only with explicit `?board=pipeline` | Default false at mount retirement, then remove after file deletion |
| `VITE_ONBOARDING_SHELL_V2` | Existing false; enable only with supported v2 reads | True after gates; false selects grace-period classic navigation within BatchWorkspace until Slice 7; then false shows disabled-content/rollback notice, never another shell |
| `VITE_BRAND_GATE_V2` | Existing false; effective only with shell flag | Independently disable during rollout; existing contextual/preflight actions remain |
| `VITE_EXECUTION_STRIP_V2` | Existing false; effective only with shell flag | Independently disable; no DB or worker behavior change |
| `VITE_REVIEW_UI_V2` | Existing true | Do not change its semantics/default in this rewrite |

Use existing kill-switch parser (`false|0|no`, whitespace/case normalization, empty→default) and test override/reset. Env flags are build-time cached, not a runtime server kill switch. Do not add server reads of `VITE_*`, do not enable sourcing/cohort/manual-evidence/model flags as part of rollout, and do not retain an execution-tail feature waiting to be accidentally enabled.

### 7.1 Explicit exhaustive flag/URL mount truth table (P0)

The following **factored truth tables are a complete specification**, not examples. Expand their Cartesian product into `src/tests/fixtures/onboarding-shell-matrix.json` and assert the rendered mount/destination/notice in `onboarding-linear-shell.test.tsx`. Inputs: `W`=workspace, `S`=shell-v2, `B`=brand gate, `E`=execution strip, `D`=diagnostics, `Q`=exact `board=pipeline` query, and `T`=one of the ten legacy-tab cases in Table C. There are **8 W/D/Q × 8 S/B/E × 10 T = 640 explicit cases per lifecycle phase** (pre-retirement, mounts-retired Slice 6, final Slice 7), 1,920 mount assertions total. Table A determines root; Table B applies only when that root is BatchWorkspace; Table C determines legacy destination only when content is enabled. Freeze the expected ledger independently of the production resolver; a test that computes both expected and actual with that resolver is invalid. All cases assume an authorized selected batch and available v2 reads; missing batch/unsupported API are additional fail-closed cases.

**Table A — root and notice; `*` here means each of the eight S/B/E rows and all ten T rows, not skipped tests.**

| W | D | Q | Before mount retirement (Slices 2–5b) | Mounts retired (Slice 6) | File deleted/final (Slice 7) |
|---|---|---|---|---|---|
| 0 | 0 | 0 | Unavailable; no board/shell features | BatchWorkspace | BatchWorkspace |
| 0 | 0 | 1 | Unavailable + diagnostics-disabled notice; no board | BatchWorkspace + retired-diagnostics notice | BatchWorkspace + retired-diagnostics notice |
| 0 | 1 | 0 | **Unavailable; no board** (no implicit fallback) | BatchWorkspace | BatchWorkspace |
| 0 | 1 | 1 | PipelineBoard only | BatchWorkspace + retired-diagnostics notice | BatchWorkspace + retired-diagnostics notice |
| 1 | 0 | 0 | BatchWorkspace | BatchWorkspace | BatchWorkspace |
| 1 | 0 | 1 | BatchWorkspace + diagnostics-disabled notice | BatchWorkspace + retired-diagnostics notice | BatchWorkspace + retired-diagnostics notice |
| 1 | 1 | 0 | BatchWorkspace | BatchWorkspace | BatchWorkspace |
| 1 | 1 | 1 | PipelineBoard only | BatchWorkspace + retired-diagnostics notice | BatchWorkspace + retired-diagnostics notice |

When root is PipelineBoard/Unavailable, B/E mount counts are zero regardless of raw flags/T; a legacy tab does not secretly mount another shell. Diagnostics `Q` is evaluated before T. After Slice 6, D/W values are ignored as retired shell/diagnostics switches, not allowed to create a hidden mount.

**Table B — BatchWorkspace content/features for every S×B×E combination.** “Brand enabled” means the single brand view is available and mounts **only** on `view=brand-setup`; it is never added as a seventh stage. With a legacy T destination, brand view is not mounted regardless of availability. An enabled strip remains a shell element with honest batch-wide scope on an operation destination.

| S | B | E | Slices 2–6 content | Brand setup available | Strip mounted | Slice 7 content |
|---|---|---|---|---|---|---|
| 0 | 0 | 0 | Classic grace navigation in BatchWorkspace | No | No | BatchWorkspace disabled-content/rollback notice |
| 0 | 0 | 1 | Classic grace navigation in BatchWorkspace | No | No | BatchWorkspace disabled-content/rollback notice |
| 0 | 1 | 0 | Classic grace navigation in BatchWorkspace | **No** | No | BatchWorkspace disabled-content/rollback notice |
| 0 | 1 | 1 | Classic grace navigation in BatchWorkspace | **No** | No | BatchWorkspace disabled-content/rollback notice |
| 1 | 0 | 0 | Linear navigation in BatchWorkspace | No | No | Linear navigation |
| 1 | 0 | 1 | Linear navigation in BatchWorkspace | No | Yes | Linear navigation |
| 1 | 1 | 0 | Linear navigation in BatchWorkspace | Yes | No | Linear navigation |
| 1 | 1 | 1 | Linear navigation in BatchWorkspace | Yes | Yes | Linear navigation |

For Slice 7 S=0, no legacy/brand/strip operation content mounts; it is a kill-switch state, not classic navigation left permanently in the build. A diagnostics retirement notice from Table A still appears. Tests additionally select `view=brand-setup` for all eight rows: S=0 or B=0 => no BrandGateView (disabled-view notice and safe shell destination); S=1,B=1 => exactly one BrandGateView, no seventh stage. Conflicting explicit stage/view/legacy-tab selectors are rejected as unsupported navigation rather than guessed.

**Table C — legacy `?tab=` destination (for enabled BatchWorkspace content; no stage inferred from category).**

| T | Linear content destination | Classic grace destination |
|---|---|---|
| absent | Stage 1 Check source options, server-filtered stage list | Existing Needs Attention destination |
| `needs_attention` | Entire-batch AttentionQueueView | Same preserved operation |
| `processing` | Entire-batch ProcessingView | Same preserved operation |
| `waiting_on_family` | Entire-batch FamilyWaitingView | Same preserved operation |
| `review` | Entire-batch ReviewWorkspace; its own queue/filters, no inherited shell filter | Same preserved operation |
| `approved` | Entire-batch ApprovedView | Same preserved operation |
| `ready_to_export` | Entire-batch ReadyToExportView, completed excluded | Same preserved operation |
| `completed` | OutcomeItemsView filtered `category=completed`, no export action | Same truthful outcome results |
| `skipped` | OutcomeItemsView filtered `category=skipped`, **never Approved** | Same truthful outcome results |
| invalid/unknown tab | Unsupported-link notice + safe default Stage 1; no mutation | Unsupported-link notice + default Needs Attention |

For each case, reset overrides, reset/isolate module cache, stub build env **before** import, create a fresh URL/history and unmount/restore after assertion. Run parser truth tables for `false|0|no` including case/whitespace, absent/empty defaults, and override/reset; opposite-order runs must yield the same mounts. `VITE_REVIEW_UI_V2` is unchanged and tested separately for noninterference (no shell flag may flip it). The raw-stage Review list unreviewed/reviewed/not_ready facets are separately tested from the intentionally whole-batch legacy `?tab=review` destination.

**P0 acceptance in Slices 2/6/7:** each applicable 640-case phase is collected/executed, the published expectation ledger matches these tables, and mandatory edges pass: shell-OFF+brand-ON => no brand view; workspace-OFF+diagnostics-ON without query => no board; post-retirement diagnostics URL => shell + notice. Pairwise-only tests or per-flag getter tests do not satisfy this matrix.

### 7.2 Exact Slice 0/per-slice baseline, scoped diff and log evidence

These are **future validation/evidence commands, not executed by this planning task**. Run from the repo root in an offline fixture-safe environment. Before the first writer, choose an exclusive private external directory:

```sh
umask 077
EVIDENCE="$(mktemp -d /tmp/baystate-onboarding-rewrite-slice0.XXXXXX)"
mkdir "$EVIDENCE/before" "$EVIDENCE/after"
cp CONTEXT.md "$EVIDENCE/before/CONTEXT.md"
cp src/onboarding/job-queue.ts "$EVIDENCE/before/job-queue.ts"
```

Run the following capture block with `SNAPSHOT=before` before editing and `SNAPSHOT=after` afterward. Preserve the original evidence root between blocks; never regenerate the before files from HEAD. Both HEAD and dirty input hashes matter. **Before running the hash pipeline lines**, inspect the captured path/deletion manifests and tracked/untracked symlink identities; if a path can resolve to a live DB, ignored credential file or external secret directory, stop at manifest capture and obtain a reviewed safe regular-file list. Do not execute the unfiltered hashing pipeline on such a tree. All outputs remain private external evidence; no file enters the Git index.

```sh
SNAPSHOT=before
git rev-parse HEAD > "$EVIDENCE/$SNAPSHOT/outer.head"
git -C storage/catalog rev-parse HEAD > "$EVIDENCE/$SNAPSHOT/catalog.head"
git status --porcelain=v1 --untracked-files=all > "$EVIDENCE/$SNAPSHOT/outer.status"
git -C storage/catalog status --porcelain=v1 --untracked-files=all > "$EVIDENCE/$SNAPSHOT/catalog.status"
git diff --name-only > "$EVIDENCE/$SNAPSHOT/outer.changed-paths"
git -C storage/catalog diff --name-only > "$EVIDENCE/$SNAPSHOT/catalog.changed-paths"
git diff --cached --name-only > "$EVIDENCE/$SNAPSHOT/outer.staged-paths"
git -C storage/catalog diff --cached --name-only > "$EVIDENCE/$SNAPSHOT/catalog.staged-paths"
git diff --binary > "$EVIDENCE/$SNAPSHOT/outer.patch"
git -C storage/catalog diff --binary > "$EVIDENCE/$SNAPSHOT/catalog.patch"
git ls-files -z --cached --others --exclude-standard > "$EVIDENCE/$SNAPSHOT/outer.paths.zlist"
git -C storage/catalog ls-files -z --cached --others --exclude-standard > "$EVIDENCE/$SNAPSHOT/catalog.paths.zlist"
git ls-files --deleted > "$EVIDENCE/$SNAPSHOT/outer.deleted-paths"
git -C storage/catalog ls-files --deleted > "$EVIDENCE/$SNAPSHOT/catalog.deleted-paths"
git ls-files -z --cached --others --exclude-standard | xargs -0 shasum -a 256 > "$EVIDENCE/$SNAPSHOT/outer.files.sha256" 2> "$EVIDENCE/$SNAPSHOT/outer.hash-errors"
printf '%s\n' "$?" > "$EVIDENCE/$SNAPSHOT/outer.hash-exit"
(cd storage/catalog && git ls-files -z --cached --others --exclude-standard | xargs -0 shasum -a 256) > "$EVIDENCE/$SNAPSHOT/catalog.files.sha256" 2> "$EVIDENCE/$SNAPSHOT/catalog.hash-errors"
printf '%s\n' "$?" > "$EVIDENCE/$SNAPSHOT/catalog.hash-exit"
shasum -a 256 CONTEXT.md src/onboarding/job-queue.ts src/client/onboarding-feature-flags.ts src/onboarding/flags.ts src/tests/unit/onboarding-feature-flags.test.ts src/tests/unit/onboarding-server-flags.test.ts package.json vitest.config.ts scripts/verify.sh .github/workflows/ci.yml docs/adr/0034-onboarding-rename-and-shell-rewrite.md docs/plans/onboarding-frontend-rewrite-plan.md > "$EVIDENCE/$SNAPSHOT/slice0-targets.sha256"
git diff --check > "$EVIDENCE/$SNAPSHOT/diff-check.log" 2>&1
printf '%s\n' "$?" > "$EVIDENCE/$SNAPSHOT/diff-check.exit"
git diff -- CONTEXT.md src/onboarding/job-queue.ts > "$EVIDENCE/$SNAPSHOT/doc-sites-vs-head.patch"
```

Hash failures must be reconciled against the captured pre-existing deletion/symlink manifest; any new unreadable/unknown path blocks the writer. Record symlink identity/target separately and do not follow a link to a live DB or external secret directory. No DB files, ignored credential files or live storage contents are added to the allowlist by these commands; skip unsafe entries with an explicit reviewed reason, never a silent successful hash. Before/after manifests prove absent/new/deleted paths as well as hashes. Compare outer/catalog statuses and `diff -u` the two `*.files.sha256` files against the exact slice allowlist; **both staged-path files must remain empty**. For a new planned file, record its initial absence, then its after hash.

D5's scoped dirty-baseline comparisons after editing:

```sh
git diff --no-index -- "$EVIDENCE/before/CONTEXT.md" CONTEXT.md > "$EVIDENCE/after/CONTEXT-vs-dirty-baseline.patch"
printf '%s\n' "$?" > "$EVIDENCE/after/CONTEXT-diff.exit"
git diff --no-index -- "$EVIDENCE/before/job-queue.ts" src/onboarding/job-queue.ts > "$EVIDENCE/after/job-queue-vs-dirty-baseline.patch"
printf '%s\n' "$?" > "$EVIDENCE/after/job-queue-diff.exit"
diff -u "$EVIDENCE/before/outer.files.sha256" "$EVIDENCE/after/outer.files.sha256" > "$EVIDENCE/after/outer-hash-delta.patch"
diff -u "$EVIDENCE/before/catalog.files.sha256" "$EVIDENCE/after/catalog.files.sha256" > "$EVIDENCE/after/catalog-hash-delta.patch"
```

`git diff --no-index`/`diff` exit 1 means a recorded difference, not validation failure by itself. Reviewer must verify exactly one CONTEXT bullet change and only the worker class comment; compare TypeScript runtime token/AST content with comments removed against the saved dirty baseline and retain the comparison result. No token/string/statement change is permissible for D5. Do not use a broad HEAD diff to attribute someone else's existing work to this slice.

Capture baseline and after validation with identical commands/environment, using `RUN=baseline` then `RUN=after` (the new guard runs after its Slice 0 file exists):

```sh
RUN=baseline
bun run typecheck > "$EVIDENCE/$RUN-typecheck.log" 2>&1
printf '%s\n' "$?" > "$EVIDENCE/$RUN-typecheck.exit"
bun node_modules/vitest/vitest.mjs run src/tests/unit/onboarding-feature-flags.test.ts src/tests/unit/onboarding-server-flags.test.ts --reporter=json --outputFile="$EVIDENCE/$RUN-flags.json" > "$EVIDENCE/$RUN-flags.log" 2>&1
printf '%s\n' "$?" > "$EVIDENCE/$RUN-flags.exit"
```

After creating the guard/self-test, also run `bun run test:runner-coverage > "$EVIDENCE/after-runner-guard.log" 2>&1` and record its actual exit immediately, then `bun node_modules/vitest/vitest.mjs run src/tests/unit/test-runner-coverage.test.ts --reporter=json --outputFile="$EVIDENCE/after-runner-self-test.json" > "$EVIDENCE/after-runner-self-test.log" 2>&1` and record its exit. For each subsequent slice, capture the exact §7.3 command's full stdout/stderr and immediate exit in the same way; preserve Bun's executed-file/test totals and Vitest's JSON counts. Never pipe a test through `tee`/a summary without preserving the test's own status. The packet contains a failure ledger keyed by test/file/message, `baseline-existing` vs `new`, selected/collected/passed/failed/skipped counts and log paths; zero collected or silently skipped required cases is a failure. A baseline failure is documented, not automatically waived or repaired out of scope. No `git add`, commit, reset or restore appears in this procedure.

### 7.3 Validation commands for the implementer (NOT run by this planning task)

Run locally with dependencies already present, offline and with isolated DB fixtures. Save full logs outside the repo; report exit status, selected test count and failures. Never allow `bunx` to fetch dependencies: use installed binaries.

- `bun run typecheck`
- `bun run build`
- `bun node_modules/vitest/vitest.mjs run <explicit pure/UI test files from the slice>`
- `bun test --timeout 30000 <explicit Bun DB test files from the slice>`
- `bun scripts/audit-onboarding-stage-vocabulary.ts --check docs/plans/onboarding-stage-vocabulary-inventory.md` (after the planned audit tool exists)
- `bun node_modules/eslint/bin/eslint.js <explicit changed .ts/.tsx files>`
- Final ladder: `bun run test`, `bun run test:db`, and `bun run lint` after verifying the current script works. Do not broaden the task to package/lint cleanup if a baseline script is broken.
- `git diff --check`; `git diff --name-only`; `git diff --cached --name-only`; `git status --porcelain=v1 --untracked-files=all` and the corresponding `git -C storage/catalog ...` checks. Expected staged-path output is empty. Compare protected hashes with the per-slice baseline; do not “fix” dirt by reset/restore.
- **Automated artifact gate, not a manual/TBD step:** build with the exact §5.6 packaging command during Slice 5a and invoke `ONBOARDING_BRIDGE_MANIFEST="$BRIDGE_ROOT/bridge-manifest.json" bun test --timeout 120000 src/tests/unit/onboarding-stage-rollback-bridge.test.ts`. The checked-in test launches the emitted child with the exact §5.6 argv/env and validates post-DB effects. On Slice 5b+, provision and verify the frozen bridge manifest first; missing input is a failure, never a skip/rebuild of current code. No invocation defaults to a live DB.
- CI/pre-Vitest guard: `bun run test:runner-coverage`. Retirement graph: `bun scripts/audit-onboarding-shell-imports.ts --check docs/plans/onboarding-shell-retirement-inventory.md` (after its Slice 6 files exist).

Concrete targeted commands (run after the corresponding files exist; do not substitute Vitest for a Bun DB suite):

| Slice | Exact targeted command |
|---|---|
| 0 | `bun run test:runner-coverage` then `bun node_modules/vitest/vitest.mjs run src/tests/unit/test-runner-coverage.test.ts src/tests/unit/onboarding-feature-flags.test.ts src/tests/unit/onboarding-server-flags.test.ts` |
| 1 pure | `bun node_modules/vitest/vitest.mjs run src/tests/unit/onboarding-stage-vocabulary.test.ts src/tests/unit/onboarding-stage-read-schema.test.ts src/tests/unit/onboarding-stage-audit.test.ts` |
| 1 DB | `bun test --timeout 30000 src/tests/unit/onboarding-stage-read-routes.test.ts src/tests/unit/onboarding-stage-read-query-plan.test.ts src/tests/unit/onboarding-work-state-query-plan.test.ts src/tests/unit/onboarding-work-routes.test.ts` |
| 2 UI | `bun node_modules/vitest/vitest.mjs run src/tests/unit/onboarding-linear-shell.test.tsx src/tests/unit/onboarding-stage-items.test.tsx src/tests/unit/onboarding-preparation-schema.test.ts src/tests/unit/onboarding-prepare-listing.test.tsx src/tests/unit/batch-workspace-logic.test.ts src/tests/unit/review-workspace-loading.test.tsx src/tests/unit/review-workspace-challenger-stress.test.tsx src/tests/unit/onboarding-ui-idempotency.test.ts` |
| 2 preparation DB | `bun test --timeout 30000 src/tests/unit/onboarding-preparation-read.test.ts src/tests/unit/onboarding-stage-read-query-plan.test.ts` |
| 3 UI | `bun node_modules/vitest/vitest.mjs run src/tests/unit/onboarding-brand-gate.test.tsx src/tests/unit/onboarding-brand-gate-logic.test.ts src/tests/unit/batch-preflight-modal.test.tsx` |
| 3 DB | `bun test --timeout 30000 src/tests/unit/batch-preflight-lifecycle.test.ts src/tests/unit/brand-authority-gate.test.ts src/tests/unit/brand-assign-routes.test.ts src/tests/unit/brand-domain-setup.test.ts src/tests/unit/distributor-record-materializer.test.ts src/tests/unit/sourcing-default-on-e2e.test.ts` |
| 4 UI | `bun node_modules/vitest/vitest.mjs run src/tests/unit/onboarding-live-activity.test.ts src/tests/unit/onboarding-execution-strip.test.tsx` |
| 4 route | `bun test --timeout 30000 src/tests/unit/onboarding-sse-versioning.test.ts src/tests/unit/onboarding-telemetry.test.ts` |
| 5a source proofs | `bun test --timeout 30000 src/tests/unit/onboarding-stage-migration.test.ts src/tests/unit/onboarding-stage-history-compat.test.ts src/tests/unit/onboarding-stage-queued-continuation.test.ts` |
| 5a and 5b emitted bridge (**required**) | `ONBOARDING_BRIDGE_MANIFEST="$BRIDGE_ROOT/bridge-manifest.json" bun test --timeout 120000 src/tests/unit/onboarding-stage-rollback-bridge.test.ts` |
| 5b API | `bun test --timeout 30000 src/tests/unit/onboarding-stage-api-compat.test.ts` |
| 5 regression, part 1 | `bun test --timeout 30000 src/tests/unit/db-migration.test.ts src/tests/unit/onboarding-repos.test.ts src/tests/unit/onboarding-operation-idempotency.test.ts src/tests/unit/onboarding-review-state.test.ts src/tests/unit/onboarding-automation.test.ts` |
| 5 regression, part 2 | `bun test --timeout 30000 src/tests/unit/sourcing-stage-order.test.ts src/tests/unit/sourcing-policy.test.ts src/tests/unit/cohort-worker.test.ts src/tests/unit/cohort-freeze.test.ts src/tests/unit/durable-approval-promote.test.ts src/tests/unit/draft-promoter.test.ts` |
| 6–7 | `bun scripts/audit-onboarding-shell-imports.ts --check docs/plans/onboarding-shell-retirement-inventory.md` then `bun node_modules/vitest/vitest.mjs run src/tests/unit/onboarding-shell-imports.test.ts src/tests/unit/onboarding-linear-shell.test.tsx src/tests/unit/onboarding-feature-flags.test.ts src/tests/unit/batch-workspace-logic.test.ts` plus the final ladder above |

No live migration command is included as an executable approval here. A future operational command must name its DB/backup/expected identity explicitly and pass the maintenance gate.

### Mandatory reviewer packet per slice

- Exact changed/new/deleted file list, scoped diff, out-of-scope hash comparison, unstaged-index evidence for both repositories.
- Test files added/updated, commands, full log locations, exit codes and selected/collected/executed/skipped counts; list baseline failures separately from new failures. For every Bun file show **both** its explicit package test:db entry and Vitest exclude, plus pre-Vitest CI runner-guard output. Include inventory-checker synthetic fixture results, finite seeded oracle/query-counter evidence and each applicable 640-case mount matrix log.
- API v1/v2 fixture examples with redacted data; count/filter/cursor parity and query budgets.
- For rename slices: classified literal/SQL/DDL/JSON inventory, per-row matrix/digest comparison, immutable-byte/hash evidence, every injected transaction-failure checkpoint, same-process metadata-flip test, queue continuation traces, pinned bridge entries/build/runtime/checksums and the checked-in Bun spawned-artifact rehearsal with independent post-DB assertions. Source-only/manual bridge evidence is insufficient.
- Supplemental local no-network UI walkthrough: label/accessibility/focus checks for initial/reconnect stale states, supplier-only mixed batch, domain/profile exception, variant/manual-evidence/conflict panels, waiting family, sequential review, failed save/conflict, review invalidation, approval without export, receipt retry, Completed and Skipped paths. **Automated** seeded parity, clock/EventSource race/teardown/cap tests and exhaustive flag combinations remain the gates; walkthroughs cannot substitute. At retirement include static+dynamic+CSS import graphs and exact approved deletion/export/coverage ledger.
- Reviewer gate is required. A missing bridge proof, unclassified stage literal, changed receipt bytes, broken frozen workflow or newly widened authority is a blocker, not a documented “minor risk.”

## 8. ADR 0034 outline

1. **Status/decision scope:** conditional acceptance; vocabulary and deployment gates explicit; cite council memo as superseding conflicting draft details.
2. **Partial supersession of ADR 0016:** linear six-stage primary navigation and actual machine-vocabulary rename supersede its navigation/unchanged-enum decisions. Enumerate all retained behavioral guarantees: server projection, durable review independent of stage, invalidation, auth, idempotency/receipts, separate review/approval/export, verified export completion, automation and cohort safety.
3. **Rename table and boundaries:** approved old↔new bijection, including `route_sources` / Check source options; unchanged statuses/order/transitions; stage-vs-activity/source/route distinctions; Step 0 excluded. Official URL is the principal UX extraction path, distributor evidence a secondary strategy/qualified fast path. Supersede supplier-first **presentation language**, not the existing engine scheduling/qualification guarantees.
4. **One BatchWorkspace shell:** incremental strangulation and exact PipelineBoard retirement sequence; preserved operation surfaces and narrow rename-only freeze exception. Prepare listing remains one internally sectioned stage view (OCR evidence, cohort state, names, type, fields), with canonical states and explicit stage/family/full-batch scope; no additional execution stages or editable review authority.
5. **Step 0:** one view, domain health above per-item fixes, existing authority/controlled-release flows; qualified distributor exemption; no new batch barrier/source policy.
6. **Execution strip/read contract:** server counts/filter parity, projection freshness, explicitly ephemeral sanitized receipt-time activity; no durable tail/heartbeat/worker-health claims.
7. **Compatibility:** v1/v2 API/SSE adapters, dual-read plus transactional backfill, versioned immutable-format interpretation, legacy defaults/old migration ordering, pinned bridge rollback and quiescence.
8. **Alternatives rejected:** labels-only final implementation; seventh stage; new permanent shell; client-side page filtering; work-state→stage inference; durable event-history project; backup-only rollback; publishing implied by approval.
9. **Rollout/acceptance:** UI flags, separate operational migration approval, required regression/rollback evidence, decommission deadline.
10. **Documentation reconciliation:** only the two D5 explanatory sites in CONTEXT/job-queue. Do not rewrite the already-correct Stage Advancement paragraph or perform a broad glossary cleanup in this tranche; the ADR contains the authoritative vocabulary/supersession table.

## Appendix A. Full-inventory gate and verified file-level seed inventory

The inventory is an implementation deliverable, not a promise that a quoted-string grep is exhaustive. It must include quoted strings, template literals/SQL, unquoted property keys (`STAGES`, stage distributions), schemas/defaults/CHECKs, generic `.stage` readers, dynamic construction, serialized JSON, tests, scripts and persisted DDL. Each match gets file/line, role, format version, chosen treatment, downstream consumer and test. No unclassified hit may remain at Slice 5 activation. Re-run after each slice because this is a dirty, evolving worktree.

### Operational stage sites: exact inspected candidate paths

| Area | Files / mandatory coverage |
|---|---|
| Shared contracts | `src/shared/schemas/onboarding.ts`: PipelineStageEnum, item schemas, batch stage distribution, sourcing decision target variants; `src/shared/schemas/onboarding-work-state.ts`: stage field and v1 contract; `src/shared/schemas/onboarding-review-queue.ts`: verify no accidental review-state/cursor change |
| Item lifecycle | `src/db/repositories/onboarding-item-repo.ts`: STAGE_ORDER; **line 235 `stage: (row.stage || 'sourcing') as PipelineStage`** is an operational fail-open fallback to replace with version-aware validation (null/empty/unknown are not a first-stage default); adjacent **line 236 `stageStatus: (row.stage_status || 'pending') as StageStatus`** is separately inventoried to prove status semantics/legacy interpretation are not accidentally renamed; all inserts/default selection, chunk/staged reads, advance/reverse/reset/claim/stale-claim paths, `resetItemsToStage`, `SOURCING_COMPLETION_TARGETS` **values**, sourcing decision validation, review/promotion completion |
| Batch and review | `src/db/repositories/onboarding-batch-repo.ts`: derived distribution, completed counts, archival predicate; `src/db/repositories/onboarding-review-repo.ts`: raw SQL review/promotion guards, write encodings and legacy rejection strings; `src/db/repositories/onboarding-conflict-repo.ts`: post-conflict stage transitions |
| Cohort and observers | `src/db/repositories/classification-cohort-run-repo.ts`: all stage predicates/leases; `src/db/repositories/curation-cohort-repo.ts`: generic row stage transport vs immutable extraction hashes; `src/db/repositories/store-manager-source-observer-repo.ts`: raw stage projection and downstream event comparison |
| Execution | `src/onboarding/job-queue.ts`, `src/onboarding/auto-advance.ts`, `src/onboarding/domain-release.ts`, `src/onboarding/curation-cohort-service.ts`, `src/onboarding/cohort-curator.ts`, `src/onboarding/product-curator.ts`, `src/onboarding/draft-promoter.ts`: compare/dispatch/emit/write boundaries only |
| Sourcing | `src/onboarding/sourcing/entry-policy.ts`; `src/onboarding/sourcing/distributor-record-materializer.ts`; all consumers of decision targets reached from the inventory. Decision route IDs/immutable v2 target bytes are separate from runtime target stages |
| Exceptions/newer evidence paths | `src/onboarding/variant-selection-service.ts`, `src/onboarding/manual-evidence-service.ts`, `src/onboarding/manual-evidence-eligibility.ts`, `src/onboarding/brand-domain-blockers.ts`, `src/onboarding/extraction/profile-blockers.ts`: stage guards and query encodings, not authority/eligibility policies |
| Projection/metrics | `src/onboarding/onboarding-work-state.ts`, `src/onboarding/onboarding-review-queue.ts`, `src/onboarding/onboarding-telemetry.ts`: runtime stage guards, preserve category/review/metric semantics; `src/db/repositories/onboarding-work-state-repo.ts` for shared read context, not classification-stage renaming |
| Server | `src/server/routes/onboarding-routes.ts`: duplicate orders/validStages, reset/advance/import/staged/count/item endpoints and SSE; `src/server/routes/onboarding-work-routes.ts`: narrow approved stage-only exception; `src/server/routes/profile-activation-routes.ts`: stage-specific requeue guard; `src/server/services/store-manager-trigger-service.ts`: semantic stage comparisons; `src/server/app.ts`: version/read route mounting |
| Client | `src/client/onboarding-api.ts`, `src/client/onboarding-work-api.ts`; `src/client/components/PipelineBoard.tsx`: STAGES/keys/guards until deletion; `src/client/components/WeeklyReportPanel.tsx`: stage distribution order; `src/client/components/onboarding/BatchWorkspace.tsx`, `batch-workspace-logic.ts`: distinguish old tab IDs from stage values; `src/client/components/onboarding/families/FamilyInspectorDrawer.tsx`: display incoming stage via version-aware boundary if necessary |
| DDL/migration history | `src/db/migrations.ts`; `src/db/stage-pipeline-migration.sql`; `src/db/onboarding-migration.sql`; `src/db/schema.sql`: classify historical literals/defaults vs current writers and schema prerequisites. No blind migration-file replacement |
| Offline/administrative scripts | `scripts/benchmark-onboarding-work-state.ts`, `scripts/unblock-sourcing-conflicts.ts`, `scripts/repair-system-auto-accept.ts`: stage reads/writes must use known versions or refuse v2 DBs. Do not run repair scripts. Other script hits must be classified before allowance |

### Known non-stage/immutable hits: preserve unless inventory proves otherwise

- WorkActivity values/order/labels in `src/client/components/onboarding/processing/processing-logic.ts`, `ProcessingStatus.tsx` and `onboarding-work-state.ts` are independent activities, not STAGE_ORDER. The old draft's proposal to deduplicate ACTIVITY_ORDER into stage order was incorrect.
- Review navigation/state words in `src/client/App.tsx`, `src/client/components/OnboardingSettings.tsx`, `src/client/components/onboarding-settings/tabRegistry.ts` are not automatically stage identifiers.
- Model-operation/capability values in `src/client/components/AiComputePanel.tsx`, `src/client/components/common/AiRouteSummary.tsx`, `src/db/repositories/provider-connection-repo.ts`, `src/onboarding/llm-client.ts`, `src/classification/flags.ts`, `src/classification/confidence-calibrator.ts` must not be globally renamed.
- Classification's distinct stage names and recorded snapshots: `src/classification/model-operation-registry.ts`, `runtime-snapshot.ts`, `effective-curation-type.ts`, `cohort-page-coordinator.ts`, `index.ts`, `evidence-targeting.ts`, `stages/value-gap-abstain.ts`, `stages/packaging-ocr-stage.ts`; `src/onboarding/cloud-vlm-client.ts`, `packaging-ocr.ts`; `src/db/repositories/packaging-ocr-shadow-repo.ts`, `classification-model-call-repo.ts`. Generic `stage` here is not necessarily an onboarding stage.
- `src/onboarding/sourcing/html-scraper/session-runner.ts` and `scripts/build-page-role-proposals.ts` contain word collisions; classify by role rather than replacing.
- Source types `official_page`/`distributor_record`, method versions, `onboarding_discovery_runs`, extraction/curation table names, ReviewState and WorkStateCategory strings, operation IDs, receipt details/request hashes, evidence and cohort/source hashes stay intact.
- Test inventory includes both current-runtime assertions to update and immutable v1 fixtures to retain. Particularly preserve original fixtures in `hash-stability-characterization.test.ts`, review/operation-receipt/sourcing/variant/cohort migration suites; add v2 counterparts and comparison tests instead of automatic snapshot replacement.

## 9. Residual risks and stop conditions

- **Inventory completeness:** SQL/templates/generic readers and newer manual-evidence paths can bypass obvious enum checks. Static classification plus fixture/bridge proof is mandatory; missing sources/scout reports remain an evidence limitation.
- **Legacy upgrade ordering:** historical operator-state and sourcing repairs may not be cleanly separable on every old DB. Block deployment if prerequisites/history preservation cannot be demonstrated; do not widen this rewrite into repair.
- **Legacy SQL default:** intentionally retained for compatibility without table rebuild. All sanctioned writers must pass an explicit encoded stage, and activation must detect unexpected legacy writes. Strict v2-only DB constraints are deferred.
- **Downtime/space:** real DB size, WAL volume, in-flight workers and secondary writers are unknown in planning. A batch pause alone does not establish quiescence. Failed backup/lock/identity proof blocks migration.
- **Mixed deployment:** old cached clients are covered by v1 transport, but unmodified pre-bridge workers/binaries are unsafe on v2 storage. Pin every writer artifact; do not delete compatibility adapters prematurely.
- **Ephemeral gaps:** historical live activity cannot be recovered; stale projections and SSE loss must be visible. This v1 intentionally does not diagnose worker liveness or provide durable execution history.
- **Read cost:** summary derivation still scans the authorized batch; sparse pages can be empty. Benchmark bounded queries and update frequency without adding unapproved indexes or changing frozen review loading.
- **Frozen child scope:** existing operation views are full-batch, not stage-filterable. Explicitly label scope; stage-scoped review/attention rewrites are not silently included. Keep shell defaults truthful and do not manufacture “all reviewed” from stage counts.
- **Existing baseline issues:** dirty drafts/comments and possible test/lint/runner-registration failures must be attributed from the exact baseline logs/hashes, not cleaned up broadly or hidden by excluding required suites. No application tests were executed by this planning task.
- **Bridge provisioning:** fresh CI/native checkouts must receive the frozen reviewed bridge artifact locally; without it the emitted-artifact test must fail. A newly built current-native binary is not a rollback substitute. Bundled filesystem assets/external packages and Bun-version drift are real failure cases, explicitly checked by §5.6.
- **Budgets and instrumentation:** the published SQL/fetch budgets require v2 bulk access if existing hydration/cohort loops exceed them; preparation summaries must fit within the same chunk budget, not add N+1 queries. Partial legacy counters cannot prove compliance. Timing/cap defaults remain owner approval items and must be parameterized in deterministic tests.
- **Strategy terminology vs scheduling:** official-page-primary describes the owner's main extraction/UX flow. Existing distributor lookups/entry policy remain exactly as recorded; this plan cannot silently promise an official-first worker dispatch order or move items to fit the diagram. A behavioral priority change requires separate approval.
- **Preparation observability:** some historic runs lack section-level outcomes. Show unavailable/stale with lineage rather than fabricated completion; do not add new execution events/model calls to make the five sections look complete.

### Reviewer-finding closure map (plan edits, not an implementation pass)

| Review finding | Binding acceptance location |
|---|---|
| Tests P0: Bun execution/exclusion + CI assertion | §6.1 exact nine-file table, Slice 0 CI guard/self-test, each owning slice's dual-entry/collection gate |
| Tests P0: real automated bridge rollback, pinned artifact | §5.5–5.6 build/argv/env/manifest/runtime contract, Slice 5a/5b spawned-artifact acceptance, §7.3 exact command |
| Tests P0: inventory checker self-tests | Slice 1 actual-checker synthetic evasion/allowlist/exit-code tests; Slice 5 activation acceptance |
| Tests P0: explicit flag-combination matrix | §7.1 complete factored 1,920-case ledger and Slice 2/6/7 phase gates |
| Correctness P1: pushdown/chunks/query budget/cursor extension | §4.1 predicate split, no lookahead, total-SQL caps and separate v2 fingerprint/cursor version |
| Correctness P1: no storage-version cache | §5.2 per-transaction read + same-process flip/concurrent transaction tests |
| Correctness P1/P2: command inventory, limit divergence, fallback line | Slice 3 verified preflight test touch, §4.1 v1/v2 limits, Appendix A :235/:236 |
| Tests P1: finite seeded parity/adversarial/N+1 tests | Slice 1 deterministic builder/independent 36-cell oracle/covering set/attack payloads and full execution counters |
| Tests P1: deterministic SSE harness/parameterized budgets | §4.3 and Slice 4 EventSource injection/fake timers/deferred races/teardown/boundary cases; manual supplemental only |
| Tests P1: migration failure seam | §5.4a named checkpoints and second-connection rollback/writer-stop proof |
| Tests P1: brand fetch/error budgets | Slice 3 six-read epoch/one-page budget and empty≠healthy rendered matrix |
| Tests P1: unconditional Bun SSE and retirement graph/deletions | §6.1/Slice 4 runner gate; Slice 6–7 static/dynamic/glob/CSS self-tested graph plus export/coverage allowlist |
| Tests P2/requested P1: exact baseline diff/hash/log capture | §7.2 commands, dirty-baseline comment comparison and failure/count ledger; Slice 0 acceptance |
| Binding owner: official URL primary, distributor secondary | §2 `route_sources` candidate and source-triage/main-vs-alternate diagram; Slice 2 narrative/actual-work tests; unchanged routing invariant |
| Binding owner: curation granularity without more stages/views | Slice 2 five-section table, canonical state/read/query contracts, stage-vs-family/full-batch scope and new registered projection/view tests |

## 10. Explicit owner-approval checklist

### Final 6-stage vocabulary — approval required first

- [ ] Approve both machine values and labels: **`route_sources` / Check source options → `find_product_page` / Find product page → `collect_details` / Collect details → `prepare_listing` / Prepare listing → `review_listings` / Review listings → `create_drafts` / Create drafts**. If changed, approve one replacement bijection before code/fixtures/migration digests are finalized.
- [ ] Confirm **`route_sources` / Check source options** as the adjusted stage-1 candidate: automatic triage/routing, official product URL as the main extraction flow, supplier/distributor evidence secondary and a qualified fast path — not a compulsory supplier-first step and not an unapproved worker-priority change.
- [ ] Confirm this is an actual runtime/schema/persisted stage rename, not labels-only; statuses and transition semantics remain unchanged.
- [ ] Approve ADR 0034's explicit partial supersession of ADR 0016 navigation/vocabulary while retaining every behavioral guarantee.
- [ ] Confirm the recorded narrow D4 rename-only exception; all frozen operations and existing work-state read handlers otherwise remain untouched, with v1 request/receipt behavior preserved.
- [ ] Approve BatchWorkspace incremental strangulation, full-batch secondary operation scope, explicit diagnostics query-only interval, mount removal, and final PipelineBoard deletion deadline.
- [ ] Approve **one Prepare listing view, five internally sectioned concerns**: Packaging OCR evidence; Family/cohort grouping & readiness; Name curation; Product type assignment; Field classification (with distinct Page placement/draft-readiness sub-row). Stage lists/counts stay stage-scoped, complete family context can span stages, and existing review/attention/processing/family/approval/export operations remain explicitly full-batch and unchanged. No new execution stages or inline decision surface.
- [ ] Approve Step 0 **Brand setup** as one view, no execution stage/batch barrier/universal official-domain requirement; distributor bypass unchanged.
- [ ] Approve separate v2 stage/status read endpoints, exact-filter 6×6 counts and cursor versioning, while retaining legacy API/SSE representations.
- [ ] Approve ephemeral-only strip disclosure and proposed budgets: 15s refresh, 45s stale threshold, 400ms debounce with 2s maximum wait, 100 summaries, 160 characters, 16KiB frame cap; no tail/heartbeat/health/run-history project.
- [ ] Approve only the two D5 explanatory edits; no main Stage Advancement/glossary rewrite.
- [ ] Approve the dual-read/storage-version write design, immutable-format serializers, retained legacy DDL default with explicit writers, and **tested actual bridge binary** as the rollback path. Backup alone is not acceptance.
- [ ] Require independent reviewer approval of the classified inventory **and checker self-tests**, explicit per-Bun-file test:db/exclude/CI guard evidence, seeded matrix/query-budget proofs, parameterized EventSource race/teardown/cap tests, full flag/URL mount matrix, old-DB/history/queue/fault-injection proofs and **automated pinned emitted-bridge** rehearsal before default-on/decommission.
- [ ] Approve retired workspace/diagnostics flags being ignored after mount removal, and the final Slice 7 shell-OFF disabled-content state; classic rollback after deletion uses the archived compatible client, never a permanent second shell or PipelineBoard.
- [ ] Separately approve any future live maintenance window, verified backup/source identity, all-writer quiescence and explicit migration execution. **No such approval or execution is part of this plan-only tranche.**
