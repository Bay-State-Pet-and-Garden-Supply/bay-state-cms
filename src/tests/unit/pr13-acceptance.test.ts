/**
 * PR13 acceptance (issue #30, third test:db invocation group): authority
 * economics + polish.
 *
 * Covers (per the PR13 architecture report, DECISION-A..D):
 *  1. T-hash scoping (DECISION-C): only the broad policy digest changing
 *     leaves the T-hash UNCHANGED; the operation-specific plan entry
 *     (provider/model/promptTemplateVersion/ruleVersion) still participates.
 *  2. Cross-parent same-T-hash reuse (DECISION-A/B) END-TO-END: revision A
 *     coordinates (one title call) → the reviewer re-run supersedes A and
 *     resets the members → revision B with the SAME frozen authority makes
 *     ZERO title calls, writes fresh rows with the SAME values and the
 *     ORIGINAL (OLD) model-call ids, members commit consuming B's copied
 *     titles byte-identically, and promotion passes under the NEW cohort run
 *     (the cohort-coordinated output-linkage exemption resolves the
 *     parent-op-bound call ids). Authority-mutated B and an incomplete old
 *     set both coordinate fresh.
 *  3. H4 conflict-reason wording (DECISION-D): the distinct/reviewed
 *     SUMMARIES render `id (Label)` from the frozen snapshot's productTypes;
 *     unknown ids render id-only; member detail lines keep the raw ids.
 *  4. The two PR12-close P2 edges: the expected-OCR-digest predicate literal
 *     contract (a supplied NULL expected digest rejects OCR entirely — never
 *     matches a stored null) and the v1 shadow-OCR false-negative
 *     documentation (module JSDoc + ADR).
 *
 * Harness mirrors pr12-acceptance.test.ts (fresh per-test DBs, the active v2
 * bundle, the llm-client mock). The mock returns REAL canned titles for
 * `cohort_title_consolidation` (so rows carry `llm_cohort` + call ids to
 * preserve) and canned page assignments for the parent page op, counting both
 * so the cross-parent zero-call claim is measurable.
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
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  computeMembershipHash,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortSnapshotByHash,
  rerunIdleCohortRevision,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { getCohortTitleOutputsByRun } from '../../db/repositories/classification-cohort-output-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
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
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  getRuntimeSnapshotByHash,
  getModelExecutionPlanEntry,
} from '../../classification/runtime-snapshot';
import {
  computeCohortTitleInputHash,
} from '../../onboarding/cohort-curation/titles';
import { titleExecutionTypeAuthorityFromRun } from '../../classification/cohort-decision-authority';
import { evidenceFromProjection } from '../../classification/cohort-product-type-resolver';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { parseExecutionEvidenceProjection } from '../../shared/schemas/cohorts';
import type { CohortRun, CurationCohort, ExecutionEvidenceProjectionV2 } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';

// ─── llm-client mock (counting; production audit semantics) ───────────────────

let titleCallCount = 0;
let pageCallCount = 0;
let auditCallSeq = 0;

// Even-SKU members land on the generic 'Dog Food' category: the deterministic
// P5 guards reject treat-only/brand-only primary pages for dry-food products,
// and an abstained durable page decision can never pass the review gate.
const PAGE_NAMES = ['Dog Food Dry', 'Dog Treats', 'Brand - Acme', 'Dog Food'];

// Lint-clean + family-consistent: NOT a punctuation/case echo of the raw names
// (B1 spreadsheet_fallback_leak), carries the fixtures' brandHint 'Acme' exactly
// once per title (T3), and uses R1-normalized weight forms ('5 lb.') so the
// titles round-trip the lint unchanged — otherwise coordination deterministically
// falls back, producing rows with NULL model_call_id.
const CANNED_TITLES: Record<string, string> = {
  '100000000001': 'Acme Purina Pro Plan Dog Food Chicken Recipe 5 lb.',
  '100000000002': 'Acme Purina Pro Plan Dog Food Beef Recipe 10 lb.',
  '100000000003': 'Acme Purina Pro Plan Dog Food Salmon Recipe 5 lb.',
};

function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

/** Extract the exact UPC set from a cohort title prompt and return matching
 *  canned titles (each group prompt carries only its group's UPCs). */
