/**
 * Classification model-call repository (issue #17 work item E).
 *
 * Durable per-call observability for protected model calls bound to a
 * classification run. A call row is inserted as `started` BEFORE transport and
 * updated to a terminal status on every path. Only hashes are stored (prompt
 * hashes, policy digest, snapshot hash) — never prompt bodies, credentials, or
 * remote response bodies. Legacy `curation_model_calls` is deprecated and
 * intentionally untouched.
 *
 * Fail-closed invariants:
 * - No audit start row means no transport (the wrapper aborts before `fetch`).
 * - No durable terminal update means the model output is discarded and cannot
 *   reach a proposal.
 * - A model call from another run/snapshot cannot be linked to a proposal.
 * - Cost is `0` ONLY for an explicitly local route (`costBasis='local_zero'`);
 *   unknown cloud rates are `null` + `costBasis='unknown'`, never a guessed
 *   zero.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { redactTransportText } from '../../classification/model-policy-gateway';
import { MODEL_CALL_STATUS, COST_BASIS, type ModelCallStatus, type CostBasis } from '../../classification/model-operation-registry';

const now = () => new Date().toISOString();

export interface ModelCallStartInput {
  runId: string;
  stageName: string | null;
  operation: string;
  attempt: number;
  provider: string;
  model: string;
  requestedModel?: string | null;
  locality: string | null;
  snapshotHash: string;
  modelPolicyDigest: string;
  promptTemplateVersion: string;
  ruleVersion: string;
  systemPromptHash: string;
  userPromptHash: string;
}

export interface ModelCallTerminalUpdate {
  status: ModelCallStatus;
  /** ISO timestamp when the call ended. */
  endedAt?: string;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Bounded, redacted reason/error — never a raw provider body. */
  errorMessage?: string | null;
  estimatedCostUsd?: number | null;
  costBasis?: CostBasis | null;
  resolvedModel?: string | null;
  typedResultMetadata?: Record<string, unknown> | null;
}

export interface ModelCallRow {
  id: string;
  run_id: string;
  stage_name: string | null;
  operation: string;
  attempt: number;
  provider: string | null;
  model: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  typed_result_json: string | null;
  locality: string | null;
  snapshot_hash: string | null;
  model_policy_digest: string | null;
  prompt_template_version: string | null;
  rule_version: string | null;
  system_prompt_hash: string | null;
  user_prompt_hash: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  status: ModelCallStatus;
  error_message: string | null;
  estimated_cost_usd: number | null;
  cost_basis: CostBasis | null;
  created_at: string;
}

/**
 * Compute the honest cost estimate for a model call. Local routes are an
 * explicit `local_zero`; unknown cloud rates are `null` + `unknown` — never a
 * guessed zero. No stale hard-coded public pricing is reused.
 */
export function computeModelCallCost(
  locality: string | null,
  _promptTokens: number | null,
  _completionTokens: number | null,
): { estimatedCostUsd: number | null; costBasis: CostBasis } {
  if (locality === 'local') {
    return { estimatedCostUsd: 0, costBasis: COST_BASIS.localZero };
  }
  return { estimatedCostUsd: null, costBasis: COST_BASIS.unknown };
}

/**
 * Insert the `started` audit row BEFORE transport. Throws on insert failure so
 * the wrapper never transports without a durable start row.
 */
