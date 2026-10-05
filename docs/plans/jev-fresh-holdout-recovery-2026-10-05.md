# Fresh holdout recovery — source-only plan (2026-10-05)

Status: source-only recovery planning. No model calls, labels, credentials, DB, catalog assignments, or private-custody reads. Old 391-family holdout is unrecoverable/ineligible and excluded from all counts.

## Preservation rules
- Keep all previous family splits/IDs and source banks untouched; no pin/commit/code/test changes.
- Never move formerly development families to holdout to fill quotas.
- Existing public corpus (3,692 records / 1,914 families / 32 admitted domains) is the exclusion ledger: new holdout families must be unseen manufacturer families.
- Reuse frozen grouping (`familyGroupingIdentityFor`/`normalizeBrand`/`extractNameStem`) and `splitForFamily(seed 42, 20)`; train/test map to development.

## Fresh-source targets (broad store coverage)
- Food/treat: frommfamily.com, wellnesspetfood.com, canidae.com, purina.com.
- Toys: nylabone.com, kongcompany.com, outwardhound.com, westpaw.com.
- Care: espoma-adjacent animal-care feeds to be confirmed from official sitemaps only.
- Garden/pest: espoma.com, farnam.com.
- Neighbors: coastalpet.com, schleich-s.com (verify manufacturer-official product feed before admission).
- Anticipate ≥max(200, 20K) actually labeled holdout via representative full-family sampling, never model-outcome cherry-picking. Supplemental cohorts tracked separately; primary case is lexicographically first canonical URL per whole family.

## Source/split/privacy protocol
- Public official manufacturer feeds/sitemaps/product pages only; https, host policy, manual redirects, stop on denial (401/403/406/429/451, challenge, robots disallow-all); ≤1 concurrent/domain.
- Per record: canonical URL, retrieval time, content hash, exact excerpts, product identity, source locator, evidence limits. Explicit `PUBLIC:` identifiers only; no invented IDs/UPCs, prices, customer identifiers, or labels.
- Publish development rows only; holdout stays in custodian-only storage with counts/commitments. Exposure of a holdout row invalidates it.

## Budget preflight (actual)
- Original budget 1,200; previously consumed 1,128; 72 remained before this session.
- This session: 12 availability probes (robots.txt, no redirect followed, denial-stop respected), 0 failures requiring retry. Remaining: 60.
- Probe result: 4×200 (frommfamily, canidae, outwardhound, coastalpet), 7×301 to same-host policy URLs (wellnesspetfood, nylabone, kongcompany, westpaw, espoma, farnam, purina), 1×404 (schleich-s.com robots). No bodies stored, no labels.
- A proper fresh corpus (sitemap crawl + product-HTML/structured-document capture + audit for ~200+ holdout primary families) needs several hundred requests — well beyond 60. More operator approval is needed before collecting the proper corpus; do not proceed on the remaining 60 alone.
