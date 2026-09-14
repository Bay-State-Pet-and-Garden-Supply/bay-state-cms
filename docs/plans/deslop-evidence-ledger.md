# Deslop evidence ledger (ADR 0036) — trace-verified, 2026-09-14

Fallow 2.54.3, full project. Rule: every deletion needs `trace-file =
UNREACHABLE` **plus** `rg` proving no static / dynamic / test / migration /
docs-as-spec reference. A `trace-file` hit alone is a hypothesis, not a finding.

## Vendor noise (excluded from analysis, never deleted)

- 107 files under `.github/skills/impeccable/scripts/` reported as unused files.
  Vendored skill runtime, not Bay State code. Fix: added `.github/skills/**`
  to `.fallowrc.json` `ignorePatterns` (ADR 0036). Re-run drops reported dead
  files 136 → ~29.

## False positives (fallow UNREACHABLE but provably live — KEEP)

| File | Why live |
| --- | --- |
| `src/extraction-worker/auth.test.ts` | Live vitest entry; imports `./auth`. Test entries are not import targets. |
| `scripts/*.ts` (16 reported) | CLI entries via `package.json` (`dev`, `classification:integrity`, `sourcing:live-smoke`, `verify`, `test:runner-coverage`), docs runbooks, or direct `bun scripts/` invocation. Missing fallow `entry` config, not dead code. Delete only with proof the invoking workflow is obsolete. |
| `docs/plans/cohort-curation-slice0-gen-golden.ts` | Script living under docs; same entry-point gap. Move-or-ignore decision, not a deletion. |

## Blocked orphans (UNREACHABLE but owned by a live plan/migration — KEEP until owner retires)

| File | Blocker |
| --- | --- |
| `src/client/components/LlmTaskConfigPanel.tsx` | Orphaned (mounted NOWHERE) but `docs/plans/classification-v4-activation-and-settings-revamp-plan.md` mandates mounting it under Settings → AI Tasks. Server routes live. Deleting now contradicts the plan. |
| `src/client/components/common/SectionHeader.tsx` | Same plan lists it under "Reuse untouched" shared primitives. Currently unimported; keep as plan dependency. |
| `src/db/repositories/profile-engineer-workflow-repo.ts` | Zero external callers, but `src/db/migrations.ts:4805-4844` maintains `profile_engineer_domain_workflows` live (rename + index). Repo/table retirement needs a migration decision, not a file deletion. |
| `src/onboarding/distributor-copy-consolidator.ts` | `docs/plans/distributor-scrapers-implementation-plan.md:730` says "Do not re-enable" — explicitly deprecated, but the prohibition itself is the spec. Delete only with plan-owner sign-off. |

## Safe first-cut candidates (UNREACHABLE + `rg` clean — verify once more at delete time)

Each needs a final `rg` + `trace-file` re-check immediately before deletion
(names drift fast in this repo):

1. `src/client/components/onboarding/WorkStateTabs.tsx` — no refs outside self.
2. `src/client/hooks/useCohortFamilyState.ts` — no refs outside self.
3. `src/client/components/onboarding/families/family-waiting-logic.ts` — `rg family-waiting-logic` empty (verify `family-waiting` prefix variants).
4. `src/client/components/onboarding/review/ReviewMediaPanel.tsx` — no refs outside self.
5. `src/client/components/LocalAiStatusPanel.tsx` — no refs outside self.
6. `src/db/repositories/handoff-intent-repo.ts` — `ensureHandoffTable` / `persistHandoffIntent` / `handoff_intents` have zero refs outside self; no migration reference. Strongest repo-layer candidate.
7. `src/onboarding/brand-hub/brand-strategy-command.ts` — `saveBrandStrategyCommand` zero refs outside self (confirm vs ADR 0035 strategy-approval write path before deleting).

## Requires owner decision (not in first cut)

- **4 circular deps:** `imported-identity ↔ spreadsheet-parser`,
  `suite-suggestion-service ↔ template-clustering`,
  `store-manager-tools ↔ tool-registry`, `compiler ↔ registry`. Each needs
  extract-shared-module refactoring with behavior parity — separate tickets.
- **53 duplicate exports** (schema-vs-repo doubles: `BrandHubRow`,
  `ExtractorProfile`, `LlmTask*`, `MAX_NORMALIZED_VARIANTS`, …). Canonical
  location per pair needs schema-owner sign-off; mechanical merge risks
  import churn across 654 test files.
- **26 star suppressions** in `.fallowrc.json`: remove file-by-file, most
  suppressed surface first (`classification/*`, `shared/schemas/*`), with
  per-export narrow ignores only where trace proves external entry.
