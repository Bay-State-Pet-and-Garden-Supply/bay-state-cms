import React, { useState, useEffect } from 'react';
import {
  getCurationTargets,
  getClassificationReadiness,
  getOnboardingCapabilities,

  type CurationTargetsResponse,
} from '../onboarding-api';
import { downloadPagesImport, activatePagesImport } from '../api';
import { readinessViewFromReport } from '../classification-readiness-view';
import type { CurationTargetConfig } from '../../shared/schemas/classification';
import { AiRouteSummary } from './common/AiRouteSummary';
import { getExtractionWorkerHealth } from '../onboarding-api';
import type { WorkerHealthResponse } from '../../shared/schemas/extraction-worker';
import { ViewHeader } from './common/ViewHeader';
import { colors } from '../theme';
import { DistributorConnectionsPanel } from './onboarding-settings/DistributorConnectionsPanel';
import { SitemapHealthView } from './sitemap-health/SitemapHealthView';
import { BrandStrategyView } from './brand-strategy/BrandStrategyView';
import { primaryOnboardingSettingsTabs, resolveOnboardingSettingsTab } from './onboarding-settings/tabRegistry';
import type { OnboardingSettingsTabId } from './onboarding-settings/tabRegistry';
import { normalizeBrandHubDomain } from '../../onboarding/brand-hub/normalizeDomain';
import { getProfileWorkspacePath } from './profile-workspace/route';

type OnboardingSettingsTab = OnboardingSettingsTabId;

interface OnboardingSettingsProps {
  onBack: () => void;
  /** Initial tab to open (deep-linked, e.g. `?view=onboarding&settingsTab=curation`). */
  initialTab?: OnboardingSettingsTab;
}

