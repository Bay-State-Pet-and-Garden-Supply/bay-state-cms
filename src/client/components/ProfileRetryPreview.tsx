/**
 * ProfileRetryPreview.tsx — shows items blocked in Extraction due to
 * missing/unhealthy profiles, and lets operators retry them.
 *
 * Used from OnboardingSettings (domain detail panel) via the
 * "Show blocked items" button.
 */

import React, { useState, useEffect } from 'react';
import {
  getProfileRetryPreview,
  retryProfileBlockedItems,
} from '../onboarding-api';
import type { ProfileBlockedItem } from '../../shared/schemas/onboarding';

// ─── Props ──────────────────────────────────────────────────────────────────

interface ProfileRetryPreviewProps {
  domain: string;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateUrl(url: string | null, maxLen = 50): string {
  if (!url) return '';
  return url.length > maxLen ? url.slice(0, maxLen) + '…' : url;
}

function truncate(str: string | null, maxLen = 60): string {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 1100,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    background: '#fff',
    borderRadius: 12,
    width: 'min(90vw, 960px)',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: '1px solid #e5e7eb',
    background: '#f9fafb',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: '#111827',
    margin: 0,
  },
  headerDomain: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: 400,
    marginLeft: 8,
  },
  closeBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 13,
    color: '#374151',
    fontWeight: 500,
  },
  body: {
    padding: '20px 24px',
    overflowY: 'auto' as const,
    flex: 1,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 0',
    fontSize: 14,
    color: '#6b7280',
    gap: 10,
  },
  healthBanner: {
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 12,
    color: '#4b5563',
    marginBottom: 12,
  },
  spinner: {
    display: 'inline-block',
    width: 20,
    height: 20,
    border: '2px solid #e5e7eb',
    borderTopColor: '#2563eb',
    borderRadius: '50%',
    animation: 'spinner 0.6s linear infinite',
  } as React.CSSProperties,
  errorBox: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 6,
    padding: '16px 20px',
    color: '#991b1b',
    fontSize: 13,
    lineHeight: 1.5,
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: '48px 0',
    color: '#6b7280',
    fontSize: 14,
  },
  checkIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
    borderRadius: '50%',
    background: '#dcfce7',
    color: '#16a34a',
    fontSize: 24,
    marginBottom: 12,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 13,
  },
  th: {
    borderBottom: '2px solid #e5e7eb',
    textAlign: 'left' as const,
    padding: '8px 10px',
    color: '#4b5563',
    fontWeight: 600,
    fontSize: 12,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  td: {
    borderBottom: '1px solid #f3f4f6',
    padding: '8px 10px',
    color: '#374151',
    verticalAlign: 'top' as const,
  },
  checkbox: {
    width: 18,
    height: 18,
    cursor: 'pointer',
    accentColor: '#2563eb',
  },
  retryButton: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 24px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  } as React.CSSProperties,
  retryButtonDisabled: {
    background: '#93c5fd',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 24px',
    cursor: 'not-allowed',
    fontWeight: 600,
    fontSize: 14,
  } as React.CSSProperties,
  actionBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 24px',
    borderTop: '1px solid #e5e7eb',
    background: '#f9fafb',
  },
  summary: {
    fontSize: 13,
    color: '#6b7280',
  },
  successBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: '#dcfce7',
    color: '#166534',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 4,
    padding: '2px 8px',
  },
  retryingBadge: {
    fontSize: 13,
    color: '#2563eb',
    fontWeight: 500,
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileRetryPreview({ domain, onClose }: ProfileRetryPreviewProps) {
  const [items, setItems] = useState<ProfileBlockedItem[]>([]);
  const [health, setHealth] = useState<{ healthy: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [retriedCount, setRetriedCount] = useState<number | null>(null);
  // Track per-item retry success to show checkmarks
  const [retriedItems, setRetriedItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await getProfileRetryPreview(domain);
        if (!cancelled) {
          setItems(result.items);
          setHealth(result.health ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load blocked items',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [domain]);

  const handleToggleSelect = (itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.itemId)));
    }
  };

  const handleRetry = async () => {
    if (selectedIds.size === 0) return;
    setRetrying(true);
    try {
      const result = await retryProfileBlockedItems(domain, Array.from(selectedIds));
      setRetriedCount(result.accepted);
      setRetriedItems((prev) => {
        const next = new Set(prev);
        for (const id of selectedIds) {
          next.add(id);
        }
        return next;
      });
      // Remove retried items from the list after a brief delay
      setTimeout(() => {
        setItems((prev) => prev.filter((i) => !selectedIds.has(i.itemId)));
        setSelectedIds(new Set());
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  const allSelected = items.length > 0 && selectedIds.size === items.length;

  return (
    <div style={styles.overlay} onClick={onClose}>
      {/* Stop propagation on the card so clicking inside doesn't close */}
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div style={styles.header}>
          <h2 style={styles.headerTitle}>
            Profile Retry Preview
            <span style={styles.headerDomain}>— {domain}</span>
          </h2>
          <button
            type="button"
            style={styles.closeBtn}
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {/* ── Body ── */}
        <div style={styles.body}>
          {/* Reviewed health (read-only, never gates the deliberate retry) */}
          {!loading && !error && health && (
            <div style={styles.healthBanner}>
              {health.healthy
                ? 'Reviewed health: healthy — automatic release applies to newly blocked items.'
                : `Reviewed health: not healthy (${health.reason ?? 'unknown'}) — selected retry stays available as a deliberate operator act.`}
            </div>
          )}
          {/* Loading */}
          {loading && (
            <div style={styles.loading}>
              <div style={styles.spinner} />
              <span>Checking for blocked items…</span>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div style={styles.errorBox}>
              <strong>Unable to load blocked items.</strong>
              <p style={{ margin: '6px 0 0' }}>
                Failed to load blocked items.
              </p>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: '#b91c1c' }}>
                {error}
              </p>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && items.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.checkIcon}>✓</div>
              <p style={{ fontWeight: 600, color: '#374151', margin: '0 0 4px' }}>
                No blocked items found for this domain.
              </p>
              <p style={{ margin: 0 }}>
                All extraction items for {domain} are either healthy or in earlier stages.
              </p>
            </div>
          )}

          {/* Items table */}
          {!loading && !error && items.length > 0 && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: 40 }}>
                    <input
                      type="checkbox"
                      style={styles.checkbox}
                      checked={allSelected}
                      onChange={handleSelectAll}
                    />
                  </th>
                  <th style={styles.th}>UPC</th>
                  <th style={styles.th}>Product Name</th>
                  <th style={styles.th}>Source URL</th>
                  <th style={styles.th}>Error</th>
                  <th style={styles.th}>Blocked At</th>
                  <th style={{ ...styles.th, width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isRetried = retriedItems.has(item.itemId);
                  const isSelected = selectedIds.has(item.itemId);
                  return (
                    <tr
                      key={item.itemId}
                      style={{
                        background: isRetried ? '#f0fdf4' : isSelected ? '#eff6ff' : undefined,
                        opacity: isRetried ? 0.6 : 1,
                        transition: 'opacity 1s ease',
                      }}
                    >
                      <td style={styles.td}>
                        <input
                          type="checkbox"
                          style={styles.checkbox}
                          checked={isSelected || isRetried}
                          disabled={isRetried}
                          onChange={() => handleToggleSelect(item.itemId)}
                        />
                      </td>
                      <td style={styles.td}>
                        <code style={{ fontSize: 12, color: '#4b5563' }}>{item.upc}</code>
                      </td>
                      <td style={{ ...styles.td, fontWeight: 500 }}>
                        {truncate(item.name, 40)}
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{ color: '#2563eb', fontSize: 12, wordBreak: 'break-all' }}
                          title={item.sourceUrl ?? undefined}
                        >
                          {truncateUrl(item.sourceUrl, 35)}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{ color: '#dc2626', fontSize: 12 }}
                          title={item.errorMessage ?? undefined}
                        >
                          {truncate(item.errorMessage, 50)}
                        </span>
                      </td>
                      <td style={{ ...styles.td, fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {formatDate(item.blockedAt)}
                      </td>
                      <td style={styles.td}>
                        {isRetried && (
                          <span style={styles.successBadge}>✓ Retried</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Action bar ── */}
        <div style={styles.actionBar}>
          <span style={styles.summary}>
            {items.length > 0
              ? `${items.length} blocked item${items.length !== 1 ? 's' : ''} · ${selectedIds.size} selected`
              : ''}
            {retriedCount !== null && (
              <span style={{ marginLeft: 12, color: '#16a34a', fontWeight: 600 }}>
                · {retriedCount} accepted for retry
              </span>
            )}
          </span>
          {retrying ? (
            <span style={styles.retryingBadge}>Retrying…</span>
          ) : retriedCount !== null ? (
            <span style={{ ...styles.successBadge, padding: '10px 24px', fontSize: 14 }}>
              ✓ Retry complete
            </span>
          ) : (
            <button
              type="button"
              style={
                selectedIds.size === 0
                  ? styles.retryButtonDisabled
                  : styles.retryButton
              }
              disabled={selectedIds.size === 0}
              onClick={handleRetry}
            >
              Retry Selected ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {/* Inject spinner animation keyframes */}
      <style>{`
        @keyframes spinner {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export default ProfileRetryPreview;
