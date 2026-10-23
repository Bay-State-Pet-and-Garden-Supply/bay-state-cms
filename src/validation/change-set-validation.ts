import { clearValidationResults, listValidationResults, addValidationResult } from '../db/repositories/validation-repo';
import { resolveBaseFileName, findDuplicateFileNames, normalizeFileName } from '../shopsite/file-name';
import { listCatalogFilenameOwners } from '../db/repositories/product-index-repo';
import { findChangeSetById, listChangeSetItems, setItemValidationStatus, listConflictingDraftChangeSets, type ChangeSetItemRow } from '../db/repositories/change-set-repo';
import { validateProduct, type ValidationContext, type ValidationOptions } from './product-validation';
import { readStoreConfig, readProductFile } from '../git/workspace-files';
import { findWorkspace, findWorkspacePathById } from '../db/repositories/workspace-repo';
import { hasBlockingDriftForSkuExcludingChangeSet } from '../db/repositories/drift-repo';
import { getDb } from '../db/connection';
import { comparisonHashForProduct } from '../shopsite/catalog-comparison';
import { extractSubproductSkus, extractSubproductSkuOccurrences, hashNativeReferences } from '../shopsite/product-codec';
import { findCurationDataJsonById, findItemById } from '../db/repositories/onboarding-item-repo';
import { draftListingEvidenceHashes, draftVariantFactsFor, currentSourceAuthority } from '../classification/listing-evidence-currentness';
import { evaluateListingEvidenceGate } from '../classification/listing-evidence-gate';
import { getRun } from '../db/repositories/classification-run-repo';
import { validateReviewCompletionGate } from '../classification/review-completion-gate';
import { loadItemListingReadiness } from '../classification/item-listing-readiness';
import { evaluateListingCompletenessGate } from '../classification/listing-evidence-gate';
import { validateFamilyMemberOrigin } from '../classification/storefront-family-origin';
import { listStorefrontFamilyPlans, parseStorefrontFamilyPlan, type StorefrontFamilyPlanRow } from '../db/repositories/storefront-family-plan-repo';
import { validateStorefrontFamilyGroup, validateNonFoodFamilyGroup, type StorefrontFamilyIssue } from './storefront-family-validation';
import { FOOD_FAMILY_VARIANT_RULE_VERSION } from '../classification/family-variant-rule';
import { isManagedFamilyProduct, hasExplicitSubproductsClear, readManagedMembership } from '../shopsite/storefront-subproducts';
import { StorefrontFamilyPlanSchema } from '../shared/schemas/storefront-family';
import type { StorefrontFamilyPlan } from '../shared/schemas/storefront-family';
import type { Product } from '../shared/types';
import { GitClient } from '../git/git-client';
import { skuToProductFilePath } from '../git/product-file-path';
function onboardingDraftBinding(
  workspaceId: string,
  item: ChangeSetItemRow,
): { itemId: string; runId: string } | null {
  const draft = JSON.parse(item.draftJson) as { itemId?: unknown };
  const originItemId = typeof draft.itemId === 'string' && draft.itemId.trim() ? draft.itemId : null;
  if (!item.classificationRunId) {
    if (originItemId) throw new Error('The onboarding draft has no frozen run binding; prepare a fresh draft.');
    return null;
  }
  const run = getRun(item.classificationRunId);
  if (!run || run.workspaceId !== workspaceId || run.productSku !== item.sku) {
    throw new Error('The draft classification run is missing or belongs to another workspace or SKU.');
  }
  if (run.sourceKind === 'catalog_product') {
    if (originItemId) throw new Error('A catalog run cannot replace an onboarding draft origin.');
    return null;
  }
  if (!run.onboardingItemId || originItemId && originItemId !== run.onboardingItemId) {
    throw new Error('The draft run is not bound to its exact originating onboarding item.');
  }
  return { itemId: run.onboardingItemId, runId: run.id };
}


/**
 * Immutable dep read (finding 6): approved file bytes at a commit, never
 * mutable worktree bytes. Null when the commit/file does not resolve.
 */
function readApprovedFileAtCommit(workspacePath: string, commitHash: string, sku: string): string | null {
  try {
    return new GitClient(workspacePath).readFileAtCommit(commitHash, skuToProductFilePath(sku));
  } catch {
    return null;
  }
}
function onboardingPriceAuthorityIssue(
  item: ChangeSetItemRow,
  product: Product,
  workspaceId: string,
): { code: string; message: string } | null {
  const baselines: Product[] = [];
  if (item.baseJson) {
    try {
      const baseline = JSON.parse(item.baseJson) as Product;
      if (!baseline?.core) throw new Error('Missing product core');
      baselines.push(baseline);
    } catch {
      return {
        code: 'ONBOARDING_PRICE_AUTHORITY_MISSING',
        message: 'We could not confirm the original price. Keep the amount entered when the product was added.',
      };
    }
  }

  const workspacePath = findWorkspacePathById(workspaceId);
  if (workspacePath) {
    try {
      const approved = readProductFile(workspacePath, item.sku);
      if (approved) baselines.push(approved);
    } catch {
      // A recorded base remains authoritative if a file cannot be read.
    }
  }

  if (item.operation !== 'create' && baselines.length === 0) {
    return {
      code: 'ONBOARDING_PRICE_AUTHORITY_MISSING',
      message: 'We could not confirm the original price. Keep the amount entered when the product was added.',
    };
  }
  if (baselines.some((baseline) =>
    product.core?.price !== baseline.core?.price ||
    product.core?.salePrice !== baseline.core?.salePrice
  )) {
    return {
      code: 'ONBOARDING_PRICE_IMMUTABLE',
      message: 'The price was entered during onboarding and must remain exactly the same.',
    };
  }
  if (item.operation === 'create' && product.core?.salePrice != null) {
    return {
      code: 'ONBOARDING_PRICE_IMMUTABLE',
      message: 'A new product can only use the price entered when it was added; a separate sale price cannot be set.',
    };
  }

  let binding: { itemId: string; runId: string } | null;
  try {
    binding = onboardingDraftBinding(workspaceId, item);
  } catch {
    return {
      code: 'ONBOARDING_PRICE_AUTHORITY_MISSING',
      message: 'We could not confirm the original price. Add this product through Add Products so it uses the amount you entered.',
    };
  }
  if (item.operation === 'create' && !binding) {
    return {
      code: 'ONBOARDING_PRICE_AUTHORITY_MISSING',
      message: 'New products must be added through Add Products so their price comes from your entry.',
    };
  }
  if (binding) {
    const onboardingItem = findItemById(binding.itemId);
    if (!onboardingItem) {
      return {
        code: 'ONBOARDING_PRICE_AUTHORITY_MISSING',
        message: 'We could not confirm the original price. Add this product through Add Products so it uses the amount you entered.',
      };
    }
    if (product.core?.price !== onboardingItem.price) {
      return {
        code: 'ONBOARDING_PRICE_IMMUTABLE',
        message: 'The product price must match the amount entered when the product was added.',
      };
    }
  }
  return null;
}


export interface ChangeSetValidationResult {
  total: number;
  blockers: number;
  warnings: number;
  infos: number;
  items: Array<{
    sku: string;
    operation: string;
    results: Array<{
      severity: string;
      code: string;
      message: string;
      fieldPath: string | null;
    }>;
  }>;
  canApprove: boolean;
}

/**
 * Validate all items in a change set.
 */
