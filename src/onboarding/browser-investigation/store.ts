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
  insertInvestigation,
  listInvestigationRecords as listRepoRecords,
  updateInvestigation as updateRepo,
} from '../../db/repositories/browser-investigation-repo';
import type { InvestigationStore } from './service';

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
