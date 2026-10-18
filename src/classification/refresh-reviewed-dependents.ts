import { getAcceptedProposals, getEvidenceByRun, getLiveDecisionsByRun, getRun } from '../db/repositories/classification-run-repo';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { getEffectiveClassificationPair } from './assignment-projection';
import { isApprovedClassificationPair } from './product-classification';
import { runPipeline } from './pipeline-runner';
import { attributeApplicabilityStage } from './stages/attribute-applicability';
import { productAttributeProposalsStage } from './stages/attribute-proposals';
import { categoryPageProposalsStage } from './stages/category-page-proposals';
import {
  assertDependentReviewCurrent, finishDependentReviewProjection,
  isTypeDependentProposal, listCurrentRunProposals, claimDependentReviewLease,
  assertDependentReviewLease, failDependentReviewLease, getConditionalUniversalAttributeIds,
  getApplicableAcceptedPremiseProposalIds,
} from '../db/repositories/classification-dependent-review-repo';
import { redactTransportText } from './model-policy-gateway';

/**
 * Review is a new dependent judgment, not a new extraction. Keep the accepted
 * type, OCR, naming, frozen options and universal decisions in the original run.
 * Only applicable attributes and verified pages are recomputed. No image fetch,
 * OCR, naming, type dispatch, config recapture or automatic approval occurs.
 */
export async function refreshReviewedDependents(input: {
  runId: string; workspaceId: string; itemId?: string | null; refreshId?: string;
  claimedBy?: string | null;
}): Promise<{ runId: string; proposalCount: number }> {
  const run = getRun(input.runId);
  if (!run || run.workspaceId !== input.workspaceId || !run.configSnapshotHash) throw new Error('Classification run has no frozen runtime authority.');
  const snapshot = getRuntimeSnapshotByHash(run.workspaceId, run.configSnapshotHash);
  if (!snapshot) throw new Error('Frozen runtime snapshot is unavailable.');
  // Coordinated child pages are owned by their parent; never fork a child into
  // singleton page execution. The cohort worker must restart the parent instead.
  if (run.cohortRunId) throw new Error('Coordinated cohort review must refresh through its parent run; restart the cohort preparation.');
  const accepted = getAcceptedProposals(run.productSku, run.id);
  // ADR 0041: refresh requires an accepted canonical pair; legacy
  // `primary_product_type` rows are history-only and cannot authorize it.
  const type = accepted.find(proposal => proposal.proposalType === 'product_classification');
  const pair = type ? getEffectiveClassificationPair(type) : { categoryId: null, productTypeId: null };
  const typeId = pair.productTypeId;
  const decision = type && getLiveDecisionsByRun(run.id).find(row => row.proposalId === type.id && row.decision === 'accepted');
  if (!typeId || !decision) throw new Error('Accept or correct a Product Classification before refreshing its attributes and pages.');
  if (!snapshot.productTypes.some(type => type.id === typeId)) throw new Error('Reviewed Product Type is not an option in the run’s frozen taxonomy.');
  if (pair.categoryId) {
    if (!isApprovedClassificationPair({ categoryId: pair.categoryId, productTypeId: typeId }, { productTypes: snapshot.productTypes as any, categories: (snapshot as any).categories ?? [] })) {
      throw new Error('Reviewed Product Classification is not an approved configured combination in the run’s frozen taxonomy.');
    }
  }
  const guardInput = { ...input, decisionId: decision.id };
  assertDependentReviewCurrent(guardInput);
  const evidence = getEvidenceByRun(run.id);
  if (evidence.length === 0) throw new Error('The run has no persisted extraction evidence; refresh cannot invent it.');
  const lease = claimDependentReviewLease(guardInput);
  if (lease.alreadyCompleted) return { runId: run.id, proposalCount: 0 };
  const refreshId = lease.refreshId;
  const assertHeld = () => { assertDependentReviewCurrent(guardInput); assertDependentReviewLease(lease); };
  const conditionalUniversalAttributeIds = getConditionalUniversalAttributeIds(snapshot, typeId);
  const preservablePremiseProposalIds = getApplicableAcceptedPremiseProposalIds(snapshot, pair, run.id, accepted);
  const acceptedFacts = accepted.filter(proposal =>
    !isTypeDependentProposal(proposal, snapshot, conditionalUniversalAttributeIds)
    || (proposal.proposalType === 'field_assignment'
      && preservablePremiseProposalIds.has(proposal.id)
      && proposal.status === 'accepted'
      && !proposal.isStale
      && proposal.currentDecisionId != null
      && proposal.runId === run.id
      && proposal.productSku === run.productSku),
  );
  const retained = listCurrentRunProposals(run.id).filter(proposal =>
    !isTypeDependentProposal(proposal, snapshot, conditionalUniversalAttributeIds)
    || (proposal.proposalType === 'field_assignment'
      && preservablePremiseProposalIds.has(proposal.id)
      && proposal.status === 'accepted'
      && !proposal.isStale
      && proposal.currentDecisionId != null
      && proposal.runId === run.id
      && proposal.productSku === run.productSku),
  );
  const preservedProposalIds = new Set(acceptedFacts
    .filter(proposal => proposal.proposalType === 'field_assignment' && preservablePremiseProposalIds.has(proposal.id))
    .map(proposal => proposal.id));
  try {
  const result = await runPipeline([
    attributeApplicabilityStage, productAttributeProposalsStage, categoryPageProposalsStage,
  ], {
    workspaceId: run.workspaceId,
    workspacePath: snapshot.workspacePath,
    configSnapshotRef: snapshot.configSnapshotRef,
    snapshot,
    runId: run.id,
    dependentReviewRefresh: true,
    assertHeld,
  }, {
    sku: run.productSku,
    onboardingItemId: run.onboardingItemId ?? undefined,
    sourceKind: run.sourceKind,
    evidence,
    acceptedProposals: acceptedFacts,
    allProposals: retained,
  }, { prepareOnly: true });
  assertHeld();
  const retainedIds = new Set(retained.map(proposal => proposal.id));
  const newProposalIds = result.proposals.filter(proposal => !retainedIds.has(proposal.id)).map(proposal => proposal.id);
  finishDependentReviewProjection({ ...guardInput, refreshId, typeId, newProposalIds,
    snapshot, lease, commitPreparedStages: result.commitPreparedStages!,
    preservedProposalIds,
    applicability: result.stageOutputs.attribute_applicability?.metadata?.applicability });
  return { runId: run.id, proposalCount: newProposalIds.length };
  } catch (error) {
    failDependentReviewLease(lease, redactTransportText(error instanceof Error ? error.message : String(error)));
    throw error;
  }
}
