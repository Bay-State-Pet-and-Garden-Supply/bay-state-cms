# Worktree code review — 2026-10-06

**Result: three confirmed P2 findings.** The worktree needs corrections before clean verification.

## Scope and authority

- Baseline/HEAD: `e703caa0dc3c8b8d1dc4066c86bb985aa537cc1f`.
- Scope: all uncommitted changes, including untracked files — 72 tracked modifications, 41 new files, 113 total before this report. Index empty.
- Coverage: onboarding shell/preparation/review/approval/draft-export UI and backend; Tier-1 browser investigation and render isolation; readonly connection repositories; Jev secondary-comparison and ShopSite Page evidence scripts; public evidence artifacts; changed tests, configuration and governing documentation.
- Standards: repository/global AGENTS instructions and existing architecture. Spec: #332, #237, #302, ADRs 0034/0038, onboarding operating model and associated plans.
- Scope-content SHA-256: `d1abf015cb4e09fbf089d5fedaf0fc77c1ca8dfcac790bbbb06bb05b313bb59c` (JSON of path/file-SHA pairs sorted by path; excludes this report).
- Independent backend/browser and frontend/spec reviews were consolidated with primary script/artifact review. All three findings below were independently challenged and accepted.

## Findings

### 1. [P2] Make the new usage fixture conform to its input type

