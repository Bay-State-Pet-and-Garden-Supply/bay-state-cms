# Type-First Curation Accuracy Guardrails Plan

**Status:** Approved 2026-09-02  
**Repo:** `bay-state-cms` (`@baystate/baystate-cms`, cwd `/Users/nickborrello/Desktop/Projects/bay-state-cms`)  
**Scope:** Prevent wrong `primary_product_type` from poisoning `attribute_applicability → product_attribute_proposals → category_page_proposals → product_draft_projection` while preserving throughput. Derived from parallel researcher/scout + oracle (gpt-5.6-sol:xhigh) findings.

## 1. Goals

1. Make review completion incapable of accepting undecided, stale, cleared, system-generated, or non-current Product Types.
2. Treat Reviewed Product Type as publication authority and Execution Product Type as preview-only provisional context.
3. Invalidate and recompute only outputs that actually depend on Product Type while retaining valid universal outputs.
4. Give reviewers a type-first workflow with evidence, hierarchy, and an accurate impact preview.
5. Add deterministic verification and depth-aware calibration before considering any second-model verifier.
6. Preserve immutable decisions and audit history, including historical `system_auto_accept` records.

## 2. Non-goals and boundaries

- Do not change PipelineBoard; BatchWorkspace Review remains the primary operator surface.
- Do not mutate frozen taxonomy release JSON or invent Product Type/ancestor IDs.
- Do not reintroduce Agent Lab, autonomous loops, or model-selected retries.
- Do not grant auto-acceptance from confidence, calibration, Execution Type, or verifier output.
- Do not change title, identity, image-rights, sourcing, or publication behavior except where type dependency currentness blocks existing paths.
- Do not delete historical decisions, proposals, or history rows.
- Do not perform network calls, paid crawls, or live-database repair during implementation/testing.
- Preserve any dirty worktree; use one sequential writer and do not stage or commit except through a separately sanctioned catalog path.

## 3. Assumptions and fail-closed invariants

- A human Product Type correction must resolve to an option in the run’s frozen runtime snapshot.
- “Human” initially means a decision accepted through the authenticated/operator review route and stamped server-side as `human_review`; client-supplied origin is never trusted.
- An accepted decision with explicit `revisedValue: null` and `revisedTargetId: null` is a clear, not absence. It suppresses fallback and blocks Review and Promotion.
- Reviewable abstentions require no decision and do not count as unresolved proposals.
- A universal attribute has no Product Type dependency. An unexpected dependency on a universal proposal is treated as corrupt/stale rather than ignored.
- Missing run, snapshot, authority, parent, dependency target, dependency hash, or malformed provenance blocks currentness.
- Safety gates and invalidation are never disabled by rollout flags. Disabling recomputation leaves the item blocked and queued; it never restores stale output.
- Execution Type may preserve an output only when its ID, stamped dependency hash, parent revision, workspace, and snapshot all match exactly.

## 4. Architecture and file map

### New production files

| File | Responsibility |
|---|---|
| `src/classification/classification-currentness.ts` | Pure shared authority/currentness model used by Review and Promotion: effective type extraction, explicit-clear detection, human-origin validation, configured-target validation, parent currentness, and dependency target/hash checks. |
| `src/classification/type-change-impact.ts` | Pure impact analyzer shared by preview and commit; partitions active proposals into invalidated, exact-match revalidated, universal-preserved, and unaffected sets. |
| `src/classification/type-dependent-refresh.ts` | Selective, frozen-input recomputation for applicability, attributes, pages, and semantic metadata without replacing dependency-free universal outputs. |
| `src/db/repositories/classification-refresh-repo.ts` | Atomic queue insertion/claim/CAS completion and stale-trigger detection. |
| `scripts/repair-system-auto-accept.ts` | Dry-run-first, backup-gated remediation of historical system-accepted Product Types. |
| `src/classification/product-type-verifier.ts` | P2 deterministic verifier and ancestor/abstention policy. |
| `src/classification/product-type-shadow-verifier.ts` | P2 optional low-confidence, second-model shadow comparison; never authoritative. |

### Existing production files to modify

