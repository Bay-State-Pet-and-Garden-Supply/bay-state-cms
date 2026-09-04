import { getDb } from '../db/connection';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { isUniversalAttribute } from './applicability-evaluator';
import {
  CohortSemanticValidationSchema,
  CorrectedCategoryPageRecordSchema,
  FamilyTitleValidationRecordSchema,
  PageDecisionStatusRecordSchema,
} from '../shared/schemas/onboarding';
import { getActivePageImportHash, listVerifiedPageOptions } from '../db/repositories/page-repo';

export type ReviewCompletionGateResult =
  | { ok: true; proposalCount: number }
  | { ok: false; code: string; reason: string };

/**
 * Fail-closed type-gating check shared by both gates.
 *
 * When a run is bound to a resolvable M4+ runtime snapshot that enables a
 * product_type curation target, review may only complete if a reviewed
 * (accepted) Primary Product Type exists — either as an accepted type decision
 * in the same run or as a compatible reviewed fact carried in the snapshot.
 * Type-gated field assignments (any non-universal attribute) must never pass
 * review without a reviewed type.
 *
 * Legacy runs (unresolvable or absent config snapshot) skip the check.
 */
function assertReviewedProductTypeForRun(options: {
  runId: string;
  workspaceId: string;
  configSnapshotHash: string | null;
  reviewableProposals: Array<{ id: string; proposalType: string; targetId: string | null }>;
}): ReviewCompletionGateResult | null {
  const { runId, workspaceId, configSnapshotHash } = options;

  // Snapshot is the only place that proves the config's type-gating intent.
  const snapshot = configSnapshotHash
    ? getRuntimeSnapshotByHash(workspaceId, configSnapshotHash)
    : null;
  if (!snapshot) return null;

  const typeTargetEnabled = snapshot.curationTargets.some(
    target => target.kind === 'product_type' && (target.enabled || target.mandatory),
  );
  if (!typeTargetEnabled) return null;

  // In-run accepted type decision.
  const acceptedTypeDecision = getDb().query(
    `SELECT 1 FROM classification_proposals p
     JOIN classification_proposal_decisions d ON d.proposal_id = p.id AND d.superseded_at IS NULL
     WHERE p.run_id = ? AND p.proposal_type = 'primary_product_type' AND d.decision = 'accepted'
     LIMIT 1`,
  ).get(runId);
  const reviewedTypeFact = snapshot.reviewedFacts.some(
    fact => fact.proposalType === 'primary_product_type',
  );
  if (acceptedTypeDecision || reviewedTypeFact) return null;

  // Any non-universal field assignment in this run is type-gated. Unknown
  // attributes fail closed.
  const gatedFieldProposal = options.reviewableProposals.some(proposal => {
    if (proposal.proposalType !== 'field_assignment') return false;
    const attribute = snapshot.attributes.find(candidate => candidate.id === proposal.targetId);
    if (!attribute) return true;
    return !isUniversalAttribute(attribute);
  });
  if (!gatedFieldProposal) return null;

  return {
    ok: false,
    code: 'type_gated_without_reviewed_type',
    reason: 'Type-gated attribute proposals cannot complete review without a reviewed (accepted) Primary Product Type.',
  };
}

export interface ReviewCompletionGateInput {
  workspaceId: string;
  onboardingItemId: string;
  productSku: string;
  activeRunId: string;
}

/**
 * Manual-evidence review backstop (parent #101, ticket #103 thin slice).
 *
 * Read-only, fail-closed: when the item's LATEST extraction row is an
 * operator manual-evidence row (`manual_evidence_v1`), an ACTIVE (never
 * superseded) attestation must exist for the item and its id must match the
 * row's attestation link. Returns a `manual_attestation_missing` refusal
 * otherwise. Returns null for non-manual rows and for fully attested manual
 * rows (later tickets add hash-mismatch, inheritance, and image-rights
 * refusals). Exported for isolated unit testing.
 */
