// story: e08s01 — aggregation projection (exact normalized-brand authority, singleton workspace, never union)
import { listAllBrandSites } from '../../db/repositories/brand-site-repo';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';
import { getSitemapInventory } from '../sitemap-inventory-service';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { deriveBrandStrategies, type StrategyApprovalInput } from './brand-strategy-derive';
import { BrandStrategySchema } from '../../shared/schemas/brand-strategy';
import type { BrandStrategy } from '../../shared/schemas/brand-strategy';
import {
  listStrategyApprovalInputs,
  computeBrandStrategyConfigurationToken,
  normalizeBrandKey,
} from '../../db/repositories/brand-strategy-approval-repo';
import { listDistributors, listConnectionsByWorkspace } from '../../db/repositories/distributor-repo';
import { listSupportedDistributorIds } from '../sourcing/connector-registry';
import { getSourcingFlags } from '../flags';

export { deriveBrandStrategies } from './brand-strategy-derive';

function readinessForDomain(domain: string): BrandStrategy['extractorReadiness'] {
  try {
    const state = getDomainProfileState(domain);
    if (!state.hasProfile) return 'not_configured';
    if (state.testsPassEvidence) return 'active';
    return 'degraded';
  } catch {
    return 'not_configured';
  }
}

/** Best-effort configuration token for guarded editing (undefined when unreadable). */
function readToken(workspaceId: string, normalizedBrand: string): string | undefined {
  try {
    return computeBrandStrategyConfigurationToken(workspaceId, normalizedBrand);
  } catch {
    return undefined;
  }
}

/** Best-effort sourcing capability snapshot (fail-closed when unreadable). */
function readFlags(): { effectiveEnabled: boolean; reason: string } | null {
  try {
    const f = getSourcingFlags();
    return { effectiveEnabled: f.effectiveEnabled, reason: f.reason };
  } catch {
    return null;
  }
}

function buildStrategies(): BrandStrategy[] {
  const workspace = requireServerSingletonWorkspace();
  const brandSites = listAllBrandSites();
  let enabledDistributorIds: string[];
  try {
    enabledDistributorIds = [...new Set(listConnectionsByWorkspace(workspace.id, true).map((c) => c.distributorId))];
  } catch {
    enabledDistributorIds = [];
  }
  let knownDistributorIds: string[];
  try {
    knownDistributorIds = [...new Set([...listDistributors().map((d) => d.id), ...listSupportedDistributorIds()])];
  } catch {
    knownDistributorIds = [...listSupportedDistributorIds()];
  }
  const sitemapByDomain = new Map<string, { totalUrls: number; lastRefreshAt: string | null; activeCount: number }>();
  const readinessByDomain = new Map<string, BrandStrategy['extractorReadiness']>();
  const domains = new Set(brandSites.map((s) => s.domain));
  for (const d of domains) {
    const inv = getSitemapInventory(d);
    sitemapByDomain.set(d, { totalUrls: inv.candidateCount, lastRefreshAt: inv.freshness, activeCount: inv.activeProductCount });
    readinessByDomain.set(d, readinessForDomain(d));
  }
  // Spec #120: approved strategies are explicit rows; absence means awaiting approval.
  const approvals: Map<string, StrategyApprovalInput> = listStrategyApprovalInputs(workspace.id);
  const strategies = deriveBrandStrategies(
    { brandSites: brandSites.map((s) => ({ brandName: s.brandName, domain: s.domain })), sitemapByDomain, readinessByDomain, enabledDistributorIds, knownDistributorIds, approvals },
    readinessForDomain,
  );
  const flags = (() => {
    try {
      return getSourcingFlags();
    } catch {
      return null;
    }
  })();
  const executionAvailability = flags
    ? { enabled: flags.effectiveEnabled, reason: flags.reason }
    : { enabled: false, reason: 'unknown' };
  for (const s of strategies) {
    try {
      s.configurationToken = computeBrandStrategyConfigurationToken(workspace.id, s.normalizedBrand);
    } catch {
      s.configurationToken = undefined;
    }
    s.executionAvailability = executionAvailability;
    BrandStrategySchema.parse(s);
  }
  return strategies;
}

export function listBrandStrategies(): BrandStrategy[] {
  return buildStrategies();
}

/**
 * Builder slice B1: single-brand detail for the builder (Settings New and
 * Stage 1 newly assigned brands). Returns one unapproved projection with
 * revision 0 and an empty-configuration token when nothing is stored — and
 * writes nothing (no strategy rows are created by reads).
 */
export function getBrandStrategyDetail(brand: string): BrandStrategy | null {
  if (!brand || !brand.trim()) return null;
  const normalized = normalizeBrandKey(brand);
  const strategies = buildStrategies();
  const found = strategies.find((s) => s.normalizedBrand === normalized);
  if (found) return found;
  // Brand unknown to every store: synthesize an explicit unapproved
  // projection so the builder can edit without synthetic writes.
  const workspace = requireServerSingletonWorkspace();
  const token = readToken(workspace.id, normalized);
  const flags = readFlags();
  const detail: BrandStrategy = {
    brandKey: brand.trim(),
    normalizedBrand: normalized,
    officialDomains: [],
    extractorReadiness: 'not_configured',
    ambiguous: [],
    unmatched: true,
    possibleMatches: [],
    approval: { approved: false, revision: 0, approvedAt: null, approvedBy: null },
    approvedSources: undefined,
    sourceAvailability: [],
    collectionReadiness: 'awaiting_approval',
    proposalSources: [],
    sourceOptions: [],
    configurationToken: token,
    executionAvailability: flags ? { enabled: flags.effectiveEnabled, reason: flags.reason } : { enabled: false, reason: 'unknown' },
  };
  BrandStrategySchema.parse(detail);
  return detail;
}
