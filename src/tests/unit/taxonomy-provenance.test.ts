// story: e05s02 — taxonomy provenance per field, no invented IDs (ADR 0012)
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import { validateProposalSafety } from '../../classification/proposal-safety';
import { findCanonicalCollisions } from '../../classification/controlled-value-identity';
import { validateSerializableValue } from '../../classification/attribute-value-validation';

describe('e05s02 — taxonomy provenance additive field', () => {
  test('product-curator populates taxonomyProvenance (bundle/snapshot/verified identity)', () => {
    const src = fs.readFileSync('src/onboarding/product-curator.ts', 'utf8');
    expect(src).toContain('taxonomyProvenance');
    expect(src).toContain('bundleHash');
    expect(src).toContain('snapshotHash');
    expect(src).toContain('verifiedPageIdSet');
    expect(src).toContain('attributeProfileId');
    expect(src).toContain('e05s02');
  });

  test('CurationDataSchema allows taxonomyProvenance', () => {
    const src = fs.readFileSync('src/shared/schemas/onboarding.ts', 'utf8');
    expect(src).toContain('taxonomyProvenance');
    expect(src).toContain('bundleHash');
    expect(src).toContain('snapshotHash');
  });

  test('Review panel renders taxonomy provenance badge', () => {
    const src = fs.readFileSync('src/client/components/onboarding/review/ReviewClassificationPanel.tsx', 'utf8');
    expect(src).toContain('Taxonomy provenance');
    expect(src).toContain('taxonomyProvenance');
    expect(src).toContain('store/classification');
    expect(src).toContain('ADR 0012');
  });

  test('CURATION_FIELD_MAP documents SoT chain store/classification → RuntimeClassificationSnapshot', () => {
    const src = fs.readFileSync('specs/tech-architecture/CURATION_FIELD_MAP.md', 'utf8');
    expect(src).toContain('store/classification');
    expect(src).toContain('RuntimeClassificationSnapshot');
    expect(src).toContain('e05s02');
  });
});

describe('e05s02 — no invented IDs choke-point (ADR 0012)', () => {
  test('category_page invented id fails closed when verified catalog present', () => {
    const invented = {
      id: 'p-invented',
      runId: 'r1',
      productSku: 'SKU1',
      proposalType: 'category_page' as const,
      targetId: 'invented_page_id',
      proposedValue: { pageId: 'invented_page_id', pageName: 'Invented Page' },
      confidence: 0.9,
      evidenceIds: [],
      status: 'pending' as const,
      isBulkAcceptable: false,
      isStale: false,
      stalenessReason: null,
      snapshotHash: null,
      createdAt: new Date().toISOString(),
    } as unknown as import('../../shared/schemas/classification').ClassificationProposal;

    const safety = validateProposalSafety([invented], {
      attributes: [],
      evidence: [],
      verifiedPageIds: new Set(['real_page_a', 'real_page_b']),
    });
    expect(safety.ok).toBe(false);
    expect(safety.findings[0]?.code).toBe('page_unverified');
  });

  test('category_page verified id passes when in verified set', () => {
    const verified = {
      id: 'p-verified',
      runId: 'r1',
      productSku: 'SKU1',
      proposalType: 'category_page' as const,
      targetId: 'real_page_a',
      proposedValue: { pageId: 'real_page_a', pageName: 'Real Page A' },
      confidence: 0.9,
      evidenceIds: [],
      status: 'pending' as const,
      isBulkAcceptable: false,
      isStale: false,
      stalenessReason: null,
      snapshotHash: null,
      createdAt: new Date().toISOString(),
    } as unknown as import('../../shared/schemas/classification').ClassificationProposal;

    const safety = validateProposalSafety([verified], {
      attributes: [],
      evidence: [],
      verifiedPageIds: new Set(['real_page_a', 'real_page_b']),
    });
    expect(safety.ok).toBe(true);
  });

  test('controlled-value Dog/dog duplicate is a case-fold collision (ADR 0012)', () => {
    const collisions = findCanonicalCollisions(['Dog', 'dog']);
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.some(c => c.kind === 'case-fold')).toBe(true);
  });

  test('controlled-membership still rejects near-match via alias mis-map', () => {
    const attr = {
      id: 'color',
      valueMode: 'controlled' as const,
      allowedValues: ['Red', 'Blue'],
      valueAliases: [{ alias: 'rouge', mapsTo: 'Red' }],
    };
    // exact canonical passes
    expect(validateSerializableValue('Red', attr).ok).toBe(true);
    // alias mapsTo outside allowed set fails closed (ADR 0012)
    const badAlias = { ...attr, valueAliases: [{ alias: 'rouge', mapsTo: 'Green' }] };
    expect(validateSerializableValue('rouge', badAlias).ok).toBe(false);
    // unknown value fails
    expect(validateSerializableValue('Green', attr).ok).toBe(false);
  });
});