export function validateManualEvidenceForReview(itemId: string): ReviewCompletionGateResult | null {
  const db = getDb();
  let latest: { extraction_method: string; manual_attestation_id: string | null } | undefined;
  try {
    latest = db.query(
      `SELECT extraction_method, manual_attestation_id FROM onboarding_extractions
       WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(itemId) as { extraction_method: string; manual_attestation_id: string | null } | undefined;
  } catch {
    // Pre-foundation databases (no attestation store): manual rows cannot
    // exist (their insert requires the same columns), so there is nothing
    // to refuse. Legacy fixtures keep byte-identical behavior.
    return null;
  }
  if (!latest || latest.extraction_method !== 'manual_evidence_v1') return null;
  const attestationId = latest.manual_attestation_id;
  if (!attestationId) {
    return {
      ok: false,
      code: 'manual_attestation_missing',
      reason: 'Manual evidence has no attestation link; the item cannot be review-ready.',
    };
  }
  let active: { attestation_id: string } | undefined;
  try {
    active = db.query(
      `SELECT attestation_id FROM onboarding_manual_evidence_attestations
       WHERE attestation_id = ? AND item_id = ? AND superseded_at IS NULL LIMIT 1`,
    ).get(attestationId, itemId) as { attestation_id: string } | undefined;
  } catch {
    active = undefined;
  }
  if (!active) {
    return {
      ok: false,
      code: 'manual_attestation_missing',
      reason: 'Manual evidence attestation is missing or was withdrawn; the item cannot be review-ready.',
    };
  }
  return null;
}

/**
 * Universal Category Page assignment requirement (operator mandate): an
 * onboarding item may never complete Review without at least one Category
 * Page assignment that resolves into the CURRENT active verified Page
 * import. Structural, NOT config-dependent — unlike the snapshot-gated P10
 * decision gate for cohort children, this applies to every classified item
 * AND to legacy items through the route-level call. Promotion already fails
 * closed on missing verified pages; this moves the refusal earlier so an
 * unpageable item is never marked reviewed/approved in the first place.
 *
 * `curationData` is the PARSED curation payload (null when absent). Corrupt
 * JSON semantics stay with the caller (the run gate refuses with
 * `semantic_validation_blocked` per existing convention).
 */
export function validateItemCategoryPagesAssigned(input: {
  workspaceId: string;
  curationData: unknown;
}): ReviewCompletionGateResult | null {
  const curation =
    input.curationData && typeof input.curationData === 'object'
      ? (input.curationData as Record<string, unknown>)
      : null;
  const suggestedPages = Array.isArray(curation?.suggestedPages) ? curation!.suggestedPages : [];
  if (suggestedPages.length === 0) {
    return {
      ok: false,
      code: 'missing_category_page',
      reason:
        'No Category Page is assigned; assign at least one Category Page from the verified options before completing review.',
    };
  }
  const verifiedNames = new Set(listVerifiedPageOptions(input.workspaceId).map(page => page.name));
  const unverified = suggestedPages.filter(name => typeof name !== 'string' || !verifiedNames.has(name));
  if (unverified.length > 0) {
    return {
      ok: false,
      code: 'unverified_category_page',
      reason: `Category Page assignment does not resolve into the current verified Page import (${unverified.map(String).join(', ')}); re-select from the verified options.`,
    };
  }
  return null;
}

/**
 * Read-only, fail-closed validation for completing Review on a classified item.
 * Only decisions belonging to proposals in the item's exact active run count.
 */
export function validateReviewCompletionGate(
  input: ReviewCompletionGateInput,
): ReviewCompletionGateResult {
  const db = getDb();
  const run = db.query(
    `SELECT status, workspace_id, onboarding_item_id, product_sku, config_snapshot_hash, cohort_run_id
     FROM classification_runs
     WHERE id = ?`,
  ).get(input.activeRunId) as {
    status: string;
    workspace_id: string;
    onboarding_item_id: string | null;
    product_sku: string;
    config_snapshot_hash: string | null;
    cohort_run_id: string | null;
  } | undefined;

  if (!run) {
    return { ok: false, code: 'run_not_found', reason: `Classification run ${input.activeRunId} not found.` };
  }
  if (run.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Classification run belongs to a different workspace.' };
  }
  if (run.onboarding_item_id !== input.onboardingItemId) {
    return { ok: false, code: 'item_mismatch', reason: 'Classification run is not linked to this exact onboarding item.' };
  }
  if (run.product_sku !== input.productSku) {
    return {
      ok: false,
      code: 'sku_mismatch',
      reason: `Classification run SKU "${run.product_sku}" does not match item UPC "${input.productSku}".`,
    };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return {
      ok: false,
      code: 'run_not_completed',
      reason: `Classification run has status "${run.status}". Only completed runs can be reviewed.`,
    };
  }

  // Parent #101 (manual-evidence route, ticket #103 thin slice): a manual
  // extraction row without an ACTIVE attestation join can never complete
  // review. Additive check only — automated and distributor rows always
  // pass through (null) and existing gate precedence is unchanged.
  const manualEvidenceGate = validateManualEvidenceForReview(input.onboardingItemId);
  if (manualEvidenceGate) return manualEvidenceGate;

  // PR9 C3 (issue #30, DECISION-C) + review round 2 (R2-A): the cohort
  // SEMANTIC validation gate. Two distinct paths:
  //
  // 1. ACTIVE COHORT CHILD (`cohort_run_id` non-null) — STRICT gate. A child
  //    can be reviewed ONLY when (b) the committed projection references
  //    THIS child run, (c) the parent run exists in the same workspace, (d)
  //    the parent is NOT superseded (a superseded parent's children are
  //    historical — never reviewable), (e) the parent is in a terminal
  //    reviewable state (completed / completed_with_abstentions /
  //    completed_with_member_failures — a running/freezing parent means the
  //    post-loop Brand validation has not finished, so the child is never
  //    reviewable while the parent is in flight), and (f/g) the committed
  //    `semanticValidation` parses against the EXACT shared schema and is
  //    `passed` (blocked → refuse with the first finding; MISSING or
  //    malformed → fail closed, never review-ready — the surface helper's
  //    documented contract treats missing/malformed as corruption).
  //
  // 2. LEGACY (`cohort_run_id` null) — EXACTLY today's behavior: an absent
  //    semanticValidation key proceeds, a `blocked` status refuses, and
  //    corrupt curation JSON fails closed (byte-identical).
  if (run.cohort_run_id === null) {
    // ── Legacy path (byte-identical pre-R2 behavior) ──
    {
      const curationRow = db.query(
        'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
      ).get(input.onboardingItemId) as { curation_data_json: string | null } | undefined;
      if (curationRow?.curation_data_json) {
        let parsedCuration: unknown;
        try {
          parsedCuration = JSON.parse(String(curationRow.curation_data_json));
        } catch {
          return {
            ok: false,
            code: 'semantic_validation_blocked',
            reason: 'Curation data is corrupt; the item cannot be review-ready.',
          };
        }
        const semanticValidation =
          parsedCuration && typeof parsedCuration === 'object'
            ? (parsedCuration as Record<string, unknown>).semanticValidation
            : undefined;
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
          return {
            ok: false,
            code: 'semantic_validation_blocked',
            reason: firstMessage,
          };
        }
      }
    }
  } else {
    // ── Active cohort child: strict R2-A gate ──

    // (b) The committed projection must reference THIS child run.
    const curationRow = db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(input.onboardingItemId) as { curation_data_json: string | null } | undefined;
    let parsedCuration: Record<string, unknown> | null = null;
    if (curationRow?.curation_data_json) {
      try {
        const parsed = JSON.parse(String(curationRow.curation_data_json));
        if (parsed && typeof parsed === 'object') parsedCuration = parsed as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          code: 'semantic_validation_blocked',
          reason: 'Curation data is corrupt; the committed cohort semantic validation payload cannot be read.',
        };
      }
    }
    const committedRunId =
      typeof parsedCuration?.classificationRunId === 'string' ? parsedCuration.classificationRunId : null;
    if (committedRunId !== input.activeRunId) {
      return {
        ok: false,
        code: 'semantic_validation_blocked',
        reason:
          committedRunId === null
            ? 'Committed curation data carries no classification run reference; the cohort child projection is unavailable.'
            : `Committed curation data references classification run ${committedRunId}, not this run ` +
              `${input.activeRunId}; the cohort child projection is inconsistent.`,
      };
    }

    // (c) The parent run must exist and belong to the same workspace.
    const parentRun = db.query(
      'SELECT id, status, workspace_id FROM classification_cohort_runs WHERE id = ?',
    ).get(run.cohort_run_id) as { id: string; status: string; workspace_id: string } | undefined;
    if (!parentRun) {
      return {
        ok: false,
        code: 'parent_not_found',
        reason: `Cohort parent run ${run.cohort_run_id} not found.`,
      };
    }
    if (parentRun.workspace_id !== input.workspaceId) {
      return {
        ok: false,
        code: 'workspace_mismatch',
        reason: `Cohort parent run ${parentRun.id} belongs to a different workspace.`,
      };
    }

    // (d) A superseded parent's completed children are historical — never
    // reviewable (the parent's outputs are no longer the live revision).
    if (parentRun.status === 'superseded') {
      return {
        ok: false,
        code: 'parent_superseded',
        reason:
          `Cohort parent run ${parentRun.id} was superseded; its completed children are historical ` +
          'and cannot be reviewed.',
      };
    }

    // (e) A running/freezing parent is in flight (post-loop Brand validation
    // happens AFTER member completion) — a child is never reviewable until
    // the parent reaches a terminal reviewable state.
    const PARENT_REVIEWABLE_STATUSES = new Set([
      'completed',
      'completed_with_abstentions',
      'completed_with_member_failures',
    ]);
    if (!PARENT_REVIEWABLE_STATUSES.has(parentRun.status)) {
      return {
        ok: false,
        code: 'parent_not_completed',
        reason:
          `Cohort parent run ${parentRun.id} has status "${parentRun.status}"; a child cannot be ` +
          'reviewed while its parent is in flight.',
      };
    }

    // (f/g) The committed semanticValidation must parse against the EXACT
    // shared schema; missing or malformed data fails closed (never
    // review-ready — corruption, not a pass-through).
    const semanticValidation = parsedCuration?.semanticValidation;
    if (semanticValidation === undefined || semanticValidation === null) {
      return {
        ok: false,
        code: 'semantic_validation_blocked',
        reason: 'Committed cohort semantic validation payload is missing; the item cannot be review-ready.',
      };
    }
    const parsedSemantic = CohortSemanticValidationSchema.safeParse(semanticValidation);
    if (!parsedSemantic.success) {
      return {
        ok: false,
        code: 'semantic_validation_blocked',
        reason: 'Committed cohort semantic validation payload is malformed; the item cannot be review-ready.',
      };
    }
    if (parsedSemantic.data.status === 'blocked') {
      const firstMessage =
        parsedSemantic.data.findings.length > 0 ? parsedSemantic.data.findings[0].message : undefined;
      return {
        ok: false,
        code: 'semantic_validation_blocked',
        reason: firstMessage ?? 'A hard cohort semantic validation finding blocks this item.',
      };
    }

    // ── e09 B3 (T9): family title consistency proof ──
    // A cohort-coordinated title (`llm_cohort`/`cohort_fallback`) may only be
    // reviewed when the committed curation data carries a valid passing
    // `familyTitleValidation` record — captured at the member-projection
    // commit from the durable output (never recomputed from live rows).
    // Missing or malformed for a coordinated title is corruption → fail
    // closed. Non-cohort title sources (manual/web/ocr/llm single) are not
    // family-coordinated and skip this check.
    const committedTitleSource = parsedCuration?.titleSource;
    if (committedTitleSource === 'llm_cohort' || committedTitleSource === 'cohort_fallback') {
      const familyTitleValidation = parsedCuration?.familyTitleValidation;
      if (familyTitleValidation === undefined || familyTitleValidation === null) {
        return {
          ok: false,
          code: 'title_validation_missing',
          reason:
            'Committed curation data carries a cohort-coordinated title without the required family title validation record; the item cannot be review-ready (T9).',
        };
      }
      const parsedTitleValidation = FamilyTitleValidationRecordSchema.safeParse(familyTitleValidation);
      if (!parsedTitleValidation.success) {
        return {
          ok: false,
          code: 'title_validation_malformed',
          reason:
            'Committed family title validation record is malformed; the item cannot be review-ready (T9).',
        };
      }
      if (parsedTitleValidation.data.status !== 'passed') {
        return {
          ok: false,
          code: 'title_validation_blocked',
          reason:
            'The committed family title set did not pass consistency validation; the item cannot be review-ready (T9).',
        };
      }
    }

    // ── e09 B3 (P10): Category Page decision gate ──
    // Enforced only when the run's FROZEN snapshot enables the category_page
    // target (same intent-proof pattern as the type gate above); legacy runs
    // without a resolvable snapshot skip it. NOTE: both this gate and the T9
    // title gate above are additionally scoped to cohort children — the page
    // decision status and family-title record are written only by the cohort
    // commit (cohort_run_id !== null branch). Single-item classification runs
    // rely on the promotion mandatory-Pages + verified-set currentness
    // backstop instead. An abstained or absent durable
    // decision blocks review (adjudication #6) unless a reviewer correction —
    // an ACCEPTED category_page proposal in this run — resolves to a CURRENT
    // verified Page ID (adjudication #10). An assigned decision with accepted
    // identified proposals that no longer resolve into the active verified
    // import is stale → refuse. Confidence is never consulted.
    const pageGateSnapshot = run.config_snapshot_hash
      ? getRuntimeSnapshotByHash(input.workspaceId, run.config_snapshot_hash)
      : null;
    const categoryPageTargetEnabled = pageGateSnapshot
      ? pageGateSnapshot.curationTargets.some(
          // Snapshot curation-target kinds are 'product_type' | 'product_field' | 'page'
          // (CurationTargetKindEnum) — the Page decision is the 'page' target.
          target => target.kind === 'page' && (target.enabled || target.mandatory),
        )
      : false;
    // CURRENT active verified Page import identities (P10: a reviewer
    // correction satisfies the gate only when it resolves to a current
    // verified Page ID).
    const verifiedPageIdSet = new Set(
      categoryPageTargetEnabled ? listVerifiedPageOptions(input.workspaceId).map(page => page.id) : [],
    );
    if (categoryPageTargetEnabled) {
      const pageDecisionStatus = parsedCuration?.pageDecisionStatus;
      if (pageDecisionStatus === undefined || pageDecisionStatus === null) {
        return {
          ok: false,
          code: 'page_decision_missing',
          reason:
            'Committed Category Page decision record is missing; the item cannot be review-ready (P10).',
        };
      }
      const parsedPageDecision = PageDecisionStatusRecordSchema.safeParse(pageDecisionStatus);
      if (!parsedPageDecision.success) {
        return {
          ok: false,
          code: 'page_decision_missing',
          reason:
            'Committed Category Page decision record is malformed; the item cannot be review-ready (P10).',
        };
      }
      // Effective identity mirrors getAcceptedProposals (classification-run-repo):
      // the live non-superseded decision's revised_target_id wins when present,
      // otherwise the original predicted target. Adjudication #10 — a reviewer
      // correction satisfies the gate only when it resolves to a current
      // verified Page ID, so a REVISED target must be validated as itself.
      const pageProposalRows = db.query(
        `SELECT p.target_id,
                (SELECT CASE WHEN COALESCE(d.has_revised_target, CASE WHEN d.revised_target_id IS NULL THEN 0 ELSE 1 END) = 1
                        THEN d.revised_target_id ELSE p.target_id END
                   FROM classification_proposal_decisions d
                  WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
                  ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS effective_target_id,
                EXISTS(
                  SELECT 1 FROM classification_proposal_decisions d
                  WHERE d.proposal_id = p.id AND d.superseded_at IS NULL AND d.decision = 'accepted'
                ) AS has_accepted_decision
         FROM classification_proposals p
         WHERE p.run_id = ? AND p.proposal_type = 'category_page'`,
      ).all(input.activeRunId) as Array<{
        target_id: string | null;
        effective_target_id: string | null;
        has_accepted_decision: number;
      }>;
      const hasAcceptedVerifiedPage = pageProposalRows.some(
        row =>
          row.has_accepted_decision &&
          typeof row.effective_target_id === 'string' &&
          row.effective_target_id.length > 0 &&
          verifiedPageIdSet.has(row.effective_target_id),
      );
      if (parsedPageDecision.data.status === 'abstained') {
        if (!hasAcceptedVerifiedPage) {
          // e09 round-3 FIX 1 (adjudication #10): an abstained member
          // materializes ZERO category_page proposals, so the accepted-proposal
          // correction path above can never fire for it. The Review UI
          // therefore writes a `correctedCategoryPage` record (stable verified
          // Page ID + active import hash at correction time) when the reviewer
          // picks a page from the VERIFIED options list. Fail-closed: a missing
          // OR malformed record keeps the plain abstention refusal; a stale
          // hash or an ID outside the CURRENT verified import refuses with
          // page_decision_stale. A valid correction satisfies the abstention.
          const rawCorrection = parsedCuration?.correctedCategoryPage;
          const parsedCorrection = CorrectedCategoryPageRecordSchema.safeParse(rawCorrection);
          if (!parsedCorrection.success) {
            return {
              ok: false,
              code: 'page_decision_abstained',
              reason:
                (rawCorrection === undefined || rawCorrection === null
                  ? parsedPageDecision.data.reason ??
                    'The Category Page decision abstained; manual selection resolving to a current verified Page ID is required before review can complete (P10).'
                  : 'The reviewer Category Page correction record is malformed and cannot satisfy the abstention; re-select the page from the current verified options (P10).'),
            };
          }
          const activeImportHash = getActivePageImportHash(input.workspaceId);
          if (!activeImportHash || parsedCorrection.data.activePageImportHash !== activeImportHash) {
            return {
              ok: false,
              code: 'page_decision_stale',
              reason:
                'The reviewer Category Page correction was recorded against a different Page import; re-select the page from the current verified options (P10).',
            };
          }
          if (!verifiedPageIdSet.has(parsedCorrection.data.pageId)) {
            return {
              ok: false,
              code: 'page_decision_stale',
              reason:
                'The reviewer-corrected Category Page ID does not resolve into the active verified Page import; re-select the page from the current verified options (P10).',
            };
          }
          // Valid current correction — the abstention is resolved; fall through.
        }
      } else if (parsedPageDecision.data.status === 'absent') {
        if (!hasAcceptedVerifiedPage) {
          return {
            ok: false,
            code: 'page_decision_missing',
            reason:
              'No durable Category Page decision was committed for this cohort member and no reviewer-accepted verified Page exists; the item cannot be review-ready (P10).',
          };
        }
      } else {
        // Assigned: verify committed assignments still resolve into the
        // CURRENT active verified import. Only IDENTIFIED accepted proposals
        // participate — name-only rows carry no verifiable identity and are
        // never acceptance authority (P2/P12).
        const identifiedAcceptedPages = pageProposalRows.filter(
          row =>
            row.has_accepted_decision &&
            typeof row.effective_target_id === 'string' &&
            row.effective_target_id.length > 0,
        );
        if (
          identifiedAcceptedPages.length > 0 &&
          !identifiedAcceptedPages.some(row => verifiedPageIdSet.has(row.effective_target_id!))
        ) {
          return {
            ok: false,
            code: 'page_decision_stale',
            reason:
              'The committed Category Page assignment no longer resolves into the active verified Page import (stale or unverified identity); the item cannot be review-ready (P10).',
          };
        }
        if (!hasAcceptedVerifiedPage) {
          // Fail closed (P10): an `assigned` decision whose accepted proposals
          // were ALL rejected by the reviewer (or carry name-only rows with no
          // verifiable identity) leaves zero accepted verified Pages — review
          // must not complete on that end state.
          return {
            ok: false,
            code: 'page_decision_missing',
            reason:
              'No reviewer-accepted Category Page resolves into the active verified import; the item cannot be review-ready (P10).',
          };
        }
      }
    }
  }

  const proposals = db.query(
    `SELECT p.id, p.status, p.proposal_type, p.target_id,
            EXISTS(
              SELECT 1 FROM classification_proposal_decisions d
              WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
            ) AS has_decision
     FROM classification_proposals p
     WHERE p.run_id = ?`,
  ).all(input.activeRunId) as Array<{
    id: string;
    status: string;
    proposal_type: string;
    target_id: string | null;
    has_decision: number;
  }>;

  if (proposals.length === 0) {
    return { ok: false, code: 'no_proposals', reason: 'No reviewable proposals in the classification run.' };
  }

  const pendingOrStale = proposals.filter(p => p.status === 'pending' || p.status === 'stale');
  if (pendingOrStale.length > 0) {
    return {
      ok: false,
      code: 'pending_proposals',
      reason: `Classification run has ${pendingOrStale.length} pending or stale proposal(s) that require review.`,
    };
  }

  const missingDecisions = proposals.filter(p => p.status !== 'reviewable_abstention' && !p.has_decision);
  if (missingDecisions.length > 0) {
    return {
      ok: false,
      code: 'missing_decisions',
      reason: `Classification run has ${missingDecisions.length} proposal(s) without a durable decision row.`,
    };
  }

  const typeGate = assertReviewedProductTypeForRun({
    runId: input.activeRunId,
    workspaceId: input.workspaceId,
    configSnapshotHash: run.config_snapshot_hash,
    reviewableProposals: proposals.map(p => ({
      id: p.id,
      proposalType: p.proposal_type,
      targetId: p.target_id,
    })),
  });
  if (typeGate) return typeGate;

  // ── Universal Category Page assignment requirement ──
  // Checked LAST so run-integrity, semantic, decision, and type gates keep
  // their established precedence. It applies uniformly to cohort children
  // AND single-item/legacy runs regardless of whether the frozen snapshot
  // enabled the page curation target — an item without an assigned Category
  // Page that resolves into the CURRENT verified import is never
  // review-ready (promotion's mandatory-Pages backstop would fail it later;
  // this refuses before the item can be marked reviewed/approved). Corrupt
  // curation JSON fails closed with the established semantic_validation_blocked code.
  let universalPagesCuration: Record<string, unknown> | null = null;
  {
    const pagesCurationRow = db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(input.onboardingItemId) as { curation_data_json: string | null } | undefined;
    if (pagesCurationRow?.curation_data_json) {
      try {
        const parsedPagesCuration = JSON.parse(String(pagesCurationRow.curation_data_json));
        if (parsedPagesCuration && typeof parsedPagesCuration === 'object') {
          universalPagesCuration = parsedPagesCuration as Record<string, unknown>;
        }
      } catch {
        return {
          ok: false,
          code: 'semantic_validation_blocked',
          reason: 'Curation data is corrupt; the item cannot be review-ready.',
        };
      }
    }
  }
  const universalPagesGate = validateItemCategoryPagesAssigned({
    workspaceId: input.workspaceId,
    curationData: universalPagesCuration,
  });
  if (universalPagesGate) return universalPagesGate;

  return { ok: true, proposalCount: proposals.length };
}

// ─── Catalog Product Review Completion Gate ──────────────────────────────────

export interface CatalogReviewCompletionGateInput {
  workspaceId: string;
  productSku: string;
  runId: string;
}

/**
 * Read-only validation for completing review on a catalog product run.
 * Checks workspace/SKU ownership and run completion status.
 */
export function validateCatalogReviewCompletionGate(
  input: CatalogReviewCompletionGateInput,
): ReviewCompletionGateResult {
  const db = getDb();
  const run = db.query(
    `SELECT status, workspace_id, product_sku, source_kind, config_snapshot_hash
     FROM classification_runs WHERE id = ?`,
  ).get(input.runId) as {
    status: string; workspace_id: string; product_sku: string; source_kind: string; config_snapshot_hash: string | null;
  } | undefined;

  if (!run) {
    return { ok: false, code: 'run_not_found', reason: `Run ${input.runId} not found.` };
  }
  if (run.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Run belongs to a different workspace.' };
  }
  if (run.source_kind !== 'catalog_product') {
    return { ok: false, code: 'source_mismatch', reason: 'Run is not a catalog product run.' };
  }
  if (run.product_sku !== input.productSku) {
    return { ok: false, code: 'sku_mismatch', reason: `Run SKU "${run.product_sku}" does not match "${input.productSku}".` };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return { ok: false, code: 'run_not_completed', reason: `Run status is "${run.status}".` };
  }

  const reviewableProposals = db.query(
    `SELECT p.id, p.status, p.proposal_type, p.target_id,
            EXISTS(
              SELECT 1 FROM classification_proposal_decisions d
              WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
            ) AS has_decision
     FROM classification_proposals p
     WHERE p.run_id = ? AND p.proposal_type != 'reviewable_abstention'`,
  ).all(input.runId) as Array<{ id: string; status: string; proposal_type: string; target_id: string | null; has_decision: number }>;

  if (reviewableProposals.length === 0) {
    return { ok: false, code: 'no_proposals', reason: 'No reviewable proposals.' };
  }

  const pendingOrStale = reviewableProposals.filter(p => p.status === 'pending' || p.status === 'stale');
  if (pendingOrStale.length > 0) {
    return {
      ok: false,
      code: 'pending_proposals',
      reason: `Catalog classification run has ${pendingOrStale.length} pending or stale proposal(s) that require review.`,
    };
  }

  const missingDecisions = reviewableProposals.filter(p => !p.has_decision);
  if (missingDecisions.length > 0) {
    return {
      ok: false,
      code: 'missing_decisions',
      reason: `Catalog classification run has ${missingDecisions.length} proposal(s) without a durable decision row.`,
    };
  }

  const typeGate = assertReviewedProductTypeForRun({
    runId: input.runId,
    workspaceId: input.workspaceId,
    configSnapshotHash: run.config_snapshot_hash,
    reviewableProposals: reviewableProposals.map(p => ({
      id: p.id,
      proposalType: p.proposal_type,
      targetId: p.target_id,
    })),
  });
  if (typeGate) return typeGate;

  return { ok: true, proposalCount: reviewableProposals.length };
}
