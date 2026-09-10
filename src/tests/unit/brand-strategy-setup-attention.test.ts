// Builder slice B2 — observable setup-attention parking (Bun; uses bun:sqlite).
//
// The engine-level skip reasons (strategy_no_usable_source,
// strategy_binding_invalid) are covered at the engine seam; these tests prove
// the worker actually parks the item at needs_input with a
// needs_input_conflict decision through processSourcing — not just a returned
// value nobody consumes.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { startSourcingGeneration, insertEvidenceAttempt } from '../../db/repositories/onboarding-evidence-repo';
import { createDistributor, createConnection, updateConnection } from '../../db/repositories/distributor-repo';
import { addBrandSiteMapping } from '../../db/repositories/brand-site-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import type { Workspace } from '../../shared/types';

describe('Brand strategy setup attention (observable processSourcing parking)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-strategy-setup-attention-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();
    overrideSourcingFlags({ sourcingEngineEnabled: true });

    workspaceId = 'ws-setup-attention';
    const now = new Date().toISOString();
    const ws: Workspace = {
      id: workspaceId,
      name: 'Setup Attention WS',
      workspacePath: tempDir,
      gitPath: path.join(tempDir, '.git'),
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);

    // One enabled distributor connection so the worker reaches the engine
    // instead of the zero-connections pass-through branch.
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    const conn = createConnection({ workspaceId, distributorId: 'dist_phillips', connectorType: 'api', configuration: {} });
    updateConnection(conn.id, workspaceId, { enabled: true });
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeSourcingItem(brandHint: string, upc = '012345678901', name = 'Setup Attention Item') {
    const batch = createBatch({ workspaceId, name: 'SA Batch', fileName: 'sa.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc, name, brandHint, rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    return item;
  }

  test('official-only approved strategy parks at needs_input with a needs_input_conflict decision', async () => {
    addBrandSiteMapping('Acme', 'acme.com');
    saveBrandStrategy(workspaceId, {
      brand: 'Acme',
      sources: [{ kind: 'official_page', domain: 'acme.com' }],
      expectedRevision: 0,
    });
    const item = makeSourcingItem('Acme');

    await new OnboardingWorker(workspaceId, tempDir).poll();

    const after = findItemById(item.id);
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.sourcingDecision?.route).toBe('needs_input_conflict');
    expect(after?.sourcingDecision?.warnings.join(' ')).toContain('official sources are not supported');
  });

  test('pre-builder generation with evidence but no binding parks at needs_input instead of reconciling', async () => {
    // Review-loop R1 P1-1: the reuse path pins the boundary too. Evidence
    // collected before an approval, with no captured binding, must not
    // reconcile under the new approved boundary — park visibly.
    saveBrandStrategy(workspaceId, {
      brand: 'Acme',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const item = makeSourcingItem('Acme', '012345678903', 'Pre-builder Evidence Item');
    const generation = startSourcingGeneration(item.id, 'automatic');
    const conn = getDb().query('SELECT id FROM distributor_connections WHERE workspace_id = ?').get(workspaceId) as { id: string };
    insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'provider_dist_phillips',
      distributorConnectionId: conn.id,
      sourcingGenerationId: generation.id,
      lookupUpc: '012345678903',
      outcome: 'not_stocked',
      confidence: 0,
      evidenceUrl: null,
      matchedFields: [],
      identityJson: null,
      warningsJson: '[]',
      errorCode: null,
      errorMessage: null,
    });

    await new OnboardingWorker(workspaceId, tempDir).poll();

    const after = findItemById(item.id);
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.sourcingDecision?.route).toBe('needs_input_conflict');
    expect(after?.sourcingDecision?.warnings.join(' ')).toContain('binding is missing or invalid');
  });

  test('corrupt strategy binding parks at needs_input instead of dispatching', async () => {
    const item = makeSourcingItem('Acme', '012345678902', 'Binding Invalid Item');
    const generation = startSourcingGeneration(item.id, 'automatic');
    const now = new Date().toISOString();
    getDb()
      .query(
        `INSERT INTO sourcing_generation_strategy_snapshots
          (sourcing_generation_id, workspace_id, item_id, mode, strategy_revision, normalized_brand,
           sources_json, preferred_distributor_ids_json, binding_version, captured_at, created_at)
         VALUES (?, ?, ?, 'approved', 1, 'acme', '[]', '[]', 'bogus-version-v9', ?, ?)`,
      )
      .run(generation.id, workspaceId, item.id, now, now);

    await new OnboardingWorker(workspaceId, tempDir).poll();

    const after = findItemById(item.id);
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.sourcingDecision?.route).toBe('needs_input_conflict');
    expect(after?.sourcingDecision?.warnings.join(' ')).toContain('binding is invalid');
  });
});
