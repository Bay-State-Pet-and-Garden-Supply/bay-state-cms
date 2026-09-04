// Ticket #105 (parent #101) review P1-2 — route-level coverage for the
// profile-retry guard: POST retry 409s with zero writes when any item holds
// active manual evidence, then withdraw, then retry accepts; the preview
// lists the withdrawn (failed) item.
//
// Route suite (bun:sqlite — run under `bun test` via test:db, same
// convention as brand-assign-routes.test.ts). Follows that file's pattern:
// vitest imports, temp-dir DB, the real Hono app.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  overrideManualEvidenceFlags,
  resetManualEvidenceFlagsOverride,
} from '../../onboarding/flags';
import {
  submitManualEvidence,
  withdrawManualEvidence,
  MANUAL_EVIDENCE_ACTIVE_RETRY_CODE,
} from '../../onboarding/manual-evidence-service';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const wsId = 'ws-manual-retry-route';
const DOMAIN = 'butcherspup.example.com';
const noProfile = { findProfileByDomain: (_domain: string) => null };

function seedFailedItem(upc: string) {
  const batch = createBatch({ workspaceId: wsId, name: 'Retry Route', fileName: 'rr.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [
    {
      upc,
      name: 'Retry Route Product',
      rowNumber: 1,
      stage: 'extraction',
      stageStatus: 'failed',
      sourceUrl: `https://${DOMAIN}/family`,
    },
  ]);
  updateItemStageStatus(item.id, 'failed', `No extractor profile for ${DOMAIN}`);
  return item;
}

describe('manual-evidence retry route guard (ticket #105)', () => {
  let tempDir: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-retry-route-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    overrideManualEvidenceFlags({ enabled: true });
  });

  afterAll(() => {
    resetManualEvidenceFlagsOverride();
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetActiveWorkerForTest();
  });

  it('POST retry 409s with the active-manual code and writes nothing, then withdraw, then retry accepts', async () => {
    const good = seedFailedItem('RR-GOOD-1');
    const manual = seedFailedItem('RR-MANUAL-1');
    const submitted = submitManualEvidence(
      {
        itemId: manual.id,
        workspaceId: wsId,
        operatorId: 'operator-1',
        title: 'Butcher Pup Beef Bites',
        attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
      },
      noProfile,
    );
    expect(submitted.ok).toBe(true);

    // Batch order puts the good item first: the pre-scan must refuse before
    // ANY write, so the good item stays failed (no partial mutation).
    const refused = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [good.id, manual.id] }),
    });
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody.error.code).toBe(MANUAL_EVIDENCE_ACTIVE_RETRY_CODE);
    expect(refusedBody.error.itemIds).toContain(manual.id);
    expect(findItemById(good.id)?.stageStatus).toBe('failed');
    expect(findItemById(manual.id)?.stageStatus).toBe('completed');

    // Withdraw-then-retry per item: the withdrawn item returns to the
    // failed pool (visible in the preview) and the retry accepts it.
    const withdrawn = withdrawManualEvidence({ itemId: manual.id, workspaceId: wsId, operatorId: 'operator-1' });
    expect(withdrawn.ok).toBe(true);

    const preview = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}`);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect((previewBody.items as Array<{ itemId: string }>).map((i) => i.itemId)).toContain(manual.id);

    const accepted = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [good.id, manual.id] }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ accepted: 2 });
    expect(findItemById(good.id)?.stageStatus).toBe('pending');
    expect(findItemById(manual.id)?.stageStatus).toBe('pending');
    expect(getDb().query('SELECT COUNT(*) AS cnt FROM onboarding_extractions WHERE item_id = ? AND extraction_method = ?').get(manual.id, 'manual_evidence_v1') as { cnt: number }).toMatchObject({ cnt: 0 });
  });
});
