import type { ExtractionData } from '../shared/schemas/onboarding';
import { matchOfficialPageIdentity, type OfficialPageIdentityResult } from './official-page-identity';

export interface ValidationResult {
  valid: boolean;
  status: 'ok' | 'blocked' | 'offline' | 'mismatch';
  reason: string | null;
  confidence: number;
  /** Name-first official-page identity outcome, present when identity inputs were assessed. */
  identity?: OfficialPageIdentityResult;
}

export interface ExtractionIdentityExpectation {
  name: string;
  brandHint?: string | null;
  domain?: string | null;
  /** Register UPC — page-observed GTINs corroborate or contradict; absence is ordinary. */
  upc?: string | null;
  /** GTIN observed on the extracted page (product-level). Contradiction fails closed. */
  barcode?: string | null;
  /** Operator-selected variant key from the confirmation decision (stale-selection guard). */
  selectedVariantKey?: string | null;
  /** Variant key + label observed on the extracted page. */
  extractedVariantKey?: string | null;
  extractedVariantLabel?: string | null;
}

// Common English stop words to filter out before word overlap calculation
const STOP_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'from', 'up', 'about', 'into', 'over', 'after', 'dog', 'cat', 'pet', 'food', 'toy', 'treat'
]);

// Common patterns indicating the page is offline, down, or blocked
const DEAD_PAGE_PATTERNS = [
  /store is currently unavailable/i,
  /coming soon/i,
  /under maintenance/i,
  /page not found/i,
  /404/i,
  /no longer available/i,
  /site maintenance/i,
  /temporarily down/i
];

const BLOCKED_PAGE_PATTERNS = [
  /sorry, you have been blocked/i,
  /access denied/i,
  /cloudflare/i,
  /attention required/i,
  /security check/i,
  /bot verification/i,
  /please verify you are a human/i
];

/**
 * Extract domain name from a URL or hostname.
 */
function extractDomain(urlOrHost: string): string {
  try {
    const urlStr = urlOrHost.startsWith('http') ? urlOrHost : `http://${urlOrHost}`;
    const parsed = new URL(urlStr);
    return parsed.hostname.replace(/^www\./, '').toLowerCase().trim();
  } catch {
    return urlOrHost.toLowerCase().replace(/^www\./, '').trim();
  }
}

/**
 * Validates extracted product data against the expected name and brand.
 * Categorizes failure types (blocked, offline, mismatch) and calculates a validation confidence score.
 */
