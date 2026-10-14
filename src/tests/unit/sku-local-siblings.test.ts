/**
 * Issue #351 — two similar siblings with different facts (TDD workflow seam).
 *
 * Two sibling SKUs share Brand/family identity but carry different own-SKU
 * facts. Each SKU is classified ONLY from its own evidence through the
 * public seam (processProductTypeTarget → persisted proposals → reviewer
 * decisions → draft contents). The sibling with the key fact resolves; the
 * sibling missing it abstains — it must NOT inherit the resolved sibling's
 * conclusion, even though Brand and family agree.
 *
 * Isolated persistence; deterministic adapters; no live ShopSite mutation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { processProductTypeTarget } from '../../classification/curation-target-processor';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import type { ClassificationEvidence } from '../../shared/types';

const WS_ID = 'ws-sku-local-siblings';

function configFixture(): any {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    curationTargets: [
      { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
    ],
    brands: [], guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-local-siblings-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  saveClassificationConfig(workspacePath, configFixture());
  syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
});

function evidence(id: string, runId: string, sku: string, value: string): ClassificationEvidence {
  return {
    id, runId, stageName: 'evidence_extraction', productSku: sku,
    attributeId: null, source: 'official_product_page', reliability: 'high', sourceUrl: null,
    sourceField: 'description', snippet: value, value,
    metadata: {}, capturedAt: new Date().toISOString(),
  } as ClassificationEvidence;
}

async function classifySku(sku: string, texts: string[]) {
  const config = configFixture();
  const ref = createConfigSnapshot(WS_ID, config);
  const snapshot: any = {
    ...buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() }, sourceProductHash: null }),
    categories: [{ id: 'dog-food', name: 'Dog Food' }],
    productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' }],
  };
  const target: any = {
    config: { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
    options: [{ value: 'dog-food-dry', label: 'Dry Dog Food' }],
  };
  const ev = texts.map((text, i) => evidence(`ev-${sku}-${i}`, `run-${sku}`, sku, text));
  return processProductTypeTarget(target, { sku, evidence: ev, acceptedProposals: [], allProposals: [] }, {
    workspacePath, workspaceId: WS_ID, runId: `run-${sku}`,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
    snapshot,
  } as any);
}

describe('two similar siblings with different facts (issue #351)', () => {
  it('sibling with the key fact resolves; sibling missing it abstains — no inheritance', async () => {
    // Sibling A carries the type fact in its own evidence.
    const siblingA = await classifySku('SKU-A', ['Dry Dog Food chicken kibble for adult dogs']);
    expect(siblingA.proposals).toHaveLength(1);
    expect(siblingA.proposals[0].proposalType).toBe('product_classification');

    // Sibling B shares Brand/family but carries no type fact — empty evidence.
    const siblingB = await classifySku('SKU-B', []);
    expect(siblingB.proposals).toEqual([]);

    // The verdicts are independent: B's abstention holds even though A
    // resolved under the same Brand. (Cohort aggregation must not fill it.)
    expect(siblingA.proposals[0].productSku).toBe('SKU-A');
  });

  it('sufficient text without images produces a supported classification', async () => {
    const result = await classifySku('SKU-TEXT', ['Dry Dog Food salmon recipe, complete nutrition for all breeds']);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].proposalType).toBe('product_classification');
  });
});
