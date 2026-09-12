/**
 * Ticket #124 — per-item Listing Evidence Gap correction panel.
 *
 * Shows the durable, specific request for operator help (missing fields +
 * safe reason from persisted gap facts), lets the operator inspect what is
 * missing and submit attributed correction values, then resumes preparation
 * from retained evidence. The gap clears only when re-preparation
 * validation succeeds — submit alone never marks the product complete.
 *
 * Keyboard-operable form with loading/error/success states; product context
 * (name + missing fields) is preserved across failed requests. Strategy
 * approval vs listing approval stay distinct in copy.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colors } from '../../theme';
import {
  getPreparationGap,
  submitGapCorrection,
  generateGapIdempotencyKey,
  OnboardingApiError,
  type PreparationGapView,
} from '../../onboarding-api';

export interface GapCorrectionPanelProps {
  itemId: string;
  itemName: string;
  onChanged?: () => void;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'ready'; gap: PreparationGapView }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string; gap: PreparationGapView | null }
  | { kind: 'accepted'; gap: PreparationGapView; replay: boolean };

function fieldLabel(field: string): string {
  if (field === 'title') return 'Product name';
  if (field === 'description') return 'Description';
  return field;
}

export function GapCorrectionPanel({ itemId, itemName, onChanged }: GapCorrectionPanelProps) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [values, setValues] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => generateGapIdempotencyKey());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const { gap } = await getPreparationGap(itemId);
      if (!mounted.current) return;
      if (!gap || gap.status !== 'open') {
        setStatus({ kind: 'none' });
        return;
      }
      const initial: Record<string, string> = {};
      for (const f of gap.missingFields) initial[f] = gap.correctionEnvelope?.values[f] ?? '';
      setValues(initial);
      setStatus({ kind: 'ready', gap });
    } catch (err) {
      if (!mounted.current) return;
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not load the listing gap.',
        gap: null,
      });
    }
  }, [itemId]);

  useEffect(() => { void load(); }, [load]);

  const submit = useCallback(async () => {
    const current = status.kind === 'ready' || status.kind === 'error' ? status.gap : null;
    if (!current) return;
    setStatus({ kind: 'submitting' });
    try {
      const result = await submitGapCorrection(
        itemId,
        {
          values,
          expectedEvidenceHash: current.evidenceHash,
          expectedUpdatedAt: current.updatedAt,
        },
        { idempotencyKey: key },
      );
      if (!mounted.current) return;
      setStatus({ kind: 'accepted', gap: result.gap, replay: result.replay });
      onChanged?.();
    } catch (err) {
      if (!mounted.current) return;
      // A new key per attempt: retries never replay a failed command.
      setKey(generateGapIdempotencyKey());
      const message = err instanceof OnboardingApiError && err.code === 'stale_gap'
        ? 'This request changed while you worked — reloading the latest gap.'
        : err instanceof Error ? err.message : 'Correction failed.';
      if (err instanceof OnboardingApiError && err.code === 'stale_gap') {
        void load();
        return;
      }
      setStatus({ kind: 'error', message, gap: current });
    }
  }, [itemId, key, load, onChanged, status, values]);

  if (status.kind === 'loading') {
    return <p className="bws-muted" role="status">Checking listing readiness…</p>;
  }
  if (status.kind === 'none') {
    return <p className="bws-muted" data-testid={`gap-panel-clear-${itemId}`}>No open listing gaps for this product.</p>;
  }
  if (status.kind === 'submitting') {
    return <p className="bws-muted" role="status">Submitting correction and resuming preparation…</p>;
  }
  if (status.kind === 'accepted') {
    return (
      <div role="status" data-testid={`gap-panel-accepted-${itemId}`}>
        <p>
          {status.replay ? 'Correction already recorded — showing the accepted result.' : 'Correction recorded.'}{' '}
          Preparation resumes from retained evidence; this gap clears only when validation succeeds.
        </p>
        <button type="button" onClick={() => void load()}>Refresh status</button>
      </div>
    );
  }
  const gap = status.kind === 'ready' ? status.gap : status.gap;
  if (!gap) {
    return (
      <div role="alert" data-testid={`gap-panel-error-${itemId}`}>
        <p>{status.kind === 'error' ? status.message : 'Could not load the listing gap.'}</p>
        <button type="button" onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  return (
    <div data-testid={`gap-panel-${itemId}`}>
      <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>
        Listing help needed — {itemName}
      </h4>
      <p className="bws-muted">
        Collected evidence cannot yet produce a usable listing. {gap.reason}{' '}
        Supplied values are attributed to you (the operator), never to a source.
      </p>
      {status.kind === 'error' && (
        <p role="alert" data-testid={`gap-panel-error-${itemId}`}>{status.message}</p>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        aria-label={`Correct listing information for ${itemName}`}
      >
        {gap.missingFields.map((field) => (
          <div key={field} style={{ marginBottom: 8 }}>
            <label htmlFor={`gap-${itemId}-${field}`} style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>
              {fieldLabel(field)}
            </label>
            {field === 'description' ? (
              <textarea
                id={`gap-${itemId}-${field}`}
                value={values[field] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                rows={3}
                style={{ width: '100%' }}
              />
            ) : (
              <input
                id={`gap-${itemId}-${field}`}
                type="text"
                value={values[field] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                style={{ width: '100%' }}
              />
            )}
          </div>
        ))}
        <button
          type="submit"
          data-testid={`gap-panel-submit-${itemId}`}
          style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            backgroundColor: 'transparent',
            border: `1px solid ${colors.uniformGreen}`,
            borderRadius: 6,
            padding: '0.375rem 0.75rem',
            cursor: 'pointer',
            minHeight: 32,
          }}
        >
          Submit correction and resume preparation
        </button>
      </form>
      <p className="bws-muted" style={{ fontSize: '0.75rem' }}>
        Approving a sourcing strategy does not approve this listing — ordinary Review listings approval still applies.
      </p>
    </div>
  );
}
