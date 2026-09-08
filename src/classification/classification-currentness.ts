/**
 * Shared Product Type Currentness Model (P0.2).
 *
 * Implements the shared authority and currentness verification used by both
 * Review and Promotion gates.
 *
 * Invariants:
 * 1. An active, non-superseded 'accepted' decision on an active primary_product_type proposal.
 * 2. Server-derived decision origin must be 'human_review'. Automation (system_auto_accept,
 *    verifier, execution, migration, unknown) cannot qualify.
 * 3. Non-null effective target. Explicit clear returns 'reviewed_product_type_cleared'.
 * 4. Revised target and revised value must resolve to the same Product Type.
 * 5. Effective Product Type ID must exist in the run's frozen configured options.
 * 6. Run must belong to the exact workspace, item, SKU and be in a terminal completed status.
 * 7. For cohort children, the parent must belong to workspace, be current (non-superseded),
 *    and be terminal.
 * 8. Every active type-dependent accepted proposal must carry a recognized dependency with
 *    matching target and canonical value hash. Universal proposals must have no type dependency.
 */

import type { Database } from 'bun:sqlite';
import type { ClassificationProposal, DecisionOrigin } from '../shared/types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getProductTypeIdFromValue } from './assignment-projection';
import { isUniversalAttribute } from './applicability-evaluator';
import { hashCanonicalJson } from '../shared/stable-id';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';

export type ProductTypeCurrentnessCode =
  | 'run_not_found'
  | 'snapshot_unavailable'
  | 'workspace_mismatch'
  | 'item_mismatch'
  | 'sku_mismatch'
  | 'run_not_completed'
  | 'parent_not_found'
  | 'parent_workspace_mismatch'
  | 'parent_superseded'
  | 'parent_not_completed'
  | 'missing_primary_product_type_proposal'
  | 'no_accepted_product_type_decision'
  | 'non_human_product_type_decision'
  | 'reviewed_product_type_cleared'
  | 'revised_product_type_mismatch'
  | 'unconfigured_product_type'
  | 'missing_type_dependency'
  | 'universal_proposal_has_type_dependency'
  | 'stale_proposal';

export type ProductTypeCurrentnessResult =
  | {
      ok: true;
      effectiveTypeId: string;
      decisionId: string;
      decisionOrigin: DecisionOrigin;
      canonicalValueHash: string;
    }
  | {
      ok: false;
      code: ProductTypeCurrentnessCode;
      reason: string;
    };

export interface ActiveRunContext {
  id: string;
  workspaceId: string;
  onboardingItemId?: string | null;
  productSku: string;
  status: string;
  configSnapshotHash?: string | null;
  cohortRunId?: string | null;
}

export interface ParentRunContext {
  id: string;
  workspaceId: string;
  status: string;
}

export interface DecisionRecordContext {
  id: string;
  decision: string;
  decisionOrigin?: string | null;
  reviewerId?: string | null;
  revisedFromId?: string | null;
  revisedValue?: unknown;
  hasRevisedValue?: boolean;
  revisedTargetId?: string | null;
  hasRevisedTargetId?: boolean;
  supersededAt?: string | null;
}

export interface DependencyRecord {
  dependencyKind: string;
  dependencyTargetId: string | null;
  dependencyValueHash?: string | null;
}

export interface ProposalWithDependencies {
  proposal: ClassificationProposal;
  dependencies: DependencyRecord[];
  isUniversal?: boolean;
}

export interface ProductTypeCurrentnessInput {
  workspaceId: string;
  onboardingItemId?: string | null;
  productSku: string;
  activeRun: ActiveRunContext | null;
  parentRun?: ParentRunContext | null;
  snapshot?: RuntimeClassificationSnapshot | null;
  primaryTypeProposal?: ClassificationProposal | null;
  primaryTypeDecision?: DecisionRecordContext | null;
  typeDependentProposals?: ProposalWithDependencies[];
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'completed_with_abstentions']);
const TERMINAL_PARENT_STATUSES = new Set([
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
]);

