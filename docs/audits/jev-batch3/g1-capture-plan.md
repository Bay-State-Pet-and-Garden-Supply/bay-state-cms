# G1 Fresh Holdout Capture Plan — rev2 2026-10-09 (planning only — NO-CAPTURE)

> **NO-CAPTURE BANNER.** This document authorizes **zero** spend, **zero**
> fetch, and **zero** sealed-payload reads. It is a plan against the 305 sealed
> window remainder (895 spent / 1200) for G1 reviewer + owner approval. All
> numbers derive from public manifests, counts, code, or reviewer-signed
> records cited per number. Per-class sealed composition is **unknown** and no
> sealed credit is taken anywhere. Blind food probing is retired (0/5 Batch4
> food probes hit); food strategy is MANUAL official-page curation only.

> **REV2 SCOPE.** Owner scope-reduction 2026-10-09
> (`reduced-scope.json`): qualify on the **10 FLOORED classes only**,
> **10 × 20 = 200 NEW distinct holdout rows** (dev rows never count). The 10
> smallest-deficit classes from draft1 are explicitly OUT. Draft1 (2026-10-08)
> §§2–3/7–8 20-class math is **retired in full** and retained below as history
> only; normative numbers are §10 (rev2) + `local://g1-capture-plan.json`
> (rev2, 9568 bytes, sha256
> `48f1c7e9aa96ef3fa46642c8170ab87b73dbab02710a9956b9b52415a228793b`).
> No embedded self-hash of this MD appears anywhere in this repo (Batch4 lesson).

- **Status:** rev2 planner-only, pending fresh reviewer approval + owner spend
  authorization (G1). Default if unapproved: window closes at 895 spent and
  Batch3/Batch4 finals stand.
- **Authority:** G0-approved `qualifying-holdout-spec.md`
  (APPROVED-WITH-AMENDMENTS, A1/A2/A3 applied) + review
  `g0-holdout-spec-review.json`; reduced scope
  `reduced-scope.json` (supersedes `predeclared-class-set.json` for
  qualification); v4 `development-support.json` + `development-gold.json`;
  Batch3/Batch4 manifests, ghost/food forensics, collector code.
- **Owner of this change:** this plan doc + `local://g1-capture-plan.json`
  only. No other file touched.
- **G0 amendments consumed:** A1 (mannapro-23 0-ghost bound in estate ceiling),
  A2 (fitting-evidence artifact path named in separation proof), A3 (G2 ledger
  acceptance stated explicitly) — all restated in §§5–6 below.

## 1. Standing facts (sources per fact)

| # | Fact | Source |
|---|------|--------|
| 1 | Window: 895 spent / 1200, **305 remainder sealed**; kinds to date enrich 68 / sitemap 234 / feed 38 / page 555, 0 missing | `batch4-stage-record.json` `windowAfter`; stage-record kinds chain |
| 2 | Sealed estate ceiling ~42 distinct families: (123 − ~104 ghosts) + 23 mannapro held at 0 ghosts | completion acks; `batch3-ghost-ruling-rev4-scope.json`; batch4 stage record |
| 3 | v4 dev: 997 rows / 930 families; 31 known types, 10 at 20-row floor | v4 `development-support.json` counts |
| 4 | Below-floor deficit summed **244 rows across 21 types** (spec §3.1 verified) | spec §3.1 recomputed vs v4 classSupport |
| 5 | Fresh shortfall **≥350 rows** vs ≥400-row floor — exceeds the 305 remainder | §3.2 ceiling math; §4 below |
| 6 | Predeclared 20-class set binding: 10 qualified + 10 smallest-deficit | `predeclared-class-set.json` |
| 7 | Blind food probing retired: Batch4 0/5 food probes hit (hillspet sitemap-miss ×2; tasteofthewild 885 locs/250 queued/0 proof; orijen sitemap-miss ×2; acana sitemap-miss ×2; merrick 343 locs/1 queued/0 rows) + Batch3 M1/M3/M4 dry | `batch4-stage-record.json` `foodPattern`; batch4 plan forensics |
| 8 | SmartPak bank revised: 190/190 rows `official-manufacturer` → `third-party-retailer SmartPak medium-reliability`; corrected bytes flow into **v5+ only**, sealed v2/v3/v4 untouched | `smartpak-revision-record.json` |
| 9 | P2 unspent 97 NOT recycled; R-104 stays sealed under existing rulings | ghost ruling rev4; P2 status; G0 §6 |
| 10 | Split: family-locked 80/20, `splitForFamily` seed 42, HOLDOUT_PERCENT 20 | `collect-jev-v3-sources.ts:58-59`; `benchmark-exporter.ts:40-41,57-58` |