export function validateExtraction(
  extracted: Partial<ExtractionData>,
  expected: ExtractionIdentityExpectation
): ValidationResult {
  const title = (extracted.title ?? '').trim();
  const url = (extracted.sourceUrl ?? '').toLowerCase();

  // 1. Check for empty title
  if (!title) {
    return {
      valid: false,
      status: 'offline',
      reason: 'Extracted title is empty',
      confidence: 0,
    };
  }

  // 2. Check for Cloudflare/WAF block indicators in the title
  for (const pattern of BLOCKED_PAGE_PATTERNS) {
    if (pattern.test(title)) {
      return {
        valid: false,
        status: 'blocked',
        reason: `Access blocked: matches pattern "${pattern.source}"`,
        confidence: 0,
      };
    }
  }

  // 3. Check for Dead page / Offline indicators in the title
  for (const pattern of DEAD_PAGE_PATTERNS) {
    if (pattern.test(title)) {
      return {
        valid: false,
        status: 'offline',
        reason: `Dead page: matches pattern "${pattern.source}"`,
        confidence: 0,
      };
    }
  }

  // 4. Heuristic Title Match / Mismatch check
  const cleanTitle = title.toLowerCase();
  const expectedName = expected.name.toLowerCase();
  const brand = (expected.brandHint ?? '').toLowerCase().trim();

  // If the page is a generic store page (e.g. just lists collections or lists login)
  if (cleanTitle === 'login' || cleanTitle === 'customer login' || cleanTitle === 'shopify' || cleanTitle === 'error') {
    return {
      valid: false,
      status: 'offline',
      reason: `Generic or error page: title is "${title}"`,
      confidence: 0,
    };
  }

  // Determine if we are on the brand's official domain
  let isOnBrandDomain = false;
  if (url) {
    const pageDomain = extractDomain(url);
    if (expected.domain) {
      const targetDomain = extractDomain(expected.domain);
      isOnBrandDomain = pageDomain.includes(targetDomain) || targetDomain.includes(pageDomain);
    }
    if (!isOnBrandDomain && brand) {
      const normalizedBrand = brand.replace(/\s+/g, '');
      isOnBrandDomain = pageDomain.includes(normalizedBrand);
    }
  }

  // Calculate word overlap
  const getWords = (str: string) =>
    str
      .replace(/[^\w\s-]/g, '') // remove punctuation
      .split(/[\s-]+/)
      .map(w => w.trim())
      // Keep words of length > 2, OR length > 1 if we are matching brand/critical tags
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const expectedWords = getWords(expectedName);

  if (expectedWords.length === 0) {
    return {
      valid: true,
      status: 'ok',
      reason: null,
      confidence: 0.5,
    };
  }

  // Count how many expected words are present in the extracted title.
  // Allow partial containment (e.g. expected "flyballyellow" matching title "flyball")
  // to handle concatenated catalog codes or variations gracefully.
  const titleWords = getWords(cleanTitle);
  const matchingWords = expectedWords.filter(w => {
    if (cleanTitle.includes(w)) return true;
    return titleWords.some(tw => w.includes(tw) || tw.includes(w));
  });
  const overlapRatio = matchingWords.length / expectedWords.length;

  // Check if the brand name is present
  const brandInTitle = brand && cleanTitle.includes(brand);

  // Match decision threshold:
  // If we are on the brand's official domain, we are more lenient since they don't prefix their brand name to every product page.
  const threshold = isOnBrandDomain ? 0.15 : 0.25;
  const requireBrand = !isOnBrandDomain;

  const isMismatch = (overlapRatio < threshold && !(brandInTitle && overlapRatio > 0)) || matchingWords.length === 0 || (requireBrand && brand && !brandInTitle && overlapRatio < 0.5);

  if (isMismatch) {
    return {
      valid: false,
      status: 'mismatch',
      reason: `Catalog mismatch: title "${title}" has only ${Math.round(overlapRatio * 100)}% word overlap with expected name "${expected.name}" (threshold: ${threshold * 100}%, isOnBrandDomain: ${isOnBrandDomain})`,
      confidence: overlapRatio,
    };
  }

  // 5. Name-first identity revalidation (ADR 0040): the page heading must
  // still identify the same register name/variant. Runs after the cheap
  // word-overlap screen so ordinary mismatches keep their existing reason.
  const identity = matchOfficialPageIdentity({
    registerName: expected.name,
    registerUpc: expected.upc ?? null,
    brandHint: expected.brandHint ?? null,
    pageName: title,
    pageBrand: extracted.brand ?? null,
    pageKind: 'product',
    variants: [],
    observedGtins: expected.barcode ? [expected.barcode] : [],
  });
  if (expected.selectedVariantKey && expected.extractedVariantKey
    && expected.selectedVariantKey !== expected.extractedVariantKey) {
    return {
      valid: false,
      status: 'mismatch',
      reason: `stale_selection: confirmed variant "${expected.selectedVariantKey}" but page now shows "${expected.extractedVariantKey}" (${expected.extractedVariantLabel ?? 'unlabeled'})`,
      confidence: 0,
      identity,
    };
  }
  if (identity.outcome === 'reject_conflict') {
    return {
      valid: false,
      status: 'mismatch',
      reason: `identity_conflict: ${identity.reasons.join(', ')}`,
      confidence: 0,
      identity,
    };
  }
  if (identity.outcome === 'needs_operator') {
    return {
      valid: false,
      status: 'mismatch',
      reason: `identity needs operator review: ${identity.reasons.join(', ') || 'ambiguous'}`,
      confidence: overlapRatio,
      identity,
    };
  }

  // Calculate a match confidence score based on overlap and brand inclusion
  let confidence = overlapRatio;
  if (brandInTitle || isOnBrandDomain) {
    confidence = Math.min(1.0, confidence + 0.25);
  }

  return {
    valid: true,
    status: 'ok',
    reason: null,
    confidence: Math.round(confidence * 100) / 100,
    identity,
  };
}
