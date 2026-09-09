/**
 * Slice 2 — terminal outcome results (Operate mode).
 *
 * Completed and Skipped are DISTINCT outcomes served server-filtered
 * (`category=completed|skipped`) with NO new decisions:
 * - Skipped has no Approved destination and no export action.
 * - Completed has no Ready-to-Export badge membership and no export action.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colors, rounded } from '../../theme';
import { getStageReadItems, StageReadApiError } from '../../onboarding-stage-api';
import { STAGE_READ_LIMIT_DEFAULT } from '../../../shared/schemas/onboarding-stage-read';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import { reviewStateLabel, sourceTypeLabel, formatCount } from './batch-workspace-logic';
import type { OutcomeCategory } from './linear-workspace-logic';

export interface OutcomeItemsViewProps {
  batchId: string;
  outcome: OutcomeCategory;
}

const OUTCOME_COPY: Record<OutcomeCategory, { title: string; note: string }> = {
  completed: {
    title: 'Completed',
    note: 'Export verified. Completed is a terminal outcome — it is not a member of Ready-to-Export and offers no export action.',
  },
  skipped: {
    title: 'Skipped',
    note: 'Skipped items have no Approved destination and no export action. Re-entering the flow happens through existing operations, not here.',
  },
};

export function OutcomeItemsView({ batchId, outcome }: OutcomeItemsViewProps) {
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const copy = OUTCOME_COPY[outcome];

  const load = useCallback(
    async (cursor: string | null) => {
      const gen = generation.current;
      setLoading(true);
      try {
        let currentCursor: string | null = cursor;
        let isFirst = !cursor;
        let iter = 0;
        const maxIter = 50;

        while (iter < maxIter) {
          iter++;
          const res = await getStageReadItems(batchId, {
            category: outcome,
            limit: STAGE_READ_LIMIT_DEFAULT,
            ...(currentCursor ? { cursor: currentCursor } : {}),
          });
          if (generation.current !== gen) return;

          if (isFirst) {
            setItems(res.items);
            isFirst = false;
          } else {
            setItems((prev) => [...prev, ...res.items]);
          }
          setNextCursor(res.nextCursor);

          if (!res.nextCursor) {
            break;
          }
          currentCursor = res.nextCursor;
        }
        setError(null);
      } catch (err) {
        if (generation.current !== gen) return;
        const msg =
          err instanceof StageReadApiError
            ? `${err.message}${err.code ? ` (${err.code})` : ''}`
            : err instanceof Error
              ? err.message
              : String(err);
        setError(msg);
      } finally {
        if (generation.current === gen) setLoading(false);
      }
    },
    [batchId, outcome],
  );

  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setNextCursor(null);
    setError(null);
    void load(null);
  }, [load]);

  return (
    <div data-testid={`outcome-items-${outcome}`}>
      <div className="bws-muted" data-testid="outcome-scope-label" style={{ margin: '0 0 4px 0', fontSize: '0.75rem' }}>
        {copy.title} · server-filtered <code>category={outcome}</code> ·{' '}
        {loading && items.length === 0 ? 'loading…' : `${formatCount(items.length)} loaded row${items.length === 1 ? '' : 's'}`}
        {nextCursor ? ' — more available' : ''}
      </div>
      <div className="bws-muted" style={{ margin: '0 0 8px 0', fontSize: '0.75rem' }}>{copy.note}</div>
      {error && (
        <div role="alert" style={{ color: colors.signetBurgundy, padding: '0.75rem 0' }}>
          Failed to load outcome items: {error}
        </div>
      )}
      {loading && items.length === 0 && !error && (
        <div className="bws-muted" style={{ padding: '1rem 0' }}>Loading outcome items…</div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="bws-muted" style={{ padding: '2rem 1rem', textAlign: 'center' }} data-testid="outcome-empty">
          No {copy.title.toLowerCase()} products.
        </div>
      )}
      {items.length > 0 && (
        <div className="bws-table-scroll">
        <table className="bws-results-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Stage</th>
              <th>Review</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                <td>
                  <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>{item.name || item.upc}</div>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
                    {item.upc}
                    {item.brand ? ` · ${item.brand}` : ''}
                  </div>
                </td>
                <td>
                  <span className="bws-stage-badge" title={`Recorded pipeline state: ${item.stage} / ${item.stageStatus}`}>
                    {item.stage} / {item.stageStatus}
                  </span>
                </td>
                <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
                  {item.reviewState ? reviewStateLabel(item.reviewState) : '—'}
                </td>
                <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
                  {sourceTypeLabel(item.sourceType)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {nextCursor && (
        <button
          type="button"
          onClick={() => load(nextCursor)}
          disabled={loading}
          style={{
            marginTop: 12,
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.5rem 0.875rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 36,
          }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
