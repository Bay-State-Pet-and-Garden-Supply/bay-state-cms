/**
 * Review-completeness gate (story e10s01, epic #review-final-gate).
 *
 * Mirrors — WITHOUT modifying — the promotion mandatory checklist in
 * src/onboarding/draft-promoter.ts (~976–996) and its field-resolution
 * chains (effective title 629/753; mapping-routed Brand resolution via
 * resolveBrandCatalogField over active attributeMappings with a
 * ProductField16 fallback; price cleanup; distributor image approvals;
 * verified-pages-only rule),
 * so an item that passes review-complete can never later fail promotion
 * on a mandatory field. The promoter keeps its own checks (defense in
 * depth); this module is the EARLY, review-time authority.
 *
 * Anti-silent-fallback contract: the effective promoted name is evaluated
 * through the exact promoter chain
 *   curationData.curatedTitle || extractionData.title || item.name
 * An empty effective name is a BLOCKER (missing_name); a non-empty
 * effective name sourced from a fallback (no reviewed curatedTitle) is a
 * WARNING (name_from_fallback_source) so the reviewer always sees what a
 * promotion would actually use.
 *
 * `evaluateReviewCompleteness` is PURE: no DB access, no I/O, no writes.
 * All DB/workspace reads happen in the `buildReviewCompletenessContext`
 * helpers below, which mirror the promoter's resolution order.
 */
import type {
  ReviewCompletenessBlockerCode,
  ReviewCompletenessWarningCode,
} from '../shared/schemas/onboarding';

// Single import surface for consumers: codes live in the shared schemas,
// but gate users can take everything from this module.
export type {
  ReviewCompletenessBlockerCode,
  ReviewCompletenessWarningCode,
} from '../shared/schemas/onboarding';
import { listVerifiedPageOptions, getProductPageAssignments, getActivePageImportHash } from '../db/repositories/page-repo';
import { getProposalsByRun } from '../db/repositories/classification-run-repo';
import { getCachedBrands, getCachedAttributeMappings } from '../db/repositories/classification-config-repo';
import { resolveBrand } from './brand-resolution';
import { resolveBrandCatalogField } from '../onboarding/draft-promoter';
import { readProductFile } from '../git/workspace-files';
import { getPageIdentityId } from '../shared/proposal-display';
import { CorrectedCategoryPageRecordSchema } from '../shared/schemas/onboarding';

export interface ReviewCompletenessContext {
  sourceType: 'official_page' | 'distributor_record';
  itemName: string | null;
  itemPrice: string | null;
  brandHint: string | null;
  /** Only the fields the promoter consumes from curation data. */
  curatedTitle?: string | null;
  curatedDescription?: string | null;
  searchKeywords?: string | null;
  curatedWeight?: string | null;
  /** Only the fields the promoter consumes from extraction data. */
  extractionData: {
    title?: string | null;
    description?: string | null;
    price?: string | null;
    weight?: string | null;
    searchKeywords?: string | null;
    primaryImage?: string | null;
    additionalImages?: string[] | null;
    distributorImageApprovals?: Array<{ imageUrl?: string | null }> | null;
  } | null;
  /** e10s04: reviewer media selection (curation_data.reviewedMedia); absent until first media save. */
  reviewedMedia?: { primaryImage?: string | null; orderedAdditional?: string[]; suppressed?: string[] } | null;
  /**
   * Mapped Brand slot value after the FULL promoter brand-resolution
   * chain (existing approved catalog value at the mapped slot →
   * resolveBrand over cached workspace brands → raw brandHint). Null
   * means the promoter's mandatory Brand check would fail.
   */
  resolvedBrandName: string | null;
  /** Undecided proposals remain in the item's active classification run. */
  hasPendingProposals: boolean;
  /**
   * Count of VERIFIED page assignments the promoter would accept (accepted
   * category_page proposals whose identity resolves into the current active
   * verified import WITH a usable display name; else the reviewer's
   * correctedCategoryPage record when it resolves into the CURRENT import;
   * else manual product_pages rows that carry a non-empty name AND a
   * verified page ID).
   */
  verifiedPageAssignmentCount: number;
  /** Accepted page proposals whose identity is NOT verified (visible skips at promotion). */
  unverifiedAcceptedPageCount: number;
}

export interface ReviewCompletenessResult {
  ready: boolean;
  blockers: ReviewCompletenessBlockerCode[];
  warnings: ReviewCompletenessWarningCode[];
  notes: string[];
}

