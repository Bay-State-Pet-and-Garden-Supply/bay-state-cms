/**
 * Slice 1 — deterministic fixture builder + independent oracle for v2 stage
 * reads (council plan §6 Slice 1).
 *
 * PURE module: no bun:test/bun:sqlite imports (Vitest-safe). Fixed seed
 * `stage-read-v1-001`, fixed ids/times/ordering — never random UUIDs or
 * current time in expected results.
 *
 * Oracle strategy (two legs, neither calls the endpoint implementation):
 * 1. Pure spec leg: stage/status/matrix expectations computed directly from
 *    fixture specs + the shared vocabulary maps (contract, not implementation).
 * 2. v1-differential leg (Bun tests only): category/facet expectations come
 *    from the FROZEN v1 projection on the same batch — v2 must agree on
 *    everything except stage vocabulary and limits.
 */
import {
  V1_TO_V2,
  STAGE_ORDER_V2,
  type StageV2,
} from '../../shared/onboarding-stage-vocabulary';
import type { StageStatus } from '../../shared/schemas/onboarding';

export const STAGE_READ_FIXTURE_SEED = 'stage-read-v1-001';

const V1_STAGES = ['sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion'] as const;
const STATUSES: StageStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'needs_input', 'skipped'];

export interface StageReadItemSpec {
  key: string;
  upc: string;
  name: string;
  brandHint: string | null;
  sourceType: 'official_page' | 'distributor_record';
  sourceUrl: string | null;
  stage: (typeof V1_STAGES)[number];
  stageStatus: StageStatus;
  rowNumber: number;
}

/** Deterministic PRNG (mulberry32) — fixed seed only. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function brandFor(i: number): string | null {
  if (i % 11 === 0) return null;
  const brands = ['Blue Buffalo', 'Purina', 'Acme Farms', 'Zeta Pet'];
  return brands[i % brands.length]!;
}

/** All 36 stage×status cells, one item each. Fixed ids/upcs/rowNumbers. */
export function build36CellSpecs(): StageReadItemSpec[] {
  const specs: StageReadItemSpec[] = [];
  let n = 0;
  for (const stage of V1_STAGES) {
    for (const status of STATUSES) {
      n += 1;
      const distributor = n % 5 === 0;
      specs.push({
        key: `cell-${stage}-${status}`,
        upc: `CELL-${stage}-${status}`,
        name: `Cell product ${stage} ${status} ${n}`,
        brandHint: brandFor(n),
        sourceType: distributor ? 'distributor_record' : 'official_page',
        sourceUrl: distributor ? null : `https://example-${n}.com/product/${n}`,
        stage,
        stageStatus: status,
        rowNumber: n,
      });
    }
  }
  return specs;
}

/** Large deterministic mixed set (default 600 rows) for pagination/sparse tests. */
export function buildLargeMixedSpecs(count = 600): StageReadItemSpec[] {
  const rand = seededRandom(0x51ab1e);
  const specs: StageReadItemSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const stage = V1_STAGES[Math.floor(rand() * V1_STAGES.length)]!;
    const status = STATUSES[Math.floor(rand() * STATUSES.length)]!;
    const distributor = rand() < 0.2;
    specs.push({
      key: `bulk-${i}`,
      upc: `BULK-${String(i).padStart(4, '0')}`,
      name: `Bulk product ${i} ${stage}`,
      brandHint: brandFor(i + 3),
      sourceType: distributor ? 'distributor_record' : 'official_page',
      sourceUrl: distributor ? null : `https://shop-${i % 37}.example.com/p/${i}`,
      stage,
      stageStatus: status,
      rowNumber: 1000 + i,
    });
  }
  return specs;
}

/** Sparse set: only 3 of 200 rows match a narrow filter (tests empty pages). */
export function buildSparseSpecs(): StageReadItemSpec[] {
  const specs: StageReadItemSpec[] = [];
  for (let i = 0; i < 200; i += 1) {
    const match = i === 17 || i === 88 || i === 150;
    specs.push({
      key: `sparse-${i}`,
      upc: `SPARSE-${String(i).padStart(3, '0')}`,
      name: match ? 'Sparse needle product alpha' : `Sparse filler product ${i}`,
      brandHint: 'Sparse Brand',
      sourceType: 'official_page',
      sourceUrl: `https://sparse.example.com/p/${i}`,
      stage: match ? 'curation' : 'sourcing',
      stageStatus: match ? 'pending' : 'pending',
      rowNumber: 2000 + i,
    });
  }
  return specs;
}

/** Duplicate row_numbers with opposite id ordering (tie-breaker coverage). */
export function buildDuplicateRowNumberSpecs(): StageReadItemSpec[] {
  return [
    {
      key: 'dup-b',
      upc: 'DUP-B',
      name: 'Dup product b',
      brandHint: 'Dup Brand',
      sourceType: 'official_page',
      sourceUrl: 'https://dup.example.com/b',
      stage: 'discovery',
      stageStatus: 'pending',
      rowNumber: 3000,
    },
    {
      key: 'dup-a',
      upc: 'DUP-A',
      name: 'Dup product a',
      brandHint: 'Dup Brand',
      sourceType: 'official_page',
      sourceUrl: 'https://dup.example.com/a',
      stage: 'discovery',
      stageStatus: 'pending',
      rowNumber: 3000,
    },
  ];
}

// ─── Pure-spec oracle (stage/status/matrix leg) ───────────────────────────────

export function canonicalStageOfSpec(spec: StageReadItemSpec): StageV2 {
  return V1_TO_V2[spec.stage];
}

export function expectedMatrixForSpecs(specs: StageReadItemSpec[]): Record<StageV2, Record<StageStatus, number>> {
  const matrix = {} as Record<StageV2, Record<StageStatus, number>>;
  for (const stage of STAGE_ORDER_V2) {
    matrix[stage] = { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 };
  }
  for (const spec of specs) {
    matrix[canonicalStageOfSpec(spec)][spec.stageStatus] += 1;
  }
  return matrix;
}

export function expectedIdsForStageFilter(
  specs: StageReadItemSpec[],
  stage: StageV2 | null,
  status: StageStatus | null,
): Set<string> {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (stage && canonicalStageOfSpec(spec) !== stage) continue;
    if (status && spec.stageStatus !== status) continue;
    ids.add(spec.upc);
  }
  return ids;
}

/** Canonical traversal order (row_number, upc-as-id-proxy) for page oracle. */
export function orderSpecsForTraversal(specs: StageReadItemSpec[]): StageReadItemSpec[] {
  return [...specs].sort((a, b) => (a.rowNumber !== b.rowNumber ? a.rowNumber - b.rowNumber : a.upc.localeCompare(b.upc)));
}
