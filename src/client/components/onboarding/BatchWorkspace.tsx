import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colors, fonts, rounded, typography } from '../../theme';
import { subscribeBatchEvents } from '../../onboarding-work-api';
import type {
  WorkStateCounts,
  WorkStateProjectionHealth,
} from '../../../shared/schemas/onboarding-work-state';
import { attentionIsUrgent, formatCount } from './batch-workspace-logic';
import { getOnboardingFeatureFlags } from '../../onboarding-feature-flags';
import {
  parseWorkspaceSelection,
  resolveLegacyTabDestination,
  type LinearStageId,
  type OperationViewId,
} from './linear-workspace-logic';
import { ExecutionStrip } from './ExecutionStrip';
import { BatchExecutionControls } from './BatchExecutionControls';
import { getBatch } from '../../onboarding-api';
import { StageNavigation } from './StageNavigation';
import { StageItemsView } from './StageItemsView';
import { OutcomeItemsView } from './OutcomeItemsView';
import { PrepareListingView } from './PrepareListingView';
import {
  getStageReadCounts,
  type StageReadQuery,
} from '../../onboarding-stage-api';
import type { StageStatusMatrix } from '../../../shared/schemas/onboarding-stage-read';

// ── Sibling feature views (epic #46 wave 2 contract) ─────────────────────────
import { AttentionQueueView } from './attention/AttentionQueueView';
import { OfficialSiteResolutionWorkspace } from './attention/OfficialSiteResolutionWorkspace';
import { ProcessingView } from './processing/ProcessingView';
import { FamilyWaitingView } from './families/FamilyWaitingView';
import { ReviewWorkspace } from './review/ReviewWorkspace';
import { ApprovedView } from './approved/ApprovedView';
import { ReadyToExportView } from './approved/ReadyToExportView';

import './onboarding-workspace.css';

const COUNT_REFRESH_DEBOUNCE_MS = 400;

export interface BatchWorkspaceProps {
  batchId: string;
  batchName: string;
  onBack: () => void;
  /** Opens the Onboarding settings page (extractor profiles, distributors…). */
  onOpenSettings?: () => void;
}

/**
 * Epic #46 — Batch Workspace (UX workstream 1).
 *
 * The Store Manager's primary onboarding surface. Automation owns
 * progression; this shell shows exactly where the operator is needed
 * (Needs Attention), what is progressing on its own (Processing), what is
 * gated on families (Waiting on Family), what awaits final inspection
 * (Review), and what has been released (Approved / Ready to Export).
 *
 * Raw pipeline stage/stage_status are secondary diagnostics only.
 */

export function BatchWorkspace({ batchId, batchName, onBack, onOpenSettings }: BatchWorkspaceProps) {
  // Slice 7: BatchWorkspace is the sole shell and the temporary classic
  // work-state-primary navigation branch is removed (fallback release
  // archived). The linear six-stage navigation is primary; batch-wide
  // operation/outcome destinations live behind one compact Batch tools
  // disclosure in the batch header (grouped links, never a second tablist).
  // shellV2Enabled=false is an emergency
  // disabled-content state (header + rollback instruction, no
  // brand/strip/old navigation), not a permanent competing primary shell —
  // restore classic navigation via the archived matching bridge client.
  const linearEnabled = getOnboardingFeatureFlags().shellV2Enabled;
  if (linearEnabled) {
    return (
      <LinearShell
        batchId={batchId}
        batchName={batchName}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
      />
    );
  }
  return (
    <ShellDisabledNotice
      batchName={batchName}
      onBack={onBack}
      onOpenSettings={onOpenSettings}
    />
  );
}

/**
 * Slice 7 emergency kill-switch state (shell flag OFF): the shell header
 * plus a clear rollback instruction. No stage navigation, no brand view, no
 * execution strip, and no resurrected classic/board navigation — this is a
 * disabled-content state, not a second shell.
 */
