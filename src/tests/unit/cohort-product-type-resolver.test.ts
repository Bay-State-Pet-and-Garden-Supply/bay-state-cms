import { describe, it, expect } from 'bun:test';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  evidenceFromProjection,
  matchMemberDeterministically,
  resolveCohortProductType,
  validateCohortFamilyInvariants,
  KEYWORD_MATCH_MIN_CONFIDENCE,
} from '../../classification/cohort-product-type-resolver';
import type { CohortMemberInput, PerMemberProductTypeResult } from '../../classification/cohort-product-type-resolver';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
  ExecutionEvidenceProjectionV1,
} from '../../shared/schemas/cohorts';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { BrandConfig } from '../../shared/schemas/classification';
import type { ReviewedFact } from '../../classification/reviewed-facts';
import { packagingOcrDataToEvidence } from '../../classification/ocr-evidence';

// ─── Fixtures (pure — no DB) ──────────────────────────────────────────────────

const TYPE_PRODUCT_TYPES = [
  { id: 'dry-dog-food', name: 'Dry Dog Food' },
  { id: 'dry-cat-food', name: 'Dry Cat Food' },
];

const PRODUCT_TYPE_TARGET = {
  id: 'test-product-type',
  kind: 'product_type' as const,
  label: 'Test Product Type',
  enabled: true,
  selectionMode: 'single' as const,
  attributeId: null,
  catalogField: null,
  optionSource: 'configured' as const,
  required: false,
  mandatory: false,
  sortOrder: 0,
};

/**
 * Minimal immutable runtime snapshot fixture carrying the fields the pure
 * `resolveTargetsFromSnapshot` path reads (config curationTargets,
 * snapshot.curationTargets, productTypes). Cast: the snapshot type has many
 * unrelated required fields this pure test never touches.
 */
function makeSnapshot(
  productTypes: Array<{ id: string; name: string }>,
  curationTargets: unknown[] = [PRODUCT_TYPE_TARGET],
): RuntimeClassificationSnapshot {
  const config = {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '', updatedAt: '', fileVersions: {} },
    productTypes,
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    curationTargets,
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
  return {
    schemaVersion: 1,
    snapshotHash: 's'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceId: 'ws-test',
    workspacePath: '/tmp/ws-test',
    productSku: 'SKU-1',
    configAuthorityKind: 'v1',
    sourceCatalogCommit: null,
    config,
    configSnapshotRef: { id: 'cfg', hash: 's'.repeat(64), sourceCommit: null, createdAt: '2026-01-01T00:00:00.000Z' },
    focusedFileHashes: {},
    catalogEvidenceHash: null,
    productTypes,
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    guidance: [],
    brands: [],
    modelPolicy: config.modelPolicy,
    dataSharing: config.dataSharing,
    curationTargets,
    fieldOptions: {},
    reviewedFacts: [],
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    sourceProductHash: null,
    searchKeywords: null,
    productPageNames: [],
    pageImportId: null,
    pageImportHash: null,
    pageContextReliability: 'low',
  } as unknown as RuntimeClassificationSnapshot;
}

/** Frozen `execution-evidence-v1` member with the frozen evidence-stage inputs. */
function makeMemberProjection(opts: {
  itemId?: string;
  sku?: string | null;
  name?: string;
  expectedName?: string | null;
  brand?: string | null;
} = {}): ExecutionEvidenceProjectionMemberV1 {
  const name = opts.name ?? 'Purina Pro Plan Dry Dog Food Chicken 5 lb';
  const brand = opts.brand ?? 'Purina';
  const itemId = opts.itemId ?? 'item-1';
  const sku = opts.sku ?? itemId;
  return {
    onboardingItemId: itemId,
    ordinal: 1,
    productSku: sku,
    extractionComplete: true,
    sourceUrl: 'https://brand.example.com/p1',
    extractionSourceUrl: 'https://brand.example.com/p1',
    sourcingDecision: null,
    spreadsheetIdentity: {
      name,
      expectedName: opts.expectedName ?? null,
      brandHint: brand,
      departmentHint: null,
      price: null,
      quantity: null,
      rowNumber: 1,
      upc: sku ?? '',
    },
    extraction: {
      title: name,
      description: 'Complete and balanced nutrition for adult dogs.',
      brand,
      weight: '5 lb',
      bulletPoints: ['First ingredient chicken', 'Made in the USA'],
      searchKeywords: 'kibble dog food',
      primaryImage: 'https://img.example.com/p1.jpg',
      additionalImages: ['https://img.example.com/p1a.jpg'],
      customFields: { Flavor: 'Chicken' },
      fieldProvenance: { title: 'json-ld' },
      manualEvidenceAttestationId: null,
      manualReferenceUrl: null,
      packagingTitle: null,
      ocr: {
        outcome: null,
        packagingOcrData: null,
        ocrInputHash: '0'.repeat(64),
        ocrExecutionDigest: null,
      },
      piEvidence: [],
      piImportComplete: true,
    },
    evidenceHash: 'e'.repeat(64),
  };
}

/** Recompute the ocrInputHash for the member's own frozen input set and attach settled OCR. */
function withSettledOcr(
  member: ExecutionEvidenceProjectionMemberV1,
  ocrData: Record<string, unknown>,
  opts: { ocrExecutionDigest?: string | null } = {},
): ExecutionEvidenceProjectionMemberV1 {
  const ocrInputHash = hashCanonicalJson({
    sourceUrl: member.sourceUrl,
    extractionSourceUrl: member.extractionSourceUrl,
    primaryImage: member.extraction.primaryImage,
    additionalImages: member.extraction.additionalImages,
  });
  return {
    ...member,
    extraction: {
      ...member.extraction,
      ocr: {
        outcome: { status: 'succeeded', localStatus: 'succeeded', model: 'test-vlm', imageCount: 1 },
        packagingOcrData: ocrData as never,
        ocrInputHash,
        ocrExecutionDigest: opts.ocrExecutionDigest === undefined ? 'd'.repeat(64) : opts.ocrExecutionDigest,
      },
    },
  };
}

