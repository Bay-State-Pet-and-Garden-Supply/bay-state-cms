// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ReviewQueueRowSchema,
  ReviewGateStatusEnum,
  ProjectionHealthSchema,
  ReviewQueueCountsSchema,
  ReviewQueuePageSchema,
  ReviewQueueStatusTotalsSchema,
  ReviewQueueProgressSchema,
  ReviewQueueCursorError,
  encodeReviewQueueCursor,
  decodeReviewQueueCursor,
  validateReviewQueueCursor,
  computeReviewQueueFilterHash,
  deriveReviewGateStatus,
} from '../../shared/schemas/onboarding-review-queue';

describe('ReviewQueueRowSchema', () => {
  const validRow = {
    itemId: 'item-123',
    upc: '012345678905',
    displayTitle: 'Blue Buffalo Chicken 30lb',
    brand: 'Blue Buffalo',
    sourceType: 'official_page' as const,
    imageUrl: 'https://example.com/image.jpg',
    family: {
      cohortId: 'cohort-1',
      label: 'Life Protection Formula',
      memberCount: 4,
      readyCount: 3,
      blockedCount: 1,
    },
    reviewState: 'unreviewed' as const,
    sortKey: '0:blue buffalo chicken 30lb:item-123',
    updatedAt: '2026-09-01T12:00:00.000Z',
    warningCodes: ['name_from_fallback_source'],
    hasWarnings: true,
    reviewGateStatus: 'ready' as const,
  };

  it('validates a correct ReviewQueueRow', () => {
    const parsed = ReviewQueueRowSchema.safeParse(validRow);
    expect(parsed.success).toBe(true);
  });

  it('strictly rejects rows with prohibited detail blobs', () => {
    const prohibitedBlobs = [
      { description: 'Long description text...' },
      { curatedDescription: 'Curated HTML text' },
      { extraction: { title: 'Raw extracted title' } },
      { extractionData: { price: '$49.99' } },
      { ocrData: { text: 'OCR lines' } },
      { packagingOcrData: { attempts: [] } },
      { classificationProposals: [{ id: 'p1' }] },
      { proposalTrees: [] },
      { variantMatrix: { candidates: [] } },
      { variantResolution: { id: 'vr-1' } },
      { sourceHtml: '<html><body>...</body></html>' },
      { item: { id: 'full-item' } },
      { rawItem: {} },
    ];

    for (const blob of prohibitedBlobs) {
      const invalidRow = { ...validRow, ...blob };
      const parsed = ReviewQueueRowSchema.safeParse(invalidRow);
      expect(parsed.success).toBe(false);
    }
  });

  it('validates ReviewGateStatusEnum values', () => {
    expect(ReviewGateStatusEnum.safeParse('ready').success).toBe(true);
    expect(ReviewGateStatusEnum.safeParse('blocked').success).toBe(true);
    expect(ReviewGateStatusEnum.safeParse('unknown').success).toBe(true);
    expect(ReviewGateStatusEnum.safeParse('passing').success).toBe(false);
    expect(ReviewGateStatusEnum.safeParse('pending').success).toBe(false);
  });
});

