# TypeSafe Jev Curation Rollout Runbook (Issue #302)

Operator guide and operational authority for qualifying, rolling out, troubleshooting, and rolling back the **TypeSafe Jev Curation** workflow in Bay State CMS.

Scope:
- Curation stage decision-making: Primary Product Type, Controlled Attributes (Single- & Multi-Value), and Category Pages/Cohorts.
- Primary provider: TypeSafe Jev (`jev-1.13.0` via System One transport).
- Authority & governance: ADR 0004, ADR 0013, ADR 0033.

---

## 1. Architectural Principles & Review Boundary

1. **Deterministic Spine:** The onboarding pipeline stages (Sourcing → Discovery → Extraction → Curation → Review → Promotion) remain deterministic. Jev acts as a bounded Curation Assistant, not an autonomous agent.
2. **Propose-Only Authority (`isBulkAcceptable: false`):** Every Jev proposal is marked with `isBulkAcceptable = false`. Bulk-acceptance in the review drawer or automated promotion is forbidden. Every proposal must be explicitly accepted, rejected, or modified by a human operator (Store Manager).
3. **Calibrated Fail-Closed Semantics:** Jev emits structured choices and calibrated probabilities or abstains (`no_fit`, `insufficient_evidence`, `candidate_limit_exceeded`). It never invents unconfigured options, off-catalog URLs, or low-probability guesses.
4. **Frozen Snapshot Discipline:** Classification runs are bound to an immutable runtime snapshot (`RuntimeClassificationSnapshot`). Changing route configuration in workspace settings does not alter running or completed classification runs.
5. **Honest Qualification Gates:** Live contract checks and canary gates require actual live credentials (`TYPESAFE_API_KEY`) and live store manager approvals. The system refuses to pass qualification based on mocks, stubs, or absence of errors. Missing prerequisites are reported explicitly as blockers: `blocked` when offline evidence itself fails (the default no-credential run — the `blocked` candidate side counts as service failures, so candidate quality cannot evidence itself), `provisionally_qualified` only when offline evidence is fully clean and only verification/operational prerequisites remain.

---

## 2. Confidence Concepts: Probability vs. Concentration Confidence

Choice returns a probability distribution over configured outcomes and a separate
**concentration confidence** describing that distribution. Noul returns P(yes),
without a separate confidence. Neither measure grants approval authority.

| Measure | Meaning | Operator use |
|---|---|---|
| Choice selected probability | Probability assigned to the selected option, including an abstention option | A 0.90 insufficient-evidence answer is confidence in abstaining, not confidence in a product value |
| Choice concentration confidence | How concentrated the answer distribution is | Inspect alongside probability; it is not whole-workflow correctness |
| Noul P(yes) | Probability that one candidate value/page applies | Evaluate labels independently; current floor is 0.70 |
| Legacy chat/keyword support | Generated or heuristic support from the comparison implementation | Keep labeled separately; it is not Jev concentration confidence |

Current Choice floor is 0.50. Store-specific calibration and acceptance must be
established from development evidence and a separately qualified holdout. Vendor
probability is not proof of empirical correctness for this store's assortment.

---

## 3. Operator Setup & Connection Configuration

### A. Environment Configuration
Set the TypeSafe API credential in your environment:

```bash
# Never commit a real key. Provide it via the environment only:
export TYPESAFE_API_KEY
```

The server automatically maps `process.env.TYPESAFE_API_KEY` to the `typesafe` provider connection credential during startup.

### B. AI Compute Panel (Settings UI)
1. Navigate to **Settings → AI Compute**.
2. Locate the **TypeSafe** connection card (`typesafe`).
3. Verify connection attributes:
   - **Transport:** `systemone`
   - **Base URL:** `https://api.typesafe.ai/v1`
   - **Trust Zone:** `cloud`
   - **Evaluated Model:** `jev-1.13.0`
4. Click **Test Connection** to execute the live ping/probe against the health endpoint.
5. Ensure the toggle switch is set to **Enabled**.

### C. Route Preview & Apply
1. Navigate to **Settings → AI Routing** or **Classification Policy**.
2. Review stage routes:
   - `primary_product_type_proposal` → `typesafe` (`jev-1.13.0`)
   - `product_attribute_proposals` → `typesafe` (`jev-1.13.0`)
   - `category_page_proposals` → `typesafe` (`jev-1.13.0`)
