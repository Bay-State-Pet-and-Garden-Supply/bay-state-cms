/**
 * Ticket #122 (A-lite): durable completed strategy-collection envelope.
 *
 * Repository-owned persistence for the versioned multi-contribution
 * collection result (`strategy-collection-v1`). Generation-keyed,
 * write-once, immutable:
 *
 * - `finalizeStrategyCollectionForGeneration` builds the envelope from the
 *   generation's FROZEN approved binding (distributor-only) plus its durable
 *   attempt outcomes and persists it exactly once. An identical rewrite is
 *   idempotent; a divergent rewrite throws `envelope_conflict`. Attempts
 *   alone never prove completion — finalization requires the frozen binding,
 *   current-generation eligibility, and ≥1 durable attempt.
 * - `getStrategyCollectionResult` reads back the validated envelope:
 *   missing / unsupported-version / corrupt / foreign-attempt / hash-mismatch
 *   rows fail closed with stable codes. Generations without a row keep their
 *   legacy interpretation (compat fallback owned by callers, never here).
 *
 * Distributor-only stays profile-free and URL-null: this module performs
 * zero fetch/profile/OCR/model/image work — it reads SQLite rows only.
 */
import { getDb } from '../connection';
import { findItemById } from './onboarding-item-repo';
import { findBatchById } from './onboarding-batch-repo';
import {
  getCurrentSourcingGeneration,
  getEvidenceAttemptsByItemAndGeneration,
} from './onboarding-evidence-repo';
import { getGenerationStrategyBinding } from './brand-strategy-generation-repo';
import { listConnectionsByWorkspace } from './distributor-repo';
import {
  STRATEGY_COLLECTION_RESULT_VERSION,
  CollectionContributionSchema,
  buildStrategyCollectionEnvelope,
  computeStrategyCollectionHash,
  type StrategyCollectionResult,
  type StrategyCollectionAttemptInput,
} from '../../onboarding/sourcing/strategy-collection-result';

export interface FinalizedStrategyCollection {
  envelope: StrategyCollectionResult;
  hash: string;
  attemptInputs: StrategyCollectionAttemptInput[];
  idempotent: boolean;
}

