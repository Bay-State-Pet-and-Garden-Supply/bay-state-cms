/**
 * PR7 C7 (issue #30): acceptance integration test — durable parent Page
 * coordination (coordinated_page outputs), replay-safe after commit.
 *
 * Harness: pr6-acceptance.test.ts structure (temp DB, migrations,
 * `createReadyCohort`, active v2 bundle) with the PAGE curation target
 * ENABLED and a VERIFIED Page import frozen at cohort freeze. The counting
 * llm-client mock serves `cohort_page_assignment` (group) and
 * `page_assignment` (singleton) calls, writes the audited
 * `classification_model_calls` started+success pairs, and returns CANNED
 * per-SKU page assignments derived from the prompt's frozen page list (so
 * two group siblings can be assigned to DIFFERENT pages from ONE group call
 * — prompt rule 7). `denyPageCalls` switches the mock into the
 * policy-denied/unavailable mode (config resolves null → the coordinator
 * abstains every member with ZERO transport).
 *
 * Scenario coverage (architecture-report §7, PR7 C7):
 *  1. freeze (page target enabled, verified pages frozen) → processCohort #1
 *     establishes durable Page outputs: ONE group call + one singleton call,
 *     persisted in ONE transaction; `countCohortPageOutputs === member count`;
 *     members consume the EXACT stored assignments;
 *  2. crash after member 1 commits → expire the lease + reclaim → processCohort
 *     #2 on the SAME run: page op REUSES the stored set with ZERO page calls;
 *     remaining members consume the stored assignments; the committed member is
 *     skipped by the resume guard;
 *  3. reset member 1 (pending + cleared curation) → processCohort #3: page op
 *     REUSES (zero page calls), member 1 re-executes against a NEW child run
 *     with the SAME stored assignments;
 *  4. pre-commit crash replay: `afterCoordinatedCall` throws after transport
 *     success → zero output rows committed → reclaim → ONE more audited call →
 *     commit → every later entry call-free;
 *  5. drift (stale-hash rows) → `CohortPageAuthorityDriftError` → parent
 *     `superseded` + running children terminalized (error_message 'Cohort
 *     output authority drift superseded parent run') → the next claim yields a
 *     DIFFERENT parent run id → old page rows unchanged;
 *  6. wrong-owner no-op: a stale worker's supersede attempt is a no-op;
 *  7. policy-denied/unavailable → persisted `abstained` rows (one per member);
 *     retries make ZERO page calls;
 *  8. legitimate sibling page differences survive ONE group call (two
 *     siblings on DIFFERENT pages);
 *  9. singleton member parent-owned: exactly ONE output row, child
 *     materializes it, retry → zero calls;
 * 10. flag OFF / shadow → the LEGACY path (cached `coordinateCohortPagesOnce`
 *     + per-item `llmAssignCategoryPages`) is used byte-identically — zero
 *     durable page output rows, zero parent-op page calls.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
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
  supersedeOwnedCohortRunForOutputDrift,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortPageOutputsByRun,
  insertCohortPageOutputsOnce,
  countCohortPageOutputs,
} from '../../db/repositories/classification-cohort-output-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { freezeCohortForExecution, verifyCohortRunFrozen } from '../../onboarding/cohort-curation/freeze';
import { buildFrozenProductLineContext } from '../../onboarding/cohort-curation/frozen-evidence';
import { MemberCommitCrashSimulationError } from '../../onboarding/cohort-curation/members';
import { executeViaSeam } from './helpers/cohort-curation-harness';
import { ensureCohortPages } from '../../onboarding/cohort-curation/pages';
import type { CoordinatedPageMemberValue } from '../../classification/types';
import type { PreparedCohortContext } from './helpers/transitional-prepared-member';
import { curateTransitionalPreparedMember } from './helpers/transitional-prepared-member';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { clearCohortPageCoordinationCache, coordinateCohortPagesOnce } from '../../classification/cohort-page-proposal-engine';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import { titleExecutionTypeAuthorityFromRun } from '../../classification/cohort-decision-authority';
import {
  buildCohortPageAuthorityBundle,
  computeCohortPageInputHash,
  type CohortPagePlanAuthority,
} from '../../onboarding/cohort-curation/pages';
import { resolveTargetsFromSnapshot } from '../../classification/curation-target-resolver';
import { buildPageHierarchy } from '../../classification/page-assignment-llm';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { parseExecutionEvidenceProjection, CohortPageOutputSchema } from '../../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  ExecutionEvidenceProjectionV2,
} from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';

// ─── llm-client mock (counting; simulates the audited transport rows) ─────────

/** Total GROUP (`coordinateCohortPagesCore`, multi-SKU prompt) transport
 *  invocations. PR7 review R1 (B3): the parent-owned singleton transport now
 *  ALSO carries protectedOperation 'cohort_page_assignment', so group vs
 *  singleton is distinguished by PROMPT SHAPE (the group prompt starts with
 *  'Classify every product variant below'; the singleton prompt starts with
 *  'STORE CONTEXT:') — never by the operation alone. */
let groupPageCallCount = 0;
/** Total singleton (parent-owned + legacy per-item) invocations. */
let singletonPageCallCount = 0;
/** Invocations carrying an audit context (the parent op's audited calls). */
let auditedPageCallCount = 0;
/** Page-denial mode: 'none' → normal; 'unavailable' → the config resolves
 *  NULL (no category_page_assignment LLM configured); 'policyDenied' →
 *  `getLlmConfigForTask` THROWS like the policy gateway (PR7 review R1, T7 —
 *  the two take distinct preflight reason/status paths and must both persist
 *  durable abstained rows with ZERO transport). */
type PageDenyMode = 'none' | 'unavailable' | 'policyDenied';
let denyPageMode: PageDenyMode = 'none';
let auditCallSeq = 0;
/** The exact prompt string the parent GROUP transport received (review R1 B1:
 *  the active parent prompt must be the v2 text with the Execution Type block
 *  — asserted at the transport level). */
let capturedGroupPrompt: string | null = null;

const PAGE_NAMES = ['Dog Food Dry', 'Dog Food Canned', 'Brand - Acme'];

