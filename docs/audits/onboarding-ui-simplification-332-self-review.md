# Onboarding simplification #332 — direct self-review

**Follow-up:** all five findings below are fixed in the working tree and covered
by permanent regressions. See the [fix verification report](onboarding-ui-simplification-332-fixes.md).
The findings and reproduction evidence below describe the pre-fix implementation.

Scope: the implementation working tree compared with
`e431eb35c523af7bb1f2fc3b25e7638b231e9341`, plus its new files, against the
owner-approved spec #332. Existing browser-investigation/canary changes are
outside this review. This review was performed directly, without subagents.

**Result: five actionable findings.** Six focused reproduction assertions fail
against the implementation: four UI cases and two native cases for the same
draft-linkage defect. These findings qualify the earlier green regression-suite
and subagent review results; they are coverage gaps, not the unrelated baseline
TypeScript/lint/live-provider blockers.

## Standards and architecture

The changed read/command seams retain shared validation and repository-owned
new SQL. The native promoter retains a transaction for its ordinary caller,
while the receipt path owns its combined draft/completion/audit transaction.
No additional credential or workspace-isolation violation was identified.

The new draft identity linkage, however, depends on an undeclared product-JSON
property rather than a durable record relationship preserved by catalog edits.
Its concrete correctness consequence is finding 1 below.

## Findings against the spec

### 1. P1 — Catalog edits destroy the draft-link duplicate barrier

Locations: `src/onboarding/draft-promoter.ts:1966–1971`,
`src/db/repositories/onboarding-review-repo.ts:94–105` and `:530–535`.

The implementation stores the originating onboarding item as root `itemId` in
`change_set_items.draft_json`. Both linked reads and the already-drafted guard
depend on that property. The normal Catalog editor submits only core, custom
fields, and ShopSite data (`ProductDetail.tsx:211–215`); `autosaveDraft` rebuilds
the product from the approved/empty base (`product-service.ts:84–100`) and
overwrites the same draft row without `itemId`.

Reproduction: create a native onboarding draft, run the ordinary catalog save
with an edited price and the other existing fields, then read item linkage.
The row and change set still exist, but linked-record count changes **1 → 0**.
In the supported older-completion-write scenario (item still pending), the same
edit followed by a different-key creation actually creates another draft rather
than returning `already_drafted`.

Fix direction: preserve authoritative item-to-draft provenance independently
of editable product JSON, or make every draft rewrite reliably preserve and
validate it. Verify Catalog save, cold reads, and different-key repeats together.

### 2. P2 — Automatic batch refresh discards valid paginated intake context

Locations: `src/client/components/onboarding/StageItemsView.tsx:289–296` and
`:311–315`; refresh source: `BatchWorkspace.tsx:113–116`.

Every batch event increments `refreshKey`; the intake effect calls `load(null)`.
That replaces all loaded pages with the first page and treats valid products
outside that page as removed, pruning inspector and mutation selections.

Reproduction: load 100 unchanged products, open product 75, then increment the
shell refresh key. The list falls **100 → 50** and the valid inspector selection
is lost. Continuous processing can repeatedly interrupt later-page intake work.

Fix direction: refresh the loaded scope, or retain/revalidate named product
context separately. Absence from the first page is not evidence of ineligibility.

### 3. P2 — Review Load more can remain permanently busy after an SSE refresh

Locations: `src/client/components/onboarding/review/use-review-queue.ts:66–76`
and `:104–126`.

A silent refresh increments `requestVersionRef` while a page fetch is pending.
The obsolete page's `finally` then intentionally skips clearing `loadingMore`,
and the replacement refresh never clears it either. `loadMore` refuses further
requests while that flag remains true.

Reproduction: start a pending cursor fetch, complete `loadQueue({silent:true})`,
then settle the old cursor response. The refreshed queue still has a next
cursor, but **`loadingMore` remains true**. Further pagination is disabled until
a filter change or remount.

Fix direction: cancellation/supersession must reset pagination busy state under
the new request owner without allowing an old request to clear a newer request.

### 4. P2 — Review restoration replaces a valid later-page product

Location: `src/client/components/onboarding/review/ReviewWorkspace.tsx:836–847`.

Restored inspector selection is compared only with the first loaded review
page. If the product is not on that page, it is silently replaced by the first
row and the replacement is persisted as the new preference.

Reproduction: remember `review-75` in a 100-product unreviewed scope, then mount
Review with its first 50 rows. Persisted selection becomes **`review-0`**, even
though product 75 remains valid and its detail can be fetched.

Fix direction: distinguish not-yet-loaded from no-longer-in-scope; use a bounded
selected-product context lookup, as the preparation view already does.

### 5. P2 — Unsaved preparation corrections bypass the batch-exit guard

Locations: `src/client/components/onboarding/PreparationItemDetails.tsx:245–247`
and `src/client/components/onboarding/BatchWorkspace.tsx:184–186`.

The shell guards leaving only when it finds `data-onboarding-dirty="true"`.
Review and intake emit that marker, but the newly embedded GapCorrectionPanel
keeps correction values only in local state and never registers dirty state.
Leaving the batch or opening Settings discards those values without the guard.

Reproduction: enter an unsaved description correction, click Back to batches,
and spy on confirmation/navigation. **Confirmation is not called and the back
callback runs**, despite the pending value.

Fix direction: register correction dirtiness with the shell and guard product
changes/navigation consistently until submission or explicit discard.

## Reproduction evidence

The temporary UI file was executed with:

`bun run test:unit src/tests/unit/onboarding-self-review-repros.test.tsx`

Result: **4 targeted assertions failed**, with actual values shown above.

Two temporary native probes were inserted into the existing isolated
draft-authority fixture and executed with:

`bun test --timeout 30000 src/tests/unit/onboarding-export-draft-authority.test.ts --test-name-pattern 'SELF-REVIEW REPRO'`

Result: **2 targeted assertions failed**, proving provenance loss and duplicate
creation after a catalog edit in the older-completion-write scenario.

The temporary probes were removed from registered suites after recording the
results. Archived sources are available locally under
`/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/`:

- `onboarding-self-review-repros.test.tsx` — copy under the original test
  directory to run its four rendered/hook probes.
- `onboarding-self-review-native-probes.txt` — insert into the existing fixture
  describe to run the two native probes.

No application fixes were made during the review itself. The subsequent fix
pass resolved these findings and added permanent behavior tests; remaining
repository-wide verification blockers are documented in the follow-up report.
