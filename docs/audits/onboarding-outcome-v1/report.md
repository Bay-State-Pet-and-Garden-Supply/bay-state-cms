# Onboarding outcome comparison v1 — report

Status: **BLOCKED; NO QUALIFICATION OR IMPROVEMENT CLAIM**. A development dispatch attempt ran, but it stopped in Discovery and did not exercise TypeSafe or Serper acquisition. The old arm-level `COMPLETE` values mean neither successful preparation nor successful qualification.

## Pins and population

- Baseline: `91b52e9b489a7435d0a96e095da46952edac4cd7`; rationale and input commitments in `manifest.public.json`.
- Candidate comparison freeze: unset. The publication observation is not a frozen candidate.
- Manifest population: 337 original rows / 332 distinct SKUs; development 169 rows / 166 distinct, holdout 168 rows / 166 distinct. Stratum support remains insufficient; no fixture padding.
- Holdout predictions, source-derived labels, blinded review, and scoring are not complete. This investigation used development inputs only.

## Reconstructed development observations

Source run: `2026-10-22T14-38-23-226Z-47cea9e7-bd7a-47cf-bb4c-0243c2666c4c`.

| Observation | Baseline | Candidate |
|---|---:|---:|
| Original development rows | 169 | 169 |
| Imported distinct items | 166 | 166 |
| Duplicate input rows | 3 | 3 |
| Blocked items | 166 | 166 |
| Missing row mappings | 0 | 0 |
| Discovery candidates | 331 | 331 |
| Selected sources | 0 | 0 |
| No domain setup | 51 | 51 |
| No candidates | 60 | 60 |
| Variant choice required | 31 | 31 |
| Source confirmation required | 24 | 24 |
| Recorded model calls | 0 | 0 |

Candidate acquisition reservations: zero. Baseline predates that ledger. These are local recorded-activity counts, not external billing receipts or independently reviewed correctness metrics.

Reconstruction is under private `diagnostics/2026-10-22T15-07-19-679Z/{baseline,candidate}/reconstructed.json` and `summary.json`. It joined the current hash-verified development manifest to copies of the completed arm databases. Original raw JSON and database/WAL/SHM hashes were checked unchanged after reconstruction. Missing original per-row output cannot be repaired into a frozen equal-input execution receipt; reconstruction is not a rerun.

## Dispatch diagnosis

1. Every imported item remained in Discovery; 135 had stage status `completed`, 31 `needs_input`. The old executor incorrectly treated both as successful end-to-end completion and matched duplicate rows to the same item repeatedly.
2. Automatic source confirmation requires strong exact structured/variant GTIN proof plus mapped-domain authority (`src/onboarding/job-queue.ts`, Discovery auto-selection). None of the persisted candidates was selected.
3. Extraction's `identity_bootstrap` path requires a confirmed official source and returns to its dedicated branch before supplemental search. **That bootstrap does not call Serper.** Serper is a later Curation supplemental-acquisition fallback for supported checklist gaps with no selected approved source, subject to TypeSafe policy, cloud-sharing, authority, pricing, and budget gates.
4. Both disposable workspaces lacked classification configuration; direct policy snapshots returned `disabled`. A present credential does not provide model policy, runtime activation evidence, or an acquisition pricing policy.
5. The previous `$1` argument was an estimate cutoff, not a whole-run pre-dispatch cap. Its cost capture read only `ai_model_calls`, not all discovery/classification ledgers, and called estimates observed spend. No billed-cost conclusion follows.
6. First-token brand hints and `/tmp/brand_domains.json` were inferred setup, not a verified operator-approved authority snapshot. They are not qualification evidence and are no longer synthesized by the executor.

## Harness corrections and verification

`scratch/run-comparison.ts` now writes per-row dispositions and blockers, accounts for duplicate UPCs once, and refuses live dispatch while whole-run budget enforcement, frozen equal-input runtime configuration, and complete metric capture are unavailable. It no longer copies production credentials or manufactures brand-domain configuration.

