import { findWorkspace } from '../../db/repositories/workspace-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext, ClassificationConfigLoadError, ClassificationConfigNotConfiguredError } from '../../classification/config-loader';
import { syncConfigToCache, getPersistedConfigSnapshotId, upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { migrateLegacyWorkspaceIfNeeded, getStoreCatalogPath } from './migration-service';
import { syncRegistryFromProductIndex } from './field-metadata-service';
import type { Workspace } from '../../shared/types';

/**
 * Load the classification configuration for a workspace and record the result
 * on the workspace object. Unconfigured workspaces carry no config and no
 * error; configured-but-invalid workspaces propagate the typed error through
 * `classificationConfigError` instead of silently falling through to a stale
 * SQLite cache. The config object is never derived from the cache here.
 */
function attachClassificationConfig(ws: Workspace, workspacePath: string): void {
  try {
    const activationContext = createRuntimeActivationContext(workspacePath, ws.id);
    const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
    if (authority.kind === 'v2') {
      if (!getPersistedConfigSnapshotId(ws.id, authority.bundle.manifest.bundleHash)) {
        upsertConfigSnapshot(ws.id, authority.bundle, authority.bundle.manifest.sourceCatalogCommit);
      }
      ws.classificationConfig = authority.bundle as unknown as Workspace['classificationConfig'];
      ws.classificationConfigError = null;
      return;
    }
    syncConfigToCache(ws.id, authority.config);
    ws.classificationConfig = authority.config;
    ws.classificationConfigError = null;
  } catch (err) {
    if (err instanceof ClassificationConfigNotConfiguredError) {
      // Unconfigured is a valid empty state, not an error.
      ws.classificationConfig = undefined;
      ws.classificationConfigError = null;
      return;
    }
    if (err instanceof ClassificationConfigLoadError) {
      // Configuration exists but is invalid: fail closed, never reuse a stale cache.
      ws.classificationConfig = undefined;
      ws.classificationConfigError = err.message;
      return;
    }
    ws.classificationConfig = undefined;
    ws.classificationConfigError = err instanceof Error ? err.message : String(err);
  }
}

export function getCurrentWorkspace(): Workspace | null {
  try {
    const ws = findWorkspace();
    if (ws) {
      attachClassificationConfig(ws, ws.workspacePath);
      return ws;
    }
  } catch {
    // Database not initialized yet
  }

  // Trigger migration / initialization of single store catalog
  const catalogPath = migrateLegacyWorkspaceIfNeeded();
  const ws = findWorkspace();
  if (ws) {
    attachClassificationConfig(ws, catalogPath);
  }
  return ws;
}

/**
 * Ensures the field_registry has an entry for every ProductField key present
 * in product_index.custom_fields. Runs on catalog load so the registry stays
 * 1:1 with the live catalog. Additive-only and routed through the canonical
 * field-metadata service so the R2 attestation (store/field-registry.json) is
 * always refreshed alongside R1 (fixes C2). Existing rows are never overwritten.
 */
export function syncFieldRegistryFromProductIndex(workspaceId: string, workspacePath?: string): void {
  const added = syncRegistryFromProductIndex({
    id: workspaceId,
    workspacePath: workspacePath ?? getStoreCatalogPath(),
  });
  if (added > 0) {
    console.log(`[WorkspaceService] Synced ${added} missing field_registry entries from product_index.`);
  }
}
