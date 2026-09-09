# Onboarding stage-vocabulary inventory (seed, Slice 0)

**Status:** seed manifest. Slice 0 creates the structure; Slice 5a completes the
classified match manifest (every match gets file/line, role, format version,
chosen treatment, downstream consumer, test). No unclassified hit may remain at
Slice 5 activation. Vocabulary is owner-pending — this seed records v1 sites
only; no v2 literals are final.

Seed source: council plan Appendix A (verified file-level seed inventory) plus
the Slice 0 audit-tool contract (§6.1). Re-run after each slice; this is a
dirty, evolving worktree.

## Classification rules

- `operational`: a live stage read/write/guard/predicate/transition/claim/emit
  that must move through the version-aware adapter + dual-read bridge to the
  native v2 enum. Example: `STAGE_ORDER`, `PipelineStageEnum`, claim/advance/
  reset guards, `SOURCING_COMPLETION_TARGETS` values, worker dispatch/sweep
  targets, cohort predicates, projection live stages, stage-typed route/API/SSE
  fields, batch distributions.
- `historical`: migration/DDL literals, old-status→v1 upgrade steps, immutable
  fixtures/receipts/decision JSON/route IDs/hashes. Preserve; interpret through
  version-aware adapters, never blanket-replace.
- `non-stage`: word collisions that are not onboarding stages (WorkActivity,
  classification stages, review navigation words, model-operation values,
  source types, ReviewState/WorkStateCategory strings). Preserve unless the
  inventory proves otherwise with a consumer + test.

## Seed rows (v1 sites; treatment pending Slice 5a review)

| File | Symbol/site | Presumed class | Notes |
|---|---|---|---|
| `src/shared/schemas/onboarding.ts` | `PipelineStageEnum` (~:203), item schemas, batch stage distribution, sourcing decision target variants | operational (+ historical for decision-target fixtures) | Runtime cutover in Slice 5b; decision route IDs stable |
| `src/shared/schemas/onboarding-work-state.ts` | stage field, v1 contract, `computeWorkStateFilterHash` | operational (contract frozen) | v1 hashes/cursors byte-identical; v2 hash is a new function |
| `src/db/repositories/onboarding-item-repo.ts` | `STAGE_ORDER` (:84), hydration fallback (:235 `row.stage \|\| 'sourcing'` → version-aware validation), status fallback (:236, inventoried separately), inserts/defaults, chunk/staged reads, advance/reverse/reset/claim/stale-claim, `resetItemsToStage`, `SOURCING_COMPLETION_TARGETS` values, sourcing validation, review/promotion completion | operational | :235 fail-open fallback must reject null/empty/unknown, never default to first stage |
| `src/db/repositories/onboarding-batch-repo.ts` | derived distribution, completed counts, archival predicate | operational | Derived, not a new persisted authority |
| `src/db/repositories/onboarding-review-repo.ts` | raw SQL review/promotion guards, write encodings, legacy rejection strings | operational | Narrow D4 exception only |
| `src/db/repositories/onboarding-conflict-repo.ts` | post-conflict stage transitions | operational | — |
| `src/db/repositories/classification-cohort-run-repo.ts` | stage predicates/leases | operational | — |
| `src/db/repositories/curation-cohort-repo.ts` | generic row stage transport vs immutable extraction hashes | operational + historical | Transport moves; hashes preserved |
| `src/db/repositories/store-manager-source-observer-repo.ts` | raw stage projection, downstream event comparison | operational | — |
| `src/onboarding/job-queue.ts` | dispatch/sweep targets, guards, emits | operational | Comment-only D5 edit in Slice 0; no runtime change |
| `src/onboarding/auto-advance.ts` | advance/discovery/extraction/curation helpers, `sweepAutoAdvance` | operational | — |
| `src/onboarding/domain-release.ts`, `curation-cohort-service.ts`, `cohort-curator.ts`, `product-curator.ts`, `draft-promoter.ts` | compare/dispatch/emit/write boundaries | operational | — |
| `src/onboarding/sourcing/entry-policy.ts`, `sourcing/distributor-record-materializer.ts` | entry policy, decision targets | operational + historical (route IDs) | Route IDs e.g. `distributor_record_to_extraction` stable, never rewritten |
| `src/onboarding/variant-selection-service.ts`, `manual-evidence-service.ts`, `manual-evidence-eligibility.ts`, `brand-domain-blockers.ts`, `extraction/profile-blockers.ts` | stage guards, query encodings | operational | Authority/eligibility policies unchanged |
| `src/onboarding/onboarding-work-state.ts`, `onboarding-review-queue.ts`, `onboarding-telemetry.ts` | runtime stage guards | operational | Category/review/metric semantics preserved |
| `src/server/routes/onboarding-routes.ts` | duplicate orders/validStages, reset/advance/import/staged/count/item endpoints, SSE | operational | Explicit boundary serializers; default = legacy v1 |
| `src/server/routes/onboarding-work-routes.ts` | live `review` guard (~:447), emitted `promotion` (~:511) | operational (narrow D4 exception) | Only inventoried rename substitutions; v1 behavior byte-identical |
| `src/server/routes/profile-activation-routes.ts` | stage-specific requeue guard | operational | — |
| `src/client/onboarding-api.ts`, `onboarding-work-api.ts` | stage fields/keys/guards | operational | Client must not import DB repos for stage order |
| PipelineBoard.tsx — DELETED in Slice 7 (see docs/plans/onboarding-shell-retirement-inventory.md sections 6-8; rollback uses archived bridge client) | STAGES/keys/guards (retired) | retired | Slice 6-7 retirement sequence; file removed after verified-unreachable interval |
| `src/db/migrations.ts`, `stage-pipeline-migration.sql`, `onboarding-migration.sql`, `schema.sql` | historical literals/defaults (`DEFAULT 'discovery'`), prerequisites | historical | Old-status→v1 step preserved; operator-review backfill ordering explicit |
| `scripts/benchmark-onboarding-work-state.ts`, `scripts/unblock-sourcing-conflicts.ts`, `scripts/repair-system-auto-accept.ts` | stage reads/writes | operational (version-known or refuse v2) | Do not run repair scripts in this work |

