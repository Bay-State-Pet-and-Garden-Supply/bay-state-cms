import React, { useState, useEffect, useCallback } from 'react';
import {
  getCatalogClassification,
  runCatalogClassification,
  applyCatalogClassification,
  type CatalogClassificationDetail,
} from '../api';
import { getClassificationReadiness } from '../onboarding-api';
import {
  readinessViewFromReport,
  shouldBlockRun,
  type ReadinessView,
} from '../classification-readiness-view';
import { deriveEvidenceView } from '../classification-evidence-view';
import { EvidenceCitationList } from './pipeline-drawer/EvidenceCitationList';
import { colors } from '../theme';

const buttonBase: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const primaryButton: React.CSSProperties = {
  ...buttonBase,
  background: colors.uniformGreen,
  color: colors.feedBagCream,
};

const sectionStyle: React.CSSProperties = {
  marginTop: 32,
  padding: 24,
  border: '1px solid #e2e8f0',
  borderRadius: 16,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: '#0f172a',
  marginBottom: 4,
};

interface Props {
  sku: string;
  onDraftCreated: () => void;
}

export function CatalogClassificationPanel({ sku, onDraftCreated }: Props) {
  const [detail, setDetail] = useState<CatalogClassificationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [changeSetId, setChangeSetId] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ReadinessView | null>(null);

  const loadReadiness = useCallback(async () => {
    try {
      const result = await getClassificationReadiness();
      setReadiness(readinessViewFromReport(result.readiness));
    } catch {
      // Conservative: an unreadable report must never read as ready.
      setReadiness(readinessViewFromReport(null));
    }
  }, []);

  useEffect(() => {
    loadReadiness();
  }, [loadReadiness]);

  const loadClassification = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await getCatalogClassification(sku);
      setDetail(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sku]);

  useEffect(() => {
    loadClassification();
  }, [loadClassification]);

  const handleRun = async () => {
    setRunning(true);
    setError('');
    setMessage('');
    try {
      await runCatalogClassification(sku);
      setMessage('Classification run completed.');
      await loadClassification();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const handleApply = async () => {
    if (!detail?.run) return;
    setApplying(true);
    setError('');
    setMessage('');
    try {
      const result = await applyCatalogClassification(sku, detail.run.id);
      setChangeSetId(result.changeSetId);
      setMessage(`Created update draft in change set ${result.changeSetId.slice(0, 8)}. ${result.appliedFields.length} field(s), ${result.appliedPages.length} page(s) applied${(result.removedPages?.length ?? 0) > 0 ? `, ${result.removedPages.length} page(s) removed` : ''}.`);
      if (result.skipped.length > 0) {
        setMessage(prev => prev + ` ${result.skipped.length} skipped.`);
      }
      onDraftCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  };

  const run = detail?.run;
  const hasActiveRun = run && run.status !== 'failed';
  const canDecide = run && (run.status === 'completed' || run.status === 'completed_with_abstentions');
  const pendingProposals = (detail?.proposals || []).filter(p =>
    p.proposalType !== 'reviewable_abstention'
  );
  const canApply = Boolean(canDecide && pendingProposals.length > 0);

  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitle}>🧠 Classification</h3>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
        Run AI-powered product classification to propose attributes, category pages, and product types.
      </p>

      {/* Run status — conservative while readiness is unknown: buttons stay
          disabled and a loading note is shown until a real report arrives. */}
      {!readiness && (
        <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#64748b' }}>
          Checking classification readiness…
        </div>
      )}
      {readiness && !readiness.isReady && (
        <div style={{ marginBottom: 16, padding: 12, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, fontSize: 13 }}>
          <div style={{ color: '#9a3412', fontWeight: 600 }}>⚠ Classification is not ready to run</div>
          <div style={{ color: '#7c2d12', marginTop: 4 }}>{readiness.summary.join(' ')}</div>
          {readiness.findingCodes.length > 0 && (
            <div style={{ color: '#7c2d12', marginTop: 4 }}>
              Findings: {readiness.findingCodes.join(', ')}
            </div>
          )}
          {readiness.capabilities.page.reason && (
            <div style={{ color: '#7c2d12', marginTop: 2 }}>Category Pages: {readiness.capabilities.page.reason}</div>
          )}
          <a href="/?view=onboarding&settingsTab=curation" style={{ color: '#9a3412', fontWeight: 600, marginTop: 6, display: 'inline-block' }}>
            Open Curation Targets settings →
          </a>
        </div>
      )}

      {/* Run status */}
      {run && (
        <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', borderRadius: 8, fontSize: 13 }}>
          <div><strong>Status:</strong> {run.status}</div>
          {run.completedAt && <div><strong>Completed:</strong> {new Date(run.completedAt).toLocaleString()}</div>}
          {run.errorMessage && <div style={{ color: '#dc2626' }}><strong>Error:</strong> {run.errorMessage}</div>}
          {detail?.sourceDrift && (
            <div style={{ color: '#d97706', marginTop: 4 }}>⚠ Product has changed since classification was run.</div>
          )}
          {detail?.configDrift && (
            <div style={{ color: '#d97706', marginTop: 4 }}>⚠ Classification config has changed since run.</div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          style={primaryButton}
          onClick={handleRun}
          disabled={running || readiness === null || shouldBlockRun(readiness)}
          title={readiness === null ? 'Checking classification readiness…' : (shouldBlockRun(readiness) ? 'Classification is not ready to run' : undefined)}
        >
          {running ? 'Running...' : hasActiveRun ? 'Rerun' : 'Run Classification'}
        </button>
      </div>

      {/* Error / Message */}
      {error && <div style={{ color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0', fontSize: 13 }}>{error}</div>}
      {message && <div style={{ color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0', fontSize: 13 }}>{message}</div>}
      {changeSetId && (
        <div style={{ color: '#2563eb', padding: '8px 12px', background: '#eff6ff', borderRadius: 4, margin: '8px 0', fontSize: 13 }}>
          Update draft created in change set <strong>{changeSetId.slice(0, 8)}</strong>. Use the Change Set page to review and approve.
        </div>
      )}

      {/* Proposals */}
      {canDecide && (pendingProposals.length > 0 || (detail?.proposals || []).some(p => p.proposalType === 'reviewable_abstention')) && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>Proposals ({pendingProposals.length})</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingProposals.map(p => (
              <div
                key={p.id}
                style={{
                  padding: 12,
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <strong style={{ color: '#0f172a' }}>{p.proposalType.replace(/_/g, ' ')}</strong>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {(p.hasRevisedValue && (p as { revisedValue?: unknown }).revisedValue === null) && (
                      <span title="Reviewed removal: accepting clears this value (the before value is shown below)" style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: '#fee2e2', color: '#991b1b' }}>
                        Removal
                      </span>
                    )}
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      background: p.confidence > 0.7 ? '#dcfce7' : p.confidence > 0.4 ? '#fef9c3' : '#fee2e2',
                      color: p.confidence > 0.7 ? '#166534' : p.confidence > 0.4 ? '#92400e' : '#991b1b',
                    }}>
                      {Math.round(p.confidence * 100)}%
                    </span>
                  </span>
                </div>
                <div style={{ color: '#334155', marginBottom: 4 }}>
                  <strong>Target:</strong> {(p.hasRevisedTargetId ? p.revisedTargetId : p.targetId) || '-'}
                </div>
                <div style={{ color: '#475569', fontSize: 12, marginBottom: 8, fontFamily: 'monospace', wordBreak: 'break-word' }}>
                  {(p.hasRevisedValue && (p as { revisedValue?: unknown }).revisedValue === null)
                    ? (<><strong>Before:</strong> {typeof p.proposedValue === 'object' ? JSON.stringify(p.proposedValue) : String(p.proposedValue ?? '-')} <strong>→ After:</strong> (cleared)</>)
                    : (<><strong>Value:</strong> {(() => {
                      const value = p.hasRevisedValue ? p.revisedValue : p.proposedValue;
                      return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '-');
                    })()}</>)}
                </div>
                {(() => {
                  const liveDecision = (detail?.decisions || []).find(
                    d => d.proposalId === p.id,
                  );
                  const view = deriveEvidenceView({
                    proposal: p as unknown as import('../../shared/schemas/classification').ClassificationProposal,
                    evidence: (detail?.evidence || []) as unknown as import('../../shared/schemas/classification').ClassificationEvidence[],
                    decision: (liveDecision ?? null) as import('../../shared/schemas/classification').ClassificationProposalDecision | null,
                  });
                  return <EvidenceCitationList rows={view.rows} selectedIds={view.citation.citedIds} showUncited isUncited={view.citation.isUncited} />;
                })()}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {canApply && (
              <button
                style={{ ...primaryButton, background: '#059669' }}
                onClick={handleApply}
                disabled={applying || detail?.sourceDrift || detail?.configDrift}
              >
                {applying ? 'Applying...' : 'Create Update Draft'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Abstentions (informational — these stages had nothing to propose) */}
      {canDecide && (detail?.proposals || []).filter(p => p.proposalType === 'reviewable_abstention').length > 0 && (
        <div style={{ marginTop: 16, padding: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
          <strong>Stage Abstentions</strong> — these stages could not produce proposals:
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {(detail?.proposals || []).filter(p => p.proposalType === 'reviewable_abstention').map(p => (
              <li key={p.id}>
                <strong>{String(p.targetId || 'unknown').replace(/_/g, ' ')}</strong>
                {p.proposedValue && typeof p.proposedValue === 'object' && (p.proposedValue as any).reason
                  ? ` — ${(p.proposedValue as any).reason}`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* No run state */}
      {!run && !loading && (
        <div style={{ color: '#64748b', fontSize: 13, fontStyle: 'italic' }}>
          No classification run yet. Click "Run Classification" to start.
        </div>
      )}

      {loading && <div style={{ color: '#64748b', fontSize: 13 }}>Loading...</div>}
    </div>
  );
}
