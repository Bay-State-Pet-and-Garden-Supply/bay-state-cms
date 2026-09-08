/**
 * PR6 C6 (issue #30): acceptance integration test — durable parent title
 * coordination, replay-safe after commit (honest contract, PR6 hardening B
 * P1-1).
 *
 * Harness: cohort-worker.test.ts (temp DB, migrations, `createReadyCohort`)
 * + the active-v2 bundle + counting llm-client mock from
 * cohort-title-coordinator.test.ts. The mock returns a CANNED per-UPC title
 * JSON built from the prompt's UPC set (so it works for 2- and 3-member
 * groups), counts every `cohort_title_consolidation` invocation, and
 * simulates the audited transport's `classification_model_calls`
 * started→success rows (so the audit-pair assertions are real DB rows).
 *
 * Scenario coverage (architecture-report §11):
 *  1. freeze → run `running`, `final_membership_hash` + `execution_product_type_id` written;
 *  2. processCohort #1 → exactly ONE title call (the set was empty); N output
 *     rows with equal `input_hash`; every member's `curatedTitle` matches the
 *     persisted value;
 *  3. kill/restart: clearCohortCoordinationCache + expired lease +
 *     reclaimExpiredCohortRuns(new worker) → processCohort #2 with ZERO
 *     FURTHER title calls (the durable set already committed — replay-safe);
 *     the completed member is skipped by the resume guard; reset ONE member
 *     (stage → pending, curation data cleared) and re-run → the re-executed
 *     member's `curatedTitle` is byte-identical to the pre-kill value;
 *  4. counts: one audited started+success `classification_model_calls` pair
 *     per invocation, bound to the ordinal-0 child run — the scenario has
 *     exactly ONE invocation because the commit completed on the first entry;
 *     the general guarantee is ZERO FURTHER calls AFTER COMMIT (replay-safe),
 *     not "one call forever" (a crash between transport success and the
 *     outputs commit may re-invoke coordination — each invocation audited,
 *     no retry cap; covered in cohort-title-coordinator.test.ts);
 *  5. flag OFF → zero output rows, the legacy coordinator + cohortCache path
 *     (byte-identical), zero parent-level title calls;
 *  6. shadow (`cohortCurationV2Enabled && cohortShadowOnly`) → the legacy
 *     per-item path, no outputs, no parent op;
 *  7. immutability: superseding the run leaves the output rows untouched; a
 *     fresh claim/freeze creates a NEW run with NEW output rows.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi, mock } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemExtractionData,
  updateItemStageStatus,
  updateItemCurationData,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  getCohortById,
  getCohortMembers,
  computeMembershipHash,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCohortSnapshotByHash,
  reclaimExpiredCohortRuns,
  supersedeCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortTitleOutputsByRun,
} from '../../db/repositories/classification-cohort-output-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { OnboardingWorker } from '../../onboarding/job-queue';
import {
  freezeCohortForExecution,
  processCohort,
  verifyCohortRunFrozen,
  buildFrozenProductLineContext,
  MemberCommitCrashSimulationError,
} from '../../onboarding/cohort-curator';
import type { PreparedCohortContext } from '../../onboarding/cohort-curator';
import { curateItemWithPipeline } from '../../onboarding/product-curator';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { parseExecutionEvidenceProjection } from '../../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  ExecutionEvidenceProjectionV2,
} from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';

// ─── llm-client mock (counting; simulates the audited transport rows) ─────────

/** Total `cohort_title_consolidation` LLM invocations (audited + legacy). */
let titleCallCount = 0;
/** Invocations carrying an audit context (the parent op's audited call). */
let auditedTitleCallCount = 0;
let auditCallSeq = 0;

