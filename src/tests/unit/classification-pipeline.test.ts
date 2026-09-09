import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';

// Mock the LLM client so page assignment works in test environment
mock.module('../../onboarding/llm-client', () => ({
  callLlmForTask: mock(async () => '{"pages":[{"pageName":"Dog Food","confidence":0.8}]}'),
  getLlmConfigForTask: mock(() => ({ provider: 'ollama', apiKey: 'test', baseUrl: 'http://localhost:11434/v1', model: 'test-model' })),
}));

import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import {
  syncConfigToCache,
  getCachedProductTypes,
  getCachedAttributes,
  createConfigSnapshot,
  computeConfigHash,
  computeLegacyConfigHash,
  configHashMatches,
} from '../../db/repositories/classification-config-repo';
import { createRun, completeRun, getProposalsByRun, getStageResults, getEvidenceByRun, recordDecision, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { runPipeline } from '../../classification/pipeline-runner';
import type { ClassificationStageName } from '../../classification/types';
import type { ClassificationEvidence } from '../../shared/types';
import { evidenceExtractionStage, nameConsolidationStage, categoryPageProposalsStage, productAttributeProposalsStage, attributeApplicabilityStage, primaryProductTypeStage } from '../../classification';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import { upsertPage } from '../../db/repositories/page-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { updateFieldMetadata } from '../../server/services/field-metadata-service';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../../classification/page-snapshot';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listCurationTargetCandidates } from '../../classification/curation-targets';
import { getDb } from '../../db/connection';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import catalogClassificationRoutes from '../../server/routes/catalog-classification-routes';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { applyFieldMappingEdits } from '../../classification/field-mapping-editor';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { authorityConfigHashMatches, runtimeSnapshotHashMatchesConfig } from '../../classification/runtime-snapshot';
import { sha256Hex } from '../../shared/stable-id';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';

