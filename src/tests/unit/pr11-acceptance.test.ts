/**
 * PR11 acceptance (issue #30): the Promotion gate.
 *
 * Harness: pr10-acceptance structure — fresh per-test DBs for route tests so
 * `findWorkspace` (LIMIT 1) resolves deterministically. C3 adds the
 * advance-hole suite (a PR9 blocked member cannot advance review → promotion);
 * the promotion-gate acceptance suite (C4) extends this file with the full
 * cohort harness.
 *
 * The "a blocked item that somehow reaches promotion is still refused by the
 * promotion gate" contract is asserted in the draft-promoter suite
 * (draft-promoter.test.ts, PR11 C2): a blocked member in the promotion stage
 * is refused per-item with `semantic_validation_blocked` and its first
 * finding, while siblings promote.
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
  listDependenciesForProposal,
  supersedeCohortRun,
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
import { promoteItems } from '../../onboarding/draft-promoter';
import { seedPromotionApproval } from './helpers/seed-promotion-approval';
import { markReviewed } from '../../db/repositories/onboarding-review-repo';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import type { CohortRun, CurationCohort } from '../../shared/schemas/cohorts';
import type { OnboardingItem, CurationData } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { Hono } from 'hono';
import onboardingRoutes from '../../server/routes/onboarding-routes';

// ─── llm-client mock (counting; production audit semantics) ───────────────────

let auditCallSeq = 0;

// Even-SKU members land on the generic 'Dog Food' category: the deterministic
// P5 guards reject treat-only/brand-only primary pages for dry-food products,
// and an abstained durable page decision can never pass the review gate.
const PAGE_NAMES = ['Dog Food Dry', 'Dog Treats', 'Brand - Acme', 'Dog Food'];

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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr11-acceptance-${randomUUID().slice(0, 8)}`);
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

/** Fresh per-test DB with EXACTLY ONE workspace so the route's `findWorkspace`
 *  (LIMIT 1) resolves deterministically. */
