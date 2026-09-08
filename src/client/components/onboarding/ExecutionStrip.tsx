/**
 * Slice 4-UI — ephemeral execution strip (council plan §4.3, Operate mode).
 *
 * A slim batch-wide status bar inside the linear shell. Two independent
 * halves, never mixed:
 * 1. Server-derived status — batch execution permission plus the v2 server
 *    count matrix with honest freshness. Running/paused is execution
 *    permission ONLY, never worker health.
 * 2. Ephemeral live activity — display-only summaries received while this
 *    view is open. Never a source for status, counts, approval, or export.
 *
 * Inherits the BatchWorkspace world (theme tokens, inline styles, muted
 * helper copy). No alive badge, no concurrency, no last-poll, no
 * oldest-claim — those claims do not exist in this v1.
 */
import React, { useId, useState } from 'react';
import { colors, fonts, rounded, typography } from '../../theme';
import { formatCount } from './batch-workspace-logic';
import { LINEAR_STAGES } from './linear-workspace-logic';
import {
  EXECUTION_PERMISSION_NOTE,
  LIVE_ACTIVITY_DISCLOSURE,
  RECONNECT_GAP_LABEL,
  STRIP_CONNECTION_LABELS,
  formatElapsedAge,
  formatReceivedAt,
  labelExecutionPermission,
} from './execution-strip-logic';
import {
  useExecutionStrip,
  type FetchStripSnapshot,
  type StripEventSourceFactory,
} from './use-execution-strip';
import type { ExecutionStripBudgets } from './execution-strip-logic';

export interface ExecutionStripProps {
  batchId: string;
  budgets?: ExecutionStripBudgets;
  fetchSnapshot?: FetchStripSnapshot;
  createEventSource?: StripEventSourceFactory;
  /** Open the activity list on mount (visual-verification seam; default closed). */
  defaultExpanded?: boolean;
}

export function ExecutionStrip({
  batchId,
  budgets,
  fetchSnapshot,
  createEventSource,
  defaultExpanded = false,
}: ExecutionStripProps) {
  const {
    connection,
    freshness,
    snapshot,
    lastSuccessAtMs,
    fetchError,
    timeline,
    nowMs,
    refreshNow,
  } = useExecutionStrip({ batchId, budgets, fetchSnapshot, createEventSource });
  const [expanded, setExpanded] = useState(defaultExpanded);
  const activityListId = useId();

  const activityCount = timeline.filter((item) => item.kind === 'activity').length;
  const totalLabel = snapshot ? formatCount(snapshot.matchingTotal) : null;
  const ageLabel =
    lastSuccessAtMs !== null ? formatElapsedAge(nowMs - lastSuccessAtMs) : null;

  return (
    <section
      aria-label="Execution status"
      data-testid="execution-strip"
      style={{
        backgroundColor: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        padding: '10px 14px',
        marginBottom: 12,
        fontFamily: fonts.body,
        color: colors.ledgerCharcoal,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          fontSize: '0.8125rem',
        }}
      >
        <span
          className="bws-muted"
          style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
        >
          Batch-wide
        </span>
        <span
          data-testid="strip-execution-state"
          title={EXECUTION_PERMISSION_NOTE}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            backgroundColor: colors.feedBagCream,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.full,
            padding: '0.25rem 0.625rem',
            fontWeight: 700,
          }}
        >
          Execution: {snapshot ? labelExecutionPermission(snapshot.executionState) : '…'}
        </span>
        <span data-testid="strip-counts" style={{ fontWeight: 600 }}>
          {snapshot ? (
            <>{totalLabel} products (server counts)</>
          ) : (
            <>Counts not loaded</>
          )}
        </span>
        <span
          data-testid="strip-freshness"
          role="status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            borderRadius: rounded.full,
            padding: '0.25rem 0.625rem',
            fontWeight: 600,
            backgroundColor:
              freshness === 'fresh'
                ? '#e6f4ea'
                : freshness === 'not-loaded'
                  ? '#f3f4f6'
                  : '#fff3cd',
            color:
              freshness === 'fresh'
                ? '#1e7e34'
                : freshness === 'not-loaded'
                  ? '#4b5563'
                  : '#856404',
            border: '1px solid currentColor',
          }}
        >
          {freshness === 'not-loaded' && 'Not loaded'}
          {freshness === 'fresh' && ageLabel !== null && `Updated ${ageLabel} ago`}
          {freshness === 'stale' && ageLabel !== null && `Stale — updated ${ageLabel} ago`}
          {freshness === 'error' && 'Error — showing last successful counts'}
        </span>
        {snapshot?.projectionComputedAt && (
          <span className="bws-muted" style={{ fontSize: '0.75rem' }} title="Server projection time (display only)">
            Server computed: {snapshot.projectionComputedAt}
          </span>
        )}
        <span data-testid="strip-connection" style={{ marginLeft: 'auto', fontWeight: 600 }} className="bws-muted">
          {STRIP_CONNECTION_LABELS[connection]}
        </span>
        <button
          type="button"
          data-testid="strip-refresh"
          onClick={refreshNow}
          style={{
            backgroundColor: 'transparent',
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.375rem 0.75rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 32,
          }}
        >
          Refresh
        </button>
        <button
          type="button"
          data-testid="strip-activity-toggle"
          aria-expanded={expanded}
          aria-controls={activityListId}
          onClick={() => setExpanded((value) => !value)}
          style={{
            backgroundColor: 'transparent',
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.375rem 0.75rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 32,
          }}
        >
          {expanded ? 'Hide live activity' : `Live activity (${activityCount})`}
        </button>
      </div>

      {fetchError && (
        <p role="alert" data-testid="strip-error" style={{ margin: '8px 0 0 0', fontSize: '0.8125rem', color: '#856404' }}>
          Could not refresh counts: {fetchError} Showing the last successful server counts.
        </p>
      )}

      {snapshot && (
        <dl
          data-testid="strip-stage-totals"
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            margin: '8px 0 0 0',
            fontSize: '0.75rem',
          }}
        >
          {LINEAR_STAGES.map((stage) => (
            <div key={stage.id} style={{ display: 'flex', gap: 4 }}>
              <dt className="bws-muted" style={{ margin: 0 }}>{stage.label}:</dt>
              <dd style={{ margin: 0, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {formatCount(snapshot.stageTotals[stage.id] ?? 0)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {expanded && (
        <div style={{ marginTop: 8 }}>
          <p data-testid="strip-disclosure" style={{ ...typography.viewSubtitle, margin: '0 0 8px 0', fontSize: '0.75rem' }}>
            {LIVE_ACTIVITY_DISCLOSURE}
          </p>
          {timeline.length === 0 ? (
            <p data-testid="strip-activity-empty" className="bws-muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
              No live activity received yet in this view.
            </p>
          ) : (
            <ul
              id={activityListId}
              data-testid="strip-activity-list"
              style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              {timeline.map((item) =>
                item.kind === 'gap' ? (
                  <li
                    key={item.id}
                    data-testid="strip-gap-marker"
                    role="status"
                    className="bws-muted"
                    style={{ fontSize: '0.75rem', fontStyle: 'italic' }}
                  >
                    {RECONNECT_GAP_LABEL} ({formatReceivedAt(item.receivedAtMs)})
                  </li>
                ) : (
                  <li key={item.id} data-testid="strip-activity-item" style={{ fontSize: '0.8125rem' }}>
                    <span className="bws-muted" style={{ fontSize: '0.75rem' }}>
                      {formatReceivedAt(item.receivedAtMs)}
                    </span>{' '}
                    — {item.summary}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
