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
    adapterStatus: 'supported',
    supportedTransports: ['openai-compatible', 'ollama-native', 'systemone'],
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
  stageSupport: Record<string, { supported: boolean; reason?: string; multiValueSupported?: boolean; cohortSupported?: boolean }>;
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

// ─── Shared policy plumbing (extracted to keep handler complexity low) ───────
// Each helper below owns one narrow concern; behavior is byte-identical to the
// pre-extraction inline blocks (same messages, same CAS/token semantics).

function resolveActivationContext(workspacePath: string, workspaceId?: string) {
  if (!workspaceId) return undefined;
  try {
    return createRuntimeActivationContext(workspacePath, workspaceId);
  } catch {
    return undefined;
  }
}

function readActiveBundleHash(workspacePath: string, fallbackHash: string): string {
  const manifestPath = path.join(workspacePath, 'store', 'classification', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return fallbackHash;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (raw.bundleHash) return raw.bundleHash;
  } catch {
    // Fall back to the bundle manifest hash.
  }
  return fallbackHash;
}

type StageSupportMap = ConnectionOption['stageSupport'];

function stageSupportForSystemOne(stage: StageDefinition): StageSupportMap[string] {
  if (stage.id === 'primary_product_type_proposal') return { supported: true };
  if (stage.id === 'product_attribute_proposals') return { supported: true, multiValueSupported: true };
  if (stage.id === 'category_page_proposals') return { supported: true, cohortSupported: true };
  return {
    supported: false,
    reason: `TypeSafe Jev typed-judgment adapter is not yet available for stage "${stage.label}" (pending stage adapter).`,
  };
}

function stageSupportForTransport(stage: StageDefinition, transport: string): StageSupportMap[string] {
  if (stage.supportedTransports.includes(transport as never)) {
    return {
      supported: true,
      ...(stage.id === 'product_attribute_proposals' ? { multiValueSupported: true } : {}),
      ...(stage.id === 'category_page_proposals' ? { cohortSupported: true } : {}),
    };
  }
  return {
    supported: false,
    reason: `Transport "${transport}" is not supported for stage "${stage.label}".`,
  };
}

function buildStageSupportForConnection(conn: ProviderConnection): StageSupportMap {
  const support: StageSupportMap = {};
  for (const stage of CLASSIFICATION_POLICY_STAGES) {
    support[stage.id] = conn.transport === 'systemone'
      ? stageSupportForSystemOne(stage)
      : stageSupportForTransport(stage, conn.transport);
  }
  return support;
}

function connectionModels(conn: ProviderConnection): Array<{ id: string; name: string }> {
  const connAny = conn as unknown as { models?: unknown; lastProbeStatus?: string };
  if (Array.isArray(connAny.models)) return connAny.models as Array<{ id: string; name: string }>;
  if (conn.transport === 'systemone') return [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }];
  return [];
}

function connectionStatus(conn: ProviderConnection): string {
  const connAny = conn as unknown as { lastProbeStatus?: string };
  return connAny.lastProbeStatus || getCachedConnectionHealth(conn.id) || 'healthy';
}

function toConnectionOption(conn: ProviderConnection): ConnectionOption {
  return {
    id: conn.id,
    label: conn.label || conn.id,
    transport: conn.transport,
    trustZone: conn.trustZone,
    locality: trustZoneToLocality(conn.trustZone),
    enabled: conn.enabled !== false,
    status: connectionStatus(conn),
    models: connectionModels(conn),
    stageSupport: buildStageSupportForConnection(conn),
  };
}

function findMatchingConnection(
  connections: ProviderConnection[],
  effectiveProvider: string,
): ProviderConnection | undefined {
  return connections.find(c =>
    c.id === effectiveProvider ||
    c.label === effectiveProvider ||
    (c.transport === 'ollama-native' && effectiveProvider === 'ollama'),
  );
}

