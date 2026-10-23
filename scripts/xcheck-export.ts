/**
 * Read-only XML export cross-check against a fresh full ShopSite census.
 * Usage: bun run scripts/xcheck-export.ts <changeSetId>
 * A saved baseline XML cannot authorize a full-record product import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb } from '../src/db/connection';
import { findWorkspace } from '../src/db/repositories/workspace-repo';
import { redactCredentials } from '../src/shopsite/multipart-upload';
import { gateBackfillExport } from './lib/backfill-preflight-cli';

const changeSetId = process.argv[2];
if (!changeSetId || process.argv[3]) {
  console.error('usage: xcheck-export.ts <changeSetId> (requires fresh live XML; no saved baseline)');
  process.exit(2);
}

try {
  initDb(process.env.BAYSTATE_CMS_DB_PATH ?? 'storage/catalog/.shopsite-cms/app.db');
  const workspace = findWorkspace();
  if (!workspace) throw new Error('No workspace loaded.');
  const xmlPath = path.join(workspace.workspacePath, 'exports', changeSetId, 'shopsite-products.xml');
  const outgoingXml = fs.readFileSync(xmlPath, 'utf-8');
  const gate = await gateBackfillExport(changeSetId, outgoingXml);
  for (const issue of gate.issues) console.error(`FAIL ${issue.sku}/${issue.field}: ${issue.reason}`);
  console.log(gate.ok ? 'XCHECK PASS: live values and approved export agree' : `XCHECK FAIL: ${gate.issues.length} issue(s)`);
  process.exitCode = gate.ok ? 0 : 1;
} catch (error) {
  console.error(`XCHECK FAIL: ${redactCredentials(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}
