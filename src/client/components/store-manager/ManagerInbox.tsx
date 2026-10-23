import React, { useEffect, useCallback, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type {
  StoreManagerInboxItem,
  StoreManagerNotification,
  StoreManagerSeverity,
} from '../../store-manager-api';
import {
  sortInboxItems,
  summarizeInbox,
  formatInboxAge,
  isInboxItemStale,
  lifecycleLabel,
  inboxCommandPrefill,
} from '../../store-manager-inbox-logic';
import type { EventStreamStatus } from '../../hooks/useStoreManagerEvents';

interface ManagerInboxProps {
  open: boolean;
  onClose: () => void;
  /** Live notifications from the SSE hook (used for the unread badge + inline list). */
  notifications?: StoreManagerNotification[];
  eventStatus?: EventStreamStatus;
  variant?: 'modal' | 'inline';
  onAskManager?: (prompt: string) => void;
}

const SEVERITY_STYLE: Record<StoreManagerSeverity, { color: string; background: string; label: string }> = {
  critical: { color: '#8b1e2d', background: '#fdeaea', label: 'Urgent' },
  warning: { color: '#8a6116', background: '#fdf3dd', label: 'Please review' },
  info: { color: '#2f5d3a', background: '#e9f4ec', label: 'Note' },
};

/**
 * Manager Inbox — the single triage queue. Items are workspace-scoped rows
 * reconciled from deterministic collectors; opening an item re-reads current
 * authority (stale rows stay visible but are flagged). Actions are operator
 * ack/resolve only — nothing here stages, publishes, repairs, or alters
 * onboarding state, and nothing executes automatically on click.
 */
export function ManagerInbox({ open, onClose, notifications = [], eventStatus = 'closed', variant = 'inline', onAskManager }: ManagerInboxProps) {
  const [items, setItems] = useState<StoreManagerInboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<{ isCurrent: boolean; currentCount: number | null } | null>(null);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const { reconcileStoreManagerInbox, fetchStoreManagerInbox } = await import('../../store-manager-api');
      await reconcileStoreManagerInbox();
      const data = await fetchStoreManagerInbox();
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Manager Inbox.');
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const summary = summarizeInbox(items);
  const sorted = sortInboxItems(items);

  const openItem = async (item: StoreManagerInboxItem) => {
    setOpenItemId(item.id);
    setOpenDetail(null);
    try {
      const { fetchStoreManagerInboxItem } = await import('../../store-manager-api');
      const result = await fetchStoreManagerInboxItem(item.id);
      setOpenDetail({ isCurrent: result.isCurrent, currentCount: result.current?.count ?? null });
    } catch {
      setOpenDetail(null);
    }
  };

  const act = async (item: StoreManagerInboxItem, action: 'acknowledge' | 'resolve') => {
    setBusyId(item.id);
    setError(null);
    try {
      const api = await import('../../store-manager-api');
      const updated =
        action === 'acknowledge'
          ? await api.acknowledgeStoreManagerInboxItem(item.id)
          : await api.resolveStoreManagerInboxItem(item.id);
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed.`);
    } finally {
      setBusyId(null);
    }
  };

  const unread = notifications.filter((n) => n.readAt === null).length;

  const isInline = variant === 'inline';

  const cardContent = (
    <div
      role={isInline ? 'region' : 'dialog'}
      aria-modal={isInline ? undefined : true}
      aria-label="Needs attention"
      onClick={(e) => e.stopPropagation()}
      style={{
        width: '100%',
        maxWidth: isInline ? 900 : 540,
        maxHeight: isInline ? undefined : '85vh',
        overflowY: 'auto',
        padding: 24,
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        boxShadow: isInline ? '0 1px 3px rgba(33,20,20,0.04)' : '0 20px 25px -5px rgba(0, 0, 0, 0.15)',
        fontFamily: fonts.body,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal }}>
            Needs attention {unread > 0 ? <span style={{ color: colors.signetBurgundy }}>({unread} new)</span> : null}
          </div>
          <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 2 }}>
            {summary.total} {summary.total === 1 ? 'item' : 'items'} · {summary.critical} urgent · {summary.warning} to review · {summary.info} notes · {summary.open} {summary.open === 1 ? 'item still needs' : 'items still need'} attention
            {eventStatus === 'live' ? ' · Updates are current' : eventStatus === 'reconnecting' ? ' · Refreshing updates' : ''}
          </div>
        </div>
        {isInline ? null : (
          <button type="button" onClick={onClose} aria-label="Close needs attention" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 12px' }}>
            ✕ Close
          </button>
        )}
      </div>

      {error ? <div style={{ fontSize: 12, color: colors.signetBurgundy, marginBottom: 8 }}>We couldn't load the latest updates. Please try again.</div> : null}
      {loading && sorted.length === 0 ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>Checking for updates…</div>
      ) : null}

      {!loading && sorted.length === 0 ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>Nothing needs your attention right now.</div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sorted.map((item) => {
          const sev = SEVERITY_STYLE[item.severity];
          const stale = isInboxItemStale(item);
          const prefill = inboxCommandPrefill(item);
          const detail = openItemId === item.id ? openDetail : null;
          return (
            <article
              key={item.id}
              aria-label={`${sev.label} item needing attention: ${item.title}`}
              onClick={() => void openItem(item)}
              style={{
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.md,
                padding: '12px 14px',
                background: colors.whiteSurface,
                boxShadow: '0 1px 2px rgba(33,20,20,0.03)',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: sev.color, background: sev.background, padding: '2px 6px', borderRadius: 4 }}>
                  {sev.label}
                </span>
                <span
                  style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, flex: 1 }}
                >
                  {item.title}
                </span>
                <span style={{ fontSize: 11, color: colors.mulchBrown }}>{formatInboxAge(item.lastSeenAt)}</span>
              </div>
              <div style={{ fontSize: 12, color: colors.mulchBrown, marginBottom: 6 }}>
                {item.summary} ·{' '}
                <span style={{ fontWeight: 600, color: stale ? colors.signetBurgundy : colors.uniformGreen }}>
                  {stale ? 'May be out of date' : lifecycleLabel(item.lifecycle)}
                </span>
              </div>
              {detail ? (
                <div style={{ fontSize: 11, color: detail.isCurrent ? colors.uniformGreen : colors.signetBurgundy, marginBottom: 6 }}>
                  {detail.isCurrent
                    ? 'Checked just now. This still needs attention.'
                    : 'This may have changed. Open the original item again before deciding.'}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <div style={{ flex: 1 }} />
                {prefill && onAskManager ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAskManager(prefill);
                    }}
                    style={{ fontSize: 11, padding: '3px 10px', background: colors.seedlingGreen }}
                  >
                    Ask for help ➔
                  </button>
                ) : null}
                {item.lifecycle === 'open' ? (
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    className="btn btn-outline"
                    onClick={(e) => { e.stopPropagation(); void act(item, 'acknowledge'); }}
                    style={{ fontSize: 11, padding: '3px 10px' }}
                  >
                    Mark as seen
                  </button>
                ) : null}
                {item.lifecycle === 'open' || item.lifecycle === 'acknowledged' ? (
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    className="btn btn-outline"
                    onClick={(e) => { e.stopPropagation(); void act(item, 'resolve'); }}
                    style={{ fontSize: 11, padding: '3px 10px' }}
                  >
                    Mark handled
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );

  if (isInline) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', background: colors.feedBagCream }}>
        {cardContent}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(33, 20, 20, 0.45)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      {cardContent}
    </div>
  );
}
