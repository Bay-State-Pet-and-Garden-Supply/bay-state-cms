/**
 * B3 — controlled per-source checklist for the shared strategy builder.
 *
 * Included selects the approved collection boundary. Availability and
 * remediation text included. No API calls, no persistence — the parent
 * builder owns edit state. Retained-but-unrepairable approved refs render as
 * visible-but-locked rows so they never silently vanish.
 */
import React from 'react';
import type {
  BrandStrategySourceOption,
  StrategySourceRef,
} from '../../../shared/schemas/brand-strategy';
import { availabilityText, sourceKey } from './brand-strategy-builder-model';

export interface SourcePickerProps {
  options: BrandStrategySourceOption[];
  /** Approved refs absent from options (retained history, not selectable). */
  retainedRefs?: StrategySourceRef[];
  included: StrategySourceRef[];
  onToggleInclude: (ref: StrategySourceRef) => void;
  disabled?: boolean;
}

function refLabel(kind: string, ref: string, displayName: string): string {
  return kind === 'official_page' ? `Official website · ${displayName}` : `Distributor · ${displayName}`;
}

export function BrandStrategySourcePicker({
  options,
  retainedRefs = [],
  included,
  onToggleInclude,
  disabled = false,
}: SourcePickerProps) {
  const includedKeys = new Set(included.map(sourceKey));
  const optionKeys = new Set(
    options.map((o) => `${o.kind}:${o.ref.trim().toLowerCase()}`),
  );
  const retained = retainedRefs.filter((r) => {
    const lookup = r.kind === 'official_page'
      ? `official_page:${(r.domain ?? '').trim().toLowerCase()}`
      : `distributor_record:${(r.distributorId ?? '').trim().toLowerCase()}`;
    return !optionKeys.has(lookup);
  });

  return (
    <fieldset
      style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', margin: 0 }}
    >
      <legend style={{ fontSize: 12, fontWeight: 700, color: '#374151', padding: '0 6px' }}>
        Approved sources — Included
      </legend>
      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>
        Included authorizes collection attempts.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
        {options.length === 0 && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>No source options available.</span>
        )}
        {options.map((o) => {
          const ref: StrategySourceRef = o.kind === 'official_page'
            ? { kind: 'official_page', domain: o.ref }
            : { kind: 'distributor_record', distributorId: o.ref };
          const key = sourceKey(ref);
          const checked = includedKeys.has(key);
          const optionId = `strategy-src-${o.kind}-${o.ref.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
          return (
            <div
              key={key}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                padding: '6px 8px',
                background: checked ? '#f0fdf4' : '#f9fafb',
                opacity: o.selectable ? 1 : 0.75,
              }}
            >
              <label
                htmlFor={optionId}
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: o.selectable && !disabled ? 'pointer' : 'not-allowed' }}
              >
                <input
                  id={optionId}
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || !o.selectable}
                  onChange={() => onToggleInclude(ref)}
                />
                <span style={{ fontWeight: 600, color: '#111827' }}>{refLabel(o.kind, o.ref, o.displayName)}</span>
                {!o.selectable && (
                  <span style={{ fontSize: 11, color: '#92400e' }}>· repair required: {o.reason}</span>
                )}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, marginLeft: 26 }}>
                <span style={{ fontSize: 11, color: o.available ? '#166534' : '#6b7280' }}>
                  {availabilityText(o.available, o.reason)}
                </span>
              </div>
            </div>
          );
        })}
        {retained.map((r) => (
          <div
            key={`retained-${sourceKey(r)}`}
            style={{ border: '1px dashed #d1d5db', borderRadius: 6, padding: '6px 8px', background: '#fff' }}
          >
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              Retained approved reference ·{' '}
              {r.kind === 'official_page' ? `Official website · ${r.domain}` : `Distributor · ${r.distributorId}`}{' '}
              — unavailable and not repairable. Remove it by saving without it; history is untouched until you save.
            </span>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
