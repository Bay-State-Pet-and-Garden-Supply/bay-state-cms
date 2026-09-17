// Fix 1 (image attestation recovery) + Fix 2 (activation preserves the
// complete builder configuration) — DB-backed, run under `bun test` (same
// convention as domain-version-health-evaluator.test.ts).
//
// Every version below is built through the ACTUAL builder payload shape
// (`createEmptyDraft` + `draftToVersionPayload`), so the activation test
// proves the production save path — not a hand-shaped fixture — survives
// activation with custom selectors and a variant strategy intact.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import {
  createVersion,
  getActiveVersion,
  updateVersionEvidence,
} from '../../db/repositories/profile-version-repo';
import { findProfileByDomain } from '../../db/repositories/extractor-profile-repo';
import { runTitleMatrix } from './helpers/domain-health-fixture';
import {
  setupReleaseDb,
  teardownReleaseDb,
  cleanReleaseDomain,
  type ReleaseDbSetup,
} from './helpers/release-db-suite';
import { evaluateCandidateVersionHealth, resolveExecutableProfile } from '../../onboarding/domain-version-health';
import { getDomainReleaseHealth } from '../../onboarding/domain-release';
import { createEmptyDraft, draftToVersionPayload } from '../../client/components/profile-builder/profileBuilderMapping';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const WS_MAIN = 'ws-attestation-activation-main';
const DOMAIN = 'attestation-activation.example.com';

const PROVENANCE = { provider: 'test', model: 'test', configId: 'test' };

/** Builder draft with the complete executable configuration under test. */
function buildConfiguredDraft() {
  const draft = createEmptyDraft({ domain: DOMAIN, runtime: 'static' });
  draft.titleSelector = 'h1';
  draft.descriptionSelector = 'meta[property="og:description"]';
  draft.imagesSelector = '.product-image-gallery img';
  draft.brandSelector = null;
  draft.priceSelector = null;
  draft.customSelectors = {
    careInstructionsSelector: '.care-instructions',
    flavorSelector: '.flavor',
  };
  draft.variantSelectionStrategy = {
    containerSelector: 'select#primaryvariationvalue',
    optionType: 'select',
    axes: ['size'],
  };
  draft.customSelectorMetadata = { flavorSelector: { unit: 'text' } };
  return draft;
}

/** Representative suite + fully-passing title matrix matching the version hashes. */
async function seedEvidence(versionId: string, urls: string[]) {
  setRepresentativeSuite(DOMAIN, urls, 'tester');
  const hashByUrl = new Map(urls.map((u, i) => [u, `${DOMAIN}-hash-${i}`]));
  await runTitleMatrix({
    domain: DOMAIN,
    versionId,
    urls,
    provenance: 'css:h1',
    hashForUrl: (u) => hashByUrl.get(u) ?? `${DOMAIN}-hash-0`,
  });
}

function suiteUrls() {
  return [1, 2, 3].map((i) => `https://${DOMAIN}/products/p${i}`);
}

function sortedHashes(urls: string[]) {
  return urls.map((_, i) => `${DOMAIN}-hash-${i}`).sort();
}