function cannedTitleResponseForPrompt(prompt: string): string {
  const upcs = [...prompt.matchAll(/\[(\d{10,})\]/g)].map(match => match[1]);
  const payload: Record<string, string> = {};
  for (const upc of upcs) payload[upc] = CANNED_TITLES[upc] ?? `Purina Pro Plan Dog Food ${upc}`;
  return JSON.stringify(payload);
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

/** Simulate the audited transport's durable started + success rows. */
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
    titleCallCount++;
    if (options.modelCall) writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
    return {
      content: cannedTitleResponseForPrompt(prompt),
      callId,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  if (operation === 'cohort_page_assignment_parent') {
    pageCallCount++;
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

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr13-acceptance-${randomUUID().slice(0, 8)}`);
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
  pageCallCount = 0;
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

/** Cohort member fixture that is PROMOTION-ready: a price and a relative
 *  primary image (no network fetch in the draft promoter). */
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR13 Acceptance Batch', fileName: 'pr13.xlsx', totalItems: itemsData.length }).id;
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
  // Reuse the pr12 harness's page activation: import + verify records.
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr13-acceptance-pages'),
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
async function freezeActiveCohort(wsId: string, wsPath: string): Promise<CohortRun> {
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
  const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, wsId);
  expect(finalized.status).toBe('running');
  return finalized;
}

/** Parse the run's frozen execution-evidence projection from its snapshot. */
function loadProjection(wsId: string, run: CohortRun): ExecutionEvidenceProjectionV2 {
  const snap = getCohortSnapshotByHash(wsId, run.evidenceSnapshotHash!)!;
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
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
      [`pr13-decision-${proposal.id}`, proposal.id, `key-${proposal.id}`, now],
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

/** Seed a compatible reviewed Primary Product Type decision (mirrors the
 *  cohort-freeze harness): the freeze's snapshot build collects it as a
 *  provenance-compatible reviewed fact, so the cohort resolver sees it. The
 *  run's `config_snapshot_hash` is the ACTIVE v2 bundle hash (== the
 *  authority's `bundle.manifest.bundleHash`) so `factConfigIsCompatible`
 *  accepts the fact. */
function seedReviewedTypeDecision(wsId: string, sku: string, itemId: string, typeId: string, configSnapshotHash: string): void {
  const now = new Date().toISOString();
  const runId = `prior-type-run-${itemId}`;
  const proposalId = `prior-type-proposal-${itemId}`;
  getDb().run(
    `INSERT INTO classification_runs
     (id, workspace_id, onboarding_item_id, product_sku, source_kind, config_snapshot_hash, status, started_at)
     VALUES (?, ?, ?, ?, 'onboarding', ?, 'completed', ?)`,
    [runId, wsId, itemId, sku, configSnapshotHash, now],
  );
  getDb().run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'primary_product_type', ?, ?, 0.95, 'accepted', ?)`,
    [proposalId, runId, sku, typeId, JSON.stringify({ productTypeId: typeId }), now],
  );
  getDb().run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
     VALUES (?, ?, 'accepted', ?, ?, ?, NULL)`,
    [`prior-type-decision-${itemId}`, proposalId, JSON.stringify({ productTypeId: typeId }), typeId, now],
  );
}

// ─── T-hash authority scoping (DECISION-C) ────────────────────────────────────

describe('PR13 C5 — title authority scoping (issue #30, DECISION-C)', () => {
  it('only the broad policy digest differs → the T-hash is UNCHANGED; provider/model/versions still participate', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const projection = loadProjection(workspaceId, run);
    const ordered = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
    const child = getDb().query(
      'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string };
    const snapshot = getRuntimeSnapshotByHash(workspaceId, child.config_snapshot_hash)!;
    const planEntry = getModelExecutionPlanEntry(snapshot, 'cohort_title_consolidation') ?? undefined;
    const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(run, snapshot);
    const base = computeCohortTitleInputHash({
      run,
      projection,
      titlePlanEntry: planEntry,
      executionTypeAuthority,
    });
    // The pipeline-built authority participates: mutating the SAME
    // execution-type authority object's LABEL (the canonical title authority
    // source) changes the hash — the composition is live, not inert.
    expect(computeCohortTitleInputHash({
      run,
      projection,
      titlePlanEntry: planEntry,
      executionTypeAuthority: { ...executionTypeAuthority, label: 'Different Label' },
    })).not.toBe(base);
    // Replay determinism: the SAME frozen authority recomputed yields the
    // identical hash (the coordinator's reuse check depends on this).
    expect(computeCohortTitleInputHash({
      run,
      projection,
      titlePlanEntry: planEntry,
      executionTypeAuthority,
    })).toBe(base);
    expect(computeCohortTitleInputHash({
      run,
      projection,
      titlePlanEntry: { ...(planEntry as NonNullable<typeof planEntry>), provider: 'openai', model: 'gpt-4o-mini' },
      executionTypeAuthority,
    })).not.toBe(base);
    expect(computeCohortTitleInputHash({
      run,
      projection,
      titlePlanEntry: { ...(planEntry as NonNullable<typeof planEntry>), promptTemplateVersion: 'cohort-title-consolidation-prompt-v2' },
      executionTypeAuthority,
    })).not.toBe(base);
    expect(computeCohortTitleInputHash({
      run,
      projection,
      // RULE_VERSIONS.cohort_title_consolidation is currently '-rules-v2'
      // (B1 family-title consistency bump) — override to v3 so the value
      // genuinely differs from the frozen authority.
      titlePlanEntry: { ...(planEntry as NonNullable<typeof planEntry>), ruleVersion: 'cohort-title-consolidation-rules-v3' },
      executionTypeAuthority,
    })).not.toBe(base);
  });
});

// ─── Cross-parent same-T-hash reuse E2E (DECISION-A/B) ───────────────────────

describe('PR13 C5 — cross-parent same-T-hash reuse E2E (issue #30, DECISION-A/B)', () => {
  it('A coordinates (one call) → supersede → revision B SAME authority: ZERO title calls, fresh rows, same values, OLD call ids preserved, members commit byte-identically, promotion passes under the new cohort run', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);

    // Revision A: one title call; members commit consuming A's titles.
    const runA = await freezeActiveCohort(workspaceId, wsPath);
    const summaryA = await executeViaSeam(wsPath, workspaceId, runA.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summaryA.parentStatus);
    expect(titleCallCount).toBe(1);
    expect(pageCallCount).toBe(1); // one parent page call for the group
    const titleRowsA = getCohortTitleOutputsByRun(runA.id);
    expect(titleRowsA).toHaveLength(3);
    const oldTitleCallIds = [...new Set(titleRowsA.map(r => r.modelCallId))];
    expect(oldTitleCallIds.length).toBe(1); // one group → one producing call
    const curatedTitlesA = prepared.items.map(item => findItemById(item.id)!.curationData!.curatedTitle);

    // Reviewer re-run: supersede A + reset the EXACT members atomically.
    const rerun = rerunIdleCohortRevision(prepared.cohorts[0].id, runA.id, 'PR13 C5 re-run');
    expect(rerun.superseded).toBe(true);
    expect(rerun.resetMemberCount).toBe(3);

    // Revision B: claim + freeze + processCohort.
    const [runB] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalizedB = await freezeCohortForExecution(runB, wsPath, workspaceId);
    expect(finalizedB.status).toBe('running');
    titleCallCount = 0;
    // PR13 review R1 (T1): ZERO title-op calls is proven at the TABLE level
    // too — the mock transport counter could be bypassed, the audit rows
    // cannot. Member-level consolidation calls ARE expected (each member
    // still runs its own name-consolidation with the coordinated title as
    // context); the PARENT `cohort_title_consolidation` op must not fire.
    const titleOpsBeforeB = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_model_calls WHERE operation = 'cohort_title_consolidation'",
    ).get() as { cnt: number };
    const summaryB = await executeViaSeam(wsPath, workspaceId, finalizedB.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summaryB.parentStatus);
    // Cross-parent same-T-hash reuse: ZERO title calls.
    expect(titleCallCount).toBe(0);
    const titleOpsAfterB = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_model_calls WHERE operation = 'cohort_title_consolidation'",
    ).get() as { cnt: number };
    expect(Number(titleOpsAfterB.cnt)).toBe(Number(titleOpsBeforeB.cnt));
    // DECISION-A: titles only — pages are NOT cross-parent-reused, so revision
    // B coordinates its own fresh page set (one additional page call).
    expect(pageCallCount).toBe(2);

    // Fresh write-once rows under B with the SAME values + the ORIGINAL (OLD)
    // producing call ids preserved (DECISION-B) — the old rows stay untouched.
    const titleRowsB = getCohortTitleOutputsByRun(finalizedB.id);
    expect(titleRowsB).toHaveLength(3);
    expect(titleRowsB.map(r => JSON.parse(r.outputValueJson))).toEqual(titleRowsA.map(r => JSON.parse(r.outputValueJson)));
    expect(titleRowsB.map(r => r.modelCallId).sort()).toEqual(titleRowsA.map(r => r.modelCallId).sort());
    expect(titleRowsB.every(r => r.modelCallId !== null)).toBe(true);
    expect(getCohortTitleOutputsByRun(runA.id)).toEqual(titleRowsA);
    // The OLD call ids remain REAL terminal-success audited calls (truthful
    // provenance — the C6b linkage can still resolve them).
    for (const callId of oldTitleCallIds) {
      const call = getDb().query('SELECT status FROM classification_model_calls WHERE id = ?').get(callId) as { status: string };
      expect(call).toBeTruthy();
      expect(call.status).toBe('success');
    }

    // Members commit consuming B's copied titles byte-identically.
    const curatedTitlesB = prepared.items.map(item => findItemById(item.id)!.curationData!.curatedTitle);
    expect(curatedTitlesB).toEqual(curatedTitlesA);
    expect(curatedTitlesB.every(title => typeof title === 'string' && title.length > 0)).toBe(true);

    // Promotion under the NEW cohort run B: the gate passes (the member
    // proposals carry the parent-op-bound page call id of B's ordinal-0
    // child; the cohort-coordinated output-linkage exemption resolves it
    // under the new cohort run).
    for (const item of prepared.items) decideAllProposals(findItemById(item.id)!);
    placeInPromotion(prepared.items.map(item => findItemById(item.id)!));
    const result = await promoteItems(workspaceId, wsPath, prepared.items[0].batchId, prepared.items.map(item => item.id));
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(3);
    expect(result.changeSetId).not.toBeNull();
  });

  it('authority-mutated revision B coordinates FRESH (the superseded set no longer matches)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const runA = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, runA.id, 'worker-a');
    expect(titleCallCount).toBe(1);

    // Mutate one member's frozen title evidence BEFORE the re-run → B's
    // frozen projection (and therefore the T-hash) changes.
    const item = prepared.items.find(i => i.upc === '100000000001')!;
    const ext = item.extractionData ? { ...(item.extractionData as Record<string, unknown>) } : {};
    ext.title = 'Changed Web Title';
    updateItemExtractionData(item.id, JSON.stringify(ext));

    rerunIdleCohortRevision(prepared.cohorts[0].id, runA.id, 'PR13 C5 re-run (mutated authority)');
    const [runB] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalizedB = await freezeCohortForExecution(runB, wsPath, workspaceId);
    expect(finalizedB.status).toBe('running');
    titleCallCount = 0;
    const summaryB = await executeViaSeam(wsPath, workspaceId, finalizedB.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summaryB.parentStatus);
    // A DIFFERENT T-hash → no copy → fresh coordinate (exactly one call).
    expect(titleCallCount).toBe(1);
    const titleRowsB = getCohortTitleOutputsByRun(finalizedB.id);
    expect(titleRowsB).toHaveLength(3);
  });

  it('an INCOMPLETE superseded set (missing row) → no reuse, revision B coordinates fresh', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, COHERENT_PROMOTABLE);
    const runA = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, runA.id, 'worker-a');
    expect(titleCallCount).toBe(1);

    // Simulate a partial old set (only possible via an illegal direct DELETE).
    getDb().run(
      "DELETE FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000001'",
      [runA.id],
    );
    expect(getCohortTitleOutputsByRun(runA.id)).toHaveLength(2);

    rerunIdleCohortRevision(prepared.cohorts[0].id, runA.id, 'PR13 C5 re-run (incomplete set)');
    const [runB] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalizedB = await freezeCohortForExecution(runB, wsPath, workspaceId);
    expect(finalizedB.status).toBe('running');
    titleCallCount = 0;
    const summaryB = await executeViaSeam(wsPath, workspaceId, finalizedB.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summaryB.parentStatus);
    // EXACT-SET completeness failed on the old set → fresh coordinate.
    expect(titleCallCount).toBe(1);
    expect(getCohortTitleOutputsByRun(finalizedB.id)).toHaveLength(3);
  });
});

// ─── H4 conflict-reason wording (DECISION-D) ──────────────────────────────────

describe('PR13 C5 — H4 conflict-reason labels (issue #30, DECISION-D)', () => {
  it('a conflicted freeze reason renders `id (Label)` for configured types and stays deterministic', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Wet Dog Food Beef 10 lb', _brandHint: 'Acme' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('failed');
    expect(finalized.productTypeOutcome).toBe('conflicted');
    expect(finalized.errorMessage).toContain('cohort_product_type_conflict');
    // The distinct summary renders the configured labels beside the ids.
    expect(finalized.errorMessage).toContain('dog-food-dry (Dry Dog Food)');
    expect(finalized.errorMessage).toContain('dog-food-wet (Wet Dog Food)');
    // Member detail lines keep the RAW ids (deterministic machine-readable).
    expect(finalized.errorMessage).toMatch(/ -> dog-food-(dry|wet)@/);
    // Deterministic STRUCTURE: members sort by onboardingItemId (never input
    // order), distinct ids sort, and labels resolve identically — assert the
    // ordering + composition, not the run-scoped item UUIDs (fresh per
    // workspace, so byte-equality across workspaces is impossible by design).
    const memberLines = finalized.errorMessage!.match(/members: (.+); no execution type written/)?.[1]?.split('; ') ?? [];
    expect(memberLines.length).toBe(2);
    const memberIds = memberLines.map(line => line.split(' ')[0]);
    expect(memberIds).toEqual([...memberIds].sort((a, b) => a.localeCompare(b)));
    expect(finalized.errorMessage).toContain('2 distinct confident Product Types');
  });

  it('an UNKNOWN type id renders id-only (no label) — the label lookup never invents one', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
    });
    // A reviewed type NOT present in the frozen snapshot's productTypes: the
    // reviewed-vs-inference conflict reason must render it id-only.
    seedReviewedTypeDecision(workspaceId, '100000000001', prepared.items[0].id, 'mystery-type', prepared.configSnapshotHash);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('failed');
    expect(finalized.productTypeOutcome).toBe('conflicted');
    expect(finalized.errorMessage).toContain('mystery-type');
    expect(finalized.errorMessage).not.toContain('mystery-type (');
    // The configured id still renders its label.
    expect(finalized.errorMessage).toContain('dog-food-dry (Dry Dog Food)');
  });

  it('a re-freeze of the SAME cohort revision repeats the conflict reason BYTE-IDENTICALLY (deterministic wording, PR13 review R1)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': promotableExtraction('100000000001', { _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
      '100000000002': promotableExtraction('100000000002', { _name: 'Purina Pro Plan Wet Dog Food Beef 10 lb', _brandHint: 'Acme' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const first = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(first.status).toBe('failed');
    expect(first.productTypeOutcome).toBe('conflicted');
    // Same cohort + same frozen authority → the NEW revision repeats the
    // reason text exactly (same member item ids, same resolved types).
    rerunIdleCohortRevision(prepared.cohorts[0].id, first.id, 'PR13 C5 determinism re-run');
    const [run2] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const second = await freezeCohortForExecution(run2, wsPath, workspaceId);
    expect(second.status).toBe('failed');
    expect(second.productTypeOutcome).toBe('conflicted');
    expect(second.errorMessage).toBe(first.errorMessage);
    expect(second.errorMessage).toContain('dog-food-dry (Dry Dog Food)');
  });
});

// ─── The two PR12-close P2 edges ──────────────────────────────────────────────

describe('PR13 C5 — PR12-close P2 edges', () => {
  it('the expected-OCR-digest predicate is the literal contract (expected null NEVER matches a stored null)', () => {
    const hasOcr = (evidence: ReturnType<typeof evidenceFromProjection>): boolean =>
      evidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr');
    // Reuse the C4 unit matrix compactly through the PURE resolver: a stored
    // null with an explicitly-supplied null expected digest is REJECTED; a
    // non-null expected never matches a stored null; expected === stored is
    // accepted; absent keeps the non-null check.
    // (The full matrix lives in cohort-product-type-resolver.test.ts PR13 C4.)
    const buildMember = (storedDigest: string | null) => {
      const member = {
        onboardingItemId: 'item-1',
        ordinal: 0,
        productSku: 'SKU-1',
        extractionComplete: true as const,
        sourceUrl: 'https://brand.example.com/p1',
        extractionSourceUrl: 'https://brand.example.com/p1',
        sourcingDecision: null,
        spreadsheetIdentity: {
          name: 'RAW CHKN 5LB',
          expectedName: null,
          brandHint: 'PawCo',
          departmentHint: 'Food',
          price: '19.99',
          quantity: 1,
          rowNumber: 2,
          upc: 'SKU-1',
        },
        extraction: {
          title: 'PawCo Chicken Recipe 5 lb',
          description: 'x',
          brand: 'PawCo',
          weight: '5 lb',
          bulletPoints: [],
          searchKeywords: '',
          primaryImage: 'https://img.example.com/p1.jpg',
          additionalImages: [],
          customFields: {},
          fieldProvenance: {},
          packagingTitle: null,
          manualEvidenceAttestationId: null,
          manualReferenceUrl: null,
          ocr: {
            outcome: null,
            packagingOcrData: { productName: 'Package Dog Food' } as never,
            ocrInputHash: '0'.repeat(64),
            ocrExecutionDigest: storedDigest,
          },
          piEvidence: [],
          piImportComplete: true as const,
        },
        evidenceHash: 'e'.repeat(64),
      };
      const ocrInputHash = hashCanonicalJson({
        sourceUrl: member.sourceUrl,
        extractionSourceUrl: member.extractionSourceUrl,
        primaryImage: member.extraction.primaryImage,
        additionalImages: member.extraction.additionalImages,
      });
      member.extraction.ocr.ocrInputHash = ocrInputHash;
      return member;
    };
    expect(hasOcr(evidenceFromProjection(buildMember(null), { expectedOcrExecutionDigest: null }))).toBe(false);
    expect(hasOcr(evidenceFromProjection(buildMember('digest-1'), { expectedOcrExecutionDigest: null }))).toBe(false);
    expect(hasOcr(evidenceFromProjection(buildMember('digest-1'), { expectedOcrExecutionDigest: 'digest-1' }))).toBe(true);
    expect(hasOcr(evidenceFromProjection(buildMember('digest-1')))).toBe(true);
    expect(hasOcr(evidenceFromProjection(buildMember(null)))).toBe(false);
  });
});