`--mode mechanism-check --max-spend-usd 0` invokes the real importer and worker poll/drain with items held in a paused batch. Both arms passed in run `2026-10-22T15-07-19-566Z-59ec1864-b869-416b-a339-a5a91bdb767c`. Positive-cap preflight also refused dispatch for both 169-row arms in run `2026-10-22T15-08-09-255Z-f3dd1248-9ccd-493d-87bb-a614a5e099dd`; each report accounts for 166 blocked items and three duplicate rows.

Focused TypeScript compilation passed. `bunx vitest run src/tests/unit/onboarding-outcome-report.test.ts`: six tests passed. Regression coverage includes review-blocked stage completion, duplicate attribution, missing output, selected-source progression, and failure with unchanged legacy status. These checks validate reporting and refusal, not paid dispatch, full-suite health, or qualification.

## Remaining prerequisites

- Freeze and install comparable, verified catalog/configuration, model/connection/sharing policy, acquisition pricing/budgets, and source-response evidence in both arms.
- Enforce a whole-run ceiling before every provider effect, including Discovery and Curation; do not equate a per-item acquisition budget or row estimate with the CLI cap.
- Capture and reconcile all provider ledgers, row outcomes, checklist/claim/review evidence, and shared calls; complete real source review without invented confirmations.
- Complete development fitting, candidate freeze, sealed holdout capture/review/scoring, required capability receipts and authorized canary execution before merge/activation.

Applicable blockers remain those in `manifest.public.json`. No provider work was launched by the correction smokes. Production workspace/store state and original run evidence were not mutated.

## Test runner integration

The runner-coverage check exposed ten expansion suites missing both their Vitest exclusions and Bun registration. `package.json` now invokes each in an isolated Bun process; `vitest.config.ts` explicitly excludes them from Node/Vitest collection. No baseline exceptions were added.

All ten suites passed in isolation: 49 tests, zero failures. `bun scripts/check-test-runner-coverage.ts` passed with zero new violations; its 24 documented baseline entries are unchanged. This does not claim the full suite passed.

Candidate-only refusal run `2026-10-22T15-10-54-841Z-28098b05-f27c-4e89-8678-8358e47a2fcc` exercised exit code 2. Read-only SQL confirmed all imported items remained held/pending, with zero sources, model-call rows across all four ledgers, and acquisition reservations.


## Recovery implementation (R1–R4 foundations, R2–R4 product path)

Status: IMPLEMENTED IN WORKING TREE, UNCOMMITTED. No qualification claim; live spend remains blocked and no holdout data was read.

Foundations: versioned discovery-assessment contracts with guarded run persistence; validated qualification runtime freeze with split-before-open input isolation; atomic cumulative microUSD budget ledger with multi-child coordinator; offline development diagnostics sampler; published TypeSafe/Serper billing evidence (live pilot stays BLOCKED for lack of enforceable charge bounds). Foundation verification: 29/29 Bun tests green; foundation tsc clean.

R2 retrieval: UPC/SKU/high-confidence short-circuits removed; approved domains frozen once per run and threaded through index, sitemap, fetch, and verification; full candidate count passed to verification; price removed from all matching paths (ADR 0043).

R3 confirmation: observed H1 heading/brand/canonical-variant evidence wired to the existing conservative matcher; selected-variant contradiction guard; automatic_name only for exact no-GTIN matches; single append-only decision transaction with owner/run/revision/authority binding; success emitted only after commit; prewrites removed; page-observed-only index enrichment. Verification: 44/44 across sitemap-selection-workflow, page-verifier, brand-authority-gate, discovery-run-trace (bun) plus official-page-identity (vitest); tsc clean on R3 files.

R4 extraction: durable official-decision binding required for advancement (distributor route keeps its own binding); confirmed-page static extraction via profile-optional parser before model/browser; worker page prices stripped and raw price signals removed per ADR 0043; invalid profiles never treated as healthy. Verification: 21/21 ladder tests green; combined R-slice suites 56/56 green in the phase gate run.

Multifile Bun runs show cross-file interference (kill-switch env leakage, worker DB singletons); each failing suite passes in isolation. Pre-existing errors untouched: extraction-identity-worker (4/5 fail identically without R3), job-queue sourcing/materialization shapes, page-extractor ProfileRunnerResult narrowing, storefront-family, drift-backfill, and stable-id tsc errors.

