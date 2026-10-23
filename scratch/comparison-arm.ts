import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { materializeQualificationRuntime, readQualificationFreeze, validateQualificationRuntime, type QualificationRuntimeValidation } from './comparison-runtime';
import { importQualificationRuntimeRecords } from '../src/db/repositories/qualification-runtime-repo';
import { closeDb, getDb, initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { OnboardingWorker } from '../src/onboarding/job-queue';
import { createBatch, findBatchById, updateBatchExecutionState } from '../src/db/repositories/onboarding-batch-repo';
import { holdBatchItems, insertItems, listItemsByBatch, releaseBatchItems, type InsertItemData } from '../src/db/repositories/onboarding-item-repo';
import { deriveSourcingEntryStage, SOURCING_ENTRY_POLICY_VERSION } from '../src/onboarding/sourcing/entry-policy';
import { getSourcingFlags } from '../src/onboarding/flags';
import type { OnboardingItem } from '../src/shared/schemas/onboarding';
import { Database } from 'bun:sqlite';
import { createPaidEffectBudgetClient, PaidEffectBudgetCoordinator, type PaidEffectBudgetClient } from '../src/ai/paid-effect-budget';
import type { PaidEffectAuthorization, QualificationPaidEffectScope, VerifiedPaidEffectBillingContract } from '../src/shared/schemas/paid-effect';
import { pilotBudgetAuthorization } from './comparison-budget';

export type ArmStop = 'preflight_denied' | 'review_ready' | 'needs_input' | 'denied' | 'failed' | 'deadline' | 'no-progress';
export interface ArmResult { arm: 'baseline' | 'candidate'; stop: ArmStop; imported: number; polls: number; state: unknown; denial?: string }
export interface ArmBootstrapOptions { arm: 'baseline' | 'candidate'; freezePath: string; privateRoot: string; workspacePath: string; destinationRoot: string; dbPath: string; credentialFd?: number; budgetDbPath?: string }
export interface PopulationRow { upc: string; register_name: string; price: number; brandHint?: string | null }
export interface PreparedArm { arm: ArmBootstrapOptions['arm']; imported: number; batchId: string; itemIds: string[]; workspacePath: string }
export interface ArmPreflightResult { arm: ArmBootstrapOptions['arm']; prepared?: PreparedArm; imported: number; denial?: string }

/** Policy rejection: frozen authorization/cap/contract refuses paid release.
 * Operational failures (ledger open, coordinator construct) are NOT this class
 * and propagate as structured failures instead of policy denials. */
export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

function redacted(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY)=[^\s,;]+|[A-Za-z0-9_-]{32,})/gi, '[REDACTED]').slice(0, 1000);
}
async function credentials(fd: number | undefined, run: QualificationRuntimeValidation): Promise<Record<string,string>> {
  const expected = run.run.credentialReferences;
  if (!expected.length) return {};
  if (!Number.isInteger(fd) || fd! < 3) throw new Error('Declared credentials require a private credential FD');
  const input = await readFile(`/dev/fd/${fd}`, 'utf8');
  const supplied = JSON.parse(input) as Record<string, unknown>;
  const allowed = new Set(expected.map(item => item.environmentKey));
  if (Object.keys(supplied).some(key => !allowed.has(key)) || expected.some(item => typeof supplied[item.environmentKey] !== 'string' || !supplied[item.environmentKey])) throw new Error('Credential FD does not exactly match declared bindings');
  return Object.fromEntries(expected.map(item => [item.environmentKey, supplied[item.environmentKey] as string]));
}

