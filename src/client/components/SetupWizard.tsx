import React, { useState, useEffect } from 'react';
import { bootstrapFromXml, bootstrapFromFile, bootstrapFromPull, getBootstrapStatus, getConnection, saveConnection, testConnection } from '../api';

interface Props {
  onComplete: () => void;
  onUpdated?: () => void;
}

export function SetupWizard({ onComplete, onUpdated: _onUpdated }: Props) {
  const [step, setStep] = useState(0);
  const [xmlInput, setXmlInput] = useState('');
  const [filePath, setFilePath] = useState('');
  const [cgiBaseUrl, setCgiBaseUrl] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [polling, setPolling] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);

  useEffect(() => {
    const loadConnectionSettings = async () => {
      try {
        const res = await getConnection();
        if (res.connection) {
          setCgiBaseUrl(res.connection.cgiBaseUrl || '');
          setMerchantId(res.connection.merchantId || '');
          setPasswordConfigured(res.connection.passwordConfigured);
        }
      } catch (err) {
        console.error('Failed to load saved connection settings:', err);
      }
    };
    void loadConnectionSettings();
  }, []);

  const startPollingStatus = (successPrefix: string) => {
    setPolling(true);
    setLoading(true);
    setStatusMessage('Initializing catalog import in the background...');
    
    const interval = setInterval(async () => {
      try {
        const res = await getBootstrapStatus();
        if (res.bootstrapStatus === 'complete') {
          clearInterval(interval);
          setPolling(false);
          setLoading(false);
          setResult(`${successPrefix} Baseline commit: ${res.baselineCommit || 'N/A'}`);
          setStep(1);
        } else if (res.bootstrapStatus === 'failed') {
          clearInterval(interval);
          setPolling(false);
          setLoading(false);
          setError(res.error || 'Bootstrap failed in the background. Check server logs.');
        } else if (res.bootstrapStatus === 'running') {
          setStatusMessage('Importing products from ShopSite, parsing XML, and writing Git catalog files...');
        }
      } catch (err) {
        clearInterval(interval);
        setPolling(false);
        setLoading(false);
        setError(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);
  };

  const handleSaveConnection = async () => {
    if (!cgiBaseUrl.trim() || !merchantId.trim() || (!password && !passwordConfigured)) {
      setError('CGI URL, merchant/user ID, and password are required to enable direct sync. You can skip this and use XML import/export fallback.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await saveConnection(cgiBaseUrl.trim(), merchantId.trim(), password);
      const test = await testConnection();
      setResult(`Connection saved. ${test.message}`);
      setPasswordConfigured(true);
      setPassword(''); // Clear password field after save
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBootstrapFromPull = async () => {
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromPull();
      startPollingStatus('Bootstrap complete! Products successfully imported from ShopSite.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleBootstrapXml = async () => {
    if (!xmlInput.trim()) {
      setError('XML content is required');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromXml(xmlInput.trim());
      startPollingStatus('Bootstrap complete! Products successfully imported from pasted XML.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleFileBootstrap = async () => {
    if (!filePath.trim()) {
      setError('File path is required');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromFile(filePath.trim());
      startPollingStatus('Bootstrap complete! Products successfully imported from XML file.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { maxWidth: 600, margin: '0 auto', padding: 24 },
    input: { width: '100%', padding: 8, margin: '8px 0', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 },
    textarea: { width: '100%', height: 150, padding: 8, margin: '8px 0', fontSize: 13, border: '1px solid #ccc', borderRadius: 4, fontFamily: 'monospace' },
    button: { padding: '10px 20px', fontSize: 14, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, margin: '4px' },
    secondary: { padding: '10px 20px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4, margin: '4px' },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 8 },
    error: { color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0' },
    result: { color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0', whiteSpace: 'pre-wrap' as any },
    section: { marginTop: 16, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 },
    heading: { fontSize: 18, fontWeight: 500, marginBottom: 8 },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Bay State Store Catalog Setup</h1>

      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}
      {polling && (
        <div style={{ color: '#2563eb', padding: '12px', background: '#eff6ff', borderRadius: 4, margin: '8px 0', fontWeight: 500 }}>
          ⏳ {statusMessage}
        </div>
      )}

      {step === 0 && (
        <div>
          <p>Initial setup for store catalog. Configure direct sync if available, or import products from XML/export fallback.</p>

          <div style={styles.section}>
            <h2 style={styles.heading}>Optional Direct Sync Connection</h2>
            <p style={{ fontSize: 13, color: '#4b5563' }}>
              Basic auth works for some ShopSite environments, but authentication is store-specific. If this fails, you can still use XML import/export fallback.
            </p>
            <input
              style={styles.input}
              placeholder="ShopSite CGI URL or script path (e.g., https://store.example.com/cgi-bin/bo/db_xml.cgi)"
              value={cgiBaseUrl}
              onChange={e => setCgiBaseUrl(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Merchant/user ID"
              value={merchantId}
              onChange={e => setMerchantId(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder={passwordConfigured ? "Password (configured - leave blank to keep, or enter new one)" : "Password"}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleSaveConnection} disabled={loading}>
              {loading ? 'Testing...' : 'Save & Test Connection'}
            </button>
            <button style={styles.button} onClick={handleBootstrapFromPull} disabled={loading}>
              {loading ? 'Bootstrapping...' : 'Bootstrap Catalog from ShopSite'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Paste ShopSite XML</h2>
            <textarea
              style={styles.textarea}
              placeholder="Paste your ShopSite products XML here..."
              value={xmlInput}
              onChange={e => setXmlInput(e.target.value)}
            />
            <button style={styles.button} onClick={handleBootstrapXml} disabled={loading}>
              {loading ? 'Importing...' : 'Import from XML'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Load from XML File</h2>
            <input
              style={styles.input}
              placeholder="Path to XML file on disk"
              value={filePath}
              onChange={e => setFilePath(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleFileBootstrap} disabled={loading}>
              {loading ? 'Loading...' : 'Load from File'}
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <p>Bootstrap complete! You can now manage products.</p>
          <button style={styles.button} onClick={onComplete}>
            Open Catalog
          </button>
        </div>
      )}
    </div>
  );
}
