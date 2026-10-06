import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import type { DbDatabase } from '../driver';

export interface ShopSiteConnectionRow {
  id: string;
  workspaceId: string;
  cgiBaseUrl: string;
  authStrategy: string;
  merchantId: string | null;
  passwordSecretRef: string | null;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
}

export function findConnection(workspaceId: string, db: Pick<DbDatabase, 'query'> = getDb()): ShopSiteConnectionRow | null {
  const row = db.query('SELECT * FROM connection WHERE workspace_id = ? LIMIT 1').get(workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function upsertConnection(input: {
  workspaceId: string;
  cgiBaseUrl: string;
  merchantId?: string | null;
  passwordSecretRef?: string | null;
  authStrategy?: string;
  lastTestedAt?: string | null;
  lastTestStatus?: string | null;
  lastTestError?: string | null;
}): ShopSiteConnectionRow {
  const db = getDb();
  const existing = findConnection(input.workspaceId);
  const now = new Date().toISOString();

  if (existing) {
    db.run(
      `UPDATE connection
       SET cgi_base_url = ?, auth_strategy = ?, merchant_id = ?, password_secret_ref = ?,
           last_tested_at = ?, last_test_status = ?, last_test_error = ?
       WHERE id = ?`,
      [
        input.cgiBaseUrl,
        input.authStrategy ?? existing.authStrategy,
        input.merchantId ?? existing.merchantId,
        input.passwordSecretRef ?? existing.passwordSecretRef,
        input.lastTestedAt ?? existing.lastTestedAt,
        input.lastTestStatus ?? existing.lastTestStatus,
        input.lastTestError ?? existing.lastTestError,
        existing.id,
      ],
    );
    return findConnection(input.workspaceId)!;
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO connection
       (id, workspace_id, cgi_base_url, auth_strategy, merchant_id, password_secret_ref, last_tested_at, last_test_status, last_test_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.cgiBaseUrl,
      input.authStrategy ?? 'basic',
      input.merchantId ?? null,
      input.passwordSecretRef ?? null,
      input.lastTestedAt ?? now,
      input.lastTestStatus ?? null,
      input.lastTestError ?? null,
    ],
  );
  return findConnection(input.workspaceId)!;
}

export function updateConnectionTestStatus(
  workspaceId: string,
  status: string,
  error: string | null,
): void {
  const db = getDb();
  db.run(
    `UPDATE connection
     SET last_tested_at = ?, last_test_status = ?, last_test_error = ?
     WHERE workspace_id = ?`,
    [new Date().toISOString(), status, error, workspaceId],
  );
}

function mapRow(row: Record<string, unknown>): ShopSiteConnectionRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    cgiBaseUrl: String(row.cgi_base_url),
    authStrategy: String(row.auth_strategy),
    merchantId: row.merchant_id ? String(row.merchant_id) : null,
    passwordSecretRef: row.password_secret_ref ? String(row.password_secret_ref) : null,
    lastTestedAt: row.last_tested_at ? String(row.last_tested_at) : null,
    lastTestStatus: row.last_test_status ? String(row.last_test_status) : null,
    lastTestError: row.last_test_error ? String(row.last_test_error) : null,
  };
}
