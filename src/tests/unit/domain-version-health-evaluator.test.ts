// Issue #214 — shared domain/version health evaluator: one definition of
// health for activation (candidate) and release (active), plus read-only
// surfacing in retry preview and the profile-state health UI.
//
// Convention: bun:sqlite DB-backed, run under `bun test` (same as
// domain-release-guard.test.ts). Asserts externally visible verdicts —
// healthy/unhealthy agreement between entry points, candidate-without-active
// activation, release refusal of non-active versions — never internals.
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
  updateItemExtractionData,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { createVersion, setActiveVersion, getActiveVersion } from '../../db/repositories/profile-version-repo';
import { resetTestMatrixForTest, runMatrix } from '../../onboarding/profile-test-matrix';
import { setRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { makeDomainHealthy } from './helpers/domain-health-fixture';
import {
  evaluateCandidateVersionHealth,
  evaluateActiveVersionHealth,
  evaluateDomainVersionHealth,
  resolveExecutableProfile,
} from '../../onboarding/domain-version-health';
import { getDomainReleaseHealth, releaseDomainExtractionItems } from '../../onboarding/domain-release';
import { findProfileByDomain, upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const WS_MAIN = 'ws-version-health-main';
const DOMAIN = 'version-health.example.com';

function cleanDomain(domain: string) {
  const db = getDb();
  db.query(`DELETE FROM onboarding_items WHERE source_url LIKE ?`).run(`%${domain}%`);
  db.query(`DELETE FROM extractor_profiles WHERE domain = ?`).run(domain);
  db.query(`DELETE FROM profile_active WHERE domain = ?`).run(domain);
  db.query(`DELETE FROM profile_versions WHERE domain = ?`).run(domain);
  try {
    db.query(`DELETE FROM domain_representative_suite WHERE domain = ?`).run(domain);
  } catch (_e) { /* best-effort */ }
  try {
    db.query(`DELETE FROM domain_waiver WHERE domain = ?`).run(domain);
  } catch (_e) { /* best-effort */ }
  resetTestMatrixForTest();
}

/** A bare version with no matrix evidence and no confirmed suite. */
function makeBareVersion(domain: string) {
  return createVersion({
    domain,
    selectors: { titleSelector: 'h1' },
    runtime: 'rendered',
    sampleIds: [],
    artifactHashes: [],
    validationSummary: {},
    provenance: { provider: 'test', model: 'test', configId: 'test' },
    approver: 'tester',
    reason: 'test',
  });
}

describe('shared domain/version health evaluator (#214)', () => {
  let tempDir: string;
  let mainBatchId: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-health-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: WS_MAIN,
      name: WS_MAIN,
      workspacePath: `/tmp/${WS_MAIN}`,
      gitPath: `/tmp/${WS_MAIN}/.git`,
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    mainBatchId = createBatch({ workspaceId: WS_MAIN, name: 'Health', fileName: 'h.csv', totalItems: 10 }).id;
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetActiveWorkerForTest();
    cleanDomain(DOMAIN);
  });

  it('activation and release agree on a healthy fixture', async () => {
    await makeDomainHealthy(DOMAIN);
    const active = getActiveVersion(DOMAIN)!;
    expect(active).not.toBeNull();

    const candidate = evaluateCandidateVersionHealth(DOMAIN, active.id);
    const release = getDomainReleaseHealth(DOMAIN);
    expect(candidate.healthy).toBe(true);
    expect(candidate.reason).toBeNull();
    expect(release).toEqual({ healthy: true, reason: null });
  });

  it('a selector edit cannot inherit active-version health', async () => {
    await makeDomainHealthy(DOMAIN);
    const active = getActiveVersion(DOMAIN)!;
    upsertProfile(DOMAIN, { titleSelector: '.edited-title' });

    expect(evaluateCandidateVersionHealth(DOMAIN, active.id).healthy).toBe(true);
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: false, reason: 'executable_content_changed' });
  });

  it('activation and release agree on an unhealthy fixture (active version, no evidence)', () => {
    const bare = makeBareVersion(DOMAIN);
    setActiveVersion(DOMAIN, bare.id);

    const candidate = evaluateCandidateVersionHealth(DOMAIN, bare.id);
    const release = getDomainReleaseHealth(DOMAIN);
    expect(candidate.healthy).toBe(false);
    expect(release.healthy).toBe(false);
    expect(release.reason).toBe(candidate.reason);
  });

  it('a candidate evaluates healthy without being active (no circular dependence)', async () => {
    await makeDomainHealthy(DOMAIN);
    const healthy = getActiveVersion(DOMAIN)!;
    const bare = makeBareVersion(DOMAIN);
    // Point active at the unevidenced version: release goes unhealthy…
    setActiveVersion(DOMAIN, bare.id);
    expect(getDomainReleaseHealth(DOMAIN).healthy).toBe(false);
    // …but the healthy candidate still evaluates healthy on its own evidence.
    const candidate = evaluateCandidateVersionHealth(DOMAIN, healthy.id);
    expect(candidate.healthy).toBe(true);
    expect(candidate.reason).toBeNull();
  });

  it('release refuses anything but the active version (version mismatch)', async () => {
    await makeDomainHealthy(DOMAIN);
    const healthy = getActiveVersion(DOMAIN)!;
    const bare = makeBareVersion(DOMAIN);

    // Candidate V2 (unevidenced) is unhealthy; release still reports the
    // active V1 verdict — the two do not leak into each other.
    expect(evaluateCandidateVersionHealth(DOMAIN, bare.id).healthy).toBe(false);
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: true, reason: null });

    // After switching active to V2, release refuses while V1 stays healthy.
    setActiveVersion(DOMAIN, bare.id);
    expect(getDomainReleaseHealth(DOMAIN).healthy).toBe(false);
    expect(evaluateCandidateVersionHealth(DOMAIN, healthy.id).healthy).toBe(true);
  });

  it('unknown versions and foreign-domain versions fail closed', async () => {
    // Foreign-domain probe first: full cleanDomain() would reset the shared
    // matrix store/tables, so this probe uses targeted row cleanup only.
    const foreign = makeBareVersion('foreign-version.example.com');
    const mismatch = evaluateDomainVersionHealth(DOMAIN, foreign.id);
    expect(mismatch.healthy).toBe(false);
    expect(mismatch.reason).toBe('version_domain_mismatch');
    getDb().query(`DELETE FROM profile_versions WHERE domain = ?`).run('foreign-version.example.com');
    getDb().query(`DELETE FROM profile_active WHERE domain = ?`).run('foreign-version.example.com');

    await makeDomainHealthy(DOMAIN);
    const unknown = evaluateDomainVersionHealth(DOMAIN, 'does-not-exist');
    expect(unknown.healthy).toBe(false);
    expect(unknown.reason).toBe('unknown_version');
    // Release health for the healthy domain is untouched by the probes.
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: true, reason: null });
  });

  it('release preserves the no-profile footprint reasons without an active version', () => {
    // No legacy row, no active pointer: the long-standing no_usable_profile.
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: false, reason: 'no_usable_profile' });
    expect(evaluateActiveVersionHealth(DOMAIN)).toMatchObject({ healthy: false, reason: 'no_active_version' });
  });

  it('activating a healthy candidate succeeds even when it is not yet active', async () => {
    await makeDomainHealthy(DOMAIN);
    const healthy = getActiveVersion(DOMAIN)!;
    const bare = makeBareVersion(DOMAIN);
    setActiveVersion(DOMAIN, bare.id);
    upsertProfile(DOMAIN, { titleSelector: '.unreviewed', customSelectors: { size: '.size' } });

    const res = await app.request(`/api/domains/${DOMAIN}/profile/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: healthy.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(true);
    expect(getActiveVersion(DOMAIN)!.id).toBe(healthy.id);
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: true, reason: null });
  });

  it('retry preview surfaces read-only health without gating the deliberate retry', async () => {
    const [item] = insertItems(mainBatchId, [
      {
        upc: 'VH-RETRY-1',
        name: 'Version Health Retry Product',
        rowNumber: 1,
        stage: 'extraction',
        stageStatus: 'failed',
        sourceUrl: `https://${DOMAIN}/products/vh-retry-1`,
      },
    ]);
    updateItemStageStatus(item.id, 'failed', `No extractor profile for ${DOMAIN} — profile required`);

    // Unhealthy domain: preview still lists the item (deliberate retry is
    // ungated) but reports the shared health verdict read-only.
    const preview = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}`);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect((previewBody.items as Array<{ itemId: string }>).map((i) => i.itemId)).toContain(item.id);
    expect(previewBody.health).toMatchObject(getDomainReleaseHealth(DOMAIN));

    await makeDomainHealthy(DOMAIN);
    const healthyPreview = await app.request(`/api/onboarding/settings/profile-retry-preview/${DOMAIN}`);
    expect(healthyPreview.status).toBe(200);
    expect(await healthyPreview.json()).toMatchObject({ health: { healthy: true, reason: null } });
  });

  it('profile-state health UI resolves reviewed health through the shared evaluator', async () => {
    const before = await app.request(`/api/domains/${DOMAIN}/profile-state`);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ reviewedHealth: { healthy: false } });

    await makeDomainHealthy(DOMAIN);
    const after = await app.request(`/api/domains/${DOMAIN}/profile-state`);
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.reviewedHealth).toEqual({ healthy: true, reason: null, versionId: getActiveVersion(DOMAIN)!.id });
    // Existing header fields are untouched.
    expect(body.activeVersion).toBe(getActiveVersion(DOMAIN)!.id);
  });

  it('waiver-backed health agrees across both entry points', async () => {
    const singleDomain = 'waive-version-health.example.com';
    try {
      await makeDomainHealthy(singleDomain, { confirmed: 1, waiver: true });
      const active = getActiveVersion(singleDomain)!;
      const candidate = evaluateCandidateVersionHealth(singleDomain, active.id);
      expect(candidate.healthy).toBe(true);
      expect(getDomainReleaseHealth(singleDomain)).toEqual({ healthy: true, reason: null });
    } finally {
      cleanDomain(singleDomain);
    }
  });

  it('artifact mismatch agrees across both entry points', async () => {
    const urls = [`https://${DOMAIN}/products/p1`, `https://${DOMAIN}/products/p2`, `https://${DOMAIN}/products/p3`];
    setRepresentativeSuite(DOMAIN, urls, 'tester');
    const version = createVersion({
      domain: DOMAIN,
      selectors: { titleSelector: 'h1' },
      runtime: 'rendered',
      sampleIds: urls,
      // Deliberately wrong: does not match the matrix hashes below.
      artifactHashes: ['wrong-a', 'wrong-b', 'wrong-c'],
      validationSummary: { imageRuleOk: true },
      provenance: { provider: 'test', model: 'test', configId: 'test' },
      approver: 'tester',
      reason: 'test',
    });
    await runMatrix({
      domain: DOMAIN,
      draftVersion: version.id,
      samples: urls.map((u, i) => ({ id: u, url: u, expectedTitle: `Product ${i + 1}` })),
      runner: async (sample) => ({
        extractedTitle: `Product ${urls.indexOf(sample.url) + 1}`,
        provenance: 'css:h1',
        artifactHash: `${DOMAIN}-hash-${urls.indexOf(sample.url)}`,
        success: true,
      }),
    });
    setActiveVersion(DOMAIN, version.id);

    const candidate = evaluateCandidateVersionHealth(DOMAIN, version.id);
    const release = getDomainReleaseHealth(DOMAIN);
    expect(candidate.healthy).toBe(false);
    expect(candidate.reason).toBe('artifact_mismatch');
    expect(release).toEqual({ healthy: false, reason: 'artifact_mismatch' });
  });

  it('a healthy active version resolves through the executable-profile resolver', async () => {
    await makeDomainHealthy(DOMAIN);
    const active = getActiveVersion(DOMAIN)!;
    const resolved = resolveExecutableProfile(DOMAIN);
    expect(resolved.id).toBe(active.id);
    expect(resolved.domain).toBe(DOMAIN);
    expect(resolved.titleSelector).toBe('h1');
    expect(resolved.version).toBe(active.version);
  });

  it('a missing active version fails closed through the resolver', async () => {
    expect(() => resolveExecutableProfile(DOMAIN)).toThrow(/no_active_version/);
    expect(evaluateActiveVersionHealth(DOMAIN)).toMatchObject({ healthy: false, reason: 'no_active_version', versionId: null });
  });

  it('an edited active version is re-evaluated, then re-activates and resolves the new content', async () => {
    await makeDomainHealthy(DOMAIN);
    const v1 = getActiveVersion(DOMAIN)!;
    upsertProfile(DOMAIN, { titleSelector: '.edited-title' });
    expect(() => resolveExecutableProfile(DOMAIN)).toThrow(/executable_content_changed/);
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: false, reason: 'executable_content_changed' });
    expect(evaluateCandidateVersionHealth(DOMAIN, v1.id).healthy).toBe(true);

    const evidenceUrls = Array.from({ length: 3 }, (_, i) => `https://${DOMAIN}/products/v2-${i + 1}`);
    setRepresentativeSuite(DOMAIN, evidenceUrls, 'tester');
    const v2 = createVersion({
      domain: DOMAIN,
      selectors: { titleSelector: '.edited-title' },
      runtime: 'rendered',
      sampleIds: evidenceUrls,
      artifactHashes: evidenceUrls.map((_, i) => `${DOMAIN}-v2-hash-${i}`).sort(),
      validationSummary: { imageRuleOk: true },
      provenance: { provider: 'test', model: 'test', configId: 'test' },
      approver: 'tester',
      reason: 'selector edit re-activation',
    });
    await runMatrix({
      domain: DOMAIN,
      draftVersion: v2.id,
      samples: evidenceUrls.map((u, i) => ({ id: u, url: u, expectedTitle: `Product ${i + 1}` })),
      runner: async (sample) => ({
        extractedTitle: `Product ${evidenceUrls.indexOf(sample.url) + 1}`,
        provenance: 'css:.edited-title',
        artifactHash: `${DOMAIN}-v2-hash-${evidenceUrls.indexOf(sample.url)}`,
        success: true,
      }),
    });
    setActiveVersion(DOMAIN, v2.id);

    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: true, reason: null });
    const resolved = resolveExecutableProfile(DOMAIN);
    expect(resolved.id).toBe(v2.id);
    expect(resolved.titleSelector).toBe('.edited-title');
  });

  it('terminal items are untouched by an edit, re-activation, and a domain release sweep', async () => {
    const batch = createBatch({ workspaceId: WS_MAIN, name: 'Terminal', fileName: 'terminal.csv', totalItems: 3 });
    const terminalSpecs: Array<{ upc: string; stage: 'curation' | 'review'; status: 'completed' | 'skipped' }> = [
      { upc: 'VH-TERM-1', stage: 'curation', status: 'completed' },
      { upc: 'VH-TERM-2', stage: 'review', status: 'completed' },
      { upc: 'VH-TERM-3', stage: 'review', status: 'skipped' },
    ];
    const [curated, reviewed, skipped] = insertItems(
      batch.id,
      terminalSpecs.map((s, i) => ({
        upc: s.upc,
        name: `Terminal ${i + 1}`,
        rowNumber: i + 1,
        stage: s.stage,
        stageStatus: 'pending',
        sourceUrl: `https://${DOMAIN}/products/${s.upc.toLowerCase()}`,
      })),
    );
    for (const [item, spec] of [[curated, terminalSpecs[0]], [reviewed, terminalSpecs[1]], [skipped, terminalSpecs[2]]] as const) {
      updateItemExtractionData(item.id, JSON.stringify({ title: 'T' }));
      updateItemStageStatus(item.id, spec.status);
    }
    const before = new Map(
      [curated, reviewed, skipped].map((item) => {
        const row = findItemById(item.id)!;
        return [item.id, { stage: row.stage, stageStatus: row.stageStatus, errorMessage: row.errorMessage }];
      }),
    );

    await makeDomainHealthy(DOMAIN);
    upsertProfile(DOMAIN, { titleSelector: '.edited-title' });
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: false, reason: 'executable_content_changed' });
    expect(releaseDomainExtractionItems(WS_MAIN, DOMAIN, { releaseAllBlocked: true }).releasedIds).toEqual([]);

    const after = new Map(
      [curated, reviewed, skipped].map((item) => {
        const row = findItemById(item.id)!;
        return [item.id, { stage: row.stage, stageStatus: row.stageStatus, errorMessage: row.errorMessage }];
      }),
    );
    expect(after).toEqual(before);
  });
});
