/**
 * Unit tests for `src/classification/page-assignment-llm.ts`.
 *
 * Runs under vitest. Mocks the LLM client and page repo so no
 * real API calls or database connections are made.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/schemas/classification';

// Helper: cast a mock-spy value to its Mock type so TS sees .mockResolvedValue etc.
function asMock(fn: any): Mock {
  return fn as unknown as Mock;
}

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('../../onboarding/llm-client', () => {
  const callLlmForTask = vi.fn();
  return {
    callLlmForTask,
    // The audited wrapper is used by production call sites; forward it to the
    // same transport mock so existing assertions on callLlmForTask keep
    // working while the provenance wrapper returns the enriched result shape.
    callLlmForTaskWithProvenance: vi.fn(async (task: string, prompt: string, system: string) => {
      const content = await callLlmForTask(task, prompt, system);
      return content == null
        ? null
        : { content, callId: 'call-1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } };
    }),
  };
});

vi.mock('../../db/repositories/page-repo', () => ({
  listPages: vi.fn(),
}));

// Import after mocks are set up
import { callLlmForTask } from '../../onboarding/llm-client';
import { listPages } from '../../db/repositories/page-repo';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
  normalizePageAssignments,
  validatePageResponseEntries,
  type PageAssignmentParams,
} from '../../classification/page-assignment-llm';

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

const makeProposal = (overrides: Partial<ClassificationProposal> = {}): ClassificationProposal => ({
  id: 'prop-' + Math.random().toString(36).slice(2, 8),
  runId: 'run-1',
  productSku: 'test-sku',
  proposalType: 'primary_product_type',
  targetId: null,
  proposedValue: null,
  confidence: 0.8,
  evidenceIds: [],
  status: 'pending',
  isBulkAcceptable: false,
  isStale: false,
  stalenessReason: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

/**
 * Build a page-name → {id,name} map from entries.
 * The canonical name is used as the key (case-sensitive).
 */
function makePageIndex(
  entries: Array<{ id: string; name: string }>,
): Map<string, { id: string; name: string }> {
  const m = new Map<string, { id: string; name: string }>();
  for (const e of entries) m.set(e.name, { id: e.id, name: e.name });
  return m;
}

// Default page index for normalizePageAssignments tests
const BASIC_PAGE_INDEX = makePageIndex([
  { id: 'p1', name: 'Dog Food Dry' },
  { id: 'p2', name: 'Dog Food Shop All' },
  { id: 'p3', name: 'Cat Food Wet' },
  { id: 'p4', name: 'Cat Food Shop All' },
  { id: 'p5', name: 'Dog Treats' },
  { id: 'p6', name: 'Brand - Acme Pet' },
  { id: 'p7', name: 'Dog Food Wet' },
  { id: 'p8', name: 'Brand - Instinct' },
  { id: 'p9', name: 'Cat Food Dry' },
]);

// ─── buildPageHierarchy ──────────────────────────────────────────────────────

describe('buildPageHierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves parent names from frozen verified Page records (pure, no DB)', () => {
    const records = [
      { pageId: 'parent-1', pageName: 'Dog Food Shop All', verified: true, parentPageId: null, parentPageName: null },
      { pageId: 'child-1', pageName: 'Dog Food Dry', verified: true, parentPageId: 'parent-1', parentPageName: 'Dog Food Shop All' },
      { pageId: 'child-2', pageName: 'Dog Food Wet', verified: true, parentPageId: 'parent-1', parentPageName: 'Dog Food Shop All' },
    ];

    const options = [
      { value: 'parent-1', label: 'Dog Food Shop All' },
      { value: 'child-1', label: 'Dog Food Dry' },
      { value: 'child-2', label: 'Dog Food Wet' },
    ];

    const result = buildPageHierarchy(options, records);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 'parent-1', name: 'Dog Food Shop All', parentName: null });
    expect(result[1]).toEqual({ id: 'child-1', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' });
    expect(result[2]).toEqual({ id: 'child-2', name: 'Dog Food Wet', parentName: 'Dog Food Shop All' });
  });

  it('returns null parentName for top-level pages and is duplicate-name safe', () => {
    const records = [
      { pageId: 'p1', pageName: 'Same Name', verified: true, parentPageId: null, parentPageName: null },
      { pageId: 'p2', pageName: 'Same Name', verified: true, parentPageId: null, parentPageName: null },
    ];

    const result = buildPageHierarchy([
      { value: 'p1', label: 'Same Name' },
      { value: 'p2', label: 'Same Name' },
    ], records);

    expect(result.every(p => p.parentName === null)).toBe(true);
    expect(new Set(result.map(p => p.id)).size).toBe(2);
  });
});

