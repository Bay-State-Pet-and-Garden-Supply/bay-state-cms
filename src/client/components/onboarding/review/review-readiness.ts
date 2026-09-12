/**
 * Review readiness derivation (story e10s03, epic #review-final-gate).
 *
 * Pure, framework-free client derivation turning an item detail into a
 * `{ ready, blockers, warnings }` view using the SHARED gate codes from
 * e10s01 (`REVIEW_COMPLETENESS_*_CODES` in src/shared/schemas/onboarding).
 *
 * Authority contract: the server snapshot on `detail.completeness` (e10s01
 * detail projection) is authoritative when present; the local fallback is
 * advisory-only and may under-approximate (brand/page verification needs
 * workspace state the client does not have). The review-complete gate stays
 * the final authority either way — a stale advisory "ready" is corrected by
 * the structured rejection codes (see `applyServerBlockers` /
 * `parseBlockersFromRejection`), never by silent acceptance.
 */
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import {
  REVIEW_COMPLETENESS_BLOCKER_CODES,
  REVIEW_COMPLETENESS_WARNING_CODES,
  type ReviewCompletenessBlockerCode,
  type ReviewCompletenessWarningCode,
} from '../../../../shared/schemas/onboarding';
import type { OnboardingApiError } from '../../../onboarding-api';
import type { ReviewDraft } from './review-types';
import {
  assessNamingInvariants,
  isProductCapacity,
  classifyTitleEmbeddedToken,
  type NamingMeasurementToken,
} from '../../../../onboarding/naming-assessment';
import { extractProtectedTokens, knownColorsAcross } from '../../../../onboarding/title-prompt-template';

export interface ReviewReadiness {
  ready: boolean;
  blockers: ReviewCompletenessBlockerCode[];
  warnings: ReviewCompletenessWarningCode[];
  notes: string[];
  /** True when derived from the server detail projection (authoritative). */
  authoritative: boolean;
}

const trimOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

function isBlockerCode(value: string): value is ReviewCompletenessBlockerCode {
  return (REVIEW_COMPLETENESS_BLOCKER_CODES as readonly string[]).includes(value);
}

function isWarningCode(value: string): value is ReviewCompletenessWarningCode {
  return (REVIEW_COMPLETENESS_WARNING_CODES as readonly string[]).includes(value);
}

/**
 * Effective promoted name — EXACT promoter chain (draft-promoter.ts:629/753):
 * RAW falsy `||` over untrimmed values; trimming happens only at the verdict
 * (parity with resolveEffectivePromotedName). A whitespace-only curatedTitle
 * is truthy in the chain and therefore blocks, exactly like the server gate.
 */
export function resolveEffectiveName(detail: ItemDetailResponse | null): string | null {
  const curatedRaw = detail?.item.curationData?.curatedTitle;
  const extractedRaw = detail?.extraction?.title ?? detail?.item.extractionData?.title;
  const finalTitle =
    (typeof curatedRaw === 'string' ? curatedRaw : '') ||
    (typeof extractedRaw === 'string' ? extractedRaw : '') ||
    detail?.item.name ||
    '';
  return trimOrNull(finalTitle);
}

/** Primary image through the promoter downloader input chain (advisory).
 * e10s04: the persisted reviewer media selection wins first, mirroring
 * resolveEffectivePrimaryImage in src/classification/review-completeness.ts. */