/**
 * Resolve decision origin fail-closed.
 * An explicit server-stamped decisionOrigin wins. Legacy rows with
 * reviewer_id === 'system_auto_accept' are always 'system_auto_accept'.
 * Unknown/missing origin never fabricates 'human_review' — only an explicit
 * server-stamped 'human_review' qualifies as publication authority.
 */
export function resolveDecisionOrigin(decision: {
  decision_origin?: string | null;
  decisionOrigin?: string | null;
  reviewer_id?: string | null;
  reviewerId?: string | null;
}): DecisionOrigin {
  const origin = decision.decisionOrigin ?? decision.decision_origin;
  if (origin && origin.length > 0) {
    return origin as DecisionOrigin;
  }
  const reviewer = decision.reviewerId ?? decision.reviewer_id;
  if (reviewer === 'system_auto_accept') {
    return 'system_auto_accept';
  }
  return 'unknown' as DecisionOrigin;
}

/**
 * Distinguish explicit null target/value clear from absence of correction.
 */
export function isExplicitProductTypeClear(entity: {
  hasRevisedTargetId?: boolean;
  revisedTargetId?: string | null;
  hasRevisedValue?: boolean;
  revisedValue?: unknown;
}): boolean {
  if (entity.hasRevisedTargetId && (entity.revisedTargetId === null || entity.revisedTargetId === undefined)) {
    if (entity.hasRevisedValue) {
      return entity.revisedValue === null || entity.revisedValue === undefined;
    }
    return true;
  }
  if (entity.hasRevisedValue && (entity.revisedValue === null || entity.revisedValue === undefined)) {
    if (entity.hasRevisedTargetId) {
      return entity.revisedTargetId === null || entity.revisedTargetId === undefined;
    }
    return true;
  }
  return false;
}

/**
 * Compute the canonical reviewed Product Type authority value-hash.
 * Mirrors computeReviewedAuthorityHash: hashCanonicalJson({ reviewedProductTypeId }).
 */
export function computeReviewedTypeAuthorityHash(reviewedTypeId: string | null): string | null {
  if (reviewedTypeId === null || reviewedTypeId.length === 0) return null;
  return hashCanonicalJson({ reviewedProductTypeId: reviewedTypeId });
}

/**
 * Pure validation of Product Type currentness.
 */
