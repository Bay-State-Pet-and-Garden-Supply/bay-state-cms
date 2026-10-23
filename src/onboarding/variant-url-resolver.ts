import { extractProductJsonFromHtml } from './shopify-json';
import { diffRegisterVsExpected, tokenSet, parseVariantMatrix, matchVariantMatrix, deriveVariantTokens } from './variant-resolver';
import { productUrlIdentityKey, parentProductKey, buildVariantDeepLink, hasVariantParam } from './product-url-identity';
import { getEffectiveVariantResolutionMode } from './variant-flags';
import { computeIdentityMatrixHash } from '../shared/schemas/variant-resolution';
import { assertSafeVariantDestination, classifyIp } from '../shared/ssrf';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';
import type { VariantUrlInput } from '../db/repositories/brand-url-index-repo';

export const MAX_VARIANT_PARENT_FETCHES = 3;
const FETCH_TIMEOUT_MS = 15000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DOMAIN_MIN_INTERVAL_MS = 500; // 2 req/s per domain
const DOMAIN_RETRY_DEFAULT_MS = 5000;
const DOMAIN_RETRY_MAX_MS = 60000;
const domainRateState = new Map<string, { lastFetch: number; retryUntil: number }>();
const domainLocks = new Map<string, Promise<void>>();
async function withDomainLock<T>(domainKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = domainLocks.get(domainKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  domainLocks.set(domainKey, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); }
}

function getDomainKey(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '').trim(); } catch { return url.toLowerCase(); }
}
function parseRetryAfter(value: string | null): number {
  if (!value) return DOMAIN_RETRY_DEFAULT_MS;
  const v = value.trim();
  const n = parseInt(v, 10);
  if (!isNaN(n) && String(n) === v) return Math.min(Math.max(n * 1000, 0), DOMAIN_RETRY_MAX_MS);
  const d = Date.parse(v);
  if (!isNaN(d)) return Math.min(Math.max(d - Date.now(), 0), DOMAIN_RETRY_MAX_MS);
  return DOMAIN_RETRY_DEFAULT_MS;
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
export function __resetVariantDomainRateStateForTests() { domainRateState.clear(); }
export function __getVariantDomainRateStateForTests(domain: string) { return domainRateState.get(domain.toLowerCase().replace(/^www\./, '').trim()) ?? null; }

export interface VariantResolutionContext {
  upc: string;
  rawName: string;
  expectedName: string;
  brandHint: string | null;
}

export interface ShopifyVariantCandidate {
  id: string;
  title: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  sku?: string | null;
  barcode?: string | null;
  image?: string | null;
  url: string;
}

export type VariantResolutionResult =
  | { status: 'no_variants' }
  | {
      status: 'resolved';
      platform: 'shopify';
      variant: ShopifyVariantCandidate & { score: number; matchedSignals: string[] };
      confidence: number;
      matchedSignals: string[];
    }
  | {
      status: 'ambiguous';
      platform: 'shopify';
      variants: Array<ShopifyVariantCandidate & { score: number; matchedSignals: string[] }>;
      confidence: number;
      matchedSignals: string[];
    };

const COMMON_COLORS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink',
  'brown', 'grey', 'gray', 'lavender', 'gold', 'silver', 'lav', 'chkn', 'turk', 'veg',
]);
const COMMON_SIZES = new Set([
  's', 'm', 'l', 'xl', 'xxl', 'xs', 'small', 'medium', 'large', 'mini', 'giant',
  'standard', 'pack', 'count', 'ct', 'oz', 'lb', 'g', 'kg', 'ml', 'sm', 'md', 'lg',
]);

function isVariantToken(t: string): boolean {
  const lower = t.toLowerCase();
  if (COMMON_COLORS.has(lower) || COMMON_SIZES.has(lower)) return true;
  if (/^\d+(oz|lb|g|kg|ml|ct|pack|s)?$/i.test(lower)) return true;
  return false;
}

function buildVariantUrl(baseUrl: string, variantId: string): string {
  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set('variant', variantId);
    return urlObj.toString();
  } catch {
    return `${baseUrl}?variant=${variantId}`;
  }
}

