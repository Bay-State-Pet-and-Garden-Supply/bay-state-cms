/**
 * Product Retrieval Service
 *
 * Vector similarity search over approved products behind the replaceable
 * retrieval-index interface. Exact cosine search is isolated in
 * `retrieval-index.ts`; corrupt vectors and dimension mismatches are ERRORS
 * (never zero-similarity results). Production retrieval requests fail closed
 * to a policy-disabled response unless the productionRetrieval feature is
 * enabled with a verified receipt and activation audit.
 */

import { fetchEmbedding } from './embedding-client';
import * as embeddingRepo from '../db/repositories/embedding-repo';
import * as classRunRepo from '../db/repositories/classification-run-repo';
import { InMemoryRetrievalIndex, embeddingDocumentId, type VectorEntry, type RetrievalIndex } from './retrieval-index';
import { evaluateFeaturePolicy, type FeaturePolicyOptions } from './feature-policy';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import { pageNameFromPageValue } from '../shared/proposal-display';

export interface SimilarProduct {
  sku: string;
  similarity: number;
  productName: string;
  productType: string | null;
  acceptedPages: string[];
  acceptedFields: Record<string, string>;
}

export interface RetrievalOptions {
  topK?: number;          // default 5
  minSimilarity?: number; // default 0.60
  excludeSkus?: string[];
  model?: string;         // default 'nomic-embed-text'
  provider?: string;
  /** Scope for the request. Production requires the feature policy gate. */
  scope?: 'production' | 'evaluation';
  /** Explicit request token required for evaluation scope. */
  evaluationRequestToken?: string;
  /** Injectable fetch for mocked-HTTP tests. */
  fetch?: typeof fetch;
  /** When provided, production access is gated on this feature policy. */
  modelPolicy?: ModelPolicyConfigV2 | null;
  featurePolicyOptions?: FeaturePolicyOptions;
}

export class RetrievalPolicyDisabledError extends Error {
  readonly code = 'retrieval_policy_disabled';
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'RetrievalPolicyDisabledError';
    this.reason = reason;
  }
}

/**
 * Assert that production retrieval is permitted. The approved Bay State
 * configuration keeps productionRetrieval disabled, so production requests
 * fail closed with a policy-disabled error.
 */
export function assertProductionRetrievalAllowed(
  modelPolicy: ModelPolicyConfigV2 | null | undefined,
  featurePolicyOptions?: FeaturePolicyOptions,
): void {
  if (!modelPolicy) {
    throw new RetrievalPolicyDisabledError('Production retrieval requires a model policy; none configured.');
  }
  const decision = evaluateFeaturePolicy(modelPolicy, {
    feature: 'productionRetrieval',
    scope: 'production',
  }, featurePolicyOptions);
  if (decision.state !== 'enabled') {
    throw new RetrievalPolicyDisabledError(`Production retrieval is policy-disabled: ${decision.reason}`);
  }
}

/** Convert stored rows into validated vector entries behind the index. */
function loadRetrievalIndex(
  workspaceId: string,
  model: string,
  provider: string,
  namespace: 'production' | 'evaluation' = 'production',
): RetrievalIndex {
  const index = new InMemoryRetrievalIndex();
  const rows = embeddingRepo.getAllEmbeddings(workspaceId, model, namespace);
  for (const row of rows) {
    const vector = embeddingRepo.deserializeEmbedding(row.embedding_blob);
    // Validation happens at upsert time in the index (throws, never zero-sim).
    const entry: VectorEntry = {
      id: embeddingDocumentId(row.workspace_id, row.product_sku, (row.namespace ?? 'production') as 'production' | 'evaluation', row.embedding_model),
      workspaceId: row.workspace_id,
      sku: row.product_sku,
      namespace: (row.namespace ?? 'production') as 'production' | 'evaluation',
      model: row.embedding_model,
      provider: row.provider ?? provider,
      dimension: row.embedding_dim,
      schemaVersion: row.schema_version ?? 1,
      vector,
      text: row.embedding_text,
      sourceHash: row.source_hash,
      configHash: row.source_config_hash ?? row.config_hash ?? null,
      decisionRunId: row.decision_run_id ?? row.run_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      failureStatus: row.failure_status ?? null,
    };
    index.upsert(entry);
  }
  return index;
}

