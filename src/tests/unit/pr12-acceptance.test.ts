/**
 * PR12 acceptance (issue #30, third test:db invocation group): the deferral
 * close-out — invalidation authority + promotion hygiene.
 *
 * Covers (per the PR12 architecture report, DECISION-A..D):
 *  1. Value-hash invalidation (DECISION-A): a parent execution-authority
 *     value drift (confidence under the same target id, or a reviewed-kind
 *     hash mismatch) stales execution/reviewed-stamped proposals at
 *     promotion, while the coherent target+hash-matching fixture passes.
 *  2. Promotion hygiene (DECISION-C): promoteItems is 3-phase — a blocked
 *     item produces ZERO image fetches and zero change-set rows; a parent
 *     superseded BETWEEN the (a) pre-pass and the (c) final gate is refused
 *     in (c) with zero drafts (images may have been downloaded, but the item
 *     never drafts); healthy items promote with exactly-once downloads.
 *  3. Registry-version fail-closed (DECISION-B): a run snapshot frozen under
 *     an older operation-registry version refuses run-bound calls
 *     (registry_version_mismatch).
 *  4. Shadow OCR non-authority (DECISION-D): a shadow-mode freeze leaves no
 *     reusable OCR authority (no ocrExecutionDigest / ocrInputHash writes, no
 *     model calls).
 *
 * Harness mirrors pr11-acceptance.test.ts (fresh per-test DBs, the active v2
 * bundle, the llm-client mock). pr8–pr11 acceptance suites stay green as the
 * frozen regression for the gate semantics PR12 refines.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { initDb, getDb, closeDb } from '../../db/connection';
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
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import { getRuntimeSnapshotByHash, requireModelCallContext } from '../../classification/runtime-snapshot';
import {
  computeExecutionAuthorityHash,
  computeReviewedAuthorityHash,
} from '../../classification/promotion-gate';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import { MODEL_OPERATION_REGISTRY_VERSION } from '../../classification/model-operation-registry';
import type { CohortRun, CurationCohort } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';

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

/** The group response: every SKU in the prompt assigned to a FROZEN page. */
function cannedGroupResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const skus = [...prompt.matchAll(/^SKU (\d{10,})$/gm)].map(match => match[1]);
  const payload: Record<string, unknown> = {};
  for (const sku of skus) {
    const evenSku = Number(sku.slice(-2)) % 2 === 0;
    const page = pages.find(page => page.name === (evenSku ? PAGE_NAMES[3] : PAGE_NAMES[0]));
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
let tinyJpeg: Buffer;
const tempPaths: string[] = [];

beforeAll(async () => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr12-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  // A 2x2 white JPEG the draft promoter's sharp pipeline can decode — used by
  // the fetch mock so healthy image downloads complete deterministically.
  tinyJpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).jpeg().toBuffer();
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
 *  image (no network fetch in the draft promoter unless overridden), and no
 *  additional URLs. */
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR12 Acceptance Batch', fileName: 'pr12.xlsx', totalItems: itemsData.length }).id;
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

function activateVerifiedPages(wsId: string): void {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-treats', name: 'Dog Treats' },
    { key: 'dog-food', name: 'Dog Food' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr12-acceptance-pages'),
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
      [`pr12-decision-${proposal.id}`, proposal.id, `key-${proposal.id}`, now],
    );
    getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', ['accepted', proposal.id]);
  }
}

/** Move completed curation members straight to the promotion stage. */
function placeInPromotion(items: OnboardingItem[]): void {
  for (const item of items) {
    getDb().run(
      "UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending' WHERE id = ?",
      [item.id],
    );
  }
  // Epic #46 review round-2: durable review + approval now required before an
  // export draft (final transactional authority). Seed so these gate tests hit
  // their INTENDED gate, not the approval gate.
  seedPromotionApproval(items);
}

/** Run the coherent cohort end-to-end to a promotion-ready state. */
async function promoteReadyCoherent(
  wsId: string,
  wsPath: string,
  extByUpc: Record<string, Record<string, any>>,
): Promise<{ prepared: ReturnType<typeof prepareActiveV2Workspace>; run: CohortRun; items: OnboardingItem[] }> {
  const prepared = prepareActiveV2Workspace(wsId, wsPath, extByUpc);
  const run = await freezeActiveCohort(wsId, wsPath);
  const summary = await executeViaSeam(wsPath, wsId, run.id, 'worker-a');
  expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
  const items = prepared.items;
  for (const item of items) decideAllProposals(findItemById(item.id)!);
  placeInPromotion(items.map(item => findItemById(item.id)!));
  return { prepared, run, items };
}

