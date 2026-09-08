/**
 * Packaging-OCR eval harness end-to-end (packaging-OCR overhaul P3-T1).
 *
 * Runs `evaluateCandidatesAgainstGolden` against MOCK transports only (the
 * constraint: the harness must never make network calls beyond the
 * configured local baseUrls; tests inject fetchFn mocks entirely).
 * DB-backed (bun:test) because src/onboarding/packaging-ocr.ts transitively
 * imports bun:sqlite repositories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  resetCircuitBreakers,
} from '../../onboarding/vlm-circuit-breaker';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';
import { evaluateCandidatesAgainstGolden } from '../../onboarding/ocr-eval/runner';
import { loadGoldenDatasetFromJson, type LoadedGoldenDataset } from '../../onboarding/ocr-eval/golden-dataset';
import type { NetworkFetch } from '../../onboarding/vlm-client';

const BASELINE_MODEL = 'qwen2.5vl:latest';const CANDIDATE_MODEL = 'qwen3-vl:8b-test';
const GOOD_JSON =
  '{"productName":"Wormeze Liquid","brand":"Acme","species":["dog"],"upc":"036000291452"}';
const PROSE = 'This package appears to contain dog treats and nothing structured.';

/** Capturing ollama-native transport mock. */
function makeTransport(responder: (call: number, url: string, body: Record<string, unknown>) => string) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    return new Response(JSON.stringify({ message: { content: responder(calls.length, url, body) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as NetworkFetch;
  return { fn, calls };
}

function inlineRef(): string {
  // ≥1KiB payload so the local-image loader's minimum-size rule passes.
  return `inline:${Buffer.alloc(2048, 0x61).toString('base64')}`;
}

function datasetJson(entries: Array<{ id: string; upc: string | null }>): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: 'harness-test-v1',
    entries: entries.map(e => ({
      id: e.id,
      imageRef: inlineRef(),
      expected: {
        productName: 'Wormeze Liquid',
        brand: 'Acme',
        species: ['dog'],
        upc: e.upc,
        flavorVariety: null,
        color: null,
        material: null,
        size: null,
        weight: null,
        count: null,
        lifeStage: null,
        breedSize: null,
        productForm: null,
        healthConcernFunction: [],
        dietaryLabels: [],
        ingredients: [],
        ingredientKeywords: [],
        claims: [],
        visibleTextLines: [],
      },
    })),
  });
}

beforeEach(() => {
  // Inline image refs never touch disk; the runner stages its own temp dir.
  initDb(':memory:');
  runMigrations();
  resetCircuitBreakers();
});

afterEach(() => {
  closeDb();
  resetCircuitBreakers();
  resetOcrStageFlagsOverride();
});

