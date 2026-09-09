# Slice 0 — import inventory for the six retiring modules

Scope: every direct consumer of `cohort-curator.ts`,
`cohort-title-coordinator.ts`, `onboarding/cohort-page-coordinator.ts`,
`cohort-title-hash.ts`, `cohort-page-hash.ts`, `cohort-lease-keeper.ts` —
static imports, literal dynamic imports, and `mock.module`/`vi.mock` targets.
Baseline: HEAD `b1782f5`, dirty worktree (see ledger).

## Production importers

| Importer | Imports from retiring modules |
|---|---|
| `src/onboarding/job-queue.ts` (64–65) | cohort-curator execution entry + `CohortShadowObservation` type (the claim-execution seam Slice 2 replaces) |
| `src/onboarding/product-curator.ts` (63–64, 181, 195) | `buildFrozenItem`, `PreparedCohortContext` type (the circular import Slice 1 breaks) |
| `src/onboarding/cohort-name-coordinator.ts` (22) | `normalizeTitleAuthorityString`, `TITLE_AUTHORITY_TRUNCATION` from cohort-title-hash (re-point to pure leaf in Slice 1) |
| `src/onboarding/cohort-page-hash.ts` (83) | cohort-title-hash (shared provenance accessor → pure leaf) |
| `src/onboarding/cohort-title-coordinator.ts` (130, 132, 136) | `computeCohortTitleInputHash`, `titleExecutionTypeAuthorityFromRun`; `CohortLeaseKeeper`; `FrozenProductLineContext` type from cohort-curator |
| `src/onboarding/cohort-page-coordinator.ts` (115, 120–122) | `titleExecutionTypeAuthorityFromRun`; cohort-page-hash bundle types; `coordinateCohortPagesCore` from classification engine |
| `src/classification/cohort-page-coordinator.ts` (2–3, 47) | `PAGE_AUTHORITY_TRUNCATION`, `ExecutionTypeTitleAuthority` type from onboarding hashes (the cross-seam leak; Slice 4 renames + re-points to leaf); exports `coordinateCohortPagesOnce` to `curation-target-processor.ts` |
| `src/classification/cohort-product-type-resolver.ts` (35) | `sourceProvenanceFromMember` from cohort-title-hash (re-point to pure leaf in Slice 1) |

## Literal dynamic imports touching the cluster

- `cohort-curator.ts:857` — `await import('./cloud-vlm-client')` (OCR transport, lazy).
- `cohort-curator.ts:498–499` — `require('./imported-identity')`,
  `require('../shared/stable-id')` (lazy schema/canonicalization load).
- No dynamic import of the six retiring modules themselves was found;
  all cross-module references above are static.

## Test importers / mock targets

Direct test importers of retiring modules: `cohort-freeze`, `cohort-worker`,
`cohort-title-hash`, `cohort-page-hash`, `cohort-title-coordinator`,
`cohort-lease-keeper`, `pr6`–`pr13`-acceptance, `cohort-page-coordinator`
(classification core suite — exercises the engine, NOT the onboarding
wrapper; do not delete by filename analogy), `cohort-page-prompt`,
`e04s02-curation-provenance` (dynamic frozen-item import),
`sourcing-default-on-e2e`, `distributor-scrapers-acceptance`,
`curation-target-processor` (+ `-cohort`, `-product-type-normalization`)
suites, `packaging-ocr-stage`.

Mock registry targets covering the cluster:
- `mock.module('../../onboarding/llm-client')` — title-coordinator,
  pr6–pr13 acceptance, cohort-page-hash suites (transport fakes; preserved).
- `vi.mock('@/onboarding/llm-client')` — classification page-coordinator,
  page-prompt, name-coordinator suites.
- `vi.mock('@/db/repositories/classification-cohort-run-repo')` —
  cohort-lease-keeper suite (heartbeat stub; retired with the suite).
- `vi.mock('@/db/repositories/page-repo')`,
  `vi.mock('@/db/repositories/classification-model-call-repo')`,
  `vi.mock('@/classification/runtime-snapshot')` — page-coordinator/prompt suites.

## Slice implications

- Slice 1 allowlist must include all eight production files above plus the
  two repository files; no other production file statically imports the
  retiring modules.
- Slice 2 worker rewiring touches only `job-queue.ts` import/call sites.
- Surviving suites needing scoped import updates are listed in the plan §5;
  suites not importing moved symbols need no edits.
