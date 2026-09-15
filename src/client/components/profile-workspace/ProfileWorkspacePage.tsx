// story: e08 tracer — merged picker/suite → canonical capture → builder preview (General Store)
// route pattern: /settings/domains/:domain/profile
import React, { useEffect, useState, useCallback } from 'react';
import { normalizeBrandHubDomain } from '../../../onboarding/brand-hub/normalizeDomain';
import { getProfileWorkspacePath, parseReturnPath, parseWorkspaceParams } from './route';
import { ProfileWorkspaceHeader } from './ProfileWorkspaceHeader';
import { ReadinessRail } from './ReadinessRail';
import { EvidenceRail } from './EvidenceRail';
import { HistoryShell } from './HistoryShell';
import { ProfileBuilder } from '../profile-builder/ProfileBuilder';
import { OutputFirstWorkspace } from './OutputFirstWorkspace';
import type { DomainProfileState } from '../../../db/repositories/domain-profile-state-repo';
import { deriveReadinessState } from '../../../onboarding/profile-readiness';
import { SuitePanel } from './SuitePanel';
import { TestMatrix } from './TestMatrix';
import type { MatrixResult } from '../../../onboarding/profile-test-matrix';
import { colors, fonts, rounded } from '../../theme';

type SuiteResp = { suite: string[]; inventory: { candidateCount: number; confirmedCount: number; freshness: string | null }; clusters?: Array<{ prefix: string; count: number; key: string; fingerprint: string; suggestedUrl: string }>; suggested?: string[] };
type CaptureArtifact = { dom: string; screenshotBase64: string; runtime: string; hash: string; capturedAt: string; url: string } | null;

