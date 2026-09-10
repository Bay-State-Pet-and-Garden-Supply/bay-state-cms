// ---------------------------------------------------------------------------
// AI ProductField proposal validation (epic #42, #39)
//
// Coverage:
//  - pure validator: kind classification, staging safety, unsafe payloads,
//    envelope parse (all-or-nothing structural), per-candidate business
//    rejections (safe-skip diagnostics);
//  - generateAiProposals integration with a mocked model response: strict
//    validation before mutation, server-derived affected SKUs, transactional
//    replace, prior-proposals-preserved on structural failure, rollback,
//    field scope errors, exact observed-value membership, redacted
//    diagnostics.
//
// Runs under `bun test` (bun:sqlite DB harness; bun's mock.module replaces
// the llm-client so no network/model call ever happens).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync, rmSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { writeProductFile, createWorkspaceDirs } from '../../git/workspace-files';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import {
  generateAiProposals,
  AiProposalValidationError,
  ProposalFieldScopeError,
} from '../../server/services/store-manager-assistant-service';
import {
  validateAiProposalResponse,
  classifyNormalizationKind,
  safeToStageForKind,
  hasUnsafePayload,
  levenshteinDistance,
  stripCodeFence,
} from '../../server/services/ai-proposal-validator';
import {
  replaceAiProposalsForField,
  listProposals,
  findProposalById,
} from '../../db/repositories/catalog-health-proposal-repo';
import { isBulkReviewEligible } from '../../server/services/store-manager-bulk-review-service';
import { CatalogProposalSchema } from '../../shared/schemas/catalog-health-proposal';
import type { Product } from '../../shared/types';

// ─── Model fake: DI'd callLlm (no process-wide mocks; other test files in
// the shared bun process must keep their real llm-client). ───────────────
let aiResponse: string | null = null;
let llmCallCount = 0;
const fakeCallLlm = async (): Promise<string | null> => {
  llmCallCount += 1;
  return aiResponse;
};

// ─── Pure validator tests ────────────────────────────────────────────────────

