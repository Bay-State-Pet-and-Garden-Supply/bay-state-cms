import { getDb } from '../connection';
import type { StrategySourceRef } from '../../shared/schemas/brand-strategy';
import { getApprovedBrandStrategy } from './brand-strategy-approval-repo';
import { findItemById } from './onboarding-item-repo';
import { findBatchById } from './onboarding-batch-repo';
import { getCurrentSourcingGeneration } from './onboarding-evidence-repo';
import { getBrandSourcingConfig } from './distributor-repo';

/** Versioned generation binding — the only supported version fails closed otherwise. */
export const STRATEGY_BINDING_VERSION = 'strategy-binding-v1';

export type GenerationStrategyBinding =
  | {
      version: typeof STRATEGY_BINDING_VERSION;
      mode: 'approved';
      strategyRevision: number;
      strategyBrand: string;
      sources: StrategySourceRef[];
      preferredDistributorIds: string[];
    }
  | {
      version: typeof STRATEGY_BINDING_VERSION;
      mode: 'legacy_advisory';
    };

interface SnapshotRow {
  sourcing_generation_id: string;
  workspace_id: string;
  item_id: string;
  mode: string;
  strategy_revision: number | null;
  normalized_brand: string | null;
  sources_json: string;
  preferred_distributor_ids_json: string;
  binding_version: string;
  captured_at: string;
  created_at: string;
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function parseBinding(row: SnapshotRow): GenerationStrategyBinding {
  if (row.binding_version !== STRATEGY_BINDING_VERSION) {
    throw codedError('binding_invalid', `binding_invalid: unsupported strategy binding version '${row.binding_version}'`);
  }
  if (row.mode === 'approved') {
    let sources: unknown;
    let preferred: unknown;
    try {
      sources = JSON.parse(row.sources_json);
    } catch {
      throw codedError('binding_invalid', 'binding_invalid: corrupt strategy binding sources');
    }
    try {
      preferred = JSON.parse(row.preferred_distributor_ids_json);
    } catch {
      throw codedError('binding_invalid', 'binding_invalid: corrupt strategy binding preferences');
    }
    if (!Array.isArray(sources) || !Array.isArray(preferred)) {
      throw codedError('binding_invalid', 'binding_invalid: corrupt strategy binding payload');
    }
    if (!Number.isInteger(row.strategy_revision) || (row.strategy_revision as number) < 1 || !row.normalized_brand) {
      throw codedError('binding_invalid', 'binding_invalid: corrupt approved strategy binding');
    }
    return {
      version: STRATEGY_BINDING_VERSION,
      mode: 'approved',
      strategyRevision: row.strategy_revision as number,
      strategyBrand: row.normalized_brand as string,
      sources: sources as StrategySourceRef[],
      preferredDistributorIds: (preferred as unknown[]).filter((v): v is string => typeof v === 'string'),
    };
  }
  if (row.mode === 'legacy_advisory') {
    return { version: STRATEGY_BINDING_VERSION, mode: 'legacy_advisory' };
  }
  throw codedError('binding_invalid', `binding_invalid: unknown strategy binding mode '${row.mode}'`);
}

function ensureTables(): void {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS sourcing_generation_strategy_snapshots (
    sourcing_generation_id TEXT PRIMARY KEY REFERENCES sourcing_generations(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('approved', 'legacy_advisory')),
    strategy_revision INTEGER, normalized_brand TEXT,
    sources_json TEXT NOT NULL DEFAULT '[]', preferred_distributor_ids_json TEXT NOT NULL DEFAULT '[]',
    binding_version TEXT NOT NULL DEFAULT 'strategy-binding-v1',
    captured_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
}

/**
 * Capture-or-read the strategy binding for a generation, within one
 * transaction. Writes once before first work; concurrent captures re-read
 * the stored winner. Validates generation/item/workspace ownership and
 * current-generation eligibility. A generation that already holds evidence
 * but no binding is pre-builder/uncertain and fails closed (explicit new
 * generation required) — history is preserved, never stamped with today's
 * approval.
 */
export function captureGenerationStrategyBinding(input: {
  workspaceId: string;
  itemId: string;
  generationId: string;
}): GenerationStrategyBinding {
  ensureTables();
  const db = getDb();
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    const generation = db.query('SELECT id, item_id, status FROM sourcing_generations WHERE id = ?').get(input.generationId) as
      | { id: string; item_id: string; status: string }
      | undefined;
    if (!generation || generation.item_id !== input.itemId) {
      throw codedError('binding_invalid', 'binding_invalid: unknown sourcing generation for this item');
    }
    const item = findItemById(input.itemId);
    if (!item) throw codedError('binding_invalid', 'binding_invalid: unknown onboarding item');
    const batch = findBatchById((item as { batchId: string }).batchId);
    if (!batch || (batch as { workspaceId: string }).workspaceId !== input.workspaceId) {
      throw codedError('binding_invalid', 'binding_invalid: item is not owned by this workspace');
    }
    const current = getCurrentSourcingGeneration(input.itemId);
    if (!current || current.id !== input.generationId) {
      throw codedError('binding_stale', 'binding_stale: generation was superseded before binding');
    }
    const existing = db.query('SELECT * FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id = ?').get(input.generationId) as
      | SnapshotRow
      | undefined;
    if (existing) {
      if (existing.workspace_id !== input.workspaceId || existing.item_id !== input.itemId) {
        throw codedError('binding_invalid', 'binding_invalid: binding owner mismatch');
      }
      return parseBinding(existing);
    }
    const evidenceCount = (
      db.query('SELECT COUNT(*) AS n FROM onboarding_evidence_attempts WHERE sourcing_generation_id = ?').get(input.generationId) as
        | { n: number }
        | undefined
    )?.n ?? 0;
    if (evidenceCount > 0) {
      // Pre-builder work is already durable: never attribute today's
      // approval to old evidence. Require an explicit new generation.
      throw codedError('binding_uncertain', 'binding_uncertain: generation has evidence but no strategy binding; retry in a new generation');
    }

    const brandHint = (item as { brandHint?: string | null }).brandHint ?? null;
    const approved = getApprovedBrandStrategy(input.workspaceId, brandHint);
    let mode: 'approved' | 'legacy_advisory' = 'legacy_advisory';
    let revision: number | null = null;
    let normalizedBrand: string | null = null;
    let sourcesJson = '[]';
    let preferredJson = '[]';
    if (approved) {
      mode = 'approved';
      revision = approved.revision;
      normalizedBrand = approved.normalizedBrand;
      sourcesJson = JSON.stringify(approved.sources);
      const config = getBrandSourcingConfig(input.workspaceId, brandHint);
      preferredJson = JSON.stringify(config?.preferredDistributorIds ?? []);
    }
    try {
      db.query(`INSERT INTO sourcing_generation_strategy_snapshots
        (sourcing_generation_id, workspace_id, item_id, mode, strategy_revision, normalized_brand,
         sources_json, preferred_distributor_ids_json, binding_version, captured_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.generationId, input.workspaceId, input.itemId, mode, revision, normalizedBrand,
          sourcesJson, preferredJson, STRATEGY_BINDING_VERSION, now, now,
        );
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        const winner = db.query('SELECT * FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id = ?').get(input.generationId) as
          | SnapshotRow
          | undefined;
        if (!winner) throw codedError('binding_invalid', 'binding_invalid: concurrent binding race left no row');
        return parseBinding(winner);
      }
      throw err;
    }
    const row = db.query('SELECT * FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id = ?').get(input.generationId) as
      | SnapshotRow
      | undefined;
    if (!row) throw codedError('binding_invalid', 'binding_invalid: binding capture left no row');
    return parseBinding(row);
  });

  return run() as GenerationStrategyBinding;
}

/** Read a captured binding (null when none). Corrupt rows fail closed. */
export function getGenerationStrategyBinding(generationId: string): GenerationStrategyBinding | null {
  ensureTables();
  const db = getDb();
  let row: SnapshotRow | undefined;
  try {
    row = db.query('SELECT * FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id = ?').get(generationId) as
      | SnapshotRow
      | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  return parseBinding(row);
}
