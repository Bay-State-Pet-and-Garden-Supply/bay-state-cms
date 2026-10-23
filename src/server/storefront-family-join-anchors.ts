import fs from 'node:fs';
import path from 'node:path';
import { extractSubproductSkus } from '../shopsite/product-codec';
import {
  listStorefrontFamilyPlans,
  parseStorefrontFamilyPlan,
  type StorefrontFamilyPlanRow,
} from '../db/repositories/storefront-family-plan-repo';
import { buildCatalogJoinAnchor, type CatalogJoinAnchor } from '../classification/storefront-family-join';
import { resolveFamilyVariantRule, type FamilyVariantRuleVersion } from '../classification/family-variant-rule';
import type { StorefrontFamilyPlan } from '../shared/schemas/storefront-family';
import type { Product } from '../shared/types';
import { encodeSkuForFilename } from '../git/product-file-path';
/**
 * Join catalog anchors for #370 candidate discovery (route seam).
 *
 * Builds a bounded anchor pool per request: every reviewed managed family
 * member loads keyed by SKU from the plan index (workspace-scoped SELECT —
 * addressed reads, never scan position) plus key-matching catalog rows up
 * to a 512-match bound. When the caller's import query is bound, plain
 * catalog rows reach discovery only through an equality key (SKU identity,
 * source identifier, or configured type/rule/brand block). Anchors carry
 * their origin path so the review can distinguish a reviewed managed plan
 * (`managed_plan`), a live native reference (`native_reference`), and a
 * plain catalog row (`catalog_scan`). Repository pattern: all SQL lives in
 * repositories or here at the route seam (single workspace-scoped SELECT);
 * the discovery module stays pure.
 */

function textAttr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function reviewedTypeIdFor(product: Product): string | null {
  const rawAttributes = product.shopsite.preserved.rawAttributes ?? {};
  // Staged evidence first, thenReviewed-authority aliases (backfill: older
  // managed drafts stamp reviewedTypeHash only, so fall through every known
  // key before giving up — never fabricate).
  for (const key of ['nonFoodProductTypeId', 'reviewedProductTypeId', 'productTypeId', 'reviewedTypeId']) {
    const v = textAttr(rawAttributes[key]);
    if (v) return v;
  }
  return null;
}

function modelFor(product: Product): string | null {
  const rawAttributes = product.shopsite.preserved.rawAttributes ?? {};
  for (const key of ['nonFoodModel', 'model', 'Model']) {
    const v = textAttr(rawAttributes[key]);
    if (v) return v;
  }
  return null;
}

function mpnFor(product: Product): string | null {
  const rawAttributes = product.shopsite.preserved.rawAttributes ?? {};
  for (const key of ['mpn', 'MPN', 'manufacturerPartNumber', 'ManufacturerPartNumber']) {
    const v = textAttr(rawAttributes[key]);
    if (v) return v;
  }
  return null;
}

function ruleVersionFor(typeId: string | null, familyRule: FamilyVariantRuleVersion | null): FamilyVariantRuleVersion | null {
  if (familyRule) return familyRule;
  if (!typeId) return null;
  return resolveFamilyVariantRule(typeId)?.version ?? null;
}

function familyOrderOfFamily(family: StorefrontFamilyPlan): string[] {
  if (family.joinOrigin) return [...family.joinOrigin.familyOrder];
  if (family.adoptionOrigin) return [...family.adoptionOrigin.nativeOrder];
  return [...family.memberSkus].sort();
}

