import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colors, fonts, typography } from '../../theme';
import { subscribeBatchEvents } from '../../onboarding-work-api';
import { getBatch } from '../../onboarding-api';
import { getStageReadCounts } from '../../onboarding-stage-api';
import type { WorkStateCounts, WorkStateProjectionHealth } from '../../../shared/schemas/onboarding-work-state';
import type { StageStatusMatrix } from '../../../shared/schemas/onboarding-stage-read';
import { getOnboardingFeatureFlags } from '../../onboarding-feature-flags';
import { LINEAR_STAGES, parseWorkspaceSelection, resolveLegacyTabDestination, type LinearStageId } from './linear-workspace-logic';
import { readLastWorkspaceStage, readStageViewPreferences, rememberWorkspaceStage, writeStageViewPreferences } from './workspace-view-state';
import { StageNavigation } from './StageNavigation';
import { StageItemsView } from './StageItemsView';
import { PrepareListingView } from './PrepareListingView';
import { ReviewWorkspace } from './review/ReviewWorkspace';
import { ReadyToExportView } from './approved/ReadyToExportView';
import { AttentionQueueView } from './attention/AttentionQueueView';
import { OfficialSiteResolutionWorkspace } from './attention/OfficialSiteResolutionWorkspace';
import { BatchExecutionControls } from './BatchExecutionControls';
import { ExecutionStrip } from './ExecutionStrip';
import './onboarding-workspace.css';

const COUNT_REFRESH_DEBOUNCE_MS = 400;

export interface BatchWorkspaceProps {
  batchId: string;
  batchName: string;
  workspaceId?: string;
  onBack: () => void;
  onOpenSettings?: () => void;
  onOpenProfileBuilder?: (domain: string) => void;
}

