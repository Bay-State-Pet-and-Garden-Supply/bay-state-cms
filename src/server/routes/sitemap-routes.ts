import { Hono } from 'hono';
import { listAllBrandSites, upsertBrandSite, deleteBrandSitesByDomain } from '../../db/repositories/brand-site-repo';
import { listAllProfiles, findProfileByDomain, upsertProfile, deleteProfileByDomain } from '../../db/repositories/extractor-profile-repo';
import { listAllDomainStatuses, deleteDomainStatus } from '../../db/repositories/domain-status-repo';
import { deleteSitemapCacheByDomain } from '../../db/repositories/sitemap-cache-repo';
import {
  findUrlsByDomain,
  getAllDomainUrlCounts,
  normalizeDomain,
  deleteBrandUrlById,
  deleteBrandUrlsByIds,
  deleteBrandUrlsByDomain,
} from '../../db/repositories/brand-url-index-repo';
import {
  getAllLatestRefreshRuns,
  listRefreshHistory,
  getAllDomainDiscoveryEconomics,
  getDiscoveryEconomics,
  deleteTelemetryByDomain,
} from '../../db/repositories/sitemap-telemetry-repo';
import {
  evaluateDomainSitemapHealth,
  getDomainSitemapHealth,
  type DomainSitemapHealthSummary,
} from '../../onboarding/sitemap-health-evaluator';
import { fetchAndParseSitemap } from '../../onboarding/sitemap-fetcher';
import { findLocalBrandCandidates } from '../../onboarding/local-brand-url-finder';
import { prewarmBrandDomain, syncAllBrandSitemaps } from '../../onboarding/sitemap-sync-service';
import type {
  SitemapsOverviewResponse,
  SitemapDomainDetailResponse,
  BrandUrlsListResponse,
  SitemapTestLookupResponse,
  DomainSitemapSummary,
} from '../../shared/schemas/onboarding';

export const sitemapRoutes = new Hono();

/**
 * GET /api/onboarding/sitemaps
 * Overview table listing all known domains with sitemap health, URL counts, refresh stats, and metrics.
 */