function ShellDisabledNotice({ batchName, onBack, onOpenSettings }: {
  batchName: string;
  onBack: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div data-testid="shell-disabled-notice" style={{ padding: '16px 24px 32px 24px', fontFamily: fonts.body, color: colors.ledgerCharcoal }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <button
          type="button"
          onClick={onBack}
          style={{ backgroundColor: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '0.4375rem 0.75rem', fontSize: '0.8125rem', fontWeight: 600, color: colors.uniformGreen, cursor: 'pointer', minHeight: 36, marginTop: 6 }}
          aria-label="Back to batches"
        >
          ← Batches
        </button>
        <div>
          <h1 style={{ ...typography.viewTitle, margin: 0 }}>{batchName}</h1>
          <p style={{ ...typography.viewSubtitle, margin: '0.25rem 0 0 0' }}>Workspace disabled</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} style={{ backgroundColor: 'transparent', border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '0.4375rem 0.75rem', fontSize: '0.8125rem', fontWeight: 600, color: colors.mulchBrown, cursor: 'pointer', minHeight: 36 }}>
              Settings
            </button>
          )}
        </div>
      </div>
      <div role="status" style={{ backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, padding: '16px', fontSize: '0.8125rem', lineHeight: 1.5 }}>
        The onboarding workspace is disabled by configuration (<code>VITE_ONBOARDING_SHELL_V2=false</code>). No stage navigation, brand setup, or execution strip is available in this state.
        To restore the workspace, rebuild with the shell flag enabled — or, to use classic navigation, serve the archived matching bridge client.
      </div>
    </div>
  );
}

/** Sum one stage column of the server 6×6 matrix — the badge source of truth. */
function sumStageMatrixColumn(matrix: StageStatusMatrix, stage: LinearStageId): number {
  const col = matrix[stage];
  return col.pending + col.in_progress + col.completed + col.failed + col.needs_input + col.skipped;
}

function readSelection() {
  return parseWorkspaceSelection(typeof window !== 'undefined' ? window.location.search : '');
}

