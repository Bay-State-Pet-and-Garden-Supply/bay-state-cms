/**
 * P0 #1 backfill preflight regression tests (backfill remediation plan).
 *
 * Every fixture exercises the public seam
 * (`preflightBackfillWithResolvers` with in-memory run/decision/mapping
 * fakes, plus the pure `parseBackfillCensusXml` census) — never the module's
 * source text and never mock-echo assertions. Live/outgoing/baseline payloads
 * are real quoted ShopSite XML emitted by `ShopSiteProductCodec`, so the
 * `Foo&apos;s` vs `Foos` case proves entity-aware semantic comparison rather
 * than string matching.
 */
import { describe, expect, it } from 'vitest';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import {
  diffBackfillRecords,
  parseBackfillCensusXml,
  preflightBackfill,
  preflightBackfillWithResolvers,
  type BackfillCensusRecord,
  type BackfillPreflightIssue,
  type BackfillPreflightResolvers,
} from '../../shopsite/backfill-preflight';
import type { ChangeSetItemRow } from '../../db/repositories/change-set-repo';
import type {
  AttributeMappingConfig,
  ClassificationProposal,
} from '../../shared/schemas/classification';
import type { ClassificationRunRow } from '../../db/repositories/classification-run-repo';
import type { Product } from '../../shared/types';

const WORKSPACE_ID = 'ws-backfill-preflight-test';
const SKU = 'FOO-001';
const RUN_ID = 'run-foo-001';

let productSeq = 0;

function baseProduct(): Product {
  productSeq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `product-${productSeq}`,
    sku: SKU,
    status: 'active',
    core: {
      name: 'Foo Widgets',
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: 'in_stock',
      weight: null,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {
      ProductField1: 'instock060526',
      ProductField23: 'Chicken',
    },
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: now,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

function liveDocument(products: Product[]): string {
  return ShopSiteProductCodec.encodeMany(products).xml;
}

function namespacedDocument(innerXml: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">',
    '<ShopSiteProducts version="15.0">',
    '<Products>',
    innerXml,
    '</Products>',
    '</ShopSiteProducts>',
  ].join('\n');
}

function singleRecord(xml: string): BackfillCensusRecord {
  const census = parseBackfillCensusXml(xml);
  expect(census.ok).toBe(true);
  expect(census.records).toHaveLength(1);
  return census.records[0];
}

let proposalSeq = 0;

function fieldProposal(value: string): ClassificationProposal {
  proposalSeq += 1;
  const now = new Date().toISOString();
  return {
    id: `proposal-${proposalSeq}`,
    runId: RUN_ID,
    productSku: SKU,
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: value,
    confidence: 0.9,
    evidenceIds: [],
    status: 'accepted',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: now,
  };
}

function completedCatalogRun(): ClassificationRunRow {
  const now = new Date().toISOString();
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    onboardingItemId: null,
    sourceKind: 'catalog_product',
    sourceProductHash: null,
    productSku: SKU,
    configSnapshotId: null,
    configSnapshotHash: null,
    status: 'completed',
    startedAt: now,
    completedAt: now,
    errorMessage: null,
    cohortRunId: null,
  };
}

function scalarMappings(): AttributeMappingConfig[] {
  return [
    {
      id: 'flavor-mapping',
      attributeId: 'flavor',
      catalogField: 'ProductField23',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    },
  ];
}

function resolversWith(overrides?: Partial<BackfillPreflightResolvers>): BackfillPreflightResolvers {
  return {
    getRun: () => completedCatalogRun(),
    getAcceptedProposals: () => [fieldProposal('Salmon')],
    getCachedAttributeMappings: () => scalarMappings(),
    ...overrides,
  };
}