## Known non-stage/immutable hits (preserve)

WorkActivity values/order/labels; review navigation words in `App.tsx`/
`OnboardingSettings.tsx`/`tabRegistry.ts`; model-operation/capability values;
classification's distinct stage names + recorded snapshots; `session-runner.ts`
+ `build-page-role-proposals.ts` collisions; source types, method versions,
`onboarding_discovery_runs`, extraction/curation table names, ReviewState/
WorkStateCategory strings, operation IDs, receipt details/request hashes,
evidence/cohort/source hashes. Test inventory keeps v1 fixtures as v1; v2
counterparts are added, never blanket-replaced (esp.
`hash-stability-characterization`, review/operation-receipt/sourcing/variant/
cohort migration suites).

## Tooling

- `scripts/audit-onboarding-stage-vocabulary.ts` (Slice 1): read-only source
  audit + classified inventory check; no DB/application imports.
- `scripts/check-test-runner-coverage.ts` (Slice 0): test-runner registration
  guard; see §6.1.

---

## Slice 5a classified match manifest (bridge foundation)

Every live match below carries file/line, role, format version, treatment,
consumer, and test. NO unclassified hit remains in the operational set.
Historical SQL/immutable fixtures are classified `historical` and preserved
(not mechanically rewritten); word collisions are `non-stage`.

### Operational — adapted in Slice 5a (verified dual-read/refuse-v2)

