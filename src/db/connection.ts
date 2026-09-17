import { Database } from './driver';
import path from 'path';
import fs from 'fs';

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb(dbPath) first.');
  }
  return _db;
}

export function initDb(dbPath: string): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  _db = new Database(dbPath);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA busy_timeout = 5000;');
  _db.exec('PRAGMA foreign_keys = ON;');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** True when a database is initialized (PI-10: guards DB-backed budget
 *  enforcement in environments that may lack bun:sqlite, e.g. vitest). */
export function isDbInitialized(): boolean {
  return _db !== null;
}

/**
 * Run a parameterized `IN (...)` select in chunks (SQLite variable limit).
 * Returns concatenated rows in chunk order. Callers keep their own error
 * mapping, query instrumentation, and row shaping.
 */
export function queryInChunks<T>(
  buildSql: (placeholders: string) => string,
  ids: string[],
  chunkSize = 900,
): T[] {
  const db = getDb();
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    rows.push(...(db.query(buildSql(chunk.map(() => '?').join(','))).all(...chunk) as T[]));
  }
  return rows;
}

// fallow-ignore-next-line unused-export
export function resetDb(): void {
  closeDb();
  _db = null;
}
