/**
 * Shared deterministic matchers for curation target proposals.
 *
 * Provides evidence text assembly, tokenization, keyword overlap scoring,
 * alias matching, and option normalization — used by all target-driven
 * proposal stages instead of each stage reimplementing its own matcher.
 */
import type { ClassificationEvidence, ProductAttributeConfig } from '../shared/schemas/classification';
import { matchCanonicalValue } from './controlled-value-identity';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MatchedOption {
  value: string;
  label: string;
  confidence: number;
  matchedTokens: string[];
}

export interface MatchKeywordParams {
  /** The option values/labels to score */
  options: Array<{ value: string; label: string }>;
  /** Normalized lowercased evidence text */
  text: string;
  /** Single or multiple selection mode */
  selectionMode: 'single' | 'multiple';
  /** Max results (default: 1 for single, 5 for multiple) */
  maxResults?: number;
  /** Optional stop words to exclude from tokenization */
  stopWords?: Set<string>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'page', 'pages',
  'products', 'product', 'shop', 'all', 'this', 'that',
  'our', 'your', 'new', 'item', 'items', 'size', 'pet', 'pets',
]);

// ─── Evidence Helpers ─────────────────────────────────────────────────────────

export interface BuildEvidenceTextOptions {
  /** Source kinds to include (default: all) */
  includeSources?: string[];
  /** Source fields to exclude */
  excludeFields?: string[];
  /** Max chars per evidence value */
  maxValueLength?: number;
}

/**
 * Build normalized evidence text and collect evidence IDs from classification evidence.
 *
 * @param evidence - Array of classification evidence
 * @param options - Filtering options
 * @returns Joined text and evidence IDs for proposal linkage
 */
export function buildEvidenceText(
  evidence: ClassificationEvidence[],
  options: BuildEvidenceTextOptions = {},
): { text: string; evidenceIds: string[] } {
  const excludeFields = new Set(options.excludeFields ?? []);
  const includeSources = options.includeSources
    ? new Set(options.includeSources)
    : null;
  const maxLen = options.maxValueLength ?? 500;

  const parts: string[] = [];
  const evidenceIds: string[] = [];

  for (const e of evidence) {
    if (includeSources && !includeSources.has(e.source)) continue;
    if (excludeFields.has(e.sourceField ?? '')) continue;

    const val = typeof e.value === 'string' ? e.value : e.value != null ? JSON.stringify(e.value) : (e.snippet ?? '');
    if (!val || val.trim().length === 0) continue;

    parts.push(val.slice(0, maxLen));
    if (e.id) evidenceIds.push(e.id);
  }

  return { text: parts.join(' ').trim(), evidenceIds };
}

// ─── Tokenization ─────────────────────────────────────────────────────────────

/**
 * Tokenize text into lowercase word tokens, filtering out stop words and short tokens.
 */
// fallow-ignore-next-line unused-export — used by tests
export function tokenize(text: string, stopWords?: Set<string>): string[] {
  const stop = stopWords ?? DEFAULT_STOP_WORDS;
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !stop.has(t));
}

// ─── Option Normalization ─────────────────────────────────────────────────────

/**
 * Find the exact allowed option matching a candidate value (comparison-key
 * match, NFC + trim + case fold). Returns the canonical option value or null.
 * Ambiguity fails closed: when more than one allowed value shares the
 * candidate's comparison key the candidate is rejected (the collision should
 * have been caught by config validation).
 */
export function normalizeOption(candidate: unknown, options: string[]): string | null {
  return matchCanonicalValue(candidate, options);
}

// ─── Keyword / Token Overlap Matching ─────────────────────────────────────────

/**
 * Score options against evidence text using word/token overlap.
 *
 * Each option label is tokenized; tokens present in the evidence text
 * count as hits. Score = hits / total option tokens.
 */
export function matchKeywordOptions(params: MatchKeywordParams): MatchedOption[] {
  const { options, text, selectionMode, stopWords } = params;
  const maxResults = params.maxResults ?? (selectionMode === 'multiple' ? 5 : 1);

  if (options.length === 0 || !text || text.length < 3) return [];

  const evidenceTokens = new Set(tokenize(text, stopWords));

  const scored = options
    .map(opt => {
      const tokens = tokenize(opt.label, stopWords);
      const hits = tokens.filter(t => evidenceTokens.has(t));
      const score = tokens.length === 0 ? 0 : hits.length / tokens.length;
      return {
        value: opt.value,
        label: opt.label,
        confidence: Math.min(0.85, 0.45 + score * 0.35),
        matchedTokens: hits,
      };
    })
    .filter(m => m.confidence > 0 || m.matchedTokens.length > 0)
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));

  return scored.slice(0, maxResults);
}

// ─── Attribute / Alias Matching ───────────────────────────────────────────────

export interface AttributeMatchResult {
  value: string;
  confidence: number;
  matchedBy: 'direct' | 'alias';
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match attribute values from evidence text using word-boundary matching
 * and configured value aliases.
 *
 * @param attribute - The product attribute config with allowedValues and valueAliases
 * @param text - Normalized evidence text (lowercased)
 * @param options - The allowed option strings
 * @param selectionMode - Single or multiple
 * @returns Matched values with confidence scores
 */
export function matchAttributeOptions(
  attribute: ProductAttributeConfig,
  text: string,
  options: string[],
  selectionMode: 'single' | 'multiple',
): AttributeMatchResult[] {
  if (options.length === 0 || !text) return [];

  const textLower = text.toLowerCase();
  const found: Array<{ value: string; confidence: number; matchedBy: 'direct' | 'alias' }> = [];
  const seen = new Set<string>();

  // 1. Word-boundary match against allowed values (direct)
  for (const opt of options) {
    if (seen.has(opt)) continue;
    if (new RegExp('\\b' + escapeRegex(opt.toLowerCase()) + '\\b', 'i').test(textLower)) {
      found.push({ value: opt, confidence: 0.6, matchedBy: 'direct' });
      seen.add(opt);
      if (selectionMode === 'single') break;
    }
  }

  // 2. Alias matching (also word-boundary)
  if (selectionMode === 'multiple' || found.length === 0) {
    for (const alias of attribute.valueAliases ?? []) {
      if (seen.has(alias.mapsTo)) continue;
      if (new RegExp('\\b' + escapeRegex(alias.alias.toLowerCase()) + '\\b', 'i').test(textLower)) {
        // Fail closed: the alias target must be one of the exact allowed
        // option values — an alias pointing outside the set is never guessed
        // into a canonical ID.
        const canonical = normalizeOption(alias.mapsTo, options);
        if (!canonical) continue;
        if (seen.has(canonical)) continue;
        found.push({ value: canonical, confidence: 0.60, matchedBy: 'alias' });
        seen.add(canonical);
        if (selectionMode === 'single') break;
      }
    }
  }

  // Deduplicate by value, keep highest confidence
  const deduped = new Map<string, AttributeMatchResult>();
  for (const f of found) {
    const existing = deduped.get(f.value);
    if (!existing || f.confidence > existing.confidence) {
      deduped.set(f.value, f);
    }
  }

  const results = [...deduped.values()];
  if (selectionMode === 'single') return results.slice(0, 1);
  return results.slice(0, 10);
}
