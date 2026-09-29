/**
 * Versioned pricing metadata and cost calculation for AI model calls.
 *
 * Rules:
 * - Local routes (`locality === 'local'` or provider `'ollama'`): `estimatedApiCostUsd = 0`, `costBasis = 'local_zero'`.
 * - Known cloud pricing: `estimatedApiCostUsd = calculated`, `costBasis = 'published_rate'`.
 * - Unknown cloud pricing: `estimatedApiCostUsd = null`, `costBasis = 'unknown'`.
 *
 * Drift invariant: every published-price key must be a registered model
 * profile (`assertPublishedPricingRegistered()` returns only unregistered
 * keys, i.e. [] when healthy). Obsolete aliases for models that no longer
 * exist in the registry are removed rather than silently retained.
 */

import { getModelProfile } from './model-registry';

export type CostBasis = 'local_zero' | 'published_rate' | 'unknown';

export interface ModelPricing {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  effectiveAt: string;
}

export interface ApiCostResult {
  estimatedApiCostUsd: number | null;
  costBasis: CostBasis;
}

const PUBLISHED_PRICING: Record<string, ModelPricing> = {
  'deepseek-v4-flash': { inputPerMillion: 0.14, outputPerMillion: 0.28, effectiveAt: '2026-01-01' },
  'deepseek-v4-pro': { inputPerMillion: 0.435, outputPerMillion: 0.87, effectiveAt: '2026-01-01' },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60, effectiveAt: '2026-01-01' },
  // TypeSafe Jev 1.13: $0.042/Mtok input, output tokens free (documented
  // $42/Btok). Output records null so cost is input-only, never zero-filled.
  'jev-1.13.0': { inputPerMillion: 0.042, outputPerMillion: null, effectiveAt: '2026-09-22' },
};

/**
 * Return the published-price keys that are NOT registered model profiles.
 * The pricing table and the model registry are a single catalog; a non-empty
 * result means the lists have drifted and must be reconciled.
 */
export function assertPublishedPricingRegistered(): string[] {
  return Object.keys(PUBLISHED_PRICING).filter((key) => getModelProfile(key) === null);
}

/**
 * Retrieve published pricing rates for a given model.
 */
export function getModelPricing(modelName: string): ModelPricing | null {
  if (!modelName) return null;
  const key = modelName.trim().toLowerCase();
  return PUBLISHED_PRICING[key] ?? null;
}

/**
 * Compute honest API cost estimate. Local models return $0.00 (`local_zero`),
 * known cloud models return calculated USD (`published_rate`), and unlisted
 * cloud models return null (`unknown`).
 */
export function computeApiCost(
  provider: string,
  model: string,
  locality: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
): ApiCostResult {
  const isLocal = locality === 'local' || provider.trim().toLowerCase() === 'ollama';
  if (isLocal) {
    return { estimatedApiCostUsd: 0, costBasis: 'local_zero' };
  }

  const pricing = getModelPricing(model);
  if (!pricing || pricing.inputPerMillion === null) {
    return { estimatedApiCostUsd: null, costBasis: 'unknown' };
  }

  const pTokens = promptTokens ?? 0;
  const inputCost = (pTokens / 1_000_000) * pricing.inputPerMillion;
  // Output-free pricing (TypeSafe Jev: output tokens are free) records
  // input-only cost; unknown completion tokens stay unknown on that leg.
  const outputCost = pricing.outputPerMillion === null ? 0
    : ((completionTokens ?? 0) / 1_000_000) * pricing.outputPerMillion;
  const totalCost = Number((inputCost + outputCost).toFixed(6));

  return {
    estimatedApiCostUsd: totalCost,
    costBasis: 'published_rate',
  };
}
