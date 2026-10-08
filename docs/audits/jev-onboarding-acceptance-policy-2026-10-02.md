# Jev onboarding acceptance policy — 2026-10-02

This policy governs release evidence for #293/#302 and the #312 retirement dependency.
It is a release gate, not permission for a model or evaluator to approve products.

## Pinned implementation

- Model: `jev-1.13.0`, with exact returned-model validation.
- Engineering defaults, not fitted acceptance policies: Choice selected-outcome
  floor 0.50; Noul per-value/page P(yes) floor 0.70. Publish separately fitted
  store/capability policies before holdout inspection. Confidence/concentration
  is never an approval signal.
- Page membership questions: `page-question-v2`; judgment/provenance contract:
  `jev-page-v2-provenance`. Generic brand directories are not substitutes for a
  missing brand-specific product listing page.
- Taxonomy authority for current expansion: frozen `bay-state-v9`, 74 configured
  product types, authority `ff17dc313076c4657e87fa557ae7fa182796ddfcb53ce385f7525ebc03a33026`.
  Candidate sets and applicable profiles come from the frozen production
  snapshot, never the gold-label union. Older v5 runs retain their original meaning.
- Pages: verified live ShopSite import. Never invent Page IDs or page names.

Current qualification predictor `code-executed-v8` binds capture-time source-input
identity/evidence and owned frozen taxonomies before transport. Requested and
actual provider-returned model identities follow the last speaking stage;
fully silent sides remain blocked. It retains exact semantic abstention codes:
`no_match` and `insufficient_evidence` earn correctness only against matching gold.
Low-probability, uncoded legacy and service-failure abstentions do not. Unlabeled rows are excluded
from the Product Type accuracy denominator. The predeclared paired primary metric
is `productType.rawCorrectness`, bootstrapped over the same labeled fixed population.
The conservative benchmark gate requires at least 200 labeled holdout examples,
20 per evaluated class, coverage 0.80, zero safety violations and a positive lower
95% paired-delta bound. The expansion additionally requires at least 20 represented
classes, so at least 400 held rows are necessary. Sourcing all 74 configured types
is not required; every evaluated class's floor remains binding. These are
necessary gates, not fitted policies or representative-assortment evidence.
No revision reseals previously inspected holdouts.

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

## Current expanded-development evidence

- Expansion-v2 has 967 independently reviewed development products: 685 known,
  218 genuine no-fit, 64 insufficient-evidence; 901 families and eight explicit
  field states per row. A scoped generation peer receipt verifies all hashes,
  147 integrated corrections and zero admissible-evidence/canonical-value leaks.
  It recommends NO-FREEZE, not production acceptance.
- Only 10 of 27 represented known types meet the 20-row floor. Breed-size (1),
  flavor (17), life-stage (8) and packaging (6) have thin positive support;
  fuel-type and hose-length have no applicable examples. Unsupported capabilities
  must remain visible and unqualified.
- All 967 complete page sets remain unknown. Verified page identities and the
  existing max-4/specific-over-Shop-All/include-brand guidance do not close
  eligibility, subject boundaries, conflicting pages or promotional membership.
- Custody hashes/modes for 60 files in 15 banks are verified without parsing
  payloads. The 309 publicly declared held rows are unlabeled and below the
  necessary 400-row minimum; exposure and class separation are not established.
- The immutable three-public-row live diagnostic uses the actual configured
  `deepseek-cloud`/`deepseek-v4-flash` incumbent (returned `deepseek-flash`) and
  pinned Jev (requested and returned `jev-1.13.0`). Both propose `dog-treats`
  against an insufficient-evidence gold row. No inference about representative
  accuracy or fitted thresholds is warranted from this non-random sample.
- Actual transport plus live stored-flag smoke on an isolated clone blocks before
  dispatch (zero requests) and before retry (one local HTTP529 fault, no second
  request). This is fault-injection evidence, not a completed production canary.
- The actual-batch audit identifies 51 provenance-valid distributor-record inputs
  and a six-member family. They require fresh ordered runs and attributed human
  decisions; old runs/approvals and the seeded goldset batch do not qualify.
- Typecheck and focused native Bun suites pass (307 passed, 1 skipped). Real
  pinned API compatibility passes. The runtime worktree is uncommitted and the
  required commit-bound compatibility/operations/canary receipts remain absent.

No fitted policy has been published and no qualifying holdout inspected.
Full-population candidate replay plans 3,868 attempts against the 600 ceiling;
neither increasing budgets nor truncating populations is implicit authorization.
Reconcile public source-budget accounting or approve a new bounded allocation
before additional product-source collection.


## Retirement

#312 remains gated by actual #302 qualification. The parked retirement commit
`36f4328a` requires re-audit against the current cohort modules and re-evaluation
after cleanup. Do not delete the live comparator or silently redirect local-only
routes to cloud Jev to make a checklist appear complete.