sitemapRoutes.get('/onboarding/sitemaps', (c) => {
  const statusFilter = c.req.query('status');
  const attentionOnly = c.req.query('attention') === 'true';
  const searchQuery = c.req.query('search')?.toLowerCase().trim();

  const brandSites = listAllBrandSites();
  const profiles = listAllProfiles();
  const domainStatuses = listAllDomainStatuses();
  const allCounts = getAllDomainUrlCounts();
  const latestRuns = getAllLatestRefreshRuns();
  const economics = getAllDomainDiscoveryEconomics(30);
  const globalEconomics = getDiscoveryEconomics(null, 30);

  const statusMap = new Map(domainStatuses.map((s) => [s.domain, s]));
  const profileMap = new Map(profiles.map((p) => [p.domain, p]));
  const brandMap = new Map<string, typeof brandSites>();

  for (const b of brandSites) {
    const norm = normalizeDomain(b.domain);
    const existing = brandMap.get(norm) || [];
    existing.push(b);
    brandMap.set(norm, existing);
  }

  // Domain universe
  const domainSet = new Set<string>();
  for (const b of brandSites) domainSet.add(normalizeDomain(b.domain));
  for (const p of profiles) domainSet.add(normalizeDomain(p.domain));
  for (const d of Object.keys(allCounts)) domainSet.add(d);
  for (const d of Object.keys(latestRuns)) domainSet.add(d);

  const now = new Date();
  const summaries: DomainSitemapSummary[] = [];

  for (const domain of Array.from(domainSet).sort()) {
    const counts = allCounts[domain] || { totalCount: 0, activeCount: 0, inactiveCount: 0, productCount: 0 };
    const latestRefresh = latestRuns[domain] || null;
    const econ = economics[domain] || { totalLookups: 0, localHitCount: 0, localHitRate: 0 };
    const dStatus = statusMap.get(domain) || null;
    const prof = profileMap.get(domain) || null;
    const brands = brandMap.get(domain) || [];

    const health = evaluateDomainSitemapHealth(
      domain,
      counts,
      latestRefresh,
      latestRefresh ? [latestRefresh] : [],
      econ,
      dStatus,
      now,
    );

    const summary = {
      ...health,
      brandAssociations: brands.map((b) => ({
        id: b.id,
        brandName: b.brandName,
        successCount: b.successCount,
        lastUsedAt: b.lastUsedAt,
      })),
      productUrlPattern: prof?.sitemapProductUrlPattern || null,
    };

    // Apply filters
    if (statusFilter && summary.status !== statusFilter) continue;
    if (attentionOnly && !summary.needsAttention) continue;
    if (searchQuery) {
      const matchDomain = domain.includes(searchQuery);
      const matchBrand = summary.brandAssociations.some((b) => b.brandName.toLowerCase().includes(searchQuery));
      if (!matchDomain && !matchBrand) continue;
    }

    summaries.push(summary);
  }

  // Calculate totals
  const totalDomains = summaries.length;
  const healthyCount = summaries.filter((s) => s.status === 'healthy').length;
  const staleCount = summaries.filter((s) => s.status === 'stale').length;
  const errorCount = summaries.filter((s) => s.status === 'error').length;
  const missingCount = summaries.filter((s) => s.status === 'missing').length;
  const needsAttentionCount = summaries.filter((s) => s.needsAttention).length;
  const totalIndexedUrls = summaries.reduce((acc, s) => acc + s.totalUrlsCount, 0);
  const totalProductUrls = summaries.reduce((acc, s) => acc + s.productUrlsCount, 0);

  const response: SitemapsOverviewResponse = {
    domains: summaries,
    totals: {
      totalDomains,
      healthyCount,
      staleCount,
      errorCount,
      missingCount,
      needsAttentionCount,
      totalIndexedUrls,
      totalProductUrls,
      overallLocalHitRate: Math.round(globalEconomics.localHitRate * 100) / 100,
    },
    generatedAt: now.toISOString(),
  };

  return c.json(response);
});

/**
 * GET /api/onboarding/sitemaps/:domain
 * Domain detail view with sitemap configuration, recent refresh history, and summary.
 */
sitemapRoutes.get('/onboarding/sitemaps/:domain', (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const summary = getDomainSitemapHealth(domain);
  const history = listRefreshHistory(domain, 20);
  const profile = findProfileByDomain(domain);
  const brandSites = listAllBrandSites();
  const brands = brandSites.filter((b) => normalizeDomain(b.domain) === domain);

  const response: SitemapDomainDetailResponse = {
    summary: {
      ...summary,
      brandAssociations: brands.map((b) => ({
        id: b.id,
        brandName: b.brandName,
        successCount: b.successCount,
        lastUsedAt: b.lastUsedAt,
      })),
      productUrlPattern: profile?.sitemapProductUrlPattern || null,
    },
    history: history.map((h) => ({
      id: h.id,
      domain: h.domain,
      startedAt: h.started_at,
      completedAt: h.completed_at,
      status: h.status,
      sourceUrl: h.source_url,
      totalUrlsObserved: h.total_urls_observed,
      productUrlsEligible: h.product_urls_eligible,
      addedCount: h.added_count,
      updatedCount: h.updated_count,
      inactivatedCount: h.inactivated_count,
      durationMs: h.duration_ms,
      errorMessage: h.error_message,
      httpStatus: h.http_status,
    })),
    productUrlPattern: profile?.sitemapProductUrlPattern || null,
  };

  return c.json(response);
});

/**
 * GET /api/onboarding/sitemaps/:domain/urls
 * Paginated and searchable URL inventory for a domain.
 */
