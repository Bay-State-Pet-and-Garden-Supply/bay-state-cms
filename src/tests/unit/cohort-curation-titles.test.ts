/**
 * Slice 3 transfer of `cohort-title-coordinator.test.ts` (39 cases, pre-delete
 * gate 39/39 green) onto the new seam: every case now calls
 * `ensureCohortTitles` from `src/onboarding/cohort-curation/titles.ts` (first
 * user of the shared durable-set lifecycle in `decisions.ts`) instead of the
 * old transitional entry. Fixture builders + counting llm-client mock moved
 * with the cases — the old suite file is deleted in this slice. Case-level
 * replacement map: docs/plans/cohort-curation-slice0-ledger.md §2 + Slice 3
 * actuals appendix.
 *
 * Public-seam crash coverage (plan §3.3 — checkpoints threaded through
 * `executeClaim`, never around it) lives at the bottom of this file: the
 * active-bundle + counting-mock infrastructure required for the real
 * coordinate path lives here, so the title pre-commit crash + reclaim
 * scenarios run here through the public invocation. (`recovery.test.ts`
 * covers freeze/member crashes; its header points here for titles.)
 *
 * PR6 C4 (issue #30): the parent title coordination op —
 * `ensureCohortTitles`.
 *
 * bun:test harness mirroring cohort-worker.test.ts, with an ACTIVE v2 bundle
 * (mirroring cohort-freeze.test.ts's `writeActiveV2Bundle`) so the member
 * runtime snapshots are schema-v2 with a frozen model-execution plan — the
 * audited `cohort_title_consolidation` call (DECISION-N, ordinal-0 child
 * binding) actually resolves. `llm-client` is MOCKED (counting calls; the
 * mock also simulates the audited transport's `classification_model_calls`
 * started→success rows so the audit-pair assertions are real DB rows).
 *
 * Coverage:
 * - fresh run: ONE title call, 2 output rows sharing the same input_hash,
 *   returned map equals the persisted rows, exactly one audited started+
 *   success pair bound to the ordinal-0 child run;
 * - reuse: second call on the same run (after clearCohortCoordinationCache)
 *   → zero calls, identical map (DB authority, not process memory);
 * - hash mismatch (PR6 hardening A): a nonempty committed set under a stale
 *   input_hash → CohortTitleAuthorityDriftError, existing set untouched, ZERO
 *   new model calls (write-once — never re-coordinates, never replaces);
 * - incomplete nonempty set (PR6 hardening A): → CohortTitleAuthorityDriftError
 *   (can only be corruption — the all-or-nothing insert never leaves partial
 *   rows);
 * - all-or-nothing: forced insert failure (nonexistent workspace FK) → throws,
 *   zero rows remain;
 * - HeartbeatLostError after the LLM returns (sibling reclaim) → no rows,
 *   error propagates;
 * - LLM failure → deterministic fallback persisted (source cohort_fallback,
 *   model_call_id NULL);
 * - singleton members → no output row, no call (DECISION-O).
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
  updateItemExtractionData,
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
  getCohortSnapshotByHash,
  getCohortRunById,
  getLatestSupersededRunForCohort,
  reclaimExpiredCohortRuns,
  supersedeOwnedCohortRunForOutputDrift,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortTitleOutputsByRun,
  countCohortTitleOutputs,
} from '../../db/repositories/classification-cohort-output-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import {
  getRuntimeSnapshotByHash,
  getModelExecutionPlanEntry,
  snapshotHash,
} from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import { computeCohortTitleInputHash } from '../../onboarding/cohort-curation/titles';
import { titleExecutionTypeAuthorityFromRun } from '../../classification/cohort-decision-authority';
import { ensureCohortTitles, CohortTitleAuthorityDriftError, CohortTitleOutputCorruptError } from '../../onboarding/cohort-curation/titles';
import { createCohortCuration } from '../../onboarding/cohort-curation/index';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { buildFrozenProductLineContext } from '../../onboarding/cohort-curation/frozen-evidence';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import { MemberCommitCrashSimulationError } from '../../onboarding/cohort-curation/members';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { overrideCohortCurationFlags, resetCohortCurationFlagsOverride } from '../../classification/flags';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';

/** ISO timestamp helper for the tie test (mirrors the repo's `now()`). */
const nowIso = () => new Date().toISOString();
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { parseExecutionEvidenceProjection } from '../../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionV2,
} from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { FrozenProductLineContext } from '../../onboarding/cohort-curation/frozen-evidence';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';

// ─── llm-client mock (counting; simulates the audited transport rows) ─────────

let titleCallCount = 0;
let auditCallSeq = 0;
/** When true, the mock throws (simulating an LLM transport failure). */
let failNextTitleCall = false;
/** When true, the mock writes a durable `policy_denied` terminal row then throws (simulating the audited wrapper's denied path). */
let denyNextTitleCall = false;
/** When true, the mock writes a durable `unavailable` terminal row then returns null (simulating the audited wrapper's unavailable path). */
let unavailableNextTitleCall = false;
/** When true, the mock expires + reclaims `reclaimRunId` before returning. */
let reclaimAfterTitleCall = false;
let reclaimRunId: string | null = null;
let reclaimWorkspaceId: string | null = null;
/** PR6 review SHOULD-FIX 1: per-group producing calls recorded by the mock
 *  (call id + the group's UPC set from the prompt) — the per-row provenance
 *  assertions tie rows to THEIR producing call without depending on the
 *  absolute (cross-test cumulative) call-id sequence. */
let lastGroupCalls: Array<{ callId: string; upcs: string[] }> = [];
/** PR6 hardening B (P1-3): every prompt the mocked transport received, so
 *  tests can assert the prompt consumes exactly the T-hash authority (OCR
 *  weight/flavor + Execution Product Type context). */
let lastPrompts: string[] = [];

function mockGetLlmConfigForTask(): Record<string, any> {
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

function mockCallLlmForTask(): string {
  return JSON.stringify({
    '100000000001': 'Purina Pro Plan Dog Food Chicken 5 lb',
    '100000000002': 'Purina Pro Plan Dog Food Beef 10 lb',
  });
}

/** Canned titles keyed by UPC (extend when a test adds more members). */
const CANNED_TITLES: Record<string, string> = {
  '100000000001': 'Purina Pro Plan Dog Food Chicken 5 lb',
  '100000000002': 'Purina Pro Plan Dog Food Beef 10 lb',
  // ProPet group (SHOULD-FIX 1): titles carry the group's evidenced brand so
  // the candidate set passes T3 and persists as llm_cohort.
  '100000000003': 'ProPet Pro Plan Dog Food Salmon 5 lb',
  '100000000004': 'ProPet Pro Plan Dog Food Lamb 10 lb',
};

function cannedTitleForUpc(upc: string): string {
  return CANNED_TITLES[upc] ?? `Purina Pro Plan Dog Food ${upc}`;
}

/** Extract the exact UPC set from the cohort prompt and return a matching JSON
 *  (multi-group cohorts make one call per group — each prompt carries only
 *  that group's UPCs). */
/** Round-3 FIX 4 (Gap 1): per-test title overrides — lets a test inject an LLM
 *  set that FAILS validateFamilyTitleSet without touching other tests. */
let titleOverrides: Record<string, string> | null = null;

function cannedResponseForPrompt(prompt: string): string {
  const upcs = [...prompt.matchAll(/\[(\d{10,})\]/g)].map(match => match[1]);
  const payload: Record<string, string> = {};
  for (const upc of upcs) payload[upc] = titleOverrides?.[upc] ?? cannedTitleForUpc(upc);
  return JSON.stringify(payload);
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

/** Write a durable terminal `classification_model_calls` row for a status with NO transport. */
function writeTerminalRow(runId: string, snapshotHash: string | null, status: 'policy_denied' | 'unavailable'): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'name_consolidation', 'cohort_title_consolidation', 1, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`title-terminal-${++auditCallSeq}`, runId, snapshotHash, 'cohort-title-consolidation-prompt-v1', 'cohort-title-consolidation-rules-v1', 'sys-hash', 'user-hash', now, now, status, now],
  );
}

