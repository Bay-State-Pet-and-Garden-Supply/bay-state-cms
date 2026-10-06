## Problem Statement

The Store Manager has to navigate through intermediate screens and separately opened workspaces to perform ordinary onboarding tasks. Review listings opens a basic list rather than the actual review workspace. Create drafts repeats that detour. Batch tools presents a second navigation system, preparation sections show placeholders instead of available product-specific facts, and source setup exposes too many configuration controls together. Moving between these destinations can discard filters and selected-product context.

The operator needs one obvious home for each task, direct access to review and draft creation, clear product-specific progress and blockers, and a way to resolve batch-wide exceptions without losing their place.

## Solution

Keep the six canonical Pipeline Stage tabs in the existing Batch Workspace. Each tab opens the working screen for its task, without an intermediate list and an Open workspace button.

| Stage tab | Default experience |
| --- | --- |
| Identify & Route Sources | Product, Brand, Source, Status, and Next action; quick brand assignment and selection-driven bulk assignment; detailed domain, profile, and strategy configuration in the selected product's panel. |
| Find product page | Clear progress, specific blockers, and the relevant existing resolution action. |
| Collect details | Extraction or distributor-materialization progress, source information, and actionable failures. |
| Prepare listing | One product-first list showing Preparing, Waiting on family, and Needs attention; selected-product preparation details and existing correction actions. |
| Review listings | The queue-and-inspector review workspace, initially filtered to Needs review; Reviewed and Approved filters, with explicit approval of reviewed products in the same tab. |
| Create drafts | Approved products awaiting draft creation, created CMS drafts, downstream release links, and completed/skipped outcomes. |

The header contains compact batch status, Needs attention with a batch-wide count, Start branded products, Pause/Resume, and Settings. Start all products is an overflow action; detailed live activity starts collapsed. Needs attention opens an issue panel and the relevant resolver while preserving the underlying stage, filters, and selected product.

New batches open at Identify & Route Sources. Returning to an existing batch restores its last stage and filters; an explicit valid link takes precedence. A selected product is restored when still appropriate, and all mutation selections are revalidated against current eligibility.

Review completion, approval, CMS draft creation, downstream export, and publication remain distinct decisions and outcomes. Automation continues to own routine stage progression.

## User Stories

