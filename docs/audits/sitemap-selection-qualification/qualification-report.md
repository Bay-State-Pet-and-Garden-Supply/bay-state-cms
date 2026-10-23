# Official-page selector qualification report (issue #374) — OFFLINE, ACTIVATION OFF

Status: **BLOCKED — activation OFF.** No live evidence exists. No paid calls made. No store writes performed. This report is the qualification record; it does not authorize activation.

## 1. What was built
- **Dev corpus (frozen):** `src/tests/fixtures/sitemap-selection-qualification/dev-corpus.json` — 14 rows, 14 distinct `familyId`s, sha256 `4ae609d550fa53eafe8372f8b75f1c4e0cd3917b732f46d8d11ed7183c6f9e54`. Covers: deterministic-exact (2), standard multi-candidate (4 incl. one single-candidate verify passthrough), hard negatives wrong-recipe/size/lifestage/line/formula/domain (6), insufficient-evidence (2), missing-gold coverage_gap (1). Intentional intra-dev hard case: dev-02 (`dev-nutrisource-purevita-chicken-rice`) and dev-12 (`dev-nutrisource-purevita-chicken-rice-small`) are the same product line in 25 LB vs 5 LB size variants sharing the identical gold URL — not cross-corpus leakage (zero dev↔holdout family overlap holds). Frozen: register names, approved domains, retrieved candidate sets (exact URLs), gold confirm/abstain, prompt/model/policy versions.
- **Sealed holdout (frozen, NOT run):** `src/tests/fixtures/sitemap-selection-qualification/holdout-corpus.json` — 10 rows, 10 distinct families with zero family overlap vs dev, sha256 `2db0602d67151cd82c7a4cc1e8a07b7b2e33bf939565ac60157658b584c5ca20`. Sealed: the holdout RUN (selector + verifier against live retrieval) has not been executed and MUST NOT be until the live-gate reviewer authorizes unsealing via the auditable `HOLDOUT_UNSEAL=<review-id>` token after the dev-fitted policy below. The seal covers the RUN, not the bytes: the disjointness/hash check reads file bytes (necessary to verify the seal), but never executes holdout rows.
- **Task policy (fitted on dev, published before holdout inspection):** `docs/audits/sitemap-selection-qualification/task-policy.json` — accept when all retrieval candidates share one approved domain and variant tokens match, else abstain; single-candidate / exact-identity → deterministic verify path (no model call); empty retrieval → `coverage_gap`; off-domain-only → `insufficient_evidence` (never select); mixed-domain no-in-domain-match → `no_match`; P(choice) < 0.50 → `low_model_probability` abstention; never clip, never chat fallback, never select an unseen URL.
- **Eval harness:** `scripts/sitemap-selection-qualification.ts` — offline-capable; stubbed Choice transport checks selector mechanics; `--live` requires `TYPESAFE_API_KEY`/`SYSTEMONE_API_KEY` and refuses without credentials, counts `paidCallsMade` from per-row `modelCallMade` dispatch flags in live mode; separates retrieval coverage / selector quality / confirmed-page precision; fixed-population reporting; `--corpus holdout` refuses without the auditable `HOLDOUT_UNSEAL=<review-id>` reviewer token.
- **Regression test:** `src/tests/unit/sitemap-selection-qualification.test.ts` — runs the frozen dev corpus through the selector with a stubbed Choice transport and asserts the fixed-population accounting (9/14 retrieval coverage, 9/9 selector-correct given coverage, 5/5 correct abstentions, zero harness failures); asserts the holdout-sealed invariant (refusal + authorized unseal path, family-disjoint, never executed), the production default path OFF (seed `mlFeatures` all disabled + disabled connection refuses dispatch), the policy timestamps, and that sha256 of both corpus file bytes matches the policy-pinned digests.

## 2. Offline results (stubbed transport — MECHANICS ONLY, not model quality)

`bun scripts/sitemap-selection-qualification.ts --corpus dev` → fixed population n=14, zero harness failures/errors:

| Slice | Result |
|---|---|
| Retrieval coverage (gold URL in candidate set) | 9/14 = 0.643 |
| Selector correct given coverage (choice = gold, incl. deterministic verify passthroughs) | 9/9 = 1.000 |
| Correct abstentions (gold abstain → abstained) | 5/5 = 1.000 |
| Failures / errors / misses | 0 |
| Paid calls / store writes | 0 / 0 |

