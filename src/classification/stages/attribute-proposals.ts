/**
 * Product Attribute Proposals Stage (issue #351 SKU-local evidence).
 *
 * Thin wrapper around the shared curation target engine. Processes
 * only enabled product-field curation targets through the shared
 * resolver → matcher → ranker → proposal builder pipeline.
 *
 * Gating (identical to the applicability stage):
 * - A pending (unreviewed) Primary Product Type guess produces NO
 *   decision-eligible type-gated attribute proposals.
 * - Universal attributes proceed without a Product Type.
 * - Profile attributes require the member's OWN reviewed effective
 *   Product Type and membership in that type's profile. No execution
 *   fallback — missing own-SKU evidence stays unresolved.
 * - When no product_type target is enabled, attributes are un-gated.
 *
 * A Product Type with `attributeProfileId: null` is a legitimately
 * EMPTY profile: universal attributes may proceed, every non-universal
 * type-gated attribute is `not_applicable` — never "all fields".
 *
 * Per-Product-Type cardinality comes from the accepted type's profile
 * (not a global target selectionMode) and is passed to the shared
 * processor so multi-value proposals use validated field-specific shapes.
 *
 * Dependencies: attribute_applicability stage.
 */
import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { processProductFieldTarget, processProductFieldTargetsBatch } from '../curation-target-processor';
import { getEffectiveCurationProductType, resolveEffectiveTypeProfile } from '../effective-curation-type';
import { getUniversalTierFlags } from '../flags';
import { getCachedAttributeProfiles, getCachedProductTypes } from '../../db/repositories/classification-config-repo';
import { evaluateAttributeApplicability } from './attribute-applicability';
import { resolveProductTypeInvariants } from '../product-type-invariants';
import { isUniversalAttribute } from '../applicability-evaluator';
/**
 * P1 #9 proposal-time check: true when the product's current slot for this
 * attribute already holds multiple pipe-delimited values. Custom-field
 * evidence rows carry the live slot value verbatim (source catalog_product
 * or spreadsheet under the mapped catalog field).
 */
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
    const resolved = context.snapshot
      ? resolveTargetsFromSnapshot(context.snapshot)
      : resolveEnabledTargets(loadClassificationConfig(context.workspacePath), context.workspaceId);

    // If no enabled product-field targets exist, return succeeded (not abstained)
    if (resolved.productFields.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'No product-field curation targets are enabled.',
        },
      };
    }

    const typeTargetEnabled = resolved.productTypes.length > 0;
    const { effectiveTypeId, source } = getEffectiveCurationProductType(input, context);

    const profiles = context.snapshot
      ? context.snapshot.attributeProfiles
      : getCachedAttributeProfiles(context.workspaceId);
    // SKU-local path (issue #351): authoritative direction (frozen Product
    // Type -> attributeProfileId -> profile.id), fail closed on a missing
    // declared profile; attributeProfileId: null is EMPTY (universal-only).
    const profile = resolveEffectiveTypeProfile(
      effectiveTypeId,
      profiles,
      context.snapshot !== undefined,
      context.snapshot,
    );
    const profileAttributeIds = profile
      ? new Set(profile.attributes.map(entry => entry.attributeId))
      : null;

    // Only targets whose applicability is 'applicable' may produce
    // decision-eligible proposals. Unknown (pending type) and not_applicable
    // targets are withheld.
    const gated: Array<{ target: (typeof resolved.productFields)[number]; cardinality: 'single' | 'multiple' }> = [];

    for (const target of resolved.productFields) {
      if (!target.attribute) continue;
      const attribute = target.attribute;
      if (context.dependentReviewRefresh && isUniversalAttribute(attribute)) continue;
      const profileEntry = profile?.attributes.find(entry => entry.attributeId === attribute.id);
      const evaluation = evaluateAttributeApplicability({
        attribute,
        profileAttributeIds,
        conditions: profileEntry?.applicabilityConditions ?? [],
        acceptedTypeId: effectiveTypeId,
        typeTargetEnabled,
        reviewedFacts: context.snapshot?.reviewedFacts ?? [],
        // P3 widened universal tier (plan B.P3.1): flag OFF (default) passes
        // false — byte-identical legacy gating.
        widenedUniversal: getUniversalTierFlags().universalTierWideningEnabled,
      });
      if (evaluation.state !== 'applicable') continue;

      // P1 #9 proposal-time no-narrowing: where the current slot already
      // holds multiple values, abstain as already-populated rather than
      // proposing a partial replacement. The stage emits a review-visible
      // message; the matching proposal never materializes. Empty slots
      // still accept grounded values.
      if (isAlreadyPopulatedMultiValue({ input, attribute })) continue;

      // Per-Product-Type cardinality wins over the global target mode when a
      // profile entry exists; otherwise the target's own selection mode.
      const cardinality = profileEntry?.cardinality ?? target.config.selectionMode ?? 'single';
      gated.push({ target, cardinality });
    }
    if (gated.length === 0) {
      // e04s01: fail-closed with explicit abstention — silent "succeeded" with
      // zero proposals made the review panel indistinguishable from
      // "correctly empty". Now we emit a reviewable_abstention so the UI can
      // surface applicability reasons and gating provenance.
      const blockedReason =
        effectiveTypeId === null && typeTargetEnabled
          ? 'No Product Classification (reviewed or provisional); type-gated attribute proposals are withheld until the pair is proposed.'
          : 'No applicable product-field targets for the Product Classification.';
      return {
        status: 'abstained',
        reason: blockedReason,
        output: {
          evidence: [],
          proposals: [],
          abstained: true,
          message: blockedReason,
          metadata: {
            gated: true,
            acceptedTypeId: effectiveTypeId,
            typeTargetEnabled,
            effectiveTypeId,
            effectiveTypeSource: source,
          },
        },
      };
    }

    // Invariant attributes from the Effective Product Type resolve deterministically
    // first (zero LLM calls) and are removed from the variable target loop.
    const productTypes = context.snapshot
      ? context.snapshot.productTypes
      : getCachedProductTypes(context.workspaceId);

    const { invariantProposals, remainingGatedTargets } = resolveProductTypeInvariants({
      effectiveTypeId,
      effectiveTypeSource: source,
      gatedTargets: gated,
      productTypes: productTypes as unknown as Parameters<typeof resolveProductTypeInvariants>[0]['productTypes'],
      evidence: input.evidence ?? [],
      runId: context.runId,
      sku: input.sku,
      snapshotHash: context.snapshot?.snapshotHash,
    });

    const allProposals: ClassificationProposal[] = [...invariantProposals];
    const messages: string[] = [];

    // Process remaining variable targets through the shared batch engine
    const batchResult = await processProductFieldTargetsBatch(remainingGatedTargets, input, context);
    allProposals.push(...batchResult.proposals);
    if (batchResult.messages.length > 0) messages.push(...batchResult.messages);

    if (allProposals.length === 0) {
      return {
        status: 'abstained',
        reason: messages.length > 0
          ? `No attribute value matches found: ${messages.join('; ')}`
          : 'No attribute value matches found from available evidence.',
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: allProposals,
        abstained: false,
      },
    };
  },
};