function makeProjection(members: ExecutionEvidenceProjectionMemberV1[]): ExecutionEvidenceProjectionV1 {
  return {
    version: 'execution-evidence-v1',
    cohortId: 'cohort-1',
    batchId: 'batch-1',
    groupingVersion: 'product-family-v1',
    members,
  };
}

function memberInput(
  projection: ExecutionEvidenceProjectionMemberV1,
  productTypes: Array<{ id: string; name: string }>,
  curationTargets?: unknown[],
  reviewedTypeId?: string | null,
): CohortMemberInput {
  return {
    projection,
    memberSnapshot: makeSnapshot(productTypes, curationTargets),
    ...(reviewedTypeId !== undefined ? { reviewedTypeId } : {}),
  };
}

function coherentResults(typeIds: string[]): PerMemberProductTypeResult[] {
  return typeIds.map((typeId, index) => ({
    onboardingItemId: `item-${index + 1}`,
    productSku: `SKU-${index + 1}`,
    productTypeId: typeId,
    confidence: 0.8,
    source: 'keyword' as const,
    reviewedTypeId: null,
    inferredTypeId: null,
    isAbstention: false,
    supportingEvidenceIds: [`ev-${index + 1}`],
    contradictingEvidenceIds: [],
  }));
}

// ─── C3a: evidenceFromProjection ──────────────────────────────────────────────

