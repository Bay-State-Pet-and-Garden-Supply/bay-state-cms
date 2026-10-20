import fs from 'fs';
import path from 'path';
import { ShopSiteProductCodec, assertNoPreservedCorruption } from './product-codec';
import { deterministicStringify } from '../git/deterministic-json';
import { createImagesZip, assertZipHasImages } from './zip-generator';
import type { Product } from '../shared/types';
import type { LinkedManifest } from '../shared/schemas/change-set';
export interface ExportPackageResult {
  exportDir: string;
  xmlPath: string;
  manifestPath: string;
  instructionsPath: string;
  /** Null when every referenced image is absent from disk (XML-only package). */
  zipPath: string | null;
  productCount: number;
  /** Set when the package shipped XML-only because images are absent from disk. */
  missingImagesWarning?: string;
}

/**
 * Create an export package for a set of changed products.
 * Generates XML, manifest, and upload instructions.
 */
export async function createExportPackage(
  workspacePath: string,
  changeSetId: string,
  products: Product[],
  options?: {
    xmlVersion?: string;
    newProductTag?: string;
    changeSetTitle?: string;
    approvedCommit?: string;
    linkedManifest?: LinkedManifest;
    /** Issue #373: exact hash of the complete-family upload payload bytes. */
    pushPayloadHash?: string;
    /** Issue #373: stable SKU document order of the complete upload set. */
    pushSkus?: string[];
  },
): Promise<ExportPackageResult> {
  const exportDir = path.join(workspacePath, 'exports', changeSetId);
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  // Generate XML. Fail closed when drafts still carry the "[object Object]"
  // sentinel: a corrupted export would destroy live preserved blocks on upload.
  assertNoPreservedCorruption(products);
  const xml = ShopSiteProductCodec.encodeMany(products, {
    xmlVersion: options?.xmlVersion,
    newProductTag: options?.newProductTag,
  }).xml;

  const xmlPath = path.join(exportDir, 'shopsite-products.xml');
  fs.writeFileSync(xmlPath, xml, 'utf-8');

  // Generate images zip. When every referenced image is absent from disk
  // (P2 #24), ship an XML-only package with an explicit warning instead of
  // failing: the XML references stay intact and the manifest records that
  // no ZIP was claimed. Malformed preserved XML still fails closed above.
  const zipPath = path.join(exportDir, 'shopsite-images.zip');
  await createImagesZip(workspacePath, products, zipPath);
  let missingImagesWarning: string | undefined;
  try {
    assertZipHasImages(zipPath, products);
  } catch {
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch {
      // ignore cleanup failure
    }
    const totalRefs = products.reduce((count, p) => {
      let n = p.core?.media?.primary ? 1 : 0;
      n += (p.core?.media?.additional || []).filter(Boolean).length;
      return count + n;
    }, 0);
    missingImagesWarning =
      `${totalRefs} image(s) referenced by this change set are absent from disk; ` +
      `exported XML only with no images ZIP. Run the image repair tool to re-download ` +
      `images from onboarding extraction data, then re-export.`;
  }

  // Generate manifest. Issue #363: approved export data and its dependency
  // manifest describe the same immutable catalog commit — the package is
  // commit-bound, never mutable-workspace-bound.
  const linkedManifest = options?.linkedManifest;
  const manifest = {
    schemaVersion: 1,
    changeSetId,
    changeSetTitle: options?.changeSetTitle ?? changeSetId,
    generatedAt: new Date().toISOString(),
    productCount: products.length,
    productSkus: products.map(p => p.sku),
    xmlVersion: options?.xmlVersion ?? '15.0',
    notes: 'Export package for ShopSite product import.',
    imagesZip: missingImagesWarning ? null : path.basename(zipPath),
    ...(options?.approvedCommit ? { approvedCommit: options.approvedCommit } : {}),
    ...(linkedManifest ? { linkedManifest } : {}),
    ...(options?.pushPayloadHash ? { pushPayloadHash: options.pushPayloadHash } : {}),
    ...(options?.pushSkus ? { pushSkus: options.pushSkus } : {}),
    ...(missingImagesWarning ? { warning: missingImagesWarning } : {}),
  };
  const manifestPath = path.join(exportDir, 'manifest.json');
  fs.writeFileSync(manifestPath, deterministicStringify(manifest), 'utf-8');

  // Generate upload instructions
  const instructionsPath = path.join(exportDir, 'upload-instructions.md');
  const instructions = generateInstructions(products.length, changeSetId);
  fs.writeFileSync(instructionsPath, instructions, 'utf-8');

  return {
    exportDir,
    xmlPath,
    manifestPath,
    instructionsPath,
    zipPath: missingImagesWarning ? null : zipPath,
    productCount: products.length,
    ...(missingImagesWarning ? { missingImagesWarning } : {}),
  };
}

function generateInstructions(productCount: number, changeSetId: string): string {
  return `# Bay State CMS Export — Upload Instructions

## Overview

This export package contains ${productCount} product(s) from change set "${changeSetId}".

## Files

- \`shopsite-products.xml\` — Product XML data to import
- \`manifest.json\` — Export metadata
- \`upload-instructions.md\` — This file

## How to Import

### Option 1: Direct XML upload (if you have CGI access)

1. Open a browser and go to your ShopSite admin backoffice.
2. Navigate to the **Database Upload** tool.
3. Upload \`shopsite-products.xml\` using the form.
4. Set the **Match Upload Fields** to **SKU** (or your configured matching key).
5. Set **Add New Records** to **Yes**.
6. Review the import results page.
7. If prompted, run \`dbmake.cgi\` with the returned parameters.

### Option 2: MIME multipart upload (automated)

If you have a script or integration tool:

1. POST \`shopsite-products.xml\` to \`dbupload.cgi\` as a MIME multipart form with:
   - \`clientApp=1\`
   - \`dbname=products\`
   - \`uniqueName=SKU\`
   - \`newRecords=yes\`
   - \`defer_linking=no\`

2. After upload, call \`dbmake.cgi\` with the \`return_string\` **exactly as returned**.
3. After import, regenerate/publish the store so changes are visible to shoppers:
   - Visit \`generate.cgi\` with \`clientApp=1\`, \`htmlpages=1\`, \`index=1\`
   - Or use your ShopSite admin's **Publish** feature.

## Important Notes

- **Authentication** for automated CGI calls is environment-specific and may require Basic auth, IP whitelisting, or browser session cookies.
- This import will **update existing products** (matched by SKU) and **create new ones** for SKUs not found in ShopSite.
- **Unmatched products** in the source XML that do not have a valid SKU may be skipped or fail.
- After import, always **publish/regenerate** the storefront or shoppers will not see the changes.
- If you encounter unexpected results, export a fresh sample from ShopSite \`db_xml.cgi\` and compare the XML structure.

## ShopSite Documentation Reference

The import workflow follows the documented ShopSite automated database XML upload flow:
- Database Automated XML Upload/Download
- MIME Encoded XML Upload
- Database XML Upload/Download SDK

## v1 Scope Note

This export package was generated by Bay State CMS v1, which supports product imports only.
Page imports and media uploads are not yet supported.
`;
}