/**
 * @deprecated P2 legacy — use parseVariantMatrix/matchVariantMatrix from variant-resolver.ts (canonical). Kept for backwards compat, no prod callers (only tests).
 * Score a Shopify variant candidate deterministically against product metadata.
 */
// fallow-ignore-next-line unused-export — used by tests
export function scoreShopifyVariant(
  v: Omit<ShopifyVariantCandidate, 'url'>,
  context: VariantResolutionContext,
  hints: Set<string>,
  variantNameTokens: Set<string>
): { score: number; matchedSignals: string[] } {
  let score = 0;
  const matchedSignals: string[] = [];

  // 1. UPC/barcode exact match (Highest Priority)
  const normUpc = context.upc ? String(context.upc).trim().replace(/^0+/, '') : '';
  const normBarcode = v.barcode ? String(v.barcode).trim().replace(/^0+/, '') : '';
  if (normUpc && normBarcode && normUpc === normBarcode) {
    score += 1000;
    matchedSignals.push('barcode-exact');
  }

  // Set up token sets for variant description
  const varTitleTokens = tokenSet(v.title);
  const varOptionTokens = new Set<string>();
  if (v.option1) tokenSet(v.option1).forEach(t => varOptionTokens.add(t));
  if (v.option2) tokenSet(v.option2).forEach(t => varOptionTokens.add(t));
  if (v.option3) tokenSet(v.option3).forEach(t => varOptionTokens.add(t));

  // 2. Expected name token match (size/color/flavor)
  for (const h of hints) {
    if (varTitleTokens.has(h) || varOptionTokens.has(h)) {
      score += 20;
      matchedSignals.push(`hint-token:${h}`);
    }
  }

  for (const vt of variantNameTokens) {
    if (varTitleTokens.has(vt) || varOptionTokens.has(vt)) {
      score += 30;
      matchedSignals.push(`variant-token:${vt}`);
    }
  }

  // 3. Variant option exact match
  for (const opt of [v.option1, v.option2, v.option3]) {
    if (!opt) continue;
    const normOpt = opt.toLowerCase().trim();
    if (hints.has(normOpt) || variantNameTokens.has(normOpt)) {
      score += 60;
      matchedSignals.push(`option-exact:${normOpt}`);
    }
  }

  // 4. SKU contains helper
  if (v.sku && context.rawName.toLowerCase().includes(v.sku.toLowerCase())) {
    score += 50;
    matchedSignals.push(`sku-contains:${v.sku}`);
  }

  // (Input Price Authority, ADR 0043: no price scoring — matching uses
  // identity evidence only.)

  return { score, matchedSignals };
}

/**
 * @deprecated P2 legacy — use parseVariantMatrix + matchVariantMatrix (canonical, 5 adapters). Shim kept so existing unit tests stay green.
 * Resolve Shopify variants from raw HTML.
 */
