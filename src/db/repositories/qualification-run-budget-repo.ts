import type { Database } from 'bun:sqlite';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  calculatePaidEffectChargeMicros,
  PaidEffectAuthorizationSchema,
  PaidEffectAttemptDescriptorSchema,
  PaidEffectBeneficiariesSchema,
  PaidEffectRawUsageSchema,
  PaidEffectSettlementSchema,
  QualificationPaidEffectScopeSchema,
  type PaidEffectAuthorization,
  type PaidEffectAttemptDescriptor,
  type PaidEffectRawUsage,
  type PaidEffectSettlement,
  type QualificationPaidEffectScope,
  type VerifiedPaidEffectBillingContract,
} from '../../shared/schemas/paid-effect';

export type PaidEffectAuthorizationState = 'active' | 'closed' | 'drifted';
export type PaidEffectReservationState = 'reserved' | 'dispatched' | 'settled' | 'released';

export interface PaidEffectReservationRecord {
  idempotencyKey: string;
  authorizationId: string;
  qualificationRunId: string;
  arm: QualificationPaidEffectScope['arm'];
  outputId: string;
  beneficiaries: QualificationPaidEffectScope['beneficiaries'];
  descriptor: PaidEffectAttemptDescriptor;
  descriptorHash: string;
  billingContractHash: string;
  maximumChargeMicros: number;
  state: PaidEffectReservationState;
  actualCostMicros: number | null;
  releaseReason: string | null;
  observations: PaidEffectObservation[];
  createdAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
}

export interface PaidEffectObservation {
  observationHash: string;
  kind: PaidEffectSettlement['kind'];
  rawUsage: PaidEffectRawUsage | null;
  estimatedCostMicros: number | null;
  actualCostMicros: number | null;
  evidenceRef: string | null;
  source: 'provider_usage' | 'invoice' | null;
  createdAt: string;
}

export interface PaidEffectBudgetSnapshot {
  authorizationId: string;
  qualificationRunId: string;
  state: PaidEffectAuthorizationState;
  authorizedCeilingMicros: number;
  uniqueEffects: number;
  knownSubtotalMicros: number;
  unknownLiabilitiesMicros: number;
  reservedLiabilitiesMicros: number;
  totalEncumberedMicros: number;
  availableMicros: number;
  effects: PaidEffectReservationRecord[];
}

interface AuthorizationRow {
  authorization_id: string;
  qualification_run_id: string;
  ceiling_micros: number;
  authorization_hash: string;
  authorization_json: string;
  state: string;
  close_reason: string | null;
  created_at: string;
  closed_at: string | null;
}

interface ReservationRow {
  idempotency_key: string;
  authorization_id: string;
  qualification_run_id: string;
  arm: string;
  output_id: string;
  beneficiaries_json: string;
  descriptor_json: string;
  descriptor_hash: string;
  billing_contract_hash: string;
  maximum_charge_micros: number;
  state: string;
  actual_cost_micros: number | null;
  release_reason: string | null;
  created_at: string;
  dispatched_at: string | null;
  settled_at: string | null;
}

interface ObservationRow {
  observation_hash: string;
  kind: string;
  raw_usage_json: string | null;
  estimated_cost_micros: number | null;
  actual_cost_micros: number | null;
  evidence_ref: string | null;
  source: string | null;
  created_at: string;
}

const now = (): string => new Date().toISOString();

function transaction<T>(db: Database, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = body();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original journal error */ }
    throw error;
  }
}

function parseJson<T>(json: string, label: string, parse: (value: unknown) => T): T {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error(`paid_effect_journal_corrupt:${label}`); }
  try { return parse(value); } catch { throw new Error(`paid_effect_journal_corrupt:${label}`); }
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('paid_effect_journal_overflow');
  return total;
}

function checkedSum(rows: readonly ReservationRow[]): { known: number; unknown: number; reserved: number; total: number } {
  let known = 0;
  let unknown = 0;
  let reserved = 0;
  for (const row of rows) {
    if (row.state === 'settled') known = checkedAdd(known, row.actual_cost_micros ?? -1);
    else if (row.state === 'dispatched') unknown = checkedAdd(unknown, row.maximum_charge_micros);
    else if (row.state === 'reserved') reserved = checkedAdd(reserved, row.maximum_charge_micros);
    else if (row.state !== 'released') throw new Error('paid_effect_journal_corrupt:reservation_state');
  }
  return { known, unknown, reserved, total: checkedAdd(checkedAdd(known, unknown), reserved) };
}