export function validateChangeSet(changeSetId: string, options?: ValidationOptions): ChangeSetValidationResult {
  const db = getDb();
  return db.transaction(() => {
    const changeSet = findChangeSetById(changeSetId);
    const items = listChangeSetItems(changeSetId);
  const allSkus = items.map(i => JSON.parse(i.draftJson)?.sku || i.sku).filter(Boolean);
  const effectiveOptions: ValidationOptions = { checkDrift: true, ...options };

  // Load health config to respect manager settings
  const ws = findWorkspace();
  const rulesConfig: Record<string, any> = {};
  if (ws?.workspacePath) {
    const config = readStoreConfig<{ rules: Array<{ code: string; severity: any }> }>(ws.workspacePath, 'health-config.json');
    if (config?.rules) {
      for (const r of config.rules) {
        rulesConfig[r.code] = r.severity;
      }
    }
  }

  const context: ValidationContext = {
    workspaceId: changeSet?.workspaceId ?? '',
    scopeType: 'change_set',
    scopeId: changeSetId,
    allSkus,
    rulesConfig,
  };

  // Clear previous validation results for this change set
  clearValidationResults('change_set', changeSetId);

  let totalBlockers = 0;
  let totalWarnings = 0;
  let totalInfos = 0;
  const itemResults: ChangeSetValidationResult['items'] = [];

  for (const item of items) {
    let product: Product;
    try {
      product = JSON.parse(item.draftJson) as Product;
    } catch {
      setItemValidationStatus(changeSetId, item.sku, 'blocked');
      itemResults.push({
        sku: item.sku,
        operation: item.operation,
        results: [{
          severity: 'blocker',
          code: 'PARSE_ERROR',
          message: 'Could not parse draft JSON for this product.',
          fieldPath: null,
        }],
      });
      totalBlockers++;
      continue;
    }

    // Check SKU change from base
    const baseSku = item.baseJson ? (JSON.parse(item.baseJson) as Product)?.sku : null;
    if (baseSku && baseSku !== product.sku) {
      clearValidationResults('change_set', changeSetId);
      // SKU change is a blocker - we'll just call addValidationResult from within validateProduct
    }

    const results = validateProduct(product, context, effectiveOptions);
    const priceIssue = onboardingPriceAuthorityIssue(item, product, changeSet?.workspaceId ?? '');
    if (priceIssue) {
      results.push(addValidationResult({
        scopeType: 'change_set',
        scopeId: changeSetId,
        severity: 'blocker',
        code: priceIssue.code,
        message: priceIssue.message,
        fieldPath: 'core.price',
      }));
    }
    const blockers = results.filter(r => r.severity === 'blocker').length;
    const warnings = results.filter(r => r.severity === 'warning').length;
    const infos = results.filter(r => r.severity === 'info').length;

    totalBlockers += blockers;
    totalWarnings += warnings;
    totalInfos += infos;

    setItemValidationStatus(changeSetId, item.sku, blockers > 0 ? 'blocked' : (warnings > 0 ? 'warning' : 'valid'));

    itemResults.push({
      sku: item.sku,
      operation: item.operation,
      results: results.map(r => ({
        severity: r.severity,
        code: r.code,
        message: r.message,
        fieldPath: r.fieldPath,
      })),
    });
  }

  // SKU change detection at change set level
  // Check if any item changed its SKU from base (synced SKU mutation check)
  for (const item of items) {
    if (item.baseJson) {
      try {
        const baseProduct = JSON.parse(item.baseJson) as Product;
        const draftProduct = JSON.parse(item.draftJson) as Product;
        if (baseProduct.sku !== draftProduct.sku && baseProduct.shopsite?.lastSyncedAt) {
          // SKU changed on a synced product - add blocker directly
              addValidationResult({
            scopeType: 'change_set',
            scopeId: changeSetId,
            severity: 'blocker',
            code: 'SYNCED_SKU_CHANGED',
            message: `Cannot change SKU of synced product from "${baseProduct.sku}" to "${draftProduct.sku}". Synced SKUs are immutable.`,
            fieldPath: 'sku',
          });
          totalBlockers++;
        }
      } catch { /* skip */ }
    }
  }

  // Issue #107: duplicate more-information page file names fail closed.
  // Sibling drafts whose effective <FileName> values collide (identical or
  // slug-colliding names, case-insensitive) would cross-link detail pages in
  // the live store. Unlike DUPLICATE_SKU (per-item via context.allSkus),
  // this needs the whole change set, so it lives here at the change-set level.
  try {
    const nameEntries: Array<{ key: string; fileName: string }> = [];
    for (const item of items) {
      try {
        const draft = JSON.parse(item.draftJson) as Product;
        if (draft?.sku) nameEntries.push({ key: draft.sku, fileName: resolveBaseFileName(draft) });
      } catch { /* unparseable drafts already recorded as PARSE_ERROR above */ }
    }
    for (const group of findDuplicateFileNames(nameEntries)) {
      addValidationResult({
        scopeType: 'change_set',
        scopeId: changeSetId,
        severity: 'blocker',
        code: 'DUPLICATE_FILENAME',
        message: `More-information page file name "${group.fileName}" is shared by ${group.keys.length} products (${group.keys.join(', ')}). Give each product a distinct file name before approval.`,
        fieldPath: null,
      });
      // Mirror a pointer onto each member item: per-item surfaces render
      // itemResults[].results, which would otherwise stay green while the
      // change set cannot approve. Member items are marked blocked.
      for (const sku of group.keys) {
        const member = itemResults.find(i => i.sku === sku);
        if (!member) continue;
        const row = addValidationResult({
          scopeType: 'change_set',
          scopeId: changeSetId,
          severity: 'blocker',
          code: 'DUPLICATE_FILENAME',
          message: `More-information page file name "${group.fileName}" is shared with another product in this change set. Give each product a distinct file name before approval.`,
          fieldPath: null,
        });
        member.results.push({
          severity: row.severity,
          code: row.code,
          message: row.message,
          fieldPath: row.fieldPath,
        });
        setItemValidationStatus(changeSetId, sku, 'blocked');
      }
    }
  } catch (err) {
    // Issue #106: filename-check failures are blockers — never swallowed.
    addValidationResult({
      scopeType: 'change_set',
      scopeId: changeSetId,
      severity: 'blocker',
      code: 'FILENAME_CHECK_FAILED',
      message: `Filename validation could not complete: ${err instanceof Error ? err.message : String(err)}. Resolve before approval.`,
      fieldPath: null,
    });
  }

  // Issue #106 SEQUENCE 2c: validate the change-set overlay against
  // UNTOUCHED catalog ownership (change-set-only is rejected). A draft
  // claiming a catalog name owned by a different SKU blocks closed;
  // same-SKU ownership is a self-update and stays clear.
  try {
    const catalogOwners = new Map<string, string>();
    try {
      for (const { sku, fileName } of listCatalogFilenameOwners()) {
        const key = fileName.toLowerCase();
        if (!catalogOwners.has(key)) catalogOwners.set(key, sku);
      }
    } catch {
      // Minimal DBs without the catalog index: overlay covers nothing.
    }
    for (const item of items) {
      let draft: Product;
      try {
        draft = JSON.parse(item.draftJson) as Product;
      } catch {
        continue; // PARSE_ERROR already recorded per item above.
      }
      const draftSku = draft?.sku || item.sku;
      let effective: string | null = null;
      try {
        effective = normalizeFileName(resolveBaseFileName(draft));
      } catch {
        continue;
      }
      if (!effective) continue;
      const ownerSku = catalogOwners.get(effective.toLowerCase());
      if (ownerSku && ownerSku !== draftSku) {
        const row = addValidationResult({
          scopeType: 'change_set',
          scopeId: changeSetId,
          severity: 'blocker',
          code: 'CATALOG_FILENAME_COLLISION',
          message: `More-information page file name "${effective}" is owned by catalog product ${ownerSku}. Give ${draftSku} a distinct file name before approval.`,
          fieldPath: null,
        });
        const member = itemResults.find(i => i.sku === item.sku);
        if (member) {
          member.results.push({
            severity: row.severity,
            code: row.code,
            message: row.message,
            fieldPath: row.fieldPath,
          });
          setItemValidationStatus(changeSetId, item.sku, 'blocked');
        }
      }
    }
   } catch (err) {
     addValidationResult({
       scopeType: 'change_set',
       scopeId: changeSetId,
       severity: 'blocker',
       code: 'FILENAME_CHECK_FAILED',
       message: `Catalog filename overlay could not complete: ${err instanceof Error ? err.message : String(err)}. Resolve before approval.`,
       fieldPath: null,
     });
   }

  // Issue #363: whole-group structural precheck — LINKED OPERATIONS ONLY.
  // Linked means any structural Subproducts dependency in the operation
  // (member-to-member write mesh OR member-to-non-member read dep). A
  // parent-only update over live children still runs the precheck so stale
  // bases, missing refs, and drift on reads refuse. Only change sets with
  // zero Subproducts references anywhere skip the group gate.
  // Worker366's listing-evidence anchor below is intentionally untouched.
  const parsedForLinkCheck: Record<string, Product> = {};
  for (const item of items) {
    try {
      parsedForLinkCheck[item.sku] = JSON.parse(item.draftJson) as Product;
    } catch { /* unparseable drafts already recorded as PARSE_ERROR above */ }
  }
  const isLinkedGroup = Object.entries(parsedForLinkCheck).some(([sku, draft]) =>
    extractSubproductSkus(draft).some((ref) => ref !== sku),
  );
  // Onboarding releases use their exact frozen origin, never the latest
  // import with the same SKU. Ordinary manual/catalog drafts stay separate.
  for (const item of items) {
    let gate: { code: string; reason: string } | null = null;
    try {
      const workspaceId = changeSet?.workspaceId ?? '';
      const binding = onboardingDraftBinding(workspaceId, item);
      if (!binding) continue;
      const reviewed = validateReviewCompletionGate({
        workspaceId,
        onboardingItemId: binding.itemId,
        productSku: item.sku,
        activeRunId: binding.runId,
      });
      if (!reviewed.ok) {
        gate = reviewed;
      } else {
        const product = JSON.parse(item.draftJson) as Product;
        const draftTitle = typeof product.core?.name === 'string' ? product.core.name : null;
        const draftDescription = typeof product.core?.description === 'string' ? product.core.description : null;
        const draftWeight = typeof product.core?.weight === 'string' ? product.core.weight : null;
        const variantFacts = draftVariantFactsFor(binding.itemId, draftWeight);
        const projection = { title: draftTitle, description: draftDescription, variantFacts, product };
        const completeness = evaluateListingCompletenessGate(
          loadItemListingReadiness(workspaceId, binding.itemId, projection).evaluation,
        );
        if (!completeness.ok) {
          gate = completeness;
        } else {
          const rawCuration = findCurationDataJsonById(binding.itemId);
          const curation = rawCuration ? JSON.parse(rawCuration) as Record<string, unknown> : null;
          const hashes = draftListingEvidenceHashes(binding.itemId, projection, {
            workspacePath: ws?.workspacePath,
            workspaceId,
          });
          const evaluated = evaluateListingEvidenceGate({
            curationData: curation,
            currentListingHash: hashes.listingHash,
            currentEvidenceHash: hashes.evidenceHash,
            currentModelPolicyDigest: hashes.modelPolicyDigest,
            currentRequiredFields: hashes.requiredFields,
            currentSourceAuthority: currentSourceAuthority(binding.itemId),
          });
          if (!evaluated.ok) gate = evaluated;
        }
      }
    } catch (error) {
      gate = {
        code: 'ONBOARDING_DRAFT_AUTHORITY_UNAVAILABLE',
        reason: error instanceof Error ? error.message : 'The exact onboarding draft authority could not be verified.',
      };
    }
    if (!gate) continue;
    const row = addValidationResult({
      scopeType: 'change_set',
      scopeId: changeSetId,
      severity: 'blocker',
      code: 'LISTING_EVIDENCE_UNRESOLVED',
      message: `SKU ${item.sku}: release refused (${gate.code}): ${gate.reason}`,
      fieldPath: null,
    });
    const member = itemResults.find(result => result.sku === item.sku);
    if (member) {
      member.results.push({
        severity: row.severity,
        code: row.code,
        message: row.message,
        fieldPath: row.fieldPath,
      });
    }
    setItemValidationStatus(changeSetId, item.sku, 'blocked');
  }
  // Family-linked change sets (including reference-free dissolutions) must
  // reach the adopted-family gate below: the standalone return would skip
  // origin/run-binding validation for drafts with no Subproducts references.
  const familyLinked = (() => {
    try {
      return listStorefrontFamilyPlans(changeSet?.workspaceId ?? '').some((row) => {
        try {
          return parseStorefrontFamilyPlan(row.planJson).linkedChangeSetId === changeSetId ||
            row.linkedChangeSetId === changeSetId;
        } catch {
          return row.linkedChangeSetId === changeSetId;
        }
      });
    } catch {
      return false;
    }
  })();
  if (!isLinkedGroup && !familyLinked) {
    const standaloneResults = listValidationResults('change_set', changeSetId);
    const standaloneBlockers = standaloneResults.filter(r => r.severity === 'blocker').length;
    const standaloneWarnings = standaloneResults.filter(r => r.severity === 'warning').length;
    const standaloneInfos = standaloneResults.filter(r => r.severity === 'info').length;
    return {
      total: items.length,
      blockers: standaloneBlockers,
      warnings: standaloneWarnings,
      infos: standaloneInfos,
      items: itemResults,
      canApprove: standaloneBlockers === 0,
    };
  }
  try {
    const precheck = precheckLinkedConsistencyGroup(changeSetId);
    for (const issue of precheck.issues) {
      const row = addValidationResult({
        scopeType: 'change_set',
        scopeId: changeSetId,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        fieldPath: issue.fieldPath,
      });
      const sku = issue.sku;
      if (sku) {
        const member = itemResults.find((i) => i.sku === sku);
        if (member && issue.severity === 'blocker') {
          member.results.push({
            severity: row.severity,
            code: row.code,
            message: row.message,
            fieldPath: row.fieldPath,
          });
          setItemValidationStatus(changeSetId, sku, 'blocked');
        }
      }
    }
  } catch (err) {
    addValidationResult({
      scopeType: 'change_set',
      scopeId: changeSetId,
      severity: 'blocker',
      code: 'LINKED_PRECHECK_FAILED',
      message: `Linked-group precheck could not complete: ${err instanceof Error ? err.message : String(err)}. Resolve before approval.`,
      fieldPath: null,
    });
  }
  // Issue #368: adopted-family whole-group gate. Change sets staged by an
  // accepted StorefrontFamilyPlan must carry exactly the planned managed
  // group: identical member set, single managed Subproducts block per
  // member covering exactly the planned set, deterministic PF7 proposals
  // on every member. Any member/rule/base/draft drift blocks the whole
  // family — no partial local commit. Plans are listing-owned; the
  // classifier path is never consulted here.
  try {
    const familyGate = validateAdoptedFamilyChangeSet(changeSetId, items);
    for (const issue of familyGate) {
      const row = addValidationResult({
        scopeType: 'change_set',
        scopeId: changeSetId,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        fieldPath: issue.fieldPath,
      });
      if (issue.sku) {
        const member = itemResults.find((i) => i.sku === issue.sku);
        if (member && issue.severity === 'blocker') {
          member.results.push({
            severity: row.severity,
            code: row.code,
            message: row.message,
            fieldPath: row.fieldPath,
          });
          setItemValidationStatus(changeSetId, issue.sku, 'blocked');
        }
      }
    }
  } catch (err) {
    addValidationResult({
      scopeType: 'change_set',
      scopeId: changeSetId,
      severity: 'blocker',
      code: 'FAMILY_GATE_FAILED',
      message: `Family gate could not complete: ${err instanceof Error ? err.message : String(err)}. Resolve before approval.`,
      fieldPath: null,
    });
  }
 

  // Re-fetch results after our additions
  const allResults = listValidationResults('change_set', changeSetId);
  totalBlockers = allResults.filter(r => r.severity === 'blocker').length;
  totalWarnings = allResults.filter(r => r.severity === 'warning').length;
  totalInfos = allResults.filter(r => r.severity === 'info').length;

  return {
    total: items.length,
    blockers: totalBlockers,
    warnings: totalWarnings,
    infos: totalInfos,
    items: itemResults,
    canApprove: totalBlockers === 0,
  };
  })();
}
// ── Issue #368 adopted-family change-set gate ───────────────────────────────