function resolveEffectiveProviderModel(
  stage: StageDefinition,
  modelPolicy: { defaultProvider: string; defaultModel: string; stageOverrides: StageOverrideRecord },
): { isInherited: boolean; provider: string; model: string; fallbackProvider: string | null; fallbackModel: string | null } {
  const override = modelPolicy.stageOverrides[stage.id];
  const isInherited = !override || !override.provider;
  return {
    isInherited,
    provider: (!isInherited && override.provider) ? override.provider : modelPolicy.defaultProvider,
    model: (!isInherited && override.model) ? override.model : modelPolicy.defaultModel,
    fallbackProvider: override?.fallbackProvider ?? null,
    fallbackModel: override?.fallbackModel ?? null,
  };
}

function resolveConnectionDisplay(
  matchedConn: ProviderConnection | undefined,
  effectiveProvider: string,
  providerLocalities: Record<string, ProviderLocality>,
): Pick<EffectiveStageRoute, 'connectionId' | 'connectionLabel' | 'connectionStatus' | 'connectionLocality'> {
  const matchedAny = matchedConn as unknown as { lastProbeStatus?: string } | undefined;
  return {
    connectionId: matchedConn?.id ?? null,
    connectionLabel: matchedConn?.label ?? effectiveProvider,
    connectionStatus: matchedAny?.lastProbeStatus || (matchedConn ? getCachedConnectionHealth(matchedConn.id) : null) || 'healthy',
    connectionLocality: matchedConn ? trustZoneToLocality(matchedConn.trustZone) : (providerLocalities[effectiveProvider] ?? 'local'),
  };
}

function toEffectiveStageRoute(
  stage: StageDefinition,
  modelPolicy: { defaultProvider: string; defaultModel: string; stageOverrides: StageOverrideRecord; providerLocalities: Record<string, ProviderLocality> },
  connections: ProviderConnection[],
): EffectiveStageRoute {
  const resolved = resolveEffectiveProviderModel(stage, modelPolicy);
  const matchedConn = findMatchingConnection(connections, resolved.provider);
  return {
    id: stage.id,
    label: stage.label,
    description: stage.description,
    isInherited: resolved.isInherited,
    effectiveProvider: resolved.provider,
    effectiveModel: resolved.model,
    effectiveFallbackProvider: resolved.fallbackProvider,
    effectiveFallbackModel: resolved.fallbackModel,
    ...resolveConnectionDisplay(matchedConn, resolved.provider, modelPolicy.providerLocalities),
  };
}

function emptyPreviewDiff(): PreviewPolicyResult['diff'] {
  return { stages: {}, dataSharing: { text: { from: '', to: '' }, image: { from: '', to: '' } } };
}

function invalidPreview(baseBundleHash: string, validationErrors: string[]): PreviewPolicyResult {
  return {
    valid: false,
    previewToken: null,
    baseBundleHash,
    dataSharingEffects: [],
    validationErrors,
    diff: emptyPreviewDiff(),
  };
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

  const activationContext = resolveActivationContext(workspacePath, _workspaceId);
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
  const activeBundleHash = readActiveBundleHash(workspacePath, bundle.manifest.bundleHash);
  const connections = Object.values(getFullAiRoutingConfig().connections);
  return {
    migrationRequired: false,
    bundleHash: activeBundleHash,
    activeRevision: bundle.manifest.activeRevision,
    defaultProvider: bundle.modelPolicy.defaultProvider,
    defaultModel: bundle.modelPolicy.defaultModel,
    textDataSharing: bundle.dataSharing.textPolicy,
    imageDataSharing: bundle.dataSharing.imagePolicy,
    stages: CLASSIFICATION_POLICY_STAGES.map(stage => toEffectiveStageRoute(stage, bundle.modelPolicy, connections)),
    availableConnections: connections.map(toConnectionOption),
  };
}

function resolveConnectionProposal(
  proposal: StageOverrideProposal,
  connections: ProviderConnection[],
): { provider: string; model: string; locality: ProviderLocality; transport: string } {
  const conn = connections.find(c => c.id === proposal.connectionId);
  if (!conn) {
    throw new ClassificationPolicyServiceError(`Connection "${proposal.connectionId}" not found.`, 'connection_not_found', 400);
  }
  const connAny = conn as unknown as { models?: Array<{ id: string }> };
  const model = proposal.model || connAny.models?.[0]?.id || (conn.transport === 'systemone' ? 'jev-1.13.0' : 'default');
  return {
    provider: conn.id,
    model,
    locality: trustZoneToLocality(conn.trustZone),
    transport: conn.transport,
  };
}

