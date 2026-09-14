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
 * - Deterministic: identical artifact in, identical outcomes out — EXCLUDING
 *   wall-clock latencyMs (fix #8). latencyMs is transport timing recorded only
 *   when recordLatency:true (via performance.now() or an injected clock);
 *   scored-row identity comparisons MUST use getDeterministicScoredRowIdentity()
 *   (shared-metrics.ts), which strips wall-clock latency.
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
import { parseVariantMatrix, matchVariantMatrix } from '../variant-resolver';
import type { VariantMatrix, VariantMatchDecision } from '../../shared/schemas/variant-resolution';
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
    latencyMs: 0,
    requestCount: 0,
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

  const recordLatency = Boolean(options.recordLatency);
  // Wall-clock source (fix #8): injectable for deterministic replays; the
  // recorded latencyMs is transport timing and is excluded from scored-row
  // identity (see getDeterministicScoredRowIdentity).
  const now = options.clock ?? (() => performance.now());

  // ── Configuration 1: Current Extraction (Baseline) ──────────────────────────
  const t0Baseline = now();
  const baselineResult = await extractViaHttpDetailed(sample.url, profile, expected, mockFetch);
  const baselineLatency = recordLatency ? Math.round((now() - t0Baseline) * 10) / 10 : undefined;
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
    latencyMs: baselineLatency,
    requestCount: 1,
  };

  // ── Configuration 2: Current + Strict Image Filtering ─────────────────────
  const t0Strict = now();
  let cfg2Matrix: VariantMatrix | null = null;
  try {
    cfg2Matrix = parseVariantMatrix(html, sample.url);
  } catch {
    // Graceful degradation
  }
  let cfg2Decision: VariantMatchDecision | null = null;
  if (cfg2Matrix && cfg2Matrix.candidates.length > 0 && expected) {
    try {
      cfg2Decision = matchVariantMatrix(cfg2Matrix, {
        name: expected.name ?? '',
        brandHint: expected.brandHint ?? null,
        gtin: expected.gtin ?? null,
        sku: null,
        mpn: null,
      });
    } catch {
      // Graceful degradation
    }
  }

  const strictFilterResult = applyStrictImageFilter({
    images: baselineRawImages.length > 0 ? baselineRawImages : baselineAdmittedImages,
    baseUrl: sample.url,
    variantMatrix: cfg2Matrix,
    selectedVariantKey: cfg2Decision?.selectedVariantKey ?? (cfg2Matrix?.candidates.length === 1 ? cfg2Matrix.candidates[0].variantKey : null),
  });

  const strictAdditionalImages = strictFilterResult.admittedImages.filter(
    u => u !== strictFilterResult.primaryImage,
  );
  const strictLatency = recordLatency ? Math.round((now() - t0Strict) * 10) / 10 : undefined;

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
    latencyMs: recordLatency && baselineLatency !== undefined && strictLatency !== undefined ? baselineLatency + strictLatency : undefined,
    requestCount: 1,
  };

  // ── Configuration 3: Structured Signals Only (Measurement Arm) ────────────
  // Re-run with profile = null to disable custom CSS selectors
  const t0Structured = now();
  const structuredResult = await extractViaHttpDetailed(sample.url, null, expected, mockFetch);
  const structuredLatency = recordLatency ? Math.round((now() - t0Structured) * 10) / 10 : undefined;
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
    latencyMs: structuredLatency,
    requestCount: 1,
  };

  // ── Configuration 4: Proposed Hybrid (Identity-First + Strict) ─────────────
  const t0Hybrid = now();
  const hybridResult = selectHybridFields({
    raw: baselineResult.raw,
    url: sample.url,
    html,
    expected,
  });
  const hybridLatency = recordLatency ? Math.round((now() - t0Hybrid) * 10) / 10 : undefined;

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
    latencyMs: recordLatency && baselineLatency !== undefined && hybridLatency !== undefined ? baselineLatency + hybridLatency : undefined,
    requestCount: 1,
  };

  return {
    current_extraction: currentExtractionOutcome,
    current_strict_images: currentStrictOutcome,
    structured_only: structuredOutcome,
    hybrid_identity_first: hybridOutcome,
  };
}
