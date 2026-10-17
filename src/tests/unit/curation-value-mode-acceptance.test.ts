import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  resolveAttributeAllowedValues,
  applyCurationTargetsToConfig,
} from '../../classification/curation-targets';
import { deriveCurationApplicability } from '../../classification/curation-applicability';
import type { ClassificationConfig, ProductAttributeConfig, CurationTargetConfig } from '../../shared/schemas/classification';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { createRun, getProposalsByRun } from '../../db/repositories/classification-run-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { runPipeline } from '../../classification/pipeline-runner';
import { primaryProductTypeStage } from '../../classification/stages/primary-product-type';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import type { StageInput } from '../../classification/types';

function rejectingFetch(): typeof fetch {
  return Object.assign(
    async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      throw new Error('Unexpected external request in deterministic fixture');
    },
    { preconnect: () => undefined },
  );
}

describe('Curation Input Mode & ValueMode Enforcement Acceptance Tests', () => {
  let workspacePath: string;
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'value-modes-'));
    globalThis.fetch = rejectingFetch();
    initDb(':memory:');
    runMigrations();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  const measuredSizeAttribute: ProductAttributeConfig = {
    id: 'size',
    name: 'Size',
    description: 'Measured package size',
    valueMode: 'measured',
    canonicalUnit: 'cm',
    allowedValues: [],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Physical Characteristics',
  };

  const freeTextMaterialAttribute: ProductAttributeConfig = {
    id: 'material',
    name: 'Material',
    description: 'Package material',
    valueMode: 'freeText',
    canonicalUnit: null,
    allowedValues: [],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Composition',
  };

  const controlledFlavorAttribute: ProductAttributeConfig = {
    id: 'flavor',
    name: 'Flavor',
    description: 'Product flavor',
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Chicken', 'Beef', 'Salmon'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Product Details',
  };

  const mockConfig: ClassificationConfig = {
    manifest: {
      schemaVersion: 1,
      compatibilityVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fileVersions: {},
    },
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [measuredSizeAttribute, freeTextMaterialAttribute, controlledFlavorAttribute],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'mapping-size', attributeId: 'size', catalogField: 'ProductField27', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'mapping-material', attributeId: 'material', catalogField: 'ProductField28', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'mapping-flavor', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      {
        id: 'target-size',
        kind: 'product_field',
        label: 'Size',
        enabled: true,
        mandatory: false,
        selectionMode: 'single',
        attributeId: 'size',
        catalogField: 'ProductField27',
        optionSource: 'configured',
        required: false,
        sortOrder: 0,
      },
      {
        id: 'target-flavor',
        kind: 'product_field',
        label: 'Flavor',
        enabled: true,
        mandatory: false,
        selectionMode: 'single',
        attributeId: 'flavor',
        catalogField: 'ProductField23',
        optionSource: 'live_store',
        required: false,
        sortOrder: 1,
      },
    ],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5vl:latest',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
  };

  it('1. resolveAttributeAllowedValues returns empty array for measured and freeText attributes even with optionSource live_store', () => {
    const liveStoreSizeTarget: CurationTargetConfig = {
      id: 'target-size',
      kind: 'product_field',
      label: 'Size',
      enabled: true,
      mandatory: false,
      selectionMode: 'single',
      attributeId: 'size',
      catalogField: 'ProductField27',
      optionSource: 'live_store',
      required: false,
      sortOrder: 0,
    };

    const measuredAllowed = resolveAttributeAllowedValues(mockConfig, measuredSizeAttribute, liveStoreSizeTarget);
    expect(measuredAllowed).toEqual([]);

    const freeTextAllowed = resolveAttributeAllowedValues(mockConfig, freeTextMaterialAttribute, liveStoreSizeTarget);
    expect(freeTextAllowed).toEqual([]);
  });

  it('2. applyCurationTargetsToConfig normalizes non-controlled target optionSource to configured', () => {
    const rawTargets = [
      {
        id: 'target-size',
        kind: 'product_field',
        label: 'Size',
        enabled: true,
        catalogField: 'ProductField27',
        attributeId: 'size',
        optionSource: 'configured',
      },
      {
        id: 'target-flavor',
        kind: 'product_field',
        label: 'Flavor',
        enabled: true,
        catalogField: 'ProductField23',
        attributeId: 'flavor',
        optionSource: 'live_store',
      },
    ];

    const updatedConfig = applyCurationTargetsToConfig(mockConfig, rawTargets, 'test-workspace');
    const sizeTarget = updatedConfig.curationTargets.find(t => t.id === 'target-size');
    const flavorTarget = updatedConfig.curationTargets.find(t => t.id === 'target-flavor');

    expect(sizeTarget?.optionSource).toBe('configured');
    expect(flavorTarget?.optionSource).toBe('live_store');
  });

  it('3. applyCurationTargetsToConfig throws error if live_store is explicitly forced on non-controlled attribute', () => {
    const rawTargets = [
      {
        id: 'target-size',
        kind: 'product_field',
        label: 'Size',
        enabled: true,
        catalogField: 'ProductField27',
        attributeId: 'size',
        optionSource: 'live_store',
      },
    ];

    expect(() => applyCurationTargetsToConfig(mockConfig, rawTargets, 'test-workspace')).toThrowError(
      /cannot use optionSource 'live_store' because attribute "Size" has valueMode 'measured'/
    );
  });

  it('proposes measured and free-text values from captured fields without controlled options', async () => {
    const targets: ClassificationConfig['curationTargets'] = [
      { id: 'type', kind: 'product_type', label: 'Product Classification', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, sortOrder: 0 },
      mockConfig.curationTargets[0]!,
      {
        ...mockConfig.curationTargets[0]!, id: 'target-material', label: 'Material',
        attributeId: 'material', catalogField: 'ProductField28', sortOrder: 2,
      },
    ];
    const { bundle } = generateCandidate({
      ...BayStatePetGardenSeed,
      name: 'Value modes fixture', revision: 'value-modes-fixture',
      categories: [{ id: 'pet-supplies', name: 'Pet Supplies', description: null }],
      productTypes: [{ id: 'pet-carrier', name: 'Pet Carrier', description: null, categoryId: 'pet-supplies' }],
      attributes: [measuredSizeAttribute, freeTextMaterialAttribute].map(attribute => ({ ...attribute, isUniversal: false })),
      profileTemplates: [{
        id: 'carrier-profile', name: 'Carrier attributes', productTypeIds: ['pet-carrier'],
        attributes: [{ attributeId: 'size' }, { attributeId: 'material' }],
      }],
      mappings: [
        { id: 'size-map', attributeId: 'size', catalogField: 'ProductField27', serialization: { kind: 'measured', unit: 'cm', valueUnitSeparator: ' ', prefix: '', suffix: '' } },
        { id: 'material-map', attributeId: 'material', catalogField: 'ProductField28', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      ],
      curationTargets: targets, brands: [], guidance: [],
    }, {
      schemaVersion: 1, sourceTreeHash: '0'.repeat(64), productFileCount: 0,
      parseFailureCount: 0, parseFailures: [],
      fieldRegistry: { entryCount: 0, xmlFields: [] }, fields: [], pages: [],
    });
    const sku = 'CARRIER-1';
    insertWorkspace({
      id: 'ws-value-modes', name: 'Value mode fixture', workspacePath, gitPath: '',
      createdAt: bundle.manifest.createdAt, updatedAt: bundle.manifest.createdAt, bootstrapStatus: 'complete', baselineCommit: null,
    });
    const snapshot = buildRuntimeSnapshot({
      workspaceId: 'ws-value-modes', workspacePath, productSku: sku,
      authority: { kind: 'v2', bundle }, sourceProductHash: null,
      configSnapshotRef: { id: 'value-modes', hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: bundle.manifest.createdAt },
    });
    const stored = persistRuntimeSnapshot(snapshot);
    const run = createRun(snapshot.workspaceId, sku, stored.id, stored.hash);
    const input: StageInput = {
      sku, acceptedProposals: [], allProposals: [],
      evidence: [
        { attributeId: null, sourceField: 'name', value: 'Pet Carrier' },
        { attributeId: 'size', sourceField: 'ProductField27', value: '32 cm' },
        { attributeId: 'material', sourceField: 'ProductField28', value: 'Stainless steel' },
      ].map((record, index) => ({
        ...record, id: `value-mode-evidence-${index}`, runId: run.id,
        stageName: 'evidence_extraction', productSku: sku, source: 'official_product_page',
        reliability: 'high', sourceUrl: null, snippet: record.value,
        metadata: {}, capturedAt: bundle.manifest.createdAt,
      })),
    };
    const context = {
      runId: run.id, workspaceId: snapshot.workspaceId, workspacePath: snapshot.workspacePath,
      configSnapshotRef: snapshot.configSnapshotRef, snapshot,
    };
    for (const record of input.evidence) {
      getDb().run(
        `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_field, snippet, value_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, run.id, sku, record.stageName, record.source, record.reliability, record.attributeId,
          record.sourceField, record.snippet, JSON.stringify(record.value), '{}', bundle.manifest.createdAt],
      );
    }
    await runPipeline([primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage], context, input);
    const proposals = getProposalsByRun(run.id);
    expect(proposals.find(proposal => proposal.proposalType === 'product_classification')).toMatchObject({
      productSku: sku, runId: run.id, status: 'pending', proposedValue: { categoryId: 'pet-supplies', productTypeId: 'pet-carrier' },
    });
    expect(proposals.filter(proposal => proposal.proposalType === 'field_assignment')
      .sort((left, right) => left.targetId!.localeCompare(right.targetId!)).map(proposal => ({
      targetId: proposal.targetId, value: proposal.proposedValue, status: proposal.status,
    }))).toEqual([
      { targetId: 'material', value: 'Stainless steel', status: 'pending' },
      { targetId: 'size', value: '32 cm', status: 'pending' },
    ]);
  });

  it('5. deriveCurationApplicability requires exact attributeProfileId and emits product_type_profile_missing when profile is missing', () => {
    const configWithMissingProfile: ClassificationConfig = {
      ...mockConfig,
      productTypes: [
        {
          id: 'garden-hose',
          name: 'Garden Hose',
          description: null,
          attributeProfileId: 'garden-hose-v2-missing',
          oldIdAliases: [],
        },
      ],
      attributeProfiles: [
        {
          id: 'old-garden-hose-profile',
          productTypeId: 'garden-hose',
          name: 'Old Hose Profile',
          attributes: [{ attributeId: 'size', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }],
        },
      ],
    };

    const report = deriveCurationApplicability(configWithMissingProfile);
    const missingFinding = report.findings.find(f => f.code === 'product_type_profile_missing');
    expect(missingFinding).toBeDefined();
    expect(missingFinding?.message).toContain('garden-hose-v2-missing');

    const sizeApplicability = report.applicability.find(a => a.catalogField === 'ProductField27');
    expect(sizeApplicability?.productTypes.length).toBe(0);
  });
});
