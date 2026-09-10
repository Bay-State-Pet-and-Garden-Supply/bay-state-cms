// story: e07s03, e07s04 — single capture with element-map + viewport + 16-hex hash + SSRF guard
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyIp, isPrivateOrLinkLocal } from '../shared/ssrf';

export interface CaptureElement {
  id: string;
  tag: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dataAttrs: string[];
}

export interface CaptureResult {
  dom: string;
  screenshotBase64: string;
  screenshotRef?: string;
  runtime: string;
  hash: string;
  capturedAt: string;
  elements: CaptureElement[];
  viewport: { w: number; h: number; deviceScaleFactor: number } | null;
}

function hashCapture(input: { dom: string; screenshotBase64: string; runtime: string; url: string; elementsCount: number }): string {
  return createHash('sha256')
    .update(input.dom + input.screenshotBase64 + input.runtime + input.url + String(input.elementsCount))
    .digest('hex')
    .slice(0, 16);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.search) u.search = '[redacted]';
    if (u.username || u.password) { u.username = '[redacted]'; u.password = ''; }
    return u.toString();
  } catch { return '[redacted-url]'; }
}

function isAllowedProtocol(url: string): boolean {
  try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

async function isPrivateHost(url: string): Promise<boolean> {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('example.com') || host.endsWith('example.org') || host.endsWith('example.net')) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    const kind = classifyIp(host);
    if (kind === 'private' || kind === 'link_local') return true;
    const { lookup } = await import('node:dns/promises');
    const addrs = await lookup(host, { all: true });
    return addrs.some(a => isPrivateOrLinkLocal(a.address));
  } catch { return false; }
}

async function assertAllowedUrl(url: string): Promise<void> {
  if (!isAllowedProtocol(url)) throw new Error(`blocked protocol for capture: ${redactUrl(url)}`);
  if (await isPrivateHost(url)) throw new Error(`blocked private destination: ${redactUrl(url)}`);
}

function persistCapture(result: CaptureResult & { url: string }): CaptureResult {
  const dir = path.join(os.tmpdir(), 'baystate-captures');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* non-fatal */ }
  const ref = path.join(dir, `${result.hash}.json`);
  try {
    fs.writeFileSync(
      ref,
      JSON.stringify({
        dom: result.dom.slice(0, 5_000_000),
        screenshotBase64: result.screenshotBase64.slice(0, 5_000_000),
        runtime: result.runtime,
        hash: result.hash,
        capturedAt: result.capturedAt,
        url: result.url,
        elements: result.elements.slice(0, 2000),
        viewport: result.viewport,
      }),
      'utf-8',
    );
  } catch (_e) { /* non-fatal */ }
  return { ...result, screenshotRef: ref };
}

