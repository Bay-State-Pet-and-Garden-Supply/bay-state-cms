# Onboarding Frontend Full Rewrite — Implementation-Ready Plan (no code)

> **SUPERSEDED (Slice 0):** the council memo (Pass 1 f3287394 / Pass 2 c36e504c) is binding. This draft is **not** implementation authority for tails/heartbeats/new shells, backup-only rollback, or final vocabulary. Binding direction lives in `docs/plans/onboarding-linear-rewrite-council-plan.md`. Preserved here for audit only.

- **Status:** PLAN ONLY — revised 2026-09-05 after dual-review BLOCK (P0 + 4×P1 fixed: server-flag layer, `app_meta` migration path, scoped grep gate, pinned Slice 3 contract, `WorkActivityEnum` frozen, Step 0 spike, `STAGE_ORDER` export step, decision-JSON policy, grace-retained board). Slice 0 implementation lands separately (ADR 0034 draft + CONTEXT fix + UI + server flags + tests).
- **Author role:** Planner subagent.
- **Date (UTC):** 2026-09-05.
- **Governing inputs read:** `CONTEXT.md` (Onboarding Pipeline glossary + Relationships, incl. lines 609–946 on Stage Advancement / automation supersession), `docs/plans/classification-system-implementation-plan.md` (M0–M11 + issue-17 addendum), ADRs `0007`, `0016`, `0017` (plus `0008`, `0013`, `0014` family referenced via code), `src/shared/schemas/onboarding.ts` (PipelineStageEnum ~:212, StageStatusEnum, SourceTypeEnum, batch/execution enums), `src/db/repositories/onboarding-item-repo.ts` (STAGE_ORDER :84 + claim/advance/reset paths), `src/onboarding/job-queue.ts` (`buildAutoStages`, `sweepAutoAdvance`, `sweepDomainReleases`, claim/dispatch), `src/onboarding/auto-advance.ts`, `src/onboarding/sse-emitter.ts`, `src/onboarding/onboarding-telemetry.ts`, `src/onboarding/onboarding-work-state.ts`, `src/shared/schemas/onboarding-work-state.ts`, `src/client/onboarding-feature-flags.ts`, `src/client/components/Onboarding.tsx`, `src/client/components/onboarding/BatchWorkspace.tsx`, `src/client/components/PipelineBoard.tsx` (headers), attention/review/approved/processing/preflight component inventory, `src/server/routes/onboarding-routes.ts` + `onboarding-work-routes.ts` route maps, `src/server/routes/health.ts`, batch repo `execution_state`.
- **Scout handoffs:** requested at `subagent-artifacts/outputs/166f42fa-…/{frontend-ui,backend-pipeline,runs-observability}.md` — **path does not exist** in this worktree (`ls subagent-artifacts` → no such directory; `/tmp/*.md` contains unrelated audits). Plan is therefore derived from **direct codebase reads** listed above, not from scout docs. Treat missing handoffs as an evidence gap (see Residual risks).
- **CONTEXT.md authority:** `CONTEXT.md` Onboarding Pipeline glossary is authoritative for terms. Where CONTEXT contradicts code, code behavior is documented as-is and CONTEXT is fixed by Slice 0 (never the reverse).

## 0. Locked decisions (operator grill — non-negotiable boundaries)

1. **Linear stages are the primary organizing principle.** The six-stage linear order is the operator model. Work-state categories (`processing / needs_attention / …`) remain a *derived projection*, never the primary navigation.
2. **FULL domain rename in code, not UI labels only.** Machine values (`PipelineStageEnum`, DB `stage` values, worker switch arms, SSE `stage`, work-state `stage`, staged/work-state endpoints, tests) are all renamed. A label-map-only change is explicitly rejected.
3. **Step 0 brand gate exists as a single view.** Domain-mapping health on top + per-item brand fixes below. It must unblock the Discovery authority gate (resolved `brandHint` + mapped official domain). It rehouses (not duplicates): `BrandAssignmentPanel`, `BrandDomainSetupPanel`, `SearchableBrandSelector`, preflight `assign-brand-group` / `configure-brand`, Settings brands-tab authority (ADR 0017).
4. **Execution strip shows both batch+stage status AND live SSE feed.** Batch/running-paused state, per-stage backlog (`pending / in_progress / failed / needs_input`), claimed age, last poll, pause/resume **plus** live `item:status` / `batch:progress`, profile-blocked, family-barrier, and failure events. Current gaps are in scope to fix: no `GET /runs`, ephemeral in-memory SSE (`src/onboarding/sse-emitter.ts`), `console.log`-only worker narration, trivial `/health`, telemetry derived-at-query with `not_available`s.
5. **Rewrite scope is the shell/tabs/monitoring ONLY.** `BatchWorkspace` + `PipelineBoard` divergence is replaced by one shell. **KEPT as-is (moved, not rewritten):** `ReviewWorkspace` (queue + inspector, Looks Good & Next, approve/export) and all attention panels (brand / domain / URL / variant / evidence / conflicts). No review-decision or promotion semantics change in this rewrite.
6. **CONTEXT.md staleness is fixed in this work.** "Stage Advancement … always manual" contradicts the worker's per-poll `sweepAutoAdvance` (epic #46 automation-owned happy path). Fix lands in Slice 0, before any UI copy is written.

## 1. Current-state inventory (verified, not assumed)

### 1.1 Stage authority (rename blast radius)

