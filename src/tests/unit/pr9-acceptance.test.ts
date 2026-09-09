/**
 * PR9 acceptance (issue #30): semantic cohort validation.
 *
 * C4 — PR5 dependency P2 (DECISION-B): universal-attribute `field_assignment`
 * proposals carry NO product-type dependency (execution-driven AND
 * reviewed-driven); type-dependent proposals keep the exact same value hash;
 * `category_page` stamping (PR7 C6) unchanged.
 *
 * Harness: pr7/pr8-acceptance structure (temp DB, migrations,
 * `prepareActiveV2Workspace`, verified Page import, THREE-member cohort with
 * one 2-sibling group + one singleton) plus the counting llm-client mock.
 * The Bay State seed's `brand` attribute is UNIVERSAL with an enabled
 * product_field target, and `flavor` is non-universal + pet-food-profile —
 * so members deterministically emit BOTH a universal and a type-dependent
 * field_assignment proposal. The parent ops persist durable title rows
 * (cohort_fallback) + durable page rows (canned per-SKU assignments) BEFORE
 * the member loop.
 *
 * C5 (later commit) extends this file with the full reviewer acceptance list.
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
  advanceReviewedItemsToPromotion,
  advanceItemsToNextStage,
  completeReviewStage,
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
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { executeViaSeam } from './helpers/cohort-curation-harness';
import { validateSiblingConsistency, activeCohortSemanticFindingsForItem } from '../../classification/consistency-validator';
import { validateReviewCompletionGate, validateItemCategoryPagesAssigned } from '../../classification/review-completion-gate';
import { validatePromotionGate } from '../../classification/promotion-gate';
import type { PromotionGateInput } from '../../classification/promotion-gate';
import type { ClassificationRunRow } from '../../db/repositories/classification-run-repo';
import {
  validateMemberSemantics,
  validateCohortBrandCoherence,
} from '../../classification/cohort-semantic-validator';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { clearCohortPageCoordinationCache } from '../../classification/cohort-page-proposal-engine';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import { canonicalJsonFileString, canonicalJsonStringify, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import type { CohortRun, CurationCohort } from '../../shared/schemas/cohorts';
import type { OnboardingItem, CurationData } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { getActivePageImportHash, listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import type { OnboardingEvent } from '../../onboarding/sse-emitter';

// ─── llm-client mock (counting; production audit semantics) ───────────────────

let auditCallSeq = 0;

const PAGE_NAMES = ['Dog Food Dry', 'Dog Food Canned', 'Brand - Acme'];

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

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr9-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => {
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
  clearCohortPageCoordinationCache();
});

// ─── Fixtures (mirror pr7/pr8-acceptance) ─────────────────────────────────────

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
 *  adjust attribute config (e.g. give the universal brand a controlled value
 *  list so its field_assignment proposal materializes). */
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR9 Acceptance Batch', fileName: 'pr9.xlsx', totalItems: itemsData.length }).id;
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

function activateVerifiedPages(wsId: string): void {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-food-canned', name: 'Dog Food Canned' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr9-acceptance-pages'),
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

/** Seed a reviewed Primary Product Type decision for a member (reviewed-first
 *  effective-type precedence). The prior run references the WORKSPACE's v2
 *  config snapshot hash so the accepted decision is provenance-compatible and
 *  rides into the frozen member snapshot's reviewed facts. */
function seedReviewedTypeDecision(
  wsId: string,
  configSnapshotHash: string,
  sku: string,
  itemId: string,
  typeId: string,
): void {
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

/** The member's field_assignment proposals keyed by target id. */
function fieldAssignmentsByTarget(curationData: CurationData): Map<string, CurationData['classificationProposals'][number]> {
  const byTarget = new Map<string, CurationData['classificationProposals'][number]>();
  for (const proposal of curationData.classificationProposals) {
    if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;
    byTarget.set(proposal.targetId, proposal);
  }
  return byTarget;
}

// ─── PR9 C4 (issue #30, DECISION-B): universal-attribute dependency skip ─────

/** Bay State seed with the UNIVERSAL `brand` attribute switched to controlled
 *  with allowedValues ['Acme'] — its enabled product_field target then has
 *  options, so the member pipeline deterministically emits a brand
 *  field_assignment proposal (the brand shortcut fires on the member's brand
 *  evidence). `flavor` stays non-universal + pet-food-profile. */
const BRAND_CONTROLLED_SEED: typeof BayStatePetGardenSeed = {
  ...BayStatePetGardenSeed,
  attributes: BayStatePetGardenSeed.attributes.map(attribute =>
    attribute.id === 'brand'
      ? { ...attribute, valueMode: 'controlled' as const, allowedValues: ['Acme'] }
      : attribute,
  ),
};

describe('PR9 C4 — universal-attribute field_assignment proposals carry no product-type dependency (issue #30, DECISION-B)', () => {
  it('execution-driven run: universal brand proposals get NO execution_product_type row; type-dependent proposals keep exactly one', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS, BRAND_CONTROLLED_SEED);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');

    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(3);

    for (const item of items) {
      const stored = findItemById(item.id)!;
      const assignments = fieldAssignmentsByTarget(stored.curationData!);
      // The seed's `brand` attribute is UNIVERSAL with an enabled target — the
      // member's pipeline emits a brand field_assignment proposal.
      const brand = assignments.get('brand');
      const flavor = assignments.get('flavor');
      expect(brand).toBeDefined();
      expect(flavor).toBeDefined();
      // DECISION-B: universal applicability is type-independent → NO row.
      expect(listDependenciesForProposal(brand!.id)).toHaveLength(0);
      // Type-dependent proposals keep the exact same single execution row.
      const flavorDeps = listDependenciesForProposal(flavor!.id);
      expect(flavorDeps).toHaveLength(1);
      expect(flavorDeps[0].dependencyKind).toBe('execution_product_type');
      expect(flavorDeps[0].dependencyTargetId).toBe('dog-food-dry');
      expect(flavorDeps[0].dependencyValueHash).toBe(
        hashCanonicalJson({
          executionProductTypeId: run.executionProductTypeId!,
          productTypeConfidence: run.productTypeConfidence!,
        }),
      );
    }
  });

  it('reviewed-driven run: universal brand proposals get NO reviewed_product_type row; type-dependent proposals keep exactly one', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS, BRAND_CONTROLLED_SEED);
    // Member 1 gets a provenance-compatible reviewed type fact (reviewed-first
    // precedence) → its field_assignment proposals stamp reviewed_product_type.
    seedReviewedTypeDecision(workspaceId, prepared.configSnapshotHash, prepared.items[0].upc, prepared.items[0].id, 'dog-food-dry');
    const run = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const reviewedMember = findItemById(prepared.items[0].id)!;
    expect(reviewedMember.curationData!.effectiveProductType).toEqual({ id: 'dog-food-dry', source: 'reviewed' });
    const assignments = fieldAssignmentsByTarget(reviewedMember.curationData!);
    const brand = assignments.get('brand');
    const flavor = assignments.get('flavor');
    expect(brand).toBeDefined();
    expect(flavor).toBeDefined();
    expect(listDependenciesForProposal(brand!.id)).toHaveLength(0);
    const flavorDeps = listDependenciesForProposal(flavor!.id);
    expect(flavorDeps).toHaveLength(1);
    expect(flavorDeps[0].dependencyKind).toBe('reviewed_product_type');
    expect(flavorDeps[0].dependencyTargetId).toBe('dog-food-dry');
  });
});

