// story: e07s04 — POST /api/domains/:domain/profile/activate (cluster-aware fail-closed, deterministic release)
import { Hono } from 'hono';
import { getVersionById, setActiveVersion, createVersion, listVersions } from '../../db/repositories/profile-version-repo';
import { getMatrixResult } from '../../onboarding/profile-test-matrix';
import { evaluateGate } from '../../onboarding/profile-activation-gate';
import { getSuiteSuggestion } from '../../onboarding/suite-suggestion-service';
import { templateAwarePrefix } from '../../onboarding/template-clustering';
import { getDb } from '../../db/connection';
import { encodeForStorage, readStorageVersion } from '../../db/repositories/onboarding-stage-vocabulary-repo';
import { hasValidWaiver } from '../../db/repositories/waiver-repo';

export const profileActivationRoutes = new Hono();

profileActivationRoutes.get('/domains/:domain/profile/versions', (c) => {
  const domain = (c.req.param('domain') ?? '').toLowerCase().replace(/^www\./, '').trim();
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

function serverConfirmedCount(domain: string): number {
  try {
    const db = getDb();
    const row = db.query('SELECT COUNT(*) as c FROM domain_representative_suite WHERE domain = ?').get(domain) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch { return 0; }
}

function serverSampleIds(domain: string): string[] {
  try {
    const db = getDb();
    const rows = db.query('SELECT url FROM domain_representative_suite WHERE domain = ?').all(domain) as { url: string }[];
    return rows.map(r => r.url);
  } catch { return []; }
}

profileActivationRoutes.post('/domains/:domain/profile/activate', async (c) => {
  const domain = (c.req.param('domain') ?? '').toLowerCase().replace(/^www\./, '').trim();
  const body = (await c.req.json().catch(() => ({}))) as { versionId?: string };
  const versionId = body.versionId;
  if (!versionId) return c.json({ error: 'versionId required' }, 400);
  const version = getVersionById(versionId);
  if (!version) return c.json({ error: 'version not found' }, 404);
  if (version.domain !== domain) return c.json({ error: 'version domain mismatch' }, 400);
  const matrix = getMatrixResult(domain, versionId);
  const sampleUrls = serverSampleIds(domain);
  const clusterIds: string[] = (() => {
    try {
      const confirmedPrefixes = new Set(sampleUrls.map(u => templateAwarePrefix(u)));
      const suggestion = getSuiteSuggestion(domain);
      const matched = suggestion.clusters.map(cl => cl.prefix).filter(p => confirmedPrefixes.has(p));
      if (matched.length > 0) return matched;
      return Array.from(confirmedPrefixes);
    } catch (_e) {
      return Array.from(new Set(sampleUrls.map(u => templateAwarePrefix(u))));
    }
  })();
  const requiredResults = matrix
    ? matrix.rows.flatMap(r => r.cells.map(cell => ({ field: cell.field, success: cell.success, provenance: cell.provenance, artifactHash: cell.artifactHash, expected: cell.expected, extracted: cell.extracted })))
    : [];
  const wrongProduct = matrix ? matrix.rows.some(r => r.cells.some(c => (c.failureReason ?? '').includes('wrong_product'))) : false;
  const wrongVariant = matrix ? matrix.rows.some(r => r.cells.some(c => (c.failureReason ?? '').includes('wrong_variant'))) : false;
  const waiver = hasValidWaiver(domain);
  const confirmedCount = serverConfirmedCount(domain);
  const imageRuleOk = (version.validationSummary as any)?.imageRuleOk as boolean | undefined;
  const gate = evaluateGate({
    requiredResults: requiredResults as any,
    wrongProduct,
    wrongVariant,
    waiver,
    confirmedCount,
    imageRuleOk,
    matrixResult: matrix,
    expectedArtifactHashes: version.artifactHashes,
    sampleIds: serverSampleIds(domain),
    clusterIds,
  } as any);
  if (!gate.allowed) {
    return c.json({ allowed: false, blockReason: gate.blockReason, reviseAction: gate.reviseAction, reason: gate.reason }, 409);
  }
  setActiveVersion(domain, versionId);
  // deterministic release: parked setup_required_profile + profile-blocked failed items
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
  // also sweep profile-blocked failed extraction items via canonical release (workspace-scoped)
  try {
    const { getCurrentWorkspace } = await import('../../server/services/workspace-service');
    const ws = (getCurrentWorkspace as any)();
    if (ws?.id) {
      const { releaseDomainExtractionItems } = await import('../../onboarding/domain-release');
      const res = (releaseDomainExtractionItems as any)(ws.id, domain, { releaseAllBlocked: true });
      released += (res.releasedIds?.length ?? 0);
    }
  } catch (_err) {
    // Extraction items release non-fatal
  }
  return c.json({ allowed: true, activeVersionId: versionId, released });
});
