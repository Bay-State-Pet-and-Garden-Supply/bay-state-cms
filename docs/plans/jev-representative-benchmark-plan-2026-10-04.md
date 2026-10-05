# Representative Jev benchmark — implementation plan

## Authority and boundaries

Governed by [#293](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/293), [#302](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/302), [acceptance policy](../audits/jev-onboarding-acceptance-policy-2026-10-02.md), `AGENTS.md`, `CONTEXT.md`, and ADRs 0003/0005/0013/0033. Inspected source: `5907853b07d98d233848f48723581afe641eb787`. Supplied compatibility/live-contract results establish plumbing, not representative accuracy; not rerun here.

This session writes only this plan. No code, dataset, DB, routing, credentials, catalog, PR, issue, or commit changes. Preserve concurrent root work and the clean qualification checkout. Collection uses the inventory agent’s findings, not duplicate catalog sampling. Final product approval remains human; #312 stays gated.

## Ordered work

### 1. Repair the evaluation contract before collecting qualifying labels

Touch `src/shared/schemas/classification.ts` (`BenchmarkGoldLabelsSchema`, `FrozenTaxonomySnapshotSchema`), `src/classification/benchmark-scoring-helpers.ts` (`QualificationGoldCore`), `benchmark-prediction.ts`, `benchmark-evaluator.ts`, and `jev-qualification-service.ts` in that same classification directory.

Current gaps: `parseQualificationGoldOnly` minimally validates; attribute `state` is unrestricted and ignored by the Jev set scorer; pages lack uncertainty and empty gold sets are skipped. `BenchmarkGoldLabelsSchema` does not declare the evaluator’s existing `productTypeState`/`fieldStates` markers.

Add versioned, strictly validated per-target known/no-fit/insufficient-evidence/unlabeled states, retaining existing spellings and separate attribute inapplicability. Add page-state/completeness metadata: unknown or partly adjudicated pages must never become a known empty set. Attribute labels remain usable independently of Product Type labeling. Require matching semantic abstention codes; failures never earn correctness. Preserve legacy bytes/readability without qualifying incomplete contracts.

**Accept:** extend `src/tests/unit/benchmark-evaluator.test.ts` and `typesafe-curation-qualification.test.ts` to distinguish every state, partial page uncertainty, omitted targets, service failures, and incorrect abstention codes.

### 2. Freeze real authority; separate metadata from protected payloads

Create `scripts/prepare-jev-benchmark.ts`, defaulting to validation/dry-run. Consume an allowlisted inventory export derived through `src/classification/config-loader.ts::loadRuntimeConfigAuthority` and `page-snapshot.ts::captureVerifiedPageSnapshot`. Bind workspace `5d0e7adf-9e7f-4e23-a59e-267cfd775d0b`, approved v5 release/catalog commit, config hashes, capture time, verified import ID/hash, and all 212 verified Page identities, subject to coherent revalidation.

Retain complete profiles, universals, conditions, cardinality, invariants, aliases, evidence rules/guidance, Page hierarchy and selection scope; current reduced frozen candidates omit some of these. Extend the snapshot contract rather than inventing candidates from gold. Recompute hashes and reject missing authority or mismatched IDs. Do not call `buildRuntimeSnapshot`: it collects reviewed facts and VLM settings.

Add `getDatasetMetadataOnly` in `src/db/repositories/benchmark-repo.ts`, with an explicit read-only connection dependency: aggregate counts/splits/status/hashes/attribution presence only. `getExamples(id, split, {hideGold:true})` still selects full payloads; `initDb` enables WAL. Neither is a safe metadata-only read path. Existing frozen 16-row metadata, stored total zero, and absent adjudications remain an unrepaired blocker, not reusable sealed data.

**Accept:** new `src/tests/unit/jev-benchmark-preparation.test.ts` rejects hash/Page/config drift and proves no sensitive-table, gold-payload, migration, or write access.

### 3. Collect, independently adjudicate, and seal families

After implementation approval, create `docs/audits/jev-representative-v1/{manifest.json,taxonomy.json,development.json,support.json}`. Keep `holdout.json` in custodian-only storage outside Git, shared agent context, and searchable indexes; publish only its commitment and custody metadata.

Collect public manufacturer product pages/package documents only: canonical URL, retrieval timestamp, content hash, exact supporting excerpts, product/variant identity, source locator, and evidence limitations. Bound collection to 1,200 requests, one concurrent request/domain; stop on denial, never bypass access controls. No retailer/catalog assignments or model predictions as gold. Missing facts remain missing; source text is evidence, never instructions. Two independently attributed labelers resolve disagreements against frozen store conventions; unresolved targets stay unlabeled. Agent adjudication is not human product approval.

Before labeling, freeze sampling rules, seed, ratio, and canonical brand/product-line family IDs. Reuse `src/classification/benchmark-exporter.ts::splitForFamily` and `verifyFamilySeparation`; train/test map to development. Group all sizes, flavors, duplicate URLs and related variants together. Custodian audits near-duplicates; never split or rename families to fill quotas. Existing `exportFixtureDataset` is private and DB-writing: expose/reuse its pure validation only, not the historical-assignment exporter.

Target 120 development families and at least `max(200,20K)` labeled holdout examples for K evaluated classes, preferably one primary-scoring example per family. Reserve supplemental mixed cohorts. Publish support by split, independent families, class/profile/target, single/multiple attributes/pages, and food/treat, toy, animal-care, garden/pest, neighbors, no-fit, missing evidence, and mixed-cohort strata. Top up whole families prospectively; unsupported capabilities remain unqualified.

Development labelers may disclose labels. Holdout custodians return aggregate counts/support/citations only, without row-to-label mappings. Seal evidence, labels, membership and adjudication together; exposure invalidates that holdout for subsequent tuning.

**Accept:** preparation/export tests reject leakage, anonymous adjudication and invalid canonical IDs; frozen payload hashes cannot change unnoticed.

### 4. Make replay blind and calibration reproducible

Extend `scripts/typesafe-curation-qualification.ts` with explicit manifest/split, dry-run budget, and publication-bound holdout-release inputs. Currently it hardcodes the fixture and reads all gold before filtering. Development must never open holdout payloads.

Extend `benchmark-prediction.ts::captureQualificationPredictionsLive` to retain per-target raw distributions/P(yes), coded outcomes, exact state/question/candidate hashes, model identity and usage. Existing artifacts collapse attribute/Page uncertainty. Use gold-free prediction inputs; join labels only during scoring.

Add `src/classification/jev-benchmark-replay.ts` as a narrow existing-harness adapter: stage-isolated replay fixes prerequisite type authority; end-to-end replay derives it. Exercise actual singleton/multiple/cohort Page seams in `page-decision.ts` (`resolvePageDecision`, `coordinateCohortPagesWithJev`), not the current singleton-Choice approximation.

Fit policies using development-only family folds; existing 0.50/0.70 floors are not fitted evidence. Publish `development-policy.json` binding code, taxonomy, `jev-1.13.0`, question/threshold meanings, per-capability acceptance criteria and support before holdout release. Any later tuning requires new holdout qualification.

**Accept:** prediction/qualification/preparation tests prove zero holdout reads/dispatches during development, gold-independent predictions, exact provenance binding, and member-local mixed-cohort evidence.

### 5. Bounded execution and release decision

Zero inference now. Propose up to 24 development cases capped at 600 combined provider HTTP attempts; subsequently one qualifying comparison capped at 8,000 attempts, including retries/chunks, concurrency two, two hours. Preflight exact 32-question batching against frozen candidates; never clip candidates. Stop before exceeding caps; at most one transient retry. Operator-provisioned isolated evaluation storage only; no production DB initialization. Record actual usage/cost; unknown pricing remains unknown.

Retain `evaluateJevQualificationGate`/`evaluateQualificationGate`: ≥200 labeled holdout, ≥20/class, ≥0.80 coverage, zero safety/service failures/harmful regressions and positive lower 95% paired `productType.rawCorrectness` delta. Report all stage errors, harms, recovery, set precision/recall, latency and support. No fitted policy is asserted here. **Accept:** qualification tests reject unsupported capabilities and budget exhaustion before further dispatch.

## Validation and residual risks

Register the new Bun suite in `package.json`. Run `bun test --timeout 30000 src/tests/unit/jev-benchmark-preparation.test.ts src/tests/unit/benchmark-{export,prediction,evaluator,qualification,dataset-lifecycle}.test.ts src/tests/unit/typesafe-curation-qualification.test.ts`, `bun run typecheck`, focused ESLint, and `git diff --check`; bind fresh compatibility evidence to changed code.

Residual risks: label disagreement, sparse classes, correlated families, manufacturer-selection bias, incomplete Page semantics, and replay/production mismatch. Public-evidence evaluation does not qualify Sourcing/Extraction or replace source-ready, fully human-reviewed canaries.
