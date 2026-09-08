/**
 * Slice 5a — onboarding stage-vocabulary bridge repository.
 *
 * Pure storage-version authority + dual-spelling normalization for the D1
 * machine rename. All new stage SQL lives here or in
 * `src/db/onboarding-stage-vocabulary-migration.sql`.
 *
 * Rules (council plan §5.2):
 * - No process/startup/singleton cache of the storage version. Every caller
 *   reads `app_meta.onboarding_stage_vocabulary_version` from the SAME
 *   connection INSIDE the calling transaction (read or write).
 * - Predicates match the semantic stage under EITHER spelling (dual read).
 * - Row updates encode the stage with the DB storage version's spelling
 *   observed in that same transaction (storage-version-dependent write).
 * - Unknown storage versions and unknown stage literals fail closed.
 */

import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import {
  STAGE_ORDER_V1,
  STAGE_ORDER_V2,
  STAGE_VOCABULARY_VERSION_V1,
  STAGE_VOCABULARY_VERSION_V2,
  V1_TO_V2,
  V2_TO_V1,
  isStageV1String,
  isStageV2String,
  type StageV1,
  type StageV2,
} from '../../shared/onboarding-stage-vocabulary';

export const STAGE_VOCABULARY_META_KEY = 'onboarding_stage_vocabulary_version';
export { STAGE_VOCABULARY_VERSION_V1, STAGE_VOCABULARY_VERSION_V2 };

export const STAGE_V1_SET: ReadonlySet<string> = new Set(STAGE_ORDER_V1 as readonly string[]);
export const STAGE_V2_SET: ReadonlySet<string> = new Set(STAGE_ORDER_V2 as readonly string[]);

export const V1_TO_V2_MAP: Readonly<Record<string, string>> = Object.freeze({ ...(V1_TO_V2 as Record<string, string>) });
export const V2_TO_V1_MAP: Readonly<Record<string, string>> = Object.freeze({ ...(V2_TO_V1 as Record<string, string>) });

export type StorageVersion = 1 | 2;

export class StageStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageStorageError';
  }
}

type DbHandle = ReturnType<typeof getDb>;