export function insertModelCallStart(input: ModelCallStartInput): string {
  const id = randomUUID();
  const db = getDb();
  const requestedModel = input.requestedModel ?? input.model;
  db.run(
    `INSERT INTO classification_model_calls
     (id, run_id, stage_name, operation, attempt, provider, model, requested_model, locality, snapshot_hash,
      model_policy_digest, prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash,
      started_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.stageName,
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
      input.systemPromptHash,
      input.userPromptHash,
      now(),
      MODEL_CALL_STATUS.started,
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
export function completeModelCall(callId: string, update: ModelCallTerminalUpdate): boolean {
  const db = getDb();
  const typedResultJson = update.typedResultMetadata != null ? JSON.stringify(update.typedResultMetadata) : null;
  const result = db.run(
    `UPDATE classification_model_calls SET
       status = ?, ended_at = ?, duration_ms = ?, prompt_tokens = ?, completion_tokens = ?,
       error_message = ?, estimated_cost_usd = ?, cost_basis = ?,
       resolved_model = COALESCE(?, resolved_model),
       typed_result_json = COALESCE(?, typed_result_json)
     WHERE id = ? AND status = 'started'`,
    [
      update.status,
      update.endedAt ?? now(),
      update.durationMs ?? null,
      update.promptTokens ?? null,
      update.completionTokens ?? null,
      update.errorMessage != null ? redactTransportText(String(update.errorMessage)) : null,
      update.estimatedCostUsd ?? null,
      update.costBasis ?? null,
      update.resolvedModel ?? null,
      typedResultJson,
      callId,
    ],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Insert a terminal call row directly (no transport happened). Used for
 * `policy_denied` (route denial before fetch) and `unavailable` (no model
 * configured) so every attempted protected call is observable.
 */
export function insertTerminalModelCall(
  input: Omit<ModelCallStartInput, 'provider' | 'model'> & {
    provider: string | null;
    model: string | null;
    requestedModel?: string | null;
    resolvedModel?: string | null;
    typedResultMetadata?: Record<string, unknown> | null;
    status: 'policy_denied' | 'unavailable' | 'failed';
    errorMessage?: string | null;
    costBasis?: CostBasis | null;
  },
): string {
  const id = randomUUID();
  const db = getDb();
  const requestedModel = input.requestedModel ?? input.model;
  const resolvedModel = input.resolvedModel ?? input.model;
  const typedResultJson = input.typedResultMetadata != null ? JSON.stringify(input.typedResultMetadata) : null;
  db.run(
    `INSERT INTO classification_model_calls
     (id, run_id, stage_name, operation, attempt, provider, model, requested_model, resolved_model, typed_result_json, locality, snapshot_hash,
      model_policy_digest, prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash,
      started_at, ended_at, duration_ms, status, error_message, estimated_cost_usd, cost_basis, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.stageName,
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
      input.systemPromptHash,
      input.userPromptHash,
      now(),
      now(),
      0,
      input.status,
      input.errorMessage != null ? redactTransportText(String(input.errorMessage)) : null,
      input.costBasis === COST_BASIS.localZero ? 0 : null,
      input.costBasis ?? null,
      now(),
    ],
  );
  return id;
}

/**
 * Record a terminal `policy_denied` / `unavailable` row for a protected
 * preflight that decided not to invoke the model (no frozen policy, no LLM
 * config, route denial). Every model-eligible attempt must be observable even
 * when no transport happens. No-op when no audit context is present.
 */
export function recordTerminalPreflight(
  ctx: import('../../classification/model-operation-registry').ModelCallContext | null | undefined,
  modelPolicyDigest: string,
  status: 'policy_denied' | 'unavailable',
  errorMessage: string,
): void {
  if (!ctx) return;
  insertTerminalModelCall({
    runId: ctx.runId,
    stageName: ctx.stage,
    operation: ctx.operation,
    attempt: ctx.attempt,
    provider: null,
    model: null,
    locality: null,
    snapshotHash: ctx.snapshotHash,
    modelPolicyDigest,
    promptTemplateVersion: ctx.promptTemplateVersion,
    ruleVersion: ctx.ruleVersion,
    systemPromptHash: '',
    userPromptHash: '',
    status,
    errorMessage,
    costBasis: COST_BASIS.unknown,
  });
}

/** All model-call rows for a run (ascending by start time). */
export function getModelCallsByRun(runId: string): ModelCallRow[] {
  return getDb()
    .query('SELECT * FROM classification_model_calls WHERE run_id = ? ORDER BY started_at ASC, rowid ASC')
    .all(runId) as unknown as ModelCallRow[];
}

export function getModelCallById(callId: string): ModelCallRow | null {
  const row = getDb()
    .query('SELECT * FROM classification_model_calls WHERE id = ?')
    .get(callId) as Record<string, unknown> | undefined;
  return row ? (row as unknown as ModelCallRow) : null;
}

/**
 * Verify every listed call ID belongs to the given run AND snapshot hash.
 * Returns the missing/foreign call IDs; an empty array means full linkage.
 * Fails closed (callers must not persist proposals whose call rows are foreign).
 */
export function verifyModelCallsBelongToRun(
  runId: string,
  snapshotHash: string,
  callIds: string[],
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const db = getDb();
  for (const callId of callIds) {
    const row = db
      .query(
        'SELECT run_id, snapshot_hash FROM classification_model_calls WHERE id = ?',
      )
      .get(callId) as { run_id: string; snapshot_hash: string | null } | undefined;
    if (!row || row.run_id !== runId || row.snapshot_hash !== snapshotHash) {
      missing.push(callId);
    }
  }
  return { ok: missing.length === 0, missing };
}
