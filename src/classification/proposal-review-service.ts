import { getDb } from '../db/connection';
import { DecisionConflictError, getProposalsByRun, getLiveDecisionsByRun, insertDecisionRow, recordHistoryEvent, assertProposalReviewLiveness } from '../db/repositories/classification-run-repo';
import { enqueueRefreshItem } from '../db/repositories/classification-refresh-repo';
import type { ClassificationProposalDecision } from '../shared/types';
import { getCategoryIdFromValue, getEffectiveClassificationPair, getEffectiveProposalValue, getProductTypeIdFromValue } from './assignment-projection';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { invalidateDependentTypeReview, isTypeDependentProposal, listCurrentRunProposals } from '../db/repositories/classification-dependent-review-repo';
import { validateFrozenReviewCorrection } from './review-correction';
import { isBrandPageProposal, isProtectedTargetId, protectedTargetRefusal } from './classification-ownership';
import { pageNameFromPageValue } from '../shared/proposal-display';

export interface ProposalReviewInput {
  workspaceId: string;
  productSku: string;
  runId: string;
  sourceKind: 'onboarding' | 'catalog_product';
  decisions: Array<{
    id?: string;
    proposalId: string;
    decision: 'accepted' | 'rejected' | 'deferred';
    reviewerId?: string | null;
    reviewerNote?: string | null;
    revisedValue?: unknown;
    revisedTargetId?: string | null;
    /**
     * Evidence citations for this correction (issue #17 I). Each id must
     * belong to the same run/SKU and be linked to the proposal in one of the
     * evidence relations; arbitrary/invented citations are rejected before
     * any decision or history row is written.
     */
    evidenceIds?: string[];
    actionToken?: string;
    expectedRevisionId?: string | null;
    /** @deprecated Transitional aliases accepted while older clients drain. */
    revisedFromId?: string | null;
    proposedValue?: unknown;
    targetId?: string | null;
  }>;
  /** Required for onboarding; null for catalog */
  onboardingItemId?: string;
  /** Internal evaluator attribution; HTTP review retains human_review. */
  reviewOrigin?: 'human_review' | 'agent_review';
}

export type ProposalReviewResult =
  | { ok: true; decisions: ClassificationProposalDecision[]; refreshRequired?: boolean }
  | { ok: false; code: string; reason: string };

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const decisionAliasPairs = [
  ['expectedRevisionId', 'revisedFromId'],
  ['revisedValue', 'proposedValue'],
  ['revisedTargetId', 'targetId'],
] as const;

type DecisionInput = ProposalReviewInput['decisions'][number];

interface ResolvedCorrection {
  hasRevisedValue: boolean;
  revisedValue?: unknown;
  hasRevisedTargetId: boolean;
  revisedTargetId?: string | null;
}

/**
 * A reviewed category_page value must be either a legacy page-name string or
 * an object with a non-empty `pageName` (and, when present, a string `pageId`).
 * Any other shape is rejected BEFORE a decision row is written so a Page ID
 * can never be accepted into a page-name field via an unvalidated revision.
 */
function isValidCategoryPageValue(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.pageName !== 'string' || record.pageName.length === 0) return false;
  if (record.pageId !== undefined && record.pageId !== null
    && (typeof record.pageId !== 'string' || record.pageId.length === 0)) {
    return false;
  }
  return true;
}

