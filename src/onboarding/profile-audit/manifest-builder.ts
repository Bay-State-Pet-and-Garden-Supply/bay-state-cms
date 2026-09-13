/**
 * Manifest Builder (Audit Sampling Seam)
 *
 * Constructs a sample manifest by combining:
 * 1. Confirmed products from representative suite (`getRepresentativeSuite`).
 * 2. Candidate product URLs from sitemap inventory (`brand_url_index`).
 * 3. Snapshot artifact resolution (.baystate-cms/artifacts/profile-builder/<domain>/...).
 *
 * Explicitly distinguishes available vs missing artifacts:
 * - When snapshot HTML is absent, sets `artifactRef = null` (recorded as an evidence gap downstream).
 * - When supplemental artifacts (min.html, screenshot.png) are absent, sets `hasSupplementalArtifact = false`.
 */

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import type {
  AuditManifest,
  AuditManifestSample,
  AuditGroundTruth,
} from '../../shared/schemas/profile-audit';
import { normalizeDomain } from '../../db/repositories/brand-url-index-repo';

export interface BuildManifestOptions {
  domain: string;
  artifactRoot?: string;
  suiteUrls?: string[];
  candidateUrls?: string[];
  candidateLimit?: number;
  groundTruthOverrides?: Record<string, Partial<AuditGroundTruth>>;
}

const DEFAULT_ARTIFACT_ROOT = resolve(
  process.cwd(),
  '.baystate-cms',
  'artifacts',
  'profile-builder',
);

interface ResolvedSnapshotInfo {
  jobId: string;
  htmlRef: string;
  canonicalUrl: string | null;
  supplementalRefs: string[];
  hasSupplemental: boolean;
  freshness: string | null;
}

function scanDomainSnapshots(domain: string, artifactRoot: string): ResolvedSnapshotInfo[] {
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

    try {
      const stats = statSync(htmlFile);
      freshness = stats.mtime.toISOString();
      const content = readFileSync(htmlFile, 'utf8');
      const $ = cheerio.load(content);
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
    });
  }

  return results;
}

function deriveDefaultGroundTruth(
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
            if (data['@type'] === 'Product') {
              if (data.name && !title) title = String(data.name).trim();
              const b = typeof data.brand === 'string' ? data.brand : data.brand?.name;
              if (b && !brand) brand = String(b).trim();
              if (data.sku && !sku) sku = String(data.sku).trim();
              const g = data.gtin || data.gtin12 || data.gtin13 || data.gtin8;
              if (g && !gtin) gtin = String(g).trim();
              const p = data.offers?.price ?? data.offers?.lowPrice;
              if (p !== undefined && !price) price = String(p).trim();
              if (data.image) {
                const imgUrl = typeof data.image === 'string' ? data.image : data.image.url;
                if (imgUrl && !primaryImage) {
                  primaryImage = String(imgUrl).trim();
                  admissibleImages.push(primaryImage);
                }
              }
            }
          } catch {}
        });

        if (!title) {
          title = $('h1').first().text().trim() || $('title').text().trim();
        }
      }
    } catch {}
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

export async function buildAuditManifest(options: BuildManifestOptions): Promise<AuditManifest> {
  const normDomain = normalizeDomain(options.domain);
  const artifactRoot = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;

  // 1. Resolve Suite URLs
  let suiteUrls = options.suiteUrls;
  if (!suiteUrls) {
    try {
      const { getRepresentativeSuite } = await import('../../db/repositories/representative-suite-repo');
      suiteUrls = getRepresentativeSuite(normDomain);
    } catch {
      suiteUrls = [];
    }
  }

  // 2. Resolve Candidate URLs
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

  // Fallback: If DB suite is empty but retained snapshots exist, use snapshot canonical URLs
  if (suiteUrls.length === 0 && candidateUrls.length === 0 && snapshots.length > 0) {
    suiteUrls = snapshots
      .map(s => s.canonicalUrl)
      .filter((u): u is string => !!u);
  }

  // Index snapshots by normalized canonical url and by jobId
  const urlToSnapshot = new Map<string, ResolvedSnapshotInfo>();
  for (const snap of snapshots) {
    if (snap.canonicalUrl) {
      urlToSnapshot.set(snap.canonicalUrl.toLowerCase(), snap);
      // Also match without trailing slash or www.
      const cleaned = snap.canonicalUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
      urlToSnapshot.set(cleaned, snap);
    }
  }

  function findMatchingSnapshot(targetUrl: string): ResolvedSnapshotInfo | undefined {
    const direct = urlToSnapshot.get(targetUrl.toLowerCase());
    if (direct) return direct;
    const cleaned = targetUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    return urlToSnapshot.get(cleaned);
  }

  const samples: AuditManifestSample[] = [];
  const seenUrls = new Set<string>();

  // Add confirmed suite URLs first
  for (const url of suiteUrls) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const snap = findMatchingSnapshot(url);
    const overrides = options.groundTruthOverrides?.[url];
    const defaultGroundTruth = deriveDefaultGroundTruth(url, snap, artifactRoot);

    const groundTruth: AuditGroundTruth = {
      identity: { ...defaultGroundTruth.identity, ...overrides?.identity },
      fields: { ...defaultGroundTruth.fields, ...overrides?.fields },
      images: { ...defaultGroundTruth.images, ...overrides?.images },
    };

    samples.push({
      sampleId: `sample-${samples.length + 1}`,
      url,
      domain: normDomain,
      stratum: 'standard_pdp',
      inventoryStatus: 'confirmed',
      artifactRef: snap ? snap.htmlRef : null,
      supplementalArtifactRefs: snap ? snap.supplementalRefs : [],
      hasSupplementalArtifact: snap ? snap.hasSupplemental : false,
      captureFreshness: snap ? snap.freshness : null,
      groundTruth,
    });
  }

  // Add candidate URLs up to limit
  const limit = options.candidateLimit ?? 2;
  let addedCandidates = 0;
  for (const url of candidateUrls) {
    if (seenUrls.has(url)) continue;
    if (addedCandidates >= limit) break;
    seenUrls.add(url);
    addedCandidates++;

    const snap = findMatchingSnapshot(url);
    const overrides = options.groundTruthOverrides?.[url];
    const defaultGroundTruth = deriveDefaultGroundTruth(url, snap, artifactRoot);

    const groundTruth: AuditGroundTruth = {
      identity: { ...defaultGroundTruth.identity, ...overrides?.identity },
      fields: { ...defaultGroundTruth.fields, ...overrides?.fields },
      images: { ...defaultGroundTruth.images, ...overrides?.images },
    };

    samples.push({
      sampleId: `sample-${samples.length + 1}`,
      url,
      domain: normDomain,
      stratum: 'standard_pdp',
      inventoryStatus: 'candidate',
      artifactRef: snap ? snap.htmlRef : null,
      supplementalArtifactRefs: snap ? snap.supplementalRefs : [],
      hasSupplementalArtifact: snap ? snap.hasSupplemental : false,
      captureFreshness: snap ? snap.freshness : null,
      groundTruth,
    });
  }

  return {
    domain: normDomain,
    generatedAt: new Date().toISOString(),
    samples,
    metadata: {
      totalConfirmed: suiteUrls.length,
      totalCandidates: candidateUrls.length,
      totalSnapshotsDiscovered: snapshots.length,
    },
  };
}