describe('evaluateCandidatesAgainstGolden', () => {
  it('routes each candidate through its own baseUrl/model via vlmConfigOverride', async () => {
    const transport = makeTransport(() => GOOD_JSON);
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }, { id: 'b', upc: null }]);
    const result = await evaluateCandidatesAgainstGolden(raw, {
      candidates: [
        { baseUrl: 'http://127.0.0.1:11434', model: BASELINE_MODEL },
        { baseUrl: 'http://127.0.0.1:11500', model: CANDIDATE_MODEL },
      ],
      baselineModel: BASELINE_MODEL,
      fetchFn: transport.fn,
    });
    // 2 candidates × 2 items = 4 transport calls total.
    expect(transport.calls).toHaveLength(4);
    const urls = transport.calls.map(c => c.url);
    expect(urls.filter(u => String(u).startsWith('http://127.0.0.1:11434/api/chat'))).toHaveLength(2);
    expect(urls.filter(u => String(u).startsWith('http://127.0.0.1:11500/api/chat'))).toHaveLength(2);
    expect(result.reports.map(r => r.candidateModel)).toEqual([BASELINE_MODEL, CANDIDATE_MODEL]);
    expect(result.datasetDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sends greedy decoding (temperature 0) on OCR attempt bodies by default', async () => {
    const transport = makeTransport(() => GOOD_JSON);
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }]);
    await evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
      candidates: [{ baseUrl: 'http://127.0.0.1:11434', model: BASELINE_MODEL }],
      baselineModel: BASELINE_MODEL,
      fetchFn: transport.fn,
    });
    expect(transport.calls[0]!.body.options).toEqual({ temperature: 0 });
  });

  it('computes parse-success deltas and coded failure reasons for a failing candidate', async () => {
    const transport = makeTransport((call, url) => {
      if (String(url).includes(':11500')) {
        return PROSE; // unparseable prose → unparseable_json
      }
      return GOOD_JSON;
    });
    const raw = datasetJson([
      { id: 'a', upc: '036000291452' },
      { id: 'b', upc: '036000291453' },
    ]);
    const result = await evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
      candidates: [
        { baseUrl: 'http://127.0.0.1:11434', model: BASELINE_MODEL },
        { baseUrl: 'http://127.0.0.1:11500', model: CANDIDATE_MODEL },
      ],
      baselineModel: BASELINE_MODEL,
      fetchFn: transport.fn,
    });
    const baseline = result.reports.find(r => r.candidateModel === BASELINE_MODEL)!;
    const candidate = result.reports.find(r => r.candidateModel === CANDIDATE_MODEL)!;
    expect(baseline.parseSuccessRate).toBe(1);
    expect(candidate.parseSuccessRate).toBe(0);
    expect(candidate.failureReasonCounts['unparseable_json']).toBe(2);
    expect(candidate.vsBaseline.hasBaseline).toBe(true);
    expect(candidate.vsBaseline.parseSuccessRateDelta).toBe(-1);
    expect(baseline.vsBaseline.hasBaseline).toBe(false);
  });

  it('rejects non-loopback candidate baseUrls BEFORE staging any image or calling the transport', async () => {
    const transport = makeTransport(() => GOOD_JSON);
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }]);
    await expect(
      evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
        candidates: [
          { baseUrl: 'http://127.0.0.1:11434', model: BASELINE_MODEL },
          { baseUrl: 'http://evil.example.com:11434', model: CANDIDATE_MODEL },
        ],
        fetchFn: transport.fn,
      }),
    ).rejects.toThrow(/non-loopback/);
    // Zero transports AND zero image staging side effects for a misconfigured run.
    expect(transport.calls).toHaveLength(0);
  });

  it('FIX-E round 2: rejection message never carries userinfo or query payload', async () => {
    const transport = makeTransport(() => GOOD_JSON);
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }]);
    const secretUrl = 'http://user:topsecret@evil.example.com:11434/path?token=abc123';
    let message = '';
    try {
      await evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
        candidates: [{ baseUrl: secretUrl, model: CANDIDATE_MODEL }],
        fetchFn: transport.fn,
      });
      throw new Error('expected a non-loopback rejection');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/non-loopback/);
    }
    // Bounded redaction: scheme://host[:port] only.
    expect(message).toContain('http://evil.example.com:11434');
    expect(message).not.toContain('user:topsecret');
    expect(message).not.toContain('token=abc123');
    expect(message).not.toContain('/path');
    // And no transport ever ran.
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects duplicate candidate labels before any model call', async () => {
    const transport = makeTransport(() => GOOD_JSON);
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }]);
    await expect(
      evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
        candidates: [
          { baseUrl: 'http://127.0.0.1:11434', model: CANDIDATE_MODEL },
          { baseUrl: 'http://127.0.0.1:11500', model: CANDIDATE_MODEL },
        ],
        fetchFn: transport.fn,
      }),
    ).rejects.toThrow(/unique labels/);
    // No model call may happen for a misconfigured candidate list.
    expect(transport.calls).toHaveLength(0);
  });

  it('fails closed when a golden image cannot be resolved (no datasetDir for file refs)', async () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: 'file-ref',
      entries: [{
        id: 'x',
        imageRef: 'images/missing.jpg',
        expected: { productName: null, brand: null, species: [], upc: null, flavorVariety: null, color: null, material: null, size: null, weight: null, count: null, lifeStage: null, breedSize: null, productForm: null, healthConcernFunction: [], dietaryLabels: [], ingredients: [], ingredientKeywords: [], claims: [], visibleTextLines: [] },
      }],
    });
    const loaded: LoadedGoldenDataset = loadGoldenDatasetFromJson(raw);
    await expect(
      evaluateCandidatesAgainstGolden(loaded, {
        candidates: [{ baseUrl: 'http://127.0.0.1:11434', model: BASELINE_MODEL }],
        fetchFn: makeTransport(() => GOOD_JSON).fn,
      }),
    ).rejects.toThrow(/Cannot resolve image for golden entry "x"/);
  });

  it('repetition-tail mitigation: retries once with frequency_penalty when retries are enabled', async () => {
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    const repetitive = ('The package shows dog treats dog treats dog treats dog treats dog treats dog treats ' +
      'dog treats dog treats dog treats dog treats dog treats dog treats').trim();
    const transport = makeTransport(call => (call === 1 ? repetitive : GOOD_JSON));
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }]);
    const result = await evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
      candidates: [{ baseUrl: 'http://127.0.0.1:11434', model: CANDIDATE_MODEL }],
      fetchFn: transport.fn,
    });
    // First call returned the repetitive tail → exactly ONE retry carrying the penalty.
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]!.body.options).toEqual({ temperature: 0, frequency_penalty: 0.3 });
    const report = result.reports[0]!;
    expect(report.parseSuccessRate).toBe(1); // retried response parsed fine
  });

  it('does NOT retry repetitive responses when the retry flag is off', async () => {
    const repetitive = ('The package shows cat toys cat toys cat toys cat toys cat toys cat toys ' +
      'cat toys cat toys cat toys cat toys cat toys cat toys').trim();
    const transport = makeTransport(() => repetitive);
    const raw = datasetJson([{ id: 'a', upc: '036000291452' }]);
    const result = await evaluateCandidatesAgainstGolden(loadGoldenDatasetFromJson(raw), {
      candidates: [{ baseUrl: 'http://127.0.0.1:11434', model: CANDIDATE_MODEL }],
      fetchFn: transport.fn,
    });
    expect(transport.calls).toHaveLength(1);
    expect(result.reports[0]!.parseSuccessRate).toBe(0);
  });

  it('loads packaging-ocr-baystate-golden.json and validates all entries and fields', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const goldenPath = path.resolve(__dirname, '../../onboarding/ocr-eval/datasets/packaging-ocr-baystate-golden.json');
    const raw = await fs.readFile(goldenPath, 'utf8');
    const dataset = loadGoldenDatasetFromJson(raw);
    expect(dataset.name).toBe('packaging-ocr-baystate-golden');
    expect(dataset.entries.length).toBeGreaterThanOrEqual(8);
    expect(dataset.digest).toBeDefined();

    // Verify presence of representative departments
    const hasDog = dataset.entries.some(e => e.expected.species?.includes('dog'));
    const hasCat = dataset.entries.some(e => e.expected.species?.includes('cat'));
    const hasHorse = dataset.entries.some(e => e.expected.species?.includes('horse'));
    const hasPoultry = dataset.entries.some(e => e.expected.species?.includes('poultry'));
    const hasBird = dataset.entries.some(e => e.expected.species?.includes('bird'));
    const hasLawn = dataset.entries.some(e => e.expected.npkRatio === '29-0-3');
    const hasPackagingType = dataset.entries.some(e => e.expected.packagingType === 'Bag');

    expect(hasDog).toBe(true);
    expect(hasCat).toBe(true);
    expect(hasHorse).toBe(true);
    expect(hasPoultry).toBe(true);
    expect(hasBird).toBe(true);
    expect(hasLawn).toBe(true);
    expect(hasPackagingType).toBe(true);
  });
});
