/**
 * Epic #46 — Approval + Ready-to-Export logic (pure, unit-tested).
 * Selection state, per-item outcome aggregation, and export-status
 * derivation. No React imports.
 */
import type {
  ApprovalItemOutcome,
  WorkStateCategory,
} from '../../../../shared/schemas/onboarding-work-state';

// ─── Selection state ───────────────────────────────────────────────────────────

export interface SelectionState {
  selectedIds: string[];
  allEligibleIds: string[];
}

export function toggleSelection(state: SelectionState, itemId: string): SelectionState {
  return {
    ...state,
    selectedIds: state.selectedIds.includes(itemId)
      ? state.selectedIds.filter(id => id !== itemId)
      : [...state.selectedIds, itemId],
  };
}

/** 'Select all' only covers eligible (fetched) ids. */
export function selectAll(state: SelectionState): SelectionState {
  return { ...state, selectedIds: [...state.allEligibleIds] };
}

export function clearSelection(state: SelectionState): SelectionState {
  return { ...state, selectedIds: [] };
}

export function allSelected(state: SelectionState): boolean {
  return (
    state.allEligibleIds.length > 0 && state.selectedIds.length === state.allEligibleIds.length
  );
}

export function anySelected(state: SelectionState): boolean {
  return state.selectedIds.length > 0;
}

/** Prune selection to ids that still exist in the eligible set. */
export function pruneSelection(state: SelectionState, eligibleIds: string[]): SelectionState {
  const eligible = new Set(eligibleIds);
  return {
    ...state,
    allEligibleIds: [...eligibleIds],
    selectedIds: state.selectedIds.filter(id => eligible.has(id)),
  };
}

// ─── Outcome aggregation ───────────────────────────────────────────────────────

export interface ApprovalOutcomeSummary {
  approvedCount: number;
  rejectedCount: number;
  rejected: ApprovalItemOutcome[];
  /** Ids that were approved — for moving rows out of the eligible view. */
  approvedIds: string[];
  /** Ids that were rejected — a retry candidate set. */
  retryIds: string[];
}

export function summarizeOutcomes(results: ApprovalItemOutcome[]): ApprovalOutcomeSummary {
  const rejected = results.filter(r => r.status === 'rejected');
  const approvedIds = results.filter(r => r.status === 'approved').map(r => r.itemId);
  return {
    approvedCount: results.length - rejected.length,
    rejectedCount: rejected.length,
    rejected,
    approvedIds,
    retryIds: rejected.map(r => r.itemId),
  };
}

// ─── Export-status derivation ──────────────────────────────────────────────────

export interface ExportStatusPresentation {
  category: WorkStateCategory;
  /** Operator-facing section heading. */
  heading: string;
  /** Honest language — never 'published'. */
  description: string;
  /** Whether the draft-creation action applies here. */
  canCreateDrafts: boolean;
  /** Whether a change-set review link applies here. */
  canOpenChangeSet: boolean;
}

export function exportStatusPresentation(category: WorkStateCategory): ExportStatusPresentation {
  switch (category) {
    case 'approved':
      return {
        category,
        heading: 'Approved · awaiting CMS drafts',
        description:
          'Approved listings awaiting CMS product draft creation. Approval does not export or publish products.',
        canCreateDrafts: true,
        canOpenChangeSet: false,
      };
    case 'ready_to_export':
      return {
        category,
        heading: 'CMS drafts created',
        description:
          'CMS drafts have been created. Change-set approval, export, and publication remain separate steps.',
        canCreateDrafts: false,
        canOpenChangeSet: true,
      };
    case 'completed':
      return {
        category,
        heading: 'Export verified',
        description: 'The downstream export operation succeeded and was verified by the server.',
        canCreateDrafts: false,
        canOpenChangeSet: true,
      };
    case 'skipped':
      return {
        category,
        heading: 'Skipped · all stages',
        description: 'Products deliberately skipped anywhere in this batch. No approval or draft-creation action applies.',
        canCreateDrafts: false,
        canOpenChangeSet: false,
      };
    default:
      return {
        category,
        heading: 'Approved',
        description: '',
        canCreateDrafts: false,
        canOpenChangeSet: false,
      };
  }
}

export function exportActionLabel(category: WorkStateCategory): string {
  switch (category) {
    case 'approved':
      return 'Create CMS drafts';
    case 'ready_to_export':
      return 'Open Change Set Review';
    default:
      return 'Export';
  }
}

// ─── Approve-all confirm gate ──────────────────────────────────────────────────

export interface ConfirmGateState {
  open: boolean;
  count: number;
}

export function shouldConfirmApproveAll(count: number, requireConfirm: boolean): boolean {
  return requireConfirm && count > 0;
}
