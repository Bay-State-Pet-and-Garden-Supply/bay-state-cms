# Adjudication brief — the single failing Product Type row
`docs/audits/jev-representative-v9/adjudication-brief-leash-clip.md`
Status: RULED NO-FIT by independent reviewer subagent (confidence 0.98) — owner waived human review; this is the standing rule for accessory-vs-member cases.
Corpus: `docs/audits/jev-representative-v9/` (gold `development-gold-v9.json`).

## 1. The row
- SKU `PUBLIC:earthrated.com:296bf8efe35fecda`, family `family-698fc0b7b51025f77531d8f1b6ed28e0`, split `dev`.
- Gold: `productType.kind = no-fit`, `typeId = null`; all 8 controlled field states `inapplicable`; pages unknown.
- Item: Earth Rated leash-clip waste-bag dispenser accessory (silicone strap + hook + click-and-lock closure that attaches to a leash).
- Evidence (3 snippets, all `official_product_page`): "Click-and-lock closure to keep bags secure." / "Sturdy, minimal-swing silicone strap attaches easily to any style of leash." / "Signature hook for hanging used bags keeps your hands free and clean until you spot a trash bin."

## 2. What both sides did (verbatim from `secondary-comparison-v7-2026-10-06.json`)
- Candidate (Jev `jev-1.13.0`, `live_captured`): `productType = dog-waste-bags`, `typeProbability = 0.6`, not abstained; full distribution `dog-waste-bags 0.60 / collars-leashes 0.21 / no_match 0.15 / insufficient_evidence 0.03 / tie-down-straps-chains 0.01`, rest 0. Attributes: `species = Dog` only. Pages: predicted one page id at 0.99 (page gold is unknown for all rows — unevaluated).
- Baseline (DeepSeek `deepseek-flash`, `live_captured`): identical call — `dog-waste-bags`, confidence 0.85, `species = Dog`, pages abstained-semantic.
- The scorer marks both incorrect: `isJevProductTypeCorrect` (`src/classification/jev-qualification-service.ts:281-290`) requires exact `no_match` abstention for no-fit gold. No judgment involved — string comparison against adjudicated kind.
- Both models failed identically (0.60 and 0.85 confidence), so there is no cross-model signal to arbitrate; the disagreement is human-vs-model, which only a ruling resolves.

## 3. Counterfactuals, run through the real evaluator (not hand arithmetic)
Baseline: candidate Product Type correctness 0.9565, incorrect 1, coverage 0.7391.
- **Ruling "no-fit stands"** (candidate had abstained `no_match`): correctness **1.0**, incorrect **0**, coverage 0.6957. The coverage drop is mechanical: an abstention leaves the fixed population, exactly as 5 of the 7 no-fit rows already do.
- **Ruling "member of dog-waste-bags"** (gold relabeled, predictions untouched): correctness **1.0**, incorrect **0**, coverage unchanged 0.7391.
Under either ruling the zero-error gate clears on this corpus. The gate is doing its job: it holds because exactly one adjudicated label is contested, and it releases on exactly one ruling.

## 4. What the ruling must settle (one question, two consequences)
Is a functional accessory whose sole purpose is carrying waste bags a member of the `dog-waste-bags` product type, or genuinely no-fit?
- **If member:** the gold label (not the classifier) was wrong. No code changes follow; the error line disappears and the next corpus revision carries the corrected label. Note this also means DeepSeek was right here, and the +26.09 correctness delta narrows — report the revised delta, do not keep the old one.
- **If no-fit stands:** the row becomes the canonical hard negative for the type boundary, and the visible repair direction is over-generalization from dog-adjacency + waste-bag association (top alternatives were `collars-leashes` 0.21 and `tie-down-straps-chains` 0.01 — both strap/harness-adjacent). The honest fix is wording-level re-scoping of the no-fit/abstention policy (accessory-for-X is not X), and per #312's own acceptance criteria the repaired implementation must be re-evaluated on the fixed population — pre-repair numbers cannot qualify it.

## 5. What the ruling must NOT do
Lower the gate, carve an exception, re-adjudicate by model vote, or treat coverage loss (in the stands case) as harm: the abstention-coverage tradeoff is the documented fixed-population contract, and the other 5 no-fit abstentions already exercise it.

## 6. Ruling (independent reviewer subagent, owner-waived human review)
Verdict: **NO-FIT** — the gold label stands unchanged.
Justification (reviewer's own words): the membership case is that the accessory serves the waste-bag use case exclusively (closure keeps bags secure, hook hangs used bags). The stronger identity reading is that the same evidence plus "silicone strap attaches easily to any style of leash" describes a reusable holder for bags — not a bag — and the item contains no bags. Of the frozen taxonomy's candidate types (waste-bags as consumables, collars-leashes as restraint goods, grooming as skin/coat care, tie-down as trailer equipment), neither shared use nor strap-shaped construction makes the dispenser an instance of those goods, and no listed type covers it.
**Standing boundary rule:** classify an accessory by what it is, not merely by what it supports — assign a product type only when its stated scope includes the accessory itself, otherwise return no-fit when no available type does.
**Consequence:** the row stands as the canonical hard negative; the wording-level accessory-for-X fix and its fixed-population re-evaluation belong to #312's scope. The zero-error gate remains red for exactly one adjudicated row.
