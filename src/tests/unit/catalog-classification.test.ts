import { describe, it, expect } from 'vitest';
import {
  serializeAttributeValue,
  buildAssignmentProjection,
} from '../../classification/assignment-projection';
import {
  ShopSiteProductCodec,
  extractPageNamesFromBlock,
} from '../../shopsite/product-codec';
import { ownProductPageNames } from '../../classification/catalog-product-source';
import type { ClassificationProposal, AttributeMappingConfig, Product } from '../../shared/types';

function makePageTestProduct(
  productOnPages: string[],
  preserved?: Product['shopsite']['preserved'],
): Product {
  return {
    schemaVersion: 1,
    id: 'page-test-1',
    sku: 'PAGE-TEST-1',
    status: 'active',
    core: {
      name: 'Page Test Product',
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: null,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages,
    },
    customFields: {},
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: preserved ?? { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z', archivedAt: null },
  };
}

// ─── assignment-projection.ts ─────────────────────────────────────────────────

describe('serializeAttributeValue', () => {
  const defaultSerialization = { format: 'direct', separator: ', ', prefix: '', suffix: '' };

  it('returns empty string for null/undefined', () => {
    expect(serializeAttributeValue(null, defaultSerialization)).toBe('');
    expect(serializeAttributeValue(undefined, defaultSerialization)).toBe('');
  });

  it('bypasses prefix/suffix for explicit null clears', () => {
    const withPrefix = { format: 'direct', separator: ', ', prefix: 'Size: ', suffix: '' };
    const withSuffix = { format: 'direct', separator: ', ', prefix: '', suffix: ' lb' };
    expect(serializeAttributeValue(null, withPrefix)).toBe('');
    expect(serializeAttributeValue(null, withSuffix)).toBe('');
    expect(serializeAttributeValue(undefined, withPrefix)).toBe('');
  });

  it('returns string value directly for direct format', () => {
    expect(serializeAttributeValue('Chicken', defaultSerialization)).toBe('Chicken');
  });

  it('joins array values with separator', () => {
    expect(serializeAttributeValue(['Chicken', 'Beef'], defaultSerialization)).toBe('Chicken, Beef');
  });

  it('applies prefix and suffix', () => {
    const withAffix = { format: 'direct', separator: ', ', prefix: '[', suffix: ']' };
    expect(serializeAttributeValue('Chicken', withAffix)).toBe('[Chicken]');
  });

  it('applies prefix and suffix to array values', () => {
    const withAffix = { format: 'direct', separator: ', ', prefix: '[', suffix: ']' };
    expect(serializeAttributeValue(['A', 'B'], withAffix)).toBe('[A, B]');
  });

  it('converts numbers to strings', () => {
    expect(serializeAttributeValue(42, defaultSerialization)).toBe('42');
    expect(serializeAttributeValue(3.14, defaultSerialization)).toBe('3.14');
  });
});

describe('buildAssignmentProjection', () => {
  const mappings: AttributeMappingConfig[] = [
    {
      id: 'flavor-map',
      attributeId: 'flavor',
      catalogField: 'ProductField17',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    },
    {
      id: 'stale-map',
      attributeId: 'color',
      catalogField: 'ProductField18',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: true,
    },
    {
      id: 'no-field-map',
      attributeId: 'size',
      catalogField: '',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    },
  ];

  const currentCustomFields: Record<string, string> = {
    ProductField17: 'Chicken',
    ProductField19: 'ExistingValue',
  };

  const currentPageNames = ['Dog Food', 'Treats'];

  it('maps field_assignment proposals to projections', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p1', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'flavor',
        proposedValue: 'Beef', confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].catalogField).toBe('ProductField17');
    expect(result.fields[0].currentValue).toBe('Chicken');
    expect(result.fields[0].proposedValue).toBe('Beef');
    expect(result.fields[0].isOverwrite).toBe(true);
    expect(result.fields[0].isNoOp).toBe(false);
    expect(result.skipped).toHaveLength(0);
  });

  it('projects an explicit null correction as a deliberate field clear', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p-clear', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'flavor',
        proposedValue: 'Beef', revisedValue: null, hasRevisedValue: true, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);
    expect(result.fields[0].proposedValue).toBe('');
    expect(result.fields[0].isOverwrite).toBe(true);
    expect(result.fields[0].isNoOp).toBe(false);
  });

  it('projects prefixed/suffixed explicit null clears as empty strings', () => {
    const affixMappings: AttributeMappingConfig[] = [
      {
        id: 'size-map',
        attributeId: 'size',
        catalogField: 'ProductField20',
        serialization: { format: 'direct', separator: ', ', prefix: 'Size: ', suffix: '' },
        isStale: false,
      },
    ];
    const proposals: ClassificationProposal[] = [
      {
        id: 'p-affix-clear', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'size',
        proposedValue: 'Large', revisedValue: null, hasRevisedValue: true, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];
    const result = buildAssignmentProjection(proposals, {}, [], affixMappings);
    expect(result.fields[0].proposedValue).toBe('');
  });

  it('skips assignments when the revised target is explicitly cleared to null', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p-target-clear', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'flavor',
        proposedValue: 'Beef', revisedTargetId: null, hasRevisedTargetId: true, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];
    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);
    expect(result.fields).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p-target-clear', targetId: null, reason: 'No attribute target' }),
    ]);
  });

  it('uses the revised target when mapping a corrected assignment', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p-retarget', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'size',
        proposedValue: 'Beef', revisedTargetId: 'flavor', hasRevisedTargetId: true, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);
    expect(result.fields[0].catalogField).toBe('ProductField17');
    expect(result.fields[0].proposedValue).toBe('Beef');
  });

  it('flags no-op when current and proposed match', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p2', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'flavor',
        proposedValue: 'Chicken', confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);

    expect(result.fields[0].isNoOp).toBe(true);
    expect(result.fields[0].isOverwrite).toBe(false);
  });

  it('skips proposals with stale mapping', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p3', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'color',
        proposedValue: 'Red', confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);

    expect(result.fields).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('stale');
  });

  it('skips proposals with no catalog field', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p4', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'size',
        proposedValue: 'Large', confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);

    expect(result.fields).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('handles category_page proposals as additive', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p5', runId: 'r1', productSku: 'SKU001',
        proposalType: 'category_page', targetId: 'Dog Food',
        proposedValue: { pageName: 'Dog Food' }, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'p6', runId: 'r1', productSku: 'SKU001',
        proposalType: 'category_page', targetId: 'New Category',
        proposedValue: { pageName: 'New Category' }, confidence: 0.8,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);

    expect(result.pages.existing).toEqual(['Dog Food', 'Treats']);
    expect(result.pages.proposed).toEqual(['New Category']);
    // Dog Food proposal is skipped because it is already assigned
    expect(result.skipped).toHaveLength(1);
  });

  it('skips page proposals for already-assigned pages and for nameless values', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p7', runId: 'r1', productSku: 'SKU001',
        proposalType: 'category_page', targetId: 'Dog Food',
        proposedValue: {}, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'p8', runId: 'r1', productSku: 'SKU001',
        proposalType: 'category_page', targetId: 'Dog Food',
        proposedValue: { pageName: 'Dog Food' }, confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);
    expect(result.pages.proposed).toEqual([]);
    // The empty-object value has no display name — the Page ID target must
    // never be substituted (issue #17 pass 3c).
    const namelessSkip = result.skipped.find(skip => skip.proposalId === 'p7');
    expect(namelessSkip).toBeDefined();
    expect(namelessSkip!.reason).toBe('Page display name missing');
    // A named value that matches an existing page is skipped as already
    // assigned.
    const assignedSkip = result.skipped.find(skip => skip.proposalId === 'p8');
    expect(assignedSkip).toBeDefined();
    expect(assignedSkip!.reason).toContain('already assigned');
  });

  it('deduplicates by catalog field (first proposal wins)', () => {
    const proposals: ClassificationProposal[] = [
      {
        id: 'p8', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'flavor',
        proposedValue: 'Beef', confidence: 0.9,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'p9', runId: 'r1', productSku: 'SKU001',
        proposalType: 'field_assignment', targetId: 'flavor',
        proposedValue: 'Chicken', confidence: 0.8,
        evidenceIds: [], status: 'accepted',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = buildAssignmentProjection(proposals, currentCustomFields, currentPageNames, mappings);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].proposedValue).toBe('Beef');
  });
});