function writeSearch(mutator: (params: URLSearchParams) => void, push: boolean) {
  const url = new URL(window.location.href);
  mutator(url.searchParams);
  if (push) window.history.pushState(null, '', url.toString());
  else window.history.replaceState(null, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Slice 2 linear shell: six stage tabs are primary navigation; preserved
 * full-batch operation views are secondary destinations (clearly labeled
 * 'entire batch', stage filters cleared/hidden while open); Completed /
 * Skipped are server-filtered outcome results with no new decisions.
 */
function LinearShell({ batchId, batchName, onBack, onOpenSettings }: BatchWorkspaceProps) {
  const [selection, setSelection] = useState(readSelection);
  const [stageCounts, setStageCounts] = useState<Record<LinearStageId, number> | null>(null);
  const [opCounts, setOpCounts] = useState<WorkStateCounts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [countsStale, setCountsStale] = useState(false);
  const [projectionHealth, setProjectionHealth] = useState<WorkStateProjectionHealth | null>(null);
  const [attentionItemId, setAttentionItemId] = useState<string | null>(null);
  const [executionState, setExecutionState] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const hasAutoRoutedRef = useRef(false);

  const refreshStageCounts = useCallback(async () => {
    const gen = generation.current;
    try {
      const res = await getStageReadCounts(batchId, {} satisfies StageReadQuery);
      if (generation.current !== gen) return;
      const next: Record<LinearStageId, number> = {
        route_sources: sumStageMatrixColumn(res.stageStatusMatrix, 'route_sources'),
        find_product_page: sumStageMatrixColumn(res.stageStatusMatrix, 'find_product_page'),
        collect_details: sumStageMatrixColumn(res.stageStatusMatrix, 'collect_details'),
        prepare_listing: sumStageMatrixColumn(res.stageStatusMatrix, 'prepare_listing'),
        review_listings: sumStageMatrixColumn(res.stageStatusMatrix, 'review_listings'),
        create_drafts: sumStageMatrixColumn(res.stageStatusMatrix, 'create_drafts'),
      };
      setStageCounts(next);
      setOpCounts(res.counts);
      setProjectionHealth(res.projectionHealth);
      setCountsError(null);
      setCountsStale(false);
      // Auto-land on Needs Attention if the batch has items needing attention and no explicit stage/tab was chosen
      if (!hasAutoRoutedRef.current && (res.counts?.needs_attention ?? 0) > 0) {
        const currentSel = parseWorkspaceSelection(typeof window !== 'undefined' ? window.location.search : '');
        if (currentSel.kind === 'legacy' && currentSel.rawTab === null) {
          hasAutoRoutedRef.current = true;
          writeSearch((params) => {
            params.delete('stage');
            params.delete('stageVersion');
            params.delete('wview');
            params.set('tab', 'needs_attention');
          }, false);
          return;
        }
      }
    } catch (err) {
      if (generation.current !== gen) return;
      // Retain last successful counts with a stale badge — never zero them.
      setCountsError(err instanceof Error ? err.message : String(err));
      setCountsStale(true);
    } finally {
      if (generation.current === gen) setUpdating(false);
    }
  }, [batchId]);

  useEffect(() => {
    generation.current += 1;
    hasAutoRoutedRef.current = false;
    setStageCounts(null);
    setOpCounts(null);
    setCountsError(null);
    setCountsStale(false);
    setAttentionItemId(null);
    setExecutionState(null);
    setSelection(readSelection());
    void refreshStageCounts();
    void getBatch(batchId).then(
      (res) => setExecutionState(res?.batch?.executionState ?? null),
      () => {},
    );
  }, [refreshStageCounts, batchId]);

  useEffect(() => {
    const onPop = () => setSelection(readSelection());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      setUpdating(true);
      refreshTimer.current = setTimeout(() => {
        refreshStageCounts();
        void getBatch(batchId).then(
          (res) => setExecutionState(res?.batch?.executionState ?? null),
          () => {},
        );
      }, COUNT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [batchId, refreshStageCounts]);

  const selectStage = useCallback((stage: LinearStageId) => {
    setAttentionItemId(null);
    writeSearch((params) => {
      params.delete('tab');
      params.delete('wview');
      params.set('stage', stage);
      params.set('stageVersion', '2');
    }, true);
  }, []);

  const openOperation = useCallback((view: OperationViewId) => {
    const tab = view === 'attention' ? 'needs_attention'
      : view === 'processing' ? 'processing'
      : view === 'family' ? 'waiting_on_family'
      : view === 'review' ? 'review'
      : view === 'approved' ? 'approved'
      : 'ready_to_export';
    setAttentionItemId(null);
    // Entering a full-batch operation clears/hides stage-scoped filters:
    // the stage list unmounts (keyed remount clears its filters on return).
    writeSearch((params) => {
      params.delete('stage');
      params.delete('stageVersion');
      params.delete('wview');
      params.set('tab', tab);
    }, true);
  }, []);

  const openOutcome = useCallback((outcome: 'completed' | 'skipped') => {
    setAttentionItemId(null);
    writeSearch((params) => {
      params.delete('stage');
      params.delete('stageVersion');
      params.delete('wview');
      params.set('tab', outcome);
    }, true);
  }, []);

  const backToStage = useCallback((stage: LinearStageId) => {
    setAttentionItemId(null);
    writeSearch((params) => {
      params.delete('tab');
      params.delete('wview');
      params.set('stage', stage);
      params.set('stageVersion', '2');
    }, true);
  }, []);

  const activeStage: LinearStageId = selection.kind === 'stage' ? selection.stage : 'route_sources';
  const legacyDest = selection.kind === 'legacy' ? resolveLegacyTabDestination(selection.rawTab) : null;
  // Return-to-prior-stage: remember the last explicitly entered stage so
  // operation/outcome/brand destinations return there instead of
  // resetting to route_sources. Legacy ?tab= links never infer a stage,
  // so the remembered stage only advances on explicit stage selections.
  const lastStageRef = useRef<LinearStageId>('route_sources');
  useEffect(() => {
    if (selection.kind === 'stage') lastStageRef.current = selection.stage;
  }, [selection]);
  const returnStage: LinearStageId = selection.kind === 'stage' ? selection.stage : lastStageRef.current;

  const openAttentionItem = useCallback((itemId: string) => {
    // Blocking siblings live in Needs Attention — jump there and open them.
    openOperation('attention');
    setAttentionItemId(itemId);
  }, [openOperation]);

  // Slice 3 (retired, #115): Step 0 brand-setup is absorbed into Stage 1
  // ("Identify & Route Sources"). `parseWorkspaceSelection` redirects legacy
  // `wview=brand-setup` links into `stage=route_sources` at the parse seam,
  // so there is no standalone brand view, no header button, and no separate
  // mount branch here.
  const stripMounted = isExecutionStripMounted();
  // Step 0 retired (#115): normalize any inbound `wview=brand-setup` URL to
  // the canonical Stage 1 URL so legacy links/bookmarks land on Identify &
  // Route Sources with stageVersion=2 (single replace, no history loop).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('wview') === 'brand-setup') {
      writeSearch((p) => {
        p.delete('tab');
        p.delete('wview');
        p.set('stage', 'route_sources');
        p.set('stageVersion', '2');
      }, false);
    }
  }, []);

  return (
    <div data-testid="linear-shell" style={{ padding: '16px 24px 32px 24px', fontFamily: fonts.body, color: colors.ledgerCharcoal }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              backgroundColor: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.md,
              padding: '0.375rem 0.75rem',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: colors.uniformGreen,
              cursor: 'pointer',
              minHeight: 32,
              display: 'inline-flex',
              alignItems: 'center',
            }}
            aria-label="Back to batches"
          >
            ← Batches
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ ...typography.viewTitle, margin: 0, fontSize: '1.25rem', lineHeight: 1.2 }}>{batchName}</h1>
            {updating && (
              <span
                role="status"
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  color: colors.mulchBrown,
                  backgroundColor: colors.feedBagCream,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.full,
                  padding: '2px 8px',
                }}
              >
                updating…
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BatchExecutionControls batchId={batchId} executionState={executionState} onChanged={setExecutionState} compact />
          <BatchToolsDisclosure opCounts={opCounts} onOpenOperation={openOperation} onOpenOutcome={openOutcome} />
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              style={{
                backgroundColor: 'transparent',
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.md,
                padding: '0.3125rem 0.625rem',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: colors.mulchBrown,
                cursor: 'pointer',
                minHeight: 32,
              }}
            >
              Settings
            </button>
          )}
        </div>
      </div>

      {countsError && (
        <div role="alert" style={{ backgroundColor: colors.signetBurgundy, color: colors.feedBagCream, borderRadius: rounded.md, padding: '10px 14px', marginBottom: 8, fontSize: '0.8125rem' }}>
          Could not load stage counts: {countsError}
        </div>
      )}
      {stripMounted && <ExecutionStrip batchId={batchId} />}
      {projectionHealth?.status === 'degraded' && (
        <div role="status" aria-label="Projection health degraded" style={{ backgroundColor: '#fff3cd', color: '#856404', border: '1px solid #ffeaa7', borderRadius: rounded.md, padding: '10px 14px', marginBottom: 14, fontSize: '0.8125rem' }}>
          Projection degraded: {projectionHealth.issues.length} issue(s) — counts may be partial. (v{projectionHealth.version})
        </div>
      )}

      {selection.kind === 'unsupported' && (
        <div role="alert" data-testid="unsupported-link-notice" style={{ backgroundColor: '#fff3cd', color: '#856404', border: '1px solid #ffeaa7', borderRadius: rounded.md, padding: '10px 14px', marginBottom: 14, fontSize: '0.8125rem' }}>
          Unsupported link: {selection.reason} Showing Identify & Route Sources instead — nothing was changed.
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => backToStage('route_sources')} style={{ backgroundColor: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '0.375rem 0.75rem', fontSize: '0.8125rem', fontWeight: 600, color: colors.uniformGreen, cursor: 'pointer', minHeight: 32 }}>
              Go to Identify & Route Sources
            </button>
          </div>
        </div>
      )}

      {stageCounts ? (
        <StageNavigation activeStage={activeStage} stageCounts={stageCounts} countsStale={countsStale} onSelect={selectStage} />
      ) : !countsError ? (
        <div style={{ padding: 24, textAlign: 'center', color: colors.mulchBrown }}>Loading stages…</div>
      ) : null}

      {/* Step 0 retired (#115): unreachable via parse (redirects to Stage 1
          at the parse seam). Defensive fallback: any residual brand-setup
          selection renders the Stage 1 intake surface, never a separate
          brand view. */}
      {selection.kind === 'brand-setup' && stageCounts && (
        <StageItemsView
          key={`stage-${batchId}-route_sources`}
          batchId={batchId}
          stage="route_sources"
        />
      )}

      {(selection.kind === 'stage' || selection.kind === 'unsupported') && stageCounts && (
        selection.kind === 'stage' && selection.stage === 'prepare_listing' ? (
          <PrepareListingView
            key={`prepare-${batchId}`}
            batchId={batchId}
            onOpenOperation={openOperation}
            onOpenFullBatchReview={() => openOperation('review')}
          />
        ) : (
          <StageItemsView
            key={`stage-${batchId}-${activeStage}`}
            batchId={batchId}
            stage={activeStage}
            onOpenSettings={onOpenSettings}
            onOpenFullBatchReview={activeStage === 'review_listings' ? () => openOperation('review') : undefined}
            onOpenReadyToExportWorkspace={activeStage === 'create_drafts' ? () => openOperation('export') : undefined}
          />
        )
      )}

      {legacyDest && (legacyDest.kind === 'operation' ? (
        <LinearOperationDestination
          batchId={batchId}
          view={legacyDest.view}
          returnStage={returnStage}
          onBack={() => backToStage(returnStage)}
          onOpenItem={legacyDest.view === 'attention' ? setAttentionItemId : openAttentionItem}
        />
      ) : legacyDest.kind === 'outcome' ? (
        <div>
          <LinearScopeBanner scope={`${legacyDest.outcome === 'completed' ? 'Completed' : 'Skipped'} outcome`} returnLabel={`Back to ${activeStageLabel(returnStage)}`} onBack={() => backToStage(returnStage)} />
          <OutcomeItemsView key={`outcome-${batchId}-${legacyDest.outcome}`} batchId={batchId} outcome={legacyDest.outcome} />
        </div>
      ) : legacyDest.kind === 'stage' ? (
        <StageItemsView key={`stage-${batchId}-${legacyDest.stage}`} batchId={batchId} stage={legacyDest.stage} onOpenSettings={onOpenSettings} onOpenFullBatchReview={legacyDest.stage === 'review_listings' ? () => openOperation('review') : undefined} onOpenReadyToExportWorkspace={legacyDest.stage === 'create_drafts' ? () => openOperation('export') : undefined} />
      ) : (
        <div role="alert" data-testid="unsupported-link-notice" style={{ backgroundColor: '#fff3cd', color: '#856404', border: '1px solid #ffeaa7', borderRadius: rounded.md, padding: '10px 14px', marginBottom: 14, fontSize: '0.8125rem' }}>
          Unsupported link: unknown operation ‘{selection.kind === 'legacy' ? (selection.rawTab ?? '') : ''}’. Showing Identify & Route Sources instead — nothing was changed.
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => backToStage('route_sources')} style={{ backgroundColor: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '0.375rem 0.75rem', fontSize: '0.8125rem', fontWeight: 600, color: colors.uniformGreen, cursor: 'pointer', minHeight: 32 }}>
              Go to Identify & Route Sources
            </button>
          </div>
        </div>
      ))}

      {attentionItemId && (
        <FocusTrap onClose={() => setAttentionItemId(null)}>
          <div role="dialog" aria-modal="true" aria-label="Resolve product blocker" className="bws-drawer">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', backgroundColor: colors.uniformGreen, color: colors.feedBagCream }}>
              <strong style={{ fontFamily: fonts.body, fontSize: '0.875rem' }}>Resolve product blocker</strong>
              <button type="button" onClick={() => setAttentionItemId(null)} aria-label="Close resolution workspace" style={{ backgroundColor: 'transparent', border: 'none', color: colors.feedBagCream, fontSize: '1.25rem', cursor: 'pointer', lineHeight: 1, padding: '0.25rem 0.5rem', minHeight: 32 }}>
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              <OfficialSiteResolutionWorkspace batchId={batchId} itemId={attentionItemId} onResolved={() => { setAttentionItemId(null); refreshStageCounts(); }} />
            </div>
          </div>
        </FocusTrap>
      )}
    </div>
  );
}

