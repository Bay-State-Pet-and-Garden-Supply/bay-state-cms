/**
 * Canonical classification readiness (ADR 0041, issue #354).
 *
 * The shared server-owned readiness result consumed by catalog review/apply
 * and onboarding review-complete/draft creation. It answers:
 * is the run's canonical Category + Product Type resolved, does that pair
 * have an unambiguous approved storefront mapping, is its profile configuration
 * resolved, and are all applicability states known and applicable required
 * values validly valued?
 *
 * - Unresolved/ambiguous Category or Product Type, unresolved storefront
 *   mapping/profile configuration, unknown applicability, or applicable
 *   required values keep Review and prevent draft creation.
 * - Supported optional values, optional abstentions, and confirmed
 *   non-applicability are reported but never block: optional unsupported
 *   attributes do not become universal value requirements.
 * - Brand and images stay optional to classification; separate listing,
 *   identity, commerce, and image-rights requirements are untouched.
 * - Profile applicability uses current accepted effective field decisions
 *   overlaid on compatible reviewed facts captured in the run snapshot.
 */
import { getCachedAttributeMappings, getCachedClassificationOutputBindings } from '../db/repositories/classification-config-repo';
import { findGateRunById, getAcceptedProposals, getLiveDecisionsByRun, getProposalsByRun } from '../db/repositories/classification-run-repo';
import { composeEffectiveReviewedFacts, findRejectedProductClassificationProposal } from './reviewed-facts';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { getReviewedClassificationPair } from './effective-curation-type';
import { getEffectiveClassificationPair } from './assignment-projection';
import { validateAttributeProfileValue } from './attribute-value-validation';
import { getEffectiveProposalTargetId, getEffectiveProposalValue } from './effective-proposal';
import { resolveAttributeProfilePlan } from './attribute-profile-plan';
import { resolveWebsiteClassification, isApprovedClassificationPair } from './product-classification';
import { resolveCanonicalClassificationOutputBindings } from './classification-ownership';
import type {
  CanonicalClassificationReadinessResult,
  CanonicalReadinessCode as SharedCanonicalReadinessCode,
  RequiredValueGap as SharedRequiredValueGap,
} from '../shared/schemas/classification';

