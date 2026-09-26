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
5. **Honest Qualification Gates:** Live contract checks and canary gates require actual live credentials (`TYPESAFE_API_KEY`) and live store manager approvals. The system refuses to pass qualification based on mocks, stubs, or absence of errors. Missing prerequisites are reported explicitly as blockers, maintaining `PROVISIONALLY_QUALIFIED` status.

---

## 2. Confidence Concepts: Probability vs. Concentration Confidence

A central architectural requirement of ADR 0033 and Issue #302 is the distinction between **Probability Confidence** and **Concentration Confidence**:

| Dimension | Probability Confidence (System One / Jev) | Concentration Confidence (Chat LLM / Verbalization) |
|---|---|---|
| **Mechanism** | Derived from calibrated probability models (Noul binary probability $P(\text{yes}) \in [0, 1]$; Choice probability distribution over mutually exclusive candidates summing to 1 within $\pm 0.01$). | Derived from chat token generation log-probabilities, softmax entropy over tokens, or verbalized self-assessment ("I am 95% confident"). |
| **Calibration** | Statistically calibrated: an evaluated score of 0.85 corresponds to approximately 85% empirical correctness across representative held-out evaluation sets. | Not calibrated: chat models routinely suffer from verbal overconfidence, sycophancy, temperature distortion, and sensitivity to prompt wording. |
| **Candidate Distribution** | True probability closure: the probabilities across all criteria keys (including explicit abstention options `no_fit` and `insufficient_evidence`) must sum to $1.0 \pm 0.01$, with the selected option matching the distribution argmax. | Pseudo-distribution: output probabilities or rankings reflect language token frequencies, not candidate membership truths. |
| **System Treatment** | Grounded in decision floors: Single Choice threshold ($\ge 0.70$), Multi-Value Noul threshold ($\ge 0.60$), and development-fitted eligibility ($\ge 0.50$). | **Explicitly rejected** as evidence for automated routing or calibration. Never used to justify reduced human review. |

---

## 3. Operator Setup & Connection Configuration

### A. Environment Configuration
Set the TypeSafe API credential in your environment:

```bash
export TYPESAFE_API_KEY="<your-typesafe-api-key>"
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
Run the qualification CLI runner:

```bash
bun scripts/typesafe-curation-qualification.ts
```

For machine-readable JSON output:

```bash
bun scripts/typesafe-curation-qualification.ts --json
```

The script reports:
1. **Product Type Metrics:** Top-1 Accuracy, Coverage, Incorrect Proposals, Regressions against baseline.
2. **Attribute Set Metrics:** Exact match, Precision, Recall, F1 for single- and multi-value attributes.
3. **Category Page Set Metrics:** Exact match, Precision, Recall, F1 for ShopSite page assignments.
4. **Cohort Pipeline Effects:** Stage-isolated accuracy and end-to-end cohort pipeline effects.
5. **Telemetry & SLOs:** Latency (p50, p95) and cost basis per SKU.
6. **Time Disclaimer:** *Explicit disclaimer confirming that model execution latency does not claim operator review-time reduction until measured via review drawer time-tracking.*
7. **Production Qualification Assessment:** Evaluates all 10 criteria and reports specific blockers.

### C. Bounded Live Contract Check
To run an opt-in live check against the TypeSafe API:

```bash
TYPESAFE_API_KEY="<your-typesafe-api-key>" bun scripts/typesafe-curation-qualification.ts --live-check
```

*Note: Without `--live-check` and a valid `TYPESAFE_API_KEY`, the script will intentionally mark live contract checks and canary stages as blocked, keeping production status at `PROVISIONALLY_QUALIFIED`.*

### D. Staged Canary Verification
Canary rollout must proceed in strict order:
1. **Canary 1: Single SKU** — Validate single product classification, attribute extraction, and drawer presentation.
2. **Canary 2: Variant Family** — Validate variant family consistency, attribute inheritance, and independent variant evaluation.
3. **Canary 3: Multi-Item Cohort** — Validate multi-item category page coordination and cohort review workflow.

**Requirement:** Every canary batch must be explicitly reviewed and approved by the Store Manager in the review drawer before proceeding to broader activation.

---

## 5. Troubleshooting & Failure Modes

| Symptom | Probable Cause | Action |
|---|---|---|
| `abstentionCode: service_failure` | HTTP 5xx, network timeout, or TypeSafe API outage. | The model call fails closed; proposal is marked as abstained. Check TypeSafe status. No automatic retry is executed. |
| `abstentionCode: candidate_limit_exceeded` | The number of taxonomy options exceeds 253 candidates. | Jev Choice supports up to 253 ordinary options + 2 abstention options. The system fails closed (first-N clipping is forbidden). Prune taxonomy or group into hierarchical sub-types. |
| `abstentionCode: no_match` | The product does not fit any configured product type or category page (`no_fit`). | Expected semantic abstention. Operator reviews in drawer to either create a new taxonomy node or assign a custom category. |
| `abstentionCode: insufficient_evidence` | Evidence text or package OCR lacks required differentiating details. | Expected semantic abstention. Supplement evidence in Sourcing or proceed with manual drawer entry. |
| `abstentionCode: low_probability` | Top candidate probability fell below threshold ($< 0.70$ for PT, $< 0.60$ for Attributes). | Expected guardrail. Prevents low-confidence hallucination. Operator adjudicates in drawer. |
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
1. Add the new versioned pin to `TYPESAFE_KNOWN_MODELS` in `src/shared/schemas/systemone.ts`.
2. Run the offline benchmark harness against the held-out gold set:
   ```bash
   bun scripts/typesafe-curation-qualification.ts
   ```
3. Verify that non-regression floors hold:
   - Primary Product Type accuracy $\ge$ baseline ($100\%$ on gold holdout).
   - Attribute F1 $\ge$ baseline ($0.88$).
   - Category Page F1 $\ge$ baseline ($0.85$).
4. Update `TYPESAFE_EVALUATED_MODEL` in `src/shared/schemas/systemone.ts`.
5. Update tests and documentation.

### Modifying Question Prompts or Thresholds
- Question instructions and criteria are versioned in `src/classification/model-operation-registry.ts` (`RULE_VERSIONS` and `PROMPT_TEMPLATE_VERSIONS`).
- Changing a question prompt or instructions increments the corresponding rule version, ensuring cache invalidation and immutable audit tracking.
- Lowering confidence thresholds (e.g. below 0.70 for Choice or 0.60 for Noul) requires written justification, ADR approval, and verification that the Wilson lower bound on precision remains $\ge 0.95$.
