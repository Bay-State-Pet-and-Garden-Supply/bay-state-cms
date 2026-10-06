import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import type { PreparationSummary } from '../../../shared/schemas/onboarding-preparation';
import type { StageReadCountsResponse, StageReadItemsResponse } from '../../../shared/schemas/onboarding-stage-read';
import { getStageReadCounts, getStageReadItems, type StageReadQuery } from '../../onboarding-stage-api';
import { getItemWorkState, subscribeBatchEvents } from '../../onboarding-work-api';
import {
  PREPARATION_FILTERS, preparationCategoryFilter, preparationStatusLabel, preparationSummary,
  type PreparationCategoryFilter,
} from './prepare-listing-logic';
import { readStageViewPreferences, writeStageViewPreferences } from './workspace-view-state';
import { PreparationItemDetails } from './PreparationItemDetails';

export interface PrepareListingViewProps {
  batchId: string;
  workspaceId?: string;
  /** The batch shell opens its attention panel without replacing this view. */
  onOpenAttentionItem?: (itemId: string) => void;
  /** Increment after resolving a task in the shell's attention panel. */
  refreshKey?: number;
  /** Compatibility for older callers; preparation never navigates through these. */
  onOpenOperation?: (view: 'attention' | 'family' | 'review') => void;
  onOpenFullBatchReview?: () => void;
}

interface SelectedProduct {
  item: OnboardingWorkState;
  summary: PreparationSummary;
}

interface ReadState {
  scope: string;
  loading: boolean;
  page: StageReadItemsResponse | null;
  matching: StageReadCountsResponse | null;
  statuses: StageReadCountsResponse | null;
  error: string | null;
  countsError: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load preparation products.';
}

export function PrepareListingView(props: PrepareListingViewProps) {
  // Scope changes remount preferences and cancel every pending read together.
  return <PreparationProducts key={JSON.stringify([props.workspaceId, props.batchId])} {...props} />;
}