## 2. Deficit math (planning basis — dev rows never count toward holdout floors)

Predeclared smallest-deficit 10 (have → need, from v4 classSupport):

| Class | Have | Need | 5× novel families required |
|-------|-----:|-----:|---------------------------:|
| fly-control-equine | 19 | 1 | 5 |
| fish-food | 18 | 2 | 10 |
| supplements | 19 | 1 | 5 |
| cat-toys | 17 | 3 | 15 |
| bird-houses-baths | 16 | 4 | 20 |
| flea-tick-treatment | 11 | 9 | 45 |
| potting-soil | 13 | 7 | 35 |
| collars-leashes | 10 | 10 | 50 |
| dog-food-wet | 8 | 12 | 60 |
| cat-treats | 7 | 13 | 65 |
| **Subtotal (in-set deficit)** | | **62** | **310** |

- Out-of-set below-floor 11 classes (cat-food-dry 18, cattle-feed 19,
  dog-food-dry 14, goat-sheep-feed 18, horse-treats-supplements 17,
  insect-control 12, lawn-fertilizer 19, livestock-feeders 17,
  livestock-health-dewormers 12, poultry-coops-equipment 17, weed-control 19):
  **182 rows**, fully unfunded within this window (§7).
- The 5× novel rule (≥5×K raw kept NOVEL in-stratum families per K needed
  known rows, quota permitting) demands **310 novel families** for the in-set
  62 — on its own exceeding what 305 attempts can plausibly produce at observed
  yields (Batch3 M ≈ 0.02 holdout rows/attempt; Batch4 mannapro outlier ≈ 0.15;
  blended ≈ 0.08). **Closure of any class is NOT promised**; adjudication
  decides every row, no forced fits.

## 3. Probe order + quotas (sum 305 = full remainder, hard stop 1200)

| Order | Probe | Stratum | Deficit targets (intent only) | Quota |
|-------|-------|---------|-------------------------------|------:|
| F1 | MANUAL food curation (nutro.com, royalcanin.com, bluebuffalo.com, victorpetfood.com — all code-listed fresh official manufacturers) | food | dog-food-wet +12, cat-treats +13 | 120 |
| N1 | schleich-s.com (code-listed `collect-jev-v3-sources.ts:84`, never run) | neighbors | collars-leashes +10, cat-toys +3 (opportunistic) | 30 |
| G1 | foxfarm.com (NEW-PROPOSAL, official soil/fertilizer manufacturer, UNVERIFIED) | garden | potting-soil +7 | 40 |
| C1 | seresto.com (NEW-PROPOSAL, official Elanco Seresto product site, UNVERIFIED) | care | flea-tick-treatment +9 | 40 |
| T1 | benebone.com (NEW-PROPOSAL, official chew-toy manufacturer, UNVERIFIED) | toys | cat-toys +3, collars-leashes +10 | 35 |
| B1 | woodlink.com (NEW-PROPOSAL, official bird-product manufacturer, UNVERIFIED) | neighbors | bird-houses-baths +4 | 40 |
| | **Quota sum** | | | **305** |

- **Quota sum = 305 ≤ 305.** Zero slack: global hard stop 1200 is the backstop;
  any unspent balance stays sealed, never auto-recycled.
- **No dry-domain re-proposals.** Forbidden: frommfamily, canidae, purina,
  espoma, farnam, coastalpet, outwardhound (Batch3 M dry); hillspet,
  tasteofthewildpetfood, orijenpetfoods, acana, westpaw, scotts, merrickpetcare
  (Batch4 dry); beco/earthborn/nutrisource/naturvet/ruffwear/annamaet
  precedents; kong/smartpak/naturesway/oxbow/stella/instinct/wellness/nylabone/mannapro
  (harvested — re-harvest = ghosts).
- **No verified-endpoint claims.** Code-listed seeds are official-manufacturer
  standing only; all four NEW proposals flagged UNVERIFIED; every yield is a
  probe, not a source.
