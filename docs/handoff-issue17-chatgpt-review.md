# Issue #17 Remediation — Review Handoff (for ChatGPT code review)

> **Status update (2026-08): SUPERSEDED by ADR-0030 (Agent Lab decommission) — content below references the deleted `src/product-intelligence/**` Agent Lab surface and is preserved as a historical record only.**

Reviewed target: `main` @ `06ffda2` (36 commits ahead of origin before push),
pushed to `origin/main` on 2026-08-09.

## 1. What this change set is

Remediation of adversarial-audit issue #17 for the classification/curation
subsystem of the Bay State CMS (Bun + Hono + SQLite; React SPA). The work is
organized as passes A–M from `docs/plans/` (post-recovery issue-17 plan) and
completes the earlier M0–M11 recovery. Every pass was adversarial-reviewed
(read-only reviewer, multiple rounds) before acceptance; the closing
independent review passed with evidence at `/tmp/issue17-final-review.md`
(also summarized below).

The single most important property reviewers should check: **fail-closed
everywhere** — no implicit model fallback, no promotion without a live
accepted decision, no page assignment without a verified page ID, no
fabricated metrics, and no live-DB write outside the sanctioned, backup-gated
maintenance tools.

## 2. Passes → commits → focus files

| Pass | Item | Key commits | Focus files |
|---|---|---|---|
| 1 | A — local_only model boundary | `0af96d5` `b1eba02` `23356c7` `50578f8` `1461af3` | `src/classification/model-policy-gateway.ts`, `src/onboarding/model-policy-snapshot.ts` |
| 2 | B+K — accepted-only promotion | `d3e0423` | `src/onboarding/draft-promoter.ts` |
| 3 | D1+L — verified Page snapshot, readiness | `c85c821` `f7af801` `4fb5881` `044c014` `c912b60` | `src/classification/page-snapshot.ts`, `src/classification/readiness.ts` |
| 4 | E — model-call provenance | `33cea8c` `a836f80` `cb4ae5d` `ad90656` `e891b7e` `e6f802d` | `src/db/repositories/classification-model-call-repo.ts`, run-detail route |
| 5 | H+I — evidence targeting, citations | `69d2c32` `f6ef1a6` `2b5a8d5` `cab0e29` | `src/classification/evidence-targeting.ts`, `classification_proposal_evidence` (relation-typed) |
| 6 | C1 — integrity/backup/repair tooling | `2979de8` … `4c0ed69` (7 rounds) | `scripts/classification-integrity.ts`, `src/db/sqlite-backup-verifier.ts`, `src/classification/integrity-audit.ts` |
| 7 | F — production telemetry | `0433047` `3dc206a` `26a0cf5` `8da49b6` | `src/classification/production-metrics.ts`, `src/db/repositories/classification-metrics-repo.ts`, `src/client/classification-metrics-view.ts`, weekly-report route |
| 8 | G+J — controlled-value identity, built-in output policy | `668a693` `26165d4` | `src/classification/controlled-value-identity.ts`, `src/shopsite/built-in-output-policy.ts`, ADR-0011/0012 |
| 9 | C2 — LIVE integrity repair | executed 2026-08-09 | one transaction, post-audit clean (details §4) |
| 10 | D2 — LIVE config activation | `b1c7d83` (CLI); nested catalog commit `024c6412` | `scripts/classification-config-admin.ts`; active bundle `b5ca076f…` |
| 11 | M — registry/docs | `5786e91` | `docs/governance-17-alignment.md`, `CONTEXT.md` |
| — | external review fixes | `dc65ba2` | `src/onboarding/draft-promoter.ts` (verified-page promotion gate), `src/shopsite/built-in-output-policy.ts` (runtime freeze), their tests |
| — | lint cleanup + final review fix | `d1b9080` `06ffda2` | zero lint errors in issue-17-owned files |

## 3. What to review most carefully (probe list)

1. **Model policy gateway (A)**: `resolveModelRoute()` — every protected call
   must fail closed (`policy_absent`, `policy_tampered`, `locality_undeclared`,
   `endpoint_non_loopback`, `implicit_fallback_forbidden`). No path may
   silently fall back to a cloud provider; `local_only` checks BOTH declared
   locality and resolved endpoint (loopback only). `model-policy-snapshot.ts`
   fails closed to `{state:'disabled'}` for missing/legacy policies.
2. **Promotion (B/K)**: `draft-promoter.ts` — proposals promoted only when
   `status === 'accepted'` from a live decision; the old
   `accepted.length ? accepted : nonRejected` fallback is gone (grep
   `nonRejected` should hit only the governance doc).
3. **Page identity (D1)**: `captureVerifiedPageSnapshot()` is ONE transactional
   read (import + verified `page_index` rows, strict 1:1 bijection, throws on
   drift). Both run creators enforce readiness (409 `classification_not_ready`);
   an enabled page target can never start with `no_verified_page_catalog`.
   **Mandatory verified-page promotion gate** (review-fix `dc65ba2`): at
   promotion, at least one VERIFIED page assignment is required — accepted
   proposals with unverified IDs and name-only manual `product_pages` rows are
   visible skips (diagnostic only) and never satisfy the gate. `ProductOnPages`
   serializes ONLY the verified assignment set (no unchecked DB-name fallback),
   and the verified catalog is the display-name authority (a verified Page ID
   with no proposal name resolves to the verified page's canonical name; the
   Page ID is never serialized as a name). Regression tests cover only-bogus →
   blocked, name-only manual row → blocked, mixed verified+unverified → emits
   only verified, and ID-only proposal → catalog-name resolution.
4. **Model-call provenance (E)**: call row inserted BEFORE transport; terminal
   row recorded BEFORE output is consumed; missing/terminal row ⇒ output
   discarded. Run-detail endpoint returns no prompts/credentials (redaction +
   key dropping).
