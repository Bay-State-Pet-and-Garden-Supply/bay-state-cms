import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { getCachedAttributeMappings } from '../../db/repositories/classification-config-repo';
import { getEffectiveProposalTargetId, getEffectiveProposalValue, serializeAttributeValue } from '../assignment-projection';
import { getPageDisplayName, isRemovalIntent, pageNameFromPageValue } from '../../shared/proposal-display';
import { isBrandPageProposal, isProtectedTargetId } from '../classification-ownership';

/**
 * Product Draft Projection Stage
 *
 * Produces a preview of the final product draft fields that would result
 * from applying all accepted (or, before review, all pending) proposals.
 * This includes:
 * - Field assignments mapped to Catalog Fields (accepted first, then pending)
 * - Category page assignments (accepted first, then pending)
 *
 * This is the final classification stage before product draft creation.
 * No actual product files are modified — this is a preview only.
 *
 * PR8 C1 (DECISION-A): the curated title is a DECLARED projection input —
 * `name_consolidation` runs before this stage and the projection metadata
 * carries the SAME title the curationData assembly reads
 * (`input.stageOutputs.name_consolidation.metadata`, never a re-derivation).
 * In active cohort mode that output is the parent-coordinated title; in
 * legacy mode it is the per-member consolidated title.
 *
 * IMPORTANT: This stage does NOT persist proposals. The projection is
 * returned as stage output metadata and consumed by the Review UI.
 * The downstream `draft-promoter.ts` reads accepted proposals directly
 * from the classification_proposals table via `getAcceptedProposals()`.
 */