describe('ProjectionHealthSchema', () => {
  it('validates healthy projection', () => {
    const healthy = {
      status: 'healthy' as const,
      version: '1.0.0',
      computedAt: '2026-09-01T12:00:00.000Z',
      issues: [],
    };
    expect(ProjectionHealthSchema.safeParse(healthy).success).toBe(true);
  });

  it('validates degraded projection with bounded issues', () => {
    const degraded = {
      status: 'degraded' as const,
      version: '1.0.0',
      computedAt: '2026-09-01T12:00:00.000Z',
      issues: [
        { source: 'curation_data_json', code: 'corrupt_json', affectedCount: 3 },
      ],
    };
    expect(ProjectionHealthSchema.safeParse(degraded).success).toBe(true);
  });

  it('rejects negative affectedCount', () => {
    const invalid = {
      status: 'degraded' as const,
      version: '1.0.0',
      computedAt: '2026-09-01T12:00:00.000Z',
      issues: [{ source: 'curation', code: 'err', affectedCount: -1 }],
    };
    expect(ProjectionHealthSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('ReviewQueueCountsSchema', () => {
  it('accepts additive independent scopes without changing legacy filtered count fields', () => {
    expect(ReviewQueueStatusTotalsSchema.parse({ unreviewed: 10, reviewed: 3, approved: 2 })).toEqual({ unreviewed: 10, reviewed: 3, approved: 2 });
    expect(ReviewQueueProgressSchema.parse({ total: 15, reviewed: 5, remaining: 10 })).toEqual({ total: 15, reviewed: 5, remaining: 10 });
    expect(ReviewQueueCountsSchema.parse({ total: 3, reviewedTotal: 3 }).reviewedTotal).toBe(3);
  });
  it('validates correct counts', () => {
    const counts = {
      total: 100,
      reviewedTotal: 40,
      unreviewedTotal: 60,
      readyCount: 75,
      blockedCount: 20,
      unknownCount: 5,
    };
    expect(ReviewQueueCountsSchema.safeParse(counts).success).toBe(true);
  });
});

describe('ReviewQueuePageSchema', () => {
  it('validates a complete ReviewQueuePage', () => {
    const page = {
      batchId: 'batch-1',
      rows: [],
      nextCursor: 'abc123cursor',
      counts: {
        total: 0,
        reviewedTotal: 0,
        unreviewedTotal: 0,
        readyCount: 0,
        blockedCount: 0,
        unknownCount: 0,
      },
      projectionHealth: {
        status: 'healthy' as const,
        version: '1.0.0',
        computedAt: '2026-09-01T12:00:00.000Z',
        issues: [],
      },
    };
    expect(ReviewQueuePageSchema.safeParse(page).success).toBe(true);
  });
});

describe('Cursor Serialization and Filter Hash Binding', () => {
  const filters = {
    brand: 'Blue Buffalo',
    warningsOnly: true,
    reviewStates: ['unreviewed' as const],
  };

  it('performs lossless cursor encoding and decoding roundtrip', () => {
    const filterHash = computeReviewQueueFilterHash(filters);
    const payload = {
      v: 1 as const,
      sortKey: '0:blue buffalo chicken:item-1',
      itemId: 'item-1',
      filterHash,
    };
    const encoded = encodeReviewQueueCursor(payload);
    expect(typeof encoded).toBe('string');
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true); // Base64url character set

    const decoded = decodeReviewQueueCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it('detects filter mismatch when filters change', () => {
    const originalHash = computeReviewQueueFilterHash(filters);
    const cursor = encodeReviewQueueCursor({
      v: 1,
      sortKey: '0:key:item-1',
      itemId: 'item-1',
      filterHash: originalHash,
    });

    const changedFilters = { ...filters, brand: 'Purina' };
    expect(() => validateReviewQueueCursor(cursor, changedFilters)).toThrow(ReviewQueueCursorError);
    try {
      validateReviewQueueCursor(cursor, changedFilters);
    } catch (err: any) {
      expect(err.code).toBe('filter_mismatch');
    }
  });

  it('rejects malformed cursor string', () => {
    expect(() => decodeReviewQueueCursor('invalid!!!base64url')).toThrow(ReviewQueueCursorError);
    try {
      decodeReviewQueueCursor('not-valid-base64');
    } catch (err: any) {
      expect(err.code).toBe('malformed_cursor');
    }
  });
});

describe('deriveReviewGateStatus', () => {
  const baseItem: any = {
    id: 'item-1',
    name: 'Sample Dog Food 30lb',
    upc: '012345678905',
    price: '24.99',
    brand: 'Sample Brand',
    sourceType: 'official_page',
  };

  it('evaluates ready for fully complete item', () => {
    const curationData = {
      curatedTitle: 'Sample Dog Food 30lb',
      reviewedMedia: { primaryImage: 'https://example.com/p.jpg' },
      suggestedPages: ['cat-1'],
    };
    const extractionData = {
      price: '$24.99',
    };
    const res = deriveReviewGateStatus(baseItem, curationData, extractionData);
    expect(res.status).toBe('ready');
    expect(res.warningCodes).toEqual([]);
  });

  it('evaluates blocked for missing mandatory fields', () => {
    const noNameItem = { ...baseItem, name: '' };
    const res = deriveReviewGateStatus(noNameItem, { suggestedPages: [] }, null);
    expect(res.status).toBe('blocked');
    expect(res.warningCodes).toContain('missing_name');
    expect(res.warningCodes).toContain('missing_primary_image');
    expect(res.warningCodes).toContain('missing_pages');
  });

  it('evaluates blocked for semantic validation failure', () => {
    const curationData = {
      curatedTitle: 'Sample Dog Food 30lb',
      reviewedMedia: { primaryImage: 'https://example.com/p.jpg' },
      suggestedPages: ['cat-1'],
      semanticValidation: {
        status: 'blocked',
        findings: [{ message: 'Conflict' }],
      },
    };
    const res = deriveReviewGateStatus(baseItem, curationData, null);
    expect(res.status).toBe('blocked');
    expect(res.warningCodes).toContain('semantic_validation_blocked');
  });
});
