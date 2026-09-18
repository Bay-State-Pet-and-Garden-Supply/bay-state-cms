// Browser Investigation background worker (#243).
//
// Sequential worker-loop that runs QUEUED investigations off the HTTP
// request path. It reuses the server's existing sequential worker-loop
// pattern (one sequential poller per process with an in-flight guard,
// setInterval + unref, start/stop/tick — mirrors
// `src/server/services/store-manager-event-worker.ts` and the pipeline
// `OnboardingWorker` poll loop) and the existing `browser_investigations`
// rows as the queue: no new queue system and no new table.
//
// Why this mechanism (and not the alternatives):
// - Store Manager event worker: rejected as the dispatch path because its
//   tick is inert unless `eventTriggersEnabled` is on and the kill switch
//   is off, and mixing investigation runs into trigger occurrences would
//   couple unrelated domains (effectively a new queue kind).
// - Pipeline `OnboardingWorker`: rejected because it is a per-workspace,
//   lazily-started item pipeline (2s poll for sourcing/discovery/
//   extraction/curation); investigations are domain-level operator requests
//   launched from routes that never start that worker, so progress would
//   depend on unrelated pipeline activity.
// - This worker: always runs (explicit operator requests must always make
//   progress — no flag/kill-switch gate), claims queued rows oldest-first
//   through the existing `runInvestigation` dispatch, and marks unexpected
//   dispatch failures failed with the stable `provider_error` code so no
//   investigation stays queued forever. Cancellation (#244) keeps working:
//   the sweep re-reads each row before dispatch, so a queued row cancelled
//   between listing and dispatch is skipped (never resurrected); a cancel
//   that lands mid-run aborts the live dispatch through the service's
//   in-process registry (runInvestigation owns the AbortController,
//   cancelInvestigation aborts it), the runner tears down the container,
//   and the terminal `cancelled` row is never rewritten by the settling run.

import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';
import { runInvestigation, type InvestigationStore } from './service';

export interface InvestigationWorkerOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Poll interval (default 2000ms, matches the onboarding worker loop). */
  pollIntervalMs?: number;
  /** Store factory (defaults to the lazy SQLite adapter; injected in tests). */
  storeFactory?: () => InvestigationStore;
  /** Workspace scope seam (defaults to the single-row workspace table). */
  workspaceIds?: string[] | (() => string[]);
  /** Dispatch seam (defaults to the existing service dispatch). */
  run?: typeof runInvestigation;
  /** Logger (defaults to console). */
  log?: Pick<Console, 'error' | 'warn' | 'log'>;
}

export interface InvestigationWorker {
  start(): void;
  stop(): void;
  /** Run one sweep synchronously; returns queued investigations processed. */
  tick(): Promise<number>;
  /** Wake the worker: run a sweep now, chaining after in-flight work. */
  kick(): void;
  get running(): boolean;
}

