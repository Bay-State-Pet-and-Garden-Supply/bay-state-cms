import React, { useState, useEffect } from 'react';
import { listFieldRegistry, updateFieldRegistryEntry, getConnection, saveConnection, testConnection } from '../api';
import { ViewHeader } from './common/ViewHeader';
import { AiComputePanel } from './AiComputePanel';
import { CatalogFieldsView } from './catalog-workbench/CatalogFieldsView';
import { TypesAttributesView } from './catalog-workbench/TypesAttributesView';
import { MappingsView } from './catalog-workbench/MappingsView';
import { SchemaHealthView } from './catalog-workbench/SchemaHealthView';
import { SettingsTabShell, SettingsTabPanel, type SettingsTabDef } from './settings/SettingsTabShell';
import { SettingsClassificationTab } from './settings/SettingsClassificationTab';
import { TaxonomyReleaseCard } from './settings/TaxonomyReleaseCard';
import { ListingStandardsEditor } from './settings/ListingStandardsEditor';
import { colors } from '../theme';
import { ItemAcquisitionSettings } from './settings/ItemAcquisitionSettings';

/**
 * Store Settings (deep-linked via `?view=settings&tab=<id>`).
 *
 * P1 UI revamp: classification/taxonomy administration consolidated here as
 * top-level tabs (Catalog Fields / Types & Attributes / Mappings & Health /
 * AI Tasks) so managers operate releases without entering Onboarding.
 * Read-only release-derived views render inside SettingsClassificationTab
 * (FrozenBanner pattern); editable surfaces remain only those the server
 * permits today (LLM task configs, field-registry display labels, connection,
 * AI compute routing).
 */

type SettingsTab = 'general' | 'ai' | 'catalog' | 'types' | 'mappings-health' | 'taxonomy-release';

const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI Routes' },
  { id: 'catalog', label: 'Catalog Fields' },
  { id: 'types', label: 'Types & Attributes' },
  { id: 'mappings-health', label: 'Mappings & Health' },
  { id: 'taxonomy-release', label: 'Taxonomy Release' },
];

const VALID_TAB_IDS = new Set<string>(SETTINGS_TABS.map((t) => t.id));

function getInitialSettingsTab(): SettingsTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return VALID_TAB_IDS.has(tab ?? '') ? (tab as SettingsTab) : 'general';
}

interface SettingsProps {
  /** Opens a product overlay when reused workbench views reference SKUs. */
  onSelectProduct?: (sku: string) => void;
}

