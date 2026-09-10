import { downloadPagesFromShopSite, type PagesXmlFetcher } from './page-download-service';
import { getActivePageImport } from '../db/repositories/page-import-repo';
import { getProductPageAssignments, listVerifiedPageOptions } from '../db/repositories/page-repo';
import { activatePageImportFromRecords } from './page-import-service';
import { extractPageNamesFromPreserved } from './page-candidate-importer';
import type { Product } from '../shared/types';

export interface PagesPreflightResult {
  status: 'up_to_date' | 'reconciled';
  sourceHash: string;
  verifiedCount: number;
  message: string;
  warnings?: string[];
}

/**
 * Preflights the ShopSite Pages database before a Product push.
 *
 * 1. Downloads the live Pages XML from ShopSite via the given fetcher/client.
 * 2. Compares the remote source hash against the workspace's active page import.
 * 3. If identical, confirms category metadata is current (zero DB writes).
 * 4. If remote has changed (or no active import exists), atomically activates
 *    the new verified page import so <ProductOnPages> serializes against
 *    up-to-date category names.
 * 5. Fails closed on any transport, parse, or response error.
 */
export async function preflightPagesSync(options: {
  workspaceId: string;
  client: PagesXmlFetcher;
  activatedBy?: string | null;
}): Promise<PagesPreflightResult> {
  const downloadResult = await downloadPagesFromShopSite(options.client);
  if (!downloadResult.ok) {
    throw new Error(`ShopSite Pages preflight failed: ${downloadResult.error}`);
  }

  const activeImport = getActivePageImport(options.workspaceId);
  if (activeImport && activeImport.sourceHash === downloadResult.sourceHash) {
    return {
      status: 'up_to_date',
      sourceHash: downloadResult.sourceHash,
      verifiedCount: downloadResult.counts.verified,
      message: `Page catalog verified up-to-date with ShopSite (${downloadResult.counts.verified} verified pages, hash ${downloadResult.sourceHash.slice(0, 8)}).`,
      warnings: downloadResult.warnings,
    };
  }

  const verifiedRecords = downloadResult.records.filter(
    r => r.identity.kind !== 'unverified_name_only' && r.identity.status === 'verified',
  );

  if (verifiedRecords.length === 0) {
    // ShopSite's pages export is degraded: it returned no verifiable identities
    // (no PageID in the XML — observed when the live store stops emitting
    // PageID, even though the page set itself is unchanged, 211/211 names
    // still present). Failing closed here would block every export with no
    // way for the operator to proceed. When we have an active verified
    // import, treat the catalog as unchanged and keep it, with an explicit
    // warning. The next successful export that *does* carry PageIDs will
    // reconcile normally; a truly empty store (no pages at all) still fails
    // because there is no active import to fall back to.
    const degradedActive = getActivePageImport(options.workspaceId);
    if (degradedActive) {
      const degradedVerifiedCount = listVerifiedPageOptions(options.workspaceId).length;
      if (degradedVerifiedCount > 0) {
        const degradedWarnings = [
          ...(downloadResult.warnings ?? []),
          `ShopSite Pages export contained no verifiable page identities (hash ${downloadResult.sourceHash.slice(0, 8)}); ` +
            `retaining active verified catalog (${degradedVerifiedCount} pages, hash ${degradedActive.sourceHash.slice(0, 8)}). ` +
            `Ask your ShopSite admin why PageID stopped exporting.`,
        ];
        return {
          status: 'up_to_date',
          sourceHash: degradedActive.sourceHash,
          verifiedCount: degradedVerifiedCount,
          message:
            `Page catalog retained — ShopSite export is degraded (no PageID, hash ${downloadResult.sourceHash.slice(0, 8)}). ` +
            `Using active verified catalog (${degradedVerifiedCount} pages).`,
          warnings: degradedWarnings,
        };
      }
    }
    throw new Error(
      `ShopSite Pages preflight found no verified pages in downloaded XML (hash ${downloadResult.sourceHash.slice(0, 8)}).`,
    );
  }

  activatePageImportFromRecords({
    workspaceId: options.workspaceId,
    sourceHash: downloadResult.sourceHash,
    parserFormatVersion: downloadResult.parserFormatVersion,
    records: verifiedRecords,
    activatedBy: options.activatedBy ?? 'sync-preflight',
  });

  const prevHash = activeImport ? activeImport.sourceHash.slice(0, 8) : 'none';
  const nextHash = downloadResult.sourceHash.slice(0, 8);
  const message = activeImport
    ? `ShopSite Pages database changed (${prevHash} -> ${nextHash}); reconciled ${verifiedRecords.length} verified page(s).`
    : `Initial page catalog activated from ShopSite (${verifiedRecords.length} verified page(s), hash ${nextHash}).`;

  return {
    status: 'reconciled',
    sourceHash: downloadResult.sourceHash,
    verifiedCount: verifiedRecords.length,
    message,
    warnings: downloadResult.warnings,
  };
}

