# Onboarding shell retirement inventory (Slice 7 — file deleted, zero mounts)

**Phase:** file-deleted final (council plan §6 Slice 7). Slice 6 removed all
PipelineBoard mount branches/imports (BatchWorkspace sole shell, zero
production import-graph edges, audit-proven); Slice 7 deletes
`src/client/components/PipelineBoard.tsx` after that zero-mount evidence
plus the agreed grace interval and manual acceptance. No board file, mount,
or implicit fallback remains. Rollback is the archived matching bridge
client — never a resurrected board and never a permanent competing primary
navigation (`shellV2Enabled=false` is an emergency disabled-content state
inside BatchWorkspace).

**Audit gate:** `bun scripts/audit-onboarding-shell-imports.ts --check
docs/plans/onboarding-shell-retirement-inventory.md` must pass: zero
production import-graph edges to `PipelineBoard.tsx`, zero unclassified
computed imports/globs, and this inventory naming the board file as
deleted-after-verified-unreachable with zero approved mounts.

## 1. Deleted file (zero mounts approved: none)

| Path | Disposition | Inbound refs (production) | Replacement coverage |
|---|---|---|---|
| `src/client/components/PipelineBoard.tsx` | **DELETED in Slice 7** — removed after the Slice 6 verified-unreachable interval (zero production edges, audit gate green before AND after deletion). It was NOT an alternate rollback shell (rollback = archived matching bridge client). | Zero at deletion (audit gate proves; §8 export/coverage diff below). | Diagnostics-only Kanban replaced by `StageNavigation` + server 6×6 matrix (`StageItemsView`); per-item inspection replaced by the frozen operation views mounted in `BatchWorkspace`/`LinearShell`. |

## 2. Slice 6 production edits (mount removal — no file deletions)

(Table retained for audit history; Slice 7 changes follow in §2a.)

| Path | Change | Behavior owner |
|---|---|---|
| `src/client/components/Onboarding.tsx` | Removed the `PipelineBoard` import and BOTH mount branches (explicit-diagnostics mount and workspace-disabled fallback mount). Removed the now-dead `Unavailable` branch: `VITE_BATCH_WORKSPACE_ENABLED=false` is a deprecated no-op. An explicit `?board=pipeline` URL renders the sole shell plus a `retired-diagnostics` retirement notice (`data-testid="retired-diagnostics-notice"`), never a board mount and never a dead screen. Also removed the now-unused `PipelineBoard`-only imports (`getProfileWorkspacePath`, `normalizeBrandHubDomain`, `getOnboardingFeatureFlags`). | `resolveRetiredShell` (Table A mounts-retired) + retired ledger fixture. |
| `src/client/onboarding-feature-flags.ts` | Controlled default-on in rollout order (shell first, then brand gate + strip): `shellV2Enabled`, `brandGateV2Enabled`, `executionStripV2Enabled` default `true`. `pipelineDiagnosticsEnabled` default `false`. Kill-switch parser + override/reset semantics unchanged. `VITE_REVIEW_UI_V2` semantics/default untouched. | `onboarding-feature-flags.test.ts` (Slice 6 defaults + parser + isolation). |
| `src/client/components/onboarding/linear-workspace-logic.ts` | Added `resolveRetiredShell` (Table A mounts-retired: root always `BatchWorkspace`; `?board=pipeline` ⇒ `retired-diagnostics` notice; retired `W`/`D` switches ignored). Tables B+C shared via `finishBatchWorkspaceRoot`. Pre-retirement `resolveLinearShell` retained for ledger history. `ShellMatrixResult.notice` gains `retired-diagnostics`. | `onboarding-shell-mounts-retired.test.ts` + retired ledger fixture. |
| `src/client/components/onboarding/BatchWorkspace.tsx` | Sole-shell comments; classic work-state navigation explicitly marked as the temporary rollback mode (shell flag OFF restores it, never PipelineBoard). Added `data-testid="linear-shell"` / `data-testid="workspace-grace-fallback"` roots for mount verification. No behavior change to frozen operation mounts. | `onboarding-linear-shell.test.tsx` (existing mounts) + browser verify. |
| `src/client/components/onboarding/WorkStateTabs.tsx` | Comment-only: within-shell secondary/classic navigation, never a root shell, never a board reference. | Unchanged behavior; existing suites. |