function activeStageLabel(stage: LinearStageId): string {
  switch (stage) {
    case 'route_sources': return 'Identify & Route Sources';
    case 'find_product_page': return 'Find product page';
    case 'collect_details': return 'Collect details';
    case 'prepare_listing': return 'Prepare listing';
    case 'review_listings': return 'Review listings';
    case 'create_drafts': return 'Create drafts';
  }
}

// Step 0 retired (#115): the standalone Brand setup view is absorbed into
// Stage 1 ("Identify & Route Sources"). The former isBrandSetupAvailable
// anchor is removed; the shell no longer gates any brand view on flags.

/**
 * Slice 4: the ephemeral execution strip mounts only when the shell flag
 * AND the strip flag are both on (Table B E=1 ⇒ mounted). It is a
 * batch-wide shell element with honest scope — it stays mounted across
 * stage/operation destinations and never claims worker health.
 */
function isExecutionStripMounted(): boolean {
  const flags = getOnboardingFeatureFlags();
  return flags.shellV2Enabled && flags.executionStripV2Enabled;
}

/** Clearly-scoped full-batch operation destination (composition, not rewrite). */
function LinearOperationDestination({ batchId, view, returnStage, onBack, onOpenItem }: {
  batchId: string;
  view: OperationViewId;
  returnStage: LinearStageId;
  onBack: () => void;
  onOpenItem: (itemId: string) => void;
}) {
  return (
    <div data-testid={`linear-operation-${view}`}>
      <LinearScopeBanner scope={`Entire batch — ${view === 'attention' ? 'Needs Attention' : view === 'processing' ? 'Processing' : view === 'family' ? 'Waiting on Family' : view === 'review' ? 'Review' : view === 'approved' ? 'Approved' : 'Ready to Export'}`} returnLabel={`Back to ${activeStageLabel(returnStage)}`} onBack={onBack} />
      {view === 'attention' && <AttentionQueueView batchId={batchId} onOpenItem={onOpenItem} />}
      {view === 'processing' && <ProcessingView batchId={batchId} />}
      {view === 'family' && <FamilyWaitingView batchId={batchId} onOpenItem={onOpenItem} />}
      {view === 'review' && <ReviewWorkspace batchId={batchId} />}
      {view === 'approved' && (
        <div data-testid="approved-view" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <ApprovedView batchId={batchId} />
        </div>
      )}
      {view === 'export' && (
        <div data-testid="ready-to-export-view" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <ReadyToExportView batchId={batchId} />
        </div>
      )}
    </div>
  );
}

