import type { StageDefinition, StageContext, StageInput, StageOutput, StageResult } from '../types';
import { ClassificationDraftProjectionPreviewSchema, type ClassificationDraftProjectionPreview } from '../../shared/schemas/classification';
import { snapshotHash } from '../runtime-snapshot';
import { readProductFile } from '../../git/workspace-files';
import { buildAssignmentProjection, createAssignmentProjectionAuthority } from '../assignment-projection';
import { getEffectiveProposalTargetId, getEffectiveProposalValue } from '../effective-proposal';
import { getCachedClassificationOutputBindings } from '../../db/repositories/classification-config-repo';

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
    const authority = createAssignmentProjectionAuthority(
      snapshot,
      undefined,
      getCachedClassificationOutputBindings(context.workspaceId),
    );
    const reviewContext = { reviewedProposals: accepted, currentRunProposals: allProposals };
    const approved = buildAssignmentProjection(
      accepted, currentFields, currentPages, mappings, verifiedIds, authority, reviewContext,
    );
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
    const provisional = buildAssignmentProjection(
      pending, currentFields, currentPages, mappings, verifiedIds, authority, reviewContext,
    );
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

type CurrentDraftProjectionInput = {
  sku: string;
  expectedSnapshotHash: string | null;
  sourceKind?: StageInput['sourceKind'];
  onboardingItemId?: string;
  evidence: StageInput['evidence'];
  acceptedProposals: StageInput['acceptedProposals'];
  proposals: StageInput['allProposals'];
  stageResults: readonly { stage_name?: unknown; output_json?: unknown }[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function refusalList(value: unknown): Array<{ proposalId: string; targetId: string | null; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record && typeof record.proposalId === 'string'
      && (typeof record.targetId === 'string' || record.targetId === null)
      && typeof record.reason === 'string'
      ? [{ proposalId: record.proposalId, targetId: record.targetId, reason: record.reason }]
      : [];
  });
}

function previewFromStageResult(result: StageResult): ClassificationDraftProjectionPreview {
  if (result.status === 'failed') {
    return ClassificationDraftProjectionPreviewSchema.parse({
      status: 'failed',
      message: null,
      error: result.error,
      projection: null,
    });
  }
  const output = result.output;
  if (!output) {
    return ClassificationDraftProjectionPreviewSchema.parse({
      status: 'abstained',
      message: result.status === 'abstained' ? result.reason : null,
      error: null,
      projection: null,
    });
  }

  const projection = asRecord(output.metadata?.projection);
  const rawTitle = asRecord(projection?.title);
  return ClassificationDraftProjectionPreviewSchema.parse({
    status: result.status,
    message: result.status === 'abstained' ? result.reason : output.message ?? null,
    error: null,
    projection: projection ? {
      fieldAssignments: stringRecord(projection.fieldAssignments),
      pageAssignments: stringList(projection.pageAssignments),
      removedPages: stringList(projection.removedPages),
      selectionMode: projection.selectionMode,
      refusals: refusalList(projection.refusals),
      provisionalFieldAssignments: stringRecord(projection.provisionalFieldAssignments),
      pendingPageAssignments: stringList(projection.pendingPageAssignments),
      pendingRemovedPages: stringList(projection.pendingRemovedPages),
      provisionalRefusals: refusalList(projection.provisionalRefusals),
      title: rawTitle && typeof rawTitle.value === 'string' && typeof rawTitle.source === 'string'
        ? { value: rawTitle.value, source: rawTitle.source }
        : null,
    } : null,
  });
}

function restoredNameConsolidationOutput(
  stageResults: CurrentDraftProjectionInput['stageResults'],
): StageOutput | undefined {
  let output: StageOutput | undefined;
  for (const row of stageResults) {
    if (row.stage_name !== 'name_consolidation' || typeof row.output_json !== 'string') continue;
    try {
      const parsed = asRecord(JSON.parse(row.output_json));
      const metadata = asRecord(parsed?.metadata);
      if (metadata) output = { evidence: [], proposals: [], abstained: false, metadata };
    } catch {
      // A malformed historical stage result must not prevent field projection.
    }
  }
  return output;
}

/**
 * Recomputes the user-facing draft projection from the run's frozen authority
 * and current reviewer decisions. Persisted stage rows remain historical.
 */
export async function projectCurrentReviewedDraft(
  input: CurrentDraftProjectionInput,
  context: StageContext,
): Promise<ClassificationDraftProjectionPreview> {
  const snapshot = context.snapshot;
  if (
    !snapshot
    || input.expectedSnapshotHash === null
    || snapshot.snapshotHash !== input.expectedSnapshotHash
    || snapshotHash(snapshot) !== input.expectedSnapshotHash
    || snapshot.workspaceId !== context.workspaceId
    || snapshot.productSku !== input.sku
  ) {
    return ClassificationDraftProjectionPreviewSchema.parse({
      status: 'failed',
      message: null,
      error: 'Frozen classification authority is unavailable or does not match this run.',
      projection: null,
    });
  }

  const acceptedProposals = input.acceptedProposals;
  const stageOutputs = {
    name_consolidation: restoredNameConsolidationOutput(input.stageResults),
  };
  const result = await productDraftProjectionStage.execute({
    sku: input.sku,
    sourceKind: input.sourceKind,
    onboardingItemId: input.onboardingItemId,
    evidence: input.evidence,
    acceptedProposals,
    allProposals: input.proposals,
    stageOutputs,
  }, context);
  return previewFromStageResult(result);
}
