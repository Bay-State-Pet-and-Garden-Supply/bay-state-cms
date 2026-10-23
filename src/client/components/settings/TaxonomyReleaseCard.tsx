import React, { useCallback, useEffect, useState } from 'react';
import {
  getTaxonomyReleaseStatus,
  pinTaxonomyRelease,
  type TaxonomyReleaseRevisionInfo,
  type TaxonomyReleaseStatus,
} from '../../onboarding-api';
import { FrozenBanner } from './FrozenBanner';
import { StatusBadge } from './StatusBadge';
import { KeyValueList, type KeyValueEntry } from './KeyValueList';

/**
 * Taxonomy Release status card (P4 client increment — plan sections B.P4.3/C).
 *
 * Consumes GET /api/settings/taxonomy-release and renders:
 * - the workspace's active revision (FrozenBanner pattern),
 * - every available immutable release with manifest counts + hash status,
 * - the sanctioned Activate/Pin action, rendered DISABLED unless the server
 *   reports `adminEnabled` (the client NEVER guesses — defense in depth with
 *   the server-side 403 `release_admin_disabled` gate).
 */

const STYLES: Record<string, React.CSSProperties> = {
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20 },
  sectionTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 12px 0', color: '#111827' },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid #f1f5f9',
    flexWrap: 'wrap' as const,
  },
  revisionName: { fontFamily: 'monospace', fontSize: 13, color: '#111827' },
  countsLine: { fontSize: 12, color: '#6b7280' },
  primaryBtn: {
    background: '#14532D',
    color: '#FEFCE8',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 13,
  },
  disabledBtn: {
    background: '#e5e7eb',
    color: '#6b7280',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'not-allowed',
    fontWeight: 600,
    fontSize: 13,
  },
  error: { color: '#dc2626', background: '#fef2f2', borderRadius: 6, padding: 8, marginTop: 12, fontSize: 13 },
  success: { color: '#166534', background: '#f0fdf4', borderRadius: 6, padding: 8, marginTop: 12, fontSize: 13 },
};

function formatCounts(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return 'no manifest counts';
  return keys.map((key) => `${counts[key]} ${key}`).join(' · ');
}

export function TaxonomyReleaseCard(): React.ReactElement {
  const [status, setStatus] = useState<TaxonomyReleaseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getTaxonomyReleaseStatus());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A successful admin-gate change in Security Settings alters whether
  // Activate is enabled. Panels stay mounted across tab switches, so listen
  // for the gate change instead of requiring a page reload.
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener('baystate:release-admin-changed', refresh);
    return () => window.removeEventListener('baystate:release-admin-changed', refresh);
  }, [load]);

  const activate = async (revision: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await pinTaxonomyRelease(revision);
      setNotice(`Workspace pinned to ${result.activeRevision}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return (
      <div style={STYLES.card}>
        <h2 style={STYLES.sectionTitle}>Taxonomy Release</h2>
        <div aria-live="polite" style={{ fontSize: 13, color: '#6b7280' }}>Loading release status…</div>
      </div>
    );
  }

  const activeRevision = status?.activeRevision ?? null;
  const revisions: TaxonomyReleaseRevisionInfo[] = status?.availableRevisions ?? [];

  return (
    <div>
      <FrozenBanner revision={activeRevision ?? status?.defaultRevision ?? null} />
      <div style={STYLES.card}>
        <h2 style={STYLES.sectionTitle}>Taxonomy Release</h2>
        <KeyValueList
          items={[
            {
              label: 'Active revision',
              value: activeRevision
                ? <span style={STYLES.revisionName}>{activeRevision}</span>
                : <span style={{ fontStyle: 'italic', color: '#6b7280' }}>none pinned (pre-migration)</span>,
            },
            ...(status?.updatedAt
              ? [{ label: 'Pinned at', value: new Date(status.updatedAt).toLocaleString() }]
              : []),
            {
              label: 'Admin activation',
              value: <StatusBadge variant={status?.adminEnabled ? 'active' : 'frozen'} title={
                status?.adminEnabled
                  ? 'BAYSTATE_CMS_RELEASE_ADMIN_ENABLED is on — pin changes permitted with a valid API token.'
                  : 'Server-side admin gate is OFF; activation requires BAYSTATE_CMS_RELEASE_ADMIN_ENABLED plus a valid API token.'
              } />,
            },
          ] as KeyValueEntry[]}
        />

        <h3 style={{ ...STYLES.sectionTitle, fontSize: 14, margin: '18px 0 8px' }}>Available releases</h3>
        {revisions.map((revision) => {
          const isActive = revision.revision === activeRevision;
          return (
            <div key={revision.revision} style={STYLES.row} data-release-row={revision.revision}>
              <div>
                <span style={STYLES.revisionName}>{revision.revision}</span>{' '}
                {isActive ? <StatusBadge variant="active" /> : null}
                {revision.manifestHashesOk
                  ? <StatusBadge variant="mapped" label="Hashes OK" />
                  : <StatusBadge variant="blocker" label={`Validation errors: ${revision.errorCount}`} />}
                {revision.errorCount === 0 && revision.warningCount > 0
                  ? <StatusBadge variant="warning" label={`${revision.warningCount} warnings`} />
                  : null}
                <div style={STYLES.countsLine}>{formatCounts(revision.counts)}</div>
              </div>
              {!isActive ? (
                <button
                  type="button"
                  style={status?.adminEnabled && !busy ? STYLES.primaryBtn : STYLES.disabledBtn}
                  disabled={!status?.adminEnabled || busy}
                  title={
                    status?.adminEnabled
                      ? `Pin this workspace to ${revision.revision} (requires API token)`
                      : 'Disabled: server-side release administration is off (BAYSTATE_CMS_RELEASE_ADMIN_ENABLED)'
                  }
                  onClick={() => void activate(revision.revision)}
                >
                  {busy ? 'Working…' : 'Activate'}
                </button>
              ) : (
                <StatusBadge variant="active" label="Active" />
              )}
            </div>
          );
        })}

        {error && <div role="alert" style={STYLES.error}>{error}</div>}
        {notice && <div role="status" aria-live="polite" style={STYLES.success}>{notice}</div>}
      </div>
    </div>
  );
}
