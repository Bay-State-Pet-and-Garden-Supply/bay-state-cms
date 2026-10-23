import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { hashCanonicalJson } from '../shared/stable-id';
import {
  installQualificationRunBudgetSchema,
  createQualificationRunBudgetRepo,
  type PaidEffectBudgetSnapshot,
  type PaidEffectReservationRecord,
} from '../db/repositories/qualification-run-budget-repo';
import {
  PaidEffectAuthorizationSchema,
  PaidEffectAttemptDescriptorSchema,
  PaidEffectAuthoritativeSettlementSchema,
  PaidEffectSettlementSchema,
  QualificationPaidEffectScopeSchema,
  type PaidEffectAuthorization,
  type PaidEffectAttemptDescriptor,
  type PaidEffectSettlement,
  type PaidEffectAuthoritativeSettlement,
  type PaidEffectUnknownSettlement,
  type QualificationPaidEffectScope,
} from '../shared/schemas/paid-effect';

export type PaidEffectBudgetErrorCode =
  | 'scope_missing'
  | 'scope_mismatch'
  | 'invalid_request'
  | 'authorization_missing'
  | 'authorization_closed'
  | 'budget_exhausted'
  | 'idempotency_conflict'
  | 'reservation_state'
  | 'contract_unverified'
  | 'contract_drift'
  | 'settlement_not_authoritative'
  | 'authoritative_settlement_parent_only'
  | 'cancelled'
  | 'coordinator_disconnected'
  | 'journal_unavailable';

export class PaidEffectBudgetError extends Error {
  constructor(readonly code: PaidEffectBudgetErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PaidEffectBudgetError';
  }
}

export interface PaidEffectReservation {
  readonly idempotencyKey: string;
  readonly descriptorHash: string;
  readonly maximumChargeMicros: number;
  markDispatched(signal?: AbortSignal): Promise<void>;
  settle(evidence: PaidEffectUnknownSettlement): Promise<void>;
  releaseUndispatched(reason: string): Promise<void>;
}

export interface PaidEffectBudgetClient {
  readonly closedSignal: AbortSignal;
  reserve(scope: QualificationPaidEffectScope, descriptor: PaidEffectAttemptDescriptor, signal?: AbortSignal): Promise<PaidEffectReservation>;
  snapshot(scope: QualificationPaidEffectScope, signal?: AbortSignal): Promise<PaidEffectBudgetSnapshot>;
}

export type PaidEffectBudgetRequest =
  | { version: 1; requestId: string; operation: 'reserve'; scope: QualificationPaidEffectScope; descriptor: PaidEffectAttemptDescriptor }
  | { version: 1; requestId: string; operation: 'mark_dispatched'; scope: QualificationPaidEffectScope; idempotencyKey: string; descriptorHash: string }
  | { version: 1; requestId: string; operation: 'settle'; scope: QualificationPaidEffectScope; idempotencyKey: string; descriptorHash: string; evidence: PaidEffectUnknownSettlement }
  | { version: 1; requestId: string; operation: 'release_undispatched'; scope: QualificationPaidEffectScope; idempotencyKey: string; descriptorHash: string; reason: string }
  | { version: 1; requestId: string; operation: 'snapshot'; scope: QualificationPaidEffectScope };

export type PaidEffectBudgetReply =
  | { version: 1; requestId: string; ok: true; result: unknown }
  | { version: 1; requestId: string; ok: false; code: PaidEffectBudgetErrorCode; message: string };

