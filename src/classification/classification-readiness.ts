/**
 * Canonical classification readiness (ADR 0041, issue #354).
 *
 * The ONE shared server-owned readiness result consumed by catalog
 * review/apply and onboarding review-complete/draft creation. It answers:
 * is the run's canonical Category + Product Type resolved, is its profile
 * configuration resolved, and are its applicable required values valued?
 *
 * - Unresolved Category or Product Type, unresolved profile configuration,
 *   or applicable required values keep Review and prevent draft creation.
 * - Supported optional values, optional abstentions, and confirmed
 *   non-applicability are reported but never block: optional unsupported
 *   attributes do not become universal requirements.
 * - Brand and images stay optional to classification; separate listing,
 *   identity, commerce, and image-rights requirements are untouched.
 */
import { findGateRunById, getAcceptedProposals } from '../db/repositories/classification-run-repo';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getReviewedClassificationPair } from './effective-curation-type';
import { getEffectiveClassificationPair } from './assignment-projection';

export type CanonicalReadinessCode =
  | 'ready'
  | 'run_not_found'
  | 'run_not_completed'
  | 'pair_unresolved'
  | 'profile_unresolved'
  | 'required_values_missing';

export interface RequiredValueGap {
  attributeId: string;
  catalogField: string | null;
  status: 'missing' | 'valued' | 'not_applicable' | 'optional_unvalued';
}

export interface CanonicalReadinessResult {
  ok: boolean;
  code: CanonicalReadinessCode;
  reason: string;
  details: {
    categoryId: string | null;
    productTypeId: string | null;
    profileId: string | null;
    requiredValues: RequiredValueGap[];
  };
}

/**
 * Evaluate canonical readiness for a run. Reads live proposals/decisions
 * (stale/superseded rows never count) and the run's frozen snapshot.
 * Pure read: persists nothing, approves nothing.
 */
export function evaluateCanonicalReadiness(input: {
  workspaceId: string;
  runId: string;
}): CanonicalReadinessResult {
  const gateRun = findGateRunById(input.runId);
  const run = gateRun ? {
    id: gateRun.id, status: gateRun.status, workspace_id: gateRun.workspaceId,
    product_sku: gateRun.productSku, config_snapshot_hash: gateRun.configSnapshotHash,
  } : undefined;

  if (!run || run.workspace_id !== input.workspaceId) {
    return {
      ok: false, code: 'run_not_found',
      reason: `Classification run ${input.runId} not found.`,
      details: { categoryId: null, productTypeId: null, profileId: null, requiredValues: [] },
    };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return {
      ok: false, code: 'run_not_completed',
      reason: `Classification run has status "${run.status}". Only completed runs can be ready.`,
      details: { categoryId: null, productTypeId: null, profileId: null, requiredValues: [] },
    };
  }

  const snapshot = run.config_snapshot_hash
    ? getRuntimeSnapshotByHash(input.workspaceId, run.config_snapshot_hash)
    : null;

  // Legacy runs (no resolvable snapshot) carry no classification authority
  // intent — same passthrough as the review gates (never invent a pair
  // requirement where no configuration proves one). Pair/profile/required
  // checks apply only under a frozen authority.
  if (!snapshot) {
    return {
      ok: true, code: 'ready', reason: 'Legacy run without frozen classification authority; no canonical requirement applies.',
      details: { categoryId: null, productTypeId: null, profileId: null, requiredValues: [] },
    };
  }

  // Canonical pair: accepted in-run pair first, then compatible reviewed facts.
  let categoryId: string | null = null;
  let productTypeId: string | null = null;
  const accepted = getAcceptedProposals(run.product_sku, run.id);
  for (const proposal of accepted) {
    if (proposal.proposalType !== 'product_classification' && proposal.proposalType !== 'primary_product_type') continue;
    const pair = getEffectiveClassificationPair(proposal);
    if (pair.categoryId || pair.productTypeId) {
      categoryId = pair.categoryId;
      productTypeId = pair.productTypeId;
      break;
    }
  }
  if (!categoryId && !productTypeId && snapshot) {
    const factPair = getReviewedClassificationPair(snapshot);
    categoryId = factPair.categoryId;
    productTypeId = factPair.productTypeId;
  }
  if (!categoryId || !productTypeId) {
    return {
      ok: false, code: 'pair_unresolved',
      reason: 'Review requires a resolved Category + Product Type pair; at least one member is unresolved.',
      details: { categoryId, productTypeId, profileId: null, requiredValues: [] },
    };
  }

  // Profile configuration: the type's declared profile must resolve in the
  // frozen snapshot. A null profile id is legitimately empty (universals
  // only) — never a gap. A declared-but-absent profile is a configuration
  // gap that keeps Review.
  const snapshotTypes = snapshot?.productTypes ?? [];
  const profiles = snapshot?.attributeProfiles ?? [];
  const typeRow = snapshotTypes.find(t => t.id === productTypeId) as
    | { attributeProfileId?: string | null }
    | undefined;
  const declaredProfileId = typeRow?.attributeProfileId ?? null;
  let profileId: string | null = null;
  if (snapshot && declaredProfileId) {
    const profile = profiles.find(p => p.id === declaredProfileId);
    if (!profile) {
      return {
        ok: false, code: 'profile_unresolved',
        reason: `Product Type "${productTypeId}" declares Attribute Profile "${declaredProfileId}" which is missing from the frozen configuration.`,
        details: { categoryId, productTypeId, profileId: null, requiredValues: [] },
      };
    }
    profileId = profile.id;
  }

  // Required values: profile-required + applicable attributes must carry an
  // accepted valued proposal. Optional/unvalued and non-applicable are
  // reported, never blocking. Universals are never required by a profile.
  const requiredValues: RequiredValueGap[] = [];
  let missingRequired = 0;
  if (snapshot && profileId) {
    const profile = profiles.find(p => p.id === profileId)!;
    const mappings = snapshot.attributeMappings ?? [];
    for (const entry of profile.attributes ?? []) {
      const attribute = (snapshot.attributes ?? []).find(a => a.id === entry.attributeId);
      if (!attribute) continue;
      const mapping = mappings.find(m => m.attributeId === entry.attributeId);
      const valued = accepted.some(p =>
        p.proposalType === 'field_assignment' &&
        (p.targetId === entry.attributeId || p.hasRevisedTargetId && p.revisedTargetId === entry.attributeId) &&
        p.status === 'accepted' &&
        (() => {
          const v = p.hasRevisedValue ? (p as { revisedValue?: unknown }).revisedValue : p.proposedValue;
          return v !== null && v !== undefined && !(typeof v === 'string' && v.length === 0);
        })(),
      );
      const gap: RequiredValueGap = {
        attributeId: entry.attributeId,
        catalogField: mapping?.catalogField ?? null,
        status: valued ? 'valued' : entry.required ? 'missing' : 'optional_unvalued',
      };
      requiredValues.push(gap);
      if (gap.status === 'missing') missingRequired += 1;
    }
  }
  void (snapshot as RuntimeClassificationSnapshot | null);

  if (missingRequired > 0) {
    const names = requiredValues.filter(g => g.status === 'missing').map(g => g.attributeId).join(', ');
    return {
      ok: false, code: 'required_values_missing',
      reason: `Required classification value(s) unresolved: ${names}.`,
      details: { categoryId, productTypeId, profileId, requiredValues },
    };
  }

  return {
    ok: true, code: 'ready', reason: 'Canonical classification is resolved.',
    details: { categoryId, productTypeId, profileId, requiredValues },
  };
}
