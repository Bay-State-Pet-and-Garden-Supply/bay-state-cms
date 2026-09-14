/**
 * Profile Audit Replay Runner
 *
 * Replays byte-identical retained page artifacts through all four configurations:
 * 1. Current extraction (baseline)
 * 2. Current plus strict post-merge image filtering
 * 3. Structured signals only (measurement arm)
 * 4. Proposed hybrid (identity-first field selection plus strict filtering)
 *
 * CRITICAL CONTRACTS:
 * - ZERO network refetch: in-memory mock fetch serves the retained artifact bytes.
 * - Missing artifacts recorded as evidence gaps, never as parser failures.
 * - Deterministic: identical artifact in, identical outcomes out.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type {
  AuditManifestSample,
  ReplayConfiguration,
} from '../../shared/schemas/profile-audit';
import type { ExtractionOutcome, ReplayRunnerOptions } from './types';
import { extractViaHttpDetailed } from '../page-extractor';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';
import { applyStrictImageFilter } from './strict-image-filter';
import { selectHybridFields } from './hybrid-field-selector';
import { createResolver } from '../../server/services/profile-builder/snapshotArtifactResolver';

const DEFAULT_ARTIFACT_ROOT = resolve(
  process.cwd(),
  '.baystate-cms',
  'artifacts',
  'profile-builder',
);

function buildEmptyOutcome(
  configuration: ReplayConfiguration,
  isEvidenceGap: boolean,
  reason: string,
): ExtractionOutcome {
  return {
    configuration,
    data: ExtractionDataSchema.parse({
      title: null,
      brand: null,
      description: null,
      price: null,
      primaryImage: null,
      additionalImages: [],
      bulletPoints: [],
      confidence: 0,
    }),
    admittedImages: [],
    rejectedImages: [],
    primaryImage: null,
    isEvidenceGap,
    evidenceGapReason: reason,
  };
}

export async function replaySample(
  sample: AuditManifestSample,
  profile: ExtractorProfile | null,
  options: ReplayRunnerOptions = {},
): Promise<Record<ReplayConfiguration, ExtractionOutcome>> {
  // Case 1: Missing primary artifact
  if (!sample.artifactRef) {
    const reason = 'Snapshot artifact not found in inventory';
    return {
      current_extraction: buildEmptyOutcome('current_extraction', true, reason),
      current_strict_images: buildEmptyOutcome('current_strict_images', true, reason),
      structured_only: buildEmptyOutcome('structured_only', true, reason),
      hybrid_identity_first: buildEmptyOutcome('hybrid_identity_first', true, reason),
    };
  }

  // Case 2: Resolve and read HTML from disk
  const artifactRoot = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  let html: string;
  try {
    const resolver = createResolver({ artifactRoot });
    const resolved = resolver.resolve(sample.artifactRef);
    html = resolved.html;
  } catch (err: unknown) {
    // Fallback direct read in case artifactRef is relative to artifactRoot
    const directPath = join(artifactRoot, sample.artifactRef);
    if (existsSync(directPath)) {
      html = readFileSync(directPath, 'utf8');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        current_extraction: buildEmptyOutcome('current_extraction', true, `Artifact read failed: ${msg}`),
        current_strict_images: buildEmptyOutcome('current_strict_images', true, `Artifact read failed: ${msg}`),
        structured_only: buildEmptyOutcome('structured_only', true, `Artifact read failed: ${msg}`),
        hybrid_identity_first: buildEmptyOutcome('hybrid_identity_first', true, `Artifact read failed: ${msg}`),
      };
    }
  }

  // Prepare zero-network mock fetch transport
  const mockFetch = async () => {
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const expected = options.expected ?? {
    name: sample.groundTruth.identity.productName,
    brandHint: sample.groundTruth.identity.brand,
    gtin: sample.groundTruth.identity.gtin ?? undefined,
  };

  // ── Configuration 1: Current Extraction (Baseline) ──────────────────────────
  const baselineResult = await extractViaHttpDetailed(sample.url, profile, expected, mockFetch);
  const baselineRawImages = [
    ...(baselineResult.raw.custom?.images as string[] || []),
    ...(baselineResult.raw.images || []),
  ];
  const baselineAdmittedImages = [
    baselineResult.data.primaryImage,
    ...(baselineResult.data.additionalImages || []),
  ].filter(Boolean) as string[];

  const currentExtractionOutcome: ExtractionOutcome = {
    configuration: 'current_extraction',
    data: baselineResult.data,
    raw: baselineResult.raw,
    admittedImages: baselineAdmittedImages,
    rejectedImages: [],
    primaryImage: baselineResult.data.primaryImage,
    isEvidenceGap: false,
  };

  // ── Configuration 2: Current + Strict Image Filtering ─────────────────────
  const strictFilterResult = applyStrictImageFilter({
    images: baselineRawImages.length > 0 ? baselineRawImages : baselineAdmittedImages,
    baseUrl: sample.url,
  });

  const strictAdditionalImages = strictFilterResult.admittedImages.filter(
    u => u !== strictFilterResult.primaryImage,
  );

  const currentStrictOutcome: ExtractionOutcome = {
    configuration: 'current_strict_images',
    data: {
      ...baselineResult.data,
      primaryImage: strictFilterResult.primaryImage,
      additionalImages: strictAdditionalImages,
    },
    raw: baselineResult.raw,
    admittedImages: strictFilterResult.admittedImages,
    rejectedImages: strictFilterResult.rejectedImages,
    primaryImage: strictFilterResult.primaryImage,
    imageRejectionReasons: strictFilterResult.rejectionReasons,
    isEvidenceGap: false,
  };

  // ── Configuration 3: Structured Signals Only (Measurement Arm) ────────────
  // Re-run with profile = null to disable custom CSS selectors
  const structuredResult = await extractViaHttpDetailed(sample.url, null, expected, mockFetch);
  const structuredAdmittedImages = [
    structuredResult.data.primaryImage,
    ...(structuredResult.data.additionalImages || []),
  ].filter(Boolean) as string[];

  const structuredOutcome: ExtractionOutcome = {
    configuration: 'structured_only',
    data: structuredResult.data,
    raw: structuredResult.raw,
    admittedImages: structuredAdmittedImages,
    rejectedImages: [],
    primaryImage: structuredResult.data.primaryImage,
    isEvidenceGap: false,
  };

  // ── Configuration 4: Proposed Hybrid (Identity-First + Strict) ─────────────
  const hybridResult = selectHybridFields({
    raw: baselineResult.raw,
    url: sample.url,
    html,
    expected,
  });

  const hybridOutcome: ExtractionOutcome = {
    configuration: 'hybrid_identity_first',
    data: hybridResult.data,
    raw: baselineResult.raw,
    conflicts: hybridResult.conflicts,
    variantDecision: hybridResult.variantDecision,
    identityResolution: hybridResult.identityResolution,
    admittedImages: hybridResult.admittedImages,
    rejectedImages: hybridResult.rejectedImages,
    primaryImage: hybridResult.primaryImage,
    imageRejectionReasons: hybridResult.imageRejectionReasons,
    isEvidenceGap: false,
  };

  return {
    current_extraction: currentExtractionOutcome,
    current_strict_images: currentStrictOutcome,
    structured_only: structuredOutcome,
    hybrid_identity_first: hybridOutcome,
  };
}
