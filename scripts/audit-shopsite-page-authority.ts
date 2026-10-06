/** Read-only ShopSite Page XML evidence capture; never activates an import. */
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { findWorkspaceIdReadonly } from '../src/db/repositories/workspace-repo';
import { findConnection } from '../src/db/repositories/connection-repo';
import { ShopSiteHttpClient } from '../src/shopsite/shopsite-http-client';
import { parseShopSitePagesXml } from '../src/shopsite/page-parser';
import { assertNoHoldoutAccess, recomputeTaxonomyAuthorityHash } from '../src/classification/jev-benchmark-replay';
import { sha256Hex } from '../src/shared/stable-id';

const root = path.resolve(import.meta.dir, '..');
const option = (flag: string) => process.argv.find(argument => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
const fields = ['Name', 'File name', 'Page ID', 'Title', 'Text 1', 'Text 2', 'Text 3', 'Link Name', 'Link Text', 'Template'];
if (!process.argv.includes('--download')) {
  console.log(JSON.stringify({ download: false, database: 'pages', version: '14.0', fields, activation: false }, null, 2));
  process.exit(0);
}
const output = option('--out');
if (!output) throw new Error('Page evidence download requires a new --out=<json> path.');
const outputPath = path.resolve(output);
assertNoHoldoutAccess(outputPath);
assertNoHoldoutAccess(path.dirname(outputPath));
if (fs.existsSync(outputPath) || !fs.statSync(path.dirname(outputPath)).isDirectory()) {
  throw new Error('Page evidence output must be new with an existing public parent.');
}
const taxonomyPath = path.resolve(root, option('--taxonomy') ?? 'docs/audits/jev-representative-v4/taxonomy.json');
assertNoHoldoutAccess(taxonomyPath);
const authority = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
const authorityHash = recomputeTaxonomyAuthorityHash(authority);
const expectedAuthorityHash = option('--authority-hash') ?? authority.authorityHash;
if (!expectedAuthorityHash || authorityHash !== expectedAuthorityHash) throw new Error('Frozen Page authority hash mismatch; supply the approved --authority-hash=<sha256>.');
const source = new Database(path.join(root, 'storage/catalog/.shopsite-cms/app.db'), { readonly: true, create: false });
source.exec('PRAGMA query_only = ON');
const workspaceId = findWorkspaceIdReadonly(source);
const connection = workspaceId ? findConnection(workspaceId, source) : null;
source.close();
if (workspaceId !== authority.binding.workspaceId || !connection?.merchantId || !connection.passwordSecretRef) {
  throw new Error('The configured ShopSite workspace connection is unavailable or differs from authority.');
}
const client = new ShopSiteHttpClient({ cgiBaseUrl: connection.cgiBaseUrl, merchantId: connection.merchantId, password: connection.passwordSecretRef });
const retrievedAt = new Date().toISOString();
const response = await client.fetchPagesXml({ version: '14.0', fields });
if (!response.success || !response.data) throw new Error('ShopSite Page evidence download failed.');
const document = parseShopSitePagesXml(response.data);
if (document.responseCode !== '1' || document.pages.length === 0 || document.pages.some(page => !page.pageId || !page.name)) {
  throw new Error('ShopSite Page evidence export is not a successful nonempty verified export.');
}
const frozenPages = new Map<string, { pageId: string; pageName: string }>(authority.pages
  .filter((page: { identityKind: string }) => page.identityKind === 'exported_guid')
  .map((page: { identityKey: string; pageId: string; pageName: string }) => [page.identityKey, page]));
const identities = new Set(document.pages.map(page => page.pageId));
if (identities.size !== document.pages.length || identities.size !== frozenPages.size ||
    document.pages.some(page => frozenPages.get(page.pageId)?.pageName !== page.name)) {
  throw new Error('Downloaded Page identities or names differ from the frozen verified pool; no import was activated.');
}
const records = document.pages.map(page => ({ pageId: frozenPages.get(page.pageId)!.pageId,
  exportedGuid: page.pageId, name: page.name, fileName: page.pageFileName,
  title: page.fields.PageTitle ?? null, text1: page.fields.Text1 ?? null, text2: page.fields.Text2 ?? null,
  text3: page.fields.Text3 ?? null, linkName: page.fields.LinkName ?? null, linkText: page.fields.LinkText ?? null,
  template: page.fields.Template ?? null, parentReference: page.parentRef,
  sourceFragmentSha256: sha256Hex(page.rawXml) }));
const result = { artifactKind: 'shopsite-page-xml-authority-evidence', retrievedAt, authorityHash,
  activeImportId: authority.binding.pageImportId, activeIdentityImportHash: authority.binding.pageImportHash,
  exportSha256: sha256Hex(response.data), requestedVersion: '14.0', returnedVersion: document.version, requestedFields: fields,
  databaseReadonly: true, shopsiteDownloadRequests: 1, importActivated: false, productionWrites: 0,
  pageIdsPreserved: true, assignmentScopeClosed: false, productMembershipGold: false,
  counts: { total: records.length, fileNames: records.filter(record => record.fileName).length,
    titles: records.filter(record => record.title).length, text1: records.filter(record => record.text1).length,
    text2: records.filter(record => record.text2).length, text3: records.filter(record => record.text3).length,
    parents: records.filter(record => record.parentReference).length }, records };
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, exportSha256: result.exportSha256, counts: result.counts,
  pageIdsPreserved: true, productionWrites: 0, assignmentScopeClosed: false }, null, 2));
