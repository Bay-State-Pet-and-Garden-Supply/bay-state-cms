import { Hono, type Context } from 'hono';
import { isPrivateOrLinkLocal, isPrivateOrLinkLocalHost } from '../../shared/ssrf';
import { getLocalRuntimeStatus } from '../../ai/local-runtime-coordinator';
import { OLLAMA_VLM_SERVICE_NAME, DEFAULT_LOCAL_VISION_MODEL } from '../../ai/vision-model-defaults';
import { streamSSE } from 'hono/streaming';
import {
  SSE_VERSION_PARAM,
  parseSseVocabularyVersion,
  serializeSseV1,
  serializeSseV1Ping,
  serializeSseV1Welcome,
  serializeSseV2,
  serializeSseV2ConnectionFrame,
} from '../onboarding-event-presentation';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { buildQualityReport } from '../../db/repositories/classification-metrics-repo';
import { deriveQualityDisplay } from '../../client/classification-metrics-view';
import { getCurrentWorkspace } from '../services/workspace-service';
import {
  createBatch,
  findBatchById,
  listBatches,
  deleteBatch,
  isBatchComplete,
  setBatchArchived,
  updateBatchExecutionState,
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  setDiscoverySourceUrl,
  listItemsByBatchStaged,
  advanceItemsToNextStage,
  updateItemStageStatus,
  completeReviewStage,
  completePromotionStage,
  resetItemsForRetry,
  fallbackSourcingItemsToDiscovery,
  fallbackSourcingItemToDiscovery,
  resetItemsToStage,
  sendItemsToPreviousStage,
  skipItems,
  getWeeklyReportItems,
  revertToOfficialDiscovery,
  reopenApprovedForReapproval,
  updateItemBrandHint,
  releaseBatchItems,
  holdBatchItems,
  bulkAssignBrandToItems,
} from '../../db/repositories/onboarding-item-repo';
import {
  previewBatchFilenames,
  recordFilenameDecision,
  filenameGateReason,
  type FilenamePreviewItem,
} from '../../onboarding/filename-review';
import { partitionBatchByBrand, buildMissingBrandGroups } from '../../onboarding/batch-release';
import type { PipelineStage } from '../../shared/schemas/onboarding';
import { toCanonicalStage, type StageV2 } from '../../shared/onboarding-stage-vocabulary';
import {
  parseStageVocabularyVersion,
  serializeStage,
  type StageVocabularyVersion,
} from '../onboarding-stage-api';
import { isStageV1String, parseV2StageInput, V1_TO_V2 } from '../../shared/onboarding-stage-vocabulary';
import { ResolveSourcingRequestSchema, FallbackSourcingItemsRequestSchema, MediaSelectionRequestSchema } from '../../shared/schemas/onboarding';
import { readStorageVersion, encodeForStorage } from '../../db/repositories/onboarding-stage-vocabulary-repo';

/**
 * Slice 5b native: canonical equality for hydrated (either-spelling) stages.
 * Unknown literals never match (fail closed to the not-eligible branch).
 */
function routeStageIs(rawStage: unknown, canonical: StageV2): boolean {
  try {
    return toCanonicalStage(rawStage) === canonical;
  } catch {
    return false;
  }
}
import { getSourcingFlags } from '../../onboarding/flags';
import {
  deriveSourcingEntryStage,
  SOURCING_ENTRY_POLICY_VERSION,
} from '../../onboarding/sourcing/entry-policy';
import {
  getEvidenceAttemptsForItem,
  listGenerationsForItem,
  getCurrentSourcingGeneration,
  getEvidenceAttemptsByItemAndGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import { getCurrentGenerationAcceptedAttemptIds } from '../../db/repositories/onboarding-acceptance-repo';
import { buildDistributorRecordProjection } from '../../onboarding/sourcing/distributor-record-projection';
import {
  listConflictsForItem,
  resolveConflict,
  getConflictById,
  listResolvedConflictResolutions,
} from '../../db/repositories/onboarding-conflict-repo';
import { completeSourcingViaProjection } from '../../db/repositories/onboarding-item-repo';
import { convertToLbs } from '../../shared/weight-converter';
import {
  ProductIdentityEvidenceSchema,
  type EvidenceAttempt,
} from '../../shared/schemas/distributor-evidence';
import { ResolveConflictRequestSchema } from '../../shared/schemas/distributor';
import {
  listSourcesByItem,
  selectSource
} from '../../db/repositories/onboarding-source-repo';
import {
  getLatestExtraction,
  updateLatestExtractionData
} from '../../db/repositories/onboarding-extraction-repo';
import {
  upsertApiKey,
  getApiKey,
  listApiKeys,
  deleteApiKey
} from '../../db/repositories/api-key-repo';
import {
  listAllBrandSites,
  deleteBrandSite,
  findBrandSites,
  updateBrandSiteDomain
} from '../../db/repositories/brand-site-repo';
import { listStrategyApprovalInputs } from '../../db/repositories/brand-strategy-approval-repo';
import { getServerSingletonWorkspace, MultipleWorkspacesError } from '../../db/repositories/workspace-singleton';
import { assignOfficialDomainForBrand } from '../../onboarding/brand-domain-service';
import {
  MANUAL_EVIDENCE_ACTIVE_RETRY_CODE,
  hasActiveManualEvidence,
} from '../../onboarding/manual-evidence-service';
import { getBrandDomainBlockers } from '../../onboarding/brand-domain-blockers';
import {
  listAllProfiles,
  upsertProfile,
  deleteProfile,
  findProfileByDomain
} from '../../db/repositories/extractor-profile-repo';
import {
  listLlmTaskConfigs,
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
  LLM_TASKS,
} from '../../db/repositories/llm-task-config-repo';
import {
  upsertProviderConnection,
  getProviderConnection,
  deleteProviderConnection,
  upsertWorkloadRoute,
  saveAiRoutingDefaults,
  getFullAiRoutingConfig,
} from '../../db/repositories/provider-connection-repo';
import { probeConnectionHealth } from '../../ai/connection-health-monitor';
import {
  validateConnectionTrustZone,
  toClientProviderConnection,
  type ProviderConnection,
  type WorkloadRoute,
} from '../../ai/provider-connections';
import {
  listAllProfileGenerations,
  listProfileGenerationsByDomain,
  findProfileGenerationById,
  insertProfileGeneration,
  deleteProfileGeneration,
} from '../../db/repositories/profile-generation-repo';
import {
  findProfileGenerationRevisionById,
  listRevisionsByGeneration,
  updateRevisionSelectors,
} from '../../db/repositories/profile-generation-revision-repo';
import {
  findProfileFieldDecisionById,
} from '../../db/repositories/profile-generation-field-decision-repo';
import {
  listDomainProfileGovernance,
  createInitialRevisionForGeneration,
  validateRevisionAcrossConfirmedSamples,
  reviseProfileFromStructuredFeedback,
  approveRevisionFields,
  rejectRevisionFields,
  rollbackProfileFieldBy,
  listFieldDecisionsForGeneration,
  listValidationResultsForRevision,
} from '../../onboarding/profile-governance-service';
import {
  type SelectorKey,
} from '../../onboarding/profile-promoter';
import {
  LlmTaskConfigUpsertSchema,
  ApproveRevisionFieldsRequestSchema,
  RejectRevisionFieldsRequestSchema,
  RollbackFieldRequestSchema,
  ReviseFromFeedbackRequestSchema,
  ValidateRevisionRequestSchema,
  type LlmTask,
  type ProfileBlockedItem,
  DistributorEvidenceAttemptViewSchema,
  type DistributorEvidenceAttemptView,
} from '../../shared/schemas/onboarding';
import {
  SnapshotRequestSchema,
  ValidateRequestSchema,
  GenerateSelectorRequestSchema,
} from '../../shared/schemas/extraction-worker';
import { parseSpreadsheet, detectColumnMapping, applyColumnMapping } from '../../onboarding/spreadsheet-parser';
import { matchExistingBrand } from '../../shared/brand-matcher';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { getDomainDiagnosticsResponse } from '../../onboarding/domain-diagnostics-service';
import { generateSelectors } from '../services/profile-builder/generateSelectorsService';
import { GenerateSelectorsRequestSchema } from '../../shared/schemas/selector-generation';
import {
  getWorkerHealth,
  snapshotPage,
  validateProfile,
  generateSelectorFromElement,
  trustedExtract,
} from '../extraction-worker-client';
import { upsertDomainConfig, DomainConfigUpsertSchema } from '../../onboarding/domain-config-service';
import {
  isProfileGenerationEnabled,
  generateExtractorProfile,
  validateGeneratedProfile,
  buildSeedPreview,
  getMinimizedDom,
} from '../../onboarding/profile-generator';
import { callLlmForTask } from '../../onboarding/llm-client';
import { fetchAndParseSitemap } from '../../onboarding/sitemap-fetcher';
import { listAllSitemapCaches, insertSitemapCache } from '../../db/repositories/sitemap-cache-repo';
import { HTTP_EXTRACTION_HEADERS } from '../../onboarding/page-extractor';
import { promoteItems } from '../../onboarding/draft-promoter';
import { listCandidateCohortViews } from '../../onboarding/curation-cohort-service';
import { CohortListResponseSchema } from '../../shared/schemas/cohorts';
import type { WorkStateCounts } from '../../shared/schemas/onboarding-work-state';
import {
  getBatchWorkStateCounts,
  getBatchWorkStateForItems,
} from '../../onboarding/onboarding-work-state';
import {
  markReviewed,
  markReviewInvalidated,
  getReviewState,
} from '../../db/repositories/onboarding-review-repo';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import { cleanAndDeduplicateImages } from '../../onboarding/image-utils';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import {
  getEvidenceByRun,
  getLiveDecisionsByRun,
  getProposalsByRun,
  getValidatedOnboardingRun,
} from '../../db/repositories/classification-run-repo';
import { validateSiblingConsistency, activeCohortSemanticFindingsForItem } from '../../classification/consistency-validator';
import { validateReviewCompletionGate, validateItemCategoryPagesAssigned } from '../../classification/review-completion-gate';
import {
  buildReviewCompletenessContext,
  evaluateReviewCompleteness,
  type ReviewCompletenessBlockerCode,
} from '../../classification/review-completeness';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { SubmitProposalDecisionsRequestSchema } from '../../shared/schemas/classification';
import { getDb } from '../../db/connection';
import { getCohortById, listCohortShadowObservations } from '../../db/repositories/curation-cohort-repo';
import {
  getCurrentCohortRun,
  rerunIdleCohortRevision,
  CohortRerunBusyError,
  CohortRerunStageConflictError,
} from '../../db/repositories/classification-cohort-run-repo';

/**
 * Workspace ownership guard for an onboarding item: the item must belong to
 * a batch owned by the ACTIVE workspace. Returns an error response or null.
 * (Cross-workspace resources are 404 — never readable, never mutated.)
 */
function itemWorkspaceError(c: Context, item: { batchId: string }): Response | null {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const batch = findBatchById(item.batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  return null;
}

const route = new Hono();

/**
 * Project a raw evidence attempt row into the typed
 * `DistributorEvidenceAttemptView` (ADR 0014): identityJson is parsed
 * server-side with ProductIdentityEvidenceSchema — raw DB JSON is never the
 * frontend type, and malformed JSON fails closed to null.
 */
function projectEvidenceAttempt(
  attempt: EvidenceAttempt,
  acceptedIds: string[],
): DistributorEvidenceAttemptView {
  let identity: Record<string, unknown> | null = null;
  if (attempt.identityJson) {
    try {
      const raw = JSON.parse(attempt.identityJson);
      const parsed = ProductIdentityEvidenceSchema.safeParse(raw);
      if (parsed.success) {
        identity = { ...parsed.data };
      }
    } catch {
      // Malformed identityJson — fail closed to null.
    }
  }

  let warnings: string[] = [];
  if (attempt.warningsJson) {
    try {
      const parsed = JSON.parse(attempt.warningsJson);
      if (Array.isArray(parsed)) warnings = parsed;
    } catch {
      // Ignore malformed warnings.
    }
  }

  return DistributorEvidenceAttemptViewSchema.parse({
    id: attempt.id,
    providerId: attempt.providerId,
    distributorConnectionId: attempt.distributorConnectionId ?? null,
    catalogSnapshotId: attempt.catalogSnapshotId ?? null,
    lookupUpc: attempt.lookupUpc,
    outcome: attempt.outcome,
    confidence: attempt.confidence,
    evidenceUrl: attempt.evidenceUrl,
    productName: identity?.name ?? null,
    brand: identity?.brand ?? null,
    description: identity?.description ?? null,
    imageUrls: identity?.images ?? [],
    warnings,
    errorCode: attempt.errorCode ?? null,
    errorMessage: attempt.errorMessage,
    catalogVersion: attempt.catalogVersion ?? null,
    observedAt: attempt.observedAt ?? null,
    expiresAt: attempt.expiresAt ?? null,
    sourcingGenerationId: attempt.sourcingGenerationId ?? null,
    createdAt: attempt.createdAt,
    isAccepted: acceptedIds.includes(attempt.id),
    identity,
  });
}

// Global worker holder, keyed by the workspace it serves. Epic #46 review
// remediation (fix 7): switching the active workspace must REPLACE the worker
// (stopping the old one) instead of returning a worker permanently bound to
// the FIRST workspace seen — automation (discovery→extraction→curation→
// review progression, domain releases) is workspace-scoped.
interface ActiveWorkerEntry {
  workspaceId: string;
  worker: OnboardingWorker;
}
let activeWorker: ActiveWorkerEntry | null = null;

/**
 * Lazy worker accessor shared by every mutating onboarding route (epic #46
 * work-state routes import this so domain-release and approval trigger a
 * background poll without instantiating a second worker).
 */
export function getWorker(workspaceId: string, workspacePath: string): OnboardingWorker {
  if (activeWorker?.workspaceId !== workspaceId) {
    // Stop the previous workspace's poll loop before replacing it. Clear the
    // slot BEFORE constructing the new worker so a construction/start failure
    // never leaves `activeWorker` pointing at a stopped instance (reviewer
    // P7) — the next call then recreates cleanly.
    activeWorker?.worker.stop();
    activeWorker = null;
    const worker = new OnboardingWorker(workspaceId, workspacePath);
    worker.start();
    activeWorker = { workspaceId, worker };
  }
  return activeWorker.worker;
}

/** Test seam: stop and clear the active worker (idempotent). */
export function resetActiveWorkerForTest(): void {
  activeWorker?.worker.stop();
  activeWorker = null;
}

function autoAcceptPendingProposalsForRun(runId: string): void {
  const db = getDb();
  const proposals = db.query(
    `SELECT p.id, p.status, 
            EXISTS(SELECT 1 FROM classification_proposal_decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) AS has_decision
     FROM classification_proposals p
     WHERE p.run_id = ? AND (p.status = 'pending' OR p.status = 'stale')`
  ).all(runId) as { id: string; status: string; has_decision: number }[];

  const now = new Date().toISOString();
  for (const p of proposals) {
    if (!p.has_decision) {
      try {
        const decisionId = randomUUID();
        db.run(
          `INSERT INTO classification_proposal_decisions
           (id, proposal_id, decision, revised_from_id, reviewer_id, reviewer_note,
            revised_value_json, revised_target_id, has_revised_target, decision_key, superseded_at, created_at)
           VALUES (?, ?, 'accepted', NULL, 'system_auto_accept', 'Auto-accepted on review completion', NULL, NULL, 0, ?, NULL, ?)`,
          [decisionId, p.id, randomUUID(), now],
        );
        db.run(`UPDATE classification_proposals SET status = 'accepted' WHERE id = ?`, [p.id]);
      } catch {
        db.run(`UPDATE classification_proposals SET status = 'accepted' WHERE id = ?`, [p.id]);
      }
    } else {
      db.run(`UPDATE classification_proposals SET status = 'accepted' WHERE id = ?`, [p.id]);
    }
  }
}

const runOwnedCurationKeys = [
  'classificationRunId',
  'classificationConfigSnapshot',
  'classificationEvidence',
  'classificationProposals',
  'classificationDecisions',
  'classificationHistory',
] as const;

function withoutRunOwnedCurationData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...data };
  for (const key of runOwnedCurationKeys) delete sanitized[key];
  return sanitized;
}

function validatedItemRunId(item: {
  id: string;
  batchId: string;
  upc: string;
  curationData?: { classificationRunId?: string | null } | null;
}): string | null {
  const batch = findBatchById(item.batchId);
  if (!batch) return null;
  return getValidatedOnboardingRun(
    item.curationData?.classificationRunId,
    batch.workspaceId,
    item.id,
    item.upc,
  )?.id ?? null;
}

// ─── BATCH UPLOAD AND CRUD ──────────────────────────────────────────────────────

/**
 * POST /api/onboarding/batches/upload
 * Parse uploaded file, return headers & auto-detected mappings.
 */
