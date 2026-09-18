/**
 * Profile Runner Client
 *
 * Builds ExtractRequest payloads from an ExtractorProfile + source URL
 * and dispatches them to the extraction worker's POST /profile-runner/extract.
 *
 * Lives in the Bun API server. The extraction worker must be running
 * separately (`bun run worker:dev`) for this to work.
 */

import { trustedExtract } from '../server/extraction-worker-client';
import type { ExtractorProfile } from '../db/repositories/extractor-profile-repo';
import type { ExtractionData } from '../shared/schemas/onboarding';
import type { VariantSelectionStrategy } from '../shared/schemas/extraction-worker';
import { cleanAndDeduplicateImages } from './image-utils';

export interface ProfileRunnerOptions {
  /** The product page URL to extract from. */
  sourceUrl: string;
  /** The extractor profile (CSS selectors) for this domain. */
  profile: ExtractorProfile;
  /** Optional extra source domains for the worker-side allowlist (e.g. the
   * Pi run policy's allowedSourceDomains). The profile's own approved domain
   * is always included. */
  allowedSourceDomains?: string[];
  /** Optional trusted source SKU for variant-identity matching. */
  /** Expected product info from the spreadsheet. */
  expected: {
    name: string;
    brandHint?: string | null;
    price?: string | null;
    /** UPC/GTIN when known — forwarded for ADR-0031 ladder identity
     * classification on the worker side (ExtractRequest already accepts it). */
    upc?: string | null;
    /** Trusted source SKU for variant-identity matching (T4, optional). */
    sku?: string | null;
    /** Exact known platform variant ID for identity matching (T4, optional). */
    platformVariantId?: string | null;
  };
  /** Optional variant selection receipt for stale-safe extraction (M4). */
  variantSelection?: {
    resolutionId: string;
    identityMatrixHash: string;
    variantKey: string;
  };
}

export type ProfileRunnerResult =
  | { ok: true; data: ExtractionData; warnings: string[]; fieldProvenance: Record<string, string>; fieldProvenanceDetails?: Record<string, { method: string; sourcePath: string }>; sourceContentHash?: string | null; sourceArtifactId?: string | null; selectedReceipt?: unknown; matrixDecision?: unknown; variantMatrix?: unknown; identityMatrixHash?: string | null; candidates?: unknown[] }
  | { ok: false; error: string; warnings: string[]; failureCode?: string | null; matrixDecision?: unknown; selectedReceipt?: unknown; variantMatrix?: unknown; identityMatrixHash?: string | null; candidates?: unknown[] };

/**
 * Run a trusted profile extraction against the extraction worker.
 *
 * Builds an ExtractRequest from the profile and dispatches it to the
 * worker's POST /profile-runner/extract endpoint. The worker runs the
 * profile's CSS selectors deterministically (never falls back to
 * generic extraction, never calls an LLM).
 *
 * Returns ok:false when the worker is unreachable or returns a
 * response without trusted title evidence, preserving fail-closed
 * semantics per ADR 0009.
 */
export const runProfileForUrl = runProfileExtraction;

/** Deduplicated worker-side source allowlist for one profile execution. */
function allowedSourceDomainsFor(profile: ExtractorProfile, extra?: string[]): string[] {
  // The profile's approved domain is always an allowed source; Pi runs may
  // add the run policy's allowedSourceDomains on top. Deduplicated and
  // transmitted to the worker so every fetch/redirect/sub-resource is checked
  // against the SSRF floor AND this explicit allowlist.
  return Array.from(new Set([
    profile.domain,
    ...(extra ?? []),
  ])).filter((domain): domain is string => typeof domain === 'string' && domain.trim().length > 0);
}

function profileVersionOf(profile: ExtractorProfile): number {
  return profile.version ?? (profile.updatedAt
    ? Math.floor(new Date(profile.updatedAt).getTime() / 1000)
    : 0);
}

function expectedOf(expected: ProfileRunnerOptions['expected']): Record<string, unknown> {
  return {
    name: expected.name,
    brandHint: expected.brandHint ?? null,
    price: expected.price ?? null,
    spreadsheetHints: {},
    upc: expected.upc || undefined,
    // T4: trusted identity inputs ride the existing expected carrier —
    // the UPC stays in the GTIN slot and is never conflated with the SKU.
    ...(expected.sku ? { sku: expected.sku } : {}),
    ...(expected.platformVariantId ? { platformVariantId: expected.platformVariantId } : {}),
  };
}

