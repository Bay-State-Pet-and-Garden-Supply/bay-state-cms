/**
 * Bounded public-manufacturer source collector with an explicit immutable
 * source-request window (fresh prospective capture).
 *
 * Source-only: public manufacturer feeds/sitemaps/pages. No model calls, no
 * labels, no DB, no credentials, no commits. Every actual HTTP request —
 * sitemap, feed, page, each redirect hop, each retry, each network error —
 * reserves a numbered seq from ONE owned window BEFORE transport
 * (scripts/lib/source-request-window.ts). Reservations are conservatively
 * spent; the window hard-stops at its allocation (<=1200) with no refund and
 * no candidate clipping. At most one in-flight request per domain (fully
 * sequential fetching).
 *
 * Exclusion is PUBLIC-ONLY: sealed public banks plus --exclude-bank stage
 * chaining. Private-custody parsing is removed for prospective capture: old
 * custody stays sealed and unparsed, and overlap against unparsed private
 * banks is unverified (see manifest caveats). Historical attempt totals are
 * unverified and never printed as fact.
 *
 * Feed honesty: rows sourced from batch public catalog feeds record
 * sourceForm "manufacturer-feed" and NEVER claim an individually fetched
 * product page. Page rows record "manufacturer-page" with the fetched URL.
 *
 * Usage:
 *   bun scripts/collect-jev-v3-sources.ts --write \
 *     --custody <NEW-EMPTY-DIR> --public <NEW-EMPTY-DIR> \
 *     --source-window <WINDOW-DIR> --owner-decisions <owner-approved-decisions.json> \
 *     [--attempt-cap <n<=remaining>] [--seed-file <seeds.json>] [--exclude-bank <bank.json> ...]
 *     [--taxonomy <taxonomy.json>] [--worker <name>]
 *   bun scripts/collect-jev-v3-sources.ts --dry-run [--seed-file <seeds.json>] [--taxonomy <taxonomy.json>]
 *     [--source-window <WINDOW-DIR> --owner-decisions <file>]  (planning only; no fetch, no spend)
 * (--prior-custody is rejected; enrichment refetches are Main-runner-scoped
 * via the shared window kind "enrich", never a collector bypass.)
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
import {
  buildPublicSourceReceipt,
  computeOwnerDecisionSha256,
  getSourceWindowUsage,
  openSourceWindow,
  parseInvocationCap,
  recordSourceOutcome,
  reserveSourceRequest,
  SOURCE_WINDOW_MAX,
  SourceWindowExhaustedError,
  type SourceRequestKind,
  type SourceWindowHandle,
} from './lib/source-request-window';

const SPLIT_SEED = 42;
const HOLDOUT_PERCENT = 20;

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

/** Requested additional bank paths for stage chaining (later stages exclude earlier Batch3 outputs). */
function argsAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const WRITE = process.argv.includes('--write');
const DRY_RUN = process.argv.includes('--dry-run');
const CUSTODY = arg('--custody') ?? 'private-custody/jev-batch3';
const PUBLIC = arg('--public') ?? 'docs/audits/jev-batch3';
const SOURCE_WINDOW_DIR = arg('--source-window');
const OWNER_DECISIONS_PATH = arg('--owner-decisions');
const WORKER = arg('--worker') ?? null;
const ATTEMPT_CAP_RAW = arg('--attempt-cap');
const PRIOR_CUSTODY_FLAG = arg('--prior-custody');

const UA = 'BayStateCMS-JevBenchmark/1.0 (+research source collection; public pages only)';

/** Active owned window for this invocation (opened once in main, never reset). */
let activeWindow: SourceWindowHandle | null = null;
/** Seq of every reservation this invocation spends (private ledger linkage). */
const spentSeqs: number[] = [];
/** Per-invocation reminder of the remaining-owned-window cap (window refuses past it). */
let invocationBudget = 0;
const denied = new Set<string>();
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
/** Canonical prior-URL identity key: apex/www-insensitive host plus path
 * modulo trailing slash — the sameProductUrl identity as a string, so
 * admission exclusion stays an O(1) Set lookup. Raw URLs remain on the
 * prior rows for provenance; admission compares keys only, so a new
 * spelling (apex/www, trailing slash) or a changed SKU can never re-admit
 * an exposed product. */
export function canonicalProductUrlKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${siteRoot(u.hostname)}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

