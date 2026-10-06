# Jev V8 activation and unfinished qualification — 2026-10-05

## Governed activation completed

The authenticated release API validated and pinned `bay-state-v8` at
`2026-10-05T08:26:00.049Z`. The separate catalog commit is
`9d8b54cf83d42e00e988f08efae7f280ebd76b69` and changes only
`store/classification/state.json`. The local API was refreshed to load the
new description schemas and remains token-authenticated on loopback.

The new frozen authority was captured through the read-only preparation CLI:

- Release: `bay-state-v8`.
- Full authority: `78f550f0b31c51c5a3c4b5f614e0bc953a90fdbe49749b7b39d6cd2ceeeef2de`.
- Config: `098499155c24642ddfa061dfc0455528267109ed6c062af42009ec7d51d37ab3`.
- Verified Pages: 212, import `68d699b2-9c47-439e-87e3-110ef688ec0b`,
  hash `60cdb1235506d36b879fd0b95f1d1578434381f0aae9e2b2973d2739556a15fe`.
- Preparation writes: four public metadata files, zero DB writes, zero model calls.

The previous 121 development entries were independently re-adjudicated under
V8 into new files, preserving V7 input/gold history. V8 support is 91 known,
17 unlabeled, 8 no-fit and 5 insufficient-evidence; no complete Page gold.
This is source-only adjudication, not human product approval or a new live
model accuracy result.

## Concrete harness and collection fixes

The incumbent CLI no longer treats a database path as a credential reference.
It requires an explicit reference and validates isolation before `initDb`:
operational/repository-local stores, `.shopsite-cms` paths and symlink/hard-link
aliases of the production DB are refused. This guard does not claim that the
live incumbent bridge or its transport budget is complete.

A red-capable collector test reproduced five defects: navigation, product-line
listings, ingredient glossary and cookie-only pages were admitted as products;
cookie text contaminated a valid product's evidence. Admission now requires
one matching Product identity and extracts product-specific descriptions.
The same real extractor seam now passes those regressions.

Additional guard tests cover request caps, public URL validation on every
redirect, normalized denial propagation, refusal to overwrite sealed artifacts,
validated seed files, verified feed/sitemap joins and exclusion of obvious
non-product discovery URLs. A separate failing test caught whole-file authority
hashing: collector identity now reuses the preparation/replay domain and excludes
observation time. The original V4 metadata is archived and corrected, with
input and membership bytes unchanged. **15 collector tests pass.**

## Evidence collection: incomplete and unqualified

The owner approved 2,000 additional source requests, increasing the total cap
to 3,200. The cumulative ledger records **3,107 requests used / 93 remaining**;
redirects and failures count. Model inference has a separate budget. No new
qualification inference was performed during this collection work.

The first fresh collection produced 394 apparent families, including 88 held
families, but the admission defect contaminated that population with non-product
and thin captures. It is exploratory and **ineligible for qualification**.
Independent private review quarantined 42 non-product held rows and corrected
a stage-gold bug: Primary Product Type had incorrectly depended on other stages'
completeness. The remaining private source-only revision has 19 known types and
27 insufficient-evidence products. These aggregate counts are not adequate
class support or an approval receipt. No private cases are identified here.

The corrected V4 collection kept 28 new families: 23 development families and
five sealed holdout families. Family grouping and seed-42 splits were preserved;
previous development families were not reassigned to holdout. Corrected metadata
binds the actual V8 authority above. Source/membership commitments are public;
private inputs and labels remain outside Git under approved custody.

The original 391-family holdout remains quarantined in full because of the
earlier custody communication exposure. It has not been silently resealed.

## Page evidence

The source audit covers all 212 verified identities, with 148 direct-listing
definitions, 44 navigation definitions and 20 unresolved purposes/identity
bindings. Purpose evidence does not prove a product's Page membership.
The unresolved bindings require additional evidence or specific owner policy
decisions. No Page retirement, replacement UUID or invented hierarchy occurred.
The Page audit used 273 source requests included in the cumulative ledger.

## Verification and independent review

- Latest replay/qualification/SystemOne group after the isolation guard:
  140 pass, 1 skip, 0 fail.
- Collector: 15 pass, 0 fail.
- Full Vitest portion: 336 files, 4,382 pass, 1 skip.
- The full `bun run test` command is not green: its DB leg failed. A sequential
  rerun reached the previously reproduced four sourcing-observe failures.
  The principal Bun group passed 1,969 tests with 1 skip during that rerun.
  Earlier disk-I/O errors in the combined run are not a passed check.
- Mixed-worktree typecheck retains the unrelated
  `browser-investigation-tier1.test.ts:815` null/number mismatch.
- Runner coverage: 664 suites, 184 Bun suites, zero new violations,
  30 documented-baseline violations.
- `git diff --check` passed before this audit write; final verification records
  must bind the eventual reviewed commit, not the previous `5907853b` receipts.

### Standards review

The independent reviewer withdrew an incorrect unknown-to-zero finding after
verifying that the internal comparison sentinel is availability-gated and
unknown Product Type probability persists as null. No confirmed hard standard
violation remained in the reviewed scope. Optional design-smell observations
were not treated as a request for unrelated cleanup.

### Spec review

The independent reviewer withdrew a floating-point-tolerance finding: machine
epsilon does not permit a sum of 1.0105 and existing out-of-bound tests reject it.
Owner-approved release/authentication changes were recognized as in scope.
The real isolation defect was fixed. True gaps remain: a live incumbent
comparison, transport budget/identity plumbing for that leg, actual offline
Page/cohort seams, qualifying support, fitted policy publication and human
canary approval.

## Post-commit verification

Commit `9d2441d828708876760b2b7b0e2952f349c4d958` now has fresh evidence from
a clean detached checkout: TypeScript passed; focused checks passed 218 tests
with one skip; the four compatibility suites passed 720 tests with one skip.
The bounded actual live contract returned `jev-1.13.0` in one HTTP attempt.
An actual loopback stored-disablement/lease exercise passed with request counts
0 / 1 / 1 and no retries after either authority changed.
See `jev-commit-verification-9d2441d8-2026-10-05.md` and its three JSON receipts.
This refreshes those prerequisites for the committed implementation; it does
not establish new V8 product accuracy or a globally green full test command.

## Release decision

**#302 remains blocked and #312 remains gated.** Neither source collection,
code completion nor an active taxonomy pin establishes production quality.
No fitted policy/publication or holdout unseal is asserted. Qualification still
needs adequately supported product evidence, complete Page/cohort labels,
the actual incumbent comparison and actual production Page/cohort evaluation
seams. Real-product canaries retain final Store Manager review.
