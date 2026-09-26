import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { canonicalJsonFileString, canonicalJsonStringify, hashCanonicalJson, isSha256Hex, sha256Hex } from '../../shared/stable-id';
import { buildFocusedFiles } from '../../classification/config-generator';
import type { ClassificationConfigBundleV2 } from '../../shared/schemas/classification';
import type {
  ClassificationConfig,
  ProductTypeConfig,
  ProductAttributeConfig,
  AttributeProfileConfig,
  AttributeMappingConfig,
  GuidanceConfig,
  ModelPolicyConfig,
  DataSharingConfig,
  BrandConfig,
} from '../../shared/types';

const now = () => new Date().toISOString();

// ─── Config File Metadata ───────────────────────────────────────────────────────

export interface ConfigFileMeta {
  workspaceId: string;
  fileName: string;
  schemaVersion: number;
  contentHash: string;
  contentJson: string;
  updatedAt: string;
}

// fallow-ignore-next-line unused-export — config-store diagnostics consume this in Milestone 3
export function listConfigFiles(workspaceId: string): ConfigFileMeta[] {
  const rows = getDb()
    .query('SELECT * FROM classification_config_files WHERE workspace_id = ? ORDER BY file_name')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    workspaceId: String(r.workspace_id),
    fileName: String(r.file_name),
    schemaVersion: Number(r.schema_version),
    contentHash: String(r.content_hash),
    contentJson: String(r.content_json),
    updatedAt: String(r.updated_at),
  }));
}

/** Exact historical signed-decimal hash used by existing snapshot rows. */
export function computeLegacyConfigHash(config: ClassificationConfig): string {
  return legacySignedDecimalHash(JSON.stringify(config));
}

function legacySignedDecimalHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}

export function upsertConfigFile(workspaceId: string, fileName: string, schemaVersion: number, content: unknown): void {
  const json = canonicalJsonStringify(content);
  const hash = hashCanonicalJson(content);
  getDb().run(
    `INSERT INTO classification_config_files (workspace_id, file_name, schema_version, content_hash, content_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, file_name) DO UPDATE SET
       schema_version = EXCLUDED.schema_version,
       content_hash = EXCLUDED.content_hash,
       content_json = EXCLUDED.content_json,
       updated_at = EXCLUDED.updated_at`,
    [workspaceId, fileName, schemaVersion, hash, json, now()],
  );
}

// ─── Full Config Cache Sync ─────────────────────────────────────────────────────

/**
 * Mirrors a loaded ClassificationConfig into the SQLite cache tables.
 * Run after workspace load or after a config change.
 */
