import { findBrandSites } from '../db/repositories/brand-site-repo';
import { getApprovedBrandStrategy } from '../db/repositories/brand-strategy-approval-repo';
import { getGenerationStrategyBinding } from '../db/repositories/brand-strategy-generation-repo';
import { getCurrentSourcingGeneration } from '../db/repositories/onboarding-evidence-repo';
import { isOfficialDomainMatch } from './domain-utils';
import { isKnownRetailerOrDistributorDomain } from './discovery/retailer-domain-list';

/** A frozen generation outranks live approval; a legacy item uses mapped brand sites. */
export function getAllowedOfficialPageDomains(input: {
  workspaceId: string; itemId: string; brandHint: string | null;
}): string[] {
  const generation = getCurrentSourcingGeneration(input.itemId);
  const binding = generation ? getGenerationStrategyBinding(generation.id) : null;
  const configured = binding
    ? binding.mode === 'approved' ? binding.sources : []
    : getApprovedBrandStrategy(input.workspaceId, input.brandHint)?.sources ?? null;
  const domains = configured
    ? configured.filter(source => source.kind === 'official_page' && source.domain).map(source => source.domain!)
    : input.brandHint ? findBrandSites(input.brandHint).map(site => site.domain) : [];
  return [...new Set(domains.map(domain => domain.toLowerCase().replace(/^www\./, '')))];
}

export function isAuthorizedOfficialPageUrl(raw: string, domains: string[]): boolean {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (isKnownRetailerOrDistributorDomain(host)) return false;
    return domains.some(domain => isOfficialDomainMatch(host, domain));
  } catch {
    return false;
  }
}