sitemapRoutes.get('/onboarding/sitemaps/:domain/urls', (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const search = c.req.query('search');
  const pageType = c.req.query('page_type') as any;
  const activeOnly = c.req.query('active') !== 'false';
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

  const { urls, total } = findUrlsByDomain(domain, {
    search,
    pageType,
    activeOnly,
    limit,
    offset,
  });

  const response: BrandUrlsListResponse = {
    domain,
    urls: urls.map((u) => ({
      id: u.id,
      domain: u.domain,
      url: u.url,
      path: u.path,
      slug: u.slug,
      pageType: u.page_type,
      sitemapSourceUrl: u.sitemap_source_url,
      firstSeenAt: u.first_seen_at,
      lastSeenAt: u.last_seen_at,
      lastSitemapRefreshAt: u.last_sitemap_refresh_at,
      active: u.active,
      lastmod: u.lastmod,
      title: u.title,
      h1: u.h1,
      upc: u.upc,
      sku: u.sku,
      mpn: u.mpn,
      brand: u.brand,
      lastFetchedAt: u.last_fetched_at,
      extractionStatus: u.extraction_status,
    })),
    total,
    limit,
    offset,
  };

  return c.json(response);
});

/**
 * POST /api/onboarding/sitemaps/sync-all
 * Triggers batch pre-warming / sitemap sync across all brand sites.
 */
sitemapRoutes.post('/onboarding/sitemaps/sync-all', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    concurrency?: number;
    onlyStaleOrMissing?: boolean;
    force?: boolean;
  };

  const result = await syncAllBrandSitemaps({
    concurrency: body.concurrency,
    onlyStaleOrMissing: body.onlyStaleOrMissing,
    force: body.force,
  });

  return c.json({
    ok: true,
    ...result,
  });
});

/**
 * POST /api/onboarding/sitemaps/:domain/prewarm
 * Pre-warms and enriches a specific domain's sitemap and catalog variants.
 */
sitemapRoutes.post('/onboarding/sitemaps/:domain/prewarm', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const body = (await c.req.json().catch(() => ({}))) as {
    includeShopifyCatalog?: boolean;
  };

  const result = await prewarmBrandDomain(domain, {
    includeShopifyCatalog: body.includeShopifyCatalog,
  });

  const updatedSummary = getDomainSitemapHealth(domain);

  return c.json({
    ok: result.status === 'synced',
    domain,
    result,
    summary: updatedSummary,
  });
});

/**
 * POST /api/onboarding/sitemaps/:domain/refresh
 * Explicit mutation endpoint to trigger sitemap refresh immediately for a domain.
 */
sitemapRoutes.post('/onboarding/sitemaps/:domain/refresh', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const profile = findProfileByDomain(domain);

  const fetchResult = await fetchAndParseSitemap(
    domain,
    profile?.sitemapProductUrlPattern || null,
  );

  const updatedSummary = getDomainSitemapHealth(domain);

  return c.json({
    ok: true,
    domain,
    fetchResult: {
      urlsCount: fetchResult.urls.length,
      sourceUrl: fetchResult.sourceUrl,
      reconcileResult: fetchResult.reconcileResult,
    },
    summary: updatedSummary,
  });
});

/**
 * POST /api/onboarding/sitemaps/:domain/test-lookup
 * Sandbox test endpoint to simulate product matching against the local URL index.
 */
sitemapRoutes.post('/onboarding/sitemaps/:domain/test-lookup', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const body = (await c.req.json().catch(() => ({}))) as {
    upc?: string;
    name?: string;
    sku?: string;
    brandHint?: string;
  };

  const candidates = await findLocalBrandCandidates(domain, {
    upc: body.upc,
    name: body.name,
    sku: body.sku,
    brandHint: body.brandHint,
  });

  const response: SitemapTestLookupResponse = {
    domain,
    candidates: candidates.map((cand) => ({
      url: cand.url,
      confidence: cand.confidence,
      sourceMethod: cand.sourceMethod,
      matchType: cand.matchType,
      title: cand.title,
      upc: cand.upc,
      sku: cand.sku,
      signals: cand.signals,
    })),
    testedAt: new Date().toISOString(),
  };

  return c.json(response);
});