function LinearScopeBanner({ scope, returnLabel, onBack }: { scope: string; returnLabel: string; onBack: () => void }) {
  return (
    <div data-testid="linear-scope-banner" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', backgroundColor: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: '0.8125rem', color: '#3730a3' }}>
      <strong>Scope: {scope}.</strong>
      <span>Stage filters are cleared while this view is open.</span>
      <button type="button" onClick={onBack} style={{ marginLeft: 'auto', backgroundColor: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '0.375rem 0.75rem', fontSize: '0.8125rem', fontWeight: 600, color: colors.uniformGreen, cursor: 'pointer', minHeight: 32 }}>
        {returnLabel}
      </button>
    </div>
  );
}

/**
 * Oracle slice: the single compact batch-wide entry point in the header.
 *
 * One <details> disclosure labeled 'Batch tools, entire batch' with grouped
 * navigation LINKS (plain buttons in lists — never a second tablist, so no
 * tab selection state can falsely highlight Ready to Export). Batch counts
 * stay inside the disclosure; the trigger carries a clearly labeled
 * batch-attention urgency indicator. Opening a destination replaces stage
 * content with its explicit scope banner, stays batch-wide, and hides
 * stage filters (entering an operation clears stage params; the stage list
 * unmounts and its filters reset on return).
 */