function resolvePrimaryImage(detail: ItemDetailResponse | null): string | null {
  const extraction = detail?.extraction ?? detail?.item.extractionData ?? null;
  const reviewed = (detail?.item.curationData as { reviewedMedia?: { primaryImage?: string | null; suppressed?: string[] } | null } | null | undefined)?.reviewedMedia ?? null;
  const suppressed = new Set(reviewed?.suppressed ?? []);
  const designated = typeof reviewed?.primaryImage === 'string' && reviewed.primaryImage.trim() !== ''
    ? reviewed.primaryImage.trim()
    : null;
  const designatedUsable = designated !== null && !suppressed.has(designated);
  if (designatedUsable) return designated;

  if (detail?.item.sourceType === 'distributor_record') {
    const approved = (extraction?.distributorImageApprovals ?? [])
      .map((a) => a.imageUrl)
      .filter((u): u is string => typeof u === 'string' && u.length > 0 && !suppressed.has(u));
    return approved[0] ?? null;
  }
  // Suppression wins over both designation and the extraction fallback:
  // a hidden image must surface as missing_primary_image, never silently ship.
  const extractionPrimary = trimOrNull(extraction?.primaryImage);
  if (extractionPrimary && !suppressed.has(extractionPrimary)) return extractionPrimary;
  return null;
}

/**
 * Derive the readiness view for one item. Prefers the authoritative server
 * snapshot; otherwise derives an ADVISORY approximation client-side.
 */
export function deriveReadiness(
  detail: ItemDetailResponse | null,
  workState?: ReviewQueueRow | OnboardingWorkState | null,
): ReviewReadiness {
  // Authoritative path: the e10s01 detail projection.
  const server = (detail as { completeness?: ReviewReadiness } | null)?.completeness;
  if (server && Array.isArray(server.blockers)) {
    return {
      ready: Boolean(server.ready),
      blockers: server.blockers.filter(isBlockerCode),
      warnings: Array.isArray(server.warnings) ? server.warnings.filter(isWarningCode) : [],
      notes: Array.isArray(server.notes) ? server.notes.map(String) : [],
      authoritative: true,
    };
  }

  // Advisory fallback (server snapshot absent — e.g. workspace probe failed).
  const blockers: ReviewCompletenessBlockerCode[] = [];
  const warnings: ReviewCompletenessWarningCode[] = [];
  const notes: string[] = [];
  const curation = detail?.item.curationData ?? null;
  const extraction = detail?.extraction ?? detail?.item.extractionData ?? null;
  const distributor = detail?.item.sourceType === 'distributor_record';

  const curatedTitle = trimOrNull(curation?.curatedTitle);
  const effectiveName = resolveEffectiveName(detail);
  if (!effectiveName) blockers.push('missing_name');
  else if (!curatedTitle) warnings.push('name_from_fallback_source');

  // Parity with resolveEffectivePromotedPrice: RAW falsy chain first
  // (whitespace-only item.price is truthy and cleans to empty ⇒ blocker,
  // never silently falls through to extraction), currency symbols stripped
  // only at the verdict.
  const rawPrice =
    detail?.item.price || (distributor ? null : extraction?.price) || null;
  const price =
    typeof rawPrice === 'string' ? rawPrice.replace(/[$\s,]/g, '').trim() || null : null;
  if (!price) {
    // Parity with evaluateReviewCompleteness adjudication: item.price is the
    // ONLY promotion price authority for distributor rows too, so an empty
    // item price blocks for every source type (fixable via the editable
    // price input).
    blockers.push('missing_price');
  }

  // Advisory brand check: the queue projection carries the resolved brand
  // when brand resolution ran; without it fall back to the raw hint. The
  // server gate remains the authority for the full resolution chain.
  const brand = trimOrNull(workState?.brand) ?? trimOrNull(detail?.item.brandHint);
  if (!brand) blockers.push('missing_brand');

  if (!resolvePrimaryImage(detail)) blockers.push('missing_primary_image');

  // Advisory pages check: suggestedPages + accepted page proposals WITHOUT
  // workspace verified-import resolution — may over-report ready; the
  // server gate corrects via rejection codes.
  const acceptedPageProposals = (curation?.classificationProposals ?? []).filter(
    (p) => p.proposalType === 'category_page' && p.status === 'accepted',
  ).length;
  const pageCount = (curation?.suggestedPages ?? []).length + acceptedPageProposals;
  if (pageCount < 1) blockers.push('missing_pages');

  if (!trimOrNull(curation?.curatedDescription)) warnings.push('description_empty');
  if (!trimOrNull(curation?.searchKeywords)) warnings.push('keywords_empty');
  if (!trimOrNull(curation?.curatedWeight)) warnings.push('weight_missing');

  // Issue #106: advisory naming warnings from the shared pure assessment
  // (server snapshot stays authoritative; this never blocks here).
  try {
    const extRec = (extraction ?? {}) as Record<string, unknown>;
    const attrs = extRec.variantAttributes;
    const attrRec = attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : null;
    const tokens: NamingMeasurementToken[] = [];
    if (attrRec) {
      for (const [axis, value] of Object.entries(attrRec)) {
        if (typeof value !== 'string' || !value.trim()) continue;
        const lowered = axis.trim().toLowerCase();
        if (lowered === 'color' || lowered === 'flavor' || lowered === 'formula') continue;
        tokens.push({
          axis: axis.trim(),
          value: value.trim(),
          conflicted: lowered === 'capacity' && !isProductCapacity(value),
        });
      }
    }
    const advWeight = trimOrNull((curation as Record<string, unknown> | null)?.curatedWeight)
      ?? (typeof extRec.weight === 'string' ? trimOrNull(extRec.weight) : null);
    if (advWeight && /[a-z]/i.test(advWeight)) tokens.push({ axis: 'weight', value: advWeight });
    if (tokens.length === 0 && effectiveName) {
      for (const embedded of extractProtectedTokens(effectiveName)) {
        tokens.push({ axis: classifyTitleEmbeddedToken(embedded), value: embedded });
      }
    }
    const structuredColors = [
      attrRec && typeof attrRec.color === 'string' ? (attrRec.color as string) : null,
      typeof extRec.color === 'string' ? (extRec.color as string) : null,
    ].filter((c): c is string => !!c?.trim());
    const advisory = assessNamingInvariants({
      title: effectiveName,
      brand,
      brandEvidence: brand ? 'present' : 'absent',
      measurementTokens: tokens,
      measurementApplicable: true,
      ownColor: structuredColors[0] ?? null,
      familyColors: knownColorsAcross(structuredColors),
      siblingTitles: [],
    });
    for (const finding of advisory.findings) {
      if (finding.code === 'missing_size' && !warnings.includes('missing_size')) warnings.push('missing_size');
      if (finding.code === 'missing_color' && !warnings.includes('missing_color')) warnings.push('missing_color');
    }
  } catch {
    // Advisory assessment never breaks the readiness view.
  }

  const proposals = curation?.classificationProposals ?? [];
  const decisions = curation?.classificationDecisions ?? [];
  if (proposals.some((p) => p.status === 'pending' && !decisions.some((d) => d.proposalId === p.id))) {
    warnings.push('pending_proposals');
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    notes,
    authoritative: false,
  };
}