3. Click **Preview Policy Changes** to verify the route digest and stage transport compatibility.
4. Click **Apply Policy** to commit the policy view.

---

## 4. Offline Evaluation & Canary Verification

### A. Adjudicated Benchmark Goldset
The qualification suite's historical seam fixture is
`src/tests/fixtures/benchmark-jev-qualification-goldset.json`.
- **Entries:** 16 previously inspected fixture items covering food, treats, toys, animal care, pest control, lawn & garden, confusing neighbors, unknown types (`no-fit`), and incomplete evidence (`insufficient-evidence`, `unlabeled`). This is not an independently supported representative release evaluation or a fresh blind holdout.
- **Splits:** Strictly family-separated (`dev` and `holdout`) with verified zero split leakage across brand/product families.
- **Targets:** Primary Product Types, Controlled Attributes (single & multi-value), and Category Pages with verified ShopSite page identities.

### B. Running the Offline Comparison
Run the qualification CLI runner (default is CI-safe and offline: the
baseline side is the deterministic floor, the candidate side is `blocked`
with code `jev_credentials_absent` — the report fails closed by
construction and the assessment status is `blocked` for candidate quality,
NOT `provisionally_qualified`):

```bash
bun scripts/typesafe-curation-qualification.ts
```

For machine-readable JSON output (includes `comparisonReport`,
`assessment`, `predictionArtifact`, `predictionProvenance`, `liveCheck`,
`canary`, `family`, `compatibility`, and `operatorDocs`):

```bash
bun scripts/typesafe-curation-qualification.ts --json
```

Runner flags (all `--flag=value` form except the booleans; the usage line
in `scripts/typesafe-curation-qualification.ts` is authoritative):

| Flag | Effect |
|---|---|
| `--split=dev\|holdout` | Dispatch and score only that split; development execution never sends holdout inputs to providers. Family verification still checks the whole population. |
| `--json` | Machine-readable output; human-readable report otherwise. |
| `--live-capture` | Capture the candidate side from real Jev judgments. Requires `TYPESAFE_API_KEY` (≥ 8 chars); without it the candidate stays `blocked` (`jev_credentials_absent`) — never simulated. |
| `--model=jev-1.13.0` | Requested Jev model for live capture (default: `TYPESAFE_EVALUATED_MODEL`, currently `jev-1.13.0` in `src/ai/systemone-transport.ts`). |
| `--baseline-provider=<p> --baseline-model=<m>` | Request the explicit incumbent chat route. Both flags, a frozen taxonomy, `--isolated-store` and `TYPESAFE_BASELINE_CREDENTIAL_REF` are required. Unavailable or mismatched credentials remain blocked. |
| `--manifest=<path> --gold=<path> --taxonomy=<path>` | Load SHA-bound public development inputs and independently frozen authority. Representative replay is dev-only and refuses private/holdout paths. |
| `--max-attempts=<n> --concurrency=<n> --deadline-ms=<n>` | Candidate request limits: defaults 600 actual HTTP attempts, concurrency at most 2, hard deadline 300000 ms. Finite integer limits are validated before capture. |
| `--baseline-max-attempts=<n> --baseline-deadline-ms=<n>` | Separate incumbent limits, defaulting to the corresponding candidate limits. Its gold-free conservative upper-bound plan must fit before initialization or dispatch; JSON-repair requests consume the same budget. |
| `--isolated-store=<path>` | Existing initialized evaluation database outside all code worktrees. Operational stores and symlink/hard-link aliases are denied before `initDb`; the active connection must match and stay the same instance. |
| `--live-check` (or `TYPESAFE_LIVE_CHECK=1`) | Run the bounded live contract check as a subprocess (requires `TYPESAFE_API_KEY`); its actual result feeds the assessment. |
| `--artifact-out=path` | Create a new immutable prediction artifact in an existing public output directory; existing files are refused before dispatch and creation uses `wx`. |
| `--db=path` | Legacy route-resolution argument; it does not replace the required `--isolated-store` or authorize use of an operational database. |

