/**
 * AiComputePanel.tsx — AI Compute & Provider Connections Settings.
 *
 * Provides a unified settings interface for:
 * 1. Provider Connections (Desktop LM Studio on LAN, OpenAI Cloud, Local Ollama).
 * 2. Privacy & Data Sharing Policies (This Device, Trusted LAN, Cloud).
 * 3. Workload Routing with Catalog Default inheritance and per-workload fallbacks.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  getAiConfig,
  upsertAiConnection,
  deleteAiConnection,
  probeAiConnection,
  testEphemeralAiConnection,
  saveAiDefaults,
  upsertAiWorkloadRoute,
} from '../onboarding-api';
import type {
  ProviderConnection,
  AiRoutingConfig,
  WorkloadRoute,
  ModelTarget,
  AiTrustZone,
  DataSharingPolicy,
} from '../../ai/provider-connections';
import type { ConnectionHealthReport, DiscoveredModel } from '../../ai/connection-health-monitor';
import { TYPESAFE_KNOWN_MODELS } from '../../ai/systemone-transport';
import { DEFAULT_LOCAL_VISION_MODEL } from '../../shared/vision-model-defaults';
import { colors, fonts, rounded } from '../theme';
import { ClassificationProviderSettings } from './settings/ClassificationProviderSettings';

/**
 * Versioned TypeSafe pins that stay selectable on System One routes even when
 * discovery lists aliases only. Shared with the transport's known-pin list so
 * the panel never drifts from pin semantics (aliases are discovered models,
 * never known pins).
 */
const TYPESAFE_PINNED_MODELS: readonly string[] = TYPESAFE_KNOWN_MODELS;

/** Derive the operator-approved host/port pin from a base URL, mirroring the
 *  server-side derivation in validateConnectionTrustZone (default port per
 *  protocol, hostname lowercased). Returns {} when the URL does not parse. */
function pinFromUrl(baseUrl: string): { host?: string; port?: number } {
  try {
    const url = new URL(baseUrl);
    return {
      host: url.hostname.toLowerCase(),
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
    };
  } catch {
    return {};
  }
}

/** Sensible per-connection default model used when the UI dropdowns reset a
 *  route's model on connection change. Prefers the first live-discovered
 *  model, falling back to a curated default per provider (never a generic
 *  model name that the provider does not serve). */
function defaultModelForConnection(connId: string, healthMap: Record<string, ConnectionHealthReport>): string {
  const discovered = healthMap[connId]?.models?.[0]?.id;
  if (discovered) return discovered;
  const curated: Record<string, string> = {
    'deepseek-cloud': 'deepseek-v4-flash',
    'openai-cloud': 'gpt-4o-mini',
    'typesafe-jev': 'jev-1.13.0',
    'local-ollama': DEFAULT_LOCAL_VISION_MODEL,
  };
  return curated[connId] ?? '';
}

/**
 * Model selector for a route target. Shows a dropdown of the connection's
 * probe-discovered models when available (with a "Custom…" escape hatch for
 * arbitrary model IDs), and falls back to a plain text field when the
 * connection has never been probed or is offline so configuration still works.
 *
 * Pinned-model semantics (TypeSafe contract): discovery may list aliases
 * only (e.g. jev-latest), while the operator pins a versioned ID
 * (jev-1.13.0). The pinned value always stays selectable — offered as an
 * explicit "Pinned: …" option — and is never silently replaced by an alias.
 */
