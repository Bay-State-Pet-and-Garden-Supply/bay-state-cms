# Issue #208 — retry sweep + observability close-out

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** record-only synthesis — per-domain
records transcribed from the mechanism input artifacts (#204, #205,
#206, #207, #203) plus a live read-only sweep snapshot against the
workspace DB (`storage/catalog/.shopsite-cms/app.db`, `mode=ro`).
Nothing here is re-probed, re-validated, or re-routed.
**Code:** `src/onboarding/brand-hub/retry-sweep-closeout-208.ts`
(ledger + sweep predicate + untouched seam + close-out note),
`src/tests/unit/retry-sweep-closeout-208.test.ts` (14 tests).
**No production writes** (no profile rows, no activations, no item
moves, no review-state edits — activation and selected retry are
operator acts queued in §4).

## 1. Per-domain ledger (acceptance: mechanism, evidence, activation, cost, failure codes)

Ticket-scoped items sum to 70 (5 + 5 + 7 + 53 + 0). Every draft was
hand-authored and worker-validated: total metered LLM spend is **0
tokens**. All profile mechanisms satisfy the three-confirmation rule on
evidence with no waivers. Full rows live in `DOMAIN_LEDGER_208`; the
table below is the summary:

| Domain | Ticket | Mechanism | Items | Confirmations | LLM | Failure codes seen |
|---|---|---|---|---|---|---|
| bonide.com | #204 | static structured profile | 5 | 3, no waiver | 0 | clean nulls + `variant_selection_required` (3 variant-blocked URLs) |
| www.nylabone.com | #205 | single AI draft | 5 | 6 across 3+ templates, no waiver | 0 | clean nulls |
| www.bluebuffalo.com | #206 | full AI draft | 7 | 6 across 4 templates, no waiver | 0 (`LLM_COST_206`) | clean nulls |
| discovernutrisource.com | #207 | Shopify minimal profile | 27 | 3, no waiver | 0 | clean nulls |
| openfarmpet.com | #207 | Shopify minimal profile | 8 | 3, no waiver | 0 | clean nulls |
| snifsnax.com | #207 | Shopify minimal profile | 8 | 3, no waiver | 0 | clean nulls |
| jollypets.com | #207 | Shopify minimal profile | 6 | 3, no waiver | 0 | clean nulls |
| www.wondercide.com | #207 | Shopify minimal profile | 3 | 3, no waiver | 0 | clean nulls |
| horsemenspride.com | #207 | Shopify minimal profile | 1 | 3, no waiver | 0 | clean nulls |
| bil-jac.com | #203 | static-validation follow-up | 0 | n/a (downstream ticket) | 0 | — (wall lifted, leaf 200s) |
| northstatesind.com | #203 | static-validation followup | 0 | n/a (downstream ticket) | 0 | — (wall lifted, JSON-LD leaves) |
| yeowww.com | #203 | static-validation followup | 0 | n/a (downstream ticket) | 0 | — (wall lifted, thin OG layer) |
| chickensouppets.com | #203 | distributor/manual blocked | 0 | n/a (no selectors ever) | 0 | — (leaf 403) |
| multipet.com | #203 | distributor/manual blocked | 0 | n/a (no selectors ever) | 0 | — (leaf 403) |

Unique-backlog reconciliation: the 86 items of the #197 inventory are
34 (#199 strategies, incl. 18 Shopify domains validated inside #207) +
35 (#207-as-written Nutrisource/Open Farm) + 5 (#204) + 5 (#205) + 7
(#206). #207's 53 = 35 + the 18 already counted in #199 — no
double-count; the ledger counts #207's 53 once.

## 2. Sweep result (acceptance: eligible retried, ineligible listed with reasons)

Live snapshot 2026-09-16: **0 eligible / 0 retried**. Zero rows sit in
failed extraction and no activations have been executed (every mechanism
ticket is record-only by governance), so the selected-retry path
correctly admits nothing today. All 130 items are listed with reasons —
none silently skipped:

| Cohort | Count | Reason |
|---|---|---|
| route_sources\|pending | 89 | `retry_ineligible_stage`: pre-extraction backlog queued behind operator activation → selected retry per domain |
| review_listings\|needs_input | 8 | in-review cohort, out of scope — reviewer action only |
| review_listings\|skipped | 5 | skipped cohort, out of scope — reviewer action only |
| create_drafts\|completed | 28 | completed cohort, out of scope — finished work |

Eligibility predicate (`sweepEligibility208`) follows the live
#198-hardened route (`src/server/routes/onboarding-routes.ts`):
workspace ownership (the route's bare 404, labeled `foreign_workspace`
at sweep level) → manual-evidence precedence (409, reusing the exact
route code `manual_evidence_active_retry_rejected`) → stage (400
`retry_ineligible_stage`) → status (400 `retry_ineligible_status`) →
URL-verdict holds from the mechanism modules
(`variant_resolution_required`, `unvalidated_url`, #204's verbatim
`wrong_product` for discontinued slugs — the route performs no
URL-verdict check, so those codes have no route counterpart by
design). An `eligible` result is necessary but NOT sufficient:
`getDomainReleaseHealth` is the final authority at release time.

Scope reconciliation (`SCOPE_RECONCILIATION_208`): the 89 pending rows
are the 86 #197-inventory items (34 #199 + 35 #207-as-written + 5 #204
+ 5 #205 + 7 #206, verified by live `brand_hint` distribution) plus 3
Kong rows — `kongcompany.com` already holds a production profile row,
so Kong sits outside the #197 mechanism scope and is held out with
that reason. Cohort granularity (4 cohorts with counts, not 130
per-item rows) is the record-only form: item IDs churn while the
sweep's claim — every item reason-coded, none silently skipped — holds
at the cohort level and re-verifies with one query.

## 3. Untouched verification (acceptance: completed / in-review / skipped verified untouched)

`verifyUntouched208` seam asserts the live observed counts 28 / 8 / 5
and fails loudly on any drift. Observed 2026-09-16: no drift — the
scale-up touched zero finished rows (no profile writes, no activations,
no item moves anywhere in #198–#207).

## 4. Operator runbook (what remains — all human-only)

1. **Per-field approval** in the Profile Builder per mechanism doc
   (#204 §5, #205 §5, #206 §5, #207 §5) — these records are the proposal
   evidence.
2. **Image-preview attestation** per domain, including the named review
   items (Bonide YouTube poster; Open Farm icons/posters/labels;
   Wondercide family rail + poster; Nylabone/Blue Buffalo gallery sets).
3. **Version activation**, then **selected retry** of failed-extraction
   items behind `getDomainReleaseHealth` (#198). Variant-blocked sizes
   wait for discriminating SKUs or operator selection; Bonide
   discontinued slugs never release.
4. **File three downstream static-validation tickets** (bil-jac,
   northstatesind, yeowww — operator owns filing; no existing owner).
5. **Distributor qualification FU-1/FU-4** (#200) before chickensouppets
   / multipet flow. Nutrisource releases on the canonical host per the
   #202 rule.

## Observed live state 2026-09-16 (read-only; recorded as evidence, not assumed)

Taken against `storage/catalog/.shopsite-cms/app.db` (`mode=ro`) while
writing this ticket — the re-verification queries below reproduce every row:

- `onboarding_items`: 130 rows, all status `imported` — 89
  route_sources|pending, 8 review_listings|needs_input, 5
  review_listings|skipped, 28 create_drafts|completed. Zero failed rows.
- `onboarding_review_state`: 51 approved, 2 reviewed-unapproved.
- `extractor_profiles`: 23 rows, none on any of the 14 close-out domains.

## Re-verification (read-only; re-run anytime)

```bash
DB="storage/catalog/.shopsite-cms/app.db"
sqlite3 "file:$DB?mode=ro" "SELECT stage, stage_status, COUNT(*) FROM onboarding_items GROUP BY stage, stage_status;"
# ^ must read: create_drafts|completed 28, review_listings|needs_input 8, review_listings|skipped 5, route_sources|pending 89
sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM onboarding_items WHERE stage_status='failed';"
# ^ must return 0 (zero eligible for selected retry)
sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM extractor_profiles WHERE domain IN ('bonide.com','nylabone.com','www.nylabone.com','bluebuffalo.com','www.bluebuffalo.com','discovernutrisource.com','openfarmpet.com','snifsnax.com','jollypets.com','wondercide.com','www.wondercide.com','horsemenspride.com','bil-jac.com','northstatesind.com','yeowww.com','chickensouppets.com','multipet.com');"
# ^ must return 0 (record-only: no live profile rows written by #204-#208)
npx vitest run src/tests/unit/retry-sweep-closeout-208.test.ts
```

## Acceptance mapping

- [x] Every eligible item retried through the selected-retry path;
  ineligible items listed with reasons, not silently skipped (§2: 0
  eligible / 0 retried honestly — zero failed rows exist — with all 130
  items reason-coded across 4 cohorts; route checks reuse the live
  route's exact codes, mechanism holds reuse the mechanism codes; the
  89−86 gap is reconciled as 3 out-of-scope Kong rows).
- [x] Per-domain record exists: mechanism, validation evidence,
  activation basis, cost (if any), failure codes seen (§1 +
  `DOMAIN_LEDGER_208`, 14/14 domains, 0 tokens total).
- [x] Previously completed / in-review / skipped items verified
  untouched (§3: 28/8/5 via the `verifyUntouched208` seam, no drift).
- [x] A short close-out note on the parent issue states what unblocked
  what, and what (if anything) remains (`CLOSEOUT_NOTE_208`, posted as a
  comment on #197; §4 lists the remaining operator work).
