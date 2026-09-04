/**
 * Parent #101 (manual-evidence route, ticket #104 full set) — operator
 * manual-evidence form for a profile-blocked item.
 *
 * Full field set: per-SKU title (required) + brand/description/bullets/
 * weight/dimensions/images (optional), each with a per-field source-kind
 * selector; every image needs its own rights checkbox. The family page URL
 * and pasted family text are REFERENCE ONLY (never the extraction source —
 * the server persists a NULL extraction source URL, and the pasted text is
 * used only for the inheritance guard). Submission requires all three
 * attestations; the UI never supplies provenance (the server derives
 * sourceType, identityStatus, hashes, and the attestation link). A
 * distributor record, when present, renders read-only for side-by-side
 * consultation — the panel never auto-fills from it and never links to it.
 * No bulk action, no auto-suggest.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  getManualEvidence,
  submitManualEvidence,
  withdrawManualEvidence,
  type ManualEvidenceFieldSourceKind,
  type SubmitManualEvidenceBody,
} from '../../../onboarding-api';

interface ManualEvidencePanelProps {
  itemId: string;
  defaultTitle: string;
  defaultBrand?: string | null;
  /** Called with the attestation id after a successful submission. */
  onSubmitted?: (attestationId: string) => void;
}

const SOURCE_KINDS: ManualEvidenceFieldSourceKind[] = [
  'operator_transcription',
  'packaging_photo',
  'distributor_sheet',
  'brand_family_reference',
];

