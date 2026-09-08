/**
 * Slice 2 — stage-scoped item list over server-filtered v2 stage reads.
 *
 * Server-authoritative: every filter (stage, stageStatus, category,
 * reviewState, sourceType, q) is sent to
 * GET /api/onboarding/v2/batches/:id/stage-work-state/items via
 * `src/client/onboarding-stage-api.ts`. The client sends limit 50 explicitly
 * and follows cursors; it never derives totals from fetched-page lengths.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import { assignBrandGroup, assignItemBrand } from '../../onboarding-api';
import { BrandCombobox } from './BrandCombobox';
import { getBrandOptions, resolveCanonicalBrand } from './brand-combobox-logic';
import {
  getStageReadItems,
  StageReadApiError,
} from '../../onboarding-stage-api';
import { STAGE_READ_LIMIT_DEFAULT } from '../../../shared/schemas/onboarding-stage-read';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import type { StageReadQuery } from '../../onboarding-stage-api';
import type { LinearStageId } from './linear-workspace-logic';
import { LINEAR_STAGE_LABELS } from './linear-workspace-logic';
import {
  DEFAULT_REVIEW_LIST_FACET,
  REVIEW_LIST_FACETS,
  REVIEW_LIST_FACET_LABELS,
  reviewStateLabel,
  sourceTypeLabel,
  formatCount,
  type ReviewListFacet,
} from './batch-workspace-logic';

export interface StageItemsViewProps {
  batchId: string;
  stage: LinearStageId;
  /** Compact mode hides the explainer (used inside PrepareListingView). */
  compact?: boolean;
  onOpenFullBatchReview?: () => void;
  /** Oracle slice: batch-wide export workspace entry inside Create drafts. */
  onOpenReadyToExportWorkspace?: () => void;
}

type Facet = { category?: string; reviewState?: ReviewListFacet };

