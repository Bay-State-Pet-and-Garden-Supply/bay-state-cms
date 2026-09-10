import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitClient } from '../../git/git-client';
import { createWorkspaceDirs, writeGitignore, writeProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Git Workspace Init', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-test-${Date.now()}`);
  beforeAll(() => {
    // Clean up first
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  it('should create workspace directories', () => {
    const dirs = createWorkspaceDirs(testDir);

    expect(fs.existsSync(dirs.products)).toBe(true);
    expect(fs.existsSync(dirs.store)).toBe(true);
    expect(fs.existsSync(dirs.exports)).toBe(true);
    expect(fs.existsSync(dirs.dotShopsite)).toBe(true);
  });

  it('should write .gitignore', () => {
    writeGitignore(testDir);

    const gitignorePath = path.join(testDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('app.db');
  });

  it('should initialize a git repo', () => {
    const git = new GitClient(testDir);

    expect(git.isInstalled()).toBe(true);
    expect(git.isRepo()).toBe(false);

    git.init();
    expect(git.isRepo()).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.git'))).toBe(true);
  });

  it('should write a deterministic product file', () => {
    const product = {
      schemaVersion: 1 as const,
      id: 'test-uuid',
      sku: 'TEST-001',
      status: 'active' as const,
      core: {
        name: 'Test Product',
        price: '19.99',
        salePrice: null,
        description: null,
        inventory: { quantityOnHand: 10, lowStockThreshold: null, outOfStockLimit: null },
        availability: null,
        weight: null,
        taxable: true,
        media: { primary: null, additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {},
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
    };

    writeProductFile(testDir, product);

    const filePath = path.join(testDir, skuToProductFilePath('TEST-001'));
    expect(fs.existsSync(filePath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.sku).toBe('TEST-001');
    expect(parsed.core.name).toBe('Test Product');
  });

  it('should stage and commit', () => {
    const git = new GitClient(testDir);

    git.add(['products/', 'store/', '.gitignore']);
    const output = git.commit('Initial commit: test products');
    expect(output).toBeTruthy();

    const hash = git.getHeadHash();
    expect(hash).toBeTruthy();
    expect(hash.length).toBeGreaterThanOrEqual(7);
  });

  it('should track product file at HEAD', () => {
    const git = new GitClient(testDir);
    const content = git.readFileAtHead(skuToProductFilePath('TEST-001'));
    expect(content).toBeTruthy();

    if (content) {
      const parsed = JSON.parse(content);
      expect(parsed.sku).toBe('TEST-001');
    }
  });
});