const SOURCE_KIND_LABELS: Record<ManualEvidenceFieldSourceKind, string> = {
  operator_transcription: 'Typed by me',
  packaging_photo: 'Packaging photo',
  distributor_sheet: 'Distributor sheet',
  brand_family_reference: 'Family page viewed',
};

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ManualEvidencePanel({
  itemId,
  defaultTitle,
  defaultBrand,
  onSubmitted,
}: ManualEvidencePanelProps): React.ReactElement {
  const [title, setTitle] = useState(defaultTitle);
  const [brand, setBrand] = useState(defaultBrand ?? '');
  const [description, setDescription] = useState('');
  const [bulletsRaw, setBulletsRaw] = useState('');
  const [weight, setWeight] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [primaryImage, setPrimaryImage] = useState('');
  const [additionalImagesRaw, setAdditionalImagesRaw] = useState('');
  const [fieldSources, setFieldSources] = useState<Record<string, ManualEvidenceFieldSourceKind>>({});
  const [rightsApprovedUrls, setRightsApprovedUrls] = useState<string[]>([]);
  const [familyReferenceUrl, setFamilyReferenceUrl] = useState('');
  const [familyReferenceText, setFamilyReferenceText] = useState('');
  const [distributorReference, setDistributorReference] = useState<Record<string, string> | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
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
      setDistributorReference(res.distributorReference ?? null);
    } catch {
      setExistingAttestation(null);
      setDistributorReference(null);
    }
  }, [itemId]);

  useEffect(() => {
    void loadExisting();
  }, [loadExisting]);

  const additionalImages = splitLines(additionalImagesRaw);
  const enteredImages = [
    ...(primaryImage.trim() ? [primaryImage.trim()] : []),
    ...additionalImages,
  ];

  const setKind = (field: string, kind: ManualEvidenceFieldSourceKind) => {
    setFieldSources((prev) => ({ ...prev, [field]: kind }));
  };

  const toggleRights = (url: string) => {
    setRightsApprovedUrls((prev) => (prev.includes(url) ? prev.filter((entry) => entry !== url) : [...prev, url]));
  };

  const imagesWithMissingRights = enteredImages.filter((url) => !rightsApprovedUrls.includes(url));

  const canSubmit =
    !busy &&
    title.trim().length > 0 &&
    noFamilyInheritance &&
    perSkuVerified &&
    rightsAttested &&
    (enteredImages.length === 0 || imagesWithMissingRights.length === 0);

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: SubmitManualEvidenceBody = {
        title: title.trim(),
        brand: brand.trim() || null,
        description: description.trim() || null,
        bulletPoints: splitLines(bulletsRaw),
        weight: weight.trim() || null,
        dimensions: dimensions.trim() || null,
        primaryImage: primaryImage.trim() || null,
        additionalImages,
        fieldSources,
        imageApprovals: rightsApprovedUrls.map((imageUrl) => ({ imageUrl, rightsAttested: true as const })),
        familyReferenceText: familyReferenceText.trim() || null,
        familyReferenceUrl: familyReferenceUrl.trim() || null,
        overrideDistributorReason: overrideReason.trim() || null,
        attestation: {
          noFamilyInheritance: true,
          perSkuVerified: true,
          rightsAttested: true,
          notes: notes.trim() || null,
        },
      };
      const res = await submitManualEvidence(itemId, body);
      setSubmittedAttestationId(res.attestationId);
      setExistingAttestation(null);
      setNeedsOverride(false);
      onSubmitted?.(res.attestationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Manual evidence submission failed';
      setError(message);
      // A qualified distributor record already exists: reveal the explicit
      // override-reason input instead of failing silently. The reason is
      // recorded on the attestation; it never links the manual row to the
      // distributor record.
      if (/distributor record already exists/i.test(message)) {
        setNeedsOverride(true);
      }
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

  const renderKindSelect = (field: string, label: string) => (
    <label style={{ display: 'block', fontSize: '0.75rem', marginTop: 4 }}>
      {label} source
      <select
        value={fieldSources[field] ?? 'operator_transcription'}
        onChange={(e) => setKind(field, e.target.value as ManualEvidenceFieldSourceKind)}
        style={{ display: 'block', width: '100%', marginTop: 2 }}
        aria-label={`${label} source`}
      >
        {SOURCE_KINDS.map((kind) => (
          <option key={kind} value={kind}>{SOURCE_KIND_LABELS[kind]}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="attn-section" aria-label="Enter manual evidence">
      <h3 className="attn-section-title">Enter product facts manually</h3>
      <div className="attn-section-body">
        <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-body)', fontSize: '0.8125rem' }}>
          This brand exposes only a product family page — there is no per-product page to extract from.
          Transcribe this product&apos;s facts below. Nothing is copied from the family page automatically.
        </p>
        {distributorReference ? (
          <div style={{ border: '1px dashed var(--color-card-border)', padding: 8, marginBottom: 8 }}>
            <p style={{ margin: '0 0 4px', fontSize: '0.8125rem', fontWeight: 600 }}>
              Distributor reference (read-only — type values yourself, nothing auto-fills)
            </p>
            {Object.entries(distributorReference).map(([field, value]) => (
              <p key={field} style={{ margin: '0 0 2px', fontSize: '0.75rem' }}>
                <strong>{field}:</strong> {value}
              </p>
            ))}
          </div>
        ) : null}
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
          {renderKindSelect('brand', 'Brand')}
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Description (optional)
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Description"
          />
          {renderKindSelect('description', 'Description')}
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Bullet points (optional, one per line, max 10)
          <textarea
            value={bulletsRaw}
            onChange={(e) => setBulletsRaw(e.target.value)}
            rows={3}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Bullet points, one per line"
          />
          {renderKindSelect('bulletPoints', 'Bullets')}
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Weight (optional, e.g. &ldquo;2 lb&rdquo; — must be parseable, otherwise omitted)
          <input
            type="text"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Weight"
          />
          {renderKindSelect('weight', 'Weight')}
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Dimensions (optional)
          <input
            type="text"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Dimensions"
          />
          {renderKindSelect('dimensions', 'Dimensions')}
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Primary image URL (optional — requires its rights checkbox below)
          <input
            type="url"
            value={primaryImage}
            onChange={(e) => setPrimaryImage(e.target.value)}
            placeholder="https://…"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Primary image URL"
          />
          {renderKindSelect('primaryImage', 'Primary image')}
        </label>
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Additional image URLs (optional, one per line — each requires its rights checkbox below)
          <textarea
            value={additionalImagesRaw}
            onChange={(e) => setAdditionalImagesRaw(e.target.value)}
            rows={2}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Additional image URLs, one per line"
          />
          {renderKindSelect('additionalImages', 'Additional images')}
        </label>
        {enteredImages.length > 0 ? (
          <fieldset style={{ border: '1px solid var(--color-card-border)', padding: 8, marginBottom: 8 }}>
            <legend style={{ fontSize: '0.8125rem' }}>Per-image rights (each required)</legend>
            {enteredImages.map((url) => (
              <label key={url} style={{ display: 'block', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                <input type="checkbox" checked={rightsApprovedUrls.includes(url)} onChange={() => toggleRights(url)} />{' '}
                I have the right to use {url}
              </label>
            ))}
          </fieldset>
        ) : null}
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
        <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
          Family page text — reference only, never evidence (optional paste, used only to check you didn&apos;t copy it)
          <textarea
            value={familyReferenceText}
            onChange={(e) => setFamilyReferenceText(e.target.value)}
            rows={2}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
            aria-label="Family page text, reference only, never evidence"
          />
        </label>
        {needsOverride ? (
          <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: 8 }}>
            A distributor record already exists — explain why manual evidence is still needed
            <input
              type="text"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 4 }}
              aria-label="Distributor override reason"
            />
          </label>
        ) : null}
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
