#!/usr/bin/env bun
/**
 * TypeSafe Jev Curation Workflow Qualification Runner (Issue #302, blocker fix #293).
 *
 * Honest captured evaluation over a frozen GOLD-ONLY fixture
 * (`src/tests/fixtures/benchmark-jev-qualification-goldset.json` carries
 * adjudicated gold labels + evidence + the frozen taxonomy snapshot — never
 * stored predictions). Both prediction sides are CAPTURED from the current
 * classification code into an immutable, hash-bound artifact, and that
 * artifact is what gets scored by the existing evaluator
 * (`evaluateJevOfflineComparison`). Legacy fixture copies that still embed
 * `baseline`/`candidate` keys load fine — those keys are ignored and never
 * scored.
 *
 * Capture modes (see `src/classification/benchmark-prediction.ts`):
 * - Default (CI-safe, no network): deterministic floor. The baseline side is
 *   the real deterministic matcher (`deterministic_floor`); the candidate
 *   side is `blocked` (`jev_credentials_absent`). The report therefore
 *   cannot evidence candidate quality and fails closed by construction.
 * - `--live-capture` with an explicit TYPESAFE_API_KEY: the candidate side
 *   captures real Jev judgments (`live_captured` with model identity +
 *   usage); without the key the side stays `blocked` — never simulated.
 * - `--baseline-provider <p> --baseline-model <m>`: the baseline side follows
 *   incumbent precedence (deterministic first, then the legacy chat ranker
 *   for unresolved stages) with credentials resolved from the existing
 *   provider store; unresolvable credentials record `blocked`.
 *
 * Live contract evidence is wired, not hardcoded: `--live-check` (or
 * TYPESAFE_LIVE_CHECK=1) with a provisioned TYPESAFE_API_KEY executes the
 * real bounded contract script as a subprocess and feeds its actual result
 * into the qualification assessment. Staged-canary sign-offs are read from
 * an explicit receipts file (TYPESAFE_CANARY_RECEIPTS_PATH) or
 * TYPESAFE_CANARY_*_REVIEWED env flags — defaulting to unreviewed
 * (fail-closed) when absent. Family separation is proven live via the
 * shipped `verifyFamilySeparation` over the loaded gold entries (never
 * rebuilt here). Compatibility is attested by an operator-kept receipts
 * file (TYPESAFE_COMPAT_RECEIPTS_PATH) or inline
 * TYPESAFE_COMPAT_RECEIPT_JSON — absent or malformed keeps the fail-closed
 * blocker. Operator docs are bound live by hashing the published runbook
 * bytes, so doc edits change the receipt hash and invalidate prior outputs.
 *
 * Usage:
 *   bun scripts/typesafe-curation-qualification.ts [--split=dev|holdout] [--json] [--live-check] [--live-capture] [--model=jev-1.13.0] [--baseline-provider=ollama] [--baseline-model=llama3] [--artifact-out=path]
 *   TYPESAFE_LIVE_CHECK=1 TYPESAFE_API_KEY=... bun scripts/typesafe-curation-qualification.ts --live-capture --live-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  evaluateJevOfflineComparison,
  assessProductionQualification,
  REQUIRED_COMPATIBILITY_SUITE_IDS,
  OPERATOR_RUNBOOK_PATH,
  type QualificationGoldset,
} from '../src/classification/jev-qualification-service';
import { verifyFamilySeparation } from '../src/classification/benchmark-exporter';
import {
  CompatibilityReceiptSchema,
  OperatorDocsReceiptSchema,
  type CompatibilityReceipt,
  type FamilySeparationProof,
  type OperatorDocsReceipt,
} from '../src/shared/schemas/classification';
import {
  parseQualificationGoldOnly,
  buildQualificationPredictionsFromCode,
  captureQualificationPredictionsLive,
  QUALIFICATION_PREDICTOR_VERSION,
  type ExecutedQualificationPrediction,
  type QualificationPredictionArtifact,
} from '../src/classification/benchmark-prediction';
import { FrozenTaxonomySnapshotSchema } from '../src/shared/schemas/classification';

const GOLDSET_PATH = path.resolve(
  import.meta.dir,
  '../src/tests/fixtures/benchmark-jev-qualification-goldset.json',
);
const LIVE_CHECK_PATH = path.resolve(import.meta.dir, './typesafe-live-contract-check.ts');

const isJson = process.argv.includes('--json');
const isLiveCheckFlag = process.argv.includes('--live-check');
const isLiveCaptureFlag = process.argv.includes('--live-capture');
const splitArg = process.argv.find(a => a.startsWith('--split='))?.split('=')[1] as 'dev' | 'holdout' | undefined;
const modelArg = process.argv.find(a => a.startsWith('--model='))?.split('=')[1];
const baselineProviderArg = process.argv.find(a => a.startsWith('--baseline-provider='))?.split('=')[1];
const baselineModelArg = process.argv.find(a => a.startsWith('--baseline-model='))?.split('=')[1];
const artifactOutArg = process.argv.find(a => a.startsWith('--artifact-out='))?.split('=')[1];

if (!fs.existsSync(GOLDSET_PATH)) {
  console.error(`Goldset fixture not found at ${GOLDSET_PATH}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(GOLDSET_PATH, 'utf8'));
// Fail-closed on legacy authored predictions: they may exist in older copies
// for readability, but they must never be scored. The loader strips them;
// this notice makes any such copy visible instead of silently trusted.
if (Array.isArray(raw.entries) && raw.entries.some((e: unknown) => {
  const r = e as Record<string, unknown>;
  return 'baseline' in r || 'candidate' in r;
})) {
  console.error(
    'Note: fixture copy embeds legacy baseline/candidate predictions; ignoring them — predictions will be executed from code.',
  );
}
const goldEntries = parseQualificationGoldOnly(raw);

// Candidate option sets come from the frozen taxonomy snapshot — never the
// union of gold labels. A present-but-malformed snapshot fails closed;
// legacy fixtures without one fall back to the labeled gold-union pool.
const frozenTaxonomy = raw.frozenTaxonomy ?? null;
if (frozenTaxonomy !== null) {
  const parsed = FrozenTaxonomySnapshotSchema.safeParse(frozenTaxonomy);
  if (!parsed.success) {
    console.error(`Fixture frozenTaxonomy failed validation: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    process.exit(1);
  }
}

// 1. Capture baseline + candidate predictions into an immutable artifact.
//    Default: deterministic floor (no network). Opt-in live capture for the
//    candidate (`--live-capture` + TYPESAFE_API_KEY) and/or the baseline
//    chat leg (`--baseline-provider` + `--baseline-model`).
const apiKey = process.env.TYPESAFE_API_KEY ?? '';
const hasKey = apiKey.length >= 8;
const baselineRoute = baselineProviderArg && baselineModelArg
  ? { provider: baselineProviderArg, model: baselineModelArg }
  : null;
if (isLiveCaptureFlag && !hasKey) {
  console.error(
    'Note: --live-capture requested without a provisioned TYPESAFE_API_KEY; the candidate side will be recorded as blocked (jev_credentials_absent), never simulated.',
  );
}
let artifact: QualificationPredictionArtifact;
if (isLiveCaptureFlag || baselineRoute) {
  artifact = await captureQualificationPredictionsLive(
    goldEntries,
    {
      jev: hasKey ? { apiKey, ...(modelArg ? { model: modelArg } : {}) } : null,
      baselineRoute,
    },
    frozenTaxonomy,
  );
} else {
  artifact = buildQualificationPredictionsFromCode(goldEntries, frozenTaxonomy);
}

// 2. Score the executed artifact with the existing evaluator (unchanged).
const goldset: QualificationGoldset = {
  version: raw.version,
  description: raw.description,
  adjudicatedBy: raw.adjudicatedBy,
  verifiedPageImport: raw.verifiedPageImport,
  entries: goldEntries.map(e => {
    const p = artifact.predictions.find(x => x.sku === e.sku);
    if (!p) throw new Error(`Missing executed prediction for gold entry "${e.sku}".`);
    return {
      sku: e.sku,
      familyId: e.familyId,
      split: e.split,
      assortment: e.assortment,
      gold: e.gold,
      evidence: e.evidence,
      baseline: { ...p.baseline },
      candidate: { ...p.candidate },
    };
  }),
};

const comparisonReport = evaluateJevOfflineComparison(goldset, splitArg);

if (artifactOutArg) {
  fs.writeFileSync(artifactOutArg, JSON.stringify(artifact, null, 2));
}

// 3. Wire the REAL live-contract check result (opt-in, never required for CI).
const liveCheckRequested = isLiveCheckFlag || process.env.TYPESAFE_LIVE_CHECK === '1';
let liveContractCheckExecuted = false;
let liveContractCheckSuccess = false;
let liveCheckDetail: string;
if (!liveCheckRequested) {
  liveCheckDetail = 'not requested (pass --live-check with TYPESAFE_API_KEY to run the bounded live check)';
} else if (!hasKey) {
  liveCheckDetail = 'requested but TYPESAFE_API_KEY is not provisioned; refusing to run';
} else {
  const proc = Bun.spawnSync(
    ['bun', LIVE_CHECK_PATH, ...(modelArg ? [`--model=${modelArg}`] : [])],
    {
      env: { ...process.env, TYPESAFE_LIVE_CHECK: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  liveContractCheckExecuted = true;
  const stdoutText = proc.stdout.toString().trim();
  try {
    const parsed = JSON.parse(stdoutText) as { ok?: unknown };
    liveContractCheckSuccess = proc.exitCode === 0 && parsed.ok === true;
    liveCheckDetail = liveContractCheckSuccess
      ? `executed via ${path.basename(LIVE_CHECK_PATH)}: ok=true (exit 0)`
      : `executed via ${path.basename(LIVE_CHECK_PATH)}: ok=false (exit ${proc.exitCode}) ${(proc.stderr.toString() || stdoutText).slice(0, 300)}`;
  } catch {
    liveCheckDetail = `executed via ${path.basename(LIVE_CHECK_PATH)}: unparseable output (exit ${proc.exitCode}) ${(proc.stderr.toString() || stdoutText).slice(0, 300)}`;
  }
}

// 4. Staged-canary sign-offs from explicit operator receipts (fail-closed default).
interface CanaryReceipts {
  productType: boolean;
  attributes: boolean;
  cohortPages: boolean;
  source: string;
}

function emptyCanaryReceipts(): CanaryReceipts {
  return {
    productType: false,
    attributes: false,
    cohortPages: false,
    source: 'none provided (unreviewed)',
  };
}

/** Read canary sign-offs from the receipts file (fail-closed when unreadable). */
function readCanaryReceiptsFile(receipts: CanaryReceipts, receiptsPath: string): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptsPath, 'utf8')) as {
      productTypeReviewed?: unknown;
      attributesReviewed?: unknown;
      cohortPagesReviewed?: unknown;
    };
    receipts.productType = parsed.productTypeReviewed === true;
    receipts.attributes = parsed.attributesReviewed === true;
    receipts.cohortPages = parsed.cohortPagesReviewed === true;
    receipts.source = `file ${receiptsPath}`;
  } catch (err) {
    console.error(
      `Warning: TYPESAFE_CANARY_RECEIPTS_PATH unreadable (${err instanceof Error ? err.message : String(err)}); treating canaries as unreviewed.`,
    );
    receipts.source = `unreadable file ${receiptsPath} (unreviewed)`;
  }
}