export function StageItemsView({ batchId, stage, compact, onOpenFullBatchReview, onOpenReadyToExportWorkspace }: StageItemsViewProps) {
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  // Review-listings defaults to Unreviewed; Reviewed / Not-ready are distinct
  // server-filtered lists. Not-ready is never folded into an awaiting count.
  const [facet, setFacet] = useState<Facet>(
    stage === 'review_listings' ? { reviewState: DEFAULT_REVIEW_LIST_FACET } : {},
  );
  const generation = useRef(0);
  // Inline brand assignment (route_sources only): per-row drafts mirroring
  // Step 0 BrandGateView BrandFixRow. The mutation path is the EXACT same
  // `assignItemBrand` call — no new endpoints, no mapping UI; brand→domain
  // mapping authority stays in Settings.
  const [drafts, setDrafts] = useState<Record<string, { brand: string; saving: boolean; error: string | null }>>({});
  const [refreshing, setRefreshing] = useState(false);
  // Checkbox multiselect (route_sources only): per-row selection driving a
  // bulk bar that calls the EXISTING assignBrandGroup(batchId, itemIds,
  // brand) client. Success flows through the existing refresh epoch below.
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [bulkBrand, setBulkBrand] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Canonical brand pool for the comboboxes below (EXISTING getBrandSites
  // client: brandSites spellings + catalogBrands). Empty on failed reads —
  // inputs degrade to free-text entry, never a broken control.
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const brandOptionsRef = useRef<string[]>([]);
  brandOptionsRef.current = brandOptions;

  useEffect(() => {
    setFacet(stage === 'review_listings' ? { reviewState: DEFAULT_REVIEW_LIST_FACET } : {});
    setQ('');
    setDebouncedQ('');
    setDrafts({});
    setRefreshing(false);
    setSelected({});
    setBulkBrand('');
    setBulkError(null);
    setBulkSaving(false);
  }, [stage, batchId]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (cursor: string | null, currentFacet: Facet, query: string) => {
      const gen = generation.current;
      setLoading(true);
      try {
        const params: StageReadQuery = { stage, limit: STAGE_READ_LIMIT_DEFAULT };
        if (currentFacet.reviewState) params.reviewState = currentFacet.reviewState;
        if (query) params.q = query;
        if (cursor) params.cursor = cursor;
        const res = await getStageReadItems(batchId, params);
        if (generation.current !== gen) return; // batch/stage switch discards stale responses
        setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
        // Honesty note: this bounded endpoint returns rows, not a batch
        // total — authoritative totals come from the counts endpoint (stage
        // badges). We display the loaded-row count only, never a page
        // length passed off as a total.
        setError(null);
      } catch (err) {
        if (generation.current !== gen) return;
        const msg = err instanceof StageReadApiError ? `${err.message}${err.code ? ` (${err.code})` : ''}` : err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (generation.current === gen) setLoading(false);
      }
    },
    [batchId, stage],
  );

  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setNextCursor(null);
    setError(null);
    void load(null, facet, debouncedQ);
    // Keyed on the serialized facet shape so object identity churn never
    // retriggers the fetch; only actual filter changes do.
  }, [load, JSON.stringify(facet), debouncedQ]);

  // Live mirrors of the current filter so the refresh epoch below always
  // re-reads the visible list (never a stale closure).
  const facetRef = useRef(facet);
  facetRef.current = facet;
  const queryRef = useRef(debouncedQ);
  queryRef.current = debouncedQ;

  // Refresh epoch mirroring BrandGateView.refreshEpoch: success refetches
  // the stage list from the server; rows keep their server-reported state
  // until the fresh response confirms the fix, so counts/badges update.
  const refreshEpoch = useCallback(async () => {
    const gen = generation.current;
    setRefreshing(true);
    try {
      setItems([]);
      setNextCursor(null);
      setError(null);
      setDrafts({});
      setSelected({});
      setBulkError(null);
      await load(null, facetRef.current, queryRef.current);
    } finally {
      if (generation.current === gen) setRefreshing(false);
    }
  }, [load]);

  const updateDraft = useCallback((itemId: string, patch: Partial<{ brand: string; saving: boolean; error: string | null }>) => {
    setDrafts((prev) => {
      const existing = prev[itemId] ?? { brand: '', saving: false, error: null };
      return { ...prev, [itemId]: { ...existing, ...patch } };
    });
  }, []);

  // One shared brand-pool read per route_sources mount (cached globally
  // in brand-combobox-logic; zero per-row requests).
  useEffect(() => {
    if (stage !== 'route_sources') {
      setBrandOptions([]);
      return;
    }
    let cancelled = false;
    void getBrandOptions().then((opts) => {
      if (!cancelled) setBrandOptions(opts);
    });
    return () => {
      cancelled = true;
    };
  }, [stage, batchId]);

  // EXACT Step 0 BrandGateView BrandFixRow mutation path: assignItemBrand,
  // then the refresh epoch above. Never locally marks an item fixed. The
  // value is canonicalized first so an existing brand typed with variant
  // casing still submits its stored brand_sites spelling (no ghost
  // brands); genuinely new brands pass through trimmed and untouched.
  const runBrandAssign = useCallback(
    async (itemId: string, value: string) => {
      const canonical = resolveCanonicalBrand(value, brandOptionsRef.current);
      if (!canonical || drafts[itemId]?.saving) return;
      updateDraft(itemId, { saving: true, error: null });
      try {
        await assignItemBrand(itemId, canonical);
        await refreshEpoch();
      } catch (err) {
        updateDraft(itemId, {
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [drafts, refreshEpoch, updateDraft],
  );

  const toggleSelect = useCallback((itemId: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[itemId]) delete next[itemId];
      else next[itemId] = true;
      return next;
    });
    setBulkError(null);
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const allSelected = items.length > 0 && items.every((item) => prev[item.itemId]);
      if (allSelected) return {};
      const next: Record<string, true> = {};
      for (const item of items) next[item.itemId] = true;
      return next;
    });
    setBulkError(null);
  }, [items]);

  // Bulk path: the EXISTING assignBrandGroup(batchId, itemIds, brand)
  // client, then the existing refresh epoch. Never locally marks rows
  // fixed; route_sources scope only (callers gate rendering). Canonicalizes
  // like the per-row path so bulk assigns hit brand_sites keys exactly.
  const runBulkAssign = useCallback(async (overrideValue?: string) => {
    const ids = Object.keys(selected);
    const canonical = resolveCanonicalBrand(overrideValue ?? bulkBrand, brandOptionsRef.current);
    if (!canonical || ids.length === 0 || bulkSaving) return;
    setBulkSaving(true);
    setBulkError(null);
    try {
      await assignBrandGroup(batchId, ids, canonical);
      setSelected({});
      setBulkBrand('');
      await refreshEpoch();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkSaving(false);
    }
  }, [selected, bulkBrand, bulkSaving, batchId, refreshEpoch]);

  const selectedCount = Object.keys(selected).length;

  const isRouteSourcesStage = stage === 'route_sources';

  const isReviewStage = stage === 'review_listings';
  const isDraftsStage = stage === 'create_drafts';

  return (
    <div id="bws-stage-panel" role="tabpanel" aria-labelledby={`bws-stage-tab-${stage}`} data-testid={`stage-items-${stage}`}>
      {!compact && stage === 'route_sources' && (
        <div className="bws-stage-flow-note" data-testid="stage-one-flow-note">
          <p>
            <strong>Main flow:</strong> use the official product page as the main source.
          </p>
          <p className="bws-muted">
            Secondary fast path: a qualified supplier record can provide an alternate path that
            skips product-page discovery. Triage rows report their actual recorded activity —
            including a real distributor lookup when one occurred — never a fabricated visit.
          </p>
        </div>
      )}

      <p className="bws-muted" data-testid="stage-scope-label" style={{ margin: '0 0 8px 0', fontSize: '0.8125rem' }}>
        Stage list: {LINEAR_STAGE_LABELS[stage]} · server-filtered ·{' '}
        {loading && items.length === 0 ? 'loading…' : `${formatCount(items.length)} loaded row${items.length === 1 ? '' : 's'}`}
        {nextCursor ? ' — more available' : ''}
        {refreshing ? ' · refreshing…' : ''}
      </p>

      {isReviewStage && (
        <div className="bws-facet-row" role="group" aria-label="Review state filter" data-testid="review-facet-row">
          {REVIEW_LIST_FACETS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={facet.reviewState === f}
              className={`bws-chip${facet.reviewState === f ? ' bws-chip-active' : ''}`}
              onClick={() => setFacet({ reviewState: f })}
            >
              {REVIEW_LIST_FACET_LABELS[f]}
            </button>
          ))}
          {onOpenFullBatchReview && (
            <button
              type="button"
              className="bws-filter-input"
              style={{ cursor: 'pointer', fontWeight: 600, color: colors.uniformGreen }}
              onClick={onOpenFullBatchReview}
            >
              Open full-batch Review workspace
            </button>
          )}
        </div>
      )}

      {isDraftsStage && onOpenReadyToExportWorkspace && (
        <div className="bws-facet-row" role="group" aria-label="Export workspace" data-testid="drafts-export-row">
          <button
            type="button"
            data-testid="open-ready-to-export-workspace"
            className="bws-filter-input"
            style={{ cursor: 'pointer', fontWeight: 600, color: colors.uniformGreen }}
            onClick={onOpenReadyToExportWorkspace}
          >
            Open ready-to-export workspace, entire batch
          </button>
        </div>
      )}

      <div className="bws-filter-bar" role="search" aria-label={`Filter ${LINEAR_STAGE_LABELS[stage]}`}>
        <input
          type="search"
          className="bws-filter-input"
          placeholder="Search UPC, name, or brand…"
          aria-label="Search by UPC, name, or brand"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: '1 1 240px', minWidth: 200 }}
        />
      </div>

      {isRouteSourcesStage && items.length > 0 && (
        <div
          data-testid="stage-bulk-bar"
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '8px 10px',
            margin: '0 0 8px 0',
          }}
        >
          <span className="bws-muted" data-testid="stage-bulk-count" style={{ fontSize: '0.75rem', fontWeight: 600, paddingBottom: 8 }}>
            {selectedCount === 0 ? 'No rows selected' : `${selectedCount} selected`}
          </span>
          <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
            Brand for selected
            <span style={{ display: 'block', width: 200, marginTop: 2 }}>
              <BrandCombobox
                value={bulkBrand}
                onChange={(next) => { setBulkBrand(next); setBulkError(null); }}
                onCommit={(next) => void runBulkAssign(next)}
                options={brandOptions}
                disabled={bulkSaving}
                ariaLabel="Brand for selected rows"
                placeholder="Enter brand name"
                inputTestId="stage-bulk-brand-input"
                inputStyle={{
                  display: 'block',
                  width: 200,
                  padding: '0.375rem 0.5rem',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.md,
                  fontSize: '0.8125rem',
                  fontFamily: fonts.body,
                }}
              />
            </span>
          </label>
          <button
            type="button"
            data-testid="stage-bulk-assign"
            onClick={() => void runBulkAssign()}
            disabled={bulkSaving || selectedCount === 0 || !bulkBrand.trim()}
            style={{
              backgroundColor: colors.uniformGreen,
              border: 'none',
              borderRadius: rounded.md,
              padding: '0.375rem 0.75rem',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: colors.feedBagCream,
              cursor: bulkSaving || selectedCount === 0 || !bulkBrand.trim() ? 'not-allowed' : 'pointer',
              opacity: bulkSaving || selectedCount === 0 || !bulkBrand.trim() ? 0.6 : 1,
              minHeight: 32,
            }}
          >
            {bulkSaving ? 'Assigning…' : 'Assign to selected'}
          </button>
          {bulkError && (
            <span role="alert" data-testid="stage-bulk-error" style={{ fontSize: '0.75rem', color: colors.signetBurgundy, flexBasis: '100%' }}>
              {bulkError} — list unchanged.
            </span>
          )}
        </div>
      )}

      {error && (
        <div role="alert" style={{ color: colors.signetBurgundy, padding: '0.75rem 0' }}>
          Failed to load stage items: {error}
        </div>
      )}
      {loading && items.length === 0 && !error && (
        <div className="bws-muted" style={{ padding: '1rem 0' }}>Loading stage items…</div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="bws-muted" style={{ padding: '2rem 1rem', textAlign: 'center' }} data-testid="stage-empty">
          No products in this stage match the current filters.
        </div>
      )}
      {items.length > 0 && (
        <div className="bws-table-scroll">
        <table className="bws-results-table">
          <thead>
            <tr>
              {isRouteSourcesStage && (
                <th>
                  <input
                    type="checkbox"
                    data-testid="stage-select-all"
                    aria-label="Select all rows"
                    checked={items.length > 0 && items.every((item) => selected[item.itemId])}
                    onChange={toggleSelectAll}
                  />
                </th>
              )}
              <th>Product</th>
              <th>Stage status</th>
              <th>Review</th>
              <th>Source</th>
              {isRouteSourcesStage && <th>Brand fix</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const draft = drafts[item.itemId];
              const brandValue = draft?.brand ?? item.brand ?? '';
              const saving = draft?.saving ?? false;
              return (
              <tr key={item.itemId}>
                {isRouteSourcesStage && (
                  <td>
                    <input
                      type="checkbox"
                      data-testid={`stage-select-${item.itemId}`}
                      aria-label={`Select ${item.name || item.upc}`}
                      checked={Boolean(selected[item.itemId])}
                      onChange={() => toggleSelect(item.itemId)}
                    />
                  </td>
                )}
                <td>
                  <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>{item.name || item.upc}</div>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
                    {item.upc}
                    {item.brand ? ` · ${item.brand}` : ''}
                  </div>
                </td>
                <td>
                  <span className="bws-stage-badge" title={`Recorded pipeline state: ${item.stage} / ${item.stageStatus}`}>
                    {item.stage} / {item.stageStatus}
                  </span>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>{item.label}</div>
                </td>
                <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
                  {item.reviewState ? reviewStateLabel(item.reviewState) : '—'}
                </td>
                <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
                  {sourceTypeLabel(item.sourceType)}
                  {item.domain ? <div style={{ fontSize: '0.6875rem' }}>{item.domain}</div> : null}
                </td>
                {isRouteSourcesStage && (
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
                      <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
                        Brand
                        <span style={{ display: 'block', width: '100%', marginTop: 2 }}>
                          <BrandCombobox
                            value={brandValue}
                            onChange={(next) => updateDraft(item.itemId, { brand: next, error: null })}
                            onCommit={(next) => void runBrandAssign(item.itemId, next)}
                            options={brandOptions}
                            disabled={saving}
                            ariaLabel={`Brand for ${item.name || item.upc}`}
                            placeholder="Enter brand name"
                            inputStyle={{
                              display: 'block',
                              width: '100%',
                              padding: '0.375rem 0.5rem',
                              border: `1px solid ${colors.cardBorder}`,
                              borderRadius: rounded.md,
                              fontSize: '0.8125rem',
                              fontFamily: fonts.body,
                            }}
                          />
                        </span>
                      </label>
                      <div>
                        <button
                          type="button"
                          data-testid={`stage-brand-assign-${item.itemId}`}
                          onClick={() => void runBrandAssign(item.itemId, brandValue)}
                          disabled={saving || !brandValue.trim()}
                          style={{
                            backgroundColor: colors.uniformGreen,
                            border: 'none',
                            borderRadius: rounded.md,
                            padding: '0.375rem 0.75rem',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: colors.feedBagCream,
                            cursor: saving || !brandValue.trim() ? 'not-allowed' : 'pointer',
                            opacity: saving || !brandValue.trim() ? 0.6 : 1,
                            minHeight: 32,
                          }}
                        >
                          {saving ? 'Assigning…' : 'Assign brand'}
                        </button>
                      </div>
                      {draft?.error && (
                        <span role="alert" style={{ fontSize: '0.75rem', color: colors.signetBurgundy }}>
                          {draft.error} — list unchanged.
                        </span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      {nextCursor && (
        <button
          type="button"
          onClick={() => load(nextCursor, facet, debouncedQ)}
          disabled={loading}
          style={{
            marginTop: 12,
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.5rem 0.875rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 36,
          }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
