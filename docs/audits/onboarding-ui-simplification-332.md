# Onboarding UI simplification — working-tree verification

Governing spec: [#332](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/332).
Implementation tickets: #278, #282, #280, #285, #279, #283, #284, #281, #286.

## Delivered behavior

- One six-stage Batch Workspace. Review listings and Create drafts open their
  working views directly; Batch tools and workspace-opening detours are removed.
- Review contains Needs review, Reviewed, and Approved filters, stable
  server-owned status totals/progress, explicit reviewed-selection approval,
  and inspection-only controls for approved/terminal products.
- Prepare listing is product-first, displaying real per-item preparation
  projections, effective-run evidence, gap facts/correction, family readiness,
  and actionable blocking siblings.
- Batch-wide attention opens a shell-owned list/resolver panel without changing
  the working stage. Search, filters, selection, and pending edits survive
  stage switching; Escape restores the attention invoker's focus.
- Intake uses five concise columns and selected-product configuration, retains
  quick/contextual bulk brand assignment, and preserves source exemptions.
  List reads now fetch one bounded page rather than automatically draining.
- The compact header accurately names Start branded products, exposes Start all
  products in overflow, and initially collapses existing live activity.
- Old task links map to their new stage/filter/panel homes. Per-workspace/batch
  preferences restore valid working context, with explicit navigation taking
  precedence over remembered defaults.
- Draft creation reuses native promotion under the operation receipt's
  transaction. Successful draft records, item completion, receipt, and audit
  are atomic; item-specific persisted linkage remains truthful across cold
  reads and prevents duplicate creation under a different idempotency key.

## Subagent orchestration and review

Independent file ownership covered workspace preferences/navigation, execution
controls, review/approval and its server read contract, draft/outcome UI,
preparation/family details, intake, tracker reconciliation, and integration
tests. The main agent composed the shell and completed browser verification
after the frontend designer was cancelled.

- Standards/correctness review reported no materially actionable findings in
  the scoped implementation, including transaction, authority, and isolation.
- Spec review raised legacy-link precedence. The shell now explicitly
  distinguishes an absent legacy selector from an explicit destination;
  mapping/restoration tests cover the relevant cases.
- Earlier issue IDs were reused, their bodies reconciled to #332, and native
  GitHub dependencies verified. The existing parent #277 and native grouping
  were preserved. No implementation issue is closed by this verification.

## Automated verification

| Check | Result |
| --- | --- |
| Complete Vitest suite, `bun run test:unit` | **328 files passed; 4,316 tests passed; 1 skipped.** |
| New native draft-authority suite, `bun test --timeout 30000 src/tests/unit/onboarding-export-draft-authority.test.ts` | Passed, including cold reads, distinct-key duplicates, partial failures, stale approval, workspace isolation, v2 stage spelling, and transaction rollback. |
| Native DB chain, `bun run test:db` | **2,321 passed; 1 live Jev qualification test failed; the remaining chained groups did not run.** |
| Test-runner registration, `bun run test:runner-coverage` | 653 suites scanned; 181 Bun suites; 0 new violations; 30 documented baseline violations. |
| ESLint on changed UI TypeScript files | Passed for all 24 files. |
| ESLint on affected backend/test files | 27 findings, matching the pre-change HEAD baseline by file/rule/count. |
| Full `bun run lint` | Failed: 3,008 errors and 3 warnings across the existing tree. |
| `bun run typecheck` | Failed on the same three unrelated diagnostics recorded before implementation. |
| `bun run build` | Vite bundling passed: 445 modules, 1.56 seconds. The command failed at the subsequent TypeScript check on those same three diagnostics. |
| `git diff --check` | Passed. |

The full `bun run test` was attempted. Its first run stopped at three assertions
tied to the retired interface. Those tests were updated to verify direct stage
entry, bounded loaded-row pagination, and governed idempotent calls. All three
focused files passed, and the complete Vitest suite then passed as shown above.
The native chain was run separately and stopped at the unrelated live test.

### Repository-wide blockers

- `scripts/seed-jev-canary.ts:111` and `:164`: duplicate block-scoped
  `manifestPath` declarations.
- `src/tests/unit/browser-investigation-tier1.test.ts:815`: `null` assigned where
  the type permits only `number | undefined`.
- The native test `captures live Jev judgments against frozen gold evidence
  (opt-in keyed live capture, real network)` failed in the existing qualification
  suite. No credentials were inspected, changed, or included in this report.
- Full-tree lint includes existing unrelated findings. Targeted UI lint is
  clean; backend/test findings were compared with HEAD rather than silently
  repaired or suppressed.

## Bounded browser verification

The actual React components and CSS were mounted in a Vite-only synthetic
fixture with fictional product data and in-memory API responses. No customer
database or ShopSite communication was used. This verifies UI composition and
interaction, not a production-backend end-to-end run.

- Desktop: **1440 × 1000**. Narrow viewport: **390 × 844**.
- Verified direct Review/Create drafts entry, preparation product/details,
  intake controls, Reviewed approval availability, and Approved inspection with
  no review-stage actions or selection checkboxes.
- Verified attention opening preserves the Review stage and search text;
  Escape closes the panel and restores focus to its header control.
- Verified stage switching preserves Review search/filter context and exposes
  exactly one visible stage panel.
- Document scroll width did not exceed viewport width in Review, preparation,
  drafts, or attention. Intentional table/tab scrolling remains scoped.
- Fixed narrow review-row title/badge overlap in one batch and confirmed the
  corrected geometry and screenshot. No browser errors were reported.
- Browser session and the fixture's owned Vite process were stopped afterward.

Screenshots are temporary local artifacts under
`/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/`:

- `onboarding-review-desktop.png`
- `onboarding-preparation-desktop.png`
- `onboarding-drafts-desktop.png`
- `onboarding-review-narrow-confirmed.png`
- `onboarding-attention-narrow.png`
- `onboarding-preparation-narrow.png`
- `onboarding-drafts-narrow.png`

## Delivery status

Implementation and focused verification are complete in the working tree.
Repository-wide verification remains blocked as documented above. Changes are
not committed or pushed; unrelated existing work was preserved.

## Follow-up direct self-review

The subsequent [direct self-review](onboarding-ui-simplification-332-self-review.md)
reproduced five implementation defects that the green regression suite and
earlier subagent reviews did not cover. These include a draft-linkage/duplicate
barrier issue, pagination/context regressions, and unguarded preparation edits.
The earlier test results remain accurate for their covered cases, but were not
full acceptance evidence. The subsequent [fix pass](onboarding-ui-simplification-332-fixes.md)
resolved all five findings and added permanent regressions. Its full Vitest and
affected native suites pass; unrelated repository-wide blockers remain documented.
