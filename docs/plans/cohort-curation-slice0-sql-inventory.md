# Slice 0 — direct-SQL inventory in `src/onboarding/cohort-curator.ts`

Relocation targets for Slice 1. NO changes in this slice: preserve statement
ordering, CAS predicates, and transaction membership exactly.
Site numbers are statement/query lines (e.g. 934/936 share one `getDb()`
at 933), not `getDb()` call lines.

## Read-only existence / lookup queries → `classification-run-repo.ts`

| Site | Statement | Purpose | Relocation note |
|---|---|---|---|
| 934 | `SELECT 1 FROM classification_model_calls WHERE run_id = ? LIMIT 1` | `childRunHasSideEffects`: model-call side-effect check | Narrow `hasChildSideEffects`-style reader; keep both probes + OR order |
| 936 | `SELECT 1 FROM classification_stage_results WHERE run_id = ? LIMIT 1` | `childRunHasSideEffects`: stage-result side-effect check | Same function as above |
| 2766 | `SELECT id, status FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1` | Latest member child lookup (resume guard) | **Latest child, NOT latest refs-bearing child** — do not substitute the refs query below |
| 3152 | `SELECT id, target_id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?` (`field_assignment`) | Proposal rows for product-type dependency stamping | Same narrow reader family |
| 3193 | `SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?` (`category_page`) | Page proposal ids for dependency stamping | Same narrow reader family |

## Cohort-scoped queries → `classification-cohort-run-repo.ts`

| Site | Statement | Purpose | Relocation note |
|---|---|---|---|
| 2812 | `SELECT config_snapshot_id, config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND config_snapshot_id IS NOT NULL AND config_snapshot_hash IS NOT NULL ORDER BY started_at DESC LIMIT 1` | Prior snapshot refs for rebinding | Reuse `getCohortMemberRunForTitleAudit` only where semantically identical |
| 2819 | `UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?` | Rebind refs onto reused child | Same transaction as today |
| 3288 | `SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND status IN ('completed','completed_with_abstentions') ORDER BY started_at ASC LIMIT 1` | First committed child's snapshot (Brand coherence) | ASC-first ordering is load-bearing |

## In-place member-run repair → `classification-cohort-run-repo.ts`

| Site | Statement | Purpose | Relocation note |
|---|---|---|---|
| 1228 | `UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?` | Backfill refs on side-effect-free member run during resume | Idempotent no-side-effects path only; the side-effect branch (`completeRun` + `createRun`, repo calls already) is unchanged |

## Transaction composition (stays composed via repo ops, never held across `await`)

| Site | Boundary | Purpose |
|---|---|---|
| 1448–1449 | `db.transaction` in final freeze CAS | Only transition `freezing → running`; membership/config/Page/model-authority re-read + compare inside |
| 3095 | `getDb().transaction` in member commit | Atomic CurationData + item completion + child terminal + proposal dependencies |

## Already-delegated writes (no relocation needed)

- Post-loop Brand coherence UPDATEs go through repository
  `writeCohortBrandSemanticUpdates` (line 3382; cohort-atomic, parent
  lease/ownership CAS first statement). Member commit uses repo operations
  `updateItemCurationData`, `updateItemStageStatus`, `completeRun`.
- `cohort-curator.ts` imports `getDb` from `../db/connection` (line 34);
  the ten `getDb()` call sites above are the complete set — no other direct
  SQL exists in this file.