Remaining: R5 isolated arm execution, R6 transport hookup, R7 evaluator capture, R8 diagnostic pilot — all still blocked on approved runtime export, enforceable billing bounds, source review, and candidate freeze.

## R8 predeclared diagnostic pilot subset (committed before outputs)

Source: completed development attempt `2026-10-22T14-38-23-226Z-47cea9e7-bd7a-47cf-bb4c-0243c2666c4c`; row IDs from the hash-verified development manifest. Stable row-ID hash order within each bucket selected the first-listed row per bucket plus a second different-domain row where supported. No holdout data was read. Sole-operator source review/adjudication remains pending; no planner/agent output adjudicates truth.

| Bucket | Row ID | UPC | Register name | Expectation basis |
|---|---|---|---|---|
| no_domain | DEV-0027 | 627987481006 | BUTCHERS PUP FRZN DINNER CHKN 6LB | Unmapped brand stays `BLOCKED_DOMAIN_SETUP`; no inferred domain. |
| no_domain | DEV-0029 | (second unmapped brand, TBD at execution) | — | Same refusal; different domain proves no single-brand special case. |
| no_candidates | DEV-0015 | 860012493753 | WOOF PUPSICLE LAVENDER XL | R2/R3 positive control candidate: mapped domain, page expected retrievable; confirm or record verified miss. |
| no_candidates | DEV-0039 | 073893179238 | PURE VITA BEEF/KALE 12LB | Mapped domain; confirm or record verified miss. |
| ambiguous | DEV-0014 | 860012493746 | WOOF PUPSICLE LAVENDER LG | Near-neighbor variant must remain unresolved without explicit choice. |
| ambiguous | DEV-0019 | 810054211679 | BENEBONE GREEN FISHBONE SALMON SM | Same; different brand. |
| confirmation | DEV-0001 | 035585357409 | KONG CLASSIC GOLD LG | No candidates in old run; mapped domain (kongcompany.com); retrieval-miss vs setup diagnosis target. |
| confirmation | DEV-0002 | 035585357423 | KONG CLASSIC GOLD SM | Companion size; tests variant discrimination. |

Max 8 rows. DEV-0029 resolves at execution to the lowest-hash unmapped-brand row outside BUTCHERS; BUTCHERS duplicates do not count as the second domain. If any listed row lacks support at execution, it is reported as absent support — never substituted after outputs.

Stop rules: unknown/unbounded charge, missing authority/sharing, incomplete coverage, lost ownership, ungoverned effects, unsafe browser behavior, forbidden approvals/store effects, deadline/no-progress, or budget exhaustion all halt the pilot; untouched rows terminalize as blocked. One combined $3 ceiling across both arms, retries, preparation, and paid smokes; no top-ups. Live TypeSafe calls stay refused (no enforceable charge bound evidenced); Serper + browser paths run under the cumulative budget owner.

## R8 source-reviewed gold verdicts (sealed 2026-10-22, sole operator)

Reviewer: sole operator. No planner/agent output adjudicates truth. Verdicts reference retained run diagnostics plus operator knowledge; missing page bytes are marked unavailable, never inferred.

| Row | UPC | Verdict | Basis |
|---|---|---|---|
| DEV-0027 | 627987481006 | blocked_unresolvable_official | Brand = Butcher Pup; no proper manufacturer product pages; needs distributors. |
| DEV-0041 | 780824103001 | blocked_unresolvable_official | "SLOW" is not the brand (register omits it); true item = OurPets DuraPet Slow Feed Bowl SM; official-domain impossible, 3rd-party only. Brand discovery needs web search or manual entry. |
| DEV-0015 | 860012493753 | confirm_variant | mywoof.com approved; UPC on candidate 1 (`products/pupsicle`), exact variant `?variant=42864285057220` selected manually; variant logic to verify live. |
| DEV-0039 | 073893179238 | wrong_brand | NOT PURE VITA — NutriSource beef-kale entrée (discovernutrisource.com URL supplied); all purebites.com candidates wrong site. First-token hint misattributed. |
| DEV-0014 | 860012493746 | confirm_variant | Lavender/Large `?variant=42864284991684`; other emitted candidates incorrect variants. |
| DEV-0019 | 810054211679 | confirm_variant | benebone.com approved; Green Fishbone Small `?variant=44092915253347`. |
| DEV-0001 | 035585357409 | discontinued_unlisted | KONG domain approved; Classic Gold LG was limited release, no longer listed; impossible to find. |
| DEV-0002 | 035585357423 | discontinued_unlisted | Same deal, SM companion. |

