/**
 * Bounded public-manufacturer source collector for the Jev representative v3
 * benchmark (fresh holdout recovery).
 *
 * Source-only: public manufacturer feeds/sitemaps/pages. No model calls, no
 * labels, no DB, no credentials, no commits. Every HTTP attempt (including
 * redirect hops and retries) is counted against --attempt-cap. At most one
 * in-flight request per domain (fully sequential fetching).
 *
 * Feed honesty: rows sourced from batch public catalog feeds record
 * sourceForm "manufacturer-feed" and NEVER claim an individually fetched
 * product page. Page rows record "manufacturer-page" with the fetched URL.
 *
 * Usage:
 *   bun scripts/collect-jev-v3-sources.ts --write \
 *     --custody /var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/jev-representative-v3-custody \
 *     --public docs/audits/jev-representative-v3 \
 *     [--attempt-cap 1500] [--dry-run] [--seed-file <seeds.json>]
 *     [--prior-custody <dir>] [--taxonomy <taxonomy.json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { load } from 'cheerio';
import { familyGroupingIdentityFor } from '../src/onboarding/product-line-grouper';
import { splitForFamily } from '../src/classification/benchmark-exporter';
import { recomputeTaxonomyAuthorityHash } from '../src/classification/jev-benchmark-replay';
import { JevSourceCandidateSchema, assertPublicSourceUrl } from '../src/shared/schemas/jev-benchmark';
import { hashCanonicalJson } from '../src/shared/stable-id';

const SPLIT_SEED = 42;
const HOLDOUT_PERCENT = 20;
/** Approved per-invocation attempt ceiling for this source worker. */
export const MAX_ATTEMPT_CAP = 1500;

