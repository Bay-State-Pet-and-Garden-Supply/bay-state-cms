# Onboarding simplification #332 — self-review fixes

All five findings in the [direct self-review](onboarding-ui-simplification-332-self-review.md)
are resolved in the working tree and covered by permanent behavior tests.

## Fixes

1. **Durable draft origin:** linked reads and different-key duplicate protection
   use the completed export receipt's immutable item/change-set association,
   joined to the actual persisted draft record and its workspace/batch/SKU.
   Editable product JSON is retained only as a legacy fallback. Catalog edits
   no longer erase the authoritative binding; a receipt without a persisted
   record is not projected as a draft. No database migration was introduced.
2. **Intake context:** refreshes atomically replace the pages already loaded,
   using fresh bounded cursors. Worker bursts are coalesced rather than
   cancelling a multi-page refresh repeatedly. Valid inspector and bulk
   selections survive; products genuinely leaving the refreshed scope are
   pruned. Pending configuration and commands defer automatic refresh.
3. **Review pagination:** replacement queue requests cancel obsolete cursor
   ownership and reset its busy state. An old response cannot clear a newer
   cursor request's state, duplicate Load more commands are coalesced, and
   cursor reads cannot start against an outstanding replacement queue read.
4. **Restored Review context:** a validated optional selected-item request
   returns one compact `selectedRow` independently of page membership. It
   respects the original filters and batch ownership and does not alter page
   rows, totals, or cursor identity. Only an explicit server result can prove
   a remembered product left the scope; selected detail remains bounded.
5. **Preparation edits:** correction dirtiness reaches the shell's exit guard
   and browser unload protection. Product/filter changes require explicit
   discard. Background gap changes retain the editor's bound request and
   pending values. Stale submissions also keep their values; explicit reload
   refreshes the parent context instead of leaving it disabled or outdated.

## Permanent regression coverage

- `onboarding-export-draft-authority.test.ts`: Catalog save, cold linkage,
  legacy missing-completion duplicate protection, and absent persisted record.
- `onboarding-stage-one-intake.test.tsx`: later-page inspector/bulk selection,
  real removal, fresh bounded cursors, and coalesced worker refreshes.
- `review-queue-request-ownership.test.tsx`: superseded cursor cleanup, a newer
  request retaining ownership, repeated commands, and replacement-read gating.
- `review-workspace-approval.test.tsx`: restored off-page inspection and
  selection replacement only after authoritative scope removal.
- `review-queue-routes-adversarial.test.ts`: bounded selected context,
  unchanged count/cursor predicates, and unknown/foreign selection isolation.
- `gap-correction-edit-guards.test.tsx`: Back/Settings guards, unload, confirmed
  submission clearing dirtiness, and deliberate stale-request reload.
- `onboarding-prepare-listing.test.tsx`: guarded product/filter changes,
  pending values surviving background changes, explicit discard, and refreshed
  usable context after a stale-request reload.
- Existing correction and inspector stress tests now verify deliberate reload
  and real controlled React draft state across fresh SSE responses.

## Verification

| Check | Result |
| --- | --- |
| Full `bun run test:unit` | **330 files passed; 4,330 tests passed; 1 skipped.** |
| Native draft-authority suite | **19 passed.** |
| Native review-queue HTTP/adversarial suite | **14 passed.** |
| Native review-queue schema suite | **15 passed.** |
| Native stage-read query-plan suite | **16 passed.** |
| Native work-state query-plan suite | **15 passed.** |
| Native total | **79 passed**, run in isolated processes. |
| Test-runner registration | 655 suites; 181 Bun suites; 0 new violations; 30 documented baseline violations. |
| Lint on 19 fix-related files | 18 clean; only the pre-existing empty catch in `onboarding-work-api.ts:145` remains, confirmed against HEAD. |
| `bun run typecheck` | Only the three previously recorded unrelated diagnostics remain. |
| `bun run build` | Vite succeeded: 445 modules in 1.48 seconds. The subsequent TypeScript step is blocked by those same diagnostics. |
| `git diff --check` | Passed. |

TypeScript blockers remain the duplicate `manifestPath` declarations in
`scripts/seed-jev-canary.ts:111,164` and the null/number mismatch in
`src/tests/unit/browser-investigation-tier1.test.ts:815`. The broader native
chain's earlier live Jev failure is not reclassified as resolved; affected
native checks above all pass. Application code and new tests introduce no new
TypeScript diagnostics.

Changes remain uncommitted. Existing unrelated work is preserved.