const RequestIdSchema = z.string().min(1).max(128);
const DescriptorHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PaidEffectBudgetRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), requestId: RequestIdSchema, operation: z.literal('reserve'), scope: QualificationPaidEffectScopeSchema, descriptor: PaidEffectAttemptDescriptorSchema }).strict(),
  z.object({ version: z.literal(1), requestId: RequestIdSchema, operation: z.literal('mark_dispatched'), scope: QualificationPaidEffectScopeSchema, idempotencyKey: PaidEffectAttemptDescriptorSchema.shape.idempotencyKey, descriptorHash: DescriptorHashSchema }).strict(),
  z.object({ version: z.literal(1), requestId: RequestIdSchema, operation: z.literal('settle'), scope: QualificationPaidEffectScopeSchema, idempotencyKey: PaidEffectAttemptDescriptorSchema.shape.idempotencyKey, descriptorHash: DescriptorHashSchema, evidence: PaidEffectSettlementSchema }).strict(),
  z.object({ version: z.literal(1), requestId: RequestIdSchema, operation: z.literal('release_undispatched'), scope: QualificationPaidEffectScopeSchema, idempotencyKey: PaidEffectAttemptDescriptorSchema.shape.idempotencyKey, descriptorHash: DescriptorHashSchema, reason: z.string().trim().min(1).max(256) }).strict(),
  z.object({ version: z.literal(1), requestId: RequestIdSchema, operation: z.literal('snapshot'), scope: QualificationPaidEffectScopeSchema }).strict(),
]);
export type PaidEffectBudgetOperation =
  | Omit<Extract<PaidEffectBudgetRequest, { operation: 'reserve' }>, 'version' | 'requestId'>
  | Omit<Extract<PaidEffectBudgetRequest, { operation: 'mark_dispatched' }>, 'version' | 'requestId'>
  | Omit<Extract<PaidEffectBudgetRequest, { operation: 'settle' }>, 'version' | 'requestId'>
  | Omit<Extract<PaidEffectBudgetRequest, { operation: 'release_undispatched' }>, 'version' | 'requestId'>
  | Omit<Extract<PaidEffectBudgetRequest, { operation: 'snapshot' }>, 'version' | 'requestId'>;

interface BudgetRepository {
  freezeAuthorization(authorization: PaidEffectAuthorization): { authorizationHash: string; state: string };
  reserve(input: { scope: QualificationPaidEffectScope; descriptor: PaidEffectAttemptDescriptor }): PaidEffectReservationRecord;
  getReservation(authorizationId: string, idempotencyKey: string): PaidEffectReservationRecord | null;
  markDispatched(authorizationId: string, idempotencyKey: string, descriptorHash: string): void;
  settle(authorizationId: string, idempotencyKey: string, descriptorHash: string, evidence: PaidEffectSettlement): void;
  releaseUndispatched(authorizationId: string, idempotencyKey: string, descriptorHash: string, reason: string): void;
  snapshot(authorizationId: string): PaidEffectBudgetSnapshot;
  close(authorizationId: string, reason: string): void;
}

const VALIDATION_ERROR = 'paid_effect_invalid_request';
const SCOPE_ERRORS = new Set(['paid_effect_qualification_scope_mismatch', 'paid_effect_arm_not_authorized']);
const CONTRACT_ERRORS = new Set(['paid_effect_billing_contract_unverified', 'paid_effect_request_exceeds_contract', 'paid_effect_request_missing_dimension']);
const RESERVATION_ERRORS = new Set(['paid_effect_reservation_not_dispatchable', 'paid_effect_reservation_not_settleable', 'paid_effect_reservation_already_settled', 'paid_effect_dispatched_reservation_not_releasable', 'paid_effect_reservation_missing', 'paid_effect_settlement_conflict']);