/**
 * Whole-group family gate for change sets staged by an accepted
 * StorefrontFamilyPlan. The linking plan is listing-owned: the change set
 * under validation must carry exactly the planned managed group — same
 * member set, deterministic PF7 proposals, single managed Subproducts
 * block per member. Verifies through `validateStorefrontFamilyGroup` on
 * managed-materialized drafts so pre-mutation drafts and post-commit files
 * agree. Change sets with no linking plan pass through (non-family drafts
 * keep raw preservation untouched). Never throws: unresolvable members or
 * unparseable drafts return blockers.
 */
export function validateAdoptedFamilyChangeSet(
  changeSetId: string,
  items: Array<{ sku: string; draftJson: string; baseJson: string | null }>,
): StorefrontFamilyIssue[] {
  const issues: StorefrontFamilyIssue[] = [];
  const block = (code: string, message: string, sku: string | null = null, fieldPath: string | null = null): void => {
    issues.push({ severity: 'blocker', code, message, fieldPath, sku });
  };
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) {
    block('FAMILY_CHANGE_SET_MISSING', 'Change set not found; cannot validate an adopted family group.');
    return issues;
  }
  let plans: StorefrontFamilyPlanRow[];
  try {
    plans = listStorefrontFamilyPlans(changeSet.workspaceId);
  } catch {
    block('FAMILY_PLAN_UNRESOLVABLE', 'Family plans are unresolvable for this workspace; refusing approval until the store resolves.');
    return issues;
  }
  const linking = plans.filter((row) => {
    try {
      return parseStorefrontFamilyPlan(row.planJson).linkedChangeSetId === changeSetId;
    } catch {
      return false;
    }
  });
  if (linking.length === 0) return issues;
  if (linking.length > 1) {
    block('FAMILY_MULTIPLE_PLANS', 'More than one family plan links this change set; one change set carries exactly one family.');
    return issues;
  }
  let plan: StorefrontFamilyPlan;
  try {
    plan = parseStorefrontFamilyPlan(linking[0]!.planJson);
  } catch {
    block('FAMILY_PLAN_UNREADABLE', 'The linking family plan is unreadable; refusing approval.');
    return issues;
  }
  // Applied plans are history: re-validation of an approved/recovered commit
  // matches on the recorded appliedCommit. Anything else must be currently
  // accepted; draft staging never applies — applied exists only via the
  // approval/recovery completion that also landed the approved commit.
  if (plan.status === 'applied') {
    if (!plan.appliedCommit || plan.appliedCommit !== changeSet.approvedCommit ||
      !['approved', 'pushed'].includes(changeSet.status)) {
      block('FAMILY_PLAN_NOT_ACCEPTED', 'The applied family plan does not match this approved commit.');
      return issues;
    }
  } else if (plan.status !== 'accepted') {
    block('FAMILY_PLAN_NOT_ACCEPTED', 'The complete current family plan must be accepted before approval.');
    return issues;
  }
  const workspacePath = findWorkspacePathById(changeSet.workspaceId);
  if (!workspacePath) {
    block('FAMILY_ORIGIN_UNRESOLVABLE', 'The family workspace is unavailable; source origins cannot be verified.');
    return issues;
  }
  try {
    const changeSetItems = listChangeSetItems(changeSetId);
    const bindingsBySku = new Map(changeSetItems.map(item => [item.sku, item.classificationRunId]));
    const changedSkus = new Set(items.map((item) => item.sku));
    for (const member of plan.members) {
      const origin = validateFamilyMemberOrigin({
        workspaceId: changeSet.workspaceId,
        workspacePath,
        sku: member.sku,
        origin: member.origin,
      });
      if (!origin.ok) {
        block('FAMILY_ORIGIN_UNRESOLVABLE', `${origin.code}: ${origin.reason}`, member.sku);
      } else if (!origin.purchasable) {
        block('FAMILY_NOT_PURCHASABLE', 'The member has no current verified purchasability authority.', member.sku);
      } else if (member.origin?.kind === 'onboarding' && changedSkus.has(member.sku) &&
        (!bindingsBySku.has(member.sku) || bindingsBySku.get(member.sku) !== member.origin.runId)) {
        block('FAMILY_ORIGIN_MISMATCH', 'The changed member lost its exact onboarding run binding.', member.sku);
      } else if (member.origin?.kind === 'catalog' && changedSkus.has(member.sku) &&
        (!bindingsBySku.has(member.sku) || !member.origin.classificationRunId ||
          bindingsBySku.get(member.sku) !== member.origin.classificationRunId)) {
        block('FAMILY_ORIGIN_MISMATCH', 'The changed member lost its exact approved catalog classification run binding.', member.sku);
      }
    }
  } catch {
    block('FAMILY_ORIGIN_UNRESOLVABLE', 'The complete member source-origin check could not finish.');
  }
  if (issues.length > 0) return issues;
  const parsed = new Map<string, Product>();
  for (const item of items) {
    try {
      parsed.set(item.sku, JSON.parse(item.draftJson) as Product);
    } catch {
      block('FAMILY_DRAFT_UNPARSEABLE', `Could not parse draft JSON for "${item.sku}"; the whole family blocks.`, item.sku);
    }
  }
  if (issues.length > 0) return issues;
  const rawPlan = linking[0]!.planJson;
  const change = readPlanChange(rawPlan);
  // Sub-validators push blockers through `block` (the gate's array) and
  // return their local array — merge both, otherwise blockers pushed via
  // `block` inside removal/dissolution are silently discarded.
  if (change?.kind === 'dissolve_family') {
    const sub = validateDissolutionChangeSet(plan, parsed, block);
    return [...issues, ...sub];
  }
  if (change?.kind === 'remove_members') {
    const sub = validateRemovalChangeSet(plan, change.remainingSkus, change.removedSkus, parsed, block);
    return [...issues, ...sub];
  }
  // Completeness over writes+reads for join plans (#370): apply stages only
  // necessary writes (delta shape — import create + main managed-block
  // update); unchanged members ride as linked read dependencies, never
  // rewritten. The staged set plus the draft-resolved read deps must cover
  // exactly the planned group — no missing member, no extra SKU. Adopt
  // plans (full-group writes, no join origin) keep the exact-write match.
  const plannedSet = [...plan.memberSkus].sort();
  const stagedSet = [...parsed.keys()].sort();
  const isJoinPlan = plan.joinOrigin != null;
  if (isJoinPlan) {
    const draftRefs: Record<string, true> = {};
    for (const draft of parsed.values()) {
      for (const ref of extractSubproductSkus(draft)) draftRefs[ref] = true;
    }
    const covered: Record<string, true> = {};
    for (const sku of stagedSet) covered[sku] = true;
    for (const ref of Object.keys(draftRefs)) {
      if ((plannedSet as string[]).includes(ref)) covered[ref] = true;
    }
    const coveredList = Object.keys(covered).sort();
    if (coveredList.length !== plannedSet.length || plannedSet.some((sku, i) => sku !== coveredList[i])) {
      block(
        'FAMILY_GROUP_INCOMPLETE',
        `Change set carries (${stagedSet.join(', ') || 'none'}) but plan "${plan.id.slice(0, 8)}" requires exactly (${plannedSet.join(', ')}); any missing member blocks the family — no partial commit.`,
      );
      return issues;
    }
  } else if (plannedSet.length !== stagedSet.length || plannedSet.some((sku, i) => sku !== stagedSet[i])) {
    block(
      'FAMILY_GROUP_INCOMPLETE',
      `Change set carries (${stagedSet.join(', ') || 'none'}) but plan "${plan.id.slice(0, 8)}" requires exactly (${plannedSet.join(', ')}); any missing member blocks the family — no partial commit.`,
    );
    return issues;
  }
  // Emitted-membership gate (#368): validate the representation the
  // encoder actually emits, not just the preserved raw block. The raw-first
  // checks above assert the submitted native posture; the checks below
  // assert the managed markers (member-SKU membership the encoder builds
  // the exported block from) with multiplicity — raw/member agreement,
  // exact accepted membership, self-inclusion, and no duplicates. A raw
  // block naming A,B,C with markers for only A,B refuses here instead of
  // silently omitting C at export.
  const mainDraft = parsed.get(plan.mainSku);
  if (!mainDraft) {
    block('FAMILY_GROUP_INCOMPLETE', `Main "${plan.mainSku}" has no staged draft; the whole family blocks.`, plan.mainSku);
    return issues;
  }
  const mainOccurrences = extractSubproductSkuOccurrences(mainDraft);
  if (new Set(mainOccurrences).size !== mainOccurrences.length) {
    const dupes = [...new Set(mainOccurrences.filter((sku, i) => mainOccurrences.indexOf(sku) !== i))].sort();
    block('FAMILY_MAIN_DUPLICATED', `Main "${plan.mainSku}" lists ${dupes.map((d) => `"${d}"`).join(', ')} more than once; the main appears exactly once.`, plan.mainSku, 'shopsite.preserved.advancedBlocks');
  }
  const mainRawSet = new Set(extractSubproductSkus(mainDraft));
  if (mainRawSet.size !== plannedSet.length || !plannedSet.every((sku) => mainRawSet.has(sku))) {
    block(
      'FAMILY_MAIN_SELF_MEMBERSHIP',
      `Main "${plan.mainSku}" submitted Subproducts must reference exactly the accepted member set (${plannedSet.join(', ')}); got (${[...mainRawSet].sort().join(', ') || 'none'}).`,
      plan.mainSku,
      'shopsite.preserved.advancedBlocks',
    );
  }
  if (!mainRawSet.has(plan.mainSku)) {
    block('FAMILY_SELF_REFERENCE_MISSING', `Main "${plan.mainSku}" must list itself as its own Subproduct so its size stays purchasable.`, plan.mainSku, 'shopsite.preserved.advancedBlocks');
  }
  const managed = readManagedMembership(mainDraft);
  if (!managed) {
    block('FAMILY_MAIN_SELF_MEMBERSHIP', `Main "${plan.mainSku}" carries no managed-family membership markers; the encoder would emit no managed block for the accepted set (${plannedSet.join(', ')}).`, plan.mainSku, 'shopsite.preserved.rawAttributes');
  } else {
    if (managed.familyId !== plan.id) {
      block('FAMILY_CONFLICTING_MEMBERSHIP', `Main "${plan.mainSku}" managed markers belong to family "${managed.familyId}", not plan "${plan.id}"; transitive merges are refused.`, plan.mainSku, 'shopsite.preserved.rawAttributes');
    }
    if (new Set(managed.memberSkus).size !== managed.memberSkus.length) {
      const dupes = [...new Set(managed.memberSkus.filter((sku, i) => managed.memberSkus.indexOf(sku) !== i))].sort();
      block('FAMILY_MAIN_DUPLICATED', `Main "${plan.mainSku}" managed markers list ${dupes.map((d) => `"${d}"`).join(', ')} more than once; the encoder would throw instead of emitting a duplicate — refusing approval.`, plan.mainSku, 'shopsite.preserved.rawAttributes');
    }
    const markerSet = new Set(managed.memberSkus);
    if (markerSet.size !== plannedSet.length || !plannedSet.every((sku) => markerSet.has(sku))) {
      block(
        'FAMILY_MAIN_SELF_MEMBERSHIP',
        `Main "${plan.mainSku}" managed markers must name exactly the accepted member set (${plannedSet.join(', ')}); got (${managed.memberSkus.join(', ') || 'none'}).`,
        plan.mainSku,
        'shopsite.preserved.rawAttributes',
      );
    }
    if (!markerSet.has(plan.mainSku)) {
      block('FAMILY_SELF_REFERENCE_MISSING', `Main "${plan.mainSku}" managed markers must include the main itself so its size stays purchasable.`, plan.mainSku, 'shopsite.preserved.rawAttributes');
    }
    const rawSorted = [...mainRawSet].sort();
    const markerSorted = [...markerSet].sort();
    if (rawSorted.length !== markerSorted.length || rawSorted.some((sku, i) => sku !== markerSorted[i])) {
      block(
        'FAMILY_MAIN_SELF_MEMBERSHIP',
        `Main "${plan.mainSku}" submitted raw refs (${rawSorted.join(', ') || 'none'}) disagree with managed markers (${markerSorted.join(', ') || 'none'}); approval validates the emitted representation, never one side alone.`,
        plan.mainSku,
        'shopsite.preserved.advancedBlocks',
      );
    }
  }
  for (const sku of plannedSet) {
    if (sku === plan.mainSku) continue;
    const staged = parsed.get(sku);
    if (!staged) continue;
    if (readManagedMembership(staged)) {
      block('FAMILY_CONFLICTING_MEMBERSHIP', `SKU "${sku}" carries managed-family markers; only the main "${plan.mainSku}" emits the managed block — other cycles refuse.`, sku, 'shopsite.preserved.rawAttributes');
    }
  }
  // Delta-write shape (#370): non-main member checks run only over STAGED
  // drafts. An unstaged read-dep member keeps its live native posture by
  // construction (apply never rewrote it); dereferencing its absent draft
  // would crash the gate instead of passing it.
  for (const sku of plannedSet) {
    if (sku === plan.mainSku) continue;
    const staged = parsed.get(sku);
    if (!staged) continue;
    const refs = extractSubproductSkus(staged).filter((r) => (plannedSet as string[]).includes(r));
    if (refs.length > 0) {
      block('FAMILY_CONFLICTING_MEMBERSHIP', `SKU "${sku}" hosts family member refs (${refs.join(', ')}); only the main "${plan.mainSku}" emits the managed block — other cycles refuse.`, sku, 'shopsite.preserved.advancedBlocks');
    }
  }
  if (issues.length > 0) return issues;
  // Validate the STORED drafts as written: apply already materialized the
  // managed block (main) + PF7-only shapes (non-mains) through the same
  // writer, so rebuilding here would validate a repair copy instead of the
  // actual representation. The mesh check reads the stored block/markers.
  // Delta-write shape (#370): unstaged read-dep members resolve from their
  // live approved base (unchanged by construction) so the full-group rule
  // still evaluates the complete family. A missing live base for an
  // unstaged member blocks — the group cannot prove completeness.
  const materialized: Product[] = [];
  for (const sku of plannedSet) {
    const draft = parsed.get(sku);
    if (!draft) {
      let liveBase: Product | null;
      try {
        const wsPath = findWorkspacePathById(changeSet.workspaceId);
        liveBase = wsPath ? readProductFile(wsPath, sku) : null;
      } catch {
        liveBase = null;
      }
      if (!liveBase) {
        block('FAMILY_GROUP_INCOMPLETE', `SKU "${sku}" is an unstaged read dependency with no live approved base; the whole family blocks.`, sku);
        continue;
      }
      materialized.push(liveBase);
      continue;
    }
    const pf7 = plan.pf7Proposals.find((p) => p.sku === sku)?.shortName;
    if (!pf7 || (draft.customFields['ProductField7'] ?? '').trim() !== pf7) {
      block('FAMILY_PF7_MISMATCH', `SKU "${sku}" draft PF7 does not match the accepted plan proposal; unreviewed payload rewrites refuse approval.`, sku, 'customFields.ProductField7');
      continue;
    }
    materialized.push(draft);
  }
  if (issues.length > 0) return issues;
  // #370: join plans carry their stamped rule version — food joins use the
  // food group check; non-food joins use their approved rule's group check
  // (the rule version is schema-typed on the plan, never an inline cast).
  if (plan.ruleVersion !== 'food-family-variant-rule-v1') {
    for (const issue of validateNonFoodFamilyGroup(plan.ruleVersion, plan.id, materialized, new Map())) {
      issues.push(issue);
    }
    return issues;
  }
  for (const issue of validateStorefrontFamilyGroup({ familyId: plan.id, members: materialized, bases: new Map() })) {
    issues.push(issue);
  }
  return issues;
}