The script reports:
1. **Product Type Metrics:** Top-1 Accuracy, Coverage, Incorrect Proposals, Regressions against baseline.
2. **Attribute Set Metrics:** Exact match, Precision, Recall, F1 for single- and multi-value attributes.
3. **Category Page Set Metrics:** Exact match, Precision, Recall, F1 for ShopSite page assignments.
4. **Cohort Pipeline Effects:** Stage-isolated accuracy and end-to-end cohort pipeline effects.
5. **Telemetry & SLOs:** Latency basis per SKU (mean/p50/p95 in JSON; Mean/P95 in text) and cost basis.
6. **Time Disclaimer:** *Explicit disclaimer confirming that model execution latency does not claim operator review-time reduction until measured via review drawer time-tracking.*
7. **Production Qualification Assessment:** Evaluates all 10 criteria and reports specific blockers.
8. **Receipt Provenance:** Family proof, compatibility receipt, operator-docs receipt, live-check, and canary sources echoed with provenance (see D–G).

### C. Bounded Live Contract Check
To run an opt-in live check against the TypeSafe API:

```bash
# Requires TYPESAFE_API_KEY in the environment (never inline the value):
bun scripts/typesafe-curation-qualification.ts --live-check
```

To capture real candidate quality (not just the contract probe), add
`--live-capture` — same credential requirement; without the key the
candidate side is recorded as `blocked` (`jev_credentials_absent`), never
mocked:

```bash
bun scripts/typesafe-curation-qualification.ts --split=dev --live-capture --model=jev-1.13.0 --live-check --json
```

To request the incumbent baseline through its real provider path, provision an
isolated evaluation context and an explicit non-secret reference to the
credential it contains. References are `api_keys:<provider>` or
`provider_connections:<connection-id>` and must match the actually resolved
provider/model/source. Endpoint/pin configuration and the frozen policy are
hashed into artifact identity; credentials are not hashed or printed.

For example, after explicitly provisioning an isolated OpenAI evaluation store:

```bash
TYPESAFE_BASELINE_CREDENTIAL_REF=api_keys:openai \
  bun scripts/typesafe-curation-qualification.ts --split=dev \
  --baseline-provider=openai --baseline-model=gpt-4o-mini \
  --isolated-store="$TYPESAFE_ISOLATED_STORE" --json
```

This example does not provision credentials or select a different provider on
failure. A full representative population may exceed the default conservative
preflight: choose an explicitly approved bounded budget before running it.
The capture API itself requires each live leg's budget and deadline; a key
alone returns `jev_runtime_guard_unwired`. The incumbent requires the same
wiring and rechecks credential/configuration and database authority before
requests and audit writes. Missing returned-model identity, mixed model
identities or any failed call remain blocked. Missing token usage remains null.

*Note: Without `--live-check`/`--live-capture` and a valid
`TYPESAFE_API_KEY`, the script intentionally marks the candidate side as
`blocked` (service failures), plus live contract and canary stages as
unmet — production status is `blocked` for candidate quality, NOT
`provisionally_qualified` (see H).*

### D. Staged Canary Verification
Canary rollout must proceed in strict order:
1. **Product Types** — representative types, no-fit and insufficient-evidence outcomes.
2. **Controlled attributes** — applicable single/multiple values and variants.
3. **Category Pages/cohorts** — verified singleton assignments and actual frozen multi-item coordination.

Final Store Manager review/approval is retained. Terminal review can replace the
drawer for proposal decisions, with the same review service and attribution:

```zsh
bun scripts/review-canary.ts --batch "Jev Canary — goldset-16" --reviewer nick
```

The command shows field names, mapped ShopSite slots, evidence, conflicts and
existing accepted pages. Corrections preserve identity/cardinality. Type review
refreshes dependent attributes/pages from frozen evidence without replaying OCR,
naming or Product Type. Failed/concurrent refreshes do not erase valid proposals.
Incompatible historical plans require a fresh run.

An agent can apply explicitly enumerated decisions. These are stamped
`agent_review`, never impersonate the operator, and require final human
confirmation. They do not qualify human receipts or item approval:

```zsh
bun scripts/review-canary.ts --decisions-file docs/audits/jev-agent-review-decisions-2026-10-02.json --list-only
```

Receipts require actual attributed human decisions, including abstentions.
Empty/no-run queues cannot pass; singleton pages do not certify a cohort canary.
Hand-seeded synthetic items lack real extraction bindings and cannot qualify the
worker. Seeders hold new fixtures and never disable freeze/provenance guards,
replace pins or reconfigure credentials.

**Recording sign-offs** (fail-closed default: absent = unreviewed blockers).
Following the canary-receipt pattern — a receipts file and/or env flags,
echoed with provenance in `--json` (`canary.source`) and the text report:

