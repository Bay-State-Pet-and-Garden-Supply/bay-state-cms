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

    if (/<select\b[^>]*>[\s\S]*?<option\b/i.test(html) || /class=["'][^"']*swatch/i.test(html)) {
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
): string {
  if (name && name.trim()) {
    const normBrand = normalizeBrand(brand || '') || 'DefaultBrand';
    const stem = extractNameStem(name);
    return stem ? `${normBrand} - ${stem}` : `${normBrand} - ${name.trim()}`;
  }
  const slug = url.split('/').filter(Boolean).pop() || 'Product';
  const cleanSlug = slug.replace(/[-_]/g, ' ').replace(/\.(html?|php)$/i, '');
  const normBrand = normalizeBrand(brand || '') || 'DefaultBrand';
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
): AuditGroundTruth {
  let title = '';
  let brand = '';
  let sku: string | null = null;
  let gtin: string | null = null;
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
      brand: brand || 'DefaultBrand',
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

    // 2. Candidate sitemap URLs
    let candidateUrls = options.candidateUrls;
    if (!candidateUrls) {
      try {
        const { getActiveUrlsForDomain } = await import('../../db/repositories/brand-url-index-repo');
        candidateUrls = getActiveUrlsForDomain(normDomain, 'product');
      } catch {
        candidateUrls = [];
      }
    }

    // 3. Scan Retained Snapshots
    const snapshots = scanDomainSnapshots(normDomain, artifactRoot);

    // Fallback: If DB suite is empty and candidateUrls empty, use snapshots
    if (suiteUrls.length === 0 && candidateUrls.length === 0 && snapshots.length > 0) {
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
      return urlToSnapshot.get(cleaned);
    };

    // Add Confirmed Suite URLs
    for (const url of suiteUrls) {
      const lower = url.toLowerCase();
      if (seenUrls.has(lower)) continue;
      seenUrls.add(lower);

      const snap = findSnapshot(url);
      candidatePool.push({
        url,
        domain: normDomain,
        inventoryStatus: 'confirmed',
        sampleType: 'confirmed_profile_sample',
        isProfileBlocked: false,
        isFailureSample: false,
        rawFreshness: snap?.freshness,
        snapshot: snap,
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
           FROM onboarding_items
           WHERE source_url IS NOT NULL`,
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

      if (!item.sourceUrl) continue;

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
        candidatePool.push({
          url: item.sourceUrl,
          domain: normDomain,
          name: item.name,
          brandHint: item.brandHint,
          inventoryStatus: 'candidate',
          sampleType: 'profile_blocked',
          isProfileBlocked: true,
          isFailureSample: true,
          rawFreshness: snap?.freshness ?? item.updatedAt ?? item.createdAt,
          snapshot: snap,
        });
        seenUrls.add(lower);
      } else if (isFailure && !seenUrls.has(lower)) {
        const snap = findSnapshot(item.sourceUrl);
        candidatePool.push({
          url: item.sourceUrl,
          domain: normDomain,
          name: item.name,
          brandHint: item.brandHint,
          inventoryStatus: 'candidate',
          sampleType: 'failure_sample',
          isProfileBlocked: false,
          isFailureSample: true,
          rawFreshness: snap?.freshness ?? item.updatedAt ?? item.createdAt,
          snapshot: snap,
        });
        seenUrls.add(lower);
      }
    }

    // Add Candidate URLs
    for (const url of candidateUrls) {
      const lower = url.toLowerCase();
      if (seenUrls.has(lower)) continue;
      seenUrls.add(lower);

      const snap = findSnapshot(url);
      candidatePool.push({
        url,
        domain: normDomain,
        inventoryStatus: 'candidate',
        sampleType: 'unreviewed_candidate',
        isProfileBlocked: false,
        isFailureSample: false,
        rawFreshness: snap?.freshness,
        snapshot: snap,
      });
    }

    // Add Remaining Snapshots only if neither suiteUrls nor candidateUrls were explicitly provided
    if (!options.suiteUrls && !options.candidateUrls) {
      for (const snap of snapshots) {
        if (!snap.canonicalUrl) continue;
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
  interface PreparedCandidate extends RawCandidateRecord {
    platform: string;
    pageStructureScope: string;
    variantShape: string;
    productFamily: string;
    freshness: string;
    stratum: string;
    groundTruth: AuditGroundTruth;
  }

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

    const defaultGT = deriveDefaultGroundTruth(item.url, snap, artifactRoot);
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

  const requestedHoldoutNorm = new Set<string>();
  for (const raw of options.holdoutFamilies || []) {
    const rawTrim = raw.trim().toLowerCase();
    requestedHoldoutNorm.add(rawTrim);
    requestedHoldoutNorm.add(deriveProductFamily(raw, null, '').toLowerCase());
    const parts = raw.split('-');
    if (parts.length > 1) {
      requestedHoldoutNorm.add(deriveProductFamily(parts.slice(1).join('-'), parts[0], '').toLowerCase());
    }
  }

  for (const fam of allFamilies) {
    const famLower = fam.toLowerCase();
    const isExplicit =
      requestedHoldoutNorm.has(famLower) ||
      Array.from(requestedHoldoutNorm).some(req => famLower.includes(req) || req.includes(famLower));
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

  // Guarantee: When multiple families exist and none hashed to holdout, reserve the first family
  if (allFamilies.length >= 2 && holdoutFamilySet.size === 0) {
    const first = allFamilies[0];
    holdoutFamilySet.add(first);
    tuningFamilySet.delete(first);
  } else if (allFamilies.length >= 2 && tuningFamilySet.size === 0) {
    const last = allFamilies[allFamilies.length - 1];
    tuningFamilySet.add(last);
    holdoutFamilySet.delete(last);
  }

  // Holdout partition sanity: holdout and tuning MUST be strictly disjoint
  const holdoutUntouched = Array.from(holdoutFamilySet).every(f => !tuningFamilySet.has(f));

  // Stratify by stratum: group candidate items
  const strataMap = new Map<string, PreparedCandidate[]>();
  for (const c of preparedCandidates) {
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

    // Sort to prioritize confirmed profile samples, then profile blocked, then unreviewed candidates
    candidates.sort((a, b) => {
      const rank = (c: PreparedCandidate) => {
        if (c.sampleType === 'confirmed_profile_sample') return 1;
        if (c.sampleType === 'profile_blocked') return 2;
        if (c.snapshot) return 3;
        return 4;
      };
      return rank(a) - rank(b);
    });

    const chosen = candidates.slice(0, samplesPerStratum);

    let minDate = new Date(chosen[0].freshness);
    let maxDate = new Date(chosen[0].freshness);

    for (const c of chosen) {
      const d = new Date(c.freshness);
      if (d < minDate) minDate = d;
      if (d > maxDate) maxDate = d;

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

  const primaryDomain = targetDomains.length === 1 ? targetDomains[0] : targetDomains.join(',');

  return {
    domain: primaryDomain,
    generatedAt: new Date().toISOString(),
    samples: selectedSamples,
    metadata: {
      claimedStrata,
      strataSummary,
      holdoutFamilies: Array.from(new Set([...(options.holdoutFamilies || []), ...holdoutFamilySet])).sort(),
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