/**
 * Read the #369 membership-change marker from the typed plan. Returns null
 * for new-family/adopt plans (no membership change — the existing gate path
 * runs untouched). Schema-typed now (`adoptionOrigin`/`membershipChange`
 * are explicit optional fields); unmarked plans fall through to the adopt
 * gate below. Never throws: corrupt markers refuse closed downstream.
 */
function readPlanChange(planJson: string): { kind: string; remainingSkus: string[]; removedSkus: string[] } | null {
  try {
    const plan = parseStorefrontFamilyPlan(planJson) as StorefrontFamilyPlan;
    const change = plan.membershipChange;
    if (!change) return null;
    if (change.kind !== 'remove_members' && change.kind !== 'dissolve_family') return null;
    return { kind: change.kind, remainingSkus: [...change.remainingSkus], removedSkus: [...change.removedSkus] };
  } catch {
    return null;
  }
}

/**
 * Gate for an explicit reviewed membership removal (#369): the change set
 * carries every remaining member (managed mesh over the remaining set,
 * PF7 proposals verbatim) PLUS every removed member (untouched PF7, no
 * managed markers, explicit empty clear block — omission never clears).
 * Unrelated native children/accessories and unknown blocks survive because
 * the drafts pass through untouched except the Subproducts slot.
 */
