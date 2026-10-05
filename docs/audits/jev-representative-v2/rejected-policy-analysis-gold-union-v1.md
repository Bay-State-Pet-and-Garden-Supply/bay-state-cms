# Development policy analysis v7 (development-only evidence)

No qualification granted. No policy published. No unseal authorized.

## Inputs (hashes)
- Gold (current, corrected): `development-gold-calibration-v7.json` sha `4359ff49…` — 121 entries / 120 families, all dev; kinds 87 known / 8 no-fit / 6 insuff / 20 unlabeled; pages 99 partial + 22 unknown.
- Predictions (actual capture): `development-predictions-v6-calibration-v7.json` artifact `5f27c0d3…` — 121 live candidate sides (`jev-1.13.0`) + 121 deterministic floors; 223 attempts declared, 1,409,664 tokens verified.
- Taxonomy bundle `66557f40…` is a config bundle, not a frozen snapshot → union fallback (replay owns full-authority validation; not claimed here).
- Code: predictor `code-executed-v6`, policy `630fcaab…`, `page-question-v2` / `jev-page-v2-provenance`, floors single 0.50 / multi 0.70.

## Correction disclosure
Four post-capture source-only disagreements → unlabeled (benebone 3517169401955, tropiclean 9170786615551, thermacell 30062244921486bdd041 + 17aa863126bd5e699f22). Rescore joins CURRENT gold (hash above), distinct from capture-time labels. SKU join 121/121 both ways, 0 empty evidence. Nothing relabeled from outcomes. Strict shape gate passed at parse.

## Current rescore (shipped `evaluateJevOfflineComparison`)
- Type (101 eligible): correctness .9307, coverage .8515, incorrect 2, harm 0, recovered 74.
- Attrs (114 eligible): correctness .6754, coverage .7719, incorrect 26, harm 1; set F1 .865. Per-target: species .881/67, flavor .818/11, life-stage .857/7, food-form .553/47, breed-size .400/5, packaging .500/2. Type errors: insuff-evidence forced guesses at conf .99 (redbarn→dog-treats) and .75 (naturvet→grooming). Attr errors dominated by insuff-evidence targets predicted without coded proof plus known exact-set mismatches (food-form 22 slots).
- Pages: 0 eligible → **n/a (not evaluated)**, never 0%-wrong. End-to-end all-stages 0 is expected while pages are unevaluated.
- Confidence verified from artifact: 102 predicted all P>0 (min .54), 19 abstained all 0 with codes; rejected = unresolved `low_probability`, never semantic credit.

## Threshold sensitivity (type only, monotone stricter floors)
.50/.60: .9307 / cov .8515 / err 2 (sub-.60 predictions sit on unlabeled entries — no eligible effect). .70: .9109 / .8317 / err 2. .80/.90: err 1 but coverage .7723/.7624 **and harm 1**. No floor meets coverage≥.8 + zero errors; per-class support max 12 < 20. 5-fold family-disjoint correctness .87–1.00 (errors in folds 2, 4); no cross-variant independence claimed.

## Decision
**`policyPublicationBlocked: true`, `policiesPublishedBeforeHoldout: false`.** Independent blockers: pages 0 eligible; holdout custody exposure `ineligible-pending-recovery`. Pricing unknown.
