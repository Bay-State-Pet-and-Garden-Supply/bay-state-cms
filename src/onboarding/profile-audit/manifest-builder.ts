/**
 * Manifest Builder (Audit Sampling Seam)
 *
 * Full Stratified Sampling Manifest (Issue #175, Parent #173):
 * Stratifies sitemap inventory plus retained artifacts by:
 * - Domain
 * - Page-structure scope (standard_pdp, variant_matrix_pdp, long_tail_pdp, profile_blocked_pdp, failure_pdp)
 * - Platform (shopify, woocommerce, bigcommerce, magento, nextjs, nuxt, generic)
 * - Product family (via name stem + brand normalization)
 * - Variant shape (single_variant, multi_variant, multi_axis_variant)
 * - Capture freshness (guaranteed per sample)
 *
 * Core Guarantees:
 * - Every claimed stratum present with freshness recorded per sample.
 * - Entire product families held out from tuning and explicitly named in metadata.
 * - Distributor-record items strictly excluded.
 * - Profile-Blocked items included so fail-closed behavior is measured.
 * - Confirmed Profile Samples distinguished from unreviewed candidates.
 */

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import type {
  AuditManifest,
  AuditManifestSample,
  AuditGroundTruth,
  StratumSummary,
} from '../../shared/schemas/profile-audit';
import type { BuildStratifiedManifestOptions } from './types';
import { normalizeDomain } from '../../db/repositories/brand-url-index-repo';
import { detectPlatform } from '../extraction-ladder/platforms';
import { parseVariantMatrix } from '../variant-resolver';
import { normalizeBrand, extractNameStem } from '../product-line-grouper';
import { PROFILE_BLOCKED_ERROR_PATTERN } from '../domain-release';

export interface BuildManifestOptions extends BuildStratifiedManifestOptions {
  domain: string;
}

const DEFAULT_ARTIFACT_ROOT = resolve(
  process.cwd(),
  '.baystate-cms',
  'artifacts',
  'profile-builder',
);

export interface ResolvedSnapshotInfo {
  jobId: string;
  htmlRef: string;
  canonicalUrl: string | null;
  supplementalRefs: string[];
  hasSupplemental: boolean;
  freshness: string | null;
  htmlContent?: string;
}

export function scanDomainSnapshots(domain: string, artifactRoot: string): ResolvedSnapshotInfo[] {
  const norm = normalizeDomain(domain);
  const domainDir = join(artifactRoot, norm);
  if (!existsSync(domainDir)) return [];

  const entries = readdirSync(domainDir, { withFileTypes: true });
  const results: ResolvedSnapshotInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    const jobDir = join(domainDir, jobId);
    const htmlFile = join(jobDir, 'page.html');
    if (!existsSync(htmlFile)) continue;

    let canonicalUrl: string | null = null;
    let freshness: string | null = null;
    let htmlContent: string | undefined = undefined;

    try {
      const stats = statSync(htmlFile);
      freshness = stats.mtime.toISOString();
      htmlContent = readFileSync(htmlFile, 'utf8');
      const $ = cheerio.load(htmlContent);
      const linkCanon = $('link[rel="canonical"]').attr('href');
      const ogUrl = $('meta[property="og:url"]').attr('content');
      canonicalUrl = (linkCanon || ogUrl || '').trim() || null;
    } catch {
      // Non-fatal if parsing canonical fails
    }

    const supplementalRefs: string[] = [];
    const minHtml = join(jobDir, 'page.min.html');
    const screenshot = join(jobDir, 'screenshot.png');

    if (existsSync(minHtml)) {
      supplementalRefs.push(relative(artifactRoot, minHtml));
    }
    if (existsSync(screenshot)) {
      supplementalRefs.push(relative(artifactRoot, screenshot));
    }

    const hasSupplemental = supplementalRefs.length >= 2;
    const htmlRef = relative(artifactRoot, htmlFile);

    results.push({
      jobId,
      htmlRef,
      canonicalUrl,
      supplementalRefs,
      hasSupplemental,
      freshness,
      htmlContent,
    });
  }

  return results;
}

