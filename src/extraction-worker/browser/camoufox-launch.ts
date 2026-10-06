/**
 * Camoufox / Plain Playwright launch-context factory for the extraction worker.
 *
 * Camoufox is an anti-detect Firefox build that injects realistic browser
 * fingerprints (canvas, WebGL, fonts, TLS, etc.) to evade Cloudflare and
 * similar bot-detection systems.
 *
 * The plain Playwright path exists as a documented rollback when
 * BAYSTATE_CMS_WORKER_BROWSER_BACKEND=playwright is set.
 */

import { firefox, chromium, type Browser, type LaunchOptions } from 'playwright';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import type { WorkerBrowserConfig } from './config';

export interface LaunchContext {
  launcher: typeof firefox | typeof chromium;
  launchOptions: LaunchOptions & { executablePath?: string };
}

/**
 * Create a launch context using Camoufox (anti-detect Firefox).
 * This is the default and preferred backend.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function createCamoufoxLaunchContext(
  config: WorkerBrowserConfig,
): Promise<LaunchContext> {
  const opts = await camoufoxLaunchOptions({
    headless: config.headless,
  });

  return {
    launcher: firefox,
    launchOptions: {
      ...opts,
      args: [
        ...(opts.args ?? []),
        '--window-size=1280,800',
      ],
    },
  };
}

/**
 * Create a launch context using plain Playwright Chromium.
 * Use this as a documented rollback when Camoufox is unavailable.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function createPlainPlaywrightLaunchContext(
  config: WorkerBrowserConfig,
): Promise<LaunchContext> {
  return {
    launcher: chromium,
    launchOptions: {
      headless: config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars',
        '--window-size=1280,800',
        // Scoped trust flags (e.g. the Tier 1 render worker accepting the
        // per-run validating-proxy credential in-container). Empty in
        // normal extraction; only `--` flags survive config parsing.
        ...(config.extraLaunchArgs ?? []),
      ],
    },
  };
}

/**
 * Auto-select launch context based on worker config backend setting.
 */
export async function createLaunchContext(
  config: WorkerBrowserConfig,
): Promise<LaunchContext> {
  if (config.backend === 'playwright') {
    console.log('[browser] Using plain Playwright Chromium (rollback mode)');
    return createPlainPlaywrightLaunchContext(config);
  }
  console.log('[browser] Using Camoufox (anti-detect Firefox)');
  try {
    return await createCamoufoxLaunchContext(config);
  } catch (err) {
    console.warn('[browser] Failed to initialize Camoufox, falling back to plain Playwright Chromium:', err);
    return createPlainPlaywrightLaunchContext(config);
  }
}
