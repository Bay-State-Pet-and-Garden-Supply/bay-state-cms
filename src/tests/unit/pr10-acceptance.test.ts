/**
 * PR10 acceptance (issue #30): Review UX for blocked findings.
 *
 * C1 — first-class `semanticValidation` on the hydrated item payload: an
 * active blocked member's `GET /items/:id` carries `semanticValidation.status
 * = 'blocked'` with its findings; a coherent member carries `passed`; legacy
 * items OMIT the field entirely; malformed active curation data yields the
 * fail-closed blocked payload (never absent).
 *
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
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { executeViaSeam } from './helpers/cohort-curation-harness';
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
function decideAllProposals(_item: OnboardingItem): void {
  void _item;
}

/** Advance completed curation members to the review stage (blocked members
 *  land in review/pending — the drawer sees them there). */
function advanceToReview(_items: OnboardingItem[]): void {
  void _items;
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

