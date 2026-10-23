import { afterEach, describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import {
  createPaidEffectBudgetClient,
  PaidEffectBudgetCoordinator,
  PaidEffectBudgetError,
  createPaidEffectIdempotencyKey,
  runPaidEffect,
  withQualificationPaidEffectScope,
  withRequiredQualificationPaidEffectScope,
  type PaidEffectBudgetClient,
} from '../../ai/paid-effect-budget';
import {
  calculatePaidEffectChargeMicros,
  paidEffectBillingTermsHash,
  PaidEffectAuthorizationSchema,
  VerifiedPaidEffectBillingContractSchema,
  type PaidEffectAttemptDescriptor,
  type PaidEffectAuthorization,
  type QualificationPaidEffectScope,
} from '../../shared/schemas/paid-effect';
import { hashCanonicalJson } from '../../shared/stable-id';
import { createComparisonBudgetIpcClient, runComparisonBudgetCoordinatorSmoke } from '../../../scratch/comparison-budget';

const openedDatabases: Database[] = [];
const temporaryDirectories: string[] = [];
interface ContractFixtureTerms {
  schemaVersion: 1;
  contractId: string;
  provider: string;
  model: string;
  dimensions: Array<{ name: string; unit: string; maxUnits: number; priceMicros: number; priceUnits: number }>;
  attemptOverheadMicros: number;
  maxChargeMicros: number;
  authoritativeUsageSource: 'provider_usage' | 'invoice' | 'none';
  verifiedEvidenceHash: string;
  verifiedEvidenceRef: string;
  verifiedBy: string;
  verifiedAt: string;
}

function verifiedContract(terms: ContractFixtureTerms) {
  return VerifiedPaidEffectBillingContractSchema.parse({ ...terms, verifiedTermsHash: paidEffectBillingTermsHash(terms) });
}

afterEach(() => {
  for (const db of openedDatabases.splice(0)) {
    try { db.close(); } catch { /* a restart test already closed its first handle */ }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function contractInput(maxUnits: number, priceMicros: number, priceUnits = 1, cumulativeMaxUnits?: number) {
  const maximum = (BigInt(maxUnits) * BigInt(priceMicros) + BigInt(priceUnits) - 1n) / BigInt(priceUnits);
  if (maximum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixture charge is not a safe integer');
  return {
    schemaVersion: 1 as const,
    contractId: 'fixture-billing-contract',
    provider: 'fixture-provider',
    model: 'fixture-model',
    dimensions: [{ name: 'units', unit: 'request-unit', maxUnits, ...(cumulativeMaxUnits === undefined ? {} : { cumulativeMaxUnits }), priceMicros, priceUnits }],
    attemptOverheadMicros: 0,
    maxChargeMicros: Number(maximum),
    authoritativeUsageSource: 'provider_usage' as const,
    verifiedEvidenceHash: 'a'.repeat(64),
    verifiedEvidenceRef: 'controlled-test-contract',
    verifiedBy: 'unit-test-fixture',
    verifiedAt: '2026-10-22T00:00:00.000Z',
  };
}

function makeAuthorization(ceiling: number, maxUnits = 1, priceMicros = 60, priceUnits = 1, cumulativeMaxUnits?: number): PaidEffectAuthorization {
  const contract = verifiedContract(contractInput(maxUnits, priceMicros, priceUnits, cumulativeMaxUnits));
  return PaidEffectAuthorizationSchema.parse({
    schemaVersion: 1,
    authorizationId: 'qualification-budget-fixture',
    qualificationRunId: 'qualification-run-fixture',
    approvedCeilingMicros: ceiling,
    arms: ['baseline', 'candidate'],
    billingContracts: [contract],
  });
}

function openFixture(ceiling = 300, maxUnits = 1, priceMicros = 60, priceUnits = 1, cumulativeMaxUnits?: number) {
  const db = new Database(':memory:');
  openedDatabases.push(db);
  const authorization = makeAuthorization(ceiling, maxUnits, priceMicros, priceUnits, cumulativeMaxUnits);
  const coordinator = new PaidEffectBudgetCoordinator(db, authorization);
  const client = createPaidEffectBudgetClient((request) => coordinator.handleRequest(request), new AbortController().signal);
  return { db, authorization, coordinator, client, contract: authorization.billingContracts[0]! };
}


function scope(arm: 'baseline' | 'candidate' = 'baseline', outputId = `output-${arm}`): QualificationPaidEffectScope {
  return {
    qualificationRunId: 'qualification-run-fixture',
    authorizationId: 'qualification-budget-fixture',
    arm,
    outputId,
    beneficiaries: [{ kind: 'item', id: 'fixture-row-1' }],
  };
}

function descriptor(contract: PaidEffectAuthorization['billingContracts'][number], key = createPaidEffectIdempotencyKey()): PaidEffectAttemptDescriptor {
  return {
    idempotencyKey: key,
    logicalEffectId: 'product-detail-extraction:fixture-row-1',
    provider: contract.provider,
    model: contract.model,
    effect: 'extract-product-details',
    billingContractId: contract.contractId,
    billingContractHash: hashCanonicalJson(contract),
    requestedUnits: Object.fromEntries(contract.dimensions.map((dimension) => [dimension.name, dimension.maxUnits])),
  };
}

async function withinScope<T>(input: {
  client: PaidEffectBudgetClient;
  scope?: QualificationPaidEffectScope;
  signal?: AbortSignal;
  body: () => Promise<T> | T;
}): Promise<T> {
  return withRequiredQualificationPaidEffectScope(() => withQualificationPaidEffectScope({
    scope: input.scope ?? scope(),
    client: input.client,
    signal: input.signal,
    body: input.body,
  }));
}

describe('qualification paid-effect budget lifecycle', () => {
  it('atomically denies concurrent reservations whose maxima would cross the shared ceiling', async () => {
    const fixture = openFixture(100, 1, 60);
    const attempts = await Promise.allSettled([
      fixture.client.reserve(scope('baseline'), descriptor(fixture.contract, 'attempt-near-cap-a')),
      fixture.client.reserve(scope('candidate'), descriptor(fixture.contract, 'attempt-near-cap-b')),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const denial = attempts.find((result) => result.status === 'rejected');
    expect(denial?.status).toBe('rejected');
    if (denial?.status === 'rejected') expect(denial.reason).toMatchObject({ code: 'budget_exhausted' });
    const snapshot = fixture.coordinator.snapshot(scope());
    expect(snapshot.totalEncumberedMicros).toBe(60);
    expect(snapshot.totalEncumberedMicros).toBeLessThanOrEqual(snapshot.authorizedCeilingMicros);
  });
  it('denies Serper request unit 2,500 while retaining the 2,499-unit pool usage in the ledger', async () => {
    const fixture = openFixture(0, 1, 0, 1, 2_499);
    for (let attempt = 1; attempt <= 2_499; attempt += 1) {
      await fixture.client.reserve(scope(), descriptor(fixture.contract, `serper-pool-attempt-${attempt}`));
    }
    await expect(fixture.client.reserve(scope(), descriptor(fixture.contract, 'serper-pool-attempt-2500')))
      .rejects.toMatchObject({ code: 'budget_exhausted' });
    const snapshot = fixture.coordinator.snapshot(scope());
    expect(snapshot.uniqueEffects).toBe(2_499);
    expect(snapshot.effects).toHaveLength(2_499);
    expect(snapshot.effects.reduce((sum, effect) => sum + (effect.descriptor.requestedUnits.units ?? 0), 0)).toBe(2_499);
  });

  it('pairs logical effects across arms and outputs while assigning each retry a separate physical idempotency key', async () => {
    const fixture = openFixture(180, 1, 60);
    const first = descriptor(fixture.contract, 'physical-attempt-1');
    const firstReservation = await fixture.client.reserve(scope('baseline', 'output-initial'), first);
    const exactReplay = await fixture.client.reserve(scope('baseline', 'output-initial'), first);
    expect(exactReplay.descriptorHash).toBe(firstReservation.descriptorHash);
    await expect(fixture.client.reserve(scope('baseline', 'different-output'), first))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });

    await expect(fixture.client.reserve(scope('baseline', 'output-initial'), { ...first, logicalEffectId: 'changed-logical-call' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });

    const retry = descriptor(fixture.contract, 'physical-attempt-2');
    expect(retry.logicalEffectId).toBe(first.logicalEffectId);
    await fixture.client.reserve(scope('baseline', 'output-after-restart'), retry);
    await fixture.client.reserve(scope('candidate', 'candidate-output'), descriptor(fixture.contract, 'candidate-attempt-1'));
    const snapshot = fixture.coordinator.snapshot(scope());
    expect(snapshot.uniqueEffects).toBe(3);
    expect(snapshot.reservedLiabilitiesMicros).toBe(180);
    expect(snapshot.effects.map((effect) => effect.descriptor.logicalEffectId)).toEqual([
      first.logicalEffectId,
      first.logicalEffectId,
      first.logicalEffectId,
    ]);
  });

  it('retains a dispatched liability across journal restart and refuses to dispatch its replay twice', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qualification-budget-restart-'));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, 'journal.sqlite');
    let db = new Database(dbPath);
    openedDatabases.push(db);
    const authorization = makeAuthorization(100, 1, 60);
    const coordinator = new PaidEffectBudgetCoordinator(db, authorization);
    const client = createPaidEffectBudgetClient((request) => coordinator.handleRequest(request), new AbortController().signal);
    const currentScope = scope();
    const attempt = descriptor(authorization.billingContracts[0]!, 'crashed-attempt');
    const reservation = await client.reserve(currentScope, attempt);
    await reservation.markDispatched();
    db.close();

    db = new Database(dbPath);
    openedDatabases.push(db);
    const restarted = new PaidEffectBudgetCoordinator(db, authorization);
    const restartedClient = createPaidEffectBudgetClient((request) => restarted.handleRequest(request), new AbortController().signal);
    const snapshot = restarted.snapshot(currentScope);
    expect(snapshot.unknownLiabilitiesMicros).toBe(60);
    expect(snapshot.availableMicros).toBe(40);
    const replay = await restartedClient.reserve(currentScope, attempt);
    await expect(replay.markDispatched()).rejects.toMatchObject({ code: 'reservation_state' });
    await expect(restartedClient.reserve(currentScope, descriptor(authorization.billingContracts[0]!, 'new-retry-after-crash')))
      .rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('distinguishes cancellation before dispatch from cancellation after dispatch', async () => {
    const fixture = openFixture(100, 1, 60);
    const preDispatchAbort = new AbortController();
    preDispatchAbort.abort();
    let effects = 0;
    await expect(withinScope({
      client: fixture.client,
      signal: preDispatchAbort.signal,
      body: () => runPaidEffect({ descriptor: descriptor(fixture.contract, 'cancel-before-dispatch'), execute: async () => {
        effects++;
        return { value: undefined };
      } }),
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(effects).toBe(0);
    expect(fixture.coordinator.snapshot(scope()).uniqueEffects).toBe(0);
    const reservedThenAborted = new AbortController();
    const cancellingClient = createPaidEffectBudgetClient(async (request) => {
      const reply = await fixture.coordinator.handleRequest(request);
      if (request.operation === 'reserve') reservedThenAborted.abort();
      return reply;
    }, new AbortController().signal);
    await expect(withinScope({
      client: cancellingClient,
      signal: reservedThenAborted.signal,
      body: () => runPaidEffect({ descriptor: descriptor(fixture.contract, 'cancel-after-reserve'), execute: async () => {
        effects++;
        return { value: 'must-not-run' };
      } }),
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(effects).toBe(0);
    const beforeDispatchSnapshot = fixture.coordinator.snapshot(scope());
    expect(beforeDispatchSnapshot.effects[0]).toMatchObject({ state: 'released', maximumChargeMicros: 60 });
    expect(beforeDispatchSnapshot.reservedLiabilitiesMicros).toBe(0);


    const afterDispatchAbort = new AbortController();
    await expect(withinScope({
      client: fixture.client,
      signal: afterDispatchAbort.signal,
      body: () => runPaidEffect({ descriptor: descriptor(fixture.contract, 'cancel-after-dispatch'), execute: async () => {
        effects++;
        afterDispatchAbort.abort();
        throw new Error('provider interrupted after dispatch');
      } }),
    })).rejects.toThrow('provider interrupted after dispatch');
    expect(effects).toBe(1);
    const snapshot = fixture.coordinator.snapshot(scope());
    expect(snapshot.unknownLiabilitiesMicros).toBe(60);
    await expect(fixture.client.reserve(scope(), descriptor(fixture.contract, 'additional-after-cancel')))
      .rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('records raw usage and estimates separately and lowers liability only from matching authoritative billing evidence', async () => {
    const fixture = openFixture(200, 10, 10);
    const attempt = descriptor(fixture.contract, 'usage-settlement-attempt');
    const reservation = await fixture.client.reserve(scope(), attempt);
    await reservation.markDispatched();
    await reservation.settle({ kind: 'unknown', rawUsage: { units: 2 }, estimatedCostMicros: 20 });
    const unresolved = fixture.coordinator.snapshot(scope());
    expect(unresolved.knownSubtotalMicros).toBe(0);
    expect(unresolved.unknownLiabilitiesMicros).toBe(100);
    expect(unresolved.effects[0]?.observations[0]).toMatchObject({ rawUsage: { units: 2 }, estimatedCostMicros: 20, actualCostMicros: null });

    const evidence = {
      kind: 'authoritative' as const, source: 'provider_usage' as const, evidenceRef: 'provider-usage-receipt',
      rawUsage: { units: 2 }, actualCostMicros: 20, estimatedCostMicros: 20,
    };
    const childSettlement = await fixture.coordinator.handleRequest({
      version: 1, requestId: 'child-settlement-attempt', operation: 'settle', scope: scope(),
      idempotencyKey: attempt.idempotencyKey, descriptorHash: reservation.descriptorHash, evidence,
    });
    expect(childSettlement).toMatchObject({ ok: false, code: 'authoritative_settlement_parent_only' });
    await fixture.coordinator.settle(scope(), attempt.idempotencyKey, reservation.descriptorHash, evidence);
    const reconciled = fixture.coordinator.snapshot(scope());
    expect(reconciled.knownSubtotalMicros).toBe(20);
    expect(reconciled.unknownLiabilitiesMicros).toBe(0);
    expect(reconciled.effects[0]?.beneficiaries).toEqual(scope().beneficiaries);
    expect(reconciled.effects[0]?.observations.map((observation) => observation.kind)).toEqual(['unknown', 'authoritative']);
  });

  it('closes authorization on provider contract drift and keeps the dispatched maximum reserved', async () => {
    const fixture = openFixture(200, 10, 10);
    const attempt = descriptor(fixture.contract, 'drifting-provider-attempt');
    const reservation = await fixture.client.reserve(scope(), attempt);
    await reservation.markDispatched();
    await expect(fixture.coordinator.settle(scope(), attempt.idempotencyKey, reservation.descriptorHash, {
      kind: 'authoritative', source: 'provider_usage', evidenceRef: 'contradictory-receipt',
      rawUsage: { units: 2 }, actualCostMicros: 19,
    })).rejects.toMatchObject({ code: 'contract_drift' });
    const snapshot = fixture.coordinator.snapshot(scope());
    expect(snapshot.state).toBe('drifted');
    expect(snapshot.unknownLiabilitiesMicros).toBe(100);
    await expect(fixture.client.reserve(scope(), descriptor(fixture.contract, 'after-contract-drift')))
      .rejects.toMatchObject({ code: 'authorization_closed' });
  });

  it('releases only reservations proven never dispatched', async () => {
    const fixture = openFixture(200, 1, 60);
    const undispatched = await fixture.client.reserve(scope(), descriptor(fixture.contract, 'release-before-dispatch'));
    await undispatched.releaseUndispatched('cancelled_before_dispatch');
    await undispatched.releaseUndispatched('cancelled_before_dispatch');
    expect(fixture.coordinator.snapshot(scope()).reservedLiabilitiesMicros).toBe(0);

    const dispatched = await fixture.client.reserve(scope(), descriptor(fixture.contract, 'retain-after-dispatch'));
    await dispatched.markDispatched();
    await expect(dispatched.releaseUndispatched('cancelled_after_dispatch')).rejects.toMatchObject({ code: 'reservation_state' });
    expect(fixture.coordinator.snapshot(scope()).unknownLiabilitiesMicros).toBe(60);
  });

  it('requires scope in qualification children while leaving unscoped ordinary execution pass-through', async () => {
    const fixture = openFixture();
    let effects = 0;
    await runPaidEffect({ descriptor: descriptor(fixture.contract, 'ordinary-no-scope'), execute: async () => {
      effects++;
      return { value: 'ordinary' };
    } });
    expect(effects).toBe(1);

    await expect(withRequiredQualificationPaidEffectScope(() => runPaidEffect({
      descriptor: descriptor(fixture.contract, 'missing-qualification-scope'),
      execute: async () => { effects++; return { value: 'must-not-run' }; },
    }))).rejects.toMatchObject({ code: 'scope_missing' });
    expect(effects).toBe(1);
  });

  it('fails closed when the parent IPC stream is lost before reservation', async () => {
    const replies = new PassThrough();
    const requests = new PassThrough();
    const ipc = createComparisonBudgetIpcClient({ replies, requests });
    const fixture = openFixture();
    let effects = 0;
    const parentClosed = Promise.withResolvers<void>();
    ipc.client.closedSignal.addEventListener('abort', () => parentClosed.resolve(), { once: true });
    replies.end();
    await parentClosed.promise;
    await expect(withinScope({
      client: ipc.client,
      body: () => runPaidEffect({ descriptor: descriptor(fixture.contract, 'parent-lost'), execute: async () => {
        effects++;
        return { value: 'must-not-run' };
      } }),
    })).rejects.toBeInstanceOf(PaidEffectBudgetError);
    expect(effects).toBe(0);
    ipc.close();
    requests.destroy();
  });
  it('denies a paid effect after a journal read/write failure', async () => {
    const fixture = openFixture();
    fixture.db.exec('DROP TABLE paid_effect_reservations');
    let effects = 0;
    await expect(withinScope({
      client: fixture.client,
      body: () => runPaidEffect({ descriptor: descriptor(fixture.contract, 'journal-failure'), execute: async () => {
        effects++;
        return { value: 'must-not-run' };
      } }),
    })).rejects.toMatchObject({ code: 'journal_unavailable' });
    expect(effects).toBe(0);
    expect(fixture.coordinator.isClosed()).toBe(true);
  });


  it('rejects caller-substituted prices, ceiling overflow, and unsafe rounded totals', async () => {
    const fixture = openFixture();
    const badDescriptor = { ...descriptor(fixture.contract, 'substituted-contract'), billingContractHash: 'b'.repeat(64) };
    let effects = 0;
    await expect(withinScope({
      client: fixture.client,
      body: () => runPaidEffect({ descriptor: badDescriptor, execute: async () => {
        effects++;
        return { value: 'must-not-run' };
      } }),
    })).rejects.toMatchObject({ code: 'contract_drift' });
    expect(effects).toBe(0);
    expect(() => new PaidEffectBudgetCoordinator(fixture.db, makeAuthorization(300, 1, 61)))
      .toThrow('paid_effect_authorization_conflict');

    expect(PaidEffectAuthorizationSchema.safeParse({ ...fixture.authorization, approvedCeilingMicros: 3_000_001 }).success).toBe(false);
    const rounded = verifiedContract(contractInput(1, 1, 3));
    expect(rounded.maxChargeMicros).toBe(1);
    expect(calculatePaidEffectChargeMicros(rounded, { units: 1 })).toBe(1);
    const oversizedTerms = {
      ...contractInput(1, 1),
      dimensions: [{ name: 'units', unit: 'request-unit', maxUnits: 2, priceMicros: Number.MAX_SAFE_INTEGER, priceUnits: 1 }],
      maxChargeMicros: Number.MAX_SAFE_INTEGER,
    };
    expect(() => verifiedContract(oversizedTerms)).toThrow();
  });

  it('terminal close releases only undispatched work and rejects new effects', async () => {
    const fixture = openFixture(200, 1, 60);
    const reserved = await fixture.client.reserve(scope(), descriptor(fixture.contract, 'close-undispatched'));
    const dispatched = await fixture.client.reserve(scope(), descriptor(fixture.contract, 'close-dispatched'));
    await dispatched.markDispatched();
    fixture.coordinator.close('qualification complete');

    const snapshot = fixture.coordinator.snapshot(scope());
    expect(snapshot.state).toBe('closed');
    expect(snapshot.reservedLiabilitiesMicros).toBe(0);
    expect(snapshot.unknownLiabilitiesMicros).toBe(60);
    await expect(reserved.markDispatched()).rejects.toMatchObject({ code: 'authorization_closed' });
    let effects = 0;
    await expect(withinScope({
      client: fixture.client,
      body: () => runPaidEffect({ descriptor: descriptor(fixture.contract, 'after-terminal-close'), execute: async () => {
        effects++;
        return { value: 'must-not-run' };
      } }),
    })).rejects.toMatchObject({ code: 'authorization_closed' });
    expect(effects).toBe(0);
  });

  it('coordinates real child processes against the same ceiling', async () => {
    const result = await runComparisonBudgetCoordinatorSmoke();
    expect(result.allowedChildren).toBe(1);
    expect(result.deniedChildren).toBe(1);
    expect(result.knownSubtotalMicros).toBe(0);
    expect(result.unknownLiabilitiesMicros).toBe(70);
    expect(result.totalEncumberedMicros).toBe(70);
  });
});
