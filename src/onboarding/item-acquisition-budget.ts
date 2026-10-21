import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { randomUUID } from 'node:crypto';
import { findWorkspacePathById } from '../db/repositories/workspace-repo';
import {
  getItemAcquisitionBatchId,
  markItemAcquisitionBudgetDispatched,
  releaseItemAcquisitionBudgetAttempt,
  reserveItemAcquisitionBudgetAttempt,
  settleAbandonedItemAcquisitionBudgetAttempts,
  settleItemAcquisitionBudgetAttempt,
  type ItemAcquisitionResources,
} from '../db/repositories/item-acquisition-budget-repo';
import {
  ItemAcquisitionPolicyDocumentSchema,
  ItemAcquisitionPolicySchema,
  type ItemAcquisitionPolicyDocument,
  type ItemAcquisitionLimits,
  type ItemAcquisitionModelPrice,
  type ItemAcquisitionPolicy,
} from '../shared/schemas/item-acquisition';
import { InvestigationBudgetSchema, type InvestigationBudget } from '../shared/schemas/browser-investigation';
import { BudgetLedger, type BudgetLedgerRequestAttempt } from './browser-investigation/budgets';
import { hashCanonicalJson } from '../shared/stable-id';

export type ItemAcquisitionPolicyUnavailableReason = 'policy_not_configured' | 'policy_disabled' | 'policy_invalid' | 'workspace_unavailable';
export type ItemAcquisitionPolicyLoadResult =
  | { status: 'available'; policy: ItemAcquisitionPolicy; policyHash: string; pricingHash: string }
  | { status: 'unavailable'; reason: ItemAcquisitionPolicyUnavailableReason };

export type ItemAcquisitionBudgetDenialCode =
  | ItemAcquisitionPolicyUnavailableReason
  | 'budget_not_enforceable'
  | 'budget_exhausted'
  | 'concurrency_limit'
  | 'model_not_approved'
  | 'cancelled'
  | 'lease_lost'
  | 'policy_changed';

export class ItemAcquisitionBudgetDeniedError extends Error {
  constructor(readonly code: ItemAcquisitionBudgetDenialCode, readonly detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'ItemAcquisitionBudgetDeniedError';
  }
}

export interface ItemAcquisitionBudgetScopeInput {
  workspaceId: string;
  itemId: string;
  runId: string;
  signal?: AbortSignal;
  assertHeld?: () => void;
}

export interface ItemAcquisitionAttemptInput {
  kind: 'model' | 'serper_search' | 'browser';
  provider: string;
  model: string;
  resources: ItemAcquisitionResources;
}

export interface ItemAcquisitionReservation {
  id: string;
  batchId: string;
  policyHash: string;
  pricingHash: string;
  resources: ItemAcquisitionResources;
  costMicros: number | null;
}

export interface ItemAcquisitionBudgetScope {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly policy: ItemAcquisitionPolicy;
  readonly policyHash: string;
  readonly pricingHash: string;
  readonly signal: AbortSignal;
  assertHeld(): void;
}

interface ActiveScope extends ItemAcquisitionBudgetScope {
  readonly input: ItemAcquisitionBudgetScopeInput;
  readonly reservationIds: Set<string>;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const budgetScope = new AsyncLocalStorage<ActiveScope>();
const POLICY_RELATIVE_PATH = path.join('store', 'item-acquisition', 'policy.json');
const POLICY_LOCK_RELATIVE_PATH = path.join('.shopsite-cms', 'locks', 'item-acquisition-policy.lock');

function repositoryRoot(workspacePath: string): string {
  const root = path.resolve(workspacePath);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('workspace_root_invalid');
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (path.resolve(gitRoot) !== root) throw new Error('workspace_git_root_invalid');
  return root;
}

function policyPath(workspacePath: string, create: boolean): string {
  const root = repositoryRoot(workspacePath);
  const storePath = path.join(root, 'store');
  if (create && !fs.existsSync(storePath)) fs.mkdirSync(storePath);
  if (!fs.existsSync(storePath)) return path.join(storePath, 'item-acquisition', 'policy.json');
  const storeStat = fs.lstatSync(storePath);
  if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) throw new Error('policy_store_invalid');
  const directory = path.join(storePath, 'item-acquisition');
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory);
  if (fs.existsSync(directory)) {
    const dirStat = fs.lstatSync(directory);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('policy_directory_invalid');
  }
  return path.join(directory, 'policy.json');
}