// ─── PR9 C5 (issue #30): acceptance suite — family invariants, coordinated
//      variant contract, member-local profile, migration test ────────────────

/** Fixture whose extraction TITLE carries the type keywords — the coherent
 *  fixture (`THREE_MEMBER_EXTRACTIONS`) now carries them too (PR9 review R1,
 *  B1); this alias documents the intent for the conflicting-Product-Type test. */
const TYPE_KEYWORD_EXTRACTIONS = THREE_MEMBER_EXTRACTIONS;

/**
 * A persisted-style `field_assignment` proposal injected by the
 * `beforeSemanticValidation` processCohort seam (T1) — the semantic validator
 * consumes `curationData.classificationProposals` and the committed curation
 * JSON must carry the proposal intact.
 */
function injectedFieldAssignment(targetId: string, proposedValue: unknown): CurationData['classificationProposals'][number] {
  return {
    id: `injected-${randomUUID().slice(0, 8)}`,
    runId: 'injected-child-run',
    productSku: 'injected-sku',
    proposalType: 'field_assignment',
    targetId,
    proposedValue,
    confidence: 0.9,
    evidenceIds: [],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: new Date().toISOString(),
  } as unknown as CurationData['classificationProposals'][number];
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
      [`c5-decision-${proposal.id}`, proposal.id, `key-${proposal.id}`, now],
    );
    getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', ['accepted', proposal.id]);
  }
}

