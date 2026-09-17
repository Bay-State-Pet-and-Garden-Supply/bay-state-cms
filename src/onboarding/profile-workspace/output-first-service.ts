/**
 * Output-First Profile Workspace Service (#191)
 *
 * Implements the output-first workspace inspection flow:
 * 1. URL ingest renders resolved product and variant, per-field values with sources,
 *    and the gallery with the primary flagged, WITHOUT requiring custom selectors first.
 * 2. The Exception Queue holds ONLY:
 *    - missing: required/standard fields not extracted
 *    - conflicted: cross-source disagreements (selector vs structured)
 *    - unknown-membership: images lacking variant membership or proven shared proof
 *    - vague-identity: generic title fragments, ambiguous variants, or parent-vs-variant confusion
 *    Each item is deep-resolvable.
 * 3. Sibling-URL validation:
 *    Validates the draft against representative sibling URLs.
 *    Sibling validation must pass before reviewer approval; drafting stays proposal-only until then.
 *    Preserves per-structure fail-closed extraction and existing readiness vocabulary.
 * 4. Records session metrics:
 *    Time to first working profile, manual corrections count, sibling pass rate, wrong product/image counts.
 */

import { extractProductFromHtml } from '../page-extractor';
import { selectHybridFields, type RawExtractionLayers } from '../profile-audit/hybrid-field-selector';
import { isGenericTitleFragment } from '../profile-audit/scorer';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type { HybridConflict, IdentityVerdict } from '../../shared/schemas/profile-audit';

export type ExceptionCategory =
  | 'missing'
  | 'conflicted'
  | 'unknown-membership'
  | 'vague-identity';

export interface ExceptionResolutionOption {
  action: string;
  label: string;
  value?: string;
}

export interface ExceptionQueueItem {
  id: string;
  category: ExceptionCategory;
  field?: string;
  imageUrl?: string;
  title: string;
  description: string;
  currentValue?: string | null;
  conflictingValue?: string | null;
  sources?: string[];
  severity: 'critical' | 'warning';
  resolutions: ExceptionResolutionOption[];
}

export interface OutputFirstInspectOptions {
  domain: string;
  url: string;
  html?: string;
  profile?: ExtractorProfile | null;
  expected?: {
    name?: string;
    brandHint?: string | null;
    price?: string | null;
    gtin?: string | null;
    sku?: string | null;
  };
  startTime?: number;
}

export interface OutputFirstInspectionResult {
  url: string;
  domain: string;
  identity: {
    status: string;
    verdict: IdentityVerdict;
    selectedVariantKey: string | null;
    selectedCandidateTitle: string | null;
    parentTitle: string | null;
    confusionDetected: boolean;
    confusionType: string | null;
    confusionDetails: string | null;
    isVague: boolean;
    vagueReason: string | null;
  };
  fields: Record<
    string,
    {
      value: string | null;
      source: string;
      status: 'extracted' | 'missing' | 'conflicted';
      conflict?: HybridConflict | null;
    }
  >;
  gallery: {
    primaryImage: string | null;
    admittedImages: string[];
    rejectedImages: Array<{
      url: string;
      reason: string;
    }>;
  };
  exceptionQueue: ExceptionQueueItem[];
  canApprove: boolean;
  siblingValidationRequired: boolean;
  metrics: {
    timeToFirstWorkingProfileMs: number;
    exceptionsCount: number;
    missingCount: number;
    conflictedCount: number;
    unknownMembershipCount: number;
    vagueIdentityCount: number;
    manualCorrectionsCount: number;
    wrongProductCount: number;
    wrongImageCount: number;
  };
}

const COMMON_GENERIC_WORDS = new Set([
  'shampoo',
  'spray',
  'food',
  'treats',
  'collar',
  'leash',
  'harness',
  'toy',
  'supplement',
  'conditioner',
  'cleaner',
  'bed',
  'bowl',
]);

function checkIsVagueTitle(title: string | null, expectedName?: string | null): { isVague: boolean; reason: string | null } {
  if (!title || !title.trim()) {
    return { isVague: true, reason: 'Title is missing or empty' };
  }
  const cleanTitle = title.trim();

  // If expected name is provided, use discriminator scoring
  if (expectedName && expectedName.trim()) {
    if (isGenericTitleFragment(cleanTitle, expectedName.trim())) {
      return {
        isVague: true,
        reason: `Extracted title "${cleanTitle}" is a generic fragment of expected product "${expectedName.trim()}"`,
      };
    }
  }

  // Bare category word heuristic (single generic category word with no identifying qualifiers or codes)
  const tokens = cleanTitle.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && COMMON_GENERIC_WORDS.has(tokens[0])) {
    return {
      isVague: true,
      reason: `Extracted title "${cleanTitle}" is a bare category word without distinguishing product identity or codes`,
    };
  }

  return { isVague: false, reason: null };
}

