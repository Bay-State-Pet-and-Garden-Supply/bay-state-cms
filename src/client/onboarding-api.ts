import type {
  OnboardingBatch,
  OnboardingItem,
  OnboardingSource,
  ExtractionData,
  CurationData,
  ColumnMapping,
  BrandSite,
  ExtractorProfile,
  PipelineStage,
  LlmTask,
  LlmProvider,
  LlmTaskConfig,
  StructuredFeedback,
  ProfileGenerationGeneration,
  ProfileGenerationRevision,
  ProfileGenerationValidationResult,
  ProfileGenerationFieldDecision,
  DomainProfileGovernance,
  DomainDiagnosticsEntry,
  DomainDiagnosticsResponse,
  ProfileBlockedItem,
  DistributorEvidenceAttemptView,
  SitemapsOverviewResponse,
  SitemapDomainDetailResponse,
  DomainSitemapSummary,
  BrandUrlsListResponse,
  SitemapTestLookupResponse,
  SitemapTestLookupRequest,
  MediaSelectionRequest,
  FallbackSourcingItemsResponse,
} from '../shared/schemas/onboarding';

export interface MissingBrandGroup {
  key: string;
  suggestedBrand: string | null;
  itemCount: number;
  itemIds: string[];
  sampleProductNames: string[];
}
import type {
  WorkerHealthResponse,
  SnapshotRequest,
  SnapshotResponse,
  ValidateRequest,
  ValidateResponse,
  GenerateSelectorRequest,
  GenerateSelectorResponse,

} from '../shared/schemas/extraction-worker';
import type {
  ClassificationProposalDecision,
  CurationTargetConfig,
  ProposalDecisionInput,
} from '../shared/schemas/classification';
import type { GenerateSelectorsResponse, GenerateSelectorsRequest } from '../shared/schemas/selector-generation';
import type { CohortListResponse } from '../shared/schemas/cohorts';
import type { WorkStateCounts } from '../shared/schemas/onboarding-work-state';

const API_BASE = '/api/onboarding';

export class OnboardingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    /**
     * Full response body (additive, e10s03): lets callers recover structured
     * detail — e.g. review-complete rejection `failures[].blockers` — without
     * re-parsing human messages.
     */
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'OnboardingApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const errorObj = (data as any).error;
    const errMsg = typeof errorObj === 'object' && errorObj && 'message' in errorObj
      ? errorObj.message
      : errorObj || `HTTP ${res.status}`;
    const code = typeof (data as any).code === 'string' ? (data as any).code : null;
    throw new OnboardingApiError(errMsg, res.status, code, data);
  }
  return data as T;
}

export interface UploadResponse {
  fileName: string;
  headers: string[];
  mapping: Partial<ColumnMapping>;
  rowsCount: number;
  tempRows: Record<string, string>[];
}

export async function uploadSpreadsheet(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/batches/upload`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  return data as UploadResponse;
}

export async function createBatch(data: {
  name: string;
  fileName: string;
  mapping: ColumnMapping;
  rows: Record<string, string>[];
  brandMappings?: Record<string, string>;
}): Promise<{ batch: OnboardingBatch; validationErrors: any[] }> {
  return request<{ batch: OnboardingBatch; validationErrors: any[] }>('/batches', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function resolveBrandDomains(brands: string[]): Promise<{ mappings: Record<string, string | null> }> {
  return request<{ mappings: Record<string, string | null> }>('/settings/brand-sites/resolve', {
    method: 'POST',
    body: JSON.stringify({ brands }),
  });
}

export async function getBatches(): Promise<{ batches: OnboardingBatch[]; workStateCounts: Record<string, WorkStateCounts> }> {
  return request<{ batches: OnboardingBatch[]; workStateCounts: Record<string, WorkStateCounts> }>('/batches');
}

export async function getBatch(id: string): Promise<{ batch: OnboardingBatch }> {
  return request<{ batch: OnboardingBatch }>(`/batches/${id}`);
}

export async function deleteBatch(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${id}`, {
    method: 'DELETE',
  });
}

export async function getMissingBrandGroups(batchId: string): Promise<{ batchId: string; groups: MissingBrandGroup[] }> {
  return request<{ batchId: string; groups: MissingBrandGroup[] }>(`/batches/${batchId}/missing-brand-groups`);
}

export async function startBatch(
  batchId: string,
  mode: 'ready_only' | 'all' = 'ready_only',
): Promise<{ success: boolean; executionState: string }> {
  return request<{ success: boolean; executionState: string }>(
    `/batches/${batchId}/start`,
    {
      method: 'POST',
      body: JSON.stringify({ mode }),
    },
  );
}

export async function pauseBatch(batchId: string): Promise<{ success: boolean; executionState: string }> {
  return request<{ success: boolean; executionState: string }>(`/batches/${batchId}/pause`, {
    method: 'POST',
  });
}

export async function resumeBatch(batchId: string): Promise<{ success: boolean; executionState: string }> {
  return request<{ success: boolean; executionState: string }>(`/batches/${batchId}/resume`, {
    method: 'POST',
  });
}

