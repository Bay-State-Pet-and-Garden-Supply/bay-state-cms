// fallow-ignore-file unused-export

/**
 * Classification Policy Settings Service (Issue #296 / ADR 0033).
 *
 * Implements read, preview, and apply workflows for selecting classification
 * providers in Classification Settings. The existing workspace model-policy
 * stage overrides remain the sole routing authority for:
 *   - Primary Product Type (`primary_product_type_proposal`)
 *   - Controlled Product Attributes (`product_attribute_proposals`)
 *   - Category Pages (`category_page_proposals`)
 *
 * Enforces stage adapter compatibility, connection health visibility,
 * pinned model selection, data-sharing implications, CAS concurrency,
 * and fail-closed validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ClassificationManifestV2Schema,
  ModelPolicyConfigV2Schema,
  DataSharingConfigV2Schema,
  type ModelPolicyConfigV2,
  type DataSharingConfigV2,
  type ProviderLocality,
} from '../shared/schemas/classification';
import { canonicalJsonStringify, sha256Hex } from '../shared/stable-id';
import {
  classificationDir,
  hasClassificationConfig,
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from './config-loader';
import {
  updateClassificationPolicy,
  ConfigStoreConflictError,
  ConfigStoreError,
} from './config-store';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { getCachedConnectionHealth } from '../ai/connection-health-monitor';
import type { ProviderConnection } from '../ai/provider-connections';

export class ClassificationPolicyServiceError extends Error {
  readonly statusCode: number;
  constructor(
    message: string,
    readonly code: string = 'policy_service_error',
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ClassificationPolicyServiceError';
    this.statusCode = status;
  }
}

export interface StageDefinition {
  id: 'primary_product_type_proposal' | 'product_attribute_proposals' | 'category_page_proposals';
  label: string;
  description: string;
  operation: string;
  adapterStatus: 'supported' | 'unwired';
  supportedTransports: readonly ('openai-compatible' | 'ollama-native' | 'systemone')[];
}

export const CLASSIFICATION_POLICY_STAGES: readonly StageDefinition[] = [
  {
    id: 'primary_product_type_proposal',
    label: 'Primary Product Type',
    description: 'Selects the primary product type from the configured taxonomy.',
    operation: 'product_type_ranking',
    adapterStatus: 'supported',
    supportedTransports: ['openai-compatible', 'ollama-native', 'systemone'],
  },
  {
    id: 'product_attribute_proposals',
    label: 'Controlled Product Attributes',
    description: 'Proposes applicable controlled attribute values (single- and multi-valued) from the active attribute profile.',
    operation: 'attribute_ranking',
    adapterStatus: 'supported',
    supportedTransports: ['openai-compatible', 'ollama-native', 'systemone'],
  },
  {
    id: 'category_page_proposals',
    label: 'Category Pages',
    description: 'Proposes verified ShopSite category pages based on taxonomy, species, and hierarchy rules.',
    operation: 'page_assignment',
    adapterStatus: 'unwired', // Jev adapter arrives in #299 / #301
    supportedTransports: ['openai-compatible', 'ollama-native'],
  },
] as const;

export interface EffectiveStageRoute {
  id: string;
  label: string;
  description: string;
  isInherited: boolean;
  effectiveProvider: string;
  effectiveModel: string;
  effectiveFallbackProvider: string | null;
  effectiveFallbackModel: string | null;
  connectionId: string | null;
  connectionLabel: string | null;
  connectionStatus: string;
  connectionLocality: ProviderLocality;
}

export interface ConnectionOption {
  id: string;
  label: string;
  transport: string;
  trustZone: string;
  locality: ProviderLocality;
  enabled: boolean;
  status: string;
  models: Array<{ id: string; name: string }>;
  stageSupport: Record<string, { supported: boolean; reason?: string; multiValueSupported?: boolean }>;
}

export interface ClassificationPolicySettingsResponse {
  migrationRequired: boolean;
  migrationMessage?: string;
  bundleHash: string | null;
  activeRevision: string | null;
  defaultProvider: string;
  defaultModel: string;
  textDataSharing: string;
  imageDataSharing: string;
  stages: EffectiveStageRoute[];
  availableConnections: ConnectionOption[];
}

export interface StageOverrideProposal {
  connectionId?: string | null;
  provider?: string | null;
  model?: string | null;
  fallbackConnectionId?: string | null;
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
}

export interface PreviewPolicyInput {
  expectedBaseBundleHash: string;
  stageOverrides: Record<string, StageOverrideProposal>;
  defaultProvider?: string;
  defaultModel?: string;
  textDataSharing?: 'local_only' | 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';
  imageDataSharing?: 'local_only' | 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';
}

export interface PreviewPolicyResult {
  valid: boolean;
  previewToken: string | null;
  baseBundleHash: string;
  dataSharingEffects: string[];
  validationErrors: string[];
  diff: {
    stages: Record<string, {
      from: { provider: string; model: string };
      to: { provider: string; model: string };
    }>;
    dataSharing: {
      text: { from: string; to: string };
      image: { from: string; to: string };
    };
  };
}

export interface ApplyPolicyInput {
  previewToken: string;
  expectedBaseBundleHash: string;
  stageOverrides: Record<string, StageOverrideProposal>;
  defaultProvider?: string;
  defaultModel?: string;
  textDataSharing?: 'local_only' | 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';
  imageDataSharing?: 'local_only' | 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';
}

export interface ApplyPolicyResult {
  success: boolean;
  bundleHash: string;
  commitHash: string | null;
  updatedAt: string;
  effectiveRoutes: Record<string, { provider: string; model: string }>;
}

function trustZoneToLocality(trustZone: string): ProviderLocality {
  if (trustZone === 'cloud') return 'cloud';
  if (trustZone === 'trusted_lan') return 'trusted_lan';
  return 'local';
}

/**
 * Reads classification policy settings for the active workspace.
 */
