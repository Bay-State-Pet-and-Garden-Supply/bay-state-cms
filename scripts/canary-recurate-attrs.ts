/** Narrow review refresh. Reuses persisted evidence; never replays OCR/name/type. */
import { initDb } from '../src/db/connection';
import { findWorkspace } from '../src/db/repositories/workspace-repo';
import { listBatches } from '../src/db/repositories/onboarding-batch-repo';
import { listItemsByBatch } from '../src/db/repositories/onboarding-item-repo';
import { getValidatedOnboardingRun } from '../src/db/repositories/classification-run-repo';
import { refreshReviewedDependents } from '../src/classification/refresh-reviewed-dependents';

export async function refreshCanaryDependents(): Promise<void> {
  initDb('storage/catalog/.shopsite-cms/app.db');
  const workspace = findWorkspace();
  if (!workspace) throw new Error('No workspace.');
  const batch = listBatches(workspace.id).find(batch => batch.name === 'Jev Canary — goldset-16');
  if (!batch) throw new Error('Canary batch not found.');
  for (const item of listItemsByBatch(batch.id)) {
    const run = getValidatedOnboardingRun(item.curationData?.classificationRunId, workspace.id, item.id, item.upc);
    if (!run) continue;
    try {
      const result = await refreshReviewedDependents({ runId: run.id, workspaceId: workspace.id, itemId: item.id });
      console.log(`${item.upc}: ${result.proposalCount} fresh dependent proposals; accepted type and upstream evidence retained.`);
    } catch (error) { console.log(`${item.upc}: blocked — ${error instanceof Error ? error.message : String(error)}`); }
  }
}
if (import.meta.main) refreshCanaryDependents().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
