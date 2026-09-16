# Issue #199 — brand inventory + sourcing-strategy resolution (10 brands, 34 items)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Status:** resolutions recorded here + executable applicator; operator applies to production.
**Code:** `src/onboarding/brand-hub/brand-strategies-199.ts` (spec),
`scripts/apply-brand-strategies-199.ts` (applicator),
`src/tests/unit/brand-strategies-199.test.ts` (13 tests).

## Count reconciliation (acceptance: counts reconcile to the corrected 34-item inventory)

The draft spec header said "37 items" but its own per-brand rows sum to **34**
(8+6+4+3+3+3+3+2+1+1). The research doc repeated the "37" header with the same
rows. The header was the error; the per-brand counts are the corrected
inventory. `BRAND_199_TOTAL_ITEMS` asserts 34 in code so drift fails loudly.

## Resolutions (acceptance: every brand states official vs distributor with rationale)

Evidence observed 2026-09-16 via live homepage fetches (status + canonical +
platform markers) and search. Homepage platform is a triage signal only —
product-page proof is ticket #201's job.

| Brand | Items | Strategy | Domain / pins | Rationale (short) |
|---|---|---|---|---|
| Snif-Snax | 8 | official_page | snifsnax.com | Live official store (200, self-canonical); brand-owned catalog |
| Jolly Pets | 6 | official_page | jollypets.com | Live official store (200, self-canonical) with dog-toy catalog |
| Hummzinger | 4 | official_page | hummzinger.com | Live manufacturer site (Aspects, Inc., 200) with /product/ pages |
| YowUp | 3 | official_page | yowup.com | Live official site (200, self-canonical) with locale product pages |
| Wondercide | 3 | official_page | wondercide.com | Live official store (200, www canonical) with full catalog |
| Sevin | 3 | official_page | gardentech.com | Sevin is a GardenTech line — house domain is the official presence (ADR 0017 convergence) |
| OurPets | 3 | **distributor-first-class** | phillips, pet_food_experts | Historic domain ourpets.com is **dead** (Shopify "store unavailable" post-Petmate-acquisition); no official domain exists |
| Coop & Range | 2 | **distributor-first-class** | orgill, central_pet | No official site exists — coopandrange.com is a parked for-sale page; farm-channel brand via distributors |
| OC | 1 | official_page | ocraw.com | "OC" = OC Raw Dog (only pet-brand match); live official site (200, www canonical) with /product/ pages — **identity must be confirmed from the item row before approving** |
| Horsemen's Pride | 1 | official_page | horsemenspride.com | Live official store (200, self-canonical) with full catalog |

Official total: 8 brands / 29 items. Distributor-first-class total: 2 brands /
5 items. Combined: **10 brands / 34 items — zero pending items without a
recorded sourcing strategy.**

Distributor-first-class choices are explicit Included pins in the approved
strategy (visible in `approvedSources`, deriving `profile_bypass_eligible`),
not fallbacks-by-omission. OurPets fallback if distributor evidence fails to
qualify: map the Petmate house site (petmate.com, alive, Shopify) — documented
here, never silently assumed.

## #201 handoff (acceptance: newly mapped official domains go to the probe before profile work)

| Domain | Homepage platform signal | Probe first |
|---|---|---|
| snifsnax.com | Shopify + JSON-LD | Shopify product JSON, redirect chain, structured data |
| jollypets.com | Shopify + JSON-LD | Shopify product JSON, redirect chain, structured data |
| hummzinger.com | None (unknown — WP/custom?) | Mechanism unknown: probe /product/ pages before ANY profile work |
| yowup.com | WordPress + JSON-LD | WooCommerce markers? Product/Offer schema? |
| wondercide.com | Shopify + JSON-LD | Shopify product JSON, variant-bearing pages |
| gardentech.com | Sitecore (/-/media/) | Template-driven? Scope must be Sevin pages (multi-brand house site) |
| ocraw.com | WooCommerce + WordPress | Woo markers? Product/Offer schema? |
| horsemenspride.com | Shopify + JSON-LD | Shopify product JSON, redirect chain, structured data |

No domain proceeds to profile work on this homepage evidence alone.

## Application runbook

**Brand-level (this ticket, scripted):**

```bash
# 1. Review the plan (dry-run, default):
bun scripts/apply-brand-strategies-199.ts --db=$BAYSTATE_CMS_DB_PATH
# 2. Verify the single OC item matches the OC Raw Dog catalog:
#    sqlite3 $DB "SELECT id, product_name, upc FROM onboarding_items WHERE brand_hint LIKE '%OC%' ..."
#    (match name/UPC against ocraw.com; on mismatch: --skip-brands=oc, route item to needs-info)
# 3. Apply (OC requires explicit identity acknowledgement):
bun scripts/apply-brand-strategies-199.ts --db=$BAYSTATE_CMS_DB_PATH --apply --acknowledge-oc-identity
```

Each write goes through `saveBrandStrategy` (guarded atomic Save:
revision guard + configuration token, mapping + approval commit together).
Re-runs are idempotent (identical approved sources skip; diverged sources
re-approve to rev N+1 for audit). Every run (dry-run or apply) also prints
a live item-coverage check (`summarizeItemCoverage` over non-duplicate
`onboarding_items.brand_hint`): per-brand live-vs-spec counts, UNJOINED
spellings that no strategy attaches to, and blank-hint items needing
`assign-brand`. The check is warn-only — spelling variance resolves via the
assign surfaces below, never by editing resolutions to match typos.

**Item-level (operator, stage-appropriate surfaces — 34 items):**

- Items held for brand identity → `POST /api/onboarding/batches/:id/assign-brand-group`
  (bulk `assign_brand`) or `POST /api/onboarding/items/:id/assign-brand`.
- Items held for domain → `POST /api/onboarding/items/:id/assign-domain`
  (Discovery-scoped; official brands converge onto the single domain above —
  never retailer domains, which the approval flow rejects).
- Distributor-first-class items (OurPets, Coop & Range) take the
  `distributor_record_to_extraction` route on qualification (null URL,
  merchandising-depth, Amendment B) — no Discovery, no profile.
- Distributor collection readiness stays `setup_attention` until ticket #200
  verifies connections/secrets — approval does not imply collectability.

## Acceptance mapping

- [x] Zero pending items lack a recorded sourcing strategy — 10/10 brands resolved (8 official, 2 distributor-first-class), 34/34 items covered.
- [x] Official vs distributor stated with rationale per brand; distributor choices are explicit pins.
- [x] 8 newly mapped official domains handed to #201 with platform signals (table above).
- [x] Counts reconcile to the corrected 34-item inventory (37-header error documented).