export type CanonicalReadinessCode = SharedCanonicalReadinessCode;
export type RequiredValueGap = SharedRequiredValueGap;
export type CanonicalReadinessResult = CanonicalClassificationReadinessResult;


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

  // Classification readiness requires captured canonical V2 authority. Legacy
  // embedded proposal history and V1 snapshots cannot establish current intent.
  if (!snapshot || snapshot.schemaVersion !== 2 || snapshot.configAuthorityKind !== 'v2') {
    return {
      ok: false, code: 'profile_unresolved',
      reason: 'Frozen V2 classification authority is required for readiness.',
      details: { categoryId: null, productTypeId: null, profileId: null, requiredValues: [] },
    };
  }

  const accepted = getAcceptedProposals(run.product_sku, run.id);
  const currentRunProposals = getProposalsByRun(run.id);
  const decisions = getLiveDecisionsByRun(run.id);
  const currentAccepted = accepted.filter(proposal =>
    proposal.status === 'accepted' && !proposal.isStale &&
    decisions.some(decision => decision.proposalId === proposal.id && decision.decision === 'accepted' &&
      decision.id === proposal.currentDecisionId),
  );
  const acceptedPairs = accepted.filter(proposal =>
    proposal.proposalType === 'product_classification' && proposal.status === 'accepted' && !proposal.isStale,
  );
  if (acceptedPairs.length > 1) {
    return {
      ok: false, code: 'pair_unresolved',
      reason: 'Review has multiple accepted Product Classification pairs; exactly one current pair is required.',
      details: { categoryId: null, productTypeId: null, profileId: null, requiredValues: [] },
    };
  }

  const reviewedPair = acceptedPairs.length === 1
    ? getEffectiveClassificationPair(acceptedPairs[0]!)
    : getReviewedClassificationPair(snapshot, currentRunProposals);
  const categoryId = reviewedPair.categoryId;
  const productTypeId = reviewedPair.productTypeId;
  if (!categoryId || !productTypeId) {
    return {
      ok: false, code: 'pair_unresolved',
      reason: 'Review requires a resolved Category + Product Type pair; at least one member is unresolved.',
      details: { categoryId, productTypeId, profileId: null, requiredValues: [] },
    };
  }

  const websiteClassification = resolveWebsiteClassification({ categoryId, productTypeId }, snapshot);
  if (websiteClassification.status !== 'resolved') {
    return {
      ok: false, code: 'core_mapping_unresolved',
      reason: `Product Classification has no unambiguous approved ShopSite mapping: ${websiteClassification.reason}`,
      details: { categoryId, productTypeId, profileId: null, requiredValues: [] },
    };
  }

  const outputBindingResolution = resolveCanonicalClassificationOutputBindings({
    currentBindings: getCachedClassificationOutputBindings(input.workspaceId),
    frozenBindings: snapshot.classificationOutputBindings ?? [],
    currentMappings: getCachedAttributeMappings(input.workspaceId),
    frozenMappings: snapshot.attributeMappings,
  });
  if (outputBindingResolution.status !== 'resolved') {
    return {
      ok: false, code: 'core_mapping_unresolved',
      reason: `Product Classification output binding is unresolved: ${outputBindingResolution.reason}`,
      details: { categoryId, productTypeId, profileId: null, requiredValues: [] },
    };
  }

  const applicabilityFacts = composeEffectiveReviewedFacts(snapshot, currentAccepted, run.id);
  const plan = resolveAttributeProfilePlan(snapshot, { categoryId, productTypeId }, applicabilityFacts);
  if (plan.status !== 'ready') {
    return {
      ok: false, code: 'profile_unresolved',
      reason: plan.reason ?? 'Frozen Attribute Profile configuration is unresolved.',
      details: { categoryId, productTypeId, profileId: plan.profileId, requiredValues: [] },
    };
  }
  const requiredValues: RequiredValueGap[] = [];


  let missingRequired = 0;
  for (const entry of plan.entries) {
    if (entry.applicability.state === 'unknown') {
      const status: RequiredValueGap['status'] = entry.required ? 'required_unknown' : 'optional_unknown';
      const mapping = snapshot.attributeMappings.find(candidate => candidate.attributeId === entry.attribute.id);
      requiredValues.push({ attributeId: entry.attribute.id, catalogField: mapping?.catalogField ?? null, status });
      missingRequired++;
      continue;
    }
    const mapping = snapshot.attributeMappings.find(candidate => candidate.attributeId === entry.attribute.id);
    const applicable = entry.applicability.state === 'applicable';
    const candidates = currentAccepted.filter(proposal =>
      proposal.proposalType === 'field_assignment' &&
      getEffectiveProposalTargetId(proposal) === entry.attribute.id,
    );
    const valued = applicable && candidates.some(proposal => {
      const value = getEffectiveProposalValue(proposal);
      if (value === null || value === undefined) return false;
      return validateAttributeProfileValue(value, entry.attribute, entry.cardinality).ok;
    });
    const status: RequiredValueGap['status'] = !applicable
      ? 'not_applicable'
      : valued ? 'valued' : entry.required ? 'missing' : 'optional_unvalued';
    requiredValues.push({ attributeId: entry.attribute.id, catalogField: mapping?.catalogField ?? null, status });
    if (status === 'missing') missingRequired++;
  }

  if (missingRequired > 0) {
    const unresolved = requiredValues
      .filter(gap => gap.status === 'missing' || gap.status === 'required_unknown' || gap.status === 'optional_unknown')
      .map(gap => gap.attributeId)
      .join(', ');
    return {
      ok: false, code: 'required_values_missing',
      reason: `Classification values or applicability unresolved: ${unresolved}.`,
      details: { categoryId, productTypeId, profileId: plan.profileId, requiredValues },
    };
  }

  return {
    ok: true, code: 'ready', reason: 'Canonical classification is resolved.',
    details: { categoryId, productTypeId, profileId: plan.profileId, requiredValues },
  };
}
/**
 * Resolve the catalogue fields whose captured Attribute Profile rules are
 * required and currently applicable for a completed V2 run. This deliberately
 * uses the same live decisions, reviewed facts, and frozen profile planner as
 * canonical readiness so callers cannot infer requiredness from value status
 * alone (which also includes optional valued attributes).
 */
