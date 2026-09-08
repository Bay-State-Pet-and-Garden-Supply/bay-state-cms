/**
 * Slice 4 transfer onto the new page seam (`ensureCohortPages` from
 * `src/onboarding/cohort-curation/pages.ts`, second user of the shared
 * durable-set lifecycle in `decisions.ts`).
 *
 * Case-level replacement map: PR7's direct-parent page CRASH cases move here
 * to the public `executeClaim` invocation (never the op directly, never
 * mocked) — the pre-commit crash replay (PR7 #4), the singleton in-flight
 * ownership loss (PR7 R1), and the commit race (PR7 trailing case) are
 * REMOVED from `pr7-acceptance.test.ts` in this slice to avoid duplicate
 * fixtures/assertions. PR7 retains every review/linkage/legacy invariant
 * (1-2-3, 5-6, 7, 8, 9, 10, R2, R3).
 *
 * Also new in this file: one negative test per §1.4 title-vs-page asymmetry
 * (cross-parent copy EXISTS for titles / ABSENT for pages; singleton members
 * excluded from title rows / included in page rows; T-hash v2 vs P-hash v1),
 * plus the two remaining §1.4 page negatives: model-unavailability (denied /
 * unavailable transport → durable coded abstentions, call-free retry) and
 * output-integrity (a corrupt persisted page row → CohortPageOutputCorruptError
 * with usable rows, zero re-coordination).
 *
 * Harness: the PR7 page-flavored builders (temp DB, migrations, ACTIVE v2
 * bundle, VERIFIED Page import) with a counting `llm-client` mock that serves
 * the parent `cohort_page_assignment_parent` core transport and writes the
 * audited `classification_model_calls` started+success pairs. Non-page tasks
 * resolve NULL transport — members abstain and the parent completes with
 * abstentions; the page path under test is unaffected (same note as the
 * titles seam suite).
 *
 * bun:test harness with disposable temp workspace/DB (fails setup outside a
 * fresh temp root; cleans only that root).
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
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { buildFrozenProductLineContext } from '../../onboarding/cohort-curation/frozen-evidence';
import { MemberCommitCrashSimulationError } from '../../onboarding/cohort-curation/members';
import { ensureCohortTitles } from '../../onboarding/cohort-curation/titles';
import {
  ensureCohortPages,
  CohortPageAuthorityDriftError,
  CohortPageOutputCorruptError,
} from '../../onboarding/cohort-curation/pages';
import { createCohortCuration } from '../../onboarding/cohort-curation/index';
import type { FrozenProductLineContext } from '../../onboarding/cohort-curation/frozen-evidence';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
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
import { parseExecutionEvidenceProjection } from '../../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionV2,
} from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';

// ─── llm-client mock (counting; simulates the audited transport rows) ─────────

/** Total multi-SKU (group) parent core transport invocations. */
let groupPageCallCount = 0;
/** Total single-SKU (parent singleton) core transport invocations. */
let singletonPageCallCount = 0;
let auditCallSeq = 0;
/** When true, the PARENT page transport's config lookup throws (audited policy-denied path). Gated to the parent operation so member/title transports are unaffected. */
let denyNextParentPageConfig = false;
/** When true, the PARENT page transport's config lookup resolves null (LLM-unavailable path). */
let unavailableNextParentPageConfig = false;

const PAGE_NAMES = ['Dog Food Dry', 'Dog Food Canned', 'Brand - Acme'];

/** Extract the frozen page list from a page prompt (`[ID:xxx] Name ...`). */
function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

function findPage(pages: Array<{ id: string; name: string }>, name: string) {
  return pages.find(page => page.name === name) ?? null;
}

/** The group/singleton response: every SKU in the prompt assigned to a FROZEN
 *  page. Siblings differ by design: the SKU VALUE decides the page, so member
 *  / prompt ORDER can never flip the result. */
function cannedPageResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const skus = [...prompt.matchAll(/^SKU (\S+)$/gm)].map(match => match[1]);
  const payload: Record<string, unknown> = {};
  for (const sku of skus) {
    const evenSku = Number(sku.slice(-2)) % 2 === 0;
    const page = findPage(pages, evenSku ? PAGE_NAMES[1] : PAGE_NAMES[0]);
    payload[sku] = page ? [{ pageId: page.id, pageName: page.name, confidence: 0.85 }] : [];
  }
  return JSON.stringify(payload);
}

