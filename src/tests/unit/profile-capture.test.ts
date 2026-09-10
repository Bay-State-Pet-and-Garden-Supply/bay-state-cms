// story: e07s03, oracle follow-up
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

describe('profile-capture // story: e07s03', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function expectedHash(dom: string, screenshot: string, runtime: string, url: string, elementsCount = 0): string {
    return createHash('sha256').update(dom + screenshot + runtime + url + String(elementsCount)).digest('hex').slice(0, 16);
  }

  it('static capture fetches html and returns elements=[] viewport=null hash 16', async () => {
    const html = '<html><body><h1>Title</h1></body></html>';
    global.fetch = vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    const res = await captureProfilePage({ url: 'https://example.com/p/1', runtime: 'static' });
    expect(res.dom).toBe(html);
    expect(res.runtime).toBe('static');
    expect(res.elements).toEqual([]);
    expect(res.viewport).toBeNull();
    expect(res.hash).toBe(expectedHash(html, '', 'static', 'https://example.com/p/1', 0));
    expect(res.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(res.screenshotRef).toMatch(/baystate-captures/);
    expect(new Date(res.capturedAt).toISOString()).toBe(res.capturedAt);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rendered capture uses playwright and returns elements+viewport+hash 16', async () => {
    const dom = '<html><body><h1>Rendered</h1></body></html>';
    const fakeScreenshot = Buffer.from('pngdata').toString('base64');
    const mockElements = [
      { id: 'bs-0', tag: 'h1', text: 'Rendered', x: 20, y: 80, w: 400, h: 36, dataAttrs: [] },
      { id: 'bs-1', tag: 'div', text: 'Rendered extra', x: 10, y: 70, w: 500, h: 480, dataAttrs: [] },
    ];
    vi.doMock('playwright', () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: async () => ({
            newPage: async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({ dom, elements: mockElements, viewport: { w: 1280, h: 720, deviceScaleFactor: 1 } })),
              screenshot: vi.fn(async () => Buffer.from('pngdata')),
              close: vi.fn(async () => {}),
              on: vi.fn(),
            }),
            close: vi.fn(async () => {}),
          }),
          close: vi.fn(async () => {}),
        })),
      },
    }));
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    const res = await captureProfilePage({ url: 'https://example.com/p/2', runtime: 'rendered' });
    expect(res.dom).toBe(dom);
    expect(res.runtime).toBe('rendered');
    expect(res.elements).toEqual(mockElements);
    expect(res.viewport).toEqual({ w: 1280, h: 720, deviceScaleFactor: 1 });
    expect(res.hash).toBe(expectedHash(dom, fakeScreenshot, 'rendered', 'https://example.com/p/2', mockElements.length));
    expect(res.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(res.screenshotRef).toMatch(/baystate-captures/);
  });

  it('hitTest returns smallest-area element containing point', async () => {
    const { hitTest } = await import('../../onboarding/profile-capture.ts');
    const elements = [
      { id: 'bs-0', tag: 'h1', text: 'Title', x: 20, y: 80, w: 400, h: 36, dataAttrs: [] },
      { id: 'bs-1', tag: 'div', text: 'Title wrapper', x: 10, y: 70, w: 500, h: 480, dataAttrs: [] },
      { id: 'bs-2', tag: 'img', text: '', x: 20, y: 170, w: 320, h: 320, dataAttrs: [] },
    ];
    expect(hitTest(elements, 30, 95)).toBe('bs-0');
    expect(hitTest(elements, 25, 135)).toBe('bs-1');
    expect(hitTest(elements, 50, 200)).toBe('bs-2');
    expect(hitTest(elements, 2000, 2000)).toBeNull();
  });

  it('static capture throws on fetch failure with context', async () => {
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    await expect(captureProfilePage({ url: 'https://example.com/missing', runtime: 'static' })).rejects.toThrow(/fetch failed 404/);
  });

  it('blocks private, loopback, and decimal IP addresses (SSRF guard)', async () => {
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    const blockedUrls = [
      'http://127.0.0.1/secret',
      'http://10.0.0.1/admin',
      'http://2130706433/internal',
    ];
    for (const url of blockedUrls) {
      await expect(captureProfilePage({ url, runtime: 'static' })).rejects.toThrow(/blocked private destination/);
    }
  });

  it('fails closed when DNS resolution fails for unresolvable hostnames', async () => {
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    await expect(captureProfilePage({ url: 'http://invalid-nonexistent-domain-xyz987.invalid/p/1', runtime: 'static' })).rejects.toThrow(/blocked private destination/);
  });

  it('allows public 172.x Cloudflare IP addresses without false-positive blocking', async () => {
    const html = '<html><body><h1>Public Cloudflare Host</h1></body></html>';
    global.fetch = vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    const res = await captureProfilePage({ url: 'http://172.67.182.1/p/1', runtime: 'static' });
    expect(res.dom).toBe(html);
  });
});
