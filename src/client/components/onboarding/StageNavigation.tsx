/**
 * Slice 2 — primary six-stage navigation (Operate mode).
 *
 * Exactly six tabs in execution order with server-derived badges. Badges come
 * from the v2 server count matrix (column sums per stage), never from
 * fetched-page lengths. Step 0 (`brand-setup`) is never a tab here.
 */
import React from 'react';
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
              aria-controls="bws-stage-panel"
              className="bws-tab bws-stage-tab"
              title={`${index + 1}. ${stage.label} — ${stage.description}`}
              onClick={() => onSelect(stage.id)}
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