export async function assignBrandGroup(
  batchId: string,
  itemIds: string[],
  brand: string,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/batches/${batchId}/assign-brand-group`,
    {
      method: 'POST',
      body: JSON.stringify({ itemIds, brand }),
    },
  );
}

export async function getBatchStagedItems(
  batchId: string,
  options?: { vocabularyVersion?: 1 | 2 },
): Promise<{ staged: Record<PipelineStage, OnboardingItem[]> }> {
  // Slice 5b native: the board consumes canonical v2 keys. Default wire
  // stays legacy v1 for unchanged callers; pass { vocabularyVersion: 2 }.
  const suffix = options?.vocabularyVersion === 2 ? '?stageVocabularyVersion=2' : '';
  return request<{ staged: Record<PipelineStage, OnboardingItem[]> }>(`/batches/${batchId}/staged${suffix}`);
}

/**
 * Active candidate curation cohorts for a batch with per-member extraction
 * readiness and derived waiting state (issue #30, PR2).
 */
export async function getBatchCohorts(batchId: string): Promise<CohortListResponse> {
  return request<CohortListResponse>(`/batches/${batchId}/cohorts`);
}

export async function advanceItems(itemIds: string[]): Promise<{ advanced: number; skipped: number }> {
  return request<{ advanced: number; skipped: number }>('/items/advance', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

/**
 * Effective onboarding capabilities reported by the server (Amendment A).
 * The board uses these to decide which Sourcing actions may be surfaced;
 * the server remains the authoritative gate. No secret references or
 * connection details are ever part of this payload.
 */
export interface OnboardingCapabilities {
  sourcing: {
    engineEnabled: boolean;
    /** Sourcing mode (null when OFF / invalid / malformed configuration). */
    mode: 'observe' | 'manual' | 'automatic' | null;
    /** Stable non-secret reason for the current capability state. */
    configurationReason: string;
    /** Durable entry-policy version governing worker claims (1 = post-amendment). */
    entryPolicyVersion: number;
  };
}

/**
 * Server-derived qualification of the current distributor record (Amendment
 * A). Present when an item sits at sourcing/needs_input with an evaluated
 * generation. `qualified` uses the SAME deterministic authority as automatic
 * routing — the client never recomputes it and never supplies ids/hash.
 */
export interface SourcingQualificationView {
  qualified: boolean;
  reasonCodes: string[];
  acceptedEvidenceAttemptIds: string[];
  providerIds: string[];
  evidenceHash: string | null;
  /** The current sourcing generation the view derives from (null when absent). */
  sourcingGenerationId: string | null;
}

export type SourcingResolutionAction = 'use_distributor_record' | 'fallback_to_discovery';

/**
 * Strict Sourcing resolution (Amendment A): the client sends ONLY the
 * action; the server derives every accepted-id/hash/provider value and
 * recomputes qualification. `use_distributor_record` is a manual-mode
 * operator decision; `fallback_to_discovery` is the audited continue path.
 */
export async function resolveSourcingAction(
  itemId: string,
  action: SourcingResolutionAction,
): Promise<{ success: boolean; item?: unknown }> {
  return request<{ success: boolean; item?: unknown }>(`/items/${itemId}/resolve-sourcing`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

/**
 * Operator "Continue with Official Site Discovery" for a distributor-source
 * item at Extraction (MD item 8). The server reverts the item to
 * official-page sourcing (source_url stays null), clears the active
 * extraction payload, moves it to discovery/pending, and preserves all
 * sourcing evidence in one guarded transaction. No body is required — the
 * server is the only authority.
 */
export async function continueWithOfficialDiscovery(
  itemId: string,
): Promise<{ success: boolean; item?: OnboardingItem }> {
  return request<{ success: boolean; item?: OnboardingItem }>(`/items/${itemId}/continue-with-official-discovery`, {
    method: 'POST',
  });
}

export async function getOnboardingCapabilities(): Promise<OnboardingCapabilities> {
  return request<OnboardingCapabilities>('/capabilities');
}

export interface SourcingFallbackItem {
  id: string;
  reason: string;
}

export type { FallbackSourcingItemsResponse };

export async function fallbackSourcingItemsToDiscovery(
  itemIds: string[],
): Promise<FallbackSourcingItemsResponse> {
  return request<FallbackSourcingItemsResponse>('/items/fallback-sourcing-to-discovery', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

/**
 * Parent #101 (manual-evidence route, ticket #104 full set): operator
 * submission of manual evidence for one profile-blocked item. The client
 * sends ONLY raw fields + per-field source kinds + per-image rights +
 * booleans + optional reference-only family context; the server derives
 * all provenance (sourceType, identityStatus, hashes, attestation link).
 */
export type ManualEvidenceFieldSourceKind =
  | 'operator_transcription'
  | 'packaging_photo'
  | 'distributor_sheet'
  | 'brand_family_reference';

export interface SubmitManualEvidenceBody {
  title: string;
  brand?: string | null;
  description?: string | null;
  bulletPoints?: string[];
  weight?: string | null;
  dimensions?: string | null;
  primaryImage?: string | null;
  additionalImages?: string[];
  fieldSources?: Record<string, ManualEvidenceFieldSourceKind>;
  imageApprovals?: Array<{ imageUrl: string; rightsAttested: true }>;
  familyReferenceText?: string | null;
  familyReferenceUrl?: string | null;
  familyPageOnlyConfirmed?: boolean;
  overrideDistributorReason?: string | null;
  attestation: {
    noFamilyInheritance: true;
    perSkuVerified: true;
    rightsAttested: true;
    notes?: string | null;
  };
}

export async function submitManualEvidence(
  itemId: string,
  body: SubmitManualEvidenceBody,
): Promise<{ itemId: string; attestationId: string; extractionId: string }> {
  return request<{ itemId: string; attestationId: string; extractionId: string }>(
    `/items/${itemId}/submit-manual-evidence`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function withdrawManualEvidence(
  itemId: string,
): Promise<{ itemId: string; supersededAttestationId: string }> {
  return request<{ itemId: string; supersededAttestationId: string }>(
    `/items/${itemId}/withdraw-manual-evidence`,
    { method: 'POST' },
  );
}

export async function getManualEvidence(itemId: string): Promise<{
  itemId: string;
  attestation: Record<string, unknown> | null;
  distributorReference?: Record<string, string> | null;
}> {
  return request<{
    itemId: string;
    attestation: Record<string, unknown> | null;
    distributorReference?: Record<string, string> | null;
  }>(
    `/items/${itemId}/manual-evidence`,
  );
}

export async function resetStageItems(
  itemIds: string[],
): Promise<{ success: boolean; moved?: string[]; reset?: string[]; skipped?: Array<{ id: string; reason: string }> }> {
  return request<{ success: boolean; moved?: string[]; reset?: string[]; skipped?: Array<{ id: string; reason: string }> }>('/items/reset', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function skipStageItems(itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/items/skip-bulk', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function moveToPreviousStage(
  itemIds: string[],
): Promise<{ success: boolean; moved: number; skipped: number }> {
  return request<{ success: boolean; moved: number; skipped: number }>('/items/move-to-previous', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function completeReviewStage(itemIds: string[], opts?: { filenameDecisions?: Record<string, 'accept' | 'defer'> }): Promise<{ success: boolean; count: number; legacyCount?: number; classifiedCount?: number }> {
  const res = await fetch(`${API_BASE}/items/review-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      opts?.filenameDecisions ? { itemIds, filenameDecisions: opts.filenameDecisions } : { itemIds },
    ),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    // PR10 (issue #30, DECISION-B): surface the per-item gate reasons inline
    // so a `semantic_validation_blocked` failure shows the EXACT finding
    // reason (the gate's `reason` is the first finding message) in the
    // drawer's existing error display — never just the generic batch error.
    const failures = Array.isArray(data?.failures) ? data.failures as Array<{ reason?: unknown }> : [];
    const reasons = failures
      .map(failure => (typeof failure?.reason === 'string' ? failure.reason : null))
      .filter((reason): reason is string => reason !== null);
    const baseMsg = typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`;
    const message = reasons.length > 0 ? `${baseMsg} ${reasons.join(' ')}` : baseMsg;
    // e10s03: carry the full response body as `payload` so
    // parseBlockersFromRejection can read the structured failures[].blockers
    // codes instead of relying on the human message marker alone.
    throw new OnboardingApiError(message, res.status, typeof data?.code === 'string' ? data.code : null, data);
  }
  return data as { success: boolean; count: number; legacyCount?: number; classifiedCount?: number };
}

export async function getBatchItems(
  batchId: string,
  status?: string,
): Promise<{ items: OnboardingItem[] }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<{ items: OnboardingItem[] }>(`/batches/${batchId}/items${query}`);
}

export async function startSourceDiscovery(batchId: string, itemIds?: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-discovery`, {
    method: 'POST',
    body: itemIds ? JSON.stringify({ itemIds }) : undefined,
  });
}

