/** Direct Create drafts task. Approval, CMS drafts, and verified export are distinct. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  subscribeBatchEvents,
  createExportDrafts,
  createIdempotencyKey,
  type CreateExportDraftsResponse,
} from '../../../onboarding-work-api';
import { getStageReadCounts, getStageReadItems } from '../../../onboarding-stage-api';
import {
  StageReadCountsResponseSchema,
  StageReadItemsResponseSchema,
  STAGE_READ_LIMIT_DEFAULT,
  type StageReadCountsResponse,
} from '../../../../shared/schemas/onboarding-stage-read';
import { getProduct, getChangeSet, type ChangeSetItem } from '../../../api';
import { readStageViewPreferences, writeStageViewPreferences } from '../workspace-view-state';
import { exportStatusPresentation } from './approved-logic';
import { PackagingInspectorModal } from './PackagingInspectorModal';
import './approved.css';

export interface ReadyToExportViewProps {
  batchId: string;
  workspaceId?: number | string;
  onChanged?: () => void;
}

const PAGE_SIZE = STAGE_READ_LIMIT_DEFAULT;

type SectionKey = 'approved' | 'ready_to_export' | 'completed' | 'skipped';
type DraftFilter = 'all' | SectionKey;
type DraftLink = Pick<ChangeSetItem, 'id' | 'sku' | 'changeSetId'>;
interface SectionPage {
  items: OnboardingWorkState[];
  nextCursor: string | null;
  cursor: string | null;
  previous: Array<string | null>;
}
const SECTIONS: SectionKey[] = ['approved', 'ready_to_export', 'completed', 'skipped'];
const FILTER_LABELS: Record<DraftFilter, string> = {
  all: 'All outcomes', approved: 'Awaiting CMS drafts', ready_to_export: 'CMS drafts created',
  completed: 'Export verified', skipped: 'Skipped · all stages',
};
function emptyPages(): Record<SectionKey, SectionPage> {
  const page = (): SectionPage => ({ items: [], nextCursor: null, cursor: null, previous: [] });
  return { approved: page(), ready_to_export: page(), completed: page(), skipped: page() };
}
function isDraftFilter(value: unknown): value is DraftFilter {
  return value === 'all' || SECTIONS.includes(value as SectionKey);
}
function draftHref(sku: string): string {
  return `?view=catalog&product=${encodeURIComponent(sku)}`;
}
function changeSetHref(id: string): string {
  // The release screen has no record-specific URL. This links the actual persisted record.
  return `/api/change-sets/${encodeURIComponent(id)}`;
}

export function ReadyToExportView({ batchId, workspaceId = 'default', onChanged }: ReadyToExportViewProps) {
  // A keyed session also isolates late reads/commands when the host changes batch or workspace.
  return <DraftWorkspace key={JSON.stringify([String(workspaceId), batchId])}
    batchId={batchId} workspaceId={workspaceId} onChanged={onChanged} />;
}

function DraftWorkspace({ batchId, workspaceId = 'default', onChanged }: ReadyToExportViewProps) {
  const preferenceScope = useMemo(() => ({ workspaceId: String(workspaceId), batchId, stage: 'create_drafts' as const }), [workspaceId, batchId]);
  const [preferences] = useState(() => readStageViewPreferences(preferenceScope));
  const [pages, setPages] = useState(emptyPages);
  const pagesRef = useRef(pages);
  const [counts, setCounts] = useState<StageReadCountsResponse | null>(null);
  const [matchingCounts, setMatchingCounts] = useState<StageReadCountsResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftResult, setDraftResult] = useState<CreateExportDraftsResponse | null>(null);
  const [resultLinks, setResultLinks] = useState<DraftLink[]>([]);
  const [resultLinkError, setResultLinkError] = useState<string | null>(null);
  const [isDegraded, setIsDegraded] = useState(false);
  const [filterText, setFilterText] = useState(preferences?.q ?? '');
  const [activeTab, setActiveTab] = useState<DraftFilter>(isDraftFilter(preferences?.filters.category) ? preferences.filters.category : 'approved');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [inspectId, setInspectId] = useState<string | null>(preferences?.selectedId ?? null);
  const [inspectedLink, setInspectedLink] = useState<DraftLink | null>(null);
  const [inspectionLinkError, setInspectionLinkError] = useState<string | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [packagingInspectItem, setPackagingInspectItem] = useState<OnboardingWorkState | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const successfulIds = useRef(new Set<string>());
  const attempt = useRef<{ key: string; ids: string[] } | null>(null);
  const resultGeneration = useRef(0);
  const [retryPending, setRetryPending] = useState(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const bySection = useMemo(() => Object.fromEntries(SECTIONS.map(section => [section, pages[section].items])) as Record<SectionKey, OnboardingWorkState[]>, [pages]);
  const allItems = useMemo(() => SECTIONS.flatMap(section => pages[section].items), [pages]);
  const inspectItem = allItems.find(item => item.itemId === inspectId) ?? null;
  const setInspectItem = (item: OnboardingWorkState | null) => setInspectId(item?.itemId ?? null);
  const canSelect = !loading && !refreshing && !readError && !isDegraded && !busy;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    writeStageViewPreferences(preferenceScope, { filters: { category: activeTab }, q: filterText, selectedId: inspectId });
  }, [preferenceScope, activeTab, filterText, inspectId]);

  // One page per category; skipped deliberately has NO stage predicate.
  const loadSections = useCallback(async () => {
    const gen = ++generation.current;
    setRefreshing(true);
    try {
      const q = filterText.trim();
      const [rawCounts, rawMatching, ...rawPages] = await Promise.all([
        getStageReadCounts(batchId),
        q ? getStageReadCounts(batchId, { q }) : Promise.resolve(null),
        ...SECTIONS.map(category => getStageReadItems(batchId, { category, ...(q ? { q } : {}), limit: PAGE_SIZE })),
      ]);
      const full = StageReadCountsResponseSchema.parse(rawCounts);
      const matching = rawMatching ? StageReadCountsResponseSchema.parse(rawMatching) : full;
      const responses = rawPages.map(raw => StageReadItemsResponseSchema.parse(raw));
      if ([full, matching, ...responses].some(response => response.batchId !== batchId)) throw new Error('Draft read belongs to another batch. Refresh to try again.');
      if (responses.some((response, index) => response.items.some(item => item.category !== SECTIONS[index]))) throw new Error('Draft category scope did not match the requested page.');
      if (!alive.current || generation.current !== gen) return;
      const next = emptyPages();
      for (const [index, section] of SECTIONS.entries()) {
        next[section] = { ...next[section], items: responses[index].items, nextCursor: responses[index].nextCursor };
      }
      pagesRef.current = next;
      setPages(next);
      setCounts(full);
      setMatchingCounts(matching);
      setReadError(null);
      setIsDegraded([full, matching, ...responses].some(response => response.projectionHealth.status === 'degraded'));
      const eligible = new Set(next.approved.items.filter(item => !successfulIds.current.has(item.itemId)).map(item => item.itemId));
      setSelectedIds(prev => prev.filter(id => eligible.has(id)));
      const ids = new Set(SECTIONS.flatMap(section => next[section].items.map(item => item.itemId)));
      setInspectId(prev => prev && ids.has(prev) ? prev : null);
      setPackagingInspectItem(prev => prev ? SECTIONS.flatMap(section => next[section].items).find(item => item.itemId === prev.itemId) ?? null : null);
    } catch (err) {
      if (alive.current && generation.current === gen) setReadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current && generation.current === gen) { setLoading(false); setRefreshing(false); }
    }
  }, [batchId, filterText]);
  const refreshRef = useRef(loadSections);
  refreshRef.current = loadSections;

  useEffect(() => {
    let subscribed = true;
    void loadSections();
    const unsubscribe = subscribeBatchEvents(batchId, (event) => {
      if (subscribed && (event.type === 'item:status' || event.type === 'batch:progress' || event.type === 'batch:complete')) void loadSections();
    });
    return () => {
      subscribed = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [batchId, loadSections]);

  const pageSection = async (section: SectionKey, direction: 'next' | 'previous') => {
    if (refreshing || busy || readError) return;
    const page = pagesRef.current[section];
    const cursor = direction === 'next' ? page.nextCursor : page.previous.at(-1) ?? null;
    if (direction === 'next' ? !cursor : page.previous.length === 0) return;
    const gen = ++generation.current;
    setRefreshing(true);
    try {
      const response = StageReadItemsResponseSchema.parse(await getStageReadItems(batchId, {
        category: section, ...(filterText.trim() ? { q: filterText.trim() } : {}), limit: PAGE_SIZE, ...(cursor ? { cursor } : {}),
      }));
      if (response.batchId !== batchId) throw new Error('Draft page belongs to another batch.');
      if (response.items.some(item => item.category !== section)) throw new Error('Draft category scope did not match the requested page.');
      if (!alive.current || generation.current !== gen) return;
      const next = { ...pagesRef.current, [section]: {
        items: response.items, nextCursor: response.nextCursor, cursor,
        previous: direction === 'next' ? [...page.previous, page.cursor] : page.previous.slice(0, -1),
      } };
      pagesRef.current = next;
      setPages(next);
      setReadError(null);
      if (response.projectionHealth.status === 'degraded') setIsDegraded(true);
      if (section === 'approved') {
        const eligible = new Set(response.items.filter(item => !successfulIds.current.has(item.itemId)).map(item => item.itemId));
        setSelectedIds(prev => prev.filter(id => eligible.has(id)));
      }
      setInspectId(prev => prev && SECTIONS.some(key => next[key].items.some(item => item.itemId === prev)) ? prev : null);
      setPackagingInspectItem(null);
    } catch (err) {
      if (alive.current && generation.current === gen) setReadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current && generation.current === gen) setRefreshing(false);
    }
  };

  const readResultLinks = useCallback(async (result: CreateExportDraftsResponse) => {
    if (!result.changeSetId) return;
    const gen = ++resultGeneration.current;
    try {
      const persisted = await getChangeSet(result.changeSetId);
      if (!alive.current || resultGeneration.current !== gen) return;
      if (persisted.changeSet.id !== result.changeSetId) throw new Error('Change set identity did not match the draft receipt.');
      const created = new Set(result.created);
      const links = persisted.items.filter(item => {
        try { return item.changeSetId === result.changeSetId && created.has(JSON.parse(item.draftJson).itemId); } catch { return false; }
      }).map(({ id, sku, changeSetId }) => ({ id, sku, changeSetId }));
      setResultLinks(links);
      setResultLinkError(links.length < created.size ? 'Some draft records could not be linked. The receipt is retained; retry the record lookup.' : null);
    } catch (err) {
      if (alive.current && resultGeneration.current === gen) setResultLinkError(`Draft record lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const createDrafts = async (replay = false) => {
    if (busyRef.current || isDegraded || readError || refreshing) return;
    const eligible = new Set(pagesRef.current.approved.items.filter(item => !successfulIds.current.has(item.itemId)).map(item => item.itemId));
    const ids = selectedIds.filter(id => eligible.has(id));
    if (!replay && (retryPending || ids.length === 0)) return;
    if (!replay) attempt.current = { key: createIdempotencyKey(), ids };
    const current = attempt.current;
    if (!current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await createExportDrafts(batchId, current.ids, { idempotencyKey: current.key });
      if (!alive.current) return;
      attempt.current = null;
      setRetryPending(false);
      setDraftResult(res);
      resultGeneration.current += 1;
      setResultLinks([]);
      setResultLinkError(null);
      res.created.forEach(id => successfulIds.current.add(id));
      setSelectedIds(prev => prev.filter(id => !successfulIds.current.has(id)));
      void readResultLinks(res);
      await refreshRef.current();
      if (!alive.current) return;
      try { onChangedRef.current?.(); } catch {
        setError('CMS draft receipt recorded, but the batch summary refresh failed. Refresh the batch summary to try again.');
      }
    } catch (err) {
      if (!alive.current) return;
      setRetryPending(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const total = counts ? SECTIONS.reduce((sum, section) => sum + counts.counts[section], 0) : 0;
  // Search is server-owned and applies before pagination; badges remain full-batch totals.
  const filteredBySection = bySection;
  const visibleApproved = (activeTab === 'all' || activeTab === 'approved')
    ? bySection.approved.filter(item => !successfulIds.current.has(item.itemId)) : [];
  const projectionReceiptLag = bySection.approved.some(item => successfulIds.current.has(item.itemId));

  const allApprovedSelected =
    visibleApproved.length > 0 && visibleApproved.every((it) => selectedIds.includes(it.itemId));
  const toggleAllApproved = () => {
    if (!canSelect) return;
    setSelectedIds((prev) =>
      allApprovedSelected
        ? prev.filter((id) => !visibleApproved.some((it) => it.itemId === id))
        : [...new Set([...prev, ...visibleApproved.map((it) => it.itemId)])],
    );
  };

  const toggleItemSelection = (id: string) => {
    if (!canSelect || !pagesRef.current.approved.items.some(item => item.itemId === id) || successfulIds.current.has(id)) return;
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    );
  };

  useEffect(() => {
    let cancelled = false;
    setInspectedLink(null);
    setInspectionLinkError(null);
    if (!inspectItem || inspectItem.category === 'skipped') { setInspectionLoading(false); return; }
    const item = inspectItem;
    const receiptLink = resultLinks.find(link => link.sku === item.upc);
    if (receiptLink) { setInspectedLink(receiptLink); setInspectionLoading(false); return; }
    if (item.category === 'approved') { setInspectionLoading(false); return; }
    setInspectionLoading(true);
    void (async () => {
      try {
        const product = await getProduct(item.upc);
        if (cancelled) return;
        if (!product.hasDraft || !product.changeSetId) throw new Error('No active CMS draft link is available for this product.');
        const persisted = await getChangeSet(product.changeSetId);
        if (cancelled) return;
        const draft = persisted.items.find(row => row.sku === item.upc && row.changeSetId === product.changeSetId);
        if (!draft) throw new Error('The persisted change set no longer contains this product.');
        setInspectedLink({ id: draft.id, sku: draft.sku, changeSetId: draft.changeSetId });
      } catch (err) {
        if (!cancelled) setInspectionLinkError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setInspectionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [inspectItem, resultLinks]);

  // Close drawer on escape key
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectItem(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (loading) return <div className="ow-loading" role="status">Loading CMS draft status…</div>;
  if (readError && !counts) {
    return (
      <div className="ow-error" role="alert">
        <span>Draft status unavailable: {readError}</span>
        <button type="button" className="btn btn-outline" onClick={loadSections}>
          Retry
        </button>
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
            Create CMS drafts
            <span className="ow-count-pill">{total} products in draft creation and outcomes</span>
          </h4>
          <span className="ow-audit-line">
            Create CMS product drafts for approved listings. Change-set approval, export, and publication are separate steps.
          </span>
        </div>

        <div className="ow-funnel-metrics" role="group" aria-label="Draft status filters">
          {(['all', ...SECTIONS] as DraftFilter[]).map(section => (
            <button key={section} type="button" aria-pressed={activeTab === section}
              className={`ow-funnel-stat ${activeTab === section ? 'ow-funnel-stat--active' : ''}`}
              onClick={() => setActiveTab(section)}>
              <span className="ow-funnel-num">{section === 'all' ? total : counts?.counts[section] ?? '—'}</span>
              <span className="ow-funnel-label">{FILTER_LABELS[section]}</span>
            </button>
          ))}
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
            placeholder="Search intake name, brand, or UPC…"
            aria-label="Search batch products by intake name, brand, or UPC"
            value={filterText}
            onChange={(e) => { generation.current += 1; setRefreshing(true); setFilterText(e.target.value); }}
          />
          {filterText && (
            <button
              type="button"
              className="ow-search-clear"
              onClick={() => { generation.current += 1; setRefreshing(true); setFilterText(''); }}
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
        {(activeTab === 'all' || activeTab === 'approved') && (
          <div className="ow-toolbar-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={toggleAllApproved}
              disabled={!canSelect || visibleApproved.length === 0}
            >
              {allApprovedSelected ? 'Deselect loaded' : `Select loaded awaiting (${visibleApproved.length})`}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void createDrafts()}
              disabled={selectedIds.length === 0 || !canSelect || retryPending}
            >
              {busy ? 'Creating CMS drafts…' : `Create CMS drafts for selected (${selectedIds.length})`}
            </button>
          </div>
        )}
      </div>

      <p className="ow-detail">Status counts cover the full batch. Selection covers only loaded approved rows (up to {PAGE_SIZE} per page); it never selects the entire eligible batch.</p>
      <button type="button" className="btn btn-outline btn-sm" disabled={refreshing || busy} onClick={() => void loadSections()}>
        {refreshing ? 'Refreshing draft status…' : 'Refresh draft status'}
      </button>
      {readError && <div className="ow-error" role="alert">Showing stale draft status. {readError} Refresh before creating drafts.</div>}
      {isDegraded && <div className="ow-error" role="alert">Projection degraded — CMS draft creation is unavailable until a healthy refresh.</div>}
      {projectionReceiptLag && <p role="status" className="ow-detail">Confirmed CMS draft receipts exist for products the status projection still lists as awaiting drafts. Counts are server-reported; those products cannot be selected again in this session.</p>}
      {total === 0 && <div className="ow-empty"><strong>No draft creation or outcomes yet.</strong><span>Approved listings appear here when ready for CMS draft creation. Skipped products from every stage remain available here.</span></div>}
      {draftResult && (
        <div className="ow-section" aria-label="CMS draft operation results">
          <p role="status">CMS draft request: {draftResult.createdCount} created, {draftResult.rejectedCount} rejected.</p>
          <p className="ow-detail">Receipt: <code>{draftResult.receiptId}</code>. Draft creation does not export or publish products.</p>
          <ul>{draftResult.results.map(result => <li key={result.itemId}><code>{result.itemId}</code>: {result.status}{result.reason ? ` — ${result.reason}` : ''}</li>)}</ul>
          {draftResult.changeSetId && <p>Persisted change set: <a href={changeSetHref(draftResult.changeSetId)}>{draftResult.changeSetId}</a></p>}
          {resultLinks.length > 0 && <ul>{resultLinks.map(link => <li key={link.id}><a href={draftHref(link.sku)}>CMS draft {link.sku}</a> · Draft record <code>{link.id}</code></li>)}</ul>}
          {resultLinkError && <div role="alert">{resultLinkError} <button type="button" className="btn btn-outline btn-sm" onClick={() => void readResultLinks(draftResult)}>Retry draft record lookup</button></div>}
          {draftResult.changeSetId && <a href="?view=changesets">Continue release in Change Sets</a>}
        </div>
      )}
      {error && (
        <div className="ow-error" role="alert">
          <span>{error}</span>
          {retryPending && <><span> The outcome is unconfirmed. Retry the same request to recover its receipt.</span><button type="button" className="btn btn-outline btn-sm" disabled={busy || refreshing || isDegraded || Boolean(readError)} onClick={() => void createDrafts(true)}>Retry draft request</button></>}
        </div>
      )}

      {/* Sections rendering */}
      {sectionsToRender.map((section) => {
        const items = filteredBySection[section];
        const rawCount = matchingCounts?.counts[section] ?? 0;
        const pres = exportStatusPresentation(section);

        return (
          <div key={section} className={`ow-section ow-dashboard-section ow-section--${section}`}>
            <div className="ow-section-header">
              <div className="ow-section-header-left">
                <span className={`ow-section-badge ow-section-badge--${section}`} />
                <h5 className="ow-section-title">
                  {pres.heading}{' '}
                  <span className="ow-count-pill">
                    {rawCount} matching · {items.length} loaded
                  </span>
                </h5>
              </div>
            </div>
            <p className="ow-detail ow-section-desc">{pres.description}</p>

            {items.length === 0 ? (
              <div className="ow-no-matches">
                {pages[section].nextCursor ? 'No matching products in this page. Continue to the next page.' : `No ${FILTER_LABELS[section].toLowerCase()}${filterText ? ` matching "${filterText}"` : ''}.`}
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
                              disabled={!canSelect || successfulIds.current.has(item.itemId)}
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
                              CMS draft created
                            </span>
                          )}
                          {section === 'approved' && isSelected && (
                            <span className="ow-chip ow-chip--selected" style={{ fontSize: '0.6875rem' }}>
                              Selected
                            </span>
                          )}
                          {section === 'skipped' && <span className="ow-chip">Skipped · {item.stage}</span>}
                          {section === 'approved' && successfulIds.current.has(item.itemId) && <span className="ow-chip">CMS draft receipt recorded</span>}
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
                          Inspect listing
                        </button>
                        {section === 'ready_to_export' && (
                          <button type="button" className="ow-btn-link" onClick={() => setInspectItem(item)}>Inspect CMS draft links</button>
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
                            aria-label="Select all loaded approved products"
                            checked={allApprovedSelected}
                            disabled={!canSelect || visibleApproved.length === 0}
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
                                disabled={!canSelect || successfulIds.current.has(item.itemId)}
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
                              <button type="button" className="ow-btn-link" onClick={() => setInspectItem(item)}>Inspect CMS draft links</button>
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
                                {successfulIds.current.has(item.itemId) ? 'CMS draft receipt recorded' : isSelected ? 'Selected for CMS draft' : 'Awaiting CMS draft'}
                              </span>
                            )}
                            {section === 'skipped' && <span className="ow-chip">Skipped · {item.stage}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="ow-toolbar-actions" aria-label={`${pres.heading} pagination`}>
              <button type="button" className="btn btn-outline btn-sm" disabled={refreshing || busy || Boolean(readError) || pages[section].previous.length === 0}
                onClick={() => void pageSection(section, 'previous')}>Previous {pres.heading} page</button>
              <span className="ow-detail">Page {pages[section].previous.length + 1} · up to {PAGE_SIZE} products per page</span>
              <button type="button" className="btn btn-outline btn-sm" disabled={refreshing || busy || Boolean(readError) || !pages[section].nextCursor}
                onClick={() => void pageSection(section, 'next')}>Next {pres.heading} page</button>
            </div>
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
              <h4 className="ow-drawer-title">Listing details</h4>
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
              {inspectItem.category !== 'skipped' && <div className="ow-drawer-section">
                <h6 className="ow-drawer-section-title">CMS draft and release records</h6>
                {inspectionLoading ? <p role="status">Looking up persisted CMS draft…</p> : inspectedLink ? <>
                  <p><a href={draftHref(inspectedLink.sku)}>CMS draft {inspectedLink.sku}</a> · Draft record <code>{inspectedLink.id}</code></p>
                  <p><a href={changeSetHref(inspectedLink.changeSetId)}>Change set {inspectedLink.changeSetId}</a></p>
                  <a href="?view=changesets">Continue release in Change Sets</a>
                </> : <p>{inspectionLinkError ?? (inspectItem.category === 'approved' ? 'Approved; awaiting CMS draft creation.' : 'Persisted CMS draft link unavailable.')}</p>}
                {inspectItem.category === 'completed' && <p>Downstream export verified by the server. This does not establish publication status.</p>}
              </div>}
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
                  disabled={!canSelect || successfulIds.current.has(inspectItem.itemId)}
                  onClick={() => toggleItemSelection(inspectItem.itemId)}
                >
                  {selectedIds.includes(inspectItem.itemId) ? 'Deselect Item' : 'Select for Draft Creation'}
                </button>
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
                  ...filteredBySection.skipped,
                ]
              : filteredBySection[activeTab]
          }
          onClose={() => setPackagingInspectItem(null)}
          onNavigate={setPackagingInspectItem}
          onToggleSelection={canSelect && packagingInspectItem.category === 'approved' && !successfulIds.current.has(packagingInspectItem.itemId) ? toggleItemSelection : undefined}
          isSelected={selectedIds.includes(packagingInspectItem.itemId)}
        />
      )}
    </div>
  );
}