- Gates and decisions:
  - `src/classification/review-completion-gate.ts`
  - `src/classification/promotion-gate.ts`
  - `src/classification/proposal-review-service.ts`
  - `src/classification/assignment-projection.ts`
  - `src/db/repositories/classification-run-repo.ts`
  - `src/onboarding/draft-promoter.ts`
  - `src/server/routes/onboarding-routes.ts`
- Selective recomputation:
  - `src/classification/refresh-queue-processor.ts`
  - `src/classification/stages/attribute-applicability.ts`
  - `src/classification/stages/attribute-proposals.ts`
  - `src/classification/stages/category-page-proposals.ts`
  - `src/onboarding/cohort-curator.ts`
  - `src/onboarding/job-queue.ts`
  - `src/server/routes/classification-routes.ts`
- Schemas and migration:
  - `src/shared/schemas/classification.ts`
  - `src/shared/schemas/onboarding.ts`
  - `src/db/classification-migration.sql`
  - `src/db/migrations.ts`
  - `package.json`
- API, UI, and events:
  - `src/client/onboarding-api.ts`
  - `src/client/onboarding-work-api.ts`
  - `src/client/components/onboarding/review/ReviewClassificationPanel.tsx`
  - `src/client/components/onboarding/review/ReviewWorkspace.tsx`
  - `src/client/components/onboarding/review/use-review-detail-cache.ts`
  - `src/client/components/onboarding/review/review.css`
  - `src/onboarding/sse-emitter.ts`
- Verification, calibration, and metrics:
  - `src/classification/stages/primary-product-type.ts`
  - `src/classification/cohort-product-type-resolver.ts`
  - `src/classification/confidence-calibrator.ts`
  - `src/classification/benchmark-evaluator.ts`
  - `src/classification/production-metrics.ts`
  - `src/classification/flags.ts`
  - `src/db/repositories/classification-metrics-repo.ts`
  - `src/shared/schemas/classification-metrics.ts`

Do not modify `src/classification/releases/**` or workspace catalog files.

---

## 5. P0 — Correctness and authority

### P0.1 Remove review-time auto-acceptance

In `onboarding-routes.ts`:

- Delete `autoAcceptPendingProposalsForRun`.
- Remove its call from `/onboarding/items/review-complete`.
- Do not update proposal status or create decisions during validation.
- Pending and stale proposals remain unchanged and produce structured blocker codes.
- Continue enforcing `isBulkAcceptable` only for explicit bulk decision requests; review completion is not a decision request.

### P0.2 Shared Product Type currentness

Implement `classification-currentness.ts` and use it from both gates.

A current Reviewed Product Type requires:

1. An active, non-superseded `accepted` decision on an active `primary_product_type` proposal.
2. Server-derived decision origin `human_review`; `system_auto_accept`, verifier, execution, migration, or unknown automation cannot qualify.
3. A non-null effective target. Explicit clear returns `reviewed_product_type_cleared`.
4. Revised target and revised value resolve to the same Product Type.
5. The ID exists in the run’s frozen configured Product Type options.
6. The run belongs to the exact workspace, item, and SKU and is terminal.
7. For cohort children, the parent belongs to the workspace, is the current non-superseded revision, and is terminal.
8. Every active type-dependent accepted proposal has a recognized dependency with the expected target and canonical value hash.

Remove Review’s fallback to “any accepted type decision” or snapshot reviewed-fact presence. Promotion retains reviewed facts for curation provenance only; they are not enough to cross Review/Promotion authority gates.

### P0.3 Proposal completeness

In both review gates:

- Filter abstentions by `proposal_type === 'reviewable_abstention'`, not by proposal status.
- Ignore abstentions for pending/missing-decision completeness.
- Block any active non-abstention proposal with `pending`, `stale`, missing live decision, or inconsistent status/decision.
- Disallow submitting decisions against stale or superseded proposals.
- Preserve stale status until a narrowly authorized recomputation supersedes it; no generic path may turn stale into accepted.

### P0.4 Transactional batch completion

Keep Phase 1 as read-only preflight. During Phase 3:

- Open one transaction for the full requested item set.
- Reload item stage, active run pointer, proposals, decisions, parent, currentness, pages, and completeness.
- Rerun all gates inside the transaction before the first write.
- If any item changed or fails, throw/rollback the entire batch.
- Only after all items pass may `completeReviewStage` and `markReviewed` run.

