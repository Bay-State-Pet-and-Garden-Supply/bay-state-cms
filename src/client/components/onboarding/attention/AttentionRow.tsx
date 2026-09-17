/**
 * Epic #46 Phase 4 — one Needs Attention row answering the four operator
 * questions plainly:
 *   1. WHAT product is blocked?
 *   2. WHY did automation stop?
 *   3. WHAT decision/action is required?
 *   4. WHAT will happen after I resolve it?
 *
 * Presentational only — all text comes from the server projection
 * (label/detail) and the deterministic attention-logic helpers.
 * Row container is NON-interactive; only dedicated buttons are interactive.
 */
import React, { useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  getAttentionActionLabel,
  getAttentionConsequence,
  getAttentionGroupLabel,
} from './attention-logic';
import { SemanticConflictPanel } from './SemanticConflictPanel';
import { VariantDispositionPanel } from './VariantDispositionPanel';
import './semantic-conflict.css';

interface AttentionRowProps {
  workState: OnboardingWorkState;
  batchId: string;
  /** Opens the workspace drawer for this item */
  onResolve: (itemId: string) => void;
  /** When true the Resolve button shows an in-flight state. */
  resolving?: boolean;
  onViewFamily?: (cohortId: string) => void;
  onActionComplete?: () => void;
}

export function AttentionRow({ workState, batchId, onResolve, resolving = false, onViewFamily, onActionComplete }: AttentionRowProps): React.ReactElement {
  const { attentionReason, attentionAction, label, detail, upc, name, brand, itemId, findingCode, family } = workState;
  const reasonLabel = attentionReason ? getAttentionGroupLabel(attentionReason) : label;
  const actionLabel = attentionAction ? getAttentionActionLabel(attentionAction) : 'Resolve';
  const consequence = getAttentionConsequence(attentionReason, detail);
  const isSemanticBlocked = attentionReason === 'semantic_validation_blocked';
  const hasFamily = Boolean(family && family.memberCount > 1);
  const [expanded, setExpanded] = useState(false);
  const detailsId = `attn-details-${itemId}`;

  return (
    <article className="attn-row" aria-label={`${name} — ${reasonLabel}`}>
      <div className="attn-row-top">
        <div className="attn-row-identity">
          <div className="attn-row-name">{workState.curatedTitle || name}</div>
          <div className="attn-row-meta">
            <span>{upc}</span>
            {brand ? <span>{brand}</span> : null}
            <span className="attn-action-chip">{reasonLabel}</span>
            {hasFamily ? <span className="attn-family-badge" title={`Family ${family!.label ?? family!.cohortId} — ${family!.memberCount} members`}>{family!.memberCount} in family</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
          {hasFamily && onViewFamily ? (
            <button
              type="button"
              className="btn btn-outline"
              style={{ height: '2rem', padding: '0 0.625rem', fontSize: '0.75rem' }}
              onClick={(e) => {
                e.stopPropagation();
                onViewFamily(family!.cohortId);
              }}
            >
              View family
            </button>
          ) : null}
          {isSemanticBlocked ? (
            <button
              type="button"
              className="btn btn-outline"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={expanded ? 'Hide conflict details' : 'Show conflict details'}
              style={{ height: '2rem', padding: '0 0.625rem', fontSize: '0.75rem' }}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              {expanded ? '▴ Hide' : '▾ Details'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            style={{ flexShrink: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onResolve(itemId);
            }}
            disabled={resolving}
          >
            {resolving ? 'Working…' : actionLabel}
          </button>
        </div>
      </div>

      <div className="attn-row-four">
        <div className="attn-answer">
          <span className="attn-answer-label">Why it stopped</span>
          <span className="attn-answer-text">{label}</span>
        </div>
        <div className="attn-answer">
          <span className="attn-answer-label">Action needed</span>
          <span className="attn-answer-text">{attentionAction ? actionLabel : reasonLabel}</span>
        </div>
        <div className="attn-answer">
          <span className="attn-answer-label">What happens next</span>
          <span className="attn-answer-text">{consequence}</span>
        </div>
      </div>

      {detail && !findingCode ? (
        <div className="attn-answer">
          <span className="attn-answer-label">Detail</span>
          <span className="attn-answer-text">{detail}</span>
        </div>
      ) : null}
      <VariantDispositionPanel itemId={itemId} workState={workState} onChanged={onActionComplete} />
      {isSemanticBlocked && expanded ? (
        <div id={detailsId} onClick={(e) => e.stopPropagation()}>
          <SemanticConflictPanel item={workState} batchId={batchId} onActionComplete={onActionComplete} />
        </div>
      ) : null}
    </article>
  );
}
