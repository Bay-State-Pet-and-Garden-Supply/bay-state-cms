# Representative Jev development verification — 2026-10-05

## Release decision

**Issue #302 remains blocked; #312 remains gated.** No fitted acceptance policy
has been published and no qualifying holdout evaluation has been performed.
This audit records development evidence from the dirty worktree based on
`5907853b07d98d233848f48723581afe641eb787`, not a clean-commit release receipt.

## Integration fixes verified

- Taxonomy status/activation requests use `/api/settings/taxonomy-release`
  and the configured bearer-token headers shared with the main API client.
  Missing credentials remain missing; the server's authentication/admin gates
  still apply. Seven focused client tests passed.
- The live Settings page renders `bay-state-v7` active with hashes OK and no
  alerts; rejected `bay-state-v6` is absent. This was a read-only browser check,
  not a new activation or approval.
- Replay recomputes the complete canonical authority hash over
  `{bundle, pages, binding-minus-capturedAt}` and checks gold containment before
  returning inputs. Shape-valid invented types/values/pages cannot become
  controlled authority. Tampered authority fails before dispatch.
- Actual approved attribute names, definitions, target labels, aliases,
  catalog fields and claim guards travel in a validated, hashed sidecar.
  Per-value Noul probabilities and their digest remain attached to captures.
- V5-derived release generation follows hierarchy evidence, then bounded
  baseline lineage, then schema fallback. A schema-3 descendant does not
  accidentally short-circuit to V4 validation before examining its V5 parent.
- Unmeasured percentages, F1, precision and recall render `n/a` in the CLI.
  Attribute evaluation counts describe product attribute sets, not individual
  target slots.

## Independently reviewed development population

The unchanged 27-row pilot (26 families) plus 94 new development families gives
**121 rows / 120 independent families**. Source-only peer review checked
literal citations, frozen vocabulary/profile membership, cardinality and
family separation. An invented type and four input/authority-boundary
disagreements were corrected independently of predictions. Rejected bytes
and review findings are preserved in `jev-representative-v2/`.

Current gold: 87 known types, 8 no-fit, 6 insufficient-evidence, 20 unlabeled.
The four post-capture boundary corrections were marked unlabeled; their
ambiguity is not resolved by changing labels to match model answers.

The calibration manifest explicitly binds current gold and taxonomy file
hashes. The loader validates 121 rows / 120 families with no family leakage.
The frozen runtime pool is 74 types, 9 controlled attribute targets, 74
profiles, 4 universals and 212 verified pages; the source bundle contains
27 attributes. Gold never supplies the option pool.

## Bounded live capture and rescore

- Capture: `jev-representative-v2/development-predictions-v6-calibration-v7.json`.
- Predictor: `code-executed-v6`; exact model: `jev-1.13.0`.
- Artifact: `5f27c0d3d3d8d71da2343a2046b03306ae35c081834dcd4afd765f37df4e635a`.
- Full authority: `2310c06a9e92ef55b91dc96b03fa6b31e19656b0adfead653f7c572040713577`.
- Details: `8e85f87a4439f2b7992b40b179b63a0b3376166abf59f7c59a1c3483e11905a4`.
- Snapshot: `d74ca8cdc9963d90aca87aa65e5b827ecc8782df49cb2b3f3c5236ffa22fa3fb`.
- Preflight: 1,331 questions / 242 batches / 484 worst-case HTTP attempts.
  Actual: **223 attempts**, 0 rejected, no deadline firing, cap 600,
  concurrency at most 2, deadline 300,000 ms.

Primary independently recomputed the details digest using the shipped
`frozenAuthorityDetailsHash`; full authority, details and snapshot all match
the immutable capture. Current labels were joined to unchanged captured
outputs using the shipped evaluator; no second live run was needed.

| Current development rescore | Eligible | Correctness | Coverage | Incorrect | Harmful regressions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Product Type | 101 | 93.07% | 85.15% | 2 | 0 |
| Product attribute sets | 110 | 70.00% | 80.00% | 26 | 1 |
| Complete Page sets | 0 | n/a | n/a | n/a | n/a |

