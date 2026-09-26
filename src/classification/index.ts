/**
 * Classification Stage Registry
 *
 * Central module that exports all available classification stages
 * in their correct dependency order. To add a new stage:
 * 1. Create the stage file in src/classification/stages/
 * 2. Import and add it to the array below
 * 3. The pipeline runner resolves dependencies automatically
 */
export { packagingOcrStage } from './stages/packaging-ocr-stage';
export { evidenceExtractionStage } from './stages/evidence-extraction';
export { nameConsolidationStage } from './stages/name-consolidation';
export { primaryProductTypeStage } from './stages/primary-product-type';
export { attributeApplicabilityStage } from './stages/attribute-applicability';
export { productAttributeProposalsStage } from './stages/attribute-proposals';
export { valueGapAbstainStage } from './stages/value-gap-abstain';
export type { ValueGapOutcome, ValueGapResolutionRecord, ValueGapStageMetadata } from './stages/value-gap-abstain';
export { categoryPageProposalsStage } from './stages/category-page-proposals';
export { productDraftProjectionStage } from './stages/draft-projection';

// ─── Shared Evidence Extractor ─────────────────────────────────────────────────
export type { NormalizedEvidenceInput, EvidenceExtractionResult } from './product-evidence-extractor';

// ─── Catalog Evidence (Milestone 3/7) ─────────────────────────────────────────
export {
  scanCatalogEvidence,
  renderCatalogEvidence,
  readLiveCatalogFields,
  createCatalogEvidenceVerifier,
  verifyCatalogEvidenceTreeIntegrity,
  gitCommitIsAncestor,
} from './catalog-evidence';
export type { CatalogEvidence, CatalogFieldEvidence, CatalogPageObservation } from './catalog-evidence';

// ─── Runtime Config Authority (Milestone 7) ────────────────────────────────────
export {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
  loadRuntimeConfig,
} from './config-loader';
export type { RuntimeConfigAuthority, VerifiedActivationContext } from './config-loader';

// ─── Catalog Product Classification ────────────────────────────────────────────
export type { CatalogProductSource } from './catalog-product-source';

// ─── Immutable Runtime Snapshot ───────────────────────────────────────────────
export { buildRuntimeSnapshot, deepFreeze, snapshotHash, persistRuntimeSnapshot, getRuntimeSnapshotByHash, runtimeSnapshotHashMatchesConfig, authorityConfigHashMatches } from './runtime-snapshot';
export type {
  RuntimeClassificationSnapshot,
  RuntimeSnapshotInput,
  PageSnapshotState,
  PageSnapshotRecord,
} from './runtime-snapshot';

// ─── Model Operation Registry (issue #17 E) ───────────────────────────────────
export { PROMPT_TEMPLATE_VERSIONS, RULE_VERSIONS, OPERATION_PARAMETERS, OPERATION_TO_STAGE, MODEL_CALL_STATUS, COST_BASIS, buildRuntimeRuleVersions, buildModelExecutionPlan, computePromptHashes } from './model-operation-registry';
export type {
  ModelCallContext,
  ModelCallStatus,
  CostBasis,
  ModelExecutionPlan,
  ModelExecutionPlanEntry,
  RuntimeRuleVersions,
} from './model-operation-registry';

// ─── Reviewed Facts ────────────────────────────────────────────────────────────
export type { ReviewedFact, CollectReviewedFactsInput } from './reviewed-facts';

// ─── Proposal Safety ───────────────────────────────────────────────────────────
export type {
  ProposalSafetyReport,
  ProposalSafetyFinding,
  ProposalSafetyContext,
  SafetyFindingCode,
} from './proposal-safety';

// ─── Proposal Selection ───────────────────────────────────────────────────────
export { selectPrimaryProductTypeProposal, getReviewedPrimaryProductTypeId } from './proposal-selection';
export type { ProposalSelection } from './proposal-selection';

// ─── Assignment Projection ────────────────────────────────────────────────────
export type { SerializableValueValidation } from './assignment-projection';

// ─── Dependent Refresh Queue ──────────────────────────────────────────────────

// ─── Benchmark / Feature Policy (M9) ───────────────────────────────────────────
export {
  computePredictionBundleHash,
  extractPredictionsForSku,
  validatePredictionBundle,
  buildPredictionBundle,
  loadPredictionBundle,
} from './benchmark-prediction';
export type {
  GoldExampleForPrediction,
  BuildPredictionBundleOptions,
} from './benchmark-prediction';
export {
  evaluateQualificationGate,
  buildQualificationReceiptPayload,
  buildQualificationReceiptDigest,
  createQualificationReceiptId,
} from './benchmark-qualification';
export type { QualificationGateOptions, QualificationResult } from './benchmark-qualification';
export {
  evaluateFeaturePolicy,
  evaluateAllFeatures,
  ALL_ML_FEATURES,
} from './feature-policy';
export type { FeatureRequest, FeatureRequestScope, FeaturePolicyOptions } from './feature-policy';

export type { GoldExampleForEvaluation, ControlledValues, ComputeMetricsOptions, EvaluateBenchmarkOptions, EvaluateBenchmarkResult } from './benchmark-evaluator';

// ─── Retrieval Index (M10) ─────────────────────────────────────────────────────
export { InMemoryRetrievalIndex, VectorValidationError, assertFiniteVector, embeddingDocumentId, benchmarkEmbeddingDocumentId, buildBenchmarkRetrievalIndex } from './retrieval-index';
export type {
  VectorEntry,
  RetrievalIndex,
  RetrievalHit,
  RetrievalSearchOptions,
  EmbeddingNamespace,
  BenchmarkIndexExample,
  BuildBenchmarkIndexOptions,
  BenchmarkIndexBuildResult,
} from './retrieval-index';

// ─── Embedding Maintenance (M10) ───────────────────────────────────────────────
export { runEmbeddingMaintenance, computeDesiredEmbeddings, planEmbeddingMaintenance, loadCurrentIndex, EmbeddingMaintenanceLockedError, EmbeddingPolicyDeniedError, EMBEDDING_MODEL, EMBEDDING_PROVIDER } from './embedding-maintenance';
export type {
  DesiredEmbedding,
  MaintenancePlan,
  MaintenanceReport,
  MaintenanceOptions,
} from './embedding-maintenance';

// ─── Retrieval / Rerank (M10) ──────────────────────────────────────────────────
export { findSimilarApprovedProducts, RetrievalPolicyDisabledError, assertProductionRetrievalAllowed } from './product-retrieval';
export type { SimilarProduct, RetrievalOptions } from './product-retrieval';
export {
  rerankPageProposals,
  rerankPageProposalsVerified,
  assertVerifiedPageRerankContext,
  PageRerankBlockedError,
} from './page-reranker';
export type { PageProposal, RankedPageProposal, RerankVerifiedOptions } from './page-reranker';
