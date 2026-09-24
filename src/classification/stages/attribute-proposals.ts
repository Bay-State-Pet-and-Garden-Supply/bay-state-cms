/**
 * Product Attribute Proposals Stage
 *
 * Thin wrapper around the shared curation target engine. Processes
 * only enabled product-field curation targets through the shared
 * resolver → matcher → ranker → proposal builder pipeline.
 *
 * Gating (identical to the applicability stage):
 * - A pending (unreviewed) Primary Product Type guess produces NO
 *   decision-eligible type-gated attribute proposals.
 * - Universal attributes proceed without a Product Type.
 * - Profile attributes require an effective Product Type (the reviewed
 *   accepted type first, the frozen cohort Execution Product Type as fallback)
 *   and membership in that type's profile (PR5).
 * - When no product_type target is enabled, attributes are un-gated.
 *
 * The profile is resolved from the frozen runtime snapshot only — never from
 * the live config cache when a cohort execution type is present (fail-closed
 * guard). A Product Type with `attributeProfileId: null` is a legitimately
 * EMPTY profile: universal attributes may proceed, every non-universal
 * type-gated attribute is `not_applicable` — never "all fields" (PR5 P1-1).
 * Flag OFF / legacy runs carry no execution type and gate exactly as
 * today.
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

export const productAttributeProposalsStage: StageDefinition = {
  name: 'product_attribute_proposals',
  requires: ['attribute_applicability'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    // PR5 fail-closed guard (architecture pillar 2): the effective-type path
    // resolves profiles/targets EXCLUSIVELY from the frozen runtime snapshot.
    // An execution type with a missing snapshot would silently fall back to
    // the live config cache — never allowed.
    if (context.cohortExecutionType !== undefined && context.snapshot === undefined) {
      throw new Error(
        'effective-type path requires the frozen runtime snapshot; live config is never read with an execution type',
      );
    }

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
    // PR5 P1-1: the effective path resolves the profile in the AUTHORITATIVE
    // direction (frozen Product Type -> attributeProfileId -> profile.id) and
    // fails closed on a missing declared profile; attributeProfileId: null is
    // a legitimately EMPTY profile (universal-only, never 'all fields'). The
    // legacy path (no cohort execution type) stays byte-identical.
    const profile = resolveEffectiveTypeProfile(
      effectiveTypeId,
      profiles,
      context.cohortExecutionType !== undefined,
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
      const sourceSuffix =
        source === 'execution' ? ' (driven by cohort execution Product Type.)' : '';
      const blockedReason =
        effectiveTypeId === null && typeTargetEnabled
          ? 'No reviewed Primary Product Type; type-gated attribute proposals are withheld until the type is accepted.'
          : `No applicable product-field targets for the accepted Product Type.${sourceSuffix}`;
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
      productTypes: productTypes as any,
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
