import type { Database } from 'bun:sqlite';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { encodeForStorage, readStorageVersion, toCanonicalStored } from '../db/repositories/onboarding-stage-vocabulary-repo';

export interface SelectVariantInput {
  itemId: string;
  resolutionId: string;
  identityMatrixHash: string;
  variantKey: string;
}

/**
 * Server-derived variant selection — never trusts client URL/payload.
 * Returns the updated source URL on success, throws with code on failure.
 */
export function selectVariantService(
  db: Database,
  input: SelectVariantInput,
): { sourceUrl: string } {
  // BEGIN IMMEDIATE ensures single writer for supersede+insert+item update
  db.exec('BEGIN IMMEDIATE');
  try {
    const repo = createVariantResolutionRepo(db);
    const current = repo.getById(input.resolutionId);
    if (!current) {
      const e: any = new Error('Resolution not found');
      e.code = 404;
      throw e;
    }
    if (current.onboarding_item_id !== input.itemId) {
      const e: any = new Error('Resolution does not belong to item');
      e.code = 404;
      throw e;
    }
    if (current.identity_matrix_hash !== input.identityMatrixHash) {
      const e: any = new Error('Stale matrix');
      e.code = 409;
      throw e;
    }
    // Idempotent retry must precede superseded check (P1-3): a retry with same resolutionId/hash/key must succeed even if original row was superseded by concurrent selection
    const currentForItem = repo.getCurrentForItem(input.itemId);
    if (
      currentForItem &&
      currentForItem.status === 'selected' &&
      currentForItem.selected_variant_key === input.variantKey &&
      currentForItem.identity_matrix_hash === input.identityMatrixHash
    ) {
      db.exec('COMMIT');
      return { sourceUrl: currentForItem.source_url };
    }
    if (current.superseded_at) {
      const e: any = new Error('Resolution superseded');
      e.code = 409;
      throw e;
    }
    // Validate item stage/status and extraction absence inside transaction
    const itemRow = db.prepare('SELECT stage, stage_status FROM onboarding_items WHERE id = ?').get(input.itemId) as
      | { stage: string; stage_status: string }
      | undefined;
    if (!itemRow) {
      const e: any = new Error('Item not found');
      e.code = 404;
      throw e;
    }
    // Only find_product_page|collect_details in needs_input (or pending/needs_input for extraction) may select variant.
    // Slice 5b native: canonical comparison (dual read — either stored spelling qualifies).
    const rowCanonical = toCanonicalStored(itemRow.stage);
    const allowedStageStatus =
      (rowCanonical === 'find_product_page' && itemRow.stage_status === 'needs_input') ||
      (rowCanonical === 'collect_details' && (itemRow.stage_status === 'needs_input' || itemRow.stage_status === 'pending' || itemRow.stage_status === 'failed'));
    if (!allowedStageStatus) {
      const e: any = new Error(`Variant selection requires find_product_page/needs_input or collect_details/needs_input, got ${itemRow.stage}/${itemRow.stage_status}`);
      e.code = 409;
      throw e;
    }
    // Downstream extraction guard: if extraction already completed, reject unless invalidating (sibling cohort check done via stage_status)
    if (rowCanonical === 'collect_details' && itemRow.stage_status === 'completed') {
      // Allow re-entry only for park→select→resume flow where item was re-queued to needs_input before selection; completed barrier is checked per-batch elsewhere
      const e: any = new Error('Extraction already completed');
      e.code = 409;
      throw e;
    }
    // Status guard: only unresolved matrices may be resolved
    if (current.status === 'selected' || current.status === 'resolved') {
      // resolved automatic already — operator replacement must be explicit but we treat as 409 unless same key (handled above)
      const e: any = new Error('Resolution already selected');
      e.code = 409;
      throw e;
    }
    if (!['ambiguous', 'no_match', 'stale', 'unsupported'].includes(current.status)) {
      const e: any = new Error(`Resolution status ${current.status} not selectable`);
      e.code = 409;
      throw e;
    }
    const candidates = JSON.parse(current.candidates_json) as Array<{ variantKey: string; deepLink: string; available?: boolean }>;
    const chosen = candidates.find((c) => c.variantKey === input.variantKey);
    if (!chosen) {
      const e: any = new Error('Variant key not in matrix');
      e.code = 400;
      throw e;
    }
    // Availability policy: unavailable candidates rejected unless explicitly allowed (for now fail closed)
    if (chosen.available === false) {
      const e: any = new Error('Variant is unavailable');
      e.code = 400;
      throw e;
    }
    const now = new Date().toISOString();
    // supersede current and insert decided row atomically
    repo.supersedeCurrent(input.itemId, now);
    repo.create({
      id: `${input.resolutionId}-sel-${Date.now()}`,
      onboarding_item_id: input.itemId,
      source_url: chosen.deepLink,
      canonical_parent_key: current.canonical_parent_key,
      platform: current.platform as any,
      parser_version: current.parser_version,
      identity_matrix_hash: current.identity_matrix_hash,
      source_content_hash: current.source_content_hash,
      status: 'selected',
      reason_codes_json: JSON.stringify(['operator_selected']),
      candidates_json: current.candidates_json,
      automatic_variant_key: current.automatic_variant_key,
      selected_variant_key: input.variantKey,
      decision_origin: 'operator',
      decided_at: now,
      superseded_at: null,
      created_at: now,
      updated_at: now,
    });
    // update item source_url and requeue to collect_details/pending (park→select→resume) within same transaction.
    // Slice 5b native: the write encodes this transaction's observed storage version.
    db.prepare('UPDATE onboarding_items SET source_url = ?, stage = ?, stage_status = ?, updated_at = ? WHERE id = ?').run(chosen.deepLink, encodeForStorage('collect_details', readStorageVersion(db)), 'pending', now, input.itemId);
    // ensure a source row exists/selected
    const existing = db.prepare('SELECT id FROM onboarding_sources WHERE item_id = ? AND url = ?').get(input.itemId, chosen.deepLink) as any;
    if (existing) {
      db.prepare('UPDATE onboarding_sources SET is_selected = 1 WHERE id = ?').run(existing.id);
      db.prepare('UPDATE onboarding_sources SET is_selected = 0 WHERE item_id = ? AND id != ?').run(input.itemId, existing.id);
    } else {
      db.prepare(
        'INSERT INTO onboarding_sources (id, item_id, url, domain, confidence, is_selected, source_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        `src-${Date.now()}`,
        input.itemId,
        chosen.deepLink,
        new URL(chosen.deepLink).hostname,
        0.95,
        1,
        'operator_variant',
        now,
      );
      db.prepare('UPDATE onboarding_sources SET is_selected = 0 WHERE item_id = ? AND url != ?').run(input.itemId, chosen.deepLink);
    }
    db.exec('COMMIT');
    return { sourceUrl: chosen.deepLink };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}