| Layer | File | Symbol / value |
|---|---|---|
| Shared enum | `src/shared/schemas/onboarding.ts:212` | `PipelineStageEnum = sourcing/discovery/extraction/curation/review/promotion` |
| Shared status | `src/shared/schemas/onboarding.ts:1126` | `StageStatusEnum = pending/in_progress/completed/failed/needs_input/skipped` |
| Repo order | `src/db/repositories/onboarding-item-repo.ts:84` | `STAGE_ORDER` (same six values) |
| Repo transitions | `src/db/repositories/onboarding-item-repo.ts` (~2262 lines) | `advanceItemsToNextStage`, `advanceReviewedItemsToPromotion`, `resetItemsToStage`, `sendItemsToPreviousStage`, `claimItemsForProcessing` (sourcing entry-policy guard), `getPendingItemsByStage`, `getStageCounts`, `listItemsByBatchStaged`, `updateItemStageStatus`, `completeReviewStage/completePromotionStage`, `setDiscoverySourceUrl`, `advanceDiscoveryToExtraction / advanceExtractionToCuration / advanceCurationToReview` helpers |
| Worker stages | `src/onboarding/job-queue.ts` | `buildAutoStages()` (sourcing gated by sourcing flags; else `curation/extraction/discovery`), `processItem` switch, cohort-exclusive curation leg, `holdWaitingFamilyMembers`, `dispatchCohortRun`, per-leg `processSourcing/processDiscovery/processExtraction/processCuration` |
| Auto-advance | `src/onboarding/auto-advance.ts` (201 lines) | `advanceDiscoveryItemToExtraction`, `advanceExtractionItemToCuration`, `advanceCurationItemToReview`, `sweepAutoAdvance` (called every 2 s poll) |
| Domain release | `src/onboarding/domain-release.ts` | `sweepDomainReleases` (profile-blocked → requeue when profile becomes usable) |
| Work-state projection | `src/onboarding/onboarding-work-state.ts` (1277 lines) | `buildBatchWorkStateContext`, `deriveItemWorkState` — passes `stage/stageStatus` through as secondary diagnostics; derives `category/attentionReason/attentionAction` |
| Work-state schema | `src/shared/schemas/onboarding-work-state.ts` | `OnboardingWorkStateSchema.stage: PipelineStageEnum`, `stageStatus: StageStatusEnum`, `AttentionReasonEnum`, `AttentionActionEnum`, `WorkStateCategoryEnum`, cursor/filter schemas |
| SSE | `src/onboarding/sse-emitter.ts` | in-memory `EventTarget`-equivalent `Map<batchId, handlers>`; event types `item:status/batch:progress/batch:complete/batch:error` with `data: {status, stage, …}` — **ephemeral, per-process, no history** |
| Client subscribe | `src/client/onboarding-work-api.ts:253–265` | `subscribeBatchEvents` → `new EventSource(`${API_BASE}/batches/${batchId}/events`)` (debounced count refresh, 400 ms) |
| Staged endpoint | `src/server/routes/onboarding-routes.ts:1004` | `GET /api/onboarding/batches/:id/staged` (Kanban grouping via `listItemsByBatchStaged`) |
| Work-state endpoints | `src/server/routes/onboarding-work-routes.ts` | `GET batches/:id/work-state`, `/counts`, `/items?cursor&limit`, `GET items/:id/work-state`, `GET review-queue`, `GET metrics`, `POST batches/:id/approve`, `POST batches/:id/create-export-drafts`, `POST domains/:domain/release` |
| Batch execution | `src/shared/schemas/onboarding.ts` (`BatchExecutionStateEnum = draft/ready/running/paused/completed`), `src/db/repositories/onboarding-batch-repo.ts` (`execution_state`, `updateBatchExecutionState`), routes `POST batches/:id/start|pause|resume` | worker claim requires `b.status='active' AND (execution_state='running' OR NULL)` |
| Flags | `src/client/onboarding-feature-flags.ts` | `batchWorkspaceEnabled` (default ON), `pipelineDiagnosticsEnabled` (default ON), `reviewUiV2` (default ON); `parseEnvFlag` kill-switch (`false|0|no` disables) |
| Shell | `src/client/components/Onboarding.tsx` (1067 lines) | batches list → `BatchWorkspace` (default) vs `PipelineBoard` (`?board=pipeline` diagnostics); upload modal; preflight modal wiring |
| Workspace | `src/client/components/onboarding/BatchWorkspace.tsx` (718 lines) | tabs `needs_attention/processing/waiting_on_family/review/approved/ready_to_export` + filtered-results table; **NOT stage-linear** — this is the divergence to replace |
| Diagnostics board | `src/client/components/PipelineBoard.tsx` (1478 lines) | six-stage Kanban, one batch at a time, per-column advance buttons — diagnostics-only per epic #46 |
| KEEP: review | `src/client/components/onboarding/review/ReviewWorkspace.tsx` (1270 lines) + `ReviewQueue/ReviewActions/ReviewListingPanel/ReviewClassificationPanel/ReviewPagesPanel/ReviewMediaPanel/ReviewReadinessPanel/ReviewConfirmStep/review-logic/review-readiness/review-editability` | queue + inspector, Looks Good & Next, approve/export — **do not rewrite** |
| KEEP: attention | `src/client/components/onboarding/attention/` (`AttentionQueueView/AttentionRow/BrandAssignmentPanel/BrandDomainSetupPanel/CandidateUrlPanel/ChooseVariantPanel/DomainBlockerPanel/ExtractorStatusPanel/ManualEvidencePanel/OfficialSiteResolutionWorkspace 842 lines/SemanticConflictPanel`) | **do not rewrite internals; rehouse only** |
| Brand authority | ADR 0017 + `src/onboarding/job-queue.ts:passesAuthorityGate/getOfficialDomainsForBrand`, `src/onboarding/domain-utils.ts`, `src/db/repositories/brand-site-repo.ts`, brand-domain-blocker projection + `GET batches/:id/brand-domain-setup`, `POST …/brand-domain-setup/:brand`, `POST items/:id/assign-brand|assign-domain`, preflight `assign-brand-group/configure-brand`, Settings Domain Configuration | Discovery authority gate: auto-accept requires resolved `brandHint` + `isOfficialDomainMatch(candidate, mapped domains)` |
| Health | `src/server/routes/health.ts` (13 lines) | trivial `{status:'ok', version, timestamp}` — no worker/queue/claim/SSE/projection health |
| Telemetry | `src/onboarding/onboarding-telemetry.ts` (615 lines) | derived-at-query; many `not_available` (resolution time, latency histograms, replay/conflict markers, payload sizes); honest but **not a live execution feed** |
| Tests (probe) | `src/tests/unit/` | `onboarding-work-state.test.ts`, `onboarding-work-routes.test.ts`, `onboarding-automation.test.ts`, `onboarding-feature-flags.test.ts`, `batch-workspace-logic.test.ts`, `onboarding-telemetry.test.ts`, `onboarding-approval-gates.test.ts`, `batch-preflight-*`, `onboarding-ui-idempotency.test.ts` — stage-string assertions live here and must be migrated with the rename |

### 1.2 CONTEXT staleness (exact)

- `CONTEXT.md:609–610` "Stage Advancement … Advancement is always manual — no item auto-transitions between stages. The worker only processes items within their current stage."
- `CONTEXT.md:762/782` repeat the always-manual model.
- `CONTEXT.md:946` + ADR 0016 already supersede it for the operator model ("automation owns progression … This supersedes the 'Advancement is always manual' wording"), but the **glossary entry itself was never rewritten**, so readers of §Stage Advancement get the wrong rule.
- Code truth: `job-queue.ts poll()` runs `sweepAutoAdvance` + `sweepDomainReleases` every poll (2 s) with SSE `autoAdvanced:true` events. Fix = rewrite the glossary entry to the automation-owned rule with the manual-decision reserve list (URL/profile exception, source-conflict, approval, export), and point the old wording at ADR 0016 §Supersession.