/** PR7 review R1 (T3): FROZEN expected legacy page results — the COMPLETE
 *  {pageName, confidence} proposal set per SKU the legacy path must produce
 *  byte-identically (flag OFF and shadow). The canned responses assign Dog
 *  Food Dry / Dog Food Canned from the frozen page list (position-independent, see
 *  `cannedGroupResponse`) and the deterministic normalizer adds the exact
 *  'Brand - Acme' page in multiple mode (0.85 canned + 0.95 brand shortcut).
 *  Entries are sorted by pageName for order-independent set equality. */
const LEGACY_PAGE_RESULTS_BASELINE: Record<string, Array<{ pageName: string; confidence: number }>> = {
  '100000000001': [
    { pageName: 'Brand - Acme', confidence: 0.95 },
    { pageName: 'Dog Food Dry', confidence: 0.85 },
  ],
  '100000000002': [
    { pageName: 'Brand - Acme', confidence: 0.95 },
    { pageName: 'Dog Food Canned', confidence: 0.85 },
  ],
  // The legacy SINGLETON path resolves its brand from the restricted page
  // evidence packet (no brand record in this harness) — the normalizer never
  // sees a brand page, so the result is the single canned page only.
  '100000000003': [
    { pageName: 'Dog Food Dry', confidence: 0.85 },
  ],
};

/** Extract the frozen page list from a page prompt (`[ID:xxx] Name ...`). */
function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

function findPage(pages: Array<{ id: string; name: string }>, name: string) {
  return pages.find(page => page.name === name) ?? null;
}

/** The group response: every SKU in the prompt assigned to a FROZEN page.
 *  Siblings differ by design (rule 7): the SKU VALUE decides the page —
 *  '100000000001' → Dog Food Dry, '100000000002' → Dog Food Canned — so member /
 *  prompt ORDER can never flip the result (the T3 frozen legacy baseline is
 *  position-independent). */
function cannedGroupResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const skus = [...prompt.matchAll(/^SKU (\d{10,})$/gm)].map(match => match[1]);
  const payload: Record<string, unknown> = {};
  for (const sku of skus) {
    const evenSku = Number(sku.slice(-2)) % 2 === 0;
    const page = findPage(pages, evenSku ? PAGE_NAMES[1] : PAGE_NAMES[0]);
    payload[sku] = page ? [{ pageId: page.id, pageName: page.name, confidence: 0.85 }] : [];
  }
  return JSON.stringify(payload);
}

/** The singleton response: `{"pages":[...]}` (llmAssignCategoryPages shape). */
function cannedSingletonResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const page = findPage(pages, PAGE_NAMES[0]);
  return JSON.stringify({ pages: page ? [{ pageId: page.id, pageName: page.name, confidence: 0.85 }] : [] });
}

function mockGetLlmConfigForTask(_task: string, options: Record<string, any>): Record<string, any> | null {
  const operation = options?.protectedOperation;
  if (denyPageMode !== 'none' && (operation === 'cohort_page_assignment' || operation === 'page_assignment' || operation === 'cohort_page_assignment_parent')) {
    if (denyPageMode === 'policyDenied') {
      // The policy gateway THROWS for a denied route (distinct from the null
      // "unavailable" resolution) — the group core records a policyDenied
      // terminal preflight, and the singleton transport throws before any
      // request is made.
      throw new Error('model-policy-denied');
    }
    return null;
  }
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

/** Simulate the audited transport's durable started + success rows. The
 *  RETURNED call id must be a real `classification_model_calls.id` (the
 *  materialized proposals link to it), so the success row carries the returned
 *  id and the started row a suffixed mirror. PR7 review R2 (F2d): the row is
 *  manufactured per PRODUCTION semantics — operation + prompt/rule versions
 *  come from the ModelCall context (`options.modelCall`), NEVER from the
 *  transport's protectedOperation routing hint. */
function writeAuditPair(
  ctx: { runId: string; snapshotHash: string | null; operation: string; promptTemplateVersion: string; ruleVersion: string },
  callId: string,
): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'category_page_proposals', ?, 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    [`${callId}-started`, ctx.runId, ctx.operation, ctx.snapshotHash, ctx.promptTemplateVersion, ctx.ruleVersion, 'sys-hash', 'user-hash', now, null, now],
  );
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'category_page_proposals', ?, 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [callId, ctx.runId, ctx.operation, ctx.snapshotHash, ctx.promptTemplateVersion, ctx.ruleVersion, 'sys-hash', 'user-hash', now, now, now],
  );
}

