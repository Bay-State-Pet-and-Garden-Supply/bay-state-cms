/**
 * PR8 C4 (issue #30): acceptance integration test — draft projection ordering
 * + fail-closed member drafts, replay-safe after commit.
 *
 * Harness: pr7-acceptance.test.ts structure (temp DB, migrations,
 * `prepareActiveV2Workspace`, verified Page import, THREE-member cohort with
 * one 2-sibling group + one singleton) plus the counting llm-client mock.
 * The parent ops persist durable title rows (the mock returns null content
 * for the title op → the coordinator persists deterministic `cohort_fallback`
 * rows) and durable page rows (canned per-SKU assignments) BEFORE the member
 * loop; prepared children consume them with ZERO coordination calls.
 *
 * Scenario coverage:
 *  1. freeze → processCohort #1 (crash after member 2's pipeline): member 1
 *     COMMITS (draft = curationData); title + page outputs persisted by the
 *     parent ops;
 *  2. reset member 1 (stage → pending, curation cleared) + reclaim (lease
 *     expiry, new worker) → processCohort #2 under the SAME parent run: ZERO
 *     title/Page coordination calls (spies on `coordinateCohortItemsOnce`,
 *     `coordinateCohortPagesOnce`, `coordinateCohortPagesCore`,
 *     `llmAssignCategoryPages`, reinstalled immediately before the retry
 *     window), member 1 re-executes and its CANONICAL DRAFT SIGNATURE
 *     (hashCanonicalJson of the deterministic draft fields + projection
 *     metadata, audit identity/time excluded) is BYTE-EQUAL;
 *  3. negative tests (DECISION-B): missing title row fails the member (no
 *     partial draft, no fallback); corrupt PAGE JSON fails; missing page row
 *     fails; abstained page row succeeds with no pages; an attribute-stage
 *     failure (unresolvable effective type) fails the member via the pipeline
 *     throw; PR8 review R1 adds corrupt/empty-title/assigned-empty-page
 *     DURABLE-row cases re-entering processCohort (the affected member fails
 *     closed with the deterministic message — child failed, no curationData,
 *     zero re-coordination, parent completes with member failures);
 *  4. legacy flag OFF: byte-identical path — no cohort runs/outputs, per-item
 *     pipeline emits the draft as today, the projection metadata carries the
 *     consolidated title (DECISION-A additive in legacy too).
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
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortTitleOutputsByRun,
  getCohortPageOutputsByRun,
  countCohortTitleOutputs,
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
import type { PreparedCohortContext } from './helpers/transitional-prepared-member';
import { curateTransitionalPreparedMember } from './helpers/transitional-prepared-member';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { clearCohortPageCoordinationCache } from '../../classification/cohort-page-proposal-engine';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import * as cohortNameCoordinator from '../../onboarding/cohort-name-coordinator';
import * as cohortPageCoordinator from '../../classification/cohort-page-proposal-engine';
import * as pageAssignmentLlm from '../../classification/page-assignment-llm';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
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
import type { OnboardingItem, CurationData } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import type { CoordinatedPageMemberValue } from '../../classification/types';

// ─── llm-client mock (counting; production audit semantics) ───────────────────

let groupPageCallCount = 0;
let singletonPageCallCount = 0;
let auditedPageCallCount = 0;
let titleCallCount = 0;
let auditCallSeq = 0;

const PAGE_NAMES = ['Dog Food Dry', 'Dog Food Canned', 'Brand - Acme'];

/** Extract the frozen page list from a page prompt (`[ID:xxx] Name ...`). */
function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

function findPage(pages: Array<{ id: string; name: string }>, name: string) {
  return pages.find(page => page.name === name) ?? null;
}

/** The group response: every SKU in the prompt assigned to a FROZEN page.
 *  Siblings differ by design (rule 7): the SKU VALUE decides the page. */
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

function mockGetLlmConfigForTask(): Record<string, any> {
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

/** Simulate the audited transport's durable started + success rows. The
 *  returned call id must be a real `classification_model_calls.id` (the
 *  materialized proposals link to it). PR7 review R2 (F2d): the row is
 *  manufactured per PRODUCTION semantics — operation, stage_name, AND
 *  attempt all come from the ModelCall context (`options.modelCall`), NEVER
 *  from the transport's protectedOperation routing hint or hardcoded values
 *  (PR8 review R1 SHOULD-FIX: the title op's rows carry stage
 *  'name_consolidation' and the page op's rows 'category_page_proposals' —
 *  exactly what production writes via OPERATION_TO_STAGE). */
function writeAuditPair(ctx: ModelCallContext, callId: string): void {
  const now = new Date().toISOString();
  const stageName = ctx.stage ?? 'name_consolidation';
  const attempt = ctx.attempt;
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    [`${callId}-started`, ctx.runId, stageName, ctx.operation, attempt, ctx.snapshotHash, ctx.promptTemplateVersion, ctx.ruleVersion, 'sys-hash', 'user-hash', now, null, now],
  );
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [callId, ctx.runId, stageName, ctx.operation, attempt, ctx.snapshotHash, ctx.promptTemplateVersion, ctx.ruleVersion, 'sys-hash', 'user-hash', now, now, now],
  );
}