| File:line | Role | Format | Treatment | Consumer | Test |
|---|---|---|---|---|---|
| `src/shared/onboarding-stage-vocabulary.ts` (whole) | canonical v1↔v2 authority, bijection, parsers | v1+v2 | authority (unchanged) | repos, server boundary, artifacts | `onboarding-stage-history-compat` |
| `src/shared/schemas/onboarding.ts:208` `PipelineStageEnum` | v1 runtime/storage enum | v1 | frozen until 5b native cutover | item-repo, routes | history-compat |
| `src/db/repositories/onboarding-item-repo.ts` `storedStageIs`/`storedStageIndex` helpers | canonical comparators | v1+v2 | no module-owned order array (shared `STAGE_ORDER_V2` only); advancement/reset index via canonical positions, writes encoded | claim/advance/reset | migration + queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~259` hydration | row→item boundary | v1+v2 read | version-aware validation, fail-closed (no first-stage default) | all readers | history-compat |
| `src/db/repositories/onboarding-item-repo.ts:~759` `claimItemsForProcessing` | worker claim predicate | v1+v2 read | dual-spelling `(stage=? OR stage=?)` predicate | job-queue | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~360` `insertItems` | writer | version-dependent write | per-transaction metadata read, encode observed version | import paths | migration |
| `src/db/repositories/onboarding-item-repo.ts:~931,~951,~956` `advanceItemsToNextStage` | generic advance | v1+v2 read/write | canonical sourcing check + canonical order index; next stage encoded via observed version | worker/operator advance | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1013,~1046` `advanceReviewedItemsToPromotion` | review→promotion advance | v1+v2 read/write | canonical review check; SET encoded, WHERE dual-spelling | bulk approval | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1093` `completeReviewStage`, `~1105` `completePromotionStage` | review/promotion completion | v1+v2 read | dual-spelling WHERE guards | review/promotion completion | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1172` `resetItemsToPending` | retry reset | v1+v2 read | canonical review/promotion branch | worker reset | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1248` `sendItemsToPreviousStage` | send-back | v1+v2 read/write | canonical index + canonical undo branches; revert stage encoded | reviewed send-back | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1268` `resetItemsToStage` | admin reset-to-stage | version-dependent write | target accepted in either spelling, encoded via observed version | admin repair | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1548` `updateSourcingDecision` audit write | sourcing audit guard | v1+v2 read | dual-spelling `sourcing` guard; no stage transition | audit callers | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~705` `getPendingItemsByStage` | worker pending read | v1+v2 read | dual-spelling predicate (claim pattern) | worker | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:~1126` `getStageCounts` | derived distribution | v1+v2 read | semantic (canonical) counting into v1-keyed buckets | batch reads | queued-continuation |
| `src/db/repositories/onboarding-item-repo.ts:1539-1546` route→target map | decision-target interpretation | v1 recorded | interpret via artifacts module, bytes preserved | materializer | history-compat |
| `src/db/repositories/onboarding-batch-repo.ts:88,111,163` distribution/completed/archival | derived counts | v1+v2 read | semantic dual-spelling counting + archival predicate | batch reads | queued-continuation |
| `src/db/repositories/onboarding-review-repo.ts:304,362-364,529` review guard + approve-advance + export eligibility | raw review guards | v1+v2 read/write | dual-read predicates + version-encoded approve write + dual-spelling export check (D4 narrow; :529 adapted for the §5.5 export-receipt proof) | review routes | queued-continuation + rollback-bridge |
| `src/db/repositories/onboarding-conflict-repo.ts:426` post-conflict transition | conflict guard | v1+v2 read | dual predicate | conflict resolution | queued-continuation |
| `src/db/repositories/classification-cohort-run-repo.ts:172,186,765,797` cohort predicates/leases | cohort claim/freeze | v1+v2 read/write | 4-literal NOT IN + canonical rerun validation + encoded reset write | cohort worker | queued-continuation |
| `src/db/repositories/store-manager-source-observer-repo.ts:61-69` observer rows | raw projection | v1 (+ refuse-v2) | v1 rows pass through byte-identical; v2/unknown literals throw a clear refuse-v2 error (downstream trigger compares are 5b-owned v1) | observer events | queued-continuation |
| `src/db/repositories/onboarding-stage-vocabulary-repo.ts` (whole) | version read/validate/inventory/transactional seam + counts/digests | v1+v2 | per-transaction metadata reads, no cache | all writers | migration |
| `src/db/onboarding-stage-vocabulary-migration.sql` (whole) | six stage-only updates | v1→v2 | offline maintenance only, never startup | maintenance script | migration |
| `src/db/migrations.ts` (stage-vocabulary block) | precondition/order validation + v2 boot guard | meta | guarded checks, NOT unconditional backfill; unknown storage version throws; v2 storage with unknown/null stage rows throws (P0-3, no `void`) | boot | migration |
| `src/server/onboarding-stage-api.ts` (whole) | v1/v2 boundary serializers | v1 default, v2 opt-in | validate version before action | stage-bearing routes | history-compat |
| `src/onboarding/onboarding-stage-artifacts.ts` (whole) | immutable target interpretation | v1 recorded | interpret-only, route IDs stable | sourcing engine | history-compat |
| `scripts/onboarding-stage-vocabulary.ts` (whole) | offline maintenance | v1/v2 | dry-run default; apply gated on mode/backup/identity/quiescence | operator | migration (dry-run-writes-nothing) |
| `scripts/build-onboarding-stage-bridge.ts`, `scripts/onboarding-stage-compat-smoke.ts`, `src/tests/helpers/onboarding-stage-bridge-harness.ts` (whole) | pinned artifact build + child exercise + spawn harness | v1+v2 | §5.6 contract; smoke exercises emitted app/repos (v1 route+auth, queue-continuation, receipt-replay, distributor/cohort) | rollback-bridge test | rollback-bridge |
| `scripts/unblock-sourcing-conflicts.ts:33` blocked-items read | admin script | version-known or refuse-v2 | v1/absent storage: v1 query byte-identical; v2 storage throws a clear refuse-v2 error | operator | migration (refuse-v2 check) |
| `scripts/repair-system-auto-accept.ts:118-119,212` promotion reads/return-to-review | admin script | version-known or refuse-v2 | v1/absent storage: queries byte-identical; v2 storage throws a clear refuse-v2 error | operator | migration (refuse-v2 check) |
| `src/onboarding/flags.ts` compat scaffolding | toggle resolution | n/a | compat mandatory: tolerant/execution-tail toggles retired; unsupported combos fail startup; VITE_* never chooses storage | boot | migration |
| `src/client/components/onboarding/StageItemsView.tsx`, `src/client/components/onboarding/OutcomeItemsView.tsx`, `src/client/components/onboarding/PrepareListingView.tsx`, `src/client/components/onboarding/linear-workspace-logic.ts`, `src/client/components/onboarding/execution-strip-logic.ts`, `src/client/components/onboarding/prepare-listing-logic.ts`, `src/shared/schemas/onboarding-live-activity.ts` | Slice 2/4 v2-native display/navigation | v2 display | built v2-native against v2 stage reads; not a runtime stage authority | UI shell/strip | existing UI suites (unchanged) |