function resolveLegacyProposal(
  proposal: StageOverrideProposal,
): { provider: string; model: string; locality: ProviderLocality; transport: string } {
  const provider = proposal.provider || 'ollama';
  const model = proposal.model || 'qwen2.5:7b';
  return {
    provider,
    model,
    locality: provider === 'ollama' ? 'local' : 'cloud',
    transport: provider === 'ollama' ? 'ollama-native' : 'openai-compatible',
  };
}

function resolveProviderAndLocality(
  proposal: StageOverrideProposal,
  connections: ProviderConnection[],
): { provider: string; model: string; locality: ProviderLocality; transport: string } {
  if (proposal.connectionId) return resolveConnectionProposal(proposal, connections);
  return resolveLegacyProposal(proposal);
}

function checkStageTransportSupport(stage: StageDefinition, transport: string): string | null {
  if (transport === 'systemone') {
    if (
      stage.id !== 'primary_product_type_proposal' &&
      stage.id !== 'product_attribute_proposals' &&
      stage.id !== 'category_page_proposals'
    ) {
      return `TypeSafe Jev typed-judgment adapter is not yet available for stage "${stage.label}" (pending stage adapter).`;
    }
    return null;
  }
  if (!stage.supportedTransports.includes(transport as never)) {
    return `Provider transport "${transport}" is not supported for stage "${stage.label}".`;
  }
  return null;
}

interface StagePreviewAccumulator {
  proposedOverrides: Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }>;
  providerLocalities: Record<string, ProviderLocality>;
  diffStages: PreviewPolicyResult['diff']['stages'];
  validationErrors: string[];
  dataSharingEffects: string[];
  hasCloudProvider: boolean;
}

type StageOverrideRecord = Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }>;

function accumulateUnchangedStage(
  stage: StageDefinition,
  currentBundle: { modelPolicy: { defaultProvider: string; defaultModel: string; stageOverrides: StageOverrideRecord; providerLocalities: Record<string, ProviderLocality> } },
  acc: StagePreviewAccumulator,
): void {
  const currentOverride = currentBundle.modelPolicy.stageOverrides[stage.id];
  const fromProvider = currentOverride?.provider || currentBundle.modelPolicy.defaultProvider;
  const fromModel = currentOverride?.model || currentBundle.modelPolicy.defaultModel;
  acc.diffStages[stage.id] = {
    from: { provider: fromProvider, model: fromModel },
    to: { provider: fromProvider, model: fromModel },
  };
  if (acc.providerLocalities[fromProvider] === 'cloud') acc.hasCloudProvider = true;
}

function accumulateProposedStage(
  stage: StageDefinition,
  proposal: StageOverrideProposal,
  currentBundle: { modelPolicy: { defaultProvider: string; defaultModel: string; stageOverrides: StageOverrideRecord } },
  connections: ProviderConnection[],
  acc: StagePreviewAccumulator,
): void {
  const currentOverride = currentBundle.modelPolicy.stageOverrides[stage.id];
  const fromProvider = currentOverride?.provider || currentBundle.modelPolicy.defaultProvider;
  const fromModel = currentOverride?.model || currentBundle.modelPolicy.defaultModel;
  try {
    const resolved = resolveProviderAndLocality(proposal, connections);
    const supportError = checkStageTransportSupport(stage, resolved.transport);
    if (supportError) acc.validationErrors.push(supportError);
    acc.proposedOverrides[stage.id] = {
      provider: resolved.provider,
      model: resolved.model,
      fallbackProvider: proposal.fallbackProvider ?? null,
      fallbackModel: proposal.fallbackModel ?? null,
    };
    acc.providerLocalities[resolved.provider] = resolved.locality;
    if (resolved.locality === 'cloud') {
      acc.hasCloudProvider = true;
      acc.dataSharingEffects.push(`Stage "${stage.label}" uses cloud provider "${resolved.provider}". Text data will be sent to external cloud endpoint.`);
    }
    acc.diffStages[stage.id] = {
      from: { provider: fromProvider, model: fromModel },
      to: { provider: resolved.provider, model: resolved.model },
    };
  } catch (err) {
    acc.validationErrors.push(err instanceof Error ? err.message : String(err));
  }
}