function mockCallLlmForTaskWithProvenance(
  task: string,
  prompt: string,
  _systemPrompt: string,
  options: Record<string, any>,
): { content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null {
  const operation = options?.protectedOperation;
  const callId = `call-${++auditCallSeq}`;
  // Title op (production audit semantics): content NULL → the coordinator
  // persists deterministic `cohort_fallback` rows (the audited call row still
  // becomes the row provenance when the coordinator captures it).
  if (operation === 'cohort_title_consolidation') {
    titleCallCount++;
    if (options.modelCall) {
      auditedPageCallCount++;
      writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
    }
    return null;
  }
  if (operation === 'cohort_page_assignment_parent') {
    // The parent page path (group + one-member singletons) uses the v2 core
    // prompt shape.
    const skuCount = (prompt.match(/^SKU \S+$/gm) ?? []).length;
    if (skuCount > 1) groupPageCallCount++;
    else singletonPageCallCount++;
    if (options.modelCall) {
      auditedPageCallCount++;
      writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
    }
    return {
      content: cannedGroupResponse(prompt),
      callId,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  return null;
}

mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: () => mockGetLlmConfigForTask(),
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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr8-acceptance-${randomUUID().slice(0, 8)}`);
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
  titleCallCount = 0;
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
  clearCohortPageCoordinationCache();
  // NOTE: `auditCallSeq` is deliberately NOT reset — the audit-row ids must
  // stay globally unique across tests in this shared database file.
});

// ─── Fixtures (mirror pr7-acceptance.test.ts) ─────────────────────────────────

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
 *  the PAGE curation target left ENABLED. */
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR8 Acceptance Batch', fileName: 'pr8.xlsx', totalItems: itemsData.length }).id;
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

const THREE_MEMBER_EXTRACTIONS = {
  // Members 1 + 2 share brand + name stem → ONE `groupByProductLine` group.
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', _ocrWeight: '10 lb' }),
  // Member 3: a DIFFERENT stem → a singleton group of 1.
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Salmon 5 lb', _brandHint: 'Acme' }),
};

/** Activate ONE verified Page import with the fixture pages. */
function activateVerifiedPages(wsId: string): void {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-food-canned', name: 'Dog Food Canned' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr8-acceptance-pages'),
    parserFormatVersion: 'pages-xml-1',
    records: pages.map(page => ({
      identity: { kind: 'exported_guid' as const, key: page.key, status: 'verified' as const },
      name: page.name,
      parentRef: null,
      availability: 'available' as const,
    })),
    activatedBy: 'test',
  });
  for (const page of pages) {
    if (!listVerifiedPageOptions(wsId).some(row => row.name === page.name)) {
      throw new Error(`verified fixture page not created: ${page.name}`);
    }
  }
}

/** Write the active v2 bundle + persist its config snapshot, activate the
 *  verified Page import, then create the ready cohort. */
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
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
}

/** Build a prepared-cohort context for one member from the frozen run —
 *  mirrors `buildPreparedCohortContextForMember` + the processCohort
 *  attachments (memberGroupSizes, coordinatedTitles, coordinatedPages,
 *  pageCoordinationAbsent). */
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
  const pageRows = getCohortPageOutputsByRun(run.id);
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
    memberGroupSizes: frozenLineContext.memberGroupSizes,
    coordinatedTitles: new Map(
      getCohortTitleOutputsByRun(run.id).map(row => [
        row.productSku,
        JSON.parse(row.outputValueJson) as { title: string; source: 'llm_cohort' | 'cohort_fallback' },
      ]),
    ),
    coordinatedPages: new Map<string, CoordinatedPageMemberValue>(
      pageRows.map(row => [
        row.productSku,
        {
          output: CohortPageOutputSchema.parse(JSON.parse(row.outputValueJson)),
          modelCallId: row.modelCallId,
        },
      ]),
    ),
    pageCoordinationAbsent: pageRows.length === 0,
  };
}

/** Freeze a ready cohort and return the prepared-context scaffolding. */
async function freezeAndScaffold(
  extByUpc: Record<string, Record<string, any>> = THREE_MEMBER_EXTRACTIONS,
): Promise<{
  workspaceId: string;
  workspacePath: string;
  run: CohortRun;
  items: OnboardingItem[];
  projection: ExecutionEvidenceProjectionV2;
  frozenLineContext: ReturnType<typeof buildFrozenProductLineContext>;
}> {
  const { workspaceId, workspacePath: wsPath } = newWorkspace();
  const { items } = prepareActiveV2Workspace(workspaceId, wsPath, extByUpc);
  const run = await freezeActiveCohort(workspaceId, wsPath);
  const projection = loadFrozenProjection(workspaceId, run);
  const cohort = getCohortById(run.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
  return { workspaceId, workspacePath: wsPath, run, items, projection, frozenLineContext };
}

// ─── Byte-identical draft comparison helpers ─────────────────────────────────

/** Normalized semantic tuples of the run's classification proposals — the
 *  deterministic core (proposalType/targetId/proposedValue/confidence/status/
 *  modelCallIds). Proposal ids, evidence ids, and timestamps are run-scoped
 *  random values (a retried member runs against a NEW child run) and are
 *  excluded from the byte-identical comparison. */
function normalizedProposalTuples(curationData: CurationData): string[] {
  return curationData.classificationProposals
    .map(proposal => JSON.stringify({
      proposalType: proposal.proposalType,
      targetId: proposal.targetId ?? null,
      proposedValue: proposal.proposedValue,
      confidence: proposal.confidence,
      status: proposal.status,
      modelCallIds: proposal.modelCallIds ?? [],
    }))
    .sort();
}

/** The draft-projection stage metadata title ({value, source}) carried in the
 *  member's classificationHistory (the stage result output_json). */
function projectionTitleFromHistory(curationData: CurationData): { value: string; source: string } | null {
  const entry = curationData.classificationHistory.find(
    history => history.eventType === 'stage_product_draft_projection',
  );
  if (!entry) return null;
  const parsed = JSON.parse(entry.eventJson.output as string) as {
    metadata?: { projection?: { title?: { value?: string; source?: string } | null } };
  };
  const title = parsed.metadata?.projection?.title ?? null;
  if (!title || typeof title.value !== 'string' || title.value.length === 0) return null;
  return { value: title.value, source: title.source ?? '' };
}

// ─── PR8 review R1 — canonical draft artifact (DECISION-E contract) ──────────

/** The draft-projection stage metadata from the member's classificationHistory
 *  (the stage result output_json) — the projection metadata the canonical
 *  draft signature consumes. */
function projectionMetadataFromHistory(curationData: CurationData): {
  fieldAssignments: Record<string, unknown>;
  pageAssignments: string[];
  title: { value: string; source: string } | null;
} | null {
  const entry = curationData.classificationHistory.find(
    history => history.eventType === 'stage_product_draft_projection',
  );
  if (!entry) return null;
  const parsed = JSON.parse(entry.eventJson.output as string) as {
    metadata?: {
      projection?: {
        fieldAssignments?: Record<string, unknown>;
        pageAssignments?: string[];
        title?: { value?: string; source?: string } | null;
      };
    };
  };
  const projection = parsed.metadata?.projection;
  if (!projection) return null;
  const title = projection.title;
  return {
    fieldAssignments: projection.fieldAssignments ?? {},
    pageAssignments: projection.pageAssignments ?? [],
    title:
      title && typeof title.value === 'string' && title.value.length > 0
        ? { value: title.value, source: title.source ?? '' }
        : null,
  };
}

/**
 * The CANONICAL draft artifact whose byte equality defines "byte-identical
 * curationData" across retry (PR8 review R1 BLOCKER 3 / DECISION-E).
 * `hashCanonicalJson` of the deterministic DRAFT object (curatedTitle,
 * titleSource, suggestedPages, searchKeywords, curatedDescription,
 * curatedWeight, suggestedProductType, packagingOcrTitle, and the draft
 * projection's fieldAssignments/pageAssignments/title). Audit identity and
 * time fields — curatedAt, classificationRunId, classificationHistory,
 * proposal/evidence ids — are EXPLICITLY EXCLUDED by this contract (a retried
 * member runs against a NEW child run with fresh run-scoped ids and
 * timestamps; the DRAFT must still reproduce byte-identically).
 */
function canonicalDraftSignature(curationData: CurationData): string {
  const projection = projectionMetadataFromHistory(curationData);
  return hashCanonicalJson({
    curatedTitle: curationData.curatedTitle ?? null,
    titleSource: curationData.titleSource,
    suggestedPages: curationData.suggestedPages ?? [],
    searchKeywords: curationData.searchKeywords,
    curatedDescription: curationData.curatedDescription,
    curatedWeight: curationData.curatedWeight,
    suggestedProductType: curationData.suggestedProductType,
    packagingOcrTitle: curationData.packagingOcrTitle,
    projection: projection
      ? {
          fieldAssignments: projection.fieldAssignments,
          pageAssignments: projection.pageAssignments,
          title: projection.title,
        }
      : null,
  });
}

// ─── Spies on every coordination entry point (zero-call proof) ────────────────

function installCoordinationSpies() {
  // ESM live bindings: wrapping the exported function intercepts calls made
  // through every importing module (the parent ops + prepared members).
  return {
    coordinateCohortItemsOnce: vi.spyOn(cohortNameCoordinator, 'coordinateCohortItemsOnce'),
    coordinateCohortPagesOnce: vi.spyOn(cohortPageCoordinator, 'coordinateCohortPagesOnce'),
    coordinateCohortPagesCore: vi.spyOn(cohortPageCoordinator, 'coordinateCohortPagesCore'),
    llmAssignCategoryPages: vi.spyOn(pageAssignmentLlm, 'llmAssignCategoryPages'),
  };
}

describe('PR8 acceptance — draft projection ordering + fail-closed member drafts (issue #30)', () => {
  it('1-2: freeze + coordinated title/page outputs → processCohort #1 commits member 1; reset + reclaim + retry under the SAME parent run → ZERO title/Page coordination calls → curationData BYTE-IDENTICAL → remaining members commit', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeAndScaffold();
    const finalized = run;

    // Install the four coordination spies BEFORE the first entry so the whole
    // scenario is counted.
    const spies = installCoordinationSpies();
    const spyCounts = () => ({
      title: titleCallCount,
      groupPages: groupPageCallCount,
      singletonPages: singletonPageCallCount,
      audited: auditedPageCallCount,
      itemsOnce: spies.coordinateCohortItemsOnce.mock.calls.length,
      pagesOnce: spies.coordinateCohortPagesOnce.mock.calls.length,
      pagesCore: spies.coordinateCohortPagesCore.mock.calls.length,
      llmAssign: spies.llmAssignCategoryPages.mock.calls.length,
    });

    // ── processCohort #1: member 1 COMMITS; crash after member 2's pipeline.
    let pipelineCount = 0;
    await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a', {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 2) {
          throw new MemberCommitCrashSimulationError('simulated kill after member 1 commit');
        }
      },
    })).rejects.toThrow('simulated kill after member 1 commit');

    // The parent ops persisted the durable sets on the first entry.
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    const titleRows = getCohortTitleOutputsByRun(finalized.id);
    expect(titleRows).toHaveLength(2); // the 2-sibling group only (DECISION-O)
    const memberOneAfterCrash = findItemById(items[0].id)!;
    expect(memberOneAfterCrash.stageStatus).toBe('completed');
    const firstCurationData = memberOneAfterCrash.curationData!;
    const firstTitle = firstCurationData.curatedTitle;
    if (firstTitle === null || firstTitle === undefined) throw new Error('first curatedTitle missing');

    const countsAfterFirst = spyCounts();
    // Active cohort mode: the LEGACY coordination entry points were NEVER
    // consulted (title + page + per-item singleton paths are all replaced by
    // the durable parent outputs).
    expect(countsAfterFirst.itemsOnce).toBe(0);
    expect(countsAfterFirst.pagesOnce).toBe(0);
    expect(countsAfterFirst.llmAssign).toBe(0);
    // The parent ops coordinated once (one group page call + one singleton
    // page call + one title group call).
    expect(countsAfterFirst.groupPages).toBe(1);
    expect(countsAfterFirst.singletonPages).toBe(1);
    expect(countsAfterFirst.title).toBe(1);
    // One audited started+success pair per parent invocation (title + group +
    // singleton) — the mock manufactures audit rows per PRODUCTION semantics.
    expect(countsAfterFirst.audited).toBe(3);

    // PR8 review R1 (SHOULD-FIX): the audit rows carry the CONTEXT-DERIVED
    // stage and attempt — title rows stage 'name_consolidation', page rows
    // stage 'category_page_proposals' — plus their context-derived operations
    // (never a hardcoded stage/attempt).
    const titleAuditRows = getDb().query(
      "SELECT * FROM classification_model_calls WHERE operation = 'cohort_title_consolidation'",
    ).all() as Array<Record<string, any>>;
    expect(titleAuditRows.length).toBe(2); // one started + one success pair
    for (const row of titleAuditRows) {
      expect(row.stage_name).toBe('name_consolidation');
      expect(row.attempt).toBe(1);
      expect(row.operation).toBe('cohort_title_consolidation');
    }
    const pageAuditRows = getDb().query(
      "SELECT * FROM classification_model_calls WHERE operation = 'cohort_page_assignment_parent'",
    ).all() as Array<Record<string, any>>;
    expect(pageAuditRows.length).toBe(4); // group + singleton, started + success each
    for (const row of pageAuditRows) {
      expect(row.stage_name).toBe('category_page_proposals');
      expect(row.attempt).toBe(1);
      expect(row.operation).toBe('cohort_page_assignment_parent');
    }

    // ── crash/reclaim: expire the lease, reclaim with a NEW worker id →
    // resume the SAME parent run (frozen match).
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

    // ── reset member 1 (simulated crash-recovery retry) + processCohort #2.
    updateItemStageStatus(items[0].id, 'pending');
    updateItemCurationData(items[0].id, '');
    // PR8 review R1 (review-tests PARTIAL b): clear/reinstall all four
    // coordination spies IMMEDIATELY BEFORE the retry window and assert each
    // retry-window call count is EXACTLY 0 (the pre-retry history is
    // irrelevant to the retry-window proof).
    spies.coordinateCohortItemsOnce.mockRestore();
    spies.coordinateCohortPagesOnce.mockRestore();
    spies.coordinateCohortPagesCore.mockRestore();
    spies.llmAssignCategoryPages.mockRestore();
    const retrySpies = installCoordinationSpies();
    const titleCallsBeforeRetry = titleCallCount;
    const groupPageCallsBeforeRetry = groupPageCallCount;
    const singletonPageCallsBeforeRetry = singletonPageCallCount;
    const auditedCallsBeforeRetry = auditedPageCallCount;
    const summary2 = await executeViaSeam(wsPath, workspaceId, resumed.id, 'worker-b');
    expect(summary2.parentStatus).not.toBe('failed');

    // ZERO title/Page coordination calls across the retry window — four
    // explicit zero-count assertions on the fresh retry-window spies, plus
    // flat transport counters (the parent ops reused the durable sets).
    expect(retrySpies.coordinateCohortItemsOnce.mock.calls.length).toBe(0);
    expect(retrySpies.coordinateCohortPagesOnce.mock.calls.length).toBe(0);
    expect(retrySpies.coordinateCohortPagesCore.mock.calls.length).toBe(0);
    expect(retrySpies.llmAssignCategoryPages.mock.calls.length).toBe(0);
    expect(titleCallCount).toBe(titleCallsBeforeRetry);
    expect(groupPageCallCount).toBe(groupPageCallsBeforeRetry);
    expect(singletonPageCallCount).toBe(singletonPageCallsBeforeRetry);
    expect(auditedPageCallCount).toBe(auditedCallsBeforeRetry);
    retrySpies.coordinateCohortItemsOnce.mockRestore();
    retrySpies.coordinateCohortPagesOnce.mockRestore();
    retrySpies.coordinateCohortPagesCore.mockRestore();
    retrySpies.llmAssignCategoryPages.mockRestore();

    // ── member 1's re-executed draft is BYTE-IDENTICAL on the listed fields.
    const memberOneRetried = findItemById(items[0].id)!;
    expect(memberOneRetried.stageStatus).toBe('completed');
    const secondCurationData = memberOneRetried.curationData!;
    expect(secondCurationData.curatedTitle).toBe(firstTitle);
    expect(secondCurationData.titleSource).toBe(firstCurationData.titleSource);
    expect(secondCurationData.suggestedPages).toEqual(firstCurationData.suggestedPages);
    expect(secondCurationData.searchKeywords).toEqual(firstCurationData.searchKeywords);
    expect(secondCurationData.curatedDescription).toEqual(firstCurationData.curatedDescription);
    expect(normalizedProposalTuples(secondCurationData)).toEqual(normalizedProposalTuples(firstCurationData));
    // PR8 review R1 (BLOCKER 3 / DECISION-E): the CANONICAL draft artifact is
    // BYTE-IDENTICAL across retry — hashCanonicalJson equality of the
    // canonical object ({curatedTitle, titleSource, suggestedPages,
    // searchKeywords, curatedDescription, curatedWeight,
    // suggestedProductType, packagingOcrTitle, projection:{fieldAssignments,
    // pageAssignments, title}}). Audit identity/time fields (curatedAt,
    // classificationRunId, classificationHistory, proposal/evidence ids) are
    // explicitly excluded by the canonical-draft contract.
    expect(canonicalDraftSignature(secondCurationData)).toBe(canonicalDraftSignature(firstCurationData));
    const firstProjectionTitle = projectionTitleFromHistory(firstCurationData);
    const secondProjectionTitle = projectionTitleFromHistory(secondCurationData);
    expect(firstProjectionTitle).not.toBeNull();
    expect(firstProjectionTitle!.value).toBe(firstTitle);
    expect(firstProjectionTitle!.source).toBe(firstCurationData.titleSource);
    expect(secondProjectionTitle).toEqual(firstProjectionTitle);

    // ── the remaining members committed the same way (same durable outputs).
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const curatedTitle = stored.curationData!.curatedTitle;
      if (curatedTitle === null || curatedTitle === undefined) throw new Error('curatedTitle missing');
      expect(curatedTitle.length).toBeGreaterThan(0);
      const projectionTitle = projectionTitleFromHistory(stored.curationData!);
      expect(projectionTitle).not.toBeNull();
      expect(projectionTitle!.value).toBe(curatedTitle);
      expect(projectionTitle!.source).toBe(stored.curationData!.titleSource);
    }
    const finalRun = getCohortRunById(finalized.id)!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(finalRun.status);
  });

  it('3a (DECISION-B): missing title row for a multi-item group member FAILS the member — no invented title, no partial draft', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeAndScaffold();
    const prepared = buildPreparedContext(workspaceId, run, items[0], frozenLineContext);
    // The parent-op contract violation: no durable title row for the member.
    prepared.coordinatedTitles = new Map();
    await expect(
      curateTransitionalPreparedMember(findItemById(items[0].id)!, wsPath, workspaceId, prepared),
    ).rejects.toThrow(/missing a persisted cohort title output in active cohort mode/);
    // No fallback title was ever written (the pipeline threw before the draft).
    expect(findItemById(items[0].id)!.curationData).toBeNull();
  });

  it('3b (DECISION-B): corrupt stored page payload FAILS the member — no partial draft', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeAndScaffold();
    const prepared = buildPreparedContext(workspaceId, run, items[0], frozenLineContext);
    prepared.coordinatedTitles = new Map([['100000000001', { title: 'Acme Frozen Coordinated Title 5 lb', source: 'llm_cohort' }]]);
    prepared.coordinatedPages = new Map([
      ['100000000001', { output: { status: 'assigned', pages: [{ pageId: 42 }] }, modelCallId: 'x' } as any],
    ]);
    prepared.pageCoordinationAbsent = false;
    await expect(
      curateTransitionalPreparedMember(findItemById(items[0].id)!, wsPath, workspaceId, prepared),
    ).rejects.toThrow(/corrupt parent page output payload/);
  });

  it('3c (DECISION-B): missing page row (no abstained row, no pageCoordinationAbsent marker) FAILS the member — no partial draft', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeAndScaffold();
    const prepared = buildPreparedContext(workspaceId, run, items[0], frozenLineContext);
    prepared.coordinatedTitles = new Map([['100000000001', { title: 'Acme Frozen Coordinated Title 5 lb', source: 'llm_cohort' }]]);
    prepared.coordinatedPages = new Map();
    prepared.pageCoordinationAbsent = false;
    await expect(
      curateTransitionalPreparedMember(findItemById(items[0].id)!, wsPath, workspaceId, prepared),
    ).rejects.toThrow(/no parent page output row in active cohort mode/);
  });

  it('3d (DECISION-B): an abstained page output row is a COMPLETE result — the member succeeds with NO pages', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeAndScaffold();
    const prepared = buildPreparedContext(workspaceId, run, items[0], frozenLineContext);
    prepared.coordinatedTitles = new Map([['100000000001', { title: 'Acme Frozen Coordinated Title 5 lb', source: 'llm_cohort' }]]);
    prepared.coordinatedPages = new Map([
      ['100000000001', { output: { status: 'abstained', reason: 'Cohort page LLM policy denied.' }, modelCallId: null }],
    ]);
    prepared.pageCoordinationAbsent = false;
    const curationData = await curateTransitionalPreparedMember(findItemById(items[0].id)!, wsPath, workspaceId, prepared);
    // Issue #108 (design B): the hand-built durable title is a valid
    // branded parent output, so the member consumes it byte-for-byte (the
    // page-abstention subject of this test is unaffected).
    expect(curationData.curatedTitle).toBe('Acme Frozen Coordinated Title 5 lb');
    expect(curationData.titleSource).toBe('llm_cohort');
    const pageProposals = curationData.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(pageProposals).toHaveLength(0);
    expect(curationData.suggestedPages).toHaveLength(0);
  });

  it('3e (DECISION-B): an attribute-stage failure FAILS the member via the pipeline throw (no partial draft)', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeAndScaffold();
    const prepared = buildPreparedContext(workspaceId, run, items[0], frozenLineContext);
    prepared.coordinatedTitles = new Map([['100000000001', { title: 'Acme Frozen Coordinated Title 5 lb', source: 'llm_cohort' }]]);
    // An execution type absent from the frozen snapshot makes
    // `attribute_applicability` fail closed — the pipeline throws and the
    // member fails.
    prepared.cohortExecutionType = { id: 'bogus-not-a-real-type', confidence: 0.95, outcome: 'coherent' };
    await expect(
      curateTransitionalPreparedMember(findItemById(items[0].id)!, wsPath, workspaceId, prepared),
    ).rejects.toThrow(/missing from the frozen runtime snapshot/);
  });

  // ─── PR8 review R1 (BLOCKER 1) + review round 2 (P1): corrupt DURABLE rows
  //      SUPERSEDE the parent (never a member failure) ────────────────────
  // Corruption of a WRITE-ONCE PARENT-OWNED shared semantic artifact must
  // route through the supersession lifecycle (the same primitive as authority
  // drift): the old parent is superseded, every running child terminalizes
  // atomically, the old rows stay immutable, the claim slot reopens, and a
  // NEW parent revision can commit a fresh complete set. A member failure
  // would strand the revision forever (write-once rows + terminal-current
  // parent + no new claim).

  it('review-R2-1 (P1): a corrupt persisted curated_title row SUPERSEDES the parent — children terminalized, old rows immutable, new run immediately claimable, zero re-coordination', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeAndScaffold();
    let pipelineCount = 0;
    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 2) throw new MemberCommitCrashSimulationError('simulated kill');
      },
    })).rejects.toThrow('simulated kill');
    expect(findItemById(items[0].id)!.stageStatus).toBe('completed');
    expect(countCohortPageOutputs(run.id)).toBe(3);

    // Capture every running child before corruption.
    const childrenBefore = getDb().query(
      'SELECT id, status FROM classification_runs WHERE cohort_run_id = ? AND status = \'running\'',
    ).all(run.id) as Array<{ id: string; status: string }>;

    // Corrupt ONE durable curated_title row (member 2's).
    getDb().run(
      "UPDATE classification_cohort_outputs SET output_value_json = '{corrupt' WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000002'",
      [run.id],
    );
    // Immutability baseline: capture AFTER the test's corruption write — the
    // assertion is that SUPERSESSION leaves every row (including the corrupt
    // one) exactly as found.
    const outputsBefore = getCohortTitleOutputsByRun(run.id);

    // Clear/reinstall all four spies immediately before the re-entry window.
    const reentrySpies = installCoordinationSpies();

    // Re-enter processCohort: the parent title op's REUSE path parses the row,
    // fails closed, and the parent is SUPERSEDED (not a member failure).
    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a')).rejects.toThrow(/corrupt/i);

    // Parent SUPERSEDED with the deterministic message (run id + SKU + cause).
    const terminal = getCohortRunById(run.id)!;
    expect(terminal.status).toBe('superseded');
    expect(terminal.supersededAt).not.toBeNull();
    expect(terminal.errorMessage).toContain('100000000002');
    expect(terminal.errorMessage).toContain(run.id);
    expect(terminal.errorMessage).toMatch(/corrupt/i);

    // EVERY formerly-running child terminalized atomically.
    for (const child of childrenBefore) {
      const after = getDb().query(
        'SELECT status, error_message FROM classification_runs WHERE id = ?',
      ).get(child.id) as { status: string; error_message: string | null };
      expect(after.status).toBe('failed');
      expect(after.error_message).toBe('Cohort output authority drift superseded parent run');
    }

    // Old output rows byte-identical (never replaced, never extended).
    expect(getCohortTitleOutputsByRun(run.id)).toEqual(outputsBefore);

    // No member materialized corrupted data: members 1/2/3 have no NEW curation
    // writes under the superseded run (member 1's earlier commit is historical).
    expect(findItemById(items[1].id)!.stageStatus).not.toBe('completed');
    expect(findItemById(items[2].id)!.stageStatus).not.toBe('completed');

    // ZERO re-coordination in the re-entry window.
    expect(reentrySpies.coordinateCohortItemsOnce.mock.calls.length).toBe(0);
    expect(reentrySpies.coordinateCohortPagesOnce.mock.calls.length).toBe(0);
    expect(reentrySpies.coordinateCohortPagesCore.mock.calls.length).toBe(0);
    expect(reentrySpies.llmAssignCategoryPages.mock.calls.length).toBe(0);

    // The claim slot REOPENED: a NEW parent revision is immediately claimable,
    // freezes, and executes — a FRESH complete set under the new run id.
    // PR9 review R1 (B1): a null Primary-Product-Type suggestion is now a HARD
    // family_product_type finding whenever the parent Execution Product Type
    // exists — the singleton member 3's original evidence ('Adult Dog Food
    // Salmon') abstains on the family invariant. Give member 3's extraction
    // TITLE type keywords so the fresh revision resolves a non-null
    // suggestion; its `_name` stays 'Adult Dog Food Salmon' (separate group),
    // so DECISION-O title rows (2) and the singleton page call (1) are
    // unchanged, and the legacy flag-OFF frozen baseline (test 4) is untouched.
    const memberThreeForRevision = findItemById(items[2].id)!;
    const memberThreeExt = memberThreeForRevision.extractionData as Record<string, any> | null;
    updateItemExtractionData(memberThreeForRevision.id, JSON.stringify({
      ...(memberThreeExt ?? {}),
      title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb',
    }));
    const newRevision = await freezeActiveCohort(workspaceId, wsPath);
    expect(newRevision.id).not.toBe(run.id);
    const freshSummary = await executeViaSeam(wsPath, workspaceId, newRevision.id, 'worker-a');
    // Same completion semantics as the first revision: the title transport mock
    // returns empty -> durable cohort_fallback rows, pages assigned; members
    // commit. Not failed, and a FULL fresh output set exists under the new id.
    expect(freshSummary.parentStatus).not.toBe('failed');
    expect(freshSummary.parentStatus).not.toBe('completed_with_member_failures');
    expect(countCohortTitleOutputs(newRevision.id)).toBe(2); // multi-item group members only (DECISION-O)
    expect(countCohortPageOutputs(newRevision.id)).toBe(3); // pages cover ALL members (DECISION-A)
    reentrySpies.coordinateCohortItemsOnce.mockRestore();
    reentrySpies.coordinateCohortPagesOnce.mockRestore();
    reentrySpies.coordinateCohortPagesCore.mockRestore();
    reentrySpies.llmAssignCategoryPages.mockRestore();
  });

  it('review-R2-2 (P1): an EMPTY persisted curated_title row (pre-tightening) SUPERSEDES the parent — no fallback title is ever invented', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeAndScaffold();
    let pipelineCount = 0;
    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 2) throw new MemberCommitCrashSimulationError('simulated kill');
      },
    })).rejects.toThrow('simulated kill');

    // Hand-seed an EMPTY title row at the DB level (pre-tightening corruption
    // — the schema now rejects empty titles via trim().min(1), so the parent
    // reuse path fails the parse and SUPERSEDES).
    getDb().run(
      "UPDATE classification_cohort_outputs SET output_value_json = ? WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000002'",
      [JSON.stringify({ title: '', source: 'llm_cohort' }), run.id],
    );

    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a')).rejects.toThrow(/corrupt/i);

    const terminal = getCohortRunById(run.id)!;
    expect(terminal.status).toBe('superseded');
    expect(terminal.errorMessage).toContain('100000000002');
    expect(terminal.errorMessage).toContain(run.id);

    // No member invented a fallback title: members 2/3 never ran under the
    // superseded run.
    expect(findItemById(items[1].id)!.curationData).toBeNull();
    expect(findItemById(items[2].id)!.curationData).toBeNull();

    const nextRun = claimReadyCurationCohorts(workspaceId, 10, 'worker-next', COHORT_LEASE_TTL_MS);
    expect(nextRun.length).toBe(1);
    expect(nextRun[0].id).not.toBe(run.id);
  });

  it('review-R2-3 (P1): an assigned persisted coordinated_page row with EMPTY pages SUPERSEDES the parent — no partial draft', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeAndScaffold();
    let pipelineCount = 0;
    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 2) throw new MemberCommitCrashSimulationError('simulated kill');
      },
    })).rejects.toThrow('simulated kill');

    // Seed an assigned row with an EMPTY page list (pre-tightening corruption
    // — the schema now rejects assigned-empty via pages.min(1)).
    getDb().run(
      "UPDATE classification_cohort_outputs SET output_value_json = ? WHERE cohort_run_id = ? AND output_kind = 'coordinated_page' AND product_sku = '100000000003'",
      [JSON.stringify({ status: 'assigned', pages: [], source: 'llm_cohort' }), run.id],
    );

    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a')).rejects.toThrow(/corrupt/i);

    const terminal = getCohortRunById(run.id)!;
    expect(terminal.status).toBe('superseded');
    expect(terminal.errorMessage).toContain('100000000003');
    expect(terminal.errorMessage).toContain(run.id);

    // No member materialized a partial draft under the superseded run.
    expect(findItemById(items[2].id)!.curationData).toBeNull();

    const nextRun = claimReadyCurationCohorts(workspaceId, 10, 'worker-next', COHORT_LEASE_TTL_MS);
    expect(nextRun.length).toBe(1);
    expect(nextRun[0].id).not.toBe(run.id);
  });

  it('4: legacy flag OFF — byte-identical path (no cohort runs/outputs, per-item draft emitted, projection metadata carries the consolidated title)', async () => {
    // NOTE: no freeze — the flag-OFF path must run the per-item worker path
    // byte-identically (flag defaults OFF; a freeze would force the flags ON).
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    const cohortRunRows = getDb().query(
      'SELECT COUNT(*) AS cnt FROM classification_cohort_runs WHERE workspace_id = ?',
    ).get(workspaceId) as { cnt: number };
    expect(Number(cohortRunRows.cnt)).toBe(0);
    const outputRows = getDb().query(
      'SELECT COUNT(*) AS cnt FROM classification_cohort_outputs WHERE workspace_id = ?',
    ).get(workspaceId) as { cnt: number };
    expect(Number(outputRows.cnt)).toBe(0);

    const items = getDb().query(
      `SELECT i.id FROM onboarding_items i
       JOIN onboarding_batches b ON b.id = i.batch_id
       WHERE b.workspace_id = ?`,
    ).all(workspaceId) as Array<{ id: string }>;
    expect(items.length).toBe(3);
    const legacyNormalized = new Map<string, Record<string, unknown>>();
    for (const row of items) {
      const stored = findItemById(row.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
      const curatedTitle = stored.curationData!.curatedTitle;
      if (curatedTitle === null || curatedTitle === undefined) throw new Error('curatedTitle missing');
      expect(curatedTitle.length).toBeGreaterThan(0);
      // DECISION-A is additive in legacy mode too: the projection metadata
      // carries the consolidated title from name_consolidation.
      const projectionTitle = projectionTitleFromHistory(stored.curationData!);
      expect(projectionTitle).not.toBeNull();
      expect(projectionTitle!.value).toBe(curatedTitle);
      expect(projectionTitle!.source).toBe(stored.curationData!.titleSource);
      legacyNormalized.set(stored.upc, {
        title: curatedTitle,
        source: stored.curationData!.titleSource,
        pages: stored.curationData!.suggestedPages,
        keywords: stored.curationData!.searchKeywords ?? '',
      });
    }
    // PR8 review R1 (review-tests PARTIAL c): the legacy run's normalized
    // output is compared against an explicit FROZEN pre-PR8 baseline literal
    // (expected title/source/pages/keywords), excluding the additive
    // projection-title metadata where applicable (asserted separately above —
    // DECISION-A is additive in legacy mode, so the baseline covers only the
    // DRAFT the pre-PR8 pipeline emitted).
    //
    // FROZEN on the deterministic fixtures + fixed test llm-client mock
    // (captured before the review-R1 edits): members 1+2 are grouped and get
    // the legacy coordinator's deterministic fallback (cohort_fallback); the
    // singleton keeps the per-item spreadsheet title (source web).
    const FROZEN_LEGACY_BASELINE = {
      '100000000001': {
        title: 'Acme Purina Pro Plan Dry Dog Food Chicken 5 lb.',
        source: 'cohort_fallback',
        pages: [],
        keywords: 'Acme Purina Pro Plan Dry Dog Food Chicken 5 lb., dog-food-dry, Original, description',
      },
      '100000000002': {
        title: 'Acme Purina Pro Plan Dry Dog Food Beef 10 lb.',
        source: 'cohort_fallback',
        pages: [],
        keywords: 'Acme Purina Pro Plan Dry Dog Food Beef 10 lb., dog-food-dry, Original, description',
      },
      // Issue #108: the singleton's brandless spreadsheet title now leaves
      // curation brand-guaranteed (brand evidence is Acme); keywords derive
      // from the guaranteed title, so the separate brand token drops out.
      '100000000003': {
        title: 'Acme Purina Pro Plan Adult Dog Food Salmon 5 lb',
        source: 'web',
        pages: [],
        keywords: 'Acme Purina Pro Plan Adult Dog Food Salmon 5 lb, Original, description',
      },
    };
    expect(Object.fromEntries(legacyNormalized)).toEqual(FROZEN_LEGACY_BASELINE);
  });
});