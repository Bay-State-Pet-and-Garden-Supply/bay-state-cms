import React, { useState, useEffect } from 'react';
import { getClassificationConfig } from '../../onboarding-api';
import type { AttributeMappingConfig } from '../../../shared/schemas/classification';
import { FrozenBanner } from '../settings/FrozenBanner';
import { StatusBadge } from '../settings/StatusBadge';
import { KeyValueList } from '../settings/KeyValueList';

export function TypesAttributesView() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getClassificationConfig()
      .then(res => { if (!cancelled) setConfig(res.config); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading classification configuration...</div>;
  }
  if (!config) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        <p>Classification configuration not available.</p>
        <p style={{ fontSize: 12 }}>Sync products from ShopSite to enable this view.</p>
      </div>
    );
  }

  const { productTypes = [], attributes = [], attributeProfiles = [], attributeMappings = [] } = config;

  const attrNames = new Map(attributes.map((a: any) => [a.id, a.name]));
  const mappingCache = new Map(attributeMappings.map((m: any) => [m.attributeId, m]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <FrozenBanner />
      {productTypes.length > 0 && (
        <section>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: '#0f172a' }}>
            Product Types ({productTypes.length})
          </h3>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
            Product Types define which attributes are relevant for products of that type.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {productTypes.map((pt: any) => {
              const profile = attributeProfiles.find((ap: any) => ap.id === pt.attributeProfileId);
              return (
                <div key={pt.id} style={{ background: 'var(--color-white-surface, #fff)', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 'var(--rounded-lg, 8px)', padding: 16, boxShadow: 'var(--shadow-sm)' }}>
                  <div style={{ marginBottom: 8 }}>
                    <strong style={{ fontSize: 14, color: 'var(--color-uniform-green, #14532D)' }}>{pt.name}</strong>
                  </div>
                  <KeyValueList
                    stacked={false}
                    items={[
                      { label: 'Type ID', value: <code style={{ fontSize: 11 }}>{pt.id}</code> },
                      ...(profile ? [{ label: 'Attribute Profile', value: `${profile.attributes.length} attributes` }] : []),
                    ]}
                  />
                  {pt.description && <p style={{ fontSize: 12, color: '#525252', margin: '4px 0 0' }}>{pt.description}</p>}
                  {profile && profile.attributes.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {profile.attributes.map((pa: any) => (
                        <span key={pa.attributeId} style={{ fontSize: 11, background: 'rgba(20, 83, 45, 0.08)', color: 'var(--color-uniform-green, #14532D)', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
                          {attrNames.get(pa.attributeId) ?? pa.attributeId}
                          {pa.required && <span style={{ marginLeft: 2, color: 'var(--color-signet-burgundy, #760C19)' }}>*</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Product Attributes */}
      <section>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 8px', color: 'var(--color-uniform-green, #14532D)' }}>
          Product Attributes ({attributes.length})
        </h3>
        <p style={{ fontSize: 12, color: '#525252', margin: '0 0 12px' }}>
          Product Attributes are merchandising concepts (e.g. flavor, size, material) distinct from ShopSite XML field destinations.
        </p>
        {attributes.length === 0 ? (
          <p style={{ fontSize: 13, color: '#737373' }}>No attributes configured.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, background: '#fff', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 8 }}>
              <thead>
                <tr>
                  <th style={th}>Attribute</th>
                  <th style={th}>ID</th>
                  <th style={th}>Value Mode</th>
                  <th style={th}>Allowed Values</th>
                  <th style={th}>Mapped Catalog Field</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {attributes.map((attr: any) => {
                  const mapping = mappingCache.get(attr.id) as AttributeMappingConfig | undefined;
                  return (
                    <tr key={attr.id}>
                      <td style={td}>
                        <strong style={{ color: 'var(--color-ledger-charcoal, #211414)' }}>{attr.name}</strong>
                        {attr.isClaim && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--color-signet-burgundy, #760C19)', fontWeight: 600 }}>claim</span>}
                      </td>
                      <td style={td}><code style={{ fontSize: 11 }}>{attr.id}</code></td>
                      <td style={td}><ModeBadge mode={attr.valueMode} /></td>
                      <td style={td}>
                        {attr.allowedValues?.length > 0
                          ? <span style={{ fontSize: 11, color: '#525252' }}>{attr.allowedValues.slice(0, 5).join(', ')}{attr.allowedValues.length > 5 ? '…' : ''}</span>
                          : <span style={{ fontSize: 11, color: '#a3a3a3' }}>free text</span>}
                      </td>
                      <td style={td}>
                        {mapping ? (
                          <div>
                            <code style={{ fontSize: 11, color: 'var(--color-seedling-green, #16844D)' }}>{mapping.catalogField}</code>
                            {mapping.isStale && <span style={{ marginLeft: 4 }}><StatusBadge variant="stale" /></span>}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: '#a3a3a3' }}>— unmapped</span>
                        )}
                      </td>
                      <td style={td}>
                        {mapping?.isStale ? (
                          <StatusBadge variant="stale" />
                        ) : mapping ? (
                          <StatusBadge variant="mapped" />
                        ) : (
                          <StatusBadge variant="unmapped" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p style={{ fontSize: 12, color: '#737373', borderTop: '1px solid var(--color-card-border, #E8E6D9)', paddingTop: 16, margin: 0 }}>
        Product Types, Attributes, and Mappings are managed by the active immutable taxonomy release and are read-only here.
      </p>
    </div>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const labels: Record<string, { label: string; bg: string; fg: string }> = {
    controlled: { label: 'Controlled List', bg: 'var(--color-success-bg, #d1fae5)', fg: 'var(--color-uniform-green, #14532D)' },
    freeText: { label: 'Free Form Text', bg: 'var(--color-warning-bg, #fef3c7)', fg: 'var(--color-warning-text, #78350f)' },
    measured: { label: 'Measured Unit', bg: 'rgba(20, 83, 45, 0.08)', fg: 'var(--color-uniform-green, #14532D)' },
  };
  const item = labels[mode] ?? { label: mode, bg: '#f5f5f5', fg: '#737373' };
  return <span style={{ background: item.bg, color: item.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{item.label}</span>;
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid var(--color-card-border, #E8E6D9)', fontSize: 11, fontWeight: 700, color: 'var(--color-uniform-green, #14532D)', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--color-card-border, #E8E6D9)', verticalAlign: 'top' };
