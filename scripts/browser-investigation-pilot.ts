#!/usr/bin/env bun
/**
 * #239 real thin-slice pilot CLI (opt-in, thin wrapper).
 *
 * Explicit-request → containerized local-harness investigation of a REAL
 * Shopify domain → compiled policy → ACTUAL production-worker representative
 * + truly blind holdout validation → governed inactive draft. All gate,
 * argv, orchestration, and report logic lives in
 * `src/onboarding/browser-investigation/pilot.ts` so it stays importable by
 * the Vitest suite; this file only reads argv/env and injects the REAL
 * dependencies (real isolation probe, real lifecycle service with the
 * default local harness, the SAME production policy runner the validation
 * route uses, memory stores with a capturing version creator — no production
 * DB writes, no activation path).
 *
 * Usage:
 *   BAYSTATE_CMS_BROWSER_INVESTIGATION_PILOT=1 \
 *   BAYSTATE_INVESTIGATION_ISOLATION=ready \
 *   BAYSTATE_CMS_WORKER_TOKEN=... BAYSTATE_CMS_WORKER_PORT=3032 \
 *   bun scripts/browser-investigation-pilot.ts \
 *     --domain www.allbirds.com \
 *     --rep-url https://www.allbirds.com/products/womens-wool-runners-natural-black \
 *     --holdout-url https://www.allbirds.com/products/trino-tubers-onyx \
 *     --expected-json /tmp/pilot-expected.json
 *
 * The expected JSON maps each validation URL to its trusted expected
 * identity: { "<url>": { "name": "...", "sku": "...", "gtin": "...",
 * "productId": "...", "variantKey": "...", "platformVariantId": "...",
 * "brandHint": "...", "price": "..." } }. At minimum each entry needs a
 * name, a trusted identifier (sku/gtin/platformVariantId/variantKey), and
 * the parent productId.
 *
 * Never runs in CI (refuses when CI is set), never runs without the
 * explicit flag + isolation + explicit domain/URLs/expected, and records
 * only what was actually performed — no activation, release, or attestation
 * is ever inferred. Without the flag this script performs no network.
 */
import { readFileSync } from 'node:fs';
import { checkIsolationAvailable } from '../src/onboarding/browser-investigation/isolation.ts';
import { registerInvestigationProvider } from '../src/onboarding/browser-investigation/provider.ts';
import { LocalBrowserHarnessProvider } from '../src/onboarding/browser-investigation/local-harness.ts';
import { requestAndRunInvestigation } from '../src/onboarding/browser-investigation/service.ts';
import { parseExpectedIdentities, parsePilotArgv, runPilot } from '../src/onboarding/browser-investigation/pilot.ts';
import { productionPolicyRunner } from '../src/onboarding/browser-investigation/policy-worker-runner.ts';
import { createMemoryInvestigationStore } from '../src/tests/unit/helpers/browser-investigation-memory-store.ts';

/** Read the expected-identity JSON, or exit 2 with an operator-safe reason. */
function readExpectedJson(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`cannot read expected JSON ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.main === true) {
  // Production wiring (mirrors browser-investigation-routes): the real
  // containerized local harness is the default provider. The fake is never
  // registered here, so no pilot run can ever produce fabricated evidence.
  registerInvestigationProvider(new LocalBrowserHarnessProvider());
  const cli = parsePilotArgv(process.argv.slice(2));
  if (!cli.ok) {
    console.error(cli.reason);
    process.exit(2);
  }
  const expected = parseExpectedIdentities(readExpectedJson(cli.value.expectedJsonPath!));
  if (!expected.ok) {
    console.error(expected.reason);
    process.exit(2);
  }
  let applied = 0;
  const outcome = await runPilot({
    domain: cli.value.domain,
    representativeUrls: cli.value.representativeUrls,
    holdoutUrls: cli.value.holdoutUrls,
    expectedByUrl: expected.value,
    ...(cli.value.workspaceId ? { workspaceId: cli.value.workspaceId } : {}),
    ...(cli.value.actor ? { actor: cli.value.actor } : {}),
    env: process.env as Record<string, string | undefined>,
    checkIsolation: () => checkIsolationAvailable(),
    investigate: async ({ workspaceId, domain, representativeUrls }) =>
      requestAndRunInvestigation(createMemoryInvestigationStore(), {
        workspaceId,
        domain,
        mode: 'domain_onboarding',
        sampleUrls: representativeUrls,
        modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
        knownContext: {},
      }),
    runner: productionPolicyRunner,
    createVersion: (input) => {
      applied += 1;
      const domain = String((input as { domain?: unknown }).domain ?? '');
      return { id: `ver_pilot_${Date.now().toString(36)}_${applied}`, domain, version: applied };
    },
  });
  if (outcome.report) {
    console.log(JSON.stringify(outcome.report, null, 2));
  } else {
    console.error(outcome.reason ?? 'pilot refused');
  }
  process.exit(outcome.exitCode);
}