// ─── extractProductContext ───────────────────────────────────────────────────

describe('extractProductContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts product name from spreadsheet expected_name', () => {
    const evidence = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'RAW PRODUCT NAME' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'expected_name', value: 'Cleaned Product Name' }),
      makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Web Title' }),
    ];

    const result = extractProductContext(evidence, []);
    expect(result.productName).toBe('Cleaned Product Name');
  });

  it('falls through preference chain: expected_name → web title → OCR name → spreadsheet name', () => {
    // Only spreadsheet name available
    let result = extractProductContext(
      [makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Only Name' })],
      [],
    );
    expect(result.productName).toBe('Only Name');

    // OCR name available (no expected_name or web title)
    result = extractProductContext(
      [
        makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
        makeEvidence({ source: 'visual_product_evidence', sourceField: 'name', value: 'OCR Name' }),
      ],
      [],
    );
    expect(result.productName).toBe('OCR Name');

    // Web title available
    result = extractProductContext(
      [
        makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
        makeEvidence({ source: 'visual_product_evidence', sourceField: 'name', value: 'OCR Name' }),
        makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Web Title' }),
      ],
      [],
    );
    expect(result.productName).toBe('Web Title');

    // expected_name beats everything
    result = extractProductContext(
      [
        makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
        makeEvidence({ source: 'spreadsheet', sourceField: 'expected_name', value: 'Expected Name' }),
        makeEvidence({ source: 'visual_product_evidence', sourceField: 'name', value: 'OCR Name' }),
        makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Web Title' }),
      ],
      [],
    );
    expect(result.productName).toBe('Expected Name');
  });

  it('extracts species, flavor, lifeStage, productForm from visual_product_evidence', () => {
    const evidence = [
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'species', value: 'dogs' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'flavor', value: 'Smoked Salmon' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'lifeStage', value: 'Adult' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'productForm', value: 'Dry Kibble' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'healthConcern', value: 'Joint Health' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'healthConcern', value: 'Digestion' }),
    ];

    const result = extractProductContext(evidence, []);

    expect(result.ocrSummary.species).toEqual(['Dog', 'dogs']);
    expect(result.ocrSummary.flavor).toBe('Smoked Salmon');
    expect(result.ocrSummary.lifeStage).toBe('Adult');
    expect(result.ocrSummary.productForm).toBe('Dry Kibble');
    expect(result.ocrSummary.healthConcern).toEqual(['Joint Health', 'Digestion']);
  });

  it('extracts productType from primary_product_type proposals', () => {
    const proposals = [
      makeProposal({ proposalType: 'primary_product_type', targetId: 'Dry Dog Food' }),
    ];

    const result = extractProductContext([], proposals);
    expect(result.productType).toBe('Dry Dog Food');
  });

  it('returns null productType when no primary_product_type proposal exists', () => {
    const result = extractProductContext([], []);
    expect(result.productType).toBeNull();
  });

  // ── Brand resolution priority ──────────────────────────────────────────

  it('resolves brand from resolved_brand evidence first', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'catalog_manager_guidance',
        sourceField: 'resolved_brand',
        value: { brandId: 'acme', brandName: 'Acme Pet' },
        reliability: 'high',
      }),
      makeEvidence({
        source: 'official_product_page',
        sourceField: 'brand',
        value: 'Acme Pet Official',
      }),
      makeEvidence({
        source: 'visual_product_evidence',
        sourceField: 'brand',
        value: 'Acme OCR',
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBe('Acme Pet');
  });

  it('falls back to official page brand when resolved_brand absent', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'official_product_page',
        sourceField: 'brand',
        value: 'Acme Official',
      }),
      makeEvidence({
        source: 'spreadsheet',
        sourceField: 'brand',
        value: 'Acme Spreadsheet',
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBe('Acme Official');
  });

  it('falls back to spreadsheet brand hint before OCR brand', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'spreadsheet',
        sourceField: 'brand',
        value: 'Acme Spreadsheet',
      }),
      makeEvidence({
        source: 'visual_product_evidence',
        sourceField: 'brand',
        value: 'Acme OCR',
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBe('Acme Spreadsheet');
  });

  it('falls back to OCR brand as last resort', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'visual_product_evidence',
        sourceField: 'brand',
        value: 'Acme OCR',
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBe('Acme OCR');
  });

  it('returns null brand when no brand evidence exists', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({ sourceField: 'name', value: 'Only Name' }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBeNull();
  });

  // ── Distributor context tests ───────────────────────────────────────────

  it('uses distributor name when no official or OCR name is available', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name',
        value: 'Distributor Product Name',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    // Spreadsheet name should be last resort; distributor wins
    expect(ctx.productName).toBe('Distributor Product Name');
  });

  it('prefers official name over distributor name', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'official_product_page', sourceField: 'name', value: 'Official Product' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name',
        value: 'Distributor Name',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.95 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.productName).toBe('Official Product');
  });

  it('includes distributor descriptions in the product description', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'third_party_page', sourceField: 'description',
        value: 'A premium dog food with real chicken.',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.9 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.productDescription).toContain('[central_pet] A premium dog food with real chicken.');
  });

  it('combines official and distributor descriptions with official first', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'official_product_page', sourceField: 'description',
        value: 'Official product description.',
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'description',
        value: 'Distributor description.',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.productDescription).toContain('Official product description.');
    expect(ctx.productDescription).toContain('[p1] Distributor description.');
    // Official should come first
    expect(ctx.productDescription.indexOf('Official')).toBeLessThan(
      ctx.productDescription.indexOf('[p1]'),
    );
  });

  it('deduplicates identical distributor descriptions', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'third_party_page', sourceField: 'description',
        value: 'Same description text.',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'description',
        value: 'Same description text.',
        metadata: { providerId: 'p2', attemptId: 'a2', confidence: 0.8 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    // Should only appear once
    const occurrences = (ctx.productDescription.match(/Same description text/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('stays within the 2000-character description budget', () => {
    const longDesc = 'X'.repeat(1500);
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'third_party_page', sourceField: 'description',
        value: longDesc,
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.9 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'description',
        value: longDesc + 'extra',
        metadata: { providerId: 'p2', attemptId: 'a2', confidence: 0.8 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.productDescription.length).toBeLessThanOrEqual(2000);
  });

  it('uses distributor brand when no official or spreadsheet brand exists', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'third_party_page', sourceField: 'brand',
        value: 'Distributor Brand Inc',
        metadata: { providerId: 'central_pet', attemptId: 'att-1', confidence: 0.95 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBe('Distributor Brand Inc');
  });

  it('prefers official brand over distributor brand', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'official_product_page', sourceField: 'brand', value: 'Official Brand' }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'brand',
        value: 'Distributor Brand',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.95 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.ocrSummary.brand).toBe('Official Brand');
  });

  it('picks the highest-confidence distributor name among multiple providers', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({
        source: 'third_party_page', sourceField: 'name',
        value: 'Low Confidence Name',
        metadata: { providerId: 'p1', attemptId: 'a1', confidence: 0.5 },
      }),
      makeEvidence({
        source: 'third_party_page', sourceField: 'name',
        value: 'High Confidence Name',
        metadata: { providerId: 'p2', attemptId: 'a2', confidence: 0.95 },
      }),
    ];
    const ctx = extractProductContext(evidence, []);
    expect(ctx.productName).toBe('High Confidence Name');
  });

  it('handles non-string evidence values safely', () => {
    const evidence: ClassificationEvidence[] = [
      makeEvidence({ source: 'third_party_page', sourceField: 'name', value: null as unknown as string }),
      makeEvidence({ source: 'third_party_page', sourceField: 'brand', value: undefined as unknown as string }),
    ];
    const ctx = extractProductContext(evidence, []);
    // Should not crash — falls back to 'Unknown Product'
    expect(ctx.productName).toBe('Unknown Product');
    expect(ctx.ocrSummary.brand).toBeNull();
  });
});