### Operational — 5b-owned native-cutover-only (verified single-spelling v1 in 5a)

These sites were verified (audit `--emit-manifest` + direct read) to contain
NO dual-read/version-aware handling in the 5a tree. They stay single-spelling
v1 through Slice 5a and move only in the 5b native cutover. No silent
dual behavior is claimed for them.

| File:line | Role | Format | Treatment | Consumer | Test |
|---|---|---|---|---|---|
| `src/db/repositories/onboarding-item-repo.ts:~1657,~1719,~1725,~1771,~1981,~2042,~2070,~2116,~2152,~2215` sourcing completion/transition guards | sourcing guards + `SET stage = 'discovery'` writes | v1 | 5b-owned native-cutover-only | sourcing engine | 5b api-compat |
| `src/db/repositories/onboarding-item-repo.ts:~2290,~2311,~2329,~2348,~2366,~2385,~2403,~2423,~2458` stage-stepping transitions | discovery→extraction→curation→review→promotion guarded transitions | v1 | 5b-owned native-cutover-only | worker stepping | 5b api-compat |
| `src/db/repositories/curation-cohort-repo.ts` row transport | generic row stage transport | operational + historical | 5b-owned; extraction hashes preserved | curator | history-compat |
| `src/db/repositories/onboarding-work-state-repo.ts` shared read context | read context | v1 | 5b-owned native-cutover-only | work-state reads | 5b |
| `src/onboarding/job-queue.ts`, `src/onboarding/auto-advance.ts`, `src/onboarding/domain-release.ts`, `src/onboarding/curation-cohort-service.ts`, `src/onboarding/cohort-curator.ts`, `src/onboarding/product-curator.ts`, `src/onboarding/draft-promoter.ts` | dispatch/emit/write boundaries | v1 | 5b-owned native-cutover-only | workers | 5b |
| `src/onboarding/sourcing/entry-policy.ts`, `src/onboarding/sourcing/distributor-record-materializer.ts` | entry policy/targets | operational + historical | 5b-owned; route IDs stable, never rewritten | sourcing | 5b |
| `src/onboarding/variant-selection-service.ts`, `src/onboarding/manual-evidence-service.ts`, `src/onboarding/manual-evidence-eligibility.ts`, `src/onboarding/brand-domain-blockers.ts`, `src/onboarding/extraction/profile-blockers.ts` | stage guards/query encodings | v1 | 5b-owned native-cutover-only; authority/eligibility unchanged | exception paths | 5b |
| `src/onboarding/onboarding-work-state.ts`, `src/onboarding/onboarding-review-queue.ts`, `src/onboarding/onboarding-telemetry.ts` | projection guards | v1 | 5b-owned native-cutover-only; category/review/metric semantics preserved | work-state reads | 5b |
| `src/server/routes/onboarding-routes.ts` orders/validStages/endpoints/SSE | transport | v1 default | 5b-owned native-cutover-only | clients | 5b api-compat |
| `src/server/routes/onboarding-work-routes.ts:~447,~511` review guard/emitted promotion | frozen file | v1 | 5b-owned; D4 narrow substitution NOT applied in 5a — frozen v1 behavior byte-identical | work routes | existing work-routes suite |
| `src/server/routes/profile-activation-routes.ts` requeue guard | guard | v1 | 5b-owned native-cutover-only | activation | 5b |
| `src/server/services/store-manager-trigger-service.ts` comparisons | trigger terminal/promotion compares | v1 | 5b-owned native-cutover-only (observer refuses v2 so these never misread) | triggers | 5b |
| `src/client/onboarding-api.ts`, `src/client/onboarding-work-api.ts`, `src/client/components/onboarding/BatchWorkspace.tsx`, `src/client/components/onboarding/batch-workspace-logic.ts`, `src/client/components/onboarding/families/FamilyInspectorDrawer.tsx`, `src/client/components/onboarding/processing/processing-logic.ts`, `src/client/components/onboarding/processing/ProcessingStatus.tsx`, `src/client/components/WeeklyReportPanel.tsx` | display/keys/guards | v1 | 5b-owned display cutover (client must not import DB repos for stage order); seed-gap files folded here explicitly | UI | existing UI suites (unchanged) |
| `scripts/benchmark-onboarding-work-state.ts` stage seeding | fixture seeder | v1 fixtures | 5b-owned; seeds v1 literals, never a runtime authority | benchmarks | existing |
| `src/server/onboarding-event-presentation.ts` SSE serializers + `src/shared/schemas/onboarding-live-activity.ts` live-stage mappers | per-subscriber wire serialization | v1 default, v2 opt-in | 5b-owned: v1 normalizes canonical→v1, v2 accepts v2 input (identity) | SSE clients/strip | 5b api-compat + sse-versioning |
| `src/shared/schemas/onboarding.ts` `PipelineStageEnum` + `src/shared/schemas/onboarding-work-state.ts` stage field | runtime enum + stored-carrying row schemas | v2 canonical / dual row | 5b-owned: enum cut over; row schemas union v1+v2 (stored spelling preserved) | all | 5b api-compat + history-compat |
| `src/onboarding/onboarding-stage-read.ts` promoted-SKU derivation + `src/onboarding/onboarding-telemetry.ts` denominator | projection live stages | v1 | 5b-owned native-cutover-only | work-state reads | 5b |
| `src/server/services/store-manager-inbox-collectors.ts` staged-key consumer | diagnostics consumer | v1 key | 5b-owned: v2 key | triggers | 5b |

