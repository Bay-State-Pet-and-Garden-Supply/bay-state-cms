# ADR 0039: bay-state-v9 Activation, Bound Qualification Captures, and Partitioned Candidate Dispatch

- **Status:** Accepted (2026-10-07, issue #302 bullet 9).
- **Supersedes (narrowly, never rewrites):** the "Qualification & Release Framework
  (2026-09-25, Issue #302)" appendix of ADR 0033 — specifically its 16-entry-only
  goldset description, its `code-executed-v7` predictor with no source-input
  commitment, and its unpartitioned (single shared request state) candidate-dispatch
  assumption. Those ADR 0033 passages remain verbatim history; where they conflict
  with the behavior below, this ADR governs. All other ADR 0033 decisions
  (deterministic spine, propose-only authority, fail-closed semantics, staged
  authority gates) stand unchanged, as do ADR 0004 (replaceable stages) and
  ADR 0013 (cohort-centric, type-first curation).

## Context

Since ADR 0033's qualification appendix was written, three shipped changes moved
the ground under it, each verified against committed code and frozen artifacts:

1. The store's live classification authority is now `bay-state-v9`
   (`storage/catalog/store/classification/state.json`: `activeTaxonomyRevision =
   "bay-state-v9"`), not any earlier release. v9 carries 74 classifiable product
   types (`src/classification/releases/bay-state-v9/hierarchy.json`), an
   18-value species vocabulary, and `safety-toe-type` with `exportDisposition:
   not_exported` and no export mapping (retired export intent).
2. Qualification captures moved to predictor `code-executed-v8`
   (`QUALIFICATION_PREDICTOR_VERSION` in `src/classification/benchmark-prediction.ts`),
   which binds a capture-time source-input commitment (`sourceInputsHash`, via
   `hashQualificationSourceInputs`) into the artifact digest. Rescoring is now a
   verify-or-refuse contract (`assertQualificationArtifactIntegrity`): v7
   (pre-commitment) artifacts are refused with a rerun message, never re-scored
   as current, and a recomputed commitment for changed evidence no longer
   verifies against the original predictions.
3. The candidate live leg dispatches one request series per target-permitted
   evidence group (`partitionCandidateQuestionsByPermittedEvidence`,
   `dispatchPartitionedCandidateGroups` — production parity), superseding the
   legacy single shared request state. The dev-replay budget preflight plans
   per-group chunk sums, which can only overestimate live batches, never
   undercount them (conservative by construction; over-budget replays are
   denied before dispatch).

Alongside these, the representative development corpus froze at v9
(`docs/audits/jev-representative-v9/`, 23 rows: 16 known-type / 7 no-fit, with
an independent peer re-derivation receipt), and the Earth Rated leash-clip
adjudication settled the standing accessory-vs-member boundary rule
(`docs/audits/jev-representative-v9/adjudication-brief-leash-clip.md`).

## Decision

1. **v9 is the qualification authority.** Offline evaluation, replay budgets, and
   canary evidence bind to `bay-state-v9` (74 types, species 18,
   safety-toe-type retired). Earlier-release behavior described in ADR 0033 is
   history, not authority.
2. **Captures are bound and versioned.** New captures use `code-executed-v8`
   with the source-input commitment in the digest. Legacy v7 artifacts stay
   readable as bytes but are refused for scoring — rerun live capture. No
   silent acceptance, no re-score-as-current.
3. **Dispatch is partitioned; budgets stay conservative.** Candidate questions
   dispatch per target-permitted evidence group. The replay planner's per-group
   chunk accounting is an upper bound on live cost — a planned fit guarantees
   the live run fits; a planned overage denies before dispatch.
4. **Accessory-vs-member boundary rule.** Classify an accessory by what it is,
   not merely by what it supports: assign a product type only when its stated
   scope includes the accessory itself, otherwise return no-fit. The leash-clip
   dispenser row (gold no-fit, both providers guessed `dog-waste-bags`) is the
   canonical hard negative. Wording-level no-fit re-scoping and its
   fixed-population re-evaluation belong to implementation work, never to
   gate-lowering or gold relabeling by model vote.
5. **v9 corpus freeze discipline.** The 23-row peer-verified v9 corpus is the
   representative development corpus; it is append-only by supersession — a new
   generation supersedes it with a fresh peer receipt, rows are never appended
   to the frozen corpus. The 16-entry qualification seam fixture
   (`src/tests/fixtures/benchmark-jev-qualification-goldset.json`) remains the
   runner's historical CI fixture, not a representative evaluation.
6. **Confidence language is unchanged.** Choice selected-probability vs.
   concentration confidence vs. Noul P(yes) semantics from ADR 0033 / the
   rollout runbook carry forward verbatim; the leash-clip counterfactual (0.60
   and 0.85 confidences, both wrong) is now the standing operator example that
   vendor probability is not empirical correctness.

## Consequences

- The operator runbook (`docs/runbooks/typesafe-jev-curation-rollout.md`) is
  updated to v9 authority, v8 predictor/rescore contract, partitioned dispatch
  with conservative budgets, the boundary rule, and the v9 corpus freeze — with
  every new claim spot-checked against the sources named above.
- Corpus expansion toward qualification scale (200-row sealed holdout,
  20-per-class support) measures future implementation repairs; it does not
  pre-judge them, and blocked verdicts stand until the gates clear.