describe('PR9 C5 — acceptance: family invariants, coordinated-variant contract, member-local profile, migration test (issue #30)', () => {
  afterEach(() => {
    resetCohortCurationFlagsOverride();
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
  });

  it('coherent cohort => PASS + review-ready (all members semanticValidation passed; the review gate passes a decided member)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');

    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(3);

    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const sv = stored.curationData!.semanticValidation!;
      expect(sv.status).toBe('passed');
      expect(sv.findings).toEqual([]);
    }

    // Review gate: with every proposal decided, a coherent member IS
    // review-ready.
    decideAllProposals(findItemById(items[0].id)!);
    const memberOne = findItemById(items[0].id)!;
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: memberOne.id,
      productSku: memberOne.upc,
      activeRunId: memberOne.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(true);
  });

  it('e09 B3 (T9/P10): a MISSING persisted gate record fails review closed (corruption, never review-ready)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    const baseCuration = member.curationData!;

    // T9: a cohort-coordinated title WITHOUT its familyTitleValidation record
    // is corruption — the review gate must refuse, not pass through.
    const withoutTitleValidation = { ...baseCuration } as Record<string, unknown>;
    delete withoutTitleValidation.familyTitleValidation;
    getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(withoutTitleValidation),
      member.id,
    ]);
    const titleGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: member.id,
      productSku: member.upc,
      activeRunId: baseCuration.classificationRunId!,
    });
    expect(titleGate.ok).toBe(false);
    if (!titleGate.ok) expect(titleGate.code).toBe('title_validation_missing');

    // Restore the title record, then strip the Page decision record (P10).
    // The page target is enabled in this fixture's frozen snapshot, so a
    // missing decision refuses; if the fixture's snapshot has no page target
    // the title record is present again and the earlier checks hold instead.
    const withoutPageDecision = { ...baseCuration } as Record<string, unknown>;
    delete withoutPageDecision.pageDecisionStatus;
    getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(withoutPageDecision),
      member.id,
    ]);
    const pageGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: member.id,
      productSku: member.upc,
      activeRunId: baseCuration.classificationRunId!,
    });
    expect(pageGate.ok).toBe(false);
  });

  it('sibling Page differences + title variant differences => PASS (each member matches its OWN durable output; never sibling equality)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const siblingA = findItemById(items[0].id)!;
    const siblingB = findItemById(items[1].id)!;
    // The canned page assignments differ per SKU, and the durable titles
    // differ per variant (Chicken vs Beef).
    expect(siblingA.curationData!.suggestedPages).not.toEqual(siblingB.curationData!.suggestedPages);
    expect(siblingA.curationData!.curatedTitle).not.toEqual(siblingB.curationData!.curatedTitle);
    // Both pass: each corresponds to its own durable parent output.
    expect(siblingA.curationData!.semanticValidation!.status).toBe('passed');
    expect(siblingB.curationData!.semanticValidation!.status).toBe('passed');
  });

  it('conflicting Brand => blocked family_brand (CANONICAL ids, R2-C); NOT review-ready (review gate refuses); a passed member under the member-failures parent IS reviewable', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Member 2 shares the cohort brandHint (Woof → same candidate cohort) but
    // its FROZEN extraction brand resolves to a DIFFERENT canonical Brand
    // ('Blue Buffalo' → blue-buffalo vs 'Woof' → woof). R2-C compares
    // CANONICAL BrandConfig ids — a disagreement is HARD regardless of
    // counts (no majority forcing).
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', brand: 'Blue Buffalo' }),
      '100000000003': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb', _brandHint: 'Woof', title: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
    });
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe('100000000002');

    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.curationData!.semanticValidation!.status).toBe('passed');
    const memberTwo = findItemById(items[1].id)!;
    expect(memberTwo.stageStatus).toBe('completed'); // blocked-not-destroyed
    const sv = memberTwo.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find(f => f.code === 'family_brand')!;
    expect(finding.memberSku).toBe('100000000002');
    expect(finding.message).toContain('blue-buffalo');
    expect(finding.message).toContain('woof');

    // Review gate refuses the blocked member.
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: memberTwo.id,
      productSku: memberTwo.upc,
      activeRunId: memberTwo.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('semantic_validation_blocked');

    // R2-A: a PASSED member under a completed_with_member_failures parent IS
    // reviewable — the parent's member failures never taint healthy children.
    decideAllProposals(memberOne);
    const memberOneGate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: memberOne.id,
      productSku: memberOne.upc,
      activeRunId: memberOne.curationData!.classificationRunId!,
    });
    expect(memberOneGate.ok).toBe(true);
  });

  it('conflicting Product Type => blocked family_product_type (parent authority vs member suggestion)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, TYPE_KEYWORD_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');

    // Force the parent authority to a DIFFERENT real type: the members' own
    // proposals still say dog-food-dry → family_product_type findings.
    getDb().run(
      'UPDATE classification_cohort_runs SET execution_product_type_id = ? WHERE id = ?',
      ['dog-food-wet', run.id],
    );
    const mutatedRun = getCohortRunById(run.id)!;
    const summary = await executeViaSeam(wsPath, workspaceId, mutatedRun.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.completedMembers).toBe(3);

    // Members 1+2 (dry dog food) are blocked; member 3 (adult dog food) has
    // no confident type suggestion and ABSTAINS on the family invariant.
    for (const item of [items[0], items[1]]) {
      const stored = findItemById(item.id)!;
      const sv = stored.curationData!.semanticValidation!;
      expect(sv.status).toBe('blocked');
      const finding = sv.findings.find(f => f.code === 'family_product_type')!;
      expect(finding.memberSku).toBe(item.upc);
      expect(finding.message).toContain('dog-food-dry');
      expect(finding.message).toContain('dog-food-wet');
      expect(stored.curationData!.suggestedProductType).toBe('dog-food-dry');
    }
    // curationData + proposals preserved for the Review UX.
    expect(findItemById(items[0].id)!.curationData!.classificationProposals.length).toBeGreaterThan(0);
  });

  it('singleton cohort follows the same validator architecture (per-member semanticValidation present and coherent)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
    });
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    const sv = stored.curationData!.semanticValidation!;
    expect(sv.status).toBe('passed');
    expect(sv.findings).toEqual([]);
  });

  it('member-local E2E: an injected inapplicable field_assignment proposal blocks the member END-TO-END (committed blocked, curationData + proposals intact, parent failure, review gate refuses)', async () => {
    // T1 (PR9 review R1): the previous acceptance case called the pure
    // validator directly. This version runs END-TO-END through the
    // `beforeSemanticValidation` processCohort seam — a persisted-style
    // proposal set is injected immediately before semantic validation, then
    // the committed item must be blocked, curationData + proposals intact, the
    // parent records exactly one member failure, and the review gate refuses.
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');

    // 'size' is a NON-universal attribute OUTSIDE the pet-food profile.
    let injected = false;
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
      beforeSemanticValidation: (curationData) => {
        if (injected) return;
        injected = true;
        curationData.classificationProposals.push(injectedFieldAssignment('size', 'Large'));
      },
    });
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.completedMembers).toBe(3);
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe(items[0].upc);

    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.stageStatus).toBe('completed'); // blocked-not-destroyed
    const sv = memberOne.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find(f => f.code === 'member_attribute_applicability')!;
    expect(finding.memberSku).toBe(items[0].upc);
    expect(finding.message).toContain('size');
    // curationData + proposals intact (the injected proposal survived).
    expect(memberOne.curationData!.classificationProposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'size')).toBe(true);
    // Review gate refuses the blocked member.
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: memberOne.id,
      productSku: memberOne.upc,
      activeRunId: memberOne.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('semantic_validation_blocked');
    // Siblings stay passed.
    expect(findItemById(items[1].id)!.curationData!.semanticValidation!.status).toBe('passed');
    expect(findItemById(items[2].id)!.curationData!.semanticValidation!.status).toBe('passed');
  });

  it('member-local E2E: an injected MULTI-VALUE ARRAY on a single-cardinality attribute blocks END-TO-END (PR9 review R1, B5)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');

    // Inject a single-cardinality flavor proposal carrying ['Chicken','Beef']
    // (a multi-value array in ONE proposal) into the FIRST member's curation
    // data immediately before semantic validation.
    let injected = false;
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
      beforeSemanticValidation: (curationData) => {
        if (injected) return;
        injected = true;
        curationData.classificationProposals.push(injectedFieldAssignment('flavor', ['Chicken', 'Beef']));
      },
    });
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe(items[0].upc);

    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.stageStatus).toBe('completed');
    const sv = memberOne.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find(f => f.code === 'member_cardinality')!;
    expect(finding.memberSku).toBe(items[0].upc);
    expect(finding.message).toContain('flavor');
    // curationData + proposals intact.
    expect(memberOne.curationData!.classificationProposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(true);
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: memberOne.id,
      productSku: memberOne.upc,
      activeRunId: memberOne.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('semantic_validation_blocked');
    expect(findItemById(items[1].id)!.curationData!.semanticValidation!.status).toBe('passed');
    expect(findItemById(items[2].id)!.curationData!.semanticValidation!.status).toBe('passed');
  });

  it('R3 E2E: an EXPLICITLY EMPTY category_page proposal set against an assigned durable page output BLOCKS end-to-end — the production call site can never fall back to display names (PR9 review R3)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);

    // Strip the FIRST member's materialized category_page proposals immediately
    // before semantic validation while leaving suggestedPages (display names)
    // intact — exactly the state the R3 fix must block: the production call
    // site supplied an EMPTY proposal set against an assigned durable set.
    let stripped = false;
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
      beforeSemanticValidation: (curationData) => {
        if (stripped) return;
        stripped = true;
        curationData.classificationProposals = curationData.classificationProposals.filter(
          p => p.proposalType !== 'category_page',
        );
      },
    });
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe(items[0].upc);

    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.stageStatus).toBe('completed'); // blocked-not-destroyed
    const sv = memberOne.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find(f => f.code === 'coordinated_page')!;
    expect(finding.memberSku).toBe(items[0].upc);
    // suggestedPages (display names) were intact — the block must NOT have
    // come from a name comparison.
    expect(memberOne.curationData!.suggestedPages.length).toBeGreaterThan(0);
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: memberOne.id,
      productSku: memberOne.upc,
      activeRunId: memberOne.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('semantic_validation_blocked');
    // Siblings stay passed.
    expect(findItemById(items[1].id)!.curationData!.semanticValidation!.status).toBe('passed');
    expect(findItemById(items[2].id)!.curationData!.semanticValidation!.status).toBe('passed');
  });

  it('MIGRATION TEST: legacy validateSiblingConsistency STILL warns on sibling page divergence, while the new validator PASSES each member against its own durable output', () => {
    // Sibling A pages=[Dog Food], Sibling B pages=[Dog Food, Brand - Acme].
    const { workspaceId } = newWorkspace();
    const batchId = createBatch({ workspaceId, name: 'Migration Batch', fileName: 'migration.xlsx', totalItems: 2 }).id;
    const items = insertItems(batchId, [
      { upc: '900000000001', name: 'Acme Dog Food Chicken 5 lb', brandHint: 'Acme', rowNumber: 1, stage: 'curation' as const, stageStatus: 'completed' as const },
      { upc: '900000000002', name: 'Acme Dog Food Beef 10 lb', brandHint: 'Acme', rowNumber: 2, stage: 'curation' as const, stageStatus: 'completed' as const },
    ]);
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ suggestedPages: ['Dog Food'] }), items[0].id],
    );
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ suggestedPages: ['Dog Food', 'Brand - Acme'] }), items[1].id],
    );

    // LEGACY unchanged: live-regrouping divergence warning on the same data.
    const warnings = validateSiblingConsistency(batchId);
    expect(warnings.some(w => w.field === 'category_page')).toBe(true);

    // NEW validator: coordinated_variant contract — each member matches its
    // OWN durable output, sibling equality is never required.
    const siblingA = validateMemberSemantics({
      memberSku: '900000000001',
      parentExecutionType: { id: 'dog-food-dry', label: 'Dry Dog Food' },
      curatedTitle: 'Acme Dog Food Chicken 5 lb',
      titleSource: 'cohort_fallback',
      suggestedPages: ['Dog Food'],
      suggestedProductType: 'dog-food-dry',
      durableTitleOutput: { title: 'Acme Dog Food Chicken 5 lb', source: 'cohort_fallback' },
      durablePageOutput: { status: 'assigned', pages: [{ pageId: 'p1', pageName: 'Dog Food', confidence: 0.9 }] },
    });
    const siblingB = validateMemberSemantics({
      memberSku: '900000000002',
      parentExecutionType: { id: 'dog-food-dry', label: 'Dry Dog Food' },
      curatedTitle: 'Acme Dog Food Beef 10 lb',
      titleSource: 'cohort_fallback',
      suggestedPages: ['Dog Food', 'Brand - Acme'],
      suggestedProductType: 'dog-food-dry',
      durableTitleOutput: { title: 'Acme Dog Food Beef 10 lb', source: 'cohort_fallback' },
      durablePageOutput: { status: 'assigned', pages: [
        { pageId: 'p1', pageName: 'Dog Food', confidence: 0.9 },
        { pageId: 'p2', pageName: 'Brand - Acme', confidence: 0.7 },
      ] },
    });
    expect(siblingA.status).toBe('passed');
    expect(siblingB.status).toBe('passed');
  });

  it('flag OFF/shadow: EXECUTED legacy-worker path — raw curation JSON carries NO own semanticValidation key and the canonical serialization + legacy warning payload are byte-identical (T2)', async () => {
    // PR9 review R1 (T2): the previous acceptance test never executed the
    // legacy worker path nor inspected curation_data_json. This version runs
    // the real OnboardingWorker per-item (legacy) path over OFF and shadow and
    // (a) asserts the raw curation JSON has NO own 'semanticValidation' key in
    // BOTH modes, (b) compares the canonical curation serialization to the
    // frozen OFF-mode baseline byte-identically in shadow mode, and (c) asserts
    // the legacy warning payload emitted through SSE is byte-identical.
    const runLegacyScenario = async (mode: 'off' | 'shadow'): Promise<{
      rows: Array<{ itemId: string; curationJson: string; parsed: Record<string, unknown> }>;
      events: Array<{ itemId: string; data: Record<string, unknown> }>;
    }> => {
      clearCohortCoordinationCache();
      clearCohortPageCoordinationCache();
      const { workspaceId, workspacePath: wsPath } = newWorkspace();
      const { items } = prepareActiveV2Workspace(workspaceId, wsPath, {
        '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
        '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
      });
      if (mode === 'shadow') {
        overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });
      } else {
        overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
      }
      // The legacy per-item worker path is the ONLY path in both modes (OFF
      // has V2 disabled; shadow observes without cohort claiming — never
      // active mode).
      expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(mode === 'shadow');
      expect(!getCohortCurationFlags().cohortCurationV2Enabled || getCohortCurationFlags().cohortShadowOnly).toBe(true);

      const batchId = items[0].batchId;
      const events: Array<{ itemId: string; data: Record<string, unknown> }> = [];
      const unsubscribe = onboardingEvents.subscribe(batchId, (event: OnboardingEvent) => {
        if (event.type === 'item:status' && event.itemId) events.push({ itemId: event.itemId, data: event.data });
      });
      const worker = new OnboardingWorker(workspaceId, wsPath);
      await worker.poll();
      await worker.drain();
      unsubscribe();

      const rows = getDb().query(
        'SELECT id, curation_data_json FROM onboarding_items WHERE batch_id = ? ORDER BY upc',
      ).all(batchId) as Array<{ id: string; curation_data_json: string | null }>;
      return {
        rows: rows.map(row => ({
          itemId: row.id,
          curationJson: row.curation_data_json ?? '',
          parsed: JSON.parse(row.curation_data_json ?? '{}') as Record<string, unknown>,
        })),
        events,
      };
    };

    const off = await runLegacyScenario('off');
    const shadow = await runLegacyScenario('shadow');

    expect(off.rows).toHaveLength(2);
    expect(shadow.rows).toHaveLength(2);
    for (const row of [...off.rows, ...shadow.rows]) {
      expect(Object.prototype.hasOwnProperty.call(row.parsed, 'semanticValidation')).toBe(false);
    }

    // Canonical serialization: the OFF-mode bytes are the frozen baseline and
    // shadow mode must match byte-identically. The two scenarios run in
    // DIFFERENT workspaces, so volatile identity/timestamp fields (ids, run
    // refs, timestamps, evidence refs) are normalized out — every DETERMINISTIC
    // curation field (titles, sources, pages, suggested type, proposals,
    // decisions) must be byte-identical between the modes.
    const VOLATILE_KEYS = new Set([
      'id', 'runId', 'createdAt', 'updatedAt', 'curatedAt', 'capturedAt',
      'startedAt', 'endedAt', 'extractedAt', 'snapshotHash', 'evidenceIds',
      'supportingEvidenceIds', 'contradictingEvidenceIds', 'currentDecisionId',
      'classificationRunId', 'classificationConfigSnapshot', 'classificationHistory',
      'verifiedPageIdSet', 'verifiedPageCount', 'pageSnapshot', 'snapshot',
      // taxonomyProvenance (product-curator.ts:986) writes per-workspace
      // activation identity: bundleHash/bundleVersion differ on every run and
      // are non-deterministic across executions — normalized out like the
      // other volatile identity fields.
      'bundleHash', 'bundleVersion',
    ]);
    const stripVolatile = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripVolatile);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
          if (VOLATILE_KEYS.has(key)) continue;
          out[key] = stripVolatile(child);
        }
        return out;
      }
      return value;
    };
    const canonicalize = (rows: Array<{ curationJson: string }>): string =>
      rows.map(row => canonicalJsonStringify(stripVolatile(JSON.parse(row.curationJson)))).join('\n');
    expect(canonicalize(shadow.rows)).toBe(canonicalize(off.rows));

    // Legacy warning payload (the SSE consistencyWarnings surface) identical
    // in both modes — and never carries the active-cohort semanticValidation.
    const warningPayloads = (events: Array<{ itemId: string; data: Record<string, unknown> }>): unknown =>
      events
        .slice()
        .sort((a, b) => a.itemId.localeCompare(b.itemId))
        .map(event => ({
          consistencyWarnings: event.data.consistencyWarnings ?? [],
          semanticValidation: event.data.semanticValidation ?? null,
        }));
    expect(JSON.stringify(warningPayloads(shadow.events))).toBe(JSON.stringify(warningPayloads(off.events)));
    expect(JSON.stringify(warningPayloads(off.events))).toContain('"semanticValidation":null');

    // The un-executed-item surface stays legacy in both modes.
    resetCohortCurationFlagsOverride();
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
    });
    expect(activeCohortSemanticFindingsForItem(findItemById(items[0].id)!)).toEqual({ mode: 'legacy' });
  });
});