```bash
# Option 1: receipts file (booleans; unreadable file warns and stays unreviewed)
export TYPESAFE_CANARY_RECEIPTS_PATH=/tmp/canary-receipts.json
# {"productTypeReviewed": true, "attributesReviewed": true, "cohortPagesReviewed": true}

# Option 2: env flags (layer on top of the file when both are present)
export TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED=1
export TYPESAFE_CANARY_ATTRIBUTES_REVIEWED=1
export TYPESAFE_CANARY_COHORT_PAGES_REVIEWED=1
```

### E. Family-Separation Proof (automatic)
The runner proves dev/holdout isolation live on every run via the shipped
`verifyFamilySeparation` (`src/classification/benchmark-exporter.ts`) over
the loaded gold entries — shared family identity plus cross-split
near-duplicate detection, proof version `family-separation-v1`. No operator
input is required or accepted; a failing proof (or verifier error) keeps
the fail-closed `family_separation_unverified` blocker. The `--json`
`family` section echoes the proof (`proofVersion`, `familiesChecked`,
`passed`, leak/duplicate counts) and the text report shows a
`Family proof:` line.

### F. Compatibility Receipt (operator-recorded)
The runner cannot re-run the already-green seams itself, so compatibility
is operator-attested: a receipts file the runner reads, validates, and
echoes with provenance. Absent or malformed input keeps the fail-closed
`compatibility_unverified` blocker — malformed receipts are never silently
accepted (a stderr warning names the defect).

Receipt shape (all four suite ids from `REQUIRED_COMPATIBILITY_SUITE_IDS`
in `src/classification/jev-qualification-service.ts`, each with the commit
it passed on, plus the time it was recorded):

```json
{
  "suites": [
    {"suiteId": "other-providers", "commit": "<git-sha>", "passed": true, "executedAt": null},
    {"suiteId": "deterministic-rules", "commit": "<git-sha>", "passed": true, "executedAt": null},
    {"suiteId": "frozen-snapshots", "commit": "<git-sha>", "passed": true, "executedAt": null},
    {"suiteId": "legacy-reads", "commit": "<git-sha>", "passed": true, "executedAt": null}
  ],
  "recordedAt": "2026-09-28T00:00:00.000Z"
}
```

Inputs (inline env JSON wins when set; otherwise the file; otherwise
absent — an explicitly malformed env value blocks without falling back to
the file):

```bash
# Option 1: receipts file
export TYPESAFE_COMPAT_RECEIPTS_PATH=/tmp/compat-receipts.json

# Option 2: inline JSON (same shape as above)
export TYPESAFE_COMPAT_RECEIPT_JSON='{"suites": [...], "recordedAt": "..."}'
```

**Recording / refreshing:** after the four suites pass, write the file with
the current commit (`git rev-parse HEAD`) and timestamp
(`date -u +%Y-%m-%dT%H:%M:%SZ`). Refresh on every change under test.
Commit-bound (fail-closed): the runner resolves the expected commit as the
current HEAD (or `TYPESAFE_QUALIFIED_COMMIT` when explicitly qualifying a
recorded digest) and requires EVERY suite commit to equal it — a stale green
receipt for an older commit retains the `compatibility_unverified` blocker
with a mismatch message (`compatibility receipt bound to …; expected …`),
never silently current. Re-qualifying at a newer commit with a stale file
still echoes the old commit and stays blocked until the suites re-pass at the
new commit. The file carries no secrets (suite ids, commit SHAs, booleans,
timestamps) and is safe to commit alongside the qualification.
The `--json` `compatibility` section echoes the receipt, source,
`expectedCommit`/`expectedCommitSource`, and per-suite `suiteId@commit`
detail; the text report shows a `Compatibility:` line with the expected
commit.

### G. Operator-Docs Receipt (automatic, live-bound)
The runner binds qualification to the exact published runbook bytes: on
every run it hashes
`docs/runbooks/typesafe-jev-curation-rollout.md`
(`OPERATOR_RUNBOOK_PATH`) with SHA-256 and passes
`{runbookPath, contentHash, publishedAt}` as the receipt. Any doc edit
changes the hash, so prior `--json` outputs (which echo the full hash) are
visibly invalidated. An unreadable runbook keeps the fail-closed
`operator_docs_missing` blocker with a stderr warning. The `--json`
`operatorDocs` section echoes the receipt; the text report shows an
`Operator docs:` line.

