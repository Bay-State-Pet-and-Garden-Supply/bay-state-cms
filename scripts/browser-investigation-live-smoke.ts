#!/usr/bin/env bun
/**
 * T6 live-smoke CLI entry (thin wrapper).
 *
 * Opt-in manual rollout probe for the constrained local investigation
 * harness. All gate, isolation, and report logic lives in
 * `src/onboarding/browser-investigation/live-smoke.ts` so it stays
 * importable by the Vitest suite; this file only wires argv/env to it.
 *
 * Usage:
 *   BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE=1 \
 *   BAYSTATE_INVESTIGATION_ISOLATION=ready \
 *   BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE_MODEL=local:qwen2.5vl:latest \
 *   bun scripts/browser-investigation-live-smoke.ts --domain shop.example.com --sample-url https://shop.example.com/products/alpha
 *
 * Never runs in CI (refuses when CI is set), never runs without the
 * explicit flag + isolation + model config, and records only what was
 * actually performed — no activation, release, or attestation is ever
 * inferred. Without the flag this script performs no network.
 */
import { checkIsolationAvailable } from '../src/onboarding/browser-investigation/isolation.ts';
import { runLiveSmoke } from '../src/onboarding/browser-investigation/live-smoke.ts';

function takeValue(argv: readonly string[], index: number, flag: string): string | null {
  const value = argv[index];
  if (value == null || value.startsWith('--')) {
    console.error(`missing value for ${flag}`);
    process.exit(2);
  }
  return value;
}

interface SmokeCli {
  domain: string | null;
  sampleUrls: string[];
  model: string | null;
}

const CLI_FLAG_HANDLERS: Readonly<Record<string, (cli: SmokeCli, value: string) => void>> = {
  '--domain': (cli, value) => {
    cli.domain = value;
  },
  '--sample-url': (cli, value) => {
    cli.sampleUrls.push(value);
  },
  '--model': (cli, value) => {
    cli.model = value;
  },
};

function parseArgv(argv: readonly string[]): SmokeCli {
  const cli: SmokeCli = { domain: null, sampleUrls: [], model: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const handle = CLI_FLAG_HANDLERS[arg];
    if (!handle) {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
    handle(cli, takeValue(argv, i + 1, arg)!);
    i += 1;
  }
  return cli;
}

if (import.meta.main === true) {
  const { domain, sampleUrls, model } = parseArgv(process.argv.slice(2));
  const outcome = await runLiveSmoke({
    domain,
    sampleUrls,
    ...(model ? { modelRef: model } : {}),
    env: process.env as Record<string, string | undefined>,
    checkIsolation: () => checkIsolationAvailable(),
    // Manual rollout step: isolation verification only. A bounded live
    // browser investigation is launched explicitly by the operator from the
    // Profile Workspace once this probe reports isolation ready — this CLI
    // never launches a browser on its own, so the report cannot overclaim.
    performLiveInvestigation: async () => ({
      steps: ['isolation_verified'],
      notes: ['live browser investigation not launched by this probe; launch explicitly from the Profile Workspace'],
    }),
  });
  if (outcome.report) {
    console.log(JSON.stringify(outcome.report, null, 2));
  } else {
    console.error(outcome.reason ?? 'live smoke refused');
  }
  process.exit(outcome.exitCode);
}