describe('evidenceFromProjection', () => {
  it('maps spreadsheet + extraction + OCR fields into evidence records with no DB/model side effects', () => {
    const base = makeMemberProjection({ itemId: 'item-shape', sku: 'SKU-SHAPE' });
    base.spreadsheetIdentity.expectedName = 'Purina Dry Dog Food (Expected)';
    const member = withSettledOcr(base, {
      productName: 'Package Dog Food',
      brand: 'Acme',
      species: ['dog'],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      ingredientKeywords: ['kibble'],
      visibleTextLines: ['Line one', 'Line two', ''],
      confidenceByField: { productName: 0.95, weight: 0.5 },
      metadata: { modelCallIds: ['call-1'] },
    });

    const evidence = evidenceFromProjection(member);

    // Spreadsheet identity records.
    expect(evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'name' && e.value === 'Purina Pro Plan Dry Dog Food Chicken 5 lb')).toBe(true);
    expect(evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'expected_name' && e.value === 'Purina Dry Dog Food (Expected)')).toBe(true);
    expect(evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'brand' && e.value === 'Purina')).toBe(true);

    // Normalized extraction records (official product page).
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'name' && e.value === 'Purina Pro Plan Dry Dog Food Chicken 5 lb')).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'brand' && e.value === 'Purina')).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'weight' && e.value === '5 lb')).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'description' && String(e.value).includes('balanced'))).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'bullet_point' && e.value === 'First ingredient chicken')).toBe(true);
    const keywordRecord = evidence.find(e => e.sourceField === 'search_keywords');
    expect(keywordRecord).toBeTruthy();
    expect(keywordRecord!.source).toBe('official_product_page');
    expect(keywordRecord!.reliability).toBe('low');
    expect(evidence.some(e => e.sourceField === 'Flavor' && e.value === 'Chicken' && e.source === 'official_product_page')).toBe(true);

    // Frozen packaging OCR records (shared packagingOcrDataToEvidence mapping).
    const ocrRecords = evidence.filter(e => e.metadata && (e.metadata as Record<string, unknown>).provenance === 'packaging_ocr');
    expect(ocrRecords.length).toBeGreaterThan(0);
    const nameRec = ocrRecords.find(e => e.sourceField === 'name');
    expect(nameRec).toBeTruthy();
    expect(nameRec!.source).toBe('visual_product_evidence');
    expect(nameRec!.value).toBe('Package Dog Food');
    expect(nameRec!.reliability).toBe('high'); // confidenceByField.productName 0.95
    expect(ocrRecords.find(e => e.sourceField === 'brand')!.value).toBe('Acme');
    const flavorRec = ocrRecords.find(e => e.sourceField === 'flavor');
    expect(flavorRec!.attributeId).toBe('flavor');
    expect(flavorRec!.value).toBe('Chicken');
    expect(ocrRecords.find(e => e.sourceField === 'weight')!.reliability).toBe('medium'); // confidence 0.5
    expect(ocrRecords.find(e => e.sourceField === 'ingredientKeyword')!.reliability).toBe('low');
    expect(ocrRecords.filter(e => e.sourceField === 'visible_text')).toHaveLength(2); // blank line skipped
    for (const rec of ocrRecords) {
      const metadata = rec.metadata as Record<string, unknown>;
      expect(metadata.modelCallIds).toEqual(['call-1']);
      expect(metadata.model).toBe('test-vlm');
    }

    // Record envelope: every record carries id/runId/stageName/productSku/capturedAt.
    for (const rec of evidence) {
      expect(rec.id.length).toBeGreaterThan(0);
      expect(rec.runId).toBe('');
      expect(rec.productSku).toBe('SKU-SHAPE');
      expect(rec.stageName).toBe('evidence_extraction');
      expect(rec.capturedAt.length).toBeGreaterThan(0);
    }

    // runId/productSku overrides stamp the produced records.
    const stamped = evidenceFromProjection(member, { runId: 'run-1', productSku: 'SKU-X' });
    expect(stamped.every(e => e.runId === 'run-1' && e.productSku === 'SKU-X')).toBe(true);
  });

  it('P2-T1 equivalence: frozen OCR materialization exactly equals the shared packagingOcrDataToEvidence output (deleted mirror now delegated)', () => {
    const ocrFixture = {
      productName: 'Equivalence Dog Food',
      brand: 'Acme',
      species: ['dog'],
      flavorVariety: 'Chicken & Rice',
      color: 'blue',
      material: 'steel',
      size: 'large',
      weight: '5 lb',
      count: '2 pack',
      lifeStage: 'adult',
      breedSize: 'all',
      productForm: 'kibble',
      healthConcernFunction: ['joint support'],
      dietaryLabels: ['grain-free'],
      ingredientKeywords: ['chicken', ''],
      visibleTextLines: ['line-1', '', 'line-3', 'line-4'], // >3 lines: only the first 3 are considered, blanks skipped
      ingredients: ['', 'chicken meal'],
      claims: ['vet approved'],
      confidenceByField: { productName: 0.95, brand: 0.8, species: 0.55, flavorVariety: null, ingredientKeywords: 0.2 },
      metadata: { modelCallIds: ['call-eq'] }, // durable call ids ride ON the frozen OCR record
    };

    // The shared pure converter's output for this fixture...
    const expected = packagingOcrDataToEvidence(ocrFixture as never, {
      runId: 'run-eq',
      sku: 'SKU-EQ',
      model: 'test-vlm',
      modelCallIds: ['call-eq'],
    });

    // ...must EXACTLY equal the resolver's frozen-OCR materialization under
    // identical params — proving the former mirrored copy is replaced by
    // delegation to one shared implementation, not a second mapping.
    const member = withSettledOcr(makeMemberProjection({ sku: 'SKU-EQ' }), ocrFixture);
    const evidence = evidenceFromProjection(member, { runId: 'run-eq', productSku: 'SKU-EQ' });
    const stripVolatile = (records: ReturnType<typeof evidenceFromProjection>) =>
      records.map(({ id: _id, capturedAt: _capturedAt, ...rest }) => rest);
    const actual = stripVolatile(
      evidence.filter(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr'),
    );
    expect(actual).toEqual(stripVolatile(expected));

    // Representative-mapping spot checks across all reliability bands.
    const bySourceField = new Map(actual.map(r => [r.sourceField, r]));
    expect(bySourceField.get('name')!.reliability).toBe('high'); // confidence 0.95
    expect(bySourceField.get('flavor')!.reliability).toBe('medium'); // null confidence -> fallback 'medium'
    expect(bySourceField.get('ingredientKeyword')!.reliability).toBe('low'); // confidence 0.2
    expect(actual.filter(r => r.sourceField === 'visible_text')).toHaveLength(2); // blank line skipped within first-3 window
    for (const rec of actual) {
      expect((rec.metadata as Record<string, unknown>).model).toBe('test-vlm');
      expect((rec.metadata as Record<string, unknown>).modelCallIds).toEqual(['call-eq']);
    }
  });

  it('fails closed: OCR is never materialized on input-hash mismatch or a missing execution digest', () => {
    const member = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' });

    // primaryImage changed AFTER the input hash was computed — the stored OCR
    // belongs to different inputs and is never materialized.
    const tampered = {
      ...member,
      extraction: { ...member.extraction, primaryImage: 'https://img.example.com/changed.jpg' },
    };
    const tamperedEvidence = evidenceFromProjection(tampered);
    expect(tamperedEvidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr')).toBe(false);

    // Pre-hardening projection without an execution-authority digest
    // (ocrExecutionDigest null) is never materialized (fail-closed mirror).
    const unbound = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' }, { ocrExecutionDigest: null });
    const unboundEvidence = evidenceFromProjection(unbound);
    expect(unboundEvidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr')).toBe(false);
  });

  it('PR13 C4: the expected-OCR-digest predicate is the literal contract — an explicitly supplied NULL expected digest rejects OCR entirely (never matches a stored null)', () => {
    const hasOcr = (evidence: ReturnType<typeof evidenceFromProjection>): boolean =>
      evidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr');
    // Stored digest null + expected null → REJECTED (the old predicate matched
    // null === null and blessed unverifiable OCR; the literal contract never does).
    const storedNull = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' }, { ocrExecutionDigest: null });
    expect(hasOcr(evidenceFromProjection(storedNull, { expectedOcrExecutionDigest: null }))).toBe(false);
    // Stored non-null + expected null → REJECTED (null never equals a digest).
    const storedDigest = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' }); // default 'd'.repeat(64)
    expect(hasOcr(evidenceFromProjection(storedDigest, { expectedOcrExecutionDigest: null }))).toBe(false);
    // expected === stored → ACCEPTED (read-only participation under the matching authority).
    expect(hasOcr(evidenceFromProjection(storedDigest, { expectedOcrExecutionDigest: 'd'.repeat(64) }))).toBe(true);
    // A stale stored digest under an EXPECTED digest → REJECTED (PR12 R1 unchanged).
    expect(hasOcr(evidenceFromProjection(storedDigest, { expectedOcrExecutionDigest: 'other-digest' }))).toBe(false);
    // expected ABSENT → the pre-PR12 non-null check is byte-identical: a
    // non-null stored digest materializes, a stored null does not.
    expect(hasOcr(evidenceFromProjection(storedDigest))).toBe(true);
    expect(hasOcr(evidenceFromProjection(storedNull))).toBe(false);
  });
});

// ─── C3a: matchMemberDeterministically ───────────────────────────────────────

describe('matchMemberDeterministically', () => {
  it('keyword hit: full token overlap returns the matched id with confidence >= floor', () => {
    const evidence = evidenceFromProjection(makeMemberProjection({ name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }));
    const result = matchMemberDeterministically(evidence, [
      { value: 'dry-dog-food', label: 'Dry Dog Food' },
      { value: 'dry-cat-food', label: 'Dry Cat Food' },
    ]);
    expect(result).toEqual({ productTypeId: 'dry-dog-food', confidence: 0.8, source: 'keyword' });
  });

  it('keyword miss: no token overlap returns a null result (no confident match)', () => {
    const evidence = evidenceFromProjection(makeMemberProjection({ name: 'Generic Pet Product 25 lb' }));
    const result = matchMemberDeterministically(evidence, [
      { value: 'dry-dog-food', label: 'Dry Dog Food' },
      { value: 'dry-cat-food', label: 'Dry Cat Food' },
    ]);
    expect(result).toEqual({ productTypeId: null, confidence: null, source: null });
  });

  it('confidence-floor boundary: partial token overlap below KEYWORD_MATCH_MIN_CONFIDENCE returns no match', () => {
    expect(KEYWORD_MATCH_MIN_CONFIDENCE).toBe(0.7);
    // 2/3 label tokens (dry, dog) — score 0.667 -> confidence ~0.683 < 0.7.
    const partial = evidenceFromProjection(makeMemberProjection({ name: 'Purina Dry Dog Biscuit' }));
    const partialResult = matchMemberDeterministically(partial, [{ value: 'dry-dog-food', label: 'Dry Dog Food' }]);
    expect(partialResult).toEqual({ productTypeId: null, confidence: null, source: null });

    // 3/4 label tokens — score 0.75 -> confidence ~0.7125 >= 0.7.
    const fullEnough = evidenceFromProjection(makeMemberProjection({ name: 'Purina Dry Dog Food' }));
    const fullEnoughResult = matchMemberDeterministically(fullEnough, [{ value: 'dry-dog-food', label: 'Dry Dog Food Kibble' }]);
    expect(fullEnoughResult.productTypeId).toBe('dry-dog-food');
    expect(fullEnoughResult.source).toBe('keyword');
    expect(fullEnoughResult.confidence).toBeCloseTo(0.7125, 4);
  });

  it('empty options -> null result (member abstains)', () => {
    const evidence = evidenceFromProjection(makeMemberProjection());
    expect(matchMemberDeterministically(evidence, [])).toEqual({ productTypeId: null, confidence: null, source: null });
  });
});

// ─── C3b: resolveCohortProductType ───────────────────────────────────────────

describe('resolveCohortProductType', () => {
  it('coherent: all confident members agree on one id with min(confidences)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food Kibble 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    // Member A: 4/4 tokens -> 0.8; Member B: 3/4 tokens -> 0.7125.
    expect(resolution.confidence).toBeCloseTo(0.7125, 4);
    expect(resolution.memberSupport).toEqual({ confidentCount: 2, memberCount: 2 });
    expect(resolution.contradictingEvidenceIds).toEqual([]);
    expect(resolution.supportingEvidenceIds.length).toBeGreaterThan(0);
    expect(resolution.perMember).toHaveLength(2);
    expect(resolution.perMember.every(m => !m.isAbstention && m.productTypeId === 'dry-dog-food')).toBe(true);
  });

  it('conflicted: >=2 confident distinct ids — never picks an id', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), TYPE_PRODUCT_TYPES),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Pro Plan Dry Cat Food 5 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('conflicted');
    if (resolution.outcome !== 'conflicted') return;
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.confidence).toBeNull();
    expect(resolution.memberSupport).toEqual({ confidentCount: 2, memberCount: 2 });
    // Each side's evidence contradicts the other's — the union is never empty.
    expect(resolution.contradictingEvidenceIds.length).toBeGreaterThan(0);
    const distinctIds = new Set(resolution.perMember.map(m => m.productTypeId));
    expect(distinctIds.size).toBe(2);
  });

  it('abstained: no confident match across members', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Generic Pet Product 25 lb' }), TYPE_PRODUCT_TYPES),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Generic Pet Product 30 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    if (resolution.outcome !== 'abstained') return;
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.confidence).toBeNull();
    expect(resolution.supportingEvidenceIds).toEqual([]);
    expect(resolution.memberSupport).toEqual({ confidentCount: 0, memberCount: 2 });
    expect(resolution.perMember.every(m => m.isAbstention)).toBe(true);
  });

  it('coherent_with_abstentions: >=1 confident match + >=1 abstainer, no contradiction (DECISION-C)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), TYPE_PRODUCT_TYPES),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Generic Pet Product 25 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('coherent_with_abstentions');
    if (resolution.outcome !== 'coherent_with_abstentions') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    expect(resolution.confidence).toBe(0.8);
    expect(resolution.memberSupport).toEqual({ confidentCount: 1, memberCount: 2 });
    expect(resolution.contradictingEvidenceIds).toEqual([]);
    expect(resolution.perMember[0].isAbstention).toBe(false);
    expect(resolution.perMember[1].isAbstention).toBe(true);
  });

  it('below confidenceFloor counts as abstain (raw match stays visible)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.75,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food Kibble 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
      ],
    });
    // Member B matches at 0.7125 — above the matcher floor (0.7) but below the
    // caller floor (0.75) — so it counts as an abstention.
    expect(resolution.outcome).toBe('coherent_with_abstentions');
    if (resolution.outcome !== 'coherent_with_abstentions') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    expect(resolution.confidence).toBeCloseTo(0.8, 4);
    expect(resolution.memberSupport).toEqual({ confidentCount: 1, memberCount: 2 });
    const memberB = resolution.perMember[1];
    expect(memberB.isAbstention).toBe(true);
    expect(memberB.productTypeId).toBe('dry-dog-food');
    expect(memberB.confidence).toBeCloseTo(0.7125, 4);
    expect(memberB.source).toBe('keyword');
    expect(memberB.supportingEvidenceIds).toEqual([]);
  });

  it('abstained when every confident match is below the floor', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.85,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food Kibble 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.memberSupport).toEqual({ confidentCount: 0, memberCount: 2 });
    expect(resolution.perMember.every(m => m.isAbstention)).toBe(true);
  });

  it('empty member list resolves to abstained', () => {
    const resolution = resolveCohortProductType({ confidenceFloor: 0.7, members: [] });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.memberSupport).toEqual({ confidentCount: 0, memberCount: 0 });
    expect(resolution.perMember).toEqual([]);
  });

  it('resolveTargetsFromSnapshot path: options come from the frozen member snapshot', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
  });

  it('member without an enabled product-type target abstains (no options resolved)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food 5 lb' }), [], []),
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.perMember[0].isAbstention).toBe(true);
    expect(resolution.perMember[0].productTypeId).toBeNull();
  });

  it('LLM label result maps to the canonical option VALUE (BLOCKER fix): a label id never reaches the aggregation as an id', () => {
    // Deterministic match absent (neutral evidence) -> the LLM fallback is
    // applied. llmRankOptions returns the option LABEL 'Dry Dog Food'; the
    // member result must carry the canonical VALUE 'dry-dog-food' so a
    // deterministic+LLM mix matching the same type is coherent, never falsely
    // conflicted.
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        // LLM member: neutral evidence, LLM picks the 'Dry Dog Food' LABEL.
        memberInput(makeMemberProjection({ itemId: 'item-llm', name: 'Purina Pro Plan Dog Food Chicken 5 lb' }), TYPE_PRODUCT_TYPES),
        // Deterministic member: 'dry' present -> confident keyword match.
        memberInput(makeMemberProjection({ itemId: 'item-kw', name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }), TYPE_PRODUCT_TYPES),
      ],
      memberLlmResults: [
        { productTypeId: 'Dry Dog Food', confidence: 0.8 },
        null,
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    // The persisted id is the canonical value, never the display label.
    expect(resolution.productTypeId).toBe('dry-dog-food');
    expect(resolution.confidence).toBeCloseTo(0.8, 4);
    const llmMember = resolution.perMember[0];
    expect(llmMember.isAbstention).toBe(false);
    expect(llmMember.productTypeId).toBe('dry-dog-food');
    expect(llmMember.source).toBe('llm');
    expect(resolution.perMember[1].source).toBe('keyword');
    expect(resolution.contradictingEvidenceIds).toEqual([]);
  });

  it('an LLM result whose label maps to NO frozen option abstains (fail closed — never an id from an unknown label)', () => {
    // Deterministic match absent; the LLM returns a label outside the frozen
    // options. The member must abstain rather than contribute a guessed id.
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-llm', name: 'Purina Pro Plan Dog Food Chicken 5 lb' }), TYPE_PRODUCT_TYPES),
      ],
      memberLlmResults: [
        { productTypeId: 'Premium Wet Cat Food', confidence: 0.8 },
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.perMember[0].isAbstention).toBe(true);
    expect(resolution.perMember[0].productTypeId).toBeNull();
  });

  it('an LLM result that already carries the canonical VALUE passes through unchanged', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-llm', name: 'Purina Pro Plan Dog Food Chicken 5 lb' }), TYPE_PRODUCT_TYPES),
      ],
      memberLlmResults: [
        { productTypeId: 'dry-dog-food', confidence: 0.8 },
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    expect(resolution.perMember[0].source).toBe('llm');
    expect(resolution.perMember[0].productTypeId).toBe('dry-dog-food');
  });

  it('SHOULD-FIX: an LLM label matching TWO frozen options (duplicate display labels) abstains — never picks the first', () => {
    // Config validation permits duplicate display labels (warning, not
    // rejection), so a label that matches two frozen options is ambiguous.
    // The member must abstain (fail closed) rather than silently resolve the
    // label to the FIRST option's canonical id.
    const duplicateLabelTypes = [
      { id: 'dry-dog-food', name: 'Dry Dog Food' },
      { id: 'dry-dog-food-supersize', name: 'Dry Dog Food' }, // same label, distinct id
    ];
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        // Neutral evidence → no confident deterministic match → the LLM
        // fallback applies and returns the ambiguous 'Dry Dog Food' LABEL.
        memberInput(makeMemberProjection({ itemId: 'item-llm', name: 'Purina Pro Plan Dog Food Chicken 5 lb' }), duplicateLabelTypes),
      ],
      memberLlmResults: [
        { productTypeId: 'Dry Dog Food', confidence: 0.8 },
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.perMember[0].isAbstention).toBe(true);
    expect(resolution.perMember[0].productTypeId).toBeNull();
    // The ambiguous label never resolved to the first matching option.
    expect(resolution.perMember[0].productTypeId).not.toBe('dry-dog-food');
  });
});