This closes the validation-to-commit race and guarantees failed batch validation mutates no decisions, proposal statuses, review state, approvals, or item stages.

### P0 acceptance criteria

- Pending proposals stay pending after failed completion.
- Stale proposals stay stale.
- `isBulkAcceptable: false` proposals cannot be implicitly accepted.
- Explicit Product Type clear blocks Review and Promotion.
- A `system_auto_accept` decision cannot satisfy type authority.
- Abstentions neither require decisions nor mask unresolved non-abstentions.
- Parent, target, hash, or dependency mismatch blocks both gates consistently.
- A mixed-validity batch returns all failures and changes zero rows.

**Estimate:** M, approximately 3–5 engineering days.

---

## 6. Data migration and historical repair

### Schema migration

Add, through `classification-migration.sql` and a guarded migration in `migrations.ts`:

- `classification_proposal_decisions.decision_origin`, nullable for legacy rows; new route writes use a constrained server-derived value.
- Proposal revision metadata such as `superseded_at` and `refresh_queue_id`, allowing stale historical proposals to remain immutable while active queries ignore superseded revisions.
- Refresh queue ownership/currentness columns:
  - `source_kind`
  - `onboarding_item_id`
  - `cohort_id`
  - `expected_run_id`
  - `expected_parent_run_id`
  - `trigger_decision_id`
  - `claimed_by`, `claimed_at`, `attempt_count`
- Indexes for unique trigger decision, workspace/status claiming, and active proposals.

Legacy origin resolution remains fail-closed: `reviewer_id='system_auto_accept'` is always system authority even before repair.

### Repair procedure

`classification:repair-system-auto-accept` must:

1. Default to `--dry-run`; report affected decisions, active reviews, approvals, promotion items, and already-exported records.
2. Require the application writer to be stopped for `--apply`.
3. Create and verify a SQLite backup using `createSqliteBackup`/`verifySqliteBackup` immediately before mutation.
4. In one transaction:
   - Stamp/identify matching historical origin metadata.
   - Supersede, never delete, live system-accepted Primary Product Type decisions.
   - Mark the corresponding Product Type proposal and mismatched dependents stale.
   - Append history events referencing original IDs.
   - Invalidate durable review and clear approval.
   - Return unexported promotion-stage items to `review/pending`.
5. Never unpublish or rewrite already-exported catalog data; list it for manual audit.
6. Be idempotent and emit an auditable repair receipt.

### Migration acceptance criteria

- Fresh and upgraded databases produce the same schema.
- Historical rows and IDs remain queryable.
- Applying without a verified, source-matching backup fails before a write.
- Re-running repair causes no duplicate history or state transitions.
- Gate deployment is safe before repair: unsafe decisions are already ignored.

**Estimate:** M, approximately 2–3 days including rehearsal.

---

## 7. P1 — Invalidation, recomputation, and type-first UX

### P1.1 Atomic Product Type change

Refactor Product Type decisions through a dedicated transaction in `proposal-review-service.ts`:

1. Validate optimistic predecessor, active run, configured next ID, and human origin.
2. Compute impact using `type-change-impact.ts`.
3. Append the type decision.
4. Mark only mismatched type-dependent active proposals stale.
5. Preserve dependency-free universal proposals and their decisions.
6. Revalidate rather than stale execution-driven outputs only when all of these match:
   - new reviewed ID equals frozen Execution Type ID;
   - dependency target and value hash match;
   - parent revision is current and terminal;
   - workspace, snapshot, and run lineage match;
   - proposal was not already stale for another reason.
7. Invalidate durable review, clear approval, and reopen an approved promotion item.
8. Enqueue an item- or cohort-scoped refresh tied to the exact trigger decision.
9. Append history events in the same transaction.

Any error rolls back the decision and every side effect.

### P1.2 Selective, cohort-aware refresh

Replace the current unclaimed per-SKU refresh behavior:

- The onboarding worker becomes the only refresh writer.
- `/classification/refresh/process` may wake/report the worker but must not start a competing writer.
- Claim queue rows through CAS and verify the trigger decision is still live.
- A later type correction supersedes an older queued trigger.
- Standalone items recompute only applicability, type-dependent attributes/pages, and semantic metadata from frozen evidence/snapshot.
- Cohort items retain the exact current parent context. A busy, stale, superseded, or non-terminal parent blocks/retries; the processor never silently falls back to standalone curation.
- Old invalidated proposals remain stale history. After replacement proposals commit, mark the old rows superseded, not accepted.
- New dependent proposals are pending and require review.
- Universal proposals remain active and decided.
- On failure, keep the item review-invalidated and stale; never restore old outputs.

### P1.3 API contracts

Add shared Zod contracts.

**Detail response addition**

```ts
typeReview: {
  reviewed: { id: string | null; label: string | null; decisionId: string | null; current: boolean };
  executionPreview: {
    id: string | null;
    label: string | null;
    confidence: number | null;
    previewOnly: true;
  } | null;
  options: Array<{ id: string; label: string; hierarchyPath: string[] }>;
  evidence: {
    strength: 'strong' | 'moderate' | 'weak' | 'none';
    supportingCount: number;
    contradictingCount: number;
    matchedWords: string[];
  };
  refreshState: 'current' | 'queued' | 'running' | 'failed' | 'blocked';
}
```

Hierarchy paths must come from the pinned immutable release identified by the frozen snapshot. If that join is unavailable or cyclic, omit the path and expose “Hierarchy unavailable”; never guess.

**Impact preview**

`POST /api/onboarding/items/:id/product-type-impact`

Request:

```json
{
  "proposalId": "…",
  "nextProductTypeId": "configured-id-or-null",
  "expectedDecisionId": "…"
}
```

Response contains old/new type, affected counts by proposal class, preserved universal count, exact-match revalidation count, recomputation scope, and parent/cohort impact. It is read-only.

The existing decisions endpoint remains the mutation endpoint. The server recomputes impact during commit; preview data is never trusted. Explicit clear must send both revised fields as present `null` values. Optimistic mismatch returns `409` and mutates nothing.

### P1.4 Review UX and accessibility

Refactor `ReviewClassificationPanel` into:

1. **Step 1 — Confirm Product Type**
   - Current type and hierarchy breadcrumb.
   - Evidence strength, confidence, matched evidence, and visible contradiction warning.
   - Dedicated change selector and explicit “Clear Product Type” action.
   - Execution Type displayed separately as **“Preview only — used to prepare fields; not reviewed catalog truth.”**
   - Impact confirmation dialog before mutation.

2. **Step 2 — Review fields for [Product Type]**
   - Type-dependent rows show stale/recomputing state.
   - Universal rows stay usable and visibly preserved.
   - Completion remains disabled until Step 1 has current non-null human authority and all Step 2 decisions are current.

Accessibility requirements:

- Native label associations and breadcrumb list semantics.
- Keyboard-operable selector/dialog; focus moves into the dialog and returns to its trigger.
- `aria-live` status for invalidation/recompute completion.
- Stale, preview-only, and conflict states use text/icons in addition to color.
- Busy state disables duplicate submissions without hiding errors.

### P1.5 SSE and telemetry

Add named events:

- `item:classification-invalidated`
- `item:classification-refresh-started`
- `item:classification-refresh-completed`
- `item:classification-refresh-failed`

Emit only after transaction commit. ReviewWorkspace invalidates the affected detail cache and silently refreshes queue counts without discarding an unrelated dirty draft.

Extend quality telemetry with denominators and null-on-insufficient-data behavior for:

- type correction and overturn rates;
- current stale proposal/item counts;
- queued/running/failed refresh counts and p50/p95 latency;
- blocked completion counts by structured reason;
- snapshot/parent/dependency drift;
- Execution-vs-Reviewed disagreement;
- deterministic/second-model verifier disagreement and calibration by depth.

Failed completion attempts use structured logs or non-domain counters so the “mutates nothing” database invariant remains true.

### P1 flags and rollout

Add flags in `classification/flags.ts`:

- `typeFirstReviewUiEnabled`
- `typeChangeRefreshWorkerEnabled`
- `productTypeDeterministicVerifierMode: off | shadow | enforce`
- `productTypeSecondModelShadowEnabled`

