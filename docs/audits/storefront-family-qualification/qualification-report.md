# Storefront-family qualification report (issue #376) — OFFLINE, ACTIVATION OFF

Status: **BLOCKED — activation OFF.** No live evidence exists. No paid calls made. No store writes performed. This report is the qualification record; it does not authorize activation.

## 1. What was built

- **Dev corpus (frozen):** `src/tests/fixtures/storefront-family-qualification/dev-corpus.json` — 17 rows, 5 distinct families (`fam-dev-01/06/09/11/14`), sha256 `9424e0d3b3c6c23ea7a657c0d62a07386afdce172ec771467db5213be0f2a943`. Covers: same-product 3-size accept (dev-01), flavor conflict (dev-02), species conflict (dev-03), missing invariant held (dev-04), undeclared pack held (dev-05), same-SKU ambiguity → identity resolution (dev-06), competing families ambiguous (dev-07), transitive bridge with below-floor abstention (dev-08), non-food permitted size accept (dev-09), non-food material conflict (dev-10), catalog join preserving existing main (dev-11), native accessory preserved/refused (dev-12), native nested unsupported (dev-13), duplicate tuple + duplicate PF7 block (dev-14), genuine stem-only pair dropped by discovery (dev-15), transport refusal/null-policy disablement (dev-16), synthetic-sample native posture (dev-17: XYZ-789 from the synthetic `shopsite-products-sample.xml` fixture — NOT a real store export; no real redacted store-family export has been inspected by this ticket). Refrozen 2026-10-19: dev-15 corrected to a genuine stem-only pair (dropped outright, recorded signals `[]`); dev-17 native order corrected to true fixture document order; anchor accounting corrected to 8 total (5 join + 3 membership). Holdout sealed and untouched.
- **Sealed holdout (frozen, NOT run):** `src/tests/fixtures/storefront-family-qualification/holdout-corpus.json` — 17 rows, 5 distinct families (`fam-hold-01/06/09/11/14`), zero family overlap vs dev and zero SKU overlap vs dev, sha256 `c3cf1869dec7743ff56c26cee1565f07968aa2032860f09ef0fa6c50c2d5033e`. Mirrors every dev category with a disjoint brand/recipe/type authority (`Beacon/Harvest`, `type-dogfood-v7`, `Northfield/Den Bed`, `type-bed-v4`).
- **Task policy (fitted on dev, published before sealed holdout evaluation):** `docs/audits/storefront-family-qualification/task-policy.json` — records `fitExecutedAt`, an explicit fit-then-freeze note (dev was executed through the pure functions BEFORE freezing; dev-05's retailUnit and dev-14's PF7 pair were narrowed during fitting, then re-frozen/re-hashed), and `frozenRecordedAt` binding the frozen bytes; `publishedBeforeHoldoutInspection` attests the holdout seal ordering (dev fit + policy publish before any holdout-corpus content was executed or fitted — holdout `expect` golds are never run through rule/membership functions; the seal check itself reads holdout `candidateTitles` only for the family/SKU-disjointness and title-similarity ceiling, never for fitting), not freeze-before-first-run. Binds rule versions (`food-family-variant-rule-v1`, `non-food-size-family-variant-rule-v1`, `non-food-color-family-variant-rule-v1`), model pin (`jev-1.13.0`), operation (`family_membership_proposal`), prompt (`family-membership-proposal-prompt-v1`), selection floor (0.50), reviewed type/catalog/evidence authority. `frozenCommit` is `untracked-working-tree` (no commit exists to bind) — honest for this offline record; the live run MUST re-pin to a real commit.
- **Eval harness (regression test):** `src/tests/unit/storefront-family-qualification.test.ts` — runs the frozen dev corpus through the REAL pure functions (`evaluateFamilyVariantRule`, `evaluateNonFoodFamilyVariantRule`, `nominateFamilyMain`, `nominateNonFoodFamilyMain`, `derivePf7ShortNames`, `deriveNonFoodPf7ShortNames`, `validateFamilyTitleSet`, `freezeProposalAnchors`, `interpretAnchorChoice`, `resolveProposalDisposition`, `checkTransitiveSafety`, `discoverJoinCandidates`, `resolveJoinCandidates`, `classifySubproductsSupport`, `classifyNativeAdoption`, `setManagedSubproducts`, `buildManagedSubproductsXml`, `validateStorefrontFamilyGroup`, `validateNonFoodFamilyGroup`, `classifyClassifierFamilyWrite`, `planFamilyPushSet`, `assessFamilyPushReadiness`, `reconcileFamilyPushImport`, `checkFamilyPushStalenessFiles`, `ShopSiteProductCodec.decode/encodeMany`, `proposeFamilyMembership` with null policy, `assertConnectionEnabledForDispatch`) with zero transport/DB/credentials, and asserts the fixed-population accounting below, the holdout-sealed invariant (family-disjoint, SKU-disjoint, Jaccard title-similarity ceiling < 0.80), the offline dispatch-refusal gates, and sha256 corpus pins. `bun test src/tests/unit/storefront-family-qualification.test.ts` → 9 pass, 0 fail (orchestrator verifies at phase end; not run by this ticket per contract).

