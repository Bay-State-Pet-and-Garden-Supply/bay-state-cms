import React, { useState, useEffect } from 'react';
import { listCatalogFields, listFieldRegistry, listAttributeMappings } from '../../api';
import { getCurationTargets } from '../../onboarding-api';
import { composeMerchandisingFieldSpecs } from '../../../classification/merchandising-field-spec';
import { projectCatalogFieldSummaries } from '../../../classification/merchandising-field-spec-projections';
import type {
  ReadSlice,
  RegistryMetadata,
  MappingReference,
} from '../../../shared/schemas/merchandising-field-spec';
import type { CurationTargetConfig } from '../../../shared/schemas/classification';
import type { CatalogFieldSummary } from './types';
import { CatalogFieldDrawer } from './CatalogFieldDrawer';

interface CatalogFieldsViewProps {
  onSelectProduct: (sku: string) => void;
}

const TABLE_STYLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  background: 'var(--color-white-surface, #fff)',
  border: '1px solid var(--color-card-border, #E8E6D9)',
  borderRadius: 'var(--rounded-lg, 8px)',
  overflow: 'hidden',
};

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  borderBottom: '2px solid var(--color-card-border, #E8E6D9)',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--color-uniform-green, #14532D)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const TD_STYLE: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--color-card-border, #E8E6D9)',
  cursor: 'pointer',
};

