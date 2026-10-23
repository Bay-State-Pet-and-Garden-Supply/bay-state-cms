/**
 * Deterministic attribute enrichment through real stages and persisted proposals.
 * Generated pair/profile authority, certified fields and one captured snapshot
 * replace the old live-config/Brand-output fixtures. No model/store transport
 * is needed: these cases exercise supplied text and field-grounded values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, getProposalsByRun } from '../../db/repositories/classification-run-repo';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { runPipeline } from '../../classification/pipeline-runner';
import { primaryProductTypeStage } from '../../classification/stages/primary-product-type';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import type { ClassificationEvidence } from '../../shared/schemas/classification';

const NOW = '2026-08-01T12:00:00.000Z';
const WORKSPACE_ID = 'ws-detail-enrichment';
let workspacePath: string;
const originalFetch = globalThis.fetch;

function rejectingFetch(): typeof fetch {
  return Object.assign(
    async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      throw new Error('Unexpected external request in deterministic fixture');
    },
    { preconnect: () => undefined },
  );
}

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-enrichment-'));
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WORKSPACE_ID, name: 'Detail enrichment fixture', workspacePath, gitPath: '',
    createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null,
  });
  globalThis.fetch = rejectingFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

const ATTRIBUTES: BayStateSeed['attributes'] = [
  { id: 'flavor', name: 'Flavor', valueMode: 'controlled', allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'poultry', mapsTo: 'Chicken' }] },
  { id: 'species', name: 'Pet Type', valueMode: 'controlled', allowedValues: ['Dog', 'Cat'], valueAliases: [{ alias: 'dogs', mapsTo: 'Dog' }] },
  { id: 'material', name: 'Material', valueMode: 'freeText', allowedValues: [], valueAliases: [] },
].map(attribute => ({
  ...attribute, description: null, canonicalUnit: null, visualEvidenceEligibility: 'ineligible',
  isClaim: false, isCompositionAttribute: false, group: null, isUniversal: false,
})) as BayStateSeed['attributes'];

async function enrich(attributeId: string, records: Array<{ field: string; value: string; attributeId?: string }>) {
  const attribute = ATTRIBUTES.find(candidate => candidate.id === attributeId)!;
  const catalogField = { flavor: 'ProductField23', species: 'ProductField17', material: 'ProductField28' }[attributeId]!;
  const { bundle } = generateCandidate({
    ...BayStatePetGardenSeed, name: 'Detail enrichment fixture', revision: 'detail-enrichment-fixture',
    categories: [{ id: 'dog-food', name: 'Dog Food', description: null }],
    productTypes: [{ id: 'dry-dog-food', name: 'Dry Dog Food', description: null, categoryId: 'dog-food' }],
    attributes: [attribute],
    profileTemplates: [{ id: 'food-profile', name: 'Food profile', productTypeIds: ['dry-dog-food'], attributes: [{ attributeId }] }],
    mappings: [{ id: 'detail-map', attributeId, catalogField, serialization: { kind: 'scalar', prefix: '', suffix: '' } }],
    curationTargets: [
      { id: 'type', kind: 'product_type', label: 'Product Classification', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, sortOrder: 0 },
      { id: 'detail', kind: 'product_field', label: attribute.name, enabled: true, mandatory: false, selectionMode: 'single', attributeId, catalogField, optionSource: 'configured', required: false, sortOrder: 1 },
    ],
    brands: [], guidance: [],
  }, {
    schemaVersion: 1, sourceTreeHash: '0'.repeat(64), productFileCount: 0,
    parseFailureCount: 0, parseFailures: [], fieldRegistry: { entryCount: 0, xmlFields: [] }, fields: [], pages: [],
  });
  const sku = `DETAIL-${randomUUID()}`;
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WORKSPACE_ID, workspacePath, productSku: sku, authority: { kind: 'v2', bundle },
    configSnapshotRef: { id: 'detail-config', hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: NOW },
    sourceProductHash: null,
  });
  const stored = persistRuntimeSnapshot(snapshot);
  const run = createRun(WORKSPACE_ID, sku, stored.id, stored.hash, { sourceKind: 'catalog_product' });
  const evidence: ClassificationEvidence[] = [
    { field: 'name', value: 'Dry Dog Food' }, ...records,
  ].map(record => ({
    id: randomUUID(), runId: run.id, productSku: sku, stageName: 'evidence_extraction',
    attributeId: 'attributeId' in record ? record.attributeId ?? null : null,
    source: 'official_product_page', reliability: 'high', sourceUrl: null,
    sourceField: record.field, snippet: record.value, value: record.value, metadata: {}, capturedAt: NOW,
  }));
  // Supplied evidence is durable before the stages cite it in proposals.
  for (const record of evidence) {
    getDb().run(
      `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, run.id, sku, record.stageName, record.source, record.reliability, record.attributeId,
        record.sourceField, record.snippet, JSON.stringify(record.value), '{}', NOW],
    );
  }
  await runPipeline([primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage], {
    workspacePath, workspaceId: WORKSPACE_ID, runId: run.id, configSnapshotRef: snapshot.configSnapshotRef, snapshot,
  }, { sku, evidence, acceptedProposals: [], allProposals: [] });
  const proposals = getProposalsByRun(run.id);
  expect(proposals.find(proposal => proposal.proposalType === 'product_classification')).toMatchObject({
    productSku: sku, runId: run.id, status: 'pending',
    proposedValue: { categoryId: 'dog-food', productTypeId: 'dry-dog-food' },
  });
  return proposals.filter(proposal => proposal.proposalType === 'field_assignment');
}

describe('detail enrichment with captured pair/profile authority', () => {
  it.each([
    ['Chicken', 'Premium Chicken Recipe for Adult Dogs'],
    ['Beef', 'Made with real beef for adult dogs'],
  ])('proposes canonical %s from supplied recipe text', async (value, text) => {
    const proposals = await enrich('flavor', [{ field: 'description', value: text }]);
    expect(proposals.map(proposal => ({ targetId: proposal.targetId, value: proposal.proposedValue, status: proposal.status })))
      .toEqual([{ targetId: 'flavor', value, status: 'pending' }]);
  });

  it('proposes the certified Pet Type value from supplied species text', async () => {
    const proposals = await enrich('species', [{ field: 'description', value: 'A complete meal for dogs' }]);
    expect(proposals.map(proposal => ({ targetId: proposal.targetId, value: proposal.proposedValue, status: proposal.status })))
      .toEqual([{ targetId: 'species', value: 'Dog', status: 'pending' }]);
  });

  it('uses a field-grounded free-text material rather than unrelated listing text', async () => {
    const proposals = await enrich('material', [
      { field: 'ProductField28', attributeId: 'material', value: 'Recyclable paper' },
      { field: 'description', value: 'A convenient package for everyday feeding' },
    ]);
    expect(proposals.map(proposal => ({ targetId: proposal.targetId, value: proposal.proposedValue, status: proposal.status })))
      .toEqual([{ targetId: 'material', value: 'Recyclable paper', status: 'pending' }]);
  });

  it('does not turn unrelated listing copy into a free-text material assignment', async () => {
    const proposals = await enrich('material', [{ field: 'description', value: 'A convenient package for everyday feeding' }]);
    expect(proposals).toEqual([]);
  });
});
