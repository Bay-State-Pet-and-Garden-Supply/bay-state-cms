import type * as cheerio from 'cheerio';
import { isThirdPartyPriceSpecification, type ScrapedProductEvidence } from '../corpus-schema.js';
import { computeEntityId } from '../url-policy.js';

function isBurpeeProductUrl(url: string): boolean {
  // Ignore root categories and non-product pages
  if (
    url === 'https://www.burpee.com/vegetables/' ||
    url === 'https://www.burpee.com/flowers/' ||
    url.includes('/e-gift-card')
  ) {
    return false;
  }
  // True product pages usually end in .html or have product identifiers
  return url.endsWith('.html') || url.includes('/prod');
}

export function parseBurpeeProductHtml(url: string, $: cheerio.CheerioAPI): ScrapedProductEvidence | null {
  // Reject non-product landing pages
  if (!isBurpeeProductUrl(url)) {
    return null;
  }

  const title =
    $('h1.product-name').text().trim() ||
    $('h1.page-title').text().trim() ||
    $('h1').first().text().trim();

  // Reject generic category titles
  if (
    !title ||
    title.includes('Seeds & Plants') ||
    title.toLowerCase().includes('category')
  ) {
    return null;
  }

  const brand = 'Burpee';

  // Breadcrumbs extraction (Magento / Magento 2 / Custom layout)
  const breadcrumbItems: string[] = [];
  $('.breadcrumbs .item, .breadcrumb li, ol.breadcrumb li, nav[aria-label="breadcrumb"] li').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text !== '/' && text.toLowerCase() !== 'home' && text.toLowerCase() !== 'main content') {
      breadcrumbItems.push(text);
    }
  });

  // Specifications extraction
  const specifications: Record<string, string> = {};
  $('.product-attribute, .attribute-item, .tech-specs tr, table.attributes tr, .additional-attributes tr, dl.product-specs dt').each((_, el) => {
    const key = $(el).is('dt')
      ? $(el).text().trim().replace(/:$/, '')
      : $(el).find('.label, th, td:first-child').text().trim().replace(/:$/, '');
    const val = $(el).is('dt')
      ? $(el).next('dd').text().trim()
      : $(el).find('.value, td:last-child').text().trim();
    if (key && val && key !== val && !isThirdPartyPriceSpecification(key)) {
      specifications[key] = val;
    }
  });

  let gtin: string | undefined;
  let mpn: string | undefined;
  let description: string | undefined;
  const images: string[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '{}');
      const item = Array.isArray(data) ? data.find((d) => d['@type'] === 'Product') : data;
      if (item && item['@type'] === 'Product') {
        if (item.gtin13 || item.gtin12 || item.gtin) {
          gtin = String(item.gtin13 || item.gtin12 || item.gtin);
        }
        if (item.sku || item.mpn) mpn = String(item.sku || item.mpn);
        if (item.description) description = String(item.description).trim();
        if (item.image) {
          const imgs = Array.isArray(item.image) ? item.image : [item.image];
          imgs.forEach((img: unknown) => {
            if (typeof img === 'string') images.push(img);
          });
        }
      }
    } catch {
      // Ignore
    }
  });

  if (!description) {
    description = $('.product-description, #description, .product.attribute.description').text().trim() || undefined;
  }

  return {
    entityId: computeEntityId(url),
    retailer: 'burpee.com',
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
