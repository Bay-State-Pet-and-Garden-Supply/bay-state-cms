/**
 * Read-only classification backfill gate. Fetches a fresh, full live export;
 * an old baseline or workspace-only comparison cannot authorize an import.
 * Usage: bun run scripts/gate-batch.ts <changeSetId>
 */
import { initDb } from '../src/db/connection';
import { findChangeSetById, listChangeSetItems } from '../src/db/repositories/change-set-repo';
import { ShopSiteProductCodec } from '../src/shopsite/product-codec';
import { redactCredentials } from '../src/shopsite/multipart-upload';
import { gateBackfillExport } from './lib/backfill-preflight-cli';

const changeSetId = process.argv[2];
if (!changeSetId) {
  console.error('usage: gate-batch.ts <changeSetId>');
  process.exit(2);
}

try {
  // The shared helper downloads all products using the configured CGI endpoint.
  initDb(process.env.BAYSTATE_CMS_DB_PATH ?? 'storage/catalog/.shopsite-cms/app.db');
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) throw new Error('Change set not found.');
  const items = listChangeSetItems(changeSetId);
  const products = items.map(item => JSON.parse(item.draftJson));
  const xml = ShopSiteProductCodec.encodeMany(products).xml;
  const gate = await gateBackfillExport(changeSetId, xml);
  for (const issue of gate.issues) console.error(`FAIL ${issue.sku}/${issue.field}: ${issue.reason}`);
  console.log(gate.ok ? `GATE PASS: ${items.length} intended SKU(s)` : `GATE FAIL: ${gate.issues.length} issue(s)`);
  process.exitCode = gate.ok ? 0 : 1;
} catch (error) {
  console.error(`GATE FAIL: ${redactCredentials(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}