route.post('/onboarding/batches/upload', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  try {
    const body = await c.req.parseBody();
    const file = body.file as File;
    if (!file) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    const buffer = await file.arrayBuffer();
    const parsed = parseSpreadsheet(buffer, file.name);
    const mapping = detectColumnMapping(parsed.headers);

    return c.json({
      fileName: file.name,
      headers: parsed.headers,
      mapping,
      rowsCount: parsed.totalRows,
      // Store temporary parsed rows in response so the frontend can send them back with the finalized mapping
      tempRows: parsed.rows
    });
  } catch (err) {
    console.error('[OnboardingRoutes] Upload failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/onboarding/batches
 * Confirms mapping and creates the onboarding batch & item queue.
 */
route.post('/onboarding/batches', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  try {
    const { name, fileName, mapping, rows, brandMappings } = await c.req.json();
    if (!name || !fileName || !mapping || !rows) {
      return c.json({ error: 'Missing batch info, mapping, or rows' }, 400);
    }

    const { valid, errors } = applyColumnMapping(rows, mapping);
    if (valid.length === 0) {
      return c.json({ error: 'No valid rows to import. Please check your mapping.', validationErrors: errors }, 400);
    }

    // Fetch all existing brand names to match against register names
    const existingBrands = listAllBrandSites().map(b => b.brandName);

    // Check duplicate UPCs against existing catalog and skip already existing ones
    const finalItems = [];
    for (const item of valid) {
      const existingProduct = findProductBySku(item.upc);
      if (existingProduct) {
        continue;
      }

      let assignedBrandHint = item.brandHint;
      if (!assignedBrandHint) {
        const matched = matchExistingBrand(item.name, existingBrands);
        if (matched) {
          assignedBrandHint = matched;
        }
      }

      finalItems.push({
        ...item,
        brandHint: assignedBrandHint,
        isDuplicate: false,
        existingSku: null,
      });
    }

    if (finalItems.length === 0) {
      return c.json({ error: 'All products in this spreadsheet already exist in the catalog.', validationErrors: errors }, 400);
    }

    // ADR 0017 follow-up: uploads no longer write brand_sites. Brand→domain
    // authority lives in Settings (Domain Configuration) and in Discovery
    // attention actions (assign_brand / assign_domain). The field is still
    // accepted for backward compatibility with older clients, but a non-empty
    // payload is only warned about — never persisted.
    if (brandMappings && typeof brandMappings === 'object' && Object.keys(brandMappings).length > 0) {
      console.warn('[OnboardingRoutes] Ignoring deprecated brandMappings from upload; brand_sites must be updated through Settings or Discovery attention actions.');
    }

    // Entry stage: single-sourced from the effective sourcing capability
    // (ADR 0014 Amendment A). Effective-enabled → Sourcing; otherwise items
    // enter Discovery so no import can strand at sourcing/pending.
    const entryStage = deriveSourcingEntryStage(getSourcingFlags());

    const batch = createBatch({
      workspaceId: workspace.id,
      name,
      fileName,
      totalItems: finalItems.length,
      executionState: 'draft',
      columnMappingJson: JSON.stringify(mapping),
    });

    // Production imports carry the current sourcing entry-policy version (1),
    // regardless of the derived entry stage; an omitted version stays 0
    // (fail closed) for legacy/fixture callers only.
    insertItems(batch.id, finalItems, entryStage, SOURCING_ENTRY_POLICY_VERSION);

    return c.json({ batch, validationErrors: errors });
  } catch (err) {
    console.error('[OnboardingRoutes] Create batch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/onboarding/batches
 * List all batches.
 */
route.get('/onboarding/batches', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  // Ensure worker is running for the active workspace
  getWorker(workspace.id, workspace.workspacePath);

  const batches = listBatches(workspace.id);

  // Epic #46 refinement: per-batch operator work-state counts so the batch
  // table shows the SAME metrics as the Batch Workspace tabs (the legacy
  // promotion-stage completed/failed columns no longer describe the
  // operating model). Additive — clients without the map still work.
  const workStateCounts: Record<string, WorkStateCounts> = {};
  for (const batch of batches) {
    workStateCounts[batch.id] = getBatchWorkStateCounts(batch.id);
  }
  return c.json({ batches, workStateCounts });
});

/**
 * GET /api/onboarding/weekly-report
 * Get items uploaded or promoted within a specified date range (defaulting to the past 7 days).
 */
route.get('/onboarding/weekly-report', async (c) => {
  const endIso = c.req.query('endDate') || new Date().toISOString();
  let startIso = c.req.query('startDate');
  if (!startIso) {
    const endMs = new Date(endIso).getTime();
    startIso = new Date(endMs - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  const items = getWeeklyReportItems(startIso, endIso);
  const promotedCount = items.filter(
    i => i.status === 'promoted' || (routeStageIs(i.stage, 'create_drafts') && i.stageStatus === 'completed')
  ).length;

  // Issue #17 F: include the same versioned quality summary in the weekly
  // report. The report is read-only and workspace-scoped; when no workspace
  // is active the quality section is null with a warning (never a fabricated
  // zero). The existing uploaded/promoted item behavior is untouched.
  let qualitySummary: ReturnType<typeof deriveQualityDisplay> | null;
  const ws = getCurrentWorkspace();
  if (ws) {
    try {
      const report = buildQualityReport(ws.id, startIso, endIso, new Date().toISOString());
      qualitySummary = deriveQualityDisplay(report);
    } catch (err) {
      qualitySummary = {
        summaryRows: [],
        warnings: [`Quality summary unavailable: ${err instanceof Error ? err.message : String(err)}`],
        groupRows: [],
        hasGroups: false,
      };
    }
  } else {
    // Honest no-workspace state: null summary WITH the documented warning
    // (never a fabricated zero).
    qualitySummary = {
      summaryRows: [],
      warnings: ['No active workspace; quality summary is unavailable.'],
      groupRows: [],
      hasGroups: false,
    };
  }

  return c.json({
    startDate: startIso,
    endDate: endIso,
    items,
    totalCount: items.length,
    promotedCount,
    qualitySummary,
  });
});


/**
 * GET /api/onboarding/batches/:id
 * Get single batch details.
 */
route.get('/onboarding/batches/:id', async (c) => {
  const workspace = findWorkspace();
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || (workspace && batch.workspaceId !== workspace.id)) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  // Epic #46 Phase 3: server-derived operator work-state counts so the Batch
  // Workspace shell renders Processing / Needs Attention / Waiting on Family /
  // Ready for Review / Approved without interpreting raw stages.
  const workStateCounts = getBatchWorkStateCounts(batchId);

  return c.json({ batch, workStateCounts });
});

/**
 * DELETE /api/onboarding/batches/:id
 * Delete a batch.
 */
route.delete('/onboarding/batches/:id', async (c) => {
  const batchId = c.req.param('id');
  const deleted = deleteBatch(batchId);
  if (!deleted) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * GET /api/onboarding/batches/:id/missing-brand-groups
 * Grouped missing-brand clusters for the attention queue (brand assignments only).
 */
route.get('/onboarding/batches/:id/missing-brand-groups', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  try {
    const groups = buildMissingBrandGroups(batchId);
    return c.json({ batchId, groups });
  } catch (err) {
    console.error('[OnboardingRoutes] Missing-brand groups failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/onboarding/batches/:id/start
 * Starts batch execution (controlled release).
 * Body: { mode?: 'ready_only' | 'all' }
 */
route.post('/onboarding/batches/:id/start', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  let body: { mode?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // default body
  }

  const mode = body.mode === 'all' ? 'all' : 'ready_only';

  if (mode === 'all') {
    // Release all items in the batch
    releaseBatchItems(batchId);
  } else {
    // Ready only: release branded items, hold unbranded items.
    // Ready = non-empty trimmed brandHint (no distributor exemption).
    const { readyItemIds, heldItemIds } = partitionBatchByBrand(batchId);
    if (readyItemIds.length > 0) {
      releaseBatchItems(batchId, readyItemIds);
    }
    if (heldItemIds.length > 0) {
      holdBatchItems(batchId, heldItemIds, 'unresolved_brand');
    }
  }

  updateBatchExecutionState(batchId, 'running');

  // Trigger worker poll loop
  try {
    getWorker(workspace.id, workspace.workspacePath).poll();
  } catch (err) {
    console.error('[OnboardingRoutes] Worker poll trigger failed on batch start:', err);
  }

  onboardingEvents.emit({
    type: 'batch:progress',
    batchId,
    data: { executionState: 'running' },
  });

  return c.json({ success: true, executionState: 'running' });
});

/**
 * POST /api/onboarding/batches/:id/pause
 * Pauses batch execution.
 */
route.post('/onboarding/batches/:id/pause', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  updateBatchExecutionState(batchId, 'paused');

  onboardingEvents.emit({
    type: 'batch:progress',
    batchId,
    data: { executionState: 'paused' },
  });

  return c.json({ success: true, executionState: 'paused' });
});

/**
 * POST /api/onboarding/batches/:id/resume
 * Resumes paused batch execution.
 */
route.post('/onboarding/batches/:id/resume', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  updateBatchExecutionState(batchId, 'running');

  // Trigger worker poll loop
  try {
    getWorker(workspace.id, workspace.workspacePath).poll();
  } catch (err) {
    console.error('[OnboardingRoutes] Worker poll trigger failed on batch resume:', err);
  }

  onboardingEvents.emit({
    type: 'batch:progress',
    batchId,
    data: { executionState: 'running' },
  });

  return c.json({ success: true, executionState: 'running' });
});

/**
 * POST /api/onboarding/batches/:id/assign-brand-group
 * Bulk assigns a brand to a list of items and releases them if held.
 */
route.post('/onboarding/batches/:id/assign-brand-group', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  const { itemIds, brand } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0 || !brand?.trim()) {
    return c.json({ error: 'itemIds array and brand are required' }, 400);
  }

  // Ticket #125: generation-aware bulk reassignment. Items the worker
  // holds (route_sources/in_progress) keep their pins and are reported —
  // never silently skipped, never retargeted.
  const skippedBrandConflicts: Array<{ itemId: string; reason: string }> = [];
  const assignable = (itemIds as unknown[]).filter((id) => {
    if (typeof id !== 'string') return false;
    const existing = findItemById(id);
    if (!existing || existing.batchId !== batchId) return false;
    if (routeStageIs(existing.stage, 'route_sources') && existing.stageStatus === 'in_progress') {
      skippedBrandConflicts.push({ itemId: id, reason: 'collection_in_progress' });
      return false;
    }
    return true;
  }) as string[];
  bulkAssignBrandToItems(batchId, assignable, brand.trim());
  // When assigned a brand, release the items
  releaseBatchItems(batchId, assignable);

  for (const itemId of assignable) {
    onboardingEvents.emitItemStatus(batchId, itemId, 'pending', { brandHint: brand.trim() });
  }

  return c.json({ success: true, skippedBrandConflicts });
});

/**
 * GET /api/onboarding/batches/:id/items
 * List items in a batch.
 */
route.get('/onboarding/batches/:id/items', async (c) => {
  const batchId = c.req.param('id');
  const status = c.req.query('status');

  const items = listItemsByBatch(batchId, status ? (status as any) : undefined);

  // Epic #46 Phase 1: server-owned per-item operator work-state projection.
  // Additive field — existing clients keep working.
  const { byItem, counts } = getBatchWorkStateForItems(batchId, items);
  const itemsWithWorkState = items.map(item => ({
    ...item,
    workState: byItem.get(item.id) ?? null,
  }));

  return c.json({ items: itemsWithWorkState, workStateCounts: counts });
});

/**
 * POST /api/onboarding/batches/:id/bulk-brand
 * Bulk assign a brand and domain to multiple items in a batch.
 */
route.post('/onboarding/batches/:id/bulk-brand', async (c) => {
  const { itemIds, brandHint, brandDomain } = await c.req.json();
  const db = getDb();

  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  db.transaction(() => {
    // 1. Update brand_hint for all items
    const placeholders = itemIds.map(() => '?').join(', ');
    db.query(`UPDATE onboarding_items SET brand_hint = ? WHERE id IN (${placeholders})`)
      .run(brandHint ? brandHint.trim() : null, ...itemIds);

    // 2. If domain is provided, update/upsert brand site domain mapping
    if (brandHint && brandHint.trim() && brandDomain && brandDomain.trim()) {
      updateBrandSiteDomain(brandHint.trim(), brandDomain.trim());
    }
  })();

  return c.json({ success: true });
});

// ─── STAGE-BASED PIPELINE ENDPOINTS ─────────────────────────────────────────────

/**
 * GET /api/onboarding/batches/:id/staged
 * Returns items grouped by stage for the Kanban Pipeline Board.
 */
route.get('/onboarding/batches/:id/staged', (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  const workspace = findWorkspace();
  if (!workspace || !batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  // Slice 5b native: stage-typed grouping is canonical v2 in memory.
  // Default/unversioned wire representation stays legacy v1; opt-in
  // `?stageVocabularyVersion=2` selects canonical v2 keys.
  let wireVersion: StageVocabularyVersion;
  try {
    wireVersion = parseStageVocabularyVersion(c.req.query('stageVocabularyVersion'));
  } catch {
    return c.json({ error: 'Invalid stageVocabularyVersion', code: 'invalid_version' }, 400);
  }
  const staged = listItemsByBatchStaged(batchId);
  if (wireVersion === 2) return c.json({ staged });
  const v1Staged: Record<string, typeof staged[keyof typeof staged]> = {};
  for (const [stage, items] of Object.entries(staged)) {
    v1Staged[serializeStage(stage, 1)] = items;
  }
  return c.json({ staged: v1Staged });
});

/**
 * GET /api/onboarding/batches/:id/cohorts
 * Returns the batch's ACTIVE candidate curation cohorts (issue #30, PR2) with
 * per-member extraction readiness and derived waiting state. Derived state
 * only — no cohort execution exists yet (PR3+).
 */
route.get('/onboarding/batches/:id/cohorts', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  const workspace = findWorkspace();
  if (!workspace || !batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const payload = CohortListResponseSchema.parse({
    cohorts: listCandidateCohortViews(batchId),
    shadowObservations: listCohortShadowObservations(workspace.id, 50),
  });
  return c.json(payload);
});

/**
 * POST /api/onboarding/cohorts/:id/re-run
 * Start a NEW cohort revision (issue #30, PR10 DECISION-C).
 *
 * Resolution semantics for a blocked review member: fix the underlying cause
 * FIRST (member evidence, config, or a transient model issue) — the fresh
 * revision then re-freezes from CURRENT extraction evidence, re-coordinates
 * the family outputs, and re-validates every member. The gate is NEVER
 * weakened: there is NO manual override anywhere; a still-conflicted member
 * blocks again with fresh findings.
 *
 * Lifecycle: ONE cohort-atomic operation (`rerunIdleCohortRevision`) —
 * validates EVERY cohort member is in review/curation (fail closed BEFORE any
 * mutation), CAS-supersedes the current non-superseded parent run
 * (idle-terminal supersede), terminalizes linked running children, and resets
 * the EXACT `curation_cohort_members` to curation/pending with
 * `curation_data_json` cleared — all in ONE transaction, so the claim slot
 * opens ONLY when the member reset becomes visible (PR10 review R1: never
 * batch-wide, never two transactions).
 *
 * Fail-closed guards:
 * - Unknown cohort (or a cohort outside the active workspace) => 404.
 * - No current non-superseded run (incl. an already-superseded parent) =>
 *   400 `no_active_run`.
 * - ACTIVELY HELD parent (`status IN ('freezing','running') AND claimed_by IS
 *   NOT NULL`) => 400 `run_busy` with ZERO mutation — a reviewer-facing
 *   re-run never yanks a live worker (the owner-guarded drift primitive is
 *   the worker's own supersede path inside `processCohort`; this route never
 *   calls it).
 * - A cohort member outside review/curation (e.g. already in promotion) =>
 *   400 `member_stage_conflict`, ZERO mutation (the re-run contract never
 *   silently skips a member nor destroys downstream state).
 * - The idle-supersede CAS failing (superseded concurrently) => 400
 *   `run_busy`, zero mutation (the whole transaction rolled back).
 *
 * Legacy/shadow cohorts have no cohort runs at all => `no_active_run` (400).
 */
route.post('/onboarding/cohorts/:id/re-run', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const cohortId = c.req.param('id');
  const cohort = getCohortById(cohortId);
  if (!cohort || cohort.workspaceId !== workspace.id) {
    return c.json({ error: 'Cohort not found' }, 404);
  }

  const currentRun = getCurrentCohortRun(cohortId);
  if (!currentRun) {
    return c.json({ error: 'No active cohort run to supersede.', code: 'no_active_run' }, 400);
  }

  // Fail-closed on actively-held runs: a reviewer re-run must never race an
  // in-flight freeze/execution (zero mutation on this path).
  const activelyHeld =
    (currentRun.status === 'freezing' || currentRun.status === 'running') &&
    currentRun.claimedBy !== null;
  if (activelyHeld) {
    return c.json({
      error: `Cohort run ${currentRun.id} is actively ${currentRun.status}; wait for it to finish before starting a new revision.`,
      code: 'run_busy',
    }, 400);
  }

  const reason = 'New cohort revision requested by reviewer';
  // ONE cohort-atomic operation: stage validation + parent CAS + child
  // terminalization + EXACT-member reset in a single transaction (PR10 review
  // R1). Any failure rolls back EVERYTHING — the parent is never superseded
  // without the member reset becoming visible.
  try {
    rerunIdleCohortRevision(cohort.id, currentRun.id, reason);
  } catch (err) {
    if (err instanceof CohortRerunStageConflictError) {
      return c.json({
        error: err.message,
        code: 'member_stage_conflict',
        memberItemId: err.memberItemId,
      }, 400);
    }
    if (err instanceof CohortRerunBusyError) {
      return c.json({
        error: err.message,
        code: 'run_busy',
      }, 400);
    }
    throw err;
  }

  return c.json({ superseded: true, cohortId });
});

/**
 * POST /api/onboarding/items/advance
 * Advances selected items to the next pipeline stage.
 * Body: { itemIds: string[] }
 * Only advances items with stage_status = 'completed'.
 */
route.post('/onboarding/items/advance', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  // ── PR11 C3 advance-hole guard (issue #30, DECISION-B) ────────────────
  // A PR9 blocked member is 'completed' in the review stage, so the raw
  // advance would move it to promotion WITHOUT review-complete (the
  // review-complete gate refuses it, the advance route never did). The
  // promotion gate stays authoritative; this route-level guard is
  // defense-in-depth: blocked members never even reach the promotion stage.
  // The item stays in review with a deterministic reason; siblings advance.
  const advanceable: string[] = [];
  const refused: Array<{ itemId: string; reason: string }> = [];
  for (const id of itemIds) {
    const item = findItemById(id);
    // Only a completed REVIEW_LISTINGS item advances review → promotion — the only
    // transition this guard covers (blocked members must still reach the
    // Review drawer, so curation → review is never refused).
    if (!item || !routeStageIs(item.stage, 'review_listings') || item.stageStatus !== 'completed') {
      advanceable.push(id);
      continue;
    }
    const semanticValidation = item.curationData?.semanticValidation;
    if (
      semanticValidation &&
      typeof semanticValidation === 'object' &&
      (semanticValidation as { status?: unknown }).status === 'blocked'
    ) {
      const findings = (semanticValidation as { findings?: Array<{ message?: unknown }> }).findings;
      const firstMessage =
        Array.isArray(findings) && findings.length > 0 && typeof findings[0]?.message === 'string'
          ? findings[0].message
          : 'A hard cohort semantic validation finding blocks this item.';
      refused.push({ itemId: id, reason: `semantic_validation_blocked: ${firstMessage}` });
      continue;
    }
    // Epic #46 audit fix (fix 3): the generic Advance can never move a
    // reviewed-but-never-release-decided item into Promotion. Bulk approval
    // is the ONLY release decision — a review/completed item without a
    // DURABLE review record (or with an invalidated one) is refused here so
    // diagnostics Advance cannot bypass the approval gate.
    const reviewState = getReviewState(id);
    if (!reviewState?.reviewedAt || reviewState.reviewInvalidatedAt) {
      refused.push({ itemId: id, reason: 'durable_review_required' });
      continue;
    }
    advanceable.push(id);
  }

  const result = advanceItemsToNextStage(advanceable);

  // Trigger worker to pick up newly pending items
  const worker = getWorker(workspace.id, workspace.workspacePath);
  try {
    worker.poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingRoutes] Background worker poll failed (non-blocking):', pollErr);
  }

  return c.json({ ...result, refused });
});

/**
 * POST /api/onboarding/items/reset
 * Capability-aware retry reset. While the Sourcing engine is disabled,
 * Sourcing items are moved to Discovery via the audited fallback instead of
 * resetting in place (which would strand them at sourcing/pending).
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/reset', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  let body: { itemIds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const itemIds = body.itemIds;
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  // Workspace isolation (fail closed): foreign items are never reset.
  const owned: string[] = [];
  const skippedForeign: Array<{ id: string; reason: string }> = [];
  for (const id of itemIds) {
    const item = typeof id === 'string' ? findItemById(id) : undefined;
    if (!item) {
      skippedForeign.push({ id: String(id), reason: 'not_found' });
      continue;
    }
    const ownershipError = itemWorkspaceError(c, item);
    if (ownershipError) {
      skippedForeign.push({ id: id as string, reason: 'not_in_active_workspace' });
      continue;
    }
    owned.push(id as string);
  }

  const result = resetItemsForRetry(owned, { sourcingEngineEnabled: sourcingRoutingActive() });

  // Foreign/missing ids are reported, never silently dropped.
  const skipped = [...result.skipped, ...skippedForeign];

  // Trigger worker to pick up newly pending items (only after transitions).
  const worker = getWorker(workspace.id, workspace.workspacePath);
  try {
    worker.poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingRoutes] Background worker poll failed (non-blocking):', pollErr);
  }

  return c.json({ success: true, moved: result.moved, reset: result.reset, skipped });
});

/**
 * Effective routing capability (Amendment A, MC): the Sourcing engine must
 * be effectively enabled AND in a routing mode (manual/automatic). OFF,
 * invalid, and observe modes never route/claim — existing marker-v1 rows
 * must not be reset in place (that would strand them); the audited
 * fallback path is used instead.
 */
function sourcingRoutingActive(): boolean {
  const flags = getSourcingFlags();
  return flags.effectiveEnabled && flags.mode !== 'observe' && flags.mode !== null;
}

/**
 * GET /api/onboarding/capabilities
 * Reports the effective onboarding capabilities (Amendment A): the Sourcing
 * engine switch, rollout mode, non-secret configuration reason, and the
 * durable entry-policy version. The board uses this to decide which actions
 * may be surfaced; the server remains the authoritative gate. Never exposes
 * secret references or connection details.
 */
route.get('/onboarding/capabilities', (c) => {
  const flags = getSourcingFlags();
  return c.json({
    sourcing: {
      engineEnabled: flags.effectiveEnabled,
      mode: flags.mode,
      configurationReason: flags.reason,
      entryPolicyVersion: SOURCING_ENTRY_POLICY_VERSION,
    },
  });
});

/**
 * POST /api/onboarding/items/fallback-sourcing-to-discovery
 * Bulk repair for stranded sourcing/pending items: moves every eligible item
 * to Discovery inside one transaction with an audited fallback_to_discovery
 * operator-override decision. Only items in batches owned by the active
 * workspace are eligible; ineligible/missing IDs are reported, never silently
 * dropped.
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/fallback-sourcing-to-discovery', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const parseResult = FallbackSourcingItemsRequestSchema.safeParse(await c.req.json());
  if (!parseResult.success) {
    return c.json({ error: 'Invalid fallback sourcing payload', details: parseResult.error.format() }, 400);
  }

  const { itemIds } = parseResult.data;

  // Workspace ownership: every requested item must belong to a batch owned by
  // the active workspace. Wholly unknown/foreign input fails closed; mixed
  // input returns a truthful partial result.
  const batchIdByItemId = new Map<string, string>();
  let knownCount = 0;
  for (const id of itemIds) {
    const item = findItemById(id);
    if (!item) continue;
    knownCount++;
    batchIdByItemId.set(id, item.batchId);
  }
  if (knownCount === 0) {
    return c.json({ error: 'No onboarding items found for the requested ids' }, 404);
  }

  const owned = new Set(
    [...new Set(batchIdByItemId.values())]
      .map((batchId) => findBatchById(batchId))
      .filter((b): b is NonNullable<typeof b> => b !== undefined && b.workspaceId === workspace.id)
      .map((b) => b.id),
  );

  const ownedIds: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of itemIds) {
    const batchId = batchIdByItemId.get(id);
    if (!batchId) {
      skipped.push({ id, reason: 'not_found' });
    } else if (!owned.has(batchId)) {
      skipped.push({ id, reason: 'not_owned' });
    } else {
      ownedIds.push(id);
    }
  }

  const result = fallbackSourcingItemsToDiscovery(ownedIds);

  // Trigger worker to pick up newly pending Discovery items.
  const worker = getWorker(workspace.id, workspace.workspacePath);
  try {
    worker.poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingRoutes] Background worker poll failed (non-blocking):', pollErr);
  }

  return c.json({
    moved: result.moved,
    skipped: [...skipped, ...result.skipped],
  });
});

/**
 * POST /api/onboarding/items/reset-to-stage
 * Moves items to a specific pipeline stage with 'completed' status,
 * preserving extraction/curation data. The worker won't re-process them.
 * Body: { itemIds: string[], targetStage: string }
 */
route.post('/onboarding/items/reset-to-stage', async (c) => {
  const { itemIds, targetStage } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }
  if (!targetStage || typeof targetStage !== 'string') {
    return c.json({ error: 'targetStage string is required' }, 400);
  }
  const rawVersion = c.req.query('stageVocabularyVersion');
  let wireVersion: StageVocabularyVersion;
  try {
    wireVersion = parseStageVocabularyVersion(rawVersion);
  } catch {
    return c.json({ error: 'Invalid stageVocabularyVersion', code: 'invalid_version' }, 400);
  }
  // Slice 5b native: strict version separation — default/unversioned
  // accepts ONLY legacy v1 spellings, opt-in v2 ONLY canonical values.
  // Mixed/unknown representations reject (never silently coerced).
  let canonicalTarget: string;
  try {
    if (wireVersion === 2) {
      canonicalTarget = parseV2StageInput(targetStage);
    } else {
      if (!isStageV1String(targetStage)) throw new Error('invalid_stage');
      canonicalTarget = V1_TO_V2[targetStage];
    }
  } catch {
    return c.json({ error: `Invalid stage: ${targetStage}`, code: 'invalid_stage' }, 400);
  }

  const result = resetItemsToStage(itemIds, canonicalTarget as PipelineStage);
  return c.json({ success: true, reset: result.reset });
});

/**
 * POST /api/onboarding/items/move-to-previous
 * Sends selected items to their previous pipeline stage, undoing current stage results.
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/move-to-previous', async (c) => {
  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  const result = sendItemsToPreviousStage(itemIds);
  return c.json({ success: true, ...result });
});

/**
 * POST /api/onboarding/items/skip-bulk
 * Marks items as skipped in their current stage.
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/skip-bulk', async (c) => {
  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  skipItems(itemIds);
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/review-complete
 * Marks review-stage items as completed (stage_status = 'completed').
 *
 * Legacy items (no classificationRunId) bypass validation.
 *
 * For classified items:
 * - Runs a preliminary validation phase across ALL items first.
 *   If any item fails validation, returns 400 with per-item reasons
 *   and mutates NONE.
 * - Each item must reference a run that belongs to the current workspace,
 *   that exact onboarding item, and that SKU, and be in a
 *   completed/completed_with_abstentions state.
 * - The item must be in the 'review_listings' stage.
 * - Every proposal in that run (excluding product_draft_projection) must
 *   have status 'accepted', 'rejected', or 'deferred' AND have at least
 *   one matching row in classification_proposal_decisions.
 *   Stale, pending, or missing-decision proposals block completion.
 * - At least one reviewable proposal must be decided.
 *
 * Body: { itemIds: string[] }
 */

/** Shared Phase-1 completeness gate for legacy + classified items (e10s01). */
function reviewCompletenessFailure(
  item: Parameters<typeof buildReviewCompletenessContext>[0],
  workspace: { id: string; workspacePath: string },
): { reason: string; blockers: ReviewCompletenessBlockerCode[] } | null {
  const result = evaluateReviewCompleteness(
    buildReviewCompletenessContext(item, {
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
    }),
  );
  if (result.ready) return null;
  return {
    reason: `Missing mandatory fields: ${result.blockers.join(', ')}`,
    blockers: result.blockers,
  };
}

route.post('/onboarding/items/review-complete', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const { itemIds, reviewerId, filenameDecisions: rawDecisions } = (await c.req.json()) as {
    itemIds?: unknown; reviewerId?: unknown; filenameDecisions?: unknown;
  };
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  if (new Set(itemIds).size !== itemIds.length) {
    return c.json({ error: 'itemIds must not contain duplicates' }, 400);
  }

  // Issue #109: explicit per-item filename-warning decisions. Validated
  // manually (this route predates the zod approve schema); anything else
  // is a 400 with no mutation, matching the route's existing shape.
  const filenameDecisions: Record<string, 'accept' | 'defer'> = {};
  if (rawDecisions !== undefined) {
    if (typeof rawDecisions !== 'object' || rawDecisions === null || Array.isArray(rawDecisions)) {
      return c.json({ error: 'filenameDecisions must be an object mapping itemId to "accept" or "defer".' }, 400);
    }
    for (const [key, value] of Object.entries(rawDecisions)) {
      if (value !== 'accept' && value !== 'defer') {
        return c.json({ error: `filenameDecisions["${key}"] must be "accept" or "defer".` }, 400);
      }
      filenameDecisions[key] = value;
    }
  }

  const db = getDb();
  const failures: Array<{ itemId: string; reason: string; blockers?: string[] }> = [];
  const legacyIds: string[] = [];
  const classifiedIds: string[] = [];
  const deferred: string[] = [];
  const batchIdByItemId = new Map<string, string>();
  const reviewedBy = typeof reviewerId === 'string' && reviewerId.trim() ? reviewerId.trim() : 'operator';
  // Issue #109: filename preview resolved once per batch (not per item).
  const filenamePreviewCache = new Map<string, Map<string, FilenamePreviewItem>>();

  // ── Phase 1: Validate every item ─────────────────────────────────────
  for (const id of itemIds) {
    const item = findItemById(id);
    if (!item) {
      failures.push({ itemId: id, reason: 'Item not found' });
      continue;
    }
    batchIdByItemId.set(id, item.batchId);

    // Workspace-ownership guard (epic #46 review round 2 + GPT review):
    // items from foreign workspaces are never reviewable through this route.
    const itemBatch = findBatchById(item.batchId);
    if (!itemBatch || itemBatch.workspaceId !== workspace.id) {
      failures.push({ itemId: id, reason: 'Item not in this workspace' });
      continue;
    }

    // Must be in the review_listings stage
    if (!routeStageIs(item.stage, 'review_listings')) {
      failures.push({ itemId: id, reason: `Item is in stage "${item.stage}", not "review_listings"` });
      continue;
    }

    // Issue #109: filename-warning gate. Explicit decisions are recorded to
    // Classification History first, deliberately: the decision is audit
    // trail even when completion is rejected (400). This is safe because
    // accepts are base-keyed and revalidated on every gate check — a stale
    // accept can never silently approve later; retitles change the base and
    // re-warn. Deferrals skip mutation via `deferred`.
    let preview = filenamePreviewCache.get(item.batchId);
    if (!preview) {
      preview = new Map(
        previewBatchFilenames(workspace.workspacePath, item.batchId, workspace.id).map(p => [p.itemId, p]),
      );
      filenamePreviewCache.set(item.batchId, preview);
    }
    const previewEntry = preview.get(id);
    if (previewEntry && previewEntry.warnings.length > 0) {
      const decision = filenameDecisions[id];
      if (decision === 'accept' || decision === 'defer') {
        recordFilenameDecision(workspace.id, item.upc, item.batchId, decision, previewEntry.baseFileName, reviewedBy);
      }
      if (decision === 'defer') {
        deferred.push(id);
        continue;
      }
      const filenameReason = filenameGateReason(previewEntry, workspace.id, item.batchId);
      if (filenameReason) {
        failures.push({ itemId: id, reason: filenameReason });
        continue;
      }
    }

    const runId = item.curationData?.classificationRunId;
    if (!runId) {
      // Legacy items without classification data pass through the run gate,
      // but the universal Category Page requirement still applies — an item
      // without an assigned (verified) Category Page is never review-ready.
      const legacyPagesGate = validateItemCategoryPagesAssigned({
        workspaceId: workspace.id,
        curationData: item.curationData,
      });
      if (legacyPagesGate && !legacyPagesGate.ok) {
        // Structured code carried alongside the reason so the client readiness
        // panel can surface it post-rejection instead of an empty blocker set.
        failures.push({ itemId: id, reason: `${legacyPagesGate.code}: ${legacyPagesGate.reason}`, blockers: [legacyPagesGate.code] });
        continue;
      }
      // Story e10s01 — Phase-1 review-completeness gate (fail closed):
      // the promotion mandatory checklist is enforced BEFORE durable review
      // is recorded. Legacy and classified items face the SAME checklist;
      // the promoter keeps its own checks downstream (defense in depth).
      const legacyCompletenessFailure = reviewCompletenessFailure(item, workspace);
      if (legacyCompletenessFailure) {
        failures.push({ itemId: id, ...legacyCompletenessFailure });
        continue;
      }
      // Ticket #124 P1-2: legacy items face the SAME gap refusal as
      // classified items (mirrors the markReviewed repository guard so a
      // direct call and the route agree). Without this, a gapped legacy
      // item reaches markReviewed inside the Phase 3 transaction and 500s.
      try {
        const { getDb } = await import('../../db/connection');
        const legacyGapRow = getDb().query('SELECT status FROM preparation_gaps WHERE item_id = ?').get(id) as
          | { status: string }
          | undefined;
        if (legacyGapRow?.status === 'open') {
          failures.push({
            itemId: id,
            reason: 'preparation_gap_unresolved: resolve the open Listing Evidence Gap in Prepare listing before review.',
          });
          continue;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('preparation_gap_unresolved')) throw err;
        // Minimal DBs without the gaps table: no gap can be open.
      }
      legacyIds.push(id);
      continue;
    }

    // Auto-accept any remaining pending proposals for this classification run
    autoAcceptPendingProposalsForRun(runId);

    const gate = validateReviewCompletionGate({
      workspaceId: workspace.id,
      onboardingItemId: id,
      productSku: item.upc,
      activeRunId: runId,
    });
    if (!gate.ok) {
      // Run-gate codes (page_decision_*, title_validation_*, …) are not
      // completeness blockers, but carrying them structurally lets
      // parseBlockersFromRejection surface SOMETHING actionable instead of [].
      failures.push({ itemId: id, reason: gate.reason, blockers: [gate.code] });
      continue;
    }

    // Story e10s01 — Phase-1 review-completeness gate for classified items
    // (same checklist as legacy; runs AFTER the run/decision gates so its
    // codes describe an otherwise-reviewable item).
    const completenessFailure = reviewCompletenessFailure(item, workspace);
    if (completenessFailure) {
      failures.push({ itemId: id, ...completenessFailure });
      continue;
    }

    // Ticket #124 — unresolved Listing Evidence Gaps refuse review
    // readiness per item (mirrors the markReviewed repository guard so a
    // direct call and the route agree).
    try {
      const { getDb } = await import('../../db/connection');
      const gapRow = getDb().query('SELECT status FROM preparation_gaps WHERE item_id = ?').get(id) as
        | { status: string }
        | undefined;
      if (gapRow?.status === 'open') {
        failures.push({
          itemId: id,
          reason: 'preparation_gap_unresolved: resolve the open Listing Evidence Gap in Prepare listing before review.',
        });
        continue;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('preparation_gap_unresolved')) throw err;
      // Minimal DBs without the gaps table: no gap can be open.
    }

    classifiedIds.push(id);
  }

  // ── Phase 2: If any item failed, reject all without mutating ─────────
  if (failures.length > 0) {
    return c.json({
      error: 'Some items failed review completion validation. None were mutated.',
      failures,
    }, 400);
  }

  // ── Phase 3: Complete all in a single transaction ────────────────────
  // Epic #46 Phase 1: each completed review ALSO writes the durable review
  // state (onboarding_review_state) so bulk approval and the work-state
  // projection have an independent reviewed signal. Re-review clears any
  // prior approval/invalidation via markReviewed upsert semantics.
  db.transaction(() => {
    for (const id of legacyIds) {
      completeReviewStage(id);
      markReviewed({ itemId: id, batchId: batchIdByItemId.get(id) ?? '', reviewedBy });
    }
    for (const id of classifiedIds) {
      completeReviewStage(id);
      markReviewed({ itemId: id, batchId: batchIdByItemId.get(id) ?? '', reviewedBy });
    }
  })();

  return c.json({
    success: true,
    count: itemIds.length,
    legacyCount: legacyIds.length,
    classifiedCount: classifiedIds.length,
    deferred,
  });
});

/**
 * POST /api/onboarding/batches/:id/promote
 * Promotes promotion-stage items to CMS product drafts.
 * Marks items as stage_status='completed' on success, 'failed' on error.
 */
route.post('/onboarding/batches/:id/promote', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds)) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  try {
    // Validate items are in the promotion (create_drafts) stage — either spelling.
    const db = getDb();
    const invalid = db.query(
      `SELECT COUNT(*) as count FROM onboarding_items WHERE id IN (${itemIds.map(() => '?').join(',')}) AND stage NOT IN ('promotion', 'create_drafts')`
    ).all(...itemIds) as Array<{ count: number }>;
    if (invalid.length > 0 && invalid[0].count > 0) {
      return c.json({ error: 'All items must be in the promotion stage' }, 400);
    }

    // Epic #46 audit fix (fix 3): Promotion is the export-prep side effect,
    // and approval is the ONLY release decision. Every item must carry a
    // DURABLE, non-invalidated approval before drafts are created — an
    // item advanced by diagnostics or edited after approval (approval
    // cleared) is refused here so the export path can never run ahead of a
    // valid release decision. All-or-nothing, matching the route's existing
    // stage validation shape.
    const approvalFailures: Array<{ itemId: string; reason: string }> = [];
    for (const id of itemIds) {
      const item = findItemById(id);
      if (!item) {
        approvalFailures.push({ itemId: id, reason: 'item_not_found' });
        continue;
      }
      const reviewState = getReviewState(id);
      if (reviewState?.reviewInvalidatedAt) {
        // Invalidation clears approved_at — check it FIRST or the reason below
        // is unreachable for edited-after-approval items.
        approvalFailures.push({ itemId: id, reason: 'approval_invalidated' });
        continue;
      }
      if (!reviewState?.approvedAt) {
        approvalFailures.push({ itemId: id, reason: 'approval_required' });
        continue;
      }
    }
    if (approvalFailures.length > 0) {
      return c.json({
        error: 'All items must be approved before promotion. None were mutated.',
        failures: approvalFailures,
      }, 400);
    }

    const result = await promoteItems(workspace.id, workspace.workspacePath, batchId, itemIds);

    // Archive batch if all items are done
    if (isBatchComplete(batchId)) {
      setBatchArchived(batchId, true);
    }

    return c.json(result);
  } catch (err) {
    console.error('[OnboardingRoutes] Promotion failed:', err);

    // Mark items as failed
    for (const id of itemIds) {
      completePromotionStage(id, false, err instanceof Error ? err.message : String(err));
    }

    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ─── SSE STREAM ─────────────────────────────────────────────────────────────────

/**
 * GET /api/onboarding/batches/:id/events
 * Streams real-time progress for a batch.
 */
route.get('/onboarding/batches/:id/events', async (c) => {
  const batchId = c.req.param('id');
  const workspace = findWorkspace();
  // Workspace-ownership guard (epic #46 review remediation, fix 4): a
  // foreign-workspace batch is 404 BEFORE any SSE connection opens — family
  // readiness and item event streams are workspace-scoped.
  const batch = findBatchById(batchId);
  if (!workspace || !batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  if (workspace) {
    getWorker(workspace.id, workspace.workspacePath);
  }

  // Slice 4-SERVER: SSE representation is selected at connection creation by
  // URL parameter ONLY (EventSource cannot send headers). Absent/unversioned
  // means legacy v1; anything else rejects BEFORE the stream opens.
  const versioned = parseSseVocabularyVersion(c.req.query(SSE_VERSION_PARAM));
  if ('error' in versioned) {
    return c.json({ error: 'Invalid stageVocabularyVersion', code: 'invalid_version' }, 400);
  }
  const sseVersion = versioned.version;

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  c.header('Content-Encoding', 'identity');
  c.header('X-Content-Type-Options', 'nosniff');

  return streamSSE(c, async (stream) => {
    const unsubscribe = onboardingEvents.subscribe(batchId, async (event) => {
      try {
        // v1 path is byte-identical legacy passthrough. v2 serializes per
        // subscriber through the allowlisted sanitizer; unmappable events
        // are dropped (counts still refresh by polling).
        const frame = sseVersion === 2 ? serializeSseV2(event) : serializeSseV1(event);
        if (frame) {
          await stream.writeSSE(frame);
        }
      } catch (err) {
        console.warn(`[SSE] Failed to write event to batch ${batchId}:`, err);
      }
    });

    // Send initial heart beat/welcome message (connection frame, not activity).
    // v1 shape is byte-identical legacy; v2 is a typed connection frame.
    await stream.writeSSE(
      sseVersion === 2 ? serializeSseV2ConnectionFrame('welcome', batchId) : serializeSseV1Welcome(batchId),
    );

    // Cleanup on disconnect
    stream.onAbort(() => {
      unsubscribe();
      console.log(`[SSE] Disconnected from batch ${batchId}`);
    });

    // Keep connection alive with periodic pings every 15s (transport-only;
    // never worker activity). v1 ping shape is byte-identical legacy.
    while (true) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        await stream.writeSSE(
          sseVersion === 2
            ? serializeSseV2ConnectionFrame('ping', batchId)
            : serializeSseV1Ping(new Date().toISOString()),
        );
      } catch {
        break;
      }
    }
  });
});

// ─── INDIVIDUAL ITEM ACTIONS ────────────────────────────────────────────────────

/**
 * GET /api/onboarding/items/:id
 * Get full details of an item (including sources & latest extraction).
 */
route.get('/onboarding/items/:id', async (c) => {
  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;

  const sources = listSourcesByItem(itemId);
  const extraction = getLatestExtraction(itemId);

  // MD round-7 (defect 1a): a preserved extraction row stays audit-only after
  // a source change. Only the row whose source_type matches the ITEM's
  // CURRENT source type may surface as the active extraction — an official
  // fallback (distributor_record → official_page) must never resurrect the
  // old distributor payload for an official pending/failed extraction, and a
  // distributor item must never display an official row.
  const activeExtraction =
    extraction && (extraction.source_type ?? 'official_page') === item.sourceType
      ? extraction
      : undefined;

  // Prefer user-edited extraction data saved directly on the item record
  // (onboarding_items.extraction_data_json), falling back to the latest
  // matching extraction run record (onboarding_extractions). This ensures
  // edits like removing an image from extraction results are persisted when
  // the user re-opens the item.
  const extractionData = item.extractionData
    ?? (activeExtraction ? JSON.parse(activeExtraction.extraction_data_json) : null);

  // PR9 C3 (issue #30, DECISION-C): an ACTIVE-cohort member's semantic
  // validation findings surface INSTEAD of the legacy
  // `validateSiblingConsistency` warnings; legacy/shadow keep the legacy
  // surface byte-identical. PR9 review R1 (B6): the discriminated surface
  // NEVER falls back to legacy live-regrouping once active membership is
  // established — missing/malformed semantic data fails closed (blocked
  // payload), not to the legacy warnings.
  const semanticSurface = activeCohortSemanticFindingsForItem(item);
  const consistencyWarnings = semanticSurface.mode === 'active'
    ? []
    : item.curationData
      ? validateSiblingConsistency(item.batchId).filter(warning =>
          Object.prototype.hasOwnProperty.call(warning.values, item.upc),
        )
      : [];

  const activeRunId = validatedItemRunId(item);
  const sanitizedCuration = item.curationData
    ? withoutRunOwnedCurationData(item.curationData as unknown as Record<string, unknown>)
    : null;
  const hydratedItem = item.curationData
    ? {
        ...item,
        curationData: activeRunId
          ? {
              ...sanitizedCuration,
              classificationRunId: activeRunId,
              classificationConfigSnapshot: item.curationData.classificationConfigSnapshot ?? null,
              classificationProposals: getProposalsByRun(activeRunId),
              classificationEvidence: getEvidenceByRun(activeRunId),
              classificationDecisions: getLiveDecisionsByRun(activeRunId),
              classificationHistory: [],
            }
          : sanitizedCuration,
      }
    : item;

  const acceptedEvidenceAttemptIds = item.sourcingDecision?.acceptedEvidenceAttemptIds ?? [];
  const evidenceAttempts = getEvidenceAttemptsForItem(itemId)
    .map((attempt) => projectEvidenceAttempt(attempt, acceptedEvidenceAttemptIds));

  // Amendment A (MC): server-derived distributor-record qualification view
  // for the manual-mode drawer. Computed with the SAME deterministic
  // authority as automatic routing (buildDistributorRecordProjection over
  // the current generation's attempts + relational acceptances). null when
  // the item is not at the sourcing stage and is not a distributor-source
  // extraction item, or has no current generation. Distributor-source
  // extraction items (pending/failed, payload not yet materialized) keep
  // the view so the extraction drawer can render provider/attempt/hash/
  // generation provenance (MD round-6 defect 7).
  const sourcingQualificationView = (() => {
    const isSourcingStage = routeStageIs(item.stage, 'route_sources');
    const isDistributorExtractionPendingOrFailed =
      item.sourceType === 'distributor_record' &&
      routeStageIs(item.stage, 'collect_details') &&
      (item.stageStatus === 'pending' || item.stageStatus === 'failed');
    if (!isSourcingStage && !isDistributorExtractionPendingOrFailed) return null;
    const generation = getCurrentSourcingGeneration(itemId);
    if (!generation) return null;
    const attempts = getEvidenceAttemptsByItemAndGeneration(itemId, generation.id);
    const acceptedIds = getCurrentGenerationAcceptedAttemptIds(itemId);
    // A current generation ALWAYS yields a view (certification 84c918d9):
    // empty attempts/acceptances produce an UNQUALIFIED view with reason
    // codes (e.g. no_accepted_evidence) so the manual drawer can render
    // "Not qualified" + Continue. Never fabricate evidence.
    const projection = buildDistributorRecordProjection({
      itemId,
      itemUpc: item.upc,
      sourcingGenerationId: generation.id,
      attempts,
      acceptedAttemptIds: acceptedIds,
      // MD round-7 (defect 2): apply the SAME persisted operator resolutions
      // the routing/materialization authority uses (candidate/custom/dismiss)
      // so the drawer view agrees with the persisted decision hash. Without
      // them a custom-override record would render unqualified with no
      // authoritative hash.
      resolutions: listResolvedConflictResolutions(itemId),
    });
    if (projection.qualified) {
      return {
        qualified: true,
        reasonCodes: [] as string[],
        acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
        providerIds: projection.providerIds,
        evidenceHash: projection.evidenceHash,
        sourcingGenerationId: generation.id,
        warnings: projection.warnings,
      };
    }
    return {
      qualified: false,
      reasonCodes: projection.reasonCodes,
      acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
      providerIds: projection.providerIds,
      evidenceHash: null,
      sourcingGenerationId: generation.id,
      warnings: projection.warnings,
    };
  })();

  // Story e10s01 — authoritative review-completeness status so the client
  // renders live blocker/warning codes from the SAME logic the
  // review-complete gate enforces (client snapshot is advisory; the server
  // gate remains authoritative).
  const completeness = (() => {
    try {
      const workspace = findWorkspace();
      if (!workspace) return undefined;
      return evaluateReviewCompleteness(
        buildReviewCompletenessContext(
          { ...item, extractionData: (extractionData ?? null) as Record<string, unknown> | null },
          { workspaceId: workspace.id, workspacePath: workspace.workspacePath },
        ),
      );
    } catch {
      // Evaluation must never break the detail projection; the client falls
      // back to its advisory derivation and review-complete stays authoritative.
      return undefined;
    }
  })();

  // M6: latest variant resolution (client-safe)
  let variantResolution: unknown = null;
  try {
    const { getDb } = await import('../../db/connection');
    const db = getDb();
    const row = db.prepare('SELECT * FROM onboarding_variant_resolutions WHERE onboarding_item_id = ? AND superseded_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(itemId) as any;
    if (row) {
      variantResolution = { id: row.id, status: row.status, candidates: JSON.parse(row.candidates_json), identityMatrixHash: row.identity_matrix_hash, platform: row.platform, selectedVariantKey: row.selected_variant_key ?? null, decisionOrigin: row.decision_origin ?? null };
    }
  } catch {}
  return c.json({
    item: hydratedItem,
    sources,
    extraction: extractionData,
    evidenceAttempts,
    generations: listGenerationsForItem(itemId),
    conflicts: listConflictsForItem(itemId),
    consistencyWarnings,
    semanticValidation: semanticSurface.mode === 'active' ? semanticSurface.semanticValidation : undefined,
    sourcingQualificationView,
    ...(variantResolution ? { variantResolution } : {}),
    ...(completeness ? { completeness } : {}),
  });
});

/**
 * PUT /api/onboarding/items/:id
 * Update item details (allows overriding price, title, category, extraction_data_json).
 */
route.put('/onboarding/items/:id', async (c) => {
  const itemId = c.req.param('id');
  const body = await c.req.json();
  const db = getDb();

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  // Workspace-ownership guard (epic #46 review round 2): a consequential
  // edit is a workspace-scoped mutation — foreign-workspace items are 404,
  // never mutated.
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;

  // equal what the canonical projection dictates (the materializer re-
  // validates this on every idempotent retry). Editing the payload or
  // assigning a URL here would let a tampered payload be restored later or
  // invent a source URL. Use Continue-with-Official-Site-Discovery to change
  // the source instead.
  if (item.sourceType === 'distributor_record' && (body.extraction_data !== undefined || body.source_url !== undefined)) {
    return c.json(
      {
        error:
          'Distributor extraction data is derived and immutable; use Continue-with-Official-Site-Discovery to change the source.',
      },
      400,
    );
  }

  // e10s02 adjudication: distributor inventory is upstream-managed — the
  // review UI renders quantity read-only and never sends the key; reject
  // direct attempts rather than silently writing (fail-closed parity with
  // the extraction_data guard above). Price stays writable for BOTH source
  // types: item.price is the promoter's ONLY distributor price authority
  // (draft-promoter.ts ~777), so the reviewer must be able to set it when
  // an import omitted it.
  if (item.sourceType === 'distributor_record' && body.quantity !== undefined) {
    return c.json(
      { error: 'Distributor record inventory is managed upstream; quantity cannot be edited here.' },
      400,
    );
  }

  // Fail closed on negative commerce values — the promoter would otherwise
  // write them verbatim into the approved draft. Validation runs AFTER
  // stripping currency symbols/whitespace (same cleaning as the promotion
  // price chain) so forms like "$-5" or "- $5" cannot smuggle a negative
  // value past a leading-character check.
  if (typeof body.price === 'string') {
    const cleanedPrice = body.price.replace(/[$\s,]/g, '').trim();
    if (
      cleanedPrice.startsWith('-') ||
      (cleanedPrice !== '' && Number.isFinite(Number(cleanedPrice)) && Number(cleanedPrice) < 0)
    ) {
      return c.json({ error: 'Price cannot be negative.' }, 400);
    }
  }
  if (
    body.quantity !== undefined &&
    body.quantity !== null &&
    Number.isFinite(Number(body.quantity)) &&
    Number(body.quantity) < 0
  ) {
    return c.json({ error: 'Quantity cannot be negative.' }, 400);
  }

  // MD round-7 (defect 1b): ROW-level immutability. A PRESERVED
  // distributor_record extraction row is audit-only even after an official
  // fallback (item.sourceType is now official_page, so the guard above no
  // longer applies). The generic edit must never mutate it.
  if (body.extraction_data !== undefined) {
    const latestExtraction = getLatestExtraction(itemId);
    if (latestExtraction && (latestExtraction.source_type ?? 'official_page') === 'distributor_record') {
      return c.json(
        {
          error:
            'Preserved distributor extraction data is derived and immutable; use Continue-with-Official-Site-Discovery to change the source.',
        },
        400,
      );
    }
  }

  db.transaction(() => {
    if (body.name) {
      db.query('UPDATE onboarding_items SET name = ? WHERE id = ?').run(body.name, itemId);
    }
    if (body.price !== undefined) {
      db.query('UPDATE onboarding_items SET price = ? WHERE id = ?').run(body.price, itemId);
    }
    // e10s02 (review full-field form, plan §3 row 4): quantity is reviewer-
    // editable for official-page items. Integer-or-null; garbage clears to
    // null rather than storing a malformed value.
    if (body.quantity !== undefined) {
      const parsedQuantity =
        body.quantity === null ? null : Number.parseInt(String(body.quantity), 10);
      const safeQuantity = parsedQuantity !== null && Number.isNaN(parsedQuantity) ? null : parsedQuantity;
      db.query('UPDATE onboarding_items SET quantity = ? WHERE id = ?').run(safeQuantity, itemId);
    }
    if (body.source_url !== undefined) {
      db.query('UPDATE onboarding_items SET source_url = ? WHERE id = ?').run(body.source_url, itemId);
    }
    if (body.status) {
      db.query('UPDATE onboarding_items SET status = ? WHERE id = ?').run(body.status, itemId);
    }
    if (body.brandHint !== undefined) {
      const oldBrandHint = item.brandHint;
      db.query('UPDATE onboarding_items SET brand_hint = ? WHERE id = ?').run(body.brandHint, itemId);
      
      if (body.propagateBrandName && oldBrandHint && oldBrandHint.trim()) {
        db.query('UPDATE onboarding_items SET brand_hint = ? WHERE batch_id = ? AND brand_hint = ?').run(body.brandHint, item.batchId, oldBrandHint);
      }
    }
    if (body.brandDomain !== undefined) {
      const activeBrand = body.brandHint !== undefined ? body.brandHint : item.brandHint;
      if (activeBrand && activeBrand.trim() && body.brandDomain !== null) {
        updateBrandSiteDomain(activeBrand, body.brandDomain.trim());
      }
    }
    if (body.extraction_data) {
      const json = JSON.stringify(body.extraction_data);
      db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
        json,
        itemId
      );
      // Also update the extraction table so both stores stay in sync
      updateLatestExtractionData(itemId, json);
    }
    if (body.curation_data) {
      // Strip all run-owned fields from generic client input, even for a legacy
      // item without a valid run. Only a validated persisted run may restore
      // canonical state below.
      const nextCurationData: Record<string, any> = withoutRunOwnedCurationData(body.curation_data);
      // e10s04: reviewedMedia is written ONLY by PUT /items/:id/media after
      // candidate-set validation. A generic listing save must neither overwrite
      // nor erase it — strip any client-supplied value and carry the persisted
      // selection forward (mirrors the run-owned-key restoration below).
      delete nextCurationData.reviewedMedia;
      if (nextCurationData.curatedWeight !== undefined) {
        nextCurationData.curatedWeight = convertToLbs(nextCurationData.curatedWeight);
      }

      const activeRunId = validatedItemRunId(item);
      if (activeRunId) {
        nextCurationData.classificationRunId = activeRunId;
        nextCurationData.classificationConfigSnapshot = item.curationData?.classificationConfigSnapshot ?? null;
        nextCurationData.classificationProposals = getProposalsByRun(activeRunId);
        nextCurationData.classificationEvidence = getEvidenceByRun(activeRunId);
        nextCurationData.classificationDecisions = getLiveDecisionsByRun(activeRunId);
        nextCurationData.classificationHistory = [];
      }

      const priorReviewedMedia = (
        item.curationData as { reviewedMedia?: unknown } | null | undefined
      )?.reviewedMedia;
      if (priorReviewedMedia !== undefined && priorReviewedMedia !== null) {
        nextCurationData.reviewedMedia = priorReviewedMedia;
      }

      db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
        JSON.stringify(nextCurationData),
        itemId,
      );
    }
  })();

  // Epic #46 Phase 6: a consequential edit invalidates any prior durable
  // review (and clears any approval). The edited fields affect the approved
  // output — the item must be re-reviewed and is never bulk-approvable while
  // invalidated. No-op when the item was never reviewed.
  const consequentialKeys = ['name', 'price', 'quantity', 'brandHint', 'source_url', 'extraction_data', 'curation_data'] as const;
  const isConsequentialEdit = consequentialKeys.some(key => body[key] !== undefined);
  // Epic #46 audit fix (fix 3): an APPROVED promotion-stage item whose
  // output was edited must return to an actionable review state — its
  // durable approval is cleared below, and it can never export again without
  // a fresh review + approval. Capture the pre-edit state BEFORE invalidation
  // (invalidation nulls approved_at).
  const reviewBeforeEdit = getReviewState(itemId);
  const wasApprovedInPromotion =
    routeStageIs(item.stage, 'create_drafts') &&
    Boolean(reviewBeforeEdit?.approvedAt) &&
    !reviewBeforeEdit?.reviewInvalidatedAt;
  if (isConsequentialEdit) {
    markReviewInvalidated(itemId, 'consequential_edit');
    if (wasApprovedInPromotion && reopenApprovedForReapproval(itemId)) {
      onboardingEvents.emitItemStatus(item.batchId, itemId, 'pending', {
        stage: 'review_listings',
        reason: 'reapproval_required',
      });
    }
  }

  return c.json({ success: true });
});