// ─── normalizePageAssignments ────────────────────────────────────────────────

describe('normalizePageAssignments', () => {
  it('deduplicates by page ID (first occurrence wins)', () => {
    // Use entries without Shop All to avoid rule-2 interference
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'p7', pageName: 'Dog Food Wet', confidence: 0.5 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, [], 5);
    expect(result).toHaveLength(2);
    expect(result[0].pageId).toBe('p1');
    expect(result[0].confidence).toBe(0.85);
    expect(result[1].pageId).toBe('p7');
  });

  it('removes Shop All when a specific page is present', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
      { pageId: 'p2', pageName: 'Dog Food Shop All', confidence: 0.5 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, [], 5);
    expect(result).toHaveLength(1);
    expect(result[0].pageName).toBe('Dog Food Dry');
  });

  it('keeps Shop All when no specific page is present', () => {
    const input = [
      { pageId: 'p2', pageName: 'Dog Food Shop All', confidence: 0.6 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, [], 5);
    expect(result).toHaveLength(1);
    expect(result[0].pageName).toBe('Dog Food Shop All');
  });

  it('includes exact brand page when it exists and is not already present', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, 'Acme Pet', [], 5);
    expect(result).toHaveLength(2);
    expect(result[1].pageName).toBe('Brand - Acme Pet');
    expect(result[1].confidence).toBe(0.95);
  });

  it('does not add a second page in single-selection mode', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
    ];
    const result = normalizePageAssignments(
      input,
      BASIC_PAGE_INDEX,
      'Acme Pet',
      [],
      1,
      'single',
    );
    expect(result).toEqual(input);
  });

  it('reserves a slot for an exact brand page when specific pages fill capacity', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'p7', pageName: 'Dog Food Wet', confidence: 0.8 },
      { pageId: 'p5', pageName: 'Dog Treats', confidence: 0.7 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, 'Acme Pet', [], 3);
    expect(result).toHaveLength(3);
    expect(result.map(p => p.pageName)).toEqual([
      'Dog Food Dry',
      'Dog Food Wet',
      'Brand - Acme Pet',
    ]);
  });

  it('does NOT add brand page when already present', () => {
    const input = [
      { pageId: 'p6', pageName: 'Brand - Acme Pet', confidence: 0.9 },
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, 'Acme Pet', [], 5);
    expect(result).toHaveLength(2);
    const brandEntries = result.filter(p => p.pageName === 'Brand - Acme Pet');
    expect(brandEntries).toHaveLength(1);
  });

  it('drops Shop All to make room for brand page when at capacity', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
      { pageId: 'p7', pageName: 'Dog Food Wet', confidence: 0.8 },
      { pageId: 'p2', pageName: 'Dog Food Shop All', confidence: 0.5 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, 'Acme Pet', [], 3);
    // After removing Shop All (2 remain), brand page fits
    expect(result).toHaveLength(3);
    expect(result.some(p => p.pageName === 'Brand - Acme Pet')).toBe(true);
  });

  it('clamps output to maxResults', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'p7', pageName: 'Dog Food Wet', confidence: 0.8 },
      { pageId: 'p5', pageName: 'Dog Treats', confidence: 0.7 },
      { pageId: 'p2', pageName: 'Dog Food Shop All', confidence: 0.5 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, [], 2);
    // After dedupe (4) and removing Shop All (3 remain), clamped to 2
    expect(result).toHaveLength(2);
  });

  it('filters dog pages when only cat species evidence exists', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'p3', pageName: 'Cat Food Wet', confidence: 0.8 },
      { pageId: 'p9', pageName: 'Cat Food Dry', confidence: 0.7 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, ['Cat'], 5);
    expect(result).toHaveLength(2);
    expect(result.every(p => !p.pageName.toLowerCase().includes('dog'))).toBe(true);
    expect(result.some(p => p.pageName === 'Cat Food Wet')).toBe(true);
    expect(result.some(p => p.pageName === 'Cat Food Dry')).toBe(true);
  });

  it('filters cat pages when only dog species evidence exists', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'p3', pageName: 'Cat Food Wet', confidence: 0.8 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, ['Dog'], 5);
    expect(result).toHaveLength(1);
    expect(result[0].pageName).toBe('Dog Food Dry');
  });

  it('does not filter when both cat and dog species present', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'p3', pageName: 'Cat Food Wet', confidence: 0.8 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, ['Dog', 'Cat'], 5);
    expect(result).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    const result = normalizePageAssignments([], BASIC_PAGE_INDEX, null, [], 5);
    expect(result).toHaveLength(0);
  });

  it('filters companion pet pages when only horse/equine species evidence exists', () => {
    const input = [
      { pageId: 'h1', pageName: 'Horse Feed & Supplements', confidence: 0.95 },
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.8 },
      { pageId: 'p3', pageName: 'Cat Food Wet', confidence: 0.75 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, ['Horse'], 5);
    expect(result).toHaveLength(1);
    expect(result[0].pageName).toBe('Horse Feed & Supplements');
  });

  it('filters dog/cat pages when only poultry species evidence exists', () => {
    const input = [
      { pageId: 'pl1', pageName: 'Poultry Feed & Scratch', confidence: 0.95 },
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.8 },
      { pageId: 'p3', pageName: 'Cat Food Wet', confidence: 0.75 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, ['Poultry'], 5);
    expect(result).toHaveLength(1);
    expect(result[0].pageName).toBe('Poultry Feed & Scratch');
  });

  it('filters horse, poultry, and livestock pages when dog species evidence exists', () => {
    const input = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
      { pageId: 'h1', pageName: 'Equine Supplements', confidence: 0.85 },
      { pageId: 'pl1', pageName: 'Poultry Feed', confidence: 0.8 },
      { pageId: 'lv1', pageName: 'Livestock Care', confidence: 0.75 },
    ];
    const result = normalizePageAssignments(input, BASIC_PAGE_INDEX, null, ['Dog'], 5);
    expect(result).toHaveLength(1);
    expect(result[0].pageName).toBe('Dog Food Dry');
  });
});