- **Coverage statement.** Dedicated quota covers 7 of the 10 predeclared
  deficit classes (58 of 62 needed rows nominal). fly-control-equine +1,
  fish-food +2, supplements +1 (4 rows) have NO dedicated probe and are
  opportunistic-only within this window. All 11 out-of-set classes (182 rows)
  are unfunded within this window. The 5× headroom (≈310 families) is
  structurally unfunded — see §7 disposition.
- **Spend order + food gate.** F1 opens with a 15-page-attempt pilot on its
  first domain: if 0 proof-pass, PAUSE the food block and return to reviewer
  before burning the remaining F1 quota (Batch4 food-gate precedent carried).
  Then N1 → G1 → C1 → T1 → B1 in order; Main may reorder within ceiling, never
  beyond it. No R-tranche, no P2-97 touch at any order.

## 4. MANUAL food-curation design (F1, quota 120)

Blind sitemap discovery failed food 0/5 (sitemap-miss + proof-wall pattern);
F1 spends **zero** attempts on sitemap/feed discovery for food domains.

1. **Hand-picked URL list (human, Main-owned).** Curator hand-picks official
   product pages only (product-detail merchandise pages on the four listed
   domains; category/listing/search/home/promo pages excluded per pageScope)
   and records `{url, domain, brand, intendedClass (intent only)}` in a local
   page-lead list. Intended class never binds adjudication. List size ≤ 100 URLs
   (≈100 page fetches + ~20 redirect-hop headroom = 120 quota).
2. **Fetch mechanism (reviewer to approve one).** Recommended: Main-owned
   manual-page runner (enrichment-runner precedent — NOT a collector bypass)
   that fetches exact curated URLs through the identical proof gates,
   kind-tagged `page`, every hop reserved + recorded via the window API.
   Alternative: collector `--page-leads` flag (code change, reviewer decision).
   No fetching until the mechanism is approved.
3. **Per-URL cost accounting.** Each fetch hop costs 1 attempt
   (`fetchOnce`: max 5 same-site hops, every hop reserve+record). Canonical
   pre-fetch exclusion gate costs ZERO attempts; post-redirect-alias burns hops
   already reserved. Ledger tracks spent per URL; F1 hard-stops at 120.
4. **Ghost-risk justification (gap-fill rule).** F1 is fresh-first, not
   re-harvest: all four domains never harvested in any bank, so ghost risk is
   scatter-normal (near-zero). No gap-fill approval is needed because no prior
   harvest is revisited. Any curated URL whose canonical key hits
   `loadPublicExclusion` is excluded pre-fetch at zero cost and logged.
5. **Proof requirements UNCHANGED.** Exactly-one-Product JSON-LD
   (`singleProductIdentity`), name (+ path match when url present),
   bodyText ≥ 80 chars with ≥ 1 excerpt (`candidateFromPageHtml`), UGC/cross-sell
   clips excluded, verified-feed path NOT used (page path only — no feed claims).
6. **Abandon rules.** Pause a domain after 15 consecutive proof-fail page
   fetches (proof-wall signature); abandon a domain after 30 page attempts with
   0 kept rows; abandon the F1 block only on reviewer call. Per-domain sub-cap
   30 page attempts (4 × 30 = 120).
7. **Exclusion.** Public-only `loadPublicExclusion` chaining ALL v2
   PRIOR_PUBLIC_BANKS + Batch3 p1/p3/m2/m8-public + Batch4 b4-7-public dev banks
   + earlier G1 probe outputs via `--exclude-bank`. `--prior-custody` rejected;
   private branch absent.

## 5. Fresh-domain probe gates (N1/G1/C1/T1/B1)

- **Fresh-first.** Every seed never harvested in any prior bank. RE-HARVEST
  FORBIDDEN except reviewer-approved gap fill with stated ghost-risk
  justification (ghost ruling carried).
- **Per-probe caps.** Hard cap = probe quota; global hard stop 1200.
- **Abandon rule.** Abandon any blind probe at 0 page-rows after 40 page
  attempts (rev4 beco/earthborn precedent carried); quota-30/35 probes abandon
  at cap with 0 rows.
- **Dev-primary gates.** ALL progress counted on kept DEV-PRIMARY families
  post-split post-exclusion only; raw candidate/page-row counts diagnostic-only,
  never gates. Report dev-yield rate + novel-family rate per probe.
