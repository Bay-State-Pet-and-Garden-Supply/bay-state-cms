import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import {
  createPaidEffectBudgetClient,
  PaidEffectBudgetCoordinator,
  PaidEffectBudgetError,
  runPaidEffect,
  withQualificationPaidEffectScope,
  withRequiredQualificationPaidEffectScope,
  type PaidEffectBudgetClient,
  type PaidEffectBudgetExchange,
  type PaidEffectBudgetReply,
} from '../src/ai/paid-effect-budget';
import {
  paidEffectBillingTermsHash,
  PaidEffectAuthorizationSchema,
  VerifiedPaidEffectBillingContractSchema,
  type PaidEffectAuthorization,
  type PaidEffectAttemptDescriptor,
  type QualificationPaidEffectScope,
  type VerifiedPaidEffectBillingContract,
} from '../src/shared/schemas/paid-effect';
import { hashCanonicalJson } from '../src/shared/stable-id';

const ReplySchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), requestId: z.string(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ version: z.literal(1), requestId: z.string(), ok: z.literal(false), code: z.string(), message: z.string() }).strict(),
]);

function makeDisconnectedError(): PaidEffectBudgetError {
  return new PaidEffectBudgetError('coordinator_disconnected');
}

interface PendingReply {
  resolve(reply: PaidEffectBudgetReply): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ComparisonBudgetIpcClient {
  client: PaidEffectBudgetClient;
  close(): void;
}

/** Qualification-child side of the dedicated newline-framed stdio IPC channel. */
export function createComparisonBudgetIpcClient(input: {
  replies: Readable;
  requests: Writable;
}): ComparisonBudgetIpcClient {
  const disconnected = new AbortController();
  const pending = new Map<string, PendingReply>();
  const abandoned = new Set<string>();
  const lines = createInterface({ input: input.replies, crlfDelay: Infinity });
  let closed = false;

  const disconnect = () => {
    if (closed) return;
    closed = true;
    disconnected.abort(makeDisconnectedError());
    lines.close();
    input.requests.end();
    input.replies.destroy();
    for (const [requestId, entry] of pending) {
      if (entry.signal && entry.abortListener) entry.signal.removeEventListener('abort', entry.abortListener);
      entry.reject(makeDisconnectedError());
      pending.delete(requestId);
    }
    abandoned.clear();
  };

  lines.on('line', (line) => {
    let reply: unknown;
    try { reply = JSON.parse(line); } catch { disconnect(); return; }
    const parsed = ReplySchema.safeParse(reply);
    if (!parsed.success) { disconnect(); return; }
    const entry = pending.get(parsed.data.requestId);
    if (!entry) {
      if (abandoned.delete(parsed.data.requestId)) return;
      disconnect();
      return;
    }
    pending.delete(parsed.data.requestId);
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener('abort', entry.abortListener);
    entry.resolve(parsed.data as PaidEffectBudgetReply);
  });
  lines.on('close', disconnect);
  input.replies.on('error', disconnect);
  input.replies.on('close', disconnect);
  input.requests.on('error', disconnect);
  input.requests.on('close', disconnect);

  const exchange: PaidEffectBudgetExchange = (request, signal) => {
    const pendingReply = Promise.withResolvers<PaidEffectBudgetReply>();
    if (closed || disconnected.signal.aborted) {
      pendingReply.reject(makeDisconnectedError());
      return pendingReply.promise;
    }
    if (signal?.aborted) {
      pendingReply.reject(new PaidEffectBudgetError('cancelled'));
      return pendingReply.promise;
    }
    const entry: PendingReply = { resolve: pendingReply.resolve, reject: pendingReply.reject, signal };
    if (signal) {
      entry.abortListener = () => {
        pending.delete(request.requestId);
        abandoned.add(request.requestId);
        pendingReply.reject(new PaidEffectBudgetError('cancelled'));
      };
      signal.addEventListener('abort', entry.abortListener, { once: true });
    }
    pending.set(request.requestId, entry);
    input.requests.write(`${JSON.stringify(request)}\n`, (error) => {
      if (!error || !pending.has(request.requestId)) return;
      pending.delete(request.requestId);
      if (signal && entry.abortListener) signal.removeEventListener('abort', entry.abortListener);
      pendingReply.reject(makeDisconnectedError());
      disconnect();
    });
    return pendingReply.promise;
  };
  return { client: createPaidEffectBudgetClient(exchange, disconnected.signal), close: disconnect };
}

interface AttachedChild {
  close(): void;
}

/** Parent coordinator for all qualification child processes sharing one SQLite ledger handle. */
export class ComparisonBudgetIpcCoordinator {
  private readonly coordinator: PaidEffectBudgetCoordinator;
  private readonly children = new Set<AttachedChild>();
  private closed = false;

  constructor(db: Database, authorization: PaidEffectAuthorization) {
    this.coordinator = new PaidEffectBudgetCoordinator(db, authorization);
  }

