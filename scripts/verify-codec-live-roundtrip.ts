#!/usr/bin/env bun
/**
 * Read-only live-corpus round-trip verification for the product codec.
 *
 * Streams a full `db_xml.cgi` products download (default: the cached copy at
 * storage/tmp/live-products-full.xml) through ShopSiteProductCodec.decode →
 * .encode and asserts:
 *   1. No "[object Object]" sentinel in decoded preserved data or encoded XML.
 *   2. Every nested top-level block present in the source survives (raw) and
 *      is re-emitted.
 *   3. No duplicate top-level tags in the encoded output where the source had
 *      one (notably ProductType).
 *
 * No network, no writes, no DB. Pass `--download` to fetch a fresh copy first
 * (read-only) using the stored connection.
 */
import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { ShopSiteProductCodec, findPreservedCorruption } from '../src/shopsite/product-codec';
import { ShopSiteHttpClient } from '../src/shopsite/shopsite-http-client';

const CACHE_PATH = 'storage/tmp/live-products-full.xml';

let xml: string;
if (process.argv.includes('--download')) {
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
  xml = res.data;
  fs.writeFileSync(CACHE_PATH, xml);
  console.log(`downloaded ${xml.length} bytes`);
} else {
  xml = fs.readFileSync(CACHE_PATH, 'utf8');
  console.log(`reusing ${CACHE_PATH} (${xml.length} bytes)`);
}

const NESTED_TAGS = ['QuantityPricing', 'CrossSell', 'AddToPages', 'OptionMenus', 'Subproducts', 'ProductOnPages', 'ProductOptions', 'QBImport'];
const blocks = [...xml.matchAll(/<(?:product|Product)>[\s\S]*?<\/(?:product|Product)>/gi)].map(m => m[0]);
console.log(`products: ${blocks.length}`);

let sentinelDecoded = 0;
let sentinelEncoded = 0;
let nestedMissing = 0;
let duplicateTags = 0;
const missingExamples: string[] = [];
const sampleLimit = 12;

const seenNested = new Map<string, number>();
for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i];
  const doc = `<ShopSiteProducts version="15.0"><Products>${block}</Products></ShopSiteProducts>`;
  const { products } = ShopSiteProductCodec.decode(doc);
  const product = products[0];
  const corruption = findPreservedCorruption(product);
  if (corruption.length > 0) {
    sentinelDecoded++;
    if (missingExamples.length < sampleLimit) missingExamples.push(`decode sentinel ${product.sku}: ${corruption.join(',')}`);
  }
  const out = ShopSiteProductCodec.encode(product).xml;
  if (/\[object (?:Object|Array)\]/.test(out)) {
    sentinelEncoded++;
    if (missingExamples.length < sampleLimit) missingExamples.push(`encode sentinel ${product.sku}`);
  }
  for (const tag of NESTED_TAGS) {
    const withContent = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`).exec(block);
    if (!withContent) continue;                                  // self-closing empty → nothing to preserve
    if (!/<[A-Za-z_]/.test(withContent[0].replace(new RegExp(`</?${tag}>`, 'g'), ''))) continue; // no children/text
    seenNested.set(tag, (seenNested.get(tag) ?? 0) + 1);
    const stillRaw = product.shopsite.preserved.advancedBlocks[tag] != null;
    const emitted = new RegExp(`<${tag}[\\s/>]`).test(out);
    if (!stillRaw || !emitted) {
      nestedMissing++;
      if (missingExamples.length < sampleLimit) missingExamples.push(`nested lost ${tag} sku=${product.sku} raw=${stillRaw} emitted=${emitted}`);
    }
  }
  // duplicate top-level tag check on the tags the encoder owns (top level is
  // exactly two-space indented in encoded output; nested blocks indent deeper)
  for (const tag of ['ProductType', 'Name', 'SKU', 'Price', 'ProductID', 'ProductGUID']) {
    const inSource = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`).test(block);
    if (!inSource) continue;
    const count = (out.match(new RegExp(`^  <${tag}>`, 'gm')) ?? []).length;
    if (count !== 1) {
      duplicateTags++;
      if (missingExamples.length < sampleLimit) missingExamples.push(`count ${tag}=${count} sku=${product.sku}`);
    }
  }
}

console.log('\nnested blocks seen:', [...seenNested.entries()].map(([t, n]) => `${t}:${n}`).join(', '));
console.log(`decode sentinels: ${sentinelDecoded}`);
console.log(`encode sentinels: ${sentinelEncoded}`);
console.log(`nested lost:      ${nestedMissing}`);
console.log(`duplicate/absent owned tags: ${duplicateTags}`);
if (missingExamples.length > 0) console.log('examples:\n  ' + missingExamples.join('\n  '));
const failed = sentinelDecoded + sentinelEncoded + nestedMissing + duplicateTags;
console.log(failed === 0 ? '\nPASS: full live corpus round-trips without corruption or loss.' : `\nFAIL: ${failed} problem(s).`);
process.exit(failed === 0 ? 0 : 1);
