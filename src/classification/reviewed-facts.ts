/**
 * Reviewed Facts
 *
 * Reviewed facts are accepted/reviewed proposal decisions that may be carried
 * into the next classification run's immutable snapshot as compatible input.
 * Only accepted decisions with a live (non-superseded) decision row qualify;
 * pending guesses and provisional predictions never become facts.
 *
 * Facts preserve full provenance (source decision ID, run ID, config/snapshot
 * hash, and source hash) and are only reusable while every provenance
 * dimension still matches the current snapshot. Drift invalidates a fact
 * rather than silently reusing it.
 */
import type { ClassificationProposal } from '../shared/types';
import { getEffectiveProposalTargetId, getEffectiveProposalValue } from './assignment-projection';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getDb } from '../db/connection';

export interface ReviewedFact {
  /** The proposal the decision was made on. */
  proposalId: string;
  /** The durable decision row that accepted the fact. */
  decisionId: string;
  /** The classification run that produced the proposal. */
  runId: string;
  workspaceId: string;
  productSku: string;
  proposalType: string;
  /** Effective target: revised target if present, else the immutable prediction target. */
  targetId: string | null;
  /** Effective value: revised value if present, else the immutable predicted value. */
  value: unknown;
  /** Config/snapshot hash the proposal run was created under. */
  configSnapshotHash: string | null;
  /** Source product/evidence hash of the proposal run. */
  sourceHash: string | null;
  createdAt: string;
}

export interface CollectReviewedFactsInput {
  workspaceId: string;
  productSku: string;
}

/**
 * Read every accepted, live decision for a product as a reviewed fact.
 * Never reads pending proposals or superseded decisions.
 */
export function collectReviewedFacts(input: CollectReviewedFactsInput): ReviewedFact[] {
  const db = getDb();
  const rows = db.query(
    `SELECT p.id AS proposal_id, d.id AS decision_id, p.run_id, r.workspace_id,
            p.product_sku, p.proposal_type, p.target_id, p.proposed_value_json,
            d.revised_value_json, d.revised_target_id, r.config_snapshot_hash,
            r.source_product_hash, d.created_at
     FROM classification_proposals p
     JOIN classification_runs r ON r.id = p.run_id
     JOIN classification_proposal_decisions d ON d.proposal_id = p.id
     WHERE p.product_sku = ? AND r.workspace_id = ?
        AND d.decision = 'accepted' AND d.superseded_at IS NULL
        AND p.superseded_at IS NULL AND COALESCE(p.is_stale, 0) = 0
        AND COALESCE(d.decision_origin, 'unknown') = 'human_review'
     ORDER BY d.created_at DESC, d.rowid DESC`,
  ).all(input.productSku, input.workspaceId) as Array<Record<string, unknown>>;

  return rows.map(row => {
    const revisedValueJson = row.revised_value_json == null ? null : String(row.revised_value_json);
    const proposedValueJson = row.proposed_value_json == null ? null : String(row.proposed_value_json);
    const revisedTargetId = row.revised_target_id == null ? null : String(row.revised_target_id);
    const targetId = row.target_id == null ? null : String(row.target_id);
    return {
      proposalId: String(row.proposal_id),
      decisionId: String(row.decision_id),
      runId: String(row.run_id),
      workspaceId: String(row.workspace_id),
      productSku: String(row.product_sku),
      proposalType: String(row.proposal_type),
      targetId: revisedTargetId ?? targetId,
      value: revisedValueJson != null
        ? JSON.parse(revisedValueJson)
        : proposedValueJson != null
          ? JSON.parse(proposedValueJson)
          : null,
      configSnapshotHash: row.config_snapshot_hash == null ? null : String(row.config_snapshot_hash),
      sourceHash: row.source_product_hash == null ? null : String(row.source_product_hash),
      createdAt: String(row.created_at),
    };
  });
}

/**
 * Normalize the absent-source representation. Onboarding runs have no product
 * source hash: the snapshot builds with an empty string while the persisted
 * run row stores NULL. Both mean "no source identity" and must compare equal
 * so carried facts survive; a real digest is never coerced.
 */
export function normalizeAbsentHash(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value;
}

/**
 * A fact is compatible only when its config snapshot hash and source hash both
 * match the current snapshot. Drift in either dimension invalidates the fact.
 */
export function isFactCompatible(
  fact: ReviewedFact,
  currentConfigHash: string | null,
  currentSourceHash: string | null,
): boolean {
  if (fact.configSnapshotHash !== currentConfigHash) return false;
  if (normalizeAbsentHash(fact.sourceHash) !== normalizeAbsentHash(currentSourceHash)) return false;
  return true;
}

/**
 * Filter a fact list to the facts compatible with the current snapshot.
 * Incompatible (drifted) facts are dropped, never silently reused.
 */
export function filterCompatibleFacts(
  facts: ReviewedFact[],
  currentConfigHash: string | null,
  currentSourceHash: string | null,
): ReviewedFact[] {
  return facts.filter(fact => isFactCompatible(fact, currentConfigHash, currentSourceHash));
}

/**
 * Overlay this run's accepted field decisions on the compatible facts captured
 * by its snapshot. Cleared values still replace their prior target fact.
 */
export function composeEffectiveReviewedFacts(
  snapshot: RuntimeClassificationSnapshot | undefined,
  currentRunProposals: readonly ClassificationProposal[],
  runId: string,
): ReviewedFact[] {
  if (!snapshot) return [];

  const replacedTargets = new Set<string>();
  const currentFacts: ReviewedFact[] = [];
  for (const proposal of currentRunProposals) {
    if (
      proposal.runId !== runId
      || proposal.productSku !== snapshot.productSku
      || proposal.proposalType !== 'field_assignment'
      || proposal.status !== 'accepted'
      || proposal.isStale
      || !proposal.currentDecisionId
    ) continue;

    const targetId = getEffectiveProposalTargetId(proposal);
    if (proposal.targetId) replacedTargets.add(proposal.targetId);
    if (targetId) replacedTargets.add(targetId);
    const value = getEffectiveProposalValue(proposal);
    if (
      targetId
      && value !== null
      && value !== undefined
      && !(typeof value === 'string' && value.trim().length === 0)
      && !(Array.isArray(value) && value.length === 0)
    ) {
      currentFacts.push({
        proposalId: proposal.id,
        decisionId: proposal.currentDecisionId,
        runId,
        workspaceId: snapshot.workspaceId,
        productSku: snapshot.productSku,
        proposalType: proposal.proposalType,
        targetId,
        value,
        configSnapshotHash: snapshot.configSnapshotRef.hash,
        sourceHash: snapshot.sourceProductHash,
        createdAt: proposal.createdAt,
      });
    }
  }

  return [
    ...currentFacts,
    ...snapshot.reviewedFacts.filter(fact =>
      fact.proposalType !== 'field_assignment' || !fact.targetId || !replacedTargets.has(fact.targetId),
    ),
  ];
}