export function evaluateProductTypeCurrentness(
  input: ProductTypeCurrentnessInput,
): ProductTypeCurrentnessResult {
  const { workspaceId, onboardingItemId, productSku, activeRun, parentRun, snapshot } = input;

  // 1. Validate Active Run
  if (!activeRun) {
    return { ok: false, code: 'run_not_found', reason: 'Active classification run not found.' };
  }
  if (activeRun.workspaceId !== workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Classification run belongs to a different workspace.' };
  }
  if (onboardingItemId && activeRun.onboardingItemId && activeRun.onboardingItemId !== onboardingItemId) {
    return { ok: false, code: 'item_mismatch', reason: 'Classification run is not linked to this exact onboarding item.' };
  }
  if (activeRun.productSku !== productSku) {
    return {
      ok: false,
      code: 'sku_mismatch',
      reason: `Classification run SKU "${activeRun.productSku}" does not match item UPC "${productSku}".`,
    };
  }
  if (!TERMINAL_RUN_STATUSES.has(activeRun.status)) {
    return {
      ok: false,
      code: 'run_not_completed',
      reason: `Classification run has status "${activeRun.status}". Only completed runs can be reviewed or promoted.`,
    };
  }

  // 2. Validate Cohort Parent Run if active run is a cohort child
  if (activeRun.cohortRunId) {
    if (!parentRun) {
      return {
        ok: false,
        code: 'parent_not_found',
        reason: `Cohort parent run ${activeRun.cohortRunId} not found.`,
      };
    }
    if (parentRun.workspaceId !== workspaceId) {
      return {
        ok: false,
        code: 'parent_workspace_mismatch',
        reason: `Cohort parent run ${parentRun.id} belongs to a different workspace.`,
      };
    }
    if (parentRun.status === 'superseded') {
      return {
        ok: false,
        code: 'parent_superseded',
        reason: `Cohort parent run ${parentRun.id} was superseded; proposals are historical and cannot qualify.`,
      };
    }
    if (!TERMINAL_PARENT_STATUSES.has(parentRun.status)) {
      return {
        ok: false,
        code: 'parent_not_completed',
        reason: `Cohort parent run ${parentRun.id} has status "${parentRun.status}"; cannot qualify while parent is in flight.`,
      };
    }
  }

  // 3. Primary Product Type Proposal & Decision
  const proposal = input.primaryTypeProposal;
  if (!proposal || proposal.proposalType !== 'primary_product_type') {
    return {
      ok: false,
      code: 'missing_primary_product_type_proposal',
      reason: 'Classification run has no active Primary Product Type proposal.',
    };
  }

  const decision = input.primaryTypeDecision;
  if (!decision || decision.decision !== 'accepted' || decision.supersededAt) {
    return {
      ok: false,
      code: 'no_accepted_product_type_decision',
      reason: 'Classification run has no active accepted Primary Product Type decision.',
    };
  }

  // 4. Human origin authority validation
  const origin = resolveDecisionOrigin(decision);
  if (origin !== 'human_review') {
    return {
      ok: false,
      code: 'non_human_product_type_decision',
      reason: `Primary Product Type decision origin is "${origin}"; only "human_review" qualifies as publication authority.`,
    };
  }

  // 5. Explicit clear check
  const hasExplicitClear =
    isExplicitProductTypeClear(proposal) ||
    isExplicitProductTypeClear({
      hasRevisedTargetId: decision.hasRevisedTargetId,
      revisedTargetId: decision.revisedTargetId,
      hasRevisedValue: decision.hasRevisedValue,
      revisedValue: decision.revisedValue,
    });

  if (hasExplicitClear) {
    return {
      ok: false,
      code: 'reviewed_product_type_cleared',
      reason: 'Primary Product Type was explicitly cleared by a reviewer; publication authority requires an active Product Type.',
    };
  }

  // 6. Revised target and revised value consistency
  const hasRevisedTarget = proposal.hasRevisedTargetId || decision.hasRevisedTargetId;
  const revisedTargetId = proposal.hasRevisedTargetId
    ? (proposal.revisedTargetId ?? null)
    : (decision.hasRevisedTargetId ? (decision.revisedTargetId ?? null) : null);

  const hasRevisedVal = proposal.hasRevisedValue || decision.hasRevisedValue;
  const revisedVal = proposal.hasRevisedValue
    ? proposal.revisedValue
    : (decision.hasRevisedValue ? decision.revisedValue : undefined);
  const revisedValTypeId = hasRevisedVal ? getProductTypeIdFromValue(revisedVal) : null;

  if (hasRevisedTarget && hasRevisedVal && revisedTargetId !== revisedValTypeId) {
    return {
      ok: false,
      code: 'revised_product_type_mismatch',
      reason: `Revised Primary Product Type target "${revisedTargetId}" conflicts with revised value Product Type "${revisedValTypeId}".`,
    };
  }

  const effectiveTargetId = hasRevisedTarget ? revisedTargetId : (proposal.targetId ?? null);
  const effectiveValue = hasRevisedVal ? revisedVal : proposal.proposedValue;
  const valueProductTypeId = getProductTypeIdFromValue(effectiveValue);

  const effectiveTypeId = effectiveTargetId ?? valueProductTypeId;
  if (!effectiveTypeId) {
    return {
      ok: false,
      code: 'reviewed_product_type_cleared',
      reason: 'Effective Primary Product Type resolved to empty/null.',
    };
  }

  // 7. Option exists in run's frozen configured options — missing snapshot blocks fail-closed.
  if (!snapshot) {
    return {
      ok: false,
      code: 'snapshot_unavailable',
      reason: 'Classification run has no resolvable frozen runtime snapshot; Product Type authority cannot be verified.',
    };
  }
  {
    const isConfigured = snapshot.productTypes.some(pt => pt.id === effectiveTypeId);
    if (!isConfigured) {
      return {
        ok: false,
        code: 'unconfigured_product_type',
        reason: `Effective Product Type "${effectiveTypeId}" is not a configured option in the run's frozen runtime snapshot.`,
      };
    }
  }

  const canonicalValueHash = computeReviewedTypeAuthorityHash(effectiveTypeId);
  if (!canonicalValueHash) {
    return {
      ok: false,
      code: 'reviewed_product_type_cleared',
      reason: 'Unable to compute canonical authority value hash for reviewed Product Type.',
    };
  }

  // 8. Type-dependent proposal dependencies and universals
  if (input.typeDependentProposals) {
    for (const item of input.typeDependentProposals) {
      const p = item.proposal;
      const typeDeps = item.dependencies.filter(
        d => d.dependencyKind === 'reviewed_product_type' || d.dependencyKind === 'execution_product_type',
      );

      if (item.isUniversal) {
        if (typeDeps.length > 0) {
          return {
            ok: false,
            code: 'universal_proposal_has_type_dependency',
            reason: `Universal attribute proposal ${p.id} (target "${p.targetId ?? '<none>'}") carries unexpected product-type dependency; universal proposals must not depend on Product Type.`,
          };
        }
        continue;
      }

      // Non-universal / type-dependent proposal (e.g. gated field assignment or category page)
      if (p.proposalType === 'field_assignment' || p.proposalType === 'category_page') {
        if (!item.isUniversal && typeDeps.length === 0) {
          return {
            ok: false,
            code: 'missing_type_dependency',
            reason: `Type-dependent proposal ${p.id} (target "${p.targetId ?? '<none>'}") is missing required reviewed_product_type dependency.`,
          };
        }
        for (const dep of typeDeps) {
          if (dep.dependencyTargetId !== effectiveTypeId) {
            return {
              ok: false,
              code: 'stale_proposal',
              reason: `Accepted proposal ${p.id} carries a ${dep.dependencyKind} dependency targeting "${dep.dependencyTargetId ?? '<none>'}", but current effective type is "${effectiveTypeId}".`,
            };
          }
          if (dep.dependencyValueHash == null || dep.dependencyValueHash !== canonicalValueHash) {
            return {
              ok: false,
              code: 'stale_proposal',
              reason: `Accepted proposal ${p.id} carries a ${dep.dependencyKind} dependency whose value hash ${dep.dependencyValueHash ?? '<missing>'} does not match current authority hash ${canonicalValueHash}.`,
            };
          }
        }
      }
    }
  }

  return {
    ok: true,
    effectiveTypeId,
    decisionId: decision.id,
    decisionOrigin: origin,
    canonicalValueHash,
  };
}

