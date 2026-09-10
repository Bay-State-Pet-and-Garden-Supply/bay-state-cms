import { type ScrapedProductEvidence, ScrapedProductEvidenceSchema } from '../corpus-schema.js';
import { computeEntityId } from '../url-policy.js';

export interface BrightDataTriggerResponse {
  snapshot_id: string;
}

export interface BrightDataChewyItem {
  id?: string;
  url?: string;
  title?: string;
  name?: string;
  page_title?: string;
  brand?: string;
  brand_name?: string;
  manufacturer?: string;
  upc?: string;
  gtin?: string;
  sku?: string;
  mpn?: string;
  categories?: string[];
  breadcrumbs?: string[];
  category_path?: string[];
  category?: string;
  hierarchy?: string[];
  description?: string;
  about_product?: string;
  product_details?: string;
  specifications?: Record<string, string>;
  attributes?: Record<string, string>;
  images?: string[];
  image_urls?: string[];
  image_url?: string;
  main_image?: string;
  input?: { url?: string };
  [key: string]: unknown;
}

/**
 * Bright Data Scraper / Crawl API Client.
 * Uses Bright Data cloud scrapers to fetch Chewy, Tractor Supply, and retail store data
 * without running local browsers or managing proxies.
 */
export class BrightDataScraperClient {
  private apiKey: string;
  private baseUrl = 'https://api.brightdata.com';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.BRIGHT_DATA_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('BRIGHT_DATA_API_KEY is required for BrightDataScraperClient');
    }
  }

  /**
   * Triggers a Bright Data cloud scraper collection job for a list of target product URLs.
   * @param datasetId Bright Data Dataset ID (Defaults to Chewy Product Scraper `gd_l1vikt252b5d448408` or process.env.BRIGHT_DATA_CHEWY_DATASET_ID)
   * @param urls Target product URLs to scrape
   */
  async triggerScraper(datasetId?: string, urls: string[] = []): Promise<string> {
    const dsId = datasetId || process.env.BRIGHT_DATA_CHEWY_DATASET_ID || 'gd_l1vikt252b5d448408';
    const endpoint = `${this.baseUrl}/datasets/v3/trigger?dataset_id=${encodeURIComponent(dsId)}`;
    const input = urls.map((url) => ({ url }));

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Bright Data trigger failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as BrightDataTriggerResponse;
    return data.snapshot_id;
  }

  /**
   * Polls or retrieves snapshot results from a completed Bright Data trigger job.
   * @param snapshotId The snapshot_id returned by triggerScraper
   */
  async getSnapshotData(snapshotId: string): Promise<BrightDataChewyItem[]> {
    const endpoint = `${this.baseUrl}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`;

    const res = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch Bright Data snapshot ${snapshotId} (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as BrightDataChewyItem[];
    return Array.isArray(data) ? data : [data];
  }

  /**
   * Normalizes raw Bright Data dataset output into Bay State CMS ScrapedProductEvidence.
   */
  normalizeChewyItem(item: BrightDataChewyItem): ScrapedProductEvidence | null {
    const rawUrl = item.url || (item.input && typeof item.input === 'object' && (item.input as any).url);
    if (!rawUrl) return null;

    let title = (item.title || item.name || item.page_title || '').trim();
    if (!title) return null;

    // Clean up generic page title suffixes (e.g. " - Chewy.com")
    title = title.replace(/\s*\|\s*Chewy.*$/i, '').replace(/\s*-\s*Chewy.*$/i, '').trim();

    const brand = (item.brand || item.brand_name || item.manufacturer || '').trim() || undefined;
    const gtin = (item.gtin || item.upc || item.sku || item.mpn || '').trim() || undefined;

    // Extract category breadcrumbs from array or pipe/slash delimited string
    let rawBreadcrumb: string[] = [];
    if (Array.isArray(item.categories)) {
      rawBreadcrumb = item.categories.map((c) => String(c).trim()).filter(Boolean);
    } else if (Array.isArray(item.breadcrumbs)) {
      rawBreadcrumb = item.breadcrumbs.map((c) => String(c).trim()).filter(Boolean);
    } else if (Array.isArray(item.category_path)) {
      rawBreadcrumb = item.category_path.map((c) => String(c).trim()).filter(Boolean);
    } else if (Array.isArray(item.hierarchy)) {
      rawBreadcrumb = item.hierarchy.map((c) => String(c).trim()).filter(Boolean);
    } else if (typeof item.category === 'string') {
      rawBreadcrumb = item.category.split(/[|>]/).map((c) => c.trim()).filter(Boolean);
    }

    // Specifications
    const specs: Record<string, string> = {};
    const rawSpecs = item.specifications || item.attributes;
    if (rawSpecs && typeof rawSpecs === 'object') {
      for (const [k, v] of Object.entries(rawSpecs)) {
        if (typeof v === 'string' && v.trim()) specs[k.trim()] = v.trim();
      }
    }

    // Images
    const images: string[] = [];
    if (Array.isArray(item.images)) {
      images.push(...item.images.filter((img): img is string => typeof img === 'string'));
    }
    if (Array.isArray(item.image_urls)) {
      images.push(...item.image_urls.filter((img): img is string => typeof img === 'string'));
    }
    if (typeof item.image_url === 'string' && !images.includes(item.image_url)) {
      images.push(item.image_url);
    }
    if (typeof item.main_image === 'string' && !images.includes(item.main_image)) {
      images.push(item.main_image);
    }

    const description = (item.description || item.about_product || item.product_details || '').trim() || undefined;

    let retailer = 'chewy.com';
    try {
      retailer = new URL(rawUrl).hostname.replace('www.', '');
    } catch {
      // Use default fallback
    }

    const evidence: ScrapedProductEvidence = {
      id: `brightdata-${item.id || encodeURIComponent(rawUrl)}`,
      entityId: computeEntityId(rawUrl),
      retailer,
      sourceUrl: rawUrl,
      rawUrl,
      scrapedAt: new Date().toISOString(),
      title,
      brand,
      upc: gtin,
      gtin,
      rawBreadcrumb,
      specifications: specs,
      description,
      images,
      acquisitionMode: 'cloud_scraper',
      parserVersion: '2.0',
      licenseStatus: 'proprietary',
      validationState: 'unvalidated',
      qualityFlags: [],
      pageKind: 'unknown',
    };

    return ScrapedProductEvidenceSchema.parse(evidence);
  }
}