export function getClassificationPolicySettings(
  workspacePath: string,
  _workspaceId: string,
): ClassificationPolicySettingsResponse {
  if (!hasClassificationConfig(workspacePath)) {
    return {
      migrationRequired: false,
      bundleHash: null,
      activeRevision: null,
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5:7b',
      textDataSharing: 'local_only',
      imageDataSharing: 'local_only',
      stages: [],
      availableConnections: [],
    };
  }

  let activationContext;
  if (_workspaceId) {
    try {
      activationContext = createRuntimeActivationContext(workspacePath, _workspaceId);
    } catch {
      // fallback
    }
  }
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind === 'v1') {
    return {
      migrationRequired: true,
      migrationMessage: 'v1 classification configuration must be migrated to v2 before selecting stage providers.',
      bundleHash: null,
      activeRevision: null,
      defaultProvider: authority.config.modelPolicy.defaultProvider,
      defaultModel: authority.config.modelPolicy.defaultModel,
      textDataSharing: authority.config.dataSharing.textPolicy,
      imageDataSharing: authority.config.dataSharing.imagePolicy,
      stages: [],
      availableConnections: [],
    };
  }

  const bundle = authority.bundle;
  const manifest = bundle.manifest;
  const modelPolicy = bundle.modelPolicy;
  const dataSharing = bundle.dataSharing;

  const activeDir = path.join(workspacePath, 'store', 'classification');
  let activeBundleHash = manifest.bundleHash;
  if (fs.existsSync(path.join(activeDir, 'manifest.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(activeDir, 'manifest.json'), 'utf-8'));
      if (raw.bundleHash) activeBundleHash = raw.bundleHash;
    } catch {
      // fallback to bundle manifest
    }
  }

  const fullRouting = getFullAiRoutingConfig();
  const connections = Object.values(fullRouting.connections);

  // Map available connections with stage support
  const availableConnections: ConnectionOption[] = connections.map(conn => {
    const locality = trustZoneToLocality(conn.trustZone);
    const stageSupport: Record<string, { supported: boolean; reason?: string; multiValueSupported?: boolean }> = {};

    for (const stage of CLASSIFICATION_POLICY_STAGES) {
      if (conn.transport === 'systemone') {
        if (stage.id === 'primary_product_type_proposal') {
          stageSupport[stage.id] = { supported: true };
        } else if (stage.id === 'product_attribute_proposals') {
          stageSupport[stage.id] = { supported: true, multiValueSupported: true };
        } else {
          stageSupport[stage.id] = {
            supported: false,
            reason: `TypeSafe Jev typed-judgment adapter is not yet available for stage "${stage.label}" (pending stage adapter).`,
          };
        }
      } else if (stage.supportedTransports.includes(conn.transport as any)) {
        stageSupport[stage.id] = {
          supported: true,
          ...(stage.id === 'product_attribute_proposals' ? { multiValueSupported: true } : {}),
        };
      } else {
        stageSupport[stage.id] = {
          supported: false,
          reason: `Transport "${conn.transport}" is not supported for stage "${stage.label}".`,
        };
      }
    }

    const connAny = conn as any;
    const health = getCachedConnectionHealth(conn.id);
    const models = (connAny.models && Array.isArray(connAny.models))
      ? connAny.models
      : (conn.transport === 'systemone' ? [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }] : []);
    const status = connAny.lastProbeStatus || health || 'healthy';

    return {
      id: conn.id,
      label: conn.label || conn.id,
      transport: conn.transport,
      trustZone: conn.trustZone,
      locality,
      enabled: conn.enabled !== false,
      status,
      models,
      stageSupport,
    };
  });

  // Calculate effective route for each of the 3 stages
  const stages: EffectiveStageRoute[] = CLASSIFICATION_POLICY_STAGES.map(stage => {
    const override = modelPolicy.stageOverrides[stage.id];
    const isInherited = !override || !override.provider;

    const effectiveProvider = (!isInherited && override.provider) ? override.provider : modelPolicy.defaultProvider;
    const effectiveModel = (!isInherited && override.model) ? override.model : modelPolicy.defaultModel;
    const effectiveFallbackProvider = override?.fallbackProvider ?? null;
    const effectiveFallbackModel = override?.fallbackModel ?? null;

    // Resolve matching connection
    const matchedConn = connections.find(c => c.id === effectiveProvider || c.label === effectiveProvider || (c.transport === 'ollama-native' && effectiveProvider === 'ollama'));
    const matchedConnAny = matchedConn as any;
    const connectionStatus = matchedConnAny?.lastProbeStatus || (matchedConn ? getCachedConnectionHealth(matchedConn.id) : null) || 'healthy';

    return {
      id: stage.id,
      label: stage.label,
      description: stage.description,
      isInherited,
      effectiveProvider,
      effectiveModel,
      effectiveFallbackProvider,
      effectiveFallbackModel,
      connectionId: matchedConn?.id ?? null,
      connectionLabel: matchedConn?.label ?? effectiveProvider,
      connectionStatus,
      connectionLocality: matchedConn ? trustZoneToLocality(matchedConn.trustZone) : (modelPolicy.providerLocalities[effectiveProvider] ?? 'local'),
    };
  });

  return {
    migrationRequired: false,
    bundleHash: activeBundleHash,
    activeRevision: manifest.activeRevision,
    defaultProvider: modelPolicy.defaultProvider,
    defaultModel: modelPolicy.defaultModel,
    textDataSharing: dataSharing.textPolicy,
    imageDataSharing: dataSharing.imagePolicy,
    stages,
    availableConnections,
  };
}

