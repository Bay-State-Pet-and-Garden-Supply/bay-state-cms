import React, { useState, useEffect } from 'react';
import { listSyncJobs, getSyncJobDetail, type SyncJob, type SyncJobDetail } from '../api';
import { colors, fonts, rounded, themeStyles } from '../theme';
import { ViewHeader } from './common/ViewHeader';

export function SyncJobsView() {
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<SyncJobDetail | null>(null);
  const [error, setError] = useState('');

  const fetchJobs = async () => {
    try {
      const res = await listSyncJobs();
      setJobs(res.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { fetchJobs(); }, []);

  const handleSelect = async (id: string) => {
    try {
      const res = await getSyncJobDetail(id);
      setSelectedJob(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const getStatusBadge = (s: string) => {
    switch (s.toLowerCase()) {
      case 'succeeded':
        return <span className="badge badge-primary" style={{ backgroundColor: colors.seedlingGreen }}>Complete</span>;
      case 'failed':
        return <span className="badge badge-featured">Needs attention</span>;
      case 'running':
        return <span className="badge badge-sale">In progress</span>;
      default:
        return <span className="badge badge-preorder">{s}</span>;
    }
  };

  const kindLabel = (k: string): string => {
    const labels: Record<string, string> = {
      push_publish: 'Store update',
      upload_only: 'Catalog file sent',
      pull_drift: 'Check for store changes',
      full_reconcile: 'Match catalog with store',
      bootstrap: 'Initial catalog import',
    };
    return labels[k] ?? k;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1380, margin: '0 auto', fontFamily: fonts.body }}>
      <ViewHeader
        title="Store Updates"
        description="See when product changes were sent to your store and whether they worked."
      />

      {error && (
        <div style={{ color: colors.signetBurgundy, padding: '12px 16px', backgroundColor: '#fee2e2', borderRadius: rounded.md, border: `1px solid ${colors.signetBurgundy}`, marginBottom: 20, fontSize: 13, fontWeight: 600 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 24 }}>
        {/* Sync Job List */}
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {jobs.length === 0 && (
              <div style={{ ...themeStyles.card, padding: 32, textAlign: 'center', color: colors.mulchBrown, fontSize: 13 }}>
                No store updates yet.
              </div>
            )}
            {jobs.map(job => {
              const isSelected = selectedJob?.job?.id === job.id;
              return (
                <div
                  key={job.id}
                  style={{
                    padding: '14px 18px',
                    margin: '2px 0',
                    borderRadius: rounded.md,
                    border: `1px solid ${isSelected ? colors.uniformGreen : colors.cardBorder}`,
                    backgroundColor: isSelected ? colors.feedBagCream : colors.whiteSurface,
                    boxShadow: isSelected ? '0 2px 4px rgba(20, 83, 45, 0.08)' : '0 1px 2px rgba(33, 20, 20, 0.03)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => handleSelect(job.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <strong style={{ fontSize: 14, color: colors.ledgerCharcoal }}>{kindLabel(job.kind)}</strong>
                    {getStatusBadge(job.status)}
                  </div>
                  <div style={{ fontSize: 12, color: colors.mulchBrown, display: 'flex', gap: 8 }}>
                    <span>Started: {job.startedAt?.slice(0, 19).replace('T', ' ') ?? '—'}</span>
                    <span>·</span>
                    <span>{job.productCount} products</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sync Job Detail Card & Event Logs */}
        <div>
          {selectedJob ? (
            <div style={{ ...themeStyles.card, padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${colors.cardBorder}` }}>
                <div>
                  <h2 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700, color: colors.ledgerCharcoal, margin: '0 0 4px 0' }}>
                    {kindLabel(selectedJob.job.kind)}
                  </h2>
                </div>
                {getStatusBadge(selectedJob.job.status)}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, backgroundColor: colors.feedBagCream, padding: 14, borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' }}>Started</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: colors.ledgerCharcoal, fontFamily: fonts.mono, marginTop: 2 }}>
                    {selectedJob.job.startedAt?.slice(0, 19).replace('T', ' ') ?? '—'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' }}>Completed</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: colors.ledgerCharcoal, fontFamily: fonts.mono, marginTop: 2 }}>
                    {selectedJob.job.completedAt?.slice(0, 19).replace('T', ' ') ?? '—'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' }}>Products updated</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: colors.ledgerCharcoal, fontFamily: fonts.mono, marginTop: 2 }}>
                    {selectedJob.job.productCount} products
                  </div>
                </div>
              </div>

              {selectedJob.job.errorSummary && (
                <div style={{ padding: '12px 14px', backgroundColor: '#fee2e2', border: `1px solid ${colors.signetBurgundy}`, borderRadius: rounded.md, color: colors.signetBurgundy, fontSize: 13, marginBottom: 20, fontWeight: 600 }}>
                  What needs attention: {selectedJob.job.errorSummary}
                </div>
              )}

              <h3 style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: 700, color: colors.ledgerCharcoal, margin: '0 0 12px 0' }}>
                What happened
              </h3>

              {selectedJob.events.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: colors.mulchBrown, fontSize: 13 }}>
                  No update details are available.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 8 }}>
                  {selectedJob.events.map(evt => (
                    <div 
                      key={evt.id} 
                      style={{ 
                        padding: '10px 14px', 
                        margin: '2px 0', 
                        backgroundColor: colors.feedBagCream, 
                        border: `1px solid ${colors.cardBorder}`, 
                        borderRadius: rounded.md, 
                        display: 'flex', 
                        gap: 12, 
                        alignItems: 'flex-start',
                        fontSize: 13,
                      }}
                    >
                      <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown, width: 65, flexShrink: 0, marginTop: 1 }}>
                        {evt.createdAt.slice(11, 19)}
                      </span>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        padding: '2px 6px',
                        borderRadius: rounded.xs,
                        flexShrink: 0,
                        backgroundColor: evt.level === 'error' ? '#fee2e2' : evt.level === 'warning' ? colors.cornerCalloutGold : evt.level === 'info' ? colors.seedlingGreen : colors.cardBorder,
                        color: evt.level === 'error' ? colors.signetBurgundy : evt.level === 'warning' || evt.level === 'info' ? colors.ledgerCharcoal : colors.mulchBrown,
                      }}>
                        {evt.level === 'error' ? 'Needs attention' : evt.level === 'warning' ? 'Please review' : evt.level === 'info' ? 'Update' : evt.level}
                      </span>
                      <span style={{ flex: 1, color: colors.ledgerCharcoal, lineHeight: 1.4, wordBreak: 'break-word' }}>
                        {evt.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ ...themeStyles.card, padding: 48, textAlign: 'center', color: colors.mulchBrown, fontSize: 14 }}>
              Select a store update to see what happened.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
