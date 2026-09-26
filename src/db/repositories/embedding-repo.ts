import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { serializeEmbedding, deserializeEmbedding as deserializeEmbeddingVector } from '../../classification/embedding-client';
import type { EmbeddingNamespace } from '../../classification/embedding-client';

export interface ProductEmbeddingRow {
  id: string;
  workspace_id: string;
  product_sku: string;
  embedding_model: string;
  embedding_text: string;
  embedding_blob: Buffer;
  embedding_dim: number;
  source_hash: string;
  created_at: string;
  // v2 columns (present after the embedding v2 migration)
  namespace?: string;
  model_fingerprint?: string;
  provider?: string;
  schema_version?: number;
  config_hash?: string | null;
  decision_hash?: string | null;
  document_hash?: string | null;
  run_id?: string | null;
  failure_status?: string | null;
  updated_at?: string;
  // legacy v2 column names from the first embedding-v2 migration draft
  source_config_hash?: string | null;
  decision_run_id?: string | null;
}

export interface EmbeddingDocumentInput {
  workspaceId: string;
  sku: string;
  model: string;
  provider: string;
  namespace: EmbeddingNamespace;
  text: string;
  sourceHash: string;
  configHash: string | null;
  decisionHash: string | null;
  runId: string | null;
  documentHash: string;
  vector: Float32Array;
}

/**
 * Legacy-compatible upsert (production namespace, provider 'ollama').
 * Kept for existing callers; new callers should use upsertEmbeddingDocument.
 */
export function upsertEmbedding(
  workspaceId: string,
  productSku: string,
  model: string,
  text: string,
  embedding: Float32Array,
  sourceHash: string,
): void {
  const doc = {
    workspaceId,
    sku: productSku,
    model,
    provider: 'ollama',
    namespace: 'production' as const,
    text,
    sourceHash,
    configHash: null,
    decisionHash: null,
    runId: null,
    documentHash: sourceHash,
    vector: embedding,
  };
  upsertEmbeddingDocument(doc);
}

function upsertEmbeddingDocument(input: EmbeddingDocumentInput): void {
  const db = getDb();
  const blob = serializeEmbedding(input.vector);
  const now = new Date().toISOString();
  const rowId = randomUUID();
  db.query(`
    INSERT INTO product_embeddings (
      id, workspace_id, product_sku, embedding_model, embedding_text, embedding_blob,
      embedding_dim, source_hash, created_at, namespace, model_fingerprint, provider,
      schema_version, config_hash, decision_hash, document_hash, run_id, failure_status, updated_at
    ) VALUES (
      $id, $workspaceId, $productSku, $model, $text, $blob,
      $dim, $sourceHash, $createdAt, $namespace, $fingerprint, $provider,
      $schemaVersion, $configHash, $decisionHash, $documentHash, $runId, $failureStatus, $updatedAt
    )
    ON CONFLICT(workspace_id, product_sku, embedding_model, namespace) DO UPDATE SET
      embedding_text = excluded.embedding_text,
      embedding_blob = excluded.embedding_blob,
      embedding_dim = excluded.embedding_dim,
      source_hash = excluded.source_hash,
      model_fingerprint = excluded.model_fingerprint,
      provider = excluded.provider,
      schema_version = excluded.schema_version,
      config_hash = excluded.config_hash,
      decision_hash = excluded.decision_hash,
      document_hash = excluded.document_hash,
      run_id = excluded.run_id,
      failure_status = excluded.failure_status,
      updated_at = excluded.updated_at
  `).run({
    $id: rowId,
    $workspaceId: input.workspaceId,
    $productSku: input.sku,
    $model: input.model,
    $text: input.text,
    $blob: blob,
    $dim: input.vector.length,
    $sourceHash: input.sourceHash,
    $createdAt: now,
    $namespace: input.namespace,
    $fingerprint: fingerprintFor(input.model, input.provider),
    $provider: input.provider,
    $schemaVersion: 1,
    $configHash: input.configHash,
    $decisionHash: input.decisionHash,
    $documentHash: input.documentHash,
    $runId: input.runId,
    $failureStatus: null,
    $updatedAt: now,
  });
}