export function CatalogFieldsView({ onSelectProduct }: CatalogFieldsViewProps) {
  const [fields, setFields] = useState<CatalogFieldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerField, setDrawerField] = useState<string | null>(null);
  const [drawerLabel, setDrawerLabel] = useState('');
  const [sortKey, setSortKey] = useState<string>('xmlField');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await listCatalogFields();
        if (!cancelled) setFields(res.fields);
      } catch {
        // Fallback: use field registry + mappings + curation targets
        if (cancelled) return;
        try {
          const [reg, mappingsRes, targetsRes] = await Promise.allSettled([
            listFieldRegistry(),
            listAttributeMappings(),
            getCurationTargets(),
          ]);

          const registry: ReadSlice<RegistryMetadata> =
            reg.status === 'fulfilled' && reg.value?.entries
              ? { status: 'available', data: reg.value.entries }
              : { status: 'unavailable', reason: 'source_failed' };

          const mappings: ReadSlice<MappingReference> =
            mappingsRes.status === 'fulfilled' && mappingsRes.value?.mappings
              ? { status: 'available', data: mappingsRes.value.mappings }
              : { status: 'unavailable', reason: 'source_failed' };

          const targets: ReadSlice<CurationTargetConfig> =
            targetsRes.status === 'fulfilled' && (targetsRes.value as any)?.targets
              ? { status: 'available', data: (targetsRes.value as any).targets }
              : { status: 'unavailable', reason: 'source_failed' };

          const model = composeMerchandisingFieldSpecs({
            configuration: {
              status: 'references_only',
              mappings,
              targets,
            },
            registry,
          });

          const fallbackFields = projectCatalogFieldSummaries(model, 'legacy-client-fallback');
          if (!cancelled) setFields(fallbackFields);
        } catch {
          if (!cancelled) setFields([]);
        }
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = [...fields].sort((a, b) => {
    let cmp: number;
    const av = (a as any)[sortKey];
    const bv = (b as any)[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const openDrawer = (field: CatalogFieldSummary) => {
    setDrawerField(field.xmlField);
    setDrawerLabel(field.label);
  };

  const SortIcon = ({ col }: { col: string }) => (
    <span style={{ marginLeft: 4, opacity: sortKey === col ? 1 : 0.3 }}>
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  return (
    <div>
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#666' }}>Loading catalog fields...</div>
      ) : fields.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#737373', background: '#fff', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 8 }}>
          No catalog fields found. Sync products from ShopSite first.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE_STYLE}>
            <thead>
              <tr>
                <th style={TH_STYLE} onClick={() => handleSort('xmlField')}>Field <SortIcon col="xmlField" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('label')}>Label <SortIcon col="label" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('kind')}>Kind <SortIcon col="kind" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('dataType')}>Type <SortIcon col="dataType" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('nonEmptyCount')}># Non-empty <SortIcon col="nonEmptyCount" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('distinctCount')}>Distinct <SortIcon col="distinctCount" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('inferredValueMode')}>Mode <SortIcon col="inferredValueMode" /></th>
                <th style={TH_STYLE}>Mapped</th>
                <th style={TH_STYLE}>Curation</th>
                <th style={TH_STYLE}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(f => (
                <tr
                  key={f.xmlField}
                  style={{ cursor: 'pointer' }}
                  onClick={() => openDrawer(f)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={e => e.key === 'Enter' && openDrawer(f)}
                >
                  <td style={TD_STYLE}><code style={{ color: 'var(--color-seedling-green, #16844D)' }}>{f.xmlField}</code></td>
                  <td style={TD_STYLE}>
                    <strong>{f.label}</strong>
                    {f.warning && <span style={{ marginLeft: 6, color: 'var(--color-warning-text, #78350f)', fontSize: 11 }}>⚠️</span>}
                  </td>
                  <td style={TD_STYLE}><KindBadge kind={f.kind} /></td>
                  <td style={TD_STYLE}><code style={{ fontSize: 11 }}>{f.dataType}</code></td>
                  <td style={TD_STYLE}>{f.nonEmptyCount.toLocaleString()}</td>
                  <td style={TD_STYLE}>{f.distinctCount.toLocaleString()}</td>
                  <td style={TD_STYLE}><ModeBadge mode={f.inferredValueMode} /></td>
                  <td style={TD_STYLE}>
                    {f.mappedAttributeId ? (
                      <span style={{ fontSize: 11, color: 'var(--color-uniform-green, #14532D)', fontWeight: 600 }}>✓ mapped</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#a3a3a3' }}>—</span>
                    )}
                  </td>
                  <td style={TD_STYLE}>
                    {f.isCurationTarget ? (
                      <span style={{ fontSize: 11, color: 'var(--color-uniform-green, #14532D)', fontWeight: 600 }}>curated</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#a3a3a3' }}>—</span>
                    )}
                  </td>
                  <td style={TD_STYLE}>
                    {f.isStale ? (
                      <span style={{ fontSize: 11, color: 'var(--color-signet-burgundy, #760C19)', fontWeight: 600 }}>stale</span>
                    ) : f.warning ? (
                      <span style={{ fontSize: 11, color: 'var(--color-warning-text, #78350f)', fontWeight: 600 }}>warning</span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-uniform-green, #14532D)', fontWeight: 600 }}>ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerField && (
        <CatalogFieldDrawer
          xmlField={drawerField}
          label={drawerLabel}
          onClose={() => setDrawerField(null)}
          onSelectProduct={onSelectProduct}
        />
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    core: { bg: 'var(--color-success-bg, #d1fae5)', fg: 'var(--color-uniform-green, #14532D)' },
    system: { bg: 'var(--color-warning-bg, #fef3c7)', fg: 'var(--color-warning-text, #78350f)' },
    custom: { bg: 'rgba(20, 83, 45, 0.08)', fg: 'var(--color-uniform-green, #14532D)' },
  };
  const c = colors[kind] ?? { bg: '#f5f5f5', fg: '#525252' };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
      {kind}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const labels: Record<string, { label: string; bg: string; fg: string }> = {
    controlled: { label: 'Controlled List', bg: 'var(--color-success-bg, #d1fae5)', fg: 'var(--color-uniform-green, #14532D)' },
    freeText: { label: 'Free Form Text', bg: 'var(--color-warning-bg, #fef3c7)', fg: 'var(--color-warning-text, #78350f)' },
    measured: { label: 'Measured Unit', bg: 'rgba(20, 83, 45, 0.08)', fg: 'var(--color-uniform-green, #14532D)' },
    unknown: { label: 'Unclassified', bg: '#f5f5f5', fg: '#737373' },
  };
  const item = labels[mode] ?? { label: mode, bg: '#f5f5f5', fg: '#737373' };
  return (
    <span style={{ background: item.bg, color: item.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
      {item.label}
    </span>
  );
}
