/**
 * Unit tests for the deterministic size/capacity guarantee in
 * `consolidateProductTitle` (issue #111).
 *
 * Runs under `bun test` (NOT vitest) because the consolidator resolves LLM
 * configuration through the DB-backed llm-client. Uses the explicit disabled
 * policy (null) for deterministic no-LLM paths, immune to ambient API keys
 * when suites share a process/DB singleton.
 *
 * NOTE: keep isolated from name-consolidation-stage.test.ts — that file
 * vi.mock()s title-consolidation and bun shares the module registry per
 * process, so co-running would poison these real-path tests (same rule as
 * brand-title-guarantee.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { consolidateProductTitle, applyVariantGuarantee } from '../../onboarding/title-consolidation';

const TEST_DB_PATH = 'src/tests/unit/size-title-guarantee-test.db';

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  initDb(TEST_DB_PATH);
  runMigrations();
});

afterAll(() => {
  try { closeDb(); } catch { /* ok */ }
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(TEST_DB_PATH + '-shm');
    unlinkSync(TEST_DB_PATH + '-wal');
  } catch { /* ok */ }
});

describe('consolidateProductTitle size guarantee (issue #111)', () => {
  test('distributor size below a sizeless H1 reaches the title as final tokens (AC1/AC3)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'E-Z HANG SCALE',
        brandHint: 'Salter',
        distributorTitles: [{ title: 'E-Z Hang Scale Silver', providerId: 'bradley', attemptId: 'a1', confidence: 0.9 }],
        distributorBrands: [{ brand: 'Salter', providerId: 'bradley', attemptId: 'a1', confidence: 0.9 }],
        distributorVariants: [{ field: 'size', value: 'Up to 55 LB', providerId: 'bradley', attemptId: '', confidence: 1.0 }],
      },
      null,
    );
    expect(result.title).toBe('Salter E-Z HANG SCALE 55 lb');
    expect(result.sizeApplied).toEqual(['55 lb']);
    expect(result.sizeUnverified).toBeUndefined();
  });

  test('spreadsheet raw-name size tokens survive consolidation (AC2)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'DOG FOOD',
        rawRegisterName: 'DOG FOOD 5LB',
        brandHint: 'Acme',
        webTitle: 'Premium Dog Food',
      },
      null,
    );
    // No-LLM fallback returns the spreadsheet name; the variant guarantee
    // restores the raw-register token the cleaned name dropped.
    expect(result.title).toBe('Acme DOG FOOD 5 lb');
    expect(result.sizeApplied).toEqual(['5 lb']);
  });

  test('capacity is a first-class axis, not folded into size text (AC4)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'BUCKET',
        brandHint: 'Acme',
        distributorVariants: [{ field: 'capacity', value: '5 GAL', providerId: 'bradley', attemptId: '', confidence: 1.0 }],
      },
      null,
    );
    expect(result.title).toBe('Acme BUCKET 5 gal');
    expect(result.sizeApplied).toEqual(['5 gal']);
  });

  test('OCR measurements join the merged set', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'KIBBLE',
        brandHint: 'Acme',
        ocrTitle: 'Premium Kibble',
        ocrWeight: '16 oz',
      },
      null,
    );
    expect(result.title).toBe('Acme Premium Kibble 16 oz');
    expect(result.sizeApplied).toEqual(['16 oz']);
  });

  test('missing size everywhere marks the result unverified without inventing (AC5)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'Mystery Product',
        brandHint: 'Acme',
        webTitle: 'Mystery Product Deluxe',
      },
      null,
    );
    expect(result.title).toBe('Acme Mystery Product');
    expect(result.sizeApplied).toEqual([]);
    expect(result.sizeUnverified).toBe(true);
  });

  test('variant wrapper pins the same guarantee for live-LLM returns', () => {
    // A run-bound LLM call cannot be fabricated outside the audited pipeline,
    // so the exact wrapper both LLM returns share is pinned directly:
    // dropped tokens restored as final tokens, provenance preserved, and
    // unverified marking when nothing is evidenced.
    const guarded = applyVariantGuarantee(
      { title: 'Premium Dog Food', source: 'llm', modelCallIds: ['mock-call-1'] },
      ['DOG FOOD 5LB', 'Premium Dog Food'],
    );
    expect(guarded.title).toBe('Premium Dog Food 5 lb');
    expect(guarded.source).toBe('llm');
    expect(guarded.modelCallIds).toEqual(['mock-call-1']);
    expect(guarded.sizeApplied).toEqual(['5 lb']);

    const unverified = applyVariantGuarantee({ title: 'Mystery Product', source: 'llm' }, ['Mystery Product']);
    expect(unverified.title).toBe('Mystery Product');
    expect(unverified.sizeApplied).toEqual([]);
    expect(unverified.sizeUnverified).toBe(true);
  });
});
