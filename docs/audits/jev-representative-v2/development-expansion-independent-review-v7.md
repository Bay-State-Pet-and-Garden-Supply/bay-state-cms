# Independent Source-Only Review — Development Expansion v7 (94 families)

Scope: public v2 frozen taxonomy (`taxonomy.json`, bay-state-v7, 74 product types),
development source bank (`source-development.json`, 1523 rows), pilot gold/adjudication
(`development-gold.json`, `development-adjudication.json`, `support-dev.json`) and the
three expansion artifacts (`development-gold-expansion-v7.json`,
`development-adjudication-expansion-v7.json`, `development-support-expansion-v7.json`).
No predictions, model outputs, holdout/private custody, credentials, production DB, or
network/model calls were used. This is benchmark adjudication, not human catalog approval.

Authority binding: all reviewed artifacts carry
`authorityHash 2310c06a9e92ef55b91dc96b03fa6b31e19656b0adfead653f7c572040713577`
(release bay-state-v7). Adjudication `taxonomySourceHash` equals the frozen config hash;
`httpRequestLedger: []`, `extraPublicHttpRequests: 0` — source-only, no live fetches.

## Evidence verdict

- 94/94 expansion SKUs join 1:1 to `source-development.json` by SKU and `sourceIndex`;
  every `familyId` matches the bank row; 94 distinct SKUs, 94 distinct `sourceIndex`
  values, 94 distinct `familyId` values.
- Every adjudication citation quote is contained verbatim in the joined bank row's
  `excerpts` text (substring containment 100%; locators point at the correct
  `source-development.json#/<index>/excerpts/<n>` object). Note the quotes are
  substrings of longer captured excerpts, not full-excerpt equality — expected under
  the stated provenance-join normalization, recorded here as a precision limitation.
- Species cardinality: all multi-valued `species` (`values: [...]`) occur only under
  `grooming` or `supplements`, consistent with the frozen conditional inputs
  (`profile-grooming` / `profile-supplements` multiple, all other 72 profiles single)
  and the owner-approved change (NOT model tuning).
- Controlled-value vocabulary: all `known` field values fall within frozen
  `allowedValues` (checked species, food-form, flavor, life-stage, breed-size,
  packaging-type). All `categoryPages.pageIds` resolve to verified import pages.
- No-fit (6) vs ambiguous/unlabeled (13) vs insufficient-evidence (4) discipline is
  sound: no-fit rows document affirmative absence of any of the 74 types; unlabeled
  rows name 2+ candidate types with an explicit blocking rule (missing discriminator /
  single-value dispute / combination); insufficient-evidence rows withhold the type
  while retaining directly supported fields.

## Aggregate disagreements

One concrete authority contradiction in the 94-row expansion (1/94). All other 93 rows
concur with frozen v7 authority, citations, cardinality, field applicability, and
source independence.

### Disputed development row (public source ID only)