function freshRouteDb(): { workspaceId: string; workspacePath: string } {
  const root = path.join(os.tmpdir(), `baystate-cms-pr11-route-${randomUUID().slice(0, 8)}`);
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

/** Insert a REVIEW-stage item that is 'completed' (would advance without the
 *  guard). `curationOverrides` can carry a blocked semanticValidation. */
function insertReviewItem(
  batchId: string,
  upc: string,
  curationOverrides: Record<string, unknown> = {},
): { id: string; upc: string } {
  const [item] = insertItems(batchId, [{ upc, name: `Item ${upc}`, rowNumber: 1 }]);
  const curation = {
    curatedTitle: `Item ${upc}`,
    titleSource: 'web',
    suggestedPages: [],
    suggestedProductType: null,
    curatedAt: new Date().toISOString(),
    curationMethod: 'auto',
    ...curationOverrides,
  };
  getDb().run(
    "UPDATE onboarding_items SET stage = 'review', stage_status = 'completed', curation_data_json = ? WHERE id = ?",
    [JSON.stringify(curation), item.id],
  );
  // Epic #46 review round-2: a review/completed item being advanced must have
  // durable review state (the advance guard refuses review→promotion without
  // it). Seed it so these C3 tests hit their intended semantic guard.
  markReviewed({ itemId: item.id, batchId, reviewedBy: 'test' });
  return { id: item.id, upc: item.upc };
}

// ─── PR11 C3: the advance-hole guard (DECISION-B) ────────────────────────────

describe('PR11 C3 — a blocked member cannot advance review → promotion via the advance route (issue #30, DECISION-B)', () => {
  it('refuses the blocked member (stays in review) while healthy siblings advance; the response carries the deterministic reason', async () => {
    const { workspaceId } = freshRouteDb();
    const batchId = createBatch({ workspaceId, name: 'Advance Hole', fileName: 'advance.xlsx', totalItems: 3 }).id;
    const blocked = insertReviewItem(batchId, '900000000001', {
      semanticValidation: {
        status: 'blocked',
        findings: [{
          code: 'family_brand',
          memberSku: '900000000001',
          message: 'Brand conflict: acme vs woof',
        }],
      },
    });
    const healthyA = insertReviewItem(batchId, '900000000002');
    const healthyB = insertReviewItem(batchId, '900000000003');

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [blocked.id, healthyA.id, healthyB.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { advanced: number; skipped: number; refused: Array<{ itemId: string; reason: string }> };
    expect(body.advanced).toBe(2);
    expect(body.refused).toHaveLength(1);
    expect(body.refused[0].itemId).toBe(blocked.id);
    expect(body.refused[0].reason).toBe('semantic_validation_blocked: Brand conflict: acme vs woof');

    // The blocked member stays in review (completed — the Review drawer keeps it).
    const blockedRow = findItemById(blocked.id)!;
    expect(blockedRow.stage).toBe('review');
    expect(blockedRow.stageStatus).toBe('completed');

    // Healthy siblings advance review → promotion unchanged.
    for (const healthy of [healthyA, healthyB]) {
      const row = findItemById(healthy.id)!;
      expect(row.stage).toBe('promotion');
      expect(row.stageStatus).toBe('pending');
    }
  });

  it('healthy items advance unchanged even when no blocked member is present', async () => {
    const { workspaceId } = freshRouteDb();
    const batchId = createBatch({ workspaceId, name: 'Advance Healthy', fileName: 'advance-healthy.xlsx', totalItems: 2 }).id;
    const a = insertReviewItem(batchId, '900000000004');
    const b = insertReviewItem(batchId, '900000000005');

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id, b.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { advanced: number; refused: Array<{ itemId: string; reason: string }> };
    expect(body.advanced).toBe(2);
    expect(body.refused).toHaveLength(0);
    for (const item of [a, b]) {
      expect(findItemById(item.id)!.stage).toBe('promotion');
    }
  });

  it('a blocked member in the CURATION stage still advances to review (blocked-not-destroyed must reach the Review drawer)', async () => {
    const { workspaceId } = freshRouteDb();
    const batchId = createBatch({ workspaceId, name: 'Advance To Review', fileName: 'advance-review.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [{ upc: '900000000006', name: 'Blocked Curation Member', rowNumber: 1 }]);
    getDb().run(
      "UPDATE onboarding_items SET stage = 'curation', stage_status = 'completed', curation_data_json = ? WHERE id = ?",
      [JSON.stringify({
        curatedTitle: 'Blocked Curation Member',
        titleSource: 'web',
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
        semanticValidation: {
          status: 'blocked',
          findings: [{ code: 'family_brand', memberSku: '900000000006', message: 'Brand conflict: acme vs woof' }],
        },
      }), item.id],
    );

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { advanced: number; refused: Array<{ itemId: string; reason: string }> };
    // The guard only covers review → promotion; curation → review proceeds so
    // the blocked member is visible in the Review drawer.
    expect(body.advanced).toBe(1);
    expect(body.refused).toHaveLength(0);
    const row = findItemById(item.id)!;
    expect(row.stage).toBe('review');
    expect(row.stageStatus).toBe('pending');
  });
});

// ─── Cohort fixtures (mirror pr9/pr10-acceptance) ─────────────────────────────

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
 *  the PAGE curation target left ENABLED. `seed` is overridable so tests can
 *  adjust attribute config (e.g. controlled brand values). */
function writeActiveV2Bundle(
  wsPath: string,
  seed: typeof BayStatePetGardenSeed = BayStatePetGardenSeed,
): { bundle: ReturnType<typeof generateCandidate>['bundle']; xmlFields: string[] } {
  const candidate = generateCandidate(seed, EVIDENCE);
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

/** Cohort member fixture that is PROMOTION-ready: a price, a relative primary
 *  image (no network fetch in the draft promoter), and no additional URLs. */
function promotableExtraction(sku: string, overrides: Record<string, any> = {}): Record<string, any> {
  return settledExtraction({
    ...overrides,
    price: overrides.price ?? '$12.99',
    primaryImage: overrides.primaryImage ?? `products/${sku}/images/primary.jpg`,
    additionalImages: [],
  });
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR11 Acceptance Batch', fileName: 'pr11.xlsx', totalItems: itemsData.length }).id;
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

const COHERENT_PROMOTABLE = {
  '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
  '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
  '100000000003': promotableExtraction('100000000003', { _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
};

/** PR9 C5 conflicting-Brand fixture (member 2 resolves to a different
 *  canonical Brand) with promotion-ready fields. */
const CONFLICTING_PROMOTABLE = {
  '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
  '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', brand: 'Blue Buffalo' }),
  '100000000003': promotableExtraction('100000000003', { _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
};

/** Bay State seed with the UNIVERSAL `brand` attribute switched to controlled
 *  with allowedValues ['Acme'] — the member pipeline then deterministically
 *  emits a brand field_assignment proposal (which must carry NO dependency). */
const BRAND_CONTROLLED_SEED: typeof BayStatePetGardenSeed = {
  ...BayStatePetGardenSeed,
  attributes: BayStatePetGardenSeed.attributes.map(attribute =>
    attribute.id === 'brand'
      ? { ...attribute, valueMode: 'controlled' as const, allowedValues: ['Acme'] }
      : attribute,
  ),
};

function activateVerifiedPages(wsId: string): void {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-treats', name: 'Dog Treats' },
    { key: 'dog-food', name: 'Dog Food' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr11-acceptance-pages'),
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
  seed: typeof BayStatePetGardenSeed = BayStatePetGardenSeed,
): { items: OnboardingItem[]; cohorts: CurationCohort[]; configSnapshotHash: string } {
  const { bundle } = writeActiveV2Bundle(wsPath, seed);
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
 *  member's active run (the promotion gate consumes accepted proposals). */
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
      [`c11-decision-${proposal.id}`, proposal.id, `key-${proposal.id}`, now],
    );
    getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', ['accepted', proposal.id]);
  }
}

/** Move completed curation members straight to the promotion stage (the route
 *  gates are covered by the C3 suite; here we test the promotion gate itself). */
function placeInPromotion(items: OnboardingItem[]): void {
  for (const item of items) {
    getDb().run(
      "UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending' WHERE id = ?",
      [item.id],
    );
  }
  // Epic #46 review round-2: promotion now requires durable review + approval
  // (final transactional authority). Seed it so these gate tests exercise
  // their INTENDED gate (semantic/PR11), not the approval gate.
  seedPromotionApproval(items);
}

function fieldAssignmentsByTarget(curationData: CurationData): Map<string, CurationData['classificationProposals'][number]> {
  const byTarget = new Map<string, CurationData['classificationProposals'][number]>();
  for (const proposal of curationData.classificationProposals) {
    if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;
    byTarget.set(proposal.targetId, proposal);
  }
  return byTarget;
}

// ─── PR11 C4: promotion gate acceptance (issue #30) ──────────────────────────

describe('PR11 C4 — a blocked member in the promotion stage is refused per-item; siblings promote (zero draft writes)', () => {
  it('blocked member => semantic_validation_blocked with the first finding; ZERO draft rows; siblings promote', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, CONFLICTING_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe('100000000002');

    const items = prepared.items;
    const blockedMember = findItemById(items[1].id)!;
    expect(blockedMember.curationData!.semanticValidation!.status).toBe('blocked');
    const finding = blockedMember.curationData!.semanticValidation!.findings
      .find(f => f.code === 'family_brand')!;
    const blockedRunId = blockedMember.curationData!.classificationRunId!;

    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));

    // Siblings promote; the blocked member is refused per-item with the first
    // finding as the reason.
    expect(result.count).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].itemId).toBe(blockedMember.id);
    expect(result.failures[0].error).toBe(finding.message);

    const blockedRow = findItemById(blockedMember.id)!;
    expect(blockedRow.stageStatus).toBe('failed');
    expect(blockedRow.errorMessage).toBe(finding.message);

    // ZERO product draft rows for the refused member; drafts for both siblings.
    expect(listChangeSetItems(result.changeSetId!)
      .filter(ci => ci.sku === '100000000002')).toHaveLength(0);
    expect(listChangeSetItems(result.changeSetId!)
      .filter(ci => ci.sku === '100000000001')).toHaveLength(1);
    expect(listChangeSetItems(result.changeSetId!)
      .filter(ci => ci.sku === '100000000003')).toHaveLength(1);

    // The blocked member's run pointer is untouched (blocked-not-destroyed).
    expect(findItemById(blockedMember.id)!.curationData!.classificationRunId).toBe(blockedRunId);
  });

  it('P2 (R1): a blocked member produces NO image side effects — the pre-pass downloads images only for gate-passing items', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Only the BLOCKED member carries an HTTP image URL (the promotable
    // fixture uses relative paths that never hit fetch). Post-fix the pre-pass
    // skips the blocked member entirely, so ZERO fetches occur; pre-fix the
    // blocked member's URL would have been downloaded.
    const fixture = {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', brand: 'Blue Buffalo', primaryImage: 'https://img.example.com/b/primary.jpg', additionalImages: ['https://img.example.com/b/alt1.jpg'] }),
      '100000000003': promotableExtraction('100000000003', { _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
    };
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, fixture);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    const items = prepared.items;
    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    const fetchMock = mock(async () => { throw new Error('network blocked'); });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    try {
      const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
      // The blocked member is refused; its HTTP image URL was NEVER fetched
      // (the pre-pass skipped it before any download) — zero image side
      // effects for the refused item.
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].itemId).toBe(findItemById(items[1].id)!.id);
      expect(fetchMock.mock.calls.length).toBe(0);
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});

describe('PR11 C4 — a cohort child of a SUPERSEDED parent never promotes (parent_superseded)', () => {
  it('superseding the parent via the drift primitive leaves the member curationData intact and promotion refuses every child', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    const items = prepared.items;

    // The out-of-band straggler: the parent is superseded (drift primitive)
    // while the members keep their curation data and terminal child runs.
    expect(supersedeCohortRun(run.id, 'PR11 acceptance supersede')).toBe(true);
    expect(getCohortRunById(run.id)!.status).toBe('superseded');

    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.error).toContain('superseded');
      expect(failure.error).toContain(run.id);
    }
    for (const item of items) {
      expect(findItemById(item.id)!.stageStatus).toBe('failed');
    }
    expect(result.changeSetId).toBeNull();
  });
});

describe('PR11 C4 — stale proposals: an accepted type dependency whose target no longer matches the current effective type refuses; matching and universal proposals promote', () => {
  it('PR12 value-hash: a parent execution-authority mutation stales execution-stamped proposals EVEN with a matching reviewed type — and a member with NO reviewed type is REFUSED (reviewed_product_type_required, PR11 R2)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    const items = prepared.items;

    // The members' proposals were stamped with execution_product_type target
    // 'dog-food-dry'. Mutate the parent authority to 'dog-food-wet'.
    getDb().run(
      'UPDATE classification_cohort_runs SET execution_product_type_id = ? WHERE id = ?',
      ['dog-food-wet', run.id],
    );
    // Sanity: the stamped dependency rows still claim the ORIGINAL type.
    const flavorProposal = [...findItemById(items[0].id)!.curationData!.classificationProposals]
      .find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')!;
    const deps = listDependenciesForProposal(flavorProposal.id);
    expect(deps.some(d => d.dependencyKind === 'execution_product_type' && d.dependencyTargetId === 'dog-food-dry')).toBe(true);

    // PART 1 — PR12 value-hash invalidation (DECISION-A): the members'
    // execution-stamped proposals were stamped under the parent authority
    // {executionProductTypeId:'dog-food-dry', productTypeConfidence:0.9}.
    // The parent execution id mutated to 'dog-food-wet' — the CURRENT
    // authority value hash (recomputed from the parent run's current id +
    // confidence) no longer matches the stamped hash, so the proposals are
    // STALE even though the accepted reviewed type (dog-food-dry) still
    // matches the dependency target. The parent authority VALUE is the
    // truthful staleness key (PR12): a drifted id (or confidence) under the
    // same target id stales execution-stamped proposals. The reviewed-first
    // PASS authority stays covered by the coherent-fixture test below.
    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));
    const withReviewed = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(withReviewed.count).toBe(0);
    expect(withReviewed.failures).toHaveLength(3);
    for (const failure of withReviewed.failures) {
      expect(failure.error).toContain('value hash');
      expect(failure.error).toContain('execution_product_type');
      expect(failure.error).toContain('(execution)');
    }

    // PART 2 — a member with NO reviewed type (its PT proposal carries no
    // PART 2 — a member with NO reviewed type (its PT proposal carries no
    // accepted decision and the frozen snapshot has no reviewed fact):
    // Promotion REFUSES with reviewed_product_type_required — the Execution
    // Type is Curation-only authority and is NEVER a substitute at Promotion
    // (PR11 review R2).
    // Re-set the member to a fresh promotion attempt: strip the PT decision.
    for (const item of items) {
      const member = findItemById(item.id)!;
      const runId = member.curationData!.classificationRunId!;
      const ptProposal = getDb().query(
        "SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = 'primary_product_type'",
      ).get(runId) as { id: string } | undefined;
      if (ptProposal) {
        getDb().run('DELETE FROM classification_proposal_decisions WHERE proposal_id = ?', [ptProposal.id]);
        getDb().run("UPDATE classification_proposals SET status = 'pending' WHERE id = ?", [ptProposal.id]);
      }
    }
    const retry = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(retry.count).toBe(0);
    expect(retry.failures).toHaveLength(3);
    for (const failure of retry.failures) {
      expect(failure.error).toContain('Reviewed Product Type');
      expect(failure.error).toContain('Curation-only');
    }
    expect(retry.changeSetId).toBeNull();
  });

  it('a coherent active-cohort member promotes (matching dependency => draft created)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    const items = prepared.items;
    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(3);
    expect(result.changeSetId).not.toBeNull();
    for (const item of items) {
      const drafts = listChangeSetItems(result.changeSetId!).filter(ci => ci.sku === item.upc);
      expect(drafts).toHaveLength(1);
      expect(findItemById(item.id)!.stageStatus).toBe('completed');
    }
  });

  it('P1-A E2E (R1): a reviewer-REVISED primary_product_type beats the frozen execution type — execution-stamped deps become STALE and promotion refuses', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    const items = prepared.items;
    const member = findItemById(items[0].id)!;
    const runId = member.curationData!.classificationRunId!;

    // Accept every proposal, then REVISE the primary_product_type target to
    // wet-dog-food (the latest live decision wins — paired revisedTargetId,
    // exactly what proposal-review-service normalizes a reviewer correction
    // into).
    decideAllProposals(member);
    const ptProposal = getDb().query(
      "SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = 'primary_product_type'",
    ).get(runId) as { id: string } | undefined;
    expect(ptProposal).toBeTruthy();
    getDb().run(
      `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, decision_key, revised_target_id, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', ?, ?, 1, ?)`,
      [`c11-pt-revised-${runId}`, ptProposal!.id, `revised-key-${ptProposal!.id}`, 'dog-food-wet', new Date().toISOString()],
    );
    for (const item of items.slice(1)) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    // The member's execution-stamped flavor dependency claims dog-food-dry
    // while the reviewed authority is now dog-food-wet => STALE.
    const flavorProposal = [...findItemById(items[0].id)!.curationData!.classificationProposals]
      .find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')!;
    expect(listDependenciesForProposal(flavorProposal.id)
      .some(d => d.dependencyKind === 'execution_product_type' && d.dependencyTargetId === 'dog-food-dry')).toBe(true);

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    // The revised member refuses stale_proposal; the siblings (reviewed type
    // dry matching their execution-stamped deps) promote.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].itemId).toBe(findItemById(items[0].id)!.id);
    expect(result.failures[0].error).toContain('stale');
    expect(result.failures[0].error).toContain('execution_product_type');
    expect(result.failures[0].error).toContain('dog-food-dry');
    expect(result.count).toBe(2);
    expect(listChangeSetItems(result.changeSetId!)
      .filter(ci => ci.sku === '100000000001')).toHaveLength(0);
    expect(listChangeSetItems(result.changeSetId!)
      .filter(ci => ci.sku === '100000000002')).toHaveLength(1);
    expect(listChangeSetItems(result.changeSetId!)
      .filter(ci => ci.sku === '100000000003')).toHaveLength(1);
  });

  it('R2 E2E: a FROZEN-SNAPSHOT reviewed fact (wet) is the promotion authority — execution-stamped dry deps become STALE', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    const items = prepared.items;

    for (const item of items) decideAllProposals(findItemById(item.id)!);
    for (const item of items) {
      const member = findItemById(item.id)!;
      const runId = member.curationData!.classificationRunId!;
      // Remove the in-run accepted PT decision AFTER accepting everything (so
      // no accepted type decision exists in this run — the frozen snapshot
      // fact is then the ONLY reviewed authority).
      const ptProposal = getDb().query(
        "SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = 'primary_product_type'",
      ).get(runId) as { id: string } | undefined;
      if (ptProposal) {
        getDb().run('DELETE FROM classification_proposal_decisions WHERE proposal_id = ?', [ptProposal.id]);
        getDb().run("UPDATE classification_proposals SET status = 'pending' WHERE id = ?", [ptProposal.id]);
      }
      // Inject a provenance-compatible REVIEWED fact (wet) into the child's
      // frozen runtime snapshot — the PR5 second reviewed-authority source
      // that `getRuntimeSnapshotByHash` loads at promotion.
      const child = getDb().query(
        'SELECT config_snapshot_hash FROM classification_runs WHERE id = ?',
      ).get(runId) as { config_snapshot_hash: string | null };
      expect(child.config_snapshot_hash).not.toBeNull();
      const row = getDb().query(
        'SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
      ).get(workspaceId, child.config_snapshot_hash) as { config_json: string };
      const snapshot = JSON.parse(row.config_json) as Record<string, unknown>;
      snapshot.reviewedFacts = [{
        proposalId: `pt-${runId}`,
        decisionId: `dec-${runId}`,
        runId,
        workspaceId,
        productSku: member.upc,
        proposalType: 'primary_product_type',
        targetId: 'dog-food-wet',
        value: { productTypeId: 'dog-food-wet' },
      }];
      getDb().run(
        'UPDATE classification_config_snapshots SET config_json = ? WHERE workspace_id = ? AND snapshot_hash = ?',
        [JSON.stringify(snapshot), workspaceId, child.config_snapshot_hash],
      );
    }
    placeInPromotion(items.map(item => findItemById(item.id)!));

    // The reviewed authority is now wet (frozen fact); the members'
    // execution-stamped deps claim dry => STALE for every member.
    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.error).toContain('stale');
      expect(failure.error).toContain('execution_product_type');
      expect(failure.error).toContain('dog-food-wet');
    }
    expect(result.changeSetId).toBeNull();
  });

  it('R3 E2E: an EXPLICIT in-run REVIEW CLEAR (submitProposalDecisions revisedTargetId=null) suppresses the frozen reviewed fact — reviewed_product_type_required, zero drafts', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    const items = prepared.items;

    for (const item of items) {
      const member = findItemById(item.id)!;
      const runId = member.curationData!.classificationRunId!;
      // 1. Inject the OLD frozen reviewed fact (dry) into the child's runtime
      //    snapshot — the authority an in-run clear must suppress.
      const child = getDb().query(
        'SELECT config_snapshot_hash FROM classification_runs WHERE id = ?',
      ).get(runId) as { config_snapshot_hash: string | null };
      const row = getDb().query(
        'SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
      ).get(workspaceId, child.config_snapshot_hash) as { config_json: string };
      const snapshot = JSON.parse(row.config_json) as Record<string, unknown>;
      snapshot.reviewedFacts = [{
        proposalId: `old-pt-${runId}`,
        decisionId: `old-dec-${runId}`,
        runId,
        workspaceId,
        productSku: member.upc,
        proposalType: 'primary_product_type',
        targetId: 'dog-food-dry',
        value: { productTypeId: 'dog-food-dry' },
      }];
      getDb().run(
        'UPDATE classification_config_snapshots SET config_json = ? WHERE workspace_id = ? AND snapshot_hash = ?',
        [JSON.stringify(snapshot), workspaceId, child.config_snapshot_hash],
      );
      // 2. Accept every proposal (incl. the PT) via the normal path, then
      //    submit the REAL Review representation of an explicit clear: an
      //    accepted PT decision with revisedTargetId = null. The clear is the
      //    latest live decision and its PRESENCE is authoritative — the old
      //    frozen fact must NOT be resurrected.
      decideAllProposals(member);
      const ptProposal = getDb().query(
        "SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = 'primary_product_type'",
      ).get(runId) as { id: string };
      const existingDecision = getDb().query(
        'SELECT id FROM classification_proposal_decisions WHERE proposal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      ).get(ptProposal.id) as { id: string } | undefined;
      const cleared = submitProposalDecisions({
        workspaceId,
        productSku: member.upc,
        onboardingItemId: member.id,
        runId,
        sourceKind: 'onboarding',
        decisions: [{
          proposalId: ptProposal.id,
          decision: 'accepted',
          revisedTargetId: null,
          expectedRevisionId: existingDecision?.id ?? null,
        }],
      });
      expect(cleared.ok).toBe(true);
    }
    placeInPromotion(items.map(item => findItemById(item.id)!));

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.error).toContain('Reviewed Product Type');
    }
    expect(result.changeSetId).toBeNull();
  });

  it('a universal-attribute proposal (NO dependency row) is never stale and promotes', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE, BRAND_CONTROLLED_SEED);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    // The controlled `brand` attribute deterministically emits a field
    // assignment proposal carrying NO product-type dependency (PR9 C4).
    const memberOne = findItemById(prepared.items[0].id)!;
    const assignments = fieldAssignmentsByTarget(memberOne.curationData!);
    const brand = assignments.get('brand');
    expect(brand).toBeDefined();
    expect(listDependenciesForProposal(brand!.id)).toHaveLength(0);

    for (const item of prepared.items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(prepared.items.map(item => findItemById(item.id)!));

    const result = await promoteItems(workspaceId, wsPath, prepared.items[0].batchId, prepared.items.map(item => item.id));
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(3);
  });
});

