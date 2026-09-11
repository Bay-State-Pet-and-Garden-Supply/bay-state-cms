import { getDb } from '../connection';
import { randomUUID, createHash } from 'node:crypto';
import {
  ApproveBrandStrategySchema,
  ApprovedBrandStrategySchema,
  type ApprovedBrandStrategy,
  type StrategySourceRef,
} from '../../shared/schemas/brand-strategy';
import { normalizeOfficialDomainInput } from '../../shared/schemas/brand-strategy-domain';
import { isKnownRetailerOrDistributorDomain } from '../../onboarding/discovery/retailer-domain-list';
import { isSupportedDistributorId } from '../../onboarding/sourcing/connector-registry';
import {
  findBrandSites,
  addBrandSiteMapping,
  removeBrandSiteMapping,
} from './brand-site-repo';
import {
  getDistributorById,
} from './distributor-repo';

/** Normalize brand identity independently of domain mappings (exact authority). */
export function normalizeBrandKey(brand: string): string {
  return brand.toLowerCase().trim();
}

interface StrategyRow {
  id: string;
  workspace_id: string;
  brand: string;
  normalized_brand: string;
  sources_json: string;
  revision: number;
  approved: number;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseSourcesJson(raw: string): StrategySourceRef[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StrategySourceRef[]) : [];
  } catch {
    return [];
  }
}

