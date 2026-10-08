# Qualifying Holdout Specification (planning document — NO inspection, NO labeling, NO capture)

> **NO-INSPECTION BANNER.** This document is a PLAN only. It authorizes zero
> payload reads of any sealed custody material (Batch1/2 holdouts, Batch3
> sealed rows, Batch4 mannapro 23 held). Every number below comes from public
> manifests, counts, code, or reviewer-signed records — cited per number.
> Anything not so sourced is flagged **unknown**. Sealed material stays sealed
> until every gate in §6 clears, in order.
>
> **Process incident (recorded 2026-10-08):** during drafting, the spec agent
> accidentally opened one sealed `holdout-inputs.json` payload file, halted
> immediately, and excluded its content from this spec. Main verified the
> spec contains zero payload-derived content (all sealed numbers are
> gross/ghost tallies from signed records; per-class sealed composition is
> explicitly unknown throughout). No labels, counts-by-class, or floor inputs
> derive from the incident. The affected cohort's qualification standing is
> for the reviewer to rule on at G0; this spec takes no position.

- **Status:** draft spec, planning only. No approvals granted or implied by
  this document.
- **Fitted policy:** published — `docs/audits/jev-batch3/per-capability-policy.json`
  (`acceptance-policy-v1-unfitted`, `publishedBeforeHoldoutInspection: true`,
  published 2026-10-08). Labeling-order constraint (labeling follows policy
  publication) is therefore satisfiable; labeling itself is NOT authorized here.
- **Owner of this file:** this spec only. No other file is touched by this change.

## 1. Standing facts and sources

| # | Fact | Source |
|---|------|--------|
| 1 | v4 development: 997 rows / 930 families; 31 known types, 10 at 20-row floor; peer review 7/7 RECOMMEND-FREEZE | `docs/audits/jev-expansion-v4/development-support.json` counts; `development-peer-receipt.json` (receipt v4) |
| 2 | Fitted per-capability policy published unfitted-honest, before any holdout inspection | `docs/audits/jev-batch3/per-capability-policy.json` header |
| 3 | Canaries human-signed: spine (1 item, 8 decisions) + 6-member cohort (NutriSource PureVita) | `docs/audits/jev-batch3/canary-receipts.json` |
| 4 | Ghost mechanism CONFIRMED: Batch3 sealed rows include ~104 ghost recaptures of Batch1/2 holdout families; plus Batch4 mannapro 23 held at 0 ghosts (`batch4-stage-record.json`); estate ceiling ~(123−~104)+23 ≈ ~42 per §2.3 | `batch3-ghost-ruling-rev4-scope.json` (verdict GHOST-MECHANISM-CONFIRMED-PROCEED-M-FRESH-FIRST-ONLY); `batch3-completion-acknowledgement.json` (`sealedGross: 123`, `sealedNote: ~104 ghosts`) |
| 5 | Ghost-dedupe by familyId at unseal is recorded obligation | `batch3-source-plan.json` rev4 `ghostMechanism.dedupeObligation`; `stage-record.json` (batch3-capture-stage-record) |
| 6 | Batch4 mannapro 23 held are fresh (0 ghosts); 11 novel dev rows | `batch4-stage-record.json` (mannapro HIT: 34 rows = 11 dev + 23 held, 0 ghosts); `batch4-completion-acknowledgement.json` |
| 7 | Window: 895 spent / 1200, 305 remaining sealed | `batch4-stage-record.json` `windowAfter` |
| 8 | Split discipline: family-locked 80/20, `splitForFamily`, seed 42, HOLDOUT_PERCENT 20 | `scripts/collect-jev-v3-sources.ts:58-59`; `src/classification/benchmark-exporter.ts:40-41,57-58`; `batch3-source-plan.json` holdout discipline |
| 9 | Floors: ≥400 distinct held rows; ≥20 classes at ≥20 rows each (literal 20×20) | `batch3-source-plan.json` (`holdoutFloor`, `oldCustodyTreatment`); Batch1/2 309 rows / 266 families explicitly never count |
| 10 | Batch1/2 old custody (309 rows / 266 families): archived, unqualified, counts toward nothing | `batch3-source-plan.json` `oldCustodyTreatment` |

## 2. Distinct-family accounting method (metadata only)

### 2.1 Allowed inputs

At unseal, and ONLY at unseal after §7 gates clear, the accounting step may read
**exclusively**:

1. `familyId` string sets from `membership.json` files (Batch1/2 holdout
   membership, Batch3 sealed-stage membership, Batch4 custody membership).
   FamilyId-set comparison only — no SKU, title, URL, excerpt, hash, or label
   fields are read during accounting.