5. **Evidence targeting (H/I)**: `classification_proposal_evidence.relation`
   role-union CHECK; contradictions surface into
   `classification_proposal_decision_evidence`; brand role disjointness;
   citations rendered in both review UIs.
6. **Integrity tooling (C1)**: repair refuses to run without
   `--execute --backup-manifest --expected-audit-hash`; backup verifier is
   adversarial-grade: VACUUM INTO single artifact, sidecar refusal, immutable
   open, collision-resistant identity (XOR + Mersenne sums), quarantine
   cleanup, content-attested publish, source-parity gate.
7. **Telemetry (F)**: coverage is `'n/a'` (never fabricated `0.0%`) when
   eligible runs exist but no decision-eligible proposals; groups keyed by
   resolved model route; per-proposal NEWEST live decision wins regardless of
   insertion order; date params validated (400, never 500); weekly-report
   no-workspace branch returns an honest warning. The weekly-report test
   deliberately uses NO module mock (Bun 1.3.x `mock.module` is
   process-global and un-restorable) — it seeds an isolated DB and asserts the
   honest `n/a` fixture that the old code rendered as `0.0%`.
8. **Controlled-value identity (G)**: IDs are exact canonical strings
   (NFC+trim); label === ID; aliases whose `mapsTo` is not an exact allowed ID
   are rejected; alias TARGETS validated against the allowed set via
   `matchCanonicalValue` (see `26165d4` — the initial `resolveAlias` misuse
   silently dropped valid aliases).
9. **Built-in output policy (J)**: `SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1` is
   immutable and adapter-owned (ADR-0011) — since review-fix `dc65ba2` it is
   also RUNTIME-frozen (the exported array and every rule object are
   `Object.freeze`d; the membership `Set` is module-private behind
   `isBuiltInOutputField()`). `product-denormalizer.ts` consumes it
   byte-compatibly (roundtrip tests unchanged).
10. **Docs (M)**: every status in `docs/governance-17-alignment.md` is backed
    by commit/DB evidence; hashes were copied from command output, not
    guessed.

## 4. Live operations performed (2026-08-09)

- **C2 repair** (live DB, ~1.8 GB SQLite): verified backup first
  (`/tmp/issue17-c2-backup`), audit manifest hash matched the reviewed
  baseline exactly (3,062 FK violations; 637 stage results, 2,003 evidence,
  191 proposals, 180 onboarding sources, 50 extractions, 1 revision, 22
  dangling embedded proposals), then ONE transaction repair with clean
  post-audit (`foreignKeyViolations: 0`, `PRAGMA integrity_check = ok`).
  Operational rows untouched: 268 terminal runs, 465 proposals, 211 verified
  pages, 33,631 product_pages.
- **D2 activation** (user-approved): candidate generated twice (identical),
  evidence scanned twice (identical, `3b276fed…` unchanged vs M7), preview
  reviewed; activation wrote nested catalog commit `024c6412` touching ONLY
  `store/classification/**`; active bundle `b5ca076f…`, `store-pages`
  `enabled:true` (`optionSource: live_store`) against the same 211-page
  verified import (`96d018cb`, source hash `20d94f68…`); model policy
  Ollama/local-only; all four ML features disabled. Runtime authority loads
  with zero blockers; readiness reports Category Pages runnable.

## 5. Gates (all green at 06ffda2)

- `bun run typecheck` — clean
- `bun run build` — clean
- `bunx vitest run` — 1,481 passed / 1 skipped / 0 failed
- `bun run test:db` — 1,246 passed / 0 failed
- `bun run lint` — **zero errors in issue-17-owned files**; ~2,590
  pre-existing errors in unrelated files remain (separated with before/after
  evidence, no new exclusions added)
- Final independent adversarial review: PASS (all 10 items, file:line
  evidence, live-DB probes)

## 6. Caveats / not included

- **Parallel workstream NOT in this push**: the Product Intelligence program
  (`feat/pi-1-product-intelligence-execution-boundary`, PI-1…PI-11) is
  developed in parallel by another agent/session and lives on its own branch;
  only the classification-side issue-17 remediation is in this push. The
  governance doc attributes PI items separately and does not claim one
  workstream substitutes for the other.
- **Production ML remains disabled** (all `mlFeatures.*` disabled in the
  active bundle); benchmark/calibration are evaluation-only; the Gold
  qualification gate (≥200 holdout, ≥20/class, ≥0.80 coverage, zero safety
  violations, positive CI lower bound) is unmet — `insufficient_sample` is
  the honest state.
- **Lint debt** in files outside issue-17 scope is pre-existing and
  untouched.
- **No network/paid services** were used during implementation; HTTP is
  mocked in tests; no live model calls were performed.
- **Nested catalog repo** (`storage/catalog`, its own git) holds the two
  config-store commits (`6e5684f97`, `024c6412`) and is NOT pushed to
  GitHub (contains store catalog data; per project convention it stays
  local).
- GitHub issue state is not written from this repository.

## 7. Suggested review entry points

1. `src/classification/model-policy-gateway.ts` + `model-policy-snapshot.ts`
2. `src/onboarding/draft-promoter.ts` (accepted-only promotion)
3. `src/classification/page-snapshot.ts` + `readiness.ts`
4. `src/db/repositories/classification-model-call-repo.ts`
5. `src/db/sqlite-backup-verifier.ts` + `scripts/classification-integrity.ts`
6. `src/classification/production-metrics.ts` + `classification-metrics-repo.ts`
7. `src/classification/controlled-value-identity.ts`
8. `src/shopsite/built-in-output-policy.ts`
9. `scripts/classification-config-admin.ts`
10. `docs/governance-17-alignment.md` (registry)