/** Prepare an arm's isolated runtime and import only the caller-selected split rows, held in a paused batch. */
export async function preflightComparisonArm(options: ArmBootstrapOptions, rows: readonly PopulationRow[]): Promise<ArmPreflightResult> {
  let initialized = false;
  try {
    const resolveRooted = (value: string): string => value.startsWith('/') ? value : path.join(options.privateRoot, value);
    const run = await readQualificationFreeze(resolveRooted(options.freezePath));
    if (!run.authorizedArms.includes(options.arm)) throw new Error(`Arm not authorized: ${options.arm}`);
    if (rows.length === 0) throw new Error('Selected split population is empty');
    if (rows.length > run.limits.maxItems) throw new Error('Population exceeds frozen item limit');
    const db: Database = initDb(options.dbPath);
    initialized = true;
    runMigrations();
    const validation = await materializeQualificationRuntime(resolveRooted(options.freezePath), options.privateRoot, resolveRooted(options.workspacePath), path.resolve(options.destinationRoot), db);
    importQualificationRuntimeRecords(db, validation.run.runtimeRecords, validation.run.workspaceId);
    const items: InsertItemData[] = rows.map((row, index) => ({
      upc: row.upc, name: row.register_name, price: String(row.price), rowNumber: index + 1,
      brandHint: row.brandHint ?? null,
      isHeld: true, stageStatus: 'pending',
    }));
    const batch = createBatch({
      workspaceId: validation.run.workspaceId, name: `Qualification ${options.arm}`, fileName: 'selected-split-rows',
      totalItems: items.length, executionState: 'paused',
      columnMappingJson: JSON.stringify({ upc: 'upc', name: 'register_name', price: 'price' }),
    });
    // Pilot enters directly at Discovery: the sourcing leg is default-on but the worker's
    // auto-stage list never claims route_sources items, stranding them. Sourcing routing
    // is a separate product decision, not part of this Discovery/confirmation pilot.
    const inserted = insertItems(batch.id, items, 'find_product_page', SOURCING_ENTRY_POLICY_VERSION);
    holdBatchItems(batch.id, inserted.map(item => item.id), 'Qualification preflight: awaiting both-arm release.');
    const persisted = listItemsByBatch(batch.id);
    if (persisted.length !== rows.length || persisted.some(item => !item.isHeld || item.stageStatus !== 'pending')) throw new Error('Held population reconciliation failed');
    return { arm: options.arm, imported: persisted.length, prepared: { arm: options.arm, imported: persisted.length, batchId: batch.id, itemIds: persisted.map(item => item.id), workspacePath: validation.workspacePath } };
  } catch (error) {
    return { arm: options.arm, imported: 0, denial: redacted(error) };
  } finally {
    if (initialized) closeDb();
  }
}

/** Release a previously prepared arm only after the coordinator has preflighted every requested arm.
 * T4: with a budget input, builds a shared paid-effect coordinator and threads scope + Serper
 * contract into the worker; every Serper POST / browser session reserves against the run ledger. */
export async function releaseComparisonArm(options: ArmBootstrapOptions, prepared: PreparedArm, budget?: { runId: string; capUsd: number; paidEffect?: RunPaidEffect }): Promise<ArmResult> {
  let bindings: Record<string, string> = {};
  let initialized = false;
  try {
    const freezeResolved = options.freezePath.startsWith('/') ? options.freezePath : path.join(options.privateRoot, options.freezePath);
    const db: Database = initDb(options.dbPath);
    initialized = true;
    runMigrations();
    const validation = await validateQualificationRuntime(freezeResolved, options.privateRoot, prepared.workspacePath, db);
    if (!validation.run.authorizedArms.includes(options.arm) || prepared.arm !== options.arm || !prepared.batchId) throw new Error('Arm release does not match a successful preflight');
    bindings = await credentials(options.credentialFd, validation);
    for (const [key, value] of Object.entries(bindings)) process.env[key] = value;
    const batch = findBatchById(prepared.batchId);
    if (!batch || batch.workspaceId !== validation.run.workspaceId || batch.executionState !== 'paused') throw new Error('Prepared batch is missing, foreign, or no longer paused');
    const items = listItemsByBatch(prepared.batchId);
    if (items.length !== prepared.imported || items.some(item => !prepared.itemIds.includes(item.id) || !item.isHeld)) throw new Error('Prepared held batch changed before release');
    const released = releaseBatchItems(prepared.batchId, prepared.itemIds);
    if (released !== prepared.imported) throw new Error('Population release reconciliation failed');
    updateBatchExecutionState(prepared.batchId, 'running');
    const paidEffect = budget?.paidEffect;
    const result = await runBoundedWorker(options, validation, prepared, items.length, paidEffect);
    if (paidEffect) {
      try {
        const snapshot = paidEffect.coordinator.snapshot(paidEffect.scope);
        (result as { budgetSnapshot?: unknown }).budgetSnapshot = snapshot;
      } catch {
        (result as { budgetSnapshot?: unknown }).budgetSnapshot = null;
      }
      // The parent owns the shared coordinator and closes it after all arms finish.
    }
    return result;
  } catch (error) {
    return { arm: options.arm, stop: 'denied', imported: prepared.imported, polls: 0, state: null, denial: redacted(error) };
  } finally {
    if (initialized) closeDb();
    for (const key of Object.keys(bindings)) delete process.env[key];
  }
}

