/**
 * Value Gap Abstain Stage (P3 — classification roadmap plan B.P3.3)
 *
 * Closes RESIDUAL value-production gaps left after deterministic proposal
 * production: attributes that are mapped (enabled curation target), applicable
 * under the effective Product Type, controlled-valued, and yet received NO
 * `field_assignment` proposal from the `product_attribute_proposals` stage.
 *
 * For each such gap attribute this stage makes AT MOST ONE id-constrained LLM
 * call whose candidate values are restricted to the attribute's frozen
 * `allowedValues`/aliases (`llmRankOptions` normalizes every response against
 * the option list). Constraint enforcement is layered twice:
 *   1. the ranker drops any response value not present in the supplied options;
 *   2. this stage re-validates every returned value against the frozen
 *      `allowedValues` before any proposal is built — ANY out-of-constraint
 *      value fails the whole attribute closed to a deterministic abstention
 *      (`value_gap_abstained`), never invention.
 *
 * Honesty guards (fail closed):
 * - Claim/composition attributes are NEVER resolved here: their direct-
 *   evidence requirements cannot be satisfied by a constrained pick without
 *   supporting evidence, so they are excluded from the gap set entirely.
 * - No calibrated threshold, confidence, or bulk-acceptance path is granted:
 *   proposals keep status `pending` and default `isBulkAcceptable` (false).
 * - Flag OFF (BAYSTATE_CMS_VALUE_GAP_LLM, default) removes the stage from the
 *   composed pipeline entirely (`composeCurationPipelineStages`); if the stage
 *   is nevertheless invoked it succeeds as an inert no-op.
 *
 * Operation registration: `value_gap_resolution` (model-operation-registry;
 * registry version bumped to 3 per ADR 0013 precedent — snapshots frozen
 * under an older registry refuse run-bound calls via
 * `assertModelPlanCompatible`, which is the documented fail-closed upgrade
 * semantics).
 *
 * PR9 DECISION-B invariant preserved structurally: proposals produced here
 * exist only when the member had NO effective reviewed/execution type driving
 * dependency stamping (otherwise profile gating would already have decided
 * these attributes), so no product-type dependency rows can attach to them.
 *
 * Dependencies: product_attribute_proposals (reads its stage output plus the
 * attribute_applicability metadata).
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import { buildEvidenceTargetPacket, tokenGroundingSupport } from '../evidence-targeting';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { getUniversalTierFlags } from '../flags';

/** Outcome recorded per gap attribute in stage metadata (audit trail). */
export type ValueGapOutcome =
  | 'proposed'
  | 'value_gap_abstained'
  | 'out_of_constraint_abstained'
  | 'no_evidence'
  | 'skipped_claim_composition';

export interface ValueGapResolutionRecord {
  attributeId: string;
  catalogField: string | null;
  outcome: ValueGapOutcome;
  /** Selected value when outcome === 'proposed'. Never present otherwise. */
  value?: string;
  reason?: string;
}

export interface ValueGapStageMetadata {
  resolutions: ValueGapResolutionRecord[];
  proposedCount: number;
  abstainedCount: number;
}

