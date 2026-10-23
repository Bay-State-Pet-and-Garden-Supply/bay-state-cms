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
const MAX_PAGE_ITEMS = 100;

interface RenderTaskPage {
  pageIndex: number;
  url: string;
  artifactRef: string;
  expectedPageId?: string;
  actions?: Array<{ id: string; kind: 'observe' | 'links' | 'variants' | 'accordion'; targetId?: string }>;
}

interface RenderTask {
  investigationId: string;
  approvedHosts: string[];
  pages: RenderTaskPage[];
  maxReads: number;
  maxObservationBytesPerOperation: number;
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
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const boundedObservationBytes = (value: unknown): boolean =>
  positiveInteger(value) && value <= MAX_STDIN_BYTES;
const nonEmptyArray = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
const boundedPages = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_PAGES_PER_TASK;

/** Task-level field shapes (investigation id, hosts, pages, budgets). */
const RENDER_TASK_FIELDS: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
  ['investigationId', nonEmptyString],
  ['approvedHosts', nonEmptyArray],
  ['pages', boundedPages],
  ['maxReads', positiveInteger],
  ['maxObservationBytesPerOperation', boundedObservationBytes],
];

/** One render page descriptor: approved URL, artifact ref, index and bounded code-owned action IDs. */
function validPage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const page = raw as Record<string, unknown>;
  if (!(nonEmptyString(page.url) && nonEmptyString(page.artifactRef) &&
    typeof page.pageIndex === 'number' && Number.isSafeInteger(page.pageIndex) && page.pageIndex >= 0)) return false;
  if (page.expectedPageId !== undefined && (typeof page.expectedPageId !== 'string' || !/^[a-f0-9]{64}$/.test(page.expectedPageId))) return false;
  if (page.actions === undefined) return page.expectedPageId === undefined;
  if (!Array.isArray(page.actions) || page.actions.length < 1 || page.actions.length > 4) return false;
  const ids = new Set<string>();
  return page.actions.every((rawAction) => {
    if (!rawAction || typeof rawAction !== 'object') return false;
    const action = rawAction as Record<string, unknown>;
    if (typeof action.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(action.id) || ids.has(action.id)) return false;
    if (!['observe', 'links', 'variants', 'accordion'].includes(String(action.kind))) return false;
    if (action.targetId !== undefined) {
      const validTarget = action.kind === 'accordion'
        ? typeof action.targetId === 'string' && /^accordion-[0-9]{1,3}$/.test(action.targetId)
        : action.kind === 'variants' && typeof action.targetId === 'string' && /^variant-[0-9]{1,3}-option-[0-9]{1,3}$/.test(action.targetId);
      if (!validTarget || !page.expectedPageId) return false;
    }
    ids.add(action.id);
    return true;
  });
}

function validTask(raw: unknown): raw is RenderTask {
  if (!raw || typeof raw !== 'object') return false;
  const task = raw as Record<string, unknown>;
  if (RENDER_TASK_FIELDS.some(([key, check]) => !check(task[key]))) return false;
  return (task.pages as unknown[]).every(validPage);
}

/** Accept the per-run validating-proxy credential (in-container only — see extractSnapshot). Idempotent. */
function enableInterceptTrust(): void {
  const key = 'BAYSTATE_CMS_WORKER_EXTRA_LAUNCH_ARGS';
  const flags = (process.env[key] ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!flags.includes('--ignore-certificate-errors')) flags.push('--ignore-certificate-errors');
  process.env[key] = flags.join(' ');
}

