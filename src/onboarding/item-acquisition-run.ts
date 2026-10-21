import type { OnboardingItem } from '../shared/schemas/onboarding';
import type { AcceptedItemEvidence } from '../shared/schemas/item-evidence';
import { createRuntimeActivationContext, loadRuntimeConfigAuthority } from '../classification/config-loader';
import { buildRuntimeSnapshot, persistRuntimeSnapshot, type RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';
import { createConfigSnapshot, getPersistedConfigSnapshotId, syncConfigToCache, upsertConfigSnapshot } from '../db/repositories/classification-config-repo';
import { createRun, completeRun, type ClassificationRunRow } from '../db/repositories/classification-run-repo';
import { itemInputIdentityHash } from './item-input-identity';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import type { ModelPolicyView } from '../classification/model-policy-gateway';

export interface ItemAcquisitionRun {
  run: ClassificationRunRow;
  snapshot: RuntimeClassificationSnapshot;
  modelPolicy: ModelPolicyView | null;
}

/** Freeze a genuine item-owned run before bootstrap evidence collection. */
export function createItemAcquisitionRun(input: {
  item: OnboardingItem;
  workspaceId: string;
  workspacePath: string;
  inputRevision: string;
  evidence: AcceptedItemEvidence | null;
  assertHeld: () => void;
}): ItemAcquisitionRun {
  const { item, workspaceId, workspacePath, inputRevision, evidence, assertHeld } = input;
  const sourceProductHash = evidence?.inputHash ?? itemInputIdentityHash(workspaceId, item);
  if (
    !item.id || !item.upc || !inputRevision ||
    (evidence !== null && (evidence.workspaceId !== workspaceId || evidence.batchId !== item.batchId ||
      evidence.itemId !== item.id || evidence.sku !== item.upc))
  ) throw new Error('Bootstrap evidence and immutable item input must belong to the exact onboarding item.');
  assertHeld();
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  assertHeld();

  let configSnapshotRef: { id: string; hash: string; sourceCommit: string | null; createdAt: string };
  let focusedFileHashes: Record<string, string>;
  let catalogEvidenceHash: string | null;
  if (authority.kind === 'v2') {
    const bundle = authority.bundle;
    let id = getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash);
    if (!id) id = upsertConfigSnapshot(workspaceId, bundle, bundle.manifest.sourceCatalogCommit).id;
    configSnapshotRef = {
      id,
      hash: bundle.manifest.bundleHash,
      sourceCommit: bundle.manifest.sourceCatalogCommit,
      createdAt: new Date().toISOString(),
    };
    focusedFileHashes = bundle.manifest.fileVersions;
    catalogEvidenceHash = bundle.manifest.catalogEvidenceHash;
  } else {
    syncConfigToCache(workspaceId, authority.config);
    const snapshot = createConfigSnapshot(workspaceId, authority.config);
    configSnapshotRef = { id: snapshot.id, hash: snapshot.hash, sourceCommit: null, createdAt: new Date().toISOString() };
    focusedFileHashes = authority.config.manifest.fileVersions ?? {};
    catalogEvidenceHash = null;
  }

  const snapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath,
    productSku: item.upc,
    authority,
    configSnapshotRef,
    focusedFileHashes,
    catalogEvidenceHash,
    sourceProductHash,
  });
  assertHeld();
  const persistedSnapshot = persistRuntimeSnapshot(snapshot);
  const modelPolicy = authority.kind === 'v2' && snapshot.modelPolicy
    ? modelPolicyViewFromConfig(snapshot.modelPolicy as unknown as ModelPolicyConfigV2, snapshot.snapshotHash)
    : null;
  const run = createRun(workspaceId, item.upc, persistedSnapshot.id, persistedSnapshot.hash, {
    onboardingItemId: item.id,
    sourceKind: 'onboarding',
    sourceProductHash,
  });
  try {
    assertHeld();
  } catch (error) {
    completeRun(run.id, 'failed', 'The Extraction item claim was lost during bootstrap run creation.');
    throw error;
  }
  // The immutable runtime snapshot is persisted independently and its hash is
  // the policy binding used by every protected call in this bootstrap run.
  if (run.configSnapshotId !== persistedSnapshot.id || run.configSnapshotHash !== persistedSnapshot.hash) {
    completeRun(run.id, 'failed', 'Bootstrap run snapshot linkage did not match the persisted runtime snapshot.');
    throw new Error('Bootstrap run snapshot linkage mismatch.');
  }
  return { run, snapshot, modelPolicy };
}

/** Close a bootstrap run without publishing any Curation payload or proposals. */
export function finishItemAcquisitionRun(runId: string, outcome: 'completed' | 'failed', reason?: string): void {
  completeRun(runId, outcome === 'completed' ? 'completed_with_abstentions' : 'failed', reason);
}
