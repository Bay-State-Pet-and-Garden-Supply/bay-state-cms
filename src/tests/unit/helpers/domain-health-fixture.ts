// Issue #198 — shared reviewed-health fixture for release-guard tests.
//
// Establishes the authoritative activation-rule health for a domain so
// release tests can assert movement: 3 confirmed representative samples,
// an active profile version whose artifact hashes exactly match a
// fully-passing title matrix, and the image bar recorded in the version
// evidence. Mirrors what the activation route's gate requires — a legacy
// `extractor_profiles` row alone never releases.
//
// Callers own DB lifecycle (initDb + runMigrations); this helper only
// writes fixture rows.
import { createVersion, setActiveVersion } from '../../../db/repositories/profile-version-repo';
import { runMatrix } from '../../../onboarding/profile-test-matrix';
import { setRepresentativeSuite } from '../../../db/repositories/representative-suite-repo';
import { createWaiver } from '../../../db/repositories/waiver-repo';

export async function makeDomainHealthy(
  domain: string,
  opts?: { confirmed?: number; waiver?: boolean },
): Promise<void> {
  const confirmed = opts?.confirmed ?? 3;
  const urls = Array.from({ length: confirmed }, (_, i) => `https://${domain}/products/p${i + 1}`);
  setRepresentativeSuite(domain, urls, 'tester');
  if (opts?.waiver) createWaiver(domain, 'small domain', 'operator-1');
  const hashes = urls.map((_, i) => `${domain}-hash-${i}`).sort();
  const version = createVersion({
    domain,
    selectors: { titleSelector: 'h1' },
    runtime: 'rendered',
    sampleIds: urls,
    artifactHashes: hashes,
    validationSummary: { imageRuleOk: true },
    provenance: { provider: 'test', model: 'test', configId: 'test' },
    approver: 'tester',
    reason: 'test',
  });
  const hashByUrl = new Map(urls.map((u, i) => [u, `${domain}-hash-${i}`]));
  await runMatrix({
    domain,
    draftVersion: version.id,
    samples: urls.map((u, i) => ({ id: u, url: u, expectedTitle: `Product ${i + 1}` })),
    runner: async (sample) => ({
      extractedTitle: `Product ${urls.indexOf(sample.url) + 1}`,
      provenance: 'css:h1',
      artifactHash: hashByUrl.get(sample.url) ?? `${domain}-hash-0`,
      success: true,
    }),
  });
  setActiveVersion(domain, version.id);
}
