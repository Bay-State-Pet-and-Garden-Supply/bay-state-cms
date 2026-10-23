import { useEffect, useState } from 'react';
import { getApiAuthHeaders } from '../../api';
import { ListingCompletenessStandardSchema, ListingRequirementSchema, type ListingCompletenessStandard, type ListingRequirement } from '../../../shared/schemas/item-evidence';

interface StandardsSnapshot { standards: ListingCompletenessStandard[]; documentHash: string | null; bundleHash: string }
interface Preview { standard: ListingCompletenessStandard; documentHash: string | null; bundleHash: string }

export function ListingStandardsEditor() {
  const [snapshot, setSnapshot] = useState<StandardsSnapshot | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [standardId, setStandardId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [productTypeId, setProductTypeId] = useState('');
  const [requirementsText, setRequirementsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(): Promise<void> {
    setError(null);
    try {
      const response = await fetch('/api/onboarding/listing-standards', { headers: getApiAuthHeaders() });
      if (!response.ok) throw new Error(`Standards could not be loaded (${response.status}).`);
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('standards' in value) || !Array.isArray(value.standards) || !('documentHash' in value) || !('bundleHash' in value)) throw new Error('Standards response is incomplete.');
      setSnapshot({ standards: value.standards.map(standard => ListingCompletenessStandardSchema.parse(standard)),
        documentHash: typeof value.documentHash === 'string' ? value.documentHash : null,
        bundleHash: typeof value.bundleHash === 'string' ? value.bundleHash : '' });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Standards could not be loaded.'); }
  }
  useEffect(() => { void load(); }, []);
  function parseRequirements(): ListingRequirement[] {
    const value: unknown = JSON.parse(requirementsText);
    if (!Array.isArray(value)) throw new Error('Requirements must be a JSON array.');
    return value.map(entry => ListingRequirementSchema.parse(entry));
  }
  async function makePreview(): Promise<void> {
    if (!snapshot) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/onboarding/listing-standards/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders() },
        body: JSON.stringify({ standardId, categoryId, productTypeId, requirements: parseRequirements() }),
      });
      if (!response.ok) throw new Error(`Preview failed (${response.status}).`);
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('standard' in value) || !('documentHash' in value) || !('bundleHash' in value)) throw new Error('Preview response is incomplete.');
      setPreview({ standard: ListingCompletenessStandardSchema.parse(value.standard),
        documentHash: typeof value.documentHash === 'string' ? value.documentHash : null,
        bundleHash: typeof value.bundleHash === 'string' ? value.bundleHash : '' });
    } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Preview failed.'); }
    finally { setBusy(false); }
  }
  async function apply(): Promise<void> {
    if (!snapshot || !preview) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/onboarding/listing-standards/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders() },
        body: JSON.stringify({ standardId, categoryId, productTypeId, requirements: preview.standard.requirements,
          expectedDocumentHash: preview.documentHash, expectedBundleHash: preview.bundleHash }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'Standards changed since preview. Reload and preview again.' : `Apply failed (${response.status}).`);
      setPreview(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Apply failed.'); }
    finally { setBusy(false); }
  }
  const inputStyle = { display: 'block', boxSizing: 'border-box', width: '100%', maxWidth: 560, margin: '4px 0 12px', padding: '8px', border: '1px solid var(--color-card-border, #aaa)', borderRadius: 4 } as const;
  return <section aria-labelledby="listing-standards-heading" style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--color-card-border, #aaa)' }}>
    <h3 id="listing-standards-heading">Listing completeness standards</h3>
    <p>Standards are classification-specific and saved to the workspace Git history. No default requirements are assumed.</p>
    {snapshot ? <ul>{snapshot.standards.map(standard => <li key={standard.id}>{standard.categoryId} / {standard.productTypeId} · revision {standard.revision} · {standard.requirements.length} requirements</li>)}</ul> : <p role="status">Loading standards…</p>}
    <form onSubmit={event => { event.preventDefault(); void makePreview(); }}>
      <label>Standard ID<input required value={standardId} onChange={event => { setStandardId(event.target.value); setPreview(null); }} style={inputStyle} /></label>
      <label>Category ID<input required value={categoryId} onChange={event => { setCategoryId(event.target.value); setPreview(null); }} style={inputStyle} /></label>
      <label>Product Type ID<input required value={productTypeId} onChange={event => { setProductTypeId(event.target.value); setPreview(null); }} style={inputStyle} /></label>
      <label>Requirements (JSON array)<textarea required rows={8} value={requirementsText} onChange={event => { setRequirementsText(event.target.value); setPreview(null); }} style={{ ...inputStyle, fontFamily: 'monospace' }} aria-describedby="listing-requirements-help" /></label>
      <p id="listing-requirements-help">Each requirement is validated against the shared finite schema before preview; only review-approved classification pairs should be configured.</p>
      <button type="submit" disabled={busy || !snapshot}>Preview changes</button>
    </form>
    {preview && <div aria-live="polite" style={{ marginTop: 12 }}>
      <h4>Preview: {preview.standard.categoryId} / {preview.standard.productTypeId}</h4>
      <p>{preview.standard.requirements.length} requirements · policy hash {preview.standard.standardHash}</p>
      <button type="button" disabled={busy} onClick={() => void apply()}>Apply and commit standard</button>
      <button type="button" disabled={busy} onClick={() => setPreview(null)}>Discard preview</button>
    </div>}
    <button type="button" disabled={busy} onClick={() => void load()} style={{ marginLeft: 8 }}>Reload standards</button>
    {error && <p role="alert" style={{ color: 'var(--color-error, #a32121)' }}>{error}</p>}
    {busy && <p role="status">Saving standards…</p>}
  </section>;
}
