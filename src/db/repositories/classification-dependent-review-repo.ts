import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { ProductAttributeConfig } from '../../shared/schemas/classification';
import type { ClassificationProposal } from '../../shared/types';
import { getDb } from '../connection';
import { findItemById, updateItemCurationData } from './onboarding-item-repo';
import { getProposalsByRun, getEvidenceByRun, getLiveDecisionsByRun, getRun } from './classification-run-repo';
import { isUniversalAttribute } from '../../classification/applicability-evaluator';
import { getEffectiveClassificationPair } from '../../classification/assignment-projection';
import { validateAttributeProfileValue } from '../../classification/attribute-value-validation';
import { getEffectiveProposalTargetId, getEffectiveProposalValue } from '../../classification/effective-proposal';
import { composeEffectiveReviewedFacts } from '../../classification/reviewed-facts';
import { resolveAttributeProfilePlan } from '../../classification/attribute-profile-plan';
import { hashCanonicalJson } from '../../shared/stable-id';
import { markReviewInvalidated } from './onboarding-review-repo';
import { randomUUID } from 'node:crypto';
import { enqueueRefreshItem } from './classification-refresh-repo';

function isValidReviewedPremiseValue(
  value: unknown,
  attribute: ProductAttributeConfig,
  cardinality: 'single' | 'multiple',
): boolean {
  return validateAttributeProfileValue(value, attribute, cardinality).ok;
}

/** Current accepted condition premises that remain valid under the corrected profile. */
export function getApplicableAcceptedPremiseProposalIds(
  snapshot: RuntimeClassificationSnapshot,
  pair: { categoryId: string | null; productTypeId: string | null },
  runId: string,
  proposals: readonly ClassificationProposal[],
): ReadonlySet<string> {
  const selectedType = snapshot.productTypes.find(type => type.id === pair.productTypeId);
  const profileId = selectedType && 'attributeProfileId' in selectedType
    && typeof selectedType.attributeProfileId === 'string'
    ? selectedType.attributeProfileId : null;
  const profiles = profileId ? snapshot.attributeProfiles.filter(profile => profile.id === profileId) : [];
  if (profiles.length !== 1 || !Array.isArray(profiles[0]?.attributes)) return new Set<string>();
  const profile = profiles[0]!;
  const premiseIds = new Set((profile?.attributes ?? []).flatMap(rule =>
    Array.isArray(rule.applicabilityConditions)
      ? rule.applicabilityConditions.flatMap(condition => {
        if (!condition || typeof condition !== 'object' || !('attributeId' in condition)) return [];
        return typeof condition.attributeId === 'string' ? [condition.attributeId] : [];
      })
      : [],
  ));
  if (premiseIds.size === 0) return new Set<string>();

  const effectiveFacts = composeEffectiveReviewedFacts(snapshot, [...proposals], runId);
  const preliminaryPlan = resolveAttributeProfilePlan(snapshot, pair, []);
  const entriesById = new Map(preliminaryPlan.entries.map(entry => [entry.attribute.id, entry]));
  const validFacts = effectiveFacts.filter(fact => {
    if (!fact.targetId) return false;
    const entry = entriesById.get(fact.targetId);
    return Boolean(entry && isValidReviewedPremiseValue(fact.value, entry.attribute, entry.cardinality));
  });
  const plan = resolveAttributeProfilePlan(snapshot, pair, validFacts);
  const correctedEntriesById = new Map(plan.entries.map(entry => [entry.attribute.id, entry]));
  const proposalsById = new Map(proposals.map(proposal => [proposal.id, proposal]));
  const liveAcceptedIds = new Set(getLiveDecisionsByRun(runId)
    .filter(decision => decision.decision === 'accepted')
    .map(decision => decision.proposalId));
  const currentProposalIds = new Set(proposals.map(proposal => proposal.id));
  const effectiveFactByTarget = new Set<string>();
  const preservableProposalIds = new Set<string>();
  for (const fact of validFacts) {
    if (!fact.targetId || effectiveFactByTarget.has(fact.targetId)) continue;
    effectiveFactByTarget.add(fact.targetId);
    if (!premiseIds.has(fact.targetId) || !currentProposalIds.has(fact.proposalId)) continue;
    const proposal = proposalsById.get(fact.proposalId);
    if (!proposal
      || proposal.proposalType !== 'field_assignment'
      || proposal.status !== 'accepted'
      || proposal.isStale
      || proposal.currentDecisionId == null
      || proposal.runId !== runId
      || proposal.productSku !== snapshot.productSku
      || !liveAcceptedIds.has(proposal.id)) continue;
    const correctedEntry = correctedEntriesById.get(fact.targetId);
    if (!correctedEntry || correctedEntry.applicability.state !== 'applicable') continue;
    const effectiveValue = getEffectiveProposalValue(proposal);
    if (effectiveValue === null || effectiveValue === undefined) continue;
    if (!isValidReviewedPremiseValue(effectiveValue, correctedEntry.attribute, correctedEntry.cardinality)) continue;
    preservableProposalIds.add(fact.proposalId);
  }
  return preservableProposalIds;
}
const dependentAbstentionStages = new Set(['attribute_applicability', 'product_attribute_proposals', 'category_page_proposals']);