export function hitTest(elements: CaptureElement[], x: number, y: number): string | null {
  const hit = elements
    .filter(e => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  return hit ? hit.id : null;
}

export async function captureProfilePage(input: { url: string; runtime: 'static' | 'rendered' }): Promise<CaptureResult> {
  const runtime = input.runtime;
  if (runtime === 'static') return captureStatic(input.url);
  return captureRendered(input.url);
}

async function captureStatic(url: string): Promise<CaptureResult> {
  await assertAllowedUrl(url);
  const ac = new AbortController();
  const overall = setTimeout(() => ac.abort(), 15000);
  const sizeCap = 5 * 1024 * 1024;
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'BaystateCMS-capture/1.0' }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) { const next = new URL(loc, url).toString(); await assertAllowedUrl(next); }
      throw new Error(`redirect blocked for capture: ${redactUrl(url)}`);
    }
    if (!res.ok) throw new Error(`fetch failed ${res.status} for ${redactUrl(url)}`);
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !ct.includes('text/html') && !ct.includes('application/xhtml')) throw new Error(`blocked content-type ${ct} for ${redactUrl(url)}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > sizeCap) throw new Error(`capture too large ${buf.length} for ${redactUrl(url)}`);
    const dom = new TextDecoder().decode(buf);
    const capturedAt = new Date().toISOString();
    const elements: CaptureElement[] = [];
    const base: CaptureResult & { url: string } = {
      dom, screenshotBase64: '', runtime: 'static', hash: hashCapture({ dom, screenshotBase64: '', runtime: 'static', url, elementsCount: 0 }), capturedAt, url, elements, viewport: null,
    };
    return persistCapture(base);
  } finally { clearTimeout(overall); }
}

async function captureRendered(url: string): Promise<CaptureResult> {
  await assertAllowedUrl(url);
  let browser: any = null;
  const deadline = setTimeout(() => { try { if (browser) browser.close(); } catch (_e) { /* non-fatal */ } }, 25000);
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.on('request', async (req: any) => {
      try {
        const u = req.url();
        if (u !== url) await assertAllowedUrl(u);
        const resourceType = req.resourceType();
        // Abort non-essential tracking scripts and streaming media to accelerate capture
        if (
          resourceType === 'media' ||
          /google-analytics|googletagmanager|facebook\.net|clarity\.ms|hotjar|privy|klaviyo|doubleclick|tiktok\.com|sentry\.io/i.test(u)
        ) {
          await req.abort().catch(() => {});
          return;
        }
      } catch (_e) {
        // Non-fatal
      }
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
    } catch {
      await page.goto(url, { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
    }
    await page.waitForTimeout(300);

    // Suppress newsletter popups, promo modals, and cookie banners before screenshot
    await page.evaluate(() => {
      const popupSelectors = [
        '[class*="modal" i]', '[class*="popup" i]', '[class*="newsletter" i]',
        '[id*="modal" i]', '[id*="popup" i]', '[id*="newsletter" i]',
        '[id*="klaviyo" i]', '[class*="klaviyo" i]', '[class*="privy" i]',
        '[class*="cookie" i]', '[id*="cookie" i]', '[class*="banner" i]',
        '#shopify-section-popup', '.overlay', '.backdrop',
      ];
      for (const sel of popupSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'absolute' || parseInt(style.zIndex, 10) > 100) {
            (el as HTMLElement).style.display = 'none';
          }
        }
      }
    }).catch(() => {});

    const evaluated = await page.evaluate(() => {
      const elements: Array<{ id: string; tag: string; text: string; x: number; y: number; w: number; h: number; dataAttrs: string[] }> = [];
      let counter = 0;
      for (const el of document.querySelectorAll('*')) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width < 3 || rect.height < 3) continue;
        if (rect.width * rect.height > 2_000_000) continue;
        const id = `bs-${counter++}`;
        el.setAttribute('data-baystate-id', id);
        const dataAttrs = [...(el as Element).attributes].filter(a => a.name.startsWith('data-')).map(a => a.name).slice(0, 4);
        elements.push({ id, tag: el.tagName.toLowerCase(), text: ((el as HTMLElement).innerText ?? '').trim().slice(0, 120), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), dataAttrs });
      }
      const dom = document.documentElement.outerHTML;
      const viewport = { w: window.innerWidth, h: window.innerHeight, deviceScaleFactor: window.devicePixelRatio };
      return { dom, elements, viewport };
    });
    let dom: string = evaluated.dom;
    if (dom.length > 5 * 1024 * 1024) dom = dom.slice(0, 5 * 1024 * 1024);
    let screenshotBase64 = await page.screenshot({ type: 'png' }).then((buf: Buffer) => buf.toString('base64')).catch(() => '');
    if (screenshotBase64.length > 5 * 1024 * 1024) screenshotBase64 = screenshotBase64.slice(0, 5 * 1024 * 1024);
    await context.close();
    const capturedAt = new Date().toISOString();
    const elements: CaptureElement[] = evaluated.elements;
    const viewport = evaluated.viewport;
    const base: CaptureResult & { url: string } = { dom, screenshotBase64, runtime: 'rendered', hash: hashCapture({ dom, screenshotBase64, runtime: 'rendered', url, elementsCount: elements.length }), capturedAt, url, elements, viewport };
    return persistCapture(base);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { if (browser) await browser.close(); } catch (_e) { /* non-fatal */ }
    console.warn(`[profile-capture] rendered capture failed for ${redactUrl(url)}: ${msg}, falling back to static`);
    return captureStatic(url);
  } finally {
    clearTimeout(deadline);
    try { if (browser) await browser.close(); } catch (_e) { /* non-fatal */ }
  }
}