/** Env override flags for canary sign-offs (keyed by receipt field). */
const CANARY_ENV_FLAGS = [
  ['TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED', 'productType'],
  ['TYPESAFE_CANARY_ATTRIBUTES_REVIEWED', 'attributes'],
  ['TYPESAFE_CANARY_COHORT_PAGES_REVIEWED', 'cohortPages'],
] as const;

/** True when any canary env override flag is set. */
function hasCanaryEnvOverrides(): boolean {
  return CANARY_ENV_FLAGS.some(([envVar]) => process.env[envVar] === '1');
}

/** Label env-sourced receipts when no file source was recorded. */
function labelCanaryEnvSource(receipts: CanaryReceipts): void {
  if (receipts.source === 'none provided (unreviewed)' && hasCanaryEnvOverrides()) {
    receipts.source = 'env TYPESAFE_CANARY_*_REVIEWED';
  }
}

/** Apply TYPESAFE_CANARY_*_REVIEWED env overrides on top of file receipts. */
function applyCanaryEnvOverrides(receipts: CanaryReceipts): void {
  for (const [envVar, key] of CANARY_ENV_FLAGS) {
    if (process.env[envVar] === '1') receipts[key] = true;
  }
  labelCanaryEnvSource(receipts);
}

function readCanaryReceipts(): CanaryReceipts {
  const receipts = emptyCanaryReceipts();
  const receiptsPath = process.env.TYPESAFE_CANARY_RECEIPTS_PATH;
  if (receiptsPath) {
    readCanaryReceiptsFile(receipts, receiptsPath);
  }
  applyCanaryEnvOverrides(receipts);
  return receipts;
}
const canary = readCanaryReceipts();