/**
 * PUT /api/onboarding/items/:id/media (story e10s04)
 * Persist the reviewer's media selection into `curation_data.reviewedMedia`.
 *
 * Validation contract (spec §Surface + OVERWRITE consequences):
 * - every requested URL must belong to the candidate-set UNION: the item's
 *   current extraction candidates PLUS previously persisted reviewedMedia
 *   entries — after an overwrite save, prior selections remain valid
 *   candidates even when absent from extraction data; foreign URLs are 400.
 * - distributor-record items: selection is limited to already-approved
 *   display images (rights-attested approvals); commerce approval stays
 *   governed by PI-6 computeCommerceApproved, never by reviewer assertion.
 * - persistence rides curation_data_json wholesale, preserving run-owned
 *   keys (spread of the existing parsed object).
 * - consequential edit: invalidates durable review via the SAME
 *   markReviewInvalidated('consequential_edit') path as generic PUT, and
 *   reopens approved promotion items for re-approval.
 */
route.put('/onboarding/items/:id/media', async (c) => {
  const itemId = c.req.param('id');
  const parsedBody = MediaSelectionRequestSchema.safeParse(await c.req.json());
  if (!parsedBody.success) {
    return c.json({ error: 'Invalid media selection payload.', issues: parsedBody.error.issues }, 400);
  }
  const selection = parsedBody.data;

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;


  const requested = [
    ...(selection.primaryImage ? [selection.primaryImage] : []),
    ...selection.orderedAdditional,
    ...selection.suppressed,
  ];

  for (const u of requested) {
    try {
      const parsed = new URL(u);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return c.json(
          { error: 'Media selection contains invalid URL protocol. Only HTTP and HTTPS URLs are supported.', urls: [u] },
          400,
        );
      }
    } catch {
      return c.json(
        { error: 'Media selection contains malformed URL.', urls: [u] },
        400,
      );
    }
  }

  // Disjointness contract: a URL may occupy exactly ONE role. A primary that
  // is also suppressed is self-contradictory (downstream interpretation would
  // differ per source type); same for an ordered additional that is also
  // suppressed. Reject before any persistence so `reviewedMedia` stays
  // unambiguous regardless of source type.
  const suppressedSelection = new Set(selection.suppressed);
  if (selection.primaryImage !== null && suppressedSelection.has(selection.primaryImage)) {
    return c.json(
      { error: 'primaryImage cannot also appear in suppressed.', urls: [selection.primaryImage] },
      400,
    );
  }
  const roleOverlap = selection.orderedAdditional.filter((url) => suppressedSelection.has(url));
  if (roleOverlap.length > 0) {
    return c.json(
      { error: 'orderedAdditional URLs cannot also appear in suppressed.', urls: roleOverlap },
      400,
    );
  }

  const db = getDb();
  const reviewBeforeEdit = getReviewState(itemId);
  const wasApprovedInPromotion =
    routeStageIs(item.stage, 'create_drafts') &&
    Boolean(reviewBeforeEdit?.approvedAt) &&
    !reviewBeforeEdit?.reviewInvalidatedAt;

  // Known limitation (documented, not fixed — single-operator local CMS):
  // a listing save (PUT /items/:id) and a media save (PUT /items/:id/media)
  // issued concurrently both read item.curationData at request start and
  // last-write-wins the whole JSON blob, so one side's fields can be lost.
  // The epic's OVERWRITE suppression semantics make losing a suppression
  // consequential; operators should avoid interleaving the two saves.
  db.transaction(() => {
    const nextCurationData: Record<string, unknown> = { ...(item.curationData ?? {}) };
    nextCurationData.reviewedMedia = {
      primaryImage: selection.primaryImage,
      orderedAdditional: selection.orderedAdditional,
      suppressed: selection.suppressed,
    };
    db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
      JSON.stringify(nextCurationData),
      itemId,
    );
    // Invalidation is part of the same transaction as the persistence it
    // describes: a failure between write and invalidation would otherwise
    // leave changed media still marked reviewed.
    markReviewInvalidated(itemId, 'consequential_edit');
  })();
  if (wasApprovedInPromotion && reopenApprovedForReapproval(itemId)) {
    onboardingEvents.emitItemStatus(item.batchId, itemId, 'pending', {
      stage: 'review_listings',
      reason: 'reapproval_required',
    });
  }

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/decisions
 * Record classification proposal decisions for an onboarding item.
 *
 * Validates that:
 * - The item has an active classificationRunId.
 * - Every proposal ID is unique.
 * - Every proposal belongs to that exact run, SKU, onboarding item,
 *   current workspace, and a completed/completed_with_abstentions run.
 * - Null/mismatched joined run metadata fails closed.
 *
 * Decisions are recorded in a single transaction. This endpoint does NOT
 * mark the review stage as completed — callers must POST to
 * /onboarding/items/review-complete separately.
 */
