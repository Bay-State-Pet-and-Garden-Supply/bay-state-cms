import React, { useState, useEffect } from 'react';
import { getWeeklyReport, type WeeklyReportProductItem } from '../onboarding-api';
import { toCanonicalStage } from '../../shared/onboarding-stage-vocabulary';

/** Slice 5b native: canonical promotion check (dual read — either stored spelling). */
function isPromotedReportItem(item: WeeklyReportProductItem): boolean {
  if (item.status === 'promoted') return true;
  try {
    return toCanonicalStage(item.stage) === 'create_drafts' && item.stageStatus === 'completed';
  } catch {
    return false;
  }
}

export interface WeeklyReportPanelProps {
  variant?: 'inline' | 'modal';
  onClose?: () => void;
}

type DatePreset = 'past7' | 'currentWeek' | 'past14' | 'past30' | 'custom';

const STORAGE_KEY = 'shopsite_weekly_report_settings_v1';

interface StoredReportSettings {
  hours?: string;
  preset?: DatePreset;
  onlyPromoted?: boolean;
  includeUpc?: boolean;
  includeBrand?: boolean;
}

function loadStoredSettings(): StoredReportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

function saveStoredSettings(settings: Partial<StoredReportSettings>) {
  try {
    const current = loadStoredSettings();
    const updated = { ...current, ...settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
}

export function WeeklyReportPanel({ variant = 'inline', onClose }: WeeklyReportPanelProps) {
  const initialSettings = loadStoredSettings();

  // Default to per-day schedule or restored schedule
  const [hours, setHours] = useState(initialSettings.hours ?? 'Thursday 12-6\nFriday 12-6');
  const [preset, setPreset] = useState<DatePreset>(initialSettings.preset ?? 'past7');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [onlyPromoted, setOnlyPromoted] = useState(initialSettings.onlyPromoted ?? true);
  const [includeUpc, setIncludeUpc] = useState(initialSettings.includeUpc ?? true);
  const [includeBrand, setIncludeBrand] = useState(initialSettings.includeBrand ?? true);

  // Persist settings whenever toggles or values change
  useEffect(() => {
    saveStoredSettings({
      hours,
      preset,
      onlyPromoted,
      includeUpc,
      includeBrand,
    });
  }, [hours, preset, onlyPromoted, includeUpc, includeBrand]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reportItems, setReportItems] = useState<WeeklyReportProductItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [promotedCount, setPromotedCount] = useState(0);
  const [qualitySummary, setQualitySummary] = useState<import('../classification-metrics-view').QualityDisplay | null>(null);

  const [customText, setCustomText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Compute start/end ISO dates based on preset
  const getDateRange = () => {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();

    if (preset === 'past7') {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      return { start, end };
    }
    if (preset === 'currentWeek') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(now.setDate(diff));
      mon.setHours(0, 0, 0, 0);
      return { start: mon.toISOString(), end };
    }
    if (preset === 'past14') {
      const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      return { start, end };
    }
    if (preset === 'past30') {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      return { start, end };
    }
    if (preset === 'custom' && customStartDate) {
      const sDate = new Date(customStartDate);
      const eDate = customEndDate ? new Date(customEndDate) : now;
      return { start: sDate.toISOString(), end: eDate.toISOString() };
    }

    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return { start, end };
  };

  const fetchReport = async () => {
    setLoading(true);
    setError('');
    try {
      const { start, end } = getDateRange();
      const res = await getWeeklyReport(start, end);
      setReportItems(res.items);
      setTotalCount(res.totalCount);
      setPromotedCount(res.promotedCount);
      setQualitySummary(res.qualitySummary ?? null);
      setCustomText(null); // Reset manual overrides when refetching
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [preset, customStartDate, customEndDate]);

  // Filter items based on user selection
  const filteredItems = reportItems.filter(item => {
    if (onlyPromoted) {
      return isPromotedReportItem(item);
    }
    return true;
  });

  // Generate the formatted email string
  const generateEmailBody = () => {
    if (customText !== null) return customText;

    let productList = '';
    if (filteredItems.length === 0) {
      productList = '(No products uploaded or promoted during this period)';
    } else {
      productList = filteredItems
        .map(item => {
          const details: string[] = [];
          if (includeBrand && item.brandHint) {
            details.push(`Brand: ${item.brandHint}`);
          }
          if (includeUpc && item.upc) {
            details.push(`UPC/SKU: ${item.upc}`);
          }
          const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
          return `- ${item.name}${detailStr}`;
        })
        .join('\n');
    }

    const formattedHours = hours.trim() || '(No hours specified)';

    return `Hello,

This week I worked:
${formattedHours}

Products:
${productList}`;
  };

  const currentEmailBody = generateEmailBody();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentEmailBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  const handleSendEmail = () => {
    const subject = encodeURIComponent('Weekly Status Report');
    const body = encodeURIComponent(currentEmailBody);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  };

  const addPresetHours = (textToAdd: string) => {
    setHours(prev => {
      const trimmed = prev.trim();
      if (!trimmed) return textToAdd;
      if (trimmed.includes(textToAdd)) return trimmed;
      return `${trimmed}\n${textToAdd}`;
    });
  };

  const styles: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.65)',
      backdropFilter: 'blur(4px)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    modalContainer: {
      background: '#ffffff',
      borderRadius: 16,
      width: '100%',
      maxWidth: 740,
      maxHeight: '90vh',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
      overflow: 'hidden',
    },
    inlineContainer: {
      background: '#ffffff',
      borderRadius: 12,
      border: '1px solid #e5e7eb',
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    header: {
      padding: '20px 24px',
      borderBottom: '1px solid #e2e8f0',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      background: '#f8fafc',
    },
    title: {
      fontSize: 18,
      fontWeight: 700,
      color: '#0f172a',
      margin: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 20,
      cursor: 'pointer',
      color: '#64748b',
      padding: '4px 8px',
      borderRadius: 6,
    },
    body: {
      padding: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 20,
      overflowY: variant === 'modal' ? 'auto' : 'visible',
    },
    controlGroup: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      background: '#f8fafc',
      padding: 16,
      borderRadius: 12,
      border: '1px solid #e2e8f0',
    },
    row: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 16,
      alignItems: 'flex-start',
    },
    field: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      flex: 1,
      minWidth: 200,
    },
    label: {
      fontSize: 13,
      fontWeight: 600,
      color: '#334155',
    },
    hoursTextarea: {
      padding: '10px 12px',
      borderRadius: 8,
      border: '1px solid #cbd5e1',
      fontSize: 13,
      fontFamily: 'inherit',
      color: '#0f172a',
      background: '#ffffff',
      outline: 'none',
      minHeight: 70,
      resize: 'vertical',
      lineHeight: 1.5,
    },
    quickChipsRow: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 4,
    },
    chipBtn: {
      background: '#ffffff',
      border: '1px solid #cbd5e1',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 12,
      color: '#2563eb',
      fontWeight: 500,
      cursor: 'pointer',
    },
    clearChipBtn: {
      background: '#fff1f2',
      border: '1px solid #fecdd3',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 12,
      color: '#e11d48',
      fontWeight: 500,
      cursor: 'pointer',
    },
    input: {
      padding: '8px 12px',
      borderRadius: 8,
      border: '1px solid #cbd5e1',
      fontSize: 14,
      color: '#0f172a',
      background: '#ffffff',
      outline: 'none',
    },
    select: {
      padding: '8px 12px',
      borderRadius: 8,
      border: '1px solid #cbd5e1',
      fontSize: 14,
      color: '#0f172a',
      background: '#ffffff',
      outline: 'none',
      cursor: 'pointer',
    },
    checkboxRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      fontSize: 13,
      color: '#475569',
      flexWrap: 'wrap',
    },
    checkboxLabel: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      cursor: 'pointer',
      userSelect: 'none',
    },
    statsBar: {
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      fontSize: 13,
      color: '#64748b',
    },
    badge: {
      background: '#e0f2fe',
      color: '#0369a1',
      padding: '2px 8px',
      borderRadius: 12,
      fontWeight: 600,
      fontSize: 12,
    },
    qualitySummary: {
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 10,
      margin: '10px 0',
    },
    qualityChip: {
      background: '#f1f5f9',
      border: '1px solid #e2e8f0',
      borderRadius: 6,
      padding: '2px 8px',
      fontSize: 12,
    },
    textarea: {
      width: '100%',
      minHeight: 220,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.6,
      padding: 16,
      borderRadius: 12,
      border: '1px solid #cbd5e1',
      background: '#0f172a',
      color: '#f8fafc',
      resize: 'vertical',
      outline: 'none',
      boxSizing: 'border-box',
    },
    footer: {
      padding: '16px 24px',
      borderTop: '1px solid #e2e8f0',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      background: '#f8fafc',
    },
    btnGroup: {
      display: 'flex',
      gap: 10,
    },
    primaryBtn: {
      background: '#2563eb',
      color: '#ffffff',
      border: 'none',
      padding: '10px 18px',
      borderRadius: 8,
      fontSize: 14,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    },
    secondaryBtn: {
      background: '#ffffff',
      color: '#334155',
      border: '1px solid #cbd5e1',
      padding: '10px 18px',
      borderRadius: 8,
      fontSize: 14,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
    },
    copiedBadge: {
      background: '#dcfce7',
      color: '#15803d',
      border: '1px solid #86efac',
    },
  };

  const contentNode = (
    <div style={variant === 'modal' ? styles.modalContainer : styles.inlineContainer} onClick={e => e.stopPropagation()}>
      <div style={styles.header}>
        <h2 style={styles.title}>📊 Weekly Manager Report Generator</h2>
        {variant === 'modal' && onClose && (
          <button style={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        )}
      </div>

      <div style={styles.body}>
        <div style={styles.controlGroup}>
          <div style={styles.row}>
            <div style={{ ...styles.field, flex: 2 }}>
              <label style={styles.label}>Daily Hours Worked (Specify by Day)</label>
              <textarea
                style={styles.hoursTextarea}
                value={hours}
                onChange={e => setHours(e.target.value)}
                placeholder="e.g.&#10;Thursday 12-6&#10;Friday 12-6"
              />
              <div style={styles.quickChipsRow}>
                <span style={{ fontSize: 11, color: '#64748b', alignSelf: 'center' }}>Quick add:</span>
                <button type="button" style={styles.chipBtn} onClick={() => addPresetHours('Thursday 12-6')}>+ Thu 12-6</button>
                <button type="button" style={styles.chipBtn} onClick={() => addPresetHours('Friday 12-6')}>+ Fri 12-6</button>
                <button type="button" style={styles.chipBtn} onClick={() => addPresetHours('Saturday 12-6')}>+ Sat 12-6</button>
                <button type="button" style={styles.chipBtn} onClick={() => addPresetHours('Monday 9-5')}>+ Mon 9-5</button>
                <button type="button" style={styles.clearChipBtn} onClick={() => setHours('')}>Clear</button>
              </div>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Time Range</label>
              <select
                style={styles.select}
                value={preset}
                onChange={e => setPreset(e.target.value as DatePreset)}
              >
                <option value="past7">Past 7 Days</option>
                <option value="currentWeek">Current Week (Mon – Sun)</option>
                <option value="past14">Past 14 Days</option>
                <option value="past30">Past 30 Days</option>
                <option value="custom">Custom Range...</option>
              </select>

              {preset === 'custom' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  <div>
                    <label style={{ ...styles.label, fontSize: 12 }}>Start Date</label>
                    <input
                      type="date"
                      style={styles.input}
                      value={customStartDate}
                      onChange={e => setCustomStartDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ ...styles.label, fontSize: 12 }}>End Date</label>
                    <input
                      type="date"
                      style={styles.input}
                      value={customEndDate}
                      onChange={e => setCustomEndDate(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={styles.checkboxRow}>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={onlyPromoted}
              onChange={e => setOnlyPromoted(e.target.checked)}
            />
            Only Promoted Products
          </label>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={includeUpc}
              onChange={e => setIncludeUpc(e.target.checked)}
            />
            Include UPC/SKU
          </label>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={includeBrand}
              onChange={e => setIncludeBrand(e.target.checked)}
            />
            Include Brand Name
          </label>
        </div>

        <div style={styles.statsBar}>
          <span>
            Found <strong>{filteredItems.length}</strong> product{filteredItems.length !== 1 ? 's' : ''} for report
          </span>
          <span style={styles.badge}>
            {promotedCount} Promoted / {totalCount} Total
          </span>
          {loading && <span style={{ color: '#2563eb' }}>Loading products...</span>}
        </div>

        {error && <div style={{ color: '#dc2626', fontSize: 13 }}>Failed to load products: {error}</div>}

        {qualitySummary && (
          <div style={styles.qualitySummary}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Classification Quality Summary</div>
            {qualitySummary.summaryRows.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
                {qualitySummary.summaryRows.map((row, i) => (
                  <span key={i} style={styles.qualityChip}>
                    <strong>{row.label}:</strong> {row.value} <span style={{ opacity: 0.7 }}>({row.denominator})</span>
                  </span>
                ))}
              </div>
            )}
            {qualitySummary.warnings.length > 0 && (
              <div style={{ color: '#b45309', fontSize: 12, marginBottom: 4 }}>
                {qualitySummary.warnings.slice(0, 5).map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
                {qualitySummary.warnings.length > 5 && <div>… {qualitySummary.warnings.length - 5} more warning(s)</div>}
              </div>
            )}
            {qualitySummary.hasGroups && (
              <div style={{ fontSize: 12, maxHeight: 140, overflowY: 'auto' }}>
                {qualitySummary.groupRows.map((g, i) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <strong>{g.groupLabel}</strong> · src {g.sourceKind} · precision {g.precision} · coverage{' '}
                    {g.coverage} · corr {g.correctionRate} · ECE {g.ece} · routes: {g.modelRoutes || 'none'}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
            <label style={styles.label}>Email Output Preview (Editable):</label>
            {customText !== null && (
              <button
                style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 12, cursor: 'pointer' }}
                onClick={() => setCustomText(null)}
              >
                ↺ Reset to auto-generated text
              </button>
            )}
          </div>
          <textarea
            style={styles.textarea}
            value={currentEmailBody}
            onChange={e => setCustomText(e.target.value)}
          />
        </div>
      </div>

      <div style={styles.footer}>
        {variant === 'modal' && onClose ? (
          <button style={styles.secondaryBtn} onClick={onClose}>
            Close
          </button>
        ) : (
          <span style={{ fontSize: 13, color: '#64748b' }}>
            Report auto-updates based on date selection and hours specified above.
          </span>
        )}
        <div style={styles.btnGroup}>
          <button
            style={copied ? { ...styles.secondaryBtn, ...styles.copiedBadge } : styles.secondaryBtn}
            onClick={handleCopy}
          >
            {copied ? '✓ Copied to Clipboard!' : '📋 Copy Email'}
          </button>
          <button style={styles.primaryBtn} onClick={handleSendEmail}>
            ✉️ Send via Email
          </button>
        </div>
      </div>
    </div>
  );

  if (variant === 'modal') {
    return (
      <div style={styles.overlay} onClick={onClose}>
        {contentNode}
      </div>
    );
  }

  return contentNode;
}