### H. Operational evidence and release identity

Policy publication and disablement are fail-closed evidence inputs. They are not
assumed passed because the implementation or a test file exists. Record actual
results and supporting artifact references, then provide
`TYPESAFE_OPERATIONS_RECEIPTS_PATH` with booleans
`policiesPublishedBeforeHoldout` and `connectionDisablementVerified`.
Do not set either true without performing and retaining the corresponding work.
The published acceptance policy is
`docs/audits/jev-onboarding-acceptance-policy-2026-10-02.md`.

The CLI also executes the existing conservative raw benchmark gate on the labeled
holdout: at least 200 holdout examples, at least 20 per evaluated class, coverage
at least 0.80, zero safety/controlled-value violations, and a positive lower 95%
bound on the paired primary-metric improvement. Raw source and frozen snapshot
must match; provider failures keep the gate unqualified. These existing floors
are a necessary statistical gate, not proof of every capability's fitted policy
or of representative assortment coverage. Tiny fixture success and operational
checkboxes cannot clear `statistical_gate_failed` / `statistical_gate_unverified`.

Predictor `code-executed-v7` binds coded semantic abstentions into the immutable
artifact hash. A low-probability refusal is not a correct no-fit answer, and an
insufficient-evidence answer is not a no-match answer. Unlabeled rows earn no
accuracy credit. The paired primary metric is `productType.rawCorrectness` over
the labeled fixed population, including abstentions, rather than only the subset
answered by both providers. It also binds the verified incumbent credential
reference and non-secret route identity, using actual provider-returned model
metadata. Older v5/v6 artifacts stay readable and retain their bytes.

A development-only comparison cannot qualify release. A dirty runtime worktree
cannot be certified by a receipt naming HEAD: the CLI reports
`qualified_code_uncommitted` until reviewed code is committed and tested there.
Dependent review refreshes consume human review, so their outputs cannot be
recaptured as raw pre-review predictions (`post_review_refresh`). Original
immutable prediction artifacts remain readable.

### I. Page sync and local OCR

Page download explicitly requests `Name`, `File name`, `Page ID`, and `Title`
using documented XML compatibility version 14.0. Merchant default field
selection can return hundreds of empty/name-only records; unnamed records are
rejected instead of inventing assignment pages. Preview/activate a fully verified
download through the existing import workflow. No page upload or publishing is
performed by this procedure.

The local workspace's `visionOcr` route is now explicit local-only
`onboarding-ocr-local` / `qwen2.5vl:latest`, with no cloud fallback. Default OCR
was verified on a real package image without route/transport overrides, including
materialization as `visual_product_evidence`. Old frozen routes remain frozen.
Transport success proves plumbing, not perfect transcription or interpretation.
Review raw visible text and unsupported structured claims independently.

### J. Status Semantics: `blocked` vs `provisionally_qualified`
- `qualified`: zero blockers.
- `provisionally_qualified`: offline evidence itself is clean
  (`candidateOutperformsBaseline`, zero harmful regressions in every stage,
  zero candidate service failures) but verification/operational blockers
  remain (family, live credentials/contract, canaries, compatibility,
  operator docs).
- `blocked`: offline evidence itself is incomplete or failed (missing
  report, offline failure, regressions, service failures).

Consequence: the default no-credential run is `blocked` — the candidate
side is `blocked` (`jev_credentials_absent`), which counts as service
failures, so `offlineEvaluationPassed` is false and
`provisionally_qualified` is unreachable until real candidate evidence
(`--live-capture` with `TYPESAFE_API_KEY`) plus clean deltas exist.

---

## 5. Troubleshooting & Failure Modes