## 2. Plain-language rename proposal + migration impact

### 2.1 Candidate renames (machine values + UI labels together)

Operator requirement: full rename in code, so machine values change — not just display strings. Recommended candidate set (Option A). Two alternates are carried for the ADR decision; **only one lands**.

**Option A — recommended (verb-first, operator-plain):**

| # | Old machine value | New machine value | UI step label | What happens here (one line) |
|---|---|---|---|---|
| 0 | *(new)* | `brand_gate` | "0 · Fix brands" | Step 0 gate view (not a pipeline stage value on items; a workspace view over pre-Discovery blockers). See §3. |
| 1 | `sourcing` | `check_suppliers` | "1 · Check suppliers" | Distributor evidence lookup + reconcile + route (incl. qualified `distributor_record` skip). |
| 2 | `discovery` | `find_official_page` | "2 · Find official page" | Official-page search + authority-gated verification. |
| 3 | `extraction` | `pull_details` | "3 · Pull details" | Profile-gated page scrape OR distributor-record materialization (null URL). |
| 4 | `curation` | `clean_classify` | "4 · Clean up & classify" | Cohort-aware title/attribute/page synthesis. |
| 5 | `review` | `review_approve` | "5 · Review & approve" | Human QA gate (bulk approval path). |
| 6 | `promotion` | `create_drafts` | "6 · Create drafts" | CMS draft creation + page-directory link. |

**Option B (noun-light):** `gather_supply / locate_official / extract_evidence / refine_classify / human_review / publish_drafts`.
**Option C (minimal-diff):** keep `review` and `promotion` unchanged, rename only the four automation stages. **Not recommended** — leaves the confusing core (`sourcing/discovery/extraction/curation`) half-renamed and forces a second migration later.

Naming constraints enforced by this plan:
- Machine values: `snake_case`, ≤ 24 chars, stable sort prefix (`0–6` is display-only; machine order comes from a single `STAGE_ORDER` array, never lexicographic).
- `StageStatusEnum` (`pending/in_progress/completed/failed/needs_input/skipped`) is **unchanged** — statuses already read plainly; renaming them doubles migration risk for zero operator gain.
- Step 0 `brand_gate` is **not** an item `stage` value. Items never sit "in" brand_gate; the view aggregates `needs_attention` items whose `attentionReason ∈ {brand_not_provided, …}` + unmapped-brand Discovery holds + preflight brand groups. This avoids a 7th stage migration and keeps `STAGE_ORDER` length 6.

### 2.2 Migration impact (exhaustive file list)

The rename touches **every layer that names a stage**. No layer may keep old strings behind a label map after cutover (compat aliases exist only inside the migration window, Slice 4).

1. **Shared contracts (first):**
   - `src/shared/schemas/onboarding.ts` — `PipelineStageEnum` (6 values), `SourcingRouteEnum` targets (`target: 'extraction'|'discovery'|'sourcing'` literals inside `SourcingDecisionV2Schema` variants), `OnboardingItemSchema.stage`, comments naming stages.
   - `src/shared/schemas/onboarding-work-state.ts` — `OnboardingWorkStateSchema.stage` renamed; `WorkActivityEnum` UNCHANGED (activities `distributor_lookup/official_site_search/extraction/curation` etc. are already operator-plain and an independent work-state contract — per review, never rename enum values; stage→activity display differences via a mapping function only), `ExtractorProfileBlockerSampleSchema`/brand-blocker comments.
   - Any `StageStatusEnum`-adjacent helper that switches on stage (work-state projection reason tables).
2. **DB values + repos:**
   - `onboarding_items.stage` stored strings (all rows) — requires a **data migration** (see §6).
   - `src/db/repositories/onboarding-item-repo.ts` — `STAGE_ORDER`, `listItemsByBatchStaged` keys, `advanceItemsToNextStage` sourcing→`find_official_page` special-case, `sendItemsToPreviousStage` undo arms, `resetItemsToStage` param, `claimItemsForProcessing(stage)` callers, `getPendingItemsByStage`, `getStageCounts`, `advanceDiscoveryToExtraction / advanceExtractionToCuration / advanceCurationToReview` (rename or alias), cohort-run joins filtering on stage.
   - `src/db/migrations.ts` MONOLITH (`app_meta`-gated blocks, no `src/db/migrations/` directory) + sibling `*.sql` alongside current ones — M1 (execution tail) + M2 (stage backfill) as separate `app_meta` blocks with idempotency guards + `src/tests/unit/db-migration.test.ts` extension (receipt, re-run safety, count-audit). Never combined, never a new runner path.
   - `src/db/schema.sql` — CHECK constraints / comments naming stages, if any.
3. **Worker:**
   - `src/onboarding/job-queue.ts` — `buildAutoStages()` return values, `processItem` switch, curation cohort-exclusive gate (`stage === 'curation'` comparisons incl. `holdWaitingFamilyMembers`), `passesAuthorityGate` comments, log/SSE `stage` fields.
   - `src/onboarding/auto-advance.ts` — all three advance helpers + sweep result keys (`discoveryToExtraction` → new names), SSE payloads.
   - `src/onboarding/domain-release.ts` — extraction-stage filter + SSE payloads.
   - `src/onboarding/onboarding-work-state.ts` — stage-keyed reason tables, family-barrier stage checks, cohort readiness stage checks.
   - Cohort/curation/draft/review/telemetry services that branch on `item.stage` (`cohort-curator.ts:2211,3231,3265,3390`, `curation-cohort-service.ts:315`, `product-curator.ts:489`, `draft-promoter.ts:510,763,1124`, `onboarding-review-queue.ts:51-52`, `onboarding-telemetry.ts:243` `stage==='promotion'`, `classification-cohort-run-repo.ts:172,186,765,797`, `onboarding-review-repo.ts:362,518`, `store-manager-trigger-service.ts:302,326`, `stage-pipeline-migration.sql:15-30`, `migrations.ts:242-246,261,297`).
  - Duplicated stage order literals that Slice 4 must dedupe: `onboarding-routes.ts:1385` second `STAGE_ORDER`/`validStages`, `PipelineBoard.tsx:46` `STAGES`, `processing-logic.ts:42`, `WeeklyReportPanel.tsx:131`, `onboarding-routes.ts:1620,2113,2209`. Normative rule: Slice 4 scope = all `grep -rn` stage-literal hits in stage-typed positions (enum, STAGE_ORDER, comparisons/params/payload keys, staged/work-state keys); compat suite covers telemetry/review-queue/draft-promoter/migrations; `grep`-clean gate (scoped, see §11) enforces.