// ─── PR12 C6: value-hash invalidation (DECISION-A) ───────────────────────────

describe('PR12 C6 — value-hash invalidation (issue #30, DECISION-A)', () => {
  it('coherent fixture passes: target AND execution value-hash match', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await promoteReadyCoherent(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(3);
    expect(result.changeSetId).not.toBeNull();
    for (const item of items) {
      expect(listChangeSetItems(result.changeSetId!).filter(ci => ci.sku === item.upc)).toHaveLength(1);
      expect(findItemById(item.id)!.stageStatus).toBe('completed');
    }
  });

  it('a parent product_type_confidence drift (SAME target id) stales execution-stamped proposals', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { run, items } = await promoteReadyCoherent(workspaceId, wsPath, COHERENT_PROMOTABLE);
    expect(run.executionProductTypeId).toBe('dog-food-dry');
    // The members' execution-stamped value hash was frozen under the ORIGINAL
    // confidence. Drift the CURRENT parent confidence while KEEPING the target
    // id — the recomputed authority hash no longer matches the stamped hash.
    const parentBefore = getCohortRunById(run.id)!;
    expect(parentBefore.productTypeConfidence).not.toBeNull();
    getDb().run(
      'UPDATE classification_cohort_runs SET product_type_confidence = ? WHERE id = ?',
      [parentBefore.productTypeConfidence! + 0.01, run.id],
    );
    const currentHash = computeExecutionAuthorityHash(
      'dog-food-dry',
      getCohortRunById(run.id)!.productTypeConfidence,
    );
    const flavorProposal = [...findItemById(items[0].id)!.curationData!.classificationProposals]
      .find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')!;
    const deps = getDb().query(
      'SELECT dependency_value_hash FROM classification_proposal_dependencies WHERE proposal_id = ? AND dependency_kind = ?',
    ).all(flavorProposal.id, 'execution_product_type') as Array<{ dependency_value_hash: string }>;
    expect(deps).toHaveLength(1);
    expect(deps[0].dependency_value_hash).not.toBe(currentHash);

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.error).toContain('value hash');
      expect(failure.error).toContain('execution_product_type');
      expect(failure.error).toContain('(execution)');
    }
    expect(result.changeSetId).toBeNull();
    for (const item of items) {
      expect(findItemById(item.id)!.stageStatus).toBe('failed');
    }
  });

  it('a reviewed-kind dependency hash mismatch (target still matches) stales', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = await promoteReadyCoherent(workspaceId, wsPath, COHERENT_PROMOTABLE);
    // The members carry execution-kind rows stamped under the parent execution
    // authority. Rewrite them into reviewed-kind rows whose STAMPED hash was
    // computed under a DIFFERENT reviewed authority ('dog-food-wet') while the
    // target stays the accepted reviewed type ('dog-food-dry') — the reviewed
    // target still matches, only the VALUE drifted.
    const reviewedId = 'dog-food-dry';
    const wrongReviewedHash = computeReviewedAuthorityHash('dog-food-wet')!;
    const rows = getDb().query(
      `SELECT id FROM classification_proposal_dependencies WHERE dependency_kind = 'execution_product_type'`,
    ).all() as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      getDb().run(
        `UPDATE classification_proposal_dependencies
         SET dependency_kind = 'reviewed_product_type', dependency_target_id = ?, dependency_value_hash = ?
         WHERE id = ?`,
        [reviewedId, wrongReviewedHash, row.id],
      );
    }

    const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.error).toContain('value hash');
      expect(failure.error).toContain('reviewed_product_type');
      expect(failure.error).toContain('(reviewed)');
    }
    expect(result.changeSetId).toBeNull();
  });
});

// ─── PR12 C6: promotion hygiene — 3-phase promoteItems (DECISION-C) ──────────