## 3. Behavior/coverage ledger (every unique board behavior accounted for)

| Board behavior | Disposition | Replacement test |
|---|---|---|
| Six-stage Kanban diagnostics (stage columns/counts) | **Retired as diagnostics-only.** Stage truth now comes from the server 6×6 matrix via `StageNavigation` badges + `StageItemsView` (server-filtered, never page-length derived). | `onboarding-linear-shell.test.tsx` (six tabs/order/server badges); `onboarding-stage-items.test.tsx`; Slice 1 query-budget suites. |
| Per-item pipeline inspection/drawer actions | **Preserved** — frozen operation views (`AttentionQueueView`, `OfficialSiteResolutionWorkspace`, `ProcessingView`, `FamilyWaitingView`, `ReviewWorkspace`, `ApprovedView`, `ReadyToExportView`, `OutcomeItemsView`) mount unchanged inside the sole shell. | Existing attention/family/review/approved suites + `onboarding-linear-shell.test.tsx` legacy-destination mounts. |
| `?board=pipeline` deep link | **Retired with notice.** Resolves to the current shell + `retired-diagnostics` notice; never a dead screen. | Retired ledger (all Q=1 rows) + `onboarding-shell-mounts-retired.test.ts` mandatory edge. |
| `VITE_BATCH_WORKSPACE_ENABLED=false` disable branch | **Retired.** Deprecated input is ignored; the sole shell always mounts (Table A mounts-retired: every W=0 row ⇒ `BatchWorkspace`). | Retired ledger (all W=0 rows ⇒ `BatchWorkspace`). |
| `shellV2Enabled=false` fallback | **Retired in Slice 7** — the temporary classic work-state-primary branch is removed (fallback release archived). S=0 is now the emergency disabled-content state (`shell-disabled-notice`: header + rollback instruction, no brand/strip/old navigation). Classic rollback uses the archived matching bridge client. | `onboarding-linear-shell.test.tsx` (disabled-state mounts); retired ledger S=0 rows still pin resolver `content: 'classic'`, rendered as disabled content. |

## 4. Explicitly NOT deleted in Slice 6 (shared-edge / out-of-scope guard)

(Slice 6 guard retained for history. Slice 7 deletion allowlist: §8.)

- `src/client/components/PipelineBoard.tsx` itself (deleted only in Slice 7 per §7).
- Every helper/style/test the board imports (`onboarding-api`, `pipeline-decision-state`, `classification-readiness-view`, `useCohortFamilyState`, stage vocabulary, shared schemas): all have live inbound edges from preserved surfaces. **No wildcard helper deletion;** Slice 7 may delete only exact paths individually approved here with zero remaining inbound edges.
- No server/storage/migration change of any kind in this slice.
- `VITE_REVIEW_UI_V2` semantics/default: untouched (tested noninterference).

## 5. Coverage before/after

- Before: pre-retirement ledger `src/tests/fixtures/onboarding-shell-matrix.json` (650 cases) green against `resolveLinearShell`.
- After: retired ledger `src/tests/fixtures/onboarding-shell-matrix-retired.json` (656 cases: 640 factored + 16 brand-setup/unsupported extras) green against `resolveRetiredShell`; pre-retirement ledger still green (resolver retained); import-graph audit gate green; `onboarding-shell-imports.test.ts` self-tests green; frozen operation suites unchanged.

## 6. Slice 7 production edits (file deletion + fallback retirement)

