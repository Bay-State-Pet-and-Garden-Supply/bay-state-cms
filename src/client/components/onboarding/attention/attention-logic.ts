/**
 * Epic #46 Phase 4 — Needs Attention queue logic (pure, unit-testable).
 *
 * All human-facing labels, grouping, consequences and profile-readiness
 * derivation live here so the components stay presentational and the text
 * stays deterministic. The server owns the work-state projection; this
 * module only formats and groups what the server already derived.
 */
import type {
  AttentionAction,
  AttentionReason,
  OnboardingWorkState,
  WorkActivity,
} from '../../../../shared/schemas/onboarding-work-state';
import type { DomainDiagnosticsEntry, OnboardingSource } from '../../../../shared/schemas/onboarding';
import {
  ACTIVITY_BADGE_LABELS,
  ACTIVITY_BADGE_TOOLTIPS,
  getActivityBadgeLabel as getProcessingBadgeLabel,
  getActivityBadgeTooltip as getProcessingBadgeTooltip,
} from '../processing/processing-logic';

// Re-export granular activity badge helpers so both Processing and Attention
// surfaces share one canonical vocabulary (single source of truth in processing-logic).
export { ACTIVITY_BADGE_LABELS, ACTIVITY_BADGE_TOOLTIPS };
export const getActivityBadgeLabel = getProcessingBadgeLabel;
export const getActivityBadgeTooltip = getProcessingBadgeTooltip;
export type { WorkActivity };

// ─── Attention group metadata (display order) ──────────────────────────────────

export interface AttentionGroupMeta {
  reason: AttentionReason | 'unknown';
  label: string;
  /** Short chip label for the filter row. */
  chipLabel: string;
}

export const ATTENTION_GROUP_ORDER: ReadonlyArray<AttentionGroupMeta> = [
  { reason: 'brand_not_provided', label: 'Brand assignment required', chipLabel: 'Needs brand' },
  { reason: 'verify_official_url', label: 'Verify official product page', chipLabel: 'Verify page' },
  { reason: 'no_official_url', label: 'Official product page not found', chipLabel: 'No page found' },
  { reason: 'choose_official_url', label: 'Choose the correct product page', chipLabel: 'Choose page' },
  { reason: 'choose_variant', label: 'Choose product variant', chipLabel: 'Choose variant' },
  { reason: 'extractor_profile_required', label: 'Extractor setup required', chipLabel: 'Set up extractor' },
  { reason: 'manual_evidence_available', label: 'Manual evidence available', chipLabel: 'Enter manually' },
  { reason: 'extraction_profile_failed', label: 'Extraction / profile failure', chipLabel: 'Extraction failed' },
  { reason: 'source_conflict', label: 'Distributor match conflict', chipLabel: 'Conflict' },
  { reason: 'processing_failed', label: 'Processing failure', chipLabel: 'Processing failed' },
  { reason: 'semantic_validation_blocked', label: 'Curation semantic conflict', chipLabel: 'Curation conflict' },
  { reason: 'unknown', label: 'Other', chipLabel: 'Other' },
];

export function getAttentionGroupLabel(reason: AttentionReason | null | undefined): string {
  const key: AttentionReason | 'unknown' = reason ?? 'unknown';
  return ATTENTION_GROUP_ORDER.find((g) => g.reason === key)?.label ?? 'Other';
}

export function getAttentionGroupChip(reason: AttentionReason | null | undefined): string {
  const key: AttentionReason | 'unknown' = reason ?? 'unknown';
  return ATTENTION_GROUP_ORDER.find((g) => g.reason === key)?.chipLabel ?? 'Other';
}

// ─── Action labels ─────────────────────────────────────────────────────────────

export const ATTENTION_ACTION_LABELS: Record<AttentionAction, string> = {
  assign_brand: 'Assign brand',
  verify_official_url: 'Confirm the page',
  choose_official_url: 'Choose a page',
  choose_variant: 'Choose product variant',
  setup_extractor_profile: 'Set up extraction',
  retry_extraction: 'Retry extraction',
  resolve_source_conflict: 'Resolve conflict',
  retry_processing: 'Retry',
  resolve_semantic_conflict: 'Review curation findings',
  enter_manual_evidence: 'Enter manual evidence',
};

