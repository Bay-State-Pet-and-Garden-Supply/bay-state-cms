#!/usr/bin/env bun
/**
 * Read-only census of live ShopSite ProductField slot usage.
 *
 * Downloads the FULL products database from `db_xml.cgi` and censuses the
 * `ProductField1..32` slots the CMS taxonomy maps.
 *
 * Why full download: the documented `fields=` allowlist does NOT recognize
 * `ProductFieldN` names — a filtered request returns SKU/Name only and
 * silently omits every custom field, which makes the store look empty.
 * Subsetting custom fields via `fields=` is therefore not reliable; the
 * full record must be downloaded and parsed locally.
 *
 * No writes, no upload, no publish, no DB persistence. Credentials are read
 * from the workspace connection row and never printed.
 *
 * Usage:
 *   bun run scripts/audit-live-productfield-slots.ts            # live download
 *   bun run scripts/audit-live-productfield-slots.ts --reuse    # reuse cached XML
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { ShopSiteHttpClient } from '../src/shopsite/shopsite-http-client';

const DB_PATH = 'storage/catalog/.shopsite-cms/app.db';
const CACHE_PATH = 'storage/tmp/live-products-full.xml';
const CENSUS_PATH = 'storage/tmp/live-productfield-census.json';

/** Live CMS taxonomy slot assignments (docs/audits/jev-representative-v4 taxonomy.json). */
const MAPPED_SLOTS: Record<string, string> = {
  ProductField8: 'nutrition',
  ProductField13: 'canonical-category-id',
  ProductField14: 'canonical-breadcrumb',
  ProductField16: 'brand',
  ProductField17: 'species',
  ProductField18: 'life-stage',
  ProductField19: 'breed-size',
  ProductField20: 'dietary-features',
  ProductField21: 'health-benefits',
  ProductField22: 'food-form',
  ProductField23: 'flavor',
  ProductField24: 'category',
  ProductField25: 'product-type',
  ProductField26: 'product-feature',
  ProductField27: 'size',
  ProductField28: 'material',
  ProductField29: 'color',
  ProductField30: 'packaging-type',
  ProductField32: 'product-cross-sell',
};

let xml: string;
if (process.argv.includes('--reuse')) {
  xml = fs.readFileSync(CACHE_PATH, 'utf8');
  console.log(`reusing ${CACHE_PATH} (${xml.length} bytes)`);
} else {
  const source = new Database(DB_PATH, { readonly: true, create: false });
  source.exec('PRAGMA query_only = ON');
  const row = source
    .query('SELECT cgi_base_url AS cgiBaseUrl, merchant_id AS merchantId, password_secret_ref AS password FROM connection LIMIT 1')
    .get() as { cgiBaseUrl: string; merchantId: string; password: string | null } | undefined;
  source.close();
  if (!row?.cgiBaseUrl || !row.merchantId || !row.password) {
    throw new Error('No complete ShopSite connection stored in the workspace database.');
  }
  const client = new ShopSiteHttpClient({
    cgiBaseUrl: row.cgiBaseUrl,
    merchantId: row.merchantId,
    password: row.password,
  });
  const response = await client.fetchProductsXml();
  if (!response.success || !response.data) {
    throw new Error(`Product download failed: ${response.error ?? 'unknown'}`);
  }
  xml = response.data;
  fs.mkdirSync('storage/tmp', { recursive: true });
  fs.writeFileSync(CACHE_PATH, xml);
}

const slots = Array.from({ length: 32 }, (_, i) => `ProductField${i + 1}`);
const products: Array<{ sku: string; values: Record<string, string> }> = [];
for (const block of xml.split(/<Product[ >]/).slice(1)) {
  const pick = (tag: string): string =>
    (block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`))?.[1] ?? '').trim();
  const values: Record<string, string> = {};
  for (const slot of slots) {
    const value = pick(slot);
    if (value !== '') values[slot] = value;
  }
  products.push({ sku: pick('SKU'), values });
}

const perSlot: Record<string, {
  present: number;
  distinct: number;
  piped: number;
  allLower: number;
  topValues: Array<{ value: string; count: number }>;
}> = {};
for (const slot of slots) {
  const counts = new Map<string, number>();
  let present = 0;
  for (const product of products) {
    const value = product.values[slot];
    if (value === undefined) continue;
    present += 1;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let piped = 0;
  let allLower = 0;
  for (const [value, count] of counts) {
    if (value.includes('|')) piped += count;
    if (value === value.toLowerCase() && value !== value.toUpperCase()) allLower += count;
  }
  perSlot[slot] = {
    present,
    distinct: counts.size,
    piped,
    allLower,
    topValues: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value: value.slice(0, 120), count })),
  };
}

const census = {
  retrievedAt: new Date().toISOString(),
  productCount: products.length,
  perSlot,
  mappedSlots: MAPPED_SLOTS,
  slotVerdicts: Object.fromEntries(slots.map(slot => [slot, {
    mappedAttribute: MAPPED_SLOTS[slot] ?? null,
    populated: perSlot[slot].present > 0,
  }])),
};

fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2));

console.log(`products: ${census.productCount}`);
for (const slot of slots) {
  const entry = perSlot[slot];
  if (entry.present === 0) continue;
  const preview = entry.topValues.slice(0, 4).map(v => `${v.value}(${v.count})`).join(' | ');
  console.log(
    `${slot.padEnd(15)} n=${String(entry.present).padStart(5)} distinct=${String(entry.distinct).padStart(4)}` +
    ` pipes=${String(entry.piped).padStart(5)} lower=${String(entry.allLower).padStart(5)}  ${preview.slice(0, 120)}`,
  );
}
console.log(`\ncensus: ${CENSUS_PATH}`);
