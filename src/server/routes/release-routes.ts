import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrentWorkspace } from '../services/workspace-service';
import {
  DEFAULT_TAXONOMY_REVISION,
  readWorkspaceState,
  writeWorkspaceState,
} from '../../classification/workspace-state';
import {
  assertReleaseValid,
  assertReleaseValidV4,
  assertReleaseValidV5,
  isValidReleaseId,
  ReleaseValidationError,
} from '../../classification/release-validation';
import { V4_TAXONOMY_REVISION, V5_TAXONOMY_REVISION } from '../../classification/release-compiler';
import { timingSafeCompare } from '../../shared/timing-safe';

/**
 * Taxonomy release status + sanctioned activation (P4 — plan section B.P4.3).
 *
 * GET /api/settings/taxonomy-release
 *   Read-only release/pin status for the Settings → Taxonomy Release card:
 *   the workspace's active revision, the default revision, whether the admin
 *   gate is enabled server-side (the client NEVER guesses — it renders the
 *   Activate action disabled unless this flag is true), and every available
 *   immutable release under src/classification/releases with its manifest
 *   counts and hash-validation status.
 *
 * POST /api/settings/taxonomy-release/pin   body: { revision }
 *   THE ONLY PRODUCTION WRITER of store/classification/state.json (grep-
 *   enforced single-writer rule, plan risk R3). Fail-closed gates in order:
 *     1. `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED` truthy — else 403
 *        `release_admin_disabled` (kill switch: unset ⇒ no flips anywhere).
 *     2. `BAYSTATE_CMS_API_TOKEN` present AND Authorization: Bearer matches —
 *        defense-in-depth re-check inside the route (the global middleware may
 *        evolve; this gate must not).
 *     3. The requested release MUST pass its full validator BEFORE any write;
 *        a failing validation leaves state.json untouched.
 *   Rollback is the same route with revision = bay-state-v3 (the v3 bundle is
 *   immutable forever and remains the rollback target, plan B.P4.5).
 */

const admin = new Hono();

/** Env kill-switch-style gate (default disabled). */
function releaseAdminEnabled(): boolean {
  const raw = process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED;
  if (raw === undefined || raw === '') return false;
  return ['1', 'true', 'on'].includes(raw.trim().toLowerCase());
}

// ─── Available-revision scan (cached) ─────────────────────────────────────────

interface AvailableRevision {
  revision: string;
  schemaVersion: number | null;
  lifecycle: string | null;
  counts: Record<string, number>;
  /** False when ANY manifest-hash finding fired (missing/mismatched file). */
  manifestHashesOk: boolean;
  errorCount: number;
  warningCount: number;
}

let cacheKey: string | null = null;
let cachedRevisions: AvailableRevision[] | null = null;

function releasesRoot(): string {
  // Same root resolveReleaseDir() uses inside release-validation.
  return path.resolve(__dirname, '..', '..', 'classification', 'releases');
}

function fingerprint(): string {
  const root = releasesRoot();
  if (!fs.existsSync(root)) return '';
  const parts: string[] = [];
  for (const entry of fs.readdirSync(root).sort()) {
    const manifestPath = path.join(root, entry, 'manifest.json');
    try {
      const stat = fs.statSync(manifestPath);
      parts.push(`${entry}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${entry}:missing`);
    }
  }
  return parts.join('|');
}

/** Validate one release directory read-only and summarize it for the card. */
function inspectRevision(revision: string): AvailableRevision | null {
  const dir = path.join(releasesRoot(), revision);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { revision, schemaVersion: null, lifecycle: null, counts: {}, manifestHashesOk: false, errorCount: 1, warningCount: 0 };
  }
  const schemaVersion = typeof manifest.schemaVersion === 'number' ? manifest.schemaVersion : null;
  try {
    const report =
      revision === V5_TAXONOMY_REVISION ? assertReleaseValidV5(revision)
        : schemaVersion === 3 ? assertReleaseValidV4(revision)
        : schemaVersion === 2 ? assertReleaseValid(revision)
          : null;
    if (!report) throw new Error('unsupported_release_schema');
    return {
      revision,
      schemaVersion,
      lifecycle: typeof manifest.lifecycle === 'string' ? manifest.lifecycle : null,
      counts: { ...report.counts },
      manifestHashesOk: !report.findings.some(finding => finding.code.startsWith('manifest_hash')),
      errorCount: report.findings.filter(finding => finding.severity === 'error').length,
      warningCount: report.findings.filter(finding => finding.severity === 'warning').length,
    };
  } catch (error) {
    const message = error instanceof ReleaseValidationError ? `${error.report.findings.length} findings` : String(error);
    console.warn(`[ReleaseRoutes] release "${revision}" failed validation: ${message}`);
    return {
      revision,
      schemaVersion,
      lifecycle: typeof manifest.lifecycle === 'string' ? manifest.lifecycle : null,
      counts: (manifest.counts as Record<string, number> | undefined) ?? {},
      manifestHashesOk: false,
      errorCount: 1,
      warningCount: 0,
    };
  }
}