const trimOrNull = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Effective name through the EXACT promoter chain (falsy `||`, untrimmed,
 * draft-promoter.ts:629/753), then the mandatory check applies `.trim()`
 * (draft-promoter.ts ~981). A whitespace-only curatedTitle therefore blocks,
 * byte-identical to promotion behavior.
 */
export function resolveEffectivePromotedName(ctx: ReviewCompletenessContext): string | null {
  const finalTitle =
    ctx.curatedTitle || ctx.extractionData?.title || ctx.itemName || '';
  return trimOrNull(finalTitle);
}

/**
 * Price through the promoter chain (draft-promoter.ts ~777–778):
 * item price first; extraction price for official sources only — distributor
 * drafts never receive extraction-sourced price (Amendment B M5b-2).
 */
export function resolveEffectivePromotedPrice(ctx: ReviewCompletenessContext): string | null {
  const isDistributor = ctx.sourceType === 'distributor_record';
  const rawPrice = ctx.itemPrice || (isDistributor ? null : ctx.extractionData?.price) || null;
  return rawPrice ? rawPrice.replace(/[$\s,]/g, '').trim() || null : null;
}

/**
 * Primary image + additional ordering through the promoter downloader input
 * chain (draft-promoter.ts, e10s04 amendment): the reviewer's persisted
 * `reviewedMedia` selection wins FIRST, then falls back to the untouched
 * resolution chain. Official sources fall back to extraction
 * primaryImage/additionalImages; distributor sources draw ONLY from the
 * rights-attested approved set (raw candidates never reach commerce), with
 * suppression removing approved URLs from consideration and a designated
 * primary honored only while it remains an approved, unsuppressed URL.
 */
export function resolveEffectiveImages(ctx: ReviewCompletenessContext): {
  primaryImage: string | null;
  additionalImages: string[];
} {
  const suppressed = new Set((ctx.reviewedMedia?.suppressed ?? []).filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  ));
  const designated = trimOrNull(ctx.reviewedMedia?.primaryImage ?? null);

  const orderedAdditional = ctx.reviewedMedia?.orderedAdditional?.filter(
    (u): u is string => typeof u === 'string' && u.length > 0 && !suppressed.has(u),
  );

  if (ctx.sourceType === 'distributor_record') {
    const approved = (ctx.extractionData?.distributorImageApprovals ?? [])
      .map((a) => a.imageUrl)
      .filter((u): u is string => typeof u === 'string' && u.length > 0 && !suppressed.has(u));
    const primary = designated && (approved.includes(designated) || !approved.length) && !suppressed.has(designated)
      ? designated
      : (approved[0] ?? (designated && !suppressed.has(designated) ? designated : null));
    const additionalImages = (ctx.reviewedMedia?.orderedAdditional && ctx.reviewedMedia.orderedAdditional.length > 0)
      ? (orderedAdditional ?? [])
      : approved.filter((u) => u !== primary);
    return { primaryImage: primary, additionalImages: additionalImages.filter((u) => u !== primary) };
  }

  const fallbackAdditional = (ctx.extractionData?.additionalImages ?? []).filter(
    (u): u is string => typeof u === 'string' && u.length > 0 && !suppressed.has(u),
  );
  // Suppression removes a URL from consideration ENTIRELY (OVERWRITE
  // semantics): neither a designated primary nor the extraction fallback may
  // resolve to a suppressed URL — otherwise hiding the current primary would
  // still promote it (anti-silent-fallback contract).
  const designatedPrimary =
    designated && !suppressed.has(designated) ? designated : null;
  const extractionPrimary = trimOrNull(ctx.extractionData?.primaryImage ?? null);
  const fallbackPrimary =
    extractionPrimary && !suppressed.has(extractionPrimary) ? extractionPrimary : null;
  const primary = designatedPrimary ?? fallbackPrimary;
  const additionalSource = (orderedAdditional && orderedAdditional.length > 0)
    ? orderedAdditional
    : fallbackAdditional;
  return { primaryImage: primary, additionalImages: additionalSource.filter((u) => u !== primary) };
}

/**
 * Primary-image candidate through the promoter downloader input chain:
 * reviewer-reviewed selection first (e10s04), then official → extraction
 * primaryImage; distributor → FIRST rights-attested approved image URL only
 * (raw candidates never reach commerce).
 */
export function resolveEffectivePrimaryImage(ctx: ReviewCompletenessContext): string | null {
  return resolveEffectiveImages(ctx).primaryImage;
}

