import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { runPipeline } from '../../classification/pipeline-runner';
import { evidenceExtractionStage } from '../../classification';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import { getDb } from '../../db/connection';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import type { StageContext } from '../../classification/types';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import { snapshotHash } from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';

describe('Brand Integration', () => {
  let workspacePath: string;
  let workspaceId: string;
  let runId: string;
  let context: StageContext;

  beforeAll(() => {
    // P0 taxonomy freeze: this suite writes a legacy config, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-brand-int-${workspaceId.slice(0, 8)}`);
    const dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(dbPath);
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'test-brand',
      workspacePath,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const now = new Date().toISOString();
    // Save config WITHOUT brands first, then WITH brands in specific tests
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [],
      attributes: [],
      attributeProfiles: [],
      attributeMappings: [],
      curationTargets: [],
      guidance: [],
      modelPolicy: {
        defaultProvider: 'ollama', defaultModel: '', stageOverrides: {},
        imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const,
      },
      dataSharing: {
        imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const,
        sensitiveDataFiltering: true, retentionDays: 90,
      },
      brands: [],
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const snapId = randomUUID();
    getDb().run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      [snapId, workspaceId, snapId, JSON.stringify(config), now],
    );
    runId = randomUUID();
    getDb().run(
      `INSERT INTO classification_runs (id, workspace_id, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      [runId, workspaceId, 'BRAND-TEST-1', snapId, snapId, now],
    );
    context = {
      workspacePath,
      workspaceId,
      runId,
      configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: now },
    };
  });

  /**
   * Configure brands in the workspace config and sync to cache.
   */
  function configureBrands(brands: Array<{ id: string; name: string; aliases: string[]; oldIdAliases: string[] }>) {
    const current = loadClassificationConfig(workspacePath);
    const now = new Date().toISOString();
    saveClassificationConfig(workspacePath, {
      ...current,
      manifest: { ...current.manifest, updatedAt: now },
      brands,
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  }

  it('emits resolved_brand evidence when brands are configured', async () => {
    configureBrands([
      { id: 'dr-marty', name: 'Dr. Marty', aliases: ['DR MARTY', 'Dr Marty'], oldIdAliases: [] },
      { id: 'blue-buffalo', name: 'Blue Buffalo', aliases: ['Blue'], oldIdAliases: [] },
    ]);

    const itemId = randomUUID();
    const now = new Date().toISOString();
    const batchId = randomUUID();
    getDb().run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at) VALUES (?, ?, ?, ?, 'imported', 1, ?, ?)`,
      [batchId, workspaceId, 'Brand Batch', 'brand.xlsx', now, now],
    );
    getDb().run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, brand_hint, status, row_number, created_at, updated_at) VALUES (?, ?, 'BRAND-TEST-1', 'Dr. Marty Treats', 'DR MARTY', 'imported', 1, ?, ?)`,
      [itemId, batchId, now, now],
    );

    const result = await runPipeline(
      [evidenceExtractionStage],
      context,
      {
        sku: 'BRAND-TEST-1',
        onboardingItemId: itemId,
        evidence: [],
        acceptedProposals: [],
        allProposals: [],
      },
    );

    const resolvedEvidence = result.evidence.filter(e => e.sourceField === 'resolved_brand');
    expect(resolvedEvidence.length).toBe(1);
    expect(resolvedEvidence[0].source).toBe('catalog_manager_guidance');
    expect(resolvedEvidence[0].reliability).toBe('high');

    const value = resolvedEvidence[0].value as { brandId: string; brandName: string };
    expect(value.brandId).toBe('dr-marty');
    expect(value.brandName).toBe('Dr. Marty');

    // Clean up
    getDb().run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    getDb().run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
  });

  it('does NOT emit resolved_brand evidence when no brands are configured', async () => {
    configureBrands([]);

    const itemId = randomUUID();
    const now = new Date().toISOString();
    const batchId = randomUUID();
    getDb().run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at) VALUES (?, ?, ?, ?, 'imported', 1, ?, ?)`,
      [batchId, workspaceId, 'NoBrand Batch', 'nobrand.xlsx', now, now],
    );
    getDb().run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, brand_hint, status, row_number, created_at, updated_at) VALUES (?, ?, 'BRAND-TEST-NO', 'Generic Treats', 'UnknownBrand', 'imported', 1, ?, ?)`,
      [itemId, batchId, now, now],
    );

    const result = await runPipeline(
      [evidenceExtractionStage],
      context,
      {
        sku: 'BRAND-TEST-NO',
        onboardingItemId: itemId,
        evidence: [],
        acceptedProposals: [],
        allProposals: [],
      },
    );

    const resolvedEvidence = result.evidence.filter(e => e.sourceField === 'resolved_brand');
    expect(resolvedEvidence.length).toBe(0);

    // Clean up
    getDb().run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    getDb().run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
  });

  it('processProductFieldTarget emits no Brand proposal even with resolved evidence (issue #349)', async () => {
    const resolvedEvidence: ClassificationEvidence = {
      id: randomUUID(),
      runId,
      stageName: 'evidence_extraction',
      productSku: 'BRAND-TEST-BF',
      attributeId: null,
      source: 'catalog_manager_guidance',
      reliability: 'high',
      sourceUrl: null,
      sourceField: 'resolved_brand',
      snippet: 'Blue Buffalo',
      value: { brandId: 'blue-buffalo', brandName: 'Blue Buffalo' },
      metadata: { matchedBy: 'exact', confidence: 1.0 },
      capturedAt: new Date().toISOString(),
    };
    const target: ResolvedTarget = {
      config: {
        id: 'brand-field',
        kind: 'product_field', mandatory: false,
        label: 'Brand',
        enabled: true,
        selectionMode: 'single',
        attributeId: 'brand',
        catalogField: 'ProductField16',
        optionSource: 'configured',
        required: false,
        sortOrder: 0,
      },
      options: [
        { value: 'Blue Buffalo', label: 'Blue Buffalo' },
        { value: 'Dr. Marty', label: 'Dr. Marty' },
      ],
      attribute: {
        id: 'brand',
        name: 'Brand',
        description: null,
        valueMode: 'freeText',
        canonicalUnit: null,
        allowedValues: [],
        valueAliases: [],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: 'Identity',
      },
    };
    const result = await processProductFieldTarget(
      target,
      { sku: 'BRAND-TEST-BF', evidence: [resolvedEvidence], acceptedProposals: [], allProposals: [] },
      context,
    );
    expect(result.proposals).toEqual([]);
  });

  it('processProductFieldTarget falls through to normal matching for non-brand fields', async () => {
    // Genuine captured authority: the hardened processor resolves permission
    // and inference inputs from the run's frozen runtime snapshot, so the
    // fixture carries a certified flavor slot (PF23 `Facet - Flavor` per
    // docs/audits/extra-fields-certification-2026-10-15) with a unique
    // current binding. PF1 is uncertified commerce — never classifier-owned.
    const now = new Date().toISOString();
    const frozenConfig = {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [],
      attributes: [
        {
          id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const,
          canonicalUnit: null, allowedValues: ['Chicken', 'Beef'],
          valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }],
          visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food',
        },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct' as const, separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        {
          id: 'flavor-field', kind: 'product_field' as const, mandatory: false, label: 'Flavor',
          enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField23',
          optionSource: 'configured' as const, required: false, sortOrder: 0,
        },
      ],
      guidance: [],
      modelPolicy: {
        defaultProvider: 'ollama', defaultModel: '', stageOverrides: {},
        imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const,
      },
      dataSharing: {
        imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const,
        sensitiveDataFiltering: true, retentionDays: 90,
      },
      brands: [],
    };
    const frozenAttribute = {
      id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled',
      canonicalUnit: null, allowedValues: ['Chicken', 'Beef'],
      valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }],
      visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food',
    } as const;
    const frozenMapping = {
      id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false,
    } as const;
    const frozenTargetConfig = {
      id: 'flavor-field', kind: 'product_field', mandatory: false, label: 'Flavor',
      enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23',
      optionSource: 'configured', required: false, sortOrder: 0,
    } as const;
    const frozenOptions = [{ value: 'Beef', label: 'Beef' }, { value: 'Chicken', label: 'Chicken' }];
    const snapshotBase = {
      schemaVersion: 1, createdAt: new Date().toISOString(), workspaceId, workspacePath, productSku: 'BRAND-TEST-NBF',
      configAuthorityKind: 'v1', sourceCatalogCommit: null, config: { ...frozenConfig, attributes: [frozenAttribute], attributeMappings: [frozenMapping], curationTargets: [frozenTargetConfig] },
      configSnapshotRef: { id: 'snap-flavor', hash: 'hash-flavor', sourceCommit: null, createdAt: new Date().toISOString() },
      focusedFileHashes: {}, catalogEvidenceHash: null, productTypes: [], categories: [],
      attributes: [frozenAttribute], attributeProfiles: [], attributeMappings: [frozenMapping],
      guidance: [], brands: [], modelPolicy: frozenConfig.modelPolicy, dataSharing: frozenConfig.dataSharing,
      curationTargets: [frozenTargetConfig], fieldOptions: { 'flavor-field': frozenOptions },
      reviewedFacts: [], pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
      sourceProductHash: null, searchKeywords: null, productPageNames: [],
      pageImportId: null, pageImportHash: null, pageContextReliability: 'low',
    } as unknown as RuntimeClassificationSnapshot;
    const frozenSnapshot = { ...snapshotBase, snapshotHash: snapshotHash(snapshotBase) };
    const frozenContext: StageContext = { ...context, snapshot: frozenSnapshot };
    const resolvedEvidence: ClassificationEvidence = {
      id: randomUUID(),
      runId,
      stageName: 'evidence_extraction',
      productSku: 'BRAND-TEST-NBF',
      attributeId: null,
      source: 'catalog_manager_guidance',
      reliability: 'high',
      sourceUrl: null,
      sourceField: 'resolved_brand',
      snippet: 'Blue Buffalo',
      value: { brandId: 'blue-buffalo', brandName: 'Blue Buffalo' },
      metadata: { matchedBy: 'exact', confidence: 1.0 },
      capturedAt: new Date().toISOString(),
    };

    const target: ResolvedTarget = {
      config: {
        id: 'flavor-field',
        kind: 'product_field', mandatory: false,
        label: 'Flavor',
        enabled: true,
        selectionMode: 'single',
        attributeId: 'flavor',
        catalogField: 'ProductField23',
        optionSource: 'configured',
        required: false,
        sortOrder: 0,
      },
      options: frozenSnapshot.fieldOptions['flavor-field'] ?? [],
      attribute: {
        id: 'flavor',
        name: 'Flavor',
        description: null,
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: ['Chicken', 'Beef'],
        valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: 'Food',
      },
    };

    const fieldEvidence: ClassificationEvidence = {
      id: randomUUID(),
      runId,
      stageName: 'evidence_extraction',
      productSku: 'BRAND-TEST-NBF',
      attributeId: null,
      source: 'spreadsheet',
      reliability: 'medium',
      sourceUrl: null,
      sourceField: 'name',
      snippet: 'Chicken Flavor',
      value: 'Chicken Flavor',
      metadata: {},
      capturedAt: new Date().toISOString(),
    };

    const result = await processProductFieldTarget(
      target,
      {
        sku: 'BRAND-TEST-NBF',
        evidence: [resolvedEvidence, fieldEvidence],
        acceptedProposals: [],
        allProposals: [],
      },
      frozenContext,
    );

    // Should match "Chicken" via alias, not the brand shortcut
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    if (result.proposals.length > 0) {
      expect(result.proposals[0].targetId).toBe('flavor');
    }
  });

  it('extracts customFields from extraction_data_json as official_product_page evidence', async () => {
    const itemId = randomUUID();
    const now = new Date().toISOString();
    const batchId = randomUUID();
    const extractionData = {
      title: 'Extracted Title',
      customFields: {
        color: 'Blue',
        breedSize: 'Large',
      },
    };

    getDb().run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at) VALUES (?, ?, ?, ?, 'imported', 1, ?, ?)`,
      [batchId, workspaceId, 'Custom Batch', 'custom.xlsx', now, now],
    );
    getDb().run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, extraction_data_json, created_at, updated_at) VALUES (?, ?, 'CUSTOM-TEST-1', 'Test Item', 'imported', 1, ?, ?, ?)`,
      [itemId, batchId, JSON.stringify(extractionData), now, now],
    );

    const result = await runPipeline(
      [evidenceExtractionStage],
      context,
      {
        sku: 'CUSTOM-TEST-1',
        onboardingItemId: itemId,
        evidence: [],
        acceptedProposals: [],
        allProposals: [],
      },
    );

    const colorEvidence = result.evidence.find(e => e.sourceField === 'color');
    expect(colorEvidence).toBeDefined();
    expect(colorEvidence?.source).toBe('official_product_page');
    expect(colorEvidence?.value).toBe('Blue');

    const breedSizeEvidence = result.evidence.find(e => e.sourceField === 'breedSize');
    expect(breedSizeEvidence).toBeDefined();
    expect(breedSizeEvidence?.source).toBe('official_product_page');
    expect(breedSizeEvidence?.value).toBe('Large');

    // Clean up
    getDb().run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    getDb().run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
  });
});