route.post('/onboarding/items/:id/decisions', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const parsed = SubmitProposalDecisionsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid decisions payload.', issues: parsed.error.issues }, 400);
  }

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  const activeRunId = item.curationData?.classificationRunId;
  if (!activeRunId) {
    return c.json({
      error: 'Item has no active classification run. Legacy (pre-classification) items cannot accept classification decisions.',
    }, 400);
  }

  if (parsed.data.bulk === true) {
    const proposalIds = parsed.data.decisions.map(decision => decision.proposalId);
    const placeholders = proposalIds.map(() => '?').join(',');
    const ineligible = getDb().query(
      `SELECT id FROM classification_proposals
       WHERE id IN (${placeholders}) AND run_id = ? AND COALESCE(is_bulk_acceptable, 0) = 0`,
    ).all(...proposalIds, activeRunId) as Array<{ id: string }>;
    if (ineligible.length > 0) {
      return c.json({
        error: `Proposal ${ineligible[0].id} is not eligible for bulk acceptance. Use individual review instead.`,
      }, 400);
    }
  }

  const result = submitProposalDecisions({
    workspaceId: workspace.id,
    productSku: item.upc,
    runId: activeRunId,
    sourceKind: 'onboarding',
    onboardingItemId: itemId,
    decisions: parsed.data.decisions,
  });

  if (!result.ok) {
    const status = result.code === 'decision_conflict' ? 409 : 400;
    return c.json({ error: result.reason, code: result.code }, status);
  }

  // This endpoint deliberately does not complete Review. The caller must
  // drain all writes and invoke /review-complete separately.
  return c.json({
    success: true,
    count: result.decisions.length,
    decisions: result.decisions,
  });
});

