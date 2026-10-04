import { randomUUID } from 'node:crypto';
import { redactTransportText } from './model-policy-gateway';
import { curateItemWithPipeline } from '../onboarding/product-curator';
import { refreshReviewedDependents } from './refresh-reviewed-dependents';
import { findItemById } from '../db/repositories/onboarding-item-repo';
import {
  assertClaimedRefresh, bindClaimedLegacyRefresh, claimRefreshBatch,
  failRefreshItem, findRefreshOnboardingItemId, publishConfigurationRefresh,
} from '../db/repositories/classification-refresh-repo';

/** Workspace-scoped claimed queue dispatch; type review never replays upstream stages. */
export async function processRefreshQueue(workspaceId: string, workspacePath: string): Promise<number> {
  const workerId = `classification-refresh-${randomUUID()}`;
  const rows = claimRefreshBatch(workerId, 50, 300, { workspaceId, excludeDeferred: true });
  let processed = 0;
  for (const row of rows) {
    try {
      assertClaimedRefresh(row);
      if (row.triggerType === 'primary_product_type_change') {
        const scope = JSON.parse(row.refreshScopeJson) as { runId?: string };
        const runId = row.expectedRunId ?? scope.runId;
        if (!runId) throw new Error('Type refresh requires a matching frozen run scope.');
        const bound = bindClaimedLegacyRefresh(row, runId);
        await refreshReviewedDependents({ runId, workspaceId, itemId: bound.onboardingItemId,
          refreshId: bound.id, claimedBy: bound.claimedBy });
        processed++;
        continue;
      }
      if (row.sourceKind === 'catalog_product') throw new Error('Catalog configuration refresh is deferred; use the catalog Rerun action.');
      const itemId = row.onboardingItemId ?? findRefreshOnboardingItemId(workspaceId, row.productSku);
      const item = itemId ? findItemById(itemId) : null;
      if (!item) throw new Error('No active onboarding item found for refresh.');
      const originalRunId = item.curationData?.classificationRunId ?? null;
      const assertHeld = () => {
        assertClaimedRefresh(row);
        if ((findItemById(item.id)?.curationData?.classificationRunId ?? null) !== originalRunId) throw new Error('Item run changed while configuration refresh was executing.');
      };
      const data = await curateItemWithPipeline(item, workspacePath, workspaceId, null, { assertHeld });
      assertHeld();
      publishConfigurationRefresh(row, item.id, originalRunId, data);
      processed++;
    } catch (error) {
      // The dependent service transfers ownership and owns its own guarded
      // failure write. A polling worker cannot overwrite a reclaimed lease.
      failRefreshItem(row.id, redactTransportText(error instanceof Error ? error.message : String(error)), false, 3, workerId);
    }
  }
  return processed;
}