describe('version image attestation + complete-config activation', () => {
  let tempDir: string;
  let _batchId: string;

  beforeAll(() => {
    const setup: ReleaseDbSetup = setupReleaseDb({
      tmpPrefix: 'attestation-activation-test-',
      workspaceIds: [WS_MAIN],
      batch: { workspaceId: WS_MAIN, name: 'Attestation', fileName: 'a.csv', totalItems: 5 },
    });
    tempDir = setup.tempDir;
    _batchId = setup.batchId;
  });

  afterAll(() => {
    teardownReleaseDb(tempDir);
  });

  beforeEach(() => {
    resetActiveWorkerForTest();
    cleanReleaseDomain(DOMAIN);
  });

  it('absent attestation blocks the candidate with missing_image_attestation', async () => {
    const urls = suiteUrls();
    const version = createVersion({
      domain: DOMAIN,
      selectors: { titleSelector: 'h1' },
      runtime: 'rendered',
      sampleIds: urls,
      artifactHashes: sortedHashes(urls),
      validationSummary: {},
      provenance: PROVENANCE,
      approver: 'tester',
      reason: 'test',
    });
    await seedEvidence(version.id, urls);
    const verdict = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toMatch(/missing_image_attestation/);
  });

  it('explicit false blocks; the version-bound image-review action unblocks', async () => {
    const urls = suiteUrls();
    const draft = buildConfiguredDraft();
    const payload = draftToVersionPayload(draft, false);
    expect(payload.validationSummary.imageRuleOk).toBe(false);
    const version = createVersion({
      domain: payload.domain,
      selectors: payload.selectors,
      runtime: payload.runtime,
      sampleIds: urls,
      artifactHashes: sortedHashes(urls),
      validationSummary: payload.validationSummary,
      provenance: PROVENANCE,
      approver: 'tester',
      reason: 'test',
    });
    await seedEvidence(version.id, urls);
    expect(evaluateCandidateVersionHealth(DOMAIN, version.id)).toMatchObject({
      healthy: false,
      reason: 'image rule failed',
    });

    const res = await app.request(`/api/domains/${DOMAIN}/profile/versions/${version.id}/image-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed: true, approver: 'operator-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.validationSummary.imageRuleOk).toBe(true);

    const after = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(after.healthy).toBe(true);
    expect(after.reason).toBeNull();
  });

  it('matrix evidence updates preserve the attestation (never fabricate, never clear)', async () => {
    const urls = suiteUrls();
    const draft = buildConfiguredDraft();
    const payload = draftToVersionPayload(draft, true);
    const version = createVersion({
      domain: payload.domain,
      selectors: payload.selectors,
      runtime: payload.runtime,
      sampleIds: urls,
      artifactHashes: sortedHashes(urls),
      validationSummary: payload.validationSummary,
      provenance: PROVENANCE,
      approver: 'tester',
      reason: 'test',
    });
    await seedEvidence(version.id, urls);
    expect(evaluateCandidateVersionHealth(DOMAIN, version.id).healthy).toBe(true);

    // The exact evidence-only update the matrix route performs.
    updateVersionEvidence(version.id, { sampleIds: urls, artifactHashes: sortedHashes(urls) });
    expect(evaluateCandidateVersionHealth(DOMAIN, version.id).healthy).toBe(true);

    // A summary-carrying update without the key merges instead of clearing.
    updateVersionEvidence(version.id, { validationSummary: { rowCount: 3 } });
    expect(evaluateCandidateVersionHealth(DOMAIN, version.id).healthy).toBe(true);
  });

  it('activation preserves the builder custom selectors and variant strategy', async () => {
    const urls = suiteUrls();
    const draft = buildConfiguredDraft();
    // The ACTUAL builder payload shape — complete executable snapshot plus
    // the explicit image attestation — is the version under activation.
    const payload = draftToVersionPayload(draft, true, { sampleCount: urls.length });
    expect(payload.selectors.customSelectors).toEqual({
      careInstructionsSelector: '.care-instructions',
      flavorSelector: '.flavor',
    });
    expect(payload.selectors.variantSelectionStrategy).toEqual({
      containerSelector: 'select#primaryvariationvalue',
      optionType: 'select',
      axes: ['size'],
    });
    const version = createVersion({
      domain: payload.domain,
      selectors: payload.selectors,
      runtime: payload.runtime,
      sampleIds: urls,
      artifactHashes: sortedHashes(urls),
      validationSummary: payload.validationSummary,
      provenance: PROVENANCE,
      approver: 'tester',
      reason: 'test',
    });
    await seedEvidence(version.id, urls);
    expect(evaluateCandidateVersionHealth(DOMAIN, version.id).healthy).toBe(true);

    const res = await app.request(`/api/domains/${DOMAIN}/profile/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: version.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allowed: true, activeVersionId: version.id });
    expect(getActiveVersion(DOMAIN)!.id).toBe(version.id);

    // Activation rebuilt the legacy profile from the version snapshot —
    // custom-field extraction and variant interaction survive.
    const legacy = findProfileByDomain(DOMAIN)!;
    expect(legacy).not.toBeNull();
    expect(legacy.titleSelector).toBe('h1');
    expect(legacy.descriptionSelector).toBe('meta[property="og:description"]');
    expect(legacy.imagesSelector).toBe('.product-image-gallery img');
    expect(legacy.customSelectors).toEqual({
      careInstructionsSelector: '.care-instructions',
      flavorSelector: '.flavor',
    });
    expect(legacy.variantSelectionStrategy).toEqual({
      containerSelector: 'select#primaryvariationvalue',
      optionType: 'select',
      axes: ['size'],
    });
    expect(legacy.runtime).toBe('static');

    // The same snapshot validates (release health) and executes.
    expect(getDomainReleaseHealth(DOMAIN)).toEqual({ healthy: true, reason: null });
    const resolved = resolveExecutableProfile(DOMAIN);
    expect(resolved.customSelectors).toEqual({
      careInstructionsSelector: '.care-instructions',
      flavorSelector: '.flavor',
    });
    expect(resolved.variantSelectionStrategy).toEqual({
      containerSelector: 'select#primaryvariationvalue',
      optionType: 'select',
      axes: ['size'],
    });
  });
});
