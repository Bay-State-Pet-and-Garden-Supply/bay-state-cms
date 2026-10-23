import type * as cheerio from 'cheerio';
import { isThirdPartyPriceSpecification, type ScrapedProductEvidence } from '../corpus-schema.js';
import { computeEntityId } from '../url-policy.js';

function isAceHardwareProductUrl(url: string): boolean {
  return url.includes('/p/') || url.includes('/product/');
}

export function parseAceHardwareProductHtml(url: string, $: cheerio.CheerioAPI): ScrapedProductEvidence | null {
  if (!isAceHardwareProductUrl(url)) {
    return null;
  }

  const title =
    $('h1.product-title').text().trim() ||
    $('h1[data-test="product-title"]').text().trim() ||
    $('h1').first().text().trim();

  if (!title) return null;

  const brand =
    $('[data-test="product-brand"]').text().trim() ||
    $('.brand-link').text().trim() ||
    undefined;

  const breadcrumbItems: string[] = [];
  $('.breadcrumbs li, nav[aria-label="breadcrumbs"] li').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text !== '/' && text.toLowerCase() !== 'home') {
      breadcrumbItems.push(text);
    }
  });

  const specifications: Record<string, string> = {};
  $('.product-specifications tr, table.specs tr, dl.specifications dt').each((_, el) => {
    const key = $(el).is('dt')
      ? $(el).text().trim()
      : $(el).find('td:first-child, th').text().trim().replace(/:$/, '');
    const val = $(el).is('dt')
      ? $(el).next('dd').text().trim()
      : $(el).find('td:last-child').text().trim();
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
        if (item.mpn || item.sku) mpn = String(item.mpn || item.sku);
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
    description = $('.product-details-description, #productDescription').text().trim() || undefined;
  }

  return {
    entityId: computeEntityId(url),
    retailer: 'acehardware.com',
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