function readPolicyDocument(workspacePath: string): { document: ItemAcquisitionPolicyDocument | null; documentHash: string | null; gitHead: string | null } {
  const root = repositoryRoot(workspacePath);
  const file = policyPath(root, false);
  const stat = fs.existsSync(path.dirname(file)) ? fs.lstatSync(file, { throwIfNoEntry: false }) : undefined;
  const relative = POLICY_RELATIVE_PATH.split(path.sep).join('/');
  let trackedContent: string | null = null;
  try { trackedContent = execFileSync('git', ['show', `HEAD:${relative}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { /* an absent committed policy is the expected unconfigured state */ }
  if (!stat && trackedContent !== null) throw new Error('policy_worktree_differs_from_git');
  let document: ItemAcquisitionPolicyDocument | null = null;
  let documentHash: string | null = null;
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('policy_file_invalid');
    const content = fs.readFileSync(file, 'utf8');
    if (trackedContent === null || content !== trackedContent) throw new Error('policy_worktree_differs_from_git');
    document = ItemAcquisitionPolicyDocumentSchema.parse(JSON.parse(content));
    documentHash = hashCanonicalJson(document);
  }
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return { document, documentHash, gitHead: gitHead || null };
}

function priceHash(policy: ItemAcquisitionPolicy): string {
  return hashCanonicalJson({ models: policy.models, services: policy.services });
}

function availablePolicy(policy: ItemAcquisitionPolicy): ItemAcquisitionPolicyLoadResult {
  if (!policy.enabled) return { status: 'unavailable', reason: 'policy_disabled' };
  return { status: 'available', policy, policyHash: hashCanonicalJson(policy), pricingHash: priceHash(policy) };
}

/** Load only an explicit, valid Git-backed policy. No policy file means unavailable, never an implicit default. */
export function loadItemAcquisitionPolicy(workspaceId: string): ItemAcquisitionPolicyLoadResult {
  let workspacePath: string | null;
  try { workspacePath = findWorkspacePathById(workspaceId); }
  catch { return { status: 'unavailable', reason: 'workspace_unavailable' }; }
  if (!workspacePath) return { status: 'unavailable', reason: 'workspace_unavailable' };
  try {
    const loaded = readPolicyDocument(workspacePath);
    if (!loaded.document || !loaded.documentHash) return { status: 'unavailable', reason: 'policy_not_configured' };
    return availablePolicy(loaded.document.policy);
  } catch {
    return { status: 'unavailable', reason: 'policy_invalid' };
  }
}

export interface ItemAcquisitionPolicySnapshot {
  policy: ItemAcquisitionPolicy | null;
  documentHash: string | null;
  gitHead: string | null;
  policyHash: string | null;
  pricingHash: string | null;
}

/** Safe policy readback; contains configuration and hashes only, never provider credentials. */
export function readItemAcquisitionPolicy(workspacePath: string): ItemAcquisitionPolicySnapshot {
  const current = readPolicyDocument(workspacePath);
  const policy = current.document?.policy ?? null;
  return {
    policy,
    documentHash: current.documentHash,
    gitHead: current.gitHead,
    policyHash: policy ? hashCanonicalJson(policy) : null,
    pricingHash: policy ? priceHash(policy) : null,
  };
}

export interface ItemAcquisitionPolicyPreview {
  policy: ItemAcquisitionPolicy;
  policyHash: string;
  pricingHash: string;
  documentHash: string | null;
  gitHead: string | null;
  findings: string[];
}

export function previewItemAcquisitionPolicy(input: { workspacePath: string; policy: unknown }): ItemAcquisitionPolicyPreview {
  const policy = ItemAcquisitionPolicySchema.parse(input.policy);
  if (policy.enabled && policy.models.length + policy.services.length === 0) throw new Error('enabled_policy_has_no_approved_adapter');
  const current = readPolicyDocument(input.workspacePath);
  return {
    policy, policyHash: hashCanonicalJson(policy), pricingHash: priceHash(policy),
    documentHash: current.documentHash, gitHead: current.gitHead,
    findings: policy.enabled ? [] : ['Policy is disabled; acquisition calls remain unavailable.'],
  };
}

function runGit(workspacePath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function lockPolicy(workspacePath: string): Promise<() => Promise<void>> {
  const lockPath = path.join(workspacePath, POLICY_LOCK_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return lockfile.lock(lockPath, { realpath: false, stale: 60_000, retries: { retries: 10, factor: 1.5, minTimeout: 25, maxTimeout: 300 } });
}

/** Re-validate preview hashes under a cross-process lock, then commit only the policy file. */
export async function applyItemAcquisitionPolicy(input: {
  workspacePath: string;
  actor: string;
  policy: unknown;
  expectedDocumentHash: string | null;
  expectedGitHead: string | null;
  expectedPolicyHash: string;
}): Promise<{ policy: ItemAcquisitionPolicy; policyHash: string; pricingHash: string; documentHash: string; gitHead: string }> {
  const policy = ItemAcquisitionPolicySchema.parse(input.policy);
  if (!input.actor.trim()) throw new Error('actor_required');
  if (hashCanonicalJson(policy) !== input.expectedPolicyHash) throw new Error('preview_policy_mismatch');
  if (policy.enabled && policy.models.length + policy.services.length === 0) throw new Error('enabled_policy_has_no_approved_adapter');
  const root = repositoryRoot(input.workspacePath);
  const release = await lockPolicy(root);
  const relative = POLICY_RELATIVE_PATH.split(path.sep).join('/');
  const file = policyPath(root, true);
  let previous: string | null = null;
  let wrote = false;
  try {
    const current = readPolicyDocument(root);
    if (current.documentHash !== input.expectedDocumentHash || current.gitHead !== input.expectedGitHead) throw new Error('policy_conflict');
    const stagedBefore = runGit(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (stagedBefore.length) throw new Error('pre_staged_paths');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('policy_file_invalid');
      previous = fs.readFileSync(file, 'utf8');
    }
    const document = ItemAcquisitionPolicyDocumentSchema.parse({
      schemaVersion: 1, policy, approvedBy: input.actor, approvedAt: new Date().toISOString(),
    });
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const savedDocumentHash = hashCanonicalJson(document);
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'w' });
    wrote = true;
    runGit(root, ['add', '--', relative]);
    const staged = runGit(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    if (staged.length !== 1 || staged[0] !== relative) throw new Error('git_out_of_scope');
    runGit(root, ['commit', '--only', '-m', `Update item acquisition policy ${hashCanonicalJson(policy).slice(0, 12)}`, '--', relative]);
    const gitHead = runGit(root, ['rev-parse', 'HEAD']);
    return { policy, policyHash: hashCanonicalJson(policy), pricingHash: priceHash(policy), documentHash: savedDocumentHash, gitHead };
  } catch (error) {
    if (wrote) {
      if (previous === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previous, 'utf8');
      try { runGit(root, ['reset', '--', relative]); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    await release();
  }
}

function assertResources(resources: ItemAcquisitionResources): void {
  for (const value of Object.values(resources)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_budget_resources');
}

function assertWithinLimits(resources: ItemAcquisitionResources, itemLimits: ItemAcquisitionLimits, batchLimits: ItemAcquisitionLimits): void {
  for (const key of Object.keys(resources) as Array<keyof ItemAcquisitionResources>) {
    if (resources[key] > itemLimits[key] || resources[key] > batchLimits[key]) throw new ItemAcquisitionBudgetDeniedError('budget_exhausted', key);
  }
}

function costForAttempt(scope: ActiveScope, input: ItemAcquisitionAttemptInput): number | null {
  const requiresCost = scope.policy.itemLimits.maxCostMicros !== null || scope.policy.batchLimits.maxCostMicros !== null;
  if (input.kind === 'model') {
    const price = scope.policy.models.find(entry => entry.provider === input.provider && entry.model === input.model);
    if (!price) throw new ItemAcquisitionBudgetDeniedError('model_not_approved', `${input.provider}/${input.model}`);
    if (input.resources.bytes > price.maxRequestBytes || input.resources.inputTokens > price.maxInputTokensPerAttempt || input.resources.outputTokens > price.maxOutputTokensPerAttempt) {
      throw new ItemAcquisitionBudgetDeniedError('budget_exhausted', 'model_attempt_limit');
    }
    if (price.outputLimit !== 'max_tokens') throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'model_output_limit');
    if (price.inputMicrosPerMillionTokens === null || price.outputMicrosPerMillionTokens === null) {
      if (requiresCost) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'model_price_unknown');
      return null;
    }
    return safeCostSum(
      tokenCost(input.resources.inputTokens, price.inputMicrosPerMillionTokens),
      tokenCost(input.resources.outputTokens, price.outputMicrosPerMillionTokens),
    );
  }
  const service = scope.policy.services.find(entry => entry.service === input.kind);
  if (!service) throw new ItemAcquisitionBudgetDeniedError('model_not_approved', input.kind);
  if (service.costMicrosPerAttempt === null) {
    if (requiresCost) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', `${input.kind}_price_unknown`);
    return null;
  }
  const serviceCost = BigInt(service.costMicrosPerAttempt) * BigInt(input.resources.attempts);
  if (serviceCost > BigInt(Number.MAX_SAFE_INTEGER)) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'cost_overflow');
  return Number(serviceCost);
}

function tokenCost(tokens: number, rateMicrosPerMillionTokens: number): number {
  const cost = (BigInt(tokens) * BigInt(rateMicrosPerMillionTokens) + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'cost_overflow');
  return Number(cost);
}

function safeCostSum(left: number, right: number): number {
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'cost_overflow');
  return Number(sum);
}

function activeScope(): ActiveScope {
  const scope = budgetScope.getStore();
  if (!scope) throw new ItemAcquisitionBudgetDeniedError('policy_not_configured', 'missing_item_scope');
  scope.assertHeld();
  return scope;
}

function mapRepositoryError(error: unknown): ItemAcquisitionBudgetDeniedError {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('budget_exhausted:')) return new ItemAcquisitionBudgetDeniedError('budget_exhausted', message.slice('budget_exhausted:'.length));
  if (message.startsWith('concurrency_limit:')) return new ItemAcquisitionBudgetDeniedError('concurrency_limit', message.slice('concurrency_limit:'.length));
  if (message.startsWith('budget_not_enforceable:')) return new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', message.slice('budget_not_enforceable:'.length));
  if (message === 'reservation_not_dispatchable' || message === 'reservation_not_settleable' || message === 'reservation_not_releasable') return new ItemAcquisitionBudgetDeniedError('policy_changed', message);
  return new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'reservation_unavailable');
}

export function getItemAcquisitionModelPrice(provider: string, model: string): ItemAcquisitionModelPrice | null {
  const scope = budgetScope.getStore();
  if (!scope) return null;
  scope.assertHeld();
  const entry = scope.policy.models.find(price => price.provider === provider && price.model === model);
  if (!entry) throw new ItemAcquisitionBudgetDeniedError('model_not_approved', `${provider}/${model}`);
  return entry;
}

export function getItemAcquisitionModelOutputLimit(provider: string, model: string): number | null {
  const scope = budgetScope.getStore();
  if (!scope) return null;
  scope.assertHeld();
  const price = getItemAcquisitionModelPrice(provider, model);
  return price ? Math.min(price.maxOutputTokensPerAttempt, scope.policy.itemLimits.outputTokens, scope.policy.batchLimits.outputTokens) : null;
}

export function getItemAcquisitionBudgetSignal(signal?: AbortSignal): AbortSignal | undefined {
  const scope = budgetScope.getStore();
  if (!scope) return signal;
  return signal ? AbortSignal.any([scope.signal, signal]) : scope.signal;
}
export interface ItemAcquisitionModelAttempt {
  reservation: ItemAcquisitionReservation;
  maxOutputTokens: number;
  maxResponseBytes: number;
  markDispatched(): void;
  settle(input: { responseBytes: number; inputTokens?: number; outputTokens?: number; durationMs: number }): void;
  settleUnknown(): void;
  release(): void;
}

/** Reserve a text-model request using byte-derived input-token upper bounds and the provider's enforced output cap. */
export function reserveItemAcquisitionModelAttempt(input: {
  provider: string;
  model: string;
  requestBytes: number;
  requestedOutputTokens: number;
  timeoutMs: number;
}): ItemAcquisitionModelAttempt | null {
  const scope = budgetScope.getStore();
  if (!scope) return null;
  scope.assertHeld();
  const price = getItemAcquisitionModelPrice(input.provider, input.model);
  if (!price) return null;
  if (price.outputLimit !== 'max_tokens') throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'model_output_limit');
  const maxOutputTokens = Math.min(price.maxOutputTokensPerAttempt, scope.policy.itemLimits.outputTokens, scope.policy.batchLimits.outputTokens);
  const maxResponseBytes = price.maxResponseBytesPerAttempt;
  if (!Number.isSafeInteger(input.requestBytes) || input.requestBytes < 1 ||
    input.requestBytes > price.maxRequestBytes || input.requestBytes > price.maxInputTokensPerAttempt ||
    maxOutputTokens < 1 || input.requestedOutputTokens < 1) {
    throw new ItemAcquisitionBudgetDeniedError('budget_exhausted', 'model_attempt_limit');
  }
  const outputTokens = Math.min(input.requestedOutputTokens, maxOutputTokens);
  const timeoutMs = Math.min(input.timeoutMs, scope.policy.itemLimits.durationMs, scope.policy.batchLimits.durationMs);
  const maximumBytes = input.requestBytes + maxResponseBytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < input.requestBytes || timeoutMs < 1) {
    throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'model_attempt_limit_overflow');
  }
  const requestResources: ItemAcquisitionResources = {
    attempts: 1, pages: 0, actions: 0, redirects: 0,
    bytes: maximumBytes, artifacts: 0,
    durationMs: timeoutMs, inputTokens: input.requestBytes, outputTokens,
  };
  const reservation = reserveItemAcquisitionAttempt({ kind: 'model', provider: input.provider, model: input.model, resources: requestResources });
  let dispatched = false;
  let finished = false;
  const settleUnknown = (): void => {
    if (finished) return;
    settleItemAcquisitionAttempt(reservation.id, { actualResources: reservation.resources, billing: 'unknown' });
    finished = true;
  };
  return {
    reservation, maxOutputTokens: outputTokens, maxResponseBytes,
    markDispatched() {
      if (finished || dispatched) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'model_attempt_state');
      markItemAcquisitionDispatched(reservation.id);
      dispatched = true;
    },
    settle(usage) {
      if (!dispatched || finished) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'model_attempt_state');
      const inputTokens = usage.inputTokens ?? requestResources.inputTokens;
      const outputTokens = usage.outputTokens ?? requestResources.outputTokens;
      const responseBytes = usage.responseBytes;
      if (![inputTokens, outputTokens, responseBytes, usage.durationMs].every(value => Number.isSafeInteger(value) && value >= 0)) {
        settleUnknown();
        throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'model_usage_invalid');
      }
      const actualResources: ItemAcquisitionResources = {
        ...requestResources,
        bytes: input.requestBytes + responseBytes,
        durationMs: usage.durationMs,
        inputTokens, outputTokens,
      };
      if (!Number.isSafeInteger(actualResources.bytes)) {
        settleUnknown();
        throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'model_usage_overflow');
      }
      const ratesKnown = price.inputMicrosPerMillionTokens !== null && price.outputMicrosPerMillionTokens !== null;
      const billing = usage.inputTokens !== undefined && usage.outputTokens !== undefined && ratesKnown ? 'known' : 'unknown';
      const actualCostMicros = billing === 'known'
        ? safeCostSum(tokenCost(inputTokens, price.inputMicrosPerMillionTokens!), tokenCost(outputTokens, price.outputMicrosPerMillionTokens!))
        : undefined;
      settleItemAcquisitionAttempt(reservation.id, {
        actualResources, billing, ...(billing === 'known' ? { actualCostMicros } : {}),
      });
      finished = true;
      if (actualResources.bytes > requestResources.bytes || inputTokens > requestResources.inputTokens ||
        outputTokens > requestResources.outputTokens || usage.durationMs > requestResources.durationMs) {
        throw new ItemAcquisitionBudgetDeniedError('budget_exhausted', 'model_attempt_overrun');
      }
    },
    settleUnknown,
    release() {
      if (finished) return;
      if (dispatched) return settleUnknown();
      releaseItemAcquisitionReservation(reservation.id, 'model_attempt_not_dispatched');
      finished = true;
    },
  };
}


export function reserveItemAcquisitionAttempt(input: ItemAcquisitionAttemptInput): ItemAcquisitionReservation {
  const scope = activeScope();
  assertResources(input.resources);
  assertWithinLimits(input.resources, scope.policy.itemLimits, scope.policy.batchLimits);
  const costMicros = costForAttempt(scope, input);
  const batchId = scope.batchId;
  const id = randomUUID();
  try {
    reserveItemAcquisitionBudgetAttempt({
      id, workspaceId: scope.workspaceId, batchId, itemId: scope.itemId, runId: scope.runId,
      provider: input.provider, model: input.model, kind: input.kind, policyHash: scope.policyHash, pricingHash: scope.pricingHash,
      reservedResources: input.resources, costMicros, itemLimits: scope.policy.itemLimits, batchLimits: scope.policy.batchLimits,
    });
    scope.reservationIds.add(id);
    return { id, batchId, policyHash: scope.policyHash, pricingHash: scope.pricingHash, resources: input.resources, costMicros };
  } catch (error) { throw mapRepositoryError(error); }
}

export function markItemAcquisitionDispatched(id: string): void {
  const scope = activeScope();
  if (!scope.reservationIds.has(id)) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'reservation_scope_mismatch');
  try { markItemAcquisitionBudgetDispatched(id, scope.workspaceId, scope.itemId, scope.runId); }
  catch (error) { throw mapRepositoryError(error); }
}

export function settleItemAcquisitionAttempt(id: string, input: { actualResources: ItemAcquisitionResources; billing: 'known' | 'unknown' | 'not_applicable'; actualCostMicros?: number | null }): void {
  const scope = activeScope();
  if (!scope.reservationIds.has(id)) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'reservation_scope_mismatch');
  assertResources(input.actualResources);
  try {
    settleItemAcquisitionBudgetAttempt({
      id, workspaceId: scope.workspaceId, itemId: scope.itemId, runId: scope.runId,
      actualResources: input.actualResources, billing: input.billing,
      actualCostMicros: input.billing === 'known' ? input.actualCostMicros ?? null : null,
    });
  } catch (error) { throw mapRepositoryError(error); }
}

export function releaseItemAcquisitionReservation(id: string, reason: string): void {
  const scope = activeScope();
  if (!scope.reservationIds.has(id)) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'reservation_scope_mismatch');
  try { releaseItemAcquisitionBudgetAttempt(id, scope.workspaceId, scope.itemId, scope.runId, reason); }
  catch (error) { throw mapRepositoryError(error); }
}

export async function withItemAcquisitionBudget<T>(input: ItemAcquisitionBudgetScopeInput, work: (scope: ItemAcquisitionBudgetScope) => Promise<T>): Promise<T> {
  const existing = budgetScope.getStore();
  if (existing) {
    if (existing.workspaceId !== input.workspaceId || existing.itemId !== input.itemId || existing.runId !== input.runId) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'nested_scope_mismatch');
    existing.assertHeld();
    return work(existing);
  }
  if (input.signal?.aborted) throw new ItemAcquisitionBudgetDeniedError('cancelled');
  const loaded = loadItemAcquisitionPolicy(input.workspaceId);
  if (loaded.status !== 'available') throw new ItemAcquisitionBudgetDeniedError(loaded.reason);
  const batchId = getItemAcquisitionBatchId(input.workspaceId, input.itemId);
  if (!batchId) throw new ItemAcquisitionBudgetDeniedError('workspace_unavailable', 'item_owner_unavailable');
  const abortController = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abortController.signal]) : abortController.signal;
  const startedAt = Date.now();
  const deadlineAt = startedAt + loaded.policy.itemLimits.durationMs;
  const timeout = setTimeout(() => abortController.abort(new Error('item acquisition time budget exhausted')), loaded.policy.itemLimits.durationMs);
  const scope: ActiveScope = {
    workspaceId: input.workspaceId, itemId: input.itemId, batchId, runId: input.runId,
    policy: loaded.policy, policyHash: loaded.policyHash, pricingHash: loaded.pricingHash,
    signal, input, reservationIds: new Set(), startedAt, deadlineAt, timeout,
    assertHeld() {
      if (signal.aborted || Date.now() >= deadlineAt) throw new ItemAcquisitionBudgetDeniedError('cancelled', 'time_or_signal');
      try { input.assertHeld?.(); } catch { throw new ItemAcquisitionBudgetDeniedError('lease_lost'); }
    },
  };
  try {
    return await budgetScope.run(scope, () => work(scope));
  } finally {
    clearTimeout(timeout);
    try { settleAbandonedItemAcquisitionBudgetAttempts([...scope.reservationIds], scope.workspaceId, scope.itemId, scope.runId); }
    catch { /* durable rows remain reserved/dispatched, preserving fail-closed commitments */ }
  }
}

/** Convert approved ceilings to browser request constraints without selecting acquisition-policy defaults. */
export function itemAcquisitionInvestigationBudget(): InvestigationBudget {
  const scope = activeScope();
  const limits = scope.policy.itemLimits;
  const bounded = (value: number, technicalMaximum: number, field: string): number => {
    if (value > technicalMaximum) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', `browser_${field}_limit`);
    return value;
  };
  const perObservationBytes = limits.actions === 0 ? 0 : Math.floor(limits.bytes / limits.actions);
  const maxObservationBytesPerOperation = bounded(perObservationBytes, 32_768, 'observation_bytes');
  const byteLimit = bounded(limits.bytes, 50 * 1024 * 1024, 'bytes');
  const artifactBytes = bounded(limits.bytes, 50 * 1024 * 1024, 'artifact_bytes');
  const monetaryCaps = [scope.policy.itemLimits.maxCostMicros, scope.policy.batchLimits.maxCostMicros]
    .filter((value): value is number => value !== null);
  const maxCostMicros = monetaryCaps.length === 0 ? null : Math.min(...monetaryCaps);
  const maxCostUsd = maxCostMicros === null ? undefined : maxCostMicros / 1_000_000;
  if (maxCostMicros !== null && !Number.isFinite(maxCostUsd)) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'browser_cost_limit');
  const raw = {
    maxPages: bounded(limits.pages, 5, 'pages'),
    maxReads: bounded(limits.actions, 20, 'actions'),
    maxModelCalls: bounded(Math.max(1, limits.attempts), 8, 'model_calls'),
    timeoutMs: bounded(limits.durationMs, 600_000, 'duration'),
    maxResponseBytesPerResponse: bounded(byteLimit, 5 * 1024 * 1024, 'response_bytes'),
    maxTotalResponseBytesTransferred: byteLimit,
    maxTotalResponseBytesDecompressed: byteLimit,
    maxRequestAttempts: bounded(limits.attempts, 500, 'attempts'),
    maxArtifactBytesPerArtifact: bounded(artifactBytes, 5 * 1024 * 1024, 'artifact_bytes_per_item'),
    maxArtifactBytesTotal: artifactBytes,
    maxObservationBytesPerOperation,
    maxModelInputBytesPerCall: bounded(byteLimit, 64 * 1024, 'model_input_bytes'),
    maxModelInputBytesTotal: bounded(byteLimit, 256 * 1024, 'model_input_bytes_total'),
    maxModelOutputTokensPerCall: bounded(Math.max(1, limits.outputTokens), 4096, 'output_tokens'),
    maxModelResultBytesPerCall: bounded(byteLimit, 32 * 1024, 'model_result_bytes'),
    maxImageAttachmentsTotal: 0,
    maxImageBytesPerImage: 512 * 1024,
    maxImageLongestEdgePx: 1024,
    maxSelectorLength: 512,
    maxSelectorMatches: 100,
    maxJsonPointerDepth: 32,
    maxJsonNodesVisited: 10_000,
    maxRedirectHops: bounded(limits.redirects, 10, 'redirects'),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
  const parsed = InvestigationBudgetSchema.safeParse(raw);
  if (!parsed.success) throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'browser_policy_incompatible');
  return parsed.data;

}

/** Build a browser ledger whose every broker request has a durable pre-dispatch byte and duration reservation. */
export function createItemAcquisitionBudgetLedger(): BudgetLedger {
  const budget = itemAcquisitionInvestigationBudget();
  return new BudgetLedger(budget, {
    beforeRequestAttempt(input) {
      const reservation = reserveItemAcquisitionAttempt({
        kind: 'browser',
        provider: 'browser',
        model: '',
        resources: {
          attempts: 1, pages: 0, actions: 0, redirects: 1,
          bytes: input.maxResponseBytes, artifacts: 0,
          durationMs: input.timeoutMs, inputTokens: 0, outputTokens: 0,
        },
      });
      let dispatched = false;
      let finished = false;
      const assertOpen = (): void => {
        if (finished) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'browser_attempt_already_settled');
      };
      const settle = (redirects: number, bytes: number, durationMs: number, billing: 'known' | 'unknown'): void => {
        assertOpen();
        if (![redirects, bytes, durationMs].every(value => Number.isSafeInteger(value) && value >= 0)) {
          throw new ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'browser_usage_invalid');
        }
        const actualResources = { ...reservation.resources, redirects, bytes, durationMs };
        settleItemAcquisitionAttempt(reservation.id, {
          actualResources,
          billing,
          ...(billing === 'known' ? { actualCostMicros: reservation.costMicros } : {}),
        });
        finished = true;
        if (bytes > reservation.resources.bytes || durationMs > reservation.resources.durationMs) {
          throw new ItemAcquisitionBudgetDeniedError('budget_exhausted', 'browser_attempt_overrun');
        }
      };
      return {
        markDispatched() {
          assertOpen();
          markItemAcquisitionDispatched(reservation.id);
          dispatched = true;
        },
        settle(input: { redirects: number; bytes: number; durationMs: number }) {
          if (!dispatched) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'browser_attempt_not_dispatched');
          settle(input.redirects, input.bytes, input.durationMs, reservation.costMicros === null ? 'unknown' : 'known');
        },
        settleUnknown() {
          assertOpen();
          if (!dispatched) {
            releaseItemAcquisitionReservation(reservation.id, 'browser_attempt_not_dispatched');
            finished = true;
            return;
          }
          settle(reservation.resources.redirects, reservation.resources.bytes, reservation.resources.durationMs, 'unknown');
        },
        release() {
          assertOpen();
          if (dispatched) throw new ItemAcquisitionBudgetDeniedError('policy_changed', 'dispatched_browser_attempt_cannot_release');
          releaseItemAcquisitionReservation(reservation.id, 'browser_attempt_not_dispatched');
          finished = true;
        },
      } satisfies BudgetLedgerRequestAttempt;
    },
  });
}