1. As a Store Manager, I want to retain the six recognizable Pipeline Stage tabs, so that I can understand where onboarding work belongs.
2. As a Store Manager, I want each tab to open its actual working screen, so that routine work does not require an extra workspace-opening click.
3. As a Store Manager, I want Review listings to open the review queue and product inspector immediately, so that I can begin inspection directly.
4. As a Store Manager, I want Needs review selected initially, so that products awaiting inspection receive my attention first.
5. As a Store Manager, I want Reviewed and Approved filters in Review, so that I can see the distinct decisions already recorded.
6. As a Store Manager, I want Looks Good & Next and existing review keyboard navigation, so that reviewing hundreds of products remains practical.
7. As a Store Manager, I want the existing final listing, evidence, warnings, and readiness details in the inspector, so that I can judge the actual proposed output.
8. As a Store Manager, I want filename decisions and blocking review errors explained, so that I understand which explicit action is required.
9. As a Store Manager, I want to approve a reviewed selection in Review, so that approval does not require a separately opened destination.
10. As a Store Manager, I want review completion and approval to remain distinct actions, so that checking a product does not silently authorize release.
11. As a Store Manager, I want accurate eligibility and exact approval results, so that rejected or failed products are not mistaken for approved products.
12. As a Store Manager, I want approved products shown with appropriate inspection-only controls, so that I cannot accidentally send an approved or terminal product through a review-stage action.
13. As a Store Manager, I want consequential edits to retain existing review invalidation, so that stale approval cannot authorize changed output.
14. As a Store Manager, I want active review queues to exclude completed and skipped products, so that terminal outcomes do not appear as actionable review work.
15. As a Store Manager, I want status counts and review progress independent of the fetched page and selected status filter, so that pagination does not distort progress.
16. As a Store Manager, I want Create drafts to open the release workspace directly, so that I can inspect approved products and create drafts without another navigation step.
17. As a Store Manager, I want approved, awaiting-draft, created-draft, and verified downstream outcomes distinguished, so that I know what has actually happened.
18. As a Store Manager, I want links to actual persisted CMS drafts and change sets, so that I can inspect the resulting records and continue the release workflow.
19. As a Store Manager, I want selected-product and whole-eligible-scope bulk actions clearly distinguished, so that a partially loaded page cannot silently expand or shrink an operation.
20. As a Store Manager, I want retries and repeat submissions to retain existing receipts and idempotency, so that successful drafts are not created twice.
21. As a Store Manager, I want completed and skipped outcomes accessible in Create drafts, so that products are not lost after leaving active work.
22. As a Store Manager, I want skipped products from every Pipeline Stage included in batch outcomes, so that the outcome count is complete.
23. As a Store Manager, I want Prepare listing to focus on products and their current needs, so that I do not have to interpret five placeholder accordions.
24. As a Store Manager, I want real preparation evidence for the selected product, so that OCR, names, product types, classifications, and family readiness are understandable.
25. As a Store Manager, I want unavailable information distinguished from a confirmed clear result, so that missing evidence is not presented as success.
26. As a Store Manager, I want Listing Evidence Gaps and existing correction actions next to the affected product, so that I can fix the actual blocker in context.
27. As a Store Manager, I want Waiting on family to identify ready, still-processing, and blocked siblings, so that I understand why my product cannot proceed.
28. As a Store Manager, I want a blocking sibling to lead to its relevant existing task and back to the initiating product, so that family resolution does not lose context.
29. As a Store Manager, I want a persistent batch-wide Needs attention count, so that I notice blockers in other stages while continuing my current work.
30. As a Store Manager, I want opening and resolving attention tasks to preserve my stage, filters, and selected product, so that exceptions do not force me to rebuild my working context.
31. As a Store Manager, I want one navigation system for stage tasks, so that Batch tools does not compete with the primary tabs.
32. As a Store Manager, I want a concise source-setup list with a specific next action, so that domain, profile, and strategy details appear when relevant rather than all at once.
33. As a Store Manager, I want quick individual and contextual bulk brand assignment, so that simplifying the source list does not slow common intake work.
34. As a Store Manager, I want official-page and qualified distributor-record requirements shown accurately, so that profile-free distributor products are not incorrectly blocked by domain or profile setup.
35. As a Store Manager, I want external configuration links to preserve a useful return context, so that specialist setup work leads back to the initiating batch and product.
36. As a Store Manager, I want Start branded products named for its actual behavior, so that brand release is not confused with source/profile readiness.
37. As a Store Manager, I want Start all products accessible as an advanced action and Pause/Resume readily available, so that a quieter header still exposes necessary execution controls.
38. As a Store Manager, I want execution permission, recorded progress, and ephemeral activity distinguished, so that permission to run is not mistaken for observed worker activity.
39. As a Store Manager, I want to reopen a batch at my last stage and filters, so that repeated sessions continue where I was working.
40. As a Store Manager, I want valid direct links and browser back/forward to take precedence over remembered defaults, so that navigation is predictable.
41. As a Store Manager, I want selection and controls revalidated after product movement or refreshed data, so that old UI state cannot authorize an ineligible action.
42. As a Store Manager, I want pending edits protected during navigation, so that context restoration does not silently discard my work.
43. As a Store Manager, I want distinct loading, empty, failed, unavailable, and stale states, so that a failed refresh does not look like an empty batch.
44. As a Store Manager, I want keyboard-operable tabs, meaningful status text, and reliable panel focus restoration, so that all normal tasks remain accessible.
45. As a Store Manager, I want usable product details and issue resolution at narrow widths, so that the working screens do not depend on a wide desktop layout.
46. As a Store Manager, I want large batches to use paginated reads and bounded selected-product detail, so that simplification does not require loading every product and its evidence.

## Implementation Decisions

- Retain the existing single Batch Workspace shell and the six canonical stage identities. Simplify the content and interaction topology rather than replacing stage navigation with a process-overview navigation model.
- Directly compose the existing review and draft workspaces under their stage tabs. Reuse their deep detail, validation, mutation, receipt, and idempotency seams rather than build parallel review or promotion implementations.
- Consolidate approval into the Reviewed view of Review. Needs review, Reviewed, and Approved are durable review-state filters, not additional Pipeline Stages. Approved products may be displayed in Review even though approval advances them to Create drafts; this is an explicit review-history scope, not inferred stage membership.
- Derive review action availability from authoritative current facts. Review completion applies only to eligible unreviewed products; approval applies only to eligible reviewed products. Approved and terminal product inspection cannot expose review-stage edit, completion, or send-back commands. Existing controlled invalidation remains authoritative wherever editing is supported.
- Correct the review read projection at the server/shared-schema seam. Exclude terminal rows from active queues before pagination, supply truthful per-status totals, and distinguish filtered list totals from batch review progress. Reviewed and approved products are checked for progress purposes, but Approved is not counted as the Reviewed filter's result count. Products still preparing and deliberately skipped products are not pending review work.
- Use server-defined, consistently scoped predicates for counts and items. Stage badges describe server stage totals; review filters describe their named review scope; attention overlaps stages; terminal outcomes and family-context units are separately labeled. No totals or eligibility are inferred from loaded rows or event narration.
- Reuse existing stage, work-state, preparation, family, attention, review, approval, and draft read/command contracts. Extend validated reads additively where required for accurate terminal exclusion, status totals, or bounded selected-product facts. Keep database access repository-owned.
- Bind preparation details to the selected product and effective run using the existing per-item preparation projection. The five internal preparation sections are detail groupings, not stages, queues, completion gates, or batch progress estimates. Preserve unavailable versus clear gap semantics and existing gap correction/revalidation.
- Show actual family membership and readiness; resolve relevant siblings through existing attention workflows. Contextual siblings do not inflate stage-list counts, and the Family Readiness Barrier remains unchanged.
- Read skipped outcomes across the entire batch, not just Create drafts. Distinguish persisted CMS draft creation from downstream export verification and publication. Present existing release destinations and actual persisted result links.
- Own the attention panel and return context in the batch shell. List-to-resolver navigation is internal to that panel; closing or resolving it restores the originating view and focus. Existing specialist workspaces keep explicit return context.
- Preserve stage/filter/selected-product view state per workspace and batch, with explicit valid navigation taking precedence over remembered defaults. Revalidate selection after refresh and movement; do not persist credentials, customer records, draft edits, or product evidence as view preferences.
- Simplify source rows and expose configuration in selected-product detail while retaining quick brand assignment and selection-driven bulk actions. Existing Brand Hub, strategy, profile, and distributor-record authority remains authoritative.
- Rename the existing branded-release action to Start branded products. Keep Start all products as an advanced action and retain Pause/Resume semantics. Start is not a claim of profile readiness, Pause is not a promise to cancel in-flight work, and Resume does not implicitly release holds.
- Render compact recorded status and initially collapsed ephemeral activity using existing facts. This scope does not add worker runtime-observation APIs, durable event history, a heartbeat, or new liveness claims.
- Redirect equivalent old workspace links to the new task home or attention/outcome panel. Retire duplicate navigation only when the replacement workflow and its entry points are verified.
- Preserve the established visual identity while reducing nested destinations and competing controls. Use semantic tabs/statuses, non-color-only reasons, bounded panels, keyboard operation, and responsive detail layouts.
- Record the narrow presentation supersession of ADR 0034: separate full-batch operation navigation, placeholder preparation sections, and frozen view composition give way to direct task screens and contextual details. Stage vocabulary and automation/review/release authority remain governed by the existing ADRs.