export function detectPlatformFromHtmlOrUrl(html: string | null, url: string): string {
  if (html) {
    const ladderPlatform = detectPlatform(html, url);
    if (ladderPlatform !== 'generic') return ladderPlatform;
    if (/window\.bcvariants\b|window\.BCData\b/i.test(html)) return 'bigcommerce';
    if (/["']jsonConfig["']|jsonConfig\s*=/i.test(html)) return 'magento';
    if (/"@type"\s*:\s*"Product"/i.test(html)) return 'jsonld';
    return 'generic';
  }
  const lower = url.toLowerCase();
  if (lower.includes('/products/')) return 'shopify';
  if (lower.includes('/product/')) return 'woocommerce';
  return 'generic';
}

export function isNonProductPath(url: string): boolean {
  try {
    const parsed = new URL(url);
    const p = parsed.pathname.toLowerCase();
    if (p === '/' || p === '') return true;
    if (/\.(md|txt|xml|json|pdf|png|jpg|jpeg|webp|svg|ico|css|js|map|woff2?|ttf|eot)$/i.test(p)) return true;
    if (/^\/(agents\.md|robots\.txt|sitemap.*|cart|checkout|account|login|register|privacy|terms|contact|about)(\/|$)/i.test(p)) return true;
    return false;
  } catch {
    return false;
  }
}

export function detectPageStructureScope(
  url: string,
  html: string | null,
  isBlocked = false,
  isFailure = false,
): string {
  if (isBlocked) return 'profile_blocked_pdp';
  if (isFailure) return 'failure_pdp';
  if (html) {
    // Check for non-standard / long-tail URL patterns
    if (/\/(collections|bundles|items|category)\//i.test(url) || /\?[a-z0-9_-]+=/i.test(url)) {
      return 'long_tail_pdp';
    }
    // Check for long-tail template markers in HTML
    if (
      /class=["'][^"']*\b(bundle|custom-template|landing-page|gift-set|set-product|pack-product)\b/i.test(html) ||
      /<meta\s+name=["']template["']\s+content=["'][^"']*\b(bundle|custom|set)\b/i.test(html)
    ) {
      return 'long_tail_pdp';
    }
    // Check for variant matrix markup / indicators
    if (
      /<form[^>]*class=["'][^"']*variations_form/i.test(html) ||
      /<select[^>]*name=["']id["']/i.test(html) ||
      /window\.bcvariants\b/i.test(html) ||
      /"jsonConfig"/i.test(html) ||
      /"ProductGroup"/i.test(html) ||
      /"hasVariant"/i.test(html)
    ) {
      return 'variant_matrix_pdp';
    }
    return 'standard_pdp';
  }
  if (/\/(collections|bundles|items|category)\//i.test(url) || /\?[a-z0-9_-]+=/i.test(url)) {
    return 'long_tail_pdp';
  }
  return 'standard_pdp';
}

export function detectVariantShape(html: string | null, url: string): string {
  if (html) {
    try {
      const matrix = parseVariantMatrix(html, url);
      if (matrix && matrix.candidates.length > 1) {
        const axes = new Set<string>();
        for (const c of matrix.candidates) {
          for (const opt of c.options) {
            axes.add(opt.axis.toLowerCase());
          }
        }
        if (axes.size >= 2) return 'multi_axis_variant';
        return 'multi_variant';
      }
      if (matrix && matrix.candidates.length === 1) {
        return 'single_variant';
      }
    } catch {
      // ignore
    }

    if (
      /<select\b[^>]*>[\s\S]*?<option\b/i.test(html) ||
      /class=["'][^"']*(swatch|variant-input|product-form__input)/i.test(html)
    ) {
      return 'multi_variant';
    }
    return 'single_variant';
  }
  if (/[?&](variant|sku|size|color)=/i.test(url)) {
    return 'multi_variant';
  }
  return 'single_variant';
}

export function deriveProductFamily(
  name: string | null | undefined,
  brand: string | null | undefined,
  url: string,
  domainHint?: string,
): string {
  const fallbackBrand = domainHint ? normalizeBrand(domainHint.split('.')[0]) : 'DefaultBrand';
  const normBrand = normalizeBrand(brand || '') || fallbackBrand;
  if (name && name.trim()) {
    const stem = extractNameStem(name);
    return stem ? `${normBrand} - ${stem}` : `${normBrand} - ${name.trim()}`;
  }
  const slug = url.split('/').filter(Boolean).pop() || 'Product';
  const cleanSlug = slug.replace(/[-_]/g, ' ').replace(/\.(html?|php)$/i, '');
  const stem = extractNameStem(cleanSlug);
  return stem ? `${normBrand} - ${stem}` : `${normBrand} - ${cleanSlug}`;
}

export function splitForFamily(
  familyId: string,
  splitSeed: number,
  holdoutPercent: number,
): 'train' | 'test' | 'holdout' {
  let hash = 0x811c9dc5;
  const input = `${familyId}:${splitSeed}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const score = (hash >>> 0) % 100;
  if (score < holdoutPercent) return 'holdout';
  if (score < holdoutPercent * 2) return 'test';
  return 'train';
}

export function normalizeFreshness(rawDate: string | null | undefined): string {
  if (!rawDate) return new Date().toISOString();
  try {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // ignore
  }
  return new Date().toISOString();
}

export function deriveDefaultGroundTruth(
  url: string,
  snapshotInfo?: ResolvedSnapshotInfo,
  artifactRoot?: string,
  domainHint?: string,
  urlMetadata?: { title?: string | null; brand?: string | null; upc?: string | null; sku?: string | null },
): AuditGroundTruth {
  let title = urlMetadata?.title?.trim() || '';
  let brand = urlMetadata?.brand?.trim() || '';
  let sku: string | null = urlMetadata?.sku?.trim() || null;
  let gtin: string | null = urlMetadata?.upc?.trim() || null;
  let price: string | null = null;
  let primaryImage: string | null = null;
  const admissibleImages: string[] = [];

  if (snapshotInfo && artifactRoot) {
    try {
      const absPath = join(artifactRoot, snapshotInfo.htmlRef);
      if (existsSync(absPath)) {
        const html = readFileSync(absPath, 'utf8');
        const $ = cheerio.load(html);

        // Check JSON-LD
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const data = JSON.parse($(el).html() || '{}');
            const items = data['@graph'] ? data['@graph'] : [data];
            for (const item of items) {
              if (item['@type'] === 'Product') {
                if (item.name && !title) title = String(item.name).trim();
                const b = typeof item.brand === 'string' ? item.brand : item.brand?.name;
                if (b && !brand) brand = String(b).trim();
                if (item.sku && !sku) sku = String(item.sku).trim();
                const g = item.gtin || item.gtin12 || item.gtin13 || item.gtin8 || item.gtin14;
                if (g && !gtin) gtin = String(g).trim();
                const p = item.offers?.price ?? item.offers?.lowPrice;
                if (p !== undefined && !price) price = String(p).trim();
                if (item.image) {
                  const imgUrl = typeof item.image === 'string' ? item.image : Array.isArray(item.image) ? item.image[0] : item.image?.url;
                  if (imgUrl && !primaryImage) {
                    primaryImage = String(imgUrl).trim();
                    admissibleImages.push(primaryImage);
                  }
                }
              }
            }
          } catch {
            // ignore
          }
        });

        if (!title) {
          title = $('h1').first().text().trim() || $('title').text().trim();
        }
      }
    } catch {
      // ignore
    }
  }

  if (!title) {
    const slug = url.split('/').filter(Boolean).pop() || 'Product';
    title = slug.replace(/[-_]/g, ' ');
  }

  return {
    identity: {
      brand: brand || (domainHint ? normalizeBrand(domainHint.split('.')[0]) : 'DefaultBrand'),
      productName: title,
      gtin,
      sku,
    },
    fields: {
      title: { available: true, expectedValue: title },
      brand: { available: !!brand, expectedValue: brand || null },
      price: { available: !!price, expectedValue: price || null },
      sku: { available: !!sku, expectedValue: sku || null },
      gtin: { available: !!gtin, expectedValue: gtin || null },
      description: { available: true },
    },
    images: {
      primaryImage,
      admissibleImages,
    },
  };
}

interface RawCandidateRecord {
  url: string;
  domain: string;
  name?: string;
  brandHint?: string | null;
  inventoryStatus: 'confirmed' | 'candidate';
  sampleType: 'confirmed_profile_sample' | 'unreviewed_candidate' | 'profile_blocked' | 'failure_sample';
  isProfileBlocked: boolean;
  isFailureSample: boolean;
  rawFreshness?: string | null;
  snapshot?: ResolvedSnapshotInfo;
  candidateMetadata?: {
    title?: string | null;
    brand?: string | null;
    upc?: string | null;
    sku?: string | null;
    lastmod?: string | null;
  };
}

interface PreparedCandidate extends RawCandidateRecord {
  platform: string;
  pageStructureScope: string;
  variantShape: string;
  productFamily: string;
  freshness: string;
  stratum: string;
  groundTruth: AuditGroundTruth;
  isHoldout?: boolean;
}

/**
 * Helper to select up to `samplesPerStratum` samples per stratum ensuring:
 * 1. Confirmed profile samples, profile-blocked, and failure items prioritized.
 * 2. Both holdout and tuning partitions represented if candidates exist from both.
 * 3. Product family diversity maximized (avoid picking duplicate families if alternative families exist).
 */
function selectStratumSamples(
  candidates: PreparedCandidate[],
  samplesPerStratum: number,
  holdoutFamilySet: Set<string>,
): PreparedCandidate[] {
  if (candidates.length <= samplesPerStratum) {
    return [...candidates];
  }
  if (samplesPerStratum <= 0) {
    return [];
  }

  const rank = (c: PreparedCandidate) => {
    if (c.sampleType === 'confirmed_profile_sample') return 1;
    if (c.sampleType === 'profile_blocked') return 2;
    if (c.sampleType === 'failure_sample') return 3;
    if (c.snapshot) return 4;
    return 5;
  };

  const holdoutCandidates = candidates
    .filter(c => holdoutFamilySet.has(c.productFamily))
    .sort((a, b) => rank(a) - rank(b));
  const tuningCandidates = candidates
    .filter(c => !holdoutFamilySet.has(c.productFamily))
    .sort((a, b) => rank(a) - rank(b));

  const selected: PreparedCandidate[] = [];
  const usedFamilies = new Set<string>();

  const pickBest = (pool: PreparedCandidate[]): PreparedCandidate | null => {
    for (const c of pool) {
      if (!selected.includes(c) && !usedFamilies.has(c.productFamily)) {
        return c;
      }
    }
    for (const c of pool) {
      if (!selected.includes(c)) {
        return c;
      }
    }
    return null;
  };

  // If both holdout and tuning candidates exist in this stratum and we need >= 2 samples:
  if (samplesPerStratum >= 2 && holdoutCandidates.length > 0 && tuningCandidates.length > 0) {
    const firstTuning = pickBest(tuningCandidates);
    if (firstTuning) {
      selected.push(firstTuning);
      usedFamilies.add(firstTuning.productFamily);
    }
    const firstHoldout = pickBest(holdoutCandidates);
    if (firstHoldout) {
      selected.push(firstHoldout);
      usedFamilies.add(firstHoldout.productFamily);
    }
  }

  // Fill remaining slots
  const overallSorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  while (selected.length < samplesPerStratum) {
    const next = pickBest(overallSorted);
    if (!next) break;
    selected.push(next);
    usedFamilies.add(next.productFamily);
  }

  return selected;
}

/**
 * Builds the full stratified sampling manifest across domains, scopes,
 * platforms, product families, and variant shapes (Issue #175).
 */
export async function buildFullStratifiedManifest(
  options: BuildStratifiedManifestOptions = {},
): Promise<AuditManifest> {
  const artifactRoot = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const splitSeed = options.splitSeed ?? 42;
  const holdoutPercent = options.holdoutPercent ?? 20;
  const samplesPerStratum = options.samplesPerStratum ?? 2;
  const candidateLimit = options.candidateLimit;

  // Determine target domains
  let targetDomains: string[] = [];
  if (options.domains && options.domains.length > 0) {
    targetDomains = options.domains.map(normalizeDomain);
  } else if (options.domain && options.domain !== 'all') {
    targetDomains = [normalizeDomain(options.domain)];
  } else {
    // Scan artifact directories or DB to find active domains
    if (existsSync(artifactRoot)) {
      try {
        const entries = readdirSync(artifactRoot, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.')) {
            targetDomains.push(normalizeDomain(e.name));
          }
        }
      } catch {
        // ignore
      }
    }
    if (targetDomains.length === 0) {
      targetDomains = ['earthbath.com'];
    }
  }

  let totalExcludedDistributorRecords = 0;
  const candidatePool: RawCandidateRecord[] = [];
  const seenUrls = new Set<string>();

  for (const domain of targetDomains) {
    const normDomain = normalizeDomain(domain);

    // 1. Confirmed Suite URLs
    let suiteUrls = options.suiteUrls;
    if (!suiteUrls) {
      try {
        const { getRepresentativeSuite } = await import('../../db/repositories/representative-suite-repo');
        suiteUrls = getRepresentativeSuite(normDomain);
      } catch {
        suiteUrls = [];
      }
    }

    // 2. Candidate sitemap URLs and metadata
    interface DiscoveredCandidateMetadata {
      url: string;
      lastmod?: string | null;
      title?: string | null;
      brand?: string | null;
      upc?: string | null;
      sku?: string | null;
    }

    const candidateMetaMap = new Map<string, DiscoveredCandidateMetadata>();
    let candidateList: string[] = [];

    if (options.candidateUrls) {
      for (const item of options.candidateUrls) {
        if (typeof item === 'string') {
          if (isNonProductPath(item)) continue;
          candidateList.push(item);
          candidateMetaMap.set(item.toLowerCase(), { url: item });
        } else if (item && item.url) {
          if (isNonProductPath(item.url)) continue;
          candidateList.push(item.url);
          candidateMetaMap.set(item.url.toLowerCase(), item);
        }
      }
    } else {
      try {
        const { getDb } = await import('../../db/connection');
        const db = getDb();
        const rows = db.query(
          `SELECT url, lastmod, title, brand, upc, sku
           FROM brand_url_index
           WHERE domain = ? AND page_type = 'product' AND active = 1`,
        ).all(normDomain) as any[];
        for (const row of rows) {
          if (!row.url || isNonProductPath(row.url)) continue;
          candidateList.push(row.url);
          candidateMetaMap.set(row.url.toLowerCase(), {
            url: row.url,
            lastmod: row.lastmod,
            title: row.title,
            brand: row.brand,
            upc: row.upc,
            sku: row.sku,
          });
        }
      } catch {
        candidateList = [];
      }
    }

    // Apply sitemapLastmods from options if provided
    if (options.sitemapLastmods) {
      for (const [u, lmod] of Object.entries(options.sitemapLastmods)) {
        const lower = u.toLowerCase();
        const existing = candidateMetaMap.get(lower);
        if (existing) {
          existing.lastmod = lmod;
        } else {
          candidateMetaMap.set(lower, { url: u, lastmod: lmod });
        }
      }
    }

    // Also enrich with brand_url_index if available and not yet fetched
    if (options.candidateUrls) {
      try {
        const { getDb } = await import('../../db/connection');
        const db = getDb();
        const rows = db.query(
          `SELECT url, lastmod, title, brand, upc, sku
           FROM brand_url_index
           WHERE domain = ?`,
        ).all(normDomain) as any[];
        for (const r of rows) {
          const lower = r.url.toLowerCase();
          const existing = candidateMetaMap.get(lower);
          if (existing) {
            existing.lastmod = existing.lastmod ?? r.lastmod;
            existing.title = existing.title ?? r.title;
            existing.brand = existing.brand ?? r.brand;
            existing.upc = existing.upc ?? r.upc;
            existing.sku = existing.sku ?? r.sku;
          }
        }
      } catch {
        // DB not available or table absent
      }
    }

    if (candidateLimit && candidateLimit > 0) {
      candidateList = candidateList.slice(0, candidateLimit);
    }

    // 3. Scan Retained Snapshots
    const snapshots = scanDomainSnapshots(normDomain, artifactRoot);

    // Fallback: If DB suite is empty and candidateUrls empty, use snapshots
    if (suiteUrls.length === 0 && candidateList.length === 0 && snapshots.length > 0) {
      suiteUrls = snapshots.map(s => s.canonicalUrl).filter((u): u is string => !!u);
    }

    // Index snapshots by URL
    const urlToSnapshot = new Map<string, ResolvedSnapshotInfo>();
    for (const snap of snapshots) {
      if (snap.canonicalUrl) {
        urlToSnapshot.set(snap.canonicalUrl.toLowerCase(), snap);
        const cleaned = snap.canonicalUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
        urlToSnapshot.set(cleaned, snap);
      }
    }

    const findSnapshot = (targetUrl: string): ResolvedSnapshotInfo | undefined => {
      const direct = urlToSnapshot.get(targetUrl.toLowerCase());
      if (direct) return direct;
      const cleaned = targetUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
      const matchCleaned = urlToSnapshot.get(cleaned);
      if (matchCleaned) return matchCleaned;
      const noQuery = cleaned.split('?')[0].split('#')[0];
      return urlToSnapshot.get(noQuery);
    };

    // Add Confirmed Suite URLs
    for (const url of suiteUrls) {
      const lower = url.toLowerCase();
      if (seenUrls.has(lower)) continue;
      seenUrls.add(lower);

      const snap = findSnapshot(url);
      const meta = candidateMetaMap.get(lower);
      const freshness = snap?.freshness ?? meta?.lastmod ?? (options.sitemapLastmods?.[url] ?? null);
      candidatePool.push({
        url,
        domain: normDomain,
        inventoryStatus: 'confirmed',
        sampleType: 'confirmed_profile_sample',
        isProfileBlocked: false,
        isFailureSample: false,
        rawFreshness: freshness,
        snapshot: snap,
        candidateMetadata: meta,
      });
    }

    // Add Onboarding Items (filtering distributor records, capturing blocked items)
    let onboardingItems = options.onboardingItems;
    if (!onboardingItems) {
      try {
        const { getDb } = await import('../../db/connection');
        const db = getDb();
        const rows = db.query(
          `SELECT id, source_url, name, brand_hint, source_type, stage, stage_status, error_message, updated_at, created_at
           FROM onboarding_items`,
        ).all() as any[];
        onboardingItems = rows.map(r => ({
          id: r.id,
          sourceUrl: r.source_url,
          name: r.name,
          brandHint: r.brand_hint,
          sourceType: r.source_type,
          stage: r.stage,
          stageStatus: r.stage_status,
          errorMessage: r.error_message,
          updatedAt: r.updated_at,
          createdAt: r.created_at,
        }));
      } catch {
        onboardingItems = [];
      }
    }

    for (const item of onboardingItems) {
      // EXCLUSION MANDATE: Distributor-record items must be excluded
      if (item.sourceType === 'distributor_record') {
        totalExcludedDistributorRecords++;
        continue;
      }

      if (!item.sourceUrl || isNonProductPath(item.sourceUrl)) continue;

      let itemHost: string;
      try {
        itemHost = new URL(item.sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
      } catch {
        continue;
      }
      if (itemHost !== normDomain) continue;

      const lower = item.sourceUrl.toLowerCase();
      const isBlocked =
        (item.stageStatus === 'failed' || item.stageStatus === 'needs_input') &&
        (PROFILE_BLOCKED_ERROR_PATTERN.test(item.errorMessage ?? '') ||
          /profile_blocked|profile-required|no_healthy_profile/i.test(item.errorMessage ?? ''));

      const isFailure = item.stageStatus === 'failed';

      if (isBlocked) {
        // PROFILE-BLOCKED MANDATE: Must be included to measure fail-closed behavior
        const snap = findSnapshot(item.sourceUrl);
        const meta = candidateMetaMap.get(lower);
        candidatePool.push({
          url: item.sourceUrl,
          domain: normDomain,
          name: item.name,
          brandHint: item.brandHint,
          inventoryStatus: 'candidate',
          sampleType: 'profile_blocked',
          isProfileBlocked: true,
          isFailureSample: true,
          rawFreshness: snap?.freshness ?? meta?.lastmod ?? item.updatedAt ?? item.createdAt,
          snapshot: snap,
          candidateMetadata: meta,
        });
        seenUrls.add(lower);
      } else if (isFailure && !seenUrls.has(lower)) {
        const snap = findSnapshot(item.sourceUrl);
        const meta = candidateMetaMap.get(lower);
        candidatePool.push({
          url: item.sourceUrl,
          domain: normDomain,
          name: item.name,
          brandHint: item.brandHint,
          inventoryStatus: 'candidate',
          sampleType: 'failure_sample',
          isProfileBlocked: false,
          isFailureSample: true,
          rawFreshness: snap?.freshness ?? meta?.lastmod ?? item.updatedAt ?? item.createdAt,
          snapshot: snap,
          candidateMetadata: meta,
        });
        seenUrls.add(lower);
      }
    }

    // Add Candidate URLs
    for (const url of candidateList) {
      const lower = url.toLowerCase();
      if (seenUrls.has(lower)) continue;
      seenUrls.add(lower);

      const snap = findSnapshot(url);
      const meta = candidateMetaMap.get(lower);
      const freshness = snap?.freshness ?? meta?.lastmod ?? (options.sitemapLastmods?.[url] ?? null);
      candidatePool.push({
        url,
        domain: normDomain,
        name: meta?.title ?? undefined,
        brandHint: meta?.brand ?? undefined,
        inventoryStatus: 'candidate',
        sampleType: 'unreviewed_candidate',
        isProfileBlocked: false,
        isFailureSample: false,
        rawFreshness: freshness,
        snapshot: snap,
        candidateMetadata: meta,
      });
    }

    // Add Remaining Snapshots only if neither suiteUrls nor candidateUrls were explicitly provided
    if (!options.suiteUrls && !options.candidateUrls) {
      for (const snap of snapshots) {
        if (!snap.canonicalUrl || isNonProductPath(snap.canonicalUrl)) continue;
        const lower = snap.canonicalUrl.toLowerCase();
        if (seenUrls.has(lower)) continue;
        seenUrls.add(lower);

        candidatePool.push({
          url: snap.canonicalUrl,
          domain: normDomain,
          inventoryStatus: 'candidate',
          sampleType: 'unreviewed_candidate',
          isProfileBlocked: false,
          isFailureSample: false,
          rawFreshness: snap.freshness,
          snapshot: snap,
        });
      }
    }
  }

  // Derive Product Family, Platform, Scope, Variant Shape, and Ground Truth for each candidate
  const preparedCandidates: PreparedCandidate[] = [];

  for (const item of candidatePool) {
    const snap = item.snapshot;
    let html: string | null = snap?.htmlContent ?? null;
    if (!html && snap && artifactRoot) {
      const abs = join(artifactRoot, snap.htmlRef);
      if (existsSync(abs)) {
        try {
          html = readFileSync(abs, 'utf8');
        } catch {
          // ignore
        }
      }
    }

    const platform = detectPlatformFromHtmlOrUrl(html, item.url);
    const pageStructureScope = detectPageStructureScope(
      item.url,
      html,
      item.isProfileBlocked,
      item.isFailureSample,
    );
    const variantShape = detectVariantShape(html, item.url);
    const freshness = normalizeFreshness(item.rawFreshness);

    const defaultGT = deriveDefaultGroundTruth(
      item.url,
      snap,
      artifactRoot,
      item.domain,
      item.candidateMetadata,
    );
    const overrides = options.groundTruthOverrides?.[item.url];

    const groundTruth: AuditGroundTruth = {
      identity: {
        ...defaultGT.identity,
        ...(item.name ? { productName: item.name } : {}),
        ...(item.brandHint ? { brand: item.brandHint } : {}),
        ...overrides?.identity,
      },
      fields: {
        ...defaultGT.fields,
        ...(item.name ? { title: { available: true, expectedValue: item.name } } : {}),
        ...overrides?.fields,
      },
      images: {
        ...defaultGT.images,
        ...overrides?.images,
      },
    };

    const productFamily = deriveProductFamily(
      groundTruth.identity.productName,
      groundTruth.identity.brand,
      item.url,
      item.domain,
    );

    const stratum = `${item.domain}:${platform}:${pageStructureScope}:${variantShape}`;

    preparedCandidates.push({
      ...item,
      platform,
      pageStructureScope,
      variantShape,
      productFamily,
      freshness,
      stratum,
      groundTruth,
    });
  }

  // Partition Product Families into Holdouts vs Tuning
  const allFamilies = Array.from(new Set(preparedCandidates.map(c => c.productFamily))).sort();
  const holdoutFamilySet = new Set<string>();
  const tuningFamilySet = new Set<string>();

  const primaryDomain = targetDomains.length === 1 ? targetDomains[0] : targetDomains.join(',');

  const requestedHoldoutNorm = new Set<string>();
  for (const raw of options.holdoutFamilies || []) {
    const rawTrim = raw.trim().toLowerCase();
    if (!rawTrim) continue;
    requestedHoldoutNorm.add(rawTrim);
    const derived = deriveProductFamily(raw, null, '', primaryDomain).toLowerCase();
    if (derived) requestedHoldoutNorm.add(derived);
    const parts = raw.split('-');
    if (parts.length > 1) {
      const derivedParts = deriveProductFamily(parts.slice(1).join('-'), parts[0], '', primaryDomain).toLowerCase();
      if (derivedParts) requestedHoldoutNorm.add(derivedParts);
    }
  }

  for (const fam of allFamilies) {
    const famLower = fam.toLowerCase();
    const isExplicit =
      requestedHoldoutNorm.has(famLower) ||
      Array.from(requestedHoldoutNorm).some(req => req.length >= 3 && famLower.includes(req));

    if (isExplicit) {
      holdoutFamilySet.add(fam);
    } else {
      const split = splitForFamily(fam, splitSeed, holdoutPercent);
      if (split === 'holdout') {
        holdoutFamilySet.add(fam);
      } else {
        tuningFamilySet.add(fam);
      }
    }
  }

  // Guarantee: When multiple families exist and none hashed to holdout, reserve one
  if (allFamilies.length >= 2 && holdoutFamilySet.size === 0) {
    const first = allFamilies[0];
    holdoutFamilySet.add(first);
    tuningFamilySet.delete(first);
  } else if (allFamilies.length >= 2 && tuningFamilySet.size === 0) {
    const candidateToMove = allFamilies.slice().reverse().find(f => !requestedHoldoutNorm.has(f.toLowerCase()))
      || allFamilies[allFamilies.length - 1];
    tuningFamilySet.add(candidateToMove);
    holdoutFamilySet.delete(candidateToMove);
  }

  // Holdout partition sanity: holdout and tuning MUST be strictly disjoint
  const holdoutUntouched = Array.from(holdoutFamilySet).every(f => !tuningFamilySet.has(f));

  // Stratify by stratum: group candidate items
  const strataMap = new Map<string, PreparedCandidate[]>();
  for (const c of preparedCandidates) {
    c.isHoldout = holdoutFamilySet.has(c.productFamily);
    const list = strataMap.get(c.stratum) ?? [];
    list.push(c);
    strataMap.set(c.stratum, list);
  }

  const claimedStrata = Array.from(strataMap.keys()).sort();
  const selectedSamples: AuditManifestSample[] = [];
  const strataSummary: Record<string, StratumSummary> = {};

  let confirmedCount = 0;
  let candidateCount = 0;
  let blockedCount = 0;

  for (const stratum of claimedStrata) {
    const candidates = strataMap.get(stratum) || [];
    if (candidates.length === 0) continue;

    const chosen = selectStratumSamples(candidates, samplesPerStratum, holdoutFamilySet);
    if (chosen.length === 0) continue;

    let minDate = new Date(chosen[0].freshness);
    let maxDate = new Date(chosen[0].freshness);

    for (const c of chosen) {
      const d = new Date(c.freshness);
      if (!isNaN(d.getTime())) {
        if (d < minDate) minDate = d;
        if (d > maxDate) maxDate = d;
      }

      const isHoldout = holdoutFamilySet.has(c.productFamily);
      const holdoutFamilyName = isHoldout ? c.productFamily : null;

      if (c.sampleType === 'confirmed_profile_sample') confirmedCount++;
      else if (c.isProfileBlocked) blockedCount++;
      else candidateCount++;

      selectedSamples.push({
        sampleId: `sample-${selectedSamples.length + 1}`,
        url: c.url,
        domain: c.domain,
        stratum: c.stratum,
        inventoryStatus: c.inventoryStatus,
        artifactRef: c.snapshot ? c.snapshot.htmlRef : null,
        supplementalArtifactRefs: c.snapshot ? c.snapshot.supplementalRefs : [],
        hasSupplementalArtifact: c.snapshot ? c.snapshot.hasSupplemental : false,
        captureFreshness: c.freshness,
        groundTruth: c.groundTruth,
        pageStructureScope: c.pageStructureScope,
        platform: c.platform,
        productFamily: c.productFamily,
        variantShape: c.variantShape,
        isHoldout,
        holdoutFamilyName,
        isProfileBlocked: c.isProfileBlocked,
        isFailureSample: c.isFailureSample,
        sampleType: c.sampleType,
      });
    }

    strataSummary[stratum] = {
      stratum,
      domain: chosen[0].domain,
      platform: chosen[0].platform,
      pageStructureScope: chosen[0].pageStructureScope,
      variantShape: chosen[0].variantShape,
      sampleCount: chosen.length,
      freshnessRange: {
        min: minDate.toISOString(),
        max: maxDate.toISOString(),
      },
    };
  }

  const explicitHoldoutsNotInTuning = (options.holdoutFamilies || [])
    .map(f => f.trim())
    .filter(f => f && !tuningFamilySet.has(f));
  const finalHoldoutFamilies = Array.from(new Set([...explicitHoldoutsNotInTuning, ...holdoutFamilySet])).sort();

  return {
    domain: primaryDomain,
    generatedAt: new Date().toISOString(),
    samples: selectedSamples,
    metadata: {
      claimedStrata,
      strataSummary,
      holdoutFamilies: finalHoldoutFamilies,
      tuningFamilies: Array.from(tuningFamilySet).sort(),
      holdoutUntouched,
      totalConfirmed: confirmedCount,
      totalCandidates: candidateCount,
      totalBlocked: blockedCount,
      totalExcludedDistributorRecords,
      totalSnapshotsDiscovered: candidatePool.filter(c => !!c.snapshot).length,
    },
  };
}

/**
 * Backward-compatible entrypoint used by #174 tests and pilot auditor.
 * Internally delegates to the full stratified manifest builder.
 */
export async function buildAuditManifest(options: BuildManifestOptions): Promise<AuditManifest> {
  const normDomain = normalizeDomain(options.domain);
  const result = await buildFullStratifiedManifest({
    domain: normDomain,
    artifactRoot: options.artifactRoot,
    suiteUrls: options.suiteUrls,
    candidateUrls: options.candidateUrls,
    candidateLimit: options.candidateLimit,
    samplesPerStratum: options.samplesPerStratum ?? 2,
    groundTruthOverrides: options.groundTruthOverrides,
    holdoutFamilies: options.holdoutFamilies,
    onboardingItems: options.onboardingItems,
  });

  return result;
}
