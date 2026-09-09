/**
 * Slice 1 — v2 read-contract schema tests (Bun suite, pure — no DB).
 *
 * Runner note (plan deviation, Slice 1 acceptance): this suite MUST be Vitest
 * under a healthy toolchain, but vite-node cannot resolve zod v4's named `z`
 * export (pre-existing repo-wide breakage — e.g.
 * generate-selectors-schemas.test.ts fails identically on a clean tree), and
 * this contract's chain (./onboarding → ./classification) uses named imports.
 * It therefore runs under `bun test` with dual registration (test:db entry +
 * vitest exclude). Revisit when the toolchain issue is fixed.
 *
 * Covers strict filters, intentional v1/v2 limit divergence, v3 cursor
 * binding (scope/version/fingerprint), and error-code mapping. No DB.
 */
import { describe, it, expect } from 'bun:test';
import {
  StageReadFiltersSchema,
  computeStageReadFilterHashV2,
  encodeStageReadCursor,
  decodeStageReadCursor,
  validateStageReadCursor,
  StageReadCursorError,
  emptyStageStatusMatrix,
  emptyWorkStateCounts,
  STAGE_READ_CURSOR_VERSION,
  STAGE_READ_LIMIT_DEFAULT,
  STAGE_READ_LIMIT_MAX,
  sumStageStatusMatrix,
  type StageReadFilters,
} from '../../shared/schemas/onboarding-stage-read';

const SCOPE = { workspaceId: 'ws-1', batchId: 'batch-1' };