/** v2 upsert used by maintenance/retrieval (document-bound provenance). */
export interface EmbeddingV2UpsertInput {
  workspaceId: string;
  productSku: string;
  model: string;
  provider: string;
  text: string;
  embedding: Float32Array;
  dimension: number;
  sourceHash: string;
  namespace: EmbeddingNamespace;
  schemaVersion: number;
  sourceConfigHash?: string | null;
  decisionRunId?: string | null;
  documentHash?: string;
  updatedAt?: string;
}

export function upsertEmbeddingV2(input: EmbeddingV2UpsertInput): void {
  const doc: EmbeddingDocumentInput = {
    workspaceId: input.workspaceId,
    sku: input.productSku,
    model: input.model,
    provider: input.provider,
    namespace: input.namespace,
    text: input.text,
    sourceHash: input.sourceHash,
    configHash: input.sourceConfigHash ?? null,
    decisionHash: null,
    runId: input.decisionRunId ?? null,
    documentHash: input.documentHash ?? input.sourceHash,
    vector: input.embedding,
  };
  upsertEmbeddingDocument(doc);
}

/** Rows in a namespace for one model (maintenance desired-set load). */
export function getEmbeddingsByNamespace(
  workspaceId: string,
  namespace: EmbeddingNamespace,
  model?: string,
): ProductEmbeddingRow[] {
  const db = getDb();
  if (model) {
    return db
      .query(
        `SELECT * FROM product_embeddings
         WHERE workspace_id = $workspaceId AND namespace = $namespace AND embedding_model = $model`,
      )
      .all({ $workspaceId: workspaceId, $namespace: namespace, $model: model }) as ProductEmbeddingRow[];
  }
  return listNamespaceRows(workspaceId, namespace);
}

/** Delete by row id (alias kept for maintenance callers). */
export function removeEmbedding(rowId: string): boolean {
  return deleteEmbeddingById(rowId);
}

/** Record a corrupt-vector failure on a persisted row by id. */
export function markEmbeddingFailure(rowId: string, status: string, at?: string): void {
  const db = getDb();
  db.query(
    'UPDATE product_embeddings SET failure_status = $status, updated_at = $at WHERE id = $id',
  ).run({ $status: status, $at: at ?? new Date().toISOString(), $id: rowId });
}

/** Row-vector deserialization passthrough (maintenance callers). */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  return deserializeRowVector({ embedding_blob: buf } as ProductEmbeddingRow);
}

/** Stable model/provider fingerprint used for wrong-model detection. */
function fingerprintFor(model: string, provider: string): string {
  return `${provider}::${model}`;
}

export function getEmbedding(
  workspaceId: string,
  sku: string,
  model: string,
  namespace: EmbeddingNamespace = 'production',
): ProductEmbeddingRow | null {
  const db = getDb();
  return (
    (db
      .query(
        `SELECT * FROM product_embeddings
         WHERE workspace_id = $workspaceId AND product_sku = $sku
           AND embedding_model = $model AND namespace = $namespace`,
      )
      .get({
        $workspaceId: workspaceId,
        $sku: sku,
        $model: model,
        $namespace: namespace,
      }) as ProductEmbeddingRow | undefined) ?? null
  );
}

export function getAllEmbeddings(
  workspaceId: string,
  model: string,
  namespace: EmbeddingNamespace = 'production',
): ProductEmbeddingRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM product_embeddings
       WHERE workspace_id = $workspaceId AND embedding_model = $model AND namespace = $namespace`,
    )
    .all({ $workspaceId: workspaceId, $model: model, $namespace: namespace }) as ProductEmbeddingRow[];
}

/** All rows in a namespace (any model) for stale/wrong-model detection. */
export function listNamespaceRows(
  workspaceId: string,
  namespace: EmbeddingNamespace = 'production',
): ProductEmbeddingRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM product_embeddings
       WHERE workspace_id = $workspaceId AND namespace = $namespace`,
    )
    .all({ $workspaceId: workspaceId, $namespace: namespace }) as ProductEmbeddingRow[];
}

function deleteEmbeddingById(id: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM product_embeddings WHERE id = $id').run({ $id: id });
  return Number(result.changes) > 0;
}

function deserializeRowVector(row: ProductEmbeddingRow): Float32Array {
  return deserializeEmbeddingVector(row.embedding_blob);
}
