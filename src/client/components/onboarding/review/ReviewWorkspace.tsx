/**
 * Epic #46 — Rapid Review workspace (Phase 6).
 *
 * Batch Workspace tab: the primary human QA surface. Every Curation-complete
 * product must be reviewed before approval. Dense queue (left) + persistent
 * inspector (right); `Looks Good & Next` marks the product durably reviewed
 * and immediately opens the next unreviewed product — hundreds of items
 * without returning to the board.
 *
 * Milestone 1 (P1-C): Bounded Rapid Review Loading.
 * Uses `useReviewQueue` for cursor-paginated lightweight `ReviewQueueRow` loading,
 * and `useReviewDetailCache` for bounded LRU detail fetching (max 5 items,
 * active + adjacent prefetching only).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeBatchEvents } from '../../../onboarding-work-api';
import {
  completeReviewStage,
  moveToPreviousStage,
  submitDecisions,
  updateItem,
  updateItemMedia,
} from '../../../onboarding-api';
import type { ClassificationProposal } from '../../../../shared/schemas/classification';
import {
  activeFilterChips,
  applyQueueFilters,
  countActiveQueueFilters,
  distinctBrands,
  distinctFamilies,
  findNextQueuedItem,
  findNextReviewTarget,
  findPreviousReviewTarget,
  formatReviewProgress,
  hasActiveQueueFilters,
  removeFilterChip,
  countGateBlockedItems,
  buildLegacyListingUpdatePayload,
  pruneQueueSelection,
  reviewProgress,
  reviewableSelectionIds,
  selectAllVisible,
  sortForReview,
  toggleGroupSelection,
  toggleQueueSelection,
  type ReviewQueueFilters,
} from './review-logic';
import type { ReviewDraft, ReviewInspectorItem } from './review-types';
import type { SourceType, ReviewCompletenessWarningCode, MediaSelectionRequest } from '../../../../shared/schemas/onboarding';
import { getOnboardingFeatureFlags } from '../../../onboarding-feature-flags';
import { buildListingUpdatePayload } from './review-editability';
import {
  applyServerBlockers,
  deriveReadiness,
  diffEffectiveValues,
  effectiveGateValues,
  fieldBlockerCodes,
  focusJumpTarget,
  isDraftDirty,
  jumpTargetFor,
  parseBlockersFromRejection,
  type EffectiveGateValues,
  type GateValueDiffRow,
} from './review-readiness';
import { useReviewQueue } from './use-review-queue';
import { useReviewDetailCache } from './use-review-detail-cache';
import { useFilenamePreview, warnedPreviewIds } from './use-filename-preview';
import type { BatchFilenamePreviewItem } from '../../../onboarding-work-api';
import { ReviewQueue } from './ReviewQueue';
import { ReviewIdentityPanel } from './ReviewIdentityPanel';
import { ReviewPagesPanel } from './ReviewPagesPanel';
import { ReviewListingPanel } from './ReviewListingPanel';
import { ReviewClassificationPanel } from './ReviewClassificationPanel';
import { ReviewWarningsPanel } from './ReviewWarningsPanel';
import { ReviewReadinessPanel } from './ReviewReadinessPanel';
import { ReviewConfirmStep, shouldOpenConfirmStep } from './ReviewConfirmStep';
import { ReviewActions } from './ReviewActions';
import './review.css';

const REFRESH_DEBOUNCE_MS = 900;

export interface ReviewWorkspaceProps {
  batchId: string;
}

export function ReviewWorkspace({ batchId }: ReviewWorkspaceProps) {
  // ── Filters / facets ────────────────────────────────────────────────────
  const [filters, setFilters] = useState<ReviewQueueFilters>({});

  // ── Bulk review selection (epic #46 follow-up, phase 4) ─────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // ── Session tracking ────────────────────────────────────────────────────
  const [editedIds, setEditedIds] = useState<Set<string>>(() => new Set());
  const [warnedIds, setWarnedIds] = useState<Set<string>>(() => new Set());
  const [optimisticReviewed, setOptimisticReviewed] = useState(0);

  // ── Current inspector item ──────────────────────────────────────────────
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);

  // ── Actions ─────────────────────────────────────────────────────────────
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(() => new Set());
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [allReviewed, setAllReviewed] = useState(false);

  // ── Editing state ───────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── V2 review surface state (e10s02/e10s03; inert while flag off) ──────
  const v2 = useMemo(() => getOnboardingFeatureFlags().reviewUiV2, []);
  /** Pre-edit seed of the active draft — dirty detection base. */
  const draftSeedRef = useRef<ReviewDraft | null>(null);
  /** First-edit effective gate values per item id (confirm-step baseline). */
  const baselineRef = useRef<Map<string, EffectiveGateValues>>(new Map());
  /** Structured blocker codes from a rejected review-complete call. */
  const [rejectedBlockers, setRejectedBlockers] = useState<string[] | null>(null);
  /** Pending confirm-step diff (open ⇒ modal visible). */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<GateValueDiffRow[]>([]);
  const [confirmWarnings, setConfirmWarnings] = useState<ReviewCompletenessWarningCode[]>([]);

  // ── Lightbox ────────────────────────────────────────────────────────────
  const [lightbox, setLightbox] = useState<{ url: string; caption: string } | null>(null);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneIds = useRef<Set<string>>(new Set());
  const keyboardNavRef = useRef(false);

  // ── Cursor-Paginated Queue Loading (Milestone 1 / P1-C) ─────────────────
  const {
    rows,
    counts,
    hasMore,
    loading: queueLoading,
    loadingMore,
    error: queueError,
    loadQueue,
    loadMore,
    optimisticUpdateRow,
    optimisticRemoveRow,
  } = useReviewQueue({ batchId, filters, pageSize: 50 });

  // ── Derived filtered & sorted queue ─────────────────────────────────────
  const sortedAll = useMemo(() => sortForReview(rows), [rows]);
  const filteredItems = useMemo(
    () => applyQueueFilters(sortedAll, filters, { editedIds, warnedIds }),
    [sortedAll, filters, editedIds, warnedIds],
  );

  // ── Filename preview (issue #109): computed names + collision warnings ─
  // Fetched once per batch; refreshed on explicit mutation events only.
  const filenamePreview = useFilenamePreview(batchId);
  // Stable refresh handle: the hook return object reshapes every render.
  const refreshFilenamePreview = filenamePreview.refresh;

  // Warned queue ids follow the preview (drives the ⚠ badge + warnings filter).
  useEffect(() => {
    setWarnedIds(warnedPreviewIds(filenamePreview.byId));
  }, [filenamePreview.byId]);

  // ── Bounded LRU Detail Cache with Active + Adjacent Prefetch (P1-C) ─────
  const {
    details,
    detailErrors,
    invalidateItem,
  } = useReviewDetailCache({
    batchId,
    selectedItemId: currentItemId,
    visibleRows: filteredItems,
    maxCacheSize: 5,
  });

  // Keyboard focus follow: after an arrow-key selection, move DOM focus to the
  // active queue row so the focus ring and screen-reader position track it.
  useEffect(() => {
    if (!keyboardNavRef.current || !currentItemId) return;
    keyboardNavRef.current = false;
    document.getElementById(currentItemId)?.focus();
  }, [currentItemId]);

  // Reset local state on batch change
  useEffect(() => {
    setCurrentItemId(null);
    setEditedIds(new Set());
    setWarnedIds(new Set());
    setEditing(false);
    setDraft(null);
    setAllReviewed(false);
    setOptimisticReviewed(0);
    doneIds.current = new Set<string>();
  }, [batchId]);

  // Auto-select the first unreviewed item once queue is loaded
  useEffect(() => {
    if (queueLoading || currentItemId) return;
    if (sortedAll.length === 0) {
      setAllReviewed(false);
      return;
    }
    const target = findNextReviewTarget(sortedAll, null, doneIds.current);
    if (target) setCurrentItemId(target.itemId);
    else setAllReviewed(true);
  }, [queueLoading, sortedAll, currentItemId]);

  // SSE-driven refresh (debounced) — counts + queue stay live without killing dirty draft
  useEffect(() => {
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadQueue({ silent: true });
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [batchId, loadQueue]);

  // Dirty-draft guard
  const draftDirty = v2 && editing && isDraftDirty(draftSeedRef.current, draft);
  useEffect(() => {
    if (!draftDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draftDirty]);

  // Immediate detail reset for inspector state when current item changes
  useEffect(() => {
    if (!currentItemId) {
      setEditing(false);
      setDraft(null);
      draftSeedRef.current = null;
      return;
    }
    setRejectedBlockers(null);
    setConfirmOpen(false);
    setPendingDiff([]);
    setActionError(null);
  }, [currentItemId]);

  // Prune the bulk-review selection whenever the queue reloads.
  useEffect(() => {
    setSelectedIds(prev => pruneQueueSelection(prev, rows.map(i => i.itemId)));
  }, [rows]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const reviewableSelectedIds = useMemo(
    () => reviewableSelectionIds(selectedIds, filteredItems),
    [selectedIds, filteredItems],
  );
  const reviewableSelected = reviewableSelectedIds.length;

  // Issue #109: bulk review can never silently sweep filename-warned items
  // (bulk carries no per-item decisions) — resolve them individually first.
  const bulkFilenameWarnedIds = useMemo(
    () => reviewableSelectedIds.filter(id => warnedIds.has(id)),
    [reviewableSelectedIds, warnedIds],
  );

  const handleBulkReview = useCallback(async () => {
    if (reviewableSelectedIds.length === 0 || bulkBusy) return;
    if (bulkFilenameWarnedIds.length > 0) {
      setBulkError(
        `${bulkFilenameWarnedIds.length} selected product${bulkFilenameWarnedIds.length === 1 ? ' has' : 's have'} a file-name warning — accept or defer each one individually before bulk review.`,
      );
      setBulkConfirmOpen(false);
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    setBulkNotice(null);
    try {
      const res = await completeReviewStage(reviewableSelectedIds);
      setBulkNotice(
        `${res.count} product${res.count === 1 ? '' : 's'} marked reviewed` +
          (res.classifiedCount !== undefined && res.legacyCount !== undefined
            ? ` (${res.classifiedCount} classified, ${res.legacyCount} legacy)`
            : ''),
      );
      setSelectedIds([]);
      await loadQueue();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
      setBulkConfirmOpen(false);
    }
  }, [reviewableSelectedIds, bulkBusy, bulkFilenameWarnedIds, loadQueue]);

  const totalCount = counts ? counts.total : rows.length;
  const reviewedCount = counts
    ? counts.reviewedTotal + optimisticReviewed
    : rows.filter(r => r.reviewState === 'reviewed' || r.reviewState === 'approved').length;

  const progress = useMemo(() => {
    return reviewProgress(rows, { total: totalCount, reviewedTotal: reviewedCount });
  }, [rows, totalCount, reviewedCount]);

  const currentWorkState = useMemo(
    () => (currentItemId ? rows.find(i => i.itemId === currentItemId) ?? null : null),
    [rows, currentItemId],
  );

  // ── Filename preview for the inspected item (issue #109) ──────────────
  const currentPreview: BatchFilenamePreviewItem | null = useMemo(
    () => (currentItemId ? filenamePreview.byId.get(currentItemId) ?? null : null),
    [filenamePreview.byId, currentItemId],
  );
  const currentFilenameWarnings = currentPreview?.warnings ?? [];
  const currentHasCatalogCollision = currentFilenameWarnings.some(
    w => w.code === 'filename_collision_catalog',
  );
  const currentIsFilenameWarned = currentFilenameWarnings.length > 0;

  const currentInspector: ReviewInspectorItem | null = useMemo(() => {
    if (!currentWorkState) return null;
    return {
      workState: currentWorkState,
      detail: details.get(currentWorkState.itemId) ?? null,
      detailError: detailErrors.get(currentWorkState.itemId) ?? null,
    };
  }, [currentWorkState, details, detailErrors]);

  const readiness = useMemo(
    () =>
      v2 && currentInspector
        ? deriveReadiness(currentInspector.detail, currentInspector.workState)
        : null,
    [v2, currentInspector],
  );
  const mergedReadiness = useMemo(() => {
    if (!v2 || !readiness) return null;
    return rejectedBlockers ? applyServerBlockers(readiness, rejectedBlockers) : readiness;
  }, [v2, readiness, rejectedBlockers]);

  const facets = useMemo(
    () => ({ brands: distinctBrands(sortedAll), families: distinctFamilies(sortedAll) }),
    [sortedAll],
  );

  // ── Actions ──────────────────────────────────────────────────────────────
  const approveCurrentItem = useCallback(async (filenameDecision?: 'accept' | 'defer') => {
    if (!currentWorkState) return;
    const id = currentWorkState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setActionError(null);
    try {
      await completeReviewStage(
        [id],
        filenameDecision ? { filenameDecisions: { [id]: filenameDecision } } : undefined,
      );
      setRejectedBlockers(null);
      doneIds.current.add(id);
      optimisticUpdateRow(id, { reviewState: 'reviewed' });
      setOptimisticReviewed(prev => prev + 1);
      const remaining = rows.map(i => (i.itemId === id ? { ...i, reviewState: 'reviewed' as const } : i));
      const next = findNextReviewTarget(sortForReview(remaining), id, doneIds.current);
      if (next) {
        setCurrentItemId(next.itemId);
      } else {
        setAllReviewed(true);
        setCurrentItemId(null);
      }
      void loadQueue({ silent: true });
      refreshFilenamePreview();
    } catch (err) {
      const codes = v2 ? parseBlockersFromRejection(err, id) : [];
      if (codes.length > 0) {
        setRejectedBlockers(codes);
        setActionError(`Review completion rejected — mandatory checks failed: ${codes.join(', ')}.`);
      } else {
        setActionError(err instanceof Error ? err.message : 'Failed to mark item reviewed');
      }
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentWorkState, rows, optimisticUpdateRow, loadQueue, v2, refreshFilenamePreview]);

  // ── Filename-warning decisions (issue #109) ────────────────────────────
  // Warned items can never ride plain Looks-Good: Accept records the
  // decision and approves; Defer records it and moves on unreviewed.
  const handleAcceptFilename = useCallback(async () => {
    if (!currentWorkState || !currentIsFilenameWarned || currentHasCatalogCollision) return;
    await approveCurrentItem('accept');
  }, [currentWorkState, currentIsFilenameWarned, currentHasCatalogCollision, approveCurrentItem]);

  const handleDeferFilename = useCallback(async () => {
    if (!currentWorkState || !currentIsFilenameWarned) return;
    const id = currentWorkState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setActionError(null);
    try {
      await completeReviewStage([id], { filenameDecisions: { [id]: 'defer' } });
      setRejectedBlockers(null);
      const next = findNextReviewTarget(sortForReview(rows), id, doneIds.current);
      if (next) {
        setCurrentItemId(next.itemId);
      } else {
        setCurrentItemId(null);
      }
      void loadQueue({ silent: true });
      refreshFilenamePreview();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to defer item');
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentWorkState, currentIsFilenameWarned, rows, loadQueue, refreshFilenamePreview]);

  const beginEdit = useCallback(() => {
    if (!currentInspector) return;
    const id = currentInspector.workState.itemId;
    const item = currentInspector.detail?.item;
    const cur = item?.curationData as Record<string, unknown> | undefined;
    const ext = currentInspector.detail?.extraction ?? item?.extractionData ?? null;
    const seed: ReviewDraft = {
      curatedTitle:
        cur?.curatedTitle ??
        ('curatedTitle' in currentInspector.workState ? (currentInspector.workState as any).curatedTitle : null) ??
        ext?.title ??
        (('displayTitle' in currentInspector.workState) ? currentInspector.workState.displayTitle : currentInspector.workState.name) ??
        '',
      brandHint: currentInspector.workState.brand ?? item?.brandHint ?? ext?.brand ?? '',
      curatedWeight:
        (cur?.curatedWeight as string) ??
        (('weight' in currentInspector.workState ? (currentInspector.workState as any).weight : null) ?? ''),
      curatedDescription:
        (cur?.curatedDescription as string) ??
        ('description' in currentInspector.workState ? (currentInspector.workState as any).description : null) ??
        ext?.description ??
        '',
      searchKeywords: (cur?.searchKeywords as string) ?? '',
      ...(v2
        ? {
            price: (item?.price ?? ('price' in currentInspector.workState ? (currentInspector.workState as any).price : null) ?? ext?.price ?? '') as string,
            quantity: item?.quantity !== null && item?.quantity !== undefined ? String(item.quantity) : '',
          }
        : {}),
    };
    setDraft(seed);
    draftSeedRef.current = seed;
    setEditing(true);
    setSaveError(null);
    if (v2 && !baselineRef.current.has(id)) {
      baselineRef.current.set(
        id,
        effectiveGateValues(currentInspector.detail, currentInspector.workState),
      );
    }
  }, [currentInspector, v2]);

  const attemptCancelEdit = useCallback((): boolean => {
    if (!v2 || !editing) {
      setEditing(false);
      setDraft(null);
      draftSeedRef.current = null;
      setSaveError(null);
      return true;
    }
    if (isDraftDirty(draftSeedRef.current, draft)) {
      const ok = window.confirm('Discard unsaved listing changes for this product?');
      if (!ok) return false;
    }
    setEditing(false);
    setDraft(null);
    draftSeedRef.current = null;
    setSaveError(null);
    return true;
  }, [v2, editing, draft]);

  const selectItem = useCallback(
    (id: string) => {
      if (id === currentItemId) return;
      if (v2 && editing && isDraftDirty(draftSeedRef.current, draft)) {
        const ok = window.confirm('Discard unsaved listing changes and open another product?');
        if (!ok) return;
      }
      setEditing(false);
      setDraft(null);
      draftSeedRef.current = null;
      setCurrentItemId(id);
    },
    [currentItemId, v2, editing, draft],
  );

  const handleLooksGood = useCallback(async () => {
    if (!currentInspector) return;
    // Issue #109: a filename-warned item can never ride plain Looks-Good
    // (keyboard shortcut included) — Accept or Defer explicitly.
    if (currentIsFilenameWarned) {
      setActionError('Filename warning needs an explicit decision — accept the suffixed name or defer this product.');
      return;
    }
    const id = currentInspector.workState.itemId;
    const baseline = baselineRef.current.get(id);
    const current = effectiveGateValues(currentInspector.detail, currentInspector.workState);
    const diff = baseline ? diffEffectiveValues(baseline, current) : [];
    if (v2 && shouldOpenConfirmStep(id, editedIds, diff)) {
      setPendingDiff(diff);
      setConfirmWarnings(readiness?.warnings ?? []);
      setConfirmOpen(true);
    } else {
      await approveCurrentItem();
    }
  }, [currentInspector, approveCurrentItem, v2, editedIds, readiness, currentIsFilenameWarned]);

  const moveTo = useCallback(
    (dir: 'next' | 'previous') => {
      const target =
        dir === 'next'
          ? findNextQueuedItem(filteredItems, currentItemId)
          : findPreviousReviewTarget(filteredItems, currentItemId);
      if (!target) return;
      selectItem(target.itemId);
    },
    [filteredItems, currentItemId, selectItem],
  );

  const handleSaveEdit = useCallback(async () => {
    if (!currentInspector || !draft) return;
    const id = currentInspector.workState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setSaveError(null);
    try {
      const sourceType: SourceType =
        currentInspector.detail?.item.sourceType === 'distributor_record'
          ? 'distributor_record'
          : ((currentInspector.workState.sourceType as SourceType) ?? 'official_page');
      await updateItem(
        id,
        v2
          ? buildListingUpdatePayload(draft, sourceType)
          : buildLegacyListingUpdatePayload(draft),
      );
      setEditedIds(prev => new Set(prev).add(id));
      setEditing(false);
      setDraft(null);
      draftSeedRef.current = null;
      invalidateItem(id);
      void loadQueue({ silent: true });
      // Retitles change filename bases — recompute the preview.
      refreshFilenamePreview();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentInspector, draft, invalidateItem, loadQueue, v2]);

  useEffect(() => {
    if (!v2 || editing || !currentInspector?.detail) return;
    beginEdit();
  }, [v2, editing, currentInspector, beginEdit]);

  const handleSaveMedia = useCallback(async (selection: MediaSelectionRequest) => {
    if (!currentInspector) return;
    const id = currentInspector.workState.itemId;
    await updateItemMedia(id, selection);
    invalidateItem(id);
    void loadQueue({ silent: true });
  }, [currentInspector, invalidateItem, loadQueue]);

  const handleDecision = useCallback(
    async (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => {
      if (!currentInspector) return;
      const id = currentInspector.workState.itemId;
      setBusyDecisionId(proposal.id);
      try {
        await submitDecisions(id, [{ proposalId: proposal.id, decision }]);
        invalidateItem(id);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [currentInspector, invalidateItem],
  );

  const handleUpdatePages = useCallback(
    async (nextPages: string[], correction?: { pageId: string; activePageImportHash: string }) => {
      if (!currentInspector) return;
      const id = currentInspector.workState.itemId;
      const curation = currentInspector.detail?.item?.curationData ?? {};
      setBusyItemIds(prev => new Set(prev).add(id));
      try {
        await updateItem(id, {
          curation_data: {
            ...curation,
            suggestedPages: nextPages,
            ...(correction
              ? {
                  correctedCategoryPage: {
                    pageId: correction.pageId,
                    activePageImportHash: correction.activePageImportHash,
                    correctedAt: new Date().toISOString(),
                  },
                }
              : {}),
          },
        });
        invalidateItem(id);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyItemIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [currentInspector, invalidateItem],
  );

  const handleSendToCuration = useCallback(async () => {
    if (!currentWorkState) return;
    if (v2 && editing && isDraftDirty(draftSeedRef.current, draft)) {
      setActionError('You have unsaved edits — click “Save edits” (or Cancel) before sending back to curation.');
      return;
    }
    const id = currentWorkState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setActionError(null);
    try {
      await moveToPreviousStage([id]);
      optimisticRemoveRow(id);
      const remaining = rows.filter(i => i.itemId !== id);
      const next = findNextReviewTarget(sortForReview(remaining), id, doneIds.current);
      if (next) {
        setCurrentItemId(next.itemId);
      } else {
        setCurrentItemId(null);
      }
      void loadQueue({ silent: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send item back to Curation');
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentWorkState, v2, editing, draft, rows, optimisticRemoveRow, loadQueue]);

  const handleBulkSendToCuration = useCallback(async () => {
    if (selectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await moveToPreviousStage(selectedIds);
      setBulkNotice(`${res.moved} item${res.moved === 1 ? '' : 's'} sent back to Curation`);
      setSelectedIds([]);
      await loadQueue();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, bulkBusy, loadQueue]);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (lightbox) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setLightbox(null);
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!workspaceRef.current?.contains(target ?? document.body)) return;
      if (editing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          attemptCancelEdit();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (currentItemId !== null) {
          e.preventDefault();
          setCurrentItemId(prev => (prev !== null ? null : prev));
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          keyboardNavRef.current = true;
          moveTo('next');
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          keyboardNavRef.current = true;
          moveTo('previous');
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          void handleLooksGood();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightbox, editing, currentItemId, attemptCancelEdit, moveTo, handleLooksGood]);

  const busy = currentItemId ? busyItemIds.has(currentItemId) : false;

  const jumpToFix = useCallback(
    (code: string) => {
      const targetId = jumpTargetFor(code);
      if (!targetId) return;
      const isFieldTarget = targetId.startsWith('rv-edit-');
      if (isFieldTarget && !editing) {
        beginEdit();
      }
      requestAnimationFrame(() => {
        focusJumpTarget(targetId);
      });
    },
    [editing, beginEdit],
  );

  /** Bulk-review gating: fail-closed safety on unknown / blocked status */
  const selectedBlockedCount = useMemo(() => {
    return countGateBlockedItems(reviewableSelectedIds, filteredItems, details);
  }, [reviewableSelectedIds, filteredItems, details]);

  const loadedCount = filteredItems.length;
  const filtersTotal = filteredItems.length;

  // Filters change → keep a valid selection.
  useEffect(() => {
    if (!currentItemId) return;
    if (filteredItems.some(i => i.itemId === currentItemId)) return;
    const target = findNextReviewTarget(filteredItems, null, doneIds.current);
    setCurrentItemId(target?.itemId ?? null);
  }, [filteredItems]);

  const queueEmptyMessage =
    queueLoading
      ? 'Loading review queue…'
      : filtersTotal === 0 && hasActiveQueueFilters(filters)
        ? 'No products match the current filters.'
        : 'Nothing to review yet — automation is still working.';

  return (
    <div className="rv-workspace" ref={workspaceRef}>
      {actionError && (
        <div role="alert" className="rv-error-banner">
          {actionError}
        </div>
      )}

      <div className="rv-body">
        <div className="rv-queue-pane">
          <QueueHeader
            filters={filters}
            onChange={setFilters}
            facets={facets}
            progress={progress}
            total={totalCount}
            shownCount={loadedCount}
          />
          {(selectedIds.length > 0 || filters.sourceType === 'distributor_record') && (
            <div className="rv-bulk-bar" role="region" aria-label="Bulk review">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={bulkBusy || filteredItems.length === 0}
                onClick={() =>
                  setSelectedIds(prev =>
                    prev.length === filteredItems.length ? [] : selectAllVisible(filteredItems.map(i => i.itemId)),
                  )
                }
              >
                {selectedIds.length === filteredItems.length && filteredItems.length > 0
                  ? 'Clear selection'
                  : `Select all shown (${filteredItems.length})`}
              </button>
              <span className="rv-bulk-count">
                {selectedIds.length} selected · {reviewableSelected} reviewable
              </span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={bulkBusy || selectedIds.length === 0}
                onClick={() => void handleBulkSendToCuration()}
                title="Send selected items back to Curation stage"
              >
                ↩ Send to Curation ({selectedIds.length})
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={bulkBusy || reviewableSelected === 0 || selectedBlockedCount > 0 || bulkFilenameWarnedIds.length > 0}
                title={
                  bulkFilenameWarnedIds.length > 0
                    ? `${bulkFilenameWarnedIds.length} selected product${bulkFilenameWarnedIds.length === 1 ? ' has' : 's have'} a file-name warning — accept or defer each one individually first`
                    : selectedBlockedCount > 0
                      ? `${selectedBlockedCount} of ${reviewableSelected} selected products are missing mandatory fields — fix or deselect them first`
                      : 'Open the confirmation for the selected products'
                }
                onClick={() => setBulkConfirmOpen(true)}
              >
                {bulkFilenameWarnedIds.length > 0
                  ? `Mark reviewed (${reviewableSelected} · ${bulkFilenameWarnedIds.length} filename-warned)`
                  : selectedBlockedCount > 0
                    ? `Mark reviewed (${reviewableSelected} · ${selectedBlockedCount} blocked)`
                    : `Mark reviewed (${reviewableSelected})`}
              </button>
            </div>
          )}
          {bulkNotice && (
            <div className="rv-bulk-notice" role="status">
              ✓ {bulkNotice}
            </div>
          )}
          {bulkError && (
            <div className="rv-error-banner" role="alert">
              {bulkError}
            </div>
          )}
          {bulkConfirmOpen && (
            <div className="rv-modal-backdrop" role="presentation" onMouseDown={() => setBulkConfirmOpen(false)}>
              <div
                className="rv-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Confirm bulk review"
                onMouseDown={e => e.stopPropagation()}
              >
                <h3 className="rv-modal-title">Mark {reviewableSelected} product{reviewableSelected === 1 ? '' : 's'} reviewed?</h3>
                <p className="rv-modal-body">
                  These products will be durably marked reviewed and moved to the approval
                  queue. Approving never exports anything — export stays a separate step.
                </p>
                <div className="rv-modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setBulkConfirmOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={bulkBusy}
                    onClick={() => void handleBulkReview()}
                  >
                    {bulkBusy ? 'Reviewing…' : `Mark reviewed (${reviewableSelected})`}
                  </button>
                </div>
              </div>
            </div>
          )}
          {queueError ? (
            <div className="rv-state-note" role="alert">
              Could not load the review queue: {queueError}
            </div>
          ) : (
            <ReviewQueue
              items={filteredItems}
              currentItemId={currentItemId}
              details={details}
              warnedIds={warnedIds}
              editedIds={editedIds}
              selectedIds={selectedSet}
              onToggleSelected={itemId =>
                setSelectedIds(prev => toggleQueueSelection(prev, itemId))
              }
              onToggleFamilySelected={itemIds =>
                setSelectedIds(prev => toggleGroupSelection(prev, itemIds))
              }
              emptyMessage={queueEmptyMessage}
              onSelect={selectItem}
            />
          )}
          {hasMore && (
            <div className="rv-load-more">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore
                  ? 'Loading more…'
                  : `Load more (${rows.length} of ${totalCount} shown)`}
              </button>
            </div>
          )}
        </div>

        <div className="rv-inspector-pane" tabIndex={-1} aria-label="Review inspector">
          {currentInspector ? (
            <div className="rv-inspector-inner">
              {currentInspector.detailError && (
                <div className="rv-error-banner" role="alert">
                  Detail could not be loaded: {currentInspector.detailError}
                </div>
              )}
              <ReviewIdentityPanel workState={currentInspector.workState} detail={currentInspector.detail} fileName={currentPreview?.fileName ?? null} />
              <ReviewListingPanel
                workState={currentInspector.workState}
                detail={currentInspector.detail}
                editing={editing}
                draft={draft ?? { curatedTitle: '', brandHint: '', curatedWeight: '', curatedDescription: '', searchKeywords: '' }}
                onDraftChange={setDraft}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => {
                  attemptCancelEdit();
                }}
                showSaveActions={!v2 || draftDirty}
                saving={busy}
                savingMedia={busy}
                saveError={saveError}
                onOpenLightbox={(url, caption) => setLightbox({ url, caption })}
                v2={v2}
                onSaveMedia={v2 ? handleSaveMedia : undefined}
                blockedCodesByField={
                  v2 && mergedReadiness ? fieldBlockerCodes(mergedReadiness.blockers) : undefined
                }
              />
              <ReviewPagesPanel
                detail={currentInspector.detail}
                onUpdatePages={handleUpdatePages}
              />
              <ReviewClassificationPanel
                detail={currentInspector.detail}
                onDecision={handleDecision}
                busyDecisionId={busyDecisionId}
              />
              <ReviewWarningsPanel detail={currentInspector.detail} filenameWarnings={currentFilenameWarnings} filenameResolutions={currentPreview?.allowedResolutions} />
              {v2 && (
                <ReviewReadinessPanel
                  detail={currentInspector.detail}
                  workState={currentInspector.workState}
                  readiness={mergedReadiness ?? undefined}
                  onJumpRequest={jumpToFix}
                />
              )}
              <ReviewActions
                workState={currentInspector.workState}
                detail={currentInspector.detail}
                busy={busy}
                editing={editing}
                allReviewed={allReviewed}
                shortcutKey="G"
                blockers={v2 ? mergedReadiness?.blockers : undefined}
                filenameWarned={currentIsFilenameWarned}
                filenameAcceptable={currentIsFilenameWarned && !currentHasCatalogCollision}
                onAcceptFilename={() => void handleAcceptFilename()}
                onDeferFilename={() => void handleDeferFilename()}
                onLooksGood={() => void handleLooksGood()}
                onPrevious={() => moveTo('previous')}
                onNext={() => moveTo('next')}
                onToggleEdit={v2 ? undefined : () => (editing ? attemptCancelEdit() : beginEdit())}
                onSendToCuration={() => void handleSendToCuration()}
              />
            </div>
          ) : (
            <div className="rv-state-note">
              {allReviewed
                ? 'All products reviewed — ready for bulk approval in the Approved tab.'
                : 'Select a product from the queue to inspect it.'}
            </div>
          )}
        </div>
      </div>

      <KeyboardLegend />

      {lightbox && (
        <Lightbox url={lightbox.url} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      )}

      {v2 && (
        <ReviewConfirmStep
          open={confirmOpen}
          diffRows={pendingDiff}
          warnings={confirmWarnings}
          busy={busy}
          onApprove={() => {
            setConfirmOpen(false);
            void approveCurrentItem();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Queue header + progress --------------------------------------------------

function QueueHeader({
  filters,
  onChange,
  facets,
  progress,
  total,
  shownCount,
}: {
  filters: ReviewQueueFilters;
  onChange: (f: ReviewQueueFilters) => void;
  facets: { brands: string[]; families: { cohortId: string; label: string }[] };
  progress: ReturnType<typeof reviewProgress>;
  total: number;
  shownCount: number;
}) {
  const pct = progress.total > 0 ? Math.round((progress.reviewedCount / progress.total) * 100) : 0;

  return (
    <div className="rv-queue-header">
      <div className="rv-queue-header-top">
        <div className="rv-progress" role="status" aria-label="Review progress">
          <span className="rv-progress-main">{formatReviewProgress(progress)}</span>
          <span className="rv-progress-sub">
            {progress.remaining} remaining
            {total > shownCount ? ` · showing ${shownCount}` : ''}
          </span>
        </div>

        <FilterControls filters={filters} onChange={onChange} facets={facets} />
      </div>
      <div className="rv-progress-track" aria-hidden="true">
        <div className="rv-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </div>
  );
}

// ─── Collapsed filter controls ───────────────────────────────────────────────

const LEGEND_DISMISS_KEY = 'rv-shortcuts-dismissed';

function FilterControls({
  filters,
  onChange,
  facets,
}: {
  filters: ReviewQueueFilters;
  onChange: (f: ReviewQueueFilters) => void;
  facets: { brands: string[]; families: { cohortId: string; label: string }[] };
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeCount = countActiveQueueFilters(filters);
  const chips = activeFilterChips(filters, {
    familyLabel: facets.families.find(f => f.cohortId === filters.familyCohortId)?.label,
  });

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const toggle = (key: keyof ReviewQueueFilters, value: boolean) =>
    onChange({ ...filters, [key]: filters[key] ? undefined : value });

  return (
    <div className="rv-filters" role="group" aria-label="Queue filters" ref={containerRef}>
      <button
        type="button"
        className="rv-filter-trigger"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(prev => !prev)}
      >
        <span aria-hidden="true">☰</span> Filters
        {activeCount > 0 && (
          <span className="rv-filter-count" aria-label={`${activeCount} active filters`}>
            {activeCount}
          </span>
        )}
      </button>

      {chips.length > 0 && (
        <span className="rv-filter-chips">
          {chips.map(chip => (
            <button
              key={chip.key}
              type="button"
              className="rv-filter-chip-remove"
              onClick={() => onChange(removeFilterChip(filters, chip.key))}
              title={`Remove ${chip.label} filter`}
            >
              {chip.label} ✕
            </button>
          ))}
        </span>
      )}

      {open && (
        <div className="rv-filter-popover">
          <div className="rv-filter-popover-row">
            <button
              type="button"
              className={`rv-chip${filters.reviewStates?.includes('unreviewed') ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.reviewStates?.includes('unreviewed') ?? false}
              onClick={() =>
                onChange(
                  filters.reviewStates?.includes('unreviewed')
                    ? { ...filters, reviewStates: undefined }
                    : { ...filters, reviewStates: ['unreviewed'] },
                )
              }
            >
              Unreviewed
            </button>
            <button
              type="button"
              className={`rv-chip${filters.reviewStates?.includes('reviewed') ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.reviewStates?.includes('reviewed') ?? false}
              onClick={() =>
                onChange(
                  filters.reviewStates?.includes('reviewed')
                    ? { ...filters, reviewStates: undefined }
                    : { ...filters, reviewStates: ['reviewed'] },
                )
              }
            >
              Reviewed
            </button>
          </div>
          <div className="rv-filter-popover-row">
            <button
              type="button"
              className={`rv-chip rv-chip-warning${filters.warningsOnly ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.warningsOnly ?? false}
              onClick={() => toggle('warningsOnly', !filters.warningsOnly)}
            >
              ⚠ Warnings
            </button>
            <button
              type="button"
              className={`rv-chip${filters.editedOnly ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.editedOnly ?? false}
              onClick={() => toggle('editedOnly', !filters.editedOnly)}
            >
              Edited during review
            </button>
          </div>

          {facets.families.length > 0 && (
            <select
              className="rv-select"
              aria-label="Filter by family"
              value={filters.familyCohortId ?? ''}
              onChange={e => onChange({ ...filters, familyCohortId: e.target.value || undefined })}
            >
              <option value="">All families</option>
              {facets.families.map(f => (
                <option key={f.cohortId} value={f.cohortId}>
                  {f.label}
                </option>
              ))}
            </select>
          )}

          {facets.brands.length > 0 && (
            <select
              className="rv-select"
              aria-label="Filter by brand"
              value={filters.brand ?? ''}
              onChange={e => onChange({ ...filters, brand: e.target.value || undefined })}
            >
              <option value="">All brands</option>
              {facets.brands.map(b => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}

          <select
            className="rv-select"
            aria-label="Filter by source"
            value={filters.sourceType ?? 'all'}
            onChange={e =>
              onChange({ ...filters, sourceType: (e.target.value || 'all') as 'official_page' | 'distributor_record' | 'all' })
            }
          >
            <option value="all">Any source</option>
            <option value="distributor_record">Distributor record</option>
            <option value="official_page">Official page</option>
          </select>

          {hasActiveQueueFilters(filters) && (
            <button type="button" className="rv-chip" onClick={() => onChange({})}>
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shortcut legend (dismissible — persisted) ──────────────────────────────

export function isLegendDismissed(store: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return store.getItem(LEGEND_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissLegend(store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    store.setItem(LEGEND_DISMISS_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

export function KeyboardLegend() {
  const [dismissed, setDismissed] = useState(() => isLegendDismissed());

  if (dismissed) {
    return (
      <button
        type="button"
        className="rv-legend-reopen"
        aria-label="Show keyboard shortcuts"
        onClick={() => {
          dismissLegendRestore();
          setDismissed(false);
        }}
        title="Show keyboard shortcuts"
      >
        ⌨ Shortcuts
      </button>
    );
  }

  return (
    <div className="rv-legend">
      <span aria-hidden="true">
        <kbd>G</kbd> Looks Good &amp; Next
      </span>
      <span aria-hidden="true">
        <kbd>←</kbd> <kbd>→</kbd> previous / next product
      </span>
      <span aria-hidden="true">
        <kbd>Esc</kbd> close product / image
      </span>
      <button
        type="button"
        className="rv-legend-dismiss"
        aria-label="Hide keyboard shortcuts"
        title="Hide shortcuts"
        onClick={() => {
          dismissLegend();
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}

function dismissLegendRestore(): void {
  try {
    localStorage.removeItem(LEGEND_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

function Lightbox({ url, caption, onClose }: { url: string; caption: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="rv-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Product image"
      onKeyDown={handleKey}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="rv-lightbox-close"
        aria-label="Close image"
        onClick={onClose}
      >
        ✕
      </button>
      <img src={url} alt={caption} className="rv-lightbox-img" onClick={e => e.stopPropagation()} />
      <div className="rv-lightbox-caption">{caption}</div>
    </div>
  );
}
