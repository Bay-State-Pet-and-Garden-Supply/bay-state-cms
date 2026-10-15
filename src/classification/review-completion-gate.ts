import { findAcceptedPairDecision, listGatePageProposalsByRun, listGateProposalsByRun, listAcceptedVisualGateRows, listDecisionEvidenceIds, listVisualEvidenceByIds, findGateRunById } from '../db/repositories/classification-run-repo';
import {
  getManualEvidenceAttestation,
  isManualEvidenceAttestationActive,
  parseManualEvidenceImageRights,
  verifyManualEvidenceAttestationHash,
} from '../db/repositories/onboarding-manual-evidence-repo';
import { findLatestExtractionGateRow } from '../db/repositories/onboarding-extraction-repo';
import { findCurationDataJsonById } from '../db/repositories/onboarding-item-repo';
import { findCohortParentGateRow } from '../db/repositories/classification-cohort-run-repo';
import {
  buildManualEvidenceFieldValues,
  isManualFieldValueInherited,
} from '../onboarding/manual-evidence-eligibility';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { getCategoryIdFromValue, getProductTypeIdFromValue } from './assignment-projection';
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
 * Fail-closed classification-gating check shared by both gates (issue #350).
 *
 * When a run is bound to a resolvable M4+ runtime snapshot that enables a
 * classification curation target, review may only complete if a reviewed
 * (accepted) canonical Category + Product Type pair exists — either as an
 * accepted pair decision in the same run or as a compatible reviewed fact
 * carried in the snapshot. An incomplete pair blocks with a precise code.
 * Pair-gated field assignments (any non-universal attribute) must never pass
 * review without a reviewed pair.
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

  // Snapshot is the only place that proves the config's gating intent.
  const snapshot = configSnapshotHash
    ? getRuntimeSnapshotByHash(workspaceId, configSnapshotHash)
    : null;
  if (!snapshot) return null;

  const typeTargetEnabled = snapshot.curationTargets.some(
    target => target.kind === 'product_type' && (target.enabled || target.mandatory),
  );
  if (!typeTargetEnabled) return null;
  // In-run accepted pair decision (new kind) or legacy accepted type.
  const pairDecision = findAcceptedPairDecision(runId);
  const acceptedRow = pairDecision ? {
    proposal_type: pairDecision.proposalType, target_id: pairDecision.targetId,
    proposed_value_json: pairDecision.proposedValueJson,
    revised_value_json: pairDecision.revisedValueJson, revised_target_id: pairDecision.revisedTargetId,
    has_revised_value: pairDecision.hasRevisedValue ? 1 : 0,
    has_revised_target: pairDecision.hasRevisedTarget ? 1 : 0,
  } : undefined;
  const reviewedPairFact = snapshot.reviewedFacts.some(
    fact => fact.proposalType === 'product_classification' || fact.proposalType === 'primary_product_type',
  );
  if (acceptedRow ?? reviewedPairFact) {
    // Presence alone is not enough: the pair must be complete. A legacy
    // type-only acceptance resolves its category through the snapshot
    // mapping; an unmapped type stays an explicit gap.
    if (reviewedPairFact && !acceptedRow) return null;
    if (acceptedRow) {
      let parsed: unknown;
      try {
        const raw = acceptedRow.has_revised_value ? acceptedRow.revised_value_json : acceptedRow.proposed_value_json;
        parsed = raw ? JSON.parse(raw) : null;
      } catch { parsed = null; }
      const categoryId = getCategoryIdFromValue(parsed);
      const typeId = acceptedRow.has_revised_target && acceptedRow.revised_target_id
        ? acceptedRow.revised_target_id
        : getProductTypeIdFromValue(parsed) ?? acceptedRow.target_id;
      if (categoryId && typeId) return null;
      return {
        ok: false,
        code: 'classification_incomplete',
        reason: 'Review requires an accepted Category + Product Type pair; the current acceptance addresses only one member.',
      };
    }
    return null;
  }

  // Any non-universal field assignment in this run is pair-gated. Unknown
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
    reason: 'Type-gated attribute proposals cannot complete review without a reviewed (accepted) Product Classification.',
  };
}


export interface ReviewCompletionGateInput {
  workspaceId: string;
  onboardingItemId: string;
  productSku: string;
  activeRunId: string;
}

/**
 * Manual-evidence review backstop (parent #101, ticket #104 full set).
 *
 * Read-only, fail-closed: when the item's LATEST extraction row is an
 * operator manual-evidence row (`manual_evidence_v1`), the gate applies
 * four additive refusals in order — missing/withdrawn attestation
 * (`manual_attestation_missing`), checklist hash mismatch vs the stored
 * extraction payload (`manual_attestation_incomplete`), any manual field
 * matching the stored family-reference snapshot
 * (`manual_family_inheritance_suspected`), and manual images without
 * per-image rights approvals (`manual_image_rights_missing`). Returns null
 * for non-manual rows and for fully attested manual rows. Exported for
 * isolated unit testing.
 */
