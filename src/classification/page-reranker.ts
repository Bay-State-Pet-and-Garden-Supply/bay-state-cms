/**
 * Hierarchical Page Reranker
 *
 * Reranks LLM-proposed category page assignments using:
 * 1. Retrieval consensus boost from similar approved products
 * 2. Hierarchy coherence (suppresses parent "Shop All" pages when specific child page is present)
 * 3. Cross-species safety enforcement
 */

import type { SimilarProduct } from './product-retrieval';

export interface PageProposal {
  pageId: string;
  pageName: string;
  confidence: number;
  isBrandShortcut?: boolean;
}

export interface RankedPageProposal extends PageProposal {
  rerankScore: number;
  rerankReason: string;
}

export class PageRerankBlockedError extends Error {
  readonly code = 'page_rerank_blocked_missing_verified_page_identity';
  constructor() {
    super('Page reranking is blocked: no verified Page identity catalog is active. Reranking never executes without verified Page data.');
    this.name = 'PageRerankBlockedError';
  }
}

/**
 * Verify that an active verified Page identity catalog is available before
 * reranking may run. Without verified Pages, reranking is BLOCKED (never
 * silently skipped or approximated).
 */
export function assertVerifiedPageRerankContext(verifiedPageIds?: ReadonlySet<string> | null): void {
  if (!verifiedPageIds || verifiedPageIds.size === 0) {
    throw new PageRerankBlockedError();
  }
}

export interface RerankVerifiedOptions {
  maxPages?: number;
  productSpecies?: string[];
  /** Verified Page row ids from the active Page import; must be non-empty. */
  verifiedPageIds: ReadonlySet<string>;
}

/**
 * Production reranking entry point. Requires an active verified Page catalog;
 * throws PageRerankBlockedError otherwise. Filters proposed pages to verified
 * identities before scoring.
 */
export function rerankPageProposalsVerified(
  proposals: PageProposal[],
  similarProducts: SimilarProduct[],
  options: RerankVerifiedOptions,
): RankedPageProposal[] {
  assertVerifiedPageRerankContext(options.verifiedPageIds);
  const verifiedOnly = proposals.filter(p => options.verifiedPageIds.has(p.pageId));
  const { verifiedPageIds: _verifiedPageIds, ...pureOptions } = options;
  return rerankPageProposals(verifiedOnly, similarProducts, pureOptions);
}

export function rerankPageProposals(
  proposals: PageProposal[],
  similarProducts: SimilarProduct[],
  options?: { maxPages?: number; productSpecies?: string[] },
): RankedPageProposal[] {
  const maxPages = options?.maxPages ?? 5;
  const productSpecies = (options?.productSpecies || []).map(s => s.toLowerCase());

  // 1. Calculate retrieval frequency for each page name/ID
  const pageRetrievalCounts = new Map<string, number>();
  for (const sim of similarProducts) {
    for (const page of sim.acceptedPages) {
      const lower = page.toLowerCase();
      pageRetrievalCounts.set(lower, (pageRetrievalCounts.get(lower) || 0) + 1);
    }
  }

  // 2. Score and filter proposals
  const ranked: RankedPageProposal[] = [];
  const proposedNamesLower = new Set(proposals.map(p => p.pageName.toLowerCase()));

  for (const prop of proposals) {
    const nameLower = prop.pageName.toLowerCase();

    // Cross-species check
    if (productSpecies.length > 0) {
      const isDogProduct = productSpecies.includes('dog');
      const isCatProduct = productSpecies.includes('cat');

      if (isDogProduct && /\bcat\b/.test(nameLower) && !/\bdog\b/.test(nameLower)) continue;
      if (isCatProduct && /\bdog\b/.test(nameLower) && !/\bcat\b/.test(nameLower)) continue;
    }

    // Hierarchy coherence: suppress parent "Shop All" page if specific subcategory page is present
    if (/\bshop all\b/.test(nameLower)) {
      const parentPrefix = nameLower.replace(/\bshop all\b/, '').trim();
      const hasSpecificChild = Array.from(proposedNamesLower).some(
        other => other !== nameLower && other.includes(parentPrefix),
      );
      if (hasSpecificChild) {
        continue; // Suppress redundant parent
      }
    }

    // Retrieval boost
    const retCount = pageRetrievalCounts.get(nameLower) || 0;
    let boost = 0;
    let reason = 'llm_only';

    if (retCount >= 2) {
      boost = 0.15;
      reason = 'retrieval_consensus';
    } else if (retCount === 1) {
      boost = 0.05;
      reason = 'retrieval_supported';
    } else if (prop.isBrandShortcut) {
      reason = 'brand_shortcut';
    }

    const rerankScore = Math.min(0.99, prop.confidence + boost);

    ranked.push({
      ...prop,
      rerankScore,
      rerankReason: reason,
    });
  }

  // Sort descending by rerankScore
  ranked.sort((a, b) => b.rerankScore - a.rerankScore);

  return ranked.slice(0, maxPages);
}