2. `splitGroup` values already recorded in those membership entries (to confirm
   the sealed rows were assigned `holdout` by `splitForFamily` seed 42 / 20%).
3. Public collection manifests and stage/acknowledgement records for gross
   cross-checks.

Any field beyond `familyId` (+ `splitGroup` for the split check) read from a
sealed custody file is an inspection event and MUST halt the step.

### 2.2 Gross-vs-distinct tallies

For each sealed cohort (Batch1/2 holdout, Batch3 sealed, Batch4 held) record:

- **Gross held rows** `G_cohort`: row count as stated in the signed record
  (Batch3 `G = 123` per completion acknowledgement; Batch4 mannapro `G = 23`
  per stage record). Gross is a custody-integrity number, NOT a floor number.
- **Ghost rows** `H_cohort`: rows whose `familyId` is already present in an
  earlier sealed cohort's familyId set (Batch3 vs Batch1/2; Batch4 vs
  Batch1/2+Batch3). Ghosts contribute **zero** to every floor.
- **Distinct contribution** `D_cohort = |families(cohort) − families(all
  earlier cohorts)|`, computed by set subtraction on `familyId` sets.
- **Qualifying total** `D_total = |union of all sealed familyId sets|`
  (distinct families across the full sealed estate).

Ordering is fixed: Batch1/2 first, then Batch3, then Batch4. A family claimed
by the earliest cohort that holds it; later recaptures are ghosts regardless
of capture quality.

### 2.3 Ghost accounting (restated, not new)

- Ghost mechanism per ruling: sealed Batch1/2 holdout families/URLs are
  invisible to the public-only exclusion (`loadPublicExclusion`), so re-harvest
  re-fetches holdout URLs, regroups identical keys into identical `familyId`s,
  and re-splits identical holdout verdicts. Chain confirmed from code + public
  manifests with no sealed payload touched.
- Ghost rows are sealed duplicates: never inspectable, never dev-usable, never
  re-split, never re-seeded — ever.
- Recorded tallies (metadata-only, pre-unseal estimates, NOT floor inputs):
  Batch3 ~104 ghosts of 123 gross; P1 5/5 holdout ghosts, P2 13/14 ghosts + 1
  novel, P3 86/86 ghosts; P1/P3 dev rows novel (11 drearth + 1 kong, train via
  production import). Exact ghost/distinct counts are **unknown** until the
  §2.2 set subtraction runs at unseal.
- Upper-bound preview (NOT a finding): `(123 − ~104) + 23 ≈ ~42` distinct
  families ceiling from sealed stock vs the ≥400 floor. The sealed estate
  cannot qualify on its own under any labeling outcome; see §4.

## 3. Floor math

### 3.1 v4 development support (basis, not holdout credit)

From `development-support.json` `classSupport` (rows per known type; floor =
literal 20 rows). `no-fit` (222 rows) and `insufficient-evidence` (64 rows) are
adjudication outcomes, not qualifying classes, and are excluded from this math.

| Type | Rows | ≥20 | Deficit |
|------|-----:|:---:|--------:|
| bee-supplies | 25 | ✓ | 0 |
| bird-houses-baths | 16 | | 4 |
| cat-food-dry | 2 | | 18 |
| cat-food-wet | 20 | ✓ | 0 |
| cat-toys | 17 | | 3 |
| cat-treats | 7 | | 13 |
| cattle-feed | 1 | | 19 |
| collars-leashes | 10 | | 10 |
| dog-food-dry | 6 | | 14 |
| dog-food-wet | 8 | | 12 |
| dog-toys | 55 | ✓ | 0 |
| dog-treats | 33 | ✓ | 0 |
| equine-grooming-hoof | 33 | ✓ | 0 |
| fish-food | 18 | | 2 |
| flea-tick-treatment | 11 | | 9 |
| fly-control-equine | 19 | | 1 |
| goat-sheep-feed | 2 | | 18 |
| grooming | 31 | ✓ | 0 |
| horse-blankets-tack | 88 | ✓ | 0 |
| horse-treats-supplements | 3 | | 17 |
| insect-control | 8 | | 12 |
| lawn-fertilizer | 1 | | 19 |
| livestock-feeders | 3 | | 17 |
| livestock-health-dewormers | 8 | | 12 |
| plant-food-fertilizer | 33 | ✓ | 0 |
| potting-soil | 13 | | 7 |
| poultry-coops-equipment | 3 | | 17 |
| small-animal-feed-bedding | 43 | ✓ | 0 |
| supplements | 19 | | 1 |
| weed-control | 1 | | 19 |
| wild-bird-feeders | 174 | ✓ | 0 |

