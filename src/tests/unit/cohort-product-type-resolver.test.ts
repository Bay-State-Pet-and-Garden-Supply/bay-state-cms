import { describe, it, expect } from 'bun:test';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  evidenceFromProjection,
  matchMemberDeterministically,
  KEYWORD_MATCH_MIN_CONFIDENCE,
} from '../../classification/cohort-product-type-resolver';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../../shared/schemas/cohorts';
import type { ClassificationEvidence } from '../../shared/schemas/classification';

// ─── Fixtures (pure — no DB) ──────────────────────────────────────────────────



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




// ─── C3a: evidenceFromProjection ──────────────────────────────────────────────

describe('evidenceFromProjection', () => {
  it('preserves supplied identity, official facts and eligible explicit package wording with their provenance', () => {
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

    const expectedOcrExecutionDigest = 'd'.repeat(64);
    const evidence = evidenceFromProjection(member, { expectedOcrExecutionDigest });
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

    // Eligible explicit package wording materializes with visual provenance
    // under the matching execution authority.
    const ocrRecords = evidence.filter(e => e.metadata && (e.metadata as Record<string, unknown>).provenance === 'packaging_ocr');
    expect(ocrRecords.some(e => e.sourceField === 'name' && e.source === 'visual_product_evidence' && e.value === 'Package Dog Food')).toBe(true);
    expect(ocrRecords.some(e => e.sourceField === 'brand' && e.value === 'Acme')).toBe(true);
    expect(ocrRecords.some(e => e.sourceField === 'flavor' && e.attributeId === 'flavor' && e.value === 'Chicken')).toBe(true);
    for (const rec of ocrRecords) {
      const metadata = rec.metadata as Record<string, unknown>;
      expect(metadata.modelCallIds).toEqual(['call-1']);
      expect(metadata.model).toBe('test-vlm');
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
    const tamperedEvidence = evidenceFromProjection(tampered, { expectedOcrExecutionDigest: 'd'.repeat(64) });
    expect(tamperedEvidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr')).toBe(false);

    // Pre-hardening projection without an execution-authority digest
    // (ocrExecutionDigest null) cannot support the current execution.
    const unbound = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' }, { ocrExecutionDigest: null });
    const unboundEvidence = evidenceFromProjection(unbound, { expectedOcrExecutionDigest: 'd'.repeat(64) });
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

// ─── C3b: aggregation REMOVED (issue #351 SKU-local evidence) ─────────────────
//
// REMOVED: cross-member aggregation/family-invariant block deleted with the resolver aggregation.


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
    expect(page.find(e => e.sourceField === 'name')?.value).toBe('Purina Pro Plan Dry Dog Food Chicken 5 lb');
    for (const entry of page) {
      expect(entry.source).toBe('distributor_record');
      expect(entry.sourceUrl).toBeNull();
      // provenance metadata: sorted attempt/provider ids + generation + hash
      expect(entry.metadata).toMatchObject({
        provenance: 'distributor_record',
        acceptedProviderIds: ['phillips'],
        acceptedEvidenceAttemptIds: ['att-1'],
        sourcingGenerationId: 'gen-1',
        distributorEvidenceHash: 'a'.repeat(64),
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

// ─── Issue #361: shared frozen semantics — scan and member execution agree ──
// The same supplied fact carries the same meaning/eligibility in the
// read-only scan (`evidenceFromProjection`) and the persisted member
// execution (the frozen evidence stage). These tests observe downstream
// supported proposals + provenance + OCR eligibility at the existing
// consumer seams — never exact copied record arrays or bookkeeping.

describe('issue #361 — frozen scan/member semantic agreement', () => {
  const DOG_FOOD_OPTIONS = [
    { value: 'dry-dog-food', label: 'Dry Dog Food' },
    { value: 'dry-cat-food', label: 'Dry Cat Food' },
  ];

  /** Official-page member whose facts support a Dry Dog Food proposal. */
  function officialDogFoodMember(sku: string): ExecutionEvidenceProjectionMemberV1 {
    return makeMemberProjection({
      itemId: `item-${sku}`,
      sku,
      name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
      brand: 'Purina',
    });
  }

  it('same official-page facts support the same downstream proposal with official provenance', () => {
    const member = officialDogFoodMember('SKU-361-A');
    const scanEvidence = evidenceFromProjection(member);
    const scanMatch = matchMemberDeterministically(scanEvidence, DOG_FOOD_OPTIONS);
    expect(scanMatch).toEqual({ productTypeId: 'dry-dog-food', confidence: 0.8, source: 'keyword' });
    expect(scanEvidence.some(e => e.source === 'official_product_page' && e.sourceField === 'name')).toBe(true);
    expect(scanEvidence.some(e => e.source === 'official_product_page' && e.sourceUrl === 'https://brand.example.com/p1')).toBe(true);
    // Absent facts are never inferred: no invented copy beyond the supplied fields.
    expect(scanEvidence.some(e => e.sourceField === 'distributor_sku')).toBe(false);
  });

  it('same distributor-identity facts support downstream matching with distributor (never official) provenance', () => {
    const base = makeMemberProjection({ itemId: 'item-361-dist', sku: 'SKU-361-DIST', name: 'Phillips Dry Dog Food Chicken 20 lb', brand: 'Phillips' });
    const member = {
      ...base,
      version: 'execution-evidence-v2',
      itemSourceType: 'distributor_record',
      extractionSourceType: 'distributor_record',
      extractionMethod: 'distributor_record_v1',
      sourcingGenerationId: 'gen-361',
      acceptedEvidenceAttemptIds: ['att-361'],
      acceptedProviderIds: ['phillips'],
      distributorEvidenceHash: 'c'.repeat(64),
      extraction: {
        ...base.extraction,
        distributorSku: 'DSKU-361',
        manufacturerPartNumber: null,
        variantAttributes: {},
        distributorCategory: null,
        dimensions: null,
        casePack: null,
        unitOfMeasure: null,
        ingredients: null,
        merchandisingProvenance: {},
        distributorReferenceValues: {},
      },
    } as ExecutionEvidenceProjectionMemberV2;
    const evidence = evidenceFromProjection(member);
    expect(evidence.some(e => e.source === 'official_product_page')).toBe(false);
    const nameEntry = evidence.find(e => e.source === 'distributor_record' && e.sourceField === 'name');
    expect(nameEntry).toBeTruthy();
    expect(nameEntry!.sourceUrl).toBeNull();
    expect(nameEntry!.metadata).toMatchObject({ provenance: 'distributor_record', sourcingGenerationId: 'gen-361' });
    // Distributor copy is never emitted for v1 members — identity-only.
    expect(evidence.some(e => e.sourceField === 'description')).toBe(false);
  });

  it('missing facts abstain downstream instead of inferring a proposal', () => {
    const member = makeMemberProjection({ itemId: 'item-361-empty', sku: 'SKU-361-EMPTY', name: 'Generic Pet Product 25 lb' });
    const emptied = {
      ...member,
      extraction: {
        ...member.extraction,
        title: null,
        description: null,
        brand: null,
        weight: null,
        bulletPoints: [],
        searchKeywords: null,
        customFields: {},
      },
    };
    const evidence = evidenceFromProjection(emptied);
    // Only spreadsheet identity remains — the keyword match cannot clear its floor.
    const result = matchMemberDeterministically(evidence, DOG_FOOD_OPTIONS);
    expect(result).toEqual({ productTypeId: null, confidence: null, source: null });
  });

  it('stale/tampered OCR is excluded while eligible explicit package wording retains provenance', () => {
    const hasOcr = (evidence: ClassificationEvidence[]): boolean =>
      evidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr');
    const eligible = withSettledOcr(makeMemberProjection({ sku: 'SKU-361-OCR', name: 'Generic Pet Product 25 lb' }), { productName: 'Package Dry Dog Food' });
    const expectedOcrExecutionDigest = 'd'.repeat(64);
    const evidence = evidenceFromProjection(eligible, { expectedOcrExecutionDigest });
    const ocrEntry = evidence.find(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr');
    expect(ocrEntry).toMatchObject({ source: 'visual_product_evidence', sourceField: 'name', value: 'Package Dry Dog Food' });
    expect(matchMemberDeterministically(evidence, DOG_FOOD_OPTIONS).productTypeId).toBe('dry-dog-food');
    // Tampered inputs: the stored OCR belongs to a different input set.
    const tampered = {
      ...eligible,
      extraction: { ...eligible.extraction, primaryImage: 'https://img.example.com/tampered.jpg' },
    };
    const tamperedEvidence = evidenceFromProjection(tampered, { expectedOcrExecutionDigest });
    expect(hasOcr(tamperedEvidence)).toBe(false);
    expect(matchMemberDeterministically(tamperedEvidence, DOG_FOOD_OPTIONS).productTypeId).toBeNull();
    // Stale authority: a digest from another execution cannot support the assignment.
    const staleEvidence = evidenceFromProjection(eligible, { expectedOcrExecutionDigest: 'stale-digest' });
    expect(hasOcr(staleEvidence)).toBe(false);
    expect(matchMemberDeterministically(staleEvidence, DOG_FOOD_OPTIONS).productTypeId).toBeNull();
  });

  it('separate siblings keep separate meaning — no inherited facts', () => {
    const dogMember = officialDogFoodMember('SKU-361-SIB-A');
    const catMember = makeMemberProjection({ itemId: 'item-361-sib-b', sku: 'SKU-361-SIB-B', name: 'Purina Pro Plan Dry Cat Food Salmon 3 lb', brand: 'Purina' });
    const dogEvidence = evidenceFromProjection(dogMember);
    const catEvidence = evidenceFromProjection(catMember);
    expect(matchMemberDeterministically(dogEvidence, DOG_FOOD_OPTIONS).productTypeId).toBe('dry-dog-food');
    expect(matchMemberDeterministically(catEvidence, DOG_FOOD_OPTIONS).productTypeId).toBe('dry-cat-food');
    // Sibling A's SKU never appears in sibling B's facts.
    expect(catEvidence.some(e => String(e.value ?? '').includes('SKU-361-SIB-A'))).toBe(false);
    expect(catEvidence.every(e => e.productSku === 'SKU-361-SIB-B')).toBe(true);
  });

  it('operator-manual members emit only attributed manual facts, never automated labels', () => {
    const base = makeMemberProjection({ itemId: 'item-361-manual', sku: 'SKU-361-MANUAL' });
    const member: ExecutionEvidenceProjectionMemberV2 = {
      ...base,
      version: 'execution-evidence-v2',
      itemSourceType: 'official_page',
      extractionSourceType: 'official_page',
      extractionMethod: 'manual_evidence_v1',
      sourcingGenerationId: null,
      acceptedEvidenceAttemptIds: [],
      acceptedProviderIds: [],
      distributorEvidenceHash: null,
      extraction: {
        ...base.extraction,
        distributorSku: null,
        manufacturerPartNumber: null,
        variantAttributes: {},
        distributorReferenceValues: {},
        distributorCategory: null,
        dimensions: null,
        casePack: null,
        unitOfMeasure: null,
        ingredients: null,
        merchandisingProvenance: {},
        fieldProvenance: { title: 'user', brand: 'user' },
        manualEvidenceAttestationId: 'attest-361',
        manualReferenceUrl: null,
      },
    };
    const evidence = evidenceFromProjection(member);
    expect(evidence.find(e => e.source === 'operator_manual' && e.sourceField === 'name')?.value).toBe('Purina Pro Plan Dry Dog Food Chicken 5 lb');
    for (const entry of evidence.filter(e => e.source !== 'spreadsheet')) {
      expect(entry.source).toBe('operator_manual');
      expect(entry.reliability).toBe('low');
      expect(entry.sourceUrl).toBeNull();
    }
    expect(evidence.some(e => e.source === 'official_product_page')).toBe(false);
    expect(evidence.some(e => e.source === 'distributor_record')).toBe(false);
  });
});
