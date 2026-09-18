// SQLite-backed InvestigationStore adapter (T1).
//
// Thin bridge between the pure lifecycle service and the SQLite repository.
// Importing this module pulls in bun:sqlite via the connection layer — the
// service itself stays import-clean so Vitest can exercise lifecycle logic
// with an in-memory store.

import {
  findActiveInvestigation,
  findInvestigationById,
  findInvestigationByIdAnyWorkspace,
  getInvestigationProposalState,
  getInvestigationValidationState,
  insertInvestigation,
  listInvestigationRecords as listRepoRecords,
  markInvestigationApplied,
  saveInvestigationProposal,
  saveInvestigationValidation,
  updateInvestigation as updateRepo,
  type InvestigationProposalState,
  type InvestigationValidationState,
} from '../../db/repositories/browser-investigation-repo';
import type { ProposalStore, StoredProposal } from './apply';
import type { InvestigationStore } from './service';
import type { StoredValidation, ValidationStore } from './validate';

export function createSqliteInvestigationStore(): InvestigationStore {
  return {
    insert(row) {
      return insertInvestigation({
        workspaceId: row.workspaceId,
        domain: row.domain,
        mode: row.mode,
        status: row.status,
        provider: row.provider,
        runId: row.runId,
        requestedModelJson: row.requestedModelJson,
        actualModelJson: row.actualModelJson,
        inputSnapshotJson: row.inputSnapshotJson,
        inputHash: row.inputHash,
        budgetJson: row.budgetJson,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        usageJson: row.usageJson,
        failureCode: row.failureCode,
        failureDetail: row.failureDetail,
        resultJson: row.resultJson,
        resultHash: row.resultHash,
        discardedAt: row.discardedAt,
        discardActor: row.discardActor,
        ...(row.id ? { id: row.id } : {}),
      });
    },
    find(workspaceId, id) {
      return findInvestigationById(workspaceId, id);
    },
    list(workspaceId, domain) {
      return listRepoRecords(workspaceId, domain);
    },
    findActive(workspaceId, domain) {
      return findActiveInvestigation(workspaceId, domain);
    },
    existsInOtherWorkspace(workspaceId, id) {
      const any = findInvestigationByIdAnyWorkspace(id);
      return !!any && any.workspaceId !== workspaceId;
    },
    update(workspaceId, id, patch) {
      return updateRepo(workspaceId, id, patch);
    },
  };
}

/** SQLite-backed ProposalStore adapter (T2). Thin bridge over the
 * investigation repository's proposal/apply columns. The repository row
 * shape and the domain proposal state are structurally identical; the
 * annotations below pin that boundary explicitly. */
export function createSqliteProposalStore(): ProposalStore {
  return {
    getProposal(workspaceId, investigationId): StoredProposal | null {
      const state: InvestigationProposalState | null = getInvestigationProposalState(workspaceId, investigationId);
      return state;
    },
    saveProposal(workspaceId, investigationId, proposalJson, proposalHash) {
      saveInvestigationProposal(workspaceId, investigationId, proposalJson, proposalHash);
    },
    markApplied(workspaceId, investigationId, versionId, actor, appliedAt) {
      markInvestigationApplied(workspaceId, investigationId, versionId, actor, appliedAt);
    },
  };
}

/** SQLite-backed ValidationStore adapter (T4). Thin bridge over the
 * investigation repository's validation-reference columns. */
export function createSqliteValidationStore(): ValidationStore {
  return {
    getValidation(workspaceId, investigationId): StoredValidation | null {
      const state: InvestigationValidationState | null = getInvestigationValidationState(
        workspaceId,
        investigationId,
      );
      return state;
    },
    saveValidation(workspaceId, investigationId, validationJson, validationHash, policyHash, validatedAt) {
      saveInvestigationValidation(workspaceId, investigationId, validationJson, validationHash, policyHash, validatedAt);
    },
  };
}