// 5. Family-separation proof computed live via the shipped verifier over the
// loaded gold entries (no operator input — deterministic, never rebuilt
// here). Verification failure keeps the fail-closed blocker below.
let familySeparationProof: FamilySeparationProof | null = null;
let familyProofDetail: string;
try {
  const proof = verifyFamilySeparation(goldEntries);
  familySeparationProof = proof;
  familyProofDetail = proof.passed
    ? `${proof.proofVersion} over ${proof.familiesChecked} families: passed (zero leakage, verified live)`
    : `${proof.proofVersion} over ${proof.familiesChecked} families: FAILED (${proof.leakedFamilies.length} leaked, ${proof.nearDuplicatePairs.length} near-duplicates)`;
} catch (err) {
  familyProofDetail = `verification failed (${err instanceof Error ? err.message : String(err)}); treating as unverified`;
  console.error(`Warning: family-separation verification failed; keeping the fail-closed blocker.`);
}

// 6. Compatibility receipt from explicit operator records (fail-closed default).
interface CompatibilityInput {
  receipt: CompatibilityReceipt | null;
  source: string;
  detail: string;
}

/** Validate a parsed compat receipt value (malformed → null, never silently accepted). */
function validateCompatReceiptValue(value: unknown, source: string): CompatibilityInput {
  const parsed = CompatibilityReceiptSchema.safeParse(value);
  if (!parsed.success) {
    console.error(
      `Warning: compatibility receipt ${source} malformed (${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}); treating as unverified.`,
    );
    return {
      receipt: null,
      source: `malformed ${source} (unverified)`,
      detail: `malformed ${source}; expected suites [${REQUIRED_COMPATIBILITY_SUITE_IDS.join(', ')}] with commit + pass status`,
    };
  }
  const suites = parsed.data.suites.map(s => `${s.suiteId}@${s.commit.slice(0, 12)}${s.passed ? '' : ':FAILED'}`).join(', ');
  return {
    receipt: parsed.data,
    source,
    detail: `${source}: ${parsed.data.suites.length} suites (${suites}) recorded ${parsed.data.recordedAt}`,
  };
}

