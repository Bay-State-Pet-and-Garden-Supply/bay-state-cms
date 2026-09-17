/**
 * Explicit unresolved variant-identity dispositions (no-matrix Sitecore follow-up).
 *
 * Template pages whose evidence cannot enforce variant identity (the
 * Nylabone Sitecore precedent: size-bearing family pages where the worker
 * parses no variant matrix, so no selector can discriminate sizes) must not
 * release size-specific items automatically — even when those items carry
 * NEITHER a variant resolution row NOR a `variant:`-prefixed gate error
 * (the ordinary profile-blocked state: `No extractor profile for …`).
 *
 * This module persists that explicit disposition per item
 * (`unresolved_variant_identity`): `markVariantIdentityUnresolved` records
 * operator/brand-curation knowledge that an item is variant-bearing without
 * matrix enforcement; `variantIdentityEligibilityForItem` consults it and
 * holds the item until operator variant selection proves identity
 * (a `selected`/`resolved` resolution with a variant key still releases —
 * positive proof wins over the recorded absence of proof).
 *
 * Audit (issue #220): every mark records WHO marked it (`marked_by`, the
 * server-derived principal actor — never a client-supplied identity) and
 * WHEN (`created_at`/`updated_at`). Clearing deletes the row; the clear
 * itself is audited via `audit_log` at the route seam (who/when/details),
 * so no operator act is silent.
 *
 * Fail-closed: any disposition read failure is surfaced to the caller so
 * the release path can hold rather than release blind.
 */
import { getDb } from '../connection';
import { UNRESOLVED_VARIANT_IDENTITY_DISPOSITION } from '../../onboarding/variant-identity-eligibility';

export interface VariantIdentityDisposition {
  itemId: string;
  disposition: string;
  reason: string;
  /** Server-derived principal actor who recorded the mark (null on pre-audit rows). */
  markedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

let markedByColumnEnsured = false;

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_variant_identity_dispositions (
      item_id TEXT PRIMARY KEY REFERENCES onboarding_items(id) ON DELETE CASCADE,
      disposition TEXT NOT NULL,
      reason TEXT NOT NULL,
      marked_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Backfill for DBs whose table predates the issue-#220 audit column
  // (created by the pre-migration ensureTable without `marked_by`).
  // One PRAGMA per process — mark/clear are rare operator acts, and the
  // release-hold read path calls ensureTable per candidate row.
  if (!markedByColumnEnsured) {
    markedByColumnEnsured = true;
    const cols = db.query(`PRAGMA table_info(onboarding_variant_identity_dispositions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'marked_by')) {
      db.exec(`ALTER TABLE onboarding_variant_identity_dispositions ADD COLUMN marked_by TEXT;`);
    }
  }
}

/**
 * Record explicit knowledge that an item is variant-bearing without matrix
 * enforcement (e.g. a size-specific Nylabone row on a Sitecore family page).
 * Idempotent per item — re-marking updates the reason and the audit identity.
 *
 * `markedBy` is the server-derived principal actor (the route passes
 * `principal.actor`); direct callers (tests, scripts) pass an explicit
 * operator label or leave null. Client-supplied identity is never trusted.
 */
export function markVariantIdentityUnresolved(
  itemId: string,
  reason: string,
  opts?: { markedBy?: string | null },
): VariantIdentityDisposition {
  if (!itemId?.trim()) throw new Error('item id required');
  if (!reason?.trim()) throw new Error('disposition reason required');
  ensureTable();
  const db = getDb();
  const now = new Date().toISOString();
  const markedBy = opts?.markedBy?.trim() ? opts.markedBy.trim() : null;
  db.query(`
    INSERT INTO onboarding_variant_identity_dispositions (item_id, disposition, reason, marked_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET disposition=excluded.disposition, reason=excluded.reason, marked_by=excluded.marked_by, updated_at=excluded.updated_at
  `).run(itemId, UNRESOLVED_VARIANT_IDENTITY_DISPOSITION, reason.trim(), markedBy, now, now);
  // Return the stored row (not the write timestamp): a re-mark preserves
  // the original `created_at`, and the caller must see that same value.
  return getVariantIdentityDisposition(itemId)!;
}

/** Clear the disposition (operator variant selection proved identity). */
export function clearVariantIdentityDisposition(itemId: string): void {
  ensureTable();
  getDb().query(`DELETE FROM onboarding_variant_identity_dispositions WHERE item_id = ?`).run(itemId);
}

/** Current explicit disposition for an item, if any (null when unmarked). */
export function getVariantIdentityDisposition(itemId: string): VariantIdentityDisposition | null {
  ensureTable();
  const row = getDb().query(
    `SELECT item_id as itemId, disposition, reason, marked_by as markedBy, created_at as createdAt, updated_at as updatedAt
     FROM onboarding_variant_identity_dispositions WHERE item_id = ?`,
  ).get(itemId) as VariantIdentityDisposition | undefined;
  return row ?? null;
}

/**
 * Bulk load dispositions for a set of item ids (one statement per 900-id
 * chunk — the work-state projection's O(1) read budget). Returns only
 * marked items; unmarked ids are absent from the map.
 */
export function listVariantIdentityDispositions(itemIds: string[]): Map<string, VariantIdentityDisposition> {
  ensureTable();
  const map = new Map<string, VariantIdentityDisposition>();
  if (itemIds.length === 0) return map;
  const db = getDb();
  const CHUNK = 900;
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.query(
      `SELECT item_id as itemId, disposition, reason, marked_by as markedBy, created_at as createdAt, updated_at as updatedAt
       FROM onboarding_variant_identity_dispositions WHERE item_id IN (${placeholders})`,
    ).all(...chunk) as VariantIdentityDisposition[];
    for (const row of rows) map.set(row.itemId, row);
  }
  return map;
}
