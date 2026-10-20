# Sitemap selection live-retrieval qualification — v2 (issue #374) — OFFLINE CORPUS + LIVE RETRIEVAL SCAFFOLD, ACTIVATION OFF

Status: **IN PROGRESS — activation OFF. No freeze attested. No holdout executed. No sign-off issued.**

## 1. What v2 is and is not

- **Preserved byte-identical:** v1 dev corpus (`src/tests/fixtures/sitemap-selection-qualification/dev-corpus.json`), v1 holdout corpus, v1 task policy, v1 qualification report, and all retained v1 live artifacts (`/tmp/sitemap-dev-live*.json`). Nothing in v1 was modified to produce v2.
- **New in v2:** a separately versioned live-retrieval evaluation basis —
  - `src/tests/fixtures/sitemap-selection-v2-qualification/dev-corpus.json` (v1 rows + `liveRetrieval` slots; frozen v1 sets retained alongside crawled candidates),
  - `docs/audits/sitemap-selection-v2-qualification/task-policy.json` (policyId `sitemap-selection-task-policy-v2-live`; acceptance contract below; pins TBD at freeze),
  - this report.
- **Why a new version:** the v1 frozen candidate URLs no longer resolve (all v1 live verifier attempts returned HTTP 404). v1 remains the mechanics/contract record; v2 evaluates against live retrieval output. v2 does NOT relitigate v1 rows (dev-11 stays a failed frozen selector decision).

## 2. v2 acceptance contract (frozen at freeze time; criteria fixed BEFORE holdout)

- Retrieval: every dev row retains fetch time, approved-domain authority, sitemap source URL, ranked candidate URLs + provenance, and failures/missing pages. Fixed population (all rows, incl. negatives) — no selecting only working URLs.
- Selector: Choice over the ranked live set; abstention vocabulary unchanged; off-domain never selected (domain gate); bypass handoff verified the same as selections.
- Verifier: every selected URL AND every deterministic-bypass handoff gets a fetch attempt with recorded HTTP cause; identity/variant evidence retained per successful fetch (proof class, GTINs, title, decision reason).
- Calibration: full Choice distributions retained per dispatched row (abstention keys included); descriptive only at n<=14; no post-hoc threshold changes.
- Confirmed-page precision: reported as attempts / successful fetches / product-detail classifications / product+variant confirmations; `null` until demonstrated. A fetch is not a confirmation.
- Pass bar (dev): TBD at freeze — proposed: selector-correct given live coverage with zero off-domain selections, correct abstentions on gold-abstain rows, verifier attempted on 100% of selected+bypass handoffs. Dev-11 recorded as failed frozen decision carried forward.

## 3. Live retrieval evidence (dev crawl, NOT an evaluation)

- Crawl: `bun scripts/sitemap-selection-qualification.ts --corpus dev --crawl-live-retrieval <out>` (no model calls, no store writes).
- Runner changes since v1: in-memory scratch DB (credential never touches disk); same-resolver credential provenance check (fail-closed); full distributions retained; verifier fetch with recorded HTTP cause; deterministic bypasses verified; `retrievalSource` per row.
- Verifier attempts: 10 (7 typed + 3 bypass handoffs). Successful fetches: 0/10 (HTTP 404 on all fixture URLs — expected: v1 URLs are dead). This is failure-path evidence, not qualification data.

## 4. Open gates (unchanged from v1 protocol)

1. Dev v2 evaluation with live retrieval + verifier evidence on resolvable targets.
2. Independent freeze attestation (DIFFERENT reviewer instance) with corpus + source-revision pins.
3. Logged holdout unseal authorization; v2 holdout corpus (independent custody/versioning — v1 holdout untouched).
4. Reviewed live canary with operator attestation (confirmation path, not selector alone).
5. Routing/data-sharing approval of the evaluated pins.
6. Disable-to-manual verification + recovery proof.

## 5. Activation record

ACTIVATION: OFF. No flag, policy, or default changed. No freeze attested. No holdout executed. No canary run. No sign-off issued.
