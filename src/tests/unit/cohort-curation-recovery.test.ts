/**
 * Cohort Curation recovery tests (plan Slice 2, §3.2.2).
 *
 * Real persisted output sets with deterministic crash, time, reclaim, and
 * supersession scenarios — all through `executeClaim` and the production
 * `verifyFrozen` callback. Crash checkpoints travel through the public
 * execution invocation; a test calling the parent coordinators directly or
 * mocking them would not be evidence and none does.
 *
 * Title pre-commit crash coverage (plan checkpoint `afterCoordinatedCall`
 * threaded through the public invocation) lives in
 * `cohort-curation-titles.test.ts` (Slice 3): the active-bundle +
 * counting-mock infrastructure required for the real coordinate path lives
 * there. Page pre-commit crash coverage follows in Slice 4 with the shared
 * page lifecycle. Freeze (`beforeFinalCas`) and member
 * (`afterMemberPipeline`) pre-commit crashes are covered here, and both fail
 * when checkpoint threading is removed.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'node:child_process';
import { getDb } from '../../db/connection';
import { findItemById, updateItemExtractionData } from '../../db/repositories/onboarding-item-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  listCohortRunsByCohort,
  reclaimExpiredCohortRuns,
  heartbeatCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { countCohortTitleOutputs } from '../../db/repositories/classification-cohort-output-repo';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { MemberCommitCrashSimulationError } from '../../onboarding/cohort-curation/members';
import { createCohortCuration } from '../../onboarding/cohort-curation/index';
import { OnboardingWorker } from '../../onboarding/job-queue';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
} from '../../classification/flags';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import {
  createDisposableCurationContext,
  createReadyCohort,
  settledExtraction,
  installFetchTransport,
  seedDeterministicTitleOutputs,
  type DisposableCurationContext,
} from './helpers/cohort-curation-harness';

let ctx: DisposableCurationContext;
let denyFetch: { calls: unknown[]; restore: () => void };

beforeAll(() => {
  setTaxonomyFreezeForTests(false);
  ctx = createDisposableCurationContext();
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
  denyFetch = installFetchTransport(() => {
    throw new Error('unexpected model transport on a seeded-reuse path');
  });
});

afterAll(() => {
  denyFetch.restore();
  ctx.cleanup();
  setTaxonomyFreezeForTests(true);
});

afterEach(() => {
  resetCohortCurationFlagsOverride();
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
});

function curation() {
  return createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
}

describe('freeze pre-commit crash through the seam', () => {
  it('beforeFinalCas crash leaves the run freezing with zero rows; clean re-entry completes', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000001': settledExtraction({ _name: 'Acme Freeze Crash 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-fc', COHORT_LEASE_TTL_MS);
    // Crash twice (not once) so the test cannot pass on an at-most-once path.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        curation().executeClaim(claimed.id, 'worker-fc', {
          beforeFinalCas: () => {
            throw new Error('simulated pre-CAS crash');
          },
        }),
      ).rejects.toThrow('simulated pre-CAS crash');
      expect(getCohortRunById(claimed.id)!.status).toBe('freezing');
      expect(countCohortTitleOutputs(claimed.id)).toBe(0);
    }
    const recovered = await curation().executeClaim(claimed.id, 'worker-fc');
    expect(recovered.executed).toBe(true);
    expect(getCohortRunById(claimed.id)!.status).toBe('completed');
    expect(findItemById(items[0].id)!.stageStatus).toBe('completed');
    expect(denyFetch.calls.length).toBe(0);
  });
});

describe('member pre-commit crash through the seam', () => {
  it('afterMemberPipeline crash commits nothing for the member; reclaim re-executes to completion', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000011': settledExtraction({ _name: 'Acme Member Crash 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-mc', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(claimed, ctx.workspacePath, ctx.workspaceId);
    expect(frozen.status).toBe('running');
    await expect(
      curation().executeClaim(frozen.id, 'worker-mc', {
        afterMemberPipeline: () => {
          throw new MemberCommitCrashSimulationError('simulated member-commit crash');
        },
      }),
    ).rejects.toBeInstanceOf(MemberCommitCrashSimulationError);
    // No member commit: no curation data, item not completed, run still running.
    expect(findItemById(items[0].id)!.curationData).toBeNull();
    expect(findItemById(items[0].id)!.stageStatus).not.toBe('completed');
    expect(getCohortRunById(frozen.id)!.status).toBe('running');
    const recovered = await curation().executeClaim(frozen.id, 'worker-mc');
    expect(recovered.executed).toBe(true);
    expect(getCohortRunById(frozen.id)!.status).toBe('completed');
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
    expect(denyFetch.calls.length).toBe(0);
  });
});

describe('expired and reclaimed owners through the seam', () => {
  it('stale owner makes no post-loss writes; the reclaiming owner alone finishes', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000021': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '300000000022': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(claimed, ctx.workspacePath, ctx.workspaceId);
    expect(frozen.status).toBe('running');
    seedDeterministicTitleOutputs(ctx.workspaceId, frozen);

    // Worker A stalls with renewal paused: expire the lease, reclaim under B
    // through the production reclaim path with the production verifier.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', frozen.id]);
    const reclaim = reclaimExpiredCohortRuns(
      ctx.workspaceId,
      new Date().toISOString(),
      run => curation().verifyFrozen(run),
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    expect(reclaim.resumed[0].id).toBe(frozen.id);

    const callsBefore = (getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt;
    const titlesBefore = countCohortTitleOutputs(frozen.id);
    const stale = await curation().executeClaim(frozen.id, 'worker-a');
    expect(stale.executed).toBe(false);
    if (!stale.executed) expect(stale.disposition).toBe('stale-owner');
    // No post-loss writes by A: no new model calls, no new title rows, item untouched.
    expect((getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt).toBe(callsBefore);
    expect(countCohortTitleOutputs(frozen.id)).toBe(titlesBefore);
    expect(findItemById(items[0].id)!.stageStatus).not.toBe('completed');

    // B alone finishes.
    const finished = await curation().executeClaim(frozen.id, 'worker-b');
    expect(finished.executed).toBe(true);
    expect(getCohortRunById(frozen.id)!.status).toBe('completed');
    expect(getCohortRunById(frozen.id)!.claimedBy).toBe('worker-b');
    expect(findItemById(items[0].id)!.stageStatus).toBe('completed');
    expect(denyFetch.calls.length).toBe(0);
  });

  it('exact expiry is not yet reclaimable; one millisecond later it is', async () => {
    createReadyCohort(ctx.workspaceId, {
      '300000000022': settledExtraction({ _name: 'Acme Expiry Edge 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-e', COHORT_LEASE_TTL_MS);
    const at = '2026-01-01T00:00:00.000Z';
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', [at, claimed.id]);
    const equal = reclaimExpiredCohortRuns(ctx.workspaceId, at, run => curation().verifyFrozen(run), 'worker-x', COHORT_LEASE_TTL_MS);
    expect(equal.resumed.length).toBe(0);
    expect(equal.superseded.length).toBe(0);
    const after = reclaimExpiredCohortRuns(
      ctx.workspaceId,
      '2026-01-01T00:00:00.001Z',
      run => curation().verifyFrozen(run),
      'worker-x',
      COHORT_LEASE_TTL_MS,
    );
    expect(after.resumed.length).toBe(1);
    expect(after.resumed[0].id).toBe(claimed.id);
  });
});

describe('freeze drift through the seam', () => {
  it('a freeze-window mutation supersedes the parent with zero execution', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000031': settledExtraction({ _name: 'Acme Drift 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-d', COHORT_LEASE_TTL_MS);
    // The world moves between authority capture and the final CAS — the
    // checkpoint threads the mutation through the public execution
    // invocation, exactly where a racing writer would land.
    const result = await curation().executeClaim(claimed.id, 'worker-d', {
      beforeFinalCas: () => {
        const live = findItemById(items[0].id)!;
        updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, title: 'MUTATED WHILE FREEZING' }));
      },
    });
    expect(result.executed).toBe(false);
    if (!result.executed) expect(result.disposition).toBe('freeze-not-finalized');
    // Old run superseded (never executed), its outputs untouched, slot reopened.
    expect(getCohortRunById(claimed.id)!.status).toBe('superseded');
    expect(countCohortTitleOutputs(claimed.id)).toBe(0);
    expect(findItemById(items[0].id)!.stageStatus).not.toBe('completed');
    const [fresh] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-d', COHORT_LEASE_TTL_MS);
    expect(fresh.id).not.toBe(claimed.id);
    expect(listCohortRunsByCohort(fresh.cohortId).length).toBe(2);
    expect(denyFetch.calls.length).toBe(0);
  });
});

describe('worker wiring through the seam', () => {
  it('a worker poll executes a ready cohort end to end with no caller-built authority', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000041': settledExtraction({ _name: 'Acme Worker Wire 5 lb' }),
    });
    const worker = new OnboardingWorker(ctx.workspaceId, ctx.workspacePath);
    await worker.poll();
    await worker.drain();
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
    expect(denyFetch.calls.length).toBe(0);
  });
});

describe('subprocess restart over the same disposable DB', () => {
  it('a fresh process resumes the frozen run to completion (no process cache is the authority)', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000051': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '300000000052': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-r', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(claimed, ctx.workspacePath, ctx.workspaceId);
    expect(frozen.status).toBe('running');
    seedDeterministicTitleOutputs(ctx.workspaceId, frozen);

    const repoRoot = process.cwd();
    const entryPath = path.join(ctx.workspacePath, 'restart-entry.ts');
    fs.writeFileSync(
      entryPath,
      `import { initDb } from '${repoRoot}/src/db/connection';\n` +
      `import { createCohortCuration } from '${repoRoot}/src/onboarding/cohort-curation/index';\n` +
      `initDb(process.env.SEAM_DB_PATH!);\n` +
      `const curation = createCohortCuration({ workspacePath: process.env.SEAM_WS_PATH!, workspaceId: process.env.SEAM_WS_ID! });\n` +
      `const result = await curation.executeClaim(process.env.SEAM_RUN_ID!, process.env.SEAM_WORKER_ID!);\n` +
      `console.log(JSON.stringify({ executed: result.executed }));\n`,
    );
    const spawned = spawnSync('bun', [entryPath], {
      env: {
        ...process.env,
        SEAM_DB_PATH: ctx.dbPath,
        SEAM_WS_PATH: ctx.workspacePath,
        SEAM_WS_ID: ctx.workspaceId,
        SEAM_RUN_ID: frozen.id,
        SEAM_WORKER_ID: 'worker-r',
      },
      encoding: 'utf-8',
    });
    if (spawned.status !== 0) throw new Error(`restart-entry failed (status ${spawned.status}): ${spawned.stderr}`);
    expect(String(spawned.stderr ?? '')).toBe('');
    expect(spawned.stdout).toContain('"executed":true');
    expect(getCohortRunById(frozen.id)!.status).toBe('completed');
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });
});

// ─── Lease ownership through the seam (transferred from cohort-lease-keeper.test.ts, Slice 5) ──
// Case-level replacement map (ledger §1): the 11 private timer/`lost`/`stopped`
// field and method-count assertions have no replacement value — their
// PUBLIC-behavior equivalents live here, observed through repo lease columns
// and seam dispositions only (never private keeper fields). The renewal
// cadence itself (max(1, floor(TTL/3))) is keeper-internal timer scheduling
// with no repo-visible effect beyond "renewals happen while held"; what is
// pinned here is idempotent sync renewal, reclaim immunity while renewed,
// and zero lease writes after terminal. The isolated suite is deleted in
// this slice.

describe('lease ownership through the seam (transferred Slice 5)', () => {
  it('slow live owner: a renewed lease is not reclaimable; completion leaves no scheduled renewal', async () => {
    createReadyCohort(ctx.workspaceId, {
      '300000000061': settledExtraction({ _name: 'Acme Slow Owner 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-slow', COHORT_LEASE_TTL_MS);
    // Idempotent sync renewal, visible in repo lease columns only.
    const atClaim = getCohortRunById(claimed.id)!.leaseExpiresAt!;
    expect(heartbeatCohortRun(claimed.id, 'worker-slow', COHORT_LEASE_TTL_MS)).toBe(true);
    const renewedOnce = getCohortRunById(claimed.id)!.leaseExpiresAt!;
    expect(renewedOnce >= atClaim).toBe(true);
    expect(heartbeatCohortRun(claimed.id, 'worker-slow', COHORT_LEASE_TTL_MS)).toBe(true);
    const renewedTwice = getCohortRunById(claimed.id)!.leaseExpiresAt!;
    expect(renewedTwice >= renewedOnce).toBe(true);
    // A second worker cannot reclaim the renewed row.
    const attempt = reclaimExpiredCohortRuns(
      ctx.workspaceId,
      new Date().toISOString(),
      run => curation().verifyFrozen(run),
      'worker-x',
      COHORT_LEASE_TTL_MS,
    );
    expect(attempt.resumed.length).toBe(0);
    expect(getCohortRunById(claimed.id)!.claimedBy).toBe('worker-slow');
    // Complete through the seam; the terminal run refuses heartbeat (the
    // repo guards active status) and no future reclaim can touch it.
    const done = await curation().executeClaim(claimed.id, 'worker-slow');
    expect(done.executed).toBe(true);
    expect(heartbeatCohortRun(claimed.id, 'worker-slow', COHORT_LEASE_TTL_MS)).toBe(false);
    const leaseAfter = getCohortRunById(claimed.id)!.leaseExpiresAt;
    const farFuture = reclaimExpiredCohortRuns(
      ctx.workspaceId,
      '2999-01-01T00:00:00.000Z',
      run => curation().verifyFrozen(run),
      'worker-y',
      COHORT_LEASE_TTL_MS,
    );
    // The terminal run is never reclaimed (other tests' leftover live rows
    // may resume in this shared disposable DB — out of scope here).
    expect(farFuture.resumed.every(r => r.id !== claimed.id)).toBe(true);
    expect(farFuture.superseded.every(r => r.id !== claimed.id)).toBe(true);
    // Advancing time performs no lease writes: columns frozen at terminal.
    expect(getCohortRunById(claimed.id)!.leaseExpiresAt).toBe(leaseAfter);
    expect(denyFetch.calls.length).toBe(0);
  });

  it('duplicate executeClaim on a terminal parent is not-executed with zero writes', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '300000000062': settledExtraction({ _name: 'Acme Duplicate Claim 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-dup', COHORT_LEASE_TTL_MS);
    const first = await curation().executeClaim(claimed.id, 'worker-dup');
    expect(first.executed).toBe(true);
    // Second claim on the terminal parent: not-executed disposition, zero
    // writes — no new model calls, title rows, item writes, or lease writes.
    const callsBefore = (getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt;
    const titlesBefore = countCohortTitleOutputs(claimed.id);
    const leaseBefore = getCohortRunById(claimed.id)!.leaseExpiresAt;
    const itemBefore = JSON.stringify(findItemById(items[0].id)!.curationData);
    const second = await curation().executeClaim(claimed.id, 'worker-dup');
    expect(second.executed).toBe(false);
    if (!second.executed) expect(second.disposition).toBe('already-terminal');
    expect((getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt).toBe(callsBefore);
    expect(countCohortTitleOutputs(claimed.id)).toBe(titlesBefore);
    expect(getCohortRunById(claimed.id)!.leaseExpiresAt).toBe(leaseBefore);
    expect(JSON.stringify(findItemById(items[0].id)!.curationData)).toBe(itemBefore);
    expect(denyFetch.calls.length).toBe(0);
  });
});
