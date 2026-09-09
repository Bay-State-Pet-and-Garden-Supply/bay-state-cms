/**
 * Type Change Impact Analysis (P1.1).
 *
 * Pure analysis of what happens when a reviewer changes or clears the
 * Primary Product Type of an onboarding item or classification run.
 *
 * Invariants:
 * 1. Universals are independent of Product Type and remain valid.
 * 2. Non-universal field assignments and category pages that depend on the old
 *    type are invalidated (staled).
 * 3. If the candidate type matches the run's original Execution Product Type,
 *    matching proposals can be preserved rather than staled.
 * 4. Explicit clear (candidateProductTypeId: null) invalidates all type-dependent proposals
 *    and produces no recomputable candidate attributes.
 */

import type { ClassificationProposal } from '../shared/types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { isUniversalAttribute } from './applicability-evaluator';
import { getEffectivePrimaryProductTypeId } from './assignment-projection';

export interface ProposalDependencyRecord {
  proposalId: string;
  dependencyKind: string;
  dependencyTargetId: string | null;
  dependencyValueHash?: string | null;
}

export interface AnalyzeProductTypeImpactInput {
  runId: string;
  candidateProductTypeId: string | null;
  activeProposals: ClassificationProposal[];
  dependencies: ProposalDependencyRecord[];
  snapshot?: RuntimeClassificationSnapshot | null;
  executionProductTypeId?: string | null;
  executionAuthorityHash?: string | null;
  /** Optional lineage for strict execution revalidation (plan P1.1-6). When supplied, all must match. */
  workspaceId?: string | null;
  expectedWorkspaceId?: string | null;
  snapshotHash?: string | null;
  expectedSnapshotHash?: string | null;
  parentRunId?: string | null;
  expectedParentRunId?: string | null;
  parentStatus?: string | null;
}

export interface InvalidationItem {
  proposalId: string;
  targetId: string | null;
  proposalType: string;
  reason: string;
}

export interface PreservedItem {
  proposalId: string;
  targetId: string | null;
  proposalType: string;
  matchedKind: 'execution_alignment' | 'dependency_match';
}

export interface UniversalPreservedItem {
  proposalId: string;
  targetId: string | null;
  proposalType: string;
}

export interface RecomputeItem {
  targetId: string | null;
  proposalType: string;
}

export interface ProductTypeImpactAnalysis {
  candidateProductTypeId: string | null;
  isClear: boolean;
  isUnchanged: boolean;
  hasExecutionTypeAlignment: boolean;
  dependentProposalsToInvalidate: InvalidationItem[];
  universalProposalsPreserved: UniversalPreservedItem[];
  preservedProposals: PreservedItem[];
  proposalsToRecompute: RecomputeItem[];
  summary: {
    totalActiveProposals: number;
    dependentInvalidatedCount: number;
    universalPreservedCount: number;
    preservedCount: number;
    recomputeCount: number;
  };
}

