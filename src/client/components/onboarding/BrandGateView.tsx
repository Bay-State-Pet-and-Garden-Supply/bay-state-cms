/**
 * Slice 3 — Step 0 Brand setup: the single unified brand view (council plan §6 Slice 3).
 *
 * ONE ordered view, mounted in BatchWorkspace on `wview=brand-setup` when the
 * shell flag AND the brand flag are enabled (brand flag requires shell flag).
 * This is a VIEW, never a stage: it adds no seventh tab, no batch-wide gate,
 * no persisted Step-0 stage, and no new authority or mutation protocol.
 *
 * Order: TOP shows preflight mapping coverage/advice plus the existing
 * frozen `BrandDomainSetupPanel`; BOTTOM shows per-item brand fixes (existing
 * assign-brand/domain actions) plus the existing grouped
 * `BrandAssignmentPanel`. Settings remains the brand→domain mapping
 * authority; the view links to (never duplicates) the frozen contextual
 * resolution forms and never removes frozen contextual actions.
 *
 * Server-owned behavior: preflight readiness/held IDs, blocker lists, and
 * per-item rows all come from existing typed reads. A missing official
 * domain stays advisory for supplier-qualified paths (a qualified
 * distributor record with no official domain/null URL remains
 * extraction-eligible and profile-free); unknown/mismatched official
 * authority still blocks official auto-accept and resolves in the frozen
 * attention flow. Empty blocker responses render loading/error/UNKNOWN —
 * never healthy. Action success refetches every projection; the view never
 * locally marks an item unblocked.
 *
 * Fetch budget per initial/refresh epoch (independent of preflight ID count):
 * `getBatchPreflight` ≤ 2 (view + frozen BrandAssignmentPanel),
 * `getBrandDomainBlockers` ≤ 2 (view + frozen BrandDomainSetupPanel),
 * ≤ 1 bounded stage-items page, zero per-item detail requests. Each Load
 * more adds at most 1 items request with no automatic page chase.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { colors, fonts, rounded, typography } from '../../theme';
import {
  assignItemBrand,
  assignItemDomain,
} from '../../onboarding-api';
import { BrandCombobox } from './BrandCombobox';
import { getBrandOptions, resolveCanonicalBrand } from './brand-combobox-logic';
import {
  getBrandGateProjections,
  getStageReadItems,
  type BrandGateProjections,
} from '../../onboarding-stage-api';
import { STAGE_READ_LIMIT_DEFAULT } from '../../../shared/schemas/onboarding-stage-read';
import { BrandAssignmentPanel } from './attention/BrandAssignmentPanel';
import { BrandDomainSetupPanel } from './attention/BrandDomainSetupPanel';
import {
  BRAND_ROW_KIND_ADVICE,
  BRAND_ROW_KIND_LABELS,
  buildBrandRowContext,
  classifyBrandRows,
  deriveBrandGateHealth,
  selectBrandGateGroups,
  type ClassifiedBrandRow,
} from './brand-gate-logic';

export interface BrandGateViewProps {
  batchId: string;
  /** Return to the stage list (safe shell destination, no mutation). */
  onBack: () => void;
  /** Settings remains the brand→domain mapping authority. */
  onOpenSettings?: () => void;
  /** Existing controlled-release flow (Preflight Review modal). */
  onOpenPreflight?: () => void;
  /** Open one item in the frozen contextual resolution flow. */
  onOpenAttentionItem?: (itemId: string) => void;
}

interface RowDraft {
  brand: string;
  domain: string;
  saving: boolean;
  error: string | null;
  notice: string | null;
}

const KIND_BADGE_STYLE: Record<ClassifiedBrandRow['kind'], React.CSSProperties> = {
  mapped_official: { backgroundColor: '#dcfce7', color: '#166534' },
  missing_brand: { backgroundColor: '#fee2e2', color: '#991b1b' },
  unmapped_brand: { backgroundColor: '#ffedd5', color: '#9a3412' },
  mismatched_authority: { backgroundColor: '#fef9c3', color: '#854d0e' },
  distributor_exempt: { backgroundColor: '#e0f2fe', color: '#075985' },
};