/** Single-arm convenience; paired execution must use the coordinator's dual-preflight barrier. */
export async function runComparisonArm(options: ArmBootstrapOptions, rows?: readonly PopulationRow[]): Promise<ArmResult> {
  if (!rows) return { arm: options.arm, stop: 'preflight_denied', imported: 0, polls: 0, state: null, denial: 'Population rows are required for comparison-arm execution.' };
  const preflight = await preflightComparisonArm(options, rows);
  if (!preflight.prepared) return { arm: options.arm, stop: 'preflight_denied', imported: preflight.imported, polls: 0, state: null, denial: preflight.denial };
  return releaseComparisonArm(options, preflight.prepared);
}

type RunPaidEffect = {
  coordinator: PaidEffectBudgetCoordinator;
  client: PaidEffectBudgetClient;
  scope: QualificationPaidEffectScope;
  serperSearchContract: VerifiedPaidEffectBillingContract;
};

export function buildRunPaidEffect(
  options: ArmBootstrapOptions,
  prepared: PreparedArm,
  budget: { runId: string; capUsd: number; authorizationUsdMicros: number; billingReferences: Array<{ provider: string; contractId: string }> },
  coordinator?: PaidEffectBudgetCoordinator,
): RunPaidEffect {
  if (!options.budgetDbPath) throw new PolicyDeniedError('Qualification release requires a shared budget ledger path.');
  const cap = Math.min(Math.round(budget.capUsd * 1_000_000), budget.authorizationUsdMicros);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 3_000_000) {
    throw new PolicyDeniedError('Qualification paid release requires a positive approved cap within the $3 CLI/freeze ceiling.');
  }
  // Freeze r8-smoke1 pins the legacy 'serper-subscription' id; the pilot contract it
  // authorizes is serperPilotContract ('serper-pilot-2499-credits'). Accept both ids
  // here; a future freeze cut records the pilot id explicitly.
  const serperContract = budget.billingReferences.find(ref => ref.provider === 'serper_search' &&
    (ref.contractId === 'serper-pilot-2499-credits' || ref.contractId === 'serper-subscription'));
  if (!serperContract) throw new PolicyDeniedError('Frozen qualification authorization does not include a Serper billing contract; paid release denied.');
  const ledgerDb = coordinator ? undefined : new Database(options.budgetDbPath);
  const authorization = pilotBudgetAuthorization({ runId: budget.runId, arms: ['baseline', 'candidate'] });
  const boundedAuthorization = { ...authorization, approvedCeilingMicros: Math.min(authorization.approvedCeilingMicros, cap) };
  const effectCoordinator = coordinator ?? new PaidEffectBudgetCoordinator(ledgerDb!, boundedAuthorization);
  const client = createPaidEffectBudgetClient(request => effectCoordinator.handleRequest(request), new AbortController().signal);
  const scope: QualificationPaidEffectScope = {
    qualificationRunId: budget.runId,
    authorizationId: authorization.authorizationId,
    arm: options.arm,
    outputId: prepared.batchId,
    beneficiaries: prepared.itemIds.map(id => ({ kind: 'item' as const, id })),
  };
  return { coordinator: effectCoordinator, client, scope, serperSearchContract: authorization.billingContracts[0]! };
}

