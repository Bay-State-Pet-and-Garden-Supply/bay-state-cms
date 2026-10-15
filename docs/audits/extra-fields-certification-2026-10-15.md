# Extra Product Fields Label Certification — 2026-10-15

## Provenance

User-supplied authenticated Extra Product Fields (Extra Fields settings) screenshot,
received 2026-10-15. It IS the authenticated source for this certification (issue #355
criterion 1). No live ShopSite calls were made; no credentials were handled. PF1–PF15
were **not shown** in the screenshot and remain **uncertified**.

## Transcription (verified by direct read of the screenshot file)

| Slot | Exact live label |
|---|---|
| Product Field 16 | Facet - Brand |
| Product Field 17 | Facet - Pet Type |
| Product Field 18 | Facet - Lifestage |
| Product Field 19 | Facet - Pet Size |
| Product Field 20 | Facet - Special Diet |
| Product Field 21 | Facet - Health Feature |
| Product Field 22 | Facet - Food Form |
| Product Field 23 | Facet - Flavor |
| Product Field 24 | Facet - Category |
| Product Field 25 | Facet - Product Type |
| Product Field 26 | Facet - Product Feature |
| Product Field 27 | Facet - Size |
| Product Field 28 | Facet - Material |
| Product Field 29 | Facet - Color |
| Product Field 30 | Facet - Packaging Type |
| Product Field 31 | Product Category |
| Product Field 32 | Product Cross Sell |

Exact-text notes: PF18 is `Lifestage` (single word); PF32 is `Product Cross Sell`
(no hyphen); PF31 `Product Category` is distinct from PF24 `Facet - Category`.

## Per-slot repo diff (live is authority)

`scripts/realign-classification-mappings.ts` `SHOP_SITE_FIELD_LABELS` (PF16–PF32):
**17/17 MATCH** — every repo-declared label is byte-identical to the live label.
No mapping/seed/doc correction was required for PF16–32 labels.

Seed (`src/classification/config-seeds/bay-state-pet-garden-v1.ts`) brand/category/
product-type bindings (PF16/PF24/PF25) and `Facet - …` descriptions: consistent
with the certified labels. v10 release attribute descriptions naming
`Facet - Category` / `Facet - Product Type` / `Facet - Product Feature` /
`Facet - Size`: consistent.

Intentional divergences (NOT label mismatches, no correction made):
- v10 renames the `product-cross-sell` attribute display name to
  `UPC List (read-only)` with `not_exported` disposition (owner-approved
  2026-10-06 alignment: live PF32 carries pipe-joined UPC/barcode identifiers).
  The live slot label remains `Product Cross Sell`; the rename is local policy.
- v10 retires `breed-size`/`size` (PF19/PF27) to `not_exported` with mappings
  removed. The live labels `Facet - Pet Size` / `Facet - Size` are certified;
  only CMS export intent changed.
- The reviewed seed still maps PF19/PF27/PF32 (behind the P0 taxonomy freeze;
  seed-sync fails closed). Seed ↔ v10 divergence belongs to #350+ taxonomy
  work, not this certification.

## PF24 vs PF31

Mappings never conflate them: `category` → PF24 only; nothing maps to PF31
(seed comment, generator test, and `classification-mapping-audit.md` all reserve
PF31 as occupied-live-only / reserved-until-live-verified). PF31 stays
occupied-live-only: certified label, no CMS write path.

## PF32 write protection (v10 production path)

- No `ProductField32` entry in v10 `export-mappings.json` (15 mappings, none PF32).
- `product-cross-sell` disposition is `not_exported`; the compiler derives
  curation targets only from `shopsite` dispositions, so v10 has no PF32 target.
- With no mapping, apply-time `applyCatalogClassification` skips with
  `No attribute mapping found`; `not_exported` attributes serialize nothing.
- Covered by `src/tests/unit/release-v10.test.ts` ("retires product-cross-sell
  and nutrition: not_exported, unmapped, target-less").
- Caveat: v10 `facet-profiles.json` still lists `product-cross-sell` membership
  (11 profiles) and the frozen reviewed seed still maps PF32. Proposals without
  mapping authority cannot write; seed/v10 alignment is #350+ work.

## PF1–PF15 verdict: REFERENCES EXIST — criterion 1 cannot fully close

The screenshot does not show PF1–PF15, and live labels there stay uncertified.
Repo references into PF1–PF15 (grep evidence):
- Seed maps `nutrition` → `ProductField8`.
- v10 maps compiled projections `canonical-category-id` → `ProductField13`,
  `canonical-breadcrumb` → `ProductField14` (CMS-authored, live-empty slots —
  no live label asserted, but numeric bindings in the uncertified range).
- Unit-test fixtures reference `ProductField4`/`ProductField8`
  (`REVIEWED_FIELDS`, codec/evidence fixtures).
- `src/onboarding/draft-promoter.ts` constructs new-date `ProductField1`.
- `bay-state-store/SKILL.md` documents `ProductField1` conventions.

Per the certification gate, the affected set is NOT fully certified by PF16–32
alone. Issue #355 stays open pending authenticated PF1–15 label evidence.

## Docs updated

- `docs/audits/live-storefront-product-fields-2026-10-13.md`: PF16–PF32 rows
  `UNRESOLVED` → `CERTIFIED (2026-10-15 Extra Fields screenshot)`; §4(1) and
  headline scoped to PF1–PF15. PF1–PF15 rows untouched (uncertified).
- `scripts/realign-classification-mappings.ts` + seed header comments:
  PF16–32 provenance `unverified` → certified 2026-10-15; PF1–15 still unverified.
- `.agents/skills/shopsite-product-fields/references/product-xml-mapping.md`:
  binding-certification paragraph updated (PF16–32 certified, PF1–15 pending).
- `.agents/skills/bay-state-store/SKILL.md`: PF24/25 drafting-policy note now
  cites certified live labels (policy wording unchanged).