/**
 * PURE evaluator. Deterministic; no DB access. Blocker codes map 1:1 onto
 * the promoter's mandatory checklist entries (Name / Price / Brand /
 * Primary Image / Pages); warnings are non-blocking review-quality signals.
 *
 * Warning semantics (documented contract):
 * - name_from_fallback_source: effective promoted name exists but the
 *   curated title contributed nothing to it (fallback would be promoted).
 * - description_empty / keywords_empty / weight_missing: the CURATED field
 *   is empty — even when promotion has an extraction fallback, the reviewer
 *   must see that the reviewed value is absent.
 * - pending_proposals / unverified_accepted_pages: run-state signals that
 *   promotion treats as skips or auto-accepts.
 */
export function evaluateReviewCompleteness(ctx: ReviewCompletenessContext): ReviewCompletenessResult {
  const blockers: ReviewCompletenessBlockerCode[] = [];
  const warnings: ReviewCompletenessWarningCode[] = [];
  const notes: string[] = [];

  // 1. Name (promoter mandatory check #1)
  const effectiveName = resolveEffectivePromotedName(ctx);
  if (!effectiveName) {
    blockers.push('missing_name');
  } else if (!trimOrNull(ctx.curatedTitle)) {
    // Non-empty effective name, but sourced from extraction title or the
    // imported spreadsheet name — never silently promote an unreviewed
    // fallback: surface it loudly instead.
    warnings.push('name_from_fallback_source');
  }

  // 2. Price (promoter mandatory check #2). EXACT promoter mirror
  // (draft-promoter.ts ~777 + ~979): item.price is the ONLY distributor
  // price authority (extraction price is ignored for distributor sources),
  // and its emptiness fails promotion for EVERY source type. A missing
  // item price therefore blocks review completion here too — never a
  // silent pass-now/fail-at-promotion dead end. The reviewer fixes it by
  // editing the item price (editable for both source types per the e10s02
  // matrix adjudication; nothing upstream forces distributor price null).
  const effectivePrice = resolveEffectivePromotedPrice(ctx);
  if (!effectivePrice) {
    blockers.push('missing_price');
  }

  // 3. Brand (promoter mandatory check #3 — mapped Brand slot)
  if (!trimOrNull(ctx.resolvedBrandName)) {
    blockers.push('missing_brand');
  }

  // 4. Primary image (promoter mandatory check #4)
  if (!resolveEffectivePrimaryImage(ctx)) {
    blockers.push('missing_primary_image');
  }

  // 5. Pages (promoter mandatory check #5): only VERIFIED assignments count.
  if (ctx.verifiedPageAssignmentCount < 1) {
    blockers.push('missing_pages');
  }
  if (ctx.unverifiedAcceptedPageCount > 0) {
    warnings.push('unverified_accepted_pages');
  }

  // Curated-field quality warnings (see contract above).
  if (!trimOrNull(ctx.curatedDescription)) warnings.push('description_empty');
  if (!trimOrNull(ctx.searchKeywords)) warnings.push('keywords_empty');
  if (!trimOrNull(ctx.curatedWeight)) warnings.push('weight_missing');

  if (ctx.hasPendingProposals) warnings.push('pending_proposals');

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    notes,
  };
}

// ─── Context builders (server-side reads; mirror promoter resolution order) ──

export interface ReviewCompletenessItemLike {
  id: string;
  upc: string;
  name: string | null;
  price: string | null;
  brandHint: string | null;
  sourceType: 'official_page' | 'distributor_record' | string;
  curationData: Record<string, unknown> | null;
  extractionData: Record<string, unknown> | null;
}

/**
 * Verified/unverified accepted page counts mirroring the promoter's
 * resolution order (draft-promoter.ts ~847–927): accepted category_page
 * proposals count as verified only when their identity resolves into the
 * CURRENT active verified import AND the verified catalog supplies a usable
 * display name (draft-promoter.ts:903–912 skips verified IDs with empty
 * names); the reviewer's `correctedCategoryPage` record is consulted ONLY
 * when no verified proposal page exists, and qualifies ONLY under the same
 * fail-closed rule the review-completion gate applies to abstention
 * corrections (review-completion-gate.ts:470–505): schema-valid record, hash
 * equal to the ACTIVE page-import source hash, Page ID inside the CURRENT
 * verified import, with a usable display name. Manual product_pages rows are
 * consulted last, and only rows with a non-empty name qualify
 * (draft-promoter.ts:919 `if (p.pageName)`). Unverified accepted proposals
 * are counted separately as visible-skip context — they NEVER satisfy the
 * gate.
 *
 * Post-review fix (blind review F1): without the correction-record path, an
 * item whose only Review-UI page edit is a `correctedCategoryPage` (the exact
 * field `handleUpdatePages` writes) could never clear `missing_pages` — the
 * reviewer's fix action had no effect on the gate.
 */
