/**
 * Shared durable decision-set lifecycle (plan Slice 3, §2.2).
 *
 * One lifecycle shared by exactly two known kinds — coordinated titles and
 * coordinated Category Pages. Slice 3 wired the title kind; Slice 4 wired
 * the Page kind onto the same closed branch. This module owns the KIND-AGNOSTIC
 * mechanics only:
 *
 * - exact-set/hash inspection of a persisted output set
 *   (`inspectDurableSet`) — empty vs complete-match vs write-once drift;
 * - per-row parse-failure collection (`collectRowParseFailures`) — corrupt
 *   rows never yield usable outputs silently;
 * - write-once insert with commit-race → drift conversion
 *   (`insertDecisionSetOnce`) — a sibling commit between the pure-read check
 *   and the insert can never silently split the set;
 * - lease-scoped ownership around generation + insert
 *   (`withOwnedDecisionScope`) — a stale owner aborts with
 *   `HeartbeatLostError` and zero rows.
 *
 * What lives here deliberately does NOT include: hash computation, target-set
 * derivation, cross-parent copy policy, engine invocation, or member-input
 * selection — those are per-kind policy in `titles.ts` and `pages.ts`.
 * There is no plugin registry, no configurable
 * strategy catalogue, no generic `DecisionSpec`, no event sourcing, and no
 * externally supplied hash/parse/persist policy: the closed
 * `DurableDecisionKind` branch below is exhaustive, and each kind's
 * implementation is an explicit module, not a registration.
 *
 * Package-internal seam, not a public workflow step. Never imports the
 * transitional `../cohort-curator` (boundary R2) — only the repository layer,
 * the scoped lease keeper, and error identity.
 */
import { CohortOutputAlreadyCommittedError } from '../../db/repositories/classification-cohort-output-repo';
import { CohortLeaseKeeper } from './execution-lease';
import { COHORT_LEASE_TTL_MS } from '../../db/repositories/classification-cohort-run-repo';

/**
 * The closed set of durable parent decision kinds — titles and pages, each
 * with an explicit implementation module. Never a third string, never a
 * runtime registry.
 */
export type DurableDecisionKind = 'curated_title' | 'coordinated_page';

/** All known kinds, for exhaustive branching (not for iteration). */
export const DURABLE_DECISION_KINDS: readonly DurableDecisionKind[] = [
  'curated_title',
  'coordinated_page',
];

/** Compile-time exhaustiveness guard for closed-kind branches. */
export function assertExhaustiveDecisionKind(kind: never): never {
  throw new Error(`Unhandled durable decision kind: ${String(kind)}`);
}

// ─── Set inspection ───────────────────────────────────────────────────────────

/** One persisted output row as the lifecycle sees it (no payload parsing). */
export interface DurableSetRow {
  productSku: string;
  inputHash: string;
}

export type DurableSetStatus =
  /** No rows: the kind may coordinate (or copy, where its policy allows). */
  | { status: 'empty' }
  /** Exactly the expected member set and every row matches the fresh hash. */
  | { status: 'complete-match' }
  /**
   * A NONEMPTY set that is incomplete, over-complete, or hash-mismatched.
   * The set is write-once and can never be replaced — the kind must fail
   * closed (never re-coordinate, never delete).
   */
  | { status: 'drift'; storedHashes: string[]; rowCount: number };

/**
 * Classify a persisted output set against the kind's expected member set and
 * freshly computed input hash. Pure reads only — no keeper, no transport, no
 * writes. Exact-set equality: count equality AND membership equality (a
 * same-hash set carrying unexpected extra rows is corruption, not reuse).
 */
export function inspectDurableSet(params: {
  expectedSkus: ReadonlySet<string>;
  rows: DurableSetRow[];
  inputHash: string;
}): DurableSetStatus {
  const { expectedSkus, rows, inputHash } = params;
  if (rows.length === 0) return { status: 'empty' };
  const rowBySku = new Map(rows.map(row => [row.productSku, row]));
  const complete =
    rows.length === expectedSkus.size && [...expectedSkus].every(sku => rowBySku.has(sku));
  const hashMatch = rows.every(row => row.inputHash === inputHash);
  if (complete && hashMatch) return { status: 'complete-match' };
  return {
    status: 'drift',
    storedHashes: [...new Set(rows.map(row => row.inputHash))],
    rowCount: rows.length,
  };
}

// ─── Parse-failure collection ─────────────────────────────────────────────────

/** One row that failed to parse, with its original cause (diagnostic only). */
export interface CorruptRowFailure {
  sku: string;
  cause: string;
}

/**
 * Parse every expected row; collect per-SKU failures instead of throwing on
 * the first. A corrupt persisted row never yields a usable output silently —
 * the kind turns a nonempty failure list into its corrupt-set error (parent
 * supersession, never member failure, never partial use).
 */
export function collectRowParseFailures<T>(
  expectedSkus: ReadonlySet<string>,
  parse: (sku: string) => T,
): { parsed: Map<string, T>; failures: CorruptRowFailure[] } {
  const parsed = new Map<string, T>();
  const failures: CorruptRowFailure[] = [];
  for (const sku of expectedSkus) {
    try {
      parsed.set(sku, parse(sku));
    } catch (err) {
      failures.push({ sku, cause: err instanceof Error ? err.message : String(err) });
    }
  }
  return { parsed, failures };
}

// ─── Write-once insert with commit-race conversion ────────────────────────────

/**
 * Run a kind's all-or-nothing insert. A
 * `CohortOutputAlreadyCommittedError` — a sibling committed a set for this
 * run between the pure-read inspection and this insert — is converted to the
 * kind's drift error (built from a fresh read of the committed set) so the
 * set can never be silently split or double-written. Any other error
 * propagates unchanged (a persistence failure leaves zero rows callers can
 * see — the insert is all-or-nothing).
 */
export function insertDecisionSetOnce(params: {
  insert: () => void;
  readCommittedHashes: () => DurableSetRow[];
  toDriftError: (storedHashes: string[], rowCount: number) => Error;
}): void {
  try {
    params.insert();
  } catch (err) {
    if (err instanceof CohortOutputAlreadyCommittedError) {
      const committed = params.readCommittedHashes();
      throw params.toDriftError(
        [...new Set(committed.map(row => row.inputHash))],
        committed.length,
      );
    }
    throw err;
  }
}

// ─── Lease-scoped ownership ───────────────────────────────────────────────────

/**
 * Run generation + insert under a scoped `CohortLeaseKeeper` owned by the
 * run's claim holder. The keeper asserts ownership before the body starts
 * (start() renews first — a stale pre-reclaim worker throws before any side
 * effect), the body re-asserts after awaits before writes, and a lost claim
 * aborts with `HeartbeatLostError` (never converted into a fallback outcome).
 * The timer stops in `finally` on success, failure, crash simulation, and
 * ownership loss.
 */
export async function withOwnedDecisionScope<T>(params: {
  runId: string;
  workerId: string;
  ttlMs?: number;
  body: (keeper: CohortLeaseKeeper) => T | Promise<T>;
}): Promise<T> {
  const keeper = new CohortLeaseKeeper(
    params.runId,
    params.workerId,
    params.ttlMs ?? COHORT_LEASE_TTL_MS,
  ).start();
  try {
    return await params.body(keeper);
  } finally {
    keeper.stop();
  }
}