## Testing Decisions

- The primary seam is the rendered Batch Workspace using representative validated API fixtures and existing command boundaries. Tests assert user-visible navigation, task completion, eligibility, scope, restored context, and operation results rather than component nesting or implementation helpers.
- Extend existing linear-shell, navigation/selection, stage-item, source-intake, preparation, review-workspace, review-filter, approval/export, and execution-strip test families. Each implementation slice owns its meaningful rendered behavior tests.
- Cover the real server read seam for active review terminal exclusion, stable status totals, progress semantics, filter-bound cursors, and reconciliation of count and item scope. Use the existing review-queue schema/adversarial tests and stage-read query-plan tests as prior art.
- Reuse command-level review-state, approval-gate, filename-decision, durable-promotion, gap-correction, and controlled-release tests to verify existing authority. Do not duplicate lifecycle logic inside UI tests.
- Verify direct Review and Create drafts entry; explicit approval after review; approved/terminal inspection controls; exact success/failure reporting; and draft result linkage independently of optimistic notifications.
- Verify per-batch stage/filter restoration, valid direct-link precedence, browser history, panel closing/resolution, late responses, product movement, eligibility pruning, and protection of pending edits.
- Verify real selected-product preparation facts, unavailable-versus-clear gaps, sibling resolution, batch-wide skipped outcomes, empty/error/stale states, pagination, and scope-correct bulk selections.
- Run the smallest affected rendered and server suites per slice. At integrated completion run typecheck, lint, build, and the repository test suite; inspect the final diff.
- Finish with a bounded live-browser walkthrough on desktop and a narrow viewport, checking the full exception-to-review-to-approval-to-draft path, keyboard operation, and focus restoration.

## Out of Scope

- Replacing the six stage tabs with a process-overview-first navigation model, introducing a seventh stage, reviving the retired Pipeline Board, or creating another application shell.
- Changing sourcing qualification, extraction, curation/classification, cohort formation, family barriers, stage progression, or command-time review/approval/promotion policy.
- New worker observation infrastructure, durable execution tails, heartbeat/health services, inferred liveness, or invented progress/ETA reporting.
- Automatic approval, draft creation by approval, automatic export/publication, or new ShopSite communication.
- Database/stage-vocabulary migrations, unrelated design-system changes, or a broad glossary rewrite.
- Rebuilding Brand Hub, strategy, Profile Builder, or specialist configuration authority inside onboarding.

## Further Notes

- The owner confirmed this design through three recommendation rounds and approved the consolidated plan on 2026-09-30. Implementation is pending; this document records the target rather than claiming the UI has shipped.
- The existing tracker spec #277 and tickets #278–#286 cover related onboarding work. This owner-approved scope differs in two material areas: six direct working stage tabs are retained, and new worker runtime-observation infrastructure is not part of this simplification. Compatible work should be reconciled before implementation rather than duplicated.
- Publishing or reconciling child tickets must preserve clear blocking edges and keep every slice demoable. Prefer reusing compatible existing tickets after approval of their revised scope. Do not close or rewrite the existing parent spec as a side effect.
- Implementation priority is direct review and draft workspaces, then product-first preparation and exception resolution, followed by intake/header refinement and verified navigation retirement. Shared view-state work should be narrowly prefactored as an independently verifiable stage-switching and batch-return behavior.
