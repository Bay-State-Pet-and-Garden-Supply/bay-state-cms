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
 *
 * Bounded dev replay (no agent LIVE calls; primary runs real inference after
 * verifying the guard):
 *   bun scripts/typesafe-curation-qualification.ts --manifest docs/audits/jev-representative-v1/manifest.json --gold docs/audits/jev-representative-v1/development-gold.json --taxonomy docs/audits/jev-representative-v1/taxonomy.json [--split=dev] [--max-attempts=600] [--concurrency=2] [--deadline-ms=60000]
 * Dev candidate-only live capture additionally needs explicit
 * `--live-capture --model=<id>` + TYPESAFE_API_KEY: a bound attempt guard
 * (600 max attempts, ≤2 concurrency, hard deadline) is enforced inside every
 * real request attempt, primary + retry. Real inference command (primary):
 *   TYPESAFE_API_KEY=... bun scripts/typesafe-curation-qualification.ts --manifest docs/audits/jev-representative-v1/manifest.json --gold docs/audits/jev-representative-v1/development-gold.json --taxonomy docs/audits/jev-representative-v1/taxonomy.json --live-capture --model=jev-1.13.0 [--max-attempts=600] [--deadline-ms=300000]
 * Default runs (no --live-capture) never touch the network even with an
 * ambient key, and the key value is never printed.
 * `--isolated-store=<path>` + TYPESAFE_BASELINE_CREDENTIAL_REF (production
 * DB is never initialized; otherwise the labeled deterministic_floor).
 * Private holdout custody is never readable here (denied before load).
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDb } from '../src/db/connection';
import { createHash } from 'node:crypto';
import {
  evaluateJevOfflineComparison,
  evaluateJevQualificationGate,
  assessProductionQualification,
  evaluationStatusText,
  measuredPercent,
  measuredScore,
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
  withFrozenAuthorityDetails,
  QUALIFICATION_PREDICTOR_VERSION,
  type ExecutedQualificationPrediction,
  type QualificationPredictionArtifact,
} from '../src/classification/benchmark-prediction';
import { FrozenTaxonomySnapshotSchema } from '../src/shared/schemas/classification';
import {
  REPRESENTATIVE_DEV_GOLD_PATH,
  REPRESENTATIVE_MANIFEST_PATH,
  REPRESENTATIVE_TAXONOMY_PATH,
  assertNoHoldoutAccess,
  createDevAttemptGuard,
  defaultDevReplayBudget,
  dryRunBudgetPreflight,
  assertLiveCaptureAllowed,
  isLiveRuntimeGuardWired,
  planDevReplayBudget,
  resolveBaselineRoute,
  assertIsolatedBaselineStore,
  resolveDevCaptureMode,
  loadDevReplayInputs,
  DEV_REPLAY_UNSUPPORTED_CAPABILITIES,
  REPLAY_CONTEXT_ISOLATED_SINGLE_CHOICE,
  DEV_CALIBRATION_NOTE,
} from '../src/classification/jev-benchmark-replay';

const LIVE_CHECK_PATH = path.resolve(import.meta.dir, './typesafe-live-contract-check.ts');

