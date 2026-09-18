// #238 — shared presentation primitives for the browser-investigation panel.
//
// Styles and formatting helpers live here so the panel, its stateful
// controller, and its presentational parts render identically without
// duplicating literal values. Pure functions and constants only.

import React from 'react';
import { colors, fonts, rounded } from '../../theme';

export function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.hostname + parsed.pathname;
    return path.length > 56 ? `${path.slice(0, 56)}…` : path;
  } catch {
    return url.length > 56 ? `${url.slice(0, 56)}…` : url;
  }
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}

export function statusColor(status: string): string {
  if (status === 'completed') return colors.seedlingGreen;
  if (status === 'failed') return colors.signetBurgundy;
  if (status === 'running' || status === 'queued') return colors.cornerCalloutGold;
  return colors.mulchBrown;
}

export function reasonText(allowed: boolean, reason: string): string {
  return allowed ? reason : `Unavailable: ${reason}`;
}

export const card: React.CSSProperties = {
  background: colors.whiteSurface,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: rounded.lg,
  padding: 16,
  boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
};

export const sectionTitle: React.CSSProperties = {
  margin: '0 0 10px',
  fontFamily: fonts.display,
  fontSize: '0.9375rem',
  fontWeight: 700,
  color: colors.ledgerCharcoal,
};

export const hint: React.CSSProperties = {
  fontSize: 11,
  color: colors.mulchBrown,
};

export const fieldLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: colors.ledgerCharcoal,
  marginBottom: 6,
};

export const mono: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 12,
  color: colors.ledgerCharcoal,
};

export const textInput: React.CSSProperties = {
  padding: '5px 8px',
  fontSize: 12,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: rounded.sm,
};

export function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: '7px 16px',
    background: disabled ? colors.feedBagCream : colors.uniformGreen,
    color: disabled ? colors.mulchBrown : colors.feedBagCream,
    border: 'none',
    borderRadius: rounded.sm,
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  };
}

export const ghostButton: React.CSSProperties = {
  padding: '6px 12px',
  background: colors.whiteSurface,
  color: colors.uniformGreen,
  border: `1px solid ${colors.uniformGreen}`,
  borderRadius: rounded.sm,
  fontFamily: fonts.body,
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
};

export const errorBox: React.CSSProperties = {
  padding: '8px 12px',
  background: 'rgba(118, 12, 25, 0.08)',
  border: `1px solid ${colors.signetBurgundy}`,
  borderRadius: rounded.sm,
  color: colors.signetBurgundy,
  fontSize: 12,
  fontWeight: 600,
};

export const actionCard: React.CSSProperties = {
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: rounded.sm,
  padding: 12,
};

export const inlineRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

/** Error box rendered only when a message exists (never an empty alert). */
export function AlertBox({ message, style }: { message: string | null; style?: React.CSSProperties }): React.ReactElement | null {
  if (!message) return null;
  return (
    <div role="alert" style={{ ...errorBox, ...style }}>
      {message}
    </div>
  );
}

/** Budget rows table shared by the launch preview and the workspace view. */
export function BudgetRows({ rows }: { rows: readonly { key: string; label: string; value: string }[] }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
          <span style={{ color: colors.mulchBrown, minWidth: 220 }}>{row.label}</span>
          <span style={{ fontFamily: fonts.mono, color: colors.ledgerCharcoal }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** One `<summary>` disclosure row with its body. */
export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: colors.uniformGreen }}>
        {title}
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>{children}</div>
    </details>
  );
}

/** Bounded label/value line used across the evidence and proposal blocks. */
export function DetailLine({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ fontSize: 12, marginTop: 6 }}>
      <span style={hint}>{label}: </span>
      {value}
    </div>
  );
}