/**
 * Merge structured blocker codes from a review-complete rejection into the
 * live view (stale-snapshot correction). The server always wins: merged
 * results are marked authoritative and never "ready".
 */
export function applyServerBlockers(
  readiness: ReviewReadiness,
  serverBlockers: string[],
): ReviewReadiness {
  const merged = new Set<string>([...readiness.blockers, ...serverBlockers]);
  const blockers = [...merged].filter(isBlockerCode);
  // Server codes are authoritative: warnings stay, but "ready" now reflects
  // the merged blocker set (stale advisory snapshots can never mask a block).
  return {
    ...readiness,
    blockers,
    ready: blockers.length === 0,
    authoritative: true,
  };
}

/**
 * Extract structured blocker codes from a rejected review-complete call.
 * Reads the additive `failures` payload carried on `OnboardingApiError`
 * (additive client API change); falls back to parsing the human message.
 */
export function parseBlockersFromRejection(err: unknown, itemId?: string): string[] {
  const payload = (err as OnboardingApiError & { payload?: unknown })?.payload as
    | { failures?: Array<{ itemId?: string; blockers?: string[] }> }
    | undefined;
  const failures = Array.isArray(payload?.failures) ? payload!.failures : [];
  const collected = new Set<string>();
  for (const failure of failures) {
    if (itemId && failure.itemId && failure.itemId !== itemId) continue;
    for (const code of failure.blockers ?? []) collected.add(code);
  }
  if (collected.size > 0) return [...collected];

  // Message fallback (single-item rejections): "Missing mandatory fields: a, b".
  const message = err instanceof Error ? err.message : String(err);
  const marker = 'Missing mandatory fields:';
  const idx = message.indexOf(marker);
  if (idx >= 0) {
    return message
      .slice(idx + marker.length)
      .split(',')
      .map((part) => part.trim())
      .filter((code) => code.length > 0);
  }
  return [];
}