describe('classifyNormalizationKind + staging safety (epic #42, #39)', () => {
  it('classifies casing normalization', () => {
    expect(classifyNormalizationKind('Cat Supplies', 'cat supplies')).toBe('casing');
    expect(classifyNormalizationKind('cat supplies', 'Cat Supplies')).toBe('casing');
  });

  it('classifies whitespace normalization before casing', () => {
    expect(classifyNormalizationKind(' Cat Supplies ', 'Cat Supplies')).toBe('whitespace');
    expect(classifyNormalizationKind('Cat Supplies ', 'Cat Supplies')).toBe('whitespace');
  });

  it('classifies separator normalization', () => {
    expect(classifyNormalizationKind('Dog/Food', 'Dog Food')).toBe('separator');
    expect(classifyNormalizationKind('Dog-Food', 'Dog Food')).toBe('separator');
    expect(classifyNormalizationKind('Dog; Food', 'Dog Food')).toBe('separator');
  });

  it('classifies typo corrections via levenshtein', () => {
    expect(classifyNormalizationKind('Cat Suplies', 'Cat Supplies')).toBe('typo');
    expect(classifyNormalizationKind('Cat Supplies', 'Cat Suplies')).toBe('typo');
  });

  it('classifies unrelated mappings as semantic', () => {
    expect(classifyNormalizationKind('Feline', 'Cat')).toBe('semantic');
    expect(classifyNormalizationKind('Dog Supplies', 'Cat Supplies')).toBe('semantic');
  });

  it('safeToStage is deterministic: casing/whitespace mechanical, others review', () => {
    expect(safeToStageForKind('casing')).toBe(true);
    expect(safeToStageForKind('whitespace')).toBe(true);
    expect(safeToStageForKind('separator')).toBe(false);
    expect(safeToStageForKind('typo')).toBe(false);
    expect(safeToStageForKind('semantic')).toBe(false);
  });

  it('levenshteinDistance matches known values', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('cat supplies', 'cat supplies')).toBe(0);
    expect(levenshteinDistance('Cat Suplies', 'Cat Supplies')).toBe(1);
  });

  it('hasUnsafePayload rejects control/markup/url/path payloads', () => {
    expect(hasUnsafePayload('Cat\x01Food')).toBe(true);
    expect(hasUnsafePayload('<b>Cat</b>')).toBe(true);
    expect(hasUnsafePayload('Cat &amp; Dog')).toBe(true);
    expect(hasUnsafePayload('file:///etc/passwd')).toBe(true);
    expect(hasUnsafePayload('https://example.com/x')).toBe(true);
    expect(hasUnsafePayload('../outside')).toBe(true);
    expect(hasUnsafePayload('/abs/path')).toBe(true);
    expect(hasUnsafePayload('Cat Supplies')).toBe(false);
    expect(hasUnsafePayload("D'Artagnan 2-Pack")).toBe(false);
  });

  it('stripCodeFence removes json fences and trailing backticks', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

const OBSERVED = new Set([
  'Cat Supplies',
  'cat supplies',
  'Cat Suplies',
  ' Cat Supplies ',
  'Feline',
  'Dog/Food',
  'Dog Food',
]);

function ctx(overrides: Partial<Parameters<typeof validateAiProposalResponse>[1]> = {}) {
  return {
    workspaceId: 'ws-test',
    field: 'ProductField24',
    observedValues: OBSERVED,
    fieldRegistered: true,
    fieldEditable: true,
    source: 'ai' as const,
    ...overrides,
  };
}

describe('validateAiProposalResponse (pure, epic #42, #39)', () => {
  it('accepts a valid mixed response with derived kinds and staging safety', () => {
    const raw = JSON.stringify({
      proposals: [
        { oldValue: 'cat supplies', newValue: 'Cat Supplies', reason: 'casing', confidence: 0.9 },
        { oldValue: ' Cat Supplies ', newValue: 'Cat Supplies', reason: 'trim', confidence: 0.95 },
        { oldValue: 'Dog/Food', newValue: 'Dog Food', reason: 'separator', confidence: 0.7 },
        { oldValue: 'Cat Suplies', newValue: 'Cat Supplies', reason: 'typo', confidence: 0.6 },
        { oldValue: 'Feline', newValue: 'Cat', reason: 'semantic grouping', confidence: 1 },
      ],
    });
    const result = validateAiProposalResponse(raw, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBe(5);
    expect(result.candidates[0]).toMatchObject({ oldValue: 'cat supplies', normalizationKind: 'casing', safeToStage: true });
    expect(result.candidates[1]).toMatchObject({ normalizationKind: 'whitespace', safeToStage: true });
    expect(result.candidates[2]).toMatchObject({ normalizationKind: 'separator', safeToStage: false });
    expect(result.candidates[3]).toMatchObject({ normalizationKind: 'typo', safeToStage: false });
    // Confidence 1 does NOT grant staging authority for semantic merges.
    expect(result.candidates[4]).toMatchObject({ normalizationKind: 'semantic', safeToStage: false, confidence: 1 });
    // Accepted entries are reported in diagnostics with kind/staging.
    const accepted = result.diagnostics.filter((d) => d.status === 'accepted');
    expect(accepted.length).toBe(5);
    expect(accepted[0]).toMatchObject({ index: 0, normalizationKind: 'casing', safeToStage: true });
    expect(result.rejectedCount).toBe(0);
  });

  it('fails closed on invalid JSON (all-or-nothing)', () => {
    const result = validateAiProposalResponse('this is not json', ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_json');
    expect(result.diagnostics[0]).toMatchObject({ index: -1, status: 'rejected', code: 'invalid_json' });
  });

  it('strips fences and accepts fenced JSON', () => {
    const raw = '```json\n{"proposals":[{"oldValue":"Feline","newValue":"Cat"}]}\n```';
    const result = validateAiProposalResponse(raw, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidates.length).toBe(1);
  });

  it('rejects unknown envelope keys (strict schema)', () => {
    const result = validateAiProposalResponse(JSON.stringify({ foo: 1, proposals: [] }), ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_envelope');
  });

  it('rejects candidates with missing fields / wrong types', () => {
    const missing = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Feline' }] }), ctx());
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('invalid_envelope');

    const wrongType = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 123, newValue: 'Cat' }] }), ctx());
    expect(wrongType.ok).toBe(false);
  });

  it('rejects out-of-range and non-finite confidence', () => {
    const high = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Feline', newValue: 'Cat', confidence: 1.5 }] }), ctx());
    expect(high.ok).toBe(false);
    const negative = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Feline', newValue: 'Cat', confidence: -0.1 }] }), ctx());
    expect(negative.ok).toBe(false);
    const nullConfidence = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Feline', newValue: 'Cat', confidence: null }] }), ctx());
    expect(nullConfidence.ok).toBe(false);
  });

  it('rejects oversized values and too many proposals', () => {
    const big = 'x'.repeat(250);
    const oversized = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Feline', newValue: big }] }), ctx());
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.code).toBe('invalid_envelope');

    const many = { proposals: Array.from({ length: 51 }, (_, i) => ({ oldValue: 'Feline', newValue: `Cat-${i}` })) };
    const tooMany = validateAiProposalResponse(JSON.stringify(many), ctx());
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.code).toBe('too_many_proposals');
  });

  it('rejects responses over the byte cap', () => {
    const huge = JSON.stringify({ proposals: [{ oldValue: 'Feline', newValue: 'Cat', reason: 'x'.repeat(70_000) }] });
    const result = validateAiProposalResponse(huge, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('response_too_large');
  });

  it('safe-skips hallucinated old values with structured diagnostics', () => {
    const result = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Unicorns', newValue: 'Cat' }] }), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBe(0);
    expect(result.diagnostics[0]).toMatchObject({ index: 0, status: 'rejected', code: 'old_value_not_observed' });
    expect(result.rejectedCount).toBe(1);
  });

  it('rejects old values that only match case/whitespace variants', () => {
    const result = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Cat Supplies ', newValue: 'Cat Supplies' }] }), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBe(0);
    expect(result.diagnostics[0].code).toBe('old_value_case_mismatch');
  });

  it('rejects identical values', () => {
    const result = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Cat Supplies', newValue: 'Cat Supplies' }] }), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics[0].code).toBe('identical_values');
  });

  it('rejects control/markup/path payloads', () => {
    const result = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Cat Supplies', newValue: '<script>alert(1)</script>' }] }), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics[0].code).toBe('unsafe_payload');
  });

  it('safe-skips duplicate mappings', () => {
    const result = validateAiProposalResponse(
      JSON.stringify({
        proposals: [
          { oldValue: 'cat supplies', newValue: 'Cat Supplies' },
          { oldValue: 'cat supplies', newValue: 'Cat Supplies' },
        ],
      }),
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBe(1);
    expect(result.diagnostics.map((d) => d.code)).toContain('duplicate_mapping');
  });

  it('safe-skips conflicting mappings for one old value', () => {
    const result = validateAiProposalResponse(
      JSON.stringify({
        proposals: [
          { oldValue: 'cat supplies', newValue: 'Cat Supplies' },
          { oldValue: 'cat supplies', newValue: 'Cat Suppliez' },
        ],
      }),
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.length).toBe(1);
    expect(result.diagnostics.map((d) => d.code)).toContain('conflicting_mapping');
  });

  it('rejects chains/cycles in one response', () => {
    const result = validateAiProposalResponse(
      JSON.stringify({
        proposals: [
          { oldValue: 'cat supplies', newValue: 'Cat Supplies' },
          { oldValue: 'Cat Supplies', newValue: 'Cat Supply' },
        ],
      }),
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both participants rejected (chain) — nothing accepted.
    expect(result.candidates.length).toBe(0);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['chain_mapping', 'chain_mapping']);
  });

  it('diagnostics never contain raw model prose beyond bounded values', () => {
    const result = validateAiProposalResponse(JSON.stringify({ proposals: [{ oldValue: 'Ghost', newValue: 'Cat' }] }), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const d of result.diagnostics) {
      expect(d.message.length).toBeLessThanOrEqual(400);
      expect(d.message.includes('ignore previous instructions')).toBe(false);
    }
  });
});

