/**
 * Filename allocation contract (issue #106, SEQUENCE 1b/1c).
 *
 * Determinism is defined over: allocation version + candidate identities /
 * bases + kept ownership + catalog/pending snapshot. Persisted assignments
 * never renumber; previews carry their allocation scope/snapshot label.
 * Pure module: no imports, no DB.
 */
import { createHash } from 'node:crypto';

/** Allocation algorithm version — bump only with a deliberate contract change. */
export const FILENAME_ALLOCATION_VERSION = 1;

export type AllocationScope = 'promotion' | 'preview' | 'reimport';

export interface AllocationCandidate {
  /** Disambiguated allocation key (UPC + item id). */
  key: string;
  itemId: string;
  base: string;
}

export interface AllocationRecord {
  itemId: string;
  base: string;
  assigned: string;
  /** Numeric suffix (2, 3, …) or null when the base was kept as-is. */
  suffix: number | null;
  algorithmVersion: number;
  candidateKey: string;
  candidateBase: string;
  keptOwnership: boolean;
  snapshotRef: string;
  scope: AllocationScope;
}

/**
 * Deterministic snapshot identity over the taken set (case-insensitive,
 * order-independent). Re-running an allocation with the same version +
 * candidates + taken set reproduces the assignment (story 21).
 */
export function computeTakenSnapshotRef(taken: Iterable<string>): string {
  const names = [...taken].map((t) => t.toLowerCase()).sort();
  return createHash('sha1').update(JSON.stringify(names)).digest('hex').slice(0, 16);
}

/** Human label pinning a preview/allocation to its scope + snapshot. */
export function allocationScopeLabel(scope: AllocationScope, snapshotRef: string): string {
  return `${scope} allocation · snapshot ${snapshotRef} · v${FILENAME_ALLOCATION_VERSION}`;
}

function suffixOf(base: string, assigned: string): number | null {
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const match = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?\\.html$`, 'i').exec(assigned);
  if (!match) return null;
  return match[1] ? Number(match[1]) : null;
}

/**
 * Build reconstructible allocation records from an allocation run
 * (story 21: base, assigned value, suffix, algorithm version, candidate
 * set, replayable snapshot refs). Kept-ownership rows (existing live names)
 * are recorded with `keptOwnership: true` and never renumbered.
 */
export function buildAllocationRecords(args: {
  candidates: AllocationCandidate[];
  taken: Iterable<string>;
  assigned: Map<string, string>;
  keptIds: Set<string>;
  keptNames?: Map<string, string>;
  snapshotRef: string;
  scope: AllocationScope;
}): AllocationRecord[] {
  const records: AllocationRecord[] = [];
  for (const candidate of args.candidates) {
    const assignedName = args.assigned.get(candidate.key);
    if (!assignedName) continue;
    records.push({
      itemId: candidate.itemId,
      base: candidate.base,
      assigned: assignedName,
      suffix: suffixOf(candidate.base, assignedName),
      algorithmVersion: FILENAME_ALLOCATION_VERSION,
      candidateKey: candidate.key,
      candidateBase: candidate.base,
      keptOwnership: false,
      snapshotRef: args.snapshotRef,
      scope: args.scope,
    });
  }
  for (const id of args.keptIds) {
    const name = args.keptNames?.get(id);
    if (!name) continue;
    records.push({
      itemId: id,
      base: name,
      assigned: name,
      suffix: null,
      algorithmVersion: FILENAME_ALLOCATION_VERSION,
      candidateKey: id,
      candidateBase: name,
      keptOwnership: true,
      snapshotRef: args.snapshotRef,
      scope: args.scope,
    });
  }
  return records;
}