// ─── PR9 review round 2 (issue #30): R2 regressions ───────────────────────────

/** Coherent member semantics fixture for the R2 direct-validator regressions. */
function r2CoherentMember(overrides: Record<string, unknown> = {}) {
  return {
    memberSku: '100000000001',
    parentExecutionType: { id: 'dry-dog-food', label: 'Dry Dog Food' },
    curatedTitle: 'Acme Dry Dog Food Chicken 5 lb',
    titleSource: 'cohort_fallback',
    suggestedPages: ['Dog Food Dry'],
    suggestedProductType: 'dry-dog-food',
    durableTitleOutput: { title: 'Acme Dry Dog Food Chicken 5 lb', source: 'cohort_fallback' as const },
    durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    pageOutputExpectedEmpty: false,
    ...overrides,
  };
}

describe('PR9 review R2 — active review authority gate + coordinated correspondence + canonical Brand identity (issue #30)', () => {
  afterEach(() => {
    resetCohortCurationFlagsOverride();
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
  });

  it('R2-A: a completed cohort child is NOT reviewable while its parent is running (parent_not_completed)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    // Simulate the parent race: the child committed+completed, but the parent
    // is still in flight (post-loop Brand validation happens AFTER member
    // completion). The child must NOT be reviewable.
    getDb().run('UPDATE classification_cohort_runs SET status = ? WHERE id = ?', ['running', run.id]);
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: member.id,
      productSku: member.upc,
      activeRunId: member.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('parent_not_completed');
      expect(gate.reason).toContain(run.id);
    }
  });

  it('R2-A: a SUPERSEDED parent leaves its completed children non-reviewable (parent_superseded)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    // A new revision superseded this parent — its children are historical.
    getDb().run(
      "UPDATE classification_cohort_runs SET status = 'superseded', superseded_at = ? WHERE id = ?",
      [new Date().toISOString(), run.id],
    );
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: member.id,
      productSku: member.upc,
      activeRunId: member.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('parent_superseded');
      expect(gate.reason).toContain(run.id);
    }
  });

  it('R2-A: MISSING semanticValidation in an active cohort child fails closed (semantic_validation_blocked)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    // Strip the semanticValidation key from the committed curation data — a
    // corrupt/lost payload must NEVER pass through (surface contract treats
    // missing as corruption).
    const { semanticValidation: _dropped, ...rest } = member.curationData!;
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(rest), member.id],
    );
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: member.id,
      productSku: member.upc,
      activeRunId: member.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('semantic_validation_blocked');
      expect(gate.reason).toMatch(/missing/i);
    }
  });

  it('R2-A: MALFORMED semanticValidation in an active cohort child fails closed (semantic_validation_blocked)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    // A status outside the {passed, blocked} enum is malformed — never
    // review-ready.
    const curation = { ...member.curationData!, semanticValidation: { status: 'weird', findings: [] } };
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(curation), member.id],
    );
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: member.id,
      productSku: member.upc,
      activeRunId: member.curationData!.classificationRunId!,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('semantic_validation_blocked');
      expect(gate.reason).toMatch(/malformed/i);
    }
  });

  it('R2-A: a legacy non-cohort child is byte-identical — absent semanticValidation proceeds (no parent checks)', async () => {
    // The gate's legacy path (cohort_run_id NULL) is EXACTLY today's behavior:
    // an absent semanticValidation key proceeds and no parent checks run.
    // The universal Category Page requirement still applies (operator
    // mandate), so the fixture activates a verified Page import and assigns
    // one verified page.
    const { workspaceId } = newWorkspace();
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sha256Hex('pr9-r2a-pages'),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid' as const, key: 'dog-food-dry', status: 'verified' as const }, name: 'Dog Food Dry', parentRef: null, availability: 'available' as const },
      ],
      activatedBy: 'test',
    });
    const batchId = createBatch({ workspaceId, name: 'R2 Legacy Batch', fileName: 'legacy.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [
      { upc: '900000000001', name: 'Acme Legacy Item', brandHint: 'Acme', rowNumber: 1, stage: 'review' as const, stageStatus: 'pending' as const },
    ]);
    getDb().run(
      'INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, source_kind, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['r2-legacy-run', workspaceId, item.id, item.upc, 'onboarding', 'completed', new Date().toISOString(), new Date().toISOString()],
    );
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Legacy Title', classificationRunId: 'r2-legacy-run', suggestedPages: ['Dog Food Dry'] }), item.id],
    );
    // Seed one decided proposal so the gate reaches ok.
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES ('r2-legacy-prop', 'r2-legacy-run', ?, 'primary_product_type', 'dry-dog-food', '"Dry Dog Food"', 0.9, 'accepted', ?)`,
      [item.upc, new Date().toISOString()],
    );
    getDb().run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
       VALUES ('r2-legacy-dec', 'r2-legacy-prop', 'accepted', 'token', ?)`,
      [new Date().toISOString()],
    );
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: item.id,
      productSku: item.upc,
      activeRunId: 'r2-legacy-run',
    });
    expect(gate.ok).toBe(true);
  });

  it('R2-B: exact title source equality — a matching title with a DIFFERENT source is a coordinated_title finding (both directions)', () => {
    const mismatched = validateMemberSemantics(r2CoherentMember({ titleSource: 'llm_cohort' }));
    expect(mismatched.status).toBe('blocked');
    expect(mismatched.findings.some(f => f.code === 'coordinated_title')).toBe(true);

    const otherDirection = validateMemberSemantics(r2CoherentMember({
      durableTitleOutput: { title: 'Acme Dry Dog Food Chicken 5 lb', source: 'llm_cohort' as const },
    }));
    expect(otherDirection.status).toBe('blocked');
    expect(otherDirection.findings.some(f => f.code === 'coordinated_title')).toBe(true);

    expect(validateMemberSemantics(r2CoherentMember()).status).toBe('passed');
  });

  it('R2-B: page correspondence is STABLE PAGE ID-based — wrong id with the same display name blocks; name mismatch is advisory-only', () => {
    // Wrong pageId with the same display name → BLOCKED (identity is the id).
    const wrongId = validateMemberSemantics(r2CoherentMember({
      pageProposals: [{ pageId: 'pX', pageName: 'Dog Food Dry' }],
    }));
    expect(wrongId.status).toBe('blocked');
    expect(wrongId.findings.some(f => f.code === 'coordinated_page')).toBe(true);

    // Matched id but different display name → advisory-only (status passed).
    const nameMismatch = validateMemberSemantics(r2CoherentMember({
      suggestedPages: ['Dog Food Dry (New)'],
      pageProposals: [{ pageId: 'p1', pageName: 'Dog Food Dry (New)' }],
    }));
    expect(nameMismatch.status).toBe('passed');
    expect(nameMismatch.findings.some(f => f.code === 'coordinated_page_name_mismatch')).toBe(true);
    expect(nameMismatch.findings.some(f => f.code === 'coordinated_page')).toBe(false);

    // Exact id set-match passes.
    expect(validateMemberSemantics(r2CoherentMember({
      pageProposals: [{ pageId: 'p1', pageName: 'Dog Food Dry' }],
    })).status).toBe('passed');
  });

  it('R2-B: expected-empty REQUIRES zero pages AND zero category_page proposals', () => {
    const blocked = validateMemberSemantics(r2CoherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: true,
      suggestedPages: ['Dog Food Dry'],
      pageProposals: [{ pageId: 'p1', pageName: 'Dog Food Dry' }],
    }));
    expect(blocked.status).toBe('blocked');
    expect(blocked.findings.some(f => f.code === 'coordinated_page')).toBe(true);

    const abstainedWithProposal = validateMemberSemantics(r2CoherentMember({
      suggestedPages: [],
      pageProposals: [{ pageId: 'pX', pageName: 'Dog Food Dry' }],
      durablePageOutput: { status: 'abstained' as const, reason: 'policy denied' },
    }));
    expect(abstainedWithProposal.status).toBe('blocked');
    expect(abstainedWithProposal.findings.some(f => f.code === 'coordinated_page')).toBe(true);

    const clean = validateMemberSemantics(r2CoherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: true,
      suggestedPages: [],
      pageProposals: [],
    }));
    expect(clean.status).toBe('passed');
  });

  it('R2-C: canonical Brand identity — alias coherence passes and two distinct canonical ids block', () => {
    const hillsBrands = [
      { id: 'hills', name: "Hill's Science Diet", aliases: ['Science Diet'], oldIdAliases: [] },
    ];
    // Raw texts differ but resolve to the SAME canonical id → coherent.
    const aliasCoherent = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ["Hill's Science Diet"] },
      { sku: '100000000002', frozenBrandEvidence: ['Science Diet'] },
    ], { brands: hillsBrands });
    expect(aliasCoherent.status).toBe('passed');
    expect(aliasCoherent.findings).toEqual([]);

    // Two distinct canonical ids → HARD block regardless of counts.
    const twoIds = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000004', frozenBrandEvidence: ['Purina'] },
    ], {
      brands: [
        { id: 'acme', name: 'Acme', aliases: [], oldIdAliases: [] },
        { id: 'purina', name: 'Purina', aliases: [], oldIdAliases: [] },
      ],
    });
    expect(twoIds.status).toBe('blocked');
    expect(twoIds.findings.every(f => f.code === 'family_brand')).toBe(true);
  });
});

