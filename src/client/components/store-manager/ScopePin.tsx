import React, { useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerPinnedScope, StoreManagerResolvedScope } from '../../store-manager-api';
import { formatScopeLabel, SCOPE_KIND_OPTIONS } from '../../store-manager-command-logic';

interface ScopePinProps {
  scope: StoreManagerResolvedScope | null;
  /** Validate + pin (server-side); parent owns the API call. */
  onPin: (scope: StoreManagerPinnedScope) => void;
  onClear: () => void;
  error?: string | null;
  busy?: boolean;
}

/**
 * Pinned conversational-scope chip + pin form. The pin is client-held and
 * server-validated; the server never accepts a scope it cannot resolve in the
 * workspace (vendor fails closed).
 */
export function ScopePin({ scope, onPin, onClear, error, busy }: ScopePinProps) {
  const [kind, setKind] = useState<string>('product_field');
  const [value, setValue] = useState('');
  const [expanded, setExpanded] = useState(false);

  const label = formatScopeLabel(scope);

  const buildScope = (): StoreManagerPinnedScope | null => {
    const v = value.trim();
    if (!v) return null;
    switch (kind) {
      case 'product_field':
        return { kind: 'product_field', field: v };
      case 'change_set':
        return { kind: 'change_set', changeSetId: v };
      case 'sku_set':
        return { kind: 'sku_set', skus: v.split(',').map((s) => s.trim()).filter(Boolean) };
      case 'onboarding_batch':
        return { kind: 'onboarding_batch', batchId: v };
      default:
        return null;
    }
  };

  const submit = () => {
    const built = buildScope();
    if (built) onPin(built);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative', fontFamily: fonts.body }}>
      {label && !expanded ? (
        <span
          title={scope?.scopeHash}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: rounded.full,
            background: colors.feedBagCream,
            border: `1px solid ${colors.seedlingGreen}`,
            color: colors.ledgerCharcoal,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">◎</span>
          {label}
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear focus"
            style={{
              border: 'none',
              background: 'transparent',
              color: colors.mulchBrown,
              cursor: 'pointer',
              fontSize: 12,
              padding: 0,
            }}
          >
            ✕
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={label ? 'Change focus' : 'Choose what to focus on'}
          style={{
            border: `1px solid ${colors.cardBorder}`,
            background: colors.whiteSurface,
            color: colors.ledgerCharcoal,
            borderRadius: rounded.md,
            padding: '5px 10px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {label ? `◎ ${label}` : '+ Choose focus'}
        </button>
      )}

      {expanded && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 40,
            width: 280,
            padding: 12,
            background: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <p style={{ margin: 0, fontSize: 11, color: colors.mulchBrown }}>
            Choose the products or details you want to include.
          </p>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="What should help focus on?"
            style={{
              padding: '6px 8px',
              borderRadius: rounded.sm,
              border: `1px solid ${colors.cardBorder}`,
              fontSize: 12,
              color: colors.ledgerCharcoal,
              background: colors.whiteSurface,
            }}
          >
            {SCOPE_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={kind === 'sku_set' ? 'Product codes, separated by commas' : 'Product detail name from Settings'}
            aria-label="Details to focus on"
            style={{
              padding: '6px 8px',
              borderRadius: rounded.sm,
              border: `1px solid ${colors.cardBorder}`,
              fontSize: 12,
              color: colors.ledgerCharcoal,
            }}
          />
          {error && <div style={{ color: colors.signetBurgundy, fontSize: 11 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !value.trim()}
              className="btn btn-primary"
              style={{ fontSize: 12, padding: '5px 12px' }}
            >
              {busy ? 'Saving...' : 'Set focus'}
            </button>
            <button type="button" onClick={() => setExpanded(false)} className="btn btn-outline" style={{ fontSize: 12, padding: '5px 12px' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