export const productDraftProjectionStage: StageDefinition = {
  name: 'product_draft_projection',
  requires: ['name_consolidation', 'category_page_proposals', 'product_attribute_proposals'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const accepted = input.acceptedProposals;
    const allProposals = input.allProposals;

    // Issue #351 (SKU-local evidence): no execution-type context exists —
    // the stage resolves mappings from the frozen snapshot when present,
    // else the live cache (unchanged fallback).


    // PR8 C1 (DECISION-A): the coordinated/consolidated title + its source
    // from the `name_consolidation` stage output — the SAME source the
    // curationData assembly reads. Absent output (a stage invoked in
    // isolation, or a non-standard pipeline) yields `title: null`, never a
    // crash.
    const nameMeta = input.stageOutputs?.name_consolidation?.metadata as
      | Record<string, unknown>
      | undefined;
    const projectedTitle =
      typeof nameMeta?.curatedTitle === 'string' && nameMeta.curatedTitle.length > 0
        ? {
            value: nameMeta.curatedTitle,
            source: (typeof nameMeta.titleSource === 'string' ? nameMeta.titleSource : 'web') as string,
          }
        : null;

    const mappings = context.snapshot
      ? context.snapshot.attributeMappings
      : getCachedAttributeMappings(context.workspaceId);

    // Build a set of target IDs already covered by accepted proposals
    // so we don't double-count when including pending ones.
    const acceptedTargetIds = new Set(
      accepted
        .filter(p => p.proposalType === 'field_assignment' && p.targetId)
        .map(p => p.targetId!),
    );

    // Collect field assignments from accepted proposals first,
    // then supplement with pending proposals for preview.
    const fieldAssignments: Record<string, unknown> = {};
    const pendingSupplement: Array<{ targetId: string; value: unknown; confidence: number }> = [];

    // The ONE shared serializer: preview, onboarding promotion, and catalog
    // application all use serializeAttributeValue so a value serializes
    // identically across every surface.
    const applyMapping = (proposal: any, mapping: any): unknown => {
      const value = getEffectiveProposalValue(proposal);
      return serializeAttributeValue(value, mapping.serialization);
    };

    // Process accepted proposals
    for (const proposal of accepted) {
      if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;
      // ADR 0041 / issue #349: the accepted preview and the resulting draft
      // agree — protected targets never project, even via revised targets.
      if (isProtectedTargetId(getEffectiveProposalTargetId(proposal)) || isProtectedTargetId(proposal.targetId)) continue;
      const mapping = mappings.find(m => m.attributeId === proposal.targetId);
      if (!mapping || mapping.isStale) continue;
      fieldAssignments[mapping.catalogField] = applyMapping(proposal, mapping);
    }

    // Supplement with pending proposals for preview (not yet reviewed)
    for (const proposal of allProposals) {
      if (
        proposal.proposalType !== 'field_assignment' ||
        !proposal.targetId ||
        acceptedTargetIds.has(proposal.targetId)
      ) continue;
      if (proposal.status !== 'pending' || proposal.isStale) continue;
      if (isProtectedTargetId(getEffectiveProposalTargetId(proposal)) || isProtectedTargetId(proposal.targetId)) continue;

      const mapping = mappings.find(m => m.attributeId === proposal.targetId);
      if (!mapping || mapping.isStale) continue;

      // Don't override an accepted value; only add if not already set
      if (fieldAssignments[mapping.catalogField] === undefined) {
        fieldAssignments[mapping.catalogField] = applyMapping(proposal, mapping);
        pendingSupplement.push({ targetId: proposal.targetId, value: proposal.proposedValue, confidence: proposal.confidence });
      }
    }

    // Collect accepted category page assignments, then supplement with pending.
    // Page display names come from proposedValue.pageName (never the target
    // Page ID — issue #17 D1). Issue #353: accepted explicit removals are
    // surfaced as `removedPages` (before names) so the accepted preview and
    // the resulting draft agree; Brand pages never project (outside owned
    // scope — refused at review, skipped here too).
    const pageAssignments: string[] = [];
    const removedPages: string[] = [];
    for (const proposal of accepted) {
      if (proposal.proposalType !== 'category_page') continue;
      if (isRemovalIntent(proposal as unknown as { hasRevisedValue?: boolean; revisedValue?: unknown })) {
        const beforeName = pageNameFromPageValue((proposal as unknown as { proposedValue?: unknown }).proposedValue);
        if (beforeName && !isBrandPageProposal(beforeName) && !removedPages.includes(beforeName)) removedPages.push(beforeName);
        continue;
      }
      const pageName = getPageDisplayName(proposal as unknown as Parameters<typeof getPageDisplayName>[0]);
      if (pageName && !isBrandPageProposal(pageName)) pageAssignments.push(pageName);
    }

    const pendingPageAssignments: string[] = [];
    if (pageAssignments.length === 0) {
      for (const proposal of allProposals) {
        if (proposal.proposalType !== 'category_page') continue;
        if (proposal.status !== 'pending' || proposal.isStale) continue;
        const pageName = getPageDisplayName(proposal as unknown as Parameters<typeof getPageDisplayName>[0]);
        if (pageName && !isBrandPageProposal(pageName)) pendingPageAssignments.push(pageName);
      }
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [],  // No synthetic proposals — projection is metadata-only
        abstained: false,
        message: `${Object.keys(fieldAssignments).length} field assignments, ${
          pendingPageAssignments.length > 0 ? pendingPageAssignments.length : pageAssignments.length
        } page assignments projected.` +
          (projectedTitle ? ` Title source: ${projectedTitle.source}.` : ''),
        metadata: {
          projection: {
            fieldAssignments,
            pageAssignments:
              pendingPageAssignments.length > 0
                ? pendingPageAssignments
                : pageAssignments,
            removedPages,
            acceptedProposalCount: accepted.length,
            pendingSupplementCount: pendingSupplement.length,
            hasAcceptedAssignments: accepted.length > 0,
            selectionMode:
              accepted.length > 0 ? 'accepted' : 'provisional_preview',
            pendingSupplement,
            // PR8 C1 (DECISION-A): the curated title the final product draft
            // will carry, sourced from the `name_consolidation` stage output
            // ({value, source}). Null when no name_consolidation output is
            // present.
            title: projectedTitle,
          },
        },
      },
    };
  },
};