Invalidation and gate correctness are unflagged. Roll out P1 as:

1. Deploy P0.
2. Run repair dry-run, verified backup, then sanctioned repair.
3. Enable UI and refresh worker for internal batches.
4. Canary complete cohorts; monitor stale backlog and recompute failures.
5. Expand only when no blocked queue growth or authority drift is observed.
6. Rollback disables UI/worker only; queued/stale records remain blocked.

### P1 acceptance criteria

- A→B stales all mismatched dependent attributes/pages and invalidates review/approval atomically.
- Universal proposals and human decisions remain valid.
- No previously stale proposal is revived.
- Matching Execution Type plus exact dependency fingerprint is safely revalidated; any mismatch blocks.
- Cohort items never recompute through the standalone path.
- A failed decision or queue commit leaves every related table unchanged.
- The UI communicates two-step authority, preview-only Execution Type, impact, and refresh status accessibly.

**Estimate:** XL, approximately 2–3 weeks.

---

## 8. P2 — Verification and calibration

### P2.1 Deterministic verification first

`product-type-verifier.ts` consumes only frozen evidence, configured options, release hierarchy, and deterministic scores. It returns versioned reason codes and one of:

- `pass_candidate`
- `prefer_classifiable_ancestor`
- `abstain`
- `human_review`

Checks include:

- configured ID and hierarchy integrity;
- species/domain contradictions;
- Product Type invariant contradictions;
- insufficient supporting evidence;
- top-candidate margin and sibling ambiguity;
- parent/leaf confidence appropriate to taxonomy depth.

A leaf is emitted only when both its branch and leaf thresholds pass. Otherwise choose the nearest supported ancestor only if that ancestor is itself a configured classifiable Product Type. If no classifiable ancestor exists, abstain and show the non-classifiable ancestor only as guidance.

Run the verifier in shadow first for both `primary-product-type.ts` and `cohort-product-type-resolver.ts`; enforce only after held-out acceptance.

### P2.2 Depth-aware calibration

Update calibration/evaluation to:

- fit on development data only;
- stratify by taxonomy revision and depth;
- require minimum per-depth/per-class support;
- report ECE, exact leaf accuracy, ancestor accuracy, tree-distance error, coverage, and abstention;
- fall back to a conservative global threshold or abstention when support is insufficient;
- never use model self-confidence as acceptance authority;
- freeze calibrated artifacts by digest before canary use.

### P2.3 Optional second-model shadow

Only after deterministic verification is accepted and ADR 0033 is approved/amended:

- Deterministically sample a bounded low-confidence slice.
- Use a separately configured model route and provenance record.
- Restrict output to configured IDs or abstention.
- Persist comparison telemetry only.
- Never alter proposals, type decisions, refresh scope, review priority, or promotion.
- Kill immediately on out-of-enum output, cost/latency breach, or safety violation.

### P2 acceptance criteria

- Invalid IDs, hierarchy failures, and contradictions always abstain/block.
- Exact deterministic matches do not regress.
- Uncertain leaves resolve to a configured defensible ancestor or abstain, never an invented/broad guess.
- Calibration reports depth-specific support and uncertainty.
- Second-model output has zero authority and is off by default.
- No verifier path creates accepted decisions or publication writes.

**Estimate:** L for deterministic verification/calibration, plus L for optional shadow verifier and data collection.

---

## 9. Test plan

### New tests

- `src/tests/unit/classification-currentness.test.ts`
  - Human/non-human authority, explicit clear, mismatched value/target, parent currentness, target/hash checks, missing dependency failure.
- `src/tests/unit/type-change-invalidation.test.ts`
  - A→B invalidation, universals preserved, exact Execution Type revalidation, prior stale preservation, atomic rollback.
- `src/tests/unit/classification-refresh-queue.test.ts`
  - CAS claims, stale trigger supersession, single writer, cohort-vs-standalone routing, failure remains blocked.
- `src/tests/unit/system-auto-accept-repair.test.ts`
  - Dry run, mandatory verified backup, immutable history, idempotency, review/approval invalidation.
- `src/tests/unit/product-type-verifier.test.ts`
  - Hierarchy, contradictions, ancestor fallback, no classifiable ancestor abstention.
