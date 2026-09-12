/**
 * Story e10s01 — review-completeness gate tests.
 *
 * Covers:
 * - every blocker/warning code's trigger condition on the PURE evaluator;
 * - the effective-name warning-vs-blocker boundary (promoter chain parity,
 *   including the whitespace-only curatedTitle behavior);
 * - the distributor price path (item.price is the only authority — empty
 *   item price BLOCKS, extraction price never substitutes);
 * - the verified-pages-only rule at builder level (proposals + manual rows);
 * - POST /onboarding/items/review-complete carrying structured blockers and
 *   mutating NOTHING on failure (all-or-nothing, fail closed);
 * - legacy no-run items still gated by the category-page requirement.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { getReviewState } from '../../db/repositories/onboarding-review-repo';
import {
  listVerifiedPageOptions,
  assignProductToPageId,
  getActivePageImportHash,
} from '../../db/repositories/page-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import onboardingRoutes from '../../server/routes/onboarding-routes';
import {
  evaluateReviewCompleteness,
  countReviewPageAssignments,
  buildReviewCompletenessContext,
  resolveReviewBrand,
  type ReviewCompletenessContext,
  type ReviewCompletenessItemLike,
} from '../../classification/review-completeness';
import { writeProductFile } from '../../git/workspace-files';
import type { Product } from '../../shared/types';

// ─── Pure evaluator fixtures ─────────────────────────────────────────────────

function baseItem(overrides: Partial<ReviewCompletenessItemLike> = {}): ReviewCompletenessItemLike {
  return {
    id: 'item-1',
    upc: 'UPC-1',
    name: 'Spreadsheet Name',
    price: '9.99',
    brandHint: 'Acme',
    sourceType: 'official_page',
    curationData: null,
    extractionData: null,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<ReviewCompletenessContext> = {}): ReviewCompletenessContext {
  return {
    sourceType: 'official_page',
    itemName: 'Spreadsheet Name',
    itemPrice: '9.99',
    brandHint: 'Acme',
    curatedTitle: 'Curated Title',
    curatedDescription: 'A description',
    searchKeywords: 'kw1 kw2',
    curatedWeight: '1.5',
    extractionData: {
      title: 'Extraction Title',
      description: null,
      price: null,
      weight: null,
      searchKeywords: null,
      primaryImage: 'http://img.example/primary.jpg',
      additionalImages: [],
      distributorImageApprovals: null,
    },
    resolvedBrandName: 'Acme Brands',
    hasPendingProposals: false,
    verifiedPageAssignmentCount: 2,
    unverifiedAcceptedPageCount: 0,
    ...overrides,
  };
}

describe('evaluateReviewCompleteness (pure)', () => {
  it('is ready when every mandatory field resolves', () => {
    const result = evaluateReviewCompleteness(baseCtx());
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('blocks with missing_name when no name source resolves', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({ itemName: null, curatedTitle: null, extractionData: { title: null } }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('missing_name');
  });

  it('warns (not blocks) when the effective name comes from a fallback source', () => {
    const result = evaluateReviewCompleteness(baseCtx({ curatedTitle: null }));
    expect(result.blockers).not.toContain('missing_name');
    expect(result.warnings).toContain('name_from_fallback_source');
    // Boundary: a reviewed curated title never emits the fallback warning.
    const reviewed = evaluateReviewCompleteness(baseCtx());
    expect(reviewed.warnings).not.toContain('name_from_fallback_source');
  });

  it('treats a whitespace-only curatedTitle as blocking (byte-identical to promoter chain)', () => {
    // Promoter: finalTitle = '   ' (truthy) → coreProduct.name?.trim() empty
    // → mandatory Name check fails. No fallback warning either.
    const result = evaluateReviewCompleteness(baseCtx({ curatedTitle: '   ' }));
    expect(result.blockers).toContain('missing_name');
    expect(result.warnings).not.toContain('name_from_fallback_source');
  });

  it('blocks official_page items with an empty price', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({ itemPrice: null, extractionData: { title: 'T', price: null } }),
    );
    expect(result.blockers).toContain('missing_price');
    expect(result.ready).toBe(false);
  });

  it('cleans price like the promoter ($ , whitespace stripped) before judging emptiness', () => {
    const ok = evaluateReviewCompleteness(baseCtx({ itemPrice: '$1,299.00' }));
    expect(ok.blockers).not.toContain('missing_price');
    const onlySymbols = evaluateReviewCompleteness(baseCtx({ itemPrice: ' $ , ' }));
    expect(onlySymbols.blockers).toContain('missing_price');
  });

  it('blocks distributor_record items with an empty item price — extraction price NEVER substitutes (promoter parity)', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({
        sourceType: 'distributor_record',
        itemPrice: null,
        extractionData: { title: 'T', price: '19.99' },
      }),
    );
    // Adjudication: the promoter resolves distributor price from item.price
    // ONLY (draft-promoter.ts ~777) and its mandatory check fails on empty —
    // so the gate must block too, never auto-satisfy from extraction data.
    expect(result.blockers).toContain('missing_price');
    expect(result.ready).toBe(false);
  });

  it('blocks when ProductField16-equivalent brand resolution is empty', () => {
    const result = evaluateReviewCompleteness(baseCtx({ resolvedBrandName: null }));
    expect(result.blockers).toContain('missing_brand');
    const whitespace = evaluateReviewCompleteness(baseCtx({ resolvedBrandName: '   ' }));
    expect(whitespace.blockers).toContain('missing_brand');
  });

  it('blocks official_page items without a primary image candidate', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({ extractionData: { title: 'T', primaryImage: null } }),
    );
    expect(result.blockers).toContain('missing_primary_image');
  });

  it('a persisted reviewedMedia primary clears missing_primary_image', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({
        extractionData: { title: 'T', primaryImage: null, additionalImages: ['http://img.example/b.jpg'] },
        reviewedMedia: {
          primaryImage: 'http://img.example/b.jpg',
          orderedAdditional: [],
          suppressed: [],
        },
      }),
    );
    expect(result.blockers).not.toContain('missing_primary_image');
  });

  it('suppressing the ONLY extraction primary keeps missing_primary_image (hidden ≠ promotable)', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({
        extractionData: { title: 'T', primaryImage: 'http://img.example/p.jpg', additionalImages: [] },
        reviewedMedia: { primaryImage: null, orderedAdditional: [], suppressed: ['http://img.example/p.jpg'] },
      }),
    );
    expect(result.blockers).toContain('missing_primary_image');
  });

  it('uses only rights-attested approved images as the distributor primary-image candidate', () => {
    const approved = evaluateReviewCompleteness(
      baseCtx({
        sourceType: 'distributor_record',
        extractionData: {
          title: 'T',
          primaryImage: 'http://raw.example/nope.jpg',
          distributorImageApprovals: [{ imageUrl: null }, { imageUrl: 'http://approved.example/a.jpg' }],
        },
      }),
    );
    expect(approved.blockers).not.toContain('missing_primary_image');

    const noneApproved = evaluateReviewCompleteness(
      baseCtx({
        sourceType: 'distributor_record',
        extractionData: { title: 'T', primaryImage: null, distributorImageApprovals: [] },
      }),
    );
    expect(noneApproved.blockers).toContain('missing_primary_image');
  });

  it('blocks with missing_pages when zero VERIFIED assignments exist', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({ verifiedPageAssignmentCount: 0, unverifiedAcceptedPageCount: 3 }),
    );
    expect(result.blockers).toContain('missing_pages');
    expect(result.warnings).toContain('unverified_accepted_pages');
  });

  it('warns missing_size when the effective name carries no measurement (issue #106)', () => {
    // baseCtx title 'Curated Title' has no size and curatedWeight '1.5' is
    // unitless canonical data (not title evidence) — advisory, never blocking.
    const result = evaluateReviewCompleteness(baseCtx());
    expect(result.ready).toBe(true);
    expect(result.warnings).toContain('missing_size');
    const sized = evaluateReviewCompleteness(
      baseCtx({ curatedTitle: 'Acme Curated Title 2 lb', curatedWeight: '2 lb' }),
    );
    expect(sized.warnings).not.toContain('missing_size');
  });

  it('warns missing_color for a known multicolor family with unknown own color (issue #106)', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({
        curatedTitle: 'Acme Collar 5 LB',
        curatedWeight: '5 LB',
        extractionData: {
          title: 'Acme Collar', description: null, price: null, weight: null,
          searchKeywords: null, primaryImage: 'http://img.example/primary.jpg',
          additionalImages: [], distributorImageApprovals: null,
          variantAttributes: { color: 'Red' }, color: 'Blue', seoFileName: null,
        },
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.warnings).toContain('missing_color');
  });

  it('emits curated-field quality warnings without blocking readiness', () => {
    const result = evaluateReviewCompleteness(
      baseCtx({
        curatedDescription: null,
        searchKeywords: '',
        curatedWeight: null,
        hasPendingProposals: true,
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining(['description_empty', 'keywords_empty', 'weight_missing', 'pending_proposals']),
    );
  });
});

describe('resolveReviewBrand (promoter input-chain parity)', () => {
  const brands = [{ id: 'b1', name: 'Acme', aliases: ['Acme Corp'] }] as unknown as Parameters<
    typeof resolveReviewBrand
  >[3];

  it('does NOT fall through a whitespace-only brandHint to the effective name', () => {
    // Promoter parity (draft-promoter.ts:962): brandInput = '   ' (truthy) →
    // resolveBrand rejects whitespace → raw hint assigned → mandatory trim
    // check fails → promotion blocks on Brand. Pre-trimming the hint would
    // let the gate pass an item promotion later blocks — forbidden invariant.
    const result = resolveReviewBrand(baseItem({ brandHint: '   ' }), null, 'Acme Pet Food', brands);
    expect(result).toBeNull();
  });

  it('resolves via the effective name when brandHint is falsy', () => {
    const result = resolveReviewBrand(baseItem({ brandHint: null }), null, 'Acme Pet Food', brands);
    expect(result).toBe('Acme');
  });

  it('falls back to the trimmed hint when resolution fails on a usable hint', () => {
    const result = resolveReviewBrand(baseItem({ brandHint: 'Zorgon' }), null, 'Acme Pet Food', brands);
    expect(result).toBe('Zorgon');
  });
});

// ─── DB-backed builder + route tests ────────────────────────────────────────

let workspaceId: string;
let workspacePath: string;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  return app;
}

function makeBatch(name = 'e10s01 Batch'): string {
  return createBatch({ workspaceId, name, fileName: 'test.csv', totalItems: 0 }).id;
}

function createItem(
  batchId: string,
  overrides: { upc: string; stage?: string; stageStatus?: string; name?: string; price?: string | null; brandHint?: string | null },
): string {
  return insertItems(batchId, [{
    upc: overrides.upc,
    name: overrides.name ?? 'Spreadsheet Name',
    rowNumber: 1,
    ...(overrides.price !== undefined ? { price: overrides.price } : {}),
    ...(overrides.brandHint !== undefined ? { brandHint: overrides.brandHint } : {}),
    stage: (overrides.stage ?? 'review') as never,
    stageStatus: (overrides.stageStatus ?? 'pending') as never,
  }], (overrides.stage ?? 'review') as never, 1)[0].id;
}

function seedVerifiedPages(names: string[]): void {
  activatePageImportFromRecords({
    workspaceId,
    sourceHash: createHash('sha256').update(names.join('|')).digest('hex'),
    parserFormatVersion: 'pages-xml-1',
    records: names.map((name) => ({
      identity: { kind: 'exported_guid' as const, key: `guid-${name}`, status: 'verified' as const },
      name,
      parentRef: null,
      availability: 'available' as const,
    })),
    activatedBy: 'test',
  });
}

beforeAll(() => {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-e10s01-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  seedVerifiedPages(['Pets']);
});

describe('countReviewPageAssignments (builder)', () => {
  it('counts manual product_pages rows ONLY when their page ID is verified in the active import', () => {
    const batchId = makeBatch('pages-manual');
    const upc = `MANUAL-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;

    assignProductToPageId(upc, verifiedPage.id, 'Pets');
    let counts = countReviewPageAssignments(findItemById(id)!, workspaceId);
    expect(counts.verifiedPageAssignmentCount).toBe(1);

    // An unverified page row (identity_status != 'verified', no active
    // import) satisfies the product_pages FK but NEVER satisfies the gate.
    const foreignUpc = `${upc}-f`;
    const ghostItemId = createItem(batchId, { upc: foreignUpc });
    getDb().run(
      `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, identity_kind, identity_key, identity_status, availability, created_at, updated_at)
       VALUES ('ghost-page-id', 'Ghost Page', NULL, NULL, 'hash-ghost', 'unverified_name_only', 'ghost-key', 'unverified', 'available', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    assignProductToPageId(foreignUpc, 'ghost-page-id', 'Ghost Page');
    counts = countReviewPageAssignments(findItemById(id)!, workspaceId);
    expect(counts.verifiedPageAssignmentCount).toBe(1); // own row still verified

    const ghostCounts = countReviewPageAssignments(findItemById(ghostItemId)!, workspaceId);
    expect(ghostCounts.verifiedPageAssignmentCount).toBe(0);
  });

  it('counts a correctedCategoryPage record that resolves into the CURRENT verified import (blind review F1)', () => {
    const batchId = makeBatch('pages-correction-current');
    const upc = `CORR-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    const activeHash = getActivePageImportHash(workspaceId)!;

    // No run pointer, no product_pages rows — the correction record is the
    // ONLY page authority (exactly what handleUpdatePages writes for an
    // item whose page proposal was rejected/absent).
    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [
        JSON.stringify({
          correctedCategoryPage: {
            pageId: verifiedPage.id,
            activePageImportHash: activeHash,
            correctedAt: new Date().toISOString(),
          },
        }),
        id,
      ],
    );

    const counts = countReviewPageAssignments(findItemById(id)!, workspaceId);
    expect(counts.verifiedPageAssignmentCount).toBe(1);
  });

  it('does NOT count a STALE-HASH or foreign-ID correctedCategoryPage record (fail closed)', () => {
    const batchId = makeBatch('pages-correction-stale');
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    const staleHash = 'stale-import-hash-000';

    const staleId = createItem(batchId, { upc: `STALE-${randomUUID().slice(0, 6)}` });
    getDb().run(`UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`, [
      JSON.stringify({
        correctedCategoryPage: {
          pageId: verifiedPage.id,
          activePageImportHash: staleHash,
          correctedAt: new Date().toISOString(),
        },
      }),
      staleId,
    ]);

    const foreignId = createItem(batchId, { upc: `FOREIGN-${randomUUID().slice(0, 6)}` });
    getDb().run(`UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`, [
      JSON.stringify({
        correctedCategoryPage: {
          pageId: 'not-a-verified-page-id',
          activePageImportHash: getActivePageImportHash(workspaceId)!,
          correctedAt: new Date().toISOString(),
        },
      }),
      foreignId,
    ]);

    expect(countReviewPageAssignments(findItemById(staleId)!, workspaceId).verifiedPageAssignmentCount).toBe(0);
    expect(countReviewPageAssignments(findItemById(foreignId)!, workspaceId).verifiedPageAssignmentCount).toBe(0);
  });

  it('does NOT count name-only manual product_pages rows even when their page ID is verified (promoter :919)', () => {
    const batchId = makeBatch('pages-manual-nameless');
    const upc = `NONAME-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;

    assignProductToPageId(upc, verifiedPage.id, ''); // name-only row: FK satisfied, gate never
    const counts = countReviewPageAssignments(findItemById(id)!, workspaceId);
    expect(counts.verifiedPageAssignmentCount).toBe(0);
  });

  it('counts accepted category_page proposals by VERIFIED identity; unverified accepted are reported separately', () => {
    const batchId = makeBatch('pages-proposals');
    const upc = `PROP-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc });
    const run = createRun(workspaceId, upc, null, null, id);
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;

    const now = new Date().toISOString();
    const insertProposal = getDb().prepare(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, evidence_ids_json, supporting_evidence_ids_json, contradicting_evidence_ids_json, model_call_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertProposal.run(randomUUID(), run.id, upc, 'category_page', null,
      JSON.stringify({ pageId: verifiedPage.id, pageName: 'Pets' }), 0.9, 'accepted', 1, 0, null, null, '[]', '[]', '[]', '[]', now);
    insertProposal.run(randomUUID(), run.id, upc, 'category_page', null,
      JSON.stringify({ pageId: 'unverified-page-id', pageName: 'Ghost' }), 0.9, 'accepted', 1, 0, null, null, '[]', '[]', '[]', '[]', now);

    updateCurationData(id, { suggestedPages: ['Pets'], classificationRunId: run.id });

    const counts = countReviewPageAssignments(findItemById(id)!, workspaceId);
    expect(counts.verifiedPageAssignmentCount).toBe(1);
    expect(counts.unverifiedAcceptedPageCount).toBe(1);
  });

  it('does NOT count an accepted proposal onto a verified Page ID whose verified display name is unusable (promoter :903–912)', () => {
    const batchId = makeBatch('pages-empty-verified-name');
    const upc = `EMPTYNAME-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc });

    // Verified + available row joined into the ACTIVE import, but with an
    // empty canonical name — degenerate catalog data the promoter skips.
    const activeImport = getDb()
      .query("SELECT id FROM page_imports WHERE status = 'active' ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string } | undefined;
    expect(activeImport).toBeDefined();
    const nowIso = new Date().toISOString();
    getDb().run(
      `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, workspace_id, import_id, identity_kind, identity_key, identity_status, availability, created_at, updated_at)
       VALUES ('empty-name-page-id', '', NULL, NULL, 'hash-empty-name', ?, ?, 'exported_guid', 'guid-empty-name', 'verified', 'available', ?, ?)`,
      [workspaceId, activeImport!.id, nowIso, nowIso],
    );

    const run = createRun(workspaceId, upc, null, null, id);
    getDb()
      .prepare(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, evidence_ids_json, supporting_evidence_ids_json, contradicting_evidence_ids_json, model_call_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), run.id, upc, 'category_page', null,
        JSON.stringify({ pageId: 'empty-name-page-id', pageName: 'Whatever' }), 0.9, 'accepted', 1, 0, null, null, '[]', '[]', '[]', '[]', nowIso);
    updateCurationData(id, { classificationRunId: run.id });

    const counts = countReviewPageAssignments(findItemById(id)!, workspaceId);
    expect(counts.verifiedPageAssignmentCount).toBe(0); // missing_pages blocker
    expect(counts.unverifiedAcceptedPageCount).toBe(1); // surfaced as visible-skip warning context
  });
});

function updateCurationData(itemId: string, data: Record<string, unknown>): void {
  getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
    JSON.stringify(data),
    itemId,
  ]);
}

function updateExtractionData(itemId: string, data: Record<string, unknown>): void {
  getDb().run('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?', [
    JSON.stringify(data),
    itemId,
  ]);
}

describe('buildReviewCompletenessContext (promoter brand-slot parity, #142)', () => {
  function seedBrandMapping(catalogField: string): void {
    const now = new Date().toISOString();
    getDb().run(
      `INSERT OR IGNORE INTO classification_attribute_mappings
       (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        workspaceId,
        'map-brand',
        'brand',
        catalogField,
        JSON.stringify({ format: 'direct', separator: ', ', prefix: '', suffix: '' }),
        now,
        now,
      ],
    );
  }

  function clearBrandMapping(): void {
    getDb().run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ? AND id = ?', [
      workspaceId,
      'map-brand',
    ]);
  }

  function writeApprovedProduct(upc: string, customFields: Record<string, string>): void {
    const now = new Date().toISOString();
    const product: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: upc,
      status: 'active',
      core: {
        name: 'Approved Product',
        price: '9.99',
        salePrice: null,
        description: null,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null,
        weight: null,
        taxable: true,
        media: { primary: null, additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields,
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
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };
    writeProductFile(workspacePath, product);
  }

  it('reads the existing approved brand from the MAPPED slot, agreeing with the promoter', () => {
    seedBrandMapping('ProductField12');
    try {
      const batchId = makeBatch('brand-slot-parity');
      const upc = `BRANDMAP-${randomUUID().slice(0, 6)}`;
      const id = createItem(batchId, { upc, brandHint: null });
      // The approved file carries the brand ONLY at the mapped slot; the
      // legacy fallback slot holds a decoy that the promoter would ignore.
      writeApprovedProduct(upc, { ProductField12: 'MappedBrandCo', ProductField16: 'DecoyBrand' });
      const ctx = buildReviewCompletenessContext(findItemById(id)!, { workspaceId, workspacePath });
      expect(ctx.resolvedBrandName).toBe('MappedBrandCo');
    } finally {
      clearBrandMapping();
    }
  });

  it('falls back to ProductField16 when no brand mapping exists (promoter parity)', () => {
    clearBrandMapping();
    const batchId = makeBatch('brand-slot-fallback');
    const upc = `BRANDFB-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, brandHint: null });
    writeApprovedProduct(upc, { ProductField16: 'FallbackBrand' });
    const ctx = buildReviewCompletenessContext(findItemById(id)!, { workspaceId, workspacePath });
    expect(ctx.resolvedBrandName).toBe('FallbackBrand');
  });
});

describe('POST /api/onboarding/items/review-complete — e10s01 completeness gate', () => {
  it('rejects with STRUCTURED blockers and mutates nothing when mandatory fields are missing', async () => {
    const batchId = makeBatch('gate-blocked');
    const upc = `BLOCKED-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: null, brandHint: null });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    assignProductToPageId(upc, verifiedPage.id, 'Pets'); // pages OK so remaining blockers are isolated
    updateCurationData(id, { suggestedPages: ['Pets'] });

    const before = findItemById(id)!;
    const beforeState = getReviewState(id);

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('None were mutated');
    const failure = body.failures.find((f: { itemId: string }) => f.itemId === id);
    expect(failure).toBeDefined();
    expect(Array.isArray(failure.blockers)).toBe(true);
    expect(failure.reason).toContain('Missing mandatory fields:');
    // Name falls back to the spreadsheet item name (warning, not blocker);
    // price/brand/primary-image have no fallback and block.
    expect(failure.blockers).toEqual(
      expect.arrayContaining(['missing_price', 'missing_brand', 'missing_primary_image']),
    );

    // Nothing mutated: same stage/stage_status, no durable review state row.
    const after = findItemById(id)!;
    expect(after.stage).toBe(before.stage);
    expect(after.stageStatus).toBe(before.stageStatus);
    expect(after.curationData).toEqual(before.curationData);
    expect(after.extractionData).toEqual(before.extractionData);
    expect(getReviewState(id)).toBe(beforeState);
  });

  it("rejects the WHOLE batch when one item fails completeness, mutating neither item", async () => {
    const batchId = makeBatch('gate-mixed-batch');

    // Item A: fully resolved — would pass on its own.
    const passUpc = `MIXPASS-${randomUUID().slice(0, 6)}`;
    const passId = createItem(batchId, { upc: passUpc, price: '5.00', brandHint: 'Acme' });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    assignProductToPageId(passUpc, verifiedPage.id, 'Pets');
    updateCurationData(passId, {
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Reviewed Title 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
    });
    updateExtractionData(passId, { title: 'Ext', primaryImage: 'http://img.example/p.jpg' });

    // Item B: mandatory fields missing (no price/brand/image fallbacks).
    const failUpc = `MIXFAIL-${randomUUID().slice(0, 6)}`;
    const failId = createItem(batchId, { upc: failUpc, price: null, brandHint: null });
    assignProductToPageId(failUpc, verifiedPage.id, 'Pets'); // isolate price/brand/image blockers
    updateCurationData(failId, { suggestedPages: ['Pets'] });

    const passBefore = findItemById(passId)!;
    const failBefore = findItemById(failId)!;
    const passStateBefore = getReviewState(passId);
    const failStateBefore = getReviewState(failId);

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [passId, failId] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('None were mutated');

    // Only the incomplete item is reported; the passing item is NOT silently
    // completed either.
    const failure = body.failures.find((f: { itemId: string }) => f.itemId === failId);
    expect(failure).toBeDefined();
    expect(failure.blockers).toEqual(
      expect.arrayContaining(['missing_price', 'missing_brand', 'missing_primary_image']),
    );
    expect(body.failures.find((f: { itemId: string }) => f.itemId === passId)).toBeUndefined();

    // BOTH items are byte-identical to their pre-request state (all-or-nothing).
    const passAfter = findItemById(passId)!;
    const failAfter = findItemById(failId)!;
    expect(passAfter.stageStatus).toBe(passBefore.stageStatus);
    expect(passAfter.curationData).toEqual(passBefore.curationData);
    expect(getReviewState(passId)).toBe(passStateBefore);
    expect(failAfter.stageStatus).toBe(failBefore.stageStatus);
    expect(failAfter.curationData).toEqual(failBefore.curationData);
    expect(getReviewState(failId)).toBe(failStateBefore);
  });

  it('rejects review-complete for a distributor_record item whose item price is empty (promotion would fail on Price)', async () => {
    const batchId = makeBatch('gate-distributor');
    const upc = `DIST-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: null, brandHint: 'Acme' });
    // insertItems defaults source_type to official_page; flip it the way the
    // sourcing materializer does.
    getDb().run("UPDATE onboarding_items SET source_type = 'distributor_record' WHERE id = ?", [id]);
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    assignProductToPageId(upc, verifiedPage.id, 'Pets');
    updateCurationData(id, {
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Reviewed Title 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
    });
    // Rights-attested approved image present; extraction price must be IGNORED.
    updateExtractionData(id, {
      title: 'Ext',
      price: '19.99',
      distributorImageApprovals: [{ imageUrl: 'http://approved.example/a.jpg' }],
    });

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    // Fail closed: passing here would create a pass-review/fail-promotion
    // dead end ("Missing mandatory fields: Price" at promotion time).
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.failures[0].blockers).toContain('missing_price');

    // Projection surfaces the blocker so the reviewer can FIX it by editing
    // the item price (editable for both source types per adjudication).
    const detailRes = await makeApp().request(`/api/onboarding/items/${id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.completeness.ready).toBe(false);
    expect(detail.completeness.blockers).toEqual(['missing_price']);
  });
  it('still gates legacy no-run items on the category-page requirement before completeness', async () => {
    const batchId = makeBatch('gate-legacy-pages');
    const id = createItem(batchId, { upc: `NOPAGE-${randomUUID().slice(0, 6)}` });
    updateCurationData(id, {}); // no suggestedPages → missing_category_page

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.failures[0].reason).toContain('missing_category_page');
  });

  it('completes review when every mandatory field resolves (no over-blocking)', async () => {
    const batchId = makeBatch('gate-passing');
    const upc = `PASS-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: '12.34', brandHint: 'Acme' });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    assignProductToPageId(upc, verifiedPage.id, 'Pets');
    updateCurationData(id, {
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Reviewed Title 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
    });
    updateExtractionData(id, { title: 'Ext', primaryImage: 'http://img.example/p.jpg' });

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const state = getReviewState(id);
    expect(state?.reviewedAt).toBeTruthy();

    // Detail projection carries the authoritative completeness status.
    const detailRes = await makeApp().request(`/api/onboarding/items/${id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.completeness).toBeDefined();
    expect(detail.completeness.ready).toBe(true);
    // Curated fields all present → no fallback or quality warnings beyond none.
    expect(detail.completeness.warnings).toEqual([]);
  });

  it('blocks review-complete when the draft filename is owned by another catalog product (issue #106)', async () => {
    const batchId = makeBatch('gate-filename-block');
    const upc = `FNBLOCK-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: '12.34', brandHint: 'Acme' });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    assignProductToPageId(upc, verifiedPage.id, 'Pets');
    updateCurationData(id, {
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Filename Product 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
    });
    updateExtractionData(id, { title: 'Ext', primaryImage: 'http://img.example/p.jpg', seoFileName: 'taken-live-name' });
    // Untouched catalog owns the seo-derived base under another SKU.
    getDb().query(`INSERT INTO product_index
      (id, sku, file_path, title, status, price, inventory_quantity, primary_image, product_hash, created_at, updated_at, custom_fields)
      VALUES (?, ?, ?, ?, 'active', '1.00', 1, NULL, 'h', '2026-01-01', '2026-01-01', ?)`).run(
      `pi-fnblock-${upc}`, `FOREIGN-${upc}`, `/p/x.xml`, 'Foreign', JSON.stringify({ FileName: 'taken-live-name.html' }),
    );

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // Ownership refusal surfaces through the filename gate (and the
    // completeness duplicate_filename blocker on the detail projection).
    expect(JSON.stringify(body)).toMatch(/duplicate_filename|filename_collision_catalog/);
    // Approval cannot waive ownership: the item is not reviewed.
    expect(getReviewState(id)?.reviewedAt ?? null).toBeNull();
  });

  it('completes review when a persisted reviewedMedia selection is the only primary image (server-side e10s04 parity)', async () => {
    const batchId = makeBatch('gate-media-pass');
    const upc = `MEDIAPASS-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: '12.34', brandHint: 'Acme' });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;
    assignProductToPageId(upc, verifiedPage.id, 'Pets');
    updateCurationData(id, {
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Reviewed Title 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
      // Selection written by PUT /items/:id/media: designated additional as
      // primary; extraction has NO primary at all.
      reviewedMedia: {
        primaryImage: 'http://img.example/alt.jpg',
        orderedAdditional: [],
        suppressed: [],
      },
    });
    updateExtractionData(id, { title: 'Ext', primaryImage: null, additionalImages: ['http://img.example/alt.jpg'] });

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const detailRes = await makeApp().request(`/api/onboarding/items/${id}`);
    const detail = await detailRes.json();
    expect(detail.completeness.ready).toBe(true);
  });

  it('completes review for a legacy no-run item whose ONLY page authority is a CURRENT-hash correctedCategoryPage (blind review F1 e2e)', async () => {
    const batchId = makeBatch('gate-correction-pass');
    const upc = `CORRPASS-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: '7.77', brandHint: 'Acme' });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;

    // No run pointer (legacy), no product_pages row, NO suggestedPages — the
    // correction record written by handleUpdatePages is the only page signal.
    updateCurationData(id, {
      // handleUpdatePages writes BOTH keys together: suggestedPages satisfies
      // the legacy category-page gate (display names), the correction record
      // is what THIS gate can actually verify against the current import.
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Reviewed Title 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
      correctedCategoryPage: {
        pageId: verifiedPage.id,
        activePageImportHash: getActivePageImportHash(workspaceId)!,
        correctedAt: new Date().toISOString(),
      },
    });
    updateExtractionData(id, { title: 'Ext', primaryImage: 'http://img.example/p.jpg' });

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('rejects review-complete with missing_pages when the correctedCategoryPage hash is STALE (fail closed)', async () => {
    const batchId = makeBatch('gate-correction-stale');
    const upc = `CORRSTALE-${randomUUID().slice(0, 6)}`;
    const id = createItem(batchId, { upc, price: '7.77', brandHint: 'Acme' });
    const verifiedPage = listVerifiedPageOptions(workspaceId).find((p) => p.name === 'Pets')!;

    updateCurationData(id, {
      suggestedPages: ['Pets'],
      curatedTitle: 'Acme Reviewed Title 2 lb',
      curatedDescription: 'Reviewed description',
      searchKeywords: 'kw',
      curatedWeight: '2 lb',
      correctedCategoryPage: {
        pageId: verifiedPage.id,
        activePageImportHash: 'stale-import-hash-abc123',
        correctedAt: new Date().toISOString(),
      },
    });
    updateExtractionData(id, { title: 'Ext', primaryImage: 'http://img.example/p.jpg' });

    const res = await makeApp().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const failure = body.failures.find((f: { itemId: string }) => f.itemId === id);
    expect(failure).toBeDefined();
    expect(failure.blockers).toContain('missing_pages');
  });

  it('PUT rejects the quantity key for distributor_record rows but keeps price writable (adjudication)', async () => {
    const batchId = makeBatch('put-dist-qty');
    const id = createItem(batchId, { upc: `DQ-${randomUUID().slice(0, 6)}`, brandHint: 'Acme' });
    getDb().run("UPDATE onboarding_items SET source_type = 'distributor_record' WHERE id = ?", [id]);

    const qtyRes = await makeApp().request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 5 }),
    });
    expect(qtyRes.status).toBe(400);

    // Price stays writable: item.price is the promoter's ONLY distributor
    // price authority, so the reviewer must be able to fix a missing_price
    // blocker from Review.
    const priceRes = await makeApp().request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: '12.50' }),
    });
    expect(priceRes.status).toBe(200);
    expect(findItemById(id)!.price).toBe('12.50');
  });

  it('PUT rejects negative price and quantity values (the promoter writes them verbatim otherwise)', async () => {
    const batchId = makeBatch('put-negative');
    const id = createItem(batchId, { upc: `NEG-${randomUUID().slice(0, 6)}` });
    const app = makeApp();
    const priceRes = await app.request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: '-5.00' }),
    });
    expect(priceRes.status).toBe(400);
    // Currency-symbol-wrapped negatives must fail too: validation runs AFTER
    // stripping `$ ,` whitespace, mirroring the promotion price cleanup
    // (blind review F2 — " $-5 " previously smuggled a negative through).
    const wrappedRes = await app.request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: ' $-5 ' }),
    });
    expect(wrappedRes.status).toBe(400);
    const qtyRes = await app.request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: -3 }),
    });
    expect(qtyRes.status).toBe(400);
    const item = findItemById(id)!;
    expect(item.price).toBeNull();
    expect(item.quantity).toBeNull();
  });

  it('PUT normalizes edited curatedWeight through convertToLbs at the route level', async () => {
    const batchId = makeBatch('put-weight-lbs');
    const id = createItem(batchId, { upc: `WT-${randomUUID().slice(0, 6)}` });
    const res = await makeApp().request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curation_data: { curatedWeight: '12 oz' } }),
    });
    expect(res.status).toBe(200);
    expect((findItemById(id)! as unknown as { curationData: Record<string, unknown> }).curationData.curatedWeight).toBe('0.75');
  });
});