/**
 * DELETE /api/onboarding/sitemaps/:domain/urls/:id
 * Delete a specific URL from the domain's inventory.
 */
sitemapRoutes.delete('/onboarding/sitemaps/:domain/urls/:id', (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const id = c.req.param('id');
  const success = deleteBrandUrlById(id);
  if (!success) {
    return c.json({ error: 'URL record not found' }, 404);
  }
  return c.json({ ok: true, id, domain });
});

/**
 * DELETE /api/onboarding/sitemaps/:domain/urls
 * Batch delete URLs by ID array from the domain's inventory.
 */
sitemapRoutes.delete('/onboarding/sitemaps/:domain/urls', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) {
    return c.json({ error: 'ids array is required and must not be empty' }, 400);
  }
  const deletedCount = deleteBrandUrlsByIds(ids);
  return c.json({ ok: true, deletedCount, domain });
});

/**
 * POST /api/onboarding/sitemaps
 * Add a new site/domain to the sitemap index, with optional brand mapping and immediate crawl.
 */
sitemapRoutes.post('/onboarding/sitemaps', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    domain?: string;
    brandName?: string;
    productUrlPattern?: string;
    fetchNow?: boolean;
  };

  if (!body.domain || typeof body.domain !== 'string' || !body.domain.trim()) {
    return c.json({ error: 'domain is required' }, 400);
  }

  const rawDomain = body.domain.trim();
  let domain = normalizeDomain(rawDomain);
  if (domain.includes('://')) {
    try {
      domain = normalizeDomain(new URL(domain).hostname);
    } catch {
      // fallback
    }
  }
  domain = domain.split('/')[0].split(':')[0];

  if (!domain) {
    return c.json({ error: 'Invalid domain format' }, 400);
  }

  // 1. If brandName provided, save brand mapping
  if (body.brandName && typeof body.brandName === 'string' && body.brandName.trim()) {
    upsertBrandSite(body.brandName.trim(), domain);
  }

  // 2. If productUrlPattern provided, save profile with pattern
  if (body.productUrlPattern && typeof body.productUrlPattern === 'string') {
    upsertProfile(domain, {
      sitemapProductUrlPattern: body.productUrlPattern.trim() || null,
    });
  }

  // 3. If fetchNow !== false, immediately fetch and index the sitemap
  let fetchResult = null;
  if (body.fetchNow !== false) {
    try {
      fetchResult = await fetchAndParseSitemap(
        domain,
        body.productUrlPattern?.trim() || null,
      );
    } catch (err) {
      console.warn(`[SitemapRoutes] Initial sitemap fetch for ${domain} failed:`, err);
    }
  }

  const summary = getDomainSitemapHealth(domain);

  return c.json({
    ok: true,
    domain,
    summary,
    fetchResult: fetchResult
      ? {
          urlsCount: fetchResult.urls.length,
          sourceUrl: fetchResult.sourceUrl,
          reconcileResult: fetchResult.reconcileResult,
        }
      : null,
  }, 201);
});

/**
 * DELETE /api/onboarding/sitemaps/:domain
 * Delete an entire domain from the sitemap index, cascading all URLs, cache, status, and telemetry.
 */
sitemapRoutes.delete('/onboarding/sitemaps/:domain', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  if (!domain) {
    return c.json({ error: 'domain is required' }, 400);
  }

  // Cascade deletion
  const deletedUrlsCount = deleteBrandUrlsByDomain(domain);
  deleteSitemapCacheByDomain(domain);
  deleteDomainStatus(domain);
  deleteTelemetryByDomain(domain);
  deleteBrandSitesByDomain(domain);
  deleteProfileByDomain(domain);

  return c.json({
    ok: true,
    domain,
    deletedUrlsCount,
  });
});