/** Flag value in `--flag=value` or `--flag value` form (dev-replay flags accept both). */
function flagValue(name: string): string | null {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const isJson = process.argv.includes('--json');
const isLiveCheckFlag = process.argv.includes('--live-check');
const isLiveCaptureFlag = process.argv.includes('--live-capture');
const modelArg = process.argv.find(a => a.startsWith('--model='))?.split('=')[1];
const baselineProviderArg = process.argv.find(a => a.startsWith('--baseline-provider='))?.split('=')[1];
const baselineModelArg = process.argv.find(a => a.startsWith('--baseline-model='))?.split('=')[1];
const artifactOutArg = process.argv.find(a => a.startsWith('--artifact-out='))?.split('=')[1];
const dbArg = process.argv.find(a => a.startsWith('--db='))?.slice('--db='.length);
// Bounded dev-replay inputs (issue #302 follow-up): explicit external
// manifest/gold + frozen authority. --split defaults to dev when any
// representative input is given; holdout labels load only at publication
// binding/custody explicit unseal (never here — see assertNoHoldoutAccess).
const manifestArg = flagValue('--manifest');
const goldArg = flagValue('--gold');
const taxonomyArg = flagValue('--taxonomy');
const representativeInputs = manifestArg ?? goldArg ?? taxonomyArg;
const splitArg = (flagValue('--split') ?? (representativeInputs ? 'dev' : undefined)) as 'dev' | 'holdout' | undefined;
const maxAttemptsArg = flagValue('--max-attempts');
const concurrencyArg = flagValue('--concurrency');
const deadlineMsArg = flagValue('--deadline-ms');
const isolatedStoreArg = flagValue('--isolated-store');
if (splitArg && !['dev', 'holdout'].includes(splitArg)) throw new Error('--split must be dev or holdout.');
if (representativeInputs && splitArg !== 'dev') throw new Error('Representative replay inputs are dev-only (--split=dev); holdout needs publication binding/custody explicit unseal.');
if (Boolean(baselineProviderArg) !== Boolean(baselineModelArg)) throw new Error('Provide both baseline provider and model.');
for (const p of [manifestArg, goldArg, taxonomyArg]) if (p) assertNoHoldoutAccess(p);

const GOLDSET_PATH = goldArg ?? path.resolve(
  import.meta.dir,
  '../src/tests/fixtures/benchmark-jev-qualification-goldset.json',
);

if (!fs.existsSync(GOLDSET_PATH)) {
  console.error(`Goldset fixture not found at ${GOLDSET_PATH}`);
  process.exit(1);
}

// Representative dev replay: explicit external manifest/gold + frozen
// authority (dev-only; holdout custody never loads here).
const devReplay = representativeInputs
  ? loadDevReplayInputs({
      manifestPath: manifestArg ?? REPRESENTATIVE_MANIFEST_PATH,
      goldPath: goldArg ?? REPRESENTATIVE_DEV_GOLD_PATH,
      taxonomyPath: taxonomyArg ?? REPRESENTATIVE_TAXONOMY_PATH,
    })
  : null;

const raw = devReplay ? null : JSON.parse(fs.readFileSync(GOLDSET_PATH, 'utf8'));
// Fail-closed on legacy authored predictions: they may exist in older copies
// for readability, but they must never be scored. The loader strips them;
// this notice makes any such copy visible instead of silently trusted.
if (raw && Array.isArray(raw.entries) && raw.entries.some((e: unknown) => {
  const r = e as Record<string, unknown>;
  return 'baseline' in r || 'candidate' in r;
})) {
  console.error(
    'Note: fixture copy embeds legacy baseline/candidate predictions; ignoring them — predictions will be executed from code.',
  );
}
const allGoldEntries = devReplay ? devReplay.goldEntries : parseQualificationGoldOnly(raw);
// Split before inference. A development run must never send sealed holdout
// evidence to either provider merely to discard it later during scoring.
const goldEntries = splitArg ? allGoldEntries.filter(entry => entry.split === splitArg) : allGoldEntries;

// Candidate option sets come from the frozen taxonomy snapshot — never the
// union of gold labels. A present-but-malformed snapshot fails closed;
// legacy fixtures without one fall back to the labeled gold-union pool.
const frozenTaxonomy = devReplay ? devReplay.frozenSnapshot : (raw.frozenTaxonomy ?? null);
if (frozenTaxonomy !== null) {
  const parsed = FrozenTaxonomySnapshotSchema.safeParse(frozenTaxonomy);
  if (!parsed.success) {
    console.error(`Fixture frozenTaxonomy failed validation: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    process.exit(1);
  }
}

// Dry-run budget preflight (before transport/chunks/retries): dev default
// 600 max HTTP attempts, max 2 concurrency. The plan is the EXACT derived
// worst case (entries × question batches × max retry — never clipped
// candidates); over-budget denies before dispatch. Live mode additionally
// needs the bound runtime guard supplied through the request path.
const replayBudget = defaultDevReplayBudget({
  ...(maxAttemptsArg ? { maxHttpAttempts: Number(maxAttemptsArg) } : {}),
  ...(concurrencyArg ? { maxConcurrency: Number(concurrencyArg) } : {}),
  ...(deadlineMsArg ? { hardDeadlineMs: Number(deadlineMsArg) } : {}),
});
const devPlan = isLiveCaptureFlag && devReplay && frozenTaxonomy
  ? planDevReplayBudget(goldEntries, devReplay.frozenSnapshot)
  : null;
if (devPlan) {
  console.error(`Plan: ${devPlan.entryCount} entries, ${devPlan.totalQuestions} questions, ${devPlan.dispatchBatches} batches, worst-case ${devPlan.plannedHttpAttempts} HTTP attempts (max ${replayBudget.maxHttpAttempts}).`);
}
const preflight = dryRunBudgetPreflight({
  entryCount: goldEntries.length,
  plannedHttpAttempts: devPlan ? devPlan.plannedHttpAttempts : (isLiveCaptureFlag ? goldEntries.length : 0),
  budget: replayBudget,
});
if (!preflight.allowed) {
  console.error(`Budget preflight denied: ${preflight.reason}`);
  process.exit(1);
}

// 1. Capture baseline + candidate predictions into an immutable artifact.
//    Default: deterministic floor (no network — an ambient TYPESAFE_API_KEY
//    alone never implies live; only explicit --live-capture does, and the key
//    value itself is never printed). Dev candidate-only live capture needs
//    explicit --live-capture --model + credential AND the bound attempt guard
//    wired through the real request path (else blocked with reason, never
//    simulated). New baseline live routes need --isolated-store + credential
//    ref (else the labeled deterministic floor — never a substituted
//    provider, never production DB; candidate-only dev mode performs no DB
//    init and no production writes).
const apiKey = process.env.TYPESAFE_API_KEY ?? '';
const hasKey = apiKey.length >= 8;
const baselineResolution = resolveBaselineRoute({
  provider: baselineProviderArg ?? null,
  model: baselineModelArg ?? null,
  isolatedStore: isolatedStoreArg ?? dbArg ?? null,
  credentialRef: process.env.TYPESAFE_BASELINE_CREDENTIAL_REF ?? null,
});
const baselineRoute = baselineResolution.route;
if (baselineResolution.blockedReason) {
  console.error(`Note: ${baselineResolution.blockedReason}`);
}
if (baselineRoute) {
  // NEVER initialize the production DB for replay: live baselines run only
  // against the explicit isolated store.
  if (!isolatedStoreArg) throw new Error('baseline_live_requires_isolated_store: pass --isolated-store=<path> (production DB is never initialized for replay).');
  if (!fs.existsSync(isolatedStoreArg)) throw new Error('Live incumbent capture requires an initialized isolated workspace database (--isolated-store=path).');
  const isolatedStore = assertIsolatedBaselineStore(isolatedStoreArg, {
    repositoryRoot: path.resolve(import.meta.dir, '..'),
    productionStorePaths: [path.resolve(import.meta.dir, '../storage/catalog/.shopsite-cms/app.db')],
  });
  initDb(isolatedStore);
}
// Bound the runtime guard to this run (budget + hard deadline enforced
// inside every real request attempt, primary + retry). Unwired/absent stays
// blocked — the flag is the bound guard itself, never a global.
const attemptGuard = isLiveCaptureFlag ? createDevAttemptGuard(replayBudget) : null;
let liveAllowed = false;
if (isLiveCaptureFlag) {
  try {
    assertLiveCaptureAllowed({ liveCapture: true, model: modelArg ?? null, credentialRef: hasKey ? 'TYPESAFE_API_KEY' : null, guard: attemptGuard });
    liveAllowed = hasKey;
  } catch (err) {
    console.error(`Note: ${(err as Error).message} The candidate side will be recorded as blocked, never simulated.`);
    attemptGuard?.dispose();
  }
} else if (devReplay) {
  console.error(`Note: dev replay context ${REPLAY_CONTEXT_ISOLATED_SINGLE_CHOICE}. ${DEV_CALIBRATION_NOTE}. Unsupported: ${DEV_REPLAY_UNSUPPORTED_CAPABILITIES.join('; ')}.`);
}
if (isLiveCaptureFlag && !hasKey) {
  console.error(
    'Note: --live-capture requested without a provisioned TYPESAFE_API_KEY; the candidate side will be recorded as blocked (jev_credentials_absent), never simulated.',
  );
}
const captureMode = liveAllowed
  ? resolveDevCaptureMode({
      liveCaptureRequested: true,
      credentialPresent: true,
      guardWired: isLiveRuntimeGuardWired(attemptGuard),
    })
  : 'deterministic_floor' as const;
let artifact: QualificationPredictionArtifact;
// Frozen grounding sidecar (aliases, catalog fields, claim flags) rides
// capture post-validation — the strict schema check above stays pure, the
// frozen_snapshot contract + hash are unchanged.
const captureTaxonomy = devReplay
  ? withFrozenAuthorityDetails(devReplay.frozenSnapshot, devReplay.authorityDetails)
  : frozenTaxonomy;
if (captureMode === 'live_captured' || baselineRoute) {
  artifact = await captureQualificationPredictionsLive(
    goldEntries,
    {
      jev: captureMode === 'live_captured' ? { apiKey, ...(modelArg ? { model: modelArg } : {}) } : null,
      baselineRoute,
      ...(attemptGuard ? { attemptBudget: { tryConsumeAttempt: () => attemptGuard.tryConsumeAttempt() }, deadlineSignal: attemptGuard.signal } : {}),
    },
    captureTaxonomy,
  );
  if (attemptGuard) {
    const audit = attemptGuard.audit();
    console.error(`Guard audit: ${audit.consumed} attempts consumed, ${audit.rejected} rejected (max ${audit.maxHttpAttempts}), deadlineFired=${audit.deadlineFired}.`);
    attemptGuard.dispose();
  }
} else {
  artifact = buildQualificationPredictionsFromCode(goldEntries, captureTaxonomy);
}

// 2. Score the executed artifact with the existing evaluator (unchanged).
const goldset: QualificationGoldset = {
  version: devReplay ? 'jev-representative-dev-v1' : raw.version,
  description: devReplay ? 'Bounded dev replay over jev-representative-v1 (agent adjudication, NOT approval; isolated single-Choice, NOT cohort qualification)' : raw.description,
  adjudicatedBy: devReplay ? 'agent:jev-development-adjudicator (NOT human approval)' : raw.adjudicatedBy,
  verifiedPageImport: devReplay ? devReplay.frozenSnapshot.pages.length : raw.verifiedPageImport,
  frozenTaxonomy,
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
const statisticalGate = evaluateJevQualificationGate(goldset, { predictionSource: 'prereview_raw', bundleVersion: 1,
  snapshotMatched: artifact.taxonomySource === 'frozen_snapshot' && artifact.frozenTaxonomyHash === frozenTaxonomy?.snapshotHash,
  pairedSeedDigest: artifact.artifactHash });

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
// Policies and disablement are operational evidence, not constants inferred
// from the existence of unit tests. Absent receipts keep both gates false.
let operations: { policiesPublishedBeforeHoldout?: boolean; connectionDisablementVerified?: boolean } = {};
const operationsPath = process.env.TYPESAFE_OPERATIONS_RECEIPTS_PATH;
if (operationsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(operationsPath, 'utf8'));
    operations = {
      policiesPublishedBeforeHoldout: parsed.policiesPublishedBeforeHoldout === true,
      connectionDisablementVerified: parsed.connectionDisablementVerified === true,
    };
  } catch {
    console.error('Operations receipt is unreadable; policy and disablement verification remain incomplete.');
  }
}

// 5. Family-separation proof computed live via the shipped verifier over the
// loaded gold entries (no operator input — deterministic, never rebuilt
// here). Verification failure keeps the fail-closed blocker below.
let familySeparationProof: FamilySeparationProof | null = null;
let familyProofDetail: string;
try {
  const proof = verifyFamilySeparation(allGoldEntries);
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

/**
 * Commit the compatibility receipt must be bound to (issue #302): the
 * current HEAD, or the explicitly qualified commit/digest recorded with the
 * run (`TYPESAFE_QUALIFIED_COMMIT`). Every suite commit must equal it — an
 * old green receipt cannot qualify later changed code (fail-closed on
 * mismatch, blocker retained). Receipt/compat wiring only — the
 * prediction-capture invocation above is untouched.
 */
/** Explicit qualified commit from the environment (null when absent). */
function readExplicitQualifiedCommit(): { commit: string; source: string } | null {
  const explicit = process.env.TYPESAFE_QUALIFIED_COMMIT?.trim();
  return explicit ? { commit: explicit, source: 'env TYPESAFE_QUALIFIED_COMMIT' } : null;
}

/** Current HEAD or null when git is unavailable (fail-closed downstream). */
function readGitHeadCommit(): { commit: string; source: string } | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    const head = proc.stdout.toString().trim();
    if (proc.exitCode === 0 && /^[0-9a-f]{4,64}$/i.test(head)) return { commit: head, source: 'git HEAD' };
  } catch {
    // Fall through to unresolvable below (fail-closed).
  }
  return null;
}

function resolveCompatibilityExpectedCommit(): { commit: string | null; source: string } {
  return readExplicitQualifiedCommit()
    ?? readGitHeadCommit()
    ?? warnUnresolvableCompatibilityCommit();
}

/** Warn once when no commit binding is available (fail-closed: nothing clears). */
function warnUnresolvableCompatibilityCommit(): { commit: null; source: string } {
  console.error(
    'Warning: cannot resolve current HEAD for compatibility binding (not a git repo or git unavailable); no compatibility receipt can clear while unbound.',
  );
  return { commit: null, source: 'unresolvable (unverified)' };
}
const compatExpected = resolveCompatibilityExpectedCommit();
const runtimeStatus = Bun.spawnSync(['git', 'status', '--porcelain', '--', 'src', 'scripts', 'package.json', 'vitest.config.ts'],
  { cwd: path.resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
const compatibilityWorktreeClean = runtimeStatus.exitCode === 0 && runtimeStatus.stdout.toString().trim() === '';

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
  ...operations,
  compatibilityWorktreeClean,
  hasTypeSafeApiKey: hasKey,
  liveContractCheckExecuted,
  liveContractCheckSuccess,
  canaryProductTypeReviewed: canary.productType,
  canaryAttributesReviewed: canary.attributes,
  canaryCohortPagesReviewed: canary.cohortPages,
  familySeparationProof,
  compatibilityReceipt: compat.receipt,
  compatibilityExpectedCommit: compatExpected.commit,
  operatorDocsReceipt,
  offlineComparisonReport: comparisonReport,
  offlineQualificationGate: statisticalGate,
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
  decisionPolicyHash: artifact.decisionPolicyHash,
  predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
  artifactHash: artifact.artifactHash,
  predictedAt: artifact.predictedAt,
  entryCount: artifact.entryCount,
  captureMode: artifact.captureMode,
  taxonomySource: artifact.taxonomySource,
  frozenTaxonomyHash: artifact.frozenTaxonomyHash,
  authorityHash: artifact.authorityHash,
  authorityDetailsHash: artifact.authorityDetailsHash,
  fixtureVersion: devReplay ? 'jev-representative-dev-v1' : raw.version,
  fixturePath: devReplay ? devReplay.goldPath : GOLDSET_PATH,
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
  expectedCommit: compatExpected.commit,
  expectedCommitSource: compatExpected.source,
  runtimeWorktreeClean: compatibilityWorktreeClean,
};
const operatorDocsProvenance = {
  receipt: operatorDocsReceipt,
  detail: operatorDocsDetail,
  source: 'computed live by hashing the published runbook bytes',
};

if (isJson) {
  console.log(JSON.stringify({
    comparisonReport,
    statisticalGate,
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
console.log(`Compatibility:    ${compat.detail} (expected ${compatExpected.commit ? compatExpected.commit.slice(0, 12) + '…' : 'unresolvable'} via ${compatExpected.source})`);
console.log(`Operator docs:    ${operatorDocsDetail}\n`);

console.log(`Evaluated Examples: ${comparisonReport.evaluatedExamples} (Dev: ${comparisonReport.devCount}, Holdout: ${comparisonReport.holdoutCount})`);
console.log(`Statistical gate:   ${statisticalGate.qualified ? 'passed' : `unqualified (${statisticalGate.reasons.join('; ')})`}`);
console.log(`Adjudicated By:     ${goldset.adjudicatedBy}\n`);

console.log('--- 1. PRIMARY PRODUCT TYPE COMPARISON ---');
console.log(`  Evaluation:      ${evaluationStatusText(comparisonReport.productType.evaluation, 'product type labels')}`);
console.log(`  Raw Correctness: Baseline ${measuredPercent(comparisonReport.productType.rawCorrectness.baseline, comparisonReport.productType.evaluation)} | Jev ${measuredPercent(comparisonReport.productType.rawCorrectness.candidate, comparisonReport.productType.evaluation)} (Delta: ${comparisonReport.productType.rawCorrectness.delta > 0 ? '+' : ''}${(comparisonReport.productType.rawCorrectness.delta * 100).toFixed(1)}%)`);
console.log(`  Coverage:        Baseline ${measuredPercent(comparisonReport.productType.coverage.baseline, comparisonReport.productType.evaluation)} | Jev ${measuredPercent(comparisonReport.productType.coverage.candidate, comparisonReport.productType.evaluation)}`);
console.log(`  Incorrect:       Baseline ${comparisonReport.productType.incorrectProposals.baseline} | Jev ${comparisonReport.productType.incorrectProposals.candidate}`);
console.log(`  Regressions:     ${comparisonReport.productType.harmfulRegressions}`);
console.log(`  Recovered:       ${comparisonReport.productType.recoveredAbstentions}`);
console.log(`  Service Failures:${comparisonReport.productType.serviceFailures.candidate}\n`);

console.log('--- 2. CONTROLLED ATTRIBUTES COMPARISON ---');
console.log(`  Evaluation:      ${evaluationStatusText(comparisonReport.attributes.evaluation, 'product attribute sets')}`);
console.log(`  Raw Correctness: Baseline ${measuredPercent(comparisonReport.attributes.rawCorrectness.baseline, comparisonReport.attributes.evaluation)} | Jev ${measuredPercent(comparisonReport.attributes.rawCorrectness.candidate, comparisonReport.attributes.evaluation)}`);
console.log(`  Set F1 Score:    Baseline ${measuredScore(comparisonReport.attributes.setMetrics.f1.baseline, comparisonReport.attributes.evaluation)} | Jev ${measuredScore(comparisonReport.attributes.setMetrics.f1.candidate, comparisonReport.attributes.evaluation)}`);
console.log(`  Set Precision:   Baseline ${measuredScore(comparisonReport.attributes.setMetrics.precision.baseline, comparisonReport.attributes.evaluation)} | Jev ${measuredScore(comparisonReport.attributes.setMetrics.precision.candidate, comparisonReport.attributes.evaluation)}`);
console.log(`  Set Recall:      Baseline ${measuredScore(comparisonReport.attributes.setMetrics.recall.baseline, comparisonReport.attributes.evaluation)} | Jev ${measuredScore(comparisonReport.attributes.setMetrics.recall.candidate, comparisonReport.attributes.evaluation)}`);
console.log(`  Exact Match:     Baseline ${measuredPercent(comparisonReport.attributes.setMetrics.exactMatch.baseline, comparisonReport.attributes.evaluation)} | Jev ${measuredPercent(comparisonReport.attributes.setMetrics.exactMatch.candidate, comparisonReport.attributes.evaluation)}\n`);

console.log('--- 3. CATEGORY PAGES & COHORTS COMPARISON ---');
console.log(`  Evaluation:      ${evaluationStatusText(comparisonReport.categoryPages.evaluation, 'page sets')}`);
console.log(`  Page Exact Match:Baseline ${measuredPercent(comparisonReport.categoryPages.setMetrics.exactMatch.baseline, comparisonReport.categoryPages.evaluation)} | Jev ${measuredPercent(comparisonReport.categoryPages.setMetrics.exactMatch.candidate, comparisonReport.categoryPages.evaluation)}`);
console.log(`  Page F1 Score:   Baseline ${measuredScore(comparisonReport.categoryPages.setMetrics.f1.baseline, comparisonReport.categoryPages.evaluation)} | Jev ${measuredScore(comparisonReport.categoryPages.setMetrics.f1.candidate, comparisonReport.categoryPages.evaluation)}`);
console.log(`  Page Precision:  Baseline ${measuredScore(comparisonReport.categoryPages.setMetrics.precision.baseline, comparisonReport.categoryPages.evaluation)} | Jev ${measuredScore(comparisonReport.categoryPages.setMetrics.precision.candidate, comparisonReport.categoryPages.evaluation)}`);
console.log(`  Page Recall:     Baseline ${measuredScore(comparisonReport.categoryPages.setMetrics.recall.baseline, comparisonReport.categoryPages.evaluation)} | Jev ${measuredScore(comparisonReport.categoryPages.setMetrics.recall.candidate, comparisonReport.categoryPages.evaluation)}\n`);

console.log('--- 4. END-TO-END PIPELINE EFFECTS ---');
console.log(`  Total Evaluated: ${comparisonReport.endToEndPipeline.totalMembers}`);
console.log(`  Correct Type:    ${comparisonReport.endToEndPipeline.typeResolution.correct}`);
console.log(`  Attrs Correct:   ${comparisonReport.endToEndPipeline.attributeEffects.correctWhenTypeCorrect}`);
console.log(`  Pages Match:     ${comparisonReport.endToEndPipeline.pageEffects.exactMatchWhenTypeCorrect}`);
console.log(`  All Stages OK:   ${comparisonReport.endToEndPipeline.endToEndCorrectAllStages}\n`);

console.log('--- 5. LATENCY & COST TELEMETRY ---');
const formatLatency = (value: number | null) => value === null ? 'unknown' : `${value}ms`;
const formatCost = (value: number | null) => value === null ? 'unknown' : `$${value.toFixed(4)}`;
console.log(`  Mean Latency:    Baseline ${formatLatency(comparisonReport.telemetry.latency.baseline.meanMs)} | Jev ${formatLatency(comparisonReport.telemetry.latency.candidate.meanMs)}`);
console.log(`  P95 Latency:     Baseline ${formatLatency(comparisonReport.telemetry.latency.baseline.p95Ms)} | Jev ${formatLatency(comparisonReport.telemetry.latency.candidate.p95Ms)}`);
console.log(`  Estimated Cost:  Baseline ${formatCost(comparisonReport.telemetry.estimatedCostUsd.baseline)} | Jev ${formatCost(comparisonReport.telemetry.estimatedCostUsd.candidate)}`);
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