export async function inspectProfileUrl(
  options: OutputFirstInspectOptions,
): Promise<OutputFirstInspectionResult> {
  const { domain, url, html = '', profile = null, expected } = options;
  const start = options.startTime ?? Date.now();

  const zeroNetworkFetch = async () => {
    throw new Error('inspectProfileUrl zero-network violation');
  };

  // 1. Raw extraction layers from HTML (Cheerio + structured data)
  const detailed = await extractProductFromHtml(
    html,
    url,
    profile,
    expected ? {
      name: expected.name,
      brandHint: expected.brandHint ?? undefined,
      price: expected.price ?? undefined,
      gtin: expected.gtin ?? undefined,
    } : undefined,
    zeroNetworkFetch,
  );

  const rawLayers: RawExtractionLayers = detailed.raw as unknown as RawExtractionLayers;

  // 2. Hybrid Field Selection & Identity Resolution
  const hybrid = selectHybridFields({
    raw: rawLayers,
    url,
    html,
    expected,
  });

  // 3. Resolve Identity & Vague Identity Detection
  const extractedTitle = hybrid.data.title;
  const vagueCheck = checkIsVagueTitle(extractedTitle, expected?.name);

  const identityStatus =
    hybrid.identityResolution.status === 'no_matrix' && (hybrid.data.title || hybrid.data.sku || hybrid.data.gtin)
      ? 'single_variant'
      : hybrid.identityResolution.status;

  const isVague =
    vagueCheck.isVague ||
    hybrid.identityResolution.confusionDetected ||
    identityStatus === 'ambiguous_variant' ||
    (identityStatus === 'parent_page' && !hybrid.selectedCandidate);

  const vagueReason = vagueCheck.reason || hybrid.identityResolution.confusionDetails || null;

  const identityVerdict: IdentityVerdict = isVague
    ? (identityStatus === 'ambiguous_variant' ? 'ambiguous' : 'unidentified')
    : 'correct_match';

  // 4. Per-Field Values with Sources
  const fields: OutputFirstInspectionResult['fields'] = {};
  const conflictMap = new Map<string, HybridConflict>();
  for (const c of hybrid.conflicts) {
    conflictMap.set(c.field, c);
  }

  const standardFields = ['title', 'brand', 'price', 'description', 'sku', 'gtin'] as const;
  for (const f of standardFields) {
    const val = (hybrid.data as Record<string, unknown>)[f] as string | null | undefined;
    const source = hybrid.fieldProvenance[f] || 'none';
    const conflict = conflictMap.get(f) ?? null;

    let status: 'extracted' | 'missing' | 'conflicted' = 'extracted';
    if (conflict) {
      status = 'conflicted';
    } else if (!val || !String(val).trim()) {
      status = 'missing';
    }

    fields[f] = {
      value: val ? String(val).trim() : null,
      source,
      status,
      conflict,
    };
  }

  // 5. Gallery
  const rejectedImages: Array<{ url: string; reason: string }> = [];
  for (const [imgUrl, reason] of Object.entries(hybrid.imageRejectionReasons)) {
    rejectedImages.push({ url: imgUrl, reason });
  }

  const gallery = {
    primaryImage: hybrid.primaryImage,
    admittedImages: hybrid.admittedImages,
    rejectedImages,
  };

  // 6. Exception Queue: ONLY missing, conflicted, unknown-membership, vague-identity
  const exceptionQueue: ExceptionQueueItem[] = [];

  // A. Vague Identity
  if (isVague) {
    exceptionQueue.push({
      id: 'exc-vague-identity',
      category: 'vague-identity',
      title: 'Vague or Ambiguous Identity',
      description: vagueReason ?? 'Product identity cannot be deterministically resolved',
      severity: 'critical',
      resolutions: [
        { action: 'select_variant', label: 'Select Variant from Candidate Matrix' },
        { action: 'manual_pick_title', label: 'Select Specific Title Element on Page' },
        { action: 'manual_pick_sku', label: 'Select Specific Variant SKU Element on Page' },
      ],
    });
  }

  // B. Missing Fields (critical required fields: title, brand, price)
  const criticalFields = ['title', 'brand', 'price'] as const;
  for (const f of criticalFields) {
    if (fields[f].status === 'missing') {
      exceptionQueue.push({
        id: `exc-missing-${f}`,
        category: 'missing',
        field: f,
        title: `Missing Required Field: ${f.toUpperCase()}`,
        description: `Could not extract ${f} from structured or heuristic signals.`,
        severity: 'critical',
        resolutions: [
          { action: 'manual_pick', label: `Select ${f} on Page Canvas` },
          { action: 'edit_selector', label: `Specify CSS Selector for ${f}` },
          { action: 'manual_value', label: `Enter Manual Value for ${f}` },
        ],
      });
    }
  }

  // C. Conflicted Fields
  for (const [f, conflict] of conflictMap.entries()) {
    exceptionQueue.push({
      id: `exc-conflicted-${f}`,
      category: 'conflicted',
      field: f,
      title: `Conflicted Value: ${f.toUpperCase()}`,
      description: conflict.disagreementReason ?? `Disagreement between selector and structured ${conflict.structuredSource}`,
      currentValue: conflict.selectorValue,
      conflictingValue: conflict.structuredValue,
      sources: [conflict.selectorSource, conflict.structuredSource],
      severity: (conflict.severity as 'critical' | 'warning') ?? 'critical',
      resolutions: [
        {
          action: 'choose_structured',
          label: `Use Structured (${conflict.structuredSource}): "${conflict.structuredValue ?? ''}"`,
          value: conflict.structuredValue ?? undefined,
        },
        {
          action: 'choose_selector',
          label: `Use Custom Selector: "${conflict.selectorValue ?? ''}"`,
          value: conflict.selectorValue ?? undefined,
        },
        { action: 'manual_pick', label: `Select Element on Page` },
        { action: 'manual_value', label: `Enter Manual Value` },
      ],
    });
  }

  // D. Unknown-Membership Images
  for (const rej of rejectedImages) {
    if (rej.reason === 'unknown_membership') {
      exceptionQueue.push({
        id: `exc-unknown-image-${Buffer.from(rej.url).toString('base64').slice(0, 16)}`,
        category: 'unknown-membership',
        imageUrl: rej.url,
        title: 'Image of Unknown Membership',
        description: `Image was rejected because it lacks positive variant membership or proven shared evidence.`,
        severity: 'warning',
        resolutions: [
          { action: 'admit_variant_image', label: 'Admit Image (Confirm Variant Membership)' },
          { action: 'set_primary', label: 'Admit and Set as Primary Image' },
          { action: 'keep_rejected', label: 'Confirm Rejection' },
        ],
      });
    }
  }

  const missingCount = exceptionQueue.filter((e) => e.category === 'missing').length;
  const conflictedCount = exceptionQueue.filter((e) => e.category === 'conflicted').length;
  const unknownMembershipCount = exceptionQueue.filter((e) => e.category === 'unknown-membership').length;
  const vagueIdentityCount = exceptionQueue.filter((e) => e.category === 'vague-identity').length;

  const wrongProductCount = (identityVerdict as string) === 'wrong_product' ? 1 : 0;
  const wrongImageCount = rejectedImages.filter((r) => r.reason === 'other_variant').length;

  const hasCriticalExceptions = exceptionQueue.some((e) => e.severity === 'critical');
  const canApprove = !hasCriticalExceptions && exceptionQueue.length === 0;

  const elapsedMs = Date.now() - start;

  return {
    url,
    domain,
    identity: {
      status: identityStatus,
      verdict: identityVerdict,
      selectedVariantKey: hybrid.identityResolution.selectedVariantKey,
      selectedCandidateTitle: (hybrid.identityResolution.selectedCandidateTitle ?? hybrid.data.title) || null,
      parentTitle: hybrid.identityResolution.parentTitle ?? null,
      confusionDetected: hybrid.identityResolution.confusionDetected,
      confusionType: hybrid.identityResolution.confusionType ?? null,
      confusionDetails: hybrid.identityResolution.confusionDetails ?? null,
      isVague,
      vagueReason,
    },
    fields,
    gallery,
    exceptionQueue,
    canApprove,
    siblingValidationRequired: true,
    metrics: {
      timeToFirstWorkingProfileMs: elapsedMs,
      exceptionsCount: exceptionQueue.length,
      missingCount,
      conflictedCount,
      unknownMembershipCount,
      vagueIdentityCount,
      manualCorrectionsCount: 0,
      wrongProductCount,
      wrongImageCount,
    },
  };
}

