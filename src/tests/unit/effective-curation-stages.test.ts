/**
 * Profile-dependent behavior through real stages and persisted proposals.
 * The old synthetic v1/Type-only, execution-fallback and wording assertions
 * are covered by the canonical-pair workflow/provisional seam. These cases
 * retain invariant and reviewed-only condition behavior with governed fields.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, getProposalsByRun } from '../../db/repositories/classification-run-repo';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { primaryProductTypeStage } from '../../classification/stages/primary-product-type';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import { runPipeline } from '../../classification/pipeline-runner';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/schemas/classification';

const NOW = '2026-08-01T12:00:00.000Z';
const WORKSPACE_ID = 'ws-effective-curation';
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
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-curation-'));
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WORKSPACE_ID, name: 'Effective curation fixture', workspacePath, gitPath: '',
    createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null,
  });
  globalThis.fetch = rejectingFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

async function runProfilePass(mode: 'invariant' | 'condition', reviewedProductTypeId?: string) {
  const invariant = mode === 'invariant';
  const productType: BayStateSeed['productTypes'][number] = {
    id: 'dry-dog-food', name: 'Dry Dog Food', description: null, categoryId: 'dog-food',
    invariantAttributes: invariant ? { flavor: 'Chicken' } : {},
  };
  const productTypes: BayStateSeed['productTypes'] = reviewedProductTypeId
    ? [productType, {
      id: reviewedProductTypeId, name: 'Wet Dog Food', description: null, categoryId: 'dog-food',
      invariantAttributes: { flavor: 'Beef' },
    }]
    : [productType];
  const attributes: BayStateSeed['attributes'] = (invariant ? [
    { id: 'flavor', name: 'Flavor', allowedValues: ['Chicken', 'Beef'] },
    { id: 'color', name: 'Color', allowedValues: ['Red', 'Blue'] },
  ] : [
    { id: 'species', name: 'Pet Type', allowedValues: ['Dog', 'Cat'] },
    { id: 'material', name: 'Material', allowedValues: ['Rubber', 'Paper'] },
  ]).map(attribute => ({
    ...attribute, description: null, valueMode: 'controlled', canonicalUnit: null,
    valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: false,
    isCompositionAttribute: false, group: null, isUniversal: false,
  }));
  const fields: Record<string, string> = {
    flavor: 'ProductField23', color: 'ProductField29', species: 'ProductField17', material: 'ProductField28',
  };
  const { bundle } = generateCandidate({
    ...BayStatePetGardenSeed, name: 'Effective curation fixture', revision: `effective-${mode}`,
    categories: [{ id: 'dog-food', name: 'Dog Food', description: null }], productTypes,
    attributes,
    profileTemplates: [{
      id: 'food-profile', name: 'Food profile',
      productTypeIds: reviewedProductTypeId ? ['dry-dog-food', reviewedProductTypeId] : ['dry-dog-food'],
      attributes: invariant ? [{ attributeId: 'flavor', required: true, cardinality: 'single' }] : [
        { attributeId: 'species', required: true, cardinality: 'single' },
        { attributeId: 'material', required: false, cardinality: 'single', applicabilityConditions: [{ operator: 'equals', attributeId: 'species', value: 'Dog', factSource: 'accepted_reviewed' }] },
      ],
    }],
    mappings: attributes.map(attribute => ({
      id: `${attribute.id}-map`, attributeId: attribute.id, catalogField: fields[attribute.id]!,
      serialization: { kind: 'scalar', prefix: '', suffix: '' },
    })),
    curationTargets: [
      { id: 'type', kind: 'product_type', label: 'Product Classification', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, sortOrder: 0 },
      ...attributes.map((attribute, index): BayStateSeed['curationTargets'][number] => ({
        id: `target-${attribute.id}`, kind: 'product_field', label: attribute.name,
        enabled: true, mandatory: false, selectionMode: 'single', attributeId: attribute.id,
        catalogField: fields[attribute.id]!, optionSource: 'configured', required: false, sortOrder: index + 1,
      })),
    ],
    brands: [], guidance: [],
  }, {
    schemaVersion: 1, sourceTreeHash: '0'.repeat(64), productFileCount: 0, parseFailureCount: 0,
    parseFailures: [], fieldRegistry: { entryCount: 0, xmlFields: [] }, fields: [], pages: [],
  });
  const sku = `PROFILE-${mode}`;
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WORKSPACE_ID, workspacePath, productSku: sku, authority: { kind: 'v2', bundle },
    configSnapshotRef: { id: `profile-${mode}`, hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: NOW },
    sourceProductHash: null,
  });
  const stored = persistRuntimeSnapshot(snapshot);
  const run = createRun(WORKSPACE_ID, sku, stored.id, stored.hash, { sourceKind: 'catalog_product' });
  const text = invariant ? 'Dry Dog Food in a Red package' : 'Dry Dog Food for Dog, material Rubber';
  const evidence: ClassificationEvidence = {
    id: randomUUID(), runId: run.id, stageName: 'evidence_extraction', productSku: sku,
    attributeId: null, source: 'official_product_page', reliability: 'high', sourceUrl: null,
    sourceField: 'description', snippet: text, value: text, metadata: {}, capturedAt: NOW,
  };
  getDb().run(
    `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, source_field, snippet, value_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [evidence.id, run.id, sku, evidence.stageName, evidence.source, evidence.reliability,
      evidence.sourceField, text, JSON.stringify(text), '{}', NOW],
  );
  const acceptedPair: ClassificationProposal[] = reviewedProductTypeId ? [{
    id: 'reviewed-product-classification', runId: run.id, productSku: sku,
    proposalType: 'product_classification', targetId: 'dry-dog-food',
    proposedValue: { categoryId: 'dog-food', productTypeId: 'dry-dog-food' },
    evidenceIds: [], isBulkAcceptable: false, isStale: false, stalenessReason: null,
    confidence: 1, status: 'accepted', hasRevisedValue: false,
    hasRevisedTargetId: true, revisedTargetId: reviewedProductTypeId, createdAt: NOW,
  }] : [];
  await runPipeline([primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage], {
    workspacePath, workspaceId: WORKSPACE_ID, runId: run.id, configSnapshotRef: snapshot.configSnapshotRef, snapshot,
  }, { sku, evidence: [evidence], acceptedProposals: acceptedPair, allProposals: [] });
  return getProposalsByRun(run.id);
}

describe('profile-governed curation outcomes', () => {
  it('persists a configured invariant as a pending proposal without widening profile membership', async () => {
    const proposals = await runProfilePass('invariant');
    expect(proposals.find(proposal => proposal.proposalType === 'product_classification')).toMatchObject({
      status: 'pending', proposedValue: { categoryId: 'dog-food', productTypeId: 'dry-dog-food' },
    });
    const assignments = proposals.filter(proposal => proposal.proposalType === 'field_assignment');
    expect(assignments.map(proposal => ({
      targetId: proposal.targetId, value: proposal.proposedValue, status: proposal.status,
      confidence: proposal.confidence, isBulkAcceptable: proposal.isBulkAcceptable, derivation: proposal.derivation,
    }))).toEqual([{
      targetId: 'flavor', value: 'Chicken', status: 'pending', confidence: 1, isBulkAcceptable: false,
      derivation: { kind: 'product_type_invariant', productTypeId: 'dry-dog-food', productTypeSource: 'provisional' },
    }]);
  });

  it('does not treat a pending discriminator assignment as a reviewed applicability fact', async () => {
    const proposals = await runProfilePass('condition');
    expect(proposals.filter(proposal => proposal.proposalType === 'field_assignment').map(proposal => ({
      targetId: proposal.targetId, value: proposal.proposedValue, status: proposal.status,
    }))).toEqual([{ targetId: 'species', value: 'Dog', status: 'pending' }]);
  });

  it('uses a reviewed target-only Product Type correction when deriving configured attributes', async () => {
    const proposals = await runProfilePass('invariant', 'wet-dog-food');
    const flavor = proposals.find(proposal => proposal.proposalType === 'field_assignment');
    expect(flavor).toMatchObject({
      targetId: 'flavor',
      proposedValue: 'Beef',
      derivation: { kind: 'product_type_invariant', productTypeId: 'wet-dog-food', productTypeSource: 'reviewed' },
    });
  });
});