function validateCloudSharing(
  hasCloudProvider: boolean,
  proposedTextSharing: string,
  acc: Pick<StagePreviewAccumulator, 'validationErrors' | 'dataSharingEffects'>,
): void {
  if (hasCloudProvider && proposedTextSharing !== 'cloud_allowed') {
    acc.validationErrors.push(`Using a cloud provider requires textDataSharing to be cloud_allowed (currently "${proposedTextSharing}").`);
  }
  if (!hasCloudProvider && proposedTextSharing === 'local_only') {
    acc.dataSharingEffects.push('All configured providers are local; product data remains strictly on-device.');
  }
}

function buildPreviewToken(
  valid: boolean,
  input: PreviewPolicyInput,
  acc: Pick<StagePreviewAccumulator, 'proposedOverrides'>,
  proposedTextSharing: string,
  proposedImageSharing: string,
  currentBundle: { modelPolicy: { defaultProvider: string; defaultModel: string } },
): string | null {
  if (!valid) return null;
  return sha256Hex(canonicalJsonStringify({
    baseBundleHash: input.expectedBaseBundleHash,
    stageOverrides: acc.proposedOverrides,
    textDataSharing: proposedTextSharing,
    imageDataSharing: proposedImageSharing,
    defaultProvider: input.defaultProvider || currentBundle.modelPolicy.defaultProvider,
    defaultModel: input.defaultModel || currentBundle.modelPolicy.defaultModel,
  }));
}

/**
 * Previews a proposed classification policy change and returns a bound previewToken.
 */
export function previewClassificationPolicy(
  workspacePath: string,
  input: PreviewPolicyInput,
  workspaceId?: string,
): PreviewPolicyResult {
  const activationContext = resolveActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind === 'v1') {
    return invalidPreview(input.expectedBaseBundleHash, [
      'v1 classification workspace must be migrated to v2 before configuring stage providers.',
    ]);
  }

  const currentBundle = authority.bundle;
  const activeBundleHash = readActiveBundleHash(workspacePath, currentBundle.manifest.bundleHash);
  if (activeBundleHash !== input.expectedBaseBundleHash) {
    return invalidPreview(input.expectedBaseBundleHash, [
      `Configuration has changed (expected ${input.expectedBaseBundleHash}, found ${activeBundleHash}). Please refresh.`,
    ]);
  }

  const connections = Object.values(getFullAiRoutingConfig().connections);
  const acc: StagePreviewAccumulator = {
    proposedOverrides: { ...currentBundle.modelPolicy.stageOverrides },
    providerLocalities: { ...currentBundle.modelPolicy.providerLocalities },
    diffStages: {},
    validationErrors: [],
    dataSharingEffects: [],
    hasCloudProvider: false,
  };

  for (const stage of CLASSIFICATION_POLICY_STAGES) {
    const proposal = input.stageOverrides[stage.id];
    if (!proposal) accumulateUnchangedStage(stage, currentBundle, acc);
    else accumulateProposedStage(stage, proposal, currentBundle, connections, acc);
  }

  const proposedTextSharing = input.textDataSharing || currentBundle.dataSharing.textPolicy;
  const proposedImageSharing = input.imageDataSharing || currentBundle.dataSharing.imagePolicy;
  validateCloudSharing(acc.hasCloudProvider, proposedTextSharing, acc);

  const valid = acc.validationErrors.length === 0;
  return {
    valid,
    previewToken: buildPreviewToken(valid, input, acc, proposedTextSharing, proposedImageSharing, currentBundle),
    baseBundleHash: input.expectedBaseBundleHash,
    dataSharingEffects: acc.dataSharingEffects,
    validationErrors: acc.validationErrors,
    diff: {
      stages: acc.diffStages,
      dataSharing: {
        text: { from: currentBundle.dataSharing.textPolicy, to: proposedTextSharing },
        image: { from: currentBundle.dataSharing.imagePolicy, to: proposedImageSharing },
      },
    },
  };
}