async function runBoundedWorker(options: ArmBootstrapOptions, runtime: QualificationRuntimeValidation, prepared: PreparedArm, imported: number, paidEffect?: RunPaidEffect): Promise<ArmResult> {
  const deadline = Date.now() + runtime.run.limits.maxRuntimeMs;
  const worker = new OnboardingWorker(runtime.run.workspaceId, runtime.workspacePath);
  if (paidEffect) {
    // Per-item scope narrowing: each acquisition reserves against this item alone,
    // so the ledger attributes Serper/browser spend to the row that caused it.
    worker.setQualificationPaidEffect((itemId: string) => ({
      scope: { ...paidEffect.scope, beneficiaries: [{ kind: 'item' as const, id: itemId }] },
      client: paidEffect.client,
      serperSearchContract: paidEffect.serperSearchContract,
      browserSessionContract: paidEffect.serperSearchContract,
    }));
  }
  let polls = 0;
  let previous = '';
  try {
    while (Date.now() < deadline && polls < runtime.run.limits.maxItems) {
      await worker.poll();
      polls++;
      await worker.drain();
      const state = summarizeItems(listItemsByBatch(prepared.batchId));
      if (state.failed > 0) return { arm: options.arm, stop: 'failed', imported, polls, state };
      if (state.needsInput > 0) return { arm: options.arm, stop: 'needs_input', imported, polls, state };
      if (state.reviewReady === imported) return { arm: options.arm, stop: 'review_ready', imported, polls, state };
      const fingerprint = JSON.stringify(state);
      if (fingerprint === previous) return { arm: options.arm, stop: 'no-progress', imported, polls, state };
      previous = fingerprint;
    }
    return {
      arm: options.arm, stop: Date.now() >= deadline ? 'deadline' : 'no-progress', imported, polls,
      state: summarizeItems(listItemsByBatch(prepared.batchId)),
    };
  } catch (error) {
    return { arm: options.arm, stop: 'denied', imported, polls, state: null, denial: redacted(error) };
  }
}

function summarizeItems(items: OnboardingItem[]): { total: number; held: number; failed: number; needsInput: number; reviewReady: number; stageCounts: Record<string, number> } {
  const stageCounts: Record<string, number> = {};
  for (const item of items) stageCounts[`${item.stage}:${item.stageStatus}`] = (stageCounts[`${item.stage}:${item.stageStatus}`] ?? 0) + 1;
  return {
    total: items.length, held: items.filter(item => item.isHeld).length,
    failed: items.filter(item => item.stageStatus === 'failed').length,
    needsInput: items.filter(item => item.stageStatus === 'needs_input').length,
    reviewReady: items.filter(item => item.stage === 'review_listings' && item.stageStatus === 'pending').length,
    stageCounts,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const values: Record<string,string> = {};
  for (let i=0;i<args.length;i++) { if (!args[i].startsWith('--') || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Invalid arm bootstrap arguments'); values[args[i].slice(2)] = args[++i]; }
  const required = ['arm','freeze','private-root','workspace','destination','db','population'];
  if (required.some(key => !values[key]) || !['baseline','candidate'].includes(values.arm)) throw new Error('Usage: bun scratch/comparison-arm.ts --arm baseline|candidate --freeze path --private-root path --workspace path --destination path --db path --population selected-rows.json [--credential-fd N]');
  const rows = JSON.parse(await readFile(values.population!, 'utf8')) as PopulationRow[];
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.upc !== 'string' || typeof row.register_name !== 'string' || typeof row.price !== 'number')) throw new Error('Population file must contain selected rows with UPC, register_name, and numeric price.');
  const result = await runComparisonArm({ arm: values.arm as ArmBootstrapOptions['arm'], freezePath: values.freeze, privateRoot: values['private-root'], workspacePath: values.workspace, destinationRoot: values.destination, dbPath: values.db, credentialFd: values['credential-fd'] === undefined ? undefined : Number(values['credential-fd']) }, rows);
  console.log(JSON.stringify(result)); if (result.stop === 'preflight_denied' || result.stop === 'denied' || result.stop === 'failed') process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(`comparison-arm: ${redacted(error)}`); process.exitCode = 1; });
