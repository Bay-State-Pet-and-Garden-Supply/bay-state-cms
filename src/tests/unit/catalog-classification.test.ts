import { describe, it, expect } from 'vitest';
import {
  buildAssignmentProjection,
} from '../../classification/assignment-projection';
import {
  ShopSiteProductCodec,
  extractPageNamesFromBlock,
} from '../../shopsite/product-codec';
import { ownProductPageNames } from '../../classification/catalog-product-source';
import type { ClassificationProposal, AttributeMappingConfig, ProductAttributeConfig, Product } from '../../shared/types';
import type { CanonicalClassificationOutputBindingV2 } from '../../shared/schemas/classification';

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

// Reviewed assignment interpretation. End-to-end pending/approved separation is
// exercised by canonical-classification-workflow.test.ts; these inputs are
// accepted decisions, never pending suggestions presented as approved changes.
const mappings: AttributeMappingConfig[] = [
  { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  { id: 'material-map', attributeId: 'material', catalogField: 'ProductField28', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  { id: 'species-map', attributeId: 'species', catalogField: 'ProductField17', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
];
const attributes: ProductAttributeConfig[] = [
  { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
  { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Nylon', 'Rubber'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
  { id: 'species', name: 'Pet Type', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Dog', 'Cat'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
];
const currentCustomFields = { ProductField23: 'Chicken', ProductField28: 'Nylon', ProductField17: 'Dog', ProductField6: '19.99', ProductField16: 'Acme' };
const verifiedPageNames = new Map([
  ['page-food', 'Dog Food'], ['page-treats', 'Treats'], ['page-new', 'New Category'], ['page-brand', 'Brand - Acme'],
]);
const verifiedPageIds = new Set(verifiedPageNames.keys());
const authority = { attributes, frozenMappings: mappings, verifiedPageNames };

function proposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'p1', runId: 'r1', productSku: 'SKU001', proposalType: 'field_assignment', targetId: 'flavor',
    proposedValue: 'Beef', confidence: 0.9, evidenceIds: [], status: 'accepted',
    isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: '2026-08-04T00:00:00Z',
    ...overrides,
  };
}

function pageProposal(id: string, pageId: string, pageName: string): ClassificationProposal {
  return proposal({ id, proposalType: 'category_page', targetId: pageId, proposedValue: { pageId, pageName } });
}

describe('reviewed assignment projection with captured semantic authority', () => {
  it('projects Flavor and Pet Type into their distinct certified fields', () => {
    const result = buildAssignmentProjection([
      proposal(), proposal({ id: 'p-pet', targetId: 'species', proposedValue: 'Cat' }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: 'Chicken', proposedValue: 'Beef', isOverwrite: true, isNoOp: false },
      { catalogField: 'ProductField17', currentValue: 'Dog', proposedValue: 'Cat', isOverwrite: true, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('projects an accepted canonical pair through both captured and current output bindings', () => {
    const bindings = [
      { role: 'category' as const, catalogField: 'ProductField24', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
      { role: 'product-type' as const, catalogField: 'ProductField25', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
    ];
    const pair = proposal({
      id: 'p-pair',
      proposalType: 'product_classification',
      targetId: 'dog-food-dry',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
    });
    const result = buildAssignmentProjection(
      [pair],
      currentCustomFields,
      [],
      mappings,
      verifiedPageIds,
      {
        ...authority,
        currentClassificationOutputBindings: bindings,
        frozenClassificationOutputBindings: bindings,
        categories: [{ id: 'dog-food' }],
        productTypes: [{
          id: 'dog-food-dry',
          categoryId: 'dog-food',
          websiteValues: { category: 'QA Dog Food', productType: 'QA Dry Dog Food' },
        }],
      },
    );
    expect(result.fields).toEqual([
      { catalogField: 'ProductField24', currentValue: null, proposedValue: 'QA Dog Food', isOverwrite: false, isNoOp: false },
      { catalogField: 'ProductField25', currentValue: null, proposedValue: 'QA Dry Dog Food', isOverwrite: false, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it.each([
    ['missing current Category binding', (bindings: CanonicalClassificationOutputBindingV2[]) => bindings.filter(binding => binding.role !== 'category'), null],
    ['stale Product Type binding', (bindings: CanonicalClassificationOutputBindingV2[]) => bindings.map(binding => binding.role === 'product-type' ? { ...binding, isStale: true } : binding), null],
    ['wrong Category destination', (bindings: CanonicalClassificationOutputBindingV2[]) => bindings.map(binding => binding.role === 'category' ? { ...binding, catalogField: 'ProductField25' } : binding), null],
    ['changed current serializer', null, (bindings: CanonicalClassificationOutputBindingV2[]) => bindings.map(binding => binding.role === 'category' ? { ...binding, serialization: { ...binding.serialization, prefix: 'Category: ' } } : binding)],
  ])('refuses an incomplete, stale, mismatched or changed pair binding: %s', (_label, currentEdit, frozenEdit) => {
    const bindings = [
      { role: 'category' as const, catalogField: 'ProductField24', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
      { role: 'product-type' as const, catalogField: 'ProductField25', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
    ];
    const pair = proposal({
      id: 'p-pair',
      proposalType: 'product_classification',
      targetId: 'dog-food-dry',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
    });
    const currentBindings = currentEdit ? currentEdit(bindings) : bindings;
    const frozenBindings = frozenEdit ? frozenEdit(bindings) : bindings;
    const result = buildAssignmentProjection([pair], currentCustomFields, [], mappings, verifiedPageIds, {
      ...authority,
      currentClassificationOutputBindings: currentBindings,
      frozenClassificationOutputBindings: frozenBindings,
      categories: [{ id: 'dog-food' }],
      productTypes: [{
        id: 'dog-food-dry',
        categoryId: 'dog-food',
        websiteValues: { category: 'QA Dog Food', productType: 'QA Dry Dog Food' },
      }],
    });
    expect(result.fields).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p-pair', reason: expect.stringContaining('protected_target_refused') }),
    ]);
  });

  it('writes a corrected Flavor→Material decision only into Material PF28', () => {
    const result = buildAssignmentProjection([
      proposal({ revisedTargetId: 'material', hasRevisedTargetId: true, revisedValue: 'Rubber', hasRevisedValue: true }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField28', currentValue: 'Nylon', proposedValue: 'Rubber', isOverwrite: true, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('treats an explicit reviewed null as a field clear', () => {
    const result = buildAssignmentProjection([
      proposal({ revisedValue: null, hasRevisedValue: true }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: 'Chicken', proposedValue: '', isOverwrite: true, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('does not turn an explicitly cleared target into an assignment or refusal', () => {
    const result = buildAssignmentProjection([
      proposal({ revisedTargetId: null, hasRevisedTargetId: true }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('does not apply revised target/value payloads without their presence flags', () => {
    const result = buildAssignmentProjection([
      proposal({ proposedValue: 'Chicken', revisedTargetId: 'material', revisedValue: 'Rubber', hasRevisedTargetId: false, hasRevisedValue: false }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: 'Chicken', proposedValue: 'Chicken', isOverwrite: false, isNoOp: true },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it.each([
    ['unknown Flavor slot', 'flavor', 'ProductField1'],
    ['MAP pricing', 'flavor', 'ProductField6'],
    ['Brand slot', 'flavor', 'ProductField16'],
    ['Pet Type borrowed by Flavor', 'flavor', 'ProductField17'],
    ['native fulfillment', 'flavor', 'ProductType'],
    ['unknown semantic role', 'unverified-role', 'ProductField23'],
    ['Brand borrowed Flavor slot', 'brand', 'ProductField23'],
  ])('refuses %s even when current and captured mappings agree', (_label, attributeId, catalogField) => {
    const unsafeMappings = [{ ...mappings[0], attributeId, catalogField }];
    const result = buildAssignmentProjection([
      proposal({ targetId: attributeId }),
    ], currentCustomFields, [], unsafeMappings, verifiedPageIds, { ...authority, frozenMappings: unsafeMappings });
    expect(result.fields).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p1', targetId: attributeId, reason: expect.stringContaining('protected_target_refused') }),
    ]);
  });

  it('does not launder an original Brand target through a permitted correction', () => {
    const result = buildAssignmentProjection([
      proposal({ targetId: 'brand', revisedTargetId: 'flavor', hasRevisedTargetId: true }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p1', reason: expect.stringContaining('protected_target_refused') }),
    ]);
  });

  it.each(['missing', 'empty', 'stale', 'duplicate'] as const)('refuses a %s mapping rather than emitting a field', state => {
    const invalidMappings = state === 'missing' ? []
      : state === 'duplicate' ? [mappings[0], { ...mappings[0], id: 'duplicate' }]
        : [{ ...mappings[0], catalogField: state === 'empty' ? '' : 'ProductField23', isStale: state === 'stale' }];
    const result = buildAssignmentProjection([proposal()], currentCustomFields, [], invalidMappings, verifiedPageIds, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['p1']);
  });

  it('refuses serialization drift from the captured mapping', () => {
    const changed = [{ ...mappings[0], serialization: { ...mappings[0].serialization, prefix: 'Flavor: ' } }, ...mappings.slice(1)];
    const result = buildAssignmentProjection([proposal()], currentCustomFields, [], changed, verifiedPageIds, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p1', reason: expect.stringContaining('mapping_changed') }),
    ]);
  });

  it('reports conflicting accepted assignments instead of silently picking a winner', () => {
    const result = buildAssignmentProjection([
      proposal(), proposal({ id: 'p-conflict', proposedValue: 'Chicken' }),
    ], currentCustomFields, [], mappings, verifiedPageIds, authority);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['p-conflict']);
  });
});

describe('verified taxonomy page deltas', () => {
  it('adds only new verified taxonomy names without duplicating existing assignments', () => {
    const result = buildAssignmentProjection([
      pageProposal('p-food', 'page-food', 'Dog Food'),
      pageProposal('p-new', 'page-new', 'New Category'),
      pageProposal('p-duplicate', 'page-new', 'New Category'),
    ], {}, ['Dog Food', 'Treats'], mappings, verifiedPageIds, authority);
    expect(result.pages).toEqual({
      existing: ['Dog Food', 'Treats'], proposed: ['New Category'], removed: [],
      additions: [{ pageId: 'page-food', pageName: 'Dog Food' }, { pageId: 'page-new', pageName: 'New Category' }],
      removals: [], final: ['Dog Food', 'Treats', 'New Category'],
    });
    expect(result.skipped).toEqual([]);
  });

  it('removes the original verified taxonomy assignment for an explicit reviewed clear', () => {
    const result = buildAssignmentProjection([
      { ...pageProposal('p-remove', 'page-food', 'Dog Food'), revisedValue: null, hasRevisedValue: true, revisedTargetId: null, hasRevisedTargetId: true },
    ], {}, ['Dog Food', 'Treats'], mappings, verifiedPageIds, authority);
    expect(result.pages.removals).toEqual([{ pageId: 'page-food', pageName: 'Dog Food' }]);
    expect(result.pages.final).toEqual(['Treats']);
    expect(result.pages.proposed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('uses the captured display name, never a forged payload name', () => {
    const result = buildAssignmentProjection([
      pageProposal('p-name', 'page-new', 'Invented Page'),
    ], {}, [], mappings, verifiedPageIds, authority);
    expect(result.pages.final).toEqual(['New Category']);
    expect(result.skipped).toEqual([]);
  });

  it.each([
    proposal({ id: 'p-unverified', proposalType: 'category_page', targetId: 'page-unknown', proposedValue: { pageId: 'page-unknown', pageName: 'Unknown Page' } }),
    proposal({ id: 'p-inconsistent', proposalType: 'category_page', targetId: 'page-food', proposedValue: { pageId: 'page-new', pageName: 'New Category' } }),
    proposal({ id: 'p-no-id', proposalType: 'category_page', targetId: 'page-new', proposedValue: { pageName: 'New Category' } }),
  ])('refuses unverified or inconsistent identity: $id', page => {
    const result = buildAssignmentProjection([page], {}, ['Treats'], mappings, verifiedPageIds, authority);
    expect(result.pages.final).toEqual(['Treats']);
    expect(result.pages.additions).toEqual([]);
    expect(result.pages.removals).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual([page.id]);
  });

  it('never substitutes the stable page ID for a missing verified display name', () => {
    const result = buildAssignmentProjection([
      proposal({ proposalType: 'category_page', targetId: 'page-new', proposedValue: { pageId: 'page-new' } }),
    ], {}, [], mappings, verifiedPageIds, { ...authority, verifiedPageNames: new Map() });
    expect(result.pages.final).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['p1']);
  });

  it.each([false, true])('protects Brand page identity even with a disguised name (removal=%s)', removal => {
    const page = pageProposal('p-brand', 'page-brand', 'Dog Food');
    if (removal) Object.assign(page, { revisedValue: null, hasRevisedValue: true });
    const result = buildAssignmentProjection([page], {}, ['Brand - Acme', 'Treats'], mappings, verifiedPageIds, authority);
    expect(result.pages.final).toEqual(['Brand - Acme', 'Treats']);
    expect(result.pages.additions).toEqual([]);
    expect(result.pages.removals).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p-brand', reason: expect.stringContaining('protected_target_refused') }),
    ]);
  });

  it('treats an explicitly cleared page target as no assignment, not a page-name fallback', () => {
    const page = { ...pageProposal('p-no-target', 'page-new', 'New Category'), revisedTargetId: null, hasRevisedTargetId: true };
    const result = buildAssignmentProjection([page], {}, ['Treats'], mappings, verifiedPageIds, authority);
    expect(result.pages.final).toEqual(['Treats']);
    expect(result.pages.additions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

// ─── first-class Category Page assignments (#142/#143) ───────────────────────
// The shallow product-page-assignments module is deleted. Page-name
// extraction lives behind the codec seam (extractPageNamesFromBlock),
// product reads use ownProductPageNames (first-class with legacy fallback),
// and serialization goes through ShopSiteProductCodec.encode.

describe('extractPageNamesFromBlock', () => {
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
