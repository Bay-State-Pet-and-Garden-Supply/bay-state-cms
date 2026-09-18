// Client-safe profile-workspace inspection view model (no server/Node imports).
//
// These types and the pure exception-resolution reducer are consumed by BOTH the
// server-side Output-First service and the Profile Workspace UI. They live in
// src/shared so the browser bundle never reaches server code: importing this slice
// from src/onboarding/profile-workspace/output-first-service.ts dragged the server
// extraction chain (page-extractor → playwright, db repositories → node:crypto)
// into the client graph and broke `vite build` / the dev dependency scan.

import type { HybridConflict, IdentityVerdict } from '../schemas/profile-audit';

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

type ExceptionResolution = {
  action: string;
  value?: string;
  selectedVariantKey?: string;
};

/** Source label for a field resolution, mirroring the original action mapping. */
function sourceForAction(action: string, sources?: string[]): string {
  if (action === 'choose_structured') return sources?.[1] || 'structured';
  if (action === 'choose_selector') return 'custom-selector';
  return 'manual-override';
}

/** Field patch for missing/conflicted resolutions and vague-identity title corrections. */
function resolveFieldPatch(
  exc: ExceptionQueueItem,
  resolution: ExceptionResolution,
): OutputFirstInspectionResult['fields'] {
  if (exc.category === 'vague-identity') {
    if (!resolution.value) return {};
    return {
      title: { value: resolution.value, source: 'manual-override', status: 'extracted', conflict: null },
    };
  }
  if ((exc.category !== 'missing' && exc.category !== 'conflicted') || !exc.field) return {};
  return {
    [exc.field]: {
      value: resolution.value ?? exc.conflictingValue ?? exc.currentValue ?? null,
      source: sourceForAction(resolution.action, exc.sources),
      status: 'extracted',
      conflict: null,
    },
  };
}

/** Identity patch for vague-identity resolutions. */
function resolveIdentityPatch(
  exc: ExceptionQueueItem,
  resolution: ExceptionResolution,
): Partial<OutputFirstInspectionResult['identity']> {
  if (exc.category !== 'vague-identity') return {};
  const patch: Partial<OutputFirstInspectionResult['identity']> = {
    isVague: false,
    vagueReason: null,
    verdict: 'correct_match',
  };
  if (resolution.selectedVariantKey) {
    patch.selectedVariantKey = resolution.selectedVariantKey;
    patch.status = 'resolved_variant';
  }
  return patch;
}

/** Gallery patch shape: `promote` prepends (set_primary), otherwise append-if-missing. */
type GalleryPatch = { admit: string; promote: boolean } | null;

function resolveGalleryPatch(exc: ExceptionQueueItem, resolution: ExceptionResolution): GalleryPatch {
  if (exc.category !== 'unknown-membership' || !exc.imageUrl) return null;
  if (resolution.action === 'admit_variant_image') return { admit: exc.imageUrl, promote: false };
  if (resolution.action === 'set_primary') return { admit: exc.imageUrl, promote: true };
  // keep_rejected (and unknown actions) leave the gallery untouched.
  return null;
}

function applyGalleryPatch(
  gallery: OutputFirstInspectionResult['gallery'],
  patch: GalleryPatch,
): OutputFirstInspectionResult['gallery'] {
  const base = {
    ...gallery,
    admittedImages: [...gallery.admittedImages],
    rejectedImages: [...gallery.rejectedImages],
  };
  if (!patch) return base;
  const { admit, promote } = patch;
  const alreadyAdmitted = base.admittedImages.includes(admit);
  return {
    primaryImage: promote ? admit : base.primaryImage,
    admittedImages: promote
      ? [admit, ...base.admittedImages.filter((u) => u !== admit)]
      : alreadyAdmitted
        ? base.admittedImages
        : [...base.admittedImages, admit],
    rejectedImages: base.rejectedImages.filter((r) => r.url !== admit),
  };
}

/** Metrics recomputed after the resolved exception leaves the queue. */
function recomputeMetrics(
  metrics: OutputFirstInspectionResult['metrics'],
  queue: ExceptionQueueItem[],
): OutputFirstInspectionResult['metrics'] {
  const countOf = (category: ExceptionCategory) => queue.filter((e) => e.category === category).length;
  return {
    ...metrics,
    exceptionsCount: queue.length,
    missingCount: countOf('missing'),
    conflictedCount: countOf('conflicted'),
    unknownMembershipCount: countOf('unknown-membership'),
    vagueIdentityCount: countOf('vague-identity'),
    manualCorrectionsCount: metrics.manualCorrectionsCount + 1,
  };
}

/**
 * Pure reducer: apply one exception resolution to an inspection result.
 * Behaviour is unchanged from the Output-First service original; the branches
 * are extracted into the patches above so the reducer stays below the
 * project's complexity gate.
 */
export function applyExceptionResolution(
  inspection: OutputFirstInspectionResult,
  exceptionId: string,
  resolution: ExceptionResolution,
): OutputFirstInspectionResult {
  const exc = inspection.exceptionQueue.find((e) => e.id === exceptionId);
  if (!exc) return inspection;

  const nextQueue = inspection.exceptionQueue.filter((e) => e.id !== exceptionId);
  const hasCritical = nextQueue.some((e) => e.severity === 'critical');

  return {
    ...inspection,
    fields: { ...inspection.fields, ...resolveFieldPatch(exc, resolution) },
    gallery: applyGalleryPatch(inspection.gallery, resolveGalleryPatch(exc, resolution)),
    identity: { ...inspection.identity, ...resolveIdentityPatch(exc, resolution) },
    exceptionQueue: nextQueue,
    canApprove: !hasCritical && nextQueue.length === 0,
    metrics: recomputeMetrics(inspection.metrics, nextQueue),
  };
}