interface CollectionRow {
  sourcing_generation_id: string;
  workspace_id: string;
  item_id: string;
  version: string;
  strategy_revision: number;
  normalized_brand: string;
  contributions_json: string;
  identity_conflict: number;
  collection_hash: string;
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS strategy_collection_results (
    sourcing_generation_id TEXT PRIMARY KEY REFERENCES sourcing_generations(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
    version TEXT NOT NULL DEFAULT 'strategy-collection-v1',
    strategy_revision INTEGER NOT NULL, normalized_brand TEXT NOT NULL,
    contributions_json TEXT NOT NULL DEFAULT '[]', identity_conflict INTEGER NOT NULL DEFAULT 0,
    collection_hash TEXT NOT NULL, captured_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_strategy_collection_results_item ON strategy_collection_results(item_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_strategy_collection_results_workspace ON strategy_collection_results(workspace_id)');
}

/** Validated read: fail closed with stable codes, never a partial envelope. */
export function getStrategyCollectionResult(generationId: string): { envelope: StrategyCollectionResult; hash: string } {
  ensureTable();
  const db = getDb();
  const row = db.query('SELECT * FROM strategy_collection_results WHERE sourcing_generation_id = ?').get(generationId) as
    | CollectionRow
    | undefined;
  if (!row) throw codedError('missing_envelope', 'no completed strategy collection for this generation');
  if (row.workspace_id == null || row.item_id == null) {
    throw codedError('corrupt_envelope', 'strategy collection row is missing ownership');
  }
  if (row.version !== STRATEGY_COLLECTION_RESULT_VERSION) {
    throw codedError('unsupported_version', `unsupported strategy collection version '${row.version}'`);
  }
  let contributions: unknown;
  try {
    contributions = JSON.parse(row.contributions_json);
  } catch {
    throw codedError('corrupt_envelope', 'strategy collection contributions are not valid JSON');
  }
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw codedError('corrupt_envelope', 'strategy collection has no contributions');
  }
  const parsedContributions = [];
  for (const c of contributions) {
    const parsed = CollectionContributionSchema.safeParse(c);
    if (!parsed.success) throw codedError('corrupt_envelope', 'strategy collection contribution failed validation');
    parsedContributions.push(parsed.data);
  }
  // Ownership + attempt-reference validation: every referenced attempt must
  // be a durable row of THIS generation+item (a foreign attempt id smuggled
  // into the JSON fails closed — never trusted).
  const generation = db.query('SELECT id, item_id FROM sourcing_generations WHERE id = ?').get(generationId) as
    | { id: string; item_id: string }
    | undefined;
  if (!generation || generation.item_id !== row.item_id) {
    throw codedError('ownership_mismatch', 'strategy collection generation ownership mismatch');
  }
  const attemptRows = db.query(
    'SELECT id FROM onboarding_evidence_attempts WHERE sourcing_generation_id = ? AND item_id = ?',
  ).all(generationId, row.item_id) as Array<{ id: string }>;
  const known = new Set(attemptRows.map((r) => r.id));
  for (const c of parsedContributions) {
    for (const attemptId of c.attemptIds) {
      if (!known.has(attemptId)) {
        throw codedError('unknown_attempt', 'strategy collection references an attempt outside this generation');
      }
    }
  }
  const envelope: StrategyCollectionResult = {
    version: STRATEGY_COLLECTION_RESULT_VERSION,
    itemId: row.item_id,
    sourcingGenerationId: generationId,
    strategyRevision: row.strategy_revision,
    strategyBrand: row.normalized_brand,
    contributions: parsedContributions,
    identityConflict: row.identity_conflict === 1,
  };
  if (!Number.isInteger(row.strategy_revision) || row.strategy_revision < 1 || !row.normalized_brand) {
    throw codedError('corrupt_envelope', 'strategy collection revision/brand is corrupt');
  }
  if (computeStrategyCollectionHash(envelope) !== row.collection_hash) {
    throw codedError('hash_mismatch', 'strategy collection hash does not match its contributions');
  }
  return { envelope, hash: row.collection_hash };
}

/**
 * Finalize the completed-collection envelope for one generation.
 *
 * Fail-closed coded errors (no write unless every check passes):
 * - `stale_generation` — the generation is not the item's current one;
 * - `missing_binding` / `binding_invalid` — no (or corrupt) frozen binding;
 * - `not_distributor_only` — the frozen boundary is not an approved
 *   distributor-only source set (query_all, official-bearing, or legacy);
 * - `no_attempts` — nothing was attempted (never-started stays setup
 *   attention; only started-and-exhausted work completes);
 * - `envelope_conflict` — a divergent envelope is already finalized.
 */
export function finalizeStrategyCollectionForGeneration(input: {
  workspaceId: string;
  itemId: string;
  generationId: string;
}): FinalizedStrategyCollection {
  ensureTable();
  const db = getDb();

  const item = findItemById(input.itemId);
  if (!item) throw codedError('unknown_item', 'unknown onboarding item');
  const batch = findBatchById((item as { batchId: string }).batchId);
  if (!batch || (batch as { workspaceId: string }).workspaceId !== input.workspaceId) {
    throw codedError('ownership_mismatch', 'item is not owned by this workspace');
  }
  const current = getCurrentSourcingGeneration(input.itemId);
  if (!current || current.id !== input.generationId) {
    throw codedError('stale_generation', 'generation was superseded before collection completed');
  }
  let binding;
  try {
    binding = getGenerationStrategyBinding(input.generationId);
  } catch {
    throw codedError('binding_invalid', 'strategy binding is invalid for this generation');
  }
  if (!binding) throw codedError('missing_binding', 'no strategy binding captured for this generation');
  if (binding.mode !== 'approved') {
    throw codedError('not_distributor_only', 'strategy collection requires an approved strategy boundary');
  }
  if (binding.sources.length === 0 || binding.sources.some((s) => s.kind !== 'distributor_record')) {
    throw codedError('not_distributor_only', 'strategy collection requires an approved distributor-only boundary');
  }

  const attempts = getEvidenceAttemptsByItemAndGeneration(input.itemId, input.generationId);
  if (attempts.length === 0) {
    throw codedError('no_attempts', 'no collection attempts started for this generation');
  }

  const connections = listConnectionsByWorkspace(input.workspaceId, false);
  const distributorByConnection = new Map(connections.map((c) => [c.id, c.distributorId]));
  const enabledDistributors = new Set(
    connections.filter((c) => c.enabled).map((c) => c.distributorId.toLowerCase()),
  );
  const attemptInputs: StrategyCollectionAttemptInput[] = [];
  for (const a of attempts) {
    if (a.outcome !== 'found' && a.outcome !== 'not_stocked' && a.outcome !== 'source_error') continue;
    const distributorId = a.distributorConnectionId
      ? distributorByConnection.get(a.distributorConnectionId) ?? null
      : null;
    if (!distributorId) {
      throw codedError('unknown_connection', 'collection attempt references an unknown connection');
    }
    attemptInputs.push({
      attemptId: a.id,
      connectionId: a.distributorConnectionId as string,
      distributorId,
      providerId: a.providerId,
      outcome: a.outcome,
      errorCode: a.errorCode,
      identityJson: a.identityJson,
    });
  }
  if (attemptInputs.length === 0) {
    throw codedError('no_attempts', 'no usable collection attempts for this generation');
  }
  const attemptedDistributors = new Set(attemptInputs.map((a) => a.distributorId.toLowerCase()));
  const unavailableDistributorIds = binding.sources
    .map((s) => s.distributorId as string)
    .filter((id) => !enabledDistributors.has(id.toLowerCase()) && !attemptedDistributors.has(id.toLowerCase()));

  const built = buildStrategyCollectionEnvelope({
    itemId: input.itemId,
    generationId: input.generationId,
    strategyRevision: binding.strategyRevision,
    strategyBrand: binding.strategyBrand,
    sources: binding.sources,
    attempts: attemptInputs,
    unavailableDistributorIds,
    identityConflict: false,
  });
  if (!built) throw codedError('envelope_invalid', 'collection envelope failed validation');

  const now = new Date().toISOString();
  const existing = db.query('SELECT * FROM strategy_collection_results WHERE sourcing_generation_id = ?').get(input.generationId) as
    | CollectionRow
    | undefined;
  if (existing) {
    if (existing.collection_hash === built.hash) {
      return { envelope: built.result, hash: built.hash, attemptInputs, idempotent: true };
    }
    throw codedError('envelope_conflict', 'a divergent collection envelope is already finalized for this generation');
  }
  db.query(`INSERT INTO strategy_collection_results
    (sourcing_generation_id, workspace_id, item_id, version, strategy_revision, normalized_brand,
     contributions_json, identity_conflict, collection_hash, captured_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.generationId, input.workspaceId, input.itemId, STRATEGY_COLLECTION_RESULT_VERSION,
      binding.strategyRevision, binding.strategyBrand, JSON.stringify(built.result.contributions),
      built.result.identityConflict ? 1 : 0, built.hash, now, now,
    );
  return { envelope: built.result, hash: built.hash, attemptInputs, idempotent: false };
}
