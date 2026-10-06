#!/usr/bin/env bun
/**
 * Repair "[object Object]" preserved data in workspace product drafts.
 *
 * Pre-fix decode stringified nested blocks (QuantityPricing, CrossSell,
 * AddToPages, OptionMenus, QBImport) into the literal sentinel. This script
 * re-decodes the live store XML with the FIXED codec and splices ONLY the
 * sentinel-bearing keys back into each affected draft:
 *
 *   - deletes sentinel values from preserved.unknownElements / advancedBlocks;
 *   - restores the real raw block from the live record when available;
 *   - never touches core / customFields / status / metadata / product identity
 *     or any non-corrupted preserved key.
 *
 * Dry-run by default. `--apply` writes drafts (canonical writer). Read-only on
 * the live store: uses the cached full download unless `--download` is passed.
 *
 * Usage:
 *   bun run scripts/repair-preserved-blocks.ts                 # dry run
 *   bun run scripts/repair-preserved-blocks.ts --apply         # write drafts
 *   bun run scripts/repair-preserved-blocks.ts --apply --download
 */
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { ShopSiteProductCodec, findPreservedCorruption } from '../src/shopsite/product-codec';
import { writeProductFile } from '../src/git/workspace-files';
import { ShopSiteHttpClient } from '../src/shopsite/shopsite-http-client';
import type { Product } from '../src/shared/types';

const WORKSPACE_PATH = 'storage/catalog';
const PRODUCTS_DIR = path.join(WORKSPACE_PATH, 'products');
const CACHE_PATH = 'storage/tmp/live-products-full.xml';
const REPORT_PATH = 'storage/tmp/preserved-corruption-repair-report.json';
const APPLY = process.argv.includes('--apply');

async function loadLiveXml(): Promise<string> {
  if (!process.argv.includes('--download') && fs.existsSync(CACHE_PATH)) {
    return fs.readFileSync(CACHE_PATH, 'utf8');
  }
  const source = new Database('storage/catalog/.shopsite-cms/app.db', { readonly: true, create: false });
  source.exec('PRAGMA query_only = ON');
  const row = source
    .query('SELECT cgi_base_url AS cgiBaseUrl, merchant_id AS merchantId, password_secret_ref AS password FROM connection LIMIT 1')
    .get() as { cgiBaseUrl: string; merchantId: string; password: string | null } | undefined;
  source.close();
  if (!row?.cgiBaseUrl || !row.merchantId || !row.password) throw new Error('No complete ShopSite connection stored.');
  const client = new ShopSiteHttpClient({ cgiBaseUrl: row.cgiBaseUrl, merchantId: row.merchantId, password: row.password });
  const res = await client.fetchProductsXml();
  if (!res.success || !res.data) throw new Error(`Download failed: ${res.error ?? 'unknown'}`);
  fs.writeFileSync(CACHE_PATH, res.data);
  return res.data;
}

const liveXml = await loadLiveXml();
console.log(`live XML: ${liveXml.length} bytes (${APPLY ? 'APPLY' : 'dry-run'})`);

// SKU → real raw blocks / preserved values from the live store (fixed codec).
const liveBySku = new Map<string, Product>();
for (const match of liveXml.matchAll(/<(?:product|Product)>[\s\S]*?<\/(?:product|Product)>/gi)) {
  const doc = `<ShopSiteProducts version="15.0"><Products>${match[0]}</Products></ShopSiteProducts>`;
  const decoded = ShopSiteProductCodec.decode(doc);
  const product = decoded.products[0];
  if (product?.sku) liveBySku.set(product.sku, product);
}
console.log(`live products indexed: ${liveBySku.size}`);

const report = {
  applied: APPLY,
  scanned: 0,
  affected: 0,
  repaired: 0,
  unrepairable: [] as string[],
  repairedTags: {} as Record<string, number>,
  samples: [] as Array<{ sku: string; tags: string[]; restored: string[] }>,
};

const files = fs.readdirSync(PRODUCTS_DIR).filter(name => name.endsWith('.json'));
for (const name of files) {
  const filePath = path.join(PRODUCTS_DIR, name);
  report.scanned += 1;
  let product: Product;
  try {
    product = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Product;
  } catch {
    continue;
  }
  const corruption = findPreservedCorruption(product);
  if (corruption.length === 0) continue;
  report.affected += 1;

  const live = liveBySku.get(product.sku);
  const restored: string[] = [];
  for (const bucketTag of corruption) {
    const [bucket, tag] = bucketTag.split(':') as ['unknownElements' | 'advancedBlocks', string];
    // Delete the sentinel from whichever bucket carries it.
    const preserved = product.shopsite.preserved;
    if (bucket === 'unknownElements') {
      delete (preserved.unknownElements as Record<string, unknown>)[tag];
    } else {
      delete (preserved.advancedBlocks as Record<string, string>)[tag];
    }
    // Restore the real raw block from the live record when available.
    const liveBlock = live?.shopsite.preserved.advancedBlocks[tag];
    if (liveBlock && !/\[object (?:Object|Array)\]/.test(liveBlock)) {
      preserved.advancedBlocks[tag] = liveBlock;
      restored.push(tag);
    }
    report.repairedTags[tag] = (report.repairedTags[tag] ?? 0) + 1;
  }

  if (!live) {
    report.unrepairable.push(product.sku);
  }
  if (restored.length > 0 || live) report.repaired += 1;
  if (report.samples.length < 8) report.samples.push({ sku: product.sku, tags: corruption, restored });

  if (APPLY) {
    writeProductFile(WORKSPACE_PATH, product);
  }
}

fs.mkdirSync('storage/tmp', { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`scanned: ${report.scanned} | affected: ${report.affected} | repaired: ${report.repaired} | unrepairable: ${report.unrepairable.length}`);
console.log('repaired tags:', JSON.stringify(report.repairedTags));
console.log('samples:', JSON.stringify(report.samples.slice(0, 3)));
console.log(`report: ${REPORT_PATH}`);
if (!APPLY) console.log('\nDry run — pass --apply to write drafts.');