/**
 * POST /api/onboarding/items/:id/retry
 * Reset an item's stage_status to 'pending' to let the background worker try again.
 * Uses stage-based reset instead of legacy status field.
 */
route.post('/onboarding/items/:id/retry', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;

  // Sourcing items route through the capability-aware reset seam: while the
  // engine capability is DISABLED, retry performs the audited
  // fallback_to_discovery transition (never stranding at sourcing/pending);
  // when ENABLED, retry resets the item in place and supersedes the evidence
  // generation for a clean re-run (ADR 0014).
  if (routeStageIs(item.stage, 'route_sources')) {
    const result = resetItemsForRetry([itemId], {
      sourcingEngineEnabled: sourcingRoutingActive(),
    });
    if (result.moved.length === 0 && result.reset.length === 0) {
      return c.json({ error: `Cannot retry sourcing item: ${result.skipped[0]?.reason ?? 'transition_failed'}` }, 400);
    }
    const worker = getWorker(workspace.id, workspace.workspacePath);
    try {
    worker.poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingRoutes] Background worker poll failed (non-blocking):', pollErr);
  }
    return c.json({ success: true });
  }

  const db = getDb();
  db.query('UPDATE onboarding_items SET stage_status = ?, status = ?, retry_count = 0, error_message = NULL WHERE id = ?').run(
    'pending',
    routeStageIs(item.stage, 'find_product_page') ? 'imported' : 'source_confirmed',
    itemId
  );

  // Trigger worker polling
  const worker = getWorker(workspace.id, workspace.workspacePath);
  try {
    worker.poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingRoutes] Background worker poll failed (non-blocking):', pollErr);
  }

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/select-source
 * Confirms a selected discovery source candidate.
 */
route.post('/onboarding/items/:id/select-source', async (c) => {
  const itemId = c.req.param('id');
  const { sourceId } = await c.req.json();
  if (!sourceId) {
    return c.json({ error: 'sourceId is required' }, 400);
  }

  // Epic #46 audit fix (fix 5): workspace ownership — foreign items are 404
  // before any source is listed or bound.
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;

  // M6 hardening: if unresolved variant matrix present, require select-variant
  try {
    const { getEffectiveVariantResolutionMode } = await import('../../onboarding/variant-flags');
    if (getEffectiveVariantResolutionMode() === 'active') {
      const { getDb } = await import('../../db/connection');
      const db = getDb();
      const res = db.prepare('SELECT status FROM onboarding_variant_resolutions WHERE onboarding_item_id = ? AND superseded_at IS NULL LIMIT 1').get(itemId) as any;
      if (res && (res.status === 'ambiguous' || res.status === 'no_match' || res.status === 'stale')) {
        return c.json({ error: 'Unresolved variant matrix — use select-variant' }, 409);
      }
    }
  } catch {}
  const sources = listSourcesByItem(itemId);
  const selected = sources.find(s => s.id === sourceId);
  if (!selected) {
    return c.json({ error: 'Source candidate not found' }, 404);
  }

  // Builder slice B2 + ticket #123: strategy-bound manual selection cannot
  // admit a non-official candidate as the official source. Authority is the
  // item's CURRENT generation frozen binding first (a live approval edit
  // can never expand a running generation), live approval as fallback.
  // A known retailer/distributor host is never official (hard reject even
  // before boundary evaluation). Legacy unbound rows keep their historical
  // semantics (no check).
  try {
    const { getApprovedBrandStrategy } = await import('../../db/repositories/brand-strategy-approval-repo');
    const { getGenerationStrategyBinding } = await import('../../db/repositories/brand-strategy-generation-repo');
    const { getCurrentSourcingGeneration } = await import('../../db/repositories/onboarding-evidence-repo');
    const { isOfficialDomainMatch } = await import('../../onboarding/domain-utils');
    const { isKnownRetailerOrDistributorDomain } = await import('../../onboarding/discovery/retailer-domain-list');
    let host = '';
    try {
      host = new URL(selected.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      host = '';
    }
    if (host && isKnownRetailerOrDistributorDomain(host)) {
      return c.json(
        { error: 'strategy_source_not_approved', code: 'strategy_source_not_approved', message: 'Selected source is a retailer/distributor host, never an official source' },
        409,
      );
    }
    const officialOf = (sources: Array<{ kind: string; domain?: string | null }>): string[] =>
      sources.filter((s) => s.kind === 'official_page' && s.domain).map((s) => (s.domain as string).toLowerCase());
    let allowed: string[] | null = null;
    // A corrupt binding propagates to the fail-closed 503 below (never a
    // live-approval fallback past a pinned-but-unreadable boundary).
    const generation = getCurrentSourcingGeneration(itemId);
    const binding = generation ? getGenerationStrategyBinding(generation.id) : null;
    if (binding?.mode === 'approved') allowed = officialOf(binding.sources);
    if (allowed === null) {
      const strategyWorkspace = findWorkspace();
      const approved = strategyWorkspace
        ? getApprovedBrandStrategy(strategyWorkspace.id, (item as { brandHint?: string | null }).brandHint ?? null)
        : null;
      if (approved) allowed = officialOf(approved.sources);
    }
    if (allowed !== null) {
      const admitted = allowed.some((d) => isOfficialDomainMatch(host, d));
      if (!admitted) {
        return c.json(
          { error: 'strategy_source_not_approved', code: 'strategy_source_not_approved', message: 'Selected source is outside the approved brand strategy' },
          409,
        );
      }
    }
  } catch (err) {
    // A guard evaluation failure fails closed (never an unguarded write).
    if (err instanceof Response) throw err;
    if (err && typeof err === 'object' && 'status' in (err as Record<string, unknown>)) throw err;
    return c.json(
      { error: 'strategy_guard_unavailable', code: 'strategy_guard_unavailable', message: 'Strategy guard could not be evaluated' },
      503,
    );
  }

  selectSource(sourceId);
  setDiscoverySourceUrl(itemId, selected.url);

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/select-variant
 * M6: durable Choose Variant — server-derived, stale-safe
 */
route.post('/onboarding/items/:id/select-variant', async (c) => {
  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) return c.json({ error: 'Item not found' }, 404);
  const ownershipError = itemWorkspaceError(c, item as any);
  if (ownershipError) return ownershipError;
  // mode active check
  const { getEffectiveVariantResolutionMode } = await import('../../onboarding/variant-flags');
  if (getEffectiveVariantResolutionMode() !== 'active') {
    return c.json({ error: 'Variant resolution not active' }, 409);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const { VariantSelectionRequestSchema } = await import('../../shared/schemas/variant-resolution');
  const parsed = VariantSelectionRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  const { getDb } = await import('../../db/connection');
  const { selectVariantService } = await import('../../onboarding/variant-selection-service');
  const db = getDb();
  try {
    const result = selectVariantService(db, { itemId, resolutionId: parsed.data.resolutionId, identityMatrixHash: parsed.data.identityMatrixHash, variantKey: parsed.data.variantKey });
    // Requeue extraction — reset to extraction/pending and poll worker
    const workspace = findWorkspace();
    if (workspace) {
      try {
        // Slice 5b native: requeue write encodes the observed storage version.
        db.prepare('UPDATE onboarding_items SET stage = ?, stage_status = ?, retry_count = 0, error_message = NULL, updated_at = ? WHERE id = ?').run(encodeForStorage('collect_details', readStorageVersion(db)), 'pending', new Date().toISOString(), itemId);
        const { OnboardingWorker } = await import('../../onboarding/job-queue');
        const worker = new (OnboardingWorker as any)(workspace.id, workspace.workspacePath);
        try { worker.poll(); } catch {}
      } catch {}
    }
    return c.json({ success: true, sourceUrl: result.sourceUrl });
  } catch (e: any) {
    const code = e?.code === 404 ? 404 : e?.code === 409 ? 409 : e?.code === 400 ? 400 : 500;
    return c.json({ error: e?.message ?? 'Variant selection failed' }, code as any);
  }
});

/**
 * POST /api/onboarding/items/:id/set-url
 * Manually set the URL for an onboarding item.
 */
route.post('/onboarding/items/:id/set-url', async (c) => {
  const itemId = c.req.param('id');
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: 'url is required' }, 400);
  }

  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL format' }, 400);
  }

  // Distributor-source items have no product page: their source URL is
  // derived-null by the deterministic materializer. Assigning a URL here
  // would contradict the no-fake-URL rule (ADR 0014 / Amendment A).
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  // Epic #46 audit fix (fix 5): workspace ownership — foreign items are 404.
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;
  if (item.sourceType === 'distributor_record') {
    return c.json(
      {
        error:
          'Distributor-source items cannot set a URL; use Continue-with-Official-Site-Discovery to change the source.',
      },
      400,
    );
  }

  setDiscoverySourceUrl(itemId, url);
  return c.json({ success: true });
});

/**
 * ADR 0017 commitment 4 — re-trigger official site discovery using the SAME
 * re-run flow the existing search_again/retry path uses: reset the item to
 * discovery/pending (retry_count cleared, error cleared, flat status back to
 * 'imported') and poll the background worker so the guided discovery run
 * starts immediately. A background poll failure must never fail the
 * endpoint that triggered it.
 */
function requeueDiscoveryRun(itemId: string, workspaceId: string, workspacePath: string): void {
  const db = getDb();
  db.query(
    'UPDATE onboarding_items SET stage_status = ?, status = ?, retry_count = 0, error_message = NULL WHERE id = ?',
  ).run('pending', 'imported', itemId);
  const worker = getWorker(workspaceId, workspacePath);
  try {
    worker.poll();
  } catch (pollErr) {
    console.error('[OnboardingRoutes] Background worker poll failed (non-blocking):', pollErr);
  }
}

/**
 * POST /api/onboarding/items/:id/assign-brand
 *
 * ADR 0017 commitment 4 — first-class discovery-card attention action,
 * extended to Check source options (route_sources): assign a brand hint to
 * the item and, for Find product page items only, re-run official site
 * discovery guided by that brand. For Check source options items, sourcing
 * reads the saved hint when routing; the item keeps its stage/status and
 * discovery is not re-queued. Controlled-release holds (`missing_brand` and
 * `unresolved_brand`) are released so the newly-branded item can flow
 * (mirroring assign-brand-group).
 *
 * Request:  { "brand": string }
 * Response: 200 { success: true, item } | 400 { error } | 404 { error }
 */
route.post('/onboarding/items/:id/assign-brand', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const brand = (body as { brand?: unknown })?.brand;
  if (typeof brand !== 'string' || brand.trim().length === 0) {
    return c.json({ error: 'brand is required' }, 400);
  }

  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;
  // Ticket #125: generation-aware reassignment. Epoch protection: a
  // caller-supplied expectedBrandHint that no longer matches fails with
  // 409 instead of retargeting another context's payload.
  const expectedBrandHint = (body as { expectedBrandHint?: unknown })?.expectedBrandHint;
  if (typeof expectedBrandHint === 'string' && expectedBrandHint.trim().length > 0) {
    const current = (item.brandHint ?? '').trim().toLowerCase();
    if (current !== expectedBrandHint.trim().toLowerCase()) {
      return c.json(
        { error: 'Brand assignment changed since read', code: 'brand_assignment_conflict' },
        409,
      );
    }
  }
  // A sourcing item the worker holds (in_progress) keeps its generation
  // pin; reassignment waits for an explicit new-generation retry.
  if (routeStageIs(item.stage, 'route_sources') && item.stageStatus === 'in_progress') {
    return c.json(
      { error: 'Item collection is in progress; retry reassignment after the run settles', code: 'brand_assignment_conflict' },
      409,
    );
  }
  const isDiscovery = routeStageIs(item.stage, 'find_product_page');
  const isSourcing = routeStageIs(item.stage, 'route_sources');
  if (!isDiscovery && !isSourcing) {
    return c.json(
      { error: `assign_brand requires the item to be in Check source options (route_sources) or Find product page (find_product_page), got ${item.stage}/${item.stageStatus}` },
      400,
    );
  }

  const trimmedBrand = brand.trim();
  updateItemBrandHint(itemId, trimmedBrand);
  const heldByReleaseGate = item.isHeld && (item.heldReason === 'missing_brand' || item.heldReason === 'unresolved_brand');
  if (isDiscovery) {
    if (heldByReleaseGate) releaseBatchItems(item.batchId, [itemId]);
    requeueDiscoveryRun(itemId, workspace.id, workspace.workspacePath);
  } else if (heldByReleaseGate) {
    releaseBatchItems(item.batchId, [itemId]);
  }
  console.log(
    `[OnboardingRoutes] assign_brand for ${itemId}: brand hint -> "${trimmedBrand}"${isDiscovery ? ', discovery re-queued' : ', sourcing hint saved without discovery requeue'}`,
  );

  return c.json({ success: true, item: findItemById(itemId) });
});

/**
 * POST /api/onboarding/items/:id/assign-domain
 *
 * ADR 0017 commitment 4 — first-class discovery-card attention action:
 * upsert a brand→domain mapping for the item's CURRENT brand hint and
 * re-run official site discovery so the mapped domain guides the search
 * and becomes authority-gate-eligible. Requires the item to already have a
 * brand hint — an operator must assign the brand first (assign_brand),
 * otherwise the mapping would be attached to an unresolved brand identity.
 *
 * Request:  { "domain": string }  (bare domain or URL; scheme/www/path stripped)
 * Response: 200 { success: true, item } | 400 { error } | 404 { error }
 */
route.post('/onboarding/items/:id/assign-domain', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const domain = (body as { domain?: unknown })?.domain;
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    return c.json({ error: 'domain is required' }, 400);
  }

  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;
  if (!routeStageIs(item.stage, 'find_product_page')) {
    return c.json(
      { error: `assign_domain requires the item to be in Find product page (find_product_page), got ${item.stage}/${item.stageStatus}` },
      400,
    );
  }

  const brandHint = item.brandHint;
  if (!brandHint || brandHint.trim().length === 0) {
    return c.json(
      { error: 'This product has no brand assigned yet — assign a brand first (Assign Brand), then map its official domain.' },
      400,
    );
  }

  // Shared guarded logic (brand-domain-service): URL-tolerant normalization,
  // blank/invalid rejection, the ADR 0017 commitment 3 retailer/distributor
  // denylist guard, and the brand_sites upsert. Error strings identical to
  // the pre-refactor inline implementation.
  const result = assignOfficialDomainForBrand({ brand: brandHint.trim(), domain });
  if (!result.ok) {
    return c.json({ error: result.message }, 400);
  }

  requeueDiscoveryRun(itemId, workspace.id, workspace.workspacePath);
  console.log(
    `[OnboardingRoutes] assign_domain for ${itemId}: brand "${result.brand}" -> ${result.domain}, discovery re-queued`,
  );

  return c.json({ success: true, item: findItemById(itemId) });
});

/**
 * GET /api/onboarding/batches/:id/brand-domain-setup
 *
 * ADR 0017 — batch-level 'Resolve Brand Domains' setup queue (epic #46
 * follow-up): discovery items parked because their brand has no mapped
 * official domain, grouped by brand and sorted by blocked-product count. The
 * operator surface mirrors the extractor-profile setup queue (one task per
 * brand: "assign domain for BUTCHERS — unblocks 7 products"). Workspace-scoped
 * like every batch projection.
 *
 * Response: 200 { blockers: BrandDomainSetupBlocker[] } | 404 { error }
 */
route.get('/onboarding/batches/:id/brand-domain-setup', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  return c.json({ blockers: getBrandDomainBlockers(batchId) });
});

/**
 * POST /api/onboarding/batches/:id/brand-domain-setup/:brand
 *
 * ADR 0017 — batch-level domain assignment for an unmapped brand: upserts
 * the brand→domain mapping via the SAME guarded service the per-item
 * assign_domain action uses, then re-queues EVERY discovery item in the
 * batch that is parked for this brand's unmapped domain so guided discovery
 * runs immediately with the mapped domain authority-gate-eligible.
 *
 * Request:  { "domain": string }  (bare domain or URL; scheme/www/path stripped)
 * Response: 200 { success: true, requeued: N, blockers: refreshed list }
 *          | 400 { error } | 404 { error }
 */
