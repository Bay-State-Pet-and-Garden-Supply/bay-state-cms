import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import type { DbDatabase } from '../driver';

export interface SecuritySettingsRow {
  id: string;
  api_token: string | null;
  release_admin_enabled: number;
  created_at: string;
  updated_at: string;
}

export function installSecuritySettingsSchema(db: Pick<DbDatabase, 'exec'> = getDb()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_security_settings (
    id TEXT PRIMARY KEY,
    api_token TEXT,
    release_admin_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

export function getSecuritySettings(db: Pick<DbDatabase, 'query'> = getDb()): SecuritySettingsRow | undefined {
  return db.query('SELECT * FROM app_security_settings LIMIT 1').get() as SecuritySettingsRow | undefined;
}

export function getStoredApiToken(db: Pick<DbDatabase, 'query'> = getDb()): string | undefined {
  const token = getSecuritySettings(db)?.api_token;
  return token || undefined;
}

export function getStoredReleaseAdminEnabled(db: Pick<DbDatabase, 'query'> = getDb()): boolean {
  return getSecuritySettings(db)?.release_admin_enabled === 1;
}

export function saveSecuritySettings(values: { apiToken?: string; releaseAdminEnabled?: boolean }, db: Pick<DbDatabase, 'query'> = getDb()): void {
  if (values.apiToken?.startsWith('•')) {
    throw new Error('Cannot save a masked API token.');
  }
  const now = new Date().toISOString();
  const existing = getSecuritySettings(db);
  if (existing) {
    db.query(`UPDATE app_security_settings SET api_token = ?, release_admin_enabled = ?, updated_at = ? WHERE id = ?`).run(
      values.apiToken ?? existing.api_token,
      values.releaseAdminEnabled === undefined ? existing.release_admin_enabled : Number(values.releaseAdminEnabled),
      now,
      existing.id,
    );
    return;
  }
  db.query(`INSERT INTO app_security_settings (id, api_token, release_admin_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    randomUUID(), values.apiToken ?? null, Number(values.releaseAdminEnabled ?? false), now, now,
  );
}
