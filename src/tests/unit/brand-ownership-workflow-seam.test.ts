/**
 * Issue #349 — Brand ownership workflow seam (criterion 7).
 *
 * Proves Brand-present AND Brand-absent cases through the owner-confirmed
 * workflow seam using public interfaces only:
 * run (shared composition) → proposals → decisions → actual local draft
 * contents. Isolated persistence (fresh temp DB per test); deterministic
 * adapters (no provider calls — the flavor path resolves deterministically).
 *
 * - Unanimous Brand evidence yields NO Brand proposal (Brand-present case).
 * - Brand-absent evidence also classifies the owned attribute fine.
 * - An attempted protected revised target is refused attributably
 *   (`protected_target_refused`), never applied or rerouted.
 * - A historical Brand proposal accept is refused; reject passes.
 * - Catalog application preserves non-classification fields (identity,
 *   Name, description, images, pricing, inventory, Brand slot) in the
 *   actual local draft, applying only the owned classification change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createRun as createRepositoryRun,
  completeRun,
  getProposalsByRun,
  getAcceptedProposals,
  getLiveDecisionsByRun,
} from '../../db/repositories/classification-run-repo';
import {
  createConfigSnapshot,
} from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { processProductFieldTarget, processProductFieldTargetsBatch } from '../../classification/curation-target-processor';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { StageInput, StageContext } from '../../classification/types';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { buildAssignmentProjection } from '../../classification/assignment-projection';
import { productDraftProjectionStage } from '../../classification/stages/draft-projection';
import type { StageResult } from '../../classification/types';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { writeProductFile } from '../../git/workspace-files';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { isTaxonomyFrozen, setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { computeProductHash } from '../../classification/catalog-product-source';
import type { ClassificationEvidence } from '../../shared/types';
import type { ClassificationConfig } from '../../shared/schemas/classification';
import type { Product } from '../../shared/schemas/product';

const WS_ID = "ws-brand-ownership-seam";

function configFixture(): ClassificationConfig {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [],
    attributes: [
      { id: 'brand', name: 'Brand', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Identity' },
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
    ],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'brand-map', attributeId: 'brand', catalogField: 'ProductField16', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      // Brand target deliberately ENABLED: proves the composition guard covers
      // it — no path emits a Brand proposal even from an enabled seed target.
      { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  } satisfies ClassificationConfig;
}

function extendConfigWithMaterial(config: ClassificationConfig): ClassificationConfig {
  return {
    ...config,
    attributes: [
      ...config.attributes,
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Material' },
    ],
    attributeMappings: [
      ...config.attributeMappings,
      { id: 'material-map', attributeId: 'material', catalogField: 'ProductField28', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      ...config.curationTargets,
      { id: 'mt', kind: 'product_field', label: 'Material', enabled: true, selectionMode: 'single', attributeId: 'material', catalogField: 'ProductField28', optionSource: 'configured', required: false, mandatory: false, sortOrder: 3 },
    ],
  } satisfies ClassificationConfig;
}

function fieldTarget(targetId: string, attributeId: string, catalogField: string, allowedValues: string[]): ResolvedTarget {
  return {
    config: { id: targetId, kind: 'product_field', label: attributeId, enabled: true, mandatory: false, selectionMode: 'single', attributeId, catalogField, optionSource: 'configured', required: false, sortOrder: 1 },
    options: allowedValues.map(value => ({ value, label: value })),
  } satisfies ResolvedTarget;
}

function fieldStageInput(sku: string, evidence: ClassificationEvidence[]): StageInput {
  return { sku, evidence, acceptedProposals: [], allProposals: [] };
}

function fieldStageContext(workspacePathValue: string, runId: string, sku: string, config = configFixture()): StageContext {
  const ref = createConfigSnapshot(WS_ID, config);
  const configSnapshotRef = { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() };
  expect(isTaxonomyFrozen()).toBe(true);
  const snapshot = buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath: workspacePathValue, productSku: sku,
    config, configSnapshotRef, sourceProductHash: null });
  persistRuntimeSnapshot(snapshot);
  return { workspacePath: workspacePathValue, workspaceId: WS_ID, runId, configSnapshotRef, snapshot };
}

function readPreviewFieldAssignments(stageResult: StageResult): Record<string, unknown> {
  if (stageResult.status === 'failed') throw new Error(stageResult.error);
  const output = stageResult.output;
  if (!output) throw new Error('draft projection stage returned no output');
  const metadata: unknown = output.metadata;
  if (!metadata || typeof metadata !== 'object' || !('projection' in metadata)) {
    throw new Error('draft projection stage returned no projection metadata');
  }
  const projection: unknown = metadata.projection;
  if (!projection || typeof projection !== 'object' || !('fieldAssignments' in projection)) {
    throw new Error('draft projection metadata lacks fieldAssignments');
  }
  const fieldAssignments: unknown = projection.fieldAssignments;
  if (!fieldAssignments || typeof fieldAssignments !== 'object' || Array.isArray(fieldAssignments)) {
    throw new Error('draft projection fieldAssignments is not an object');
  }
  return Object.fromEntries(Object.entries(fieldAssignments));
}

function persistFixtureConfig(config: ClassificationConfig): void {
  const wasFrozen = isTaxonomyFrozen();
  expect(wasFrozen).toBe(true);
  setTaxonomyFreezeForTests(false);
  try {
    saveClassificationConfig(workspacePath, config);
    syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
  } finally {
    setTaxonomyFreezeForTests(wasFrozen);
  }
  expect(isTaxonomyFrozen()).toBe(true);
}

function submitFrozenDecision(input: Parameters<typeof submitProposalDecisions>[0]) {
  expect(isTaxonomyFrozen()).toBe(true);
  return submitProposalDecisions(input);
}

function applyFrozenCatalogClassification(...args: Parameters<typeof applyCatalogClassification>) {
  expect(isTaxonomyFrozen()).toBe(true);
  return applyCatalogClassification(...args);
}

function readChangeSetCustomFields(draftJson: string): Record<string, string> {
  const parsed: unknown = JSON.parse(draftJson);
  if (!parsed || typeof parsed !== 'object' || !('customFields' in parsed)) {
    throw new Error('draft JSON lacks customFields');
  }
  return parsed.customFields as Record<string, string>;
}

function correctedDestProduct(sku: string, now: string): Product {
  return {
    schemaVersion: 1, id: 'p-corrected', sku, status: 'active',
    core: {
      name: 'Acme Rubber Chew', price: '9.99', salePrice: null, description: 'Tough chew',
      inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
      weight: '5 lb', taxable: true, media: { primary: 'products/x/primary.jpg', additional: [] },
      seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: ['Old Page'],
    },
    customFields: { ProductField16: 'Acme', ProductField23: 'Beef', ProductField28: 'Nylon' },
    shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

function ev(id: string, runId: string, sku: string, overrides: Partial<ClassificationEvidence>): ClassificationEvidence {
  return {
    id, runId, stageName: 'evidence_extraction', productSku: sku,
    attributeId: null, source: 'spreadsheet', reliability: 'medium',
    sourceUrl: null, sourceField: 'name', snippet: null, value: null,
    metadata: {}, capturedAt: new Date().toISOString(), ...overrides,
  } satisfies ClassificationEvidence;
}
let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(true);
  expect(isTaxonomyFrozen()).toBe(true);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ownership-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  persistFixtureConfig(configFixture());
});

afterEach(() => {
  try {
    closeDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  } finally {
    setTaxonomyFreezeForTests(true);
    expect(isTaxonomyFrozen()).toBe(true);
  }
});
describe('issue #349 workflow seam: Brand ownership end to end', () => {
  it('Brand-present: unanimous Brand evidence yields no Brand proposal; owned flavor classifies', async () => {
    const runId = 'run-present';
    const evidence = [
      ev('ev-brand-1', runId, 'SKU-PRESENT', { source: 'spreadsheet', sourceField: 'brand', value: 'Acme', snippet: 'Acme' }),
      ev('ev-brand-2', runId, 'SKU-PRESENT', { source: 'official_product_page', sourceField: 'brand', value: 'Acme', snippet: 'Acme' }),
      ev('ev-flavor', runId, 'SKU-PRESENT', { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken dinner', snippet: 'Chicken dinner' }),
    ];
    const brandTarget: ResolvedTarget = {
      config: { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, sortOrder: 1 },
      options: [],
    } satisfies ResolvedTarget;
    const brandResult = await processProductFieldTarget(brandTarget, fieldStageInput('SKU-PRESENT', evidence), fieldStageContext(workspacePath, runId, 'SKU-PRESENT'));
    expect(brandResult.proposals).toEqual([]);

    const flavorTarget: ResolvedTarget = {
      config: { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 2 },
      options: [{ value: 'Chicken', label: 'Chicken' }, { value: 'Beef', label: 'Beef' }],
    } satisfies ResolvedTarget;
    const flavorResult = await processProductFieldTarget(flavorTarget, fieldStageInput('SKU-PRESENT', evidence), fieldStageContext(workspacePath, runId, 'SKU-PRESENT'));
    expect(flavorResult.proposals.map(proposal => [proposal.targetId, proposal.proposedValue])).toEqual([['flavor', 'Chicken']]);
  });

  it('Brand-absent: no Brand evidence still classifies the owned attribute; no Brand proposal', async () => {
    const runId = 'run-absent';
    const evidence = [
      ev('ev-name', runId, 'SKU-ABSENT', { sourceField: 'name', value: 'Chicken dinner kibble', snippet: 'Chicken dinner kibble' }),
      ev('ev-flavor', runId, 'SKU-ABSENT', { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken dinner', snippet: 'Chicken dinner' }),
    ];
    const brandTarget: ResolvedTarget = {
      config: { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, sortOrder: 1 },
      options: [],
    } satisfies ResolvedTarget;
    const brandResult = await processProductFieldTarget(brandTarget, fieldStageInput('SKU-ABSENT', evidence), fieldStageContext(workspacePath, runId, 'SKU-ABSENT'));
    expect(brandResult.proposals).toEqual([]);
    const flavorResult = await processProductFieldTarget(
      fieldTarget('flavor-target', 'flavor', 'ProductField23', ['Chicken', 'Beef']),
      fieldStageInput('SKU-ABSENT', evidence), fieldStageContext(workspacePath, runId, 'SKU-ABSENT'),
    );
    expect(flavorResult.proposals.map(proposal => [proposal.targetId, proposal.proposedValue])).toEqual([['flavor', 'Chicken']]);
  });


  it('refuses single and batch output without captured configuration authority', async () => {
    const sku = 'SKU-NO-AUTHORITY';
    const { snapshot: _snapshot, ...context } = fieldStageContext(workspacePath, 'no-authority', sku);
    const target = fieldTarget('flavor-target', 'flavor', 'ProductField23', ['Chicken']);
    const input = fieldStageInput(sku, [ev('grounded', context.runId, sku,
      { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken' })]);
    const single = await processProductFieldTarget(target, input, context);
    expect(single.proposals).toEqual([]);
    expect(single.message).toContain('configuration_gap');
    const batch = await processProductFieldTargetsBatch([{ target }], input, context);
    expect(batch.proposals).toEqual([]);
    expect(batch.messages.join('; ')).toContain('configuration_gap');
  });

  it('refuses unknown attributes, uncaptured targets and stale bindings in single and batch output', async () => {
    const sku = 'SKU-UNKNOWN-AUTHORITY';
    const target = fieldTarget('flavor-target', 'flavor', 'ProductField23', ['Chicken']);
    const unknownAttribute = configFixture();
    unknownAttribute.attributes = unknownAttribute.attributes.filter(attribute => attribute.id !== 'flavor');
    const missingTarget = configFixture();
    missingTarget.curationTargets = missingTarget.curationTargets?.filter(target => target.attributeId !== 'flavor');
    const staleBinding = configFixture();
    staleBinding.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!.isStale = true;
    const absentBinding = configFixture();
    absentBinding.attributeMappings = absentBinding.attributeMappings.filter(mapping => mapping.attributeId !== 'flavor');
    const mismatchedBinding = configFixture();
    mismatchedBinding.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!.catalogField = 'ProductField28';
    for (const [config, refusal] of [
      [unknownAttribute, 'configuration_gap'], [missingTarget, 'configuration_gap'],
      [staleBinding, 'configuration_gap'], [absentBinding, 'configuration_gap'],
      [mismatchedBinding, 'protected_target_refused'],
    ] as const) {
      const context = fieldStageContext(workspacePath, 'unknown-authority', sku, config);
      const input = fieldStageInput(sku, [ev('grounded', context.runId, sku,
        { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken' })]);
      const single = await processProductFieldTarget(target, input, context);
      expect(single.proposals).toEqual([]);
      expect(single.message).toContain(refusal);
      const batch = await processProductFieldTargetsBatch([{ target }], input, context);
      expect(batch.proposals).toEqual([]);
      expect(batch.messages.join('; ')).toContain(refusal);
    }
  });

  it('uses captured options instead of caller-supplied options', async () => {
    const sku = 'SKU-FROZEN-OPTIONS';
    const context = fieldStageContext(workspacePath, 'frozen-options', sku);
    const target = fieldTarget('flavor-target', 'flavor', 'ProductField23', ['Rubber']);
    const input = fieldStageInput(sku, [ev('grounded', context.runId, sku,
      { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken dinner', snippet: 'Chicken dinner' })]);
    const result = await processProductFieldTarget(target, input, context);
    expect(result.proposals.map(proposal => proposal.proposedValue)).toEqual(['Chicken']);
  });


  it('refuses captured mappings to pricing, native and unknown destinations before single/batch inference', async () => {
    const sku = 'SKU-PROTECTED-BINDINGS';
    for (const catalogField of ['ProductField6', 'ProductType', 'ProductField999']) {
      const config = configFixture();
      config.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!.catalogField = catalogField;
      config.curationTargets!.find(target => target.attributeId === 'flavor')!.catalogField = catalogField;
      const context = fieldStageContext(workspacePath, 'protected-binding', sku, config);
      const target = fieldTarget('flavor-target', 'flavor', catalogField, ['Chicken']);
      const input = fieldStageInput(sku, []);
      const single = await processProductFieldTarget(target, input, context);
      expect(single.proposals).toEqual([]);
      expect(single.message).toContain('protected_target_refused');
      const batch = await processProductFieldTargetsBatch([{ target }], input, context);
      expect(batch.proposals).toEqual([]);
      expect(batch.messages.join('; ')).toContain('protected_target_refused');
    }
  });

  it('refuses incompatible captures without producing field proposals', async () => {
    const sku = 'SKU-CAPTURE-IDENTITY';
    const target = fieldTarget('flavor-target', 'flavor', 'ProductField23', ['Chicken']);
    const context = fieldStageContext(workspacePath, 'capture-identity', sku);
    const input = fieldStageInput(sku, []);
    for (const incompatible of [
      { ...context, snapshot: { ...context.snapshot!, snapshotHash: 'invalid' } },
      { ...context, snapshot: { ...context.snapshot!, productSku: 'ANOTHER-SKU' } },
    ]) {
      const result = await processProductFieldTarget(target, input, incompatible);
      expect(result.proposals).toEqual([]);
      expect(result.message).toContain('configuration_gap');
      const batch = await processProductFieldTargetsBatch([{ target }], input, incompatible);
      expect(batch.proposals).toEqual([]);
      expect(batch.messages.join('; ')).toContain('configuration_gap');
    }
  });

  it('refuses stale/protected reviewed destinations atomically, even for explicit removals', () => {
    const sku = 'SKU-ATOMIC-DESTINATIONS';
    for (const destination of ['stale', 'ProductField6', 'ProductType', 'ProductField999']) {
      const config = extendConfigWithMaterial(configFixture());
      const materialMapping = config.attributeMappings.find(mapping => mapping.attributeId === 'material')!;
      if (destination === 'stale') materialMapping.isStale = true;
      else {
        materialMapping.catalogField = destination;
        config.curationTargets!.find(target => target.attributeId === 'material')!.catalogField = destination;
      }
      const captured = fieldStageContext(workspacePath, 'authority-capture', sku, config);
      const persisted = persistRuntimeSnapshot(captured.snapshot!);
      const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { sourceKind: 'catalog_product' });
      for (const [id, attributeId] of [[`known-${destination}`, 'flavor'], [`unsafe-${destination}`, 'material']]) {
        getDb().run(`INSERT INTO classification_proposals
          (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
          VALUES (?, ?, ?, 'field_assignment', ?, ?, 0.9, 'pending', datetime('now'))`,
        [id, run.id, sku, attributeId, JSON.stringify(attributeId === 'flavor' ? 'Chicken' : 'Rubber')]);
      }
      completeRun(run.id, 'completed');
      for (const correction of [{}, { revisedValue: null }, { revisedTargetId: null }]) {
        const result = submitFrozenDecision({ workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
          decisions: [
            { proposalId: `known-${destination}`, decision: 'accepted' },
            { proposalId: `unsafe-${destination}`, decision: 'accepted', ...correction },
          ] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe(destination === 'stale' ? 'configuration_gap' : 'protected_target_refused');
        expect(getLiveDecisionsByRun(run.id)).toEqual([]);
        expect(getAcceptedProposals(sku, run.id)).toEqual([]);
        expect(getProposalsByRun(run.id).every(proposal => proposal.status === 'pending')).toBe(true);
      }
    }
  });

  it('decisions → draft: protected revised target refused; accepted flavor applies; draft preserves the rest', async () => {
    const sku = 'SKU-DRAFT';
    const now = new Date().toISOString();
    const product: Product = {
      schemaVersion: 1, id: 'p-seam', sku, status: 'active',
      core: {
        name: 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Yummy kibble',
        inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
        weight: '5 lb', taxable: true, media: { primary: 'products/x/primary.jpg', additional: ['products/x/alt.jpg'] },
        seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: ['Old Page'],
      },
      customFields: { ProductField16: 'Acme', ProductField23: 'Beef' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };
    writeProductFile(workspacePath, product);
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const snapshot = buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: now }, sourceProductHash: computeProductHash(product) });
    const persisted = persistRuntimeSnapshot(snapshot);

    const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { sourceKind: 'catalog_product', sourceProductHash: snapshot.sourceProductHash });
    const db = getDb();
    const curated = await processProductFieldTarget(
      fieldTarget('flavor-target', 'flavor', 'ProductField23', ['Chicken', 'Beef']),
      fieldStageInput(sku, [ev('supplied-flavor', run.id, sku, {
        source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken dinner', snippet: 'Chicken dinner',
      })]),
      { workspacePath, workspaceId: WS_ID, runId: run.id, configSnapshotRef: snapshot.configSnapshotRef, snapshot },
    );
    expect(curated.proposals.map(proposal => [proposal.targetId, proposal.proposedValue])).toEqual([['flavor', 'Chicken']]);
    const proposal = curated.proposals[0];
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, proposal.proposalType, proposal.targetId, JSON.stringify(proposal.proposedValue), proposal.confidence, 'pending', now]);
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-brand-hist', run.id, sku, 'field_assignment', 'brand', '"Acme"', 0.9, 'pending', now]);
    completeRun(run.id, 'completed');

    // Attempted protected revised target → attributable refusal.
    const refused = submitFrozenDecision({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted', revisedTargetId: 'brand', revisedValue: 'Acme' }],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('protected_target_refused');

    // Historical Brand proposal accept → refused; reject → passes.
    const histAccept = submitFrozenDecision({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-brand-hist', decision: 'accepted' }],
    });
    expect(histAccept.ok).toBe(false);
    if (!histAccept.ok) expect(histAccept.code).toBe('protected_target_refused');
    const histReject = submitFrozenDecision({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-brand-hist', decision: 'rejected' }],
    });
    expect(histReject.ok).toBe(true);

    // Accept the owned flavor proposal, then apply: draft carries only the
    // owned change; identity/Name/description/images/pricing/inventory/Brand
    // survive byte-identical.
    const acceptFlavor = submitFrozenDecision({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted' }],
    });
    expect(acceptFlavor.ok).toBe(true);
    expect(getProposalsByRun(run.id).filter(p => p.targetId === 'brand' && p.status === 'accepted')).toEqual([]);
    expect(getAcceptedProposals(sku, run.id).map(p => p.targetId)).toEqual(['flavor']);

    const result = await applyFrozenCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).toEqual(['ProductField23']);
    const items = listChangeSetItems(result.changeSetId);
    const draftFields = readChangeSetCustomFields(items[0].draftJson);
    expect(draftFields.ProductField23).toBe('Chicken');
    expect(draftFields.ProductField16).toBe('Acme');
    const draft = JSON.parse(items[0].draftJson) as Product;
    expect(draft.core).toEqual(product.core);
    expect(draft.shopsite).toEqual(product.shopsite);
    expect(draft.sku).toBe(sku);
  });

  it('issue #357: a corrected Flavor→Material destination agrees between preview and draft; Brand still never writes', async () => {
    // Certified slots (docs/audits/extra-fields-certification-2026-10-15):
    // PF23 Facet-Flavor, PF28 Facet-Material. A reviewed correction moves
    // the value to the MATERIAL slot; the Brand slot is untouched in both
    // surfaces. Fails on old main where preview kept the original slot.
    const sku = 'SKU-CORRECTED-DEST';
    const now = new Date().toISOString();
    const product = correctedDestProduct(sku, now);
    writeProductFile(workspacePath, product);
    const extendedConfig = extendConfigWithMaterial(configFixture());
    persistFixtureConfig(extendedConfig);
    const ref = createConfigSnapshot(WS_ID, extendedConfig);
    const captured = buildRuntimeSnapshot({
      workspaceId: WS_ID, workspacePath, productSku: sku, config: extendedConfig,
      configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: now },
      sourceProductHash: computeProductHash(product),
    });
    const persisted = persistRuntimeSnapshot(captured);
    const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { sourceKind: 'catalog_product', sourceProductHash: computeProductHash(product) });
    const db = getDb();
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', now]);
    completeRun(run.id, 'completed');
    const reviewed = submitFrozenDecision({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted', revisedTargetId: 'material', revisedValue: 'Rubber' }],
    });
    expect(reviewed.ok).toBe(true);
    const accepted = getAcceptedProposals(sku, run.id);
    const mappings = captured.attributeMappings;
    const projection = buildAssignmentProjection(
      accepted, product.customFields, product.core.productOnPages ?? [], mappings, new Set(),
      { attributes: captured.attributes, frozenMappings: captured.attributeMappings },
    );
    expect(projection.skipped).toEqual([]);
    const projectedByField: Record<string, string> = {};
    for (const field of projection.fields) projectedByField[field.catalogField] = field.proposedValue ?? '';
    expect(projectedByField['ProductField28']).toBe('Rubber');
    expect('ProductField23' in projectedByField).toBe(false);
    expect(isTaxonomyFrozen()).toBe(true);
    const stageResult = await productDraftProjectionStage.execute(
      { sku, evidence: [], acceptedProposals: accepted, allProposals: accepted },
      { workspacePath, workspaceId: WS_ID, runId: run.id, configSnapshotRef: captured.configSnapshotRef, snapshot: captured },
    );
    const previewAssignments = readPreviewFieldAssignments(stageResult);
    expect(previewAssignments['ProductField28']).toBe('Rubber');
    expect(previewAssignments['ProductField23']).toBeUndefined();
    const result = await applyFrozenCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).toEqual(['ProductField28']);
    const items = listChangeSetItems(result.changeSetId);
    const draftFields = readChangeSetCustomFields(items[0].draftJson);
    expect(draftFields['ProductField28']).toBe('Rubber');
    expect(draftFields['ProductField23']).toBe('Beef');
    expect(draftFields['ProductField16']).toBe('Acme');
  });
});
