import React, { useState, useEffect } from 'react';
import { checkDrift, listDrift, listDriftHunks, resolveDrift, resolveDriftHunk, fullReconcile, bulkResolveDrift, importNewDriftProduct, reopenDriftReconcile, type DriftItem, type DriftHunkView } from '../api';
import { ViewHeader } from './common/ViewHeader';
import { colors } from '../theme';

export function DriftView() {
  const [drifts, setDrifts] = useState<DriftItem[]>([]);
  const [hunks, setHunks] = useState<DriftHunkView[]>([]);
  const [fieldCounts, setFieldCounts] = useState<Record<string, number>>({});
  const [openCount, setOpenCount] = useState(0);
  const [reconcileCount, setReconcileCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [hunkTotal, setHunkTotal] = useState(0);
  const [fieldFilter, setFieldFilter] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPasteOverride, setShowPasteOverride] = useState(false);
  const [driftXml, setDriftXml] = useState('');

  const fetchDrift = async (field?: string) => {
    try {
      const activeField = field !== undefined ? field : fieldFilter;
      // Trust-remote scope ("*") lists unfiltered but bulks all eligible.
      const listField = activeField === '*' ? undefined : (activeField || undefined);
      const res = await listDrift('open', undefined, undefined, listField);
      setDrifts(res.drifts);
      setOpenCount(res.openCount);
      setReconcileCount(res.reconcileCount ?? 0);
      setTotal(res.total ?? res.drifts.length);
      const hunkRes = await listDriftHunks({ status: 'open', field: listField, limit: 100 });
      setHunks(hunkRes.hunks);
      setHunkTotal(hunkRes.total);
      setFieldCounts(hunkRes.fieldCounts ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { fetchDrift(''); }, []);

  const handleCheckDrift = async () => {
    setLoading(true);
    setError('');
    setResult('');
    try {
      // Live pull by default via the saved ShopSite connection; pasted XML
      // is only an advanced override for diagnostics.
      const res = await checkDrift(driftXml.trim() || undefined);
      setResult(`Drift check complete: ${res.driftCount} product(s) differ from remote.`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (id: string, action: 'keep_local' | 'accept_remote' | 'create_change_set') => {
    setLoading(true);
    setError('');
    try {
      const res = await resolveDrift(id, action);
      setResult(`Resolved: ${res.action} for SKU "${res.sku}"${(res as { changeSetId?: string }).changeSetId ? ` (change set ${(res as { changeSetId?: string }).changeSetId})` : ''}`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleImportNew = async (driftId: string, remoteHash?: string) => {
    if (!confirm('Import this genuinely new remote product into the approved catalog? This creates a new product file and commit.')) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await importNewDriftProduct(driftId, remoteHash);
      setResult(`Imported new product SKU "${res.sku}"${res.commitHash ? ` (commit ${res.commitHash.slice(0, 8)})` : ''}.`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReopen = async (driftId: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await reopenDriftReconcile(driftId);
      setResult(`Reopened reconcile for SKU "${res.sku}" back to open. Every linked hunk is resolvable again.`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleHunkResolve = async (hunk: DriftHunkView, decision: 'accept' | 'reject') => {
    setLoading(true);
    setError('');
    try {
      const res = await resolveDriftHunk({
        driftId: hunk.driftId,
        field: hunk.field,
        decision,
        baselineValue: hunk.baselineValue,
        remoteValue: hunk.remoteValue,
        expectedRemoteHash: hunk.remoteHash,
        expectedBaselineCommit: hunk.baselineCommit,
      });
      setResult(`${decision === 'accept' ? 'Accepted' : 'Rejected'} ${res.field} for SKU "${res.sku}"${res.resolvedAll ? ' (all hunks resolved)' : ` (${res.remainingHunks} hunk(s) remain)`}`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBulkAccept = async () => {
    if (!fieldFilter) {
      setError('Bulk resolution requires an explicit scope: pick a field filter (e.g. core.price) or "All eligible fields (*)". Bare accept-everything is not offered.');
      return;
    }
    const isTrust = fieldFilter === '*';
    const confirmMsg = isTrust
      ? `Trust remote for all ${hunkTotal} eligible hunk(s) through one reviewed change set? Only eligible fields change; new products, unverified pages, and reconcile-linked fields stay outstanding.`
      : `Accept all ${hunkTotal} "${fieldFilter}" hunk(s) through one reviewed change set? Only "${fieldFilter}" changes; other fields stay outstanding.`;
    if (!confirm(confirmMsg)) {
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await bulkResolveDrift(fieldFilter, 'accept_remote');
      setResult(res.message);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReconcile = async () => {
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await fullReconcile();
      setResult(`Full reconcile complete: ${res.reindexedCount} products reindexed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 16 },
    section: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16 },
    label: { fontSize: 13, fontWeight: 600, marginBottom: 4 },
    textarea: { width: '100%', minHeight: 80, padding: 8, fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, fontFamily: 'monospace' },
    btn: { padding: '8px 16px', fontSize: 13, cursor: 'pointer', border: 'none', borderRadius: 4, marginRight: 8 },
    error: { color: '#dc2626', padding: 8, background: '#fef2f2', borderRadius: 4, margin: '8px 0', fontSize: 13 },
    result: { color: '#16a34a', padding: 8, background: '#f0fdf4', borderRadius: 4, margin: '8px 0', fontSize: 13, whiteSpace: 'pre-wrap' as any },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { padding: '8px 12px', textAlign: 'left' as any, borderBottom: '2px solid #e5e7eb', fontWeight: 600 },
    td: { padding: '8px 12px', borderBottom: '1px solid #e5e7eb' },
    badge: {
      padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: '#fff',
    } as React.CSSProperties,
    actionBtn: { padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: 'none', borderRadius: 3, margin: '2px', color: '#fff' },
    select: { padding: '6px 10px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, marginRight: 8 },
  };

  const fieldOptions = Object.keys(fieldCounts).sort();

  return (
    <div style={styles.container}>
      <ViewHeader
        title="Drift Detection"
        description={
          <>
            Detects products that have changed in ShopSite since you last pulled.
            {openCount > 0 && <span style={{ color: '#dc2626', marginLeft: 8, fontWeight: 600 }}>⚠ {openCount} open drift item(s).</span>}
            {reconcileCount > 0 && <span style={{ color: '#6b7280', marginLeft: 8, fontWeight: 600 }}>⇄ {reconcileCount} in reconcile.</span>}
            {hunkTotal > 0 && <span style={{ color: '#6b7280', marginLeft: 8 }}>· {hunkTotal} field hunk(s).</span>}
          </>
        }
      />

      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}

      <div style={styles.section}>
        <div style={styles.label}>Incoming changes from the live store</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          Pull the latest ShopSite data via your saved connection, then accept what you want.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={{ ...styles.btn, background: colors.uniformGreen, color: colors.feedBagCream }} onClick={handleCheckDrift} disabled={loading}>
            {loading ? 'Pulling...' : 'Pull live changes'}
          </button>
        </div>
        <div style={{ marginTop: 8 }}>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#6b7280', padding: 0 }}
            onClick={() => setShowPasteOverride((v) => !v)}>
            {showPasteOverride ? '▾ Hide XML paste override' : '▸ Advanced: paste ShopSite XML instead'}
          </button>
        </div>
        {showPasteOverride && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Diagnostics only — pasted XML overrides the live pull. You should never need this in normal use.
            </div>
            <textarea
              style={styles.textarea}
              value={driftXml}
              onChange={(e) => setDriftXml(e.target.value)}
              placeholder="Paste ShopSite products XML here (optional override)..."
            />
          </div>
        )}
      </div>

      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={styles.label}>
            Field Hunks ({hunkTotal})
            {fieldFilter && fieldFilter !== '*' && <span style={{ marginLeft: 8, fontWeight: 'normal' }}>filtered to {fieldFilter}</span>}
            {fieldFilter === '*' && <span style={{ marginLeft: 8, fontWeight: 'normal' }}>trust-remote: all eligible fields</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              style={styles.select}
              value={fieldFilter}
              onChange={(e) => { setFieldFilter(e.target.value); fetchDrift(e.target.value); }}
            >
              <option value="">Pick a scope...</option>
              <option value="*">All eligible fields (*) — trust remote</option>
              {fieldOptions.map(f => (
                <option key={f} value={f}>{f} ({fieldCounts[f]})</option>
              ))}
            </select>
            {fieldFilter && (
              <button style={{ ...styles.btn, background: '#e5e7eb', color: '#111', fontSize: 11 }} onClick={() => { setFieldFilter(''); fetchDrift(''); }} disabled={loading}>
                Clear
              </button>
            )}
            <button
              style={{ ...styles.btn, background: fieldFilter ? '#10b981' : '#9ca3af', color: '#fff', fontSize: 11 }}
              onClick={handleBulkAccept}
              disabled={loading || !fieldFilter}
              title={fieldFilter === '*' ? 'Trust remote for all eligible hunks via one reviewed change set (held items stay outstanding)' : fieldFilter ? `Bulk accept all "${fieldFilter}" hunks via one reviewed change set` : 'Pick a field filter or All eligible fields (*) — bulk requires an explicit scope'}
            >
              {fieldFilter === '*' ? 'Trust Remote (*)' : fieldFilter ? `Bulk Accept ${fieldFilter}` : 'Bulk Accept (pick a scope)'}
            </button>
          </div>
        </div>

        {hunks.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>No incoming changes{fieldFilter && fieldFilter !== '*' ? ` for ${fieldFilter}` : ''}. Pull live changes to check.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>SKU</th>
                <th style={styles.th}>Field</th>
                <th style={styles.th}>Before → After</th>
                <th style={styles.th}>State</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hunks.map(h => (
                <tr key={h.id}>
                  <td style={styles.td}><strong>{h.sku}</strong></td>
                  <td style={styles.td}><code style={{ fontSize: 11 }}>{h.field}</code></td>
                  <td style={styles.td}>
                    <span style={{ color: '#6b7280' }}>{h.baselineValue ?? '∅'}</span>
                    {' → '}
                    <strong>{h.remoteValue ?? '∅'}</strong>
                  </td>
                  <td style={styles.td}>
                    {h.heldReason === 'new_product' ? (
                      <>
                        <span style={{ ...styles.badge, background: '#0e7490' }}>new product</span>
                        <div style={{ marginTop: 4 }}>
                          <button style={{ ...styles.actionBtn, background: '#0e7490' }} onClick={() => handleImportNew(h.driftId, h.remoteHash)} disabled={loading}>
                            Import new product
                          </button>
                        </div>
                      </>
                    ) : h.heldReason === 'unavailable_assignment' ? (
                      <>
                        <span style={{ ...styles.badge, background: '#b45309' }}>held: unverified page</span>
                        <div style={{ marginTop: 4 }}>
                          <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleHunkResolve(h, 'reject')} disabled={loading}>
                            Reject (keep local)
                          </button>
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Accept held: no stable page identity — reconcile for manual merge.</div>
                      </>
                    ) : h.heldReason === 'in_reconcile' ? (
                      <>
                        <span style={{ ...styles.badge, background: '#6b7280' }}>in reconcile</span>
                        <div style={{ marginTop: 4 }}>
                          <button style={{ ...styles.actionBtn, background: '#6b7280' }} onClick={() => handleReopen(h.driftId)} disabled={loading}>
                            Reopen
                          </button>
                        </div>
                      </>
                    ) : (
                      <span style={{ ...styles.badge, background: '#dc2626' }}>open</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    {h.heldReason === 'new_product' ? (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>Imports via the explicit new-product workflow</span>
                    ) : h.heldReason === 'unavailable_assignment' ? (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>Reject keeps local; accept stays held</span>
                    ) : h.heldReason ? (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>Settles through reconcile approve / discard / reopen</span>
                    ) : (
                      <>
                        <button style={{ ...styles.actionBtn, background: '#7c3aed' }} onClick={() => handleHunkResolve(h, 'accept')} disabled={loading}>
                          Accept hunk
                        </button>
                        <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleHunkResolve(h, 'reject')} disabled={loading}>
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={styles.label}>
            Drift Items ({total > 0 ? total : drifts.length})
            {total > drifts.length && (
              <span style={{ fontSize: 12, fontWeight: 'normal', color: '#b45309', marginLeft: 8 }}>
                (Showing {drifts.length} of {total})
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {drifts.length > 0 && (
              <button
                style={{ ...styles.btn, background: fieldFilter ? '#10b981' : '#9ca3af', color: '#fff', fontSize: 11 }}
                onClick={() => handleBulkAccept()}
                disabled={loading || !fieldFilter}
                title={fieldFilter === '*' ? 'Trust remote for all eligible hunks via one reviewed change set (held items stay outstanding)' : fieldFilter ? `Bulk accept all "${fieldFilter}" hunks via one reviewed change set` : 'Pick a field filter or All eligible fields (*) — bulk requires an explicit scope'}
              >
                {fieldFilter === '*' ? 'Trust Remote (*)' : fieldFilter ? `Bulk Accept ${fieldFilter}` : 'Bulk Accept (pick a scope)'}
              </button>
            )}
            <button style={{ ...styles.btn, background: '#6b7280', color: '#fff', fontSize: 11 }} onClick={handleReconcile} disabled={loading}>
              Full Reindex
            </button>
          </div>
        </div>

        {drifts.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>No drift items yet. Pull live changes to detect remote updates.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>SKU</th>
                <th style={styles.th}>Local Name</th>
                <th style={styles.th}>Remote Name</th>
                <th style={styles.th}>Hunks</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {drifts.map(d => (
                <tr key={d.id}>
                  <td style={styles.td}>
                    <strong>{d.sku}</strong>
                    {d.productKind === 'new' && (
                      <span style={{ ...styles.badge, background: '#0e7490', marginLeft: 6 }}>NEW</span>
                    )}
                  </td>
                  <td style={styles.td}>{d.localProductName ?? '—'}</td>
                  <td style={styles.td}>{d.remoteProductName ?? '—'}</td>
                  <td style={styles.td}>
                    {(d.hunks ?? []).length === 0 ? (
                      <span style={{ color: '#9ca3af' }}>—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                        {(d.hunks ?? []).map((h, i) => (
                          <li key={i}><code style={{ fontSize: 11 }}>{h.field}</code>: {h.baselineValue ?? '∅'} → {h.remoteValue ?? '∅'}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td style={styles.td}><span style={{...styles.badge, background: d.status === 'open' ? '#dc2626' : d.status === 'kept_local' ? '#16a34a' : d.status === 'accepted_remote' ? '#7c3aed' : '#6b7280'}}>{d.status}</span></td>
                  <td style={styles.td}>
                    {d.status === 'open' && (
                      <>
                        <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleResolve(d.id, 'keep_local')}>
                          Keep Local
                        </button>
                        {d.productKind === 'new' ? (
                          <button style={{ ...styles.actionBtn, background: '#0e7490' }} onClick={() => handleImportNew(d.id, (d as { remoteHash?: string }).remoteHash || undefined)}>
                            Import New
                          </button>
                        ) : (
                          <button style={{ ...styles.actionBtn, background: '#7c3aed' }} onClick={() => handleResolve(d.id, 'accept_remote')}>
                            Accept Remote
                          </button>
                        )}
                        <button style={{ ...styles.actionBtn, background: colors.uniformGreen }} onClick={() => handleResolve(d.id, 'create_change_set')}>
                          Reconcile
                        </button>
                      </>
                    )}
                    {d.status === 'in_reconcile' && (
                      <button style={{ ...styles.actionBtn, background: '#6b7280' }} onClick={() => handleReopen(d.id)}>
                        Reopen
                      </button>
                    )}
                    {d.status !== 'open' && d.status !== 'in_reconcile' && <span style={{ fontSize: 12, color: '#9ca3af' }}>Resolved</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
