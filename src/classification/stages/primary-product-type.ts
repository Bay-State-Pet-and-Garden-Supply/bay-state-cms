/**
 * Primary Product Type Proposal Stage
 *
 * Thin wrapper around the shared frozen target resolver. It delegates
 * canonical Product Classification to the shared processor.
 *
 * Product Classification is processed only when the immutable run snapshot
 * contains its approved target configuration.
 *
 * Dependencies: Evidence from evidence_extraction stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { processProductTypeTarget } from '../curation-target-processor';

export const primaryProductTypeStage: StageDefinition = {
  name: 'primary_product_type_proposal',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    if (!context.snapshot) {
      return {
        status: 'abstained',
        reason: 'Product Classification requires a frozen classification snapshot.',
      };
    }
    const resolved = resolveTargetsFromSnapshot(context.snapshot);

    // If Product Type is not an enabled curation target, return succeeded
    // with empty proposals (NOT abstained, to avoid noisy reviewable_abstention).
    if (resolved.productTypes.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'Product Type is not enabled as a curation target.',
        },
      };
    }

    // Target exists but has no options configured
    if (resolved.productTypes[0].options.length === 0) {
      return {
        status: 'abstained',
        reason: 'No product type options configured. Add product types in store/classification/product-types.json.',
      };
    }

    // Delegate to shared processor
    const result = await processProductTypeTarget(resolved.productTypes[0], input, context);

    if (result.proposals.length === 0) {
      return {
        status: 'abstained',
        reason: `No confident product type match found: ${result.message}`,
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: result.proposals,
        abstained: false,
        message: result.message,
      },
    };
  },
};
