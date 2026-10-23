import type * as cheerio from 'cheerio';
import { isThirdPartyPriceSpecification, type ScrapedProductEvidence } from '../corpus-schema.js';
import { computeEntityId } from '../url-policy.js';

function isChewyProductUrl(url: string): boolean {
  return url.includes('/dp/');
}

export function parseChewyProductHtml(url: string, $: cheerio.CheerioAPI): ScrapedProductEvidence | null {
  if (!isChewyProductUrl(url)) {
    return null;
  }

  // Extract Title
  const title =
    $('h1[data-testid="product-title"]').text().trim() ||
    $('h1.product-title').text().trim() ||
    $('h1').first().text().trim();

  if (!title) return null;

  // Extract Brand
  const brand =
    $('[data-testid="brand-name"]').text().trim() ||
    $('.product-header__brand a').text().trim() ||
    $('a[href*="/b/"]').first().text().trim() ||
    undefined;

  // Extract Breadcrumbs
  const breadcrumbItems: string[] = [];
  $('[data-testid="breadcrumb-item"], nav.breadcrumbs li, ul.breadcrumb li').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text !== '>' && text.toLowerCase() !== 'home') {
      breadcrumbItems.push(text);
    }
  });

  // Extract Specifications
  const specifications: Record<string, string> = {};
  // Chewy key-value tables
  $('tr[data-testid], .specifications__row, table.specs-table tr, section#Specifications tr').each((_, el) => {
    const key = $(el).find('th, td:first-child, dt, .spec-title').text().trim().replace(/:$/, '');
    const val = $(el).find('td:last-child, dd, .spec-value').text().trim();
    if (key && val && key !== val && !isThirdPartyPriceSpecification(key)) {
      specifications[key] = val;
    }
  });

  // Check LD-JSON structured data for UPC/GTIN/Images
  let gtin: string | undefined;
  let mpn: string | undefined;
  let description: string | undefined;
  const images: string[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '{}');
      const item = Array.isArray(data) ? data.find((d) => d['@type'] === 'Product') : data;
      if (item && item['@type'] === 'Product') {
        if (item.gtin13 || item.gtin12 || item.gtin8 || item.gtin) {
          gtin = String(item.gtin13 || item.gtin12 || item.gtin8 || item.gtin);
        }
        if (item.mpn) mpn = String(item.mpn);
        if (item.description) description = String(item.description).trim();
        if (item.image) {
          const imgs = Array.isArray(item.image) ? item.image : [item.image];
          imgs.forEach((img: unknown) => {
            if (typeof img === 'string') images.push(img);
            else if (typeof img === 'object' && img !== null && 'url' in img) images.push(String((img as { url: string }).url));
          });
        }
      }
    } catch {
      // Ignore invalid JSON-LD
    }
  });

  // Fallback description
  if (!description) {
    description = $('[data-testid="product-description"], section#Descriptions').text().trim() || undefined;
  }

  // Fallback images
  if (images.length === 0) {
    $('img[src*="/app/images/products/"]').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !images.includes(src)) images.push(src);
    });
  }

  return {
    entityId: computeEntityId(url),
    retailer: 'chewy.com',
    sourceUrl: url,
    scrapedAt: new Date().toISOString(),
    title,
    brand,
    gtin,
    mpn,
    rawBreadcrumb: breadcrumbItems,
    specifications,
    description,
    images: images.filter((img) => img.startsWith('http')),
    acquisitionMode: 'browser_parse',
    parserVersion: '2.0',
    validationState: 'unvalidated',
    qualityFlags: [],
    pageKind: 'unknown',
  };
}

export function extractChewyCatalogLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const links = new Set<string>();
  $('a[href*="/dp/"], a[href*="/b/"], a[href*="/app/c/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      if (absoluteUrl.includes('chewy.com')) {
        links.add(absoluteUrl);
      }
    } catch {
      // invalid URL
    }
  });
  return Array.from(links);
}
