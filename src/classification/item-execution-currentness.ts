import { hashCanonicalJson } from '../shared/stable-id';
import { ItemExecutionCurrentnessSchema } from '../shared/schemas/item-evidence';
import type { AcceptedItemEvidence, ItemExecutionCurrentness } from '../shared/schemas/item-evidence';
import type { ClassificationEvidence, ClassificationProposal } from '../shared/schemas/classification';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';

export interface ClassificationStageOutput {
  stage_name: string;
  output_json: string | null;
}

/** Hash immutable run output while excluding all reviewer-mutable proposal state. */
export function hashClassificationRunOutput(input: {
  evidence: ClassificationEvidence[];
  proposals: ClassificationProposal[];
  stageResults: ClassificationStageOutput[];
}): string {
  const evidence = input.evidence.map(entry => ({
    id: entry.id, runId: entry.runId, stageName: entry.stageName, productSku: entry.productSku,
    attributeId: entry.attributeId, source: entry.source, reliability: entry.reliability,
    sourceUrl: entry.sourceUrl, sourceField: entry.sourceField, snippet: entry.snippet,
    value: entry.value, metadata: entry.metadata, capturedAt: entry.capturedAt,
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const proposals = input.proposals.map(proposal => ({
    id: proposal.id,
    runId: proposal.runId,
    productSku: proposal.productSku,
    proposalType: proposal.proposalType,
    targetId: proposal.targetId,
    proposedValue: proposal.proposedValue,
    confidence: proposal.confidence,
    evidenceIds: proposal.evidenceIds,
    supportingEvidenceIds: proposal.supportingEvidenceIds ?? null,
    contradictingEvidenceIds: proposal.contradictingEvidenceIds ?? null,
    derivation: proposal.derivation ?? null,
    modelCallIds: proposal.modelCallIds ?? null,
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const stageResults = input.stageResults.map(result => ({ stageName: result.stage_name, outputJson: result.output_json }));
  return hashCanonicalJson({ version: 1, evidence, proposals, stageResults });
}

export type ItemExecutionCurrentnessFields = Omit<ItemExecutionCurrentness, 'runCurrentnessHash'>;

/** Build the strict persisted record and bind all frozen inputs to its currentness hash. */
export function buildItemExecutionCurrentness(fields: ItemExecutionCurrentnessFields): ItemExecutionCurrentness {
  const parsed = ItemExecutionCurrentnessSchema.omit({ runCurrentnessHash: true }).parse(fields);
  return ItemExecutionCurrentnessSchema.parse({ ...parsed, runCurrentnessHash: hashCanonicalJson(parsed) });
}

/** Validate the stored immutable run receipt against live bindings and output. */
export function validateItemExecutionCurrentness(input: {
  currentness: unknown;
  expected: ItemExecutionCurrentnessFields;
  classificationOutputHash: string;
}): boolean {
  const parsed = ItemExecutionCurrentnessSchema.safeParse(input.currentness);
  if (!parsed.success || parsed.data.classificationOutputHash !== input.classificationOutputHash) return false;
  const { runCurrentnessHash, ...fields } = parsed.data;
  if (runCurrentnessHash !== hashCanonicalJson(fields)) return false;
  return hashCanonicalJson(fields) === hashCanonicalJson(input.expected);
}

/** Assemble the expected receipt from current item-local run and evidence state. */
export function validateLiveItemExecutionCurrentness(input: {
  workspaceId: string;
  item: { id: string; batchId: string; upc: string; inputRevision: string; curationData: { classificationRunId?: string | null; itemExecutionCurrentness?: unknown } | null };
  run: ClassificationRunRow;
  evidence: AcceptedItemEvidence;
  configSnapshotId: string | null;
  configSnapshotHash: string;
  runtimeSnapshotHash: string;
  policyDigest: string;
  classificationEvidence: ClassificationEvidence[];
  proposals: ClassificationProposal[];
  stageResults: ClassificationStageOutput[];
}): boolean {
  const { item, run, evidence } = input;
  if (run.sourceKind !== 'onboarding' || run.status !== 'completed' && run.status !== 'completed_with_abstentions' ||
      run.workspaceId !== input.workspaceId || run.onboardingItemId !== item.id || run.productSku !== item.upc ||
      item.curationData?.classificationRunId !== run.id || evidence.workspaceId !== input.workspaceId ||
      evidence.batchId !== item.batchId || evidence.itemId !== item.id || evidence.sku !== item.upc) return false;
  const classificationOutputHash = hashClassificationRunOutput({
    evidence: input.classificationEvidence,
    proposals: input.proposals,
    stageResults: input.stageResults,
  });
  const expected: ItemExecutionCurrentnessFields = {
    recordVersion: 1,
    inputRevision: item.inputRevision,
    evidenceId: evidence.id,
    evidenceRevision: evidence.revision,
    evidenceHash: evidence.evidenceHash,
    inputHash: evidence.inputHash,
    sourceStateHash: evidence.sourceStateHash,
    authorityHash: evidence.authorityHash,
    configSnapshotId: input.configSnapshotId,
    configSnapshotHash: input.configSnapshotHash,
    runtimeSnapshotId: null,
    runtimeSnapshotHash: input.runtimeSnapshotHash,
    policyDigest: input.policyDigest,
    classificationRunId: run.id,
    classificationOutputHash,
  };
  return validateItemExecutionCurrentness({
    currentness: item.curationData?.itemExecutionCurrentness,
    expected,
    classificationOutputHash,
  });
}
