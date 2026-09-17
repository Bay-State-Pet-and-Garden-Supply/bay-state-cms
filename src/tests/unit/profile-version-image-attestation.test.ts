/**
 * Version-bound explicit image-review attestation (Fix 1, vitest, no DB).
 *
 * Proves the repository contract under the in-memory fallback:
 * - `draftToVersionPayload` is the save-path writer of `imageRuleOk`
 *   (explicit boolean, default false — never absent-by-accident here);
 * - `attestVersionImageReview` is the ONLY post-creation writer;
 * - `updateVersionEvidence` (the matrix re-run path) preserves a prior
 *   attestation and never fabricates one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDraft, draftToVersionPayload } from '../../client/components/profile-builder/profileBuilderMapping';

const PROVENANCE = { provider: 'test', model: 'test', configId: 'test' };

async function freshVersion(imageReviewed: boolean) {
  const repo = await import('../../db/repositories/profile-version-repo');
  repo.resetProfileVersionsForTest();
  const draft = createEmptyDraft({ domain: 'attest.example.com' });
  draft.titleSelector = 'h1';
  const payload = draftToVersionPayload(draft, imageReviewed);
  return {
    repo,
    version: repo.createVersion({
      domain: payload.domain,
      selectors: payload.selectors,
      runtime: payload.runtime,
      sampleIds: ['s1'],
      artifactHashes: ['h1'],
      validationSummary: payload.validationSummary,
      provenance: PROVENANCE,
      approver: 'tester',
      reason: 'test',
    }),
  };
}

describe('version image attestation repository contract', () => {
  beforeEach(async () => {
    const { resetProfileVersionsForTest } = await import('../../db/repositories/profile-version-repo');
    resetProfileVersionsForTest();
  });

  it('creation records an explicit false attestation by default (blocked, not absent-by-accident)', async () => {
    const { repo, version } = await freshVersion(false);
    expect(repo.getVersionById(version.id)?.validationSummary.imageRuleOk).toBe(false);
  });

  it('explicit review records true via the save payload', async () => {
    const { repo, version } = await freshVersion(true);
    expect(repo.getVersionById(version.id)?.validationSummary.imageRuleOk).toBe(true);
  });

  it('attestVersionImageReview flips the stored attestation both ways', async () => {
    const { repo, version } = await freshVersion(false);
    repo.attestVersionImageReview(version.id, true, { approver: 'operator-1' });
    const attested = repo.getVersionById(version.id)!;
    expect(attested.validationSummary.imageRuleOk).toBe(true);
    expect(attested.validationSummary.imageReviewedBy).toBe('operator-1');
    repo.attestVersionImageReview(version.id, false);
    expect(repo.getVersionById(version.id)?.validationSummary.imageRuleOk).toBe(false);
  });

  it('matrix re-run preserves a prior attestation (never clears, never fabricates)', async () => {
    const { repo, version } = await freshVersion(true);
    // The exact call the matrix route makes: evidence only, no summary.
    repo.updateVersionEvidence(version.id, { sampleIds: ['s1', 's2'], artifactHashes: ['h2', 'h1'] });
    expect(repo.getVersionById(version.id)?.validationSummary.imageRuleOk).toBe(true);
    // Even a summary-carrying update without the key preserves it.
    repo.updateVersionEvidence(version.id, { validationSummary: { rowCount: 2 } });
    const merged = repo.getVersionById(version.id)!;
    expect(merged.validationSummary.imageRuleOk).toBe(true);
    expect(merged.validationSummary.rowCount).toBe(2);
  });

  it('matrix re-run never fabricates attestation on an unattested version', async () => {
    const { repo, version } = await freshVersion(false);
    repo.updateVersionEvidence(version.id, { sampleIds: ['s1', 's2'], artifactHashes: ['h2', 'h1'] });
    expect(repo.getVersionById(version.id)?.validationSummary.imageRuleOk).toBe(false);
  });

  it('attesting an unknown version returns null', async () => {
    const { resetProfileVersionsForTest, attestVersionImageReview } = await import('../../db/repositories/profile-version-repo');
    resetProfileVersionsForTest();
    expect(attestVersionImageReview('does-not-exist', true)).toBeNull();
  });
});