export function validateManualEvidenceForReview(itemId: string): ReviewCompletionGateResult | null {
  const gateRow = findLatestExtractionGateRow(itemId);
  const latest = gateRow ? {
    extraction_method: gateRow.extractionMethod,
    manual_attestation_id: gateRow.manualAttestationId,
    extraction_data_json: gateRow.extractionDataJson,
  } : undefined;
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
    active = isManualEvidenceAttestationActive(attestationId, itemId) ? { attestation_id: attestationId } : undefined;
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
  // Rebuild the canonical field map from the STORED extraction payload
  // with the same builder the submit path used, then re-verify the
  // checklist hashes: any post-submit payload edit fails closed.
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(latest.extraction_data_json ?? 'null'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      code: 'manual_attestation_incomplete',
      reason: 'Manual evidence extraction payload is corrupt; the item cannot be review-ready.',
    };
  }
  const payloadFieldValues = buildManualEvidenceFieldValues({
    title: typeof payload.title === 'string' ? payload.title : null,
    brand: typeof payload.brand === 'string' ? payload.brand : null,
    description: typeof payload.description === 'string' ? payload.description : null,
    bulletPoints: Array.isArray(payload.bulletPoints) ? (payload.bulletPoints as string[]) : null,
    weight: typeof payload.weight === 'string' ? payload.weight : null,
    dimensions: typeof payload.dimensions === 'string' ? payload.dimensions : null,
    primaryImage: typeof payload.primaryImage === 'string' ? payload.primaryImage : null,
    additionalImages: Array.isArray(payload.additionalImages) ? (payload.additionalImages as string[]) : null,
  });
  let hashesMatch: boolean;
  try {
    hashesMatch = verifyManualEvidenceAttestationHash(attestationId, payloadFieldValues);
  } catch {
    return {
      ok: false,
      code: 'manual_attestation_missing',
      reason: 'Manual evidence attestation is missing or was withdrawn; the item cannot be review-ready.',
    };
  }
  if (!hashesMatch) {
    return {
      ok: false,
      code: 'manual_attestation_incomplete',
      reason: 'Manual evidence fields do not match the signed attestation checklist; the item cannot be review-ready.',
    };
  }
  const attestationRow = getManualEvidenceAttestation(attestationId);
  // Family-inheritance suspicion (ticket #104): any manual text field
  // matching the operator-pasted family-reference snapshot means the
  // operator copied family copy instead of transcribing per-SKU facts.
  // No snapshot stored → nothing to compare → the check passes.
  const snapshot = attestationRow?.family_reference_text ?? null;
  if (typeof snapshot === 'string' && snapshot.trim().length > 0) {
    const textFields: string[] = [];
    for (const field of ['title', 'brand', 'description', 'weight', 'dimensions'] as const) {
      const value = payloadFieldValues[field];
      if (typeof value === 'string') textFields.push(value);
    }
    const bullets = payloadFieldValues.bulletPoints;
    if (Array.isArray(bullets)) {
      for (const bullet of bullets) {
        if (typeof bullet === 'string') textFields.push(bullet);
      }
    }
    for (const value of textFields) {
      if (isManualFieldValueInherited(value, snapshot)) {
        return {
          ok: false,
          code: 'manual_family_inheritance_suspected',
          reason:
            'A manual evidence field matches the stored family-reference text; per-SKU facts must be transcribed, not copied from the family page.',
        };
      }
    }
  }
  // Image rights (ticket #104): every manual image URL needs a stored
  // per-image rights approval on the attestation. Images are operator
  // evidence, never distributor candidates — unattested images block.
  const payloadImages: string[] = [];
  if (typeof payloadFieldValues.primaryImage === 'string') payloadImages.push(payloadFieldValues.primaryImage);
  if (Array.isArray(payloadFieldValues.additionalImages)) {
    for (const image of payloadFieldValues.additionalImages) {
      if (typeof image === 'string') payloadImages.push(image);
    }
  }
  if (payloadImages.length > 0) {
    let approvals: Array<{ imageUrl: string }>;
    try {
      approvals = attestationRow ? parseManualEvidenceImageRights(attestationRow) : [];
    } catch {
      return {
        ok: false,
        code: 'manual_image_rights_missing',
        reason: 'Manual image rights approvals are corrupt; the item cannot be review-ready.',
      };
    }
    const approvedUrls = new Set(approvals.map((approval) => approval.imageUrl));
    if (!payloadImages.every((imageUrl) => approvedUrls.has(imageUrl))) {
      return {
        ok: false,
        code: 'manual_image_rights_missing',
        reason: 'Manual images lack per-image rights approvals; the item cannot be review-ready.',
      };
    }
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
  const gateRun = findGateRunById(input.activeRunId);
  const run = gateRun ? {
    status: gateRun.status,
    workspace_id: gateRun.workspaceId,
    onboarding_item_id: gateRun.onboardingItemId,
    product_sku: gateRun.productSku,
    config_snapshot_hash: gateRun.configSnapshotHash,
    cohort_run_id: gateRun.cohortRunId,
  } : undefined;

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
      const curationDataJson = findCurationDataJsonById(input.onboardingItemId);
      const curationRow = curationDataJson ? { curation_data_json: curationDataJson } : undefined;
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
    const cohortCurationJson = findCurationDataJsonById(input.onboardingItemId);
    const curationRow = cohortCurationJson ? { curation_data_json: cohortCurationJson } : undefined;
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
    const cohortParent = findCohortParentGateRow(run.cohort_run_id);
    const parentRun = cohortParent ? { id: cohortParent.id, status: cohortParent.status, workspace_id: cohortParent.workspaceId } : undefined;
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
      const gatePageRows = listGatePageProposalsByRun(input.activeRunId);
      const pageProposalRows = gatePageRows.map(row => ({
        target_id: row.targetId,
        effective_target_id: row.effectiveTargetId,
        has_accepted_decision: row.hasAcceptedDecision ? 1 : 0,
      }));
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

  const gateProposals = listGateProposalsByRun(input.activeRunId);
  const proposals = gateProposals.map(row => ({
    id: row.id,
    status: row.status,
    proposal_type: row.proposalType,
    target_id: row.targetId,
    has_decision: row.hasDecision ? 1 : 0,
  }));

  if (proposals.length === 0) {
    return { ok: false, code: 'no_proposals', reason: 'No reviewable proposals in the classification run.' };
  }

  // Issue #351: `reviewable_abstention` rows are coded unresolved outcomes
  // (insufficient evidence / missing pair), not pending work — they carry
  // reason + code and are explicitly decision-exempt below. Blocking on
  // them would permanently bar review whenever SKU-local evidence
  // withholds (the correct #351 semantic). Only decision-eligible
  // proposals block as pending.
  const missingDecisions = proposals.filter(p => p.proposal_type !== 'reviewable_abstention' && !p.has_decision);
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
    const pagesCurationJson = findCurationDataJsonById(input.onboardingItemId);
    const pagesCurationRow = pagesCurationJson ? { curation_data_json: pagesCurationJson } : undefined;
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
  const catalogGateRun = findGateRunById(input.runId);
  const run = catalogGateRun ? {
    status: catalogGateRun.status,
    workspace_id: catalogGateRun.workspaceId,
    product_sku: catalogGateRun.productSku,
    source_kind: catalogGateRun.sourceKind,
    config_snapshot_hash: catalogGateRun.configSnapshotHash,
  } : undefined;
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

  const catalogGateProposals = listGateProposalsByRun(input.runId).filter(p => p.proposalType !== 'reviewable_abstention');
  const reviewableProposals = catalogGateProposals.map(p => ({
    id: p.id,
    status: p.status,
    proposal_type: p.proposalType,
    target_id: p.targetId,
    has_decision: p.hasDecision ? 1 : 0,
  }));

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

  // A3: every accepted image-backed proposal must cite supporting same-run
  // OCR evidence explicitly in the reviewer decision evidenceIds, with a
  // reviewed quote on a byte-identified image. An OCR-only value without a
  // quote, or an accepted visual decision without explicit citation, fails.
  // Citations live in the classification_proposal_decision_evidence join
  // table keyed by live decision id — never a column on the decision row.
  const gateVisualRows = listAcceptedVisualGateRows(input.runId);
  const acceptedVisual = gateVisualRows.map(row => ({
    proposal_id: row.proposalId,
    union: row.unionEvidenceIds,
    decision_id: row.decisionId,
  }));
  const citedByDecision = (decisionId: string | null): string[] => {
    if (!decisionId) return [];
    try {
      return listDecisionEvidenceIds(decisionId);
    } catch {
      return [];
    }
  };
  for (const row of acceptedVisual) {
    const cited = citedByDecision(row.decision_id);
    const union = row.union;
    const visualInUnion = listVisualEvidenceByIds(union, input.runId);
    // Image-backed but uncited: the value came from package pixels yet the
    // reviewer cited no same-run OCR evidence — hold for explicit citation.
    if (visualInUnion.length > 0 && cited.length === 0) {
      return {
        ok: false,
        code: 'visual_citation_missing',
        reason: `Proposal "${row.proposal_id}" is image-backed but cites no same-run OCR evidence; cite the supporting package quotation first.`,
      };
    }
    if (cited.length === 0) continue;
    const visualCited = listVisualEvidenceByIds(cited, input.runId);
    // Cited visual evidence must carry a reviewed quote (non-empty snippet).
    // Byte identity is enforced at apply/upload by A2 re-hashing.
    const quoteless = visualCited.filter(e => !e.snippet || !e.snippet.trim());
    if (quoteless.length > 0) {
      return {
        ok: false,
        code: 'visual_citation_missing_quote',
        reason: `Proposal "${row.proposal_id}" cites visual evidence without a reviewed package quotation; open the image and confirm the exact words.`,
      };
    }
  }

  return { ok: true, proposalCount: reviewableProposals.length };
}
