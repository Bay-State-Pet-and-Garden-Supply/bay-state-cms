import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { getCurrentWorkspace } from '../services/workspace-service';
import { syncFieldRegistryFromProductIndex } from '../services/workspace-service';
import { indexProductPageAssignments } from '../../db/repositories/page-repo';
import { getChangeSetDetail } from '../services/change-set-service';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { buildUploadMultipart, extractDbmakeQuery, redactCredentials, isDbmakeSuccessful } from '../../shopsite/multipart-upload';
import { publishStore } from '../../shopsite/publish';
import { buildCgiScriptUrl } from '../../shopsite/url-utils';
import { createSyncJob, completeSyncJob, addSyncJobEvent, listSyncJobs, findSyncJobById, listSyncJobEvents } from '../../db/repositories/sync-job-repo';
import { updateProductIndex, insertProductIndex, findProductBySku } from '../../db/repositories/product-index-repo';
import { findConnection } from '../../db/repositories/connection-repo';
import { hasBlockingDriftForSku } from '../../db/repositories/drift-repo';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { hashJson } from '../../git/deterministic-json';
import { skuToProductFilePath } from '../../git/product-file-path';
import { getDb } from '../../db/connection';
import { createImagesZip } from '../../shopsite/zip-generator';
import { ShopSiteHttpClient } from '../../shopsite/shopsite-http-client';
import { preflightPagesSync, reconcileProductsToActivePages } from '../../shopsite/page-sync-preflight';
import type { Product } from '../../shared/types';

const route = new Hono();

interface ConnectionConfig {
  cgiBaseUrl: string;
  merchantId: string;
  password: string;
}

interface UploadResult {
  success: boolean;
  dbmakeQuery: string;
  rawResponse: string;
  cookieHeader?: string;
  error?: string;
}

interface DbmakeResult {
  success: boolean;
  response: string;
  cookieHeader?: string;
  error?: string;
}

function getConnectionConfig(workspaceId: string): ConnectionConfig | null {
  const row = findConnection(workspaceId);
  if (!row?.cgiBaseUrl || !row.merchantId || !row.passwordSecretRef) return null;
  return {
    cgiBaseUrl: row.cgiBaseUrl,
    merchantId: row.merchantId,
    password: row.passwordSecretRef,
  };
}

function authHeader(config: ConnectionConfig): string {
  return `Basic ${Buffer.from(`${config.merchantId}:${config.password}`).toString('base64')}`;
}

function extractCookieHeader(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers
      .getSetCookie()
      .map(cookie => cookie.split(';', 1)[0]?.trim())
      .filter(Boolean);
    if (cookies.length > 0) return cookies.join('; ');
  }

  const rawSetCookie = response.headers.get('set-cookie');
  if (!rawSetCookie) return undefined;
  return rawSetCookie
    .split(/,(?=[^;,]+=)/)
    .map(cookie => cookie.split(';', 1)[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function productsFromApprovedItems(items: Array<{ sku: string; draftJson: string }>): Product[] {
  return items.map(item => {
    try {
      return JSON.parse(item.draftJson) as Product;
    } catch {
      throw new Error(`Failed to parse product data for SKU "${item.sku}"`);
    }
  });
}

function ensureNoOpenDrift(workspaceId: string, items: Array<{ sku: string }>): string | null {
  for (const item of items) {
    if (hasBlockingDriftForSku(workspaceId, item.sku)) {
      return item.sku;
    }
  }
  return null;
}

async function directUpload(xml: string, config: ConnectionConfig): Promise<UploadResult> {
  const multipart = buildUploadMultipart(xml, {
    newRecords: 'yes',
    uniqueName: 'SKU',
  });

  const url = buildCgiScriptUrl(config.cgiBaseUrl, 'dbupload.cgi');
  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    'User-Agent': 'BaystateCMS/0.1.0',
    'Content-Type': multipart.contentType,
    'Content-Length': String(multipart.contentLength),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: multipart.body as unknown as BodyInit,
      signal: AbortSignal.timeout(180_000),
    });

    const rawResponse = await response.text();
    const cookieHeader = extractCookieHeader(response);

    if (!response.ok) {
      return {
        success: false,
        dbmakeQuery: '',
        rawResponse,
        cookieHeader,
        error: `HTTP ${response.status}: ${redactCredentials(rawResponse.slice(0, 300))}`,
      };
    }

    const dbmakeQuery = extractDbmakeQuery(rawResponse);
    if (dbmakeQuery === null) {
      return {
        success: false,
        dbmakeQuery: '',
        rawResponse,
        cookieHeader,
        error: `ShopSite upload did not return a dbmake return string or success indicator: ${redactCredentials(rawResponse.slice(0, 300))}`,
      };
    }

    return { success: true, dbmakeQuery, rawResponse, cookieHeader };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, dbmakeQuery: '', rawResponse: '', error: msg };
  }
}

