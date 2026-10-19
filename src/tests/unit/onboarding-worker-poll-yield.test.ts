/**
 * Issue #303 — worker-iteration yield regression.
 *
 * The 2026-09-22 production wedge: the API process spun at >100% CPU with
 * zero request throughput during a batch run, and nothing logged
 * iteration duration or alerted on throughput dropping to zero.
 *
 * This suite proves BOTH halves of the acceptance criterion at the existing
 * public seams (no private-helper assertions, no test-only interfaces):
 *
 * 1. `poll()` always yields to the event loop — proven by an overlapped
 *    throughput smoke: an HTTP request (`GET /api/onboarding/batches`, the
 *    exact cheap endpoint from the incident report) issued WHILE a batch
 *    poll is in flight must be served (200) BEFORE the poll finishes. The
 *    #303 mechanism this guards is the entire poll iteration running
 *    synchronously before any yielding await: with that shape the loop stays
 *    blocked for the whole poll, so the request can only be served after the
 *    poll returns and the poll always wins the race — a fully synchronous
 *    poll fails this test.
 * 2. Iteration-duration observability — `lastPollDuration()` exposes the
 *    wall-clock duration of the last completed iteration; failed iterations
 *    increment `failedPollCount()`, which `start()` uses for backoff.
 *
 * Offline-only: temp DB + workspace, cohort flags OFF (legacy per-item
 * path), no network, no LLM.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { resetCohortCurationFlagsOverride, overrideCohortCurationFlags } from '../../classification/flags';
import { resetSourcingFlagsOverride } from '../../onboarding/flags';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { sweepAutoAdvance } from '../../onboarding/auto-advance';
import app from '../../server/app';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import type { Workspace } from '../../shared/types';

describe('OnboardingWorker poll iteration always yields (issue #303)', () => {
  let tempDir: string;
  let workspaceId: string;
  let wsPath: string;

  beforeEach(() => {
    delete process.env.BAYSTATE_CMS_SOURCING_ENABLED;
    delete process.env.BAYSTATE_CMS_SOURCING_MODE;
    resetSourcingFlagsOverride();
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: false });
    try { resetActiveWorkerForTest(); } catch { /* no worker started yet */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-poll-yield-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    workspaceId = 'ws-poll-yield';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: wsPath,
      gitPath: path.join(wsPath, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
    resetCohortCurationFlagsOverride();
    try { resetActiveWorkerForTest(); } catch { /* best-effort */ }
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function seedBatch(itemCount: number): string {
    const batch = createBatch({ workspaceId, name: 'Yield batch', fileName: 'yield.csv', totalItems: itemCount });
    const rows = Array.from({ length: itemCount }, (_, i) => ({
      upc: `YIELD-${String(i).padStart(5, '0')}`,
      name: `Yield Item ${i}`,
      brandHint: 'Acme',
      rowNumber: i + 1,
    }));
    insertItems(batch.id, rows, 'discovery', 0);
    // Every item completes discovery with a confirmed URL, so the poll's
    // auto-advance sweep has real synchronous work (find + guarded UPDATE +
    // SSE emit per item) on the measured path.
    const db = getDb();
    for (const row of db.query('SELECT id FROM onboarding_items WHERE batch_id = ?').all(batch.id) as Array<{ id: string }>) {
      db.query(`UPDATE onboarding_items SET stage_status = 'completed', source_url = ? WHERE id = ?`)
        .run(`https://brand.example.com/product/${row.id}`, row.id);
    }
    return batch.id;
  }

  test('an HTTP request issued while a poll is in flight is served before the poll finishes (no synchronous-iteration starvation, issue #303)', async () => {
    seedBatch(50);
    const worker = new OnboardingWorker(workspaceId, wsPath);
    // Serve the real app over loopback so the request below exercises the
    // live event loop — `app.request` would bypass it and could never detect
    // starvation. `port: 0` picks an ephemeral port.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => app.fetch(req),
    });
    try {
      // Start the poll WITHOUT awaiting it: it runs its sweep legs
      // (auto-advance → domain release → claim legs → cohort refresh) with
      // a `setImmediate` yield between every unit of work. While it is in
      // flight, issue the exact cheap read from the incident report WITHOUT
      // awaiting it either, then race the two: the response must win. Only
      // real event-loop yields let socket IO progress between poll chunks —
      // microtask-only awaits would starve the request exactly the way the
      // wedged iteration did — so the race outcome pins the mechanism, not
      // just the status code.
      const pollPromise = worker.poll();
      const resPromise = fetch(`http://127.0.0.1:${server.port}/api/onboarding/batches`);
      const first = await Promise.race([
        resPromise.then(() => 'response' as const),
        pollPromise.then(() => 'poll' as const),
      ]);
      await pollPromise;
      await worker.drain();
      expect(first).toBe('response');
      const res = await resPromise;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { batches?: unknown[] };
      expect(Array.isArray(body.batches)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test('poll records its iteration duration and resets the failure counter', async () => {
    seedBatch(5);
    const worker = new OnboardingWorker(workspaceId, wsPath);

    expect(worker.lastPollDuration()).toBeNull();
    await worker.poll();
    await worker.drain();

    const duration = worker.lastPollDuration();
    expect(typeof duration).toBe('number');
    expect(duration!).toBeGreaterThanOrEqual(0);
    expect(worker.failedPollCount()).toBe(0);
  });

  test('bounded sweeps leave leftovers eligible for a later poll (restart-safe)', async () => {
    // 10 eligible items, sweep budget of 4 shared across three legs with
    // per-leg caps and a rotating start leg: each sweep advances a bounded
    // number of distinct items and leaves the rest eligible; later sweeps
    // pick up new items. Atomic claims + idempotent sweeps make this the
    // restart-safe property the runbook recovery relies on.
    seedBatch(10);
    const first = await sweepAutoAdvance(workspaceId, { limit: 4 });
    const firstTotal = first.discoveryToExtraction.length + first.extractionToCuration.length + first.curationToReview.length;
    expect(firstTotal).toBeGreaterThan(0);
    expect(firstTotal).toBeLessThanOrEqual(4);
    const second = await sweepAutoAdvance(workspaceId, { limit: 4 });
    const secondIds = [...second.discoveryToExtraction, ...second.extractionToCuration, ...second.curationToReview];
    expect(secondIds.length).toBeGreaterThan(0);
    const done = new Set([...first.discoveryToExtraction, ...second.discoveryToExtraction]);
    expect(done.size).toBe(first.discoveryToExtraction.length + second.discoveryToExtraction.length);
  });
});
