/**
 * Domain Config Service — unified write API.
 *
 * Upserts extractor profile selectors AND replaces brand associations
 * for a single domain in a single transaction. This is the write
 * counterpart to the read-only `domain-diagnostics-service.ts`.
 *
 * The function is intentionally a thin transaction wrapper around the
 * existing repository functions so that each repository remains the
 * single source of truth for its table's invariants.
 */

import { z } from 'zod';
import { getDb } from '../db/connection';
import { upsertProfile } from '../db/repositories/extractor-profile-repo';
import { upsertBrandSite, deleteBrandSite } from '../db/repositories/brand-site-repo';
import { buildDomainDiagnostics } from './domain-diagnostics-service';
import type { DomainDiagnosticsEntry } from '../shared/schemas/onboarding';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const DomainConfigUpsertSchema = z.object({
  titleSelector: z.string().nullable().optional(),
  priceSelector: z.null().optional(),
  descriptionSelector: z.string().nullable().optional(),
  brandSelector: z.string().nullable().optional(),
  imagesSelector: z.string().nullable().optional(),
  sitemapProductUrlPattern: z.string().nullable().optional(),

  /** Full-replacement brand associations. When provided, the domain's
   *  brand_sites are replaced wholesale — brands in this array are
   *  upserted, brands NOT in this array are deleted. When absent
   *  (undefined), brand associations are left untouched. */
  brands: z
    .array(
      z.object({
        id: z.string().optional(),
        brandName: z.string().min(1),
        urlPattern: z.string().nullable().optional(),
        successCount: z.number().int().optional(),
      }),
    )
    .optional(),
});

export type DomainConfigUpsert = z.infer<typeof DomainConfigUpsertSchema>;

// ─── Service ───────────────────────────────────────────────────────────────────

/**
 * Upsert domain config atomically.
 *
 * 1. Upserts the extractor profile — `undefined` selectors preserve
 *    existing values; `null` explicitly clears a selector.
 * 2. When `data.brands` is provided, replaces all brand associations:
 *    upserts incoming brands, deletes any existing brand_sites for
 *    this domain that are NOT in the array.
 * 3. Returns the updated DomainDiagnosticsEntry for this domain.
 */
export function upsertDomainConfig(
  domain: string,
  data: DomainConfigUpsert,
): DomainDiagnosticsEntry {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  db.transaction(() => {
    // 1. Upsert extractor profile
    upsertProfile(normalizedDomain, {
      titleSelector: data.titleSelector,
      priceSelector: null,
      descriptionSelector: data.descriptionSelector,
      brandSelector: data.brandSelector,
      imagesSelector: data.imagesSelector,
      sitemapProductUrlPattern: data.sitemapProductUrlPattern,
    });

    // 2. Replace brand associations (full-replacement semantics)
    if (data.brands !== undefined) {
      const incomingIds = new Set<string>();

      for (const brand of data.brands) {
        const brandId = brand.id;
        // Try to match existing brand_site by id + domain
        const existing =
          brandId
            ? (db
                .query('SELECT id FROM brand_sites WHERE id = ? AND domain = ?')
                .get(brandId, normalizedDomain) as { id: string } | undefined)
            : undefined;

        if (existing) {
          // existing is truthy only when brandId is defined (non-undefined, non-empty)
          const safeBrandId = brandId as string;
          // Update existing row
          db.query(
            `UPDATE brand_sites
             SET brand_name = ?, url_pattern = ?, success_count = ?, domain = ?
             WHERE id = ?`,
          ).run(
            brand.brandName.toLowerCase().trim(),
            brand.urlPattern ?? null,
            brand.successCount ?? 1,
            normalizedDomain,
            safeBrandId,
          );
          incomingIds.add(safeBrandId);
        } else {
          // Create new row
          const result = upsertBrandSite(
            brand.brandName,
            normalizedDomain,
            brand.urlPattern ?? null,
          );
          incomingIds.add(result.id);
        }
      }

      // Delete any brand_sites for this domain NOT in the incoming set
      const existingBrands = db
        .query('SELECT id FROM brand_sites WHERE domain = ?')
        .all(normalizedDomain) as { id: string }[];

      for (const row of existingBrands) {
        if (!incomingIds.has(row.id)) {
          deleteBrandSite(row.id);
        }
      }
    }
  })();

  // 3. Return diagnostics entry for this domain
  const diagnostics = buildDomainDiagnostics();
  const entry = diagnostics.find((e) => e.domain === normalizedDomain);
  if (entry) return entry;

  // Fallback — should not happen after a successful write, but guard
  // against the edge case where buildDomainDiagnostics misses a freshly
  // created domain by constructing a minimal entry.
  return {
    domain: normalizedDomain,
    hasActiveProfile: true,
    activeProfileId: null,
    profileUpdatedAt: new Date().toISOString(),
    sitemapUrlsCount: 0,
    sitemapFetchedAt: null,
    sitemapExpiresAt: null,
    sitemapSourceUrl: null,
    sitemapStale: false,
    healthStatus: 'unknown',
    healthCheckedAt: null,
    healthReason: null,
    healthStale: false,
    brandAssociations: [],
    generationCount: 0,
    latestGenerationStatus: null,
    latestGenerationAt: null,
  };
}
