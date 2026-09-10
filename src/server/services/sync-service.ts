import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { sanitizeXml } from '../../shopsite/xml-sanitizer';
import { writeProductFile, writeStoreConfig } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashJson } from '../../git/deterministic-json';
import { createSyncJob, completeSyncJob, addSyncJobEvent } from '../../db/repositories/sync-job-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { indexProductPageAssignments } from '../../db/repositories/page-repo';
import { bootstrapSyncRegistry } from './field-metadata-service';
import { upsertMappingValidityFinding } from '../../db/repositories/mapping-validity-repo';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
  type RuntimeConfigAuthority,
} from '../../classification/config-loader';
import { updateBootstrapStatus } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { getDb } from '../../db/connection';
import type { Product } from '../../shared/types';
import type { FieldRegistryEntry } from '../../shared/types';
import type { Workspace } from '../../shared/types';

interface BootstrapResult {
  success: boolean;
  productCount: number;
  commitHash?: string;
  errors: string[];
  warnings: string[];
}

/**
 * D4 (issue #31 commit 3): mapping-validity findings.
 *
 * After the registry merge, compare the incoming xmlField set against the
 * active bundle's attributeMappings and record one finding per mapped field:
 * `field_present = 1` when the Catalog Field appeared in the pull, `0` when it
 * did not. Sync writes findings ONLY — it never writes `isStale` on
 * attributeMappings (isStale is mapping-authority state). A future canonical
 * classification-config reconciliation operation reads these findings and
 * writes isStale through the mapping-editor/activation path.
 */
function emitMappingValidityFindings(workspace: Workspace, entries: Array<Omit<FieldRegistryEntry, 'id'>>): void {
  let authority: RuntimeConfigAuthority;
  try {
    authority = loadRuntimeConfigAuthority(
      workspace.workspacePath,
      createRuntimeActivationContext(workspace.workspacePath, workspace.id),
    );
  } catch {
    // No active classification configuration yet — there are no mappings to
    // attest, so there is nothing to compare against.
    return;
  }
  const mappings = authority.kind === 'v2' ? authority.bundle.attributeMappings : authority.config.attributeMappings;
  const incomingFields = new Set(entries.map(entry => entry.xmlField));
  const detectedAt = new Date().toISOString();
  for (const mapping of mappings) {
    upsertMappingValidityFinding({
      workspaceId: workspace.id,
      catalogField: mapping.catalogField,
      fieldPresent: incomingFields.has(mapping.catalogField) ? 1 : 0,
      detectedAt,
    });
  }
}

/**
 * Bootstrap a workspace from ShopSite XML content (from local file or fetched text).
 */