describe('Classification Pipeline Integration', () => {
  let workspacePath: string;
  let workspaceId: string;

  /** Persist fixture evidence as the run creators do, so stage proposals can
   *  link to durable rows (issue #17 H fail-closed linkage). */
  function persistFixtureEvidence(runId: string, evidence: ClassificationEvidence[]): void {
    if (evidence.length === 0) return;
    const db = getDb();
    const sku = evidence[0].productSku;
    const stmt = db.prepare(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of evidence) {
      stmt.run(
        e.id, runId, sku, e.stageName, e.source, e.reliability, e.attributeId ?? null,
        e.sourceUrl ?? null, e.sourceField ?? null, e.snippet ?? null,
        JSON.stringify(e.value ?? null), JSON.stringify(e.metadata ?? {}), e.capturedAt,
      );
    }
  }
  const BASELINE_CURATION_TARGETS = [
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: true, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: true, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
  ];

  beforeAll(() => {
    // P0 taxonomy freeze: this suite writes a legacy config, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-class-test-${workspaceId.slice(0, 8)}`);
    const dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(dbPath);
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'test', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });

    const now = '2026-08-01T12:00:00.000Z';
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [
        { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
      ],
      attributes: [
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeProfiles: [
        { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dry Dog Food Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
      ],
      attributeMappings: [
        { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: BASELINE_CURATION_TARGETS,
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
      dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  }, 60000);

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
  });

  it('loads classification config and verifies cached reads', () => {
    const config = loadClassificationConfig(workspacePath);
    expect(config.productTypes.length).toBe(1);
    expect(config.attributes.length).toBe(1);
    expect(getCachedProductTypes(workspaceId).length).toBe(1);
    expect(getCachedAttributes(workspaceId).length).toBe(1);
  });

  it('uses canonical SHA-256 for new snapshots while matching exact historical signed-decimal hashes', () => {
    const config = loadClassificationConfig(workspacePath);
    const canonical = computeConfigHash(config);
    const legacy = computeLegacyConfigHash(config);
    expect(canonical).toMatch(/^[a-f0-9]{64}$/);
    // Fixed regression vector for the exact signed-decimal algorithm used by
    // historical persisted snapshots. Do not derive this expectation from the
    // implementation under test.
    expect(legacy).toBe('-606658189');
    expect(canonical).not.toBe(legacy);
    expect(configHashMatches(config, canonical)).toBe(true);
    expect(configHashMatches(config, legacy)).toBe(true);
    expect(configHashMatches(config, 'deadbeef')).toBe(false);
    expect(configHashMatches(config, 'not-a-hash')).toBe(false);
    expect(configHashMatches({ ...config, productTypes: [] }, canonical)).toBe(false);

    const snapshot = createConfigSnapshot(workspaceId, config);
    expect(snapshot.hash).toBe(canonical);
    const row = getDb().query('SELECT snapshot_hash, config_json FROM classification_config_snapshots WHERE id = ?')
      .get(snapshot.id) as { snapshot_hash: string; config_json: string };
    expect(row.snapshot_hash).toBe(canonical);
    expect(JSON.parse(row.config_json)).toEqual(config);
  });

  it('accepts the fixed historical hash through both catalog drift consumers end to end', async () => {
    const historicalHash = '-606658189';
    const sku = 'LEGACY-DRIFT-CONSUMER';
    const run = createRun(workspaceId, sku, null, historicalHash, { sourceKind: 'catalog_product' });
    completeRun(run.id, 'completed');

    const app = new Hono();
    app.route('/api', catalogClassificationRoutes);
    const detail = await app.request(`/api/products/${sku}/classification`);
    expect(detail.status).toBe(200);
    expect((await detail.json() as { configDrift: boolean }).configDrift).toBe(false);

    writeProductFile(workspacePath, {
      sku,
      name: 'Legacy drift test product',
      customFields: {},
      shopsite: { preserved: { unknownElements: {}, advancedBlocks: {} } },
    } as unknown as Parameters<typeof writeProductFile>[1]);
    await expect(applyCatalogClassification(workspacePath, workspaceId, sku, run.id))
      .rejects.toThrow('No accepted proposals to apply.');
  });

  it('abstains from category page proposals without a reviewed Product Type and verified Page catalog', async () => {
    upsertPage({ name: 'Dog Food', fileName: 'dog-food.html', parentId: null, pageHash: 'abc', lastSyncedAt: null });
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-1', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-1', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dog Food Chicken', value: 'Dog Food Chicken', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    // Product Type target is enabled and no accepted type exists, so page
    // proposals abstain (reviewed type + verified Page catalog required).
    const result = await runPipeline([evidenceExtractionStage, categoryPageProposalsStage], { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } }, { sku: 'TEST-SKU-1', evidence, acceptedProposals: [], allProposals: [] });
    const pageProposals = result.proposals.filter(p => p.proposalType === 'category_page');
    expect(pageProposals.length).toBe(0);
    const abstentions = result.proposals.filter(p => p.proposalType === 'reviewable_abstention');
    expect(abstentions.length).toBeGreaterThanOrEqual(1);
  });

  it('produces attribute proposals via alias matching', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-2', snapId, snapHash);
    const acceptedType = { id: randomUUID(), runId: run.id, productSku: 'TEST-SKU-2', proposalType: 'primary_product_type' as const, targetId: 'dry-dog-food', proposedValue: {}, confidence: 1, evidenceIds: [], status: 'accepted' as const, isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: new Date().toISOString() };
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-2', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Beef Recipe', value: 'Beef Recipe', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-2', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with Chicken and Lamb', value: 'Made with Chicken and Lamb', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    persistFixtureEvidence(run.id, evidence);
    const result = await runPipeline([evidenceExtractionStage, primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage], { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } }, { sku: 'TEST-SKU-2', evidence, acceptedProposals: [acceptedType], allProposals: [] });
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThan(0);
    recordDecision({ id: randomUUID(), proposalId: fieldProposals[0].id, decision: 'accepted', revisedFromId: null, reviewerId: null, reviewerNote: null, revisedValue: null, revisedTargetId: null, decisionKey: null, supersededAt: null, createdAt: new Date().toISOString() });
    expect(getAcceptedProposals('TEST-SKU-2', run.id).length).toBeGreaterThan(0);
  });

  it('distributor evidence passes through reviewable classification without official labeling or null-URL violation', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-DIST', snapId, snapHash);
    const distMeta = {
      provenance: 'distributor_record',
      sourcingGenerationId: 'gen-dist-1',
      acceptedEvidenceAttemptIds: ['a2', 'a1'],
      acceptedProviderIds: ['bci', 'phillips'],
      distributorEvidenceHash: 'a'.repeat(64),
      fieldProvenance: { title: 'phillips' },
    };
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-DIST', attributeId: null, source: 'distributor_record' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Distributor Dog Food Chicken 20 lb', value: 'Distributor Dog Food Chicken 20 lb', metadata: distMeta, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-DIST', attributeId: null, source: 'distributor_record' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'weight', snippet: '20 lb', value: '20 lb', metadata: distMeta, capturedAt: new Date().toISOString() },
    ];
    persistFixtureEvidence(run.id, evidence);
    const result = await runPipeline(
      [evidenceExtractionStage, primaryProductTypeStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-DIST', evidence, acceptedProposals: [], allProposals: [] },
    );
    // Reviewable outcome: a primary-product-type proposal or a reviewable
    // abstention — never a silent bypass.
    expect(result.proposals.some(p => p.proposalType === 'primary_product_type' || p.proposalType === 'reviewable_abstention')).toBe(true);

    // Persisted evidence is truthful: distributor_record source, NULL
    // classification URL, never elevated to official_product_page.
    const persisted = getEvidenceByRun(run.id);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every(e => e.source === 'distributor_record')).toBe(true);
    expect(persisted.every(e => e.sourceUrl === null)).toBe(true);
    expect(persisted.some(e => e.source === 'official_product_page')).toBe(false);
  });

  it('name consolidation stage returns metadata without field_assignment proposals', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-NAME', snapId, snapHash);
    const evidence = [
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-NAME',
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'name',
        snippet: 'Dr. Marty Bark Stoppers Digestion Formula 16 oz',
        value: 'Dr. Marty Bark Stoppers Digestion Formula 16 oz',
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-NAME',
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'brand',
        snippet: 'Dr. Marty',
        value: 'Dr. Marty',
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: new Date().toISOString(),
      },
    ];
    // Run nameConsolidationStage directly (without evidenceExtractionStage which
    // would abstain and create a reviewable_abstention proposal on this test DB)
    const result = await runPipeline(
      [nameConsolidationStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-NAME', evidence, acceptedProposals: [], allProposals: [] },
    );

    // name_consolidation should produce metadata without field_assignment proposals
    const nameMeta = result.stageOutputs.name_consolidation?.metadata as Record<string, unknown> | undefined;
    expect(nameMeta).toBeDefined();
    expect(nameMeta!.curatedTitle).toBeDefined();
    expect(nameMeta!.titleSource).toBeDefined();
    expect(typeof nameMeta!.curatedTitle).toBe('string');

    // Name consolidation produces no field_assignment proposals
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBe(0);
  });

  it('withholds type-gated attribute proposals while Product Type is pending (no accepted proposals)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-PROV', snapId, snapHash);
    const evidence = [
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-PROV',
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'name',
        snippet: 'Beef Recipe Dry Dog Food',
        value: 'Beef Recipe Dry Dog Food',
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-PROV',
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'description',
        snippet: 'Made with real Beef, Chicken, and Lamb',
        value: 'Made with real Beef, Chicken, and Lamb',
        metadata: { provenance: 'web_scrape' },
        capturedAt: new Date().toISOString(),
      },
    ];

    // Run pipeline WITHOUT any accepted proposals — a pending (provisional)
    // Product Type guess must NOT unlock decision-eligible type-gated
    // attribute proposals (fail-closed first pass).
    persistFixtureEvidence(run.id, evidence);
    const result = await runPipeline(
      [
        evidenceExtractionStage,
        primaryProductTypeStage,
        attributeApplicabilityStage,
        productAttributeProposalsStage,
      ],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-PROV', evidence, acceptedProposals: [], allProposals: [] },
    );

    // Should have a primary_product_type proposal (pending)
    const typeProposals = result.proposals.filter(p => p.proposalType === 'primary_product_type');
    expect(typeProposals.length).toBeGreaterThanOrEqual(1);
    expect(typeProposals[0].status).toBe('pending');

    // NO decision-eligible field assignments while the type is pending.
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBe(0);
    const flavorProposal = fieldProposals.find(p => p.targetId === 'flavor');
    expect(flavorProposal).toBeUndefined();
  });

  it('produces type-gated attribute proposals only after the Product Type is accepted (reviewed facts carry forward)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-REVIEWED', snapId, snapHash, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'src-hash-reviewed',
    });
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-REVIEWED', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Beef Recipe Dry Dog Food', value: 'Beef Recipe Dry Dog Food', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-REVIEWED', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with real Beef, Chicken, and Lamb', value: 'Made with real Beef, Chicken, and Lamb', metadata: {}, capturedAt: new Date().toISOString() },
    ];

    // Build + persist a runtime snapshot whose reviewed facts carry an
    // accepted 'dry-dog-food' decision, then run the pipeline against it.
    const runtime = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: 'TEST-SKU-REVIEWED',
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'src-hash-reviewed',
    });
    persistRuntimeSnapshot(runtime);

    // The accepted type must flow in as an in-run accepted proposal so the
    // gating logic sees a reviewed type (facts alone are also honored).
    const acceptedType = { id: randomUUID(), runId: run.id, productSku: 'TEST-SKU-REVIEWED', proposalType: 'primary_product_type' as const, targetId: 'dry-dog-food', proposedValue: { productTypeId: 'dry-dog-food' }, confidence: 1, evidenceIds: [], status: 'accepted' as const, isBulkAcceptable: false, isStale: false, stalenessReason: null, snapshotHash: runtime.snapshotHash, createdAt: new Date().toISOString() };

    persistFixtureEvidence(run.id, evidence);
    const result = await runPipeline(
      [primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() }, snapshot: runtime },
      { sku: 'TEST-SKU-REVIEWED', evidence, acceptedProposals: [acceptedType], allProposals: [] },
    );

    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThanOrEqual(1);
    const flavorProposal = fieldProposals.find(p => p.targetId === 'flavor');
    expect(flavorProposal).toBeDefined();
    expect(flavorProposal!.status).toBe('pending');
    expect(flavorProposal!.snapshotHash).toBe(runtime.snapshotHash);
  });

  it('uses live-store curation target options for a selected ProductField', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: 'ProductField24',
      label: 'Product Field 24',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Curation',
      sampleValuesJson: null,
      createdAt: now,
      updatedAt: now,
    });
    db.run(
      `INSERT OR REPLACE INTO product_index
       (id, sku, file_path, title, status, product_hash, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'LIVE-OPT-1', 'products/live-opt-1.json', 'Existing Cat Toy', 'active', 'hash-live-1', JSON.stringify({ ProductField24: 'Cat Toys' }), now, now],
    );
    db.run(
      `INSERT OR REPLACE INTO product_index
       (id, sku, file_path, title, status, product_hash, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'LIVE-OPT-2', 'products/live-opt-2.json', 'Existing Dog Food', 'active', 'hash-live-2', JSON.stringify({ ProductField24: 'Dog Food' }), now, now],
    );

    const current = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, {
      ...current,
      productTypes: [],
      attributeProfiles: [],
      attributes: [
        ...current.attributes.filter(a => a.id !== 'field-productfield24'),
        { id: 'field-productfield24', name: 'Product Field 24', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Curation' },
      ],
      attributeMappings: [
        ...current.attributeMappings.filter(m => m.attributeId !== 'field-productfield24'),
        { id: 'field-productfield24-mapping', attributeId: 'field-productfield24', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'target-productfield24', kind: 'product_field' as const, label: 'Product Field 24', enabled: true, selectionMode: 'single' as const, attributeId: 'field-productfield24', catalogField: 'ProductField24', optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 0 },
      ],
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-24', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-24', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Premium Cat Toys assortment', value: 'Premium Cat Toys assortment', metadata: {}, capturedAt: now },
    ];
    persistFixtureEvidence(run.id, evidence);

    const result = await runPipeline(
      [productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: now } },
      { sku: 'TEST-SKU-24', evidence, acceptedProposals: [], allProposals: [] },
    );

    const proposal = result.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'field-productfield24');
    expect(proposal?.proposedValue).toBe('Cat Toys');
  });

  it('discovers ProductField candidates from product_index even when field_registry is incomplete', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert a product with ProductField24 (which is NOT in field_registry)
    db.run(
      `INSERT OR REPLACE INTO product_index
       (id, sku, file_path, title, status, product_hash, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'DISCOVER-24', 'products/discover-24.json', 'Field 24 Product', 'active', 'hash-disc-24', JSON.stringify({ ProductField24: 'Cat Toys', ProductField16: 'Pet Brands' }), now, now],
    );

    const config = loadClassificationConfig(workspacePath);
    const candidates = listCurationTargetCandidates(workspaceId, config);

    // ProductField24 should appear as a candidate even beyond the initial
    // registry set (it was upserted in the previous test, but the point is
    // that fields discovered from product_index.custom_fields are included).
    const pf24 = candidates.productFields.find(f => f.catalogField === 'ProductField24');
    expect(pf24).toBeDefined();
    expect(pf24!.values).toContain('Cat Toys');

    // Fields discovered from catalog data that were never in the registry
    // (ProductField16 came only from the product we inserted, not from registry).
    expect(candidates.productFields.length).toBeGreaterThanOrEqual(2);
  });

  it('page candidates include only verified ShopSite-synced pages from the active import (name-deduped)', () => {
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: 'f'.repeat(64),
      parserFormatVersion: 'shopsite-pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid', key: 'p1', status: 'verified' }, name: '##FaceBook Store', parentRef: null, availability: 'available' },
        { identity: { kind: 'exported_guid', key: 'p2', status: 'verified' }, name: '##FaceBook Store', parentRef: null, availability: 'available' },
        { identity: { kind: 'exported_guid', key: 'p3', status: 'verified' }, name: 'Dog Food', parentRef: null, availability: 'available' },
      ],
      activatedBy: 'test',
    });
    // Provisional name-only row (ProductOnPages fragment scan) — review
    // context only, must never surface as a curation candidate.
    upsertPage({ name: 'Ghost Page', fileName: null, parentId: null, lastSyncedAt: null, pageHash: 'g'.repeat(64) });

    const config = loadClassificationConfig(workspacePath);
    const candidates = listCurationTargetCandidates(workspaceId, config);
    const pageNames = candidates.pages.map(page => page.label);

    expect(pageNames).toContain('Dog Food');
    // Distinct GUIDs sharing a display name collapse to one option.
    expect(pageNames.filter(name => name === '##FaceBook Store').length).toBe(1);
    expect(pageNames).not.toContain('Ghost Page');
  });

  it('migrates legacy product types to classification config', () => {
    const db = getDb();
    const ltId = randomUUID();
    const now = new Date().toISOString();
    db.run('INSERT INTO product_types (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [ltId, workspaceId, 'Wet Cat Food', now, now]);
    db.run('INSERT INTO product_type_fields (id, product_type_id, xml_field, label, data_type, required, validation_rules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), ltId, 'CustomField1', 'Flavor', 'string', 1, null, now, now]);
    const result = migrateLegacyToClassificationConfig(workspacePath, workspaceId, true);
    expect(result).not.toBeNull();
    expect(result!.productTypes.length).toBeGreaterThanOrEqual(1);
    expect(result!.attributes.length).toBeGreaterThanOrEqual(1);
    expect(result!.attributeProfiles.length).toBeGreaterThanOrEqual(1);
    expect(result!.attributeMappings.length).toBeGreaterThanOrEqual(1);
  });

  it('disabled product type target skips primary product type proposal', async () => {
    // Save a config with page target only (no product_type target)
    const current = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, {
      ...current,
      curationTargets: [
        { id: 'test-pages-only', kind: 'page', label: 'Test Pages', enabled: true, selectionMode: 'multiple', attributeId: null, catalogField: null, optionSource: 'live_store', required: false, mandatory: false, sortOrder: 0 },
      ],
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-NOPT', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-NOPT', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dry Dog Food Chicken Recipe', value: 'Dry Dog Food Chicken Recipe', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    persistFixtureEvidence(run.id, evidence);
    const result = await runPipeline(
      [evidenceExtractionStage, primaryProductTypeStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-NOPT', evidence, acceptedProposals: [], allProposals: [] },
    );

    const typeProposals = result.proposals.filter(p => p.proposalType === 'primary_product_type');
    expect(typeProposals.length).toBe(0);

    // Restore original config for subsequent tests
    const restored = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, { ...restored, curationTargets: BASELINE_CURATION_TARGETS });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  });

  it('product field proposals work without product type target', async () => {
    // Save an explicit config with product_field target but no product_type,
    // so we are not affected by any prior test's config mutations.
    const now = new Date().toISOString();
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [],
      attributes: [
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'test-flavor-only', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
      ],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama' as const, defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
      dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-FIELDONLY', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-FIELDONLY', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Chicken Recipe Dry Dog Food', value: 'Chicken Recipe Dry Dog Food', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-FIELDONLY', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with real Chicken', value: 'Made with real Chicken', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    persistFixtureEvidence(run.id, evidence);
    const result = await runPipeline(
      [productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-FIELDONLY', evidence: evidence, acceptedProposals: [], allProposals: [] },
    );

    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Fail-closed tests ─────────────────────────────────────────────────

  it('aborts pipeline when a stage returns failed status; downstream stage is not called', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-FAIL', snapId, snapHash);

    let stage3Called = false;

    const okStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'succeeded' as const,
        output: { evidence: [], proposals: [], abstained: false, metadata: { dummy: true } },
      }),
    };

    const failingStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'failed' as const,
        error: 'Intentional test failure',
      }),
    };

    const spyStage: import('../../classification/types').StageDefinition = {
      name: 'attribute_applicability',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        stage3Called = true;
        return { status: 'succeeded' as const, output: { evidence: [], proposals: [], abstained: false } };
      },
    };

    await expect(
      runPipeline(
        [okStage, failingStage, spyStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'TEST-SKU-FAIL', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow('Intentional test failure');

    expect(stage3Called).toBe(false);

    // One failed stage result recorded for the failing stage
    const stageResults = getStageResults(run.id);
    const failResults = stageResults.filter((sr: any) => sr.stage_name === 'primary_product_type_proposal');
    expect(failResults.length).toBe(1);
    expect(failResults[0].status).toBe('failed');
    expect(failResults[0].error_message).toContain('Intentional test failure');

    // The preceding stage should have a succeeded result
    const okResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation');
    expect(okResults.length).toBe(1);
    expect(okResults[0].status).toBe('succeeded');

    // The spy stage should have no result (never executed)
    const spyResults = stageResults.filter((sr: any) => sr.stage_name === 'attribute_applicability');
    expect(spyResults.length).toBe(0);
  });

  it('aborts pipeline when a stage throws; downstream stage is not called, only one failed result recorded', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-THROW', snapId, snapHash);

    let downstreamCalled = false;

    const throwingStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        throw new Error('Kaboom from stage');
      },
    };

    const spyStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        downstreamCalled = true;
        return { status: 'succeeded' as const, output: { evidence: [], proposals: [], abstained: false } };
      },
    };

    await expect(
      runPipeline(
        [throwingStage, spyStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'TEST-SKU-THROW', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow('Kaboom from stage');

    expect(downstreamCalled).toBe(false);

    // Exactly one failed result for the throwing stage (no double-record)
    const stageResults = getStageResults(run.id);
    const failResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation' && sr.status === 'failed');
    expect(failResults.length).toBe(1);
    expect(failResults[0].error_message).toContain('Kaboom from stage');

    // Downstream stage has no result
    const spyResults = stageResults.filter((sr: any) => sr.stage_name === 'primary_product_type_proposal');
    expect(spyResults.length).toBe(0);
  });

  it('abstaining stage persists reviewable_abstention proposal and returns it in-memory', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-ABSTAIN', snapId, snapHash);

    const abstainingStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'abstained' as const,
        reason: 'No evidence for name consolidation',
      }),
    };

    const result = await runPipeline(
      [abstainingStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-ABSTAIN', evidence: [], acceptedProposals: [], allProposals: [] },
    );

    // In-memory result includes the abstention proposal
    const abstentions = result.proposals.filter(p => p.proposalType === 'reviewable_abstention');
    expect(abstentions.length).toBe(1);
    expect(abstentions[0].targetId).toBe('name_consolidation');
    expect(abstentions[0].proposedValue).toEqual({ reason: 'No evidence for name consolidation' });

    // Stage result recorded as abstained
    const stageResults = getStageResults(run.id);
    const abstainedResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation');
    expect(abstainedResults.length).toBe(1);
    expect(abstainedResults[0].status).toBe('abstained');
    expect(abstainedResults[0].error_message).toContain('No evidence for name consolidation');

    // Abstention proposal is persisted to the database
    const persisted = getProposalsByRun(run.id);
    const persistedAbstentions = persisted.filter(p => p.proposalType === 'reviewable_abstention');
    expect(persistedAbstentions.length).toBe(1);
    expect(persistedAbstentions[0].targetId).toBe('name_consolidation');
  });

  it('rejects pipeline when evidence/proposal persistence fails due to PK conflict; downstream not called, one failed result', async () => {
    const CONFLICT_ID = '00000000-0000-0000-0000-0000000000cc';

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-PKCONF', snapId, snapHash);

    // Pre-insert a proposal with the hardcoded ID so the stage's persist attempt fails.
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, evidence_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [CONFLICT_ID, run.id, 'TEST-SKU-PKCONF', 'field_assignment', 'flavor', '{}', 0.5, 'pending', 0, 0, null, null, '[]', now],
    );

    const producingStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [{
            id: randomUUID(),
            runId: run.id,
            stageName: 'name_consolidation' as const,
            productSku: 'TEST-SKU-PKCONF',
            attributeId: null,
            source: 'spreadsheet' as const,
            reliability: 'medium' as const,
            sourceUrl: null,
            sourceField: 'name',
            snippet: 'Test',
            value: 'Test',
            metadata: {},
            capturedAt: new Date().toISOString(),
          }],
          proposals: [{
            id: CONFLICT_ID,
            runId: run.id,
            productSku: 'TEST-SKU-PKCONF',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.9,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: true,
            isStale: false,
            stalenessReason: null,
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
          metadata: {},
        },
      }),
    };

    let downstreamCalled = false;
    const spyStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        downstreamCalled = true;
        return { status: 'succeeded' as const, output: { evidence: [], proposals: [], abstained: false } };
      },
    };

    await expect(
      runPipeline(
        [producingStage, spyStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'TEST-SKU-PKCONF', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow();

    expect(downstreamCalled).toBe(false);

    // One failed result recorded for the producing stage
    const stageResults = getStageResults(run.id);
    const failResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation' && sr.status === 'failed');
    expect(failResults.length).toBe(1);

    // No succeeded result or stage evidence survived the rolled-back transaction.
    const succeededResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation' && sr.status === 'succeeded');
    expect(succeededResults.length).toBe(0);
    const persistedEvidence = db.query(
      'SELECT COUNT(*) AS count FROM classification_evidence WHERE run_id = ? AND stage_name = ?',
    ).get(run.id, 'name_consolidation') as { count: number };
    expect(persistedEvidence.count).toBe(0);

    // The downstream spy was not called
    const spyResults = stageResults.filter((sr: any) => sr.stage_name === 'primary_product_type_proposal');
    expect(spyResults.length).toBe(0);
  });

  function createReviewGateItem(suffix: string) {
    const batch = createBatch({
      workspaceId,
      name: `Review Gate ${suffix}`,
      fileName: `${suffix}.xlsx`,
      totalItems: 1,
    });
    return insertItems(batch.id, [{
      upc: `GATE-${suffix}`,
      name: `Gate Product ${suffix}`,
      rowNumber: 1,
    }])[0];
  }

  function seedReviewProposal(runId: string, sku: string, status: string = 'pending'): string {
    const id = randomUUID();
    getDb().run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, is_bulk_acceptable, is_stale, created_at)
       VALUES (?, ?, ?, 'category_page', 'Dog Food', ?, 0.8, ?, 1, 0, ?)`,
      [id, runId, sku, JSON.stringify({ pageName: 'Dog Food' }), status, new Date().toISOString()],
    );
    return id;
  }

  const decide = (proposalId: string, decision: 'accepted' | 'rejected' | 'deferred') => {
    recordDecision({
      id: randomUUID(),
      proposalId,
      decision,
      revisedFromId: null,
      reviewerId: 'test-reviewer',
      reviewerNote: null,
      revisedValue: null,
      revisedTargetId: null,
      decisionKey: null,
      supersededAt: null,
      createdAt: new Date().toISOString(),
    });
  };



  it('blocks review completion when proposals are pending or missing decisions', () => {
    const item = createReviewGateItem('PENDING');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    seedReviewProposal(run.id, item.upc, 'pending');

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('pending_proposals');
  });

  it('allows an exact completed active run only after every proposal has a decision', () => {
    const item = createReviewGateItem('PASS');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed_with_abstentions');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    decide(seedReviewProposal(run.id, item.upc), 'deferred');
    // Universal Category Page requirement: review never completes without an
    // assignment resolving into the active verified import.
    writeCurationData(item.id, { suggestedPages: ['Dog Food'] });

    expect(validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: item.id,
      productSku: item.upc,
      activeRunId: run.id,
    })).toEqual({ ok: true, proposalCount: 2 });
  });

  it('fails closed for null or wrong onboarding item ownership', () => {
    const item = createReviewGateItem('OWNERSHIP');
    const db = getDb();
    const nullRunId = randomUUID();
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, NULL, ?, 'completed', ?, ?)`,
      [nullRunId, workspaceId, item.upc, new Date().toISOString(), new Date().toISOString()],
    );
    const nullGate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: nullRunId });
    expect(nullGate.ok).toBe(false);
    if (!nullGate.ok) expect(nullGate.code).toBe('item_mismatch');

    const otherItem = createReviewGateItem('OTHEROWNER');
    const wrongRun = createRun(workspaceId, item.upc, null, null, otherItem.id);
    completeRun(wrongRun.id, 'completed');
    const wrongGate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: wrongRun.id });
    expect(wrongGate.ok).toBe(false);
    if (!wrongGate.ok) expect(wrongGate.code).toBe('item_mismatch');
  });

  it('prevents concurrent running runs but allows a later run after terminal completion', () => {
    const item = createReviewGateItem('ACTIVEUNIQUE');
    const first = createRun(workspaceId, item.upc, null, null, item.id);
    expect(() => createRun(workspaceId, item.upc, null, null, item.id)).toThrow();

    completeRun(first.id, 'failed', 'test failure');
    const later = createRun(workspaceId, item.upc, null, null, item.id);
    expect(later.status).toBe('running');
    completeRun(later.id, 'completed');
  });

  // ─── PR9 C3 (issue #30, DECISION-C): the cohort semantic validation gate ──

  /** Write an item's curation_data_json directly (raw SQL, no schema parse). */
  function writeCurationData(itemId: string, curationData: Record<string, unknown>): void {
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(curationData), new Date().toISOString(), itemId],
    );
  }

  it('refuses an item whose semanticValidation is blocked (code + first finding reason)', () => {
    const item = createReviewGateItem('BLOCKED');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    writeCurationData(item.id, {
      curatedTitle: 'Some Title',
      classificationRunId: run.id,
      semanticValidation: {
        status: 'blocked',
        findings: [
          { code: 'family_product_type', memberSku: item.upc, message: 'Primary Product Type "dog-treats" does not match the family invariant.' },
          { code: 'family_brand', memberSku: item.upc, message: 'Brand conflict.' },
        ],
      },
    });

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('semantic_validation_blocked');
      expect(gate.reason).toContain('family invariant');
    }
  });

  it('passes an item whose semanticValidation is passed', () => {
    const item = createReviewGateItem('PASSED-SEM');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    writeCurationData(item.id, {
      curatedTitle: 'Some Title',
      classificationRunId: run.id,
      suggestedPages: ['Dog Food'],
      semanticValidation: { status: 'passed', findings: [] },
    });

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(true);
  });

  it('fails closed on corrupt curation data JSON (never review-ready)', () => {
    const item = createReviewGateItem('CORRUPT-SEM');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      ['{corrupt json', item.id],
    );

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('semantic_validation_blocked');
      expect(gate.reason).toMatch(/corrupt/i);
    }
  });

  it('passes a legacy item with curation data but no semanticValidation key', () => {
    const item = createReviewGateItem('LEGACY-SEM');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    writeCurationData(item.id, {
      curatedTitle: 'Some Title',
      classificationRunId: run.id,
      suggestedPages: ['Dog Food'],
    });

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(true);
  });

  it('defaults isBulkAcceptable to false on all proposals even with high confidence (Issue #10)', async () => {
    const { buildCategoryPageProposal, buildFieldAssignmentProposal, buildProductTypeProposal } = await import('../../classification/curation-target-proposal');

    const typeProp = buildProductTypeProposal({
      runId: randomUUID(),
      sku: '12345',
      productTypeId: 'dog-food',
      confidence: 0.99,
      evidenceIds: [],
    });
    expect(typeProp.isBulkAcceptable).toBe(false);

    const fieldProp = buildFieldAssignmentProposal({
      runId: randomUUID(),
      sku: '12345',
      attributeId: 'brand',
      value: 'Acme',
      confidence: 0.95,
      evidenceIds: [],
      isMultiple: false,
    });
    expect(fieldProp.isBulkAcceptable).toBe(false);

    const pageProp = buildCategoryPageProposal({
      runId: randomUUID(),
      sku: '12345',
      pageName: 'Dog Food',
      confidence: 0.90,
      evidenceIds: [],
    });
    expect(pageProp.isBulkAcceptable).toBe(false);
  });

  it('inherits catalog_product source for catalog product description and bullet point evidence', async () => {
    const { extractProductEvidence } = await import('../../classification/product-evidence-extractor');
    const result = await extractProductEvidence(
      {
        title: 'Catalog Kibble',
        brand: 'Acme',
        weight: '5 lb',
        description: 'Rich in protein for adult dogs.',
        bulletPoints: ['High protein', 'Grain free'],
        searchKeywords: null,
        customFields: {},
        primaryImage: null,
        additionalImages: [],
        sourceUrl: null,
        workspacePath,
        existingPageNames: [],
      },
      {
        sku: 'CATALOG-SKU-1',
        sourceKind: 'catalog_product',
        evidence: [],
        acceptedProposals: [],
        allProposals: [],
      },
      {
        workspaceId,
        runId: randomUUID(),
        workspacePath,
        configSnapshotRef: { id: 'test-snapshot', hash: 'abc', sourceCommit: null, createdAt: new Date().toISOString() },
      },
    );

    const desc = result.evidence.find(e => e.sourceField === 'description');
    expect(desc).toBeDefined();
    expect(desc?.source).toBe('catalog_product');

    const bullet = result.evidence.find(e => e.sourceField === 'bullet_point');
    expect(bullet).toBeDefined();
    expect(bullet?.source).toBe('catalog_product');
  });

  it('preserves catalog_product sourceKind through runPipeline stage input propagation', async () => {
    const pipelineRun = createRun(workspaceId, 'RUNPIPELINE-CATALOG-SKU', null, null, { sourceKind: 'catalog_product' });
    const stageInput = {
      sku: 'RUNPIPELINE-CATALOG-SKU',
      sourceKind: 'catalog_product' as const,
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    };
    const context = {
      workspaceId,
      runId: pipelineRun.id,
      workspacePath,
      configSnapshotRef: { id: 'test-snapshot', hash: 'abc', sourceCommit: null, createdAt: new Date().toISOString() },
    };

    const res = await runPipeline([evidenceExtractionStage], context, stageInput);
    expect(res.evidence).toBeDefined();

    const evidence = getEvidenceByRun(pipelineRun.id);
    const descEvidence = evidence.find(e => e.sourceField === 'description');
    if (descEvidence) {
      expect(descEvidence.source).toBe('catalog_product');
    }
  });

  it('persists ocrOutcome in classification_stage_results output_json even when evidence stage abstains', async () => {
    const item = createReviewGateItem('ABSTAIN-OCR-SKU');
    const db = getDb();
    db.run("UPDATE onboarding_items SET name = '', expected_name = null, brand_hint = null, extraction_data_json = ? WHERE id = ?", [
      JSON.stringify({ title: null, brand: null, description: null, primaryImage: null }),
      item.id,
    ]);
    const run = createRun(workspaceId, item.upc, null, null, { onboardingItemId: item.id, sourceKind: 'onboarding' });
    const stageInput = {
      sku: item.upc,
      onboardingItemId: item.id,
      sourceKind: 'onboarding' as const,
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    };
    const context = {
      workspaceId,
      runId: run.id,
      workspacePath,
      configSnapshotRef: { id: 'test-snapshot', hash: 'abc', sourceCommit: null, createdAt: new Date().toISOString() },
    };

    await runPipeline([evidenceExtractionStage], context, stageInput);
    const stageResults = getStageResults(run.id);
    const evStage = stageResults.find((s: any) => s.stage_name === 'evidence_extraction');
    expect(evStage).toBeDefined();
    expect(evStage?.output_json).not.toBeNull();
    const parsedOutput = JSON.parse(evStage!.output_json!);
    expect(parsedOutput.metadata?.ocrOutcome).toBeDefined();
  });

  it('rejects a tampered frozen snapshot at run start (fail closed)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const runtime = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: 'TAMPER-SKU',
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'src-hash-tamper',
    });
    persistRuntimeSnapshot(runtime);

    const run = createRun(workspaceId, 'TAMPER-SKU', null, runtime.snapshotHash, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'src-hash-tamper',
    });

    // Mutate a frozen node: strict mode throws on write, but a structuredClone
    // tamper bypasses Object.freeze — the pipeline's recompute must catch it.
    const tampered = structuredClone(runtime);
    tampered.searchKeywords = 'injected';

    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TAMPER-SKU', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Beef', value: 'Beef', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    await expect(
      runPipeline(
        [primaryProductTypeStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() }, snapshot: tampered },
        { sku: 'TAMPER-SKU', evidence, acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow(/snapshot hash mismatch/i);
  });

  it('rejects stage output whose proposal runId does not match the run (fail closed)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'RUNID-SKU', snapId, snapHash);

    const rogueStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId: 'rogue-run',
            productSku: 'RUNID-SKU',
            proposalType: 'primary_product_type' as const,
            targetId: 'dry-dog-food',
            proposedValue: { productTypeId: 'dry-dog-food' },
            confidence: 0.9,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };

    await expect(
      runPipeline(
        [rogueStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'RUNID-SKU', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow(/runId mismatch/i);
  });

  it('category-page stage output is byte-identical when page_index mutates after the snapshot is built', async () => {
    // This test controls its own config: ensure the page target is enabled
    // regardless of any earlier test's on-disk mutations.
    const nowTs = new Date().toISOString();
    const baseConfig = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, {
      ...baseConfig,
      manifest: { ...baseConfig.manifest, updatedAt: nowTs },
      curationTargets: BASELINE_CURATION_TARGETS,
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    // Activate a verified Page import so the page stage has verified options.
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: 'e'.repeat(64),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid', key: '1', status: 'verified' }, name: 'Dog Food', parentRef: null, availability: 'available' },
        { identity: { kind: 'exported_guid', key: '2', status: 'verified' }, name: 'Dog Toys', parentRef: null, availability: 'available' },
      ],
      activatedBy: 'test',
    });
    const pageSnapshot = captureVerifiedPageSnapshot(workspaceId);
    expect(pageSnapshot.pageImportId).not.toBeNull();

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const runtime = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: 'PAGE-SKU',
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'src-hash-page',
      pages: toPageSnapshotState(pageSnapshot),
      pageImportId: pageSnapshot.pageImportId,
      pageImportHash: pageSnapshot.pageImportHash,
    });
    persistRuntimeSnapshot(runtime);

    const makeEvidence = (runId: string) => [
      { id: randomUUID(), runId, stageName: 'evidence_extraction' as const, productSku: 'PAGE-SKU', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dry Dog Food Beef Recipe for dogs', value: 'Dry Dog Food Beef Recipe for dogs', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const makeAcceptedType = (runId: string) => ({ id: randomUUID(), runId, productSku: 'PAGE-SKU', proposalType: 'primary_product_type' as const, targetId: 'dry-dog-food', proposedValue: {}, confidence: 1, evidenceIds: [], status: 'accepted' as const, isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: new Date().toISOString() });

    const runA = createRun(workspaceId, 'PAGE-SKU', null, runtime.snapshotHash, { sourceKind: 'catalog_product', sourceProductHash: 'src-hash-page' });
    const contextA = { workspacePath, workspaceId, runId: runA.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() }, snapshot: runtime };
    const resultA = await runPipeline(
      [categoryPageProposalsStage],
      contextA,
      { sku: 'PAGE-SKU', evidence: makeEvidence(runA.id), acceptedProposals: [makeAcceptedType(runA.id)], allProposals: [] },
    );
    completeRun(runA.id, 'completed');

    // Mutate page_index AFTER the snapshot was frozen: the page stage must
    // read only the frozen verified records.
    getDb().run('UPDATE page_index SET name = ? WHERE identity_key = ?', ['Renamed Food', '1']);
    getDb().run("UPDATE page_index SET availability = 'unavailable' WHERE identity_key = ?", ['2']);

    const runB = createRun(workspaceId, 'PAGE-SKU', null, runtime.snapshotHash, { sourceKind: 'catalog_product', sourceProductHash: 'src-hash-page' });
    const contextB = { workspacePath, workspaceId, runId: runB.id, configSnapshotRef: contextA.configSnapshotRef, snapshot: runtime };
    const resultB = await runPipeline(
      [categoryPageProposalsStage],
      contextB,
      { sku: 'PAGE-SKU', evidence: makeEvidence(runB.id), acceptedProposals: [makeAcceptedType(runB.id)], allProposals: [] },
    );

    const normalize = (p: any) => ({ proposalType: p.proposalType, targetId: p.targetId, proposedValue: p.proposedValue, status: p.status });
    const sortable = (p: any) => `${p.proposalType}:${String(p.targetId)}`;
    const a = resultA.proposals.map(normalize).sort((x: any, y: any) => sortable(x).localeCompare(sortable(y)));
    const b = resultB.proposals.map(normalize).sort((x: any, y: any) => sortable(x).localeCompare(sortable(y)));

    expect(a).toEqual(b);
    // At least one page proposal was produced by the frozen verified catalog.
    expect(a.length).toBeGreaterThan(0);
  });

  it('stage output is unchanged when config/cache/Page rows mutate after the snapshot is built', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const runtime = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: 'SNAP-SKU',
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'src-hash-snap',
    });
    persistRuntimeSnapshot(runtime);

    const makeEvidence = (runId: string) => [
      { id: randomUUID(), runId, stageName: 'evidence_extraction' as const, productSku: 'SNAP-SKU', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dry Dog Food Beef Recipe', value: 'Dry Dog Food Beef Recipe', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const makeAcceptedType = (runId: string) => ({ id: randomUUID(), runId, productSku: 'SNAP-SKU', proposalType: 'primary_product_type' as const, targetId: 'dry-dog-food', proposedValue: {}, confidence: 1, evidenceIds: [], status: 'accepted' as const, isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: new Date().toISOString() });

    const runA = createRun(workspaceId, 'SNAP-SKU', null, runtime.snapshotHash, { sourceKind: 'catalog_product', sourceProductHash: 'src-hash-snap' });
    const contextA = { workspacePath, workspaceId, runId: runA.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() }, snapshot: runtime };
    const evidenceA = makeEvidence(runA.id);
    persistFixtureEvidence(runA.id, evidenceA);
    const resultA = await runPipeline(
      [primaryProductTypeStage, productAttributeProposalsStage],
      contextA,
      { sku: 'SNAP-SKU', evidence: evidenceA, acceptedProposals: [makeAcceptedType(runA.id)], allProposals: [] },
    );
    completeRun(runA.id, 'completed');

    // Mutate the on-disk config, the derived cache, and Page rows AFTER the
    // snapshot was built and frozen. The snapshot path must ignore all of it.
    saveClassificationConfig(workspacePath, {
      ...config,
      manifest: { ...config.manifest, updatedAt: '2026-09-01T12:00:00.000Z' },
      productTypes: [...config.productTypes, { id: 'cat-food', name: 'Cat Food', description: null, attributeProfileId: null, oldIdAliases: [] }],
      attributes: [],
      attributeProfiles: [],
      attributeMappings: [],
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
    upsertPage({ name: 'Injected Page', fileName: 'injected.html', parentId: null, pageHash: 'zzz', lastSyncedAt: null });

    const runB = createRun(workspaceId, 'SNAP-SKU', null, runtime.snapshotHash, { sourceKind: 'catalog_product', sourceProductHash: 'src-hash-snap' });
    const contextB = { workspacePath, workspaceId, runId: runB.id, configSnapshotRef: contextA.configSnapshotRef, snapshot: runtime };
    const evidenceB = makeEvidence(runB.id);
    persistFixtureEvidence(runB.id, evidenceB);
    const resultB = await runPipeline(
      [primaryProductTypeStage, productAttributeProposalsStage],
      contextB,
      { sku: 'SNAP-SKU', evidence: evidenceB, acceptedProposals: [makeAcceptedType(runB.id)], allProposals: [] },
    );

    const normalize = (p: any) => ({ proposalType: p.proposalType, targetId: p.targetId, proposedValue: p.proposedValue, status: p.status });
    const sortable = (p: any) => `${p.proposalType}:${String(p.targetId)}`;
    const a = resultA.proposals.map(normalize).sort((x: any, y: any) => sortable(x).localeCompare(sortable(y)));
    const b = resultB.proposals.map(normalize).sort((x: any, y: any) => sortable(x).localeCompare(sortable(y)));

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // Every persisted proposal is bound to its run's snapshot hash.
    const persistedHashes = getDb().query(
      'SELECT config_snapshot_hash FROM classification_proposals WHERE run_id = ?',
    ).all(runB.id) as Array<{ config_snapshot_hash: string | null }>;
    expect(persistedHashes.length).toBeGreaterThan(0);
    expect(persistedHashes.every(row => row.config_snapshot_hash === runtime.snapshotHash)).toBe(true);
  });

  it('draft promoter handles item with missing extractionData gracefully without aborting transaction', async () => {
    const { promoteItems } = await import('../../onboarding/draft-promoter');
    const batch = createBatch({
      workspaceId,
      name: 'Missing Ext Batch',
      fileName: 'test.xlsx',
      totalItems: 1,
    });
    const items = insertItems(batch.id, [{
      upc: 'NO-EXT-DATA-SKU',
      name: 'No Extraction Item',
      rowNumber: 2,
    }]);

    const res = await promoteItems(workspaceId, workspacePath, batch.id, [items[0].id]);
    expect(res.count).toBe(0);
    expect(res.failures.length).toBe(1);
    expect(res.failures[0].error).toBe('Missing extraction data');
  });

  // ── Issue #17 work item E: model-call linkage on persisted proposals ────

  it('persists a proposal whose modelCallIds belong to the run/snapshot', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'SKU-MC-OK', snapId, snapHash);
    // A real model-call row bound to this run + snapshot hash, completed to
    // `success`: only a durable success call can be linked to a persisted
    // proposal (a `started` row is non-terminal and must be rejected).
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: run.id,
      stageName: 'product_attribute_proposals',
      operation: 'attribute_ranking',
      attempt: 1,
      provider: 'ollama',
      model: 'llama3',
      locality: 'local',
      snapshotHash: snapHash,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    const terminalDurable = completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    });
    expect(terminalDurable).toBe(true);

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId: run.id,
            productSku: 'SKU-MC-OK',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            modelCallIds: [callId],
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };

    const result = await runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-MC-OK', evidence: [], acceptedProposals: [], allProposals: [] });
    expect(result.proposals).toHaveLength(1);
    const persisted = getDb().query(
      'SELECT model_call_ids_json FROM classification_proposals WHERE run_id = ?',
    ).all(run.id) as Array<{ model_call_ids_json: string | null }>;
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0].model_call_ids_json ?? '[]')).toEqual([callId]);
  });

  it('rolls back stage persistence when a proposal references a model call from another run/snapshot', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'SKU-MC-BAD', snapId, snapHash);
    // A model call belonging to a DIFFERENT run.
    const otherRun = createRun(workspaceId, 'SKU-OTHER', snapId, snapHash);
    const { insertModelCallStart } = await import('../../db/repositories/classification-model-call-repo');
    const foreignCall = insertModelCallStart({
      runId: otherRun.id,
      stageName: 'product_attribute_proposals',
      operation: 'attribute_ranking',
      attempt: 1,
      provider: 'ollama',
      model: 'llama3',
      locality: 'local',
      snapshotHash: snapHash,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId: run.id,
            productSku: 'SKU-MC-BAD',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            modelCallIds: [foreignCall],
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };

    await expect(runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-MC-BAD', evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
    // No proposal row was persisted (transaction rolled back).
    const persisted = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposals WHERE run_id = ?',
    ).get(run.id) as { c: number };
    expect(persisted.c).toBe(0);
    const stageRows = getStageResults(run.id).filter(s => s.status === 'succeeded');
    expect(stageRows).toHaveLength(0);
  });

  it('rejects a proposal linked to a non-terminal (started) model call and rolls back', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'SKU-MC-STARTED', snapId, snapHash);
    // A model-call row for THIS run/snapshot that is still `started` (never
    // completed): only a durable `success` call can be linked to a persisted
    // proposal.
    const { insertModelCallStart } = await import('../../db/repositories/classification-model-call-repo');
    const startedCall = insertModelCallStart({
      runId: run.id,
      stageName: 'product_attribute_proposals',
      operation: 'attribute_ranking',
      attempt: 1,
      provider: 'ollama',
      model: 'llama3',
      locality: 'local',
      snapshotHash: snapHash,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId: run.id,
            productSku: 'SKU-MC-STARTED',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            modelCallIds: [startedCall],
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };

    await expect(runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-MC-STARTED', evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/non-terminal\/non-success|started/);
    const persisted = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposals WHERE run_id = ?',
    ).get(run.id) as { c: number };
    expect(persisted.c).toBe(0);
  });

  // ── PR7 C6b (issue #30): cohort-coordinated model-call linkage exemption ──
  //
  // The parent ops bind their audited page/title calls to the ORDINAL-0 member
  // child run (DECISION-N), and every member's durable
  // `classification_cohort_outputs` row inherits that call id. A materialized
  // proposal on a NON-ordinal-0 child therefore references a call that
  // belongs to the ordinal-0 child — the ONLY narrow exemption to the
  // run/snapshot check. The call row must still exist and be terminal-success;
  // a resolved output row (same cohort run + same product_sku) is the ONLY
  // way the mismatch is tolerated.

  /** Seed the minimal cohort-authority chain (batch → cohort → parent cohort
   *  run) so child runs can FK to it. Returns the created cohort id. */
  function seedCohortAuthorityChain(wsId: string, parentRunId: string): string {
    const now = new Date().toISOString();
    const batchId = `c6b-batch-${randomUUID()}`;
    const cohortId = `c6b-cohort-${randomUUID()}`;
    getDb().run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
       VALUES (?, ?, 'b', 'b.xlsx', 'active', 0, ?, ?)`,
      [batchId, wsId, now, now],
    );
    getDb().run(
      `INSERT INTO curation_cohorts (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'k', 'l', 'product-family-v1', 'membership-hash', 'ready', ?, ?)`,
      [cohortId, wsId, batchId, now, now],
    );
    getDb().run(
      `INSERT INTO classification_cohort_runs (id, workspace_id, cohort_id, candidate_membership_hash, status, created_at)
       VALUES (?, ?, ?, 'candidate-hash', 'freezing', ?)`,
      [parentRunId, wsId, cohortId, now],
    );
    return cohortId;
  }

  /** Seed a durable cohort output row carrying `callId` for `memberSku` under
   *  `parentRunId` with the given `outputKind` (default 'coordinated_page'). */
  function seedCohortOutputRow(
    wsId: string,
    parentRunId: string,
    memberSku: string,
    callId: string,
    outputKind = 'coordinated_page',
  ): void {
    getDb().run(
      `INSERT INTO classification_cohort_outputs
         (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      [randomUUID(), wsId, parentRunId, outputKind, memberSku, 'a'.repeat(64), callId, new Date().toISOString()],
    );
  }

  /** Build a `category_page_proposals` stage that emits ONE proposal carrying
   *  `callId` on `runId` for `memberSku` (the materializer shape). */
  function cohortPageStage(runId: string, memberSku: string, snapHash: string, callId: string) {
    return {
      name: 'category_page_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId,
            productSku: memberSku,
            proposalType: 'category_page' as const,
            targetId: 'dog-food-dry',
            proposedValue: { pageId: 'dog-food-dry', pageName: 'Dog Food Dry' },
            confidence: 0.85,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            modelCallIds: [callId],
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };
  }

  /** Create a cohort parent + two children (ordinal-0 audit holder + member)
   *  and a terminal-success audited page call on the ordinal-0 child.
   *  Returns the member run, the ordinal-0 run, and the call id. */
  function cohortLinkageFixture(wsId: string, parentRunId: string, memberSku: string, snapId: string, snapHash: string) {
    seedCohortAuthorityChain(wsId, parentRunId);
    const memberRun = createRun(wsId, memberSku, snapId, snapHash, { cohortRunId: parentRunId });
    const ordinal0Run = createRun(wsId, `SKU-C6B-X-${randomUUID().slice(0, 6)}`, snapId, `x-${snapHash}`, { cohortRunId: parentRunId });
    return { memberRun, ordinal0Run };
  }

  it('C6b: a cohort child member MAY reference the ordinal-0 child call id when a durable coordinated_page output row of the SAME cohort + SKU carries it (run/snapshot mismatch exempted)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-${randomUUID()}`;
    const memberSku = 'SKU-C6B-MEMBER';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    expect(completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    })).toBe(true);
    seedCohortOutputRow(workspaceId, parentRunId, memberSku, callId);

    const result = await runPipeline([cohortPageStage(memberRun.id, memberSku, snapHash, callId)], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] });
    expect(result.proposals).toHaveLength(1);
    const persisted = getDb().query(
      'SELECT model_call_ids_json FROM classification_proposals WHERE run_id = ?',
    ).all(memberRun.id) as Array<{ model_call_ids_json: string | null }>;
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0].model_call_ids_json ?? '[]')).toEqual([callId]);
  });

  it('C6b: FAILS when the output row belongs to a DIFFERENT cohort run (no cross-cohort exemption)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-a-${randomUUID()}`;
    const otherParentRunId = `c6b-parent-b-${randomUUID()}`;
    const memberSku = 'SKU-C6B-CROSS-COHORT';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    expect(completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    })).toBe(true);
    // The output row lives on a DIFFERENT cohort run → the join cannot resolve.
    seedCohortAuthorityChain(workspaceId, otherParentRunId);
    seedCohortOutputRow(workspaceId, otherParentRunId, memberSku, callId);

    await expect(runPipeline([cohortPageStage(memberRun.id, memberSku, snapHash, callId)], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
  });

  it('C6b: FAILS when the output row carries a DIFFERENT product_sku than the proposal', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-${randomUUID()}`;
    const memberSku = 'SKU-C6B-WRONG-SKU';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    expect(completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    })).toBe(true);
    // The output row carries a DIFFERENT SKU → the exemption cannot resolve.
    seedCohortOutputRow(workspaceId, parentRunId, 'SKU-C6B-SOMEONE-ELSE', callId);

    await expect(runPipeline([cohortPageStage(memberRun.id, memberSku, snapHash, callId)], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
  });

  it('C6b: FAILS for a NON-cohort run referencing a foreign call id (unchanged hard fail, no exemption)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    // No cohort_run_id on either run — a plain foreign-call linkage failure.
    const run = createRun(workspaceId, 'SKU-C6B-NONCOHORT', snapId, snapHash);
    const otherRun = createRun(workspaceId, 'SKU-C6B-OTHER', snapId, `x-${snapHash}`);
    const { insertModelCallStart } = await import('../../db/repositories/classification-model-call-repo');
    const foreignCall = insertModelCallStart({
      runId: otherRun.id,
      stageName: 'product_attribute_proposals',
      operation: 'attribute_ranking',
      attempt: 1,
      provider: 'ollama',
      model: 'llama3',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId: run.id,
            productSku: 'SKU-C6B-NONCOHORT',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            modelCallIds: [foreignCall],
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };

    await expect(runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-C6B-NONCOHORT', evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
  });

  it('C6b: FAILS when the call row exists but is NOT terminal-success — the status check runs BEFORE any exemption', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-${randomUUID()}`;
    const memberSku = 'SKU-C6B-STARTED';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart } = await import('../../db/repositories/classification-model-call-repo');
    const startedCall = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    // The durable output row EXISTS and resolves — but the call is still
    // `started`: the terminal-success hard-fail must win over the exemption.
    seedCohortOutputRow(workspaceId, parentRunId, memberSku, startedCall);

    await expect(runPipeline([cohortPageStage(memberRun.id, memberSku, snapHash, startedCall)], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/non-terminal\/non-success|started/);
  });

  it('C6b: FAILS when no durable output row resolves the call id (missing row — no exemption)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-${randomUUID()}`;
    const memberSku = 'SKU-C6B-NO-ROW';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    expect(completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    })).toBe(true);
    // NO output row is seeded for this member/call.

    await expect(runPipeline([cohortPageStage(memberRun.id, memberSku, snapHash, callId)], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
  });

  it('C6b (PR7 review R2 F3-2): FAILS when the output row is a curated_title (wrong output_kind) — even for a category_page proposal', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-${randomUUID()}`;
    const memberSku = 'SKU-C6B-TITLE-KIND';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    expect(completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    })).toBe(true);
    // The only durable output row is a CURATED_TITLE row carrying the call id
    // (a title-op call id) — the page exemption must NOT resolve through it.
    seedCohortOutputRow(workspaceId, parentRunId, memberSku, callId, 'curated_title');

    await expect(runPipeline([cohortPageStage(memberRun.id, memberSku, snapHash, callId)], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
  });

  it('C6b (PR7 review R2 F3-2): FAILS for a NON-category_page proposal even when a coordinated_page output row resolves the call id', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const parentRunId = `c6b-parent-${randomUUID()}`;
    const memberSku = 'SKU-C6B-FIELD-KIND';
    const { memberRun, ordinal0Run } = cohortLinkageFixture(workspaceId, parentRunId, memberSku, snapId, snapHash);
    const { insertModelCallStart, completeModelCall } = await import('../../db/repositories/classification-model-call-repo');
    const callId = insertModelCallStart({
      runId: ordinal0Run.id,
      stageName: 'category_page_proposals',
      operation: 'cohort_page_assignment',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: `x-${snapHash}`,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'cohort-page-assignment-prompt-v1',
      ruleVersion: 'cohort-page-assignment-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    expect(completeModelCall(callId, {
      status: 'success',
      durationMs: 5,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: 'local_zero',
    })).toBe(true);
    // A durable coordinated_page row exists and resolves the call id — but
    // the proposal is a FIELD_ASSIGNMENT, so the exemption must NOT apply.
    seedCohortOutputRow(workspaceId, parentRunId, memberSku, callId);

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: randomUUID(),
            runId: memberRun.id,
            productSku: memberSku,
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            modelCallIds: [callId],
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
        },
      }),
    };

    await expect(runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: memberRun.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: memberSku, evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Model call linkage failed/);
  });

  it('fails closed when a proposal references nonexistent or foreign-run evidence (issue #17 H)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'SKU-EV-LINK', snapId, snapHash);
    const foreignRun = createRun(workspaceId, 'SKU-EV-LINK', snapId, snapHash);
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    // Evidence that belongs to a DIFFERENT run (foreign-run evidence must never
    // be linked to this run's proposal).
    getDb().run(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, value_json, created_at)
       VALUES (?, ?, ?, 'evidence_extraction', 'official_product_page', 'high', '"Foreign"', ?)`,
      ['evidence-foreign', foreignRun.id, 'SKU-EV-LINK', now],
    );

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: proposalId,
            runId: run.id,
            productSku: 'SKU-EV-LINK',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: ['evidence-foreign', 'evidence-does-not-exist'],
            supportingEvidenceIds: ['evidence-foreign'],
            contradictingEvidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            createdAt: now,
          }],
          abstained: false,
        },
      }),
    };

    await expect(runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-EV-LINK', evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Evidence linkage failed/);

    // The entire stage transaction rolled back: zero proposals, zero links
    // for this proposal (never any foreign/nonexistent link).
    const persisted = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposals WHERE run_id = ?',
    ).get(run.id) as { c: number };
    expect(persisted.c).toBe(0);
    const links = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposal_evidence WHERE proposal_id = ?',
    ).get(proposalId) as { c: number };
    expect(links.c).toBe(0);
  });

  it('rejects role-only evidence ids that bypass the union and roll back (issue #17 pass 5b)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'SKU-EV-ROLEONLY', snapId, snapHash);
    const proposalId = randomUUID();
    const now = new Date().toISOString();

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [],
          proposals: [{
            id: proposalId,
            runId: run.id,
            productSku: 'SKU-EV-ROLEONLY',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            // Empty union with non-empty role arrays: ghost/foreign role ids
            // must fail closed — a role can never reference an id outside the
            // proposal's evidence union.
            evidenceIds: [],
            supportingEvidenceIds: ['ghost-evidence'],
            contradictingEvidenceIds: ['foreign-evidence'],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            createdAt: now,
          }],
          abstained: false,
        },
      }),
    };

    await expect(runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-EV-ROLEONLY', evidence: [], acceptedProposals: [], allProposals: [] })).rejects.toThrow(/Evidence linkage failed/);

    const persisted = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposals WHERE run_id = ?',
    ).get(run.id) as { c: number };
    expect(persisted.c).toBe(0);
    const links = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposal_evidence WHERE proposal_id = ?',
    ).get(proposalId) as { c: number };
    expect(links.c).toBe(0);
  });

  it('persists proposal evidence roles in the join with the authoritative relation (issue #17 H)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'SKU-EV-ROLES', snapId, snapHash);
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const evidence: ClassificationEvidence[] = [
      {
        id: 'ev-support', runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'SKU-EV-ROLES',
        attributeId: 'flavor', source: 'official_product_page' as const, reliability: 'high' as const,
        sourceUrl: null, sourceField: null, snippet: null, metadata: null,
        value: 'Chicken', capturedAt: now,
      },
      {
        id: 'ev-contradict', runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'SKU-EV-ROLES',
        attributeId: 'flavor', source: 'spreadsheet' as const, reliability: 'medium' as const,
        sourceUrl: null, sourceField: null, snippet: null, metadata: null,
        value: 'Beef', capturedAt: now,
      },
    ];
    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence,
          proposals: [{
            id: proposalId,
            runId: run.id,
            productSku: 'SKU-EV-ROLES',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.8,
            evidenceIds: ['ev-support', 'ev-contradict'],
            supportingEvidenceIds: ['ev-support'],
            contradictingEvidenceIds: ['ev-contradict'],
            status: 'pending' as const,
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            snapshotHash: snapHash,
            createdAt: now,
          }],
          abstained: false,
        },
      }),
    };

    const result = await runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-EV-ROLES', evidence: [], acceptedProposals: [], allProposals: [] });
    expect(result.proposals).toHaveLength(1);

    const links = getDb().query(
      'SELECT evidence_id, relation FROM classification_proposal_evidence WHERE proposal_id = ? ORDER BY evidence_id',
    ).all(proposalId) as Array<{ evidence_id: string; relation: string }>;
    expect(links).toEqual([
      { evidence_id: 'ev-contradict', relation: 'contradicting' },
      { evidence_id: 'ev-support', relation: 'supporting' },
    ]);

    const hydrated = getDb().query(
      'SELECT supporting_evidence_ids_json, contradicting_evidence_ids_json FROM classification_proposals WHERE run_id = ?',
    ).get(run.id) as { supporting_evidence_ids_json: string; contradicting_evidence_ids_json: string };
    expect(JSON.parse(hydrated.supporting_evidence_ids_json)).toEqual(['ev-support']);
    expect(JSON.parse(hydrated.contradicting_evidence_ids_json)).toEqual(['ev-contradict']);
  });

  it('persists a reviewable brand proposal with DISJOINT roles when brand assertions disagree by case (issue #17 pass 5c)', async () => {
    const baseConfig = loadClassificationConfig(workspacePath);
    const brandAttribute = {
      id: 'brand',
      name: 'Brand',
      description: null,
      valueMode: 'controlled' as const,
      canonicalUnit: null,
      allowedValues: ['Blue Buffalo', 'Dr. Marty'],
      valueAliases: [],
      visualEvidenceEligibility: 'eligible' as const,
      isClaim: false,
      isCompositionAttribute: false,
      group: 'Identity',
    };
    const brandTargetCfg = {
      id: 'brand-target',
      kind: 'product_field' as const,
      label: 'Brand',
      enabled: true,
      selectionMode: 'single' as const,
      attributeId: 'brand',
      catalogField: 'ProductField16',
      optionSource: 'configured' as const,
      required: false,
      mandatory: false,
      sortOrder: 3,
    };
    const brandConfig = {
      ...baseConfig,
      attributes: [...(baseConfig.attributes ?? []), brandAttribute],
      curationTargets: [...(baseConfig.curationTargets ?? []), brandTargetCfg],
    };
    saveClassificationConfig(workspacePath, brandConfig);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, brandConfig);
    const run = createRun(workspaceId, 'SKU-BRAND-CASE', snapId, snapHash);
    const now = new Date().toISOString();
    const evidence: ClassificationEvidence[] = [
      {
        id: 'brand-ev-one', runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'SKU-BRAND-CASE',
        attributeId: null, source: 'official_product_page' as const, reliability: 'high' as const,
        sourceUrl: null, sourceField: 'brand', snippet: null, value: 'Blue Buffalo', metadata: {}, capturedAt: now,
      },
      {
        id: 'brand-ev-two', runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'SKU-BRAND-CASE',
        attributeId: null, source: 'official_product_page' as const, reliability: 'high' as const,
        sourceUrl: null, sourceField: 'brand', snippet: null, value: 'BLUE BUFFALO', metadata: {}, capturedAt: now,
      },
    ];
    persistFixtureEvidence(run.id, evidence);

    const resolvedBrandTarget = {
      config: brandTargetCfg,
      options: [
        { value: 'Blue Buffalo', label: 'Blue Buffalo' },
        { value: 'Dr. Marty', label: 'Dr. Marty' },
      ],
      attribute: brandAttribute,
    };

    const stage = {
      name: 'product_attribute_proposals' as const,
      requires: [] as ClassificationStageName[],
      evidenceFrom: [] as ClassificationStageName[],
      execute: async () => {
        const result = await processProductFieldTarget(
          resolvedBrandTarget as never,
          { sku: 'SKU-BRAND-CASE', evidence, acceptedProposals: [], allProposals: [] },
          {
            workspacePath,
            workspaceId,
            runId: run.id,
            configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
          },
          { cardinality: 'single' },
        );
        return {
          status: 'succeeded' as const,
          output: {
            evidence: [],
            proposals: result.proposals,
            abstained: false,
          },
        };
      },
    };

    const result = await runPipeline([stage], {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
    }, { sku: 'SKU-BRAND-CASE', evidence, acceptedProposals: [], allProposals: [] });

    // No rollback: exactly one persisted proposal.
    expect(result.proposals).toHaveLength(1);
    const persisted = getDb().query(
      'SELECT COUNT(*) AS c FROM classification_proposals WHERE run_id = ?',
    ).get(run.id) as { c: number };
    expect(persisted.c).toBe(1);

    // Disjoint roles: case-distinct disagreement is a visible conflict with
    // ONLY contradicting ids — the selected assertion is never also supporting.
    const proposal = result.proposals[0];
    const support = proposal.supportingEvidenceIds ?? [];
    const conflict = proposal.contradictingEvidenceIds ?? [];
    expect(support).toEqual([]);
    expect([...conflict].sort()).toEqual(['brand-ev-one', 'brand-ev-two']);
    expect(proposal.isBulkAcceptable).toBe(false);

    const links = getDb().query(
      'SELECT evidence_id, relation FROM classification_proposal_evidence WHERE proposal_id = ? ORDER BY evidence_id',
    ).all(proposal.id) as Array<{ evidence_id: string; relation: string }>;
    expect(links).toEqual([
      { evidence_id: 'brand-ev-one', relation: 'contradicting' },
      { evidence_id: 'brand-ev-two', relation: 'contradicting' },
    ]);
  });

  it('I7: a mapping move through the editor makes an earlier run config-drifted', async () => {
    // The mapping editor operates only on an ACTIVE v2 bundle, but this
    // suite's shared workspace is v1, so this test builds its own v2
    // workspace (same shared DB; workspace-scoped reads keep it isolated).
    // The drift signal is computed exactly as GET /api/classification/runs/:id
    // computes it: authority-bundle-hash match OR persisted runtime-snapshot
    // match; neither → configDrift (fail closed).
    const I7_FIELDS = [
      'ProductField4', 'ProductField8', 'ProductField16', 'ProductField17',
      'ProductField18', 'ProductField19', 'ProductField20', 'ProductField21',
      'ProductField22', 'ProductField23', 'ProductField24', 'ProductField25',
      'ProductField26', 'ProductField27', 'ProductField28', 'ProductField29',
      'ProductField30', 'ProductField32',
    ];
    const artifactContent = JSON.stringify({
      schemaVersion: 1,
      sourceTreeHash: 'i7'.repeat(32),
      productFileCount: 0,
      parseFailureCount: 0,
      parseFailures: [],
      fieldRegistry: { entryCount: I7_FIELDS.length, xmlFields: [...I7_FIELDS].sort() },
      fields: [],
      pages: [],
    });
    const evidenceHash = sha256Hex(artifactContent);
    const evidence: CatalogEvidence = {
      schemaVersion: 1,
      sourceTreeHash: '0'.repeat(64),
      productFileCount: 0,
      parseFailureCount: 0,
      parseFailures: [],
      fieldRegistry: { entryCount: I7_FIELDS.length, xmlFields: [...I7_FIELDS].sort() },
      fields: [...I7_FIELDS].sort().map(xmlField => ({
        xmlField,
        recordCount: 1,
        nonEmptyCount: 1,
        distinctValueCount: 1,
        distinctValueHash: '0'.repeat(64),
        delimiterEvidence: [],
      })),
      pages: [],
    };

    const v2WorkspaceId = randomUUID();
    const v2Path = path.join(os.tmpdir(), `baystate-cms-class-v2-${v2WorkspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(v2Path, 'store', 'classification'), { recursive: true });
    fs.mkdirSync(path.join(v2Path, 'products'), { recursive: true });
    insertWorkspace({
      id: v2WorkspaceId,
      name: 'test-v2',
      workspacePath: v2Path,
      gitPath: path.join(v2Path, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const git = new GitClient(v2Path);
    git.init();
    fs.writeFileSync(path.join(v2Path, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
    fs.writeFileSync(
      path.join(v2Path, 'store', 'field-registry.json'),
      JSON.stringify({ entries: [...I7_FIELDS].sort().map(xmlField => ({ xmlField })) }),
      'utf-8',
    );
    git.add(['store/manifest.json', 'store/field-registry.json']);
    git.commit('seed catalog manifest');
    const sourceCatalogCommit = git.getHeadHash();

    const candidate = generateCandidate(BayStatePetGardenSeed, evidence);
    const preview = previewCandidate(candidate.bundle, v2Path, { catalogEvidence: artifactContent });
    if (!preview.hash) {
      throw new Error(`preview failed: ${preview.report.findings.map(f => f.code).join(', ')}`);
    }
    await activateBundle(preview.hash, null, {
      workspacePath: v2Path,
      workspaceId: v2WorkspaceId,
      activationContext: {
        catalogFields: I7_FIELDS,
        verifiedPageIds: ['page-i7-1'],
        verifyCatalogEvidence: (input: { catalogEvidenceHash: string; sourceCatalogCommit: string }) => ({
          verified: input.catalogEvidenceHash === evidenceHash && input.sourceCatalogCommit === sourceCatalogCommit,
          reason: 'test verifier',
        }),
      } as never,
      catalogEvidenceHash: evidenceHash,
      gitEnabled: true,
    });

    // A run bound to the freshly activated v2 bundle.
    const initialAuthority = loadRuntimeConfigAuthority(v2Path, createRuntimeActivationContext(v2Path, v2WorkspaceId));
    expect(initialAuthority.kind).toBe('v2');
    const run = createRun(v2WorkspaceId, 'I7-SKU', null, (initialAuthority as Extract<RuntimeConfigAuthority, { kind: 'v2' }>).bundle.manifest.bundleHash, { sourceKind: 'catalog_product' });

    // Mirror of the run-detail route's config-drift computation.
    const configDrift = (): boolean => {
      try {
        const authority = loadRuntimeConfigAuthority(v2Path, createRuntimeActivationContext(v2Path, v2WorkspaceId));
        const matches = authorityConfigHashMatches(authority, run.configSnapshotHash!) ||
          runtimeSnapshotHashMatchesConfig(
            v2WorkspaceId,
            run.configSnapshotHash!,
            authority.kind === 'v2' ? authority.bundle : authority.config,
          );
        return !matches;
      } catch {
        return true;
      }
    };
    expect(configDrift()).toBe(false);

    // Apply a legal mapping move via the mapping editor (in-batch unmap + map;
    // ProductField4 is free so no D3 collision).
    applyFieldMappingEdits(v2Path, v2WorkspaceId, [
      { catalogField: 'ProductField26', attributeId: null },
      { catalogField: 'ProductField4', attributeId: 'product-feature' },
    ], { gitEnabled: false });

    // The prior run's config snapshot no longer matches the active authority.
    expect(configDrift()).toBe(true);
  });

  it('I8: a registry-only label edit does not masquerade as a mapping change (configDrift stays false)', async () => {
    // Same fresh-v2-workspace pattern as I7: the canonical field-metadata
    // service mutates R1 (`field_registry` DB) + its R2 projection
    // (`store/field-registry.json`) while this suite's shared workspace is
    // v1, so this test builds its own v2 workspace (same shared DB;
    // workspace-scoped reads keep it isolated). The drift signal is computed
    // exactly as GET /api/classification/runs/:id computes it: authority-
    // bundle-hash match OR persisted runtime-snapshot match; neither →
    // configDrift (fail closed).
    const I8_FIELDS = [
      'ProductField4', 'ProductField8', 'ProductField16', 'ProductField17',
      'ProductField18', 'ProductField19', 'ProductField20', 'ProductField21',
      'ProductField22', 'ProductField23', 'ProductField24', 'ProductField25',
      'ProductField26', 'ProductField27', 'ProductField28', 'ProductField29',
      'ProductField30', 'ProductField32',
    ];
    const artifactContent = JSON.stringify({
      schemaVersion: 1,
      sourceTreeHash: 'i8'.repeat(32),
      productFileCount: 0,
      parseFailureCount: 0,
      parseFailures: [],
      fieldRegistry: { entryCount: I8_FIELDS.length, xmlFields: [...I8_FIELDS].sort() },
      fields: [],
      pages: [],
    });
    const evidenceHash = sha256Hex(artifactContent);
    const evidence: CatalogEvidence = {
      schemaVersion: 1,
      sourceTreeHash: '0'.repeat(64),
      productFileCount: 0,
      parseFailureCount: 0,
      parseFailures: [],
      fieldRegistry: { entryCount: I8_FIELDS.length, xmlFields: [...I8_FIELDS].sort() },
      fields: [...I8_FIELDS].sort().map(xmlField => ({
        xmlField,
        recordCount: 1,
        nonEmptyCount: 1,
        distinctValueCount: 1,
        distinctValueHash: '0'.repeat(64),
        delimiterEvidence: [],
      })),
      pages: [],
    };

    const v2WorkspaceId = randomUUID();
    const v2Path = path.join(os.tmpdir(), `baystate-cms-class-v2-${v2WorkspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(v2Path, 'store', 'classification'), { recursive: true });
    fs.mkdirSync(path.join(v2Path, 'products'), { recursive: true });
    insertWorkspace({
      id: v2WorkspaceId,
      name: 'test-v2',
      workspacePath: v2Path,
      gitPath: path.join(v2Path, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const git = new GitClient(v2Path);
    git.init();
    fs.writeFileSync(path.join(v2Path, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
    fs.writeFileSync(
      path.join(v2Path, 'store', 'field-registry.json'),
      JSON.stringify({ entries: [...I8_FIELDS].sort().map(xmlField => ({ xmlField })) }),
      'utf-8',
    );
    git.add(['store/manifest.json', 'store/field-registry.json']);
    git.commit('seed catalog manifest');
    const sourceCatalogCommit = git.getHeadHash();

    const candidate = generateCandidate(BayStatePetGardenSeed, evidence);
    const preview = previewCandidate(candidate.bundle, v2Path, { catalogEvidence: artifactContent });
    if (!preview.hash) {
      throw new Error(`preview failed: ${preview.report.findings.map(f => f.code).join(', ')}`);
    }
    await activateBundle(preview.hash, null, {
      workspacePath: v2Path,
      workspaceId: v2WorkspaceId,
      activationContext: {
        catalogFields: I8_FIELDS,
        verifiedPageIds: ['page-i8-1'],
        verifyCatalogEvidence: (input: { catalogEvidenceHash: string; sourceCatalogCommit: string }) => ({
          verified: input.catalogEvidenceHash === evidenceHash && input.sourceCatalogCommit === sourceCatalogCommit,
          reason: 'test verifier',
        }),
      } as never,
      catalogEvidenceHash: evidenceHash,
      gitEnabled: true,
    });

    // A run bound to the freshly activated v2 bundle.
    const initialAuthority = loadRuntimeConfigAuthority(v2Path, createRuntimeActivationContext(v2Path, v2WorkspaceId));
    expect(initialAuthority.kind).toBe('v2');
    const run = createRun(v2WorkspaceId, 'I8-SKU', null, (initialAuthority as Extract<RuntimeConfigAuthority, { kind: 'v2' }>).bundle.manifest.bundleHash, { sourceKind: 'catalog_product' });

    // Mirror of the run-detail route's config-drift computation (same as I7).
    const configDrift = (): boolean => {
      try {
        const authority = loadRuntimeConfigAuthority(v2Path, createRuntimeActivationContext(v2Path, v2WorkspaceId));
        const matches = authorityConfigHashMatches(authority, run.configSnapshotHash!) ||
          runtimeSnapshotHashMatchesConfig(
            v2WorkspaceId,
            run.configSnapshotHash!,
            authority.kind === 'v2' ? authority.bundle : authority.config,
          );
        return !matches;
      } catch {
        return true;
      }
    };
    expect(configDrift()).toBe(false);

    // Populate the canonical R1 field-registry rows for this workspace (the
    // seeded store/field-registry.json is a projection of R1; the active
    // loader re-attests mapped fields against this set), then snapshot the
    // active bundle's mapping fingerprint + hash BEFORE the label edit.
    for (const xmlField of [...I8_FIELDS].sort()) {
      upsertRegistryEntry({
        id: randomUUID(),
        workspaceId: v2WorkspaceId,
        xmlField,
        label: xmlField,
        kind: 'custom',
        dataType: 'string',
        editable: true,
        required: false,
        uiGroup: 'Custom Fields',
        sampleValuesJson: null,
        curatedFieldsJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const authorityBeforeEdit = loadRuntimeConfigAuthority(v2Path, createRuntimeActivationContext(v2Path, v2WorkspaceId));
    expect(authorityBeforeEdit.kind).toBe('v2');
    const bundleBeforeEdit = (authorityBeforeEdit as Extract<RuntimeConfigAuthority, { kind: 'v2' }>).bundle;
    const beforeMappingsVersion = bundleBeforeEdit.manifest.fileVersions['mappings.json'];
    const beforeBundleHash = bundleBeforeEdit.manifest.bundleHash;

    // Registry-only LABEL edit through the canonical field-metadata service
    // (the function behind PUT /api/field-registry/:id). It mutates R1 and
    // rewrites store/field-registry.json — never store/classification/**.
    const updatedRow = updateFieldMetadata(
      { id: v2WorkspaceId, workspacePath: v2Path },
      'ProductField4',
      { label: 'Edited Field Label' },
    );
    expect(updatedRow.label).toBe('Edited Field Label');

    // (a) The prior run's config snapshot still matches the active bundle
    // hash — a display-only change must not masquerade as a config change.
    expect(configDrift()).toBe(false);

    // (b) The active bundle manifest's mappings.json fingerprint is untouched.
    const authorityAfterEdit = loadRuntimeConfigAuthority(v2Path, createRuntimeActivationContext(v2Path, v2WorkspaceId));
    expect(authorityAfterEdit.kind).toBe('v2');
    const bundleAfterEdit = (authorityAfterEdit as Extract<RuntimeConfigAuthority, { kind: 'v2' }>).bundle;
    expect(bundleAfterEdit.manifest.fileVersions['mappings.json']).toBe(beforeMappingsVersion);

    // (c) The bundle hash itself is unchanged.
    expect(bundleAfterEdit.manifest.bundleHash).toBe(beforeBundleHash);

    // Positive control (covered by I7 above, not duplicated here): a real
    // MAPPING edit through applyFieldMappingEdits flips this same run's
    // configDrift to true. A registry-only label edit must never masquerade
    // as that mapping/classification change.
  });
});
