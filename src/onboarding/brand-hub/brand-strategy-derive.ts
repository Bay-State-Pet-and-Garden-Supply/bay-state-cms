// story: e08s01 — pure derivation for Brand Strategy (no DB, no side effects)
// Issue #150 (Amendment B1.1): advisory settings (aliases, preferred
// distributors, sourcing policy) are retired. Derivation authority is exact
// normalized brand identity over mappings + stored approvals, plus live
// enabled connections for proposals. No alias/fuzzy authority.
import type { BrandStrategy, BrandStrategyOfficialDomain, BrandStrategySourceAvailability, BrandStrategyCollectionReadiness, BrandStrategySourceOption, StrategySourceRef } from '../../shared/schemas/brand-strategy';
import { isKnownRetailerOrDistributorDomain } from '../discovery/retailer-domain-list';

function normalizeExact(value: string): string {
  return value.toLowerCase().trim();
}

function normalizeDiagnostic(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

function freshnessFor(lastRefreshAt: string | null, activeCount: number): 'fresh' | 'stale' | 'missing' {
  if (!lastRefreshAt || activeCount === 0) return 'missing';
  const ageMs = Date.now() - new Date(lastRefreshAt).getTime();
  if (Number.isNaN(ageMs)) return 'missing';
  return ageMs < 7 * 24 * 3600 * 1000 ? 'fresh' : 'stale';
}

export interface StrategyApprovalInput {
  approved: boolean;
  revision: number;
  approvedAt: string | null;
  approvedBy: string | null;
  /** Display spelling of the stored brand (fallback for approval-only brands). */
  brand?: string;
  /** Explicitly approved source refs; when absent the proposal is derived. */
  sources?: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
}

export interface DeriveParams {
  brandSites: Array<{ brandName: string; domain: string }>;
  sitemapByDomain?: Map<string, { totalUrls: number; lastRefreshAt: string | null; activeCount: number }>;
  readinessByDomain?: Map<string, BrandStrategy['extractorReadiness']>;
  enabledDistributorIds?: string[];
  /** Approved strategies keyed by normalized brand (absence = awaiting approval). */
  approvals?: Map<string, StrategyApprovalInput>;
  /** Known distributor ids (registry-supported + configured) for source options. */
  knownDistributorIds?: string[];
}

export function deriveBrandStrategies(params: DeriveParams, readinessFallback?: (domain: string) => BrandStrategy['extractorReadiness']): BrandStrategy[] {
  const exactKeys = new Set<string>();
  for (const s of params.brandSites) exactKeys.add(normalizeExact(s.brandName));
  // Approval-only brands persist in reads even after mappings vanish.
  for (const k of params.approvals?.keys() ?? []) exactKeys.add(k);

  const diagnosticIndex = new Map<string, string[]>();
  for (const key of exactKeys) {
    const diag = normalizeDiagnostic(key);
    const list = diagnosticIndex.get(diag) ?? [];
    list.push(key);
    diagnosticIndex.set(diag, list);
  }

  const sitesByExact = new Map<string, Array<{ domain: string }>>();
  for (const s of params.brandSites) {
    const key = normalizeExact(s.brandName);
    const list = sitesByExact.get(key) ?? [];
    list.push({ domain: s.domain });
    sitesByExact.set(key, list);
  }

  const enabledIds = params.enabledDistributorIds ?? [];
  const result: BrandStrategy[] = [];
  for (const exact of [...exactKeys].sort()) {
    const sites = sitesByExact.get(exact) ?? [];

    const officialDomains: BrandStrategyOfficialDomain[] = sites.map(({ domain }) => {
      const norm = domain.toLowerCase().replace(/^www\./, '').trim();
      const inv = params.sitemapByDomain?.get(norm) ?? null;
      const totalUrls = inv?.totalUrls ?? 0;
      const lastRefreshAt = inv?.lastRefreshAt ?? null;
      const activeCount = inv?.activeCount ?? 0;
      return {
        domain: norm,
        sitemap: { totalUrls, freshCount: activeCount, lastRefreshAt, freshness: freshnessFor(lastRefreshAt, activeCount) },
      };
    });

    const approvalInput = params.approvals?.get(exact) ?? null;
    const displayBrand = params.brandSites.find((s) => normalizeExact(s.brandName) === exact)?.brandName ?? approvalInput?.brand ?? exact;

    // Spec #120: approval state is explicit — a proposal or mapping never
    // constitutes approval.
    const approval = approvalInput
      ? { approved: approvalInput.approved, revision: approvalInput.revision, approvedAt: approvalInput.approvedAt, approvedBy: approvalInput.approvedBy }
      : { approved: false, revision: 0, approvedAt: null, approvedBy: null };

    // Approved distributor-only boundary (for no-domain bypass eligibility).
    const approvedSources = approval.approved && (approvalInput?.sources?.length ?? 0) > 0
      ? (approvalInput!.sources as NonNullable<StrategyApprovalInput['sources']>)
      : null;
    const approvedDistributorIds = (approvedSources ?? [])
      .filter((s) => s.kind === 'distributor_record' && s.distributorId)
      .map((s) => s.distributorId as string);

    let extractorReadiness: BrandStrategy['extractorReadiness'];
    if (officialDomains.length === 0) {
      // No-domain bypass is derived only from a nonempty approved
      // distributor-only boundary — never from enabled connections alone.
      extractorReadiness = approvedDistributorIds.length > 0 ? 'profile_bypass_eligible' : 'not_configured';
    } else {
      const first = officialDomains[0].domain;
      extractorReadiness = params.readinessByDomain?.get(first) ?? (readinessFallback ? readinessFallback(first) : 'not_configured');
    }

    const diagKey = normalizeDiagnostic(exact);
    const collisions = (diagnosticIndex.get(diagKey) ?? []).filter((k) => k !== exact);
    const ambiguous = collisions.map((candidateBrand) => ({ candidateBrand, reason: 'whitespace-normalized match' }));

    // Unmatched means no mapped domain and no approved distributor source.
    const unmatched = sites.length === 0 && approvedDistributorIds.length === 0;

    // Per-source availability with bounded reasons. Distributor-record
    // sources never require an extractor profile; only webpage sources do.
    // When an approved strategy pins an explicit source boundary, derive
    // from the approved sources so readiness/label describe what collection
    // will actually run. No collection path executes official_page yet, so
    // an approved official source is reported not_supported (never ready,
    // never silently dropped). Without a stored boundary, fall back to the
    // live proposal (unapproved brands stay awaiting_approval regardless).
    const sourceAvailability: BrandStrategySourceAvailability[] = [];
    const enabledSet = new Set(enabledIds);
    if (approvedSources) {
      for (const src of approvedSources) {
        if (src.kind === 'official_page') {
          sourceAvailability.push({
            kind: 'official_page',
            ref: (src.domain ?? officialDomains[0]?.domain ?? 'official website').toLowerCase(),
            available: false,
            reason: 'not_supported',
          });
        } else if (src.distributorId) {
          const available = enabledSet.has(src.distributorId);
          sourceAvailability.push({
            kind: 'distributor_record',
            ref: src.distributorId,
            available,
            reason: available ? 'ready' : 'connection_not_configured',
          });
        }
      }
    }
    // Approved boundary above is authoritative; the live proposal stays
    // exposed via officialDomains plus enabled connections for diffing and
    // re-approval, but is never mixed into availability. Proposal path:
    if (!approvedSources && officialDomains.length > 0) {
      const domain = officialDomains[0].domain;
      const available = extractorReadiness === 'active' || extractorReadiness === 'degraded';
      sourceAvailability.push({
        kind: 'official_page',
        ref: domain,
        available,
        reason: extractorReadiness === 'active' || extractorReadiness === 'degraded'
          ? 'ready'
          : extractorReadiness === 'profile_bypass_eligible'
            ? 'ready'
            : extractorReadiness === 'not_configured' ? 'no_profile' : 'profile_not_healthy',
      });
    }
    if (!approvedSources) {
      for (const distributorId of enabledIds) {
        const available = enabledSet.has(distributorId);
        sourceAvailability.push({
          kind: 'distributor_record',
          ref: distributorId,
          available,
          reason: available ? 'ready' : 'connection_not_configured',
        });
      }
    }

    // Collection readiness: approval and availability are orthogonal.
    // "Ready" means collection can run — never that evidence or a
    // listing is complete.
    let collectionReadiness: BrandStrategyCollectionReadiness;
    if (!approval.approved) {
      collectionReadiness = 'awaiting_approval';
    } else if (sourceAvailability.length === 0) {
      collectionReadiness = 'unknown';
    } else if (sourceAvailability.every((s) => !s.available)) {
      collectionReadiness = 'setup_attention';
    } else if (sourceAvailability.every((s) => s.available)) {
      collectionReadiness = 'ready';
    } else {
      collectionReadiness = 'ready_partial';
    }

    // Canonical server-derived live proposal: all mapped official domains
    // plus every enabled distributor connection, deduplicated.
    const proposalSources: StrategySourceRef[] = [];
    {
      const seen = new Set<string>();
      for (const d of officialDomains) {
        const key = `official_page:${d.domain}`;
        if (!seen.has(key)) { seen.add(key); proposalSources.push({ kind: 'official_page', domain: d.domain }); }
      }
      for (const id of enabledIds) {
        const key = `distributor_record:${id.toLowerCase()}`;
        if (!seen.has(key)) { seen.add(key); proposalSources.push({ kind: 'distributor_record', distributorId: id }); }
      }
    }

    // Source catalog for the builder: mapped domains + known distributors +
    // retained approved refs (visible even when unmapped/unknown).
    const sourceOptions: BrandStrategySourceOption[] = [];
    {
      const seen = new Set<string>();
      const readinessByDomainLocal = params.readinessByDomain;
      for (const d of officialDomains) {
        const key = `official_page:${d.domain}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const denylisted = isKnownRetailerOrDistributorDomain(d.domain);
        const readiness = readinessByDomainLocal?.get(d.domain);
        const healthy = readiness === 'active' || readiness === 'degraded';
        sourceOptions.push({
          kind: 'official_page',
          ref: d.domain,
          displayName: d.domain,
          selectable: !denylisted,
          reason: denylisted ? 'retailer_host' : healthy ? 'ready' : readiness === 'not_configured' || !readiness ? 'no_profile' : 'profile_not_healthy',
          available: healthy && !denylisted,
        });
      }
      const knownIds = [...new Set([...(params.knownDistributorIds ?? []), ...enabledIds])];
      for (const id of knownIds) {
        const key = `distributor_record:${id.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const available = enabledSet.has(id);
        sourceOptions.push({
          kind: 'distributor_record',
          ref: id,
          displayName: id,
          selectable: true,
          reason: available ? 'ready' : 'connection_not_configured',
          available,
        });
      }
      for (const src of approvalInput?.sources ?? []) {
        const ref = src.kind === 'official_page' ? (src.domain ?? '').toLowerCase() : (src.distributorId ?? '');
        if (!ref) continue;
        const key = `${src.kind}:${ref.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sourceOptions.push({
          kind: src.kind,
          ref,
          displayName: ref,
          selectable: false,
          reason: src.kind === 'official_page' ? 'unmapped_domain' : 'removed_source',
          available: false,
        });
      }
    }

    result.push({
      brandKey: displayBrand,
      normalizedBrand: exact,
      officialDomains,
      extractorReadiness,
      ambiguous,
      unmatched,
      possibleMatches: ambiguous,
      approval,
      approvedSources: approvalInput?.sources ? [...approvalInput.sources] : undefined,
      sourceAvailability,
      collectionReadiness,
      proposalSources,
      sourceOptions,
    });
  }

  return result;
}