function classificationRunIdOf(item: ReviewCompletenessItemLike): string | null {
  return typeof item.curationData?.classificationRunId === 'string'
    ? item.curationData.classificationRunId
    : null;
}

export function countReviewPageAssignments(
  item: ReviewCompletenessItemLike,
  workspaceId: string,
): { verifiedPageAssignmentCount: number; unverifiedAcceptedPageCount: number } {
  const verifiedOptions = listVerifiedPageOptions(workspaceId);
  const verifiedIds = new Set(verifiedOptions.map((page) => page.id));
  const verifiedNameById = new Map(verifiedOptions.map((page) => [page.id, page.name]));
  let verified = 0;
  let unverifiedAccepted = 0;

  const runId = classificationRunIdOf(item);
  if (runId) {
    try {
      const proposals = getProposalsByRun(runId).filter(
        (p) => p.proposalType === 'category_page' && p.status === 'accepted',
      );
      for (const proposal of proposals) {
        const pageId = getPageIdentityId(proposal);
        // Display-name authority is the verified catalog (draft-promoter.ts:
        // 903–908): a verified Page ID whose verified row lacks a usable
        // display name is skipped, never counted.
        const verifiedName = pageId ? verifiedNameById.get(pageId) : undefined;
        if (
          pageId &&
          verifiedIds.has(pageId) &&
          typeof verifiedName === 'string' &&
          verifiedName.length > 0
        ) {
          verified++;
        } else {
          unverifiedAccepted++;
        }
      }
    } catch {
      // Corrupt run payload fails open into the manual-assignment fallback
      // below; the promoter-side gate remains the final authority.
    }
  }

  if (verified === 0) {
    // Reviewer correction record (same fallback tier as manual rows): the
    // Review UI persists correctedCategoryPage via handleUpdatePages, so it
    // must be able to satisfy this gate or missing_pages becomes a dead end.
    const rawCorrection = item.curationData?.correctedCategoryPage;
    const parsedCorrection = CorrectedCategoryPageRecordSchema.safeParse(rawCorrection);
    if (parsedCorrection.success) {
      const activeImportHash = getActivePageImportHash(workspaceId);
      const correctedName =
        verifiedIds.has(parsedCorrection.data.pageId)
          ? verifiedNameById.get(parsedCorrection.data.pageId)
          : undefined;
      if (
        activeImportHash &&
        parsedCorrection.data.activePageImportHash === activeImportHash &&
        typeof correctedName === 'string' &&
        correctedName.length > 0
      ) {
        verified = 1;
      }
    }
  }

  if (verified === 0) {
    try {
      for (const assignment of getProductPageAssignments(item.upc)) {
        // Name-only manual rows are review context (draft-promoter.ts:919)
        // and never satisfy the gate.
        if (!assignment.pageName) continue;
        if (assignment.pageId && verifiedIds.has(assignment.pageId)) verified++;
      }
    } catch {
      /* ignore — same tolerance as the promoter's fallback loop */
    }
  }

  return { verifiedPageAssignmentCount: verified, unverifiedAcceptedPageCount: unverifiedAccepted };
}

/**
 * Brand resolution mirroring the promoter's pre-mandatory-check chain
 * (draft-promoter.ts ~920–951): an existing approved catalog value at the
 * MAPPED Brand slot (resolveBrandCatalogField over active
 * attributeMappings, fallback ProductField16) wins outright; otherwise
 * resolveBrand runs against cached workspace brands over brandHint →
 * effective name → item name; unresolved input falls back to the raw
 * brandHint (and to nothing when there is no hint).
 */