route.post('/onboarding/batches/:id/brand-domain-setup/:brand', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  const brand = c.req.param('brand').trim();
  if (!brand) {
    return c.json({ error: 'brand is required' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const domain = (body as { domain?: unknown })?.domain;
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    return c.json({ error: 'domain is required' }, 400);
  }

  // The blocker group: every item in THIS batch parked for this brand's
  // unmapped domain. An empty group still maps the domain (useful for later
  // discovery runs) but has nothing to requeue.
  const blockers = getBrandDomainBlockers(batchId);
  const blocker = blockers.find(b => b.brand === brand);
  const itemIds = blocker?.itemIds ?? [];

  const result = assignOfficialDomainForBrand({ brand, domain });
  if (!result.ok) {
    return c.json({ error: result.message }, 400);
  }

  for (const itemId of itemIds) {
    requeueDiscoveryRun(itemId, workspace.id, workspace.workspacePath);
  }
  console.log(
    `[OnboardingRoutes] brand-domain-setup for batch ${batchId}: brand "${result.brand}" -> ${result.domain}, requeued ${itemIds.length} item(s)`,
  );

  return c.json({
    success: true,
    requeued: itemIds.length,
    blockers: getBrandDomainBlockers(batchId),
  });
});

/**
 * POST /api/onboarding/items/:id/skip
 * Marks item as skipped in its current stage (stage-based).
 */
route.post('/onboarding/items/:id/skip', (c) => {
  const itemId = c.req.param('id');
  skipItems([itemId]);
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/resolve-sourcing
 * Resolves a Sourcing item through one of two strict operator actions:
 *
 * - `use_distributor_record` (Amendment A, MC item 7): the server recomputes
 *   the canonical projection for the item's current generation and, when
 *   qualified, routes to Extraction via `distributor_record_to_extraction`.
 *   Any client-supplied ids/hash/providers are IGNORED (the schema is
 *   closed). Kill-switched (engine effectively off) → 403; marker-v0 legacy
 *   items → 400 (their cohort is Continue-to-Discovery only).
 * - `fallback_to_discovery`: audited operator override; the server derives
 *   the evidence-vs-no-evidence audit route (`evidence_to_discovery` when
 *   accepted evidence exists, else `fallback_to_discovery`).
 *
 * `bundle_to_curation` and direct Sourcing → Curation routing remain
 * PROHIBITED and have zero database effects.
 */
route.post('/onboarding/items/:id/resolve-sourcing', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parseResult = ResolveSourcingRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Invalid resolve sourcing payload', details: parseResult.error.format() }, 400);
  }

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  if (!routeStageIs(item.stage, 'route_sources')) {
    return c.json({ error: `Item is not in the sourcing stage (${item.stage}/${item.stageStatus})` }, 400);
  }

  // Workspace ownership: the item must belong to a batch owned by the active
  // workspace (404 cross-workspace, never a mutation).
  const batch = findBatchById(item.batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }

  if (parseResult.data.action === 'use_distributor_record') {
    // Kill switch + mode gate: effective capability OFF (disabled, malformed,
    // invalid mode) OR observe mode → fail closed before anything else.
    if (!sourcingRoutingActive()) {
      return c.json({ error: 'Sourcing engine is disabled' }, 403);
    }
    // Legacy marker-v0 cohort: Continue-to-Discovery only (MC item 9).
    if (item.sourcingEntryPolicyVersion !== SOURCING_ENTRY_POLICY_VERSION) {
      return c.json(
        { error: 'Legacy sourcing items use Continue-to-Discovery; distributor routing is unavailable' },
        400,
      );
    }
    // Strict manual action: only meaningful from the needs_input holding
    // state (manual-mode evaluation / conflict resolution).
    if (item.stageStatus !== 'needs_input') {
      return c.json({ error: `use_distributor_record requires sourcing/needs_input, got ${item.stageStatus}` }, 400);
    }

    const resolutions = listResolvedConflictResolutions(itemId);
    const result = completeSourcingViaProjection(itemId, resolutions, { strictQualification: true });
    if (!result.ok) {
      return c.json(
        {
          error: `Cannot use distributor record: ${result.reason ?? 'transition_failed'}`,
          reason: result.reason ?? null,
          reasonCodes: result.reasonCodes ?? [],
        },
        400,
      );
    }
    return c.json({
      success: true,
      route: result.route,
      qualified: result.qualified,
      evidenceHash: result.evidenceHash ?? null,
      item: findItemById(itemId),
    });
  }

  const result = fallbackSourcingItemToDiscovery(itemId);
  if (!result.moved) {
    return c.json({ error: `Cannot resolve sourcing item: ${result.reason ?? 'transition_failed'}` }, 400);
  }

  return c.json({ success: true, item: findItemById(itemId) });
});

/**
 * POST /api/onboarding/items/:id/continue-with-official-discovery
 * Amendment A (MD item 8): operator "Continue with Official Site Discovery"
 * for a DISTRIBUTOR-SOURCE item at Extraction (pending/failed, or completed
 * before Curation). One guarded transaction:
 *
 * - source_type → official_page (source_url stays NULL);
 * - the active item extraction payload is cleared;
 * - stage → discovery/pending;
 * - the operator override is recorded.
 *
 * Sourcing generations, evidence attempts, conflicts, acceptances, and prior
 * extraction audit rows are preserved. Later-stage items must first use the
 * existing reviewed send-back flow — no post-Review history rewrite exists.
 */
route.post('/onboarding/items/:id/continue-with-official-discovery', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  const ownershipError = itemWorkspaceError(c, item);
  if (ownershipError) return ownershipError;

  // Guard: only distributor-source items may revert (official items are not
  // distributor-materialized; they already have their own discovery path).
  if (item.sourceType !== 'distributor_record') {
    return c.json({ error: 'Item is not a distributor-source item' }, 400);
  }
  // Stage guard: collect_details pending/failed, or completed before Curation.
  // Anything later must use the reviewed send-back flow.
  if (!routeStageIs(item.stage, 'collect_details') || !['pending', 'failed', 'completed'].includes(item.stageStatus)) {
    return c.json(
      {
        error: `Continue-with-official-discovery requires collect_details pending/failed/completed-before-curation, got ${item.stage}/${item.stageStatus}. Items that advanced past Curation must use the reviewed send-back flow instead.`,
      },
      400,
    );
  }

  const result = revertToOfficialDiscovery(itemId, workspace.id);
  if (!result.ok) {
    return c.json(
      { error: `Cannot continue with official discovery: ${result.reason ?? 'transition_failed'}` },
      400,
    );
  }
  return c.json({ success: true, item: findItemById(itemId) });
});

/**
 * GET /api/onboarding/items/:id/conflicts
 * Durable evidence conflicts for a Sourcing item (ADR 0014). Read-only and
 * always available — evidence review stays visible while the engine is OFF.
 */
route.get('/onboarding/items/:id/conflicts', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }

  // Workspace ownership: the item must belong to a batch owned by the active
  // workspace (404 cross-workspace).
  const batch = findBatchById(item.batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }

  return c.json({ conflicts: listConflictsForItem(itemId) });
});

/**
 * POST /api/onboarding/items/:id/conflicts/:conflictId/resolve
 * Resolve one durable evidence conflict (ADR 0014). Capability-gated: fails
 * closed (403) while the Sourcing engine is disabled. Guards in order:
 * ownership (404), item stage must be sourcing (400), payload validates
 * (400), and the conflict must belong to THIS item (404). Resolving the LAST
 * open hard conflict completes Sourcing via the guarded transition to
 * discovery/pending with an `evidence_to_discovery` operator-override
 * decision — it never routes to Curation.
 */
route.post('/onboarding/items/:id/conflicts/:conflictId/resolve', async (c) => {
  if (!sourcingRoutingActive()) {
    return c.json({ error: 'Sourcing engine is disabled' }, 403);
  }

  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  const conflictId = c.req.param('conflictId');

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }

  // Workspace ownership (404 cross-workspace, never a mutation).
  const batch = findBatchById(item.batchId);
  if (!batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }

  if (!routeStageIs(item.stage, 'route_sources')) {
    return c.json({ error: `Item is not in the sourcing stage (${item.stage}/${item.stageStatus})` }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parseResult = ResolveConflictRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Invalid resolve-conflict payload', details: parseResult.error.format() }, 400);
  }

  const conflict = getConflictById(conflictId);
  if (!conflict || conflict.itemId !== itemId) {
    return c.json({ error: 'Evidence conflict not found' }, 404);
  }

  try {
    resolveConflict(conflictId, parseResult.data, 'operator');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Conflict resolution failed';
    return c.json({ error: message }, 400);
  }

  return c.json({
    success: true,
    item: findItemById(itemId),
    conflicts: listConflictsForItem(itemId),
  });
});

// ─── DEPRECATED BATCH LIFECYCLE ROUTES ─────────────────────────────────────────
// These remain for backward compatibility during migration.
// Use /onboarding/items/advance in the new stage-based model.

// ─── API KEYS AND CACHED BRAND SITES SETTINGS ────────────────────────────────────

route.get('/onboarding/settings/api-keys', (c) => {
  const keys = listApiKeys();
  // Redact actual keys for safety, except for ollama_vlm whose 'enabled' value
  // is a boolean flag, not a real secret.
  const redacted = keys.map(k => ({
    id: k.id,
    service: k.service,
    apiKey: k.service === OLLAMA_VLM_SERVICE_NAME
      ? (k.api_key || '')
      : (k.api_key ? '••••••••' + k.api_key.slice(-4) : ''),
    baseUrl: k.base_url,
    model: k.model
  }));
  return c.json({ keys: redacted });
});

const KNOWN_DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
];

route.get('/onboarding/settings/ollama/status', async (c) => {
  const row = getApiKey('ollama');
  const baseUrl = row?.base_url || 'http://localhost:11434';
  const status = await getLocalRuntimeStatus(baseUrl);
  return c.json(status);
});

