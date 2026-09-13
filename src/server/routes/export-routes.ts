import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getChangeSetDetail } from '../services/change-set-service';
import { createExportPackage } from '../../shopsite/export-package';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { repairChangeSetImagesForWorkspace } from '../services/store-manager-image-repair';
import type { Product } from '../../shared/types';

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
    }, 400);
  }

  const items = listChangeSetItems(changeSetId);
  const products: Product[] = [];

  for (const item of items) {
    try {
      const product = JSON.parse(item.draftJson) as Product;
      products.push(product);
    } catch {
      return c.json({ error: `Failed to parse draft JSON for SKU "${item.sku}"` }, 500);
    }
  }

  if (products.length === 0) {
    return c.json({ error: 'No products in change set to export.' }, 400);
  }

  try {
    const exportResult = await createExportPackage(
      workspace.workspacePath,
      changeSetId,
      products,
      { changeSetTitle: changeSet.title },
    );

    return c.json({
      success: true,
      exportDir: exportResult.exportDir,
      xmlPath: exportResult.xmlPath,
      manifestPath: exportResult.manifestPath,
      instructionsPath: exportResult.instructionsPath,
      zipPath: exportResult.zipPath,
      productCount: exportResult.productCount,
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
