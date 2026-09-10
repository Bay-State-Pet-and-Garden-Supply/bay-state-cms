import { randomUUID } from 'node:crypto';
import { unlinkSync, rmSync, existsSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { writeProductFile, createWorkspaceDirs } from '../../git/workspace-files';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { validateCatalogHealth, getCatalogHealthReport } from '../../server/services/product-service';
import type { Product } from '../../shared/types';

describe('Catalog Health Check', () => {
  const testDbPath = '/tmp/baystate-cms-health-test.db';
  const testWorkspacePath = '/tmp/baystate-cms-health-workspace';
  const workspaceId = randomUUID();

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create workspace structure
    createWorkspaceDirs(testWorkspacePath);

    // Insert workspace into DB
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Health Test Store', testWorkspacePath, `${testWorkspacePath}/.git`, now, now, 'complete'],
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(testWorkspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('should scan catalog and detect healthy and unhealthy products', () => {
    const now = new Date().toISOString();

    // Setup: register a required custom field and a number custom field
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: 'ProductField1',
      label: 'Brand Name',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: true,
      uiGroup: null,
      sampleValuesJson: null,
      createdAt: now,
      updatedAt: now,
    });

    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: 'ProductField2',
      label: 'Weight Lbs',
      kind: 'custom',
      dataType: 'number',
      editable: true,
      required: false,
      uiGroup: null,
      sampleValuesJson: null,
      createdAt: now,
      updatedAt: now,
    });

    // 1. Create a perfectly healthy product
    const healthyProduct: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'HEALTHY-001',
      status: 'active',
      core: {
        name: 'Super Healthy Widget',
        price: '19.99',
        salePrice: null,
        description: 'A very healthy and complete widget.',
        inventory: { quantityOnHand: 50, lowStockThreshold: 5, outOfStockLimit: 0 },
        availability: 'in-stock',
        weight: '1.2',
        taxable: true,
        media: { primary: '/images/healthy.jpg', additional: [] },
        seo: { fileName: 'healthy-widget.html', searchKeywords: 'healthy, widget', googleProductCategory: '' },
        productOnPages: [],
      },
      customFields: {
        ProductField1: 'Acme Corp', // required field filled
        ProductField2: '1.5',       // number field is valid number
      },
      shopsite: {
        productId: '101',
        productGuid: 'guid-healthy',
        xmlVersion: '15.0',
        lastPulledAt: now,
        lastRemoteHash: 'hash',
        lastSyncedAt: now,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    // 2. Create a product with warnings (missing price, description, and primary image)
    const warningProduct: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'WARN-002',
      status: 'active',
      core: {
        name: 'Warning Widget',
        price: null, // warning: missing price
        salePrice: null,
        description: '', // warning: missing description
        inventory: { quantityOnHand: 0, lowStockThreshold: null, outOfStockLimit: null },
        availability: null,
        weight: null,
        taxable: true,
        media: { primary: '', additional: [] }, // warning: missing image
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {
        ProductField1: 'Brandless', // required field filled
      },
      shopsite: {
        productId: '102',
        productGuid: 'guid-warn',
        xmlVersion: '15.0',
        lastPulledAt: now,
        lastRemoteHash: 'hash',
        lastSyncedAt: now,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    // 3. Create an unhealthy product (missing name, missing required custom field, invalid custom field number)
    const unhealthyProduct: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'BAD-003',
      status: 'active',
      core: {
        name: '', // blocker: missing name
        price: 'abc', // blocker: invalid price number
        salePrice: null,
        description: 'A bad product.',
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null,
        weight: null,
        taxable: true,
        media: { primary: '/images/bad.jpg', additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {
        ProductField1: '', // blocker: missing required custom field
        ProductField2: 'not-a-number', // blocker: invalid number format
      },
      shopsite: {
        productId: '103',
        productGuid: 'guid-bad',
        xmlVersion: '15.0',
        lastPulledAt: now,
        lastRemoteHash: 'hash',
        lastSyncedAt: now,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    // Write products to workspace files
    writeProductFile(testWorkspacePath, healthyProduct);
    writeProductFile(testWorkspacePath, warningProduct);
    writeProductFile(testWorkspacePath, unhealthyProduct);

    // Index products in sqlite DB
    insertProductIndex({
      id: healthyProduct.id,
      sku: healthyProduct.sku,
      filePath: `products/${healthyProduct.sku}.json`,
      title: healthyProduct.core.name,
      status: healthyProduct.status,
      price: healthyProduct.core.price,
      inventoryQuantity: healthyProduct.core.inventory.quantityOnHand,
      primaryImage: healthyProduct.core.media.primary,
      productHash: 'hash1',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
    });

    insertProductIndex({
      id: warningProduct.id,
      sku: warningProduct.sku,
      filePath: `products/${warningProduct.sku}.json`,
      title: warningProduct.core.name,
      status: warningProduct.status,
      price: warningProduct.core.price,
      inventoryQuantity: warningProduct.core.inventory.quantityOnHand,
      primaryImage: warningProduct.core.media.primary,
      productHash: 'hash2',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
    });

    insertProductIndex({
      id: unhealthyProduct.id,
      sku: unhealthyProduct.sku,
      filePath: `products/${unhealthyProduct.sku}.json`,
      title: unhealthyProduct.core.name,
      status: unhealthyProduct.status,
      price: unhealthyProduct.core.price,
      inventoryQuantity: unhealthyProduct.core.inventory.quantityOnHand,
      primaryImage: unhealthyProduct.core.media.primary,
      productHash: 'hash3',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Run catalog-wide health check validation
    const report = validateCatalogHealth(workspaceId, testWorkspacePath);

    expect(report.totalProducts).toBe(3);
    expect(report.healthyProducts).toBe(1); // Only healthyProduct is 100% clean
    expect(report.unhealthyProducts).toBe(2); // warningProduct and unhealthyProduct both have issues

    // Detailed issues checks
    const badIssues = report.issues.filter(i => i.sku === 'BAD-003');
    expect(badIssues.length).toBeGreaterThanOrEqual(4); // missing name, invalid price, missing ProductField1, invalid ProductField2 format
    
    // Check missing name issue
    const nameIssue = badIssues.find(i => i.code === 'MISSING_NAME');
    expect(nameIssue).toBeDefined();
    expect(nameIssue?.severity).toBe('blocker');

    // Check invalid price format issue
    const priceIssue = badIssues.find(i => i.code === 'INVALID_PRICE');
    expect(priceIssue).toBeDefined();
    expect(priceIssue?.severity).toBe('blocker');

    // Check missing required custom field issue
    const requiredFieldIssue = badIssues.find(i => i.code === 'MISSING_REQUIRED_FIELD');
    expect(requiredFieldIssue).toBeDefined();
    expect(requiredFieldIssue?.severity).toBe('blocker');

    // Check invalid number format issue
    const numberFormatIssue = badIssues.find(i => i.code === 'INVALID_NUMBER_FORMAT');
    expect(numberFormatIssue).toBeDefined();
    expect(numberFormatIssue?.severity).toBe('blocker');

    // Warning product checks
    const warnIssues = report.issues.filter(i => i.sku === 'WARN-002');
    expect(warnIssues.length).toBeGreaterThanOrEqual(3); // missing price, missing description, missing image

    const missingPrice = warnIssues.find(i => i.code === 'MISSING_PRICE');
    expect(missingPrice).toBeDefined();
    expect(missingPrice?.severity).toBe('warning');

    const missingDesc = warnIssues.find(i => i.code === 'MISSING_DESCRIPTION');
    expect(missingDesc).toBeDefined();
    expect(missingDesc?.severity).toBe('warning');

    const missingImg = warnIssues.find(i => i.code === 'MISSING_PRIMARY_IMAGE');
    expect(missingImg).toBeDefined();
    expect(missingImg?.severity).toBe('warning');

    // Retrieve report using getCatalogHealthReport()
    const storedReport = getCatalogHealthReport();
    expect(storedReport.totalProducts).toBe(3);
    expect(storedReport.healthyProducts).toBe(1);
    expect(storedReport.unhealthyProducts).toBe(2);
    expect(storedReport.issues.length).toBe(report.issues.length);
  });
});
