import React, { useEffect, useState, useCallback } from 'react';
import {
  getClassificationPolicySettings,
  previewClassificationPolicy,
  applyClassificationPolicy,
  type ClassificationPolicySettingsResponse,
  type EffectiveStageRouteView,
  type ConnectionOptionView,
  type PreviewPolicyResultResponse,
} from '../../api';
import { colors, fonts, rounded } from '../../theme';

interface StageFormState {
  override: boolean;
  connectionId: string;
  model: string;
  fallbackConnectionId: string;
  fallbackModel: string;
}

export function ClassificationProviderSettings(): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [settings, setSettings] = useState<ClassificationPolicySettingsResponse | null>(null);

  // Form states
  const [textDataSharing, setTextDataSharing] = useState<'local_only' | 'cloud_allowed'>('local_only');
  const [imageDataSharing, setImageDataSharing] = useState<'local_only' | 'cloud_allowed'>('local_only');
  const [stageForms, setStageForms] = useState<Record<string, StageFormState>>({});

  // Preview state
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewPolicyResultResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Apply state
  const [applying, setApplying] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getClassificationPolicySettings();
      const s = data.settings;
      setSettings(s);
      setTextDataSharing(s.textDataSharing);
      setImageDataSharing(s.imageDataSharing);

      const forms: Record<string, StageFormState> = {};
      for (const stage of s.stages) {
        forms[stage.id] = {
          override: !stage.isInherited,
          connectionId: stage.connectionId || (s.availableConnections[0]?.id ?? ''),
          model: stage.effectiveModel || '',
          fallbackConnectionId: stage.effectiveFallbackProvider || '',
          fallbackModel: stage.effectiveFallbackModel || '',
        };
      }
      setStageForms(forms);
      setPreviewResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const handleStageFieldChange = (stageId: string, field: keyof StageFormState, value: any) => {
    setStageForms(prev => ({
      ...prev,
      [stageId]: {
        ...prev[stageId],
        [field]: value,
      },
    }));
    setPreviewResult(null); // invalidate prior preview
    setSuccessMsg(null);
  };

  const handlePreview = async () => {
    if (!settings) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const stageOverridesPayload: Record<string, any> = {};
      for (const stage of settings.stages) {
        const form = stageForms[stage.id];
        if (form && form.override) {
          stageOverridesPayload[stage.id] = {
            connectionId: form.connectionId || null,
            model: form.model || null,
            fallbackConnectionId: form.fallbackConnectionId || null,
            fallbackModel: form.fallbackModel || null,
          };
        } else {
          stageOverridesPayload[stage.id] = {
            connectionId: null,
            model: null,
            fallbackConnectionId: null,
            fallbackModel: null,
          };
        }
      }

      const res = await previewClassificationPolicy({
        expectedBaseBundleHash: settings.bundleHash,
        stageOverrides: stageOverridesPayload,
        textDataSharing,
        imageDataSharing,
      });
      setPreviewResult(res.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!settings || !previewResult || !previewResult.previewToken) return;
    setApplying(true);
    setError(null);
    try {
      const stageOverridesPayload: Record<string, any> = {};
      for (const stage of settings.stages) {
        const form = stageForms[stage.id];
        if (form && form.override) {
          stageOverridesPayload[stage.id] = {
            connectionId: form.connectionId || null,
            model: form.model || null,
            fallbackConnectionId: form.fallbackConnectionId || null,
            fallbackModel: form.fallbackModel || null,
          };
        } else {
          stageOverridesPayload[stage.id] = {
            connectionId: null,
            model: null,
            fallbackConnectionId: null,
            fallbackModel: null,
          };
        }
      }

      const res = await applyClassificationPolicy({
        previewToken: previewResult.previewToken,
        expectedBaseBundleHash: settings.bundleHash,
        stageOverrides: stageOverridesPayload,
        textDataSharing,
        imageDataSharing,
      });

      setSuccessMsg(`Classification policy updated successfully! (Bundle: ${res.result.bundleHash.slice(0, 8)}${res.result.commitHash ? `, Commit: ${res.result.commitHash.slice(0, 8)}` : ''})`);
      await fetchSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: colors.mulchBrown }}>
        Loading classification provider policy...
      </div>
    );
  }

  if (settings?.migrationRequired) {
    return (
      <div
        style={{
          padding: '1.5rem',
          background: '#FEF3C7',
          border: '1px solid #F59E0B',
          borderRadius: rounded.lg,
          color: '#92400E',
          margin: '1rem 0',
        }}
      >
        <h3 style={{ margin: '0 0 0.5rem 0', fontFamily: fonts.display }}>Classification v2 Migration Required</h3>
        <p style={{ margin: 0, fontSize: '0.875rem' }}>
          This workspace is running legacy v1 classification configuration. Provider stage routing is governed exclusively by v2 model policies.
          Please perform the configuration migration in Onboarding Settings before configuring stage overrides.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem 0', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: fonts.display, fontSize: '1.25rem', color: colors.ledgerCharcoal }}>
              Classification Stage Providers
            </h2>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8125rem', color: colors.mulchBrown }}>
              Configure provider connections for Curation classification stages. Stage overrides in Model Policy are the sole authority.
            </p>
          </div>
          {settings && (
            <div style={{ textAlign: 'right', fontSize: '0.75rem', color: colors.mulchBrown }}>
              <div>Active Revision: <strong>{settings.activeRevision}</strong></div>
              <div style={{ fontFamily: fonts.mono }}>Hash: {settings.bundleHash ? settings.bundleHash.slice(0, 10) : 'none'}</div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: '#FEE2E2',
            border: '1px solid #EF4444',
            borderRadius: rounded.md,
            color: '#B91C1C',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      {successMsg && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: '#ECFDF5',
            border: '1px solid #10B981',
            borderRadius: rounded.md,
            color: '#047857',
            fontSize: '0.875rem',
          }}
        >
          {successMsg}
        </div>
      )}

      {/* Data Sharing Policies */}
      <div
        style={{
          background: colors.whiteSurface,
          padding: '1.25rem',
          borderRadius: rounded.lg,
          border: `1px solid ${colors.cardBorder}`,
        }}
      >
        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem', color: colors.ledgerCharcoal }}>
          Data Sharing & Locality Boundaries
        </h3>
        <p style={{ margin: '0 0 1rem 0', fontSize: '0.8125rem', color: colors.mulchBrown }}>
          Control whether product attributes and text can leave this device to reach cloud provider connections.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
              Text Data Sharing
            </label>
            <select
              value={textDataSharing}
              onChange={(e) => {
                setTextDataSharing(e.target.value as any);
                setPreviewResult(null);
              }}
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: rounded.sm,
                border: `1px solid ${colors.cardBorder}`,
                fontSize: '0.8125rem',
              }}
            >
              <option value="local_only">Local Only (Reject cloud transmission)</option>
              <option value="cloud_allowed">Cloud Allowed (Allow cloud providers)</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal, marginBottom: '0.25rem' }}>
              Image Data Sharing
            </label>
            <select
              value={imageDataSharing}
              onChange={(e) => {
                setImageDataSharing(e.target.value as any);
                setPreviewResult(null);
              }}
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: rounded.sm,
                border: `1px solid ${colors.cardBorder}`,
                fontSize: '0.8125rem',
              }}
            >
              <option value="local_only">Local Only (Reject external OCR/VLM)</option>
              <option value="cloud_allowed">Cloud Allowed (Allow external OCR/VLM)</option>
            </select>
          </div>
        </div>
      </div>

      {/* The 3 Stage Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {settings?.stages.map((stage: EffectiveStageRouteView) => {
          const form = stageForms[stage.id] || {
            override: false,
            connectionId: '',
            model: '',
            fallbackConnectionId: '',
            fallbackModel: '',
          };

          const selectedConn = settings.availableConnections.find(c => c.id === form.connectionId);
          const stageSupport = selectedConn?.stageSupport?.[stage.id];
          const isUnsupported = selectedConn && stageSupport?.supported === false;

          return (
            <div
              key={stage.id}
              style={{
                background: colors.whiteSurface,
                padding: '1.25rem',
                borderRadius: rounded.lg,
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9375rem', color: colors.ledgerCharcoal }}>
                      {stage.label}
                    </span>
                    <span
                      style={{
                        fontSize: '0.6875rem',
                        padding: '0.125rem 0.375rem',
                        borderRadius: rounded.full,
                        background: form.override ? '#DBEAFE' : '#F3F4F6',
                        color: form.override ? '#1D4ED8' : '#4B5563',
                        fontWeight: 600,
                      }}
                    >
                      {form.override ? 'Stage Override' : 'Inherited from Default'}
                    </span>
                  </div>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: colors.mulchBrown }}>
                    {stage.description}
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.8125rem', color: colors.ledgerCharcoal, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <input
                      type="checkbox"
                      checked={form.override}
                      onChange={(e) => handleStageFieldChange(stage.id, 'override', e.target.checked)}
                    />
                    Override Stage Provider
                  </label>
                </div>
              </div>

              {!form.override ? (
                <div style={{ fontSize: '0.8125rem', color: colors.mulchBrown, background: colors.feedBagCream, padding: '0.75rem', borderRadius: rounded.md }}>
                  Effective Route: <strong>{stage.effectiveProvider}</strong> / <strong>{stage.effectiveModel}</strong>
                  {stage.effectiveFallbackProvider && (
                    <span> (Fallback: {stage.effectiveFallbackProvider} / {stage.effectiveFallbackModel})</span>
                  )}
                  <span style={{ marginLeft: '0.75rem', fontSize: '0.75rem', color: stage.connectionStatus === 'healthy' ? '#059669' : '#D97706' }}>
                    ● {stage.connectionStatus}
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    {/* Primary Provider Connection */}
                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: colors.ledgerCharcoal, marginBottom: '0.25rem', fontWeight: 500 }}>
                        Primary Provider Connection
                      </label>
                      <select
                        value={form.connectionId}
                        onChange={(e) => {
                          const nextConnId = e.target.value;
                          const nextConn = settings.availableConnections.find(c => c.id === nextConnId);
                          handleStageFieldChange(stage.id, 'connectionId', nextConnId);
                          if (nextConn && nextConn.models?.[0]?.id) {
                            handleStageFieldChange(stage.id, 'model', nextConn.models[0].id);
                          }
                        }}
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          borderRadius: rounded.sm,
                          border: `1px solid ${isUnsupported ? '#F59E0B' : colors.cardBorder}`,
                          fontSize: '0.8125rem',
                        }}
                      >
                        {settings.availableConnections.map((c: ConnectionOptionView) => {
                          const supported = c.stageSupport[stage.id]?.supported;
                          return (
                            <option key={c.id} value={c.id}>
                              {c.label} ({c.locality.toUpperCase()}) {supported ? '' : '⚠️ (Adapter Unwired)'}
                            </option>
                          );
                        })}
                      </select>
                    </div>

                    {/* Primary Model */}
                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: colors.ledgerCharcoal, marginBottom: '0.25rem', fontWeight: 500 }}>
                        Model
                      </label>
                      <input
                        type="text"
                        value={form.model}
                        onChange={(e) => handleStageFieldChange(stage.id, 'model', e.target.value)}
                        placeholder="Model identifier (e.g. qwen2.5:7b)"
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          borderRadius: rounded.sm,
                          border: `1px solid ${colors.cardBorder}`,
                          fontSize: '0.8125rem',
                          fontFamily: fonts.mono,
                        }}
                      />
                    </div>
                  </div>

                  {/* Unsupported Adapter Notice (e.g. TypeSafe Jev pending #297/#298/#299) */}
                  {isUnsupported && (
                    <div
                      style={{
                        padding: '0.75rem',
                        background: '#FFFBEB',
                        border: '1px solid #FDE68A',
                        borderRadius: rounded.md,
                        fontSize: '0.75rem',
                        color: '#92400E',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <span>⚠️</span>
                      <div>
                        <strong>Incompatible with Stage:</strong>{' '}
                        {stageSupport?.reason || 'Adapter is unwired for this stage.'}
                      </div>
                    </div>
                  )}

                  {/* Fallback settings */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.25rem' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: colors.mulchBrown, marginBottom: '0.25rem' }}>
                        Fallback Connection (Optional)
                      </label>
                      <select
                        value={form.fallbackConnectionId}
                        onChange={(e) => handleStageFieldChange(stage.id, 'fallbackConnectionId', e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.375rem 0.5rem',
                          borderRadius: rounded.sm,
                          border: `1px solid ${colors.cardBorder}`,
                          fontSize: '0.75rem',
                        }}
                      >
                        <option value="">None (No fallback)</option>
                        {settings.availableConnections.map((c: ConnectionOptionView) => (
                          <option key={c.id} value={c.id}>
                            {c.label} ({c.locality.toUpperCase()})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: colors.mulchBrown, marginBottom: '0.25rem' }}>
                        Fallback Model
                      </label>
                      <input
                        type="text"
                        value={form.fallbackModel}
                        onChange={(e) => handleStageFieldChange(stage.id, 'fallbackModel', e.target.value)}
                        placeholder="Fallback Model"
                        style={{
                          width: '100%',
                          padding: '0.375rem 0.5rem',
                          borderRadius: rounded.sm,
                          border: `1px solid ${colors.cardBorder}`,
                          fontSize: '0.75rem',
                          fontFamily: fonts.mono,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Preview & Apply Card */}
      <div
        style={{
          background: colors.whiteSurface,
          padding: '1.25rem',
          borderRadius: rounded.lg,
          border: `1px solid ${colors.cardBorder}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '0.9375rem', color: colors.ledgerCharcoal }}>
              Validation, Data-Sharing Effects & Changes
            </h4>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: colors.mulchBrown }}>
              Preview changes to check data-sharing implications and verify atomic configuration integrity before applying.
            </p>
          </div>

          <button
            type="button"
            onClick={handlePreview}
            disabled={previewing || applying}
            style={{
              padding: '0.5rem 1rem',
              background: colors.uniformGreen,
              color: '#FFFFFF',
              border: 'none',
              borderRadius: rounded.md,
              fontWeight: 600,
              fontSize: '0.8125rem',
              cursor: previewing ? 'wait' : 'pointer',
            }}
          >
            {previewing ? 'Evaluating Preview...' : 'Preview Changes'}
          </button>
        </div>

        {previewError && (
          <div
            style={{
              padding: '0.75rem',
              background: '#FEE2E2',
              border: '1px solid #EF4444',
              borderRadius: rounded.md,
              color: '#B91C1C',
              fontSize: '0.8125rem',
            }}
          >
            {previewError}
          </div>
        )}

        {previewResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderTop: `1px solid ${colors.cardBorder}`, paddingTop: '1rem' }}>
            {!previewResult.valid ? (
              <div
                style={{
                  padding: '0.75rem',
                  background: '#FEF2F2',
                  border: '1px solid #F87171',
                  borderRadius: rounded.md,
                  color: '#991B1B',
                  fontSize: '0.8125rem',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Cannot Apply Changes:</div>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {previewResult.validationErrors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div
                  style={{
                    padding: '0.75rem',
                    background: '#F0FDF4',
                    border: '1px solid #86EFAC',
                    borderRadius: rounded.md,
                    color: '#166534',
                    fontSize: '0.8125rem',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>Configuration Valid</div>
                  <div style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    Preview Token: <code style={{ fontFamily: fonts.mono }}>{previewResult.previewToken?.slice(0, 16)}...</code>
                  </div>
                </div>

                {previewResult.dataSharingEffects.length > 0 && (
                  <div style={{ fontSize: '0.8125rem', color: colors.ledgerCharcoal }}>
                    <span style={{ fontWeight: 600 }}>Data-Sharing Effects:</span>
                    <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem', color: colors.mulchBrown }}>
                      {previewResult.dataSharingEffects.map((eff, idx) => (
                        <li key={idx}>{eff}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={handleApply}
                    disabled={applying}
                    style={{
                      padding: '0.5rem 1.25rem',
                      background: colors.seedlingGreen,
                      color: '#FFFFFF',
                      border: 'none',
                      borderRadius: rounded.md,
                      fontWeight: 600,
                      fontSize: '0.8125rem',
                      cursor: applying ? 'wait' : 'pointer',
                    }}
                  >
                    {applying ? 'Applying under CAS Lock...' : 'Apply Classification Policy'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