// ─── e09 Phase C — T9/P10 gate codes, reviewer corrections, stale-import ─────

/** Overwrite one key of the member's committed curation JSON. */
function mutateCuration(member: OnboardingItem, mutate: (curation: Record<string, unknown>) => void): void {
  const fresh = findItemById(member.id)!;
  const copy = { ...(fresh.curationData ?? {}) } as Record<string, unknown>;
  mutate(copy);
  getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(copy), member.id]);
}

function reviewGate(wsId: string, member: OnboardingItem) {
  return validateReviewCompletionGate({
    workspaceId: wsId,
    onboardingItemId: member.id,
    productSku: member.upc,
    activeRunId: member.curationData!.classificationRunId!,
  });
}

describe('e09 Phase C — review-completion gate codes + corrections (T9/P10)', () => {
  afterEach(() => {
    resetCohortCurationFlagsOverride();
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
  });

  it('T9 codes: malformed familyTitleValidation refuses title_validation_malformed; a committed BLOCKED record refuses title_validation_blocked', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);

    // Malformed: version is not a string → schema parse fails.
    mutateCuration(member, curation => {
      curation.familyTitleValidation = { status: 'passed', version: 123 };
    });
    const malformed = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe('title_validation_malformed');

    // Blocked representable status (schema widened in B3): producer never
    // commits it today, but the gate must refuse it if present.
    mutateCuration(member, curation => {
      curation.familyTitleValidation = { status: 'blocked', version: 'v1', source: 'llm_cohort' };
    });
    const blocked = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('title_validation_blocked');
  });

  it('P10 codes: missing decision record AND abstained decision each refuse with THAT code', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    // NOTE: deliberately NO reviewer decisions here — an accepted verified
    // category_page proposal would trigger the adjudication #10 correction
    // path instead of the plain refusal codes these assertions pin.

    // Missing record (strengthens the earlier ok:false-only assertion).
    mutateCuration(member, curation => {
      delete curation.pageDecisionStatus;
    });
    const missing = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('page_decision_missing');

    // Abstained WITHOUT any reviewer-accepted verified page → refused with
    // the specific code (adjudication #6: abstention blocks Review).
    mutateCuration(member, curation => {
      curation.pageDecisionStatus = { status: 'abstained' };
    });
    const abstained = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(abstained.ok).toBe(false);
    if (!abstained.ok) expect(abstained.code).toBe('page_decision_abstained');
  });

  it('adjudication #10: an abstained decision + reviewer-ACCEPTED verified category_page proposal completes review (plain target)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member); // accepts every proposal incl. category_page → targets are VERIFIED ids

    mutateCuration(member, curation => {
      curation.pageDecisionStatus = { status: 'abstained' };
    });
    // The accepted proposals resolve into the active verified import →
    // the manual correction satisfies the gate despite the abstention.
    const corrected = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(corrected.ok).toBe(true);
  });

  it('adjudication #10 REVISED variant: correction honored via revised_target_id (COALESCE semantics), not the original target', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    const runId = member.curationData!.classificationRunId!;
    const verifiedIds = new Set(listVerifiedPageOptions(workspaceId).map(row => row.id));
    const revisedTarget = listVerifiedPageOptions(workspaceId).find(row => row.name === 'Dog Food Dry')!.id;

    // Corrupt every ORIGINAL predicted target so nothing resolves anymore…
    getDb().run(
      "UPDATE classification_proposals SET target_id = 'page-bogus-original' WHERE run_id = ? AND proposal_type = 'category_page'",
      [runId],
    );
    mutateCuration(member, curation => {
      curation.pageDecisionStatus = { status: 'abstained' };
    });
    // …without a revision the abstained refusal stands.
    const beforeRevision = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(beforeRevision.ok).toBe(false);
    if (!beforeRevision.ok) expect(beforeRevision.code).toBe('page_decision_abstained');

    // …then the reviewer REVISES ONE page proposal onto a current verified ID.
    const pageProposal = getDb().query(
      "SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = 'category_page' ORDER BY rowid LIMIT 1",
    ).get(runId) as { id: string };
    getDb().run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_target_id, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', ?, 1, ?)`,
      [`phasec-revision-${pageProposal.id}`, pageProposal.id, revisedTarget, new Date().toISOString()],
    );
    // The REVISED (current) id is what gets validated — gate passes.
    const afterRevision = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(afterRevision.ok).toBe(true);
    expect(verifiedIds.has(revisedTarget)).toBe(true);
  });

  it('P10 fail-open regression: an ASSIGNED decision whose accepted pages were ALL rejected by the reviewer refuses page_decision_missing', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    // Accept non-page proposals; REJECT every category_page proposal.
    const proposals = getDb().query(
      'SELECT id, proposal_type FROM classification_proposals WHERE run_id = ?',
    ).all(member.curationData!.classificationRunId!) as Array<{ id: string; proposal_type: string }>;
    const now = new Date().toISOString();
    for (const proposal of proposals) {
      if (proposal.proposal_type === 'reviewable_abstention') continue;
      const decision = proposal.proposal_type === 'category_page' ? 'rejected' : 'accepted';
      getDb().run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [`phasec-decision-${proposal.id}`, proposal.id, decision, `phasec-key-${proposal.id}`, now],
      );
    }
    mutateCuration(member, curation => {
      curation.pageDecisionStatus = { status: 'assigned' };
    });
    const gate = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('page_decision_missing');
      expect(gate.reason).toMatch(/no reviewer-accepted/i);
    }
  });
});