4. **SSE + endpoints:**
   - `src/onboarding/sse-emitter.ts` — `data.stage` values; event-type vocabulary unchanged (`item:status` etc.).
   - `src/server/routes/onboarding-routes.ts` — `GET batches/:id/staged` response keys, `POST items/advance|reset|reset-to-stage|move-to-previous` stage params, `GET batches/:id/events` payload docs, sourcing-resolve routes that name target stages.
   - `src/server/routes/onboarding-work-routes.ts` — work-state `stage` passthrough, review-queue stage filters, approve/export stage guards (`review/completed → promotion/pending` in `advanceReviewedItemsToPromotion`).
   - `src/client/onboarding-api.ts`, `src/client/onboarding-work-api.ts` — stage-typed params, filter shapes, SSE handling.
5. **Client:**
   - `src/client/components/PipelineBoard.tsx` — column keys/headers/advance buttons (deleted at cutover, but migrated first so diagnostics stay correct during the flag window).
   - New shell + Step 0 + execution strip (Slices 1–3) — written **directly in new values**; no old strings introduced.
   - `ReviewWorkspace` + attention panels — stage-string references inside kept components updated mechanically (no logic change).
6. **Tests:** every assertion on stage strings (`onboarding-work-state.test.ts`, `onboarding-automation.test.ts`, `onboarding-repos.test.ts`, `onboarding-work-routes.test.ts`, telemetry tests, batch-workspace-logic tests, variant/sourcing tests that assert target stages). Plan requires a **mechanical rename pass + targeted new tests** (see per-slice test requirements), never a snapshot auto-update without review.

## 3. Step 0 brand gate (single view)

**Route/tab:** first tab of the new shell, `step=0` (`"0 · Fix brands"`), always visible (not behind a filter). It is a **view over existing blockers**, not a new stage.

- **Top: domain-mapping health.** Brand→official-domain coverage for the batch: mapped ✓ / unmapped ✗; per-brand blocked-item counts; links into Settings Domain Configuration (authority stays in Settings; the gate never writes mappings except through the same `assign-domain`/`configure-brand` server paths). Provisional-label / retailer-denylist display is a Slice 2 spike question (no `provisional` column in `brand-site-repo.ts`, no denylist in `domain-utils.ts` — retailer filtering lives in `source-discovery.ts` via `retailer-domain-list`): do not make it acceptance criteria until the seam is cited.
- **Bottom: per-item brand fixes.** Queue of items blocked on brand: `attentionReason brand_not_provided` + Discovery-parked `no domain mapped for brand "X"` + preflight `missing_brand/ambiguous_brand/unrouted_brand` holds. Inline actions reuse existing server paths: `POST items/:id/assign-brand`, `POST batches/:id/bulk-brand`, `POST batches/:id/assign-brand-group`, `POST batches/:id/configure-brand`, `POST items/:id/assign-domain`, `GET batches/:id/brand-domain-setup`.
- **Unblock contract (Discovery authority gate):** an item leaves Step 0 when it has a non-blank resolved `brandHint` **and** that brand maps to ≥1 official domain (`getOfficialDomainsForBrand ≠ []`). Discovery auto-accept additionally requires `passesAuthorityGate` (candidate domain matches a mapped domain). The gate UI shows this two-conjunct state per item/brand (brand ✓/✗ · domain ✓/✗) so operators see *why* Discovery is still parked.
- **Rehouse, not duplicate:** `BrandAssignmentPanel.tsx`, `BrandDomainSetupPanel.tsx`, `SearchableBrandSelector.tsx`, preflight brand-group/configure-brand sections, and the Settings brands-tab authority move into the Step 0 view shell. Their server contracts are unchanged. No second brand-editing surface may remain in the old tabs after cutover.
- **Fail-closed invariants:** unknown/unmapped brand ⇒ never auto-accepted; bulk brand assign validates non-blank trimmed brand and batch membership server-side (existing `bulkAssignBrandToItems` semantics). Provisional / denylist gating stays a spike until sourced (see above).

## 4. Execution strip (batch+stage status + live feed)

Two halves, one strip, pinned above the stage tabs:

- **Left — batch + stage status (pollable, not SSE-derived):** batch `executionState` (`draft/ready/running/paused/completed`) + pause/resume buttons (existing `POST batches/:id/pause|resume|start`); per-stage backlog counts for the **new** six values (`pending/in_progress/failed/needs_input` per stage; `completed/skipped` collapsed); oldest `claimed_at` age for `in_progress` (stale-claim visibility, 5-min threshold); last successful poll timestamp; worker identity/concurrency display if exposed by the new `GET /runs` (Slice 3).
- **Right — live SSE feed (ephemeral display, never the state of record):** rolling list of `item:status` / `batch:progress` events with stage + `autoAdvanced` markers, `profile-blocked` (extractor), `family-barrier` holds, and failures with `errorMessage`. Reconnect-safe (EventSource retry + counts re-fetch on reconnect); a feed gap never corrupts status (status always re-read from the pollable endpoint).
- **Gaps fixed here (not elsewhere):**
  - No `GET /runs` → new read-only run/execution endpoint(s) in Slice 3 (scoped, bounded, paginated; worker/claim/lease observability without exposing secrets).
  - Ephemeral SSE → Slice 3 adds a **bounded durable event tail** (DB-backed, TTL-capped) served alongside the live stream so reloads/reconnects show recent history; the in-memory bus stays as the fan-out.
  - `console.log`-only narration → structured worker events surfaced through the same tail (no log scraping by the client).
  - Trivial `/health` → extended readiness in Slice 3 (`worker alive, last poll, claim lag, SSE subscribers, projection health`) without leaking credentials.
  - Derived-at-query `not_available`s → left as-is in telemetry; the strip does **not** re-derive metrics — it shows raw execution state, which is always derivable.

## 5. Rewrite shell (what is replaced vs kept)

- **Replaced:** `BatchWorkspace.tsx` (work-state-category tabs) + `PipelineBoard.tsx` (six-stage Kanban diagnostics) + `Onboarding.tsx` shell branching (`?board=pipeline`) + `WorkStateTabs.tsx` + `batch-workspace-logic.ts` tab/filter derivations that encode the old navigation. One new linear shell owns: Step 0 brand gate → six stage tabs (new values/labels) → execution strip → kept Review/attention surfaces embedded at the `review_approve` tab (and attention drawers reachable from any blocked row).
- **Kept byte-for-byte in behavior (moved, re-skinned only):** `ReviewWorkspace` + all `review/*` panels, `ApprovedView/ReadyToExportView/ExportActions`, all `attention/*` panels + `OfficialSiteResolutionWorkspace`, `FamilyInspectorDrawer/FamilyReadinessCard` (family context stays reachable; the `waiting_on_family` *tab* goes away as primary nav but family-barrier state remains visible inline + in the feed), `BatchPreflightModal` (upload-time; Step 0 is post-upload brand resolution — the two never merge).
- **Non-goals (explicit):** no review-decision semantics change; no promotion/draft semantics change; no sourcing/discovery/extraction/curation pipeline logic change; no work-state projection logic change except the stage-key rename + Step 0 aggregation; no telemetry re-derivation; no extractor-profile, cohort, or classification-config changes.

