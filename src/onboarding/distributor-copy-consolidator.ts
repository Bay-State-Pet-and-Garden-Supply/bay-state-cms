/**
 * Raw distributor descriptions are not accepted item evidence and cannot be
 * selected, merged, or returned as customer-facing copy.
 */
import type { EvidenceAttempt } from '../shared/schemas/distributor-evidence';
import type { ModelPolicyView } from '../classification/model-policy-gateway';

export interface DistributorTitleSignal {
  title: string;
  providerId: string;
  attemptId: string;
  confidence: number;
}

export interface ConsolidationResult {
  curatedDescription: string | null;
  sourceAttemptIds: string[];
  warnings: string[];
}

export async function consolidateDistributorCopy(
  _attempts: EvidenceAttempt[],
  _itemName: string,
  _brandHint: string | null,
  _modelPolicy?: ModelPolicyView | null,
): Promise<ConsolidationResult> {
  return {
    curatedDescription: null,
    sourceAttemptIds: [],
    warnings: ['Raw distributor descriptions are not accepted item evidence; use prepareGroundedCopyForItem.'],
  };
}
