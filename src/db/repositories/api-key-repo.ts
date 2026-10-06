import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { DbDatabase } from '../driver';

export interface ApiKeyRow {
  id: string;
  service: string;
  api_key: string;
  base_url: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertApiKey(
  service: string,
  apiKey: string,
  baseUrl?: string | null,
  model?: string | null,
): ApiKeyRow {
  const db = getDb();
  const now = new Date().toISOString();

  // Guard: reject redacted/masked keys on BOTH paths. The UI displays keys
  // as '••••••••' + last 4 chars, so anything starting with '•' arriving
  // here means the client is sending back the masked value rather than
  // a real key. Writing that would silently break every LLM call.
  if (apiKey.startsWith('•')) {
    throw new Error(
      `Cannot save a redacted API key for service "${service}". ` +
        'Please enter the full, unredacted key in Settings.',
    );
  }

  const existing = db.query('SELECT * FROM api_keys WHERE service = ?').get(service) as ApiKeyRow | undefined;

  if (existing) {
    const keyToSave = apiKey.startsWith('•') ? existing.api_key : apiKey;
    db.query(
      'UPDATE api_keys SET api_key = ?, base_url = ?, model = ?, updated_at = ? WHERE service = ?',
    ).run(keyToSave, baseUrl ?? existing.base_url, model ?? existing.model, now, service);
    return { ...existing, api_key: keyToSave, base_url: baseUrl ?? existing.base_url, model: model ?? existing.model, updated_at: now };
  }

  const id = randomUUID();
  db.query(
    'INSERT INTO api_keys (id, service, api_key, base_url, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, service, apiKey, baseUrl ?? null, model ?? null, now, now);
  return { id, service, api_key: apiKey, base_url: baseUrl ?? null, model: model ?? null, created_at: now, updated_at: now };
}

export function getApiKey(service: string, db: Pick<DbDatabase, 'query'> = getDb()): ApiKeyRow | undefined {
  return db.query('SELECT * FROM api_keys WHERE service = ?').get(service) as ApiKeyRow | undefined;
}

export function listApiKeys(): ApiKeyRow[] {
  const db = getDb();
  return db.query('SELECT * FROM api_keys ORDER BY service').all() as ApiKeyRow[];
}

export function deleteApiKey(service: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM api_keys WHERE service = ?').run(service);
  return result.changes > 0;
}