- `src/tests/unit/product-type-depth-calibration.test.ts`
  - Split isolation, support floors, depth buckets, conservative fallback.

### Existing tests to extend

- `src/tests/unit/review-completeness-gate.test.ts`
  - Failed batch validation mutates nothing; no review-time auto-accept.
- `src/tests/unit/onboarding-decision-routes.test.ts`
  - Explicit clear encoding, stale/superseded refusal, optimistic conflict.
- `src/tests/unit/promotion-gate.test.ts`
  - Shared currentness parity with Review.
- `src/tests/unit/review-classification-panel.test.tsx`
  - Step labels, preview-only text, selector, impact dialog, accessible status/focus.
- `src/tests/unit/onboarding-review-state.test.ts`
  - Type change invalidates review and clears approval.
- `src/tests/unit/draft-promoter.test.ts`
  - Currentness remains a final defense.
- `src/tests/unit/db-migration.test.ts`
  - Fresh/upgrade schema and indexes.
- `src/tests/unit/decision-revision-migration.test.ts`
  - Legacy origin interpretation.
- `src/tests/unit/cohort-worker.test.ts`
  - Cohort refresh context and exact fingerprint reuse.
- `src/tests/unit/pr9-acceptance.test.ts`, `pr11-acceptance.test.ts`, `pr12-acceptance.test.ts`
  - Adjust assumptions that previously relied on implicit acceptance.

Mandatory regression matrix:

1. Stale remains stale.
2. Explicit clear blocks.
3. A→B invalidates dependents.
4. Universals remain valid.
5. Matching Execution Type/fingerprint can preserve or revalidate.
6. Target/hash/authority/parent conflicts block.
7. Failed multi-item validation mutates nothing.

## 10. Validation commands

Run in dependency order:

```bash
bun test --timeout 30000 \
  src/tests/unit/classification-currentness.test.ts \
  src/tests/unit/type-change-invalidation.test.ts \
  src/tests/unit/classification-refresh-queue.test.ts \
  src/tests/unit/system-auto-accept-repair.test.ts

bunx vitest run \
  src/tests/unit/review-classification-panel.test.tsx \
  src/tests/unit/product-type-verifier.test.ts \
  src/tests/unit/product-type-depth-calibration.test.ts

bun test --timeout 30000 \
  src/tests/unit/review-completeness-gate.test.ts \
  src/tests/unit/onboarding-decision-routes.test.ts \
  src/tests/unit/promotion-gate.test.ts \
  src/tests/unit/onboarding-review-state.test.ts \
  src/tests/unit/draft-promoter.test.ts \
  src/tests/unit/db-migration.test.ts \
  src/tests/unit/decision-revision-migration.test.ts \
  src/tests/unit/cohort-worker.test.ts

bun run typecheck
bun run lint
bun run build
bun run verify
git status --short
git diff --cached --name-only
```

Repair rehearsal must use a disposable database. No live apply command belongs in automated validation.

## 11. Residual risks and open questions

- The application currently lacks strong authenticated reviewer identity; server-stamped route provenance proves interaction path, not a cryptographically authenticated person.
- Many hierarchy ancestors are intentionally non-classifiable. Ancestor fallback will often abstain unless a future immutable taxonomy release designates broad classifiable nodes.
- Selective cohort recomputation must be validated against coordinated Page/title semantics; stale parent context must block rather than degrade to per-SKU execution.
- Historical already-exported products cannot be silently un-published by repair and require a separate audited catalog assessment.
- Large stale backlogs can accumulate while the refresh worker flag is off; rollout needs queue alerts and an operator runbook.
- Adding active/superseded proposal semantics requires every Review, Promotion, metrics, and hydration query to use the same active-row predicate.

---

*Plan generated by planner subagent (gpt-5.6-sol:xhigh) — see session `/Users/nickborrello/.pi/agent/sessions/--Users-nickborrello-Desktop-Projects-shopsite-cms--/2026-09-02T19-27-16-968Z_01a06397-05e8-7995-a099-50507702b749/90d6fad8-7570-4332-ab3e-03a797cd72e0/run-0/session.jsonl`*
