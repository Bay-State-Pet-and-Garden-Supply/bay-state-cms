/**
 * Shared Crawlee PlaywrightCrawler runner for single-page and batch
 * rendered extraction tasks.
 *
 * Provides:
 *   - runRenderedPage()    — single URL, returns one result
 *   - runRenderedPages()   — multiple URLs (e.g. validation samples), batch with shared pool
 *
 * Both use Camoufox (or rollback Playwright) via the launch-context factory,
 * optional proxy configuration, session/cookie persistence, and auto-retries.
 */

import { PlaywrightCrawler, Configuration, type PlaywrightCrawlingContext } from 'crawlee';
import { createLaunchContext } from './camoufox-launch';
import { createWorkerProxyConfiguration } from './proxy';
import { loadWorkerBrowserConfig, type WorkerBrowserConfig } from './config';

// ─── Crawlee storage path ─────────────────────────────────────────────────

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Determine the Crawlee storage directory.
 * Uses .baystate-cms/artifacts/crawlee-storage in the project dir if available,
 * otherwise falls back to a temp directory.
 */
function getCrawleeStorageDir(): string {
  // Try to use the project's artifact area
  const cwd = process.cwd();
  const projectStorage = path.join(cwd, '.baystate-cms', 'artifacts', 'crawlee-storage');
  return projectStorage;
}

/**
 * Configure Crawlee to use the worker artifact area for storage.
 * Must be called before any Crawlee module is imported, because Crawlee
 * reads CRAWLEE_STORAGE_DIR at module-load time.
 */
