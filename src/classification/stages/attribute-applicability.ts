/**
 * Frozen Attribute Applicability (issue #359).
 * Same-pass own-SKU provisional pairs select their declared profile without
 * acceptance; compatible reviewed authority retains precedence. The shared
 * plan owns pair validity, membership and configured conditions. Missing
 * authority is persisted as an attributable abstention, never live-cache or
 * "no profile constraint" execution. Explicit empty profiles remain valid.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { getEffectiveClassification } from '../effective-curation-type';
import { resolveAttributeProfilePlan } from '../attribute-profile-plan';
import { composeEffectiveReviewedFacts } from '../reviewed-facts';

export const attributeApplicabilityStage: StageDefinition = {
  name: 'attribute_applicability',
  requires: ['primary_product_type_proposal'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const classification = getEffectiveClassification(input, context);
    const plan = resolveAttributeProfilePlan(context.snapshot, {
      categoryId: classification.effectiveCategoryId,
      productTypeId: classification.effectiveTypeId,
    }, composeEffectiveReviewedFacts(context.snapshot, input.acceptedProposals, context.runId));
    const resolved = context.snapshot ? resolveTargetsFromSnapshot(context.snapshot) : null;
    const targetIds = new Set(resolved?.productFields.map(target => target.attribute?.id) ?? []);
    const evaluations = plan.entries.filter(entry => targetIds.has(entry.attribute.id)).map(entry => entry.applicability);
    const metadata = {
      applicability: evaluations,
      acceptedTypeId: classification.effectiveTypeId,
      typeTargetEnabled: (resolved?.productTypes.length ?? 0) > 0,
      effectiveTypeId: classification.effectiveTypeId,
      effectiveTypeSource: classification.source,
      effectiveCategoryId: classification.effectiveCategoryId,
      profileId: plan.profileId,
      profileStatus: plan.status,
      profileReason: plan.reason,
    };
    if (plan.status !== 'ready') {
      return { status: 'abstained', reason: plan.reason!, output: { evidence: [], proposals: [], abstained: true, metadata } };
    }
    const counts = (state: string) => evaluations.filter(evaluation => evaluation.state === state).length;
    return {
      status: 'succeeded',
      output: {
        evidence: [], proposals: [], abstained: false,
        message: `${counts('applicable')} attributes applicable, ${counts('unknown')} blocked by undecided conditions, ${counts('not_applicable')} not applicable for ${classification.effectiveTypeId}.`,
        metadata,
      },
    };
  },
};
