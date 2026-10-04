# Jev implementation verification — 2026-10-03

## Outcome

The implementation and live development checks progressed substantially. **#302
is still blocked, and #312 retirement is not authorized by this evidence.** A
small successful development fixture is not representative production qualification.

Root code is an uncommitted worktree based on
`e431eb35c523af7bb1f2fc3b25e7638b231e9341`. The separate catalog workspace recorded
an approved policy application through the live Settings UI at commit
`9cf6cf5d2`; that is an application-managed catalog policy commit, not a source-code
implementation commit.

## Completed corrections

- **Settings freeze:** `AiComputePanel.tsx` had a connection-option component
  that rendered itself recursively. Restored the filtered options, added a full
  panel-render regression, and verified the actual Settings screen in a browser.
  Judgment-only connections remain absent from chat workload choices.
- **Live disablement and lease loss:** protected type, attribute, singleton-page
  and cohort-page requests now recheck the current stored enabled state and
  ownership before every transport attempt, including retries. The database
  check lives in the server-side decision boundary; shared transport remains
  browser-safe. Missing/unreadable authority denies dispatch.
- **Frozen corrections:** target-only field changes validate both the configured
  field identity and its carried value. Invented fields/values fail before
  revision/history writes. Explicit null removal remains supported.
- **Review authority:** agent evaluation cannot replace existing review decisions
  or invalidate human dependents. Exact action-token retries remain idempotent.
  Human confirmation of an agent type correction performs the proper dependent
  invalidation and queues the narrow refresh.
- **Transactional review:** corrupt item provenance returns a conflict rather than
  crashing the endpoint. Each decision is rechecked inside the transaction; a
  mixed request cannot accept an old dependent invalidated by its earlier type
  correction. That request rolls back completely.
- **Statistical qualification:** operational flags no longer substitute for the
  existing conservative benchmark gate. The gate checks labeled holdout support,
  per-class support, coverage, safety, raw-source/snapshot compatibility, failures
  and a positive lower 95% paired-delta bound. The paired metric is fixed-population
  `productType.rawCorrectness`, not answered-overlap accuracy.
- **Prediction correctness:** predictor `code-executed-v5` preserves and hashes
  semantic abstention codes. No-match and insufficient-evidence must match their
  gold states; low-probability, service-failure and uncoded legacy refusals do not
  earn semantic correctness. Unlabeled rows earn no Product Type accuracy credit.

Previously completed narrow refresh work retains the run's frozen evidence,
accepted type and universal decisions, buffers dependent stage publication and
atomically publishes proposals/projection/queue completion under the live lease.
Coordinated children remain owned by their cohort parent. Re-seeders hold synthetic
fixtures instead of bypassing source readiness, freeze or provenance checks.

## Live browser and workspace evidence

- Actual **Settings → AI Compute → Classification Stage Providers** rendered.
  All three stage overrides showed `typesafe` / `jev-1.13.0`, no fallback.
- **Preview Changes** returned Configuration Valid and displayed each cloud text
  sharing effect. **Apply Classification Policy** succeeded in the live browser.
  Catalog commit `9cf6cf5d2` changed exactly model policies, data sharing and
  manifest metadata. Bundle hash:
  `c4e814523bd86b3d4900cf5fd24e55dfe2c9f132392a76896e04a8a55a2bd082`.
- Active taxonomy release is `bay-state-v5`. The governed v5 pin route now validates
  that release correctly. Food-form aliases are loaded by the runtime; supporting
  aliases and genuinely contradicting values have regression coverage. Historical
  run snapshots retain their original evidence meanings.
- Verified Page import `68d699b2-9c47-439e-87e3-110ef688ec0b` has **212 verified
  records**, zero name-only records. Source hash:
  `60cdb1235506d36b879fd0b95f1d1578434381f0aae9e2b2973d2739556a15fe`.
  Download explicitly requests identity fields with XML compatibility version 14.0.
- Default `visionOcr` is `onboarding-ocr-local` / `qwen2.5vl:latest`, local-only,
  no fallback, fail-closed. The previously retained real-image default-route smoke
  succeeded without overrides and materialized visual evidence. This is plumbing
  evidence, not an OCR accuracy claim or a change to old frozen OCR plans.
- The live canary Review screen rendered its evidence, proposals and readiness
  warnings. Its six review items remained unreviewed; no final approval or
  promotion was performed. Source-less synthetic fixtures cannot qualify the
  production extraction/worker path. A full newly frozen, reviewed production
  canary remains outstanding.

## Bounded live development result

Command actually executed:

```sh
bun scripts/typesafe-curation-qualification.ts --split=dev --live-capture --live-check --model=jev-1.13.0 --baseline-provider=deepseek-cloud --baseline-model=deepseek-v4-pro --db=storage/catalog/.shopsite-cms/app.db --artifact-out=docs/audits/jev-development-v5-2026-10-03.json
```

Artifact hash:
`7f172a5dd12f018a9b324a81ccec8eb41ed39b6ae01a57cff9af8461f53bc08c`.
Decision-policy hash:
`1407f2c9f5286edb283766d2c08c6fb0ed6f6dd48ded0b8ed5a2a9ac52830239`.