## 6. Phased v1 slices

One sequential writer. Slices land in order; each slice is independently revertible by flag or by `git revert` of its own commits (worktree stays dirty-safe: never `reset/clean/stash`, never stage unrelated paths).

### Slice 0 — ADR + CONTEXT fix + flags + inventory (no behavior change)

- **Goal:** lock vocabulary, fix the stale glossary, add kill-switch flags, prove the test baseline. Zero UI or pipeline behavior change.
- **Files to touch:**
  - `CONTEXT.md` — rewrite `Stage Advancement` entry to automation-owned progression (happy-path auto-advance via `sweepAutoAdvance`; manual reserve list: URL/profile exception, source-conflict, approval, export); annotate the superseded always-manual wording → ADR 0016; fix `Sourcing` entry only if it names removed transports (no semantics change).
  - `docs/adr/0034-onboarding-rename-and-shell-rewrite.md` — new (see §9 outline).
  - `src/client/onboarding-feature-flags.ts` — add UI-only `shellV2Enabled` (`VITE_ONBOARDING_SHELL_V2`, default OFF), `brandGateV2Enabled` (`VITE_BRAND_GATE_V2`, default OFF), `executionStripV2Enabled` (`VITE_EXECUTION_STRIP_V2`, default OFF); extend `OnboardingFeatureFlags`, cached env read, overrides/reset. Reuse `parseEnvFlag` kill-switch. NOTE: `VITE_*` never gates server behavior (nothing in `src/server/` reads `VITE_*`); server rename/tail gating uses server env flags (see §8) — Slice 0 must not lock §8 gating text without both layers.
  - Server env flags (new, Slice 0): `ONBOARDING_STAGE_RENAME_TOLERANT` (default OFF, gates Zod `preprocess`/repo tolerant-read), `ONBOARDING_EXECUTION_TAIL_WRITES` (default OFF, gates tail writes) — wired in server config with defaults + tests.
  - `src/tests/unit/onboarding-feature-flags.test.ts` — extend truth table for the four new flags.
- **New files:** ADR file only.
- **Contracts/invariants:** all new flags default OFF; with all OFF the app renders exactly today's tree; CONTEXT edit changes no code. Client `VITE_*` = UI-only; server `ONBOARDING_*` = behavior gates.
- **Tests:** extended flag truth-table test (defaults OFF, `false|0|no` disable, other non-empty enable, empty→default, override/reset round-trip).
- **Validation:** `bun run typecheck`, `bun run build`, `bun run test src/tests/unit/onboarding-feature-flags.test.ts`, `git diff --check`, `git status --porcelain=v1` (outer index still empty of staged files). Verify `lint` script first: repo is ESLint v9 (flat `eslint.config.mjs`) where `--ext` was removed — repair `package.json lint` if it still uses `--ext` before gating any slice on it.
- **Deps:** none; blocks Slices 1–4 (no new UI copy without fixed glossary + flags).
- **Non-goals:** no shell code, no endpoint, no migration.
- **Acceptance:** ADR merged as draft; CONTEXT Stage Advancement entry describes `sweepAutoAdvance` + manual reserve list; four flags exist, OFF by default, truth-table green.

### Slice 1 — New linear shell + stage tabs (behind `shellV2Enabled`)

- **Goal:** one shell with linear navigation (Step 0 placeholder + six renamed tabs using the **new** labels via a local display map, still reading **old** machine values through a compat adapter). Old surfaces untouched and still default.
- **Files to touch:**
  - `src/client/components/Onboarding.tsx` — flag branch: `shellV2Enabled ? <OnboardingShellV2/> : <existing>`.
  - `src/client/onboarding-api.ts`, `src/client/onboarding-work-api.ts` — additive stage-key adapter import only (no signature change).
- **New files:**
  - `src/client/components/onboarding-v2/OnboardingShellV2.tsx` — shell + tab router (`step=0` + six stage tabs) + execution-strip slot + attention-drawer slot.
  - `src/client/components/onboarding-v2/stage-tabs.tsx` — tab definitions (order, labels, counts props).
  - `src/client/components/onboarding-v2/stage-adapter.ts` — **temporary** old↔new stage key map (old values read, new labels shown). Deleted in Slice 4 cutover.
  - `src/client/components/onboarding-v2/stage-items.tsx` — per-tab item list (counts + rows; reuses work-state `items` endpoint, filters client-side by adapted stage).
  - `src/tests/unit/onboarding-shell-v2.test.tsx` — tab order/labels, `?step` routing, flag OFF renders legacy tree.
- **Contracts/invariants:** flag OFF ⇒ byte-identical legacy tree; flag ON ⇒ six tabs in canonical order, counts sum to batch total, unknown stage values render as "unknown — diagnostics" (fail-closed, never crash); no writes from the shell (read-only lists; all actions stay in kept panels/drawers).
- **Tests:** shell routing/order test; adapter round-trip test (old→new→old for all six); unknown-stage fail-closed render test.
- **Validation:** `bun run typecheck`, `bun run build`, `bun run lint` (new dir), `bun run test` (new suite + `batch-workspace-logic.test.ts` regression), manual flag ON/OFF matrix.
- **Deps:** Slice 0. Blocks Slices 2–3 (they mount into this shell).
- **Non-goals:** no Step 0 logic (placeholder tab only), no execution-strip live data (static slot), no rename migration (adapter only).
- **Acceptance:** with flag ON, batch view shows Step 0 + six renamed tabs in order with correct per-stage counts; flag OFF restores today's UI exactly; no new network calls beyond existing counts/items endpoints.

### Slice 2 — Step 0 brand gate (behind `brandGateV2Enabled`, requires `shellV2Enabled`)

- **Goal:** the single brand view from §3, mounted as Step 0. All actions reuse existing server paths.
- **Files to touch (rehouse, minimal edits):**
  - `src/client/components/onboarding/attention/BrandAssignmentPanel.tsx`, `BrandDomainSetupPanel.tsx` — extract pure presentational exports if needed (no behavior change); keep files as the implementation.
  - `src/client/components/SearchableBrandSelector.tsx` — reused as-is.
  - `src/client/components/onboarding/preflight/BatchPreflightModal.tsx` — link-out to Step 0 ("Resolve remaining brands →"); no logic change.
  - `src/client/components/OnboardingSettings.tsx` + settings brands/domain section — add "Open Step 0 brand gate" deep link; authority stays in Settings.
