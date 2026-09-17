/**
 * Issue #220 — variant-identity disposition mark/clear panel.
 *
 * Board surfacing for the explicit unresolved variant-identity disposition:
 * an operator can mark a no-matrix variant-bearing item (e.g. a real
 * Nylabone size row on a Sitecore family page) so the release hold engages
 * with a `variant_resolution_required` reason, or clear the mark once
 * operator variant selection proves identity (restoring prior behavior).
 *
 * Display-only with respect to releases: marking never releases anything —
 * the server-side release hold consults the same row. Both acts are
 * audited server-side (principal actor + timestamp in the disposition row
 * and `audit_log`).
 *
 * Rendered in two board surfaces sharing this one component:
 * - the Needs Attention row (for extraction-blocked reasons), and
 * - the resolution workspace extractor/manual phases (profile-blocked).
 */
import React, { useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  clearVariantIdentityDisposition,
  markVariantIdentityUnresolved,
} from '../../../onboarding-work-api';

/** Attention reasons whose blocked items may be variant-bearing (mark offered). */
const MARKABLE_REASONS: ReadonlySet<string> = new Set([
  'manual_evidence_available',
  'extraction_profile_failed',
  'extractor_profile_required',
  'choose_variant',
]);

interface VariantDispositionPanelProps {
  itemId: string;
  /** Server-derived work state (carries the current disposition, when marked). */
  workState: OnboardingWorkState;
  /** Called after a successful mark/clear so the parent re-reads server state. */
  onChanged?: () => void;
}

export function VariantDispositionPanel({ itemId, workState, onChanged }: VariantDispositionPanelProps): React.ReactElement | null {
  const initial = workState.variantDisposition ?? null;
  const [disposition, setDisposition] = useState(initial);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'mark' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep local state honest when the parent re-reads (new workState identity).
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setDisposition(initial);
  }

  const markable = (workState.attentionReason != null && MARKABLE_REASONS.has(workState.attentionReason)) || disposition !== null;
  if (!markable) return null;

  const handleMark = async () => {
    const trimmed = reason.trim();
    if (!trimmed || busy) return;
    setBusy('mark');
    setError(null);
    try {
      const res = await markVariantIdentityUnresolved(itemId, trimmed);
      setDisposition({
        disposition: res.disposition.disposition,
        reason: res.disposition.reason,
        markedBy: res.disposition.markedBy,
        updatedAt: res.disposition.updatedAt,
      });
      setReason('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark this item');
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    if (busy) return;
    setBusy('clear');
    setError(null);
    try {
      await clearVariantIdentityDisposition(itemId);
      setDisposition(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear this item');
    } finally {
      setBusy(null);
    }
  };

  if (disposition) {
    return (
      <div
        data-testid={`variant-disposition-${itemId}`}
        role="status"
        aria-label="Variant identity hold active"
        style={{
          marginTop: 8,
          border: '1px solid #f59e0b',
          background: '#fffbeb',
          borderRadius: 6,
          padding: '8px 10px',
          fontSize: '0.75rem',
          lineHeight: 1.5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: '#92400e' }}>Variant hold: identity unproven</strong>
          <button
            type="button"
            className="btn btn-outline"
            style={{ height: '1.75rem', padding: '0 0.625rem', fontSize: '0.75rem', marginLeft: 'auto' }}
            onClick={(e) => { e.stopPropagation(); void handleClear(); }}
            disabled={busy !== null}
            aria-label="Clear variant hold"
          >
            {busy === 'clear' ? 'Clearing…' : 'Clear hold'}
          </button>
        </div>
        <div style={{ color: '#78350f', marginTop: 4 }}>
          {disposition.reason ?? 'Marked variant-bearing without matrix enforcement.'}
        </div>
        <div style={{ color: '#a16207', marginTop: 2 }}>
          Marked{disposition.markedBy ? ` by ${disposition.markedBy}` : ''} · {disposition.updatedAt}
          {' '}— release held with <code>variant_resolution_required</code> until variant selection proves identity.
        </div>
        {error ? (
          <div role="alert" style={{ color: '#991b1b', marginTop: 4 }}>{error}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid={`variant-disposition-${itemId}`}
      style={{
        marginTop: 8,
        border: '1px dashed #d1d5db',
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: '0.75rem',
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: '#4b5563' }}>
        <strong>Variant identity:</strong> no-matrix variant-bearing rows (e.g. size-specific items on a
        template family page) release unmarked. Marking holds this item out of automatic and bulk
        release until variant selection proves identity.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <input
          aria-label="Variant-hold reason"
          className="input"
          style={{ flex: 1, minWidth: 200, height: '2rem', fontSize: '0.75rem' }}
          placeholder="e.g. Size-specific row on no-matrix family page"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleMark(); }}
          disabled={busy !== null}
          maxLength={500}
        />
        <button
          type="button"
          className="btn btn-outline"
          style={{ height: '2rem', padding: '0 0.75rem', fontSize: '0.75rem' }}
          onClick={(e) => { e.stopPropagation(); void handleMark(); }}
          disabled={busy !== null || reason.trim().length === 0}
        >
          {busy === 'mark' ? 'Marking…' : 'Mark variant-bearing'}
        </button>
      </div>
      {error ? (
        <div role="alert" style={{ color: '#991b1b', marginTop: 4 }}>{error}</div>
      ) : null}
    </div>
  );
}
