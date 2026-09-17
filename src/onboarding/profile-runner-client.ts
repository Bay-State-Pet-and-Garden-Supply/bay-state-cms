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
  /** Expected product info from the spreadsheet. */
  expected: {
    name: string;
    brandHint?: string | null;
    price?: string | null;
    /** UPC/GTIN when known — forwarded for ADR-0031 ladder identity
     * classification on the worker side (ExtractRequest already accepts it). */
    upc?: string | null;
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
export async function runProfileExtraction(
  options: ProfileRunnerOptions,
): Promise<ProfileRunnerResult> {
  const { sourceUrl, profile, expected } = options;

  // The profile's approved domain is always an allowed source; Pi runs may
  // add the run policy's allowedSourceDomains on top. Deduplicated and
  // transmitted to the worker so every fetch/redirect/sub-resource is checked
  // against the SSRF floor AND this explicit allowlist.
  const allowedSourceDomains = Array.from(new Set([
    profile.domain,
    ...(options.allowedSourceDomains ?? []),
  ])).filter((domain): domain is string => typeof domain === 'string' && domain.trim().length > 0);

  const request: any = {
    profileId: profile.id,
    profileVersion: profile.version ?? (profile.updatedAt
      ? Math.floor(new Date(profile.updatedAt).getTime() / 1000)
      : 0),
    sourceUrl,
    expected: {
      name: expected.name,
      brandHint: expected.brandHint ?? null,
      price: expected.price ?? null,
      spreadsheetHints: {},
      upc: expected.upc || undefined,
    },
    profile: {
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
    },
  };
  if (options.variantSelection) {
    (request as any).variantSelection = options.variantSelection;
  }

  const result = await trustedExtract(request);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      warnings: [],
      failureCode: null,
    };
  }

  const response = result.data as any;

  if (!response.ok || !response.extractionData) {
    return {
      ok: false,
      error: 'Extraction worker returned ok:false',
      warnings: response.warnings ?? [],
      failureCode: response.failureCode ?? null,
      matrixDecision: response.matrixDecision ?? null,
      selectedReceipt: response.selectedReceipt ?? null,
      variantMatrix: (response as any).variantMatrix ?? (response as any).matrix ?? null,
      identityMatrixHash: (response as any).identityMatrixHash ?? (response.matrixDecision as any)?.identityMatrixHash ?? null,
      candidates: (response as any).candidates ?? (response.matrixDecision as any)?.candidates ?? (response as any).variantMatrix?.candidates ?? null,
    };
  }

  const ext = response.extractionData;
  const rawImages = [ext.primaryImage, ...ext.additionalImages].filter(Boolean) as string[];
  const cleanImages = cleanAndDeduplicateImages(rawImages, sourceUrl);
  ext.primaryImage = cleanImages[0] || null;
  ext.additionalImages = cleanImages.slice(1);
  (ext as any).images = cleanImages;

  return {
    ok: true,
    data: ext,
    warnings: response.warnings ?? [],
    fieldProvenance: response.fieldProvenance ?? ext.fieldProvenance ?? {},
    fieldProvenanceDetails: response.fieldProvenanceDetails ?? {},
    sourceContentHash: response.sourceContentHash ?? null,
    sourceArtifactId: response.sourceArtifactId ?? null,
    selectedReceipt: response.selectedReceipt ?? null,
    matrixDecision: response.matrixDecision ?? null,
    variantMatrix: (response as any).variantMatrix ?? (response as any).matrix ?? null,
    identityMatrixHash: (response as any).identityMatrixHash ?? (response.matrixDecision as any)?.identityMatrixHash ?? null,
    candidates: (response as any).candidates ?? (response.matrixDecision as any)?.candidates ?? (response as any).variantMatrix?.candidates ?? null,
  };
}