The comparator is **deterministic_floor**, not the live incumbent provider.
Pricing is unknown. This evidence does not measure operator-time improvement,
coordinated-cohort Page quality, extraction readiness or human approval.

`development-policy-analysis-v7.{json,md}` records family-disjoint support and
conditional stricter concrete-proposal filters. No tested filter meets both
80% coverage and zero errors. Per-class development support has maximum 12,
below the required 20/class. Abstention-side `confidence: 0` is a placeholder,
not retained selected-outcome probability; those outcomes cannot be refitted
as if their full distributions were available. The earlier gold-union analysis
was rejected and preserved, then replaced with the actual frozen-snapshot
rescore. **`policyPublicationBlocked: true`;
`policiesPublishedBeforeHoldout: false`.**

## Holdout custody

The custodian completed source-only review of 391 private families and kept
private revisions outside Git. Aggregate receipt:
`jev-representative-v2/holdout-custody.json`.

The custodian's communication exceeded aggregate-only reporting by including
potentially recognizable label-change descriptions. The exposure is recorded;
the dataset is **ineligible for qualification/unsealing pending independent
custody recovery or a new unexposed family-separated holdout**. No pristine
blindness or silent resealing is claimed. No private payload was opened by
primary or used to tune questions/thresholds. Page completeness and per-class
support remain separate blockers. This audit contains no private case mappings.

## Verification actually run

- Eight focused Bun suites: 183 pass, 1 skip before the final loader/lineage
  additions; no failures.
- Latest replay/qualification/SystemOne group: 129 pass, 1 skip, 0 fail.
- Latest release V7/V6/authoring group: 34 pass, 0 fail.
- Taxonomy client Vitest suite: 7 pass.
- Runner coverage: 662 suites, 183 Bun suites, 0 new violations,
  30 documented-baseline violations.
- Typecheck still reports the unrelated existing
  `browser-investigation-tier1.test.ts:815` null/number mismatch.
- Focused lint reports three pre-existing unused imports in
  `jev-qualification-service.ts`; all three have one reference in both HEAD
  and the worktree. The other five checked files had no messages.
- `git diff --check` passed with the audit present.

Tracker update: [issue #302 development status](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/302#issuecomment-5989009300).

## Remaining release prerequisites

Resolve ambiguous type boundaries with explicit approved definitions/source
facts; obtain adequately supported, genuinely unexposed evaluation data and
complete Page/cohort gold; retain missing raw outcome probabilities; fit and
publish policies before release evaluation; compare the real incumbent in an
isolated harness; commit reviewed owned code and bind fresh compatibility/live
receipts; complete source-ready human-reviewed canaries. No automatic
promotion, ShopSite publish, #302 closure or #312 retirement is authorized by
this development evidence.

## Subsequent owner-approved definition update

The owner explicitly selected **Skin and coat care** for Grooming, including
medicated topical care while retaining the separate flea/tick-targeted type,
and **Include repellent devices** for Insect & Pest Control.

`bay-state-v8` was authored from v7 and validated as a candidate. The compiled
diff changes only the two approved descriptions; profile memberships,
invariants and the two multi-species profiles are identical. See
`taxonomy-v8-descriptions-proof-2026-10-05.md`. The candidate has not been
activated; the workspace remains on v7.

An additive optional frozen Product Type description now carries those
definitions into question criteria without rewriting historical snapshots.
New captures also retain actual Product Type outcome probability, full Choice
probabilities when supplied, and a probability digest; historical missing
probability remains unknown. Existing v7 captures above were not rewritten or
re-run under v8 authority.

Latest post-update check: **181 Bun tests passed, 1 skipped, 0 failed** across
release V8/V7/V6/authoring and replay/qualification/SystemOne suites.
`git diff --check` passed. These remain worktree checks, not committed release
qualification receipts.
