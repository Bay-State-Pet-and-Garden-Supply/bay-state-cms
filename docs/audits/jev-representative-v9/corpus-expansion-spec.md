# Corpus expansion specification — from 23 to qualification scale
`docs/audits/jev-representative-v9/corpus-expansion-spec.md`
Status: SPECIFICATION ONLY — no gold written, no labels invented, no existing artifact touched.

## 1. The structural fact
All proportions below are measured against `src/classification/releases/bay-state-v9/`
(74 product types, 11 facet profiles, attribute set frozen) and the store index
(`product_index`: 22,108 rows; 21,243 with at least one attribute slot filled).
The qualification gate floors live in `src/classification/benchmark-qualification.ts`
(`requiredHoldout` 200, `requiredClassSupport` 20, `requiredCoverage` 0.80).

## 2. Deficits by class
- **Holdout: 5 → 200 (deficit 195).** Existing holdout is 2 known-type / 2 no-fit / 1 insufficient,
  sealed under v8 and ineligible. Expansion needs a *new unexposed* holdout at the same family-separated
  discipline: ≥20 classes represented, ≥20 per evaluated class where the class exists.
- **Dev: 23 → ≥230.** The floors bind the holdout, but a 23-row dev set cannot fit per-capability
  policies or support 20-per-class reporting — target ~10× current, family-separated, no SKU/family
  overlap with holdout or exposure in any prior artifact.
- **Per-class support is effectively zero for 70 of 74 types.** Current corpus covers 4 type-classes
  (dog-toys 2, dog-waste-bags 6, grooming 8, pet-beds 0 evaluated? — receipts: byType dog-toys 2,
  no-fit 7, pet-beds 2, dog-waste-bags 4, grooming 8). Every class outside these four needs ≥20
  adjudicated rows; the three largest store pools are Food (2,736 PF25), Treats (959), leash/collar/harness (~500).

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
Same bar the v9 corpus met, restated at scale: authority tripartite agreement + recomputed
producer hash; all review-signed entries with explicit field states; 20-per-class support;
200-row sealed holdout with no family/stratum overlap; pages with known assignments (current
corpus is 23/23 unknown — not evaluated); fitted per-capability policies published *before*
holdout inspection; Store Manager canary sign-offs recorded. Until then the blocked verdict stands.