export function bootstrapFromXml(
  workspace: Workspace,
  xmlContent: string,
  source: 'xml_text' | 'xml_file',
): BootstrapResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const workspacePath = workspace.workspacePath;
  const workspaceId = workspace.id;
  const now = new Date().toISOString();

  // Create sync job
  const job = createSyncJob({
    workspaceId,
    kind: source === 'xml_file' ? 'bootstrap' : 'bootstrap',
    metadataJson: JSON.stringify({ source, timestamp: now }),
  });

  addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Starting bootstrap...' });

  try {
    updateBootstrapStatus(workspaceId, 'running');

    // Sanitize and decode XML via ShopSiteProductCodec
    const cleanXml = sanitizeXml(xmlContent);
    const decoded = ShopSiteProductCodec.decode(cleanXml, { workspaceId });

    addSyncJobEvent({
      syncJobId: job.id, level: 'info',
      message: `Parsed ${decoded.products.length} products from XML (version ${decoded.xmlVersion})`,
    });

    if (decoded.products.length === 0) {
      errors.push('No products found in XML data.');
      completeSyncJob(job.id, 'failed', { errorSummary: errors.join('; '), productCount: 0 });
      updateBootstrapStatus(workspaceId, 'failed');
      return { success: false, productCount: 0, errors, warnings };
    }

    // Filter valid products and collect registry observations
    const products: Product[] = [];
    const allRegistryEntries: Omit<FieldRegistryEntry, 'id'>[] = [...decoded.registryObserved];
    const seenSkus = new Set<string>();

    for (const product of decoded.products) {
      if (!product.sku) {
        warnings.push(`Product "${product.core.name || '(unnamed)'}" has no SKU and will be skipped.`);
        continue;
      }
      const skuTrimmed = product.sku.trim();
      if (seenSkus.has(skuTrimmed)) {
        warnings.push(`Product "${product.core.name || '(unnamed)'}" skipped because SKU "${skuTrimmed}" is a duplicate.`);
        continue;
      }
      seenSkus.add(skuTrimmed);
      products.push(product);
    }

    if (products.length === 0) {
      errors.push('No syncable products found after normalization (all missing SKU).');
      completeSyncJob(job.id, 'failed', { errorSummary: errors.join('; '), productCount: 0 });
      updateBootstrapStatus(workspaceId, 'failed');
      return { success: false, productCount: 0, errors, warnings };
    }

    // Deduplicate registry entries (keep first occurrence)
    const seenFields = new Set<string>();
    const uniqueRegistry = allRegistryEntries.filter(e => {
      if (seenFields.has(e.xmlField)) return false;
      seenFields.add(e.xmlField);
      return true;
    });

    // Write product files
    for (const product of products) {
      writeProductFile(workspacePath, product);
    }

    // Field registry: D2 property-level merge through the canonical
    // field-metadata service. Curated metadata (per curated_fields_json)
    // survives the pull, sampleValuesJson is refreshed from the observation,
    // fields absent from the pull are kept (no clearRegistry), and the R2
    // attestation is rewritten from R1.
    bootstrapSyncRegistry({ id: workspaceId, workspacePath }, uniqueRegistry);

    // D4: mapping-validity findings (findings only — never isStale). Best
    // effort: a failure here must not fail the bootstrap.
    try {
      emitMappingValidityFindings(workspace, uniqueRegistry);
    } catch (err) {
      console.warn('[SyncService] mapping-validity findings emission failed (non-fatal):', err);
    }

    // Write store configs
    writeStoreConfig(workspacePath, 'manifest.json', {
      workspaceName: workspace.name,
      workspaceId,
      appVersion: '0.1.0',
      schemaVersion: 1,
      productCount: products.length,
      generatedAt: now,
      baselineCommit: null,
    });

    // Seed product index and product page assignments in SQLite
    getDb().run('DELETE FROM product_index');
    getDb().run('DELETE FROM product_pages');

    for (const product of products) {
      const productHash = hashJson(product);
      const hasAdvanced = product.shopsite.preserved.advancedBlocks
        && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0;

      insertProductIndex({
        id: product.id,
        sku: product.sku,
        filePath: skuToProductFilePath(product.sku),
        title: product.core.name,
        status: product.status,
        price: product.core.price,
        inventoryQuantity: product.core.inventory.quantityOnHand,
        primaryImage: product.core.media.primary,
        productHash,
        lastApprovedCommit: null,
        lastPulledRemoteHash: productHash,
        lastSyncedRemoteHash: productHash,
        lastSyncedAt: now,
        syncStatus: 'synced',
        hasAdvancedBlocks: hasAdvanced ? 1 : 0,
        hasWarnings: warnings.length > 0 ? 1 : 0,
        createdAt: product.metadata.createdAt,
        updatedAt: product.metadata.updatedAt,
        description: product.core.description,
        searchKeywords: product.core.seo.searchKeywords,
        customFields: product.customFields,
      });

      // Index ProductOnPages into product_pages so category page counts reflect real ShopSite data
      indexProductPageAssignments(product);
    }

    // Git commit
    const git = new GitClient(workspacePath);
    try {
      git.add(['products/', 'store/', '.gitignore']);
      const versionInfo = `ShopSite XML version ${decoded.xmlVersion}`;
      git.commit(`Initial ShopSite product bootstrap (${products.length} products, ${versionInfo})`);
      const commitHash = git.getHeadHash();

      updateBootstrapStatus(workspaceId, 'complete', commitHash);

      // Set lastApprovedCommit on all indexed products to the initial baseline commit
      const db = getDb();
      db.run('UPDATE product_index SET last_approved_commit = ?', [commitHash]);

      completeSyncJob(job.id, 'succeeded', {
        productCount: products.length,
      });

      addSyncJobEvent({
        syncJobId: job.id, level: 'info',
        message: `Bootstrap complete: ${products.length} products imported, commit: ${commitHash}`,
      });

      addAuditLog({
        workspaceId,
        entityType: 'workspace',
        entityId: workspaceId,
        action: 'bootstrap',
        message: `Bootstrapped ${products.length} products from XML (${source})`,
        detailsJson: JSON.stringify({ productCount: products.length, source, commitHash, warnings: warnings.length > 0 ? warnings : undefined }),
      });

      return { success: true, productCount: products.length, commitHash, errors, warnings };
    } catch (err) {
      const msg = `Git operation failed: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      completeSyncJob(job.id, 'failed', { errorSummary: msg, productCount: products.length });
      updateBootstrapStatus(workspaceId, 'failed');
      addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
      return { success: false, productCount: products.length, errors, warnings };
    }
  } catch (err) {
    const msg = `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    completeSyncJob(job.id, 'failed', { errorSummary: msg });
    updateBootstrapStatus(workspaceId, 'failed');
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
    return { success: false, productCount: 0, errors, warnings };
  }
}
