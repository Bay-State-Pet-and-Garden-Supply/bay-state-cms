import React, { useState, useEffect } from 'react';
import { checkDrift, listDrift, listDriftHunks, resolveDrift, resolveDriftHunk, fullReconcile, bulkResolveDrift, reopenDriftReconcile, type DriftItem, type DriftHunkView } from '../api';
import { ViewHeader } from './common/ViewHeader';
import { colors } from '../theme';
const isPriceField = (field: string) => /(?:price|cost|sale)/i.test(field);

const FIELD_LABELS: Record<string, string> = {
  'core.name': 'Product name',
  'core.description': 'Description',
  'core.price': 'Price',
  'core.salePrice': 'Sale price',
  'core.sku': 'Product code',
  'core.quantityOnHand': 'Quantity',
};

function displayField(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]!;
  const words = field.replace(/^core\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayStatus(status: string): string {
  if (status === 'open') return 'Needs review';
  if (status === 'kept_local') return 'Kept current version';
  if (status === 'accepted_remote') return 'Updated from store';
  if (status === 'in_reconcile') return 'Being reviewed';
  return 'Done';
}

export function DriftView() {
  const [drifts, setDrifts] = useState<DriftItem[]>([]);
  const [hunks, setHunks] = useState<DriftHunkView[]>([]);
  const [fieldCounts, setFieldCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [hunkTotal, setHunkTotal] = useState(0);
  const [fieldFilter, setFieldFilter] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchDrift = async (field?: string) => {
    try {
      const activeField = field !== undefined ? field : fieldFilter;
      // Trust-remote scope ("*") lists unfiltered but bulks all eligible.
      const listField = activeField === '*' ? undefined : (activeField || undefined);
      const res = await listDrift('open', undefined, undefined, listField);
      setDrifts(res.drifts);
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
      // Check the saved store connection; this never changes product prices.
      const res = await checkDrift();
      setResult(`Checked the store. ${res.driftCount} product(s) have changes to review.`);
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
      setResult(
        action === 'keep_local'
          ? `Kept the current version of ${res.sku}.`
          : action === 'accept_remote'
            ? `Updated ${res.sku} with store details.`
            : `Store changes for ${res.sku} are ready for review.`,
      );
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
      setResult(`Changes for ${res.sku} are ready to review again.`);
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
      setResult(
        isPriceField(hunk.field)
          ? `Kept the price entered when ${res.sku} was added.`
          : decision === 'accept'
            ? `Used the store's ${displayField(res.field).toLowerCase()} for ${res.sku}.`
            : `Kept the current ${displayField(res.field).toLowerCase()} for ${res.sku}.`,
      );
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBulkAccept = async () => {
    if (!fieldFilter) {
      setError('Choose a product detail or “All changeable details” first.');
      return;
    }
    if (fieldFilter !== '*' && isPriceField(fieldFilter)) {
      setError('Price stays as entered when a product is added. Store changes cannot change it.');
      return;
    }
    const confirmMsg = fieldFilter === '*'
      ? 'Use the store’s changes for all changeable details? Prices will stay as entered when each product was added.'
      : `Use the store’s ${displayField(fieldFilter).toLowerCase()} for the selected products? Prices will stay unchanged.`;
    if (!confirm(confirmMsg)) return;
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bulkResolveDrift(fieldFilter, 'accept_remote');
      setResult('The selected store changes are ready for review. Product prices have not changed.');
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
      await fullReconcile();
      setResult('Your product list has been refreshed.');
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
        title="Store Changes"
        description="Compare products in your online store with your catalog. Prices stay exactly as entered when a product is added."
      />

      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}

      <div style={styles.section}>
        <div style={styles.label}>Check for changes</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          Check your online store. You can review each change before it is used.
        </div>
        <button style={{ ...styles.btn, background: colors.uniformGreen, color: colors.feedBagCream }} onClick={handleCheckDrift} disabled={loading}>
          {loading ? 'Checking…' : 'Check online store'}
        </button>
      </div>

      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={styles.label}>Changes to review ({hunkTotal})</div>
            {fieldFilter && fieldFilter !== '*' && (
              <span style={{ fontSize: 12, color: '#6b7280' }}>Showing: {displayField(fieldFilter)}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              style={styles.select}
              value={fieldFilter}
              aria-label="Filter product changes"
              onChange={(e) => { setFieldFilter(e.target.value); fetchDrift(e.target.value); }}
            >
              <option value="">All product changes</option>
              <option value="*">All changeable details</option>
              {fieldOptions.map((field) => (
                <option key={field} value={field}>
                  {displayField(field)}{isPriceField(field) ? ' (price stays as entered)' : ''} ({fieldCounts[field]})
                </option>
              ))}
            </select>
            {fieldFilter && (
              <button style={{ ...styles.btn, background: '#e5e7eb', color: '#111', fontSize: 11 }} onClick={() => { setFieldFilter(''); fetchDrift(''); }} disabled={loading}>
                Show all
              </button>
            )}
            <button
              style={{ ...styles.btn, background: '#10b981', color: '#fff', fontSize: 11 }}
              onClick={handleBulkAccept}
              disabled={loading || !fieldFilter || (fieldFilter !== '*' && isPriceField(fieldFilter))}
              title={isPriceField(fieldFilter) ? 'Prices stay as entered when a product is added.' : 'Use the selected store details for review.'}
            >
              {fieldFilter === '*' ? 'Use all changeable details' : fieldFilter ? `Use ${displayField(fieldFilter).toLowerCase()}` : 'Choose changes first'}
            </button>
          </div>
        </div>

        {hunks.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>
            {fieldFilter && fieldFilter !== '*' && isPriceField(fieldFilter)
              ? 'No price changes are used. Prices stay as entered when the products were added.'
              : 'No changes to review. Check your online store to look again.'}
          </p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Product code</th>
                <th style={styles.th}>Detail</th>
                <th style={styles.th}>Change</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Next step</th>
              </tr>
            </thead>
            <tbody>
              {hunks.map((h) => {
                const priceChange = isPriceField(h.field);
                const newProduct = h.heldReason === 'new_product';
                return (
                  <tr key={h.id}>
                    <td style={styles.td}><strong>{h.sku}</strong></td>
                    <td style={styles.td}>{displayField(h.field)}</td>
                    <td style={styles.td}>
                      {priceChange
                        ? newProduct
                          ? 'Enter the price when you add this product.'
                          : 'Price stays as entered when this product was added.'
                        : <><span style={{ color: '#6b7280' }}>{h.baselineValue ?? '—'}</span>{' → '}<strong>{h.remoteValue ?? '—'}</strong></>}
                    </td>
                    <td style={styles.td}>
                      {newProduct ? (
                        <span style={{ ...styles.badge, background: '#0e7490' }}>Not in your catalog</span>
                      ) : h.heldReason === 'in_reconcile' ? (
                        <span style={{ ...styles.badge, background: '#6b7280' }}>Already under review</span>
                      ) : priceChange ? (
                        <span style={{ ...styles.badge, background: '#6b7280' }}>Price stays as entered</span>
                      ) : h.heldReason === 'unavailable_assignment' ? (
                        <span style={{ ...styles.badge, background: '#b45309' }}>Page needs checking</span>
                      ) : (
                        <span style={{ ...styles.badge, background: '#dc2626' }}>Needs review</span>
                      )}
                    </td>
                    <td style={styles.td}>
                      {newProduct ? (
                        <span>Add this product to your catalog and enter its price there.</span>
                      ) : h.heldReason === 'in_reconcile' ? (
                        <button style={{ ...styles.actionBtn, background: '#6b7280' }} onClick={() => handleReopen(h.driftId)} disabled={loading}>
                          Review these changes again
                        </button>
                      ) : priceChange ? (
                        <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleHunkResolve(h, 'reject')} disabled={loading}>
                          Keep original price
                        </button>
                      ) : h.heldReason === 'unavailable_assignment' ? (
                        <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleHunkResolve(h, 'reject')} disabled={loading}>
                          Keep current version
                        </button>
                      ) : (
                        <>
                          <button style={{ ...styles.actionBtn, background: '#7c3aed' }} onClick={() => handleHunkResolve(h, 'accept')} disabled={loading}>
                            Use store change
                          </button>
                          <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleHunkResolve(h, 'reject')} disabled={loading}>
                            Keep current version
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={styles.label}>
            Products with changes ({total > 0 ? total : drifts.length})
            {total > drifts.length && (
              <span style={{ fontSize: 12, fontWeight: 'normal', color: '#6b7280', marginLeft: 8 }}>
                Showing {drifts.length} of {total} products
              </span>
            )}
          </div>
          <button style={{ ...styles.btn, background: '#6b7280', color: '#fff', fontSize: 11 }} onClick={handleReconcile} disabled={loading}>
            Refresh product list
          </button>
        </div>

        {drifts.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>No changes to review. Check your online store to look again.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Product code</th>
                <th style={styles.th}>Current product name</th>
                <th style={styles.th}>Store product name</th>
                <th style={styles.th}>Details changed</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Next step</th>
              </tr>
            </thead>
            <tbody>
              {drifts.map((d) => {
                const productHasPriceChange = (d.hunks ?? []).some((h) => isPriceField(h.field));
                return (
                  <tr key={d.id}>
                    <td style={styles.td}><strong>{d.sku}</strong></td>
                    <td style={styles.td}>{d.localProductName ?? '—'}</td>
                    <td style={styles.td}>{d.remoteProductName ?? '—'}</td>
                    <td style={styles.td}>
                      {(d.hunks ?? []).length === 0 ? (
                        <span style={{ color: '#9ca3af' }}>—</span>
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                          {(d.hunks ?? []).map((h, i) => (
                            <li key={i}>
                              {displayField(h.field)}:{' '}
                              {isPriceField(h.field)
                                ? 'Price stays as entered'
                                : `${h.baselineValue ?? '—'} → ${h.remoteValue ?? '—'}`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, background: d.status === 'open' ? '#dc2626' : d.status === 'in_reconcile' ? '#6b7280' : '#16a34a' }}>
                        {displayStatus(d.status)}
                      </span>
                    </td>
                    <td style={styles.td}>
                      {d.status === 'open' ? (
                        d.productKind === 'new' ? (
                          <span>Add this product to your catalog and enter its price there.</span>
                        ) : productHasPriceChange ? (
                          <span>Price stays as entered. Review the other details above one at a time.</span>
                        ) : (
                          <>
                            <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleResolve(d.id, 'keep_local')} disabled={loading}>
                              Keep current details
                            </button>
                            <button style={{ ...styles.actionBtn, background: '#7c3aed' }} onClick={() => handleResolve(d.id, 'accept_remote')} disabled={loading}>
                              Use store details
                            </button>
                            <button style={{ ...styles.actionBtn, background: colors.uniformGreen }} onClick={() => handleResolve(d.id, 'create_change_set')} disabled={loading}>
                              Review changes
                            </button>
                          </>
                        )
                      ) : d.status === 'in_reconcile' ? (
                        <button style={{ ...styles.actionBtn, background: '#6b7280' }} onClick={() => handleReopen(d.id)} disabled={loading}>
                          Review again
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: '#6b7280' }}>No action needed.</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
