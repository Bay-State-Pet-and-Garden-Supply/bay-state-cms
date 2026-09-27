/**
 * SQLite Repository for Provider Connections and Workload Routes.
 *
 * Single authoritative persistence for AI Compute configuration:
 * provider connections, default catalog/privacy settings, and workload routing.
 */

import { getDb } from '../connection';
import type {
  ProviderConnection,
  AiRoutingConfig,
  WorkloadRoute,
  ModelTarget,
  AiTrustZone,
  AiTransport,
  DataSharingPolicy,
  TerminalBehavior,
} from '../../ai/provider-connections';
import { DEFAULT_BUILTIN_CONNECTIONS } from '../../ai/provider-connections';
import { DEFAULT_LOCAL_VISION_MODEL } from '../../shared/vision-model-defaults';

interface DbProviderConnection {
  id: string;
  label: string;
  transport: string;
  base_url: string;
  credential: string | null;
  trust_zone: string;
  approved_host: string;
  approved_port: number | null;
  enabled: number;
  connect_timeout_ms: number;
  inference_timeout_ms: number;
  created_at: string;
  updated_at: string;
}

interface DbWorkloadRoute {
  workload: string;
  primary_connection_id: string;
  primary_model_id: string;
  fallback_connection_id: string | null;
  fallback_model_id: string | null;
  text_data_sharing: string | null;
  image_data_sharing: string | null;
  terminal_behavior: string;
  created_at: string;
  updated_at: string;
}

interface DbRoutingDefaults {
  id: string;
  catalog_primary_connection_id: string;
  catalog_primary_model_id: string;
  catalog_fallback_connection_id: string | null;
  catalog_fallback_model_id: string | null;
  text_data_sharing: string;
  image_data_sharing: string;
  created_at: string;
  updated_at: string;
}

/**
 * Ensures initial default connections, routes, and defaults exist in the DB.
 */
