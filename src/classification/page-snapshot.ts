// fallow-ignore-file unused-export

/**
 * Verified Page catalog snapshot (issue #17 work item D1).
 *
 * Classification runs must execute against ONE frozen view of the verified
 * Page catalog. This module performs a single read of the ACTIVE page import
 * plus its matching verified `page_index` rows, validates that every import
 * record has a matching verified row, and returns an immutable snapshot the
 * run creators pass into `buildRuntimeSnapshot()` before a run row exists.
 *
 * Fail-closed contract:
 * - No active import or no usable verified records ⇒ an empty unavailable
 *   snapshot (the run creator records `no_verified_page_catalog`; an enabled
 *   Page target fails readiness/abstains — name-only rows are never options).
 * - Malformed import records, a record without a matching verified row, or an
 *   import/row mismatch during capture ⇒ throw BEFORE run creation so a run
 *   can never start against an inconsistent Page catalog.
 * - Mutating or superseding `page_index`/`page_imports` after capture cannot
 *   change the frozen records a run sees.
 */
import { getDb } from '../db/connection';
import { PageRecordSchema } from '../shared/schemas/page';
import type { PageRecord } from '../shared/schemas/page';
import {
  getActivePageImportRow,
  listVerifiedPageIndexRows,
  mapImportRow,
  type ReadonlySnapshotDb,
} from '../db/repositories/page-import-repo';
import type { PageSnapshotRecord, PageSnapshotState } from './runtime-snapshot';

export interface VerifiedPageSnapshot {
  /**
   * Present only when an active verified import with usable matching rows
   * exists. Null means the catalog is unavailable (no import or no verified
   * rows) and the run must record `no_verified_page_catalog`.
   */
  pageImportId: string | null;
  pageImportHash: string | null;
  /** Verified + available records only, with parent metadata, in stable order. */
  records: PageSnapshotRecord[];
  /** Local page_index row IDs of the verified records. */
  verifiedPageIds: string[];
}

/** Empty unavailable snapshot (no active verified import / no usable rows). */
export const UNAVAILABLE_PAGE_SNAPSHOT: VerifiedPageSnapshot = {
  pageImportId: null,
  pageImportHash: null,
  records: [],
  verifiedPageIds: [],
};

/**
 * One coherent read of the ACTIVE verified Page import for a workspace.
 *
 * Reads the active import row (including its canonical `records_json`) once,
 * then the `page_index` rows belonging to that exact import, and validates a
 * strict 1:1 correspondence: every verified import record must have exactly
 * one matching verified `page_index` row with the same name, availability,
 * parent reference, and source hash — and every verified row for that import
 * must correspond to a verified record. Any drift, malformed records, or
 * parse failure THROWS so a run can never start against an incoherent Page
 * catalog (fail closed before run creation).
 *
 * Unavailable states (no active import, or an active import with genuinely no
 * verified+available records and no verified rows) return the empty
 * UNAVAILABLE_PAGE_SNAPSHOT; the run-start readiness gate then blocks an
 * enabled Page target because the captured snapshot carries no Page IDs.
 */