/** Strict attempt-cap parsing: finite positive integer within the approved allocation. */
export function parseAttemptCap(raw: string | null): number {
  if (raw == null) return MAX_ATTEMPT_CAP;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid_attempt_cap: "${raw}" must be a positive integer`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ATTEMPT_CAP) {
    throw new Error(`invalid_attempt_cap: "${raw}" must be an integer in [1, ${MAX_ATTEMPT_CAP}]`);
  }
  return n;
}

export interface Seed {
  domain: string;
  brand: string;
  stratum: 'food' | 'treat' | 'toys' | 'care' | 'garden' | 'pest' | 'neighbors';
  sourceRule: string;
}

// Prospectively declared sampling strata + source rules (before any fetch).
// Generation default. A generation may supply --seed-file to override with
// validated new-unseen-brand seeds; seeds carry DOMAINS only, never product
// URLs — every fetched URL must come from a fetched official sitemap/feed.
const SEEDS: Seed[] = [
  { domain: 'frommfamily.com', brand: 'Fromm', stratum: 'food', sourceRule: 'official sitemap + product pages' },
  { domain: 'wellnesspetfood.com', brand: 'Wellness', stratum: 'food', sourceRule: 'official sitemap + product pages' },
  { domain: 'canidae.com', brand: 'CANIDAE', stratum: 'food', sourceRule: 'official sitemap + product pages' },
  { domain: 'purina.com', brand: 'Purina', stratum: 'food', sourceRule: 'official sitemap + product pages' },
  { domain: 'kongcompany.com', brand: 'KONG', stratum: 'toys', sourceRule: 'batch feed verified against official sitemap, else product pages' },
  { domain: 'nylabone.com', brand: 'Nylabone', stratum: 'toys', sourceRule: 'official sitemap + product pages' },
  { domain: 'outwardhound.com', brand: 'Outward Hound', stratum: 'toys', sourceRule: 'batch feed verified against official sitemap, else product pages' },
  { domain: 'westpaw.com', brand: 'West Paw', stratum: 'toys', sourceRule: 'batch feed verified against official sitemap, else product pages' },
  { domain: 'espoma.com', brand: 'Espoma', stratum: 'garden', sourceRule: 'official sitemap + product pages' },
  { domain: 'farnam.com', brand: 'Farnam', stratum: 'care', sourceRule: 'official sitemap + product pages' },
  { domain: 'coastalpet.com', brand: 'Coastal Pet', stratum: 'neighbors', sourceRule: 'official sitemap + product pages' },
  { domain: 'schleich-s.com', brand: 'Schleich', stratum: 'neighbors', sourceRule: 'official sitemap + product pages if manufacturer-official feed confirms' },
];

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const SeedSchema = z
  .object({
    domain: z.string().regex(DOMAIN_RE, 'seed domain must be a bare public hostname'),
    brand: z.string().min(1).max(200),
    stratum: z.enum(['food', 'treat', 'toys', 'care', 'garden', 'pest', 'neighbors']),
    sourceRule: z.string().min(1).max(500),
  })
  .strict();

export type ParsedSeeds = Seed[];

/**
 * Validated generation seed override. Domains only — product URLs can never
 * enter through this file, so it cannot bypass the sitemap/feed source
 * policy or the per-hop public-URL gate.
 */
export function parseSeedFile(raw: unknown): Seed[] {
  const parsed = z.array(SeedSchema).min(1).max(24).parse(raw);
  const domains = parsed.map(s => s.domain.toLowerCase());
  if (new Set(domains).size !== domains.length) {
    throw new Error('invalid_seed_file: duplicate domains');
  }
  return parsed;
}

/** Default prior-generation private custody (v3 source/membership exclusion). */
export const PRIOR_CUSTODY_DEFAULT =
  '/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/jev-representative-v3-custody';

/** Measured prior source-worker attempts across earlier generations (non-resetting). */
export const PRIOR_SOURCE_ATTEMPTS = 1485;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const WRITE = process.argv.includes('--write');
const DRY_RUN = process.argv.includes('--dry-run');
const CUSTODY = arg('--custody') ?? '/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/opencode/jev-representative-v3-custody';
const PUBLIC = arg('--public') ?? 'docs/audits/jev-representative-v3';
const ATTEMPT_CAP = parseAttemptCap(arg('--attempt-cap'));

const UA = 'BayStateCMS-JevBenchmark/1.0 (+research source collection; public pages only)';

interface Attempt { url: string; status: number | string; kind: string; at: string }
const ledger: Attempt[] = [];
const denied = new Set<string>();
let attemptCount = 0;

function logAttempt(url: string, status: number | string, kind: string): void {
  attemptCount += 1;
  ledger.push({ url, status, kind, at: new Date().toISOString() });
}

function siteRoot(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}
/** Normalized denial identity: apex/www and case collapse so a denial sticks across hops. */
export function normalizeDeniedHost(host: string): string {
  return siteRoot(host);
}
/** Shared public-source URL policy gate (https, host policy, no userinfo/auth params). */
export function isAllowedSourceUrl(url: string): boolean {
  try {
    assertPublicSourceUrl(url);
    return true;
  } catch {
    return false;
  }
}
function sameSite(a: string, b: string): boolean {
  try {
    return siteRoot(new URL(a).hostname) === siteRoot(new URL(b).hostname);
  } catch { return false; }
}

/** Same official site + same path: apex/www-insensitive product-URL match. */
export function sameProductUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (
      siteRoot(x.hostname) === siteRoot(y.hostname) &&
      x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '')
    );
  } catch {
    return false;
  }
}

async function fetchOnce(url: string, kind: string): Promise<{ status: number; text: string; finalUrl: string } | null> {
  let initialHost: string;
  try {
    initialHost = new URL(url).hostname;
  } catch {
    return null;
  }
  if (denied.has(normalizeDeniedHost(initialHost))) return null;
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (attemptCount >= ATTEMPT_CAP) return null;
    // Policy gate + denial check on EVERY hop (redirects may move apex<->www).
    if (!isAllowedSourceUrl(current)) return null;
    try {
      if (denied.has(normalizeDeniedHost(new URL(current).hostname))) return null;
    } catch {
      return null;
    }
    let res: Response;
    try {
      res = await fetch(current, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      logAttempt(current, `fetch-error:${String(e).slice(0, 80)}`, kind);
      return null;
    }
    logAttempt(current, res.status, kind);
    if ([401, 403, 429, 451].includes(res.status)) {
      try {
        denied.add(normalizeDeniedHost(new URL(current).hostname));
      } catch { /* unparseable host: stay denied for the initial host */ }
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      const next = new URL(loc, current);
      if (next.protocol !== 'https:') return null;
      // Same-site redirect only (apex <-> www); cross-site refused. Count already logged.
      if (!sameSite(next.toString(), current)) return null;
      current = next.toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) return null;
    const text = await res.text();
    return { status: res.status, text, finalUrl: current };
  }
  return null;
}

function cleanText(html: string): string {
  const $ = load(html);
  $('script, style, nav, header, footer, form, .cookie-banner, .cookie-consent, #onetrust-banner-sdk, .newsletter').remove();
  return $.text().replace(/\s+/g, ' ').trim();
}

interface ProductPageIdentity {
  name: string;
  description?: string;
  brand?: string | { name?: string };
  url?: string;
}

/** A sitemap entry is discovery evidence, not proof that the URL is a product. */
function singleProductIdentity(html: string, finalUrl: string): ProductPageIdentity | null {
  const $ = load(html);
  const products: ProductPageIdentity[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
    // Sitecore-style markup capitalizes schema.org keys (Name/Url/
    // Description); accept both casings as the same vocabulary.
    const name = typeof record.name === 'string' ? record.name
      : typeof record.Name === 'string' ? (record.Name as string) : null;
    if (types.includes('Product') && name && name.trim()) {
      products.push({ ...(record as unknown as ProductPageIdentity), name });
    }
    // Do not promote ItemList/recommendation elements into primary products.
    visit(record['@graph']);
    visit(record.mainEntity);
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try { visit(JSON.parse($(element).text())); } catch { /* malformed metadata is not product proof */ }
  });
  const matches = products.filter(product => {
    if (!product.url) return products.length === 1;
    try {
      const candidate = new URL(product.url, finalUrl);
      const current = new URL(finalUrl);
      return sameSite(candidate.href, current.href) && candidate.pathname.replace(/\/$/, '') === current.pathname.replace(/\/$/, '');
    } catch { return false; }
  });
  return matches.length === 1 ? matches[0] : null;
}

const PRICE_RE = /[$€£]\s?\d|was\s?\$|sale\s?price/i;

function pickExcerpts(text: string, locatorBase: string, max = 8): Array<{ text: string; locator: string }> {
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length >= 40 && s.length <= 1800);
  const key = /(dog|cat|puppy|kitten|bird|fish|horse|reptile|small pet|ferret|flavor|flavour|recipe|formula|grain|protein|rubber|nylon|plush|rope|squeak|chew|fetch|tug|food|treat|kibble|wet|dry|organic|natural|size|weight|oz\b|lb\b|material|cotton|fleece|coat|skin|dental|joint|digestive|coat|flea|tick|shampoo|soil|fertilizer|seed|pest|repel)/i;
  const preferred = sentences.filter(s => !PRICE_RE.test(s) && key.test(s));
  const fallback = sentences.filter(s => !PRICE_RE.test(s) && !key.test(s));
  const chosen = [...preferred, ...fallback].slice(0, max);
  return chosen.map((text, i) => ({ text, locator: `${locatorBase}#excerpt-${i}`.slice(0, 500) }));
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(t: string): Set<string> {
  return new Set(normTitle(t).split(' ').filter(w => w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

interface PriorRow { familyId: string; canonicalUrl: string; title: string; brand: string }
function loadExclusion(priorCustodyDir: string | null): { byFamily: Set<string>; byUrl: Set<string>; prior: PriorRow[]; privateFamilies: number; privateUrls: number } {
  const byFamily = new Set<string>();
  const byUrl = new Set<string>();
  const prior: PriorRow[] = [];
  for (const v of ['jev-representative-v1', 'jev-representative-v2']) {
    const p = path.join('docs/audits', v, 'source-development.json');
    if (!fs.existsSync(p)) continue;
    const rows = JSON.parse(fs.readFileSync(p, 'utf-8')) as PriorRow[];
    for (const r of rows) {
      byFamily.add(r.familyId);
      byUrl.add(r.canonicalUrl);
      prior.push({ familyId: r.familyId, canonicalUrl: r.canonicalUrl, title: r.title, brand: r.brand });
    }
  }
  let privateFamilies = 0;
  let privateUrls = 0;
  if (priorCustodyDir) {
    // Prior-generation private exclusion audit. Reads ONLY familyId +
    // canonicalUrl identity fields — never excerpts, labels, or gold.
    let found = false;
    const membershipPath = path.join(priorCustodyDir, 'membership.json');
    if (fs.existsSync(membershipPath)) {
      found = true;
      const members = JSON.parse(fs.readFileSync(membershipPath, 'utf-8')) as Array<{ familyId?: unknown }>;
      for (const m of members) {
        if (typeof m.familyId === 'string' && m.familyId) {
          if (!byFamily.has(m.familyId)) privateFamilies++;
          byFamily.add(m.familyId);
        }
      }
    }
    const holdoutPath = path.join(priorCustodyDir, 'holdout-inputs.json');
    if (fs.existsSync(holdoutPath)) {
      found = true;
      const rows = JSON.parse(fs.readFileSync(holdoutPath, 'utf-8')) as Array<{ familyId?: unknown; canonicalUrl?: unknown }>;
      for (const r of rows) {
        if (typeof r.familyId === 'string' && r.familyId) byFamily.add(r.familyId);
        if (typeof r.canonicalUrl === 'string' && r.canonicalUrl.startsWith('https://')) {
          if (!byUrl.has(r.canonicalUrl)) privateUrls++;
          byUrl.add(r.canonicalUrl);
        }
      }
    }
    if (!found) {
      throw new Error(`incomplete_exclusion_ledger: no membership.json or holdout-inputs.json in ${priorCustodyDir}`);
    }
  }
  return { byFamily, byUrl, prior, privateFamilies, privateUrls };
}

export interface Candidate {
  row: Record<string, unknown>;
  stratum: string;
  sourceForm: 'manufacturer-feed' | 'manufacturer-page';
}

async function collectFeedProducts(seed: Seed, exclusion: ReturnType<typeof loadExclusion>, stats: Record<string, number>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seenHandles = new Set<string>();
  for (let page = 1; page <= 6; page++) {
    const feedUrl = `https://${seed.domain}/products.json?limit=250&page=${page}`;
    const res = await fetchOnce(feedUrl, 'feed');
    if (!res) { stats[`${seed.domain}:feed-miss`] = (stats[`${seed.domain}:feed-miss`] ?? 0) + 1; break; }
    let payload: { products?: Array<{ id: number; title: string; handle: string; vendor?: string; body_html?: string }> };
    try { payload = JSON.parse(res.text); } catch { break; }
    const products = payload.products ?? [];
    if (products.length === 0) break;
    for (const p of products) {
      if (seenHandles.has(p.handle)) continue;
      seenHandles.add(p.handle);
      const canonicalUrl = `https://${seed.domain}/products/${p.handle}`;
      if (exclusion.byUrl.has(canonicalUrl)) { stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1; continue; }
      const title = (p.title ?? '').trim();
      const brand = (p.vendor ?? seed.brand).trim() || seed.brand;
      if (!title) continue;
      const bodyText = p.body_html ? cleanText(p.body_html) : '';
      if (bodyText.length < 80) { stats.excludedThinEvidence = (stats.excludedThinEvidence ?? 0) + 1; continue; }
      const excerpts = pickExcerpts(bodyText, `${feedUrl}#/products/${p.id}/body_html`);
      if (excerpts.length === 0) { stats.excludedThinEvidence = (stats.excludedThinEvidence ?? 0) + 1; continue; }
      const retrievedAt = new Date().toISOString();
      out.push({
        stratum: seed.stratum,
        sourceForm: 'manufacturer-feed',
        row: {
          sku: `PUBLIC:${seed.domain}:${p.id}`.slice(0, 120),
          title: title.slice(0, 500),
          brand: brand.slice(0, 200),
          canonicalUrl,
          productIdentity: `${brand}: ${title}`.slice(0, 300),
          sourceLocator: `${feedUrl}#/products/${p.id}`.slice(0, 500),
          sourceHash: crypto.createHash('sha256').update(res.text).digest('hex'),
          retrievedAt,
          familyId: 'pending',
          excerpts,
          evidenceLimitations: 'Batch public manufacturer catalog feed row, sitemap verification pending; admitted as feed evidence ONLY on an official-sitemap URL match, otherwise queued for individual page fetch. Public description only; no prices, no merchant category labels.',
        },
      });
    }
    if (products.length < 250) break;
  }
  return out;
}

async function collectSitemapUrls(seed: Seed, stats: Record<string, number>): Promise<{ urls: string[]; prequalified: Set<string> }> {
  const urls: string[] = [];
  // HTML-discovery candidates live in their own pool: the 600-cap sitemap
  // pool can fill with unscored flat slugs before discovery runs, which
  // would otherwise starve harvesting. Candidates are high-signal
  // (category-listing context) and bounded separately.
  const candidates: string[] = [];
  const MAX_CANDIDATES = 400;
  // Category-listing-harvested product candidates: admitted by page
  // context (listings link products), still subject to the JSON-LD proof.
  const prequalified = new Set<string>();
  // Prefix-density accumulator (function scope): dense cohorts can spread
  // across multiple sitemap child files, so counts aggregate across
  // batches and prequalify after the crawl. Content-hub first segments
  // are never cohorts.
  const prefixCohorts = new Map<string, string[]>();
  const CONTENT_HUB = /^(learn|video|videos|blog|blogs|news|content|help|support|about|page|pages)(-|$)/i;
  const queue = [`https://${seed.domain}/sitemap.xml`];
  const seen = new Set<string>();
  const id = (k: string): string => `${seed.domain}:${k}`;
  // BigCommerce/HTML fallback: stores whose XML sitemap 404s (e.g. custom
  // themes) often still serve an HTML sitemap at /sitemap.php listing
  // category pages. Tried once per seed, after the XML miss.
  let htmlFallbackDone = false;
  let discoveryFetches = 0;
  const MAX_DISCOVERY_FETCHES = 20;
  while (queue.length > 0 && seen.size < 20 && discoveryFetches <= MAX_DISCOVERY_FETCHES) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetchOnce(url, 'sitemap');
    if (!res) {
      stats[id('sitemap-miss')] = (stats[id('sitemap-miss')] ?? 0) + 1;
      if (!htmlFallbackDone && url.endsWith('/sitemap.xml')) {
        htmlFallbackDone = true;
        queue.push(`https://${seed.domain}/sitemap.php`);
        continue;
      }
      break;
    }
    const $ = load(res.text, { xmlMode: true });
    const locs = $('loc').map((_, el) => $(el).text().trim()).get().filter(u => u.startsWith('https://'));
    const isSitemapPhp = /sitemap\.php$/.test(url);
    if (locs.length === 0) discoveryFetches++;
    if (locs.length === 0 && (isSitemapPhp || !/\.xml(\.gz)?($|\?)/i.test(url))) {
      // HTML sitemap page: harvest same-site anchors. Product-like links
      // join the URL pool; category links recurse as discovery pages under
      // the same seen/attempt caps. Every product URL still faces the
      // JSON-LD identity proof in collectPage — discovery widens, proof
      // does not weaken.
      stats[id('sitemap-html')] = (stats[id('sitemap-html')] ?? 0) + 1;
      const $$ = load(res.text);
      const anchors = new Set<string>();
      $$('a[href]').each((_, el) => {
        const href = String($$(el).attr('href') ?? '').split('?')[0].split('#')[0];
        if (href.startsWith('https://')) anchors.add(href);
      });
      for (const u of anchors) {
        try {
          if (!sameSite(u, `https://${seed.domain}`)) continue;
        } catch { continue; }
        if (scoreUrl(u) >= 3) {
          if (urls.length < 600) urls.push(u);
          continue;
        }
        if (NON_PRODUCT_HINT.test(u) || seen.has(u)) continue;
        let pathname = '';
        try { pathname = new URL(u).pathname; } catch { continue; }
        if (/\/sitemap\.php$/.test(u) || !/\/[^./]+\/?$/.test(pathname)) continue;
        if (isSitemapPhp) {
          // Sitemap page: nav/category harvest. Recurse as discovery under
          // the same seen/attempt caps.
          if (seen.size < 20) queue.push(u);
        } else if (candidates.length < MAX_CANDIDATES) {
          // Category listing page: unknown same-site directory URLs are
          // product CANDIDATES by context (the listing links products, not
          // nav). Separate pool so a full sitemap pool cannot starve
          // harvesting. They bypass the score floor but NOT the JSON-LD
          // identity proof in collectPage — a non-product fetch burns
          // budgeted attempts and is rejected as excludedNonProduct.
          stats[id('sitemap-html-candidates')] = (stats[id('sitemap-html-candidates')] ?? 0) + 1;
          prequalified.add(u);
          candidates.push(u);
        }
      }
      continue;
    }
    stats[id('sitemap-locs')] = (stats[id('sitemap-locs')] ?? 0) + locs.length;
    const children = locs.filter(u => /\.xml(\.gz)?$/i.test(u));
    if (children.length > 0) {
      stats[id('sitemap-children')] = children.length;
      for (const u of children.slice(0, 15)) {
        try { if (sameSite(u, `https://${seed.domain}`)) queue.push(u); } catch { /* skip */ }
      }
    } else {
      let floorHits = 0;
      for (const u of locs) {
        if (urls.length >= 600) break;
        if (!sameSite(u, `https://${seed.domain}`)) continue;
        urls.push(u);
        if (scoreUrl(u) >= 3) floorHits++;
      }
      // Zero-hit fallback: no sitemap URL passes the product floor (flat
      // Magento-style slugs). Requeue listing-like URLs as HTML discovery
      // pages under the same caps; their product anchors face the standard
      // prequalified + JSON-LD proof gates. Bounded: seen-size cap applies.
      if (locs.length > 0) {
        // Prefix-density accumulation: sub-floor same-site URLs grouped by
        // first path segment across ALL batches (dense cohorts like /pt/
        // spread over many child files). Evaluated post-crawl.
        for (const u of locs) {
          let same = false;
          try { same = sameSite(u, `https://${seed.domain}`); } catch { continue; }
          if (!same || scoreUrl(u) >= 3 || NON_PRODUCT_HINT.test(u)) continue;
          let seg = '';
          try {
            const parts = new URL(u).pathname.split('/').filter(s => s.length > 0);
            seg = parts[0] ?? '';
          } catch { continue; }
          if (!seg || CONTENT_HUB.test(seg)) continue;
          const list = prefixCohorts.get(seg) ?? [];
          list.push(u);
          prefixCohorts.set(seg, list);
        }
        if (floorHits === 0) {
          stats[id('sitemap-listing-fallback')] = 1;
          for (const u of locs) {
            if (seen.has(u) || NON_PRODUCT_HINT.test(u)) continue;
            let pathname = '';
            try { pathname = new URL(u).pathname; } catch { continue; }
            if (!/\/[^./]+\/?$/.test(pathname)) continue;
            try { if (sameSite(u, `https://${seed.domain}`)) queue.push(u); } catch { /* skip */ }
            if (seen.size >= 20) break;
          }
        }
      }
    }
  }
  // Post-crawl: prequalify dense cohorts (200+ URLs under one segment).
  // Catalog structure, not scattered slugs; JSON-LD proof still decides
  // each URL individually.
  let dense = 0;
  for (const [seg, cohort] of [...prefixCohorts.entries()].sort(([, a], [, b]) => b.length - a.length)) {
    if (cohort.length < 200) continue;
    dense++;
    stats[id(`sitemap-prefix-cohort:${seg}`)] = cohort.length;
    for (const u of cohort) {
      if (urls.length + candidates.length >= 1000) break;
      prequalified.add(u);
      candidates.push(u);
    }
  }
  if (dense > 0) stats[id('sitemap-prefix-cohorts')] = dense;
  return { urls: [...new Set([...urls, ...candidates])], prequalified };
}

const PRODUCT_HINT = /(product|shop|store|collection|\/p\/|\/item|\/dp\/|\.html?$)/i;
const NON_PRODUCT_HINT = /(blog|news|article|cart|checkout|search|account|login|contact|about|faq|policy|terms|privacy|store-locator|dealer|career|press|ingredient|glossary|\/blogs?\/|\/learn\/|\/guides?\/|size-chart|reviews|recipe\/$|\/pages?\/(?!.*product))/i;

function scoreUrl(u: string): number {
  let s = 0;
  if (/\/products?\//i.test(u)) s += 3;
  else if (PRODUCT_HINT.test(u)) s += 1;
  if (NON_PRODUCT_HINT.test(u)) s -= 5;
  return s;
}

/**
 * Admission gate for feed rows: a feed canonical is only claimed verified
 * when it actually matches a fetched official-sitemap URL (apex/www
 * insensitive). Unmatched rows are withheld from feed admission — never
 * silently relabeled as verified.
 */
export function partitionFeedRows(
  feedRows: Candidate[],
  sitemapUrls: string[],
): { verified: Candidate[]; unverified: Candidate[] } {
  const verified: Candidate[] = [];
  const unverified: Candidate[] = [];
  for (const c of feedRows) {
    const canonical = String(c.row.canonicalUrl);
    if (sitemapUrls.some(u => sameProductUrl(canonical, u))) verified.push(c);
    else unverified.push(c);
  }
  return { verified, unverified };
}

/**
 * Pre-fetch discovery filter: only product-like sitemap URLs are ever
 * fetched. Obvious nav/FAQ/ingredient/listing/cookie/policy URLs are
 * rejected BEFORE any costly fetch — there is no non-product fallback.
 * Category-listing-harvested candidates (prequalified) bypass the score
 * floor — their listing context is the qualification — but face the same
 * JSON-LD identity proof downstream.
 */
export function selectFetchUrls(sitemapUrls: string[], cap: number, prequalified?: ReadonlySet<string>): string[] {
  const ranked = [...new Set(sitemapUrls)]
    .filter(u => u.startsWith('https://'))
    .map(u => ({ u, s: scoreUrl(u) }))
    .filter(x => x.s >= 3 || prequalified?.has(x.u))
    .sort((a, b) => b.s - a.s);
  return ranked.slice(0, cap).map(x => x.u);
}

export const VERIFIED_FEED_LIMITATIONS = 'Batch public manufacturer catalog feed row; canonical URL matched in the fetched official sitemap. Page NOT individually fetched. Public description only; no prices, no merchant category labels.';

// Test seam: pure page extractor (no fetch). collectPage fetches, then delegates here.
export function candidateFromPageHtml(
  seed: Seed,
  url: string,
  finalUrl: string,
  html: string,
  retrievedAt: string,
  stats: Record<string, number>,
): Candidate | null {
  const $ = load(html);
  const product = singleProductIdentity(html, finalUrl);
  if (!product) { stats.excludedNonProduct = (stats.excludedNonProduct ?? 0) + 1; return null; }
  const title = product.name.trim();
  const brand = (typeof product.brand === 'string' ? product.brand : product.brand?.name)?.trim() || seed.brand;
  const descriptions = $('[itemprop="description"], .product-description, .full-description, [data-product-description]')
    .map((_, element) => cleanText($(element).html() ?? '')).get().filter(Boolean);
  if (typeof product.description === 'string') descriptions.unshift(cleanText(product.description));
  else if (typeof (product as unknown as Record<string, unknown>).Description === 'string') {
    descriptions.unshift(cleanText(String((product as unknown as Record<string, unknown>).Description)));
  }
  const bodyText = [...new Set(descriptions)].join(' ');
  if (bodyText.length < 80) { stats.excludedThinEvidence = (stats.excludedThinEvidence ?? 0) + 1; return null; }
  const excerpts = pickExcerpts(bodyText, `${finalUrl} JSON-LD Product + product-description`);
  if (excerpts.length === 0) { stats.excludedThinEvidence = (stats.excludedThinEvidence ?? 0) + 1; return null; }
  return {
    stratum: seed.stratum,
    sourceForm: 'manufacturer-page',
    row: {
      sku: `PUBLIC:${seed.domain}:${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`.slice(0, 120),
      title: title.slice(0, 500),
      brand: brand.slice(0, 200),
      canonicalUrl: url,
      productIdentity: `${brand}: ${title}`.slice(0, 300),
      sourceLocator: finalUrl.slice(0, 500),
      sourceHash: crypto.createHash('sha256').update(html).digest('hex'),
      retrievedAt,
      familyId: 'pending',
      excerpts,
      evidenceLimitations: 'Individually fetched official manufacturer product page. Public description only; no prices, no merchant category labels.',
    },
  };
}

export async function collectPage(seed: Seed, url: string, exclusion: ReturnType<typeof loadExclusion>, stats: Record<string, number>): Promise<Candidate | null> {
  if (exclusion.byUrl.has(url)) { stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1; return null; }
  const res = await fetchOnce(url, 'page');
  if (!res) return null;
  return candidateFromPageHtml(seed, url, res.finalUrl, res.text, new Date().toISOString(), stats);
}

export const CUSTODY_ARTIFACTS = ['candidate-bank.json', 'holdout-inputs.json', 'membership.json', 'attempt-ledger.json', 'cumulative-source-ledger.json'];
export const PUBLIC_ARTIFACTS = ['source-development.json', 'source-development-supplemental.json', 'collection-manifest.json'];

/**
 * Fail-closed seal guard: report already-sealed artifact paths BEFORE any
 * network. A new generation needs explicit new output paths — never a
 * silent reseal over existing custody or public banks.
 */
export function findExistingArtifacts(
  custodyDir: string,
  publicDir: string,
  exists: (p: string) => boolean,
): string[] {
  return [
    ...CUSTODY_ARTIFACTS.map(n => path.join(custodyDir, n)),
    ...PUBLIC_ARTIFACTS.map(n => path.join(publicDir, n)),
  ].filter(exists);
}

/** Derive the authority hash from the actual taxonomy file (canonical JSON domain). */
export function deriveAuthorityHash(taxonomy: unknown): string {
  if (!taxonomy || typeof taxonomy !== 'object' || Array.isArray(taxonomy)) {
    throw new Error('invalid_taxonomy: expected a taxonomy object');
  }
  try {
    return recomputeTaxonomyAuthorityHash(taxonomy);
  } catch (error) {
    throw new Error('invalid_taxonomy: expected complete bundle, pages and binding.', { cause: error });
  }
}

async function main(): Promise<void> {
  if (WRITE) {
    const clashes = findExistingArtifacts(CUSTODY, PUBLIC, fs.existsSync);
    if (clashes.length > 0) {
      throw new Error(`sealed_artifacts_exist: refusing to overwrite: ${clashes.join(', ')}`);
    }
  }
  const taxonomyPath = arg('--taxonomy') ?? path.join(PUBLIC, 'taxonomy.json');
  let authorityHash: string;
  let taxonomyFileHash: string;
  try {
    const raw = fs.readFileSync(taxonomyPath, 'utf-8');
    taxonomyFileHash = crypto.createHash('sha256').update(raw).digest('hex');
    authorityHash = deriveAuthorityHash(JSON.parse(raw));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`unverifiable_taxonomy_authority: cannot derive authority from ${taxonomyPath}: ${detail}`, { cause: e });
  }
  const seedFile = arg('--seed-file');
  let seeds: Seed[] = SEEDS;
  if (seedFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      seeds = parseSeedFile(Array.isArray(raw) ? raw : (raw as { seeds: unknown }).seeds);
    } catch (e) {
      throw new Error(`invalid_seed_file: cannot load ${seedFile}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  // Cached-URL input: official URLs harvested earlier (e.g. the local
  // sitemap_cache) for domains whose live sitemap is now unreachable
  // (WAF/JS). JSON map domain -> URL list. Injected as discovery leads
  // for that seed's domain only; same gates (score floor or prequalified
  // context, JSON-LD proof) apply. Never a substitute for fetching.
  const urlFile = arg('--url-file');
  let cachedUrlsByDomain: Record<string, string[]> = {};
  if (urlFile) {
    try {
      const rawUrls = JSON.parse(fs.readFileSync(urlFile, 'utf-8'));
      if (typeof rawUrls !== 'object' || rawUrls === null || Array.isArray(rawUrls)) {
        throw new Error('expected a {domain: string[]} map');
      }
      for (const [domain, list] of Object.entries(rawUrls)) {
        if (!DOMAIN_RE.test(domain) || !Array.isArray(list) || list.some(u => typeof u !== 'string')) {
          throw new Error(`invalid entry for "${domain}": expected string[]`);
        }
        cachedUrlsByDomain[domain.toLowerCase()] = (list as string[]).filter(u => u.startsWith('https://'));
      }
    } catch (e) {
      throw new Error(`invalid_url_file: cannot load ${urlFile}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  const priorCustody = arg('--prior-custody') ?? PRIOR_CUSTODY_DEFAULT;
  const exclusion = loadExclusion(priorCustody);
  const stats: Record<string, number> = { excludedPriorUrl: 0, excludedPriorFamily: 0, excludedNearDup: 0, excludedThinEvidence: 0 };
  const knownBrands = seeds.map(s => s.brand);
  const raw: Candidate[] = [];

  for (const seed of seeds) {
    if (attemptCount >= ATTEMPT_CAP) break;
    // Sitemap first: feed verification requires an actual sitemap match.
    let sitemapUrls: string[] = [];
    let prequalified = new Set<string>();
    if (attemptCount < ATTEMPT_CAP) ({ urls: sitemapUrls, prequalified } = await collectSitemapUrls(seed, stats));
    stats[`${seed.domain}:sitemap-urls`] = sitemapUrls.length;
    const feedRows = await collectFeedProducts(seed, exclusion, stats);
    // Only sitemap-matched feed rows are admitted as verified feed evidence.
    const { verified, unverified } = partitionFeedRows(feedRows, sitemapUrls);
    for (const c of verified) {
      c.row.evidenceLimitations = VERIFIED_FEED_LIMITATIONS;
      raw.push(c);
    }
    stats[`${seed.domain}:feed-rows`] = verified.length;
    stats[`${seed.domain}:feed-unverified`] = unverified.length;
    // Unverified feed canonicals are official-domain discovery leads, not
    // verified evidence: they join the page-fetch queue for individual fetch.
    // Feed canonicals come from the manufacturer's own catalog feed, so they
    // join the prequalified set (listing-context equivalent); the JSON-LD
    // proof still decides admission row by row.
    const feedUrls = unverified.map(c => String(c.row.canonicalUrl));
    for (const u of feedUrls) prequalified.add(u);
    // Local-cache leads: same-domain official URLs from an earlier harvest.
    // Same gates as everything else; counted in stats for audit.
    const cachedLeads = (cachedUrlsByDomain[seed.domain.toLowerCase()] ?? [])
      .filter(u => { try { return sameSite(u, `https://${seed.domain}`); } catch { return false; } });
    stats[`${seed.domain}:cache-leads`] = cachedLeads.length;
    const pageQueue = selectFetchUrls(
      [...sitemapUrls, ...feedUrls, ...cachedLeads],
      250,
      prequalified,
    );
    stats[`${seed.domain}:fetch-queued`] = pageQueue.length;
    let added = 0;
    for (const u of pageQueue) {
      if (attemptCount >= ATTEMPT_CAP || added >= 250) break;
      const c = await collectPage(seed, u, exclusion, stats);
      if (c) { raw.push(c); added++; }
    }
    stats[`${seed.domain}:page-rows`] = added;
  }

  // Family grouping (frozen) + prior-family / near-dup exclusion over PUBLIC ledger only.
  const groups = new Map<string, Candidate[]>();
  for (const c of raw) {
    const identity = familyGroupingIdentityFor(
      { brandHint: String(c.row.brand), name: String(c.row.title) },
      knownBrands,
    );
    const key = identity.key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const priorSets = exclusion.prior.map(p => ({ brand: p.brand, toks: tokens(p.title) }));
  let excludedGroups = 0;
  const kept: Candidate[][] = [];
  for (const [key, members] of groups) {
    const familyId = `family-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    if (exclusion.byFamily.has(familyId)) { excludedGroups++; stats.excludedPriorFamily += members.length; continue; }
    const toks = tokens(String(members[0].row.title));
    const brand = String(members[0].row.brand).toLowerCase();
    let dup = false;
    for (const p of priorSets) {
      if (p.brand.toLowerCase() === brand && jaccard(toks, p.toks) >= 0.8) { dup = true; break; }
    }
    if (dup) { excludedGroups++; stats.excludedNearDup += members.length; continue; }
    for (const m of members) m.row.familyId = familyId;
    kept.push(members);
  }

  // Primary + supplemental; family-locked splits.
  const devPrimary: Record<string, unknown>[] = [];
  const devSupplemental: Record<string, unknown>[] = [];
  const holdoutPrivate: Array<Record<string, unknown>> = [];
  const membership: Array<{ familyId: string; split: string; primarySku: string; supplementalSkus: string[]; stratum: string; sourceForm: string }> = [];
  for (const members of kept) {
    members.sort((a, b) => String(a.row.canonicalUrl).localeCompare(String(b.row.canonicalUrl)));
    const familyId = String(members[0].row.familyId);
    const split = splitForFamily(familyId, SPLIT_SEED, HOLDOUT_PERCENT);
    // Schema-validate every row before sealing.
    for (const m of members) JevSourceCandidateSchema.parse(m.row);
    membership.push({
      familyId,
      split,
      primarySku: String(members[0].row.sku),
      supplementalSkus: members.slice(1).map(m => String(m.row.sku)),
      stratum: members[0].stratum,
      sourceForm: members[0].sourceForm,
    });
    if (split === 'holdout') {
      for (const m of members) holdoutPrivate.push({ ...m.row, stratum: m.stratum, sourceForm: m.sourceForm });
    } else if (members.length === 1) {
      devPrimary.push(members[0].row);
    } else {
      devPrimary.push(members[0].row);
      for (const m of members.slice(1)) devSupplemental.push(m.row);
    }
  }

  const summary = {
    authorityHash,
    taxonomyPath,
    taxonomyFileHash,
    seeds,
    seedFile: seedFile ?? null,
    exclusionLedger: {
      publicPriorFamilies: 1914,
      privatePriorFamilies: exclusion.privateFamilies,
      privatePriorUrls: exclusion.privateUrls,
      priorCustody,
    },
    attempts: attemptCount,
    attemptCap: ATTEMPT_CAP,
    deniedHosts: [...denied],
    rawCandidates: raw.length,
    familiesKept: kept.length,
    familiesExcludedPrior: excludedGroups,
    devPrimary: devPrimary.length,
    devSupplemental: devSupplemental.length,
    holdoutRows: holdoutPrivate.length,
    holdoutFamilies: membership.filter(m => m.split === 'holdout').length,
    stats,
  };

  if (DRY_RUN || !WRITE) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  fs.mkdirSync(CUSTODY, { recursive: true, mode: 0o700 });
  const put = (dir: string, name: string, data: unknown): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  };
  const memberByFamily = new Map(membership.map(m => [m.familyId, m]));
  const bankRows = [...devPrimary, ...devSupplemental].map(row => ({
    row,
    membership: memberByFamily.get(String((row as Record<string, unknown>).familyId)) ?? null,
  }));
  const bankHash = put(CUSTODY, 'candidate-bank.json', bankRows);
  const holdoutHash = put(CUSTODY, 'holdout-inputs.json', holdoutPrivate);
  const memberHash = put(CUSTODY, 'membership.json', membership);
  const ledgerHash = put(CUSTODY, 'attempt-ledger.json', { attempts: ledger, deniedHosts: [...denied], count: attemptCount, cap: ATTEMPT_CAP });
  const cumulative = {
    priorSourceAttempts: PRIOR_SOURCE_ATTEMPTS,
    thisGenerationAttempts: attemptCount,
    totalSourceAttempts: PRIOR_SOURCE_ATTEMPTS + attemptCount,
    globalLedger: {
      legacy: 1140,
      pageWorker: 273,
      source: PRIOR_SOURCE_ATTEMPTS + attemptCount,
      globalCap: 3200,
    },
  };
  const cumulativeHash = put(CUSTODY, 'cumulative-source-ledger.json', cumulative);

  const devHash = put(PUBLIC, 'source-development.json', devPrimary);
  const devSuppHash = put(PUBLIC, 'source-development-supplemental.json', devSupplemental);
  const manifest = {
    version: 'jev-representative-v3-collection-manifest',
    status: 'source-evidence-only-unlabeled',
    authorityHash,
    taxonomyPath,
    taxonomyFileHash,
    splits: { seed: SPLIT_SEED, holdoutPercent: HOLDOUT_PERCENT },
    exclusion: { priorFamilies: 1914, priorLedger: ['jev-representative-v1', 'jev-representative-v2'], privatePriorFamilies: exclusion.privateFamilies, privatePriorUrls: exclusion.privateUrls, priorCustody, excludedGroups, stats },
    attempts: { used: attemptCount, cap: ATTEMPT_CAP, deniedHosts: [...denied], cumulative },
    counts: { familiesKept: kept.length, devPrimary: devPrimary.length, devSupplemental: devSupplemental.length, holdoutFamilies: membership.filter(m => m.split === 'holdout').length, holdoutRows: holdoutPrivate.length },
    commitments: { bankHash, holdoutHash, memberHash, ledgerHash, cumulativeHash, devHash, devSuppHash },
    privacy: { noHoldoutRowsInPublic: true, custodyMode: '0600', labelsCollected: 0, modelCalls: 0, dbReads: 0 },
  };
  const manifestHash = put(PUBLIC, 'collection-manifest.json', manifest);
  console.log(JSON.stringify({ ...summary, files: { devHash, devSuppHash, manifestHash, holdoutHash } }, null, 2));
}

if (import.meta.main) {
  await main();
}
