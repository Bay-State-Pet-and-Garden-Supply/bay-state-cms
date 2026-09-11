// story: e08s02 — Brands Hub editor + sitemap/readiness enrichment + Profile Workspace links (profile bypass eligible)
// B4 — Settings mounts the shared BrandStrategyBuilder: approval/revision/readiness,
// single combined Save, no misleading strategy Delete.
import React, { useEffect, useRef, useState } from 'react';
import { KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS } from '../../../onboarding/discovery/retailer-domain-list';
import type { BrandStrategy } from '../../../shared/schemas/brand-strategy';
import { getProfileWorkspacePath } from '../profile-workspace/route';
import { getBrandStrategies } from '../../onboarding-api';
import { BrandStrategyBuilder } from './BrandStrategyBuilder';

type Props = {
  strategies?: BrandStrategy[];
  loading?: boolean;
  /** Incremented when the Brands tab becomes active — refetches without touching open-editor state. */
  refreshSignal?: number;
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

function ApprovalSummary({ strategy }: { strategy: BrandStrategy }) {
  const approved = strategy.approval?.approved === true;
  const sources = strategy.approvedSources ?? [];
  if (!approved) return <span style={{ color: '#6b7280', fontSize: 12 }}>Awaiting approval</span>;
  if (sources.length === 0) return <span style={{ color: '#6b7280', fontSize: 12 }}>Approved — no sources</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>Included:</span>
      {sources.map((s) => {
        const label = s.kind === 'official_page' ? s.domain : s.distributorId;
        return (
          <span key={`${s.kind}:${label}`} style={{ background: '#e0f2fe', color: '#0c4a6e', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>{label}</span>
        );
      })}
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

/** Text approval state — never color-only. */
function ApprovalState({ strategy }: { strategy: BrandStrategy }) {
  const approval = strategy.approval;
  const readiness = strategy.collectionReadiness;
  const approved = approval?.approved === true;
  const sources = strategy.approvedSources ?? [];
  const summary = sources.length === 0
    ? 'no approved sources'
    : sources.map((s) => (s.kind === 'official_page' ? `Official website (${s.domain})` : `Distributor (${s.distributorId})`)).join(' + ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ fontWeight: 700, color: approved ? '#166534' : '#92400e' }}>
        {approved ? `Approved revision ${approval.revision}` : 'Awaiting approval'}
      </span>
      {approved && <span style={{ color: '#374151' }}>{summary}</span>}
      {readiness && (
        <span style={{ color: '#6b7280' }}>
          {readiness === 'awaiting_approval' && 'Readiness: awaiting approval'}
          {readiness === 'setup_attention' && 'Readiness: setup attention — no usable sources'}
          {readiness === 'ready' && 'Readiness: ready'}
          {readiness === 'ready_partial' && 'Readiness: Partial Source Collection'}
          {readiness === 'unknown' && 'Readiness: unknown'}
        </span>
      )}
      {(strategy.sourceAvailability ?? []).filter((s) => !s.available && (s.reason === 'no_profile' || s.reason === 'profile_not_healthy')).length > 0 && (
        <span style={{ color: '#6b7280' }}>Official source needs profile setup — distributors still collect.</span>
      )}
    </div>
  );
}

type DialogState = { mode: 'edit'; brand: string } | { mode: 'create' } | null;

export function BrandStrategyView({ strategies: initial, loading, refreshSignal }: Props) {
  const [strategies, setStrategies] = useState<BrandStrategy[]>(initial ?? []);
  const [fetching, setFetching] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const lastFocus = useRef<HTMLElement | null>(null);
  // Review-loop R1 P0-2: Settings New resolves the brand name first, then
  // mounts the builder once for the typed brand (never brand='').
  const [createName, setCreateName] = useState('');
  const [createBrand, setCreateBrand] = useState<string | null>(null);
  // Review-loop R1 P1-3: shell dismiss (backdrop/Escape) must not bypass
  // the builder's discard confirmation while edits are dirty.
  const dialogDirty = useRef(false);

  async function refetch() {
    setFetching(true);
    setError(null);
    try {
      const res = await getBrandStrategies();
      setStrategies(res.strategies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => {
    if (initial) return;
    void refetch();
  }, []);

  // Prop-driven refresh: supplied strategies updates replace the table facts.
  // The open editor owns its own projection, so this never clobbers dirty edits.
  useEffect(() => {
    if (initial) setStrategies(initial);
  }, [initial]);

  // Returning to the Brands tab refetches server facts; same-brand edits in
  // the dialog keep their own guards and are never overwritten.
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    if (initial) return;
    void refetch();
  }, [refreshSignal]);

  function openDialog(next: DialogState, invoker?: HTMLElement | null) {
    lastFocus.current = invoker ?? null;
    setBuilderKey((k) => k + 1);
    setCreateName('');
    setCreateBrand(null);
    dialogDirty.current = false;
    setDialog(next);
  }

  function closeDialog() {
    setDialog(null);
    setCreateName('');
    setCreateBrand(null);
    dialogDirty.current = false;
    lastFocus.current?.focus?.();
  }

  /** Shell dismiss: refuse to discard dirty builder edits (use Cancel). */
  function requestCloseDialog() {
    if (dialogDirty.current) return;
    closeDialog();
  }

  function handleSaved() {
    setDialog(null);
    setCreateName('');
    setCreateBrand(null);
    dialogDirty.current = false;
    lastFocus.current?.focus?.();
    void refetch();
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
        <button
          onClick={(e) => openDialog({ mode: 'create' }, e.currentTarget)}
          style={{ background: '#14532d', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
        >
          + New Brand Strategy
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Brand Identity</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Included sources</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Official Domain & Sitemap</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Extraction Readiness</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Strategy Approval</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {strategies.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No brands configured</td></tr>
            )}
            {strategies.map((s) => (
              <tr key={s.normalizedBrand} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '12px' }}>
                  <div style={{ fontWeight: 600, color: '#111827' }}>{s.brandKey}</div>
                  {s.ambiguous.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: '#92400e' }}>⚠ Ambiguous: {s.ambiguous.map((a) => `${a.candidateBrand} (${a.reason})`).join(', ')}</div>}
                  {s.unmatched && <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280' }}>{s.officialDomains.length === 0 ? 'No official domain' : 'No official domain'}</div>}
                </td>
                <td style={{ padding: '12px' }}><ApprovalSummary strategy={s} /></td>
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
                <td style={{ padding: '12px' }}><ApprovalState strategy={s} /></td>
                <td style={{ padding: '12px', display: 'flex', gap: 6 }}>
                  <button
                    onClick={(e) => openDialog({ mode: 'edit', brand: s.brandKey }, e.currentTarget)}
                    style={{ background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                  >
                    Edit strategy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={dialog.mode === 'create' ? 'New brand strategy' : `Edit strategy — ${dialog.brand}`}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) requestCloseDialog();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') requestCloseDialog();
          }}
        >
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, width: 640, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
              {dialog.mode === 'create' ? 'New brand strategy' : `Edit strategy — ${dialog.brand}`}
            </h3>
            {dialog.mode === 'create' && createBrand === null ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 12, color: '#374151' }}>
                  Brand name
                  <input
                    aria-label="Brand name"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && createName.trim()) setCreateBrand(createName.trim());
                    }}
                    style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
                    placeholder="Fromm"
                  />
                </label>
                <div>
                  <button
                    type="button"
                    disabled={!createName.trim()}
                    onClick={() => setCreateBrand(createName.trim())}
                    style={{ border: '1px solid #14532d', borderRadius: 6, padding: '6px 14px', fontSize: 13, background: '#14532d', color: '#fff', cursor: createName.trim() ? 'pointer' : 'not-allowed', opacity: createName.trim() ? 1 : 0.5 }}
                  >
                    Look up
                  </button>
                </div>
              </div>
            ) : (
              <>
                {dialog.mode === 'create' && createBrand !== null && (
                  <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>
                    Brand: <strong>{createBrand}</strong>{' '}
                    <button
                      type="button"
                      onClick={() => { setCreateBrand(null); dialogDirty.current = false; }}
                      style={{ border: 'none', background: 'transparent', color: '#2563eb', textDecoration: 'underline', fontSize: 12, cursor: 'pointer', padding: 0 }}
                    >
                      Use a different brand name
                    </button>
                  </div>
                )}
                <BrandStrategyBuilder
                  key={`${dialog.mode}-${dialog.mode === 'edit' ? dialog.brand : createBrand ?? 'new'}-${builderKey}`}
                  brand={dialog.mode === 'edit' ? dialog.brand : (createBrand ?? '')}
                  onSaved={handleSaved}
                  onCancel={closeDialog}
                  onDirtyChange={(d) => { dialogDirty.current = d; }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
