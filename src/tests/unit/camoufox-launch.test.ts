import { describe, it, expect } from 'vitest';
import { createLaunchContext, createPlainPlaywrightLaunchContext } from '../../extraction-worker/browser/camoufox-launch';
import type { WorkerBrowserConfig } from '../../extraction-worker/browser/config';

describe('camoufox-launch launch context creation', () => {
  const baseConfig: WorkerBrowserConfig = {
    backend: 'camoufox',
    headless: true,
    navigationTimeoutMs: 25000,
    dwellMs: 2000,
    maxConcurrency: 2,
    maxOpenPagesPerBrowser: 20,
    retireBrowserAfterPageCount: 100,
    maxRequestRetries: 2,
    proxyUrls: [],
  };

  it('selects plain Playwright Chromium when backend is playwright', async () => {
    const config: WorkerBrowserConfig = {
      ...baseConfig,
      backend: 'playwright',
    };
    const ctx = await createLaunchContext(config);
    expect(ctx.launcher.name()).toBe('chromium');
  });

  it('creates plain Playwright launch context with expected flags', async () => {
    const ctx = await createPlainPlaywrightLaunchContext(baseConfig);
    expect(ctx.launcher.name()).toBe('chromium');
    expect(ctx.launchOptions.headless).toBe(true);
    expect(ctx.launchOptions.args).toContain('--no-sandbox');
  });

  it('returns a launch context in camoufox mode', async () => {
    const ctx = await createLaunchContext(baseConfig);
    expect(ctx).toBeDefined();
    expect(ctx.launcher).toBeDefined();
  });
});
