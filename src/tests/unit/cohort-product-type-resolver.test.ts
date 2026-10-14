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
import { packagingOcrDataToEvidence } from '../../classification/ocr-evidence';

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
    expect(nameRec!.reliability).toBe('medium'); // A3: self-reported 0.95 caps at medium before corroboration
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
    expect(bySourceField.get('name')!.reliability).toBe('medium'); // A3: self-reported 0.95 caps at medium before corroboration
    expect(bySourceField.get('flavor')!.reliability).toBe('medium'); // null confidence -> fallback 'medium'
    expect(bySourceField.get('ingredientKeyword')!.reliability).toBe('low'); // confidence 0.2
    expect(actual.filter(r => r.sourceField === 'visible_text')).toHaveLength(3); // A3: relevance-ranked 8-line window (was first-3)
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

// REMOVED (issue #351): aggregation/family-invariant block deleted with the resolver aggregation.


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