/**
 * Find similar approved products using exact cosine similarity behind the
 * retrieval-index interface.
 */
export async function findSimilarApprovedProducts(
  workspaceId: string,
  queryText: string,
  queryEmbeddingOrOptions?: Float32Array | RetrievalOptions,
  options?: RetrievalOptions,
): Promise<SimilarProduct[]> {
  const hasVector = queryEmbeddingOrOptions instanceof Float32Array;
  const opts: RetrievalOptions = hasVector ? (options || {}) : (queryEmbeddingOrOptions || options || {});
  const model = opts.model || 'nomic-embed-text';
  const provider = opts.provider || 'ollama';
  const namespace = opts.scope === 'evaluation' ? 'evaluation' : 'production';

  // Fail closed BEFORE any embedding call: production requires the feature
  // policy gate; evaluation requires an explicit request token. A disabled
  // production request never contacts an embedding service.
  if (namespace === 'production') {
    assertProductionRetrievalAllowed(opts.modelPolicy, opts.featurePolicyOptions);
  } else if (!opts.evaluationRequestToken) {
    throw new RetrievalPolicyDisabledError('Evaluation-scope retrieval requires an explicit evaluationRequestToken.');
  }

  let queryVector: Float32Array;
  if (hasVector) {
    queryVector = queryEmbeddingOrOptions as Float32Array;
  } else {
    const response = await fetchEmbedding(queryText, { model, provider, fetch: opts.fetch });
    queryVector = response.vector;
  }

  const topK = opts.topK ?? 5;
  const minSimilarity = opts.minSimilarity ?? 0.60;
  const excludeSet = new Set(opts.excludeSkus || []);

  const index = loadRetrievalIndex(workspaceId, model, provider, namespace);
  const excludeIds = new Set(Array.from(excludeSet).map(sku => embeddingDocumentId(workspaceId, sku, namespace, model)));
  const hits = index.search(queryVector, { topK, minSimilarity, excludeIds });

  const results: SimilarProduct[] = [];

  for (const hit of hits) {
    const sku = hit.entry.sku;
    const run = classRunRepo.getRecentRun(workspaceId, sku);
    let productType: string | null = null;
    const acceptedPages: string[] = [];
    const acceptedFields: Record<string, string> = {};

    if (run) {
      const proposals = classRunRepo.getProposalsByRun(run.id);
      const decisions = classRunRepo.getLiveDecisionsByRun(run.id);

      for (const proposal of proposals) {
        const decision = decisions.find(d => d.proposalId === proposal.id);
        if (decision && decision.decision === 'accepted') {
          const proposed = typeof proposal.proposedValue === 'string' ? proposal.proposedValue : '';
          const val = (decision.hasRevisedValue && typeof decision.revisedValue === 'string')
            ? decision.revisedValue
            : proposed;

          const target = (decision.hasRevisedTargetId && typeof decision.revisedTargetId === 'string')
            ? decision.revisedTargetId
            : (typeof proposal.targetId === 'string' ? proposal.targetId : '');

          // ADR 0041: legacy `primary_product_type` rows are history-only;
          // only the canonical pair contributes the live display value.
          if (proposal.proposalType === 'product_classification') {
            productType = val !== '' ? val : (typeof proposal.targetId === 'string' ? proposal.targetId : null);
          } else if (proposal.proposalType === 'category_page') {
            // Display name from the effective value — never the Page ID
            // (issue #17 D1).
            const pageName = pageNameFromPageValue(
              decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
            );
            if (pageName) acceptedPages.push(pageName);
          } else if (proposal.proposalType === 'field_assignment' && target) {
            acceptedFields[target] = val;
          }
        }
      }
    }

    results.push({
      sku,
      similarity: hit.similarity,
      productName: hit.entry.text.split(' | ')[0] || sku,
      productType,
      acceptedPages,
      acceptedFields,
    });
  }

  return results;
}


// ─── Benchmark retrieval index (train-only, leakage-free) ──────────────────────