// NOTE: canned titles must NOT be a punctuation/case-insensitive echo of the
// item's raw spreadsheet name — the title-lint B1 rule (spreadsheet_fallback_leak)
// blocks "llm" candidates that carry no information beyond rawTitle, which would
// deterministically push coordination onto the fallback path. The fixtures'
// default brandHint is 'Acme', so T3 family consistency requires the brand word
// to appear exactly once per title; the "Recipe" suffix keeps them realistic.
const CANNED_TITLES: Record<string, string> = {
  '100000000001': 'Acme Purina Pro Plan Dry Dog Food Chicken Recipe 5 lb.',
  '100000000002': 'Acme Purina Pro Plan Dry Dog Food Beef Recipe 10 lb.',
  '100000000003': 'Acme Purina Pro Plan Dry Dog Food Salmon Recipe 5 lb.',
  '100000000004': 'Acme Purina Pro Plan Dry Dog Food Lamb Recipe 10 lb.',
};

function cannedTitleForUpc(upc: string): string {
  return CANNED_TITLES[upc] ?? `Purina Pro Plan Dog Food ${upc}`;
}

/** Extract the exact UPC set from the cohort prompt and return a matching JSON. */
function cannedResponseForPrompt(prompt: string): string {
  const upcs = [...prompt.matchAll(/\[(\d{10,})\]/g)].map(match => match[1]);
  const payload: Record<string, string> = {};
  for (const upc of upcs) payload[upc] = cannedTitleForUpc(upc);
  return JSON.stringify(payload);
}

function mockGetLlmConfigForTask(): Record<string, any> {
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

/** Simulate the audited transport's durable started + success rows. */
function writeAuditPair(runId: string, snapshotHash: string | null, callId: string): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'name_consolidation', 'cohort_title_consolidation', 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    [`${callId}-started`, runId, snapshotHash, 'cohort-title-consolidation-prompt-v1', 'cohort-title-consolidation-rules-v1', 'sys-hash', 'user-hash', now, null, now],
  );
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'name_consolidation', 'cohort_title_consolidation', 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [`${callId}-success`, runId, snapshotHash, 'cohort-title-consolidation-prompt-v1', 'cohort-title-consolidation-rules-v1', 'sys-hash', 'user-hash', now, now, now],
  );
}

function mockCallLlmForTask(
  _task: string,
  prompt: string,
  _systemPrompt: string,
  options: Record<string, any>,
): string | null {
  if (options?.protectedOperation !== 'cohort_title_consolidation') return null;
  titleCallCount++;
  return cannedResponseForPrompt(prompt);
}

function mockCallLlmForTaskWithProvenance(
  _task: string,
  prompt: string,
  _systemPrompt: string,
  options: Record<string, any>,
): { content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null {
  if (options?.protectedOperation !== 'cohort_title_consolidation') return null;
  titleCallCount++;
  const callId = `title-call-${++auditCallSeq}`;
  if (options.modelCall) {
    auditedTitleCallCount++;
    writeAuditPair(options.modelCall.runId, options.modelCall.snapshotHash ?? null, callId);
  }
  return {
    content: cannedResponseForPrompt(prompt),
    callId,
    provider: 'ollama',
    model: 'qwen2.5vl:latest',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

// PR6 review round 2: Bun-native `mock.module` with `persist: false` — the mock
// is scoped to THIS file and auto-restored after it completes, so co-running
// with llm-client-task-routing / model-policy gateway suites in one `bun test`
// invocation never leaks (Bun's vi.mock registry is shared per worker).
mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: () => mockGetLlmConfigForTask(),
  callLlmForTask: (task: string, prompt: string, systemPrompt: string, options: Record<string, any>) =>
    mockCallLlmForTask(task, prompt, systemPrompt, options),
  callLlmForTaskWithProvenance: (
    task: string,
    prompt: string,
    systemPrompt: string,
    options: Record<string, any>,
  ) => mockCallLlmForTaskWithProvenance(task, prompt, systemPrompt, options),
}));

// ─── DB harness ───────────────────────────────────────────────────────────────

let workspacePath: string;

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr6-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => {
  titleCallCount = 0;
  auditedTitleCallCount = 0;
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
});

// ─── Fixtures (mirror cohort-worker.test.ts + cohort-title-coordinator.test.ts) ─

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

/** Write a lifecycle-ACTIVE v2 bundle (reviewed Bay State seed) to disk so the
 *  freeze captures schema-v2 member snapshots with a frozen model-execution
 *  plan and resolves a coherent Execution Product Type. */
