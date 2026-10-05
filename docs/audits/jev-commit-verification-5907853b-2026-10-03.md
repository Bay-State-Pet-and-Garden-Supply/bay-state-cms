# Jev committed-code verification — 2026-10-03

## Source and isolation

User authorized a local scoped source commit. Created
`5907853b07d98d233848f48723581afe641eb787`
(`fix(classification): harden Jev review and qualification`) with 76 Jev-owned
source, test and audit files. No push was performed. The 86 concurrent
UI/browser-investigation changes present at staging were excluded.

All checks below ran in a new detached checkout of that exact commit. Its
tracked/untracked Git status was clean before and after verification; shared
installed dependencies were linked through the ignored `node_modules` directory.
No runtime changes were copied from the mixed development worktree.

## Commit-bound compatibility

All commands use `bun test --timeout 30000` and the files listed below.

| Required suite | Passed tests | Skipped | Completion time (UTC) |
|---|---:|---:|---|
| other-providers | 144 | 0 | 2026-10-04T00:28:26.074Z |
| deterministic-rules | 189 | 0 | 2026-10-04T00:28:36.048Z |
| frozen-snapshots | 247 | 0 | 2026-10-04T00:28:40.789Z |
| legacy-reads | 117 | 1 | 2026-10-04T00:28:55.213Z |

`bun run typecheck` **passed** on this clean commit. The browser-investigation
null/number error reported in the mixed worktree belongs to the excluded
concurrent changes and is absent from the committed implementation.

### other-providers

- `provider-connection-routing.test.ts`
- `general-task-fallback-telemetry.test.ts`
- `vlm-client.test.ts`
- `llm-client-task-routing.test.ts`
- `classification-policy-writer.test.ts`
- `classification-policy-service.test.ts`
- `classification-policy-routes.test.ts`
- `typesafe-systemone.test.ts`

### deterministic-rules

- `classification-pipeline.test.ts`
- `product-type-verifier.test.ts`
- `curation-applicability.test.ts`
- `curation-applicability-runtime.test.ts`
- `effective-curation-type.test.ts`
- `effective-curation-stages.test.ts`
- `typesafe-product-type-seam.test.ts`
- `typesafe-attribute-seam.test.ts`
- `typesafe-attribute-multi-value.test.ts`
- `typesafe-page-seam.test.ts`
- `typesafe-cohort-page-seam.test.ts`
- `page-import-service.test.ts`
- `release-routes.test.ts`

### frozen-snapshots

- `classification-runtime-snapshot.test.ts`
- `runtime-snapshot-v2.test.ts`
- `cohort-freeze.test.ts`
- `cohort-worker.test.ts`
- `classification-cohort-run-repo.test.ts`
- `type-dependent-refresh.test.ts`
- `proposal-review-service-invalidation.test.ts`
- `classification-refresh-repo.test.ts`
- `classification-currentness.test.ts`
- `reviewed-facts.test.ts`
- `cohort-page-hash.test.ts` — separate process, preserving its mock-isolation contract

### legacy-reads

- `benchmark-prediction.test.ts`
- `benchmark-evaluator.test.ts`
- `benchmark-qualification.test.ts`
- `benchmark-dataset-lifecycle.test.ts`
- `catalog-classification-db.test.ts`
- `onboarding-decision-routes.test.ts`
- `typesafe-curation-qualification.test.ts`

All file paths above are under `src/tests/unit/`.

Strict-schema receipt:
`docs/audits/jev-compatibility-5907853b-2026-10-03.json`.
This certifies the tested commit, not the still-mixed main development worktree.
It is compatibility evidence, not a new live classification or release approval.

## Available benchmark data

Read dataset metadata through the repository, with gold labels hidden. The active
workspace has one frozen dataset, `6b4248f4-23fd-4920-a798-e47f2e3b60d4`:

- Actual rows: 11 train, 1 test, 4 holdout.
- Stored `total_examples`: 0, inconsistent with the actual 16 rows.
- Family-review marker: true; dataset hash present.
- Attributed adjudications: 0; contaminated marker count: 0.

These metadata markers do not establish independently adjudicated gold. The
small historical holdout is already inspected and is not a new sealed holdout.
No gold labels were opened, rewritten or dispatched during this availability check.

## Remaining release work

The code-commit/compatibility prerequisite now has concrete evidence for
`5907853b`. #302 still needs new representative labeled support, fitted
per-capability policies published before its sealed holdout, and source-ready,
human-confirmed type/attribute/mixed-cohort canaries with final approval.
#312 retirement remains gated. The prior development and disablement artifacts
retain their original bytes and meanings.