import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import {
  buildBenchmarkRetrievalIndex,
  type BenchmarkIndexBuildResult,
  type BenchmarkIndexExample,
} from './retrieval-index';

export interface BuildBenchmarkIndexFromDatasetOptions {
  model?: string;
  provider?: string;
  /** Injectable embedding call (mocked in tests; never a live model). */
  embed?: (text: string) => Promise<Float32Array>;
  fetch?: typeof fetch;
  expectedDimension?: number;
}

export interface BenchmarkSearchOptions {
  topK?: number;
  minSimilarity?: number;
  model?: string;
  provider?: string;
  /** Injectable embedding call for the query. */
  embed?: (text: string) => Promise<Float32Array>;
  fetch?: typeof fetch;
}

/**
 * Build a benchmark retrieval index from the TRAIN split of a frozen
 * dataset. Holdout/test examples never enter the index, so their gold labels
 * cannot leak. Every entry carries its product family for search-time
 * exclusion. Generation is deterministic when the embedding seam is.
 */
export async function buildBenchmarkRetrievalIndexFromDataset(
  workspaceId: string,
  datasetId: string,
  options: BuildBenchmarkIndexFromDatasetOptions = {},
): Promise<BenchmarkIndexBuildResult> {
  const dataset = benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Benchmark retrieval index requires a frozen dataset; dataset is ${dataset.status}.`);
  }

  const trainExamples = benchmarkRepo.getExamples(datasetId, 'train');
  const model = options.model ?? 'nomic-embed-text';
  const provider = options.provider ?? 'ollama';
  const embed = options.embed ?? (async (text: string) => {
    const response = await fetchEmbedding(text, { model, provider, fetch: options.fetch });
    return response.vector;
  });

  const examples: BenchmarkIndexExample[] = [];
  for (const example of trainExamples) {
    let evidenceText: string;
    try {
      const snapshot = JSON.parse(example.input_snapshot_json || '{}') as { evidence?: Array<{ snippet?: string }> };
      evidenceText = (snapshot.evidence ?? [])
        .map(e => e.snippet ?? '')
        .filter(s => s.length > 0)
        .join(' ')
        .slice(0, 2000);
    } catch {
      evidenceText = '';
    }
    if (!evidenceText) continue;

    let productType: string | null;
    try {
      const gold = JSON.parse(example.gold_labels_json) as { productType?: string | null };
      productType = gold.productType ?? null;
    } catch {
      productType = null;
    }

    const vector = await embed(evidenceText);
    examples.push({
      id: example.id,
      workspaceId,
      datasetId,
      sku: example.product_sku,
      familyId: example.product_family_id,
      text: evidenceText,
      vector,
      productType,
    });
  }

  return buildBenchmarkRetrievalIndex(examples, { expectedDimension: options.expectedDimension });
}

/**
 * Search a benchmark index for a query text, excluding the query's own SKU
 * and family so same-family/self examples never leak into results.
 */
export async function searchBenchmarkRetrievalIndex(
  index: Awaited<ReturnType<typeof buildBenchmarkRetrievalIndexFromDataset>>['index'],
  queryText: string,
  query: { sku?: string; familyId?: string | null },
  options: BenchmarkSearchOptions = {},
): Promise<Array<{ entryId: string; sku: string; similarity: number }>> {
  const model = options.model ?? 'nomic-embed-text';
  const provider = options.provider ?? 'ollama';
  const embed = options.embed ?? (async (text: string) => {
    const response = await fetchEmbedding(text, { model, provider, fetch: options.fetch });
    return response.vector;
  });

  const queryVector = await embed(queryText);
  const excludeSkus = query.sku ? [query.sku] : [];
  const excludeFamilies = query.familyId ? [query.familyId] : [];
  const hits = index.search(queryVector, {
    topK: options.topK ?? 10,
    minSimilarity: options.minSimilarity ?? 0,
    excludeSkus,
    excludeFamilies,
  });
  return hits.map(hit => ({
    entryId: hit.entry.id,
    sku: hit.entry.sku,
    similarity: hit.similarity,
  }));
}
