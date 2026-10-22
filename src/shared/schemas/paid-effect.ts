import { z } from 'zod';
import { hashCanonicalJson, isSha256Hex } from '../stable-id';

export const MAX_PAID_EFFECT_CEILING_MICROS = 3_000_000;
const SafeNonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const IdentifierSchema = z.string().trim().min(1).max(256);
const DigestSchema = z.string().refine(isSha256Hex, 'Expected a lowercase SHA-256 digest.');

export const PaidEffectArmSchema = z.enum(['baseline', 'candidate']);
export type PaidEffectArm = z.infer<typeof PaidEffectArmSchema>;

export const PaidEffectBeneficiarySchema = z.object({
  kind: z.enum(['item', 'shared', 'run']),
  id: IdentifierSchema,
}).strict();
export type PaidEffectBeneficiary = z.infer<typeof PaidEffectBeneficiarySchema>;
export const PaidEffectBeneficiariesSchema = z.array(PaidEffectBeneficiarySchema).min(1).max(256);

/** The immutable qualification identity travels with every reservation request. */
export const QualificationPaidEffectScopeSchema = z.object({
  qualificationRunId: IdentifierSchema,
  authorizationId: IdentifierSchema,
  arm: PaidEffectArmSchema,
  outputId: IdentifierSchema,
  beneficiaries: PaidEffectBeneficiariesSchema,
}).strict().superRefine((scope, ctx) => {
  const keys = new Set<string>();
  for (const [index, beneficiary] of scope.beneficiaries.entries()) {
    const key = `${beneficiary.kind}\0${beneficiary.id}`;
    if (keys.has(key)) ctx.addIssue({ code: 'custom', path: ['beneficiaries', index], message: 'Duplicate paid-effect beneficiary.' });
    keys.add(key);
  }
});
export type QualificationPaidEffectScope = z.infer<typeof QualificationPaidEffectScopeSchema>;

export const PaidEffectBillingDimensionSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  unit: z.string().trim().min(1).max(64),
  maxUnits: SafeNonnegativeIntegerSchema,
  priceMicros: SafeNonnegativeIntegerSchema,
  priceUnits: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PaidEffectBillingDimension = z.infer<typeof PaidEffectBillingDimensionSchema>;

const BillingContractTermsSchema = z.object({
  schemaVersion: z.literal(1),
  contractId: IdentifierSchema,
  provider: IdentifierSchema,
  model: IdentifierSchema,
  dimensions: z.array(PaidEffectBillingDimensionSchema).max(64),
  attemptOverheadMicros: SafeNonnegativeIntegerSchema,
  maxChargeMicros: SafeNonnegativeIntegerSchema,
  authoritativeUsageSource: z.enum(['provider_usage', 'invoice', 'none']),
}).strict();