function validateRemovalChangeSet(
  plan: StorefrontFamilyPlan,
  remainingSkus: string[],
  removedSkus: string[],
  parsed: Map<string, Product>,
  block: (code: string, message: string, sku?: string | null, fieldPath?: string | null) => void,
): StorefrontFamilyIssue[] {
  const issues: StorefrontFamilyIssue[] = [];
  const expected = [...remainingSkus, ...removedSkus].sort();
  const staged = [...parsed.keys()].sort();
  if (expected.length !== staged.length || expected.some((sku, i) => sku !== staged[i])) {
    block(
      'FAMILY_GROUP_INCOMPLETE',
      `Removal change set carries (${staged.join(', ') || 'none'}) but the reviewed revision touches exactly (${expected.join(', ')}); any missing member blocks the family — no partial commit.`,
    );
    return issues;
  }
  // Validate the STORED remaining drafts as written (apply materialized the
  // managed block on the main); never rebuild a repair copy for validation.
  const materialized: Product[] = [];
  for (const sku of [...remainingSkus].sort()) {
    const draft = parsed.get(sku)!;
    const pf7 = plan.pf7Proposals.find((p) => p.sku === sku)?.shortName;
    if (!pf7 || (draft.customFields['ProductField7'] ?? '').trim() !== pf7) {
      block('FAMILY_PF7_MISMATCH', `SKU "${sku}" draft PF7 does not match the accepted plan proposal; unreviewed payload rewrites refuse approval.`, sku, 'customFields.ProductField7');
      continue;
    }
    materialized.push(draft);
  }
  for (const sku of [...removedSkus].sort()) {
    const draft = parsed.get(sku)!;
    const before = (draft.customFields['ProductField7'] ?? '').trim();
    // PF7 verbatim equality: a removed member's PF7 must equal its retained
    // proposal verbatim — removal preserves labels, never rewrites them.
    // Retained snapshots guarantee comparison authority exists; a missing
    // proposal refuses closed rather than passing with empty authority.
    const proposed = plan.pf7Proposals.find((pp) => pp.sku === sku)?.shortName ?? null;
    if (proposed === null) {
      block('FAMILY_PF7_MISSING', `Removed SKU "${sku}" has no retained PF7 proposal; removal comparison authority is required.`, sku, 'customFields.ProductField7');
    } else if (before !== proposed) {
      block(before.length === 0 ? 'FAMILY_PF7_MISSING' : 'FAMILY_PF7_MISMATCH', `Removed SKU "${sku}" draft PF7 does not match the accepted proposal verbatim; removal preserves labels, never rewrites them.`, sku, 'customFields.ProductField7');
    }
    if (isManagedFamilyProduct(draft)) {
      block('FAMILY_REMOVAL_STALE_MARKER', `Removed SKU "${sku}" still carries managed-family markers; removed members leave the family explicitly.`, sku);
    }
    if (!hasExplicitSubproductsClear(draft)) {
      block(
        'FAMILY_CLEAR_UNVERIFIED',
        `Removed SKU "${sku}" carries no explicit empty <Subproducts></Subproducts> clear; omitting a populated block is never assumed to clear.`,
        sku,
        'shopsite.preserved.advancedBlocks',
      );
    }
  }
  const outerCount = issues.length;
  if (outerCount > 0) return issues;
  // Route by the plan's stamped rule (#369 non-food adopted removals):
  // food remainders use the food group check; non-food remainders use
  // their approved rule's group check.
  if (plan.ruleVersion !== FOOD_FAMILY_VARIANT_RULE_VERSION) {
    for (const issue of validateNonFoodFamilyGroup(plan.ruleVersion, plan.id, materialized, new Map())) {
      issues.push(issue);
    }
    return [...issues.slice(0, outerCount), ...issues.slice(outerCount)];
  }
  for (const issue of validateStorefrontFamilyGroup({ familyId: plan.id, members: materialized, bases: new Map() })) {
    issues.push(issue);
  }
  return [...issues.slice(0, outerCount), ...issues.slice(outerCount)];
}

