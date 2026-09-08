import React, { useState, useEffect, useCallback, useRef } from 'react';
import './batch-preflight-modal.css';
import {
  getBatchPreflight,
  startBatch,
  assignBrandGroup,
  configureBrand,
  savePreflightDraft,
} from '../../../onboarding-api';
import { normalizeBrandHubDomain, extractDomainAndPattern } from '../../../../onboarding/brand-hub/normalizeDomain';
import type {
  BatchPreflightResponse,
  PreflightBrandGroup,
  PreflightDomainBlocker,
  PreflightRoutingBlocker,
  SourcingPolicy,
  BrandSite,
} from '../../../../shared/schemas/onboarding';

interface BatchPreflightModalProps {
  batchId: string;
  isOpen: boolean;
  onClose: () => void;
  onBatchStarted?: () => void;
  catalogBrands?: string[];
  cachedBrandSites?: BrandSite[];
  /**
   * Slice 3 — navigation link to the unified Brand setup view ONLY.
   * When provided, the modal renders a link that navigates there; all
   * release/save request bodies and controlled-release behavior stay
   * exactly as before.
   */
  onOpenBrandSetup?: () => void;
}

/**
 * Searchable brand dropdown selector that offers autocomplete against known & catalog brands
 * while allowing custom brand entry, styled in "The General Store" aesthetic.
 */
interface BrandSelectorProps {
  value: string;
  onChange: (val: string) => void;
  knownBrands: string[];
  placeholder?: string;
  disabled?: boolean;
}

