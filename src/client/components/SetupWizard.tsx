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
    setStatusMessage('Getting your catalog ready...');
    
    const interval = setInterval(async () => {
      try {
        const res = await getBootstrapStatus();
        if (res.bootstrapStatus === 'complete') {
          clearInterval(interval);
          setPolling(false);
          setLoading(false);
          setResult(successPrefix);
          setStep(1);
        } else if (res.bootstrapStatus === 'failed') {
          clearInterval(interval);
          setPolling(false);
          setLoading(false);
          setError(res.error || "We couldn't finish importing products. Please try again or contact support.");
        } else if (res.bootstrapStatus === 'running') {
          setStatusMessage('Importing products from your store. This may take a few minutes...');
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
      setError('Store connection address, account ID, and password are required to connect. You can skip this and import a catalog export instead.');
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
      startPollingStatus('Your products are ready to review.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleBootstrapXml = async () => {
    if (!xmlInput.trim()) {
      setError('Paste the catalog export first.');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromXml(xmlInput.trim());
      startPollingStatus('Your products are ready to review.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleFileBootstrap = async () => {
    if (!filePath.trim()) {
      setError('Enter where the catalog file is saved.');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromFile(filePath.trim());
      startPollingStatus('Your products are ready to review.');
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
          <p>Set up your store catalog. Connect to your store or import a catalog export.</p>

          <div style={styles.section}>
            <h2 style={styles.heading}>Connect to your store (optional)</h2>
            <p style={{ fontSize: 13, color: '#4b5563' }}>
              Store connection details differ by store. If this connection does not work, import a catalog export instead.
            </p>
            <input
              style={styles.input}
              placeholder="Store connection address (ask your ShopSite administrator)"
              value={cgiBaseUrl}
              onChange={e => setCgiBaseUrl(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Store account ID"
              value={merchantId}
              onChange={e => setMerchantId(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder={passwordConfigured ? "Password (already saved — leave blank to keep it)" : "Password"}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleSaveConnection} disabled={loading}>
              {loading ? 'Testing...' : 'Save and test connection'}
            </button>
            <button style={styles.button} onClick={handleBootstrapFromPull} disabled={loading}>
              {loading ? 'Importing...' : 'Import products from my store'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Paste a catalog export</h2>
            <textarea
              style={styles.textarea}
              placeholder="Paste your store's catalog export here..."
              value={xmlInput}
              onChange={e => setXmlInput(e.target.value)}
            />
            <button style={styles.button} onClick={handleBootstrapXml} disabled={loading}>
              {loading ? 'Importing...' : 'Import catalog export'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Import a catalog file</h2>
            <input
              style={styles.input}
              placeholder="Path to the catalog file"
              value={filePath}
              onChange={e => setFilePath(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleFileBootstrap} disabled={loading}>
              {loading ? 'Importing...' : 'Import from file'}
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <p>Store setup is complete. You can now review your products.</p>
          <button style={styles.button} onClick={onComplete}>
            Open Catalog
          </button>
        </div>
      )}
    </div>
  );
}
