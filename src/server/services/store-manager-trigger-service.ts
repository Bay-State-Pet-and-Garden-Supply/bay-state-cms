/**
 * Store Manager trigger service (operations console, Issue 5).
 *
 * Owns trigger CRUD + the deterministic observation passes and the occurrence
 * dispatch path. Every occurrence enters the single runtime runner
 * (`runStoreManagerExecution`) with entrypoint `event`, execution mode
 * `unattended_read_only`, and actor class `system_event` — the runtime
 * derives the read-only allowlist and denies persistent adapters at registry
 * dispatch, so no trigger can stage, approve, publish, sync, repair, or push
 * even if the model requests it.
 *
 * Observation (plan Locked Decision 8): committed durable state only. A
 * poller records a per-source cursor AFTER the occurrence insert (same
 * transaction); unique occurrence keys make at-least-once observation
 * idempotent. Import-finished is conservative: an occurrence is emitted only
 * when the observation is terminal AND all selected Product SKUs are known;
 * otherwise a `diagnostic` occurrence is recorded and no run is created.
 */

import { randomUUID } from 'node:crypto';
import { hashCanonicalJson } from '../../shared/stable-id';
import type {
  StoreManagerExecutionDeps,
  StoreManagerExecutionResult,
} from '../../store-manager/runtime/executor';
import { runStoreManagerExecution } from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import { createStoreManagerArtifact } from '../../store-manager/runtime/artifacts';
import type { StoreManagerPinnedScope, StoreManagerPolicyProfile } from '../../shared/schemas/store-manager-operations';
import type {
  StoreManagerTriggerConfig,
  StoreManagerTriggerDefinition,
  StoreManagerTriggerKind,
  StoreManagerTriggerOccurrence,
} from '../../shared/schemas/store-manager-trigger';
import { ModelUnavailableError } from './ai-sdk-model-resolver';
import { toCanonicalStored } from '../../db/repositories/onboarding-stage-vocabulary-repo';
import {
  createTrigger,
  getTrigger,
  listTriggers,
  updateTriggerDefinition,
  setTriggerEnabled,
  updateTriggerScanState,
  createTriggerOccurrence,
  getTriggerOccurrence,
  finalizeTriggerOccurrence,
  requeueTriggerOccurrence,
  claimTriggerOccurrence,
  getSourceCursor,
  upsertSourceCursor,
  type TriggerDefinitionRow,
} from '../../db/repositories/store-manager-trigger-repo';
import {
  listApprovedChangeSetsForObservation,
  getChangeSetWithItemsForWorkspace,
} from '../../db/repositories/change-set-repo';
import { listFailedSyncJobsForObservation } from '../../db/repositories/sync-job-repo';
import { countProposalsByField } from '../../db/repositories/catalog-health-proposal-repo';
import {
  listBatchesForObservation,
  listItemsForBatchObservation,
  type OnboardingItemObservation,
} from '../../db/repositories/store-manager-source-observer-repo';
import { createStoreManagerRunArtifact, getStoreManagerSession } from '../../db/repositories/store-manager-session-repo';
import { reconcileInbox } from './store-manager-inbox-service';
import { evaluateNotificationRules } from './store-manager-notification-service';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import {
  resolveStoreManagerScopeRequest,
  StoreManagerScopeError,
} from './store-manager-scope-service';
import { getTriggerTemplate } from '../../store-manager/events/trigger-registry';

// ---------------------------------------------------------------------------
// Redaction + bounded evidence helpers
// ---------------------------------------------------------------------------