// ─── PR5 hardening (P1-2): reviewed-fact coherence at freeze time ────────────

/** Minimal `primary_product_type` reviewed fact carried in a frozen snapshot. */
function makeTypeFact(productTypeId: string): ReviewedFact {
  return {
    proposalId: 'p-type',
    decisionId: 'd-type',
    runId: 'run-prior',
    workspaceId: 'ws',
    productSku: 'SKU-1',
    proposalType: 'primary_product_type',
    targetId: productTypeId,
    value: { productTypeId },
    configSnapshotHash: 'cfg',
    sourceHash: 'src',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Spread-copy the snapshot fixture with a seeded reviewed type fact (the
 *  resolver's snapshot-derived fallback path). */
function withReviewedFacts(snapshot: RuntimeClassificationSnapshot, typeId: string): RuntimeClassificationSnapshot {
  return { ...snapshot, reviewedFacts: [makeTypeFact(typeId)] } as RuntimeClassificationSnapshot;
}

describe('resolveCohortProductType — reviewed-fact coherence (PR5 hardening P1-2)', () => {
  it('reviewed-vs-reviewed: any two members\' compatible reviewed types differ -> conflicted (both reviewed ids visible)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        // Both members abstain at inference (neutral evidence) — the reviewed
        // types alone disagree, which is enough for a family conflict.
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Generic Pet Product 25 lb' }), TYPE_PRODUCT_TYPES, undefined, 'dog-treats'),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Generic Pet Product 30 lb' }), TYPE_PRODUCT_TYPES, undefined, 'dry-dog-food'),
      ],
    });
    expect(resolution.outcome).toBe('conflicted');
    if (resolution.outcome !== 'conflicted') return;
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.perMember).toHaveLength(2);
    expect(resolution.perMember[0].reviewedTypeId).toBe('dog-treats');
    expect(resolution.perMember[1].reviewedTypeId).toBe('dry-dog-food');
    expect(resolution.perMember[0].source).toBe('reviewed');
    expect(resolution.perMember[1].source).toBe('reviewed');
    expect(resolution.perMember[0].productTypeId).toBe('dog-treats');
    expect(resolution.perMember[1].productTypeId).toBe('dry-dog-food');
    // Reviewed contributions carry maximum certainty (1.0), never a floor gate.
    expect(resolution.perMember[0].confidence).toBe(1);
    expect(resolution.perMember.every(m => !m.isAbstention)).toBe(true);
    // The reviewed facts drive the disagreement; no inferred evidence exists.
    expect(resolution.contradictingEvidenceIds).toEqual([]);
  });

  it('reviewed-vs-inferred: a reviewed type differing from the cohort\'s confident inferred type -> conflicted (never silently coexist)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        // Member A carries a reviewed dog-treats fact while its OWN evidence
        // confidently infers dry-dog-food.
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), TYPE_PRODUCT_TYPES, undefined, 'dog-treats'),
        // Member B (no reviewed fact) confidently infers dry-dog-food too.
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('conflicted');
    if (resolution.outcome !== 'conflicted') return;
    expect(resolution.productTypeId).toBeNull();
    // The reviewed member still reports its reviewed contribution (source
    // 'reviewed'); the inferred side contributes dry-dog-food.
    expect(resolution.perMember[0].source).toBe('reviewed');
    expect(resolution.perMember[0].productTypeId).toBe('dog-treats');
    expect(resolution.perMember[0].reviewedTypeId).toBe('dog-treats');
    expect(resolution.perMember[1].source).toBe('keyword');
    expect(resolution.perMember[1].productTypeId).toBe('dry-dog-food');
    // The inferred side's evidence contradicts the reviewed type.
    expect(resolution.contradictingEvidenceIds.length).toBeGreaterThan(0);
  });

  it('reviewed-vs-own-inference SINGLE member: the raw inferred id stays visible for conflict diagnostics (never hidden by the reviewed-first projection)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        // One member only: reviewed dog-treats while its OWN evidence
        // confidently infers dry-dog-food. Rule 2 conflicts — the reason must
        // surface BOTH sides even though no sibling exposes the inferred id.
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), TYPE_PRODUCT_TYPES, undefined, 'dog-treats'),
      ],
    });
    expect(resolution.outcome).toBe('conflicted');
    if (resolution.outcome !== 'conflicted') return;
    expect(resolution.productTypeId).toBeNull();
    // Reviewed-first contribution: the member reports reviewed dog-treats.
    expect(resolution.perMember[0].source).toBe('reviewed');
    expect(resolution.perMember[0].productTypeId).toBe('dog-treats');
    expect(resolution.perMember[0].reviewedTypeId).toBe('dog-treats');
    // The RAW inference stays visible for diagnostics.
    expect(resolution.perMember[0].inferredTypeId).toBe('dry-dog-food');
    // The contradicted side's evidence is present.
    expect(resolution.contradictingEvidenceIds.length).toBeGreaterThan(0);
    // Union of contribution + raw inferred ids = both sides.
    const distinct = new Set([
      ...resolution.perMember.filter(m => !m.isAbstention).map(m => m.productTypeId),
      ...resolution.perMember.map(m => m.inferredTypeId).filter((id): id is string => id !== null),
    ]);
    expect([...distinct].sort()).toEqual(['dog-treats', 'dry-dog-food']);
  });

  it('agreement: a reviewed type agreeing with the inferred type -> coherent with member contribution source reviewed', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food' }], undefined, 'dry-dog-food'),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    const reviewedMember = resolution.perMember[0];
    expect(reviewedMember.source).toBe('reviewed');
    expect(reviewedMember.reviewedTypeId).toBe('dry-dog-food');
    expect(reviewedMember.productTypeId).toBe('dry-dog-food');
    expect(reviewedMember.confidence).toBe(1);
    expect(reviewedMember.isAbstention).toBe(false);
    expect(reviewedMember.supportingEvidenceIds).toEqual([]);
    // The inferred sibling still contributes via the keyword matcher; the
    // cohort confidence is min over confident members (0.8 keyword vs 1.0).
    expect(resolution.perMember[1].source).toBe('keyword');
    expect(resolution.confidence).toBeCloseTo(0.8, 4);
    expect(resolution.contradictingEvidenceIds).toEqual([]);
  });

  it('resolution: a reviewed type resolves an otherwise-abstaining member; all members agree -> coherent with that id', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        // Member A has NO confident inference (neutral evidence) but carries a
        // reviewed dog-treats fact — the reviewed type resolves the abstainer.
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Generic Pet Product 25 lb' }), [{ id: 'dog-treats', name: 'Dog Treats' }], undefined, 'dog-treats'),
        // Member B confidently infers dog-treats.
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Pro Plan Dog Treats Beef 10 lb' }), [{ id: 'dog-treats', name: 'Dog Treats' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dog-treats');
    expect(resolution.perMember[0].isAbstention).toBe(false);
    expect(resolution.perMember[0].source).toBe('reviewed');
    expect(resolution.perMember[0].reviewedTypeId).toBe('dog-treats');
    expect(resolution.perMember[0].productTypeId).toBe('dog-treats');
    expect(resolution.perMember[1].source).toBe('keyword');
    expect(resolution.memberSupport).toEqual({ confidentCount: 2, memberCount: 2 });
    expect(resolution.contradictingEvidenceIds).toEqual([]);
  });

  it('snapshot-derived fallback: the reviewed type is read from memberSnapshot.reviewedFacts when the input omits it', () => {
    const projectionA = makeMemberProjection({ itemId: 'item-a', name: 'Generic Pet Product 25 lb' });
    const snapshotA = withReviewedFacts(makeSnapshot([{ id: 'dog-treats', name: 'Dog Treats' }]), 'dog-treats');
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        { projection: projectionA, memberSnapshot: snapshotA },
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Pro Plan Dog Treats Beef 10 lb' }), [{ id: 'dog-treats', name: 'Dog Treats' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dog-treats');
    expect(resolution.perMember[0].source).toBe('reviewed');
    expect(resolution.perMember[0].reviewedTypeId).toBe('dog-treats');
  });

  it('a reviewed member without any sibling still contributes its reviewed type (single-member resolution)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Generic Pet Product 25 lb' }), [{ id: 'dog-treats', name: 'Dog Treats' }], undefined, 'dog-treats'),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dog-treats');
    expect(resolution.confidence).toBe(1);
    expect(resolution.perMember[0].source).toBe('reviewed');
    expect(resolution.perMember[0].reviewedTypeId).toBe('dog-treats');
    expect(resolution.perMember[0].isAbstention).toBe(false);
  });
});