describe('PR11 C4 — legacy / flag-OFF / shadow promotion is byte-identical (no gate)', () => {
  it('a legacy item (no run pointer) promotes unchanged — even a blocked semanticValidation key never triggers the gate', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    activateVerifiedPages(workspaceId);
    const batchId = createBatch({ workspaceId, name: 'Legacy Promotion', fileName: 'legacy-promo.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [{
      upc: 'LEGACY-PROMO-001',
      name: 'Legacy Promo Item',
      price: '$9.99',
      brandHint: 'Acme',
      rowNumber: 1,
    }]);
    const db = getDb();
    db.run(
      "UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', extraction_data_json = ?, curation_data_json = ? WHERE id = ?",
      [
        JSON.stringify(promotableExtraction('LEGACY-PROMO-001')),
        JSON.stringify({
          curatedTitle: 'Legacy Promo Item',
          titleSource: 'web',
          suggestedPages: [],
          suggestedProductType: null,
          curatedAt: new Date().toISOString(),
          curationMethod: 'auto',
          // A blocked semantic payload WITHOUT a run pointer is legacy input:
          // the gate passes it untouched (byte-identical legacy promotion).
          semanticValidation: {
            status: 'blocked',
            findings: [{ code: 'family_brand', memberSku: 'LEGACY-PROMO-001', message: 'legacy finding' }],
          },
        }),
        item.id,
      ],
    );
    // Embedded accepted page proposal (legacy input) with a verified identity.
    const legacyPageId = listVerifiedPageOptions(workspaceId)[0].id;
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({
        curatedTitle: 'Legacy Promo Item',
        titleSource: 'web',
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
        semanticValidation: {
          status: 'blocked',
          findings: [{ code: 'family_brand', memberSku: 'LEGACY-PROMO-001', message: 'legacy finding' }],
        },
        classificationProposals: [{
          id: 'legacy-promo-page',
          proposalType: 'category_page',
          targetId: 'Dog Food Dry',
          proposedValue: { pageId: legacyPageId, pageName: 'Dog Food Dry' },
          status: 'accepted',
        }],
      }), item.id],
    );

    seedPromotionApproval([item]);
    const result = await promoteItems(workspaceId, wsPath, batchId, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const drafts = listChangeSetItems(result.changeSetId!);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].sku).toBe('LEGACY-PROMO-001');
  });
});
