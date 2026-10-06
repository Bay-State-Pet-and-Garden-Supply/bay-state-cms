import React, { useEffect, useRef } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import type { IntakeRowFlags, RowStrategyReadiness } from './StageItemsView';

export type SourceDetailSection = 'domain' | 'profile' | 'strategy' | 'source';

interface SourceItemDetailProps {
  item: OnboardingWorkState;
  flags: IntakeRowFlags;
  strategy: RowStrategyReadiness;
  section: SourceDetailSection;
  focusVersion: number;
  domainValue: string;
  domainSaving: boolean;
  domainError: string | null;
  domainAvailable: boolean;
  profilesAvailable: boolean;
  domainLoading: boolean;
  profilesLoading: boolean;
  sources: Array<{ kind: string; ref: string; available: boolean; reason: string }>;
  reasons: readonly string[];
  strategyUnavailable: boolean;
  onDomainChange: (value: string) => void;
  onSaveDomain: () => void;
  onOpenProfile: () => void;
  onReviewStrategy: (invoker: HTMLElement) => void;
  onRetry: () => void;
  onClose: () => void;
}

/** Selected-product setup only. All readiness and command authority belongs to its caller. */
export function SourceItemDetail({
  item, flags, strategy, section, focusVersion, domainValue, domainSaving, domainError,
  domainAvailable, profilesAvailable, domainLoading, profilesLoading, sources, reasons, strategyUnavailable,
  onDomainChange, onSaveDomain, onOpenProfile, onReviewStrategy, onRetry, onClose,
}: SourceItemDetailProps) {
  const sectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusVersion > 0) sectionRef.current?.focus();
  }, [item.itemId, section, focusVersion]);
  const exempt = flags.distributorExempt || strategy.suppressMissingDomain;
  return (
    <section
      id={`source-detail-${item.itemId}`}
      role="region"
      aria-label={`Source details — ${item.name || item.upc}`}
      data-testid="source-item-detail"
      style={{ marginTop: 16, padding: 16, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, background: colors.whiteSurface }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: '1rem', color: colors.ledgerCharcoal }}>{item.name || item.upc}</h3>
          <p className="bws-muted" style={{ margin: 0, fontSize: '0.8125rem' }}>{item.upc}{item.brand ? ` · ${item.brand}` : ''}</p>
        </div>
        <button type="button" className="bws-filter-input" onClick={onClose}>Close details</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 16 }}>
        <div
          ref={section === 'domain' || section === 'profile' ? sectionRef : undefined}
          tabIndex={-1}
          data-testid={`intake-domain-${item.itemId}`}
          style={{ flex: '1 1 240px', minWidth: 0 }}
        >
          <h4 style={{ margin: '0 0 8px', fontSize: '0.875rem' }}>Domain &amp; profile</h4>
          {exempt ? (
            <div data-testid={`intake-distributor-only-${item.itemId}`}>
              {flags.mappedDomain && <p style={{ margin: '0 0 8px', overflowWrap: 'anywhere' }}>{flags.mappedDomain} · Brand Hub mapping</p>}
              <p style={{ margin: 0 }}>Distributor record · No domain needed; no profile needed.</p>
            </div>
          ) : flags.missingBrand ? (
            <p className="bws-muted" style={{ margin: 0 }}>Assign a brand using the quick brand field above.</p>
          ) : !domainAvailable ? (
            <p role="status">{domainLoading ? 'Loading domain checks…' : <>Domain checks unavailable. <button type="button" className="bws-filter-input" onClick={onRetry}>Retry checks</button></>}</p>
          ) : flags.mappedDomain ? (
            <>
              <p style={{ margin: '0 0 8px', overflowWrap: 'anywhere' }}>{flags.mappedDomain} · Brand Hub mapping</p>
              {!profilesAvailable ? (
                <p role="status">{profilesLoading ? 'Loading profile checks…' : <>Profile checks unavailable. <button type="button" className="bws-filter-input" onClick={onRetry}>Retry checks</button></>}</p>
              ) : flags.profileReady ? (
                <p data-testid={`intake-profile-ready-${item.itemId}`} style={{ margin: 0, color: colors.uniformGreen }}>Profile Ready</p>
              ) : (
                <button type="button" className="bws-filter-input" data-testid={`intake-profile-required-${item.itemId}`} onClick={onOpenProfile}>
                  Profile Required — open Profile Builder
                </button>
              )}
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); onSaveDomain(); }}>
              <p data-testid={`intake-missing-domain-${item.itemId}`} style={{ margin: '0 0 8px', color: colors.signetBurgundy }}>Missing Domain</p>
              <label style={{ display: 'block', fontSize: '0.8125rem' }}>
                Official domain for {item.brand}
                <input
                  type="text"
                  className="bws-filter-input"
                  data-testid={`intake-domain-input-${item.itemId}`}
                  aria-label={`Official domain for ${item.brand}`}
                  value={domainValue}
                  disabled={domainSaving}
                  onChange={(e) => onDomainChange(e.target.value)}
                  placeholder="e.g. acme.com"
                  style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, fontFamily: fonts.body }}
                />
              </label>
              <button type="submit" className="bws-filter-input" data-testid={`intake-domain-save-${item.itemId}`} disabled={domainSaving || !domainValue.trim()} style={{ marginTop: 8 }}>
                {domainSaving ? 'Saving…' : 'Save domain'}
              </button>
              <p className="bws-muted" style={{ fontSize: '0.75rem' }}>Updates the brand mapping in Brand Hub.</p>
              {domainError && <p role="alert" data-testid={`intake-domain-error-${item.itemId}`} style={{ color: colors.signetBurgundy }}>{domainError} — entry kept.</p>}
            </form>
          )}
        </div>
        <div ref={section === 'strategy' || section === 'source' ? sectionRef : undefined} tabIndex={-1} style={{ flex: '2 1 280px', minWidth: 0 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: '0.875rem' }}>Collection strategy</h4>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{strategy.label}</p>
          <p style={{ margin: '0 0 8px' }}>{strategy.strategyLabel}</p>
          {strategy.explanation && <p style={{ margin: '0 0 8px', fontSize: '0.8125rem', maxWidth: '70ch' }}>{strategy.explanation}</p>}
          {reasons.length > 0 && <ul style={{ paddingLeft: 20 }}>{reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
          {sources.length > 0 && (
            <ul aria-label="Source availability" style={{ paddingLeft: 20, overflowWrap: 'anywhere' }}>
              {sources.map((source, i) => <li key={`${source.kind}-${source.ref}-${i}`}>{source.ref} · {source.available ? 'Available' : 'Unavailable'} — {source.reason}</li>)}
            </ul>
          )}
          {strategyUnavailable && <button type="button" className="bws-filter-input" onClick={onRetry}>Retry collection checks</button>}
          {item.brand && (
            <button type="button" className="bws-filter-input" data-testid={`intake-strategy-review-${item.itemId}`} aria-haspopup="dialog" onClick={(e) => onReviewStrategy(e.currentTarget)}>
              Review strategy
            </button>
          )}
          {item.detail && <p className="bws-muted" style={{ fontSize: '0.8125rem' }}>{item.detail}</p>}
        </div>
      </div>
    </section>
  );
}
