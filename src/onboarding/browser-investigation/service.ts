// Browser Investigation lifecycle service (T1).
//
// Workspace-scoped control plane. The ONLY production caller of the
// investigation provider seam — worker polling, failure handling,
// diagnostics reads, and normal extraction must never import the provider.
//
// Completion, compilation, validation, and human review stay distinct: a
// `completed` investigation holds UNTRUSTED proposal evidence only. Nothing
// here activates profiles, releases items, attests image review, or writes
// trusted extraction output (asserted by isolation tests).

import {
  InvestigationModelPolicySchema,
  InvestigationRecordSchema,
  InvestigationRequestInputSchema,
  InvestigationResultSchema,
  normalizeInvestigationDomain,
  resolveInvestigationBudget,
  type InvestigationBudget,
  type InvestigationFailureCode,
  type InvestigationMode,
  type InvestigationModelMetadata,
  type InvestigationModelPolicy,
  type InvestigationProviderId,
  type InvestigationRecord,
  type InvestigationUsage,
} from '../../shared/schemas/browser-investigation';
// Type-only bridge to the SQLite adapter contract. Erased at compile time,
// so this module stays runtime-clean (no bun:sqlite) and Vitest-safe.
import { hashCanonicalJson } from '../../shared/stable-id';
import { isExtendedUsageWithinBudget } from './budgets';
import type {
  InvestigationInsert,
  InvestigationPatch,
} from '../../db/repositories/browser-investigation-repo';
import {
  invokeInvestigationProvider,
  resolveInvestigationProvider,
  InvestigationProviderError,
  type InvestigationProviderCompletion,
} from './provider';

export type InvestigationStore = {
  insert(row: StoredInvestigationInsert): InvestigationRecord;
  find(workspaceId: string, id: string): InvestigationRecord | null;
  list(workspaceId: string, domain?: string): InvestigationRecord[];
  findActive(workspaceId: string, domain: string): InvestigationRecord | null;
  existsInOtherWorkspace(workspaceId: string, id: string): boolean;
  update(
    workspaceId: string,
    id: string,
    patch: InvestigationPatch,
  ): InvestigationRecord | null;
};

export type StoredInvestigationInsert = InvestigationInsert & { id?: string };

export class InvestigationServiceError extends Error {
  readonly code: InvestigationFailureCode;
  constructor(code: InvestigationFailureCode, message: string) {
    super(message);
    this.name = 'InvestigationServiceError';
    this.code = code;
  }
}

// Public options surface for explicit investigate/repair calls (routes in T1,
// compiler and workspace flows in T2/T5).
// fallow-ignore-next-line unused-type
export interface RequestInvestigationOptions {
  workspaceId: string;
  domain: string;
  mode: InvestigationMode;
  sampleUrls: string[];
  budget?: Partial<InvestigationBudget>;
  modelPolicy?: Partial<InvestigationModelPolicy>;
  knownContext?: Record<string, unknown>;
  provider?: InvestigationProviderId;
  requestedModel?: InvestigationModelMetadata | null;
  now?: Date;
  id?: string;
  runId?: string;
}

function fail(code: InvestigationFailureCode, message: string): never {
  throw new InvestigationServiceError(code, `${code}: ${message}`);
}

function requireWorkspace(workspaceId: string): void {
  if (!workspaceId || !workspaceId.trim()) fail('invalid_input', 'workspaceId required');
}

/** Reject non-http(s), credential-bearing, and literal-private-host URLs.
 * DNS-backed checks (rebinding, redirected destinations) belong to the T3
 * broker; this boundary fails closed on what is statically provable. */
function assertInvestigationSampleUrls(urls: string[]): void {
  for (const raw of urls) {
    assertOneInvestigationSampleUrl(raw);
  }
}

function assertOneInvestigationSampleUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('invalid_input', `invalid sample URL ${raw}`);
  }
  if (url!.protocol !== 'http:' && url!.protocol !== 'https:') {
    fail('invalid_input', `sample URL must be http(s): ${raw}`);
  }
  if (url!.username || url!.password) {
    fail('invalid_input', `sample URL must not carry credentials: ${raw}`);
  }
  assertPublicInvestigationHost(url!.hostname, raw);
}