function getAuthorization(db: Database, authorizationId: string): AuthorizationRow {
  const row = db.query('SELECT * FROM paid_effect_authorizations WHERE authorization_id = ?').get(authorizationId) as AuthorizationRow | null;
  if (!row) throw new Error('paid_effect_authorization_missing');
  if (!Number.isSafeInteger(row.ceiling_micros) || row.ceiling_micros < 0) throw new Error('paid_effect_journal_corrupt:authorization_ceiling');
  return row;
}

function parseAuthorization(row: AuthorizationRow): PaidEffectAuthorization {
  const authorization = parseJson(row.authorization_json, 'authorization', (value) => PaidEffectAuthorizationSchema.parse(value));
  if (authorization.authorizationId !== row.authorization_id || authorization.qualificationRunId !== row.qualification_run_id ||
    authorization.approvedCeilingMicros !== row.ceiling_micros || hashCanonicalJson(authorization) !== row.authorization_hash) {
    throw new Error('paid_effect_journal_corrupt:authorization_binding');
  }
  return authorization;
}

function getRows(db: Database, authorizationId: string): ReservationRow[] {
  return db.query(`SELECT * FROM paid_effect_reservations WHERE authorization_id = ? ORDER BY created_at, idempotency_key`).all(authorizationId) as ReservationRow[];
}

function getContract(authorization: PaidEffectAuthorization, contractId: string): VerifiedPaidEffectBillingContract {
  const contract = authorization.billingContracts.find((candidate) => candidate.contractId === contractId);
  if (!contract) throw new Error('paid_effect_billing_contract_unverified');
  return contract;
}

function assertScope(scopeInput: QualificationPaidEffectScope, authorization: PaidEffectAuthorization): QualificationPaidEffectScope {
  const scope = QualificationPaidEffectScopeSchema.parse(scopeInput);
  if (scope.authorizationId !== authorization.authorizationId || scope.qualificationRunId !== authorization.qualificationRunId) {
    throw new Error('paid_effect_qualification_scope_mismatch');
  }
  if (!authorization.arms.includes(scope.arm)) throw new Error('paid_effect_arm_not_authorized');
  return scope;
}

function validateDescriptor(
  descriptorInput: PaidEffectAttemptDescriptor,
  contract: VerifiedPaidEffectBillingContract,
): PaidEffectAttemptDescriptor {
  const descriptor = PaidEffectAttemptDescriptorSchema.parse(descriptorInput);
  if (descriptor.provider !== contract.provider || descriptor.model !== contract.model || descriptor.billingContractHash !== hashCanonicalJson(contract)) {
    throw new Error('paid_effect_billing_contract_drift');
  }
  if (descriptor.requestedUnits && Object.keys(descriptor.requestedUnits).some((key) => {
    const dimension = contract.dimensions.find((candidate) => candidate.name === key);
    return !dimension || descriptor.requestedUnits[key]! > dimension.maxUnits;
  })) throw new Error('paid_effect_request_exceeds_contract');
  for (const dimension of contract.dimensions) {
    if (descriptor.requestedUnits[dimension.name] === undefined) throw new Error(`paid_effect_request_missing_dimension:${dimension.name}`);
  }
  return descriptor;
}

function parseObservations(db: Database, idempotencyKey: string): PaidEffectObservation[] {
  const rows = db.query(`SELECT * FROM paid_effect_observations WHERE idempotency_key = ? ORDER BY rowid`).all(idempotencyKey) as ObservationRow[];
  return rows.map((row) => ({
    observationHash: row.observation_hash,
    kind: row.kind as PaidEffectSettlement['kind'],
    rawUsage: row.raw_usage_json === null ? null : parseJson(row.raw_usage_json, 'raw_usage', (value) => PaidEffectRawUsageSchema.parse(value)),
    estimatedCostMicros: row.estimated_cost_micros,
    actualCostMicros: row.actual_cost_micros,
    evidenceRef: row.evidence_ref,
    source: row.source as PaidEffectObservation['source'],
    createdAt: row.created_at,
  }));
}

