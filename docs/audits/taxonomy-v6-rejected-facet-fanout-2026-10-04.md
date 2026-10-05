# Audit: bay-state-v6 REJECTED — shared-facet fan-out exceeded owner approval

Status: **REJECTED candidate. Never activated, never pinned. Do not activate.**

## What v6 did

`bay-state-v6` (sourceBaseline `bay-state-v5`) flipped species `single→multiple` on the two
**shared** facet profiles `profile-pet-food` and `profile-accessories`. The release-file diff was
two entries, but the release compiler fans shared facets out per type, so **21 compiled
profiles** became multi-species — including `profile-dog-food-dry`, `profile-cat-food-dry`,
`profile-collars-leashes`, and other sibling types outside the approval.

## Why rejected

Owner approval covered **EXACTLY** the compiled `profile-supplements` and `profile-grooming`
species entries (official manufacturer copy explicitly listing Dog+Cat). The 19 sibling-type
fan-out was never approved. The v6 manifest notes inaccurately framed the change as scoped;
that framing is withdrawn by this audit.

## Disposition

- The proposal was moved **byte-for-byte** (all 9 file sha256 hashes verified unchanged
  pre/post move) out of application release discovery to
  `docs/audits/rejected-taxonomy-v6/bay-state-v6/` — a move, not a data deletion. It is
  **absent from `src/classification/releases/`** (now v3/v4/v5/v7 only) and can no longer be
  listed, validated, compiled, or pinned by the application Release API. Its frozen manifest
  (`releaseId bay-state-v6`, `sourceBaseline bay-state-v5`, `lifecycle release`) is preserved
  with **no lifecycle or provenance edits** — nothing here retroactively approves it.
- The overbroad approval framing in the v6 manifest notes (scoped change / owner approval of
  the outcome) is **withdrawn** by this audit: owner approval covered ONLY the compiled
  `profile-supplements` + `profile-grooming` entries, which v6 did not isolate.
- Superseded by `bay-state-v7` (sourceBaseline `bay-state-v5`, active pin): two NEW dedicated facets
  (`profile-pet-food-supplements`, `profile-accessories-grooming`) with ONLY the
  `supplements` and `grooming` type nodes rebound. Compiled before/after proves EXACTLY
  `profile-supplements/species` + `profile-grooming/species` changed; the other 72 compiled
  profiles are byte-identical.
- No benchmark gold, evaluator, model questions, scripts, or held-out material were involved
  in either candidate.