export function resolveReviewBrand(
  item: ReviewCompletenessItemLike,
  existingApprovedBrandField: string | null,
  effectiveName: string | null,
  brands: ReturnType<typeof getCachedBrands>,
): string | null {
  if (trimOrNull(existingApprovedBrandField)) return existingApprovedBrandField!.trim();

  // Promoter-parity note: the caller feeds the UNTRIMMED effective title
  // into this chain (draft-promoter.ts feeds raw finalTitle); trimming is
  // applied only by the mandatory checks themselves.
  const brandInput = item.brandHint || effectiveName || item.name;
  if (!brandInput) return null;

  try {
    const resolved = resolveBrand(brandInput, brands);
    if (resolved?.brandName) return resolved.brandName;
  } catch {
    // Brand cache is optional; keep the original brand hint (promoter parity).
  }
  // Promoter parity (draft-promoter.ts:967): the promoter assigns the RAW
  // hint and its mandatory `.trim()` check rejects whitespace-only hints;
  // returning the trimmed-or-null form reproduces exactly that outcome.
  return trimOrNull(item.brandHint);
}

/**
 * Assemble the full evaluation context for one onboarding item using the
 * same reads the promoter performs. `workspacePath` enables the
 * existing-approved-product lookup; `workspaceId` scopes pages/brands.
 */
export function buildReviewCompletenessContext(
  item: ReviewCompletenessItemLike,
  options: { workspaceId: string; workspacePath: string },
): ReviewCompletenessContext {
  // Explicit field picking: ExtractionDataSchema/CurationDataSchema are
  // .passthrough(), so unknown keys must never leak into the evaluator.
  const curation = item.curationData ?? {};
  const str = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  const provisionalCtx: ReviewCompletenessContext = {
    sourceType: item.sourceType === 'distributor_record' ? 'distributor_record' : 'official_page',
    itemName: item.name,
    itemPrice: item.price,
    brandHint: item.brandHint,
    curatedTitle: str(curation.curatedTitle),
    curatedDescription: str(curation.curatedDescription),
    searchKeywords: str(curation.searchKeywords),
    curatedWeight: str(curation.curatedWeight),
    reviewedMedia:
      curation.reviewedMedia && typeof curation.reviewedMedia === 'object'
        ? (curation.reviewedMedia as ReviewCompletenessContext['reviewedMedia'])
        : null,
    extractionData: (item.extractionData ?? null) as ReviewCompletenessContext['extractionData'],
    resolvedBrandName: null,
    hasPendingProposals: false,
    verifiedPageAssignmentCount: 0,
    unverifiedAcceptedPageCount: 0,
  };

  // Brand parity (draft-promoter.ts ~954/962): the promoter reads the
  // existing approved product at the MAPPED Brand slot (never a hardcoded
  // slot) and feeds the RAW, untrimmed finalTitle into its
  // brand-resolution chain — resolveEffectivePromotedName's trimmed form
  // is used ONLY for the mandatory emptiness verdict inside the evaluator.
  const rawFinalTitle =
    provisionalCtx.curatedTitle || provisionalCtx.extractionData?.title || provisionalCtx.itemName || '';

  let existingApprovedBrandField: string | null = null;
  try {
    // Same seam as the promoter (draft-promoter.ts phase-B): the slot is
    // resolved from active attributeMappings so review and promotion
    // agree even under a custom brand mapping. Mapping reads fail closed
    // to the documented fallback (ProductField16).
    let brandCatalogField = 'ProductField16';
    try {
      brandCatalogField = resolveBrandCatalogField(getCachedAttributeMappings(options.workspaceId));
    } catch {
      // Mapping cache unreadable — keep the documented fallback slot.
    }
    const existingApproved = readProductFile(options.workspacePath, item.upc);
    existingApprovedBrandField =
      str(existingApproved?.customFields?.[brandCatalogField]);
  } catch {
    // No readable approved product file — identical to the promoter's
    // `existingApproved` being undefined.
  }

  let brands: ReturnType<typeof getCachedBrands> = [];
  try {
    brands = getCachedBrands(options.workspaceId);
  } catch {
    // Optional cache; resolver falls back to the raw hint (promoter parity).
  }

  const pages = countReviewPageAssignments(item, options.workspaceId);

  let hasPendingProposals = false;
  const runId = classificationRunIdOf(item);
  if (runId) {
    try {
      hasPendingProposals = getProposalsByRun(runId).some((p) => p.status === 'pending');
    } catch {
      /* treat as decided; the run decision gate reports corruption separately */
    }
  }

  return {
    ...provisionalCtx,
    resolvedBrandName: resolveReviewBrand(item, existingApprovedBrandField, rawFinalTitle, brands),
    hasPendingProposals,
    verifiedPageAssignmentCount: pages.verifiedPageAssignmentCount,
    unverifiedAcceptedPageCount: pages.unverifiedAcceptedPageCount,
  };
}