route.get('/onboarding/settings/ollama/models', async (c) => {

  const row = getApiKey('ollama');
  const storedBaseUrl = row?.base_url || 'http://localhost:11434/v1';

  const queryBaseUrl = c.req.query('baseUrl');
  const baseUrl = (queryBaseUrl || storedBaseUrl).replace(/\/+$/, '');

  const models = new Set<string>();

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      const data = await res.json() as { data: Array<{ id: string }> };
      if (data && Array.isArray(data.data)) {
        for (const m of data.data) {
          models.add(m.id);
        }
      }
    }
  } catch {
    // If OpenAI-compatible endpoint failed, try Ollama-native endpoint /api/tags
    try {
      const nativeUrl = baseUrl.replace(/\/v1\/?$/, '');
      const nativeRes = await fetch(`${nativeUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (nativeRes.ok) {
        const data = await nativeRes.json() as { models: Array<{ name: string }> };
        if (data && Array.isArray(data.models)) {
          for (const m of data.models) {
            models.add(m.name);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback defaults
  if (models.size === 0) {
    models.add('llama3.2:3b');
    models.add('qwen2.5:3b');
    models.add(DEFAULT_LOCAL_VISION_MODEL);
    models.add('llama3.2');
  }

  return c.json({ models: [...models] });
});

route.get('/onboarding/settings/deepseek/models', async (c) => {
  const row = getApiKey('deepseek');
  let apiKey = row?.api_key;
  const storedBaseUrl = row?.base_url || 'https://api.deepseek.com';

  const queryKey = c.req.query('apiKey');
  if (queryKey) {
    apiKey = queryKey;
  }

  const queryBaseUrl = c.req.query('baseUrl');
  const baseUrl = (queryBaseUrl || storedBaseUrl).replace(/\/+$/, '');

  const models = new Set(KNOWN_DEEPSEEK_MODELS);

  if (apiKey) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json() as { data: Array<{ id: string }> };
        for (const m of data.data) {
          models.add(m.id);
        }
      }
    } catch {
      // Remote models fetch is best-effort; fall back to known list
    }
  }

  return c.json({ models: [...models] });
});

const KNOWN_OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'o4-mini',
  'o3-mini',
];

route.get('/onboarding/settings/openai/models', async (c) => {
  const row = getApiKey('openai');
  let apiKey = row?.api_key;
  const storedBaseUrl = row?.base_url || 'https://api.openai.com/v1';

  const queryKey = c.req.query('apiKey');
  if (queryKey) {
    apiKey = queryKey;
  }

  const queryBaseUrl = c.req.query('baseUrl');
  const baseUrl = (queryBaseUrl || storedBaseUrl).replace(/\/+$/, '');

  const models = new Set(KNOWN_OPENAI_MODELS);

  if (apiKey) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json() as { data: Array<{ id: string }> };
        for (const m of data.data) {
          models.add(m.id);
        }
      }
    } catch {
      // Remote models fetch is best-effort; fall back to known list
    }
  }

  return c.json({ models: [...models] });
});

route.put('/onboarding/settings/api-keys/:service', async (c) => {
  const service = c.req.param('service');
  const { apiKey, baseUrl, model } = await c.req.json();
  if (!apiKey) {
    return c.json({ error: 'apiKey is required' }, 400);
  }

  upsertApiKey(service, apiKey, baseUrl, model);
  return c.json({ success: true });
});

route.delete('/onboarding/settings/api-keys/:service', (c) => {
  const service = c.req.param('service');
  deleteApiKey(service);
  return c.json({ success: true });
});

route.get('/onboarding/settings/brand-sites', async (c) => {
  const sites = listAllBrandSites();
  const db = getDb();
  
  let brandField = 'ProductField16';
  const registryRow = db.query("SELECT xml_field FROM field_registry WHERE LOWER(label) = 'brand' OR LOWER(xml_field) = 'brand' LIMIT 1").get() as { xml_field: string } | undefined;
  if (registryRow) {
    brandField = registryRow.xml_field;
  }

  const brandSet = new Set<string>();
  const catalogBrands: string[] = [];

  const addBrand = (raw: string | null | undefined) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (brandSet.has(key)) return;
    brandSet.add(key);
    catalogBrands.push(trimmed);
  };

  try {
    const queryStr = `
      SELECT DISTINCT json_extract(custom_fields, '$.' || ?) AS brandName 
      FROM product_index 
      WHERE brandName IS NOT NULL AND brandName != ''
      ORDER BY brandName ASC
    `;
    const rows = db.query(queryStr).all(brandField) as { brandName: string }[];
    for (const r of rows) addBrand(r.brandName);
  } catch (e) {
    console.error('Failed to retrieve catalog brands from product_index:', e);
  }

  try {
    const onboardingRows = db.query(`
      SELECT DISTINCT brand_hint AS brandName
      FROM onboarding_items
      WHERE brand_hint IS NOT NULL AND TRIM(brand_hint) != ''
      ORDER BY brand_hint ASC
    `).all() as { brandName: string }[];
    for (const r of onboardingRows) addBrand(r.brandName);
  } catch (e) {
    console.error('Failed to retrieve onboarding brand hints:', e);
  }

  // Issue #150: advisory profiles retired. Suggestions retain catalog and
  // onboarding-hint names (above) plus mapped names and current-workspace
  // stored strategy display names via repository functions (no raw SQL, no
  // multi-workspace union — singleton contract with its bounded conflict).
  for (const site of sites) addBrand(site.brandName);
  try {
    const workspace = getServerSingletonWorkspace();
    if (workspace) {
      for (const input of listStrategyApprovalInputs(workspace.id).values()) {
        if (input.brand) addBrand(input.brand);
      }
    }
  } catch (err) {
    // Singleton contract: ambiguous workspaces fail with the bounded
    // conflict (never a multi-workspace union of approvals). Other read
    // failures keep catalog/mapped names best-effort.
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', code: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
  }

  catalogBrands.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return c.json({ brandSites: sites, catalogBrands });
});

route.post('/onboarding/settings/brand-sites/resolve', async (c) => {
  try {
    const { brands } = await c.req.json();
    if (!brands || !Array.isArray(brands)) {
      return c.json({ error: 'brands array is required' }, 400);
    }

    const mappings: Record<string, string | null> = {};
    for (const brand of brands) {
      if (!brand) continue;
      const sites = findBrandSites(brand);
      mappings[brand] = sites.length > 0 ? sites[0].domain : null;
    }

    return c.json({ mappings });
  } catch (err) {
    console.error('[OnboardingRoutes] Resolve brand domains failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

route.delete('/onboarding/settings/brand-sites/:id', (c) => {
  const id = c.req.param('id');
  deleteBrandSite(id);
  return c.json({ success: true });
});

route.get('/onboarding/settings/extractor-profiles', (c) => {
  const profiles = listAllProfiles();
  return c.json({ extractorProfiles: profiles });
});

route.post('/onboarding/settings/extractor-profiles', async (c) => {
  try {
    const { domain, titleSelector, titleOptionalSelectors, priceSelector, descriptionSelector, brandSelector, imagesSelector, sitemapProductUrlPattern, customSelectors, runtime, shopifyJSONPath, variantSelectionStrategy, customSelectorMetadata } = await c.req.json();
    if (!domain) {
      return c.json({ error: 'domain is required' }, 400);
    }
    const profile = upsertProfile(domain, {
      titleSelector,
      titleOptionalSelectors: Array.isArray(titleOptionalSelectors) ? titleOptionalSelectors : undefined,
      priceSelector,
      descriptionSelector,
      brandSelector,
      imagesSelector,
      sitemapProductUrlPattern,
      customSelectors,
      runtime: runtime === 'static' ? 'static' : runtime === 'rendered' ? 'rendered' : undefined,
      shopifyJSONPath: typeof shopifyJSONPath === 'boolean' ? shopifyJSONPath : undefined,
      variantSelectionStrategy: variantSelectionStrategy ?? undefined,
      customSelectorMetadata: customSelectorMetadata ?? undefined,
    });
    return c.json({ success: true, profile });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

route.delete('/onboarding/settings/extractor-profiles/:id', (c) => {
  const id = c.req.param('id');
  deleteProfile(id);
  return c.json({ success: true });
});

/**
 * GET /api/onboarding/settings/domain-diagnostics
 * Read-only aggregate of every known domain's profile, sitemap,
 * health, brand, and generated-profile signals. The handler does
 * not write, delete, or fetch anything; it only reads through the
 * diagnostics repository variants and returns the resulting
 * snapshot. Intended for the Onboarding Settings UI's
 * "Domain Diagnostics" section.
 */
route.get('/onboarding/settings/domain-diagnostics', (c) => {
  return c.json(getDomainDiagnosticsResponse());
});

/**
 * GET /api/onboarding/settings/extraction-worker/health
 * Returns the extraction worker's health and capabilities.
 * Used by the Onboarding Settings UI to show worker status
 * without exposing worker-host details to the frontend.
 */
route.get('/onboarding/settings/extraction-worker/health', async (c) => {
  const health = await getWorkerHealth();
  if (!health) {
    return c.json({
      ok: false,
      capabilities: { playwright: false, crawlee: false, stagehand: false, camoufox: false },
      version: 'unavailable',
    });
  }
  return c.json(health);
});

/**
 * POST /api/onboarding/settings/profile-tooling/snapshot
 * Proxies to the extraction worker's snapshot endpoint.
 * Validates request body with SnapshotRequestSchema before forwarding.
 * Returns { ok, data } on success, { ok: false, error } on failure.
 */
route.post('/onboarding/settings/profile-tooling/snapshot', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = SnapshotRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await snapshotPage(parsed.data);
  if (!result.ok) {
    return c.json({
      ok: false,
      error: result.error,
    });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * POST /api/onboarding/settings/profile-tooling/generate-selector
 * Proxies to the extraction worker's generate-selector endpoint.
 * Accepts pasted element outerHTML + full page HTML, returns a
 * stable CSS selector + extracted text/images preview.
 */
route.post('/onboarding/settings/profile-tooling/generate-selector', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = GenerateSelectorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await generateSelectorFromElement(parsed.data);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * POST /api/onboarding/settings/profile-tooling/fetch-html
 * Fetches raw HTML from a URL server-side (avoids CORS issues).
 * Used by the paste-element selector generation flow.
 */
route.post('/onboarding/settings/profile-tooling/fetch-html', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const url = (body as any)?.url;
  if (!url || typeof url !== 'string') {
    return c.json({ ok: false, error: 'url is required' }, 400);
  }

  // Block non-HTTP(S) protocols and private/internal IP ranges (SSRF & Local File Disclosure protection)
  try {
    const parsedUrl = new URL(url);
    // Security: Only allow http and https protocols to prevent file:// local file leakage or other schemes
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return c.json({ ok: false, error: 'Only http and https protocols are allowed' }, 400);
    }
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    if (await isPrivateOrLinkLocalHost(hostname)) {
      return c.json({ ok: false, error: 'URL points to a private network address' }, 400);
    }
  } catch {
    return c.json({ ok: false, error: 'Invalid URL' }, 400);
  }

  try {
    let currentUrl = url;
    let response: Response | null = null;
    for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
      // Per-hop SSRF validation: re-validate each redirect target
      try {
        const parsedCurrent = new URL(currentUrl);
        if (parsedCurrent.protocol !== 'http:' && parsedCurrent.protocol !== 'https:') {
          return c.json({ ok: false, error: 'Only http and https protocols are allowed' }, 400);
        }
        const curHostname = parsedCurrent.hostname.replace(/^\[|\]$/g, '');
        if (await isPrivateOrLinkLocalHost(curHostname)) {
          return c.json({ ok: false, error: 'URL points to a private network address' }, 400);
        }
      } catch {
        return c.json({ ok: false, error: 'Invalid URL' }, 400);
      }
      response = await fetch(currentUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          try {
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          } catch {
            return c.json({ ok: false, error: 'Invalid URL' }, 400);
          }
        }
      }
      break;
    }
    if (!response) {
      return c.json({ ok: false, error: 'Failed to fetch URL' }, 500);
    }
    if (!response.ok) {
      return c.json({ ok: false, error: `HTTP ${response.status}` });
    }
    const html = await response.text();
    return c.json({ ok: true, html });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});


/**
 * POST /api/onboarding/settings/profile-tooling/validate
 * Proxies to the extraction worker's validate endpoint.
 * Validates request body with ValidateRequestSchema before forwarding.
 * Returns { ok, data } on success, { ok: false, error } on failure.
 */
route.post('/onboarding/settings/profile-tooling/validate', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = ValidateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await validateProfile(parsed.data);
  if (!result.ok) {
    return c.json({
      ok: false,
      error: result.error,
    });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * POST /api/onboarding/settings/profile-tooling/generate-selectors
 * One-shot LLM selector generation for the Profile Builder.
 *
 * Accepts a snapshot htmlRef + field catalog + optional snapshot context.
 * Returns validated selector suggestions for all requested fields.
 *
 * Rate-limited: 3 requests per authenticated user per rolling minute.
 */
const generationRateLimiter = new Map<string, number[]>();
const activeGenerations = new Map<string, boolean>();

route.post('/onboarding/settings/profile-tooling/generate-selectors', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = GenerateSelectorsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  // Use IP + user-agent as a best-effort user identifier for rate limiting
  const userId =
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    'anonymous';
  const now = Date.now();
  const windowMs = 60_000;

  // Rate limiting: 3 requests per rolling minute per user
  const userTimestamps = generationRateLimiter.get(userId) ?? [];
  const recent = userTimestamps.filter((t) => now - t < windowMs);
  if (recent.length >= 3) {
    return c.json({
      requestId: '',
      error: {
        code: 'LLM_RATE_LIMITED',
        message: 'Rate limit exceeded. Maximum 3 generation requests per minute.',
        retryable: true,
      },
    }, 429);
  }

  // Rate limiting: 1 concurrent generation per user
  if (activeGenerations.get(userId)) {
    return c.json({
      requestId: '',
      error: {
        code: 'LLM_RATE_LIMITED',
        message: 'A generation request is already in progress for this user.',
        retryable: true,
      },
    }, 429);
  }

  activeGenerations.set(userId, true);
  recent.push(now);
  generationRateLimiter.set(userId, recent.slice(-10));

  const requestId = crypto.randomUUID();

  try {
    const result = await generateSelectors(parsed.data, { userId, requestId });
    return c.json(result, 200);
  } catch (err) {
    // Map known errors to standardized error responses
    if (
      (err as any)?.constructor?.name === 'InvalidArtifactReferenceError'
    ) {
      return c.json({
        requestId,
        error: { code: 'INVALID_ARTIFACT_REFERENCE', message: (err as Error).message, retryable: false },
      }, 400);
    }
    if (err instanceof Error && err.name === 'SnapshotNotFoundError') {
      return c.json({
        requestId,
        error: { code: 'SNAPSHOT_NOT_FOUND', message: (err as Error).message, retryable: false },
      }, 404);
    }
    if (err instanceof Error && err.name === 'SnapshotTooLargeError') {
      return c.json({
        requestId,
        error: { code: 'SNAPSHOT_TOO_LARGE', message: (err as Error).message, retryable: false },
      }, 413);
    }
    if (err instanceof Error && err.name === 'UnusableSnapshotError') {
      return c.json({
        requestId,
        error: { code: 'UNUSABLE_SNAPSHOT', message: (err as Error).message, retryable: false },
      }, 422);
    }
    if (err instanceof Error && err.name === 'LlmNotConfiguredError') {
      return c.json({
        requestId,
        error: { code: 'LLM_NOT_CONFIGURED', message: (err as Error).message, retryable: false },
      }, 503);
    }
    if (err instanceof Error && err.name === 'LlmProviderError') {
      const providerErr = err as any;
      const isTimeout = providerErr?.code === 'LLM_RATE_LIMITED';
      if (isTimeout) {
        return c.json({
          requestId,
          error: { code: 'LLM_RATE_LIMITED', message: err.message, retryable: providerErr.retryable },
        }, 429);
      }
      if (providerErr.retryable) {
        return c.json({
          requestId,
          error: { code: 'LLM_UNAVAILABLE', message: err.message, retryable: true },
        }, 503);
      }
      return c.json({
        requestId,
        error: { code: 'INTERNAL_ERROR', message: err.message, retryable: false },
      }, 500);
    }
    if (err instanceof Error && err.name === 'InvalidLlmResponseError') {
      return c.json({
        requestId,
        error: { code: 'INVALID_LLM_RESPONSE', message: (err as Error).message, retryable: true },
      }, 502);
    }

    // Unknown errors → internal
    console.error('[SelectorGen] Unhandled error:', err);
    return c.json({
      requestId,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', retryable: false },
    }, 500);
  } finally {
    activeGenerations.delete(userId);
  }
});

/**
 * GET /api/onboarding/settings/domain-diagnostics/:domain
 * Single-domain diagnostics fetch. Filters full diagnostics by domain,
 * returns entry or 404.
 */
route.get('/onboarding/settings/domain-diagnostics/:domain', (c) => {
  const domain = c.req.param('domain');
  const diagnostics = getDomainDiagnosticsResponse();
  const entry = diagnostics.entries.find(
    (e) => e.domain === domain || e.domain === domain.replace(/^www\./, ''),
  );
  if (!entry) {
    return c.json({ error: 'Domain not found' }, 404);
  }
  return c.json(entry);
});

/**
 * PUT /api/onboarding/settings/domains/:domain
 * Unified domain config: upserts extractor profile selectors and replaces
 * brand associations atomically for a single domain. Returns the updated
 * DomainDiagnosticsEntry for the domain.
 */
route.put('/onboarding/settings/domains/:domain', async (c) => {
  const domain = c.req.param('domain');
  if (!domain) {
    return c.json({ error: 'domain param is required' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = DomainConfigUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  try {
    const entry = upsertDomainConfig(domain, parsed.data);
    return c.json({ domain: entry });
  } catch (err) {
    console.error('[OnboardingRoutes] Domain config upsert failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/onboarding/settings/domain-diagnostics/:domain/generate-profile
 * On-demand AI profile generation for a domain. Profiles are
 * domain-scoped (one profile per domain), so this endpoint produces
 * exactly one proposal.
 *
 * Uses a single anchor product URL from the domain's cached sitemap
 * (or a fresh sitemap fetch). If an open (non-rejected, non-failed)
 * proposal already exists for the domain, the existing proposal ID
 * is returned instead of creating a duplicate.
 *
 * Requires BAYSTATE_CMS_PROFILE_GENERATION_ENABLED and
 * an explicit llm_task_configs row for `profile_generation`.
 * Slow path: fetches a remote page and calls an LLM (10–30s).
 */
route.post('/onboarding/settings/domain-diagnostics/:domain/generate-profile', async (c) => {
  const domain = c.req.param('domain');
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  if (!isProfileGenerationEnabled()) {
    return c.json({
      error: 'Profile generation is disabled. Set BAYSTATE_CMS_PROFILE_GENERATION_ENABLED to enable.',
    }, 400);
  }

  // Dedup: if an open proposal already exists for this domain
  // (non-rejected, non-failed), return it instead of creating
  // a duplicate. Profiles are domain-scoped — one proposal per
  // domain is correct.
  const existingOpen = listProfileGenerationsByDomain(normalizedDomain, {
    orderBy: 'created_at',
    orderDirection: 'DESC',
    limit: 1,
  }).filter(g => g.status !== 'rejected' && g.status !== 'failed');
  if (existingOpen.length > 0) {
    return c.json({
      success: true,
      generationId: existingOpen[0].id,
      existing: true,
      domain: normalizedDomain,
    });
  }

  // Pick a single anchor product URL. Try the cached sitemap first,
  // then a fresh sitemap fetch, then a user-supplied anchor URL.
  let rawUrls: string[] = [];
  const allCaches = listAllSitemapCaches();
  const cache = allCaches.find(row => row.domain === normalizedDomain);
  if (cache && cache.sitemapUrlsCount > 0) {
    rawUrls = cache.urls;
  } else {
    try {
      const sitemapResult = await fetchAndParseSitemap(normalizedDomain);
      if (sitemapResult.urls.length > 0) {
        rawUrls = sitemapResult.urls;
        try { insertSitemapCache(normalizedDomain, sitemapResult.urls, sitemapResult.sourceUrl); } catch { /* best-effort */ }
      }
    } catch (err) {
      console.warn(`[GenerateProfile] Sitemap fetch failed for ${normalizedDomain}:`, err);
    }
  }

  // Allow the client to supply an explicit anchor URL (for domains
  // where the sitemap is stale or the operator wants a specific page).
  let anchorUrl: string | null = null;
  try {
    const body = await c.req.json().catch(() => ({}));
    anchorUrl = (body as { anchorUrl?: string }).anchorUrl ?? null;
  } catch { /* use sitemap only */ }

  // Filter to product-page URLs only.
  const profile = findProfileByDomain(normalizedDomain);
  let urlPattern: RegExp | null = null;
  if (profile?.sitemapProductUrlPattern) {
    try {
      urlPattern = new RegExp(profile.sitemapProductUrlPattern, 'i');
    } catch { /* invalid regex — ignore */ }
  }
  const isProductUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/+$/, '');
      if (path === '' || path === '/') return false;
      if (urlPattern) return urlPattern.test(url);
      return parsed.pathname.startsWith('/products/');
    } catch {
      return false;
    }
  };

  // Resolve the anchor URL: explicit > sitemap > error.
  let resolvedUrl: string;
  if (anchorUrl) {
    resolvedUrl = anchorUrl;
  } else {
    const validUrls = rawUrls.filter(isProductUrl);
    if (validUrls.length === 0) {
      return c.json({
        error: `No product URLs found for ${normalizedDomain}. Run source discovery or supply an anchorUrl in the request body.`,
      }, 400);
    }
    resolvedUrl = validUrls[0];
  }

  // Use the extraction worker's rendered snapshot to fetch the page.
  // This ensures profile generation sees the same rendered DOM as
  // actual extraction (JS-rendered content, JSON-LD, images, etc.),
  // rather than a static HTTP fetch that may miss dynamic content.
  const snapshotResult = await snapshotPage({
    url: resolvedUrl,
    runtime: 'rendered',
    captureScreenshot: false,
  });

  if (!snapshotResult.ok) {
    return c.json({
      error: `Extraction worker is unavailable. Profile generation requires the worker to be running (\`bun run worker:dev\`). Worker error: ${snapshotResult.error}`,
    }, 503);
  }

  const snapshot = snapshotResult.data;
  if (!snapshot.htmlRef) {
    return c.json({
      error: `Worker snapshot completed but returned no HTML for ${snapshot.finalUrl || resolvedUrl}. The page may be blocked or require authentication.`,
    }, 502);
  }

  // Read the HTML from the worker's artifact file
  const htmlPath = path.resolve(process.cwd(), snapshot.htmlRef);
  let html: string;
  try {
    html = fs.readFileSync(htmlPath, 'utf-8');
  } catch (readErr) {
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    return c.json({
      error: `Failed to read snapshot artifact at ${snapshot.htmlRef}: ${msg}`,
    }, 500);
  }

  if (!html || html.trim().length === 0) {
    return c.json({
      error: `Worker snapshot returned empty HTML for ${snapshot.finalUrl || resolvedUrl}. The page may be blocked or require authentication.`,
    }, 502);
  }

  // Use the final URL from the snapshot (accounts for redirects)
  const pageUrl = snapshot.finalUrl || resolvedUrl;

  try {
    const generated = await generateExtractorProfile(pageUrl, html, {
      domain: normalizedDomain,
      sourceUrl: pageUrl,
    });
    if (!generated) {
      return c.json({
        error: `Profile generation returned null for ${pageUrl}. Check that the LLM is configured (Settings → AI Model Routing → profile_generation) and the page HTML is accessible.`,
      }, 500);
    }

    const validation = validateGeneratedProfile(html, generated, {
      domain: normalizedDomain,
      sourceUrl: pageUrl,
    });
    const seedPreview = buildSeedPreview(html, generated, pageUrl);
    const rec = insertProfileGeneration({
      domain: normalizedDomain,
      sourceUrl: pageUrl,
      expectedName: null,
      brandHint: null,
      selectors: generated as unknown as Record<string, unknown>,
      fieldSamples: {
        ...validation.fieldSamples,
        seedPreview,
      } as unknown as Record<string, unknown>,
      validation: {
        valid: validation.valid,
        confidence: validation.confidence,
        status: validation.status,
        reason: validation.reason,
        readyForReview: validation.readyForReview,
      } as unknown as Record<string, unknown>,
      status: 'proposed',
      confidence: validation.confidence,
      llmProvider: null,
      llmModel: null,
      errorMessage: validation.status === 'failed' ? validation.reason : null,
    });

    return c.json({
      success: true,
      generationId: rec.id,
      existing: false,
      domain: normalizedDomain,
      anchorUrl: pageUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GenerateProfile] Failed for ${pageUrl}:`, msg);
    return c.json({
      error: `Profile generation failed: ${msg}`,
    }, 500);
  }
});

route.post('/onboarding/extractor-profiles/test', async (c) => {
  try {
    const { url, titleSelector, titleOptionalSelectors, priceSelector, descriptionSelector, brandSelector, imagesSelector, variantSelectionStrategy, customSelectors } = await c.req.json();
    if (!url) {
      return c.json({ error: 'url is required' }, 400);
    }

    const testResult = await trustedExtract({
      profileId: 'draft',
      profileVersion: 1,
      sourceUrl: url,
      expected: {
        name: 'Test Product',
        brandHint: null,
        price: null,
        spreadsheetHints: {},
      },
      profile: {
        runtime: 'rendered' as const,
        selectors: {
          titleSelector: titleSelector || null,
          priceSelector: priceSelector || null,
          descriptionSelector: descriptionSelector || null,
          brandSelector: brandSelector || null,
          imagesSelector: imagesSelector || null,
        },
        titleOptionalSelectors: Array.isArray(titleOptionalSelectors) ? titleOptionalSelectors : [],
        customSelectors: customSelectors || {},
        imageRules: {},
        variantSelectionStrategy: variantSelectionStrategy || null,
        // Draft test extraction is scoped to the tested page's domain only.
        allowedSourceDomains: [],
      },
    });

    if (!testResult.ok) {
      return c.json({ error: testResult.error }, 500);
    }

    const response = testResult.data;
    if (!response.ok || !response.extractionData) {
      const errorMsg = response.warnings && response.warnings.length > 0
        ? `Extraction failed: ${response.warnings.join('; ')}`
        : 'Extraction failed: No data returned from worker';
      return c.json({ error: errorMsg }, 500);
    }

    const ext = response.extractionData;
    const rawImages = [ext.primaryImage, ...ext.additionalImages].filter(Boolean) as string[];
    const images = cleanAndDeduplicateImages(rawImages, url);

    const result: Record<string, any> = {
      title: ext.title || '',
      price: ext.price || '',
      description: ext.description || '',
      brand: ext.brand || '',
      images,
      ...ext.customFields,
    };

    return c.json({ success: true, extracted: result });
  } catch (err) {
    console.error('[OnboardingRoutes] Custom selector test run failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/onboarding/products/*
 * Serves product images/assets directly from the active workspace directory.
 */
route.get('/onboarding/products/*', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.text('No active workspace loaded', 400);
  }

  const prefix = '/api/onboarding/';
  const relativePath = c.req.path.slice(prefix.length);

  const absolutePath = path.resolve(workspace.workspacePath, relativePath);
  if (!absolutePath.startsWith(path.resolve(workspace.workspacePath))) {
    return c.text('Forbidden', 403);
  }

  if (!fs.existsSync(absolutePath)) {
    return c.text('File not found', 404);
  }

  try {
    const fileContent = fs.readFileSync(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.webp') contentType = 'image/webp';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.svg') contentType = 'image/svg+xml';

    c.header('Content-Type', contentType);
    return c.body(fileContent);
  } catch (err) {
    return c.text(`Error reading asset: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
});

// ─── Profile Governance API (Phase 3) ──────────────────────────────────────

// LLM task configs ───────────────────────────────────────────────────────────

/**
 * GET /api/onboarding/settings/llm-task-configs
 * List all task-routing rows. Provider credentials stay in `api_keys`;
 * these rows only carry provider + model + base URL override.
 */
route.get('/onboarding/settings/llm-task-configs', (c) => {
  const rows = listLlmTaskConfigs();
  return c.json({ taskConfigs: rows, knownTasks: LLM_TASKS });
});

/**
 * PUT /api/onboarding/settings/llm-task-configs/:task
 * Upsert the model + provider for a single AI task.
 */
route.put('/onboarding/settings/llm-task-configs/:task', async (c) => {
  const task = c.req.param('task') as LlmTask;
  if (!LLM_TASKS.includes(task)) {
    return c.json({ error: `Unknown task: ${task}` }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = LlmTaskConfigUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const row = upsertLlmTaskConfig({
    task,
    provider: parsed.data.provider,
    model: parsed.data.model,
    baseUrlOverride: parsed.data.baseUrlOverride ?? null,
    temperature: parsed.data.temperature ?? null,
    reasoningEffort: parsed.data.reasoningEffort ?? null,
  });
  return c.json({ success: true, taskConfig: row });
});

/**
 * DELETE /api/onboarding/settings/llm-task-configs/:task
 * Remove the task routing row. A missing row returns 200 with
 * success=false so the UI can stop showing the row gracefully.
 */
route.delete('/onboarding/settings/llm-task-configs/:task', (c) => {
  const task = c.req.param('task') as LlmTask;
  if (!LLM_TASKS.includes(task)) {
    return c.json({ error: `Unknown task: ${task}` }, 400);
  }
  const removed = deleteLlmTaskConfig(task);
  return c.json({ success: removed });
});

// ─── AI Compute & Provider Connections API ────────────────────────────────────

/**
 * GET /api/onboarding/settings/ai/config
 * Return full AI routing config (sanitized/redacted) and live health reports for all connections.
 */
route.get('/onboarding/settings/ai/config', async (c) => {
  const config = getFullAiRoutingConfig();
  const connections = Object.values(config.connections);

  const healthReports = await Promise.all(
    connections.map(conn => probeConnectionHealth(conn)),
  );

  const healthMap: Record<string, any> = {};
  for (const r of healthReports) {
    healthMap[r.connectionId] = r;
  }

  // Redact credentials from client serialization
  const sanitizedConnections: Record<string, any> = {};
  for (const conn of connections) {
    sanitizedConnections[conn.id] = toClientProviderConnection(conn);
  }

  return c.json({
    config: {
      ...config,
      connections: sanitizedConnections,
    },
    health: healthMap,
  });
});

/**
 * PUT /api/onboarding/settings/ai/defaults
 * Update Catalog Default target, fallback, and Privacy data sharing defaults.
 */
route.put('/onboarding/settings/ai/defaults', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body?.catalogTarget?.connectionId || !body?.catalogTarget?.modelId) {
    return c.json({ error: 'Missing catalogTarget' }, 400);
  }

  saveAiRoutingDefaults({
    catalogTarget: body.catalogTarget,
    catalogFallback: body.catalogFallback ?? null,
    textDataSharing: body.textDataSharing ?? 'cloud_allowed',
    imageDataSharing: body.imageDataSharing ?? 'trusted_lan_allowed',
  });

  return c.json({ success: true });
});

/**
 * PUT /api/onboarding/settings/ai/connections/:id
 * Upsert a ProviderConnection, validating Trust Zone and host pinning.
 */
route.put('/onboarding/settings/ai/connections/:id', async (c) => {
  const id = c.req.param('id');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const conn: ProviderConnection = {
    id,
    label: body.label || id,
    transport: body.transport || 'openai-compatible',
    baseUrl: body.baseUrl,
    credential: body.credential ?? undefined,
    trustZone: body.trustZone || 'this_device',
    approvedHost: body.approvedHost,
    approvedPort: body.approvedPort,
    enabled: body.enabled !== false,
    connectTimeoutMs: body.connectTimeoutMs ?? 2000,
    inferenceTimeoutMs: body.inferenceTimeoutMs ?? 60000,
  };

  try {
    validateConnectionTrustZone(conn);
  } catch (err: any) {
    return c.json({ error: `Trust zone validation failed: ${err.message}`, code: err.code }, 400);
  }

  upsertProviderConnection(conn);
  const health = await probeConnectionHealth(conn, true);
  return c.json({ success: true, connection: toClientProviderConnection(conn), health });
});

/**
 * POST /api/onboarding/settings/ai/connections/test-ephemeral
 * Test an unsaved connection payload in-memory without mutating the database.
 */
route.post('/onboarding/settings/ai/connections/test-ephemeral', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  let effectiveCredential = body.credential;
  if (!effectiveCredential || effectiveCredential === '[REDACTED]' || effectiveCredential === '••••••••••••') {
    if (body.id) {
      const existing = getProviderConnection(body.id);
      if (existing?.credential) {
        effectiveCredential = existing.credential;
      }
    }
  }

  const conn: ProviderConnection = {
    id: body.id || 'test-ephemeral',
    label: body.label || 'Test Connection',
    transport: body.transport || 'openai-compatible',
    baseUrl: body.baseUrl,
    credential: effectiveCredential ?? undefined,
    trustZone: body.trustZone || 'this_device',
    approvedHost: body.approvedHost,
    approvedPort: body.approvedPort,
    enabled: true,
    connectTimeoutMs: body.connectTimeoutMs ?? 2000,
    inferenceTimeoutMs: body.inferenceTimeoutMs ?? 30000,
  };

  try {
    validateConnectionTrustZone(conn);
  } catch (err: any) {
    return c.json({
      health: {
        connectionId: conn.id,
        status: 'misconfigured',
        latencyMs: 0,
        models: [],
        lastChecked: new Date().toISOString(),
        errorMessage: `Validation failed: ${err.message}`,
      },
    });
  }

  const health = await probeConnectionHealth(conn, true);
  return c.json({ health });
});