- **Split-variance 5× rule.** For K needed known rows, plan ≥5×K raw kept NOVEL
  in-stratum families before 80/20 split (seed 42) + adjudication attrition,
  quota permitting — with honesty clause (§2): the 305 window cannot fund 310
  families, so closure is NOT promised.
- **Proof + exclusion.** Same proof gates and public-only chained exclusion as
  §4 items 5/7 (sitemap discovery allowed on blind probes only, kind-tagged).
- **No enrichment.** No refetch, no new excerpts in G1.
- **SmartPak note.** Any SmartPak-adjacent reasoning uses the corrected
  third-party-retailer string; sealed v2/v3/v4 banks keep the bound false
  string; next-gen staging copies from expansion-v1 (revision record carried).

## 6. Ledger acceptance (G2bar — execution contract, not execution)

Next seq is **896** (spent 895). G2 execution seals new custody (0600/0700, new
dirs only) and is accepted only if, verified from public receipts/manifests
with no sealed reads:

- seqs contiguous from 896 with 0 missing outcomes;
- receipts == spent per run; kinds tallied (added to enrich 68 / sitemap 234 /
  feed 38 / page 555 baseline);
- spent ≤ cap (305; per-probe ≤ quota);
- guards: `privateCustodyParsed=false`, `labels=0`, `modelCalls=0`;
- per-invocation `--attempt-cap` = remaining window; `--source-window` +
  `--owner-decisions` required; new-dirs seal guard clean.

## 7. Ghost-dedupe + non-recycling (restated, not new)

- Ghost mechanism CONFIRMED (spec §2.3): sealed families invisible to public
  exclusion; re-harvest deterministically re-catches them. Fresh-first is the
  only capture shape; any fresh capture that re-recaptures a sealed familyId is
  a ghost at unseal and contributes zero.
- At unseal (G3, after fitted-policy publication + explicit unseal
  authorization): metadata-only familyId+splitGroup set subtraction, fixed order
  Batch1/2 → Batch3 → Batch4 → G1; ghosts contribute zero to every floor; sealed
  rows never inspectable, never dev-usable, never re-split, never re-seeded.
- Batch1/2 old custody (309 rows / 266 families) counts toward nothing, ever.
- P2 unspent 97 NOT recycled; R-104 stays sealed; this plan draws ONLY on the
  305 remainder. Separation proof (§5 of spec: family straddle-empty,
  exposure-URL absence incl. the 24-row `stratified-live-24.json`
  fitting-evidence set by recorded hash, split-integrity recomputation) and
  labeling protocol (independence, calibration, citation binding, re-derivation)
  apply unchanged at G4/G5.

## 8. Unfunded-remainder disposition (no silent qualification)

Spending all 305 plausibly yields ~20–65 gross rows (≈4–13 holdout rows at
observed rates) against a ≥350-row fresh shortfall (≥358 rows net of the ~42
sealed ceiling vs the 400-row floor). After this plan, **≥ ~340 rows remain
structurally unfunded**, plus the 182-row out-of-set deficit and the 5×
headroom. Classes outside the predeclared set remain unqualified when
under-supported; inference still considers the full candidate universe. Owner
decision required (reviewer advice):

- **Option A — new allocation request.** Fresh window sized honestly:
  ~4,000–12,000 attempts at blended observed holdout yields (0.03–0.08
  holdout rows/attempt) to fund the ≥358-row fresh need, targeting out-of-set
  classes + 5× headroom with the same fresh-first/MANUAL rules. Framed, not
  granted, here.
- **Option B — floor-scope reduction.** Qualify a subset of the predeclared set
  (e.g., ship classes that reach 20 first; defer the rest explicitly), or
  downscope the floor claim with reviewer-approved amended minima. Deferred
  classes are named as deferred — never silently qualified.
- **Option C — close the window at 895.** Batch3/Batch4 finals stand as
  recorded; sealed estate keeps its ceiling without floor claims.

## 9. Reviewer checklist (draft1 — history only; rev2 deltas in §10.6)

1. Quotas sum 305 ≤ 305; probe order; no dry-domain re-proposal; no verified
   endpoint claim (4 NEW proposals + schleich-s.com explicitly UNVERIFIED).