// ─── Gate-code presentation text ───────────────────────────────────────────────

const BLOCKER_TEXT: Record<ReviewCompletenessBlockerCode, string> = {
  missing_name: 'Name is empty',
  missing_price: 'Price is empty',
  missing_brand: 'Brand is missing',
  missing_primary_image: 'No primary image',
  missing_pages: 'No verified Catalog Page assignment',
  duplicate_filename: 'File name is owned by another product',
};

const WARNING_TEXT: Record<ReviewCompletenessWarningCode, string> = {
  name_from_fallback_source:
    'Curated name is empty — promotion would use an unreviewed source title',
  description_empty: 'Description is empty',
  keywords_empty: 'Search keywords are empty',
  weight_missing: 'Weight is missing',
  pending_proposals: 'Classification proposals await decisions',
  unverified_accepted_pages:
    'Accepted page assignments are not verified against the current catalog import',
  missing_size: 'Size/capacity is missing from the draft name',
  missing_color: 'Color is missing from the draft name',
}

/** Human text naming the field for any gate/warning code (SC 3.3.1). */
export function gateText(code: ReviewCompletenessBlockerCode | ReviewCompletenessWarningCode | string): string {
  if (code in BLOCKER_TEXT) return BLOCKER_TEXT[code as ReviewCompletenessBlockerCode];
  if (code in WARNING_TEXT) return WARNING_TEXT[code as ReviewCompletenessWarningCode];
  return code;
}

// ─── Jump-to-fix targets ───────────────────────────────────────────────────────

/**
 * DOM ids of the field each code fixes. Edit-field targets exist only while
 * editing (jumping enters edit mode first); region targets are always present.
 */
const JUMP_TARGET_BY_CODE: Record<string, string> = {
  missing_name: 'rv-edit-title',
  name_from_fallback_source: 'rv-edit-title',
  missing_price: 'rv-edit-price',
  missing_brand: 'rv-edit-brand',
  missing_primary_image: 'rv-listing-media',
  missing_pages: 'rv-pages-panel',
  unverified_accepted_pages: 'rv-pages-panel',
  pending_proposals: 'rv-classification-panel',
  description_empty: 'rv-edit-desc',
  keywords_empty: 'rv-edit-keywords',
  weight_missing: 'rv-edit-weight',
  missing_size: 'rv-edit-title',
  missing_color: 'rv-edit-title',
};

export function jumpTargetFor(code: string): string | null {
  return JUMP_TARGET_BY_CODE[code] ?? null;
}

/**
 * Move keyboard focus to the jump target and scroll it into view
 * (WCAG 2.2 jump-to-fix: focus moves, not merely scroll). Returns whether
 * a target element was found.
 */
export function focusJumpTarget(targetId: string): boolean {
  const el = document.getElementById(targetId);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (el as HTMLElement).focus({ preventScroll: true });
  return true;
}

/**
 * DOM id of the readiness-checklist message node for one gate code. Edit
 * inputs point `aria-describedby` at these nodes when their gate code is
 * blocking (SC 3.3.1/3.3.3 error association).
 */