function PreparationProducts({ batchId, workspaceId, onOpenAttentionItem, refreshKey = 0 }: PrepareListingViewProps) {
  const preferenceScope = { workspaceId: workspaceId ?? '', batchId, stage: 'prepare_listing' as const };
  const [remembered] = useState(() => readStageViewPreferences(preferenceScope));
  const [q, setQ] = useState(remembered?.q ?? '');
  const [search, setSearch] = useState(q);
  const [category, setCategory] = useState<PreparationCategoryFilter>(() => preparationCategoryFilter(remembered?.filters.category));
  const [selectedId, setSelectedId] = useState<string | null>(remembered?.selectedId ?? null);
  const [selected, setSelected] = useState<SelectedProduct | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [correctionDirty, setCorrectionDirty] = useState(false);
  const correctionDirtyRef = useRef(false);
  const [dirtyContextStale, setDirtyContextStale] = useState(false);
  const correctionChanged = useCallback((dirty: boolean) => {
    correctionDirtyRef.current = dirty;
    setCorrectionDirty(dirty);
  }, []);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1];
  const [revision, setRevision] = useState(0);
  const [projectionRevision, setProjectionRevision] = useState(0);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [contextContinuation, setContextContinuation] = useState<{ itemId: string; q: string; cursor: string } | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const readEpoch = useRef(0);
  const scope = JSON.stringify([q, category, cursor]);
  const [read, setRead] = useState<ReadState>({
    scope, loading: true, page: null, matching: null, statuses: null, error: null, countsError: null,
  });

  useEffect(() => {
    writeStageViewPreferences(preferenceScope, { q, filters: { category }, selectedId });
  }, [workspaceId, batchId, q, category, selectedId]);

  useEffect(() => {
    let active = true;
    readEpoch.current += 1;
    setContextContinuation(null);
    setContextLoading(false);
    setRead(previous => ({
      ...previous, scope, loading: true, error: null, countsError: null,
      ...(previous.scope !== scope ? { page: null, matching: null, statuses: null } : {}),
    }));
    const base: StageReadQuery = { stage: 'prepare_listing', ...(q ? { q } : {}) };
    const filters: StageReadQuery = { ...base, ...(category ? { category } : {}) };
    void (async () => {
      const [pageResult, matchingResult, statusResult] = await Promise.allSettled([
        getStageReadItems(batchId, { ...filters, limit: 50, ...(cursor ? { cursor } : {}) }),
        getStageReadCounts(batchId, filters),
        category ? getStageReadCounts(batchId, base) : Promise.resolve(null),
      ]);
      if (!active) return;
      const matching = matchingResult.status === 'fulfilled' && matchingResult.value.batchId === batchId ? matchingResult.value : null;
      const statuses = category
        ? statusResult.status === 'fulfilled' && statusResult.value?.batchId === batchId ? statusResult.value : null
        : matching;
      const countsError = !matching || !statuses ? 'Product counts are unavailable. Refresh to try again.' : null;
      if (pageResult.status === 'rejected') {
        setRead(previous => ({ ...previous, loading: false, error: errorMessage(pageResult.reason), countsError, matching, statuses }));
        return;
      }
      const page = pageResult.value;
      if (page.batchId !== batchId) {
        setRead(previous => ({ ...previous, loading: false, error: 'The preparation response belongs to a different batch.' }));
        return;
      }
      const id = selectedIdRef.current;
      let product = id ? page.items.find(item => item.itemId === id) : page.items[0];
      let summary = product ? preparationSummary(page.preparationByItem?.[product.itemId]) : null;
      // A selected product on another page is inspector context, not list
      // membership. Revalidate it with a bounded server stage read by identity.
      if (id && !product) {
        try {
          const { workState } = await getItemWorkState(id);
          if (workState.itemId !== id || !workState.upc) throw new Error('Product identity is unavailable.');
          const context = await getStageReadItems(batchId, {
            stage: 'prepare_listing', ...(category ? { category } : {}), q: workState.upc, limit: 50,
          });
          if (!active || selectedIdRef.current !== id) return;
          if (context.batchId !== batchId) throw new Error('Product context belongs to a different batch.');
          product = context.items.find(item => item.itemId === id);
          summary = product ? preparationSummary(context.preparationByItem?.[id]) : null;
          if (!product && context.nextCursor) {
            // A bounded sparse page is not evidence that selection is invalid.
            // Continue only on request; never drain an identity lookup either.
            setContextContinuation({ itemId: id, q: workState.upc, cursor: context.nextCursor });
            setSelectionNotice('The selected product has not been reached in this bounded context read. Continue its lookup to refresh details.');
            setRead({ scope, page, matching, statuses, countsError, loading: false, error: null });
            return;
          }
          setSelectionNotice(product ? null : 'The selected product is no longer in this preparation scope. Select another product.');
        } catch {
          if (!active || selectedIdRef.current !== id) return;
          // A failed context read is not proof that the item moved stages.
          setRead(previous => ({ ...previous, page, matching, statuses, countsError, loading: false,
            error: 'Could not refresh the selected product. Its last preparation facts are stale. Refresh to try again.' }));
          return;
        }
      }
      if (!active || selectedIdRef.current !== id) return;
      if (correctionDirtyRef.current && selectedRef.current?.item.itemId === id) {
        // Keep the editor's bound request and values until the operator decides
        // to discard them. Fresh page/count reads must not remount its form.
        const changed = !product || JSON.stringify(selectedRef.current.summary.gap) !== JSON.stringify(summary?.gap);
        setDirtyContextStale(changed);
        if (changed) setSelectionNotice('The listing request changed while you worked. Your pending correction is retained; discard it to load the current request.');
        setRead({ scope, page, matching, statuses, countsError, loading: false, error: null });
        return;
      }
      setDirtyContextStale(false);
      setSelected(product && summary ? { item: product, summary } : null);
      setSelectedId(product?.itemId ?? null);
      setProjectionRevision(value => value + 1);
      setRead({ scope, page, matching, statuses, countsError, loading: false, error: null });
    })();
    return () => { active = false; readEpoch.current += 1; };
  }, [batchId, scope, revision, refreshKey]);

  useEffect(() => {
    // Coalesce worker bursts; events trigger fresh authoritative reads only.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision(value => value + 1), 150);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [batchId]);

  const current = read.scope === scope;
  const page = current ? read.page : null;
  const busy = !current || read.loading;
  const stale = (busy && !correctionDirty) || dirtyContextStale || !!read.error || !!contextContinuation || page?.projectionHealth.status === 'degraded';
  const discardCorrection = () => {
    if (!correctionDirtyRef.current) return true;
    if (!window.confirm('Discard unsaved listing corrections for this product?')) return false;
    correctionChanged(false);
    setDirtyContextStale(false);
    return true;
  };
  const changeFilter = (nextQ: string, nextCategory: PreparationCategoryFilter) => {
    if (nextQ === q && nextCategory === category) return;
    if (!discardCorrection()) return;
    setQ(nextQ);
    setCategory(nextCategory);
    setCursors([null]);
    setSelectedId(null);
    setSelected(null);
    setSelectionNotice(null);
    setContextContinuation(null);
  };

  const continueSelectedContext = async () => {
    if (!contextContinuation || contextLoading) return;
    const lookup = contextContinuation;
    const epoch = readEpoch.current;
    setContextLoading(true);
    try {
      const context = await getStageReadItems(batchId, {
        stage: 'prepare_listing', ...(category ? { category } : {}), q: lookup.q, cursor: lookup.cursor, limit: 50,
      });
      if (epoch !== readEpoch.current || selectedIdRef.current !== lookup.itemId) return;
      if (context.batchId !== batchId) throw new Error('Different batch');
      const product = context.items.find(item => item.itemId === lookup.itemId);
      if (product) {
        setSelected({ item: product, summary: preparationSummary(context.preparationByItem?.[product.itemId]) });
        setProjectionRevision(value => value + 1);
        setContextContinuation(null);
        setSelectionNotice(null);
      } else if (context.nextCursor) {
        setContextContinuation({ ...lookup, cursor: context.nextCursor });
      } else {
        setSelected(null);
        setSelectedId(null);
        setContextContinuation(null);
        setSelectionNotice('The selected product is no longer in this preparation scope. Select another product.');
      }
    } catch {
      if (epoch === readEpoch.current && selectedIdRef.current === lookup.itemId) {
        setSelectionNotice('Selected product context is unavailable. Continue its lookup to try again.');
      }
    } finally {
      if (epoch === readEpoch.current) setContextLoading(false);
    }
  };

  return (
    <div className="bws-preparation" data-testid="prepare-listing-view" data-onboarding-dirty={correctionDirty ? 'true' : 'false'}>
      <header className="bws-preparation-header" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 8px' }}>Prepare listing</h2>
          <p className="bws-muted" data-testid="preparation-scope">
            {current && read.matching ? `${read.matching.matchingTotal} ${read.matching.matchingTotal === 1 ? 'product' : 'products'} in this preparation scope` : 'Preparation product count unavailable'}
          </p>
        </div>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh preparation</button>
      </header>
      <form aria-label="Search preparation products" onSubmit={event => { event.preventDefault(); changeFilter(search.trim(), category); }}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <label htmlFor="preparation-search">Search products</label>
        <input id="preparation-search" type="search" value={search} maxLength={500} onChange={event => setSearch(event.target.value)} />
        <button type="submit" className="btn btn-outline">Search</button>
      </form>
      <div className="bws-preparation-filters" role="group" aria-label="Preparation status" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {PREPARATION_FILTERS.map(filter => (
          <button key={filter.category} type="button" className="btn btn-outline" aria-pressed={category === filter.category}
            onClick={() => changeFilter(q, filter.category)}>
            {filter.label} ({current && read.statuses
              ? filter.category ? read.statuses.counts[filter.category] : read.statuses.matchingTotal
              : 'unavailable'})
          </button>
        ))}
      </div>
      {current && read.countsError && <p role="alert">{read.countsError}</p>}
      {current && (read.matching?.projectionHealth.status === 'degraded' || read.statuses?.projectionHealth.status === 'degraded')
        && <p role="status">Preparation counts are degraded. Totals reflect the server’s reported scope.</p>}
      {current && read.error && <p role="alert">{read.error} {page ? 'Last reported products are shown below.' : 'Refresh to try again.'}</p>}
      {page?.projectionHealth.status === 'degraded' && <p role="status">Preparation facts are unavailable or degraded for some products. No readiness is inferred.</p>}
      {selectionNotice && <p role="status">{selectionNotice}</p>}
      {correctionDirty && <button type="button" className="btn btn-outline" onClick={() => {
        if (!discardCorrection()) return;
        setSelected(null);
        setRevision(value => value + 1);
      }}>Discard pending correction</button>}
      {contextContinuation && <button type="button" className="btn btn-outline" disabled={busy || contextLoading}
        onClick={() => void continueSelectedContext()}>Continue selected product lookup</button>}
      <div className="bws-preparation-layout" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <section aria-label="Preparation products" className="bws-preparation-products" aria-busy={busy}
          style={{ flex: '1 1 320px', minWidth: 0 }}>
          {busy && <p role="status">Loading preparation products…</p>}
          {page && page.items.length === 0 && !busy && !read.error && (
            <p>{page.nextCursor ? 'No matching products in this read page. Continue to the next page.' : 'No products on this page match the preparation filters.'}</p>
          )}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(page?.items ?? []).map(item => (
              <li key={item.itemId} className="bws-preparation-product" style={{ borderBottom: '1px solid var(--color-card-border)', padding: '12px 0' }}>
                <button type="button" className="btn btn-outline" aria-pressed={selectedId === item.itemId} disabled={busy}
                  onClick={() => {
                    if (selectedIdRef.current === item.itemId || !discardCorrection()) return;
                    setSelectedId(item.itemId);
                    setSelected({ item, summary: preparationSummary(page?.preparationByItem?.[item.itemId]) });
                    setSelectionNotice(null);
                    setContextContinuation(null);
                  }}>
                  {item.curatedTitle ?? item.name}
                </button>
                <p style={{ margin: '8px 0 0' }}>{item.upc}{item.brand ? ` · ${item.brand}` : ''}</p>
                <p style={{ margin: '4px 0' }}><strong>{preparationStatusLabel(item.category)}</strong> · {item.label}</p>
                {item.detail && <p className="bws-muted" style={{ margin: 0 }}>{item.detail}</p>}
              </li>
            ))}
          </ul>
          <nav aria-label="Preparation pagination" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 16 }}>
            <button type="button" className="btn btn-outline" disabled={busy || cursors.length === 1}
              onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous products</button>
            <span>Read page {cursors.length}</span>
            <button type="button" className="btn btn-outline" disabled={busy || !page?.nextCursor}
              onClick={() => { if (page?.nextCursor) setCursors(previous => [...previous, page.nextCursor]); }}>Next products</button>
          </nav>
        </section>
        <section aria-label="Selected product preparation" className="bws-preparation-selected" style={{ flex: '2 1 440px', minWidth: 0, overflowWrap: 'anywhere' }}>
          {selected ? <>
            {page && !page.items.some(item => item.itemId === selected.item.itemId) && <p className="bws-muted">Selected product context from another read page.</p>}
            <PreparationItemDetails key={selected.item.itemId} batchId={batchId} workspaceId={workspaceId}
              item={selected.item} summary={selected.summary} stale={stale} refreshKey={projectionRevision}
               onOpenAttentionItem={onOpenAttentionItem}
               onCorrectionDirtyChange={correctionChanged}
              onChanged={() => { if (selectedIdRef.current === selected.item.itemId) setRevision(value => value + 1); }} />
          </> : <p className="bws-muted">Select a product to see its evidence, proposed listing, and family readiness.</p>}
        </section>
      </div>
    </div>
  );
}
