import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComparisonInput, ComparisonItem, ComparisonSource, CostEffect } from './comparison-report';
import { getCurrentItemEvidence, listItemEvidenceSnapshots } from '../src/db/repositories/accepted-item-evidence-repo';
import { getEvidenceAttemptsForItem, listGenerationsForItem } from '../src/db/repositories/onboarding-evidence-repo';
import { listItemsByBatch } from '../src/db/repositories/onboarding-item-repo';
import type { OnboardingItem } from '../src/shared/schemas/onboarding';
import { listReviewStates } from '../src/db/repositories/onboarding-review-repo';
import { listListingCompletenessExceptions } from '../src/db/repositories/listing-completeness-exception-repo';
import { getDiscoveryModelCallsByRun } from '../src/db/repositories/discovery-model-call-repo';
import { getModelCallsByRun } from '../src/db/repositories/classification-model-call-repo';
import { getAiModelCallsByWorkspace } from '../src/db/repositories/ai-model-call-repo';
import { getEvidenceByRun, getProposalsByRun, getRun, getStageResults } from '../src/db/repositories/classification-run-repo';
import { listDiscoveryRunsForBatch, listSourcesByItem, readDiscoveryAssessment } from '../src/db/repositories/onboarding-source-repo';
import type { PaidEffectBudgetSnapshot } from '../src/db/repositories/qualification-run-budget-repo';

export type CaptureAvailability = { status: 'available' | 'unavailable'; reason: string | null };
export type ComparisonCaptureBundle = {
  schema_version: 1;
  run_id: string;
  arm: 'baseline' | 'candidate';
  measurement_mode: 'controlled_replay' | 'live_operational';
  captured_at: string;
  completeness: 'complete' | 'partial';
  inputs: ComparisonInput[];
  original_rows: unknown[];
  items: Array<ComparisonItem & { row_number: number | null; batch_id: string; workspace_id: string; raw: OnboardingItem }>;
  sources: ComparisonSource[];
  discovery_runs: unknown[];
  discovery_assessments: unknown[];
  discovery_attempts: unknown[];
  classification_runs: unknown[];
  classification_details: Record<string, unknown>;
  classification_attempts: unknown[];
  general_model_calls: unknown[];
  evidence_attempts: unknown[];
  source_generations: unknown[];
  accepted_evidence: unknown[];
  current_evidence: Record<string, unknown>;
  currentness: Record<string, unknown>;
  checklist_claims_exceptions: Record<string, unknown>;
  review_state: Record<string, unknown>;
  provider_ledgers: Record<'systemone' | 'network' | 'serper' | 'browser', CaptureAvailability & { rows: unknown[] }>;
  budget_journal: CaptureAvailability & { snapshot: PaidEffectBudgetSnapshot | null; effects: CostEffect[] };
  unavailable: string[];
};