| Path | Change | Behavior owner |
|---|---|---|
| `src/client/components/PipelineBoard.tsx` | **DELETED** — the only file deletion in this slice (§8 export/coverage diff). | Audit gate (green before AND after) + §8 diff. |
| `src/client/onboarding-feature-flags.ts` | Removed `pipelineDiagnosticsEnabled` (`VITE_PIPELINE_DIAGNOSTICS_ENABLED`): the diagnostics flag is retired with the board file. `?board=pipeline` needs no flag — it always resolves to the shell + `retired-diagnostics` notice. `batchWorkspaceEnabled` stays a deprecated ignored no-op. | `onboarding-feature-flags.test.ts` (removal assertion + exact five-key set). |
| `src/client/components/Onboarding.tsx` | Added the P2 no-batch-selected notice: `?board=pipeline` with no `?batch=` renders the same `retired-diagnostics` notice above the batches list. Retired board/fallback comments to past tense. Selected-batch notice unchanged. | Browser verify (both notice paths) — §7 packet. |
| `src/client/components/onboarding/BatchWorkspace.tsx` | Removed the temporary work-state-primary navigation branch (`ClassicWorkspace` + `TabContent`/`FilteredResultsList`/`ResultRow`/`VALID_WORKSPACE_TABS`/`resolveWorkspaceTab`/`FILTER_PAGE_SIZE` and their pruned imports). `shellV2Enabled=false` is now the emergency disabled-content state (`data-testid="shell-disabled-notice"`: header + rollback instruction, no brand/strip/old navigation). `WorkStateTabs` retained as secondary operation navigation (`LinearSecondaryNav`); all frozen operation views untouched. | `onboarding-linear-shell.test.tsx` (disabled-state mounts) + browser verify. |
| `src/client/components/onboarding/WorkStateTabs.tsx`, `batch-workspace-logic.ts` | Comment-only: secondary-operation ownership after the classic primary branch is removed. No behavior change; helpers (`workspaceTabForCategory`, review-facet guards, `WORKSPACE_TABS`) retained for the secondary nav. | Existing `batch-workspace-logic.test.ts` unchanged-green. |

## 7. Slice 7 coverage after deletion

- Audit gate green before AND after deletion; `onboarding-shell-imports.test.ts` self-tests green; retired + pre-retirement ledgers still green (resolvers untouched).
- `onboarding-feature-flags.test.ts` (five-key set, removal assertion, parser, isolation), `batch-workspace-logic.test.ts`, `onboarding-linear-shell.test.tsx` (incl. disabled-state mounts), brand-gate + strip suites: green or baseline-documented (§7 packet failure ledger).
- Browser verify: final sole shell + both retirement-notice paths (selected-batch and no-batch-selected).

## 8. Slice 7 export/coverage diff (deletion allowlist)

Pre-deletion verification for `src/client/components/PipelineBoard.tsx` (1,501 lines):

- **Exports:** exactly ONE export — `PipelineBoard` (line 173, the diagnostics root component). Every other declaration (`boardStageIs`, `boardColumnFor`, `STAGES`, `STAGE_LABELS`, `STAGE_DESCRIPTIONS`, `STAGE_STATUS_STYLE`, `familyBadgeFor`, `ItemSaveAction`, `ItemDecisionTransportState`, `createEmptyDecisionTransportState`, `deriveProfileFailReason`, `PipelineBoardProps`) is module-local, never imported elsewhere.
- **Production inbound edges:** ZERO (audit gate `0 production edge(s)` before deletion; static/dynamic/re-export/glob/CSS/JSX all clean). No test file imports the board (only synthetic fixture strings inside the audit self-test). The board file imports NO `.css` (no exclusive stylesheet exists; shared `onboarding-workspace.css` stays for the preserved shell).
- **Deleted helpers/styles/tests:** NONE. Reviewed allowlist for helper/style/test deletion is EMPTY — every helper the board once imported stays:
  - `src/client/onboarding-api.ts` — shared typed client used across the shell (live edges).
  - `src/client/pipeline-decision-state.ts` — shared decision helper; NEVER deleted merely because the board once imported it (per §6 Slice 7 rule), even though no other production file currently imports it. Its unit test `pipeline-decision-state.test.ts` is retained.
  - `src/client/classification-readiness-view.ts` — live edges from `CatalogClassificationPanel`, `OnboardingSettings`.
  - `src/client/hooks/useCohortFamilyState.ts` — retained hook module (no production importer today; not a reviewed deletion — dead-code removal is out of scope).
  - Stage vocabulary + shared schemas — canonical authorities, untouched.
- **Unique behavior coverage:** every board behavior was already retired-or-preserved in the §3 ledger (Kanban → server 6×6 matrix + `StageItemsView`; inspection → frozen operation views; deep link → shell + notice). No unique still-needed behavior exports from the board; no frozen component was edited to simplify removal.