function readVersionRow(db: DbHandle): string | null {
  const row = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get(STAGE_VOCABULARY_META_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Read the storage version inside the caller's transaction. Absent = v1. */
export function readStorageVersion(db: DbHandle): StorageVersion {
  const raw = readVersionRow(db);
  if (raw === null) return 1;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  throw new StageStorageError(`Unknown ${STAGE_VOCABULARY_META_KEY}: ${raw}`);
}

/** Fail startup on unsupported version combos. VITE_* never chooses storage. */
export function assertSupportedStorageVersion(db: DbHandle): StorageVersion {
  return readStorageVersion(db);
}

/** Canonical (v2) semantic of any known stored literal; rejects unknown/null. */
export function toCanonicalStored(raw: unknown): StageV2 {
  if (isStageV2String(raw)) return raw;
  if (isStageV1String(raw)) return V1_TO_V2[raw];
  throw new StageStorageError(`Unknown onboarding stage value: ${String(raw)}`);
}

/** Storage-version-dependent write encoding for a canonical stage. */
export function encodeForStorage(canonical: StageV2, version: StorageVersion): string {
  if (version === 2) return canonical;
  const v1: StageV1 = V2_TO_V1[canonical];
  if (!v1) throw new StageStorageError(`Cannot encode stage ${canonical} for v1 storage`);
  return v1;
}

/** Accept canonical input (v2) or a known stored literal; return canonical. */
export function normalizeToCanonical(input: unknown): StageV2 {
  return toCanonicalStored(input);
}

/** SQL fragment matching a semantic stage under either spelling. */
export function stagePredicate(column: string): string {
  return `(${column} = ? OR ${column} = ?)`;
}

/** Bound params [v1, v2] for a canonical stage predicate. */
export function stagePredicateParams(canonical: StageV2): [string, string] {
  return [V2_TO_V1[canonical], canonical];
}

/** All twelve known literals (dual-read universe). */
export function allKnownStageLiterals(): string[] {
  return [...(STAGE_ORDER_V1 as readonly string[]), ...(STAGE_ORDER_V2 as readonly string[])];
}

export interface StageInventory {
  storageVersion: StorageVersion;
  perLiteral: Array<{ stage: string; status: string; count: number }>;
  unknownRows: Array<{ stage: string | null; count: number }>;
}

/** Read-only inventory: per-literal×status counts + unknown/null bucket. */
export function inventoryStageUsage(db: DbHandle): StageInventory {
  const version = readStorageVersion(db);
  const rows = db
    .query('SELECT stage, stage_status AS status, COUNT(*) AS count FROM onboarding_items GROUP BY stage, stage_status ORDER BY stage, status')
    .all() as Array<{ stage: string | null; status: string; count: number }>;
  const perLiteral: StageInventory['perLiteral'] = [];
  const unknownRows: StageInventory['unknownRows'] = [];
  for (const row of rows) {
    if (typeof row.stage === 'string' && (STAGE_V1_SET.has(row.stage) || STAGE_V2_SET.has(row.stage))) {
      perLiteral.push({ stage: row.stage, status: row.status, count: row.count });
    } else {
      unknownRows.push({ stage: row.stage, count: row.count });
    }
  }
  return { storageVersion: version, perLiteral, unknownRows };
}

export interface MigrationPreconditions {
  storageVersion: StorageVersion;
  operatorStateVersion: string | null;
  unknownCount: number;
}

/** Precondition/order validation for the sanctioned flip (NOT a backfill). */
export function checkMigrationPreconditions(db: DbHandle): MigrationPreconditions {
  const version = readStorageVersion(db);
  const opRow = db.query('SELECT value FROM app_meta WHERE key = ?').get('operator_state_schema_version') as
    | { value: string }
    | undefined;
  const unknown = db.query(
    `SELECT COUNT(*) AS cnt FROM onboarding_items WHERE stage IS NULL OR stage NOT IN (${allKnownStageLiterals().map(() => '?').join(',')})`,
  ).get(...allKnownStageLiterals()) as { cnt: number };
  return { storageVersion: version, operatorStateVersion: opRow?.value ?? null, unknownCount: unknown.cnt };
}

export type MigrationCheckpoint =
  | 'after-preconditions'
  | 'after-stage-1'
  | 'after-stage-2'
  | 'after-stage-3'
  | 'after-stage-4'
  | 'after-stage-5'
  | 'after-stage-6'
  | 'after-invariant-verification'
  | 'after-version-marker'
  | 'after-maintenance-receipt'
  | 'before-commit';

/** Test-only synchronous failure hook. Production passes none. */
export type MigrationFailureHook = (checkpoint: MigrationCheckpoint) => void;

const STAGE_UPDATE_PAIRS: Array<[StageV1, StageV2]> = [
  ['sourcing', 'route_sources'],
  ['discovery', 'find_product_page'],
  ['extraction', 'collect_details'],
  ['curation', 'prepare_listing'],
  ['review', 'review_listings'],
  ['promotion', 'create_drafts'],
];

export interface MigrationResult {
  storageVersionBefore: StorageVersion;
  perStageUpdated: Array<{ from: StageV1; to: StageV2; changes: number }>;
  rerunNoop: boolean;
}

/**
 * Transactional migration seam: six stage-only updates + version marker +
 * maintenance receipt, atomically. Must be called with writers quiesced and
 * the exclusive maintenance gate held by the caller.
 */
export function runStageVocabularyMigration(
  db: DbHandle,
  opts: { expectedSourceIdentity?: string; failureHook?: MigrationFailureHook } = {},
): MigrationResult {
  const before = readStorageVersion(db);
  const pre = checkMigrationPreconditions(db);
  if (pre.operatorStateVersion !== '2') {
    throw new StageStorageError(
      `Refusing stage migration: operator_state_schema_version=${pre.operatorStateVersion ?? 'absent'} (need '2', deferred marker-1→2 hop first)`,
    );
  }
  if (pre.unknownCount > 0) {
    throw new StageStorageError(`Refusing stage migration: ${pre.unknownCount} unknown/null stage rows`);
  }
  if (before === 2) {
    return { storageVersionBefore: before, perStageUpdated: [], rerunNoop: true };
  }
  const fail = (cp: MigrationCheckpoint): void => {
    opts.failureHook?.(cp);
  };
  const now = new Date().toISOString();
  let perStageUpdated: MigrationResult['perStageUpdated'] = [];
  const txn = db.transaction(() => {
    fail('after-preconditions');
    perStageUpdated = [];
    const labels: MigrationCheckpoint[] = ['after-stage-1', 'after-stage-2', 'after-stage-3', 'after-stage-4', 'after-stage-5', 'after-stage-6'];
    STAGE_UPDATE_PAIRS.forEach(([from, to], i) => {
      const res = db.query('UPDATE onboarding_items SET stage = ? WHERE stage = ?').run(to, from);
      perStageUpdated.push({ from, to, changes: Number(res.changes ?? 0) });
      fail(labels[i]);
    });
    const leftover = db.query(
      `SELECT COUNT(*) AS cnt FROM onboarding_items WHERE stage IN (${(STAGE_ORDER_V1 as readonly string[]).map(() => '?').join(',')})`,
    ).get(...(STAGE_ORDER_V1 as readonly string[])) as { cnt: number };
    if (leftover.cnt > 0) throw new StageStorageError(`Invariant failed: ${leftover.cnt} v1 stage rows remain`);
    fail('after-invariant-verification');
    db.query("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      STAGE_VOCABULARY_META_KEY,
      '2',
    );
    fail('after-version-marker');
    db.query(
      `CREATE TABLE IF NOT EXISTS onboarding_stage_migration_receipts (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL, per_stage_json TEXT NOT NULL, source_identity TEXT
      )`,
    ).run();
    db.query(
      'INSERT INTO onboarding_stage_migration_receipts (id, created_at, from_version, to_version, per_stage_json, source_identity) VALUES (?, ?, 1, 2, ?, ?)',
    ).run(randomUUID(), now, JSON.stringify(perStageUpdated), opts.expectedSourceIdentity ?? null);
    fail('after-maintenance-receipt');
    fail('before-commit');
  });
  txn();
  return { storageVersionBefore: before, perStageUpdated, rerunNoop: false };
}

/** Counts/digests helper for acceptance (semantic, version-independent). */
export function stageMatrixCounts(db: DbHandle): Array<{ canonical: StageV2; status: string; count: number }> {
  const rows = db
    .query('SELECT stage, stage_status AS status, COUNT(*) AS count FROM onboarding_items GROUP BY stage, stage_status')
    .all() as Array<{ stage: string; status: string; count: number }>;
  const out = new Map<string, { canonical: StageV2; status: string; count: number }>();
  for (const row of rows) {
    const canonical = toCanonicalStored(row.stage);
    const key = `${canonical}::${row.status}`;
    const prev = out.get(key);
    out.set(key, { canonical, status: row.status, count: (prev?.count ?? 0) + row.count });
  }
  return [...out.values()].sort((a, b) => a.canonical.localeCompare(b.canonical) || a.status.localeCompare(b.status));
}