function assertPublicInvestigationHost(hostname: string, raw: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) fail('invalid_input', `sample URL missing host: ${raw}`);
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost')
  ) {
    fail('invalid_input', `sample URL targets a non-public host: ${raw}`);
  }
  if (isLiteralPrivateIpv4(host)) {
    fail('invalid_input', `sample URL targets a private address: ${raw}`);
  }
}

/** Non-public IPv4 ranges as [first, last] integer pairs (dotted quads
 * parsed to uint32). Covers loopback, RFC 1918, link-local, CGNAT, and
 * current-network sources; DNS-backed rebinding checks belong to T3. */
const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
];

function isLiteralPrivateIpv4(host: string): boolean {
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (!octets || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const addr = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  return NON_PUBLIC_IPV4_RANGES.some(([first, last]) => addr >= first && addr <= last);
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function buildInputSnapshotHash(snapshot: Record<string, unknown>): string {
  return hashCanonicalJson(snapshot);
}

export function requestInvestigation(
  store: InvestigationStore,
  options: RequestInvestigationOptions,
): InvestigationRecord {
  requireWorkspace(options.workspaceId);
  const parsed = InvestigationRequestInputSchema.safeParse({
    domain: options.domain,
    mode: options.mode,
    sampleUrls: options.sampleUrls,
    budget: options.budget,
    modelPolicy: options.modelPolicy,
    knownContext: options.knownContext,
  });
  if (!parsed.success) {
    fail('invalid_input', parsed.error.issues.map((i) => i.message).join('; ') || 'invalid request');
  }
  const input = parsed.data!;
  const domain = normalizeInvestigationDomain(input.domain);
  if (!domain) fail('invalid_input', 'domain required');
  assertInvestigationSampleUrls(input.sampleUrls);

  // Production default is the real local harness — never the fake. The fake
  // survives only as explicit test injection (`provider: 'fake'` from a test
  // that registered `FakeInvestigationProvider`); production routes reject
  // `fake` before reaching this service (see browser-investigation-routes).
  const provider: InvestigationProviderId = options.provider ?? 'local_browser_harness';
  if (provider !== 'fake' && provider !== 'local_browser_harness') {
    fail('invalid_input', `unknown provider ${String(provider)}`);
  }

  const existing = store.findActive(options.workspaceId, domain);
  if (existing) {
    fail(
      'conflict_active_investigation',
      `workspace already has an active investigation for ${domain} (${existing.id})`,
    );
  }

  const budget = resolveInvestigationBudget(input.budget);
  const modelPolicy = InvestigationModelPolicySchema.parse(input.modelPolicy ?? {});
  const requestedAt = nowIso(options.now);
  const snapshot = {
    domain,
    mode: input.mode,
    sampleUrls: input.sampleUrls,
    budget,
    modelPolicy,
    knownContext: input.knownContext ?? {},
    requestedAt,
  };
  const inputHash = buildInputSnapshotHash(snapshot);
  const createdAt = requestedAt;
  const runId =
    options.runId ?? `binvrun_${requestedAt.replace(/[^0-9]/g, '').slice(0, 14)}_${Math.abs(hashSeed(inputHash))}`;
  const id = options.id ?? `binv_${Math.abs(hashSeed(`${inputHash}:${requestedAt}`))}_${Date.now().toString(36)}`;

  const inserted = store.insert({
    id,
    workspaceId: options.workspaceId,
    domain,
    mode: input.mode,
    status: 'queued',
    provider,
    runId,
    requestedModelJson: options.requestedModel ? JSON.stringify(options.requestedModel) : null,
    actualModelJson: null,
    inputSnapshotJson: JSON.stringify(snapshot),
    inputHash,
    budgetJson: JSON.stringify(budget),
    createdAt,
    updatedAt: createdAt,
  });
  return InvestigationRecordSchema.parse(inserted);
}

function hashSeed(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

function scopedOrThrow(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
): InvestigationRecord {
  requireWorkspace(workspaceId);
  const found = store.find(workspaceId, id);
  if (found) return found;
  if (store.existsInOtherWorkspace(workspaceId, id)) {
    fail('workspace_mismatch', 'investigation belongs to another workspace');
  }
  fail('not_found', `investigation ${id} not found`);
}

/**
 * Shared workspace-scoped loader (T4): apply and validation resolve the
 * same record through one definition so the two paths cannot drift on
 * scoping or failure codes.
 */
export function requireScopedInvestigation(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
): InvestigationRecord {
  return scopedOrThrow(store, workspaceId, id);
}

function toFailureCode(err: unknown): { code: InvestigationFailureCode; detail: string } {
  if (err instanceof InvestigationProviderError) {
    const map: Record<string, InvestigationFailureCode> = {
      timeout: 'timeout',
      provider_error: 'provider_error',
      budget_exhausted: 'budget_exhausted',
      budget_not_enforceable: 'budget_not_enforceable',
      cancelled: 'cancelled',
      isolation_unavailable: 'isolation_unavailable',
      cloud_disabled: 'cloud_disabled',
      holdout_exposed: 'holdout_exposed',
    };
    const code = map[err.code] ?? 'provider_error';
    return { code, detail: err.message.slice(0, 500) };
  }
  if (err instanceof InvestigationServiceError) return { code: err.code, detail: err.message.slice(0, 500) };
  return { code: 'provider_error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
}

function checkUsageWithinBudget(usage: InvestigationUsage | null | undefined, budget: InvestigationBudget): boolean {
  if (!usage) return true;
  return (
    checkCoreUsageWithinBudget(usage, budget) &&
    // T3 resource counters (broker request attempts, byte/artifacts/model-payload totals).
    isExtendedUsageWithinBudget(usage, budget)
  );
}

function checkCoreUsageWithinBudget(usage: InvestigationUsage, budget: InvestigationBudget): boolean {
  const bounded: ReadonlyArray<readonly [actual: number, cap: number]> = [
    [usage.modelCalls ?? 0, budget.maxModelCalls],
    [usage.pagesVisited ?? 0, budget.maxPages],
    [usage.readsPerformed ?? 0, budget.maxReads],
    [usage.durationMs ?? 0, budget.timeoutMs],
  ];
  if (!bounded.every(([actual, cap]) => actual <= cap)) return false;
  return !(usage.costUsd != null && budget.maxCostUsd != null && usage.costUsd > budget.maxCostUsd);
}

/** Classify a raw provider payload: accepted untrusted result, or the
 * fail-closed code that must be recorded (`malformed_result` vs the
 * distinct `evidence_missing` when the envelope is well-formed but empty). */
function classifyCompletionResult(raw: unknown):
  | { ok: true; result: NonNullable<InvestigationRecord['result']> }
  | { ok: false; code: 'malformed_result' | 'evidence_missing'; detail: string } {
  const validated = InvestigationResultSchema.safeParse(raw);
  if (validated.success) return { ok: true, result: validated.data };
  const observations =
    !!raw && typeof raw === 'object'
      ? (raw as { observations?: unknown }).observations
      : undefined;
  if (Array.isArray(observations) && observations.length === 0) {
    return { ok: false, code: 'evidence_missing', detail: 'provider returned no observations' };
  }
  return { ok: false, code: 'malformed_result', detail: 'provider returned a malformed result' };
}

function assertCompletionIdentity(
  record: InvestigationRecord,
  completion: InvestigationProviderCompletion,
): void {
  // Pure rejection: a stale or replayed delivery must not mutate the
  // running investigation (see acceptCompletion contract).
  if (completion.runId !== record.runId) {
    fail('stale_completion', 'stale run identity');
  }
  if (completion.inputHash !== record.inputHash) {
    fail('stale_completion', 'stale input snapshot');
  }
}

/**
 * Accept a provider completion for a RUNNING investigation. Rejects stale or
 * replayed completions without mutating state: wrong workspace, terminal
 * status, runId mismatch, or inputHash mismatch.
 */
export function acceptCompletion(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
  completion: InvestigationProviderCompletion,
  now?: Date,
): InvestigationRecord {
  const record = scopedOrThrow(store, workspaceId, id);
  if (record.status !== 'running') {
    fail('replay_rejected', `investigation ${id} is ${record.status}; completion rejected`);
  }
  assertCompletionIdentity(record, completion);
  const classified = classifyCompletionResult(completion.result);
  if (!classified.ok) {
    markFailed(store, workspaceId, record, classified.code, classified.detail, now, completion);
    fail(classified.code, classified.detail);
  }
  if (!checkUsageWithinBudget(completion.usage, record.budget)) {
    markFailed(store, workspaceId, record, 'budget_exhausted', 'provider usage exceeded budget', now, completion);
    fail('budget_exhausted', 'provider usage exceeded budget');
  }
  return completeWithResult(store, workspaceId, id, completion, classified.result, now);
}

function completeWithResult(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
  completion: InvestigationProviderCompletion,
  result: NonNullable<InvestigationRecord['result']>,
  now?: Date,
): InvestigationRecord {
  const at = nowIso(now);
  const updated = store.update(workspaceId, id, {
    status: 'completed',
    actualModelJson: completion.actualModel ? JSON.stringify(completion.actualModel) : null,
    completedAt: at,
    usageJson: completion.usage ? JSON.stringify(completion.usage) : null,
    resultJson: JSON.stringify(result),
    resultHash: hashCanonicalJson(result),
    updatedAt: at,
  });
  if (!updated) fail('not_found', `investigation ${id} not found`);
  return InvestigationRecordSchema.parse(updated!);
}

function markFailed(
  store: InvestigationStore,
  workspaceId: string,
  record: InvestigationRecord,
  code: InvestigationFailureCode,
  detail: string,
  now?: Date,
  completion?: InvestigationProviderCompletion,
): void {
  const at = nowIso(now);
  store.update(workspaceId, record.id, {
    status: 'failed',
    actualModelJson: completion?.actualModel ? JSON.stringify(completion.actualModel) : null,
    completedAt: at,
    usageJson: completion?.usage ? JSON.stringify(completion.usage) : null,
    failureCode: code,
    failureDetail: detail.slice(0, 500),
    updatedAt: at,
  });
}

/**
 * Run a QUEUED investigation through the provider. Only explicit
 * investigate/repair routes call this. Enforces the monetary-ceiling
 * contract before dispatch: a requested maxCostUsd the provider cannot
 * enforce fails with `budget_not_enforceable`.
 */
export async function runInvestigation(
  store: InvestigationStore,
  providerId: InvestigationProviderId,
  workspaceId: string,
  id: string,
  now?: Date,
): Promise<InvestigationRecord> {
  const record = scopedOrThrow(store, workspaceId, id);
  if (record.status !== 'queued') {
    fail('invalid_transition', `only queued investigations can run (is ${record.status})`);
  }
  if (providerId !== record.provider) {
    fail('invalid_input', `provider mismatch: investigation uses ${record.provider}`);
  }
  // Monetary ceilings must be proven enforceable before dispatch. The T1
  // fake honors the accounting contract; the local harness cannot prove a
  // billing cap yet, so it fails closed here (post-hoc checks are not caps).
  if (record.budget.maxCostUsd !== undefined && providerId === 'local_browser_harness') {
    markFailed(store, workspaceId, record, 'budget_not_enforceable', 'provider cannot enforce maxCostUsd', now);
    fail('budget_not_enforceable', 'provider cannot enforce maxCostUsd');
  }
  // Cloud stays disabled: never dispatch, even if a row somehow names it.
  try {
    resolveInvestigationProvider(providerId);
  } catch (err) {
    const mapped = toFailureCode(err);
    markFailed(store, workspaceId, record, mapped.code, mapped.detail, now);
    throw new InvestigationServiceError(mapped.code, mapped.detail);
  }

  const startedAt = nowIso(now);
  const running = store.update(workspaceId, id, { status: 'running', startedAt, updatedAt: startedAt });
  if (!running) fail('not_found', `investigation ${id} not found`);

  try {
    const completion = await invokeInvestigationProvider(providerId, {
      investigationId: record.id,
      workspaceId: record.workspaceId,
      domain: record.domain,
      mode: record.mode,
      sampleUrls: record.inputSnapshot.sampleUrls,
      inputSnapshot: record.inputSnapshot,
      inputHash: record.inputHash,
      budget: record.budget,
      modelPolicy: record.inputSnapshot.modelPolicy,
      knownContext: record.inputSnapshot.knownContext,
      runId: record.runId,
    });
    return acceptCompletion(store, workspaceId, id, completion, now);
  } catch (err) {
    const mapped = toFailureCode(err);
    const at = nowIso(now);
    if (mapped.code === 'cancelled') {
      store.update(workspaceId, id, {
        status: 'cancelled',
        completedAt: at,
        failureCode: 'cancelled',
        failureDetail: mapped.detail,
        updatedAt: at,
      });
      throw new InvestigationServiceError('cancelled', mapped.detail);
    }
    markFailed(store, workspaceId, record, mapped.code, mapped.detail, now);
    const failed = store.find(workspaceId, id);
    void failed;
    throw new InvestigationServiceError(mapped.code, mapped.detail);
  }
}

export async function requestAndRunInvestigation(
  store: InvestigationStore,
  options: RequestInvestigationOptions,
): Promise<InvestigationRecord> {
  const created = requestInvestigation(store, options);
  try {
    return await runInvestigation(store, created.provider, options.workspaceId, created.id, options.now);
  } catch (err) {
    if (err instanceof InvestigationServiceError) {
      const latest = store.find(options.workspaceId, created.id);
      if (latest) return latest;
    }
    throw err;
  }
}

export function cancelInvestigation(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
  now?: Date,
): InvestigationRecord {
  const record = scopedOrThrow(store, workspaceId, id);
  if (record.status !== 'queued' && record.status !== 'running') {
    fail('invalid_transition', `only queued/running investigations can be cancelled (is ${record.status})`);
  }
  const at = nowIso(now);
  const updated = store.update(workspaceId, id, {
    status: 'cancelled',
    completedAt: at,
    failureCode: 'cancelled',
    failureDetail: 'cancelled by operator',
    updatedAt: at,
  });
  if (!updated) fail('not_found', `investigation ${id} not found`);
  return InvestigationRecordSchema.parse(updated!);
}

export function discardInvestigation(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
  actor: string,
  now?: Date,
): InvestigationRecord {
  if (!actor || !actor.trim()) fail('invalid_input', 'discard actor required');
  const record = scopedOrThrow(store, workspaceId, id);
  if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled') {
    fail('invalid_transition', `only terminal investigations can be discarded (is ${record.status})`);
  }
  const at = nowIso(now);
  const updated = store.update(workspaceId, id, {
    status: 'discarded',
    discardedAt: at,
    discardActor: actor.trim(),
    updatedAt: at,
  });
  if (!updated) fail('not_found', `investigation ${id} not found`);
  return InvestigationRecordSchema.parse(updated!);
}

export function getInvestigation(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
): InvestigationRecord {
  return scopedOrThrow(store, workspaceId, id);
}

export function listInvestigations(
  store: InvestigationStore,
  workspaceId: string,
  domain?: string,
): InvestigationRecord[] {
  requireWorkspace(workspaceId);
  const rows = store.list(workspaceId, domain ? normalizeInvestigationDomain(domain) : undefined);
  return rows.map((r) => InvestigationRecordSchema.parse(r));
}

export function getInvestigationStatus(
  store: InvestigationStore,
  workspaceId: string,
  id: string,
): Pick<InvestigationRecord, 'id' | 'status' | 'failureCode' | 'updatedAt'> {
  const record = scopedOrThrow(store, workspaceId, id);
  return { id: record.id, status: record.status, failureCode: record.failureCode, updatedAt: record.updatedAt };
}