### Slice 5b adaptation record (native cutover applied)

Every 5b-owned row above moved as follows (storage activation remains a
separately authorized operational action — no backfill executed, no live DB
upgrade; isolated temp DBs only):

- `PipelineStageEnum` is the canonical v2 runtime enum (same order/positions);
  `LegacyPipelineStageEnum` is the frozen v1 authority. Row schemas carrying
  stored spelling (`OnboardingItem`, `OnboardingWorkState`) accept either
  spelling; runtime comparisons/branches are canonical v2 with fail-closed
  unknown handling; SQL reads are dual-spelling and writes encode the
  per-transaction observed storage version. `SOURCING_COMPLETION_TARGETS`
  values, `SourcingEntryStage`, worker dispatch/sweep targets, cohort
  predicates, projection live stages, route guards, SSE payloads, PipelineBoard
  `STAGES`/labels/guards, and diagnostics/report consumers are v2-native.
- `resetItemsToStage`'s stale PipelineBoard presentation comment is retired;
  its completed-status behavior is unchanged.
- Untouched by design: independent activity/review/source enums, WorkActivity
  values, classification's seven stages, historical migration literals, receipt
  hashes, route IDs (incl. `distributor_record_to_extraction`), ShopSite sync,
  SourcingDecision V2 `target` bytes, review-history event labels, legacy
  operation/tab IDs, and domain-name-colliding module/function names.