/** Read through repository-owned readers; missing seams remain explicitly unavailable, never empty evidence. */
export function captureComparisonArm(input: {
  runId: string;
  arm: 'baseline' | 'candidate';
  mode: 'controlled_replay' | 'live_operational';
  batchId: string;
  workspaceId: string;
  sourceRows: ComparisonInput[];
  originalRows: unknown[];
  budgetSnapshot?: PaidEffectBudgetSnapshot | null;
}): ComparisonCaptureBundle {
  const unavailable: string[] = [];
  const items = listItemsByBatch(input.batchId);
  const runs = listDiscoveryRunsForBatch(input.batchId);
  const sources: ComparisonSource[] = [];
  const evidenceAttempts: unknown[] = [];
  const generations: unknown[] = [];
  const accepted: unknown[] = [];
  const currentEvidence: Record<string, unknown> = {};
  const currentness: Record<string, unknown> = {};
  const exceptions: Record<string, unknown> = {};
  for (const item of items) {
    sources.push(...listSourcesByItem(item.id).map(source => ({ id: source.id, itemId: source.itemId, url: source.url, isSelected: source.isSelected })));
    evidenceAttempts.push(...getEvidenceAttemptsForItem(item.id));
    generations.push(...listGenerationsForItem(item.id));
    accepted.push(...listItemEvidenceSnapshots(input.workspaceId, item.id));
    currentEvidence[item.id] = getCurrentItemEvidence(input.workspaceId, item.id);
    currentness[item.id] = item.curationData?.itemExecutionCurrentness ?? { status: 'unavailable', reason: 'item_currentness_record_absent' };
    try {
      exceptions[item.id] = {
        checklist: item.curationData?.listingCompleteness ?? null,
        claims: item.curationData?.listingEvidenceValidation ?? null,
        exceptions: listListingCompletenessExceptions(input.workspaceId, item.id),
      };
    } catch {
      exceptions[item.id] = {
        checklist: item.curationData?.listingCompleteness ?? null,
        claims: item.curationData?.listingEvidenceValidation ?? null,
        exceptions: { status: 'unavailable', reason: 'listing_completeness_exception_reader_unavailable' },
      };
      unavailable.push('checklist_claims_exceptions');
    }
  }
  const discoveryAttempts = runs.flatMap(run => getDiscoveryModelCallsByRun(run.id));
  const discoveryAssessments = runs.map(run => ({ runId: run.id, itemId: run.item_id, assessment: readDiscoveryAssessment({ runId: run.id, itemId: run.item_id }) }));
  const classificationRuns: unknown[] = [];
  const classificationAttempts: unknown[] = [];
  const classificationDetails: Record<string, unknown> = {};
  for (const item of items) {
    const runId = item.curationData?.classificationRunId;
    if (!runId) continue;
    const run = getRun(runId);
    if (!run) continue;
    classificationRuns.push(run);
    classificationAttempts.push(...getModelCallsByRun(runId));
    classificationDetails[runId] = { stageResults: getStageResults(runId), evidence: getEvidenceByRun(runId), proposals: getProposalsByRun(runId) };
  }
  const generalCalls = getAiModelCallsByWorkspace(input.workspaceId, 50);
  if (generalCalls.length === 50) unavailable.push('general_model_calls_over_reader_limit');
  const reviews = Object.fromEntries(listReviewStates(input.batchId));
  const providerLedgers = Object.fromEntries((['systemone', 'network', 'serper', 'browser'] as const).map(provider => [provider, {
    status: 'unavailable' as const,
    reason: `provider_ledger_reader_not_available:${provider}`,
    rows: [] as unknown[],
  }])) as unknown as ComparisonCaptureBundle['provider_ledgers'];
  const budgetSnapshot = input.budgetSnapshot ?? null;
  const budgetEffects: CostEffect[] = budgetSnapshot?.effects.map(effect => ({
    id: effect.idempotencyKey,
    arm: effect.arm,
    attempt_id: effect.idempotencyKey,
    logical_effect_id: effect.descriptor.logicalEffectId,
    beneficiary_ids: effect.beneficiaries.map(beneficiary => beneficiary.id),
    amount_micros: effect.state === 'settled' ? effect.actualCostMicros : effect.maximumChargeMicros,
    kind: effect.state === 'settled' ? 'billed' : effect.state === 'reserved' ? 'reserved' : 'unknown',
  })) ?? [];
  if (!budgetSnapshot) unavailable.push('budget_journal');
  if (classificationRuns.length === 0) unavailable.push('classification_runs');
  if (items.length === 0) unavailable.push('arm_items');
  for (const provider of Object.keys(providerLedgers)) unavailable.push(`provider_ledger:${provider}`);
  const partial = unavailable.length > 0 || items.some(item => (item.stageStatus as string) === 'in_progress');
  return {
    schema_version: 1,
    run_id: input.runId,
    arm: input.arm,
    measurement_mode: input.mode,
    captured_at: new Date().toISOString(),
    completeness: partial ? 'partial' : 'complete',
    inputs: input.sourceRows,
    original_rows: input.originalRows,
    items: items.map(item => ({
      id: item.id, upc: item.upc, stage: item.stage, stageStatus: item.stageStatus, status: item.status,
      errorMessage: item.errorMessage ?? null, sourceUrl: item.sourceUrl ?? null,
      preparationStop: (item.stage === 'review_listings' || item.stage === 'review') && item.stageStatus === 'pending' ? 'review_ready_for_operator' :
        item.stageStatus === 'failed' ? 'failed' : item.stageStatus === 'needs_input' ? 'needs_input' : null,
      row_number: item.rowNumber ?? null, batch_id: item.batchId, workspace_id: input.workspaceId, raw: item,
    })),
    sources,
    discovery_runs: runs,
    discovery_assessments: discoveryAssessments,
    discovery_attempts: discoveryAttempts,
    classification_runs: classificationRuns,
    classification_details: classificationDetails,
    classification_attempts: classificationAttempts,
    general_model_calls: generalCalls,
    evidence_attempts: evidenceAttempts,
    source_generations: generations,
    accepted_evidence: accepted,
    current_evidence: currentEvidence,
    currentness,
    checklist_claims_exceptions: exceptions,
    review_state: reviews,
    provider_ledgers: providerLedgers,
    budget_journal: { status: budgetSnapshot ? 'available' : 'unavailable', reason: budgetSnapshot ? null : 'budget_snapshot_not_supplied', snapshot: budgetSnapshot, effects: budgetEffects },
    unavailable: [...new Set(unavailable)],
  };
}
export function unavailableComparisonCapture(input: {
  runId: string;
  arm: 'baseline' | 'candidate';
  mode: 'controlled_replay' | 'live_operational';
  sourceRows: ComparisonInput[];
  originalRows: unknown[];
  reason: string;
}): ComparisonCaptureBundle {
  return {
    schema_version: 1,
    run_id: input.runId,
    arm: input.arm,
    measurement_mode: input.mode,
    captured_at: new Date().toISOString(),
    completeness: 'partial',
    inputs: input.sourceRows,
    original_rows: input.originalRows,
    items: [],
    sources: [],
    discovery_runs: [],
    discovery_assessments: [],
    discovery_attempts: [],
    classification_runs: [],
    classification_details: {},
    classification_attempts: [],
    general_model_calls: [],
    evidence_attempts: [],
    source_generations: [],
    accepted_evidence: [],
    current_evidence: {},
    currentness: {},
    checklist_claims_exceptions: {},
    review_state: {},
    provider_ledgers: {
      systemone: { status: 'unavailable', reason: input.reason, rows: [] },
      network: { status: 'unavailable', reason: input.reason, rows: [] },
      serper: { status: 'unavailable', reason: input.reason, rows: [] },
      browser: { status: 'unavailable', reason: input.reason, rows: [] },
    },
    budget_journal: { status: 'unavailable', reason: input.reason, snapshot: null, effects: [] },
    unavailable: ['arm_items', 'sources', 'discovery_runs', 'discovery_assessments', 'discovery_attempts',
      'classification_runs', 'classification_attempts', 'general_model_calls', 'evidence_attempts',
      'source_generations', 'accepted_evidence', 'currentness', 'checklist_claims_exceptions', 'review_state',
      'provider_ledger:systemone', 'provider_ledger:network', 'provider_ledger:serper', 'provider_ledger:browser',
      'budget_journal', `repository_capture:${input.reason}`],
  };
}

/** Publish the full or partial capture atomically with exclusive destination creation. */
export async function writeComparisonCapture(file: string, bundle: ComparisonCaptureBundle): Promise<void> {
  const directory = dirname(file);
  const temporary = join(directory, `.capture-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
    await link(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
