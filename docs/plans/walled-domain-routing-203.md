# Issue #203 — walled-domain distributor routing (5 domains)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** record-only routing against two input
artifacts — the #200 readiness checklist (verified state, not assumptions)
and the #201 leaf product-page verdicts (no re-probing here).
**Code:** `src/onboarding/brand-hub/walled-domain-routing-203.ts` (routing
table + pure helpers), `src/tests/unit/walled-domain-routing-203.test.ts`
(16 tests). **No production writes** (no profile rows, no mapping rows, no
source-URL or `domain_status` edits, no generation-pin contact, no live
vendor calls — the #198 release guard already landed and this ticket needs
no enablements).

## Scope change (from #201 — #203-as-written is stale for three domains)

#201 re-probed all five walls at leaf product-page level on 2026-09-16:

- **Wall LIFTED for plain fetch (3):** `bil-jac.com`, `northstatesind.com`,
  `yeowww.com` — every probed leaf returns HTTP 200 with real catalog
  content. These re-route to **worker-validated static profiles first**,
  distributor only on validation failure.
- **Still walled (2):** `chickensouppets.com` (homepage AND leaf 403),
  `multipet.com` (leaf 403) — proven at product-page level. These stay
  **distributor/manual, zero profile rows now and ever**.

## Routing outcomes (acceptance: one recorded outcome per domain)

