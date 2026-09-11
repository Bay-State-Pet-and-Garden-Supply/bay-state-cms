import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import {
  DistributorSchema,
  DistributorConnectionSchema,
  DistributorCatalogSnapshotSchema,
  InsertDistributorConnectionSchema,
  UpdateDistributorConnectionSchema,
  type Distributor,
  type InsertDistributor,
  type DistributorConnection,
  type InsertDistributorConnection,
  type UpdateDistributorConnection,
  type DistributorCatalogSnapshot,
  DistributorAuthorityPolicySchema,
  type DistributorAuthorityPolicy,
} from '../../shared/schemas/distributor';

// ─── Row Types ─────────────────────────────────────────────────────────────────

interface DistributorRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DistributorConnectionRow {
  id: string;
  workspace_id: string;
  distributor_id: string;
  connector_type: string;
  secret_ref: string | null;
  configuration_json: string;
  authority_policy_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface DistributorCatalogSnapshotRow {
  id: string;
  distributor_connection_id: string;
  external_version: string | null;
  content_hash: string | null;
  observed_at: string;
  completed_at: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
}

// ─── Mapping Functions ─────────────────────────────────────────────────────────

function mapDistributorRow(row: DistributorRow): Distributor {
  return DistributorSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapConnectionRow(row: DistributorConnectionRow): DistributorConnection {
  let configuration = {};
  let authorityPolicy = {};
  try {
    if (row.configuration_json) configuration = JSON.parse(row.configuration_json);
  } catch { /* malformed JSON -> ignore */ }
  try {
    if (row.authority_policy_json) authorityPolicy = JSON.parse(row.authority_policy_json);
  } catch { /* malformed JSON -> ignore */ }

  return DistributorConnectionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    distributorId: row.distributor_id,
    connectorType: row.connector_type,
    secretRef: row.secret_ref,
    configuration,
    authorityPolicy,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapSnapshotRow(row: DistributorCatalogSnapshotRow): DistributorCatalogSnapshot {
  return DistributorCatalogSnapshotSchema.parse({
    id: row.id,
    distributorConnectionId: row.distributor_connection_id,
    externalVersion: row.external_version,
    contentHash: row.content_hash,
    observedAt: row.observed_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
  });
}

// ─── Distributor Operations ────────────────────────────────────────────────────

export function createDistributor(data: InsertDistributor & { id?: string }): Distributor {
  const db = getDb();
  const now = new Date().toISOString();
  const id = data.id || `dist_${randomUUID().slice(0, 8)}`;
  const status = data.status || 'active';

  db.query(
    `INSERT INTO distributors (id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, data.name, status, now, now);

  const row = db.query('SELECT * FROM distributors WHERE id = ?').get(id) as DistributorRow;
  return mapDistributorRow(row);
}

export function getDistributorById(id: string): Distributor | null {
  const db = getDb();
  const row = db.query('SELECT * FROM distributors WHERE id = ?').get(id) as DistributorRow | undefined;
  return row ? mapDistributorRow(row) : null;
}

export function listDistributors(): Distributor[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM distributors ORDER BY name').all() as DistributorRow[];
  return rows.map(mapDistributorRow);
}

export function ensureDistributor(id: string, name: string): Distributor {
  const existing = getDistributorById(id);
  if (existing) return existing;
  return createDistributor({ id, name, status: 'active' });
}

// ─── Connection Operations ─────────────────────────────────────────────────────

/**
 * Create a workspace-scoped distributor connection. Validates the input
 * against `InsertDistributorConnectionSchema` (including the recursive
 * credential rejection) BEFORE any SQL; never returns resolved secrets.
 */
export function createConnection(data: InsertDistributorConnection & { id?: string }): DistributorConnection {
  const parsed = InsertDistributorConnectionSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid distributor connection: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const valid = parsed.data;

  const db = getDb();
  const now = new Date().toISOString();
  const id = data.id || `conn_${randomUUID().slice(0, 8)}`;

  ensureDistributor(valid.distributorId, valid.distributorId);

  db.query(
    `INSERT INTO distributor_connections
      (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    valid.workspaceId,
    valid.distributorId,
    valid.connectorType,
    valid.secretRef ?? null,
    JSON.stringify(valid.configuration || {}),
    JSON.stringify(valid.authorityPolicy || {}),
    // Amendment A: create is ALWAYS disabled (fail closed); enablement is a
    // separate workspace-scoped update after operator health checks. The
    // insert schema cannot even express enabled=true, so 0 is unconditional.
    0,
    now,
    now,
  );

  const row = db.query('SELECT * FROM distributor_connections WHERE id = ?').get(id) as DistributorConnectionRow;
  return mapConnectionRow(row);
}

export function getConnectionById(id: string): DistributorConnection | null {
  const db = getDb();
  const row = db.query('SELECT * FROM distributor_connections WHERE id = ?').get(id) as DistributorConnectionRow | undefined;
  return row ? mapConnectionRow(row) : null;
}

export function listConnectionsByWorkspace(workspaceId: string, onlyEnabled = false): DistributorConnection[] {
  const db = getDb();
  let rows: DistributorConnectionRow[];
  if (onlyEnabled) {
    rows = db
      .query('SELECT * FROM distributor_connections WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at')
      .all(workspaceId) as DistributorConnectionRow[];
  } else {
    rows = db
      .query('SELECT * FROM distributor_connections WHERE workspace_id = ? ORDER BY created_at')
      .all(workspaceId) as DistributorConnectionRow[];
  }
  return rows.map(mapConnectionRow);
}

/**
 * Update a connection's non-secret fields (Settings surface, ADR 0014).
 * Workspace-scoped: the WHERE clause includes workspace_id so a cross-
 * workspace id can never be mutated; a missing row returns null. Raw
 * credential material is rejected by `UpdateDistributorConnectionSchema`
 * before any SQL runs.
 */
export function updateConnection(
  id: string,
  workspaceId: string,
  update: UpdateDistributorConnection,
): DistributorConnection | null {
  const parsed = UpdateDistributorConnectionSchema.safeParse(update);
  if (!parsed.success) {
    throw new Error(`Invalid distributor connection update: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const valid = parsed.data;

  const db = getDb();
  const now = new Date().toISOString();

  if (valid.configuration !== undefined) {
    db.query(
      'UPDATE distributor_connections SET configuration_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(JSON.stringify(valid.configuration), now, id, workspaceId);
  }
  if (valid.authorityPolicy !== undefined) {
    db.query(
      'UPDATE distributor_connections SET authority_policy_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(JSON.stringify(valid.authorityPolicy), now, id, workspaceId);
  }
  if (valid.secretRef !== undefined) {
    db.query(
      'UPDATE distributor_connections SET secret_ref = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(valid.secretRef, now, id, workspaceId);
  }
  if (valid.enabled !== undefined) {
    db.query(
      'UPDATE distributor_connections SET enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(valid.enabled ? 1 : 0, now, id, workspaceId);
  }
  if (valid.connectorType !== undefined) {
    db.query(
      'UPDATE distributor_connections SET connector_type = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(valid.connectorType, now, id, workspaceId);
  }

  const row = db
    .query('SELECT * FROM distributor_connections WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId) as DistributorConnectionRow | undefined;
  return row ? mapConnectionRow(row) : null;
}

/**
 * Update a connection's authority policy (validated + workspace-scoped).
 * Prefer `updateConnection`; kept for narrow policy-only callers. Returns
 * null when the row does not exist in the workspace.
 */
export function updateConnectionPolicy(
  id: string,
  workspaceId: string,
  policy: DistributorAuthorityPolicy,
): DistributorConnection | null {
  const parsed = DistributorAuthorityPolicySchema.safeParse(policy);
  if (!parsed.success) {
    throw new Error(`Invalid distributor authority policy: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE distributor_connections SET authority_policy_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
  ).run(JSON.stringify(parsed.data), now, id, workspaceId);

  const row = db
    .query('SELECT * FROM distributor_connections WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId) as DistributorConnectionRow | undefined;
  return row ? mapConnectionRow(row) : null;
}

// ─── Catalog Snapshot Operations ───────────────────────────────────────────────

export function createCatalogSnapshot(data: {
  distributorConnectionId: string;
  externalVersion?: string | null;
  contentHash?: string | null;
  expiresAt?: string | null;
}): DistributorCatalogSnapshot {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `snap_${randomUUID().slice(0, 8)}`;

  db.query(
    `INSERT INTO distributor_catalog_snapshots
      (id, distributor_connection_id, external_version, content_hash, observed_at, completed_at, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    data.distributorConnectionId,
    data.externalVersion ?? null,
    data.contentHash ?? null,
    now,
    now,
    data.expiresAt ?? null,
    now,
  );

  const row = db.query('SELECT * FROM distributor_catalog_snapshots WHERE id = ?').get(id) as DistributorCatalogSnapshotRow;
  return mapSnapshotRow(row);
}

export function getLatestSnapshotForConnection(distributorConnectionId: string): DistributorCatalogSnapshot | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM distributor_catalog_snapshots
       WHERE distributor_connection_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(distributorConnectionId) as DistributorCatalogSnapshotRow | undefined;
  return row ? mapSnapshotRow(row) : null;
}
