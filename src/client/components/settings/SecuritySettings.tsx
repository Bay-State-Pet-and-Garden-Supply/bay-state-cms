import { useEffect, useState } from 'react';
import { generateSecurityToken, getSecuritySettings, updateSecuritySettings, type SecuritySettings as SecuritySettingsState } from '../../api';

export function SecuritySettings() {
  const [settings, setSettings] = useState<SecuritySettingsState | null>(null);
  const [generatedToken, setGeneratedToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void getSecuritySettings().then(setSettings).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // getApiAuthHeaders() prefers window.__BAYSTATE_TOKEN__ over localStorage,
  // so a rotation must replace BOTH, with the window credential winning.
  // Writing localStorage alone leaves the stale window token in force.
  function installBrowserCredential(token: string): void {
    try {
      window.localStorage.setItem('baystate_cms_api_token', token);
    } catch {
      // Storage unavailable (private mode): fall through to window credential.
    }
    (window as Window & { __BAYSTATE_TOKEN__?: string }).__BAYSTATE_TOKEN__ = token;
  }

  async function generateToken() {
    setBusy(true);
    setError('');
    setMessage('');
    setGeneratedToken('');
    try {
      const updated = await generateSecurityToken();
      setSettings(updated);
      setGeneratedToken(updated.generatedToken);
      installBrowserCredential(updated.generatedToken);
      setMessage('Token installed as the browser credential. Copy it now for API clients — it will not be shown again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setAdmin(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setSettings(await updateSecuritySettings(enabled));
      window.dispatchEvent(new CustomEvent('baystate:release-admin-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <section aria-labelledby="security-settings-title" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24 }}>
    <h2 id="security-settings-title" style={{ fontSize: 18, fontWeight: 600, margin: '0 0 16px', color: '#111827' }}>Security</h2>
    <p style={{ fontSize: 13, color: '#6b7280' }}>Manage the API token used to authorize mutating requests and the taxonomy release-admin gate. Environment values override these saved settings.</p>
    {error && <p role="alert" style={{ color: '#dc2626' }}>{error}</p>}
    {message && <p role="status" style={{ color: '#166534' }}>{message}</p>}
    <p>API token: {settings?.tokenMask ?? 'Not configured'} ({settings?.apiTokenSource ?? 'loading'})</p>
    {settings?.apiTokenSource === 'environment' && (
      <p style={{ fontSize: 13, color: '#6b7280' }}>
        Token is managed by the <code>BAYSTATE_CMS_API_TOKEN</code> environment variable.
        Generation is disabled here — unset it and restart to manage the token in this UI.
      </p>
    )}
    {generatedToken && <label style={{ display: 'block', marginBottom: 12 }}>New token — copy now
      <input aria-label="New API token" readOnly value={generatedToken} onFocus={(event) => event.currentTarget.select()} style={{ width: '100%', padding: 8, fontFamily: 'monospace' }} />
    </label>}
    <button type="button" disabled={busy || settings?.apiTokenSource === 'environment'} onClick={() => void generateToken()}>{settings?.tokenConfigured ? 'Rotate API token' : 'Generate API token'}</button>
    <div style={{ marginTop: 20 }}>
      <label><input type="checkbox" checked={settings?.releaseAdminEnabled ?? false} disabled={busy || !settings} onChange={(event) => void setAdmin(event.currentTarget.checked)} /> Enable taxonomy release administration</label>
      <p style={{ fontSize: 13, color: '#6b7280' }}>Effective setting source: {settings?.releaseAdminSource ?? 'loading'}.</p>
    </div>
  </section>;
}
