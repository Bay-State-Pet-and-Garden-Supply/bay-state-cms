/**
 * Type Review Detail Helper (P1.3).
 *
 * Assembles the typeReview projection for GET /api/onboarding/items/:id:
 * - reviewed: current human-reviewed Product Type, label, and authority state
 * - executionPreview: candidate Product Type proposal tagged previewOnly: true
 * - options: configured options with hierarchy paths from immutable taxonomy release
 * - evidence: deterministic verifier evidence summary
 * - refreshState: current recomputation status ('current' | 'queued' | 'running' | 'failed' | 'blocked')
 */

import { Database } from 'bun:sqlite';
import type { TypeReviewDetail, ProductTypeConfigV2 } from '../shared/schemas/classification';
import { loadAndValidateProductTypeCurrentness } from './classification-currentness';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { verifyProductTypeCandidate } from './product-type-verifier';

export function computeTypeReviewDetail(
  db: Database,
  workspaceId: string,
  itemId: string,
  productSku: string,
  activeRunId: string | null,
): TypeReviewDetail | null {
  if (!activeRunId) {
    return null;
  }

  const run = db.query(
    'SELECT id, workspace_id, product_sku, config_snapshot_hash FROM classification_runs WHERE id = ?',
  ).get(activeRunId) as {
    id: string;
    workspace_id: string;
    product_sku: string;
    config_snapshot_hash: string | null;
  } | undefined;

  if (!run || !run.config_snapshot_hash) {
    return null;
  }

  const snapshot = getRuntimeSnapshotByHash(workspaceId, run.config_snapshot_hash);
  if (!snapshot) {
    return null;
  }

  // 1. Currentness check for reviewed Product Type
  const currentness = loadAndValidateProductTypeCurrentness(db, {
    workspaceId,
    activeRunId,
    productSku,
    onboardingItemId: itemId,
  });

  // Find candidate proposal for Primary Product Type
  const topPrimaryProposal = db.query(
    `SELECT id, target_id, confidence, proposed_value_json
     FROM classification_proposals
     WHERE run_id = ? AND proposal_type = 'primary_product_type' AND superseded_at IS NULL
     ORDER BY confidence DESC
     LIMIT 1`,
  ).get(activeRunId) as {
    id: string;
    target_id: string | null;
    confidence: number | null;
    proposed_value_json: string;
  } | undefined;

  let executionPreview: TypeReviewDetail['executionPreview'] = null;
  if (topPrimaryProposal) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(topPrimaryProposal.proposed_value_json);
    } catch {
      // ignore invalid json
    }
    const candidateId = topPrimaryProposal.target_id ?? (typeof parsed?.productTypeId === 'string' ? parsed.productTypeId : null);
    const ptConfig = candidateId ? snapshot.productTypes.find((pt: ProductTypeConfigV2) => pt.id === candidateId) : null;
    const label = ptConfig?.name ?? (typeof parsed?.productTypeName === 'string' ? parsed.productTypeName : null) ?? candidateId;
    executionPreview = {
      id: candidateId,
      label,
      confidence: topPrimaryProposal.confidence ?? null,
      previewOnly: true,
    };
  }

  // Find live decision for primary_product_type
  const liveDecision = db.query(
    `SELECT d.id, d.decision, d.revised_target_id, d.revised_value_json, p.target_id
     FROM classification_proposal_decisions d
     JOIN classification_proposals p ON d.proposal_id = p.id
     WHERE p.run_id = ? AND p.proposal_type = 'primary_product_type' AND d.superseded_at IS NULL
     ORDER BY d.created_at DESC
     LIMIT 1`,
  ).get(activeRunId) as {
    id: string;
    decision: string;
    revised_target_id: string | null;
    revised_value_json: string | null;
    target_id: string | null;
  } | undefined;

  let reviewedId: string | null = null;
  let reviewedLabel: string | null = null;
  let reviewedDecisionId: string | null = null;
  const isCurrent = currentness.ok && Boolean(currentness.effectiveTypeId);

  if (isCurrent) {
    reviewedId = currentness.effectiveTypeId!;
    const ptConfig = snapshot.productTypes.find((pt: ProductTypeConfigV2) => pt.id === reviewedId);
    reviewedLabel = ptConfig?.name ?? reviewedId;
    reviewedDecisionId = currentness.decisionId;
  } else if (liveDecision) {
    reviewedDecisionId = liveDecision.id;
    let revVal: Record<string, unknown> | null = null;
    try {
      revVal = liveDecision.revised_value_json ? JSON.parse(liveDecision.revised_value_json) : null;
    } catch {
      // ignore invalid json
    }
    reviewedId = liveDecision.revised_target_id ?? (typeof revVal?.productTypeId === 'string' ? revVal.productTypeId : null) ?? liveDecision.target_id ?? null;
    if (reviewedId) {
      const ptConfig = snapshot.productTypes.find((pt: ProductTypeConfigV2) => pt.id === reviewedId);
      reviewedLabel = ptConfig?.name ?? reviewedId;
    }
  }

  // 2. Options list with hierarchy paths. NOTE: ProductTypeConfigV2 carries no
  // ancestor chain (only departmentId + name), so the path is the honest
  // subset [departmentId?, name] — never a guessed taxonomy trail. If a future
  // release adds ancestor IDs, resolve them here and fall back explicitly.
  const options: TypeReviewDetail['options'] = snapshot.productTypes.map((pt: ProductTypeConfigV2) => {
    const hierarchyPath: string[] = [];
    if (pt.departmentId) {
      hierarchyPath.push(pt.departmentId);
    }
    hierarchyPath.push(pt.name);
    return {
      id: pt.id,
      label: pt.name,
      hierarchyPath,
    };
  });

  // 3. Evidence summary from verifier, fed with the run's real evidence rows
  // plus the item name as product title (previously: empty evidence, so the
  // verifier could only ever report 'none' and the UI showed no support).
  const evidenceRows = db.query(
    `SELECT snippet, value_json, source FROM classification_evidence
     WHERE run_id = ? ORDER BY created_at ASC LIMIT 200`,
  ).all(activeRunId) as Array<{ snippet: string | null; value_json: string | null; source: string | null }>;
  const itemNameRow = db.query(`SELECT name FROM onboarding_items WHERE id = ?`).get(itemId) as { name: string } | undefined;
  const candidateForVerification = executionPreview?.id ?? reviewedId;
  let evidence: TypeReviewDetail['evidence'] = {
    strength: 'none',
    supportingCount: 0,
    contradictingCount: 0,
    matchedWords: [],
  };

  if (candidateForVerification) {
    const verified = verifyProductTypeCandidate({
      candidateProductTypeId: candidateForVerification,
      candidateConfidence: topPrimaryProposal?.confidence ?? 0.8,
      evidence: evidenceRows.map(r => ({ snippet: r.snippet, valueJson: r.value_json, source: r.source })),
      snapshot,
      productTitle: itemNameRow?.name ?? null,
      sku: productSku,
    });

    evidence = verified.evidenceSummary;
  }

  // 4. Refresh state
  const refreshRow = db.query(
    `SELECT status FROM classification_refresh_queue
     WHERE onboarding_item_id = ? AND status IN ('queued', 'claimed', 'failed')
     ORDER BY requested_at DESC LIMIT 1`,
  ).get(itemId) as { status: string } | undefined;

  let refreshState: TypeReviewDetail['refreshState'] = 'current';
  if (refreshRow) {
    if (refreshRow.status === 'queued') refreshState = 'queued';
    else if (refreshRow.status === 'claimed') refreshState = 'running';
    else if (refreshRow.status === 'failed') refreshState = 'failed';
  } else if (!isCurrent) {
    refreshState = 'blocked';
  }

  return {
    reviewed: {
      id: reviewedId,
      label: reviewedLabel,
      decisionId: reviewedDecisionId,
      current: isCurrent,
    },
    executionPreview,
    options,
    evidence,
    refreshState,
  };
}
