/**
 * Slice 2 — primary six-stage navigation (Operate mode).
 *
 * Exactly six tabs in execution order with server-derived badges. Badges come
 * from the v2 server count matrix (column sums per stage), never from
 * fetched-page lengths. Step 0 (`brand-setup`) is never a tab here.
 */
import React, { useRef } from 'react';
import { LINEAR_STAGES, type LinearStageId } from './linear-workspace-logic';
import { formatCount } from './batch-workspace-logic';

export interface StageNavigationProps {
  activeStage: LinearStageId;
  /** Server-authoritative per-stage totals (summed 6×6 matrix columns). */
  stageCounts: Record<LinearStageId, number>;
  countsStale: boolean;
  onSelect: (stage: LinearStageId) => void;
}

export function StageNavigation({ activeStage, stageCounts, countsStale, onSelect }: StageNavigationProps) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="bws-stage-nav-wrap">
      <div className="bws-tabs bws-stage-tabs" role="tablist" aria-label="Onboarding stages">
        {LINEAR_STAGES.map((stage, index) => {
          const selected = stage.id === activeStage;
          const count = stageCounts[stage.id] ?? 0;
          return (
            <button
              key={stage.id}
              type="button"
              role="tab"
              id={`bws-stage-tab-${stage.id}`}
              aria-selected={selected}
              aria-controls={`bws-stage-panel-${stage.id}`}
              tabIndex={selected ? 0 : -1}
              ref={(element) => { tabs.current[index] = element; }}
              className="bws-tab bws-stage-tab"
              title={`${index + 1}. ${stage.label} — ${stage.description}`}
              onClick={() => onSelect(stage.id)}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const next = event.key === 'ArrowRight' ? (index + 1) % LINEAR_STAGES.length
                  : event.key === 'ArrowLeft' ? (index + LINEAR_STAGES.length - 1) % LINEAR_STAGES.length
                  : event.key === 'Home' ? 0
                  : event.key === 'End' ? LINEAR_STAGES.length - 1
                  : null;
                if (next === null) return;
                event.preventDefault();
                tabs.current[next]?.focus();
                onSelect(LINEAR_STAGES[next].id);
              }}
            >
              <span className="bws-stage-tab-step" aria-hidden="true">{index + 1}</span>
              {stage.label}
              <span
                className="bws-tab-count"
                aria-label={`${count} in ${stage.label.toLowerCase()}`}
              >
                {formatCount(count)}
              </span>
            </button>
          );
        })}
      </div>
      {countsStale && (
        <p className="bws-muted bws-stage-stale" role="status">
          Stage counts may be stale — showing the last successful server counts, never zeroed.
        </p>
      )}
    </div>
  );
}