// ─── validatePageResponseEntries ─────────────────────────────────────────────

describe('validatePageResponseEntries', () => {
  const nameToPage = new Map<string, { id: string; name: string }>();
  const idToPage = new Map<string, { id: string; name: string }>();
  for (const [name, info] of BASIC_PAGE_INDEX) {
    nameToPage.set(name, info);
    idToPage.set(info.id, info);
  }

  it('accepts valid ID-bearing entries', () => {
    const entries = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.85 },
      { pageId: 'p2', pageName: 'Dog Food Shop All', confidence: 0.6 },
    ];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(2);
    expect(result[0].pageId).toBe('p1');
    expect(result[1].pageId).toBe('p2');
  });

  it('rejects unknown page ID', () => {
    const entries = [
      { pageId: 'unknown-id', pageName: 'Dog Food Dry', confidence: 0.85 },
    ];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(0);
  });

  it('rejects ID/name mismatch with different semantic name', () => {
    const entries = [
      { pageId: 'p1', pageName: 'Cat Food Wet', confidence: 0.85 },
    ];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(0);
  });

  it('accepts ID-bearing entry with pageName omitted', () => {
    const entries = [
      { pageId: 'p1', confidence: 0.85 },
    ];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('p1');
    expect(result[0].pageName).toBe('Dog Food Dry');
  });

  it('accepts valid name-only entry (backward compat, unique name)', () => {
    const entries = [
      { pageName: 'Dog Food Dry', confidence: 0.85 },
    ];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('p1');
  });

  /**
   * Duplicate-name scenario: when two different page IDs have names that
   * differ only in case (e.g. "Dog Food Dry" and "DOG FOOD DRY"), a name-only
   * entry for that name is ambiguous and must be rejected.
   */
  it('rejects name-only entry when multiple IDs share the same case-insensitive name', () => {
    const ambiguousNameToPage = new Map<string, { id: string; name: string }>();
    const ambiguousIdToPage = new Map<string, { id: string; name: string }>();
    ambiguousNameToPage.set('Dog Food Dry', { id: 'p1', name: 'Dog Food Dry' });
    ambiguousNameToPage.set('DOG FOOD DRY', { id: 'pX', name: 'DOG FOOD DRY' });
    ambiguousIdToPage.set('p1', { id: 'p1', name: 'Dog Food Dry' });
    ambiguousIdToPage.set('pX', { id: 'pX', name: 'DOG FOOD DRY' });

    // Name-only entry matching both case-insensitively
    const entries = [
      { pageName: 'dog food dry', confidence: 0.8 },
    ];
    const result = validatePageResponseEntries(entries, ambiguousNameToPage, ambiguousIdToPage);
    expect(result).toHaveLength(0);
  });

  it('rejects an exact duplicate display name with different IDs', () => {
    const duplicateNames = new Map<string, { id: string; name: string }>([
      ['Dog Food Dry', { id: 'p1', name: 'Dog Food Dry' }],
      ['Dog Food Dry\u0000pX', { id: 'pX', name: 'Dog Food Dry' }],
    ]);
    const duplicateIds = new Map<string, { id: string; name: string }>([
      ['p1', { id: 'p1', name: 'Dog Food Dry' }],
      ['pX', { id: 'pX', name: 'Dog Food Dry' }],
    ]);
    expect(validatePageResponseEntries(
      [{ pageName: 'Dog Food Dry', confidence: 0.8 }],
      duplicateNames,
      duplicateIds,
    )).toHaveLength(0);
  });

  it('accepts name-only entry with case-insensitive matching', () => {
    const entries = [
      { pageName: 'dog food dry', confidence: 0.85 },
    ];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('p1');
    expect(result[0].pageName).toBe('Dog Food Dry');
  });

  it('rejects non-object entries', () => {
    const entries = [null, 'string', 42];
    const result = validatePageResponseEntries(entries, nameToPage, idToPage);
    expect(result).toHaveLength(0);
  });
});