function mapReservation(db: Database, row: ReservationRow): PaidEffectReservationRecord {
  const beneficiaries = parseJson(row.beneficiaries_json, 'beneficiaries', (value) => PaidEffectBeneficiariesSchema.parse(value));
  const scope = QualificationPaidEffectScopeSchema.parse({
    qualificationRunId: row.qualification_run_id,
    authorizationId: row.authorization_id,
    arm: row.arm,
    outputId: row.output_id,
    beneficiaries,
  });
  return {
    idempotencyKey: row.idempotency_key,
    authorizationId: row.authorization_id,
    qualificationRunId: row.qualification_run_id,
    arm: row.arm as QualificationPaidEffectScope['arm'],
    outputId: row.output_id,
    beneficiaries: scope.beneficiaries,
    descriptor: parseJson(row.descriptor_json, 'descriptor', (value) => PaidEffectAttemptDescriptorSchema.parse(value)),
    descriptorHash: row.descriptor_hash,
    billingContractHash: row.billing_contract_hash,
    maximumChargeMicros: row.maximum_charge_micros,
    state: row.state as PaidEffectReservationState,
    actualCostMicros: row.actual_cost_micros,
    releaseReason: row.release_reason,
    observations: parseObservations(db, row.idempotency_key),
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at,
  };
}
function closeForDrift(db: Database, authorizationId: string, reason: string): void {
  db.query(`UPDATE paid_effect_authorizations SET state = 'drifted', close_reason = ?, closed_at = ?
    WHERE authorization_id = ? AND state = 'active'`).run(reason.slice(0, 256), now(), authorizationId);
  db.query(`UPDATE paid_effect_reservations SET state = 'released', release_reason = 'authorization_drifted_before_dispatch', settled_at = ?
    WHERE authorization_id = ? AND state = 'reserved'`).run(now(), authorizationId);
}