// ─── C3b: validateCohortFamilyInvariants ─────────────────────────────────────

describe('validateCohortFamilyInvariants', () => {
  const BRANDS: BrandConfig[] = [
    { id: 'acme', name: 'Acme', aliases: ['Acme Pet'], oldIdAliases: [] },
    { id: 'blue-buffalo', name: 'Blue Buffalo', aliases: [], oldIdAliases: [] },
  ];

  it('brand disagreement finding via shared canonical brand resolution', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Blue Buffalo' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      BRANDS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].invariant).toBe('brand');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].kind).toBe('disagreement');
    expect(findings[0].values).toEqual(['acme', 'blue-buffalo']);
    expect(findings[0].memberIds).toEqual(['item-1', 'item-2']);
  });

  it('brand aliases canonicalize to the same brand — no finding', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme Pet' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Acme' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      BRANDS,
    );
    expect(findings).toEqual([]);
  });

  it('product type agreement finding (distinct confident ids)', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Acme' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-cat-food']),
      BRANDS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].invariant).toBe('product_type');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].values).toEqual(['dry-dog-food', 'dry-cat-food']);
    expect(findings[0].memberIds).toEqual(['item-1', 'item-2']);
  });

  it('empty findings when the family is coherent (same type, same canonical brand)', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Acme' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      BRANDS,
    );
    expect(findings).toEqual([]);
  });

  it('without configured canonical brands, raw normalized brand strings keep the mismatch visible', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Blue Buffalo' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].invariant).toBe('brand');
    expect(findings[0].values).toEqual(['unresolved:acme', 'unresolved:blue buffalo']);
  });
});

