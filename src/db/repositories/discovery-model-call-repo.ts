/**
 * Discovery-scoped model-call repository (issue #364).
 *
 * Durable per-call observability for the `sitemap_selection` protected
 * TypeSafe dispatch, bound to an `onboarding_discovery_runs` id. The shared
 * `classification_model_calls` table cannot hold those ids
 * (`run_id REFERENCES classification_runs(id)` with FK enforcement) and must
 * not be weakened (classification orphan-integrity relies on it), so the
 * sitemap selector persists its start/terminal audit rows here instead.
 *
 * Shape mirrors `classification-model-call-repo.ts`: insert the `started` row
 * BEFORE transport (throws on failure so the wrapper never transports without
 * a durable start row), complete it to a terminal status on every path that
 * transported, and insert terminal-only rows for paths that decided before
 * transport (`policy_denied`, `unavailable`, `failed` pre-dispatch).
 *
 * Only prompt hashes are stored — never prompt bodies, credentials, or
 * remote response bodies.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { redactTransportText } from '../../classification/model-policy-gateway';

const now = () => new Date().toISOString();

export type DiscoveryModelCallStatus = 'started' | 'success' | 'failed' | 'policy_denied' | 'unavailable';

export interface DiscoveryModelCallStartInput {
  runId: string;
  operation: string;
  attempt: number;
  provider: string | null;
  model: string | null;
  requestedModel?: string | null;
  locality: string | null;
  snapshotHash: string;
  modelPolicyDigest: string;
  promptTemplateVersion: string;
  ruleVersion: string;
  promptHash: string;
}

export interface DiscoveryModelCallTerminalUpdate {
  status: Exclude<DiscoveryModelCallStatus, 'started'>;
  /** ISO timestamp when the call ended. */
  endedAt?: string;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Bounded, redacted reason/error — never a raw provider body. */
  errorMessage?: string | null;
  resolvedModel?: string | null;
  typedResultMetadata?: Record<string, unknown> | null;
}

export interface DiscoveryModelCallRow {
  id: string;
  run_id: string;
  operation: string;
  attempt: number;
  provider: string | null;
  model: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  typed_result_metadata_json: string | null;
  locality: string | null;
  snapshot_hash: string;
  model_policy_digest: string;
  prompt_template_version: string;
  rule_version: string;
  prompt_hash: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  status: DiscoveryModelCallStatus;
  error_message: string | null;
  created_at: string;
}

/**
 * Insert the `started` audit row BEFORE transport. Throws on insert failure so
 * the wrapper never transports without a durable start row.
 */