/** Called inside the decision transaction, before corrected type authority is exposed. */
export function invalidateDependentTypeReview(runId: string, snapshot: RuntimeClassificationSnapshot | null, itemId: string | undefined, reason: string): void {
  const db = getDb();
  const at = new Date().toISOString();
  const proposals = listCurrentRunProposals(runId);
  const classification = proposals.find(proposal => proposal.proposalType === 'product_classification' && proposal.status === 'accepted');
  const pair = classification ? getEffectiveClassificationPair(classification) : null;
  const preservablePremiseProposalIds = snapshot && pair
    ? getApplicableAcceptedPremiseProposalIds(snapshot, pair, runId, proposals)
    : new Set<string>();
  const conditionalUniversalAttributeIds = snapshot ? getConditionalUniversalAttributeIds(snapshot, pair?.productTypeId ?? null) : new Set<string>();
  const liveAccepted = new Set(getLiveDecisionsByRun(runId)
    .filter(decision => decision.decision === 'accepted' && decision.decisionOrigin === 'human_review')
    .map(decision => decision.proposalId));
  for (const proposal of proposals) {
    const preservePremise = proposal.proposalType === 'field_assignment'
      && preservablePremiseProposalIds.has(proposal.id)
      && proposal.status === 'accepted'
      && !proposal.isStale
      && proposal.currentDecisionId != null
      && liveAccepted.has(proposal.id)
      && proposal.runId === runId
      && proposal.productSku === snapshot?.productSku;
    if (preservePremise) continue;
    const dependent = snapshot ? isTypeDependentProposal(proposal, snapshot, conditionalUniversalAttributeIds)
      : proposal.proposalType === 'field_assignment' || proposal.proposalType === 'category_page';
    if (!dependent) continue;
    db.run(`UPDATE classification_proposals SET status = 'stale', is_stale = 1, staleness_reason = ? WHERE id = ?`, [reason, proposal.id]);
    db.run('UPDATE classification_proposal_decisions SET superseded_at = ? WHERE proposal_id = ? AND superseded_at IS NULL', [at, proposal.id]);
  }
  if (itemId) markReviewInvalidated(itemId, reason);
}

/** A superseded proposal is history, never a current reviewer input. */
export function listCurrentRunProposals(runId: string) {
  const superseded = new Set((getDb().query('SELECT id FROM classification_proposals WHERE run_id = ? AND superseded_at IS NOT NULL')
    .all(runId) as Array<{ id: string }>).map(row => row.id));
  return getProposalsByRun(runId).filter(proposal => !superseded.has(proposal.id));
}

export function getConditionalUniversalAttributeIds(snapshot: RuntimeClassificationSnapshot, typeId: string | null): ReadonlySet<string> {
  if (!typeId) return new Set();
  const type = snapshot.productTypes.find(candidate => candidate.id === typeId);
  if (!type || !('attributeProfileId' in type) || typeof type.attributeProfileId !== 'string') return new Set();
  const profile = snapshot.attributeProfiles.find(candidate => candidate.id === type.attributeProfileId);
  return new Set((profile?.attributes ?? [])
    .filter(rule => rule.applicabilityConditions.length > 0)
    .map(rule => rule.attributeId)
    .filter(attributeId => {
      const attribute = snapshot.attributes.find(candidate => candidate.id === attributeId);
      return Boolean(attribute && isUniversalAttribute(attribute));
    }));
}

