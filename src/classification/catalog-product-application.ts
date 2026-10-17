import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import {
  countVisualProductEvidence,
  findGateRunById,
  findLatestEvidenceExtractionOutputJson,
  findRuntimeSnapshotEvidenceExtractionRuleVersion,
  getAcceptedProposals,
  recordHistoryEvent,
} from '../db/repositories/classification-run-repo';
import { getCachedAttributeMappings, getCachedClassificationOutputBindings } from '../db/repositories/classification-config-repo';
import { createUpdateDraftWithItem } from '../db/repositories/change-set-repo';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from './config-loader';
import { authorityConfigHashMatches, getRuntimeSnapshotByHash, runtimeSnapshotHashMatchesConfig } from './runtime-snapshot';
import { getActivePageImportHash, listVerifiedPageOptions } from '../db/repositories/page-repo';
import { buildAssignmentProjection, createAssignmentProjectionAuthority } from './assignment-projection';
import { computeProductHash } from './catalog-product-source';
import { digestLoadedImageBytes } from '../onboarding/packaging-ocr';
import { findConnection } from '../db/repositories/connection-repo';
import { resolveProductImageUrl } from '../shopsite/url-utils';
import type { Product } from '../shared/types';

/**
 * A2: re-hash the image bytes behind the run's recorded OCR image refs and
 * fail when any recorded digest no longer matches. Recorded digests come
 * from the run's evidence_extraction stage metadata (persisted by the
 * pipeline runner); refs resolve exactly as the OCR attempt resolved them.
 * Changed/absent bytes block that SKU; text-only runs (no recorded digests)
 * pass through untouched.
 */
export async function verifyRunImageBytesUnchanged(
  workspacePath: string,
  _workspaceId: string,
  _sku: string,
  runId: string,
  product: Product,
): Promise<void> {
  const outputJson = findLatestEvidenceExtractionOutputJson(runId);
  if (outputJson === null) return;
  let recorded: Array<{ imageBytesDigest?: string | null }>;
  try {
    const parsed = JSON.parse(outputJson ?? '{}') as {
      metadata?: { ocrSummary?: { images?: Array<{ imageBytesDigest?: string | null }> } };
    };
    recorded = parsed.metadata?.ocrSummary?.images ?? [];
  } catch {
    return;
  }
  const digests = recorded.map(entry => entry.imageBytesDigest).filter((digest): digest is string => !!digest);
  if (digests.length === 0) return;
  const cgiBaseUrl = (() => { try { return findConnection(_workspaceId)?.cgiBaseUrl; } catch { return undefined; } })();
  const refs = [product.core.media?.primary, ...(product.core.media?.additional ?? [])].filter((ref): ref is string => !!ref).slice(0, 2);
  const current = new Set<string>();
  for (const ref of refs) {
    const resolved = cgiBaseUrl ? resolveProductImageUrl(ref, cgiBaseUrl) : ref;
    const digest = await digestLoadedImageBytes(resolved ?? ref, workspacePath).catch(() => null);
    if (digest) current.add(digest);
  }
  for (const digest of digests) {
    if (!current.has(digest)) {
      throw new Error('Product images changed since classification (byte digest mismatch). Please provide a better image or re-run classification.');
    }
  }
}

const now = () => new Date().toISOString();

export interface ApplyClassificationResult {
  changeSetId: string;
  appliedFields: string[];
  appliedPages: string[];
  /** Accepted reviewed removals applied in this draft (issue #353). */
  removedPages: string[];
  skipped: Array<{ proposalId: string; reason: string }>;
}

/**
 * Apply accepted classification proposals to an existing catalog product.
 *
 * 1. Re-reads the product and verifies source/config hashes match
 * 2. Creates an update change-set draft (never writes directly)
 * 3. Merges accepted field assignments into customFields (explicit reviewed
 *    null clears the slot; reviewed reduced arrays remove only named values)
 * 4. Adds accepted pages to ProductOnPages and removes accepted reviewed
 *    taxonomy-page removals (other pages — including Brand pages — survive)
 * 5. Returns change-set ID for the user to approve
 */