describe('strict filters', () => {
  it('accepts a full valid filter set', () => {
    const res = StageReadFiltersSchema.safeParse({
      stage: 'prepare_listing',
      stageStatus: 'pending',
      category: 'processing',
      reviewState: 'unreviewed',
      sourceType: 'official_page',
      domain: 'Example.COM',
      cohortId: 'cohort-1',
      q: 'buffalo',
      limit: 50,
    });
    expect(res.success).toBe(true);
  });

  it('rejects unknown fields (no broadening to all)', () => {
    expect(StageReadFiltersSchema.safeParse({ stage: 'prepare_listing', bogus: 'x' }).success).toBe(false);
  });

  it('rejects v1 stage strings and step zero in the filter schema', () => {
    expect(StageReadFiltersSchema.safeParse({ stage: 'sourcing' }).success).toBe(false);
    expect(StageReadFiltersSchema.safeParse({ stage: 'brand-setup' }).success).toBe(false);
  });

  it('enforces the intentional v2 limit divergence (1–100, default documented)', () => {
    expect(STAGE_READ_LIMIT_DEFAULT).toBe(50);
    expect(STAGE_READ_LIMIT_MAX).toBe(100);
    expect(StageReadFiltersSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(StageReadFiltersSchema.safeParse({ limit: 100 }).success).toBe(true);
    // v1 accepts these; v2 must not.
    expect(StageReadFiltersSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(StageReadFiltersSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(StageReadFiltersSchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(StageReadFiltersSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(StageReadFiltersSchema.safeParse({ limit: NaN }).success).toBe(false);
  });
});

describe('v2 fingerprint', () => {
  const base: Omit<StageReadFilters, 'cursor' | 'limit'> = { stage: 'collect_details', stageStatus: 'pending' };

  it('extends the facet set with stage/status/scope/version fields', () => {
    const a = computeStageReadFilterHashV2(base, SCOPE);
    const b = computeStageReadFilterHashV2({ ...base, stage: 'review_listings' }, SCOPE);
    const c = computeStageReadFilterHashV2(base, { ...SCOPE, batchId: 'batch-2' });
    const d = computeStageReadFilterHashV2({ ...base, stageStatus: undefined }, SCOPE);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('normalizes domain/q case and blank handling (lowercase-only, like v1)', () => {
    const a = computeStageReadFilterHashV2({ q: 'Buffalo ', domain: 'Example.COM' }, SCOPE);
    const b = computeStageReadFilterHashV2({ q: 'buffalo', domain: 'example.com' }, SCOPE);
    expect(a).toBe(b);
    // Blank free text is absent (v1 match-all semantics), not a distinct filter.
    expect(computeStageReadFilterHashV2({ q: '   ', domain: '  ' }, SCOPE)).toBe(computeStageReadFilterHashV2({}, SCOPE));
    // Host subdomains are distinct filters (no www-stripping in the hash).
    expect(computeStageReadFilterHashV2({ domain: 'www.example.com' }, SCOPE)).not.toBe(
      computeStageReadFilterHashV2({ domain: 'example.com' }, SCOPE),
    );
  });
});

describe('v3 cursor binding', () => {
  const filters: Omit<StageReadFilters, 'cursor' | 'limit'> = { stage: 'find_product_page' };
  const fingerprintOf = (f: typeof filters, s: typeof SCOPE) => computeStageReadFilterHashV2(f, s);

  function validCursor(): string {
    return encodeStageReadCursor({
      v: STAGE_READ_CURSOR_VERSION,
      rowNumber: 7,
      id: 'item-1',
      filterHash: fingerprintOf(filters, SCOPE),
      workspaceId: SCOPE.workspaceId,
      batchId: SCOPE.batchId,
      endpoint: 'stage-work-state',
      stageVocabularyVersion: 2,
    });
  }

  it('round-trips a valid cursor', () => {
    const payload = validateStageReadCursor(validCursor(), filters, SCOPE);
    expect(payload.rowNumber).toBe(7);
    expect(payload.id).toBe('item-1');
  });

  it('rejects legacy v1/v2 cursors with invalid_version (never silently accepted)', () => {
    const legacy = Buffer.from(JSON.stringify({ v: 2, rowNumber: 1, id: 'x', filterHash: 'a'.repeat(16) }), 'utf8').toString('base64url');
    try {
      decodeStageReadCursor(legacy);
      throw new Error('expected decode to throw');
    } catch (err) {
      expect((err as StageReadCursorError).code).toBe('invalid_version');
    }
    const ancient = Buffer.from(JSON.stringify({ v: 1, sortKey: 'k', itemId: 'x', filterHash: 'a'.repeat(16) }), 'utf8').toString('base64url');
    try {
      decodeStageReadCursor(ancient);
      throw new Error('expected decode to throw');
    } catch (err) {
      expect((err as StageReadCursorError).code).toBe('invalid_version');
    }
  });

  it('rejects malformed base64/JSON/structure with malformed_cursor', () => {
    for (const bad of ['!!!', 'e30', Buffer.from('[]', 'utf8').toString('base64url'), Buffer.from('{"v":3}', 'utf8').toString('base64url')]) {
      try {
        decodeStageReadCursor(bad);
        throw new Error('expected decode to throw: ' + bad);
      } catch (err) {
        expect((err as StageReadCursorError).code).toBe('malformed_cursor');
      }
    }
  });

  it('rejects changed-stage-only/status-only/facet-only/batch/workspace fingerprints distinctly', () => {
    const changedStage = validateStageReadCursorChecked(validCursor(), { stage: 'create_drafts' }, SCOPE, 'filter_mismatch');
    const changedStatus = validateStageReadCursorChecked(validCursor(), { ...filters, stageStatus: 'failed' }, SCOPE, 'filter_mismatch');
    const changedBatch = validateStageReadCursorChecked(validCursor(), filters, { ...SCOPE, batchId: 'other' }, 'invalid_version');
    const changedWs = validateStageReadCursorChecked(validCursor(), filters, { ...SCOPE, workspaceId: 'other' }, 'invalid_version');
    expect([changedStage, changedStatus, changedBatch, changedWs]).toEqual([true, true, true, true]);
  });
});

function validateStageReadCursorChecked(cursor: string, filters: Omit<StageReadFilters, 'cursor' | 'limit'>, scope: typeof SCOPE, code: string): boolean {
  try {
    validateStageReadCursor(cursor, filters, scope);
    return false;
  } catch (err) {
    return (err as StageReadCursorError).code === code;
  }
}

describe('matrix helpers', () => {
  it('empty matrix sums to zero and has all 36 cells', () => {
    const matrix = emptyStageStatusMatrix();
    expect(sumStageStatusMatrix(matrix)).toBe(0);
    expect(Object.keys(matrix)).toHaveLength(6);
    for (const cells of Object.values(matrix)) {
      expect(Object.keys(cells)).toHaveLength(6);
    }
    expect(emptyWorkStateCounts()).toEqual({
      processing: 0,
      needs_attention: 0,
      waiting_on_family: 0,
      ready_for_review: 0,
      approved: 0,
      ready_to_export: 0,
      completed: 0,
      skipped: 0,
    });
  });
});