function writeSearch(mutator: (params: URLSearchParams) => void, push: boolean) {
  const url = new URL(window.location.href);
  mutator(url.searchParams);
  window.history[push ? 'pushState' : 'replaceState'](null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function sumStageMatrixColumn(matrix: StageStatusMatrix, stage: LinearStageId) {
  return Object.values(matrix[stage]).reduce((total, count) => total + count, 0);
}

/** One shell, six working screens. Exceptions never replace the active stage. */
export function BatchWorkspace(props: BatchWorkspaceProps) {
  if (!getOnboardingFeatureFlags().shellV2Enabled) {
    return <div data-testid="shell-disabled-notice" className="bws-shell">
      <button type="button" className="bws-filter-input" onClick={props.onBack}>← Batches</button>
      <h1 style={typography.viewTitle}>{props.batchName}</h1>
      <p role="status">The onboarding workspace is disabled by configuration (<code>VITE_ONBOARDING_SHELL_V2=false</code>).
        Rebuild with the shell enabled, or restore the archived matching bridge client.</p>
      {props.onOpenSettings && <button type="button" className="bws-filter-input" onClick={props.onOpenSettings}>Settings</button>}
    </div>;
  }
  return <WorkingShell key={JSON.stringify([props.workspaceId, props.batchId])} {...props} />;
}

function WorkingShell({ batchId, batchName, workspaceId: suppliedWorkspaceId, onBack, onOpenSettings, onOpenProfileBuilder }: BatchWorkspaceProps) {
  const [selection, setSelection] = useState(() => parseWorkspaceSelection(window.location.search));
  const [workspaceId, setWorkspaceId] = useState(suppliedWorkspaceId);
  const [stageCounts, setStageCounts] = useState<Record<LinearStageId, number> | null>(null);
  const [counts, setCounts] = useState<WorkStateCounts | null>(null);
  const [projectionHealth, setProjectionHealth] = useState<WorkStateProjectionHealth | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [executionState, setExecutionState] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [attentionOpen, setAttentionOpen] = useState(() => new URLSearchParams(window.location.search).get('attention') === '1');
  const [attentionItemId, setAttentionItemId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('issue'));
  const [visited, setVisited] = useState<Set<LinearStageId>>(() => new Set());
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const lastStage = useRef<LinearStageId>('route_sources');
  const refreshGeneration = useRef(0);

  const refreshCounts = useCallback(async () => {
    const gen = ++refreshGeneration.current;
    try {
      const response = await getStageReadCounts(batchId);
      if (!alive.current || gen !== refreshGeneration.current) return;
      setStageCounts(Object.fromEntries(LINEAR_STAGES.map(({ id }) => [id, sumStageMatrixColumn(response.stageStatusMatrix, id)])) as Record<LinearStageId, number>);
      setCounts(response.counts);
      setProjectionHealth(response.projectionHealth);
      setCountsError(null);
    } catch (error) {
      if (alive.current && gen === refreshGeneration.current) setCountsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current && gen === refreshGeneration.current) setUpdating(false);
    }
  }, [batchId]);

  const refreshBatch = useCallback(async () => {
    try {
      const response = await getBatch(batchId);
      if (!alive.current) return;
      setExecutionState(response?.batch?.executionState ?? null);
      if (response?.batch?.workspaceId) setWorkspaceId(response.batch.workspaceId);
    } catch { /* Execution permission stays unknown or last-known; counts have their own error. */ }
  }, [batchId]);

  useEffect(() => {
    alive.current = true;
    void refreshCounts();
    void refreshBatch();
    const onPop = () => {
      setSelection(parseWorkspaceSelection(window.location.search));
      const params = new URLSearchParams(window.location.search);
      setAttentionOpen(params.get('attention') === '1');
      setAttentionItemId(params.get('issue'));
    };
    window.addEventListener('popstate', onPop);
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (timer.current) clearTimeout(timer.current);
      setUpdating(true);
      timer.current = setTimeout(() => { void refreshCounts(); void refreshBatch(); setRefreshKey(key => key + 1); }, COUNT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      alive.current = false;
      refreshGeneration.current += 1;
      if (timer.current) clearTimeout(timer.current);
      unsubscribe();
      window.removeEventListener('popstate', onPop);
    };
  }, [batchId, refreshCounts, refreshBatch]);

  const scope = { workspaceId: workspaceId ?? '', batchId };
  const remembered = workspaceId ? readLastWorkspaceStage(scope) : null;
  const legacy = selection.kind === 'legacy' ? resolveLegacyTabDestination(selection.rawTab) : null;
  let activeStage: LinearStageId = selection.kind === 'stage' ? selection.stage : remembered ?? lastStage.current;
  if (selection.kind === 'unsupported' || selection.kind === 'brand-setup' || legacy?.kind === 'unsupported') activeStage = 'route_sources';
  if (legacy?.kind === 'stage') activeStage = selection.kind === 'legacy' && selection.rawTab === null
    ? remembered ?? legacy.stage : legacy.stage;
  if (legacy?.kind === 'operation') {
    if (legacy.view === 'review' || legacy.view === 'approved') activeStage = 'review_listings';
    if (legacy.view === 'export') activeStage = 'create_drafts';
    if (legacy.view === 'family') activeStage = 'prepare_listing';
  }
  if (legacy?.kind === 'outcome') activeStage = 'create_drafts';

  // Canonicalize old task links once. Preferences carry explicit old facets,
  // while the URL remains a stage destination rather than another workspace.
  useEffect(() => {
    if (selection.kind !== 'legacy' && selection.kind !== 'brand-setup') return;
    if (legacy?.kind === 'unsupported') return;
    const destination = legacy?.kind === 'operation' ? legacy.view : legacy?.kind === 'outcome' ? legacy.outcome : null;
    if (workspaceId && destination && destination !== 'attention' && destination !== 'processing') {
      const stageScope = { ...scope, stage: activeStage };
      const previous = readStageViewPreferences(stageScope);
      const filter = destination === 'approved' ? { reviewState: 'reviewed' }
        : destination === 'review' ? { reviewState: 'unreviewed' }
        : destination === 'family' ? { category: 'waiting_on_family' }
        : { category: destination === 'export' ? 'all' : destination };
      writeStageViewPreferences(stageScope, { q: previous?.q ?? '', selectedId: previous?.selectedId ?? null, filters: { ...previous?.filters, ...filter } });
    }
    if (destination && destination !== 'attention' && !workspaceId) return;
    writeSearch(params => {
      params.delete('tab'); params.delete('wview');
      params.set('stage', activeStage); params.set('stageVersion', '2');
      if (destination === 'attention') params.set('attention', '1');
    }, false);
  }, [selection, activeStage, workspaceId]); // scope is a preference value, not an effect trigger

  useEffect(() => {
    if (selection.kind !== 'stage') return;
    lastStage.current = activeStage;
    if (workspaceId) rememberWorkspaceStage({ workspaceId, batchId }, activeStage);
    setVisited(previous => previous.has(activeStage) ? previous : new Set([...previous, activeStage]));
  }, [selection, activeStage, workspaceId, batchId]);

  const navigateStage = (stage: LinearStageId) => writeSearch(params => {
    params.delete('tab'); params.delete('wview'); params.delete('attention'); params.delete('issue');
    params.set('stage', stage); params.set('stageVersion', '2');
  }, true);
  const openAttention = useCallback((itemId?: string) => writeSearch(params => {
    params.set('attention', '1');
    if (itemId) params.set('issue', itemId); else params.delete('issue');
  }, true), []);
  const closeAttention = () => writeSearch(params => { params.delete('attention'); params.delete('issue'); }, true);
  const changed = useCallback(() => {
    setRefreshKey(key => key + 1);
    void refreshCounts();
  }, [refreshCounts]);
  const leave = (action: () => void) => {
    if (shellRef.current?.querySelector('[data-onboarding-dirty="true"]') && !window.confirm('Leave this batch and discard unsaved edits?')) return;
    action();
  };
  const stages = LINEAR_STAGES.filter(stage => stage.id === activeStage || visited.has(stage.id));
  const unsupported = selection.kind === 'unsupported' ? selection.reason
    : legacy?.kind === 'unsupported' ? `Unknown destination ${legacy.reportedTab}` : null;
  const canonicalPending = !unsupported && (selection.kind === 'legacy' || selection.kind === 'brand-setup');

  return <div data-testid="linear-shell" className="bws-shell" ref={shellRef} style={{ fontFamily: fonts.body, color: colors.ledgerCharcoal }}>
    <header className="bws-header">
      <div className="bws-header-identity">
        <button type="button" className="bws-filter-input" onClick={() => leave(onBack)} aria-label="Back to batches">← Batches</button>
        <h1 style={{ ...typography.viewTitle, margin: 0, fontSize: '1.25rem' }}>{batchName}</h1>
        {updating && <span role="status" className="bws-muted">Updating…</span>}
      </div>
      <div className="bws-header-controls">
        <button type="button" className="bws-filter-input bws-attention-trigger" aria-haspopup="dialog" aria-expanded={attentionOpen}
          onClick={() => openAttention()} data-testid="batch-attention-trigger">
          Needs attention · {counts ? counts.needs_attention.toLocaleString() : '—'}{countsError && counts ? ' (stale)' : ''}
        </button>
        <BatchExecutionControls batchId={batchId} executionState={executionState} onChanged={setExecutionState} compact />
        {onOpenSettings && <button type="button" className="bws-filter-input" onClick={() => leave(onOpenSettings)}>Settings</button>}
      </div>
    </header>
    {countsError && <div role="alert" className="bws-read-error">Could not load stage counts: {countsError}
      <button type="button" className="bws-filter-input" onClick={() => void refreshCounts()}>Retry counts</button></div>}
    {getOnboardingFeatureFlags().executionStripV2Enabled && <ExecutionStrip batchId={batchId} />}
    {projectionHealth?.status === 'degraded' && <p role="status">Some batch facts are unavailable. Approval and draft controls use their current eligibility reads.</p>}
    {unsupported && <div role="alert" data-testid="unsupported-link-notice">Unsupported link: {unsupported}. Showing Identify &amp; Route Sources.
      <button type="button" className="bws-filter-input" onClick={() => navigateStage('route_sources')}>Go to Identify &amp; Route Sources</button></div>}
    {stageCounts ? <StageNavigation activeStage={activeStage} stageCounts={stageCounts} countsStale={!!countsError} onSelect={navigateStage} />
      : !countsError && <p role="status">Loading stages…</p>}
    {stageCounts && !canonicalPending && stages.map(({ id }) => <div key={id} hidden={id !== activeStage} className="bws-working-screen"
      id={`bws-stage-panel-${id}`} role="tabpanel" aria-labelledby={`bws-stage-tab-${id}`} data-testid={`working-stage-${id}`}>
      {id === 'review_listings' ? <ReviewWorkspace batchId={batchId} workspaceId={workspaceId} onChanged={changed} />
        : id === 'create_drafts' ? <ReadyToExportView batchId={batchId} workspaceId={workspaceId} onChanged={changed} />
        : id === 'prepare_listing' ? <PrepareListingView batchId={batchId} workspaceId={workspaceId} refreshKey={refreshKey} onOpenAttentionItem={openAttention} />
        : <StageItemsView batchId={batchId} stage={id} workspaceId={workspaceId} refreshKey={refreshKey} onOpenAttentionItem={openAttention}
          onOpenSettings={onOpenSettings ? () => leave(onOpenSettings) : undefined}
          onOpenProfileBuilder={onOpenProfileBuilder ? domain => leave(() => onOpenProfileBuilder(domain)) : undefined} />}
    </div>)}
    {attentionOpen && <AttentionPanel batchId={batchId} itemId={attentionItemId} onClose={closeAttention}
      onOpenItem={item => openAttention(item)} onBackToIssues={() => writeSearch(params => params.delete('issue'), true)}
      onResolved={() => { changed(); writeSearch(params => params.delete('issue'), false); }} />}
  </div>;
}

function AttentionPanel({ batchId, itemId, onClose, onOpenItem, onBackToIssues, onResolved }: {
  batchId: string; itemId: string | null; onClose: () => void; onOpenItem: (id: string) => void;
  onBackToIssues: () => void; onResolved: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
      .filter(element => !element.closest('[hidden]'));
    const first = buttons[0], last = buttons.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="bws-overlay" onKeyDown={onKeyDown}>
    <div className="bws-drawer bws-attention-panel" ref={container} role="dialog" aria-modal="true" aria-labelledby="batch-attention-title" data-testid="batch-attention-panel">
      <header className="bws-attention-heading"><div><h2 id="batch-attention-title">{itemId ? 'Resolve product issue' : 'Needs attention'}</h2>
        <p className="bws-muted">Entire batch · your working stage stays in place</p></div>
        <button ref={close} type="button" className="bws-filter-input" onClick={onClose} aria-label="Close attention panel">Close</button></header>
      <div className="bws-attention-body">
        {itemId ? <><button type="button" className="bws-filter-input" onClick={onBackToIssues}>← All issues</button>
          <OfficialSiteResolutionWorkspace key={itemId} batchId={batchId} itemId={itemId} onResolved={onResolved} /></>
          : <AttentionQueueView batchId={batchId} onOpenItem={onOpenItem} />}
      </div>
    </div>
  </div>;
}
