/**
 * Unit tests for `src/classification/stages/name-consolidation.ts`.
 *
 * Covers distributor title/brand signal collection, deduplication,
 * confidence ordering, fallback behavior, and backward compatibility
 * when no distributor evidence is present.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type {
  ClassificationEvidence,
} from '../../shared/schemas/classification';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../onboarding/title-consolidation', () => ({
  consolidateProductTitle: vi.fn(),
}));

import { consolidateProductTitle } from '../../onboarding/title-consolidation';
import { nameConsolidationStage } from '../../classification/stages/name-consolidation';
import type { StageContext, StageInput } from '../../classification/types';

function asMock(fn: any): Mock {
  return fn as unknown as Mock;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeEvidence = (overrides: Partial<ClassificationEvidence> = {}): ClassificationEvidence => ({
  id: 'ev-' + Math.random().toString(36).slice(2, 8),
  runId: 'run-1',
  stageName: 'evidence_extraction',
  productSku: 'test-sku',
  attributeId: null,
  source: 'spreadsheet',
  reliability: 'medium',
  sourceUrl: null,
  sourceField: 'name',
  snippet: null,
  value: 'Test Product',
  metadata: null,
  capturedAt: new Date().toISOString(),
  ...overrides,
});

const makeContext = (overrides: Partial<StageContext> = {}): StageContext => ({
  workspacePath: '/test/workspace',
  workspaceId: 'ws-1',
  runId: 'run-1',
  configSnapshotRef: {
    id: 'snap-1',
    hash: 'abc123',
    sourceCommit: null,
    createdAt: new Date().toISOString(),
  },
  ...overrides,
});

const makeInput = (overrides: Partial<StageInput> = {}): StageInput => ({
  sku: 'test-sku',
  onboardingItemId: 'item-1',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
  ...overrides,
});

// ─── Signal Collection ──────────────────────────────────────────────────────

describe('nameConsolidationStage — distributor signal collection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes distributor titles and brands to consolidateProductTitle', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Acme Premium Dog Food 5 lb',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'DOG FOOD 5LB' }),
      // Per-attempt distributor titles
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'name',
        value: 'Acme Premium Dog Food 5 lb',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.95 },
      }),
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'name',
        value: 'Acme Dog Food 5lb',
        metadata: { providerId: 'bradley', attemptId: 'att-2', confidence: 0.85 },
      }),
      // Per-attempt distributor brands
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'brand',
        value: 'Acme Pet Foods',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.95 },
      }),
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'brand',
        value: 'ACME',
        metadata: { providerId: 'bradley', attemptId: 'att-2', confidence: 0.85 },
      }),
    ];

    const result = await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorTitles).toBeDefined();
    expect(callArgs.distributorTitles).toHaveLength(2);
    expect(callArgs.distributorTitles[0].title).toBe('Acme Premium Dog Food 5 lb');
    expect(callArgs.distributorTitles[0].providerId).toBe('central_pet');
    expect(callArgs.distributorTitles[1].title).toBe('Acme Dog Food 5lb');
    expect(callArgs.distributorTitles[1].providerId).toBe('bradley');

    expect(callArgs.distributorBrands).toBeDefined();
    expect(callArgs.distributorBrands).toHaveLength(2);
    expect(callArgs.distributorBrands[0].brand).toBe('Acme Pet Foods');
    expect(callArgs.distributorBrands[1].brand).toBe('ACME');
  });

  it('orders distributor titles by confidence descending', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Test Brand' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Low Confidence',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.5 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'High Confidence',
        metadata: { providerId: 'p2', attemptId: 'a2', confidence: 0.95 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Medium Confidence',
        metadata: { providerId: 'p3', attemptId: 'a3', confidence: 0.7 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorTitles).toHaveLength(3);
    expect(callArgs.distributorTitles[0].title).toBe('High Confidence');
    expect(callArgs.distributorTitles[1].title).toBe('Medium Confidence');
    expect(callArgs.distributorTitles[2].title).toBe('Low Confidence');
  });

  it('deduplicates provider/value pairs in distributor titles', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Test Brand' }),
      // Per-attempt record
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Same Title',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
      // Same provider, same title — should be deduplicated
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Same Title',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorTitles).toHaveLength(1);
  });

  it('prefers per-attempt records over flattened duplicates', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Test Brand' }),
      // Flattened record (no attemptId)
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Flattened Title',
        metadata: { providerId: 'central_pet', confidence: 0.8 },
      }),
      // Per-attempt record with same provider/value
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Flattened Title',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorTitles).toHaveLength(1);
    // Should use the per-attempt record
    expect(callArgs.distributorTitles[0].attemptId).toBe('att-1');
    expect(callArgs.distributorTitles[0].confidence).toBe(0.9);
  });

  it('recognises both sourceField name and title for distributor titles', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Test Brand' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Name Title',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'title', value: 'Field Title',
        metadata: { providerId: 'p2', attemptId: 'a2', confidence: 0.8 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorTitles).toHaveLength(2);
  });

  it('uses distributor brand as fallback when no spreadsheet or official brand', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test Product',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test Product' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'brand', value: 'Distributor Brand Inc',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.95 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.brandHint).toBe('Distributor Brand Inc');
  });

  it('prefers spreadsheet brand over distributor brand', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Spreadsheet Brand' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'brand', value: 'Distributor Brand',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.95 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.brandHint).toBe('Spreadsheet Brand');
    // Distributor brands should still be passed for cross-reference
    expect(callArgs.distributorBrands).toHaveLength(1);
  });

  it('does not abstain when only distributor signals are available', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Distributor Only Product',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      // No spreadsheet, official, or OCR — only distributor signals
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Distributor Only Product',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'brand', value: 'Distributor Brand',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
    ];

    const result = await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
  });

  it('handles non-string and blank values gracefully', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Test Brand' }),
      // Non-string value — should be safely ignored
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 12345 as unknown as string,
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
      // Null metadata confidence — should still work
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'Valid Title',
        metadata: { providerId: 'p2', attemptId: 'a2' },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    // Non-string values (12345) are filtered out; 'Valid Title' passes
    expect(callArgs.distributorTitles).toHaveLength(1);
    expect(callArgs.distributorTitles[0].title).toBe('Valid Title');
    // Missing confidence defaults to 0.5
    expect(callArgs.distributorTitles[0].confidence).toBe(0.5);
  });

  it('ignores blank/empty distributor values', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Test Brand' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: '   ',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
    ];

    await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    // Blank value after trim — should be skipped
    expect(callArgs.distributorTitles).toBeUndefined();
  });

  it('records distributor signal counts in signalsUsed metadata', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Test Product',
      source: 'llm',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Test Product' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'T1',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name', value: 'T2',
        metadata: { providerId: 'p2', attemptId: 'a2', confidence: 0.8 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'brand', value: 'B1',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
    ];

    const result = await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    const meta = result.output.metadata as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const signalsUsed = meta!.signalsUsed as Record<string, unknown> | undefined;
    expect(signalsUsed).toBeDefined();
    expect(signalsUsed!.distributorTitleCount).toBe(2);
    expect(signalsUsed!.distributorBrandCount).toBe(1);
  });

  it('consumes a branded preComputedTitle byte-for-byte without calling the consolidator', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({ evidence: [makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' })] }),
      makeContext({ preComputedTitle: 'Acme Premium Dog Food 5 lb', preComputedTitleSource: 'llm_cohort' }),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    // Design B: durable coordinated titles are final — consumed verbatim.
    expect(result.output.metadata?.curatedTitle).toBe('Acme Premium Dog Food 5 lb');
    expect(result.output.metadata?.brandApplied).toBe('Acme');
    expect(consolidateProductTitle).not.toHaveBeenCalled();
  });

  it('throws a parent-defect error for a brandless durable title against author-visible brand', async () => {
    await expect(
      nameConsolidationStage.execute(
        makeInput({
          evidence: [makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' })],
        }),
        makeContext({ runId: 'run-defect-1', preComputedTitle: 'Premium Dog Food 5 lb', preComputedTitleSource: 'llm_cohort' }),
      ),
    ).rejects.toThrow(/stale or corrupt/);
    expect(consolidateProductTitle).not.toHaveBeenCalled();
  });

  it('abstains (no throw) for distributor-only brand against a brandless durable title', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Premium Dog Food 5 lb' }),
          makeEvidence({
            source: 'third_party_page',
            sourceField: 'brand',
            value: 'Acme',
            metadata: { providerId: 'bradley', attemptId: 'a1', confidence: 0.9 },
          }),
        ],
      }),
      makeContext({ preComputedTitle: 'Premium Dog Food 5 lb', preComputedTitleSource: 'llm_cohort' }),
    );

    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_brand/);
    expect(consolidateProductTitle).not.toHaveBeenCalled();
  });

  it('PR8 review R1 (BLOCKER 2b): an EMPTY preComputedTitle THROWS a deterministic member error — it never falls through to per-item synthesis (no invented title)', async () => {
    await expect(
      nameConsolidationStage.execute(
        makeInput({ sku: 'SKU-EMPTY-TITLE', evidence: [] }),
        makeContext({ runId: 'run-parent-42', preComputedTitle: '   ', preComputedTitleSource: 'llm_cohort' }),
      ),
    ).rejects.toThrow(/SKU-EMPTY-TITLE/);
    await expect(
      nameConsolidationStage.execute(
        makeInput({ sku: 'SKU-EMPTY-TITLE', evidence: [] }),
        makeContext({ runId: 'run-parent-42', preComputedTitle: '' }),
      ),
    ).rejects.toThrow(/run-parent-42/);
    await expect(
      nameConsolidationStage.execute(
        makeInput({ sku: 'SKU-EMPTY-TITLE', evidence: [] }),
        makeContext({ runId: 'run-parent-42', preComputedTitle: '' }),
      ),
    ).rejects.toThrow(/EMPTY coordinated title/);
    // The per-item LLM path was NEVER consulted for the empty coordinated title.
    expect(consolidateProductTitle).not.toHaveBeenCalled();
  });

  it('includes distributor titles in the fallback chain (error path)', async () => {
    asMock(consolidateProductTitle).mockRejectedValue(new Error('LLM error'));

    const evidence: ClassificationEvidence[] = [
      // No spreadsheet, official, or OCR — only distributor signals
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'name',
        value: 'Distributor Fallback Title',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'brand',
        value: 'Acme',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
    ];

    const result = await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    expect(result.output.metadata?.curatedTitle).toBe('Acme Distributor Fallback Title');
  });
});

// ─── Brand guarantee (issue #108) ───────────────────────────────────────────

describe('nameConsolidationStage — brand guarantee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('abstains missing_brand when no brand exists in any evidence', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Brandless Product',
      source: 'llm',
    });

    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Brandless Product' })],
      }),
      makeContext(),
    );

    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_brand/);
    // Fail-closed before synthesis: the LLM path is never consulted.
    expect(consolidateProductTitle).not.toHaveBeenCalled();
  });

  it('abstains when the mocked consolidator reports brandUnverified', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Brandless Product',
      source: 'llm',
      brandUnverified: true,
    });

    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Brandless Product' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
        ],
      }),
      makeContext(),
    );

    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_brand/);
  });

  it('records brandApplied metadata on success', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Acme Widget',
      source: 'llm',
      brandApplied: 'Acme',
    });

    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Widget' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
        ],
      }),
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    expect(result.output.metadata?.brandApplied).toBe('Acme');
  });

  it('falls back to the stage brandHint when the consolidator omits brandApplied', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Acme Widget',
      source: 'manual',
    });

    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Widget' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
        ],
      }),
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    expect(result.output.metadata?.brandApplied).toBe('Acme');
  });

  it('abstains missing_brand for a preComputedTitle with no brand evidence at all', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({ evidence: [] }),
      makeContext({ preComputedTitle: 'Cohort Title', preComputedTitleSource: 'llm_cohort' }),
    );

    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_brand/);
    expect(consolidateProductTitle).not.toHaveBeenCalled();
  });
});

// ─── distributor_record wiring (issue #110) ──────────────────────────────────
// Both evidence-extraction paths emit distributor evidence with source
// `distributor_record`; the collector must not drop it.

/** Consolidated distributor_record evidence as evidence-extraction emits it. */
const distributorRecordEvidence = (
  sourceField: string,
  value: string,
  opts: { providerId?: string; attemptIds?: string[] } = {},
): ClassificationEvidence =>
  makeEvidence({
    source: 'distributor_record' as ClassificationEvidence['source'],
    sourceField,
    value,
    metadata: {
      provenance: 'distributor_record',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: opts.attemptIds ?? ['att-1'],
      acceptedProviderIds: [opts.providerId ?? 'bradley'],
      distributorEvidenceHash: 'hash-1',
      fieldProvenance: { [sourceField]: opts.providerId ?? 'bradley' },
    },
  });

