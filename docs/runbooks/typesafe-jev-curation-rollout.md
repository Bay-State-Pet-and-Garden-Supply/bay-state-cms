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

A central architectural requirement of ADR 0033 and Issue #302 is the distinction between **Probability Confidence** and **Concentration Confidence**:

| Dimension | Probability Confidence (System One / Jev) | Concentration Confidence (Chat LLM / Verbalization) |
|---|---|---|
| **Mechanism** | Derived from calibrated probability models (Noul binary probability $P(\text{yes}) \in [0, 1]$; Choice probability distribution over mutually exclusive candidates summing to 1 within $\pm 0.01$). | Derived from chat token generation log-probabilities, softmax entropy over tokens, or verbalized self-assessment ("I am 95% confident"). |
| **Calibration** | Statistically calibrated: an evaluated score of 0.85 corresponds to approximately 85% empirical correctness across representative held-out evaluation sets. | Not calibrated: chat models routinely suffer from verbal overconfidence, sycophancy, temperature distortion, and sensitivity to prompt wording. |
| **Candidate Distribution** | True probability closure: the probabilities across all criteria keys (including explicit abstention options `no_fit` and `insufficient_evidence`) must sum to $1.0 \pm 0.01$, with the selected option matching the distribution argmax. | Pseudo-distribution: output probabilities or rankings reflect language token frequencies, not candidate membership truths. |
| **System Treatment** | Grounded in decision floors: Single Choice selected-probability ($\ge 0.50$), Multi-Value Noul P(yes) ($\ge 0.70$), uncertain band ($0.40$–$0.70$), and development-fitted eligibility ($\ge 0.50$). | **Explicitly rejected** as evidence for automated routing or calibration. Never used to justify reduced human review. |

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
The qualification suite evaluates against `src/tests/fixtures/benchmark-jev-qualification-goldset.json`.
- **Entries:** 16 fully adjudicated, representative items covering food, treats, toys, animal care, pest control, lawn & garden, confusing neighbors, unknown types (`no-fit`), and incomplete evidence (`insufficient-evidence`, `unlabeled`).
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
| `--split=dev\|holdout` | Score only one split (default: all 16 entries). |
| `--json` | Machine-readable output; human-readable report otherwise. |
| `--live-capture` | Capture the candidate side from real Jev judgments. Requires `TYPESAFE_API_KEY` (≥ 8 chars); without it the candidate stays `blocked` (`jev_credentials_absent`) — never simulated. |
| `--model=jev-1.13.0` | Requested Jev model for live capture (default: `TYPESAFE_EVALUATED_MODEL`, currently `jev-1.13.0` in `src/ai/systemone-transport.ts`). |
| `--baseline-provider=<p> --baseline-model=<m>` | Capture the baseline side via the incumbent route (deterministic floor first, then the legacy chat ranker). BOTH flags are required; credentials resolve from the existing provider store and unresolvable credentials record `blocked`. |
| `--live-check` (or `TYPESAFE_LIVE_CHECK=1`) | Run the bounded live contract check as a subprocess (requires `TYPESAFE_API_KEY`); its actual result feeds the assessment. |
| `--artifact-out=path` | Write the executed prediction artifact JSON to `path`. |

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
TYPESAFE_API_KEY=... bun scripts/typesafe-curation-qualification.ts --live-capture --live-check --json
```

To capture the incumbent baseline through its real provider path as well,
add both incumbent flags (credentials resolve from the existing provider
store):

```bash
bun scripts/typesafe-curation-qualification.ts --live-capture --baseline-provider=ollama --baseline-model=llama3 --json
```

*Note: Without `--live-check`/`--live-capture` and a valid
`TYPESAFE_API_KEY`, the script intentionally marks the candidate side as
`blocked` (service failures), plus live contract and canary stages as
unmet — production status is `blocked` for candidate quality, NOT
`provisionally_qualified` (see H).*

### D. Staged Canary Verification
Canary rollout must proceed in strict order:
1. **Canary 1: Single SKU** — Validate single product classification, attribute extraction, and drawer presentation.
2. **Canary 2: Variant Family** — Validate variant family consistency, attribute inheritance, and independent variant evaluation.
3. **Canary 3: Multi-Item Cohort** — Validate multi-item category page coordination and cohort review workflow.

**Requirement:** Every canary batch must be explicitly reviewed and approved by the Store Manager in the review drawer before proceeding to broader activation.

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

### H. Status Semantics: `blocked` vs `provisionally_qualified`
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
1. Navigate to **Settings → AI Routing**.
2. Select the stage (e.g. `primary_product_type_proposal`) and switch provider to `ollama` or `openai`.
3. Click **Apply Policy**.
4. Future runs immediately dispatch to the newly selected provider.

### Emergency Connection Disablement
To immediately halt all TypeSafe traffic:
1. Navigate to **Settings → AI Compute**.
2. Toggle the **TypeSafe** connection to **Disabled**.
3. Any subsequent classification dispatch to TypeSafe immediately throws `AiConnectionUnavailableError` without attempting network requests.
4. **Zero Retry & No Implicit Fallback:** The system fails closed into an audited abstention; it will *never* silently fall back to an unconfigured or unapproved provider.

### Provenance Guarantee
Existing and in-flight classification runs are permanently linked to their original `config_snapshot_hash` and `classification_model_calls` audit rows. Changing route settings or disabling connections never alters or rewrites the provenance of historical runs.

---

## 7. Model, Question & Threshold Upgrade Procedures

### Upgrading Jev Model Pins (e.g. `jev-1.13.0` → `jev-1.14.0`)
1. Add the new versioned pin to `TYPESAFE_KNOWN_MODELS` in `src/ai/systemone-transport.ts`.
2. Run the offline benchmark harness against the held-out gold set:
   ```bash
   bun scripts/typesafe-curation-qualification.ts
   ```
3. Verify that the shipped non-regression gates hold (no absolute
   percentages — the gates compare candidate vs baseline on the executed
   artifact):
   - `candidateOutperformsBaseline` is true (candidate raw correctness $\ge$ baseline on Primary Product Type).
   - Zero harmful regressions in every stage (Product Type, Attributes, Category Pages).
   - Zero candidate service failures (`summary.zeroServiceFailures` true — `blocked` sides never evidence quality).
4. Update `TYPESAFE_EVALUATED_MODEL` in `src/ai/systemone-transport.ts`.
5. Update tests and documentation.

### Modifying Question Prompts or Thresholds
- Question instructions and criteria are versioned in `src/classification/model-operation-registry.ts` (`RULE_VERSIONS` and `PROMPT_TEMPLATE_VERSIONS`).
- Changing a question prompt or instructions increments the corresponding rule version, ensuring cache invalidation and immutable audit tracking.
- Lowering confidence thresholds (e.g. below 0.50 for single Choice or 0.70 for multi-value Noul) requires written justification, ADR approval, and verification that the Wilson lower bound on precision remains $\ge 0.95$.