/**
 * DELETE /api/onboarding/settings/ai/connections/:id
 * Delete a ProviderConnection.
 */
route.delete('/onboarding/settings/ai/connections/:id', (c) => {
  const id = c.req.param('id');
  const deleted = deleteProviderConnection(id);
  return c.json({ success: deleted });
});

/**
 * POST /api/onboarding/settings/ai/connections/:id/probe
 * Force refresh health and model list for an existing connection.
 */
route.post('/onboarding/settings/ai/connections/:id/probe', async (c) => {
  const id = c.req.param('id');
  const conn = getProviderConnection(id);
  if (!conn) {
    return c.json({ error: `Connection "${id}" not found` }, 404);
  }

  const health = await probeConnectionHealth(conn, true);
  return c.json({ success: true, health });
});

/**
 * PUT /api/onboarding/settings/ai/workload-routes/:workload
 * Upsert a WorkloadRoute.
 */
route.put('/onboarding/settings/ai/workload-routes/:workload', async (c) => {
  const workload = c.req.param('workload');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const routeConfig: WorkloadRoute = {
    primary: body.primary ?? 'inherit',
    fallback: body.fallback ?? 'inherit',
    textDataSharing: body.textDataSharing,
    imageDataSharing: body.imageDataSharing,
    terminalBehavior: body.terminalBehavior || 'fail_closed',
  };

  upsertWorkloadRoute(workload, routeConfig);
  return c.json({ success: true, route: routeConfig });
});

// Domain profile governance ──────────────────────────────────────────────────

/**
 * GET /api/onboarding/settings/profile-governance/:domain
 * Domain-level governance summary: active profile, generations,
 * revisions, decisions, sample count.
 */
route.get('/onboarding/settings/profile-governance/:domain', (c) => {
  const domain = c.req.param('domain');
  const summary = listDomainProfileGovernance(domain);
  return c.json(summary);
});

/**
 * GET /api/onboarding/settings/profile-generations?domain=&status=
 * List generated profile proposals. When `domain` is provided, results
 * are scoped to that domain; without `domain`, the route returns the
 * newest proposals across all domains so proposals are visible before
 * an active extractor profile exists.
 */
route.get('/onboarding/settings/profile-generations', (c) => {
  const domain = c.req.query('domain');
  const status = c.req.query('status');
  const options: { status?: 'proposed' | 'validated' | 'rejected' | 'promoted' | 'failed' } = {};
  if (status === 'proposed' || status === 'validated' || status === 'rejected' || status === 'promoted' || status === 'failed') {
    options.status = status;
  }
  const generations = domain
    ? listProfileGenerationsByDomain(domain, options)
    : listAllProfileGenerations(options);
  return c.json({ generations });
});

/**
 * GET /api/onboarding/settings/profile-generations/:id
 * Single generation with its revisions, field decisions, and validation
 * results. The UI uses this for the review drawer.
 */
route.get('/onboarding/settings/profile-generations/:id', (c) => {
  const id = c.req.param('id');
  const generation = findProfileGenerationById(id);
  if (!generation) {
    return c.json({ error: 'Generation not found' }, 404);
  }
  // Ensure revisions exist for legacy generations (backfill on read).
  const backfilledRevision = createInitialRevisionForGeneration(id);
  void backfilledRevision;
  const revisions = listRevisionsByGeneration(id);
  const fieldDecisions = listFieldDecisionsForGeneration(id);
  const validationResults = revisions.flatMap((r) =>
    listValidationResultsForRevision(r.id),
  );
  return c.json({
    generation,
    revisions,
    fieldDecisions,
    validationResults,
  });
});

/**
 * DELETE /api/onboarding/settings/profile-generations/:id
 * Remove a profile generation proposal and all of its cascade
 * children (revisions, validation results, field decisions).
 */
route.delete('/onboarding/settings/profile-generations/:id', (c) => {
  const id = c.req.param('id');
  const deleted = deleteProfileGeneration(id);
  if (!deleted) {
    return c.json({ error: 'Generation not found' }, 404);
  }
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/settings/profile-generations/:id/revisions
 * Create a new revision from structured store-manager feedback.
 */
route.post('/onboarding/settings/profile-generations/:id/revisions', async (c) => {
  const generationId = c.req.param('id');
  const generation = findProfileGenerationById(generationId);
  if (!generation) {
    return c.json({ error: 'Generation not found' }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = ReviseFromFeedbackRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const revision = reviseProfileFromStructuredFeedback({
    generationId,
    parentRevisionId: parsed.data.parentRevisionId ?? null,
    feedback: parsed.data.feedback,
    notes: parsed.data.notes ?? null,
  });
  if (!revision) {
    return c.json({ error: 'Could not create revision' }, 500);
  }

  // ── AI revision: call the LLM to revise selectors based on feedback ──
  // This is deliberately a best-effort step. If the LLM is not configured
  // or the call fails, the feedback revision is still created so the
  // operator can see it. The `draft` status signals that the revision
  // needs an AI pass.
  let finalRevision = revision;
  try {
    const pageUrl = generation.sourceUrl;
    const promptFeedback = parsed.data.feedback;
    const currentSelectors = revision.selectors;

    // Fetch the source page HTML.
    const response = await fetch(pageUrl, {
      headers: HTTP_EXTRACTION_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const html = await response.text();
      const minimized = getMinimizedDom(html);

      const systemPrompt =
        'You are a precise assistant that returns ONLY valid JSON. No markdown, no commentary, no code fences.';

      const userPrompt = `You are a CSS selector expert. Revise the following selectors based on operator feedback.

CURRENT SELECTORS:
${JSON.stringify(currentSelectors, null, 2)}

OPERATOR FEEDBACK:
${JSON.stringify(promptFeedback, null, 2)}

PAGE DOM (minimized):
${minimized.slice(0, 150_000)}

Return ONLY a valid JSON object with exactly these keys:
{ "titleSelector": string|null, "priceSelector": string|null, "descriptionSelector": string|null, "brandSelector": string|null, "imagesSelector": string|null }`;

      const llmResult = await callLlmForTask('profile_revision', userPrompt, systemPrompt, { allowFallback: false });

      if (llmResult) {
        // Strip code fences and parse.
        let cleaned = llmResult.trim();
        const fenceMatch = cleaned.match(/^```(?:json|JSON)?\s*\n?/);
        if (fenceMatch) cleaned = cleaned.slice(fenceMatch[0].length);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trim();

        const parsedSelectors = JSON.parse(cleaned);
        if (parsedSelectors && typeof parsedSelectors === 'object' && !Array.isArray(parsedSelectors)) {
          const selectorFields = ['titleSelector', 'priceSelector', 'descriptionSelector', 'brandSelector', 'imagesSelector'];
          const sanitized: Record<string, unknown> = {};
          for (const key of selectorFields) {
            const val = (parsedSelectors as Record<string, unknown>)[key];
            sanitized[key] = typeof val === 'string' && val.trim() ? val.trim() : null;
          }

          // Update the revision with the new selectors.
          const updated = updateRevisionSelectors(revision.id, sanitized, {
            status: 'validated',
            llmTask: 'profile_revision',
          });
          if (updated) finalRevision = updated;
        }
      }
    }
  } catch (err) {
    // The revision was still created; log the LLM failure but do not
    // reject the request. The revision stays in 'draft' status so the
    // operator knows the AI pass did not complete.
    console.warn(`[Revisions] LLM revision pass failed for ${generationId}:`, err);
  }

  return c.json({ success: true, revision: finalRevision });
});

/**
 * POST /api/onboarding/settings/profile-generations/:id/revisions/:revisionId/validate
 * Re-run validation across confirmed same-domain samples and persist
 * per-field/per-sample results.
 */
route.post(
  '/onboarding/settings/profile-generations/:id/revisions/:revisionId/validate',
  async (c) => {
    const revisionId = c.req.param('revisionId');
    const revision = findProfileGenerationRevisionById(revisionId);
    if (!revision) {
      return c.json({ error: 'Revision not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = ValidateRevisionRequestSchema.safeParse(body ?? {});
    const sampleLimit = parsed.success ? parsed.data.sampleLimit : undefined;
    const generation = findProfileGenerationById(revision.generationId);
    if (!generation) {
      return c.json({ error: 'Parent generation not found' }, 404);
    }
    const result = await validateRevisionAcrossConfirmedSamples(
      revisionId,
      generation.domain,
      { sampleLimit },
    );
    return c.json({ success: true, result });
  },
);

/**
 * POST /api/onboarding/settings/profile-generations/:id/revisions/:revisionId/decisions
 * Approve or reject selected selector fields. The body uses
 * `mode: 'approve' | 'reject'` to route to the right service.
 */
route.post(
  '/onboarding/settings/profile-generations/:id/revisions/:revisionId/decisions',
  async (c) => {
    const revisionId = c.req.param('revisionId');
    const revision = findProfileGenerationRevisionById(revisionId);
    if (!revision) {
      return c.json({ error: 'Revision not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const raw = body as { mode?: string } | null;
    const mode = raw && typeof raw === 'object' ? raw.mode : undefined;
    if (mode !== 'approve' && mode !== 'reject') {
      return c.json({ error: 'Body must include mode: "approve" or "reject"' }, 400);
    }
    if (mode === 'approve') {
      const parsed = ApproveRevisionFieldsRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Invalid approval body', details: parsed.error.flatten() }, 400);
      }
      const result = approveRevisionFields({
        generationId: revision.generationId,
        approvedFields: parsed.data.approvedFields,
        notes: parsed.data.notes ?? null,
        decidedBy: parsed.data.decidedBy ?? null,
        imagePreviewsReviewed: parsed.data.imagePreviewsReviewed === true,
      });
      return c.json({ success: result.imageApprovalAccepted, ...result });
    }
    // mode === 'reject'
    const parsed = RejectRevisionFieldsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid rejection body', details: parsed.error.flatten() }, 400);
    }
    const result = rejectRevisionFields({
      generationId: revision.generationId,
      rejectedFields: parsed.data.rejectedFields as SelectorKey[],
      reason: parsed.data.reason ?? null,
      notes: parsed.data.notes ?? null,
      decidedBy: parsed.data.decidedBy ?? null,
    });
    return c.json({ success: true, ...result });
  },
);

/**
 * POST /api/onboarding/settings/profile-field-decisions/:decisionId/rollback
 * Roll back a previously approved field decision.
 */
route.post('/onboarding/settings/profile-field-decisions/:decisionId/rollback', async (c) => {
  const decisionId = c.req.param('decisionId');
  const decision = findProfileFieldDecisionById(decisionId);
  if (!decision) {
    return c.json({ error: 'Decision not found' }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = RollbackFieldRequestSchema.safeParse(body ?? {});
  const result = rollbackProfileFieldBy({
    decisionId,
    domain: decision.domain,
    selectorField: decision.selectorField as SelectorKey,
    notes: parsed.success ? parsed.data.notes ?? null : null,
    decidedBy: parsed.success ? parsed.data.decidedBy ?? null : null,
  });
  return c.json({ success: result.rolledBack, ...result });
});

// ─── Profile Retry Preview ──────────────────────────────────────────────────────

/**
 * GET /api/onboarding/settings/profile-retry-preview/:domain
 * Query all active batches' items blocked in Extraction with profile-related errors.
 * Filters by domain (sourceUrl hostname or brandHint).
 * Returns items matching ProfileBlockedItemSchema shape.
 */
route.get('/onboarding/settings/profile-retry-preview/:domain', (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const domain = c.req.param('domain');
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  const batches = listBatches(workspace.id).filter(b => b.status === 'active');

  // Profile-related error patterns to match against error_message
  const profileErrorPatterns = [
    'profile',
    'selector',
    'extraction failed',
    'no data extracted',
    'missing selector',
    'health',
    'blocked',
    'unhealthy',
  ];

  const items: ProfileBlockedItem[] = [];

  for (const batch of batches) {
    const staged = listItemsByBatchStaged(batch.id);
    const extractionItems = staged.collect_details || [];

    for (const item of extractionItems) {
      if (item.stageStatus !== 'failed') continue;

      // Filter by domain match (sourceUrl hostname or brandHint)
      const matchesDomain = (): boolean => {
        if (item.brandHint && item.brandHint.toLowerCase() === normalizedDomain) return true;
        if (item.brandHint && normalizedDomain.includes(item.brandHint.toLowerCase())) return true;
        if (item.brandHint && item.brandHint.toLowerCase().includes(normalizedDomain)) return true;
        if (item.sourceUrl) {
          try {
            const hostname = new URL(item.sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
            if (hostname === normalizedDomain || hostname.endsWith('.' + normalizedDomain)) return true;
          } catch {
            // ignore invalid URLs
          }
        }
        return false;
      };
      if (!matchesDomain()) continue;

      // Filter by error message matching profile-related patterns
      if (item.errorMessage) {
        const lowerError = item.errorMessage.toLowerCase();
        const matchesProfileError = profileErrorPatterns.some(p => lowerError.includes(p));
        if (!matchesProfileError) continue;
      }

      items.push({
        itemId: item.id,
        upc: item.upc,
        name: item.name,
        expectedName: item.expectedName ?? null,
        brandHint: item.brandHint ?? null,
        sourceUrl: item.sourceUrl ?? null,
        errorMessage: item.errorMessage,
        blockedAt: item.updatedAt,
      });
    }
  }

  return c.json({ items });
});

/**
 * POST /api/onboarding/settings/profile-retry-preview/:domain/retry
 * Accept { itemIds: string[] } and reset each item's stage_status to 'pending'
 * so the worker picks it up. Returns { accepted: number }.
 */
route.post('/onboarding/settings/profile-retry-preview/:domain/retry', async (c) => {
  const domain = c.req.param('domain');
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  let body: { itemIds?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { itemIds } = body;
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  for (const itemId of itemIds) {
    const item = findItemById(itemId);
    if (!item) {
      return c.json({ error: `Item ${itemId} not found` }, 404);
    }
    const itemDomain = item.sourceUrl
      ? new URL(item.sourceUrl).hostname.replace(/^www\./, '')
      : item.brandHint || '';
    if (itemDomain !== normalizedDomain) {
      return c.json({ error: `Item ${itemId} does not belong to domain ${domain}` }, 400);
    }
  }

  // Ticket #105 (review P0-2): pre-scan every item for active manual
  // evidence BEFORE any write. Resetting a manual-completed item would
  // strand its extraction row + active attestation and silently clobber
  // operator work, so refuse the whole batch with zero writes and direct
  // the operator to withdraw first; the withdrawn (failed) item is
  // retryable again per item.
  const activeManualIds = itemIds.filter((itemId) => hasActiveManualEvidence(itemId));
  if (activeManualIds.length > 0) {
    return c.json(
      {
        error: {
          code: MANUAL_EVIDENCE_ACTIVE_RETRY_CODE,
          message: `Item ${activeManualIds[0]} holds active manual evidence — withdraw it first, then retry.`,
          itemIds: activeManualIds,
        },
      },
      409,
    );
  }

  let accepted = 0;
  for (const itemId of itemIds) {
    updateItemStageStatus(itemId, 'pending');
    accepted++;
  }

  return c.json({ accepted });
});

export default route;
