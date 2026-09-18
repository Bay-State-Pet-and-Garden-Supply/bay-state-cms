// Tier 1 render worker — IN-CONTAINER ONLY, never imported by host code (#237).
//
// Runs inside the pinned render image (`baystate/investigation-render:1`,
// `docker/investigation-render/Dockerfile`) under `bun
// /app/src/onboarding/browser-investigation/render-worker.ts`. Reads one
// render task as JSON on stdin, loads each page with the existing
// rendered-page stack (`runRenderedPage`: Crawlee + Playwright Chromium),
// and writes exactly one envelope as JSON on stdout. Nothing else is ever
// written to stdout, so the host can parse it unambiguously.
//
// Egress: the container lives on the isolated render network and its env
// carries ONLY the validating-forward-proxy declaration (see
// `buildRenderContainerSpec`). Browser traffic flows through the proxy via
// `BAYSTATE_CMS_WORKER_PROXY_URLS`; every request is ALSO checked by the
// in-container scope guard (exact approved hosts + broker path policy
// mirror) before navigation. The proxy validates authoritatively per
// request — the guard is defense-in-depth, never the boundary.
//
// Observations are typed and byte-capped (never raw bodies): title, meta,
// JSON-LD presence, image counts. The artifact hash is the SHA-256 of the
// rendered snapshot bytes seen here; the HOST anchors each observation to
// its own retained artifact (see harness `mergeRenderedObservations`).
//
// Fail-closed: malformed tasks, guard violations, budget overruns, and
// worker failures produce `{ok:false}` envelopes with stable codes.
//
// Containment-audit note: this file (and the browser stack it reuses) is
// the AUTHORIZED in-container network surface. Host modules must never
// import it — the host reaches it only as a container command via
// `renderContainerDockerArgs` (asserted statically).

import { runRenderedPage } from '../../extraction-worker/browser/rendered-page-runner';
import { loadWorkerBrowserConfig } from '../../extraction-worker/browser/config';
import { sha256 } from '../../shared/hash';

export const RENDER_WORKER_PROTOCOL_VERSION = 1;

const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_BYTES = 500;
const MAX_PAGES_PER_TASK = 5;
const MAX_JSONLD_PER_PAGE = 10;
const MAX_IMAGES_PER_PAGE = 100;

interface RenderTaskPage {
  pageIndex: number;
  url: string;
  artifactRef: string;
}

interface RenderTask {
  investigationId: string;
  approvedHosts: string[];
  pages: RenderTaskPage[];
  maxReads: number;
  maxObservationBytesPerOperation: number;
}

interface RenderedSnapshot {
  title: string;
  metaDescription: string;
  jsonLdCount: number;
  jsonLdPresent: boolean;
  imageCount: number;
  imageSamples: string[];
  snapshotBytes: string;
}

function sliceDetail(text: unknown): string {
  return String(text ?? '').slice(0, MAX_DETAIL_BYTES);
}

function writeEnvelope(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function fail(code: string, detail: unknown): never {
  writeEnvelope({ ok: false, version: RENDER_WORKER_PROTOCOL_VERSION, code, detail: sliceDetail(detail) });
  process.exit(1);
  throw new Error('unreachable');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    process.stdin.on('data', (chunk: Buffer) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_STDIN_BYTES) {
        done = true;
        reject(new Error('render task exceeds the stdin ceiling'));
        return;
      }
      chunks.push(buf);
    });
    process.stdin.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** Static scope mirror of the broker policy: exact approved hosts, no credentials, safe paths. */
const BLOCKED_PATH_RE =
  /\/(cart|basket|checkout|check-out|account|login|signin|sign-in|signup|sign-up|register|admin|wp-admin|wp-login|cgi-bin|dbupload|db_xml|dbmake|generate\.cgi)/i;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function isMediatedScheme(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function hasNoCredentials(url: URL): boolean {
  return !url.username && !url.password;
}

function isApprovedHost(url: URL, approved: Set<string>): boolean {
  return approved.has(normalizeHostname(url.hostname));
}

function isAllowedPath(pathname: string): boolean {
  return !BLOCKED_PATH_RE.test(pathname);
}

function guardFor(approvedHosts: string[]): (url: string) => Promise<boolean> {
  const approved = new Set(approvedHosts.map(normalizeHostname));
  return async (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return (
      isMediatedScheme(parsed.protocol) &&
      hasNoCredentials(parsed) &&
      isApprovedHost(parsed, approved) &&
      isAllowedPath(parsed.pathname)
    );
  };
}

const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const isNumber = (value: unknown): boolean => typeof value === 'number';
const nonEmptyArray = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
const boundedPages = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_PAGES_PER_TASK;

/** Task-level field shapes (investigation id, hosts, pages, budgets). */
const RENDER_TASK_FIELDS: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
  ['investigationId', nonEmptyString],
  ['approvedHosts', nonEmptyArray],
  ['pages', boundedPages],
  ['maxReads', isNumber],
  ['maxObservationBytesPerOperation', isNumber],
];

/** One render page descriptor: non-empty url + artifact ref and a numeric index. */
function validPage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const page = raw as Record<string, unknown>;
  return (
    nonEmptyString(page.url) && nonEmptyString(page.artifactRef) && typeof page.pageIndex === 'number'
  );
}

function validTask(raw: unknown): raw is RenderTask {
  if (!raw || typeof raw !== 'object') return false;
  const task = raw as Record<string, unknown>;
  if (RENDER_TASK_FIELDS.some(([key, check]) => !check(task[key]))) return false;
  return (task.pages as unknown[]).every(validPage);
}