/**
 * Gate for an explicit reviewed dissolution (#369): every member carries an
 * explicit empty clear, keeps its PF7, and releases managed markers. No
 * family mesh remains to validate — the clear itself is the assertion.
 */
function validateDissolutionChangeSet(
  plan: StorefrontFamilyPlan,
  parsed: Map<string, Product>,
  block: (code: string, message: string, sku?: string | null, fieldPath?: string | null) => void,
): StorefrontFamilyIssue[] {
  const issues: StorefrontFamilyIssue[] = [];
  const expected = [...plan.memberSkus].sort();
  const staged = [...parsed.keys()].sort();
  if (expected.length !== staged.length || expected.some((sku, i) => sku !== staged[i])) {
    block(
      'FAMILY_GROUP_INCOMPLETE',
      `Dissolution change set carries (${staged.join(', ') || 'none'}) but the reviewed dissolution touches exactly (${expected.join(', ')}); any missing member blocks the family — no partial commit.`,
    );
    return issues;
  }
  for (const sku of expected) {
    const draft = parsed.get(sku)!;
    const before = (draft.customFields['ProductField7'] ?? '').trim();
    const proposed = plan.pf7Proposals.find((pp) => pp.sku === sku)?.shortName ?? null;
    if (proposed === null) {
      block('FAMILY_PF7_MISSING', `SKU "${sku}" has no retained PF7 proposal; dissolution comparison authority is required.`, sku, 'customFields.ProductField7');
    } else if (before !== proposed) {
      block(before.length === 0 ? 'FAMILY_PF7_MISSING' : 'FAMILY_PF7_MISMATCH', `SKU "${sku}" draft PF7 does not match the accepted proposal verbatim; dissolution preserves labels, never rewrites them.`, sku, 'customFields.ProductField7');
    }
    if (isManagedFamilyProduct(draft)) {
      block('FAMILY_REMOVAL_STALE_MARKER', `SKU "${sku}" still carries managed-family markers; dissolved members leave the family explicitly.`, sku);
    }
    if (!hasExplicitSubproductsClear(draft)) {
      block(
        'FAMILY_CLEAR_UNVERIFIED',
        `SKU "${sku}" carries no explicit empty <Subproducts></Subproducts> clear; omitting a populated block is never assumed to clear.`,
        sku,
        'shopsite.preserved.advancedBlocks',
      );
    }
  }
  return issues;
}
// ── Issue #363 whole-group structural precheck ─────────────────────────────

export interface LinkedPrecheckIssue {
  severity: 'blocker' | 'warning' | 'info';
  code: string;
  message: string;
  fieldPath: string | null;
  sku: string | null;
}

export interface LinkedPrecheckResult {
  ok: boolean;
  issues: LinkedPrecheckIssue[];
  changeSkus: string[];
  readSkus: string[];
}

/**
 * Whole-group pre-mutation gate for the linked/consistency-group approval
 * path (issue #363): stale bases, conflicting drafts, references,
 * relevant validation, and open+reconciling drift for the whole operation.
 * One invalid dep blocks the group. Pure read-only: never mutates drafts,
 * files, index, or Git. No model or family semantics.
 */