function resolveProviderAndLocality(
  proposal: StageOverrideProposal,
  connections: ProviderConnection[],
): { provider: string; model: string; locality: ProviderLocality; transport: string } {
  if (proposal.connectionId) {
    const conn = connections.find(c => c.id === proposal.connectionId);
    if (!conn) {
      throw new ClassificationPolicyServiceError(`Connection "${proposal.connectionId}" not found.`, 'connection_not_found', 400);
    }
    const connAny = conn as any;
    const model = proposal.model || connAny.models?.[0]?.id || (conn.transport === 'systemone' ? 'jev-1.13.0' : 'default');
    return {
      provider: conn.id,
      model,
      locality: trustZoneToLocality(conn.trustZone),
      transport: conn.transport,
    };
  }

  const provider = proposal.provider || 'ollama';
  const model = proposal.model || 'qwen2.5:7b';
  return {
    provider,
    model,
    locality: provider === 'ollama' ? 'local' : 'cloud',
    transport: provider === 'ollama' ? 'ollama-native' : 'openai-compatible',
  };
}

/**
 * Previews a proposed classification policy change and returns a bound previewToken.
 */
export function previewClassificationPolicy(
  workspacePath: string,
  input: PreviewPolicyInput,
  workspaceId?: string,
): PreviewPolicyResult {
  let activationContext;
  if (workspaceId) {
    try {
      activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
    } catch {
      // fallback
    }
  }
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind === 'v1') {
    return {
      valid: false,
      previewToken: null,
      baseBundleHash: input.expectedBaseBundleHash,
      dataSharingEffects: [],
      validationErrors: ['v1 classification workspace must be migrated to v2 before configuring stage providers.'],
      diff: { stages: {}, dataSharing: { text: { from: '', to: '' }, image: { from: '', to: '' } } },
    };
  }

  const currentBundle = authority.bundle;
  const currentManifest = currentBundle.manifest;
  const activeDir = path.join(workspacePath, 'store', 'classification');
  let activeBundleHash = currentManifest.bundleHash;
  if (fs.existsSync(path.join(activeDir, 'manifest.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(activeDir, 'manifest.json'), 'utf-8'));
      if (raw.bundleHash) activeBundleHash = raw.bundleHash;
    } catch {
      // fallback
    }
  }

  if (activeBundleHash !== input.expectedBaseBundleHash) {
    return {
      valid: false,
      previewToken: null,
      baseBundleHash: input.expectedBaseBundleHash,
      dataSharingEffects: [],
      validationErrors: [`Configuration has changed (expected ${input.expectedBaseBundleHash}, found ${activeBundleHash}). Please refresh.`],
      diff: { stages: {}, dataSharing: { text: { from: '', to: '' }, image: { from: '', to: '' } } },
    };
  }

  const fullRouting = getFullAiRoutingConfig();
  const connections = Object.values(fullRouting.connections);

  const validationErrors: string[] = [];
  const dataSharingEffects: string[] = [];
  const diffStages: PreviewPolicyResult['diff']['stages'] = {};

  const proposedOverrides: Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }> = {
    ...currentBundle.modelPolicy.stageOverrides,
  };
  const providerLocalities: Record<string, ProviderLocality> = {
    ...currentBundle.modelPolicy.providerLocalities,
  };

  let hasCloudProvider = false;

  for (const stage of CLASSIFICATION_POLICY_STAGES) {
    const proposal = input.stageOverrides[stage.id];
    const currentOverride = currentBundle.modelPolicy.stageOverrides[stage.id];
    const fromProvider = currentOverride?.provider || currentBundle.modelPolicy.defaultProvider;
    const fromModel = currentOverride?.model || currentBundle.modelPolicy.defaultModel;

    if (!proposal) {
      diffStages[stage.id] = {
        from: { provider: fromProvider, model: fromModel },
        to: { provider: fromProvider, model: fromModel },
      };
      if (providerLocalities[fromProvider] === 'cloud') hasCloudProvider = true;
      continue;
    }

    try {
      const resolved = resolveProviderAndLocality(proposal, connections);

      // Check stage adapter compatibility
      if (resolved.transport === 'systemone') {
        if (stage.id !== 'primary_product_type_proposal' && stage.id !== 'product_attribute_proposals') {
          validationErrors.push(`TypeSafe Jev typed-judgment adapter is not yet available for stage "${stage.label}" (pending stage adapter).`);
        }
      } else if (!stage.supportedTransports.includes(resolved.transport as any)) {
        validationErrors.push(`Provider transport "${resolved.transport}" is not supported for stage "${stage.label}".`);
      }

      proposedOverrides[stage.id] = {
        provider: resolved.provider,
        model: resolved.model,
        fallbackProvider: proposal.fallbackProvider ?? null,
        fallbackModel: proposal.fallbackModel ?? null,
      };
      providerLocalities[resolved.provider] = resolved.locality;

      if (resolved.locality === 'cloud') {
        hasCloudProvider = true;
        dataSharingEffects.push(`Stage "${stage.label}" uses cloud provider "${resolved.provider}". Text data will be sent to external cloud endpoint.`);
      }

      diffStages[stage.id] = {
        from: { provider: fromProvider, model: fromModel },
        to: { provider: resolved.provider, model: resolved.model },
      };
    } catch (err) {
      validationErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const proposedTextSharing = input.textDataSharing || currentBundle.dataSharing.textPolicy;
  const proposedImageSharing = input.imageDataSharing || currentBundle.dataSharing.imagePolicy;

  if (hasCloudProvider && proposedTextSharing !== 'cloud_allowed') {
    validationErrors.push(`Using a cloud provider requires textDataSharing to be cloud_allowed (currently "${proposedTextSharing}").`);
  }

  if (!hasCloudProvider && proposedTextSharing === 'local_only') {
    dataSharingEffects.push('All configured providers are local; product data remains strictly on-device.');
  }

  const valid = validationErrors.length === 0;

  // Build deterministic preview token binding inputs and base bundle hash
  const previewToken = valid
    ? sha256Hex(canonicalJsonStringify({
        baseBundleHash: input.expectedBaseBundleHash,
        stageOverrides: proposedOverrides,
        textDataSharing: proposedTextSharing,
        imageDataSharing: proposedImageSharing,
        defaultProvider: input.defaultProvider || currentBundle.modelPolicy.defaultProvider,
        defaultModel: input.defaultModel || currentBundle.modelPolicy.defaultModel,
      }))
    : null;

  return {
    valid,
    previewToken,
    baseBundleHash: input.expectedBaseBundleHash,
    dataSharingEffects,
    validationErrors,
    diff: {
      stages: diffStages,
      dataSharing: {
        text: { from: currentBundle.dataSharing.textPolicy, to: proposedTextSharing },
        image: { from: currentBundle.dataSharing.imagePolicy, to: proposedImageSharing },
      },
    },
  };
}

/**
 * Applies a previewed classification policy under CAS and configuration locking.
 */
export async function applyClassificationPolicy(
  workspacePath: string,
  workspaceId: string,
  input: ApplyPolicyInput,
): Promise<ApplyPolicyResult> {
  // Re-preview to validate token and inputs
  const preview = previewClassificationPolicy(workspacePath, {
    expectedBaseBundleHash: input.expectedBaseBundleHash,
    stageOverrides: input.stageOverrides,
    defaultProvider: input.defaultProvider,
    defaultModel: input.defaultModel,
    textDataSharing: input.textDataSharing,
    imageDataSharing: input.imageDataSharing,
  }, workspaceId);

  if (!preview.valid) {
    throw new ClassificationPolicyServiceError(
      `Cannot apply invalid policy preview: ${preview.validationErrors.join('; ')}`,
      'invalid_policy_preview',
      400,
    );
  }

  if (preview.previewToken !== input.previewToken) {
    throw new ClassificationPolicyServiceError(
      'Preview token mismatch or expired. Please re-preview before applying.',
      'stale_preview_token',
      409,
    );
  }

  let activationContext;
  if (workspaceId) {
    try {
      activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
    } catch {
      // fallback
    }
  }
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind !== 'v2') {
    throw new ClassificationPolicyServiceError('Workspace is not v2.', 'v1_migration_required', 400);
  }

  const currentBundle = authority.bundle;
  const fullRouting = getFullAiRoutingConfig();
  const connections = Object.values(fullRouting.connections);

  const proposedOverrides: Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }> = {
    ...currentBundle.modelPolicy.stageOverrides,
  };
  const providerLocalities: Record<string, ProviderLocality> = {
    ...currentBundle.modelPolicy.providerLocalities,
  };

  const effectiveRoutes: Record<string, { provider: string; model: string }> = {};

  for (const stage of CLASSIFICATION_POLICY_STAGES) {
    const proposal = input.stageOverrides[stage.id];
    if (proposal) {
      const resolved = resolveProviderAndLocality(proposal, connections);
      proposedOverrides[stage.id] = {
        provider: resolved.provider,
        model: resolved.model,
        fallbackProvider: proposal.fallbackProvider ?? null,
        fallbackModel: proposal.fallbackModel ?? null,
      };
      providerLocalities[resolved.provider] = resolved.locality;
      effectiveRoutes[stage.id] = { provider: resolved.provider, model: resolved.model };
    } else {
      const curr = currentBundle.modelPolicy.stageOverrides[stage.id];
      effectiveRoutes[stage.id] = {
        provider: curr?.provider || currentBundle.modelPolicy.defaultProvider,
        model: curr?.model || currentBundle.modelPolicy.defaultModel,
      };
    }
  }

  const newModelPolicy: ModelPolicyConfigV2 = {
    ...currentBundle.modelPolicy,
    defaultProvider: input.defaultProvider || currentBundle.modelPolicy.defaultProvider,
    defaultModel: input.defaultModel || currentBundle.modelPolicy.defaultModel,
    providerLocalities,
    stageOverrides: proposedOverrides,
    textDataSharing: input.textDataSharing || currentBundle.modelPolicy.textDataSharing,
    imageDataSharing: input.imageDataSharing || currentBundle.modelPolicy.imageDataSharing,
  };

  const newDataSharing: DataSharingConfigV2 = {
    ...currentBundle.dataSharing,
    textPolicy: input.textDataSharing || currentBundle.dataSharing.textPolicy,
    imagePolicy: input.imageDataSharing || currentBundle.dataSharing.imagePolicy,
  };

  try {
    const writeResult = await updateClassificationPolicy({
      workspacePath,
      workspaceId,
      expectedBaseBundleHash: input.expectedBaseBundleHash,
      modelPolicy: newModelPolicy,
      dataSharing: newDataSharing,
    });

    return {
      success: true,
      bundleHash: writeResult.bundleHash,
      commitHash: writeResult.commitHash,
      updatedAt: writeResult.updatedAt,
      effectiveRoutes,
    };
  } catch (err) {
    if (err instanceof ConfigStoreConflictError) {
      throw new ClassificationPolicyServiceError(err.message, 'config_conflict', 409);
    }
    if (err instanceof ConfigStoreError) {
      throw new ClassificationPolicyServiceError(err.message, err.code, 400);
    }
    throw err;
  }
}