export function createInvestigationWorker(
  opts: InvestigationWorkerOptions = {},
): InvestigationWorker {
  const now = opts.now ?? (() => new Date());
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const storeFactory = opts.storeFactory ?? defaultSqliteStoreFactory;
  const run = opts.run ?? runInvestigation;
  const log = opts.log ?? console;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let inFlight = false;
  // #243 startup reconciliation runs exactly once per worker instance, on
  // the FIRST start only (never on tick/kick/interval). Any `running` row
  // observed there predates this process — the current process has not
  // dispatched anything yet — so it is an orphan from a previous process
  // (throw after the row moved to running, or process death mid-run) that
  // would otherwise block its domain forever. Live runs started by this
  // process after reconciliation are never revisited.
  let didReconcileOrphans = false;
  // A launch that arrives while a sweep is in flight must not be stranded:
  // the kick flag chains a follow-up sweep when the current one releases
  // the writer guard (the interval sweep is the production backstop; the
  // chain is what converges test processes that never start the interval).
  let kickPending = false;

  function resolveWorkspaceIds(): string[] {
    if (opts.workspaceIds !== undefined) {
      return typeof opts.workspaceIds === 'function' ? opts.workspaceIds() : [...opts.workspaceIds];
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { findWorkspace } = require('../../db/repositories/workspace-repo') as typeof import('../../db/repositories/workspace-repo');
      const ws = findWorkspace();
      return ws ? [ws.id] : [];
    } catch {
      return [];
    }
  }

  /**
   * #243 bounded startup reconciliation: mark pre-existing `running` rows
   * as failed with the stable `provider_error` code. Workspace-agnostic
   * (every resolved workspace), idempotent (re-reads before marking, skips
   * non-running rows), and once-only per worker instance via the caller.
   * Uses only the existing workspace-scoped `list`/`find`/`update` seam —
   * no new repository query.
   */
  async function reconcileOrphanedRunningOnce(): Promise<number> {
    let store: InvestigationStore;
    try {
      store = storeFactory();
    } catch (err) {
      log.error('[InvestigationWorker] reconcile store unavailable:', err);
      return 0;
    }
    let reconciled = 0;
    for (const workspaceId of resolveWorkspaceIds()) {
      let orphans: InvestigationRecord[] = [];
      try {
        orphans = store.list(workspaceId).filter((r) => r.status === 'running');
      } catch (err) {
        log.error(`[InvestigationWorker] reconcile list failed for workspace ${workspaceId}:`, err);
        continue;
      }
      for (const candidate of orphans) {
        try {
          const latest = store.find(workspaceId, candidate.id);
          if (!latest || latest.status !== 'running') continue;
          const at = now().toISOString();
          store.update(workspaceId, candidate.id, {
            status: 'failed',
            failureCode: 'provider_error',
            failureDetail: 'provider_error: investigation orphaned by previous process restart',
            completedAt: at,
            updatedAt: at,
          });
          reconciled += 1;
        } catch (err) {
          log.error(`[InvestigationWorker] reconcile of investigation ${candidate.id} failed:`, err);
        }
      }
    }
    return reconciled;
  }

  /**
   * List rows still `queued`, oldest-first. Returns null when the list
   * itself failed (caller skips the workspace, same as the inline
   * `continue`). Pure read path shared by every sweep.
   */
  function loadQueuedRows(store: InvestigationStore, workspaceId: string): InvestigationRecord[] | null {
    let rows: InvestigationRecord[];
    try {
      rows = store.list(workspaceId);
    } catch (err) {
      log.error(`[InvestigationWorker] list failed for workspace ${workspaceId}:`, err);
      return null;
    }
    return rows
      .filter((r) => r.status === 'queued')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /**
   * Re-read one row before dispatch (#244). Returns the row only when it
   * is still `queued`; a find throw or a row that moved on (cancelled /
   * discarded) yields null so the caller skips it, never resurrecting it.
   */
  function readStillQueued(
    store: InvestigationStore,
    workspaceId: string,
    id: string,
  ): InvestigationRecord | null {
    let latest: InvestigationRecord | null | undefined;
    try {
      latest = store.find(workspaceId, id);
    } catch {
      return null;
    }
    if (!latest) return null;
    if (latest.status !== 'queued') return null;
    return latest;
  }

  /**
   * Settle an unexpected dispatch throw. Only a row still `queued` after
   * the throw is marked failed with the stable `provider_error` code —
   * rows `runInvestigation` already settled (or moved on) are untouched.
   */
  function settleDispatchThrow(store: InvestigationStore, workspaceId: string, id: string, err: unknown): void {
    try {
      const after = store.find(workspaceId, id);
      if (!after) return;
      if (after.status !== 'queued') return;
      const at = now().toISOString();
      const detail = err instanceof Error ? err.message : String(err);
      store.update(workspaceId, id, {
        status: 'failed',
        failureCode: 'provider_error',
        failureDetail: `provider_error: investigation dispatch failed (${detail})`.slice(0, 500),
        completedAt: at,
        updatedAt: at,
      });
    } catch (markErr) {
      log.error(`[InvestigationWorker] investigation ${id} failure-marking failed:`, markErr);
    }
  }

  /**
   * Dispatch one listed candidate. Returns true when the row was still
   * queued and dispatched (success or settled failure both count as
   * processed); false when the re-read skipped it.
   */
  async function dispatchOne(
    store: InvestigationStore,
    workspaceId: string,
    candidate: InvestigationRecord,
  ): Promise<boolean> {
    // Re-read before dispatch: a queued row cancelled/discarded after
    // listing must be skipped, never resurrected to running (#244).
    const latest = readStillQueued(store, workspaceId, candidate.id);
    if (!latest) return false;
    try {
      await run(store, latest.provider, workspaceId, latest.id);
    } catch (err) {
      // `runInvestigation` already records terminal state for known
      // outcomes (provider/budget/resolve failures, cancellation).
      // Fallback for unexpected dispatch throws: never leave queued
      // forever — mark failed with the stable `provider_error` code.
      settleDispatchThrow(store, workspaceId, latest.id, err);
      log.error(`[InvestigationWorker] investigation ${latest.id} dispatch failed:`, err);
    }
    return true;
  }

  /** Sweep one workspace queue; returns queued investigations processed. */
  async function sweepWorkspace(store: InvestigationStore, workspaceId: string): Promise<number> {
    const queued = loadQueuedRows(store, workspaceId);
    if (!queued) return 0;
    let processed = 0;
    for (const candidate of queued) {
      const dispatched = await dispatchOne(store, workspaceId, candidate);
      if (dispatched) processed += 1;
    }
    return processed;
  }

  async function tickOnce(): Promise<number> {
    if (inFlight) return 0; // one writer
    inFlight = true;
    try {
      let store: InvestigationStore;
      try {
        store = storeFactory();
      } catch (err) {
        log.error('[InvestigationWorker] store unavailable:', err);
        return 0;
      }
      let processed = 0;
      for (const workspaceId of resolveWorkspaceIds()) {
        processed += await sweepWorkspace(store, workspaceId);
      }
      return processed;
    } finally {
      inFlight = false;
      if (kickPending) {
        kickPending = false;
        void tickOnce().catch((err) => log.error('[InvestigationWorker] chained tick failed:', err));
      }
    }
  }

  function kick(): void {
    kickPending = true;
    if (!inFlight) {
      void tickOnce().catch((err) => log.error('[InvestigationWorker] kicked tick failed:', err));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      // Sequence reconciliation before the first dispatch: the orphan
      // snapshot must predate any running rows this process creates.
      void (async () => {
        if (!didReconcileOrphans) {
          didReconcileOrphans = true;
          try {
            await reconcileOrphanedRunningOnce();
          } catch (err) {
            log.error('[InvestigationWorker] startup reconcile failed:', err);
          }
        }
        try {
          await tickOnce();
        } catch (err) {
          log.error('[InvestigationWorker] initial tick failed:', err);
        }
      })();
      timer = setInterval(() => {
        void tickOnce().catch((err) => log.error('[InvestigationWorker] tick failed:', err));
      }, pollIntervalMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    async tick() {
      return tickOnce();
    },
    kick() {
      kick();
    },
    get running() {
      return running;
    },
  };
}

function defaultSqliteStoreFactory(): InvestigationStore {
  // Lazy require keeps this module runtime-clean for Vitest (no bun:sqlite
  // at import time); production and Bun suites resolve the SQLite adapter.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createSqliteInvestigationStore } = require('./store') as typeof import('./store');
  return createSqliteInvestigationStore();
}

let singleton: InvestigationWorker | null = null;

/** Process-wide singleton (SQLite-backed). Started in `src/server/index.ts`. */
export function getInvestigationWorker(): InvestigationWorker {
  if (!singleton) singleton = createInvestigationWorker();
  return singleton;
}

/**
 * Schedule background dispatch for a newly queued investigation. Fire-and-
 * forget: never awaited by the request path, never throws. `kick` chains a
 * follow-up sweep when one is already in flight, and the interval sweep
 * remains the backstop — so the row cannot stay queued on a scheduling
 * miss or a launch that lands mid-sweep.
 */
export function scheduleInvestigationDispatch(_workspaceId: string, _id: string): void {
  void _workspaceId;
  void _id;
  try {
    getInvestigationWorker().kick();
  } catch (err) {
    console.error('[InvestigationWorker] background dispatch scheduling failed:', err);
  }
}
