import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { GitClient } from '../../git/git-client';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getChangeSetDetail, loadApprovedLinkedExport } from '../services/change-set-service';
import { createExportPackage } from '../../shopsite/export-package';
import { hasBlockingDriftForSku } from '../../db/repositories/drift-repo';
import { planFamilyPushSet, checkFamilyPushStalenessFiles } from '../../shopsite/family-push-operation';
import { findCurationDataJsonById } from '../../db/repositories/onboarding-item-repo';
import { getDb } from '../../db/connection';
import { draftListingEvidenceHashes, draftVariantFactsFor, currentSourceAuthority } from '../../classification/listing-evidence-currentness';
import { evaluateListingEvidenceGate } from '../../classification/listing-evidence-gate';
import { findLinkedManifest, listConflictingDraftChangeSets } from '../../db/repositories/change-set-repo';
import { repairChangeSetImagesForWorkspace } from '../services/store-manager-image-repair';
import type { Product } from '../../shared/types';
/**
 * Slice-A-local workspace-scoped item lookup (issue #363 restore): latest
 * item id for a workspace + SKU, newest row first through the owning batch.
 * Single inline-SQL owner; throws on DB failure so callers fail closed.
 */
function findLatestItemIdByWorkspaceAndUpc(workspaceId: string, upc: string): string | null {
  const row = getDb()
    .query(
      `SELECT i.id AS id FROM onboarding_items i JOIN onboarding_batches b ON b.id = i.batch_id
       WHERE b.workspace_id = ? AND i.upc = ? ORDER BY i.created_at DESC LIMIT 1`,
    )
    .get(workspaceId, upc) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Standalone-draft listing-evidence refusal (issue #366 gap 1): interpret
 * the persisted record against the frozen draft being released (draft
 * title/description + shared draft-variant projection over the live bundle
 * with live policy context). Returns the refusal message, or null when the
 * draft may release (no record → grandfathered; present + current + passed
 * → clear). Lookup/parse failure refuses closed (never a bypass).
 */
function refuseStandaloneDraftEvidence(product: Product, workspacePath: string, workspaceId: string, verb: 'export' | 'push'): string | null {
  const sku = product.sku;
  if (!sku) return null;
  let itemId: string | null;
  try {
    itemId = findLatestItemIdByWorkspaceAndUpc(workspaceId, sku);
  } catch {
    return `Listing-evidence check could not complete for SKU "${sku}". Resolve before ${verb}.`;
  }
  if (!itemId) return null;
  let rawCuration: string | null;
  try {
    rawCuration = findCurationDataJsonById(itemId);
  } catch {
    return `Listing-evidence check could not complete for SKU "${sku}". Resolve before ${verb}.`;
  }
  let parsedCuration: Record<string, unknown> | null;
  try {
    parsedCuration = rawCuration ? (JSON.parse(String(rawCuration)) as Record<string, unknown>) : null;
  } catch {
    return `SKU ${sku}: listing-evidence curation is unreadable (listing_evidence_malformed). Resolve before ${verb}.`;
  }
  if (!parsedCuration || parsedCuration.listingEvidenceValidation === undefined || parsedCuration.listingEvidenceValidation === null) return null;
  const draftWeight = product.core?.weight && typeof product.core.weight === 'string' && product.core.weight.trim() ? product.core.weight.trim() : null;
  const draftHashes = draftListingEvidenceHashes(
    itemId,
    { title: product.core?.name ?? null, description: product.core?.description ?? null, variantFacts: draftVariantFactsFor(itemId, draftWeight) },
    { workspacePath, workspaceId },
  );
  const gate = evaluateListingEvidenceGate({
    curationData: parsedCuration,
    currentListingHash: draftHashes.listingHash,
    currentEvidenceHash: draftHashes.evidenceHash,
    currentModelPolicyDigest: draftHashes.modelPolicyDigest,
    currentRequiredFields: draftHashes.requiredFields,
    currentSourceAuthority: currentSourceAuthority(itemId),
  });
  if (!gate.ok) return `SKU ${sku}: listing-evidence check refuses ${verb} (${gate.code}): ${gate.reason}`;
  return null;
}

const route = new Hono();

/**
 * POST /api/export/change-set/:id - Generate export package for an approved change set.
 */
route.post('/export/change-set/:id', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const { changeSet } = getChangeSetDetail(changeSetId);
  if (!changeSet) {
    return c.json({ error: 'Change set not found' }, 404);
  }

  if (changeSet.status !== 'approved') {
    return c.json({
      error: `Change set must be 'approved' before export. Current status: "${changeSet.status}"`,
      incomplete: true,
    }, 400);
  }
  // Standalone change sets (no linked manifest) gate through the same
  // listing-evidence evaluator over the frozen draft artifact (gap 1): an
  // approved standalone set whose evidence subsequently became stale or
  // blocked refuses here, exactly like the linked path below.
  const { items } = getChangeSetDetail(changeSetId);
  const manifestRow = (() => { try { return findLinkedManifest(changeSetId); } catch { return null; } })();
  if (!manifestRow) {
    const products: Product[] = [];
    for (const item of items) {
      try {
        products.push(JSON.parse(item.draftJson) as Product);
      } catch {
        return c.json({ error: `Failed to parse draft JSON for SKU "${item.sku}"` }, 500);
      }
    }
    if (products.length === 0) {
      return c.json({ error: 'No products in change set to export.' }, 400);
    }
    for (const product of products) {
      const refusal = refuseStandaloneDraftEvidence(product, workspace.workspacePath, workspace.id, 'export');
      if (refusal) return c.json({ error: refusal, incomplete: true }, 409);
    }
    try {
      const exportResult = await createExportPackage(
        workspace.workspacePath, changeSetId, products, { changeSetTitle: changeSet.title },
      );
      return c.json({
        success: true,
        exportDir: exportResult.exportDir,
        xmlPath: exportResult.xmlPath,
        manifestPath: exportResult.manifestPath,
        instructionsPath: exportResult.instructionsPath,
        zipPath: exportResult.zipPath,
        productCount: exportResult.productCount,
        ...(exportResult.missingImagesWarning ? { missingImagesWarning: exportResult.missingImagesWarning } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Export failed' }, 500);
    }
  }
  // Immutable approved-export binding (issue #363 §6): approved products and
  // the dependency manifest resolve against the SAME immutable commit.
  // Partial/unapproved/incomplete operations refuse honestly here.
  const linked = loadApprovedLinkedExport(changeSetId, workspace.workspacePath);
  if (!linked.ok) {
    return c.json(
      { error: linked.error, incomplete: linked.incomplete },
      (linked.incomplete ? 409 : 400),
    );
  }
  const products = linked.load.products;
  const linkedManifest = linked.load.manifest;
  if (products.length === 0) {
    return c.json({ error: 'No products in change set to export.' }, 400);
  }
  // Issue #366: package export refuses through the single listing-evidence
  // gate over the frozen product artifact — the approved-status check alone
  // is transitive, and a stale approval could otherwise export. Absent
  // records grandfather; present-but-stale/blocked/unavailable refuse.
  for (const product of products) {
    const refusal = refuseStandaloneDraftEvidence(product, workspace.workspacePath, workspace.id, 'export');
    if (refusal) return c.json({ error: refusal, incomplete: true }, 409);
  }
  // Export enforces the same group gates as the direct push (issue #363):
  // unresolved drift on any write or unchanged referenced read SKU refuses
  // with 409, and worktree-vs-commit staleness after approval refuses stale
  // publication instead of packaging bytes the approval never reviewed.
  // Publication-time competing drafts recheck here too (#373): a foreign
  // draft for any manifest SKU created after approval blocks the export.
  const gateSkus = [...linkedManifest.writes.map((w) => w.sku), ...linkedManifest.reads.map((r) => r.sku)];
  try {
    const gateScope: Record<string, true> = {};
    for (const sku of gateSkus) gateScope[sku] = true;
    const conflicts = listConflictingDraftChangeSets(workspace.id, Object.keys(gateScope).sort(), changeSetId);
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      return c.json({ error: `Cannot export SKU "${first.sku}": also staged in change set ${first.changeSetId.slice(0, 8)} (status "${first.status}"); resolve the competing draft before exporting.`, incomplete: true }, 409);
    }
  } catch (err) {
    return c.json({ error: `Competing-draft check could not complete (${err instanceof Error ? err.message : String(err)}); re-check before export.`, incomplete: true }, 409);
  }
  for (const sku of gateSkus) {
    try {
      if (hasBlockingDriftForSku(workspace.id, sku)) {
        return c.json({ error: `Cannot export SKU "${sku}": unresolved remote drift exists. Resolve drift first.`, incomplete: true }, 409);
      }
    } catch (err) {
      return c.json({ error: `Drift check for SKU "${sku}" could not complete (${err instanceof Error ? err.message : String(err)}); re-check before export.`, incomplete: true }, 409);
    }
  }
  const git = new GitClient(workspace.workspacePath);
  const staleness = checkFamilyPushStalenessFiles(
    linkedManifest,
    (filePath) => git.readFileAtCommit(linked.load.commitHash, filePath),
    (filePath) => {
      try {
        const full = path.join(workspace.workspacePath, filePath);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full, 'utf-8');
      } catch {
        return null;
      }
    },
  );
  if (!staleness.ok) {
    return c.json({ error: staleness.error, stale: true, incomplete: true }, 409);
  }
  // The package export validates the same complete-family plan the direct
  // push executes — one unsplittable set, stable SKU order. Required remote
  // members (referenced but unchanged) need a verified catalog entry AT THE
  // APPROVED COMMIT (#373): existence in the mutable worktree is not enough
  // — a child can exist locally while missing or divergent remotely, and a
  // local-only check would package a parent-only write as successfully
  // exportable. The commit entry binds the expectation the push path later
  // verifies against the live census; without it the dependency refuses
  // here until its complete record belongs to the approved operation.
  let pushPlan: { skus: string[]; requiredRemoteSkus: string[]; newSkus: string[]; updateSkus: string[]; payloadHash: string };
  try {
    pushPlan = planFamilyPushSet(products, linkedManifest);
    for (const sku of pushPlan.requiredRemoteSkus) {
      const read = linkedManifest.reads.find((r) => r.sku === sku);
      if (!read) {
        throw new Error(`Required remote member "${sku}" has no manifest read entry; the dependency is unrecorded — stage it in this group or remove the reference.`);
      }
      const atCommit = git.readFileAtCommit(linked.load.commitHash, read.filePath);
      if (!atCommit) {
        throw new Error(`Required remote member "${sku}" is missing at approved commit ${linked.load.commitHash.slice(0, 12)}; the group is stale — stage its complete record in this group or re-approve.`);
      }
      try {
        JSON.parse(atCommit);
      } catch {
        throw new Error(`Required remote member "${sku}" is unreadable at the approved commit; the dependency is unverifiable — re-approve the group.`);
      }
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err), incomplete: true }, 409);
  }

  try {
    const exportResult = await createExportPackage(
      workspace.workspacePath,
      changeSetId,
      products,
      {
        changeSetTitle: changeSet.title,
        approvedCommit: linked.load.commitHash,
        linkedManifest,
        pushPayloadHash: pushPlan.payloadHash,
        pushSkus: pushPlan.skus,
      },
    );
    return c.json({
      success: true,
      exportDir: exportResult.exportDir,
      xmlPath: exportResult.xmlPath,
      manifestPath: exportResult.manifestPath,
      instructionsPath: exportResult.instructionsPath,
      zipPath: exportResult.zipPath,
      productCount: exportResult.productCount,
      pushPayloadHash: pushPlan.payloadHash,
      pushSkus: pushPlan.skus,
      ...(pushPlan.requiredRemoteSkus.length > 0 ? { pushRequiredRemoteSkus: pushPlan.requiredRemoteSkus } : {}),
      ...(exportResult.missingImagesWarning ? { missingImagesWarning: exportResult.missingImagesWarning } : {}),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Export failed' }, 500);
  }
});

/**
 * GET /api/export/change-set/:id/images-zip - Download the brand-organized images ZIP.
 */
route.get('/export/change-set/:id/images-zip', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const zipPath = path.join(workspace.workspacePath, 'exports', changeSetId, 'shopsite-images.zip');

  if (!fs.existsSync(zipPath)) {
    return c.json({ error: 'Images ZIP not found. Generate an export package first.' }, 404);
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const fileBuffer = fs.readFileSync(zipPath);

  return new Response(fileBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="shopsite-images-${dateStr}.zip"`,
      'Content-Length': String(fileBuffer.length),
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * GET /api/export/change-set/:id/xml - Download the ShopSite product XML file.
 */
route.get('/export/change-set/:id/xml', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const xmlPath = path.join(workspace.workspacePath, 'exports', changeSetId, 'shopsite-products.xml');

  if (!fs.existsSync(xmlPath)) {
    return c.json({ error: 'Products XML not found. Generate an export package first.' }, 404);
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const fileBuffer = fs.readFileSync(xmlPath);

  return new Response(fileBuffer, {
    headers: {
      'Content-Type': 'application/xml',
      'Content-Disposition': `attachment; filename="shopsite-products-${dateStr}.xml"`,
      'Content-Length': String(fileBuffer.length),
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * POST /api/export/change-set/:id/repair-images
 *
 * Re-downloads images for an approved change set from the original onboarding
 * extraction data. This repairs missing image files for change sets that were
 * promoted before the workspace-backed image storage was introduced.
 *
 * All enforcement (approved-state gate, workspace scoping, bounded network
 * policy, image decode validation, atomic writes, path containment, and
 * structured outcomes) lives in the single hardened service below so the
 * Change Set Review UI path cannot drift from or bypass the agent-tool path.
 * The direct UI route remains protected by the app-level mutating-request
 * API-token boundary and an explicit user click; the agent-tool path
 * additionally requires the Store Manager approval gate (#34).
 */
route.post('/export/change-set/:id/repair-images', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const result = await repairChangeSetImagesForWorkspace({
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    changeSetId,
  });

  if (result.status === 'not_found') {
    return c.json({ error: result.error }, 404);
  }
  if (result.status === 'policy_denied') {
    return c.json({ error: result.error }, 409);
  }
  if (result.status === 'error') {
    return c.json({ error: result.error }, 400);
  }
  return c.json(result.summary);
});

export default route;