export function ProfileWorkspacePage({ domain: rawDomain }: { domain: string }): React.ReactElement {
  const domain = normalizeBrandHubDomain(rawDomain);
  const [state, setState] = useState<DomainProfileState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suiteResp, setSuiteResp] = useState<SuiteResp | null>(null);
  const [captureArtifact, setCaptureArtifact] = useState<CaptureArtifact>(null);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [matrixResult, setMatrixResult] = useState<MatrixResult | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ field: string; sampleId: string } | null>(null);
  const [approvedSamples, setApprovedSamples] = useState<Set<string>>(new Set());
  const [builderCollapsed, setBuilderCollapsed] = useState(false);
  const [validationCollapsed, setValidationCollapsed] = useState(false);

  const handleToggleApproveSample = useCallback((url: string) => {
    setApprovedSamples((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const handleApproveAll = useCallback(() => {
    const urls = matrixResult?.rows.map((r) => r.sampleUrl) ?? suiteResp?.suite ?? [];
    setApprovedSamples(new Set(urls));
  }, [matrixResult, suiteResp]);
  const [draftVersionId, setDraftVersionId] = useState<string | null>(null);
  const workspaceParams = typeof window !== 'undefined' ? parseWorkspaceParams(window.location.search) : {};
  const returnPath = workspaceParams.returnPath ?? (typeof window !== 'undefined' ? parseReturnPath(window.location.search) : null);
  const seedUrl = workspaceParams.seedUrl ?? null;
  const seedFailureReason = workspaceParams.failureReason ?? null;

  const fetchState = async (): Promise<void> => {
    setLoadError(null);
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile-state`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && typeof j === 'object' && 'domain' in j) setState(j as DomainProfileState);
      else throw new Error('Invalid profile state');
    } catch (e) { setLoadError(String(e)); }
  };

  const fetchSuite = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`);
      if (!r.ok) return;
      const j = await r.json() as SuiteResp;
      setSuiteResp(j);
    } catch (_err) {
      // Suite fetch non-fatal
    }
  }, [domain]);

  useEffect(() => { void fetchState(); void fetchSuite(); }, [domain, fetchSuite]);

  const suiteConfirmed = suiteResp?.suite.length ?? 0;
  const evidencePass = Boolean(state?.testsPassEvidence && state.testsPassEvidence.artifactHashes.length >= 3);
  const hasDraft = Boolean(draftVersionId);
  const matrixPass = Boolean(
    matrixResult &&
    matrixResult.rows.length >= 3 &&
    matrixResult.rows.every((r) => r.cells.every((c) => c.success))
  );
  const suiteUrls = suiteResp?.suite ?? [];
  const allSamplesApproved =
    approvedSamples.size >= 3 &&
    (suiteUrls.length === 0 || suiteUrls.every((u) => approvedSamples.has(u)) || ((matrixResult?.rows.length ?? 0) >= 3 && matrixResult!.rows.every((r) => approvedSamples.has(r.sampleUrl))));
  const testsPass = Boolean(
    (state?.activeVersion && evidencePass && state.activeVersion === state.testsPassEvidence?.versionId) ||
    matrixPass ||
    (hasDraft && (allSamplesApproved || (matrixResult && matrixResult.rows.length >= 3)))
  );
  const readiness = state
    ? deriveReadinessState({
        hasProfile: state.hasProfile,
        hasIndex: state.productCount > 0,
        hasDraft,
        confirmedCount: suiteConfirmed,
        testsPass,
        isActive: Boolean(state.activeVersion && evidencePass),
        needsRevalidation: (!state.activeVersion || !evidencePass) && state.productCount > 0,
        productCount: state.productCount,
      })
    : deriveReadinessState({
        hasProfile: false, hasIndex: false, hasDraft: false, confirmedCount: suiteConfirmed, testsPass: false, isActive: false, needsRevalidation: false, productCount: 0,
      });

  const [gridVisible, setGridVisible] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.ctrlKey && e.key.toLowerCase() === 'g') { e.preventDefault(); setGridVisible((v) => !v); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const loadDraftVersion = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/versions`);
      if (!r.ok) return;
      const vs = await r.json() as Array<{ id: string }>;
      if (vs.length > 0) setDraftVersionId(vs[vs.length - 1].id);
    } catch (_err) {
      // Draft load non-fatal
    }
  }, [domain]);

  const loadMatrix = useCallback(async (versionId: string): Promise<void> => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/matrix/${encodeURIComponent(versionId)}`);
      if (!r.ok) { setMatrixResult(null); return; }
      const j = await r.json() as MatrixResult;
      setMatrixResult(j);
    } catch (_err) { setMatrixResult(null); }
  }, [domain]);

  useEffect(() => { void loadDraftVersion(); }, [loadDraftVersion]);
  useEffect(() => { if (draftVersionId) void loadMatrix(draftVersionId); }, [draftVersionId, loadMatrix]);

  const handleRunTests = useCallback(async (): Promise<void> => {
    let currentVersionId = draftVersionId;
    if (!currentVersionId) {
      // Check if a draft version exists on the server
      try {
        const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/versions`);
        if (r.ok) {
          const vs = (await r.json()) as Array<{ id: string }>;
          if (vs.length > 0) {
            currentVersionId = vs[vs.length - 1].id;
            setDraftVersionId(currentVersionId);
          }
        }
      } catch (_err) {
        // Versions fetch non-fatal
      }
    }

    if (!currentVersionId) {
      setMatrixError('Please click "💾 Save Profile Draft" in Section 2 above to create a draft version before running validation tests.');
      return;
    }
    if (suiteConfirmed < 3) {
      setMatrixError('Need 3 confirmed representative samples in Section 1 to run validation tests.');
      return;
    }
    setMatrixLoading(true);
    setMatrixError(null);
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/test-matrix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: currentVersionId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMatrixResult(j as MatrixResult);
    } catch (e) {
      setMatrixError(String(e));
    }
    setMatrixLoading(false);
  }, [domain, draftVersionId, suiteConfirmed]);

  const handleRevise = useCallback((field: string): void => {
    const el = document.querySelector(`[data-field="${field}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const [activateState, setActivateState] = useState<{ loading: boolean; blocker: string | null; reviseField: string | null }>({ loading: false, blocker: null, reviseField: null });
  const [versionHistory, setVersionHistory] = useState<Array<{ id: string; version: number; approver: string; reason: string; provenance: { provider: string; model: string }; artifactHashes: string[]; createdAt: string }>>([]);

  const fetchHistory = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/versions`);
      if (!r.ok) return;
      const j = await r.json() as typeof versionHistory;
      setVersionHistory(j);
    } catch (_err) {
      // History fetch non-fatal
    }
  }, [domain]);
  useEffect(() => { void fetchHistory(); }, [fetchHistory]);

  const handleActivate = useCallback(async (): Promise<void> => {
    let currentVersionId = draftVersionId;
    if (!currentVersionId) {
      try {
        const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/versions`);
        if (r.ok) {
          const vs = (await r.json()) as Array<{ id: string }>;
          if (vs.length > 0) {
            currentVersionId = vs[vs.length - 1].id;
            setDraftVersionId(currentVersionId);
          }
        }
      } catch (_err) {
        // Versions fetch non-fatal
      }
    }
    if (!currentVersionId) {
      setActivateState({ loading: false, blocker: 'Please click "💾 Save Profile Draft" in Section 2 to create a draft version before activating.', reviseField: null });
      return;
    }
    setActivateState({ loading: true, blocker: null, reviseField: null });
    try {
      if (!matrixResult || matrixResult.draftVersion !== currentVersionId) {
        const tr = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/test-matrix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versionId: currentVersionId }),
        });
        if (tr.ok) {
          const tm = (await tr.json()) as MatrixResult;
          setMatrixResult(tm);
        }
      }
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: currentVersionId }),
      });
      const j = await r.json() as { allowed?: boolean; blockReason?: string; reviseAction?: string; reason?: string };
      if (!r.ok || !j.allowed) {
        const field = j.reviseAction?.match(/Revise (\w+)/)?.[1] ?? null;
        setActivateState({ loading: false, blocker: j.blockReason ?? j.reason ?? 'Activation blocked', reviseField: field });
        if (field) handleRevise(field);
        return;
      }
      setActivateState({ loading: false, blocker: null, reviseField: null });
      await fetchState();
      await fetchHistory();
    } catch (e) { setActivateState({ loading: false, blocker: String(e), reviseField: null }); }
  }, [domain, draftVersionId, matrixResult, handleRevise]);

  const handleCaptureUrl = useCallback(async (url: string): Promise<void> => {
    setCaptureStatus(`Capturing ${url}…`);
    try {
      const cap = await fetch('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, runtime: 'rendered' }) });
      const j = await cap.json() as { ok: boolean; dom?: string; screenshotBase64?: string; runtime?: string; hash?: string; capturedAt?: string; error?: string };
      if (!cap.ok || !j.ok || !j.dom) { setCaptureStatus(j.error ?? 'Capture failed'); return; }
      const artifact: CaptureArtifact = { dom: j.dom, screenshotBase64: j.screenshotBase64 ?? '', runtime: j.runtime ?? 'rendered', hash: j.hash ?? '', capturedAt: j.capturedAt ?? new Date().toISOString(), url };
      setCaptureArtifact(artifact);
      setCaptureStatus(null);
    } catch (e) { setCaptureStatus(String(e)); }
  }, []);

  // Auto-capture the first confirmed suite sample when suite is loaded and no capture is active
  useEffect(() => {
    if (!captureArtifact && suiteResp?.suite && suiteResp.suite.length > 0) {
      void handleCaptureUrl(suiteResp.suite[0]);
    }
  }, [captureArtifact, suiteResp?.suite, handleCaptureUrl]);

  const _handlePick = useCallback(async (url: string): Promise<void> => {
    setCaptureStatus(`Adding ${url} to suite…`);
    try {
      const suite = suiteResp?.suite ?? [];
      const nextSuite = suite.includes(url) ? suite : [...suite, url].slice(0, 10);
      const put = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: nextSuite, actor: 'operator' }),
      });
      if (!put.ok) { setCaptureStatus(`Suite add failed: ${await put.text()}`); return; }
      await fetchSuite();
    } catch (e) { setCaptureStatus(String(e)); return; }
    await handleCaptureUrl(url);
  }, [domain, suiteResp, fetchSuite, handleCaptureUrl]);

  const showMaraBand = !state || (!state.activeVersion && suiteConfirmed < 3);

  return (
    <>
      <div className={`ws-grid-toggle ${gridVisible ? 'is-visible' : ''}`} aria-hidden="true" />
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '20px 24px 60px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Full-width header banner */}
        <div>
          {loadError ? (
            <div
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontFamily: fonts.body,
                fontSize: '0.875rem',
                color: colors.signetBurgundy,
                background: colors.whiteSurface,
                border: `1px solid ${colors.signetBurgundy}`,
                borderLeft: `4px solid ${colors.signetBurgundy}`,
                borderRadius: rounded.lg,
                padding: '12px 16px',
              }}
            >
              <span>Could not load profile state: {loadError}</span>
              <button
                type="button"
                onClick={() => void fetchState()}
                style={{
                  marginLeft: 'auto',
                  background: colors.signetBurgundy,
                  color: colors.feedBagCream,
                  border: 'none',
                  borderRadius: rounded.sm,
                  padding: '6px 14px',
                  fontFamily: fonts.body,
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Retry
              </button>
            </div>
          ) : state ? (
            <ProfileWorkspaceHeader state={state} />
          ) : (
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: '0.875rem',
                color: colors.mulchBrown,
                padding: 16,
                background: colors.whiteSurface,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.lg,
              }}
            >
              Loading {domain}…
            </div>
          )}

          {showMaraBand && (
            <div
              style={{
                marginTop: 12,
                background: colors.feedBagCream,
                border: `1px solid ${colors.cardBorder}`,
                borderTop: `3px solid ${colors.cornerCalloutGold}`,
                borderRadius: rounded.lg,
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontFamily: fonts.body,
                fontSize: '0.875rem',
                color: colors.ledgerCharcoal,
                lineHeight: 1.5,
              }}
            >
              <span style={{ fontWeight: 700, color: colors.uniformGreen, whiteSpace: 'nowrap' }}>
                Onboarding Guide:
              </span>
              <span>
                Found URLs → confirm 3 representative product pages → Build CSS selectors → Run production test suite → Activate profile.
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  color: colors.mulchBrown,
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.cardBorder}`,
                  padding: '3px 8px',
                  borderRadius: rounded.sm,
                  whiteSpace: 'nowrap',
                }}
              >
                Confirmed: <strong>{suiteConfirmed}/3</strong>
              </span>
            </div>
          )}
        </div>

        {/* Full-width Horizontal Readiness Gate */}
        <ReadinessRail state={readiness} mode="horizontal" />

        {/* Full-Width Workspace Flow */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {captureStatus && (
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: 12,
                fontWeight: 600,
                color: colors.uniformGreen,
                background: colors.feedBagCream,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                padding: '10px 14px',
              }}
              role="status"
            >
              {captureStatus}
            </div>
          )}

          <SuitePanel
            domain={domain}
            suiteResp={suiteResp}
            onRefresh={fetchSuite}
            activeUrl={captureArtifact?.url}
            onSelectActive={handleCaptureUrl}
          />

          {/* Section 2: Output-First Workspace Flow */}
          <OutputFirstWorkspace
            domain={domain}
            initialUrl={captureArtifact?.url}
            seedUrl={seedUrl}
            seedFailureReason={seedFailureReason}
            suiteUrls={suiteResp?.suite ?? []}
            draftVersionId={draftVersionId}
            onSelectOnPage={(field) => {
              handleRevise(field);
              setBuilderCollapsed(false);
            }}
            onActivateProfile={handleActivate}
            onProfileUpdated={(versionId) => {
              setDraftVersionId(versionId);
              void loadMatrix(versionId);
            }}
          />

          {/* Section 3: Selectors & Profile Builder (Repair Controls) */}
          <div
            data-workspace
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.lg,
              boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                background: colors.uniformGreen,
                color: colors.feedBagCream,
                padding: '12px 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setBuilderCollapsed((v) => !v)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  2. Selectors & Profile Builder
                </span>
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    background: captureArtifact ? colors.seedlingGreen : colors.shadowPine,
                    color: colors.feedBagCream,
                    padding: '2px 8px',
                    borderRadius: rounded.sm,
                    border: '1px solid rgba(250,249,242,0.2)',
                  }}
                >
                  {captureArtifact ? 'Active Canvas Loaded' : 'Visual Selector'}
                </span>
              </div>

              <span
                style={{
                  fontFamily: fonts.body,
                  fontSize: 11,
                  fontWeight: 700,
                  color: colors.feedBagCream,
                  background: 'rgba(250,249,242,0.15)',
                  padding: '3px 8px',
                  borderRadius: rounded.sm,
                }}
              >
                {builderCollapsed ? '▼ Expand' : '▲ Collapse'}
              </span>
            </div>

            {!builderCollapsed && (
              <div style={{ padding: 16 }}>
                <ProfileBuilder
                  key={domain}
                  mode="inline"
                  initialDomain={domain}
                  initialProductUrl={captureArtifact?.url ?? undefined}
                  initialCapture={captureArtifact}
                  validationSamples={suiteResp?.suite ?? []}
                  onSaved={(data: any) => {
                    if (data?.id) {
                      setDraftVersionId(data.id);
                      void loadMatrix(data.id);
                    }
                    void loadDraftVersion();
                    setValidationCollapsed(false);
                  }}
                  onCancel={() => {}}
                />
              </div>
            )}
          </div>

          {/* Section 3: Validation & Approval */}
          <div
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.lg,
              boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                background: colors.uniformGreen,
                color: colors.feedBagCream,
                padding: '12px 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setValidationCollapsed((v) => !v)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  3. Validation & Approval (Final Step)
                </span>
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    background: approvedSamples.size >= 3 ? colors.seedlingGreen : colors.shadowPine,
                    color: colors.feedBagCream,
                    padding: '2px 8px',
                    borderRadius: rounded.sm,
                    border: '1px solid rgba(250,249,242,0.2)',
                  }}
                >
                  {approvedSamples.size}/3 Approved
                </span>
              </div>

              <span
                style={{
                  fontFamily: fonts.body,
                  fontSize: 11,
                  fontWeight: 700,
                  color: colors.feedBagCream,
                  background: 'rgba(250,249,242,0.15)',
                  padding: '3px 8px',
                  borderRadius: rounded.sm,
                }}
              >
                {validationCollapsed ? '▼ Expand' : '▲ Collapse'}
              </span>
            </div>

            {!validationCollapsed && (
              <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <TestMatrix
                  result={matrixResult}
                  loading={matrixLoading}
                  error={matrixError}
                  suiteUrls={suiteResp?.suite ?? []}
                  approvedSamples={approvedSamples}
                  onToggleApproveSample={handleToggleApproveSample}
                  onApproveAll={handleApproveAll}
                  onRevise={handleRevise}
                  onSelectCell={setSelectedCell}
                  onRunTests={handleRunTests}
                />

                {/* Activation Summary Bar */}
                {(() => {
                  const isReadyToActivate = Boolean(draftVersionId && allSamplesApproved);
                  return (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '14px 18px',
                        background: colors.whiteSurface,
                        border: `1px solid ${isReadyToActivate ? colors.seedlingGreen : colors.cardBorder}`,
                        borderRadius: rounded.lg,
                        boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: isReadyToActivate ? colors.seedlingGreen : colors.cornerCalloutGold,
                          }}
                        />
                        <div style={{ fontFamily: fonts.body, fontSize: 13, fontWeight: 700, color: isReadyToActivate ? colors.uniformGreen : colors.ledgerCharcoal }}>
                          {!allSamplesApproved
                            ? `Approve all 3 sample cards above to activate profile (${approvedSamples.size}/3 approved)`
                            : isReadyToActivate
                            ? 'Ready to activate profile (3/3 samples approved)'
                            : `Status: ${readiness.overall}`}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleActivate()}
                        disabled={activateState.loading || !isReadyToActivate}
                        style={{
                          padding: '9px 22px',
                          borderRadius: rounded.sm,
                          border: 'none',
                          background: isReadyToActivate ? colors.uniformGreen : colors.feedBagCream,
                          color: isReadyToActivate ? colors.feedBagCream : colors.mulchBrown,
                          fontFamily: fonts.body,
                          fontSize: 13,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          cursor: isReadyToActivate ? 'pointer' : 'not-allowed',
                          opacity: activateState.loading ? 0.7 : 1,
                          boxShadow: isReadyToActivate ? '0 1px 3px rgba(20,83,45,0.2)' : 'none',
                        }}
                      >
                        {activateState.loading ? 'Activating…' : 'Activate Profile'}
                      </button>
                    </div>
                  );
                })()}

                {activateState.blocker && (
                  <div
                    role="alert"
                    style={{
                      padding: '10px 14px',
                      borderRadius: rounded.sm,
                      border: `1px solid ${colors.signetBurgundy}`,
                      background: 'rgba(118, 12, 25, 0.08)',
                      color: colors.signetBurgundy,
                      fontFamily: fonts.body,
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <span>{activateState.blocker}</span>
                    {activateState.reviseField && (
                      <button
                        type="button"
                        onClick={() => handleRevise(activateState.reviseField!)}
                        style={{
                          marginLeft: 'auto',
                          padding: '4px 10px',
                          borderRadius: rounded.sm,
                          border: `1px solid ${colors.signetBurgundy}`,
                          background: colors.whiteSurface,
                          color: colors.signetBurgundy,
                          fontFamily: fonts.body,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Revise {activateState.reviseField}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <details open style={{ background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg, padding: 14 }}>
            <summary style={{ cursor: 'pointer', fontFamily: fonts.display, fontSize: '1rem', fontWeight: 700, color: colors.ledgerCharcoal }}>
              History — {versionHistory.length} immutable versions
            </summary>
            <div style={{ marginTop: 12 }}>
              <HistoryShell versions={versionHistory} />
            </div>
          </details>

          <details style={{ background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg, padding: 14 }}>
            <summary style={{ cursor: 'pointer', fontFamily: fonts.display, fontSize: '1rem', fontWeight: 700, color: colors.ledgerCharcoal }}>
              Evidence & Capture Inspector
            </summary>
            <div style={{ marginTop: 12 }}>
              {(() => {
                const cell = (() => {
                  if (!selectedCell || !matrixResult) return null;
                  for (const r of matrixResult.rows) if (r.sampleId === selectedCell.sampleId) for (const c of r.cells) if (c.field === selectedCell.field) return c;
                  return null;
                })();
                return <EvidenceRail capture={captureArtifact} matrixCell={cell} />;
              })()}
            </div>
          </details>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            {returnPath ? (
              <a
                href={returnPath}
                onClick={(e) => { e.preventDefault(); window.history.pushState(null, '', returnPath); window.dispatchEvent(new PopStateEvent('popstate')); }}
                style={{ fontFamily: fonts.body, fontSize: '0.875rem', fontWeight: 700, color: colors.uniformGreen, textDecoration: 'none' }}
              >
                ← Back
              </a>
            ) : (
              <a
                href="/?view=settings"
                onClick={(e) => { e.preventDefault(); window.history.pushState(null, '', '/?view=settings'); window.dispatchEvent(new PopStateEvent('popstate')); }}
                style={{ fontFamily: fonts.body, fontSize: '0.875rem', fontWeight: 700, color: colors.uniformGreen, textDecoration: 'none' }}
              >
                ← Back to Settings
              </a>
            )}

            <div style={{ fontSize: 11, color: colors.mulchBrown, fontFamily: fonts.mono }}>
              Path: {getProfileWorkspacePath(domain, returnPath ?? undefined)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export { getProfileWorkspacePath };

