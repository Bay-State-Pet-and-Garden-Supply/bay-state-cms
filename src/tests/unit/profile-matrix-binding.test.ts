// D3 — production-matrix binding: version-bound manager observations,
// durable multi-field cells, observation/freshness-gated health, and the
// count-only waiver. DB-backed, run under `bun test` (same convention as
// domain-version-health-evaluator.test.ts).
//
// Consumer-visible behavior only: a name-only manager sample passes only
// with complete approved fields/images; absent/wrong description, image,
// or variant fails despite the title; changed content invalidates prior
// approval; activation cannot pass on transient UI state.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createVersion } from '../../db/repositories/profile-version-repo';
import { recordSampleObservation } from '../../db/repositories/profile-sample-observation-repo';
import { setRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { createWaiver } from '../../db/repositories/waiver-repo';
import { runMatrix } from '../../onboarding/profile-test-matrix';
import { evaluateCandidateVersionHealth } from '../../onboarding/domain-version-health';
import {
  setupReleaseDb,
  teardownReleaseDb,
  cleanReleaseDomain,
} from './helpers/release-db-suite';

const WS = 'ws-matrix-binding-main';
const DOMAIN = 'matrix-binding.example.com';
const PROVENANCE = { provider: 'test', model: 'test', configId: 'test' };

const TITLE = 'Acme Full Product Name 12oz';
const DESCRIPTION = 'Full description text for the 12oz bag';
const IMAGE = `https://${DOMAIN}/images/full-12oz.jpg`;
const HASH = `${DOMAIN}-hash-0`;

function sampleUrls() {
  return [`https://${DOMAIN}/products/full`];
}

function makeVersion() {
  const urls = sampleUrls();
  return createVersion({
    domain: DOMAIN,
    selectors: { titleSelector: 'h1' },
    runtime: 'rendered',
    sampleIds: urls,
    artifactHashes: [HASH].sort(),
    validationSummary: { imageRuleOk: true },
    provenance: PROVENANCE,
    approver: 'tester',
    reason: 'test',
  });
}

function approve(versionId: string, opts?: { description?: string | null; image?: string | null; variantKey?: string | null; contentHash?: string | null }) {
  recordSampleObservation({
    domain: DOMAIN,
    versionId,
    sampleUrl: sampleUrls()[0],
    expectedTitle: TITLE,
    ...(opts && 'description' in opts ? { expectedDescription: opts.description } : { expectedDescription: DESCRIPTION }),
    ...(opts && 'image' in opts
      ? (opts.image ? { expectedPrimaryImage: opts.image } : {})
      : { expectedPrimaryImage: IMAGE }),
    variantKey: opts?.variantKey ?? null,
    contentHash: opts?.contentHash ?? HASH,
    approver: 'operator-1',
  });
}

async function runSampleMatrix(versionId: string, extracted: {
  title: string | null;
  description?: string | null;
  image?: string | null;
  variantKey?: string | null;
  artifactHash?: string;
}, expected?: { variantKey?: string | null }) {
  const urls = sampleUrls();
  setRepresentativeSuite(DOMAIN, urls, 'tester');
  createWaiver(DOMAIN, 'single-page brand', 'operator-1');
  const image = extracted.image === undefined ? IMAGE : extracted.image;
  const expectedVariant = expected?.variantKey ?? null;
  await runMatrix({
    domain: DOMAIN,
    draftVersion: versionId,
    // The sample expectation is the MANAGER-APPROVED observation (mirrors
    // what the route resolves from the repository); only the runner
    // return carries extracted values.
    samples: [{
      id: urls[0],
      url: urls[0],
      expectedTitle: TITLE,
      observation: {
        title: TITLE,
        description: DESCRIPTION,
        primaryImage: IMAGE,
        variantKey: expectedVariant,
        contentHash: HASH,
      },
      expectedVariantKey: expectedVariant,
      expectedContentHash: HASH,
    }],
    runner: async () => ({
      extractedTitle: extracted.title,
      provenance: 'css:h1',
      artifactHash: extracted.artifactHash ?? HASH,
      success: true,
      extractedVariantKey: extracted.variantKey ?? null,
      extractedProduct: {
        title: extracted.title,
        description: extracted.description ?? null,
        images: image ? [image] : [],
        primaryImage: image,
        variantKey: extracted.variantKey ?? null,
      },
    }),
  });
}

describe('production-matrix binding (D3)', () => {
  let tempDir: string;

  beforeAll(() => {
    ({ tempDir } = setupReleaseDb({
      tmpPrefix: 'matrix-binding-test-',
      workspaceIds: [WS],
      batch: { workspaceId: WS, name: 'Binding', fileName: 'b.csv', totalItems: 3 },
    }));
  });

  afterAll(() => {
    teardownReleaseDb(tempDir);
  });

  beforeEach(() => {
    cleanReleaseDomain(DOMAIN);
  });

  it('a complete name-only manager sample passes', async () => {
    const version = makeVersion();
    approve(version.id);
    await runSampleMatrix(version.id, { title: TITLE, description: DESCRIPTION, image: IMAGE });
    const verdict = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(verdict.healthy).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('a missing description fails despite a passing title (waiver cannot fake it)', async () => {
    const version = makeVersion();
    approve(version.id);
    await runSampleMatrix(version.id, { title: TITLE, description: null, image: IMAGE });
    const verdict = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain('description');
  });

  it('a wrong primary image fails despite a passing title', async () => {
    const version = makeVersion();
    approve(version.id);
    await runSampleMatrix(version.id, { title: TITLE, description: DESCRIPTION, image: `https://${DOMAIN}/images/other.jpg` });
    const verdict = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain('primary_image');
  });

  it('a wrong variant fails despite a passing title', async () => {
    const version = makeVersion();
    approve(version.id, { variantKey: 'size-m' });
    await runSampleMatrix(
      version.id,
      { title: TITLE, description: DESCRIPTION, image: IMAGE, variantKey: 'size-l' },
      { variantKey: 'size-m' },
    );
    const verdict = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toMatch(/wrong_variant|missing_identity|identity failed|variant failed/);
  });

  it('changed page content invalidates prior approval until renewed', async () => {
    const { updateVersionEvidence } = await import('../../db/repositories/profile-version-repo');
    const version = makeVersion();
    approve(version.id);
    await runSampleMatrix(version.id, { title: TITLE, description: DESCRIPTION, image: IMAGE, artifactHash: `${DOMAIN}-hash-changed` });
    const stale = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(stale.healthy).toBe(false);
    expect(stale.reason).toBe('stale_sample_observations');

    // Renewed review against the changed content: the manager re-approves
    // the new content hash and the version evidence advances with it.
    approve(version.id, { contentHash: `${DOMAIN}-hash-changed` });
    updateVersionEvidence(version.id, { artifactHashes: [`${DOMAIN}-hash-changed`] });
    await runSampleMatrix(version.id, { title: TITLE, description: DESCRIPTION, image: IMAGE, artifactHash: `${DOMAIN}-hash-changed` });
    expect(evaluateCandidateVersionHealth(DOMAIN, version.id).healthy).toBe(true);
  });

  it('a version without recorded observations cannot activate', async () => {
    const version = makeVersion();
    await runSampleMatrix(version.id, { title: TITLE, description: DESCRIPTION, image: IMAGE });
    const verdict = evaluateCandidateVersionHealth(DOMAIN, version.id);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toBe('missing_sample_observations');
  });

  it('the register name or URL is never an acceptable expectation', async () => {
    const version = makeVersion();
    const urls = sampleUrls();
    // Repository layer refuses URL-as-title even bypassing the route.
    expect(() =>
      recordSampleObservation({
        domain: DOMAIN,
        versionId: version.id,
        sampleUrl: urls[0],
        expectedTitle: urls[0],
        approver: 'operator-1',
      }),
    ).toThrow(/reviewed page title, not the URL/);
    // The route refuses it identically through the live app.
    const { default: app } = await import('../../server/app');
    const res = await app.request(`/api/domains/${DOMAIN}/profile/sample-observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: version.id, observations: [{ sampleUrl: urls[0], expectedTitle: urls[0], approver: 'operator-1' }] }),
    });
    expect(res.status).toBe(400);
  });
});