- Allowed residuals (every remaining `operational-v1` literal) carry
  version/role/test ownership in
  `docs/plans/onboarding-stage-vocabulary-residuals.json` (v1); the audit is
  run as `bun scripts/audit-onboarding-stage-vocabulary.ts --check
  docs/plans/onboarding-stage-vocabulary-inventory.md --residuals
  docs/plans/onboarding-stage-vocabulary-residuals.json`.
- Bridge re-freeze: rebuilt from the pre-native bridge source with the pinned
  §5.6 commands, deterministic chunk repair re-applied
  (`repair-bridge-chunks.ts`: dangling `__INVALID__REF__` cycle +
  duplicate trailing re-exports), byte-diff vs
  `/tmp/baystate-onboarding-bridge-uWqxDq` reviewed (repaired bundle
  byte-identical), manifest amended with the repair record + per-chunk
  hashes at `/tmp/baystate-onboarding-bridge-5b-Ax7R0h`.

### Historical (preserve; interpret through adapters)

| File | Role | Treatment |
|---|---|---|
| `src/db/stage-pipeline-migration.sql:6-30` | old-status→v1 upgrade | byte-preserved; v1 convergence step before rename |
| `src/db/migrations.ts` operator-review backfill + marker-1→2 hop | prerequisite ordering | preserved; rename refuses until marker=2 |
| `src/db/onboarding-migration.sql`, `schema.sql` (`DEFAULT 'discovery'`) | legacy schema default | classified legacy default; all writers supply explicit encoded stage |
| `hash-stability-characterization`, review/operation-receipt/sourcing/variant/cohort fixtures | immutable v1 fixtures | retained as v1; v2 counterparts added, never blanket-replaced |

### Non-stage (preserve)

WorkActivity values/order/labels; review navigation words; model-operation/
capability values; classification stage names + snapshots; session-runner +
build-page-role-proposals collisions; source types; `onboarding_discovery_runs`;
extraction/curation table names; ReviewState/WorkStateCategory; operation IDs;
receipt/request hashes; evidence/cohort/source hashes.