- **New files:**
  - `src/client/components/onboarding-v2/BrandGateView.tsx` — health header + per-item queue composition (calls existing hooks/endpoints).
  - `src/client/components/onboarding-v2/brand-gate-logic.ts` — pure derivation: brand ✓/✗ · domain ✓/✗ per item/brand, blocked-count rollups (unit-tested).
  - `src/tests/unit/brand-gate-logic.test.ts` — gate-state matrix (unmapped brand parks; mapped+matched unblocks). Provisional/denylist cases are spike-only until the seam is cited (see §3).
  - `src/tests/unit/brand-gate-view.test.tsx` — health + queue render, action wiring smoke (mocked API).
- **Contracts/invariants:** every mutation goes through existing endpoints (`assign-brand`, `bulk-brand`, `assign-brand-group`, `configure-brand`, `assign-domain`, `brand-domain-setup`); gate state is derived, never stored; unmapped/unknown brand never unblocks Discovery (mirrors `passesAuthorityGate`).
- **Tests:** logic matrix (above) + view smoke + regression run of existing brand/attention suites.
- **Validation:** `bun run typecheck`, `bun run build`, `bun run test src/tests/unit/brand-gate*`, existing `onboarding-work-routes.test.ts` green, manual: park an unmapped-brand item → appears in Step 0 → map domain in Settings → item unblocks.
- **Deps:** Slice 1. Independent of Slice 3.
- **Non-goals:** no new brand endpoints; no authority-gate logic change; no Settings rewrite.
- **Acceptance:** Step 0 shows mapping health + per-item fixes for a batch with brand blockers; resolving via Step 0 actions unblocks Discovery exactly as the old surfaces did; Settings remains the mapping authority.

### Slice 3 — Execution strip (behind `executionStripV2Enabled`, requires `shellV2Enabled`)

- **Goal:** the strip from §4: pollable batch+stage status + live SSE feed, backed by a minimal new read surface. Telemetry untouched.
- **Files to touch:**
  - `src/server/routes/health.ts` — extend (additive fields only): `workerAlive`, `lastPollAt`, `sseSubscribers`, keep `{status, version, timestamp}` shape.
  - `src/server/routes/onboarding-routes.ts` — PINNED: reuse `work-state/counts` + batch row for status half (no new `GET batches/:id/execution`) unless the pre-Slice-3 spike proves insufficiency against objective criteria (missing per-stage `pending/in_progress/failed/needs_input` backlog, oldest claim age, or last-poll that counts+batch cannot supply). Spike runs before Slice 3 implementation and pins one contract; route tests target the pinned contract only. A third divergent status source is forbidden.
  - `src/onboarding/job-queue.ts` — emit structured execution events (start/claim/complete/fail/hold/release/pause/resume/auto-advance/domain-release) to the new tail; replace nothing (console lines stay until Slice 5 cleanup).
  - `src/onboarding/sse-emitter.ts` — keep fan-out; add bounded replay of the durable tail on subscribe (cap e.g. 100/batch, TTL e.g. 24 h).
  - `src/client/onboarding-work-api.ts` — additive `getBatchExecution`, `getRecentEvents` + existing `subscribeBatchEvents` reuse.
- **New files:**
  - `src/db/repositories/onboarding-execution-repo.ts` — durable event tail (`onboarding_execution_events`: id, workspace/batch/item, kind, stage, status, message, created_at; TTL prune) + `last_poll` heartbeat row helpers. Repository pattern only — no SQL outside repos.
  - `src/tests/unit/onboarding-execution-strip.test.ts` — backlog aggregation, claim-age math, pause/resume reflection, SSE reconnect re-fetch, tail TTL/cap.
  - `src/client/components/onboarding-v2/ExecutionStrip.tsx` — status half + feed half.
- **API/DB migrations needed:** M1 as an `app_meta`-gated block in `src/db/migrations.ts` + sibling `*.sql` (existing runner pattern): `onboarding_execution_events` table (+ index on `(batch_id, created_at)`) + worker-heartbeat support, idempotency guards + receipt, `db-migration.test.ts` extension (re-run safety, count-audit). Backup-verified via `src/db/sqlite-backup-verifier.ts` before any live-DB run (acceptance must verify a backup exists). **No stage-value changes here.** Additive and null-safe (empty tail ⇒ strip shows "no recent events", never an error).
- **Contracts/invariants:** status half never derives from SSE (pollable source only); feed is display-only (a missed event never changes status); pause/resume use existing routes; heartbeat failures degrade the strip to "worker state unknown" (fail-closed, no fake green).
- **Tests:** repo tests (insert/cap/prune/scope), route tests (bounded, workspace-scoped, no secrets), component tests (paused badge, per-stage backlog, feed render + reconnect).
- **Validation:** `bun run typecheck`, `bun run build`, `bun run test` (new + work-routes suites), `bun run test:db` if repo suite is DB-backed, manual pause/resume + blocked-profile + family-barrier feed check.
- **Deps:** Slice 1. Independent of Slice 2.
- **Non-goals:** no `not_available` telemetry backfill; no log removal; no alerting/paging.
- **Acceptance:** strip shows running/paused + per-stage backlog + claim age + last poll + pause/resume; live feed shows item progress, profile-blocked, family-barrier, failures; reload shows recent tail; SSE outage degrades feed only.

### Slice 4 — Full stage rename (behind `stageRenameEnabled`; largest blast radius — lands last)