describe('Milestone E — distributor_record evidence (source labeling + identity-only)', () => {
  /** A V2 member with distributor provenance (the exact V2 shape cohorts.ts adds). */
  function distributorMember(): ExecutionEvidenceProjectionMemberV2 {
    const base = makeMemberProjection();
    return {
      ...base,
      version: 'execution-evidence-v2',
      itemSourceType: 'distributor_record',
      extractionSourceType: 'distributor_record',
      extractionMethod: 'distributor_record_v1',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: ['att-1'],
      acceptedProviderIds: ['phillips'],
      distributorEvidenceHash: 'a'.repeat(64),
      extraction: {
        ...base.extraction,
        distributorSku: 'DSKU-1',
        manufacturerPartNumber: 'MPN-1',
        variantAttributes: { flavor: 'chicken' },
        distributorCategory: null,
        dimensions: null,
        casePack: null,
        unitOfMeasure: null,
        ingredients: null,
        merchandisingProvenance: {},
        distributorReferenceValues: {},
      },
    } as ExecutionEvidenceProjectionMemberV2;
  }

  it('labels distributor evidence as distributor_record with a null URL and provenance metadata', () => {
    const evidence = evidenceFromProjection(distributorMember());
    const page = evidence.filter((e) => e.source === 'distributor_record');
    expect(page.length).toBeGreaterThan(0);
    for (const entry of page) {
      expect(entry.source).toBe('distributor_record');
      expect(entry.sourceUrl).toBeNull();
      // provenance metadata: sorted attempt/provider ids + generation + hash
      expect(entry.metadata).toMatchObject({
        provenance: 'distributor_record',
        providerIds: ['phillips'],
        acceptedEvidenceAttemptIds: ['att-1'],
        sourcingGenerationId: 'gen-1',
        evidenceHash: 'a'.repeat(64),
      });
    }
  });

  it('never labels distributor evidence official_product_page', () => {
    const evidence = evidenceFromProjection(distributorMember());
    const official = evidence.filter((e) => e.source === 'official_product_page');
    expect(official).toHaveLength(0);
  });

  it('emits ONLY identity fields for distributor evidence (no description/bullets/searchKeywords/customFields)', () => {
    const evidence = evidenceFromProjection(distributorMember());
    const page = evidence.filter((e) => e.source === 'distributor_record');
    const fields = page.map((e) => e.sourceField);
    // identity-only: name/brand/weight present
    expect(fields).toContain('name');
    expect(fields).toContain('brand');
    expect(fields).toContain('weight');
    // Milestone E review: distributor identity evidence ALSO carries the
    // frozen distributor SKU, MPN, and whitelisted variant attributes.
    expect(fields).toContain('distributor_sku');
    expect(fields).toContain('manufacturer_part_number');
    expect(fields).toContain('flavor');
    expect(page.some((e) => e.sourceField === 'distributor_sku' && e.value === 'DSKU-1')).toBe(true);
    expect(page.some((e) => e.sourceField === 'manufacturer_part_number' && e.value === 'MPN-1')).toBe(true);
    expect(page.some((e) => e.sourceField === 'flavor' && e.value === 'chicken')).toBe(true);
    // per-field provenance rides the metadata
    expect(page[0].metadata).toMatchObject({ fieldProvenance: expect.any(Object) });
    // copy fields never appear
    expect(fields).not.toContain('description');
    expect(fields).not.toContain('bullet_point');
    expect(fields).not.toContain('search_keywords');
    expect(fields).not.toContain('Flavor'); // customFields are excluded
    // no image fields
    const all = evidence.filter((e) => String(e.value).includes('img.example.com'));
    expect(all).toHaveLength(0);
  });

  it('v2 distributor members mirror merchandising fields exactly like the evidence stage (Amendment B)', () => {
    const member = distributorMember();
    (member as { extractionMethod: string }).extractionMethod = 'distributor_record_v2';
    (member.extraction as Record<string, unknown>).description = 'Mirrored distributor description';
    (member.extraction as Record<string, unknown>).bulletPoints = ['Mirrored feature one', 'Mirrored feature two'];
    (member.extraction as Record<string, unknown>).distributorCategory = 'Dog Supplies';
    (member.extraction as Record<string, unknown>).dimensions = '12 x 8 x 4 in';
    (member.extraction as Record<string, unknown>).casePack = '6';
    (member.extraction as Record<string, unknown>).unitOfMeasure = 'EA';
    (member.extraction as Record<string, unknown>).ingredients = 'Chicken, rice';
    (member.extraction as Record<string, unknown>).merchandisingProvenance = {
      description: [{ attemptId: 'att-1', providerId: 'phillips', catalogVersion: 'v1', connectionId: 'c1', values: ['Mirrored distributor description'] }],
    };
    const evidence = evidenceFromProjection(member);
    const merch = evidence.filter((e) => e.source === 'distributor_record');
    const fields = merch.map((e) => e.sourceField);
    // SAME field mapping as the frozen evidence stage: description, each
    // feature as bullet_point, distributor_category, dimensions, case_pack,
    // unit_of_measure, ingredients.
    expect(fields).toContain('description');
    expect(fields).toContain('bullet_point');
    expect(fields).toContain('distributor_category');
    expect(fields).toContain('dimensions');
    expect(fields).toContain('case_pack');
    expect(fields).toContain('unit_of_measure');
    expect(fields).toContain('ingredients');
    expect(merch.filter((e) => e.sourceField === 'bullet_point').map((e) => e.value)).toEqual(['Mirrored feature one', 'Mirrored feature two']);
    expect(merch.find((e) => e.sourceField === 'description')!.value).toBe('Mirrored distributor description');
    expect(merch.find((e) => e.sourceField === 'description')!.sourceUrl).toBeNull();
    expect((merch.find((e) => e.sourceField === 'description')!.metadata as any).merchandisingProvenance.description[0].providerId).toBe('phillips');
    // never official label; price/inventory/images never mirrored
    expect(evidence.some((e) => e.source === 'official_product_page')).toBe(false);
    expect(fields).not.toContain('price');
    expect(fields).not.toContain('inventory');
    expect(fields).not.toContain('primaryImage');
  });

  it('official-page members keep the full copy mapping and official label', () => {
    const evidence = evidenceFromProjection(makeMemberProjection());
    const official = evidence.filter((e) => e.source === 'official_product_page');
    const fields = official.map((e) => e.sourceField);
    expect(fields).toContain('description');
    expect(fields).toContain('bullet_point');
    expect(fields).toContain('search_keywords');
    expect(official.some((e) => e.sourceUrl === 'https://brand.example.com/p1')).toBe(true);
  });
});