- **42 stale suppressions:** delete the dead `fallow-ignore` comments after
  confirming the finding is genuinely gone (re-run per file).
- **Barrel trim** (`classification/index.ts` 62, `profile-audit/index.ts` 47):
  per-export `trace FILE:EXPORT` + test-import audit; unexport (keep file
  symbol private) preferred over file deletion.

## Validation protocol per deletion batch

1. `bunx fallow dead-code --trace-file <path>` → UNREACHABLE (record output).
2. Three-leg reference search: `rg` for static imports, dynamic patterns
   (`import()`/`lazy(`/`import.meta.glob`/kebab-Pascal variants), tests,
   migrations, and docs-as-spec (`docs/adr/`, `docs/plans/`, `CONTEXT.md`)
   → clean, or a naming plan resolved as stale/superseded with commit evidence.
3. Delete / unexport, one file per commit (bisectability).
4. Per file: no focused tests exist when zero references hold — record the
   `rg` clean output as the test-selection evidence instead.
5. After the batch: `bun run typecheck` + FULL `bun run test` (focused suites
   miss cross-file integration) + `fallow dead-code` re-run **iterated to
   fixpoint** (each deletion can orphan helpers/barrel lines/test-only files).
6. CI gate sequencing: regenerate the baseline quarantine in the SAME PR as
   the deletions, before `fallow audit` gate activation (stale baselines
   false-fail or false-pass).

## Execution record — oracle review 2026-09-14 (GLM-5.3-Flash)

Oracle verdict: standard right-sized (trace + rg + rebuild, not over-kill);
DEFERRED split correct (circulars/dupes are refactors); 6/7 SAFE approve
conditional on the docs leg, 1 hold, 2 reclassifications. Findings:

- `distributor-copy-consolidator.ts`: KEEP-blocked was INVERTED logic — a
  spec-deprecated (`distributor-scrapers-implementation-plan.md:730` "Do not
  re-enable"), unreachable file is exactly what deslop deletes. Reclassified
  delete-pending-owner-ack. Owner ack is acknowledgment of deletion.
- `profile-engineer-workflow-repo.ts`: table liveness (migrations.ts
  ~4801–4856: DDL + lease v2 + index + data migration, zero dependence on the
  repo file) does not imply module liveness. Relabeled dead-but-reserved
  (owner: profile-engineer epic #47/#51 wiring, needs owner + revisit
  condition). The `profile_engineer_domain_workflows` migration/table is LIVE
  and must never be included in any future deletion.
- Docs-leg results: `WorkStateTabs` deletion EXECUTES rewrite-plan Slice 5
  ("Delete … after confirming no imports remain" — confirmed; unmounted by
  linear-shell cutover c33017fb). `ReviewMediaPanel` mount deliberately
  removed by e10 final-gate 2efcbe19 (`-import { ReviewMediaPanel }`,
  `-<ReviewMediaPanel`); rewrite-plan KEEP list is stale inventory.
  `useCohortFamilyState` retirement-inventory retention was scope-based
  ("dead-code removal is out of scope" there); ADR 0036 scopes it in.
  `LocalAiStatusPanel`: v4-settings plan does NOT name it → hold released.
  `handoff-intent`: zero docs hits for file/table/functions.
  `brand-strategy-command`: ADR 0035 write path IS implemented in
  `brand-strategy-approval-repo.ts` (`saveBrandStrategy`); the command file is
  a dead duplicate wrapper → delete, commit notes the ADR gap if any.
- No `import.meta.glob` in `src/client/`; no cross-refs to dead names.

## Skill-directory dispositions (user question, oracle-verified)

- `.agents/skills/` (5 skills, 42 tracked files): KEEP — explicitly wanted,
  gitignore-whitelisted by design.
- `.github/skills/impeccable/` (148 tracked files): KEEP — wired:
  committed `.github/hooks/impeccable.json` invokes its `hook.mjs` (Copilot
  CLI + cloud), `.github/agents/*.agent.md` invoke its scripts, SKILL.md
  consumes root PRODUCT.md + DESIGN.md, `.impeccable/` live state proves use.
  Fallow's 107 flags are the entry-point false-positive class; the
  `ignorePatterns` fix stays regardless. Removal would require an atomic
  owner PR (skill + hooks + agents together), never a deslop deletion.
- `.github/agents/`, `.github/hooks/impeccable.json`: KEEP (same wiring).
- `.claude/`: KEEP the 1 tracked file (`skill-creator`); untracked remainder
  is local-only, out of deslop scope (tracked dead code only).
- `.impeccable/`: untracked, gitignored, out of scope.
- Ownership map added to AGENTS.md so the next agent doesn't re-ask this.