export function analyzeProductTypeImpact(
  input: AnalyzeProductTypeImpactInput,
): ProductTypeImpactAnalysis {
  const {
    candidateProductTypeId,
    activeProposals,
    dependencies,
    snapshot,
    executionProductTypeId,
    executionAuthorityHash,
  } = input;

  const isClear = candidateProductTypeId === null;
  const primaryProposal = activeProposals.find(p => p.proposalType === 'primary_product_type');
  const currentTypeId = primaryProposal ? getEffectivePrimaryProductTypeId(primaryProposal) : null;
  const isUnchanged = candidateProductTypeId === currentTypeId;

  const hasExecutionTypeAlignment =
    !isClear &&
    executionProductTypeId !== null &&
    executionProductTypeId !== undefined &&
    candidateProductTypeId === executionProductTypeId;

  const depsByProposal = new Map<string, ProposalDependencyRecord[]>();
  for (const dep of dependencies) {
    const list = depsByProposal.get(dep.proposalId) ?? [];
    list.push(dep);
    depsByProposal.set(dep.proposalId, list);
  }

  const dependentProposalsToInvalidate: InvalidationItem[] = [];
  const universalProposalsPreserved: UniversalPreservedItem[] = [];
  const preservedProposals: PreservedItem[] = [];
  const proposalsToRecompute: RecomputeItem[] = [];

  // If unchanged, no invalidations needed — but never revive already-stale rows.
  if (isUnchanged) {
    for (const p of activeProposals) {
      if (p.proposalType === 'primary_product_type') continue;
      if ((p as { isStale?: boolean }).isStale || (p as { status?: string }).status === 'stale') continue;
      if (p.proposalType === 'field_assignment' && p.targetId && snapshot) {
        const attr = snapshot.attributes.find(a => a.id === p.targetId);
        if (attr && isUniversalAttribute(attr)) {
          universalProposalsPreserved.push({
            proposalId: p.id,
            targetId: p.targetId,
            proposalType: p.proposalType,
          });
          continue;
        }
      }
      preservedProposals.push({
        proposalId: p.id,
        targetId: p.targetId ?? null,
        proposalType: p.proposalType,
        matchedKind: 'dependency_match',
      });
    }

    return {
      candidateProductTypeId,
      isClear,
      isUnchanged,
      hasExecutionTypeAlignment,
      dependentProposalsToInvalidate,
      universalProposalsPreserved,
      preservedProposals,
      proposalsToRecompute,
      summary: {
        totalActiveProposals: activeProposals.length,
        dependentInvalidatedCount: 0,
        universalPreservedCount: universalProposalsPreserved.length,
        preservedCount: preservedProposals.length,
        recomputeCount: 0,
      },
    };
  }

  for (const p of activeProposals) {
    if (p.proposalType === 'primary_product_type') continue;
    // Never preserve already-stale rows as valid.
    if ((p as { isStale?: boolean }).isStale || (p as { status?: string }).status === 'stale') continue;

    // Check universal attributes
    if (p.proposalType === 'field_assignment' && p.targetId && snapshot) {
      const attr = snapshot.attributes.find(a => a.id === p.targetId);
      if (attr && isUniversalAttribute(attr)) {
        universalProposalsPreserved.push({
          proposalId: p.id,
          targetId: p.targetId,
          proposalType: p.proposalType,
        });
        continue;
      }
    }

    // Type-dependent proposal
    const pDeps = depsByProposal.get(p.id) ?? [];
    const typeDep = pDeps.find(
      d => d.dependencyKind === 'reviewed_product_type' || d.dependencyKind === 'execution_product_type',
    );

    // If candidate matches original execution type and proposal has matching execution dependency
    // Strict: require exact target + exact hash (no falsy bypass) + optional lineage conjuncts.
    const lineageOk =
      (input.workspaceId === undefined || input.expectedWorkspaceId === undefined || input.workspaceId === input.expectedWorkspaceId) &&
      (input.snapshotHash === undefined || input.expectedSnapshotHash === undefined || input.snapshotHash === input.expectedSnapshotHash) &&
      (input.parentRunId === undefined || input.expectedParentRunId === undefined || input.parentRunId === input.expectedParentRunId) &&
      (input.parentStatus === undefined || input.parentStatus === null || input.parentStatus === 'completed' || input.parentStatus === 'completed_with_abstentions' || input.parentStatus === 'completed_with_member_failures');
    if (
      hasExecutionTypeAlignment &&
      lineageOk &&
      typeDep &&
      typeDep.dependencyTargetId === candidateProductTypeId &&
      executionAuthorityHash != null &&
      typeDep.dependencyValueHash === executionAuthorityHash
    ) {
      preservedProposals.push({
        proposalId: p.id,
        targetId: p.targetId ?? null,
        proposalType: p.proposalType,
        matchedKind: 'execution_alignment',
      });
      continue;
    }

    // Otherwise invalidated
    const reason = isClear ? 'product_type_cleared' : 'product_type_changed';
    dependentProposalsToInvalidate.push({
      proposalId: p.id,
      targetId: p.targetId ?? null,
      proposalType: p.proposalType,
      reason,
    });

    // If not a clear, queue recompute
    if (!isClear) {
      proposalsToRecompute.push({
        targetId: p.targetId ?? null,
        proposalType: p.proposalType,
      });
    }
  }

  return {
    candidateProductTypeId,
    isClear,
    isUnchanged,
    hasExecutionTypeAlignment,
    dependentProposalsToInvalidate,
    universalProposalsPreserved,
    preservedProposals,
    proposalsToRecompute,
    summary: {
      totalActiveProposals: activeProposals.length,
      dependentInvalidatedCount: dependentProposalsToInvalidate.length,
      universalPreservedCount: universalProposalsPreserved.length,
      preservedCount: preservedProposals.length,
      recomputeCount: proposalsToRecompute.length,
    },
  };
}