- Known types at floor: **10 of 31** (matches `classesAtTwentyRows: 10`).
- Types below floor: **21**; summed class deficit: **244 rows**
  (4+18+3+13+19+10+14+12+2+9+1+18+17+12+19+17+12+7+17+1+19).
- This table describes **development** support. It is the planning basis for
  what fresh holdout capture must cover; dev rows never count toward holdout
  floors.

### 3.2 What sealed-distinct stock could cover vs what needs fresh capture

- Per-class composition of ALL sealed stock (Batch1/2, Batch3, Batch4 held) is
  **unknown**: assigning a class to a sealed row requires reading its payload,
  which is inspection. No per-class sealed credit may be assumed, estimated, or
  interpolated in any plan.
- Volume ceiling: sealed distinct is bounded above by ~42 families (§2.3)
  against the ≥400-row floor — a shortfall of **≥350 rows** that MUST come
  from fresh capture even in the best case. Exact shortfall is **unknown**
  until unseal accounting.
- Class coverage: the holdout must prove its own 20 classes ≥20 rows each.
  Because sealed per-class labels are unknown, fresh-first capture MUST target
  the §3.1 deficit classes (prioritizing the 10 smallest-deficit types per the
  standing evaluated-class plan, plus food-class strategy revision per the
  Batch4 food-probe dry finding) without netting sealed stock against any
  class target.
- Fresh-first rules (carried, restated): every capture seed is a
  never-harvested domain; re-harvest forbidden except reviewer-approved gap
  fill with stated ghost-risk justification; dry Batch3/Batch4 domains are not
  re-proposed; food deficits need a non-blind-probing acquisition strategy
  (open question §8); split-variance rule applies (≥5×K novel in-stratum
  families per K needed known rows, quota permitting).
- Ghost rules restated: any fresh capture that re-recaptures a sealed familyId
  is a ghost at unseal and contributes zero; capture planning MUST treat
  re-harvest-adjacent domains as ghost-risky and prefer untouched domains.

## 4. Labeling protocol (after policy publication)

Policy publication (§1, row 2) satisfies the ordering constraint. The protocol
itself is NOT executed by this spec; the qualified labeling run happens only
after §7 gates clear.

1. **Independence.** Labelers MUST NOT have participated in development capture,
   adjudication, enrichment, or policy fitting for the generations under test,
   and MUST NOT have read dev gold for the classes they label. Labeler identity
   + non-participation attestation recorded per labeler.
2. **Labeler qualification.** Labelers demonstrate the task on a disjoint
   calibration set (dev gold from non-holdout classes or prior-generation
   material, NEVER sealed rows) to a pre-registered agreement bar before
   touching holdout material. Calibration results published with the labels.
3. **Citation binding.** Every `known` field value cites the exact sealed-row
   excerpt(s) supporting it (source locator + excerpt reference); every
   `no-fit` / `insufficient-evidence` verdict cites the reason (no supporting
   excerpt after full-row review / excerpt ambiguous or incomplete). Uncited
   labels are invalid.
4. **No-fit / insufficient discipline.** Adjudication-outcome rates from dev
   (222 no-fit / 64 insufficient of 997) are the standing attrition prior for
   capture sizing, but MUST NOT be used as per-row priors: each sealed row is
   judged on its own excerpts. Forced fits are disqualifying for the labeler.
5. **Peer re-derivation.** A second qualified labeler independently re-derives
   a pre-registered sample (or the full set for classes near the 20-row floor);
   disagreements adjudicated by a third party with citations published.
   Agreement statistics published per class.
6. **Sealed handling.** Labeling reads sealed payloads for the first time: it
   occurs in the unseal step only, under the §7 gate sequence, with access
   logging. Labeled holdout rows NEVER merge into development banks and NEVER
   inform capture, policy, or threshold changes.

## 5. Separation proof (family + exposure-URL, at unseal)

After labeling, before any floor claim, the unseal step MUST produce a
machine-checkable proof:

1. **Family separation.** Run `verifyFamilySeparation`
   (`src/classification/benchmark-exporter.ts:1396`) over the union of dev
   entries and labeled holdout entries: zero families straddling dev
   (train/test) and holdout (`detectFamilyDevHoldoutStraddle` empty), plus the
   near-duplicate screen (`detectFamilyNearDuplicates`) with every flagged pair
   dispositioned on the record. Non-empty straddle = floor claim fails.
