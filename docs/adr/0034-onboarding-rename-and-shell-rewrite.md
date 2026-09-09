# ADR 0034 — Onboarding linear shell rewrite + full stage rename (RECONCILED Slice 0)

**Status:** reconciled draft — the council memo (Pass 1 f3287394 / Pass 2 c36e504c) is binding and **supersedes** every conflicting decision below. Vocabulary: full v2 canonical vocabulary owner-approved 2026-09-08 (`route_sources` / Identify & Route Sources, `find_product_page` / Find product page, `collect_details` / Collect details, `prepare_listing` / Prepare listing, `review_listings` / Review listings, `create_drafts` / Create drafts). No storage migration is approved or executed by this approval alone — the backfill/flip remains a separately authorized migration with bridge-artifact proof.

**Superseded draft decisions (do NOT implement):** new competing `onboarding-v2/` shell, durable execution tail/heartbeat (`onboarding_execution_events`, `/health` extension), backup-only rollback, prematurely final vocabulary (`sourcing→check_suppliers`, `discovery→find_official_page`, `extraction→pull_details`, `curation→clean_classify`, `review→review_approve`, `promotion→create_drafts`), `BatchWorkspace` deletion at cutover, provisional/denylist spike, Slice 5 UI-defaults flip, broad CONTEXT rewrite. Each is replaced by the council-conformant plan `docs/plans/onboarding-linear-rewrite-council-plan.md` §8 outline, summarized here:

1. Conditional acceptance; vocabulary + deployment gates explicit (proposed candidate now `route_sources / find_product_page / collect_details / prepare_listing / review_listings / create_drafts`, owner sign-off required).
2. Partial supersession of ADR 0016 (navigation + machine-vocabulary only; all behavioral guarantees retained).
3. Rename table/boundaries; Step 0 excluded; official URL principal, distributor secondary presentation only.
4. One BatchWorkspace shell via incremental strangulation; exact PipelineBoard retirement sequence; Prepare listing one internally sectioned view.
5. Step 0 one view, existing authority flows; distributor exemption; no batch barrier.
6. Ephemeral-only strip; no tail/heartbeat/worker-health claims.
7. v1/v2 adapters, dual-read + transactional backfill, pinned bridge rollback, quiescence.
8. Alternatives rejected (labels-only final, seventh stage, competing shell, client filtering, work-state inference, durable history, backup-only rollback, publishing-by-approval).
9. Rollout/acceptance gates incl. independent reviewer approval + separate migration authorization.
10. Only the two D5 explanatory sites reconciled in this tranche.

## Context (retained)

