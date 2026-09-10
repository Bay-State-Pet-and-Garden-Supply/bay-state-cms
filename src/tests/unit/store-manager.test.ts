import { randomUUID } from 'node:crypto';
import { unlinkSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { writeProductFile, createWorkspaceDirs } from '../../git/workspace-files';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { getLevenshteinDistance, generateProductFieldAuditReport } from '../../server/services/catalog-insight-service';
import {
  generateDeterministicProposals,
  listProposals,
  getProposalById,
  applyProposal,
  dismissProposal,
  ProposalNotFoundError,
} from '../../server/services/product-field-refactor-service';
import {
  insertProposal,
  updateProposalStatus,
  deleteGeneratedProposals,
  findDuplicateProposal,
  dismissProposal as repoDismissProposal,
} from '../../db/repositories/catalog-health-proposal-repo';
import { CatalogProposalSchema } from '../../shared/schemas/catalog-health-proposal';
import { getProductWithDraft } from '../../server/services/product-service';
import type { Product } from '../../shared/types';

describe('Store Manager AI Assistant & Cleanup Tool', () => {
  const testDbPath = '/tmp/baystate-cms-store-manager-test.db';
  const testWorkspacePath = '/tmp/baystate-cms-store-manager-workspace';
  const testWorkspacePathB = '/tmp/baystate-cms-store-manager-workspace-b';
  const workspaceId = randomUUID();
  const workspaceIdB = randomUUID();

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create workspace structures
    createWorkspaceDirs(testWorkspacePath);
    createWorkspaceDirs(testWorkspacePathB);

    // Insert workspaces into DB
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Store Manager Test Store', testWorkspacePath, `${testWorkspacePath}/.git`, now, now, 'complete'],
    );
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceIdB, 'Store Manager Test Store B', testWorkspacePathB, `${testWorkspacePathB}/.git`, now, now, 'complete'],
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(testWorkspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { rmSync(testWorkspacePathB, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('should calculate Levenshtein distance correctly', () => {
    expect(getLevenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(getLevenshteinDistance('cat supplies', 'cat supplies')).toBe(0);
    expect(getLevenshteinDistance('cat supplies', 'cat-supplies')).toBe(1);
    expect(getLevenshteinDistance('brand', 'brandy')).toBe(1);
  });

  it('should audit custom ProductFields and generate deterministic proposals', () => {
    const now = new Date().toISOString();

    // Create products with casing duplicates and typos in ProductField24 (Category)
    // "Cat Supplies" (freq 3), "cat supplies" (freq 1), "Cat Suplies" (freq 1, typo)
    const p1: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-001',
      status: 'active',
      core: { name: 'Cat Toy A', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'a.html', searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
      customFields: { ProductField24: 'Cat Supplies' },
      shopsite: { productId: '1', productGuid: 'g1', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p2: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-002',
      status: 'active',
      core: { name: 'Cat Toy B', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'b.html', searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
      customFields: { ProductField24: 'Cat Supplies' },
      shopsite: { productId: '2', productGuid: 'g2', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p3: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-003',
      status: 'active',
      core: { name: 'Cat Toy C', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'c.html', searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
      customFields: { ProductField24: 'cat supplies' }, // casing duplicate
      shopsite: { productId: '3', productGuid: 'g3', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p4: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-004',
      status: 'active',
      core: { name: 'Cat Toy D', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'd.html', searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
      customFields: { ProductField24: 'Cat Suplies' }, // typo
      shopsite: { productId: '4', productGuid: 'g4', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p5: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-005',
      status: 'active',
      core: { name: 'Cat Toy E', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'e.html', searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
      customFields: { ProductField24: ' Cat Supplies ' }, // leading/trailing whitespace
      shopsite: { productId: '5', productGuid: 'g5', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p6: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-999',
      status: 'active',
      core: { name: 'Dog Toy A', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'f.html', searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
      customFields: { ProductField24: 'Dog Supplies ' }, // trailing whitespace, no casing duplicates
      shopsite: { productId: '6', productGuid: 'g6', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    // Add extra active products with 'Cat Supplies' so that total catalog > 10 (singleton checks)
    // and 'Cat Supplies' frequency becomes high enough (casing / typo consensus rules)
    const extraProducts: Product[] = [];
    for (let i = 6; i <= 15; i++) {
      extraProducts.push({
        schemaVersion: 1,
        id: randomUUID(),
        sku: `SKU-0${i}`,
        status: 'active',
        core: { name: `Cat Toy ${i}`, price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: `${i}.html`, searchKeywords: null, googleProductCategory: '' }, productOnPages: [] },
        customFields: { ProductField24: 'Cat Supplies' },
        shopsite: { productId: String(i), productGuid: `g${i}`, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
        metadata: { createdAt: now, updatedAt: now, archivedAt: null },
      });
    }

    // Write files and insert index rows
    for (const p of [p1, p2, p3, p4, p5, p6, ...extraProducts]) {
      writeProductFile(testWorkspacePath, p);
      insertProductIndex({
        id: p.id,
        sku: p.sku,
        filePath: `${testWorkspacePath}/products/${p.sku}.json`,
        title: p.core.name,
        status: p.status,
        price: p.core.price,
        inventoryQuantity: p.core.inventory.quantityOnHand,
        primaryImage: p.core.media.primary,
        productHash: 'hash',
        lastApprovedCommit: null,
        lastPulledRemoteHash: null,
        lastSyncedRemoteHash: null,
        lastSyncedAt: null,
        syncStatus: 'not_synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: now,
        updatedAt: now,
        description: p.core.description,
        searchKeywords: p.core.seo.searchKeywords,
        customFields: p.customFields,
      });
    }

    // 1. Check Audit Report
    const report = generateProductFieldAuditReport(workspaceId, 'ProductField24');
    expect(report.uniqueValueCount).toBe(5); // 'Cat Supplies', 'cat supplies', 'Cat Suplies', ' Cat Supplies ', 'Dog Supplies '
    expect(report.casingDuplicates.length).toBe(1); // 'Cat Supplies' vs 'cat supplies' (trimmed check)
    expect(report.suspiciousValues.length).toBe(4); // ' Cat Supplies ', 'Cat Suplies', 'cat supplies', 'Dog Supplies '

    // 2. Generate Proposals
    const createdProposals = generateDeterministicProposals(workspaceId, 'ProductField24');
    expect(createdProposals.length).toBe(4);

    const casingProp = createdProposals.find(p => p.reason === 'casing normalization');
    expect(casingProp).toBeDefined();
    expect(casingProp?.oldValue).toBe('cat supplies');
    expect(casingProp?.newValue).toBe('Cat Supplies');
    expect(casingProp?.affectedSkus).toEqual(['SKU-003']);

    const trimProp = createdProposals.find(p => p.reason === 'trim whitespace');
    expect(trimProp).toBeDefined();
    expect(trimProp?.oldValue).toBe('Dog Supplies ');
    expect(trimProp?.newValue).toBe('Dog Supplies');
    expect(trimProp?.affectedSkus).toEqual(['SKU-999']);

    // 3. Apply casing normalization proposal
    const result = applyProposal(workspaceId, testWorkspacePath, casingProp!.id);
    expect(result.changeSetId).toBeDefined();

    // Verify the proposal status was updated in DB
    const updatedProp = getProposalById(workspaceId, casingProp!.id);
    expect(updatedProp?.status).toBe('applied');
    expect(updatedProp?.changeSetId).toBe(result.changeSetId);

    // Verify the product draft overlay has the new value
    const productWithDraft = getProductWithDraft(workspaceId, testWorkspacePath, 'SKU-003');
    expect(productWithDraft.draft).toBeDefined();
    expect(productWithDraft.merged?.customFields?.ProductField24).toBe('Cat Supplies');

    // 4. Dismiss trim whitespace proposal
    dismissProposal(workspaceId, trimProp!.id);
    const dismissedProp = getProposalById(workspaceId, trimProp!.id);
    expect(dismissedProp?.status).toBe('dismissed');
  });

  it('workspace B cannot read, dismiss, or apply proposals owned by workspace A (and vice versa)', () => {
    // A fresh proposal in workspace A so cross-workspace attempts can be
    // proven to leave it untouched.
    const freshA = insertProposal({
      workspaceId,
      field: 'ProductField88',
      oldValue: 'Fresh Value',
      newValue: 'Canonical',
      affectedSkus: ['SKU-001'],
      reason: 'test',
      confidence: 0.9,
      source: 'deterministic',
      status: 'proposed',
    });

    // A proposal owned by workspace B (distinct field to keep deletes scoped).
    const bProp = insertProposal({
      workspaceId: workspaceIdB,
      field: 'ProductField99',
      oldValue: 'B Value',
      newValue: 'B Canonical',
      affectedSkus: [],
      reason: 'test',
      confidence: 0.9,
      source: 'deterministic',
      status: 'proposed',
    });

    // Scoped reads: each workspace sees only its own rows; foreign and unknown
    // ids return the same null external result.
    expect(getProposalById(workspaceIdB, freshA.id)).toBeNull();
    expect(getProposalById(workspaceId, freshA.id)?.id).toBe(freshA.id);
    expect(getProposalById(workspaceId, bProp.id)).toBeNull();
    expect(getProposalById(workspaceIdB, bProp.id)?.id).toBe(bProp.id);
    expect(getProposalById(workspaceId, 'no-such-proposal')).toBeNull();
    expect(getProposalById(workspaceIdB, 'no-such-proposal')).toBeNull();

    // Cross-workspace dismiss fails closed and mutates nothing.
    expect(() => dismissProposal(workspaceIdB, freshA.id)).toThrow(ProposalNotFoundError);
    expect(getProposalById(workspaceId, freshA.id)?.status).toBe('proposed');
    expect(() => dismissProposal(workspaceId, bProp.id)).toThrow(ProposalNotFoundError);
    expect(getProposalById(workspaceIdB, bProp.id)?.status).toBe('proposed');

    // Cross-workspace apply fails before side effects: no change set is
    // created for workspace B and workspace A's proposal stays proposed.
    expect(() => applyProposal(workspaceIdB, testWorkspacePathB, freshA.id)).toThrow(
      ProposalNotFoundError,
    );
    expect(getProposalById(workspaceId, freshA.id)?.status).toBe('proposed');
    const changeSetsB = getDb().query(
      'SELECT COUNT(*) as count FROM change_sets WHERE workspace_id = ?',
    ).get(workspaceIdB) as { count: number };
    expect(changeSetsB.count).toBe(0);

    // Repository affected-row checks: foreign/unknown ids report zero rows.
    expect(repoDismissProposal(workspaceIdB, freshA.id)).toBe(false);
    expect(updateProposalStatus(workspaceIdB, freshA.id, 'dismissed')).toBe(false);
    expect(updateProposalStatus(workspaceId, freshA.id, 'dismissed')).toBe(true);

    // Scoped duplicate lookup and delete.
    expect(findDuplicateProposal(workspaceId, 'ProductField24', 'cat supplies', 'Cat Supplies')).toBeTruthy();
    expect(findDuplicateProposal(workspaceIdB, 'ProductField24', 'cat supplies', 'Cat Supplies')).toBeNull();
    expect(deleteGeneratedProposals(workspaceIdB, 'ProductField88')).toBe(0);
    expect(deleteGeneratedProposals(workspaceIdB, 'ProductField99', 'deterministic')).toBe(1);
    expect(listProposals(workspaceIdB, { field: 'ProductField99' })).toHaveLength(0);
  });

  it('shared schema maps DB rows and keeps status/vocabulary compatible', () => {
    const row = insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'Schema Row',
      newValue: 'Schema Canonical',
      affectedSkus: ['SKU-001'],
      reason: 'shared schema test',
      confidence: 0.42,
      source: 'deterministic',
      status: 'proposed',
    });
    // The shared schema is the single contract for persisted rows.
    const parsed = CatalogProposalSchema.safeParse(row);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('proposed');
      expect(parsed.data.source).toBe('deterministic');
      expect(parsed.data.confidence).toBe(0.42);
      expect(parsed.data.oldValue).toBe('Schema Row');
    }
    // Status round-trip through the repository stays enum-compatible.
    expect(updateProposalStatus(workspaceId, row.id, 'dismissed')).toBe(true);
    expect(getProposalById(workspaceId, row.id)?.status).toBe('dismissed');
    expect(CatalogProposalSchema.safeParse(getProposalById(workspaceId, row.id)).success).toBe(true);
  });

  it('staging gate ignores confidence (informational only)', () => {
    const lowConf = insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'Low Confidence Value',
      newValue: 'Canonical Low',
      affectedSkus: ['SKU-001'],
      reason: 'confidence independence',
      confidence: 0.01,
      source: 'ai',
      status: 'proposed',
    });
    const highConf = insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'High Confidence Value',
      newValue: 'Canonical High',
      affectedSkus: ['SKU-002'],
      reason: 'confidence independence',
      confidence: 1,
      source: 'ai',
      status: 'proposed',
    });
    // applyProposal consults workspace/ownership/status — never confidence.
    const lowResult = applyProposal(workspaceId, testWorkspacePath, lowConf.id);
    const highResult = applyProposal(workspaceId, testWorkspacePath, highConf.id);
    expect(lowResult.changeSetId).toBeDefined();
    expect(highResult.changeSetId).toBeDefined();
    expect(getProposalById(workspaceId, lowConf.id)?.status).toBe('applied');
    expect(getProposalById(workspaceId, highConf.id)?.status).toBe('applied');
  });
});
