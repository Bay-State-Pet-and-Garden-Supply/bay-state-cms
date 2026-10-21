/**
 * Canonical item-local name stage. Candidate construction and selection are
 * bound to the current immutable AcceptedItemEvidence snapshot only.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { resolveNameSelection, toNameDecision } from '../name-decision';
import type { NameSelectionResult } from '../name-decision';
import { acceptedItemNameSpans } from '../name-candidates';
import { acceptedEvidenceToClassificationEvidence, getCurrentItemEvidenceView } from '../../onboarding/item-evidence';
import { hashCanonicalJson } from '../../shared/stable-id';
import { NAME_NORMALIZATION_VERSION } from '../name-candidates';
import type { ModelPolicyView } from '../model-policy-gateway';
import type { RuntimeClassificationSnapshot } from '../runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';

export interface AcceptedItemNameSelection {
  status: 'resolved' | 'abstained' | 'failed' | 'stale' | 'unavailable' | 'conflict';
  evidenceId: string | null;
  evidenceRevision: number | null;
  evidenceHash: string | null;
  currentnessHash: string | null;
  callIds: string[];
  selection: NameSelectionResult | null;
  reason: string | null;
}

/** Resolve a name only from the live accepted snapshot for this item. */
export async function selectAcceptedItemName(input: {
  workspaceId: string;
  itemId: string;
  runId: string;
  modelPolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null;
  assertHeld?: () => void;
}): Promise<AcceptedItemNameSelection> {
  input.assertHeld?.();
  const view = getCurrentItemEvidenceView(input.workspaceId, input.itemId);
  if (view.status === 'stale') return { status: 'stale', evidenceId: null, evidenceRevision: null, evidenceHash: null, currentnessHash: null, callIds: [], selection: null, reason: 'Accepted item evidence is stale.' };
  if (view.status === 'conflict') return { status: 'conflict', evidenceId: null, evidenceRevision: null, evidenceHash: null, currentnessHash: null, callIds: [], selection: null, reason: 'Accepted item evidence has unresolved conflicts.' };
  if (view.status !== 'accepted' || !view.evidence) return { status: 'unavailable', evidenceId: null, evidenceRevision: null, evidenceHash: null, currentnessHash: null, callIds: [], selection: null, reason: 'Current accepted item evidence is unavailable.' };
  const accepted = view.evidence;
  if (accepted.workspaceId !== input.workspaceId || accepted.itemId !== input.itemId) return { status: 'conflict', evidenceId: null, evidenceRevision: null, evidenceHash: null, currentnessHash: null, callIds: [], selection: null, reason: 'Accepted evidence ownership does not match the item.' };
  const { spans, brand, conflictingBrands } = acceptedItemNameSpans(accepted);
  if (conflictingBrands.length > 0) return { status: 'conflict', evidenceId: accepted.id, evidenceRevision: accepted.revision, evidenceHash: accepted.evidenceHash, currentnessHash: null, callIds: [], selection: null, reason: 'Accepted item evidence contains conflicting brand facts.' };
  const selection = await resolveNameSelection({
    evidence: acceptedEvidenceToClassificationEvidence(accepted, input.runId),
    spans,
    brand,
    sku: accepted.sku,
    runId: input.runId,
    modelPolicy: input.modelPolicy,
    snapshot: input.snapshot,
    assertHeld: input.assertHeld,
  });
  const current = getCurrentItemEvidenceView(input.workspaceId, input.itemId);
  if (current.status !== 'accepted' || !current.evidence || current.evidence.id !== accepted.id || current.evidence.revision !== accepted.revision || current.evidence.evidenceHash !== accepted.evidenceHash || current.evidence.inputHash !== accepted.inputHash || current.evidence.sourceStateHash !== accepted.sourceStateHash || current.evidence.authorityHash !== accepted.authorityHash) {
    return { status: 'stale', evidenceId: accepted.id, evidenceRevision: accepted.revision, evidenceHash: accepted.evidenceHash, currentnessHash: null, callIds: selection.modelCallIds, selection: null, reason: 'Accepted evidence changed during name selection.' };
  }
  input.assertHeld?.();
  const currentnessHash = hashCanonicalJson({ evidenceId: accepted.id, revision: accepted.revision, evidenceHash: accepted.evidenceHash, inputHash: accepted.inputHash, sourceStateHash: accepted.sourceStateHash, authorityHash: accepted.authorityHash, normalizationVersion: NAME_NORMALIZATION_VERSION, policyDigest: input.modelPolicy?.policyDigest ?? null, selection: { title: selection.title, candidates: selection.candidates, producer: selection.producer, callIds: selection.modelCallIds, outcome: selection.selectionOutcome } });
  return { status: selection.status, evidenceId: accepted.id, evidenceRevision: accepted.revision, evidenceHash: accepted.evidenceHash, currentnessHash, callIds: selection.modelCallIds, selection, reason: selection.abstentionReason ?? null };
}

export const nameConsolidationStage: StageDefinition = {
  name: 'name_consolidation',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const accepted = context.acceptedEvidence;
    if (!accepted) return { status: 'abstained', reason: 'Current accepted item evidence is required for name consolidation.' };
    if (accepted.workspaceId !== context.workspaceId || accepted.sku !== input.sku
      || (input.onboardingItemId !== undefined && accepted.itemId !== input.onboardingItemId)) {
      return { status: 'abstained', reason: 'Accepted item evidence does not match the naming stage item.' };
    }
    if (!context.snapshot) {
      return { status: 'abstained', reason: 'A frozen classification snapshot is required for accepted-item naming.' };
    }

    try {
      // V1 snapshots freeze config but have no frozen model-execution plan.
      // They may resolve a deterministic single candidate, never invoke a model.
      const snapshot = context.snapshot.schemaVersion === 2 ? context.snapshot : null;
      const modelPolicy = snapshot
        ? modelPolicyViewFromConfig(
            snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            snapshot.snapshotHash,
          )
        : null;
      const result = await selectAcceptedItemName({
        workspaceId: context.workspaceId,
        itemId: accepted.itemId,
        runId: context.runId,
        modelPolicy,
        snapshot,
        assertHeld: context.assertHeld,
      });
      if (result.status !== 'resolved' || !result.selection?.title) {
        return { status: 'abstained', reason: result.reason ?? result.selection?.abstentionReason ?? 'Accepted item name selection abstained.' };
      }
      if (result.evidenceId !== accepted.id || result.evidenceRevision !== accepted.revision
        || result.evidenceHash !== accepted.evidenceHash) {
        return { status: 'abstained', reason: 'Accepted item evidence changed after this run context was frozen.' };
      }
      const { spans, brand } = acceptedItemNameSpans(accepted);
      const nameDecision = toNameDecision({ result: result.selection, spans, brand });
      if (!nameDecision) {
        return { status: 'abstained', reason: 'Resolved name failed persistence validation against current accepted evidence.' };
      }
      const titleSource = result.selection.producer === 'typesafe' ? 'typesafe' : 'deterministic';
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: `Accepted-evidence name ${titleSource}: "${result.selection.title}"`,
          metadata: {
            curatedTitle: result.selection.title,
            titleSource,
            nameDecision,
            modelCallIds: result.callIds,
            acceptedEvidenceId: accepted.id,
            acceptedEvidenceRevision: accepted.revision,
            acceptedEvidenceHash: accepted.evidenceHash,
            nameCurrentnessHash: result.currentnessHash,
            nameNormalizationVersion: NAME_NORMALIZATION_VERSION,
          },
        },
      };
    } catch (error) {
      return { status: 'abstained', reason: `Accepted-evidence name selection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};
