import { getDb } from '../db/connection';
import { DecisionConflictError, enqueueClassificationRefresh, insertDecisionRow, recordHistoryEvent } from '../db/repositories/classification-run-repo';
import type { ClassificationProposalDecision } from '../shared/types';
import { getProductTypeIdFromValue } from './assignment-projection';

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
}

export type ProposalReviewResult =
  | { ok: true; decisions: ClassificationProposalDecision[] }
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
    `SELECT id, status, workspace_id, product_sku, source_kind, onboarding_item_id
     FROM classification_runs WHERE id = ?`,
  ).get(input.runId) as {
    id: string; status: string; workspace_id: string; product_sku: string;
    source_kind: string; onboarding_item_id: string | null;
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
    `SELECT id, proposal_type FROM classification_proposals
     WHERE id IN (${placeholders}) AND run_id = ? AND product_sku = ?`,
  ).all(...proposalIds, input.runId, input.productSku) as Array<{
    id: string;
    proposal_type: string;
  }>;

  if (proposalRows.length !== proposalIds.length) {
    return { ok: false, code: 'invalid_proposals', reason: 'One or more proposal IDs do not belong to this run and SKU.' };
  }

  const proposalTypeById = new Map(proposalRows.map(row => [row.id, row.proposal_type]));

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
    corrections.set(decision.proposalId, resolved.correction);
  }

  const decisions: ClassificationProposalDecision[] = [];

  try {
    db.transaction(() => {
      const insertedDecisions: Array<{
        decisionId: string;
        proposalId: string;
        decision: ClassificationProposalDecision['decision'];
      }> = [];

      for (const d of input.decisions) {
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
          decisionOrigin: 'human_review',
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
        const { decision, inserted, decisionId } = insertDecisionRow(db, rowInput);
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
      const typeDecisionInserted = insertedDecisions.some(
        inserted => proposalTypeById.get(inserted.proposalId) === 'primary_product_type',
      );
      if (typeDecisionInserted) {
        enqueueClassificationRefresh({
          workspaceId: input.workspaceId,
          productSku: input.productSku,
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

  return { ok: true, decisions };
}
