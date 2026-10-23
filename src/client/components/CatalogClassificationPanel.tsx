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
import { CanonicalClassificationReadiness } from './CanonicalClassificationReadiness';
import { colors } from '../theme';
import { ClassificationDraftProjectionCard } from './ClassificationDraftProjectionCard';

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

function displayTargetLabel(targetId: string | null): string | null {
  if (!targetId) return null;
  if (/^ProductField\d+$/i.test(targetId)) return 'Product detail';
  return targetId.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function suggestionLabel(type: string): string {
  switch (type) {
    case 'primary_product_type': return 'Product type';
    case 'product_classification': return 'Category and product type';
    case 'category_page': return 'Store category';
    case 'field_assignment': return 'Product detail';
    case 'configuration_gap': return 'Product setup';
    case 'reviewable_abstention': return 'No suggestion';
    default: return 'Product detail';
  }
}

function displaySuggestionValue(value: unknown): string {
  if (value == null) return 'Not provided';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(displaySuggestionValue).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${displayTargetLabel(key) ?? 'Detail'}: ${displaySuggestionValue(entry)}`)
      .join(' · ');
  }
  return 'Not provided';
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'Suggestions ready for review';
    case 'completed_with_abstentions': return 'Some suggestions are ready for review';
    case 'failed': return 'Could not prepare suggestions';
    case 'running':
    case 'pending':
      return 'Preparing suggestions';
    default:
      return 'Suggestions need attention';
  }
}

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
    } catch {
      setError('Could not load product suggestions. Please try again.');
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
      setMessage('Product suggestions are ready for review.');
      await loadClassification();
    } catch {
      setError('Could not prepare product suggestions. Please try again.');
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
      onDraftCreated();
    } catch {
      setError('Could not save these suggestions. Please try again.');
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
      <h3 style={sectionTitle}>Product category and details</h3>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
        Review these suggested product details. Nothing changes until you approve them.
      </p>

      {/* Run status — conservative while readiness is unknown: buttons stay
          disabled and a loading note is shown until a real report arrives. */}
      {!readiness && (
        <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#64748b' }}>
          Getting product suggestions ready...
        </div>
      )}
      {readiness && !readiness.isReady && (
        <div style={{ marginBottom: 16, padding: 12, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, fontSize: 13 }}>
          <div style={{ color: '#9a3412', fontWeight: 600 }}>Product suggestions need setup before they can run.</div>
          <a href="/?view=onboarding&settingsTab=curation" style={{ color: '#9a3412', fontWeight: 600, marginTop: 6, display: 'inline-block' }}>
            Open product suggestion setup →
          </a>
        </div>
      )}

      {/* Run status */}
      {run && (
        <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', borderRadius: 8, fontSize: 13 }}>
          <div><strong>Status:</strong> {runStatusLabel(run.status)}</div>
          {run.completedAt && <div><strong>Prepared:</strong> {new Date(run.completedAt).toLocaleString()}</div>}
          {run.status === 'failed' && <div style={{ color: '#dc2626' }}>Please try again or ask for help.</div>}
          {detail?.sourceDrift && (
            <div style={{ color: '#d97706', marginTop: 4 }}>Product details have changed since these suggestions were prepared.</div>
          )}
          {detail?.configDrift && (
            <div style={{ color: '#d97706', marginTop: 4 }}>Product setup has changed since these suggestions were prepared.</div>
          )}
        </div>
      )}
      {detail?.run && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', color: '#475569', fontSize: 13 }}>More setup details</summary>
          {detail.classificationReadiness && <CanonicalClassificationReadiness result={detail.classificationReadiness} />}
          <ClassificationDraftProjectionCard preview={detail.draftProjection} />
        </details>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          style={primaryButton}
          onClick={handleRun}
          disabled={running || readiness === null || shouldBlockRun(readiness)}
          title={readiness === null ? 'Getting product suggestions ready...' : (shouldBlockRun(readiness) ? 'Product suggestions need setup first' : undefined)}
        >
          {running ? 'Preparing suggestions...' : hasActiveRun ? 'Prepare new suggestions' : 'Suggest product details'}
        </button>
      </div>

      {/* Error / Message */}
      {error && <div style={{ color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0', fontSize: 13 }}>{error}</div>}
      {message && <div style={{ color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0', fontSize: 13 }}>{message}</div>}
      {changeSetId && (
        <div style={{ color: '#2563eb', padding: '8px 12px', background: '#eff6ff', borderRadius: 4, margin: '8px 0', fontSize: 13 }}>
          Suggestions saved for review. They will not update your store until you approve them.
        </div>
      )}

      {/* Proposals */}
      {canDecide && (pendingProposals.length > 0 || (detail?.proposals || []).some(p => p.proposalType === 'reviewable_abstention')) && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>Suggested changes ({pendingProposals.length})</h4>
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
                  <strong style={{ color: '#0f172a' }}>{suggestionLabel(p.proposalType)}</strong>
                </div>
                {p.proposalType === 'field_assignment' && (
                  <div style={{ color: '#334155', marginBottom: 4 }}>
                    <strong>Product detail:</strong> {displayTargetLabel(p.hasRevisedTargetId ? p.revisedTargetId ?? null : p.targetId) ?? 'Product detail'}
                  </div>
                )}
                <div style={{ color: '#475569', fontSize: 13, marginBottom: 8, wordBreak: 'break-word' }}>
                  {(p.hasRevisedValue && (p as { revisedValue?: unknown }).revisedValue === null)
                    ? <><strong>Current detail:</strong> {displaySuggestionValue(p.proposedValue)}. This suggestion removes it.</>
                    : <><strong>Suggested value:</strong> {displaySuggestionValue(p.hasRevisedValue ? p.revisedValue : p.proposedValue)}</>}
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
                {applying ? 'Saving suggestions...' : 'Save suggestions for review'}
              </button>
            )}
          </div>
        </div>
      )}

      {canDecide && (detail?.proposals || []).some(p => p.proposalType === 'reviewable_abstention') && (
        <div style={{ marginTop: 16, padding: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
          Some product details could not be suggested. You can fill them in above.
        </div>
      )}

      {/* No run state */}
      {!run && !loading && (
        <div style={{ color: '#64748b', fontSize: 13, fontStyle: 'italic' }}>
          No suggestions yet. Choose “Suggest product details” to begin.
        </div>
      )}

      {loading && <div style={{ color: '#64748b', fontSize: 13 }}>Getting product suggestions...</div>}
    </div>
  );
}
