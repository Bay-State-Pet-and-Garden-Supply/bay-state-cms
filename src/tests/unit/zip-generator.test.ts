import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createImagesZip, assertZipHasImages } from '../../shopsite/zip-generator';
import type { Product } from '../../shared/types';

describe('zip-generator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-gen-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles products with undefined core.media.additional without crashing', async () => {
    // Setup mock image
    const imageRelPath = 'products/images/earth-animal/test-chew.jpg';
    const imageFullPath = path.join(tmpDir, imageRelPath);
    fs.mkdirSync(path.dirname(imageFullPath), { recursive: true });
    fs.writeFileSync(imageFullPath, 'fake-image-binary-data');

    const products: Product[] = [
      {
        schemaVersion: 1,
        id: 'id-EA-001',
        sku: 'EA-001',
        status: 'active',
        core: {
          name: 'Earth Animal No-Hide Chew',
          price: '9.99',
          salePrice: null,
          description: 'A good chew',
          inventory: { quantityOnHand: 10, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: '1.00',
          taxable: true,
          media: {
            primary: 'earth-animal/test-chew.jpg',
            additional: undefined as unknown as string[], // Explicitly undefined to simulate the bug
          },
          seo: { fileName: 'test-chew.html', searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
        },
        customFields: {
          ProductField16: 'Earth Animal',
        },
        shopsite: {
          productId: null,
          productGuid: null,
          xmlVersion: '15.0',
          lastPulledAt: null,
          lastRemoteHash: null,
          lastSyncedAt: null,
          source: { dbname: 'products', uniqueName: 'SKU' },
          preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
        },
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        },
      },
    ];

    const zipPath = path.join(tmpDir, 'test-output.zip');
    await createImagesZip(tmpDir, products, zipPath);

    expect(fs.existsSync(zipPath)).toBe(true);
    expect(() => assertZipHasImages(zipPath, products)).not.toThrow();

    const stat = fs.statSync(zipPath);
    expect(stat.size).toBeGreaterThan(100);
  });
});