function changeSetItem(product: Product, runId: string | null): ChangeSetItemRow {
  const now = new Date().toISOString();
  const draft = { ...product, customFields: { ...product.customFields, ProductField23: 'Salmon' } };
  return {
    id: 'item-1',
    changeSetId: 'cs-1',
    sku: SKU,
    operation: 'update',
    draftJson: JSON.stringify(draft),
    baseJson: JSON.stringify(product),
    draftHash: 'hash',
    validationStatus: 'unknown',
    classificationRunId: runId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('backfill preflight census (P0 #1)', () => {
  it('compares quoted XML entities semantically through the parser', () => {
    const withEntity = namespacedDocument(
      '<Product><SKU>Q-1</SKU><Name>Foo&apos;s</Name><ProductField23>Chicken</ProductField23></Product>',
    );
    const literal = namespacedDocument(
      '<Product><SKU>Q-1</SKU><Name>Foo&apos;s Treats</Name><ProductField23>Chicken</ProductField23></Product>',
    );
    const entityName = singleRecord(withEntity).leaves['Name'];
    expect(entityName).toBe("Foo's");
    const deltas = diffBackfillRecords(singleRecord(withEntity), singleRecord(literal));
    expect(deltas.map(delta => delta.field)).toContain('Name');
  });

  it('counts nested Subproducts as parent blocks, never as top-level records', () => {
    const nested = namespacedDocument(
      '<Product><SKU>P-1</SKU><Name>Parent</Name>' +
        '<Subproducts><Subproduct><SKU>P-1-RED</SKU><Name>Red</Name></Subproduct>' +
        '<Subproduct><SKU>P-1-BLUE</SKU><Name>Blue</Name></Subproduct></Subproducts></Product>',
    );
    const census = parseBackfillCensusXml(nested);
    expect(census.ok).toBe(true);
    expect(census.records).toHaveLength(1);
    expect(census.records[0].sku).toBe('P-1');
    expect(census.countsBySku['P-1-RED']).toBeUndefined();
    expect(census.records[0].childSkus).toEqual(['P-1-BLUE', 'P-1-RED']);
    expect(Object.keys(census.records[0].blocks)).toContain('Subproducts');
  });

  it('dedupes a nested self-SKU and reports only distinct child identities', () => {
    const nested = namespacedDocument(
      '<Product><SKU>P-1</SKU><Name>Parent</Name>' +
        '<Subproducts><Subproduct><SKU>P-1</SKU><Name>Parent</Name></Subproduct>' +
        '<Subproduct><SKU>P-1-RED</SKU><Name>Red</Name></Subproduct></Subproducts></Product>',
    );
    expect(singleRecord(nested).childSkus).toEqual(['P-1-RED']);
  });

  it('fails closed on malformed XML instead of passing an empty census', () => {
    const census = parseBackfillCensusXml('<Product><SKU>Q-1</SKU><Name>Unclosed');
    expect(census.ok).toBe(false);
    expect(census.records).toHaveLength(0);
  });

  it('supports nested ProductOnPages semantic arrays in both layouts', () => {
    const modern = namespacedDocument(
      '<Product><SKU>Q-1</SKU><Name>Item</Name><ProductOnPages>' +
        '<PageLink><Name>Cat Supplies</Name></PageLink>' +
        '<PageLink><Name>Toys &amp; Fun</Name></PageLink></ProductOnPages></Product>',
    );
    const legacy = namespacedDocument(
      '<Product><SKU>Q-1</SKU><Name>Item</Name><ProductOnPages>' +
        '<Name>Toys &amp; Fun</Name><Name>Cat Supplies</Name></ProductOnPages></Product>',
    );
    const modernRecord = singleRecord(modern);
    const legacyRecord = singleRecord(legacy);
    expect(modernRecord.pages).toEqual(['Cat Supplies', 'Toys & Fun']);
    expect(diffBackfillRecords(modernRecord, legacyRecord)).toHaveLength(0);
  });
});

describe('backfill preflight entry (P0 #1)', () => {
  it('fails closed on an empty batch without touching the database', () => {
    const result = preflightBackfill({ workspaceId: WORKSPACE_ID, items: [], liveXml: '', outgoingXml: '' });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].field).toBe('batch');
  });
});