2. F1 MANUAL workflow: page-lead list rules, fetch mechanism (runner vs flag),
   per-URL accounting, proof unchanged, pilot gate + abandon rules.
3. 5× rule encoded with honesty clause; dev-primary gates; no enrichment.
4. Public-only chained exclusion; ledger acceptance (§6) executable.
5. Ghost-dedupe + non-recycling (P2-97, R-104) restated; SmartPak forward rule
   noted.
6. Coverage vs unfunded remainder stated explicitly (§§3/8); disposition
   options framed without silent qualification.
7. NO-CAPTURE until this approval + owner spend authorization land.

## 10. Rev2 rescoped plan (NORMATIVE — supersedes draft1 §§2–3/7–8)

### 10.1 Deficit math (10 floored classes, dev rows never count)

The 10 floored classes are dev-strong (v4 rows: bee-supplies 25, cat-food-wet
20, dog-toys 55, dog-treats 33, equine-grooming-hoof 33, grooming 31,
horse-blankets-tack 88, plant-food-fertilizer 33, small-animal-feed-bedding
43, wild-bird-feeders 174 — `development-support.json` classSupport) — but
dev strength buys nothing: the floor needs **20 NEW distinct rows per class**,
dev rows never count, and sealed per-class composition is unknown so
**sealed credit = 0**.

| Class | Need (new) | 5× novel families required |
|-------|-----------:|---------------------------:|
| bee-supplies | 20 | 100 |
| cat-food-wet | 20 | 100 |
| dog-toys | 20 | 100 |
| dog-treats | 20 | 100 |
| equine-grooming-hoof | 20 | 100 |
| grooming | 20 | 100 |
| horse-blankets-tack | 20 | 100 |
| plant-food-fertilizer | 20 | 100 |
| small-animal-feed-bedding | 20 | 100 |
| wild-bird-feeders | 20 | 100 |
| **Total** | **200** | **1000** |

- **Floor: 200 rows; sealed ceiling ~42 FAMILIES estate-wide** (rev4
  accounting: 123 − ~104 ghosts + 23 mannapro held at 0 ghosts, per
  completion acks + `batch3-ghost-ruling-rev4-scope.json` + batch4 stage
  record). Per-class sealed composition is unknown — zero planning credit.
- The 5× novel rule (≥5×K raw kept NOVEL in-stratum families per K needed
  known rows, quota permitting) demands **1000 novel families** for the 200 —
  structurally unfundable inside 305 attempts at observed yields (Batch3 M ≈
  0.02 holdout rows/attempt; Batch4 mannapro outlier ≈ 0.15; blended ≈ 0.08).
  **Closure of any class is NOT promised**; adjudication decides every row, no
  forced fits.
- **What 305 can cover vs remainder.** At 0.02–0.08 holdout rows/attempt, 305
  attempts plausibly yield **~6–24 holdout rows (~3–12% of the 200-row
  floor)**, leaving an unfunded remainder of **≥176 rows** plus the 5×
  headroom even before attrition — see §10.5 disposition.

### 10.2 Retargeted probes + quotas (sum 305 = full remainder, hard stop 1200)

| Order | Probe | Serves (floored, intent only) | Quota |
|-------|-------|-------------------------------|------:|
| F1 | MANUAL food curation (nutro.com, royalcanin.com, bluebuffalo.com, victorpetfood.com — all code-listed fresh official manufacturers) | dog-treats + cat-food-wet (opportunistic: bee-supplies, grooming — curation may surface apiary/grooming lines on these domains) | 120 |
| T1 | benebone.com (draft1 NEW-PROPOSAL, retargeted — was cat-toys/collars-leashes, both OUT) | dog-toys | 35 |
| G1 | foxfarm.com (draft1 NEW-PROPOSAL, retargeted — was potting-soil, OUT) | plant-food-fertilizer | 40 |
| B1 | woodlink.com (draft1 NEW-PROPOSAL, retargeted — was bird-houses-baths, OUT) | wild-bird-feeders | 40 |
| E1 | absorbine.com primary (+ weatherbeeta.com alternate on shared cap if primary abandons; both NEW-PROPOSAL official manufacturers, UNVERIFIED) | equine-grooming-hoof + horse-blankets-tack | 40 |
| S1 | kaytee.com (NEW-PROPOSAL official small-animal feed/bedding manufacturer, UNVERIFIED) | small-animal-feed-bedding | 30 |
| | **Quota sum** | | **305** |

