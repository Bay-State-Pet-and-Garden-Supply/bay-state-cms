/**
 * Slice 2 — Prepare listing: ONE stage, ONE view, five internal sections.
 *
 * Sections are display groupings over the same stage list (not stages,
 * queues, or mutation gates). Each section links to its existing full-batch
 * operation; review/approval/export remain durable actions outside this view.
 */
import React, { useState } from 'react';
import { colors } from '../../theme';
import { StageItemsView } from './StageItemsView';
import {
  PREPARE_LISTING_SECTIONS,
  buildUnavailablePreparationSummary,
} from './prepare-listing-logic';

export interface PrepareListingViewProps {
  batchId: string;
  /** Open an existing full-batch operation (stage filters stay cleared/hidden). */
  onOpenOperation: (view: 'attention' | 'family' | 'review') => void;
  onOpenFullBatchReview?: () => void;
}

export function PrepareListingView({ batchId, onOpenOperation, onOpenFullBatchReview }: PrepareListingViewProps) {
  // Sections expand independently; expansion never changes the six tabs.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Slice 2: the server has not yet shipped per-section facts, so the honest
  // summary is uniformly unavailable — shown explicitly, never inferred.
  const [summary] = useState(buildUnavailablePreparationSummary);

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div data-testid="prepare-listing-view">
      <div className="bws-prepare-sections" role="group" aria-label="Prepare listing sections">
        {PREPARE_LISTING_SECTIONS.map((section) => {
          const state = summary.sections.find((s) => s.key === section.key);
          const open = expanded[section.key] ?? false;
          return (
            <section
              key={section.key}
              aria-label={section.title}
              data-testid={`prepare-section-${section.key}`}
              className="bws-prepare-section"
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(section.key)}
                className="bws-prepare-section-toggle"
              >
                <span>{section.title}</span>
                <span className="bws-muted" data-testid={`prepare-section-state-${section.key}`}>
                  {state?.state === 'unavailable' ? 'Not yet reported' : (state?.state ?? 'Not yet reported')}
                </span>
              </button>
              {open && (
                <div className="bws-prepare-section-body">
                  <p className="bws-muted">{section.scopeNote}</p>
                  {state?.reason && <p className="bws-muted">{state.reason}</p>}
                  <button
                    type="button"
                    onClick={() => onOpenOperation(section.operationLink as 'attention' | 'family' | 'review')}
                    style={{
                      backgroundColor: 'transparent',
                      border: 'none',
                      color: colors.uniformGreen,
                      fontWeight: 600,
                      fontSize: '0.8125rem',
                      cursor: 'pointer',
                      padding: 0,
                      minHeight: 28,
                      textAlign: 'left',
                    }}
                  >
                    Open entire-batch {section.operationLink} operation →
                  </button>
                  {section.key === 'field_classification' && (
                    <p className="bws-muted" data-testid="prepare-page-placement-subrow">
                      Page placement / draft-readiness: not yet reported by the server for this
                      item — shown separately from attribute proposals, never merged into them.
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <StageItemsView batchId={batchId} stage="prepare_listing" compact onOpenFullBatchReview={onOpenFullBatchReview} />
    </div>
  );
}