export function captureVerifiedPageSnapshot(workspaceId: string, db?: ReadonlySnapshotDb): VerifiedPageSnapshot {
  const database: ReadonlySnapshotDb = db ?? getDb();
  // ONE coherent read: the active import row (including records_json), the
  // matching verified page_index rows, and all drift validation happen inside
  // a single transaction so a concurrent activation/supersede can never mix
  // database moments (issue #17 D1). Pass an independent readonly driver to
  // capture without touching the global connection.
  return database.transaction(() => {
    const activeRow = getActivePageImportRow(database, workspaceId) as Record<string, any> | undefined;
    if (!activeRow) return UNAVAILABLE_PAGE_SNAPSHOT;

    const active = mapImportRow(activeRow);

    let parsed: unknown;
    try {
      parsed = JSON.parse(activeRow.records_json);
    } catch {
      throw new Error(
        `Verified Page import changed during capture: malformed records_json in active import "${active.id}".`,
      );
    }
    const recordsResult = PageRecordSchema.array().safeParse(parsed);
    if (!recordsResult.success) {
      throw new Error(
        `Verified Page import changed during capture: invalid records_json in active import "${active.id}".`,
      );
    }
    const records: PageRecord[] = recordsResult.data;

    // One read of the verified page_index rows for THIS import (any
    // availability) so drift between the import records and child rows is
    // visible. SQL lives in the page-import repository; this seam only maps.
    const rows = listVerifiedPageIndexRows(database, workspaceId, active.id);

    const verifiedRecords = records.filter(r => r.identity.status === 'verified');

    // Strict 1:1 by identity key — THREE independent checks so the capture is
    // a true bijection and can never alias or drop rows:
    //   1. Duplicate identity keys INSIDE the authoritative records_json are
    //      rejected (e.g. records [A,A]); otherwise two records could alias
    //      the same row.
    //   2. Duplicate identity keys among the child page_index rows are
    //      rejected (even if the unique identity index is absent on an older
    //      database).
    //   3. After per-record validation, every child-row key must have been
    //      consumed exactly once — an extra unconsumed row is drift.
    const recordKeys = new Set<string>();
    for (const record of verifiedRecords) {
      const key = `${record.identity.kind}:${record.identity.key}`;
      if (recordKeys.has(key)) {
        throw new Error(
          `Verified Page import changed during capture: duplicate identity records for "${key}" in the active import.`,
        );
      }
      recordKeys.add(key);
    }

    const rowsByKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.identity_kind}:${row.identity_key}`;
      const list = rowsByKey.get(key) ?? [];
      list.push(row);
      rowsByKey.set(key, list);
    }
    for (const [key, list] of rowsByKey) {
      if (list.length > 1) {
        throw new Error(
          `Verified Page import changed during capture: duplicate page_index rows for identity "${key}" in the active import.`,
        );
      }
    }

    // NOTE: there is deliberately NO separate raw-count guard here. The
    // per-record 'no page_index row' check below handles missing rows, and the
    // consumedRowKeys tail check handles every extra-row case (equal-count
    // aliases AND count mismatches like records [A] + rows [A,B]), so the tail
    // stays operational rather than being shadowed by an earlier count error.

    // Validate EVERY verified record against its row — name, availability,
    // source hash (never NULL-exempt: an activated row has an authoritative
    // non-null import hash), and parent metadata — BEFORE filtering by
    // availability, so drift on an unavailable verified row is still a
    // capture-time error.
    // Every child-row key consumed exactly once: track which rows the
    // per-record validation below actually matches. If a verified row exists
    // for this import but no verified record references it, the catalog is
    // non-bijective (an unconsumed extra row) and capture must fail closed.
    const consumedRowKeys = new Set<string>();

    for (const record of verifiedRecords) {
      const key = `${record.identity.kind}:${record.identity.key}`;
      const row = rowsByKey.get(key)?.[0];
      if (!row) {
        throw new Error(
          `Verified Page import changed during capture: no page_index row for identity "${key}" in the active import.`,
        );
      }
      if (row.name !== record.name) {
        throw new Error(
          `Verified Page import changed during capture: name mismatch for identity "${key}".`,
        );
      }
      if (row.availability !== record.availability) {
        throw new Error(
          `Verified Page import changed during capture: availability mismatch for identity "${key}".`,
        );
      }
      if (row.source_hash === null || row.source_hash !== active.sourceHash) {
        throw new Error(
          `Verified Page import changed during capture: source hash mismatch for identity "${key}".`,
        );
      }
      // Parent validation for ALL verified rows (any availability): a record's
      // parentRef must resolve to a verified row of the same import and the
      // row's parent_id must equal that parent row's id; a parentless record
      // whose row claims a parent is drift.
      if (record.parentRef) {
        const parentRow = rowsByKey.get(`${record.identity.kind}:${record.parentRef}`)?.[0];
        if (!parentRow) {
          throw new Error(
            `Verified Page import changed during capture: parent "${record.parentRef}" not found for identity "${key}".`,
          );
        }
        if (row.parent_id !== parentRow.id) {
          throw new Error(
            `Verified Page import changed during capture: parent mismatch for identity "${key}".`,
          );
        }
      } else if (row.parent_id !== null) {
        throw new Error(
          `Verified Page import changed during capture: unexpected parent for identity "${key}".`,
        );
      }
      consumedRowKeys.add(key);
    }

    // Bijection tail check: every distinct child-row key must have been
    // consumed by exactly one verified record. Combined with the duplicate
    // record/row checks above, this proves a strict 1:1 correspondence — an
    // equal-count alias case (records [A,A] + rows [A,B]) is rejected either
    // here (row B unconsumed) or by the duplicate-record check (records A,A).
    const allRowKeys = new Set(rowsByKey.keys());
    if (consumedRowKeys.size !== allRowKeys.size) {
      const unconsumed = [...allRowKeys].filter(k => !consumedRowKeys.has(k));
      throw new Error(
        `Verified Page import changed during capture: page_index row(s) without a matching verified record ` +
          `in the active import (${unconsumed.join(', ')}).`,
      );
    }

    const out: PageSnapshotRecord[] = [];
    for (const record of verifiedRecords) {
      if (record.availability !== 'available') continue;
      const key = `${record.identity.kind}:${record.identity.key}`;
      const row = rowsByKey.get(key)![0];
      let parentPageId: string | null = null;
      let parentPageName: string | null = null;
      if (record.parentRef) {
        const parentRecord = verifiedRecords.find(
          r => `${r.identity.kind}:${r.identity.key}` === `${record.identity.kind}:${record.parentRef}`,
        );
        const parentRow = rowsByKey.get(`${record.identity.kind}:${record.parentRef}`)?.[0];
        if (!parentRecord || !parentRow) {
          throw new Error(
            `Verified Page import changed during capture: no parent page_index row for identity "${key}".`,
          );
        }
        parentPageId = parentRow.id;
        parentPageName = parentRecord.name;
      }
      out.push({
        pageId: row.id,
        pageName: record.name,
        verified: true,
        parentPageId,
        parentPageName,
        identityKind: record.identity.kind,
        identityKey: record.identity.key,
        sourceHash: active.sourceHash,
      });
    }

    if (out.length === 0) {
      // No verified+available rows at all: an unavailable catalog. The
      // run-start readiness gate blocks an enabled Page target (no Page IDs).
      return UNAVAILABLE_PAGE_SNAPSHOT;
    }

    return {
      pageImportId: active.id,
      pageImportHash: active.sourceHash,
      records: out,
      verifiedPageIds: out.map(page => page.pageId),
    };
  })();
}

/**
 * Convert a captured snapshot into the runtime-snapshot Page state. Name-only
 * observations are preserved as review context only when the catalog is
 * unavailable; they never become assignment identities.
 */
export function toPageSnapshotState(
  snapshot: VerifiedPageSnapshot,
  nameOnlyRecords: PageSnapshotRecord[] = [],
): PageSnapshotState {
  if (snapshot.pageImportId && snapshot.records.length > 0) {
    return { state: 'verified', records: snapshot.records };
  }
  return { state: 'no_verified_page_catalog', nameOnlyRecords };
}
