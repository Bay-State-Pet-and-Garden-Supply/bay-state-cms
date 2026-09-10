import { ShopSiteProductCodec } from './product-codec';
import type { Product } from '../shared/types';

/**
 * Build ShopSite XML document for a set of products.
 * Generates only the changed products, wrapped in ShopSiteProducts root.
 * Delegates directly to the authoritative ShopSiteProductCodec.
 */
export function buildProductsXml(
  products: Product[],
  options?: { xmlVersion?: string; newProductTag?: string; uniquifyFileNames?: boolean },
): string {
  const result = ShopSiteProductCodec.encodeMany(products, options);
  return result.xml;
}

/**
 * Build a single Product XML element from the normalized Product model.
 * Delegates directly to the authoritative ShopSiteProductCodec.
 */
export function buildProductXml(product: Product, _newProductTag?: string, fileName?: string): string {
  const result = ShopSiteProductCodec.encode(product, fileName ? { fileName } : undefined);
  return result.xml;
}
