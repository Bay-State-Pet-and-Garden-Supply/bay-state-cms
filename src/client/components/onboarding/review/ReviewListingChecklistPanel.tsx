import { getApiAuthHeaders } from '../../../api';
import { useCallback, useEffect, useState } from 'react';
import { ItemChecklistEvaluationSchema, type ItemChecklistEvaluation } from '../../../../shared/schemas/item-evidence';

interface Receipt { revision: number; requirementId: string; decision: 'approved' | 'revoked' }
interface ResponseBody { evaluation: ItemChecklistEvaluation; exceptions: Receipt[]; nonWaivableFields: string[] }

export function ReviewListingChecklistPanel({ itemId, onChanged }: { itemId: string; onChanged?: () => void | Promise<void> }) {
  const [data, setData] = useState<ResponseBody | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [actionTokens, setActionTokens] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const response = await fetch(`/api/onboarding/items/${encodeURIComponent(itemId)}/listing-readiness`, { headers: getApiAuthHeaders() });
      if (!response.ok) throw new Error(`Checklist refresh failed (${response.status}).`);
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('evaluation' in value) || !('exceptions' in value)) throw new Error('Checklist response is incomplete.');
      const evaluation = ItemChecklistEvaluationSchema.parse(value.evaluation);
      const exceptions = Array.isArray(value.exceptions) ? value.exceptions.filter((entry): entry is Receipt =>
        !!entry && typeof entry === 'object' && 'revision' in entry && typeof entry.revision === 'number' &&
        'requirementId' in entry && typeof entry.requirementId === 'string' && 'decision' in entry &&
        (entry.decision === 'approved' || entry.decision === 'revoked')) : [];
      const nonWaivableFields = 'nonWaivableFields' in value && Array.isArray(value.nonWaivableFields)
        ? value.nonWaivableFields.filter((field): field is string => typeof field === 'string') : [];
      setData({ evaluation, exceptions, nonWaivableFields });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Checklist could not be loaded.'); }
  }, [itemId]);
  useEffect(() => { void load(); }, [load]);

  async function decide(requirementId: string, decision: 'approved' | 'revoked'): Promise<void> {
    if (!data) return;
    const row = data.evaluation.requirements.find(entry => entry.requirementId === requirementId);
    const reasonText = reason[requirementId]?.trim();
    if (!row?.dependencyHash || !data.evaluation.inputHash || !data.evaluation.evidenceHash || !data.evaluation.standardHash || !data.evaluation.classificationHash) {
      setError('Current hashes are unavailable. Refresh the checklist before deciding.'); return;
    }
    if (decision === 'approved' && !reasonText) { setError('Enter a reason before approving an omission.'); return; }
    setBusy(requirementId); setError(null);
    const tokenKey = `${requirementId}:${decision}`;
    const actionToken = actionTokens[tokenKey] ?? crypto.randomUUID();
    setActionTokens(current => ({ ...current, [tokenKey]: actionToken }));
    try {
      const response = await fetch(`/api/onboarding/items/${encodeURIComponent(itemId)}/listing-exceptions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders(), 'Idempotency-Key': actionToken },
        body: JSON.stringify({ decision, requirementId, reason: reasonText || 'Revoked by operator.',
          expectedRevision: Math.max(0, ...data.exceptions.map(receipt => receipt.revision)), inputHash: data.evaluation.inputHash,
          evidenceHash: data.evaluation.evidenceHash, standardHash: data.evaluation.standardHash,
          classificationHash: data.evaluation.classificationHash, dependencyHash: row.dependencyHash }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'Checklist changed. Refresh and review the current finding.' : `Decision failed (${response.status}).`);
      setActionTokens(current => { const next = { ...current }; delete next[tokenKey]; return next; });
      await load();
      await onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Decision failed.'); }
    finally { setBusy(null); }
  }

  const evaluation = data?.evaluation;
  return <section aria-label="Listing completeness checklist" style={{ margin: '16px 0', padding: '12px 0', borderTop: '1px solid var(--color-border, #d2d7dc)' }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0 }}>Listing completeness</h3>
      <button type="button" onClick={() => void load()} disabled={busy !== null}>Refresh checklist</button>
    </div>
    {!evaluation && !error && <p role="status">Loading current requirements…</p>}
    {evaluation?.status === 'unavailable' && <p role="status">A current approved standard, classification, or evidence snapshot is unavailable. Resolve that source before review.</p>}
    {evaluation?.status === 'stale' && <p role="status">The checklist evidence or source state is stale. Refresh after resolving the current evidence findings.</p>}
    {evaluation && <ul style={{ listStyle: 'none', margin: '12px 0', padding: 0 }}>
      {evaluation.requirements.map(row => {
        const receipt = [...(data?.exceptions ?? [])].filter(entry => entry.requirementId === row.requirementId).sort((a, b) => b.revision - a.revision)[0];
        const nonWaivablePattern = /identity|(^|[^a-z])(sku|upc|gtin|variant|category|product.?type|safety|rights|licen[cs]e)([^a-z]|$)/i;
        const canApprove = row.required && row.exceptionEligible && !data?.nonWaivableFields.includes(row.field) &&
          !nonWaivablePattern.test(row.field) && (row.state === 'missing' || row.state === 'stale');
        return <li key={row.requirementId} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border, #d2d7dc)' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <strong>{row.label}{row.required ? ' · Required' : ' · Optional'}</strong>
            <span>{row.state.replaceAll('_', ' ')}</span>
          </div>
          {row.reason && <p style={{ margin: '4px 0' }}>{row.reason}</p>}
          {canApprove && <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}>
            <label style={{ flex: '1 1 220px' }}>Reason for omission
              <input value={reason[row.requirementId] ?? ''} onChange={event => {
                setReason(current => ({ ...current, [row.requirementId]: event.target.value }));
                setActionTokens(current => { const next = { ...current }; delete next[`${row.requirementId}:approved`]; return next; });
              }}
                aria-label={`Reason for omitting ${row.label}`} style={{ display: 'block', width: '100%' }} />
            </label>
            <button type="button" disabled={busy !== null || !reason[row.requirementId]?.trim()} onClick={() => void decide(row.requirementId, 'approved')}>Approve omission</button>
          </div>}
          {receipt?.decision === 'approved' && <button type="button" disabled={busy !== null} onClick={() => void decide(row.requirementId, 'revoked')}>Revoke omission</button>}
        </li>;
      })}
    </ul>}
    {error && <p role="alert" style={{ color: 'var(--color-error, #a32121)' }}>{error}</p>}
    {busy && <p role="status">Saving decision…</p>}
  </section>;
}
