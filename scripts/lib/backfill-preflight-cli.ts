import { findWorkspace } from '../../src/db/repositories/workspace-repo';
import { findConnection } from '../../src/db/repositories/connection-repo';
import { findChangeSetById, listChangeSetItems } from '../../src/db/repositories/change-set-repo';
import { ShopSiteHttpClient } from '../../src/shopsite/shopsite-http-client';
import { redactCredentials } from '../../src/shopsite/multipart-upload';
import { preflightBackfill } from '../../src/shopsite/backfill-preflight';

/** Read-only, fresh full ShopSite census. A saved XML file never authorizes a push. */
/** Caller initializes the workspace database before reading the change set. */
export async function gateBackfillExport(changeSetId: string, outgoingXml: string) {
  const workspace = findWorkspace();
  if (!workspace) throw new Error('No workspace loaded.');
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet || changeSet.workspaceId !== workspace.id) throw new Error('Change set not found in this workspace.');
  const items = listChangeSetItems(changeSetId);
  if (items.length === 0) throw new Error('Change set has no intended SKUs.');
  const connection = findConnection(workspace.id);
  if (!connection?.cgiBaseUrl || !connection.merchantId || !connection.passwordSecretRef) {
    throw new Error('ShopSite connection is required for a fresh full-record census.');
  }
  const client = new ShopSiteHttpClient({
    cgiBaseUrl: connection.cgiBaseUrl,
    merchantId: connection.merchantId,
    password: connection.passwordSecretRef,
  });
  const live = await client.fetchProductsXml();
  if (!live.success || !live.data) {
    throw new Error(`Fresh ShopSite product export failed: ${redactCredentials(live.error ?? live.errors.join('; '))}`);
  }
  return preflightBackfill({ workspaceId: workspace.id, items, liveXml: live.data, outgoingXml });
}
