// Issue #198 — release guard: no premature requeue before reviewed health.
//
// Route + primitive suite (bun:sqlite — run under `bun test` via test:db,
// same convention as manual-evidence-retry-route.test.ts). Proves the #198
// contract at the two seams the ticket names:
//
// A. Release guard — no automatic mechanism (poll-time sweep,
//    activation-triggered release, builder-save legacy profile write) moves
//    items out of failed extraction before reviewed health is satisfied.
//    Reviewed health = the authoritative activation rule (#197): an active
//    profile version, a passing matrix containing at least the title with
//    matching artifact hashes, 3 confirmed samples or an audited waiver,
//    and the image bar satisfied.
// B. Selected-retry hardening — the per-item retry endpoint accepts only
//    failed-extraction items owned by the requesting workspace.
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
import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { upsertDomainConfig } from '../../onboarding/domain-config-service';
import { makeDomainHealthy } from './helpers/domain-health-fixture';
import {
  releaseDomainExtractionItems,
  sweepDomainReleases,
  getDomainReleaseHealth,
} from '../../onboarding/domain-release';
import { createVersion, setActiveVersion } from '../../db/repositories/profile-version-repo';
import { resetTestMatrixForTest } from '../../onboarding/profile-test-matrix';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const WS_MAIN = 'ws-release-guard-main';
const WS_FOREIGN = 'ws-release-guard-foreign';
const DOMAIN = 'guard.example.com';

function seedFailedItem(batchId: string, upc: string, domain: string = DOMAIN) {
  const [item] = insertItems(batchId, [
    {
      upc,
      name: `Guard Product ${upc}`,
      rowNumber: 1,
      stage: 'extraction',
      stageStatus: 'failed',
      sourceUrl: `https://${domain}/products/${upc.toLowerCase()}`,
    },
  ]);
  updateItemStageStatus(item.id, 'failed', `No extractor profile for ${domain} — profile required`);
  return item;
}

// Reviewed health via the shared fixture (helpers/domain-health-fixture).
const makeHealthy = makeDomainHealthy;

function cleanDomain(domain: string) {
  const db = getDb();
  db.query(`DELETE FROM onboarding_items WHERE source_url LIKE ?`).run(`%${domain}%`);
  db.query(`DELETE FROM extractor_profiles WHERE domain = ?`).run(domain);
  db.query(`DELETE FROM profile_active WHERE domain = ?`).run(domain);
  db.query(`DELETE FROM profile_versions WHERE domain = ?`).run(domain);
  try {
    db.query(`DELETE FROM domain_representative_suite WHERE domain = ?`).run(domain);
  } catch (_e) {
    /* table may not exist in older migrations — suite cleanup is best-effort */
  }
  try {
    db.query(`DELETE FROM domain_waiver WHERE domain = ?`).run(domain);
  } catch (_e) {
    /* table may not exist in older migrations — waiver cleanup is best-effort */
  }
  resetTestMatrixForTest();
}