export function applyExceptionResolution(
  inspection: OutputFirstInspectionResult,
  exceptionId: string,
  resolution: {
    action: string;
    value?: string;
    selectedVariantKey?: string;
  },
): OutputFirstInspectionResult {
  const exc = inspection.exceptionQueue.find((e) => e.id === exceptionId);
  if (!exc) return inspection;

  const nextFields = { ...inspection.fields };
  const nextGallery = {
    ...inspection.gallery,
    admittedImages: [...inspection.gallery.admittedImages],
    rejectedImages: [...inspection.gallery.rejectedImages],
  };
  let nextIdentity = { ...inspection.identity };

  if (exc.category === 'missing' || exc.category === 'conflicted') {
    const f = exc.field;
    if (f) {
      const resolvedVal = resolution.value ?? exc.conflictingValue ?? exc.currentValue ?? null;
      const source =
        resolution.action === 'choose_structured'
          ? (exc.sources?.[1] || 'structured')
          : resolution.action === 'choose_selector'
          ? 'custom-selector'
          : 'manual-override';

      nextFields[f] = {
        value: resolvedVal,
        source,
        status: 'extracted',
        conflict: null,
      };
    }
  } else if (exc.category === 'unknown-membership' && exc.imageUrl) {
    if (resolution.action === 'admit_variant_image') {
      if (!nextGallery.admittedImages.includes(exc.imageUrl)) {
        nextGallery.admittedImages.push(exc.imageUrl);
      }
      nextGallery.rejectedImages = nextGallery.rejectedImages.filter((r) => r.url !== exc.imageUrl);
    } else if (resolution.action === 'set_primary') {
      nextGallery.primaryImage = exc.imageUrl;
      nextGallery.admittedImages = [
        exc.imageUrl,
        ...nextGallery.admittedImages.filter((u) => u !== exc.imageUrl),
      ];
      nextGallery.rejectedImages = nextGallery.rejectedImages.filter((r) => r.url !== exc.imageUrl);
    } else if (resolution.action === 'keep_rejected') {
      // Confirmed rejected, no change to gallery
    }
  } else if (exc.category === 'vague-identity') {
    nextIdentity.isVague = false;
    nextIdentity.vagueReason = null;
    nextIdentity.verdict = 'correct_match';
    if (resolution.value) {
      nextFields.title = {
        value: resolution.value,
        source: 'manual-override',
        status: 'extracted',
        conflict: null,
      };
    }
    if (resolution.selectedVariantKey) {
      nextIdentity.selectedVariantKey = resolution.selectedVariantKey;
      nextIdentity.status = 'resolved_variant';
    }
  }

  const nextQueue = inspection.exceptionQueue.filter((e) => e.id !== exceptionId);
  const hasCritical = nextQueue.some((e) => e.severity === 'critical');

  return {
    ...inspection,
    fields: nextFields,
    gallery: nextGallery,
    identity: nextIdentity,
    exceptionQueue: nextQueue,
    canApprove: !hasCritical && nextQueue.length === 0,
    metrics: {
      ...inspection.metrics,
      exceptionsCount: nextQueue.length,
      missingCount: nextQueue.filter((e) => e.category === 'missing').length,
      conflictedCount: nextQueue.filter((e) => e.category === 'conflicted').length,
      unknownMembershipCount: nextQueue.filter((e) => e.category === 'unknown-membership').length,
      vagueIdentityCount: nextQueue.filter((e) => e.category === 'vague-identity').length,
      manualCorrectionsCount: inspection.metrics.manualCorrectionsCount + 1,
    },
  };
}