/** Canonical admission check over the sealed identity set: true when the
 * URL is a known prior-source product identity under any spelling
 * (apex/www, trailing slash). The null-guard keeps unparseable candidates
 * fetchable so they fail at the page-proof stage with evidence, not via a
 * mistaken exclusion. Runs BEFORE any fetch in collectFeedProducts and
 * collectPage. */
export function isExcludedProductUrl(url: string, exclusion: { byUrl: Set<string> }): boolean {
  const key = canonicalProductUrlKey(url);
  return key !== null && exclusion.byUrl.has(key);
}

/** Every sealed public source bank a new collection must avoid: primary +
 * supplemental banks for representative v1/v2/v3/v4/v9. */
const PRIOR_PUBLIC_BANKS: string[] = [
  ...['jev-representative-v1', 'jev-representative-v2', 'jev-representative-v3', 'jev-representative-v4', 'jev-representative-v9'].flatMap(v => [
    path.join('docs/audits', v, 'source-development.json'),
    path.join('docs/audits', v, 'source-development-supplemental.json'),
  ]),
];

/** Ledger ids sealed into the collection manifest exclusion record. */
const PRIOR_LEDGER_IDS = [
  'jev-representative-v1',
  'jev-representative-v2',
  'jev-representative-v3',
  'jev-representative-v4',
  'jev-representative-v9',
  'jev-expansion-v1',
];

/** Current expansion banks (per-brand primary + supplemental) a future new
 * collection must also avoid. A missing root or entry simply yields no
 * banks; corrupt rows fail closed in loadBank. */
function expansionBanks(): string[] {
  const out: string[] = [];
  const root = path.join('docs/audits', 'jev-expansion-v1');
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(path.join(dir, 'source-development.json'));
    out.push(path.join(dir, 'source-development-supplemental.json'));
  }
  return out;
}

/**
 * Reserve-then-fetch transport: every hop reserves a numbered window seq
 * BEFORE the HTTP request and records an immutable outcome after. Exhaustion
 * refuses before transport (no refund, no candidate clipping). Caller passes
 * only sitemap|feed|page; "enrich" is Main-runner-scoped on the same window.
 */
