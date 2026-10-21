import type {
  ClassificationEvidence,
  ClassificationProposal,
  ClassificationConfigSnapshotRef,
} from '../shared/types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import type { AcceptedItemEvidence } from '../shared/schemas/item-evidence';

// ─── Stage Identity ────────────────────────────────────────────────────────────

export type ClassificationStageName =
  | 'packaging_ocr'
  | 'evidence_extraction'
  | 'name_consolidation'
  | 'primary_product_type_proposal'
  | 'attribute_applicability'
  | 'product_attribute_proposals'
  // P3 value-production ladder (plan B.P3.3): flag-gated residual-gap stage.
  // Composed ONLY while BAYSTATE_CMS_VALUE_GAP_LLM is on; flag-OFF pipelines
  // never carry the name, so legacy runs stay byte-identical.
  | 'value_gap_abstain'
  | 'category_page_proposals'
  | 'product_draft_projection';

// ─── Stage Input ───────────────────────────────────────────────────────────────

export interface StageInput {
  /** The product SKU being classified */
  sku: string;
  /** The onboarding item ID, if applicable */
  onboardingItemId?: string;
  /** Source kind of the classification run */
  sourceKind?: 'onboarding' | 'catalog_product';
  /** Previously extracted evidence from upstream stages */
  evidence: ClassificationEvidence[];
  /** Previously accepted proposals from upstream stages */
  acceptedProposals: ClassificationProposal[];
  /** All proposals from this run (including pending/stale) */
  allProposals: ClassificationProposal[];
  /**
   * PR8 C1 (issue #30): outputs of the stages that already ran in this
   * pipeline, keyed by stage name — the SAME `stageOutputs` map the pipeline
   * runner returns after the run. Populated by `runPipeline` before every
   * stage execution; a stage invoked directly in isolation (unit tests) omits
   * it. Downstream stages read prior-stage output metadata here (e.g.
   * `product_draft_projection` reads `name_consolidation.metadata` for the
   * coordinated/consolidated title) — never a re-derivation.
   */
  stageOutputs?: Partial<Record<ClassificationStageName, StageOutput>>;
}

// ─── Stage Output ──────────────────────────────────────────────────────────────

export interface StageOutput {
  /** New evidence produced by this stage */
  evidence: ClassificationEvidence[];
  /** New classification proposals produced by this stage */
  proposals: ClassificationProposal[];
  /** If true, the stage intentionally produced no proposals */
  abstained: boolean;
  /** Reason for abstention or failure */
  message?: string;
  /** Stage metadata is not itself reviewable proposal data. Explicit read models may expose declared preview metadata in the Review UI. */
  metadata?: Record<string, unknown>;
}

// ─── Stage Result ──────────────────────────────────────────────────────────────

export type StageResult =
  | { status: 'succeeded'; output: StageOutput }
  | { status: 'failed'; error: string }
  | { status: 'abstained'; reason: string; output?: StageOutput };

// ─── Stage Context ─────────────────────────────────────────────────────────────

export interface ProductLineItemSnapshot {
  sku: string;
  name: string;
  webTitle: string | null;
  brand: string | null;
  description: string;
  species: string[];
  flavor: string | null;
  lifeStage: string | null;
  productForm: string | null;
  healthConcern: string[];
}