- **Quota sum = 305 ≤ 305.** Zero slack: global hard stop 1200 is the backstop;
  any unspent balance stays sealed, never auto-recycled.
- **Parked (zero quota, not abandoned):** N1 schleich-s.com (code-listed,
  never run — no floored-class fit) and C1 seresto.com (draft1 proposal serving
  OUT flea-tick-treatment) are parked with the OUT set for a future window.
- **No dry-domain re-proposals.** Forbidden: frommfamily, canidae, purina,
  espoma, farnam, coastalpet, outwardhound (Batch3 M dry); hillspet,
  tasteofthewildpetfood, orijenpetfoods, acana, westpaw, scotts, merrickpetcare
  (Batch4 dry); beco/earthborn/nutrisource/naturvet/ruffwear/annamaet
  precedents; kong/smartpak/naturesway/oxbow/stella/instinct/wellness/nylabone/mannapro
  (harvested — re-harvest = ghosts). **Re-harvest rule tightened for rev2:**
  every floored class is already dev-well-sourced from a prior-bank domain
  (bee-supplies: natureswaybirds 25; cat-food-wet: stella 12/instinct
  4/earthanimal 4; dog-toys: kong 54; dog-treats: kong 12/stella 8/mywoof
  4/annamaet 3/earthanimal 3/instinct 2/nylabone 1; equine-grooming-hoof:
  smartpak 33; grooming: tropiclean 23 + minors; horse-blankets-tack: smartpak
  88; plant-food-fertilizer: drearth 33; small-animal-feed-bedding: oxbow 43;
  wild-bird-feeders: naturesway 92/perkypet 82 — per `development-gold.json`
  entries), so revisiting ANY of those domains is certain-ghost territory and
  is barred absent reviewer-approved gap fill. SmartPak domains are doubly
  barred (harvested + string-revised to third-party-retailer).
- **No verified-endpoint claims.** Code-listed F1 seeds are
  official-manufacturer standing only; T1/G1/B1 carried as UNVERIFIED;
  E1/S1 flagged UNVERIFIED; every yield is a probe, not a source.
- **Coverage statement.** Dedicated quota covers **8 of the 10** floored
  classes (**160 of 200 needed rows nominal**). bee-supplies + grooming have NO
  dedicated probe and are opportunistic-only (may surface inside F1 curation).
  All 10 smallest-deficit classes are explicitly OUT with zero quota. The 5×
  headroom (1000 families) is structurally unfunded — see §10.5.
- **Spend order + food gate.** F1 opens with a 15-page-attempt pilot on its
  first domain: if 0 proof-pass, PAUSE the food block and return to reviewer
  before burning the remaining F1 quota (Batch4 food-gate precedent carried).
  Then T1 → G1 → B1 → E1 → S1 in order; Main may reorder within ceiling, never
  beyond it. No R-tranche, no P2-97 touch at any order.

### 10.3 Fresh-vs-gapfill justification per class (ghost rules carried)

Floored classes are mostly WELL-sourced already — re-harvest is ghost-risky, so
every rev2 probe is fresh-first by necessity (no prior harvest revisited; no
gap-fill approval consumed):

| Class | Dev already from (harvested — DO NOT revisit) | Rev2 probe (fresh) |
|-------|-----------------------------------------------|--------------------|
| dog-treats | kong/stella/mywoof/annamaet/earthanimal/instinct/nylabone | F1 fresh food domains |
| cat-food-wet | stella/instinct/earthanimal | F1 fresh food domains |
| dog-toys | kong 54/55 | T1 benebone (fresh) |
| plant-food-fertilizer | drearth 33/33 | G1 foxfarm (fresh) |
| wild-bird-feeders | naturesway 92 + perkypet 82 | B1 woodlink (fresh) |
| equine-grooming-hoof | smartpak 33/33 (doubly barred) | E1 absorbine (fresh) |
| horse-blankets-tack | smartpak 88/88 (doubly barred) | E1 absorbine/weatherbeeta (fresh) |
| small-animal-feed-bedding | oxbow 43/43 | S1 kaytee (fresh) |
| bee-supplies | natureswaybirds 25 | opportunistic inside F1 (fresh) |
| grooming | tropiclean 23 + minors | opportunistic inside F1 (fresh) |

