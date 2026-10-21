import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db/connection';
import { getCurrentWorkspace } from '../services/workspace-service';
import { readProductFile } from '../../git/workspace-files';
import {
  stageStorefrontFamilyPlan,
  stageNonFoodStorefrontFamilyPlan,
  decideStorefrontFamilyPlan,
  checkStorefrontFamilyFreshness,
  applyStorefrontFamilyPlan,
} from '../../classification/storefront-family-plan-service';
import {
  previewNativeAdoption,
  stageNativeAdoption,
  stageMembershipChange,
  applyAdoptedFamilyPlan,
} from '../../classification/storefront-family-adoption';
import {
  buildImportedJoinQuery,
  discoverJoinCandidates,
  resolveJoinCandidates,
  stageFamilyJoin,
  reviewFamilyJoin,
  checkFamilyJoinFreshness,
  decideFamilyJoin,
  applyFamilyJoin,
  type JoinMemberEvidence,
  type JoinCandidate,
  type CatalogJoinAnchor,
  type FamilyJoinReview,
} from '../../classification/storefront-family-join';
import {
  listStorefrontFamilyPlans,
  findStorefrontFamilyPlanById,
  listStorefrontFamilyPlansForJoinCandidates,
  type StorefrontFamilyPlanRow,
  parseStorefrontFamilyPlan,
} from '../../db/repositories/storefront-family-plan-repo';
import { listConflictingDraftChangeSets } from '../../db/repositories/change-set-repo';
import { findItemById } from '../../db/repositories/onboarding-item-repo';
import { listOutstandingDriftForSku } from '../../db/repositories/drift-repo';
import { StorefrontFamilyStagingInputSchema, NonFoodFamilyStagingInputSchema } from '../../validation/storefront-family-validation';
import { getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { getEffectivePrimaryProductTypeId } from '../../classification/assignment-projection';
import { computeReviewedAuthorityHash } from '../../classification/promotion-gate';
import { currentListingEvidenceHashes } from '../../classification/listing-evidence-currentness';
import { buildJoinCatalogAnchors } from '../storefront-family-join-anchors';
import { findFamilyOnboardingOrigin, listFamilyOnboardingOrigins } from '../../db/repositories/storefront-family-origin-repo';
import { resolveApprovedCatalogFamilyOrigin, validateFamilyMemberOrigin } from '../../classification/storefront-family-origin';
import type { FamilyMemberOrigin } from '../../shared/schemas/storefront-family';
import { FOOD_FAMILY_VARIANT_RULE_VERSION, resolveFamilyVariantRule, canonicalJoinVariantTuple, type FamilyVariantRuleVersion } from '../../classification/family-variant-rule';
import { comparisonHashForProduct } from '../../shopsite/catalog-comparison';
import { captureModelPolicySnapshot } from '../../onboarding/model-policy-snapshot';
import { createRun } from '../../db/repositories/classification-run-repo';
import type { Product } from '../../shared/types';
import type {
  FamilyMembershipProposalRecord,
} from '../../db/repositories/family-membership-proposal-repo';
import {
  createFamilyMembershipProposal,
  findFamilyMembershipProposalById,
  findReusableFamilyMembershipProposal,
  decideFamilyMembershipProposal,
  markProposalsStaleForSkus,
} from '../../db/repositories/family-membership-proposal-repo';
import { PROMPT_TEMPLATE_VERSIONS } from '../../classification/model-operation-registry';
import {
  FAMILY_MEMBERSHIP_ANCHOR_LIMIT,
  FAMILY_MEMBERSHIP_OPERATION,
  resolveProposalDisposition,
  checkTransitiveSafety,
  hashProposalEvidence,
  hashProposalAnchors,
  hashProposalRules,
  proposeFamilyMembership,
  type FamilyMembershipAnchorInput,
  type IncomingMembershipEvidence,
  type ProposalLiveBinding,
} from '../../classification/family-membership-proposal';
import { StorefrontFamilyPlanSchema, type StorefrontFamilyPlan } from '../../shared/schemas/storefront-family';
/**
 * N9: validate stored plan_json with the Zod schema. Stored JSON may be
 * corrupt or predate the schema — routes surface that as a 400 (re-stage),
 * never an uncaught 500. Returns the typed plan on success.
 */
function safeParsePlan(planJson: string): { ok: true; plan: StorefrontFamilyPlan } | { ok: false } {
  let raw: unknown;
  try {
    raw = JSON.parse(planJson);
  } catch {
    return { ok: false };
  }
  const parsed = StorefrontFamilyPlanSchema.safeParse(raw);
  return parsed.success ? { ok: true, plan: parsed.data } : { ok: false };
}

const route = new Hono();

const StageBodySchema = z.object({
  members: z.array(z.object({ sku: z.string().min(1), sourceItemId: z.string().min(1).optional(), sourceKind: z.enum(['onboarding', 'catalog']).optional() })).min(2),
  mainSku: z.string().min(1).optional(),
  actor: z.string().min(1),
});

const NonFoodStageBodySchema = z.object({
  ruleVersion: z.union([
    z.literal('non-food-size-family-variant-rule-v1'),
    z.literal('non-food-color-family-variant-rule-v1'),
    z.literal('non-food-count-family-variant-rule-v1'),
    z.literal('non-food-size-color-family-variant-rule-v1'),
    z.literal('non-food-size-count-family-variant-rule-v1'),
    z.literal('non-food-color-count-family-variant-rule-v1'),
    z.literal('non-food-size-color-count-family-variant-rule-v1'),
  ]),
  members: z.array(z.object({ sku: z.string().min(1), sourceItemId: z.string().min(1).optional(), sourceKind: z.enum(['onboarding', 'catalog']).optional() })).min(2),
  mainSku: z.string().min(1).optional(),
  actor: z.string().min(1),
});

const DecideBodySchema = z.object({
  // Client-supplied operator label (NOT authenticated identity): the single-
  // operator deployment has no auth principal, so the server records this
  // string verbatim on decisions/receipts/audit rows and MUST NOT treat it
  // as authority. Write gates below bind evidence server-side; the label
  // never selects evidence, overrides, or permissions.
  action: z.enum(['accept', 'revise', 'reject', 'defer']),
  membershipProposalId: z.string().min(1).optional(),
  actor: z.string().min(1),
  note: z.string().nullable().optional(),
  mainOverrideSku: z.string().min(1).nullable().optional(),
});

const ApplyBodySchema = z.object({
  actor: z.string().min(1),
});

const AdoptPreviewBodySchema = z.object({
  members: z.array(z.object({ sku: z.string().min(1) })).min(2),
});

const AdoptStageBodySchema = z.object({
  members: z.array(z.object({ sku: z.string().min(1) })).min(2),
  actor: z.string().min(1),
});

const MembershipChangeBodySchema = z.object({
  actor: z.string().min(1),
  removeSkus: z.array(z.string().min(1)).default([]),
  dissolve: z.boolean().default(false),
});

const JoinDiscoverBodySchema = z.object({
  sku: z.string().min(1),
  gtin: z.string().nullable().optional(),
  upc: z.string().nullable().optional(),
  mpn: z.string().nullable().optional(),
  maxCandidates: z.number().int().positive().max(64).optional(),
});

const JoinStageBodySchema = z.object({
  familyPlanId: z.string().min(1),
  joinedSkus: z.array(z.string().min(1)).min(1),
  actor: z.string().min(1),
  rejectedFamilies: z.array(z.object({
    planId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    ruleVersion: z.string().min(1),
    memberSkus: z.array(z.string().min(1)),
  })).optional(),
  pf7Replacements: z.array(z.object({
    sku: z.string().min(1),
    shortName: z.string().min(1),
  })).optional(),
  /** #371 accepted membership proposal id this join stages from. */
  membershipProposalId: z.string().min(1).optional(),
});
/**
 * GET /api/storefront-families - list versioned plans for the workspace.
 */
route.get('/storefront-families', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const rows = listStorefrontFamilyPlans(workspace.id);
  // N9: validate plan_json with the Zod schema — corrupt rows surface as a
  // 400-grade client error per row (never an uncaught 500).
  const plans = [];
  for (const row of rows) {
    const parsed = safeParsePlan(row.planJson);
    if (!parsed.ok) {
      return c.json({ error: `Family plan "${row.id}" is corrupt and unreadable; re-stage the family.` }, 400);
    }
    plans.push({ ...row, plan: parsed.plan });
  }
  return c.json({ plans });
});

/**
 * GET /api/storefront-families/:id - full plan with live bases for the
 * accept/revise/reject/defer review (members, main, labels, native diffs).
 */