describe('e09 Phase C — stale import between Review and Promotion (P10+P11 defense-in-depth)', () => {
  afterEach(() => {
    resetCohortCurationFlagsOverride();
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
  });

  it('approved under import N; import N+1 activates; BOTH gates refuse before any draft write', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);

    // Positive controls under import N: review completes; promotion passes.
    expect(reviewGate(workspaceId, findItemById(items[0].id)!).ok).toBe(true);

    const stored = findItemById(items[0].id)!;
    const runId = stored.curationData!.classificationRunId!;
    const promotionGateFor = (): ReturnType<typeof validatePromotionGate> => {
      const runRow = getDb().query('SELECT id, workspace_id, status, cohort_run_id FROM classification_runs WHERE id = ?')
        .get(runId) as { id: string; workspace_id: string; status: string; cohort_run_id: string };
      const parentRow = getDb().query('SELECT id, workspace_id, status FROM classification_cohort_runs WHERE id = ?')
        .get(runRow.cohort_run_id) as { id: string; workspace_id: string; status: string };
      const proposalRows = getDb().query(
        "SELECT id, proposal_type, target_id, proposed_value_json FROM classification_proposals WHERE run_id = ?",
      ).all(runId) as Array<{ id: string; proposal_type: string; target_id: string | null; proposed_value_json: string | null }>;
      return validatePromotionGate({
        workspaceId,
        itemId: stored.id,
        productSku: stored.upc,
        curationData: stored.curationData!,
        activeRun: {
          id: runRow.id,
          workspaceId: runRow.workspace_id,
          status: runRow.status,
          cohortRunId: runRow.cohort_run_id,
        } as unknown as ClassificationRunRow,
        parentRun: {
          id: parentRow.id,
          workspaceId: parentRow.workspace_id,
          status: parentRow.status,
        } as unknown as PromotionGateInput['parentRun'],
        effectiveTypeId: 'dog-food-dry',
        acceptedProposals: proposalRows.map(row => ({
          id: row.id,
          proposalType: row.proposal_type,
          targetId: row.target_id,
          proposedValue: row.proposed_value_json ? JSON.parse(row.proposed_value_json) : null,
          hasRevisedValue: false,
        })) as PromotionGateInput['acceptedProposals'],
        dependencyLookup: () => [],
        verifiedPageIds: new Set(listVerifiedPageOptions(workspaceId).map(row => row.id)),
      });
    };
    expect(promotionGateFor()).toEqual({ ok: true });

    // Import N+1 activates with DISJOINT pages — every committed identity goes stale.
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sha256Hex('pr9-phasec-pages-N2'),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid' as const, key: 'wet-dog-food', status: 'verified' as const }, name: 'Wet Dog Food', parentRef: null, availability: 'available' as const },
      ],
      activatedBy: 'test',
    });

    // P10: review can no longer complete on the stale assignment (the P10
    // durable-decision gate fires before the universal name-level page check).
    const staleReview = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(staleReview.ok).toBe(false);
    if (!staleReview.ok) expect(staleReview.code).toBe('page_decision_stale');

    // P11: promotion refuses BEFORE any draft write.
    const stalePromotion = promotionGateFor();
    expect(stalePromotion.ok).toBe(false);
    if (!stalePromotion.ok) {
      expect(stalePromotion.code).toBe('stale_page_assignment');
      expect(stalePromotion.reason).toMatch(/P11/);
    }
  });

  it('round-3 FIX 1: correctedCategoryPage RECORD seam — current ID+hash resolves an abstained decision; stale hash and malformed records refuse', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    // Accept every NON-page proposal; REJECT every category_page proposal so
    // the accepted-proposal correction path is unavailable — only the
    // correctedCategoryPage RECORD can resolve the abstention.
    const proposals = getDb().query(
      'SELECT id, proposal_type FROM classification_proposals WHERE run_id = ?',
    ).all(member.curationData!.classificationRunId!) as Array<{ id: string; proposal_type: string }>;
    const now = new Date().toISOString();
    for (const proposal of proposals) {
      if (proposal.proposal_type === 'reviewable_abstention') continue;
      const decision = proposal.proposal_type === 'category_page' ? 'rejected' : 'accepted';
      getDb().run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [`fix1-decision-${proposal.id}`, proposal.id, decision, `fix1-key-${proposal.id}`, now],
      );
      // Mirror the real decision service: the durable decision AND the
      // proposal status move together (a pending proposal blocks review).
      getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', [decision, proposal.id]);
    }

    const currentHash = getActivePageImportHash(workspaceId);
    expect(currentHash).toBeTruthy();
    const verifiedId = listVerifiedPageOptions(workspaceId)[0].id;

    // Abstained WITHOUT any record → plain refusal (baseline).
    mutateCuration(member, curation => {
      curation.pageDecisionStatus = { status: 'abstained' };
    });
    const baseline = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(baseline.ok).toBe(false);
    if (!baseline.ok) expect(baseline.code).toBe('page_decision_abstained');

    // MALFORMED record → never satisfies the abstention (fail closed).
    mutateCuration(member, curation => {
      curation.correctedCategoryPage = { pageId: 123 };
    });
    const malformed = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe('page_decision_abstained');

    // STALE hash (recorded against a superseded import) → page_decision_stale.
    mutateCuration(member, curation => {
      curation.correctedCategoryPage = { pageId: verifiedId, activePageImportHash: 'dead-import-hash', correctedAt: now };
    });
    const staleHash = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(staleHash.ok).toBe(false);
    if (!staleHash.ok) expect(staleHash.code).toBe('page_decision_stale');

    // Current hash but an ID OUTSIDE the verified import → page_decision_stale.
    mutateCuration(member, curation => {
      curation.correctedCategoryPage = { pageId: 'page-not-in-import', activePageImportHash: currentHash!, correctedAt: now };
    });
    const unverifiedId = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(unverifiedId.ok).toBe(false);
    if (!unverifiedId.ok) expect(unverifiedId.code).toBe('page_decision_stale');

    // CURRENT verified ID + CURRENT import hash → the correction resolves the
    // abstained decision and review completes (adjudication #10).
    mutateCuration(member, curation => {
      curation.correctedCategoryPage = { pageId: verifiedId, activePageImportHash: currentHash!, correctedAt: now };
    });
    const resolved = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(resolved.ok).toBe(true);
  });
});