export function syncConfigToCache(workspaceId: string, config: ClassificationConfig): void {
  const db = getDb();
  const schemaVersion = (config as any).manifest?.schemaVersion ?? 1;
  const manifestValue = (config as any).manifest ?? { schemaVersion: 1 };

  db.transaction(() => {
    // Manifest
    upsertConfigFile(workspaceId, 'manifest.json', schemaVersion, manifestValue);

    // Product Types
    db.run('DELETE FROM classification_product_types WHERE workspace_id = ?', [workspaceId]);
    for (const pt of config.productTypes) {
      db.run(
        `INSERT INTO classification_product_types
         (workspace_id, id, name, description, attribute_profile_id, old_id_aliases_json, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          pt.id,
          pt.name,
          pt.description ?? null,
          pt.attributeProfileId ?? null,
          JSON.stringify(pt.oldIdAliases),
          hashCanonicalJson(pt),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'product-types.json', schemaVersion, config.productTypes);

    // Attributes
    db.run('DELETE FROM classification_attributes WHERE workspace_id = ?', [workspaceId]);
    for (const attr of config.attributes) {
      db.run(
        `INSERT INTO classification_attributes
         (workspace_id, id, name, description, value_mode, canonical_unit, allowed_values_json,
          value_aliases_json, visual_evidence_eligibility, is_claim, is_composition_attribute,
          group_name, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          attr.id,
          attr.name,
          attr.description ?? null,
          attr.valueMode,
          attr.canonicalUnit ?? null,
          JSON.stringify(attr.allowedValues),
          JSON.stringify(attr.valueAliases),
          attr.visualEvidenceEligibility,
          attr.isClaim ? 1 : 0,
          attr.isCompositionAttribute ? 1 : 0,
          attr.group ?? null,
          hashCanonicalJson(attr),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'attributes.json', schemaVersion, config.attributes);

    // Attribute Profiles
    db.run('DELETE FROM classification_attribute_profiles WHERE workspace_id = ?', [workspaceId]);
    for (const profile of config.attributeProfiles) {
      db.run(
        `INSERT INTO classification_attribute_profiles
         (workspace_id, id, product_type_id, name, attributes_json, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          profile.id,
          profile.productTypeId,
          profile.name,
          JSON.stringify(profile.attributes),
          hashCanonicalJson(profile),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'attribute-profiles.json', schemaVersion, config.attributeProfiles);

    // Attribute Mappings
    db.run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ?', [workspaceId]);
    for (const mapping of config.attributeMappings) {
      db.run(
        `INSERT INTO classification_attribute_mappings
         (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale,
          config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          mapping.id,
          mapping.attributeId,
          mapping.catalogField,
          JSON.stringify(mapping.serialization),
          mapping.isStale ? 1 : 0,
          hashCanonicalJson(mapping),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'mappings.json', schemaVersion, config.attributeMappings);

    // Curation targets are file-backed stage settings. They do not need a
    // dedicated cache table because stages read them from the active config,
    // but tracking the file keeps config metadata/snapshots complete.
    upsertConfigFile(workspaceId, 'curation-targets.json', schemaVersion, config.curationTargets ?? []);

    // Guidance
    db.run('DELETE FROM classification_guidance WHERE workspace_id = ?', [workspaceId]);
    for (const g of config.guidance) {
      db.run(
        `INSERT INTO classification_guidance
         (workspace_id, id, scope_type, scope_id, structured_json, free_form,
          manual_review_requirement, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          g.id,
          g.scope,
          g.scopeId ?? null,
          JSON.stringify(g.structured),
          g.freeForm ?? null,
          g.manualReviewRequirement ? 1 : 0,
          hashCanonicalJson(g),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'guidance.json', schemaVersion, config.guidance);

    // Model Policy
    db.run(
      `INSERT INTO classification_model_policies (workspace_id, policy_json, config_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         policy_json = EXCLUDED.policy_json,
         config_hash = EXCLUDED.config_hash,
         updated_at = EXCLUDED.updated_at`,
      [workspaceId, canonicalJsonStringify(config.modelPolicy), hashCanonicalJson(config.modelPolicy), now()],
    );
    upsertConfigFile(workspaceId, 'model-policies.json', schemaVersion, config.modelPolicy);

    // Brands
    db.run('DELETE FROM classification_brands WHERE workspace_id = ?', [workspaceId]);
    for (const brand of config.brands) {
      db.run(
        `INSERT INTO classification_brands
         (workspace_id, id, name, aliases_json, old_id_aliases_json, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          brand.id,
          brand.name,
          JSON.stringify(brand.aliases),
          JSON.stringify(brand.oldIdAliases),
          hashCanonicalJson(brand),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'brands.json', schemaVersion, config.brands);

    // Data Sharing Policy
    db.run(
      `INSERT INTO classification_data_sharing_policies (workspace_id, policy_json, config_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         policy_json = EXCLUDED.policy_json,
         config_hash = EXCLUDED.config_hash,
         updated_at = EXCLUDED.updated_at`,
      [workspaceId, canonicalJsonStringify(config.dataSharing), hashCanonicalJson(config.dataSharing), now()],
    );
    upsertConfigFile(workspaceId, 'data-sharing.json', schemaVersion, config.dataSharing);
  })();
}

/**
 * Update classification model policy and data sharing tables and files in SQLite cache.
 */
export function syncPolicyToCache(workspaceId: string, modelPolicy: unknown, dataSharing: unknown): void {
  const db = getDb();
  db.run(
    `INSERT INTO classification_model_policies (workspace_id, policy_json, config_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       policy_json = EXCLUDED.policy_json,
       config_hash = EXCLUDED.config_hash,
       updated_at = EXCLUDED.updated_at`,
    [workspaceId, canonicalJsonStringify(modelPolicy), hashCanonicalJson(modelPolicy), now()],
  );
  upsertConfigFile(workspaceId, 'model-policies.json', 2, modelPolicy);

  db.run(
    `INSERT INTO classification_data_sharing_policies (workspace_id, policy_json, config_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       policy_json = EXCLUDED.policy_json,
       config_hash = EXCLUDED.config_hash,
       updated_at = EXCLUDED.updated_at`,
    [workspaceId, canonicalJsonStringify(dataSharing), hashCanonicalJson(dataSharing), now()],
  );
  upsertConfigFile(workspaceId, 'data-sharing.json', 2, dataSharing);
}

// ─── Config Snapshot (for reproducible runs) ────────────────────────────────────

/**
 * Compute a stable hash of the classification config without any DB side effects.
 * Used for drift detection in read-only contexts (GET routes).
 */
export function computeConfigHash(config: ClassificationConfig): string {
  return hashCanonicalJson(config);
}

/**
 * Compare a validated config with either a canonical SHA-256 snapshot or the
 * exact signed-decimal legacy algorithm. Unknown hash formats fail closed.
 * Historical rows are never rewritten by this compatibility check.
 */
export function configHashMatches(config: ClassificationConfig, storedHash: string): boolean {
  if (isSha256Hex(storedHash)) return computeConfigHash(config) === storedHash;
  if (/^-?(?:0|[1-9]\d{0,9})$/.test(storedHash)) {
    return computeLegacyConfigHash(config) === storedHash;
  }
  return false;
}

/**
 * Creates a point-in-time snapshot of the active config for use in a classification run.
 */
export function createConfigSnapshot(workspaceId: string, config: ClassificationConfig, sourceCommit?: string): { id: string; hash: string } {
  const snapshotHash = computeConfigHash(config);

  // Return existing snapshot if identical config was already captured
  const existing = getDb()
    .query('SELECT id FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?')
    .get(workspaceId, snapshotHash) as Record<string, any> | undefined;
  if (existing) return { id: String(existing.id), hash: snapshotHash };

  const id = randomUUID();
  getDb().run(
    `INSERT INTO classification_config_snapshots
     (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version,
      source_commit, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, snapshotHash, config.manifest.schemaVersion, config.manifest.compatibilityVersion, sourceCommit ?? null, canonicalJsonStringify(config), now()],
  );
  return { id, hash: snapshotHash };
}

// ─── Read back from cache ──────────────────────────────────────────────────────

export function getCachedProductTypes(workspaceId: string): ProductTypeConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_product_types WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    attributeProfileId: r.attribute_profile_id ? String(r.attribute_profile_id) : null,
    oldIdAliases: r.old_id_aliases_json ? JSON.parse(String(r.old_id_aliases_json)) : [],
  }));
}

// fallow-ignore-next-line unused-export — used by tests
export function getCachedAttributes(workspaceId: string): ProductAttributeConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_attributes WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    valueMode: String(r.value_mode) as ProductAttributeConfig['valueMode'],
    canonicalUnit: r.canonical_unit ? String(r.canonical_unit) : null,
    allowedValues: r.allowed_values_json ? JSON.parse(String(r.allowed_values_json)) : [],
    valueAliases: r.value_aliases_json ? JSON.parse(String(r.value_aliases_json)) : [],
    visualEvidenceEligibility: String(r.visual_evidence_eligibility) as ProductAttributeConfig['visualEvidenceEligibility'],
    isClaim: Number(r.is_claim) === 1,
    isCompositionAttribute: Number(r.is_composition_attribute) === 1,
    group: r.group_name ? String(r.group_name) : null,
  }));
}

export function getCachedAttributeProfiles(workspaceId: string): AttributeProfileConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_attribute_profiles WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    productTypeId: String(r.product_type_id),
    name: String(r.name),
    attributes: r.attributes_json ? JSON.parse(String(r.attributes_json)) : [],
  }));
}

export function getCachedAttributeMappings(workspaceId: string): AttributeMappingConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_attribute_mappings WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    attributeId: String(r.attribute_id),
    catalogField: String(r.catalog_field),
    serialization: r.serialization_json ? JSON.parse(String(r.serialization_json)) : { format: 'direct', separator: ', ', prefix: '', suffix: '' },
    isStale: Number(r.is_stale) === 1,
  }));
}

// fallow-ignore-next-line unused-export — runtime snapshot builder consumes this in Milestone 4
export function getCachedGuidance(workspaceId: string): GuidanceConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_guidance WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    scope: String(r.scope_type) as GuidanceConfig['scope'],
    scopeId: r.scope_id ? String(r.scope_id) : null,
    structured: r.structured_json ? JSON.parse(String(r.structured_json)) : {},
    freeForm: r.free_form ? String(r.free_form) : null,
    manualReviewRequirement: Number(r.manual_review_requirement) === 1,
  }));
}

// fallow-ignore-next-line unused-export — runtime snapshot builder consumes this in Milestone 4
export function getCachedModelPolicy(workspaceId: string): ModelPolicyConfig | null {
  const row = getDb()
    .query('SELECT * FROM classification_model_policies WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, any> | undefined;
  if (!row) return null;
  return JSON.parse(String(row.policy_json)) as ModelPolicyConfig;
}

export function getCachedBrands(workspaceId: string): BrandConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_brands WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    aliases: r.aliases_json ? JSON.parse(String(r.aliases_json)) : [],
    oldIdAliases: r.old_id_aliases_json ? JSON.parse(String(r.old_id_aliases_json)) : [],
  }));
}

export function getCachedDataSharingPolicy(workspaceId: string): DataSharingConfig | null {
  const row = getDb()
    .query('SELECT * FROM classification_data_sharing_policies WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, any> | undefined;
  if (!row) return null;
  return JSON.parse(String(row.policy_json)) as DataSharingConfig;
}

// ─── V2 activation cache (config-store contract) ────────────────────────────────

const ACTIVE_CONFIG_HASH_KEY = (workspaceId: string) => `active_classification_config_hash:${workspaceId}`;

/**
 * Upsert the derived SQLite cache for a validated v2 activation atomically.
 * Mirrors the manifest plus every focused file with exact canonical bytes so
 * cache hashes equal the committed manifest file-versions, records the
 * point-in-time snapshot, and records the active bundle hash. The caller
 * (config-store) invokes this only after the active directory has been
 * atomically replaced and re-validated in active mode.
 */
export function upsertConfigSnapshot(
  workspaceId: string,
  bundle: ClassificationConfigBundleV2,
  sourceCommit: string | null = null,
): { id: string; hash: string } {
  const db = getDb();
  const hash = bundle.manifest.bundleHash;
  const existingId = getPersistedConfigSnapshotId(workspaceId, hash);
  const snapshotId = existingId ?? randomUUID();
  const focusedFiles = buildFocusedFiles(bundle);

  db.transaction(() => {
    const manifestContent = canonicalJsonFileString(bundle.manifest);
    db.run(
      `INSERT INTO classification_config_files (workspace_id, file_name, schema_version, content_hash, content_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, file_name) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         content_hash = EXCLUDED.content_hash,
         content_json = EXCLUDED.content_json,
         updated_at = EXCLUDED.updated_at`,
      [workspaceId, 'manifest.json', 2, sha256Hex(manifestContent), manifestContent, now()],
    );
    for (const [fileName, content] of Object.entries(focusedFiles)) {
      db.run(
        `INSERT INTO classification_config_files (workspace_id, file_name, schema_version, content_hash, content_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, file_name) DO UPDATE SET
           schema_version = EXCLUDED.schema_version,
           content_hash = EXCLUDED.content_hash,
           content_json = EXCLUDED.content_json,
           updated_at = EXCLUDED.updated_at`,
        [workspaceId, fileName, 2, sha256Hex(content), content, now()],
      );
    }
    db.run(
      `INSERT INTO classification_config_snapshots
       (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version, source_commit, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, snapshot_hash) DO UPDATE SET
         source_commit = EXCLUDED.source_commit,
         config_json = EXCLUDED.config_json,
         created_at = EXCLUDED.created_at`,
      [
        snapshotId,
        workspaceId,
        hash,
        bundle.manifest.schemaVersion,
        bundle.manifest.compatibilityVersion,
        sourceCommit,
        canonicalJsonStringify(bundle),
        now(),
      ],
    );
    db.run(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      [ACTIVE_CONFIG_HASH_KEY(workspaceId), hash],
    );
  })();
  return { id: snapshotId, hash };
}

/** Cached active v2 bundle SHA-256, or null when no v2 activation is recorded. */
export function getActiveConfigHash(workspaceId: string): string | null {
  const row = getDb()
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get(ACTIVE_CONFIG_HASH_KEY(workspaceId)) as { value: string } | undefined;
  return row ? String(row.value) : null;
}

/** Row id of a persisted config snapshot by exact hash, or null. */
export function getPersistedConfigSnapshotId(workspaceId: string, snapshotHash: string): string | null {
  const row = getDb()
    .query('SELECT id FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?')
    .get(workspaceId, snapshotHash) as { id: string } | undefined;
  return row ? String(row.id) : null;
}

export interface ConfigCacheFileState {
  fileName: string;
  schemaVersion: number;
  contentHash: string;
  contentJson: string;
}

export interface ConfigCacheState {
  activeHash: string | null;
  files: ConfigCacheFileState[];
}

/**
 * Capture the derived cache state before a v2 activation so a failed
 * Git commit can restore the previous cache transactionally.
 */
export function captureConfigCacheState(workspaceId: string): ConfigCacheState {
  const db = getDb();
  const files = db
    .query('SELECT file_name, schema_version, content_hash, content_json FROM classification_config_files WHERE workspace_id = ?')
    .all(workspaceId) as Array<Record<string, unknown>>;
  return {
    activeHash: getActiveConfigHash(workspaceId),
    files: files.map(row => ({
      fileName: String(row.file_name),
      schemaVersion: Number(row.schema_version),
      contentHash: String(row.content_hash),
      contentJson: String(row.content_json),
    })),
  };
}

/**
 * Restore the derived cache to a previously captured state and drop any
 * snapshot rows for the given bundle hash.
 */
export function restoreConfigCacheState(workspaceId: string, state: ConfigCacheState, removeSnapshotHash?: string): void {
  const db = getDb();
  db.transaction(() => {
    db.run('DELETE FROM classification_config_files WHERE workspace_id = ?', [workspaceId]);
    for (const file of state.files) {
      db.run(
        `INSERT INTO classification_config_files (workspace_id, file_name, schema_version, content_hash, content_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [workspaceId, file.fileName, file.schemaVersion, file.contentHash, file.contentJson, now()],
      );
    }
    if (removeSnapshotHash) {
      db.run('DELETE FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?', [workspaceId, removeSnapshotHash]);
    }
    if (state.activeHash === null) {
      db.run('DELETE FROM app_meta WHERE key = ?', [ACTIVE_CONFIG_HASH_KEY(workspaceId)]);
    } else {
      db.run(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
        [ACTIVE_CONFIG_HASH_KEY(workspaceId), state.activeHash],
      );
    }
  })();
}