async function fetchOnce(url: string, kind: SourceRequestKind): Promise<{ status: number; text: string; finalUrl: string } | null> {
  const window = activeWindow;
  if (!window) throw new Error('source_window_missing: collector runs require an opened --source-window (Main creates it after planner+reviewer)');
  let initialHost: string;
  try {
    initialHost = new URL(url).hostname;
  } catch {
    return null;
  }
  if (denied.has(normalizeDeniedHost(initialHost))) return null;
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (spentSeqs.length >= invocationBudget) return null;
    // Policy gate + denial check on EVERY hop (redirects may move apex<->www).
    // Gates run BEFORE reservation: refused hops spend nothing.
    if (!isAllowedSourceUrl(current)) return null;
    try {
      if (denied.has(normalizeDeniedHost(new URL(current).hostname))) return null;
    } catch {
      return null;
    }
    let reservation: { seq: number; urlSha256: string };
    try {
      reservation = reserveSourceRequest(window, { url: current, kind, ...(WORKER ? { worker: WORKER } : {}) });
    } catch (e) {
      if (e instanceof SourceWindowExhaustedError) return null;
      throw e;
    }
    spentSeqs.push(reservation.seq);
    let res: Response;
    try {
      res = await fetch(current, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      recordSourceOutcome(window, reservation.seq, { status: `fetch-error:${String(e).slice(0, 80)}`, bytes: 0 });
      return null;
    }
    if ([401, 403, 429, 451].includes(res.status)) {
      recordSourceOutcome(window, reservation.seq, { status: res.status, bytes: 0, error: 'host-denied' });
      try {
        denied.add(normalizeDeniedHost(new URL(current).hostname));
      } catch { /* unparseable host: stay denied for the initial host */ }
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        recordSourceOutcome(window, reservation.seq, { status: res.status, error: 'redirect-without-location' });
        return null;
      }
      const next = new URL(loc, current);
      recordSourceOutcome(window, reservation.seq, { status: res.status, ...(next.protocol === 'https:' ? { finalUrl: next.toString() } : {}), error: 'redirect-hop' });
      if (next.protocol !== 'https:') return null;
      // Same-site redirect only (apex <-> www); cross-site refused. Hop spent.
      if (!sameSite(next.toString(), current)) return null;
      current = next.toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      recordSourceOutcome(window, reservation.seq, { status: res.status, bytes: 0 });
      return null;
    }
    const text = await res.text();
    recordSourceOutcome(window, reservation.seq, { status: res.status, finalUrl: current, bytes: text.length });
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
/** Fail-closed public-bank load: missing files are skipped (an optional
 * supplemental or expansion bank may not exist yet), but a present file
 * with unparseable JSON or a malformed identity row throws — never a
 * silent skip that would shrink the exclusion ledger. Reads ONLY
 * familyId + canonicalUrl identity fields for admission (title/brand ride
 * along for the near-dup screen); never excerpts, labels, or gold. */
function loadBank(
  bankPath: string,
  byFamily: Set<string>,
  byUrl: Set<string>,
  prior: PriorRow[],
): { families: number; urls: number } {
  if (!fs.existsSync(bankPath)) return { families: 0, urls: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(bankPath, 'utf-8'));
  } catch (e) {
    throw new Error(`corrupt_exclusion_bank: cannot parse ${bankPath}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`corrupt_exclusion_bank: expected a row array in ${bankPath}`);
  }
  let families = 0;
  let urls = 0;
  for (const [index, entry] of parsed.entries()) {
    const r = entry as { familyId?: unknown; canonicalUrl?: unknown; title?: unknown; brand?: unknown };
    if (typeof r.familyId !== 'string' || !r.familyId || typeof r.canonicalUrl !== 'string') {
      throw new Error(`corrupt_exclusion_bank: row ${index} in ${bankPath} lacks a string familyId/canonicalUrl`);
    }
    const key = canonicalProductUrlKey(r.canonicalUrl);
    if (key === null) {
      throw new Error(`corrupt_exclusion_bank: row ${index} in ${bankPath} has an unparseable canonicalUrl`);
    }
    if (!byFamily.has(r.familyId)) families++;
    byFamily.add(r.familyId);
    if (!byUrl.has(key)) urls++;
    byUrl.add(key);
    prior.push({
      familyId: r.familyId,
      canonicalUrl: r.canonicalUrl,
      title: typeof r.title === 'string' ? r.title : '',
      brand: typeof r.brand === 'string' ? r.brand : '',
    });
  }
  return { families, urls };
}
/** Admission identity for public-only exclusion: sealed public family ids plus
 * canonical product-URL identity keys (apex/www + trailing-slash
 * insensitive). Raw URLs stay on the prior rows for provenance; the byUrl
 * set holds keys only, so lookup is an O(1) exact match on identity.
 * Private custody is NEVER parsed during prospective capture: old custody
 * stays sealed, and overlap against unparsed private banks is unverified. */
export interface SourceExclusion {
  byFamily: Set<string>;
  byUrl: Set<string>;
  prior: PriorRow[];
  publicFamilies: number;
  publicUrls: number;
  stagedFamilies: number;
  stagedUrls: number;
  stagedBanks: string[];
}
/**
 * Public-only exclusion load: sealed public banks plus explicit --exclude-bank
 * stage chaining. There is intentionally NO private-custody branch: passing
 * --prior-custody is rejected in main before any work.
 */
export function loadPublicExclusion(extraBanks: string[]): SourceExclusion {
  const byFamily = new Set<string>();
  const byUrl = new Set<string>();
  const prior: PriorRow[] = [];
  let publicFamilies = 0;
  let publicUrls = 0;
  // Every sealed public source bank: primary + supplemental for
  // representative v1/v2/v3/v4/v9, plus the current expansion banks so a
  // future new collection cannot re-expose them either.
  for (const p of [...PRIOR_PUBLIC_BANKS, ...expansionBanks()]) {
    const added = loadBank(p, byFamily, byUrl, prior);
    publicFamilies += added.families;
    publicUrls += added.urls;
  }
  let stagedFamilies = 0;
  let stagedUrls = 0;
  const stagedBanks: string[] = [];
  for (const bankPath of extraBanks) {
    // Stage chaining reads explicit public stage outputs only; a missing or
    // private-looking bank path fails closed (never a silent skip).
    const lowered = bankPath.toLowerCase();
    if (lowered.includes('custody') || lowered.includes('holdout') || lowered.includes('membership')) {
      throw new Error(`private_exclusion_rejected: stage banks must be public outputs, not custody: ${bankPath}`);
    }
    if (!fs.existsSync(bankPath)) {
      throw new Error(`missing_stage_bank: stage-chained exclusion bank not found: ${bankPath}`);
    }
    const added = loadBank(bankPath, byFamily, byUrl, prior);
    stagedFamilies += added.families;
    stagedUrls += added.urls;
    stagedBanks.push(bankPath);
  }
  return { byFamily, byUrl, prior, publicFamilies, publicUrls, stagedFamilies, stagedUrls, stagedBanks };
}

export interface Candidate {
  row: Record<string, unknown>;
  stratum: string;
  sourceForm: 'manufacturer-feed' | 'manufacturer-page';
}

async function collectFeedProducts(seed: Seed, exclusion: SourceExclusion, stats: Record<string, number>): Promise<Candidate[]> {
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
      if (isExcludedProductUrl(canonicalUrl, exclusion)) { stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1; continue; }
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
        let pathname: string;
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
          let same: boolean;
          try { same = sameSite(u, `https://${seed.domain}`); } catch { continue; }
          if (!same || scoreUrl(u) >= 3 || NON_PRODUCT_HINT.test(u)) continue;
          let seg: string;
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
            let pathname: string;
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

export async function collectPage(seed: Seed, url: string, exclusion: SourceExclusion, stats: Record<string, number>): Promise<Candidate | null> {
  // Canonical pre-fetch admission gate: the raw spelling can differ from the
  // sealed spelling (apex/www, trailing slash), so identity — not the raw
  // string — decides, BEFORE any network.
  if (isExcludedProductUrl(url, exclusion)) { stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1; return null; }
  const res = await fetchOnce(url, 'page');
  if (!res) return null;
  // Redirect-alias gate: a live redirect may resolve to a final URL whose
  // identity is sealed even though the prefetch spelling was unseen.
  if (isExcludedProductUrl(res.finalUrl, exclusion)) { stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1; return null; }
  return candidateFromPageHtml(seed, url, res.finalUrl, res.text, new Date().toISOString(), stats);
}

export const CUSTODY_ARTIFACTS = ['candidate-bank.json', 'holdout-inputs.json', 'membership.json', 'attempt-ledger.json', 'source-window-usage.json'];
export const PUBLIC_ARTIFACTS = ['source-development.json', 'source-development-supplemental.json', 'collection-manifest.json', 'source-request-receipts.json'];

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

function rejectSymlinkedOutputDir(dir: string, what: string): void {
  try {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
      throw new Error(`symlink_output_rejected: ${what} must not be a symlink: ${dir}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('symlink_output_rejected')) throw e;
    throw e;
  }
}

async function main(): Promise<void> {
  if (PRIOR_CUSTODY_FLAG !== null) {
    throw new Error('private_exclusion_rejected: --prior-custody is removed for prospective capture; old custody stays sealed (use --exclude-bank <public-bank> for stage chaining)');
  }
  if (WRITE) {
    rejectSymlinkedOutputDir(CUSTODY, '--custody');
    rejectSymlinkedOutputDir(PUBLIC, '--public');
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
  const cachedUrlsByDomain: Record<string, string[]> = {};
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
  const stageBanks = argsAll('--exclude-bank');
  const exclusion = loadPublicExclusion(stageBanks);
  const stats: Record<string, number> = { excludedPriorUrl: 0, excludedPriorFamily: 0, excludedNearDup: 0, excludedThinEvidence: 0 };
  const knownBrands = seeds.map(s => s.brand);
  const raw: Candidate[] = [];
  if (DRY_RUN || !WRITE) {
    // Planning only: no fetch, no window spend. Optionally reports the owned
    // window status when flags are provided (validating, never spending).
    let windowStatus: Record<string, unknown>;
    if (SOURCE_WINDOW_DIR === null || OWNER_DECISIONS_PATH === null) {
      windowStatus = { status: 'not-provided', note: 'Main creates the owned window after planner+reviewer; fetching requires --source-window <dir> + --owner-decisions <file>' };
    } else if (!fs.existsSync(SOURCE_WINDOW_DIR)) {
      windowStatus = { status: 'not-created-yet', windowDir: SOURCE_WINDOW_DIR, note: 'no capture authorized until Main creates this window after planner+reviewer' };
    } else {
      const planningOwnerSha = computeOwnerDecisionSha256(OWNER_DECISIONS_PATH);
      const planningWindow = openSourceWindow({
        windowDir: SOURCE_WINDOW_DIR,
        expectedOwnerDecisionSha256: planningOwnerSha,
        expectedAuthorityHash: authorityHash,
        expectedMaxHttpAttempts: SOURCE_WINDOW_MAX,
      });
      const usage = getSourceWindowUsage(planningWindow);
      windowStatus = { status: 'open', windowId: usage.windowId, maxHttpAttempts: usage.max, spent: usage.spent, remaining: usage.remaining, invocationCap: parseInvocationCap(ATTEMPT_CAP_RAW, usage.remaining) };
    }
    console.log(JSON.stringify({
      artifactKind: 'approved-source-window-collection-plan',
      mode: DRY_RUN ? 'dry-run' : 'no-write',
      fetchPlan: { wouldFetch: false, reason: 'planning-only: no HTTP requests, no window spend' },
      sourceWindow: windowStatus,
      historicalAccounting: 'unverified: this run prints ONLY its approved window; no prior/global totals are claimed',
      authorityHash,
      taxonomyPath,
      taxonomyFileHash,
      seeds,
      seedFile: seedFile ?? null,
      stageBanks,
      exclusionLedger: {
        publicPriorFamilies: exclusion.publicFamilies,
        publicPriorUrls: exclusion.publicUrls,
        stagedFamilies: exclusion.stagedFamilies,
        stagedUrls: exclusion.stagedUrls,
        priorLedger: PRIOR_LEDGER_IDS,
        privateCustodyParsed: false,
        privateOverlapCaveat: 'old sealed banks stay unparsed; overlap against unparsed private banks is unverified and uncertifiable by this run',
      },
      sealGuard: { custodyDir: CUSTODY, publicDir: PUBLIC, clashes: WRITE ? [] : findExistingArtifacts(CUSTODY, PUBLIC, fs.existsSync) },
    }, null, 2));
    return;
  }
  // Any fetching run opens the Main-created shared window BEFORE any fetch and
  // binds the exact owner-decision bytes + authority. --attempt-cap means
  // remaining-window: default = all remaining, reject-if-greater, never reset.
  if (SOURCE_WINDOW_DIR === null || OWNER_DECISIONS_PATH === null) {
    throw new Error('source_window_required: fetching runs require --source-window <dir> (Main-created) and --owner-decisions <owner-approved-decisions.json>');
  }
  const ownerDecisionSha256 = computeOwnerDecisionSha256(OWNER_DECISIONS_PATH);
  activeWindow = openSourceWindow({
    windowDir: SOURCE_WINDOW_DIR,
    expectedOwnerDecisionSha256: ownerDecisionSha256,
    expectedAuthorityHash: authorityHash,
    expectedMaxHttpAttempts: SOURCE_WINDOW_MAX,
  });
  const windowBefore = getSourceWindowUsage(activeWindow);
  invocationBudget = parseInvocationCap(ATTEMPT_CAP_RAW, windowBefore.remaining);

  for (const seed of seeds) {
    if (spentSeqs.length >= invocationBudget) break;
    // Sitemap first: feed verification requires an actual sitemap match.
    let sitemapUrls: string[] = [];
    let prequalified = new Set<string>();
    if (spentSeqs.length < invocationBudget) ({ urls: sitemapUrls, prequalified } = await collectSitemapUrls(seed, stats));
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
      if (spentSeqs.length >= invocationBudget || added >= 250) break;
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

  const windowAfter = getSourceWindowUsage(activeWindow);
  const summary = {
    artifactKind: 'approved-source-window-collection-summary',
    sourceWindow: {
      windowDir: activeWindow.windowDir,
      windowId: activeWindow.windowId,
      maxHttpAttempts: activeWindow.maxHttpAttempts,
      ownerDecisionSha256,
      ownerDecisionsPath: OWNER_DECISIONS_PATH,
      windowSpentBefore: windowBefore.spent,
      thisInvocationSpent: spentSeqs.length,
      windowSpentAfter: windowAfter.spent,
      windowRemaining: windowAfter.remaining,
      invocationCap: invocationBudget,
      invocationSeqs: [...spentSeqs],
    },
    historicalAccounting: 'unverified: this run prints ONLY its approved window; no prior/global totals are claimed',
    authorityHash,
    taxonomyPath,
    taxonomyFileHash,
    seeds,
    seedFile: seedFile ?? null,
    exclusionLedger: {
      publicPriorFamilies: exclusion.publicFamilies,
      publicPriorUrls: exclusion.publicUrls,
      stagedFamilies: exclusion.stagedFamilies,
      stagedUrls: exclusion.stagedUrls,
      stagedBanks: exclusion.stagedBanks,
      priorLedger: PRIOR_LEDGER_IDS,
      privateCustodyParsed: false,
      privateOverlapCaveat: 'old sealed banks stay unparsed; overlap against unparsed private banks is unverified and uncertifiable by this run',
    },
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

  fs.mkdirSync(CUSTODY, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PUBLIC, { recursive: true });
  if (fs.lstatSync(CUSTODY).isSymbolicLink() || fs.lstatSync(PUBLIC).isSymbolicLink()) {
    throw new Error('symlink_output_rejected: output dirs must not resolve through a symlink');
  }
  const put = (dir: string, name: string, data: unknown): string => {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      throw new Error(`sealed_artifacts_exist: refusing to overwrite: ${p}`);
    }
    fs.writeFileSync(p, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  };
  const windowHandle = activeWindow;
  const publicReceipts = buildPublicSourceReceipt(windowHandle, spentSeqs);
  // Private capture ledger: raw invocation linkage stays in 0600 custody.
  const privateLedger = {
    artifactKind: 'source-capture-ledger-private',
    windowId: windowHandle.windowId,
    invocationSeqs: [...spentSeqs],
    count: spentSeqs.length,
    deniedHosts: [...denied],
    at: new Date().toISOString(),
  };
  const memberByFamily = new Map(membership.map(m => [m.familyId, m]));
  const bankRows = [...devPrimary, ...devSupplemental].map(row => ({
    row,
    membership: memberByFamily.get(String((row as Record<string, unknown>).familyId)) ?? null,
  }));
  const bankHash = put(CUSTODY, 'candidate-bank.json', bankRows);
  const holdoutHash = put(CUSTODY, 'holdout-inputs.json', holdoutPrivate);
  const memberHash = put(CUSTODY, 'membership.json', membership);
  const ledgerHash = put(CUSTODY, 'attempt-ledger.json', privateLedger);
  const usageHash = put(CUSTODY, 'source-window-usage.json', {
    windowId: windowHandle.windowId,
    windowDir: windowHandle.windowDir,
    maxHttpAttempts: windowHandle.maxHttpAttempts,
    ownerDecisionSha256,
    authorityHash,
    windowSpentBefore: windowBefore.spent,
    thisInvocationSpent: spentSeqs.length,
    windowSpentAfter: windowAfter.spent,
    windowRemaining: windowAfter.remaining,
  });

  const devHash = put(PUBLIC, 'source-development.json', devPrimary);
  const devSuppHash = put(PUBLIC, 'source-development-supplemental.json', devSupplemental);
  const receiptsHash = put(PUBLIC, 'source-request-receipts.json', {
    artifactKind: 'source-request-receipts-public',
    windowId: windowHandle.windowId,
    maxHttpAttempts: windowHandle.maxHttpAttempts,
    ownerDecisionSha256,
    authorityHash,
    urlIdentity: 'sha256-only: public receipts never carry raw held URLs',
    receipts: publicReceipts,
  });
  const manifest = {
    version: 'jev-source-window-collection-manifest',
    status: 'source-evidence-only-unlabeled',
    authorityHash,
    taxonomyPath,
    taxonomyFileHash,
    ownerDecisionsPath: OWNER_DECISIONS_PATH,
    ownerDecisionSha256,
    splits: { seed: SPLIT_SEED, holdoutPercent: HOLDOUT_PERCENT },
    exclusion: {
      publicPriorFamilies: exclusion.publicFamilies,
      publicPriorUrls: exclusion.publicUrls,
      stagedFamilies: exclusion.stagedFamilies,
      stagedUrls: exclusion.stagedUrls,
      stagedBanks: exclusion.stagedBanks,
      priorLedger: PRIOR_LEDGER_IDS,
      privateCustodyParsed: false,
      excludedGroups,
      stats,
    },
    sourceWindow: summary.sourceWindow,
    historicalAccounting: summary.historicalAccounting,
    remainingExposureCaveat: 'old sealed banks cannot be certified eligible by this work; prior private overlap is unverified; new captures must not implicitly certify them',
    counts: { familiesKept: kept.length, devPrimary: devPrimary.length, devSupplemental: devSupplemental.length, holdoutFamilies: membership.filter(m => m.split === 'holdout').length, holdoutRows: holdoutPrivate.length },
    commitments: { bankHash, holdoutHash, memberHash, ledgerHash, usageHash, devHash, devSuppHash, receiptsHash },
    privacy: { noHoldoutRowsInPublic: true, custodyMode: '0600', publicReceiptUrls: 'sha256-only', labelsCollected: 0, modelCalls: 0, dbReads: 0 },
  };
  const manifestHash = put(PUBLIC, 'collection-manifest.json', manifest);
  console.log(JSON.stringify({ ...summary, files: { devHash, devSuppHash, manifestHash, holdoutHash, receiptsHash } }, null, 2));
}

if (import.meta.main) {
  await main();
}