2. **Exposure separation.** Every labeled holdout row's canonical URL MUST be
   absent from all public development banks (`byUrl` over public banks) and
   from the fitted-policy fitting-evidence set — artifact
   `docs/audits/jev-batch3/stratified-live-24.json` as named in
   `per-capability-policy.json` `fittingEvidence.artifact` (verify by the
   policy's recorded hash field); any exposure hit removes the row from floor
   credit (row stays sealed-archived, never re-split).
3. **Split-integrity check.** Recompute `splitForFamily(familyId, 42, 20)` for
   every credited holdout family and confirm `holdout`; any non-holdout
   recomputation removes the family (indicates a manual override or seed
   error to be investigated, never patched over).
4. Proof artifact (family lists redacted to counts + hashes if owner requires)
   is reviewer-approved before floor numbers are cited anywhere.

## 6. Gate sequence + the 305 sealed window remainder

Gates are sequential; each requires the named approval on the record. Until a
gate clears, all later steps — including any sealed read — are blocked.

| Gate | Action | Required approval |
|------|--------|-------------------|
| G0 | Approve THIS spec (or amend it) | Reviewer + owner |
| G1 | Authorize fresh holdout capture plan (targets §3.1 deficits, fresh-first, window budget) | Reviewer approves plan; owner authorizes spend |
| G2 | Execute capture; seal new custody (0600/0700, new dirs only, immutable ledger, hard stop 1200). Ledger acceptance: seqs contiguous from 896, receipts==spent per run, kinds tallied, 0 missing outcomes, spent≤cap, guards (privateCustodyParsed=false, labels=0, modelCalls=0) | Per-plan; reviewer verifies ledger integrity from public receipts/manifests |
| G3 | Authorize unseal accounting (§2): metadata-only familyId-set dedupe → gross/distinct/ghost tallies | Reviewer + owner, explicit unseal authorization |
| G4 | Authorize labeling run (§4: independent labelers, citation binding, re-derivation) | Reviewer + owner |
| G5 | Approve separation proof (§5) + floor claim (≥400 distinct rows, ≥20 classes ≥20) | Reviewer + owner |

- **NO-INSPECTION until gates clear:** no sealed payload read of any kind
  before G3 (accounting reads familyId sets only) and no label-bearing read
  before G4. Any earlier read voids the qualification attempt for the affected
  cohort.
- **The 305 sealed window remainder** (1200 − 895): this spec does NOT spend,
  allocate, or promise it. Disposition (hold for G1 fresh capture vs close the
  window) is a G1 owner decision on reviewer advice. Unspent P2 quota (97) and
  the R tranche remain under their existing non-recycling rulings and are NOT
  revived by this spec. If the window closes unspent, Batch3/Batch4 finals
  stand as recorded.
- Batch4 novel dev (11 rows) and enrichment (64/64) are unaffected by this spec
  under all outcomes.

## 7. Non-goals

- No payload inspection, labeling, or capture is authorized by this spec.
- No change to development gold, taxonomy, fitted policy, canaries, enrichment,
  or any prior acknowledgement/ruling.
- No approvals, labels, qualification verdicts, or floor claims are granted
  here — all are future gate outputs.
- No re-split, re-seed, dev-side reuse, or old-holdout (Batch1/2 309) credit
  toward any minimum, now or ever.
- No expenditure or reservation of the 305 window remainder.
- No new capture domains, seeds, quotas, or acquisition tactics are proposed
  here (those belong to the G1 capture plan).

## 8. Open questions (unknowns requiring owner/reviewer decisions)

1. Exact Batch3 distinct/ghost counts and per-cohort familyId sets — unknown
   until G3 unseal accounting. (Upper bounds in §2.3 only.)
2. Per-class composition of ALL sealed stock — unknown until G4 labeling; no
   planning credit taken.
3. Total fresh-capture volume and class targeting beyond §3.1 deficits —
   belongs to the G1 capture plan, not this spec.
4. Food-class acquisition strategy after the blind-probe dry pattern (0/5 food
   probes hit in Batch4) — distributor-record, manual, or other; G1 decision.
5. Formal predeclared 20-class evaluated set (standing direction: 10 qualified
   + 10 smallest-deficit) — Main/owner to finalize at G1.
6. Whether the 305 window remainder funds G1 capture or the window closes —
   G1 owner decision.
7. Labeler roster, calibration bar, and re-derivation sampling rates — set at
   G4 authorization, pre-registered before labeling.
8. Membership-file inventory reconciliation (per-stage `membership.json`
   lengths vs signed gross tallies) — to be reconciled from metadata at G3,
   NOT by reading sealed payloads now.