Implications recorded: distributor route required (DEV-0027); brand-discovery gap for truncated hints (DEV-0041); first-token hint misattribution (DEV-0039); no-GTIN variant resolution is the live capability under test (DEV-0015/0014/0019); discontinued rows must remain explicitly unresolved, never forced (DEV-0001/0002).

## R8 live smoke v1 — BLOCKED on baseline/candidate comparability

The 1-row DEV-0015 smoke reached the arm DBs but preflight honestly refused both arms: frozen runtime records use the candidate's newer `extractor_profiles` columns (profile_type, runtime, variant-selection metadata; +627 lines of profile migrations since baseline pin `91b52e9b`), which the baseline migration chain cannot create. Forcing the candidate schema onto the baseline arm would silently advance the incumbent and invalidate the comparison; skipping those records would run the arms on different profile authority.

Per the build contract this is `BLOCKED_COMPARABILITY`, not a product bug to patch around. Options: (a) rebase the comparison so both arms share the profile schema (e.g. candidate-backported baseline overlay, explicitly disclosed); (b) narrow the live pilot to profile-independent rows (DEV-0001/0002 discontinued pair excluded — they need no profile — but they also need no live work); (c) accept that live comparison requires the candidate's schema and compare candidate-vs-candidate runs for mechanism proof only, with no baseline efficacy claim.

No live provider call has been made; $3 ceiling untouched. The refusal above is the fail-closed system working as designed.

## T1 — DEV-0015 policy disposition (2026-10-23, operator-held retained)

Policy decision D1 resolved per planner recommendation: **retain operator-held behavior**. A barcode match corroborates identity but does not defeat conflicting visible product/variant evidence (ADR 0040 name-first; ADR 0017 authority independent).

DEV-0015 diagnostic closeout (run `2026-10-23T01-33-44-510Z-9b3bd474-6bca-4f44-a06c-c1a9fb572716`, candidate arm, `--row-id DEV-0015`, $0 spend — no Serper/browser dispatched):

| Gate | Result |
|---|---|
| Authority `mywoof.com` | PASS (mapped official domain) |
| Coverage | PASS |
| Proof | `exact_variant_gtin`, score 237 |
| Matcher | BLOCKED `reject_conflict(product_line_mismatch)` |
| Contradiction | BLOCKED page `sm`/`lg` vs register `XL` |
| Auto-select commit | none — parked `needs_input_candidates` |
| Gold | `confirm_variant ?variant=42864285057220` (manual) |

Closure: diagnosis complete. The park is correct policy behavior, not an engine bug. A lone `exact_variant_gtin` does not override matcher + contradiction under current policy. No broad `hasStrongProof` bypass; any narrow GTIN-override variant requires separate D1 re-approval + ADR 0040 amendment (planner T6, omitted). Manual-resolution journey still unproven — planner T5 must exercise `confirmOfficialPageCandidate` + `selectVariantService` before claiming operator escape works.

Budget position at T1: operator reports **$3.30 TypeSafe allowance** and **2,499 Serper credits**. Remaining pilot allowance = $3.30 minus any prior TypeSafe liabilities (none recorded — no TypeSafe calls dispatched to date) for TypeSafe-gated paths; Serper paths draw from the 2,499-credit pool, not the dollar cap. Enforceable shared-budget coordination still missing (planner T4) — no paid dispatch until wired.

## T4 — Budget enforcement scope finding (2026-10-23, no code change)

T4 investigation finds the planner's "CLI cap is not enforcement" framing is directionally right but misattributed. The actual enforcement stack, verified by reading code (not by dispatch):