| Symptom | Probable Cause | Action |
|---|---|---|
| `abstentionCode: service_failure` | HTTP 5xx, network timeout, or TypeSafe API outage. | The model call fails closed; proposal is marked as abstained. Check TypeSafe status. At most one bounded transient retry runs inside the operation deadline; persistent failures abstain. |
| `abstentionCode: candidate_limit_exceeded` | The number of taxonomy options exceeds 253 candidates. | Jev Choice supports up to 253 ordinary options + 2 abstention options. The system fails closed (first-N clipping is forbidden). Prune taxonomy or group into hierarchical sub-types. |
| `abstentionCode: no_match` | The product does not fit any configured product type or category page (`no_fit`). | Expected semantic abstention. Operator reviews in drawer to either create a new taxonomy node or assign a custom category. |
| `abstentionCode: insufficient_evidence` | Evidence text or package OCR lacks required differentiating details. | Expected semantic abstention. Supplement evidence in Sourcing or proceed with manual drawer entry. |
| `abstentionCode: low_probability` | Top candidate probability fell below threshold ($< 0.50$ for Product Type / single-value Choice, $< 0.70$ for multi-value Noul). | Expected guardrail. Prevents low-confidence hallucination. Operator adjudicates in drawer. |
| `AiMisconfigurationError: Model mismatch` | Provider returned a model name differing from requested pin `jev-1.13.0`. | Pinned model substitution is forbidden. Check provider connection model settings. |
| `HeartbeatLostError` | Run execution lease expired during long dispatch. | The run immediately fails closed without writing uncommitted proposals to avoid race conditions. |

---

## 6. Disablement & Rollback Procedures

### Instant Route Rollback
If Jev Curation needs to be deactivated for any stage:
1. Navigate to **Settings → AI Compute → Classification Stage Providers**.
2. Select the stage (e.g. `primary_product_type_proposal`) and switch provider to `ollama` or `openai`.
3. Click **Preview Changes**, inspect the effective routes and sharing effects,
   then **Apply Classification Policy**.
4. Future runs immediately dispatch to the newly selected provider.

### Emergency Connection Disablement
To immediately halt protected TypeSafe Curation dispatches:
1. Navigate to **Settings → AI Compute**.
2. Toggle the **TypeSafe** connection to **Disabled**.
3. Every protected classification attempt reads the current stored enabled state,
   including a retry after backoff. A captured enabled connection cannot bypass
   a later disablement. Disabled/missing/unreadable authority fails closed before
   further network use; an already dispatched request cannot be recalled.
4. **No further retry or implicit fallback:** The system records an actionable
   unavailable/policy-denied outcome. It never substitutes an unconfigured or
   unapproved provider. The same attempt boundary rechecks the execution lease.

`docs/audits/jev-disablement-v2-2026-10-03.json` records a controlled live HTTP
exercise with an isolated database: zero requests when disabled initially, one
request followed by a denied retry after stored disablement, and one request
followed by a denied retry after lease loss. This exercise uses no network mocks
and performs no vendor inference or production-connection mutation.

### Provenance Guarantee
Existing and in-flight classification runs are permanently linked to their original `config_snapshot_hash` and `classification_model_calls` audit rows. Changing route settings or disabling connections never alters or rewrites the provenance of historical runs.

---

## 7. Model, Question & Threshold Upgrade Procedures

### Upgrading Jev Model Pins (e.g. `jev-1.13.0` → `jev-1.14.0`)
1. Add the new versioned pin to `TYPESAFE_KNOWN_MODELS` in `src/ai/systemone-transport.ts`.
2. Fit the proposed model/question/probability policy on development examples:
   ```bash
    bun scripts/typesafe-curation-qualification.ts --split=dev
   ```
3. Publish the proposed acceptance policy before inspecting a new family-separated
   holdout. Evaluate that holdout with the conservative statistical gate and
   stage-specific non-regression checks:
   - `candidateOutperformsBaseline` is true (candidate raw correctness $\ge$ baseline on Primary Product Type).
   - Zero harmful regressions in every stage (Product Type, Attributes, Category Pages).
   - Zero candidate service failures (`summary.zeroServiceFailures` true — `blocked` sides never evidence quality).
4. Activate the new pin only after reviewed qualification, compatibility checks
   and canaries pass. Do not use an already inspected fixture as a new sealed holdout.
5. Update version/hash tests and operating documentation; old runs remain attributable.

### Modifying Question Prompts or Thresholds
- Question instructions and criteria are versioned in `src/classification/model-operation-registry.ts` (`RULE_VERSIONS` and `PROMPT_TEMPLATE_VERSIONS`).
- Changing a question prompt or instructions increments the corresponding rule version, ensuring cache invalidation and immutable audit tracking.
- Lowering outcome-probability floors (e.g. below 0.50 for single Choice or 0.70 for multi-value Noul) requires written justification, ADR approval, and verification that the Wilson lower bound on precision remains $\ge 0.95$.