function BatchToolsDisclosure({ opCounts, onOpenOperation, onOpenOutcome }: {
  opCounts: WorkStateCounts | null;
  onOpenOperation: (view: OperationViewId) => void;
  onOpenOutcome: (outcome: 'completed' | 'skipped') => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const urgent = opCounts ? attentionIsUrgent(opCounts) : false;
  const attentionCount = opCounts?.needs_attention ?? null;

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && detailsRef.current?.open) {
        detailsRef.current.open = false;
      }
    };
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const closeMenu = () => {
    if (detailsRef.current) {
      detailsRef.current.open = false;
    }
  };

  const linkStyle: React.CSSProperties = {
    backgroundColor: 'transparent',
    border: 'none',
    color: colors.uniformGreen,
    fontWeight: 600,
    fontSize: '0.8125rem',
    cursor: 'pointer',
    padding: '0.25rem 0',
    minHeight: 28,
    textAlign: 'left',
    fontFamily: fonts.body,
    whiteSpace: 'nowrap',
  };
  const countStyle: React.CSSProperties = {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 400,
    color: colors.mulchBrown,
  };
  const groupTitleStyle: React.CSSProperties = {
    margin: '0 0 4px 0',
    fontSize: '0.6875rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: colors.mulchBrown,
    fontFamily: fonts.body,
    whiteSpace: 'nowrap',
  };
  const renderCount = (value: number | null) => (
    <span style={countStyle}> ({value === null ? '…' : formatCount(value)})</span>
  );
  return (
    <details
      ref={detailsRef}
      data-testid="batch-tools-disclosure"
      style={{
        position: 'relative',
        display: 'inline-block',
      }}
    >
      <summary
        data-testid="batch-tools-trigger"
        className="bws-batch-tools-summary"
        style={{
          cursor: 'pointer',
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: colors.mulchBrown,
          backgroundColor: 'transparent',
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.md,
          padding: '0.3125rem 0.625rem',
          minHeight: 32,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontFamily: fonts.body,
          userSelect: 'none',
        }}
      >
        <span>Batch tools</span>
        <span style={{ fontSize: '0.625rem', opacity: 0.8 }}>▾</span>
        {urgent && attentionCount !== null ? (
          <span
            data-testid="batch-attention-urgency"
            role="status"
            aria-label={`Batch attention urgent: ${attentionCount} need attention`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: rounded.full,
              padding: '1px 7px',
              fontSize: '0.6875rem',
              lineHeight: 1.3,
              fontWeight: 700,
              backgroundColor: colors.signetBurgundy,
              color: colors.feedBagCream,
              border: `1px solid ${colors.burgundyDark}`,
              marginLeft: 2,
            }}
          >
            {formatCount(attentionCount)}
          </span>
        ) : (
          <span
            data-testid="batch-attention-urgency"
            role="status"
            aria-label={
              attentionCount === null
                ? 'Batch attention: loading'
                : `Batch attention: ${attentionCount} need attention`
            }
            style={{ display: 'none' }}
          />
        )}
      </summary>
      {opCounts ? (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 40,
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.12)',
            padding: '12px 16px',
            minWidth: 420,
          }}
        >
          <nav aria-label="Batch tools, entire batch" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 110 }}>
              <p style={groupTitleStyle}>Resolve and monitor</p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <li><button type="button" data-testid="batch-tool-attention" onClick={() => { closeMenu(); onOpenOperation('attention'); }} style={linkStyle}>Attention{renderCount(opCounts.needs_attention)}</button></li>
                <li><button type="button" data-testid="batch-tool-processing" onClick={() => { closeMenu(); onOpenOperation('processing'); }} style={linkStyle}>Processing{renderCount(opCounts.processing)}</button></li>
                <li><button type="button" data-testid="batch-tool-family" onClick={() => { closeMenu(); onOpenOperation('family'); }} style={linkStyle}>Family{renderCount(opCounts.waiting_on_family)}</button></li>
              </ul>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <p style={groupTitleStyle}>Review and approval</p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <li><button type="button" data-testid="batch-tool-review" onClick={() => { closeMenu(); onOpenOperation('review'); }} style={linkStyle}>Full-batch review workspace{renderCount(opCounts.ready_for_review)}</button></li>
                <li><button type="button" data-testid="batch-tool-approved" onClick={() => { closeMenu(); onOpenOperation('approved'); }} style={linkStyle}>Approved{renderCount(opCounts.approved)}</button></li>
              </ul>
            </div>
            <div style={{ flex: 1, minWidth: 110 }}>
              <p style={groupTitleStyle}>Drafts and outcomes</p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <li><button type="button" data-testid="batch-tool-export" onClick={() => { closeMenu(); onOpenOperation('export'); }} style={linkStyle}>Ready to export{renderCount(opCounts.ready_to_export)}</button></li>
                <li><button type="button" data-testid="batch-tool-completed" onClick={() => { closeMenu(); onOpenOutcome('completed'); }} style={linkStyle}>Completed{renderCount(opCounts.completed)}</button></li>
                <li><button type="button" data-testid="batch-tool-skipped" onClick={() => { closeMenu(); onOpenOutcome('skipped'); }} style={linkStyle}>Skipped{renderCount(opCounts.skipped)}</button></li>
              </ul>
            </div>
          </nav>
        </div>
      ) : (
        <div
          className="bws-muted"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 40,
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.12)',
            fontSize: '0.8125rem',
            padding: '8px 12px',
            whiteSpace: 'nowrap',
          }}
        >
          Loading batch counts…
        </div>
      )}
    </details>
  );
}

// ─── Focus trap for the resolution modal ───────────────────────────────────────

function FocusTrap({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const el = containerRef.current;
    if (el) {
      const focusables = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = Array.from(focusables).find(f => !f.hasAttribute('disabled'));
      if (first) first.focus();
      else el.focus();
    }
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const el = containerRef.current;
    if (!el) return;
    const focusables = Array.from(
      el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(f => !f.hasAttribute('disabled'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !el.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !el.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="bws-overlay" ref={containerRef} onKeyDown={handleKeyDown} role="presentation">
      {children}
    </div>
  );
}