function ensureSeededDefaults(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'openai-compatible',
      base_url TEXT NOT NULL,
      credential TEXT,
      trust_zone TEXT NOT NULL DEFAULT 'this_device',
      approved_host TEXT NOT NULL,
      approved_port INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      connect_timeout_ms INTEGER NOT NULL DEFAULT 2000,
      inference_timeout_ms INTEGER NOT NULL DEFAULT 60000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_workload_routes (
      workload TEXT PRIMARY KEY,
      primary_connection_id TEXT NOT NULL,
      primary_model_id TEXT NOT NULL,
      fallback_connection_id TEXT,
      fallback_model_id TEXT,
      text_data_sharing TEXT,
      image_data_sharing TEXT,
      terminal_behavior TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_routing_defaults (
      id TEXT PRIMARY KEY DEFAULT 'current',
      catalog_primary_connection_id TEXT NOT NULL,
      catalog_primary_model_id TEXT NOT NULL,
      catalog_fallback_connection_id TEXT,
      catalog_fallback_model_id TEXT,
      text_data_sharing TEXT NOT NULL DEFAULT 'this_device_only',
      image_data_sharing TEXT NOT NULL DEFAULT 'this_device_only',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Self-healing reconciliation of BUILT-IN connections. `INSERT OR IGNORE`
  // is idempotent: existing rows — including operator edits (credentials,
  // enabled state, custom base URLs, security pins) — are never touched,
  // while built-ins introduced by newer product versions (e.g.
  // `openai-cloud`) are added to installs whose `provider_connections`
  // table was seeded before they existed. A built-in is a product default:
  // re-adding it after a manual deletion is intentional, and operators opt
  // out by disabling the connection (enabled = false) rather than deleting
  // it. (The previous empty-table guard left newer built-ins permanently
  // absent from already-seeded installs.)
  const now = new Date().toISOString();
  const insertConn = db.query(`
    INSERT OR IGNORE INTO provider_connections (
      id, label, transport, base_url, credential, trust_zone,
      approved_host, approved_port, enabled, connect_timeout_ms,
      inference_timeout_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const conn of Object.values(DEFAULT_BUILTIN_CONNECTIONS)) {
    insertConn.run(
      conn.id,
      conn.label,
      conn.transport,
      conn.baseUrl,
      conn.credential ?? null,
      conn.trustZone,
      conn.approvedHost || 'localhost',
      conn.approvedPort ?? null,
      conn.enabled ? 1 : 0,
      conn.connectTimeoutMs ?? 2000,
      conn.inferenceTimeoutMs ?? 60000,
      now,
      now,
    );
  }

  const defaultsRow = db.query('SELECT * FROM ai_routing_defaults WHERE id = ?').get('current');
  if (!defaultsRow) {
    const now = new Date().toISOString();
    db.query(`
      INSERT OR IGNORE INTO ai_routing_defaults (
        id, catalog_primary_connection_id, catalog_primary_model_id,
        catalog_fallback_connection_id, catalog_fallback_model_id,
        text_data_sharing, image_data_sharing, created_at, updated_at
      ) VALUES ('current', 'local-ollama', ?, NULL, NULL, 'this_device_only', 'this_device_only', ?, ?)
    `).run(DEFAULT_LOCAL_VISION_MODEL, now, now);
  }
}

export function upsertProviderConnection(conn: ProviderConnection): void {
  const db = getDb();
  const now = new Date().toISOString();

  // If incoming credential is omitted or redacted, preserve the existing credential
  const existing = getProviderConnection(conn.id);
  const credentialToSave = (conn.credential === undefined || conn.credential === null || conn.credential === '[REDACTED]')
    ? (existing?.credential ?? null)
    : (conn.credential.trim() === '' ? null : conn.credential);

  let approvedHost = conn.approvedHost;
  let approvedPort = conn.approvedPort;
  try {
    const url = new URL(conn.baseUrl);
    approvedHost = approvedHost || url.hostname;
    approvedPort = approvedPort ?? (url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80));
  } catch { /* use existing */ }

  db.query(`
    INSERT INTO provider_connections (
      id, label, transport, base_url, credential, trust_zone,
      approved_host, approved_port, enabled, connect_timeout_ms,
      inference_timeout_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      transport = excluded.transport,
      base_url = excluded.base_url,
      credential = excluded.credential,
      trust_zone = excluded.trust_zone,
      approved_host = excluded.approved_host,
      approved_port = excluded.approved_port,
      enabled = excluded.enabled,
      connect_timeout_ms = excluded.connect_timeout_ms,
      inference_timeout_ms = excluded.inference_timeout_ms,
      updated_at = excluded.updated_at
  `).run(
    conn.id,
    conn.label,
    conn.transport,
    conn.baseUrl,
    credentialToSave,
    conn.trustZone,
    approvedHost || 'localhost',
    approvedPort ?? null,
    conn.enabled ? 1 : 0,
    conn.connectTimeoutMs ?? 2000,
    conn.inferenceTimeoutMs ?? 60000,
    now,
    now,
  );
}

export function getProviderConnection(id: string): ProviderConnection | null {
  const db = getDb();
  try {
    ensureSeededDefaults();
    const row = db.query('SELECT * FROM provider_connections WHERE id = ?').get(id) as DbProviderConnection | undefined;
    if (!row) return null;

    return {
      id: row.id,
      label: row.label,
      transport: row.transport as AiTransport,
      baseUrl: row.base_url,
      credential: row.credential,
      trustZone: row.trust_zone as AiTrustZone,
      approvedHost: row.approved_host,
      approvedPort: row.approved_port ?? undefined,
      enabled: Boolean(row.enabled),
      connectTimeoutMs: row.connect_timeout_ms,
      inferenceTimeoutMs: row.inference_timeout_ms,
    };
  } catch {
    return DEFAULT_BUILTIN_CONNECTIONS[id] ?? null;
  }
}

export function listProviderConnections(): ProviderConnection[] {
  const db = getDb();
  try {
    ensureSeededDefaults();
    const rows = db.query('SELECT * FROM provider_connections ORDER BY id').all() as DbProviderConnection[];
    return rows.map(row => ({
      id: row.id,
      label: row.label,
      transport: row.transport as AiTransport,
      baseUrl: row.base_url,
      credential: row.credential,
      trustZone: row.trust_zone as AiTrustZone,
      approvedHost: row.approved_host,
      approvedPort: row.approved_port ?? undefined,
      enabled: Boolean(row.enabled),
      connectTimeoutMs: row.connect_timeout_ms,
      inferenceTimeoutMs: row.inference_timeout_ms,
    }));
  } catch {
    return Object.values(DEFAULT_BUILTIN_CONNECTIONS);
  }
}

export function deleteProviderConnection(id: string): boolean {
  const db = getDb();
  ensureSeededDefaults();

  // Atomically delete and repair any dangling workload routes or defaults
  db.transaction(() => {
    db.query('DELETE FROM provider_connections WHERE id = ?').run(id);

    // Repair defaults if deleting the primary or fallback catalog connection
    const defaults = db.query('SELECT * FROM ai_routing_defaults WHERE id = ?').get('current') as DbRoutingDefaults | undefined;
    if (defaults) {
      if (defaults.catalog_primary_connection_id === id) {
        const remaining = db.query('SELECT id FROM provider_connections LIMIT 1').get() as { id: string } | undefined;
        const newPrimaryId = remaining?.id ?? 'openai-cloud';
        const newPrimaryModel = newPrimaryId === 'openai-cloud' ? 'gpt-4o-mini' : (newPrimaryId === 'deepseek-cloud' ? 'deepseek-chat' : DEFAULT_LOCAL_VISION_MODEL);
        db.query('UPDATE ai_routing_defaults SET catalog_primary_connection_id = ?, catalog_primary_model_id = ? WHERE id = ?').run(newPrimaryId, newPrimaryModel, 'current');
      }
      if (defaults.catalog_fallback_connection_id === id) {
        db.query('UPDATE ai_routing_defaults SET catalog_fallback_connection_id = NULL, catalog_fallback_model_id = NULL WHERE id = ?').run('current');
      }
    }

    // Repair workload routes referencing deleted connection
    db.query('UPDATE ai_workload_routes SET primary_connection_id = "inherit", primary_model_id = "" WHERE primary_connection_id = ?').run(id);
    db.query('UPDATE ai_workload_routes SET fallback_connection_id = NULL, fallback_model_id = NULL WHERE fallback_connection_id = ?').run(id);
  })();

  return true;
}

export function saveAiRoutingDefaults(defaults: AiRoutingConfig['defaults']): void {
  const db = getDb();
  const now = new Date().toISOString();
  ensureSeededDefaults();

  db.query(`
    INSERT INTO ai_routing_defaults (
      id, catalog_primary_connection_id, catalog_primary_model_id,
      catalog_fallback_connection_id, catalog_fallback_model_id,
      text_data_sharing, image_data_sharing, created_at, updated_at
    ) VALUES ('current', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      catalog_primary_connection_id = excluded.catalog_primary_connection_id,
      catalog_primary_model_id = excluded.catalog_primary_model_id,
      catalog_fallback_connection_id = excluded.catalog_fallback_connection_id,
      catalog_fallback_model_id = excluded.catalog_fallback_model_id,
      text_data_sharing = excluded.text_data_sharing,
      image_data_sharing = excluded.image_data_sharing,
      updated_at = excluded.updated_at
  `).run(
    defaults.catalogTarget.connectionId,
    defaults.catalogTarget.modelId,
    defaults.catalogFallback?.connectionId ?? null,
    defaults.catalogFallback?.modelId ?? null,
    defaults.textDataSharing,
    defaults.imageDataSharing,
    now,
    now,
  );
}

export function upsertWorkloadRoute(workload: string, route: WorkloadRoute): void {
  const db = getDb();
  const now = new Date().toISOString();
  ensureSeededDefaults();

  const primaryConnId = typeof route.primary === 'string' ? route.primary : route.primary.connectionId;
  const primaryModelId = typeof route.primary === 'string' ? 'inherit' : route.primary.modelId;

  let fallbackConnId: string | null = null;
  let fallbackModelId: string | null = null;

  if (route.fallback === 'inherit') {
    fallbackConnId = 'inherit';
    fallbackModelId = 'inherit';
  } else if (route.fallback) {
    fallbackConnId = route.fallback.connectionId;
    fallbackModelId = route.fallback.modelId;
  }

  db.query(`
    INSERT INTO ai_workload_routes (
      workload, primary_connection_id, primary_model_id,
      fallback_connection_id, fallback_model_id,
      text_data_sharing, image_data_sharing, terminal_behavior,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workload) DO UPDATE SET
      primary_connection_id = excluded.primary_connection_id,
      primary_model_id = excluded.primary_model_id,
      fallback_connection_id = excluded.fallback_connection_id,
      fallback_model_id = excluded.fallback_model_id,
      text_data_sharing = excluded.text_data_sharing,
      image_data_sharing = excluded.image_data_sharing,
      terminal_behavior = excluded.terminal_behavior,
      updated_at = excluded.updated_at
  `).run(
    workload,
    primaryConnId,
    primaryModelId,
    fallbackConnId,
    fallbackModelId,
    route.textDataSharing ?? null,
    route.imageDataSharing ?? null,
    route.terminalBehavior,
    now,
    now,
  );
}

export function getWorkloadRoute(workload: string): WorkloadRoute | null {
  const db = getDb();
  try {
    ensureSeededDefaults();
    const row = db.query('SELECT * FROM ai_workload_routes WHERE workload = ?').get(workload) as DbWorkloadRoute | undefined;
    if (!row) return null;

    const primary: ModelTarget | 'inherit' = row.primary_connection_id === 'inherit'
      ? 'inherit'
      : { connectionId: row.primary_connection_id, modelId: row.primary_model_id };

    let fallback: ModelTarget | 'inherit' | null = null;
    if (row.fallback_connection_id === 'inherit') {
      fallback = 'inherit';
    } else if (row.fallback_connection_id && row.fallback_model_id) {
      fallback = { connectionId: row.fallback_connection_id, modelId: row.fallback_model_id };
    }

    return {
      primary,
      fallback,
      textDataSharing: (row.text_data_sharing as DataSharingPolicy) ?? undefined,
      imageDataSharing: (row.image_data_sharing as DataSharingPolicy) ?? undefined,
      terminalBehavior: row.terminal_behavior as TerminalBehavior,
    };
  } catch {
    return null;
  }
}

/**
 * True when the persisted AI Compute routing state deviates from the pristine
 * built-in seeds — i.e. the operator has explicitly configured routing
 * (workload route rows, privacy defaults, modified built-in connections, or
 * operator-added connections).
 *
 * When configured, AI Compute is AUTHORITATIVE: live tasks never consult the
 * legacy `llm_task_configs` / `api_keys` chain, which would bypass the AI
 * Compute privacy boundary. Legacy routing remains available only to
 * never-touched installs (migration path, not runtime semantics).
 */
export function isAiComputeConfigured(): boolean {
  const db = getDb();
  ensureSeededDefaults();
  try {
    const routeCount = db.query('SELECT COUNT(*) as c FROM ai_workload_routes').get() as { c: number };
    if (routeCount.c > 0) return true;

    const defaultsRow = db.query('SELECT * FROM ai_routing_defaults WHERE id = ?').get('current') as DbRoutingDefaults | undefined;
    if (defaultsRow) {
      if (defaultsRow.text_data_sharing !== 'this_device_only' || defaultsRow.image_data_sharing !== 'this_device_only') return true;
      if (defaultsRow.catalog_primary_connection_id !== 'local-ollama' || defaultsRow.catalog_primary_model_id !== DEFAULT_LOCAL_VISION_MODEL) return true;
      if (defaultsRow.catalog_fallback_connection_id !== null || defaultsRow.catalog_fallback_model_id !== null) return true;
    }

    const rows = db.query('SELECT * FROM provider_connections').all() as DbProviderConnection[];
    for (const row of rows) {
      const seed = DEFAULT_BUILTIN_CONNECTIONS[row.id];
      if (!seed) return true; // operator-added connection
      if (seed.enabled !== Boolean(row.enabled)) return true;
      if (seed.baseUrl !== row.base_url) return true;
      if (seed.trustZone !== row.trust_zone) return true;
      if ((seed.credential ?? null) !== row.credential) return true;
      if (seed.approvedHost !== row.approved_host) return true;
      if ((seed.approvedPort ?? null) !== row.approved_port) return true;
    }
  } catch {
    // DB unavailable → treat as unconfigured (legacy migration path remains).
    return false;
  }
  return false;
}

export function getFullAiRoutingConfig(): AiRoutingConfig {
  const db = getDb();
  ensureSeededDefaults();

  const connectionsList = listProviderConnections();
  const connections: Record<string, ProviderConnection> = {};
  for (const c of connectionsList) {
    connections[c.id] = c;
  }

  // Read persisted defaults
  const defaultsRow = db.query('SELECT * FROM ai_routing_defaults WHERE id = ?').get('current') as DbRoutingDefaults | undefined;
  const defaults: AiRoutingConfig['defaults'] = {
    textDataSharing: (defaultsRow?.text_data_sharing as DataSharingPolicy) ?? 'this_device_only',
    imageDataSharing: (defaultsRow?.image_data_sharing as DataSharingPolicy) ?? 'this_device_only',
    catalogTarget: {
      connectionId: defaultsRow?.catalog_primary_connection_id ?? 'local-ollama',
      modelId: defaultsRow?.catalog_primary_model_id ?? DEFAULT_LOCAL_VISION_MODEL,
    },
    catalogFallback: defaultsRow?.catalog_fallback_connection_id
      ? {
          connectionId: defaultsRow.catalog_fallback_connection_id,
          modelId: defaultsRow.catalog_fallback_model_id ?? 'gpt-4o-mini',
        }
      : null,
  };

  // Ensure catalog primary targets an existing connection
  if (!connections[defaults.catalogTarget.connectionId] && connectionsList.length > 0) {
    defaults.catalogTarget.connectionId = connectionsList[0].id;
  }

  // Read individual workloads (or supply defaults)
  const discovery = getWorkloadRoute('discovery') ?? {
    primary: 'inherit',
    fallback: 'inherit',
    terminalBehavior: 'heuristic',
  };
  const curation = getWorkloadRoute('curation') ?? {
    primary: 'inherit',
    fallback: 'inherit',
    terminalBehavior: 'defer',
  };
  const visionOcr = getWorkloadRoute('visionOcr') ?? {
    primary: 'inherit',
    fallback: null,
    terminalBehavior: 'heuristic',
  };
  const profileBuilder = getWorkloadRoute('profileBuilder') ?? {
    primary: defaults.catalogTarget,
    fallback: defaults.catalogFallback,
    terminalBehavior: 'fail_closed',
  };
  const storeManager = getWorkloadRoute('storeManager') ?? {
    primary: defaults.catalogTarget,
    fallback: defaults.catalogFallback,
    terminalBehavior: 'unavailable',
  };

  return {
    connections,
    defaults,
    workloads: {
      discovery,
      curation,
      visionOcr,
      profileBuilder,
      storeManager,
    },
  };
}
