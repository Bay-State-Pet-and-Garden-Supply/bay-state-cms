import type { Database } from 'bun:sqlite';
import type { QualificationRuntimeRecord } from '../../shared/schemas/qualification-run';

/** Tables whose non-secret authority records may be frozen into an evaluation DB. */
export const QUALIFICATION_RUNTIME_TABLES = [
  'workspace', 'classification_output_bindings', 'classification_brands', 'ai_workload_routes',
  'ai_routing_defaults', 'extractor_profiles', 'profile_versions', 'profile_active', 'domain_status',
] as const;

const TABLE_ALLOWLIST: ReadonlySet<string> = new Set(QUALIFICATION_RUNTIME_TABLES);
const SECRET_FIELD = /(?:secret|credential|password|token|api.?key|private.?key)/i;
const OWNER_FIELD = /^(?:workspace_id|workspaceId)$/;

function tableColumns(db: Database, table: string): Array<{ name: string; pk: number }> {
  if (!TABLE_ALLOWLIST.has(table)) throw new Error(`Runtime table is not allowlisted: ${table}`);
  return db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; pk: number }>;
}
function containsSecret(value: unknown, key = ''): boolean {
  if (SECRET_FIELD.test(key)) return true;
  if (Array.isArray(value)) return value.some(entry => containsSecret(entry));
  if (value && typeof value === 'object') return Object.entries(value).some(([child, entry]) => containsSecret(entry, child));
  if (typeof value === 'string' && /(?:sk-[A-Za-z0-9]{16,}|Bearer\s+\S+)/i.test(value)) return true;
  return false;
}

function validateRecord(db: Database, record: QualificationRuntimeRecord, workspaceId: string): void {
  const columns = tableColumns(db, record.table);
  const allowed = new Set(columns.map(column => column.name));
  if (Object.keys(record.row).some(key => !allowed.has(key) || SECRET_FIELD.test(key))) throw new Error(`Runtime record has unknown or secret fields: ${record.table}`);
  for (const [key, value] of Object.entries(record.row)) {
    if (OWNER_FIELD.test(key) && value !== workspaceId) throw new Error(`Foreign workspace record refused: ${record.table}`);
    if (SECRET_FIELD.test(key)) throw new Error(`Secret runtime field refused: ${record.table}`);
  }
  if (containsSecret(record.row)) throw new Error(`Secret runtime value refused: ${record.table}`);
  if (columns.some(column => column.pk > 0 && !(column.name in record.row))) throw new Error(`Runtime record lacks immutable primary key: ${record.table}`);
}

export function exportQualificationRuntimeRecords(db: Database, workspaceId: string): QualificationRuntimeRecord[] {
  const records: QualificationRuntimeRecord[] = [];
  for (const table of QUALIFICATION_RUNTIME_TABLES) {
    const columns = tableColumns(db, table);
    const owner = columns.find(column => OWNER_FIELD.test(column.name));
    if (!owner) continue;
    const rows = db.query(`SELECT * FROM "${table}" WHERE "${owner.name}" = ?`).all(workspaceId) as Record<string, unknown>[];
    for (const row of rows) {
      const record = { table, row };
      validateRecord(db, record, workspaceId);
      records.push(record);
    }
  }
  return records;
}

/** Import only into a caller-owned disposable DB; one transaction prevents partial authority. */
export function importQualificationRuntimeRecords(db: Database, records: readonly QualificationRuntimeRecord[], workspaceId: string): void {
  const insert = db.transaction(() => {
    const seen = new Set<string>();
    for (const record of records) {
      validateRecord(db, record, workspaceId);
      const columns = tableColumns(db, record.table);
      const primaryKey = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const id = primaryKey.map(column => String(record.row[column.name])).join('\u0000');
      const key = `${record.table}\u0000${id}`;
      if (seen.has(key)) throw new Error(`Conflicting immutable runtime ID: ${record.table}`);
      seen.add(key);
      const names = Object.keys(record.row);
      const existing = db.query(`SELECT * FROM "${record.table}" WHERE ${primaryKey.map(column => `"${column.name}" = ?`).join(' AND ')}`).get(...(primaryKey.map(column => record.row[column.name]) as string[]));
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record.row)) throw new Error(`Conflicting immutable runtime ID: ${record.table}`);
        continue;
      }
      const sql = `INSERT INTO "${record.table}" (${names.map(name => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
      db.query(sql).run(...(names.map(name => record.row[name]) as string[]));
    }
  });
  insert();
}