/** Structural freeze and price-bound validation only; a trusted parent must verify the referenced billing evidence before accepting it. */
export const VerifiedPaidEffectBillingContractSchema = BillingContractTermsSchema.extend({
  verifiedTermsHash: DigestSchema,
  verifiedEvidenceHash: DigestSchema,
  verifiedEvidenceRef: IdentifierSchema,
  verifiedBy: IdentifierSchema,
  verifiedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((contract, ctx) => {
  const names = new Set<string>();
  for (const [index, dimension] of contract.dimensions.entries()) {
    if (names.has(dimension.name)) ctx.addIssue({ code: 'custom', path: ['dimensions', index, 'name'], message: 'Duplicate billing dimension.' });
    names.add(dimension.name);
  }
  let maximum = BigInt(contract.attemptOverheadMicros);
  for (const dimension of contract.dimensions) {
    maximum += (BigInt(dimension.maxUnits) * BigInt(dimension.priceMicros) + BigInt(dimension.priceUnits) - 1n) / BigInt(dimension.priceUnits);
  }
  if (maximum > BigInt(Number.MAX_SAFE_INTEGER) || Number(maximum) !== contract.maxChargeMicros) {
    ctx.addIssue({ code: 'custom', path: ['maxChargeMicros'], message: 'Maximum charge must exactly equal the checked, rounded-up maximum of all billed dimensions and overhead.' });
  }
  if (contract.verifiedTermsHash !== paidEffectBillingTermsHash(contract)) {
    ctx.addIssue({ code: 'custom', path: ['verifiedTermsHash'], message: 'Verified billing terms hash does not match the frozen contract terms.' });
  }
});
export type VerifiedPaidEffectBillingContract = z.infer<typeof VerifiedPaidEffectBillingContractSchema>;

/** Hash only the immutable billing terms; verification evidence is separately hashed and attributed. */
export function paidEffectBillingTermsHash(terms: z.infer<typeof BillingContractTermsSchema>): string {
  return hashCanonicalJson({
    schemaVersion: terms.schemaVersion,
    contractId: terms.contractId,
    provider: terms.provider,
    model: terms.model,
    dimensions: terms.dimensions,
    attemptOverheadMicros: terms.attemptOverheadMicros,
    maxChargeMicros: terms.maxChargeMicros,
    authoritativeUsageSource: terms.authoritativeUsageSource,
  });
}



/** Integer-only ceil pricing. Missing dimensions, out-of-contract usage, or unsafe totals are rejected. */
export function calculatePaidEffectChargeMicros(
  contract: VerifiedPaidEffectBillingContract,
  units: Readonly<Record<string, number>>,
): number {
  const known = new Set(contract.dimensions.map((dimension) => dimension.name));
  for (const key of Object.keys(units)) if (!known.has(key)) throw new Error(`paid_effect_unknown_billing_dimension:${key}`);
  let total = BigInt(contract.attemptOverheadMicros);
  for (const dimension of contract.dimensions) {
    const quantity = units[dimension.name];
    if (quantity === undefined || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > dimension.maxUnits) {
      throw new Error(`paid_effect_usage_outside_contract:${dimension.name}`);
    }
    total += (BigInt(quantity) * BigInt(dimension.priceMicros) + BigInt(dimension.priceUnits) - 1n) / BigInt(dimension.priceUnits);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('paid_effect_cost_overflow');
  return Number(total);
}

export const PaidEffectAttemptDescriptorSchema = z.object({
  /** Reused for a replay of this one physical attempt; never reused for a retry. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  /** Stable logical identity paired across arms and output attempts. */
  logicalEffectId: IdentifierSchema,
  provider: IdentifierSchema,
  model: IdentifierSchema,
  effect: IdentifierSchema,
  billingContractId: IdentifierSchema,
  billingContractHash: DigestSchema,
  /** Enforced request dimensions, retained for audit; they never determine or lower the reserved maximum. */
  requestedUnits: z.record(z.string(), SafeNonnegativeIntegerSchema),
}).strict();
export type PaidEffectAttemptDescriptor = z.infer<typeof PaidEffectAttemptDescriptorSchema>;

export const PaidEffectAuthorizationSchema = z.object({
  schemaVersion: z.literal(1),
  authorizationId: IdentifierSchema,
  qualificationRunId: IdentifierSchema,
  approvedCeilingMicros: SafeNonnegativeIntegerSchema.max(MAX_PAID_EFFECT_CEILING_MICROS),
  arms: z.array(PaidEffectArmSchema).min(1).max(2),
  billingContracts: z.array(VerifiedPaidEffectBillingContractSchema).min(1).max(128),
}).strict().superRefine((authorization, ctx) => {
  const arms = new Set<string>();
  for (const [index, arm] of authorization.arms.entries()) {
    if (arms.has(arm)) ctx.addIssue({ code: 'custom', path: ['arms', index], message: 'Duplicate authorized arm.' });
    arms.add(arm);
  }
  const ids = new Set<string>();
  const providerModels = new Set<string>();
  for (const [index, contract] of authorization.billingContracts.entries()) {
    if (ids.has(contract.contractId)) ctx.addIssue({ code: 'custom', path: ['billingContracts', index, 'contractId'], message: 'Duplicate billing contract id.' });
    ids.add(contract.contractId);
    const providerModel = JSON.stringify([contract.provider, contract.model]);
    if (providerModels.has(providerModel)) ctx.addIssue({ code: 'custom', path: ['billingContracts', index], message: 'Multiple frozen billing contracts target the same provider/model.' });
    providerModels.add(providerModel);
  }
});
export type PaidEffectAuthorization = z.infer<typeof PaidEffectAuthorizationSchema>;

export const PaidEffectRawUsageSchema = z.record(z.string(), z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER));
export type PaidEffectRawUsage = z.infer<typeof PaidEffectRawUsageSchema>;

export const PaidEffectAuthoritativeSettlementSchema = z.object({
  kind: z.literal('authoritative'),
  evidenceRef: IdentifierSchema,
  source: z.enum(['provider_usage', 'invoice']),
  rawUsage: z.record(z.string(), SafeNonnegativeIntegerSchema),
  actualCostMicros: SafeNonnegativeIntegerSchema,
  estimatedCostMicros: SafeNonnegativeIntegerSchema.nullable().optional(),
}).strict();
export type PaidEffectAuthoritativeSettlement = z.infer<typeof PaidEffectAuthoritativeSettlementSchema>;

export const PaidEffectUnknownSettlementSchema = z.object({
  kind: z.literal('unknown'),
  rawUsage: PaidEffectRawUsageSchema.nullable().optional(),
  estimatedCostMicros: SafeNonnegativeIntegerSchema.nullable().optional(),
}).strict();
export type PaidEffectUnknownSettlement = z.infer<typeof PaidEffectUnknownSettlementSchema>;

export const PaidEffectSettlementSchema = z.discriminatedUnion('kind', [
  PaidEffectAuthoritativeSettlementSchema,
  PaidEffectUnknownSettlementSchema,
]);
export type PaidEffectSettlement = z.infer<typeof PaidEffectSettlementSchema>;