export function OnboardingSettings({ onBack, initialTab }: OnboardingSettingsProps) {
  const [_loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Manager-selected curation classification targets.
  const [curationTargetState, setCurationTargetState] = useState<CurationTargetsResponse | null>(null);
  const [curationTargetsDraft, setCurationTargetsDraft] = useState<CurationTargetConfig[]>([]);
  const [curationTargetsLoading, setCurationTargetsLoading] = useState(false);
  // Classification readiness for the curation targets section.
  const [readinessView, setReadinessView] = useState<ReturnType<typeof readinessViewFromReport> | null>(null);

  // Lens & Curation Applicability UI states (PR5 C3-C7)
  const [curationViewMode, setCurationViewMode] = useState<'global' | 'by_product_type'>('global');
  const [selectedProductTypeId, setSelectedProductTypeId] = useState<string>('');
  const [showNonApplicable, setShowNonApplicable] = useState<boolean>(false);
  const [expandedAppliesToField, setExpandedAppliesToField] = useState<string | null>(null);
  const [inspectedCatalogField, setInspectedCatalogField] = useState<string | null>(null);

  // Worker health & profile builder overlay state
  const [_workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(null);

  const navigateToProfileWorkspace = (domain: string) => {
    const normalized = normalizeBrandHubDomain(domain);
    if (!normalized) return;
    const path = getProfileWorkspacePath(normalized, window.location.pathname + window.location.search);
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
    setWorkspaceDomain(null);
  };

  const [localDomain, setLocalDomain] = useState('');
  const [settingsTab, setSettingsTab] = useState<OnboardingSettingsTab>(resolveOnboardingSettingsTab(initialTab));
  const [sourcingEngineEnabled, setSourcingEngineEnabled] = useState(false);
  // B4 — Brands stays mounted while hidden; bump the signal so it refetches
  // server facts when the operator returns from Distributors/Profiles.
  const [brandsRefreshSignal, setBrandsRefreshSignal] = useState(0);

  useEffect(() => {
    if (settingsTab === 'brands') setBrandsRefreshSignal((n) => n + 1);
  }, [settingsTab]);

  useEffect(() => {
    getOnboardingCapabilities()
      .then((caps) => setSourcingEngineEnabled(caps.sourcing.engineEnabled))
      .catch(() => setSourcingEngineEnabled(false));
  }, []);

  // ─── Data loading ───────────────────────────────────────────────────────

  const loadCurationTargets = async () => {
    setCurationTargetsLoading(true);
    try {
      const res = await getCurationTargets();
      setCurationTargetState(res);
      setCurationTargetsDraft(res.targets);
      if (res.candidates.productTypes.length > 0 && !selectedProductTypeId) {
        setSelectedProductTypeId(res.candidates.productTypes[0].value);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCurationTargetsLoading(false);
    }
    try {
      const readiness = await getClassificationReadiness();
      setReadinessView(readinessViewFromReport(readiness.readiness));
    } catch {
      setReadinessView(readinessViewFromReport(null));
    }
  };

  const targetForField = (catalogField: string) =>
    curationTargetsDraft.find(t => t.kind === 'product_field' && t.catalogField === catalogField);

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      void loadCurationTargets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Fetch extraction worker health on mount
  useEffect(() => {
    getExtractionWorkerHealth().then(setWorkerHealth).catch(() => setWorkerHealth(null));
  }, []);

  // ─── Handlers ──────────────────────────────────────────────────────────

  const [syncingPages, setSyncingPages] = useState(false);

  const handleSyncPages = async () => {
    if (!confirm('Download the live Pages database from ShopSite and activate it as the verified page import?')) return;
    setSyncingPages(true);
    setError('');
    try {
      const res = await downloadPagesImport();
      const preview = res.preview;
      await activatePagesImport({
        sourceHash: preview.sourceHash,
        parserFormatVersion: preview.parserFormatVersion,
        records: preview.records,
      });
      const warningNote = preview.warnings.length > 0 ? ` · ${preview.warnings.length} name-only excluded` : '';
      alert(`Pages synced! ${preview.counts.verified} verified pages activated from ShopSite${warningNote}.`);
      await loadCurationTargets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingPages(false);
    }
  };

  // ─── Shared styles ──────────────────────────────────────────────────────

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 24, fontWeight: 600, margin: 0 },
    backBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 14 },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24 },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    subsection: { border: '1px solid #e5e7eb', borderRadius: 6, padding: 16, marginBottom: 12 },
    subsectionHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
    providerBadge: {
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 3,
      textTransform: 'uppercase' as const,
    },
    formGroup: { marginBottom: 12 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#4b5563', marginBottom: 6 },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, background: '#fff' },
    inputRow: { display: 'flex', gap: 8 },
    buttonRow: { display: 'flex', gap: 12, marginTop: 12 },
    primaryBtn: { background: colors.uniformGreen, color: colors.feedBagCream, border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    secondaryBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 },
    deleteBtn: { background: 'none', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse' as const, marginTop: 12, fontSize: 14 },
    th: { borderBottom: '2px solid #e5e7eb', textAlign: 'left' as const, padding: '8px 12px', color: '#4b5563', fontWeight: 600 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '8px 12px' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    hint: { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
    savedHint: { fontSize: 12, color: '#16a34a', margin: '4px 0 0' },
    checkboxLabel: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#4b5563' },
    empty: { fontSize: 14, color: '#9ca3af', fontStyle: 'italic' as const },
  };


  return (
    <div style={styles.container}>
      <ViewHeader
        title="Onboarding Pipeline Settings"
        description="Configure curation targets, brand sourcing strategies, sitemaps, and distributors."
        actions={<button style={styles.backBtn} onClick={onBack}>← Back to Batches</button>}
      />

      {error && <div style={styles.error}>{error}</div>}

      <AiRouteSummary />

      {/* P1 UI revamp: cross-link to the top-level taxonomy administration
          surface (Store Settings → Types & Attributes / Mappings & Health). */}
      <p style={{ fontSize: 13, margin: '0 0 12px' }}>
        <a href="/?view=settings&tab=types" style={{ color: '#14532D', fontWeight: 600 }}>
          Manage types, mappings & releases →
        </a>
      </p>

      {/* ─── Tab Bar — single source via tabRegistry (e35s10) — legacy profiles|sitemaps retired to brands alias ─── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #dee2e6' }}>
        {primaryOnboardingSettingsTabs().map(tab => (
          <button
            key={tab.id}
            onClick={() => setSettingsTab(tab.id as any)}
            style={{
              padding: '10px 20px',
              border: 'none',
              background: settingsTab === tab.id ? '#fff' : 'transparent',
              borderBottom: settingsTab === tab.id ? '2px solid #007bff' : '2px solid transparent',
              fontWeight: settingsTab === tab.id ? 600 : 400,
              cursor: 'pointer',
              fontSize: 14,
              color: settingsTab === tab.id ? '#007bff' : '#495057',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ display: settingsTab === 'curation' ? 'block' : 'none' }}>
      <div style={{ marginBottom: 16, padding: 12, background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8, fontSize: 13, color: '#713f12', lineHeight: 1.4 }}>
        🔒 Taxonomy frozen — Taxonomy definitions, attribute profiles, curation targets, mappings, and seed sync are read-only. Changes require a new immutable taxonomy release.
      </div>
      {/* ─── CURATION TARGETS ─── */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
            {curationViewMode === 'global' ? 'Global Curation Targets' : 'Curation by Product Type'}
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={styles.secondaryBtn} onClick={loadCurationTargets} disabled={curationTargetsLoading}>
              {curationTargetsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* View Lens Navigation */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid #e5e7eb', paddingBottom: 10 }}>
          <button
            type="button"
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: curationViewMode === 'global' ? '#2563eb' : '#f3f4f6',
              color: curationViewMode === 'global' ? '#fff' : '#4b5563',
            }}
            onClick={() => setCurationViewMode('global')}
          >
            Global Targets
          </button>
          <button
            type="button"
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: curationViewMode === 'by_product_type' ? '#2563eb' : '#f3f4f6',
              color: curationViewMode === 'by_product_type' ? '#fff' : '#4b5563',
            }}
            onClick={() => {
              setCurationViewMode('by_product_type');
              if (curationTargetState?.candidates.productTypes.length && !selectedProductTypeId) {
                setSelectedProductTypeId(curationTargetState.candidates.productTypes[0].value);
              }
            }}
          >
            By Product Type
          </button>
        </div>

        <p style={styles.hint}>
          {curationViewMode === 'global'
            ? 'Review the outputs Curation is allowed to populate. Product-field targets are further restricted by the current Product Type\'s Attribute Profile.'
            : 'Review the effective curation attributes for each Product Type. Profile entries define per-type applicability, cardinality, and required state.'}
        </p>

        {curationViewMode === 'global' && (
          <div style={{ marginBottom: 14, padding: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 13 }}>
            <div style={{ color: '#1e40af', fontWeight: 600, marginBottom: 2 }}>
              ℹ️ Managing Curation in v2 Workspaces
            </div>
            <div style={{ color: '#1e3a8a', lineHeight: 1.4 }}>
              In v2 classification workspaces, field targets and attribute requirements are managed per Product Type via the{' '}
              <button
                type="button"
                onClick={() => {
                  setCurationViewMode('by_product_type');
                  if (curationTargetState?.candidates.productTypes.length && !selectedProductTypeId) {
                    setSelectedProductTypeId(curationTargetState.candidates.productTypes[0].value);
                  }
                }}
                style={{ background: 'none', border: 'none', color: '#2563eb', textDecoration: 'underline', cursor: 'pointer', fontWeight: 600, padding: 0 }}
              >
                By Product Type
              </button>{' '}
              tab, or globally via field mappings in Catalog Workbench.
            </div>
          </div>
        )}

        {/* Configuration Health Findings (C5) */}
        {curationTargetState?.findings && curationTargetState.findings.length > 0 && (
          <div style={{ marginBottom: 14, padding: 12, background: '#fffbe8', border: '1px solid #fde047', borderRadius: 8, fontSize: 13 }}>
            <div style={{ color: '#854d0e', fontWeight: 600, marginBottom: 4 }}>
              ⚠ Configuration Health Findings ({curationTargetState.findings.length})
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: '#713f12' }}>
              {curationTargetState.findings.map((f, idx) => (
                <li key={idx} style={{ marginBottom: 2 }}>
                  <code style={{ fontSize: 11, background: '#fef08a', padding: '1px 4px', borderRadius: 4 }}>{f.code}</code> {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {readinessView && !readinessView.isReady && (
          <div style={{ marginBottom: 12, padding: 12, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, fontSize: 13 }}>
            <div style={{ color: '#9a3412', fontWeight: 600 }}>⚠ Classification is not ready</div>
            {readinessView.capabilities.page.reason && (
              <div style={{ color: '#7c2d12', marginTop: 2 }}>Category Pages: {readinessView.capabilities.page.reason}</div>
            )}
            <div style={{ color: '#7c2d12', marginTop: 2 }}>{readinessView.summary.join(' ')}</div>
          </div>
        )}

        {!curationTargetState ? (
          <p style={styles.empty}>{curationTargetsLoading ? 'Loading curation targets…' : 'No curation target data loaded yet.'}</p>
        ) : curationViewMode === 'global' ? (
          /* GLOBAL TARGETS LENS */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#7c3aed', color: '#fff' }}>Pages</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.pages.length} synced pages</span>
                <button
                  type="button"
                  disabled={syncingPages}
                  onClick={handleSyncPages}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    border: '1px solid #d1d5db',
                    background: '#f9fafb',
                    color: '#374151',
                    cursor: syncingPages ? 'not-allowed' : 'pointer',
                    opacity: syncingPages ? 0.6 : 1,
                  }}
                >
                  {syncingPages ? 'Syncing…' : 'Sync pages from ShopSite'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>Always enabled · Multi-select</span>
              </div>
            </div>
            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#2563eb', color: '#fff' }}>Product Fields</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.productFields.length} custom fields from field registry</span>
              </div>
              {curationTargetState.candidates.productFields.length === 0 ? (
                <p style={styles.empty}>No ProductField entries are available yet. Sync products from ShopSite first.</p>
              ) : (
                <>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Curate</th>
                        <th style={styles.th}>Field</th>
                        <th style={styles.th}>Attribute</th>
                        <th style={styles.th}>Input type</th>
                        <th style={styles.th}>Applies to</th>
                        <th style={styles.th}>Configuration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {curationTargetState.candidates.productFields
                        .filter(field => field.catalogField !== 'ProductField16')
                        .map(field => {
                          const target = targetForField(field.catalogField);
                          const checked = !!target?.enabled;
                          const appl = curationTargetState.applicability?.find(a => a.catalogField === field.catalogField);
                          const isInspected = inspectedCatalogField === field.catalogField;

                          return (
                            <React.Fragment key={field.catalogField}>
                              <tr>
                                <td style={styles.td}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled
                                    title="Taxonomy frozen — read-only"
                                  />
                                </td>
                                <td style={styles.td}>
                                  <strong>{field.label}</strong>
                                  <div style={{ fontSize: 11, color: '#6b7280' }}>{field.catalogField}</div>
                                </td>
                                <td style={styles.td}>
                                  {appl?.attributeName ? (
                                    <button
                                      type="button"
                                      onClick={() => setInspectedCatalogField(isInspected ? null : field.catalogField)}
                                      style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
                                    >
                                      <span style={{ fontWeight: 600, fontSize: 12, color: '#2563eb', textDecoration: 'underline' }}>
                                        {appl.attributeName}
                                      </span>
                                      <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>{appl.attributeId}</div>
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Unmapped</span>
                                  )}
                                </td>
                                <td style={styles.td}>
                                  {appl?.valueMode === 'controlled' ? (
                                    <span style={{ background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                      Select
                                    </span>
                                  ) : appl?.valueMode === 'measured' ? (
                                    <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                      Measurement
                                    </span>
                                  ) : appl?.valueMode === 'freeText' ? (
                                    <span style={{ background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                      Free text
                                    </span>
                                  ) : (
                                    <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>—</span>
                                  )}
                                </td>
                                <td style={styles.td}>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                                    {appl?.scope === 'universal' ? (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                          Universal
                                        </span>
                                      </div>
                                    ) : appl?.scope === 'profiled' ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <button
                                            type="button"
                                            onClick={() => setExpandedAppliesToField(expandedAppliesToField === field.catalogField ? null : field.catalogField)}
                                            style={{ background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                                          >
                                            {appl.productTypes.length} product {appl.productTypes.length === 1 ? 'type' : 'types'} {expandedAppliesToField === field.catalogField ? '▲' : '▼'}
                                          </button>
                                        </div>
                                        {expandedAppliesToField === field.catalogField && (
                                          <div style={{ marginTop: 4, padding: 6, background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                            {appl.productTypes.map(pt => (
                                              <div key={pt.productTypeId} style={{ color: '#334155' }}>
                                                • <strong>{pt.productTypeName}</strong> {pt.required ? '(required)' : ''} {pt.conditional ? '[conditional]' : ''}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    ) : appl?.scope === 'unused' ? (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, border: '1px solid #fde68a' }}>
                                          ⚠ Not used by any Product Type
                                        </span>
                                      </div>
                                    ) : (
                                      <span style={{ fontSize: 11, color: '#9ca3af' }}>Unmapped</span>
                                    )}
                                  </div>
                                </td>
                                <td style={styles.td}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    <span style={{ fontSize: 12, color: '#374151' }}>
                                      {appl?.valueMode === 'controlled'
                                        ? `${appl.allowedValuesCount} allowed values`
                                        : appl?.valueMode === 'measured'
                                        ? `Unit: ${appl.canonicalUnit ?? 'lb'}`
                                        : '—'}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setInspectedCatalogField(isInspected ? null : field.catalogField)}
                                      style={{ background: isInspected ? '#3b82f6' : '#f1f5f9', color: isInspected ? '#fff' : '#475569', border: '1px solid #cbd5e1', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
                                    >
                                      {isInspected ? 'Close ✕' : 'Inspect 🔍'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {isInspected && (
                                <tr>
                                  <td colSpan={6} style={{ background: '#f8fafc', padding: 12, borderBottom: '2px solid #e2e8f0' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                                      <div style={{ fontWeight: 600, color: '#1e293b', borderBottom: '1px solid #cbd5e1', paddingBottom: 4 }}>
                                        Attribute Inspector: {appl?.attributeName ?? field.label} ({field.catalogField})
                                      </div>
                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Input Type:</span>{' '}
                                          <strong>{appl?.valueMode ? (appl.valueMode === 'controlled' ? 'Select (Controlled)' : appl.valueMode === 'measured' ? 'Measurement' : 'Free text') : 'Unknown'}</strong>
                                        </div>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Canonical Unit:</span>{' '}
                                          <strong>{appl?.canonicalUnit ?? '—'}</strong>
                                        </div>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Default Cardinality:</span>{' '}
                                          <strong>{target?.selectionMode ?? 'single'}</strong>
                                        </div>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Catalog Field:</span>{' '}
                                          <code>{field.catalogField}</code>
                                        </div>
                                      </div>
                                      <div style={{ marginTop: 4, padding: 8, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6 }}>
                                        <div style={{ fontWeight: 600, fontSize: 11, color: '#475569', marginBottom: 2 }}>
                                          Historical Catalog Values (Diagnostic Reference Only)
                                        </div>
                                        <div style={{ fontSize: 11, color: '#334155' }}>
                                          {appl?.historicalValues && appl.historicalValues.length > 0
                                            ? appl.historicalValues.join(', ')
                                            : 'No historical values found in synced catalog.'}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', marginTop: 4 }}>
                                          Note: Historical values are displayed for diagnostic catalog analysis only and are not selectable options.
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 0', fontStyle: 'italic' }}>
                    Note: Product Type profile cardinality overrides default selection when defined.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          /* BY PRODUCT TYPE LENS (C4 & C7) */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Product Type:</label>
                <select
                  style={{ ...styles.select, minWidth: 200 }}
                  value={selectedProductTypeId}
                  onChange={(e) => setSelectedProductTypeId(e.target.value)}
                >
                  {curationTargetState.candidates.productTypes.map(pt => (
                    <option key={pt.value} value={pt.value}>
                      {pt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showNonApplicable}
                    onChange={(e) => setShowNonApplicable(e.target.checked)}
                  />
                  Show non-applicable attributes
                </label>
              </div>
            </div>

            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#059669', color: '#fff' }}>Effective Curation Fields</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {curationTargetState.candidates.productTypes.find(pt => pt.value === selectedProductTypeId)?.label}
                </span>
              </div>

              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Attribute</th>
                    <th style={styles.th}>Catalog Destination</th>
                    <th style={styles.th}>Required</th>
                    <th style={styles.th}>Cardinality</th>
                    <th style={styles.th}>Conditions</th>
                    <th style={styles.th}>Global Target Status</th>
                  </tr>
                </thead>
                <tbody>
                  {curationTargetState.applicability
                    .filter(item => {
                      if (!item.attributeId) return false;
                      const isUniversal = item.scope === 'universal';
                      const profileMatch = item.productTypes.find(pt => pt.productTypeId === selectedProductTypeId);
                      const isApplicable = isUniversal || !!profileMatch;
                      return isApplicable || showNonApplicable;
                    })
                    .map(item => {
                      const isUniversal = item.scope === 'universal';
                      const profileMatch = item.productTypes.find(pt => pt.productTypeId === selectedProductTypeId);
                      const isApplicable = isUniversal || !!profileMatch;
                      const target = targetForField(item.catalogField);
                      const targetEnabled = !!target?.enabled;

                      return (
                        <tr key={item.catalogField} style={{ opacity: !isApplicable ? 0.6 : 1 }}>

                          <td style={styles.td}>
                            <strong>{item.attributeName}</strong>
                            <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{item.attributeId}</div>
                          </td>

                          <td style={styles.td}>
                            <code>{item.catalogField}</code>
                          </td>

                          <td style={styles.td}>
                            <span style={{ fontSize: 12, color: profileMatch?.required ? '#dc2626' : '#6b7280', fontWeight: profileMatch?.required ? 600 : 400 }}>
                              {isApplicable ? (profileMatch?.required ? 'Required' : 'Optional') : '—'}
                            </span>
                          </td>

                          <td style={styles.td}>
                            <span style={{ fontSize: 12, color: '#374151' }}>
                              {isApplicable ? (profileMatch?.cardinality ?? 'single') : '—'}
                            </span>
                          </td>

                          <td style={styles.td}>
                            {isUniversal ? (
                              <span style={{ fontSize: 11, background: '#dcfce7', color: '#166534', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
                                Universal
                              </span>
                            ) : profileMatch?.conditional ? (
                              <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
                                Conditional
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: '#9ca3af' }}>None</span>
                            )}
                          </td>

                          <td style={styles.td}>
                            {targetEnabled ? (
                              <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Enabled</span>
                            ) : (
                              <span style={{ fontSize: 12, color: '#dc2626' }}>✕ Disabled</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      </div>

      <div style={{ display: settingsTab === 'sitemaps' ? 'block' : 'none' }}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px', color: '#111827' }}>
            Sitemaps & Brand URL Index
          </h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Persistent domain sitemap inventory, freshness monitoring, and local retrieval ladder for zero-cost discovery.
          </p>
        </div>
        <SitemapHealthView />
      </div>

      <div style={{ display: settingsTab === 'brands' ? 'block' : 'none' }}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px', color: '#111827' }}>
            Brands & Sourcing Strategy Hub
          </h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Unified brand strategy — sourcing tier, official domain & sitemap health, and governed extractor readiness. Distributor-only brands surface as profile bypass eligible. Saving a strategy approves it immediately as the next revision; active collection attempts keep their current revision.
          </p>
        </div>
        <BrandStrategyView refreshSignal={brandsRefreshSignal} />
      </div>

      <div style={{ display: settingsTab === 'distributors' ? 'block' : 'none' }}>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px', color: '#111827' }}>
          Distributors
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
          Connection infrastructure for Sourcing (ADR 0014) — brand routing moved to{' '}
          <strong>Settings → Brands</strong>.
        </p>
        <DistributorConnectionsPanel engineEnabled={sourcingEngineEnabled} />
      </div>
      </div>

      <div style={{ display: settingsTab === 'profiles' ? 'block' : 'none' }}>
      {/* ── Profile Builder Landing ── */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px', color: '#111827' }}>
          Profile Builder
        </h2>
        <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 }}>
          Build a domain extractor profile by entering a product URL and assigning CSS selectors.
          The profile defines how product data is extracted from a specific e-commerce domain.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={localDomain}
            onChange={(e) => setLocalDomain(e.target.value)}
            placeholder="Enter domain (e.g. acmepet.com)"
            style={{
              flex: 1,
              maxWidth: 400,
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: 14,
              fontFamily: 'monospace',
            }}
          />
          <button
            type="button"
            onClick={() => navigateToProfileWorkspace(localDomain)}
            disabled={!localDomain.trim()}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: localDomain.trim() ? 'pointer' : 'not-allowed',
              opacity: localDomain.trim() ? 1 : 0.6,
            }}
          >
            Open Profile Builder
          </button>
        </div>
      </div>
      </div>

      {/* ── Profile Workspace link (e06s01) — dedicated page replaces inline builder ── */}
      {workspaceDomain && (
        <div style={{ marginBottom: 24, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 20 }}>
          <a
            href={getProfileWorkspacePath(workspaceDomain, window.location.pathname + window.location.search)}
            onClick={(e) => {
              e.preventDefault();
              navigateToProfileWorkspace(workspaceDomain);
            }}
            style={{ color: '#2563eb', fontWeight: 600 }}
          >
            Open {workspaceDomain} profile workspace →
          </a>
          <button type="button" style={styles.secondaryBtn} onClick={() => setWorkspaceDomain(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