export function Settings({ onSelectProduct }: SettingsProps) {
  const [fieldRegistry, setFieldRegistry] = useState<any[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);
  const [savingFields, setSavingFields] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(getInitialSettingsTab);

  // Connection settings state
  const [cgiBaseUrl, setCgiBaseUrl] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [savingConn, setSavingConn] = useState(false);
  const [connResult, setConnResult] = useState('');
  const [connError, setConnError] = useState('');

  const [error, setError] = useState('');

  const loadFieldRegistry = async () => {
    setLoadingFields(true);
    try {
      const res = await listFieldRegistry();
      setFieldRegistry(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFields(false);
    }
  };

  const loadConnection = async () => {
    try {
      const res = await getConnection();
      if (res.connection) {
        setCgiBaseUrl(res.connection.cgiBaseUrl || '');
        setMerchantId(res.connection.merchantId || '');
        setPasswordConfigured(res.connection.passwordConfigured);
      }
    } catch (err) {
      console.error('Failed to load connection settings:', err);
    }
  };

  useEffect(() => {
    void loadFieldRegistry();
    void loadConnection();
  }, []);

  // App owns browser history for view navigation. Keep the local tab state in
  // sync when Back/Forward changes the URL while Settings stays mounted.
  useEffect(() => {
    const handlePopState = () => {
      const tab = new URLSearchParams(window.location.search).get('tab');
      setSettingsTab(VALID_TAB_IDS.has(tab ?? '') ? (tab as SettingsTab) : 'general');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleSettingsTabChange = (next: string) => {
    if (!VALID_TAB_IDS.has(next) || next === settingsTab) return;
    setSettingsTab(next as SettingsTab);
    // Keep the URL as the source of truth for the active tab so deep links
    // (`?view=settings&tab=ai`) stay live. replaceState avoids history spam.
    const url = new URL(window.location.href);
    if (next === 'general') {
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('tab', next);
    }
    window.history.replaceState(null, '', url.toString());
  };

  const handleSaveConnection = async () => {
    if (!cgiBaseUrl.trim() || !merchantId.trim()) {
      setConnError('CGI URL and merchant ID are required.');
      return;
    }
    setSavingConn(true);
    setConnError('');
    setConnResult('');
    try {
      await saveConnection(cgiBaseUrl.trim(), merchantId.trim(), password);
      const test = await testConnection();
      setConnResult(`Connection settings saved. ${test.message}`);
      setPasswordConfigured(true);
      setPassword('');
    } catch (err) {
      setConnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConn(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 1200, margin: '0 auto' },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, marginBottom: 12 },
    primaryBtn: { background: colors.uniformGreen, color: colors.feedBagCream, border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    table: { width: '100%', borderCollapse: 'collapse' as const, marginTop: 12, fontSize: 14 },
    th: { borderBottom: '2px solid #e5e7eb', textAlign: 'left' as const, padding: '8px 12px', color: '#4b5563', fontWeight: 600 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '8px 12px', verticalAlign: 'middle' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    success: { color: '#16a34a', padding: 12, background: '#f0fdf4', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    hint: { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
    empty: { fontSize: 14, color: '#9ca3af', fontStyle: 'italic' as const },
  };

  return (
    <div style={styles.container}>
      <ViewHeader
        title="Store Settings"
        description="Manage ShopSite CGI API connection, merchant credentials, global AI compute & provider routing, and catalog Field Registry definitions."
      />

      {/* Store Settings tab bar (accessible ARIA pattern via SettingsTabShell) */}
      <SettingsTabShell
        tabs={SETTINGS_TABS}
        active={settingsTab}
        onChange={handleSettingsTabChange}
        ariaLabel="Store Settings sections"
      />

      {error && <div style={styles.error}>{error}</div>}

      {/* Connection & Credentials Section (General) */}
      <SettingsTabPanel tabId="general" active={settingsTab}>
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>ShopSite Connection & Credentials</h2>
        <p style={styles.hint}>
          Configure your store's direct ShopSite CGI endpoint and credentials.
          Credentials can also be set via environment variables (<code>SHOPSITE_CGI_URL</code>, <code>SHOPSITE_MERCHANT_ID</code>, <code>SHOPSITE_PASSWORD</code>).
        </p>

        {connError && <div style={styles.error}>{connError}</div>}
        {connResult && <div style={styles.success}>{connResult}</div>}

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>ShopSite CGI Base URL</label>
        <input
          style={styles.input}
          placeholder="https://store.example.com/cgi-bin/bo/db_xml.cgi"
          value={cgiBaseUrl}
          onChange={(e) => setCgiBaseUrl(e.target.value)}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Merchant / User ID</label>
        <input
          style={styles.input}
          placeholder="Merchant ID"
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {passwordConfigured ? 'Password (configured - leave blank to keep existing)' : 'Password'}
        </label>
        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <button
            type="button"
            style={styles.primaryBtn}
            onClick={handleSaveConnection}
            disabled={savingConn}
          >
            {savingConn ? 'Testing Connection...' : 'Save & Test Connection'}
          </button>
        </div>
      </div>
      <ItemAcquisitionSettings />
      </SettingsTabPanel>

      {/* AI Routes Section — canonical global AI infrastructure surface */}
      <SettingsTabPanel tabId="ai" active={settingsTab}>
        <AiComputePanel onChange={() => setError('')} />
      </SettingsTabPanel>

      {/* Catalog Fields — live field registry view (reused workbench view)
          plus the editable display-labels editor (server-permitted surface) */}
      <SettingsTabPanel tabId="catalog" active={settingsTab}>
        <SettingsClassificationTab view="catalog-fields" showBanner={false}>
          <CatalogFieldsView onSelectProduct={onSelectProduct ?? (() => {})} />
          <div style={{ height: 24 }} />
          <div style={styles.section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Catalog Field Display Labels</h2>
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={async () => {
                  setSavingFields(true);
                  try {
                    for (const entry of fieldRegistry) {
                      await updateFieldRegistryEntry(entry.id, entry);
                    }
                    alert('Display labels saved successfully.');
                    void loadFieldRegistry();
                  } catch (err) {
                    alert('Failed to save display labels: ' + (err instanceof Error ? err.message : String(err)));
                  } finally {
                    setSavingFields(false);
                  }
                }}
                disabled={savingFields || loadingFields}
              >
                {savingFields ? 'Saving...' : 'Save Labels'}
              </button>
            </div>
            <p style={styles.hint}>
              Customize how ShopSite XML fields appear throughout the CMS editors. Labels, types, and groupings configured here
              affect the Product Detail editor, Catalog Health reports, and the Catalog Workbench.
              Product attribute mapping for the onboarding pipeline is configured in <strong>Onboarding Settings → Curation</strong>.
            </p>

            {loadingFields ? (
              <p aria-live="polite" style={styles.empty}>Loading field registry...</p>
            ) : fieldRegistry.length === 0 ? (
              <p aria-live="polite" style={styles.empty}>No fields discovered yet. Sync catalog products to populate.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, width: '15%' }}>XML Field</th>
                      <th style={{ ...styles.th, width: '25%' }}>Display Label</th>
                      <th style={{ ...styles.th, width: '15%' }}>Data Type</th>
                      <th style={{ ...styles.th, width: '10%' }}>Editable</th>
                      <th style={{ ...styles.th, width: '10%' }}>Required</th>
                      <th style={{ ...styles.th, width: '25%' }}>UI Group</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldRegistry.map((entry, idx) => (
                      <tr key={entry.id}>
                        <td style={styles.td}>
                          <strong>{entry.xmlField}</strong>
                          <div style={{ fontSize: 11, color: '#6b7280' }}>({entry.kind})</div>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.input}
                            type="text"
                            value={entry.label || ''}
                            onChange={(e) => {
                              const next = [...fieldRegistry];
                              next[idx] = { ...entry, label: e.target.value };
                              setFieldRegistry(next);
                            }}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.input}
                            value={entry.dataType}
                            onChange={(e) => {
                              const next = [...fieldRegistry];
                              next[idx] = { ...entry, dataType: e.target.value };
                              setFieldRegistry(next);
                            }}
                          >
                            {['string', 'number', 'boolean', 'html', 'image', 'list', 'raw_xml'].map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            type="checkbox"
                            checked={entry.editable}
                            onChange={(e) => {
                              const next = [...fieldRegistry];
                              next[idx] = { ...entry, editable: e.target.checked };
                              setFieldRegistry(next);
                            }}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="checkbox"
                            checked={entry.required}
                            disabled={!entry.editable}
                            onChange={(e) => {
                              const next = [...fieldRegistry];
                              next[idx] = { ...entry, required: e.target.checked };
                              setFieldRegistry(next);
                            }}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.input}
                            type="text"
                            value={entry.uiGroup || ''}
                            onChange={(e) => {
                              const next = [...fieldRegistry];
                              next[idx] = { ...entry, uiGroup: e.target.value || null };
                              setFieldRegistry(next);
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </SettingsClassificationTab>
      </SettingsTabPanel>

      {/* Types & Attributes — read-only release-derived view */}
      <SettingsTabPanel tabId="types" active={settingsTab}>
        <SettingsClassificationTab view="types-attributes" showBanner={false}>
          <TypesAttributesView />
          <ListingStandardsEditor />
        </SettingsClassificationTab>
      </SettingsTabPanel>

      {/* Mappings & Health — read-only release-derived views, stacked */}
      <SettingsTabPanel tabId="mappings-health" active={settingsTab}>
        <SettingsClassificationTab view="mappings-health" showBanner={false}>
          <MappingsView />
          <div style={{ height: 32 }} />
          <SchemaHealthView onSelectProduct={onSelectProduct ?? (() => {})} />
        </SettingsClassificationTab>
      </SettingsTabPanel>

      {/* Taxonomy Release — pin status, available immutable releases, and the
          sanctioned Activate action (server-gated; P4) */}
      <SettingsTabPanel tabId="taxonomy-release" active={settingsTab}>
        <TaxonomyReleaseCard />
      </SettingsTabPanel>
    </div>
  );
}