function errorCode(error: unknown): { code: PaidEffectBudgetErrorCode; fatal: boolean; message: string } {
  if (error instanceof PaidEffectBudgetError) return { code: error.code, fatal: false, message: error.message };
  if (error instanceof z.ZodError) return { code: 'invalid_request', fatal: false, message: VALIDATION_ERROR };
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'paid_effect_budget_exhausted') return { code: 'budget_exhausted', fatal: false, message };
  if (message === 'paid_effect_idempotency_conflict' || message === 'paid_effect_authorization_conflict') return { code: 'idempotency_conflict', fatal: false, message };
  if (message === 'paid_effect_authorization_missing') return { code: 'authorization_missing', fatal: false, message };
  if (message === 'paid_effect_ledger_closed' || message === 'paid_effect_ledger_drifted') return { code: 'authorization_closed', fatal: false, message };
  if (message === 'paid_effect_billing_contract_drift' || message.startsWith('paid_effect_authoritative_charge')) return { code: 'contract_drift', fatal: false, message };
  if (message === 'paid_effect_settlement_not_authoritative') return { code: 'settlement_not_authoritative', fatal: false, message };
  if (SCOPE_ERRORS.has(message)) return { code: 'scope_mismatch', fatal: false, message };
  if (CONTRACT_ERRORS.has(message) || message.startsWith('paid_effect_usage_outside_contract:') || message.startsWith('paid_effect_unknown_billing_dimension:')) return { code: 'contract_unverified', fatal: false, message };
  if (RESERVATION_ERRORS.has(message)) return { code: 'reservation_state', fatal: false, message };
  if (message.startsWith('paid_effect_journal_') || message.startsWith('paid_effect_journal_corrupt:') || message.startsWith('paid_effect_cost_overflow')) return { code: 'journal_unavailable', fatal: true, message };
  return { code: 'journal_unavailable', fatal: true, message: 'paid_effect_journal_unavailable' };
}

function assertScopeForAuthorization(scope: QualificationPaidEffectScope, authorization: PaidEffectAuthorization): void {
  if (scope.authorizationId !== authorization.authorizationId || scope.qualificationRunId !== authorization.qualificationRunId || !authorization.arms.includes(scope.arm)) {
    throw new PaidEffectBudgetError('scope_mismatch');
  }
}

function assertReservationBinding(
  repository: BudgetRepository,
  scope: QualificationPaidEffectScope,
  idempotencyKey: string,
  descriptorHash: string,
): void {
  const record = repository.getReservation(scope.authorizationId, idempotencyKey);
  if (!record || record.descriptorHash !== descriptorHash || record.qualificationRunId !== scope.qualificationRunId || record.arm !== scope.arm ||
    record.outputId !== scope.outputId || hashCanonicalJson(record.beneficiaries) !== hashCanonicalJson(scope.beneficiaries)) {
    throw new PaidEffectBudgetError('scope_mismatch', 'paid_effect_reservation_binding_mismatch');
  }
}

/** Parent-owned coordinator. Its repository is always supplied an explicit dedicated ledger handle. */
export class PaidEffectBudgetCoordinator {
  private healthy = true;
  private stopped = false;
  private readonly authorization: PaidEffectAuthorization;
  private readonly authorizationHash: string;
  private readonly repository: BudgetRepository;

  constructor(db: Database, authorizationInput: PaidEffectAuthorization) {
    installQualificationRunBudgetSchema(db);
    this.repository = createQualificationRunBudgetRepo(db);
    this.authorization = PaidEffectAuthorizationSchema.parse(authorizationInput);
    try {
      const frozen = this.repository.freezeAuthorization(this.authorization);
      this.authorizationHash = frozen.authorizationHash;
      this.stopped = frozen.state !== 'active';
    } catch (error) {
      const classified = errorCode(error);
      if (classified.fatal) this.healthy = false;
      throw new PaidEffectBudgetError(classified.code, classified.message);
    }
  }