export function getAttentionActionLabel(action: AttentionAction | null | undefined): string {
  if (!action) return 'Resolve';
  return ATTENTION_ACTION_LABELS[action] ?? 'Resolve';
}

/**
 * Prioritized operator actions for an attention reason, in the order they
 * should be offered. `extraction_profile_failed` is retry-first: extraction
 * may simply need to run again against the existing (now usable) profile,
 * with extractor setup offered second when the profile itself is broken.
 * Deterministic and unit-tested. Empty when no specific action applies.
 */
export function getAttentionActions(
  reason: AttentionReason | null | undefined,
): AttentionAction[] {
  switch (reason) {
    case 'brand_not_provided':
      return ['assign_brand'];
    case 'verify_official_url':
    case 'no_official_url':
      return ['verify_official_url'];
    case 'choose_official_url':
      return ['choose_official_url'];
    case 'choose_variant':
      return ['choose_variant'];
    case 'extractor_profile_required':
      return ['setup_extractor_profile'];
    case 'extraction_profile_failed':
      return ['retry_extraction', 'setup_extractor_profile'];
    case 'manual_evidence_available':
      return ['enter_manual_evidence'];
    case 'source_conflict':
      return ['resolve_source_conflict'];
    case 'processing_failed':
      return ['retry_processing'];
    case 'semantic_validation_blocked':
      return ['resolve_semantic_conflict'];
    default:
      return [];
  }
}

/** Deterministic per-action consequence text ("what happens after I do this"). */
export function getAttentionActionConsequence(action: AttentionAction | null | undefined): string {
  switch (action) {
    case 'assign_brand':
      return 'Assigning the brand re-runs distributor lookups and official site discovery automatically.';
    case 'retry_extraction':
      return 'After you retry, extraction runs again with the existing profile.';
    case 'setup_extractor_profile':
      return 'After you save a usable extractor, this product and other blocked products on the domain resume automatically.';
    case 'verify_official_url':
      return 'Confirm the page and extraction resumes automatically.';
    case 'choose_official_url':
      return 'Pick the right page and extraction resumes automatically.';
    case 'choose_variant':
      return 'Pick the exact variant and extraction resumes automatically.';
    case 'resolve_source_conflict':
      return 'Choose the correct value and sourcing continues automatically.';
    case 'retry_processing':
      return 'Retry the processing step for this product.';
    case 'resolve_semantic_conflict':
      return 'After the findings are resolved, this family re-runs Curation automatically and the product returns to Review.';
    case 'enter_manual_evidence':
      return 'Entering manual evidence completes extraction with a signed attestation; the family page stays reference-only and the item still passes Review.';
    default:
      return 'Resolve the blocker and processing continues automatically.';
  }
}

// ─── Consequence text ("what happens after I resolve it") ─────────────────────

/**
 * Deterministic one-line answer to the operator's fourth question:
 * "What will happen after I resolve it?" Mirrors the epic #46 workflow
 * contract (Phase 4 acceptance: URL confirm → extraction resumes
 * automatically; profile success → domain items release automatically).
 */
export function getAttentionConsequence(
  reason: AttentionReason | null | undefined,
  _detail?: string | null,
): string {
  switch (reason) {
    case 'brand_not_provided':
      return 'Assign the brand to run distributor lookup and official site discovery automatically.';
    case 'verify_official_url':
      return 'Confirm the correct page and extraction resumes automatically.';
    case 'no_official_url':
      return 'Provide the official product page URL to continue to extraction.';
    case 'choose_official_url':
      return 'Pick the right candidate (or enter the official URL) and extraction resumes automatically.';
    case 'choose_variant':
      return 'Pick the exact variant from the detected matrix and extraction resumes automatically.';
    case 'extractor_profile_required':
      return 'Set up an extractor for this domain and blocked products resume automatically.';
    case 'extraction_profile_failed':
      return 'Fix the extractor and retry; other products on the same domain can be released together.';
    case 'source_conflict':
      return 'Choose the correct distributor value; sourcing continues automatically.';
    case 'processing_failed':
      return 'Retry processing for this product.';
    case 'semantic_validation_blocked':
      return 'Resolve the findings and re-run Curation for this family; the product returns to Review automatically.';
    case 'manual_evidence_available':
      return 'Enter product facts manually with a signed attestation; the family page is reference only and the item still passes Review.';
    default:
      return 'Resolve the blocker and processing continues automatically.';
  }
}

