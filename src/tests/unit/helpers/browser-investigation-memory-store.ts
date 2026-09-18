// Shared in-memory InvestigationStore for browser investigation Vitest suites.
//
// Lifecycle (T1 fake-provider behavior) and harness (T3 provider + seam
// re-checks) suites share the same store semantics: one definition here so
// the suites cannot drift. Pure (no DB, no network): Vitest-safe.

import type { InvestigationRecord } from '../../../shared/schemas/browser-investigation';
import type {
  InvestigationStore,
  StoredInvestigationInsert,
} from '../../../onboarding/browser-investigation/service';
function parseJsonField(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Fresh in-memory store keyed by (workspaceId, id), mirroring the SQLite adapter. */
export function createMemoryInvestigationStore(): InvestigationStore & {
  rows: Map<string, InvestigationRecord>;
} {
  const rows = new Map<string, InvestigationRecord>();
  const key = (ws: string, id: string) => `${ws}::${id}`;
  return {
    rows,
    insert(row: StoredInvestigationInsert) {
      const record = {
        id: row.id ?? `mem_${rows.size + 1}`,
        workspaceId: row.workspaceId,
        domain: row.domain,
        mode: row.mode,
        status: row.status,
        provider: row.provider,
        runId: row.runId,
        requestedModel: parseJsonField(row.requestedModelJson),
        actualModel: parseJsonField(row.actualModelJson),
        inputSnapshot: JSON.parse(row.inputSnapshotJson) as InvestigationRecord['inputSnapshot'],
        inputHash: row.inputHash,
        budget: JSON.parse(row.budgetJson) as InvestigationRecord['budget'],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        startedAt: row.startedAt ?? null,
        completedAt: row.completedAt ?? null,
        usage: parseJsonField(row.usageJson),
        failureCode: (row.failureCode as InvestigationRecord['failureCode']) ?? null,
        failureDetail: row.failureDetail ?? null,
        result: parseJsonField(row.resultJson),
        resultHash: row.resultHash ?? null,
        discardedAt: row.discardedAt ?? null,
        discardActor: row.discardActor ?? null,
      } as InvestigationRecord;
      rows.set(key(record.workspaceId, record.id), record);
      return record;
    },
    find: (ws, id) => rows.get(key(ws, id)) ?? null,
    list: (ws, domain) =>
      [...rows.values()].filter((r) => r.workspaceId === ws && (!domain || r.domain === domain)),
    findActive: (ws, domain) =>
      [...rows.values()].find(
        (r) => r.workspaceId === ws && r.domain === domain && (r.status === 'queued' || r.status === 'running'),
      ) ?? null,
    existsInOtherWorkspace: (ws, id) => [...rows.values()].some((r) => r.id === id && r.workspaceId !== ws),
    update: (ws, id, patch) => {
      const cur = rows.get(key(ws, id));
      if (!cur) return null;
      const next = { ...cur, updatedAt: patch.updatedAt } as InvestigationRecord;
      if (patch.status !== undefined) next.status = patch.status as InvestigationRecord['status'];
      // JSON-encoded columns decode on write; scalar columns assign directly.
      for (const [patchKey, recordKey] of [
        ['actualModelJson', 'actualModel'],
        ['usageJson', 'usage'],
        ['resultJson', 'result'],
      ] as const) {
        const encoded = patch[patchKey];
        if (encoded !== undefined && encoded !== null) {
          (next as Record<string, unknown>)[recordKey] = JSON.parse(encoded) as unknown;
        }
      }
      for (const field of [
        'startedAt',
        'completedAt',
        'failureCode',
        'failureDetail',
        'resultHash',
        'discardedAt',
        'discardActor',
      ] as const) {
        const value = patch[field];
        if (value !== undefined) (next as Record<string, unknown>)[field] = value;
      }
      rows.set(key(ws, id), next);
      return next;
    },
  };
}

/**
 * Single-record store for apply-path suites: one completed investigation
 * plus strict foreign-workspace semantics. Shared by the T2 apply
 * governance and T4 validation-binding suites so scoping cannot drift.
 */
// apply suites + future validation suites
export function memoryInvestigationsFor(record: InvestigationRecord): InvestigationStore {
  return {
    insert(row: StoredInvestigationInsert) {
      throw new Error(`unexpected insert ${row.domain}`);
    },
    find: (workspaceId: string, id: string) =>
      workspaceId === record.workspaceId && id === record.id ? record : null,
    list: () => [record],
    findActive: () => null,
    existsInOtherWorkspace: (workspaceId: string, id: string) =>
      id === record.id && workspaceId !== record.workspaceId,
    update: () => null,
  };
}
