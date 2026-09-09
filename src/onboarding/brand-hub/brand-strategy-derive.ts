// story: e08s01 — pure derivation for Brand Strategy (no DB, no side effects)
import type { BrandStrategy, BrandStrategyOfficialDomain, BrandStrategySourceAvailability, BrandStrategyCollectionReadiness } from '../../shared/schemas/brand-strategy';

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
  /** Explicitly approved source refs; when absent the proposal is derived. */
  sources?: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
}

export interface DeriveParams {
  brandSites: Array<{ brandName: string; domain: string }>;
  advisoryProfiles: Array<{ brand: string; aliases: string[]; preferredDistributorIds: string[]; sourcingPolicy: BrandStrategy['sourcingPolicy'] }>;
  sitemapByDomain?: Map<string, { totalUrls: number; lastRefreshAt: string | null; activeCount: number }>;
  readinessByDomain?: Map<string, BrandStrategy['extractorReadiness']>;
  enabledDistributorIds?: string[];
  /** Approved strategies keyed by normalized brand (absence = awaiting approval). */
  approvals?: Map<string, StrategyApprovalInput>;
}

export function deriveBrandStrategies(params: DeriveParams, readinessFallback?: (domain: string) => BrandStrategy['extractorReadiness']): BrandStrategy[] {
  const exactKeys = new Set<string>();
  for (const s of params.brandSites) exactKeys.add(normalizeExact(s.brandName));
  for (const p of params.advisoryProfiles) exactKeys.add(normalizeExact(p.brand));

  const diagnosticIndex = new Map<string, string[]>();
  for (const key of exactKeys) {
    const diag = normalizeDiagnostic(key);
    const list = diagnosticIndex.get(diag) ?? [];
    list.push(key);
    diagnosticIndex.set(diag, list);
  }

  const profileByExact = new Map<string, DeriveParams['advisoryProfiles'][number]>();
  for (const p of params.advisoryProfiles) profileByExact.set(normalizeExact(p.brand), p);

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
    const advisory = profileByExact.get(exact) ?? null;
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

    const aliases = advisory?.aliases ?? [];
    const preferredDistributorIds = advisory?.preferredDistributorIds ?? [];
    const sourcingPolicy = advisory?.sourcingPolicy ?? 'advisory';

    let extractorReadiness: BrandStrategy['extractorReadiness'];
    if (officialDomains.length === 0) {
      const hasPreferred = preferredDistributorIds.length > 0;
      const isEligible = sourcingPolicy === 'preferred_only' || hasPreferred;
      extractorReadiness = isEligible ? 'profile_bypass_eligible' : 'not_configured';
    } else {
      const first = officialDomains[0].domain;
      extractorReadiness = params.readinessByDomain?.get(first) ?? (readinessFallback ? readinessFallback(first) : 'not_configured');
    }

    const diagKey = normalizeDiagnostic(exact);
    const collisions = (diagnosticIndex.get(diagKey) ?? []).filter((k) => k !== exact);
    const ambiguous = collisions.map((candidateBrand) => ({ candidateBrand, reason: 'whitespace-normalized match' }));

    const unmatched = !advisory || sites.length === 0;

    const displayBrand = advisory?.brand ?? params.brandSites.find((s) => normalizeExact(s.brandName) === exact)?.brandName ?? exact;
    const fallbackTier = enabledIds.filter((id) => !preferredDistributorIds.includes(id));

    // Spec #120: approval state is explicit — a proposal, mapping, or
    // distributor preference never constitutes approval.
    const approvalInput = params.approvals?.get(exact) ?? null;
    const approval = approvalInput
      ? { approved: approvalInput.approved, revision: approvalInput.revision, approvedAt: approvalInput.approvedAt, approvedBy: approvalInput.approvedBy }
      : { approved: false, revision: 0, approvedAt: null, approvedBy: null };

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
    const approvedSources = approval.approved && (approvalInput?.sources?.length ?? 0) > 0
      ? (approvalInput!.sources as NonNullable<StrategyApprovalInput['sources']>)
      : null;
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
    // exposed via preferredDistributorIds/officialDomains for diffing and
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
      for (const distributorId of [...preferredDistributorIds, ...fallbackTier]) {
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

    result.push({
      brandKey: displayBrand,
      normalizedBrand: exact,
      aliases,
      preferredDistributorIds,
      sourcingPolicy,
      fallbackTier,
      officialDomains,
      extractorReadiness,
      ambiguous,
      unmatched,
      possibleMatches: ambiguous,
      approval,
      approvedSources: approvalInput?.sources ? [...approvalInput.sources] : undefined,
      sourceAvailability,
      collectionReadiness,
    });
  }

  return result;
}