export function isTypeDependentProposal(
  proposal: ReturnType<typeof listCurrentRunProposals>[number],
  snapshot: RuntimeClassificationSnapshot,
  conditionalUniversalAttributeIds: ReadonlySet<string>,
): boolean {
  if (proposal.proposalType === 'category_page') return true;
  if (proposal.proposalType === 'reviewable_abstention') {
    if (dependentAbstentionStages.has(proposal.targetId ?? '')) return true;
    const attributeId = (proposal.proposedValue as { attributeId?: string } | null)?.attributeId ?? proposal.targetId;
    const attribute = snapshot.attributes.find(attr => attr.id === attributeId);
    return Boolean(attribute && !isUniversalAttribute(attribute));
  }
  if (proposal.proposalType !== 'field_assignment') return false;
  const attribute = snapshot.attributes.find(attr => attr.id === getEffectiveProposalTargetId(proposal));
  return !attribute || !isUniversalAttribute(attribute)
    || conditionalUniversalAttributeIds.has(attribute.id);
}


export function assertDependentReviewCurrent(input: { runId: string; workspaceId: string; itemId?: string | null; decisionId: string }): void {
  const run = getRun(input.runId);
  if (!run || run.workspaceId !== input.workspaceId || !['completed', 'completed_with_abstentions'].includes(run.status)) {
    throw new Error('Dependent refresh requires a current completed classification run.');
  }
  if (input.itemId) {
    const item = findItemById(input.itemId);
    if (!item || run.onboardingItemId !== item.id || item.curationData?.classificationRunId !== run.id) {
      throw new Error('Classification run changed while refreshing dependent proposals.');
    }
  }
  const decision = getLiveDecisionsByRun(run.id).find(row => row.id === input.decisionId);
  if (!decision || decision.decision !== 'accepted' || decision.decisionOrigin !== 'human_review') throw new Error('A current human-reviewed Product Type decision is required.');
}

export interface DependentReviewLease { refreshId: string; ownerId: string; alreadyCompleted: boolean }

/** Serialize HTTP, CLI and worker refreshes of one reviewed decision. */
export function claimDependentReviewLease(input: {
  runId: string; workspaceId: string; itemId?: string | null; decisionId: string;
  refreshId?: string; claimedBy?: string | null;
}): DependentReviewLease {
  const db = getDb();
  return db.transaction(() => {
    assertDependentReviewCurrent(input);
    const run = getRun(input.runId)!;
    const id = input.refreshId ?? enqueueRefreshItem({ workspaceId: input.workspaceId, productSku: run.productSku,
      sourceKind: run.sourceKind, onboardingItemId: input.itemId, expectedRunId: run.id,
      triggerType: 'primary_product_type_change', triggerDecisionId: input.decisionId, requestedBy: 'dependent_review' });
    const row = db.query(`SELECT status, claimed_by, claimed_at, expected_run_id, workspace_id FROM classification_refresh_queue WHERE id = ?`)
      .get(id) as { status: string; claimed_by: string | null; claimed_at: string | null; expected_run_id: string; workspace_id: string } | null;
    if (!row || row.expected_run_id !== input.runId || row.workspace_id !== input.workspaceId) throw new Error('Refresh queue scope does not match the reviewed run.');
    if (row.status === 'completed') return { refreshId: id, ownerId: '', alreadyCompleted: true };
    const expired = row.claimed_at != null && Date.parse(row.claimed_at) < Date.now() - 300_000;
    const ownsWorkerClaim = input.refreshId != null && input.claimedBy != null && row.claimed_by === input.claimedBy;
    if (row.status === 'claimed' && !expired && !ownsWorkerClaim) throw new Error('Dependent refresh is already in progress.');
    const ownerId = randomUUID();
    db.run(`UPDATE classification_refresh_queue SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempt_count = attempt_count + 1
      WHERE id = ?`, [ownerId, new Date().toISOString(), id]);
    return { refreshId: id, ownerId, alreadyCompleted: false };
  })();
}