Ghost mechanism CONFIRMED (spec §2.3): sealed families invisible to public
exclusion; re-harvest deterministically re-catches them. Any fresh capture
that re-recaptures a sealed familyId is a ghost at unseal and contributes
zero. No gap-fill is proposed; any future gap fill needs reviewer approval
with a stated ghost-risk justification.

### 10.4 F1 MANUAL food design carried (dog-treats + cat-food-wet are floored)

F1 design (§4) is carried UNCHANGED IN FORM, retargeted to the floored food
classes: blind sitemap discovery stays retired (0/5 Batch4 food probes hit);
zero attempts on sitemap/feed discovery; hand-picked official product-page
URLs only (≤100 URLs + ~20 redirect-hop headroom = 120 quota); Main-owned
fetch mechanism (runner vs `--page-leads` flag) still needs reviewer approval
before any fetch; per-URL cost accounting (each hop 1 attempt, max 5
same-site hops); proof gates unchanged; pilot gate (15-page-attempt pilot, 0
proof-pass ⇒ PAUSE); per-domain sub-cap 30 / abandon after 30 with 0 kept /
pause-after-15-proof-fail; public-only chained exclusion via `--exclude-bank`.
F1 is fresh-first (all four domains never harvested — scatter-normal ghost
risk), so no gap-fill approval is needed.

### 10.5 Unfunded-remainder disposition (no silent qualification)

Spending all 305 plausibly yields ~6–24 holdout rows against the 200-row
floor, leaving **≥176 rows structurally unfunded** plus the 1000-family 5×
headroom. bee-supplies + grooming carry dedicated-probe risk on top. Classes
outside the floored set (including all 10 smallest-deficit classes) remain
unqualified when under-supported; inference still considers the full
candidate universe. Owner decision required (reviewer advice):

- **Option A — new allocation request.** Fresh window sized honestly:
  ~2,500–10,000 attempts at observed holdout yields (0.02–0.08
  holdout rows/attempt) to fund the 200-row floor + 5× headroom with the same
  fresh-first/MANUAL rules. Framed, not granted, here.
- **Option B — ship-what-qualifies.** Qualify classes that reach 20 first with
  named deferrals for the rest, or downscope the floor claim with
  reviewer-approved amended minima. Deferred classes are named as deferred —
  never silently qualified.
- **Option C — close the window at 895.** Batch3/Batch4 finals stand as
  recorded; sealed estate keeps its ceiling without floor claims.

### 10.6 Reviewer checklist deltas (verify §10 + §5/§6 restated rules)

1. Quotas sum 305 ≤ 305; probe order F1→T1→G1→B1→E1→S1; no dry-domain or
   prior-bank-domain re-proposal; no verified endpoint claim (T1/G1/B1 carried
   UNVERIFIED, E1/S1 flagged UNVERIFIED).
2. F1 MANUAL workflow retargeted to dog-treats/cat-food-wet; mechanism,
   accounting, proof, pilot gate + abandon rules unchanged in form.
3. Fresh-vs-gapfill per-class table (§10.3): every probe fresh-first, no
   gap-fill approval consumed; SmartPak double-bar noted.
4. 5× rule encoded with honesty clause; dev-primary gates; no enrichment;
   public-only chained exclusion; ledger acceptance (§6) executable.
5. Ghost-dedupe + non-recycling (P2-97, R-104) restated; 10 smallest-deficit
   classes explicitly OUT with zero quota; N1/C1 parked, not abandoned.
6. Coverage (8/10 dedicated, 160/200 nominal) vs unfunded remainder (≥176 +
   5× headroom) stated explicitly; disposition framed without silent
   qualification.
7. NO-CAPTURE until this approval + owner spend authorization land.

## 11. Draft1 sections retired (history only — NOT normative)

> Draft1 §§1 (facts 4–6), 2–3/7–8 computed a 244-row summed deficit, 62-row
> in-set deficit, 310-family 5× headroom, and probe quotas against the 10
> smallest-deficit classes, which rev2 scope explicitly places OUT of
> qualification. Those figures are superseded and kept below unmodified for
> audit continuity only. Normative rev2 numbers live in §10 +
> `local://g1-capture-plan.json` (rev2).

