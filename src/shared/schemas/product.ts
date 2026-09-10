// fallow-ignore-file unused-export

import { z } from 'zod';


export const MediaSchema = z.object({
  primary: z.string().nullable().default(null),
  additional: z.array(z.string()).default(() => [] as string[]),
});

export const InventorySchema = z.object({
  quantityOnHand: z.number().int().nullable().default(null),
  lowStockThreshold: z.number().int().nullable().default(null),
  outOfStockLimit: z.number().int().nullable().default(null),
});

export const SeoSchema = z.object({
  fileName: z.string().nullable().default(null),
  searchKeywords: z.string().nullable().default(null),
  googleProductCategory: z.string().nullable().default(null),
});

export const CoreProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  price: z.string().nullable().default(null),
  salePrice: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  inventory: InventorySchema.default({
    quantityOnHand: null,
    lowStockThreshold: null,
    outOfStockLimit: null,
  }),
  availability: z.string().nullable().default(null),
  weight: z.string().nullable().default(null),
  taxable: z.boolean().default(true),
  media: MediaSchema.default({
    primary: null,
    additional: [],
  }),
  seo: SeoSchema.default({
    fileName: null,
    searchKeywords: null,
    googleProductCategory: null,
  }),
  productOnPages: z.array(z.string()).default(() => [] as string[]),
});

export const ProductSourceSchema = z.object({
  dbname: z.string().default('products'),
  uniqueName: z.string().default('SKU'),
});

export const PreservedFieldsSchema = z.object({
  unknownElements: z.record(z.string(), z.unknown()),
  advancedBlocks: z.record(z.string(), z.string()),
  rawAttributes: z.record(z.string(), z.string()),
});

export const ShopSiteMetaSchema = z.object({
  productId: z.string().nullable().default(null),
  productGuid: z.string().nullable().default(null),
  xmlVersion: z.string().default('15.0'),
  lastPulledAt: z.string().nullable().default(null),
  lastRemoteHash: z.string().nullable().default(null),
  lastSyncedAt: z.string().nullable().default(null),
  source: ProductSourceSchema,
  preserved: PreservedFieldsSchema,
});

export const ProductMetadataSchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export const ProductSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  sku: z.string().min(1, 'SKU is required'),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
  core: CoreProductSchema,
  customFields: z.record(z.string(), z.string()),
  shopsite: ShopSiteMetaSchema,
  metadata: ProductMetadataSchema,
});

export type Product = z.infer<typeof ProductSchema>;
export type CoreProduct = z.infer<typeof CoreProductSchema>;
export type ShopSiteMeta = z.infer<typeof ShopSiteMetaSchema>;
export type PreservedFields = z.infer<typeof PreservedFieldsSchema>;

/**
 * Inspect page names assigned to a product.
 * Deduplicates and trims strings, returning an immutable array.
 */
export function getProductPages(
  product: { core: { productOnPages?: string[] } } | { productOnPages?: string[] },
): readonly string[] {
  const pages = 'core' in product && product.core
    ? product.core.productOnPages
    : (product as { productOnPages?: string[] }).productOnPages;
  if (!Array.isArray(pages)) return Object.freeze([]);
  const unique = Array.from(new Set(pages.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)));
  return Object.freeze(unique);
}

/**
 * Add page names to a product with immutability and deduplication.
 */
export function addProductPages<T extends { core: CoreProduct }>(product: T, newPages: readonly string[]): T {
  const current = getProductPages(product);
  const combined = Array.from(new Set([...current, ...newPages.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)]));
  return {
    ...product,
    core: {
      ...product.core,
      productOnPages: combined,
    },
  };
}

/**
 * Remove page names from a product with immutability.
 */
export function removeProductPages<T extends { core: CoreProduct }>(product: T, pagesToRemove: readonly string[]): T {
  const toRemove = new Set(pagesToRemove.map(p => p.trim().toLowerCase()));
  const current = getProductPages(product);
  const filtered = current.filter(p => !toRemove.has(p.toLowerCase()));
  return {
    ...product,
    core: {
      ...product.core,
      productOnPages: filtered,
    },
  };
}

/**
 * Set page names on a product, replacing existing assignments with deduplicated, trimmed array.
 */
export function setProductPages<T extends { core: CoreProduct }>(product: T, pages: readonly string[]): T {
  const unique = Array.from(new Set(pages.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)));
  return {
    ...product,
    core: {
      ...product.core,
      productOnPages: unique,
    },
  };
}

/**
 * Check if a product is assigned to a specific category page (case-insensitive).
 */
export function hasProductPage(
  product: { core: { productOnPages?: string[] } } | { productOnPages?: string[] },
  pageName: string,
): boolean {
  if (!pageName) return false;
  const target = pageName.trim().toLowerCase();
  const pages = getProductPages(product);
  return pages.some(p => p.toLowerCase() === target);
}