**Location:** [`src/tests/unit/browser-investigation-tier1.test.ts:815`](../../src/tests/unit/browser-investigation-tier1.test.ts#L815).

The new test passes `{ ...ledger.toUsage(), modelCalls: null }` to `describeInvestigationCost`. Its input is `InvestigationUsage | null`; an object's optional `modelCalls` member is `number | undefined`, not nullable. Consequently, the required TypeScript check fails even though the runtime assertion can pass.

**Verification:** `bun run typecheck` exited **2**, with the sole diagnostic `TS2322` at `(815,61): Type 'null' is not assignable to type 'number | undefined'`. This test block is absent at `e703caa0`; the failure is introduced in the current review scope, even though it predates the newer Jev changes.

**Correction:** Omit the optional member or use `undefined` in this fixture. The helper's nullable output does not require widening the usage input schema.

### 2. [P2] Bind the preserved gold revision to the capture before asserting unchanged inputs

**Location:** [`scripts/jev-secondary-comparison.ts:75–84`](../../scripts/jev-secondary-comparison.ts#L75).

Rescoring compares the caller-selected `--capture-gold` entries with the current entries after stripping gold. It never proves that the selected revision supplied the evidence used by `--rescore`'s predictions. The live path now writes `evaluatedGoldSha256`, but rescoring never checks it; the existing original capture predates that field. The prediction artifact itself hashes predictions and taxonomy, not source inputs.

If evidence changes while SKUs and taxonomy remain stable, supplying the current or another matching revision as `--capture-gold` passes the comparison and emits `sourceInputsUnchanged: true` while reusing predictions generated from the old evidence. This produces a false provenance assertion and a stale evaluation without requesting fresh predictions.

**Verification:** An in-memory fixture changed one evidence snippet and updated the current manifest's gold SHA. With that revised gold supplied as `--capture-gold`, the actual CLI exited **0**, emitted `sourceInputsUnchanged: true`, and reused the original predictions/artifact identity. The unchanged-input control also succeeded.

**Correction:** Record a canonical, gold-independent source-input digest from the loaded inputs at capture time, before dispatch. Validate the preserved revision and current inputs against that commitment. A legacy capture lacking the commitment must fail this proof or be explicitly marked unverified.

### 3. [P2] Validate prediction integrity before reusing the artifact identity

**Location:** [`scripts/jev-secondary-comparison.ts:46–56`](../../scripts/jev-secondary-comparison.ts#L46), reused at [`81–85`](../../scripts/jev-secondary-comparison.ts#L81).

`evaluateArtifact` validates authority hashes and the SKU set/count, but never recomputes or validates `artifact.artifactHash`. Rescoring then publishes the supplied hash as `sourceArtifactHash` and asserts `predictionsUnchanged: true`. A modified or mismatched capture can therefore be scored under an artifact identity that describes different predictions.

**Verification:** An in-memory copy changed one candidate Product Type to another valid frozen type while retaining the original artifact hash. The actual CLI accepted it, retained hash `088082e0…`, and reported `predictionsUnchanged: true`, while candidate correctness changed from **0.9565 to 0.9130**. `hashQualificationPredictions` explicitly includes `productType` in the semantic hash (`benchmark-prediction.ts:4514`), so this is not an unhashed telemetry change.

**Correction:** Expose/reuse semantic artifact-integrity validation and reject a mismatched hash before scoring or copying its identity. Source-input verification in finding 2 is a separate check: both are necessary.

## Standards and spec assessment

| Axis | Result |
| --- | --- |
| Standards | Finding 1 breaks the typed fixture/verification contract. Findings 2–3 omit validation behind asserted evidence/provenance guarantees. |
| Spec | Findings 2–3 undermine #302's faithful capture/replay and truthful provenance requirements. No additional confirmed introduced bugs were found in the reviewed #332 onboarding or #237 runtime/browser scope. |

There are **three unique findings**, not separate duplicates for each axis. None establishes production qualification; #302 remains blocked and #312 gated.

## Verification evidence

### Primary checks

- `bun run typecheck`: **FAIL, exit 2**, finding 1.
- Actual secondary CLI exercised through a hermetic probe with public fixtures, filesystem replacements/output held in memory, and network requests denied:

| Case | Changed evidence | Changed prediction | CLI exit | Reported inputs unchanged | Reported predictions unchanged | Candidate correctness |
| --- | --- | --- | --- | --- | --- | --- |
| Control | No | No | 0 | true | true | 0.9565 |
| Revised evidence / matching supplied revision | Yes | No | 0 | true | true | 0.9565 |
| Modified prediction / retained artifact hash | No | Yes | 0 | true | true | 0.9130 |

All three cases made **zero network calls**. Probe source:
`/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/jev-secondary-review-probe.ts`.

- Nine checked public corpus/capture/rescore/Page artifact files match their recorded SHA-256 commitments. The two new scripts also match the scope's previously recorded content hashes.
- Public gold: 23 rows, 16 known-type / 7 no-fit; 207 explicit controlled-field states, 16 known / 191 inapplicable.
- Rich Page evidence: all 212 UUID/exported-GUID/name associations match the frozen pool; no duplicate UUIDs; recorded field-presence counts match the records.
- Saved rescore's source-capture SHA matches the original capture. The recorded 40 candidate / 20 comparator requests and 23 candidate / 20 comparator live sides are consistent with the artifacts.

**Documentation precision:** The saved headline stage scores agree, but the complete reports are not numerically identical: `endToEndPipeline.attributeEffects.totalEvaluated` and `eligible` change **17 → 16**, and `unevaluated` changes **0 → 1**. The secondary-comparison audit's “numerically identical” wording should be scoped to its headline stage scores.

### Independent workstream checks

| Check | Observed result |
| --- | --- |
| Browser Tier-1 validation, Vitest | 3 passed |
| Export-draft authority, Bun | 19 passed / 112 expectations |
| Workspace view state / navigation, Vitest | 16 / 18 passed |
| Review approval / request ownership, Vitest | 20 / 4 passed |
| Gap-correction edit guards, Vitest | 3 passed |
| Prepare listing / ready-to-export, Vitest | 27 / 18 passed |
| Linear shell / batch URL, Vitest | 16 / 9 passed |
| Approved logic + review loading/challenger stress, Vitest | 32 passed |

Earlier provider/connection/Page and qualification/replay checks are recorded in the [secondary-comparison audit](jev-secondary-comparison-deepseek-2026-10-06.md): 107 passed / 1 skipped and 124 passed / 1 skipped, respectively. Counts from different checks are not combined into a unique-test total. Full test/lint suites were not rerun for this review.
