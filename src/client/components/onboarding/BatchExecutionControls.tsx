import React, { useCallback, useId, useRef, useState } from 'react';
import { colors, rounded } from '../../theme';
import { getBatch, pauseBatch, resumeBatch, startBatch } from '../../onboarding-api';

export interface BatchExecutionControlsProps {
  batchId: string;
  /** Current execution state when already known (avoids an extra read). */
  executionState?: string | null;
  /** Compact renders smaller buttons for dense headers. */
  compact?: boolean;
  /** Called after a successful transition with the fresh server state. */
  onChanged?: (executionState: string) => void;
}

/**
 * Always-reachable batch execution controls (replaces the deleted
 * Preflight Review modal's Start/Pause entry points).
 *
 * Explicit branded vs all-items choice: branded releases branded
 * items and holds unbranded ones with `unresolved_brand`; all-items
 * releases everything and therefore requires confirmation. Resume only
 * flips paused → running and never releases holds. Start actions stay
 * reachable while running so held items can be released without pause.
 */
function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-1px', marginRight: 5 }}>
      <path d="M5 3l14 9-14 9V3z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-1px', marginRight: 5 }}>
      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
    </svg>
  );
}

export function BatchExecutionControls({
  batchId,
  executionState: controlledState,
  compact,
  onChanged,
}: BatchExecutionControlsProps): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localState, setLocalState] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowId = useId();
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const state = localState ?? controlledState ?? null;

  const run = useCallback(
    async (kind: 'ready' | 'all' | 'pause' | 'resume') => {
      if (busy) return;
      if (kind === 'all') {
        const ok = window.confirm(
          'Start ALL products, including items without a brand? Unbranded items will run without brand-guided discovery.',
        );
        if (!ok) return;
      }
      setBusy(kind);
      setError(null);
      try {
        let next: string;
        if (kind === 'ready') next = (await startBatch(batchId, 'ready_only')).executionState;
        else if (kind === 'all') next = (await startBatch(batchId, 'all')).executionState;
        else if (kind === 'pause') next = (await pauseBatch(batchId)).executionState;
        else next = (await resumeBatch(batchId)).executionState;
        // Re-read the batch so the displayed state is server-confirmed.
        try {
          const fresh = await getBatch(batchId);
          next = fresh?.batch?.executionState ?? next;
        } catch {
          // Fall through with the mutation response when the refetch fails.
        }
        setLocalState(next);
        onChanged?.(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [batchId, busy, onChanged],
  );

  const closeOverflow = useCallback(() => {
    setOverflowOpen(false);
    overflowButtonRef.current?.focus();
  }, []);

  const pad = compact ? '0.3125rem 0.625rem' : '0.4375rem 0.875rem';
  const btn = (primary: boolean): React.CSSProperties => ({
    backgroundColor: primary ? colors.uniformGreen : 'transparent',
    border: primary ? 'none' : `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.md,
    padding: pad,
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: primary ? colors.feedBagCream : colors.mulchBrown,
    cursor: busy ? 'wait' : 'pointer',
    minHeight: 32,
    opacity: busy ? 0.7 : 1,
    display: 'inline-flex',
    alignItems: 'center',
  });

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {state !== 'completed' && (
        <button
          type="button"
          data-testid="batch-start-ready"
          onClick={() => void run('ready')}
          disabled={busy !== null}
          style={btn(true)}
          title="Start branded products: release items with a brand and hold unbranded ones with unresolved_brand"
        >
          {busy === 'ready' ? 'Starting…' : <><PlayIcon />Start branded products</>}
        </button>
      )}
      {state !== 'completed' && (
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          <button
            type="button"
            ref={overflowButtonRef}
            data-testid="batch-start-overflow-toggle"
            aria-expanded={overflowOpen}
            aria-controls={overflowOpen ? overflowId : undefined}
            aria-label="More start actions"
            onClick={() => setOverflowOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && overflowOpen) {
                event.stopPropagation();
                setOverflowOpen(false);
              }
            }}
            disabled={busy !== null}
            style={btn(false)}
            title="Advanced start actions"
          >
            {overflowOpen ? '▴ Less' : '▾ More'}
          </button>
        </span>
      )}
      {overflowOpen && state !== 'completed' && (
        <span
          id={overflowId}
          data-testid="batch-start-overflow"
          role="group"
          aria-label="Advanced start actions"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeOverflow();
            }
          }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
          <button
            type="button"
            data-testid="batch-start-all"
            onClick={() => void run('all')}
            disabled={busy !== null}
            style={btn(false)}
            title="Start all products, including items without a brand (requires confirmation)"
          >
            {busy === 'all' ? 'Starting…' : 'Start all products'}
          </button>
        </span>
      )}
      {state === 'running' && (
        <button
          type="button"
          data-testid="batch-pause"
          onClick={() => void run('pause')}
          disabled={busy !== null}
          style={btn(false)}
        >
          {busy === 'pause' ? 'Pausing…' : <><PauseIcon />Pause</>}
        </button>
      )}
      {state === 'paused' && (
        <button
          type="button"
          data-testid="batch-resume"
          onClick={() => void run('resume')}
          disabled={busy !== null}
          style={btn(true)}
        >
          {busy === 'resume' ? 'Resuming…' : <><PlayIcon />Resume</>}
        </button>
      )}
      {error && (
        <span role="alert" style={{ fontSize: '0.75rem', color: colors.signetBurgundy }}>
          {error}
        </span>
      )}
    </span>
  );
}