// ─── llmAssignCategoryPages ──────────────────────────────────────────────────

describe('llmAssignCategoryPages', () => {
  const mockPages = [
    { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' },
    { id: 'dog-food-wet', name: 'Dog Food Wet', parentName: 'Dog Food Shop All' },
    { id: 'dog-treats', name: 'Dog Treats Shop All', parentName: null },
    { id: 'dog-toys', name: 'Dog Toys', parentName: null },
    { id: 'cat-food', name: 'Cat Food Shop All', parentName: null },
  ];

  const defaultParams: PageAssignmentParams = {
    productName: 'Honest Kitchen Beef Recipe',
    productDescription: 'A premium grain-free dog food.',
    ocrSummary: {
      species: ['Dog'],
      flavor: 'Beef',
      lifeStage: 'Adult',
      productForm: 'Dry Kibble',
      healthConcern: ['Joint Health'],
      productName: 'Honest Kitchen Beef',
      brand: 'The Honest Kitchen',
    },
    productType: 'Dry Dog Food',
    pages: mockPages,
    selectionMode: 'multiple',
    maxPages: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when pages list is empty', async () => {
    const result = await llmAssignCategoryPages({ ...defaultParams, pages: [] });
    expect(result).toBeNull();
    expect(callLlmForTask).not.toHaveBeenCalled();
  });

  it('returns null when LLM returns null (no config/fallback)', async () => {
    asMock(callLlmForTask).mockResolvedValue(null);

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).toBeNull();
  });

  it('returns null when LLM returns unparseable response', async () => {
    asMock(callLlmForTask).mockResolvedValue('not valid json at all');

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).toBeNull();
  });

  it('returns validated pages when LLM returns valid JSON with pages array', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.85 },
          { pageName: 'Dog Food Wet', confidence: 0.65 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
    expect(result!.pages[0]).toEqual({
      pageId: 'dog-food-dry',
      pageName: 'Dog Food Dry',
      confidence: 0.85,
    });
    expect(result!.pages[1]).toEqual({
      pageId: 'dog-food-wet',
      pageName: 'Dog Food Wet',
      confidence: 0.65,
    });
  });

  it('rejects page names not in the provided list', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.85 },
          { pageName: 'Non Existent Page', confidence: 0.7 },
          { pageName: 'Dog Food Wet', confidence: 0.6 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
    expect(result!.pages.map(p => p.pageName)).toEqual(['Dog Food Dry', 'Dog Food Wet']);
  });

  it('returns null when no returned pages match the provided list', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Completely Made Up Page', confidence: 0.9 },
          { pageName: 'Another Fake Page', confidence: 0.8 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).toBeNull();
  });

  it('handles {values: [...]} response shape from LLM', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ values: ['Dog Food Dry', 'Dog Food Wet'], confidence: 0.8 }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
    expect(result!.pages[0].pageName).toBe('Dog Food Dry');
    expect(result!.pages[1].pageName).toBe('Dog Food Wet');
  });

  it('strips markdown code fences from LLM response', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      '```json\n{"pages":[{"pageName":"Dog Food Dry","confidence":0.8}]}\n```',
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(1);
    expect(result!.pages[0].pageName).toBe('Dog Food Dry');
  });

  it('matches page names case-insensitively', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ pages: [{ pageName: 'dog food dry', confidence: 0.8 }] }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages[0].pageName).toBe('Dog Food Dry');
    expect(result!.pages[0].pageId).toBe('dog-food-dry');
  });

  it('caps confidence between 0.35 and 0.95', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.99 },
          { pageName: 'Dog Food Wet', confidence: 0.1 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages[0].confidence).toBe(0.95);
    expect(result!.pages[1].confidence).toBe(0.35);
  });

  it('limits results to maxPages', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.9 },
          { pageName: 'Dog Food Wet', confidence: 0.8 },
          { pageName: 'Dog Treats Shop All', confidence: 0.7 },
          { pageName: 'Dog Toys', confidence: 0.6 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages({ ...defaultParams, maxPages: 2 });
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
  });

  // ── Prompt inspection tests ────────────────────────────────────────────

  it('sibling prompt does not contain "assigned to"', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ pages: [{ pageName: 'Dog Food Dry', confidence: 0.8 }] }),
    );

    const paramsWithSiblings: PageAssignmentParams = {
      ...defaultParams,
      siblingProducts: [
        { sku: 'SKU002', name: 'Honest Kitchen Beef Recipe Chicken' },
        { sku: 'SKU003', name: 'Honest Kitchen Beef Recipe Lamb' },
      ],
    };

    await llmAssignCategoryPages(paramsWithSiblings);

    expect(asMock(callLlmForTask).mock.calls.length).toBe(1);
    // callLlmForTask signature: (taskName, prompt, systemPrompt, options)
    const prompt = asMock(callLlmForTask).mock.calls[0][1] as string;
    expect(prompt).not.toContain('assigned to');
    expect(prompt).not.toContain('assigned to []');
    expect(prompt).toContain('SKU002');
    expect(prompt).toContain('Honest Kitchen Beef Recipe Chicken');
    expect(prompt).toContain('SIBLING PRODUCTS');
  });

  it('includes page IDs ([ID:...]) in the prompt listing', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ pages: [{ pageName: 'Dog Food Dry', confidence: 0.8 }] }),
    );

    await llmAssignCategoryPages(defaultParams);

    expect(asMock(callLlmForTask).mock.calls.length).toBe(1);
    const prompt = asMock(callLlmForTask).mock.calls[0][1] as string;
    expect(prompt).toContain('[ID:dog-food-dry]');
    expect(prompt).toContain('[ID:dog-food-wet]');
  });

  it('prompt instructs LLM to return pageId and pageName', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ pages: [{ pageName: 'Dog Food Dry', confidence: 0.8 }] }),
    );

    await llmAssignCategoryPages(defaultParams);

    expect(asMock(callLlmForTask).mock.calls.length).toBe(1);
    const prompt = asMock(callLlmForTask).mock.calls[0][1] as string;
    expect(prompt).toContain('"pageId"');
    expect(prompt).toContain('"pageName"');
  });
});