/** Inline env compat receipt (malformed JSON → coded unverified, never throws). */
function readInlineCompatibilityReceipt(inlineJson: string): CompatibilityInput {
  try {
    return validateCompatReceiptValue(JSON.parse(inlineJson), 'env TYPESAFE_COMPAT_RECEIPT_JSON');
  } catch (err) {
    console.error(
      `Warning: TYPESAFE_COMPAT_RECEIPT_JSON unparseable (${err instanceof Error ? err.message : String(err)}); treating as unverified.`,
    );
    return {
      receipt: null,
      source: 'malformed env TYPESAFE_COMPAT_RECEIPT_JSON (unverified)',
      detail: 'malformed env TYPESAFE_COMPAT_RECEIPT_JSON; expected suites [other-providers, deterministic-rules, frozen-snapshots, legacy-reads] with commit + pass status',
    };
  }
}

/** File compat receipt (unreadable/malformed → coded unverified, never throws). */
function readFileCompatibilityReceipt(receiptsPath: string): CompatibilityInput {
  try {
    return validateCompatReceiptValue(
      JSON.parse(fs.readFileSync(receiptsPath, 'utf8')),
      `file ${receiptsPath}`,
    );
  } catch (err) {
    console.error(
      `Warning: TYPESAFE_COMPAT_RECEIPTS_PATH unreadable (${err instanceof Error ? err.message : String(err)}); treating as unverified.`,
    );
    return {
      receipt: null,
      source: `unreadable file ${receiptsPath} (unverified)`,
      detail: `unreadable file ${receiptsPath}; expected suites [${REQUIRED_COMPATIBILITY_SUITE_IDS.join(', ')}] with commit + pass status`,
    };
  }
}

