// story: e07s04 — POST /api/domains/:domain/profile/activate (cluster-aware fail-closed, deterministic release)
import { Hono, type Context } from 'hono';
import { getVersionById, setActiveVersion, createVersion, listVersions, profileFromVersion, attestVersionImageReview, type ProfileVersion } from '../../db/repositories/profile-version-repo';
import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { evaluateCandidateVersionHealth } from '../../onboarding/domain-version-health';
import { getDb } from '../../db/connection';
import { encodeForStorage, readStorageVersion } from '../../db/repositories/onboarding-stage-vocabulary-repo';

export const profileActivationRoutes = new Hono();

/** Lowercased www-stripped `:domain` route param shared by the activation routes. */
function domainFromParam(c: Context): string {
  return (c.req.param('domain') ?? '').toLowerCase().replace(/^www\./, '').trim();
}

/**
 * Shared version guard for the version-scoped activation routes: resolves the
 * version row and enforces domain binding. Returns the version, or an
 * `{ error }` carrying the exact error Response the handler must return.
 */
function requireDomainVersion(
  c: Context,
  domain: string,
  versionId: string,
): { version: ProfileVersion; error: null } | { version: null; error: Response } {
  const version = getVersionById(versionId);
  if (!version) return { version: null, error: c.json({ error: 'version not found' }, 404) };
  if (version.domain !== domain) return { version: null, error: c.json({ error: 'version domain mismatch' }, 400) };
  return { version, error: null };
}

/**
 * Requeue parked pre-extraction setup rows for the domain. Pre-extraction
 * rows carry no variant matrix, so the variant-identity hold cannot apply
 * here (Issue #218 scope note); the canonical extraction release below
 * filters on it (bulk `releaseAllBlocked` included). Non-fatal by design.
 */
function releaseParkedSetupRows(domain: string): number {
  let released = 0;
  try {
    const db = getDb();
    const parked = db.query("SELECT id, source_url FROM onboarding_items WHERE status = 'setup_required_profile'").all() as Array<{ id: string; source_url: string | null }>;
    const now = new Date().toISOString();
    for (const row of parked) {
      let h = '';
      try { h = new URL(row.source_url ?? '').hostname.replace(/^www\./, '').toLowerCase(); } catch (_err) { /* ignore invalid url */ }
      if (h === domain) {
        // Slice 5b native: requeue write encodes the observed storage version.
        db.query("UPDATE onboarding_items SET status = 'pending', stage = ?, stage_status = 'pending', error_message = NULL, updated_at = ? WHERE id = ?").run(encodeForStorage('collect_details', readStorageVersion(db)), now, row.id);
        released++;
      }
    }
  } catch (_err) {
    // Parked items release non-fatal
  }
  return released;
}

/**
 * Sweep profile-blocked failed extraction items through the canonical
 * release (workspace-scoped, variant-hold filtered). Non-fatal by design.
 */
async function sweepBlockedExtractionItems(domain: string): Promise<number> {
  try {
    const { getCurrentWorkspace } = await import('../../server/services/workspace-service');
    const ws = (getCurrentWorkspace as any)();
    if (ws?.id) {
      const { releaseDomainExtractionItems } = await import('../../onboarding/domain-release');
      const res = (releaseDomainExtractionItems as any)(ws.id, domain, { releaseAllBlocked: true });
      return (res.releasedIds?.length ?? 0);
    }
  } catch (_err) {
    // Extraction items release non-fatal
  }
  return 0;
}

profileActivationRoutes.get('/domains/:domain/profile/versions', (c) => {
  const domain = domainFromParam(c);
  try { return c.json(listVersions(domain)); } catch { return c.json([]); }
});

profileActivationRoutes.post('/profile-versions', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const domain = (body.domain ?? '').toString().toLowerCase().replace(/^www\./, '').trim();
  if (!domain) return c.json({ error: 'domain required' }, 400);
  if (!body.selectors) return c.json({ error: 'selectors required' }, 400);
  const v = createVersion({
    domain,
    selectors: body.selectors as Record<string, unknown>,
    runtime: body.runtime ?? 'rendered',
    sampleIds: (body.sampleIds ?? []) as string[],
    artifactHashes: ((body.artifactHashes ?? []) as string[]).slice().sort(),
    validationSummary: body.validationSummary ?? {},
    provenance: body.provenance ?? { provider: 'client', model: 'manual', configId: 'manual' },
    approver: body.approver ?? 'operator',
    reason: body.reason ?? 'save',
  });
  return c.json(v, 201);
});

// Version-bound explicit image-review action (issue #198 follow-up): the
// operator confirms they reviewed the image previews for the version's
// confirmed samples. The ONLY post-creation writer of
// `validationSummary.imageRuleOk` — default false/absent stays blocked at
// the activation gate, and matrix re-runs preserve (never fabricate) it.
profileActivationRoutes.post('/domains/:domain/profile/versions/:versionId/image-review', async (c) => {
  const domain = domainFromParam(c);
  const versionId = c.req.param('versionId') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as { reviewed?: unknown; approver?: unknown };
  if (typeof body.reviewed !== 'boolean') return c.json({ error: 'reviewed (boolean) required' }, 400);
  const lookup = requireDomainVersion(c, domain, versionId);
  if (lookup.error) return lookup.error;
  const approver = typeof body.approver === 'string' && body.approver.trim() ? body.approver.trim() : undefined;
  const next = attestVersionImageReview(versionId, body.reviewed, approver ? { approver } : undefined);
  if (!next) return c.json({ error: 'version not found' }, 404);
  return c.json(next);
});

profileActivationRoutes.post('/domains/:domain/profile/activate', async (c) => {
  const domain = domainFromParam(c);
  const body = (await c.req.json().catch(() => ({}))) as { versionId?: string };
  const versionId = body.versionId;
  if (!versionId) return c.json({ error: 'versionId required' }, 400);
  const lookup = requireDomainVersion(c, domain, versionId);
  if (lookup.error) return lookup.error;
  const version = lookup.version;
  // Issue #214: health inputs are assembled exactly once, in the shared
  // candidate evaluator (same definition the release path evaluates the
  // active version against). The candidate is NOT required to be active.
  const verdict = evaluateCandidateVersionHealth(domain, versionId);
  const gate = verdict.gate;
  if (!verdict.healthy || !gate?.allowed) {
    return c.json({ allowed: false, blockReason: gate?.blockReason ?? verdict.reason, reviseAction: gate?.reviseAction ?? null, reason: gate?.reason ?? verdict.reason }, 409);
  }
  const profile = profileFromVersion(version);
  getDb().transaction(() => {
    upsertProfile(domain, profile);
    setActiveVersion(domain, versionId);
  })();
  // deterministic release: parked setup_required_profile + profile-blocked failed items.
  const released = releaseParkedSetupRows(domain) + await sweepBlockedExtractionItems(domain);
  return c.json({ allowed: true, activeVersionId: versionId, released });
});
