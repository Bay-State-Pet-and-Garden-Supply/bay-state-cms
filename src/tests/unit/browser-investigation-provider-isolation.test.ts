// T1 (#225) — provider-seam isolation (Vitest, pure static audit).
//
// Guards the mandatory negative invariant at the source level:
// - Only explicit investigate/repair seams may invoke the provider
//   (service + investigation routes + fake/local providers).
// - Worker polling, failure handling, diagnostics reads, and normal
//   extraction never invoke it.
// - No Cloud browser SDK plumbing ships in this slice.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = process.cwd();

/** Files allowed to reference the investigation provider seam. */
const PROVIDER_SEAM_ALLOWLIST = new Set([
  'src/onboarding/browser-investigation/provider.ts',
  'src/onboarding/browser-investigation/fake-provider.ts',
  'src/onboarding/browser-investigation/service.ts',
  'src/onboarding/browser-investigation/store.ts',
  'src/server/routes/browser-investigation-routes.ts',
  // Tests that exercise the seam directly.
  'src/tests/unit/browser-investigation-fake-provider.test.ts',
  'src/tests/unit/browser-investigation-lifecycle.test.ts',
  'src/tests/unit/browser-investigation-provider-isolation.test.ts',
  'src/tests/unit/browser-investigation-routes.test.ts',
]);

/** Normal-extraction / worker / diagnostics files that must NEVER touch it. */
const NORMAL_EXTRACTION_SENTINELS = [
  'src/onboarding/job-queue.ts',
  'src/onboarding/page-extractor.ts',
  'src/onboarding/profile-runner-client.ts',
  'src/onboarding/domain-diagnostics-service.ts',
  'src/onboarding/extraction-validator.ts',
  'src/extraction-worker/routes/extract.ts',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function referencesProviderSeam(source: string): boolean {
  return (
    source.includes('browser-investigation/provider') ||
    source.includes('browser-investigation/fake-provider') ||
    source.includes('invokeInvestigationProvider') ||
    source.includes('fakeInvestigationProvider')
  );
}

function isCloudPlumbing(source: string): boolean {
  const lowered = source.toLowerCase();
  if (lowered.includes('browser-use-sdk')) return true;
  if (lowered.includes('browser_use')) return true;
  if (lowered.includes('BROWSER_USE_API_KEY')) return true;
  return /browseruse|browser-use/.test(lowered) && lowered.includes('cloud');
}

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkSrc(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
  return out;
}

describe('browser investigation provider isolation (T1)', () => {
  it('only explicit investigate/repair seams reference the provider', () => {
    const offenders: string[] = [];
    for (const rel of walkSrc(path.join(REPO_ROOT, 'src'))) {
      if (PROVIDER_SEAM_ALLOWLIST.has(rel)) continue;
      if (rel.startsWith('src/tests/')) continue;
      let source: string;
      try {
        source = read(rel);
      } catch {
        continue;
      }
      if (referencesProviderSeam(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('worker polling, failure handling, diagnostics, and normal extraction never invoke it', () => {
    for (const rel of NORMAL_EXTRACTION_SENTINELS) {
      const full = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(full)) continue;
      expect(referencesProviderSeam(read(rel)), rel).toBe(false);
    }
  });

  it('no Cloud browser SDK plumbing ships in this slice', () => {
    const offenders: string[] = [];
    for (const rel of walkSrc(path.join(REPO_ROOT, 'src'))) {
      // Test fixtures legitimately name the forbidden strings inside
      // assertions (e.g. resolveInvestigationProvider('browser_use_cloud'));
      // the shipped boundary is production code.
      if (rel.startsWith('src/tests/')) continue;
      let source: string;
      try {
        source = read(rel);
      } catch {
        continue;
      }
      if (isCloudPlumbing(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(allDeps).filter((d) => d.toLowerCase().includes('browser-use'))).toEqual([]);
  });

  it('the investigation service never imports activation, release, or health writers', () => {
    const service = read('src/onboarding/browser-investigation/service.ts');
    // Import-level check: comments may (and should) name the boundary
    // ("never activates profiles...") without depending on it.
    const importLines = service.split('\n').filter((l) => /import\s|require\(/.test(l));
    const importBlock = importLines.join('\n');
    for (const forbidden of [
      'profile-activation-gate',
      'domain-release',
      'releaseDomainExtractionItems',
      'setActiveVersion',
      'image-reuse-policy',
    ]) {
      expect(importBlock.includes(forbidden), forbidden).toBe(false);
    }
    expect(/\battest\w*\s*\(/.test(importBlock), 'attest-call').toBe(false);
  });
});