Per-row: dev-01, dev-09 deterministic `verified_unique_identity`; dev-12 single-candidate `verified_unique_identity` passthrough (ordinary verification, no Choice call); dev-02/03/04/07/10/13 `selected` → exact gold URL via closed-set ID mapping; dev-05/06/11 `insufficient_evidence`; dev-08 `coverage_gap`; dev-14 `no_match`. What this proves: the closed-set contract holds (IDs map to exact supplied URLs, abstention keys retained with safe candidates, audit rows emitted). What it does NOT prove: real model choice quality — the stub answers from the frozen `simulatedModelChoice`, so 9/9 is a mechanics check, not a model-quality claim. Real-transport P(choice) calibration is BLOCKED (see §4).

## 3. Cost / latency / operator-effort methodology (honest unknowns)

- **Offline mechanics:** 14 rows in 8 ms wall (in-process stub, no network). This is a harness smoke number, NOT a latency claim.
- **Real-transport cost/latency:** UNKNOWN. No live call was made (no credentials, no paid calls permitted). The harness records per-row `latencyMs`, `input_tokens`, `output_tokens` from dispatch results when `--live` runs and counts `paidCallsMade` from per-row `modelCallMade` dispatch flags (never zero in live mode); until then cost = unknown (never zero), P50/P95 = unmeasured with n=0. Cookbook thresholds and inference-only speed are not acceptance.
- **Operator effort to a confirmed source:** UNMEASURED. Requires the live canary (§4): retrieval → typed selection → verifier fetch + identity/variant match → operator attestation timing. Harmful-mistake accounting (wrong variant confirmed, false blocks) likewise needs live runs.
- **Unknowns register:** live Choice P distribution and calibration; retrieval coverage against live sitemaps (frozen candidate sets stand in for retrieval here); verifier pass rate; end-to-end minutes per confirmed source; token/retry spend.

## 4. BLOCKED live gate (exact remaining work — activation stays OFF until all clear)

1. **Live retrieval + selection + verifier run** on dev AND sealed holdout with real TypeSafe credentials: `bun scripts/sitemap-selection-qualification.ts --corpus dev --live` then `HOLDOUT_UNSEAL=<review-id> bun scripts/sitemap-selection-qualification.ts --corpus holdout --live` (reviewer approval id recorded in the report output). The `--live` report counts `paidCallsMade` from per-row `modelCallMade` dispatch flags — live cost is never zero. Records real latency/tokens, P(choice) calibration, selector-vs-gold quality, verifier confirmed-page precision.
2. **Reviewed canary** through retrieval → typed selection → verifier → official confirmation / manual resolution on supported examples, with retained item/run/source evidence and attributed operator decisions (synthetic source-less success does not count).
3. **Routing / data-sharing approval:** explicitly approve the evaluated pin (`jev-1.13.0`), the `sitemap_selection` operation routing, the frozen task policy, and the actual cloud-bound fields in existing settings/data-sharing controls. No broad classification-consent reuse; no silent provider/model fallback.
4. **Disable-to-manual verification:** with the TypeSafe connection disabled (or `sitemap_selection` policy `provider_disabled`), confirm dispatch halts via `assertConnectionEnabledForDispatch` (checked pre-dispatch AND pre-retry), the outcome is an honest abstention (`provider_disabled`) retaining safe candidates for the manual/unresolved workflow, with no fallback to the obsolete chat selector and no forced overlap choice. Procedure: Settings → disable the `typesafe-jev` connection → re-run a discovery item → expect `provider_disabled` + safe candidates + manual-entry path in the attention workspace; re-enable after.
5. **Activation:** only after 1–4 are recorded and reviewed. In-flight plans incompatible with the cutover must be drained/superseded; obsolete active chat-selector parsing removed; historical records and the existing classification comparator/qualification gates retained.

## 5. Activation record

ACTIVATION: OFF. No feature flag, policy state, or default was changed by this ticket. The `mlFeatures` evaluation/production surface is untouched; `sitemap_selection` resolves from the frozen snapshot policy and fails closed (`provider_disabled`) without credentials. Closing this ticket as a release is explicitly refused until §4 clears.