route.get('/storefront-families/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const row = findStorefrontFamilyPlanById(c.req.param('id'));
  if (!row || row.workspaceId !== workspace.id) return c.json({ error: 'Family plan not found.' }, 404);
  const parsed = safeParsePlan(row.planJson);
  if (!parsed.ok) {
    return c.json({ error: 'Family plan is corrupt and unreadable; re-stage the family.' }, 400);
  }
  const plan = parsed.plan;
  const liveBySku: Record<string, Product | null> = {};
  for (const sku of plan.memberSkus) {
    try {
      liveBySku[sku] = readProductFile(workspace.workspacePath, sku);
    } catch {
      liveBySku[sku] = null;
    }
  }
  // #370: join plans attach the full join review (complete import+catalog
  // membership, origins, invariants/axes, labels, native refs, read deps,
  // exact write set) alongside the plan for accept/revise/reject/defer.
  // The staged-factor snapshot stamped at stage time binds first inside
  // review; current route-bound evidence fills next; live catalog fills
  // gaps — production never depends on the live-only fallback. Conflicting
  // drafts and open drift bind here so review blockers stay production-honest.
  if (plan.joinOrigin) {
    try {
      const currentEvidenceBySku = new Map<string, JoinMemberEvidence>();
      const missingEvidence: string[] = [];
      for (const sku of plan.memberSkus) {
        const record = readMemberRecord(workspace.workspacePath, sku);
        if (!record) {
          missingEvidence.push(sku);
          continue;
        }
        currentEvidenceBySku.set(sku, {
          sku,
          base: record.base,
          draftBase: record.draftBase,
          purchasable: record.purchasable,
          brand: record.brand,
          recipe: record.recipe,
          flavor: record.flavor,
          species: record.species,
          lifeStage: record.lifeStage,
          form: record.form,
          sizeRaw: record.sizeRaw ?? '',
          ounces: record.ounces,
          retailUnit: record.retailUnit,
          packCountDeclared: record.packCountDeclared,
          packCount: record.packCount,
          reviewedTypeHash: record.reviewedTypeHash,
          evidenceHash: record.evidenceHash,
          origin: plan.joinOrigin.joinedSkus.includes(sku) ? 'import' : 'catalog',
          productTypeId: record.reviewedProductTypeId,
          model: record.model,
          material: record.material,
          function: record.function,
          safetyDose: record.safetyDose,
          strength: record.strength,
          fit: record.fit,
          colorRaw: record.colorRaw,
          countRaw: record.countRaw,
          countQuantity: record.countQuantity,
        });
      }
      let conflictingDrafts: Array<{ changeSetId: string; sku: string; status: string }> = [];
      let conflictingDraftError: string | null = null;
      try {
        conflictingDrafts = listConflictingDraftChangeSets(workspace.id, plan.memberSkus, plan.linkedChangeSetId ?? '');
      } catch (err) {
        conflictingDraftError = err instanceof Error ? err.message : String(err);
      }
      const driftSkus: string[] = [];
      let driftError: string | null = null;
      for (const sku of plan.memberSkus) {
        try {
          if (listOutstandingDriftForSku(workspace.id, sku).length > 0) driftSkus.push(sku);
        } catch (err) {
          driftError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      const membershipProposal = buildJoinProposalSection({ workspaceId: workspace.id, joinOrigin: plan.joinOrigin! });
      let competingFamilies: Array<{ planId: string; memberSkus: string[] }> = [];
      let competingFamiliesError: string | null = null;
      try {
        competingFamilies = listStorefrontFamilyPlansForJoinCandidates(workspace.id, plan.joinOrigin.joinedSkus)
          .filter((row) => row.id !== plan.id && row.id !== plan.joinOrigin!.familyPlanId)
          .map((row) => {
            try {
              const peer = parseStorefrontFamilyPlan(row.planJson);
              return { planId: row.id, memberSkus: peer.memberSkus };
            } catch {
              return { planId: row.id, memberSkus: [] as string[] };
            }
          });
      } catch (err) {
        competingFamiliesError = err instanceof Error ? err.message : String(err);
      }
      const joinReview = reviewFamilyJoin({
        planId: plan.id,
        workspacePath: workspace.workspacePath,
        liveBySku: new Map(Object.entries(liveBySku)),
        currentEvidenceBySku,
        conflictingDrafts,
        conflictingDraftError,
        driftSkus,
        driftError,
        competingFamilies,
        competingFamiliesError,
        membershipProposal,
      });
      if (missingEvidence.length > 0) {
        joinReview.blockers.push(`No current eligible SKU-local evidence for SKU(s) (${missingEvidence.join(', ')}); missing current authority blocks review — re-resolve before accepting.`);
      }
      return c.json({ row, plan, liveBySku, joinReview });
    } catch (err) {
      return c.json({ row, plan, liveBySku, joinReviewError: err instanceof Error ? err.message : String(err) });
    }
  }
  // New-family review (non-join): serve staged-factor labels alongside the
  // plan so the UI renders real before/after PF7 diffs (staged originals vs
  // proposals) instead of current-live labels alone.
  const liveLabels: Record<string, string | null> = {};
  for (const sku of plan.memberSkus) {
    const live = (liveBySku[sku]?.customFields['ProductField7'] ?? '').trim();
    liveLabels[sku] = live.length > 0 ? live : null;
  }
  const stagedLabels: Record<string, string | null> = {};
  for (const member of plan.members) {
    const staged = (member.stagedLabel ?? '').trim();
    stagedLabels[member.sku] = staged.length > 0 ? staged : null;
  }
  return c.json({ row, plan, liveBySku, liveLabels, stagedLabels });
});

/**
 * POST /api/storefront-families/stage - stage a NEW family from eligible
 * SKU-local evidence. Evidence binds server-side per SKU (never trusted
 * from the client body, which carries only skus + optional main + actor).
 */
route.post('/storefront-families/stage', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = StageBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid staging input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const records = new Map<string, MemberRecord>();
  for (const member of parsedBody.data.members) {
    const record = readMemberRecord(workspace.workspacePath, member.sku, workspace.id, member.sourceItemId, member.sourceKind);
    if (!record) {
      const ambiguous = listFamilyOnboardingOrigins(workspace.id, member.sku).length > 1;
      return c.json({ error: ambiguous
        ? `Multiple onboarding items use SKU "${member.sku}". Choose the exact sourceItemId from the onboarding item review before staging this family.`
        : `No current eligible SKU-local evidence for SKU "${member.sku}".` }, 400);
    }
    // Food families require size evidence: fall back to the approved-catalog
    // weight when curation carries no explicit size (legacy food evidence).
    const sizeRaw = (record.sizeRaw ?? record.base?.core.weight?.trim()) || null;
    if (!sizeRaw) {
      return c.json({ error: `No current eligible SKU-local evidence for SKU "${member.sku}".` }, 400);
    }
    records.set(member.sku, { ...record, sizeRaw, ounces: record.ounces ?? parseOuncesLocal(sizeRaw) });
  }
  const stagedInput = StorefrontFamilyStagingInputSchema.safeParse({
    members: [...records.entries()].map(([sku, record]) => ({
      sku,
      origin: record.origin,
      purchasable: record.purchasable,
      brand: record.brand,
      recipe: record.recipe,
      flavor: record.flavor,
      species: record.species,
      lifeStage: record.lifeStage,
      form: record.form,
      sizeRaw: record.sizeRaw,
      ounces: record.ounces,
      retailUnit: record.retailUnit,
      packCountDeclared: record.packCountDeclared,
      packCount: record.packCount,
      reviewedTypeHash: record.reviewedTypeHash,
      evidenceHash: record.evidenceHash,
    })),
    mainSku: parsedBody.data.mainSku,
  });
  if (!stagedInput.success) {
    return c.json({ error: `Rule staging refused: ${stagedInput.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  try {
    const view = stageStorefrontFamilyPlan({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      input: stagedInput.data,
      actor: parsedBody.data.actor,
      curationBySku: new Map(
        [...records.entries()].map(([sku, record]) => [sku, { base: record.base, draftBase: record.draftBase }]),
      ),
    });
    // Any live proposal touching the staged members answers a superseded
    // membership question: mark stale (accepted/consumed history untouched).
    markProposalsStaleForSkus(workspace.id, [...records.keys()]);
    return c.json({ row: view.row, plan: view.plan }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/storefront-families/stage-non-food - stage a NEW non-food
 * family under an approved non-food rule (#372). Evidence binds
 * server-side per SKU (never trusted from the client body, which carries
 * only rule version + skus + optional main + actor).
 */
route.post('/storefront-families/stage-non-food', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = NonFoodStageBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid staging input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const records = new Map<string, MemberRecord>();
  for (const member of parsedBody.data.members) {
    const record = readMemberRecord(workspace.workspacePath, member.sku, workspace.id, member.sourceItemId, member.sourceKind);
    if (!record) {
      const ambiguous = listFamilyOnboardingOrigins(workspace.id, member.sku).length > 1;
      return c.json({ error: ambiguous
        ? `Multiple onboarding items use SKU "${member.sku}". Choose the exact sourceItemId from the onboarding item review before staging this family.`
        : `No current eligible SKU-local evidence for SKU "${member.sku}".` }, 400);
    }
    records.set(member.sku, record);
  }
  const stagedInput = NonFoodFamilyStagingInputSchema.safeParse({
    ruleVersion: parsedBody.data.ruleVersion,
    members: [...records.entries()].map(([sku, record]) => ({
      sku,
      origin: record.origin,
      purchasable: record.purchasable,
      brand: record.brand,
      model: record.model,
      material: record.material,
      function: record.function,
      safetyDose: record.safetyDose,
      strength: record.strength,
      fit: record.fit,
      sizeRaw: record.sizeRaw,
      colorRaw: record.colorRaw,
      countRaw: record.countRaw,
      countQuantity: record.countQuantity,
      ounces: record.ounces,
      retailUnit: record.retailUnit,
      packCountDeclared: record.packCountDeclared,
      packCount: record.packCount,
      reviewedTypeHash: record.reviewedTypeHash,
      reviewedProductTypeId: record.reviewedProductTypeId,
      evidenceHash: record.evidenceHash,
    })),
    mainSku: parsedBody.data.mainSku,
  });
  if (!stagedInput.success) {
    return c.json({ error: `Rule staging refused: ${stagedInput.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  try {
    const view = stageNonFoodStorefrontFamilyPlan({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      input: stagedInput.data,
      actor: parsedBody.data.actor,
      curationBySku: new Map(
        [...records.entries()].map(([sku, record]) => [sku, { base: record.base, draftBase: record.draftBase }]),
      ),
    });
    markProposalsStaleForSkus(workspace.id, [...records.keys()]);
    return c.json({ row: view.row, plan: view.plan }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
/**
 * POST /api/storefront-families/:id/decide - accept/revise/reject/defer with
 * human actor + note + optional pre-acceptance main override (real member).
 */
route.post('/storefront-families/:id/decide', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = DecideBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid decision input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  // B1: check row.workspaceId BEFORE decideStorefrontFamilyPlan mutates.
  // The service appends a decision + changes status/revision in the DB, so
  // the workspace gate must run first — mirroring the apply route. A forged
  // :id from another workspace gets a 404 with zero mutation.
  const existing = findStorefrontFamilyPlanById(c.req.param('id'));
  if (!existing || existing.workspaceId !== workspace.id) return c.json({ error: 'Family plan not found.' }, 404);
  try {
    // #370: join plans decide through the join decision path (the existing
    // main stands — main overrides are refused on joins, never applied).
    if (hasJoinOrigin(existing.planJson)) {
      if (parsedBody.data.mainOverrideSku) {
        return c.json({ error: 'Join plans preserve the existing main; main overrides are not allowed.' }, 400);
      }
      const joinDecidePlan = safeParsePlan(findStorefrontFamilyPlanById(c.req.param('id'))?.planJson ?? '');
      let joinFreshness: Parameters<typeof decideFamilyJoin>[0]['freshness'] | undefined;
      let joinConflicts: Array<{ changeSetId: string; sku: string; status: string }> | undefined;
      let joinDrift: string[] | undefined;
      if (joinDecidePlan.ok && parsedBody.data.action === 'accept') {
        const liveBySku = new Map<string, Product | null>();
        const typeBySku = new Map<string, string | null>();
        const evidenceBySku = new Map<string, string | null>();
        const ruleBySku = new Map<string, string | null>();
        const typeIdBySku = new Map<string, string | null>();
        const labelBySku = new Map<string, string | null>();
        for (const sku of joinDecidePlan.plan.memberSkus) {
          const record = readMemberRecord(workspace.workspacePath, sku);
          liveBySku.set(sku, record?.base ?? null);
          typeBySku.set(sku, record?.reviewedTypeHash ?? null);
          evidenceBySku.set(sku, record?.evidenceHash ?? null);
          typeIdBySku.set(sku, record?.reviewedProductTypeId ?? null);
          ruleBySku.set(sku, record?.reviewedProductTypeId ? (resolveFamilyVariantRule(record.reviewedProductTypeId)?.version ?? null) : null);
          const liveLabel = (record?.base?.customFields['ProductField7'] ?? '').trim();
          labelBySku.set(sku, liveLabel.length > 0 ? liveLabel : null);
        }
        joinFreshness = {
          liveBySku,
          currentTypeHashBySku: typeBySku,
          currentEvidenceHashBySku: evidenceBySku,
          currentRuleVersionBySku: ruleBySku,
          currentProductTypeIdBySku: typeIdBySku,
          currentLabelBySku: labelBySku,
        };
        try {
          joinConflicts = listConflictingDraftChangeSets(workspace.id, joinDecidePlan.plan.memberSkus, joinDecidePlan.plan.linkedChangeSetId ?? '');
        } catch {
          joinConflicts = undefined;
        }
        const driftHit: string[] = [];
        for (const sku of joinDecidePlan.plan.memberSkus) {
          try {
            if (listOutstandingDriftForSku(workspace.id, sku).length > 0) driftHit.push(sku);
          } catch {
            break;
          }
        }
        joinDrift = driftHit;
      }
      // #371: resolve the linked proposal server-side (joinOrigin is the
      // authority; the body id is a hint at most) and validate it BEFORE the
      // plan decision is written — a drifted proposal refuses with zero
      // mutation. Both writes then commit atomically inside one transaction.
      const linkedProposalId = joinDecidePlan.ok
        ? (joinDecidePlan.plan.joinOrigin?.membershipProposalId ?? parsedBody.data.membershipProposalId ?? null)
        : (parsedBody.data.membershipProposalId ?? null);
      if (parsedBody.data.membershipProposalId && linkedProposalId && parsedBody.data.membershipProposalId !== linkedProposalId) {
        return c.json({ error: `Membership proposal "${parsedBody.data.membershipProposalId}" does not match the join's linked proposal; re-stage the join.` }, 400);
      }
      let proposalCurrent: { evidenceHash: string; anchorHash: string; ruleHash: string; modelPolicyDigest: string } | undefined;
      if (linkedProposalId) {
        const proposalRow = findFamilyMembershipProposalById(linkedProposalId);
        if (!proposalRow || proposalRow.workspaceId !== workspace.id) {
          return c.json({ error: `Membership proposal "${linkedProposalId}" is unresolvable in this workspace.` }, 400);
        }
        if (proposalRow.status === 'stale') {
          return c.json({ error: 'family_membership_proposal_stale: re-propose against current evidence before deciding.' }, 400);
        }
        if (parsedBody.data.action === 'accept') {
          const recomputed = currentProposalHashes(workspace.workspacePath, workspace.id, proposalRow);
          if (!recomputed.ok) {
            return c.json({ error: recomputed.error }, 400);
          }
          proposalCurrent = recomputed.hashes;
        }
      }
      const db = getDb();
      let view: { row: StorefrontFamilyPlanRow; plan: StorefrontFamilyPlan };
      try {
        view = db.transaction(() => {
          const decided = decideFamilyJoin({
            planId: c.req.param('id'),
            actor: parsedBody.data.actor,
            action: parsedBody.data.action,
            note: parsedBody.data.note ?? null,
            ...(joinFreshness ? { freshness: joinFreshness } : {}),
            ...(joinConflicts ? { conflictingDrafts: joinConflicts } : {}),
            ...(joinDrift?.length ? { driftSkus: joinDrift } : {}),
          });
          if (linkedProposalId) {
            decideFamilyMembershipProposal({
              id: linkedProposalId,
              actor: parsedBody.data.actor,
              action: parsedBody.data.action,
              linkedPlanId: parsedBody.data.action === 'accept' ? c.req.param('id') : null,
              note: parsedBody.data.note ?? null,
              current: proposalCurrent,
            });
          }
          return decided;
        })();
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      // Any join decision supersedes other live proposals touching its members.
      if (joinDecidePlan.ok) {
        markProposalsStaleForSkus(workspace.id, [...joinDecidePlan.plan.memberSkus]);
      }
      return c.json({ row: view.row, plan: view.plan });
    }
    // Decide-time recheck (#369): bind current evidence/type/rule/label +
    // competing drafts + open drift so an accept on drifted/conflicting
    // state refuses closed here instead of at apply.
    const decidePlan = safeParsePlan(findStorefrontFamilyPlanById(c.req.param('id'))?.planJson ?? '');
    let decideFreshness: Parameters<typeof decideStorefrontFamilyPlan>[0]['freshness'] | undefined;
    let decideConflicts: Array<{ changeSetId: string; sku: string; status: string }> | undefined;
    let decideDrift: string[] | undefined;
    if (decidePlan.ok && parsedBody.data.action === 'accept') {
      // Removed-member freshness: the decision rechecks the full touched
      // set (current members + removed/remaining from the reviewed
      // membership revision), never just the narrowed memberSkus.
      const decideSkus = [...decidePlan.plan.memberSkus, ...(decidePlan.plan.membershipChange?.removedSkus ?? []), ...(decidePlan.plan.membershipChange?.remainingSkus ?? [])].sort();
      const liveBySku = new Map<string, Product | null>();
      const typeBySku = new Map<string, string | null>();
      const evidenceBySku = new Map<string, string | null>();
      const labelBySku = new Map<string, string | null>();
      const typeIdBySku = new Map<string, string | null>();
      const ruleBySku = new Map<string, string | null>();
      for (const sku of decideSkus) {
        const record = readMemberRecord(workspace.workspacePath, sku, workspace.id);
        liveBySku.set(sku, record?.base ?? null);
        typeBySku.set(sku, record?.reviewedTypeHash ?? null);
        evidenceBySku.set(sku, record?.evidenceHash ?? null);
        typeIdBySku.set(sku, record?.reviewedProductTypeId ?? null);
        // Approved food authority resolves explicitly (#368): food plans
        // carry no configured non-food Product Type, so the resolver miss
        // must not stale a food accept.
        const decideIsFood = decidePlan.plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
        ruleBySku.set(sku, decideIsFood ? decidePlan.plan.ruleVersion : (record?.reviewedProductTypeId ? (resolveFamilyVariantRule(record.reviewedProductTypeId, decidePlan.plan.ruleVersion)?.version ?? null) : null));
        const liveLabel = (record?.base?.customFields['ProductField7'] ?? '').trim();
        labelBySku.set(sku, liveLabel.length > 0 ? liveLabel : null);
      }
      decideFreshness = {
        liveBySku,
        currentTypeHashBySku: typeBySku,
        currentEvidenceHashBySku: evidenceBySku,
        currentRuleVersionBySku: ruleBySku,
        currentProductTypeIdBySku: typeIdBySku,
        currentLabelBySku: labelBySku,
      };
      try {
        decideConflicts = listConflictingDraftChangeSets(workspace.id, decideSkus, decidePlan.plan.linkedChangeSetId ?? '');
      } catch {
        decideConflicts = undefined;
      }
      const driftHit: string[] = [];
      for (const sku of decideSkus) {
        try {
          if (listOutstandingDriftForSku(workspace.id, sku).length > 0) driftHit.push(sku);
        } catch {
          break;
        }
      }
      decideDrift = driftHit;
    }
    const view = decideStorefrontFamilyPlan({
      planId: c.req.param('id'),
      actor: parsedBody.data.actor,
      action: parsedBody.data.action,
      note: parsedBody.data.note ?? null,
      mainOverrideSku: parsedBody.data.mainOverrideSku ?? null,
      ...(decideFreshness ? { freshness: decideFreshness } : {}),
      ...(decideConflicts ? { conflictingDrafts: decideConflicts } : {}),
      ...(decideDrift?.length ? { driftSkus: decideDrift } : {}),
    });
    // Any plan decision supersedes live proposals touching its members
    // (including removed members on removal revisions).
    if (decidePlan.ok) {
      markProposalsStaleForSkus(workspace.id, [...decidePlan.plan.memberSkus, ...(decidePlan.plan.membershipChange?.removedSkus ?? []), ...(decidePlan.plan.membershipChange?.remainingSkus ?? [])]);
    }
    return c.json({ row: view.row, plan: view.plan });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});


/**
 * POST /api/storefront-families/:id/apply - materialize an ACCEPTED plan
 * into managed drafts through the shared change-set path (complete
 * consistency group; #363 approval + #366 gates run at approve/export).
 */
route.post('/storefront-families/:id/apply', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = ApplyBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid apply input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const row = findStorefrontFamilyPlanById(c.req.param('id'));
  if (!row || row.workspaceId !== workspace.id) return c.json({ error: 'Family plan not found.' }, 404);
  const applyParsed = safeParsePlan(row.planJson);
  if (!applyParsed.ok) {
    return c.json({ error: 'Family plan is corrupt and unreadable; re-stage the family.' }, 400);
  }
  const plan = applyParsed.plan;
  const isAdoptionOrigin = hasAdoptionOrigin(row.planJson);
  // #369: removal revisions touch removed members too (explicit clears), so
  // the apply route loads removedSkus alongside current members — apply
  // otherwise derefs a missing draft when clearing removed members.
  const removedSkus = plan.membershipChange?.kind === 'remove_members' ? plan.membershipChange.removedSkus : [];
  const draftsBySku = new Map<string, Product>();
  const purchasableBySku = new Map<string, boolean>();
  const currentTypeHashBySku = new Map<string, string | null>();
  const currentEvidenceHashBySku = new Map<string, string | null>();
  const currentRuleVersionBySku = new Map<string, string | null>();
  const currentProductTypeIdBySku = new Map<string, string | null>();
  const currentLabelBySku = new Map<string, string | null>();
  for (const sku of [...plan.memberSkus, ...removedSkus]) {
    const record = readMemberRecord(workspace.workspacePath, sku);
    if (!record) return c.json({ error: `No current eligible evidence for SKU "${sku}"; the whole family blocks.` }, 400);
    draftsBySku.set(sku, record.draftBase);
    // Positive-only authority (#368): unknown curation authority never
    // passes as purchasable — the map carries explicit-true only, and the
    // service refuses a missing entry closed.
    if (record.purchasableKnown && record.purchasable) purchasableBySku.set(sku, true);
    currentTypeHashBySku.set(sku, record.reviewedTypeHash);
    currentEvidenceHashBySku.set(sku, record.evidenceHash);
    // Approved food authority resolves explicitly (#368): food plans carry
    // no configured non-food Product Type, so the non-food resolver returns
    // null for them. A food member's current rule authority is the approved
    // food rule (matching the staged rule version), never a resolver miss.
    const currentRuleIsFood = plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
    const resolvedRule = record.reviewedProductTypeId
      ? (resolveFamilyVariantRule(record.reviewedProductTypeId, plan.ruleVersion)?.version ?? null)
      : null;
    currentRuleVersionBySku.set(sku, currentRuleIsFood ? plan.ruleVersion : resolvedRule);
    currentProductTypeIdBySku.set(sku, record.reviewedProductTypeId);
    const liveLabel = (record.base?.customFields['ProductField7'] ?? '').trim();
    currentLabelBySku.set(sku, liveLabel.length > 0 ? liveLabel : null);
  }
  try {
    // #370: join plans materialize through applyFamilyJoin (create/update
    // identity from true bases, necessary writes only; full current-state
    // freshness gates inside apply with no opt-out).
    if (hasJoinOrigin(row.planJson)) {
      const joined = applyFamilyJoin({
        planId: plan.id,
        workspaceId: workspace.id,
        workspacePath: workspace.workspacePath,
        draftsBySku,
        actor: parsedBody.data.actor,
        purchasableBySku,
        currentTypeHashBySku,
        currentEvidenceHashBySku,
        currentRuleVersionBySku,
        currentProductTypeIdBySku,
        currentLabelBySku,
      });
      markProposalsStaleForSkus(workspace.id, [...plan.memberSkus]);
      return c.json({ changeSetId: joined.changeSetId, plan: joined.plan }, 201);
    }
    // Authority recheck before apply (#372): changes after acceptance
    // must not publish captured stale factors — refuse closed when the
    // current reviewed type/evidence/rule authority moved from staging.
    // Consequential staged factors bind too: a material/color/count/size,
    // retail-unit, pack, or projected-listing edit after staging changes the
    // staged-input projection (never the evidence-hash bundle alone), so
    // apply recomputes the full current staged-factor tuple and compares it
    // against the member snapshot — not just the current evidence hash.
    if (!hasJoinOrigin(row.planJson)) {
      for (const member of plan.members) {
        const currentType = currentTypeHashBySku.get(member.sku) ?? null;
        if (currentType !== member.reviewedTypeHash) {
          return c.json({ error: `family_apply_stale: SKU "${member.sku}" reviewed type authority changed after staging; re-stage before applying.` }, 400);
        }
        const currentEvidence = currentEvidenceHashBySku.get(member.sku) ?? null;
        if (currentEvidence !== member.evidenceHash) {
          return c.json({ error: `family_apply_stale: SKU "${member.sku}" listing evidence changed after staging; re-stage before applying.` }, 400);
        }
        if (member.productTypeId != null) {
          const currentTypeId = currentProductTypeIdBySku.get(member.sku) ?? null;
          if (currentTypeId !== member.productTypeId) {
            return c.json({ error: `family_apply_stale: SKU "${member.sku}" product type changed after staging; re-stage before applying.` }, 400);
          }
        }
        const hasRule = currentRuleVersionBySku.has(member.sku);
        const currentRule = currentRuleVersionBySku.get(member.sku) ?? null;
        if (!hasRule || currentRule === null || currentRule !== plan.ruleVersion) {
          return c.json({ error: `family_apply_stale: SKU "${member.sku}" rule changed after staging; re-stage before applying.` }, 400);
        }
        const factorDrift = currentStagedFactorProjection(workspace.workspacePath, workspace.id, member, plan.ruleVersion);
        if (!factorDrift.ok) {
          return c.json({ error: `family_apply_stale: SKU "${member.sku}" current staged-factor evidence unreadable after staging (${factorDrift.error}); re-stage before applying.` }, 400);
        }
        if (factorDrift.projection !== stagedFactorProjectionOf(member)) {
          return c.json({ error: `family_apply_stale: SKU "${member.sku}" staged factors or projected listing changed after staging; re-stage before applying.` }, 400);
        }
      }
    }
    const applied = isAdoptionOrigin
      ? applyAdoptedFamilyPlan({
          planId: plan.id,
          workspaceId: workspace.id,
          workspacePath: workspace.workspacePath,
          draftsBySku,
          actor: parsedBody.data.actor,
          purchasableBySku,
        })
      : applyStorefrontFamilyPlan({
          planId: plan.id,
          workspaceId: workspace.id,
          workspacePath: workspace.workspacePath,
          draftsBySku,
          actor: parsedBody.data.actor,
          purchasableBySku,
        });
    // Materialization changes every member base: supersede live proposals
    // touching members or explicitly removed SKUs.
    markProposalsStaleForSkus(workspace.id, [...plan.memberSkus, ...removedSkus]);
    return c.json({ changeSetId: applied.changeSetId, plan: applied.plan }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

const JoinProposeBodySchema = z.object({
  sku: z.string().min(1),
  gtin: z.string().nullable().optional(),
  upc: z.string().nullable().optional(),
  mpn: z.string().nullable().optional(),
  maxAnchors: z.number().int().positive().max(16).optional(),
});

/**
 * POST /api/storefront-families/join-discover - deterministic high-recall
 * candidate discovery for one imported SKU (#370): workspace/SKU identity,
 * configured type/rule/brand blocking, legitimate source identifiers, and
 * high-recall name/model evidence — no whole-catalog pairwise model scan,
 * no stem-only authority. Same-SKU collisions and duplicate tuples route
 * to explicit resolution, never a merge. Pure read-only: stages no plan.
 */
route.post('/storefront-families/join-discover', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = JoinDiscoverBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid join discovery input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const record = readMemberRecord(workspace.workspacePath, parsedBody.data.sku);
  if (!record) return c.json({ error: `No current eligible SKU-local evidence for SKU "${parsedBody.data.sku}".` }, 400);
  try {
    const query = buildImportedJoinQuery({
      sku: parsedBody.data.sku,
      gtin: parsedBody.data.gtin ?? null,
      upc: parsedBody.data.upc ?? null,
      mpn: parsedBody.data.mpn ?? null,
      brand: record.brand,
      reviewedProductTypeId: record.reviewedProductTypeId,
      ruleVersion: record.reviewedProductTypeId ? (resolveFamilyVariantRule(record.reviewedProductTypeId)?.version ?? null) : null,
      name: record.draftBase.core.name ?? null,
      model: record.model,
    });
    const built = buildJoinCatalogAnchors(workspace.workspacePath, workspace.id, {
      normalizedSku: query.normalizedSku, sourceIdentifiers: query.sourceIdentifiers, brand: query.brand,
      reviewedProductTypeId: query.reviewedProductTypeId, ruleVersion: query.ruleVersion, nameTokens: query.nameTokens,
    });
    const candidates = discoverJoinCandidates(query, built.anchors, { maxCandidates: parsedBody.data.maxCandidates ?? 16 });
    // Duplicate-tuple evidence (#370): the query SKU's own canonical
    // permitted-axis tuple plus each anchor's tuple from current SKU-local
    // evidence via the rule's canonical tuple (unit-aware, retail-unit
    // inclusive) — resolution flags true duplicates (refuse, never branch).
    const tupleKeyOf = (sku: string): string | null => {
      const target = sku === parsedBody.data.sku ? record : readMemberRecord(workspace.workspacePath, sku);
      if (!target) return null;
      const rule = target.reviewedProductTypeId ? resolveFamilyVariantRule(target.reviewedProductTypeId)?.version ?? null : null;
      return canonicalJoinVariantTuple(rule ?? 'food-family-variant-rule-v1', {
        sizeRaw: target.sizeRaw,
        ounces: target.ounces,
        retailUnit: target.retailUnit,
        colorRaw: target.colorRaw,
        countRaw: target.countRaw,
        countQuantity: target.countQuantity,
      });
    };
    const resolution = resolveJoinCandidates({ querySku: parsedBody.data.sku, candidates, anchorsBySku: built.anchorsBySku, tupleOf: tupleKeyOf });
    return c.json({ query, candidates: resolution.resolved, ambiguous: resolution.ambiguous, reasons: resolution.reasons });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
/**
 * Build the inspection DTO for a stored proposal row: the same shape the
 * GET inspection route returns (stale flags recomputed from status, never
 * from the bare repository record). join-propose and proposal-decide reuse
 * this so the client never renders a DTO without stale/staleReasons.
 */
function toProposalInspectionDto(row: FamilyMembershipProposalRecord): {
  id: string; sku: string; outcome: string; status: string; revision: number; linkedPlanId: string | null;
  judgments: Array<{ anchorSku: string; familyPlanId: string | null; outcome: string; reason: string }>;
  modelCallIds: string[]; stale: boolean; staleReasons: string[];
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
} {
  const stale = row.status === 'stale';
  const judgments = Array.isArray(row.judgments) ? row.judgments : [];
  const modelCallIds = Array.isArray(row.modelCallIds) ? row.modelCallIds : [];
  return {
    id: typeof row.id === 'string' ? row.id : '',
    sku: typeof row.sku === 'string' ? row.sku : '',
    outcome: typeof row.outcome === 'string' ? row.outcome : 'service',
    status: typeof row.status === 'string' ? row.status : 'unresolved',
    revision: typeof row.revision === 'number' ? row.revision : 0,
    linkedPlanId: row.linkedPlanId ?? null,
    judgments: judgments.map((j) => ({
      anchorSku: typeof j?.anchorSku === 'string' ? j.anchorSku : '',
      familyPlanId: j?.familyPlanId ?? null,
      outcome: typeof j?.outcome === 'string' ? j.outcome : 'service',
      reason: typeof j?.reason === 'string' ? j.reason : '',
    })),
    modelCallIds: modelCallIds.filter((id): id is string => typeof id === 'string'),
    stale,
    staleReasons: stale ? ['Proposal marked stale: member/rule/evidence/base changed after the proposal; re-propose before staging.'] : [],
    decidedBy: row.decidedBy ?? null,
    decidedAt: row.decidedAt ?? null,
    decisionNote: row.decisionNote ?? null,
  };
}

/**
 * POST /api/storefront-families/join-propose - TypeSafe ambiguous-family
 * membership proposal (#371). Freezes ≤16 eligible anchors from #370
 * equality-key discovery, asks one independent closed-set Relationship
 * Choice per anchor, and persists raw judgments + audit hashes. The model
 * proposes; existing deterministic gates dispose. No transitive union, no
 * merges, no writes. Identical-state reuse returns the stored row with no
 * new call; live refusal surfaces service/disabled explicitly.
 */
route.post('/storefront-families/join-propose', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = JoinProposeBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid proposal input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const record = readMemberRecord(workspace.workspacePath, parsedBody.data.sku);
  if (!record) return c.json({ error: `No current eligible SKU-local evidence for SKU "${parsedBody.data.sku}".` }, 400);
  try {
    const built = await proposeJoinMembership({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      sku: parsedBody.data.sku,
      gtin: parsedBody.data.gtin ?? null,
      upc: parsedBody.data.upc ?? null,
      mpn: parsedBody.data.mpn ?? null,
      maxAnchors: parsedBody.data.maxAnchors ?? null,
    });
    return c.json(
      { proposal: toProposalInspectionDto(built.proposal), reused: built.reused, disposition: built.disposition },
      built.reused ? 200 : 201,
    );
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

const ProposalDecideBodySchema = z.object({
  action: z.enum(['accept', 'revise', 'reject', 'defer']),
  actor: z.string().min(1),
  note: z.string().nullable().optional(),
});

/**
 * GET /api/storefront-families/proposals/:id - standalone TypeSafe proposal
 * inspection (#371). Truthful outcome/status/judgments plus the tracked
 * model call IDs; operators decide here before staging, or continue
 * standalone (revise/reject/defer leaves the listing releasable, never
 * auto-joins). Stale rows surface as stale with an explicit re-propose
 * reason, never a hidden inference.
 */
route.get('/storefront-families/proposals/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const row = findFamilyMembershipProposalById(c.req.param('id'));
  if (!row || row.workspaceId !== workspace.id) return c.json({ error: 'Membership proposal not found.' }, 404);
  return c.json({ proposal: toProposalInspectionDto(row) });
});

/**
 * POST /api/storefront-families/proposals/:id/decide - standalone proposal
 * accept/revise/reject/defer with human actor + note (#371). Accept marks
 * the proposal accepted for a later join stage (it never stages a plan by
 * itself); revise/reject/defer dispose it and leave standalone progress
 * untouched. Stale rows refuse (re-propose against current evidence); no
 * confidence-based automatic join.
 */
route.post('/storefront-families/proposals/:id/decide', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = ProposalDecideBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid proposal decision input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const existing = findFamilyMembershipProposalById(c.req.param('id'));
  if (!existing || existing.workspaceId !== workspace.id) return c.json({ error: 'Membership proposal not found.' }, 404);
  try {
    // Fail closed on drift: recompute the current frozen hashes for the
    // stored incoming SKU + request before accepting the stored judgments.
    const current = currentProposalHashes(workspace.workspacePath, workspace.id, existing);
    if (!current.ok) {
      return c.json({ error: current.error }, 400);
    }
    const decided = decideFamilyMembershipProposal({
      id: existing.id,
      actor: parsedBody.data.actor,
      action: parsedBody.data.action,
      note: parsedBody.data.note ?? null,
      current: current.hashes,
    });
    return c.json({ proposal: toProposalInspectionDto(decided) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});


/**
 * POST /api/storefront-families/join - stage an imported join: new size(s)
 * join a reviewed existing family without changing its main/IDs/URL/
 * members/order/labels unless an explicit reviewed diff authorizes it.
 * Same-SKU ambiguity and competing families refuse without explicit
 * resolution; missing authority stays unresolved (never fabricated).
 */
route.post('/storefront-families/join', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = JoinStageBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid join staging input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const staged = readJoinStageEvidence(workspace.workspacePath, parsedBody.data.familyPlanId, parsedBody.data.joinedSkus);
  if (!staged.ok) return c.json({ error: staged.error }, 400);
  // #371: an accepted membership proposal binds the disposed anchor; the
  // complete plan gates below still validate everything (proposal disposes,
  // never authorizes). Rejected/deferred (or no) proposals stage manually.
  let membershipProposal: { proposalId: string; outcome: string; familyPlanId: string } | null = null;
  if (parsedBody.data.membershipProposalId) {
    const proposalRow = findFamilyMembershipProposalById(parsedBody.data.membershipProposalId);
    if (!proposalRow || proposalRow.workspaceId !== workspace.id) {
      return c.json({ error: `Membership proposal "${parsedBody.data.membershipProposalId}" is unresolvable in this workspace.` }, 400);
    }
    if (proposalRow.status !== 'accepted') {
      return c.json({ error: `Membership proposal "${proposalRow.id.slice(0, 8)}" is "${proposalRow.status}"; accept the proposal before staging the join.` }, 400);
    }
    const disposition = resolveProposalDisposition(proposalRow.judgments);
    if (disposition.conflicts) {
      return c.json({ error: `family_membership_conflict: ${disposition.reason}` }, 400);
    }
    if (disposition.sameSku.length > 0) {
      return c.json({ error: `family_join_same_sku: proposal marks ${disposition.sameSku.map((j: { anchorSku: string }) => `"${j.anchorSku}"`).join(', ')} as the same sellable SKU; resolve identity/duplicates, never stage a family join.` }, 400);
    }
    const targets = disposition.positives.filter((j: { familyPlanId: string | null }) => j.familyPlanId === parsedBody.data.familyPlanId);
    if (targets.length === 0) {
      return c.json({ error: `family_membership_no_selection: accepted proposal selects no anchor in family "${parsedBody.data.familyPlanId.slice(0, 8)}"; revise the proposal or stage manually with explicit resolution.` }, 400);
    }
    // Linkage binds the incoming SKU: the staged joined SKUs must include
    // the proposal's incoming SKU, so an accepted proposal for SKU X can
    // never authorize a join of unrelated SKU Y.
    if (!parsedBody.data.joinedSkus.includes(proposalRow.sku)) {
      return c.json({ error: `family_membership_sku_mismatch: proposal "${proposalRow.id.slice(0, 8)}" covers incoming SKU "${proposalRow.sku}"; the staged join does not include it — re-stage with the matching SKU.` }, 400);
    }
    // Fail closed on drift: the accepted proposal's stored hashes must still
    // match the current anchors/evidence/policy/rule state before staging.
    const current = currentProposalHashes(workspace.workspacePath, workspace.id, proposalRow);
    if (!current.ok) {
      return c.json({ error: current.error }, 400);
    }
    const drifted =
      proposalRow.evidenceHash !== current.hashes.evidenceHash ||
      proposalRow.anchorHash !== current.hashes.anchorHash ||
      proposalRow.ruleHash !== current.hashes.ruleHash ||
      proposalRow.modelPolicyDigest !== current.hashes.modelPolicyDigest;
    if (drifted) {
      return c.json({ error: 'family_membership_proposal_stale: evidence/anchor/rule/policy drifted since the proposal; re-propose before staging.' }, 400);
    }
    // Transitive safety reads live hard-invariant evidence for the incoming
    // SKU plus every positive anchor: two positives in different families
    // that disagree on a shared invariant axis refuse, so A~B + B~C never
    // merges incompatible A/C endpoints. Missing evidence stays null
    // (never fabricated, never equal) — checkTransitiveSafety compares only
    // axes both endpoints actually carry. `positives` below carries only
    // anchor SKUs; the incoming SKU enters through `invariantOf`, which
    // resolves it (and any re-read anchor) from live stage evidence.
    const invariantOf = (anchorSku: string): Record<string, string | null> => {
      const incomingEvidence = anchorSku === proposalRow.sku ? staged.evidenceBySku.get(anchorSku) : undefined;
      if (incomingEvidence) return invariantRecordOf(incomingEvidence);
      const anchorEvidence = staged.evidenceBySku.get(anchorSku) ?? readMemberRecord(workspace.workspacePath, anchorSku);
      if (!anchorEvidence) return {};
      return invariantRecordOf(anchorEvidence);
    };
    const safety = checkTransitiveSafety({ positives: disposition.positives, invariantOf });
    if (!safety.safe) return c.json({ error: safety.reason ?? 'family_membership_transitive_refused' }, 400);
    membershipProposal = { proposalId: proposalRow.id, outcome: proposalRow.outcome, familyPlanId: parsedBody.data.familyPlanId };
  }
  try {
    const db = getDb();
    const view = db.transaction(() => {
      const stagedView = stageFamilyJoin({
        workspaceId: workspace.id,
        workspacePath: workspace.workspacePath,
        familyPlanId: parsedBody.data.familyPlanId,
        joinedSkus: parsedBody.data.joinedSkus,
        actor: parsedBody.data.actor,
        evidenceBySku: staged.evidenceBySku,
        rejectedFamilies: parsedBody.data.rejectedFamilies,
        pf7Replacements: parsedBody.data.pf7Replacements,
        membershipProposal,
      });
      if (membershipProposal) {
        decideFamilyMembershipProposal({
          id: membershipProposal.proposalId,
          actor: parsedBody.data.actor,
          action: 'accept',
          linkedPlanId: stagedView.plan.id,
          note: `staged join ${stagedView.plan.id.slice(0, 8)} extends family ${parsedBody.data.familyPlanId.slice(0, 8)}`,
        });
      }
      return stagedView;
    })();
    // Relevant mutation: the join staged against live evidence, so every
    // other live proposal touching the joined or member SKUs is stale. The
    // consumed proposal is already accepted above and is never marked.
    markProposalsStaleForSkus(workspace.id, [...staged.evidenceBySku.keys()]);
    return c.json({ row: view.row, plan: view.plan }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * Resolve full-group join staging evidence: the target family's existing
 * members (catalog origin, base = live approved) plus the imported joined
 * SKUs (import origin, base = null for genuinely new SKUs). Fail closed to
 * a 400-grade error string when any member lacks current eligible evidence.
 */
/**
 * Build the frozen anchor inputs for a proposal from live member evidence:
 * reviewed identity from real family members, SKU-local evidence per member,
 * hard-invariant values, and canonical variant tuples (+ product bases).
 * Fail closed with the required evidence missing (no discovery-metadata stand-ins).
 */
function buildProposalAnchorInputs(input: {
  workspacePath: string;
  candidates: JoinCandidate[];
  anchorsBySku: Map<string, CatalogJoinAnchor>;
  plansById: Map<string, StorefrontFamilyPlanRow>;
  queryRuleVersion: FamilyVariantRuleVersion | null;
}): FamilyMembershipAnchorInput[] {
  return input.candidates.map((candidate) => {
    const anchor = input.anchorsBySku.get(candidate.sku);
    const planRow = candidate.familyPlanId ? input.plansById.get(candidate.familyPlanId) : null;
    let plan: StorefrontFamilyPlan | null = null;
    if (planRow) {
      const parsed = safeParsePlan(planRow.planJson);
      if (parsed.ok) plan = parsed.plan;
    }
    const memberSkus = plan ? [...plan.memberSkus].sort() : anchor ? [anchor.sku] : [candidate.sku];
    const ruleVersion = (plan?.ruleVersion ?? anchor?.familyRuleVersion ?? input.queryRuleVersion ?? 'food-family-variant-rule-v1') as FamilyMembershipAnchorInput['ruleVersion'];
    const memberEvidence: Array<Record<string, unknown>> = [];
    for (const memberSku of memberSkus) {
      const memberRecord = readMemberRecord(input.workspacePath, memberSku);
      if (!memberRecord) throw new Error(`No current eligible SKU-local evidence for SKU "${memberSku}"; re-propose before deciding.`);
      const tuple = canonicalJoinVariantTuple(ruleVersion, {
        sizeRaw: memberRecord.sizeRaw, ounces: memberRecord.ounces, retailUnit: memberRecord.retailUnit,
        colorRaw: memberRecord.colorRaw, countRaw: memberRecord.countRaw, countQuantity: memberRecord.countQuantity,
      });
      memberEvidence.push({
        sku: memberSku,
        evidenceHash: memberRecord.evidenceHash,
        typeHash: memberRecord.reviewedTypeHash,
        ruleVersion: memberRecord.reviewedProductTypeId ? (resolveFamilyVariantRule(memberRecord.reviewedProductTypeId)?.version ?? null) : null,
        baseHash: memberRecord.base ? comparisonHashForProduct(memberRecord.base) : null,
        invariants: invariantRecordOf(memberRecord),
        tuple,
      });
    }
    const memberTuples = memberEvidence.map((m) => `${String(m['sku'])}:${String(m['tuple'] ?? 'unknown')}`).join(', ');
    const hardInvariants = memberEvidence.map((m) => {
      const invariants = m['invariants'] as Record<string, string | null>;
      const parts = Object.entries(invariants).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).sort().join(',');
      return `${String(m['sku'])}[${parts || 'unknown'}]`;
    }).join('; ');
    const reviewedIdentity = plan
      ? `family ${plan.id} · main ${plan.mainSku} · members ${memberSkus.join(', ')} · rule ${plan.ruleVersion}`
      : `catalog anchor ${candidate.sku} · brand ${(memberEvidence[0]?.['invariants'] as Record<string, string | null> | undefined)?.['brand'] ?? 'unknown'} · evidence ${(memberEvidence[0] as { evidenceHash?: string } | undefined)?.['evidenceHash'] ?? 'unknown'}`;
    return {
      anchor: anchor ?? {
        sku: candidate.sku, familyPlanId: candidate.familyPlanId, familyMain: candidate.familyMain,
        familyOrder: candidate.familyOrder, familyRuleVersion: candidate.familyRuleVersion,
        normalizedSku: candidate.sku.toLowerCase(), sourceIdentifiers: [], blockingBrand: '',
        blockingTypeId: '', blockingRule: '', nameStem: '', nameTokens: [], model: null,
        sameSkuConflict: false, duplicateTuple: false, origin: 'catalog_scan' as const,
      },
      candidate,
      reviewedIdentity,
      ruleVersion,
      ruleIdentity: plan ? `approved family ${plan.id}` : `catalog scan anchor ${candidate.sku}`,
      evidence: memberEvidence.map((m) => `${String(m['sku'])}:${String(m['evidenceHash'])}:${String(m['typeHash'])}`).slice(0, 15),
      hardInvariants,
      memberTuples,
      stateBinding: { anchorSku: candidate.sku, familyPlanId: candidate.familyPlanId, memberEvidence },
    };
  });
}

/**
 * One canonical live-state binding for a proposal: the incoming SKU's live
 * evidence, the full anchor member evidence, and the live revision of EVERY
 * family the proposal touches. Built once per live state and reused
 * UNCHANGED for creation hashing, dispatch hashing, reuse checks, and
 * freshness revalidation — identical live state always hashes identically.
 */
function buildProposalLiveBinding(input: {
  sku: string;
  record: MemberRecord;
  ruleVersion: FamilyVariantRuleVersion | null;
  candidates: JoinCandidate[];
  plansById: Map<string, StorefrontFamilyPlanRow>;
  anchorInputs: FamilyMembershipAnchorInput[];
}): {
  forEvidence: { evidenceHash: string; typeHash: string; ruleVersion: FamilyVariantRuleVersion | null; revision: number | null; revisions: Array<number | null>; memberEvidence: unknown };
  forAnchors: { sku: string; typeHash: string; ruleVersion: FamilyVariantRuleVersion | null; revision: number | null; revisions: Array<number | null> };
  forRules: { ruleVersion: FamilyVariantRuleVersion | null; revision: number | null; revisions: Array<number | null> };
  forDispatch: ProposalLiveBinding;
} {
  const revisionOf = (familyPlanId: string | null): number | null => {
    if (!familyPlanId) return null;
    const planRow = input.plansById.get(familyPlanId);
    return planRow ? planRow.revision : null;
  };
  const revisions = input.candidates.map((candidate) => revisionOf(candidate.familyPlanId));
  const primaryRevision = input.candidates.length > 0 ? revisions[0] ?? null : null;
  const memberEvidence: unknown[] = input.anchorInputs.flatMap((a) => {
    const binding: { memberEvidence?: unknown } | null =
      typeof a.stateBinding === 'object' && a.stateBinding !== null ? (a.stateBinding as { memberEvidence?: unknown }) : null;
    return Array.isArray(binding?.memberEvidence) ? binding.memberEvidence : [];
  });
  return {
    forEvidence: { evidenceHash: input.record.evidenceHash, typeHash: input.record.reviewedTypeHash, ruleVersion: input.ruleVersion, revision: primaryRevision, revisions, memberEvidence },
    forAnchors: { sku: input.sku, typeHash: input.record.reviewedTypeHash, ruleVersion: input.ruleVersion, revision: primaryRevision, revisions },
    forRules: { ruleVersion: input.ruleVersion, revision: primaryRevision, revisions },
    forDispatch: {
      sku: input.sku, evidenceHash: input.record.evidenceHash, typeHash: input.record.reviewedTypeHash,
      ruleVersion: input.ruleVersion, memberEvidence, revisions, primaryRevision,
    },
  };
}

/**
 * Incoming SKU's reviewed identity/evidence/invariants/tuple for the model
 * request: the actual live SKU-local evidence (never anchor-derived), so
 * the model can distinguish a true size variant from a same-brand/type
 * product with conflicting recipe/form/life-stage.
 */
function buildIncomingMembershipState(input: {
  sku: string;
  record: MemberRecord;
  ruleVersion: FamilyVariantRuleVersion | null;
}): IncomingMembershipEvidence {
  const invariants = invariantRecordOf(input.record);
  const tuple = input.ruleVersion
    ? (canonicalJoinVariantTuple(input.ruleVersion, {
      sizeRaw: input.record.sizeRaw, ounces: input.record.ounces, retailUnit: input.record.retailUnit,
      colorRaw: input.record.colorRaw, countRaw: input.record.countRaw, countQuantity: input.record.countQuantity,
    }) ?? 'unknown')
    : 'unknown';
  return {
    sku: input.sku,
    evidenceHash: input.record.evidenceHash,
    typeHash: input.record.reviewedTypeHash,
    ruleVersion: input.ruleVersion,
    brand: input.record.brand,
    recipe: input.record.recipe,
    flavor: input.record.flavor,
    species: input.record.species,
    lifeStage: input.record.lifeStage,
    form: input.record.form,
    model: input.record.model,
    material: input.record.material,
    function: input.record.function,
    safetyDose: input.record.safetyDose,
    strength: input.record.strength,
    fit: input.record.fit,
    sizeRaw: input.record.sizeRaw,
    ounces: input.record.ounces,
    retailUnit: input.record.retailUnit,
    colorRaw: input.record.colorRaw,
    countRaw: input.record.countRaw,
    countQuantity: input.record.countQuantity,
    invariants,
    tuple,
  };
}


/**
 * #371 seam: freeze ≤16 eligible anchors from #370 discovery, run one
 * logical TypeSafe request (independent closed-set Choice per anchor), and
 * persist raw judgments + audit hashes. Returns the stored row; identical
 * relevant state reuses the stored row with no new call.
 */
async function proposeJoinMembership(input: {
  workspaceId: string;
  workspacePath: string;
  sku: string;
  gtin: string | null;
  upc: string | null;
  mpn: string | null;
  maxAnchors?: number | null;
}): Promise<{ proposal: FamilyMembershipProposalRecord; reused: boolean; disposition: { positives: number; conflicts: boolean; reason: string | null } }> {
  const record = readMemberRecord(input.workspacePath, input.sku);
  if (!record) throw new Error(`No current eligible SKU-local evidence for SKU "${input.sku}"; re-propose once reviewed type/evidence exist.`);
  if (!record.evidenceHash || !record.reviewedTypeHash || !record.reviewedProductTypeId) {
    throw new Error(`No current eligible SKU-local evidence for SKU "${input.sku}"; re-propose once reviewed type/evidence exist.`);
  }
  const incomingRuleVersion = record.reviewedProductTypeId ? (resolveFamilyVariantRule(record.reviewedProductTypeId)?.version ?? null) : null;
  if (!incomingRuleVersion) {
    throw new Error(`No approved family rule for SKU "${input.sku}"; re-propose once a rule governs its reviewed type.`);
  }
  const query = buildImportedJoinQuery({
    sku: input.sku,
    gtin: input.gtin, upc: input.upc, mpn: input.mpn,
    brand: record.brand,
    reviewedProductTypeId: record.reviewedProductTypeId,
    ruleVersion: incomingRuleVersion,
    name: record.draftBase.core.name ?? null,
    model: record.model,
  });
  // No silent clip: discover one past the applicable bound so an over-wide
  // eligible set surfaces as explicit overflow instead of prefix
  // adjudication. An explicit operator maxAnchors (≤16) narrows below the
  // anchor bound (fewer questions per request); narrowing above the anchor
  // bound is forbidden by the body schema.
  const built = buildJoinCatalogAnchors(input.workspacePath, input.workspaceId, {
    normalizedSku: query.normalizedSku, sourceIdentifiers: query.sourceIdentifiers, brand: query.brand,
    reviewedProductTypeId: query.reviewedProductTypeId, ruleVersion: query.ruleVersion, nameTokens: query.nameTokens,
  });
  const requestedCap = input.maxAnchors ?? null;
  const detectCap = requestedCap == null ? FAMILY_MEMBERSHIP_ANCHOR_LIMIT + 1 : requestedCap + 1;
  const discovered = discoverJoinCandidates(query, built.anchors, { maxCandidates: detectCap });
  if (discovered.length > FAMILY_MEMBERSHIP_ANCHOR_LIMIT) {
    throw new Error(
      `family_membership_overflow: ${discovered.length}+ eligible anchors exceed the ${FAMILY_MEMBERSHIP_ANCHOR_LIMIT}-anchor bound; narrow discovery or reject explicitly — first-N clipping is forbidden.`,
    );
  }
  if (requestedCap != null && discovered.length > requestedCap) {
    throw new Error(
      `family_membership_overflow: ${discovered.length}+ eligible anchors exceed the requested cap of ${requestedCap}; narrow discovery or reject explicitly — first-N clipping is forbidden.`,
    );
  }
  const candidates = requestedCap == null ? discovered : discovered.slice(0, requestedCap);
  const plansById = new Map(listStorefrontFamilyPlans(input.workspaceId).map((row) => [row.id, row]));
  const anchorInputs = buildProposalAnchorInputs({
    workspacePath: input.workspacePath, candidates, anchorsBySku: built.anchorsBySku, plansById,
    queryRuleVersion: query.ruleVersion,
  });
  const binding = buildProposalLiveBinding({
    sku: input.sku, record, ruleVersion: incomingRuleVersion,
    candidates, plansById, anchorInputs,
  });
  // Identical-state reuse: same anchors + evidence + policy + rule state ⇒
  // stored row, no new call. The rule hash (ruleVersions + prompt template)
  // binds reuse so a rule change over identical anchors re-proposes.
  const snapshot = captureModelPolicySnapshot(input.workspacePath);
  const policyView = snapshot.state === 'configured' ? snapshot.view : null;
  const policyDigest = policyView?.policyDigest ?? 'policy_unavailable';
  const evidenceHash = anchorInputs.length > 0 ? hashProposalEvidence(anchorInputs, binding.forEvidence) : 'empty';
  const anchorHash = anchorInputs.length > 0 ? hashProposalAnchors(anchorInputs, binding.forAnchors) : 'empty';
  const ruleHash = anchorInputs.length > 0 ? hashProposalRules(anchorInputs, policyDigest, binding.forRules) : 'empty';
  const reusable = findReusableFamilyMembershipProposal({
    workspaceId: input.workspaceId, sku: input.sku, evidenceHash, anchorHash, modelPolicyDigest: policyDigest, ruleHash,
  });
  if (reusable) {
    const disposition = resolveProposalDisposition(reusable.judgments);
    return { proposal: reusable, reused: true, disposition: { positives: disposition.positives.length, conflicts: disposition.conflicts, reason: disposition.reason } };
  }
  const incomingState = buildIncomingMembershipState({ sku: input.sku, record, ruleVersion: incomingRuleVersion });
  const run = createRun(input.workspaceId, input.sku, null, null);
  const result = await proposeFamilyMembership({
    sku: input.sku, query, anchors: anchorInputs, runId: run.id, modelPolicy: policyView,
    liveBinding: binding.forDispatch, incomingState,
  });
  const stored = createFamilyMembershipProposal({
    workspaceId: input.workspaceId, sku: input.sku, outcome: result.outcome,
    judgments: result.judgments, rawJudgments: result.rawJudgments, modelCallIds: result.modelCallIds,
    evidenceHash: result.evidenceHash, ruleHash: result.ruleHash, anchorHash: result.anchorHash,
    modelPolicyDigest: result.modelPolicyDigest, ruleVersion: result.ruleVersion,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION],
    request: { gtin: input.gtin, upc: input.upc, mpn: input.mpn, maxAnchors: input.maxAnchors },
  });
  const disposition = resolveProposalDisposition(result.judgments);
  return { proposal: stored, reused: false, disposition: { positives: disposition.positives.length, conflicts: disposition.conflicts, reason: disposition.reason } };
}

/**
 * Recompute the current frozen hashes for a stored proposal's incoming SKU +
 * originating request: fail closed when the SKU lost eligible evidence, the
 * anchor freeze overflows, the policy snapshot is unreadable, or the stored
 * request drifted (gtin/upc/mpn/maxAnchors mismatch). Decide/stage callers
 * compare these against the stored hashes and refuse on drift.
 */
function currentProposalHashes(
  workspacePath: string,
  workspaceId: string,
  row: FamilyMembershipProposalRecord,
): { ok: true; hashes: { evidenceHash: string; anchorHash: string; ruleHash: string; modelPolicyDigest: string } } | { ok: false; error: string } {
  const record = readMemberRecord(workspacePath, row.sku);
  if (!record) return { ok: false, error: `No current eligible SKU-local evidence for SKU "${row.sku}"; re-propose before deciding.` };
  if (!record.evidenceHash || !record.reviewedTypeHash || !record.reviewedProductTypeId) {
    return { ok: false, error: `No current eligible SKU-local evidence for SKU "${row.sku}"; re-propose once reviewed type/evidence exist.` };
  }
  const incomingRuleVersion = record.reviewedProductTypeId ? (resolveFamilyVariantRule(record.reviewedProductTypeId)?.version ?? null) : null;
  if (!incomingRuleVersion) {
    return { ok: false, error: `No approved family rule for SKU "${row.sku}"; re-propose once a rule governs its reviewed type.` };
  }
  const query = buildImportedJoinQuery({
    sku: row.sku,
    gtin: row.request.gtin, upc: row.request.upc, mpn: row.request.mpn,
    brand: record.brand,
    reviewedProductTypeId: record.reviewedProductTypeId,
    ruleVersion: incomingRuleVersion,
    name: record.draftBase.core.name ?? null,
    model: record.model,
  });
  const built = buildJoinCatalogAnchors(workspacePath, workspaceId, {
    normalizedSku: query.normalizedSku, sourceIdentifiers: query.sourceIdentifiers, brand: query.brand,
    reviewedProductTypeId: query.reviewedProductTypeId, ruleVersion: query.ruleVersion, nameTokens: query.nameTokens,
  });
  // Same construction as creation: discover one past the applicable bound
  // so over-wide eligible sets refuse explicitly instead of silently
  // truncating to a stale-prefix match.
  const revalidationCap = row.request.maxAnchors ?? null;
  const revalidationDetectCap = revalidationCap == null ? FAMILY_MEMBERSHIP_ANCHOR_LIMIT + 1 : revalidationCap + 1;
  const revalidationDiscovered = discoverJoinCandidates(query, built.anchors, { maxCandidates: revalidationDetectCap });
  if (revalidationDiscovered.length > FAMILY_MEMBERSHIP_ANCHOR_LIMIT) {
    return { ok: false, error: `family_membership_overflow: ${revalidationDiscovered.length}+ eligible anchors exceed the ${FAMILY_MEMBERSHIP_ANCHOR_LIMIT}-anchor bound; re-propose before deciding.` };
  }
  if (revalidationCap != null && revalidationDiscovered.length > revalidationCap) {
    return { ok: false, error: `family_membership_overflow: ${revalidationDiscovered.length}+ eligible anchors exceed the requested cap of ${revalidationCap}; re-propose before deciding.` };
  }
  const candidates = revalidationCap == null ? revalidationDiscovered : revalidationDiscovered.slice(0, revalidationCap);
  const plansById = new Map(listStorefrontFamilyPlans(workspaceId).map((planRow) => [planRow.id, planRow]));
  let anchorInputs: FamilyMembershipAnchorInput[];
  try {
    anchorInputs = buildProposalAnchorInputs({
      workspacePath, candidates, anchorsBySku: built.anchorsBySku, plansById,
      queryRuleVersion: query.ruleVersion,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Canonical live-state binding: the same construction as creation, so
  // identical live state hashes identically and fresh proposals validate.
  const binding = buildProposalLiveBinding({
    sku: row.sku, record, ruleVersion: incomingRuleVersion,
    candidates, plansById, anchorInputs,
  });
  if (anchorInputs.length === 0) {
    return row.evidenceHash === 'empty' && row.anchorHash === 'empty'
      ? {
        ok: true,
        hashes: {
          evidenceHash: row.evidenceHash, anchorHash: row.anchorHash,
          ruleHash: row.ruleHash, modelPolicyDigest: row.modelPolicyDigest,
        },
      }
      : { ok: false, error: `Anchor discovery for SKU "${row.sku}" no longer matches the proposal; re-propose before deciding.` };
  }
  const snapshot = captureModelPolicySnapshot(workspacePath);
  const policyView = snapshot.state === 'configured' ? snapshot.view : null;
  const modelPolicyDigest = policyView?.policyDigest ?? 'policy_unavailable';
  return {
    ok: true,
    hashes: {
      evidenceHash: hashProposalEvidence(anchorInputs, binding.forEvidence),
      anchorHash: hashProposalAnchors(anchorInputs, binding.forAnchors),
      ruleHash: hashProposalRules(anchorInputs, modelPolicyDigest, binding.forRules),
      modelPolicyDigest,
    },
  };
}

/**
 * #371 review binder: truthful proposal section (selected/negative/no-fit/
 * insufficient/overflow/service/disabled/stale) for the existing join
 * review. Null when the join staged manually with no proposal.
 */
function buildJoinProposalSection(input: {
  workspaceId: string;
  joinOrigin: NonNullable<StorefrontFamilyPlan['joinOrigin']>;
}): FamilyJoinReview['membershipProposal'] {
  const proposalId = input.joinOrigin.membershipProposalId ?? null;
  if (!proposalId) return null;
  const row = findFamilyMembershipProposalById(proposalId);
  if (!row || row.workspaceId !== input.workspaceId) return null;
  const stale = row.status === 'stale';
  const judgments = Array.isArray(row.judgments) ? row.judgments : [];
  const modelCallIds = Array.isArray(row.modelCallIds) ? row.modelCallIds : [];
  return {
    proposalId: typeof row.id === 'string' ? row.id : '',
    outcome: typeof row.outcome === 'string' ? row.outcome : 'service',
    status: typeof row.status === 'string' ? row.status : 'unresolved',
    judgments: judgments.map((j) => ({
      anchorSku: typeof j?.anchorSku === 'string' ? j.anchorSku : '',
      familyPlanId: j?.familyPlanId ?? null,
      outcome: typeof j?.outcome === 'string' ? j.outcome : 'service',
      reason: typeof j?.reason === 'string' ? j.reason : '',
    })),
    modelCallIds: modelCallIds.filter((id): id is string => typeof id === 'string'),
    stale,
    staleReasons: stale ? ['Proposal marked stale: member/rule/evidence/base changed after the proposal; re-propose before staging.'] : [],
  };
}

/**
 * Live-base-derived evidence fallback (#372): synthesize SKU-local evidence
 * for an existing catalog member from its approved base when curation
 * evidence is unavailable. Identity threads from the base's custom fields +
 * staged raw attributes; reviewed hashes thread from stamped raw attributes;
 * the base comparison hash is NOT a substitute evidence hash (empty marks it
 * unresolved downstream — the group rule still refuses without reviewed
 * type authority). Null when no approved base exists (genuinely-new imports
 * never synthesize — they refuse closed without curation evidence).
 */
function baseDerivedEvidence(workspacePath: string, sku: string): MemberRecord | null {
  let base: Product | null;
  try {
    base = readProductFile(workspacePath, sku);
  } catch {
    return null;
  }
  if (!base) return null;
  const attrs = base.shopsite.preserved.rawAttributes ?? {};
  const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
  const reviewedTypeHash = textOf(attrs['reviewedTypeHash']);
  if (!reviewedTypeHash) return null;
  const cf = base.customFields ?? {};
  const weight = (base.core.weight ?? '').trim() || null;
  const origin = getCurrentWorkspace()?.id
    ? resolveApprovedCatalogFamilyOrigin({ workspaceId: getCurrentWorkspace()!.id, workspacePath, sku })?.origin
    : undefined;
  if (!origin) return null;
  return {
    origin,
    base,
    draftBase: base,
    purchasable: true,
    // Live-base fallback carries no curation flag: authority is unknown, so
    // apply/approval (which require positive current authority) refuse until
    // real curation evidence resolves. Staging paths that accept this
    // fallback keep their existing behavior.
    purchasableKnown: false,
    brand: textOf(cf['ProductField16']),
    recipe: textOf(cf['ProductField24']),
    flavor: textOf(cf['ProductField23']),
    species: textOf(cf['ProductField17']),
    lifeStage: textOf(cf['ProductField18']),
    form: textOf(cf['ProductField22']),
    sizeRaw: weight,
    ounces: weight ? parseOuncesLocal(weight) : null,
    retailUnit: textOf(attrs['retailUnit']),
    packCountDeclared: attrs['packCountDeclared'] === 'true',
    packCount: typeof attrs['packCount'] === 'string' && /^\d+$/.test(attrs['packCount'].trim()) ? Number(attrs['packCount'].trim()) : null,
    reviewedTypeHash,
    reviewedProductTypeId: textOf(attrs['nonFoodProductTypeId']),
    evidenceHash: '',
    model: textOf(attrs['nonFoodModel']),
    material: textOf(attrs['nonFoodMaterial']),
    function: textOf(attrs['nonFoodFunction']),
    safetyDose: textOf(attrs['nonFoodSafetyDose']),
    strength: textOf(attrs['nonFoodStrength']),
    fit: textOf(attrs['nonFoodFit']),
    colorRaw: textOf(attrs['nonFoodColorRaw']),
    countRaw: textOf(attrs['nonFoodCountRaw']),
    countQuantity: typeof attrs['nonFoodCountQuantity'] === 'string' && /^\d+$/.test(attrs['nonFoodCountQuantity'].trim()) ? Number(attrs['nonFoodCountQuantity'].trim()) : null,
  };
}

function readJoinStageEvidence(
  workspacePath: string,
  familyPlanId: string,
  joinedSkus: string[],
): { ok: true; evidenceBySku: Map<string, JoinMemberEvidence> } | { ok: false; error: string } {
  const familyRow = findStorefrontFamilyPlanById(familyPlanId);
  if (!familyRow) return { ok: false, error: `No reviewed family plan "${familyPlanId}" in this workspace.` };
  const parsed = safeParsePlan(familyRow.planJson);
  if (!parsed.ok) return { ok: false, error: `Target family "${familyPlanId}" is corrupt and unreadable; re-stage before joining.` };
  const evidenceBySku = new Map<string, JoinMemberEvidence>();
  for (const sku of [...parsed.plan.memberSkus, ...joinedSkus]) {
    const isJoined = joinedSkus.includes(sku);
    // SKU fallback instead of refusal (#372): an existing catalog member
    // whose curation evidence aged out falls back to live-base-derived
    // evidence rather than refusing the whole join. Joined imports have no
    // base to fall back to — they still refuse closed.
    const record = readMemberRecord(workspacePath, sku) ?? (isJoined ? null : baseDerivedEvidence(workspacePath, sku));
    if (!record) return { ok: false, error: `No current eligible SKU-local evidence for SKU "${sku}"; the whole join blocks.` };
    const sizeRaw = (record.sizeRaw ?? record.base?.core.weight?.trim()) || null;
    if (!sizeRaw) return { ok: false, error: `No size evidence for SKU "${sku}"; joins require verified sizes.` };
    // True bases thread through for every member (joined or existing) and
    // are NEVER nulled downstream (joined-SKU-with-base immutability): a
    // joined SKU WITH an approved base is same-SKU ambiguity and the staging
    // guard (`family_join_same_sku`) fires here, not just at apply time.
    // Origin discipline lives in `origin` ('import' vs 'catalog'), never in
    // nulled bases — staging, review membership, and write-set identity all
    // read origin/base independently.
    evidenceBySku.set(sku, {
      sku,
      base: record.base,
      draftBase: record.draftBase,
      purchasable: record.purchasable,
      brand: record.brand,
      recipe: record.recipe,
      flavor: record.flavor,
      species: record.species,
      lifeStage: record.lifeStage,
      form: record.form,
      sizeRaw,
      ounces: record.ounces ?? parseOuncesLocal(sizeRaw),
      retailUnit: record.retailUnit,
      packCount: record.packCount,
      packCountDeclared: record.packCountDeclared,
      reviewedTypeHash: record.reviewedTypeHash,
      evidenceHash: record.evidenceHash,
      productTypeId: record.reviewedProductTypeId,
      origin: isJoined ? 'import' : 'catalog',
      model: record.model,
      material: record.material,
      function: record.function,
      safetyDose: record.safetyDose,
      strength: record.strength,
      fit: record.fit,
      colorRaw: record.colorRaw,
      countRaw: record.countRaw,
      countQuantity: record.countQuantity,
    });
  }
  return { ok: true, evidenceBySku };
}

/**
 * POST /api/storefront-families/adopt-preview - inspect an existing native
 * order, supported metadata, invariant evidence. Pure read-only: stages no
 * plan, mutates nothing. Unsupported/ambiguous natives return blockers with
 * a preservation reason instead of dropping data.
 */
route.post('/storefront-families/adopt-preview', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = AdoptPreviewBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid adoption preview input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const skus = parsedBody.data.members.map((m) => m.sku);
  const liveBySku = new Map<string, Product | null>();
  const evidenceBySku = new Map<string, { reviewedTypeHash: string; evidenceHash: string }>();
  const axisBySku = new Map<string, MemberRecord>();
  for (const sku of skus) {
    const record = readMemberRecord(workspace.workspacePath, sku);
    if (!record) return c.json({ error: `No current eligible SKU-local evidence for SKU "${sku}".` }, 400);
    if (!record.base) return c.json({ error: `No approved catalog entry for SKU "${sku}"; adoption preserves existing natives only.` }, 400);
    const sizeRaw = (record.sizeRaw ?? record.base.core.weight?.trim()) || null;
    if (!sizeRaw) return c.json({ error: `No size evidence for SKU "${sku}"; adoption requires verified sizes.` }, 400);
    liveBySku.set(sku, record.base);
    evidenceBySku.set(sku, { reviewedTypeHash: record.reviewedTypeHash, evidenceHash: record.evidenceHash });
    axisBySku.set(sku, { ...record, sizeRaw, ounces: record.ounces ?? parseOuncesLocal(sizeRaw) });
  }
  // Non-food adoption routing (#369): when every member's reviewed type
  // resolves the same approved non-food rule, preview under that rule with
  // per-SKU non-food axes; otherwise the food path runs untouched.
  const previewRuleVersions = new Set(
    [...axisBySku.values()].map((record) => record.reviewedProductTypeId ? resolveFamilyVariantRule(record.reviewedProductTypeId)?.version ?? null : null),
  );
  const previewRule = previewRuleVersions.size === 1 ? [...previewRuleVersions][0] : null;
  const previewIsFood = previewRule === null || previewRule === undefined || previewRule === 'food-family-variant-rule-v1';
  try {
    const preview = previewNativeAdoption({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      skus,
      liveBySku,
      evidenceBySku,
      axisOf: (p) => {
        const record = axisBySku.get(p.sku)!;
        return {
          brand: record.brand, recipe: record.recipe, flavor: record.flavor,
          species: record.species, lifeStage: record.lifeStage, form: record.form,
          sizeRaw: record.sizeRaw ?? '', ounces: record.ounces, retailUnit: record.retailUnit,
          packCountDeclared: record.packCountDeclared, packCount: record.packCount,
          purchasable: record.purchasable,
        };
      },
      ...(previewIsFood ? {} : {
        ruleVersion: previewRule,
        nonFoodAxisOf: (p) => {
          const record = axisBySku.get(p.sku)!;
          return {
            model: record.model, material: record.material, function: record.function,
            safetyDose: record.safetyDose, strength: record.strength, fit: record.fit,
            sizeRaw: record.sizeRaw, colorRaw: record.colorRaw, countRaw: record.countRaw,
            countQuantity: record.countQuantity, reviewedProductTypeId: record.reviewedProductTypeId,
          };
        },
      }),
    });
    return c.json({ preview });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/storefront-families/adopt - stage an adopted plan from a
 * complete previewed native relationship (#369). The native main is
 * preserved verbatim (never re-nominated); existing nonempty PF7 labels
 * are preserved verbatim; only empty PF7s receive deterministic proposals.
 */
route.post('/storefront-families/adopt', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = AdoptStageBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid adoption input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const skus = parsedBody.data.members.map((m) => m.sku);
  const evidenceBySku = new Map<string, {
    base: Product | null; draftBase: Product; reviewedTypeHash: string; evidenceHash: string;
    axis: {
      brand: string | null; recipe: string | null; flavor: string | null;
      species: string | null; lifeStage: string | null; form: string | null;
      sizeRaw: string; ounces: number | null; retailUnit: string | null;
      packCountDeclared: boolean; packCount: number | null; purchasable: boolean;
    };
    nonFoodAxis?: {
      model: string | null; material: string | null; function: string | null;
      safetyDose: string | null; strength: string | null; fit: string | null;
      sizeRaw: string | null; colorRaw: string | null; countRaw: string | null;
      countQuantity: number | null; reviewedProductTypeId: string | null;
    } | null;
  }>();
  for (const sku of skus) {
    const record = readMemberRecord(workspace.workspacePath, sku);
    if (!record) return c.json({ error: `No current eligible SKU-local evidence for SKU "${sku}".` }, 400);
    if (!record.base) return c.json({ error: `No approved catalog entry for SKU "${sku}"; adoption preserves existing natives only.` }, 400);
    const sizeRaw = (record.sizeRaw ?? record.base.core.weight?.trim()) || null;
    if (!sizeRaw) return c.json({ error: `No size evidence for SKU "${sku}"; adoption requires verified sizes.` }, 400);
    evidenceBySku.set(sku, {
      base: record.base,
      draftBase: record.base,
      reviewedTypeHash: record.reviewedTypeHash,
      evidenceHash: record.evidenceHash,
      axis: {
        brand: record.brand, recipe: record.recipe, flavor: record.flavor,
        species: record.species, lifeStage: record.lifeStage, form: record.form,
        sizeRaw, ounces: record.ounces ?? parseOuncesLocal(sizeRaw), retailUnit: record.retailUnit,
        packCountDeclared: record.packCountDeclared, packCount: record.packCount,
        purchasable: record.purchasable,
      },
      nonFoodAxis: {
        model: record.model, material: record.material, function: record.function,
        safetyDose: record.safetyDose, strength: record.strength, fit: record.fit,
        sizeRaw: record.sizeRaw, colorRaw: record.colorRaw, countRaw: record.countRaw,
        countQuantity: record.countQuantity, reviewedProductTypeId: record.reviewedProductTypeId,
      },
    });
  }
  // Non-food adoption staging (#369): same approved-rule routing as preview.
  const stageRuleVersions = new Set(
    [...evidenceBySku.values()].map((ev) => ev.nonFoodAxis?.reviewedProductTypeId ? resolveFamilyVariantRule(ev.nonFoodAxis.reviewedProductTypeId)?.version ?? null : null),
  );
  const stageRule = stageRuleVersions.size === 1 ? [...stageRuleVersions][0] : null;
  try {
    const view = stageNativeAdoption({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      memberSkus: skus,
      actor: parsedBody.data.actor,
      evidenceBySku,
      ...(stageRule != null && stageRule !== 'food-family-variant-rule-v1' ? { ruleVersion: stageRule } : {}),
    });
    // Adopting a native family re-parents members: supersede live proposals touching them.
    markProposalsStaleForSkus(workspace.id, [...skus]);
    return c.json({ row: view.row, plan: view.plan }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/storefront-families/:id/member-change - stage an explicit
 * reviewed membership removal or dissolution as a new revision on the SAME
 * plan id (#369). Removal of the main without dissolution refuses; full
 * dissolution carries verified explicit-clear semantics.
 */
route.post('/storefront-families/:id/member-change', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsedBody = MembershipChangeBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json({ error: `Invalid membership-change input: ${parsedBody.error.issues.map((i) => i.message).join('; ')}` }, 400);
  }
  const existing = findStorefrontFamilyPlanById(c.req.param('id'));
  if (!existing || existing.workspaceId !== workspace.id) return c.json({ error: 'Family plan not found.' }, 404);
  const safe = safeParsePlan(existing.planJson);
  if (!safe.ok) return c.json({ error: 'Family plan is corrupt and unreadable; re-stage the family.' }, 400);
  // Member-change revisions apply only to adopted native families: a #368/
  // #372 new-family plan given a membership revision would store the marker
  // but route at apply to the new-family materializer, which knows nothing
  // about removals. Fail closed here (stageMembershipChange guards too).
  if (safe.plan.adoptionOrigin?.kind !== 'adopt_family') {
    return c.json({ error: 'Family plan has no adoption origin; member-change revisions apply only to adopted native families.' }, 400);
  }
  const touched = parsedBody.data.dissolve ? safe.plan.memberSkus : [...safe.plan.memberSkus, ...parsedBody.data.removeSkus];
  const liveBySku = new Map<string, Product | null>();
  for (const sku of touched) {
    const record = readMemberRecord(workspace.workspacePath, sku);
    liveBySku.set(sku, record?.base ?? null);
  }
  try {
    const view = stageMembershipChange({
      planId: c.req.param('id'),
      actor: parsedBody.data.actor,
      removeSkus: parsedBody.data.removeSkus,
      dissolve: parsedBody.data.dissolve,
      liveBySku,
    });
    // Membership revisions (including removed members) answer a superseded
    // membership question: mark the full touched set stale.
    markProposalsStaleForSkus(workspace.id, [...touched]);
    return c.json({ row: view.row, plan: view.plan });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/storefront-families/:id/freshness - whole-group invalidation
 * check: member/rule/evidence/base/draft drift marks the plan stale.
 */
route.post('/storefront-families/:id/freshness', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const row = findStorefrontFamilyPlanById(c.req.param('id'));
  if (!row || row.workspaceId !== workspace.id) return c.json({ error: 'Family plan not found.' }, 404);
  const freshParsed = safeParsePlan(row.planJson);
  if (!freshParsed.ok) {
    return c.json({ error: 'Family plan is corrupt and unreadable; re-stage the family.' }, 400);
  }
  const plan = freshParsed.plan;
  const liveBySku = new Map<string, Product | null>();
  const typeBySku = new Map<string, string | null>();
  const evidenceBySku = new Map<string, string | null>();
  const labelBySku = new Map<string, string | null>();
  const ruleBySku = new Map<string, string | null>();
  const typeIdBySku = new Map<string, string | null>();
  for (const sku of plan.memberSkus) {
    const record = readMemberRecord(workspace.workspacePath, sku);
    liveBySku.set(sku, record?.base ?? null);
    typeBySku.set(sku, record?.reviewedTypeHash ?? null);
    evidenceBySku.set(sku, record?.evidenceHash ?? null);
    typeIdBySku.set(sku, record?.reviewedProductTypeId ?? null);
    // Approved food authority resolves explicitly (#368): food plans
    // carry no configured non-food Product Type, so the resolver miss
    // must not stale food freshness.
    const freshIsFood = plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
    ruleBySku.set(sku, freshIsFood ? plan.ruleVersion : (record?.reviewedProductTypeId ? (resolveFamilyVariantRule(record.reviewedProductTypeId, plan.ruleVersion)?.version ?? null) : null));
    const liveLabel = (record?.base?.customFields['ProductField7'] ?? '').trim();
    labelBySku.set(sku, liveLabel.length > 0 ? liveLabel : null);
  }
  try {
    // #370: join plans check whole-group join freshness (target family,
    // native IDs, catalog commit, conflicts, drift, competing families).
    if (plan.joinOrigin) {
      const joinFresh = checkFamilyJoinFreshness({
        planId: plan.id,
        workspacePath: workspace.workspacePath,
        workspaceId: workspace.id,
        liveBySku,
        currentTypeHashBySku: typeBySku,
        currentEvidenceHashBySku: evidenceBySku,
        currentRuleVersionBySku: ruleBySku,
        currentProductTypeIdBySku: typeIdBySku,
        currentLabelBySku: labelBySku,
      });
      return c.json(joinFresh);
    }
    const result = checkStorefrontFamilyFreshness({
      planId: plan.id,
      workspacePath: workspace.workspacePath,
      liveBySku,
      currentTypeHashBySku: typeBySku,
      currentEvidenceHashBySku: evidenceBySku,
      currentRuleVersionBySku: ruleBySku,
      currentProductTypeIdBySku: typeIdBySku,
      currentLabelBySku: labelBySku,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

interface MemberRecord {
  base: Product | null;
  draftBase: Product;
  origin: FamilyMemberOrigin;
  purchasable: boolean;
  /** Whether the curation record carried an explicit boolean purchasable flag (unknown authority never defaults to true at apply/approval). */
  purchasableKnown: boolean;
  brand: string | null;
  recipe: string | null;
  flavor: string | null;
  species: string | null;
  lifeStage: string | null;
  form: string | null;
  sizeRaw: string | null;
  ounces: number | null;
  retailUnit: string | null;
  packCountDeclared: boolean;
  packCount: number | null;
  reviewedTypeHash: string;
  reviewedProductTypeId: string | null;
  evidenceHash: string;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  colorRaw: string | null;
  countRaw: string | null;
  countQuantity: number | null;
}

const CurationEvidenceSchema = z.object({
  classificationRunId: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  recipe: z.string().nullable().optional(),
  flavor: z.string().nullable().optional(),
  species: z.string().nullable().optional(),
  lifeStage: z.string().nullable().optional(),
  form: z.string().nullable().optional(),
  sizeRaw: z.string().optional(),
  verifiedSize: z.string().optional(),
  comparableOunces: z.union([z.number(), z.string()]).optional(),
  retailUnit: z.string().nullable().optional(),
  packCountDeclared: z.boolean().optional(),
  packCount: z.number().optional(),
  reviewedTypeHash: z.string().optional(),
  reviewedProductTypeHash: z.string().optional(),
  reviewedProductTypeId: z.string().optional(),
  evidenceHash: z.string().optional(),
  listingEvidenceHash: z.string().optional(),
  model: z.string().nullable().optional(),
  material: z.string().nullable().optional(),
  function: z.string().nullable().optional(),
  safetyDose: z.string().nullable().optional(),
  strength: z.string().nullable().optional(),
  fit: z.string().nullable().optional(),
  colorRaw: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  countRaw: z.string().nullable().optional(),
  count: z.string().nullable().optional(),
  countQuantity: z.number().optional(),
  purchasable: z.boolean().optional(),
  curatedTitle: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  curatedDescription: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  quantity: z.number().optional(),
  primaryImage: z.string().nullable().optional(),
  additionalImages: z.array(z.string()).optional(),
  weight: z.string().nullable().optional(),
  curatedWeight: z.string().nullable().optional(),
  searchKeywords: z.string().nullable().optional(),
  seoFileName: z.string().nullable().optional(),
  productOnPages: z.array(z.string()).optional(),
});

/**
 * Resolve the member's reviewed Product Type authority from the real
 * classification authority (issue #372): the accepted product_classification
 * proposal's effective canonical pair (reviewer-corrected target wins via
 * getEffectivePrimaryProductTypeId), hashed with the shared
 * computeReviewedAuthorityHash. Returns null when no reviewed authority
 * exists — callers fail closed, never mint authority from flat curation
 * hashes.
 */
function reviewedTypeAuthorityForSku(sku: string, runId: string | null): { typeId: string | null; typeHash: string | null } {
  if (!runId) return { typeId: null, typeHash: null };
  let proposals: Array<{ proposalType: string }>;
  try {
    proposals = getAcceptedProposals(sku, runId);
  } catch {
    return { typeId: null, typeHash: null };
  }
  const pair = proposals.find((proposal) => proposal.proposalType === 'product_classification');
  if (!pair) return { typeId: null, typeHash: null };
  let typeId: string | null;
  try {
    typeId = getEffectivePrimaryProductTypeId(pair as Parameters<typeof getEffectivePrimaryProductTypeId>[0]);
  } catch {
    return { typeId: null, typeHash: null };
  }
  if (!typeId) return { typeId: null, typeHash: null };
  return { typeId, typeHash: computeReviewedAuthorityHash(typeId) };
}

/**
 * Resolve one member's current eligible SKU-local evidence: the approved
 * catalog base (null for genuinely new SKUs) plus the onboarding curation
 * record, bound to real reviewed authority. Fail closed to null when the
 * member has no current evidence.
 *
 * Authority binding (issue #372): the reviewed Product Type id/hash bind
 * from the accepted product_classification proposal (reviewer-corrected
 * target wins), and the listing-evidence hash binds from the live
 * listing-evidence currentness (title/description/variantFacts over the
 * eligible bundle). Flat curation hash fields are legacy fallbacks only —
 * they never mint authority when the real authorities are unavailable.
 */
function readMemberRecord(workspacePath: string, sku: string, workspaceId?: string, sourceItemId?: string, sourceKind?: 'onboarding' | 'catalog'): MemberRecord | null {
  let resolvedWorkspaceId: string | null = workspaceId ?? null;
  if (!resolvedWorkspaceId) {
    try {
      resolvedWorkspaceId = getCurrentWorkspace()?.id ?? null;
    } catch {
      resolvedWorkspaceId = null;
    }
  }
  const candidates = resolvedWorkspaceId && sourceKind !== 'catalog' ? listFamilyOnboardingOrigins(resolvedWorkspaceId, sku) : [];
  if ((sourceKind === 'catalog' || (candidates.length === 0 && !sourceItemId)) && resolvedWorkspaceId) {
    const catalog = resolveApprovedCatalogFamilyOrigin({ workspaceId: resolvedWorkspaceId, workspacePath, sku });
    if (!catalog) return null;
    const validation = validateFamilyMemberOrigin({ workspaceId: resolvedWorkspaceId, workspacePath, sku, origin: catalog.origin });
    if (!validation.ok) return null;
    const textOf = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
    const attrs = catalog.product.shopsite.preserved.rawAttributes;
    const custom = catalog.product.customFields;
    const weight = textOf(catalog.product.core.weight);
    return {
      base: catalog.product,
      draftBase: catalog.product,
      origin: catalog.origin,
      purchasable: validation.purchasable,
      purchasableKnown: true,
      brand: textOf(custom.ProductField16),
      recipe: textOf(custom.ProductField24),
      flavor: textOf(custom.ProductField23),
      species: textOf(custom.ProductField17),
      lifeStage: textOf(custom.ProductField18),
      form: textOf(custom.ProductField22),
      sizeRaw: weight,
      ounces: weight ? parseOuncesLocal(weight) : null,
      retailUnit: textOf(attrs.retailUnit),
      packCountDeclared: attrs.packCountDeclared === 'true',
      packCount: typeof attrs.packCount === 'string' && /^\d+$/.test(attrs.packCount) ? Number(attrs.packCount) : null,
      reviewedTypeHash: attrs.reviewedTypeHash,
      reviewedProductTypeId: textOf(attrs.nonFoodProductTypeId),
      evidenceHash: catalog.origin.productHash,
      model: textOf(attrs.nonFoodModel),
      material: textOf(attrs.nonFoodMaterial),
      function: textOf(attrs.nonFoodFunction),
      safetyDose: textOf(attrs.nonFoodSafetyDose),
      strength: textOf(attrs.nonFoodStrength),
      fit: textOf(attrs.nonFoodFit),
      colorRaw: textOf(attrs.nonFoodColorRaw),
      countRaw: textOf(attrs.nonFoodCountRaw),
      countQuantity: typeof attrs.nonFoodCountQuantity === 'string' && /^\d+$/.test(attrs.nonFoodCountQuantity) ? Number(attrs.nonFoodCountQuantity) : null,
    };
  }
  const source = sourceItemId && resolvedWorkspaceId
    ? findFamilyOnboardingOrigin(resolvedWorkspaceId, sourceItemId)
    : candidates.length === 1 ? candidates[0] : null;
  if (!source || source.sku !== sku || (!sourceItemId && candidates.length !== 1)) return null;
  const curationJson = source.curationJson;
  if (!curationJson || !source.runId || !source.runCurrentnessHash || !source.evidenceId || !source.evidenceHash) return null;
  const origin: FamilyMemberOrigin = {
    kind: 'onboarding',
    itemId: source.itemId,
    runId: source.runId,
    runCurrentnessHash: source.runCurrentnessHash,
    evidenceId: source.evidenceId,
    evidenceHash: source.evidenceHash,
  };
  const originValidation = validateFamilyMemberOrigin({ workspaceId: resolvedWorkspaceId!, workspacePath, sku, origin });
  if (!originValidation.ok) return null;
  if (!curationJson) return null;
  let parsedCuration: unknown;
  try {
    parsedCuration = JSON.parse(curationJson);
  } catch {
    return null;
  }
  const curation = CurationEvidenceSchema.safeParse(parsedCuration);
  if (!curation.success) return null;
  const fields = curation.data;
  const nonEmpty = (value: string | null | undefined): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  // Real reviewed evidence binding (#372): reviewed type id/hash bind ONLY
  // from the accepted product_classification proposal (reviewer-corrected
  // target wins); the listing-evidence hash binds ONLY from live
  // listing-evidence currentness (title/description/variantFacts over the
  // eligible bundle). Flat curation hash/type fields never mint authority —
  // a member without real reviewed type AND live listing evidence fails
  // closed here (null), so staging can never proceed on synthetic hashes.
  const curationRunId = typeof fields.classificationRunId === 'string' && fields.classificationRunId.trim().length > 0
    ? fields.classificationRunId.trim()
    : null;
  const reviewed = reviewedTypeAuthorityForSku(sku, curationRunId);
  if (!reviewed.typeId || !reviewed.typeHash) return null;
  let liveEvidenceHash: string | null = null;
  let resolvedItemPrice: string | null = null;
  let resolvedItemQuantity: number | null = null;
  if (resolvedWorkspaceId) {
    try {
      const item = findItemById(source.itemId);
      if (item) {
        const hashes = currentListingEvidenceHashes(source.itemId, parsedCuration as Record<string, unknown>, { workspacePath, workspaceId: resolvedWorkspaceId });
        if (hashes.evidenceHash) liveEvidenceHash = hashes.evidenceHash;
        resolvedItemPrice = typeof item.price === 'string' && item.price.trim().length > 0 ? item.price.trim() : null;
        resolvedItemQuantity = typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity >= 0 ? item.quantity : null;
      }
    } catch {
      liveEvidenceHash = null;
    }
  }
  const reviewedProductTypeId = reviewed.typeId;
  const reviewedTypeHash = reviewed.typeHash;
  const evidenceHash = liveEvidenceHash;
  if (!reviewedTypeHash || !reviewedProductTypeId || !evidenceHash) return null;
  // non-food rules still require sizeRaw (schema-enforced downstream), but
  // color-only/count-only members may stage without size evidence. Base
  // weight stays a food-path fallback only — it must not mint size evidence
  // for non-food color/count members that carry no curation size.
  const sizeRaw = nonEmpty(fields.sizeRaw) ?? nonEmpty(fields.verifiedSize) ?? null;
  const ounces = sizeRaw == null
    ? null
    : typeof fields.comparableOunces === 'number' && Number.isFinite(fields.comparableOunces) && fields.comparableOunces > 0
      ? fields.comparableOunces
      : parseOuncesLocal(sizeRaw);
  const countQuantity =
    typeof fields.countQuantity === 'number' && Number.isFinite(fields.countQuantity) && fields.countQuantity > 0
      ? Math.floor(fields.countQuantity)
      : null;
  // Staged-vs-live brand authority (#372): a genuinely-new import has no
  // live base, so its blank draft is seeded with the staged curation
  // evidence (brand/recipe/flavor/species/lifeStage/form → PF slots) —
  // group validation at apply/review then reads staged authority, never a
  // null that would refuse a valid family. Catalog members keep their live
  // base untouched (staged never overwrites approved truth here; the plan
  // writers stamp reviewed hashes/markers at materialization). The
  // authoritative listing projection threads production facts: item-row
  // price/quantity, extraction titles/descriptions, and reviewed media —
  // never the bare-SKU placeholder or flat-curation media alone.
  const base = readProductFile(workspacePath, sku);
  const draftBase: Product = base ?? seedBlankDraftWithStagedEvidence(blankDraftFor(sku), fields, {
    itemPrice: resolvedItemPrice, itemQuantity: resolvedItemQuantity, parsedCuration,
  });
  const liveBrand = nonEmpty(base?.customFields['ProductField16'] ?? null);
  const stagedBrand = nonEmpty(fields.brand ?? null);
  return {
    base,
    origin,
    draftBase,
    purchasable: fields.purchasable === true,
    // Unknown curation authority never defaults to purchasable (#368): an
    // absent/non-boolean flag refuses at apply/approval (callers read
    // purchasableKnown), while staging still requires explicit true.
    purchasableKnown: typeof fields.purchasable === 'boolean',
    // Consistent Brand authority (#372): catalog members bind the live
    // approved PF16 (the authority application validates); genuinely-new
    // imports with no live base bind the staged curation brand.
    brand: base ? liveBrand : (stagedBrand ?? liveBrand),
    recipe: nonEmpty(fields.recipe ?? null),
    flavor: nonEmpty(fields.flavor ?? null),
    species: nonEmpty(fields.species ?? null),
    lifeStage: nonEmpty(fields.lifeStage ?? null),
    form: nonEmpty(fields.form ?? null),
    sizeRaw,
    ounces,
    retailUnit: nonEmpty(fields.retailUnit ?? null),
    packCountDeclared: fields.packCountDeclared === true,
    // Declared-vs-inferred pack evidence (#372): packCount threads ONLY
    // from the explicit pack declaration (fields.packCount) — never inferred
    // from countQuantity. An inferred count is not a declared pack; the rule
    // evaluator refuses undeclared packs closed.
    packCount:
      typeof fields.packCount === 'number' && Number.isFinite(fields.packCount) && fields.packCount > 0
        ? Math.floor(fields.packCount)
        : null,
    reviewedTypeHash,
    reviewedProductTypeId,
    evidenceHash,
    model: nonEmpty(fields.model ?? null),
    material: nonEmpty(fields.material ?? null),
    function: nonEmpty(fields.function ?? null),
    safetyDose: nonEmpty(fields.safetyDose ?? null),
    strength: nonEmpty(fields.strength ?? null),
    fit: nonEmpty(fields.fit ?? null),
    colorRaw: nonEmpty(fields.colorRaw ?? null) ?? nonEmpty(fields.color ?? null),
    countRaw: nonEmpty(fields.countRaw ?? null) ?? nonEmpty(fields.count ?? null),
    countQuantity,
  };
}

/**
 * Hard-invariant record for the stage-time transitive gate: every axis the
 * stored evidence actually carries. Null stays null (missing is unknown,
 * never equal); checkTransitiveSafety refuses only on axes both endpoints
 * carry with disagreeing values. Covers food axes (brand/recipe/flavor/
 * species/lifeStage/form) and non-food axes (model/material/function/
 * safetyDose/strength/fit) so the gate is never vacuous.
 */
function invariantRecordOf(evidence: Pick<MemberRecord | JoinMemberEvidence,
  'brand' | 'recipe' | 'flavor' | 'species' | 'lifeStage' | 'form' |
  'model' | 'material' | 'function' | 'safetyDose' | 'strength' | 'fit'>): Record<string, string | null> {
  return {
    brand: evidence.brand,
    recipe: evidence.recipe,
    flavor: evidence.flavor,
    species: evidence.species,
    lifeStage: evidence.lifeStage,
    form: evidence.form,
    model: evidence.model,
    material: evidence.material,
    function: evidence.function,
    safetyDose: evidence.safetyDose,
    strength: evidence.strength,
    fit: evidence.fit,
  };
}

function seedBlankDraftWithStagedEvidence(draft: Product, fields: {
  brand?: string | null; recipe?: string | null; flavor?: string | null;
  species?: string | null; lifeStage?: string | null; form?: string | null;
  curatedTitle?: string | null; title?: string | null; name?: string | null;
  price?: string | null; quantity?: number | null;
  primaryImage?: string | null; additionalImages?: string[] | null;
  description?: string | null; curatedDescription?: string | null;
  weight?: string | null; curatedWeight?: string | null;
  searchKeywords?: string | null; seoFileName?: string | null;
  productOnPages?: string[] | null;
}, listing?: {
  itemPrice?: string | null; itemQuantity?: number | null; parsedCuration?: unknown;
}): Product {
  const parsed = listing?.parsedCuration;
  const itemRowPrice = listing?.itemPrice ?? null;
  const itemRowQuantity = listing?.itemQuantity ?? null;
  const seeded = { ...draft.customFields };
  if (typeof fields.brand === 'string' && fields.brand.trim().length > 0) seeded['ProductField16'] = fields.brand.trim();
  if (typeof fields.recipe === 'string' && fields.recipe.trim().length > 0) seeded['ProductField24'] = fields.recipe.trim();
  if (typeof fields.flavor === 'string' && fields.flavor.trim().length > 0) seeded['ProductField23'] = fields.flavor.trim();
  if (typeof fields.species === 'string' && fields.species.trim().length > 0) seeded['ProductField17'] = fields.species.trim();
  if (typeof fields.lifeStage === 'string' && fields.lifeStage.trim().length > 0) seeded['ProductField18'] = fields.lifeStage.trim();
  if (typeof fields.form === 'string' && fields.form.trim().length > 0) seeded['ProductField22'] = fields.form.trim();
  // Real listing projection (#372): curated title wins, then extraction
  // title, then the onboarding name — never the bare SKU placeholder.
  // Price/quantity thread from the live onboarding ITEM row (production
  // listing facts live there, not on the curation payload). Images thread
  // reviewed-media first (the operator-reviewed bundle), then extraction
  // image candidates, then flat curation media fields.
  const title = [fields.curatedTitle, fields.title, fields.name].find((v) => typeof v === 'string' && v.trim().length > 0)?.trim() ?? null;
  const livePrice = typeof itemRowPrice === 'string' && itemRowPrice.trim().length > 0 ? itemRowPrice.trim() : null;
  const price = livePrice ?? (typeof fields.price === 'string' && fields.price.trim().length > 0 ? fields.price.trim() : null);
  const reviewedPrimary = readReviewedPrimaryImage(parsed);
  const extractionImages = readExtractionImages(parsed);
  const primary = reviewedPrimary
    ?? extractionImages.primary
    ?? (typeof fields.primaryImage === 'string' && fields.primaryImage.trim().length > 0 ? fields.primaryImage.trim() : null);
  const curatedAdditional = Array.isArray(fields.additionalImages) ? fields.additionalImages.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map((u) => u.trim()) : [];
  const additional = extractionImages.additional.length > 0 ? extractionImages.additional : curatedAdditional;
  const description = [fields.curatedDescription, fields.description].find((v) => typeof v === 'string' && v.trim().length > 0)?.trim() ?? null;
  const weight = [fields.curatedWeight, fields.weight].find((v) => typeof v === 'string' && v.trim().length > 0)?.trim() ?? null;
  const keywords = typeof fields.searchKeywords === 'string' && fields.searchKeywords.trim().length > 0 ? fields.searchKeywords.trim() : null;
  const fileName = typeof fields.seoFileName === 'string' && fields.seoFileName.trim().length > 0 ? fields.seoFileName.trim() : null;
  const pages = Array.isArray(fields.productOnPages) ? fields.productOnPages.filter((pg): pg is string => typeof pg === 'string' && pg.trim().length > 0).map((pg) => pg.trim()) : [];
  const liveQuantity = typeof itemRowQuantity === 'number' && Number.isInteger(itemRowQuantity) && itemRowQuantity >= 0 ? itemRowQuantity : null;
  const quantity = liveQuantity ?? (typeof fields.quantity === 'number' && Number.isInteger(fields.quantity) && fields.quantity >= 0 ? fields.quantity : null);
  return {
    ...draft,
    core: {
      ...draft.core,
      name: title ?? draft.core.name,
      price: price ?? draft.core.price,
      description: description ?? draft.core.description,
      weight: weight ?? draft.core.weight,
      inventory: { ...draft.core.inventory, quantityOnHand: quantity ?? draft.core.inventory.quantityOnHand },
      media: { primary: primary ?? draft.core.media.primary, additional: additional.length > 0 ? additional : draft.core.media.additional },
      seo: { ...draft.core.seo, searchKeywords: keywords ?? draft.core.seo.searchKeywords, fileName: fileName ?? draft.core.seo.fileName },
      productOnPages: pages.length > 0 ? pages : draft.core.productOnPages,
    },
    customFields: seeded,
  };
}

function blankDraftFor(sku: string): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `family-new-${sku}`,
    sku,
    status: 'draft',
    core: {
      name: sku,
      price: null,
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: null,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {},
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}
/**
 * Canonical staged-factor projection of one plan member (#372): every
 * consequential factor that staging bound (identity/material/function/
 * safety/dose/strength/fit, size/color/count + quantities, retail unit,
 * pack declaration, brand/food axes, type authority, evidence hash, and
 * the projected new-SKU listing facts) joined into one comparable string.
 * Food plans carry food axes; non-food plans carry non-food axes; null axes
 * stay null (unknown is never equal to a value, never coerced).
 */
function stagedFactorProjectionOf(member: {
  brand?: string | null; model?: string | null; material?: string | null; function?: string | null;
  safetyDose?: string | null; strength?: string | null; fit?: string | null;
  recipe?: string | null; flavor?: string | null; species?: string | null;
  lifeStage?: string | null; form?: string | null;
  sizeRaw?: string | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null;
  comparableOunces?: number | null; retailUnit?: string | null;
  packCountDeclared?: boolean; packCount?: number | null;
  reviewedTypeHash: string; productTypeId?: string | null; evidenceHash: string;
  sku: string; purchasable?: boolean; purchasableKnown?: boolean;
}): string {
  return JSON.stringify({
    brand: member.brand, model: member.model ?? null, material: member.material ?? null,
    function: member.function ?? null, safetyDose: member.safetyDose ?? null,
    strength: member.strength ?? null, fit: member.fit ?? null,
    recipe: member.recipe ?? null, flavor: member.flavor ?? null, species: member.species ?? null,
    lifeStage: member.lifeStage ?? null, form: member.form ?? null,
    size: member.sizeRaw, color: member.colorRaw ?? null, count: member.countRaw ?? null,
    countQty: member.countQuantity ?? null, ounces: member.comparableOunces,
    retail: member.retailUnit, packDeclared: member.packCountDeclared, pack: member.packCount,
    typeHash: member.reviewedTypeHash, typeId: member.productTypeId ?? null,
    evidence: member.evidenceHash,
  });
}

/**
 * Recompute the current staged-factor projection for one member from LIVE
 * evidence (#372): re-reads the member record (real reviewed authority +
 * live listing-evidence hash) and projects the same tuple shape. Returns
 * `{ ok: false }` when live evidence is unavailable — the caller refuses
 * closed, never compares against an unverified projection.
 */
function currentStagedFactorProjection(
  workspacePath: string, workspaceId: string,
  member: Parameters<typeof stagedFactorProjectionOf>[0], ruleVersion: string,
): { ok: true; projection: string } | { ok: false; error: string } {
  if (!member.sku) return { ok: false, error: 'no current eligible evidence' };
  const record = readMemberRecord(workspacePath, member.sku, workspaceId);
  if (!record) return { ok: false, error: 'no current eligible evidence' };
  void ruleVersion;
  return {
    ok: true,
    projection: stagedFactorProjectionOf({
      brand: record.brand, model: record.model, material: record.material, function: record.function,
      safetyDose: record.safetyDose, strength: record.strength, fit: record.fit,
      recipe: record.recipe, flavor: record.flavor, species: record.species,
      lifeStage: record.lifeStage, form: record.form,
      sizeRaw: record.sizeRaw, colorRaw: record.colorRaw, countRaw: record.countRaw,
      countQuantity: record.countQuantity, comparableOunces: record.ounces,
      retailUnit: record.retailUnit, packCountDeclared: record.packCountDeclared,
      packCount: record.packCount, reviewedTypeHash: record.reviewedTypeHash,
      productTypeId: record.reviewedProductTypeId, evidenceHash: record.evidenceHash,
      sku: member.sku,
    }),
  };
}
/**
 * Operator-reviewed primary image (#372): the reviewed-media bundle is the
 * production listing authority for new-SKU drafts (never flat curation
 * media alone). Returns null when no reviewed primary exists.
 */
function readReviewedPrimaryImage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const media = (parsed as Record<string, unknown>).reviewedMedia;
  if (!media || typeof media !== 'object') return null;
  const primary = (media as Record<string, unknown>).primaryImage;
  return typeof primary === 'string' && primary.trim().length > 0 ? primary.trim() : null;
}

/**
 * Extraction image candidates (#372): production media facts from the
 * extraction payload (primary + additional), thread into new-SKU drafts
 * before flat curation media fallbacks.
 */
function readExtractionImages(parsed: unknown): { primary: string | null; additional: string[] } {
  if (!parsed || typeof parsed !== 'object') return { primary: null, additional: [] };
  const nested = (parsed as Record<string, unknown>).extractionData ?? (parsed as Record<string, unknown>).extraction;
  const ext = (typeof nested === 'object' && nested !== null ? nested : parsed) as Record<string, unknown>;
  const primaryRaw = ext.primaryImage;
  const primary = typeof primaryRaw === 'string' && primaryRaw.trim().length > 0 ? primaryRaw.trim() : null;
  const additionalRaw = ext.additionalImages;
  const additional = Array.isArray(additionalRaw)
    ? additionalRaw.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map((u) => u.trim())
    : [];
  return { primary, additional };
}

function parseOuncesLocal(value: string): number | null {
  const m = value.trim().match(/^([\d.,]+)\s*(oz|ounces?|lb|lbs|pounds?|g|grams?|kg|kilograms?)\.?$/i);
  if (!m) return null;
  const amount = Number(String(m[1]).replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith('oz') || unit.startsWith('ounce')) return amount;
  if (unit.startsWith('lb') || unit.startsWith('pound')) return amount * 16;
  if (unit === 'g' || unit.startsWith('gram')) return amount / 28.349523125;
  if (unit === 'kg' || unit.startsWith('kilo')) return (amount * 1000) / 28.349523125;
  return null;
}

/**
 * True when the stored plan JSON carries a #369 adoption-origin marker.
 * Adoption-origin plans materialize through applyAdoptedFamilyPlan (native
 * main/label/order preservation + removal/dissolution clears); all other
 * plans flow through the #368/#372 new-family apply untouched.
 */
function hasAdoptionOrigin(planJson: string): boolean {
  const parsed = safeParsePlan(planJson);
  return parsed.ok && parsed.plan.adoptionOrigin?.kind === 'adopt_family';
}

/**
 * True when the stored plan JSON carries a #370 join-family origin marker.
 * Join plans materialize through applyFamilyJoin (existing main/label/order
 * preservation + create/update identity); all other plans flow through
 * their existing materializers untouched.
 */
function hasJoinOrigin(planJson: string): boolean {
  const parsed = safeParsePlan(planJson);
  return parsed.ok && parsed.plan.joinOrigin?.kind === 'join_family';
}

export default route;