async function extractSnapshot(
  url: string,
  guard: (url: string) => Promise<boolean>,
  budgetMs: number,
  actions: NonNullable<RenderTaskPage['actions']> = [],
  expectedPageId?: string,
) {
  // Validating-intercept trust: this container's sole egress is the per-run
  // proxy, which terminates the browser's TLS with its own credential and
  // validates every inner request through the broker (upstream TLS to the
  // origin is genuinely validated there). The browser therefore accepts the
  // proxy credential via the scoped launch flag — set here, in-container
  // only (host code never imports this module), so normal extraction
  // (flag absent) keeps default certificate validation.
  enableInterceptTrust();
  const base = loadWorkerBrowserConfig();
  const proxyUrls = (process.env.BAYSTATE_CMS_WORKER_PROXY_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const result = await runRenderedPage(
    {
      url,
      storageDir: '/tmp/baystate-render-storage',
      networkGuard: guard,
      navigationTimeoutMs: Math.min(25_000, budgetMs),
    },
    async (ctx, dwellMs) => {
      const page = ctx.page;
      await page.waitForTimeout(Math.min(dwellMs, 2_000));
      const readPageState = () => page.evaluate(() => {
        if (!document.body) throw new Error('document body unavailable');
        const selects = Array.from(document.querySelectorAll('select'));
        const details = Array.from(document.querySelectorAll('details'));
        return {
          url: location.href,
          title: document.title,
          text: document.body.innerText,
          variants: {
            count: selects.length,
            items: selects.slice(0, 101).map((select) => ({
              name: select.name || select.getAttribute('aria-label') || '',
              optionCount: select.options.length,
              options: Array.from(select.options).slice(0, 101).map((option) => ({
                value: option.value,
                label: option.textContent?.trim() ?? '',
                selected: option.selected,
                disabled: option.disabled,
              })),
            })),
          },
          accordions: {
            count: details.length,
            items: details.slice(0, 101).map((detail) => ({
              summary: detail.querySelector('summary')?.textContent?.trim() ?? '',
              text: detail.textContent ?? '',
              expanded: detail.open,
            })),
          },
        };
      });
      const initialState = await readPageState();
      const pageId = sha256(Buffer.from(JSON.stringify(initialState), 'utf8'));
      if (expectedPageId && expectedPageId !== pageId) throw new Error('unsupported_action: stale page ID');
      const targetIds = [
        ...initialState.accordions.items.slice(0, MAX_PAGE_ITEMS).map((_, index) => `accordion-${index}`),
        ...initialState.variants.items.slice(0, MAX_PAGE_ITEMS).flatMap((variant, selectIndex) =>
          variant.options.slice(0, MAX_PAGE_ITEMS).map((_, optionIndex) => `variant-${selectIndex}-option-${optionIndex}`)),
      ];
      const targetIdsComplete = targetIds.length <= MAX_PAGE_ITEMS &&
        initialState.accordions.count <= MAX_PAGE_ITEMS &&
        initialState.variants.count <= MAX_PAGE_ITEMS &&
        initialState.variants.items.every((variant) => variant.optionCount <= MAX_PAGE_ITEMS);
      for (const action of actions) {
        if (!action.targetId) continue;
        if (sha256(Buffer.from(JSON.stringify(await readPageState()), 'utf8')) !== pageId) {
          throw new Error('unsupported_action: page changed before action');
        }
        if (action.kind === 'accordion') {
          const match = /^accordion-([0-9]{1,3})$/.exec(action.targetId);
          const index = Number(match?.[1]);
          const expected = initialState.accordions.items[index];
          const target = page.locator('details').nth(index);
          if (!match || !expected || await target.count() === 0) throw new Error('unsupported_action: stale accordion ID');
          const opened = await target.evaluate((element, expectedTarget) => {
            const detail = element as HTMLDetailsElement;
            const current = {
              summary: detail.querySelector('summary')?.textContent?.trim() ?? '',
              text: detail.textContent ?? '',
              expanded: detail.open,
            };
            if (JSON.stringify(current) !== JSON.stringify(expectedTarget)) return false;
            detail.open = true;
            return true;
          }, expected);
          if (!opened) throw new Error('unsupported_action: accordion content changed before action');
        } else if (action.kind === 'variants') {
          const match = /^variant-([0-9]{1,3})-option-([0-9]{1,3})$/.exec(action.targetId);
          const selectIndex = Number(match?.[1]);
          const optionIndex = Number(match?.[2]);
          const expected = initialState.variants.items[selectIndex];
          const target = page.locator('select').nth(selectIndex);
          if (!match || !expected || await target.count() === 0) throw new Error('unsupported_action: stale variant ID');
          const selected = await target.evaluate((element, args) => {
            const select = element as HTMLSelectElement;
            const current = {
              name: select.name || select.getAttribute('aria-label') || '',
              optionCount: select.options.length,
              options: Array.from(select.options).slice(0, 101).map((option) => ({
                value: option.value,
                label: option.textContent?.trim() ?? '',
                selected: option.selected,
                disabled: option.disabled,
              })),
            };
            const option = select.options[args.optionIndex];
            if (JSON.stringify(current) !== JSON.stringify(args.expected) ||
              select.closest('form') || !option || option.disabled) return false;
            select.selectedIndex = args.optionIndex;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, { expected, optionIndex });
          if (!selected) throw new Error('unsupported_action: variant control changed, is in a form, or option is disabled');
        }
      }
      if (actions.some((action) => action.kind === 'accordion' && !action.targetId)) {
        if (await page.locator('details').count() > MAX_PAGE_ITEMS) {
          throw new Error('unsupported_action: native accordion count exceeds the bounded read limit');
        }
        await page.$$eval('details', (details) => details.forEach((details) => { details.open = true; }));
      }
      const state = await page.evaluate(() => {
        return {
          title: document.title,
          metaDescription: document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute('content') ?? '',
          jsonLdCount: document.querySelectorAll('script[type="application/ld+json"]').length,
          images: Array.from(document.querySelectorAll('img[src]')).map((image) => image.getAttribute('src') ?? '').filter(Boolean),
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 101).map((element, index) => ({
            id: `link-${index}`,
            text: (element.textContent ?? '').trim(),
            href: (element as HTMLAnchorElement).href,
          })),
        };
      });
      const finalState = await readPageState();
      const variants = finalState.variants.items.slice(0, 101).map((variant, index) => ({
        id: `variant-${index}`,
        name: variant.name,
        complete: variant.optionCount <= 100,
        options: variant.options.slice(0, 100).map((option, optionIndex) => ({
          id: `variant-${index}-option-${optionIndex}`,
          label: option.label,
          value: option.value,
          selected: option.selected,
        })),
      }));
      const accordions = finalState.accordions.items.slice(0, 101).map((accordion, index) => ({
        id: `accordion-${index}`,
        summary: accordion.summary,
        text: accordion.text,
        expanded: accordion.expanded,
      }));
      return {
        ...state,
        text: finalState.text,
        finalUrl: finalState.url,
        variants,
        accordions,
        pageId,
        targetIds,
        targetIdsComplete,
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
  observation: unknown[] | null;
  gap: string | null;
  reads: number;
}

/** Render one approved page into its requested typed observations (or a visible gap). Never throws. */
async function renderOnePage(
  page: RenderTaskPage,
  guard: (url: string) => Promise<boolean>,
  perOpCap: number,
): Promise<RenderedPageOutcome> {
  if (!(await guard(page.url))) {
    return { observation: null, gap: `render refused for ${page.url.slice(0, 120)}: outside the investigation scope`, reads: 1 };
  }
  try {
    const result = await extractSnapshot(page.url, guard, 25_000, page.actions ?? [], page.expectedPageId);
    if (!result.ok) {
      return { observation: null, gap: `render failed for ${page.url.slice(0, 120)}: ${sliceDetail(result.error)}`, reads: 1 };
    }
    return { observation: observationOf(page, result.data, perOpCap), gap: null, reads: 2 };
  } catch (err) {
    return { observation: null, gap: `render failed for ${page.url.slice(0, 120)}: ${sliceDetail(err instanceof Error ? err.message : err)}`, reads: 1 };
  }
}

/** Return content only for the code-owned read action IDs supplied with the task. */
function observationOf(page: RenderTaskPage, data: {
  title: string; metaDescription: string; jsonLdCount: number; images: string[]; text: string;
  links: Array<{ id: string; text: string; href: string }>;
  variants: Array<{ id: string; name: string; complete: boolean; options: Array<{ id: string; label: string; value: string; selected: boolean }> }>;
  accordions: Array<{ id: string; summary: string; text: string; expanded: boolean }>;
  finalUrl: string;
  pageId: string;
  targetIds: string[];
  targetIdsComplete: boolean;
}, perOpCap: number): unknown[] {
  if (!page.actions?.length) {
    const title = String(data.title ?? '').slice(0, 500);
    const meta = String(data.metaDescription ?? '').slice(0, 1000);
    const jsonLd = Math.min(data.jsonLdCount, MAX_JSONLD_PER_PAGE);
    const images = Math.min(data.images.length, MAX_IMAGES_PER_PAGE);
    const detail = [
      `rendered title: ${title || '(none)'}`,
      `meta: ${meta ? 'present' : 'absent'}`,
      `json-ld blocks: ${jsonLd}`,
      `images: ${images}`,
    ].join('; ').slice(0, Math.min(4000, perOpCap));
    const legacyBytes = Buffer.from(JSON.stringify({ title, meta, jsonLd, images }), 'utf8');
    return [{
      kind: 'page_rendered',
      sourceUrl: page.url,
      artifactHash: sha256(legacyBytes),
      ...(detail ? { detail } : {}),
      incomplete: false,
      artifactRef: page.artifactRef,
      pageIndex: page.pageIndex,
    }];
  }
  const actions = page.actions;
  const output: unknown[] = [];
  const targetIds = data.targetIds;
  const targetIdsComplete = data.targetIdsComplete;
  for (const action of actions) {
    if (action.kind === 'variants' && data.variants.length === 0) throw new Error('unsupported_action: variant controls not found');
    if (action.kind === 'accordion' && data.accordions.length === 0) throw new Error('unsupported_action: native accordion controls not found');
    const matchCount = action.kind === 'links' ? data.links.length
      : action.kind === 'variants' ? data.variants.length
      : action.kind === 'accordion' ? data.accordions.length
      : 0;
    const value = action.kind === 'observe' ? data.text
      : action.kind === 'links' ? data.links.slice(0, MAX_PAGE_ITEMS)
      : action.kind === 'variants' ? data.variants.slice(0, MAX_PAGE_ITEMS)
      : data.accordions.slice(0, MAX_PAGE_ITEMS);
    const contentType = action.kind === 'observe' ? 'text/plain' : 'application/json';
    const content = action.kind === 'observe' ? String(value ?? '') : JSON.stringify(value);
    const contentBytes = Buffer.from(content, 'utf8').subarray(0, perOpCap);
    const completeContent = contentBytes.toString('utf8');
    const complete = Buffer.byteLength(content, 'utf8') <= Buffer.byteLength(completeContent, 'utf8') &&
      (action.kind === 'observe' || matchCount <= MAX_PAGE_ITEMS) &&
      (action.kind !== 'variants' || data.variants.every((variant) => variant.complete)) && targetIdsComplete;
    const snapshotBytes = Buffer.from(completeContent, 'utf8');
    output.push({
      kind: `item_${action.kind}`,
      actionId: action.id,
      actionKind: action.kind,
      sourceUrl: page.url,
      finalUrl: data.finalUrl,
      artifactHash: sha256(snapshotBytes),
      contentType,
      content: completeContent,
      ...(action.kind === 'links' ? { links: value } : {}),
      pageId: data.pageId,
      targetIds: targetIds.slice(0, MAX_PAGE_ITEMS),
      incomplete: !complete,
      artifactRef: page.artifactRef,
      pageIndex: page.pageIndex,
    });
  }
  return output;
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
  const perOpCap = renderTask.maxObservationBytesPerOperation;
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
    if (outcome.observation) observations.push(...outcome.observation);
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
