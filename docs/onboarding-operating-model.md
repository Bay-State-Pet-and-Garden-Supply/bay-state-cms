# Onboarding Operating Model — Store Manager Guide

This guide describes how a Store Manager operates product onboarding under the
operator-facing model adopted by [ADR 0016](adr/0016-onboarding-operating-model.md)
(epic #46), with stage navigation reconciled by
[ADR 0034](adr/0034-onboarding-rename-and-shell-rewrite.md). It is the human-facing counterpart to the internal six-stage
execution pipeline (Sourcing → Discovery → Extraction → Curation → Review →
Promotion), which remains the diagnostics/admin truth.

> **Core principle:** automation owns progression; the Store Manager owns
> exceptions, final verification, and release decisions.

The Store Manager manages **exceptions and quality**, not pipeline mechanics.

## Target operating workflow

```
Upload
  ↓
Distributor Lookup
  ↓
Official Site fallback when needed
  ↓
Extraction
  ↓
Family Readiness Barrier
  ↓
Cohort Curation
  ↓
Final Review
  ↓
Bulk Approval
  ↓
Ready to Export
```

1. **Upload** — import a spreadsheet of SKUs (hundreds in one sitting is
   expected).
2. **Distributor Lookup** — the system checks configured distributor sources
   first. An exact/acceptable match with sufficient product data becomes a
   complete listing source; the official site is never visited for it.
3. **Official Site fallback** — only products without usable distributor data
   are searched on the official manufacturer site. This is the largest
   human-intervention area (wrong size/variant SERP hits, multi-variant pages,
   missing extraction profiles).
4. **Extraction** — product data is extracted automatically (from distributor
   records or official pages).
5. **Family Readiness Barrier** — every active family member must finish
   extraction before the family may be curated. No "curate the available 3 of
   4" default; incomplete families wait.
6. **Cohort Curation** — once the family is ready, Curation runs automatically
   as a cohort, synthesizing store-ready titles, product types, attributes,
   and Category Page proposals.
7. **Final Review** — every product is inspected by a human before it may be
   approved. Review is fast and sequential ("Looks Good & Next").
8. **Bulk Approval** — the Store Manager approves the reviewed selection in
   bulk. Approval is a release decision; it does **not** export or publish.
9. **Draft creation and downstream release** — approval authorizes the existing
   CMS draft operation, not export or publication. In the approved workspace
   target, Create drafts is the task home; created drafts then continue through
   the downstream export/release workflow.

## The simplified batch workspace

The owner approved the following simplification on 2026-09-30. It is implemented
in the working tree; the [verification report](audits/onboarding-ui-simplification-332.md)
records scoped results and repository-wide check blockers.
The [UI simplification spec](plans/onboarding-ui-simplification.md) records the
complete scope and verification decisions.

The existing Batch Workspace keeps six stage tabs. Each opens its actual working
screen rather than a basic list followed by an Open workspace button:

| Stage tab | Main content | Primary human action |
| --- | --- | --- |
| **Identify & Route Sources** | Product, Brand, Source, Status, and Next action | assign brands quickly; open relevant domain/profile/strategy detail when needed |
| **Find product page** | Progress and specific source-page blockers | resolve the relevant page/variant issue |
| **Collect details** | Extraction or distributor-materialization progress and actionable failures | resolve the relevant collection issue |
| **Prepare listing** | Products preparing, waiting on family, or needing attention; real selected-product evidence | inspect preparation detail and correct actual gaps |
| **Review listings** | Review queue and persistent inspector; Needs review, Reviewed, and Approved filters | inspect, record review, then explicitly approve a reviewed selection |
| **Create drafts** | Approved products awaiting drafts, created CMS drafts, and completed/skipped outcomes | create drafts and follow the downstream release links |

Every product still has exactly one current Operator Work-State. Review-history
filters may show approved products that have advanced to Create drafts; this
does not change their Pipeline Stage. Attention spans all stages and is exposed
through a persistent **Needs attention · N** header control. Its panel opens the
issue list and existing resolver while preserving the underlying tab, filters,
and selected product. Batch tools no longer competes with stage navigation.

The compact header also contains recorded batch status, **Start branded
products**, Pause/Resume, and Settings. Start branded products describes the
existing brand-release behavior, not domain/profile readiness. Start all
products is an advanced overflow action; detailed live activity begins
collapsed. Execution permission does not prove worker activity.

New batches start at Identify & Route Sources. Existing batches remember the
last stage and filters, while explicit valid links take precedence. Restored
selection is checked against current membership and eligibility; resolution
and refresh do not silently change the active tab or discard pending edits.

## Terminology

Human-facing vocabulary describes tasks and outcomes:

| Internal stage | Human-facing term |
| --- | --- |
| Sourcing | Identify & Route Sources |
| Discovery | Find product page |
| Extraction | Collect details |
| Curation | Prepare listing |
| Review | Review listings |
| Promotion | Create drafts |

Internal enum names do not change. Raw technical state (stage, stage_status,
worker terminology) remains available in secondary diagnostics only.

## Exception workflows

### 1. Official Site resolution (one continuous task)

URL verification and extraction-profile setup are one workflow:

```
Candidate official product page found
        ↓
Is this the correct product / variant?
        ├─ No → choose/search another URL
        └─ Yes
             ↓
Does this domain have a usable extractor profile?
        ├─ Yes → resume automatic extraction
        └─ No → setup/fix extractor profile
                         ↓
               retry affected domain items
```

- The product identity panel is always visible: imported name, UPC/GTIN,
  Brand, size/variant hints, distributor evidence summary, family context.
- The candidate panel shows why a URL was selected, detected variant
  information, and alternatives.
- A confirmed URL is persisted before extraction resumes; a bad candidate URL
  can be replaced.
- A successful profile fix automatically unblocks other blocked products on
  the same domain where safe, and reports how many items were released.

### 2. Distributor-first handling

```
Upload item
   ↓
Distributor lookup(s)
   ↓
Exact/acceptable record found?
   ├─ yes → sufficient listing evidence?
   │          ├─ yes → materialize distributor data → family barrier
   │          └─ no  → official-site fallback
   └─ no → official-site fallback
```

- Clean distributor-sourced products never require an official URL or operator
  review before Curation.
- Insufficient distributor data falls back to the official site automatically.
- Source conflicts surface as Needs Attention tasks only when human judgment
  is actually required.
- The UI shows whether final listing evidence came from distributor records,
  official page extraction, or a supported combination.

### 3. Waiting on Family

A family whose members are not all extraction-ready shows readiness counts
(example: "3 / 5 products ready — waiting on: 30 lb — official product page
needs verification"). Waiting families require no manual Curation-start click;
once every active member is ready, cohort Curation runs automatically.

## Rapid final review

- Review is the primary intentional QA step. **Every** product is reviewed.
- A dense queue/table plus a persistent inspector replaces the single-column
  stage drawer.
- Primary action: **Looks Good & Next** — marks the product reviewed and opens
  the next unreviewed item.
- Keyboard navigation (previous/next, Esc, review shortcut) keeps sequential
  review practical for hundreds of items.
- Progress is explicit: `Reviewed 184 / 212`.
- Editing a reviewed product invalidates review when the edited field affects
  approved output.

## Bulk approval

- Unreviewed products cannot be bulk-approved through the normal path.
- Items with blocking semantic/review errors cannot be approved.
- In the approved workspace target, approval is available in the Reviewed
  filter of Review listings; it is a separate action rather than another
  destination. Approved products remain available for inspection without
  review-stage mutation controls.
- Approval reports exact success/failure counts; partial failures are visible
  and retryable; approval is auditable (actor/time/output version).
- Approval does **not** automatically export.

## Create drafts and Ready to Export

- In the approved workspace target, Create drafts opens the working draft
  screen directly, showing approved products awaiting draft creation, actual
  created drafts, and completed/skipped outcomes.
- Skipped outcomes include products skipped in any stage of the batch, not
  only products that reached Create drafts.
- Created drafts that await downstream export are Ready to Export. Draft
  result links and exact failures/retry options remain visible.
- Language matches the actual side effect (e.g. "creates ShopSite drafts");
  a product is never called `published` or `exported` until the underlying
  operation has succeeded and been verified.

## Target operator session

```
1. Store Manager uploads 300 new SKUs.

2. System begins automatically:
   - distributor lookup
   - official-site fallback where needed
   - extraction
   - cohort formation/readiness

3. Store Manager sees:
   Processing         267
   Needs Attention     21
   Waiting on Family   12
   Ready for Review     0

4. Manager opens Needs Attention:
   - confirms several variant URLs
   - fixes/creates extractor profiles for a few domains
   - resolves the actual blockers

5. Automation resumes affected products automatically.

6. Complete families automatically run Curation.

7. Batch eventually shows 300 Ready for Review.

8. Manager opens Review and works sequentially:
   - inspect → Looks Good & Next → inspect → Looks Good & Next → edit when required

9. Review progress reaches 300 / 300.

10. Manager bulk-approves a reviewed selection in Review listings.

11. Approved products appear in Create drafts, awaiting CMS draft creation.

12. Manager creates CMS drafts and follows the downstream export/release
    workflow when operationally appropriate.
```

The desired experience is not "move 300 cards through six columns." It is:

> **Let the system do the work, show me exactly where it needs me, let me
> verify the results quickly, then let me approve and release them in bulk.**

## Product success criteria

- The majority of clean products require **zero** manual interaction before
  Review.
- Distributor-complete products do not incur unnecessary official-site work.
- Users can immediately identify the small set of blocking products.
- No family begins Curation before required active siblings are ready.
- Every product receives a final human review.
- Reviewing hundreds of products is practical through rapid sequential
  navigation.
- Approval is bulk-efficient.
- Approval and export state are never conflated.

## Observability

Track at batch and global level (implemented by the onboarding telemetry
surface): automation completion rate, items needing attention (by reason),
attention resolution time, products completed from distributor-only,
products requiring official site, extractor-profile block rate and domain
unblock count, families waiting count and wait duration, cohort Curation
success rate, products ready for review, review throughput
(products per minute) and edit rate, bulk approval success rate, and export
success rate.