  async handleRequest(requestInput: unknown): Promise<PaidEffectBudgetReply> {
    let requestId = 'invalid';
    try {
      if (requestInput && typeof requestInput === 'object' && 'requestId' in requestInput && typeof requestInput.requestId === 'string') {
        requestId = requestInput.requestId;
      }
      const request = PaidEffectBudgetRequestSchema.parse(requestInput);
      requestId = request.requestId;
      if (!this.healthy) throw new PaidEffectBudgetError('journal_unavailable');
      if (this.stopped && (request.operation === 'reserve' || request.operation === 'mark_dispatched')) throw new PaidEffectBudgetError('authorization_closed');
      assertScopeForAuthorization(request.scope, this.authorization);
      let result: unknown;
      switch (request.operation) {
        case 'reserve': {
          result = this.repository.reserve({ scope: request.scope, descriptor: request.descriptor });
          break;
        }
        case 'mark_dispatched': {
          assertReservationBinding(this.repository, request.scope, request.idempotencyKey, request.descriptorHash);
          this.repository.markDispatched(request.scope.authorizationId, request.idempotencyKey, request.descriptorHash);
          result = null;
          break;
        }
        case 'settle': {
          if (request.evidence.kind === 'authoritative') {
            throw new PaidEffectBudgetError('authoritative_settlement_parent_only');
          }
          assertReservationBinding(this.repository, request.scope, request.idempotencyKey, request.descriptorHash);
          this.repository.settle(request.scope.authorizationId, request.idempotencyKey, request.descriptorHash, request.evidence);
          result = null;
          break;
        }
        case 'release_undispatched': {
          assertReservationBinding(this.repository, request.scope, request.idempotencyKey, request.descriptorHash);
          this.repository.releaseUndispatched(request.scope.authorizationId, request.idempotencyKey, request.descriptorHash, request.reason);
          result = null;
          break;
        }
        case 'snapshot': {
          result = this.repository.snapshot(request.scope.authorizationId);
          break;
        }
      }
      return { version: 1, requestId, ok: true, result };
    } catch (error) {
      const classified = errorCode(error);
      if (classified.fatal) this.healthy = false;
      if (classified.code === 'contract_drift') this.stopped = true;
      return { version: 1, requestId, ok: false, code: classified.code, message: classified.message };
    }
  }

  /** Reconciles a lower charge after the trusted parent authenticates external usage evidence. */
  async settle(
    scopeInput: QualificationPaidEffectScope,
    idempotencyKey: string,
    descriptorHash: string,
    evidenceInput: PaidEffectAuthoritativeSettlement,
  ): Promise<void> {
    const scope = QualificationPaidEffectScopeSchema.parse(scopeInput);
    const evidence = PaidEffectAuthoritativeSettlementSchema.parse(evidenceInput);
    assertScopeForAuthorization(scope, this.authorization);
    if (!this.healthy) throw new PaidEffectBudgetError('journal_unavailable');
    assertReservationBinding(this.repository, scope, idempotencyKey, descriptorHash);
    try {
      this.repository.settle(scope.authorizationId, idempotencyKey, descriptorHash, evidence);
    } catch (error) {
      const classified = errorCode(error);
      if (classified.fatal) this.healthy = false;
      if (classified.code === 'contract_drift') this.stopped = true;
      throw new PaidEffectBudgetError(classified.code, classified.message);
    }
  }

  snapshot(scopeInput: QualificationPaidEffectScope): PaidEffectBudgetSnapshot {
    const scope = QualificationPaidEffectScopeSchema.parse(scopeInput);
    assertScopeForAuthorization(scope, this.authorization);
    if (!this.healthy) throw new PaidEffectBudgetError('journal_unavailable');
    try {
      return this.repository.snapshot(scope.authorizationId);
    } catch (error) {
      const classified = errorCode(error);
      if (classified.fatal) this.healthy = false;
      throw new PaidEffectBudgetError(classified.code, classified.message);
    }
  }

  close(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.repository.close(this.authorization.authorizationId, reason);
  }

  isClosed(): boolean {
    return this.stopped || !this.healthy;
  }

  get frozenAuthorizationHash(): string {
    return this.authorizationHash;
  }
}

export type PaidEffectBudgetExchange = (request: PaidEffectBudgetRequest, signal?: AbortSignal) => Promise<PaidEffectBudgetReply>;

class QualificationBudgetClient implements PaidEffectBudgetClient {
  readonly closedSignal: AbortSignal;

  constructor(private readonly exchange: PaidEffectBudgetExchange, closedSignal: AbortSignal) {
    this.closedSignal = closedSignal;
  }

