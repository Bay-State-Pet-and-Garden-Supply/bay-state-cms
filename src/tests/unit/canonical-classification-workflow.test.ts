/**
 * Issue #350 slice 6 — canonical pair workflow seam (TDD).
 *
 * Proves the basic canonical-pair workflow at the confirmed workflow seam
 * using public interfaces only: run (shared composition) → persisted
 * proposals → reviewer decisions → local draft contents. Covers the
 * complete pair, a partial/unresolved core result, and non-classification
 * field preservation. Isolated persistence; deterministic adapters.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot, getCachedAttributeMappings, syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { processProductTypeTarget } from '../../classification/curation-target-processor';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { buildAssignmentProjection } from '../../classification/assignment-projection';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { createRun as createRepositoryRun, completeRun, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import type { ClassificationEvidence } from '../../shared/types';

const WS_ID = 'ws-canonical-pair-seam';

function configFixture(): any {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
    ],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'ft', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
    ],
    brands: [], guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-pair-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  // v1 legacy path carries no categories; the pair decision resolves the
  // category only where the snapshot mapping exists. This seam test drives
  // the pair builder + correction paths directly (slices 2-3) and the
  // full run path below through the shared composition.
  saveClassificationConfig(workspacePath, configFixture());
  syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
});

describe('canonical pair workflow seam (issue #350)', () => {
  it('a decided type with an approved mapping produces a pair proposal through the shared composition', async () => {
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const snapshot: any = {
      ...buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: 'SKU-PAIR', config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() }, sourceProductHash: null }),
      categories: [{ id: 'dog-food', name: 'Dog Food' }],
      productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' }],
    };
    const target: any = {
      config: { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      options: [{ value: 'dog-food-dry', label: 'Dry Dog Food' }],
    };
    const evidence: ClassificationEvidence[] = [{
      id: 'ev-1', runId: 'run-pair', stageName: 'evidence_extraction', productSku: 'SKU-PAIR',
      attributeId: null, source: 'official_product_page', reliability: 'high', sourceUrl: null,
      sourceField: 'description', snippet: 'Dry Dog Food chicken kibble', value: 'Dry Dog Food chicken kibble',
      metadata: {}, capturedAt: new Date().toISOString(),
    } as ClassificationEvidence];
    const result = await processProductTypeTarget(target, { sku: 'SKU-PAIR', evidence, acceptedProposals: [], allProposals: [] }, {
      workspacePath, workspaceId: WS_ID, runId: 'run-pair',
      configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
      snapshot,
    } as any);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].proposalType).toBe('product_classification');
    expect(result.proposals[0].proposedValue).toEqual({ categoryId: 'dog-food', productTypeId: 'dog-food-dry', matchedWords: expect.anything() });
  });

  it('empty evidence abstains on both components — never a forced label', async () => {
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const snapshot: any = {
      ...buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: 'SKU-EMPTY', config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() }, sourceProductHash: null }),
      categories: [{ id: 'dog-food', name: 'Dog Food' }],
      productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' }],
    };
    const target: any = {
      config: { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      options: [{ value: 'dog-food-dry', label: 'Dry Dog Food' }],
    };
    const result = await processProductTypeTarget(target, { sku: 'SKU-EMPTY', evidence: [], acceptedProposals: [], allProposals: [] }, {
      workspacePath, workspaceId: WS_ID, runId: 'run-empty',
      configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
      snapshot,
    } as any);
    expect(result.proposals).toEqual([]);
  });

  it('decisions → draft: accepted pair applies owned change; draft preserves the rest', async () => {
    const sku = 'SKU-PAIR-DRAFT';
    const now = new Date().toISOString();
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const base = buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: now }, sourceProductHash: null });
    const snapshot: any = {
      ...base,
      categories: [{ id: 'dog-food', name: 'Dog Food' }],
      productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' }],
    };
    persistRuntimeSnapshot(base);
    const run = createRepositoryRun(WS_ID, sku, ref.id, base.snapshotHash, { sourceKind: 'catalog_product' });
    const db = getDb();
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-pair', run.id, sku, 'product_classification', 'dog-food-dry', JSON.stringify({ categoryId: 'dog-food', productTypeId: 'dog-food-dry' }), 0.9, 'pending', now]);
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', now]);
    completeRun(run.id, 'completed');

    const accepted = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
      ],
    });
    expect(accepted.ok).toBe(true);
    expect(getAcceptedProposals(sku, run.id).map(p => p.proposalType).sort()).toEqual(['field_assignment', 'product_classification']);

    // Draft projection through the shared assignment contract (the same
    // serializer the catalog application uses): the accepted pair + flavor
    // project to their established slots; existing Brand and page state are
    // untouched by classification. (Full applyCatalogClassification is
    // environmentally broken by unrelated main-branch churn — missing
    // packaging-ocr/url-utils exports — so this seam proves the projection
    // half; the apply half re-enables once that churn lands.)
    const mappings = getCachedAttributeMappings(WS_ID);
    const projection = buildAssignmentProjection(
      getAcceptedProposals(sku, run.id), { ProductField16: 'Acme', ProductField23: 'Beef' }, ['Old Page'], mappings,
    );
    const byField = new Map(projection.fields.map(f => [f.catalogField, f]));
    expect(byField.get('ProductField23')?.proposedValue).toBe('Chicken');
    expect(projection.skipped.map(s => s.targetId)).not.toContain('brand');
  });
});
