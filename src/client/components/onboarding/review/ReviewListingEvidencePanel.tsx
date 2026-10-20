/**
 * Listing-evidence findings panel (issue #366; verification #367).
 *
 * New-file UI reading `listingEvidenceValidation` from the item detail
 * (curation data): field-linked rows with real evidence, remove/correct
 * actions via the existing PUT item + gap-correction routes. Removing
 * unsafe optional text recovers without another source/model call when
 * remaining coverage/currentness is deterministically established.
 *
 * Never touches ReviewListingPanel.tsx (Worker365 owns it): mount this
 * panel adjacent to it (jump target `rv-listing-evidence`).
 */
import { useEffect, useState } from 'react';
import type { ItemDetailResponse } from '../../../onboarding-api';
import {
  updateItem,
  submitGapCorrection,
  generateGapIdempotencyKey,
  getListingEvidenceVerifyState,
  submitListingEvidenceVerify,
  generateListingVerifyActionToken,
  OnboardingApiError,
  type ListingEvidenceVerifyView,
} from '../../../onboarding-api';
import type {
  CurationData,
  ListingEvidenceClaim,
  ListingEvidenceValidation,
} from '../../../../shared/schemas/onboarding';

export interface ReviewListingEvidencePanelProps {
  detail: ItemDetailResponse | null;
  /** Item id for PUT/correction actions (falls back to detail id). */
  itemId?: string;
  /** Refresh the cached detail after an edit (re-run evaluation). */
  onChanged?: () => void | Promise<void>;
}

/** Intentional-absence sentinel: removal writes this (never '' alone), and
 * every projection honors it (no extraction fallback). Shared literal with
 * the server (`listing-evidence-currentness.ts`); compared trimmed. */
export const LISTING_EVIDENCE_REMOVED = '__listing_evidence_removed__';

function isRemoved(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === LISTING_EVIDENCE_REMOVED;
}

function textOf(value: unknown): string | null {
  if (isRemoved(value)) return null;
  return typeof value === 'string' && value.trim() ? value : null;
}
/** Curated key carrying the claim prose (null for structured variant facts). */
function editableKeyFor(claim: ListingEvidenceClaim): 'curatedTitle' | 'curatedDescription' | null {
  if (claim.field === 'title') return 'curatedTitle';
  if (claim.field === 'description') return 'curatedDescription';
  return null;
}

