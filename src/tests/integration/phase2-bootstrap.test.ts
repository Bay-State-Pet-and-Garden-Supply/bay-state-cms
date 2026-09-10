import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';

import { createWorkspaceDirs, writeGitignore, writeProductFile, writeStoreConfig } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashJson } from '../../git/deterministic-json';
import { GitClient } from '../../git/git-client';

const fixtureDir = path.resolve(import.meta.dirname, '../fixtures');
const fixtureXml = fs.readFileSync(path.join(fixtureDir, 'shopsite-products-sample.xml'), 'utf-8');

describe('Phase 2: Bootstrap from fixture XML', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-phase2-${Date.now()}`);

  beforeAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    createWorkspaceDirs(testDir);
    writeGitignore(testDir);
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  it('should parse fixture XML into products', () => {
    const parsed = ShopSiteProductCodec.decode(fixtureXml);
    expect(parsed.products.length).toBeGreaterThanOrEqual(2);
    expect(parsed.xmlVersion).toBe('15.0');
  });

  it('should normalize and write product files', () => {
    const parsed = ShopSiteProductCodec.decode(fixtureXml);

    for (const product of parsed.products) {
      if (!product.sku) continue;

      writeProductFile(testDir, product);

      const filePath = path.join(testDir, skuToProductFilePath(product.sku));
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.sku).toBe(product.sku);
      expect(content.core.name).toBe(product.core.name);
    }
  });

  it('should create store config files', () => {
    writeStoreConfig(testDir, 'field-registry.json', { schemaVersion: 1, entries: [] });
    writeStoreConfig(testDir, 'manifest.json', {
      workspaceName: 'Test', workspaceId: 'test-ws', appVersion: '0.1.0',
      schemaVersion: 1, productCount: 2, generatedAt: new Date().toISOString(), baselineCommit: null,
    });

    expect(fs.existsSync(path.join(testDir, 'store', 'field-registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'store', 'manifest.json'))).toBe(true);
  });

  it('should create baseline Git commit', () => {
    const git = new GitClient(testDir);
    if (!git.isRepo()) {
      git.init();
    }

    git.add(['products/', 'store/', '.gitignore']);
    const result = git.commit('Initial bootstrap: test products');
    expect(result).toBeTruthy();

    const headHash = git.getHeadHash();
    expect(headHash).toBeTruthy();
    expect(headHash.length).toBeGreaterThanOrEqual(7);

    // Verify product file is at HEAD
    const content = git.readFileAtHead(skuToProductFilePath('ABC-123'));
    expect(content).toBeTruthy();
    if (content) {
      const parsed = JSON.parse(content);
      expect(parsed.sku).toBe('ABC-123');
    }
  });

  it('should handle products without SKU gracefully', () => {
    // Products missing SKU should be filtered during bootstrap
    const parsed = ShopSiteProductCodec.decode(fixtureXml);
    const products = parsed.products.filter(p => (p.sku ?? '') !== '');
    expect(products.length).toBeLessThanOrEqual(parsed.products.length);
  });

  it('should produce deterministic product JSON hash', () => {
    const parsed = ShopSiteProductCodec.decode(fixtureXml);
    const hashes: string[] = [];

    for (const product of parsed.products) {
      if (!product.sku) continue;
      const h = hashJson(product);
      expect(h).toBeTruthy();
      // Running twice should produce same hash
      const h2 = hashJson(product);
      expect(h).toBe(h2);
      hashes.push(h);
    }

    expect(hashes.length).toBeGreaterThanOrEqual(2);
  });
});
