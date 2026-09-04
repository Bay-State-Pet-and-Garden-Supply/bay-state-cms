/**
 * Parent #101 (manual-evidence route, ticket #103 thin slice) — operator
 * manual-evidence form for a profile-blocked item.
 *
 * Thin-slice field set: per-SKU title (required) + brand (optional), with an
 * optional family page URL shown and stored as REFERENCE ONLY (never the
 * extraction source — the server persists a NULL extraction source URL).
 * Submission requires all three attestations; the UI never supplies
 * provenance (the server derives sourceType, identityStatus, hashes, and the
 * attestation link). No bulk action, no auto-suggest.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  getManualEvidence,
  submitManualEvidence,
  withdrawManualEvidence,
} from '../../../onboarding-api';

interface ManualEvidencePanelProps {
  itemId: string;
  defaultTitle: string;
  defaultBrand?: string | null;
  /** Called with the attestation id after a successful submission. */
  onSubmitted?: (attestationId: string) => void;
}

export function ManualEvidencePanel({
  itemId,
  defaultTitle,
  defaultBrand,
  onSubmitted,
}: ManualEvidencePanelProps): React.ReactElement {
  const [title, setTitle] = useState(defaultTitle);
  const [brand, setBrand] = useState(defaultBrand ?? '');
  const [familyReferenceUrl, setFamilyReferenceUrl] = useState('');
  const [noFamilyInheritance, setNoFamilyInheritance] = useState(false);
  const [perSkuVerified, setPerSkuVerified] = useState(false);
  const [rightsAttested, setRightsAttested] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedAttestationId, setSubmittedAttestationId] = useState<string | null>(null);
  const [existingAttestation, setExistingAttestation] = useState<Record<string, unknown> | null>(null);

  const loadExisting = useCallback(async () => {
    try {
      const res = await getManualEvidence(itemId);
      setExistingAttestation(res.attestation);
    } catch {
      setExistingAttestation(null);
    }
  }, [itemId]);

  useEffect(() => {
    void loadExisting();
  }, [loadExisting]);

  const canSubmit =
    !busy && title.trim().length > 0 && noFamilyInheritance && perSkuVerified && rightsAttested;

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await submitManualEvidence(itemId, {
        title: title.trim(),
        brand: brand.trim() || null,
        familyReferenceUrl: familyReferenceUrl.trim() || null,
        attestation: {
          noFamilyInheritance: true,
          perSkuVerified: true,
          rightsAttested: true,
          notes: notes.trim() || null,
        },
      });
      setSubmittedAttestationId(res.attestationId);
      setExistingAttestation(null);
      onSubmitted?.(res.attestationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Manual evidence submission failed');
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await withdrawManualEvidence(itemId);
      setSubmittedAttestationId(null);
      await loadExisting();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally {
      setBusy(false);
    }
  };

  if (submittedAttestationId) {
    return (
      <section className="attn-section" aria-label="Manual evidence submitted">
        <h3 className="attn-section-title">Manual evidence recorded</h3>
        <div className="attn-section-body">
          <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem' }}>
            Extraction is complete for this product. Attestation <code>{submittedAttestationId}</code> —
            the item returns to extraction and still passes Review before promotion.
          </p>
          <button type="button" className="btn btn-outline" onClick={() => void handleWithdraw()} disabled={busy}>
            Withdraw manual evidence
          </button>
          {error ? <div className="attn-error" role="alert">{error}</div> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="attn-section" aria-label="Enter manual evidence">
      <h3 className="attn-section-title">Enter product facts manually</h3>
      <div className="attn-section-body">
        <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-body)', fontSize: '0.8125rem' }}>
          This brand exposes only a product family page — there is no per-product page to extract from.
          Transcribe this product&apos;s facts below. Nothing is copied from the family page automatically.
        </p>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Per-product title (required)
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Per-product title"
          />
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Brand (optional)
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Brand"
          />
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Family page URL — reference only, not the extraction source (optional)
          <input
            type="url"
            value={familyReferenceUrl}
            onChange={(e) => setFamilyReferenceUrl(e.target.value)}
            placeholder="https://brand.example.com/family-page"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Family page URL, reference only, not the extraction source"
          />
        </label>
        <fieldset style={{ border: '1px solid var(--color-card-border)', padding: 8, marginBottom: 8 }}>
          <legend style={{ fontSize: '0.8125rem' }}>Attestation (all required)</legend>
          <label style={{ display: 'block', fontSize: '0.8125rem' }}>
            <input type="checkbox" checked={noFamilyInheritance} onChange={(e) => setNoFamilyInheritance(e.target.checked)} />{' '}
            No family inheritance — every field above was verified for this exact product
          </label>
          <label style={{ display: 'block', fontSize: '0.8125rem' }}>
            <input type="checkbox" checked={perSkuVerified} onChange={(e) => setPerSkuVerified(e.target.checked)} />{' '}
            Per-product verified — I checked these facts against the product itself
          </label>
          <label style={{ display: 'block', fontSize: '0.8125rem' }}>
            <input type="checkbox" checked={rightsAttested} onChange={(e) => setRightsAttested(e.target.checked)} />{' '}
            Image rights — I have the right to use any images for this product
          </label>
        </fieldset>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Notes (optional)
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ display: 'block', width: '100%', marginTop: 4 }} />
        </label>
        {existingAttestation ? (
          <p style={{ fontSize: '0.8125rem' }}>
            An active manual submission already exists for this product.{' '}
            <button type="button" className="btn btn-outline" onClick={() => void handleWithdraw()} disabled={busy}>
              Withdraw it
            </button>
          </p>
        ) : null}
        {error ? <div className="attn-error" role="alert">{error}</div> : null}
        <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {busy ? 'Submitting…' : 'Submit manual evidence'}
        </button>
      </div>
    </section>
  );
}