export function buildJoinCatalogAnchors(
  workspacePath: string,
  workspaceId: string,
  query?: { normalizedSku?: string; sourceIdentifiers?: string[]; brand?: string | null; reviewedProductTypeId?: string | null; ruleVersion?: string | null; nameTokens?: string[] } | null,
): { anchors: CatalogJoinAnchor[]; anchorsBySku: Map<string, CatalogJoinAnchor> } {
  // anchor per member (same plan metadata, origin `managed_plan`).
  let plans: StorefrontFamilyPlanRow[];
  try {
    plans = listStorefrontFamilyPlans(workspaceId);
  } catch {
    plans = [];
  }
  const appliedByMember: Record<string, { plan: StorefrontFamilyPlan; order: string[] }> = {};
  for (const row of plans) {
    let plan: StorefrontFamilyPlan;
    try {
      plan = parseStorefrontFamilyPlan(row.planJson);
    } catch {
      continue;
    }
    if (row.status !== 'applied' || plan.status !== 'applied') continue;
    if (plan.workspaceId !== workspaceId) continue;
    const order = familyOrderOfFamily(plan);
    for (const sku of plan.memberSkus) {
      if (!appliedByMember[sku]) {
        appliedByMember[sku] = { plan, order };
      }
    }
  }
  // Bounded retrieval (#370): every retained anchor arrives through an
  // explicit discovery key — reviewed managed-family membership from the
  // plan index (workspace-scoped SELECT), SKU identity, source identifier,
  // or configured type/rule/brand block. Managed members sort first by
  // addressed SKU filename (never scan position), so a valid family is
  // discovered wherever its products sort. The loop keeps only key-matching
  // anchors and stops once the bounded match pool (512) fills — no
  // unrelated filename-prefix truncation. Files that cannot match any query
  // key are skipped; a generous parse cap bounds unmatched scans.
  const MAX_ANCHOR_MATCHES = 512;
  const MAX_ANCHOR_PARSES = 2048;
  const wantSkuFile = query?.normalizedSku ? `${query.normalizedSku}.json`.toLowerCase() : null;
  const wantIdentifiers = new Set<string>();
  for (const id of query?.sourceIdentifiers ?? []) {
    const key = id.trim().toLowerCase();
    if (key.length > 0) wantIdentifiers.add(key);
  }
  const anchors: CatalogJoinAnchor[] = [];
  const anchorsBySku = new Map<string, CatalogJoinAnchor>();
  const hasQuery = query != null && (
    (query.normalizedSku?.trim().length ?? 0) > 0 ||
    (query.sourceIdentifiers?.length ?? 0) > 0 ||
    (query.brand?.trim().length ?? 0) > 0 ||
    (query.reviewedProductTypeId?.trim().length ?? 0) > 0 ||
    (query.ruleVersion?.trim().length ?? 0) > 0 ||
    (query.nameTokens?.length ?? 0) > 0
  );
  const productsDir = path.join(workspacePath, 'products');
  let files: string[];
  try {
    files = fs.readdirSync(productsDir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  files.sort();
  // Explicit discovery-key ordering: managed-family member files (addressed
  // by SKU filename) plus the queried SKU's own file come first, so a valid
  // earlier family is discovered wherever its products sort — never by
  // filename-prefix luck. The remainder follows in sorted order; the loop
  // below keeps only key-matching anchors and stops once the bounded MATCH
  // pool fills. A generous parse cap bounds worst-case work for queries
  // that match nothing; key-ordered files are parsed first, so genuine
  // matches are reached well before the cap.
  const remaining = new Set(files);
  const orderedFiles: string[] = [];
  for (const sku of Object.keys(appliedByMember).sort()) {
    const name = `${encodeSkuForFilename(sku)}.json`;
    if (remaining.has(name)) {
      orderedFiles.push(name);
      remaining.delete(name);
    }
  }
  if (wantSkuFile) {
    for (const file of files) {
      if (file.toLowerCase() === wantSkuFile && remaining.has(file)) {
        orderedFiles.push(file);
        remaining.delete(file);
        break;
      }
    }
  }
  for (const file of files) {
    if (remaining.has(file)) orderedFiles.push(file);
  }
  let parsed = 0;
  for (const file of orderedFiles) {
    if (anchors.length >= MAX_ANCHOR_MATCHES) break;
    if (parsed >= MAX_ANCHOR_PARSES) break;
    const fullPath = path.join(productsDir, file);
    let product: Product | null;
    try {
      product = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Product;
    } catch {
      continue;
    }
    parsed += 1;
    if (!product || !product.sku) continue;
    if (anchorsBySku.has(product.sku)) continue;
    const managed = appliedByMember[product.sku] ?? null;
    const liveRefs = extractSubproductSkus(product);
    const origin = managed ? 'managed_plan' : liveRefs.length > 0 ? 'native_reference' : 'catalog_scan';
    const familyPlanId = managed ? managed.plan.id : null;
    const familyMain = managed ? managed.plan.mainSku : null;
    const familyOrder = managed ? managed.order : liveRefs.length > 0 ? liveRefs : [];
    const familyRuleVersion = managed ? managed.plan.ruleVersion : null;
    const typeId = reviewedTypeIdFor(product);
    // GTIN evidence threads through the import query's source identifiers;
    // catalog-side GTIN extraction stays a later seam (fail closed: anchors
    // participate through SKU/blocking/name keys until then).
    const gtin: string | null = null;
    const anchor = buildCatalogJoinAnchor({
      product,
      familyPlanId,
      familyMain,
      familyOrder,
      familyRuleVersion,
      gtin,
      mpn: mpnFor(product),
      reviewedProductTypeId: typeId,
      model: modelFor(product),
      origin,
    });
    // Stamp the resolved rule for configured blocking (catalog rows without
    // a family plan resolve through the configured type identity).
    const resolved = ruleVersionFor(typeId, familyRuleVersion);
    if (resolved) {
      anchor.blockingRule = resolved;
      if (!anchor.familyRuleVersion) anchor.familyRuleVersion = resolved;
    }
    // Real token gate (#370): when a query is bound, a catalog_scan anchor
    // reaches discovery only through an equality key (SKU identity, source
    // identifier, or configured type/rule/brand block). Managed-plan and
    // native-reference anchors always pass (reviewed membership / live refs
    // are authority, not similarity).
    if (hasQuery && origin === 'catalog_scan') {
      const skuHit = query!.normalizedSku != null && query!.normalizedSku.length > 0 && anchor.normalizedSku === query!.normalizedSku;
      const idHit = anchor.sourceIdentifiers.some((id) => wantIdentifiers.has(id.toLowerCase()));
      const normalizedQueryBrand = (query!.brand ?? '').trim().toLowerCase().replace(/\s+/g, '');
      const brandHit = normalizedQueryBrand.length > 0 &&
        anchor.blockingBrand.length > 0 && anchor.blockingBrand === normalizedQueryBrand;
      const typeHit = query!.reviewedProductTypeId != null && query!.reviewedProductTypeId.length > 0 && anchor.blockingTypeId === query!.reviewedProductTypeId;
      const ruleHit = query!.ruleVersion != null && query!.ruleVersion.length > 0 && anchor.blockingRule === query!.ruleVersion;
      if (!skuHit && !idHit && !brandHit && !typeHit && !ruleHit) continue;
    }
    // Same-SKU marking happens per-query in resolveJoinCandidates; the
    // anchor records the catalog-side normalized identity for equality.
    anchors.push(anchor);
    anchorsBySku.set(product.sku, anchor);
  }
  return { anchors, anchorsBySku };
}