export interface ValidateSiblingUrlsOptions {
  domain: string;
  siblingPages: Array<{
    url: string;
    html?: string;
    expected?: {
      name?: string;
      brandHint?: string | null;
      price?: string | null;
      gtin?: string | null;
      sku?: string | null;
    };
  }>;
  profile?: ExtractorProfile | null;
}

export interface SiblingValidationResult {
  ok: boolean;
  passRate: number;
  totalSiblings: number;
  passedCount: number;
  canApprove: boolean;
  results: Array<{
    url: string;
    success: boolean;
    failureReasons: string[];
    inspection: OutputFirstInspectionResult;
  }>;
}

export async function validateSiblingUrls(
  options: ValidateSiblingUrlsOptions,
): Promise<SiblingValidationResult> {
  const { domain, siblingPages, profile = null } = options;
  const results: SiblingValidationResult['results'] = [];

  let passedCount = 0;
  for (const s of siblingPages) {
    const inspection = await inspectProfileUrl({
      domain,
      url: s.url,
      html: s.html,
      profile,
      expected: s.expected,
    });

    const failureReasons: string[] = [];
    if (inspection.identity.isVague) {
      failureReasons.push(`Vague identity: ${inspection.identity.vagueReason ?? 'unresolved'}`);
    }
    if (!inspection.fields.title?.value) {
      failureReasons.push('Missing title');
    }
    if (!inspection.fields.price?.value) {
      failureReasons.push('Missing price');
    }

    const hasCriticalExceptions = inspection.exceptionQueue.some((e) => e.severity === 'critical');
    if (hasCriticalExceptions) {
      failureReasons.push('Unresolved critical exceptions');
    }

    const success = failureReasons.length === 0;
    if (success) passedCount++;

    results.push({
      url: s.url,
      success,
      failureReasons,
      inspection,
    });
  }

  const totalSiblings = siblingPages.length;
  const passRate = totalSiblings > 0 ? passedCount / totalSiblings : 0;
  const ok = totalSiblings > 0 && passedCount === totalSiblings;

  return {
    ok,
    passRate,
    totalSiblings,
    passedCount,
    canApprove: ok,
    results,
  };
}