function resolveCorrection(
  decision: DecisionInput,
  proposalType: string,
): { ok: true; correction: ResolvedCorrection } | { ok: false; reason: string } {
  const hasCanonicalValue = hasOwn(decision, 'revisedValue');
  const hasLegacyValue = hasOwn(decision, 'proposedValue');
  const hasCanonicalTarget = hasOwn(decision, 'revisedTargetId');
  const hasLegacyTarget = hasOwn(decision, 'targetId');
  const hasRevisedValue = hasCanonicalValue || hasLegacyValue;
  const hasRevisedTargetId = hasCanonicalTarget || hasLegacyTarget;
  const revisedValue = hasCanonicalValue ? decision.revisedValue : decision.proposedValue;
  const revisedTargetId = hasCanonicalTarget ? decision.revisedTargetId : decision.targetId;

  if (proposalType === 'category_page' && hasRevisedValue && revisedValue !== null) {
    if (!isValidCategoryPageValue(revisedValue)) {
      return { ok: false, reason: `Decision ${decision.proposalId} has an invalid Category Page value.` };
    }
  }

  // Issue #350: the canonical pair corrects through the same validated
  // model. Pair values carry {categoryId, productTypeId} and persist paired;
  // a target-only correction keeps the proposal's own category. Combination
  // validity is enforced downstream by validateClassificationCorrection
  // against the frozen snapshot (never invented here).
  if (proposalType === 'product_classification') {
    if (!hasRevisedValue && !hasRevisedTargetId) {
      return { ok: true, correction: { hasRevisedValue: false, hasRevisedTargetId: false } };
    }
    const categoryId = hasRevisedValue ? getCategoryIdFromValue(revisedValue) : null;
    const valueTypeId = hasRevisedValue ? getProductTypeIdFromValue(revisedValue) : null;
    if (hasRevisedValue && revisedValue !== null && (!categoryId || !valueTypeId)) {
      return { ok: false, reason: `Decision ${decision.proposalId} has an invalid Product Classification value; a correction must address both Category and Product Type.` };
    }
    if (hasRevisedTargetId && revisedTargetId !== null && (typeof revisedTargetId !== 'string' || revisedTargetId.length === 0)) {
      return { ok: false, reason: `Decision ${decision.proposalId} has an invalid Product Classification target.` };
    }
    const effectiveTypeId = hasRevisedTargetId ? revisedTargetId ?? null : valueTypeId;
    if (hasRevisedValue && hasRevisedTargetId && valueTypeId !== effectiveTypeId) {
      return { ok: false, reason: `Decision ${decision.proposalId} has conflicting Product Classification value and target IDs.` };
    }
    return {
      ok: true,
      correction: {
        hasRevisedValue: hasRevisedValue || hasRevisedTargetId,
        ...(hasRevisedValue || hasRevisedTargetId
          ? { revisedValue: hasRevisedValue ? { categoryId, productTypeId: valueTypeId } : { categoryId: null, productTypeId: effectiveTypeId } }
          : {}),
        hasRevisedTargetId: true,
        revisedTargetId: effectiveTypeId ?? null,
      },
    };
  }

  if (proposalType !== 'primary_product_type' || (!hasRevisedValue && !hasRevisedTargetId)) {
    return {
      ok: true,
      correction: {
        hasRevisedValue,
        ...(hasRevisedValue ? { revisedValue } : {}),
        hasRevisedTargetId,
        ...(hasRevisedTargetId ? { revisedTargetId: revisedTargetId ?? null } : {}),
      },
    };
  }
  // Product Type is one semantic identity even though legacy proposals stored
  // it in both value and target. New decisions always persist a paired,
  // canonical correction; existing one-sided history remains readable through
  // getEffectivePrimaryProductTypeId().
  const valueId = hasRevisedValue ? getProductTypeIdFromValue(revisedValue) : null;
  if (hasRevisedValue && revisedValue !== null && valueId === null) {
    return { ok: false, reason: `Decision ${decision.proposalId} has an invalid Primary Product Type value.` };
  }

  if (hasRevisedTargetId
    && revisedTargetId !== null
    && (typeof revisedTargetId !== 'string' || revisedTargetId.length === 0)) {
    return { ok: false, reason: `Decision ${decision.proposalId} has an invalid Primary Product Type target.` };
  }
  const targetId = hasRevisedTargetId ? revisedTargetId ?? null : valueId;

  if (hasRevisedValue && hasRevisedTargetId && valueId !== targetId) {
    return { ok: false, reason: `Decision ${decision.proposalId} has conflicting Primary Product Type value and target IDs.` };
  }

  const effectiveId = hasRevisedTargetId ? targetId : valueId;
  return {
    ok: true,
    correction: {
      hasRevisedValue: true,
      revisedValue: effectiveId === null ? null : { productTypeId: effectiveId },
      hasRevisedTargetId: true,
      revisedTargetId: effectiveId,
    },
  };
}

