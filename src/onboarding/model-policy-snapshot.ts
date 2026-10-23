/**
 * Frozen pre-run onboarding model-policy snapshot (issue #17 work item A).
 *
 * Protected onboarding discovery helpers (brand inference, sitemap selection,
 * title/discovery name consolidation, distributor-copy consolidation, cohort
 * title coordination) run before a classification run exists. They receive
 * either this frozen policy view or an explicit `disabled` policy so a
 * protected call can never silently choose a provider outside the workspace
 * policy.
 *
 * Fail-closed: no valid policy ⇒ `{ state: 'disabled' }` ⇒ deterministic
 * fallback/abstention and no transport.
 */
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../classification/config-loader';
import {
  buildModelPolicyView,
  type ModelPolicyView,
} from '../classification/model-policy-gateway';
import type { ModelPolicyConfig, ModelPolicyConfigV2 } from '../shared/schemas/classification';

export type ModelPolicySnapshot =
  | { state: 'configured'; view: ModelPolicyView; source: 'active_v2' | 'legacy_v1' }
  | { state: 'disabled'; reason: string };

/**
 * Capture a frozen view of the active classification model policy for the
 * given workspace (defaults to the configured workspace). V2 active bundles
 * carry `providerLocalities`; legacy v1 policies do not, so locality cannot be
 * attested and the snapshot is `disabled` (fail closed). A missing or
 * malformed policy is also `disabled`.
 */
export function captureModelPolicySnapshot(
  workspacePath: string,
  snapshotHash?: string,
  workspaceId?: string,
): ModelPolicySnapshot {
  try {
    const authority = loadRuntimeConfigAuthority(
      workspacePath,
      createRuntimeActivationContext(workspacePath, workspaceId ?? ''),
    );
    if (authority.kind === 'v2') {
      const policy = authority.bundle.modelPolicy as unknown as ModelPolicyConfigV2;
      if (!policy || typeof policy !== 'object' || !policy.defaultProvider) {
        return { state: 'disabled', reason: 'active_v2_policy_missing' };
      }
      const view = buildModelPolicyView(policy, snapshotHash ? { snapshotHash } : {});
      return { state: 'configured', view, source: 'active_v2' };
    }
    return { state: 'disabled', reason: 'legacy_v1_policy_has_no_provider_localities' };
  } catch (err) {
    return {
      state: 'disabled',
      reason: err instanceof Error ? `policy_unavailable:${err.message}` : 'policy_unavailable',
    };
  }
}

/** Convenience: capture from a run-bound snapshot model policy when available. */
export function modelPolicyViewFromConfig(
  policy: ModelPolicyConfigV2 | ModelPolicyConfig,
  snapshotHash?: string,
): ModelPolicyView | null {
  const v2 = normalizeSnapshotPolicy(policy);
  if (!v2) return null;
  return buildModelPolicyView(v2, snapshotHash ? { snapshotHash } : {});
}

function normalizeSnapshotPolicy(policy: ModelPolicyConfigV2 | ModelPolicyConfig): ModelPolicyConfigV2 | null {
  if (!policy || typeof policy !== 'object') return null;
  const candidate = policy as Partial<ModelPolicyConfigV2>;
  if (candidate.providerLocalities && typeof candidate.providerLocalities === 'object' &&
    Object.keys(candidate.providerLocalities).length > 0) {
    return candidate as ModelPolicyConfigV2;
  }
  // Legacy v1 carries no attested locality and can never authorize a
  // protected call: fail closed rather than infer locality from a name.
  return null;
}