  async reserve(scopeInput: QualificationPaidEffectScope, descriptorInput: PaidEffectAttemptDescriptor, signal?: AbortSignal): Promise<PaidEffectReservation> {
    const { client: _client, signal: _signal, ...scopeValue } = scopeInput as QualificationPaidEffectScope & { client?: unknown; signal?: unknown };
    const scope = QualificationPaidEffectScopeSchema.parse(scopeValue);
    const descriptor = PaidEffectAttemptDescriptorSchema.parse(descriptorInput);
    const reply = await this.request({ operation: 'reserve', scope, descriptor }, signal);
    const record = reply.result as PaidEffectReservationRecord;
    if (!record || record.idempotencyKey !== descriptor.idempotencyKey || !/^[a-f0-9]{64}$/.test(record.descriptorHash) ||
      !Number.isSafeInteger(record.maximumChargeMicros) || record.maximumChargeMicros < 0) {
      throw new PaidEffectBudgetError('journal_unavailable', 'paid_effect_invalid_parent_reservation_receipt');
    }
    return {
      idempotencyKey: record.idempotencyKey,
      descriptorHash: record.descriptorHash,
      maximumChargeMicros: record.maximumChargeMicros,
      markDispatched: async (requestSignal) => { await this.request({ operation: 'mark_dispatched', scope, idempotencyKey: record.idempotencyKey, descriptorHash: record.descriptorHash }, requestSignal); },
      settle: async (evidence) => {
        const settlement = PaidEffectSettlementSchema.parse(evidence);
        if (settlement.kind === 'authoritative') throw new PaidEffectBudgetError('authoritative_settlement_parent_only');
        await this.request({ operation: 'settle', scope, idempotencyKey: record.idempotencyKey, descriptorHash: record.descriptorHash, evidence: settlement });
      },
      releaseUndispatched: async (reason) => { await this.request({ operation: 'release_undispatched', scope, idempotencyKey: record.idempotencyKey, descriptorHash: record.descriptorHash, reason }); },
    };
  }

  async snapshot(scopeInput: QualificationPaidEffectScope, signal?: AbortSignal): Promise<PaidEffectBudgetSnapshot> {
    const { client: _client, signal: _signal, ...scopeValue } = scopeInput as QualificationPaidEffectScope & { client?: unknown; signal?: unknown };
    const scope = QualificationPaidEffectScopeSchema.parse(scopeValue);
    const result = (await this.request({ operation: 'snapshot', scope }, signal)).result;
    return result as PaidEffectBudgetSnapshot;
  }

  private async request(
    operation: PaidEffectBudgetOperation,
    signal?: AbortSignal,
  ): Promise<Extract<PaidEffectBudgetReply, { ok: true }>> {
    if (this.closedSignal.aborted) throw new PaidEffectBudgetError('coordinator_disconnected');
    if (signal?.aborted) throw new PaidEffectBudgetError('cancelled');
    const request = { ...operation, version: 1 as const, requestId: randomUUID() } as PaidEffectBudgetRequest;
    let reply: PaidEffectBudgetReply;
    try { reply = await this.exchange(request, signal); }
    catch (error) {
      if (error instanceof PaidEffectBudgetError) throw error;
      throw new PaidEffectBudgetError(this.closedSignal.aborted ? 'coordinator_disconnected' : 'journal_unavailable');
    }
    if (!reply || reply.requestId !== request.requestId || reply.version !== 1) throw new PaidEffectBudgetError('journal_unavailable', 'paid_effect_invalid_parent_reply');
    if (reply.ok === false) throw new PaidEffectBudgetError(reply.code, reply.message);
    if (reply.ok !== true) throw new PaidEffectBudgetError('journal_unavailable', 'paid_effect_invalid_parent_reply');
    return reply;
  }
}

/** Creates a request/reply client; the transport must reject pending requests and abort closedSignal on peer loss. */
export function createPaidEffectBudgetClient(exchange: PaidEffectBudgetExchange, closedSignal: AbortSignal): PaidEffectBudgetClient {
  return new QualificationBudgetClient(exchange, closedSignal);
}

export function createPaidEffectIdempotencyKey(): string {
  return randomUUID();
}

