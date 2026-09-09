/**
 * Unit tests for the deterministic color guarantee in
 * `consolidateProductTitle` (issue #112).
 *
 * Runs under `bun test` (NOT vitest) because the consolidator resolves LLM
 * configuration through the DB-backed llm-client. Uses the explicit disabled
 * policy (null) for deterministic no-LLM paths, immune to ambient API keys
 * when suites share a process/DB singleton.
 *
 * NOTE: keep isolated from name-consolidation-stage.test.ts — that file
 * vi.mock()s title-consolidation and bun shares the module registry per
 * process, so co-running would poison these real-path tests (same rule as
 * brand-title-guarantee.test.ts and size-title-guarantee.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { consolidateProductTitle, applyColorGuarantee } from '../../onboarding/title-consolidation';

const TEST_DB_PATH = 'src/tests/unit/color-consolidation-test.db';

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

describe('consolidateProductTitle color guarantee (issue #112)', () => {
  test('distributor color below a colorless H1 reaches a multi-color title (AC1)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'WIDGET',
        brandHint: 'Acme',
        distributorTitles: [{ title: 'Widget', providerId: 'bradley', attemptId: 'a1', confidence: 0.9 }],
        distributorVariants: [{ field: 'color', value: 'Red', providerId: 'bradley', attemptId: '', confidence: 1.0 }],
        siblingContext: { groupLabel: 'Widgets', siblingNames: ['Widget Blue'], siblingWebTitles: [], siblingOcrTitles: [], siblingSkus: [] },
      },
      null,
    );
    expect(result.title).toBe('Acme WIDGET Red');
    expect(result.colorApplied).toBe('Red');
  });

  test('single structured color leaves the title untouched (AC2)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'WIDGET',
        brandHint: 'Acme',
        distributorVariants: [{ field: 'color', value: 'Red', providerId: 'bradley', attemptId: '', confidence: 1.0 }],
      },
      null,
    );
    expect(result.title).toBe('Acme WIDGET');
    expect(result.colorApplied).toBeNull();
  });

  test('OCR color joins a multi-color family', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'WIDGET',
        brandHint: 'Acme',
        ocrColor: 'Red',
        siblingContext: { groupLabel: 'Widgets', siblingNames: ['Widget Blue'], siblingWebTitles: [], siblingOcrTitles: [], siblingSkus: [] },
      },
      null,
    );
    expect(result.title).toBe('Acme WIDGET Red');
    expect(result.colorApplied).toBe('Red');
  });

  test('present color is never doubled', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'RED WIDGET',
        brandHint: 'Acme',
        distributorVariants: [{ field: 'color', value: 'Red', providerId: 'bradley', attemptId: '', confidence: 1.0 }],
        siblingContext: { groupLabel: 'Widgets', siblingNames: ['Widget Blue'], siblingWebTitles: [], siblingOcrTitles: [], siblingSkus: [] },
      },
      null,
    );
    expect((result.title.match(/red/gi) ?? []).length).toBe(1);
    expect(result.colorApplied).toBe('Red');
  });

  test('unknown color leaves the title unchanged without holding (AC2 absence rule)', async () => {
    const result = await consolidateProductTitle(
      {
        name: 'WIDGET',
        brandHint: 'Acme',
        siblingContext: { groupLabel: 'Widgets', siblingNames: ['Widget Blue'], siblingWebTitles: [], siblingOcrTitles: [], siblingSkus: [] },
      },
      null,
    );
    // Own color is unknown (no structured color, no color in own texts) —
    // untouched. (The sibling Blue word is not ours to claim.)
    expect(result.title).toBe('Acme WIDGET');
    expect(result.colorApplied).toBeNull();
  });

  test('applyColorGuarantee pins the shared live-LLM wrapper (AC3 survival)', async () => {
    // The live-LLM returns share this exact wrapper; a run-bound LLM call
    // cannot be fabricated outside the audited pipeline, so the wrapper is
    // pinned directly (same rationale as applyBrandGuarantee/applyVariantGuarantee).
    const guarded = applyColorGuarantee(
      { title: 'Acme Widget', source: 'llm', modelCallIds: ['mock-call-1'] },
      'Red',
      ['Red', 'Blue'],
    );
    expect(guarded.title).toBe('Acme Widget Red');
    expect(guarded.colorApplied).toBe('Red');
    expect(guarded.modelCallIds).toEqual(['mock-call-1']);

    const single = applyColorGuarantee({ title: 'Acme Widget', source: 'llm' }, 'Red', ['Red']);
    expect(single.title).toBe('Acme Widget');
    expect(single.colorApplied).toBeNull();

    const unknown = applyColorGuarantee({ title: 'Acme Widget', source: 'llm' }, null, ['Red', 'Blue']);
    expect(unknown.title).toBe('Acme Widget');
    expect(unknown.colorApplied).toBeNull();
  });
});
