# Onboarding UI simplification — implementation tickets

**Spec:** [#332](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/332)

**Status:** Approved for orchestration; all nine existing implementation issues
were reconciled to spec #332, labeled ready-for-agent, and verified against the
native GitHub blocking graph. Implementation is present in the working tree;
verification evidence and repository-wide blockers are recorded in the
[working-tree verification report](../audits/onboarding-ui-simplification-332.md).

The existing nine implementation issue IDs are reused instead of creating
duplicate work. Their earlier process-overview and runtime-observation
requirements have been reconciled to the current owner-approved six-stage
simplification scope. The earlier parent spec #277 retains its native grouping;
each implementation issue identifies #332 as its governing spec.

Each ticket owns the schema/read changes it actually needs, its working UI,
existing command integration, and meaningful tests. A ticket is complete when
its behavior is independently demoable, not when an empty framework or one
technical layer has landed. These scopes are published on the implementation
issues; each slice owns its focused verification.

## 1. #278 — Preserve six-stage working context in the existing shell

**What to build:** New batches open at Identify & Route Sources; returning to
an existing batch and switching stages preserves valid filters and product
selection in the existing single shell. Explicit links and browser history
reach their named stage rather than being overridden by remembered defaults.

**Blocked by:** None (can start immediately).

- [ ] Retain the six canonical stage tabs and existing stage vocabulary adapters.
- [ ] Remember view state per workspace/batch/stage; valid explicit links take precedence.
- [ ] Reopen new batches at the first stage and existing batches at their last valid stage.
- [ ] Revalidate restored product/action selections and protect pending edits.
- [ ] Late responses and stale URLs cannot apply another batch's view state.
- [ ] Rendered navigation/history tests verify stage switching, reopening, direct links, and invalid selection.

## 2. #282 — Simplify batch status and execution controls

**What to build:** A compact header accurately describes recorded batch status,
offers Start branded products and Pause/Resume, places Start all products in
overflow, and initially collapses detailed existing live activity.

**Blocked by:** None (can start immediately).

- [ ] Start branded products retains the existing branded-release operation and does not claim profile readiness.
- [ ] Pause/Resume and Start all retain existing semantics and result/error handling.
- [ ] Start all remains reachable as an advanced action with existing confirmation behavior.
- [ ] Execution permission, recorded progress, ephemeral activity, unavailable facts, and stale reads are distinguishable.
- [ ] Header controls and activity disclosure remain keyboard-operable at desktop and narrow widths.
- [ ] Rendered/control tests verify the labels, actions, disclosure defaults, and unchanged command behavior.
- [ ] No new worker observation API or durable history infrastructure is part of this ticket.

## 3. #280 — Make Review the direct review-and-approval workspace

**What to build:** Review listings opens the actual review queue and inspector
immediately. Needs review is the default; Reviewed and Approved filters expose
the recorded decisions, and eligible reviewed selections can be explicitly
approved without another destination.

**Blocked by:** #278.

- [ ] Direct stage entry opens the existing rapid review experience without an Open workspace detour.
- [ ] Needs review, Reviewed, and Approved have accurate server-owned scopes and totals; terminal rows are excluded before active-queue pagination.
- [ ] Filter totals remain distinct from review progress and loaded page length.
- [ ] Existing review, filename decisions, warnings, edit invalidation, and exact operation results remain authoritative.
- [ ] Approval applies only to a currently eligible reviewed selection and never creates drafts.
- [ ] Approved/terminal inspection cannot trigger review-stage edit, completion, or send-back commands.
- [ ] Schema/read-model and rendered tests verify status filters, truthful counts, eligibility, pagination, and explicit review-to-approval behavior.

## 4. #285 — Open draft creation and outcomes directly

**What to build:** Create drafts opens the real release workspace, showing
approved products awaiting CMS drafts, actual created drafts, downstream
release links, and completed/skipped outcomes.

**Blocked by:** #278.

- [ ] Stage entry requires no separately opened draft workspace.
- [ ] Approved, created-draft, and verified downstream outcomes come from authoritative facts and actual result linkage.
- [ ] Draft creation retains existing durable approval checks, receipts, replay/idempotency, and exact failure/retry outcomes.
- [ ] Bulk action scope distinguishes selected IDs, loaded rows, and a supported entire eligible set.
- [ ] Skipped outcomes include products skipped anywhere in the batch, not only Create drafts.
- [ ] Existing persisted draft/change-set links work and never imply publication from approval or draft creation.
- [ ] Read/result and rendered tests verify direct entry, result links, partial failures, replay, and batch-wide outcomes.

This does not depend on #280: approved fixtures and the existing approval command
already make draft creation independently verifiable.

## 5. #279 — Resolve batch-wide attention without losing stage context

**What to build:** A persistent Needs attention count opens a shell-owned issue
panel. Selecting an issue opens its relevant existing resolver, and closing or
resolving returns to the underlying stage/filter/selected-product context.

**Blocked by:** #278.

- [ ] Indicator and list use authoritative batch-wide attention scope, not a stage-filtered or loaded-page count.
- [ ] At least one existing issue resolver completes end to end through its existing command and refreshes affected reads.
- [ ] Opening attention never silently switches the active stage or clears its filters/selection.
- [ ] Issue list, resolver navigation, closing, resolution, and external setup return preserve valid origin context.
- [ ] Escape, focus trapping/restoration, loading/error states, and narrow layouts work.
- [ ] Read/command and rendered tests verify resolution, late responses, moving products, eligibility refresh, and origin restoration.

## 6. #283 — Make preparation product-first with real evidence

**What to build:** Prepare listing opens a product-first list showing Preparing,
Waiting on family, and Needs attention. Selecting a product displays its actual
preparation facts and the relevant existing Listing Evidence Gap correction.

**Blocked by:** #278.

- [ ] Replace batch-level placeholder accordions with selected-product details from the existing preparation projection.
- [ ] Preserve all five detail groupings, effective run binding, and unavailable/proposed/decided/failed/stale distinctions.
- [ ] Product statuses, reasons, and family-readiness summaries use authoritative facts.
- [ ] Unknown gap projection differs from confirmed no open gap; correction remains unresolved until existing validation applies it.
- [ ] Pagination and late responses cannot mix products, runs, gaps, or family facts.
- [ ] Read/projection and rendered tests verify actual facts, selection changes, missing data, and existing correction/revalidation.

## 7. #284 — Simplify source setup and collection actions

**What to build:** Intake shows Product, Brand, Source, Status, and Next action.
Quick individual and contextual bulk brand assignment remain available; detailed
domain, profile, and strategy configuration appears for the selected product.
Find product page and Collect details show clear progress, specific blockers,
and relevant existing actions.

**Blocked by:** #278.

- [ ] The default intake list avoids simultaneous detailed configuration editors while keeping common assignment fast.
- [ ] Selection drives bulk actions with explicit scope and current eligibility.
- [ ] Domain/profile/strategy detail and owning specialist-workspace links preserve valid batch/product return context.
- [ ] Official-page and distributor-record requirements remain distinct; profile-free sources are not assigned new domain/profile gates.
- [ ] Find product page and Collect details expose specific server reasons and relevant existing actions.
- [ ] Rendered and existing source/assignment tests verify individual/bulk assignment, exemptions, late responses, setup return, and truthful unavailable states.

## 8. #281 — Make family waiting understandable and actionable

**What to build:** Preparation details distinguish a product's readiness from
its family's readiness, identify actual blocking siblings, and open their
attention tasks with a path back to the initiating product.

**Blocked by:** #283 (preparation product/detail presentation), #279 (context-preserving attention resolver).

- [ ] Use actual family membership/readiness and named units; do not infer families from visible product names or batch membership.
- [ ] Distinguish ready, still-processing, blocked, and unavailable sibling facts.
- [ ] Resolve an actionable sibling in the attention panel and restore the initiating product with refreshed family facts.
- [ ] Contextual cross-stage members do not inflate the selected stage's product count.
- [ ] Preserve the existing no-default-partial-family barrier and automatic progression.
- [ ] Read and rendered tests verify sibling resolution, changing membership, missing facts, pagination, scope, and return context.

## 9. #286 — Retire duplicate navigation and verify the composed flow

**What to build:** The completed six-stage workspace becomes the coherent
default. Batch tools, redundant workspace-opening buttons, placeholder
composition, and replaced operation destinations are retired once their task
homes are verified. Existing links lead to the equivalent stage, issue panel,
or outcome destination.

**Blocked by:** #280, #285, #282, #284, #281. These transitively gate #278, #279, and #283.

- [ ] Every former operation/outcome destination has a usable replacement; no active entry point needs retired navigation.
- [ ] Old URLs, browser history, reload, explicit links, batch return, and selected-product restoration work together.
- [ ] The integrated exception → preparation → review → approval → draft flow preserves authority, accurate counts, exact results, and current eligibility.
- [ ] Distributor-only, official-page, family-waiting, gap-correction, invalidation, terminal, partial-failure, and stale-read scenarios remain understandable and actionable.
- [ ] Update the operator guide, glossary, ADR presentation notes, and acceptance evidence to reflect actual delivered behavior.
- [ ] Run affected and integrated regressions, typecheck, lint, build, and the repository test suite; inspect the final diff.
- [ ] Complete a bounded desktop/narrow-browser walkthrough with keyboard and focus checks.

Every earlier slice already owns its own verification. This ticket verifies
composition and retirement rather than postponing all tests until cutover.

## Work frontier and priority

Start #278 and #282 independently. After #278, prioritize #280 and #285 for
direct review/draft access, then #283 and #279 for preparation and exceptions.
#284 is also available after #278. #281 follows preparation and attention;
#286 is the final composed-flow retirement gate.

The published implementation tickets use spec #332, ready-for-agent, and native
GitHub blocking edges in the order above. The earlier parent spec is preserved.