async function finalizeDbmake(queryString: string, config: ConnectionConfig, cookieHeader?: string): Promise<DbmakeResult> {
  const url = buildCgiScriptUrl(config.cgiBaseUrl, 'dbmake.cgi');
  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    'User-Agent': 'BaystateCMS/0.1.0',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: queryString,
      signal: AbortSignal.timeout(60_000),
    });

    const responseText = await response.text();
    const responseCookie = extractCookieHeader(response) ?? cookieHeader;

    if (!response.ok) {
      return {
        success: false,
        response: responseText,
        cookieHeader: responseCookie,
        error: `HTTP ${response.status}: ${redactCredentials(responseText.slice(0, 300))}`,
      };
    }

    if (!isDbmakeSuccessful(responseText)) {
      return {
        success: false,
        response: responseText,
        cookieHeader: responseCookie,
        error: `dbmake responded with error body: ${redactCredentials(responseText.slice(0, 300))}`,
      };
    }

    return { success: true, response: responseText, cookieHeader: responseCookie };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, response: '', cookieHeader, error: msg };
  }
}

async function runDirectSync(options: {
  workspaceId: string;
  workspacePath: string;
  changeSetId: string;
  publish: boolean;
}): Promise<ResponseInit & { body: Record<string, unknown> }> {
  const config = getConnectionConfig(options.workspaceId);
  if (!config) {
    return { status: 400, body: { error: 'ShopSite connection not configured. Use Export Package instead.' } };
  }

  const { changeSet, items } = getChangeSetDetail(options.changeSetId);
  if (!changeSet) return { status: 400, body: { error: 'Change set not found.' } };
  if (changeSet.status !== 'approved') {
    return { status: 400, body: { error: `Change set must be approved first (status: ${changeSet.status}).` } };
  }
  if (items.length === 0) return { status: 400, body: { error: 'Change set has no items.' } };

  const driftSku = ensureNoOpenDrift(options.workspaceId, items);
  if (driftSku) {
    return { status: 409, body: { error: `Cannot push SKU "${driftSku}": unresolved remote drift exists. Resolve drift first.` } };
  }

  const kind = options.publish ? 'push_publish' : 'upload_only';
  const job = createSyncJob({ workspaceId: options.workspaceId, changeSetId: options.changeSetId, kind });
  addSyncJobEvent({
    syncJobId: job.id,
    level: 'info',
    message: options.publish
      ? `Starting direct push and publish for change set "${changeSet.title}"`
      : `Starting upload-only for change set "${changeSet.title}"`,
  });

  try {
    // 1. Pages preflight — verify and reconcile category catalog before pushing products
    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: 'Running ShopSite Pages preflight verification...',
    });

    const client = new ShopSiteHttpClient({
      cgiBaseUrl: config.cgiBaseUrl,
      merchantId: config.merchantId,
      password: config.password,
    });

    const preflight = await preflightPagesSync({
      workspaceId: options.workspaceId,
      client,
      activatedBy: `sync-job-${job.id}`,
    });

    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: preflight.message,
    });

    const products = reconcileProductsToActivePages(
      options.workspaceId,
      preflight.sourceHash,
      productsFromApprovedItems(items),
    );
    const xml = ShopSiteProductCodec.encodeMany(products).xml;
    addSyncJobEvent({ syncJobId: job.id, level: 'info', message: `Generated XML for ${products.length} product(s)` });

    // Generate brand-organized images ZIP
    let zipPath: string | null = null;
    try {
      const exportsDir = path.join(options.workspacePath, 'exports', options.changeSetId);
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }
      zipPath = path.join(exportsDir, 'shopsite-images.zip');
      await createImagesZip(options.workspacePath, products, zipPath);
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Images ZIP generated.' });
    } catch (zipErr) {
      const zipMsg = zipErr instanceof Error ? zipErr.message : String(zipErr);
      addSyncJobEvent({ syncJobId: job.id, level: 'warning', message: `Images ZIP generation failed: ${zipMsg}` });
      zipPath = null;
    }

    const uploadResult = await directUpload(xml, config);
    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: 'Upload response received.',
      detailsJson: JSON.stringify({ responsePreview: redactCredentials(uploadResult.rawResponse.slice(0, 300)) }),
    });

    if (!uploadResult.success) throw new Error(`Upload failed: ${uploadResult.error}`);

    let cookieHeader = uploadResult.cookieHeader;
    if (uploadResult.dbmakeQuery) {
      const dbmakeResult = await finalizeDbmake(uploadResult.dbmakeQuery, config, cookieHeader);
      if (!dbmakeResult.success) throw new Error(`dbmake finalization failed: ${dbmakeResult.error}`);
      cookieHeader = dbmakeResult.cookieHeader ?? cookieHeader;
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'dbmake finalization completed.' });
    } else {
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Upload reported success immediately; no dbmake needed.' });
    }

    let publishCompleted = false;
    if (options.publish) {
      const publishResult = await publishStore(
        buildCgiScriptUrl(config.cgiBaseUrl, 'generate.cgi'),
        authHeader(config),
        undefined,
        cookieHeader,
      );
      publishCompleted = publishResult.success;
      if (!publishResult.success) {
        addSyncJobEvent({
          syncJobId: job.id,
          level: 'warning',
          message: `Import completed but storefront generation may need retry. ${publishResult.error}`,
        });
      } else {
        addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Storefront generation completed.' });
      }
    }

    const syncedAt = new Date().toISOString();
    for (const product of products) {
      updateProductIndex({
        sku: product.sku,
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
        lastSyncedRemoteHash: hashJson(product),
        lastPulledRemoteHash: hashJson(product),
      });
    }
    addSyncJobEvent({ syncJobId: job.id, level: 'info', message: `Marked ${products.length} product(s) as synced.` });

    completeSyncJob(job.id, 'succeeded', { productCount: products.length });

    addAuditLog({
      workspaceId: options.workspaceId,
      entityType: 'change_set',
      entityId: options.changeSetId,
      action: options.publish ? 'push_publish' : 'upload_only',
      message: `${options.publish ? 'Direct push & publish' : 'Upload-only'} completed for ${products.length} product(s)`,
      detailsJson: JSON.stringify({ productSkus: products.map(p => p.sku), publishStatus: options.publish ? (publishCompleted ? 'published' : 'imported_only') : 'skipped' }),
    });

    return {
      status: 200,
      body: {
        success: true,
        jobId: job.id,
        productCount: products.length,
        publishCompleted,
        zipPath,
        warnings: options.publish && !publishCompleted ? ['Storefront generation may need retry.'] : [],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: redactCredentials(msg) });
    completeSyncJob(job.id, 'failed', { errorSummary: redactCredentials(msg) });
    return { status: 500, body: { error: redactCredentials(msg), jobId: job.id } };
  }
}

