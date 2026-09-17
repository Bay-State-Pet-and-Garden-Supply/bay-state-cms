import {
  lookupByUpc,
  lookupBySku,
  searchUrlsLexical,
  getActiveUrlsForDomain,
  findUrlsByDomain,
  normalizeDomain,
  type BrandUrlRecord,
} from '../db/repositories/brand-url-index-repo';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { callLlmForTask, getLlmConfigForTask } from './llm-client';

export type LocalMatchMethod = 'local_upc' | 'local_sku' | 'local_token_match' | 'local_llm_selected';
export type LocalMatchType = 'upc_exact' | 'sku_exact' | 'token_overlap' | 'llm_selected';

export interface LocalCandidateSignalBreakdown {
  upcMatched: boolean;
  skuMatched: boolean;
  tokenOverlapRatio: number;
  patternMatched: boolean;
  llmSelected: boolean;
  enrichedMetadataPresent: boolean;
}

export interface LocalCandidateMatch {
  url: string;
  confidence: number;
  sourceMethod: LocalMatchMethod;
  matchType: LocalMatchType;
  title?: string | null;
  upc?: string | null;
  sku?: string | null;
  signals: LocalCandidateSignalBreakdown;
}

export interface LocalFinderTarget {
  upc?: string | null;
  name?: string | null;
  sku?: string | null;
  brandHint?: string | null;
  price?: number | null;
}

// Compact stop-word set tuned for product catalog matching
const STOP_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'from', 'up', 'about', 'into', 'over', 'after',
  'dog', 'cat', 'pet', 'food', 'toy', 'treat',
]);

const GENERIC_PRODUCT_PATH_RE = /\/(products?|p|shop|item|dp|goods)\/?[^/]*$/i;

/**
 * Tokenizes a product name into normalized keywords.
 */
export function tokenizeProductName(name: string, domain?: string): string[] {
  if (!name) return [];
  const domainBase = domain ? domain.replace(/\.[a-z]+$/i, '').replace(/^www\./i, '').toLowerCase() : '';

  const clean = name
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/[-_]/g, ' ');

  const tokens = clean
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))
    .filter((t) => (domainBase ? !t.includes(domainBase) && !domainBase.includes(t) : true));

  return Array.from(new Set(tokens));
}

/**
 * Computes token overlap ratio between query tokens and URL slug / path / title.
 */
export function computeTokenOverlapScore(
  url: string,
  tokens: string[],
  title?: string | null,
): { ratio: number; matchedTokens: string[] } {
  if (tokens.length === 0) return { ratio: 0, matchedTokens: [] };

  const targetText = `${url} ${title || ''}`.toLowerCase();
  const matchedTokens: string[] = [];

  for (const token of tokens) {
    if (targetText.includes(token)) {
      matchedTokens.push(token);
    }
  }

  return {
    ratio: matchedTokens.length / tokens.length,
    matchedTokens,
  };
}

/**
 * Core local brand URL finder implementing the tiered retrieval ladder.
 */
