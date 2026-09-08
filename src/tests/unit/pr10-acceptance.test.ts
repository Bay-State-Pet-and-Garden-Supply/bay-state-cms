/**
 * PR10 acceptance (issue #30): Review UX for blocked findings.
 *
 * C1 — first-class `semanticValidation` on the hydrated item payload: an
 * active blocked member's `GET /items/:id` carries `semanticValidation.status
 * = 'blocked'` with its findings; a coherent member carries `passed`; legacy
 * items OMIT the field entirely; malformed active curation data yields the
 * fail-closed blocked payload (never absent).
 *
 * C2 — `POST /cohorts/:id/re-run` (new-cohort-revision resolution): an idle
 * TERMINAL parent is superseded + its linked children stay terminal + the
 * cohort's members are reset (stage curation/pending, curation_data NULL) +
 * the job queue's next claim yields a NEW run id + the fresh revision
 * re-coordinates fresh outputs under the new id and re-validates (a fixed
 * member passes end-to-end; a still-conflicted member blocks again with
 * fresh findings). A claimed RUNNING parent => 400 `run_busy` with ZERO
 * mutation. Legacy/non-cohort (no current run) => 400 `no_active_run`.
 * Unknown cohort => 404.
 *
 * C4 — gate truth: after a re-run the OLD parent is superseded (the R2 gate
 * refuses its children as historical via `parent_superseded` / projection
 * loss) and the NEW revision's members are gate-evaluable (blocked =>
 * `semantic_validation_blocked`; fixed + decided => `ok: true`).
 *
 * Harness: pr9-acceptance structure (temp DB, migrations,
 * `prepareActiveV2Workspace`, verified Page import, THREE-member cohort with
 * the conflicting-Brand fixture) plus the counting llm-client mock. The
 * re-run route tests run on a FRESH per-test DB (the route resolves the
 * active workspace via `findWorkspace` LIMIT 1, so the DB must contain
 * exactly one workspace).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initDb, getDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemExtractionData,
  advanceItemsToNextStage,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  computeMembershipHash,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCurrentCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { executeViaSeam } from './helpers/cohort-curation-harness';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { clearCohortPageCoordinationCache } from '../../classification/cohort-page-proposal-engine';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
} from '../../classification/flags';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import type { CohortRun, CurationCohort } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { Hono } from 'hono';
import onboardingRoutes from '../../server/routes/onboarding-routes';

// ─── llm-client mock (counting; production audit semantics) ───────────────────

let auditCallSeq = 0;

// NOTE: every page an SKU can land on must be a valid PRIMARY category for the
// fixture's dry-food products. The deterministic category-correctness guards
// (P5: food↔treat and wet↔dry exclusivity; brand landing pages cannot serve as
// primary) turn incompatible assignments into durable reviewable abstentions,
// which fail the review completion gate fail-closed. 'Dog Food' is the second
// food-category primary used for even SKUs ("siblings differ by design").
const PAGE_NAMES = ['Dog Food Dry', 'Dog Treats', 'Brand - Acme', 'Dog Food'];

function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

function findPage(pages: Array<{ id: string; name: string }>, name: string) {
  return pages.find(page => page.name === name) ?? null;
}

/** The group response: every SKU in the prompt assigned to a FROZEN page.
 *  Siblings differ by design (rule 7): the SKU VALUE decides the page. Even
 *  SKUs land on the generic 'Dog Food' category (never treat-only or brand-only
 *  pages — the deterministic P5/category guards reject those for food products,
 *  and an abstained durable page decision can never pass the review gate). */
function cannedGroupResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const skus = [...prompt.matchAll(/^SKU (\d{10,})$/gm)].map(match => match[1]);
  const payload: Record<string, unknown> = {};
  for (const sku of skus) {
    const evenSku = Number(sku.slice(-2)) % 2 === 0;
    const page = findPage(pages, evenSku ? PAGE_NAMES[3] : PAGE_NAMES[0]);
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
  if (operation === 'cohort_title_consolidation') {
    if (options.modelCall) writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
    return null;
  }
  if (operation === 'cohort_page_assignment_parent') {
    if (options.modelCall) writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
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
const tempPaths: string[] = [];

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr10-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  for (const tempPath of tempPaths) {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

afterEach(() => {
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
  clearCohortPageCoordinationCache();
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  return app;
}

// ─── Fixtures (mirror pr9-acceptance) ─────────────────────────────────────────

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

function insertWorkspaceRow(id: string, wsPath: string): void {
  const now = new Date().toISOString();
  insertWorkspace({
    id,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

function newWorkspace(): { workspaceId: string; workspacePath: string } {
  const workspaceId = randomUUID();
  const wsPath = path.join(workspacePath, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
  initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspaceRow(workspaceId, wsPath);
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR10 Acceptance Batch', fileName: 'pr10.xlsx', totalItems: itemsData.length }).id;
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

const THREE_MEMBER_EXTRACTIONS = {
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
};

/** PR9 C5 conflicting-Brand fixture: members 1+3 resolve the cohort brand
 *  (`woof` from the Woof brandHint), member 2's frozen extraction brand
 *  resolves to a DIFFERENT canonical Brand ('blue-buffalo') => HARD
 *  `family_brand` block for member 2; members 1+3 pass. */
const CONFLICTING_BRAND_EXTRACTIONS = {
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', brand: 'Blue Buffalo' }),
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
};

function activateVerifiedPages(wsId: string): void {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-food', name: 'Dog Food' },
    { key: 'dog-treats', name: 'Dog Treats' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr10-acceptance-pages'),
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

function prepareActiveV2Workspace(
  wsId: string,
  wsPath: string,
  extByUpc: Record<string, Record<string, any>>,
): { items: OnboardingItem[]; cohorts: CurationCohort[]; configSnapshotHash: string } {
  const { bundle } = writeActiveV2Bundle(wsPath);
  const { hash: configSnapshotHash } = upsertConfigSnapshot(wsId, bundle);
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
  return { items: created.items, cohorts: created.cohorts, configSnapshotHash };
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

/** Insert an 'accepted' decision for every non-abstention proposal of the
 *  member's active run (the review gate requires all proposals decided). */
function decideAllProposals(item: OnboardingItem): void {
  const runId = item.curationData!.classificationRunId!;
  const proposals = getDb().query(
    'SELECT id, proposal_type FROM classification_proposals WHERE run_id = ?',
  ).all(runId) as Array<{ id: string; proposal_type: string }>;
  const now = new Date().toISOString();
  for (const proposal of proposals) {
    if (proposal.proposal_type === 'reviewable_abstention') continue;
    getDb().run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`c10-decision-${proposal.id}`, proposal.id, `key-${proposal.id}`, now],
    );
    getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', ['accepted', proposal.id]);
  }
}

/** Advance completed curation members to the review stage (blocked members
 *  land in review/pending — the drawer sees them there). */
function advanceToReview(items: OnboardingItem[]): void {
  const advanced = advanceItemsToNextStage(items.map(item => item.id));
  expect(advanced.advanced).toBe(items.length);
  for (const item of items) {
    const stored = findItemById(item.id)!;
    expect(stored.stage).toBe('review');
    expect(stored.stageStatus).toBe('pending');
  }
}

function runConflictingCohort(wsId: string, wsPath: string): Promise<{
  items: OnboardingItem[];
  run: CohortRun;
  memberFailures: Array<string | null>;
}> {
  return (async () => {
    const { items } = prepareActiveV2Workspace(wsId, wsPath, CONFLICTING_BRAND_EXTRACTIONS);
    const run = await freezeActiveCohort(wsId, wsPath);
    const summary = await executeViaSeam(wsPath, wsId, run.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe('100000000002');
    // blocked-not-destroyed: the blocked member committed its curation data.
    // Re-fetch the items AFTER processCohort (the pre-run snapshot is stale).
    const freshItems = listItemsByBatch(items[0].batchId);
    const memberTwo = findItemById(freshItems[1].id)!;
    expect(memberTwo.stageStatus).toBe('completed');
    expect(memberTwo.curationData!.semanticValidation!.status).toBe('blocked');
    return { items: freshItems, run, memberFailures: summary.memberFailures.map(f => f.productSku) };
  })();
}

/** Fresh per-test DB with EXACTLY ONE workspace so the route's
 *  `findWorkspace` (LIMIT 1) resolves deterministically. */
function freshRouteDb(): { workspaceId: string; workspacePath: string } {
  const root = path.join(os.tmpdir(), `baystate-cms-pr10-rerun-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(root, { recursive: true });
  tempPaths.push(root);
  resetDb();
  initDb(path.join(root, 'app.db'));
  runMigrations();
  const workspaceId = randomUUID();
  const wsPath = path.join(root, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
  insertWorkspaceRow(workspaceId, wsPath);
  return { workspaceId, workspacePath: wsPath };
}

async function rerunCohort(cohortId: string): Promise<Response> {
  return makeApp().request(`/api/onboarding/cohorts/${cohortId}/re-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ─── C1: first-class semanticValidation item field ────────────────────────────

describe('PR10 C1 — hydrated item payload carries the first-class semanticValidation surface (issue #30, DECISION-A)', () => {
  it('active blocked member: GET /items/:id carries semanticValidation.status="blocked" with the family_brand finding', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await runConflictingCohort(workspaceId, wsPath);

    const res = await makeApp().request(`/api/onboarding/items/${items[1].id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const sv = (body as any).semanticValidation;
    expect(sv).toBeDefined();
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find((f: any) => f.code === 'family_brand');
    expect(finding).toBeDefined();
    expect(finding.memberSku).toBe('100000000002');
    expect(finding.message).toContain('blue-buffalo');
    expect(finding.message).toContain('woof');
    // The active surface replaces the legacy warnings (server sends [] there).
    expect((body as any).consistencyWarnings).toEqual([]);
  });

  it('active coherent member: GET /items/:id carries semanticValidation.status="passed" with no findings', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const res = await makeApp().request(`/api/onboarding/items/${items[0].id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const sv = (body as any).semanticValidation;
    expect(sv).toBeDefined();
    expect(sv.status).toBe('passed');
    expect(sv.findings).toEqual([]);
  });

  it('legacy item: GET /items/:id OMITS the semanticValidation field entirely', async () => {
    const { workspaceId } = newWorkspace();
    const batchId = createBatch({ workspaceId, name: 'Legacy Batch', fileName: 'legacy.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [{ upc: '700000000001', name: 'Legacy Acme Dog Food', brandHint: 'Acme', rowNumber: 1 }]);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const res = await makeApp().request(`/api/onboarding/items/${item.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'semanticValidation')).toBe(false);
  });

  it('malformed active curation data: GET /items/:id yields the FAIL-CLOSED blocked payload (never absent)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    // Corrupt the committed semanticValidation payload (malformed status).
    const stored = findItemById(items[0].id)!;
    const corrupted = {
      ...stored.curationData,
      semanticValidation: { status: 'banana', findings: [] },
    };
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(corrupted), items[0].id],
    );

    const res = await makeApp().request(`/api/onboarding/items/${items[0].id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const sv = (body as any).semanticValidation;
    expect(sv).toBeDefined();
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find((f: any) => f.code === 'semantic_validation_unavailable');
    expect(finding).toBeDefined();
    expect(finding.memberSku).toBe('100000000001');
  });
});

// ─── C2: new-cohort-revision re-run route ─────────────────────────────────────

describe('PR10 C2 — POST /cohorts/:id/re-run (new-cohort-revision resolution, owner-guarded, gate-neutral)', () => {
  it('idle terminal parent: superseded + children terminal + members reset; the next claim yields a NEW run id; the fresh revision re-coordinates fresh outputs and re-validates — a still-conflicted member blocks again with FRESH findings', async () => {
    const { workspaceId, workspacePath: wsPath } = freshRouteDb();
    const { items, run: oldRun } = await runConflictingCohort(workspaceId, wsPath);
    const cohortId = oldRun.cohortId;
    const oldChildRunId = items[1].curationData!.classificationRunId!;
    const oldMemberTwoCuration = items[1].curationData;
    // The old revision's children are terminal (blocked-not-destroyed).
    const oldChildren = getDb().query(
      'SELECT status FROM classification_runs WHERE cohort_run_id = ?',
    ).all(oldRun.id) as Array<{ status: string }>;
    expect(oldChildren).toHaveLength(3);
    expect(oldChildren.every(child => ['completed', 'completed_with_abstentions'].includes(child.status))).toBe(true);
    // The old parent keeps its sticky claimed_by (historical ownership).
    expect(getCohortRunById(oldRun.id)!.claimedBy).toBe('worker-a');

    // Members sit in Review (blocked members advanced from curation).
    advanceToReview(items);

    // Reviewer triggers a NEW cohort revision.
    const res = await rerunCohort(cohortId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ superseded: true, cohortId });

    // 1. OLD parent superseded; its immutable rows stay historical.
    const superseded = getCohortRunById(oldRun.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededAt).not.toBeNull();
    expect(superseded.errorMessage).toContain('New cohort revision requested by reviewer');
    // Children remain terminal (no running child to yank).
    const childrenAfter = getDb().query(
      'SELECT status FROM classification_runs WHERE cohort_run_id = ?',
    ).all(oldRun.id) as Array<{ status: string }>;
    expect(childrenAfter.every(child => ['completed', 'completed_with_abstentions'].includes(child.status))).toBe(true);

    // 2. Members reset to curation/pending with curation_data cleared.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stage).toBe('curation');
      expect(stored.stageStatus).toBe('pending');
      expect(stored.curationData).toBeNull();
    }

    // 3. The job queue's next claim yields a NEW run id immediately.
    const [newRun] = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(newRun).toBeDefined();
    expect(newRun.cohortId).toBe(cohortId);
    expect(newRun.id).not.toBe(oldRun.id);

    // 4. The fresh revision re-freezes, re-coordinates, and re-validates.
    const finalized = await freezeCohortForExecution(newRun, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-b');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe('100000000002');

    // 5. Fresh durable outputs exist UNDER THE NEW RUN ID (old rows untouched).
    const newOutputs = getDb().query(
      'SELECT output_kind FROM classification_cohort_outputs WHERE cohort_run_id = ?',
    ).all(newRun.id) as Array<{ output_kind: string }>;
    expect(newOutputs.length).toBeGreaterThan(0);
    expect(newOutputs.some(row => row.output_kind === 'curated_title')).toBe(true);
    expect(newOutputs.some(row => row.output_kind === 'coordinated_page')).toBe(true);

    // 6. The still-conflicted member blocks AGAIN with FRESH findings under
    //    the NEW run id.
    const newMemberTwo = findItemById(items[1].id)!;
    expect(newMemberTwo.curationData!.classificationRunId).not.toBe(oldChildRunId);
    const sv = newMemberTwo.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find(f => f.code === 'family_brand')!;
    expect(finding.memberSku).toBe('100000000002');
    expect(finding.message).toContain('blue-buffalo');
    expect(finding.message).toContain('woof');

    // 7. GATE TRUTH: the OLD parent is superseded — the R2 gate refuses its
    //    children as historical (parent_superseded when the old committed
    //    projection is restored; projection-loss otherwise).
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(oldMemberTwoCuration), items[1].id],
    );
    const oldGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: items[1].id,
      productSku: items[1].upc,
      activeRunId: oldChildRunId,
    });
    expect(oldGate.ok).toBe(false);
    if (!oldGate.ok) expect(oldGate.code).toBe('parent_superseded');

    // 8. GATE TRUTH: the NEW revision's member is gate-evaluable (blocked =>
    //    semantic_validation_blocked — NOT a historical refusal).
    const newGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: items[1].id,
      productSku: items[1].upc,
      activeRunId: newMemberTwo.curationData!.classificationRunId!,
    });
    expect(newGate.ok).toBe(false);
    if (!newGate.ok) expect(newGate.code).toBe('semantic_validation_blocked');
  });

  it('idle terminal parent + FIXED member evidence: the fresh revision re-validates and the fixed member passes END-TO-END (gate ok after deciding proposals)', async () => {
    const { workspaceId, workspacePath: wsPath } = freshRouteDb();
    const { items, run: oldRun } = await runConflictingCohort(workspaceId, wsPath);
    const cohortId = oldRun.cohortId;

    // Fix the underlying cause BEFORE the re-run: member 2's frozen brand
    // evidence now resolves to the cohort's canonical brand (woof).
    const memberTwoExt = {
      ...(items[1].extractionData ?? {}),
      brand: 'Woof',
    };
    updateItemExtractionData(items[1].id, JSON.stringify(memberTwoExt));

    advanceToReview(items);
    const res = await rerunCohort(cohortId);
    expect(res.status).toBe(200);

    // The next claim creates a fresh revision; the re-coordinated + re-validated
    // cohort now completes cleanly — every member passes.
    const [newRun] = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(newRun.id).not.toBe(oldRun.id);
    const finalized = await freezeCohortForExecution(newRun, wsPath, workspaceId);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-b');
    expect(summary.parentStatus).toBe('completed');
    expect(summary.completedMembers).toBe(3);

    const fixedMember = findItemById(items[1].id)!;
    expect(fixedMember.curationData!.semanticValidation!.status).toBe('passed');
    const fixedMemberGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: fixedMember.id,
      productSku: fixedMember.upc,
      activeRunId: fixedMember.curationData!.classificationRunId!,
    });
    expect(fixedMemberGate.ok).toBe(false); // proposals not decided yet

    decideAllProposals(fixedMember);
    const decidedGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: fixedMember.id,
      productSku: fixedMember.upc,
      activeRunId: fixedMember.curationData!.classificationRunId!,
    });
    expect(decidedGate.ok).toBe(true);
  });

  it('CLAIMED running parent => 400 run_busy with ZERO mutation (fail-closed; a reviewer re-run never yanks a live worker)', async () => {
    const { workspaceId, workspacePath: wsPath } = freshRouteDb();
    const { items, cohorts } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const cohortId = cohorts[0].id;
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.status).toBe('running');
    expect(run.claimedBy).toBe('worker-a');

    // Snapshot pre-call state to prove ZERO mutation.
    const beforeRun = getCohortRunById(run.id)!;
    const beforeMembers = items.map(item => {
      const stored = findItemById(item.id)!;
      return { stage: stored.stage, stageStatus: stored.stageStatus, curationData: stored.curationData };
    });

    const res = await rerunCohort(cohortId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as any).code).toBe('run_busy');

    // ZERO mutation: run unchanged (still running, no superseded_at), members untouched.
    const afterRun = getCohortRunById(run.id)!;
    expect(afterRun.status).toBe('running');
    expect(afterRun.supersededAt).toBeNull();
    expect(afterRun.errorMessage).toBeNull();
    expect(afterRun).toEqual(beforeRun);
    for (const [index, item] of items.entries()) {
      const stored = findItemById(item.id)!;
      expect(stored.stage).toBe(beforeMembers[index].stage);
      expect(stored.stageStatus).toBe(beforeMembers[index].stageStatus);
      expect(stored.curationData).toEqual(beforeMembers[index].curationData);
    }
    // No new run was created for the cohort (the current run is unchanged).
    expect(getCurrentCohortRun(cohortId)!.id).toBe(run.id);
  });

  it('legacy/non-cohort (no current run) => 400 no_active_run; unknown cohort => 404', async () => {
    const { workspaceId, workspacePath: wsPath } = freshRouteDb();
    const { cohorts } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const cohortId = cohorts[0].id;
    // No cohort run exists (legacy mode / never claimed): nothing to supersede.
    expect(getCurrentCohortRun(cohortId)).toBeNull();

    const res = await rerunCohort(cohortId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as any).code).toBe('no_active_run');

    const missing = await rerunCohort('no-such-cohort');
    expect(missing.status).toBe(404);
  });
});