## 2. Offline results (pure deterministic functions + stubbed transport mechanics — MECHANICS, not model quality)

Fixed population n=17, 8 anchors (5 join + 3 membership), zero harness failures/errors:

| Slice | Result |
|---|---|
| Food rule: accepted (of 5 food rows) | 1/5 (dev-01 three sizes) |
| Food rule: refused with exact code (of 5) | 4/5 (flavor conflict, species conflict, missing invariant, undeclared pack) |
| Main nomination: smallest verified comparable real member | dev-01 → D1-5; join row → existing E-5 preserved |
| PF7: deterministic unique labels across whole family | dev-01: `5 lb (80 oz)` / `15 lb (240 oz)` / `30 lb (480 oz)` |
| Title consistency: accepted family passes T2–T6 | dev-01 valid |
| Non-food: permitted size accept / material conflict refuse | 1/1 accept (dev-09), 1/1 refuse (dev-10) |
| Join: same-SKU → identity resolution (never merge) | dev-06: `DUP-5` flagged, `identity/duplicate resolution` reason |
| Join: competing families ambiguous (never auto-merge/reparent) | dev-07: ambiguous, explicit-resolution reason |
| Join: stem-only never qualifies | dev-15: zero discovery candidates (stem-only anchors dropped outright); recorded `signals: []` |
| Membership: positives / below-floor abstention / conflicts | 2 selected (D8-A, D8-B), 1 insufficient (D8-C, P 0.30 < 0.50 floor), conflicts=true |
| Membership: transitive bridge refused | A~B + B~C with flavor disagreement → unsafe |
| Membership: out-of-set Choice fails closed | `service`, verdict null, never coerced |
| Membership: freeze bound enforced | 17 anchors throws `overflow` (never clips) |
| Native: accessory preserved (refused_accessory, unmanaged posture) | dev-12 + synthetic-sample XYZ-789 posture (NOT a real export) |
| Native: nested unsupported (refused_unsupported, no data loss) | dev-13 |
| Native: main self-inclusion on managed side; explicit clear; order preserved | exercised via setManagedSubproducts / clearSubproductsBlock / buildManagedSubproductsXml; synthetic XYZ-789 fixture document order is RED-then-BLUE |
| Group: duplicate tuple + duplicate PF7 block | dev-14: `FAMILY_DUPLICATE_SIZE` + `FAMILY_PF7_DUPLICATE` |
| Classifier/PF7/native ownership: protected writes refused | PF7 + Subproducts `protected_target_refused`; unrelated PF16 passes |
| Push: whole-group plan + complete XML + staleness refusal + partial recovery | 3/3 planned; partial set refuses encode; edited member refuses staleness; skipped D1-30 → `NOT reconciled`; full set reconciles `ok` |
| Transport mechanics: null policy → disabled, zero call ids; disabled connection refuses | dev-16 both; no TypeSafe route, no chat fallback |
| Paid calls / store writes | 0 / 0 |

