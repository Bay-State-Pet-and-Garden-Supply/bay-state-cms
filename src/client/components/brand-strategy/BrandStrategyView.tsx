// story: e08s02 — Brands Hub editor + sitemap/readiness enrichment + Profile Workspace links (Preferred/Fallback tier, profile bypass eligible)
import React, { useEffect, useState } from 'react';
import { KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS } from '../../../onboarding/discovery/retailer-domain-list';
import type { BrandStrategy } from '../../../shared/schemas/brand-strategy';
import { getProfileWorkspacePath } from '../profile-workspace/route';
import { upsertBrandProfile, deleteBrandProfile, getDistributors } from '../../onboarding-api';

type Props = {
  strategies?: BrandStrategy[];
  loading?: boolean;
};

function formatRefresh(lastRefreshAt: string | null): string {
  if (!lastRefreshAt) return '';
  const diff = Date.now() - new Date(lastRefreshAt).getTime();
  if (Number.isNaN(diff)) return `refreshed ${lastRefreshAt}`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'refreshed <1h ago';
  if (hours < 24) return `refreshed ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `refreshed ${days}d ago`;
}

function TierPills({ strategy }: { strategy: BrandStrategy }) {
  const preferred = strategy.preferredDistributorIds;
  if (preferred.length === 0) return <span style={{ color: '#6b7280', fontSize: 12 }}>All Enabled</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>Preferred tier:</span>
      {preferred.map((id) => (
        <span key={id} style={{ background: '#e0f2fe', color: '#0c4a6e', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>{id}</span>
      ))}
      {strategy.fallbackTier.length > 0 && (
        <>
          <span style={{ fontSize: 11, color: '#6b7280' }}>Fallback tier:</span>
          {strategy.fallbackTier.map((id) => (
            <span key={id} style={{ background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>{id}</span>
          ))}
        </>
      )}
    </div>
  );
}

function ReadinessBadge({ strategy }: { strategy: BrandStrategy }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    active: { label: 'Active', bg: '#dcfce7', fg: '#166534' },
    degraded: { label: 'Degraded', bg: '#fee2e2', fg: '#991b1b' },
    draft: { label: 'Draft', bg: '#e0e7ff', fg: '#3730a3' },
    needs_testing: { label: 'Needs testing', bg: '#fef3c7', fg: '#92400e' },
    not_configured: { label: 'Not configured', bg: '#f3f4f6', fg: '#374151' },
    profile_bypass_eligible: { label: 'Profile bypass eligible when distributor evidence qualifies', bg: '#f0fdf4', fg: '#14532d' },
  };
  const v = map[strategy.extractorReadiness] ?? map.not_configured;
  return <span style={{ background: v.bg, color: v.fg, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600 }}>{v.label}</span>;
}

export function BrandStrategyView({ strategies: initial, loading }: Props) {
  const [strategies, setStrategies] = useState<BrandStrategy[]>(initial ?? []);
  const [fetching, setFetching] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BrandStrategy | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBrandInput, setNewBrandInput] = useState('');
  const [aliasesInput, setAliasesInput] = useState('');
  const [preferredInput, setPreferredInput] = useState<string[]>([]);
  const [policyInput, setPolicyInput] = useState<BrandStrategy['sourcingPolicy']>('preferred_then_fallback');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [distributors, setDistributors] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (initial) return;
    setFetching(true);
    fetch('/api/onboarding/brands/strategy')
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((j) => setStrategies(j.strategies ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFetching(false));
  }, [initial]);

  useEffect(() => {
    getDistributors().then((r) => setDistributors(r.distributors.map((d) => ({ id: d.id, name: d.name })))).catch(() => {});
  }, []);

  function openEdit(s: BrandStrategy) {
    setEditing(s);
    setCreating(false);
    setAliasesInput(s.aliases.join(', '));
    setPreferredInput([...s.preferredDistributorIds]);
    setPolicyInput(s.sourcingPolicy);
    setSaveError(null);
  }

  function openCreate() {
    setCreating(true);
    setEditing(null);
    setNewBrandInput('');
    setAliasesInput('');
    setPreferredInput([]);
    setPolicyInput('preferred_then_fallback');
    setSaveError(null);
  }

  async function handleSave() {
    const target = editing ?? (creating ? { brandKey: newBrandInput.trim() } as BrandStrategy : null);
    if (!target || !target.brandKey.trim()) {
      setSaveError('Brand name is required');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const aliases = aliasesInput.split(',').map((v) => v.trim()).filter(Boolean);
      const preferredDistributorIds = [...preferredInput];
      await upsertBrandProfile({ brand: target.brandKey.trim(), aliases, preferredDistributorIds, sourcingPolicy: policyInput });
      const r = await fetch('/api/onboarding/brands/strategy');
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const res = await r.json();
      setStrategies(res.strategies ?? []);
      setEditing(null);
      setCreating(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(s: BrandStrategy) {
    if (!confirm(`Delete strategy for "${s.brandKey}"?`)) return;
    try {
      await deleteBrandProfile(s.brandKey);
      const r = await fetch('/api/onboarding/brands/strategy');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = await r.json();
      setStrategies(res.strategies ?? []);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  const isLoading = loading || fetching;
  if (isLoading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading brand strategies…</div>;
  if (error) return <div style={{ padding: 16, color: '#991b1b', fontSize: 13 }}>{error}</div>;

  return (
    <div>
      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e', marginBottom: 16 }}>
        Global retailer denylist active — discovery will not persist provisional domains on these hosts ({KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS.size} hosts)
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button onClick={openCreate} style={{ background: '#14532d', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>+ New Brand Strategy</button>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Brand Identity</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Sourcing tier</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Official Domain & Sitemap</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Extraction Readiness</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {strategies.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No brands configured</td></tr>
            )}
            {strategies.map((s) => (
              <tr key={s.normalizedBrand} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '12px' }}>
                  <div style={{ fontWeight: 600, color: '#111827' }}>{s.brandKey}</div>
                  {s.aliases.length > 0 && <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>{s.aliases.map((a) => <span key={a} style={{ background: '#f3f4f6', borderRadius: 999, padding: '1px 7px', fontSize: 11, color: '#4b5563' }}>{a}</span>)}</div>}
                  {s.ambiguous.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: '#92400e' }}>⚠ Ambiguous: {s.ambiguous.map((a) => `${a.candidateBrand} (${a.reason})`).join(', ')}</div>}
                  {s.unmatched && <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280' }}>{s.officialDomains.length === 0 && !s.aliases.length ? 'Unmatched advisory' : s.officialDomains.length === 0 ? 'No advisory profile' : 'No official domain'}</div>}
                </td>
                <td style={{ padding: '12px' }}><TierPills strategy={s} /></td>
                <td style={{ padding: '12px' }}>
                  {s.officialDomains.length === 0 ? (
                    <span style={{ color: '#6b7280', fontSize: 12 }}>No official site configured</span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {s.officialDomains.map((d) => (
                        <div key={d.domain} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontWeight: 500, color: '#111827' }}>{d.domain}</span>
                          <span style={{ fontSize: 11, color: '#6b7280' }}>{d.sitemap.totalUrls} URLs · {d.sitemap.freshness}{d.sitemap.lastRefreshAt ? ` · ${formatRefresh(d.sitemap.lastRefreshAt)}` : ''}</span>
                          <a href={getProfileWorkspacePath(d.domain)} style={{ fontSize: 11, color: '#2563eb', textDecoration: 'underline' }}>Build profile for {d.domain} →</a>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td style={{ padding: '12px' }}><ReadinessBadge strategy={s} /></td>
                <td style={{ padding: '12px', display: 'flex', gap: 6 }}>
                  <button onClick={() => openEdit(s)} style={{ background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Edit strategy</button>
                  <button onClick={() => handleDelete(s)} style={{ background: '#fff', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#991b1b' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: 520, maxWidth: '90vw', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>{creating ? 'New brand strategy' : `Edit strategy — ${editing?.brandKey}`}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {creating && (
                <label style={{ fontSize: 12, color: '#374151' }}>Brand name
                  <input value={newBrandInput} onChange={(e) => setNewBrandInput(e.target.value)} style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }} placeholder="Fromm" />
                </label>
              )}
              <label style={{ fontSize: 12, color: '#374151' }}>Aliases (comma-separated)
                <input value={aliasesInput} onChange={(e) => setAliasesInput(e.target.value)} style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }} placeholder="alias1, alias2" />
                <span style={{ fontSize: 11, color: '#6b7280' }}>Advisory only — not used for matching</span>
              </label>
              <div style={{ fontSize: 12, color: '#374151' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Preferred distributors</div>
                {distributors.length === 0 ? (
                  <span style={{ fontSize: 11, color: '#6b7280' }}>No enabled distributors — add a connection in Distributors tab first.</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid #d1d5db', borderRadius: 6, padding: '8px', maxHeight: 140, overflowY: 'auto', background: '#f9fafb' }}>
                    {distributors.map((d) => (
                      <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={preferredInput.includes(d.id)}
                          onChange={(e) => {
                            if (e.target.checked) setPreferredInput([...preferredInput, d.id]);
                            else setPreferredInput(preferredInput.filter((id) => id !== d.id));
                          }}
                        />
                        <span style={{ fontWeight: 500 }}>{d.name}</span>
                        <span style={{ color: '#6b7280', fontSize: 11 }}>({d.id})</span>
                      </label>
                    ))}
                  </div>
                )}
                {preferredInput.length === 0 && <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'block' }}>No preferred — all enabled distributors will be queried (All Enabled).</span>}
                {preferredInput.filter((id) => !distributors.some((d) => d.id === id)).length > 0 && (
                  <span style={{ fontSize: 11, color: '#b45309', marginTop: 4, display: 'block' }}>Stale: {preferredInput.filter((id) => !distributors.some((d) => d.id === id)).join(', ')} — no longer enabled.</span>
                )}
              </div>
              <label style={{ fontSize: 12, color: '#374151' }}>Sourcing policy
                <select value={policyInput} onChange={(e) => setPolicyInput(e.target.value as BrandStrategy['sourcingPolicy'])} style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}>
                  <option value="advisory">advisory</option>
                  <option value="preferred_then_fallback">preferred_then_fallback</option>
                  <option value="preferred_only">preferred_only</option>
                </select>
              </label>
              {saveError && <div style={{ color: '#991b1b', fontSize: 12 }}>{saveError}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <button onClick={() => { setEditing(null); setCreating(false); }} style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 14px', fontSize: 13, background: '#fff', cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{ background: '#14532d', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
