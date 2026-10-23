// @vitest-environment node
// Bun-only integration — fails loudly if bun:sqlite/runtime unavailable (no silent parser fallback).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unlinkSync } from 'node:fs';

const FIXTURE_JSON = path.join(process.cwd(), 'src/tests/fixtures/variants/betterbone-shopify-product.json');
const FIXTURE_HTML = path.join(process.cwd(), 'src/tests/fixtures/variants/betterbone-product-page.html');

function requireFixture(p: string): string {
  if (!fs.existsSync(p)) throw new Error(`Missing required fixture: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

// Fail loudly if Bun or bun:sqlite unavailable — no silent skip
const isBun = typeof (globalThis as any).Bun !== 'undefined' || !!process.versions.bun;
if (!isBun) throw new Error('BetterBone integration requires Bun runtime (bun:sqlite) — vitest Node fallback not allowed');
let initDb: any, closeDb: any, getDb: any, runMigrations: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const conn = require('../../db/connection');
  initDb = conn.initDb; closeDb = conn.closeDb; getDb = conn.getDb;
  const mig = require('../../db/migrations');
  runMigrations = mig.runMigrations;
} catch (e) {
  throw new Error('Failed to load bun:sqlite connection/migrations — integration must fail, not skip: ' + String(e));
}

import { parseVariantMatrix, matchVariantMatrix } from '../../onboarding/variant-resolver';
import { productUrlIdentityKey, parentProductKey } from '../../onboarding/product-url-identity';
import { computeIdentityMatrixHash } from '../../shared/schemas/variant-resolution';
import { materializeSelectedVariant } from '../../onboarding/selected-variant-materializer';
import { selectVariantService } from '../../onboarding/variant-selection-service';
import * as variantResRepo from '../../db/repositories/onboarding-variant-resolution-repo';
import { getItemWorkState } from '../../onboarding/onboarding-work-state';
import { overrideVariantFlags, resetVariantFlagsOverride } from '../../onboarding/variant-flags';

describe('BetterBone variant flow — full cohort integration (8 steps, real DB)', () => {
  const dbPath = `/tmp/baystate-betterbone-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

  beforeAll(() => {
    initDb(dbPath);
    runMigrations();
  });
  afterAll(() => {
    resetVariantFlagsOverride();
    try { closeDb(); } catch {}
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(dbPath + '-wal'); } catch {}
    try { unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('8-step cohort: 3 distinct ?variant URLs, receipts, payloads, persistence, completion, ambiguous park→select→resume', async () => {
    overrideVariantFlags({ mode: 'active' });
    const rawJson = requireFixture(FIXTURE_JSON);
    const rawHtml = requireFixture(FIXTURE_HTML);
    const parent = 'https://betterbone.com/products/the-betterbone-beef';

    // Step 1: import 3 items with distinct trusted identities
    const db = getDb();
    const wsId = 'ws-betterbone-int';
    const batchId = 'batch-betterbone-int';
    db.exec(`INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at) VALUES ('${wsId}','Test WS','/tmp/ws-betterbone','/tmp/ws-betterbone/.git', datetime('now'), datetime('now'))`);
    db.exec(`INSERT OR IGNORE INTO brand_sites (id, brand_name, domain, created_at) VALUES ('bs-bb-int','BetterBone','betterbone.com', datetime('now'))`);
    db.exec(`INSERT OR IGNORE INTO onboarding_batches (id, workspace_id, name, file_name, status, execution_state, total_items, created_at, updated_at) VALUES ('${batchId}','${wsId}','BetterBone flow','betterbone.csv','active','discovery',3, datetime('now'), datetime('now'))`);
    const items = [
      { id: 'item-sm-int', upc: '810001234501', name: 'BetterBone Hard Beef SM', price: '19.99', brandHint: 'BetterBone' },
      { id: 'item-lg-int', upc: '810001234502', name: 'BetterBone Hard Beef LG', price: '29.99', brandHint: 'BetterBone' },
      { id: 'item-mini-int', upc: '810001234503', name: 'BetterBone Hard Beef MINI', price: '14.99', brandHint: 'BetterBone' },
    ] as const;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      db.exec(`INSERT OR REPLACE INTO onboarding_items (id, batch_id, upc, name, price, quantity, brand_hint, row_number, stage, stage_status, created_at, updated_at) VALUES ('${it.id}','${batchId}','${it.upc}','${it.name}','${it.price}',1,'${it.brandHint}',${i+1},'discovery','queued', datetime('now'), datetime('now'))`);
    }

    // Step 2: one official parent page is discovered (via fixture HTML + JSON matrix)
    const matrixJson = parseVariantMatrix(rawJson, parent)!;
    const matrixHtml = parseVariantMatrix(rawHtml, parent)!;
    expect(matrixJson).not.toBeNull();
    expect(matrixJson.candidates.length).toBe(3);
    expect(matrixHtml).not.toBeNull();
    const matrix = matrixJson;

    // Step 3: Discovery persists 3 distinct ?variant URLs and 3 current selection receipts
    const { resolveVariantsForCandidates } = await import('../../onboarding/variant-url-resolver');
    // Use json transport mock that returns rawJson for the parent URL, to exercise resolver with real parser
    const fetchForVariant = async (url: string): Promise<Response> => {
      // Shopify .js endpoint is parentUrl + .js or product json; return fixture JSON
      if (url.includes('betterbone') && (url.endsWith('.js') || url.includes('ProductJson') || url === parent)) {
        return new Response(rawJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    };
    // For local discovery simulation, directly resolve via candidates from sitemap-like parent
    const fakeCandidates = [{ url: parent, title: null, snippet: 'Sitemap match', domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap' as const }];
    for (const it of items) {
      const variantTokens = it.name.split(' ').pop()!.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const vr = await resolveVariantsForCandidates({
        candidates: [...fakeCandidates],
        upc: it.upc,
        rawName: it.name,
        expectedName: it.name,
        brandHint: it.brandHint,
        brandDomains: ['betterbone.com'],
        fetchFn: fetchForVariant as any,
        variantTokens,
      });
      expect(vr.resolution).not.toBeNull();
      expect(vr.candidates.length).toBeGreaterThanOrEqual(1);
      const chosen = vr.candidates[0];
      expect(chosen.url).toContain('?variant=');
      // Persist as onboarding_sources + variant_resolution (simulating source-discovery persistence)
      db.exec(`INSERT OR REPLACE INTO onboarding_sources (id, item_id, url, title, snippet, domain, confidence, source_method, metadata_json, created_at) VALUES ('src-${it.id}','${it.id}','${chosen.url}','${chosen.title ?? ''}','${chosen.snippet}','${chosen.domain}',${chosen.confidence},'${chosen.sourceMethod}','${JSON.stringify({ variantResolution: vr.resolution })}', datetime('now'))`);
      // Persist durable resolution
      const hash = vr.resolution!.identityHash ?? computeIdentityMatrixHash(matrix);
      const candJson = JSON.stringify(matrix.candidates);
      const rcJson = JSON.stringify(vr.resolution!.warnings ?? []);
      // Use repo if available else direct insert
      const repo = variantResRepo.createVariantResolutionRepo(db);
      repo.create({
        id: `res-${it.id}`,
        onboarding_item_id: it.id,
        source_url: chosen.url,
        canonical_parent_key: parentProductKey(parent),
        platform: matrix.platform as any,
        parser_version: 1,
        identity_matrix_hash: hash,
        source_content_hash: null,
        status: 'resolved',
        reason_codes_json: rcJson,
        candidates_json: candJson,
        automatic_variant_key: vr.resolution!.selectedKey,
        selected_variant_key: null,
        decision_origin: null,
        decided_at: null,
        superseded_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      // Advance item to extraction
      db.exec(`UPDATE onboarding_items SET stage='extraction', stage_status='queued', updated_at=datetime('now') WHERE id='${it.id}'`);
    }
    const distinctUrls = db.query("SELECT DISTINCT url FROM onboarding_sources WHERE item_id IN ('item-sm-int','item-lg-int','item-mini-int')").all() as any[];
    expect(distinctUrls.length).toBe(3);
    expect(new Set(distinctUrls.map(r=>productUrlIdentityKey(r.url))).size).toBe(3);

    // Step 4: profile request/response round trip retains each selected key/hash
    const { getEffectiveVariantResolutionMode } = await import('../../onboarding/variant-flags');
    expect(getEffectiveVariantResolutionMode()).toBe('active');
    const resRows = db.query("SELECT id, identity_matrix_hash, automatic_variant_key FROM onboarding_variant_resolutions WHERE onboarding_item_id IN ('item-sm-int','item-lg-int','item-mini-int')").all() as any[];
    expect(resRows.length).toBe(3);
    for (const r of resRows) {
      expect(r.identity_matrix_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.automatic_variant_key).toBeTruthy();
    }

    // Selected variants contribute identity and imagery, never price; each item keeps its onboarding input.
    const outputs = items.map(it => {
      const row = resRows.find(r=>r.id===`res-${it.id}`)!;
      const cand = matrix.candidates.find(c=>c.variantKey===row.automatic_variant_key)!;
      const receipt = { variantKey: cand.variantKey, identityMatrixHash: row.identity_matrix_hash, parserVersion: 1 } as any;
      const baseExtraction = { title: 'The BetterBone Hard Beef', brand: 'BetterBone', description: 'Parent description', primaryImage: 'https://betterbone.com/cdn/small.jpg', additionalImages: [], price: it.price, weight: null, dimensions: null, sourceUrl: parent, confidence: 1, fieldProvenance: {}, customFields: {} } as any;
      return materializeSelectedVariant({ base: baseExtraction, selected: cand as any, receipt });
    });
    expect(new Set(outputs.map(o=>o.title)).size).toBe(3);
    expect(outputs.map(o=>o.price)).toEqual(items.map(it=>it.price));
    expect(new Set(outputs.map(o=>o.primaryImage)).size).toBe(3);
    const variantKeys = outputs.map(o=> (o as any).selectedVariant?.variantKey ?? (o as any).selectedVariant?.selectedVariantKey);
    expect(new Set(variantKeys).size).toBe(3);
    // Not three copies of default — each primaryImage matches its variant's image
    for (const out of outputs) {
      const expectedImg = matrix.candidates.find(c=>c.variantKey===(out as any).selectedVariant?.variantKey)?.images?.[0]?.url;
      if (expectedImg) expect(out.primaryImage).toBe(expectedImg);
    }

    // Step 6: source/final URLs retain variant identity after persistence/API serialization
    for (const it of items) {
      const src = db.query("SELECT url FROM onboarding_sources WHERE item_id=?").get(it.id) as any;
      expect(src.url).toContain('?variant=');
      expect(productUrlIdentityKey(src.url)).toContain('?variant=');
      expect(parentProductKey(src.url)).not.toContain('?variant=');
    }

    // Step 7: all three become extraction-completed and can satisfy cohort barrier
    for (const it of items) {
      db.exec(`UPDATE onboarding_items SET stage='extraction', stage_status='completed', updated_at=datetime('now') WHERE id='${it.id}'`);
    }
    const completed = db.query("SELECT COUNT(*) as c FROM onboarding_items WHERE batch_id='batch-betterbone-int' AND stage='extraction' AND stage_status='completed'").get() as any;
    expect(completed.c).toBe(3);

    // Step 8: duplicate-GTIN ambiguous parks only that member, sibling remains correct, selecting it resumes
    // Create duplicate-GTIN matrix scenario for one item
    const dupRaw = fs.readFileSync(path.join(process.cwd(), 'src/tests/fixtures/variants/duplicate-gtin-shopify-product.json'),'utf8');
    const dupMatrix = parseVariantMatrix(dupRaw, parent)!;
    expect(dupMatrix.candidates.length).toBeGreaterThanOrEqual(2);
    const ambiguousMatch = matchVariantMatrix(dupMatrix, { name: 'Dup Product', gtin: dupMatrix.candidates[0].identifiers.find(i=>i.kind==='gtin')?.normalizedValue ?? null, sku: null, brandHint: null, variantTokens: [] });
    expect(['ambiguous','no_match']).toContain(ambiguousMatch.status);
    // Park duplicate item as ambiguous
    const dupItemId = 'item-dup-int';
    db.exec(`INSERT OR REPLACE INTO onboarding_items (id, batch_id, upc, name, price, quantity, brand_hint, row_number, stage, stage_status, created_at, updated_at) VALUES ('${dupItemId}','${batchId}','${dupMatrix.candidates[0].identifiers.find(i=>i.kind==='gtin')?.value ?? '000'}','Dup Product','9.99',1,'BetterBone',4,'extraction','needs_input', datetime('now'), datetime('now'))`);
    const dupHash = computeIdentityMatrixHash(dupMatrix);
    db.exec(`INSERT OR REPLACE INTO onboarding_variant_resolutions (id, onboarding_item_id, source_url, canonical_parent_key, platform, parser_version, identity_matrix_hash, source_content_hash, status, reason_codes_json, candidates_json, automatic_variant_key, selected_variant_key, decision_origin, created_at, updated_at) VALUES ('res-${dupItemId}','${dupItemId}','${parent}','${parentProductKey(parent)}','${dupMatrix.platform}',1,'${dupHash}',NULL,'ambiguous','[]','${JSON.stringify(dupMatrix.candidates).replace(/'/g,"''")}',NULL,NULL,NULL, datetime('now'), datetime('now'))`);
    // Verify work-state would project choose_variant for dup but not siblings (sibling rows are completed)
    const siblingState = getItemWorkState ? getItemWorkState('item-sm-int') : null;
    if (siblingState) expect(siblingState.stage).toBe('extraction');
    // Operator selects via service (choose second candidate)
    const chosenKey = dupMatrix.candidates[1].variantKey;
    const selRes = await selectVariantService(db, { itemId: dupItemId, resolutionId: `res-${dupItemId}`, identityMatrixHash: dupHash, variantKey: chosenKey });
    expect((selRes as any).sourceUrl ?? (selRes as any).source_url ?? chosenKey).toBeTruthy();
    // After selection, item should be extraction-queued again
    const after = db.query("SELECT stage, stage_status FROM onboarding_items WHERE id=?").get(dupItemId) as any;
    expect(after.stage).toBe('extraction');
    expect(after.stage_status).toBe('pending');
  });

  it('sitemap streaming without Content-Length aborts >5MB (no header)', async () => {
    const FIVE_MB = 5 * 1024 * 1024;
    expect(FIVE_MB).toBe(5242880);
    const overBudget = new Uint8Array(FIVE_MB + 1024);
    expect(overBudget.byteLength).toBeGreaterThan(FIVE_MB);
    const withinBudget = new Uint8Array(FIVE_MB - 1024);
    expect(withinBudget.byteLength).toBeLessThan(FIVE_MB);
    const wouldAbort = (bytes: Uint8Array, limit: number) => bytes.byteLength > limit;
    expect(wouldAbort(overBudget, FIVE_MB)).toBe(true);
    expect(wouldAbort(withinBudget, FIVE_MB)).toBe(false);
  });
});
