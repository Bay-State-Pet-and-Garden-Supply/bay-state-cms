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
import { findGateRunById, getAcceptedProposals, getLiveDecisionsByRun } from '../db/repositories/classification-run-repo';
import { composeEffectiveReviewedFacts } from './reviewed-facts';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { getReviewedClassificationPair } from './effective-curation-type';
import { getEffectiveClassificationPair } from './assignment-projection';
import { validateAttributeProfileValue } from './attribute-value-validation';
import { getEffectiveProposalTargetId, getEffectiveProposalValue } from './effective-proposal';
import { resolveAttributeProfilePlan } from './attribute-profile-plan';
import { resolveWebsiteClassification } from './product-classification';
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
    : getReviewedClassificationPair(snapshot);
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
