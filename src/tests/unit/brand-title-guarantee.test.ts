/**
 * Unit tests for the deterministic brand guarantee in `consolidateProductTitle`
 * (issue #108).
 *
 * Runs under `bun test` (NOT vitest) because the consolidator resolves LLM
 * configuration through the DB-backed llm-client.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { consolidateProductTitle, applyBrandGuarantee } from '../../onboarding/title-consolidation';

const TEST_DB_PATH = 'src/tests/unit/brand-title-guarantee-test.db';

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

describe('consolidateProductTitle brand guarantee (issue #108)', () => {
  test('no-LLM OCR path prefixes a missing brand (manufacturer-copy fixture)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'DOG FOOD 5LB',
        brandHint: 'Acme',
        webTitle: 'Premium Dog Food',
        ocrTitle: 'Premium Dog Food 5 lb',
      },
      // Explicit disabled policy: deterministic no-LLM fallback, immune to
      // ambient API keys when suites share a process/DB singleton.
      null,
    );
    expect(result.title).toBe('Acme Premium Dog Food 5 lb');
    expect(result.source).toBe('ocr');
    expect(result.brandApplied).toBe('Acme');
    expect(result.brandUnverified).toBeUndefined();
  });

  test('no-LLM manual path prefixes a missing brand', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'SCALE',
        brandHint: 'Salter',
        manualTitle: 'E-Z Hang Scale Silver Up to 55 LB',
      },
      null,
    );
    expect(result.title).toBe('Salter E-Z Hang Scale Silver Up to 55 LB');
    expect(result.source).toBe('manual');
    expect(result.brandApplied).toBe('Salter');
  });

  test('no-LLM name path normalizes casing without doubling', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'ACME Premium Dog Food',
        brandHint: 'Acme',
      },
      null,
    );
    expect(result.title).toBe('Acme Premium Dog Food');
    expect(result.source).toBe('web');
    expect(result.brandApplied).toBe('Acme');
  });

  test('distributor brandHint is guaranteed when spreadsheet/official brands are absent', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'E-Z HANG SCALE',
      brandHint: 'Salter',
      distributorTitles: [{ title: 'E-Z Hang Scale Silver', providerId: 'bradley', attemptId: 'a1', confidence: 0.9 }],
      distributorBrands: [{ brand: 'Salter', providerId: 'bradley', attemptId: 'a1', confidence: 0.9 }],
      },
      null,
    );
    expect(result.title).toBe('Salter E-Z HANG SCALE');
    expect(result.brandApplied).toBe('Salter');
  });

  test('missing brand everywhere marks the result unverified without inventing', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'Mystery Product',
        webTitle: 'Mystery Product Deluxe',
      },
      null,
    );
    // No-LLM fallback returns the spreadsheet name unchanged (never the web
    // title) with the unverified marker — the stage holds for manual title.
    expect(result.title).toBe('Mystery Product');
    expect(result.brandUnverified).toBe(true);
    expect(result.brandApplied).toBeUndefined();
  });

  test('LLM-branch wrapper pins the same guarantee (live LLM unfabricable)', () => {
    // A run-bound LLM call cannot be fabricated outside the audited pipeline
    // (fail-closed plan compatibility), so the exact wrapper both LLM
    // returns share is pinned directly: brandless in, guaranteed out, model
    // provenance preserved, and unverified marking without a brand.
    const guarded = applyBrandGuarantee(
      { title: 'Premium Dog Food 5 lb', source: 'llm', modelCallIds: ['mock-call-1'] },
      'Acme',
    );
    expect(guarded.title).toBe('Acme Premium Dog Food 5 lb');
    expect(guarded.source).toBe('llm');
    expect(guarded.modelCallIds).toEqual(['mock-call-1']);
    expect(guarded.brandApplied).toBe('Acme');

    const unverified = applyBrandGuarantee({ title: 'Premium Dog Food 5 lb', source: 'llm' }, null);
    expect(unverified.title).toBe('Premium Dog Food 5 lb');
    expect(unverified.brandUnverified).toBe(true);
  });
});