const URL_TOKEN = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_TOKEN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Redact obvious credential/URL/email material from stored sync evidence. */
export function redactSyncEvidence(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(URL_TOKEN, '[url redacted]')
    .replace(EMAIL_TOKEN, '[email redacted]')
    .replace(/(password|passwd|api[_-]?key|token|secret|authorization)[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 400);
}

export interface RedactedSyncEvidence {
  errorClass: string;
  summary: string;
  changeSetId: string | null;
  kind: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Bounded, redacted evidence summary for a failed sync job. */
export function buildRedactedSyncEvidence(input: {
  errorSummary: string | null;
  kind: string;
  changeSetId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}): RedactedSyncEvidence {
  const summary = redactSyncEvidence(input.errorSummary);
  return {
    errorClass: (summary.slice(0, 24) || 'sync_failed').toUpperCase(),
    summary,
    changeSetId: input.changeSetId ? input.changeSetId.slice(0, 64) : null,
    kind: input.kind.slice(0, 50),
    startedAt: input.startedAt ? input.startedAt.slice(0, 40) : null,
    completedAt: input.completedAt ? input.completedAt.slice(0, 40) : null,
  };
}

// ---------------------------------------------------------------------------
// CRUD (mirrors the schedule service; triggers are created disabled)
// ---------------------------------------------------------------------------

function definitionHashFor(
  input: Pick<StoreManagerTriggerDefinition, 'workspaceId' | 'name' | 'kind' | 'config' | 'scope' | 'selectedModel' | 'objective'>,
): string {
  return hashCanonicalJson(input);
}

export interface CreateTriggerResult {
  trigger: TriggerDefinitionRow;
}

/**
 * Create a trigger from one of the four locked templates. `enabled` always
 * defaults false — automation is inert until explicitly enabled.
 */
export function createTriggerFromTemplate(
  workspaceId: string,
  input: {
    kind: StoreManagerTriggerKind;
    name: string;
    config?: StoreManagerTriggerConfig;
    scope?: StoreManagerPinnedScope;
    selectedModel?: string;
  },
): CreateTriggerResult {
  const template = getTriggerTemplate(input.kind);
  if (!template) throw new Error(`Unknown trigger kind "${input.kind}".`);
  let config = input.config;
  if (!config) {
    config = template.defaultConfig;
  } else if (config.kind !== input.kind) {
    throw new Error(`Trigger config kind "${config.kind}" does not match trigger kind "${input.kind}".`);
  }
  if (config.kind === 'import_finished' && config.batchId) {
    // The batch must exist in this workspace (workspace-scoped validation).
    const batches = listBatchesForObservation(workspaceId, 500);
    if (!batches.some((b) => b.id === config.batchId)) {
      throw new Error(`Onboarding Batch "${config.batchId}" not found in this workspace.`);
    }
  }
  if (config.kind === 'product_field_drift' && config.threshold < 1) {
    throw new Error('product_field_drift threshold must be >= 1.');
  }
  let scope: StoreManagerPinnedScope | null = input.scope ?? null;
  if (scope) {
    try {
      const resolved = resolveStoreManagerScopeRequest(workspaceId, scope);
      scope = resolved?.pinnedScope ?? null;
    } catch (err) {
      if (err instanceof StoreManagerScopeError) {
        throw new Error(`Invalid trigger scope: ${err.message}`);
      }
      throw err;
    }
  }
  const base = {
    workspaceId,
    name: input.name,
    kind: input.kind,
    config,
    scope,
    selectedModel: input.selectedModel ?? null,
    objective: template.objective,
  };
  const definitionHash = definitionHashFor(base);
  const trigger = createTrigger({
    workspaceId,
    name: input.name,
    kind: input.kind,
    config,
    scopeJson: scope ? JSON.stringify(scope) : null,
    selectedModel: input.selectedModel ?? null,
    objective: template.objective,
    definitionHash,
    enabled: false,
  });
  return { trigger };
}

export function listTriggersForWorkspace(workspaceId: string): TriggerDefinitionRow[] {
  return listTriggers(workspaceId);
}

export function getTriggerForWorkspace(workspaceId: string, id: string): TriggerDefinitionRow | null {
  return getTrigger(workspaceId, id);
}

/** Update editable fields (name/config/scope/model). Never the kind. */
export function updateTriggerForWorkspace(
  workspaceId: string,
  id: string,
  patch: {
    name?: string;
    config?: StoreManagerTriggerConfig;
    scope?: StoreManagerPinnedScope | null;
    selectedModel?: string | null;
  },
): TriggerDefinitionRow {
  const existing = getTrigger(workspaceId, id);
  if (!existing) throw new Error('Trigger not found in this workspace.');
  const config = patch.config ?? existing.config;
  if (config.kind !== existing.kind) {
    throw new Error('Trigger kind cannot change.');
  }
  if (config.kind === 'import_finished' && config.batchId) {
    const batches = listBatchesForObservation(workspaceId, 500);
    if (!batches.some((b) => b.id === config.batchId)) {
      throw new Error(`Onboarding Batch "${config.batchId}" not found in this workspace.`);
    }
  }
  let scope: StoreManagerPinnedScope | null;
  if (patch.scope !== undefined) {
    scope = patch.scope;
    if (scope) {
      try {
        const resolved = resolveStoreManagerScopeRequest(workspaceId, scope);
        scope = resolved?.pinnedScope ?? null;
      } catch (err) {
        if (err instanceof StoreManagerScopeError) {
          throw new Error(`Invalid trigger scope: ${err.message}`);
        }
        throw err;
      }
    }
  } else {
    scope = existing.scope;
  }
  const base = {
    workspaceId,
    name: patch.name ?? existing.name,
    kind: existing.kind,
    config,
    scope,
    selectedModel: patch.selectedModel !== undefined ? patch.selectedModel : existing.selectedModel,
    objective: existing.objective,
  };
  const definitionHash = definitionHashFor(base);
  return updateTriggerDefinition(workspaceId, id, {
    name: base.name,
    config,
    scopeJson: scope ? JSON.stringify(scope) : null,
    selectedModel: base.selectedModel,
    objective: base.objective,
    definitionHash,
  });
}

export function setTriggerEnabledForWorkspace(
  workspaceId: string,
  id: string,
  enabled: boolean,
  actor: string,
): TriggerDefinitionRow | null {
  const audit = hashCanonicalJson({ actor, enabled, at: new Date().toISOString() });
  return setTriggerEnabled(workspaceId, id, enabled, audit);
}

// ---------------------------------------------------------------------------
// Observation passes (deterministic; committed durable state only)
// ---------------------------------------------------------------------------

export interface ObservationResult {
  triggerId: string;
  kind: StoreManagerTriggerKind;
  occurrences: number;
  diagnostics: number;
  error: string | null;
}

function scopeJsonFor(scope: StoreManagerPinnedScope | null | undefined): string | null {
  return scope ? JSON.stringify(scope) : null;
}

/** Terminal predicate per item (see module header for the vocabulary).
 * Slice 5b native: canonical comparison (dual read — the observer passes
 * stored v1 rows through byte-identical and refuses v2/unknown, so every
 * observed literal normalizes here without misreading terminal state). */
function classifyItem(item: OnboardingItemObservation):
  | { terminal: true; sku: string | null }
  | { terminal: false; reason: string } {
  if (item.isDuplicate && item.existingSku) {
    return { terminal: true, sku: item.existingSku };
  }
  if (toCanonicalStored(item.stage) === 'create_drafts' && item.stageStatus === 'completed') {
    return { terminal: true, sku: item.upc.trim() ? item.upc : null };
  }
  if (item.stageStatus === 'skipped' || item.stageStatus === 'failed') {
    return { terminal: true, sku: null };
  }
  return { terminal: false, reason: `${item.stage}/${item.stageStatus}` };
}

/**
 * Conservative import-finished observation for one batch. Emits an occurrence
 * only when every item is terminal AND every promoted item's SKU is known;
 * otherwise records a diagnostic occurrence (never a guessed completion).
 */
function observeImportFinishedBatch(
  workspaceId: string,
  trigger: TriggerDefinitionRow,
  batchId: string,
  nowIso: string,
): { occurrence: boolean; diagnostic: string | null } {
  const items = listItemsForBatchObservation(batchId, 1000);
  const classified = items.map(classifyItem);
  const nonTerminal = classified.filter((c) => !c.terminal) as Array<{ terminal: false; reason: string }>;
  const missingSkuCount = classified.reduce(
    (acc, c, i) => acc + (c.terminal && c.sku === null && toCanonicalStored(items[i].stage) === 'create_drafts' ? 1 : 0),
    0,
  );

  // Cursor fingerprint over terminality-relevant committed state.
  const fingerprint = hashCanonicalJson({
    batchId,
    items: classified.map((c, i) =>
      c.terminal
        ? { t: 'term', sku: c.sku, up: items[i].updatedAt }
        : { t: 'active', st: items[i].stage, ss: items[i].stageStatus, up: items[i].updatedAt },
    ),
  });
  const cursor = getSourceCursor(workspaceId, 'onboarding_batch', batchId);
  if (cursor && cursor.fingerprint === fingerprint) {
    // No committed change since the last evaluation — nothing new to observe.
    return { occurrence: false, diagnostic: null };
  }

  const skus = Array.from(new Set(
    classified.flatMap((c, i) =>
      c.terminal && c.sku !== null ? [c.sku!] : [],
    ),
  )).slice(0, 200);

  if (nonTerminal.length > 0) {
    createTriggerOccurrence({
      workspaceId,
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      occurrenceKey: `import_finished:batch:${batchId}:diagnostic:not_terminal`,
      sourceRef: { kind: 'onboarding_batch', id: batchId },
      scopeJson: null,
      scheduledAt: nowIso,
      status: 'diagnostic',
      errorCode: 'import_not_terminal',
    });
    upsertSourceCursor({ workspaceId, sourceKind: 'onboarding_batch', sourceId: batchId, fingerprint, terminalObserved: false, lastObservedAt: nowIso });
    return { occurrence: false, diagnostic: 'import_not_terminal' };
  }

  if (missingSkuCount > 0) {
    createTriggerOccurrence({
      workspaceId,
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      occurrenceKey: `import_finished:batch:${batchId}:diagnostic:sku_unknown`,
      sourceRef: { kind: 'onboarding_batch', id: batchId },
      scopeJson: null,
      scheduledAt: nowIso,
      status: 'diagnostic',
      errorCode: 'sku_unknown',
    });
    upsertSourceCursor({ workspaceId, sourceKind: 'onboarding_batch', sourceId: batchId, fingerprint, terminalObserved: false, lastObservedAt: nowIso });
    return { occurrence: false, diagnostic: 'sku_unknown' };
  }

  const scope: StoreManagerPinnedScope = { kind: 'sku_set', skus };
  createTriggerOccurrence({
    workspaceId,
    triggerId: trigger.id,
    triggerVersion: trigger.version,
    occurrenceKey: `import_finished:batch:${batchId}`,
    sourceRef: { kind: 'onboarding_batch', id: batchId },
    scopeJson: scopeJsonFor(scope),
    scheduledAt: nowIso,
  });
  upsertSourceCursor({ workspaceId, sourceKind: 'onboarding_batch', sourceId: batchId, fingerprint, terminalObserved: true, lastObservedAt: nowIso });
  return { occurrence: true, diagnostic: null };
}

function observeChangeSetApproved(
  workspaceId: string,
  trigger: TriggerDefinitionRow,
  nowIso: string,
): { occurrences: number } {
  let occurrences = 0;
  for (const changeSet of listApprovedChangeSetsForObservation(workspaceId)) {
    const fingerprint = `approved:${changeSet.updatedAt}`;
    const cursor = getSourceCursor(workspaceId, 'change_set', changeSet.id);
    if (cursor && cursor.fingerprint === fingerprint) continue;
    const scope: StoreManagerPinnedScope = { kind: 'change_set', changeSetId: changeSet.id };
    createTriggerOccurrence({
      workspaceId,
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      occurrenceKey: `change_set_approved:${changeSet.id}`,
      sourceRef: { kind: 'change_set', id: changeSet.id },
      scopeJson: scopeJsonFor(scope),
      scheduledAt: nowIso,
    });
    upsertSourceCursor({ workspaceId, sourceKind: 'change_set', sourceId: changeSet.id, fingerprint, terminalObserved: true, lastObservedAt: nowIso });
    occurrences += 1;
  }
  return { occurrences };
}

function observeSyncFailed(
  workspaceId: string,
  trigger: TriggerDefinitionRow,
  nowIso: string,
): { occurrences: number } {
  let occurrences = 0;
  for (const job of listFailedSyncJobsForObservation(workspaceId)) {
    const fingerprint = `failed:${job.completedAt ?? job.startedAt ?? ''}`;
    const cursor = getSourceCursor(workspaceId, 'sync_job', job.id);
    if (cursor && cursor.fingerprint === fingerprint) continue;
    createTriggerOccurrence({
      workspaceId,
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      occurrenceKey: `sync_failed:${job.id}`,
      sourceRef: { kind: 'sync_job', id: job.id },
      scopeJson: null,
      scheduledAt: nowIso,
    });
    upsertSourceCursor({ workspaceId, sourceKind: 'sync_job', sourceId: job.id, fingerprint, terminalObserved: true, lastObservedAt: nowIso });
    occurrences += 1;
  }
  return { occurrences };
}

function observeProductFieldDrift(
  workspaceId: string,
  trigger: TriggerDefinitionRow,
  nowIso: string,
): { occurrences: number } {
  if (trigger.config.kind !== 'product_field_drift') return { occurrences: 0 };
  const threshold = trigger.config.threshold;
  const current = countProposalsByField(workspaceId, 'proposed');
  const fingerprint = hashCanonicalJson(current);
  const cursor = getSourceCursor(workspaceId, 'product_field_drift', trigger.id);

  let occurrences = 0;
  if (cursor) {
    const baseline = cursor.baselineJson
      ? (JSON.parse(cursor.baselineJson) as Record<string, number>)
      : {};
    for (const [field, count] of Object.entries(current)) {
      const delta = count - (baseline[field] ?? 0);
      if (delta >= threshold) {
        const scope: StoreManagerPinnedScope = { kind: 'product_field', field };
        createTriggerOccurrence({
          workspaceId,
          triggerId: trigger.id,
          triggerVersion: trigger.version,
          occurrenceKey: `product_field_drift:${field}:${count}`,
          sourceRef: { kind: 'product_field', id: field },
          scopeJson: scopeJsonFor(scope),
          scheduledAt: nowIso,
        });
        occurrences += 1;
      }
    }
  }
  // Advance the baseline to current counts on every evaluation (the cursor is
  // the deterministic baseline store; drift is measured against the last
  // observed counts, not the workspace's all-time low).
  upsertSourceCursor({
    workspaceId,
    sourceKind: 'product_field_drift',
    sourceId: trigger.id,
    fingerprint,
    baselineJson: JSON.stringify(current),
    terminalObserved: true,
    lastObservedAt: nowIso,
  });
  return { occurrences };
}

/**
 * Run the observation pass for one enabled trigger. Bounded: batch scans are
 * capped; drift baselines are per-trigger. Returns counts.
 */
export function observeTrigger(
  workspaceId: string,
  trigger: TriggerDefinitionRow,
  deps: { now?: () => Date } = {},
): ObservationResult {
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  let occurrences = 0;
  let diagnostics = 0;
  let error: string | null = null;
  try {
    const config = trigger.config;
    switch (config.kind) {
      case 'import_finished': {
        const batchId = config.batchId;
        const batches = batchId
          ? listBatchesForObservation(workspaceId, 200).filter((b) => b.id === batchId)
          : listBatchesForObservation(workspaceId, 200);
        for (const batch of batches) {
          const result = observeImportFinishedBatch(workspaceId, trigger, batch.id, nowIso);
          if (result.occurrence) occurrences += 1;
          if (result.diagnostic) diagnostics += 1;
        }
        break;
      }
      case 'change_set_approved': {
        const result = observeChangeSetApproved(workspaceId, trigger, nowIso);
        occurrences += result.occurrences;
        break;
      }
      case 'sync_failed': {
        const result = observeSyncFailed(workspaceId, trigger, nowIso);
        occurrences += result.occurrences;
        break;
      }
      case 'product_field_drift': {
        const result = observeProductFieldDrift(workspaceId, trigger, nowIso);
        occurrences += result.occurrences;
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }
  updateTriggerScanState(workspaceId, trigger.id, {
    lastScanAt: nowIso,
    lastScanStatus: error ? 'failed' : diagnostics > 0 && occurrences === 0 ? 'diagnostic' : 'completed',
  });
  return { triggerId: trigger.id, kind: trigger.config.kind, occurrences, diagnostics, error };
}

// ---------------------------------------------------------------------------
// Occurrence dispatch (single runtime runner; unattended read-only)
// ---------------------------------------------------------------------------

export interface TriggerDispatchDeps {
  /** Injectable runtime deps (fake model resolver / registry for tests). */
  runtime?: Partial<StoreManagerExecutionDeps>;
  /** Injectable clock. */
  now?: () => Date;
  /** Lease duration for claims (default 10 minutes). */
  leaseMs?: number;
  /** Max retries before an occurrence is terminal-failed (default 3). */
  maxRetries?: number;
  /** Base retry backoff (default 5 minutes); capped exponential. */
  retryBaseMs?: number;
  /** Max backoff (default 1 hour). */
  maxBackoffMs?: number;
  /** Optional explicit workspace path (single-workspace fallback: findWorkspace). */
  workspacePath?: string;
  /** Per-occurrence model override (never mutates the trigger definition). */
  selectedModel?: string;
  /** Server-owned policy narrowing (deadline/budget) for this occurrence. */
  policyProfile?: StoreManagerPolicyProfile;
}

export interface TriggerDispatchResult {
  occurrenceId: string;
  occurrenceKey: string;
  status: 'completed' | 'failed' | 'unavailable' | 'cancelled' | 'requeued';
  runId: string | null;
  errorCode: string | null;
  terminalStatus: string | null;
  retryCount: number;
}

/** Build the run objective: template objective + bounded redacted evidence. */
function buildOccurrenceObjective(trigger: TriggerDefinitionRow, occurrence: StoreManagerTriggerOccurrence): string {
  let objective = trigger.objective.slice(0, 1400);
  if (trigger.config.kind === 'sync_failed' && occurrence.sourceRef.kind === 'sync_job') {
    const job = listFailedSyncJobsForObservation(trigger.workspaceId, 500)
      .find((j) => j.id === occurrence.sourceRef.id);
    if (job) {
      const evidence = buildRedactedSyncEvidence(job);
      objective += `\n\nSync job ${occurrence.sourceRef.id.slice(0, 24)} failed during ${evidence.kind} (${evidence.errorClass}). Redacted evidence: ${evidence.summary || '(none recorded)'}.`;
    }
  }
  return objective.slice(0, 2000);
}

function parseScopeJson(scopeJson: string | null): StoreManagerPinnedScope | undefined {
  if (!scopeJson) return undefined;
  try {
    return JSON.parse(scopeJson) as StoreManagerPinnedScope;
  } catch {
    return undefined;
  }
}

/**
 * Dispatch one pending occurrence through the single runtime runner. The
 * caller (event worker or run-now route) must have claimed it first; this
 * function executes, persists the report artifact, reconciles inbox +
 * notifications (idempotent), and finalizes or requeues the occurrence.
 */
export async function dispatchTriggerOccurrence(
  workspaceId: string,
  occurrenceId: string,
  deps: TriggerDispatchDeps = {},
): Promise<TriggerDispatchResult> {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? 10 * 60 * 1000;
  const maxRetries = deps.maxRetries ?? 3;
  const retryBaseMs = deps.retryBaseMs ?? 5 * 60 * 1000;
  const maxBackoffMs = deps.maxBackoffMs ?? 60 * 60 * 1000;

  const occurrence = getTriggerOccurrence(workspaceId, occurrenceId);
  if (!occurrence) throw new Error('Trigger occurrence not found in this workspace.');
  const trigger = getTrigger(workspaceId, occurrence.triggerId);
  if (!trigger) {
    finalizeTriggerOccurrence({ workspaceId, occurrenceId, status: 'failed', errorCode: 'trigger_deleted' });
    return { occurrenceId, occurrenceKey: occurrence.occurrenceKey, status: 'failed', runId: null, errorCode: 'trigger_deleted', terminalStatus: null, retryCount: occurrence.retryCount };
  }
  const workspace = deps.workspacePath ? { workspacePath: deps.workspacePath } : findWorkspace() ?? { workspacePath: '.' };

  const request = createStoreManagerExecutionRequest({
    workspaceId,
    workspacePath: workspace.workspacePath,
    threadId: null,
    entrypoint: 'event',
    executionMode: 'unattended_read_only',
    objective: buildOccurrenceObjective(trigger, occurrence),
    pinnedScope: parseScopeJson(occurrence.scopeJson),
    lineage: {
      triggerKind: trigger.config.kind,
      occurrenceKey: occurrence.occurrenceKey,
    },
    selectedModel: deps.selectedModel ?? trigger.selectedModel ?? undefined,
    policyProfile: deps.policyProfile,
  });

  let result: StoreManagerExecutionResult;
  try {
    result = await runStoreManagerExecution(request, deps.runtime ?? {});
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return handleUnavailable(workspaceId, occurrence, trigger, now, deps, maxRetries, retryBaseMs, maxBackoffMs);
    }
    const code = err instanceof Error ? err.name : 'TRIGGER_DISPATCH_ERROR';
    return handleFailure(workspaceId, occurrence, trigger, code, now, maxRetries, retryBaseMs, maxBackoffMs, deps);
  }

  if (result.kind !== 'completed') {
    return handleFailure(workspaceId, occurrence, trigger, 'unexpected_result', now, maxRetries, retryBaseMs, maxBackoffMs, deps);
  }

  if (result.terminalStatus === 'success') {
    persistEventArtifacts(workspaceId, trigger, occurrence, result, now().toISOString());
    // Idempotent reconciliation after artifact validation (deterministic).
    reconcileInbox(workspaceId);
    evaluateNotificationRules(workspaceId);
    updateTriggerScanState(workspaceId, trigger.id, {
      lastScanAt: now().toISOString(),
      lastScanStatus: 'completed',
      lastRunId: result.runId,
    });
    finalizeTriggerOccurrence({
      workspaceId,
      occurrenceId,
      status: 'completed',
      runId: result.runId,
      nowIso: now().toISOString(),
    });
    return {
      occurrenceId,
      occurrenceKey: occurrence.occurrenceKey,
      status: 'completed',
      runId: result.runId,
      errorCode: null,
      terminalStatus: 'success',
      retryCount: occurrence.retryCount,
    };
  }

  return handleFailure(
    workspaceId,
    occurrence,
    trigger,
    result.terminalStatus === 'policy_denied' ? 'policy_denied' : result.terminalStatus,
    now,
    maxRetries,
    retryBaseMs,
    maxBackoffMs,
    deps,
    result.runId,
  );
}

async function handleUnavailable(
  workspaceId: string,
  occurrence: StoreManagerTriggerOccurrence,
  trigger: TriggerDefinitionRow,
  now: () => Date,
  deps: TriggerDispatchDeps,
  maxRetries: number,
  retryBaseMs: number,
  maxBackoffMs: number,
): Promise<TriggerDispatchResult> {
  updateTriggerScanState(workspaceId, trigger.id, {
    lastScanAt: now().toISOString(),
    lastScanStatus: 'unavailable',
  });
  if (occurrence.retryCount < maxRetries) {
    const backoff = Math.min(retryBaseMs * 2 ** occurrence.retryCount, maxBackoffMs);
    requeueTriggerOccurrence(workspaceId, occurrence.id, new Date(now().getTime() + backoff).toISOString(), 'model_unavailable');
    return {
      occurrenceId: occurrence.id, occurrenceKey: occurrence.occurrenceKey, status: 'requeued', runId: null,
      errorCode: 'model_unavailable', terminalStatus: 'unavailable', retryCount: occurrence.retryCount + 1,
    };
  }
  finalizeTriggerOccurrence({ workspaceId, occurrenceId: occurrence.id, status: 'unavailable', errorCode: 'model_unavailable', nowIso: now().toISOString() });
  return {
    occurrenceId: occurrence.id, occurrenceKey: occurrence.occurrenceKey, status: 'unavailable', runId: null,
    errorCode: 'model_unavailable', terminalStatus: 'unavailable', retryCount: occurrence.retryCount + 1,
  };
}

async function handleFailure(
  workspaceId: string,
  occurrence: StoreManagerTriggerOccurrence,
  trigger: TriggerDefinitionRow,
  errorCode: string,
  now: () => Date,
  maxRetries: number,
  retryBaseMs: number,
  maxBackoffMs: number,
  deps: TriggerDispatchDeps,
  runId?: string | null,
): Promise<TriggerDispatchResult> {
  updateTriggerScanState(workspaceId, trigger.id, {
    lastScanAt: now().toISOString(),
    lastScanStatus: 'failed',
    lastRunId: runId ?? null,
  });
  const code = errorCode.slice(0, 100);
  if (occurrence.retryCount < maxRetries) {
    const backoff = Math.min(retryBaseMs * 2 ** occurrence.retryCount, maxBackoffMs);
    requeueTriggerOccurrence(workspaceId, occurrence.id, new Date(now().getTime() + backoff).toISOString(), code);
    return {
      occurrenceId: occurrence.id, occurrenceKey: occurrence.occurrenceKey, status: 'requeued', runId: runId ?? null,
      errorCode: code, terminalStatus: code, retryCount: occurrence.retryCount + 1,
    };
  }
  finalizeTriggerOccurrence({ workspaceId, occurrenceId: occurrence.id, status: 'failed', errorCode: code, runId: runId ?? null, nowIso: now().toISOString() });
  return {
    occurrenceId: occurrence.id, occurrenceKey: occurrence.occurrenceKey, status: 'failed', runId: runId ?? null,
    errorCode: code, terminalStatus: code, retryCount: occurrence.retryCount + 1,
  };
}

// ---------------------------------------------------------------------------
// Run artifacts (immutable, redacted)
// ---------------------------------------------------------------------------

function persistEventArtifacts(
  workspaceId: string,
  trigger: TriggerDefinitionRow,
  occurrence: StoreManagerTriggerOccurrence,
  result: StoreManagerExecutionResult & { kind: 'completed' },
  nowIso: string,
): void {
  const reportContent = {
    triggerId: trigger.id,
    triggerName: trigger.name.slice(0, 100),
    triggerKind: trigger.config.kind,
    occurrenceKey: occurrence.occurrenceKey,
    triggerVersion: occurrence.triggerVersion,
    sourceRef: occurrence.sourceRef,
    terminalStatus: result.terminalStatus,
    runId: result.runId,
    generatedAt: nowIso,
    objective: trigger.objective.slice(0, 2000),
    summary: (result.output?.text ?? '').slice(0, 64 * 1024),
    toolOutcomes: (result.output?.toolResults ?? []).slice(0, 50).map((t) =>
      t.errorText
        ? { toolName: t.toolName, status: t.status, errorText: t.errorText.slice(0, 500) }
        : { toolName: t.toolName, status: t.status },
    ),
  };
  const artifact = createStoreManagerArtifact({
    runId: result.runId,
    workspaceId,
    kind: 'report',
    schemaVersion: 1,
    content: reportContent,
    createdAt: nowIso,
  });
  createStoreManagerRunArtifact({
    id: artifact.id,
    workspaceId,
    runId: result.runId,
    kind: 'report',
    schemaVersion: 1,
    contentJson: JSON.stringify(reportContent),
    contentHash: artifact.contentHash,
    createdAt: nowIso,
  });
}

// ---------------------------------------------------------------------------
// Run-now (read-only, flag-gated by the route)
// ---------------------------------------------------------------------------

export interface TriggerRunNowResult {
  occurrenceId: string;
  occurrenceKey: string;
  result: TriggerDispatchResult;
}

/**
 * Create an immediate occurrence for the trigger's kind (respecting its
 * config) and dispatch it synchronously through the SAME unattended read-only
 * runtime policy. "Run now" is not an approval shortcut and carries no
 * additional authority.
 */
export async function runTriggerNowReadOnly(
  workspaceId: string,
  triggerId: string,
  deps: TriggerDispatchDeps & { selectedModel?: string } = {},
): Promise<TriggerRunNowResult> {
  const now = deps.now ?? (() => new Date());
  const trigger = getTrigger(workspaceId, triggerId);
  if (!trigger) throw new Error('Trigger not found in this workspace.');
  const occurrenceKey = `run-now:${trigger.config.kind}:${randomUUID()}`;
  const occurrence = createTriggerOccurrence({
    workspaceId,
    triggerId,
    triggerVersion: trigger.version,
    occurrenceKey,
    sourceRef: { kind: trigger.config.kind, id: 'run-now' },
    scopeJson: scopeJsonFor(trigger.scope),
    scheduledAt: now().toISOString(),
  });
  const claimed = claimTriggerOccurrence(workspaceId, occurrence.id, 'operator', deps.leaseMs ?? 10 * 60 * 1000, now().toISOString());
  if (!claimed) throw new Error('Trigger occurrence could not be claimed.');
  const result = await dispatchTriggerOccurrence(workspaceId, occurrence.id, deps);
  return { occurrenceId: occurrence.id, occurrenceKey, result };
}