function revalidatePreviewForApply(
  workspacePath: string,
  workspaceId: string,
  input: ApplyPolicyInput,
): PreviewPolicyResult {
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
  return preview;
}

function loadV2BundleForApply(workspacePath: string, workspaceId: string) {
  const activationContext = resolveActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind !== 'v2') {
    throw new ClassificationPolicyServiceError('Workspace is not v2.', 'v1_migration_required', 400);
  }
  return authority.bundle;
}

function buildApplyOverrides(
  currentBundle: { modelPolicy: { defaultProvider: string; defaultModel: string; stageOverrides: StageOverrideRecord; providerLocalities: Record<string, ProviderLocality> } },
  connections: ProviderConnection[],
  stageOverrides: Record<string, StageOverrideProposal>,
): {
  proposedOverrides: Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }>;
  providerLocalities: Record<string, ProviderLocality>;
  effectiveRoutes: Record<string, { provider: string; model: string }>;
} {
  const proposedOverrides: Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }> = {
    ...currentBundle.modelPolicy.stageOverrides,
  };
  const providerLocalities: Record<string, ProviderLocality> = {
    ...currentBundle.modelPolicy.providerLocalities,
  };
  const effectiveRoutes: Record<string, { provider: string; model: string }> = {};
  for (const stage of CLASSIFICATION_POLICY_STAGES) {
    const proposal = stageOverrides[stage.id];
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
  return { proposedOverrides, providerLocalities, effectiveRoutes };
}

function buildUpdatedPolicies(
  currentBundle: { modelPolicy: ModelPolicyConfigV2; dataSharing: DataSharingConfigV2 },
  input: ApplyPolicyInput,
  proposedOverrides: Record<string, { provider?: string; model?: string; fallbackProvider: string | null; fallbackModel: string | null }>,
  providerLocalities: Record<string, ProviderLocality>,
): { newModelPolicy: ModelPolicyConfigV2; newDataSharing: DataSharingConfigV2 } {
  return {
    newModelPolicy: {
      ...currentBundle.modelPolicy,
      defaultProvider: input.defaultProvider || currentBundle.modelPolicy.defaultProvider,
      defaultModel: input.defaultModel || currentBundle.modelPolicy.defaultModel,
      providerLocalities,
      stageOverrides: proposedOverrides,
      textDataSharing: input.textDataSharing || currentBundle.modelPolicy.textDataSharing,
      imageDataSharing: input.imageDataSharing || currentBundle.modelPolicy.imageDataSharing,
    },
    newDataSharing: {
      ...currentBundle.dataSharing,
      textPolicy: input.textDataSharing || currentBundle.dataSharing.textPolicy,
      imagePolicy: input.imageDataSharing || currentBundle.dataSharing.imagePolicy,
    },
  };
}

function mapConfigStoreError(err: unknown): never {
  if (err instanceof ConfigStoreConflictError) {
    throw new ClassificationPolicyServiceError(err.message, 'config_conflict', 409);
  }
  if (err instanceof ConfigStoreError) {
    throw new ClassificationPolicyServiceError(err.message, err.code, 400);
  }
  throw err;
}

/**
 * Applies a previewed classification policy under CAS and configuration locking.
 */
export async function applyClassificationPolicy(
  workspacePath: string,
  workspaceId: string,
  input: ApplyPolicyInput,
): Promise<ApplyPolicyResult> {
  revalidatePreviewForApply(workspacePath, workspaceId, input);
  const currentBundle = loadV2BundleForApply(workspacePath, workspaceId);
  const connections = Object.values(getFullAiRoutingConfig().connections);
  const { proposedOverrides, providerLocalities, effectiveRoutes } = buildApplyOverrides(
    currentBundle,
    connections,
    input.stageOverrides,
  );
  const { newModelPolicy, newDataSharing } = buildUpdatedPolicies(
    currentBundle,
    input,
    proposedOverrides,
    providerLocalities,
  );

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
    mapConfigStoreError(err);
  }
}
