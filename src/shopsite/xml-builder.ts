import { sanitizeXml } from './xml-sanitizer';
import { denormalizeProduct } from './product-denormalizer';
import { resolveBaseFileName, uniquifyFileNames } from './file-name';
import type { Product } from '../shared/types';

/**
 * Build ShopSite XML document for a set of products.
 * Generates only the changed products, wrapped in ShopSiteProducts root.
 */
export function buildProductsXml(
  products: Product[],
  options?: { xmlVersion?: string; newProductTag?: string; uniquifyFileNames?: boolean },
): string {
  const xmlVersion = options?.xmlVersion ?? '15.0';
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">');
  lines.push(`<ShopSiteProducts version="${escapeAttr(xmlVersion)}">`);
  lines.push('<Products>');

  // Issue #107: sibling drafts with identical (or slug-colliding) names must
  // never export identical <FileName> values. Uniquification is default-on
  // so every export/sync path is covered; pass { uniquifyFileNames: false }
  // only to reproduce the raw per-product output. Keys are positional
  // (SKU + index) so even a duplicate-SKU batch — already invalid via
  // DUPLICATE_SKU — still exports distinct file names (fails closed
  // downstream instead of cross-linking detail pages).
  const uniquify = options?.uniquifyFileNames ?? true;
  const keyed = products.map((p, i) => ({ product: p, key: `${p.sku}#${i}` }));
  const uniqueNames = uniquify
    ? uniquifyFileNames(keyed.map(k => ({ key: k.key, fileName: resolveBaseFileName(k.product) })))
    : null;

  for (const { product, key } of keyed) {
    lines.push(buildProductXml(product, options?.newProductTag, uniqueNames?.get(key)));
  }

  lines.push('</Products>');
  lines.push('</ShopSiteProducts>');

  return sanitizeXml(lines.join('\n'));
}

/**
 * Build a single Product XML element from the normalized Product model.
 * Uses the denormalizer for the product block.
 */
function buildProductXml(product: Product, _newProductTag?: string, fileName?: string): string {
  const result = denormalizeProduct(product, fileName ? { fileName } : undefined);
  return result.xml;
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
