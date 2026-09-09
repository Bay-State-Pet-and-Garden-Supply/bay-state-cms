/**
 * Unit tests for the protected-token extraction, normalization, and
 * verification logic used in expected name generation.
 *
 * Tests the deterministic guard that ensures size/weight/count tokens
 * from the raw register name survive LLM-based expected name generation.
 *
 * These tests use `bun:sqlite` (via the test runner's bun test command),
 * NOT vitest, because `consolidateProductName` depends on the DB to
 * resolve LLM configuration.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import {
  extractProtectedTokens,
  normalizeProtectedToken,
  verifyAndRestoreProtectedTokens,
  consolidateProductName,
} from '../../onboarding/llm-client';

const TEST_DB_PATH = 'src/tests/unit/name-consolidation-guard-test.db';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

/**
 * Stub `globalThis.fetch` to return a controlled LLM response.
 */
function stubFetch(responseBody: unknown) {
  const mock = (async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  globalThis.fetch = mock;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/**
 * Build an LLM API response body that returns the given text as the
 * assistant's content.
 */
function llmResponse(text: string) {
  return {
    choices: [{ message: { content: text } }],
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  initDb(TEST_DB_PATH);
  runMigrations();
  // Seed a fallback API key so getLlmConfig() finds one (for tests
  // that exercise the LLM path rather than the LCS fallback).
  upsertApiKey('deepseek', 'sk-test-key', null, 'deepseek-chat');
  upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'llama3');
});

/**
 * Local-only Ollama policy view: protected discovery_name_consolidation
 * routes to the mocked local transport (issue #17 pass 1b).
 */
function localOnlyPolicyView() {
  return buildModelPolicyView(
    {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5vl:latest',
      providerLocalities: { ollama: 'local' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    } as any,
    { snapshotHash: 'snap-guard-1' },
  );
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  try { closeDb(); } catch { /* ok */ }
  try {
    // Clean up the test DB file
    unlinkSync(TEST_DB_PATH);
    unlinkSync(TEST_DB_PATH + '-shm');
    unlinkSync(TEST_DB_PATH + '-wal');
  } catch { /* ok */ }
});

// ─── extractProtectedTokens ──────────────────────────────────────────────────

describe('extractProtectedTokens', () => {
  test('extracts weight with decimal (2.64OZ)', () => {
    const tokens = extractProtectedTokens('INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ');
    expect(tokens).toContain('2.64OZ');
  });

  test('extracts weight without decimal (6OZ)', () => {
    const tokens = extractProtectedTokens('WOOF BEEF LIVER 6OZ');
    expect(tokens).toContain('6OZ');
  });

  test('extracts weight with space (10.5 OZ)', () => {
    const tokens = extractProtectedTokens('HONEST KITCHEN CHICKEN 10.5 OZ');
    expect(tokens).toContain('10.5 OZ');
  });

  test('extracts pounds (5LB)', () => {
    const tokens = extractProtectedTokens('TASTE WILD SALMON 5LB');
    expect(tokens).toContain('5LB');
  });

  test('extracts count (3PK, 30PK)', () => {
    const tokens1 = extractProtectedTokens('WOOF PUPSICLE LAVENDER 3PK');
    expect(tokens1).toContain('3PK');
    const tokens2 = extractProtectedTokens('HONEST KITCHEN BEEF BONES 30PK');
    expect(tokens2).toContain('30PK');
  });

  test('extracts variant size abbreviations (SM, LG, XL)', () => {
    const tokens1 = extractProtectedTokens('WOOF PUPSICLE LAVENDER SM');
    expect(tokens1).toContain('SM');
    const tokens2 = extractProtectedTokens('WOOF PUPSICLE CHICKEN LG');
    expect(tokens2).toContain('LG');
    const tokens3 = extractProtectedTokens('WOOF BONES XL');
    expect(tokens3).toContain('XL');
  });

  test('extracts multiple tokens from same name', () => {
    const tokens = extractProtectedTokens('INSTINCT BEEF PATE CAN 5.5OZ 12PK');
    expect(tokens).toContain('5.5OZ');
    expect(tokens).toContain('12PK');
  });

  test('returns empty array when no protected tokens present', () => {
    const tokens = extractProtectedTokens('WOOF PUPSICLE LAVENDER');
    expect(tokens).toEqual([]);
  });

  test('handles empty string', () => {
    const tokens = extractProtectedTokens('');
    expect(tokens).toEqual([]);
  });

  test('extracts grams (100G)', () => {
    const tokens = extractProtectedTokens('YAK CHEESE 100G');
    expect(tokens).toContain('100G');
  });

  test('extracts milliliters (250ML)', () => {
    const tokens = extractProtectedTokens('HONEST OIL SALMON 250ML');
    expect(tokens).toContain('250ML');
  });
});

// ─── normalizeProtectedToken ─────────────────────────────────────────────────

describe('normalizeProtectedToken', () => {
  test('normalizes 2.64OZ → 2.64 oz', () => {
    expect(normalizeProtectedToken('2.64OZ')).toBe('2.64 oz');
  });

  test('normalizes 10.5OZ → 10.5 oz', () => {
    expect(normalizeProtectedToken('10.5OZ')).toBe('10.5 oz');
  });

  test('normalizes 5LB → 5 lb', () => {
    expect(normalizeProtectedToken('5LB')).toBe('5 lb');
  });

  test('normalizes 6OZ → 6 oz', () => {
    expect(normalizeProtectedToken('6OZ')).toBe('6 oz');
  });

  test('normalizes 3PK → 3-Pack', () => {
    expect(normalizeProtectedToken('3PK')).toBe('3-Pack');
  });

  test('normalizes 30PK → 30-Pack', () => {
    expect(normalizeProtectedToken('30PK')).toBe('30-Pack');
  });

  test('normalizes SM → Small', () => {
    expect(normalizeProtectedToken('SM')).toBe('Small');
  });

  test('normalizes LG → Large', () => {
    expect(normalizeProtectedToken('LG')).toBe('Large');
  });

  test('normalizes XL → X-Large', () => {
    expect(normalizeProtectedToken('XL')).toBe('X-Large');
  });

  test('normalizes 5CT → 5-Count per FORMAT_RULES', () => {
    expect(normalizeProtectedToken('5CT')).toBe('5-Count');
  });

  test('normalizes 16OZ → 16 oz', () => {
    expect(normalizeProtectedToken('16OZ')).toBe('16 oz');
  });

  test('normalizes 48OZ → 48 oz', () => {
    expect(normalizeProtectedToken('48OZ')).toBe('48 oz');
  });

  test('returns unknown token as-is', () => {
    expect(normalizeProtectedToken('CUSTOM')).toBe('CUSTOM');
  });

  test('normalizes OZS → oz', () => {
    expect(normalizeProtectedToken('10OZS')).toBe('10 oz');
  });

  test('normalizes OUNCE → oz', () => {
    expect(normalizeProtectedToken('1OUNCE')).toBe('1 oz');
  });

  test('normalizes GRAMS → g', () => {
    expect(normalizeProtectedToken('100GRAMS')).toBe('100 g');
  });
});

// ─── verifyAndRestoreProtectedTokens ─────────────────────────────────────────

describe('verifyAndRestoreProtectedTokens', () => {
  test('restores missing 2.64 oz token from raw name', () => {
    const expectedName = 'Instinct Cat Pâté Salmon Split Cup';
    const rawName = 'INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe('Instinct Cat Pâté Salmon Split Cup 2.64 oz');
  });

  test('does not append when token already present', () => {
    const expectedName = 'Instinct Cat Pâté Salmon Split Cup 2.64 oz';
    const rawName = 'INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe(expectedName);
  });

  test('restores multiple missing tokens', () => {
    const expectedName = 'Woof Beef Pate';
    const rawName = 'WOOF BEEF PATE 5.5OZ 12PK';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe('Woof Beef Pate 5.5 oz 12-Pack');
  });

  test('returns expected name unchanged when raw has no protected tokens', () => {
    const expectedName = 'Woof Lavender Pupsicle';
    const rawName = 'WOOF LAVENDER PUPSICLE';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe(expectedName);
  });

  test('does not double-append when expected name already has the number', () => {
    const expectedName = 'Woof Beef Pate 6 oz';
    const rawName = 'WOOF BEEF PATE 6OZ';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe('Woof Beef Pate 6 oz');
  });

  test('restores SM variant abbreviation', () => {
    const expectedName = 'Woof Pupsicle Lavender';
    const rawName = 'WOOF PUPSICLE LAVENDER SM';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe('Woof Pupsicle Lavender Small');
  });

  test('restores LG variant abbreviation', () => {
    const expectedName = 'Woof Pupsicle Lavender';
    const rawName = 'WOOF PUPSICLE LAVENDER LG';
    const result = verifyAndRestoreProtectedTokens(expectedName, rawName);
    expect(result).toBe('Woof Pupsicle Lavender Large');
  });

  test('returns expected name unchanged when raw name has no content', () => {
    const result = verifyAndRestoreProtectedTokens('Some Product', '');
    expect(result).toBe('Some Product');
  });
});

// ─── consolidateProductName (mocked LLM) ─────────────────────────────────────

describe('consolidateProductName with mocked LLM', () => {
  afterEach(() => {
    restoreFetch();
  });

  test('restores 2.64 oz when mocked LLM drops it from the expected name', async () => {
    stubFetch(llmResponse('Instinct Cat Pâté Salmon Split Cup'));

    const result = await consolidateProductName(
      '860001234567',
      [{ title: 'Instinct Original Pâté Salmon Cat Food', snippet: 'Salmon recipe' }],
      'INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ',
      'Instinct',
      localOnlyPolicyView(),
    );

    // LLM returned "Instinct Cat Pâté Salmon Split Cup" (no size).
    // The deterministic guard should restore "2.64 oz" at the end.
    expect(result).toBe('Instinct Cat Pâté Salmon Split Cup 2.64 oz');
  });

  test('preserves size when mocked LLM correctly includes it', async () => {
    stubFetch(llmResponse('Instinct Cat Pâté Salmon Split Cup 2.64 oz'));

    const result = await consolidateProductName(
      '860001234567',
      [{ title: 'Instinct Original Pâté Salmon Cat Food 2.64 oz', snippet: 'Salmon recipe' }],
      'INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ',
      'Instinct',
      localOnlyPolicyView(),
    );

    expect(result).toBe('Instinct Cat Pâté Salmon Split Cup 2.64 oz');
  });

  test('preserves count token (3PK) through mocked LLM', async () => {
    stubFetch(llmResponse('Woof Lavender Pupsicle'));

    const result = await consolidateProductName(
      '860009876543',
      [{ title: 'Woof Lavender Pupsicle - 3 Pack', snippet: 'Dental chew' }],
      'WOOF LAVENDER PUPSICLE 3PK',
      'Woof',
      localOnlyPolicyView(),
    );

    expect(result).toBe('Woof Lavender Pupsicle 3-Pack');
  });

  test('preserves SM variant abbreviation through mocked LLM', async () => {
    stubFetch(llmResponse('Woof Pupsicle Lavender'));

    const result = await consolidateProductName(
      '860005555555',
      [{ title: 'Woof Pupsicle Lavender Small', snippet: 'Dental chew' }],
      'WOOF PUPSICLE LAVENDER SM',
      'Woof',
      localOnlyPolicyView(),
    );

    expect(result).toBe('Woof Pupsicle Lavender Small');
  });

  test('preserves multiple tokens (10.5OZ + 12PK) through mocked LLM', async () => {
    stubFetch(llmResponse('Instinct Beef Pate Can'));

    const result = await consolidateProductName(
      '860001111111',
      [{ title: 'Instinct Beef Pate Can', snippet: 'Beef recipe' }],
      'INSTINCT BEEF PATE CAN 10.5OZ 12PK',
      'Instinct',
      localOnlyPolicyView(),
    );

    const lower = result!.toLowerCase();
    expect(lower).toContain('10.5');
    expect(lower).toContain('12-pack');
  });

  test('returns null when no results and no original name', async () => {
    const result = await consolidateProductName('860000000000', [], undefined, undefined);
    expect(result).toBeNull();
  });

  test('falls back to LCS with token guard when LLM returns empty', async () => {
    // Mock LLM to return empty content (triggers error → LCS fallback)
    stubFetch({ choices: [{ message: { content: '' } }] });

    const result = await consolidateProductName(
      '860001234567',
      // Search result that shares enough common text with the raw name
      // for the LCS to find a valid consensus (>=10 chars)
      [{ title: 'Instinct Original Wet Cat Food 3 oz', snippet: 'Cat food' }],
      'INSTINCT WET CAT FOOD 3OZ',
      'Instinct',
      localOnlyPolicyView(),
    );

    // LLM returned empty, so it falls to LCS. The LCS guard should still
    // protect the "3OZ" token from being dropped.
    expect(result).not.toBeNull();
    // The LCS consensus should include the size/count from the raw name
    const lower = result!.toLowerCase();
    expect(lower).toContain('3');
    expect(lower).toContain('cat');
    expect(lower).toContain('food');
  });
});