// ─── Domain helpers ────────────────────────────────────────────────────────────

/** Normalized hostname (lowercase, leading `www.` stripped); null when unparsable. */
export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Normalize a domain string for comparison (lowercase, leading `www.` stripped). */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

// ─── Extractor profile readiness ───────────────────────────────────────────────

export type ProfileReadinessState = 'ready' | 'missing' | 'failed' | 'unknown';

export interface ProfileReadiness {
  state: ProfileReadinessState;
  /** The matched diagnostics entry (null when the domain has no diagnostics row). */
  entry: DomainDiagnosticsEntry | null;
}

/**
 * Derive whether a domain has a usable extractor profile from the
 * domain-diagnostics snapshot. The diagnostics entry is authoritative:
 * `hasActiveProfile` → ready; a failed generation with no active profile →
 * failed; otherwise missing (never attempted or still generating). Unknown
 * only when the domain itself is missing (no diagnostics entry).
 */
export function deriveProfileReadiness(domain: string | null, entries: DomainDiagnosticsEntry[]): ProfileReadiness {
  if (!domain) return { state: 'unknown', entry: null };
  const target = normalizeDomain(domain);
  const entry = entries.find((e) => normalizeDomain(e.domain) === target) ?? null;
  if (!entry) return { state: 'unknown', entry: null };
  if (entry.hasActiveProfile) return { state: 'ready', entry };
  if (entry.latestGenerationStatus === 'failed') return { state: 'failed', entry };
  return { state: 'missing', entry };
}

export const PROFILE_READINESS_LABELS: Record<ProfileReadinessState, string> = {
  ready: 'Extractor ready',
  missing: 'No working extractor for this domain',
  failed: 'Extractor generation failed',
  unknown: 'Extractor status unknown',
};

// ─── Queue grouping ────────────────────────────────────────────────────────────

export interface AttentionGroup {
  reason: AttentionReason | 'unknown';
  label: string;
  items: OnboardingWorkState[];
}

/** Group attention items by reason in canonical display order (unknown last). */
export function groupAttentionItems(items: OnboardingWorkState[]): AttentionGroup[] {
  const byReason = new Map<AttentionReason | 'unknown', OnboardingWorkState[]>();
  for (const item of items) {
    const key: AttentionReason | 'unknown' = item.attentionReason ?? 'unknown';
    const list = byReason.get(key) ?? [];
    list.push(item);
    byReason.set(key, list);
  }
  const groups: AttentionGroup[] = [];
  for (const meta of ATTENTION_GROUP_ORDER) {
    const list = byReason.get(meta.reason);
    if (list && list.length > 0) {
      groups.push({ reason: meta.reason, label: meta.label, items: list });
    }
  }
  return groups;
}

// ─── Candidate presentation ────────────────────────────────────────────────────

/** Human label for a discovery source method (panel removed with the retired review drawer). */
export function candidateMethodLabel(method: string | null | undefined): string {
  // Legacy SERP-era rows keep their historical provenance readable even
  // though the pipeline no longer produces these methods.
  if (method && method.startsWith('serper_')) return 'Legacy web search';
  switch (method) {
    case 'shopify_variant':
      return 'Variant match';
    case 'sitemap':
      return 'Sitemap match';
    case 'manual':
      return 'Manually added';
    default:
      return method && method.length > 0 ? method.replace(/_/g, ' ') : 'Search result';
  }
}

/** Confidence 0..1 → "86%" (em dash when absent). */
export function formatConfidence(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** A short, honest "why this candidate" line for the candidate panel. */
export function candidateWhy(source: OnboardingSource): string {
  const parts: string[] = [];
  if (source.recommendation && source.recommendation.length > 0) {
    parts.push(source.recommendation);
  } else {
    parts.push(`Found via ${candidateMethodLabel(source.sourceMethod)}`);
  }
  if (typeof source.confidence === 'number' && Number.isFinite(source.confidence)) {
    parts.push(`${formatConfidence(source.confidence)} confidence`);
  }
  if (source.verificationScore != null && Number.isFinite(source.verificationScore)) {
    parts.push(`verified ${formatConfidence(source.verificationScore)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Search candidate';
}