function mockCallLlmForTaskWithProvenance(
  _task: string,
  prompt: string,
  _systemPrompt: string,
  options: Record<string, any>,
): { content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null {
  if (options?.protectedOperation !== 'cohort_title_consolidation') return null;
  titleCallCount++;
  lastPrompts.push(prompt);
  if (denyNextTitleCall) {
    // PR6 review fix: the audited wrapper writes a durable policy_denied
    // terminal row BEFORE transport, then throws — the coordinator must fall
    // back deterministically with the audited row persisted.
    if (options.modelCall) {
      writeTerminalRow(options.modelCall.runId, options.modelCall.snapshotHash ?? null, 'policy_denied');
    }
    throw new Error('Model policy denied (mock)');
  }
  if (unavailableNextTitleCall) {
    // PR6 review fix: the audited wrapper writes a durable unavailable
    // terminal row and returns null (no transport) — the coordinator falls
    // back with the audited row persisted.
    if (options.modelCall) {
      writeTerminalRow(options.modelCall.runId, options.modelCall.snapshotHash ?? null, 'unavailable');
    }
    return null;
  }
  if (failNextTitleCall) {
    throw new Error('transport down');
  }
  const callId = `title-call-${++auditCallSeq}`;
  lastGroupCalls.push({
    callId,
    upcs: [...prompt.matchAll(/\[(\d{10,})\]/g)].map(match => match[1]),
  });
  if (options.modelCall) {
    writeAuditPair(options.modelCall.runId, options.modelCall.snapshotHash ?? null, callId);
  }
  if (reclaimAfterTitleCall && reclaimRunId && reclaimWorkspaceId) {
    getDb().run(
      'UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', reclaimRunId],
    );
    reclaimExpiredCohortRuns(
      reclaimWorkspaceId,
      new Date().toISOString(),
      () => 'match',
      'sibling-worker',
      COHORT_LEASE_TTL_MS,
    );
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
  callLlmForTask: () => mockCallLlmForTask(),
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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-title-coord-${randomUUID().slice(0, 8)}`);
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
  failNextTitleCall = false;
  denyNextTitleCall = false;
  unavailableNextTitleCall = false;
  reclaimAfterTitleCall = false;
  reclaimRunId = null;
  reclaimWorkspaceId = null;
  lastGroupCalls = [];
  lastPrompts = [];
  clearCohortCoordinationCache();
});

// ─── Fixtures (mirror cohort-worker.test.ts + cohort-freeze.test.ts v2) ───────

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
 *  plan. Mirrors `writeActiveV2Bundle` in cohort-freeze.test.ts. */
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
  return {
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
}

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
  const batchId = createBatch({ workspaceId: wsId, name: 'Title Coord Batch', fileName: 'title-coord.xlsx', totalItems: itemsData.length }).id;
  const items = insertItems(batchId, itemsData);
  for (const item of items) {
    const sourceUrl = item.sourceUrl ?? `https://brand.example.com/${item.upc}`;
    const ext: Record<string, any> = { ...extByUpc[item.upc] };
    delete ext._sourceUrl;
    delete ext._name;
    delete ext._brandHint;
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

interface FrozenCohortFixture {
  workspaceId: string;
  workspacePath: string;
  run: CohortRun;
  projection: ExecutionEvidenceProjectionV2;
  cohort: CurationCohort;
  members: CurationCohortMember[];
  frozenLineContext: FrozenProductLineContext;
  items: OnboardingItem[];
}

/** Freeze a ready cohort under the ACTIVE v2 bundle and return every input the
 *  parent op needs. */
async function freezeCohortFixture(extByUpc: Record<string, Record<string, any>>): Promise<FrozenCohortFixture> {
  const { workspaceId, workspacePath: wsPath } = newWorkspace();
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(workspaceId, bundle);
  const { items } = createReadyCohort(workspaceId, extByUpc);
  const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
  expect(finalized.status).toBe('running');
  const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
  const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  const cohort = getCohortById(finalized.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return { workspaceId, workspacePath: wsPath, run: finalized, projection, cohort, members, frozenLineContext, items };
}

/**
 * PR6 review round 1: a MIXED-family cohort — every cohort the batch formed
 * is merged into the FIRST one, so ONE run carries MULTIPLE
 * `groupByProductLine` groups (per-group provenance / singleton-in-mixed
 * cohort scenarios). The cohort's `membership_hash` is refreshed so the
 * claim/freeze membership check passes. `createReadyCohort` set every formed
 * cohort ready; the donors are superseded so only the target is claimable.
 */
async function freezeMixedCohortFixture(
  extByUpc: Record<string, Record<string, any>>,
): Promise<FrozenCohortFixture> {
  const { workspaceId, workspacePath: wsPath } = newWorkspace();
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(workspaceId, bundle);
  const { items, cohorts } = createReadyCohort(workspaceId, extByUpc);
  expect(cohorts.length).toBeGreaterThan(1);
  const target = cohorts[0];
  for (const donor of cohorts.slice(1)) {
    getDb().run(
      'UPDATE curation_cohort_members SET cohort_id = ? WHERE cohort_id = ?',
      [target.id, donor.id],
    );
    getDb().run(
      "UPDATE curation_cohorts SET status = 'superseded', superseded_at = ? WHERE id = ?",
      [new Date().toISOString(), donor.id],
    );
  }
  getDb().run(
    'UPDATE curation_cohorts SET membership_hash = ? WHERE id = ?',
    [computeMembershipHash(items.map(i => i.id)), target.id],
  );
  const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
  expect(finalized.status).toBe('running');
  const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
  const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  const cohort = getCohortById(finalized.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return { workspaceId, workspacePath: wsPath, run: finalized, projection, cohort, members, frozenLineContext, items };
}

/** Recompute the T-hash the parent op uses (mirrors its step 1). PR6 review
 *  BLOCKER 1 fix + PR13 C1 (DECISION-C): the parent op hashes the frozen
 *  OPERATION-SPECIFIC title authority — the `cohort_title_consolidation` plan
 *  entry's provider/model/versions — with NO broad policy digest (the
 *  snapshot-bound/unbound views are gone from the hash entirely). The
 *  seeded/persisted rows must match it. */
function expectedInputHash(fixture: FrozenCohortFixture): string {
  const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const child = getDb().query(
    'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(fixture.run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string } | undefined;
  const snapshot = child?.config_snapshot_hash
    ? getRuntimeSnapshotByHash(fixture.workspaceId, child.config_snapshot_hash)
    : null;
  // PR6 hardening C (P1-3): the label participates in the T-hash, resolved
  // through the SAME shared builder the parent op uses.
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(fixture.run, snapshot);
  return computeCohortTitleInputHash({
    run: fixture.run,
    projection: fixture.projection,
    titlePlanEntry: snapshot
      ? (getModelExecutionPlanEntry(snapshot, 'cohort_title_consolidation') ?? undefined)
      : undefined,
    executionTypeAuthority,
  });
}

/** The ordinal-0 member's child run id (the DECISION-N audit binding). */
function ordinal0ChildRunId(fixture: FrozenCohortFixture): string {
  const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const row = getDb().query(
    'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(fixture.run.id, ordered[0].onboardingItemId) as { id: string };
  return row.id;
}

const TWO_MEMBER_EXTRACTIONS = {
  // _brandHint 'Purina' matches the canned LLM titles below so the candidate
  // sets PASS validateFamilyTitleSet (T3: the evidenced brand must appear in
  // each title). Raw names carry 'ADULT' so the canned candidates differ from
  // the raw by content — a byte-equal candidate is now correctly B1-blocked as
  // a spreadsheet_fallback_leak by the title lint (e09).
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Chicken 5 lb', _brandHint: 'Purina' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Beef 10 lb', _brandHint: 'Purina' }),
};

describe('ensureCohortTitles — PR6 C4 (issue #30)', () => {
  it('fresh run: ONE title call, 2 output rows sharing input_hash, map equals persisted rows, one audited started+success pair on the ordinal-0 child run', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const childRunId = ordinal0ChildRunId(fixture);
    const inputHash = expectedInputHash(fixture);

    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });

    expect(titleCallCount).toBe(1);
    expect(map.size).toBe(2);
    expect(map.get('100000000001')).toEqual({ title: 'Purina Pro Plan Dog Food Chicken 5 lb.', source: 'llm_cohort' });
    expect(map.get('100000000002')).toEqual({ title: 'Purina Pro Plan Dog Food Beef 10 lb.', source: 'llm_cohort' });

    // Persisted rows: 2, sharing the canonical input_hash, matching the map.
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].inputHash).toBe(inputHash);
    expect(rows[1].inputHash).toBe(inputHash);
    const persisted = new Map(rows.map(r => [r.productSku, JSON.parse(r.outputValueJson)]));
    expect(persisted.get('100000000001')).toEqual({ title: 'Purina Pro Plan Dog Food Chicken 5 lb.', source: 'llm_cohort' });
    expect(persisted.get('100000000002')).toEqual({ title: 'Purina Pro Plan Dog Food Beef 10 lb.', source: 'llm_cohort' });
    // model_call_id provenance: the audited call id from the mock. (The call
    // id sequence is monotonic across the file so rows never collide.)
    expect(rows.every(r => r.modelCallId === `title-call-${auditCallSeq}`)).toBe(true);

    // Exactly one audited started+success pair, bound to the ordinal-0 child run.
    const calls = getDb().query(
      "SELECT * FROM classification_model_calls WHERE operation = 'cohort_title_consolidation'",
    ).all() as Array<Record<string, any>>;
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.status).sort()).toEqual(['started', 'success']);
    expect(calls.every(c => c.run_id === childRunId)).toBe(true);
  });

  it('e09 round-3 FIX 4 (Gap 1): an LLM set failing validateFamilyTitleSet persists ZERO llm_cohort rows — the all-or-nothing deterministic fallback is used instead', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    // Inconsistent skeletons + missing evidenced brand/flavor/size tokens:
    // this candidate set must FAIL family-title consistency (T2/T4).
    titleOverrides = {
      '100000000001': 'Totally Different Brand Alpha',
      '100000000002': 'Another Unrelated Line Beta',
    };
    try {
      const map = await ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      });

      // The rejected LLM set produced ZERO durable rows — never one member's row.
      const rows = getCohortTitleOutputsByRun(fixture.run.id);
      expect(rows.length === 0 || rows.length === 2).toBe(true); // never partial
      for (const row of rows) {
        const parsed = JSON.parse(row.outputValueJson) as { title: string; source: string };
        expect(parsed.source).toBe('cohort_fallback');
        expect(parsed.title).not.toContain('Totally Different Brand');
        expect(parsed.title).not.toContain('Another Unrelated Line');
      }
      if (rows.length === 2) {
        // Complete validated deterministic fallback (all-or-nothing).
        expect(map.get('100000000001')).toEqual({ title: 'Purina Pro Plan Adult Dog Food Chicken 5 lb.', source: 'cohort_fallback' });
        expect(map.get('100000000002')).toEqual({ title: 'Purina Pro Plan Adult Dog Food Beef 10 lb.', source: 'cohort_fallback' });
      } else {
        expect(map.size).toBe(0);
      }

      // The audited call still happened (started+success) — rejection is a
      // validation outcome, not a transport failure. Scoped to THIS run's
      // ordinal-0 child: the module-level DB accumulates rows across tests.
      const childRunId = ordinal0ChildRunId(fixture);
      const calls = getDb().query(
        "SELECT status FROM classification_model_calls WHERE operation = 'cohort_title_consolidation' AND run_id = ?",
      ).all(childRunId) as Array<{ status: string }>;
      expect(calls.map(c => c.status).sort()).toEqual(['started', 'success']);
    } finally {
      titleOverrides = null;
    }
  });

  it('e09 lint round-2 gap: an LLM set BLOCKED by the title lint persists ZERO llm_cohort rows — the deterministic fallback is committed instead, and reuse cannot resurrect a stale llm row', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    // Phantom weight on ONE sibling: "2.64" appears in no member's rawTitle
    // or extraction evidence ("Chicken 5 lb" / "Beef 10 lb"), so the lint
    // invalidates the whole LLM candidate set (all-or-nothing).
    titleOverrides = {
      '100000000001': 'Purina Pro Plan Dog Food Chicken 5 lb 2.64 oz',
      '100000000002': 'Purina Pro Plan Dog Food Beef 10 lb',
    };
    try {
      const map = await ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      });

      // Persistence seam: EXACTLY zero llm_cohort rows and one cohort_fallback
      // row per member — a lint-blocked group can never leave a stale llm row
      // behind for reuse/caching to resurrect.
      const rows = getCohortTitleOutputsByRun(fixture.run.id);
      const sources = rows.map(r => (JSON.parse(r.outputValueJson) as { source: string }).source);
      expect(sources.filter(s => s === 'llm_cohort')).toHaveLength(0);
      expect(sources.filter(s => s === 'cohort_fallback')).toHaveLength(2);
      for (const row of rows) {
        const parsed = JSON.parse(row.outputValueJson) as { title: string; source: string };
        expect(parsed.title).not.toContain('2.64');
      }
      expect(map.get('100000000001')?.source).toBe('cohort_fallback');
      expect(map.get('100000000002')?.source).toBe('cohort_fallback');
      expect(map.get('100000000001')?.title).not.toContain('2.64');

      // The audited call still happened (started+success) — a lint block is a
      // validation outcome, not a transport failure. Scoped to THIS run's
      // ordinal-0 child (the module-level DB accumulates rows across tests).
      const childRunId = ordinal0ChildRunId(fixture);
      const calls = getDb().query(
        "SELECT status FROM classification_model_calls WHERE operation = 'cohort_title_consolidation' AND run_id = ?",
      ).all(childRunId) as Array<{ status: string }>;
      expect(calls.map(c => c.status).sort()).toEqual(['started', 'success']);
    } finally {
      titleOverrides = null;
    }
  });

  it('reuse: second call on the same run (cache cleared) → zero calls, identical map', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const first = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(1);

    // Prove DB authority: clear the in-memory coordinator cache first — the
    // parent op never consults it, so the durable outputs alone drive reuse.
    clearCohortCoordinationCache();
    const second = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(1);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
  });

  it('PR8 review R1 (BLOCKER 1): a corrupt persisted curated_title row throws CohortTitleOutputCorruptError with the run id, per-SKU failures + original causes, and the usable parsed rows — zero re-coordination', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const first = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(2);
    expect(titleCallCount).toBe(1);

    // Corrupt ONE persisted row (bad JSON — a real corrupt storage write).
    getDb().run(
      "UPDATE classification_cohort_outputs SET output_value_json = '{corrupt' WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000001'",
      [fixture.run.id],
    );

    let thrown: unknown;
    try {
      await ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      });
      expect.unreachable('expected CohortTitleOutputCorruptError');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortTitleOutputCorruptError);
    const corrupt = thrown as CohortTitleOutputCorruptError;
    expect(corrupt.runId).toBe(fixture.run.id);
    expect(corrupt.failures).toHaveLength(1);
    expect(corrupt.failures[0].sku).toBe('100000000001');
    expect(corrupt.failures[0].cause).toContain('JSON Parse error');
    expect(corrupt.message).toContain(fixture.run.id);
    expect(corrupt.message).toContain('100000000001');
    // The unaffected row stays usable for the parent to continue.
    expect(corrupt.usableOutputs.get('100000000002')).toEqual({
      title: 'Purina Pro Plan Dog Food Beef 10 lb.',
      source: 'llm_cohort',
    });
    expect(corrupt.usableOutputs.has('100000000001')).toBe(false);
    // ZERO re-coordination — the corrupt row never triggers a new title call.
    expect(titleCallCount).toBe(1);
  });

  it('PR8 review R1 (BLOCKER 2): an EMPTY persisted title row throws CohortTitleOutputCorruptError with a schema-violation cause — the tightened schema turns a pre-tightening empty row into a member failure', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    // Hand-seed an EMPTY title at the DB level (pre-tightening corruption).
    getDb().run(
      "UPDATE classification_cohort_outputs SET output_value_json = ? WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000001'",
      [JSON.stringify({ title: '', source: 'llm_cohort' }), fixture.run.id],
    );
    let thrown: unknown;
    try {
      await ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      });
      expect.unreachable('expected CohortTitleOutputCorruptError');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortTitleOutputCorruptError);
    const corrupt = thrown as CohortTitleOutputCorruptError;
    expect(corrupt.failures[0].sku).toBe('100000000001');
    expect(corrupt.failures[0].cause).toContain('title');
  });

  it('hash mismatch: a nonempty committed set under a stale input_hash FAILS CLOSED — CohortTitleAuthorityDriftError, existing set untouched, zero new model calls', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const inputHash = expectedInputHash(fixture);

    // Simulate a prior commit under a different title authority (stale hash).
    // The run has zero rows yet, so the FIRST write-once insert succeeds.
    const { insertCohortTitleOutputsOnce } = await import('../../db/repositories/classification-cohort-output-repo');
    insertCohortTitleOutputsOnce({
      workspaceId: fixture.workspaceId,
      runId: fixture.run.id,
      inputHash: 'a'.repeat(64),
      outputs: [
        { productSku: '100000000001', title: 'Old Chicken Title', source: 'cohort_fallback' },
        { productSku: '100000000002', title: 'Old Beef Title', source: 'cohort_fallback' },
      ],
    });
    const rowsBefore = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rowsBefore).toHaveLength(2);

    // WRITE-ONCE (PR6 hardening A): a nonempty set whose rows do not match the
    // freshly computed T-hash is authority drift — the op NEVER re-coordinates
    // and NEVER replaces; it fails closed with the deterministic error.
    let thrown: unknown;
    try {
      await ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      });
      expect.unreachable('expected CohortTitleAuthorityDriftError');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortTitleAuthorityDriftError);
    const drift = thrown as CohortTitleAuthorityDriftError;
    expect(drift.runId).toBe(fixture.run.id);
    expect(drift.expectedHash).toBe(inputHash);
    expect(drift.storedHashes).toEqual(['a'.repeat(64)]);
    expect(drift.rowCount).toBe(2);
    expect(drift.message).toContain(fixture.run.id);
    expect(drift.message).toContain(inputHash);
    expect(drift.message).toContain('a'.repeat(64));

    // ZERO new model calls — the drift path aborts BEFORE any transport.
    expect(titleCallCount).toBe(0);
    // The existing set is untouched — byte-identical, never replaced.
    const rowsAfter = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.every(r => r.inputHash === 'a'.repeat(64))).toBe(true);
    expect(rowsAfter.some(r => r.outputValueJson.includes('Old Chicken Title'))).toBe(true);
  });

  it('incomplete nonempty set: only 1 of 2 rows present → CohortTitleAuthorityDriftError (all-or-nothing never leaves partial rows)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const first = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(2);
    expect(titleCallCount).toBe(1);

    // Simulate corruption: a partial set can only exist via an illegal direct
    // DELETE — the write-once all-or-nothing insert never leaves partial rows.
    getDb().run(
      "DELETE FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000002'",
      [fixture.run.id],
    );
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(1);
    const remainingBefore = getCohortTitleOutputsByRun(fixture.run.id);

    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toBeInstanceOf(CohortTitleAuthorityDriftError);

    // ZERO NEW model calls (the first coordinate was the only transport) and
    // the surviving row is untouched — never re-coordinates, never completes.
    expect(titleCallCount).toBe(1);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(1);
    expect(getCohortTitleOutputsByRun(fixture.run.id)).toEqual(remainingBefore);
  });

  it('all-or-nothing: a persistence failure throws and leaves ZERO output rows (no partial set)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    // Force `insertCohortTitleOutputsOnce` to throw (the real transaction
    // rollback is proven at the repo level in cohort-output-repo.test.ts —
    // the coordinator must propagate the failure and never leave a partial
    // set). The bogus-workspace FK route is now intercepted earlier by the
    // fail-closed frozen-audit-authority guard (BLOCKER 2/3).
    const outputRepo = await import('../../db/repositories/classification-cohort-output-repo');
    const spy = vi.spyOn(outputRepo, 'insertCohortTitleOutputsOnce').mockImplementation(() => {
      throw new Error('simulated persistence failure');
    });
    try {
      await expect(
        ensureCohortTitles({
          run: fixture.run,
          workspaceId: fixture.workspaceId,
          projection: fixture.projection,
          cohort: fixture.cohort,
          frozenLineContext: fixture.frozenLineContext,
        }),
      ).rejects.toThrow('simulated persistence failure');
    } finally {
      spy.mockRestore();
    }
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('HeartbeatLostError after the LLM returns (sibling reclaim) → no output rows, error propagates', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    reclaimAfterTitleCall = true;
    reclaimRunId = fixture.run.id;
    reclaimWorkspaceId = fixture.workspaceId;

    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toBeInstanceOf(HeartbeatLostError);

    // The stale owner wrote NOTHING: no output rows (the reclaiming sibling
    // will reuse-or-coordinate on its own re-entry).
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('LLM failure → deterministic fallback persisted (source cohort_fallback, model_call_id NULL)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    failNextTitleCall = true;

    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });

    expect(map.size).toBe(2);
    for (const entry of map.values()) {
      expect(entry.source).toBe('cohort_fallback');
      expect(entry.title.length).toBeGreaterThan(0);
    }
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.modelCallId === null)).toBe(true);
    const parsed = rows.map(r => JSON.parse(r.outputValueJson));
    expect(parsed.every((p: any) => p.source === 'cohort_fallback')).toBe(true);
  });

  it('policy-denied resolution: durable audited policy_denied terminal row + deterministic fallback persisted (never a silent non-audited fallback)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const childRunId = ordinal0ChildRunId(fixture);
    denyNextTitleCall = true;

    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });

    // Deterministic fallback persisted (group-level catch converts the denial).
    expect(map.size).toBe(2);
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.modelCallId === null)).toBe(true);
    const parsed = rows.map(r => JSON.parse(r.outputValueJson));
    expect(parsed.every((p: any) => p.source === 'cohort_fallback')).toBe(true);
    // The audited terminal row EXISTS (the preflight bypass lets the audited
    // wrapper write it before throwing), bound to the ordinal-0 child run.
    const denied = getDb().query(
      `SELECT status FROM classification_model_calls WHERE run_id = ? AND operation = 'cohort_title_consolidation' AND status = 'policy_denied'`,
    ).all(childRunId) as Array<{ status: string }>;
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it('unavailable resolution: durable audited unavailable terminal row + deterministic fallback persisted (never a silent non-audited fallback)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const childRunId = ordinal0ChildRunId(fixture);
    unavailableNextTitleCall = true;

    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });

    expect(map.size).toBe(2);
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.modelCallId === null)).toBe(true);
    const parsed = rows.map(r => JSON.parse(r.outputValueJson));
    expect(parsed.every((p: any) => p.source === 'cohort_fallback')).toBe(true);
    const unavailable = getDb().query(
      `SELECT status FROM classification_model_calls WHERE run_id = ? AND operation = 'cohort_title_consolidation' AND status = 'unavailable'`,
    ).all(childRunId) as Array<{ status: string }>;
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
  });

  it('singleton members: no output row, no call (DECISION-O)', async () => {
    const fixture = await freezeCohortFixture({
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(map.size).toBe(0);
    expect(titleCallCount).toBe(0);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('PR13 C1 (BLOCKER 1 superseded): the T-hash carries the OPERATION-SPECIFIC authority only — bound/unbound policy digests and route overrides never re-coordinate; frozen plan-entry changes do', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    // Coordinate + persist ONCE, then inspect the persisted input_hash.
    const first = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(2);
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    const persistedHash = rows[0].inputHash;
    expect(rows[1].inputHash).toBe(persistedHash);

    const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
    const child = getDb().query(
      'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(fixture.run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string };
    const snapshot = getRuntimeSnapshotByHash(fixture.workspaceId, child.config_snapshot_hash)!;
    const planEntry = getModelExecutionPlanEntry(snapshot, 'cohort_title_consolidation') ?? undefined;
    // PR6 hardening C (P1-3): the label is part of the hashed authority —
    // mirror the parent op's resolution through the shared builder.
    const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(fixture.run, snapshot);

    // (a) The BOUND digest (with snapshotHash) differs from the UNBOUND digest
    //     (routing fields only) — the distinction still exists in the policy
    //     view, but NEITHER is part of the T-hash anymore (PR13 DECISION-C).
    const unboundView = modelPolicyViewFromConfig(snapshot.modelPolicy as never);
    const boundView = modelPolicyViewFromConfig(snapshot.modelPolicy as never, snapshot.snapshotHash);
    expect(unboundView).not.toBeNull();
    expect(boundView).not.toBeNull();
    expect(unboundView!.policyDigest).not.toBe(boundView!.policyDigest);

    // (b) The persisted rows equal the T-hash computed with NO digest — and
    //     the SAME hash regardless of which (if any) broad digest is passed
    //     (the digest is dropped from the payload entirely).
    const hashWithNoDigest = computeCohortTitleInputHash({
      run: fixture.run,
      projection: fixture.projection,
      titlePlanEntry: planEntry,
      executionTypeAuthority,
    });
    expect(persistedHash).toBe(hashWithNoDigest);

    // (c) A NON-TITLE snapshot field change (H3/H4/evidence authority) changes
    //     the snapshot hash → the BOUND digest changes — but the T-hash is
    //     UNCHANGED.
    const mutated = JSON.parse(JSON.stringify(snapshot));
    mutated.catalogEvidenceHash = 'c'.repeat(64);
    expect(snapshotHash(mutated)).not.toBe(snapshot.snapshotHash);
    expect(computeCohortTitleInputHash({
      run: fixture.run,
      projection: fixture.projection,
      titlePlanEntry: planEntry,
      executionTypeAuthority,
    })).toBe(persistedHash);

    // (d) A BROAD-POLICY change (a name_consolidation route override) changes
    //     the policy digest — but NOT the frozen plan entry (the entries are
    //     snapshotted, never rebuilt from live modelPolicy) — so the T-hash
    //     is UNCHANGED. This is exactly DECISION-C: routing state never
    //     re-coordinates titles.
    const routeMutated = JSON.parse(JSON.stringify(snapshot));
    routeMutated.modelPolicy.stageOverrides = {
      ...routeMutated.modelPolicy.stageOverrides,
      name_consolidation: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        fallbackProvider: null,
        fallbackModel: null,
      },
    };
    const routeUnbound = modelPolicyViewFromConfig(routeMutated.modelPolicy as never);
    expect(routeUnbound!.policyDigest).not.toBe(unboundView!.policyDigest);
    expect(computeCohortTitleInputHash({
      run: fixture.run,
      projection: fixture.projection,
      titlePlanEntry: planEntry,
      executionTypeAuthority,
    })).toBe(persistedHash);

    // (e) A FROZEN PLAN-ENTRY change (the operation-specific authority itself)
    //     DOES change the T-hash — re-coordination is correct when the title
    //     model/version actually changes.
    expect(computeCohortTitleInputHash({
      run: fixture.run,
      projection: fixture.projection,
      titlePlanEntry: { ...(planEntry as NonNullable<typeof planEntry>), provider: 'openai', model: 'gpt-4o-mini' },
      executionTypeAuthority,
    })).not.toBe(persistedHash);
  });

  it('BLOCKER 2: the reuse path is PURE READ — a terminal ordinal-0 child is never replaced (no child creation, no ref updates)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
    const childId = ordinal0ChildRunId(fixture);
    const childCount = (): number => {
      const row = getDb().query(
        'SELECT COUNT(*) AS c FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      ).get(fixture.run.id, ordered[0].onboardingItemId) as { c: number };
      return Number(row.c);
    };
    const first = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(2);
    expect(childCount()).toBe(1); // freeze-created ordinal-0 child, untouched

    // Simulate the ordinal-0 member committing (child now TERMINAL), then a
    // crash-recovery resume: the parent op must find the SAME child and reuse
    // — never create a replacement running child (the old `ensureMemberRun`
    // created one, defeating the member-loop resume guard).
    getDb().run(
      "UPDATE classification_runs SET status = 'completed', completed_at = ? WHERE id = ?",
      [new Date().toISOString(), childId],
    );
    clearCohortCoordinationCache();
    const second = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(second.size).toBe(2);
    expect(titleCallCount).toBe(1); // reuse: zero new calls
    expect(childCount()).toBe(1); // NO replacement child created
    const statusRow = getDb().query('SELECT status FROM classification_runs WHERE id = ?').get(childId) as { status: string };
    expect(statusRow.status).toBe('completed'); // the committed child is untouched
  });

  it('BLOCKER 2/3: missing frozen audit authority (no refs-bearing ordinal-0 child) FAILS CLOSED before any transport', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
    getDb().run(
      'UPDATE classification_runs SET config_snapshot_id = NULL, config_snapshot_hash = NULL WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      [fixture.run.id, ordered[0].onboardingItemId],
    );
    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toThrow(/no child run with freeze-persisted snapshot refs/);
    expect(titleCallCount).toBe(0);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('BLOCKER 3: a frozen snapshot without a compatible title plan FAILS CLOSED (never a non-audited live call)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
    const child = getDb().query(
      'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(fixture.run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string };
    // Drop the frozen title plan entry from the persisted snapshot → the plan
    // digest no longer matches its entries → the audited context cannot be
    // built → the parent op must abort BEFORE any transport.
    const stored = getDb().query(
      'SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
    ).get(fixture.workspaceId, child.config_snapshot_hash) as { config_json: string };
    const snapshot = JSON.parse(stored.config_json);
    snapshot.modelExecutionPlan.entries = snapshot.modelExecutionPlan.entries.filter(
      (entry: any) => entry.operation !== 'cohort_title_consolidation',
    );
    getDb().run(
      'UPDATE classification_config_snapshots SET config_json = ? WHERE workspace_id = ? AND snapshot_hash = ?',
      [JSON.stringify(snapshot), fixture.workspaceId, child.config_snapshot_hash],
    );
    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toThrow(/Model plan incompatible|digest does not match/);
    expect(titleCallCount).toBe(0);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('SHOULD-FIX 1: two successful multi-item groups persist each row with ITS producing call id (per-group provenance)', async () => {
    const fixture = await freezeMixedCohortFixture({
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Purina' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Purina' }),
      '100000000003': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'ProPet' }),
      '100000000004': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Lamb 10 lb', _brandHint: 'ProPet' }),
    });
    expect(fixture.members.length).toBe(4);

    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });

    // ONE call per multi-item group (two groups → two audited calls).
    expect(titleCallCount).toBe(2);
    expect(map.size).toBe(4);
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(4);
    // The mock recorded exactly TWO producing calls — one per multi-item group.
    expect(lastGroupCalls).toHaveLength(2);
    // Map each UPC to its producing group call id (order-agnostic — the group
    // iteration order depends on member rowid tie-breaks).
    const recordedCallIdBySku = new Map<string, string>();
    for (const group of lastGroupCalls) {
      for (const upc of group.upcs) recordedCallIdBySku.set(upc, group.callId);
    }
    expect(recordedCallIdBySku.get('100000000001')).toBe(recordedCallIdBySku.get('100000000002'));
    expect(recordedCallIdBySku.get('100000000003')).toBe(recordedCallIdBySku.get('100000000004'));
    expect(recordedCallIdBySku.get('100000000001')).not.toBe(recordedCallIdBySku.get('100000000003'));
    // Every persisted row carries ITS producing group's call id — the first
    // group's rows never point at the second group's call (and vice versa).
    for (const row of rows) {
      expect(row.modelCallId).toBe(recordedCallIdBySku.get(row.productSku) ?? null);
    }
    expect(rows.every(r => r.modelCallId !== null)).toBe(true);
    // The producing call ids exist as REAL audited model-call rows.
    for (const group of lastGroupCalls) {
      const started = getDb().query(
        'SELECT COUNT(*) AS c FROM classification_model_calls WHERE id = ?',
      ).get(`${group.callId}-started`) as { c: number };
      expect(Number(started.c)).toBe(1);
    }
    // Every llm_cohort row parses and carries llm_cohort source.
    expect(rows.every(r => (JSON.parse(r.outputValueJson) as { source: string }).source === 'llm_cohort')).toBe(true);
  });

  it('P1-1 honest contract: single simulated crash between transport success and output commit → reclaim re-invokes audited coordination → commit → a subsequent entry reuses with zero calls', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const childRunId = ordinal0ChildRunId(fixture);
    const inputHash = expectedInputHash(fixture);

    // Attempt #1 — the audited title call SUCCEEDS (its `classification_model_calls`
    // started+success rows are durable) but the worker dies BEFORE the outputs
    // transaction commits. The test-only `afterCoordinatedCall` seam fires
    // exactly between transport success and `insertCohortTitleOutputsOnce`.
    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
        afterCoordinatedCall: () => {
          throw new Error('simulated crash between transport success and output commit');
        },
      }),
    ).rejects.toThrow('simulated crash between transport success and output commit');

    // The crash window: the audited call is DURABLE but the committed set is
    // EMPTY — a reclaim cannot reuse anything and must re-coordinate.
    expect(titleCallCount).toBe(1);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
    const firstAudit = getDb().query(
      "SELECT * FROM classification_model_calls WHERE operation = 'cohort_title_consolidation' AND run_id = ?",
    ).all(childRunId) as Array<Record<string, any>>;
    expect(firstAudit).toHaveLength(2);
    expect(firstAudit.map(c => c.status).sort()).toEqual(['started', 'success']);
    expect(firstAudit.every(c => c.run_id === childRunId)).toBe(true);

    // Reclaim: expire the lease + a NEW worker resumes the SAME run.
    getDb().run(
      'UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', fixture.run.id],
    );
    const reclaim = reclaimExpiredCohortRuns(
      fixture.workspaceId,
      new Date().toISOString(),
      () => 'match',
      'sibling-worker',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    expect(reclaim.resumed[0].id).toBe(fixture.run.id);
    const resumedRun = getCohortRunById(fixture.run.id)!;
    expect(resumedRun.claimedBy).toBe('sibling-worker');

    // Attempt #2 (reclaim re-entry): the set is still EMPTY ⇒ the reclaiming
    // worker re-invokes audited coordination. This single-simulated-crash
    // scenario shows ONE such re-invocation (each invocation audited); the
    // honest contract is that repeated pre-commit crashes would each cause
    // another independently audited call — there is no retry cap. The
    // committing attempt's set is COMPLETE + CONSISTENT: 2 rows, both share
    // the canonical input_hash, the returned map equals the persisted rows.
    const secondMap = await ensureCohortTitles({
      run: resumedRun,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(2);
    expect(secondMap.size).toBe(2);
    expect(secondMap.get('100000000001')).toEqual({ title: 'Purina Pro Plan Dog Food Chicken 5 lb.', source: 'llm_cohort' });
    expect(secondMap.get('100000000002')).toEqual({ title: 'Purina Pro Plan Dog Food Beef 10 lb.', source: 'llm_cohort' });
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.inputHash === inputHash)).toBe(true);
    const persisted = new Map(rows.map(r => [r.productSku, JSON.parse(r.outputValueJson)]));
    expect(secondMap.get('100000000001')).toEqual(persisted.get('100000000001'));
    expect(secondMap.get('100000000002')).toEqual(persisted.get('100000000002'));
    // Both invocations were AUDITED (one started+success pair per invocation,
    // both bound to the ordinal-0 child run).
    const secondAudit = getDb().query(
      "SELECT * FROM classification_model_calls WHERE operation = 'cohort_title_consolidation' AND run_id = ?",
    ).all(childRunId) as Array<Record<string, any>>;
    expect(secondAudit).toHaveLength(4);
    expect(secondAudit.map(c => c.status).sort()).toEqual(['started', 'started', 'success', 'success']);
    expect(secondAudit.every(c => c.run_id === childRunId)).toBe(true);

    // Attempt #3: the committed set is complete + hash-matched ⇒ REUSE with
    // zero calls — replay-safe after commit.
    const thirdMap = await ensureCohortTitles({
      run: resumedRun,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(2);
    expect([...thirdMap.entries()].sort()).toEqual([...secondMap.entries()].sort());
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
  });

  it('P1-3: the coordinated prompt consumes EXACTLY the T-hash authority — OCR weight/flavor lines + the frozen Execution Product Type label (hash authority == prompt authority)', async () => {
    // The Execution Product Type resolver runs ONLY in active cohort mode
    // (PR4 C4a gate) — enable the flags for this freeze. The fixture uses the
    // acceptance-test naming ('Dry Dog Food' in the spreadsheet name) so the
    // deterministic keyword match clears the confidence floor and resolves
    // `dog-food-dry` WITHOUT the LLM ranker fallback.
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    let fixture: FrozenCohortFixture;
    try {
      fixture = await freezeCohortFixture({
        '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
        '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
      });
    } finally {
      resetCohortCurationFlagsOverride();
    }
    // In this harness the OCR pull-forward has no configured local VLM, so the
    // fail-closed authority re-run clears the stored OCR (production keeps the
    // frozen signals when the re-run succeeds). Inject the SAME structured OCR
    // signals into the frozen projection — the single source BOTH the T-hash
    // and the frozen sibling views read — so the integration proves the
    // coordinator prompt consumes exactly what the hash claims.
    const ocrInjection = {
      productName: 'Package OCR Name',
      brand: 'Acme',
      species: [],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      confidenceByField: { productName: 0.95, weight: 0.8 },
      metadata: null,
    } as unknown as NonNullable<ExecutionEvidenceProjectionV2['members'][number]['extraction']['ocr']['packagingOcrData']>;
    for (const member of fixture.projection.members) {
      member.extraction.ocr.packagingOcrData = ocrInjection;
    }
    fixture.frozenLineContext = buildFrozenProductLineContext(
      fixture.cohort,
      fixture.members,
      fixture.projection.members,
    );
    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(map.size).toBe(2);
    expect(titleCallCount).toBe(1);

    // The frozen Execution Product Type: the id lives on the run, the label
    // is the ordinal-0 member snapshot's productTypes option name.
    expect(fixture.run.executionProductTypeId).toBe('dog-food-dry');
    const prompt = lastPrompts[0];
    expect(prompt).toBeTruthy();
    // OCR weight/flavor lines — the structured OCR signals the T-hash claims
    // (DECISION-Q) now appear in the prompt.
    expect(prompt).toContain('OCR Weight: "5 lb"');
    expect(prompt).toContain('OCR Flavor: "Chicken"');
    // Execution Product Type context with BOTH the frozen id AND the frozen
    // option's label — the prompt consumes exactly the authority the T-hash
    // covers (id + label + confidence + outcome).
    expect(prompt).toContain('Product Type Context: "dog-food-dry (Dry Dog Food)"');
    // The persisted input_hash still equals the T-hash over the SAME frozen
    // authority the prompt consumed (hash authority == prompt authority).
    expect(getCohortTitleOutputsByRun(fixture.run.id)[0].inputHash).toBe(expectedInputHash(fixture));
  });

  it('PR6 hardening C SHOULD-FIX 1: extra-row corruption — a complete same-hash set PLUS an unexpected row is DRIFT (never reused, zero new calls)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const first = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(2);
    expect(titleCallCount).toBe(1);
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);

    // Simulate corruption: an unexpected EXTRA row for a SKU that is NOT a
    // multi-item-group member, carrying the SAME input_hash — the exact shape
    // the old subset-only reuse check silently accepted as "complete".
    getDb().run(
      `INSERT INTO classification_cohort_outputs
         (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
       VALUES (?, ?, ?, 'curated_title', ?, ?, ?, NULL, ?)`,
      [randomUUID(), fixture.workspaceId, fixture.run.id, '100000000003', rows[0].inputHash,
        JSON.stringify({ title: 'Bogus Extra Title', source: 'cohort_fallback' }), new Date().toISOString()],
    );
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(3);
    const rowsBefore = getCohortTitleOutputsByRun(fixture.run.id);

    // EXACT-SET equality (PR6 hardening C): row count 3 !== expected 2 ⇒ the
    // over-complete set is write-once corruption — drift, never reuse.
    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toBeInstanceOf(CohortTitleAuthorityDriftError);
    // ZERO new model calls; the over-complete set is untouched.
    expect(titleCallCount).toBe(1);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(3);
    expect(getCohortTitleOutputsByRun(fixture.run.id)).toEqual(rowsBefore);
  });

  it('PR6 hardening C SHOULD-FIX 1: a run with NO multi-item groups but persisted output rows FAILS CLOSED (never a silent empty-map return)', async () => {
    const fixture = await freezeCohortFixture({
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    // The single-member cohort has no multi-item groups ⇒ NO output rows are
    // expected (DECISION-O). Simulate corruption: an unexpected row for the run.
    getDb().run(
      `INSERT INTO classification_cohort_outputs
         (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
       VALUES (?, ?, ?, 'curated_title', ?, ?, ?, NULL, ?)`,
      [randomUUID(), fixture.workspaceId, fixture.run.id, '100000000001', 'a'.repeat(64),
        JSON.stringify({ title: 'Bogus Row', source: 'cohort_fallback' }), new Date().toISOString()],
    );
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(1);

    await expect(
      ensureCohortTitles({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        cohort: fixture.cohort,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toBeInstanceOf(CohortTitleAuthorityDriftError);
    // Zero transport, zero output writes — the corruption is loud, not silent.
    expect(titleCallCount).toBe(0);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(1);
  });

  // ─── PR6 hardening C (P1-3): REAL-mapping parity — one field at a time ─────

  /** Run the REAL parent op once against a flags-ON fixture with OCR injected
   *  and an optional single-field mutation, then capture the REAL prompt (from
   *  the mocked transport) and the REAL persisted T-hash. Each test runs TWO
   *  full freezes (base + mutated) so the assertions never rely on a
   *  test-only mirror of the coordinator mapping. */
  async function coordinateOnceWithMutation(
    mutate?: (f: FrozenCohortFixture) => void,
  ): Promise<{ prompt: string; hash: string }> {
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    let fixture: FrozenCohortFixture;
    try {
      fixture = await freezeCohortFixture({
        '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
        '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
      });
    } finally {
      resetCohortCurationFlagsOverride();
    }
    const ocrInjection = {
      productName: 'Package OCR Name',
      brand: 'Acme',
      species: [],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      confidenceByField: { productName: 0.95, weight: 0.8 },
      metadata: null,
    } as unknown as NonNullable<ExecutionEvidenceProjectionV2['members'][number]['extraction']['ocr']['packagingOcrData']>;
    for (const member of fixture.projection.members) {
      // Deep-clone per member so a single-field mutation touches ONE member.
      member.extraction.ocr.packagingOcrData = JSON.parse(JSON.stringify(ocrInjection));
    }
    mutate?.(fixture);
    fixture.frozenLineContext = buildFrozenProductLineContext(
      fixture.cohort,
      fixture.members,
      fixture.projection.members,
    );
    const map = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(map.size).toBe(2);
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    return { prompt: lastPrompts[lastPrompts.length - 1], hash: rows[0].inputHash };
  }

  it('P1-3 PARITY (real coordinator): id-only mutation → BOTH the persisted T-hash AND the prompted authority change', async () => {
    const base = await coordinateOnceWithMutation();
    const mutated = await coordinateOnceWithMutation(f => {
      f.run.executionProductTypeId = 'dog-food-wet';
    });
    expect(mutated.hash).not.toBe(base.hash);
    expect(mutated.prompt).not.toBe(base.prompt);
    expect(base.prompt).toContain('Product Type Context: "dog-food-dry (Dry Dog Food)"');
    expect(mutated.prompt).toContain('Product Type Context: "dog-food-wet (Wet Dog Food)"');
  });

  it('P1-3 PARITY (real coordinator): label-only mutation (same id, renamed frozen option) → BOTH the T-hash AND the prompted authority change', async () => {
    const base = await coordinateOnceWithMutation();
    const mutated = await coordinateOnceWithMutation(f => {
      const ordered = [...f.projection.members].sort((a, b) => a.ordinal - b.ordinal);
      const child = getDb().query(
        'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
      ).get(f.run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string };
      const stored = getDb().query(
        'SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
      ).get(f.workspaceId, child.config_snapshot_hash) as { config_json: string };
      const snapshot = JSON.parse(stored.config_json);
      const type = snapshot.productTypes.find((t: any) => t.id === 'dog-food-dry');
      expect(type).toBeTruthy();
      type.name = 'Dry Dog Food (Renamed)';
      getDb().run(
        'UPDATE classification_config_snapshots SET config_json = ? WHERE workspace_id = ? AND snapshot_hash = ?',
        [JSON.stringify(snapshot), f.workspaceId, child.config_snapshot_hash],
      );
    });
    expect(mutated.hash).not.toBe(base.hash);
    expect(mutated.prompt).not.toBe(base.prompt);
    expect(base.prompt).toContain('Product Type Context: "dog-food-dry (Dry Dog Food)"');
    expect(mutated.prompt).toContain('Product Type Context: "dog-food-dry (Dry Dog Food (Renamed))"');
  });

  it('P1-3 PARITY (real coordinator): webBrand-only mutation → BOTH the T-hash AND the prompted authority change', async () => {
    const base = await coordinateOnceWithMutation();
    const mutated = await coordinateOnceWithMutation(f => {
      f.projection.members[0].extraction.brand = 'AnotherBrand';
    });
    expect(mutated.hash).not.toBe(base.hash);
    expect(mutated.prompt).not.toBe(base.prompt);
    expect(base.prompt).toContain('Web Brand: "Acme"');
    expect(mutated.prompt).toContain('Web Brand: "AnotherBrand"');
  });

  it('P1-3 PARITY (real coordinator): weight-only mutation → BOTH the T-hash AND the prompted authority change', async () => {
    const base = await coordinateOnceWithMutation();
    const mutated = await coordinateOnceWithMutation(f => {
      f.projection.members[0].extraction.ocr.packagingOcrData!.weight = '10 lb';
    });
    expect(mutated.hash).not.toBe(base.hash);
    expect(mutated.prompt).not.toBe(base.prompt);
    expect(base.prompt).toContain('OCR Weight: "5 lb"');
    expect(mutated.prompt).toContain('OCR Weight: "10 lb"');
  });

  it('P1-3 PARITY (real coordinator): flavor-only mutation → BOTH the T-hash AND the prompted authority change', async () => {
    const base = await coordinateOnceWithMutation();
    const mutated = await coordinateOnceWithMutation(f => {
      f.projection.members[0].extraction.ocr.packagingOcrData!.flavorVariety = 'Salmon';
    });
    expect(mutated.hash).not.toBe(base.hash);
    expect(mutated.prompt).not.toBe(base.prompt);
    expect(base.prompt).toContain('OCR Flavor: "Chicken"');
    expect(mutated.prompt).toContain('OCR Flavor: "Salmon"');
  });
});

// ─── PR13 C2: cross-parent same-T-hash reuse (issue #30, DECISION-A/B) ───────

/** Supersede a RUNNING revision (the owner-guarded drift primitive) and
 *  re-claim + re-freeze the SAME cohort as a NEW revision — the unique
 *  current-run slot reopens on supersession. */
async function supersedeAndRefreeze(fixture: FrozenCohortFixture): Promise<FrozenCohortFixture> {
  expect(supersedeOwnedCohortRunForOutputDrift(fixture.run.id, 'worker-a', 'PR13 C2 test supersede')).toBe(true);
  const claimed = claimReadyCurationCohorts(fixture.workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const runB = claimed.find(r => r.cohortId === fixture.run.cohortId)!;
  const finalized = await freezeCohortForExecution(runB, fixture.workspacePath, fixture.workspaceId);
  expect(finalized.status).toBe('running');
  const snap = getCohortSnapshotByHash(fixture.workspaceId, finalized.evidenceSnapshotHash!)!;
  const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  const cohort = getCohortById(finalized.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return { workspaceId: fixture.workspaceId, workspacePath: fixture.workspacePath, run: finalized, projection, cohort, members, frozenLineContext, items: fixture.items };
}

function runCoordParams(fixture: FrozenCohortFixture): Parameters<typeof ensureCohortTitles>[0] {
  return {
    run: fixture.run,
    workspaceId: fixture.workspaceId,
    projection: fixture.projection,
    cohort: fixture.cohort,
    frozenLineContext: fixture.frozenLineContext,
  };
}

describe('ensureCohortTitles — PR13 C2 cross-parent same-T-hash reuse (issue #30)', () => {
  it('revision B with the SAME frozen authority copies the superseded parent set: ZERO calls, fresh rows, same values, ORIGINAL model-call ids, old rows untouched', async () => {
    // Run A: ONE title call, durable rows under A.
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const mapA = await ensureCohortTitles(runCoordParams(fixtureA));
    expect(titleCallCount).toBe(1);
    expect(mapA.size).toBe(2);
    const rowsA = getCohortTitleOutputsByRun(fixtureA.run.id);
    expect(rowsA).toHaveLength(2);
    expect(rowsA.every(r => r.modelCallId !== null)).toBe(true);

    // Revision B with the SAME frozen authority: supersede A, claim + freeze B.
    titleCallCount = 0;
    const fixtureB = await supersedeAndRefreeze(fixtureA);

    const mapB = await ensureCohortTitles(runCoordParams(fixtureB));
    // ZERO LLM calls — the superseded set was copied, never re-coordinated.
    expect(titleCallCount).toBe(0);
    // Byte-identical titles from the copied set.
    expect([...mapB.entries()].sort()).toEqual([...mapA.entries()].sort());
    // FRESH write-once rows under the NEW run id.
    const rowsB = getCohortTitleOutputsByRun(fixtureB.run.id);
    expect(rowsB).toHaveLength(2);
    expect(rowsB.every(r => r.inputHash === expectedInputHash(fixtureB))).toBe(true);
    expect(rowsB.map(r => JSON.parse(r.outputValueJson))).toEqual(rowsA.map(r => JSON.parse(r.outputValueJson)));
    // DECISION-B: the ORIGINAL producing call ids are preserved.
    expect(rowsB.map(r => r.modelCallId).sort()).toEqual(rowsA.map(r => r.modelCallId).sort());
    expect(rowsB.every(r => r.modelCallId !== null)).toBe(true);
    // The old run's rows are untouched (immutable historical truth).
    expect(getCohortTitleOutputsByRun(fixtureA.run.id)).toEqual(rowsA);
  });

  it('a DIFFERENT frozen authority (mutated member evidence) → revision B coordinates FRESH (one call, no copy)', async () => {
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles(runCoordParams(fixtureA));
    expect(titleCallCount).toBe(1);

    // Mutate one member's frozen title evidence BEFORE freezing revision B —
    // the frozen projection (and therefore the T-hash) changes.
    const item = fixtureA.items.find(i => i.upc === '100000000001')!;
    const ext = item.extractionData ? { ...(item.extractionData as Record<string, unknown>) } : {};
    ext.title = 'Changed Web Title';
    updateItemExtractionData(item.id, JSON.stringify(ext));

    titleCallCount = 0;
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    expect(expectedInputHash(fixtureB)).not.toBe(expectedInputHash(fixtureA));

    const mapB = await ensureCohortTitles(runCoordParams(fixtureB));
    // The superseded set's hash no longer matches → NO copy → fresh coordinate.
    expect(titleCallCount).toBe(1);
    expect(mapB.size).toBe(2);
    expect(getCohortTitleOutputsByRun(fixtureB.run.id)).toHaveLength(2);
  });

  it('an INCOMPLETE superseded set (missing row) → no reuse, fresh coordinate (one call)', async () => {
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles(runCoordParams(fixtureA));
    expect(titleCallCount).toBe(1);

    // Simulate a partial old set (corruption that can only exist via an
    // illegal direct DELETE) — the reuse check must reject it.
    getDb().run(
      "DELETE FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000001'",
      [fixtureA.run.id],
    );

    titleCallCount = 0;
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    const mapB = await ensureCohortTitles(runCoordParams(fixtureB));
    expect(titleCallCount).toBe(1);
    expect(mapB.size).toBe(2);
    expect(getCohortTitleOutputsByRun(fixtureB.run.id)).toHaveLength(2);
  });

  it('a superseded run of a DIFFERENT cohort is never reused (cohort-scoped lookup) → fresh coordinate', async () => {
    // One workspace, TWO families → two ready cohorts. Claim both; freeze +
    // coordinate + supersede the FOREIGN cohort's run; the target cohort's
    // revision B must NOT copy the foreign rows.
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);
    createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
      '200000000001': settledExtraction({ _name: 'Royal Canin Dry Cat Food Chicken 5 lb', _brandHint: 'Royal' }),
      '200000000002': settledExtraction({ _name: 'Royal Canin Dry Cat Food Beef 10 lb', _brandHint: 'Royal' }),
    });
    const claimed = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(claimed.length).toBe(2);
    const foreignRun = claimed.find(r => r.cohortId !== claimed[0].cohortId)!;
    const targetRun = claimed.find(r => r.cohortId !== foreignRun.cohortId)!;

    // Foreign cohort: freeze + coordinate + supersede (its rows exist under
    // its OWN superseded run).
    const foreignFinalized = await freezeCohortForExecution(foreignRun, wsPath, workspaceId);
    expect(foreignFinalized.status).toBe('running');
    const foreignSnap = getCohortSnapshotByHash(workspaceId, foreignFinalized.evidenceSnapshotHash!)!;
    const foreignProjection = parseExecutionEvidenceProjection(JSON.parse(foreignSnap.payloadJson));
    const foreignCohort = getCohortById(foreignFinalized.cohortId)!;
    const foreignMembers = getCohortMembers(foreignCohort.id);
    const foreignLine = buildFrozenProductLineContext(foreignCohort, foreignMembers, foreignProjection.members);
    await ensureCohortTitles({
      run: foreignFinalized, workspaceId, projection: foreignProjection,
      cohort: foreignCohort, frozenLineContext: foreignLine,
    });
    expect(titleCallCount).toBe(1);
    expect(supersedeOwnedCohortRunForOutputDrift(foreignFinalized.id, 'worker-a', 'foreign supersede')).toBe(true);
    expect(getCohortTitleOutputsByRun(foreignFinalized.id)).toHaveLength(2);

    // Target cohort revision B: freeze + coordinate. Its own lookup finds NO
    // superseded run for ITS cohort → never copies the foreign rows → fresh.
    const targetFinalized = await freezeCohortForExecution(targetRun, wsPath, workspaceId);
    expect(targetFinalized.status).toBe('running');
    const targetSnap = getCohortSnapshotByHash(workspaceId, targetFinalized.evidenceSnapshotHash!)!;
    const targetProjection = parseExecutionEvidenceProjection(JSON.parse(targetSnap.payloadJson));
    const targetCohort = getCohortById(targetFinalized.cohortId)!;
    const targetMembers = getCohortMembers(targetCohort.id);
    const targetLine = buildFrozenProductLineContext(targetCohort, targetMembers, targetProjection.members);
    titleCallCount = 0;
    const mapTarget = await ensureCohortTitles({
      run: targetFinalized, workspaceId, projection: targetProjection,
      cohort: targetCohort, frozenLineContext: targetLine,
    });
    expect(titleCallCount).toBe(1);
    expect(mapTarget.size).toBe(2);
    const targetRows = getCohortTitleOutputsByRun(targetFinalized.id);
    expect(targetRows).toHaveLength(2);
    // The target's fresh rows are ITS OWN members (whichever cohort the claim
    // order made the target) — never the foreign cohort's SKUs.
    const targetMemberSkus = targetProjection.members.map(m => m.productSku ?? '').sort();
    expect(targetRows.map(r => r.productSku).sort()).toEqual(targetMemberSkus);
    // The foreign rows are untouched under their own (superseded) run.
    const foreignRowsStill = getCohortTitleOutputsByRun(foreignFinalized.id);
    expect(foreignRowsStill).toHaveLength(2);
    expect(foreignRowsStill.map(r => r.productSku).sort()).toEqual(
      foreignProjection.members.map(m => m.productSku ?? '').sort(),
    );
  });

  it('rows already committed under revision B (stale-hash sibling commit) → CohortTitleAuthorityDriftError, never copies over the non-empty set, zero calls', async () => {
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles(runCoordParams(fixtureA));
    expect(titleCallCount).toBe(1);

    const fixtureB = await supersedeAndRefreeze(fixtureA);
    // A sibling already committed a set under B under a DIFFERENT authority.
    const { insertCohortTitleOutputsOnce } = await import('../../db/repositories/classification-cohort-output-repo');
    insertCohortTitleOutputsOnce({
      workspaceId: fixtureB.workspaceId,
      runId: fixtureB.run.id,
      inputHash: 'a'.repeat(64),
      outputs: [
        { productSku: '100000000001', title: 'Sibling Chicken Title', source: 'cohort_fallback' },
        { productSku: '100000000002', title: 'Sibling Beef Title', source: 'cohort_fallback' },
      ],
    });

    titleCallCount = 0;
    await expect(
      ensureCohortTitles(runCoordParams(fixtureB)),
    ).rejects.toBeInstanceOf(CohortTitleAuthorityDriftError);
    expect(titleCallCount).toBe(0);
    // The stale set is untouched (write-once) — the superseded copy never ran.
    const rowsB = getCohortTitleOutputsByRun(fixtureB.run.id);
    expect(rowsB).toHaveLength(2);
    expect(rowsB.every(r => r.inputHash === 'a'.repeat(64))).toBe(true);
  });

  it('the copy-race (sibling commits BETWEEN the pure reads and the copy insert) → CohortTitleAuthorityDriftError via the beforeTitleCopyInsert seam, zero calls, sibling rows intact', async () => {
    // Run A: one call + durable rows; superseded; revision B frozen. B's own
    // set is empty, A's superseded set matches the fresh T-hash → the copy
    // path engages. The seam fires INSIDE the copy path after the
    // lease-ownership assertion and before the insert — the racing sibling's
    // rows become visible exactly there, so the insert's write-once throw is
    // converted to the deterministic drift error (never a silent overwrite).
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles(runCoordParams(fixtureA));
    expect(titleCallCount).toBe(1);
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    const { insertCohortTitleOutputsOnce } = await import('../../db/repositories/classification-cohort-output-repo');

    titleCallCount = 0;
    await expect(
      ensureCohortTitles({
        ...runCoordParams(fixtureB),
        beforeTitleCopyInsert: () => {
          insertCohortTitleOutputsOnce({
            workspaceId: fixtureB.workspaceId,
            runId: fixtureB.run.id,
            inputHash: 'b'.repeat(64),
            outputs: [
              { productSku: '100000000001', title: 'Sibling Chicken Title', source: 'cohort_fallback' },
              { productSku: '100000000002', title: 'Sibling Beef Title', source: 'cohort_fallback' },
            ],
          });
        },
      }),
    ).rejects.toBeInstanceOf(CohortTitleAuthorityDriftError);
    expect(titleCallCount).toBe(0);
    // The racing sibling's set won write-once — the copy never overwrote it.
    const raced = getCohortTitleOutputsByRun(fixtureB.run.id);
    expect(raced).toHaveLength(2);
    expect(raced.every(r => r.inputHash === 'b'.repeat(64))).toBe(true);
    expect(raced.every(r => r.outputValueJson.includes('Sibling Chicken Title') || r.outputValueJson.includes('Sibling Beef Title'))).toBe(true);
  });

  it('ONLY the LATEST superseded run is a reuse candidate: an OLDER superseded run with a complete matching set is never consulted when the latest superseded set is incomplete (fresh coordinate)', async () => {
    // A coord → supersede A → B coord (reuses A: zero calls) → supersede B →
    // delete one of B's rows (incomplete latest) → C coord: the lookup finds
    // B (latest superseded) incomplete → NO reuse — and A (older, complete,
    // matching) must NOT be consulted → fresh coordinate (one call).
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles(runCoordParams(fixtureA));
    expect(titleCallCount).toBe(1);
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    titleCallCount = 0;
    const mapB = await ensureCohortTitles(runCoordParams(fixtureB));
    expect(titleCallCount).toBe(0);
    expect(mapB.size).toBe(2);
    // Make the LATEST superseded (B) incomplete.
    getDb().run(
      "DELETE FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000001'",
      [fixtureB.run.id],
    );
    const fixtureC = await supersedeAndRefreeze(fixtureB);
    titleCallCount = 0;
    const mapC = await ensureCohortTitles(runCoordParams(fixtureC));
    // Latest superseded incomplete → no reuse; the older matching set (A) is
    // NOT a candidate → fresh coordinate.
    expect(titleCallCount).toBe(1);
    expect(mapC.size).toBe(2);
    expect(getCohortTitleOutputsByRun(fixtureC.run.id)).toHaveLength(2);
  });

  it('getLatestSupersededRunForCohort NEVER returns a non-superseded run (running sibling is not a candidate, per the unique current-run index)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    // A is 'running' (never superseded): the lookup must be empty.
    expect(getLatestSupersededRunForCohort(fixture.cohort.id)).toBeNull();
    // After supersession the SAME run is the candidate.
    expect(supersedeOwnedCohortRunForOutputDrift(fixture.run.id, 'worker-a', 'PR13 C2 sibling test')).toBe(true);
    const found = getLatestSupersededRunForCohort(fixture.cohort.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(fixture.run.id);
    expect(found!.status).toBe('superseded');
  });

  it('PR13 review R2 (P2): an exact superseded_at TIE resolves deterministically via the id tiebreaker (superseded_at DESC, id DESC)', async () => {
    // Two superseded runs for the same cohort with IDENTICAL superseded_at:
    // the lookup must be deterministic (secondary id DESC), never
    // insertion-order dependent — repeated lookups agree on the SAME run.
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await ensureCohortTitles(runCoordParams(fixtureA));
    const tie = nowIso();
    getDb().run('UPDATE classification_cohort_runs SET superseded_at = ? WHERE id = ?', [tie, fixtureA.run.id]);
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    getDb().run('UPDATE classification_cohort_runs SET superseded_at = ? WHERE id = ?', [tie, fixtureB.run.id]);
    const first = getLatestSupersededRunForCohort(fixtureA.cohort.id)!;
    expect([fixtureA.run.id, fixtureB.run.id]).toContain(first.id);
    // Stable across repeated lookups (the id tiebreaker is deterministic).
    expect(getLatestSupersededRunForCohort(fixtureA.cohort.id)!.id).toBe(first.id);
    expect(getLatestSupersededRunForCohort(fixtureA.cohort.id)!.id).toBe(first.id);
    expect(getLatestSupersededRunForCohort(fixtureA.cohort.id)!.id).toBe(first.id);
  });

  it('PR13 review R2 (P1): cross-parent reuse FAILS CLOSED across title parameter sets — A under P1 + B under P2 (everything else identical) ⇒ NO copy, fresh coordination', async () => {
    // A coordinates under the P1 parameter tuple (a parameter-only release
    // models a different deployment's OPERATION_PARAMETERS); its T-hash is
    // H1. Supersede A. B is frozen under P2 (everything else identical —
    // same members, same evidence, same plan entry): the freshly computed
    // T-hash H2 ≠ H1, so the stored P1 set is NOT the same authority → no
    // copy → fresh title coordination (one call).
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    titleCallCount = 0;
    const mapA = await ensureCohortTitles({
      ...runCoordParams(fixtureA),
      titleOperationParameters: { temperature: 0.0, maxTokens: null }, // P1
    });
    expect(titleCallCount).toBe(1);
    expect(mapA.size).toBe(2);
    const rowsA = getCohortTitleOutputsByRun(fixtureA.run.id);
    expect(rowsA).toHaveLength(2);
    const hashA = rowsA[0].inputHash;
    expect(rowsA.every(r => r.inputHash === hashA)).toBe(true);

    const fixtureB = await supersedeAndRefreeze(fixtureA);
    titleCallCount = 0;
    const mapB = await ensureCohortTitles({
      ...runCoordParams(fixtureB),
      titleOperationParameters: { temperature: 0.1, maxTokens: null }, // P2 (the registry default)
    });
    // Different parameter authority → the stored P1 set is NOT reusable.
    expect(titleCallCount).toBe(1);
    expect(mapB.size).toBe(2);
    const rowsB = getCohortTitleOutputsByRun(fixtureB.run.id);
    expect(rowsB).toHaveLength(2);
    // B's rows carry a DIFFERENT hash than A's P1-era rows; A's set untouched.
    expect(rowsB.every(r => r.inputHash !== hashA)).toBe(true);
    expect(getCohortTitleOutputsByRun(fixtureA.run.id)).toEqual(rowsA);
  });

  it('PR13 review R2 (P1): SAME parameter authority across revisions still reuses — B under the SAME tuple as A ⇒ zero calls (the R2 regression must not break the economics)', async () => {
    const fixtureA = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    titleCallCount = 0;
    await ensureCohortTitles({
      ...runCoordParams(fixtureA),
      titleOperationParameters: { temperature: 0.0, maxTokens: null }, // P1
    });
    expect(titleCallCount).toBe(1);
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    titleCallCount = 0;
    const mapB = await ensureCohortTitles({
      ...runCoordParams(fixtureB),
      titleOperationParameters: { temperature: 0.0, maxTokens: null }, // P1 again
    });
    expect(titleCallCount).toBe(0);
    expect(mapB.size).toBe(2);
    expect(getCohortTitleOutputsByRun(fixtureB.run.id)).toHaveLength(2);
  });
});

// ─── Public-seam title crash coverage (plan §3.3; deferred Slice 2 item) ─────
//
// The active-bundle + counting-mock infrastructure required for the real
// coordinate path lives in this file, so the title pre-commit crash +
// reclaim scenarios run here — always through the PUBLIC `executeClaim`
// invocation (never the op directly, never mocked). A test calling
// `ensureCohortTitles` for these windows would not be evidence.

describe('title pre-commit crash through the public seam (issue #30 P1-1)', () => {
  it('crash TWICE pre-commit → zero rows each time; recovery coordinates once more then commits; later entries reuse call-free', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    const crashTitleCommit = () => {
      throw new Error('simulated title pre-commit crash');
    };
    // Crash twice (not once) so the test cannot pass on an at-most-once path.
    // Each attempt leaves the audited call durable but ZERO committed rows.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        curation.executeClaim(fixture.run.id, 'worker-a', {
          afterCoordinatedCall: crashTitleCommit,
        }),
      ).rejects.toThrow('simulated title pre-commit crash');
      expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
      expect(getCohortRunById(fixture.run.id)!.status).toBe('running');
    }
    expect(titleCallCount).toBe(2);
    // Recovery through the same public invocation: titles coordinate once
    // more (third audited call) and commit — then crash AFTER the member
    // pipeline so the committed title set survives with the run still open.
    await expect(
      curation.executeClaim(fixture.run.id, 'worker-a', {
        afterMemberPipeline: () => {
          throw new MemberCommitCrashSimulationError('simulated member-commit crash');
        },
      }),
    ).rejects.toBeInstanceOf(MemberCommitCrashSimulationError);
    expect(titleCallCount).toBe(3);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
    expect(getCohortRunById(fixture.run.id)!.status).toBe('running');
    // Final entry through the seam: the committed title set is REUSED with
    // zero new coordination calls; members complete; the parent completes.
    const callsBefore = titleCallCount;
    const finished = await curation.executeClaim(fixture.run.id, 'worker-a');
    expect(finished.executed).toBe(true);
    expect(titleCallCount).toBe(callsBefore);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
    // Active-bundle targets abstain under the null-for-non-title-ops mock,
    // so the parent completes with abstentions (2/2 members) — the title
    // path under test is unaffected.
    expect(getCohortRunById(fixture.run.id)!.status).toBe('completed_with_abstentions');
  });

  it('ownership lost in the title window: zero rows, no post-loss writes; the reclaiming owner alone finishes', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    // Worker A's transport resolves, but a sibling reclaims BEFORE A's
    // insert — then A crashes. A must leave zero rows and never write again.
    await expect(
      curation.executeClaim(fixture.run.id, 'worker-a', {
        afterCoordinatedCall: () => {
          getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', [
            '2000-01-01T00:00:00.000Z',
            fixture.run.id,
          ]);
          const reclaim = reclaimExpiredCohortRuns(
            fixture.workspaceId,
            new Date().toISOString(),
            run => curation.verifyFrozen(run),
            'worker-b',
            COHORT_LEASE_TTL_MS,
          );
          expect(reclaim.resumed.length).toBe(1);
          throw new Error('simulated title pre-commit crash');
        },
      }),
    ).rejects.toThrow('simulated title pre-commit crash');
    expect(titleCallCount).toBe(1);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
    // A is stale: the seam refuses without mutation or transport.
    const stale = await curation.executeClaim(fixture.run.id, 'worker-a');
    expect(stale.executed).toBe(false);
    if (!stale.executed) expect(stale.disposition).toBe('stale-owner');
    expect(titleCallCount).toBe(1);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
    // B alone finishes: exactly one more audited coordination (its own
    // recovery attempt), commit, member completion, parent completion.
    const finished = await curation.executeClaim(fixture.run.id, 'worker-b');
    expect(finished.executed).toBe(true);
    expect(titleCallCount).toBe(2);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
    // Same active-bundle abstention note as above: parent terminal success
    // carries abstentions; the title path under test is unaffected.
    expect(getCohortRunById(fixture.run.id)!.status).toBe('completed_with_abstentions');
    expect(getCohortRunById(fixture.run.id)!.claimedBy).toBe('worker-b');
  });
});