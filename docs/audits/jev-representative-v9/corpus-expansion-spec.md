# Corpus expansion specification — from 23 to qualification scale
`docs/audits/jev-representative-v9/corpus-expansion-spec.md`
Status: binding specification; the historical measurements below describe the v9 baseline. A new partial development generation now exists at `../jev-expansion-v2/`; v9 artifacts remain untouched. Qualification remains blocked.

## 1. The structural fact
All proportions below are measured against `src/classification/releases/bay-state-v9/`
(74 product types, 11 facet profiles, attribute set frozen) and the store index
(`product_index`: 22,108 rows; 21,243 with at least one attribute slot filled).
The qualification gate floors live in `src/classification/benchmark-qualification.ts`
(`requiredHoldout` 200, `requiredClassSupport` 20, `requiredCoverage` 0.80).

## 2. Deficits by class
- **Holdout: 5 → 200 (deficit 195).** Existing holdout is 2 known-type / 2 no-fit / 1 insufficient,
  sealed under v8 and ineligible. Expansion needs a *new unexposed* holdout at the same family-separated
  discipline: ≥20 classes represented, ≥20 per evaluated class where the class exists. Taken together these require at least 400 held rows; the separate 200-row aggregate gate is not a relaxation of the class floors.
- **Dev: 23 → ≥230.** The floors bind the holdout, but a 23-row dev set cannot fit per-capability
  policies or support 20-per-class reporting — target ~10× current, family-separated, no SKU/family
  overlap with holdout or exposure in any prior artifact.
- **Baseline support covered only four of 74 configured types.** This is a historical coverage observation, not a requirement to source every configured type. Under the user's relaxed sourcing scope, predeclare at least 20 evaluated classes and meet the 20-row floor for every evaluated class. Uncovered/under-supported classes remain unqualified; inference still considers the full configured candidate universe. Catalog Food/Treats/leash pools are sourcing hypotheses, not gold.

## 3. Sourcing pool (measured, `product_index`, case-insensitive)
- Total pool 22,108 (8,427 active + 13,619 draft; 94 rows already `synced`).
- 21,243 rows carry ≥1 attribute value; 16,846 have a primary product image.
- Richest target slots: PF24 category 12,991 filled / 97 distinct, PF17 species 11,203 / 52 distinct
  (503 piped multi-value), PF22 food-form 4,214 / 47 distinct, PF23 flavor 3,936 / 314 distinct,
  PF18 life-stage 2,077 / 10, PF19 breed-size 1,443 / 12, PF30 packaging-type 2,363 / 20.
- Thin slots that need deliberate oversampling: PF21 health-benefits 410 / 36,
  PF28 material 455 / 17, PF27 size 401 / 20, PF29 color 882 / 74.
- Brands: 1,000 distinct PF16 values — do NOT stratify by brand (would fragment support); stratify
  by type-class and known/no-fit ratio, and record brand only as review context.
- Anti-patterns already visible in-store (screen for, don't launder into gold): case chaos
  (`Dog`/`dog`, `Kong`/`KONG`), pipe-joined multi-values (species 503, PF24/PF25/PF23/PF18…),
  merchandising pseudo-types in PF25 (`toys`/`treats`/`food`, `Treats|Toys`), category-shaped
  PF31 duplicates, `Wolf` in PF27 size, ops markers in PF1/PF2/PF12. Gold values must be
  canonical; store spellings are evidence, never labels.

## 4. Rules that stay binding during expansion
- **Both blockers (#300 multi-value proposals, #301 cohort pages) clear first** — scoring a larger
  corpus against capabilities that can't emit multi-values or coordinate pages bakes today's
  limitations into the benchmark. The delimited `'|'` serialization and `upc-list` read-only slot
  are the release-side prerequisites and are already in bay-state-v9.
- Adjudicate labels, never trust catalog slots: the store's own assignments (PF25 pseudo-types,
  species case variants, pipe strings) are hypotheses for review, never gold.
- Family separation, no exposure: new rows must be unexposed — never served, synced, or present
  in any prior artifact — otherwise the sealed-holdout semantics collapse.
- The peer receipt process repeats per generation: each corpus freeze gets an independent
  re-derivation pass and a fresh `development-peer-receipt.json`, exactly as was done for v9.
  Do not append rows to the peer-verified v9 corpus — a new generation supersedes it.
- Keep the falsification rows: no-fit must stay a first-class kind (currently 7/23), and the
  leash-clip boundary decision (`adjudication-brief-leash-clip.md`) must be recorded as the
  standing rule for accessory-vs-member cases before the next gold is frozen.
- #312 accounting: any wording-level no-fit re-scoping lands in the cleaned-up implementation
  and is re-evaluated there; the expanded corpus measures it, it does not pre-judge it.

## 5. Acceptance for the expanded corpus
The expansion requires authority tripartite agreement + recomputed
producer hash; all review-signed entries with explicit field states; 20-per-class support;
at least 400 newly sealed held rows when 20 classes each require 20 examples, with no family/stratum/exposure overlap; pages with known-complete assignments; fitted per-capability policies published *before*
holdout inspection; Store Manager canary sign-offs recorded. Until then the blocked verdict stands.

## 6. Current expanded-development evidence

Expansion-v2 contains 967 independently reviewed development products in 901 families:
685 known-type, 218 genuine no-fit and 64 insufficient-evidence. There are 27
represented known types, but only 10 meet 20-row support. Eight field states are
explicit on every row. A fresh generation-specific agent peer receipt binds
the actual bytes and all 147 integrated review corrections; it recommends NO-FREEZE.

All 967 complete page assignments remain unknown. The 212 verified page IDs/names
are identity evidence, not closed product-membership gold. Public metadata reports
309 unlabeled held rows in 15 banks; custody hashes/modes are verified without
payload inspection. That is below the 400-row necessary minimum and does not
establish exposure or per-class eligibility.

The actual full-population candidate plan is 3,868 HTTP attempts, above the
600-attempt replay ceiling. The bounded three-row real-provider diagnostic is
runtime evidence only, not a policy fit or a representative/cohort evaluation.
Further product-source capture needs reconciled accounting or a new explicit
bounded allocation. No gate may be cleared by re-splitting public data, inspecting
sealed payloads early, clipping candidates, truncating evaluated rows, treating
engineering thresholds as fitted policies, or counting old/synthetic canaries.