// fallow-ignore-next-line unused-export — used by tests
export function resolveVariantsFromHtml(
  baseUrl: string,
  html: string,
  context: VariantResolutionContext
): VariantResolutionResult {
  const productJson = extractProductJsonFromHtml(html);
  if (!productJson || !Array.isArray(productJson.variants) || productJson.variants.length === 0) {
    return { status: 'no_variants' };
  }

  const realVariants = productJson.variants.filter(
    (v: any) => v && v.title !== 'Default Title' && v.title !== 'Default'
  );
  if (realVariants.length === 0) {
    return { status: 'no_variants' };
  }

  // Normalize variants
  const candidates: ShopifyVariantCandidate[] = productJson.variants.map((v: any) => {

    let imageUrl: string | null = null;
    if (v.featured_image) {
      imageUrl = typeof v.featured_image === 'string' ? v.featured_image : v.featured_image.src || null;
    } else if (v.image) {
      imageUrl = typeof v.image === 'string' ? v.image : v.image.src || null;
    }

    return {
      id: String(v.id),
      title: v.title || '',
      option1: v.option1 || null,
      option2: v.option2 || null,
      option3: v.option3 || null,
      sku: v.sku || null,
      barcode: v.barcode || null,
      image: imageUrl,
      url: buildVariantUrl(baseUrl, String(v.id)),
    };
  });

  // Background indexing of variant URLs and their barcodes/SKUs into local brand URL index
  try {
    const parsedUrl = new URL(baseUrl);
    const domain = parsedUrl.hostname;
    const variantInputs: VariantUrlInput[] = candidates.map(c => ({
      url: c.url,
      baseUrl,
      title: c.title ? `${productJson.title || ''} - ${c.title}`.trim().replace(/^-\s*/, '') : null,
      upc: c.barcode || null,
      sku: c.sku || null,
      brand: context.brandHint || productJson.vendor || null,
      variantTokens: [c.option1, c.option2, c.option3].filter(Boolean) as string[],
    }));
    import('../db/repositories/brand-url-index-repo')
      .then(mod => mod.indexVariantUrls(domain, variantInputs))
      .catch(() => {});
  } catch {
    // Non-critical background index update
  }

  // Extract hints and specific variant tokens from expected context
  const hints = diffRegisterVsExpected(context.rawName, context.expectedName, context.brandHint);
  const rawTokens = tokenSet(context.rawName);
  const expectedTokens = tokenSet(context.expectedName);
  const allTokens = new Set([...rawTokens, ...expectedTokens]);
  const variantNameTokens = new Set<string>();
  for (const t of allTokens) {
    if (isVariantToken(t)) {
      variantNameTokens.add(t);
    }
  }

  // Score all variant candidates
  const scored = candidates.map(c => {
    const { score, matchedSignals } = scoreShopifyVariant(c, context, hints, variantNameTokens);
    return { ...c, score, matchedSignals };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) {
    return { status: 'no_variants' };
  }

  const second = scored[1];
  let ambiguous = false;
  if (second) {
    const bestHasBarcode = best.matchedSignals.includes('barcode-exact');
    const secondHasBarcode = second.matchedSignals.includes('barcode-exact');
    
    if (best.score === second.score) {
      ambiguous = true;
    } else if (second.score > 0) {
      // If best has barcode-exact and second doesn't, it's NOT ambiguous (barcode is absolute match)
      if (bestHasBarcode && !secondHasBarcode) {
        ambiguous = false;
      } else {
        const margin = (best.score - second.score) / best.score;
        if (margin < 0.2) {
          ambiguous = true;
        }
      }
    }
  }

  if (ambiguous) {
    return {
      status: 'ambiguous',
      platform: 'shopify',
      variants: scored,
      confidence: best.score / 100,
      matchedSignals: best.matchedSignals,
    };
  }

  return {
    status: 'resolved',
    platform: 'shopify',
    variant: best,
    confidence: Math.min(1.0, best.score / 100),
    matchedSignals: best.matchedSignals,
  };
}

/**
 * Main entry point: run variant resolution on candidates.
 * M3: canonical matrix, identity-aware dedupe, hard cap 3 after deterministic sort,
 * official-domain gating, mode-aware (off→no fetch, observe→diagnostics only).
 */

/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface VariantDiscoveryResolution {
  status: 'off' | 'no_variants' | 'resolved' | 'ambiguous' | 'observe' | 'skipped_no_fetch' | 'no_candidate';
  selectedKey: string | null;
  candidatesCount: number;
  overflow: boolean;
  warnings: string[];
  identityHash: string | null;
  expandedCount?: number;
  // Canonical matrix candidates with real variantKey/identifiers for durable persistence (P1-1: avoid fabricated variant-0)
  matrixCandidates?: import('../shared/schemas/variant-resolution').NormalizedVariantCandidate[];
}

export interface ResolveVariantsResult {
  candidates: InsertSourceData[];
  resolution: VariantDiscoveryResolution;
}

export async function resolveVariantsForCandidates(options: {
  candidates: InsertSourceData[];
  upc: string;
  rawName: string;
  expectedName: string;
  brandHint: string | null;
  brandDomains: string[];
  fetchFn?: NetworkFetch;
  variantTokens?: string[];
}): Promise<ResolveVariantsResult> {
  const { candidates, upc, rawName, expectedName, brandHint, brandDomains, fetchFn, variantTokens: explicitTokens } = options;
  const mode = getEffectiveVariantResolutionMode();
  if (mode === 'off') return { candidates, resolution: { status: 'off', selectedKey: null, candidatesCount: 0, overflow: false, warnings: [], identityHash: null } };
  // Already deep-linked candidates: retain without re-fetch when metadata sufficient
  const alreadyVariantLinked = candidates.filter(c => hasVariantParam(c.url));
  // Keep them; they don't consume fetch budget
  // Build bounded set: deterministic sort first, then hard cap 3 with parent-key dedupe
  const withRank = candidates.map(c => {
    // Derive hostname from actual URL — not trusted c.domain to prevent spoofing (evil.com with betterbone.com domain string)
    // Malformed URLs are not fetch-eligible — do not fall back to c.domain
    let urlHostname = '';
    try { urlHostname = new URL(c.url).hostname.toLowerCase().replace(/^www\./,'').trim(); } catch { urlHostname = ''; }
    const isOfficial = brandDomains.some(d => {
      const normD = d.toLowerCase().replace(/^www\./, '').trim();
      return urlHostname === normD || urlHostname.endsWith('.' + normD);
    });
    return {
      c,
      isOfficial,
      identityKey: (() => { try { return productUrlIdentityKey(c.url); } catch { return c.url.toLowerCase(); } })(),
      parentKey: (() => { try { return parentProductKey(c.url); } catch { return c.url.toLowerCase(); } })(),
    };
  });
  withRank.sort((a, b) => {
    if (b.c.confidence !== a.c.confidence) return b.c.confidence - a.c.confidence;
    if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;
    return a.identityKey.localeCompare(b.identityKey);
  });
  const boundedList: InsertSourceData[] = [];
  const seenParent = new Set<string>();
  for (const wr of withRank) {
    if (hasVariantParam(wr.c.url)) continue; // already linked, no fetch needed
    const pk = wr.parentKey;
    if (seenParent.has(pk)) continue;
    // Official-domain gating: only fetch if candidate's domain matches an official brand domain
    const allowFetch = wr.isOfficial;
    if (!allowFetch) continue;
    seenParent.add(pk);
    boundedList.push(wr.c);
    if (boundedList.length >= MAX_VARIANT_PARENT_FETCHES) break;
  }

  // Fetch and resolve using canonical matrix/matcher; degrade gracefully
  const variantTokens = (explicitTokens && explicitTokens.length > 0) ? explicitTokens : deriveVariantTokens(rawName || expectedName, brandHint);
  const resolvedMap = new Map<string, { matrix: ReturnType<typeof parseVariantMatrix>; decision: ReturnType<typeof matchVariantMatrix>; html: string }>();
  // Enforce injected transport contract: if fetches are needed, fetchFn must be provided (mode off already returned)
  if (boundedList.length > 0 && !fetchFn) {
    throw new Error('resolveVariantsForCandidates: fetchFn is required when variant resolution mode is not off');
  }
  await Promise.all(
    boundedList.map(cand => withDomainLock(getDomainKey(cand.url), async () => {
      try {
        // Per-domain active sweep protection: serialized, re-reads retryUntil after lock
        const domainKey = getDomainKey(cand.url);
        const state = domainRateState.get(domainKey);
        const now = Date.now();
        if (state && state.retryUntil > now) {
          console.warn(`[variant-url-resolver] throttled ${cand.url} until ${new Date(state.retryUntil).toISOString()} (429)`);
          return;
        }
        if (state && now - state.lastFetch < DOMAIN_MIN_INTERVAL_MS) {
          const waitMs = DOMAIN_MIN_INTERVAL_MS - (now - state.lastFetch);
          await sleep(waitMs);
        }
        domainRateState.set(domainKey, { lastFetch: Date.now(), retryUntil: state?.retryUntil ?? 0 });
        const fetcher = fetchFn!;
        // Per-hop manual redirect with allowlist + SSRF literal check before each fetch
        let currentUrl = cand.url;
        let res: Response | null = null;
        for (let hop = 0; hop <= 3; hop++) {
          // Per-hop throttling: re-read state after wait, preserve latest retryUntil
          const hopState = domainRateState.get(domainKey);
          const hopNow = Date.now();
          if (hopState && hopState.retryUntil > hopNow) return;
          if (hopState && hopNow - hopState.lastFetch < DOMAIN_MIN_INTERVAL_MS) {
            await sleep(DOMAIN_MIN_INTERVAL_MS - (hopNow - hopState.lastFetch));
          }
          domainRateState.set(domainKey, { lastFetch: Date.now(), retryUntil: hopState?.retryUntil ?? 0 });
          // Authoritative shared destination assertion (protocol/creds/port/allowlist/literal IP + DNS private) — DNS lookup is authoritative, cheap literal check is defense-in-depth via classifyIp
          try { await assertSafeVariantDestination(currentUrl, brandDomains); } catch { return; }
          const hostLower = (() => { try { return new URL(currentUrl).hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; } })();
          const origHost = (() => { try { return new URL(cand.url).hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; } })();
          if (hostLower !== origHost && !hostLower.endsWith('.'+origHost) && !origHost.endsWith('.'+hostLower)) return;
          const attempt = await fetcher(currentUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: 'manual' as RequestRedirect,
          });
          const loc = attempt.headers.get('location');
          if (attempt.status >= 300 && attempt.status < 400 && loc) {
            currentUrl = new URL(loc, currentUrl).toString();
            continue;
          }
          res = attempt;
          break;
        }
        if (!res) return;
        // Update lastFetch after network (preserve latest retryUntil)
        domainRateState.set(domainKey, { lastFetch: Date.now(), retryUntil: domainRateState.get(domainKey)?.retryUntil ?? 0 });
        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after') ?? res.headers.get('Retry-After');
          const delayMs = parseRetryAfter(retryAfter);
          const until = Date.now() + delayMs;
          const cur = domainRateState.get(domainKey);
          const maxUntil = Math.max(cur?.retryUntil ?? 0, until);
          domainRateState.set(domainKey, { lastFetch: Date.now(), retryUntil: maxUntil });
          console.warn(`[variant-url-resolver] 429 for ${cand.url} retry-after ${delayMs}ms`);
          return;
        }
        if (!res.ok) return;
        // Content-Length pre-check before buffering
        const contentLength = res.headers.get('content-length');
        if (contentLength) {
          const len = parseInt(contentLength, 10);
          if (!isNaN(len) && len > MAX_BODY_BYTES) return;
        }
        // Stream with limit to avoid buffering >5MB before check
        let buf: Uint8Array;
        if (res.body && typeof (res.body as any).getReader === 'function') {
          const reader = (res.body as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              total += value.length;
              if (total > MAX_BODY_BYTES) { try { await reader.cancel(); } catch {} return; }
              chunks.push(value);
            }
          }
          buf = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { buf.set(c, off); off += c.length; }
        } else {
          buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length > MAX_BODY_BYTES) return;
        }
        const html = new TextDecoder().decode(buf);
        const matrix = parseVariantMatrix(html, cand.url);
        if (!matrix || matrix.candidates.length === 0) return;
        const decision = matchVariantMatrix(matrix, { gtin: upc || null, sku: null, mpn: null, name: rawName || expectedName, brandHint: brandHint ?? null, variantTokens });
        resolvedMap.set(cand.url, { matrix, decision, html });
      } catch (err) {
        console.warn(`[variant-url-resolver] Error resolving variants for ${cand.url}:`, err);
      }
    }))
  );
  // Observe mode: diagnostics only, no URL mutation but still produce structured resolution
  if (mode === 'observe') {
    const observed = candidates.map(c => {
      const r = resolvedMap.get(c.url);
      if (!r) return c;
      try {
        const meta = c.metadataJson ? JSON.parse(c.metadataJson) : {};
        meta.variantResolutionObserve = { status: r.decision.status, reasonCodes: r.decision.reasonCodes, matchedBy: r.decision.matchedBy };
        return { ...c, metadataJson: JSON.stringify(meta) };
      } catch { return c; }
    });
    // Build resolution summary for observe
    let status: VariantDiscoveryResolution['status'] = 'observe';
    let selectedKey: string | null = null;
    let candidatesCount = 0;
    let overflow = false;
    let warnings: string[] = [];
    let identityHash: string | null = null;
    let matrixCandidates: import('../shared/schemas/variant-resolution').NormalizedVariantCandidate[] | undefined = undefined;
    for (const [, r] of resolvedMap) {
      candidatesCount = Math.max(candidatesCount, r.matrix?.candidates.length ?? 0);
      warnings = [...warnings, ...(r.matrix?.warnings ?? [])];
      if (r.matrix) { try { identityHash = computeIdentityMatrixHash(r.matrix); } catch { identityHash = r.matrix.sourceContentHash ?? identityHash; } }
      if (!matrixCandidates && r.matrix?.candidates) matrixCandidates = r.matrix.candidates.slice(0, 250);
      if (r.decision.status === 'resolved' && r.decision.selectedVariantKey && !selectedKey) selectedKey = r.decision.selectedVariantKey;
      if (r.decision.status === 'ambiguous') status = 'observe';
      if ((r.matrix?.candidates.length ?? 0) > 250 || r.matrix?.warnings.includes('too_many_variants') || r.decision.status === 'too_many_variants' || r.matrix?.warnings.some(w => w.includes('too_many'))) overflow = true;
    }
    if (resolvedMap.size === 0) status = 'no_variants';
    return { candidates: observed, resolution: { status, selectedKey, candidatesCount, overflow, warnings, identityHash, matrixCandidates } };
  }
  // Active mode: synthesize deep links from decision
  const output: InsertSourceData[] = [];
  const alreadyAdded = new Set<string>();
  // Preserve already deep-linked candidates verbatim without counting toward cap
  for (const c of alreadyVariantLinked) {
    const key = (()=>{ try { return productUrlIdentityKey(c.url); } catch { return c.url.toLowerCase(); }})();
    if (!alreadyAdded.has(key)) { alreadyAdded.add(key); output.push(c); }
  }
  for (const c of candidates) {
    if (hasVariantParam(c.url)) continue; // already handled
    const r = resolvedMap.get(c.url);
    if (!r) {
      const key = (()=>{ try { return productUrlIdentityKey(c.url); } catch { return c.url.toLowerCase(); }})();
      if (!alreadyAdded.has(key)) { alreadyAdded.add(key); output.push(c); }
      continue;
    }
    const { matrix, decision } = r;
    if (decision.status === 'resolved' && decision.selectedVariantKey) {
      const sel = matrix!.candidates.find(x => x.variantKey === decision.selectedVariantKey);
      if (!sel) { const key = (()=>{ try { return productUrlIdentityKey(c.url); } catch { return c.url.toLowerCase(); }})(); if (!alreadyAdded.has(key)) { alreadyAdded.add(key); output.push(c);} continue; }
      const deep = buildVariantDeepLink(c.url, sel);
      const key = (()=>{ try { return productUrlIdentityKey(deep); } catch { return deep.toLowerCase(); }})();
      if (alreadyAdded.has(key)) continue;
      alreadyAdded.add(key);
      output.push({
        url: deep,
        title: c.title ? `${c.title} - ${sel.title}` : sel.title,
        snippet: c.snippet,
        domain: c.domain,
        confidence: Math.max(0, Math.min(1, 0.85)),
        sourceMethod: 'shopify_variant',
        metadataJson: JSON.stringify({ originalSourceMethod: c.sourceMethod ?? null, variantResolution: { status: 'resolved', platform: matrix!.platform, variantId: sel.platformId, variantTitle: sel.title, confidence: 0.85, matchedBy: decision.matchedBy, reasonCodes: decision.reasonCodes } }),
      });
    } else if (decision.status === 'ambiguous') {
      // Expand ambiguous but bounded to 250
      const toExpand = matrix!.candidates.slice(0, 250);
      for (const v of toExpand) {
        const deep = buildVariantDeepLink(c.url, v);
        const key = (()=>{ try { return productUrlIdentityKey(deep); } catch { return deep.toLowerCase(); }})();
        if (alreadyAdded.has(key)) continue;
        alreadyAdded.add(key);
        output.push({
          url: deep,
          title: c.title ? `${c.title} - ${v.title}` : v.title,
          snippet: c.snippet,
          domain: c.domain,
          confidence: Math.max(0, Math.min(1, 0.5)),
          sourceMethod: 'shopify_variant',
          metadataJson: JSON.stringify({ originalSourceMethod: c.sourceMethod ?? null, variantResolution: { status: 'ambiguous', platform: matrix!.platform, variantId: v.platformId, variantTitle: v.title, confidence: 0.5, matchedBy: decision.matchedBy, reasonCodes: decision.reasonCodes, baseUrl: c.url } }),
        });
      }
    } else {
      const key = (()=>{ try { return productUrlIdentityKey(c.url); } catch { return c.url.toLowerCase(); }})();
      if (!alreadyAdded.has(key)) { alreadyAdded.add(key); output.push(c); }
    }
  }
  // Build structured resolution for active path
  let resStatus: VariantDiscoveryResolution['status'] = 'no_variants';
  let resSelectedKey: string | null = null;
  let resCandidatesCount = 0;
  let resOverflow = false;
  let resWarnings: string[] = [];
  let resIdentityHash: string | null = null;
  let resMatrixCandidates: import('../shared/schemas/variant-resolution').NormalizedVariantCandidate[] | undefined = undefined;
  let resExpandedCount: number | undefined = undefined;
  if (resolvedMap.size > 0) {
    // Determine aggregate status: if any resolved, prefer resolved, else ambiguous, else no_variants
    let hasResolved = false, hasAmbiguous = false;
    for (const [, r] of resolvedMap) {
      resCandidatesCount = Math.max(resCandidatesCount, r.matrix?.candidates.length ?? 0);
      resWarnings = [...resWarnings, ...(r.matrix?.warnings ?? [])];
      if (r.matrix) { try { resIdentityHash = computeIdentityMatrixHash(r.matrix); } catch { if (r.matrix?.sourceContentHash) resIdentityHash = r.matrix.sourceContentHash; } }
      if (!resMatrixCandidates && r.matrix?.candidates) resMatrixCandidates = r.matrix.candidates.slice(0, 250);
      if ((r.matrix?.candidates.length ?? 0) > 250 || r.matrix?.warnings.includes('too_many_variants') || r.decision.status === 'too_many_variants' || r.matrix?.warnings.some(w => w.includes('too_many'))) resOverflow = true;
      if (r.decision.status === 'resolved') { hasResolved = true; if (!resSelectedKey) resSelectedKey = r.decision.selectedVariantKey ?? null; }
      else if (r.decision.status === 'ambiguous') hasAmbiguous = true;
    }
    if (hasResolved) resStatus = 'resolved';
    else if (hasAmbiguous) resStatus = 'ambiguous';
    else resStatus = 'no_variants';
    resExpandedCount = output.length;
  } else if (boundedList.length === 0) {
    resStatus = 'no_candidate';
  }
  const resolution: VariantDiscoveryResolution = { status: resStatus, selectedKey: resSelectedKey, candidatesCount: resCandidatesCount, overflow: resOverflow, warnings: resWarnings, identityHash: resIdentityHash, expandedCount: resExpandedCount, matrixCandidates: resMatrixCandidates };
  // Fallback: if observe/active produced empty due to gating, return original but with resolution
  if (output.length === 0) return { candidates, resolution };
  // Cap total candidates to reasonable limit but preserve variant distinctness
  const capped = output.slice(0, 250);
  if (capped.length < output.length) resolution.overflow = true;
  return { candidates: capped, resolution };
}