All five record `blocked_with_reason` — honestly. Distributor cannot flow
with zero generations, zero pins, zero gate observations, and zero items
(#200 verdict: none routable today); manual evidence cannot be staged with
zero failed items (entry is only from `extraction/failed`).

| Domain | Brand | Wall | Route | Future items move by |
|---|---|---|---|---|
| bil-jac.com | Bil-Jac | lifted (leaf 200s `a9947dca…`, `1eb09766…`; WP Elementor, OG title/image) | static validation (OG/meta-backed) → new ticket, no owner | worker-validated static profile first; distributor only on validation failure |
| northstatesind.com | North States | lifted (leaf 200s `89bbe50d…`, `fa9c0099…`; BigCommerce, full JSON-LD sku+gtin+offer) | static validation (JSON-LD-backed, strongest) → new ticket, no owner | worker-validated static profile first; distributor only on validation failure |
| yeowww.com | Yeowww! | lifted (leaf 200s `1936ead4…`, `58b30de1…`; BigCommerce, OG-only, uneven) | static validation (weakest — validation is the gate) → new ticket, no owner | worker-validated static profile first; distributor only on validation failure |
| chickensouppets.com | Chicken Soup | still 403 (homepage AND leaf) | distributor/manual (#203 as written) | distributor-record qualification or staged manual evidence, never selectors |
| multipet.com | Multipet | still 403 (leaf `/shop/tpr-spike-bone/`) | distributor/manual (#203 as written) | distributor-record qualification or staged manual evidence, never selectors |

Blocked reasons + owner follow-ups per domain live in `WALLED_ROUTES_203`
(`blockedReason`, `followUps`): `domain_status` re-check (all five rows
still read `blocked` from the 2026-08-20 check — stale for the three
lifted, consistent for the two walled; all past the 7-day
`getDomainStatus` TTL so the next live read re-checks without hand-edits),
worker-validation tickets for the lifted three, FU-1 live smoke + strategy
pins + FU-4 observe-mode accumulation for the still-walled two.

## Readiness grounding (from #200 — transcribed, not re-assumed)

Mechanical floor ready: sourcing mode `automatic` (`default_on`), 5/5
`html_scraper` connections enabled, 3/3 auth secrets usable
(shape-verified, never disclosed), zero profile collisions (23 profiles,
none walled). Qualification unproven: 0 generations, 0 attempts, 0 walled
strategy pins (the single approved pin is open farm rev 2), 0/100 gate
observations on every connector, no live smoke run in #203 (no live vendor
calls from the agent sandbox — FU-1 stays an explicit operator action with
the exact command in each still-walled row's follow-ups).

Manual-evidence preconditions per domain: the no-existing-profile rule
passes vacuously (zero walled rows — the `verifyZeroProfileRows` seam takes
the production `findProfileByDomain` lookup); the prior-eligible-failure
requirement is unmet (zero items). When a future item fails closed with the
profile-blocked signature, staging unlocks via the audited operator path —
documented per row in `manualEvidence.unlockNote`, never staged by this
ticket.

## Sitemap discipline (acceptance: no absence used as sole justification)

`sitemap_cache` holds 32 domains and none of the five walled domains
(verified 2026-09-16) — and that absence decided nothing. Every routing
call cites leaf HTTP status as its deciding evidence (`sitemap.decidingEvidence`,
`soleJustification: false` on all five, asserted in tests): 200s for the
lifted re-routes, product-page-level 403s for the still-walled routes.
Sitemap absence is a discovery inconvenience, never proof of impossibility
(#197 story 11).

## Acceptance mapping

- [x] Each of the five domains has a recorded routing outcome
  (`WALLED_ROUTES_203`: 3× static-validation re-route, 2×
  distributor/manual — all `blocked_with_reason` with reason + named
  follow-ups; nothing left as "probably fine").
- [x] Zero profile rows created for walled domains (`createsProfileRow:
  false` on every entry; `verifyZeroProfileRows` seam + re-verification
  query below — observed state recorded alongside, not just the query).
- [x] Items (present or future) move by the routed mechanism
  (`futureItemsMoveBy`: still-walled → distributor/manual, never selectors;
  lifted → static validation first, distributor only on failure).
- [x] No sitemap absence was used as sole justification for any routing
  call (`soleJustification: false` ×5; every call cites its own leaf HTTP
  status — 200s for lifted, product-page 403s for still-walled).

## Observed live state 2026-09-16 (read-only; recorded as evidence, not assumed)

Taken against `storage/catalog/.shopsite-cms/app.db` (`mode=ro`) while
writing this ticket — the re-verification queries below reproduce every row:

- `extractor_profiles` walled rows: **0** (23 profiles total, none walled;
  no `www.`-keyed rows exist at all).
- `sitemap_cache` walled rows: **0** (32 cached domains, none walled).
- `sourcing_generations` / `onboarding_evidence_attempts`: **0 / 0**.
- `domain_status`: all five still read `blocked` (Cloudflare 403) from the
  2026-08-20 check — stale for the three lifted domains (contradicted by
  #201's 2026-09-16 leaf 200s), consistent for the two still-walled ones
  (confirmed by #201's leaf 403s); all five past the 7-day
  `getDomainStatus` TTL.

## Re-verification (read-only; re-run anytime)

```bash
DB="storage/catalog/.shopsite-cms/app.db"
# Production stores normalized apex domains (lowercase, no www. — verified:
# no www.-keyed rows exist), so exact IN is the faithful check. Observed
# 2026-09-16: zero rows.
# ^ must return zero rows (acceptance: zero profile rows for walled domains)
sqlite3 "file:$DB?mode=ro" "SELECT domain FROM extractor_profiles WHERE domain IN ('bil-jac.com','chickensouppets.com','multipet.com','northstatesind.com','yeowww.com');"
sqlite3 "file:$DB?mode=ro" "SELECT domain,status,checked_at,substr(COALESCE(reason,''),1,80) FROM domain_status WHERE domain IN ('bil-jac.com','chickensouppets.com','multipet.com','northstatesind.com','yeowww.com');"
sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM sitemap_cache WHERE domain IN ('bil-jac.com','chickensouppets.com','multipet.com','northstatesind.com','yeowww.com');"
# ^ must return 0 (absence is recorded here precisely so it can never silently justify a call)
sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM sourcing_generations; SELECT COUNT(*) FROM onboarding_evidence_attempts; SELECT COUNT(*) FROM brand_sourcing_strategies WHERE brand IN ('Bil-Jac','Chicken Soup','Multipet','North States','Yeowww');"
npx vitest run src/tests/unit/walled-domain-routing-203.test.ts
curl -s -o /dev/null -w '%{http_code}\n' https://www.bil-jac.com/products/picky-no-more-medium-large-breed-dog-food/
curl -s -o /dev/null -w '%{http_code}\n' https://northstatesind.com/north-states-mypet-petgate-essential/
curl -s -o /dev/null -w '%{http_code}\n' https://yeowww.com/our-products/catnip-pouch/
curl -s -o /dev/null -w '%{http_code}\n' https://www.chickensouppets.com/dogs/classic-adult-natural-dry-dog-food-chicken-brown-rice-turkey-recipe
curl -s -o /dev/null -w '%{http_code}\n' https://www.multipet.com/shop/tpr-spike-bone/
```
