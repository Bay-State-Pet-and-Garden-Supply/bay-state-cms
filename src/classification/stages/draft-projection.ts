import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { readProductFile } from '../../git/workspace-files';
import { buildAssignmentProjection, createAssignmentProjectionAuthority, getEffectiveProposalTargetId, getEffectiveProposalValue } from '../assignment-projection';

/**
 * Product Draft Projection Stage
 *
 * Produces a preview of the final product draft fields that would result
 * from applying accepted proposals. Pending suggestions are returned only
 * in explicitly provisional metadata, never mixed into approved fields/pages.
 * This includes:
 * - Approved fields, taxonomy additions and reviewed removals
 * - Separately labeled provisional fields/pages, without approval authority
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

    if (!context.snapshot) {
      return { status: 'failed', error: 'Classification snapshot authority is required for draft projection.' };
    }


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

    const snapshot = context.snapshot;
    const mappings = snapshot.attributeMappings;
    // Existing local product state is the projection baseline, not new
    // classification evidence. In particular an onboarding update must use
    // the same no-narrowing baseline as its final local draft adapter.
    const existingProduct = readProductFile(context.workspacePath, input.sku);
    const currentFields: Record<string, string> = { ...(existingProduct?.customFields ?? {}) };
    const mappedFields = new Set(mappings.map(mapping => mapping.catalogField));
    for (const evidence of input.evidence) {
      if (evidence.source === 'catalog_product' && evidence.sourceField
        && mappedFields.has(evidence.sourceField) && typeof evidence.value === 'string') {
        if (!existingProduct) currentFields[evidence.sourceField] = evidence.value;
      }
    }
    const currentPages = existingProduct?.core.productOnPages ?? input.evidence
      .filter(evidence => evidence.source === 'page_context' && evidence.sourceField === 'page_name' && typeof evidence.value === 'string')
      .map(evidence => String(evidence.value));
    const verifiedPages = snapshot.pages.state === 'verified'
      ? snapshot.pages.records.filter(page => page.verified) : [];
    const verifiedIds = new Set(verifiedPages.map(page => page.pageId));
    const authority = createAssignmentProjectionAuthority(snapshot);
    const approved = buildAssignmentProjection(accepted, currentFields, currentPages, mappings, verifiedIds, authority);
    const blocked = approved.skipped.length > 0;
    const fieldAssignments: Record<string, string> = {};
    if (!blocked) {
      for (const field of approved.fields) fieldAssignments[field.catalogField] = field.proposedValue;
    }

    const acceptedTargets = new Set(accepted.map(getEffectiveProposalTargetId));
    const acceptedPages = new Set([
      ...approved.pages.additions.map(page => page.pageId),
      ...approved.pages.removals.map(page => page.pageId),
    ]);
    const pending = allProposals.filter(proposal => proposal.status === 'pending' && !proposal.isStale
      && !acceptedTargets.has(getEffectiveProposalTargetId(proposal))
      && !acceptedPages.has(getEffectiveProposalTargetId(proposal) ?? ''));
    const provisional = buildAssignmentProjection(pending, currentFields, currentPages, mappings, verifiedIds, authority);
    const provisionalFieldAssignments: Record<string, string> = {};
    for (const field of provisional.fields) {
      if (!approved.fields.some(acceptedField => acceptedField.catalogField === field.catalogField)) {
        provisionalFieldAssignments[field.catalogField] = field.proposedValue;
      }
    }
    const pendingSupplement = pending.filter(proposal => proposal.proposalType === 'field_assignment')
      .flatMap(proposal => {
        const targetId = getEffectiveProposalTargetId(proposal);
        const field = mappings.find(mapping => mapping.attributeId === targetId)?.catalogField;
        return targetId && field && Object.prototype.hasOwnProperty.call(provisionalFieldAssignments, field)
          && !provisional.skipped.some(refusal => refusal.proposalId === proposal.id)
          ? [{ targetId, value: getEffectiveProposalValue(proposal), confidence: proposal.confidence }]
          : [];
      });
    const message = blocked
      ? `Approved projection refused: ${approved.skipped.map(refusal => `${refusal.proposalId}: ${refusal.reason}`).join('; ')}`
      : `${approved.fields.length} approved field assignments, ${approved.pages.additions.length} approved page assignments, ${approved.pages.removals.length} approved page removals projected.`;
    const output = {
      evidence: [],
      proposals: [],
      abstained: blocked,
      message: message + ` ${pendingSupplement.length} provisional field suggestions, ${provisional.pages.additions.length} provisional page suggestions (not approved).` + (projectedTitle ? ` Title source: ${projectedTitle.source}.` : ''),
      metadata: {
        projection: {
          fieldAssignments,
          pageAssignments: blocked ? [] : approved.pages.additions.map(page => page.pageName),
          removedPages: blocked ? [] : approved.pages.removed,
          acceptedProposalCount: accepted.length,
          hasAcceptedAssignments: !blocked && accepted.length > 0,
          selectionMode: blocked ? 'refused' : accepted.length > 0 ? 'accepted' : 'provisional_preview',
          refusals: approved.skipped,
          provisionalFieldAssignments,
          pendingPageAssignments: provisional.pages.additions.map(page => page.pageName),
          pendingRemovedPages: provisional.pages.removed,
          pendingSupplementCount: pendingSupplement.length,
          pendingSupplement,
          provisionalRefusals: provisional.skipped,
          title: projectedTitle,
        },
      },
    };
    return blocked ? { status: 'abstained', reason: message, output } : { status: 'succeeded', output };
  },
};