interface ScopeRuntime extends QualificationPaidEffectScope {
  client: PaidEffectBudgetClient;
  signal: AbortSignal;
}
interface ScopeFrame {
  required: boolean;
  scope: ScopeRuntime | null;
}
const paidEffectScope = new AsyncLocalStorage<ScopeFrame>();

export interface ComposedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

export function composePaidEffectAbortSignals(signals: readonly (AbortSignal | undefined)[]): ComposedAbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      dispose();
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
      dispose();
    };
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return { signal: controller.signal, dispose };
}

/** Mark all calls in a qualification child as requiring an explicit nested paid-effect scope. */
export function withRequiredQualificationPaidEffectScope<T>(body: () => T): T {
  return paidEffectScope.run({ required: true, scope: null }, body);
}

/** Installs the frozen run/arm/output/beneficiary binding and composes cancellation and parent-loss signals. */
export async function withQualificationPaidEffectScope<T>(input: {
  scope: QualificationPaidEffectScope;
  client: PaidEffectBudgetClient;
  signal?: AbortSignal;
  body: () => Promise<T> | T;
}): Promise<T> {
  const scope = QualificationPaidEffectScopeSchema.parse(input.scope);
  const composed = composePaidEffectAbortSignals([input.signal, input.client.closedSignal]);
  try {
    return await paidEffectScope.run({ required: true, scope: { ...scope, client: input.client, signal: composed.signal } }, input.body);
  } finally {
    composed.dispose();
  }
}

export interface PaidEffectExecution<T> {
  value: T;
  settlement?: PaidEffectUnknownSettlement;
}

/** Reserves and marks one physical attempt before invoking it; absent qualification scope preserves ordinary production behavior. */
export async function runPaidEffect<T>(input: {
  descriptor: PaidEffectAttemptDescriptor;
  signal?: AbortSignal;
  execute(signal: AbortSignal): Promise<PaidEffectExecution<T>>;
}): Promise<T> {
  const frame = paidEffectScope.getStore();
  if (!frame) {
    const passThrough = composePaidEffectAbortSignals([input.signal]);
    try { return (await input.execute(passThrough.signal)).value; } finally { passThrough.dispose(); }
  }
  if (!frame.scope) {
    if (frame.required) throw new PaidEffectBudgetError('scope_missing');
    const passThrough = composePaidEffectAbortSignals([input.signal]);
    try { return (await input.execute(passThrough.signal)).value; } finally { passThrough.dispose(); }
  }
  const runtime = frame.scope;
  const composed = composePaidEffectAbortSignals([runtime.signal, input.signal]);
  let reservation: PaidEffectReservation | undefined;
  let dispatchRequested = false;
  try {
    if (composed.signal.aborted) throw new PaidEffectBudgetError('cancelled');
    reservation = await runtime.client.reserve(runtime, input.descriptor, composed.signal);
    if (composed.signal.aborted) {
      await reservation.releaseUndispatched('cancelled_before_dispatch');
      throw new PaidEffectBudgetError('cancelled');
    }
    await reservation.markDispatched(composed.signal);
    dispatchRequested = true;
    if (composed.signal.aborted) throw new PaidEffectBudgetError('cancelled');
    const result = await input.execute(composed.signal);
    await reservation.settle(result.settlement ?? { kind: 'unknown' });
    return result.value;
  } catch (error) {
    if (reservation && !dispatchRequested && composed.signal.aborted) {
      await reservation.releaseUndispatched('cancelled_before_dispatch');
    } else if (reservation && dispatchRequested && !(error instanceof PaidEffectBudgetError)) {
      await reservation.settle({ kind: 'unknown' });
    }
    throw error;
  } finally {
    composed.dispose();
  }
}

export function currentQualificationPaidEffectScope(): QualificationPaidEffectScope | null {
  const scope = paidEffectScope.getStore()?.scope;
  if (!scope) return null;
  return {
    qualificationRunId: scope.qualificationRunId,
    authorizationId: scope.authorizationId,
    arm: scope.arm,
    outputId: scope.outputId,
    beneficiaries: scope.beneficiaries,
  };
}