function mockGetLlmConfigForTask(_task: string, _options: Record<string, any>): Record<string, any> | null {
  if (_options?.protectedOperation === 'cohort_page_assignment_parent') {
    if (denyNextParentPageConfig) throw new Error('Model policy denied (mock)');
    if (unavailableNextParentPageConfig) return null;
  }
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

/** Simulate the audited transport's durable started + success rows. */
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
  if (operation !== 'cohort_page_assignment_parent') return null;
  const callId = `page-call-${++auditCallSeq}`;
  const skuCount = (prompt.match(/^SKU \S+$/gm) ?? []).length;
  if (skuCount > 1) groupPageCallCount++;
  else singletonPageCallCount++;
  if (options.modelCall) {
    writeAuditPair(options.modelCall, callId);
  }
  return {
    content: cannedPageResponse(prompt),
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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-pages-${randomUUID().slice(0, 8)}`);
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
  denyNextParentPageConfig = false;
  unavailableNextParentPageConfig = false;
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

/** Write a lifecycle-ACTIVE v2 bundle with the PAGE curation target ENABLED,
 *  so the frozen member snapshots resolve a verified Page catalog. */
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
  const batchId = createBatch({ workspaceId: wsId, name: 'Cohort Pages Batch', fileName: 'pages.xlsx', totalItems: itemsData.length }).id;
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

// ─── Scenario helpers ─────────────────────────────────────────────────────────

const THREE_MEMBER_EXTRACTIONS = {
  // Members 1 + 2 share brand + name stem → ONE `groupByProductLine` group.
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
  // Member 3: a DIFFERENT stem → a singleton group of 1 (parent-owned too).
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Salmon 5 lb', _brandHint: 'Acme' }),
};

/** Activate ONE verified Page import with the fixture pages. */
function activateVerifiedPages(wsId: string): Map<string, string> {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-food-canned', name: 'Dog Food Canned' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('cohort-pages-fixture'),
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

/**
 * Write the active v2 bundle + persist its config snapshot, activate the
 * verified Page import, merge every formed cohort into ONE (group + singleton
 * P-set in a single run), claim as worker-a, and freeze. Returns every input
 * the parent page op needs.
 */
async function freezeCohortFixture(
  extByUpc: Record<string, Record<string, any>>,
): Promise<FrozenCohortFixture> {
  const { workspaceId, workspacePath: wsPath } = newWorkspace();
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(workspaceId, bundle);
  activateVerifiedPages(workspaceId);
  const { items, cohorts } = createReadyCohort(workspaceId, extByUpc);
  if (cohorts.length > 1) {
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
      [computeMembershipHash(items.map(item => item.id)), target.id],
    );
    const merged = getDb().query(
      'SELECT onboarding_item_id FROM curation_cohort_members WHERE cohort_id = ? ORDER BY rowid',
    ).all(target.id) as Array<{ onboarding_item_id: string }>;
    merged.forEach((member, index) => {
      getDb().run(
        'UPDATE curation_cohort_members SET ordinal = ? WHERE cohort_id = ? AND onboarding_item_id = ?',
        [index, target.id, member.onboarding_item_id],
      );
    });
  }
  const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
  expect(finalized.status).toBe('running');
  const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
// @ts-expect-error -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  const projection: ExecutionEvidenceProjectionV2 = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  const cohort = getCohortById(finalized.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
  return { workspaceId, workspacePath: wsPath, run: finalized, projection, cohort, members, frozenLineContext, items };
}

/** Recompute the P-hash the parent page op uses (mirrors its step 1). */
function expectedPageInputHash(fixture: FrozenCohortFixture): string {
  const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const child = getDb().query(
    'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(fixture.run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string } | undefined;
  const snapshot = child?.config_snapshot_hash
    ? getRuntimeSnapshotByHash(fixture.workspaceId, child.config_snapshot_hash)
    : null;
  if (!snapshot) throw new Error('ordinal-0 member runtime snapshot missing');
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(fixture.run, snapshot);
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
    buildCohortPageAuthorityBundle({ run: fixture.run, projection: fixture.projection, pagePlan, executionTypeAuthority, snapshot }),
  );
}

/** Supersede a RUNNING revision and re-claim + re-freeze the SAME cohort as a
 *  NEW revision — the unique current-run slot reopens on supersession. */
async function supersedeAndRefreeze(fixture: FrozenCohortFixture): Promise<FrozenCohortFixture> {
  expect(supersedeOwnedCohortRunForOutputDrift(fixture.run.id, 'worker-a', 'Slice 4 test supersede')).toBe(true);
  const claimed = claimReadyCurationCohorts(fixture.workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const runB = claimed.find(r => r.cohortId === fixture.run.cohortId)!;
  const finalized = await freezeCohortForExecution(runB, fixture.workspacePath, fixture.workspaceId);
  expect(finalized.status).toBe('running');
  const snap = getCohortSnapshotByHash(fixture.workspaceId, finalized.evidenceSnapshotHash!)!;
// @ts-expect-error -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  const projection: ExecutionEvidenceProjectionV2 = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  const cohort = getCohortById(finalized.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
  return { workspaceId: fixture.workspaceId, workspacePath: fixture.workspacePath, run: finalized, projection, cohort, members, frozenLineContext, items: fixture.items };
}

function countPageAuditRowsForRun(cohortRunId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_model_calls
     WHERE operation IN ('cohort_page_assignment', 'page_assignment', 'cohort_page_assignment_parent')
       AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
  ).get(cohortRunId) as { cnt: number };
  return Number(row.cnt);
}

// ─── Page pre-commit crash through the public seam (issue #30 P1-1) ──────────
// Transferred from PR7 #4: crash coverage is public-seam evidence, so it runs
// through `executeClaim` (never the op directly, never mocked).

describe('page pre-commit crash through the public seam (issue #30 P1-1)', () => {
  it('crash TWICE pre-commit → zero rows each time; recovery coordinates once more then commits; later entries reuse call-free', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    // Crash twice (not once) so the test cannot pass on an at-most-once path.
    // Each attempt leaves the audited call durable but ZERO committed rows.
    // The seam throws on the FIRST page transport (the two-member group), so
    // the singleton transport never runs on crashed attempts.
    let crashesRemaining = 2;
    const crashPageCommit = () => {
      if (crashesRemaining > 0) {
        crashesRemaining--;
        throw new Error('simulated page pre-commit crash');
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        curation.executeClaim(fixture.run.id, 'worker-a', {
          afterCoordinatedCall: (kind: 'title' | 'page') => {
            if (kind === 'page') crashPageCommit();
          },
        }),
      ).rejects.toThrow('simulated page pre-commit crash');
      expect(countCohortPageOutputs(fixture.run.id)).toBe(0);
      expect(getCohortRunById(fixture.run.id)!.status).toBe('running');
    }
    // Two crashed attempts × one group transport each; the singleton never ran.
    expect(groupPageCallCount).toBe(2);
    expect(singletonPageCallCount).toBe(0);
    // Recovery through the same public invocation: pages coordinate once more
    // (group + singleton) and commit — then crash AFTER the member pipeline
    // so the committed page set survives with the run still open.
    await expect(
      curation.executeClaim(fixture.run.id, 'worker-a', {
        afterMemberPipeline: () => {
          throw new MemberCommitCrashSimulationError('simulated member-commit crash');
        },
      }),
    ).rejects.toBeInstanceOf(MemberCommitCrashSimulationError);
    expect(groupPageCallCount).toBe(3);
    expect(singletonPageCallCount).toBe(1);
    expect(countCohortPageOutputs(fixture.run.id)).toBe(3);
    expect(getCohortRunById(fixture.run.id)!.status).toBe('running');
    // Final entry through the seam: the committed page set is REUSED with
    // zero new coordination calls; members complete; the parent completes.
    const auditsBefore = countPageAuditRowsForRun(fixture.run.id);
    const finished = await curation.executeClaim(fixture.run.id, 'worker-a');
    expect(finished.executed).toBe(true);
    expect(groupPageCallCount).toBe(3);
    expect(singletonPageCallCount).toBe(1);
    expect(countPageAuditRowsForRun(fixture.run.id)).toBe(auditsBefore); // no new audited rows
    expect(countCohortPageOutputs(fixture.run.id)).toBe(3);
    // Non-page transports resolve NULL under this mock, so members fail
    // downstream of the page path (attribute/synthesis stages) AFTER
    // consuming the stored page assignments — the parent completes with
    // member failures, and the page assertions above (commit-once,
    // call-free reuse) are unaffected.
    expect(getCohortRunById(fixture.run.id)!.status).toBe('completed_with_member_failures');
  });

  it('ownership lost in the page window: zero rows, no post-loss writes; the reclaiming owner alone finishes', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    // Worker A's group transport resolves, but a sibling reclaims BEFORE A's
    // insert — then A crashes. A must leave zero rows and never write again.
    await expect(
      curation.executeClaim(fixture.run.id, 'worker-a', {
        afterCoordinatedCall: (kind: 'title' | 'page') => {
          if (kind !== 'page') return;
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
          throw new Error('simulated page pre-commit crash');
        },
      }),
    ).rejects.toThrow('simulated page pre-commit crash');
    expect(groupPageCallCount).toBe(1);
    expect(countCohortPageOutputs(fixture.run.id)).toBe(0);
    // A is stale: the seam refuses without mutation or transport.
    const stale = await curation.executeClaim(fixture.run.id, 'worker-a');
    expect(stale.executed).toBe(false);
    if (!stale.executed) expect(stale.disposition).toBe('stale-owner');
    expect(groupPageCallCount).toBe(1);
    expect(countCohortPageOutputs(fixture.run.id)).toBe(0);
    // B alone finishes: exactly one more page coordination (group + singleton
    // — its own recovery attempt), commit, member completion, parent
    // completion.
    const finished = await curation.executeClaim(fixture.run.id, 'worker-b');
    expect(finished.executed).toBe(true);
    expect(groupPageCallCount).toBe(2);
    expect(singletonPageCallCount).toBe(1);
    expect(countCohortPageOutputs(fixture.run.id)).toBe(3);
    // Same downstream-member note as above: members fail after consuming the
    // stored pages; the page-path assertions (zero post-loss writes by A,
    // single recovery coordination by B) are unaffected.
    expect(getCohortRunById(fixture.run.id)!.status).toBe('completed_with_member_failures');
    expect(getCohortRunById(fixture.run.id)!.claimedBy).toBe('worker-b');
  });

  it('commit race through the public seam: sibling rows land between the pure-read check and the insert → drift → parent superseded, old rows unchanged', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    // A racing sibling commits a foreign-hash set after A's group transport
    // but before A's insert — A's write-once insert converts to the
    // deterministic drift error, and the seam supersedes the parent.
    let planted = false;
    let thrown: unknown;
    try {
      await curation.executeClaim(fixture.run.id, 'worker-a', {
        afterCoordinatedCall: (kind: 'title' | 'page') => {
          if (kind !== 'page' || planted) return;
          planted = true;
          // Synchronous plant: the core invokes this seam WITHOUT awaiting
          // it, so the sibling rows must land before this callback returns —
          // a dynamic import would lose the race.
          insertCohortPageOutputsOnce({
            workspaceId: fixture.workspaceId,
            runId: fixture.run.id,
            inputHash: 'racing_input_hash_' + 'a'.repeat(46),
            outputs: fixture.projection.members.map(m => ({
              productSku: m.productSku ?? '',
              output: { status: 'abstained', reason: 'racing process output' },
              modelCallId: null,
            })),
          });
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('CohortPageAuthorityDrift');
    expect((thrown as Error).cause).toBeInstanceOf(CohortPageAuthorityDriftError);
    const run = getCohortRunById(fixture.run.id)!;
    expect(run.status).toBe('superseded');
    // The sibling's rows stand (write-once); the error carries their identity.
    const rows = getCohortPageOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.inputHash === 'racing_input_hash_' + 'a'.repeat(46))).toBe(true);
    // A new revision is immediately claimable.
    const claimed = claimReadyCurationCohorts(fixture.workspaceId, 10, 'worker-c', COHORT_LEASE_TTL_MS);
    expect(claimed.some(r => r.cohortId === fixture.run.cohortId && r.id !== fixture.run.id)).toBe(true);
  });
});

// ─── §1.4 title-vs-page asymmetries (one negative test each) ─────────────────

describe('title-vs-page asymmetries (plan §1.4)', () => {
  it('NO cross-parent page copy: revision B with the SAME frozen authority coordinates FRESH (new transport calls), unlike titles', async () => {
    // Run A: durable page set under A (op-level setup — not crash evidence).
    const fixtureA = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const mapA = await ensureCohortPages({
      run: fixtureA.run,
      workspaceId: fixtureA.workspaceId,
      projection: fixtureA.projection,
      frozenLineContext: fixtureA.frozenLineContext,
    });
    expect(mapA.size).toBe(3);
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
    const rowsA = getCohortPageOutputsByRun(fixtureA.run.id);
    expect(rowsA).toHaveLength(3);

    // Revision B with the SAME frozen authority: supersede A, claim + freeze B.
    groupPageCallCount = 0;
    singletonPageCallCount = 0;
    const fixtureB = await supersedeAndRefreeze(fixtureA);
    expect(expectedPageInputHash(fixtureB)).toBe(expectedPageInputHash(fixtureA));

    const mapB = await ensureCohortPages({
      run: fixtureB.run,
      workspaceId: fixtureB.workspaceId,
      projection: fixtureB.projection,
      frozenLineContext: fixtureB.frozenLineContext,
    });
    // FRESH coordination — pages never copy a superseded set, even on an
    // exact authority match. (Titles copy here with zero calls.)
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
    expect(mapB.size).toBe(3);
    // FRESH write-once rows under the NEW run id, same values, fresh P-hash.
    const rowsB = getCohortPageOutputsByRun(fixtureB.run.id);
    expect(rowsB).toHaveLength(3);
    expect(rowsB.every(r => r.inputHash === expectedPageInputHash(fixtureB))).toBe(true);
    expect(rowsB.map(r => JSON.parse(r.outputValueJson))).toEqual(rowsA.map(r => JSON.parse(r.outputValueJson)));
    // The old run's rows are untouched (immutable historical truth).
    expect(getCohortPageOutputsByRun(fixtureA.run.id)).toEqual(rowsA);
  });

  it('all-member page set vs multi-item-only title set: the singleton has a page row but NO title row; P-hash (v1) differs from T-hash (v2)', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const titles = await ensureCohortTitles({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      cohort: fixture.cohort,
      frozenLineContext: fixture.frozenLineContext,
    });
    const pages = await ensureCohortPages({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      frozenLineContext: fixture.frozenLineContext,
    });
    // DECISION-O: the singleton member keeps member-local naming — no title row.
    expect([...titles.keys()].sort()).toEqual(['100000000001', '100000000002']);
    // DECISION-A: EVERY member — groups AND singletons — has a page result.
    expect([...pages.keys()].sort()).toEqual(['100000000001', '100000000002', '100000000003']);
    // Distinct hash authorities: the committed page rows carry the P-hash,
    // which is never equal to any title row's T-hash (v1 coordinated_page
    // vs v2 curated_title payloads).
    const pageRows = getCohortPageOutputsByRun(fixture.run.id);
    expect(pageRows).toHaveLength(3);
    expect(pageRows.every(r => r.inputHash === expectedPageInputHash(fixture))).toBe(true);
    const titleRows = getDb().query(
      "SELECT input_hash AS inputHash FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title'",
    ).all(fixture.run.id) as Array<{ inputHash: string }>;
    expect(titleRows.length).toBe(2);
    expect(titleRows.every(r => r.inputHash !== expectedPageInputHash(fixture))).toBe(true);
  });
});

// ─── §1.4 model-unavailability + output-integrity negatives ─────────────────
// P1 follow-up: the asymmetry table promises per-member coded abstention
// with call-free retry on model unavailability, and corrupt-set failure for
// bad page rows. The denied/unavailable paths run through the PUBLIC seam
// (a member-pipeline crash holds the run open so the retry must reuse the
// abstained set); the corrupt-row case mirrors the titles BLOCKER-1 test at
// the op level — deterministic, no member execution required.

function countPageTerminalRows(cohortRunId: string, status: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_model_calls
     WHERE status = ? AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
  ).get(status, cohortRunId) as { cnt: number };
  return Number(row.cnt);
}

describe('page model-unavailability persists abstentions; retry is call-free', () => {
  it('policy-denied parent transport persists one coded abstention per member; retry reuses with zero new transport or audit rows', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    // Deny BOTH page attempts (group + singleton); hold the run open after
    // member execution so the retry below must reuse the abstained set.
    denyNextParentPageConfig = true;
    await expect(
      curation.executeClaim(fixture.run.id, 'worker-a', {
        afterMemberPipeline: () => {
          throw new MemberCommitCrashSimulationError('simulated member-commit crash');
        },
      }),
    ).rejects.toBeInstanceOf(MemberCommitCrashSimulationError);
    denyNextParentPageConfig = false;
    // Denial lands at PREFLIGHT (before any transport): group + singleton
    // each abstain with ZERO transport calls. No usable page exists anywhere
    // in the durable set.
    expect(groupPageCallCount).toBe(0);
    expect(singletonPageCallCount).toBe(0);
    const rows = getCohortPageOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const parsed = JSON.parse(row.outputValueJson) as { status: string; reason: string };
      expect(parsed.status).toBe('abstained');
      expect(parsed.reason).toMatch(/policy denied/i);
      expect(row.modelCallId).toBeNull();
    }
    // Both denied preflights are audited as terminal rows.
    expect(countPageTerminalRows(fixture.run.id, 'policy_denied')).toBe(2);
    // Retry through the seam: the abstained set is REUSED — zero new page
    // transport, zero new audit rows, rows byte-identical.
    const auditsBefore = countPageAuditRowsForRun(fixture.run.id);
    const finished = await curation.executeClaim(fixture.run.id, 'worker-a');
    expect(finished.executed).toBe(true);
    expect(groupPageCallCount).toBe(0);
    expect(singletonPageCallCount).toBe(0);
    expect(countPageAuditRowsForRun(fixture.run.id)).toBe(auditsBefore);
    expect(getCohortPageOutputsByRun(fixture.run.id)).toEqual(rows);
  });

  it('unavailable parent transport persists one coded abstention per member; retry reuses with zero new transport or audit rows', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const curation = createCohortCuration({
      workspacePath: fixture.workspacePath,
      workspaceId: fixture.workspaceId,
    });
    unavailableNextParentPageConfig = true;
    await expect(
      curation.executeClaim(fixture.run.id, 'worker-a', {
        afterMemberPipeline: () => {
          throw new MemberCommitCrashSimulationError('simulated member-commit crash');
        },
      }),
    ).rejects.toBeInstanceOf(MemberCommitCrashSimulationError);
    unavailableNextParentPageConfig = false;
    expect(groupPageCallCount).toBe(0);
    expect(singletonPageCallCount).toBe(0);
    const rows = getCohortPageOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const parsed = JSON.parse(row.outputValueJson) as { status: string; reason: string };
      expect(parsed.status).toBe('abstained');
      expect(parsed.reason).toMatch(/no .* llm is configured/i);
      expect(row.modelCallId).toBeNull();
    }
    expect(countPageTerminalRows(fixture.run.id, 'unavailable')).toBe(2);
    const auditsBefore = countPageAuditRowsForRun(fixture.run.id);
    const finished = await curation.executeClaim(fixture.run.id, 'worker-a');
    expect(finished.executed).toBe(true);
    expect(groupPageCallCount).toBe(0);
    expect(singletonPageCallCount).toBe(0);
    expect(countPageAuditRowsForRun(fixture.run.id)).toBe(auditsBefore);
    expect(getCohortPageOutputsByRun(fixture.run.id)).toEqual(rows);
  });

  it('corrupt persisted page row throws CohortPageOutputCorruptError with run id, per-SKU failure + usable rows — zero re-coordination', async () => {
    const fixture = await freezeCohortFixture(THREE_MEMBER_EXTRACTIONS);
    const first = await ensureCohortPages({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      projection: fixture.projection,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(3);
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
    // Corrupt ONE persisted row (bad JSON — a real corrupt storage write).
    getDb().run(
      "UPDATE classification_cohort_outputs SET output_value_json = '{corrupt' WHERE cohort_run_id = ? AND output_kind = 'coordinated_page' AND product_sku = '100000000001'",
      [fixture.run.id],
    );
    let thrown: unknown;
    try {
      await ensureCohortPages({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        projection: fixture.projection,
        frozenLineContext: fixture.frozenLineContext,
      });
      expect.unreachable('expected CohortPageOutputCorruptError');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortPageOutputCorruptError);
    const corrupt = thrown as CohortPageOutputCorruptError;
    expect(corrupt.runId).toBe(fixture.run.id);
    expect(corrupt.failures).toHaveLength(1);
    expect(corrupt.failures[0].sku).toBe('100000000001');
    expect(corrupt.failures[0].cause).toContain('JSON Parse error');
    expect(corrupt.message).toContain(fixture.run.id);
    // The two unaffected rows stay usable; the corrupt SKU is absent.
    expect(corrupt.usableOutputs.size).toBe(2);
    expect(corrupt.usableOutputs.has('100000000001')).toBe(false);
    expect(corrupt.usableOutputs.get('100000000002')?.output.status).toBe('assigned');
    expect(corrupt.usableOutputs.get('100000000003')?.output.status).toBe('assigned');
    // ZERO re-coordination — the corrupt row never triggers a new page call.
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
  });
});
