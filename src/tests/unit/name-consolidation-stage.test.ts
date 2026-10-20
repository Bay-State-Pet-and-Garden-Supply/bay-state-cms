/**
 * Unit tests for `src/classification/stages/name-consolidation.ts` (issue #365).
 *
 * Tests run against the REAL evidence-backed boundary seam
 * (`resolveNameSelection` — no mocks): deterministic candidate construction,
 * deterministic choice, conflict/missing abstention, sibling-context
 * isolation, and the durable coordinated-title path (consumed verbatim,
 * never re-derived).
 */
import { describe, it, expect } from 'vitest';
import type {
  ClassificationEvidence,
} from '../../shared/schemas/classification';

import { nameConsolidationStage } from '../../classification/stages/name-consolidation';
import type { StageContext, StageInput } from '../../classification/types';

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

/** Minimal eligible bundle: register name + brand + one size token. */
function eligibleBundle(name = 'Acme Chicken Dinner 5LB'): ClassificationEvidence[] {
  return [
    makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: name }),
    makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
    makeEvidence({ source: 'visual_product_evidence', sourceField: 'weight', value: '5 lb' }),
  ];
}

// ─── Boundary: candidates / deterministic choice / abstain ────────────────────

describe('nameConsolidationStage — evidence-backed boundary', () => {
  it('resolves a single eligible candidate deterministically with a persisted nameDecision', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({ evidence: eligibleBundle() }),
      makeContext(),
    );
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    const meta = result.output.metadata as Record<string, unknown>;
    expect(typeof meta.curatedTitle).toBe('string');
    expect(['typesafe', 'deterministic', 'manual']).toContain(meta.titleSource);
    const decision = meta.nameDecision as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.selectedTitle).toBe(meta.curatedTitle);
    expect(typeof (decision as { inputHash?: unknown }).inputHash).toBe('string');
    expect(typeof (decision as { titleHash?: unknown }).titleHash).toBe('string');
  });

  it('abstains missing_brand when no brand exists in any evidence', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Chicken Dinner 5LB' }),
          makeEvidence({ source: 'visual_product_evidence', sourceField: 'weight', value: '5 lb' }),
        ],
      }),
      makeContext(),
    );
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_brand/);
  });

  it('abstains missing_size when no size token exists in any evidence', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Chicken Dinner' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
        ],
      }),
      makeContext(),
    );
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_size/);
  });

  it('holds conflicting sizes actionable without inventing a union', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Chicken Dinner 5 lb' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
          makeEvidence({ source: 'official_product_page', sourceField: 'weight', value: '10 lb' }),
        ],
      }),
      makeContext(),
    );
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/conflicting_sizes/);
  });

  it('does not conflict across dimensions (weight + count coexist)', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Chicken Dinner 5 lb 6-Pack' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
        ],
      }),
      makeContext(),
    );
    // Weight + count on different dimensions must not hold as conflicting.
    if (result.status === 'abstained') expect(result.reason).not.toMatch(/conflicting_sizes/);
    else expect(result.status).toBe('succeeded');
  });

  it('abstains (no invention) when candidates are ambiguous and no TypeSafe route exists', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Chicken Dinner 5 lb' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
          makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Acme Salmon Feast 5 lb' }),
        ],
      }),
      makeContext({ snapshot: undefined }),
    );
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/service_failure|insufficient_evidence/);
  });

  it('passes sibling titles as presentation context without inheriting facts', async () => {
    const evidence = eligibleBundle();
    const withSiblings = await nameConsolidationStage.execute(
      makeInput({ evidence }),
      makeContext({
        productLineContext: {
          groupId: 'g-1',
          groupLabel: 'Acme Dinner',
          siblingNames: ['Acme Salmon Feast 5 lb'],
          siblingWebTitles: [],
          siblingOcrTitles: [],
          siblingSkus: ['other-sku'],
        },
      }),
    );
    const solo = await nameConsolidationStage.execute(makeInput({ evidence }), makeContext());
    expect(withSiblings.status).toBe('succeeded');
    expect(solo.status).toBe('succeeded');
    if (withSiblings.status !== 'succeeded' || solo.status !== 'succeeded') throw new Error('Expected success');
    // Sibling facts never leak into the title: both runs agree.
    expect(withSiblings.output.metadata?.curatedTitle).toBe(solo.output.metadata?.curatedTitle);
    expect(String(withSiblings.output.message)).toMatch(/presentation context/);
  });
});

// ─── Durable coordinated-title path (consumed verbatim) ───────────────────────

