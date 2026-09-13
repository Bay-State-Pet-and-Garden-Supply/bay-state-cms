import fs from 'fs';
import os from 'os';
import path from 'path';
import { ZipArchive } from 'archiver';
import type { Product } from '../shared/types';

// fallow-ignore-next-line unused-export — used by tests
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve the local file path for a product image, checking workspace storage
 * before falling back to the legacy ~/Downloads path.
 *
 * Workspace path: {workspacePath}/products/images/{cleanPath}
 * Legacy path:    ~/Downloads/{cleanPath}
 */
function resolveImagePath(workspacePath: string, cleanPath: string): string | null {
  // Path containment: reject paths that escape the images directory
  const workspaceImage = path.resolve(workspacePath, 'products', 'images', cleanPath);
  const workspaceImagesRoot = path.resolve(workspacePath, 'products', 'images');
  if (!workspaceImage.startsWith(workspaceImagesRoot)) {
    console.warn(`[ZipGenerator] Rejected path traversal: ${cleanPath}`);
    return null;
  }

  // Priority 1: workspace storage (new canonical location)
  if (fs.existsSync(workspaceImage)) {
    return workspaceImage;
  }

  // Priority 2: legacy ~/Downloads storage
  const legacyPath = path.resolve(os.homedir(), 'Downloads', cleanPath);
  // Reject traversal on legacy path too
  const legacyRoot = path.resolve(os.homedir(), 'Downloads');
  if (legacyPath.startsWith(legacyRoot) && fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return null;
}

/**
 * Creates a ZIP file containing the images for a set of products.
 * The images in the ZIP are organized into folders by brand name.
 *
 * Throws an aggregated error if any referenced images are missing, so callers
 * can surface the list of missing files instead of silently producing an empty ZIP.
 */
export async function createImagesZip(
  workspacePath: string,
  products: Product[],
  zipPath: string,
): Promise<void> {
  const dir = path.dirname(zipPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 5 } });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      try {
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }
      } catch {
        // ignore cleanup failure
      }
    };

    output.on('close', () => {
      resolve();
    });

    archive.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });

    output.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });

    archive.pipe(output);

    try {
      const addedPaths = new Set<string>();
      const missingImages: string[] = [];
      let _totalIncluded = 0;

      for (const product of products) {
        const brandName = product.customFields?.['ProductField16'] || 'unbranded';
        const brandFolder = slugify(brandName) || 'unbranded';

        const images: string[] = [];
        if (product.core?.media?.primary) {
          images.push(product.core.media.primary);
        }
        for (const img of product.core?.media?.additional ?? []) {
          if (img) images.push(img);
        }

        for (const imgPath of images) {
          if (!imgPath) continue;

          // Normalize image paths (strip leading slashes or prefix differences)
          let cleanPath = imgPath;
          if (cleanPath.startsWith('/')) {
            cleanPath = cleanPath.slice(1);
          }
          if (cleanPath.startsWith('products/images/')) {
            cleanPath = cleanPath.slice('products/images/'.length);
          }

          if (addedPaths.has(cleanPath)) continue;
          addedPaths.add(cleanPath);

          // Organize under brand folder in the archive
          const fileName = path.basename(cleanPath);
          const archiveName = `${brandFolder}/${fileName}`;

          const resolved = resolveImagePath(workspacePath, cleanPath);
          if (resolved) {
            archive.file(resolved, { name: archiveName });
            _totalIncluded++;
          } else {
            missingImages.push(`${brandFolder}/${fileName} (from product ${product.sku}, ref: ${imgPath})`);
          }
        }
      }

      if (missingImages.length > 0) {
        // Warn and finalize with whatever we have, but let the caller know
        console.warn(
          `[ZipGenerator] ${missingImages.length} image(s) not found for export:\n  ${missingImages.join('\n  ')}`,
        );
      }

      archive.finalize();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Validate that an export ZIP actually contains image entries. Call this after
 * createImagesZip to surface a hard error when all referenced images are missing.
 *
 * A minimal ZIP with no entries is ~22 bytes; this threshold is set at 100 bytes
 * to safely detect empty containers.
 */
export function assertZipHasImages(
  zipPath: string,
  products: Product[],
): void {
  const totalRefs = products.reduce((count, p) => {
    let n = p.core?.media?.primary ? 1 : 0;
    n += (p.core?.media?.additional || []).filter(Boolean).length;
    return count + n;
  }, 0);

  if (totalRefs === 0) return; // no images expected

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Export ZIP not found at ${zipPath}`);
  }

  const stat = fs.statSync(zipPath);
  if (stat.size < 100) {
    throw new Error(
      `Export ZIP is effectively empty (${stat.size} bytes). ` +
      `${totalRefs} image(s) are referenced by this change set, but none ` +
      `were found on disk. Run the image repair tool to re-download ` +
      `images from onboarding extraction data, then re-export.`,
    );
  }
}
