# Packaging-OCR Model Rollout Runbook (P3-T3)

How to evaluate a candidate local vision model against the packaging-OCR
golden set and, only if the **pre-registered gate passes**, flip
`DEFAULT_LOCAL_VISION_MODEL`.

Scope: `src/onboarding/ocr-eval/` (harness), `src/shared/vision-model-defaults.ts`
(the flip), `docs/plans/packaging-ocr-overhaul-plan.md` Phase 3 (authority).

---

## 1. Pre-registered thresholds

> These thresholds were recorded **before any harness results existed**
> (2026-08, plan approval). Do not tune them after seeing numbers. Changing a
> threshold requires editing this section FIRST and re-freezing the dataset.

A candidate may replace `DEFAULT_LOCAL_VISION_MODEL` only when, evaluated on
the frozen golden set of **≥ 30 images** (`minSamples`):

| # | Criterion | Threshold |
|---|-----------|-----------|
| 1 | UPC accuracy (digit-exact) | ≥ baseline − **0.02** absolute |
| 2 | Hallucination rate (predicted non-null where label null) | ≤ baseline (delta ≤ 0) |
| 3 | Empty rate (failed or fully-empty extractions) | ≤ baseline + **0.01** |
| 4 | Parse success rate (schema-valid `PackagingOcrData`) | ≥ **0.95** absolute |
| 5 | Latency p95 | ≤ **2×** baseline p95 |

These live in code as `DEFAULT_ROLLOUT_THRESHOLDS` in
`src/onboarding/ocr-eval/metrics.ts`; the runbook is the human-readable
registration of record. The gate function `evaluateRolloutGate(report,
thresholds)` enforces them and fails closed on missing comparisons.

## 2. Golden-set freezing rules

- Dataset files are JSON under `src/onboarding/ocr-eval/datasets/*.json`
  (`packaging-ocr-golden-v1.example.json` shows the shape). They are
  versioned in git next to the harness so label edits get normal review.
- **Storage rationale:** PI's benchmark gold labels live in SQLite tables,
  but OCR gold needs image *bytes*; images stay OUT of git under
  `data/ocr-eval/<dataset-name>/` (local operator machine) referenced by
  relative `imageRef`, while the labeled JSON (small, reviewable,
  content-addressed) lives in `src/`. Small fixtures may embed bytes inline
  via `"imageRef": "inline:<base64>"`.
- Identity: each load computes a SHA-256 digest over the canonical JSON of
  the whole document (`LoadedGoldenDataset.digest`). Every evaluation report
  records the digest it ran against — reports from different digests must
  never be compared.
- Freeze procedure for a real rollout: curate ≥30 entries (UPC digit-exact,
  strings case-insensitive at compare time, arrays as sets), place images in
  `data/ocr-eval/<name>/images/`, commit the JSON, and record the digest in
  the flip PR description.

## 3. Running the harness

Prerequisites (operator, manual — the harness NEVER downloads models):

```bash
ollama pull qwen2.5vl:latest   # baseline
ollama pull qwen3-vl:8b        # candidate
```

Invocation (script form; sequential per candidate/item through the real OCR
core — same prompt, parser, circuit breaker, local-slot semaphore):

```bash
bun run scripts/ocr-eval.ts \
  --dataset src/onboarding/ocr-eval/datasets/packaging-ocr-golden-v1.json \
  --data-dir data/ocr-eval/packaging-ocr-golden-v1 \
  --candidate qwen2.5vl:latest@http://localhost:11434 \
  --candidate qwen3-vl:8b@http://localhost:11434
```

Reports land on **stdout only** (JSON). There is intentionally no report
persistence directory: a flip PR must paste the stdout JSON (including
`datasetDigest`) into its description, which keeps the evidence attached to
the exact commit that performs the flip. If stdout-only ever becomes a
problem, add an opt-in `--out <path>` flag writing under
`docs/runbooks/reports/` — do not write report files by default.

Programmatic use:

```ts
import { loadGoldenDatasetFromJson } from 'src/onboarding/ocr-eval/golden-dataset';
import { evaluateCandidatesAgainstGolden } from 'src/onboarding/ocr-eval/runner';
import { aggregateCandidateReport, evaluateRolloutGate } from 'src/onboarding/ocr-eval/metrics';
import { DEFAULT_LOCAL_VISION_MODEL } from 'src/shared/vision-model-defaults';

const dataset = loadGoldenDatasetFromJson(await Bun.file(path).text());
const result = await evaluateCandidatesAgainstGolden(dataset, {
  datasetDir: 'data/ocr-eval/packaging-ocr-golden-v1',
  candidates: [
    { baseUrl: 'http://localhost:11434', model: DEFAULT_LOCAL_VISION_MODEL },
    { baseUrl: 'http://localhost:11434', model: 'qwen3-vl:8b' },
  ],
  baselineModel: DEFAULT_LOCAL_VISION_MODEL,
  fetchFn: fetch, // local Ollama transport; tests inject mocks instead
});
const candidate = result.reports.find(r => r.candidateModel === 'qwen3-vl:8b')!;
const gate = evaluateRolloutGate(candidate);
```

