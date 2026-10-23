/**
 * Catalog Product Evidence Extraction Stage
 *
 * A StageDefinition factory that wraps the shared evidence extractor
 * for catalog products. Captures the product state at creation time
 * so evidence reflects a consistent snapshot.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import type { Product } from '../../shared/types';
import type { PageRow } from '../../db/repositories/page-repo';
import { buildCatalogProductEvidenceInput } from '../catalog-product-source';
import { extractProductEvidence } from '../product-evidence-extractor';
import type { OcrAttemptOutcome, OcrImageDisposition } from '../../shared/schemas/onboarding';

export interface CatalogOcrSummary {
  images: OcrImageDisposition[];
}

/**
 * Persistable per-image OCR summary (A1) for stage metadata: the coded
 * disposition rows from the attempt outcome, verbatim. Null when the
 * outcome carries no per-image rows.
 */
export function buildCatalogOcrSummary(input: { ocrOutcome: OcrAttemptOutcome }): CatalogOcrSummary | null {
  const images = input.ocrOutcome.images;
  if (!images || images.length === 0) return null;
  return { images: images.map(row => ({ ...row })) };
}

/**
 * Create an evidence_extraction stage for a catalog product.
 *
 * The stage captures the product data and page index at the time of
 * creation, ensuring a consistent snapshot for the classification run.
 *
 * @param product - The Product object to classify
 * @param workspacePath - Path to the workspace
 * @param pages - Current page index (for existing page context)
 */
export function createCatalogEvidenceExtractionStage(
  product: Product,
  workspacePath: string,
  pages?: PageRow[],
): StageDefinition {
  const source = buildCatalogProductEvidenceInput(product, workspacePath, pages);

  return {
    name: 'evidence_extraction',
    requires: [],
    evidenceFrom: [],
    execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
      try {
        const result = await extractProductEvidence(source.normalizedInput, input, context);
        const ocrSummary = result.ocrOutcome ? buildCatalogOcrSummary({ ocrOutcome: result.ocrOutcome }) : null;
        const metadata = {
          ...(result.ocrOutcome ? { ocrOutcome: result.ocrOutcome } : {}),
          ...(ocrSummary ? { ocrSummary } : {}),
        };

        if (result.evidence.length === 0) {
          return {
            status: 'abstained',
            reason: 'No new evidence extracted from catalog product.',
            output: { evidence: [], proposals: [], abstained: true, metadata },
          };
        }

        return {
          status: 'succeeded',
          output: {
            evidence: result.evidence,
            proposals: [],
            abstained: false,
            metadata,
          },
        };
      } catch (err: any) {
        return {
          status: 'failed',
          error: `Catalog evidence extraction failed: ${err.message}`,
        };
      }
    },
  };
}