function ModelSelectField({
  connId,
  value,
  onChange,
  healthMap,
  placeholder,
  flexStyle,
  pinnedOptions,
}: {
  connId: string;
  value: string;
  onChange: (modelId: string) => void;
  healthMap: Record<string, ConnectionHealthReport>;
  placeholder?: string;
  flexStyle: React.CSSProperties;
  /** Versioned pins that stay selectable even when discovery omits them. */
  pinnedOptions?: string[];
}) {
  const models = healthMap[connId]?.models ?? [];
  const pinned: string[] = (pinnedOptions ?? []).filter((p: string) => p && !models.some(m => m.id === p));
  if (models.length === 0 && pinned.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={flexStyle}
      />
    );
  }
  const known = new Set([...models.map(m => m.id), ...pinned]);
  const isCustom = value !== '' && !known.has(value);
  return (
    <>
      <select
        value={value === '' ? '' : (isCustom ? '__custom__' : value)}
        onChange={(e) => {
          const next = e.target.value;
          if (next !== '__custom__') onChange(next);
        }}
        style={flexStyle}
      >
        <option value="" disabled>Select model…</option>
        {models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        {pinned.map((p: string) => <option key={`pinned:${p}`} value={p}>Pinned: {p}</option>)}
        <option value="__custom__">Custom…</option>
      </select>
      {isCustom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={flexStyle}
        />
      )}
    </>
  );
}

interface AiComputePanelProps {
  onChange?: () => void;
}