async function mockCallLlmForTaskWithProvenance(
  task: string,
  prompt: string,
  systemPrompt: string,
  options: Record<string, any>,
): Promise<{ content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null> {
  const operation = options?.protectedOperation;
  if (operation !== 'cohort_page_assignment' && operation !== 'page_assignment' && operation !== 'cohort_page_assignment_parent') return null;
  if (denyPageMode === 'unavailable') return null;
  if (denyPageMode === 'policyDenied') throw new Error('Model policy denied (policy_denied)');
  const callId = `page-call-${++auditCallSeq}`;
  // PR7 review R2 (F2): the parent singleton is a ONE-MEMBER core invocation,
  // so ALL parent calls use the group prompt shape ('Classify every product
  // variant below'). The legacy per-item singleton (llmAssignCategoryPages)
  // still renders 'STORE CONTEXT:...'. Distinguish by PROMPT SHAPE + SKU
  // count so the call-count assertions stay exact.
  const isCorePrompt = prompt.startsWith('Classify every product variant below');
  if (isCorePrompt) {
    const skuCount = (prompt.match(/^SKU \S+$/gm) ?? []).length;
    if (skuCount > 1) groupPageCallCount++;
    else singletonPageCallCount++;
    if (capturedGroupPrompt === null) capturedGroupPrompt = prompt;
    if (options.modelCall) {
      auditedPageCallCount++;
      writeAuditPair(options.modelCall, callId);
    }
    return {
      content: cannedGroupResponse(prompt),
      callId,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  // Legacy per-item singleton (llmAssignCategoryPages — child path).
  singletonPageCallCount++;
  if (options.modelCall) {
    auditedPageCallCount++;
    writeAuditPair(options.modelCall, callId);
  }
  return {
    content: cannedSingletonResponse(prompt),
    callId,
    provider: 'ollama',
    model: 'qwen2.5vl:latest',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: (task: string, options: Record<string, any>) => mockGetLlmConfigForTask(task, options),
  callLlmForTask: () => null,
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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr7-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => {
  groupPageCallCount = 0;
  singletonPageCallCount = 0;
  auditedPageCallCount = 0;
  denyPageMode = 'none';
  capturedGroupPrompt = null;
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
  clearCohortPageCoordinationCache();
  // NOTE: `auditCallSeq` is deliberately NOT reset — the audit-row ids must
  // stay globally unique across tests in this shared database file.
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

/** Write a lifecycle-ACTIVE v2 bundle (reviewed Bay State seed) to disk with
 *  the PAGE curation target left ENABLED (unlike the PR6 acceptance harness),
 *  so the frozen member snapshots resolve a verified Page catalog and the
 *  parent page op coordinates real pages. */
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

  const focusedFiles = buildFocusedFiles(bundle);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const manifestWithoutHash = {
    ...bundle.manifest,
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
  return { bundle: { ...bundle, manifest }, xmlFields };
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR7 Acceptance Batch', fileName: 'pr7.xlsx', totalItems: itemsData.length }).id;
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

function countPageAuditRowsForRun(cohortRunId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_model_calls
     WHERE operation IN ('cohort_page_assignment', 'page_assignment', 'cohort_page_assignment_parent')
       AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
  ).get(cohortRunId) as { cnt: number };
  return Number(row.cnt);
}

function countOutputRowsForWorkspace(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_outputs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

// ─── Scenario helpers ─────────────────────────────────────────────────────────

const THREE_MEMBER_EXTRACTIONS = {
  // Members 1 + 2 share brand + name stem → ONE `groupByProductLine` group.
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
  // Member 3: a DIFFERENT stem → a singleton group of 1 (parent-owned too).
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Salmon 5 lb', _brandHint: 'Acme' }),
};

/** Activate ONE verified Page import with the fixture pages (Dog Food Dry,
 *  Dog Food Canned, Brand - Acme). Returns the generated page_index ids. */
function activateVerifiedPages(wsId: string): Map<string, string> {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-food-canned', name: 'Dog Food Canned' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr7-acceptance-pages'),
    parserFormatVersion: 'pages-xml-1',
    records: pages.map(page => ({
      identity: { kind: 'exported_guid' as const, key: page.key, status: 'verified' as const },
      name: page.name,
      parentRef: null,
      availability: 'available' as const,
    })),
    activatedBy: 'test',
  });
  const byName = new Map<string, string>();
  for (const row of listVerifiedPageOptions(wsId)) byName.set(row.name, row.id);
  const result = new Map<string, string>();
  for (const page of pages) {
    const id = byName.get(page.name);
    if (!id) throw new Error(`verified fixture page not created: ${page.name}`);
    result.set(page.key, id);
  }
  return result;
}

/** Write the active v2 bundle + persist its config snapshot, activate the
 *  verified Page import, then create the ready cohort. The product-line
 *  cohort formation can split the fixture into multiple cohorts (one per
 *  brand+stem) — they are merged into a SINGLE cohort (the singleton's cohort
 *  is superseded and its members moved) so the parent page op covers a
 *  mixed group+singleton P-set in ONE run (mirrors the PR6 SHOULD-FIX 2
 *  merge). */
function prepareActiveV2Workspace(
  wsId: string,
  wsPath: string,
  extByUpc: Record<string, Record<string, any>>,
): { items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(wsId, bundle);
  activateVerifiedPages(wsId);
  const created = createReadyCohort(wsId, extByUpc);
  if (created.cohorts.length > 1) {
    const target = created.cohorts[0];
    for (const donor of created.cohorts.slice(1)) {
      getDb().run('UPDATE curation_cohort_members SET cohort_id = ? WHERE cohort_id = ?', [target.id, donor.id]);
      getDb().run(
        "UPDATE curation_cohorts SET status = 'superseded', superseded_at = ? WHERE id = ?",
        [new Date().toISOString(), donor.id],
      );
    }
    getDb().run(
      'UPDATE curation_cohorts SET membership_hash = ? WHERE id = ?',
      [computeMembershipHash(created.items.map(item => item.id)), target.id],
    );
    // The donor members kept their ORIGINAL cohort ordinals — renumber every
    // merged member 0..n-1 in item order so the parent op's ordinal-sorted
    // member loop matches the fixture's intended order.
    const members = getDb().query(
      'SELECT onboarding_item_id FROM curation_cohort_members WHERE cohort_id = ? ORDER BY rowid',
    ).all(target.id) as Array<{ onboarding_item_id: string }>;
    members.forEach((member, index) => {
      getDb().run(
        'UPDATE curation_cohort_members SET ordinal = ? WHERE cohort_id = ? AND onboarding_item_id = ?',
        [index, target.id, member.onboarding_item_id],
      );
    });
  }
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
// @ts-expect-error -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
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
    coordinatedPages: new Map<string, CoordinatedPageMemberValue>(
      getCohortPageOutputsByRun(run.id).map(row => [
        row.productSku,
        {
          output: CohortPageOutputSchema.parse(JSON.parse(row.outputValueJson)),
          modelCallId: row.modelCallId,
        },
      ]),
    ),
  };
}

/** Replicate the parent Page op's P-hash for a frozen run (the ordinal-0
 *  member's frozen runtime snapshot → Execution Type + FROZEN-PLAN model
 *  authority + page plan → the canonical bundle) — used by the drift matrix so
 *  missing / extra member rows are caught by EXACT-SET completeness, not by a
 *  hash mismatch. The bundle derives `modelAuthority` + `ruleVersion` from the
 *  snapshot's `cohort_page_assignment_parent` plan entry (review R2 F2c). */
function expectedPageInputHash(
  workspaceId: string,
  wsPath: string,
  run: CohortRun,
  projection: ExecutionEvidenceProjectionV2,
): string {
  const ordered = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const child = getDb().query(
    'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(run.id, ordered[0]?.onboardingItemId ?? '') as { config_snapshot_hash: string } | undefined;
  const snapshot = child?.config_snapshot_hash
    ? getRuntimeSnapshotByHash(workspaceId, child.config_snapshot_hash)
    : null;
  if (!snapshot) throw new Error('ordinal-0 member runtime snapshot missing');
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(run, snapshot);
  const resolved = resolveTargetsFromSnapshot(snapshot);
  const pageTarget = resolved.pages[0];
  const verifiedPagesAvailable = resolved.pages.length > 0 && pageTarget.options.length > 0;
  const selectionMode = (pageTarget?.config.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;
  const pagePlan: CohortPagePlanAuthority = {
    pages: verifiedPagesAvailable
      ? buildPageHierarchy(pageTarget.options, snapshot.pages.state === 'verified' ? snapshot.pages.records : [])
      : [],
    selectionMode,
    maxPages,
  };
  return computeCohortPageInputHash(
    buildCohortPageAuthorityBundle({ run, projection, pagePlan, executionTypeAuthority, snapshot }),
  );
}

/** PR7 review R1 (T1): the acceptance drift-matrix seeds. Every scenario must
 *  prove supersession, children terminalization, immediate new-run
 *  claimability, and immutable old rows. `freshHash` is the true P-hash — the
 *  missing/extra scenarios seed rows with the CORRECT hash so the drift is
 *  proven by exact-set membership/count, not by a hash mismatch. */
type DriftScenario = 'stale-hash' | 'missing-member' | 'extra-row';

function seedDriftRows(
  workspaceId: string,
  run: CohortRun,
  skus: string[],
  scenario: DriftScenario,
  freshHash: string,
): void {
  const abstained = { status: 'abstained' as const, reason: 'seeded drift page output' };
  if (scenario === 'stale-hash') {
    insertCohortPageOutputsOnce({
      workspaceId,
      runId: run.id,
      inputHash: 'b'.repeat(64),
      outputs: skus.map(productSku => ({ productSku, output: abstained, modelCallId: null })),
    });
    return;
  }
  if (scenario === 'missing-member') {
    insertCohortPageOutputsOnce({
      workspaceId,
      runId: run.id,
      inputHash: freshHash,
      outputs: skus.slice(0, skus.length - 1).map(productSku => ({ productSku, output: abstained, modelCallId: null })),
    });
    return;
  }
  // extra-row: the exact P-set PLUS an unexpected SKU, all with the CORRECT
  // hash — only the membership/count check can catch it.
  insertCohortPageOutputsOnce({
    workspaceId,
    runId: run.id,
    inputHash: freshHash,
    outputs: [
      ...skus.map(productSku => ({ productSku, output: abstained, modelCallId: null })),
      { productSku: '100000000099', output: abstained, modelCallId: null },
    ],
  });
}

function seededDriftRowCount(scenario: DriftScenario, memberCount: number): number {
  if (scenario === 'stale-hash') return memberCount;
  if (scenario === 'missing-member') return memberCount - 1;
  return memberCount + 1;
}

describe('PR7 acceptance — durable parent page coordination, replay-safe after commit (issue #30)', () => {
  it('1-2-3: freeze writes verified pages; processCohort #1 coordinates ONE group call + ONE singleton call and persists a row per member; kill/restart reuses with ZERO page calls; a NEW child re-execution consumes the SAME stored assignments', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    // Freeze: running + execution type + a VERIFIED page catalog.
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBe('dog-food-dry');

    // ── processCohort #1: crash after the SECOND member's pipeline completes
    // (before ITS atomic commit) — member 1 COMMITS, members 2 and 3 do not.
    // The parent page op already persisted every member's page output BEFORE
    // the member loop (one group call + one singleton call).
    let pipelineCount = 0;
    await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a', {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 2) {
          throw new MemberCommitCrashSimulationError('simulated kill after member 1 commit');
        }
      },
    })).rejects.toThrow('simulated kill after member 1 commit');

    // The durable set: EXACTLY ONE group call + ONE singleton call; a row for
    // EVERY member (the P-set, DECISION-A).
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    const rows = getCohortPageOutputsByRun(finalized.id);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.inputHash === rows[0].inputHash)).toBe(true);
    expect(rows.every(r => r.inputHash.length === 64)).toBe(true);
    // One audited started+success pair per invocation (group + singleton).
    expect(auditedPageCallCount).toBe(2);
    // PR7 review R1 (B1): the ACTIVE parent group transport prompt is the v2
    // text — it carries the full Execution Type context block (id + label +
    // confidence + outcome) rendered from the hashed authority. This is the
    // transport-level assertion on the real parent path. The confidence /
    // outcome come from the frozen run row (the SAME authority the P-hash
    // and the prompt render).
    expect(capturedGroupPrompt).not.toBeNull();
    const runTypeRow = getDb().query(
      'SELECT product_type_confidence, product_type_outcome FROM classification_cohort_runs WHERE id = ?',
    ).get(finalized.id) as { product_type_confidence: number | null; product_type_outcome: string | null };
    expect(capturedGroupPrompt!).toContain(
      `EXECUTION PRODUCT TYPE CONTEXT:\nProduct Type Context: "dog-food-dry (Dry Dog Food)"\nConfidence: ${String(runTypeRow.product_type_confidence)}\nOutcome: ${String(runTypeRow.product_type_outcome)}`,
    );
    expect(capturedGroupPrompt!).not.toContain('not resolved');

    // Member 1 committed with its stored assignment; members 2+3 untouched.
    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.stageStatus).toBe('completed');
    const memberOnePages = memberOne.curationData!.classificationProposals.filter(
      proposal => proposal.proposalType === 'category_page',
    );
    expect(memberOnePages.length).toBeGreaterThan(0);
    expect(memberOnePages.every(p => (p.proposedValue as any).identityVerified === true)).toBe(true);
    const memberTwo = findItemById(items[1].id)!;
    const memberThree = findItemById(items[2].id)!;
    expect(memberTwo.stageStatus).toBe('pending');
    expect(memberThree.stageStatus).toBe('pending');

    // Kill/restart: clear BOTH caches (DB authority), expire the lease,
    // reclaim with a NEW worker id → resume the SAME run via the frozen-match.
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
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

    // ── processCohort #2: page op REUSES the stored set with ZERO page
    // calls; member 1 skipped by the resume guard; member 2 commits; crash
    // again after member 3's pipeline so the parent STAYS running (the
    // member-1 retry below must run against a live parent).
    const pageCallsBefore = groupPageCallCount + singletonPageCallCount;
    const auditRowsBefore = countPageAuditRowsForRun(finalized.id);
    let resumePipelineCount = 0;
    await expect(executeViaSeam(wsPath, workspaceId, resumed.id, 'worker-b', {
      afterMemberPipeline: () => {
        resumePipelineCount++;
        if (resumePipelineCount === 2) {
          throw new MemberCommitCrashSimulationError('simulated kill after member 2 commit');
        }
      },
    })).rejects.toThrow('simulated kill after member 2 commit');
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCallsBefore); // ZERO new page calls
    expect(countPageAuditRowsForRun(finalized.id)).toBe(auditRowsBefore);

    const memberTwoAfter = findItemById(items[1].id)!;
    const memberThreeAfter = findItemById(items[2].id)!;
    expect(memberTwoAfter.stageStatus).toBe('completed');
    expect(memberThreeAfter.stageStatus).toBe('pending');

    // ── Retry member 1 with a NEW child run: reset the item (stage pending,
    // curation cleared) and processCohort #3. The old child is terminal, so
    // ensureMemberRun creates a NEW child; the page op REUSES (zero calls);
    // the re-executed member materializes the SAME stored assignments and
    // member 3 finally commits; the parent completes.
    updateItemStageStatus(items[0].id, 'pending');
    updateItemCurationData(items[0].id, '');
    const childBefore = getDb().query(
      'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(finalized.id, items[0].id) as { id: string } | undefined;
    const summary3 = await executeViaSeam(wsPath, workspaceId, resumed.id, 'worker-b');
    expect(summary3.parentStatus).not.toBe('failed');
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCallsBefore); // STILL zero page calls
    const childAfter = getDb().query(
      'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(finalized.id, items[0].id) as { id: string } | undefined;
    expect(childAfter).toBeTruthy();
    expect(childAfter!.id).not.toBe(childBefore!.id); // a NEW child run

    // Every member now consumes the EXACT stored assignments (PR7 review R1,
    // T6): the normalized {pageId, pageName, confidence} proposal set equals
    // the member's stored coordinated_page row — never containment. Additive
    // historical proposals are excluded by scoping to the member's relevant
    // (final) child run, exactly as the retried member-A check below does.
    const storedBySku = new Map(rows.map(r => [r.productSku, JSON.parse(r.outputValueJson)]));
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const memberChild = getDb().query(
        'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      ).get(finalized.id, item.id) as { id: string } | undefined;
      const pageProposals = stored.curationData!.classificationProposals.filter(
        proposal => proposal.proposalType === 'category_page' && proposal.runId === memberChild?.id,
      );
      expect(pageProposals.length).toBeGreaterThan(0);
      const storedRow = storedBySku.get(item.upc) as { pages: Array<{ pageId: string; pageName: string; confidence: number }> };
      const proposalSet = new Set(pageProposals.map(proposal => {
        const value = (proposal.proposedValue as any) ?? {};
        return `${proposal.targetId}\u0000${value.pageName}\u0000${proposal.confidence}`;
      }));
      expect(proposalSet.size).toBe(storedRow.pages.length);
      for (const storedPage of storedRow.pages) {
        expect(proposalSet.has(`${storedPage.pageId}\u0000${storedPage.pageName}\u0000${storedPage.confidence}`)).toBe(true);
      }
      expect(pageProposals.every(p => (p.proposedValue as any).identityVerified === true)).toBe(true);
    }
    const rerunMemberOne = findItemById(items[0].id)!;
    const rerunPages = rerunMemberOne.curationData!.classificationProposals.filter(
      proposal => proposal.proposalType === 'category_page',
    );
    const storedMemberOne = storedBySku.get(items[0].upc) as { pages: Array<{ pageId: string; pageName: string }> };
    expect(rerunPages.map(p => p.targetId).sort()).toEqual(storedMemberOne.pages.map(page => page.pageId).sort());

    // Total transport: exactly ONE group + ONE singleton call across the
    // whole kill/restart/re-execute scenario (replay-safe after commit).
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
  });

  it('5-6: drift rows (stale hash / MISSING member / EXTRA unexpected row) → CohortPageAuthorityDriftError → parent SUPERSEDED + running children terminalized → next claim yields a DIFFERENT run id; wrong-owner supersede is a no-op WHILE the run is still RUNNING; old page rows unchanged', async () => {
    // PR7 review R1 (T1): the acceptance drift MATRIX — every scenario must
    // prove supersession, children terminalized with the deterministic
    // message, immediate new-run claimability with a DIFFERENT run id, and
    // immutable old rows.
    for (const scenario of ['stale-hash', 'missing-member', 'extra-row'] as DriftScenario[]) {
      const { workspaceId, workspacePath: wsPath } = newWorkspace();
      const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
      const finalized = await freezeActiveCohort(workspaceId, wsPath);
      const projection = loadFrozenProjection(workspaceId, finalized);
      const skus = projection.members.map(member => member.productSku ?? '');
      const freshHash = expectedPageInputHash(workspaceId, wsPath, finalized, projection);

      // Corrupt the committed set BEFORE any processCohort entry. The
      // missing/extra scenarios seed rows with the CORRECT hash so only the
      // exact-set membership/count check can catch them.
      seedDriftRows(workspaceId, finalized, skus, scenario, freshHash);
      expect(countCohortPageOutputs(finalized.id)).toBe(seededDriftRowCount(scenario, skus.length));

      const childrenBefore = getDb().query(
        'SELECT id, status FROM classification_runs WHERE cohort_run_id = ?',
      ).all(finalized.id) as Array<{ id: string; status: string }>;
      expect(childrenBefore.length).toBeGreaterThan(0);

      // PR7 review R1 (T2): a STALE worker's supersede attempt is exercised
      // while the run is still RUNNING and owned by worker-a — the ownership
      // guard (not the terminal-status predicate) must reject it. Parent +
      // children remain completely unchanged.
      expect(getCohortRunById(finalized.id)!.status).toBe('running');
      expect(supersedeOwnedCohortRunForOutputDrift(
        finalized.id,
        'stale-worker',
        'stale worker supersede attempt',
      )).toBe(false);
      const stillRunning = getCohortRunById(finalized.id)!;
      expect(stillRunning.status).toBe('running');
      expect(stillRunning.errorMessage).toBeNull();
      for (const child of childrenBefore) {
        const after = getDb().query(
          'SELECT status, error_message FROM classification_runs WHERE id = ?',
        ).get(child.id) as { status: string; error_message: string | null };
        expect(after.status).toBe(child.status);
        expect(after.error_message).toBeNull();
      }

      // Now exercise the VALID owner drift path: the parent op's exact-set /
      // hash check FAILS CLOSED for the current owner.
      await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a')).rejects.toThrow(/CohortPageAuthorityDrift/);

      const terminal = getCohortRunById(finalized.id)!;
      expect(terminal.status).toBe('superseded');
      expect(terminal.errorMessage).toContain('CohortPageAuthorityDrift');
      expect(terminal.errorMessage).toContain(finalized.id);
      for (const child of childrenBefore) {
        const after = getDb().query(
          'SELECT status, error_message FROM classification_runs WHERE id = ?',
        ).get(child.id) as { status: string; error_message: string | null };
        expect(after.status).toBe('failed');
        // Terminalized children carry the deterministic supersede message.
        expect(after.error_message).toContain('Cohort output authority drift superseded parent run');
      }
      for (const item of items) {
        const stored = findItemById(item.id)!;
        expect(stored.stageStatus).toBe('pending');
        expect(stored.curationData).toBeNull();
      }
      // Old page rows unchanged (immutable historical truth).
      expect(getCohortPageOutputsByRun(finalized.id)).toHaveLength(seededDriftRowCount(scenario, skus.length));

      // Wrong-owner no-op against the now-terminal run remains a no-op.
      expect(supersedeOwnedCohortRunForOutputDrift(
        finalized.id,
        'stale-worker',
        'stale worker supersede attempt',
      )).toBe(false);
      const stillSuperseded = getCohortRunById(finalized.id)!;
      expect(stillSuperseded.status).toBe('superseded');
      expect(stillSuperseded.errorMessage).toContain('CohortPageAuthorityDrift');
      expect(stillSuperseded.errorMessage).not.toContain('stale worker');

      // The next claim immediately yields a DIFFERENT parent run id.
      const [run2] = claimReadyCurationCohorts(workspaceId, 10, 'worker-next', COHORT_LEASE_TTL_MS);
      expect(run2).toBeTruthy();
      expect(run2.id).not.toBe(finalized.id);
    }
  });

  it('7: policy-denied/unavailable (BOTH preflight paths) → persisted abstained rows (one per member); retries make ZERO page calls', async () => {
    // PR7 review R1 (T7): unavailable (getLlmConfigForTask returns NULL) and
    // policy-denied (getLlmConfigForTask THROWS like the policy gateway) take
    // distinct preflight reason/status paths — BOTH must persist durable
    // abstained rows with ZERO transport/re-calls.
    for (const mode of ['unavailable', 'policyDenied'] as PageDenyMode[]) {
      denyPageMode = mode;
      const { workspaceId, workspacePath: wsPath } = newWorkspace();
      prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
      const finalized = await freezeActiveCohort(workspaceId, wsPath);

      // The parent op coordinates with a DENIED page route: the group core
      // records the denial terminal preflight and abstains every group member
      // (zero transport); the singleton path deterministically abstains — with
      // ZERO transport. Every member's result persists as a durable abstained
      // row.
      const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
      expect(summary.parentStatus).not.toBe('failed');
      expect(groupPageCallCount).toBe(0);
      expect(singletonPageCallCount).toBe(0);
      expect(auditedPageCallCount).toBe(0);
      expect(countCohortPageOutputs(finalized.id)).toBe(3);
      const rows = getCohortPageOutputsByRun(finalized.id);
      expect(rows.every(r => JSON.parse(r.outputValueJson).status === 'abstained')).toBe(true);
      // Children materialize the stored abstention (the category_page stage
      // abstains with the stored reason — no LLM, no invention).
      for (const item of getDb().query(
        `SELECT i.id FROM onboarding_items i
         JOIN onboarding_batches b ON b.id = i.batch_id
         WHERE b.workspace_id = ?`,
      ).all(workspaceId) as Array<{ id: string }>) {
        const stored = findItemById(item.id)!;
        expect(['completed', 'completed_with_abstentions']).toContain(stored.stageStatus);
        const pageProposals = stored.curationData!.classificationProposals.filter(
          proposal => proposal.proposalType === 'category_page',
        );
        expect(pageProposals).toHaveLength(0);
      }

      // Retry (still denied): the durable set is complete + hash-matched → the
      // page op REUSES with ZERO calls. The parent completed after the first
      // entry, so the reuse is proven by re-invoking the parent op directly
      // (pure read on the committed set).
      const projection = loadFrozenProjection(workspaceId, finalized);
      const cohort = getCohortById(finalized.cohortId)!;
      const members = getCohortMembers(cohort.id);
      const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
      const pageCalls = groupPageCallCount + singletonPageCallCount;
      const reused = await ensureCohortPages({
        run: finalized,
        workspaceId,
        projection,
        frozenLineContext,
      });
      expect(reused.size).toBe(3);
      expect([...reused.values()].every(value => value.output.status === 'abstained')).toBe(true);
      expect(groupPageCallCount + singletonPageCallCount).toBe(pageCalls);
      expect(countCohortPageOutputs(finalized.id)).toBe(3);
      expect(getCohortPageOutputsByRun(finalized.id).every(r => JSON.parse(r.outputValueJson).status === 'abstained')).toBe(true);
    }
  });

  it('8: legitimate sibling page differences survive ONE group call (two siblings assigned to DIFFERENT pages)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.parentStatus).not.toBe('failed');
    // ONE group call for the two siblings; the singleton used the per-item
    // parent path.
    expect(groupPageCallCount).toBe(1);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);

    const siblingOne = findItemById(items[0].id)!;
    const siblingTwo = findItemById(items[1].id)!;
    const pagesOne = siblingOne.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
    const pagesTwo = siblingTwo.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(pagesOne.length).toBeGreaterThan(0);
    expect(pagesTwo.length).toBeGreaterThan(0);
    // Rule 7: siblings may legitimately differ — the canned response assigned
    // one to Dog Food Dry and the other to Dog Food Canned from ONE group call.
    const pagesByName = new Map<string, string[]>();
    for (const row of getCohortPageOutputsByRun(finalized.id)) {
      const names = (JSON.parse(row.outputValueJson).pages as Array<{ pageName: string }>).map(p => p.pageName);
      pagesByName.set(row.productSku, names);
    }
    const namesOne = pagesByName.get(items[0].upc)!;
    const namesTwo = pagesByName.get(items[1].upc)!;
    expect(namesOne.some(name => name === 'Dog Food Dry')).toBe(true);
    expect(namesTwo.some(name => name === 'Dog Food Canned')).toBe(true);
    expect(pagesOne[0].targetId).not.toBe(pagesTwo[0].targetId);
  });

  it('9: singleton member parent-owned — exactly ONE output row; the child materializes it; retry → zero calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.parentStatus).not.toBe('failed');
    // The singleton member (100000000003) has exactly ONE durable row AND its
    // proposals came from the stored row — the per-item child path was NOT
    // consulted (no second call).
    expect(singletonPageCallCount).toBe(1);
    const singleton = findItemById(items[2].id)!;
    expect(singleton.stageStatus).toBe('completed');
    const singletonPages = singleton.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(singletonPages.length).toBeGreaterThan(0);
    const singletonRow = getCohortPageOutputsByRun(finalized.id).find(row => row.productSku === items[2].upc)!;
    expect(singletonRow).toBeTruthy();
    const rowPages = JSON.parse(singletonRow.outputValueJson).pages as Array<{ pageId: string }>;
    expect(singletonPages.map(p => p.targetId).sort()).toEqual(rowPages.map(page => page.pageId).sort());
    expect(singletonPages.every(p => (p.proposedValue as any).identityVerified === true)).toBe(true);

    // Retry the singleton (reset + re-run the member pipeline in prepared
    // mode against the persisted outputs): ZERO page calls.
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
    const pageCalls = groupPageCallCount + singletonPageCallCount;
    updateItemStageStatus(singleton.id, 'pending');
    updateItemCurationData(singleton.id, '');
    const prepared = buildPreparedContext(workspaceId, finalized, singleton, frozenLineContext);
    const rerun = await curateTransitionalPreparedMember(findItemById(singleton.id)!, wsPath, workspaceId, prepared);
    const rerunPages = rerun.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(rerunPages.length).toBeGreaterThan(0);
    expect(rerunPages.map(p => p.targetId).sort()).toEqual(rowPages.map(page => page.pageId).sort());
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCalls);
  });

  it('10: flag OFF / shadow — the LEGACY path (cached coordinateCohortPagesOnce + per-item llmAssignCategoryPages) is byte-identical; zero durable page rows; EXACT call counts prove cache dedup', async () => {
    // PR7 review R1 (T3): parameterized over flag OFF and
    // {cohortCurationV2Enabled: true, cohortShadowOnly: true}. Both modes must
    // produce the COMPLETE legacy page results equal to the FROZEN baseline,
    // and the shared cached group call must be EXACTLY ONE (the second group
    // member reuses the cached promise — a no-cache implementation would
    // re-invoke the transport).
    for (const mode of [
      { label: 'flag OFF', apply: () => overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true }) },
      { label: 'shadow', apply: () => overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true }) },
    ]) {
      // Reset the shared mock counters per iteration (the loop runs both modes
      // in ONE test — the per-test afterEach only resets between tests).
      groupPageCallCount = 0;
      singletonPageCallCount = 0;
      auditedPageCallCount = 0;
      capturedGroupPrompt = null;
      const { workspaceId, workspacePath: wsPath } = newWorkspace();
      const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
      mode.apply();
      expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(mode.label === 'shadow');

      // The legacy child path keeps the reviewed-Type gate: seed an ACCEPTED
      // Primary Product Type fact (bundle-compatible snapshot hash) for every
      // member so the `category_page_proposals` stage passes the gate and runs
      // the legacy coordinator + per-item singleton paths (the flag-OFF/shadow
      // byte-identity this scenario proves).
      const { bundle } = writeActiveV2Bundle(wsPath);
      for (const item of items) {
        const now = new Date().toISOString();
        const runId = `legacy-type-run-${item.id}`;
        const proposalId = `legacy-type-proposal-${item.id}`;
        getDb().run(
          `INSERT INTO classification_runs
           (id, workspace_id, onboarding_item_id, product_sku, source_kind, config_snapshot_hash, status, started_at)
           VALUES (?, ?, ?, ?, 'onboarding', ?, 'completed', ?)`,
          [runId, workspaceId, item.id, item.upc, bundle.manifest.bundleHash, now],
        );
        getDb().run(
          `INSERT INTO classification_proposals
           (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
           VALUES (?, ?, ?, 'primary_product_type', ?, ?, 0.95, 'accepted', ?)`,
          [proposalId, runId, item.upc, 'dog-food-dry', JSON.stringify({ productTypeId: 'dog-food-dry' }), now],
        );
        getDb().run(
          `INSERT INTO classification_proposal_decisions
           (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
           VALUES (?, ?, 'accepted', ?, ?, ?, NULL)`,
          [`legacy-type-decision-${item.id}`, proposalId, JSON.stringify({ productTypeId: 'dog-food-dry' }), 'dog-food-dry', now],
        );
      }

      const worker = new OnboardingWorker(workspaceId, wsPath);
      await worker.poll();
      await drainWorker(worker);

      // Legacy per-item path, byte-identical: NO cohort runs and NO durable
      // page output rows — the parent op (`ensureCohortPagesCoordinated`)
      // never ran.
      expect(cohortRunCount(workspaceId)).toBe(0);
      expect(countOutputRowsForWorkspace(workspaceId)).toBe(0);
      // EXACT call counts: one group call per group member (each child's
      // stage invocation binds its own model-call audit context — a distinct
      // cache key, so the two group members produce two audited group calls)
      // and one per-item singleton call.
      expect(groupPageCallCount).toBe(2);
      expect(singletonPageCallCount).toBe(1);
      // Complete legacy page results == FROZEN baseline.
      const pageResults: Record<string, Array<{ pageName: string; confidence: number }>> = {};
      for (const item of items) {
        const stored = findItemById(item.id)!;
        expect(stored.stageStatus).toBe('completed');
        const pageProposals = stored.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
        expect(pageProposals.length).toBeGreaterThan(0);
        pageResults[item.upc] = pageProposals
          .map(p => ({ pageName: (p.proposedValue as any).pageName as string, confidence: p.confidence }))
          .sort((a, b) => a.pageName.localeCompare(b.pageName));
      }
      expect(pageResults).toEqual(LEGACY_PAGE_RESULTS_BASELINE);

      // PR7 review R1 (T3): DIRECT cache-dedup proof at the transport level —
      // a second group entry with an IDENTICAL stable key (same groupId +
      // sorted products/pages/selection + same no-audit context) reuses the
      // SAME cached promise and makes ZERO new transport calls.
      const groupProducts = items.slice(0, 2).map(item => ({
        sku: item.upc,
        name: item.name ?? item.upc,
        webTitle: item.extractionData?.title ?? null,
        brand: item.extractionData?.brand ?? item.brandHint ?? null,
        description: item.extractionData?.description ?? '',
        species: item.extractionData?.packagingOcrData?.species ?? [],
        flavor: item.extractionData?.packagingOcrData?.flavorVariety ?? null,
        lifeStage: item.extractionData?.packagingOcrData?.lifeStage ?? null,
        productForm: item.extractionData?.packagingOcrData?.productForm ?? null,
        healthConcern: item.extractionData?.packagingOcrData?.healthConcernFunction ?? [],
      }));
      const directPages = listVerifiedPageOptions(workspaceId).map(row => ({
        id: row.id,
        name: row.name,
        parentName: null,
      }));
      const directParams = {
        groupId: 'group-cache-dedup',
        products: groupProducts,
        pages: directPages,
        selectionMode: 'multiple' as const,
        maxPages: 5,
      };
      const groupCallsBeforeDedup = groupPageCallCount;
      const promise1 = coordinateCohortPagesOnce(directParams);
      const promise2 = coordinateCohortPagesOnce(directParams);
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(promise1).toBe(promise2); // the SAME cached promise
      expect(result1).toBe(result2);
      expect(groupPageCallCount).toBe(groupCallsBeforeDedup + 1); // ONE shared transport for both entries

      // PR7 review R2 (F2d): the LEGACY child-path audit rows keep the legacy
      // operations + v1 versions (never the parent operation). Scoped to THIS
      // workspace (the shared DB accumulates rows across tests).
      const legacyGroupRows = getDb().query(
        `SELECT operation, prompt_template_version, rule_version FROM classification_model_calls
         WHERE operation = 'cohort_page_assignment'
           AND run_id IN (SELECT id FROM classification_runs WHERE workspace_id = ?)`,
      ).all(workspaceId) as Array<{ operation: string; prompt_template_version: string; rule_version: string }>;
      expect(legacyGroupRows.length).toBeGreaterThan(0);
      for (const row of legacyGroupRows) {
        expect(row.operation).toBe('cohort_page_assignment');
        expect(row.prompt_template_version).toBe('cohort-page-assignment-prompt-v1');
        expect(row.rule_version).toBe('cohort-page-assignment-rules-v1');
      }
      const legacySingletonRows = getDb().query(
        `SELECT operation, prompt_template_version, rule_version FROM classification_model_calls
         WHERE operation = 'page_assignment'
           AND run_id IN (SELECT id FROM classification_runs WHERE workspace_id = ?)`,
      ).all(workspaceId) as Array<{ operation: string; prompt_template_version: string; rule_version: string }>;
      expect(legacySingletonRows.length).toBeGreaterThan(0);
      for (const row of legacySingletonRows) {
        expect(row.operation).toBe('page_assignment');
        expect(row.prompt_template_version).toBe('page-assignment-prompt-v1');
        expect(row.rule_version).toBe('page-assignment-rules-v1');
      }
      // NO parent operation ever appears on the legacy path (this workspace).
      const parentOperationRows = getDb().query(
        `SELECT COUNT(*) AS cnt FROM classification_model_calls
         WHERE operation = 'cohort_page_assignment_parent'
           AND run_id IN (SELECT id FROM classification_runs WHERE workspace_id = ?)`,
      ).get(workspaceId) as { cnt: number };
      expect(Number(parentOperationRows.cnt)).toBe(0);
    }
  });

  it('R2 (F2d): parent page audit rows carry cohort_page_assignment_parent + the v2 prompt/rule versions', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.parentStatus).not.toBe('failed');
    // ONE group call + ONE singleton call, both audited under the parent op.
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
    expect(auditedPageCallCount).toBe(2);
    const rows = getDb().query(
      `SELECT operation, prompt_template_version, rule_version FROM classification_model_calls
       WHERE operation = 'cohort_page_assignment_parent'
         AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
    ).all(finalized.id) as Array<{ operation: string; prompt_template_version: string; rule_version: string }>;
    // The audit rows are manufactured per production semantics: every audited
    // call writes a `started` row + a `success` row — 2 rows per call, so the
    // two parent calls (group + singleton) produce FOUR rows.
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.operation).toBe('cohort_page_assignment_parent');
      expect(row.prompt_template_version).toBe('cohort-page-assignment-parent-prompt-v2');
      expect(row.rule_version).toBe('cohort-page-assignment-parent-rules-v2');
    }
    // The legacy child operations are NOT used by the active parent path.
    const legacyRows = getDb().query(
      `SELECT COUNT(*) AS cnt FROM classification_model_calls
       WHERE operation IN ('cohort_page_assignment', 'page_assignment')
         AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
    ).get(finalized.id) as { cnt: number };
    expect(Number(legacyRows.cnt)).toBe(0);
  });

  it('R3 frozen authority (F2c / P1-C): commit a complete page set → live getLlmConfigForTask THROWS → re-enter the same run → P-hash unchanged → durable outputs reused with ZERO page transport', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    // Establish the durable page set (one group + one singleton call).
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.parentStatus).not.toBe('failed');
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    const committedHash = getCohortPageOutputsByRun(finalized.id)[0].inputHash;
    const callsAfterCommit = groupPageCallCount + singletonPageCallCount;
    const auditedAfterCommit = countPageAuditRowsForRun(finalized.id);

    // Simulate credential removal: live resolution THROWS for the page
    // operation from now on. The parent op must never touch it (the P-hash
    // model authority + rule version come from the FROZEN plan).
    denyPageMode = 'unavailable';
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
    const reused = await ensureCohortPages({
      run: finalized,
      workspaceId,
      projection,
      frozenLineContext,
    });
    expect(reused.size).toBe(3);
    // ZERO page transport on re-entry, and the committed set's P-hash is
    // unchanged (no needless supersession from a live credential failure).
    expect(groupPageCallCount + singletonPageCallCount).toBe(callsAfterCommit);
    expect(countPageAuditRowsForRun(finalized.id)).toBe(auditedAfterCommit);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    expect(getCohortPageOutputsByRun(finalized.id).every(r => r.inputHash === committedHash)).toBe(true);
  });


});