/** Installs tables only in the explicitly owned qualification budget ledger. */
export function installQualificationRunBudgetSchema(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS paid_effect_authorizations (
      authorization_id TEXT PRIMARY KEY,
      qualification_run_id TEXT NOT NULL,
      ceiling_micros INTEGER NOT NULL CHECK (ceiling_micros BETWEEN 0 AND 3000000),
      authorization_hash TEXT NOT NULL,
      authorization_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'drifted')),
      close_reason TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS paid_effect_reservations (
      idempotency_key TEXT PRIMARY KEY,
      authorization_id TEXT NOT NULL REFERENCES paid_effect_authorizations(authorization_id),
      qualification_run_id TEXT NOT NULL,
      arm TEXT NOT NULL CHECK (arm IN ('baseline', 'candidate')),
      output_id TEXT NOT NULL,
      beneficiaries_json TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,
      descriptor_hash TEXT NOT NULL,
      billing_contract_hash TEXT NOT NULL,
      maximum_charge_micros INTEGER NOT NULL CHECK (maximum_charge_micros BETWEEN 0 AND 9007199254740991),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'released')),
      actual_cost_micros INTEGER,
      release_reason TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      settled_at TEXT,
      CHECK (actual_cost_micros IS NULL OR actual_cost_micros BETWEEN 0 AND 9007199254740991)
    );
    CREATE INDEX IF NOT EXISTS idx_paid_effect_reservations_authorization_state
      ON paid_effect_reservations(authorization_id, state);
    CREATE INDEX IF NOT EXISTS idx_paid_effect_reservations_qualification
      ON paid_effect_reservations(qualification_run_id, arm, output_id);
    CREATE TABLE IF NOT EXISTS paid_effect_observations (
      idempotency_key TEXT NOT NULL REFERENCES paid_effect_reservations(idempotency_key),
      observation_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('unknown', 'authoritative')),
      raw_usage_json TEXT,
      estimated_cost_micros INTEGER,
      actual_cost_micros INTEGER,
      evidence_ref TEXT,
      source TEXT CHECK (source IS NULL OR source IN ('provider_usage', 'invoice')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, observation_hash),
      CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros BETWEEN 0 AND 9007199254740991),
      CHECK (actual_cost_micros IS NULL OR actual_cost_micros BETWEEN 0 AND 9007199254740991)
    );
  `);
}

export function createQualificationRunBudgetRepo(db: Database) {
  return {
    freezeAuthorization(input: PaidEffectAuthorization): { authorization: PaidEffectAuthorization; authorizationHash: string; state: PaidEffectAuthorizationState } {
      const authorization = PaidEffectAuthorizationSchema.parse(input);
      const authorizationHash = hashCanonicalJson(authorization);
      return transaction(db, () => {
        const existing = db.query('SELECT * FROM paid_effect_authorizations WHERE authorization_id = ?').get(authorization.authorizationId) as AuthorizationRow | null;
        if (existing) {
          if (existing.authorization_hash !== authorizationHash) {
            throw new Error('paid_effect_authorization_conflict');
          }
          parseAuthorization(existing);
          return { authorization, authorizationHash, state: existing.state as PaidEffectAuthorizationState };
        }
        db.query(`INSERT INTO paid_effect_authorizations
          (authorization_id, qualification_run_id, ceiling_micros, authorization_hash, authorization_json, state, created_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?)`)
          .run(authorization.authorizationId, authorization.qualificationRunId, authorization.approvedCeilingMicros, authorizationHash, JSON.stringify(authorization), now());
        return { authorization, authorizationHash, state: 'active' };
      });
    },

    reserve(input: { scope: QualificationPaidEffectScope; descriptor: PaidEffectAttemptDescriptor }): PaidEffectReservationRecord {
      const scope = QualificationPaidEffectScopeSchema.parse(input.scope);
      const descriptor = PaidEffectAttemptDescriptorSchema.parse(input.descriptor);
      return transaction(db, () => {
        const authorizationRow = getAuthorization(db, scope.authorizationId);
        const authorization = parseAuthorization(authorizationRow);
        assertScope(scope, authorization);
        if (authorizationRow.state !== 'active') throw new Error(`paid_effect_ledger_${authorizationRow.state}`);
        const contract = getContract(authorization, descriptor.billingContractId);
        validateDescriptor(descriptor, contract);
        const maximumChargeMicros = contract.maxChargeMicros;
        const descriptorHash = hashCanonicalJson({
          authorizationHash: authorizationRow.authorization_hash,
          scope,
          descriptor,
          billingContractHash: descriptor.billingContractHash,
          maximumChargeMicros,
        });
        const existing = db.query('SELECT * FROM paid_effect_reservations WHERE idempotency_key = ?').get(descriptor.idempotencyKey) as ReservationRow | null;
        if (existing) {
          if (existing.authorization_id !== authorization.authorizationId || existing.descriptor_hash !== descriptorHash) {
            throw new Error('paid_effect_idempotency_conflict');
          }
          return mapReservation(db, existing);
        }
        const rows = getRows(db, authorization.authorizationId);
        for (const dimension of contract.dimensions) {
          if (dimension.cumulativeMaxUnits === undefined) continue;
          let consumedUnits = 0;
          for (const row of rows) {
            if (row.state === 'released' || row.billing_contract_hash !== descriptor.billingContractHash) continue;
            const priorDescriptor = parseJson(row.descriptor_json, 'descriptor', (value) => PaidEffectAttemptDescriptorSchema.parse(value));
            const priorUnits = priorDescriptor.requestedUnits[dimension.name] ?? 0;
            consumedUnits = checkedAdd(consumedUnits, priorUnits);
          }
          const requestedUnits = descriptor.requestedUnits[dimension.name] ?? 0;
          if (requestedUnits > dimension.cumulativeMaxUnits - consumedUnits) throw new Error('paid_effect_budget_exhausted');
        }
        const totals = checkedSum(rows);
        if (totals.total > authorization.approvedCeilingMicros || maximumChargeMicros > authorization.approvedCeilingMicros - totals.total) {
          throw new Error('paid_effect_budget_exhausted');
        }
        db.query(`INSERT INTO paid_effect_reservations
          (idempotency_key, authorization_id, qualification_run_id, arm, output_id, beneficiaries_json,
           descriptor_json, descriptor_hash, billing_contract_hash, maximum_charge_micros, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`)
          .run(descriptor.idempotencyKey, authorization.authorizationId, scope.qualificationRunId, scope.arm, scope.outputId,
            JSON.stringify(scope.beneficiaries), JSON.stringify(descriptor), descriptorHash, descriptor.billingContractHash,
            maximumChargeMicros, now());
        const inserted = db.query('SELECT * FROM paid_effect_reservations WHERE idempotency_key = ?').get(descriptor.idempotencyKey) as ReservationRow;
        return mapReservation(db, inserted);
      });
    },

    getReservation(authorizationId: string, idempotencyKey: string): PaidEffectReservationRecord | null {
      const row = db.query('SELECT * FROM paid_effect_reservations WHERE authorization_id = ? AND idempotency_key = ?').get(authorizationId, idempotencyKey) as ReservationRow | null;
      return row ? mapReservation(db, row) : null;
    },

    markDispatched(authorizationId: string, idempotencyKey: string, descriptorHash: string): void {
      transaction(db, () => {
        const authorization = getAuthorization(db, authorizationId);
        if (authorization.state !== 'active') throw new Error(`paid_effect_ledger_${authorization.state}`);
        const result = db.query(`UPDATE paid_effect_reservations SET state = 'dispatched', dispatched_at = ?
          WHERE authorization_id = ? AND idempotency_key = ? AND descriptor_hash = ? AND state = 'reserved'`)
          .run(now(), authorizationId, idempotencyKey, descriptorHash);
        if (result.changes !== 1) throw new Error('paid_effect_reservation_not_dispatchable');
      });
    },

    settle(authorizationId: string, idempotencyKey: string, descriptorHash: string, input: PaidEffectSettlement): void {
      const settlement = PaidEffectSettlementSchema.parse(input);
      const observationHash = hashCanonicalJson(settlement);
      const result = transaction(db, () => {
        const authorizationRow = getAuthorization(db, authorizationId);
        const authorization = parseAuthorization(authorizationRow);
        const row = db.query('SELECT * FROM paid_effect_reservations WHERE authorization_id = ? AND idempotency_key = ?').get(authorizationId, idempotencyKey) as ReservationRow | null;
        if (!row) throw new Error('paid_effect_reservation_missing');
        if (row.descriptor_hash !== descriptorHash) throw new Error('paid_effect_idempotency_conflict');
        if (settlement.kind === 'unknown') {
          if (row.state === 'settled') throw new Error('paid_effect_reservation_already_settled');
          if (row.state !== 'dispatched') throw new Error('paid_effect_reservation_not_settleable');
          const rawUsage = settlement.rawUsage == null ? null : PaidEffectRawUsageSchema.parse(settlement.rawUsage);
          db.query(`INSERT OR IGNORE INTO paid_effect_observations
            (idempotency_key, observation_hash, kind, raw_usage_json, estimated_cost_micros, created_at)
            VALUES (?, ?, 'unknown', ?, ?, ?)`)
            .run(idempotencyKey, observationHash, rawUsage === null ? null : JSON.stringify(rawUsage), settlement.estimatedCostMicros ?? null, now());
          return 'ok' as const;
        }
        if (row.state === 'settled') {
          const existing = db.query(`SELECT 1 AS present FROM paid_effect_observations WHERE idempotency_key = ? AND observation_hash = ? AND kind = 'authoritative'`).get(idempotencyKey, observationHash);
          if (existing) return 'ok' as const;
          throw new Error('paid_effect_settlement_conflict');
        }
        if (row.state !== 'dispatched') throw new Error('paid_effect_reservation_not_settleable');
        const descriptor = parseJson(row.descriptor_json, 'descriptor', (value) => PaidEffectAttemptDescriptorSchema.parse(value));
        const contract = getContract(authorization, descriptor.billingContractId);
        const scope = QualificationPaidEffectScopeSchema.parse({
          qualificationRunId: row.qualification_run_id, authorizationId: row.authorization_id,
          arm: row.arm, outputId: row.output_id, beneficiaries: parseJson(row.beneficiaries_json, 'beneficiaries', (value) => PaidEffectBeneficiariesSchema.parse(value)),
        });
        assertScope(scope, authorization);
        if (contract.authoritativeUsageSource === 'none' || settlement.source !== contract.authoritativeUsageSource) {
          throw new Error('paid_effect_settlement_not_authoritative');
        }
        let computedMicros: number;
        try { computedMicros = calculatePaidEffectChargeMicros(contract, settlement.rawUsage); }
        catch (error) {
          const driftReason = error instanceof Error ? error.message : 'paid_effect_contract_drift';
          closeForDrift(db, authorizationId, driftReason);
          return 'drift' as const;
        }
        for (const [unit, quantity] of Object.entries(settlement.rawUsage)) {
          const reservedQuantity = descriptor.requestedUnits[unit];
          if (reservedQuantity === undefined || quantity > reservedQuantity) {
            closeForDrift(db, authorizationId, `paid_effect_contract_drift:${unit}`);
            return 'drift' as const;
          }
        }
        if (computedMicros !== settlement.actualCostMicros || settlement.actualCostMicros > row.maximum_charge_micros) {
          closeForDrift(db, authorizationId, 'paid_effect_authoritative_charge_exceeds_contract');
          return 'drift' as const;
        }
        db.query(`INSERT OR IGNORE INTO paid_effect_observations
          (idempotency_key, observation_hash, kind, raw_usage_json, estimated_cost_micros, actual_cost_micros, evidence_ref, source, created_at)
          VALUES (?, ?, 'authoritative', ?, ?, ?, ?, ?, ?)`)
          .run(idempotencyKey, observationHash, JSON.stringify(settlement.rawUsage), settlement.estimatedCostMicros ?? null,
            settlement.actualCostMicros, settlement.evidenceRef, settlement.source, now());
        db.query(`UPDATE paid_effect_reservations SET state = 'settled', actual_cost_micros = ?, settled_at = ?
          WHERE authorization_id = ? AND idempotency_key = ? AND state = 'dispatched'`)
          .run(settlement.actualCostMicros, now(), authorizationId, idempotencyKey);
        return 'ok' as const;
      });
      if (result === 'drift') throw new Error('paid_effect_billing_contract_drift');
    },

    releaseUndispatched(authorizationId: string, idempotencyKey: string, descriptorHash: string, reason: string): void {
      const safeReason = reason.trim().slice(0, 256);
      if (safeReason.length === 0) throw new Error('paid_effect_release_reason_required');
      transaction(db, () => {
        const row = db.query('SELECT state, release_reason, descriptor_hash FROM paid_effect_reservations WHERE authorization_id = ? AND idempotency_key = ?').get(authorizationId, idempotencyKey) as { state: string; release_reason: string | null; descriptor_hash: string } | null;
        if (!row) throw new Error('paid_effect_reservation_missing');
        if (row.descriptor_hash !== descriptorHash) throw new Error('paid_effect_idempotency_conflict');
        if (row.state === 'released' && row.release_reason === safeReason) return;
        if (row.state !== 'reserved') throw new Error('paid_effect_dispatched_reservation_not_releasable');
        db.query(`UPDATE paid_effect_reservations SET state = 'released', release_reason = ?, settled_at = ?
          WHERE authorization_id = ? AND idempotency_key = ? AND descriptor_hash = ? AND state = 'reserved'`)
          .run(safeReason, now(), authorizationId, idempotencyKey, descriptorHash);
      });
    },

    close(authorizationId: string, reason: string): void {
      const safeReason = reason.trim().slice(0, 256);
      if (safeReason.length === 0) throw new Error('paid_effect_close_reason_required');
      transaction(db, () => {
        const authorization = getAuthorization(db, authorizationId);
        if (authorization.state !== 'active') return;
        db.query(`UPDATE paid_effect_authorizations SET state = 'closed', close_reason = ?, closed_at = ? WHERE authorization_id = ? AND state = 'active'`)
          .run(safeReason, now(), authorizationId);
        db.query(`UPDATE paid_effect_reservations SET state = 'released', release_reason = 'authorization_closed_before_dispatch', settled_at = ?
          WHERE authorization_id = ? AND state = 'reserved'`)
          .run(now(), authorizationId);
      });
    },

    snapshot(authorizationId: string): PaidEffectBudgetSnapshot {
      const authorizationRow = getAuthorization(db, authorizationId);
      const authorization = parseAuthorization(authorizationRow);
      const rows = getRows(db, authorizationId);
      const totals = checkedSum(rows);
      if (totals.total > authorization.approvedCeilingMicros) throw new Error('paid_effect_journal_ceiling_invariant_broken');
      const effects = rows.map((row) => mapReservation(db, row));
      return {
        authorizationId,
        qualificationRunId: authorization.qualificationRunId,
        state: authorizationRow.state as PaidEffectAuthorizationState,
        authorizedCeilingMicros: authorization.approvedCeilingMicros,
        uniqueEffects: effects.length,
        knownSubtotalMicros: totals.known,
        unknownLiabilitiesMicros: totals.unknown,
        reservedLiabilitiesMicros: totals.reserved,
        totalEncumberedMicros: totals.total,
        availableMicros: authorization.approvedCeilingMicros - totals.total,
        effects,
      };
    },

  };
}