/**
 * POST /api/sync/push-publish
 * Directly push an approved change set to ShopSite via dbupload -> dbmake -> generate.
 */
route.post('/sync/push-publish', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { changeSetId?: string };
  if (!body.changeSetId) return c.json({ error: 'changeSetId is required.' }, 400);

  const result = await runDirectSync({
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    changeSetId: body.changeSetId,
    publish: true,
  });
  return c.json(result.body, result.status as 200 | 400 | 409 | 500);
});

/**
 * POST /api/sync/upload-only
 * Upload and dbmake only, skip generate.cgi.
 */
route.post('/sync/upload-only', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { changeSetId?: string };
  if (!body.changeSetId) return c.json({ error: 'changeSetId is required.' }, 400);

  const result = await runDirectSync({
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    changeSetId: body.changeSetId,
    publish: false,
  });

  if (result.status === 200) {
    result.body.warning = 'Products imported. Changes may not be visible until storefront is published/regenerated.';
  }
  return c.json(result.body, result.status as 200 | 400 | 409 | 500);
});

/**
 * GET /api/sync/jobs - List sync jobs.
 */
route.get('/sync/jobs', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const jobs = listSyncJobs(workspace.id);
  return c.json({ jobs });
});

/**
 * GET /api/sync/jobs/:id - Job detail with events.
 */