describe('backfill preflight gate (P0 #1)', () => {
  it("blocks an otherwise accepted PF23 edit when live Name is Foo's vs baseline Foos", () => {
    const base = baseProduct();
    base.core.name = 'Foos';
    const live = baseProduct();
    live.core.name = "Foo's";
    const item = changeSetItem(base, RUN_ID);
    const outgoing = JSON.parse(item.draftJson) as Product;
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml: liveDocument([live]),
        outgoingXml: liveDocument([outgoing]),
      },
      resolversWith(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.field === 'Name')).toBe(true);
    for (const issue of result.issues) {
      expect(JSON.stringify(issue)).not.toContain("Foo's");
      expect(JSON.stringify(issue)).not.toContain('Foos');
    }
  });

  it('blocks re-enabling when live PF1 drifted to a disabled marker', () => {
    const base = baseProduct();
    const live = baseProduct();
    live.customFields['ProductField1'] = 'disabled101321';
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [changeSetItem(base, RUN_ID)],
        liveXml: liveDocument([live]),
        outgoingXml: liveDocument([draft]),
      },
      resolversWith(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.field === 'ProductField1')).toBe(true);
  });

  it('passes a reviewed blank-UPC fill as one visible SKU-as-GTIN allowance', () => {
    // Blank-live fixture: the numeric baseline/live pair carries no catalog
    // GTIN, so ShopSite emits no GoogleGTIN tag; the SKU-derived `<GTIN>` is
    // the one-time blank-live fill under test. Nothing live is mutated.
    const base = baseProduct();
    base.sku = '12345678';
    base.id = 'numeric-item';
    base.core.name = 'Numeric Item';
    const liveBaseline = JSON.parse(JSON.stringify(base)) as Product;
    delete (liveBaseline.customFields as Record<string, string>)['ProductField23'];
    const live = JSON.parse(JSON.stringify(liveBaseline)) as Product;
    const liveXml = liveDocument([live]);
    expect(liveXml).toContain('<GTIN>12345678</GTIN>');
    expect(liveXml).not.toContain('<GoogleGTIN>');
    // Reviewed outgoing draft: the same numeric-SKU GTIN plus the reviewed
    // flavor delta. The item SKU is unchanged, so this cannot pass as a rename.
    const draft = JSON.parse(JSON.stringify(liveBaseline)) as Product;
    draft.customFields = { ...draft.customFields, ProductField23: 'Salmon' };
    const outgoingBase = liveBaseline;
    const now = new Date().toISOString();
    const item: ChangeSetItemRow = {
      id: 'item-gtin-fill',
      changeSetId: 'cs-1',
      sku: '12345678',
      operation: 'update',
      draftJson: JSON.stringify(draft),
      baseJson: JSON.stringify(outgoingBase),
      draftHash: 'hash',
      validationStatus: 'unknown',
      classificationRunId: RUN_ID,
      createdAt: now,
      updatedAt: now,
    };
    const flavored: ClassificationProposal = { ...fieldProposal('Salmon'), productSku: '12345678' };
    const completed: ClassificationRunRow = { ...completedCatalogRun(), productSku: '12345678' };
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml,
        outgoingXml: liveDocument([draft]),
      },
      resolversWith({ getRun: () => completed, getAcceptedProposals: () => [flavored] }),
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('blocks replacing a different live GTIN with the numeric SKU', () => {
    const base = baseProduct();
    base.sku = '12345678';
    base.id = 'numeric-item';
    base.core.name = 'Numeric Item';
    const liveBaseline = JSON.parse(JSON.stringify(base)) as Product;
    delete (liveBaseline.customFields as Record<string, string>)['ProductField23'];
    const live = JSON.parse(JSON.stringify(liveBaseline)) as Product;
    live.customFields = { ...live.customFields, GTIN: '000111222333' };
    const draft = JSON.parse(JSON.stringify(liveBaseline)) as Product;
    draft.customFields = { ...draft.customFields, ProductField23: 'Salmon' };
    const now = new Date().toISOString();
    const item: ChangeSetItemRow = {
      id: 'item-gtin-replace',
      changeSetId: 'cs-1',
      sku: '12345678',
      operation: 'update',
      draftJson: JSON.stringify(draft),
      baseJson: JSON.stringify(liveBaseline),
      draftHash: 'hash',
      validationStatus: 'unknown',
      classificationRunId: RUN_ID,
      createdAt: now,
      updatedAt: now,
    };
    const flavored: ClassificationProposal = { ...fieldProposal('Salmon'), productSku: '12345678' };
    const completed: ClassificationRunRow = { ...completedCatalogRun(), productSku: '12345678' };
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml: liveDocument([live]),
        outgoingXml: liveDocument([draft]),
      },
      resolversWith({ getRun: () => completed, getAcceptedProposals: () => [flavored] }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === '12345678' && issue.field === 'GTIN')).toBe(true);
  });

  it('blocks a nondefault live minimum quantity changed by the outgoing draft', () => {
    const base = baseProduct();
    const live = JSON.parse(JSON.stringify(base)) as Product;
    live.customFields = { ...live.customFields, MinimumQuantity: '2' };
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    draft.customFields = { ...draft.customFields, MinimumQuantity: '1' };
    const item = { ...changeSetItem(base, RUN_ID), draftJson: JSON.stringify(draft) };
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml: liveDocument([live]),
        outgoingXml: liveDocument([draft]),
      },
      resolversWith(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.field === 'MinimumQuantity')).toBe(true);
  });

  it('rejects a variant-bearing parent and lists distinct child identities', () => {
    // P0 #3 wave gate: one top-level Product with nine nested Subproducts
    // (one repeats the parent SKU) encodes a single top-level record but
    // fails with eight distinct child identities listed in the diff.
    const childSkus = ['MUCK-1', 'MUCK-2', 'MUCK-3', 'MUCK-4', 'MUCK-5', 'MUCK-6', 'MUCK-7', 'MUCK-8'];
    const nested = childSkus.map(child => `<Subproduct><SKU>${child}</SKU><Name>${child}</Name></Subproduct>`).join('');
    const parentXml =
      `<Product><SKU>MUCK-PARENT</SKU><Name>Muck Parent</Name><ProductField23>Chicken</ProductField23>` +
      `<Subproducts><Subproduct><SKU>MUCK-PARENT</SKU><Name>Muck Parent</Name></Subproduct>${nested}</Subproducts></Product>`;
    const liveXml = namespacedDocument(parentXml);
    const liveCensus = parseBackfillCensusXml(liveXml);
    expect(liveCensus.ok).toBe(true);
    expect(liveCensus.records).toHaveLength(1);
    expect(liveCensus.records[0].childSkus).toEqual(childSkus);
    const asProduct = singleRecord(liveXml);
    expect(asProduct.sku).toBe('MUCK-PARENT');
    expect(asProduct.childSkus).toHaveLength(8);
  });

  it('quarantines a variant-bearing parent at gate time on every side', () => {
    const base = baseProduct();
    base.sku = 'VAR-PARENT';
    base.id = 'variant-parent';
    base.core.name = 'Variant Parent';
    const draft = JSON.parse(JSON.stringify(base)) as Product;
    draft.customFields = { ...draft.customFields, ProductField23: 'Salmon' };
    const unchanged: Product = JSON.parse(JSON.stringify(base)) as Product;
    const withVariants = (source: Product): string => {
      const encoded = ShopSiteProductCodec.encode(source).xml;
      const block =
        '<Subproducts><Subproduct><SKU>VAR-PARENT</SKU><Name>Variant Parent</Name></Subproduct>' +
        '<Subproduct><SKU>VAR-RED</SKU><Name>Red</Name></Subproduct>' +
        '<Subproduct><SKU>VAR-BLUE</SKU><Name>Blue</Name></Subproduct></Subproducts>';
      return namespacedDocument(encoded.replace('</Product>', `${block}</Product>`));
    };
    const now = new Date().toISOString();
    const item: ChangeSetItemRow = {
      id: 'item-variant',
      changeSetId: 'cs-1',
      sku: 'VAR-PARENT',
      operation: 'update',
      draftJson: JSON.stringify(draft),
      baseJson: JSON.stringify(unchanged),
      draftHash: 'hash',
      validationStatus: 'unknown',
      classificationRunId: RUN_ID,
      createdAt: now,
      updatedAt: now,
    };
    const flavored: ClassificationProposal = { ...fieldProposal('Salmon'), productSku: 'VAR-PARENT' };
    const completed: ClassificationRunRow = { ...completedCatalogRun(), productSku: 'VAR-PARENT' };
    const resolvers = resolversWith({ getRun: () => completed, getAcceptedProposals: () => [flavored] });
    for (const side of ['live', 'baseline', 'upload'] as const) {
      const liveXml = side === 'live' ? withVariants(unchanged) : liveDocument([unchanged]);
      const outgoingXml = side === 'upload' ? withVariants(draft) : liveDocument([draft]);
      // Baseline-side quarantine uses variant-carrying product JSON: decode
      // the nested block into preserved state so the emitted baseline census
      // carries the distinct child SKUs.
      const variantBaseline = ShopSiteProductCodec.decode(withVariants(unchanged)).products[0];
      const items: ChangeSetItemRow[] = [{
        ...item,
        baseJson: side === 'baseline' ? JSON.stringify(variantBaseline) : JSON.stringify(unchanged),
        draftJson: side === 'baseline' ? JSON.stringify({ ...variantBaseline, customFields: { ...variantBaseline.customFields, ProductField23: 'Salmon' } }) : item.draftJson,
      }];
      const result = preflightBackfillWithResolvers(
        { workspaceId: WORKSPACE_ID, items, liveXml, outgoingXml },
        resolvers,
      );
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === 'VAR-PARENT' && issue.field === 'Subproducts')).toBe(true);
    }
  });

  it('passes an approved PF edit with unchanged built-ins and no GTIN change', () => {
    const base = baseProduct();
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    const item = { ...changeSetItem(base, RUN_ID), draftJson: JSON.stringify(draft) };
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml: liveDocument([base]),
        outgoingXml: liveDocument([draft]),
      },
      resolversWith(),
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails stale items whose accepted run no longer matches the draft value', () => {
    const base = baseProduct();
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    draft.customFields['ProductField23'] = 'Venison';
    const item = { ...changeSetItem(base, RUN_ID), draftJson: JSON.stringify(draft) };
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml: liveDocument([base]),
        outgoingXml: liveDocument([draft]),
      },
      resolversWith(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.field === 'ProductField23')).toBe(true);
  });

  it('fails unbound items and foreign or running runs', () => {
    const base = baseProduct();
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    const liveXml = liveDocument([base]);
    const outgoingXml = liveDocument([draft]);

    const unbound = preflightBackfillWithResolvers(
      { workspaceId: WORKSPACE_ID, items: [changeSetItem(base, null)], liveXml, outgoingXml },
      resolversWith(),
    );
    expect(unbound.ok).toBe(false);
    expect(unbound.issues.some((issue: BackfillPreflightIssue) => issue.field === 'classificationRun')).toBe(true);

    const foreign = preflightBackfillWithResolvers(
      { workspaceId: WORKSPACE_ID, items: [changeSetItem(base, RUN_ID)], liveXml, outgoingXml },
      resolversWith({ getRun: () => ({ ...completedCatalogRun(), workspaceId: 'other-workspace' }) }),
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.issues.some((issue: BackfillPreflightIssue) => issue.field === 'classificationRun')).toBe(true);

    const running = preflightBackfillWithResolvers(
      { workspaceId: WORKSPACE_ID, items: [changeSetItem(base, RUN_ID)], liveXml, outgoingXml },
      resolversWith({
        getRun: () => ({ ...completedCatalogRun(), status: 'running', completedAt: null }),
      }),
    );
    expect(running.ok).toBe(false);
    expect(running.issues.some((issue: BackfillPreflightIssue) => issue.field === 'classificationRun')).toBe(true);
  });

  it('never silently drops an intended SKU missing from the upload XML', () => {
    const base = baseProduct();
    const unrelated = baseProduct();
    unrelated.sku = 'OTHER-9';
    unrelated.core.name = 'Unrelated';
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [changeSetItem(base, RUN_ID)],
        liveXml: liveDocument([base]),
        outgoingXml: liveDocument([unrelated]),
      },
      resolversWith(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.reason.includes('silent drop'))).toBe(true);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === 'OTHER-9')).toBe(true);
  });

  it('fails reconciliation for an ungated child instead of reporting the parent alone', () => {
    // Post-import proof: the wave gated only the parent SKU, while a nested
    // child changed live. Reconciling the attempted set against fresh live
    // values must fail on the child-bearing parent rather than claim the
    // parent alone succeeded.
    const base = baseProduct();
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    const item = { ...changeSetItem(base, RUN_ID), draftJson: JSON.stringify(draft) };
    const childChanged = JSON.parse(JSON.stringify(base)) as Product;
    const changedXml = ShopSiteProductCodec.encode(childChanged).xml.replace(
      '</Product>',
      '<Subproducts><Subproduct><SKU>FOO-001-RED</SKU><Name>Red</Name></Subproduct></Subproducts></Product>',
    );
    const result = preflightBackfillWithResolvers(
      {
        workspaceId: WORKSPACE_ID,
        items: [item],
        liveXml: namespacedDocument(changedXml.replace('<Product>', '<Product>')),
        outgoingXml: liveDocument([draft]),
      },
      resolversWith(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.field === 'Subproducts')).toBe(true);
  });

  it('blocks duplicate live records for the same SKU in both orderings', () => {
    const base = baseProduct();
    const draft = JSON.parse(changeSetItem(base, RUN_ID).draftJson) as Product;
    const twin = baseProduct();
    twin.core.name = 'Twin Name';
    for (const liveSet of [[base, twin], [twin, base]]) {
      const result = preflightBackfillWithResolvers(
        {
          workspaceId: WORKSPACE_ID,
          items: [changeSetItem(base, RUN_ID)],
          liveXml: liveDocument(liveSet),
          outgoingXml: liveDocument([draft]),
        },
        resolversWith(),
      );
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue: BackfillPreflightIssue) => issue.sku === SKU && issue.reason.includes('more than once'))).toBe(true);
      for (const issue of result.issues) {
        expect(JSON.stringify(issue)).not.toContain('Twin Name');
      }
    }
  });
});
