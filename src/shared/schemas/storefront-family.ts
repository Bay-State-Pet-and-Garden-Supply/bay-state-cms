import { z } from 'zod';
import { FAMILY_VARIANT_RULE_VERSIONS } from '../../classification/family-variant-rule';

/**
 * Storefront-family plan wire schema (issues #368–373).
 *
 * Listing-owned versioned plan + human decisions. This file owns ONLY the
 * persisted shape; construction/validation lives in the classification
 * layer, persistence in the repository. Zod owns the wire shape so routes
 * and the change-set gate validate stored JSON deterministically.
 */

export const STOREFRONT_FAMILY_PLAN_VERSION = 'storefront-family-plan-v1' as const;

export const StorefrontFamilyPlanStatusSchema = z.enum([
  'proposed',
  'accepted',
  'revised',
  'rejected',
  'deferred',
  'stale',
  'applied',
]);
export type StorefrontFamilyPlanStatus = z.infer<typeof StorefrontFamilyPlanStatusSchema>;

const FamilyOriginHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const FamilyMemberOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('onboarding'),
    itemId: z.string().min(1),
    runId: z.string().min(1),
    runCurrentnessHash: FamilyOriginHashSchema,
    evidenceId: z.string().min(1),
    evidenceHash: FamilyOriginHashSchema,
  }).strict(),
  z.object({
    kind: z.literal('catalog'),
    approvedCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    productHash: FamilyOriginHashSchema,
    classificationRunId: z.string().min(1).nullable(),
    classificationHash: FamilyOriginHashSchema,
  }).strict(),
]);
export type FamilyMemberOrigin = z.infer<typeof FamilyMemberOriginSchema>;

const FamilyPlanMemberSchema = z
  .object({
    sku: z.string().min(1),
    /** Absent only in immutable history; new family execution requires a bound origin. */
    origin: FamilyMemberOriginSchema.optional(),
    comparableOunces: z.number().positive().nullable().default(null),
    sizeRaw: z.string().nullable().default(null),
    retailUnit: z.string().nullable().default(null),
    packCountDeclared: z.boolean().default(false),
    packCount: z.number().int().positive().nullable().default(null),
    reviewedTypeHash: z.string().min(1),
    evidenceHash: z.string().min(1),
    baseHash: z.string().nullable().default(null),
    stagedLabel: z.string().nullable().default(null),
    productTypeId: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    material: z.string().nullable().default(null),
    function: z.string().nullable().default(null),
    safetyDose: z.string().nullable().default(null),
    strength: z.string().nullable().default(null),
    fit: z.string().nullable().default(null),
    colorRaw: z.string().nullable().default(null),
    countRaw: z.string().nullable().default(null),
    countQuantity: z.number().int().positive().nullable().default(null),
  })
  .passthrough();

const Pf7ProposalSchema = z.object({
  sku: z.string().min(1),
  shortName: z.string().min(1),
  replaced: z.boolean().default(false),
});

const FamilyPlanDecisionSchema = z.object({
  actor: z.string().min(1),
  action: z.enum(['accept', 'revise', 'reject', 'defer']),
  at: z.string().min(1),
  note: z.string().nullable().default(null),
  mainOverrideSku: z.string().nullable().default(null),
});

const AdoptionOriginSchema = z.object({
  kind: z.literal('adopt_family'),
  nativeMain: z.string().min(1),
  nativeOrder: z.array(z.string().min(1)),
});

const RejectedFamilySchema = z.object({
  planId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  ruleVersion: z.string().min(1),
  memberSkus: z.array(z.string().min(1)),
});

const MemberNativeIdSchema = z.object({
  sku: z.string().min(1),
  name: z.string(),
  productId: z.string().nullable().default(null),
  productGuid: z.string().nullable().default(null),
});

const StagedFactorSchema = z.object({
  sku: z.string().min(1),
  brand: z.string().nullable().default(null),
  recipe: z.string().nullable().default(null),
  flavor: z.string().nullable().default(null),
  species: z.string().nullable().default(null),
  lifeStage: z.string().nullable().default(null),
  form: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  material: z.string().nullable().default(null),
  function: z.string().nullable().default(null),
  safetyDose: z.string().nullable().default(null),
  strength: z.string().nullable().default(null),
  fit: z.string().nullable().default(null),
}).passthrough();

const JoinOriginSchema = z.object({
  kind: z.literal('join_family'),
  familyPlanId: z.string().min(1),
  familyMain: z.string().min(1),
  familyOrder: z.array(z.string().min(1)),
  joinedSkus: z.array(z.string().min(1)),
  rejectedFamilies: z.array(RejectedFamilySchema).default([]),
  memberNativeIds: z.array(MemberNativeIdSchema).default([]),
  stagedFactors: z.array(StagedFactorSchema).optional(),
  stagedCatalogCommit: z.string().nullable().default(null),
  membershipProposalId: z.string().nullable().optional(),
  membershipProposalOutcome: z.string().nullable().optional(),
});
export type JoinOrigin = z.infer<typeof JoinOriginSchema>;

const MembershipChangeSchema = z.object({
  kind: z.enum(['remove_members', 'dissolve_family']),
  removedSkus: z.array(z.string().min(1)),
  remainingSkus: z.array(z.string().min(1)),
  at: z.string().min(1),
  actor: z.string().min(1),
});

export const StorefrontFamilyPlanSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  ruleVersion: z.enum(FAMILY_VARIANT_RULE_VERSIONS),
  planVersion: z.literal(STOREFRONT_FAMILY_PLAN_VERSION),
  status: StorefrontFamilyPlanStatusSchema,
  revision: z.number().int().nonnegative(),
  memberSkus: z.array(z.string().min(1)).min(1),
  members: z.array(FamilyPlanMemberSchema).min(1),
  mainSku: z.string().min(1),
  mainOverridden: z.boolean().default(false),
  pf7Proposals: z.array(Pf7ProposalSchema).min(1),
  ruleHash: z.string().min(1),
  ruleConfigHash: z.string().default(''),
  evidenceHash: z.string().min(1),
  baseHash: z.string(),
  readHash: z.string().min(1),
  writeHash: z.string().min(1),
  linkedChangeSetId: z.string().nullable().default(null),
  /** Set only after the complete approved Git commit exists, never on draft materialization. */
  appliedCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).nullable().optional(),
  /** Timestamp the plan reached applied for its complete approved commit. */
  appliedAt: z.string().nullable().optional(),
  decisions: z.array(FamilyPlanDecisionSchema).default([]),
  adoptionOrigin: AdoptionOriginSchema.optional(),
  joinOrigin: JoinOriginSchema.optional(),
  membershipChange: MembershipChangeSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type StorefrontFamilyPlan = z.infer<typeof StorefrontFamilyPlanSchema>;