export function getRequiredCatalogFieldsForRun(input: {
  workspaceId: string;
  runId: string;
}): string[] | null {
  const run = findGateRunById(input.runId);
  if (!run || run.workspaceId !== input.workspaceId ||
    (run.status !== 'completed' && run.status !== 'completed_with_abstentions')) return null;
  const snapshot = run.configSnapshotHash
    ? getRuntimeSnapshotByHash(input.workspaceId, run.configSnapshotHash)
    : null;
  if (!snapshot || snapshot.schemaVersion !== 2 || snapshot.configAuthorityKind !== 'v2') return null;

  const accepted = getAcceptedProposals(run.productSku, run.id);
  const currentRunProposals = getProposalsByRun(run.id);
  const decisions = getLiveDecisionsByRun(run.id);
  const currentAccepted = accepted.filter(proposal =>
    proposal.status === 'accepted' && !proposal.isStale &&
    decisions.some(decision => decision.proposalId === proposal.id && decision.decision === 'accepted' &&
      decision.id === proposal.currentDecisionId),
  );
  const acceptedPairs = accepted.filter(proposal =>
    proposal.proposalType === 'product_classification' && proposal.status === 'accepted' && !proposal.isStale,
  );
  if (acceptedPairs.length > 1) return null;
  const pair = acceptedPairs.length === 1
    ? getEffectiveClassificationPair(acceptedPairs[0]!)
    : getReviewedClassificationPair(snapshot, currentRunProposals);
  if (!pair.categoryId || !pair.productTypeId) return null;
  const facts = composeEffectiveReviewedFacts(snapshot, currentAccepted, run.id);
  const plan = resolveAttributeProfilePlan(snapshot, pair, facts);
  if (plan.status !== 'ready') return null;

  return plan.entries
    .filter(entry => entry.required && entry.applicability.state === 'applicable')
    .map(entry => snapshot.attributeMappings.find(mapping => mapping.attributeId === entry.attribute.id)?.catalogField ??
      entry.attribute.id);
}
export interface RunListingClassificationTarget {
  source: 'reviewed' | 'provisional' | 'none';
  categoryId: string | null;
  productTypeId: string | null;
}

/**
 * Resolve an own-run pair for item listing guidance. A provisional pair may
 * select its finite configured target, but this helper never marks it reviewed
 * or ready for release; callers must keep the returned source explicit.
 */
export function selectRunListingClassificationTarget(input: {
  workspaceId: string;
  runId: string;
}): RunListingClassificationTarget {
  const run = findGateRunById(input.runId);
  if (!run || run.workspaceId !== input.workspaceId ||
    !['running', 'completed', 'completed_with_abstentions'].includes(run.status)) {
    return { source: 'none', categoryId: null, productTypeId: null };
  }
  const snapshot = run.configSnapshotHash
    ? getRuntimeSnapshotByHash(input.workspaceId, run.configSnapshotHash)
    : null;
  if (!snapshot || snapshot.schemaVersion !== 2 || snapshot.configAuthorityKind !== 'v2') {
    return { source: 'none', categoryId: null, productTypeId: null };
  }
  const runProposals = getProposalsByRun(run.id).filter(proposal =>
    proposal.runId === run.id && proposal.productSku === run.productSku,
  );
  const accepted = getAcceptedProposals(run.productSku, run.id);
  const acceptedPairs = accepted.filter(proposal =>
    proposal.proposalType === 'product_classification' && proposal.status === 'accepted' && !proposal.isStale,
  );
  if (acceptedPairs.length > 1) return { source: 'none', categoryId: null, productTypeId: null };

  const reviewedPair = acceptedPairs.length === 1
    ? getEffectiveClassificationPair(acceptedPairs[0]!)
    : getReviewedClassificationPair(snapshot, runProposals);
  if (reviewedPair.categoryId || reviewedPair.productTypeId) {
    if (!reviewedPair.categoryId || !reviewedPair.productTypeId) return { source: 'none', categoryId: null, productTypeId: null };
    const valid = isApprovedClassificationPair({ categoryId: reviewedPair.categoryId, productTypeId: reviewedPair.productTypeId }, snapshot);
    return valid
      ? { source: 'reviewed', categoryId: reviewedPair.categoryId, productTypeId: reviewedPair.productTypeId }
      : { source: 'none', categoryId: null, productTypeId: null };
  }
  if (findRejectedProductClassificationProposal(runProposals, run.productSku)) {
    return { source: 'none', categoryId: null, productTypeId: null };
  }

  const provisional = runProposals
    .filter(proposal => proposal.proposalType === 'product_classification' && !proposal.isStale &&
      (proposal.status === 'pending' || proposal.status === 'deferred'))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!provisional) return { source: 'none', categoryId: null, productTypeId: null };
  const pair = getEffectiveClassificationPair(provisional);
  if (!pair.categoryId || !pair.productTypeId) return { source: 'none', categoryId: null, productTypeId: null };
  return isApprovedClassificationPair({ categoryId: pair.categoryId, productTypeId: pair.productTypeId }, snapshot)
    ? { source: 'provisional', categoryId: pair.categoryId, productTypeId: pair.productTypeId }
    : { source: 'none', categoryId: null, productTypeId: null };
}