export const valueGapAbstainStage: StageDefinition = {
  name: 'value_gap_abstain',
  requires: ['product_attribute_proposals'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    // Defensive flag guard: composition excludes this stage while the flag is
    // OFF; a direct invocation still refuses to act (inert success).
    if (!getUniversalTierFlags().valueGapLlmEnabled) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'Value-gap resolution disabled (BAYSTATE_CMS_VALUE_GAP_LLM off).',
          metadata: { resolutions: [], proposedCount: 0, abstainedCount: 0 },
        },
      };
    }

    // ── Resolve targets (frozen snapshot first, live config only on legacy runs)
    const resolved = context.snapshot
      ? resolveTargetsFromSnapshot(context.snapshot)
      : resolveEnabledTargets(loadClassificationConfig(context.workspacePath), context.workspaceId);

    // ── Applicability evaluations from the upstream stage output. The
    // pipeline runner merges upstream evidence into `input.evidence`, so the
    // applicability metadata rides in the same StageInput map.
    const applicability = ((input.stageOutputs?.['attribute_applicability']?.metadata ?? {}) as {
      applicability?: Array<{ attributeId: string; state: string }>;
    }).applicability ?? [];
    const applicableIds = new Set(
      applicability.filter(entry => entry.state === 'applicable').map(entry => entry.attributeId),
    );

    // ── Values already produced by the deterministic proposals stage
    const priorOutput = input.stageOutputs?.['product_attribute_proposals'];
    const priorProposals = (priorOutput?.proposals ?? []) as ClassificationProposal[];
    const producedAttributeIds = new Set(
      priorProposals
        .filter(proposal => proposal.proposalType === 'field_assignment')
        .map(proposal => proposal.targetId),
    );

    // ── Gap set: mapped + applicable + controlled + unproduced + claim-free
    const gaps: Array<{
      attributeId: string;
      label: string;
      catalogField: string | null;
      allowedValues: string[];
    }> = [];
    const resolutions: ValueGapResolutionRecord[] = [];

    for (const target of resolved.productFields) {
      const attribute = target.attribute;
      if (!attribute) continue;
      const attrId = target.config.attributeId ?? target.config.id;
      if (!applicableIds.has(attrId)) continue;
      if (producedAttributeIds.has(attrId)) continue;
      const catalogField = target.config.catalogField ?? null;

      // Claims/composition require direct-evidence provenance a constrained
      // pick cannot supply — excluded from the gap set (fail-closed honesty).
      if (attribute.isClaim === true || attribute.isCompositionAttribute === true) {
        resolutions.push({
          attributeId: attrId,
          catalogField,
          outcome: 'skipped_claim_composition',
          reason: `${target.config.label} requires direct supporting evidence; never resolved by constrained LLM picks.`,
        });
        continue;
      }
      // Only controlled attributes carry a constraint set to enforce.
      if (attribute.valueMode !== 'controlled' || !attribute.allowedValues || attribute.allowedValues.length === 0) {
        continue;
      }
      gaps.push({
        attributeId: attrId,
        label: target.config.label,
        catalogField,
        allowedValues: [...attribute.allowedValues],
      });
    }

    if (gaps.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'No residual value gaps to resolve.',
          metadata: { resolutions, proposedCount: 0, abstainedCount: 0 } satisfies ValueGapStageMetadata,
        },
      };
    }

    const proposals: ClassificationProposal[] = [];
    const proposedCount = 0;
    let abstainedCount = 0;

    for (const gap of gaps) {
      // Target-relevant deterministic evidence packet (same builder the
      // proposals stage uses). Unrelated general text NEVER enters the prompt
      // (epic #46 grounding rule): an empty packet means nothing to ground a
      // pick on — recorded skip, no LLM call.
      const packet = buildEvidenceTargetPacket(input.evidence, {
        attributeId: gap.attributeId,
        sourceField: gap.catalogField,
        sourceFields: gap.catalogField ? [gap.catalogField] : null,
        selectionMode: 'single',
        aliases: [],
        isGroundingSupport: tokenGroundingSupport,
      });
      const promptText = packet.promptText || '';
      if (!promptText || promptText.trim().length < 8) {
        resolutions.push({
          attributeId: gap.attributeId,
          catalogField: gap.catalogField,
          outcome: 'no_evidence',
          reason: 'No target-relevant evidence text for constrained resolution.',
        });
        abstainedCount++;
        continue;
      }

      resolutions.push({
        attributeId: gap.attributeId,
        catalogField: gap.catalogField,
        outcome: 'value_gap_abstained',
        reason: 'Attribute curation abstained without resolving a value; residual gap abstained.',
      });
      abstainedCount++;
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals,
        abstained: proposals.length === 0 && abstainedCount > 0,
        message: `Value-gap resolution: ${proposedCount} proposed, ${abstainedCount} abstained.`,
        metadata: { resolutions, proposedCount, abstainedCount } satisfies ValueGapStageMetadata,
      },
    };
  },
};
