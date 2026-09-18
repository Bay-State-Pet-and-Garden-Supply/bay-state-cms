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
//   between listing and dispatch is skipped (never resurrected).

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

  async function tickOnce(): Promise<number> {
    if (inFlight) return 0; // one writer
    inFlight = true;
    let processed = 0;
    try {
      let store: InvestigationStore;
      try {
        store = storeFactory();
      } catch (err) {
        log.error('[InvestigationWorker] store unavailable:', err);
        return 0;
      }
      for (const workspaceId of resolveWorkspaceIds()) {
        let queued: InvestigationRecord[] = [];
        try {
          const rows = store.list(workspaceId);
          queued = rows
            .filter((r) => r.status === 'queued')
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        } catch (err) {
          log.error(`[InvestigationWorker] list failed for workspace ${workspaceId}:`, err);
          continue;
        }
        for (const candidate of queued) {
          // Re-read before dispatch: a queued row cancelled/discarded after
          // listing must be skipped, never resurrected to running (#244).
          let latest: Awaited<ReturnType<InvestigationStore['find']>>;
          try {
            latest = store.find(workspaceId, candidate.id);
          } catch {
            continue;
          }
          if (!latest || latest.status !== 'queued') continue;
          try {
            await run(store, latest.provider, workspaceId, latest.id);
          } catch (err) {
            // `runInvestigation` already records terminal state for known
            // outcomes (provider/budget/resolve failures, cancellation).
            // Fallback for unexpected dispatch throws: never leave queued
            // forever — mark failed with the stable `provider_error` code.
            try {
              const after = store.find(workspaceId, latest.id);
              if (after && after.status === 'queued') {
                const at = now().toISOString();
                const detail = err instanceof Error ? err.message : String(err);
                store.update(workspaceId, latest.id, {
                  status: 'failed',
                  failureCode: 'provider_error',
                  failureDetail: `provider_error: investigation dispatch failed (${detail})`.slice(0, 500),
                  completedAt: at,
                  updatedAt: at,
                });
              }
            } catch (markErr) {
              log.error(`[InvestigationWorker] investigation ${latest.id} failure-marking failed:`, markErr);
            }
            log.error(`[InvestigationWorker] investigation ${latest.id} dispatch failed:`, err);
          }
          processed += 1;
        }
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
      void tickOnce().catch((err) => log.error('[InvestigationWorker] initial tick failed:', err));
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

/** Test seam: stop and clear the singleton (idempotent). */
export function resetInvestigationWorkerForTest(): void {
  singleton?.stop();
  singleton = null;
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