export interface StageContext {
  workspacePath: string;
  workspaceId: string;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  /**
   * Immutable runtime snapshot resolved once before run creation. When present,
   * stages MUST consume snapshot data (config, resolved targets, profiles,
   * mappings, brands, data policy, pages) instead of reloading workspace
   * classification files or querying mutable caches.
   */
  snapshot?: RuntimeClassificationSnapshot;
  /** Current run ID for recording results */
  runId: string;
  /** Accepted immutable evidence for an item-local onboarding run. */
  acceptedEvidence?: AcceptedItemEvidence;
  /**
   * Optional ownership assertion injected by the cohort executor (PR3
   * hardening C). When present, `runPipeline` invokes it IMMEDIATELY BEFORE
   * every post-await persistence transaction / terminal update — a rejected
   * assertion (claim lost to a reclaiming sibling) throws `HeartbeatLostError`
   * and that persistence is SKIPPED, so a stale owner never writes run-scoped
   * shared state (model calls / stage results / evidence / proposals) after
   * ownership moves. Absent in legacy (non-cohort) invocations — zero behavior
   * change.
   */
  assertHeld?: () => void;
  /**
   * Optional injected transport for network-performing stages (packaging_ocr).
   * When absent, the underlying client uses its default transport
   * (globalThis.fetch). Test harnesses inject a server-bound fetch here so
   * suite-level globalThis.fetch stubs in OTHER test files can never intercept
   * stage transports. Prod callers omit it — zero behavior change.
   */
  modelFetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Review-triggered refresh reuses upstream evidence and preserves universal assignments. */
  dependentReviewRefresh?: boolean;
  /**
   * Optional product-line group context for sibling-aware processing.
   * Populated before name_consolidation when the item belongs to a
   * product line with sibling items in the same batch.
   */
  productLineContext?: {
    groupId: string;
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  /** Frozen, read-only per-SKU inputs used for cohort page coordination. */
  productLineItems?: ProductLineItemSnapshot[];
  /**
   * PR7 C4/C5 (issue #30): the parent-run durable page outputs (persisted into
   * `classification_cohort_outputs` BEFORE the member loop by
   * `ensureCohortPagesCoordinated`). Map productSku → the parsed
   * `CohortPageOutputSchema` payload PLUS the audited parent model-call id
   * that produced its row. Present ONLY in active cohort mode after the
   * parent page op; absent for legacy/shadow (which keep the coordinator
   * cache + singleton LLM path byte-identical). When present, the
   * `category_page_proposals` stage is a MATERIALIZER: it skips the
   * reviewed-Type gate (DECISION-D) and both LLM paths and turns the stored
   * result into the existing proposal shape with ZERO Page LLM calls.
   */
  coordinatedPages?: Map<string, CoordinatedPageMemberValue>;
  /**
   * PR7 review R2 (F3.3): true when the parent page op chose EXPECTED-EMPTY
   * (page target enabled but NO verified pages — DECISION-C config-level
   * absence): `coordinatedPages` is an empty map by design and the
   * `category_page_proposals` stage abstains with the clean legacy reason
   * ('No verified store pages available...') instead of warning about a
   * missing parent page output. Absent for legacy/shadow and normal active
   * cohort mode.
   */
  pageCoordinationAbsent?: boolean;
  /** Pre-computed coordinated title from cohort LLM call. When present,
   *  name_consolidation uses this instead of making its own LLM call.
   *  PR6 (issue #30): in prepared-cohort (active cohort) mode this comes
   *  from the DURABLE parent-run outputs (`classification_cohort_outputs`,
   *  kind `curated_title`) persisted by `ensureCohortTitlesCoordinated`
   *  before the member loop — never from the in-memory coordinator cache
   *  (legacy/shadow keep the coordinator + `cohortCache` path). */
  preComputedTitle?: string;
  /** Source of the pre-computed title, required when preComputedTitle is set. */
  preComputedTitleSource?: 'llm_cohort' | 'cohort_fallback' | 'typesafe' | 'deterministic';
  /** Durable name decision accompanying the pre-computed title (issue #365). */
  preComputedNameDecision?: unknown;
  /**
   * Frozen member execution-evidence projection (issue #30 PR3 M2, cohort
   * mode; Amendment A V2 with source provenance). When present, the
   * evidence-extraction stage builds its evidence from the projection's
   * spreadsheetIdentity + extraction fields + source provenance and MUST
   * NOT read onboarding_items for semantic evidence — a cohort member runs
   * against the frozen snapshot only (frozen-means-frozen). Historical V1
   * snapshots are normalized to V2 (official-page provenance) by
   * `parseExecutionEvidenceProjection` before reaching the stage.
   */
  cohortFrozenEvidence?: import('../shared/schemas/cohorts').ExecutionEvidenceProjectionMemberV2;
  /** Catalog product classification context. Present only for catalog_product runs. */
  catalogContext?: {
    sourceProductHash: string;
    existingPageIds: Array<{ pageId: string; pageName: string }>;
  };
  /** Retrieval-augmented classification context. */
  retrievalContext?: {
    enabled: boolean;
    topK?: number;
    minSimilarity?: number;
  };
}

/**
 * PR7 C4/C5 (issue #30): one member's durable parent page output — the parsed
 * `CohortPageOutputSchema` payload PLUS the audited parent model-call id that
 * produced its row (`classification_cohort_outputs.model_call_id`; null for
 * deterministic abstentions). The child `category_page_proposals` materializer
 * consumes this to stamp proposal provenance with ZERO Page LLM calls.
 */
export interface CoordinatedPageMemberValue {
  /** The parsed durable payload ({status:'assigned', pages, source} | {status:'abstained', reason}). */
  output: import('../shared/schemas/cohorts').CohortPageOutput;
  /** The audited parent model-call id that produced the row (null when the row carries none). */
  modelCallId: string | null;
}

// ─── Stage Definition ──────────────────────────────────────────────────────────

/**
 * A classification stage is a function that takes an input snapshot and context,
 * and returns a structured result. Stages may use LLMs, VLMs, deterministic rules,
 * or the database to produce evidence and proposals.
 */
export type ClassificationStage = (
  input: StageInput,
  context: StageContext,
) => Promise<StageResult>;

// ─── Stage Dependency ──────────────────────────────────────────────────────────

export interface StageDefinition {
  name: ClassificationStageName;
  /** Stages that must run before this one and whose proposals are needed */
  requires: ClassificationStageName[];
  /** Optional upstream evidence sources */
  evidenceFrom: ClassificationStageName[];
  execute: ClassificationStage;
}

// ─── Pipeline Run ──────────────────────────────────────────────────────────────

export interface PipelineRun {
  sku: string;
  onboardingItemId?: string;
  stages: ClassificationStageName[];
  stageOrder: ClassificationStageName[];
}

// ─── Pipeline Run Result ─────────────────────────────────────────────────────────

/**
 * Aggregated result from a full classification pipeline run.
 */
export interface PipelineRunResult {
  /** All evidence accumulated across all stages */
  evidence: ClassificationEvidence[];
  /** All proposals accumulated across all stages */
  proposals: ClassificationProposal[];
  /** Per-stage output metadata, keyed by stage name */
  stageOutputs: Partial<Record<ClassificationStageName, StageOutput>>;
  /** Internal review refresh: publish prepared outputs inside the owning transaction. */
  commitPreparedStages?: () => void;
}
