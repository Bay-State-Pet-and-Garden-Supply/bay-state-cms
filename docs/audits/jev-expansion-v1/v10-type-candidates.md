# v10 product-type candidate proposal (catalog-mined + pilot-adjudicated)

Status: PROPOSAL ONLY — no taxonomy edited (`taxonomy_frozen` holds on v9).
Source: full catalog PF24 (93 distinct) / PF25 (332 distinct) over 22,108
rows, substring-matched against all v9 labels + legacyTypeIds; pilot
NO-FIT rows as boundary evidence. Counts are raw slot values below;
case-variants merged where obvious.

## Tier 1 — adjudicated pilot rows already banked as support

| candidate | pilot rows | catalog signal |
| --- | --- | --- |
| aquarium-equipment (habitat kits) | R1 Aqueon 5.5-gal kit | aquatics stratum 13 banked |
| aquarium-substrate | R10 clay substrate | same |
| aquarium-lighting | R13 clip-on LED | same |
| water-testing (diagnostics) | R17 ammonia strips | same |
| car-restraint (travel safety) | R20 tether+booster | collars-leashes spill 10 banked |
| feeder-baffle (squirrel baffle) | R21 baffle | wild-bird 105 banked |
| apparel-human-merch (falsifier class) | R24 cap | — |

## Tier 2 — catalog-count-backed, zero banked rows (collect first)

| candidate | PF24 | PF25 |
| --- | --- | --- |
| healthcare (pet health) | — | 345 |
| candles-home-fragrance (soy candles) | — | 255 |
| cat-litter-boxes (distinct from litter) | — | 57 + 34 bedding-litter |
| beekeeping | — | 57 |
| habitats (small-pet/reptile enclosures) | — | 63 + 20 |
| hay-forage | — | 48 |
| pet-first-aid | — | 37 |
| bowls-feeders (dishes, non-dispenser) | — | 27 |
| water-treatments-test-kits | — | 22 |
| footwear (barn boots) | — | 27 |
| apparel-workwear-human | — | 67 clothing |
| holiday-seasonal-decor | 84 seasonal | 54 + 30 + 26 |
| canning-preserving | — | 36 |
| chicken-poultry-supplies | — | 114 |
| pet-tags (ID tags) | 90 | 90 |
| collectibles | 89 | — |
| reptile-food-supplies | 206 | — |
| horse-health-wellness | 177 | — |
| wildlife-food | 17 | — |
| hydration (water systems) | 7 | — |
| knives-tools | 5 | — |

## Anti-patterns (do NOT promote to types)

Case-chaos duplicates (`Household`/`household`, `Lawn & Garden` × 3
cases — normalize, don't multiply); departments (`Household` 896,
`Lawn & Garden` 765+210, `Barn Supplies` 308+31); PF25 pseudo-types
(`food` 3369, `treats` 1892, `toys` 1522 — merchandising buckets, not
types); pipe-joined multi-values; ops markers (PF1/PF2).

## Recommended v10 sequencing

1. Tier 1 (7): evidence banked (pilot gold + 100+ stratum rows each).
   Draft definitions +120-row support check, then release authoring.
2. Tier 2 high-count (healthcare, candles, litter-boxes, beekeeping,
   habitats, hay, first-aid, bowls, tags, collectibles, reptile):
   collect 20-per-class official-page rows first (same machine).
3. Tier 2 long-tail (hydration, knives, wildlife): fold into nearest
   Tier 1/2 type or hold for v11; do not mint single-digit types.