- `PUBLIC:petmate.com:8996487364929` — gold asserts
  `productType: { kind: known-type, typeId: caged-bird-toys }`, but the frozen v7
  bundle contains 74 product types and `caged-bird-toys` is not one of them (bird
  coverage is `bird-food`, `bird-houses-baths`, `wild-bird-feeders` only; no
  bird-toy type or profile exists). The source evidence ("JW Birdie Basketball Bird
  Toy", "a crowd favorite with all pet birds") does support a Bird toy fact, but no
  frozen type can be claimed. Independent verdict: `known-type: caged-bird-toys`
  is invalid under frozen v7; the row should be `no-fit` (or `unlabeled` only if a
  covering type existed — none does), with `species` retained as a directly
  supported fact per the unresolved-type rule.

No other disputed rows. In particular, garden-pest `species: inapplicable` rows
(e.g. insect-control / weed-control / grass-seed / lawn-fertilizer) are NOT disputed:
the adjudication explicitly marks species `outside-profile`, and gold's
`inapplicable` encodes that same outside-scope intent.

## Support: 26 pilot + 94 expansion = 120 independent families

- Pilot: 26 independent families (27 entries; the extra entry is the documented
  withholding variant sharing its `familyId`, not an independent family).
- Expansion: 94 independent families; zero `familyId` overlap with the pilot set;
  zero `sourceIndex` overlap with the pilot set.
- Combined: 120 independent families. The only repeated family in the combined
  selection is the pilot-internal withholding variant (same SKU/index twice by
  design). No variant leakage: no expansion row shares a bank `familyId`,
  `sourceIndex`, or SKU with any other selected row.

## Limitations

- Citation precision: quotes are verified substrings of the cited excerpt objects,
  not full-excerpt strings; a strict full-equality check would false-positive.
- Garden encoding: gold emits an explicit `species: inapplicable` assignment for
  lawn/garden profiles whose frozen profile has no species member. Semantically
  "outside profile / outside scope" per the adjudication, but strictly it is an
  extra-profile target. Recommend either omitting non-profile targets or renaming
  the state to `outside-profile` in a future contract version.
- Review is source-text-only against captured excerpts; image, DOM-layout, and
  off-excerpt context were not re-examined.
- No re-adjudication of the 26 pilot families was performed; pilot counts are taken
  from `support-dev.json` as stated.

## Follow-up: input-sufficiency audit of six development labels (source-only, no predictions)

Method: for each SKU, judged the calibration `gold.evidence` actually supplied to the
decision plus the exact cited manufacturer clips in the expansion adjudication,
against the literal v7 approved type definitions (names, invariantAttributes,
departments; every relevant `description` is `null`; workspace guidance contains no
grooming-vs-treatment, edible-vs-toy, or spray-vs-device rule). Brand familiarity,
full-bank facts omitted from the supplied input, and catalog category assignments
were not used. No prediction artifacts opened; no labels/files changed.

Literal approved definitions (taxonomy.json, bay-state-v7):
- `dog-toys`: name "Dog Toys", department `pet-supplies`, invariants
  `{ species: Dog }`, description `null`.
- `dog-treats`: name "Dog Treats", department `pet-supplies`, invariants
  `{ species: Dog, food-form: Treat }`, description `null`.
- `grooming`: name "Grooming", department `pet-supplies`, invariants `null/{}`
  (none), description `null`.
- `insect-control`: name "Insect & Pest Control", department
  `lawn-garden-landscaping`, invariants `{}` (none), description `null`.
- Guidance (`species-safety-guidance`, `page-assignment-guidance`,
  `domain-keywords-guidance`): no rule defining grooming vs medical/pest treatment,
  no edible vs non-edible chew rule, no spray/chemical-application requirement and no
  heating/electronic-device exclusion for insect-control.

Per-SKU verdicts from the SUPPLIED input alone:

- `PUBLIC:redbarn.com:6155086790836` — CONCUR (insufficient-evidence justified).
  Supplied: "Air Dried Beef Training Treats" + "Try today as a training treat or
  kibble topper!"; cited clips identical. No species is named and the second clip
  keeps treat-vs-topper unresolved, so withholding type and marking species
  insufficient-evidence follows the missing-discriminator rule. Withholding flavor
  despite "Beef" is consistent with no single-flavor priority rule.
- `PUBLIC:benebone.com:3517169401955` — DISAGREE (known-type `dog-toys` not
  justified; should be insufficient/unlabeled). Supplied: "Dental Chew" + "helps
  support your dog's daily dental routine"; cited clips identical. Neither clip
  establishes edibility vs non-edible construction or toy-ness, and the literal
  `dog-toys` vs `dog-treats` definitions above supply no edible/non-edible
  discriminator (both descriptions `null`). "Chew" alone cannot pick `dog-toys`
  over `dog-treats`. Species Dog is the only justified fact from the supplied
  "your dog's" clip.
- `PUBLIC:tropiclean.com:9170786615551` — DISAGREE (known-type `grooming` not
  justified from supplied input; should be insufficient/unlabeled). Supplied:
  "TropiClean OxyMed Hypoallergenic Anti Itch Spray for Dogs and Cats" +
  "Perfect for dogs, cats, puppies, and kittens"; cited clips identical. "Anti
  Itch Spray" does not resolve grooming vs medically/pest-specific treatment under
  the literal `grooming` definition (name only, description `null`, no invariants,
  no grooming-vs-treatment rule in guidance). The parallel
  `PUBLIC:naturvet.com:6928058384432` lotion-spray input below was held
  insufficient on materially identical evidence, so the pair is inconsistent from
  the supplied input alone. Species [Dog, Cat] is justified from the supplied
  clips.
- `PUBLIC:naturvet.com:6928058384432` — CONCUR (insufficient-evidence justified;
  correct template). Supplied: "Septiderm-V Skin Care Lotion Spray for Dogs and
  Cats" + "relief for your dog or cat and support a shinier coat"; cited clips
  identical. Type is withheld because the supplied facts do not resolve a
  grooming-vs-treatment function, while species [Dog, Cat] is retained as a direct
  fact. This is the standard the TropiClean row above fails to meet.
- `PUBLIC:thermacell.com:30062244921486bdd041` — DISAGREE (no-fit not justified
  from supplied input + literal definition; should be insufficient/unlabeled).
  Supplied: "E-ZoneGuard Patio + Rechargeable Mosquito Repeller (E65)" +
  "On-demand mosquito repellent starts heating with the push of a button"; cited
  clips identical. The literal `insect-control` definition ("Insect & Pest
  Control", no invariants, description `null`) does not exclude heating or
  electronic repellent devices, and no spray/chemical-application requirement
  exists in taxonomy or guidance. "Mosquito repellent" facially matches the type
  name; the no-fit reasoning imports an application-method restriction that is an
  unavailable defining fact relative to the supplied input.
- `PUBLIC:thermacell.com:17aa863126bd5e699f22` — DISAGREE (no-fit not justified;
  should be insufficient/unlabeled). Supplied: "LIV 2.0 On-Demand Mosquito+
  Repellent System" + "Get On-Demand protection through LIV 2.0 App"; cited clips
  identical. Same literal-definition point as above: nothing in the approved
  `insect-control` definition excludes an app-controlled hub-and-repeller system,
  and the supplied clips do not supply the missing exclusion.

Omitted-fact check: no separate rescue applies. Within the evidence actually
supplied and cited for these six rows, no accidentally omitted decisive cited fact
was found that would reverse any verdict above; nothing was fabricated to fill
the gaps. Four disagreements total (benebone, tropiclean, thermacell x2); two
concurs (redbarn-insufficient, naturvet-insufficient).
