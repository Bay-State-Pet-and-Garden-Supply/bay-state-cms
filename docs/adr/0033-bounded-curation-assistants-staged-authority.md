# ADR 0033: Bounded Curation Assistants with Staged Authority

- **Status:** Proposed (2026-08) — drafted during structured design grilling; implementation is gated on the acceptance milestones below and does **not** proceed on this document alone.
- **Reconciliation (2026-09-22, spec #293):** the owner-approved scope is the TypeSafe-Jev product-type-first Curation program: Curation decisions (Product Types, controlled Product Attributes, Category Pages), selectable providers (TypeSafe alongside existing chat providers), reviewed-only proposal authority, deterministic/cohort architecture preserved, and truthful evaluation. This ADR's first-slice wording (catalog-adjudication hardening, 1,500-LOC cap) does **not** describe that larger program — the cap and slice plan below bind only the original adjudication slice. The #293 program carries **separate bounded budgets per delivery ticket** (#295 connect, #296 settings routes, #297+ stage adapters, benchmark/evaluation tickets), each sized in its ticket. Nothing here authorizes automatic approval, reduced human review, or an agent architecture; those remain explicit non-goals. Policy-only editing boundary: Settings writers may change workspace model-policy and data-sharing documents (plus manifest metadata) under configuration locking/CAS with an exact changed-file allowlist; taxonomy content, origins, catalog attestations, and freeze guards are untouched and fail closed when violated.
- **Basis:** Three-angle research pass (external evidence, repo scout, practical tradeoffs) plus independent oracle advisory, 2026-08-25. Key external anchors: Anthropic *Building Effective Agents* (workflows-vs-agents criterion), Amazon catalog generator–evaluator consensus pattern, Skyvern selector-first/AI-fallback, Brain.co agent→pipeline rollback post-mortem.
- **Numbering note:** ADR number 0032 was used by an untracked cohort-cutover record that was removed after its cutover completed (the single-path lesson it documented still binds — see Constraints). This document takes 0033 to avoid collision with that history.
## Decision

We will **not** build a new agent-focused onboarding architecture. The deterministic pipeline remains the execution spine. LLM intelligence is reintroduced only as **bounded capabilities called Assistants**, productized inside existing seams:

1. **Vocabulary:** these capabilities are **Assistants** — bounded, schema-validated LLM steps that select from constrained options or abstain. Not agents; no autonomous loops, tool inventories, registries, or orchestrators.
2. **First slice — Catalog Adjudication Assistant.** Operator correction time in the review drawer is dominated by wrong Primary Product Type / Category Page assignments (measured by operator report; see Baseline). The Assistant hardens the existing `primary-product-type` / `category-page-proposals` classification stages (ADR 0004 composition) rather than adding a subsystem.
3. **Staged authority (propose → earn auto):** at ship, the Assistant fills drafts **propose-only** — every item still passes the review drawer. Auto-advance is unlocked later by changing one authority constant/policy threshold once the gate in Acceptance holds. Same code path throughout; no dual-mode branch.
4. **Baseline instrumented going forward:** every operator correction of an Assistant-filled type/category field is recorded (proposed value vs. final value vs. correction reason) and becomes the task-specific golden set. Implementation waits for the instrumentation milestone; there is no retroactive baseline.
   - **Label semantics:** an approved item whose type/category fields were left untouched counts as a *correct* label; corrections count as incorrect. This maximizes labeled volume from day one; the known rubber-stamping bias is mitigated by the operational kill thresholds (gate 4) rather than by weighted scoring.
   - **Correction reasons:** captured as a small coded enum (e.g., wrong-type-sibling, should-be-untyped, wrong-page-level, store-data-stale) plus an optional free-text note. Enumerated reasons feed directly into eval hard-negative categories.
5. **Abstention is blank-plus-reason:** when the Assistant cannot classify within constraints it writes **no value** and records a coded abstention reason for the drawer (extends the `value-gap-abstain.ts` precedent and the existing *Unknown Primary Product Type* concept). It never emits a low-confidence guess, and deterministic first-pass values are not silently substituted.
6. **Refused outright:** agent registry, generic tool runtime, event-log/budgets subsystems, agent UI, new orchestrator, permanent shadow/dual orchestration paths, runtime LLM extraction (layers 5–8 remain discarded per ADR 0030/0031).

## Pipeline boundary (binding)

| Stage | Boundary |
|---|---|
| Sourcing | Fully deterministic (unchanged) |
| Discovery | Deterministic retrieval/ranking; bounded shortlist adjudication only (hardening of existing calls) |
| Extraction | Deterministic profile execution; no runtime LLM extraction |
| Curation | **Assistants live here**: bounded naming + constrained catalog adjudication |
| Review | Human authority; corrections feed Assistant baselines |
| Promotion | Deterministic validation + writes (unchanged) |
| Variant selection, identity qualification, image rights | Always deterministic/fail-closed (unchanged) |

## Constraints inherited

- **Single-path rollout** (the removed ADR 0032's binding lesson): offline replay → fully reviewed canary cohorts → canonical activation; temporary rollout gating is removed after acceptance; rollback is kill-to-abstain or code revert, never a maintained legacy path.
- **Frozen cohort semantics:** Assistant calls execute inside the frozen evidence window (`freezeCohortForExecution`) so inputs stay reproducible and hash-checked.
- **Provenance:** curation Assistant calls use the run-bound audited variant (`callLlmForTaskWithProvenance`) writing model-call rows. (Known gap, out of scope here: discovery helpers still route through plain `callLlmForTask` sharing the `product_name_consolidation` task identity.)
- **Bounded execution:** one primary model call + at most one schema-repair call per item per field; fixed inputs; no recursive planning, model-selected retries, memory, or specialist-to-specialist dispatch; explicit token/latency/concurrency budgets per capability.
- **Constraint revalidation:** model output is accepted only if it names a currently-configured Product Type enum value or existing Category Page identity; anything else deterministically abstains.

## Acceptance gates (adopted from the oracle advisory)

1. **Task-specific frozen evaluation:** versioned, content-addressed held-out set including hard negatives, ambiguous variants, unknown brands, malformed model outputs; no regression on deterministic exact-match cases.
2. **Authority gates:** auto-advance requires a **Wilson lower bound ≥ 0.95 on exact-value precision** (95% confidence) over accumulated reviewed history. The proposal-only phase must show **≥ 20% reduction in median operator time** or **≥ 15 percentage-point recovery of correctly resolved abstentions** without material quality regression before auto-advance is even considered.
3. **Hard safety invariants:** zero off-shortlist URLs, out-of-enum values, invented taxonomy IDs, LLM variant guesses, unauthorized profile activation, rights decisions, or promotion writes — enforced by property/fuzz tests proving constraint violations deterministically abstain.
4. **Central kill switch:** checked in `src/onboarding/llm-client.ts` before queueing and immediately before transport; dominates task config and frozen model routes. Disabled capability ⇒ audited `abstained/unavailable` outcome routed to Review; never falls back to a legacy path or generic provider chain. Immediate kill on any safety-invariant violation; operational kill when, over the latest 100 reviewed outputs, reviewer rejection > 10%, invalid/timeout > 5%, or declared cost/latency SLO breached.
5. **Self-reported model confidence is never treated as calibrated evidence** for routing; routing uses measured history and deterministic signals only.
6. **LOC budget:** the complete first slice (instrumentation capture, stage hardening, drawer UI, eval-harness reuse) is capped at **≤ 1,500 LOC** including tests. Exceeding the cap requires revisiting this ADR before continuing — the binding constraint from ADR 0030 is value-per-LOC.

## Non-goals

- Reintroducing any part of the decommissioned Agent Lab runtime (ADR 0030 stands).
- Title-synthesis changes (Cohort Naming Assistant is a possible later slice, explicitly deferred).
- Discovery/Profile-assistant slices — deferred until the catalog adjudication slice proves the pattern.

## Next artifacts required before implementation

1. Instrumentation spec: operator-correction capture (schema via repository pattern) for type/category fields in the review drawer.
2. Eval specification + initial golden set derived from the first instrumented batches.
3. Authority-threshold config design (one-constant flip, mirroring the packaging-ocr rollout runbook pattern).

## Qualification & Release Framework (2026-09-25, Issue #302)

The qualification and release framework for TypeSafe Jev across Primary Product Type, Controlled Attributes (Single- & Multi-Value), and Category Pages/Cohorts is complete:

1. **Family-Separated Adjudicated Benchmark (`benchmark-jev-qualification-goldset.json`):** 16 representative, adjudicated entries covering food, treats, toys, animal care, pest control, lawn & garden, confusing neighbors, unknown types (`no-fit`), and incomplete evidence (`insufficient-evidence`, `unlabeled`). Strict family separation between `dev` and `holdout` splits with verified zero split leakage.
2. **Offline Comparison Engine (`src/classification/jev-qualification-service.ts`):** Evaluates candidate vs. current-provider baseline across raw correctness, coverage, incorrect proposals, regressions, multi-value attribute set metrics (precision, recall, F1), category page set metrics, latency (p50, p95), cost, and end-to-end cohort pipeline effects. Disclaims operator review-time gains until empirical time-tracking in the review drawer confirms them.
3. **Qualification CLI Runner (`scripts/typesafe-curation-qualification.ts`):** Executable evaluation runner evaluating offline comparison and assessing all 10 qualification criteria.
4. **Automated Verification Suite (`src/tests/unit/typesafe-curation-qualification.test.ts`):** Comprehensive test suite validating all 10 criteria end-to-end.
5. **Truthful Live & Canary Gates:** In accordance with Gates 2 & 5, absence of errors or mocks never passes live contract checks or canary stages. In environments without live credentials (`TYPESAFE_API_KEY`) or completed store manager canary reviews, the system explicitly reports blockers and maintains `PROVISIONALLY_QUALIFIED` status.
6. **Operator Runbook (`docs/runbooks/typesafe-jev-curation-rollout.md`):** Complete operational authority for setup, troubleshooting, confidence concepts (probability vs concentration confidence), canary sequencing, and zero-retry fail-closed rollback.

