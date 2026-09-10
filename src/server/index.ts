import { serve } from 'bun';
import app from './app';
import { createStoreManagerScheduler } from './services/store-manager-scheduler';
import { createStoreManagerEventWorker } from './services/store-manager-event-worker';
import { getStoreManagerFlags } from '../store-manager/flags';
import { pruneStoreManagerRetention } from '../db/store-manager-operations-migration';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { closeAllHtmlScraperSessions } from '../onboarding/sourcing/html-scraper/session-runner';

const PORT = parseInt(process.env.PORT ?? '3030', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

// ── Store Manager operations console (Issue 4): leased scheduled read-only
// runs. The scheduler is inert unless the feature flag enables it AND the
// kill switch is off. This is a small isolated wiring block — no catalog,
// onboarding, or migration behavior is touched. ──────────────────────────────
const storeManagerScheduler = createStoreManagerScheduler();
const schedulerStarted = (() => {
  const flags = getStoreManagerFlags();
  if (!flags.schedulesEnabled || flags.killSwitch) return false;
  storeManagerScheduler.start();
  return true;
})();

// ── Store Manager operations console (Issue 5): durable event-triggered
// read-only runs. One sequential worker; inert unless the eventTriggersEnabled
// flag is on AND the kill switch is off. Shares the shutdown lifecycle with
// the scheduler. ──────────────────────────────────────────────────────────────
const storeManagerEventWorker = createStoreManagerEventWorker();
const eventWorkerStarted = (() => {
  const flags = getStoreManagerFlags();
  if (!flags.eventTriggersEnabled || flags.killSwitch) return false;
  storeManagerEventWorker.start();
  return true;
})();

const shutdown = async () => {
  storeManagerScheduler.stop();
  storeManagerEventWorker.stop();
  if (retentionTimer) clearInterval(retentionTimer);
  // Amendment B (M2): release all in-memory Distributor Scraper sessions
  // (cookies/credentials are never persisted; browsers are closed).
  await closeAllHtmlScraperSessions().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Store Manager operations console (Issue 9): retention pruning. Runs once
// at startup and then hourly, only when the operations console is enabled and
// the kill switch is off (pruning pauses under the kill switch so history
// stays fully inspectable). Bounded + transactional per workspace; decision/
// audit lineage and ai_model_calls rows are never touched. unref() keeps the
// interval from blocking process exit in tests. ─────────────────────────────
const pruneRetentionOnce = () => {
  const ws = findWorkspace();
  if (!ws) return;
  try {
    pruneStoreManagerRetention(ws.id);
  } catch (err) {
    console.error('[Store Manager] Retention prune failed:', err instanceof Error ? err.message : err);
  }
};
const retentionStarted = (() => {
  const flags = getStoreManagerFlags();
  if (!flags.operationsConsoleEnabled || flags.killSwitch) return false;
  pruneRetentionOnce();
  return true;
})();
const retentionTimer = retentionStarted
  ? setInterval(() => {
      const flags = getStoreManagerFlags();
      if (!flags.operationsConsoleEnabled || flags.killSwitch) return;
      pruneRetentionOnce();
    }, 60 * 60 * 1000)
  : null;
if (retentionTimer) retentionTimer.unref();

const server = serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 60, // SSE connections need longer idle timeout than Bun's default of 10s
});

console.log(`Bay State CMS API server running on http://${HOST}:${PORT}`);
console.log(`Store Manager scheduler: ${schedulerStarted ? 'running' : 'inert (flag off or kill switch on)'}`);
console.log(`Store Manager event worker: ${eventWorkerStarted ? 'running' : 'inert (flag off or kill switch on)'}`);
console.log(`Store Manager retention: ${retentionStarted ? 'running (startup + hourly)' : 'inert (flag off or kill switch on)'}`);
if (process.env.BAYSTATE_CMS_API_TOKEN) {
  console.log(`API token authentication is enabled for mutating requests.`);
} else {
  console.log(`No API token configured. Mutating requests are unauthenticated - set BAYSTATE_CMS_API_TOKEN for production use.`);
}

export { server };