/**
 * Reconcile preserved ProductOnPages fragments against the exact verified
 * import that preflight observed. Display names are evidence only: a product
 * with a page fragment must also have a stable product_pages.page_id that is
 * present in the active import. Removed, renamed-without-identity, stale, and
 * name-only assignments fail closed before dbupload.cgi.
 */
export function reconcileProductsToActivePages(
  workspaceId: string,
  expectedSourceHash: string,
  products: Product[],
): Product[] {
  const activeImport = getActivePageImport(workspaceId);
  if (!activeImport || activeImport.sourceHash !== expectedSourceHash) {
    throw new Error('ShopSite Pages changed during sync; refusing to serialize ProductOnPages against a different import.');
  }

  const verifiedPages = listVerifiedPageOptions(workspaceId);
  const pageById = new Map(verifiedPages.map(page => [page.id, page]));

  for (const product of products) {
    const preserved = product.shopsite?.preserved;
    const fragmentNames = extractPageNamesFromPreserved(preserved);
    const firstClassNames = product.core?.productOnPages ?? [];
    if (fragmentNames.length === 0 && firstClassNames.length === 0) continue;

    const assignments = getProductPageAssignments(product.sku);
    if (assignments.length === 0) {
      throw new Error(`Product "${product.sku}" has ProductOnPages data without verified Page identity assignments.`);
    }
    const assignmentNames = new Set(assignments.map(assignment => assignment.pageName));
    const orphanedFragments = fragmentNames.filter(name => !assignmentNames.has(name));
    if (orphanedFragments.length > 0) {
      throw new Error(`Product "${product.sku}" has unresolved ProductOnPages fragment(s): ${orphanedFragments.join(', ')}.`);
    }

    const currentNames: string[] = [];
    const seenIds = new Set<string>();
    for (const assignment of assignments) {
      if (!assignment.pageId) {
        throw new Error(`Product "${product.sku}" has name-only Page assignment "${assignment.pageName}"; refusing to serialize it.`);
      }
      if (seenIds.has(assignment.pageId)) continue;
      const page = pageById.get(assignment.pageId);
      if (!page) {
        throw new Error(`Product "${product.sku}" has Page assignment "${assignment.pageName}" outside the active ShopSite Pages import.`);
      }
      seenIds.add(assignment.pageId);
      currentNames.push(page.name);
    }

    // Replace both preserved sources so a stale advanced block cannot re-add
    // an old name after the verified current names are written. Verified
    // names land on first-class core.productOnPages; the codec serializes
    // them to DTD-compliant ProductOnPages XML at export.
    if (preserved) {
      delete preserved.unknownElements['ProductOnPages'];
      delete preserved.advancedBlocks['ProductOnPages'];
      delete preserved.advancedBlocks['productOnPages'];
    }
    product.core.productOnPages = currentNames;
  }
  return products;
}
