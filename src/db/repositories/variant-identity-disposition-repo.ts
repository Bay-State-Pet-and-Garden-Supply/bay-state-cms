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
 * Fail-closed: any disposition read failure is surfaced to the caller so
 * the release path can hold rather than release blind.
 */
import { getDb } from '../connection';
import { UNRESOLVED_VARIANT_IDENTITY_DISPOSITION } from '../../onboarding/variant-identity-eligibility';

export interface VariantIdentityDisposition {
  itemId: string;
  disposition: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_variant_identity_dispositions (
      item_id TEXT PRIMARY KEY REFERENCES onboarding_items(id) ON DELETE CASCADE,
      disposition TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Record explicit knowledge that an item is variant-bearing without matrix
 * enforcement (e.g. a size-specific Nylabone row on a Sitecore family page).
 * Idempotent per item — re-marking updates the reason.
 */
export function markVariantIdentityUnresolved(itemId: string, reason: string): VariantIdentityDisposition {
  if (!itemId?.trim()) throw new Error('item id required');
  if (!reason?.trim()) throw new Error('disposition reason required');
  ensureTable();
  const db = getDb();
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO onboarding_variant_identity_dispositions (item_id, disposition, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET disposition=excluded.disposition, reason=excluded.reason, updated_at=excluded.updated_at
  `).run(itemId, UNRESOLVED_VARIANT_IDENTITY_DISPOSITION, reason.trim(), now, now);
  return { itemId, disposition: UNRESOLVED_VARIANT_IDENTITY_DISPOSITION, reason: reason.trim(), createdAt: now, updatedAt: now };
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
    `SELECT item_id as itemId, disposition, reason, created_at as createdAt, updated_at as updatedAt
     FROM onboarding_variant_identity_dispositions WHERE item_id = ?`,
  ).get(itemId) as VariantIdentityDisposition | undefined;
  return row ?? null;
}
