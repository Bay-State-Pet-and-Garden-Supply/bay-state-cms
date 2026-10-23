# Development brand × index-coverage (zero-spend)

Status: **read-only mapping report; no execution authorized or performed**. Population is the committed development split only (169 rows). This report answers whether rows have an operator-attested brand hint, whether the brand maps to an official domain, and whether that domain has indexed pages available for later search. It is not a product-identity judgment or qualification result.

## Method and accounting

The development input is `.baystate-cms/qualification/onboarding-outcome-v1/inputs/development-input.json` (169 source rows). Brand truth is restricted to the six explicit entries in `ATTESTED_BRAND_HINTS` in `scratch/run-comparison.ts`; no register-name token inference was used. These are runner hints, not a claim that every product identity is correct. The input includes repeated UPCs; the runner population de-duplicates UPCs, keeping the first source row. Therefore the row-level recommendation below is a candidate *source-row slice*; the execution code's unique-UPC behavior may reduce actual imported items.

Read-only index coverage from the sibling coverage analysis uses active `brand_url_index` row counts. Sitemap cache/profile status is reported separately and does not gate a row when indexed pages exist. All four domains mapped by the attested hints had nonempty indexes.

| Disposition | Rows | Count |
|---|---|---:|
| Attested brand with mapped domain and nonempty index (runnable slice) | DEV-0001, DEV-0002, DEV-0005, DEV-0014, DEV-0015, DEV-0019 | 6 |
| Attested/mapped brand but empty index (park for empty index) | — | 0 |
| No operator-attested brand hint (unattested; do not map by guessing) | all other development rows, excluding explicit negative cases below | 160 |
| Explicit wrong-brand/no-domain negatives | DEV-0027, DEV-0039, DEV-0041 | 3 |
| **Total** | | **169** |

The three negatives are intentionally unhinted. DEV-0039 is the known counterexample: register text beginning “PURE” does not establish the brand (the attested precedent identifies NutriSource). These rows must not be assigned a guessed brand/domain. Counts are mutually exclusive and reconcile to all 169 source rows.

## Runnable row-level slice

“Index depth” is active indexed URL count for the mapped domain, not a claim that any particular URL is relevant to the listed product. `sitemap` describes cache freshness; `profile` records extractor-profile availability from the coverage analysis.

| row_id | UPC | Attested brand | Official mapped domain | Active index depth | Sitemap cache | Profile | Recommendation |
|---|---|---|---|---:|---|---|---|
| DEV-0001 | 035585357409 | KONG | kongcompany.com | 508 | stale | present | Run: mapped; nonempty index |
| DEV-0002 | 035585357423 | KONG | kongcompany.com | 508 | stale | present | Run: mapped; nonempty index |
| DEV-0005 | 850068229253 | DR MARTY | drmartypets.com | 227 | none | present | Run: mapped; nonempty index |
| DEV-0014 | 860012493746 | WOOF | mywoof.com | 2,141 | stale | present | Run: mapped; nonempty index |
| DEV-0015 | 860012493753 | WOOF | mywoof.com | 2,141 | stale | present | Run: mapped; nonempty index |
| DEV-0019 | 810054211679 | BENEBONE | benebone.com | 157 | none | absent | Run: mapped; nonempty index; profile absence is not an index absence |

**Recommendation: exact row IDs to use as the mapped-brand slice:** `DEV-0001`, `DEV-0002`, `DEV-0005`, `DEV-0014`, `DEV-0015`, `DEV-0019`. All have explicit operator-attested hints, a brand-to-domain mapping, and nonzero index coverage. No row parks for an empty index. This recommendation is about searchability only; it does not certify product correctness or authorize dispatch.

## Parks and exclusions

- **Empty-index parks:** none among the six attested/mapped rows; all mapped domains have active index entries.
- **Unattested rows:** 160 development rows other than the six attested rows and three explicit negatives. Keep brand/domain unset; do not infer from first token or other name fragments. They are not recommended for this mapped-brand slice.
- **Wrong-brand/no-domain negatives:** `DEV-0027`, `DEV-0039`, `DEV-0041`; unhinted by design, no brand/domain mapping. Retain as negative controls, not runnable brand-mapped rows.
- Duplicate UPCs occur in the development source: `035585357409` (DEV-0001 kept; DEV-0003 dropped), `035585357423` (DEV-0002 kept; DEV-0004 dropped), and `035585357416` (DEV-0035 kept; DEV-0036 dropped). The latter three rows are among the unattested count of 160; they are still source rows and are not additional unique imported items. Recommendation IDs refer to source rows; the existing runner de-duplicates UPCs and keeps the earliest encountered row.

## Clean 6-row slice receipt (2026-10-23, reviewer-approved slice executed)

All six approved rows run singly under the $3 cap, candidate arm. Variance scare investigated and cleared: per-run `outcome_message` + source counts match earlier receipts exactly; the summary-table collapse of `gate_blocks` without reason text had hidden distinct honest outcomes.

| Row | Run outcome | Sources | Report gates | Gold |
|---|---|---:|---|---|
| DEV-0001 KONG LG | `needs_input_candidates`, `proof=none / no_structured_gtin_found` | 2 | `BLOCKED_SOURCE_REVIEW` | `discontinued_unlisted` — found but unverifiable, unforced |
| DEV-0002 KONG SM | same | 2 | same | same |
| DEV-0005 DR MARTY | `needs_input_no_candidates`, `No matching product pages found` | 0 | `BLOCKED_SOURCE_REVIEW` | runnable-brand miss — nothing found, nothing claimed |
| DEV-0014 WOOF LG | `needs_input_ambiguous` | 18 | `BLOCKED_SOURCE_REVIEW` | `confirm_variant 42864284991684` — held, no accidental XL |
| DEV-0015 WOOF XL | `needs_input_candidates`, `exact_variant_gtin` + matcher/contradiction BLOCKED | 15 | + `BLOCKED_IDENTITY_MATCHER` + `BLOCKED_IDENTITY_CONTRADICTION` | `confirm_variant 42864285057220` — correct park |
| DEV-0019 BENEBONE SM | `needs_input_ambiguous` | 18 | `BLOCKED_SOURCE_REVIEW` | `confirm_variant 44092915293347` |

Spend: $0 / 0 credits on all six (all park on sitemap-local evidence before paid dispatch; ledgers attest). Session total remains ~2 Serper credits (key check + standalone paid proof).

## Explicit non-goals and safety boundary

- No invented brand hints, first-token guessing, or inferred domain mappings.
- No holdout file access or holdout identities.
- No live dispatch, Serper/browser/TypeSafe calls, credential use, or paid calls; zero spend.
- No production writes; production database access for coverage was read-only.
- No claim of successful extraction, relevant-page coverage, item identity, or qualification. Index depth is only a count of active indexed URLs.