export function assertDependentReviewLease(lease: DependentReviewLease): void {
  const result = getDb().run(`UPDATE classification_refresh_queue SET claimed_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    [new Date().toISOString(), lease.refreshId, lease.ownerId]);
  if (result.changes !== 1) throw new Error('Dependent refresh lost its queue lease.');
}

export function failDependentReviewLease(lease: DependentReviewLease, message: string): void {
  getDb().run(`UPDATE classification_refresh_queue SET status = 'failed', error_message = ?, completed_at = ?, claimed_by = NULL, claimed_at = NULL
    WHERE id = ? AND status = 'claimed' AND claimed_by = ?`, [message, new Date().toISOString(), lease.refreshId, lease.ownerId]);
}

export function supersedeDependentReviewProposals(runId: string, snapshot: RuntimeClassificationSnapshot, refreshId: string, typeId: string, preservedProposalIds: ReadonlySet<string>): void {
  const stmt = getDb().prepare(`UPDATE classification_proposals SET superseded_at = ?, refresh_queue_id = ?, is_stale = 1,
    status = 'stale', staleness_reason = 'Superseded by reviewed Product Type refresh' WHERE id = ? AND superseded_at IS NULL`);
  const at = new Date().toISOString();
  const conditionalUniversalAttributeIds = getConditionalUniversalAttributeIds(snapshot, typeId);
  for (const proposal of listCurrentRunProposals(runId)) {
    if (!preservedProposalIds.has(proposal.id) && isTypeDependentProposal(proposal, snapshot, conditionalUniversalAttributeIds)) stmt.run(at, refreshId, proposal.id);
  }
}

/** Finish the same run's refreshed review projection; type and universal decisions are retained. */
export function finishDependentReviewProjection(input: {
  runId: string; workspaceId: string; itemId?: string | null; refreshId: string;
  typeId: string; decisionId: string; newProposalIds: string[];
  snapshot: RuntimeClassificationSnapshot; lease: DependentReviewLease; commitPreparedStages: () => void;
  preservedProposalIds: ReadonlySet<string>;
  applicability?: unknown;
}): void {
  const db = getDb();
  db.transaction(() => {
    assertDependentReviewCurrent(input);
    assertDependentReviewLease(input.lease);
    supersedeDependentReviewProposals(input.runId, input.snapshot, input.refreshId, input.typeId, input.preservedProposalIds);
    input.commitPreparedStages();
    const dependency = db.prepare(`INSERT OR REPLACE INTO classification_proposal_dependencies
      (workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
      VALUES (?, ?, 'reviewed_product_type', ?, ?, ?)`);
    const at = new Date().toISOString();
    for (const id of input.newProposalIds) {
      db.run('UPDATE classification_proposals SET refresh_queue_id = ? WHERE id = ?', [input.refreshId, id]);
      dependency.run(input.workspaceId, id, input.typeId, hashCanonicalJson({ reviewedProductTypeId: input.typeId }), at);
    }
    db.run(`UPDATE classification_refresh_queue SET status = 'completed', completed_at = ?, outcome_run_id = ?, error_message = NULL
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?`, [at, input.runId, input.lease.refreshId, input.lease.ownerId]);
    if (!input.itemId) return;
    const item = findItemById(input.itemId)!;
    const proposals = listCurrentRunProposals(input.runId);
    const suggestedPages = proposals.filter(p => p.proposalType === 'category_page' && p.status !== 'rejected')
      .map(p => p.proposedValue as { pageName?: string }).map(value => value.pageName).filter(Boolean);
    const pageAbstention = proposals.find(p => p.proposalType === 'reviewable_abstention' && p.targetId === 'category_page_proposals');
    const pageReason = (pageAbstention?.proposedValue as { reason?: string } | null)?.reason ?? null;
    const verifiedIds = input.snapshot.pages.state === 'verified' ? input.snapshot.pages.records.map(page => page.pageId) : [];
    updateItemCurationData(item.id, JSON.stringify({
      ...item.curationData,
      classificationProposals: proposals,
      classificationEvidence: getEvidenceByRun(input.runId),
      classificationDecisions: getLiveDecisionsByRun(input.runId),
      suggestedPages,
      ...(Array.isArray(input.applicability) ? { attributeApplicability: input.applicability } : {}),
      effectiveProductType: { id: input.typeId, source: 'reviewed' },
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: input.snapshot.curationTargets.some(target => target.enabled && target.kind === 'page') && input.snapshot.pages.state !== 'verified',
        verifiedPageCount: verifiedIds.length, verifiedPageIdSet: verifiedIds, reason: pageReason, snapshotHash: input.snapshot.snapshotHash },
    }));
  })();
}