export function precheckLinkedConsistencyGroup(changeSetId: string): LinkedPrecheckResult {
  const issues: LinkedPrecheckIssue[] = [];
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) {
    return {
      ok: false,
      issues: [{
        severity: 'blocker', code: 'LINKED_GROUP_MISSING',
        message: 'Change set not found; cannot approve a missing linked operation.',
        fieldPath: null, sku: null,
      }],
      changeSkus: [], readSkus: [],
    };
  }
  const items = listChangeSetItems(changeSetId);
  const changeSkus = items.map((i) => i.sku).filter(Boolean).sort();
  if (items.length === 0) {
    issues.push({
      severity: 'blocker', code: 'LINKED_GROUP_EMPTY',
      message: `Change set "${changeSet.title}" carries no products; nothing approvable as a linked operation.`,
      fieldPath: null, sku: null,
    });
    return { ok: false, issues, changeSkus, readSkus: [] };
  }

  const dupes = changeSkus.filter((sku, i) => changeSkus.indexOf(sku) !== i);
  for (const sku of [...new Set(dupes)].sort()) {
    issues.push({
      severity: 'blocker', code: 'LINKED_GROUP_DUPLICATE_SKU',
      message: `SKU "${sku}" appears more than once in this linked operation; resolve duplicates before approval.`,
      fieldPath: 'sku', sku,
    });
  }

  const parsedDrafts = new Map<string, Product>();
  for (const item of items) {
    try {
      const draft = JSON.parse(item.draftJson) as Product;
      parsedDrafts.set(item.sku, draft);
      if (!draft.sku || draft.sku !== item.sku) {
        issues.push({
          severity: 'blocker', code: 'LINKED_GROUP_SKU_MISMATCH',
          message: `Item "${item.sku}" carries a draft for SKU "${draft.sku || '(missing)'}"; drafts must match their item SKU.`,
          fieldPath: 'sku', sku: item.sku,
        });
      }
    } catch {
      issues.push({
        severity: 'blocker', code: 'LINKED_GROUP_PARSE_ERROR',
        message: `Could not parse draft JSON for "${item.sku}".`,
        fieldPath: null, sku: item.sku,
      });
    }
  }

  // Conflicting drafts: a draft/reviewing foreign change set carrying any
  // group SKU — changed writes AND unchanged-member reads — blocks the whole
  // group (operator resolves first). Approved/pushed history never blocks.
  // Read deps resolve from the drafts below; when drafts are unparseable the
  // write set still gates and the parse blocker carries the failure.
  const earlyRefs = new Set<string>();
  for (const draft of parsedDrafts.values()) {
    try {
      for (const ref of extractSubproductSkus(draft)) earlyRefs.add(ref);
    } catch { /* unparseable draft already recorded; skip its refs */ }
  }
  const changeSkuSetEarly = new Set(changeSkus);
  const earlyReadSkus = [...earlyRefs].filter((ref) => !changeSkuSetEarly.has(ref));
  try {
    const conflicts = listConflictingDraftChangeSets(changeSet.workspaceId, [...new Set([...changeSkus, ...earlyReadSkus])].sort(), changeSetId);
    for (const c of conflicts) {
      issues.push({
        severity: 'blocker', code: 'LINKED_GROUP_CONFLICTING_DRAFT',
        message: `SKU "${c.sku}" is also staged in change set ${c.changeSetId.slice(0, 8)} (status "${c.status}"); resolve the competing draft before approving this group.`,
        fieldPath: 'sku', sku: c.sku,
      });
    }
  } catch (err) {
    issues.push({
      severity: 'blocker', code: 'LINKED_CONFLICT_CHECK_FAILED',
      message: `Conflicting-draft check could not complete: ${err instanceof Error ? err.message : String(err)}.`,
      fieldPath: null, sku: null,
    });
  }

  // Unchanged-member read deps from native Subproducts references: every
  // SKU referenced by a changed product that is NOT itself changed is a
  // read dependency. Self-parent references are harmless (already in the
  // change set); any other reference cycle through changed members blocks
  // closed. Missing-read-dep evidence resolves below, after the workspace
  // path guard (the approved file is the entry signal when the index cache
  // has no row yet).
  // Issue #368 exemption (fail closed): an edge is exempt only when both
  // ends are members of the SAME plan, that plan validates against
  // StorefrontFamilyPlanSchema, its row status and JSON status are both
  // accepted|applied and agree, and the row-level linked_change_set_id
  // agrees with the JSON linkedChangeSetId claim. Multiple plans linking
  // the change set grant no exemption (mirrors the adopted-family gate's
  // FAMILY_MULTIPLE_PLANS blocker): never union across plans.
  // Unreadable/invalid/mismatched plans grant no exemption.
  // #369 note (live-awareness): the gate blocks only NEWLY-INTRODUCED
  // cycles — the draft cycle set minus the live cycle set. A reference
  // that exists live-unchanged excuses its own cycle: a plan-unlinked
  // price-only update over a live adopted mesh (A↔B both live and both
  // draft) introduces no new cycle and must pass. But a pre-existing
  // edge (e.g. PARENT-1→CHILD-A carried live) completed by a NEW reverse
  // edge (CHILD-A→PARENT-1) is a genuinely introduced 2-cycle and must
  // block. Only main→member edges of the linking plan (block-on-main-only
  // emission: the main's single managed block, main self-included exactly
  // once) are exempt on top of the live diff; every other draft edge among
  // changed members participates — other cycles refuse.
  const linkedFamilyMembers = new Set<string>();
  let linkedFamilyMain: string | null = null;
  try {
    const rows = listStorefrontFamilyPlans(changeSet.workspaceId);
    const claimants = rows.filter((row) => {
      try {
        return parseStorefrontFamilyPlan(row.planJson).linkedChangeSetId === changeSetId ||
          row.linkedChangeSetId === changeSetId;
      } catch {
        return row.linkedChangeSetId === changeSetId;
      }
    });
    if (claimants.length === 1) {
      const row = claimants[0]!;
      try {
        const parsed = StorefrontFamilyPlanSchema.safeParse(JSON.parse(row.planJson));
        if (
          parsed.success &&
          (parsed.data.status === 'accepted' || parsed.data.status === 'applied') &&
          (row.status === 'accepted' || row.status === 'applied') &&
          parsed.data.status === row.status &&
          parsed.data.linkedChangeSetId === changeSetId &&
          row.linkedChangeSetId === changeSetId &&
          parsed.data.workspaceId === changeSet.workspaceId
        ) {
          // #369: scope the mesh exemption to the CURRENT membership. A
          // removal revision demotes removed SKUs to cleared non-members, so
          // remaining→removed edges must NOT be exempt (the removed draft
          // must clear AND the live ref must not resurrect it).
          // #370: join plans carry the full group in memberSkus (existing +
          // joined) — the main's single managed block over that set is exempt.
          const current = parsed.data.membershipChange?.kind === 'remove_members'
            ? parsed.data.membershipChange.remainingSkus
            : parsed.data.memberSkus;
          for (const sku of current) linkedFamilyMembers.add(sku);
          linkedFamilyMain = parsed.data.mainSku;
        }
      } catch {
        // Unreadable plan grants no exemption.
      }
    }
  } catch {
    // Unresolvable plans grant no exemption.
  }
  const inMesh: Record<string, true> = {};
  for (const sku of linkedFamilyMembers) inMesh[sku] = true;
  // Block-on-main-only (#368): an edge is mesh-exempt only when it runs
  // OUT of the linking plan's main into a current member (the main's single
  // block) AND the main's emitted block is exactly the compliant managed
  // shape — the current member set with the main self-included exactly
  // once. A full 2-cycle (main↔member) or a non-compliant main block grants
  // no exemption: the non-main edge still participates and still refuses.
  // Member→member and member→main edges always participate.
  let mainBlockCompliant = false;
  if (linkedFamilyMain !== null && !!inMesh[linkedFamilyMain]) {
    const mainDraft = parsedDrafts.get(linkedFamilyMain);
    if (mainDraft) {
      const occurrences = extractSubproductSkuOccurrences(mainDraft);
      const selfCount = occurrences.filter((sku) => sku === linkedFamilyMain).length;
      const emitted = extractSubproductSkus(mainDraft).filter((ref) => !!inMesh[ref]);
      const emittedSet: Record<string, true> = {};
      for (const ref of emitted) emittedSet[ref] = true;
      const memberList = [...linkedFamilyMembers].sort();
      mainBlockCompliant =
        selfCount === 1 &&
        emitted.length === memberList.length &&
        memberList.every((sku) => !!emittedSet[sku]);
    }
  }
  const meshExempt = (from: string, to: string): boolean =>
    mainBlockCompliant && linkedFamilyMain !== null && from === linkedFamilyMain && !!inMesh[to];
  const changeSkuSet = new Set(changeSkus);
  const allRefs = new Set<string>();
  for (const draft of parsedDrafts.values()) {
    for (const ref of extractSubproductSkus(draft)) allRefs.add(ref);
  }
  const readSkus = [...allRefs].filter((ref) => !changeSkuSet.has(ref)).sort();
  const draftBySku = new Map<string, Product>(parsedDrafts);
  // Live adjacency over the same changed-member subgraph (same self and
  // mesh filters): a draft cycle whose every edge already exists live is
  // pre-existing, not newly introduced, and does not block. Any cycle
  // containing at least one new edge blocks.
  const liveBySku = new Map<string, Product>();
  try {
    const liveWsPath = findWorkspacePathById(changeSet.workspaceId);
    if (liveWsPath) {
      for (const sku of changeSkus) {
        try {
          const live = readProductFile(liveWsPath, sku);
          if (live) liveBySku.set(sku, live);
        } catch {
          // Unreadable live file contributes no edges (fail closed: the
          // draft cycle then counts as new).
        }
      }
    }
  } catch {
    // Unresolvable live state contributes no edges (fail closed).
  }
  const liveAdj = new Map<string, Set<string>>();
  for (const sku of changeSkus) {
    const live = liveBySku.get(sku);
    const refs = live ? extractSubproductSkus(live) : [];
    liveAdj.set(sku, new Set(refs.filter((ref) => ref !== sku && changeSkuSet.has(ref) && !meshExempt(sku, ref))));
  }
  for (const sku of changeSkus) {
    const draft = draftBySku.get(sku);
    if (!draft) continue;
    // Path-stack DFS: only a repeat on the current path is a cycle, so
    // diamond DAGs (A->{B,C}, B->D, C->D) do not false-positive.
    // #368: intra-plan mesh edges (both ends in the linking plan) are
    // exempt — the managed full-mesh is intentional; unmanaged or
    // cross-family edges still participate and still block on cycles.
    // Self-parent references never participate (already in the set).
    const onPath = new Set<string>([sku]);
    const path: string[] = [sku];
    const stack: Array<{ ref: string; expanded: boolean }> = extractSubproductSkus(draft)
      .filter((ref) => ref !== sku && changeSkuSet.has(ref) && !meshExempt(sku, ref))
      .map((ref) => ({ ref, expanded: false }));
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (!frame.expanded) {
        if (onPath.has(frame.ref)) {
          // Closed draft cycle: path from first occurrence of frame.ref
          // through the current tip, plus the back edge onto frame.ref.
          const start = path.indexOf(frame.ref);
          const loop = start >= 0 ? path.slice(start).concat(frame.ref) : [frame.ref, frame.ref];
          let preexisting = true;
          for (let e = 0; e + 1 < loop.length; e++) {
            if (!liveAdj.get(loop[e]!)?.has(loop[e + 1]!)) { preexisting = false; break; }
          }
          if (preexisting) continue;
          issues.push({
            severity: 'blocker', code: 'LINKED_GROUP_REFERENCE_CYCLE',
            message: `Subproducts reference cycle through "${frame.ref}"; remove the cycle before approving the group.`,
            fieldPath: 'shopsite.preserved.advancedBlocks', sku,
          });
          break;
        }
        onPath.add(frame.ref);
        path.push(frame.ref);
        stack.push({ ref: frame.ref, expanded: true });
        const refDraft = draftBySku.get(frame.ref);
        if (refDraft) {
          for (const next of extractSubproductSkus(refDraft)) {
            if (next !== frame.ref && changeSkuSet.has(next) && !meshExempt(frame.ref, next)) stack.push({ ref: next, expanded: false });
          }
        }
      } else {
        onPath.delete(frame.ref);
        const tip = path.lastIndexOf(frame.ref);
        if (tip >= 0) path.splice(tip, 1);
      }
    }
  }

  // Stale bases: the recorded base must still equal live approved state
  // (comparison hash + native references). Later edits stale authority. The
  // check resolves THIS change set's workspace (fail closed when the
  // workspace row is unresolvable), never the global workspace.
  const workspacePath = findWorkspacePathById(changeSet.workspaceId);
  if (!workspacePath) {
    issues.push({
      severity: 'blocker', code: 'LINKED_GROUP_WORKSPACE_UNRESOLVABLE',
      message: `Workspace for change set "${changeSet.title}" is unresolvable; refusing approval until the workspace resolves.`,
      fieldPath: null, sku: null,
    });
    return { ok: false, issues, changeSkus, readSkus };
  }
  for (const item of items) {
    const draft = parsedDrafts.get(item.sku);
    if (!draft || !item.baseJson) continue;
    try {
      const recorded = JSON.parse(item.baseJson) as Product;
      const live = readProductFile(workspacePath, item.sku);
      if (!live) {
        issues.push({
          severity: 'blocker', code: 'LINKED_GROUP_STALE_BASE',
          message: `SKU "${item.sku}" has no live approved file (deleted after staging); re-stage before approving the group.`,
          fieldPath: null, sku: item.sku,
        });
        continue;
      }
      const baseStale = comparisonHashForProduct(recorded) !== comparisonHashForProduct(live);
      const nativeStale = hashNativeReferences(recorded) !== hashNativeReferences(live);
      if (baseStale) {
        issues.push({
          severity: 'blocker', code: 'LINKED_GROUP_STALE_BASE',
          message: `SKU "${item.sku}" changed after this change set was staged (stale base); re-stage before approving the group.`,
          fieldPath: null, sku: item.sku,
        });
      } else if (nativeStale) {
        issues.push({
          severity: 'blocker', code: 'LINKED_GROUP_STALE_NATIVE_REF',
          message: `SKU "${item.sku}" native Subproducts changed after staging; re-stage before approving the group.`,
          fieldPath: 'shopsite.preserved.advancedBlocks', sku: item.sku,
        });
      }
    } catch (err) {
      issues.push({
        severity: 'blocker', code: 'LINKED_GROUP_STALE_BASE',
        message: `SKU "${item.sku}" base comparison could not complete (${err instanceof Error ? err.message : String(err)}); re-stage before approving the group.`,
        fieldPath: null, sku: item.sku,
      });
    }
  }
  // Missing/unapproved read deps block closed (finding 6): every unchanged
  // referenced SKU must have approved content at this group's base commit —
  // the immutable content the manifest will bind. A worktree-only file with
  // no commit entry (uncommitted child edit) refuses here, before mutation,
  // instead of hashing uncommitted bytes into the manifest. The
  // product-index row is a derived cache that can lag (fresh databases,
  // baseline-only setups), so commit content is the entry signal.
  const wsBaseCommit = changeSet.baseCommit || null;
  for (const ref of readSkus) {
    // Fail closed when the approved-commit read is unreadable.
    const approvedAtBase = (() => {
      try {
        return workspacePath != null && wsBaseCommit != null && readApprovedFileAtCommit(workspacePath, wsBaseCommit, ref) !== null;
      } catch {
        return false;
      }
    })();
    if (!approvedAtBase) {
      issues.push({
        severity: 'blocker', code: 'LINKED_GROUP_UNAPPROVED_DEP',
        message: `SKU "${ref}" is referenced but has no approved catalog entry at this group's base commit; stage it in this group or remove the reference.`,
        fieldPath: 'shopsite.preserved.advancedBlocks', sku: ref,
      });
    }
  }
  // Open + reconciling drift blocks the whole group per SKU — except drift
  // already linked to THIS change set, which is the set's own reconcile
  // work settling through the approve path (never a foreign blocker).
  for (const sku of [...changeSkus, ...readSkus]) {
    let blocking: boolean;
    try {
      blocking = hasBlockingDriftForSkuExcludingChangeSet(changeSet.workspaceId, sku, changeSetId);
    } catch {
      issues.push({
        severity: 'blocker', code: 'LINKED_DRIFT_CHECK_FAILED',
        message: `Drift check for SKU "${sku}" could not complete; re-check before approval.`,
        fieldPath: 'sku', sku,
      });
      continue;
    }
    if (blocking) {
      issues.push({
        severity: 'blocker', code: 'LINKED_GROUP_UNRESOLVED_DRIFT',
        message: `SKU "${sku}" has unresolved remote drift (open or reconciling); resolve drift before approving the group.`,
        fieldPath: 'sku', sku,
      });
    }
  }

  return { ok: !issues.some((i) => i.severity === 'blocker'), issues, changeSkus, readSkus };
}