describe('Universal Category Page assignment requirement (operator mandate)', () => {
  afterEach(() => {
    resetCohortCurationFlagsOverride();
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
  });

  it('review gate refuses missing_category_page when committed curation carries no suggestedPages', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    // Positive control: with pages assigned, review completes.
    expect(reviewGate(workspaceId, findItemById(items[0].id)!).ok).toBe(true);

    mutateCuration(member, curation => {
      delete curation.suggestedPages;
    });
    const missing = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('missing_category_page');
      expect(missing.reason).toMatch(/category page/i);
    }
  });

  it('review gate refuses unverified_category_page when an assigned name does not resolve into the current verified import', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    mutateCuration(member, curation => {
      curation.suggestedPages = ['Renamed Or Removed Page'];
    });
    const unverified = reviewGate(workspaceId, findItemById(items[0].id)!);
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect(unverified.code).toBe('unverified_category_page');
      expect(unverified.reason).toMatch(/Renamed Or Removed Page/);
    }
  });

  it('shared helper: absent/empty assignments refuse; verified names pass; non-string entries refuse', () => {
    const { workspaceId } = newWorkspace();
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sha256Hex('pr9-universal-pages'),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid' as const, key: 'dog-food-dry', status: 'verified' as const }, name: 'Dog Food Dry', parentRef: null, availability: 'available' as const },
      ],
      activatedBy: 'test',
    });

    const forData = (curationData: unknown) =>
      validateItemCategoryPagesAssigned({ workspaceId, curationData });

    const nullResult = forData(null);
    expect(nullResult?.ok).toBe(false);
    if (nullResult && !nullResult.ok) expect(nullResult.code).toBe('missing_category_page');

    const emptyResult = forData({ suggestedPages: [] });
    expect(emptyResult?.ok).toBe(false);
    if (emptyResult && !emptyResult.ok) expect(emptyResult.code).toBe('missing_category_page');

    expect(forData({ suggestedPages: ['Dog Food Dry'] })).toBeNull();

    const nonString = forData({ suggestedPages: [42] });
    expect(nonString?.ok).toBe(false);
    if (nonString && !nonString.ok) expect(nonString.code).toBe('unverified_category_page');

    const unknownName = forData({ suggestedPages: ['Dog Food Dry', 'Ghost Page'] });
    expect(unknownName?.ok).toBe(false);
    if (unknownName && !unknownName.ok) expect(unknownName.code).toBe('unverified_category_page');
  });

  it('advanceReviewedItemsToPromotion refuses pageless review/completed rows before approval', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');

    const member = findItemById(items[0].id)!;
    decideAllProposals(member);
    expect(advanceItemsToNextStage([member.id]).advanced).toBe(1);
    completeReviewStage(member.id);

    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = json_set(curation_data_json, '$.suggestedPages', json_array()) WHERE id = ?`,
      [member.id],
    );
    const refusedPageless = advanceReviewedItemsToPromotion([member.id]);
    expect(refusedPageless.advanced).toEqual([]);
    expect(refusedPageless.refused[0]?.itemId).toBe(member.id);
    expect(refusedPageless.refused[0]?.reason).toMatch(/missing_category_page/);

    // Restoring the assignment unblocks approval.
    const stored = findItemById(member.id)!;
    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [JSON.stringify({ ...stored.curationData!, suggestedPages: ['Dog Food Dry'] }), member.id],
    );
    const approvedAfterFix = advanceReviewedItemsToPromotion([member.id]);
    expect(approvedAfterFix.advanced).toEqual([member.id]);
    expect(approvedAfterFix.refused).toEqual([]);
  });
});