export function gateMessageId(code: string): string {
  return `rv-gate-msg-${code}`;
}

/**
 * Invert blockers into a jump-target → codes map for INPUT targets only
 * (`rv-edit-*`). Regions (media/classification) are not form controls and
 * get no aria-invalid wiring. Drives `aria-invalid` + `aria-describedby`
 * on the review form inputs.
 */
export function fieldBlockerCodes(blockers: string[]): Record<string, string[]> {
  const byTarget: Record<string, string[]> = {};
  for (const code of blockers) {
    const target = JUMP_TARGET_BY_CODE[code];
    if (!target || !target.startsWith('rv-edit-')) continue;
    (byTarget[target] ??= []).push(code);
  }
  return byTarget;
}

// ─── Dirty-state + confirm-step derivations ─────────────────────────────────────

/**
 * Whether the current draft differs from its seed (any keystroke counts —
 * exact comparison, no trimming: whitespace edits still invalidate durable
 * review server-side, so they must count as dirty locally too).
 */
export function isDraftDirty(seed: ReviewDraft | null, draft: ReviewDraft | null): boolean {
  if (!seed || !draft) return false;
  for (const key of Object.keys(seed) as Array<keyof ReviewDraft>) {
    if ((seed[key] ?? '') !== (draft[key] ?? '')) return true;
  }
  return false;
}

/** The five mandatory-check values as the promoter would resolve them. */
export interface EffectiveGateValues {
  name: string | null;
  price: string | null;
  brand: string | null;
  primaryImage: string | null;
  /** Verified-page count is server-resolved; client shows the assignment count. */
  pages: number;
}

export function effectiveGateValues(
  detail: ItemDetailResponse | null,
  workState?: ReviewQueueRow | OnboardingWorkState | null,
): EffectiveGateValues {
  const curation = detail?.item.curationData ?? null;
  const acceptedPageProposals = (curation?.classificationProposals ?? []).filter(
    (p) => p.proposalType === 'category_page' && p.status === 'accepted',
  ).length;
  // Price parity with resolveEffectivePromotedPrice / deriveReadiness:
  // item.price first, extraction price for official sources only.
  const distributorSource = detail?.item.sourceType === 'distributor_record';
  const extraction = detail?.extraction ?? detail?.item.extractionData ?? null;
  const price =
    trimOrNull(detail?.item.price) ??
    (distributorSource ? null : trimOrNull(extraction?.price));
  return {
    name: resolveEffectiveName(detail),
    price,
    brand: trimOrNull(workState?.brand) ?? trimOrNull(detail?.item.brandHint),
    primaryImage: resolvePrimaryImage(detail),
    pages: (curation?.suggestedPages ?? []).length + acceptedPageProposals,
  };
}

export interface GateValueDiffRow {
  field: 'Name' | 'Price' | 'Brand' | 'Primary image' | 'Catalog Pages';
  current: string;
  previous: string;
}

function render(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : '(empty)';
}

/** Rows where the effective value changed vs the session baseline. */
export function diffEffectiveValues(
  baseline: EffectiveGateValues | null,
  current: EffectiveGateValues,
): GateValueDiffRow[] {
  if (!baseline) return [];
  const rows: GateValueDiffRow[] = [];
  if (current.name !== baseline.name) rows.push({ field: 'Name', previous: render(baseline.name), current: render(current.name) });
  if (current.price !== baseline.price) rows.push({ field: 'Price', previous: render(baseline.price), current: render(current.price) });
  if (current.brand !== baseline.brand) rows.push({ field: 'Brand', previous: render(baseline.brand), current: render(current.brand) });
  if (current.primaryImage !== baseline.primaryImage)
    rows.push({ field: 'Primary image', previous: render(baseline.primaryImage), current: render(current.primaryImage) });
  if (current.pages !== baseline.pages)
    rows.push({
      field: 'Catalog Pages',
      previous: String(baseline.pages),
      current: String(current.pages),
    });
  return rows;
}