describe('nameConsolidationStage — durable coordinated titles', () => {
  it('consumes a branded preComputedTitle byte-for-byte', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
          makeEvidence({ source: 'visual_product_evidence', sourceField: 'weight', value: '5 lb' }),
        ],
      }),
      makeContext({ preComputedTitle: 'Acme Premium Dog Food 5 lb', preComputedTitleSource: 'llm_cohort' }),
    );
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    expect(result.output.metadata?.curatedTitle).toBe('Acme Premium Dog Food 5 lb');
    expect(result.output.metadata?.brandApplied).toBe('Acme');
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
  });

  it('an EMPTY preComputedTitle THROWS — it never falls through to per-item synthesis', async () => {
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
    ).rejects.toThrow(/EMPTY coordinated title/);
  });

  it('throws parent-defect for a sizeless durable title against evidenced size', async () => {
    await expect(
      nameConsolidationStage.execute(
        makeInput({
          evidence: [
            makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Kibble' }),
            makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
            makeEvidence({ source: 'visual_product_evidence', sourceField: 'weight', value: '5 lb' }),
          ],
        }),
        makeContext({ runId: 'run-size-1', preComputedTitle: 'Acme Kibble', preComputedTitleSource: 'llm_cohort' }),
      ),
    ).rejects.toThrow(/stale or corrupt/);
  });

  it('holds missing_size (not parent-defect) for a distributor-only token gap invisible to authorship', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Kibble 5 lb' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
          makeEvidence({
            source: 'distributor_record',
            sourceField: 'size',
            value: 'Up to 55 LB',
            metadata: { acceptedProviderIds: ['bradley'], fieldProvenance: { size: 'bradley' } },
          }),
        ],
      }),
      makeContext({ preComputedTitle: 'Acme Kibble 5 lb', preComputedTitleSource: 'llm_cohort' }),
    );
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/^missing_size/);
  });

  it('throws a parent-defect error for a durable title missing its authored color', async () => {
    await expect(
      nameConsolidationStage.execute(
        makeInput({
          evidence: [
            makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Widget Red' }),
            makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
            makeEvidence({ source: 'visual_product_evidence', sourceField: 'color', value: 'Red' }),
            makeEvidence({ source: 'visual_product_evidence', sourceField: 'weight', value: '5 lb' }),
          ],
        }),
        makeContext({ runId: 'run-color-1', preComputedTitle: 'Acme Widget 5 lb', preComputedTitleSource: 'llm_cohort' }),
      ),
    ).rejects.toThrow(/stale or corrupt/);
  });
});

// ─── Issue #365 blockers: overflow visibility, evidence-tagged distributor spans, per-candidate quantity scoping ─

describe('nameConsolidationStage — #365 blocker coverage', () => {
  it('abstains visibly (never clips) when eligible spans exceed 16 complete candidates', async () => {
    const evidence: ReturnType<typeof makeEvidence>[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Dog Food Base 5 lb' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
    ];
    for (let i = 0; i < 20; i++) {
      evidence.push(makeEvidence({ source: 'distributor_record', sourceField: 'name', value: `Acme Dog Food Recipe ${i} 5 lb`, metadata: { providerId: 'p1', attemptId: 'a1', confidence: 1.0 } }));
    }
    const result = await nameConsolidationStage.execute(makeInput({ evidence }), makeContext());
    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') throw new Error('Expected abstention');
    expect(result.reason).toMatch(/candidate_overflow|16/);
  });

  it('tags distributor spans with real evidence ids (no empty selectedEvidenceIds on distributor names)', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Kibble 5 lb' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
          makeEvidence({ source: 'distributor_record', sourceField: 'name', value: 'Acme Kibble 5 lb', metadata: { providerId: 'bradley', attemptId: 'a9', fieldProvenance: { name: 'bradley' }, acceptedProviderIds: ['bradley'] } }),
        ],
      }),
      makeContext(),
    );
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected success');
    const decision = result.output.metadata?.nameDecision as Record<string, unknown>;
    const ids = (decision?.selectedEvidenceIds ?? []) as string[];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('does not treat unit-converted equivalents as conflicts (5 lb vs 80 oz)', async () => {
    const result = await nameConsolidationStage.execute(
      makeInput({
        evidence: [
          makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Acme Kibble 5 lb' }),
          makeEvidence({ source: 'spreadsheet', sourceField: 'brand', value: 'Acme' }),
          makeEvidence({ source: 'official_product_page', sourceField: 'weight', value: '80 oz' }),
        ],
      }),
      makeContext(),
    );
    // Same net quantity in different units: must not hold as conflicting_sizes.
    if (result.status === 'abstained') expect(result.reason).not.toMatch(/conflicting_sizes/);
    else expect(result.status).toBe('succeeded');
  });

  it('scopes quantities per candidate (a quantity from span B is never asserted on span A)', async () => {
    const { buildNameCandidates } = await import('../../classification/name-candidates');
    const outcome = buildNameCandidates({
      spans: [
        { channel: 'register', span: 'Acme Chicken Dinner 5 lb' },
        { channel: 'official', span: 'Acme Salmon Feast 10 lb' },
      ],
      brand: 'Acme',
    });
    // Distinct net quantities conflict stay actionable (never unioned).
    if (outcome.kind !== 'conflict') throw new Error(`expected conflict, got ${outcome.kind}`);
  });
});