/**
 * Validate and persist proposal decisions transactionally.
 * Enforces:
 * - Run must exist and belong to the correct workspace/SKU/source
 * - Run must be completed (not running/failed)
 * - Every proposalId must belong to this exact run
 * - For onboarding: run must be linked to the correct onboarding item
 */
export function submitProposalDecisions(input: ProposalReviewInput): ProposalReviewResult {
  let refreshRequired = false;
  const db = getDb();
  if (input.decisions.length === 0) {
    return { ok: false, code: 'invalid_decisions', reason: 'At least one decision is required.' };
  }
  if (new Set(input.decisions.map(decision => decision.proposalId)).size !== input.decisions.length) {
    return { ok: false, code: 'invalid_decisions', reason: 'Duplicate proposal IDs are not allowed.' };
  }
  for (const decision of input.decisions) {
    for (const [canonical, legacy] of decisionAliasPairs) {
      if (hasOwn(decision, canonical) && hasOwn(decision, legacy)) {
        return {
          ok: false,
          code: 'invalid_decisions',
          reason: `Decision ${decision.proposalId} cannot include both ${canonical} and deprecated ${legacy}.`,
        };
      }
    }
  }
  const run = db.query(
    `SELECT id, status, workspace_id, product_sku, source_kind, onboarding_item_id, config_snapshot_hash
     FROM classification_runs WHERE id = ?`,
  ).get(input.runId) as {
    id: string; status: string; workspace_id: string; product_sku: string;
    source_kind: string; onboarding_item_id: string | null;
    config_snapshot_hash: string | null;
  } | undefined;

  if (!run) {
    return { ok: false, code: 'run_not_found', reason: `Run ${input.runId} not found.` };
  }
  if (run.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Run belongs to a different workspace.' };
  }
  if (run.product_sku !== input.productSku) {
    return { ok: false, code: 'sku_mismatch', reason: `Run SKU "${run.product_sku}" does not match "${input.productSku}".` };
  }
  if (run.source_kind !== input.sourceKind) {
    return { ok: false, code: 'source_mismatch', reason: `Run source "${run.source_kind}" does not match "${input.sourceKind}".` };
  }
  if (input.sourceKind === 'onboarding' && run.onboarding_item_id !== input.onboardingItemId) {
    return { ok: false, code: 'item_mismatch', reason: 'Run is not linked to this onboarding item.' };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return { ok: false, code: 'run_not_completed', reason: `Run status is "${run.status}". Only completed runs accept decisions.` };
  }

  // Validate every proposal belongs to both this run and this SKU. The schema
  // stores product_sku independently, so run membership alone is insufficient.
  const proposalIds = input.decisions.map(d => d.proposalId);
  const placeholders = proposalIds.map(() => '?').join(',');
  const proposalRows = db.query(
    `SELECT id, proposal_type, status, is_stale, superseded_at FROM classification_proposals
     WHERE id IN (${placeholders}) AND run_id = ? AND product_sku = ?`,
  ).all(...proposalIds, input.runId, input.productSku) as Array<{
    id: string;
    proposal_type: string;
    status: string;
    is_stale: number;
    superseded_at: string | null;
  }>;

  if (proposalRows.length !== proposalIds.length) {
    return { ok: false, code: 'invalid_proposals', reason: 'One or more proposal IDs do not belong to this run and SKU.' };
  }
  const invalid = proposalRows.find(row => row.status === 'stale' || row.is_stale || row.superseded_at);
  if (invalid) return { ok: false, code: 'decision_conflict', reason: `Proposal ${invalid.id} is ${invalid.superseded_at ? 'superseded' : 'stale'}; review its current replacement.` };

  const proposalTypeById = new Map(proposalRows.map(row => [row.id, row.proposal_type]));
  const reviewSnapshot = run.config_snapshot_hash ? getRuntimeSnapshotByHash(input.workspaceId, run.config_snapshot_hash) : null;
  const originalProposals = getProposalsByRun(input.runId);
  // ADR 0041 / issue #349: a historical Brand proposal remains attributable
  // but can never gain review authority. Refuse accepted decisions on
  // protected targets — including protected revised targets — with an
  // attributable code instead of applying or silently rerouting them.
  // Rejections/deferrals carry no write authority and pass through. Issue
  // #353: the same refusal covers Brand pages — a category_page proposal
  // whose effective display name carries the `Brand -` prefix is outside
  // classifier ownership (verified identity or not) and can never gain
  // review authority, including via a revised value/target.
  for (const decision of input.decisions) {
    if (decision.decision !== 'accepted') continue;
    const original = originalProposals.find(proposal => proposal.id === decision.proposalId);
    if (!original) continue;
    if (original.proposalType === 'category_page') {
      const revisedValue = hasOwn(decision, 'revisedValue') ? decision.revisedValue : undefined;
      const revisedTarget = hasOwn(decision, 'revisedTargetId')
        ? (decision.revisedTargetId ?? null)
        : hasOwn(decision, 'targetId')
          ? (decision.targetId ?? null)
          : original.targetId;
      const effectiveName = revisedValue !== undefined
        ? pageNameFromPageValue(revisedValue)
        : pageNameFromPageValue(getEffectiveProposalValue(original));
      if (isBrandPageProposal(effectiveName)) {
        const refusal = protectedTargetRefusal(revisedTarget ?? original.targetId);
        return { ok: false, code: refusal.code, reason: `Decision ${decision.proposalId}: ${refusal.reason}` };
      }
      continue;
    }
    if (original.proposalType !== 'field_assignment') continue;
    const revisedTarget = hasOwn(decision, 'revisedTargetId')
      ? (decision.revisedTargetId ?? null)
      : hasOwn(decision, 'targetId')
        ? (decision.targetId ?? null)
        : original.targetId;
    if (isProtectedTargetId(original.targetId) || isProtectedTargetId(revisedTarget)) {
      const refusal = protectedTargetRefusal(revisedTarget ?? original.targetId);
      return { ok: false, code: refusal.code, reason: `Decision ${decision.proposalId}: ${refusal.reason}` };
    }
  }

  // Issue #17 I: validate evidence citations BEFORE any decision or history
  // row is written. A cited evidence id must exist, belong to the same
  // run/SKU, and be linked to the proposal in one of the evidence relations.
  // Cross-run/SKU/proposal citation injection fails closed here.
  for (const decision of input.decisions) {
    const citationIds = decision.evidenceIds ?? [];
    if (citationIds.length > 50) {
      return {
        ok: false,
        code: 'invalid_decisions',
        reason: `Decision ${decision.proposalId} cites more than 50 evidence records.`,
      };
    }
    for (const evidenceId of citationIds) {
      const evidence = db.query(
        'SELECT run_id, product_sku FROM classification_evidence WHERE id = ?',
      ).get(evidenceId) as { run_id: string; product_sku: string } | undefined;
      if (!evidence || String(evidence.run_id) !== input.runId || String(evidence.product_sku) !== input.productSku) {
        return {
          ok: false,
          code: 'invalid_decisions',
          reason: `Decision ${decision.proposalId} cites evidence "${evidenceId}" that does not belong to this run/SKU.`,
        };
      }
      const link = db.query(
        'SELECT 1 FROM classification_proposal_evidence WHERE proposal_id = ? AND evidence_id = ?',
      ).get(decision.proposalId, evidenceId);
      if (!link) {
        return {
          ok: false,
          code: 'invalid_decisions',
          reason: `Decision ${decision.proposalId} cites evidence "${evidenceId}" that is not linked to this proposal.`,
        };
      }
    }
  }

  const corrections = new Map<string, ResolvedCorrection>();
  for (const decision of input.decisions) {
    const resolved = resolveCorrection(decision, proposalTypeById.get(decision.proposalId) ?? '');
    if (!resolved.ok) {
      return { ok: false, code: 'invalid_decisions', reason: resolved.reason };
    }
    try {
      corrections.set(decision.proposalId, validateFrozenReviewCorrection(originalProposals.find(proposal => proposal.id === decision.proposalId)!, resolved.correction, reviewSnapshot));
    } catch (error) {
      return { ok: false, code: 'invalid_decisions', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const decisions: ClassificationProposalDecision[] = [];

  try {
    db.transaction(() => {
      assertProposalReviewLiveness(input.runId, proposalIds);
      const insertedDecisions: Array<{
        decisionId: string;
        proposalId: string;
        decision: ClassificationProposalDecision['decision'];
      }> = [];

      for (const d of input.decisions) {
        // An earlier type correction in this same request may have invalidated
        // a later dependent. Recheck each write, not only the initial batch.
        assertProposalReviewLiveness(input.runId, [d.proposalId]);
        const hasCanonicalExpected = hasOwn(d, 'expectedRevisionId');
        const hasLegacyExpected = hasOwn(d, 'revisedFromId');
        const correction = corrections.get(d.proposalId);
        if (!correction) throw new Error(`Missing resolved correction for ${d.proposalId}.`);
        const rowInput = {
          ...(d.id ? { id: d.id } : {}),
          proposalId: d.proposalId,
          decision: d.decision,
          reviewerId: d.reviewerId ?? null,
          reviewerNote: d.reviewerNote ?? null,
          decisionOrigin: input.reviewOrigin ?? 'human_review',
          ...(correction.hasRevisedValue ? { revisedValue: correction.revisedValue } : {}),
          ...(correction.hasRevisedTargetId ? { revisedTargetId: correction.revisedTargetId ?? null } : {}),
          ...(d.actionToken ? { actionToken: d.actionToken } : {}),
          ...(hasCanonicalExpected
            ? { expectedRevisionId: d.expectedRevisionId ?? null }
            : hasLegacyExpected
              ? { expectedRevisionId: d.revisedFromId ?? null }
              : {}),
          ...(d.evidenceIds && d.evidenceIds.length > 0 ? { evidenceIds: d.evidenceIds } : {}),
        };
        const priorProposal = getProposalsByRun(input.runId).find(proposal => proposal.id === d.proposalId);
        const priorKind = proposalTypeById.get(d.proposalId);
        const priorType = priorKind === 'primary_product_type' || priorKind === 'product_classification' ? priorProposal : null;
        const priorDecision = priorType ? getLiveDecisionsByRun(input.runId).find(decision => decision.id === priorType.currentDecisionId) : null;
        const hadHumanReviewedType = priorType?.status === 'accepted' && priorDecision?.decision === 'accepted' && priorDecision.decisionOrigin === 'human_review';
        const { decision, inserted, decisionId } = insertDecisionRow(db, rowInput);
        if (inserted && input.reviewOrigin === 'agent_review'
          && (!priorProposal || priorProposal.status !== 'pending' || priorProposal.currentDecisionId)) {
          throw new DecisionConflictError('Agent evaluation cannot replace an existing review decision.');
        }
        if (inserted && priorType) {
          const previousPair = hadHumanReviewedType ? getEffectiveClassificationPair(priorType) : { categoryId: getCategoryIdFromValue(priorType.proposedValue), productTypeId: getProductTypeIdFromValue(priorType.proposedValue) };
          const previousTypeId = previousPair.productTypeId;
          const previousCategoryId = previousPair.categoryId;
          const nextType = getProposalsByRun(input.runId).find(proposal => proposal.id === priorType.id)!;
          const nextPair = d.decision !== 'accepted' ? { categoryId: null, productTypeId: null } : getEffectiveClassificationPair(nextType);
          const nextTypeId = nextPair.productTypeId;
          const nextCategoryId = nextPair.categoryId;
          const snapshot = run.config_snapshot_hash ? getRuntimeSnapshotByHash(input.workspaceId, run.config_snapshot_hash) : null;
          const currentProposals = listCurrentRunProposals(input.runId);
          const hasWithheldDependents = currentProposals.some(proposal => proposal.proposalType === 'reviewable_abstention'
            && ['product_attribute_proposals', 'category_page_proposals'].includes(proposal.targetId ?? '')
            && String((proposal.proposedValue as { reason?: string })?.reason ?? '').includes('No reviewed Product Classification'));
          const needsInitialDependents = !hadHumanReviewedType
            && (!snapshot || !currentProposals.some(proposal => isTypeDependentProposal(proposal, snapshot)));
          refreshRequired = input.reviewOrigin !== 'agent_review' && nextTypeId !== null
            && (nextTypeId !== previousTypeId || nextCategoryId !== previousCategoryId || hasWithheldDependents || needsInitialDependents);
          if (input.reviewOrigin !== 'agent_review' && (nextTypeId !== previousTypeId || nextCategoryId !== previousCategoryId)) {
            invalidateDependentTypeReview(input.runId, snapshot, input.onboardingItemId, nextTypeId === null ? 'product_type_cleared' : 'product_type_changed');
          }
        }
        decisions.push(decision);
        if (inserted) {
          insertedDecisions.push({ decisionId, proposalId: d.proposalId, decision: d.decision });
        }
      }

      // Audit rows are part of the same transaction as the decision/status
      // writes. A history failure rolls the entire review action back.
      for (const inserted of insertedDecisions) {
        recordHistoryEvent(
          input.workspaceId,
          input.productSku,
          'proposal_decision',
          { sourceKind: input.sourceKind, decision: inserted.decision },
          input.runId,
          inserted.proposalId,
          inserted.decisionId,
        );
      }
      if (insertedDecisions.length > 0) {
        recordHistoryEvent(
          input.workspaceId,
          input.productSku,
          'decisions_submitted',
          {
            sourceKind: input.sourceKind,
            decisionCount: decisions.length,
            insertedDecisionCount: insertedDecisions.length,
            insertedDecisionIds: insertedDecisions.map(inserted => inserted.decisionId),
          },
          input.runId,
        );
      }

      // A Primary Product Type decision change invalidates type-gated
      // proposals: queue a dependent refresh so the next run's snapshot cites
      // the accepted decision as a reviewed fact and re-evaluates gating.
      const typeDecisionInserted = insertedDecisions.find(
        inserted => {
          const kind = proposalTypeById.get(inserted.proposalId);
          return kind === 'primary_product_type' || kind === 'product_classification';
        },
      );
      if (typeDecisionInserted && refreshRequired) {
        enqueueRefreshItem({
          workspaceId: input.workspaceId,
          productSku: input.productSku,
          sourceKind: input.sourceKind,
          onboardingItemId: input.onboardingItemId,
          expectedRunId: input.runId,
          triggerDecisionId: typeDecisionInserted.decisionId,
          triggerType: 'primary_product_type_change',
          refreshScope: {
            sourceKind: input.sourceKind,
            runId: input.runId,
            decisionIds: insertedDecisions.map(inserted => inserted.decisionId),
          },
          requestedBy: 'proposal_review',
        });
      }
    })();
  } catch (error) {
    if (error instanceof DecisionConflictError) {
      return { ok: false, code: error.code, reason: error.message };
    }
    throw error;
  }

  return { ok: true, decisions, refreshRequired };
}