async function extractSnapshot(url: string, guard: (url: string) => Promise<boolean>, budgetMs: number) {
  const base = loadWorkerBrowserConfig();
  const proxyUrls = (process.env.BAYSTATE_CMS_WORKER_PROXY_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const result = await runRenderedPage(
    { url, networkGuard: guard, navigationTimeoutMs: Math.min(25_000, budgetMs) },
    async (ctx, dwellMs) => {
      const page = ctx.page;
      await page.waitForTimeout(Math.min(dwellMs, 2_000));
      const title = await page.title().catch(() => '');
      const metaDescription = await page
        .$eval('meta[name="description"], meta[property="og:description"]', (el) => el.getAttribute('content') ?? '')
        .catch(() => '');
      const jsonLdCount = await page
        .$$eval('script[type="application/ld+json"]', (els) => els.length)
        .catch(() => 0);
      const images = await page
        .$$eval('img[src]', (els) => els.map((el) => el.getAttribute('src') ?? '').filter(Boolean))
        .catch(() => [] as string[]);
      return { title, metaDescription, jsonLdCount, images } as {
        title: string;
        metaDescription: string;
        jsonLdCount: number;
        images: string[];
      };
    },
    {
      ...base,
      backend: 'playwright',
      maxConcurrency: 1,
      maxRequestRetries: 1,
      proxyUrls: proxyUrls.length > 0 ? proxyUrls : base.proxyUrls,
    },
  );
  return result;
}

interface RenderedPageOutcome {
  observation: unknown | null;
  gap: string | null;
  reads: number;
}

/** Render one approved page into a typed observation (or a visible gap). Never throws. */
async function renderOnePage(
  page: RenderTaskPage,
  guard: (url: string) => Promise<boolean>,
  perOpCap: number,
): Promise<RenderedPageOutcome> {
  if (!(await guard(page.url))) {
    return { observation: null, gap: `render refused for ${page.url.slice(0, 120)}: outside the investigation scope`, reads: 1 };
  }
  try {
    const result = await extractSnapshot(page.url, guard, 25_000);
    if (!result.ok) {
      return { observation: null, gap: `render failed for ${page.url.slice(0, 120)}: ${sliceDetail(result.error)}`, reads: 1 };
    }
    return { observation: observationOf(page, result.data, perOpCap), gap: null, reads: 2 };
  } catch (err) {
    return {
      observation: null,
      gap: `render failed for ${page.url.slice(0, 120)}: ${sliceDetail(err instanceof Error ? err.message : err)}`,
      reads: 1,
    };
  }
}

/** Typed, byte-capped observation from a rendered snapshot (never raw bodies). */
function observationOf(
  page: RenderTaskPage,
  data: { title: string; metaDescription: string; jsonLdCount: number; images: string[] },
  perOpCap: number,
): unknown {
  const snapshot: RenderedSnapshot = {
    title: String(data.title ?? '').slice(0, 500),
    metaDescription: String(data.metaDescription ?? '').slice(0, 1000),
    jsonLdCount: Math.min(data.jsonLdCount, MAX_JSONLD_PER_PAGE),
    jsonLdPresent: data.jsonLdCount > 0,
    imageCount: Math.min(data.images.length, MAX_IMAGES_PER_PAGE),
    imageSamples: data.images.slice(0, 5).map((s) => String(s).slice(0, 200)),
    snapshotBytes: '',
  };
  const snapshotBytes = Buffer.from(
    JSON.stringify({ title: snapshot.title, meta: snapshot.metaDescription, jsonLd: snapshot.jsonLdCount, images: snapshot.imageCount }),
    'utf8',
  );
  const detail = [
    `rendered title: ${snapshot.title || '(none)'}`,
    `meta: ${snapshot.metaDescription ? 'present' : 'absent'}`,
    `json-ld blocks: ${snapshot.jsonLdCount}`,
    `images: ${snapshot.imageCount}`,
  ].join('; ').slice(0, Math.min(4000, perOpCap));
  return {
    kind: 'page_rendered',
    sourceUrl: page.url,
    artifactHash: sha256(snapshotBytes),
    ...(detail ? { detail } : {}),
    incomplete: false,
    artifactRef: page.artifactRef,
    pageIndex: page.pageIndex,
  };
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    fail('invalid_input', err instanceof Error ? err.message : err);
  }
  let task: unknown;
  try {
    task = JSON.parse(raw!);
  } catch {
    fail('invalid_input', 'render task is not valid JSON');
  }
  if (!validTask(task)) fail('invalid_input', 'render task malformed');
  const renderTask = task as RenderTask;
  const guard = guardFor(renderTask.approvedHosts);
  const perOpCap = Math.max(1024, renderTask.maxObservationBytesPerOperation);
  let readsUsed = 0;
  const observations: unknown[] = [];
  const gaps: string[] = [];
  for (const page of renderTask.pages) {
    readsUsed += 1;
    if (readsUsed > renderTask.maxReads) {
      writeEnvelope({
        ok: false,
        version: RENDER_WORKER_PROTOCOL_VERSION,
        code: 'budget_exhausted',
        detail: 'render reads would exceed budget',
      });
      process.exit(1);
    }
    const outcome = await renderOnePage(page, guard, perOpCap);
    readsUsed += outcome.reads - 1;
    if (outcome.observation) observations.push(outcome.observation);
    if (outcome.gap) gaps.push(outcome.gap);
  }
  writeEnvelope({
    ok: true,
    version: RENDER_WORKER_PROTOCOL_VERSION,
    result: { observations, gaps: gaps.slice(0, 50), readsPerformed: readsUsed },
  });
}

main().catch((err) => {
  try {
    writeEnvelope({
      ok: false,
      version: RENDER_WORKER_PROTOCOL_VERSION,
      code: 'provider_error',
      detail: sliceDetail(err instanceof Error ? err.message : err),
    });
  } catch {
    process.exitCode = 1;
  }
});
