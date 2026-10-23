import { listAllBrandSites } from '../db/repositories/brand-site-repo';
import { listAllProfiles, findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import {
  normalizeDomain,
  getAllDomainUrlCounts,
  indexVariantUrls,
  type VariantUrlInput,
} from '../db/repositories/brand-url-index-repo';
import { productUrlIdentityKey } from './product-url-identity';
import { fetchAndParseSitemap } from './sitemap-fetcher';
import { getAllLatestRefreshRuns } from '../db/repositories/sitemap-telemetry-repo';

type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ShopifyProductDto {
  id: number;
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  variants: Array<{
    id: number;
    title: string;
    sku: string | null;
    barcode: string | null;
    option1: string | null;
    option2: string | null;
    option3: string | null;
  }>;
}

export interface IngestShopifyCatalogResult {
  domain: string;
  productsFound: number;
  variantsIndexed: number;
  success: boolean;
  error?: string;
}

export interface PrewarmDomainResult {
  domain: string;
  status: 'synced' | 'skipped' | 'failed';
  sitemapUrlsCount: number;
  variantsIndexedCount: number;
  sourceUrl?: string;
  error?: string;
  durationMs: number;
}

export interface BatchSyncResult {
  totalDomains: number;
  syncedCount: number;
  skippedCount: number;
  failedCount: number;
  totalUrlsIndexed: number;
  totalVariantsIndexed: number;
  results: PrewarmDomainResult[];
  durationMs: number;
}

/**
 * Attempts to ingest Shopify catalog via `/products.json` endpoint.
 * Rapidly populates `brand_url_index` with all variant-level UPCs, SKUs, and options.
 */
export async function ingestShopifyCatalog(
  domain: string,
  fetchFn: NetworkFetch = fetch,
  limitPages: number = 2,
): Promise<IngestShopifyCatalogResult> {
  const normDomain = normalizeDomain(domain);
  const origin = `https://${normDomain}`;
  let totalProducts = 0;
  let totalVariants = 0;

  try {
    for (let page = 1; page <= limitPages; page++) {
      const endpoint = `${origin}/products.json?limit=250&page=${page}`;
      const res = await fetchFn(endpoint, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        if (page === 1) {
          return {
            domain: normDomain,
            productsFound: 0,
            variantsIndexed: 0,
            success: false,
            error: `HTTP ${res.status}`,
          };
        }
        break; // End of pagination
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        break;
      }

      const data = (await res.json()) as { products?: ShopifyProductDto[] };
      const products = data.products;
      if (!Array.isArray(products) || products.length === 0) {
        break;
      }

      totalProducts += products.length;

      const variantInputs: VariantUrlInput[] = [];
      for (const prod of products) {
        const baseUrl = `${origin}/products/${prod.handle}`;
        if (!Array.isArray(prod.variants)) continue;

        for (const v of prod.variants) {
          const variantUrl = `${baseUrl}?variant=${v.id}`;
          variantInputs.push({
            url: variantUrl,
            baseUrl,
            title: v.title && v.title !== 'Default Title' ? `${prod.title} - ${v.title}` : prod.title,
            upc: v.barcode ? String(v.barcode) : null,
            sku: v.sku ? String(v.sku) : null,
            brand: prod.vendor || null,
            variantTokens: [v.option1, v.option2, v.option3].filter(Boolean) as string[],
          });
        }
      }

      if (variantInputs.length > 0) {
        const indexed = indexVariantUrls(normDomain, variantInputs);
        totalVariants += indexed;
      }

      if (products.length < 250) break;
    }

    return {
      domain: normDomain,
      productsFound: totalProducts,
      variantsIndexed: totalVariants,
      success: totalProducts > 0,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      domain: normDomain,
      productsFound: totalProducts,
      variantsIndexed: totalVariants,
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Pre-warms and updates a single domain's sitemap and catalog index.
 */
export async function prewarmBrandDomain(
  domain: string,
  options?: {
    includeShopifyCatalog?: boolean;
    fetchFn?: NetworkFetch;
  },
): Promise<PrewarmDomainResult> {
  const normDomain = normalizeDomain(domain);
  const startTime = Date.now();

  try {
    const profile = findProfileByDomain(normDomain);
    const pattern = profile?.sitemapProductUrlPattern || null;

    // 1. Fetch and parse sitemap
    const sitemapResult = await fetchAndParseSitemap(
      normDomain,
      pattern,
      options?.fetchFn ?? fetch,
    );

    let variantsIndexed = 0;

    // 2. If domain supports Shopify JSON or requested, attempt catalog ingestion
    if (options?.includeShopifyCatalog !== false) {
      const shopifyResult = await ingestShopifyCatalog(normDomain, options?.fetchFn ?? fetch);
      if (shopifyResult.success) {
        variantsIndexed = shopifyResult.variantsIndexed;
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      domain: normDomain,
      status: sitemapResult.urls.length > 0 || variantsIndexed > 0 ? 'synced' : 'failed',
      sitemapUrlsCount: sitemapResult.urls.length,
      variantsIndexedCount: variantsIndexed,
      sourceUrl: sitemapResult.sourceUrl,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);
    return {
      domain: normDomain,
      status: 'failed',
      sitemapUrlsCount: 0,
      variantsIndexedCount: 0,
      error,
      durationMs,
    };
  }
}

/**
 * Discovers all configured brand sites and profiles, and syncs/prewarms sitemaps across all domains.
 */
export async function syncAllBrandSitemaps(options?: {
  concurrency?: number;
  onlyStaleOrMissing?: boolean;
  force?: boolean;
  fetchFn?: NetworkFetch;
}): Promise<BatchSyncResult> {
  const startTime = Date.now();
  const brandSites = listAllBrandSites();
  const profiles = listAllProfiles();
  const allCounts = getAllDomainUrlCounts();
  const latestRuns = getAllLatestRefreshRuns();

  const domainSet = new Set<string>();
  for (const b of brandSites) domainSet.add(normalizeDomain(b.domain));
  for (const p of profiles) domainSet.add(normalizeDomain(p.domain));

  const targetDomains: string[] = [];
  const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();

  for (const domain of domainSet) {
    if (!domain) continue;
    if (options?.force) {
      targetDomains.push(domain);
      continue;
    }

    if (options?.onlyStaleOrMissing !== false) {
      const counts = allCounts[domain];
      const latestRun = latestRuns[domain];

      const isMissing = !counts || counts.totalCount === 0;
      const isStale =
        !latestRun?.completed_at || now - new Date(latestRun.completed_at).getTime() > STALE_THRESHOLD_MS;

      if (isMissing || isStale) {
        targetDomains.push(domain);
      }
    } else {
      targetDomains.push(domain);
    }
  }

  const concurrency = Math.max(1, Math.min(6, options?.concurrency ?? 3));
  const results: PrewarmDomainResult[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < targetDomains.length) {
      const currentDomain = targetDomains[index++];
      if (!currentDomain) break;
      const res = await prewarmBrandDomain(currentDomain, {
        fetchFn: options?.fetchFn,
      });
      results.push(res);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targetDomains.length) }, () => worker());
  await Promise.all(workers);

  const syncedCount = results.filter((r) => r.status === 'synced').length;
  const skippedCount = domainSet.size - targetDomains.length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const totalUrlsIndexed = results.reduce((acc, r) => acc + r.sitemapUrlsCount, 0);
  const totalVariantsIndexed = results.reduce((acc, r) => acc + r.variantsIndexedCount, 0);
  const durationMs = Date.now() - startTime;

  return {
    totalDomains: domainSet.size,
    syncedCount,
    skippedCount,
    failedCount,
    totalUrlsIndexed,
    totalVariantsIndexed,
    results,
    durationMs,
  };
}