function mapRow(row: StrategyRow): ApprovedBrandStrategy {
  const safe = parseSourcesJson(row.sources_json);
  return ApprovedBrandStrategySchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    brand: row.brand,
    normalizedBrand: row.normalized_brand,
    sources: safe,
    revision: row.revision,
    approved: row.approved === 1,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function ensureTables(): void {
  // Defensive for minimal test DBs that run migrations selectively.
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS brand_sourcing_strategies (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, brand TEXT NOT NULL,
    normalized_brand TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT, approved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, normalized_brand))`);
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Builder slice B1 (issue #150, Amendment B1.1): deterministic configuration
 * token for guarded editing.
 *
 * Covers workspace id, exact normalized brand, and sorted brand mapping
 * identities/domains/authority metadata only. Advisory settings (aliases,
 * preferred distributors, sourcing policy) are retired and never enter the
 * token. The `brand-strategy-mapping-configuration-v2` hash domain
 * invalidates every pre-retirement token, even for an empty advisory set.
 * Excludes noisy mapping success counts and last-used timestamps; excludes
 * connector health so incidental availability changes never discard edits.
 */
export function computeBrandStrategyConfigurationToken(workspaceId: string, brand: string | null): string {
  const normalized = normalizeBrandKey(brand ?? '');
  const db = getDb();
  let mappings: Array<{ id: string; domain: string; url_pattern: string | null }>;
  try {
    mappings = (
      db.query(
        'SELECT id, domain, url_pattern FROM brand_sites WHERE brand_name = ? ORDER BY domain ASC, id ASC',
      ).all(normalized) as Array<{ id: string; domain: string; url_pattern: string | null }>
    );
  } catch {
    mappings = [];
  }
  return createHash('sha256')
    .update(JSON.stringify({ domain: 'brand-strategy-mapping-configuration-v2', workspaceId, normalized, mappings }))
    .digest('hex');
}

export interface StrategyApprovalInput {
  approved: boolean;
  revision: number;
  approvedAt: string | null;
  approvedBy: string | null;
  /** Stored display spelling of the brand (approval-only identity fallback). */
  brand?: string;
  sources?: StrategySourceRef[];
}

/**
 * Builder slice B1: all stored strategy rows for a workspace (approved or
 * not), keyed by exact normalized brand. Lets the read model include
 * approval-only brands instead of deriving only mapped/advisory brands.
 */
export function listStrategyApprovalInputs(workspaceId: string): Map<string, StrategyApprovalInput> {
  ensureTables();
  const db = getDb();
  const out = new Map<string, StrategyApprovalInput>();
  let rows: StrategyRow[];
  try {
    rows = db.query('SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ?').all(workspaceId) as StrategyRow[];
  } catch {
    return out;
  }
  for (const row of rows) {
    const parsedSources = parseSourcesJson(row.sources_json);
    out.set(row.normalized_brand, {
      approved: row.approved === 1,
      revision: row.revision,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      brand: row.brand,
      sources: parsedSources,
    });
  }
  return out;
}

export function getApprovedBrandStrategy(workspaceId: string, brand: string | null): ApprovedBrandStrategy | null {
  if (!brand || !brand.trim()) return null;
  ensureTables();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
  ).get(workspaceId, normalizeBrandKey(brand)) as StrategyRow | undefined;
  if (!row || row.approved !== 1) return null;
  return mapRow(row);
}

/** Latest stored strategy row regardless of approval (for proposal/read flows). */
export function getBrandStrategyRow(workspaceId: string, brand: string | null): ApprovedBrandStrategy | null {
  if (!brand || !brand.trim()) return null;
  ensureTables();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
  ).get(workspaceId, normalizeBrandKey(brand)) as StrategyRow | undefined;
  return row ? mapRow(row) : null;
}

export interface SaveBrandStrategyInput {
  brand: string;
  sources: StrategySourceRef[];
  /** REQUIRED: 0 matches only the absent-row case. Missing guard never writes. */
  expectedRevision: number;
  configuration?: {
    officialDomains: string[];
  };
  expectedConfigurationToken?: string;
  approvedBy?: string;
}

function canonicalizeSources(sources: StrategySourceRef[]): StrategySourceRef[] {
  const out: StrategySourceRef[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (s.kind === 'distributor_record') {
      if (s.domain !== undefined) throw new Error('Invalid brand strategy approval: distributor_record sources must not carry domain');
      const id = (s.distributorId ?? '').trim();
      if (!id) throw new Error('Invalid brand strategy approval: distributor_record sources require distributorId');
      const key = `distributor_record:${id.toLowerCase()}`;
      if (seen.has(key)) throw new Error('Invalid brand strategy approval: duplicate source references');
      seen.add(key);
      out.push({ kind: 'distributor_record', distributorId: id });
    } else {
      if (s.distributorId !== undefined) throw new Error('Invalid brand strategy approval: official_page sources must not carry distributorId');
      const domain = (s.domain ?? '').toLowerCase().replace(/^www\./, '').trim();
      if (!domain) throw new Error('Invalid brand strategy approval: official_page sources require domain');
      const key = `official_page:${domain}`;
      if (seen.has(key)) throw new Error('Invalid brand strategy approval: duplicate source references');
      seen.add(key);
      out.push({ kind: 'official_page', domain });
    }
  }
  return out;
}

/**
 * Guarded atomic Save — the sole writer for brand strategies
 * (Amendment B1, superseded in part by B1.1 / issue #150).
 *
 * Each accepted explicit Save creates exactly one new approved revision,
 * including identical-source and mapping-only Saves. Mapping deltas and the
 * approval commit together; any stale/validation/database failure rolls
 * both back. Viewing, generating, or editing a proposal never writes.
 */
export function saveBrandStrategy(workspaceId: string, input: SaveBrandStrategyInput): ApprovedBrandStrategy {
  const parsed = ApproveBrandStrategySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid brand strategy approval: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  ensureTables();
  const db = getDb();
  const displayBrand = parsed.data.brand.trim();
  // Defense in depth (schema already trims): an empty identity must fail
  // closed as 400, never persist normalized_brand="" (review-loop R1 P0-1).
  if (!displayBrand) {
    throw new Error('Invalid brand strategy approval: brand must be nonblank');
  }
  const normalized = normalizeBrandKey(displayBrand);
  const now = new Date().toISOString();
  const canonicalSources = canonicalizeSources(parsed.data.sources);

  const run = db.transaction(() => {
    const existing = db.query(
      'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
    ).get(workspaceId, normalized) as StrategyRow | undefined;
    const currentRevision = existing?.revision ?? 0;
    if (parsed.data.expectedRevision !== currentRevision) {
      throw codedError(
        'stale_revision',
        `stale_revision: expected ${parsed.data.expectedRevision}, stored ${currentRevision}`,
      );
    }

    // Configuration delta (brand-scoped only — never whole-domain).
    if (parsed.data.configuration !== undefined) {
      const currentToken = computeBrandStrategyConfigurationToken(workspaceId, normalized);
      if (parsed.data.expectedConfigurationToken !== currentToken) {
        throw codedError('stale_configuration', 'stale_configuration: brand mappings or preferences changed since read');
      }
      const requestedDomains: string[] = [];
      const seenDomains = new Set<string>();
      for (const raw of parsed.data.configuration.officialDomains) {
        const norm = normalizeOfficialDomainInput(raw);
        if (!norm) {
          throw new Error(`Invalid brand strategy approval: official domain '${String(raw).slice(0, 80)}' is not an acceptable hostname`);
        }
        if (seenDomains.has(norm)) {
          throw new Error('Invalid brand strategy approval: duplicate official domains');
        }
        seenDomains.add(norm);
        requestedDomains.push(norm);
      }
      const currentPairs = findBrandSites(normalized);
      const currentDomains = new Set(currentPairs.map((p) => p.domain.toLowerCase().replace(/^www\./, '').trim()));
      const requestedSet = new Set(requestedDomains);
      // Removal ownership: every removed domain must belong to this brand.
      for (const domain of currentDomains) {
        if (!requestedSet.has(domain)) {
          const owned = currentPairs.some(
            (p) => p.domain.toLowerCase().replace(/^www\./, '').trim() === domain,
          );
          if (!owned) throw codedError('stale_configuration', 'stale_configuration: brand mapping changed since read');
          removeBrandSiteMapping(normalized, domain);
        }
      }
      for (const domain of requestedDomains) {
        if (!currentDomains.has(domain)) addBrandSiteMapping(normalized, domain);
      }
    }

    // Final source validation against final mappings + known distributors.
    const finalDomains = new Set(
      findBrandSites(normalized).map((p) => p.domain.toLowerCase().replace(/^www\./, '').trim()),
    );
    for (const s of canonicalSources) {
      if (s.kind === 'official_page') {
        const domain = s.domain as string;
        if (!finalDomains.has(domain)) {
          throw new Error(`Invalid brand strategy approval: official domain '${domain}' is not mapped for this brand`);
        }
        if (isKnownRetailerOrDistributorDomain(domain)) {
          throw new Error(`Invalid brand strategy approval: '${domain}' is a known retailer/distributor host, not an official brand domain`);
        }
      } else {
        const id = s.distributorId as string;
        if (!getDistributorById(id) && !isSupportedDistributorId(id)) {
          throw new Error(`Invalid brand strategy approval: unknown distributor '${id}'`);
        }
      }
    }

    const sourcesJson = JSON.stringify(canonicalSources);
    if (existing) {
      const nextRevision = existing.revision + 1;
      const res = db.query(
        `UPDATE brand_sourcing_strategies SET brand = ?, sources_json = ?, revision = ?,
         approved = 1, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ? AND revision = ?`,
      ).run(displayBrand, sourcesJson, nextRevision, now, parsed.data.approvedBy ?? null, now, existing.id, existing.revision);
      if (res.changes === 0) {
        throw codedError('stale_revision', `stale_revision: brand strategy for '${displayBrand}' changed since read`);
      }
    } else {
      const id = `bss_${randomUUID().slice(0, 8)}`;
      try {
        db.query(`INSERT INTO brand_sourcing_strategies
          (id, workspace_id, brand, normalized_brand, sources_json, revision, approved, approved_at, approved_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`)
          .run(id, workspaceId, displayBrand, normalized, sourcesJson, now, parsed.data.approvedBy ?? null, now, now);
      } catch (err) {
        if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
          throw codedError('stale_revision', `stale_revision: brand strategy for '${displayBrand}' was created concurrently`);
        }
        throw err;
      }
    }
  });

  // The transaction rolls back on any throw above; a successful return
  // means mappings and approval committed together.
  run();
  return getBrandStrategyRow(workspaceId, displayBrand)!;
}

/**
 * Compatibility seam (pre-builder callers): source-only approval through the
 * same guarded atomic path. `expectedRevision` is required — callers without
 * a guard must read the current revision first instead of writing unguarded.
 */
export function approveBrandStrategy(
  workspaceId: string,
  input: { brand: string; sources: StrategySourceRef[]; expectedRevision?: number; approvedBy?: string },
): ApprovedBrandStrategy {
  if (input.expectedRevision === undefined) {
    throw new Error('Invalid brand strategy approval: expectedRevision is required');
  }
  return saveBrandStrategy(workspaceId, {
    brand: input.brand,
    sources: input.sources,
    expectedRevision: input.expectedRevision,
    approvedBy: input.approvedBy,
  });
}

export function listApprovedBrandStrategies(workspaceId: string): ApprovedBrandStrategy[] {
  ensureTables();
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND approved = 1 ORDER BY brand ASC',
  ).all(workspaceId) as StrategyRow[];
  return rows.map(mapRow);
}