function listAvailableRevisions(): AvailableRevision[] {
  const key = fingerprint();
  if (cachedRevisions && cacheKey === key) return cachedRevisions;
  const root = releasesRoot();
  const revisions: AvailableRevision[] = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root).sort()) {
      const inspected = inspectRevision(entry);
      if (inspected) revisions.push(inspected);
    }
  }
  cacheKey = key;
  cachedRevisions = revisions;
  return revisions;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

admin.get('/settings/taxonomy-release', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  let pin: ReturnType<typeof readWorkspaceState>;
  try {
    pin = readWorkspaceState(workspace.workspacePath); // malformed pin fails closed
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: 'invalid_workspace_state' }, 500);
  }
  return c.json({
    activeRevision: pin?.activeTaxonomyRevision ?? null,
    updatedAt: pin?.updatedAt ?? null,
    defaultRevision: DEFAULT_TAXONOMY_REVISION,
    v4Revision: V4_TAXONOMY_REVISION,
    v5Revision: V5_TAXONOMY_REVISION,
    adminEnabled: releaseAdminEnabled(),
    availableRevisions: listAvailableRevisions(),
  });
});

admin.post('/settings/taxonomy-release/pin', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  // Gate 1: admin env kill switch (default OFF → 403).
  if (!releaseAdminEnabled()) {
    return c.json(
      {
        error: 'Taxonomy release administration is disabled. Set BAYSTATE_CMS_RELEASE_ADMIN_ENABLED to allow pin changes.',
        code: 'release_admin_disabled',
      },
      403,
    );
  }

  // Gate 2: API token re-check (defense in depth; global middleware may change).
  const expectedToken = process.env.BAYSTATE_CMS_API_TOKEN;
  const provided = c.req.header('Authorization') ?? '';
  if (!expectedToken || !timingSafeCompare(provided, `Bearer ${expectedToken}`)) {
    return c.json({ error: 'Unauthorized. Provide a valid API token via Authorization: Bearer header.', code: 'invalid_api_token' }, 401);
  }

  let revision: unknown;
  try {
    ({ revision } = await c.req.json());
  } catch {
    return c.json({ error: 'Request body must be JSON.', code: 'invalid_body' }, 400);
  }
  if (typeof revision !== 'string' || !isValidReleaseId(revision)) {
    return c.json({ error: `Invalid revision slug "${String(revision)}".`, code: 'invalid_revision' }, 400);
  }

  // Gate 3: full validation BEFORE touching state.json (never partial writes).
  try {
    if (revision === V5_TAXONOMY_REVISION) {
      assertReleaseValidV5(revision);
    } else if (revision === V4_TAXONOMY_REVISION) {
      assertReleaseValidV4(revision);
    } else {
      assertReleaseValid(revision);
    }
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      return c.json(
        {
          error: `Release "${revision}" is invalid; pin unchanged.`,
          code: 'release_invalid',
          findings: error.report.findings,
        },
        422,
      );
    }
    return c.json({ error: `Unknown or unloadable revision "${revision}".`, code: 'unknown_revision' }, 400);
  }

  const state = {
    activeTaxonomyRevision: revision,
    updatedAt: new Date().toISOString(),
  } as const;
  writeWorkspaceState(workspace.workspacePath, state);
  console.log(`[ReleaseRoutes] workspace ${workspace.id} pinned to taxonomy release ${revision}`);
  return c.json({ success: true, activeRevision: state.activeTaxonomyRevision, updatedAt: state.updatedAt });
});

export default admin;