- Operator surface diverged: `BatchWorkspace` work-state tabs (`needs_attention/processing/waiting_on_family/review/approved/ready_to_export`) vs `PipelineBoard` six-stage Kanban diagnostics. Tabs do not read as stage truth (`skipped`→`approved`, `completed` merged into Ready to Export, Review mixes `unreviewed/reviewed/not_ready`, legacy progress bar counts differ from tab badges).
- Stage names (`sourcing/discovery/extraction/curation`) do not communicate operator activity.
- Brand authority scattered (upload read-only, preflight assign-brand-group/configure-brand, attention `BrandAssignmentPanel`/`BrandDomainSetupPanel`, Settings brands tab per ADR 0017) with no single pre-Discovery view; Discovery authority gate (resolved `brandHint` + mapped official domain + `passesAuthorityGate`) parks opaquely.
- Execution opacity: 2s worker poll (`maxConcurrency=3`), in-memory ephemeral SSE (`sse-emitter.ts`, disconnect = history lost), `console.log`-only narration, trivial `/health`, telemetry derived-at-query with honest `not_available`s, no onboarding `GET /runs`.
- `CONTEXT.md` Stage Advancement still said “always manual”; code runs `sweepAutoAdvance` + `sweepDomainReleases` every poll (epic #46 / ADR 0016 automation-owned happy path). Fixed in Slice 0 (code wins, glossary rewritten).

## Decision (RECONCILED — superseded by the council memo; see header)

The five decisions below are the stale draft. Binding direction lives in `docs/plans/onboarding-linear-rewrite-council-plan.md` (§8). In particular: (1) vocabulary candidate replaced by `route_sources / find_product_page / collect_details / prepare_listing / review_listings / create_drafts`, pending owner sign-off; (2) no competing `onboarding-v2/` shell — BatchWorkspace strangulation; (4) no durable tail/heartbeat — ephemeral-only strip. Original draft text preserved below for audit:

1. **Linear renamed stages as primary nav (Option A).** Machine values change end-to-end (not labels only):
   `sourcing→check_suppliers`, `discovery→find_official_page`, `extraction→pull_details`, `curation→clean_classify`, `review→review_approve`, `promotion→create_drafts`. `StageStatusEnum` unchanged. `brand_gate` is a view, never an item `stage` (`STAGE_ORDER` stays length 6). Rejected: B (noun-light), C (minimal-diff, leaves half-rename), label-map-only (operator explicitly rejected), 7th-stage brand step (migration cost, no item invariant).
2. **Single shell replaces both surfaces.** New `onboarding-v2/` shell owns Step 0 → six stage tabs → execution strip → kept Review/attention surfaces. `BatchWorkspace`/`WorkStateTabs`/`batch-workspace-logic` deleted at cutover; `PipelineBoard` retained one unreachable grace release, then deleted in a follow-up.
3. **Step 0 brand gate** (domain health top + per-item fixes bottom) reusing existing `assign-brand/bulk-brand/assign-brand-group/configure-brand/assign-domain/brand-domain-setup` paths; Settings stays the mapping authority; unmapped/unknown never unblocks Discovery (mirrors `passesAuthorityGate`); provisional/denylist display is a Slice 2 spike (no seam today).
4. **Execution strip = pollable status + display-only live feed + durable tail.** Status half never derives from SSE; feed never changes status. M1 adds `onboarding_execution_events` (`app_meta` block, capped, TTL-pruned, redacted, workspace-scoped) + heartbeat; `/health` extended additively. Telemetry `not_available`s left as-is.
5. **Review/attention kept.** `ReviewWorkspace` + all `review/*` + all `attention/*` moved/re-skinned only; no review-decision, promotion, sourcing/discovery/extraction/curation logic change; `WorkActivityEnum` unchanged (stage→activity via mapping fn only).

## Alternatives considered

See Context + §9 of `docs/plans/onboarding-frontend-rewrite-plan.md`: label-map-only, 7th-stage brand, telemetry-derived strip, full attention/review rewrite — all rejected for scope/risk/operator direction.

## Consequences (RECONCILED — backup-only rollback rejected; tested bridge binary is the rollback path; tolerant/strict window replaced by dual-read + version-aware adapters. See header.)

Original draft text preserved below for audit:

- Blast radius: every layer naming a stage (§2.2 normative `grep stage-literal` rule; includes telemetry/review-queue/draft-promoter/cohort repos/migrations/routes duplicates/client). Tolerant→strict window gated on server `ONBOARDING_STAGE_RENAME_TOLERANT`; `staged`/`work-state`/SSE keys break at Slice 4 (announced). `WorkActivityEnum` untouched. Decision-JSON `target` strings tolerated forever.
- Flags: UI `VITE_ONBOARDING_SHELL_V2/_BRAND_GATE_V2/_EXECUTION_STRIP_V2` (default OFF, UI-only — nothing in `src/server/` reads `VITE_*`); server `ONBOARDING_STAGE_RENAME_TOLERANT` + `ONBOARDING_EXECUTION_TAIL_WRITES` (default OFF). Slice 5 flips UI defaults ON, keeps kill-switches one release; `PipelineBoard` grace-retained.
- Migrations M1/M2 as `app_meta` blocks in `src/db/migrations.ts` + sibling `*.sql`, idempotent + receipt + `db-migration.test.ts` extension, backup verified via `sqlite-backup-verifier.ts`; rollback = backup restore, never reverse-UPDATE.
- Slice 3 status source pinned pre-implementation (reuse `work-state/counts`+batch unless spike proves insufficiency). Scoped `grep` gate with allowlist (`source_type`, `discovery_runs`, `extractor_profiles`, `curation_runs`, `review_state`, `model_calls`, …).

## Rollout & rollback

Slice order 0→5 per plan; each slice flag- or `git revert`-revertible; never `reset/clean/stash`; `git diff --check` + `status --porcelain` per slice; full ladder (typecheck/build/test/test:db/scoped lint/diff-check/scoped grep/flag matrix/manual walkthroughs) at Slice 5.

## Supersession

- `CONTEXT.md` Stage Advancement rewritten to automation-owned progression (this Slice); pre-ADR-0016 “always manual” superseded for the operator model per ADR 0016 §Supersession; ADR 0007 item `stage`+`stage_status` execution model remains diagnostics truth.
- ADR 0017 authority gate is Step 0’s unblock contract (unchanged semantics).

## Slice 6 status addendum — controlled default-on + mount retirement (ACCEPTED pending reviewer gate)

**Decision:** controlled default-on in rollout order (shell first, then
brand gate + strip): `VITE_ONBOARDING_SHELL_V2`, `VITE_BRAND_GATE_V2`, and
`VITE_EXECUTION_STRIP_V2` default `true` in
`src/client/onboarding-feature-flags.ts`; `VITE_PIPELINE_DIAGNOSTICS_ENABLED`
defaults `false`; `VITE_BATCH_WORKSPACE_ENABLED=false` is a deprecated
no-op; `VITE_REVIEW_UI_V2` semantics/default untouched. All PipelineBoard
mount branches/imports removed from `Onboarding.tsx` (including the
workspace-disabled fallback); `BatchWorkspace` is the sole shell.
`?board=pipeline` resolves to the current shell with a retirement notice.
Shell flag OFF restores the temporary within-shell classic grace navigation
(never the board). The board FILE is retained unreachable for a bounded
reviewed interval (`docs/plans/onboarding-shell-retirement-inventory.md`);
Slice 7 deletes it after zero-mount evidence + grace interval + manual
acceptance.

**Acceptance status:** retired 656-case truth-table ledger
(`src/tests/fixtures/onboarding-shell-matrix-retired.json`) green against
`resolveRetiredShell`; pre-retirement ledger still green; import-graph audit
gate (`scripts/audit-onboarding-shell-imports.ts --check …`) green with
self-tests; flag suites (defaults/parser/isolation/REVIEW_UI_V2
noninterference) green; operator-flow mounts green; browser walkthrough
(default-on shell, rollback grace mode, retirement notice) recorded outside
the repo. Reviewer gate required before Slice 7. No server/storage/migration
change in this slice; no storage activation executed.

## Slice 7 status addendum — board deletion + fallback retirement (IMPLEMENTED, reviewer gate required)

**Decision:** `src/client/components/PipelineBoard.tsx` is DELETED after the
Slice 6 zero-mount evidence (audit gate green before AND after deletion) +
grace interval + manual acceptance. Export/coverage diff (reviewed allowlist
in `docs/plans/onboarding-shell-retirement-inventory.md` §8): single export
`PipelineBoard`, zero production inbound edges, zero exclusive
test/style/helper deletions — every helper the board once imported stays
(never delete the shared decision helper `pipeline-decision-state` merely
because the board once imported it). The diagnostics flag
`pipelineDiagnosticsEnabled` (`VITE_PIPELINE_DIAGNOSTICS_ENABLED`) is removed
with the file: `?board=pipeline` always resolves to the shell with a
`retired-diagnostics` notice, gated by no flag — including the P2
no-batch-selected path (notice above the batches list when no `?batch=` is
present). The temporary work-state-primary navigation branch
(`ClassicWorkspace`) is removed (fallback release archived);
`WorkStateTabs` + `batch-workspace-logic` helpers are retained as secondary
operation navigation. `shellV2Enabled=false` is now the emergency
disabled-content state inside BatchWorkspace (header + rollback
instruction, no brand/strip/old navigation), not a permanent competing
primary shell. Classic rollback after Slice 7 uses the archived matching
bridge client — never a resurrected board. BatchWorkspace and every frozen
operation view are preserved.

**Acceptance status:** one shell; no board file/mount/implicit fallback; no
permanent competing primary navigation; raw execution detail + all 36
stage/status categories observable through the stage view/strip;
import-graph self-tests + production scan green before AND after deletion;
final-phase flag/URL matrix (retired ledger) green; full regression ladder
green or baseline-documented in the §7 packet. No server/storage/migration
change in this slice; no storage activation executed.

## Open risks

Carried from plan §10/§12: rename miss (mitigated by single re-exported `STAGE_ORDER` step 0 of Slice 4 + scoped grep + compat suite), second-authority drift (existing-paths-only), tail growth/secrets (cap/TTL/allowlist), SSE storms (debounce + bounded replay ≤100), family/cohort mis-key (same-commit rename + compat), dirty-worktree discipline, scout-handoff evidence gap (direct reads substituted).