export async function findLocalBrandCandidates(
  domain: string,
  target: LocalFinderTarget,
  options?: {
    modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null;
    allowLlmRerank?: boolean;
  },
): Promise<LocalCandidateMatch[]> {
  const normDomain = normalizeDomain(domain);
  const results: LocalCandidateMatch[] = [];
  const seenUrls = new Set<string>();

  // Retrieve extractor profile for productUrlPattern
  const profile = findProfileByDomain(normDomain);
  const pattern = profile?.sitemapProductUrlPattern
    ? new RegExp(profile.sitemapProductUrlPattern, 'i')
    : null;

  // ── Tier 1: Exact UPC Match ───────────────────────────────────────────────
  if (target.upc && target.upc.trim()) {
    const upcHit = lookupByUpc(normDomain, target.upc);
    if (upcHit) {
      const isEnrichedUpc = upcHit.upc === target.upc.replace(/\D/g, '').trim();
      const confidence = isEnrichedUpc ? 0.98 : 0.95;
      seenUrls.add(upcHit.url);
      results.push({
        url: upcHit.url,
        confidence,
        sourceMethod: 'local_upc',
        matchType: 'upc_exact',
        title: upcHit.title,
        upc: upcHit.upc,
        sku: upcHit.sku,
        signals: {
          upcMatched: true,
          skuMatched: false,
          tokenOverlapRatio: 1.0,
          patternMatched: pattern ? pattern.test(upcHit.url) : true,
          llmSelected: false,
          enrichedMetadataPresent: !!(upcHit.title || upcHit.upc),
        },
      });

      // If exact UPC is matched at high confidence, return immediately
      return results;
    }
  }

  // ── Tier 2: Exact SKU / MPN Match ─────────────────────────────────────────
  if (target.sku && target.sku.trim()) {
    const skuHit = lookupBySku(normDomain, target.sku);
    if (skuHit && !seenUrls.has(skuHit.url)) {
      seenUrls.add(skuHit.url);
      results.push({
        url: skuHit.url,
        confidence: 0.92,
        sourceMethod: 'local_sku',
        matchType: 'sku_exact',
        title: skuHit.title,
        upc: skuHit.upc,
        sku: skuHit.sku,
        signals: {
          upcMatched: false,
          skuMatched: true,
          tokenOverlapRatio: 1.0,
          patternMatched: pattern ? pattern.test(skuHit.url) : true,
          llmSelected: false,
          enrichedMetadataPresent: true,
        },
      });

      return results;
    }
  }

  // ── Tier 3: Profile Pattern + FTS5 / Token Overlap Lexical Matching ───────
  const searchName = target.name?.trim();
  if (!searchName) return results;

  const tokens = tokenizeProductName(searchName, normDomain);
  if (tokens.length === 0) return results;

  // Retrieve candidate pool: FTS5 search + active product URLs
  const ftsCandidates = searchUrlsLexical(normDomain, searchName, 30);
  const activeProductUrls = findUrlsByDomain(normDomain, { pageType: 'product', activeOnly: true, limit: 100 });

  const candidatePoolMap = new Map<string, { url: string; title?: string | null; upc?: string | null; sku?: string | null }>();
  for (const c of ftsCandidates) candidatePoolMap.set(c.url, c);
  for (const c of activeProductUrls.urls) {
    if (!candidatePoolMap.has(c.url)) candidatePoolMap.set(c.url, c);
  }

  const scoredCandidates: Array<{
    url: string;
    title?: string | null;
    upc?: string | null;
    sku?: string | null;
    overlapRatio: number;
    patternMatched: boolean;
    baseScore: number;
  }> = [];

  for (const item of candidatePoolMap.values()) {
    if (seenUrls.has(item.url)) continue;

    const patternMatched = pattern
      ? pattern.test(item.url)
      : GENERIC_PRODUCT_PATH_RE.test(item.url);

    const { ratio } = computeTokenOverlapScore(item.url, tokens, item.title);
    if (ratio === 0 && !patternMatched) continue;

    // Confidence formula:
    // Base 0.65 + 0.20 * overlap + 0.05 (if pattern matched) + 0.05 (if title present)
    let score = 0.65 + 0.20 * ratio;
    if (patternMatched) score += 0.05;
    if (item.title) score += 0.05;

    score = Math.min(0.89, Math.max(0.60, score));

    scoredCandidates.push({
      url: item.url,
      title: item.title,
      upc: item.upc,
      sku: item.sku,
      overlapRatio: ratio,
      patternMatched,
      baseScore: score,
    });
  }

  scoredCandidates.sort((a, b) => b.baseScore - a.baseScore);
  const topCandidates = scoredCandidates.slice(0, 10);

  // ── Tier 4: Optional LLM Selection for Ambiguous Top Candidates ───────────
  let llmPickUrl: string | null = null;
  if (
    options?.allowLlmRerank !== false &&
    topCandidates.length >= 2 &&
    topCandidates[0].overlapRatio >= 0.3
  ) {
    const scoreDiff = topCandidates[0].baseScore - topCandidates[1].baseScore;
    if (scoreDiff <= 0.08) {
      // Ambiguous between top 2-5 items: run lightweight LLM disambiguation
      try {
        const candidatesForPrompt = topCandidates.slice(0, 5).map((c, i) => `${i + 1}. ${c.url}${c.title ? ` (Title: ${c.title})` : ''}`).join('\n');
        const prompt = `Given the product name "${searchName}" (Brand: ${target.brandHint || 'Unknown'}, UPC: ${target.upc || 'N/A'}), select the single best matching product URL from this candidate list:\n${candidatesForPrompt}\n\nRespond ONLY with the exact URL of the best match, or "NONE" if none match.`;

        const llmConfig = getLlmConfigForTask('discovery_candidate_selection', {
          allowFallback: true,
          modelPolicy: options?.modelPolicy ?? undefined,
        });
        if (llmConfig) {
          const response = await callLlmForTask(
            'discovery_candidate_selection',
            prompt,
            undefined,
            { modelPolicy: options?.modelPolicy ?? undefined, temperature: 0 },
          );
          if (response && response.trim() !== 'NONE') {
            const picked = topCandidates.find((c) => response.includes(c.url));
            if (picked) {
              llmPickUrl = picked.url;
            }
          }
        }
      } catch (err) {
        console.warn(`[LocalFinder] LLM selection failed for ${normDomain}:`, err);
      }
    }
  }

  for (const c of topCandidates) {
    seenUrls.add(c.url);
    const isLlmPick = llmPickUrl === c.url;
    const finalConfidence = isLlmPick ? Math.min(0.92, c.baseScore + 0.08) : c.baseScore;
    const matchType: LocalMatchType = isLlmPick ? 'llm_selected' : 'token_overlap';

    results.push({
      url: c.url,
      confidence: Math.round(finalConfidence * 100) / 100,
      sourceMethod: isLlmPick ? 'local_llm_selected' : 'local_token_match',
      matchType,
      title: c.title,
      upc: c.upc,
      sku: c.sku,
      signals: {
        upcMatched: false,
        skuMatched: false,
        tokenOverlapRatio: c.overlapRatio,
        patternMatched: c.patternMatched,
        llmSelected: isLlmPick,
        enrichedMetadataPresent: !!(c.title || c.upc || c.sku),
      },
    });
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}