// fallow-ignore-next-line unused-export — used by tests
export function configureCrawleeStorage(): void {
  const storageDir = getCrawleeStorageDir();
  process.env.CRAWLEE_STORAGE_DIR = storageDir;
  // Purge stale request queues / datasets from previous runs
  process.env.CRAWLEE_PURGE_ON_START = '1';

  // Ensure the directory exists
  try {
    fs.mkdirSync(path.join(storageDir, 'request_queues', 'default'), { recursive: true });
  } catch {
    // non-critical — Crawlee will create it if needed
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RenderedPageInput {
  url: string;
  /** Optional per-request guard installed before navigation (SSRF/policy). */
  networkGuard?: (url: string) => Promise<boolean>;
  /** Optional per-run scratch root for isolated render containers. */
  storageDir?: string;
  /** Per-URL navigation timeout override (ms). */
  navigationTimeoutMs?: number;
  /** Per-URL dwell time override (ms). */
  dwellMs?: number;
}

export interface RenderedPageSuccess<T> {
  ok: true;
  url: string;
  data: T;
}

export interface RenderedPageFailure {
  ok: false;
  url: string;
  error: string;
}

export type RenderedPageResult<T> = RenderedPageSuccess<T> | RenderedPageFailure;

export interface PageExtractor<T> {
  (ctx: PlaywrightCrawlingContext, dwellMs: number): Promise<T>;
}

/**
 * Minimal structural shape of a Playwright route, sufficient for the guarded
 * route handler. Kept structural (not a Playwright type import) so the handler
 * is unit-testable without a browser.
 */
export interface GuardedRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

/**
 * The single authoritative rendered-route handler: EVERY request the page
 * issues (navigation, redirect hops, sub-resources) is passed to
 * `networkGuard`; allowed requests continue, denied requests are aborted.
 * This is the ONLY route handler the runner installs — no later handler may
 * continue an unchecked request.
 */
export async function guardedRouteHandler(
  route: GuardedRoute,
  networkGuard: (url: string) => Promise<boolean>,
): Promise<void> {
  const allowed = await networkGuard(route.request().url());
  if (allowed) await route.continue();
  else await route.abort('blockedbyclient');
}

/**
 * Minimal structural shape of a Playwright page, sufficient for installing
 * the guarded route. Kept structural (not a Playwright type import) so the
 * hook is unit-testable without a browser.
 */
export interface GuardedPage {
  route(pattern: string, handler: (route: GuardedRoute) => void | Promise<void>): Promise<void>;
}

/**
 * Build the preNavigationHooks for a set of rendered-page inputs. The hook
 * installs, for each page, the SAME single authoritative catch-all route the
 * singular path installs (all URLs), driven by THAT input's networkGuard:
 * every request the page issues (navigation, redirect hops, sub-resources) is
 * decided by `guardedRouteHandler` and never bypassed by a later
 * route.continue().
 *
 * Inputs without a networkGuard get no route — identical semantics to
 * `runRenderedPage()`. Used by both the single and batch runners so the guard
 * installation cannot diverge between them.
 */
export function buildGuardPreNavigationHooks(
  inputs: RenderedPageInput[],
): ((ctx: { page: GuardedPage; request: { url: string } }) => Promise<void>)[] {
  const guardByUrl = new Map<string, (url: string) => Promise<boolean>>();
  for (const input of inputs) {
    if (input.networkGuard) guardByUrl.set(input.url, input.networkGuard);
  }
  if (guardByUrl.size === 0) return [];
  return [
    async ({ page, request }) => {
      const guard = guardByUrl.get(request.url);
      if (!guard) return;
      // One authoritative guard for the whole page lifecycle: the '**/*' route
      // intercepts navigation, every redirect hop, and every sub-resource, and
      // each request is decided by `guardedRouteHandler` (never bypassed by a
      // later route.continue()).
      await page.route('**/*', (route) => guardedRouteHandler(route, guard));
    },
  ];
}

// ─── Single page runner ────────────────────────────────────────────────────

/**
 * Open a single rendered page using Crawlee's PlaywrightCrawler and run the
 * provided extractor callback. Returns the extracted data or a failure.
 *
 * This creates a short-lived crawler for one URL. For multiple URLs, use
 * `runRenderedPages()` to reuse the browser pool.
 */
export async function runRenderedPage<T>(
  input: RenderedPageInput,
  extractor: PageExtractor<T>,
  config?: WorkerBrowserConfig,
): Promise<RenderedPageResult<T>> {
  const cfg = config ?? loadWorkerBrowserConfig();
  const launchCtx = await createLaunchContext(cfg);
  const proxyConfig = createWorkerProxyConfiguration(cfg);
  let baseStorageDir = getCrawleeStorageDir();
  if (input.storageDir) {
    const requestedStorageDir = path.resolve(input.storageDir);
    const tmpPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!requestedStorageDir.startsWith(tmpPrefix)) throw new Error('isolated Crawlee storage must be beneath the bounded tmp directory');
    baseStorageDir = requestedStorageDir;
  }
  const runId = randomUUID();
  const uniqueStorageDir = path.join(baseStorageDir, 'runs', runId);

  // Ensure unique directory exists
  fs.mkdirSync(uniqueStorageDir, { recursive: true });

  const crawleeConfig = new Configuration({
    storageClientOptions: {
      localDataDirectory: uniqueStorageDir,
    },
  });

  let result: T | undefined;
  let failure: string | undefined;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    preNavigationHooks: input.networkGuard ? buildGuardPreNavigationHooks([input]) : undefined,
    maxConcurrency: 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: cfg.maxRequestRetries,
    requestHandlerTimeoutSecs: Math.ceil((input.navigationTimeoutMs ?? cfg.navigationTimeoutMs) / 1000),
    navigationTimeoutSecs: Math.ceil((input.navigationTimeoutMs ?? cfg.navigationTimeoutMs) / 1000),
    launchContext: {
      launcher: launchCtx.launcher as any,
      launchOptions: launchCtx.launchOptions as any,
    },
    browserPoolOptions: {
      maxOpenPagesPerBrowser: cfg.maxOpenPagesPerBrowser,
      retireBrowserAfterPageCount: cfg.retireBrowserAfterPageCount,
    },
    async requestHandler(ctx) {
      result = await extractor(ctx, input.dwellMs ?? cfg.dwellMs);
    },
    failedRequestHandler({ request }) {
      failure = request.errorMessages?.[0] ?? 'Request failed';
    },
  }, crawleeConfig);

  try {
    await crawler.run([input.url]);
  } finally {
    // Clean up storage directory to avoid disk bloat
    try {
      fs.rmSync(uniqueStorageDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[browser] Failed to clean up Crawlee storage directory ${uniqueStorageDir}:`, e);
    }
  }

  if (failure) {
    return { ok: false, url: input.url, error: failure };
  }

  return { ok: true, url: input.url, data: result! };
}

// ─── Multi-page batch runner ───────────────────────────────────────────────

/**
 * Process multiple rendered pages in a single Crawlee run, reusing the same
 * browser pool across all inputs. This is much more efficient than calling
 * `runRenderedPage()` per URL.
 *
 * Results are returned in input order. Each URL is processed independently;
 * one failure does not cancel the others.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function runRenderedPages<T>(
  inputs: RenderedPageInput[],
  extractor: PageExtractor<T>,
  config?: WorkerBrowserConfig,
): Promise<RenderedPageResult<T>[]> {
  if (inputs.length === 0) return [];

  const cfg = config ?? loadWorkerBrowserConfig();
  const launchCtx = await createLaunchContext(cfg);
  const proxyConfig = createWorkerProxyConfiguration(cfg);

  const baseStorageDir = getCrawleeStorageDir();
  const runId = randomUUID();
  const uniqueStorageDir = path.join(baseStorageDir, 'batches', runId);

  // Ensure unique directory exists
  fs.mkdirSync(uniqueStorageDir, { recursive: true });

  const crawleeConfig = new Configuration({
    storageClientOptions: {
      localDataDirectory: uniqueStorageDir,
    },
  });

  // We need ordered results — use a Map keyed by URL
  // (assumes unique URLs; deduplication is caller's responsibility)
  const resultsMap = new Map<string, RenderedPageResult<T>>();

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    // Per-input network guards: every request each page issues (navigation,
    // redirect hops, sub-resources) is decided by THAT input's networkGuard via
    // the single authoritative '**/*' route — same installation as the
    // singular path, so no batch request can bypass the guard.
    preNavigationHooks: buildGuardPreNavigationHooks(inputs),
    maxConcurrency: Math.min(cfg.maxConcurrency, inputs.length),
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: cfg.maxRequestRetries,
    requestHandlerTimeoutSecs: Math.ceil(cfg.navigationTimeoutMs / 1000),
    navigationTimeoutSecs: Math.ceil(cfg.navigationTimeoutMs / 1000),
    launchContext: {
      launcher: launchCtx.launcher as any,
      launchOptions: launchCtx.launchOptions as any,
    },
    browserPoolOptions: {
      maxOpenPagesPerBrowser: cfg.maxOpenPagesPerBrowser,
      retireBrowserAfterPageCount: cfg.retireBrowserAfterPageCount,
    },
    async requestHandler(ctx) {
      const data = await extractor(ctx, cfg.dwellMs);
      resultsMap.set(ctx.request.url, { ok: true, url: ctx.request.url, data });
    },
    failedRequestHandler({ request }) {
      const error = request.errorMessages?.[0] ?? 'Request failed';
      resultsMap.set(request.url, { ok: false, url: request.url, error });
    },
  }, crawleeConfig);

  const urls = inputs.map((i) => i.url);
  try {
    await crawler.run(urls);
  } finally {
    // Clean up storage directory to avoid disk bloat
    try {
      fs.rmSync(uniqueStorageDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[browser] Failed to clean up Crawlee storage directory ${uniqueStorageDir}:`, e);
    }
  }

  // Return results in input order
  return inputs.map((i) => {
    return resultsMap.get(i.url) ?? { ok: false, url: i.url, error: 'No result produced' };
  });
}