function writeActiveV2Bundle(
  wsPath: string,
): { bundle: ReturnType<typeof generateCandidate>['bundle']; xmlFields: string[] } {
  const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
  const bundle = candidate.bundle;
  const xmlFields = [...new Set(bundle.attributeMappings.map(mapping => mapping.catalogField))];
  fs.writeFileSync(
    path.join(wsPath, 'store', 'field-registry.json'),
    JSON.stringify({ entries: xmlFields.map(xmlField => ({ xmlField })) }),
  );

  // Real git commit + real catalog-evidence artifact so the active loader's
  // catalog binding checks (commit ancestry + artifact hash) pass.
  const artifactPath = path.join(wsPath, 'store', 'classification', 'catalog-evidence.json');
  const artifactContent = JSON.stringify({ schemaVersion: 1, xmlFields });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, artifactContent);
  const catalogEvidenceHash = sha256Hex(artifactContent);
  let sourceCatalogCommit: string | null;
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'test evidence'], { cwd: wsPath, stdio: 'ignore' });
    sourceCatalogCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsPath, encoding: 'utf-8' }).trim();
  } catch (err) {
    throw new Error(`Unable to prepare the test git workspace for the active v2 bundle: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const targets = bundle.curationTargets.map(target => (
    target.kind === 'page'
      ? { ...target, enabled: false, mandatory: false }
      : target
  ));
  const adjusted = { ...bundle, curationTargets: targets };
  const focusedFiles = buildFocusedFiles(adjusted);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const manifestWithoutHash = {
    ...adjusted.manifest,
    activeRevision: 'bay-state-v2',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit,
    catalogEvidenceHash,
    fileVersions,
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const dir = path.join(wsPath, 'store', 'classification');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), canonicalJsonFileString(manifest));
  for (const [name, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { bundle: { ...adjusted, manifest }, xmlFields };
}

function newWorkspace(): { workspaceId: string; workspacePath: string } {
  const workspaceId = randomUUID();
  const wsPath = path.join(workspacePath, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  return { workspaceId, workspacePath: wsPath };
}

function settledExtraction(overrides: Record<string, any> = {}): Record<string, any> {
  const ext = {
    title: 'Original Web Title',
    brand: 'Acme',
    description: 'Original description',
    bulletPoints: ['Bullet one', 'Bullet two'],
    primaryImage: 'https://img.example.com/primary.jpg',
    additionalImages: ['https://img.example.com/alt1.jpg'],
    searchKeywords: 'kibble dog',
    customFields: { Flavor: 'Chicken' },
    fieldProvenance: { title: 'json-ld' },
    packagingTitle: 'Package OCR Title',
    packagingOcrData: {
      productName: 'Package OCR Name',
      brand: 'Acme',
      species: ['dog'],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      confidenceByField: { productName: 0.95, weight: 0.8 },
      metadata: {
        imageSourceUrl: 'https://img.example.com/primary.jpg',
        model: 'test-vlm',
        extractedAt: new Date().toISOString(),
        modelCallIds: ['mock-call-1'],
      },
    },
    ocrOutcome: { status: 'succeeded', localStatus: 'succeeded', model: 'test-vlm', imageCount: 1 },
    productIntelligenceEvidence: [],
    ...overrides,
  };
  // Fixture realism (issue #111): real OCR reads EACH package, so items
  // with different name weights must not share one OCR weight — a shared
  // value fabricates contradictory evidence (see the T7 cascade note on
  // deterministicTitleWithVariants). Override per item via _ocrWeight.
  if (overrides._ocrWeight !== undefined) {
    ext.packagingOcrData = { ...ext.packagingOcrData, weight: overrides._ocrWeight };
  }
  return ext;
}

/** ocrInputHash for the same canonical input set computeOcrInputHash uses. */
function expectedOcrInputHash(sourceUrl: string, ext: Record<string, any>): string {
  return hashCanonicalJson({
    sourceUrl,
    extractionSourceUrl: sourceUrl,
    primaryImage: ext.primaryImage ?? null,
    additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
  });
}

function createReadyCohort(
  wsId: string,
  extByUpc: Record<string, Record<string, any>>,
): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const itemsData: InsertItemData[] = Object.entries(extByUpc).map(([upc, ext], index) => ({
    upc,
    name: String(ext._name ?? ext.title ?? `Item ${upc}`),
    brandHint: String(ext._brandHint ?? ext.brand ?? 'Acme'),
    sourceUrl: String(ext._sourceUrl ?? `https://brand.example.com/${upc}`),
    rowNumber: index + 1,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
  }));
  const batchId = createBatch({ workspaceId: wsId, name: 'PR6 Acceptance Batch', fileName: 'pr6.xlsx', totalItems: itemsData.length }).id;
  const items = insertItems(batchId, itemsData);
  for (const item of items) {
    const sourceUrl = item.sourceUrl ?? `https://brand.example.com/${item.upc}`;
    const ext: Record<string, any> = { ...extByUpc[item.upc] };
    delete ext._sourceUrl;
    delete ext._name;
    delete ext._brandHint;
    delete ext._ocrWeight;
    if (ext.ocrInputHash === undefined) {
      ext.ocrInputHash = expectedOcrInputHash(sourceUrl, ext);
    }
    updateItemExtractionData(item.id, JSON.stringify(ext));
    insertExtraction({
      itemId: item.id,
      sourceUrl,
      extractionDataJson: JSON.stringify(ext),
      extractionMethod: 'test',
      confidence: 1,
    });
  }
  const formed = refreshCandidateCohorts(wsId, batchId, listItemsByBatch(batchId));
  for (const cohort of formed) updateCohortStatus(cohort.id, 'ready');
  return { batchId, items: listItemsByBatch(batchId), cohorts: formed };
}