export function AiComputePanel({ onChange }: AiComputePanelProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [config, setConfig] = useState<AiRoutingConfig | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, ConnectionHealthReport>>({});

  // Add / Edit Modal State
  const [editingConnection, setEditingConnection] = useState<ProviderConnection | null>(null);
  const [isNewConnection, setIsNewConnection] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; models?: DiscoveredModel[] } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getAiConfig();
      setConfig(res.config);
      setHealthMap(res.health);
    } catch (err: any) {
      setError(`Failed to load AI configuration: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleProbe = async (id: string) => {
    setProbingId(id);
    try {
      const res = await probeAiConnection(id);
      setHealthMap(prev => ({ ...prev, [id]: res.health }));
    } catch (err: any) {
      setError(`Probe failed: ${err.message}`);
    } finally {
      setProbingId(null);
    }
  };

  const handleDeleteConnection = async (id: string) => {
    if (!confirm(`Are you sure you want to delete connection "${id}"? Dependent workloads will be automatically reassigned.`)) return;
    try {
      await deleteAiConnection(id);
      await loadData();
      onChange?.();
      setSuccessMsg(`Connection "${id}" deleted.`);
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setError(`Delete failed: ${err.message}`);
    }
  };

  const handleSaveConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingConnection) return;
    setSaving(true);
    setError('');
    try {
      const url = new URL(editingConnection.baseUrl);
      const expectedHost = url.hostname.toLowerCase();
      const expectedPort = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
      const pinHost = (editingConnection.approvedHost ?? '').trim().toLowerCase();
      if (pinHost && pinHost !== expectedHost) {
        setError(`Save failed: the security pin host "${pinHost}" does not match the Base URL host "${expectedHost}". The pin re-derives from the Base URL — review the Security Pin fields and save again.`);
        setSaving(false);
        return;
      }
      if (editingConnection.approvedPort !== undefined && editingConnection.approvedPort !== null && editingConnection.approvedPort !== expectedPort) {
        setError(`Save failed: the security pin port "${editingConnection.approvedPort}" does not match the Base URL port "${expectedPort}".`);
        setSaving(false);
        return;
      }

      const connToSave: ProviderConnection = {
        ...editingConnection,
        approvedHost: editingConnection.approvedHost || url.hostname,
        approvedPort: editingConnection.approvedPort ?? (url.port ? parseInt(url.port, 10) : undefined),
      };

      await upsertAiConnection(connToSave);
      setEditingConnection(null);
      await loadData();
      onChange?.();
      setSuccessMsg(`Connection "${connToSave.label}" saved successfully.`);
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setError(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnectionForm = async () => {
    if (!editingConnection?.baseUrl) return;
    setProbingId('modal');
    setTestResult(null);
    try {
      const url = new URL(editingConnection.baseUrl);
      const conn: ProviderConnection = {
        ...editingConnection,
        approvedHost: editingConnection.approvedHost || url.hostname,
        approvedPort: editingConnection.approvedPort || (url.port ? parseInt(url.port, 10) : undefined),
      };
      const res = await testEphemeralAiConnection(conn);
      setTestResult({
        success: res.health.status === 'online',
        message: res.health.status === 'online'
          ? `Connected successfully (${res.health.latencyMs}ms). Discovered ${res.health.models.length} models.`
          : `Failed (${res.health.status}): ${res.health.errorMessage ?? 'Unavailable'}`,
        models: res.health.models,
      });
    } catch (err: any) {
      setTestResult({ success: false, message: `Test failed: ${err.message}` });
    } finally {
      setProbingId(null);
    }
  };

  const handleDefaultsChange = async (newDefaults: AiRoutingConfig['defaults']) => {
    if (!config) return;
    setConfig({ ...config, defaults: newDefaults });
    try {
      await saveAiDefaults(newDefaults);
      onChange?.();
      setSuccessMsg('Defaults saved.');
      setTimeout(() => setSuccessMsg(''), 2000);
    } catch (err: any) {
      setError(`Failed to save defaults: ${err.message}`);
    }
  };

  const handleWorkloadChange = async (
    workload: string,
    field: keyof WorkloadRoute,
    val: any,
  ) => {
    if (!config) return;
    const current = config.workloads[workload as keyof typeof config.workloads];
    const updated: WorkloadRoute = {
      ...current,
      [field]: val,
    };
    try {
      await upsertAiWorkloadRoute(workload, updated);
      await loadData();
      onChange?.();
      setSuccessMsg(`Workload "${workload}" updated.`);
      setTimeout(() => setSuccessMsg(''), 2000);
    } catch (err: any) {
      setError(`Failed to update workload route: ${err.message}`);
    }
  };

  if (loading && !config) {
    return <div style={{ padding: '2rem', color: colors.mulchBrown }}>Loading AI Compute configuration...</div>;
  }

  const connections = Object.values(config?.connections ?? {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {error && (
        <div style={{
          padding: '0.75rem 1rem',
          background: '#FEF2F2',
          border: '1px solid #FCA5A5',
          borderRadius: rounded.md,
          color: '#991B1B',
          fontSize: '0.875rem',
        }}>
          {error}
        </div>
      )}

      {successMsg && (
        <div style={{
          padding: '0.75rem 1rem',
          background: '#DCFCE7',
          border: '1px solid #86EFAC',
          borderRadius: rounded.md,
          color: '#15803D',
          fontSize: '0.875rem',
        }}>
          {successMsg}
        </div>
      )}

      {/* ── Section 1: Provider Connections ─────────────────────────── */}
      <section style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: '1.5rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: fonts.display, fontSize: '1.125rem', color: colors.ledgerCharcoal }}>
              Provider Connections
            </h3>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8125rem', color: colors.mulchBrown }}>
              Inference endpoints for local machines, LAN desktop servers (LM Studio), and cloud providers.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setIsNewConnection(true);
              setTestResult(null);
              setEditingConnection({
                id: `connection-${Date.now().toString().slice(-4)}`,
                // The operator supplies the real desktop endpoint explicitly;
                // a concrete LAN address is never a product default, and the
                // connection stays disabled until the operator enables it.
                label: 'New Connection',
                transport: 'openai-compatible',
                baseUrl: '',
                credential: '',
                trustZone: 'trusted_lan',
                approvedHost: '',
                approvedPort: undefined,
                enabled: false,
                connectTimeoutMs: 2000,
                inferenceTimeoutMs: 60000,
              });
            }}
            style={{
              padding: '0.5rem 1rem',
              background: colors.uniformGreen,
              color: '#FFF',
              border: 'none',
              borderRadius: rounded.md,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + Add Connection
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {connections.map(conn => {
            const health = healthMap[conn.id];
            const isOnline = health?.status === 'online';
            const isMisconfigured = health?.status === 'misconfigured';

            return (
              <div
                key={conn.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '1rem',
                  background: colors.feedBagCream,
                  borderRadius: rounded.md,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <span
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: isOnline ? colors.seedlingGreen : (isMisconfigured ? colors.mutedGold : '#EF4444'),
                      display: 'inline-block',
                    }}
                    title={health?.status ?? 'Unknown'}
                  />
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.9375rem', color: colors.ledgerCharcoal }}>
                        {conn.label}
                      </span>
                      <span style={{
                        fontSize: '0.6875rem',
                        padding: '0.125rem 0.375rem',
                        borderRadius: rounded.sm,
                        background: conn.trustZone === 'trusted_lan' ? '#E0F2FE' : (conn.trustZone === 'this_device' ? '#DCFCE7' : '#F3F4F6'),
                        color: conn.trustZone === 'trusted_lan' ? '#0369A1' : (conn.trustZone === 'this_device' ? '#15803D' : '#374151'),
                        fontWeight: 600,
                      }}>
                        {conn.trustZone.replace('_', ' ').toUpperCase()}
                      </span>
                      {conn.transport === 'systemone' && (
                        <span style={{
                          fontSize: '0.6875rem',
                          padding: '0.125rem 0.375rem',
                          borderRadius: rounded.sm,
                          background: '#EDE9FE',
                          color: '#5B21B6',
                          fontWeight: 600,
                        }} title="Judgment-only: Choice/Noul typed questions. Never used for chat, naming, tools, or vision.">
                          TYPED JUDGMENT
                        </span>
                      )}
                      {(conn as any).hasCredential && (
                        <span style={{ fontSize: '0.6875rem', color: colors.mulchBrown }}>
                          🔒 Auth Configured
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: colors.mulchBrown, marginTop: '0.125rem', fontFamily: fonts.mono }}>
                      {conn.baseUrl} {conn.approvedHost ? `(Pinned: ${conn.approvedHost}${conn.approvedPort ? `:${conn.approvedPort}` : ''})` : ''}
                    </div>
                    {health && (
                      <div style={{ fontSize: '0.75rem', color: isOnline ? colors.seedlingGreen : '#DC2626', marginTop: '0.25rem' }}>
                        {isOnline ? `● Online (${health.models.length} models discovered · ${health.latencyMs}ms)` : `⚠ ${health.errorMessage}`}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => handleProbe(conn.id)}
                    disabled={probingId === conn.id}
                    style={{
                      padding: '0.375rem 0.75rem',
                      background: colors.whiteSurface,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    {probingId === conn.id ? 'Checking...' : 'Refresh Models'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewConnection(false);
                      setTestResult(null);
                      setEditingConnection(conn);
                    }}
                    style={{
                      padding: '0.375rem 0.75rem',
                      background: colors.whiteSurface,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteConnection(conn.id)}
                    style={{
                      padding: '0.375rem 0.5rem',
                      background: 'transparent',
                      border: 'none',
                      color: '#DC2626',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Section 2: Privacy & Data Sharing Defaults ─────────────────── */}
      <section style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: '1.5rem',
      }}>
        <h3 style={{ margin: 0, fontFamily: fonts.display, fontSize: '1.125rem', color: colors.ledgerCharcoal }}>
          Privacy Defaults
        </h3>
        <p style={{ margin: '0.25rem 0 1rem 0', fontSize: '0.8125rem', color: colors.mulchBrown }}>
          Governance boundaries controlling where text metadata and packaging photos may be transmitted.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
          {/* Text Sharing */}
          <div style={{ padding: '1rem', background: colors.feedBagCream, borderRadius: rounded.md }}>
            <span style={{ fontWeight: 600, fontSize: '0.875rem', color: colors.ledgerCharcoal }}>
              Text Data Sharing
            </span>
            <p style={{ fontSize: '0.75rem', color: colors.mulchBrown, margin: '0.25rem 0 0.75rem 0' }}>
              Allows catalog and product text prompts to travel across:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.8125rem' }}>
              {(['this_device_only', 'trusted_lan_allowed', 'cloud_allowed'] as DataSharingPolicy[]).map(p => (
                <label key={p} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="textDataSharing"
                    checked={config?.defaults.textDataSharing === p}
                    onChange={() => {
                      if (config) {
                        handleDefaultsChange({ ...config.defaults, textDataSharing: p });
                      }
                    }}
                  />
                  <span>{p === 'this_device_only' ? 'This Device Only' : (p === 'trusted_lan_allowed' ? 'Trusted LAN Allowed' : 'Cloud Allowed (OpenAI / DeepSeek)')}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Image Sharing */}
          <div style={{ padding: '1rem', background: colors.feedBagCream, borderRadius: rounded.md }}>
            <span style={{ fontWeight: 600, fontSize: '0.875rem', color: colors.ledgerCharcoal }}>
              Packaging Image Sharing (OCR / Vision)
            </span>
            <p style={{ fontSize: '0.75rem', color: colors.mulchBrown, margin: '0.25rem 0 0.75rem 0' }}>
              Controls where raw high-res package photos may be sent:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.8125rem' }}>
              {(['this_device_only', 'trusted_lan_allowed', 'cloud_allowed'] as DataSharingPolicy[]).map(p => (
                <label key={p} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="imageDataSharing"
                    checked={config?.defaults.imageDataSharing === p}
                    onChange={() => {
                      if (config) {
                        handleDefaultsChange({ ...config.defaults, imageDataSharing: p });
                      }
                    }}
                  />
                  <span>{p === 'this_device_only' ? 'This Device Only' : (p === 'trusted_lan_allowed' ? 'Trusted LAN (Desktop LM Studio Only)' : 'Cloud Allowed')}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 3: Workload Routing & Inheritance ──────────────────── */}
      <section style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: '1.5rem',
      }}>
        <h3 style={{ margin: 0, fontFamily: fonts.display, fontSize: '1.125rem', color: colors.ledgerCharcoal }}>
          Catalog & Workload Model Routing
        </h3>
        <p style={{ margin: '0.25rem 0 1rem 0', fontSize: '0.8125rem', color: colors.mulchBrown }}>
          Configure primary models and availability fallbacks. Discovery and Curation inherit from Catalog Default.
        </p>

        {config && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Catalog Default */}
            <div style={{
              padding: '1rem',
              background: '#F8FAFC',
              border: '1px solid #CBD5E1',
              borderRadius: rounded.md,
            }}>
              <div style={{ fontWeight: 600, fontSize: '0.9375rem', color: colors.ledgerCharcoal, marginBottom: '0.5rem' }}>
                📁 Catalog Default (Parent)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontSize: '0.8125rem' }}>
                <div>
                  <label style={{ display: 'block', color: colors.mulchBrown, marginBottom: '0.25rem' }}>Primary Target</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <select
                      value={config.defaults.catalogTarget.connectionId}
                      onChange={(e) => {
                        const connId = e.target.value;
                        const models = healthMap[connId]?.models ?? [];
                        const modelId = models[0]?.id ?? config.defaults.catalogTarget.modelId;
                        handleDefaultsChange({
                          ...config.defaults,
                          catalogTarget: { connectionId: connId, modelId },
                        });
                      }}
                      style={{ flex: 1, padding: '0.375rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                    >
                      {connections.filter(c => c.transport !== 'systemone').map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <ModelSelectField
                      connId={config.defaults.catalogTarget.connectionId}
                      value={config.defaults.catalogTarget.modelId}
                      healthMap={healthMap}
                      pinnedOptions={config.defaults.catalogTarget.connectionId === 'typesafe-jev' ? [...TYPESAFE_PINNED_MODELS] : undefined}
                      onChange={(modelId) => handleDefaultsChange({
                        ...config.defaults,
                        catalogTarget: { ...config.defaults.catalogTarget, modelId },
                      })}
                      placeholder="Model ID"
                      flexStyle={{ flex: 1, padding: '0.375rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                    />
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', color: colors.mulchBrown, marginBottom: '0.25rem' }}>Offline Fallback</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <select
                      value={config.defaults.catalogFallback?.connectionId ?? ''}
                      onChange={(e) => {
                        const connId = e.target.value;
                        handleDefaultsChange({
                          ...config.defaults,
                          catalogFallback: connId
                            ? { connectionId: connId, modelId: defaultModelForConnection(connId, healthMap) || 'gpt-4o-mini' }
                            : null,
                        });
                      }}
                      style={{ flex: 1, padding: '0.375rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                    >
                      <option value="">None (Heuristic / Fail)</option>
                      {connections.filter(c => c.transport !== 'systemone').map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    {config.defaults.catalogFallback && (
                      <ModelSelectField
                        connId={config.defaults.catalogFallback.connectionId}
                        value={config.defaults.catalogFallback.modelId}
                        healthMap={healthMap}
                        pinnedOptions={config.defaults.catalogFallback.connectionId === 'typesafe-jev' ? [...TYPESAFE_PINNED_MODELS] : undefined}
                        onChange={(modelId) => handleDefaultsChange({
                          ...config.defaults,
                          catalogFallback: {
                            ...config.defaults.catalogFallback!,
                            modelId,
                          },
                        })}
                        placeholder="Model ID"
                        flexStyle={{ flex: 1, padding: '0.375rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Individual Workloads */}
            {[
              { id: 'discovery', label: 'Discovery (Brand Inference & Sitemaps)', hint: 'Inherits Catalog Default. Falls back to deterministic heuristics when offline.' },
              { id: 'curation', label: 'Curation (General Workload)', hint: 'General curation tasks. Product type, attribute, and page classification are governed exclusively by Classification Stage Providers below.' },
              { id: 'visionOcr', label: 'Packaging OCR / Vision', hint: 'Primary VLM for high-res package OCR. Respects Image Sharing policy.' },
              { id: 'profileBuilder', label: 'Profile Builder (AI Selector Proposal)', hint: 'Fails closed when primary and fallback fail.' },
              { id: 'storeManager', label: 'Store Manager Assistant', hint: 'Agentic assistant with native tool-calling.' },
            ].map(w => {
              const route = config.workloads[w.id as keyof typeof config.workloads];
              const isPrimaryInherit = route.primary === 'inherit';
              const isFallbackInherit = route.fallback === 'inherit';

              return (
                <div
                  key={w.id}
                  style={{
                    padding: '1rem',
                    background: colors.feedBagCream,
                    borderRadius: rounded.md,
                    border: `1px solid ${colors.cardBorder}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: colors.ledgerCharcoal }}>
                        {w.label}
                      </span>
                      <p style={{ margin: '0.125rem 0 0 0', fontSize: '0.75rem', color: colors.mulchBrown }}>
                        {w.hint}
                      </p>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
                    {/* Primary */}
                    <div>
                      <label style={{ display: 'block', color: colors.mulchBrown, fontSize: '0.75rem', marginBottom: '0.25rem' }}>Primary</label>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <select
                          value={isPrimaryInherit ? 'inherit' : (route.primary as ModelTarget).connectionId}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === 'inherit') {
                              handleWorkloadChange(w.id, 'primary', 'inherit');
                            } else {
                              handleWorkloadChange(w.id, 'primary', { connectionId: val, modelId: defaultModelForConnection(val, healthMap) || '' });
                            }
                          }}
                          style={{ flex: 1, padding: '0.375rem', fontSize: '0.8125rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                        >
                          <option value="inherit">Inherit Catalog Default</option>
                          {connections.filter(c => c.transport !== 'systemone').map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                        {!isPrimaryInherit && (
                          <ModelSelectField
                            connId={(route.primary as ModelTarget).connectionId}
                            value={(route.primary as ModelTarget).modelId}
                            healthMap={healthMap}
                            pinnedOptions={(route.primary as ModelTarget).connectionId === 'typesafe-jev' ? [...TYPESAFE_PINNED_MODELS] : undefined}
                            onChange={(modelId) => handleWorkloadChange(w.id, 'primary', {
                              ...(route.primary as ModelTarget),
                              modelId,
                            })}
                            placeholder="Model ID"
                            flexStyle={{ flex: 1, padding: '0.375rem', fontSize: '0.8125rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                          />
                        )}
                      </div>
                    </div>

                    {/* Fallback */}
                    <div>
                      <label style={{ display: 'block', color: colors.mulchBrown, fontSize: '0.75rem', marginBottom: '0.25rem' }}>Fallback</label>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <select
                          value={isFallbackInherit ? 'inherit' : (route.fallback ? (route.fallback as ModelTarget).connectionId : '')}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === 'inherit') {
                              handleWorkloadChange(w.id, 'fallback', 'inherit');
                            } else if (val === '') {
                              handleWorkloadChange(w.id, 'fallback', null);
                            } else {
                              handleWorkloadChange(w.id, 'fallback', { connectionId: val, modelId: defaultModelForConnection(val, healthMap) || 'gpt-4o-mini' });
                            }
                          }}
                          style={{ flex: 1, padding: '0.375rem', fontSize: '0.8125rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                        >
                          <option value="inherit">Inherit Catalog Fallback</option>
                          <option value="">None (Heuristic / Fail)</option>
                          {connections.filter(c => c.transport !== 'systemone').map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                        {!isFallbackInherit && route.fallback && (
                          <ModelSelectField
                            connId={(route.fallback as ModelTarget).connectionId}
                            value={(route.fallback as ModelTarget).modelId}
                            healthMap={healthMap}
                            pinnedOptions={(route.fallback as ModelTarget).connectionId === 'typesafe-jev' ? [...TYPESAFE_PINNED_MODELS] : undefined}
                            onChange={(modelId) => handleWorkloadChange(w.id, 'fallback', {
                              ...(route.fallback as ModelTarget),
                              modelId,
                            })}
                            placeholder="Fallback Model ID"
                            flexStyle={{ flex: 1, padding: '0.375rem', fontSize: '0.8125rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 4. Classification Stage Providers (Issue #296 / Model Policy Authority) ── */}
      <section style={{
        background: colors.whiteSurface,
        borderRadius: rounded.lg,
        border: `1px solid ${colors.cardBorder}`,
        padding: '1.5rem',
      }}>
        <ClassificationProviderSettings />
      </section>

      {/* ── Modal: Add / Edit Connection ───────────────────────────────── */}
      {editingConnection && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: colors.whiteSurface,
            borderRadius: rounded.lg,
            padding: '2rem',
            maxWidth: '540px',
            width: '100%',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
          }}>
            <h3 style={{ margin: '0 0 1rem 0', fontFamily: fonts.display, color: colors.ledgerCharcoal }}>
              {isNewConnection ? 'Add Provider Connection' : 'Edit Provider Connection'}
            </h3>

            <form onSubmit={handleSaveConnection} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
                  Label
                </label>
                <input
                  type="text"
                  required
                  value={editingConnection.label}
                  onChange={(e) => setEditingConnection({ ...editingConnection, label: e.target.value })}
                  placeholder="e.g. Desktop LM Studio (Office PC)"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
                    Base URL
                  </label>
                  <input
                    type="text"
                    required
                    value={editingConnection.baseUrl}
                    onChange={(e) => {
                      const baseUrl = e.target.value;
                      const pin = pinFromUrl(baseUrl);
                      setEditingConnection(prev => prev ? {
                        ...prev,
                        baseUrl,
                        ...(pin.host ? { approvedHost: pin.host } : {}),
                        ...(pin.port !== undefined ? { approvedPort: pin.port } : {}),
                      } : prev);
                    }}
                    placeholder="http://<desktop-ip>:1234/v1"
                    style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, fontFamily: fonts.mono, fontSize: '0.8125rem' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
                    Trust Zone
                  </label>
                  <select
                    value={editingConnection.trustZone}
                    onChange={(e) => setEditingConnection({ ...editingConnection, trustZone: e.target.value as AiTrustZone })}
                    style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                  >
                    <option value="trusted_lan">Trusted LAN</option>
                    <option value="this_device">This Device</option>
                    <option value="cloud">Cloud</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
                  Transport
                </label>
                <select
                  value={editingConnection.transport}
                  onChange={(e) => {
                    const transport = e.target.value as ProviderConnection['transport'];
                    setEditingConnection(prev => prev ? {
                      ...prev,
                      transport,
                      // Switching to System One presets the TypeSafe endpoint
                      // and trust zone; the operator still supplies the key.
                      ...(transport === 'systemone' ? {
                        baseUrl: 'https://api.typesafe.ai/v1',
                        trustZone: 'cloud' as AiTrustZone,
                        approvedHost: 'api.typesafe.ai',
                        approvedPort: 443,
                      } : {}),
                    } : prev);
                  }}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                >
                  <option value="openai-compatible">OpenAI-compatible (chat)</option>
                  <option value="ollama-native">Ollama-native (chat)</option>
                  <option value="systemone">System One (typed judgment — TypeSafe Jev)</option>
                </select>
                {editingConnection.transport === 'systemone' && (
                  <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.6875rem', color: colors.mulchBrown }}>
                    Judgment-only: answers typed Choice/Noul questions for classification stages. Never offered for chat, naming, tool, or vision routes.
                  </p>
                )}
              </div>

              <div style={{ padding: '0.75rem', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: rounded.md }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
                  Security Pin (Approved Host / Port)
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
                  <input
                    type="text"
                    value={editingConnection.approvedHost ?? ''}
                    onChange={(e) => setEditingConnection({ ...editingConnection, approvedHost: e.target.value })}
                    placeholder="<desktop-ip>"
                    style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, fontFamily: fonts.mono, fontSize: '0.8125rem' }}
                  />
                  <input
                    type="number"
                    value={editingConnection.approvedPort ?? ''}
                    onChange={(e) => setEditingConnection({ ...editingConnection, approvedPort: e.target.value === '' ? undefined : Number(e.target.value) })}
                    placeholder="1234"
                    style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, fontFamily: fonts.mono, fontSize: '0.8125rem' }}
                  />
                </div>
                <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.6875rem', color: colors.mulchBrown }}>
                  The server fails closed when the Base URL host/port differs from this pin (anti-SSRF guard). It re-derives from the Base URL automatically — edit deliberately only if you must override.
                </p>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
                  API Key / Bearer Token {(editingConnection as any).hasCredential ? '(Configured — leave blank to keep existing)' : (editingConnection.transport === 'systemone' ? '(Required for TypeSafe)' : '(Optional)')}
                </label>
                <input
                  type="password"
                  value={editingConnection.credential ?? ''}
                  onChange={(e) => setEditingConnection({ ...editingConnection, credential: e.target.value })}
                  placeholder={(editingConnection as any).hasCredential ? '••••••••••••' : (editingConnection.transport === 'systemone' ? 'Enter TypeSafe API key' : 'Enter API key or leave blank')}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
                />
              </div>

              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', fontWeight: 600, color: colors.ledgerCharcoal, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={editingConnection.enabled !== false}
                    onChange={(e) => setEditingConnection({ ...editingConnection, enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <p style={{ margin: '0.25rem 0 0 1.5rem', fontSize: '0.6875rem', color: colors.mulchBrown }}>
                  Disabled connections are never dispatched or retried. The TypeSafe connection stays inert until enabled and a stage adapter lands.
                </p>
              </div>

              {testResult && (
                <div style={{
                  padding: '0.75rem',
                  borderRadius: rounded.md,
                  background: testResult.success ? '#DCFCE7' : '#FEF2F2',
                  border: `1px solid ${testResult.success ? '#86EFAC' : '#FCA5A5'}`,
                  fontSize: '0.8125rem',
                  color: testResult.success ? '#15803D' : '#991B1B',
                }}>
                  <div>{testResult.message}</div>
                  {testResult.models && testResult.models.length > 0 && (
                    <div style={{ marginTop: '0.5rem', maxHeight: '100px', overflowY: 'auto' }}>
                      <strong>Available models:</strong> {testResult.models.map(m => m.id).join(', ')}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
                <button
                  type="button"
                  onClick={handleTestConnectionForm}
                  disabled={probingId === 'modal'}
                  style={{
                    padding: '0.5rem 1rem',
                    background: colors.feedBagCream,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  {probingId === 'modal' ? 'Testing...' : 'Test Connection'}
                </button>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setEditingConnection(null)}
                    style={{
                      padding: '0.5rem 1rem',
                      background: 'transparent',
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.md,
                      fontSize: '0.875rem',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    style={{
                      padding: '0.5rem 1rem',
                      background: colors.uniformGreen,
                      color: '#FFF',
                      border: 'none',
                      borderRadius: rounded.md,
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {saving ? 'Saving...' : 'Save Connection'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
