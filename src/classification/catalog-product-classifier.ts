/**
 * Catalog Product Classifier
 *
 * Orchestrates a classification run for an existing catalog product
 * (no onboarding item required). Loads the product from the Git workspace,
 * builds and persists ONE immutable runtime snapshot before run creation,
 * creates a catalog run, and executes 6 pipeline stages (omitting
 * name_consolidation).
 */
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from './config-loader';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from './page-snapshot';
import { redactTransportText } from './model-policy-gateway';
import { assertClassificationReady } from './readiness';
import { syncConfigToCache, createConfigSnapshot, getPersistedConfigSnapshotId, upsertConfigSnapshot } from '../db/repositories/classification-config-repo';
import {
  createRun,
  completeRun,
  getRecentCatalogRun,
  supersedeCatalogProposals,
} from '../db/repositories/classification-run-repo';
import { recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { runPipeline } from './pipeline-runner';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from './runtime-snapshot';
import { createCatalogEvidenceExtractionStage } from './stages/catalog-product-evidence-extraction';
import { primaryProductTypeStage } from './stages/primary-product-type';
import { attributeApplicabilityStage } from './stages/attribute-applicability';
import { productAttributeProposalsStage } from './stages/attribute-proposals';
import { categoryPageProposalsStage } from './stages/category-page-proposals';
import { productDraftProjectionStage } from './stages/draft-projection';
import { computeProductHash, ownProductPageNames } from './catalog-product-source';
import type { StageDefinition, StageContext, StageInput } from './types';
import type { Product } from '../shared/types';

/**
 * Run classification for a catalog product.
 *
 * @param workspaceId - The workspace ID
 * @param workspacePath - The workspace path (for reading product files)
 * @param product - The Product object to classify
 * @returns Object with runId and success status
 */
export async function classifyCatalogProduct(
  workspaceId: string,
  workspacePath: string,
  product: Product,
): Promise<{ runId: string; success: boolean; error?: string }> {
  const sku = product.sku;

  // 1. Load the authoritative runtime config (ACTIVE v2 bundle when present,
  //    transitional v1 otherwise) and resolve the snapshot reference binding.
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  // Capture the verified Page catalog ONCE, coherently (validates import/row
  // correspondence and throws on drift) BEFORE the readiness gate so the gate
  // is bound to the exact snapshot the run will freeze — an enabled Page
  // target can never start with pages.state='no_verified_page_catalog'.
  const pageSnapshot = captureVerifiedPageSnapshot(workspaceId);
  // Run-start readiness gate (issue #17 L): the ACTIVE v2 config must be
  // ready (enabled targets with legal options, verified Page catalog when
  // the Page target is enabled) before any snapshot/run/model side effect.
  assertClassificationReady(authority, {
    catalogFields: activationContext.catalogFields,
    verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
    verifiedPageIds: pageSnapshot.pageImportId ? pageSnapshot.verifiedPageIds : [],
  });
  let configSnapshotRef: StageContext['configSnapshotRef'];
  let focusedFileHashes: Record<string, string>;
  let catalogEvidenceHash: string | null;
  if (authority.kind === 'v2') {
    const bundle = authority.bundle;
    let persistedId = getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash);
    if (!persistedId) {
      const snap = upsertConfigSnapshot(workspaceId, bundle, bundle.manifest.sourceCatalogCommit);
      persistedId = snap.id;
    }
    configSnapshotRef = {
      id: persistedId,
      hash: bundle.manifest.bundleHash,
      sourceCommit: bundle.manifest.sourceCatalogCommit,
      createdAt: new Date().toISOString(),
    };
    focusedFileHashes = bundle.manifest.fileVersions;
    catalogEvidenceHash = bundle.manifest.catalogEvidenceHash;
    // The derived cache was written transactionally at activation; never
    // re-sync the v2 bundle through the v1-shaped cache mirror.
  } else {
    syncConfigToCache(workspaceId, authority.config);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, authority.config);
    configSnapshotRef = {
      id: snapId,
      hash: snapHash,
      sourceCommit: null,
      createdAt: new Date().toISOString(),
    };
    focusedFileHashes = authority.config.manifest.fileVersions ?? {};
    catalogEvidenceHash = null;
  }

  // 2. Compute product hash for drift detection (includes search keywords
  //    and the product's OWN ProductOnPages observations).
  const productHash = computeProductHash(product);

  // 3. Check for existing running catalog run
  const existing = getRecentCatalogRun(workspaceId, sku);
  if (existing && existing.status === 'running') {
    return { runId: existing.id, success: false, error: 'A classification run is already in progress for this product' };
  }

  // 4. Build + freeze + persist ONE immutable runtime snapshot before run
  //    creation. The verified Page catalog (captured above, before readiness)
  //    is frozen into the snapshot; page context is the product's own
  //    name-only observations (never every store Page).
  const ownPageNames = ownProductPageNames(product);
  const runtimeSnapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath,
    productSku: sku,
    authority,
    configSnapshotRef,
    focusedFileHashes,
    catalogEvidenceHash,
    sourceProductHash: productHash,
    searchKeywords: product.core.seo?.searchKeywords ?? null,
    productPageNames: ownPageNames,
    pages: toPageSnapshotState(
      pageSnapshot,
      ownPageNames.map(pageName => ({ pageId: pageName, pageName, verified: false })),
    ),
    pageImportId: pageSnapshot.pageImportId,
    pageImportHash: pageSnapshot.pageImportHash,
  });
  const { id: runtimeSnapId, hash: runtimeSnapHash } = persistRuntimeSnapshot(runtimeSnapshot);

  // 5. Create a catalog classification run bound to the runtime snapshot
  const run = createRun(workspaceId, sku, runtimeSnapId, runtimeSnapHash, {
    sourceKind: 'catalog_product',
    sourceProductHash: productHash,
  });

  try {
    // 6. Build stage context around the frozen snapshot
    const stageContext: StageContext = {
      workspacePath,
      workspaceId,
      configSnapshotRef,
      snapshot: runtimeSnapshot,
      runId: run.id,
      catalogContext: {
        sourceProductHash: productHash,
        existingPageIds: ownPageNames.map(pageName => ({ pageId: pageName, pageName })),
      },
    };

    // 7. Create catalog evidence extraction stage (captures product snapshot)
    const catalogEvidenceStage = createCatalogEvidenceExtractionStage(product, workspacePath);

    // 8. Run pipeline with 6 stages (omit name_consolidation and cohort logic)
    const stages: StageDefinition[] = [
      catalogEvidenceStage,
      primaryProductTypeStage,
      attributeApplicabilityStage,
      productAttributeProposalsStage,
      categoryPageProposalsStage,
      productDraftProjectionStage,
    ];

    const stageInput: StageInput = {
      sku,
      sourceKind: 'catalog_product',
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    };

    const result = await runPipeline(stages, stageContext, stageInput);

    // 9. Determine final status
    const hasAbstentions = result.proposals.some(p => p.proposalType === 'reviewable_abstention');
    const finalStatus = hasAbstentions ? 'completed_with_abstentions' as const : 'completed' as const;

    // 10. Supersede older catalog proposals (mark as stale)
    supersedeCatalogProposals(workspaceId, sku, run.id);

    // 11. Complete the run
    completeRun(run.id, finalStatus);

    // 12. Record history
    recordHistoryEvent(workspaceId, sku, 'catalog_classification_run', {
      runId: run.id,
      sourceKind: 'catalog_product',
      sourceProductHash: productHash,
      configSnapshotHash: runtimeSnapHash,
      status: finalStatus,
      evidenceCount: result.evidence.length,
      proposalCount: result.proposals.length,
    }, run.id);

    return { runId: run.id, success: true };

  } catch (err) {
    const reason = redactTransportText(err instanceof Error ? err.message : String(err));
    completeRun(run.id, 'failed', reason);
    return { runId: run.id, success: false, error: reason };
  }
}