- **Goal:** execute §2: new machine values end-to-end, old values gone after cutover. The Slice 1 adapter is deleted.
- **Files to touch (mechanical, in this order):**
  0. Export `STAGE_ORDER` from `onboarding-item-repo.ts:84` (currently module-private `const`, not exported) and replace duplicates (`onboarding-routes.ts:1385`, `PipelineBoard.tsx:46`) with the single re-exported source — first commit of Slice 4, before any value changes.
  1. `src/shared/schemas/onboarding.ts` (+ `onboarding-work-state.ts` stage keys only — `WorkActivityEnum` unchanged) — new enum values + `STAGE_ALIASES` compat map (old→new read, new write) + Zod `preprocess` tolerant read during the window, gated on server `ONBOARDING_STAGE_RENAME_TOLERANT` (never `VITE_*`).
  2. Server + worker + projection (`onboarding-item-repo.ts`, `job-queue.ts`, `auto-advance.ts`, `domain-release.ts`, `onboarding-work-state.ts`, cohort/curator/telemetry/review-queue/draft-promoter guards listed in §2.2, SSE payloads, both route files, `onboarding-batch-repo` comments).
  3. Client (new shell natively; kept Review/attention panels' stage refs; delete `stage-adapter.ts`).
  4. `PipelineBoard.tsx` — migrate keys first (diagnostics must stay correct during the window), then decommission in Slice 5.
- **New files:**
  - `app_meta`-gated M2 block in `src/db/migrations.ts` + sibling `*.sql` — `UPDATE onboarding_items SET stage = <new> WHERE stage = <old>` ×6, guarded by pre-checks (no unknown stage values; row counts match before/after); records a migration receipt; idempotency + `db-migration.test.ts` extension. Backup-verified via `sqlite-backup-verifier.ts`.
  - Decision-JSON policy: persisted `SourcingDecisionV2` `target` strings (`extraction|discovery|sourcing`) are TOLERATED forever via aliases (never backfilled); "aliases removed" in strict-read means item `stage` reads only — decision-JSON aliases stay permanently.
  - `src/tests/unit/stage-rename-compat.test.ts` — alias read (old rows hydrate), new write, unknown-value rejection, STAGE_ORDER adjacency (incl. sourcing-special-case → `check_suppliers → find_official_page`), sweep-result keys, SSE stage values, staged/work-state key shapes.
- **API/DB migrations needed:** the stage-value backfill above. **Backup-verified, single-writer, additive-first:** (a) deploy tolerant-read code; (b) run backfill; (c) verify counts + probe items per stage; (d) deploy strict-read (aliases removed). Rollback = restore backup + revert to pre-migration code (never a reverse-UPDATE without backup).
- **Contracts/invariants:** single re-exported `STAGE_ORDER` (after step 0 dedupe above); tolerant-read window rejects unknown values (fail-closed); `advanceReviewedItemsToPromotion` guards re-keyed (`review_approve/completed → create_drafts/pending`); sourcing entry-policy + authority-gate semantics unchanged (only key names change).
- **Tests:** compat suite + full regression of every suite asserting stage strings (mechanical update + review, never blind snapshot update).
- **Validation:** `bun run typecheck`, `bun run build`, `bun run test`, `bun run test:db`, `bun run lint`, `git diff --check`; pre/post row-count audit queries; EventSource smoke on renamed payloads.
- **Deps:** Slices 0–3 (shell/strip/gate already on new labels; migration only swaps keys).
- **Non-goals:** no status-enum change; no Step-0-as-stage; no behavior change beyond keys.
- **Acceptance:** scoped `grep` clean on stage-typed positions only (enum, STAGE_ORDER, comparisons/params/payload keys, staged/work-state keys) with explicit allowlist for non-stage vocabulary (`source_type`, `discovery_runs`, `extractor_profiles`, `curation_runs`, `review_state`, `model_calls`, etc.); all suites green; staged + work-state endpoints serve new keys; worker poll + auto-advance + domain-release operate on new keys with SSE proof.

### Slice 5 — Cutover + decommission + docs (flags default ON, legacy removed)

- **Goal:** new shell becomes the only surface; divergence deleted; docs closed.
- **Files to touch:**
  - `src/client/onboarding-feature-flags.ts` — flip UI `shellV2Enabled/brandGateV2Enabled/executionStripV2Enabled` defaults ON (keep kill-switches); server `ONBOARDING_EXECUTION_TAIL_WRITES` default ON after Slice 3 bake, `ONBOARDING_STAGE_RENAME_TOLERANT` stays ON through bake then strict-read deploy removes tolerant path; `pipelineDiagnosticsEnabled` default OFF (PipelineBoard retained in tree but unreachable unless explicitly re-enabled for one grace release — Slice 5 does NOT delete the file; deletion is a follow-up after the grace release).
  - `src/client/components/Onboarding.tsx` — remove `?board=pipeline` branch + legacy imports.
  - Delete: `BatchWorkspace.tsx`, `WorkStateTabs.tsx`, `batch-workspace-logic.ts` (after confirming no imports remain), `stage-adapter.ts` (if Slice 4 left it), legacy review-drawer remnants if any. `PipelineBoard.tsx` is NOT deleted in Slice 5 (grace release, see above).
  - `src/onboarding/job-queue.ts` — remove replaced `console.log` narration now covered by the execution tail (keep operational error logs).
  - `CONTEXT.md` — final pass: Step 0 + new stage names + execution-strip + supersession note; `docs/runbooks/*` touch-up if they name old stages.
- **Tests:** dead-import sweep (`grep` for removed symbols), full suite, flag-matrix test (post-cutover kill-switches degrade to a notice — deleted UI is never restored by a flag; legacy-safe degraded message, never a blank screen).
- **Validation:** full ladder (§8) + `?board=pipeline` returns the disabled message + staged endpoint still serves diagnostics consumers during the grace release.
- **Deps:** Slice 4.
- **Non-goals:** no further renames; no review/promotion logic touch.
- **Acceptance:** default build shows only the new shell; `grep` for `BatchWorkspace|WorkStateTabs` (outside history/docs) is clean (`PipelineBoard` still present but unreachable during grace); kill-switches documented in the ADR + runbook.

## 7. API/DB migrations (consolidated)

| # | Migration | Slice | Type | Notes |
|---|---|---|---|---|
| M1 | `onboarding_execution_events` table + `(batch_id, created_at)` index + worker-heartbeat row | 3 | additive (`app_meta` block in `migrations.ts` + sibling `*.sql`, idempotent, `db-migration.test.ts` extended, backup verified via `sqlite-backup-verifier.ts`) | TTL prune in repo; empty tail is valid |
| M2 | `onboarding_items.stage` six-value backfill (`sourcing→check_suppliers`, `discovery→find_official_page`, `extraction→pull_details`, `curation→clean_classify`, `review→review_approve`, `promotion→create_drafts`) + receipt | 4 | data (`app_meta` block, idempotent, backup verified, tolerant→strict) | tolerant-read deploy → backfill → count audit → strict-read deploy; rollback = backup restore, never blind reverse-UPDATE; decision-JSON `target` strings tolerated forever |
| — | Health extension, status via pinned `work-state/counts`+batch (no new execution endpoint unless spike proves insufficiency) | 3 | additive API | versioned alongside work-state; no breaking change to `staged`/`work-state` shapes except stage keys (Slice 4) |
| — | Stage keys in `staged` + `work-state` responses | 4 | breaking (flagged) | announced in ADR; old keys gone after cutover; no dual-shape responses beyond the tolerant window |

No other schema change is planned. No live-DB writes outside M1/M2, both with verified backups first. No network/paid crawl/model work in any slice.

## 8. Flag rollout (`src/client/onboarding-feature-flags.ts`)

Extend the existing pattern (never a new flag system):

```ts
// UI-only defaults: all OFF until their slice lands + bakes
shellV2Enabled:          parseEnvFlag(ENV.VITE_ONBOARDING_SHELL_V2, false),
brandGateV2Enabled:      parseEnvFlag(ENV.VITE_BRAND_GATE_V2, false),
executionStripV2Enabled: parseEnvFlag(ENV.VITE_EXECUTION_STRIP_V2, false),
// Server behavior gates (never VITE_* — nothing in src/server/ reads VITE_*):
// ONBOARDING_STAGE_RENAME_TOLERANT (default OFF) → Zod preprocess/repo tolerant-read
// ONBOARDING_EXECUTION_TAIL_WRITES (default OFF) → tail writes on/off
```

- Kill-switch semantics inherited: `false|0|no` disables; any other non-empty enables; empty/undefined ⇒ default. `overrideOnboardingFeatureFlags`/`resetOnboardingFeatureFlags` extended for tests.
- Gating: Step 0 requires `shellV2Enabled && brandGateV2Enabled`; strip requires `shellV2Enabled && executionStripV2Enabled`; server tolerant-read requires `ONBOARDING_STAGE_RENAME_TOLERANT=1` (strict-read after M2 + bake removes the tolerant path); tail writes require `ONBOARDING_EXECUTION_TAIL_WRITES=1`.
- Rollout order: Slice 0 (flags exist, OFF) → Slice 1 (shell ON in dev/preview only) → Slices 2–3 (gate/strip ON in preview, OFF in prod) → Slice 4 (rename in staging with backup, prod after audit) → Slice 5 (defaults ON; kill-switches retained one release).
- Existing flags untouched: `batchWorkspaceEnabled`, `pipelineDiagnosticsEnabled`, `reviewUiV2` keep current defaults until Slice 5 flips diagnostics.

## 9. ADR outline (`docs/adr/0034-onboarding-rename-and-shell-rewrite.md`)

1. Context — BatchWorkspace/work-state-tab vs PipelineBoard/stage-column divergence; confusing stage names; brand authority scattered (ADR 0017 Phases); execution opacity (no runs surface, ephemeral SSE, trivial health).
2. Decision — (a) linear renamed stages as primary nav (Option A table + rejected B/C + why `brand_gate` is a view not a stage + why statuses unchanged); (b) single shell replacing both surfaces; (c) Step 0 brand gate reusing existing endpoints with Settings as authority; (d) execution strip = pollable status + display-only live feed + durable tail; (e) Review/attention kept.
3. Alternatives considered — label-map-only rename (rejected per operator); 7th-stage brand step (rejected: migration cost, no item invariant); telemetry-derived strip (rejected: `not_available`s); full attention/review rewrite (rejected: scope/risk).
4. Consequences — migration blast radius list (§2.2); tolerant→strict rename window; `staged`/`work-state`/SSE key break at Slice 4; diagnostics grace release.
5. Rollout & rollback — slice order, flag matrix, M1/M2 backup + audit + revert rules.
6. Supersession note — CONTEXT Stage Advancement fix; ADR 0007 always-manual wording superseded by ADR 0016 for the operator model (execution enum unchanged); ADR 0017 authority gate as Step 0's unblock contract.
7. Open risks — §10 items carried as accepted-with-mitigation or deferred.

## 10. Risks + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Rename misses a stage literal (worker claims wrong stage, SSE/client mismatch) | single re-exported `STAGE_ORDER` (step 0 of Slice 4) + tolerant-read window + scoped `grep` gate on stage-typed positions with allowlist + compat suite (telemetry/review-queue/draft-promoter/migrations in scope) | revert Slice 4 code + restore pre-M2 backup; never patch old values forward |
| Step 0 becomes a second brand authority competing with Settings | gate writes only via existing `assign-*/configure-*` paths; Settings link-outs; no new mapping endpoint | flag OFF (`VITE_BRAND_GATE_V2=false`) restores old panels in place |
| Execution tail grows unbounded / leaks secrets | repo-level cap + TTL prune; message allowlist (no credentials/identifiers — reuse multipart-upload redaction pattern); workspace-scoped reads | disable tail writes via `ONBOARDING_EXECUTION_TAIL_WRITES=0`, prune table, keep ephemeral bus |
| SSE reconnect storms / count-refresh loops | debounce (existing 400 ms), re-fetch-on-reconnect instead of event replay for status, bounded tail replay (≤100) | flag OFF for strip; status half keeps working (pollable) |
| Family-barrier/cohort stage guards mis-keyed after rename | rename cohort guards in the same commit as `STAGE_ORDER`; `holdWaitingFamilyMembers` + `advance*ToReview` covered by compat tests | revert Slice 4 (backup rule) |
| Dirty-worktree collision (unrelated `M`/`??` paths) | one sequential writer; `git status` + `git diff --check` per slice; never `reset/clean/stash`; stage only the plan/slice's own paths if a commit is ever requested (none requested by this plan) | `git revert` of the slice's commits only |
| Missing scout handoffs (evidence gap) | plan built from direct reads (§1); call out assumptions in each slice's PR description | re-issue scout read before Slice 1 implementation if handoffs reappear |
| Live-DB size/locking (M1/M2) | verified backup + free-space check (M0 discipline from classification plan); migrations additive-first; single writer | backup restore; no reverse-migration without backup |

## 11. Validation ladder (per slice + final)

- Per slice: `bun run typecheck` → `bun run build` (every client-touching slice: 1–3 + 4–5) → focused `bun run test <suite>` → `bun run lint` (touched dirs; verify `lint` script first — ESLint v9 removed `--ext`) → `git diff --check` → `git status --porcelain=v1` (no staged files; unrelated dirt byte-identical).
- Final (Slice 5): `bun run typecheck`, `bun run build`, `bun run test`, `bun run test:db`, `bun run lint`, `git diff --check`, scoped stage-literal `grep` on stage-typed positions only (allowlist: `source_type`, `discovery_runs`, `extractor_profiles`, `curation_runs`, `review_state`, `model_calls`, etc.), flag ON/OFF matrix (UI + server flags), SSE + pause/resume + brand-gate manual walkthroughs.

## 12. Residual risks (accepted, visible)

- Scout handoffs unavailable — plan substitutes direct reads; a re-read is cheap if the paths reappear.
- Candidate rename Option A is a proposal — operator must choose A/B/C before Slice 1 writes labels (machine values land in Slice 4 regardless, so Slice 1–3 proceed on display labels only).
- Status source pinned pre-Slice-3 (counts+batch reuse unless spike proves insufficiency with objective criteria) — no mid-slice contract choice.
- M1/M2 run as `app_meta` blocks with `sqlite-backup-verifier.ts` proof + idempotency/receipt tests — no live-DB run without a verified backup.