describe('nameConsolidationStage — distributor_record wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('distributor_record name+brand reach the consolidator with provenance', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Salter E-Z Hang Scale Silver Up to 55 LB',
      source: 'llm',
      brandApplied: 'Salter',
    });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'E-Z HANG SCALE' }),
      distributorRecordEvidence('name', 'E-Z Hang Scale Silver Up to 55 LB'),
      distributorRecordEvidence('brand', 'Salter'),
    ];

    const result = await nameConsolidationStage.execute(makeInput({ evidence }), makeContext());

    expect(result.status).toBe('succeeded');
    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    // Bradley-style: brandless spreadsheet name, brand only in distributor details.
    expect(callArgs.brandHint).toBe('Salter');
    expect(callArgs.distributorTitles).toHaveLength(1);
    expect(callArgs.distributorTitles[0]).toMatchObject({
      title: 'E-Z Hang Scale Silver Up to 55 LB',
      providerId: 'bradley',
      attemptId: '',
      confidence: 1.0,
    });
    expect(callArgs.distributorBrands).toHaveLength(1);
    expect(callArgs.distributorBrands[0]).toMatchObject({ brand: 'Salter', providerId: 'bradley' });
  });

  it('providerId falls back to acceptedProviderIds then unknown', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({ title: 'X', source: 'llm' });

    const noFieldProv = distributorRecordEvidence('brand', 'Acme', { providerId: 'bradley' });
    (noFieldProv.metadata as Record<string, unknown>).fieldProvenance = {};
    const noProvAtAll = distributorRecordEvidence('name', 'Widget', { providerId: 'bradley' });
    (noProvAtAll.metadata as Record<string, unknown>).fieldProvenance = {};
    (noProvAtAll.metadata as Record<string, unknown>).acceptedProviderIds = [];

    await nameConsolidationStage.execute(
      makeInput({ evidence: [noFieldProv, noProvAtAll] }),
      makeContext(),
    );

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorBrands[0].providerId).toBe('bradley');
    expect(callArgs.distributorTitles[0].providerId).toBe('unknown');
  });

  it('consolidated distributor_record outranks legacy per-attempt rows', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({ title: 'X', source: 'llm' });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Widget' }),
      makeEvidence({
        source: 'third_party_page',
        sourceField: 'brand',
        value: 'Stale Brand',
        metadata: { providerId: 'legacy', attemptId: 'att-9', confidence: 0.9 },
      }),
      distributorRecordEvidence('brand', 'Salter'),
    ];

    await nameConsolidationStage.execute(makeInput({ evidence }), makeContext());

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    // Projection authority first; the legacy row is retained, not dropped.
    expect(callArgs.distributorBrands[0].brand).toBe('Salter');
    expect(callArgs.distributorBrands).toHaveLength(2);
    expect(callArgs.brandHint).toBe('Salter');
  });

  it('operator-transcribed Bradley titles pick up the distributor-details brand (AC3)', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({
      title: 'Salter E-Z Hang Scale Silver Up to 55 LB',
      source: 'llm',
      brandApplied: 'Salter',
    });

    // Operator copied the brandless H1; brand lives only in distributor details.
    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'E-Z HANG SCALE' }),
      makeEvidence({ source: 'operator_manual', sourceField: 'name', value: 'E-Z Hang Scale Silver Up to 55 LB' }),
      distributorRecordEvidence('brand', 'Salter'),
    ];

    const result = await nameConsolidationStage.execute(makeInput({ evidence }), makeContext());

    expect(result.status).toBe('succeeded');
    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.manualTitle).toBe('E-Z Hang Scale Silver Up to 55 LB');
    expect(callArgs.brandHint).toBe('Salter');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    expect(result.output.metadata?.brandApplied).toBe('Salter');
  });

  it('distributor_record rows never invent values from blank evidence', async () => {
    asMock(consolidateProductTitle).mockResolvedValue({ title: 'X', source: 'llm' });

    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Widget' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
      distributorRecordEvidence('brand', '   '),
    ];

    await nameConsolidationStage.execute(makeInput({ evidence }), makeContext());

    const callArgs = asMock(consolidateProductTitle).mock.calls[0][0];
    expect(callArgs.distributorBrands).toBeUndefined();
    expect(callArgs.brandHint).toBe('Acme');
  });
});
