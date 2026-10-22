/**
 * Lightweight page verification for discovery candidates.
 *
 * Before auto-selecting a sourceUrl, the verifier fetches the top few
 * candidate pages and computes a product-identity verification score
 * and strict proof class from structured HTML signals.
 *
 * Proof classes (P1-A):
 *   - 'exact_structured_gtin': Valid GS1 Mod-10 checksum GTIN on single-product page
 *   - 'exact_variant_gtin': Valid GS1 Mod-10 checksum GTIN resolved to exact variant
 *   - 'none': Weak, missing, contradictory, off-domain, or unverified identity
 */

import { extractProductJsonFromHtml } from './shopify-json';
import { isOfficialDomainMatch } from './domain-utils';
import {
  validateGtin,
  normalizeGtinDigits,
  canonicalGtinMatch,
  padGtinTo14,
} from '../shared/gtin';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';

// ─── Public types ────────────────────────────────────────────────────────────

export type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProofClass = 'exact_structured_gtin' | 'exact_variant_gtin' | 'none';

export interface ExtractedPageGtin {
  gtin: string;
  normalizedGtin: string;
  type: 'single' | 'variant';
  path: string;
  isValidChecksum: boolean;
}

export interface VerificationContext {
  upc: string;
  expectedName: string;
  brandHint: string | null;
  price?: number | null;
  officialDomains: string[];
}

export interface ObservedIdentityVariant {
  key: string;
  label: string;
  gtin?: string | null;
}

export interface ObservedIdentity {
  pageName: string | null;
  pageBrand: string | null;
  pageKind: 'product' | 'listing' | 'blog';
  variants: ObservedIdentityVariant[];
  observedGtins: string[];
  artifactRef: string | null;
  coverageComplete: boolean;
}

export interface VerificationResult {
  /** The original candidate, enriched with verification signals. */
  candidate: InsertSourceData;
  /** Raw verification score (0–∞, not clamped). Higher = stronger evidence. */
  verificationScore: number;
  /** Individual signal breakdown for diagnostics / review UI. */
  signals: VerificationSignals;
  /** P1-A strict proof class. */
  proofClass: ProofClass;
  /** When true, the candidate has strong enough evidence for auto-selection. */
  hasStrongProof: boolean;
  /** Extracted structured GTINs. */
  extractedGtins: ExtractedPageGtin[];
  observedIdentity: ObservedIdentity;
  /** Human-readable reason for the auto-select / skip decision. */
  decisionReason: string;
}