/** Excise (or replace) the claim char-offset span within the live field text. */
function spliceSpan(live: string, span: readonly [number, number], replacement?: string): string {
  const start = Math.max(0, Math.min(live.length, Math.trunc(span[0])));
  const end = Math.max(start, Math.min(live.length, Math.trunc(span[1])));
  const next = `${live.slice(0, start)}${replacement ?? ''}${live.slice(end)}`;
  return next.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function fieldLabel(field: ListingEvidenceClaim['field']): string {
  if (field === 'title') return 'Title';
  if (field === 'description') return 'Description';
  return 'Variant';
}


function recordOf(detail: ItemDetailResponse | null): ListingEvidenceValidation | null {
  const curation = (detail?.item.curationData ?? null) as CurationData | null;
  const raw = curation?.listingEvidenceValidation ?? null;
  if (!raw || typeof raw !== 'object') return null;
  return raw as ListingEvidenceValidation;
}

/**
 * Projected field text (curated → extraction → register), honoring
 * intentional absence: a sentinel-curated field projects to '' with NO
 * extraction fallback (removal stays removed). Corrections and splices
 * operate on what the evaluator actually checked, never on curated-only
 * text that loses fallback sibling sentences.
 */
export function projectedFieldText(detail: ItemDetailResponse | null, key: 'curatedTitle' | 'curatedDescription'): string {
  const curation = (detail?.item.curationData ?? {}) as Partial<CurationData>;
  const extraction = (detail?.extraction ?? detail?.item.extractionData ?? {}) as Record<string, unknown>;
  const curatedRaw = key === 'curatedTitle' ? curation.curatedTitle : curation.curatedDescription;
  if (isRemoved(curatedRaw)) return '';
  if (key === 'curatedTitle') {
    return textOf(curation.curatedTitle) ?? textOf(extraction['title']) ?? textOf(detail?.item.name) ?? '';
  }
  return textOf(curation.curatedDescription) ?? textOf(extraction['description']) ?? '';
}

/**
 * Whether the curated key carries an intentional removal (evidence surface:
 * the panel renders the field as "Removed — no fallback text will be
 * released" instead of an empty/missing state).
 */
export function isFieldRemoved(detail: ItemDetailResponse | null, key: 'curatedTitle' | 'curatedDescription'): boolean {
  const curation = (detail?.item.curationData ?? {}) as Partial<CurationData>;
  return isRemoved(key === 'curatedTitle' ? curation.curatedTitle : curation.curatedDescription);
}

export function ReviewListingEvidencePanel({ detail, itemId, onChanged }: ReviewListingEvidencePanelProps) {
  const record = recordOf(detail);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyOpen, setVerifyOpen] = useState<string | null>(null);
  const id = itemId ?? detail?.item.id ?? null;

  if (!record) return null;

  const blocked = record.status === 'blocked' || record.status === 'needs_review';
  const unavailable = record.status === 'unavailable' || record.status === 'stale';
  const actionable = record.claims.filter(
    (c) => c.material && c.verdict !== 'supported',
  );
  const resolvedVerified = record.claims.filter(
    (c) => c.material && c.verdict === 'supported' && c.producer === 'operator_verified',
  );

  async function refresh(): Promise<void> {
    if (onChanged) await onChanged();
  }

  async function fieldText(key: 'curatedTitle' | 'curatedDescription'): Promise<string> {
    const current = projectedFieldText(detail, key);
    if (current) return current;
    await refresh();
    return projectedFieldText(detail, key);
  }

  async function removeClaimText(claim: ListingEvidenceClaim): Promise<void> {
    if (!id) return;
    const key = editableKeyFor(claim);
    if (!key) {
      setError('Variant facts cannot be removed as prose — correct the structured value in the listing form.');
      return;
    }
    setBusy(claim.id);
    setError(null);
    try {
      // Intentional removal on the PROJECTED text: excise ONLY the claim
      // span (title claims clear the projected title; description claims
      // splice their sentence/bullet against extraction-fallback text so a
      // fallback sentence is not resurrected after the curated removal).
      // An empty projected remainder writes the REMOVED sentinel (explicit
      // intentional absence), never ''/null/omitted alone: every server
      // projection honors the sentinel with NO extraction fallback, so
      // removal cannot resurrect fallback copy through re-run, currentness,
      // draft promotion, or release hashing.
      const live = await fieldText(key);
      const remainder = key === 'curatedTitle' ? '' : spliceSpan(live, claim.span);
      const next = remainder.trim() ? remainder : LISTING_EVIDENCE_REMOVED;
      await updateItem(id, { curation_data: { [key]: next } as Partial<CurationData> });
      await rerun();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function rerun(): Promise<void> {
    if (!id) return;
    const res = await fetch(`/api/onboarding/items/${encodeURIComponent(id)}/listing-evidence-rerun`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof body?.error === 'string' ? body.error : `Re-run failed (${res.status}).`);
    }
    await refresh();
  }

  async function correctClaimText(claim: ListingEvidenceClaim, value: string): Promise<void> {
    if (!id) return;
    const cleaned = value.trim();
    if (!cleaned) {
      await removeClaimText(claim);
      return;
    }
    const key = editableKeyFor(claim);
    setBusy(claim.id);
    setError(null);
    try {
      if (key) {
        // Sentence-level correction: replace ONLY the claim span in the
        // live field text — sibling sentences survive.
        const live = await fieldText(key);
        const next = spliceSpan(live, claim.span, cleaned);
        await updateItem(id, { curation_data: { [key]: next } as Partial<CurationData> });
        await rerun();
      } else {
        // Variant fact `axis: value` — correct via gap correction values
        // (structured path) rather than prose editing.
        const axis = claim.text.split(':')[0]?.trim();
        if (!axis) throw new Error('Cannot parse the variant axis; correct it in the listing form.');
        await submitGapCorrection(
          id,
          { values: { [axis]: cleaned } },
          { idempotencyKey: generateGapIdempotencyKey() },
        );
        await rerun();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section id="rv-listing-evidence" aria-label="Listing evidence findings" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>Listing evidence</h3>
      <p role="status" style={{ margin: '0 0 8px' }}>
        Status: {record.status}
        {record.overflow ? ' — the listing exceeds the 24-claim semantic bound; narrow it and re-run.' : null}
      </p>
      {(isFieldRemoved(detail, 'curatedTitle') || isFieldRemoved(detail, 'curatedDescription')) && (
        <p style={{ margin: '0 0 8px' }}>
          Intentionally removed:
          {[isFieldRemoved(detail, 'curatedTitle') ? 'title' : null, isFieldRemoved(detail, 'curatedDescription') ? 'description' : null].filter(Boolean).join(', ')}
          {' '}— no fallback text will be released for the removed field; re-run the check to certify the narrowed listing.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, margin: '0 0 8px' }}>
        <button type="button" disabled={busy !== null} onClick={() => { setBusy('rerun'); setError(null); void rerun().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(null)); }}>
          {busy === 'rerun' ? 'Working…' : 'Re-run check'}
        </button>
      </div>
      {record.findings.length > 0 && (
        <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          {record.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      )}
      {actionable.length === 0 && !blocked && !unavailable ? (
        <p style={{ margin: 0 }}>Every material claim is supported by eligible evidence for this SKU.</p>
      ) : null}
      {actionable.length > 0 && (() => {
        const embeddedEvidence = (detail?.item.curationData as { classificationEvidence?: Array<{ id?: unknown; value?: unknown; snippet?: unknown; sourceField?: unknown }> } | null | undefined)?.classificationEvidence;
        const evidenceById: Record<string, string> = {};
        if (Array.isArray(embeddedEvidence)) {
          for (const row of embeddedEvidence) {
            if (!row || typeof row.id !== 'string' || !row.id) continue;
            const text = typeof row.value === 'string' && row.value.trim() ? row.value : typeof row.snippet === 'string' ? row.snippet : '';
            const source = typeof row.sourceField === 'string' && row.sourceField ? ` [${row.sourceField}]` : '';
            if (text.trim()) evidenceById[row.id] = `${text.trim()}${source}`;
          }
        }
        return (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {actionable.map((claim) => (
            <ClaimRow
              key={claim.id}
              claim={claim}
              busy={busy === claim.id}
              evidenceById={evidenceById}
              onRemove={() => void removeClaimText(claim)}
              onCorrect={(value) => void correctClaimText(claim, value)}
              onVerify={
                claim.verdict === 'insufficient' || claim.verdict === 'unavailable'
                  ? () => setVerifyOpen(claim.id)
                  : null
              }
            />
          ))}
        </ul>
        );
      })()}
      {resolvedVerified.length > 0 && (
        <section aria-label="Operator-verified claims" style={{ marginTop: 12 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: '0.9rem' }}>Operator-verified</h4>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {resolvedVerified.map((claim) => (
              <ClaimRow
                key={claim.id}
                claim={claim}
                busy={false}
                evidenceById={{}}
                onRemove={() => void removeClaimText(claim)}
                onCorrect={(value) => void correctClaimText(claim, value)}
                onVerify={null}
              />
            ))}
          </ul>
        </section>
      )}
      {verifyOpen && id ? (
        <VerifyClaimForm
          itemId={id}
          claimId={verifyOpen}
          claimIds={[verifyOpen]}
          onClose={() => setVerifyOpen(null)}
          onVerified={() => {
            setVerifyOpen(null);
            void refresh();
          }}
          onError={setError}
        />
      ) : null}
      {error && (
        <p role="alert" style={{ color: 'var(--color-error, #b00)' }}>{error}</p>
      )}
    </section>
  );
}

function ClaimRow({
  claim,
  busy,
  evidenceById,
  onRemove,
  onCorrect,
  onVerify,
}: {
  claim: ListingEvidenceClaim;
  busy: boolean;
  evidenceById: Record<string, string>;
  onRemove: () => void;
  onCorrect: (value: string) => void;
  onVerify: (() => void) | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(claim.text.startsWith('[') ? '' : claim.text);
  return (
    <li
      style={{
        border: '1px solid var(--color-border, #ddd)',
        borderRadius: 6,
        padding: 8,
        marginBottom: 8,
      }}
    >
      <div>
        <strong>{fieldLabel(claim.field)}</strong>
        {' · '}
        <span>verdict: {claim.verdict}</span>
        {' · '}
        <span>producer: {claim.producer.replace(/_/g, ' ')}</span>
        {claim.producer === 'operator_verified' ? (
          <span style={{ marginLeft: 6, fontWeight: 600 }}>Operator-verified — human attestation, not model support</span>
        ) : null}
      </div>
      <div style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{claim.text}</div>
      {claim.reason && <div style={{ fontSize: '0.85rem', opacity: 0.85 }}>{claim.reason}</div>}
      {claim.evidenceConsidered.length > 0 && (
        <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: '0.85rem', opacity: 0.85 }}>
          {claim.evidenceConsidered.map((evidenceId) => (
            <li key={evidenceId}>
              <span>{evidenceId}</span>
              {evidenceById[evidenceId] ? <span>: {evidenceById[evidenceId]}</span> : null}
            </li>
          ))}
          {claim.modelCallId ? <li>model call {claim.modelCallId}</li> : null}
        </ul>
      )}
      {!editing ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            Correct
          </button>
          <button type="button" disabled={busy} onClick={onRemove}>
            {busy ? 'Working…' : 'Remove'}
          </button>
          {onVerify && (claim.verdict === 'insufficient' || claim.verdict === 'unavailable') ? (
            <button type="button" disabled={busy} onClick={onVerify}>
              Verify
            </button>
          ) : null}
        </div>
      ) : (
        <form
          style={{ display: 'flex', gap: 8, marginTop: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            setEditing(false);
            onCorrect(value);
          }}
        >
          <label style={{ flex: 1 }} htmlFor={`claim-correct-${claim.id}`}>
            <span
              id={`claim-correct-label-${claim.id}`}
              style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
            >Corrected text</span>
            <input
              id={`claim-correct-${claim.id}`}
              aria-labelledby={`claim-correct-label-${claim.id}`}
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <button type="submit" disabled={busy}>Save</button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
    </li>
  );
}

function VerifyClaimForm({
  itemId,
  claimId,
  claimIds,
  onClose,
  onVerified,
  onError,
}: {
  itemId: string;
  claimId: string;
  claimIds: string[];
  onClose: () => void;
  onVerified: () => void;
  onError: (message: string | null) => void;
}) {
  const [observation, setObservation] = useState('');
  const [provenance, setProvenance] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [verifyState, setVerifyState] = useState<ListingEvidenceVerifyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Exact-replay binding (issue #367): one token per form instance, so a
  // network retry replays the same token and payload instead of stranding
  // a second receipt with `claim_not_unresolved`. Stale refusals
  // (revision_stale/evidence_stale after an intervening edit — including a
  // source_url change or re-run; issue #367 gap 7) reload verify state and
  // mint a FRESH token for the revised payload while preserving the typed
  // observation + provenance input.
  const [actionToken, setActionToken] = useState(() => generateListingVerifyActionToken());
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await getListingEvidenceVerifyState(itemId);
        if (!cancelled) setVerifyState(state);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof OnboardingApiError && err.code
              ? `Cannot verify right now (${err.code}).`
              : err instanceof Error ? err.message : 'Cannot load verification state.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);
  async function refreshState(): Promise<void> {
    setRefreshing(true);
    setLoadError(null);
    try {
      const state = await getListingEvidenceVerifyState(itemId);
      setVerifyState(state);
    } catch (err) {
      setLoadError(
        err instanceof OnboardingApiError && err.code
          ? `Cannot verify right now (${err.code}).`
          : err instanceof Error ? err.message : 'Cannot load verification state.',
      );
    } finally {
      setRefreshing(false);
    }
  }
  async function submit(): Promise<void> {
    const cleanedObservation = observation.trim();
    const cleanedProvenance = provenance.trim();
    if (cleanedObservation.length < 12 || cleanedProvenance.length < 12) {
      onError('Describe the current observation and its provenance (at least 12 characters each). Your input is kept.');
      return;
    }
    if (!verifyState?.expectedEvidenceHash || !verifyState?.expectedRevision) {
      onError('Verification state is still loading; your input is kept — wait, then submit again.');
      return;
    }
    setSubmitting(true);
    onError(null);
    try {
      await submitListingEvidenceVerify(
        itemId,
        {
          claimIds,
          observation: cleanedObservation,
          provenance: cleanedProvenance,
          expectedEvidenceHash: verifyState.expectedEvidenceHash,
          expectedRevision: verifyState.expectedRevision,
        },
        { actionToken },
      );
      onVerified();
    } catch (err) {
      // Stale refusals preserve the operator input AND rebind: reload the
      // revised claim state and mint a fresh token for the next attempt,
      // so retries never reuse the old revision. The typed observation +
      // provenance stay intact in state (issue #367 gap 7).
      const code = err instanceof OnboardingApiError ? err.code : null;
      if (code === 'revision_stale' || code === 'evidence_stale') {
        try {
          const state = await getListingEvidenceVerifyState(itemId);
          setVerifyState(state);
        } catch {
          /* keep the prior state; the Refresh button retries */
        }
        setActionToken(generateListingVerifyActionToken());
        onError(`${err instanceof Error ? err.message : 'Verification state changed.'} Your input is kept — bindings refreshed, review and resubmit.`);
      } else {
        onError(err instanceof Error ? err.message : 'Verification failed. Your input is kept.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      aria-label={`Verify claim ${claimId}`}
      style={{ border: '1px solid var(--color-border, #ddd)', borderRadius: 6, padding: 8, marginTop: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <strong>Verify claim {claimId} from a current observation</strong>
      <p style={{ margin: '4px 0', fontSize: '0.85rem', opacity: 0.85 }}>
        Verification records an operator attestation bound to the exact claim, evidence, and revision —
        never model support. Approving alone creates no evidence.
      </p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      <label style={{ display: 'block', marginTop: 8 }}>
        <span>Current observation (what you verified, verbatim)</span>
        <textarea
          value={observation}
          disabled={submitting}
          onChange={(event) => setObservation(event.target.value)}
          rows={3}
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>
        <span>Provenance (what you inspected and where)</span>
        <textarea
          value={provenance}
          disabled={submitting}
          onChange={(event) => setProvenance(event.target.value)}
          rows={2}
          style={{ width: '100%' }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="submit" disabled={submitting}>Submit verification</button>
        <button type="button" disabled={submitting || refreshing} onClick={() => void refreshState()}>Refresh bindings</button>
        <button type="button" disabled={submitting} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
