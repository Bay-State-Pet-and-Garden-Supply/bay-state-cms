// story: e08 Test slice — durable production matrix routes
import { Hono } from 'hono';
import { getVersionById, listVersions, updateVersionEvidence, profileFromVersion } from '../../db/repositories/profile-version-repo';
import { getRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { runMatrix, getMatrixResult } from '../../onboarding/profile-test-matrix';
import { runProfileForUrl } from '../../onboarding/profile-runner-client';

export const profileMatrixRoutes = new Hono();

function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, '').trim();
}

profileMatrixRoutes.post('/domains/:domain/profile/test-matrix', async (c) => {
  const raw = c.req.param('domain') ?? '';
  const domain = normalizeDomain(raw);
  const body = (await c.req.json().catch(() => ({}))) as { versionId?: string; sampleIds?: string[] };
  const versionId = body.versionId?.trim();
  if (!versionId) return c.json({ error: 'versionId required' }, 400);
  const version = getVersionById(versionId);
  if (!version) return c.json({ error: 'version not found' }, 404);
  if (normalizeDomain(version.domain) !== domain) return c.json({ error: 'domain mismatch' }, 400);
  const suite = getRepresentativeSuite(domain);
  const sampleIds = body.sampleIds ?? suite;
  const samples = sampleIds.map((url) => ({ id: url, url, expectedTitle: url }));
  if (samples.length === 0) return c.json({ error: 'no samples' }, 400);
  const runner = async (sample: { id: string; url: string; expectedTitle: string }) => {
    try {
      const profile = profileFromVersion(version);
      const res = await runProfileForUrl({ sourceUrl: sample.url, profile, expected: { name: sample.expectedTitle } });
      if (!res.ok) return { extractedTitle: null, provenance: 'profile_runner_failed', artifactHash: 'no-hash', success: false, failureReason: res.error, extractedProduct: null };
      const data = res.data as any;
      const extracted = data?.title ?? null;
      const success = !!extracted;
      const artifactHash = res.sourceContentHash ?? 'no-hash';
      const provenance = (res.fieldProvenance as Record<string, string>)?.title ?? 'profile_selector';
      const allImages = Array.isArray(data?.images) && data.images.length > 0
        ? data.images
        : [data?.primaryImage, ...(Array.isArray(data?.additionalImages) ? data.additionalImages : [])].filter(Boolean);

      return {
        extractedTitle: extracted,
        provenance,
        artifactHash,
        success,
        failureReason: success ? null : 'title missing',
        extractedProduct: data ? {
          title: data.title ?? null,
          brand: data.brand ?? null,
          price: data.price ?? null,
          description: data.description ?? null,
          images: allImages,
          customFields: data.customFields ?? {},
        } : null,
      };
    } catch (e) {
      return { extractedTitle: null, provenance: 'runner_error', artifactHash: 'no-hash', success: false, failureReason: String(e), extractedProduct: null };
    }
  };
  const result = await runMatrix({ domain, draftVersion: versionId, samples, runner });
  try {
    const actualHashes = [...new Set(result.rows.flatMap(r => r.cells.map(c => c.artifactHash)))].sort();
    const sampleIds = result.rows.map(r => r.sampleId);
    updateVersionEvidence(versionId, { sampleIds, artifactHashes: actualHashes });
  } catch (_e) {
    // Non-fatal if DB update fails in test/fallback env
  }
  return c.json(result);
});

profileMatrixRoutes.get('/domains/:domain/profile/matrix/:versionId', (c) => {
  const raw = c.req.param('domain') ?? '';
  const domain = normalizeDomain(raw);
  const versionId = c.req.param('versionId') ?? '';
  const result = getMatrixResult(domain, versionId);
  if (!result) return c.json({ error: 'matrix not found' }, 404);
  return c.json(result);
});

profileMatrixRoutes.get('/domains/:domain/profile/versions', (c) => {
  const raw = c.req.param('domain') ?? '';
  const domain = normalizeDomain(raw);
  const versions = listVersions(domain);
  return c.json(versions);
});