route.get('/sync/jobs/:id', (c) => {
  const id = c.req.param('id');
  const job = findSyncJobById(id);
  if (!job) return c.json({ error: 'Sync job not found.' }, 404);
  const events = listSyncJobEvents(id);
  return c.json({ job, events });
});

/**
 * POST /api/sync/full-reconcile - Maintenance full reconcile/rebuild.
 * Re-indexes from approved product files.
 */
route.post('/sync/full-reconcile', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const job = createSyncJob({ workspaceId: workspace.id, kind: 'full_reconcile' });
  addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Starting full reconcile...' });

  try {
    const productDir = path.join(workspace.workspacePath, 'products');
    let reindexedCount = 0;
    const errors: string[] = [];

    // Clear existing index for full rebuild
    getDb().run('DELETE FROM product_index');
    getDb().run('DELETE FROM product_pages');

    if (fs.existsSync(productDir)) {
      const files = fs.readdirSync(productDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = fs.readFileSync(path.join(productDir, file), 'utf-8');
          const product = JSON.parse(content) as Product;
          const productHash = hashJson(product);
          const existing = findProductBySku(product.sku);
          const fields = {
            sku: product.sku,
            title: product.core.name,
            status: product.status,
            price: product.core.price,
            inventoryQuantity: product.core.inventory.quantityOnHand,
            primaryImage: product.core.media.primary,
            productHash,
            hasAdvancedBlocks: Object.keys(product.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
            hasWarnings: 0,
            syncStatus: 'not_synced',
            description: product.core.description,
            searchKeywords: product.core.seo.searchKeywords,
            customFields: product.customFields,
          };
          if (existing) {
            updateProductIndex(fields);
          } else {
            insertProductIndex({
              id: product.id,
              filePath: skuToProductFilePath(product.sku),
              lastApprovedCommit: null,
              lastPulledRemoteHash: null,
              lastSyncedRemoteHash: null,
              lastSyncedAt: null,
              createdAt: product.metadata.createdAt,
              updatedAt: product.metadata.updatedAt,
              ...fields,
            });
          }

          // Index ProductOnPages into product_pages so category page counts reflect real ShopSite data
          indexProductPageAssignments(product);

          reindexedCount++;
        } catch (err) {
          const msg = `Failed to reindex ${file}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          addSyncJobEvent({ syncJobId: job.id, level: 'warning', message: msg });
        }
      }
    }

    completeSyncJob(job.id, 'succeeded', { productCount: reindexedCount });
    addSyncJobEvent({ syncJobId: job.id, level: 'info', message: `Full reconcile complete: ${reindexedCount} products reindexed.` });

    // Sync field_registry with any newly discovered ProductField keys.
    syncFieldRegistryFromProductIndex(workspace.id, workspace.workspacePath);

    return c.json({ success: true, jobId: job.id, reindexedCount, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
    completeSyncJob(job.id, 'failed', { errorSummary: msg });
    return c.json({ error: msg, jobId: job.id }, 500);
  }
});

export default route;