function workerProfileOf(profile: ExtractorProfile, allowedSourceDomains: string[]): Record<string, unknown> {
  return {
    runtime: profile.runtime ?? 'rendered',
    selectors: {
      titleSelector: profile.titleSelector,
      priceSelector: profile.priceSelector,
      descriptionSelector: profile.descriptionSelector,
      brandSelector: profile.brandSelector,
      imagesSelector: profile.imagesSelector,
    },
    titleOptionalSelectors: profile.titleOptionalSelectors ?? [],
    customSelectors: profile.customSelectors ?? {},
    imageRules: {},
    variantSelectionStrategy: profile.variantSelectionStrategy as VariantSelectionStrategy | null ?? null,
    allowedSourceDomains,
    // T4: forward the compiled extraction-policy content so the worker
    // can execute Shopify endpoint-backed policy. Legacy profiles carry
    // null and keep current selector semantics exactly.
    extractionPolicy: (profile as { extractionPolicy?: unknown }).extractionPolicy ?? null,
  };
}

/** Build the worker ExtractRequest payload (pure: no network). */
function buildPolicyExtractRequest(options: ProfileRunnerOptions): any {
  const { sourceUrl, profile } = options;
  const request: Record<string, unknown> = {
    profileId: profile.id,
    profileVersion: profileVersionOf(profile),
    sourceUrl,
    expected: expectedOf(options.expected),
    profile: workerProfileOf(profile, allowedSourceDomainsFor(profile, options.allowedSourceDomains)),
  };
  if (options.variantSelection) request.variantSelection = options.variantSelection;
  return request;
}

function workerFailureResult(result: { error: string }): ProfileRunnerResult {
  return { ok: false, error: result.error, warnings: [], failureCode: null };
}

function variantMatrixOf(response: Record<string, unknown>): unknown {
  return response.variantMatrix ?? response.matrix ?? null;
}

function identityMatrixHashOf(response: Record<string, unknown>): string | null {
  const decision = response.matrixDecision as { identityMatrixHash?: unknown } | null;
  return (response.identityMatrixHash ?? decision?.identityMatrixHash ?? null) as string | null;
}

function candidatesOf(response: Record<string, unknown>): unknown[] | null {
  const decision = response.matrixDecision as { candidates?: unknown } | null;
  const matrix = response.variantMatrix as { candidates?: unknown } | null;
  return ((response.candidates ?? decision?.candidates ?? matrix?.candidates ?? null) as unknown[] | null);
}

function failedExtractionResult(response: Record<string, unknown>): ProfileRunnerResult {
  return {
    ok: false,
    error: 'Extraction worker returned ok:false',
    warnings: (response.warnings as string[] | undefined) ?? [],
    failureCode: (response.failureCode as string | null | undefined) ?? null,
    matrixDecision: response.matrixDecision,
    selectedReceipt: response.selectedReceipt,
    variantMatrix: variantMatrixOf(response),
    identityMatrixHash: identityMatrixHashOf(response),
    candidates: candidatesOf(response) as unknown[] | undefined,
  };
}

export async function runProfileExtraction(
  options: ProfileRunnerOptions,
): Promise<ProfileRunnerResult> {
  const { sourceUrl } = options;
  const result = await trustedExtract(buildPolicyExtractRequest(options));
  if (!result.ok) return workerFailureResult(result);
  const response = result.data as unknown as Record<string, unknown>;
  const extractionData = response.extractionData as Record<string, unknown> | undefined;
  if (!response.ok || !extractionData) return failedExtractionResult(response);
  return successfulExtractionResult(response, extractionData, sourceUrl);
}

function successfulExtractionResult(
  response: Record<string, unknown>,
  extractionData: Record<string, unknown>,
  sourceUrl: string,
): ProfileRunnerResult {
  const ext = extractionData as unknown as ExtractionData;
  const rawImages = [ext.primaryImage, ...(ext.additionalImages ?? [])].filter(Boolean) as string[];
  const cleanImages = cleanAndDeduplicateImages(rawImages, sourceUrl);
  ext.primaryImage = cleanImages[0] || null;
  ext.additionalImages = cleanImages.slice(1);
  (ext as unknown as Record<string, unknown>).images = cleanImages;
  return {
    ok: true,
    data: ext,
    warnings: (response.warnings as string[] | undefined) ?? [],
    fieldProvenance: (response.fieldProvenance as Record<string, string> | undefined) ?? ext.fieldProvenance ?? {},
    fieldProvenanceDetails: (response.fieldProvenanceDetails as Record<string, { method: string; sourcePath: string }> | undefined) ?? {},
    sourceContentHash: (response.sourceContentHash as string | null | undefined) ?? null,
    sourceArtifactId: (response.sourceArtifactId as string | null | undefined) ?? null,
    selectedReceipt: response.selectedReceipt,
    matrixDecision: response.matrixDecision,
    variantMatrix: variantMatrixOf(response),
    identityMatrixHash: identityMatrixHashOf(response),
    candidates: candidatesOf(response) as unknown[] | undefined,
  };
}
