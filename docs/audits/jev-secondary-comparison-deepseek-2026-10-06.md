# DeepSeek secondary comparison + ShopSite Page XML evidence (2026-10-06)

Status: **#302 remains BLOCKED; #312 remains gated.** Secondary comparator only — not historical incumbent qualification. Agent gold/review only — not Store Manager approval.

## 1. Secondary comparator (explicit, isolated)

- Role: `secondary_comparator`, provider `deepseek-cloud`, model `deepseek-flash`.
- Credential: `provider_connections:deepseek-cloud`, explicit isolated `:memory:` evaluation DB, read-only source catalog DB, no credential persistence.
- Candidate: real Jev `jev-1.13.0` via `TYPESAFE_API_KEY`.
- Budgets per leg: 600 attempts / concurrency 2 / 300000 ms hard deadline.
- Worst-case preflight: candidate 92, comparator 506. Consumed: candidate 40, comparator 20, rejected 0, deadline not fired. Total new model requests: 60.
- Predictor: `code-executed-v7`. Artifact hash `088082e0d7d82d63209f9123164f7ccc0df821a429d0ae5d7db54f3fa094dd7b`.
- Authority: `78f550f0b31c51c5a3c4b5f614e0bc953a90fdbe49749b7b39d6cd2ceeeef2de`, catalog `9d8b54cf83d42e00e988f08efae7f280ebd76b69`, config `098499155c24642ddfa061dfc0455528267109ed6c062af42009ec7d51d37ab3`, verified Page import `60cdb1235506d36b879fd0b95f1d1578434381f0aae9e2b2973d2739556a15fe`.
- Gold: 23 public development entries (16 known-type, 7 genuine-product no-fit), explicit 9 controlled targets (207 states: 16 known + 191 inapplicable), all Pages unknown. Independently peer-verified development-only.
- No holdout access, no policy publication, no inference on held rows.

Artifacts:
- `docs/audits/jev-representative-v4/secondary-comparison-v7-2026-10-06.json` (SHA `35d947c7455d66b5c915f8d230e8df5898f776cdfba62db41ba8278b92b8944d`)
- `docs/audits/jev-representative-v4/secondary-comparison-explicit-gold-v7-2026-10-06.json` (SHA `5abfb6a8fe14f68e7339dcd62f41a259328b3690504445a25bfb72ec192ce320`, predictions unchanged, 0 additional model requests)

## 2. Results (23-row development only, N too small for qualification)

- Product Type: Jev 95.65% correctness (22/23) / 73.91% coverage, 1 incorrect; DeepSeek 69.57% / 78.26%, 2 incorrect. Delta +26.09 correctness, −4.35 coverage. Harmful regressions 0, recovered abstentions 5, service failures 0.
- Attributes (18 eligible, 5 unevaluated): both 100% correctness; Jev coverage 94.44% vs 100%; exact match / precision / recall / F1 Jev 94.44% vs DeepSeek 88.89%. Zero incorrect on either side.
- Category Pages: 0 eligible / 23 unevaluated — not evaluated.
- Explicit-gold rescore headline stage scores are identical to the capture-time scores; the prior implicit empty-field scoring risk is removed without new inference. (Full reports differ in `endToEndPipeline.attributeEffects`: `totalEvaluated`/`eligible` 17 → 16, `unevaluated` 0 → 1.)
- Jev still has 1 incorrect Product Type proposal, so the zero-error gate fails even before sample-size, coverage, paired-confidence, full-runtime cohort, and canary gates.

## 3. ShopSite Page XML authority evidence (read-only)

- Live `dbname=pages`, version `14.0`, 1 download request, no import activation, 0 production writes.
- Export SHA `810d881ccd48275366d9174e808c4e1cfe2356a8c75ecb416b37076941186ae0`.
- 212/212 identities and names match the frozen verified pool (`60cdb123…`).
- Field presence: file names 212, titles 182, Text1 35, Text2 12, Text3 37, parents 0, product-link blocks 0 in scalar-purpose export.
- Assignment scope remains open; product membership gold remains false. Filenames/titles/descriptive text are preserved as evidence only.

Artifact: `docs/audits/jev-representative-v4/shopsite-page-xml-evidence-2026-10-06.json` (SHA `1059275d07e71edcb6913ab8b1c3ac76b7ecd8383f573d68c4e41deccc077785`).

## 4. Corpus state

- Public V4 development: 23 primary + 1 supplemental variant (not independent support). Peer receipt v2: 76/76 literal citations, explicit 9-target states, quarantine 0.
- Sealed V4 holdout: 5 families/rows only (2 known-type, 2 no-fit, 1 insufficient; 1 field known, 43 inapplicable, 1 unlabeled; 5 Pages unknown). `final-private-contract-receipt.json` status `ineligible` — below 200-example / 20-per-class floors. No holdout inference.
- Policies published before holdout: false.

## 5. Code and checks

- Read-only repository injection only (`api-key-repo`, `connection-repo`, `provider-connection-repo` accept an explicit readonly reader; default behavior unchanged).
- New scripts: `scripts/jev-secondary-comparison.ts` (plan / live / rescore with input-identity and authority checks), `scripts/audit-shopsite-page-authority.ts` (read-only Page evidence, identity-match or fail).
- Typecheck: only existing `browser-investigation-tier1.test.ts(815,61)` null/number error.
- Focused tests: 107 pass / 1 skip (provider/connection/pages) + 124 pass / 1 skip (qualification/replay).
- Changes are uncommitted and scoped; unrelated worktree entries remain untouched. No push.