/**
 * DB loader helper to load context and evaluate Product Type currentness.
 */
export function loadAndValidateProductTypeCurrentness(
  db: Database,
  options: {
    workspaceId: string;
    activeRunId: string;
    onboardingItemId?: string | null;
    productSku: string;
  },
): ProductTypeCurrentnessResult {
  const { workspaceId, activeRunId, onboardingItemId, productSku } = options;

  const runRow = db.query(
    `SELECT id, workspace_id, onboarding_item_id, product_sku, status, config_snapshot_hash, cohort_run_id
     FROM classification_runs WHERE id = ?`,
  ).get(activeRunId) as {
    id: string;
    workspace_id: string;
    onboarding_item_id: string | null;
    product_sku: string;
    status: string;
    config_snapshot_hash: string | null;
    cohort_run_id: string | null;
  } | undefined;

  if (!runRow) {
    return { ok: false, code: 'run_not_found', reason: `Classification run ${activeRunId} not found.` };
  }

  const activeRun: ActiveRunContext = {
    id: runRow.id,
    workspaceId: runRow.workspace_id,
    onboardingItemId: runRow.onboarding_item_id,
    productSku: runRow.product_sku,
    status: runRow.status,
    configSnapshotHash: runRow.config_snapshot_hash,
    cohortRunId: runRow.cohort_run_id,
  };

  let parentRun: ParentRunContext | null = null;
  if (runRow.cohort_run_id) {
    const parentRow = db.query(
      `SELECT id, workspace_id, status FROM classification_cohort_runs WHERE id = ?`,
    ).get(runRow.cohort_run_id) as { id: string; workspace_id: string; status: string } | undefined;
    if (parentRow) {
      parentRun = {
        id: parentRow.id,
        workspaceId: parentRow.workspace_id,
        status: parentRow.status,
      };
    }
  }

  const snapshot = runRow.config_snapshot_hash
    ? getRuntimeSnapshotByHash(workspaceId, runRow.config_snapshot_hash)
    : null;

  // Active Primary Product Type proposal
  const typeProposalRow = db.query(
    `SELECT p.*,
            d.id as decision_id, d.decision, d.decision_origin, d.reviewer_id,
            d.revised_from_id, d.revised_value_json, d.revised_target_id,
            d.has_revised_target, d.superseded_at as decision_superseded_at
     FROM classification_proposals p
     LEFT JOIN classification_proposal_decisions d
       ON d.proposal_id = p.id AND d.superseded_at IS NULL
     WHERE p.run_id = ? AND p.proposal_type = 'primary_product_type' AND p.superseded_at IS NULL
     ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(activeRunId) as Record<string, any> | undefined;

  let primaryTypeProposal: ClassificationProposal | null = null;
  let primaryTypeDecision: DecisionRecordContext | null = null;

  if (typeProposalRow) {
    const hasRevisedValue =
      typeProposalRow.revised_value_json !== null && typeProposalRow.revised_value_json !== undefined;
    const hasRevisedTargetId =
      typeProposalRow.has_revised_target !== null && typeProposalRow.has_revised_target !== undefined
        ? Number(typeProposalRow.has_revised_target) === 1
        : typeProposalRow.revised_target_id !== null && typeProposalRow.revised_target_id !== undefined;

    primaryTypeProposal = {
      id: String(typeProposalRow.id),
      runId: String(typeProposalRow.run_id),
      productSku: String(typeProposalRow.product_sku),
      proposalType: 'primary_product_type',
      targetId: typeProposalRow.target_id ? String(typeProposalRow.target_id) : null,
      proposedValue: typeProposalRow.proposed_value_json
        ? JSON.parse(String(typeProposalRow.proposed_value_json))
        : null,
      confidence: Number(typeProposalRow.confidence),
      status: String(typeProposalRow.status) as ClassificationProposal['status'],
      isBulkAcceptable: Number(typeProposalRow.is_bulk_acceptable) === 1,
      isStale: Number(typeProposalRow.is_stale) === 1,
      stalenessReason: typeProposalRow.staleness_reason ? String(typeProposalRow.staleness_reason) : null,
      evidenceIds: typeProposalRow.evidence_ids_json ? JSON.parse(String(typeProposalRow.evidence_ids_json)) : [],
      ...(hasRevisedValue ? { revisedValue: JSON.parse(String(typeProposalRow.revised_value_json)) } : {}),
      hasRevisedValue,
      ...(hasRevisedTargetId ? { revisedTargetId: typeProposalRow.revised_target_id ? String(typeProposalRow.revised_target_id) : null } : {}),
      hasRevisedTargetId,
      currentDecisionId: typeProposalRow.decision_id ? String(typeProposalRow.decision_id) : null,
      createdAt: String(typeProposalRow.created_at),
    };

    if (typeProposalRow.decision_id) {
      primaryTypeDecision = {
        id: String(typeProposalRow.decision_id),
        decision: String(typeProposalRow.decision),
        decisionOrigin: typeProposalRow.decision_origin ? String(typeProposalRow.decision_origin) : null,
        reviewerId: typeProposalRow.reviewer_id ? String(typeProposalRow.reviewer_id) : null,
        revisedFromId: typeProposalRow.revised_from_id ? String(typeProposalRow.revised_from_id) : null,
        revisedValue: hasRevisedValue ? JSON.parse(String(typeProposalRow.revised_value_json)) : undefined,
        hasRevisedValue,
        revisedTargetId: hasRevisedTargetId ? (typeProposalRow.revised_target_id ? String(typeProposalRow.revised_target_id) : null) : undefined,
        hasRevisedTargetId,
        supersededAt: typeProposalRow.decision_superseded_at ? String(typeProposalRow.decision_superseded_at) : null,
      };
    }
  }

  // Active accepted proposals with dependencies
  const proposalRows = db.query(
    `SELECT p.*,
            d.revised_value_json, d.revised_target_id, d.has_revised_target,
            d.decision, d.id as decision_id
     FROM classification_proposals p
     JOIN classification_proposal_decisions d
       ON d.proposal_id = p.id AND d.superseded_at IS NULL AND d.decision = 'accepted'
     WHERE p.run_id = ? AND p.superseded_at IS NULL AND p.proposal_type != 'primary_product_type'`,
  ).all(activeRunId) as Record<string, any>[];

  const typeDependentProposals: ProposalWithDependencies[] = [];
  for (const row of proposalRows) {
    const deps = db.query(
      `SELECT dependency_kind, dependency_target_id, dependency_value_hash
       FROM classification_proposal_dependencies
       WHERE proposal_id = ?`,
    ).all(row.id) as Array<{
      dependency_kind: string;
      dependency_target_id: string | null;
      dependency_value_hash: string | null;
    }>;

    let isUniversal = false;
    if (snapshot && row.proposal_type === 'field_assignment' && row.target_id) {
      const attr = snapshot.attributes.find(a => a.id === row.target_id);
      if (attr && isUniversalAttribute(attr)) {
        isUniversal = true;
      }
    }

    const hasRevisedValue = row.revised_value_json !== null && row.revised_value_json !== undefined;
    const hasRevisedTargetId =
      row.has_revised_target !== null && row.has_revised_target !== undefined
        ? Number(row.has_revised_target) === 1
        : row.revised_target_id !== null && row.revised_target_id !== undefined;

    typeDependentProposals.push({
      proposal: {
        id: String(row.id),
        runId: String(row.run_id),
        productSku: String(row.product_sku),
        proposalType: String(row.proposal_type) as ClassificationProposal['proposalType'],
        targetId: row.target_id ? String(row.target_id) : null,
        proposedValue: row.proposed_value_json ? JSON.parse(String(row.proposed_value_json)) : null,
        confidence: Number(row.confidence),
        status: String(row.status) as ClassificationProposal['status'],
        isBulkAcceptable: Number(row.is_bulk_acceptable) === 1,
        isStale: Number(row.is_stale) === 1,
        stalenessReason: row.staleness_reason ? String(row.staleness_reason) : null,
        evidenceIds: row.evidence_ids_json ? JSON.parse(String(row.evidence_ids_json)) : [],
        ...(hasRevisedValue ? { revisedValue: JSON.parse(String(row.revised_value_json)) } : {}),
        hasRevisedValue,
        ...(hasRevisedTargetId ? { revisedTargetId: row.revised_target_id ? String(row.revised_target_id) : null } : {}),
        hasRevisedTargetId,
        currentDecisionId: row.decision_id ? String(row.decision_id) : null,
        createdAt: String(row.created_at),
      },
      dependencies: deps.map(d => ({
        dependencyKind: d.dependency_kind,
        dependencyTargetId: d.dependency_target_id,
        dependencyValueHash: d.dependency_value_hash,
      })),
      isUniversal,
    });
  }

  return evaluateProductTypeCurrentness({
    workspaceId,
    onboardingItemId,
    productSku,
    activeRun,
    parentRun,
    snapshot,
    primaryTypeProposal,
    primaryTypeDecision,
    typeDependentProposals,
  });
}