Twelve development rows were captured; eleven have eligible Product Type gold.
No holdout was sent for inference. The bounded live contract check passed and
returned the pinned `jev-1.13.0`. The fixture's declared adjudication metadata is
retained; this session does not establish a new independent adjudication panel.
Its frozen candidate pool is a fixture pool, not proof of the entire live assortment.

| Development metric | Incumbent | Jev |
|---|---:|---:|
| Product Type raw correctness | 81.8% | 100% |
| Product Type coverage | 81.8% | 81.8% |
| Controlled-attribute raw correctness | 81.8% | 100% |
| Page exact match | 44.4% | 100% |
| Provider failures | 1 | 0 |

Zero candidate incorrect proposals and harmful regressions were reported. The
unknown fogger returned `no_match`; the thin-evidence case returned
`insufficient_evidence`. Cost remains unknown. Per-row mean captured latency was
10,002 ms incumbent / 370 ms Jev; this is not measured operator-time saving.
The fixture's end-to-end effects summary is not a production cohort-worker canary.

## Disablement evidence

`jev-disablement-v2-2026-10-03.json` records a real loopback HTTP exercise with an
isolated SQLite connection and no network mocks:

1. Disabled stored connection, captured enabled object: **0 requests**.
2. Store disabled after the first actual 429 response: **1 request**, retry denied.
3. Lease lost after the first actual 429 response: **1 request**, retry denied.

No vendor inference or production connection mutation occurred in this exercise.
The receipt binds the exercised source hashes. Operations receipt
`jev-operations-receipts-2026-10-03.json` truthfully marks disablement verified and
policy-before-new-holdout publication unverified.

Reassessing the retained v5 predictions with that receipt clears the disablement
blocker and still returns **blocked**. Current runbook hash:
`66c2a745169549fb5acb817972c53d7ecd1dac5ce6326b16f8ad3bda959c5ca8`.

## Verification

- `bun run test`: **332 Vitest files passed; 4,341 tests passed, 1 skipped**.
  Bun's principal 133-file group passed **1,946 tests, 1 skipped**, plus the preceding
  and intervening passing groups. The command stopped at the four pre-existing
  sourcing-observe failures below; it did not pass globally.
- Executed all **40 remaining `test:db` commands** after that stopping point:
  **1,029 passed, zero failed**.
- The last mixed-request liveness guard was added after the broad run. Reran its
  seven affected review/refresh/qualification/benchmark files on the final code:
  **104 passed, 1 skipped, zero failed**. Its eight affected/new source and test
  files passed focused ESLint.
- Protected type/attribute/page/cohort and transport tests: **96 passed**.
  AI Compute rendering and classification Settings tests: **7 passed**.
- Differential ESLint over **63 owned files**, compared with starting HEAD:
  **55 baseline errors / 53 current errors, zero new lint messages**. Whole-repo
  lint is not claimed clean.
- Typecheck has only the existing concurrent-work error at
  `browser-investigation-tier1.test.ts:815` (`null` versus `number | undefined`).
- `git diff --check` passed; final central diff reviewed. Ten retained audit JSON
  artifacts were scanned for credential-bearing fields and known credential-shaped
  values; zero findings. This does not resolve historical GitGuardian alerts.
- Independent Standards and Spec review findings were corrected. The final Spec
  re-review found no actionable correctness issue in the reviewed guard,
  correction, coded-outcome and statistical-gate changes.

The four `sourcing-observe-mode.test.ts` failures were previously reproduced
unchanged on detached starting HEAD `e431eb35`: expected shadow evidence attempts
are absent in found/conflicting/error/idempotency cases. They are not a Jev regression.

## Remaining acceptance gates

1. New representative, family-separated, independently adjudicated support and
   per-capability development-fitted policies published before its sealed holdout
   is inspected. The September holdout is already inspected and cannot be resealed.
2. A real newly frozen canary through supported source/extraction readiness, then
   confirmed human Product Type, attribute and mixed-cohort page review and final
   approval. The 39 retained `agent_review` decisions do not provide those receipts.
3. Reviewed source code committed and compatibility evidence rerun/bound to that
   code. An uncommitted worktree cannot be certified by a receipt naming HEAD.
4. Repository-wide typecheck/sourcing baseline blockers resolved by their owning
   workstreams. #333's remaining cloud-quota actionable-alert criterion is not
   implemented/verified by the local-route fix.

#328 still needs a genuinely fresh source-ready canary demonstration; old frozen
contradictions are not retroactively rewritten. #302 and #312 remain open. Retiring
the comparator before these gates pass would destroy required comparison evidence.

## Published tracker updates

- [#302 verification and remaining qualification gates](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/302#issuecomment-5974416023)
- [#328 governed v5 activation and fresh-canary requirement](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/328#issuecomment-5974415977)
- [#333 explicit local OCR remediation and remaining quota-alert criterion](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/333#issuecomment-5974416003)
