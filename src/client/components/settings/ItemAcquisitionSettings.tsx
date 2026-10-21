import { useEffect, useState } from 'react';
import { getApiAuthHeaders } from '../../api';
import { z } from 'zod';
import { ItemAcquisitionPolicySchema, type ItemAcquisitionPolicy } from '../../../shared/schemas/item-acquisition';
import { colors, fonts, rounded } from '../../theme';

const SettingsResponseSchema = z.object({
  policy: ItemAcquisitionPolicySchema.nullable(),
  documentHash: z.string().nullable(),
  gitHead: z.string().nullable(),
  policyHash: z.string().nullable(),
  pricingHash: z.string().nullable(),
  hasCredential: z.boolean(),
  policyStatus: z.enum(['unconfigured', 'enabled', 'disabled']),
}).strict();
const PreviewResponseSchema = z.object({
  policy: ItemAcquisitionPolicySchema,
  policyHash: z.string().min(1),
  pricingHash: z.string().min(1),
  documentHash: z.string().nullable(),
  gitHead: z.string().nullable(),
  findings: z.array(z.string()),
}).strict();

type SettingsSnapshot = z.infer<typeof SettingsResponseSchema>;
type PolicyPreview = z.infer<typeof PreviewResponseSchema>;

export function ItemAcquisitionSettings() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [policyText, setPolicyText] = useState('');
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    setError(null);
    try {
      const response = await fetch('/api/onboarding/item-acquisition/settings', { headers: getApiAuthHeaders() });
      if (!response.ok) throw new Error(`Acquisition settings could not be loaded (${response.status}).`);
      const next = SettingsResponseSchema.parse(await response.json());
      setSnapshot(next);
      setPolicyText(next.policy ? JSON.stringify(next.policy, null, 2) : '');
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Acquisition settings could not be loaded.');
    }
  }

  useEffect(() => { void load(); }, []);

  function parsePolicy(): ItemAcquisitionPolicy {
    const raw: unknown = JSON.parse(policyText);
    return ItemAcquisitionPolicySchema.parse(raw);
  }

  async function makePreview(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/onboarding/item-acquisition/settings/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders() },
        body: JSON.stringify({ policy: parsePolicy() }),
      });
      if (!response.ok) throw new Error(response.status === 409
        ? 'The approved policy changed. Reload settings and preview again.'
        : `Policy preview failed (${response.status}).`);
      setPreview(PreviewResponseSchema.parse(await response.json()));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : 'Policy preview failed.');
    } finally {
      setBusy(false);
    }
  }

  async function applyPolicy(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/onboarding/item-acquisition/settings/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders() },
        body: JSON.stringify({
          policy: preview.policy,
          expectedDocumentHash: preview.documentHash,
          expectedGitHead: preview.gitHead,
          expectedPolicyHash: preview.policyHash,
        }),
      });
      if (!response.ok) throw new Error(response.status === 409
        ? 'The approved policy or Git revision changed after preview. Reload and review again.'
        : `Policy could not be applied (${response.status}).`);
      setPreview(null);
      setNotice('The reviewed policy was committed to workspace Git history.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Policy could not be applied.');
    } finally {
      setBusy(false);
    }
  }

  async function saveCredential(apiKeyValue: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/onboarding/item-acquisition/credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders() },
        body: JSON.stringify({ apiKey: apiKeyValue }),
      });
      if (!response.ok) throw new Error(`Brave Search credential could not be updated (${response.status}).`);
      setApiKey('');
      await load();
      setNotice(apiKeyValue === null ? 'The Brave Search credential was removed.' : 'The Brave Search credential was saved. The secret is not displayed again.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Brave Search credential could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle = {
    display: 'block', width: '100%', maxWidth: 860, margin: '5px 0 12px', padding: '9px 10px',
    border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, color: colors.ledgerCharcoal,
    background: colors.whiteSurface, font: `0.875rem ${fonts.body}`,
  } as const;
  const buttonStyle = {
    padding: '8px 12px', border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm,
    background: colors.whiteSurface, color: colors.ledgerCharcoal, font: `500 0.8125rem ${fonts.body}`, cursor: 'pointer',
  } as const;

  return <section aria-labelledby="item-acquisition-heading" style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${colors.cardBorder}`, color: colors.ledgerCharcoal }}>
    <h3 id="item-acquisition-heading" style={{ margin: '0 0 8px', fontSize: '1.05rem' }}>Item acquisition policy</h3>
    <p style={{ maxWidth: '72ch', color: colors.mulchBrown, lineHeight: 1.55 }}>
      Supplemental acquisition is unavailable until a reviewed, enabled policy is committed. Every item and batch resource ceiling and each applicable provider price must be explicit; no production limits or prices are assumed.
    </p>

    {snapshot ? <div aria-live="polite" style={{ margin: '14px 0', padding: '10px 0', borderTop: `1px solid ${colors.cardBorder}`, borderBottom: `1px solid ${colors.cardBorder}` }}>
      <p style={{ margin: '4px 0' }}>Policy status: <strong>{snapshot.policyStatus}</strong></p>
      <p style={{ margin: '4px 0', color: colors.mulchBrown }}>Brave Search credential: {snapshot.hasCredential ? 'configured' : 'not configured'} · credential values are never returned to this page.</p>
      {snapshot.policyHash && <p style={{ margin: '4px 0', color: colors.mulchBrown }}>Policy hash <code>{snapshot.policyHash}</code> · pricing hash <code>{snapshot.pricingHash}</code></p>}
      {snapshot.gitHead && <p style={{ margin: '4px 0', color: colors.mulchBrown }}>Workspace Git revision <code>{snapshot.gitHead}</code></p>}
      {!snapshot.policy && <p style={{ margin: '8px 0', color: colors.mulchBrown }}>No policy is configured. Enter a complete reviewed policy below; the editor does not populate production caps or prices.</p>}
    </div> : <p role="status" style={{ color: colors.mulchBrown }}>Loading acquisition settings…</p>}

    <form onSubmit={event => { event.preventDefault(); void makePreview(); }}>
      <label htmlFor="item-acquisition-policy-json" style={{ display: 'block', fontWeight: 600 }}>Reviewed policy JSON</label>
      <textarea
        id="item-acquisition-policy-json"
        required
        rows={20}
        value={policyText}
        onChange={event => { setPolicyText(event.target.value); setPreview(null); }}
        spellCheck={false}
        style={{ ...fieldStyle, maxWidth: 980, fontFamily: fonts.mono, fontSize: '0.8rem', lineHeight: 1.5, resize: 'vertical' }}
        aria-describedby="item-acquisition-policy-help"
      />
      <p id="item-acquisition-policy-help" style={{ maxWidth: '72ch', marginTop: -4, color: colors.mulchBrown, fontSize: '0.8125rem', lineHeight: 1.5 }}>
        Use the shared policy schema: explicit itemLimits and batchLimits, an exact provider/model price entry for every model, and service prices for each approved external adapter. Unknown pricing is not free; a requested money ceiling prevents dispatch when the bound is not enforceable.
      </p>
      <button type="submit" disabled={busy || !snapshot} style={buttonStyle}>Preview policy</button>
      <button type="button" disabled={busy} onClick={() => { void load(); }} style={{ ...buttonStyle, marginLeft: 8 }}>Reload</button>
    </form>

    {preview && <div aria-live="polite" style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.cardBorder}` }}>
      <h4 style={{ margin: '0 0 8px' }}>Policy review</h4>
      <p style={{ maxWidth: '72ch', color: colors.mulchBrown, lineHeight: 1.5 }}>
        {preview.policy.enabled ? 'Enabled policy' : 'Disabled policy'} · {preview.policy.models.length} model price entries · {preview.policy.services.length} service price entries.
      </p>
      <p>Policy hash <code>{preview.policyHash}</code> · pricing hash <code>{preview.pricingHash}</code></p>
      {preview.findings.map(finding => <p key={finding} role="status" style={{ color: colors.mulchBrown }}>{finding}</p>)}
      <button type="button" disabled={busy || !preview.gitHead} onClick={() => { void applyPolicy(); }} style={buttonStyle}>Apply and commit policy</button>
      <button type="button" disabled={busy} onClick={() => setPreview(null)} style={{ ...buttonStyle, marginLeft: 8 }}>Discard preview</button>
      {!preview.gitHead && <p role="alert">A committed workspace Git revision is required before this policy can be applied.</p>}
    </div>}

    <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${colors.cardBorder}` }}>
      <h4 style={{ margin: '0 0 8px' }}>Brave Search credential</h4>
      <p style={{ maxWidth: '72ch', color: colors.mulchBrown, lineHeight: 1.5 }}>
        Stored through the credential repository. Existing secret material cannot be read back; enter the complete key to replace it.
      </p>
      <label htmlFor="brave-search-api-key" style={{ display: 'block', fontWeight: 600 }}>API key</label>
      <input id="brave-search-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} style={fieldStyle} />
      <button type="button" disabled={busy || apiKey.trim().length === 0} onClick={() => { void saveCredential(apiKey); }} style={buttonStyle}>Save credential</button>
      {snapshot?.hasCredential && <button type="button" disabled={busy} onClick={() => { void saveCredential(null); }} style={{ ...buttonStyle, marginLeft: 8 }}>Remove credential</button>}
    </div>

    {notice && <p role="status" style={{ marginTop: 12, color: colors.seedlingGreen }}>{notice}</p>}
    {error && <p role="alert" style={{ marginTop: 12, color: 'var(--color-error, #a32121)' }}>{error}</p>}
    {busy && <p role="status" style={{ color: colors.mulchBrown }}>Saving reviewed settings…</p>}
  </section>;
}
