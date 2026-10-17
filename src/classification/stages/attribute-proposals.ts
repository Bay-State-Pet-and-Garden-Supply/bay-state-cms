/**
 * Frozen profile-constrained attribute proposals (issue #359).
 * Both consumers use attribute-profile-plan for the same own-SKU canonical
 * pair and captured rules. No live cache, disabled-type un-gating, widened
 * profile fallback, or independently generated core-field writer exists here.
 * The existing processor/safety owners retain allowed/measured value checks,
 * explicit claim evidence, provider dispatch and reviewed-only decisions.
 */
import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { processProductFieldTargetsBatch } from '../curation-target-processor';
import { getEffectiveClassification } from '../effective-curation-type';
import { resolveAttributeProfilePlan } from '../attribute-profile-plan';
import { composeEffectiveReviewedFacts } from '../reviewed-facts';
import { resolveProductTypeInvariants } from '../product-type-invariants';
import { isUniversalAttribute } from '../applicability-evaluator';
import { getEffectiveProposalTargetId } from '../assignment-projection';

/** Preserve a populated multi-valued slot instead of proposing a subset. */
function isAlreadyPopulatedMultiValue(input: {
  input: StageInput;
  attribute: { id: string };
}): boolean {
  const { input: stageInput, attribute } = input;
  for (const record of stageInput.evidence) {
    if (record.source !== 'catalog_product' && record.source !== 'spreadsheet') continue;
    const field = (record.sourceField ?? '').toLocaleLowerCase();
    if (!field.includes(attribute.id.toLocaleLowerCase()) && field !== attribute.id.toLocaleLowerCase()) continue;
    const raw = typeof record.value === 'string' ? record.value : '';
    if (raw.split('|').map(p => p.trim()).filter(Boolean).length > 1) return true;
  }
  return false;
}


export const productAttributeProposalsStage: StageDefinition = {
  name: 'product_attribute_proposals',
  requires: ['attribute_applicability'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const classification = getEffectiveClassification(input, context);
    const plan = resolveAttributeProfilePlan(context.snapshot, {
      categoryId: classification.effectiveCategoryId,
      productTypeId: classification.effectiveTypeId,
    }, composeEffectiveReviewedFacts(context.snapshot, input.acceptedProposals, context.runId));
    if (!context.snapshot) return { status: 'abstained', reason: plan.reason! };
    const resolved = resolveTargetsFromSnapshot(context.snapshot);
    const entriesById = new Map(plan.entries.map(entry => [entry.attribute.id, entry]));
    const acceptedFieldIds = new Set(input.acceptedProposals
      .filter(proposal => proposal.proposalType === 'field_assignment' && proposal.status === 'accepted')
      .map(proposal => getEffectiveProposalTargetId(proposal)));
    const gated: Array<{ target: (typeof resolved.productFields)[number]; cardinality: 'single' | 'multiple' }> = [];
    for (const target of resolved.productFields) {
      const entry = target.attribute && entriesById.get(target.attribute.id);
      if (!entry || entry.applicability.state !== 'applicable') continue;
      if (context.dependentReviewRefresh && acceptedFieldIds.has(entry.attribute.id)) continue;
      if (context.dependentReviewRefresh && isUniversalAttribute(entry.attribute)
        && (entry.rule?.applicabilityConditions.length ?? 0) === 0) continue;
      if (isAlreadyPopulatedMultiValue({ input, attribute: entry.attribute })) continue;
      gated.push({ target, cardinality: entry.cardinality });
    }
    if (gated.length === 0) {
      if (plan.status === 'ready' && resolved.productFields.length === 0) {
        return { status: 'succeeded', output: { evidence: [], proposals: [], abstained: false, message: 'No product-field curation targets are enabled.' } };
      }
      const blocked = plan.entries.filter(entry => entry.applicability.state === 'unknown')
        .map(entry => `${entry.attribute.id}: ${entry.applicability.reason}`);
      return {
        status: 'abstained',
        reason: plan.reason ?? (blocked.length > 0 ? blocked.join('; ') : 'No applicable product-field targets for the Product Classification.'),
        output: { evidence: [], proposals: [], abstained: true, metadata: {
          gated: true, effectiveTypeId: classification.effectiveTypeId, effectiveTypeSource: classification.source,
          profileId: plan.profileId, profileStatus: plan.status,
        } },
      };
    }

    const { invariantProposals, remainingGatedTargets } = resolveProductTypeInvariants({
      // An unresolved pair may still admit explicitly universal attributes,
      // but can never imply invariant values from an invalid Type premise.
      effectiveTypeId: plan.status === 'ready' ? classification.effectiveTypeId : null,
      effectiveTypeSource: classification.source,
      gatedTargets: gated,
      productTypes: context.snapshot.productTypes,
      evidence: input.evidence,
      runId: context.runId,
      sku: input.sku,
      snapshotHash: context.snapshot.snapshotHash,
    });
    const allProposals: ClassificationProposal[] = [...invariantProposals];
    const batchResult = await processProductFieldTargetsBatch(remainingGatedTargets, input, context);
    allProposals.push(...batchResult.proposals);
    if (allProposals.length === 0) {
      return {
        status: 'abstained',
        reason: batchResult.messages.length > 0
          ? `No attribute value matches found: ${batchResult.messages.join('; ')}`
          : 'No attribute value matches found from available evidence.',
      };
    }
    return { status: 'succeeded', output: { evidence: [], proposals: allProposals, abstained: false } };
  },
};