const PreflightBrandSelector: React.FC<BrandSelectorProps> = ({
  value,
  onChange,
  knownBrands,
  placeholder = 'Select or type brand...',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredBrands = knownBrands.filter((b) =>
    b.toLowerCase().includes((query || '').toLowerCase().trim())
  );

  const exactMatch = knownBrands.find(
    (b) => b.toLowerCase() === (query || '').toLowerCase().trim()
  );

  return (
    <div ref={wrapperRef} className="preflight-brand-selector-wrap">
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          value={isOpen ? query : value}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => {
            setQuery(value);
            setIsOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
          }}
          className="preflight-input"
          style={{ paddingRight: value ? '1.5rem' : '0.75rem' }}
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              setQuery('');
            }}
            style={{
              position: 'absolute',
              right: '0.5rem',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: '#6B3A18',
              cursor: 'pointer',
              fontSize: '0.875rem',
              lineHeight: 1,
            }}
            title="Clear"
          >
            ×
          </button>
        )}
      </div>

      {isOpen && !disabled && (
        <div className="preflight-brand-dropdown">
          {query.trim() && !exactMatch && (
            <button
              type="button"
              onClick={() => {
                onChange(query.trim());
                setIsOpen(false);
              }}
              className="preflight-brand-option-create"
            >
              <span>✨</span>
              <span>Use &quot;{query.trim()}&quot;</span>
            </button>
          )}

          {filteredBrands.length === 0 && !query.trim() && (
            <div style={{ padding: '0.5rem 0.75rem', color: '#6B3A18', fontStyle: 'italic' }}>
              No existing brands found. Type to enter brand.
            </div>
          )}

          {filteredBrands.map((brand) => (
            <button
              key={brand}
              type="button"
              onClick={() => {
                onChange(brand);
                setIsOpen(false);
              }}
              className={`preflight-brand-option ${brand.toLowerCase() === value.toLowerCase() ? 'selected' : ''}`}
            >
              <span>{brand}</span>
              {brand.toLowerCase() === value.toLowerCase() && (
                <span style={{ color: '#14532D', fontSize: '0.75rem' }}>✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const BatchPreflightModal: React.FC<BatchPreflightModalProps> = ({
  batchId,
  isOpen,
  onClose,
  onBatchStarted,
  catalogBrands = [],
  cachedBrandSites = [],
  onOpenBrandSetup,
}) => {
  const [preflight, setPreflight] = useState<BatchPreflightResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form states per card
  const [brandInputs, setBrandInputs] = useState<Record<string, string>>({});
  const [domainInputs, setDomainInputs] = useState<Record<string, string>>({});
  const [patternInputs, setPatternInputs] = useState<Record<string, string>>({});
  const [routingPreferences, setRoutingPreferences] = useState<Record<string, { distributorIds: string[]; policy: SourcingPolicy }>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const fetchPreflight = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getBatchPreflight(batchId);
      setPreflight(data);

      // Initialize inputs from data
      const bInputs: Record<string, string> = {};
      data.blockers.needsBrandGroups.forEach((g) => {
        bInputs[g.key] = g.suggestedBrand || '';
      });
      setBrandInputs(bInputs);

      const pInputs: Record<string, string> = {};
      data.blockers.missingDomainBrands.forEach((d) => {
        if (d.urlPattern) {
          pInputs[d.brand] = d.urlPattern;
        }
      });
      setPatternInputs(pInputs);

      const rPrefs: Record<string, { distributorIds: string[]; policy: SourcingPolicy }> = {};
      data.blockers.unroutedBrands.forEach((b) => {
        rPrefs[b.brand] = {
          distributorIds: b.preferredDistributorIds || [],
          policy: b.sourcingPolicy || 'preferred_then_fallback',
        };
      });
      setRoutingPreferences(rPrefs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    if (isOpen) {
      fetchPreflight();
    }
  }, [isOpen, fetchPreflight]);

  if (!isOpen) return null;

  // Aggregate all available brands from preflight response, catalogBrands, and cachedBrandSites
  const allKnownBrands: string[] = Array.from(
    new Set([
      ...(preflight?.knownBrands || []),
      ...catalogBrands,
      ...cachedBrandSites.map((s) => s.brandName),
    ].filter(Boolean).map((b) => b.trim()))
  ).sort((a, b) => a.localeCompare(b));

  const gatherPendingDraftPayload = () => {
    if (!preflight) return { brandAssignments: [], brandConfigs: [] };

    // 1. Brand assignments for groups that have a non-empty input
    const brandAssignments: Array<{ itemIds: string[]; brand: string }> = [];
    preflight.blockers.needsBrandGroups.forEach((group) => {
      const input = (brandInputs[group.key] || '').trim();
      if (input) {
        brandAssignments.push({
          itemIds: group.itemIds,
          brand: input,
        });
      }
    });

    // 2. Brand configs: domains + urlPatterns + routing
    const brandConfigsMap = new Map<string, {
      brand: string;
      domain?: string;
      urlPattern?: string;
      preferredDistributorIds?: string[];
      sourcingPolicy?: SourcingPolicy;
    }>();

    // Domains
    Object.entries(domainInputs).forEach(([brand, domain]) => {
      if (domain.trim()) {
        const existing = brandConfigsMap.get(brand) || { brand };
        existing.domain = domain.trim();
        if (patternInputs[brand]?.trim()) {
          existing.urlPattern = patternInputs[brand].trim();
        }
        brandConfigsMap.set(brand, existing);
      }
    });

    // Routing
    Object.entries(routingPreferences).forEach(([brand, pref]) => {
      const existing = brandConfigsMap.get(brand) || { brand };
      existing.preferredDistributorIds = pref.distributorIds;
      existing.sourcingPolicy = pref.policy;
      brandConfigsMap.set(brand, existing);
    });

    return {
      brandAssignments,
      brandConfigs: Array.from(brandConfigsMap.values()),
    };
  };

  const handleSaveDraftAndClose = async () => {
    try {
      setActionLoading('save_draft');
      setError(null);
      const payload = gatherPendingDraftPayload();

      if (payload.brandAssignments.length > 0 || payload.brandConfigs.length > 0) {
        await savePreflightDraft(batchId, payload);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleStartBatch = async (mode: 'ready_only' | 'all') => {
    try {
      setActionLoading(`start_${mode}`);
      setError(null);
      // First persist any pending draft settings so no configurations are lost
      const payload = gatherPendingDraftPayload();
      if (payload.brandAssignments.length > 0 || payload.brandConfigs.length > 0) {
        await savePreflightDraft(batchId, payload);
      }

      await startBatch(batchId, mode);
      setSuccessMessage(mode === 'ready_only' ? 'Batch started with ready products!' : 'Batch started with all products!');
      if (onBatchStarted) {
        onBatchStarted();
      }
      setTimeout(() => {
        onClose();
      }, 750);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleAssignBrand = async (group: PreflightBrandGroup) => {
    const brand = (brandInputs[group.key] || group.suggestedBrand || '').trim();
    if (!brand) {
      alert('Please select or enter a brand name');
      return;
    }
    try {
      setActionLoading(`assign_${group.key}`);
      setError(null);
      const res = await assignBrandGroup(batchId, group.itemIds, brand);
      setPreflight(res.preflight);
      setSuccessMessage(`Assigned brand "${brand}" to ${group.itemCount} product${group.itemCount === 1 ? '' : 's'}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const readyPercent = preflight && preflight.totalItems > 0
    ? Math.round((preflight.readyCount / preflight.totalItems) * 100)
    : 0;

  return (
    <div className="preflight-overlay">
      <div className="preflight-modal">
        
        {/* Modal Header */}
        <div className="preflight-header">
          <div className="preflight-header-left">
            <div className="preflight-header-icon">
              📋
            </div>
            <div>
              <h2 className="preflight-header-title">
                Batch Preflight & Execution Review
              </h2>
              <div className="preflight-header-meta">
                <span>Batch: <strong style={{ color: '#211414' }}>{preflight?.batchName || batchId}</strong></span>
                {preflight && (
                  <span className={`preflight-state-badge ${preflight.executionState}`}>
                    {preflight.executionState}
                  </span>
                )}
                {onOpenBrandSetup && (
                  <button
                    type="button"
                    data-testid="preflight-open-brand-setup"
                    onClick={onOpenBrandSetup}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: '#14532D',
                      fontWeight: 600,
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textUnderlineOffset: 2,
                    }}
                    title="Open the unified Brand setup view"
                  >
                    Open in Brand setup view →
                  </button>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={handleSaveDraftAndClose}
            disabled={actionLoading !== null}
            className="preflight-close-btn"
            title="Save & Close"
          >
            <svg style={{ width: '1.25rem', height: '1.25rem' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Modal Body */}
        <div className="preflight-body">
          {error && (
            <div className="preflight-alert-error">
              <span>{error}</span>
              <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#760c19', fontWeight: 'bold', cursor: 'pointer' }}>×</button>
            </div>
          )}

          {successMessage && (
            <div className="preflight-alert-success">
              <span>✓ {successMessage}</span>
              <button onClick={() => setSuccessMessage(null)} style={{ background: 'none', border: 'none', color: '#14532d', fontWeight: 'bold', cursor: 'pointer' }}>×</button>
            </div>
          )}

          {loading && !preflight ? (
            <div style={{ padding: '4rem 1rem', textAlign: 'center', color: '#6B3A18' }}>
              <div style={{ display: 'inline-block', width: '2rem', height: '2rem', border: '3px solid #14532D', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '0.75rem' }}></div>
              <p style={{ fontFamily: 'Arvo, Georgia, serif', fontSize: '0.875rem', fontWeight: 600, color: '#211414' }}>Analyzing batch readiness and brand profiles...</p>
            </div>
          ) : preflight ? (
            <>
              {/* Readiness Summary Banner (The General Store Hero Card) */}
              <div className="preflight-hero">
                <div className="preflight-hero-top">
                  <div>
                    <div className="preflight-hero-eyebrow">
                      Execution Readiness
                    </div>
                    <div className="preflight-hero-headline">
                      {preflight.readyCount} <span>of</span> {preflight.totalItems} products ready to run
                    </div>
                  </div>
                  <div className="preflight-hero-actions">
                    <button
                      onClick={() => handleStartBatch('ready_only')}
                      disabled={preflight.readyCount === 0 || actionLoading !== null}
                      className="preflight-btn-gold"
                    >
                      {actionLoading === 'start_ready_only' ? (
                        <span>Starting...</span>
                      ) : (
                        <span>▶ Start {preflight.readyCount} Ready Products</span>
                      )}
                    </button>
                    <button
                      onClick={() => handleStartBatch('all')}
                      disabled={actionLoading !== null || preflight.totalItems === 0}
                      className="preflight-btn-hero-secondary"
                      title="Release all items including unassigned/held items"
                    >
                      {actionLoading === 'start_all' ? 'Starting...' : 'Start All Anyway'}
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div>
                  <div className="preflight-progress-track">
                    <div
                      className="preflight-progress-fill"
                      style={{ width: `${readyPercent}%` }}
                    />
                  </div>
                </div>

                {/* Metrics 3-Col Grid */}
                <div className="preflight-metrics-grid">
                  <div className="preflight-metric-card">
                    <div className="preflight-metric-label">Brand Resolution:</div>
                    <div className="preflight-metric-value-row">
                      <span className="preflight-metric-percent">{preflight.metrics.brandResolvedPercent}%</span>
                      <span className="preflight-metric-count">({preflight.metrics.brandResolvedCount}/{preflight.totalItems})</span>
                    </div>
                    {preflight.metrics.ambiguousBrandCount + preflight.metrics.missingBrandCount > 0 ? (
                      <div className="preflight-metric-warn">
                        <span>⚠</span>
                        <span>{preflight.metrics.ambiguousBrandCount + preflight.metrics.missingBrandCount} unassigned</span>
                      </div>
                    ) : (
                      <div className="preflight-metric-ok">✓ All brands identified</div>
                    )}
                  </div>
                  <div className="preflight-metric-card">
                    <div className="preflight-metric-label">Official Domains:</div>
                    <div className="preflight-metric-value-row">
                      <span className="preflight-metric-percent">{preflight.metrics.domainMappedPercent}%</span>
                      <span className="preflight-metric-count">({preflight.metrics.domainMappedCount}/{preflight.totalItems})</span>
                    </div>
                    {preflight.metrics.missingDomainBrandCount > 0 ? (
                      <div className="preflight-metric-warn">
                        <span>⚠</span>
                        <span>{preflight.metrics.missingDomainBrandCount} missing website</span>
                      </div>
                    ) : (
                      <div className="preflight-metric-ok">✓ All domains configured</div>
                    )}
                  </div>
                  <div className="preflight-metric-card">
                    <div className="preflight-metric-label">Distributor Sourcing:</div>
                    <div className="preflight-metric-value-row">
                      <span className="preflight-metric-percent">{preflight.metrics.distributorRoutedPercent}%</span>
                      <span className="preflight-metric-count">({preflight.metrics.distributorRoutedCount}/{preflight.totalItems})</span>
                    </div>
                    {preflight.metrics.unroutedBrandCount > 0 ? (
                      <div style={{ fontSize: '0.6875rem', color: 'rgba(250, 249, 242, 0.8)', marginTop: '0.125rem' }}>
                        ℹ {preflight.metrics.unroutedBrandCount} brands unrouted (advisory)
                      </div>
                    ) : (
                      <div className="preflight-metric-ok">✓ Routing active</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Blocker & Configuration Sections */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

                {/* Section 1: Needs Brand Assignment (Signet Burgundy Highlight) */}
                {preflight.blockers.needsBrandGroups.length > 0 && (
                  <div className="preflight-section-card">
                    <div className="preflight-section-header">
                      <div className="preflight-section-title-wrap">
                        <span className="preflight-pill-dot burgundy"></span>
                        <h3 className="preflight-section-title">
                          Needs Brand Assignment ({preflight.blockers.needsBrandGroups.length} groups)
                        </h3>
                      </div>
                      <span className="preflight-badge-alert">
                        Action Required
                      </span>
                    </div>

                    <p className="preflight-section-desc">
                      Products without assigned brands cannot query distributor catalogs or discover official brand websites. Select or enter a brand to unblock automation.
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {preflight.blockers.needsBrandGroups.map((group) => {
                        const currentInput = brandInputs[group.key] ?? group.suggestedBrand ?? '';
                        const isActionRunning = actionLoading === `assign_${group.key}`;
                        
                        // Suggestion chip options (suggested brand + any close matches)
                        const quickChips: string[] = [];
                        if (group.suggestedBrand && !quickChips.includes(group.suggestedBrand)) {
                          quickChips.push(group.suggestedBrand);
                        }
                        allKnownBrands.slice(0, 3).forEach((b) => {
                          if (!quickChips.includes(b) && quickChips.length < 4) {
                            quickChips.push(b);
                          }
                        });

                        return (
                          <div key={group.key} className="preflight-cluster-item">
                            <div className="preflight-cluster-top">
                              <div className="preflight-cluster-info">
                                <div className="preflight-cluster-badges">
                                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6B3A18' }}>Suggested:</span>
                                  {group.suggestedBrand ? (
                                    <span className="preflight-suggested-tag">
                                      {group.suggestedBrand}
                                    </span>
                                  ) : (
                                    <span style={{ fontSize: '0.75rem', fontStyle: 'italic', color: '#6B3A18' }}>None detected</span>
                                  )}
                                  <span className="preflight-count-tag">
                                    {group.itemCount} {group.itemCount === 1 ? 'product' : 'products'}
                                  </span>
                                </div>
                                {group.sampleProducts && group.sampleProducts.length > 0 ? (
                                  <div className="preflight-sample-list">
                                    {(expandedGroups[group.key]
                                      ? group.sampleProducts
                                      : group.sampleProducts.slice(0, 2)
                                    ).map((prod) => (
                                      <div key={prod.id} className="preflight-sample-row">
                                        {prod.upc ? (
                                          <span className="preflight-upc-badge">
                                            UPC: {prod.upc}
                                          </span>
                                        ) : prod.sku ? (
                                          <span className="preflight-sku-badge">
                                            SKU: {prod.sku}
                                          </span>
                                        ) : (
                                          <span className="preflight-no-upc-badge">No UPC</span>
                                        )}
                                        <span className="preflight-sample-name" title={prod.name}>
                                          {prod.name}
                                        </span>
                                      </div>
                                    ))}
                                    {group.sampleProducts.length > 2 && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setExpandedGroups((prev) => ({
                                            ...prev,
                                            [group.key]: !prev[group.key],
                                          }))
                                        }
                                        className="preflight-expand-btn"
                                      >
                                        {expandedGroups[group.key]
                                          ? '▴ Show fewer products'
                                          : `▾ Show all ${group.sampleProducts.length} sample products with UPCs`}
                                      </button>
                                    )}
                                  </div>
                                ) : group.sampleProductNames.length > 0 ? (
                                  <div className="preflight-samples">
                                    Samples: {group.sampleProductNames.join(' · ')}
                                  </div>
                                ) : null}
                              </div>

                              <div className="preflight-cluster-controls">
                                <PreflightBrandSelector
                                  value={currentInput}
                                  onChange={(newBrand) => {
                                    setBrandInputs({ ...brandInputs, [group.key]: newBrand });
                                  }}
                                  knownBrands={allKnownBrands}
                                  placeholder="Select or enter brand..."
                                  disabled={isActionRunning}
                                />
                                <button
                                  onClick={() => handleAssignBrand(group)}
                                  disabled={isActionRunning || !currentInput.trim()}
                                  className="preflight-btn-primary"
                                >
                                  {isActionRunning ? 'Assigning...' : `Assign all ${group.itemCount}`}
                                </button>
                              </div>
                            </div>

                            {/* Quick selection chips */}
                            {quickChips.length > 0 && (
                              <div className="preflight-quick-chips">
                                <span className="preflight-quick-chip-label">Quick pick:</span>
                                {quickChips.map((chip) => (
                                  <button
                                    key={chip}
                                    type="button"
                                    onClick={() => {
                                      setBrandInputs({ ...brandInputs, [group.key]: chip });
                                    }}
                                    className={`preflight-chip-btn ${currentInput.toLowerCase() === chip.toLowerCase() ? 'active' : ''}`}
                                  >
                                    + {chip}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Section 2: Missing Official Domains (Muted Gold Highlight) */}
                {preflight.blockers.missingDomainBrands.length > 0 && (
                  <div className="preflight-section-card">
                    <div className="preflight-section-header">
                      <div className="preflight-section-title-wrap">
                        <span className="preflight-pill-dot gold"></span>
                        <h3 className="preflight-section-title">
                          Missing Official Domain ({preflight.blockers.missingDomainBrands.length} brands)
                        </h3>
                      </div>
                      <span className="preflight-badge-target">
                        Discovery Target · Auto-saved
                      </span>
                    </div>

                    <p className="preflight-section-desc">
                      Providing the manufacturer website ensures official product page discovery and extraction succeed. Entered domains are saved automatically.
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {preflight.blockers.missingDomainBrands.map((blocker) => {
                        const currentInput = domainInputs[blocker.brand] ?? '';
                        const firstProductName = blocker.sampleProducts?.[0]?.name || blocker.sampleProductNames?.[0] || '';
                        const searchQuery = `${blocker.brand} ${firstProductName} official website`.trim();
                        const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;

                        return (
                          <div
                            key={blocker.brand}
                            style={{
                              backgroundColor: 'rgba(250, 249, 242, 0.75)',
                              border: '1px solid #E8E6D9',
                              borderRadius: '6px',
                              padding: '0.875rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.625rem',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ fontSize: '0.875rem', fontWeight: 700, color: '#211414', fontFamily: 'Arvo, Georgia, serif' }}>
                                  {blocker.brand}
                                </span>
                                <span style={{ fontSize: '0.75rem', color: '#6B3A18', backgroundColor: '#FFFFFF', border: '1px solid #E8E6D9', padding: '0.125rem 0.5rem', borderRadius: '4px' }}>
                                  {blocker.itemCount} {blocker.itemCount === 1 ? 'product' : 'products'}
                                </span>
                              </div>
                              <a
                                href={googleSearchUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="preflight-search-link"
                                title={`Search Google for ${blocker.brand} official site`}
                              >
                                🔍 Search Google ↗
                              </a>
                            </div>

                            {/* Sample products list */}
                            {blocker.sampleProducts && blocker.sampleProducts.length > 0 ? (
                              <div className="preflight-sample-list">
                                {(expandedGroups[`domain_${blocker.brand}`]
                                  ? blocker.sampleProducts
                                  : blocker.sampleProducts.slice(0, 2)
                                ).map((prod) => (
                                  <div key={prod.id} className="preflight-sample-row">
                                    {prod.upc ? (
                                      <span className="preflight-upc-badge">UPC: {prod.upc}</span>
                                    ) : prod.sku ? (
                                      <span className="preflight-sku-badge">SKU: {prod.sku}</span>
                                    ) : (
                                      <span className="preflight-no-upc-badge">No UPC</span>
                                    )}
                                    <span className="preflight-sample-name" title={prod.name}>
                                      {prod.name}
                                    </span>
                                  </div>
                                ))}
                                {blocker.sampleProducts.length > 2 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedGroups((prev) => ({
                                        ...prev,
                                        [`domain_${blocker.brand}`]: !prev[`domain_${blocker.brand}`],
                                      }))
                                    }
                                    className="preflight-expand-btn"
                                  >
                                    {expandedGroups[`domain_${blocker.brand}`]
                                      ? '▴ Show fewer products'
                                      : `▾ Show all ${blocker.sampleProducts.length} sample products with UPCs`}
                                  </button>
                                )}
                              </div>
                            ) : blocker.sampleProductNames && blocker.sampleProductNames.length > 0 ? (
                              <div className="preflight-samples">
                                Samples: {blocker.sampleProductNames.join(' · ')}
                              </div>
                            ) : null}

                            <div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' }}>
                                <div>
                                  <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#6B3A18', display: 'block', marginBottom: '0.25rem' }}>
                                    Official Website Domain:
                                  </label>
                                  <input
                                    type="text"
                                    value={currentInput}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      // Auto-extract domain and optional product URL path pattern
                                      if (raw.includes('http://') || raw.includes('https://') || (raw.includes('/') && raw.length > 8)) {
                                        const { domain: cleaned, urlPattern } = extractDomainAndPattern(raw);
                                        setDomainInputs({ ...domainInputs, [blocker.brand]: cleaned });
                                        if (urlPattern) {
                                          setPatternInputs({ ...patternInputs, [blocker.brand]: urlPattern });
                                        }
                                      } else {
                                        setDomainInputs({ ...domainInputs, [blocker.brand]: raw });
                                      }
                                    }}
                                    onBlur={() => {
                                      if (currentInput.trim()) {
                                        const { domain: cleaned, urlPattern } = extractDomainAndPattern(currentInput);
                                        setDomainInputs({ ...domainInputs, [blocker.brand]: cleaned });
                                        if (urlPattern && !patternInputs[blocker.brand]) {
                                          setPatternInputs({ ...patternInputs, [blocker.brand]: urlPattern });
                                        }
                                      }
                                    }}
                                    placeholder="Paste URL or domain (e.g. brand.com)"
                                    className="preflight-input"
                                  />
                                </div>

                                <div>
                                  <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#6B3A18', display: 'block', marginBottom: '0.25rem' }}>
                                    Sitemap Product URL Pattern:
                                  </label>
                                  <input
                                    type="text"
                                    value={patternInputs[blocker.brand] ?? blocker.urlPattern ?? ''}
                                    onChange={(e) => {
                                      setPatternInputs({ ...patternInputs, [blocker.brand]: e.target.value });
                                    }}
                                    placeholder="e.g. /brand-product/ or /products/"
                                    className="preflight-input"
                                    style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Section 3: Distributor Sourcing Policy (Uniform Green Highlight) */}
                {preflight.blockers.unroutedBrands.length > 0 && preflight.availableDistributors.length > 0 && (
                  <div className="preflight-section-card">
                    <div className="preflight-section-header">
                      <div className="preflight-section-title-wrap">
                        <span className="preflight-pill-dot green"></span>
                        <h3 className="preflight-section-title">
                          Distributor Sourcing Policy ({preflight.blockers.unroutedBrands.length} brands)
                        </h3>
                      </div>
                      <span className="preflight-badge-advisory">
                        Advisory · Auto-saved
                      </span>
                    </div>

                    <p className="preflight-section-desc">
                      Select preferred distributors and fallback routing policies per brand. Selections are automatically saved when you close or start the batch.
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {preflight.blockers.unroutedBrands.map((blocker) => {
                        const currentPref = routingPreferences[blocker.brand] || {
                          distributorIds: blocker.preferredDistributorIds,
                          policy: blocker.sourcingPolicy,
                        };

                        return (
                          <div
                            key={blocker.brand}
                            style={{
                              backgroundColor: 'rgba(250, 249, 242, 0.75)',
                              border: '1px solid #E8E6D9',
                              borderRadius: '6px',
                              padding: '0.875rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.625rem',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ fontSize: '0.875rem', fontWeight: 700, color: '#211414', fontFamily: 'Arvo, Georgia, serif' }}>{blocker.brand}</span>
                                <span style={{ fontSize: '0.75rem', color: '#6B3A18', backgroundColor: '#FFFFFF', border: '1px solid #E8E6D9', padding: '0.125rem 0.5rem', borderRadius: '4px' }}>
                                  {blocker.itemCount} {blocker.itemCount === 1 ? 'product' : 'products'}
                                </span>
                              </div>
                            </div>

                            {/* Sample products preview for context */}
                            {blocker.sampleProducts && blocker.sampleProducts.length > 0 ? (
                              <div className="preflight-sample-list">
                                {(expandedGroups[`routing_${blocker.brand}`]
                                  ? blocker.sampleProducts
                                  : blocker.sampleProducts.slice(0, 2)
                                ).map((prod) => (
                                  <div key={prod.id} className="preflight-sample-row">
                                    {prod.upc ? (
                                      <span className="preflight-upc-badge">UPC: {prod.upc}</span>
                                    ) : prod.sku ? (
                                      <span className="preflight-sku-badge">SKU: {prod.sku}</span>
                                    ) : (
                                      <span className="preflight-no-upc-badge">No UPC</span>
                                    )}
                                    <span className="preflight-sample-name" title={prod.name}>
                                      {prod.name}
                                    </span>
                                  </div>
                                ))}
                                {blocker.sampleProducts.length > 2 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedGroups((prev) => ({
                                        ...prev,
                                        [`routing_${blocker.brand}`]: !prev[`routing_${blocker.brand}`],
                                      }))
                                    }
                                    className="preflight-expand-btn"
                                  >
                                    {expandedGroups[`routing_${blocker.brand}`]
                                      ? '▴ Show fewer products'
                                      : `▾ Show all ${blocker.sampleProducts.length} sample products with UPCs`}
                                  </button>
                                )}
                              </div>
                            ) : blocker.sampleProductNames && blocker.sampleProductNames.length > 0 ? (
                              <div className="preflight-samples">
                                Samples: {blocker.sampleProductNames.join(' · ')}
                              </div>
                            ) : null}

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(232, 230, 217, 0.6)' }}>
                              {/* Distributor selection checkboxes */}
                              <div>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#6B3A18', display: 'block', marginBottom: '0.25rem' }}>
                                  Preferred Distributors:
                                </label>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                                  {preflight.availableDistributors.map((dist) => {
                                    const isChecked = currentPref.distributorIds.includes(dist.distributorId);
                                    return (
                                      <label
                                        key={dist.id}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '0.375rem',
                                          padding: '0.25rem 0.625rem',
                                          borderRadius: '4px',
                                          fontSize: '0.75rem',
                                          cursor: 'pointer',
                                          border: `1px solid ${isChecked ? '#14532D' : '#E8E6D9'}`,
                                          backgroundColor: isChecked ? '#d1fae5' : '#FFFFFF',
                                          color: isChecked ? '#14532D' : '#6B3A18',
                                          fontWeight: isChecked ? 700 : 400,
                                          transition: 'all 0.15s',
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={(e) => {
                                            const updatedIds = e.target.checked
                                              ? [...currentPref.distributorIds, dist.distributorId]
                                              : currentPref.distributorIds.filter((id) => id !== dist.distributorId);
                                            setRoutingPreferences({
                                              ...routingPreferences,
                                              [blocker.brand]: {
                                                ...currentPref,
                                                distributorIds: updatedIds,
                                              },
                                            });
                                          }}
                                          style={{ accentColor: '#14532D' }}
                                        />
                                        <span>{dist.distributorId}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Policy select */}
                              <div>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#6B3A18', display: 'block', marginBottom: '0.25rem' }}>
                                  Routing Policy:
                                </label>
                                <select
                                  value={currentPref.policy}
                                  onChange={(e) => {
                                    setRoutingPreferences({
                                      ...routingPreferences,
                                      [blocker.brand]: {
                                        ...currentPref,
                                        policy: e.target.value as SourcingPolicy,
                                      },
                                    });
                                  }}
                                  className="preflight-input"
                                >
                                  <option value="preferred_then_fallback">
                                    Preferred first, then fallback (Recommended)
                                  </option>
                                  <option value="preferred_only">Preferred only</option>
                                  <option value="advisory">Advisory / Query all</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>
            </>
          ) : null}
        </div>

        {/* Modal Footer */}
        <div className="preflight-footer">
          <div>
            {preflight?.heldCount ? (
              <span>
                <strong style={{ color: '#760C19', fontWeight: 700 }}>{preflight.heldCount} products</strong> will remain held until brands are assigned.
              </span>
            ) : (
              <span style={{ color: '#14532D', fontWeight: 600 }}>All products are configured and ready to run.</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={handleSaveDraftAndClose}
              disabled={actionLoading !== null}
              className="preflight-btn-secondary"
            >
              {actionLoading === 'save_draft' ? 'Saving Draft...' : 'Save Draft & Close'}
            </button>
            {preflight && preflight.readyCount > 0 && (
              <button
                onClick={() => handleStartBatch('ready_only')}
                disabled={actionLoading !== null}
                className="preflight-btn-primary"
                style={{ padding: '0.5rem 1rem' }}
              >
                Start {preflight.readyCount} Ready Products
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
