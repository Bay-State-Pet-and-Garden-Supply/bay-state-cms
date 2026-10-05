# Development policy analysis v7 — CORRECTED (frozen snapshot, no gold-union)

Supersedes `rejected-policy-analysis-gold-union-v1.json/md` (archived verbatim with reason: union fallback let labels shape attribute denominators). No gold labels define candidates/applicability here.

## Authority (verified, not asserted)
- Loader `loadDevReplayInputs` over current manifest/gold/taxonomy: manifest commitments verified, strict shape gate passed (121 entries / 120 families).
- Snapshot pool: **74 types / 9 attribute targets / 212 pages / 74 profiles / 4 universals**, hash `d74ca8cd…` — equals artifact `frozenTaxonomyHash`. (Bundle holds 27 attributes; snapshot carries the 9-target set.)
- `authorityHash 2310c0…` matches on manifest, gold, taxonomy, and artifact: same actual inputs/authority; current gold differs from capture-time labels ONLY by the 4 disclosed unlabeled corrections. SKU join 121/121, 0 empty evidence.
- Code: `code-executed-v6`, `jev-1.13.0`, policy `630fcaab…`, `page-question-v2`, floors .50/.70. Primary independently recomputed details hash `8e85f87a…` with the shipped `frozenAuthorityDetailsHash`; it equals the capture's digest. Full authority and snapshot hashes also match. This supersedes the JSON analysis's earlier recorded-only verification note; see `../jev-representative-verification-2026-10-05.md` for the executed check.

## Rescore (shipped evaluator, actual snapshot)
- Type (101 elig): correctness .9307, coverage .8515, incorrect 2 (insuff-evidence forced guesses at P .99/.75), harm 0.
- Attrs (110 elig): correctness .70, coverage .80, incorrect 26, harm 1, F1 .8657. Per-target acc/sup: species .881/67, flavor .818/11, life-stage .857/7, food-form .553/47, breed-size .400/5, packaging .500/2.
- Pages: 0 eligible → n/a. End-to-end 0 (expected). Per-class support max 12 < 20.

## Threshold sweep (concrete-proposal filters only)
Abstained sides carry NO selectedProbability evidence (confidence 0 is a placeholder): abstention outcomes are never refit, no no-fit counterfactuals, no attr/page/cohort reroutes per floor.
.50: .9307/.8515/err 2 · .60: same (rejected sit on unlabeled) · .70: .9109/.8317/err 2 · .80: .8614/.7723/err 1/harm 1 · .90: .8515/.7624/err 1/harm 1. Folds (family-disjoint): 1.00/.95, .9444/.7222, .9048/.8571(1 err), .9474/.8947, .8696/.8261(1 err).

## Decision
**`policyPublicationBlocked: true`, `policiesPublishedBeforeHoldout: false`.** No floor meets coverage≥.8 + zero errors; support floor unmet; pages unpublishable; holdout exposure block independent. No fitted policy, no unseal. Pricing unknown.