/** Await all in-flight worker promises (claim dispatch is fire-and-forget). */
async function drainWorker(worker: OnboardingWorker): Promise<void> {
  await worker.drain();
}

function cohortRunCount(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_runs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

function countTitleAuditRowsForRun(cohortRunId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_model_calls
     WHERE operation = 'cohort_title_consolidation'
       AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
  ).get(cohortRunId) as { cnt: number };
  return Number(row.cnt);
}

function countTitleAuditRowsForWorkspace(wsId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_model_calls
     WHERE operation = 'cohort_title_consolidation'
       AND run_id IN (SELECT id FROM classification_runs
                      WHERE cohort_run_id IN (SELECT id FROM classification_cohort_runs WHERE workspace_id = ?))`,
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

function countOutputRowsForWorkspace(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_outputs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

/** The output row ids for a run in stable insertion order (the repo's read
 *  shape omits `id`; the immutability assertions need the row identities). */
function outputRowIds(runId: string): string[] {
  const rows = getDb().query(
    "SELECT id FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title' ORDER BY created_at",
  ).all(runId) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// ─── Scenario helpers ─────────────────────────────────────────────────────────

const TWO_MEMBER_EXTRACTIONS = {
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _ocrWeight: '10 lb' }),
};

/** Write the active v2 bundle + persist its config snapshot, then create the
 *  ready cohort. Returns everything the scenario needs. */
async function prepareActiveV2Workspace(
  wsId: string,
  wsPath: string,
  extByUpc: Record<string, Record<string, any>>,
): Promise<{ items: OnboardingItem[]; cohorts: CurationCohort[] }> {
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(wsId, bundle);
  const created = createReadyCohort(wsId, extByUpc);
  return { items: created.items, cohorts: created.cohorts };
}

/** Freeze a ready cohort under the ACTIVE v2 bundle with the flags ON. */
async function freezeActiveCohort(
  wsId: string,
  wsPath: string,
): Promise<CohortRun> {
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
  const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, wsId);
  expect(finalized.status).toBe('running');
  return finalized;
}

function loadFrozenProjection(workspaceId: string, run: CohortRun): ExecutionEvidenceProjectionV2 {
  const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
}

/** The ordinal-0 member's child run id (the DECISION-N audit binding). */
function ordinal0ChildRunId(workspaceId: string, run: CohortRun, projection: ExecutionEvidenceProjectionV2): string {
  const ordered = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const row = getDb().query(
    'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(run.id, ordered[0].onboardingItemId) as { id: string };
  return row.id;
}

/** Build a prepared-cohort context for one member from the frozen run. */
function buildPreparedContext(
  workspaceId: string,
  run: CohortRun,
  item: OnboardingItem,
  frozenLineContext: ReturnType<typeof buildFrozenProductLineContext>,
): PreparedCohortContext {
  const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
  const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  const memberProjection = projection.members.find(m => m.onboardingItemId === item.id)!;
  const child = getDb().query(
    'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
  ).get(run.id, item.id) as Record<string, any>;
  const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
  return {
    memberProjection,
    parentRunId: run.id,
    memberSnapshotId: String(child.config_snapshot_id),
    memberSnapshotHash: String(child.config_snapshot_hash),
    sharedAuthorities: {
      configSnapshotRef: memberSnapshot.configSnapshotRef,
      pages: memberSnapshot.pages,
      pageImportId: memberSnapshot.pageImportId,
      pageImportHash: memberSnapshot.pageImportHash,
      fieldOptions: memberSnapshot.fieldOptions,
      focusedFileHashes: memberSnapshot.focusedFileHashes,
      catalogEvidenceHash: memberSnapshot.catalogEvidenceHash,
      modelPolicyView: memberSnapshot.modelPolicy
      ? modelPolicyViewFromConfig(memberSnapshot.modelPolicy as never, memberSnapshot.snapshotHash)
      : null,
    },
    productLineContext: frozenLineContext.productLineContext,
    productLineItems: frozenLineContext.productLineItems,
    frozenBatchItems: frozenLineContext.frozenBatchItems,
    coordinatedTitles: new Map(
      getCohortTitleOutputsByRun(run.id).map(row => [
        row.productSku,
        JSON.parse(row.outputValueJson) as { title: string; source: 'llm_cohort' | 'cohort_fallback' },
      ]),
    ),
  };
}

describe('PR6 acceptance — durable parent title coordination, replay-safe after commit (issue #30)', () => {
  it('1-2-4: freeze writes the run authorities; processCohort #1 coordinates once (empty set) and persists 2 output rows (equal input_hash); members consume the persisted titles; one audited started+success pair on the ordinal-0 child', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await prepareActiveV2Workspace(workspaceId, wsPath, TWO_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    // C6.1 — freeze: running + final_membership_hash + execution_product_type_id.
    expect(finalized.status).toBe('running');
    expect(finalized.finalMembershipHash).not.toBeNull();
    expect(finalized.executionProductTypeId).toBe('dog-food-dry');

    // C6.2 — first processCohort entry: coordinate ONCE + persist N + consume.
    const summary = await processCohort(finalized, wsPath, workspaceId);
    expect(summary.parentStatus).not.toBe('failed');
    expect(titleCallCount).toBe(1);
    expect(auditedTitleCallCount).toBe(1);

    // 2 output rows sharing the canonical input hash.
    const rows = getCohortTitleOutputsByRun(finalized.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].inputHash).toBe(rows[1].inputHash);
    expect(rows[0].inputHash.length).toBe(64);

    // Every member consumed its persisted title (titleSource llm_cohort).
    const persistedByUpc = new Map(rows.map(r => [r.productSku, JSON.parse(r.outputValueJson)]));
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const persisted = persistedByUpc.get(item.upc) as { title: string; source: string };
      expect(stored.curationData!.curatedTitle).toBe(persisted.title);
      expect(stored.curationData!.titleSource).toBe('llm_cohort');
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(item.upc));
    }

    // C6.4 — one audited started+success pair per invocation, bound to the
    // ordinal-0 child run. This scenario committed on the first entry, so
    // exactly ONE pair exists; the honest contract (PR6 hardening B) is that
    // zero FURTHER pairs appear AFTER the durable set commits (replay-safe),
    // not that a crash between transport and commit can never re-invoke.
    const projection = loadFrozenProjection(workspaceId, finalized);
    const childRunId = ordinal0ChildRunId(workspaceId, finalized, projection);
    const calls = getDb().query(
      'SELECT * FROM classification_model_calls WHERE operation = ? AND run_id = ?',
    ).all('cohort_title_consolidation', childRunId) as Array<Record<string, any>>;
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.status).sort()).toEqual(['started', 'success']);
    expect(calls.every(c => c.run_id === childRunId)).toBe(true);
    // Durable provenance: the output rows reference the audited call id.
    expect(rows.every(r => r.modelCallId === `title-call-${auditCallSeq}`)).toBe(true);
  });

  it('3-4: kill/restart/reclaim — ZERO FURTHER title calls after the durable set committed (replay-safe), completed member skipped, re-executed member byte-identical', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const THREE_MEMBER_EXTRACTIONS = {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _ocrWeight: '10 lb' }),
      '100000000003': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
    };
    const { items } = await prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);

    // processCohort #1: crash EXACTLY after the THIRD member's pipeline (before
    // its commit). Members 1 & 2 commit with the persisted titles; member 3 is
    // left pending; the parent stays running. The parent op already persisted
    // the 3 output rows before the member loop.
    let pipelineCount = 0;
    await expect(processCohort(finalized, wsPath, workspaceId, {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 3) {
          throw new MemberCommitCrashSimulationError('simulated kill between pipeline completion and member commit');
        }
      },
    })).rejects.toThrow('simulated kill between pipeline completion and member commit');

    expect(titleCallCount).toBe(1);
    const rowsAfterKill = getCohortTitleOutputsByRun(finalized.id);
    expect(rowsAfterKill).toHaveLength(3);
    expect(rowsAfterKill.every(r => r.inputHash === rowsAfterKill[0].inputHash)).toBe(true);
    for (let i = 0; i < 2; i++) {
      const stored = findItemById(items[i].id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(items[i].upc));
      expect(stored.curationData!.titleSource).toBe('llm_cohort');
    }
    const memberThree = findItemById(items[2].id)!;
    expect(memberThree.stageStatus).toBe('pending');

    // Kill/restart: clear the coordinator cache (DB authority, not process
    // memory), expire the lease, reclaim with a NEW worker id → resume the
    // SAME run via the verifyCohortRunFrozen match.
    clearCohortCoordinationCache();
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    expect(reclaim.resumed[0].id).toBe(finalized.id);
    const resumed = getCohortRunById(finalized.id)!;

    // processCohort #2: ZERO title calls (the durable set is complete + hash
    // matched). PR6 review BLOCKER 2 fix: the parent op is PURE READ — it
    // never creates a replacement ordinal-0 child — so the resume guard finds
    // the SAME committed child for members 1 & 2 and SKIPS both (no
    // re-execution, no new child runs). Only member 3 (whose pipeline crashed
    // before its atomic commit) re-executes.
    const auditRowsBefore = countTitleAuditRowsForRun(finalized.id);
    expect(auditRowsBefore).toBe(2); // exactly one started+success pair so far
    const summary = await processCohort(resumed, wsPath, workspaceId);
    expect(summary.parentStatus).not.toBe('failed');
    expect(titleCallCount).toBe(1); // NO new title calls across the resume
    expect(auditedTitleCallCount).toBe(1);
    expect(countTitleAuditRowsForRun(finalized.id)).toBe(2); // no new audited rows

    // The ordinal-1 member was SKIPPED: exactly one child run (the freeze-
    // created child committed in #1), never re-created, title untouched. The
    // committed ordinal-0 member was skipped the same way (same child, no
    // replacement — the persisted title is consumed WITHOUT re-execution).
    const memberTwoChildren = getDb().query(
      'SELECT COUNT(*) AS cnt FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(finalized.id, items[1].id) as { cnt: number };
    expect(Number(memberTwoChildren.cnt)).toBe(1);
    const memberOneChildren = getDb().query(
      'SELECT COUNT(*) AS cnt FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(finalized.id, items[0].id) as { cnt: number };
    expect(Number(memberOneChildren.cnt)).toBe(1); // ordinal-0 child never replaced

    // All three members carry the pre-kill persisted titles byte-for-byte.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(item.upc));
      expect(stored.curationData!.titleSource).toBe('llm_cohort');
    }

    // Crash-recovery retry pattern: reset ONE member (stage → pending,
    // curation data cleared) and re-run its pipeline in prepared mode → the
    // re-executed member's curatedTitle is byte-identical to the pre-kill
    // value, with ZERO title calls.
    updateItemStageStatus(items[2].id, 'pending');
    updateItemCurationData(items[2].id, '');
    const prepared = buildPreparedContext(workspaceId, resumed, items[2], frozenLineContext);
    const rerun = await curateItemWithPipeline(findItemById(items[2].id)!, wsPath, workspaceId, prepared);
    expect(rerun.curatedTitle).toBe(cannedTitleForUpc(items[2].upc));
    expect(rerun.titleSource).toBe('llm_cohort');
    expect(titleCallCount).toBe(1);
    expect(countTitleAuditRowsForRun(finalized.id)).toBe(2);
  });

  it('5: flag OFF — zero output rows, the legacy coordinator + cohortCache path (byte-identical), zero parent-level title calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await prepareActiveV2Workspace(workspaceId, wsPath, TWO_MEMBER_EXTRACTIONS);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Legacy per-item path, byte-identical: no cohort runs, no output rows,
    // zero audited (parent-level) title calls.
    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(countOutputRowsForWorkspace(workspaceId)).toBe(0);
    expect(auditedTitleCallCount).toBe(0);
    expect(countTitleAuditRowsForWorkspace(workspaceId)).toBe(0);
    // The legacy coordinator ran the cohort title call per member (the v2
    // member-scoped policy digest participates in the legacy cache key, so
    // the in-memory cohortCache dedups only within identical snapshots —
    // pre-existing legacy behavior, untouched by PR6). No audited rows.
    expect(titleCallCount).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(item.upc));
    }
  });

  it('6: shadow (cohortCurationV2Enabled && cohortShadowOnly) — the legacy per-item path, no outputs, no parent op', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await prepareActiveV2Workspace(workspaceId, wsPath, TWO_MEMBER_EXTRACTIONS);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(countOutputRowsForWorkspace(workspaceId)).toBe(0);
    expect(auditedTitleCallCount).toBe(0);
    expect(countTitleAuditRowsForWorkspace(workspaceId)).toBe(0);
    // The legacy per-item coordinator + cache path ran (no parent op).
    expect(titleCallCount).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(item.upc));
    }
  });

  it('7: immutability — superseding the run leaves the output rows untouched; a fresh claim/freeze creates a NEW run with NEW output rows', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await prepareActiveV2Workspace(workspaceId, wsPath, TWO_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);
    const oldRunId = finalized.id;
    await processCohort(finalized, wsPath, workspaceId);
    const oldRows = getCohortTitleOutputsByRun(oldRunId);
    expect(oldRows).toHaveLength(2);
    const oldRowIds = outputRowIds(oldRunId);
    const oldRowJson = oldRows.map(r => ({ sku: r.productSku, hash: r.inputHash, payload: r.outputValueJson, callId: r.modelCallId }));

    // Supersede the completed run — historical outputs are IMMUTABLE: the old
    // rows are never deleted or rewritten by supersession.
    supersedeCohortRun(oldRunId, 'acceptance supersede');
    const afterSupersede = getCohortTitleOutputsByRun(oldRunId);
    expect(afterSupersede).toHaveLength(2);
    expect(outputRowIds(oldRunId).sort()).toEqual([...oldRowIds].sort());
    expect(afterSupersede.map(r => ({ sku: r.productSku, hash: r.inputHash, payload: r.outputValueJson, callId: r.modelCallId })))
      .toEqual(oldRowJson);

    // A fresh claim + freeze produces a NEW run with NEW output rows (the old
    // run's rows are untouched).
    const [run2] = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(run2).toBeTruthy();
    expect(run2.id).not.toBe(oldRunId);
    const finalized2 = await freezeCohortForExecution(run2, wsPath, workspaceId);
    expect(finalized2.status).toBe('running');
    const summary2 = await processCohort(finalized2, wsPath, workspaceId);
    expect(summary2.parentStatus).not.toBe('failed');

    const newRows = getCohortTitleOutputsByRun(finalized2.id);
    expect(newRows).toHaveLength(2);
    const newRowIds = outputRowIds(finalized2.id);
    expect(newRowIds.filter(id => oldRowIds.includes(id))).toHaveLength(0);
    // The old rows are STILL present and byte-identical.
    const oldRowsStill = getCohortTitleOutputsByRun(oldRunId);
    expect(oldRowsStill.map(r => ({ sku: r.productSku, hash: r.inputHash, payload: r.outputValueJson, callId: r.modelCallId })))
      .toEqual(oldRowJson);
    // PR13 C2 (DECISION-A/B): the fresh revision's frozen title authority is
    // byte-identical to the superseded revision's, so the durable set is
    // COPIED into the NEW run — ZERO new title calls, fresh rows with the
    // SAME values and the ORIGINAL producing call ids (the pre-PR13
    // expectation of a second coordinate call is superseded by the
    // cross-parent same-T-hash reuse economics).
    expect(titleCallCount).toBe(1);
    expect(newRows.map(r => ({ sku: r.productSku, hash: r.inputHash, payload: r.outputValueJson, callId: r.modelCallId })))
      .toEqual(oldRowJson);
    expect(countOutputRowsForWorkspace(workspaceId)).toBe(4);
    // Members of the new run consume the copied persisted values.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(item.upc));
    }
  });

  it('8: SHOULD-FIX 2 — a singleton inside a mixed cohort keeps the per-item path (no fallback, no warning); grouped members consume persisted outputs', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const extByUpc = {
      // Two members form one `groupByProductLine` group (same brand + stem).
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Purina' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Purina', _ocrWeight: '10 lb' }),
      // A TRUE singleton: same brand but a DIFFERENT stem (its own group of 1)
      // — merged into the same cohort below so the cohort has >=2 SKUs but the
      // member's ACTUAL frozen group size is 1.
      '100000000003': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Salmon 5 lb', _brandHint: 'Purina' }),
    };
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);
    const { items, cohorts } = createReadyCohort(workspaceId, extByUpc);
    expect(cohorts.length).toBeGreaterThan(1);
    // Merge every formed cohort into the FIRST one and refresh the membership
    // hash so the claim/freeze membership check passes (donors superseded).
    const target = cohorts[0];
    for (const donor of cohorts.slice(1)) {
      getDb().run('UPDATE curation_cohort_members SET cohort_id = ? WHERE cohort_id = ?', [target.id, donor.id]);
      getDb().run(
        "UPDATE curation_cohorts SET status = 'superseded', superseded_at = ? WHERE id = ?",
        [new Date().toISOString(), donor.id],
      );
    }
    getDb().run(
      'UPDATE curation_cohorts SET membership_hash = ? WHERE id = ?',
      [computeMembershipHash(items.map(i => i.id)), target.id],
    );

    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => {
      warns.push(args.map(String).join(' '));
    });
    try {
      const summary = await processCohort(finalized, wsPath, workspaceId);
      expect(summary.parentStatus).not.toBe('failed');
    } finally {
      warnSpy.mockRestore();
    }

    // ONLY the two-member group was coordinated: 2 output rows, ONE title call.
    expect(titleCallCount).toBe(1);
    const rows = getCohortTitleOutputsByRun(finalized.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.inputHash === rows[0].inputHash)).toBe(true);

    // Grouped members consumed the persisted titles (llm_cohort).
    for (let i = 0; i < 2; i++) {
      const stored = findItemById(items[i].id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).toBe(cannedTitleForUpc(items[i].upc));
      expect(stored.curationData!.titleSource).toBe('llm_cohort');
    }

    // The singleton completed via the UNCHANGED per-item name_consolidation
    // path — NOT the deterministic cohort fallback and NO missing-output
    // warning (SHOULD-FIX 2).
    const singleton = findItemById(items[2].id)!;
    expect(singleton.stageStatus).toBe('completed');
    expect(singleton.curationData!.curatedTitle).toBeTruthy();
    expect(singleton.curationData!.titleSource).not.toBe('cohort_fallback');
    expect(warns.some(line => line.includes('missing a persisted cohort title output'))).toBe(false);
  });
});