/** Absent compat receipt (fail-closed default). */
function absentCompatibilityReceipt(): CompatibilityInput {
  return {
    receipt: null,
    source: 'none provided (unverified)',
    detail: `none provided; expected suites [${REQUIRED_COMPATIBILITY_SUITE_IDS.join(', ')}] with commit + pass status`,
  };
}

/** Read the compat receipt: inline env JSON wins, else the receipts file, else absent. */
function readCompatibilityReceipt(): CompatibilityInput {
  const inlineJson = process.env.TYPESAFE_COMPAT_RECEIPT_JSON?.trim();
  if (inlineJson) return readInlineCompatibilityReceipt(inlineJson);
  const receiptsPath = process.env.TYPESAFE_COMPAT_RECEIPTS_PATH;
  if (receiptsPath) return readFileCompatibilityReceipt(receiptsPath);
  return absentCompatibilityReceipt();
}
const compat = readCompatibilityReceipt();

// 7. Operator-docs receipt bound live to the published runbook bytes: the
// content hash is computed at runtime, so any doc edit changes the receipt
// and visibly invalidates prior qualification outputs. Unreadable runbook
// keeps the fail-closed blocker.
let operatorDocsReceipt: OperatorDocsReceipt | null = null;
let operatorDocsDetail: string;
try {
  const runbookAbsPath = path.resolve(import.meta.dir, '..', OPERATOR_RUNBOOK_PATH);
  const bytes = fs.readFileSync(runbookAbsPath);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const publishedAt = fs.statSync(runbookAbsPath).mtime.toISOString();
  const parsed = OperatorDocsReceiptSchema.safeParse({
    runbookPath: OPERATOR_RUNBOOK_PATH,
    contentHash,
    publishedAt,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  operatorDocsReceipt = parsed.data;
  operatorDocsDetail = `${OPERATOR_RUNBOOK_PATH} sha256:${contentHash.slice(0, 12)}… (computed live)`;
} catch (err) {
  operatorDocsDetail = `runbook unreadable (${err instanceof Error ? err.message : String(err)}); treating as unpublished`;
  console.error(`Warning: operator runbook unreadable; keeping the fail-closed blocker.`);
}

const assessment = assessProductionQualification({
  hasTypeSafeApiKey: hasKey,
  liveContractCheckExecuted,
  liveContractCheckSuccess,
  canaryProductTypeReviewed: canary.productType,
  canaryAttributesReviewed: canary.attributes,
  canaryCohortPagesReviewed: canary.cohortPages,
  familySeparationProof,
  compatibilityReceipt: compat.receipt,
  operatorDocsReceipt,
  offlineComparisonReport: comparisonReport,
});

/** Count one prediction side (baseline/candidate) toward its source rollup. */
function countPredictionSourceLabel(
  side: ExecutedQualificationPrediction,
  counts: Record<string, number>,
): void {
  const source = side.source ?? 'unknown';
  counts[source] = (counts[source] ?? 0) + 1;
}

/** Count a blocked side toward the blocked-code rollup (no-op when unblocked). */
function countBlockedCode(
  side: ExecutedQualificationPrediction,
  blockedCodes: Record<string, number>,
): void {
  if (side.source === 'blocked' && side.blockedCode) {
    blockedCodes[side.blockedCode] = (blockedCodes[side.blockedCode] ?? 0) + 1;
  }
}

/** Count one prediction side (baseline/candidate) toward source + blocked-code rollups. */
function countPredictionSideSource(
  side: ExecutedQualificationPrediction,
  counts: Record<string, number>,
  blockedCodes: Record<string, number>,
): void {
  countPredictionSourceLabel(side, counts);
  countBlockedCode(side, blockedCodes);
}

/** Model-identity, usage, and routing accumulators for the source rollup. */
interface PredictionProvenanceAccumulators {
  requested: Set<string | null>;
  resolved: Set<string | null>;
  routes: Set<string | null>;
  inputTokens: number;
  outputTokens: number;
}

/** Accumulate candidate model identity (requested/resolved) for one prediction pair. */
function accumulateCandidateModelIdentity(
  p: QualificationPredictionArtifact['predictions'][number],
  acc: PredictionProvenanceAccumulators,
): void {
  const pairs: Array<{ value: string | null | undefined; target: Set<string | null> }> = [
    { value: p.candidate.requestedModel, target: acc.requested },
    { value: p.candidate.resolvedModel, target: acc.resolved },
  ];
  for (const pair of pairs) {
    if (pair.value !== undefined) pair.target.add(pair.value ?? null);
  }
}

/** Accumulate candidate usage for one prediction pair. */
function accumulateCandidateUsage(
  p: QualificationPredictionArtifact['predictions'][number],
  acc: PredictionProvenanceAccumulators,
): void {
  if (p.candidate.usage) {
    acc.inputTokens += p.candidate.usage.inputTokens ?? 0;
    acc.outputTokens += p.candidate.usage.outputTokens ?? 0;
  }
}

/** Accumulate baseline routing for one prediction pair. */
function accumulateBaselineRoute(
  p: QualificationPredictionArtifact['predictions'][number],
  acc: PredictionProvenanceAccumulators,
): void {
  if (p.baseline.provider !== undefined) acc.routes.add(p.baseline.provider ?? null);
}

/** Accumulate model identity + usage + routing for one executed prediction pair. */
function accumulatePredictionIdentity(
  p: QualificationPredictionArtifact['predictions'][number],
  acc: PredictionProvenanceAccumulators,
): void {
  accumulateCandidateModelIdentity(p, acc);
  accumulateCandidateUsage(p, acc);
  accumulateBaselineRoute(p, acc);
}

/**
 * Per-side prediction-source rollup (additive): what each source label
 * means — `live_captured` (real model judgment, identity + usage recorded),
 * `deterministic_floor` (real deterministic matcher, no model consulted — a
 * lower bound, never candidate quality evidence), `blocked` (coded reason,
 * never quality evidence; counted as a service failure fail-closed).
 */
function summarizePredictionSources(): {
  baseline: Record<string, number>;
  candidate: Record<string, number>;
  blockedCodes: Record<string, number>;
  jevModels: { requested: Array<string | null>; resolved: Array<string | null> };
  jevUsage: { inputTokens: number; outputTokens: number };
  baselineRoutes: Array<string | null>;
} {
  const baseline: Record<string, number> = {};
  const candidate: Record<string, number> = {};
  const blockedCodes: Record<string, number> = {};
  const acc: PredictionProvenanceAccumulators = {
    requested: new Set<string | null>(),
    resolved: new Set<string | null>(),
    routes: new Set<string | null>(),
    inputTokens: 0,
    outputTokens: 0,
  };
  for (const p of artifact.predictions) {
    countPredictionSideSource(p.baseline, baseline, blockedCodes);
    countPredictionSideSource(p.candidate, candidate, blockedCodes);
    accumulatePredictionIdentity(p, acc);
  }
  return {
    baseline,
    candidate,
    blockedCodes,
    jevModels: { requested: [...acc.requested], resolved: [...acc.resolved] },
    jevUsage: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
    baselineRoutes: [...acc.routes],
  };
}
const predictionSources = summarizePredictionSources();

const predictionProvenance = {
  predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
  artifactHash: artifact.artifactHash,
  predictedAt: artifact.predictedAt,
  entryCount: artifact.entryCount,
  captureMode: artifact.captureMode,
  taxonomySource: artifact.taxonomySource,
  frozenTaxonomyHash: artifact.frozenTaxonomyHash,
  fixtureVersion: raw.version,
  fixturePath: GOLDSET_PATH,
  sources: predictionSources,
  liveCaptureRequested: isLiveCaptureFlag,
  baselineRoute: baselineRoute ? `${baselineRoute.provider}/${baselineRoute.model}` : null,
  offlineLatencyNote:
    'Offline latencies are measured in-process decision compute, not live model serving; live latency/cost are proven via the bounded live-contract check and staged canaries.',
  blockedNote:
    'Blocked prediction sides carry their coded reason (blockedCode) and count as service failures in the comparison report (fail-closed); they never evidence quality.',
};
const liveCheckProvenance = {
  requested: liveCheckRequested,
  executed: liveContractCheckExecuted,
  success: liveContractCheckSuccess,
  detail: liveCheckDetail,
};
const canaryProvenance = {
  productTypeReviewed: canary.productType,
  attributesReviewed: canary.attributes,
  cohortPagesReviewed: canary.cohortPages,
  source: canary.source,
};
const familyProvenance = {
  proof: familySeparationProof,
  detail: familyProofDetail,
  source: 'computed live via verifyFamilySeparation over goldset familyIds',
};
const compatibilityProvenance = {
  receipt: compat.receipt,
  source: compat.source,
  detail: compat.detail,
};
const operatorDocsProvenance = {
  receipt: operatorDocsReceipt,
  detail: operatorDocsDetail,
  source: 'computed live by hashing the published runbook bytes',
};

if (isJson) {
  console.log(JSON.stringify({
    comparisonReport,
    assessment,
    predictionArtifact: artifact,
    predictionProvenance,
    liveCheck: liveCheckProvenance,
    canary: canaryProvenance,
    family: familyProvenance,
    compatibility: compatibilityProvenance,
    operatorDocs: operatorDocsProvenance,
  }, null, 2));
  process.exit(0);
}

console.log('======================================================================');
console.log('   TYPESAFE JEV CURATION WORKFLOW QUALIFICATION REPORT (ISSUE #302)   ');
console.log('======================================================================\n');

console.log(`Predictions:      captured from code (${predictionProvenance.predictorVersion}, mode ${artifact.captureMode}, artifact ${artifact.artifactHash.slice(0, 12)}… over ${artifact.entryCount} gold entries)`);
console.log(`Taxonomy pool:    ${artifact.taxonomySource}${artifact.frozenTaxonomyHash ? ` (${artifact.frozenTaxonomyHash.slice(0, 12)}…)` : ''}`);
console.log(`Sources:          baseline ${JSON.stringify(predictionSources.baseline)} | candidate ${JSON.stringify(predictionSources.candidate)}`);
if (Object.keys(predictionSources.blockedCodes).length > 0) {
  console.log(`Blocked codes:    ${JSON.stringify(predictionSources.blockedCodes)} (counted as service failures, fail-closed)`);
}
console.log(`Live check:       ${liveCheckDetail}`);
console.log(`Canary receipts:  ${canary.source} (PT=${canary.productType} Attr=${canary.attributes} Pages=${canary.cohortPages})`);
console.log(`Family proof:     ${familyProofDetail}`);
console.log(`Compatibility:    ${compat.detail}`);
console.log(`Operator docs:    ${operatorDocsDetail}\n`);

console.log(`Evaluated Examples: ${comparisonReport.evaluatedExamples} (Dev: ${comparisonReport.devCount}, Holdout: ${comparisonReport.holdoutCount})`);
console.log(`Adjudicated By:     ${goldset.adjudicatedBy}\n`);

console.log('--- 1. PRIMARY PRODUCT TYPE COMPARISON ---');
console.log(`  Raw Correctness: Baseline ${(comparisonReport.productType.rawCorrectness.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.productType.rawCorrectness.candidate * 100).toFixed(1)}% (Delta: ${comparisonReport.productType.rawCorrectness.delta > 0 ? '+' : ''}${(comparisonReport.productType.rawCorrectness.delta * 100).toFixed(1)}%)`);
console.log(`  Coverage:        Baseline ${(comparisonReport.productType.coverage.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.productType.coverage.candidate * 100).toFixed(1)}%`);
console.log(`  Incorrect:       Baseline ${comparisonReport.productType.incorrectProposals.baseline} | Jev ${comparisonReport.productType.incorrectProposals.candidate}`);
console.log(`  Regressions:     ${comparisonReport.productType.harmfulRegressions}`);
console.log(`  Recovered:       ${comparisonReport.productType.recoveredAbstentions}`);
console.log(`  Service Failures:${comparisonReport.productType.serviceFailures.candidate}\n`);

console.log('--- 2. CONTROLLED ATTRIBUTES COMPARISON ---');
console.log(`  Raw Correctness: Baseline ${(comparisonReport.attributes.rawCorrectness.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.attributes.rawCorrectness.candidate * 100).toFixed(1)}%`);
console.log(`  Set F1 Score:    Baseline ${comparisonReport.attributes.setMetrics.f1.baseline.toFixed(3)} | Jev ${comparisonReport.attributes.setMetrics.f1.candidate.toFixed(3)}`);
console.log(`  Set Precision:   Baseline ${comparisonReport.attributes.setMetrics.precision.baseline.toFixed(3)} | Jev ${comparisonReport.attributes.setMetrics.precision.candidate.toFixed(3)}`);
console.log(`  Set Recall:      Baseline ${comparisonReport.attributes.setMetrics.recall.baseline.toFixed(3)} | Jev ${comparisonReport.attributes.setMetrics.recall.candidate.toFixed(3)}`);
console.log(`  Exact Match:     Baseline ${(comparisonReport.attributes.setMetrics.exactMatch.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.attributes.setMetrics.exactMatch.candidate * 100).toFixed(1)}%\n`);

console.log('--- 3. CATEGORY PAGES & COHORTS COMPARISON ---');
console.log(`  Page Exact Match:Baseline ${(comparisonReport.categoryPages.setMetrics.exactMatch.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.categoryPages.setMetrics.exactMatch.candidate * 100).toFixed(1)}%`);
console.log(`  Page F1 Score:   Baseline ${comparisonReport.categoryPages.setMetrics.f1.baseline.toFixed(3)} | Jev ${comparisonReport.categoryPages.setMetrics.f1.candidate.toFixed(3)}`);
console.log(`  Page Precision:  Baseline ${comparisonReport.categoryPages.setMetrics.precision.baseline.toFixed(3)} | Jev ${comparisonReport.categoryPages.setMetrics.precision.candidate.toFixed(3)}`);
console.log(`  Page Recall:     Baseline ${comparisonReport.categoryPages.setMetrics.recall.baseline.toFixed(3)} | Jev ${comparisonReport.categoryPages.setMetrics.recall.candidate.toFixed(3)}\n`);

console.log('--- 4. END-TO-END PIPELINE EFFECTS ---');
console.log(`  Total Evaluated: ${comparisonReport.endToEndPipeline.totalMembers}`);
console.log(`  Correct Type:    ${comparisonReport.endToEndPipeline.typeResolution.correct}`);
console.log(`  Attrs Correct:   ${comparisonReport.endToEndPipeline.attributeEffects.correctWhenTypeCorrect}`);
console.log(`  Pages Match:     ${comparisonReport.endToEndPipeline.pageEffects.exactMatchWhenTypeCorrect}`);
console.log(`  All Stages OK:   ${comparisonReport.endToEndPipeline.endToEndCorrectAllStages}\n`);

console.log('--- 5. LATENCY & COST TELEMETRY ---');
console.log(`  Mean Latency:    Baseline ${comparisonReport.telemetry.latency.baseline.meanMs}ms | Jev ${comparisonReport.telemetry.latency.candidate.meanMs}ms`);
console.log(`  P95 Latency:     Baseline ${comparisonReport.telemetry.latency.baseline.p95Ms}ms | Jev ${comparisonReport.telemetry.latency.candidate.p95Ms}ms`);
console.log(`  Estimated Cost:  Baseline $${comparisonReport.telemetry.estimatedCostUsd.baseline.toFixed(4)} | Jev $${comparisonReport.telemetry.estimatedCostUsd.candidate.toFixed(4)}`);
console.log(`  Note: ${comparisonReport.telemetry.operatorTimeNote}`);
console.log(`  Note: ${predictionProvenance.offlineLatencyNote}\n`);

console.log('--- 6. PRODUCTION QUALIFICATION ASSESSMENT ---');
console.log(`  Status: ${assessment.status.toUpperCase()}`);
console.log(`  Summary: ${assessment.summary}\n`);

if (assessment.blockers.length > 0) {
  console.log('  Active Operational Blockers:');
  for (const b of assessment.blockers) {
    console.log(`    [Criterion ${b.criterion} - ${b.area}] ${b.code}:`);
    console.log(`      ${b.message}`);
    console.log(`      -> Action: ${b.actionRequired}`);
  }
  console.log('');
}

console.log('======================================================================');