### Report shape (example)

```jsonc
{
  "candidateModel": "qwen3-vl:8b",
  "baselineModel": "qwen2.5vl:latest",
  "samples": 32,
  "fieldMatch": {
    "upc": { "matched": 29, "comparable": 31, "rate": 0.935, "wilsonLower": 0.79, "wilsonUpper": 0.98 }
    // …one entry per OCR field over entries whose labels cover it
  },
  "upcAccuracy": 0.935,
  "hallucinationRate": 0.04,
  "emptyRate": 0.03,
  "parseSuccessRate": 0.97,
  "latencyP50Ms": 4100,
  "latencyP95Ms": 9800,
  "failureReasonCounts": { "unparseable_json": 1 },
  "vsBaseline": {
    "hasBaseline": true,
    "upcAccuracyDelta": -0.01,
    "hallucinationRateDelta": 0.0,
    "emptyRateDelta": 0.0,
    "parseSuccessRateDelta": 0.03,
    "latencyP50DeltaMs": -200,
    "latencyP95DeltaMs": 300,
    "baselineLatencyP50Ms": 4300,
    "baselineLatencyP95Ms": 9500
  }
}
```

## 4. Flip mechanics

The default model is one constant:

- `src/shared/vision-model-defaults.ts`: change `DEFAULT_LOCAL_VISION_MODEL`
  (and keep `LEGACY_ROUTE_FALLBACK_VISION_MODEL` consistent unless the ADR
  says otherwise).

Everything else derives automatically: the pristine-detection seed guard
(`provider-connection-repo.ts` compares literal seed values), UI suggestion
lists (`FALLBACK_MODEL_SUGGESTIONS`), and schema defaults import these
constants — no other literals may be edited. Versioned classification config
seeds/snapshots that hardcode the old tag are content-addressed and are
NEVER edited; the flip intentionally triggers the capped P1-T3
digest-staleness re-run at the next cohort freeze, which rebinds stored OCR
to the new authority within `BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP`.

Flip = exactly ONE commit touching
`src/shared/vision-model-defaults.ts`, containing:
1. the pasted stdout gate report with matching `datasetDigest`,
2. the gate verdict (`evaluateRolloutGate(...).pass === true`),
3. a link to the frozen dataset revision.

## 5. Rollback

Revert the constant commit (`git revert <flip-commit>`). No data migration
is required either direction: stored OCR rows re-bind lazily via the capped
digest-staleness re-run, and the circuit breaker/failure taxonomy is
model-agnostic. If the new model degrades catastrophically before the next
freeze, revert immediately — the re-run cap bounds the extra local VLM load.

## 6. Hallucination mitigations in effect during evaluation (P3-T2)

OCR attempts send greedy decoding by default (`temperature: 0` unless
overridden) and, when `BAYSTATE_CMS_OCR_RETRIES_ENABLED=true`, retry ONCE
with `frequency_penalty ≈ 0.3` when `detectRepetitionTail` fires
(success-with-retry recorded as a `retried_repetition` parser note).
Evaluate candidates WITH the same mitigation flags you intend to run in
production so numbers are comparable.

These mitigations apply on ALL live OCR transports, including the AI
Compute openai-compatible dispatcher path: sampling options thread through
callVlmWithDispatcher → dispatchWorkloadChat into the request body. Note
the repetition heuristic requires ≥6 consecutive single-token repeats
(multi-token n-grams: ≥3), so legitimately repeated printed lines do not
trigger the penalized retry.

## 7. Default visionOcr routing decision (local-first, issue #333)

Record of the operator-side default-routing decision (2026-10-03, verified
live; issue #333):

- **Decision: local-first.** The default (non-run-bound) packaging-OCR path
  resolves through the AI Compute `visionOcr` dispatcher to the enabled local
  Ollama route (`qwen2.5vl:latest`, loopback). Rationale: zero marginal cost,
  verified working against a real package image, and immune to cloud credit
  exhaustion silently zeroing OCR evidence (species/productForm/lifeStage all
  lose a source when a cloud primary 429s with no fallback engaged).
- **Production state:** `visionOcr` is explicitly local-only (text + images
  device-local, no cloud fallback, fail-closed). Old frozen run plans keep
  their frozen local route — unchanged by this decision.
- **Code behavior (shipped with this decision):** when a *cloud* `visionOcr`
  primary fails closed on quota (HTTP 429) with no configured fallback,
  `callVlmWithDispatcher` falls back to the enabled local route (legacy
  `api_keys.ollama_vlm` when enabled, else the first enabled loopback AI
  Compute connection) and surfaces an actionable warning — persisted as a
  `cloud_quota_fallback` parser note on the OCR metadata plus an
  `ACTION REQUIRED` log (top up credits or set the `visionOcr` primary to
  the local route). Any other failure, and any run-bound (frozen-plan) call,
  behaves exactly as before.
- **If cloud stays in the path:** a 429 on the primary must page, not just
  log — treat the `ACTION REQUIRED` warning as the paging trigger until a
  dedicated alerting seam exists.