export interface VerificationSignals {
  domainOfficial: boolean;
  isProductDetailPage: boolean;
  isListingOrSearchPage: boolean;
  isBlogOrCmsPage: boolean;
  titleSimilarity: number;
  brandInPage: boolean;
  upcInPage: boolean;
  skuInPage: boolean;
  hasJsonLdProduct: boolean;
  hasShopifyProductJson: boolean;
  variantResolved: boolean;
  canonicalMatchesCandidate: boolean;
  /** Page title as extracted from <title> tag (raw, for diagnostics). */
  pageTitle: string | null;
  /** First visible product heading, extracted from page content. */
  pageHeading: string | null;
  /** Word-level overlap score between expected name and page title. */
  titleNameOverlap: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Signals that independently qualify a candidate for auto-selection. */
// fallow-ignore-next-line unused-export — used by tests
export const STRONG_PROOF_THRESHOLD = 40;

/** Minimum number of identity signals required for strong proof. */
// fallow-ignore-next-line unused-export — used by tests
export const MIN_IDENTITY_SIGNALS = 2;

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Verify a single candidate URL by fetching its HTML and scoring
 * product-identity signals and proof class. Returns `null` when the page cannot be
 * fetched (network error, timeout, non-200).
 */
// fallow-ignore-next-line unused-export — used by tests
export async function verifyCandidate(
  candidate: InsertSourceData,
  context: VerificationContext,
  fetchFn: NetworkFetch = fetch,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<VerificationResult | null> {
  let html: string;
  const localCapMs = 12_000;
  const effectiveTimeout =
    typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, localCapMs)
      : localCapMs;
  const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
  const composedSignal = options?.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetchFn(candidate.url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: composedSignal,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  const signals = extractVerificationSignals(html, candidate.url, context);
  const score = computeVerificationScore(signals);
  const extractedGtins = extractStructuredGtinsFromHtml(html);
  const { proofClass, decisionReason } = qualifyIdentityProof(extractedGtins, context.upc, signals);
  const hasStrongProof = proofClass === 'exact_structured_gtin' || proofClass === 'exact_variant_gtin';
  const productJson = extractProductJsonFromHtml(html);
  const observedIdentity = extractObservedIdentity(html, signals, extractedGtins, productJson);

  return {
    candidate,
    verificationScore: score,
    signals,
    proofClass,
    hasStrongProof,
    extractedGtins,
    observedIdentity,
    decisionReason: `[${hasStrongProof ? 'verified' : 'needs_review'}] proof=${proofClass} | ${decisionReason} | score=${score.toFixed(0)}`,
  };
}

function extractObservedIdentity(
  html: string,
  signals: VerificationSignals,
  extractedGtins: ExtractedPageGtin[],
  productJson: Record<string, unknown> | null,
): ObservedIdentity {
  const variants: ObservedIdentityVariant[] = [];
  if (productJson && Array.isArray(productJson.variants)) {
    productJson.variants.forEach((variant: unknown, index: number) => {
      if (!variant || typeof variant !== 'object') return;
      const variantRecord = variant as Record<string, unknown>;
      const options = [variantRecord.option1, variantRecord.option2, variantRecord.option3]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(value => value.trim());
      const title = variantRecord.title;
      const label = [typeof title === 'string' ? title : null, ...options]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(value => value.trim())
        .join(' / ');
      const id = variantRecord.id;
      const barcode = variantRecord.barcode;
      variants.push({
        key: typeof id === 'string' || typeof id === 'number' ? String(id) : String(index),
        label,
        gtin: (typeof barcode === 'string' || typeof barcode === 'number') && barcode ? String(barcode) : null,
      });
    });
  }

  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      collectProductGroupVariants(JSON.parse(match[1]), variants);
    } catch { /* Ignore malformed JSON-LD. */ }
  }

  return {
    pageName: signals.pageHeading,
    pageBrand: extractObservedBrand(html),
    pageKind: signals.isListingOrSearchPage ? 'listing' : signals.isBlogOrCmsPage ? 'blog' : 'product',
    variants,
    observedGtins: extractedGtins.filter(gtin => gtin.type === 'single').map(gtin => gtin.gtin),
    artifactRef: null,
    coverageComplete: true,
  };
}

function collectProductGroupVariants(value: unknown, variants: ObservedIdentityVariant[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(item => collectProductGroupVariants(item, variants));
    return;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record['@graph'])) record['@graph'].forEach((item: unknown) => collectProductGroupVariants(item, variants));
  if (record['@type'] === 'ProductGroup' && Array.isArray(record.hasVariant)) {
    record.hasVariant.forEach((variant: unknown, index: number) => {
      if (variant && typeof variant === 'object') {
        const variantRecord = variant as Record<string, unknown>;
        const name = variantRecord.name;
        const gtin = variantRecord.gtin ?? variantRecord.gtin12 ?? variantRecord.gtin13 ?? variantRecord.gtin14 ?? variantRecord.gtin8;
        variants.push({
          key: String(index),
          label: typeof name === 'string' ? name : '',
          gtin: typeof gtin === 'string' || typeof gtin === 'number' ? String(gtin) : null,
        });
      }
    });
  }
}