  attach(child: ChildProcess): void {
    if (this.closed || this.coordinator.isClosed()) {
      this.closed = true;
      child.kill('SIGTERM');
      return;
    }
    if (!child.stdin || !child.stdout) throw new Error('paid_effect_child_requires_piped_stdin_stdout');
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let detached = false;
    const attached: AttachedChild = {
      close: () => {
        if (detached) return;
        detached = true;
        this.children.delete(attached);
        lines.close();
        child.stdin?.end();
        child.kill('SIGTERM');
      },
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      this.children.delete(attached);
      lines.close();
    };
    this.children.add(attached);
    lines.on('line', (line) => {
      let request: unknown;
      try { request = JSON.parse(line); } catch { attached.close(); return; }
      void this.coordinator.handleRequest(request).then((reply) => {
        if (detached || !child.stdin || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(reply)}\n`, (error) => {
          if (error) attached.close();
        });
      }).catch(() => attached.close());
    });
    lines.on('close', detach);
    child.once('exit', detach);
    child.once('error', detach);
  }

  snapshot(scope: QualificationPaidEffectScope) {
    return this.coordinator.snapshot(scope);
  }
  close(reason: string): void {
    this.closed = true;
    try {
      this.coordinator.close(reason);
    } finally {
      for (const child of this.children) child.close();
      this.children.clear();
    }
  }

  isClosed(): boolean {
    return this.closed || this.coordinator.isClosed();
  }
}

/** Frozen Serper pilot contract: one request unit per POST, cumulatively capped at the operator-reported 2,499-credit pool.
 * Zero-dollar (credits are not USD); the dollar ceiling stays TypeSafe-only. Evidence: operator statement
 * 2026-10-23, docs/audits/onboarding-outcome-v1/provider-billing-evidence.md. Provider-side retry/error
 * billing beyond the single POST is uncontracted and stays an unknown liability. */
export function serperPilotContract(): VerifiedPaidEffectBillingContract {
  const terms = {
    schemaVersion: 1 as const,
    contractId: 'serper-pilot-2499-credits',
    provider: 'serper_search',
    model: 'web',
    dimensions: [{ name: 'requests', unit: 'request', maxUnits: 1, cumulativeMaxUnits: 2_499, priceMicros: 0, priceUnits: 1 }],
    attemptOverheadMicros: 0,
    maxChargeMicros: 0,
    authoritativeUsageSource: 'none' as const,
    verifiedEvidenceHash: 'f'.repeat(64),
    verifiedEvidenceRef: 'operator-reported-2499-credits-2026-10-23',
    verifiedBy: 'operator-statement',
    verifiedAt: '2026-10-23T00:00:00.000Z',
  };
  return VerifiedPaidEffectBillingContractSchema.parse({
    ...terms,
    verifiedTermsHash: paidEffectBillingTermsHash(terms),
  });
}

/** Frozen pilot authorization: $3.00 schema-max USD ceiling (operator reports $3.30; the extra
 * $0.30 is recorded as unusable headroom, never authorized) + Serper contract, both arms. */
export function pilotBudgetAuthorization(input: { runId: string; arms: Array<'baseline' | 'candidate'> }): PaidEffectAuthorization {
  return PaidEffectAuthorizationSchema.parse({
    schemaVersion: 1,
    authorizationId: `pilot-budget-${input.runId}`,
    qualificationRunId: input.runId,
    approvedCeilingMicros: 3_000_000,
    arms: input.arms,
    billingContracts: [serperPilotContract()],
  });
}

function smokeAuthorization(): PaidEffectAuthorization {
  const contractTerms = {
    schemaVersion: 1 as const,
    contractId: 'local-coordinator-smoke',
    provider: 'local-smoke',
    model: 'priced-effect',
    dimensions: [{ name: 'requests', unit: 'request', maxUnits: 1, priceMicros: 70, priceUnits: 1 }],
    attemptOverheadMicros: 0,
    maxChargeMicros: 70,
    authoritativeUsageSource: 'provider_usage' as const,
    verifiedEvidenceHash: 'a'.repeat(64),
    verifiedEvidenceRef: 'controlled-local-smoke-contract',
    verifiedBy: 'local-smoke-fixture',
    verifiedAt: '2026-10-22T00:00:00.000Z',
  };
  const contract = VerifiedPaidEffectBillingContractSchema.parse({
    ...contractTerms,
    verifiedTermsHash: paidEffectBillingTermsHash(contractTerms),
  });
  return PaidEffectAuthorizationSchema.parse({
    schemaVersion: 1,
    authorizationId: 'comparison-budget-smoke-authorization',
    qualificationRunId: 'comparison-budget-smoke-run',
    approvedCeilingMicros: 100,
    arms: ['baseline', 'candidate'],
    billingContracts: [contract],
  });
}

function smokeScope(arm: 'baseline' | 'candidate'): QualificationPaidEffectScope {
  return {
    qualificationRunId: 'comparison-budget-smoke-run',
    authorizationId: 'comparison-budget-smoke-authorization',
    arm,
    outputId: `smoke-output-${arm}`,
    beneficiaries: [{ kind: 'item', id: 'controlled-smoke-row' }],
  };
}

function smokeDescriptor(key: string): PaidEffectAttemptDescriptor {
  const contract = smokeAuthorization().billingContracts[0]!;
  return {
    idempotencyKey: key,
    logicalEffectId: 'smoke-logical-call',
    provider: contract.provider,
    model: contract.model,
    effect: 'controlled-priced-attempt',
    billingContractId: contract.contractId,
    billingContractHash: hashCanonicalJson(contract),
    requestedUnits: { requests: 1 },
  };
}

async function smokeChildMain(): Promise<void> {
  const scope = JSON.parse(process.env.PAID_EFFECT_SMOKE_SCOPE ?? 'null') as QualificationPaidEffectScope;
  const descriptor = JSON.parse(process.env.PAID_EFFECT_SMOKE_DESCRIPTOR ?? 'null') as PaidEffectAttemptDescriptor;
  const ipc = createComparisonBudgetIpcClient({ replies: process.stdin, requests: process.stdout });
  try {
    await withRequiredQualificationPaidEffectScope(() => withQualificationPaidEffectScope({
      scope,
      client: ipc.client,
      body: async () => {
        await runPaidEffect({
          descriptor,
          execute: async (signal) => {
            if (signal.aborted) throw new PaidEffectBudgetError('cancelled');
            return { value: 'dispatched', settlement: { kind: 'unknown', rawUsage: { requests: 1 } } };
          },
        });
      },
    }));
    process.stderr.write('paid-effect-smoke:dispatched\n');
    process.exitCode = 0;
  } catch (error) {
    const code = error instanceof PaidEffectBudgetError ? error.code : 'unknown';
    process.stderr.write(`paid-effect-smoke:denied:${code}\n`);
    process.exitCode = code === 'budget_exhausted' ? 7 : 1;
  } finally {
    ipc.close();
  }
}

function waitForChild(child: ChildProcess, timeoutMs: number): Promise<{ exitCode: number | null; stderr: string }> {
  const completion = Promise.withResolvers<{ exitCode: number | null; stderr: string }>();
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    completion.reject(new Error('paid_effect_smoke_child_timeout'));
  }, timeoutMs);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', (error) => { clearTimeout(timer); completion.reject(error); });
  child.once('exit', (code) => { clearTimeout(timer); completion.resolve({ exitCode: code, stderr }); });
  return completion.promise;
}

/** Reusable two-child smoke entry for the parent comparison runner; entirely local and priced. */
export async function runComparisonBudgetCoordinatorSmoke(): Promise<{
  allowedChildren: number;
  deniedChildren: number;
  knownSubtotalMicros: number;
  unknownLiabilitiesMicros: number;
  totalEncumberedMicros: number;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), 'qualification-budget-smoke-'));
  const db = new Database(path.join(directory, 'budget.sqlite'));
  const ipc = new ComparisonBudgetIpcCoordinator(db, smokeAuthorization());
  const entryPath = fileURLToPath(import.meta.url);
  try {
    const children = (['baseline', 'candidate'] as const).map((arm) => {
      const child = spawn(process.execPath, [entryPath, '--budget-smoke-child'], {
        env: {
          ...process.env,
          PAID_EFFECT_SMOKE_SCOPE: JSON.stringify(smokeScope(arm)),
          PAID_EFFECT_SMOKE_DESCRIPTOR: JSON.stringify(smokeDescriptor(`smoke-attempt-${arm}`)),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      ipc.attach(child);
      return { arm, child, result: waitForChild(child, 15_000) };
    });
    const completed = await Promise.all(children.map(async ({ arm, result }) => ({ arm, ...(await result) })));
    const allowedChildren = completed.filter((child) => child.exitCode === 0).length;
    const deniedChildren = completed.filter((child) => child.exitCode === 7).length;
    const snapshot = ipc.snapshot(smokeScope('baseline'));
    if (completed.some((child) => child.exitCode !== 0 && child.exitCode !== 7)) {
      throw new Error(`paid_effect_multi_child_child_failure:${JSON.stringify(completed)}`);
    }
    if (allowedChildren !== 1 || deniedChildren !== 1 || snapshot.knownSubtotalMicros !== 0 || snapshot.unknownLiabilitiesMicros !== 70) {
      throw new Error(`paid_effect_multi_child_smoke_failed:${JSON.stringify({ completed, snapshot })}`);
    }
    return {
      allowedChildren,
      deniedChildren,
      knownSubtotalMicros: snapshot.knownSubtotalMicros,
      unknownLiabilitiesMicros: snapshot.unknownLiabilitiesMicros,
      totalEncumberedMicros: snapshot.totalEncumberedMicros,
    };
  } finally {
    ipc.close('comparison budget smoke complete');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === '--budget-smoke-child') {
    await smokeChildMain();
  } else {
    try { process.stdout.write(`${JSON.stringify(await runComparisonBudgetCoordinatorSmoke())}\n`); }
    catch (error) {
      process.stderr.write(`comparison-budget: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