// ─── generateAiProposals integration (DB harness + mocked model) ────────────

describe('generateAiProposals integration (epic #42, #39)', () => {
  const testDbPath = '/tmp/baystate-cms-ai-proposals-test.db';
  const testWorkspacePath = '/tmp/baystate-cms-ai-proposals-workspace';
  const workspaceId = randomUUID();
  const now = new Date().toISOString();

  function makeProduct(sku: string, value: string): Product {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      sku,
      status: 'active',
      core: {
        name: `Product ${sku}`,
        price: '10.00',
        salePrice: null,
        description: 'Toy',
        inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 },
        availability: 'in-stock',
        weight: '0.5',
        taxable: true,
        media: { primary: null, additional: [] },
        seo: { fileName: `${sku}.html`, searchKeywords: null, googleProductCategory: '' },
        productOnPages: [],
      },
      customFields: { ProductField24: value },
      shopsite: {
        productId: sku,
        productGuid: `g-${sku}`,
        xmlVersion: '15.0',
        lastPulledAt: null,
        lastRemoteHash: null,
        lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };
  }

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    createWorkspaceDirs(testWorkspacePath);
    const db = getDb();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'AI Proposals Test Store', testWorkspacePath, `${testWorkspacePath}/.git`, now, now, 'complete'],
    );

    // Editable registry entry for ProductField24; non-editable for ProductField88.
    const mkRegistry = (xmlField: string, editable: boolean, label: string) =>
      upsertRegistryEntry({
        id: randomUUID(),
        workspaceId,
        xmlField,
        label,
        kind: 'select',
        dataType: 'text',
        editable,
        required: false,
        uiGroup: null,
        sampleValuesJson: null,
        createdAt: now,
        updatedAt: now,
      });
    mkRegistry('ProductField24', true, 'Category');
    mkRegistry('ProductField88', false, 'Read Only');

    const products = [
      makeProduct('SKU-001', 'Cat Supplies'),
      makeProduct('SKU-002', 'cat supplies'),
      makeProduct('SKU-003', 'Cat Suplies'),
      makeProduct('SKU-004', ' Cat Supplies '),
      makeProduct('SKU-005', 'Feline'),
      makeProduct('SKU-006', 'Dog/Food'),
      makeProduct('SKU-007', 'Dog Food'),
    ];
    for (const p of products) {
      writeProductFile(testWorkspacePath, p);
      insertProductIndex({
        id: p.id,
        sku: p.sku,
        filePath: `${testWorkspacePath}/products/${p.sku}.json`,
        title: p.core.name,
        status: p.status,
        price: p.core.price,
        inventoryQuantity: p.core.inventory.quantityOnHand,
        primaryImage: p.core.media.primary,
        productHash: 'hash',
        lastApprovedCommit: null,
        lastPulledRemoteHash: null,
        lastSyncedRemoteHash: null,
        lastSyncedAt: null,
        syncStatus: 'not_synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: now,
        updatedAt: now,
        description: p.core.description,
        searchKeywords: p.core.seo.searchKeywords,
        customFields: p.customFields,
      });
    }
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(testWorkspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  beforeEach(() => {
    aiResponse = null;
    llmCallCount = 0;
  });

  it('persists validated AI proposals with server-derived affected SKUs', async () => {
    aiResponse = JSON.stringify({
      proposals: [
        { oldValue: 'cat supplies', newValue: 'Cat Supplies', reason: 'casing normalization', confidence: 0.9 },
        { oldValue: ' Cat Supplies ', newValue: 'Cat Supplies', reason: 'trim whitespace', confidence: 0.99 },
      ],
    });
    const { proposals, diagnostics } = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    expect(proposals.length).toBe(2);
    const casing = proposals.find((p) => p.oldValue === 'cat supplies');
    expect(casing).toBeDefined();
    expect(casing?.newValue).toBe('Cat Supplies');
    expect(casing?.source).toBe('ai');
    expect(casing?.status).toBe('proposed');
    expect(casing?.affectedSkus).toEqual(['SKU-002']);
    expect(casing?.confidence).toBe(0.9);
    const whitespace = proposals.find((p) => p.oldValue === ' Cat Supplies ');
    expect(whitespace?.affectedSkus).toEqual(['SKU-004']);
    // Diagnostics carry the derived kind + deterministic staging flag.
    const accepted = diagnostics.filter((d) => d.status === 'accepted');
    expect(accepted.length).toBe(2);
    expect(accepted[0]).toMatchObject({ index: 0, normalizationKind: 'casing', safeToStage: true });
    expect(accepted[1]).toMatchObject({ index: 1, normalizationKind: 'whitespace', safeToStage: true });
  });

  it('stores semantic merges as review-required (confidence never stages)', async () => {
    aiResponse = JSON.stringify({
      proposals: [
        { oldValue: 'Feline', newValue: 'Cat', reason: 'semantic grouping', confidence: 1 },
        { oldValue: 'Dog/Food', newValue: 'Dog Food', reason: 'separator cleanup', confidence: 1 },
      ],
    });
    const { proposals, diagnostics } = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    expect(proposals.length).toBe(2);
    const semantic = proposals.find((p) => p.oldValue === 'Feline');
    expect(semantic).toBeDefined();
    const semanticDiag = diagnostics.find((d) => d.index === 0);
    expect(semanticDiag).toMatchObject({ status: 'accepted', normalizationKind: 'semantic', safeToStage: false });
    const separatorDiag = diagnostics.find((d) => d.index === 1);
    expect(separatorDiag).toMatchObject({ normalizationKind: 'separator', safeToStage: false });
  });

  it('replaces only prior AI proposed rows for the workspace/field', async () => {
    // Seed prior AI proposal for ProductField24.
    const seeded = replaceAiProposalsForField(workspaceId, 'ProductField24', [
      { oldValue: 'Feline', newValue: 'Feline2', reason: 'old ai', confidence: 0.5, affectedSkus: ['SKU-005'] },
    ]);
    expect(seeded.length).toBe(1);

    aiResponse = JSON.stringify({
      proposals: [
        { oldValue: 'Feline', newValue: 'Cat', reason: 'semantic', confidence: 0.8 },
        { oldValue: 'Dog/Food', newValue: 'Dog Food', reason: 'separator', confidence: 0.8 },
      ],
    });
    const { proposals } = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    expect(proposals.length).toBe(2);
    // Old AI proposal replaced; deterministic/manual rows are untouched (none here).
    const all = listProposals(workspaceId, { field: 'ProductField24' });
    expect(all.some((p) => p.oldValue === 'Feline2')).toBe(false);
    expect(all.some((p) => p.oldValue === 'Feline' && p.newValue === 'Cat')).toBe(true);
  });

  it('preserves prior proposals when the AI response is structurally invalid', async () => {
    const seeded = replaceAiProposalsForField(workspaceId, 'ProductField24', [
      { oldValue: 'Feline', newValue: 'Cat', reason: 'kept on failure', confidence: 0.5, affectedSkus: ['SKU-005'] },
    ]);
    expect(seeded.length).toBe(1);

    aiResponse = 'This is not JSON at all, model hallucinated prose.';
    await expect(generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm })).rejects.toBeInstanceOf(
      AiProposalValidationError,
    );

    const stillThere = listProposals(workspaceId, { field: 'ProductField24' }).some(
      (p) => p.oldValue === 'Feline' && p.newValue === 'Cat' && p.source === 'ai' && p.status === 'proposed',
    );
    expect(stillThere).toBe(true);
  });

  it('rejects malformed envelope and keeps prior proposals', async () => {
    const seeded = replaceAiProposalsForField(workspaceId, 'ProductField24', [
      { oldValue: 'Feline', newValue: 'Cat', reason: 'keep', confidence: 0.5, affectedSkus: ['SKU-005'] },
    ]);
    expect(seeded.length).toBe(1);

    aiResponse = JSON.stringify({ proposals: [{ oldValue: 'Feline', confidence: 0.9 }] }); // missing newValue
    await expect(generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm })).rejects.toBeInstanceOf(
      AiProposalValidationError,
    );
    expect(listProposals(workspaceId, { field: 'ProductField24' }).length).toBe(1);
  });

  it('rolls back the whole replace when a candidate fails insert validation', () => {
    const before = listProposals(workspaceId, { field: 'ProductField24' }).length;
    // NaN confidence is a structural violation: the insert throws and the
    // transaction must roll back the DELETE of prior rows as well.
    expect(() =>
      replaceAiProposalsForField(workspaceId, 'ProductField24', [
        { oldValue: 'Feline', newValue: 'Cat', reason: 'x', confidence: Number.NaN, affectedSkus: ['SKU-005'] },
      ]),
    ).toThrow();
    expect(listProposals(workspaceId, { field: 'ProductField24' }).length).toBe(before);
  });

  it('enforces field scope: pattern, registration, and editability', async () => {
    await expect(generateAiProposals(workspaceId, 'not-a-field', { callLlm: fakeCallLlm })).rejects.toMatchObject({
      name: 'ProposalFieldScopeError',
      code: 'invalid_field_pattern',
    });
    await expect(generateAiProposals(workspaceId, 'ProductField99', { callLlm: fakeCallLlm })).rejects.toMatchObject({
      name: 'ProposalFieldScopeError',
      code: 'unknown_field',
    });
    await expect(generateAiProposals(workspaceId, 'ProductField88', { callLlm: fakeCallLlm })).rejects.toMatchObject({
      name: 'ProposalFieldScopeError',
      code: 'non_editable_field',
    });
  });

  it('requires exact observed old values (whitespace/casing preserved)', async () => {
    // Exact whitespace value is accepted.
    aiResponse = JSON.stringify({ proposals: [{ oldValue: ' Cat Supplies ', newValue: 'Cat Supplies' }] });
    const okResult = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    expect(okResult.proposals.some((p) => p.oldValue === ' Cat Supplies ')).toBe(true);

    // Near-exact variant is rejected and safe-skipped.
    aiResponse = JSON.stringify({ proposals: [{ oldValue: 'Cat Supplies ', newValue: 'Cat Supplies' }] });
    const rejectResult = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    expect(rejectResult.proposals.length).toBe(0);
    expect(rejectResult.diagnostics[0].code).toBe('old_value_case_mismatch');
  });

  it('maps DB rows through the shared schema (single contract)', async () => {
    const rows = listProposals(workspaceId, { field: 'ProductField24' });
    for (const row of rows) {
      const parsed = CatalogProposalSchema.safeParse(row);
      expect(parsed.success).toBe(true);
    }
    // findProposalById returns rows that satisfy the shared type too.
    if (rows.length > 0) {
      const byId = findProposalById(workspaceId, rows[0].id);
      expect(CatalogProposalSchema.safeParse(byId).success).toBe(true);
    }
  });

  it('does not call the model when the field scope fails first', async () => {
    // Field-scope validation runs before any prompt/model call.
    await expect(generateAiProposals(workspaceId, 'ProductField99', { callLlm: fakeCallLlm })).rejects.toBeInstanceOf(
      ProposalFieldScopeError,
    );
    expect(llmCallCount).toBe(0);

    aiResponse = JSON.stringify({ proposals: [{ oldValue: 'Feline', newValue: 'Cat' }] });
    const ok = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    expect(ok.proposals.length).toBeGreaterThanOrEqual(1);
    expect(llmCallCount).toBe(1);
  });

  it('AI and legacy proposals remain bulk-INELIGIBLE (Issue 8: no reclassification by confidence or inference)', async () => {
    aiResponse = JSON.stringify({
      proposals: [
        { oldValue: 'Feline', newValue: 'Cat' },
        { oldValue: 'Canine', newValue: 'Dog' },
      ],
    });
    const ai = await generateAiProposals(workspaceId, 'ProductField24', { callLlm: fakeCallLlm });
    for (const row of ai.proposals) {
      // AI rows never carry bulk-eligibility metadata: source + manual-review
      // defaults make them ineligible even if metadata were forged.
      expect(row.source).toBe('ai');
      expect(isBulkReviewEligible(row)).toBe(false);
      expect(CatalogProposalSchema.safeParse(row).success).toBe(true);
    }

    // Simulated legacy deterministic row with NO metadata: defaults ineligible.
    const legacy = await import('../../db/repositories/catalog-health-proposal-repo');
    const row = legacy.insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'Legacy Old',
      newValue: 'Legacy New',
      affectedSkus: ['SKU-LEGACY'],
      reason: 'legacy row',
      confidence: 0.9,
      source: 'deterministic',
      status: 'proposed',
    });
    expect(isBulkReviewEligible(row)).toBe(false);
    expect(row.manualReviewRequired).toBe(true);
    expect(row.normalizationKind).toBeNull();
    // Deterministic rows WITH the metadata ARE eligible (sanity check).
    const eligible = legacy.insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'low',
      newValue: 'Low',
      affectedSkus: ['SKU-ELIG'],
      reason: 'casing normalization',
      confidence: 0.95,
      source: 'deterministic',
      status: 'proposed',
      normalizationKind: 'casing',
      ruleVersion: 'deterministic:casing:v1',
      evidenceKey: 'casing_normalization',
      manualReviewRequired: false,
    });
    expect(isBulkReviewEligible(eligible)).toBe(true);
  });
});