function extractObservedBrand(html: string): string | null {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const brandInJson = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) { const found = brandInJson(item); if (found) return found; }
      return null;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record['@graph'])) for (const item of record['@graph']) { const found = brandInJson(item); if (found) return found; }
    const brand = record.brand;
    if (typeof brand === 'string') return brand.trim() || null;
    if (brand && typeof brand === 'object' && 'name' in brand && typeof brand.name === 'string') return brand.name.trim() || null;
    return null;
  };
  for (const script of scripts) {
    try { const found = brandInJson(JSON.parse(script[1])); if (found) return found; } catch { /* Ignore malformed JSON-LD. */ }
  }
  const meta = html.match(/<meta\b(?=[^>]*(?:property|name)=["'](?:product:brand|og:brand|brand)["'])(?=[^>]*content=["']([^"']+)["'])[^>]*>/i)
    ?? html.match(/<meta\b(?=[^>]*content=["']([^"']+)["'])(?=[^>]*(?:property|name)=["'](?:product:brand|og:brand|brand)["'])[^>]*>/i);
  if (meta?.[1]?.trim()) return meta[1].trim();
  const micro = html.match(/<[^>]*\bitemprop=["']brand["'][^>]*>([^<]+)</i);
  return micro?.[1]?.trim() || null;
}

/**
 * Verify the top N candidates (up to `maxCandidates`) in parallel.
 * Returns results sorted by verification score descending, with
 * failed fetches filtered out.
 */
export async function verifyTopCandidates(
  candidates: InsertSourceData[],
  context: VerificationContext,
  maxCandidates = 3,
  fetchFn: NetworkFetch = fetch,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<VerificationResult[]> {
  const toVerify = candidates.slice(0, maxCandidates);
  if (toVerify.length === 0) return [];

  const settled = await Promise.allSettled(
    toVerify.map(c => verifyCandidate(c, context, fetchFn, options)),
  );

  const results: VerificationResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value !== null) {
      results.push(s.value);
    }
  }
  results.sort((a, b) => b.verificationScore - a.verificationScore);
  return results;
}

// ─── Structured GTIN Extraction ─────────────────────────────────────────────

function extractJsonLdGtins(
  node: unknown,
  results: ExtractedPageGtin[],
  pathPrefix = '',
) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, idx) => {
      extractJsonLdGtins(item, results, `${pathPrefix}[${idx}]`);
    });
    return;
  }

  const record = node as Record<string, unknown>;

  if (Array.isArray(record['@graph'])) {
    record['@graph'].forEach((item, idx) => {
      extractJsonLdGtins(item, results, `${pathPrefix}@graph[${idx}]`);
    });
    return;
  }

  const type = record['@type'];
  const isType = (t: string) =>
    type === t || (Array.isArray(type) && type.includes(t));

  if (isType('Product')) {
    const candidateGtins: Array<{ key: string; val: unknown }> = [
      { key: 'gtin12', val: record.gtin12 },
      { key: 'gtin13', val: record.gtin13 },
      { key: 'gtin14', val: record.gtin14 },
      { key: 'gtin8', val: record.gtin8 },
      { key: 'gtin', val: record.gtin },
    ];
    for (const c of candidateGtins) {
      if (typeof c.val === 'string' || typeof c.val === 'number') {
        const rawStr = String(c.val).trim();
        if (rawStr) {
          results.push({
            gtin: rawStr,
            normalizedGtin: normalizeGtinDigits(rawStr),
            type: 'single',
            path: `${pathPrefix ? pathPrefix + '.' : ''}Product.${c.key}`,
            isValidChecksum: validateGtin(rawStr),
          });
        }
      }
    }
    // Also check offers if present
    if (record.offers && typeof record.offers === 'object') {
      const offersArr = Array.isArray(record.offers) ? record.offers : [record.offers];
      offersArr.forEach((offer, offIdx) => {
        if (offer && typeof offer === 'object') {
          const offRecord = offer as Record<string, unknown>;
          const offerGtins = [
            { key: 'gtin12', val: offRecord.gtin12 },
            { key: 'gtin13', val: offRecord.gtin13 },
            { key: 'gtin14', val: offRecord.gtin14 },
            { key: 'gtin8', val: offRecord.gtin8 },
            { key: 'gtin', val: offRecord.gtin },
          ];
          for (const og of offerGtins) {
            if (typeof og.val === 'string' || typeof og.val === 'number') {
              const rawStr = String(og.val).trim();
              if (rawStr) {
                results.push({
                  gtin: rawStr,
                  normalizedGtin: normalizeGtinDigits(rawStr),
                  type: 'single',
                  path: `${pathPrefix ? pathPrefix + '.' : ''}Product.offers[${offIdx}].${og.key}`,
                  isValidChecksum: validateGtin(rawStr),
                });
              }
            }
          }
        }
      });
    }
  } else if (isType('ProductGroup')) {
    if (Array.isArray(record.hasVariant)) {
      record.hasVariant.forEach((v, idx) => {
        if (v && typeof v === 'object') {
          const vRecord = v as Record<string, unknown>;
          const variantGtins = [
            { key: 'gtin12', val: vRecord.gtin12 },
            { key: 'gtin13', val: vRecord.gtin13 },
            { key: 'gtin14', val: vRecord.gtin14 },
            { key: 'gtin8', val: vRecord.gtin8 },
            { key: 'gtin', val: vRecord.gtin },
            { key: 'barcode', val: vRecord.barcode },
          ];
          for (const vg of variantGtins) {
            if (typeof vg.val === 'string' || typeof vg.val === 'number') {
              const rawStr = String(vg.val).trim();
              if (rawStr) {
                results.push({
                  gtin: rawStr,
                  normalizedGtin: normalizeGtinDigits(rawStr),
                  type: 'variant',
                  path: `${pathPrefix ? pathPrefix + '.' : ''}ProductGroup.hasVariant[${idx}].${vg.key}`,
                  isValidChecksum: validateGtin(rawStr),
                });
              }
            }
          }
        }
      });
    }
  }
}

/**
 * Extract structured GTIN representations from HTML.
 * Targets:
 *   - JSON-LD Product (@type="Product" and @graph)
 *   - JSON-LD ProductGroup (@type="ProductGroup" with hasVariant)
 *   - Shopify ProductJson scripts
 *   - HTML5 Microdata (itemprop="gtin*")
 *   - Meta tags (product:upc, product:ean, og:product:upc)
 */
export function extractStructuredGtinsFromHtml(html: string): ExtractedPageGtin[] {
  const extractedGtins: ExtractedPageGtin[] = [];

  // 1. JSON-LD scripts
  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      extractJsonLdGtins(parsed, extractedGtins);
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 2. Shopify productJSON
  const shopifyRegex = /<script\b[^>]*id=["'](?:ProductJson-|product-json-)[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  let shopifyMatch: RegExpExecArray | null;
  while ((shopifyMatch = shopifyRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(shopifyMatch[1]);
      if (parsed && Array.isArray(parsed.variants)) {
        const isMulti = parsed.variants.length > 1;
        parsed.variants.forEach((v: any, idx: number) => {
          if (v && v.barcode) {
            const rawStr = String(v.barcode).trim();
            if (rawStr) {
              extractedGtins.push({
                gtin: rawStr,
                normalizedGtin: normalizeGtinDigits(rawStr),
                type: isMulti ? 'variant' : 'single',
                path: `ShopifyProductJson.variants[${idx}].barcode`,
                isValidChecksum: validateGtin(rawStr),
              });
            }
          }
        });
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 3. HTML5 Microdata
  const microContentRegex = /<[^>]*\bitemprop=["'](gtin12|gtin13|gtin14|gtin8|gtin)["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/gi;
  let microContentMatch: RegExpExecArray | null;
  while ((microContentMatch = microContentRegex.exec(html)) !== null) {
    const rawStr = microContentMatch[2].trim();
    if (rawStr) {
      extractedGtins.push({
        gtin: rawStr,
        normalizedGtin: normalizeGtinDigits(rawStr),
        type: 'single',
        path: `itemprop=${microContentMatch[1]}[content]`,
        isValidChecksum: validateGtin(rawStr),
      });
    }
  }

  const microTextRegex = /<[^>]*\bitemprop=["'](gtin12|gtin13|gtin14|gtin8|gtin)["'][^>]*>([^<]+)<\//gi;
  let microTextMatch: RegExpExecArray | null;
  while ((microTextMatch = microTextRegex.exec(html)) !== null) {
    const rawStr = microTextMatch[2].trim();
    if (rawStr) {
      extractedGtins.push({
        gtin: rawStr,
        normalizedGtin: normalizeGtinDigits(rawStr),
        type: 'single',
        path: `itemprop=${microTextMatch[1]}`,
        isValidChecksum: validateGtin(rawStr),
      });
    }
  }

  // 4. Meta tags
  const metaRegex = /<meta\b[^>]*(?:property|name)=["'](product:upc|product:ean|og:product:upc)["'][^>]*content=["']([^"']+)["']/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const rawStr = metaMatch[2].trim();
    if (rawStr) {
      extractedGtins.push({
        gtin: rawStr,
        normalizedGtin: normalizeGtinDigits(rawStr),
        type: 'single',
        path: `meta[${metaMatch[1]}]`,
        isValidChecksum: validateGtin(rawStr),
      });
    }
  }

  const metaContentFirstRegex = /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](product:upc|product:ean|og:product:upc)["']/gi;
  let metaContentFirstMatch: RegExpExecArray | null;
  while ((metaContentFirstMatch = metaContentFirstRegex.exec(html)) !== null) {
    const rawStr = metaContentFirstMatch[1].trim();
    if (rawStr) {
      extractedGtins.push({
        gtin: rawStr,
        normalizedGtin: normalizeGtinDigits(rawStr),
        type: 'single',
        path: `meta[${metaContentFirstMatch[2]}]`,
        isValidChecksum: validateGtin(rawStr),
      });
    }
  }

  return extractedGtins;
}

// ─── Identity Proof Qualification ───────────────────────────────────────────

/**
 * Qualifies extracted GTIN identity proof according to strict P1-A criteria.
 */
export function qualifyIdentityProof(
  extractedGtins: ExtractedPageGtin[],
  targetUpc: string,
  signals: Pick<VerificationSignals, 'isListingOrSearchPage' | 'isBlogOrCmsPage' | 'upcInPage'>,
): { proofClass: ProofClass; decisionReason: string } {
  // 1. Hard disqualification for listing, search, blog, or CMS pages
  if (signals.isListingOrSearchPage || signals.isBlogOrCmsPage) {
    return {
      proofClass: 'none',
      decisionReason: signals.isListingOrSearchPage ? 'listing_or_search_page' : 'blog_or_cms_page',
    };
  }

  // 2. Structured data presence
  if (extractedGtins.length === 0) {
    return {
      proofClass: 'none',
      decisionReason: signals.upcInPage ? 'upc_in_body_or_review_text_only' : 'no_structured_gtin_found',
    };
  }

  // 3. Checksum validation
  const validChecksumGtins = extractedGtins.filter(g => g.isValidChecksum);
  if (validChecksumGtins.length === 0) {
    return {
      proofClass: 'none',
      decisionReason: 'invalid_gtin_checksum_or_length',
    };
  }

  // 4. Single-product contradiction check
  const singleProductGtins = validChecksumGtins.filter(g => g.type === 'single');
  const distinctSingleGtins = new Set(
    singleProductGtins.map(g => padGtinTo14(g.gtin) ?? g.normalizedGtin),
  );
  if (distinctSingleGtins.size > 1) {
    return {
      proofClass: 'none',
      decisionReason: 'contradictory_gtins_found',
    };
  }

  // 5. Target GTIN canonical match
  const matchingGtins = validChecksumGtins.filter(g => canonicalGtinMatch(g.gtin, targetUpc));
  if (matchingGtins.length === 0) {
    return {
      proofClass: 'none',
      decisionReason: 'gtin_mismatch_different_product_or_variant',
    };
  }

  // 6. Single product vs variant qualification
  const singleMatch = matchingGtins.find(g => g.type === 'single');
  if (singleMatch) {
    return {
      proofClass: 'exact_structured_gtin',
      decisionReason: 'exact_structured_gtin_verified',
    };
  }

  const variantMatches = matchingGtins.filter(g => g.type === 'variant');
  if (variantMatches.length === 1) {
    return {
      proofClass: 'exact_variant_gtin',
      decisionReason: 'exact_variant_gtin_resolved',
    };
  }

  if (variantMatches.length > 1) {
    return {
      proofClass: 'none',
      decisionReason: 'ambiguous_multiple_matching_variants',
    };
  }

  return {
    proofClass: 'none',
    decisionReason: 'unresolved_identity',
  };
}

// ─── Signal extraction ───────────────────────────────────────────────────────

// fallow-ignore-next-line unused-export
export function extractVerificationSignals(
  html: string,
  url: string,
  context: VerificationContext,
): VerificationSignals {
  const lowerName = context.expectedName.toLowerCase();
  const candidateDomain = extractHostname(url);

  const pageHeadingMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const pageHeading = pageHeadingMatch
    ? pageHeadingMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : null;
  // ── Page title ────────────────────────────────────────────────────────
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;

  // ── Meta description ──────────────────────────────────────────────────
  const metaDescMatch = html.match(
    /<meta\s[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta\s[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i,
  );
  const _metaDescription = metaDescMatch ? metaDescMatch[1].trim() : '';

  // ── Canonical URL ─────────────────────────────────────────────────────
  const canonMatch = html.match(
    /<link\s[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<link\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']canonical["'][^>]*>/i,
  );
  const canonicalUrl = canonMatch ? canonMatch[1].trim() : null;

  // ── JSON-LD Product ───────────────────────────────────────────────────
  const hasJsonLdProduct = /"@type"\s*:\s*"Product"/i.test(html);

  // ── Shopify productJSON ───────────────────────────────────────────────
  const productJson = extractProductJsonFromHtml(html);
  const hasShopifyProductJson = productJson !== null;

  // ── Variant resolution (via productJSON) ──────────────────────────────
  let variantResolved = false;
  if (productJson && Array.isArray(productJson.variants)) {
    const realVariants = productJson.variants.filter(
      (v: any) => v && v.title !== 'Default Title' && v.title !== 'Default',
    );
    if (realVariants.length > 0) {
      // Check if any variant matches UPC/barcode or name tokens
      const normUpc = context.upc.replace(/\D+/g, '');
      const nameTokens = tokenize(lowerName);
      for (const v of realVariants) {
        const vBarcode = v.barcode ? String(v.barcode).replace(/\D+/g, '') : '';
        if (normUpc && vBarcode === normUpc) {
          variantResolved = true;
          break;
        }
        const vTitle = (v.title || '').toLowerCase();
        const vOpt1 = (v.option1 || '').toLowerCase();
        const vOpt2 = (v.option2 || '').toLowerCase();
        const vOpt3 = (v.option3 || '').toLowerCase();
        const combined = `${vTitle} ${vOpt1} ${vOpt2} ${vOpt3}`;
        let nameHits = 0;
        for (const t of nameTokens) {
          if (combined.includes(t)) nameHits++;
        }
        if (nameHits >= Math.max(1, Math.floor(nameTokens.length * 0.4))) {
          variantResolved = true;
          break;
        }
      }
    }
  }

  // ── UPC / barcode in page ─────────────────────────────────────────────
  const upcDigits = context.upc.replace(/\D+/g, '');
  const upcInPage = upcDigits.length >= 8 && html.includes(upcDigits);

  // ── SKU presence ──────────────────────────────────────────────────────
  // Lightweight SKU detection: look for common SKU patterns in meta/property tags.
  const skuInPage =
    /"sku"\s*:\s*"[^"]+"/i.test(html) ||
    /<meta\s[^>]*property\s*=\s*["']product:retailer_item_id["'][^>]*/i.test(html) ||
    /"@type"\s*:\s*"Product"[^}]*"sku"/is.test(html) ||
    /SKU-/i.test(html);

  // ── Brand match ───────────────────────────────────────────────────────
  let brandInPage = false;
  if (context.brandHint) {
    const brandLower = context.brandHint.toLowerCase().trim();
    // Check in JSON-LD brand, meta tags, and page title
    const brandInJsonLd = new RegExp(
      `"brand"\\s*:\\s*(\\{[^}]*"name"\\s*:\\s*"[^"]*${escapeRegex(brandLower)}[^"]*"[^}]*\\}|"${escapeRegex(brandLower)}")`,
      'i',
    ).test(html);
    const brandInMeta = new RegExp(
      `<meta\\s[^>]*content\\s*=\\s*["'][^"']*${escapeRegex(brandLower)}[^"']*["'][^>]*`,
      'i',
    ).test(html);
    const brandInTitle = pageTitle
      ? pageTitle.toLowerCase().includes(brandLower)
      : false;
    brandInPage = brandInJsonLd || brandInMeta || brandInTitle;
  }

  // ── Title/name similarity ─────────────────────────────────────────────
  const titleSimilarity = pageTitle
    ? computeTitleSimilarity(pageTitle, context.expectedName)
    : 0;

  // ── Title word-level overlap ──────────────────────────────────────────
  const titleNameOverlap = pageTitle
    ? computeTokenOverlap(pageTitle, tokenize(lowerName))
    : 0;

  // ── Page type detection (from URL + title + HTML) ─────────────────────
  const urlLower = url.toLowerCase();
  const hasProductIndicator =
    /\/(products?|p|item|details?|dp|gp|buy)\//i.test(urlLower);
  const isListingOrSearchPage =
    /category-listing|collection-page|search-results-page|\/collections\/|\/search\?/i.test(html) ||
    /<body[^>]*class=["'][^"']*(?:collection|search)[^"']*["']/i.test(html) ||
    (/\/(collections?|category|categories|product-category|brands?|tags?|search|shop-all|all-products)\//i.test(
      urlLower,
    ) && !hasProductIndicator);
  const isBlogOrCmsPage =
    /blog-post-article|\/blogs\//i.test(html) ||
    (/\/(blogs?|articles?|pages|about|contact|faq)\//i.test(urlLower) &&
    !hasProductIndicator);
  const isProductDetailPage = hasProductIndicator && !isListingOrSearchPage && !isBlogOrCmsPage;

  // ── Domain official ───────────────────────────────────────────────────
  let domainOfficial = false;
  if (candidateDomain) {
    domainOfficial = context.officialDomains.some(d =>
      isOfficialDomainMatch(candidateDomain, d),
    );
  }

  // ── Canonical matches candidate ───────────────────────────────────────
  const canonicalMatchesCandidate =
    canonicalUrl !== null && normalizeUrl(canonicalUrl) === normalizeUrl(url);

  return {
    domainOfficial,
    isProductDetailPage,
    isListingOrSearchPage,
    isBlogOrCmsPage,
    titleSimilarity,
    brandInPage,
    upcInPage,
    skuInPage,
    hasJsonLdProduct,
    hasShopifyProductJson,
    variantResolved,
    canonicalMatchesCandidate,
    pageTitle,
    pageHeading,
    titleNameOverlap,
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

// fallow-ignore-next-line unused-export
export function computeVerificationScore(signals: VerificationSignals): number {
  let score = 0;

  // ── Positive signals ──────────────────────────────────────────────────

  // Domain is official — strong positive
  if (signals.domainOfficial) {
    score += 25;
  }

  // Page looks like product detail (not search/blog/listing)
  if (signals.isProductDetailPage) {
    score += 15;
  }

  // UPC/barcode in page — strongest single signal
  if (signals.upcInPage) {
    score += 60;
  }

  // Variant resolved via productJSON — very strong signal
  if (signals.variantResolved) {
    score += 50;
  }

  // Shopify productJSON present
  if (signals.hasShopifyProductJson) {
    score += 15;
  }

  // JSON-LD Product schema
  if (signals.hasJsonLdProduct) {
    score += 20;
  }

  // SKU present
  if (signals.skuInPage) {
    score += 10;
  }

  // Title similarity (0–1 scale, weighted)
  score += signals.titleSimilarity * 20;

  // Title word overlap bonus (0–1 scale)
  score += signals.titleNameOverlap * 10;

  // Brand match in page content
  if (signals.brandInPage) {
    score += 10;
  }

  // Canonical URL matches candidate — indicates canonical product page
  if (signals.canonicalMatchesCandidate) {
    score += 10;
  }

  // ── Negative signals ──────────────────────────────────────────────────

  if (signals.isListingOrSearchPage) {
    score -= 30;
  }

  if (signals.isBlogOrCmsPage) {
    score -= 40;
  }

  return score;
}

// ─── Legacy helper (preserved for backwards-compatibility) ────────────────────

// fallow-ignore-next-line unused-export
export function hasIdentityProof(signals: VerificationSignals): boolean {
  let count = 0;

  if (signals.upcInPage) count += 3;
  if (signals.variantResolved) count += 3;

  if (signals.hasJsonLdProduct && signals.titleSimilarity >= 0.4 && signals.brandInPage) {
    count += 2;
  }

  if (signals.hasShopifyProductJson && signals.titleSimilarity >= 0.4) {
    count += 2;
  }

  if (signals.skuInPage) count += 1;
  if (signals.titleNameOverlap >= 0.6) count += 1;

  return count >= MIN_IDENTITY_SIGNALS;
}

// fallow-ignore-next-line unused-export
export function buildDecisionReason(
  signals: VerificationSignals,
  score: number,
  hasStrongProof: boolean,
): string {
  const parts: string[] = [];

  if (signals.upcInPage) parts.push('UPC found in page');
  if (signals.variantResolved) parts.push('variant resolved via productJSON');
  if (signals.hasJsonLdProduct) parts.push('JSON-LD Product schema present');
  if (signals.hasShopifyProductJson) parts.push('Shopify productJSON present');
  if (signals.domainOfficial) parts.push('official domain');
  if (signals.brandInPage) parts.push('brand match');
  if (signals.isProductDetailPage) parts.push('product detail page');
  if (signals.isListingOrSearchPage) parts.push('WARNING: listing/search page');
  if (signals.isBlogOrCmsPage) parts.push('WARNING: blog/CMS page');
  if (signals.titleSimilarity >= 0.5) parts.push(`title similarity ${(signals.titleSimilarity * 100).toFixed(0)}%`);

  const signalStr = parts.length > 0 ? parts.join(', ') : 'no strong signals';
  const verdict = hasStrongProof ? 'verified' : 'needs review';

  return `[${verdict}] score=${score.toFixed(0)} | ${signalStr}`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 2);
}

function computeTokenOverlap(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let matches = 0;
  for (const t of tokens) {
    if (lower.includes(t)) matches++;
  }
  return matches / tokens.length;
}

function computeTitleSimilarity(pageTitle: string, expectedName: string): number {
  const titleTokens = tokenize(pageTitle);
  const nameTokens = tokenize(expectedName);
  if (nameTokens.length === 0) return 0;

  let matchCount = 0;
  for (const nt of nameTokens) {
    if (titleTokens.some(tt => tt.includes(nt) || nt.includes(tt))) {
      matchCount++;
    }
  }

  const overlap = matchCount / nameTokens.length;
  const lengthRatio = Math.min(1, titleTokens.length / Math.max(1, nameTokens.length));

  return overlap * 0.7 + lengthRatio * 0.3;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
