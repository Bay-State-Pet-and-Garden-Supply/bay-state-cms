import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCatalogEvidence, renderCatalogEvidence } from '../../classification/catalog-evidence';

const roots: string[] = [];

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-evidence-test-'));
  fs.mkdirSync(path.join(root, 'products', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'products', 'images'), { recursive: true });
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  roots.push(root);
  return root;
}

function writeProduct(root: string, relative: string, product: unknown): void {
  fs.writeFileSync(path.join(root, 'products', relative), JSON.stringify(product), 'utf-8');
}

const pageFragment = (names: string[]) => `<ProductOnPages>\n${names.map(name => `<PageLink>\n<Name>${name}</Name>\n</PageLink>`).join('\n')}\n</ProductOnPages>`;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('catalog evidence scan', () => {
  it('scans delimiter evidence for ProductField26..32 (previously unscanned range)', async () => {
    const root = tempWorkspace();
    writeProduct(root, 'a.json', {
      sku: 'SKU-A',
      customFields: { ProductField26: 'Squeak|Crinkle', ProductField32: '111|222|333' },
    });

    const evidence = await scanCatalogEvidence(root);

    const pf26 = evidence.fields.find(field => field.xmlField === 'ProductField26')!;
    expect(pf26.delimiterEvidence).toContainEqual({ character: '|', occurrenceCount: 1 });
    const pf32 = evidence.fields.find(field => field.xmlField === 'ProductField32')!;
    expect(pf32.delimiterEvidence).toContainEqual({ character: '|', occurrenceCount: 2 });
  });

  it('records field counts, distinct-value hashes, delimiter evidence, pages, and parse failures deterministically', async () => {
    const root = tempWorkspace();

    writeProduct(root, 'a.json', {
      sku: 'SKU-A',
      customFields: {
        ProductField16: 'Kong',
        ProductField17: 'Dog|Cat',
        ProductField24: 'Dog Food',
      },
      shopsite: {
        preserved: {
          advancedBlocks: {
            ProductOnPages: pageFragment(['Farm Animal Chicken &amp; Poultry', 'Dog Food']),
          },
        },
      },
    });
    writeProduct(root, 'sub/b.json', {
      sku: 'SKU-B',
      customFields: {
        ProductField16: 'Kong',
        ProductField17: 'Dog',
        ProductField24: '',
      },
    });
    // Media directories are never product records.
    writeProduct(root, 'images/not-a-product.json', { sku: 'SKIP', customFields: { ProductField16: 'x' } });
    // Malformed JSON is counted as a parse failure, never silently dropped.
    fs.writeFileSync(path.join(root, 'products', 'broken.json'), '{not json', 'utf-8');

    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({ entries: [
        { xmlField: 'ProductField16', label: 'Brand' },
        { xmlField: 'ProductField24', label: 'Department' },
      ] }),
      'utf-8',
    );

    const evidence = await scanCatalogEvidence(root);

    expect(evidence.productFileCount).toBe(2);
    expect(evidence.parseFailureCount).toBe(1);
    expect(evidence.parseFailures).toEqual([{ path: 'products/broken.json', reason: expect.any(String) }]);

    // Sorted by xmlField, ProductField16 < ProductField17 < ProductField24.
    expect(evidence.fields.map(field => field.xmlField)).toEqual(['ProductField16', 'ProductField17', 'ProductField24']);

    const pf16 = evidence.fields[0];
    expect(pf16.recordCount).toBe(2);
    expect(pf16.nonEmptyCount).toBe(2);
    expect(pf16.distinctValueCount).toBe(1);
    expect(pf16.distinctValueHash).toMatch(/^[a-f0-9]{64}$/);

    const pf17 = evidence.fields[1];
    expect(pf17.recordCount).toBe(2);
    expect(pf17.nonEmptyCount).toBe(2);
    // Pipe-delimited compound value contributes one '|' occurrence.
    expect(pf17.delimiterEvidence).toContainEqual({ character: '|', occurrenceCount: 1 });

    const pf24 = evidence.fields[2];
    expect(pf24.recordCount).toBe(2);
    expect(pf24.nonEmptyCount).toBe(1);
    expect(pf24.distinctValueCount).toBe(1);

    // XML entity decoding and page observations with sample SKUs.
    expect(evidence.pages.map(page => page.pageName)).toEqual(['Dog Food', 'Farm Animal Chicken & Poultry']);
    const dogFoodPage = evidence.pages.find(page => page.pageName === 'Dog Food')!;
    expect(dogFoodPage.productCount).toBe(1);
    expect(dogFoodPage.sampleSkus).toEqual(['SKU-A']);

    expect(evidence.fieldRegistry.entryCount).toBe(2);
    expect(evidence.fieldRegistry.xmlFields).toEqual(['ProductField16', 'ProductField24']);
    expect(evidence.sourceTreeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces byte-identical evidence for identical inputs', async () => {
    const root = tempWorkspace();
    writeProduct(root, 'a.json', {
      sku: 'SKU-A',
      customFields: { ProductField16: 'Kong', ProductField17: 'Dog|Cat' },
    });
    writeProduct(root, 'b.json', {
      sku: 'SKU-B',
      customFields: { ProductField16: 'Blue', ProductField17: 'Cat' },
    });
    fs.writeFileSync(path.join(root, 'store', 'field-registry.json'), JSON.stringify({ entries: [{ xmlField: 'ProductField16', label: 'Brand' }] }), 'utf-8');

    const first = await scanCatalogEvidence(root);
    const second = await scanCatalogEvidence(root);

    expect(first.sourceTreeHash).toBe(second.sourceTreeHash);
    expect(renderCatalogEvidence(first)).toBe(renderCatalogEvidence(second));
  });

  it('records an empty evidence artifact for an empty workspace', async () => {
    const root = tempWorkspace();
    const evidence = await scanCatalogEvidence(root);
    expect(evidence.productFileCount).toBe(0);
    expect(evidence.parseFailureCount).toBe(0);
    expect(evidence.fields).toEqual([]);
    expect(evidence.pages).toEqual([]);
    expect(evidence.fieldRegistry.entryCount).toBe(0);
  });

  it('C8: the evidence hash derives from the canonical xmlField projection, not raw file bytes', async () => {
    const root = tempWorkspace();
    writeProduct(root, 'a.json', {
      sku: 'SKU-A',
      customFields: { ProductField16: 'Kong', ProductField24: 'Dog Food' },
    });
    writeProduct(root, 'b.json', {
      sku: 'SKU-B',
      customFields: { ProductField16: 'Blue', ProductField24: 'Cat Food' },
    });

    // Baseline: an incidental registry shape (labels, formatting, extra
    // display metadata, extra keys, indentation).
    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { xmlField: 'ProductField16', label: 'Brand', kind: 'custom' },
          { xmlField: 'ProductField24', label: 'Department' },
        ],
      }, null, 4),
      'utf-8',
    );
    const baseline = await scanCatalogEvidence(root);

    // Same xmlField set, completely different labels/formatting/key order and
    // a new curatedFields entry — the evidence hash must be unchanged (C8:
    // incidental JSON formatting / labels / curatedFieldsJson never enter it).
    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({
        entries: [
          { curatedFieldsJson: '["label"]', uiGroup: 'Custom Fields', label: 'Renamed Brand Label', xmlField: 'ProductField16' },
          { xmlField: 'ProductField24', label: 'Department Renamed' },
        ],
      }, null, 2) + '\n',
      'utf-8',
    );
    const cosmetic = await scanCatalogEvidence(root);
    expect(cosmetic.sourceTreeHash).toBe(baseline.sourceTreeHash);
    expect(renderCatalogEvidence(cosmetic)).toBe(renderCatalogEvidence(baseline));

    // Adding a Catalog Field changes the projection hash (set membership).
    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({ entries: [
        { xmlField: 'ProductField16', label: 'Brand' },
        { xmlField: 'ProductField24', label: 'Department' },
        { xmlField: 'ProductField25', label: 'New Field' },
      ] }),
      'utf-8',
    );
    const added = await scanCatalogEvidence(root);
    expect(added.sourceTreeHash).not.toBe(baseline.sourceTreeHash);

    // Removing a field changes the projection hash again.
    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({ entries: [{ xmlField: 'ProductField16', label: 'Brand' }] }),
      'utf-8',
    );
    const removed = await scanCatalogEvidence(root);
    expect(removed.sourceTreeHash).not.toBe(baseline.sourceTreeHash);
    expect(removed.sourceTreeHash).not.toBe(added.sourceTreeHash);
  });
});