describe('PR12 C6 — promotion hygiene: 3-phase promoteItems (issue #30, DECISION-C)', () => {
  it('a blocked member produces ZERO image fetches and zero change-set rows; siblings promote', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Only the BLOCKED member carries HTTP image URLs (the siblings use
    // relative paths that never hit fetch). Phase (a) refuses the blocked
    // member BEFORE any download, so ZERO fetches occur.
    const fixture = {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', brand: 'Blue Buffalo', primaryImage: 'https://img.example.com/b/primary.jpg' }),
      '100000000003': promotableExtraction('100000000003', { _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
    };
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, fixture);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    const items = prepared.items;
    const blockedMember = findItemById(items[1].id)!;
    expect(blockedMember.curationData!.semanticValidation!.status).toBe('blocked');

    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    const fetchMock = mock(async () => { throw new Error('network blocked'); });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    try {
      const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
      expect(result.count).toBe(2);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].itemId).toBe(blockedMember.id);
      expect(fetchMock.mock.calls.length).toBe(0);
      // ZERO change-set rows for the refused member; drafts for both siblings.
      expect(listChangeSetItems(result.changeSetId!)
        .filter(ci => ci.sku === '100000000002')).toHaveLength(0);
      expect(listChangeSetItems(result.changeSetId!)
        .filter(ci => ci.sku === '100000000001')).toHaveLength(1);
      expect(listChangeSetItems(result.changeSetId!)
        .filter(ci => ci.sku === '100000000003')).toHaveLength(1);
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  it('a parent superseded BETWEEN the (a) pre-pass and the (c) final gate => refused in (c), zero change-set rows (images were already downloaded)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Every member carries an HTTP image URL so phase (b) downloads them. The
    // fetch mock supersedes the parent on the FIRST download — i.e. after the
    // (a) pre-pass passed every item but before the (c) transaction re-runs
    // the gate. The final gate then refuses EVERY child (parent_superseded)
    // with zero change-set rows; the images were downloaded exactly once
    // (the residual (b)→(c) race — the item still never drafts).
    const fixture = {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', primaryImage: 'https://img.example.com/a/primary.jpg' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', primaryImage: 'https://img.example.com/b/primary.jpg' }),
      '100000000003': promotableExtraction('100000000003', { _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', primaryImage: 'https://img.example.com/c/primary.jpg' }),
    };
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, fixture);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    const items = prepared.items;
    for (const item of items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(items.map(item => findItemById(item.id)!));

    let superseded = false;
    const fetchMock = mock(async () => {
      if (!superseded) {
        superseded = true;
        expect(supersedeCohortRun(run.id, 'PR12 TOCTOU supersede')).toBe(true);
      }
      return new Response(new Uint8Array(tinyJpeg), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const changeSetRowsBefore = getDb().query(
      'SELECT COUNT(*) AS c FROM change_set_items',
    ).get() as { c: number };
    try {
      const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
      // Phase (b) downloaded every passed item exactly once (3 HTTP URLs).
      expect(fetchMock.mock.calls.length).toBe(3);
      // Phase (c) re-ran the gate as the FINAL authority and refused every
      // child (the parent is now superseded) — zero drafts.
      expect(result.count).toBe(0);
      expect(result.failures).toHaveLength(3);
      for (const failure of result.failures) {
        expect(failure.error).toContain('superseded');
        expect(failure.error).toContain(run.id);
      }
      expect(result.changeSetId).toBeNull();
      // ZERO change-set rows were added by this promotion (delta-scoped — the
      // shared DB may hold rows from earlier tests in this file).
      const changeSetRowsAfter = getDb().query(
        'SELECT COUNT(*) AS c FROM change_set_items',
      ).get() as { c: number };
      expect(Number(changeSetRowsAfter.c)).toBe(Number(changeSetRowsBefore.c));
      for (const item of items) {
        expect(findItemById(item.id)!.stageStatus).toBe('failed');
      }
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  it('healthy items promote with EXACTLY-ONCE image downloads', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const fixture = {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', primaryImage: 'https://img.example.com/a/primary.jpg' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', primaryImage: 'https://img.example.com/b/primary.jpg' }),
    };
    const { items } = await promoteReadyCoherent(workspaceId, wsPath, fixture);

    const fetchMock = mock(async () =>
      new Response(new Uint8Array(tinyJpeg), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    try {
      const result = await promoteItems(workspaceId, wsPath, items[0].batchId, items.map(item => item.id));
      // Exactly one download per HTTP image URL — each healthy item's image
      // is fetched exactly once across the whole 3-phase flow.
      expect(fetchMock.mock.calls.length).toBe(2);
      expect(result.failures).toHaveLength(0);
      expect(result.count).toBe(2);
      for (const item of items) {
        expect(listChangeSetItems(result.changeSetId!).filter(ci => ci.sku === item.upc)).toHaveLength(1);
      }
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});

// ─── PR12 C6: registry-version fail-closed (DECISION-B) ──────────────────────

describe('PR12 C6 — registry-version fail-closed (issue #30, DECISION-B)', () => {
  it('a member snapshot frozen under registry v1 refuses run-bound calls (registry_version_mismatch)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    const child = getDb().query(
      'SELECT id, config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? LIMIT 1',
    ).get(run.id) as { id: string; config_snapshot_hash: string | null };
    expect(child.config_snapshot_hash).not.toBeNull();

    // Simulate a snapshot frozen under an OLDER operation registry: flip the
    // frozen plan's registryVersion to 1 and recompute its digest so the
    // integrity check still passes — the registry-version guard is the only
    // thing that trips.
    const row = getDb().query(
      'SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
    ).get(workspaceId, child.config_snapshot_hash) as { config_json: string };
    const snapshot = JSON.parse(row.config_json) as {
      modelExecutionPlan: { version: number; registryVersion: number; entries: unknown[]; digest?: string };
    };
    // P3: registry bumped 2 → 3 (value_gap_resolution); pin to the live constant.
    expect(snapshot.modelExecutionPlan.registryVersion).toBe(MODEL_OPERATION_REGISTRY_VERSION);
    snapshot.modelExecutionPlan.registryVersion = 1;
    snapshot.modelExecutionPlan = {
      ...snapshot.modelExecutionPlan,
      digest: hashCanonicalJson({
        version: snapshot.modelExecutionPlan.version,
        registryVersion: snapshot.modelExecutionPlan.registryVersion,
        entries: snapshot.modelExecutionPlan.entries,
      }),
    };
    getDb().run(
      'UPDATE classification_config_snapshots SET config_json = ? WHERE workspace_id = ? AND snapshot_hash = ?',
      [JSON.stringify(snapshot), workspaceId, child.config_snapshot_hash],
    );

    const loaded = getRuntimeSnapshotByHash(workspaceId, child.config_snapshot_hash!);
    expect(loaded).not.toBeNull();
    expect(() => requireModelCallContext(loaded, child.id, 'evidence_extraction', 1))
      .toThrow(/registry_version_mismatch/);
    expect(() => requireModelCallContext(loaded, child.id, 'product_type_ranking', 1))
      .toThrow(/registry_version_mismatch/);
  });
});

// ─── PR12 C6: shadow-mode OCR is never a reusable authority (DECISION-D) ─────

describe('PR12 C6 — shadow-mode OCR is never a reusable authority (issue #30, DECISION-D)', () => {
  it('a shadow-mode freeze leaves no reusable OCR authority markers and makes no model calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    // Unsettle OCR: drop the input-set + execution-authority markers so the
    // freeze's OCR pull-forward WOULD normally re-run OCR under the current
    // authority (its write-back is exactly the reusable authority PR12 C5
    // forbids in shadow mode).
    for (const item of prepared.items) {
      const ext = item.extractionData ? { ...(item.extractionData as Record<string, unknown>) } : {};
      delete ext.ocrInputHash;
      delete ext.ocrExecutionDigest;
      updateItemExtractionData(item.id, JSON.stringify(ext));
    }

    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });
    const modelCallsBefore = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_model_calls',
    ).get() as { c: number };
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(frozen.status).toBe('running');

    // NO reusable OCR authority was written: neither the execution-authority
    // digest nor the input-set marker appeared in any member's extraction
    // data, and the freeze made ZERO model calls (delta-scoped — the shared
    // DB may hold model-call rows from earlier tests in this file).
    for (const item of prepared.items) {
      const stored = getDb().query(
        'SELECT extraction_data_json FROM onboarding_items WHERE id = ?',
      ).get(item.id) as { extraction_data_json: string };
      const ext = JSON.parse(stored.extraction_data_json) as Record<string, unknown>;
      expect(ext.ocrExecutionDigest).toBeUndefined();
      expect(ext.ocrInputHash).toBeUndefined();
    }
    const modelCallsAfter = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_model_calls',
    ).get() as { c: number };
    expect(Number(modelCallsAfter.c)).toBe(Number(modelCallsBefore.c));
  });
});
