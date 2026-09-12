/**
 * Epic #46 — Ready to Export view (Phase 8 UI) — Redesigned.
 *
 * Approval ≠ export. Language matches the real side effect: ShopSite
 * DRAFT creation via change sets. 'Exported' only appears for the
 * server-verified `completed` category — never invented client-side.
 *
 * Impeccable redesign: showcases what the final products actually look like,
 * contrasting the final curated listing with the initial distributor intake values,
 * complete with product imagery, pricing, weight, catalog taxonomy, and rich
 * merchandising preview (Grid and Table modes).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  getBatchWorkState,
  getBatchWorkStateCounts,
  subscribeBatchEvents,
  createExportDrafts,
} from '../../../onboarding-work-api';
import { ExportActions } from './ExportActions';
import { exportStatusPresentation } from './approved-logic';
import { PackagingInspectorModal } from './PackagingInspectorModal';
import './approved.css';

interface ReadyToExportViewProps {
  batchId: string;
}

const PAGE_SIZE = 200;

type SectionKey = 'approved' | 'ready_to_export' | 'completed';

const SECTIONS: SectionKey[] = ['approved', 'ready_to_export', 'completed'];

export function ReadyToExportView({ batchId }: ReadyToExportViewProps) {
  const [bySection, setBySection] = useState<Record<SectionKey, OnboardingWorkState[]>>({
    approved: [],
    ready_to_export: [],
    completed: [],
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<{ count: number; changeSetId: string | null } | null>(null);
  const [isDegraded, setIsDegraded] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | SectionKey>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [inspectItem, setInspectItem] = useState<OnboardingWorkState | null>(null);
  const [packagingInspectItem, setPackagingInspectItem] = useState<OnboardingWorkState | null>(null);

  const exportIdempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    exportIdempotencyKeyRef.current = null;
  }, [JSON.stringify(selectedIds)]);

  const loadSections = useCallback(async () => {
    try {
      setError(null);
      const results = await Promise.all(
        SECTIONS.map(async (category) => {
          const collected: OnboardingWorkState[] = [];
          let offset = 0;
          for (;;) {
            const res = await getBatchWorkState(batchId, { category, limit: PAGE_SIZE, offset });
            collected.push(...res.items);
            if (collected.length >= res.total) break;
            offset += PAGE_SIZE;
          }
          return [category, collected] as const;
        }),
      );
      const next = {
        approved: [] as OnboardingWorkState[],
        ready_to_export: [] as OnboardingWorkState[],
        completed: [] as OnboardingWorkState[],
      };
      for (const [category, items] of results) next[category] = items;
      setBySection(next);
      const validIds = new Set([...next.approved].map((it) => it.itemId));
      setSelectedIds((prev) => prev.filter((id) => validIds.has(id)));
      try {
        const healthRes = await getBatchWorkStateCounts(batchId);
        setIsDegraded(healthRes.projectionHealth?.status === 'degraded');
      } catch {
        setIsDegraded(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const results = await Promise.all(
          SECTIONS.map(async (category) => {
            const collected: OnboardingWorkState[] = [];
            let offset = 0;
            for (;;) {
              const res = await getBatchWorkState(batchId, { category, limit: PAGE_SIZE, offset });
              if (cancelled) return [category, collected] as const;
              collected.push(...res.items);
              if (collected.length >= res.total) break;
              offset += PAGE_SIZE;
            }
            return [category, collected] as const;
          }),
        );
        if (cancelled) return;
        const next = {
          approved: [] as OnboardingWorkState[],
          ready_to_export: [] as OnboardingWorkState[],
          completed: [] as OnboardingWorkState[],
        };
        for (const [category, items] of results) next[category] = items;
        setBySection(next);
        const validIds = new Set([...next.approved].map((it) => it.itemId));
        setSelectedIds((prev) => prev.filter((id) => validIds.has(id)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const unsubscribe = subscribeBatchEvents(batchId, (event) => {
      if (event.type === 'item:status' || event.type === 'batch:progress') loadSections();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [batchId, loadSections]);

  const createDrafts = useCallback(async () => {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setDraftResult(null);
    if (!exportIdempotencyKeyRef.current) {
      try {
        exportIdempotencyKeyRef.current =
          typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
            ? (crypto as any).randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      } catch {
        exportIdempotencyKeyRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
    }
    const currentKey = exportIdempotencyKeyRef.current as string;
    try {
      const res = await createExportDrafts(batchId, selectedIds, { idempotencyKey: currentKey });
      exportIdempotencyKeyRef.current = null;
      setDraftResult({ count: res.createdCount, changeSetId: res.changeSetId });
      setNotice(
        res.createdCount > 0
          ? `Created export drafts for ${res.createdCount} product${res.createdCount === 1 ? '' : 's'}.`
          : 'No export drafts were created — check the products above.',
      );
      await loadSections();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [batchId, selectedIds, loadSections]);

  const total = useMemo(
    () => bySection.approved.length + bySection.ready_to_export.length + bySection.completed.length,
    [bySection],
  );

  const filteredBySection = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return bySection;
    const filterItem = (it: OnboardingWorkState) =>
      it.name.toLowerCase().includes(query) ||
      (Boolean(it.curatedTitle) && it.curatedTitle!.toLowerCase().includes(query)) ||
      (Boolean(it.upc) && it.upc.toLowerCase().includes(query)) ||
      (Boolean(it.brand) && it.brand!.toLowerCase().includes(query)) ||
      (Boolean(it.weight) && it.weight!.toLowerCase().includes(query)) ||
      (Boolean(it.description) && it.description!.toLowerCase().includes(query));

    return {
      approved: bySection.approved.filter(filterItem),
      ready_to_export: bySection.ready_to_export.filter(filterItem),
      completed: bySection.completed.filter(filterItem),
    };
  }, [bySection, filterText]);

  const visibleApproved = filteredBySection.approved;
  const allApprovedSelected =
    visibleApproved.length > 0 && visibleApproved.every((it) => selectedIds.includes(it.itemId));
  const toggleAllApproved = () =>
    setSelectedIds((prev) =>
      allApprovedSelected
        ? prev.filter((id) => !visibleApproved.some((it) => it.itemId === id))
        : [...new Set([...prev, ...visibleApproved.map((it) => it.itemId)])],
    );

  const toggleItemSelection = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    );
  };

  // Close drawer on escape key
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectItem(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (loading) return <div className="ow-loading">Loading export status…</div>;
  if (error && total === 0) {
    return (
      <div className="ow-error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-outline" onClick={loadSections}>
          Retry
        </button>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="ow-empty">
        <strong>Nothing approved yet.</strong>
        <span>
          Reviewed products that receive the bulk approval decision appear here,
          then move to Ready to Export when ShopSite drafts are created.
        </span>
      </div>
    );
  }

  const sectionsToRender = activeTab === 'all' ? SECTIONS : [activeTab];

  return (
    <div className="ow-export-dashboard" data-testid="create-drafts-workspace">
      {/* Funnel Header */}
      <div className="ow-funnel-header">
        <div className="ow-funnel-title-area">
          <h4 className="ow-funnel-main-title">
            Create Drafts & Export Catalog
            <span className="ow-count-pill">{total} total</span>
          </h4>
          <span className="ow-audit-line">
            Inspect finalized product listings and create approved ShopSite drafts in a change set.
          </span>
        </div>

        <div className="ow-funnel-metrics" role="tablist" aria-label="Draft pipeline stages">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'all'}
            className={`ow-funnel-stat ${activeTab === 'all' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <span className="ow-funnel-num">{total}</span>
            <span className="ow-funnel-label">All Items</span>
          </button>
          <div className="ow-funnel-arrow">→</div>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'approved'}
            className={`ow-funnel-stat ow-funnel-stat--approved ${activeTab === 'approved' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('approved')}
          >
            <span className="ow-funnel-num">{bySection.approved.length}</span>
            <span className="ow-funnel-label">Awaiting Drafts</span>
          </button>
          <div className="ow-funnel-arrow">→</div>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ready_to_export'}
            className={`ow-funnel-stat ow-funnel-stat--ready ${activeTab === 'ready_to_export' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('ready_to_export')}
          >
            <span className="ow-funnel-num">{bySection.ready_to_export.length}</span>
            <span className="ow-funnel-label">Drafts Created</span>
          </button>
          <div className="ow-funnel-arrow">→</div>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'completed'}
            className={`ow-funnel-stat ow-funnel-stat--completed ${activeTab === 'completed' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('completed')}
          >
            <span className="ow-funnel-num">{bySection.completed.length}</span>
            <span className="ow-funnel-label">Export Verified</span>
          </button>
        </div>
      </div>

      {/* Toolbar: Search, View Mode, Selection Controls */}
      <div className="ow-toolbar">
        <div className="ow-search-box">
          <svg className="ow-search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            className="ow-search-input"
            placeholder="Search by final title, initial upload name, brand, or UPC…"
            aria-label="Search items"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          {filterText && (
            <button
              type="button"
              className="ow-search-clear"
              onClick={() => setFilterText('')}
              aria-label="Clear search"
            >
              Clear
            </button>
          )}
        </div>

        {/* View mode toggle */}
        <div className="ow-view-toggle" role="group" aria-label="View presentation style">
          <button
            type="button"
            className={`ow-view-btn ${viewMode === 'grid' ? 'ow-view-btn--active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Card grid view — visual merchandising display"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
            Cards
          </button>
          <button
            type="button"
            className={`ow-view-btn ${viewMode === 'table' ? 'ow-view-btn--active' : ''}`}
            onClick={() => setViewMode('table')}
            title="Data table view — high density list"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
            Table
          </button>
        </div>

        {/* Bulk Action Controls */}
        {bySection.approved.length > 0 && (
          <div className="ow-toolbar-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={toggleAllApproved}
              disabled={isDegraded || visibleApproved.length === 0}
            >
              {allApprovedSelected ? 'Deselect All' : `Select All Awaiting (${visibleApproved.length})`}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={createDrafts}
              disabled={selectedIds.length === 0 || isDegraded || busy}
            >
              {busy ? 'Creating Drafts…' : `Create ShopSite Drafts (${selectedIds.length})`}
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div
          className="ow-section ow-notice-banner"
          style={{ background: 'var(--color-success-bg)', borderColor: 'var(--color-success-border)' }}
        >
          <span style={{ color: 'var(--color-success-text)' }}>{notice}</span>
        </div>
      )}
      {error && (
        <div className="ow-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {draftResult?.changeSetId && (
        <div className="ow-section ow-changeset-alert">
          <span className="ow-detail">
            Export drafts were created in change set{' '}
            <a href="?view=changesets" style={{ fontWeight: 600, color: 'var(--color-uniform-green)' }}>
              {draftResult.changeSetId}
            </a>{' '}
            — open the Change Set Review to review generated drafts and publish to ShopSite.
          </span>
        </div>
      )}

      {/* Sections rendering */}
      {sectionsToRender.map((section) => {
        const items = filteredBySection[section];
        const rawCount = bySection[section].length;
        const pres = exportStatusPresentation(section);
        if (rawCount === 0) return null;

        return (
          <div key={section} className={`ow-section ow-dashboard-section ow-section--${section}`}>
            <div className="ow-section-header">
              <div className="ow-section-header-left">
                <span className={`ow-section-badge ow-section-badge--${section}`} />
                <h5 className="ow-section-title">
                  {pres.heading}{' '}
                  <span className="ow-count-pill">
                    {items.length}
                    {items.length !== rawCount ? ` of ${rawCount}` : ''}
                  </span>
                </h5>
              </div>
              {section === 'approved' && (
                <ExportActions
                  primaryLabel={`Create drafts for selected (${selectedIds.length})`}
                  primaryDisabled={selectedIds.length === 0 || isDegraded}
                  secondaryLabel={allApprovedSelected ? 'Deselect visible' : `Select visible (${items.length})`}
                  secondaryDisabled={items.length === 0 || isDegraded}
                  busy={busy}
                  onPrimary={createDrafts}
                  onSecondary={toggleAllApproved}
                  hint={
                    isDegraded
                      ? 'Projection degraded — cannot create drafts'
                      : selectedIds.length === 0
                      ? 'Select approved products to create export drafts.'
                      : undefined
                  }
                />
              )}
            </div>
            <p className="ow-detail ow-section-desc">{pres.description}</p>

            {items.length === 0 && filterText ? (
              <div className="ow-no-matches">
                No products in <em>{pres.heading}</em> match "{filterText}".
              </div>
            ) : viewMode === 'grid' ? (
              /* ── Grid View: Visual Product Cards ── */
              <div className="ow-product-grid">
                {items.map((item) => {
                  const isSelected = selectedIds.includes(item.itemId);
                  const displayTitle = item.curatedTitle?.trim() || item.name;
                  const hasRenamed =
                    Boolean(item.curatedTitle) &&
                    item.curatedTitle!.trim().toLowerCase() !== item.name.trim().toLowerCase();

                  return (
                    <div
                      key={item.itemId}
                      className={`ow-product-card ${isSelected ? 'ow-product-card--selected' : ''}`}
                      onClick={() => {
                        if (section === 'approved') toggleItemSelection(item.itemId);
                      }}
                      style={{ cursor: section === 'approved' ? 'pointer' : 'default' }}
                    >
                      {/* Top Bar: Brand, Checkbox, Status */}
                      <div className="ow-card-topbar">
                        {section === 'approved' ? (
                          <label
                            className="ow-card-checkbox-label"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${displayTitle}`}
                              checked={isSelected}
                              onChange={() => toggleItemSelection(item.itemId)}
                            />
                            <span className="ow-brand-pill" title={item.brand || undefined}>
                              {item.brand || 'General'}
                            </span>
                          </label>
                        ) : (
                          <span className="ow-brand-pill" title={item.brand || undefined}>
                            {item.brand || 'General'}
                          </span>
                        )}

                        <div className="ow-card-topbar-right">
                          {section === 'completed' && (
                            <span className="ow-chip ow-chip--success" style={{ fontSize: '0.6875rem' }}>
                              ✓ Verified
                            </span>
                          )}
                          {section === 'ready_to_export' && (
                            <span
                              className="ow-chip"
                              style={{
                                fontSize: '0.6875rem',
                                color: 'var(--color-uniform-green)',
                                borderColor: 'var(--color-success-border)',
                                background: 'var(--color-success-bg)',
                              }}
                            >
                              Draft Created
                            </span>
                          )}
                          {section === 'approved' && isSelected && (
                            <span className="ow-chip ow-chip--selected" style={{ fontSize: '0.6875rem' }}>
                              Selected
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Product Thumbnail Box */}
                      <div
                        className="ow-card-thumb-container"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPackagingInspectItem(item);
                        }}
                        title="Click to inspect packaging photo in high resolution"
                      >
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={displayTitle}
                            className="ow-card-thumb-img"
                            loading="lazy"
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                              const parent = e.currentTarget.parentElement;
                              if (parent) {
                                const placeholder = parent.querySelector('.ow-card-no-img-fallback');
                                if (placeholder) (placeholder as HTMLElement).style.display = 'flex';
                              }
                            }}
                          />
                        ) : null}
                        <div
                          className="ow-card-no-img ow-card-no-img-fallback"
                          style={{ display: item.imageUrl ? 'none' : 'flex' }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                            <line x1="12" y1="22.08" x2="12" y2="12" />
                          </svg>
                          <span>Product Image</span>
                        </div>
                        {item.imageUrl && (
                          <div className="ow-card-zoom-badge">
                            🔍 Zoom Packaging
                          </div>
                        )}
                      </div>

                      {/* Card Body */}
                      <div className="ow-card-body">
                        {/* Final Curated Title */}
                        <h5 className="ow-card-title" title={displayTitle}>
                          {displayTitle}
                        </h5>

                        {/* Intake Comparison Tag (The requested feature: shows initial upload value!) */}
                        {hasRenamed && (
                          <div className="ow-intake-compare" title="Original distributor upload value before curation">
                            <span className="ow-intake-tag">Intake:</span>
                            <span className="ow-intake-val">{item.name}</span>
                          </div>
                        )}

                        {/* Metadata row: UPC & Weight */}
                        <div className="ow-card-meta-row">
                          {item.upc ? (
                            <code className="ow-sku-code" title={`UPC: ${item.upc}`}>
                              UPC: {item.upc}
                            </code>
                          ) : (
                            <span className="ow-no-upc" style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                              No UPC
                            </span>
                          )}
                          {item.weight && <span className="ow-weight-badge">{item.weight}</span>}
                        </div>

                        {/* Description snippet if available */}
                        {item.description && (
                          <p className="ow-card-desc" title={item.description}>
                            {item.description}
                          </p>
                        )}
                      </div>

                      {/* Card Footer */}
                      <div className="ow-card-footer" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="ow-btn-link"
                          onClick={() => setPackagingInspectItem(item)}
                          title="Open packaging photo zoom to verify printed names and formula"
                        >
                          🔍 Verify Packaging
                        </button>
                        <button
                          type="button"
                          className="ow-btn-link"
                          onClick={() => setInspectItem(item)}
                        >
                          Inspect Draft →
                        </button>
                        {section === 'ready_to_export' && (
                          <a
                            className="btn btn-primary btn-sm"
                            href="?view=changesets"
                            style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                          >
                            Open Change Set →
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* ── Table View: Dense Merchandising List ── */
              <div className="ow-dense-table-wrap">
                <table className="ow-dense-table">
                  <thead>
                    <tr>
                      {section === 'approved' && (
                        <th style={{ width: 40 }}>
                          <input
                            type="checkbox"
                            aria-label="Select all visible products"
                            checked={allApprovedSelected}
                            onChange={toggleAllApproved}
                          />
                        </th>
                      )}
                      <th style={{ width: 64 }}>Preview</th>
                      <th>Final Product Title</th>
                      <th>Initial Upload Name</th>
                      <th>Brand & UPC</th>
                      <th>Specs</th>
                      <th>Status & Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const isSelected = selectedIds.includes(item.itemId);
                      const displayTitle = item.curatedTitle?.trim() || item.name;
                      const hasRenamed =
                        Boolean(item.curatedTitle) &&
                        item.curatedTitle!.trim().toLowerCase() !== item.name.trim().toLowerCase();

                      return (
                        <tr
                          key={item.itemId}
                          className={`ow-dense-row ${isSelected ? 'ow-dense-row--selected' : ''}`}
                          onClick={() => {
                            if (section === 'approved') toggleItemSelection(item.itemId);
                          }}
                          style={{ cursor: section === 'approved' ? 'pointer' : 'default' }}
                        >
                          {section === 'approved' && (
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`Select ${displayTitle}`}
                                checked={isSelected}
                                onChange={() => toggleItemSelection(item.itemId)}
                              />
                            </td>
                          )}

                          {/* Thumbnail */}
                          <td
                            onClick={(e) => {
                              e.stopPropagation();
                              setPackagingInspectItem(item);
                            }}
                            title="Click to inspect packaging photo in high resolution"
                            style={{ cursor: 'zoom-in' }}
                          >
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={displayTitle}
                                className="ow-table-thumb"
                                loading="lazy"
                              />
                            ) : (
                              <div className="ow-table-no-thumb">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                                </svg>
                              </div>
                            )}
                          </td>

                          {/* Final Product Title */}
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--color-ledger-charcoal)', maxWidth: 360 }}>
                              {displayTitle}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                              <button
                                type="button"
                                className="ow-btn-link"
                                style={{ padding: 0 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPackagingInspectItem(item);
                                }}
                                title="Open high-resolution packaging inspector"
                              >
                                🔍 Verify Packaging
                              </button>
                              <span style={{ color: '#cbd5e1' }}>•</span>
                              <button
                                type="button"
                                className="ow-btn-link"
                                style={{ padding: 0 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setInspectItem(item);
                                }}
                              >
                                Inspect Details
                              </button>
                            </div>
                          </td>

                          {/* Initial Upload Value (Intake) */}
                          <td>
                            <code
                              className="ow-sku-code"
                              style={{
                                color: hasRenamed ? '#64748b' : 'inherit',
                                backgroundColor: hasRenamed ? '#f1f5f9' : undefined,
                              }}
                              title={item.name}
                            >
                              {item.name}
                            </code>
                          </td>

                          {/* Brand & UPC */}
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--color-ledger-charcoal)' }}>
                              {item.brand || '—'}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-mulch-brown)' }}>
                              {item.upc ? <code className="ow-sku-code">{item.upc}</code> : 'No UPC'}
                            </div>
                          </td>

                          {/* Specs */}
                          <td>
                            {item.weight ? <span className="ow-weight-badge">{item.weight}</span> : '—'}
                          </td>

                          {/* Status & Action */}
                          <td onClick={(e) => e.stopPropagation()}>
                            {section === 'completed' && (
                              <span className="ow-chip ow-chip--success">✓ Export verified</span>
                            )}
                            {section === 'ready_to_export' && (
                              <a className="btn btn-primary btn-sm" href="?view=changesets">
                                Open Change Set →
                              </a>
                            )}
                            {section === 'approved' && (
                              <span
                                className={`ow-chip ${isSelected ? 'ow-chip--selected' : ''}`}
                                style={{
                                  background: isSelected ? '#dcfce7' : '#fef3c7',
                                  color: isSelected ? '#15803d' : '#92400e',
                                  borderColor: isSelected ? '#86efac' : '#fde68a',
                                }}
                              >
                                {isSelected ? 'Selected for Draft' : 'Awaiting Draft'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* Slide-Over Inspection Drawer */}
      {inspectItem && (
        <div className="ow-drawer-backdrop" onClick={() => setInspectItem(null)}>
          <div
            className="ow-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`Inspect ${inspectItem.curatedTitle || inspectItem.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="ow-drawer-header">
              <h4 className="ow-drawer-title">Product Draft Dossier</h4>
              <button
                type="button"
                className="ow-drawer-close"
                onClick={() => setInspectItem(null)}
                aria-label="Close drawer"
              >
                ✕
              </button>
            </div>

            {/* Drawer Body */}
            <div className="ow-drawer-body">
              {/* Hero Image */}
              <div
                className="ow-drawer-hero-image-box"
                onClick={() => {
                  if (inspectItem.imageUrl) setPackagingInspectItem(inspectItem);
                }}
                title={inspectItem.imageUrl ? 'Click to inspect packaging photo in high resolution' : undefined}
              >
                {inspectItem.imageUrl ? (
                  <img
                    src={inspectItem.imageUrl}
                    alt={inspectItem.curatedTitle || inspectItem.name}
                    className="ow-drawer-hero-img"
                  />
                ) : (
                  <div className="ow-card-no-img">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    </svg>
                    <span>No primary photo recorded</span>
                  </div>
                )}
                {inspectItem.imageUrl && (
                  <div className="ow-card-zoom-badge" style={{ opacity: 1, bottom: 10, right: 10 }}>
                    🔍 Click to Zoom
                  </div>
                )}
              </div>
              {inspectItem.imageUrl && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm ow-drawer-zoom-btn"
                  onClick={() => setPackagingInspectItem(inspectItem)}
                >
                  🔍 Open High-Resolution Packaging Inspector
                </button>
              )}

              {/* Title & Before/After Comparison */}
              <div className="ow-drawer-section">
                <h6 className="ow-drawer-section-title">Listing Transformation</h6>
                <div className="ow-drawer-compare-box">
                  <div className="ow-drawer-compare-row">
                    <span className="ow-drawer-compare-heading">Final Customer-Facing Product Title</span>
                    <strong className="ow-drawer-compare-value">
                      {inspectItem.curatedTitle || inspectItem.name}
                    </strong>
                  </div>
                  <div className="ow-drawer-compare-row" style={{ borderTop: '1px solid #e2e8f0', paddingTop: 6 }}>
                    <span className="ow-drawer-compare-heading">Initial Distributor Upload Value</span>
                    <code className="ow-sku-code" style={{ alignSelf: 'flex-start', color: '#475569' }}>
                      {inspectItem.name}
                    </code>
                  </div>
                </div>
              </div>

              {/* Catalog Specifications */}
              <div className="ow-drawer-section">
                <h6 className="ow-drawer-section-title">Catalog Identifiers & Specs</h6>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="ow-intake-compare" style={{ flexDirection: 'column', gap: 2 }}>
                    <span className="ow-intake-tag">Brand</span>
                    <strong>{inspectItem.brand || 'None assigned'}</strong>
                  </div>
                  <div className="ow-intake-compare" style={{ flexDirection: 'column', gap: 2 }}>
                    <span className="ow-intake-tag">UPC / Barcode</span>
                    <code>{inspectItem.upc || 'No UPC'}</code>
                  </div>
                  <div className="ow-intake-compare" style={{ flexDirection: 'column', gap: 2 }}>
                    <span className="ow-intake-tag">Weight / Size</span>
                    <strong>{inspectItem.weight || 'None specified'}</strong>
                  </div>
                  <div className="ow-intake-compare" style={{ flexDirection: 'column', gap: 2 }}>
                    <span className="ow-intake-tag">Source Provenance</span>
                    <span style={{ fontSize: '0.75rem' }}>
                      {inspectItem.sourceType === 'distributor_record' ? 'Supplier Record' : 'Official Page'}
                      {inspectItem.domain ? ` (${inspectItem.domain})` : ''}
                    </span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="ow-drawer-section">
                <h6 className="ow-drawer-section-title">Curated Merchandising Copy</h6>
                <div className="ow-drawer-desc-text">
                  {inspectItem.description || 'No curated description available for this item.'}
                </div>
              </div>

              {/* Pipeline Status */}
              <div className="ow-drawer-section">
                <h6 className="ow-drawer-section-title">Pipeline Stage Info</h6>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-mulch-brown)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>
                    <strong>Pipeline Status:</strong> {inspectItem.stage} / {inspectItem.stageStatus}
                  </div>
                  <div>
                    <strong>Lifecycle Category:</strong> {inspectItem.category}
                  </div>
                  <div>
                    <strong>Activity:</strong> {inspectItem.activity || '—'}
                  </div>
                  {inspectItem.detail && (
                    <div>
                      <strong>Audit detail:</strong> {inspectItem.detail}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Drawer Footer */}
            <div className="ow-drawer-footer">
              {inspectItem.category === 'approved' && (
                <button
                  type="button"
                  className={`btn ${selectedIds.includes(inspectItem.itemId) ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                  onClick={() => toggleItemSelection(inspectItem.itemId)}
                >
                  {selectedIds.includes(inspectItem.itemId) ? 'Deselect Item' : 'Select for Draft Creation'}
                </button>
              )}
              {inspectItem.category === 'ready_to_export' && (
                <a className="btn btn-primary btn-sm" href="?view=changesets">
                  Open in Change Set Review →
                </a>
              )}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setInspectItem(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* High-Resolution Packaging Inspection & Verification Studio */}
      {packagingInspectItem && (
        <PackagingInspectorModal
          item={packagingInspectItem}
          allItems={
            activeTab === 'all'
              ? [
                  ...filteredBySection.approved,
                  ...filteredBySection.ready_to_export,
                  ...filteredBySection.completed,
                ]
              : filteredBySection[activeTab]
          }
          onClose={() => setPackagingInspectItem(null)}
          onNavigate={setPackagingInspectItem}
          onToggleSelection={toggleItemSelection}
          isSelected={selectedIds.includes(packagingInspectItem.itemId)}
        />
      )}
    </div>
  );
}