export function BrandGateView({
  batchId,
  onBack,
  onOpenSettings,
  onOpenPreflight,
  onOpenAttentionItem,
}: BrandGateViewProps) {
  const [projections, setProjections] = useState<BrandGateProjections | null>(null);
  const [projectionsLoading, setProjectionsLoading] = useState(true);
  const [rows, setRows] = useState<ClassifiedBrandRow[]>([]);
  const [itemsCursor, setItemsCursor] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  // Canonical brand pool for the brand comboboxes below (EXISTING
  // getBrandSites client: brandSites spellings + catalogBrands). Empty on
  // failed reads — inputs degrade to free-text entry, never broken.
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const brandOptionsRef = useRef<string[]>([]);
  brandOptionsRef.current = brandOptions;

  const loadItems = useCallback(
    async (cursor: string | null, projectionSnapshot: BrandGateProjections | null) => {
      const gen = generation.current;
      setItemsLoading(true);
      try {
        // One bounded page per request; the caller decides whether to chase.
        const res = await getStageReadItems(batchId, {
          limit: STAGE_READ_LIMIT_DEFAULT,
          ...(cursor ? { cursor } : {}),
        });
        if (generation.current !== gen) return;
        const ctx = buildBrandRowContext(
          projectionSnapshot?.preflight.value?.blockers.missingDomainBrands ?? [],
          projectionSnapshot?.blockers.value?.blockers ?? [],
        );
        const classified = classifyBrandRows(res.items, ctx);
        setRows((prev) => (cursor ? [...prev, ...classified] : classified));
        setItemsCursor(res.nextCursor);
        setItemsError(null);
      } catch (err) {
        if (generation.current !== gen) return;
        // Failed item reads show unknown — never a healthy-looking list.
        setItemsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (generation.current === gen) setItemsLoading(false);
      }
    },
    [batchId],
  );

  const refreshEpoch = useCallback(async () => {
    // Action success refetches ALL projections; the view never locally
    // marks an item unblocked — only a fresh successful server response
    // can clear a blocker.
    const gen = generation.current;
    setRefreshing(true);
    setProjectionsLoading(true);
    try {
      const res = await getBrandGateProjections(batchId);
      if (generation.current !== gen) return;
      setProjections(res);
      setRows([]);
      setItemsCursor(null);
      setItemsError(null);
      setDrafts({});
      await loadItems(null, res);
    } finally {
      if (generation.current === gen) {
        setProjectionsLoading(false);
        setRefreshing(false);
      }
    }
  }, [batchId, loadItems]);

  // Initial epoch + batch switch: reset everything so a stale prior batch
  // never flashes another batch's health. Bounded: one projections call
  // (2 reads) + one items page per epoch.
  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;
    setProjections(null);
    setProjectionsLoading(true);
    setRows([]);
    setItemsCursor(null);
    setItemsError(null);
    setDrafts({});
    setRefreshing(false);
    void (async () => {
      try {
        const res = await getBrandGateProjections(batchId);
        if (generation.current !== gen) return;
        setProjections(res);
        setProjectionsLoading(false);
        await loadItems(null, res);
      } catch (err) {
        if (generation.current !== gen) return;
        const message = err instanceof Error ? err.message : String(err);
        setProjections({
          preflight: { ok: false, value: null, error: message },
          blockers: { ok: false, value: null, error: message },
        });
        setProjectionsLoading(false);
      }
    })();
  }, [batchId, loadItems]);

  const health = deriveBrandGateHealth({
    preflight: projections?.preflight.value ?? null,
    preflightError: projections && !projections.preflight.ok ? (projections.preflight.error ?? 'unknown error') : null,
    preflightLoading: projectionsLoading && !projections,
    blockers: projections?.blockers.value ?? null,
    blockersError: projections && !projections.blockers.ok ? (projections.blockers.error ?? 'unknown error') : null,
    blockersLoading: projectionsLoading && !projections,
  });

  const groups = selectBrandGateGroups(projections?.preflight.value ?? null);

  // One shared brand-pool read per mount (cached globally in
  // brand-combobox-logic; zero per-row requests).
  useEffect(() => {
    let cancelled = false;
    void getBrandOptions().then((opts) => {
      if (!cancelled) setBrandOptions(opts);
    });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  const updateDraft = useCallback((itemId: string, patch: Partial<RowDraft>) => {
    setDrafts((prev) => {
      const existing: RowDraft = prev[itemId] ?? {
        brand: '',
        domain: '',
        saving: false,
        error: null,
        notice: null,
      };
      return { ...prev, [itemId]: { ...existing, ...patch } };
    });
  }, []);

  const runRowMutation = useCallback(
    async (row: ClassifiedBrandRow, kind: 'brand' | 'domain', value: string) => {
      // Brand submits resolve to the canonical stored spelling so an
      // existing brand typed with variant casing still hits its
      // brand_sites key exactly (no ghost brands); genuinely new brands
      // pass through trimmed and untouched. Domain handling is untouched.
      const submit = kind === 'brand'
        ? resolveCanonicalBrand(value, brandOptionsRef.current)
        : value.trim();
      if (!submit || drafts[row.itemId]?.saving) return;
      updateDraft(row.itemId, { saving: true, error: null, notice: null });
      try {
        if (kind === 'brand') await assignItemBrand(row.itemId, submit);
        else await assignItemDomain(row.itemId, submit);
        // Success refetches; the row keeps its server-reported state until
        // the fresh response confirms the fix.
        await refreshEpoch();
      } catch (err) {
        updateDraft(row.itemId, {
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [drafts, refreshEpoch, updateDraft],
  );

  return (
    <div data-testid="brand-gate-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ ...typography.viewTitle, margin: 0, fontSize: '1.125rem' }}>Brand setup</h2>
        <p className="bws-muted" style={{ margin: '0.25rem 0 0 0', fontSize: '0.8125rem' }}>
          Step 0 view — brand mappings for this batch only. Not an execution stage, not a batch
          gate: ready products keep flowing through the existing release flow.
          {refreshing ? ' · refreshing…' : ''}
        </p>
      </div>

      {/* ── TOP: preflight mapping coverage/advice + frozen domain panel ── */}
      <section data-testid="brand-gate-top" aria-label="Brand mapping coverage">
        <BrandHealthBanner
          healthState={health.state}
          headline={health.headline}
          detail={health.detail}
          readyCount={health.readyCount}
          heldCount={health.heldCount}
          totalItems={health.totalItems}
          readyCanContinue={health.readyCanContinue}
          parkedCheckUnknown={health.parkedCheckUnknown}
          onOpenPreflight={onOpenPreflight}
        />
        <div
          style={{
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '12px 14px',
            fontSize: '0.8125rem',
            color: colors.ledgerCharcoal,
          }}
        >
          <p style={{ margin: '0 0 6px 0' }}>
            <strong>Supplier-qualified paths stay advisory.</strong> A qualified distributor record
            with no official domain and a null source URL remains extraction-eligible and
            profile-free — it is never forced through an official domain, and policy-v0 rows keep
            their existing unclaimable behavior.
          </p>
          <p style={{ margin: 0 }} className="bws-muted">
            Brand→domain mappings are owned in{' '}
            {onOpenSettings ? (
              <button
                type="button"
                data-testid="brand-gate-settings-link"
                onClick={onOpenSettings}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: colors.uniformGreen,
                  fontWeight: 600,
                  fontSize: '0.8125rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                Settings
              </button>
            ) : (
              'Settings'
            )}
            . Unknown or mismatched official authority still blocks official auto-accept and
            resolves in the frozen attention flow below.
          </p>
        </div>
        <div style={{ marginTop: 12 }}>
          <BrandDomainSetupPanel batchId={batchId} />
        </div>
      </section>

      {/* ── BOTTOM: per-item brand fixes + grouped assignment panel ── */}
      <section data-testid="brand-gate-items" aria-label="Per-item brand fixes">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.9375rem', fontFamily: fonts.body }}>
          Per-item brand fixes
        </h3>
        <BrandAssignmentPanel batchId={batchId} onBrandAssigned={() => void refreshEpoch()} />

        {itemsError && (
          <div
            role="alert"
            data-testid="brand-gate-items-error"
            style={{
              backgroundColor: '#fef2f2',
              color: '#991b1b',
              border: '1px solid #fecaca',
              borderRadius: rounded.md,
              padding: '10px 14px',
              marginTop: 12,
              fontSize: '0.8125rem',
            }}
          >
            Item list unavailable ({itemsError}) — brand health is unknown, not healthy.
            {rows.length === 0 && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => void loadItems(null, projections)}
                  disabled={itemsLoading}
                  style={{
                    backgroundColor: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    padding: '0.375rem 0.75rem',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: colors.uniformGreen,
                    cursor: 'pointer',
                    minHeight: 32,
                  }}
                >
                  {itemsLoading ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            )}
          </div>
        )}

        {!itemsError && !itemsLoading && rows.length === 0 && (
          <div className="bws-muted" data-testid="brand-gate-items-empty" style={{ padding: '1.5rem 1rem', textAlign: 'center', fontSize: '0.8125rem' }}>
            No per-item rows in the current bounded page. Grouped fixes above remain available.
          </div>
        )}

        {rows.length > 0 && (
          <div className="bws-table-scroll" style={{ marginTop: 4 }}>
            <table className="bws-results-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Brand state</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BrandFixRow
                    key={row.itemId}
                    row={row}
                    draft={drafts[row.itemId]}
                    brandOptions={brandOptions}
                    onDraft={updateDraft}
                    onAssign={(kind, value) => void runRowMutation(row, kind, value)}
                    onOpenAttentionItem={onOpenAttentionItem}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {itemsLoading && rows.length === 0 && !itemsError && (
          <div className="bws-muted" style={{ padding: '1rem 0', fontSize: '0.8125rem' }}>
            Loading per-item rows…
          </div>
        )}

        {itemsCursor && !itemsError && (
          <button
            type="button"
            data-testid="brand-gate-load-more"
            onClick={() => void loadItems(itemsCursor, projections)}
            disabled={itemsLoading}
            style={{
              marginTop: 12,
              backgroundColor: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.md,
              padding: '0.5rem 0.875rem',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: colors.uniformGreen,
              cursor: 'pointer',
              minHeight: 36,
            }}
          >
            {itemsLoading ? 'Loading…' : 'Load more'}
          </button>
        )}

        <p className="bws-muted" style={{ margin: '8px 0 0 0', fontSize: '0.75rem' }}>
          {groups.totalHeld > 0
            ? `${groups.totalHeld} held by the server until their brand is fixed — fixes re-read the server, nothing is cleared locally.`
            : 'No server-held items reported by preflight.'}{' '}
          For page-level verification, use the existing attention queue rather than this list.
        </p>
      </section>

      <div>
        <button
          type="button"
          onClick={onBack}
          style={{
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.375rem 0.75rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 32,
          }}
        >
          Back to stages
        </button>
      </div>
    </div>
  );
}

function BrandHealthBanner({
  healthState,
  headline,
  detail,
  readyCount,
  heldCount,
  totalItems,
  readyCanContinue,
  parkedCheckUnknown,
  onOpenPreflight,
}: {
  healthState: 'loading' | 'error' | 'unknown' | 'attention' | 'measured';
  headline: string;
  detail: string;
  readyCount: number | null;
  heldCount: number | null;
  totalItems: number | null;
  readyCanContinue: boolean;
  parkedCheckUnknown: boolean;
  onOpenPreflight?: () => void;
}) {
  const palette: Record<typeof healthState, { bg: string; fg: string; border: string }> = {
    loading: { bg: '#f3f4f6', fg: '#374151', border: '#e5e7eb' },
    error: { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
    unknown: { bg: '#f3f4f6', fg: '#374151', border: '#e5e7eb' },
    attention: { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
    measured: { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0' },
  };
  const tone = palette[healthState];
  return (
    <div
      role={healthState === 'error' ? 'alert' : 'status'}
      data-testid="brand-gate-health"
      data-health-state={healthState}
      style={{
        backgroundColor: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        borderRadius: rounded.md,
        padding: '12px 14px',
        marginBottom: 12,
        fontSize: '0.8125rem',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <strong style={{ display: 'block', fontSize: '0.875rem' }}>{headline}</strong>
          <span style={{ display: 'block', marginTop: 4 }}>{detail}</span>
          {parkedCheckUnknown && healthState !== 'loading' && (
            <span style={{ display: 'block', marginTop: 4, fontWeight: 600 }}>
              Parked-item check: unknown (failed or unavailable reads are never shown as healthy).
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <span data-testid="brand-gate-counts" style={{ fontWeight: 700 }}>
            {readyCount !== null && totalItems !== null
              ? `${readyCount} of ${totalItems} ready${heldCount !== null && heldCount > 0 ? ` · ${heldCount} held` : ''}`
              : 'Counts unavailable'}
          </span>
          {readyCanContinue && onOpenPreflight && (
            <button
              type="button"
              data-testid="brand-gate-release-link"
              onClick={onOpenPreflight}
              style={{
                backgroundColor: colors.uniformGreen,
                border: 'none',
                borderRadius: rounded.md,
                padding: '0.4375rem 0.875rem',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: colors.feedBagCream,
                cursor: 'pointer',
                minHeight: 36,
              }}
            >
              Review ready items for release
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BrandFixRow({
  row,
  draft,
  brandOptions,
  onDraft,
  onAssign,
  onOpenAttentionItem,
}: {
  row: ClassifiedBrandRow;
  draft: RowDraft | undefined;
  brandOptions: string[];
  onDraft: (itemId: string, patch: Partial<RowDraft>) => void;
  onAssign: (kind: 'brand' | 'domain', value: string) => void;
  onOpenAttentionItem?: (itemId: string) => void;
}) {
  const badge = KIND_BADGE_STYLE[row.kind];
  const brandValue = draft?.brand ?? row.brand ?? '';
  const domainValue = draft?.domain ?? '';
  const saving = draft?.saving ?? false;

  return (
    <tr data-testid={`brand-fix-row-${row.itemId}`} data-row-kind={row.kind}>
      <td>
        <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>{row.name || row.upc}</div>
        <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
          {row.upc}
          {row.brand ? ` · ${row.brand}` : ''}
          {row.domain ? ` · ${row.domain}` : ''}
        </div>
      </td>
      <td>
        <span
          data-testid={`brand-row-kind-${row.itemId}`}
          style={{
            display: 'inline-block',
            fontSize: '0.6875rem',
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 9999,
            ...badge,
          }}
        >
          {BRAND_ROW_KIND_LABELS[row.kind]}
        </span>
        <div className="bws-muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
          {row.advice}
        </div>
      </td>
      <td>
        {row.kind === 'distributor_exempt' && (
          <span className="bws-muted" style={{ fontSize: '0.75rem' }}>
            No brand fix needed — {BRAND_ROW_KIND_ADVICE.distributor_exempt}
          </span>
        )}
        {row.kind === 'mismatched_authority' && (
          <span style={{ fontSize: '0.75rem' }}>
            {onOpenAttentionItem ? (
              <button
                type="button"
                data-testid={`brand-row-resolve-${row.itemId}`}
                onClick={() => onOpenAttentionItem(row.itemId)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: colors.uniformGreen,
                  fontWeight: 600,
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                Open in Needs Attention →
              </button>
            ) : (
              <span className="bws-muted">Resolve in the attention queue.</span>
            )}
          </span>
        )}
        {(row.kind === 'missing_brand' || row.kind === 'unmapped_brand') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
              Brand
              <span style={{ display: 'block', width: '100%', marginTop: 2 }}>
                <BrandCombobox
                  value={brandValue}
                  onChange={(next) => onDraft(row.itemId, { brand: next, error: null })}
                  onCommit={(next) => onAssign('brand', next)}
                  options={brandOptions}
                  disabled={saving}
                  ariaLabel={`Brand for ${row.name || row.upc}`}
                  placeholder="Enter brand name"
                  inputStyle={{
                    display: 'block',
                    width: '100%',
                    padding: '0.375rem 0.5rem',
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    fontSize: '0.8125rem',
                    fontFamily: fonts.body,
                  }}
                />
              </span>
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                data-testid={`brand-row-assign-brand-${row.itemId}`}
                onClick={() => onAssign('brand', brandValue)}
                disabled={saving || !brandValue.trim()}
                style={{
                  backgroundColor: colors.uniformGreen,
                  border: 'none',
                  borderRadius: rounded.md,
                  padding: '0.375rem 0.75rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: colors.feedBagCream,
                  cursor: saving || !brandValue.trim() ? 'not-allowed' : 'pointer',
                  opacity: saving || !brandValue.trim() ? 0.6 : 1,
                  minHeight: 32,
                }}
              >
                {saving ? 'Assigning…' : 'Assign brand'}
              </button>
            </div>
            {row.kind === 'unmapped_brand' && (
              <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
                Official domain
                <input
                  type="text"
                  value={domainValue}
                  disabled={saving}
                  aria-label={`Official domain for ${row.brand ?? row.name ?? row.upc}`}
                  placeholder="brand.com"
                  onChange={(e) => onDraft(row.itemId, { domain: e.target.value, error: null })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onAssign('domain', domainValue);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    marginTop: 2,
                    padding: '0.375rem 0.5rem',
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    fontSize: '0.8125rem',
                    fontFamily: fonts.body,
                  }}
                />
              </label>
            )}
            {row.kind === 'unmapped_brand' && (
              <div>
                <button
                  type="button"
                  data-testid={`brand-row-assign-domain-${row.itemId}`}
                  onClick={() => onAssign('domain', domainValue)}
                  disabled={saving || !domainValue.trim()}
                  style={{
                    backgroundColor: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    padding: '0.375rem 0.75rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: colors.uniformGreen,
                    cursor: saving || !domainValue.trim() ? 'not-allowed' : 'pointer',
                    opacity: saving || !domainValue.trim() ? 0.6 : 1,
                    minHeight: 32,
                  }}
                >
                  {saving ? 'Saving…' : 'Save domain'}
                </button>
              </div>
            )}
            {draft?.error && (
              <span role="alert" style={{ fontSize: '0.75rem', color: colors.signetBurgundy }}>
                {draft.error} — server holds are unchanged.
              </span>
            )}
          </div>
        )}
        {row.kind === 'mapped_official' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            <span className="bws-muted" style={{ fontSize: '0.75rem' }}>
              No action needed.
            </span>
            <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
              Override brand
              <span style={{ display: 'block', width: '100%', marginTop: 2 }}>
                <BrandCombobox
                  value={brandValue}
                  onChange={(next) => onDraft(row.itemId, { brand: next, error: null })}
                  onCommit={(next) => onAssign('brand', next)}
                  options={brandOptions}
                  disabled={saving}
                  ariaLabel={`Brand for ${row.name || row.upc}`}
                  placeholder="Enter brand name"
                  inputStyle={{
                    display: 'block',
                    width: '100%',
                    padding: '0.375rem 0.5rem',
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    fontSize: '0.8125rem',
                    fontFamily: fonts.body,
                  }}
                />
              </span>
            </label>
            <div>
              <button
                type="button"
                data-testid={`brand-row-assign-brand-${row.itemId}`}
                onClick={() => onAssign('brand', brandValue)}
                disabled={saving || !brandValue.trim()}
                style={{
                  backgroundColor: colors.uniformGreen,
                  border: 'none',
                  borderRadius: rounded.md,
                  padding: '0.375rem 0.75rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: colors.feedBagCream,
                  cursor: saving || !brandValue.trim() ? 'not-allowed' : 'pointer',
                  opacity: saving || !brandValue.trim() ? 0.6 : 1,
                  minHeight: 32,
                }}
              >
                {saving ? 'Assigning…' : 'Assign brand'}
              </button>
            </div>
            {draft?.error && (
              <span role="alert" style={{ fontSize: '0.75rem', color: colors.signetBurgundy }}>
                {draft.error} — server holds are unchanged.
              </span>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