export async function startExtraction(batchId: string, itemIds?: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-extraction`, {
    method: 'POST',
    body: itemIds ? JSON.stringify({ itemIds }) : undefined,
  });
}

export async function startCuration(batchId: string, itemIds?: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-curation`, {
    method: 'POST',
    body: itemIds ? JSON.stringify({ itemIds }) : undefined,
  });
}

export async function bulkSkipItems(batchId: string, itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/bulk-skip`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function bulkRetryItems(batchId: string, itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/bulk-retry`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function promoteBatchItems(
  batchId: string,
  itemIds: string[],
): Promise<{ changeSetId: string | null; count: number }> {
  return request<{ changeSetId: string | null; count: number }>(`/batches/${batchId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function bulkAssignBrand(
  batchId: string,
  itemIds: string[],
  brandHint: string | null,
  brandDomain: string | null,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/bulk-brand`, {
    method: 'POST',
    body: JSON.stringify({ itemIds, brandHint, brandDomain }),
  });
}

export interface ConsistencyWarning {
  groupId: string;
  groupLabel: string;
  field: 'category_page' | 'primary_product_type' | 'curated_title';
  values: Record<string, string[]>;
  message: string;
}

/**
 * PR10 (issue #30, DECISION-A): the first-class cohort semantic validation
 * surface carried on the hydrated item detail response. Emitted ONLY for
 * ACTIVE-cohort members (`semanticSurface.mode === 'active'`); legacy/shadow
 * items omit the field entirely. `blocked` means the member is NOT
 * review-ready (the review-complete gate refuses with
 * `semantic_validation_blocked`) while its curationData + proposals stay
 * intact (blocked-not-destroyed).
 */
export interface SemanticValidationPayload {
  status: 'passed' | 'blocked';
  findings: Array<{ code: string; memberSku: string; message: string }>;
}

export interface VariantResolutionClientView {
  id: string; status: string; candidates: Array<{ variantKey: string; title: string; sku?: string | null; gtin?: string | null; price?: string | null; available: boolean; image?: string | null; options?: Array<{axis:string;value:string}>; deepLink: string }>; identityMatrixHash: string; platform: string; selectedVariantKey?: string | null; decisionOrigin?: string | null;
}
export interface ItemDetailResponse {
  item: OnboardingItem;
  sources: OnboardingSource[];
  extraction: ExtractionData | null;
  variantResolution?: VariantResolutionClientView | null;
  evidenceAttempts?: DistributorEvidenceAttemptView[];
  /** Sourcing generations for the item (ADR 0014 audit view). */
  generations?: SourcingGenerationView[];
  /** Durable evidence conflicts with candidates (ADR 0014). */
  conflicts?: OnboardingConflictView[];
  /** Amendment A: server-derived distributor-record qualification (manual mode). */
  /** Server-derived distributor-record qualification view; null when no current sourcing generation (or not sourcing stage). */
  sourcingQualificationView?: SourcingQualificationView | null;
  /** Amendment A: durable entry-policy version (0 = legacy pre-amendment row). */
  sourcingEntryPolicyVersion?: number;
  consistencyWarnings: ConsistencyWarning[];
  /** PR10: active-cohort semantic validation surface (omitted in legacy mode). */
  semanticValidation?: SemanticValidationPayload;
}

/** Sourcing generation audit row (ADR 0014: immutable, supersession-linked). */
export interface SourcingGenerationView {
  id: string;
  itemId: string;
  status: 'running' | 'completed' | 'superseded' | 'failed';
  supersedesId: string | null;
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export async function getItemDetail(itemId: string, options?: RequestInit): Promise<ItemDetailResponse> {
  return request<ItemDetailResponse>(`/items/${itemId}`, options);
}

/**
 * e10s04: persist the reviewer media selection (primary/order/suppression).
 * Server validates the candidate-set union, enforces distributor approved-only
 * constraints, and invalidates durable review (consequential edit).
 */
export async function updateItemMedia(
  itemId: string,
  selection: MediaSelectionRequest,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/media`, {
    method: 'PUT',
    body: JSON.stringify(selection),
  });
}

export async function updateItem(
  itemId: string,
  data: Partial<OnboardingItem> & { 
    extraction_data?: Partial<ExtractionData>;
    curation_data?: Partial<CurationData>;
    brandHint?: string | null;
    brandDomain?: string | null;
    propagateBrandName?: boolean;
  },
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function retryItem(itemId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/retry`, {
    method: 'POST',
  });
}

export async function selectSource(itemId: string, sourceId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/select-source`, {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  });
}
export async function selectVariant(itemId: string, req: { resolutionId: string; identityMatrixHash: string; variantKey: string }): Promise<{ success: boolean; sourceUrl?: string }> {
  return request<{ success: boolean; sourceUrl?: string }>(`/items/${itemId}/select-variant`, { method: 'POST', body: JSON.stringify(req) });
}

export async function setItemUrl(itemId: string, url: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/set-url`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

/**
 * ADR 0017 commitment 4 — discovery-card attention action: assign a brand
 * hint to the item and re-run official site discovery guided by that brand
 * (server resets the item to discovery/pending and polls the worker).
 */
export async function assignItemBrand(
  itemId: string,
  brand: string,
): Promise<{ success: boolean; item?: OnboardingItem }> {
  return request<{ success: boolean; item?: OnboardingItem }>(`/items/${itemId}/assign-brand`, {
    method: 'POST',
    body: JSON.stringify({ brand }),
  });
}

/**
 * ADR 0017 commitment 4 — discovery-card attention action: map an official
 * domain for the item's current brand hint (brand_sites upsert) and re-run
 * official site discovery. Fails server-side with a clear error when the
 * item has no brand hint yet (assign the brand first).
 */
export async function assignItemDomain(
  itemId: string,
  domain: string,
): Promise<{ success: boolean; item?: OnboardingItem }> {
  return request<{ success: boolean; item?: OnboardingItem }>(`/items/${itemId}/assign-domain`, {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
}

export async function skipItem(itemId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/skip`, {
    method: 'POST',
  });
}

// Settings APIs
export interface ApiKeyDisplay {
  id: string;
  service: string;
  apiKey: string;
  baseUrl: string | null;
  model: string | null;
}

export async function getApiKeys(): Promise<{ keys: ApiKeyDisplay[] }> {
  return request<{ keys: ApiKeyDisplay[] }>('/settings/api-keys');
}

export async function updateApiKey(
  service: string,
  apiKey: string,
  baseUrl?: string | null,
  model?: string | null,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/api-keys/${service}`, {
    method: 'PUT',
    body: JSON.stringify({ apiKey, baseUrl, model }),
  });
}

export async function deleteApiKey(service: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/api-keys/${service}`, {
    method: 'DELETE',
  });
}

export async function getBrandSites(): Promise<{ brandSites: BrandSite[]; catalogBrands?: string[] }> {
  return request<{ brandSites: BrandSite[]; catalogBrands?: string[] }>('/settings/brand-sites');
}

export async function getOpenaiModels(apiKey?: string, baseUrl?: string): Promise<{ models: string[] }> {
  const params = new URLSearchParams();
  if (apiKey) params.set('apiKey', apiKey);
  if (baseUrl) params.set('baseUrl', baseUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ models: string[] }>(`/settings/openai/models${qs}`);
}

export async function getDeepseekModels(apiKey?: string, baseUrl?: string): Promise<{ models: string[] }> {
  const params = new URLSearchParams();
  if (apiKey) params.set('apiKey', apiKey);
  if (baseUrl) params.set('baseUrl', baseUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ models: string[] }>(`/settings/deepseek/models${qs}`);
}

export async function getExtractorProfiles(): Promise<{ extractorProfiles: ExtractorProfile[] }> {
  return request<{ extractorProfiles: ExtractorProfile[] }>('/settings/extractor-profiles');
}

export interface SaveExtractorProfilePayload {
  domain: string;
  titleSelector?: string | null;
  titleOptionalSelectors?: string[];
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  customSelectors?: Record<string, string>;
  sitemapProductUrlPattern?: string | null;
  shopifyJSONPath?: boolean;
  variantSelectionStrategy?: Record<string, unknown> | null;
  customSelectorMetadata?: Record<string, unknown>;
  runtime?: 'static' | 'rendered';
}

export async function saveExtractorProfile(data: SaveExtractorProfilePayload): Promise<{ success: boolean; profile: ExtractorProfile }> {
  return request<{ success: boolean; profile: ExtractorProfile }>('/settings/extractor-profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface DomainConfigPayload {
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  sitemapProductUrlPattern?: string | null;
  brands?: Array<{
    id?: string;
    brandName: string;
    urlPattern?: string | null;
    successCount?: number;
  }>;
}

// fallow-ignore-next-line unused-export — used by tests
export async function saveDomainConfig(
  domain: string,
  data: DomainConfigPayload,
): Promise<DomainDiagnosticsEntry> {
  return request<{ domain: DomainDiagnosticsEntry }>(
    `/settings/domains/${encodeURIComponent(domain)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  ).then((r) => r.domain);
}

// fallow-ignore-next-line unused-export — used by tests
export async function getDomainDiagnostics(): Promise<DomainDiagnosticsResponse> {
  return request<DomainDiagnosticsResponse>('/settings/domain-diagnostics');
}

export interface GenerateProfileResult {
  success: boolean;
  generationId: string | null;
  existing: boolean;
  domain: string;
  anchorUrl?: string | null;
}

export async function generateProfileForDomain(
  domain: string,
  anchorUrl?: string,
): Promise<GenerateProfileResult> {
  const body = anchorUrl ? JSON.stringify({ anchorUrl }) : undefined;
  return request<GenerateProfileResult>(
    `/settings/domain-diagnostics/${encodeURIComponent(domain)}/generate-profile`,
    { method: 'POST', body },
  );
}

export interface ExtractorTestResult {
  title?: string;
  price?: string;
  description?: string;
  brand?: string;
  images?: string[];
  customFields?: Record<string, string>;
}

export interface TestExtractorProfileRequest {
  url: string;
  titleSelector?: string | null;
  titleOptionalSelectors?: string[];
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  shopifyJSONPath?: boolean;
  variantSelectionStrategy?: any;
  customSelectors?: Record<string, string>;
}

export async function testExtractorProfile(data: TestExtractorProfileRequest): Promise<{ success: boolean; extracted: ExtractorTestResult }> {
  return request<{ success: boolean; extracted: ExtractorTestResult }>('/extractor-profiles/test', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getOllamaModels(baseUrl?: string): Promise<{ models: string[] }> {
  const params = new URLSearchParams();
  if (baseUrl) params.set('baseUrl', baseUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ models: string[] }>(`/settings/ollama/models${qs}`);
}

export interface LocalRuntimeStatusResponse {
  maxConcurrency: number;
  activeRequests: number;
  queuedRequests: number;
  connected: boolean;
  runningModels: Array<{ name: string; size?: number; digest?: string }>;
}

export async function getLocalRuntimeStatusApi(): Promise<LocalRuntimeStatusResponse> {
  return request<LocalRuntimeStatusResponse>('/settings/ollama/status');
}


// ─── Classification API ──────────────────────────────────────────────────────

export interface ClassificationConfigResponse {
  config: any;
}

export interface CurationTargetOption {
  value: string;
  label: string;
}

import type { ProductFieldCurationCandidate } from '../shared/schemas/merchandising-field-spec';
export type { ProductFieldCurationCandidate };

export interface CurationTargetCandidates {
  productTypes: CurationTargetOption[];
  productFields: ProductFieldCurationCandidate[];
  pages: CurationTargetOption[];
}

import type {
  CurationApplicabilitySummary,
  CurationHealthFinding,
} from '../classification/curation-applicability';

export interface CurationTargetsResponse {
  targets: CurationTargetConfig[];
  candidates: CurationTargetCandidates;
  applicability: CurationApplicabilitySummary[];
  findings: CurationHealthFinding[];
}

async function classificationRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/classification${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const errorObj = (data as any).error;
    const msg = (data as any).message || (typeof errorObj === 'string' ? errorObj : errorObj?.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as any).code = typeof errorObj === 'string' ? errorObj : (data as any).code || null;
    (err as any).status = res.status;
    throw err;
  }
  return data as T;
}

export async function getClassificationConfig(): Promise<ClassificationConfigResponse> {
  return classificationRequest<ClassificationConfigResponse>('/config');
}

export async function getClassificationReadiness(): Promise<{
  readiness: import('../shared/schemas/classification').ClassificationReadinessReportDto;
}> {
  return classificationRequest<{
    readiness: import('../shared/schemas/classification').ClassificationReadinessReportDto;
  }>('/readiness');
}

// fallow-ignore-next-line unused-export — used by tests
export async function saveClassificationConfig(config: any): Promise<{ success: boolean; config: any }> {
  return classificationRequest<{ success: boolean; config: any }>('/config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
}

export async function getCurationTargets(): Promise<CurationTargetsResponse> {
  return classificationRequest<CurationTargetsResponse>('/curation-targets');
}

export async function saveCurationTargets(
  targets: CurationTargetConfig[],
): Promise<CurationTargetsResponse & { success: boolean }> {
  return classificationRequest<CurationTargetsResponse & { success: boolean }>('/curation-targets', {
    method: 'PUT',
    body: JSON.stringify({ targets }),
  });
}

export async function syncClassificationSeed(): Promise<CurationTargetsResponse & { success: boolean }> {
  return classificationRequest<CurationTargetsResponse & { success: boolean }>('/sync-seed', {
    method: 'POST',
  });
}

export interface AttributeProfileEditInput {
  attributeId: string;
  included: boolean;
  required?: boolean;
  cardinality?: 'single' | 'multiple';
}

export async function updateAttributeProfile(
  productTypeId: string,
  edits: AttributeProfileEditInput[],
): Promise<{ success: boolean; bundleHash: string; commitHash: string | null; productTypeId: string; profileId: string; updatedAttributeIds: string[] }> {
  return classificationRequest<{ success: boolean; bundleHash: string; commitHash: string | null; productTypeId: string; profileId: string; updatedAttributeIds: string[] }>(`/attribute-profiles/${productTypeId}`, {
    method: 'PUT',
    body: JSON.stringify({ edits }),
  });
}

export async function updateClassificationAttribute(
  attributeId: string,
  updates: { isUniversal?: boolean; name?: string; description?: string | null },
): Promise<{ success: boolean; attribute: any }> {
  return classificationRequest<{ success: boolean; attribute: any }>(`/attributes/${attributeId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export type DecisionInput = ProposalDecisionInput;

export async function submitDecisions(
  itemId: string,
  decisions: DecisionInput[],
): Promise<{ success: boolean; count: number; decisions: ClassificationProposalDecision[] }> {
  return request<{ success: boolean; count: number; decisions: ClassificationProposalDecision[] }>(`/items/${itemId}/decisions`, {
    method: 'POST',
    body: JSON.stringify({ decisions }),
  });
}

// ─── Profile Governance API (Phase 3) ─────────────────────────────────────

// LLM task configs ──────────────────────────────────────────────────────────

export interface LlmTaskConfigListResponse {
  taskConfigs: LlmTaskConfig[];
  knownTasks: LlmTask[];
}

export async function getLlmTaskConfigs(): Promise<LlmTaskConfigListResponse> {
  return request<LlmTaskConfigListResponse>('/settings/llm-task-configs');
}

export async function upsertLlmTaskConfig(
  task: LlmTask,
  data: {
    provider: LlmProvider;
    model: string;
    fallbackProvider?: LlmProvider | null;
    fallbackModel?: string | null;
    baseUrlOverride?: string | null;
    temperature?: number | null;
    reasoningEffort?: string | null;
  },
): Promise<{ success: boolean; taskConfig: LlmTaskConfig }> {
  return request<{ success: boolean; taskConfig: LlmTaskConfig }>(
    `/settings/llm-task-configs/${task}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  );
}

export async function deleteLlmTaskConfig(task: LlmTask): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/llm-task-configs/${task}`, {
    method: 'DELETE',
  });
}

// ─── AI Compute & Provider Connections API ────────────────────────────────────

export async function getAiConfig(): Promise<{
  config: import('../ai/provider-connections').AiRoutingConfig;
  health: Record<string, import('../ai/connection-health-monitor').ConnectionHealthReport>;
}> {
  return request('/settings/ai/config');
}

export async function upsertAiConnection(
  connection: import('../ai/provider-connections').ProviderConnection,
): Promise<{
  success: boolean;
  connection: import('../ai/provider-connections').ProviderConnection;
  health: import('../ai/connection-health-monitor').ConnectionHealthReport;
}> {
  return request(`/settings/ai/connections/${connection.id}`, {
    method: 'PUT',
    body: JSON.stringify(connection),
  });
}

export async function deleteAiConnection(id: string): Promise<{ success: boolean }> {
  return request(`/settings/ai/connections/${id}`, {
    method: 'DELETE',
  });
}

export async function probeAiConnection(id: string): Promise<{
  success: boolean;
  health: import('../ai/connection-health-monitor').ConnectionHealthReport;
}> {
  return request(`/settings/ai/connections/${id}/probe`, {
    method: 'POST',
  });
}

export async function testEphemeralAiConnection(
  connection: import('../ai/provider-connections').ProviderConnection,
): Promise<{
  health: import('../ai/connection-health-monitor').ConnectionHealthReport;
}> {
  return request('/settings/ai/connections/test-ephemeral', {
    method: 'POST',
    body: JSON.stringify(connection),
  });
}

export async function saveAiDefaults(
  defaults: import('../ai/provider-connections').AiRoutingConfig['defaults'],
): Promise<{ success: boolean }> {
  return request('/settings/ai/defaults', {
    method: 'PUT',
    body: JSON.stringify(defaults),
  });
}

export async function upsertAiWorkloadRoute(
  workload: string,
  route: import('../ai/provider-connections').WorkloadRoute,
): Promise<{ success: boolean; route: import('../ai/provider-connections').WorkloadRoute }> {
  return request(`/settings/ai/workload-routes/${workload}`, {
    method: 'PUT',
    body: JSON.stringify(route),
  });
}


// Domain profile governance ───────────────────────────────────────────────

export async function getDomainProfileGovernance(
  domain: string,
): Promise<DomainProfileGovernance> {
  return request<DomainProfileGovernance>(
    `/settings/profile-governance/${encodeURIComponent(domain)}`,
  );
}

/** Fetch the latest open (non-rejected, non-failed) proposal for a domain. */
// fallow-ignore-next-line unused-export — used by tests
export async function getLatestProposalForDomain(
  domain: string,
): Promise<ProfileGenerationGeneration | null> {
  try {
    const res = await getProfileGenerations(domain);
    const open = res.generations.filter(
      (g) => g.status !== 'rejected' && g.status !== 'failed',
    );
    if (open.length === 0) return null;
    return open.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
  } catch {
    return null;
  }
}

export async function deleteProfileGeneration(generationId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/settings/profile-generations/${generationId}`,
    { method: 'DELETE' },
  );
}

export async function getProfileGenerations(
  domain?: string,
  status?: ProfileGenerationGeneration['status'],
): Promise<{ generations: ProfileGenerationGeneration[] }> {
  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  if (status) params.set('status', status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ generations: ProfileGenerationGeneration[] }>(
    `/settings/profile-generations${qs}`,
  );
}

export interface ProfileGenerationDetailResponse {
  generation: ProfileGenerationGeneration;
  revisions: ProfileGenerationRevision[];
  fieldDecisions: ProfileGenerationFieldDecision[];
  validationResults: ProfileGenerationValidationResult[];
}

export async function getProfileGenerationDetail(
  generationId: string,
): Promise<ProfileGenerationDetailResponse> {
  return request<ProfileGenerationDetailResponse>(
    `/settings/profile-generations/${generationId}`,
  );
}

export async function createRevisionFromFeedback(
  generationId: string,
  data: {
    parentRevisionId?: string | null;
    feedback: StructuredFeedback;
    notes?: string | null;
  },
): Promise<{ success: boolean; revision: ProfileGenerationRevision }> {
  return request<{ success: boolean; revision: ProfileGenerationRevision }>(
    `/settings/profile-generations/${generationId}/revisions`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

export interface ValidationRunSummary {
  revisionId: string;
  sampleCount: number;
  passingSamples: number;
  failingSamples: number;
  warningSamples: number;
  byField: Record<
    string,
    { passing: number; failing: number; warning: number }
  >;
  samples: Array<{
    field: string;
    sampleUrl: string;
    itemId: string | null;
    expectedName: string | null;
    brandHint: string | null;
    extractedText: string | null;
    extractedImages: string[];
    warnings: string[];
    status: 'pass' | 'warning' | 'fail';
  }>;
  readyForImageApproval: boolean;
  textFieldsHaveStrongEvidence: boolean;
  textFieldsHaveLimitedEvidence: boolean;
}

export async function validateRevision(
  generationId: string,
  revisionId: string,
  data: { sampleLimit?: number; notes?: string | null } = {},
): Promise<{ success: boolean; result: ValidationRunSummary }> {
  return request<{ success: boolean; result: ValidationRunSummary }>(
    `/settings/profile-generations/${generationId}/revisions/${revisionId}/validate`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

export interface ApproveRevisionFieldsResponse {
  success: boolean;
  imageApprovalAccepted: boolean;
  promotionResult: {
    promoted: boolean;
    reason: string;
    domain: string;
    generationId: string;
    approvedFields: string[];
    rejectedFields: string[];
    approvalDecisionIds: string[];
    rejectionDecisionIds: string[];
  };
}

export async function approveRevisionFields(
  generationId: string,
  revisionId: string,
  data: {
    approvedFields: Record<string, boolean>;
    notes?: string | null;
    decidedBy?: string | null;
    imagePreviewsReviewed?: boolean;
  },
): Promise<ApproveRevisionFieldsResponse> {
  return request<ApproveRevisionFieldsResponse>(
    `/settings/profile-generations/${generationId}/revisions/${revisionId}/decisions`,
    {
      method: 'POST',
      body: JSON.stringify({ mode: 'approve', ...data }),
    },
  );
}

export interface RejectRevisionFieldsResponse {
  success: boolean;
  rejectedFields: string[];
  decisionIds: string[];
}

// fallow-ignore-next-line unused-export — used by tests
export async function rejectRevisionFields(
  generationId: string,
  revisionId: string,
  data: {
    rejectedFields: string[];
    reason?: string | null;
    notes?: string | null;
    decidedBy?: string | null;
  },
): Promise<RejectRevisionFieldsResponse> {
  return request<RejectRevisionFieldsResponse>(
    `/settings/profile-generations/${generationId}/revisions/${revisionId}/decisions`,
    {
      method: 'POST',
      body: JSON.stringify({ mode: 'reject', ...data }),
    },
  );
}

export interface RollbackFieldResponse {
  success: boolean;
  rolledBack: boolean;
  reason: string;
  domain: string;
  selectorField: string;
  decisionId: string;
  restoredSelector: string | null;
}

export async function rollbackProfileField(
  decisionId: string,
  data: { notes?: string | null; decidedBy?: string | null } = {},
): Promise<RollbackFieldResponse> {
  return request<RollbackFieldResponse>(
    `/settings/profile-field-decisions/${decisionId}/rollback`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

// ─── Extraction Worker Client (Profile Tooling) ──────────────────────────────

export async function getExtractionWorkerHealth(): Promise<WorkerHealthResponse | null> {
  return request<WorkerHealthResponse>('/settings/extraction-worker/health').catch(() => null);
}

export async function snapshotPageForBuilder(
  req: SnapshotRequest,
): Promise<{ ok: boolean; data?: SnapshotResponse; error?: string }> {
  return request('/settings/profile-tooling/snapshot', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function generateSelectorFromElement(
  req: GenerateSelectorRequest,
): Promise<{ ok: boolean; data?: GenerateSelectorResponse; error?: string }> {
  return request('/settings/profile-tooling/generate-selector', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function fetchPageHtml(
  url: string,
): Promise<{ ok: boolean; html?: string; error?: string }> {
  return request('/settings/profile-tooling/fetch-html', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}


export async function validateProfileDraft(
  req: ValidateRequest,
): Promise<{ ok: boolean; data?: ValidateResponse; error?: string }> {
  return request('/settings/profile-tooling/validate', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function getProfileRetryPreview(
  domain: string,
): Promise<{ items: ProfileBlockedItem[] }> {
  return request(`/settings/profile-retry-preview/${encodeURIComponent(domain)}`);
}

export async function generateSelectors(
  req: GenerateSelectorsRequest & { signal?: AbortSignal },
): Promise<{ ok: true; data: GenerateSelectorsResponse } | { ok: false; error: { code: string; message: string; retryable: boolean } }> {
  try {
    const data = await request<GenerateSelectorsResponse>('/settings/profile-tooling/generate-selectors', {
      method: 'POST',
      body: JSON.stringify({
        htmlRef: req.htmlRef,
        sourceUrl: req.sourceUrl,
        runtime: req.runtime,
        fields: req.fields,
        snapshotContext: req.snapshotContext,
      }),
      signal: (req as any).signal,
    });
    return { ok: true, data };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      },
    };
  }
}

export async function retryProfileBlockedItems(
  domain: string,
  itemIds: string[],
): Promise<{ accepted: number }> {
  return request(`/settings/profile-retry-preview/${encodeURIComponent(domain)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export interface WeeklyReportProductItem {
  id: string;
  upc: string;
  name: string;
  brandHint: string | null;
  batchName: string;
  status: string;
  stage: string;
  stageStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReportResponse {
  startDate: string;
  endDate: string;
  items: WeeklyReportProductItem[];
  totalCount: number;
  promotedCount: number;
  /** Issue #17 F: versioned classification quality summary (null when no workspace). */
  qualitySummary?: import('./classification-metrics-view').QualityDisplay | null;
}

export interface QualityReportResponse {
  report: import('../shared/schemas/classification-metrics').QualityReport;
}

export async function getWeeklyReport(startDate?: string, endDate?: string): Promise<WeeklyReportResponse> {
  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  const q = params.toString();
  return request(`/weekly-report${q ? `?${q}` : ''}`);
}


// ─── Multi-Distributor Sourcing (ADR 0014) ────────────────────────────────────
// Typed client calls for the distributor connection Settings surface and the item evidence-conflict review surface. Raw secrets never
// travel over the wire: the server reports only a `secretConfigured` boolean.

export interface DistributorConnectionView {
  id: string;
  distributorId: string;
  distributorName: string;
  connectorType: 'api' | 'ftp_catalog' | 'csv' | 'html_scraper' | 'legacy_adapter';
  enabled: boolean;
  secretConfigured: boolean;
  /** Amendment B (M2): false for public storefront scrapers — no secret needed. */
  secretRequired: boolean;
  configuration: Record<string, unknown>;
  authorityPolicy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type OnboardingConflictView = import('../shared/schemas/distributor').OnboardingEvidenceConflict;

export async function getDistributorConnections(): Promise<{ connections: DistributorConnectionView[] }> {
  return request<{ connections: DistributorConnectionView[] }>('/settings/connections');
}

export async function createDistributorConnection(body: {
  distributorId: string;
  connectorType: DistributorConnectionView['connectorType'];
  secretRef?: string | null;
  configuration?: Record<string, unknown>;
  authorityPolicy?: Record<string, unknown>;
}): Promise<{ connection: DistributorConnectionView }> {
  // Amendment A: connections are ALWAYS created disabled (the server rejects
  // create-as-enabled). Enablement is a separate explicit PATCH after
  // fixture/credential/health checks — see updateDistributorConnection.
  return request<{ connection: DistributorConnectionView }>('/settings/connections', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateDistributorConnection(
  id: string,
  body: Partial<{
    connectorType: DistributorConnectionView['connectorType'];
    secretRef: string | null;
    configuration: Record<string, unknown>;
    authorityPolicy: Record<string, unknown>;
    enabled: boolean;
  }>,
): Promise<{ connection: DistributorConnectionView }> {
  return request<{ connection: DistributorConnectionView }>(`/settings/connections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function getDistributors(): Promise<{ distributors: Array<{ id: string; name: string; status: string }> }> {
  return request<{ distributors: Array<{ id: string; name: string; status: string }> }>('/settings/distributors');
}

export async function getItemConflicts(itemId: string): Promise<{ conflicts: OnboardingConflictView[] }> {
  return request<{ conflicts: OnboardingConflictView[] }>(`/items/${itemId}/conflicts`);
}

export async function resolveItemConflict(
  itemId: string,
  conflictId: string,
  body:
    | { action: 'resolve_candidate'; candidateId: string }
    | { action: 'custom_value'; customValue: string }
    | { action: 'dismiss' },
): Promise<{ success: boolean; item?: unknown; conflicts?: OnboardingConflictView[] }> {
  return request<{ success: boolean; item?: unknown; conflicts?: OnboardingConflictView[] }>(
    `/items/${itemId}/conflicts/${conflictId}/resolve`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

// ─── Sitemap Health & Brand URL Index APIs (Epic #61) ─────────────────────────

export async function getSitemapsOverview(params?: {
  status?: string;
  attention?: boolean;
  search?: string;
}): Promise<SitemapsOverviewResponse> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.attention) query.set('attention', 'true');
  if (params?.search) query.set('search', params.search);
  const qStr = query.toString();
  return request<SitemapsOverviewResponse>(`/sitemaps${qStr ? `?${qStr}` : ''}`);
}

export async function getSitemapDomainDetail(domain: string): Promise<SitemapDomainDetailResponse> {
  return request<SitemapDomainDetailResponse>(`/sitemaps/${encodeURIComponent(domain)}`);
}

export async function getSitemapDomainUrls(
  domain: string,
  params?: {
    search?: string;
    page_type?: string;
    active?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<BrandUrlsListResponse> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.page_type) query.set('page_type', params.page_type);
  if (params?.active !== undefined) query.set('active', params.active ? 'true' : 'false');
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  const qStr = query.toString();
  return request<BrandUrlsListResponse>(`/sitemaps/${encodeURIComponent(domain)}/urls${qStr ? `?${qStr}` : ''}`);
}

export async function refreshSitemapDomain(domain: string): Promise<{
  ok: boolean;
  domain: string;
  fetchResult: { urlsCount: number; sourceUrl: string | null; reconcileResult: unknown };
  summary: SitemapDomainDetailResponse['summary'];
}> {
  return request(`/sitemaps/${encodeURIComponent(domain)}/refresh`, {
    method: 'POST',
  });
}

export async function testSitemapLookup(
  domain: string,
  target: SitemapTestLookupRequest,
): Promise<SitemapTestLookupResponse> {
  return request<SitemapTestLookupResponse>(`/sitemaps/${encodeURIComponent(domain)}/test-lookup`, {
    method: 'POST',
    body: JSON.stringify(target),
  });
}

export async function deleteSitemapUrl(
  domain: string,
  id: string,
): Promise<{ ok: boolean; id: string; domain: string }> {
  return request<{ ok: boolean; id: string; domain: string }>(
    `/sitemaps/${encodeURIComponent(domain)}/urls/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function deleteSitemapUrls(
  domain: string,
  ids: string[],
): Promise<{ ok: boolean; deletedCount: number; domain: string }> {
  return request<{ ok: boolean; deletedCount: number; domain: string }>(
    `/sitemaps/${encodeURIComponent(domain)}/urls`,
    {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    },
  );
}

export async function addSitemapDomain(data: {
  domain: string;
  brandName?: string;
  productUrlPattern?: string;
  fetchNow?: boolean;
}): Promise<{ ok: boolean; domain: string; summary: DomainSitemapSummary; fetchResult?: any }> {
  return request<{ ok: boolean; domain: string; summary: DomainSitemapSummary; fetchResult?: any }>(
    '/sitemaps',
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

export async function deleteSitemapDomain(
  domain: string,
): Promise<{ ok: boolean; domain: string; deletedUrlsCount: number }> {
  return request<{ ok: boolean; domain: string; deletedUrlsCount: number }>(
    `/sitemaps/${encodeURIComponent(domain)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function getBrandStrategies(): Promise<{ strategies: import('../shared/schemas/brand-strategy').BrandStrategy[] }> {
  return request(`/brands/strategy`);
}

/**
 * Builder slice B1: single-brand strategy detail (synthesized revision-0
 * projection for unknown brands; the read writes nothing).
 */
export async function getBrandStrategyDetail(
  brand: string,
): Promise<{ strategy: import('../shared/schemas/brand-strategy').BrandStrategy | null; strategies: import('../shared/schemas/brand-strategy').BrandStrategy[] }> {
  return request(`/brands/strategy?brand=${encodeURIComponent(brand)}`);
}

/**
 * Builder slice B1: sole typed client writer for brand strategy Saves.
 * Every accepted Save creates one approved revision; callers pass the
 * current `expectedRevision` (0 for first Save) and, when sending
 * `configuration`, the current `expectedConfigurationToken`. Throws
 * OnboardingApiError with structured `code` (`invalid_strategy`,
 * `stale_revision`, `stale_configuration`).
 */
export async function saveBrandStrategy(
  input: import('../shared/schemas/brand-strategy').ApproveBrandStrategy,
): Promise<{ strategy: import('../shared/schemas/brand-strategy').ApprovedBrandStrategy }> {
  return request(`/brands/strategy/approve`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}



// ─── Taxonomy release status + sanctioned activation (P4) ─────────────────────

export interface TaxonomyReleaseRevisionInfo {
  revision: string;
  schemaVersion: number | null;
  lifecycle: string | null;
  counts: Record<string, number>;
  manifestHashesOk: boolean;
  errorCount: number;
  warningCount: number;
}

export interface TaxonomyReleaseStatus {
  activeRevision: string | null;
  updatedAt: string | null;
  defaultRevision: string;
  v4Revision: string;
  /** Server-side admin gate state — the client NEVER guesses (defense in depth). */
  adminEnabled: boolean;
  availableRevisions: TaxonomyReleaseRevisionInfo[];
}

export async function getTaxonomyReleaseStatus(): Promise<TaxonomyReleaseStatus> {
  return request<TaxonomyReleaseStatus>('/settings/taxonomy-release');
}

export async function pinTaxonomyRelease(
  revision: string,
): Promise<{ success: boolean; activeRevision: string; updatedAt: string }> {
  return request('/settings/taxonomy-release/pin', {
    method: 'POST',
    body: JSON.stringify({ revision }),
  });
}
