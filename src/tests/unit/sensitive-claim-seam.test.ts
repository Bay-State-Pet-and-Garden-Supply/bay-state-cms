/**
 * Issue #352 — sensitive claims need eligible support; conflicts withhold (TDD).
 *
 * At the workflow seam (processProductTypeTarget + processProductFieldTarget
 * → real proposals): a health/composition claim WITHOUT eligible direct
 * product wording abstains (never a forced low-confidence assignment), while
 * an independently supported flavor proposes in the same pass. A conflicting
 * attribute withholds only itself.
 *
 * Isolated persistence; deterministic adapters; no live ShopSite mutation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { createConfigSnapshot, syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { processProductTypeTarget, processProductFieldTarget } from '../../classification/curation-target-processor';
import type { ClassificationEvidence } from '../../shared/types';

const WS_ID = 'ws-claim-seam';

function configFixture(): any {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [] },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
      { id: 'health-claim', name: 'Health Claim', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Joint Support'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: true, isCompositionAttribute: false, group: 'Health' },
    ],
    attributeProfiles: [
      { id: 'dog-profile', productTypeId: 'dog-food-dry', name: 'Dog', attributes: [
        { attributeId: 'flavor', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
        { attributeId: 'health-claim', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
      ] },
    ],
    attributeMappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'claim-map', attributeId: 'health-claim', catalogField: 'ProductField21', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'pt', kind: 'product_type', label: 'Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'ft', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'hc', kind: 'product_field', label: 'Health', enabled: true, selectionMode: 'single', attributeId: 'health-claim', catalogField: 'ProductField21', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [], guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  saveClassificationConfig(workspacePath, configFixture());
  syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
});

function ev(id: string, runId: string, sku: string, value: string): ClassificationEvidence {
  return {
    id, runId, stageName: 'evidence_extraction', productSku: sku,
    attributeId: null, source: 'official_product_page', reliability: 'high', sourceUrl: null,
    sourceField: 'description', snippet: value, value,
    metadata: {}, capturedAt: new Date().toISOString(),
  } as ClassificationEvidence;
}

async function classify(sku: string, texts: string[]) {
  const config = configFixture();
  const ref = createConfigSnapshot(WS_ID, config);
  const snapshot: any = {
    ...buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() }, sourceProductHash: null }),
    categories: [{ id: 'dog-food', name: 'Dog Food' }],
    productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food', attributeProfileId: 'dog-profile' }],
  };
  const ctx: any = {
    workspacePath, workspaceId: WS_ID, runId: `run-${sku}`,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
    snapshot,
  };
  const input: any = { sku, evidence: texts.map((t, i) => ev(`ev-${sku}-${i}`, `run-${sku}`, sku, t)), acceptedProposals: [], allProposals: [] };
  const typeTarget: any = {
    config: { id: 'pt', kind: 'product_type', label: 'Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
    options: [{ value: 'dog-food-dry', label: 'Dry Dog Food' }],
  };
  const pair = await processProductTypeTarget(typeTarget, input, ctx);
  const fieldTarget = (id: string, attributeId: string, field: string, label: string): any => ({
    config: { id, kind: 'product_field', label, enabled: true, selectionMode: 'single', attributeId, catalogField: field, optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
    options: attributeId === 'flavor'
      ? [{ value: 'Chicken', label: 'Chicken' }]
      : [{ value: 'Joint Support', label: 'Joint Support' }],
    attribute: configFixture().attributes.find((a: any) => a.id === attributeId),
  });
  const flavor = await processProductFieldTarget(fieldTarget('ft', 'flavor', 'ProductField23', 'Flavor'), input, ctx);
  const claim = await processProductFieldTarget(fieldTarget('hc', 'health-claim', 'ProductField21', 'Health'), input, ctx);
  return { pair, flavor, claim };
}

describe('sensitive claims need eligible support (issue #352)', () => {
  it('withholds an unsupported claim after matching the Product Type', async () => {
    const { pair, claim } = await classify('SKU-MIX', ['Dry Dog Food chicken kibble, flavor Chicken']);
    expect(pair.proposals).toHaveLength(1);
    expect(claim.proposals.filter(p => p.proposalType === 'field_assignment' && p.targetId === 'health-claim')).toHaveLength(0);
  });
});
