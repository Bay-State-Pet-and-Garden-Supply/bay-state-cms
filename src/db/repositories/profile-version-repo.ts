// story: e07s01 — transactional immutable versions (SQLite, not Maps)
import { randomUUID } from 'node:crypto';
import { ExtractorProfileSchema } from '../../shared/schemas/onboarding';
import type { ExtractorProfile } from './extractor-profile-repo';

// Lazy connection helpers — avoid top-level bun:sqlite import under vitest node env
function getConnectionHelpers(): { getDb: () => any; isDbInitialized: () => boolean } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../connection');
  } catch {
    return null;
  }
}
function getDbSafe(): any {
  const h = getConnectionHelpers();
  if (!h) throw new Error('DB not available');
  return h.getDb();
}
function isDbInitializedSafe(): boolean {
  const h = getConnectionHelpers();
  if (!h) return false;
  try { return h.isDbInitialized(); } catch { return false; }
}

export interface ProfileVersion {
  id: string;
  domain: string;
  version: number;
  selectors: Record<string, unknown>;
  runtime: string;
  sampleIds: string[];
  artifactHashes: string[];
  validationSummary: Record<string, unknown>;
  provenance: { provider: string; model: string; configId: string };
  approver: string;
  reason: string;
  createdAt: string;
}

export function profileFromVersion(version: ProfileVersion): ExtractorProfile {
  const selectors = version.selectors;
  return {
    ...ExtractorProfileSchema.parse({
      ...selectors,
      titleSelector: selectors.titleSelector ?? selectors.title_selector,
      priceSelector: selectors.priceSelector ?? selectors.price_selector,
      descriptionSelector: selectors.descriptionSelector ?? selectors.description_selector,
      brandSelector: selectors.brandSelector ?? selectors.brand_selector,
      imagesSelector: selectors.imagesSelector ?? selectors.images_selector ?? selectors.imageSelector ?? selectors.image_selector,
      titleOptionalSelectors: selectors.titleOptionalSelectors ?? selectors.title_optional_selectors,
      customSelectors: selectors.customSelectors ?? selectors.custom_selectors,
      sitemapProductUrlPattern: selectors.sitemapProductUrlPattern ?? selectors.sitemap_product_url_pattern,
      id: version.id,
      domain: version.domain,
      runtime: version.runtime,
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
      version: version.version,
    }),
  };
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

function rowToVersion(row: Record<string, unknown>): ProfileVersion {
  return {
    id: row.id as string,
    domain: row.domain as string,
    version: row.version as number,
    selectors: JSON.parse(row.selectors as string),
    runtime: row.runtime as string,
    sampleIds: JSON.parse(row.sample_ids as string),
    artifactHashes: JSON.parse(row.artifact_hashes as string) as string[],
    validationSummary: JSON.parse(row.validation_summary as string),
    provenance: JSON.parse(row.provenance as string),
    approver: row.approver as string,
    reason: row.reason as string,
    createdAt: row.created_at as string,
  };
}

// Fallback in-memory maps for environments without DB (vitest without initDb)
const fallbackIds = new Map<string, ProfileVersion>();
const fallbackDomain = new Map<string, ProfileVersion[]>();
const fallbackActive = new Map<string, string>();

function useFallback(): boolean {
  return !isDbInitializedSafe();
}

export function createVersion(input: {
  domain: string;
  selectors: Record<string, unknown>;
  runtime: string;
  sampleIds: string[];
  artifactHashes: string[];
  validationSummary: Record<string, unknown>;
  provenance: { provider: string; model: string; configId: string };
  approver: string;
  reason: string;
}): ProfileVersion {
  const domain = normalizeDomain(input.domain);
  if (useFallback()) {
    const list = fallbackDomain.get(domain) ?? [];
    const version: ProfileVersion = {
      id: randomUUID(),
      domain,
      version: list.length + 1,
      selectors: input.selectors,
      runtime: input.runtime,
      sampleIds: input.sampleIds,
      artifactHashes: input.artifactHashes,
      validationSummary: input.validationSummary,
      provenance: input.provenance,
      approver: input.approver,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    fallbackIds.set(version.id, version);
    list.push(version);
    fallbackDomain.set(domain, list);
    return version;
  }
  const db = getDbSafe();
  let version: ProfileVersion | null = null;
  const tx = db.transaction(() => {
    const existing = db
      .query('SELECT MAX(version) as m FROM profile_versions WHERE domain = ?')
      .get(domain) as { m: number | null } | undefined;
    const nextVersion = (existing?.m ?? 0) + 1;
    version = {
      id: randomUUID(),
      domain,
      version: nextVersion,
      selectors: input.selectors,
      runtime: input.runtime,
      sampleIds: input.sampleIds,
      artifactHashes: [...input.artifactHashes].sort(),
      validationSummary: input.validationSummary,
      provenance: input.provenance,
      approver: input.approver,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    } as ProfileVersion;
    db.query(
      `INSERT INTO profile_versions (id, domain, version, selectors, runtime, sample_ids, artifact_hashes, validation_summary, provenance, approver, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      version.id,
      version.domain,
      version.version,
      JSON.stringify(version.selectors),
      version.runtime,
      JSON.stringify(version.sampleIds),
      JSON.stringify(version.artifactHashes),
      JSON.stringify(version.validationSummary),
      JSON.stringify(version.provenance),
      version.approver,
      version.reason,
      version.createdAt,
    );
  });
  tx();
  return version!;
}

export function updateVersionEvidence(id: string, input: { sampleIds?: string[]; artifactHashes?: string[]; validationSummary?: Record<string, unknown> }): void {
  if (useFallback()) {
    const v = fallbackIds.get(id);
    if (v) {
      if (input.sampleIds) v.sampleIds = input.sampleIds;
      if (input.artifactHashes) v.artifactHashes = [...input.artifactHashes].sort();
      if (input.validationSummary) v.validationSummary = input.validationSummary;
    }
    return;
  }
  const db = getDbSafe();
  const existing = getVersionById(id);
  if (!existing) return;
  const sampleIds = input.sampleIds ?? existing.sampleIds;
  const artifactHashes = (input.artifactHashes ?? existing.artifactHashes).slice().sort();
  const validationSummary = input.validationSummary ?? existing.validationSummary;
  db.query(
    `UPDATE profile_versions SET sample_ids = ?, artifact_hashes = ?, validation_summary = ? WHERE id = ?`
  ).run(
    JSON.stringify(sampleIds),
    JSON.stringify(artifactHashes),
    JSON.stringify(validationSummary),
    id
  );
}

export function getVersionById(id: string): ProfileVersion | null {
  if (useFallback()) return fallbackIds.get(id) ?? null;
  const db = getDbSafe();
  const row = db.query('SELECT * FROM profile_versions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToVersion(row);
}

export function listVersions(domain: string): ProfileVersion[] {
  const key = normalizeDomain(domain);
  if (useFallback()) return [...(fallbackDomain.get(key) ?? [])].sort((a, b) => a.version - b.version);
  const db = getDbSafe();
  const rows = db
    .query('SELECT * FROM profile_versions WHERE domain = ? ORDER BY version ASC')
    .all(key) as Record<string, unknown>[];
  return rows.map(rowToVersion);
}

export function getActiveVersion(domain: string): ProfileVersion | null {
  const key = normalizeDomain(domain);
  if (useFallback()) {
    const id = fallbackActive.get(key);
    if (!id) return null;
    return fallbackIds.get(id) ?? null;
  }
  const db = getDbSafe();
  const active = db.query('SELECT active_version_id FROM profile_active WHERE domain = ?').get(key) as
    | { active_version_id: string | null }
    | undefined;
  if (!active?.active_version_id) return null;
  return getVersionById(active.active_version_id);
}

export function setActiveVersion(domain: string, id: string): void {
  const key = normalizeDomain(domain);
  if (useFallback()) {
    const v = fallbackIds.get(id);
    if (!v || v.domain !== key) throw new Error(`Version ${id} not found for domain ${domain}`);
    fallbackActive.set(key, id);
    return;
  }
  const db = getDbSafe();
  const v = getVersionById(id);
  if (!v || v.domain !== key) throw new Error(`Version ${id} not found for domain ${domain}`);
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO profile_active (domain, active_version_id) VALUES (?, ?)
       ON CONFLICT(domain) DO UPDATE SET active_version_id = excluded.active_version_id`,
    ).run(key, id);
  });
  tx();
}

export function createAndActivateVersion(input: {
  domain: string;
  selectors: Record<string, unknown>;
  runtime: string;
  sampleIds: string[];
  artifactHashes: string[];
  validationSummary: Record<string, unknown>;
  provenance: { provider: string; model: string; configId: string };
  approver: string;
  reason: string;
}): ProfileVersion {
  const domain = normalizeDomain(input.domain);
  if (useFallback()) {
    const created = createVersion(input);
    setActiveVersion(domain, created.id);
    return created;
  }
  const db = getDbSafe();
  let version: ProfileVersion | null = null;
  const tx = db.transaction(() => {
    const existing = db.query('SELECT MAX(version) as m FROM profile_versions WHERE domain = ?').get(domain) as { m: number | null } | undefined;
    const nextVersion = (existing?.m ?? 0) + 1;
    version = {
      id: randomUUID(),
      domain,
      version: nextVersion,
      selectors: input.selectors,
      runtime: input.runtime,
      sampleIds: input.sampleIds,
      artifactHashes: [...input.artifactHashes].sort(),
      validationSummary: input.validationSummary,
      provenance: input.provenance,
      approver: input.approver,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    } as ProfileVersion;
    db.query(`INSERT INTO profile_versions (id, domain, version, selectors, runtime, sample_ids, artifact_hashes, validation_summary, provenance, approver, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      version!.id, version!.domain, version!.version, JSON.stringify(version!.selectors), version!.runtime, JSON.stringify(version!.sampleIds), JSON.stringify(version!.artifactHashes), JSON.stringify(version!.validationSummary), JSON.stringify(version!.provenance), version!.approver, version!.reason, version!.createdAt,
    );
    db.query(`INSERT INTO profile_active (domain, active_version_id) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET active_version_id = excluded.active_version_id`).run(domain, version!.id);
  });
  tx();
  return version!;
}

export function rollbackToVersion(domain: string, id: string): ProfileVersion | null {
  const key = normalizeDomain(domain);
  if (useFallback()) {
    const v = fallbackIds.get(id);
    if (!v || v.domain !== key) return null;
    fallbackActive.set(key, id);
    return v;
  }
  const db = getDbSafe();
  const v = getVersionById(id);
  if (!v || v.domain !== key) return null;
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO profile_active (domain, active_version_id) VALUES (?, ?)
       ON CONFLICT(domain) DO UPDATE SET active_version_id = excluded.active_version_id`,
    ).run(key, id);
  });
  tx();
  return v;
}

export function migrateLegacyProfile(input: { domain: string; selectors: Record<string, unknown> }): ProfileVersion {
  const v = createVersion({
    domain: input.domain,
    selectors: input.selectors,
    runtime: 'rendered',
    sampleIds: [],
    artifactHashes: [],
    validationSummary: { legacy: true },
    provenance: { provider: 'legacy-migration', model: 'migrate', configId: 'legacy' },
    approver: 'system',
    reason: 'legacy-migration',
  });
  return v;
}

export function getVersionState(domain: string): string {
  const key = normalizeDomain(domain);
  if (useFallback()) {
    const active = fallbackActive.get(key);
    if (active) return 'Active';
    const list = fallbackDomain.get(key) ?? [];
    if (list.some(v => v.provenance.provider === 'legacy-migration')) return 'Degraded';
    return 'Not configured';
  }
  const active = getActiveVersion(key);
  if (active) return 'Active';
  const versions = listVersions(key);
  if (versions.some(v => v.provenance.provider === 'legacy-migration')) return 'Degraded';
  return 'Not configured';
}

export function resetProfileVersionsForTest(): void {
  if (useFallback()) {
    fallbackIds.clear();
    fallbackDomain.clear();
    fallbackActive.clear();
    return;
  }
  const db = getDbSafe();
  try {
    db.exec('DELETE FROM profile_active');
    db.exec('DELETE FROM profile_versions');
  } catch {
    fallbackIds.clear();
    fallbackDomain.clear();
    fallbackActive.clear();
  }
}
