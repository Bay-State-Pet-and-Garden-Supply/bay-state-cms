# Audit: bay-state-v8 — owner type definitions, two types only

Status: **candidate for primary review/activation via the Release API. Not activated here.**

## Change

`bay-state-v8` (sourceBaseline `bay-state-v7`, V5 generation, manifest schemaVersion 3
unchanged) sets verbatim owner definitions on EXACTLY two hierarchy nodes:

- `grooming`: "Pet skin and coat care, including cleansing, conditioning, medicated
  shampoos, lotions and anti-itch sprays. Products explicitly intended for flea or tick
  control belong to Flea & Tick Treatment."
- `insect-control`: "Insect and pest control products, including mosquito repellents,
  electronic or heated repellent devices and their dedicated repellent consumables."

## Preservation proof (asserted in `src/tests/unit/release-v8.test.ts`)

- Manifest `fileVersions` equal sha256 of exact v8 file bytes; counts identical to v7.
- Hierarchy diff vs v7 is ONLY the two `description` keys (v7 nodes carry none); every other
  node byte-identical, all invariants untouched.
- All 7 non-hierarchy release files byte-identical modulo `bundleOrigin` rebinding.
- V5 validation gate: 0 errors. Generation detection: v5.
- Compiled v7→v8: attribute profiles deep-equal (species `multiple` still EXACTLY
  `profile-supplements` + `profile-grooming`); product types differ ONLY in the two
  descriptions above.

## Seam notes

- `HierarchyNodeEditChange.description` (1–500 chars or null; ids/parentIds immutable) and
  optional nullable `description` on the V4/V5 hierarchy-node release schemas
  (`release-validation.ts`); compiler passes `node.description ?? null` through to
  `productTypes` (null preserved for all undescribed nodes, so older releases compile
  byte-identically). `shared/schemas/classification.ts` untouched per ownership.
- Older releases, snapshots, benchmark gold/inputs, replay/prediction, questions: untouched.
