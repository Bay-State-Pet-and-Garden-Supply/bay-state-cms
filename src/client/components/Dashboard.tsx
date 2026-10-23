import React, { useState, useEffect } from 'react';
import { getDashboardStats, checkDrift, type DashboardStats } from '../api';
import { colors, fonts, rounded, themeStyles } from '../theme';
import { ViewHeader } from './common/ViewHeader';

interface DashboardProps {
  onNavigate: (view: 'setup' | 'catalog' | 'changesets' | 'drift' | 'syncjobs' | 'health' | 'onboarding') => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingDrift, setCheckingDrift] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await getDashboardStats();
      setStats(data);
      setError(null);
    } catch {
      setError('We could not load your store overview. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);


  const handleDriftCheck = async () => {
    setCheckingDrift(true);
    setMessage(null);
    try {
      const result = await checkDrift();
      if (result.success) {
        setMessage(`Check complete. ${result.driftCount} ${result.driftCount === 1 ? 'product is' : 'products are'} different in your store.`);
        await fetchStats();
      } else {
        setError('We could not finish checking your store. Please try again.');
      }
    } catch {
      setError('We could not check your store. Please try again.');
    } finally {
      setCheckingDrift(false);
    }
  };

  const formatTimeAgo = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
      
      if (seconds < 60) return 'Just now';
      const minutes = Math.floor(seconds / 60);
      if (minutes === 1) return '1 minute ago';
      if (minutes < 60) return `${minutes} minutes ago`;
      const hours = Math.floor(minutes / 60);
      if (hours === 1) return '1 hour ago';
      if (hours < 24) return `${hours} hours ago`;
      const days = Math.floor(hours / 24);
      if (days === 1) return 'Yesterday';
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return isoString;
    }
  };

  const getJobStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case 'succeeded':
        return <span className="badge badge-primary" style={{ backgroundColor: colors.seedlingGreen }}>Complete</span>;
      case 'failed':
        return <span className="badge badge-featured">Needs attention</span>;
      case 'running':
        return <span className="badge badge-sale">In progress</span>;
      default:
        return <span className="badge badge-preorder">Please review</span>;
    }
  };

  if (loading && !stats) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 24px', fontFamily: fonts.body, color: colors.ledgerCharcoal }}>
        <div style={{ display: 'inline-block', width: 36, height: 36, border: `4px solid ${colors.cardBorder}`, borderTopColor: colors.uniformGreen, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <p style={{ marginTop: 16, fontWeight: 600, fontSize: 14 }}>Loading your store overview...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div style={{ padding: 32, background: colors.whiteSurface, borderRadius: rounded.lg, border: `1px solid ${colors.signetBurgundy}`, margin: 24 }}>
        <h2 style={{ color: colors.signetBurgundy, fontFamily: fonts.display, fontSize: 18, margin: '0 0 8px 0' }}>Overview unavailable</h2>
        <p style={{ color: colors.ledgerCharcoal, margin: '0 0 16px 0', fontSize: 14 }}>We could not load your store overview. Please try again.</p>
        <button className="btn btn-primary" onClick={fetchStats}>Try again</button>
      </div>
    );
  }

  const { metrics, connection, recentSyncJobs } = stats!;
  const total = metrics.totalProducts;
  const synced = metrics.syncedProducts;
  const drifted = metrics.driftedProducts;

  return (
    <div style={{ padding: '24px', maxWidth: 1380, margin: '0 auto', fontFamily: fonts.body }}>
      {/* Header Section */}
      <ViewHeader
        title="Store overview"
        description="See how many products are in your catalog, what needs attention, and recent updates to your store."
        actions={
          <>
            <button 
              className="btn btn-secondary" 
              onClick={handleDriftCheck}
              disabled={checkingDrift || !connection}
              title={!connection ? "Connect your store before checking for changes." : "Check whether your store has changed."}
            >
              {checkingDrift ? 'Checking your store...' : 'Check for store changes'}
            </button>
            <button className="btn btn-primary" onClick={() => onNavigate('catalog')}>
              Review products
            </button>
          </>
        }
      />

      {/* Action Messages */}
      {message && (
        <div style={{ backgroundColor: colors.feedBagCream, border: `1px solid ${colors.seedlingGreen}`, padding: '12px 16px', borderRadius: rounded.md, color: colors.uniformGreen, fontSize: 13, fontWeight: 600, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{message}</span>
          <button style={{ background: 'none', border: 'none', color: colors.uniformGreen, cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setMessage(null)}>✕</button>
        </div>
      )}

      {error && (
        <div style={{ backgroundColor: '#fee2e2', border: `1px solid ${colors.signetBurgundy}`, padding: '12px 16px', borderRadius: rounded.md, color: colors.signetBurgundy, fontSize: 13, fontWeight: 600, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button style={{ background: 'none', border: 'none', color: colors.signetBurgundy, cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <section style={{ ...themeStyles.card, padding: '20px 24px', marginBottom: 24 }}>
        <div style={{ marginBottom: 16, borderBottom: `1px solid ${colors.cardBorder}`, paddingBottom: 12 }}>
          <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: colors.ledgerCharcoal }}>
            Catalog status
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: colors.mulchBrown }}>
            See what is ready and what needs your attention.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <button type="button" onClick={() => onNavigate('catalog')} style={{ textAlign: 'left', cursor: 'pointer', padding: 14, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: colors.mulchBrown, marginBottom: 6 }}>Products in your catalog</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: colors.ledgerCharcoal }}>{total}</div>
            <div style={{ fontSize: 12, color: colors.seedlingGreen, marginTop: 4 }}>{synced} {synced === 1 ? 'product matches' : 'products match'} your store</div>
          </button>

          <button type="button" onClick={() => onNavigate('drift')} style={{ textAlign: 'left', cursor: 'pointer', padding: 14, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: colors.mulchBrown, marginBottom: 6 }}>Different from your store</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: drifted > 0 ? colors.signetBurgundy : colors.ledgerCharcoal }}>{drifted}</div>
            <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4 }}>Review products that do not match.</div>
          </button>

          <button type="button" onClick={() => onNavigate('changesets')} style={{ textAlign: 'left', cursor: 'pointer', padding: 14, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: colors.mulchBrown, marginBottom: 6 }}>Changes waiting for review</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: colors.ledgerCharcoal }}>{metrics.draftChangeSets}</div>
            <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4 }}>Review before updating your store.</div>
          </button>

          <button type="button" onClick={() => onNavigate('health')} style={{ textAlign: 'left', cursor: 'pointer', padding: 14, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: colors.mulchBrown, marginBottom: 6 }}>Products needing attention</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: metrics.productsWithWarnings > 0 ? colors.signetBurgundy : colors.ledgerCharcoal }}>{metrics.productsWithWarnings}</div>
            <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4 }}>{metrics.productsWithWarnings > 0 ? 'Open Catalog Review to see what needs fixing.' : 'No action needed.'}</div>
          </button>
        </div>
      </section>

      <section style={{ ...themeStyles.card, padding: '20px 24px', marginBottom: 24, backgroundColor: colors.feedBagCream }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: colors.ledgerCharcoal }}>
              Add products
            </h2>
            <p style={{ margin: 0, fontSize: 13, color: colors.mulchBrown }}>
              New products are prepared for your review before any updates reach your store.
            </p>
          </div>
          <button className="btn btn-outline" onClick={() => onNavigate('onboarding')}>
            Add products
          </button>
        </div>
      </section>

      <section style={{ ...themeStyles.card, padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${colors.cardBorder}` }}>
          <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: 0, color: colors.ledgerCharcoal }}>
            Recent store updates
          </h2>
          <button className="btn btn-outline" onClick={() => onNavigate('syncjobs')}>
            See all updates
          </button>
        </div>

        {recentSyncJobs.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, marginBottom: 8 }}>
            {recentSyncJobs.slice(0, 5).map(job => (
              <div key={job.id} style={{ margin: '2px 0', padding: '14px 18px', borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, backgroundColor: colors.feedBagCream, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
                    {job.kind === 'push_publish' ? 'Store update' : job.kind === 'upload_only' ? 'Catalog file sent' : job.kind === 'pull_drift' ? 'Checked for store changes' : job.kind === 'bootstrap' ? 'Catalog imported' : job.kind === 'full_reconcile' ? 'Checked products in your store' : 'Store update'}
                  </div>
                  <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4 }}>
                    {job.productCount} {job.productCount === 1 ? 'product' : 'products'} · {job.completedAt ? formatTimeAgo(job.completedAt) : 'In progress'}
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {getJobStatusBadge(job.status)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '32px 16px', margin: '12px 0', textAlign: 'center', color: colors.mulchBrown, fontSize: 13 }}>
            No recent store updates.
          </div>
        )}
      </section>
    </div>
  );
}
