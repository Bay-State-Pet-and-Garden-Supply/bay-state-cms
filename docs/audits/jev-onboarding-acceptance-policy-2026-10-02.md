# Jev onboarding acceptance policy — 2026-10-02

This policy governs release evidence for #293/#302 and the #312 retirement dependency.
It is a release gate, not permission for a model or evaluator to approve products.

## Pinned implementation

- Model: `jev-1.13.0`, with exact returned-model validation.
- Choice: selected-outcome probability floor 0.50. Noul: per-value/page P(yes)
  floor 0.70. Confidence/concentration is not an approval signal.
- Page membership questions: `page-question-v2`; judgment/provenance contract:
  `jev-page-v2-provenance`. Generic brand directories are not substitutes for a
  missing brand-specific product listing page.
- Taxonomy: approved `bay-state-v5`; candidate sets and applicable profiles must
  come from a frozen production snapshot, never from the gold-label union.
- Pages: verified live ShopSite import. Never invent Page IDs or page names.

Verification revision, 2026-10-03: qualification predictor `code-executed-v5`
retains exact semantic abstention codes; `no_match` and `insufficient_evidence`
only earn correctness against their matching gold state. Low-probability,
uncoded legacy and service-failure abstentions do not. Unlabeled rows are excluded
from the Product Type accuracy denominator. The predeclared paired primary metric
is `productType.rawCorrectness`, bootstrapped over the same labeled fixed population.
The existing conservative benchmark gate requires 200 labeled holdout examples,
20 per evaluated class, coverage 0.80, zero safety violations and a positive lower
95% paired-delta bound. These are necessary gates, not fitted per-capability or
representative-assortment evidence. This revision does not reseal prior holdouts.

## Required evidence

1. Development evidence must demonstrate the thresholds and question meanings
   on the applicable configured targets. A frozen fixture demonstrating API
   behavior is not statistical validation of the entire assortment.
2. Publish the model/question/threshold policy before inspecting the qualifying
   holdout. The September fixture holdout was already inspected; re-running it
   is a regression check, not a new sealed-holdout qualification.
3. Use family-separated labeled support for food/treats, toys, animal care,
   garden/pest control, neighboring types, no-fit and insufficient-evidence
   outcomes, plus mixed-cohort page behavior. Report sample counts and uncovered
   capabilities; inadequate support remains unqualified.
4. Report raw fixed-population correctness, coverage, errors, harmful regressions,
   abstention recovery and set precision/recall. No harmful holdout regression,
   unsupported claim, invented page or candidate service failure is acceptable.
   Baseline service failures must be reported rather than credited as correct
   abstentions or semantic recovery.
5. Demonstrate disable-before-dispatch and disable-before-retry. Record actual
   evidence and publication timing; code existence does not satisfy either gate.
6. Bind compatibility checks to the code tested. A receipt naming HEAD does not
   qualify an uncommitted runtime worktree. Keep non-classification providers,
   catalog draft-only behavior, frozen snapshots and historical readers covered.
7. Retain individually reviewed human canary decisions and final approval.
   `agent_review` is attributed evaluator work, not `human_review`; pending,
   deferred, stale, missing or anonymous decisions cannot mint review receipts.
   Singleton page review does not certify the cohort canary.

## Known evidence limitations

- The retained development artifact contains 12 approved synthetic text cases
  and a bounded real-provider comparison. It does not exercise production
  Sourcing/Extraction provenance or prove every configured attribute/profile.
- The hand-seeded app items lack real source/extraction bindings. They remain
  unsuitable for qualifying the production worker; readiness checks are not
  bypassed and placeholder images are not OCR ground truth.
- The local OCR smoke proves loading, real inference, parsing and evidence
  materialization. It is not an OCR accuracy claim: the Instinct image says
  “FreshRaw Meals” while the VLM normalized its form to “Wet Food”. Keep raw
  visible text, structured interpretation and human corrections distinct.
- Old run snapshots and decisions retain their original meanings. New question
  or taxonomy versions require fresh qualifying runs; stored contradictions are
  not retrospectively rewritten by the food-form alias activation.

## Retirement

#312 remains gated by actual #302 qualification. The parked retirement commit
`36f4328a` requires re-audit against the current cohort modules and re-evaluation
after cleanup. Do not delete the live comparator or silently redirect local-only
routes to cloud Jev to make a checklist appear complete.
