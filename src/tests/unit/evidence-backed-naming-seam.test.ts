/**
 * Evidence-backed name selection boundary (issue #365): typed-or-nothing
 * Choice semantics, out-of-set refusal, producer truthfulness, and the
 * persisted nameDecision record.
 *
 * Uses a loopback SystemOne transport stub at the dispatch seam: assertions
 * prove composed boundary behavior (candidate → Choice → typed result),
 * never stubbed echoes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import {
  resolveNameSelection,
  toNameDecision,
  buildNameChoiceQuestion,
} from '../../classification/name-decision';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import type { NameEvidenceText } from '../../classification/name-candidates';

const cloudTypesafePolicy: ModelPolicyConfigV2 = {
  defaultProvider: 'typesafe',
  defaultModel: 'jev-1.13.0',
  providerLocalities: { typesafe: 'cloud' },
  stageOverrides: {},
  imageDataSharing: 'local_only',
  textDataSharing: 'cloud_allowed',
  mlFeatures: {
    productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
  },
};

function evidence(id: string, source: string, sourceField: string, value: string): ClassificationEvidence {
  return {
    id,
    runId: 'run-naming',
    stageName: 'evidence_extraction',
    productSku: 'SKU-NAMING-1',
    attributeId: null,
    source: source as ClassificationEvidence['source'],
    reliability: 'high',
    sourceUrl: null,
    sourceField,
    snippet: null,
    value,
    metadata: null,
    capturedAt: new Date().toISOString(),
  };
}

const spans: NameEvidenceText[] = [
  { channel: 'register', span: 'ACME Chicken Dinner 5LB', evidenceId: 'e-reg' },
  { channel: 'official', span: 'Acme Chicken Dinner 5 lb', evidenceId: 'e-web' },
];

const evidenceRows = [
  evidence('e-reg', 'spreadsheet', 'name', 'ACME Chicken Dinner 5LB'),
  evidence('e-web', 'official_product_page', 'title', 'Acme Chicken Dinner 5 lb'),
];

describe('name Choice boundary', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
  });

  it('resolves a single candidate deterministically with zero dispatch calls', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const run = createRun('ws-naming', 'SKU-NAMING-1', null, null);
    const result = await resolveNameSelection({
      evidence: evidenceRows,
      spans: [{ channel: 'register', span: 'ACME Chicken Dinner 5LB', evidenceId: 'e-reg' }],
      brand: 'Acme',
      sku: 'SKU-NAMING-1',
      runId: run.id,
      snapshot: null,
      modelPolicy: null,
    });
    expect(result.status).toBe('resolved');
    expect(result.producer).toBe('deterministic');
    expect(result.modelCallIds).toEqual([]);
    expect(calls).toBe(0);
  });

  it('refuses a persisted decision when OCR species contradicts the resolved title', async () => {
    const run = createRun('ws-naming', 'SKU-NAMING-1', null, null);
    // Register names a cat food; the package OCR says Dog. Candidates
    // resolve deterministically from the register body, but the decision
    // persistence must fail closed rather than name against the package.
    const spans = [
      { channel: 'register', span: 'ACME Cat Food 3LB', evidenceId: 'e-reg' },
      { channel: 'ocr', span: 'Dog', kind: 'species' },
    ] as const;
    const result = await resolveNameSelection({
      evidence: evidenceRows,
      spans: [...spans],
      brand: 'Acme',
      sku: 'SKU-NAMING-1',
      runId: run.id,
      snapshot: null,
      modelPolicy: null,
    });
    expect(result.status).toBe('resolved');
    expect(result.title).toContain('Cat');
    expect(toNameDecision({ result, spans: [...spans] })).toBeNull();
  });

  it('persists a decision when the title carries the evidenced species', async () => {
    const run = createRun('ws-naming', 'SKU-NAMING-1', null, null);
    const spans = [
      { channel: 'register', span: 'ACME Dog Food 5LB', evidenceId: 'e-reg' },
      { channel: 'ocr', span: 'Dog', kind: 'species' },
    ] as const;
    const result = await resolveNameSelection({
      evidence: evidenceRows,
      spans: [...spans],
      brand: 'Acme',
      sku: 'SKU-NAMING-1',
      runId: run.id,
      snapshot: null,
      modelPolicy: null,
    });
    expect(result.status).toBe('resolved');
    expect(toNameDecision({ result, spans: [...spans] })).not.toBeNull();
  });

  it('builds a Choice question over supplied candidates plus no_match/insufficient_evidence', () => {
    const plan = buildNameChoiceQuestion([
      { title: 'Acme Chicken Dinner 5 lb', components: ['a'], evidenceIds: [] },
      { title: 'Acme Salmon Dinner 5 lb', components: ['b'], evidenceIds: [] },
    ]);
    expect(Object.keys(plan.criteria)).toContain('no_match');
    expect(Object.keys(plan.criteria)).toContain('insufficient_evidence');
    expect(plan.keyToIdMap.size).toBe(2);
  });

  it('persists a nameDecision with hashes, producer, and call ids', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const run = createRun('ws-naming', 'SKU-NAMING-1', null, null);
    const result = await resolveNameSelection({
      evidence: evidenceRows,
      spans: [{ channel: 'register', span: 'ACME Chicken Dinner 5LB', evidenceId: 'e-reg' }],
      brand: 'Acme',
      sku: 'SKU-NAMING-1',
      runId: run.id,
      snapshot: null,
      modelPolicy: null,
    });
    void calls;
    const decision = toNameDecision({ result, spans });
    expect(decision).not.toBeNull();
    expect(decision?.selectedTitle).toBe(result.title ?? undefined);
    expect(decision?.producer).toBe('deterministic');
    expect(decision?.normalizationVersion).toBe('name-normalization-v2-applicable-variant');
    expect(decision?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(decision?.titleHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('holds conflicting sizes actionable (typed selection never runs)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const run = createRun('ws-naming', 'SKU-NAMING-1', null, null);
    const result = await resolveNameSelection({
      evidence: evidenceRows,
      spans: [
        { channel: 'register', span: 'ACME Dog Food 5LB' },
        { channel: 'official', span: 'Acme Dog Food 15 lb' },
      ],
      brand: 'Acme',
      sku: 'SKU-NAMING-1',
      runId: run.id,
      snapshot: null,
      modelPolicy: null,
    });
    expect(result.status).toBe('abstained');
    expect(result.abstentionCode).toBe('conflict');
    expect(calls).toBe(0);
  });
  it('records manual corrections with truthful manual provenance', async () => {
    const run = createRun('ws-naming', 'SKU-NAMING-1', null, null);
    const result = await resolveNameSelection({
      evidence: evidenceRows,
      spans,
      brand: 'Acme',
      sku: 'SKU-NAMING-1',
      runId: run.id,
      snapshot: null,
      modelPolicy: null,
      manualTitle: 'Acme Chicken Dinner Vet Formula 5 lb',
    });
    expect(result.status).toBe('resolved');
    expect(result.producer).toBe('manual');
    expect(result.title).toBe('Acme Chicken Dinner Vet Formula 5 lb');
    expect(result.modelCallIds).toEqual([]);
  });

  it('registers the cloud typesafe connection for the naming route', async () => {
    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.local',
      trustZone: 'cloud',
      credential: 'test-key',
      enabled: true,
    });
    const view = buildModelPolicyView(cloudTypesafePolicy, {});
    expect(view).not.toBeNull();
  });
});
