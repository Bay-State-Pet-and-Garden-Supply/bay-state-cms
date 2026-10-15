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

## PF1–PF15 verdict (supersedes the pre-screenshot verdict below): ALL SLOTS CERTIFIED 2026-10-15

Second user-supplied authenticated Extra Fields screenshot (2026-10-15 ~02:11,
read directly to verify). Transcription (exact text; PF1–4 and PF14 empty):

| Slot | Exact live label |
|---|---|
| Product Field 1 | *(empty — uncertified-unnamed)* |
| Product Field 2 | *(empty — uncertified-unnamed)* |
| Product Field 3 | *(empty — uncertified-unnamed)* |
| Product Field 4 | *(empty — uncertified-unnamed)* |
| Product Field 5 | Banner - Overlay Text |
| Product Field 6 | MAP Pricing |
| Product Field 7 | Child - Short Name |
| Product Field 8 | Custom Tab #1 |
| Product Field 9 | Custom Tab #2 |
| Product Field 10 | Custom Tab #3 |
| Product Field 11 | Special Order |
| Product Field 12 | Temporarily out of Stock |
| Product Field 13 | Upsell - Lightbox |
| Product Field 14 | *(empty — uncertified-unnamed)* |
| Product Field 15 | In Store Pick-up |

Exact-text notes: PF12 `Temporarily out of Stock` (lowercase `out of`);
PF15 `In Store Pick-up`; PF1–4/PF14 inputs are empty — recorded as
uncertified-unnamed, NOT as confirmed-empty-purpose.

### Per-slot adjudication (live purpose vs classification write path)

| Slot | Live purpose | Classification write path | Verdict |
|---|---|---|---|
| PF1 (unnamed) | Uncertified-unnamed | Promoter arrival-date fallback stamps `newMMDDYY` on every new draft (`draft-promoter.ts`) | **MISROUTED — BLOCKED**: `MISROUTED_CATALOG_SLOTS` guard refuses PF1; promoter skips the stamp when unmapped (listing/commerce-owned behavior, owner `draft-promoter.ts`; no `arrival_date` mapping exists in any authority, so the stamp is now inert) |
| PF2–4 (unnamed) | Uncertified-unnamed | No mapping, target, or literal in any authority (test/code refs are synthetic fixtures) | **OUT OF SCOPE** — no classification write path; not shown as purpose, only as unnamed |
| PF5 `Banner - Overlay Text` | Listing/commerce display | None (no mapping/target/proposal; test refs synthetic) | **OUT OF SCOPE** |
| PF6 `MAP Pricing` | Listing/commerce pricing | None | **OUT OF SCOPE** |
| PF7 `Child - Short Name` | Listing/commerce identity | None in production (only test-seeded `arrival_date→PF7` fixtures) | **OUT OF SCOPE** |
| PF8 `Custom Tab #1` | Display tab (not ingredients) | Stale workspace `nutrition→PF8` mapping (non-stale in cache) + reviewed revised-target path | **MISROUTED — BLOCKED**: guard refuses PF8 at edit + apply time; v9/v10 already `not_exported`. Live PF8 values (feeding HTML) are store-authored, never classifier output (0 `nutrition` proposals ever) |
| PF9–12, PF15 | Custom Tabs #2/#3, Special Order, Temp OOS, In-Store Pick-up | None (test-synthetic refs only) | **OUT OF SCOPE** |
| PF13 `Upsell - Lightbox` | Merchandising upsell | v10 `canonical-category-id→PF13` mapping (`isUniversal`, `shopsite` disposition) + revised-target path | **MISROUTED — BLOCKED**: guard refuses PF13 at edit + apply time. Real conflict confirmed: a category id must never land in an upsell slot |
| PF14 (unnamed) | Uncertified-unnamed | v10 `canonical-breadcrumb→PF14` mapping | **MISROUTED — BLOCKED**: guard refuses PF14. Breadcrumb projection into an unnamed slot is unverified output |

The user's hypothesis ("these slots don't apply to classification") is
**CONFIRMED as the end state**: after the guard, no classification write path
reaches any PF1–15 slot. It was not true before the fix — PF1/PF8/PF13/PF14
were classifier-reachable — so the hypothesis is recorded as verified
post-guard, not as originally true.

### Prior pre-screenshot verdict (kept for provenance; superseded above)

Before the PF1–15 screenshot arrived, repo references into PF1–PF15 existed
(seed `nutrition→PF8`; v10 `canonical-category-id→PF13`,
`canonical-breadcrumb→PF14`; promoter new-date PF1; PF4/PF8 test fixtures; PF1
skill conventions) while PF1–15 labels were uncertified — hence the earlier
KEEP-OPEN ruling. The screenshot + guard above resolve it.

## Closure verdict: criterion 1 SATISFIED — every classification-reachable slot certified or blocked

- PF16–32: 17/17 labels match live (first screenshot).
- PF1–15: all 15 labels certified (second screenshot; PF1–4/PF14
  uncertified-unnamed). Of the four classifier-reachable slots, PF13/PF14/PF8/PF1
  are now refused by `MISROUTED_CATALOG_SLOTS` (edit + apply time, covered by
  seam + promoter tests); all other PF1–15 slots have no classification write
  path (out of scope).

## Docs updated (both screenshots)

- `docs/audits/live-storefront-product-fields-2026-10-13.md`: all 32 rows
  CERTIFIED (PF16–32 first screenshot; PF1–15 second screenshot, PF1–4/PF14 as
  uncertified-unnamed); §4(1) updated — no uncertified labels remain.
  Pre-screenshot `LOCAL` labels for PF1–15 are superseded by the certified live
  labels wherever they differ (notably the inferred PF1–15 names).
- `scripts/realign-classification-mappings.ts` + seed header comments:
  full PF1–32 provenance certified 2026-10-15.
- `.agents/skills/shopsite-product-fields/references/product-xml-mapping.md`:
  binding-certification paragraph updated (all 32 certified; PF1–4/PF14 unnamed).
- `.agents/skills/bay-state-store/SKILL.md`: PF24/25 drafting-policy note now
  cites certified live labels (policy wording unchanged); PF1 rule updated to
  the refused-stamp behavior.