// ─── first-class Category Page assignments (#142/#143) ───────────────────────
// The shallow product-page-assignments module is deleted. Page-name
// extraction lives behind the codec seam (extractPageNamesFromBlock),
// product reads use ownProductPageNames (first-class with legacy fallback),
// and serialization goes through ShopSiteProductCodec.encode.

describe('extractPageNamesFromBlock', () => {
  it('returns empty array for empty input', () => {
    expect(extractPageNamesFromBlock('')).toEqual([]);
  });

  it('extracts page names from legacy flat <Name> fragments', () => {
    expect(extractPageNamesFromBlock('\n    <Name>Dog Food</Name>\n    <Name>Treats</Name>\n  ')).toEqual(['Dog Food', 'Treats']);
  });

  it('handles single-page fragments', () => {
    expect(extractPageNamesFromBlock('<Name>Cat Food</Name>')).toEqual(['Cat Food']);
  });

  it('extracts page names from modern <PageLink><Name> fragments', () => {
    expect(extractPageNamesFromBlock('<ProductOnPages><PageLink><Name>Dog Food</Name></PageLink></ProductOnPages>')).toEqual(['Dog Food']);
  });
});

describe('ownProductPageNames', () => {
  it('returns empty array when no assignments exist', () => {
    expect(ownProductPageNames(makePageTestProduct([]))).toEqual([]);
  });

  it('prefers first-class core.productOnPages', () => {
    expect(ownProductPageNames(makePageTestProduct(['Dog Food', 'Treats']))).toEqual(['Dog Food', 'Treats']);
  });

  it('falls back to legacy unknown-elements fragments', () => {
    const product = makePageTestProduct([], { unknownElements: { ProductOnPages: '<Name>Cat Food</Name>' }, advancedBlocks: {}, rawAttributes: {} });
    expect(ownProductPageNames(product)).toEqual(['Cat Food']);
  });

  it('falls back to legacy advanced-block fragments', () => {
    const product = makePageTestProduct([], { unknownElements: {}, advancedBlocks: { ProductOnPages: '<ProductOnPages><PageLink><Name>Legacy Page</Name></PageLink></ProductOnPages>' }, rawAttributes: {} });
    expect(ownProductPageNames(product)).toEqual(['Legacy Page']);
  });
});

describe('first-class page assignment serialization', () => {
  it('emits no ProductOnPages block for empty assignments', () => {
    const { xml } = ShopSiteProductCodec.encode(makePageTestProduct([]));
    expect(xml).not.toContain('<ProductOnPages>');
  });

  it('serializes first-class pages as DTD-compliant <PageLink><Name>', () => {
    const { xml } = ShopSiteProductCodec.encode(makePageTestProduct(['Dog Food', 'Treats', 'Dog Food']));
    expect(xml).toContain('<ProductOnPages>');
    expect(xml).toContain('<Name>Dog Food</Name>');
    expect(xml).toContain('<Name>Treats</Name>');
    const matches = xml.match(/<Name>Dog Food<\/Name>/g);
    expect(matches).toHaveLength(1);
  });

  it('escapes XML special characters in page names', () => {
    const { xml } = ShopSiteProductCodec.encode(makePageTestProduct(['Cat & Dog']));
    expect(xml).toContain('<Name>Cat &amp; Dog</Name>');
  });
});
