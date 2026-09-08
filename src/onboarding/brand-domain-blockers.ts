/**
 * ADR 0017 — batch-level 'Resolve Brand Domains' blocker aggregation.
 *
 * Discovery parks items whose brand has no mapped official domain with
 * `stage_status = 'completed'` and the deterministic review reason
 * `needs_review: no domain mapped for brand "X" — map a domain in Settings
 * to complete discovery` (job-queue.ts). Instead of one indistinguishable
 * attention row per product, the operator sees one task per brand:
 * "assign domain for BUTCHERS — unblocks 7 products".
 *
 * Mirrors the extractor-profile blocker aggregation
 * (`src/onboarding/extraction/profile-blockers.ts`): group by brand, sort by
 * blocked-product count desc then brand asc, cap sample items at 3, and
 * surface the best-known `brand_sites` mapping (if any) for prefill.
 *
 * Never throws: an aggregation error returns [] (logged) so the batch
 * workspace panel fails closed without breaking the attention tab.
 */
import { getDb } from '../db/connection';
import { stagePredicateParams } from '../db/repositories/onboarding-stage-vocabulary-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import type { BrandDomainSetupBlocker } from '../shared/schemas/onboarding-work-state';

/** The worker's stable park signature (job-queue.ts discovery noDomainMapped). */
const NO_DOMAIN_MAPPED_RE = /no domain mapped/i;

interface ParkedRow {
  id: string;
  upc: string | null;
  name: string | null;
  source_url: string | null;
  brand_hint: string | null;
  error_message: string | null;
  created_at: string;
}

/** Aggregate a batch's unmapped-brand discovery parks, grouped by brand. */
export function getBrandDomainBlockers(batchId: string): BrandDomainSetupBlocker[] {
  try {
    const db = getDb();
    // Slice 5b native: dual-spelling predicate (either stored spelling).
    const [discA, discB] = stagePredicateParams('find_product_page');
    const rows = db.query(
      `SELECT id, upc, name, source_url, brand_hint, error_message, created_at
       FROM onboarding_items
       WHERE batch_id = ? AND (stage = ? OR stage = ?) AND stage_status = 'completed'
         AND error_message IS NOT NULL
       ORDER BY row_number ASC`,
    ).all(batchId, discA, discB) as ParkedRow[];

    const byBrand = new Map<string, BrandDomainSetupBlocker>();
    for (const row of rows) {
      if (!NO_DOMAIN_MAPPED_RE.test(row.error_message ?? '')) continue;
      const brand = (row.brand_hint ?? '').trim();
      if (!brand) continue;

      let blocker = byBrand.get(brand);
      if (!blocker) {
        const sites = findBrandSites(brand);
        blocker = {
          brand,
          blockedItemCount: 0,
          batchId,
          itemIds: [],
          sampleItems: [],
          existingMapping: sites.length > 0 ? sites[0].domain : null,
          // The group's EARLIEST parked item defines when the brand started
          // blocking this batch (meaningful when items trickled in over time).
          createdAt: row.created_at,
        };
        byBrand.set(brand, blocker);
      }
      blocker.blockedItemCount += 1;
      blocker.itemIds.push(row.id);
      if (blocker.sampleItems.length < 3) {
        blocker.sampleItems.push({
          itemId: row.id,
          upc: row.upc ?? undefined,
          name: row.name ?? '',
          sourceUrl: row.source_url,
        });
      }
    }

    // Highest impact first (most blocked products), then brand asc.
    return [...byBrand.values()].sort(
      (a, b) => b.blockedItemCount - a.blockedItemCount || a.brand.localeCompare(b.brand),
    );
  } catch (err) {
    console.error(`[BrandDomainBlockers] Failed to aggregate brand-domain blockers for batch ${batchId}:`, err);
    return [];
  }
}