describe('release guard + selected-retry hardening (#198)', () => {
  let tempDir: string;
  let mainBatchId: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    const now = new Date().toISOString();
    // Main workspace first: findWorkspace() (LIMIT 1) resolves to it, so it
    // is the "requesting workspace" for route-level tests.
    for (const id of [WS_MAIN, WS_FOREIGN]) {
      insertWorkspace({
        id,
        name: id,
        workspacePath: `/tmp/${id}`,
        gitPath: `/tmp/${id}/.git`,
        createdAt: now,
        updatedAt: now,
        bootstrapStatus: 'complete',
        baselineCommit: 'baseline-sha',
      });
    }
    mainBatchId = createBatch({ workspaceId: WS_MAIN, name: 'Guard', fileName: 'g.csv', totalItems: 10 }).id;
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetActiveWorkerForTest();
    cleanDomain(DOMAIN);
  });

  it('legacy profile save leaves failed items untouched (no silent requeue)', () => {
    const item = seedFailedItem(mainBatchId, 'G-LEGACY-1');
    upsertProfile(DOMAIN, { titleSelector: 'h1.product-title' });

    expect(getDomainReleaseHealth(DOMAIN).healthy).toBe(false);
    const res = releaseDomainExtractionItems(WS_MAIN, DOMAIN);
    expect(res.profileAvailable).toBe(false);
    expect(res.releasedIds).toEqual([]);
    const sweep = sweepDomainReleases(WS_MAIN);
    expect(sweep.releasedIds).toEqual([]);
    expect(findItemById(item.id)!.stageStatus).toBe('failed');
  });

  it('domain-config (builder) save leaves failed items untouched', () => {
    const item = seedFailedItem(mainBatchId, 'G-CONFIG-1');
    upsertDomainConfig(DOMAIN, { titleSelector: 'h1', descriptionSelector: '.desc' });

    const res = releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true });
    expect(res.profileAvailable).toBe(false);
    expect(res.releasedIds).toEqual([]);
    expect(findItemById(item.id)!.stageStatus).toBe('failed');
  });

  it('active version without reviewed evidence does not release', async () => {
    const item = seedFailedItem(mainBatchId, 'G-NOEVID-1');
    // Active version exists but there is no matrix and no confirmed suite.
    const v = createVersion({
      domain: DOMAIN,
      selectors: { titleSelector: 'h1' },
      runtime: 'rendered',
      sampleIds: [],
      artifactHashes: [],
      validationSummary: {},
      provenance: { provider: 'test', model: 'test', configId: 'test' },
      approver: 'tester',
      reason: 'test',
    });
    setActiveVersion(DOMAIN, v.id);

    const health = getDomainReleaseHealth(DOMAIN);
    expect(health.healthy).toBe(false);
    const res = releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true });
    expect(res.releasedIds).toEqual([]);
    expect(findItemById(item.id)!.stageStatus).toBe('failed');
  });

  it('healthy domain releases exactly as before (no stuck items)', async () => {
    const blocked = seedFailedItem(mainBatchId, 'G-HEALTHY-1');
    await makeHealthy(DOMAIN);

    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: true, reason: null });
    const res = releaseDomainExtractionItems(WS_MAIN, DOMAIN);
    expect(res.profileAvailable).toBe(true);
    expect(res.releasedIds).toEqual([blocked.id]);
    const after = findItemById(blocked.id)!;
    expect(after.stageStatus).toBe('pending');
    expect(after.errorMessage).toBeNull();
  });

  it('waiver-backed health (1 confirmed + audited waiver) releases', async () => {
    const singleDomain = 'waive-guard.example.com';
    const batchId = mainBatchId;
    const item = seedFailedItem(batchId, 'G-WAIVER-1', singleDomain);
    try {
      await makeHealthy(singleDomain, { confirmed: 1, waiver: true });
      expect(getDomainReleaseHealth(singleDomain).healthy).toBe(true);
      const res = releaseDomainExtractionItems(WS_MAIN, singleDomain);
      expect(res.releasedIds).toEqual([item.id]);
    } finally {
      cleanDomain(singleDomain);
    }
  });

  it('sweep releases only once health is established (no premature, no stuck)', async () => {
    const item = seedFailedItem(mainBatchId, 'G-SWEEP-1');
    upsertProfile(DOMAIN, { titleSelector: 'h1' });
    expect(sweepDomainReleases(WS_MAIN).releasedIds).toEqual([]);
    expect(findItemById(item.id)!.stageStatus).toBe('failed');

    await makeHealthy(DOMAIN);
    expect(sweepDomainReleases(WS_MAIN).releasedIds).toEqual([item.id]);
    expect(findItemById(item.id)!.stageStatus).toBe('pending');
  });

  it('explicit release endpoint 400s with a health reason on unhealthy domains', async () => {
    const item = seedFailedItem(mainBatchId, 'G-ENDPOINT-1');
    upsertProfile(DOMAIN, { titleSelector: 'h1' });

    const res = await app.request(`/api/onboarding/domains/${DOMAIN}/release`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('No usable extractor profile');
    expect(findItemById(item.id)!.stageStatus).toBe('failed');
  });

  it('activating a not-yet-healthy version 409s and leaves items in place', async () => {
    const item = seedFailedItem(mainBatchId, 'G-ACTIVATE-1');
    const created = await app.request('/api/profile-versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: DOMAIN, selectors: { titleSelector: 'h1' }, sampleIds: [], artifactHashes: [] }),
    });
    expect(created.status).toBe(201);
    const version = await created.json();

    const res = await app.request(`/api/domains/${DOMAIN}/profile/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: version.id }),
    });
    expect(res.status).toBe(409);
    expect(findItemById(item.id)!.stageStatus).toBe('failed');
  });

  it('rejects an item in the wrong stage with a clear reason and zero writes', async () => {
    const batch = createBatch({ workspaceId: WS_MAIN, name: 'Retry Neg', fileName: 'n.csv', totalItems: 2 }).id;
    const [curationItem] = insertItems(batch, [
      { upc: 'N-STAGE-1', name: 'Curation Item', rowNumber: 1, stage: 'curation', stageStatus: 'pending' },
    ]);
    const failed = seedFailedItem(batch, 'N-STAGE-2');

    const res = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [curationItem.id, failed.id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain(curationItem.id);
    // Whole batch refused before any write: the eligible item stays failed.
    expect(findItemById(failed.id)!.stageStatus).toBe('failed');
  });

  it('rejects an item with the wrong status (not failed) with a clear reason', async () => {
    const batch = createBatch({ workspaceId: WS_MAIN, name: 'Retry Status', fileName: 's.csv', totalItems: 1 }).id;
    const [pending] = insertItems(batch, [
      {
        upc: 'N-STATUS-1', name: 'Pending Item', rowNumber: 1,
        stage: 'extraction', stageStatus: 'pending', sourceUrl: `https://${DOMAIN}/products/pending`,
      },
    ]);

    const res = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [pending.id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain(pending.id);
    expect(findItemById(pending.id)!.stageStatus).toBe('pending');
  });

  it('rejects a foreign-workspace item and writes nothing', async () => {
    const foreignBatch = createBatch({ workspaceId: WS_FOREIGN, name: 'Foreign', fileName: 'f.csv', totalItems: 1 }).id;
    const foreign = seedFailedItem(foreignBatch, 'N-FOREIGN-1');

    const res = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [foreign.id] }),
    });
    expect(res.status).toBe(404);
    expect(findItemById(foreign.id)!.stageStatus).toBe('failed');
  });

  it('accepts an eligible failed-extraction item in the requesting workspace', async () => {
    const batch = createBatch({ workspaceId: WS_MAIN, name: 'Retry Ok', fileName: 'o.csv', totalItems: 1 }).id;
    const failed = seedFailedItem(batch, 'N-OK-1');

    const res = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [failed.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(findItemById(failed.id)!.stageStatus).toBe('pending');
  });
});