What this proves: the deterministic rules hold on the FULL fixed population including failures/abstentions/refusals (not a selected answered overlap); corrections flip blocked→passed shape; sibling facts never inherit; provenance is truthful. What it does NOT prove: typed-selection quality (dev-08's positives were corpus-recorded answers, never a live Choice); end-to-end latency; operator time. Deterministic grouping is NOT marketed as a cost saving — family matching is new inference, and live Choice calls WILL cost per ambiguous anchor.

## 3. Cost / latency / operator-effort methodology (honest unknowns)

- **Offline mechanics:** 17 rows, 8 anchors (5 join + 3 membership), ~ms wall (in-process pure functions, no network). This is a harness smoke number, NOT a latency claim.
- **Deterministic-skip rate (measured, offline):** all 17 rows settle through pure gates with zero paid calls (100% of the dev fixed population). The live skip rate (typed-Choice calls avoided per real item) is UNKNOWN until the live run — dev-08-class ambiguity WILL cost one Choice call per anchor (up to 16 per item, then overflow abstains).
- **Real-transport cost/latency:** UNKNOWN. No live call was made (no credentials, no paid calls permitted). Until a live run records per-row `latencyMs`/`input_tokens`/`output_tokens` plus retry counts, cost = unknown (never zero), end-to-end Curation P50/P95 = unmeasured with n=0. Candidate counts (≤16 anchors/item) and pair counts (one Choice per anchor) are bounded by the freeze, not measured.
- **Operator effort (review/edit/resolution time):** UNMEASURED. Requires the reviewed canary (§4): new imported size → reviewed join → accept → durable approval → complete-group export → actual native import/finalization/linking/publish → storefront purchasability inspection, with real timing and deterministic/reuse-call skip denominators.
- **Unknowns register:** live Choice P distribution and calibration for membership selection; same-SKU vs permitted-family judgment accuracy; verifier/operator-verification pass rates; end-to-end minutes per approved family; token/retry spend; cohort lease/crash/replay behavior under load; live census fetch latency.

## 4. Canary plan (specified — NOT executed, NOT authorized by this ticket)

A separately authorized store-compatible canary, fully reviewed, operator-owned:

1. **Scope:** add ONE new imported size (e.g. a 30 lb SKU) to ONE existing approved-catalog family (2 existing members with an established main, e.g. the dev-11 shape: existing `E-5` main + `E-15` member + new `E-30` import).
2. **Preservation:** existing main (`E-5`), member order, PF7 labels, full names/SKUs, prices/stock/images/evidence/classification, filenames, enablement state — all preserved verbatim unless an explicit reviewed diff authorizes the exact change. New product stays disabled until the operator enables it through existing controls; the CMS family feature never auto-enables products.
3. **Rules exercised:** new real-member nomination (smallest verified comparable size as reviewable default, operator may revise to another real member); a permitted non-food variant rule on a second family (size-only, e.g. dev-09 shape); negative recipe/flavor/species/life-stage/form/material cases reviewed and refused (dev-02/03/10 shapes).
4. **Native proof:** actual redacted store-family export inspected BEFORE authoring (references, main-to-self, metadata, document order, clear semantics) — REQUIRED here in the live gate; this ticket proves only the synthetic-sample XYZ-789 posture offline and NO real export has been inspected; after approval, actual native import/finalization/linking/publish with complete-group XML; truthful partial/unknown recovery (never a parent-only partial family, no duplicate identities/commits, no unrelated staged changes, no false synced status).
5. **Storefront proof:** inspect the actual storefront/test-store surface and verify EVERY expected canary size including the main is represented and purchasable under the template, with unambiguous labels and preserved unrelated data. Any required canary enablement is separately authorized/operator-owned.
6. **Review proof:** actual family Review showing accept/revise/reject/defer, stale conflict/input retention, direct push/export blockers, manual/standalone continuation; rule/evidence/main/member/label/catalog/draft/drift/model-policy changes stale review.

No canary step was executed by this ticket (no credentials, no store access).

## 5. BLOCKED live gate (exact remaining work — activation stays OFF until all clear)

1. **Live Choice run** on dev AND sealed holdout with real TypeSafe credentials: membership Choice dispatches (dev-08 class: positives, below-floor abstentions, same-SKU signals) with P calibration, plus competing-family and transitive-bridge rows through the real route. Records real latency/tokens/retries, judgment-vs-gold quality, group precision/recall, harmful merges vs harmless splits. Re-pin `frozenCommit` (currently `untracked-working-tree`, no commit to bind) to the real live-run commit.
2. **Reviewed canary** per §4 through actual native import/finalization/linking/publish and storefront purchasability inspection, with retained run/source evidence and attributed operator decisions (synthetic source-less success does not count). Includes the FIRST real redacted store-family export inspection (no real export inspected by this ticket).
3. **Routing / data-sharing approval:** explicitly approve the evaluated pin (`jev-1.13.0`), the `family_membership_proposal` operation routing, the frozen task policy, and the actual cloud-bound fields through existing settings/data-sharing controls. No broad consent reuse; no silent provider/model fallback; no chat-generation fallback chain; no credential/source leakage. Classifier/PF7/Brand/rights ownership unchanged (this ticket proves the refusal gates offline).
4. **Disable-to-unresolved/manual-rollback verification:** with the TypeSafe connection disabled (or the family policy `provider_disabled`), confirm dispatch refuses via the connection assertion, outcomes stay honestly unresolved/actionable with safe candidates retained for the manual workflow, and re-enable restores service. Procedure: Settings → disable the `typesafe-jev` connection → re-run a membership proposal → expect policy-denied abstention + safe candidates + manual-entry path; re-enable after. Also verify misconfigured/lost-lease behavior.
5. **Activation:** only after 1–4 are recorded and reviewed. Remove obsolete active migrated paths at cutover (none created by this ticket); history retained; classification comparator and approval authorities untouched.

## 6. Activation record

ACTIVATION: OFF. No feature flag, policy state, or default was changed by this ticket. Only this ticket's 4 new files were created (2 corpora, task policy, test + this report); no shared-file edits. Family matching resolves from frozen policy and fails closed without credentials (ambiguity abstains; no TypeSafe route ⇒ no dispatch, no chat fallback). Closing this ticket as a release is explicitly refused until §5 clears.