export async function applyCatalogClassification(
  workspacePath: string,
  workspaceId: string,
  sku: string,
  runId: string,
): Promise<ApplyClassificationResult> {
  // Verify run
  const gateRun = findGateRunById(runId);
  const run = gateRun ? {
    id: gateRun.id, status: gateRun.status, source_kind: gateRun.sourceKind,
    source_product_hash: gateRun.sourceProductHash, config_snapshot_hash: gateRun.configSnapshotHash,
  } : undefined;

  if (!run) throw new Error(`Run ${runId} not found.`);
  if (run.source_kind !== 'catalog_product') throw new Error('Run is not a catalog product run.');
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    throw new Error(`Run status is "${run.status}". Cannot apply.`);
  }
  // A3: refuse pre-change visual runs at apply. Runs frozen before the
  // grounded-merge evidence contract carry an older evidence_extraction rule
  // version — reclassify instead of reinterpreting their frozen snapshots.
  // Text-only runs (no visual evidence) are unaffected.
  if (countVisualProductEvidence(runId) > 0) {
    const ruleVersion = run.config_snapshot_hash
      ? findRuntimeSnapshotEvidenceExtractionRuleVersion(String(run.config_snapshot_hash))
      : null;
    if (ruleVersion !== 'evidence-extraction-rules-v3-grounded-merge') {
      throw new Error('Run uses a pre-A3 visual evidence contract; reclassify instead of reinterpreting its frozen snapshot.');
    }
  }

  let product = readProductFile(workspacePath, sku);
  if (!product) throw new Error(`Product not found for SKU: ${sku}`);

  // Finish the only asynchronous check before the final source/config/page
  // authority reads. No product or change-set write precedes these checks.
  await verifyRunImageBytesUnchanged(workspacePath, workspaceId, sku, runId, product);
  product = readProductFile(workspacePath, sku);
  if (!product) throw new Error(`Product not found for SKU: ${sku}`);

  // Source hash drift check — must use same hash function as classifier
  if (run.source_product_hash) {
    const currentHash = computeProductHash(product);
    if (currentHash !== run.source_product_hash) {
      throw new Error('Product has changed since classification. Please rerun classification.');
    }
  }

  // Config hash drift check — supports plain config hashes (legacy), the
  // active v2 bundle hash, and persisted runtime snapshot hashes; unknown
  // formats fail closed.
  if (run.config_snapshot_hash) {
    const storedHash = String(run.config_snapshot_hash);
    const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, workspaceId));
    const matches =
      authorityConfigHashMatches(authority, storedHash) ||
      runtimeSnapshotHashMatchesConfig(
        workspaceId,
        storedHash,
        authority.kind === 'v2' ? authority.bundle : authority.config,
      );
    if (!matches) {
      throw new Error('Classification config has changed since classification. Please rerun classification.');
    }
  }

  // Get accepted proposals
  const acceptedProposals = getAcceptedProposals(sku, runId);
  if (acceptedProposals.length === 0) {
    throw new Error('No accepted proposals to apply.');
  }

  const frozenSnapshot = run.config_snapshot_hash
    ? getRuntimeSnapshotByHash(workspaceId, run.config_snapshot_hash)
    : null;
  if (!frozenSnapshot) {
    throw new Error('Classification snapshot authority is unavailable. Reclassify before applying.');
  }
  if (acceptedProposals.some(p => p.proposalType === 'category_page')) {
    const frozenImportHash = frozenSnapshot.pageImportHash;
    if (!frozenImportHash) throw new Error('Verified page authority is missing from the classification snapshot. Reclassify before applying.');
    if (getActivePageImportHash(workspaceId) !== frozenImportHash) {
      throw new Error('Page import has changed since classification (page_decision_stale). Re-resolve page assignments against the active verified import before applying.');
    }
  }

  const mappings = getCachedAttributeMappings(workspaceId);
  const verifiedPages = listVerifiedPageOptions(workspaceId);
  const projection = buildAssignmentProjection(
    acceptedProposals,
    product.customFields ?? {},
    product.core.productOnPages ?? [],
    mappings,
    new Set(verifiedPages.map(page => page.id)),
    createAssignmentProjectionAuthority(frozenSnapshot, new Map(verifiedPages.map(page => [page.id, page.name])),
      getCachedClassificationOutputBindings(workspaceId)),
  );
  if (projection.skipped.length > 0) {
    throw new Error(`Classification projection refused: ${projection.skipped.map(refusal => `${refusal.proposalId}: ${refusal.reason}`).join('; ')}`);
  }
  const mergedCustomFields = { ...(product.customFields ?? {}) };
  for (const field of projection.fields) mergedCustomFields[field.catalogField] = field.proposedValue;
  const appliedFields = projection.fields.map(field => field.catalogField);
  const appliedPages: string[] = [];
  const skipped: Array<{ proposalId: string; reason: string }> = [];
  const additionalPages = projection.pages.additions.map(page => page.pageName);
  const removedPages = projection.pages.removed;
  const mergedPages = projection.pages.final;
  const remainingUnknownElements = { ...(product.shopsite?.preserved?.unknownElements ?? {}) };
  delete remainingUnknownElements['ProductOnPages'];

  // Build updated product
  const updatedProduct: Product = {
    ...product,
    core: {
      ...product.core,
      productOnPages: mergedPages,
    },
    customFields: mergedCustomFields,
    shopsite: {
      ...product.shopsite,
      preserved: {
        ...product.shopsite.preserved,
        unknownElements: remainingUnknownElements,
      },
    },
    metadata: {
      ...product.metadata,
      updatedAt: now(),
    },
  };

  // Create change set + item atomically (issue #354): a failure between the
  // two writes must never orphan an empty change set — either both persist
  // or neither does. All fallible validation already ran above; only
  // serialization (pure) and these two inserts remain.
  const workspace = findWorkspace();
  const baseCommit = workspace?.baselineCommit ?? 'unknown';
  const dateStr = new Date().toLocaleDateString();
  const draftJsonStr = deterministicStringify(updatedProduct);
  const draftHash = hashJson(updatedProduct);
  const baseJsonStr = deterministicStringify(product);
  const changeSet = createUpdateDraftWithItem({
    workspaceId,
    title: `Classification: ${sku} (${dateStr})`,
    description: `Applied accepted classification proposals for product ${sku}.`,
    baseCommit,
    sku,
    draftJson: draftJsonStr,
    baseJson: baseJsonStr,
    draftHash,
    classificationRunId: runId,
  });

  // Track applied page names for the result (page data is embedded in the
  // ProductOnPages draft — product_pages table is updated when the change
  // set is approved, not during draft creation). Removals are tracked
  // separately so review surfaces can distinguish them from additions.
  for (const pageName of additionalPages) {
    appliedPages.push(pageName);
  }
  const removedPageNames: string[] = [...removedPages];

  // Record history
  try {
    recordHistoryEvent(workspaceId, sku, 'classification_draft_created', {
      runId,
      changeSetId: changeSet.id,
      appliedFields,
      appliedPages,
      removedPages: removedPageNames,
      skippedCount: skipped.length,
    });
  } catch {
    // non-blocking
  }

  return { changeSetId: changeSet.id, appliedFields, appliedPages, removedPages: removedPageNames, skipped };
}
