// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ReviewQueueRowSchema,
  ReviewFamilySummarySchema,
  ProjectionHealthSchema,
  ProjectionHealthIssueSchema,
  ReviewQueueCountsSchema,
  ReviewQueueFiltersSchema,
  ReviewQueuePageSchema,
  ReviewQueueStatusTotalsSchema,
  ReviewQueueProgressSchema,
  ReviewQueueCursorError,
  encodeReviewQueueCursor,
  decodeReviewQueueCursor,
  validateReviewQueueCursor,
  computeReviewQueueFilterHash,
  deriveReviewGateStatus,
  buildReviewQueueSortKey,
  type ReviewQueueRow,
  type ReviewQueueFilters,
} from '../../shared/schemas/onboarding-review-queue';

describe('Adversarial Schema Stress Tests', () => {
  const baseValidRow = {
    itemId: 'item-adv-100',
    upc: '012345678905',
    displayTitle: 'Blue Buffalo Life Protection Chicken 30lb',
    brand: 'Blue Buffalo',
    sourceType: 'official_page' as const,
    imageUrl: 'https://images.example.com/item-adv-100.jpg',
    family: {
      cohortId: 'cohort-100',
      label: 'Life Protection Formula',
      memberCount: 5,
      readyCount: 4,
      blockedCount: 1,
    },
    reviewState: 'unreviewed' as const,
    sortKey: '0:blue buffalo life protection chicken 30lb                :item-adv-100',
    updatedAt: '2026-09-01T12:00:00.000Z',
    warningCodes: ['name_from_fallback_source'],
    hasWarnings: true,
    reviewGateStatus: 'ready' as const,
  };

  it('verifies base row is valid', () => {
    const parsed = ReviewQueueRowSchema.parse(baseValidRow);
    expect(parsed.itemId).toBe('item-adv-100');
  });

  it('validates additive command context while rejecting injected authority and malformed totals', () => {
    const actions = { canCompleteReview: true, canApprove: false, canEdit: true };
    expect(ReviewQueueRowSchema.safeParse({ ...baseValidRow, stage: 'review_listings', stageStatus: 'completed', actions }).success).toBe(true);
    expect(ReviewQueueRowSchema.safeParse({ ...baseValidRow, actions: { ...actions, bypassGate: true } }).success).toBe(false);
    expect(ReviewQueueRowSchema.safeParse({ ...baseValidRow, actions: { ...actions, canApprove: 'true' } }).success).toBe(false);
    expect(ReviewQueueRowSchema.safeParse({ ...baseValidRow, stage: 'review' }).success).toBe(false);
    expect(ReviewQueueStatusTotalsSchema.safeParse({ unreviewed: 3, reviewed: 1, approved: -1 }).success).toBe(false);
    expect(ReviewQueueStatusTotalsSchema.safeParse({ unreviewed: 3, reviewed: 1, approved: 2, total: 6 }).success).toBe(false);
    expect(ReviewQueueProgressSchema.safeParse({ total: 5, reviewed: 3, remaining: 3 }).success).toBe(false);
    expect(ReviewQueueProgressSchema.safeParse({ total: 5, reviewed: 6, remaining: -1 }).success).toBe(false);
  });

  describe('Strict Rejection of Prohibited Detail Blobs and Injected Keys', () => {
    const prohibitedInjections: Array<{ name: string; payload: Record<string, unknown> }> = [
      { name: 'description', payload: { description: 'Full rich HTML description...' } },
      { name: 'curatedDescription', payload: { curatedDescription: '<p>Curated HTML</p>' } },
      { name: 'extraction', payload: { extraction: { rawText: 'Extracted content' } } },
      { name: 'extractionData', payload: { extractionData: { price: '$49.99', specs: {} } } },
      { name: 'ocrData', payload: { ocrData: { lines: ['OCR line 1', 'OCR line 2'] } } },
      { name: 'packagingOcrData', payload: { packagingOcrData: { attempts: [{ text: 'Raw OCR' }] } } },
      { name: 'classificationProposals', payload: { classificationProposals: [{ id: 'prop-1', status: 'pending' }] } },
      { name: 'proposalTrees', payload: { proposalTrees: [{ root: 'node-1' }] } },
      { name: 'variantMatrix', payload: { variantMatrix: { axes: ['size', 'flavor'], candidates: [] } } },
      { name: 'variantResolution', payload: { variantResolution: { status: 'resolved', chosenId: 'var-1' } } },
      { name: 'sourceHtml', payload: { sourceHtml: '<html><body>Full page dump</body></html>' } },
      { name: 'item (raw model entity)', payload: { item: { id: 'item-adv-100', rawJson: '{}' } } },
      { name: 'rawItem', payload: { rawItem: { unparsed: true } } },
      { name: 'curationData', payload: { curationData: { curatedTitle: 'Title', brandHint: 'Brand' } } },
      { name: 'html', payload: { html: '<div>Unbounded HTML</div>' } },
      { name: 'specs', payload: { specs: { weight: '30lb', color: 'Blue' } } },
      { name: 'attributes', payload: { attributes: [{ key: 'size', value: '30lb' }] } },
      { name: 'metadata', payload: { metadata: { sourceUrl: 'https://example.com' } } },
      { name: 'payload', payload: { payload: { secret: 'data' } } },
      { name: 'details', payload: { details: { full: true } } },
      { name: 'arbitraryInjection', payload: { maliciousExtraField: 'injected_content' } },
    ];

    for (const { name, payload } of prohibitedInjections) {
      it(`strictly rejects row containing injected prohibited field: ${name}`, () => {
        const poisoned = { ...baseValidRow, ...payload };
        const result = ReviewQueueRowSchema.safeParse(poisoned);
        expect(result.success).toBe(false);
        if (!result.success) {
          const issues = result.error.issues;
          expect(issues.some(e => e.code === 'unrecognized_keys')).toBe(true);
        }
      });
    }

    it('strictly rejects simultaneous multi-field injection of prohibited detail blobs', () => {
      const multiPoisoned = {
        ...baseValidRow,
        description: 'Large text',
        curationData: { complex: true },
        extractionData: { price: '20.00' },
        sourceHtml: '<html></html>',
        packagingOcrData: { ocr: true },
      };
      const result = ReviewQueueRowSchema.safeParse(multiPoisoned);
      expect(result.success).toBe(false);
    });
  });

  describe('Nested Schema Strictness and Boundary Constraints', () => {
    it('strictly rejects ReviewFamilySummarySchema with excess properties', () => {
      const familyWithExtra = {
        cohortId: 'cohort-1',
        label: 'Test Cohort',
        memberCount: 2,
        readyCount: 2,
        blockedCount: 0,
        unauthorizedExtraProp: 'forbidden',
      };
      expect(ReviewFamilySummarySchema.safeParse(familyWithExtra).success).toBe(false);
    });

    it('rejects ReviewFamilySummarySchema with negative counts', () => {
      expect(ReviewFamilySummarySchema.safeParse({ cohortId: 'c1', label: null, memberCount: -1, readyCount: 0, blockedCount: 0 }).success).toBe(false);
      expect(ReviewFamilySummarySchema.safeParse({ cohortId: 'c1', label: null, memberCount: 1, readyCount: -1, blockedCount: 0 }).success).toBe(false);
      expect(ReviewFamilySummarySchema.safeParse({ cohortId: 'c1', label: null, memberCount: 1, readyCount: 0, blockedCount: -1 }).success).toBe(false);
    });

    it('strictly rejects ProjectionHealthSchema and ProjectionHealthIssueSchema with excess properties', () => {
      const issueWithExtra = {
        source: 'curation_data_json',
        code: 'corrupt',
        affectedCount: 1,
        injected: 'bad',
      };
      expect(ProjectionHealthIssueSchema.safeParse(issueWithExtra).success).toBe(false);

      const healthWithExtra = {
        status: 'healthy' as const,
        version: '1.0.0',
        computedAt: new Date().toISOString(),
        issues: [],
        injectedHealthProp: true,
      };
      expect(ProjectionHealthSchema.safeParse(healthWithExtra).success).toBe(false);
    });

    it('strictly rejects ReviewQueueCountsSchema with negative values or excess properties', () => {
      expect(ReviewQueueCountsSchema.safeParse({ total: -1 }).success).toBe(false);
      expect(ReviewQueueCountsSchema.safeParse({ total: 10, reviewedTotal: -5 }).success).toBe(false);
      expect(ReviewQueueCountsSchema.safeParse({ total: 10, extraProp: 123 }).success).toBe(false);
    });

    it('strictly rejects ReviewQueueFiltersSchema with unauthorized query filters', () => {
      const filterWithExtra = {
        brand: 'Purina',
        unauthorizedFilter: 'drop table onboarding_items',
      };
      expect(ReviewQueueFiltersSchema.safeParse(filterWithExtra).success).toBe(false);
    });

    it('validates ReviewQueueFilters limit boundary [1, 100]', () => {
      expect(ReviewQueueFiltersSchema.safeParse({ limit: 1 }).success).toBe(true);
      expect(ReviewQueueFiltersSchema.safeParse({ limit: 100 }).success).toBe(true);
      expect(ReviewQueueFiltersSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(ReviewQueueFiltersSchema.safeParse({ limit: 101 }).success).toBe(false);
      expect(ReviewQueueFiltersSchema.safeParse({ limit: -10 }).success).toBe(false);
    });

    it('strictly rejects ReviewQueuePageSchema with excess properties', () => {
      const pageWithExtra = {
        batchId: 'batch-1',
        rows: [baseValidRow],
        nextCursor: null,
        counts: {
          total: 1,
          reviewedTotal: 0,
          unreviewedTotal: 1,
          readyCount: 1,
          blockedCount: 0,
          unknownCount: 0,
        },
        projectionHealth: {
          status: 'healthy' as const,
          version: '1.0.0',
          computedAt: new Date().toISOString(),
          issues: [],
        },
        leakedServerDetails: { memoryUsage: 1024 },
      };
      expect(ReviewQueuePageSchema.safeParse(pageWithExtra).success).toBe(false);
    });
  });

  describe('Field Type Corruptions & Missing Mandatory Fields', () => {
    it('rejects row when mandatory fields are omitted or have wrong type', () => {
      const missingItemId = { ...baseValidRow, itemId: undefined };
      expect(ReviewQueueRowSchema.safeParse(missingItemId).success).toBe(false);

      const numericItemId = { ...baseValidRow, itemId: 12345 };
      expect(ReviewQueueRowSchema.safeParse(numericItemId).success).toBe(false);

      const missingUpc = { ...baseValidRow, upc: undefined };
      expect(ReviewQueueRowSchema.safeParse(missingUpc).success).toBe(false);

      const missingTitle = { ...baseValidRow, displayTitle: undefined };
      expect(ReviewQueueRowSchema.safeParse(missingTitle).success).toBe(false);

      const missingSortKey = { ...baseValidRow, sortKey: undefined };
      expect(ReviewQueueRowSchema.safeParse(missingSortKey).success).toBe(false);

      const missingReviewGateStatus = { ...baseValidRow, reviewGateStatus: undefined };
      expect(ReviewQueueRowSchema.safeParse(missingReviewGateStatus).success).toBe(false);

      const invalidReviewGateStatus = { ...baseValidRow, reviewGateStatus: 'pending' };
      expect(ReviewQueueRowSchema.safeParse(invalidReviewGateStatus).success).toBe(false);
    });
  });
});

describe('Adversarial Cursor Security & Filter Hash Tests', () => {
  const baseFilters: ReviewQueueFilters = {
    brand: 'Blue Buffalo',
    warningsOnly: true,
    reviewStates: ['unreviewed', 'reviewed'],
    gateStatus: 'ready',
    familyCohortId: 'cohort-1',
    sourceType: 'official_page',
    q: 'chicken 30lb',
  };

  describe('Cursor Tampering, Corrupt Strings, and Version Attacks', () => {
    it('rejects non-base64url character sequences', () => {
      const invalidStrings = [
        '!!!invalid_base64url!!!',
        '==bad==padding==',
        'hello world with spaces',
        '{"v":1,"itemId":"123"}', // raw JSON, not base64url encoded
        'javascript:alert(1)',
        '<script>bad</script>',
      ];

      for (const str of invalidStrings) {
        expect(() => decodeReviewQueueCursor(str)).toThrow(ReviewQueueCursorError);
        try {
          decodeReviewQueueCursor(str);
        } catch (err: any) {
          expect(err).toBeInstanceOf(ReviewQueueCursorError);
          expect(err.code).toBe('malformed_cursor');
        }
      }
    });

    it('rejects valid base64url encoding of malformed JSON', () => {
      const malformedJson = '{ "v": 1, "sortKey": "incomplete';
      const encoded = Buffer.from(malformedJson, 'utf8').toString('base64url');
      expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
    });

    it('rejects valid base64url encoding of non-object JSON primitives', () => {
      const primitives = ['"just a string"', '12345', 'true', 'null', '["array", "of", "items"]'];
      for (const prim of primitives) {
        const encoded = Buffer.from(prim, 'utf8').toString('base64url');
        expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
      }
    });

    it('strictly rejects cursor with invalid or tampered version (v !== 1)', () => {
      const validHash = computeReviewQueueFilterHash(baseFilters);
      const invalidVersions = [
        { v: 2, sortKey: 'key', itemId: 'item-1', filterHash: validHash },
        { v: 0, sortKey: 'key', itemId: 'item-1', filterHash: validHash },
        { v: -1, sortKey: 'key', itemId: 'item-1', filterHash: validHash },
        { v: 999, sortKey: 'key', itemId: 'item-1', filterHash: validHash },
        { v: '1', sortKey: 'key', itemId: 'item-1', filterHash: validHash }, // string '1' instead of literal 1
        { v: null, sortKey: 'key', itemId: 'item-1', filterHash: validHash },
        { sortKey: 'key', itemId: 'item-1', filterHash: validHash }, // missing v
      ];

      for (const payload of invalidVersions) {
        const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
      }
    });

    it('strictly rejects cursor payload with missing required fields', () => {
      const validHash = computeReviewQueueFilterHash(baseFilters);
      const incompletePayloads = [
        { v: 1, itemId: 'item-1', filterHash: validHash }, // missing sortKey
        { v: 1, sortKey: 'key-1', filterHash: validHash }, // missing itemId
        { v: 1, sortKey: 'key-1', itemId: 'item-1' }, // missing filterHash
      ];

      for (const payload of incompletePayloads) {
        const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
      }
    });

    it('strictly rejects cursor payload with extra injected properties', () => {
      const validHash = computeReviewQueueFilterHash(baseFilters);
      const injectedPayload = {
        v: 1,
        sortKey: 'key-1',
        itemId: 'item-1',
        filterHash: validHash,
        injectedAdminPrivilege: true,
      };
      const encoded = Buffer.from(JSON.stringify(injectedPayload), 'utf8').toString('base64url');
      expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
    });

    it('strictly rejects invalid or corrupted filterHash formats', () => {
      const invalidHashes = [
        'short', // < 16 chars
        '123456789012345', // 15 chars
        'not_hex_chars_at_all!!',
        '1234567890abcdefghijklmnopqrstuvwxyz', // contains non-hex chars
        '',
      ];

      for (const badHash of invalidHashes) {
        const payload = { v: 1, sortKey: 'key-1', itemId: 'item-1', filterHash: badHash };
        const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
      }
    });
  });

  describe('Filter Hash Canonicalization and Filter Mismatch Security', () => {
    it('produces identical filterHash regardless of reviewStates array ordering', () => {
      const hash1 = computeReviewQueueFilterHash({ reviewStates: ['unreviewed', 'reviewed', 'approved'] });
      const hash2 = computeReviewQueueFilterHash({ reviewStates: ['approved', 'unreviewed', 'reviewed'] });
      const hash3 = computeReviewQueueFilterHash({ reviewStates: ['reviewed', 'approved', 'unreviewed'] });
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it('normalizes casing and whitespace for brand and q search filters', () => {
      const hash1 = computeReviewQueueFilterHash({ brand: '  Blue Buffalo  ', q: '  CHICKEN 30LB  ' });
      const hash2 = computeReviewQueueFilterHash({ brand: 'blue buffalo', q: 'chicken 30lb' });
      expect(hash1).toBe(hash2);
    });

    it('treats sourceType: "all" equivalent to omitted sourceType', () => {
      const hashAll = computeReviewQueueFilterHash({ sourceType: 'all', brand: 'Purina' });
      const hashOmitted = computeReviewQueueFilterHash({ brand: 'Purina' });
      expect(hashAll).toBe(hashOmitted);
    });

    it('detects filter mismatch for ANY filter modification', () => {
      const originalHash = computeReviewQueueFilterHash(baseFilters);
      const cursor = encodeReviewQueueCursor({
        v: 1,
        sortKey: '0:key:item-1',
        itemId: 'item-1',
        filterHash: originalHash,
      });

      const mutations: Array<{ name: string; alteredFilters: ReviewQueueFilters }> = [
        { name: 'changed brand', alteredFilters: { ...baseFilters, brand: 'Purina' } },
        { name: 'toggled warningsOnly', alteredFilters: { ...baseFilters, warningsOnly: false } },
        { name: 'removed warningsOnly', alteredFilters: { ...baseFilters, warningsOnly: undefined } },
        { name: 'changed gateStatus', alteredFilters: { ...baseFilters, gateStatus: 'blocked' } },
        { name: 'changed familyCohortId', alteredFilters: { ...baseFilters, familyCohortId: 'cohort-2' } },
        { name: 'changed sourceType', alteredFilters: { ...baseFilters, sourceType: 'distributor_record' } },
        { name: 'changed search query q', alteredFilters: { ...baseFilters, q: 'salmon 15lb' } },
        { name: 'changed reviewStates', alteredFilters: { ...baseFilters, reviewStates: ['approved'] } },
        { name: 'empty filters', alteredFilters: {} },
      ];

      for (const { name: _mutationName, alteredFilters } of mutations) {
        expect(() => validateReviewQueueCursor(cursor, alteredFilters)).toThrow(ReviewQueueCursorError);
        try {
          validateReviewQueueCursor(cursor, alteredFilters);
        } catch (err: any) {
          expect(err).toBeInstanceOf(ReviewQueueCursorError);
          expect(err.code).toBe('filter_mismatch');
        }
      }
    });

    it('accepts cursor when filters match canonical hash exactly', () => {
      const originalHash = computeReviewQueueFilterHash(baseFilters);
      const cursor = encodeReviewQueueCursor({
        v: 1,
        sortKey: '0:key:item-1',
        itemId: 'item-1',
        filterHash: originalHash,
      });

      const validated = validateReviewQueueCursor(cursor, { ...baseFilters });
      expect(validated.itemId).toBe('item-1');
      expect(validated.filterHash).toBe(originalHash);
    });
  });
});

describe('Deterministic Sorting and Pagination Invariants', () => {
  describe('buildReviewQueueSortKey', () => {
    it('strictly encodes review state ordering: unreviewed (0) < reviewed (1) < approved (2) < not_ready (3)', () => {
      const keyUnreviewed = buildReviewQueueSortKey('unreviewed', 'Same Title', 'item-1');
      const keyReviewed = buildReviewQueueSortKey('reviewed', 'Same Title', 'item-1');
      const keyApproved = buildReviewQueueSortKey('approved', 'Same Title', 'item-1');
      const keyNotReady = buildReviewQueueSortKey('not_ready', 'Same Title', 'item-1');
      const keyNull = buildReviewQueueSortKey(null, 'Same Title', 'item-1');

      expect(keyUnreviewed.startsWith('0:')).toBe(true);
      expect(keyReviewed.startsWith('1:')).toBe(true);
      expect(keyApproved.startsWith('2:')).toBe(true);
      expect(keyNotReady.startsWith('3:')).toBe(true);
      expect(keyNull.startsWith('0:')).toBe(true); // default unreviewed

      expect(keyUnreviewed.localeCompare(keyReviewed)).toBeLessThan(0);
      expect(keyReviewed.localeCompare(keyApproved)).toBeLessThan(0);
      expect(keyApproved.localeCompare(keyNotReady)).toBeLessThan(0);
    });

    it('pads short titles to exactly 64 characters to guarantee fixed column width', () => {
      const key = buildReviewQueueSortKey('unreviewed', 'Dog Food', 'item-1');
      const parts = key.split(':');
      expect(parts[1].length).toBe(64);
      expect(parts[1]).toBe('dog food'.padEnd(64, ' '));
    });

    it('truncates titles longer than 64 characters to exactly 64 characters', () => {
      const longTitle = 'A'.repeat(100);
      const key = buildReviewQueueSortKey('unreviewed', longTitle, 'item-1');
      const parts = key.split(':');
      expect(parts[1].length).toBe(64);
      expect(parts[1]).toBe('a'.repeat(64));
    });

    it('includes itemId as deterministic tie-breaker in sortKey', () => {
      const keyA = buildReviewQueueSortKey('unreviewed', 'Identical Dog Food', 'item-001');
      const keyB = buildReviewQueueSortKey('unreviewed', 'Identical Dog Food', 'item-002');
      expect(keyA).not.toBe(keyB);
      expect(keyA.localeCompare(keyB)).toBeLessThan(0);
    });
  });

  describe('Multi-Page Cursor Traversal Simulation on Duplicate Key Datasets', () => {
    it('traverses 75 items with identical titles and states with zero duplicates and zero skipped items', () => {
      // Construct 75 synthetic items with identical titles, brands, and states
      const totalItems = 75;
      const allRows: ReviewQueueRow[] = [];

      for (let i = 1; i <= totalItems; i++) {
        const idStr = String(i).padStart(3, '0');
        const itemId = `item-${idStr}`;
        const displayTitle = 'Identical Organic Dog Kibble 30lb';
        const sortKey = buildReviewQueueSortKey('unreviewed', displayTitle, itemId);
        allRows.push({
          itemId,
          upc: `000000000${idStr}`,
          displayTitle,
          brand: 'Blue Buffalo',
          sourceType: 'official_page',
          imageUrl: null,
          family: null,
          reviewState: 'unreviewed',
          sortKey,
          updatedAt: '2026-09-01T12:00:00.000Z',
          warningCodes: [],
          hasWarnings: false,
          reviewGateStatus: 'ready',
        });
      }

      // Ensure all rows are sorted deterministically
      allRows.sort((a, b) => {
        if (a.sortKey !== b.sortKey) return a.sortKey.localeCompare(b.sortKey);
        return a.itemId.localeCompare(b.itemId);
      });

      const filters: ReviewQueueFilters = { brand: 'Blue Buffalo', limit: 20 };
      const filterHash = computeReviewQueueFilterHash(filters);
      const pageSize = 20;

      const collectedItemIds: string[] = [];
      let currentCursor: string | undefined = undefined;
      let pageCount = 0;

      while (true) {
        pageCount++;
        let startIndex = 0;
        if (currentCursor) {
          const payload = validateReviewQueueCursor(currentCursor, filters);
          const cursorIndex = allRows.findIndex(
            r => r.sortKey > payload.sortKey || (r.sortKey === payload.sortKey && r.itemId > payload.itemId),
          );
          startIndex = cursorIndex === -1 ? allRows.length : cursorIndex;
        }

        const pageRows = allRows.slice(startIndex, startIndex + pageSize);
        for (const row of pageRows) {
          collectedItemIds.push(row.itemId);
        }

        let nextCursor: string | null = null;
        if (startIndex + pageSize < allRows.length && pageRows.length > 0) {
          const lastRow = pageRows[pageRows.length - 1];
          nextCursor = encodeReviewQueueCursor({
            v: 1,
            sortKey: lastRow.sortKey,
            itemId: lastRow.itemId,
            filterHash,
          });
        }

        currentCursor = nextCursor ?? undefined;
        if (!nextCursor) break;
        if (pageCount > 10) throw new Error('Infinite pagination loop detected');
      }

      // Page size is 20: 75 items should yield 4 pages (20, 20, 20, 15)
      expect(pageCount).toBe(4);
      expect(collectedItemIds.length).toBe(75);

      // Verify ZERO duplicates across all pages
      const uniqueIds = new Set(collectedItemIds);
      expect(uniqueIds.size).toBe(75);

      // Verify all 75 items were collected in exact ascending order
      for (let i = 1; i <= totalItems; i++) {
        const idStr = String(i).padStart(3, '0');
        expect(collectedItemIds[i - 1]).toBe(`item-${idStr}`);
      }
    });
  });
});

describe('Adversarial Review Gate Status Derivation Edge Cases', () => {
  const defaultItem = {
    name: 'Sample Kibble',
    price: '29.99',
    brand: 'Sample Brand',
    brandHint: 'Sample Hint',
    sourceType: 'official_page',
  };

  it('blocks when name is missing across item, curationData, and extractionData', () => {
    const item = { ...defaultItem, name: '' };
    const res = deriveReviewGateStatus(item, null, null);
    expect(res.status).toBe('blocked');
    expect(res.warningCodes).toContain('missing_name');
  });

  it('resolves curatedTitle > extractedTitle > item.name with appropriate fallback warning', () => {
    // Curated title present: no warning
    const resCurated = deriveReviewGateStatus(
      defaultItem,
      { curatedTitle: 'Curated Title', suggestedPages: ['p1'], reviewedMedia: { primaryImage: 'https://img' } },
      { title: 'Extracted Title', price: '29.99' },
    );
    expect(resCurated.warningCodes).not.toContain('name_from_fallback_source');

    // Only extracted title present: fallback warning
    const resExtracted = deriveReviewGateStatus(
      defaultItem,
      { suggestedPages: ['p1'], reviewedMedia: { primaryImage: 'https://img' } },
      { title: 'Extracted Title', price: '29.99' },
    );
    expect(resExtracted.warningCodes).toContain('name_from_fallback_source');
  });

  it('handles diverse price formatting and sanitization', () => {
    const validPriceStrings = ['$49.99', '49.99', ' $ 1,234.50 ', '$0.99'];
    for (const p of validPriceStrings) {
      const res = deriveReviewGateStatus(
        { ...defaultItem, price: p },
        { suggestedPages: ['p1'], reviewedMedia: { primaryImage: 'https://img' } },
        null,
      );
      expect(res.warningCodes).not.toContain('missing_price');
    }

    const invalidPriceStrings = ['', '   ', '$', '$,', null, undefined];
    for (const p of invalidPriceStrings) {
      const res = deriveReviewGateStatus(
        { ...defaultItem, price: p },
        { suggestedPages: ['p1'], reviewedMedia: { primaryImage: 'https://img' } },
        null,
      );
      expect(res.status).toBe('blocked');
      expect(res.warningCodes).toContain('missing_price');
    }
  });

  it('distinguishes distributor record vs official page image resolution', () => {
    // Official page: takes extractionData.primaryImage
    const officialRes = deriveReviewGateStatus(
      { ...defaultItem, sourceType: 'official_page' },
      { suggestedPages: ['p1'] },
      { primaryImage: 'https://example.com/official.jpg', price: '29.99' },
    );
    expect(officialRes.warningCodes).not.toContain('missing_primary_image');

    // Distributor record: requires distributorImageApprovals
    const distApproved = deriveReviewGateStatus(
      { ...defaultItem, sourceType: 'distributor_record' },
      { suggestedPages: ['p1'] },
      { distributorImageApprovals: [{ imageUrl: 'https://example.com/distributor.jpg' }], price: '29.99' },
    );
    expect(distApproved.warningCodes).not.toContain('missing_primary_image');

    // Distributor record without distributorImageApprovals: blocked
    const distNoApproval = deriveReviewGateStatus(
      { ...defaultItem, sourceType: 'distributor_record' },
      { suggestedPages: ['p1'] },
      { primaryImage: 'https://example.com/unapproved.jpg', distributorImageApprovals: [], price: '29.99' },
    );
    expect(distNoApproval.status).toBe('blocked');
    expect(distNoApproval.warningCodes).toContain('missing_primary_image');
  });

  it('respects reviewedMedia.suppressed for all image sources', () => {
    const suppressedUrl = 'https://example.com/bad.jpg';
    const res = deriveReviewGateStatus(
      defaultItem,
      {
        suggestedPages: ['p1'],
        reviewedMedia: {
          primaryImage: suppressedUrl,
          suppressed: [suppressedUrl],
        },
      },
      { primaryImage: suppressedUrl, price: '29.99' },
    );
    expect(res.status).toBe('blocked');
    expect(res.warningCodes).toContain('missing_primary_image');
  });

  it('blocks on semantic validation failure (status: "blocked")', () => {
    const res = deriveReviewGateStatus(
      defaultItem,
      {
        suggestedPages: ['p1'],
        reviewedMedia: { primaryImage: 'https://example.com/img.jpg' },
        semanticValidation: { status: 'blocked', findings: [{ message: 'Packaging mismatch' }] },
      },
      null,
    );
    expect(res.status).toBe('blocked');
    expect(res.warningCodes).toContain('semantic_validation_blocked');
  });

  it('warns on pending classification proposals', () => {
    const res = deriveReviewGateStatus(
      defaultItem,
      {
        suggestedPages: ['p1'],
        reviewedMedia: { primaryImage: 'https://example.com/img.jpg' },
        classificationProposals: [{ proposalType: 'field_assignment', status: 'pending' }],
      },
      null,
    );
    expect(res.warningCodes).toContain('pending_proposals');
  });
});