export function insertDiscoveryModelCallStart(input: DiscoveryModelCallStartInput): string {
  const id = randomUUID();
  const db = getDb();
  const requestedModel = input.requestedModel ?? input.model;
  db.run(
    `INSERT INTO discovery_model_calls
     (id, run_id, operation, attempt, provider, model, requested_model, locality, snapshot_hash,
      model_policy_digest, prompt_template_version, rule_version, prompt_hash,
      started_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.operation,
      input.attempt,
      input.provider,
      input.model,
      requestedModel,
      input.locality,
      input.snapshotHash,
      input.modelPolicyDigest,
      input.promptTemplateVersion,
      input.ruleVersion,
      input.promptHash,
      now(),
      'started',
      now(),
    ],
  );
  return id;
}

/**
 * Update a `started` row to a terminal status. Returns `false` when the row is
 * missing or already terminal (the wrapper must then discard the output —
 * never trust an output whose terminal row is not durable).
 */
export function completeDiscoveryModelCall(callId: string, update: DiscoveryModelCallTerminalUpdate): boolean {
  const db = getDb();
  const typedResultJson = update.typedResultMetadata != null ? JSON.stringify(update.typedResultMetadata) : null;
  const result = db.run(
    `UPDATE discovery_model_calls SET
       status = ?, ended_at = ?, duration_ms = ?, prompt_tokens = ?, completion_tokens = ?,
       error_message = ?,
       resolved_model = COALESCE(?, resolved_model),
       typed_result_metadata_json = COALESCE(?, typed_result_metadata_json)
     WHERE id = ? AND status = 'started'`,
    [
      update.status,
      update.endedAt ?? now(),
      update.durationMs ?? null,
      update.promptTokens ?? null,
      update.completionTokens ?? null,
      update.errorMessage != null ? redactTransportText(String(update.errorMessage)) : null,
      update.resolvedModel ?? null,
      typedResultJson,
      callId,
    ],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Insert a terminal call row directly (no transport happened). Used for
 * `policy_denied` (route denial before fetch), `unavailable` (no model
 * configured), and `failed` pre-dispatch (lease lost before dispatch) so
 * every attempted protected selection is observable.
 */
export function insertDiscoveryModelCallTerminal(
  input: Omit<DiscoveryModelCallStartInput, 'provider' | 'model'> & {
    provider: string | null;
    model: string | null;
    resolvedModel?: string | null;
    typedResultMetadata?: Record<string, unknown> | null;
    status: 'policy_denied' | 'unavailable' | 'failed' | 'success';
    errorMessage?: string | null;
  },
): string {
  const id = randomUUID();
  const db = getDb();
  const requestedModel = input.requestedModel ?? input.model;
  const resolvedModel = input.resolvedModel ?? input.model;
  const typedResultJson = input.typedResultMetadata != null ? JSON.stringify(input.typedResultMetadata) : null;
  db.run(
    `INSERT INTO discovery_model_calls
     (id, run_id, operation, attempt, provider, model, requested_model, resolved_model, typed_result_metadata_json, locality, snapshot_hash,
      model_policy_digest, prompt_template_version, rule_version, prompt_hash,
      started_at, ended_at, duration_ms, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.operation,
      input.attempt,
      input.provider,
      input.model,
      requestedModel,
      resolvedModel,
      typedResultJson,
      input.locality,
      input.snapshotHash,
      input.modelPolicyDigest,
      input.promptTemplateVersion,
      input.ruleVersion,
      input.promptHash,
      now(),
      now(),
      0,
      input.status,
      input.errorMessage != null ? redactTransportText(String(input.errorMessage)) : null,
      now(),
    ],
  );
  return id;
}

/** All model-call rows for a discovery run (ascending by start time). */
export function getDiscoveryModelCallsByRun(runId: string): DiscoveryModelCallRow[] {
  return getDb()
    .query('SELECT * FROM discovery_model_calls WHERE run_id = ? ORDER BY started_at ASC, rowid ASC')
    .all(runId) as unknown as DiscoveryModelCallRow[];
}

export function getDiscoveryModelCallById(callId: string): DiscoveryModelCallRow | null {
  const row = getDb()
    .query('SELECT * FROM discovery_model_calls WHERE id = ?')
    .get(callId) as Record<string, unknown> | undefined;
  return row ? (row as unknown as DiscoveryModelCallRow) : null;
}

/**
 * Verify every listed call ID belongs to the given discovery run AND snapshot
 * hash. Returns the missing/foreign call IDs; an empty array means full
 * linkage. Fails closed (callers must not persist proposals whose call rows
 * are foreign).
 */
export function verifyDiscoveryModelCallsBelongToRun(
  runId: string,
  snapshotHash: string,
  callIds: string[],
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const db = getDb();
  for (const callId of callIds) {
    const row = db
      .query(
        'SELECT run_id, snapshot_hash FROM discovery_model_calls WHERE id = ?',
      )
      .get(callId) as { run_id: string; snapshot_hash: string | null } | undefined;
    if (!row || row.run_id !== runId || row.snapshot_hash !== snapshotHash) {
      missing.push(callId);
    }
  }
  return { ok: missing.length === 0, missing };
}
