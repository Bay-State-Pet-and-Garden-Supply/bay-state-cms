import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExportPackage } from '../../shopsite/export-package';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>NOIMG-001</SKU><Name>No Image Widget</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/missing-widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

describe('export missing images (P2 #24)', () => {
  it('returns a successful XML-only package with warning and no ZIP', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-export-24-'));
    const products = ShopSiteProductCodec.decode(BASE_XML).products;
    const result = await createExportPackage(workspacePath, 'cs-noimg', products, { changeSetTitle: 'No images' });

    // Successful XML path, no ZIP, explicit warning, accurate manifest.
    expect(fs.existsSync(result.xmlPath)).toBe(true);
    expect(result.zipPath).toBeNull();
    expect(result.missingImagesWarning).toContain('absent from disk');
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8')) as {
      productCount: number; productSkus: string[]; imagesZip: null; warning: string;
    };
    expect(manifest.productCount).toBe(1);
    expect(manifest.productSkus).toEqual(['NOIMG-001']);
    expect(manifest.imagesZip).toBeNull();
    expect(manifest.warning).toContain('absent from disk');

    // Image references unchanged (never claimed as a ZIP).
    const xml = fs.readFileSync(result.xmlPath, 'utf-8');
    expect(xml).toContain('media/missing-widget.jpg');
    expect(fs.existsSync(path.join(workspacePath, 'exports', 'cs-noimg', 'shopsite-images.zip'))).toBe(false);

    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('still fails closed on malformed preserved XML', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-export-24-bad-'));
    const products = ShopSiteProductCodec.decode(BASE_XML).products;
    products[0].shopsite.preserved.unknownElements['Broken'] = '[object Object]';
    await expect(createExportPackage(workspacePath, 'cs-bad', products)).rejects.toThrow();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
});