- `scratch/run-comparison.ts:56` clamps `--max-spend-usd` to 0–3 and `comparison-arm.ts:95` releases arms only when `cap > 0 && mode === 'comparison'` — a release gate, not an accounting ledger.
- Real per-physical-attempt accounting exists one layer down: `runPaidEffect` (`src/ai/paid-effect-budget.ts:404`) reserves + marks + settles every Serper POST / browser session / model call against `PaidEffectBudgetCoordinator`, with `withQualificationPaidEffectScope` binding run/arm/output/beneficiaries.
- The break is at the runner: `comparison-arm.ts:112-137 runBoundedWorker` constructs a bare `new OnboardingWorker(...)` with **no qualification scope, no coordinator client, no Serper/browser billing contracts, no budget snapshot passed to `captureComparisonArm`** (`run-comparison.ts:193-197` passes no `budgetSnapshot`). So `runPaidEffect` falls through to its no-scope pass-through (`paid-effect-budget.ts:411-420`: "absent qualification scope preserves ordinary production behavior") — Serper would POST with only the item-acquisition ledger as guard, and capture records `budget_snapshot_not_supplied`.
- TypeSafe model calls are separately hard-refused: `src/ai/systemone-transport.ts` denies model-priced acquisition with `budget_not_enforceable typesafe_output_token_limit` before fetch. That refusal is the enforceable bound for TypeSafe paths.
- Serper has no equivalent refusal: unit-price evidence ($1.00/1k advertised, 2,499 credits operator-reported) exists, but there is no verified per-request maximum × outstanding-liability bound wired into the runner, and browser-session charge semantics are unverified.

Decision (no paid dispatch yet): with $3.30 TypeSafe allowance and 2,499 Serper credits reported, T4's remaining work is (a) thread a funded authorization + coordinator + scope into `runBoundedWorker` before any live release, (b) capture the real budget snapshot into the bundle, (c) keep TypeSafe refused until its output-token bound is evidenced, (d) treat Serper as priced-but-unbounded until its per-request maximum and retry/in-flight semantics are contract-pinned. T4 stays open pending that wiring + tests; T8 single-row smokes stay blocked until T4 closes. No code changed in this entry — finding only.

## T5 — Manual confirm boundary (2026-10-23, offline evidence)

T5 asks whether the DEV-0015 operator gold (`confirm_variant ?variant=42864285057220`) is an executable escape path or a held verdict with no working journey. Offline evidence from current code + existing suites:

- `confirmOfficialPageCandidate` (`src/onboarding/official-page-confirmation.ts:109-153`) re-verifies the fetched page through the same matcher + contradiction guards as the worker. A DEV-0015-shaped page (heading `Pupsicle` → `reject_conflict(product_line_mismatch)`; variants `sm`/`lg` vs register `XL` → `findContradictoryProductAxes` non-empty) refuses with `identity_conflict` **even with `attestedProductAndVariant: true`** — attestation only rescues `needs_operator`, never `reject_conflict` or axis conflicts (`:135-148`).
- The `sitemap-selection-workflow` suite already proves this boundary: `refuses contradictory GTIN, wrong variant, variant conflict...` (`src/tests/unit/sitemap-selection-workflow.test.ts:578-604`) and `manual attestation still confirms a needs-operator name match` (`:626-644`) — attestation rescues weak-name, not conflict.
- The variant path (`selectVariantService`, `src/onboarding/variant-selection-service.ts:16-159`) operates on a variant-resolution matrix (`ambiguous`/`no_match`/etc.), not on raw contradiction evidence. There is no existing test proving a `reject_conflict` + contradiction page flows through variant-select → confirm → extraction with the gold variant key bound.

Conclusion: under current policy the operator-held outcome for DEV-0015 is a **held verdict, not a proven manual journey**. The gold names the right variant, but no offline evidence shows `?variant=42864285057220` surviving confirm + extraction revalidation today — confirm would refuse at `:129-137` before any variant key binds. This does not invalidate the operator-held policy; it bounds the claim: "diagnosis complete, parked correctly" is proven, "operator can complete it manually" is not. Proving the journey requires a disposable-workspace exercise with a controlled mywoof-shaped artifact through variant-select → confirm → extraction, or an explicit finding that selected-variant contradiction stays held by design. T5 stays open pending that exercise; DEV-0015 closure (T1) does not depend on it.
