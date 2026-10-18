/**
 * Central Candidate Safety Validator
 *
 * Every proposal a pipeline stage produces must pass this validator before the
 * run may succeed. The validator enforces:
 *
 * - Claims require linked direct evidence with an approved source. Absence,
 *   inference, and Page context are rejected; third-party and manager-guidance
 *   evidence is not treated as direct product evidence.
 * - Composition attributes require the same direct-evidence provenance.
 * - Confidence is never a license to bypass review: claim/composition
 *   proposals can never be bulk-acceptable, and every proposal is persisted
 *   pending until a human decision exists.
 * - Controlled membership, measured units, cardinality, and delimiter policy
 *   are validated against the attribute config and mapping serialization.
 */
import type { ClassificationEvidence, ClassificationProposal } from '../shared/types';
import type { ProductAttributeConfig } from '../shared/schemas/classification';
import type { CalibratedThresholds } from './confidence-calibrator';
import { validateSerializableValue } from './attribute-value-validation';

export type SafetyFindingCode =
  | 'claim_missing_direct_evidence'
  | 'claim_page_context'
  | 'claim_unapproved_source'
  | 'claim_contradicting_evidence'
  | 'composition_missing_direct_evidence'
  | 'composition_page_context'
  | 'composition_unapproved_source'
  | 'composition_contradicting_evidence'
  | 'bulk_accept_claim'
  | 'bulk_accept_composition'
  | 'controlled_membership'
  | 'measured_unit'
  | 'delimiter_policy'
  | 'page_unverified';

export interface ProposalSafetyFinding {
  proposalId: string;
  code: SafetyFindingCode;
  message: string;
}

export interface ProposalSafetyReport {
  ok: boolean;
  findings: ProposalSafetyFinding[];
}

export interface ProposalSafetyContext {
  /** Attribute configuration for claim/composition/controlled/measured checks. */
  attributes: ProductAttributeConfig[];
  /** Every evidence record accumulated by the run, keyed lookup by id. */
  evidence: ClassificationEvidence[];
  /** Verified page IDs from the frozen snapshot — when present, category_page proposals must be verified (e05s02, ADR 0012 no invented IDs). */
  verifiedPageIds?: Set<string> | null;
}

/**
 * Sources that constitute direct product evidence for claims and composition.
 * Page context, manager guidance, third-party pages, and spreadsheets are NOT
 * direct product statements and are rejected (fail closed).
 */
const DIRECT_EVIDENCE_SOURCES = new Set([
  'official_product_page',
  'visual_product_evidence',
  'catalog_product',
]);

function findEvidence(
  context: ProposalSafetyContext,
  evidenceId: string,
): ClassificationEvidence | null {
  const lookup = new Map(context.evidence.map(evidence => [evidence.id, evidence]));
  return lookup.get(evidenceId) ?? null;
}

function validateDirectEvidence(
  proposal: ClassificationProposal,
  attribute: ProductAttributeConfig,
  context: ProposalSafetyContext,
): ProposalSafetyFinding | null {
  const isClaim = attribute.isClaim === true;

  // Claims/composition REQUIRE at least one target-specific SUPPORTING
  // evidence id with direct product-evidence provenance. Context/unrelated
  // evidence (the backward-compatible evidenceIds union) never satisfies
  // direct evidence (issue #17 pass 5b).
  const supportingIds = proposal.supportingEvidenceIds ?? [];
  if (supportingIds.length === 0) {
    return {
      proposalId: proposal.id,
      code: isClaim ? 'claim_missing_direct_evidence' : 'composition_missing_direct_evidence',
      message: `${attribute.name} (${attribute.id}) requires target-specific supporting direct evidence, but the proposal has none. Absence, inference, and context evidence cannot support a claim or composition value.`,
    };
  }

  for (const evidenceId of supportingIds) {
    const evidence = findEvidence(context, evidenceId);
    if (!evidence) {
      return {
        proposalId: proposal.id,
        code: isClaim ? 'claim_missing_direct_evidence' : 'composition_missing_direct_evidence',
        message: `${attribute.name} (${attribute.id}) links missing supporting evidence "${evidenceId}".`,
      };
    }
    if (evidence.source === 'page_context') {
      return {
        proposalId: proposal.id,
        code: isClaim ? 'claim_page_context' : 'composition_page_context',
        message: `${attribute.name} (${attribute.id}) is supported only by Page context. Page context is review context, never direct product evidence.`,
      };
    }
    if (!DIRECT_EVIDENCE_SOURCES.has(evidence.source)) {
      return {
        proposalId: proposal.id,
        code: isClaim ? 'claim_unapproved_source' : 'composition_unapproved_source',
        message: `${attribute.name} (${attribute.id}) is supported by unapproved source "${evidence.source}". Claims and composition require direct product evidence (official product page, visual product evidence, or catalog product data).`,
      };
    }
  }

  return null;
}

/**
 * P3 calibrated bulk acceptance (plan B.P3.4) — pure decision over the
 * existing `isBulkAcceptable` machinery (Issue #10).
 *
 * A proposal is bulk-acceptable ONLY when ALL of:
 * - CALIBRATED thresholds exist (a calibrated model with fitted thresholds);
 *   `calibrated === null/undefined` is the UNCALIBRATED fallback and returns
 *   false — byte-identical to the legacy behavior where nothing was ever
 *   marked bulk-acceptable from confidence;
 * - the proposal is a plain `field_assignment` (claims/composition can never
 *   be bulk-acceptable — the validator finding below still enforces this);
 * - the attribute carries no claim/composition semantics;
 * - the value has NO contradicting evidence (conflicts force manual review);
 * - confidence clears the CALIBRATED `fieldAssignment.reviewAbove` threshold.
 *
 * Calibration NEVER grants acceptance: a bulk-acceptable proposal stays
 * `pending` until an explicit human/policy decision, per confidence-calibrator's
 * evaluation-only contract. The uncalibrated fallback exists so callers can
 * thread thresholds without branching — passing null reproduces today's
 * output byte-identically (`isBulkAcceptable` resolves to false downstream).
 */
export function isCalibratedBulkAcceptable(
  proposal: Pick<ClassificationProposal, 'proposalType' | 'confidence' | 'contradictingEvidenceIds'>,
  attribute: ProductAttributeConfig | null,
  calibrated?: CalibratedThresholds | null,
): boolean {
  if (!calibrated) return false;
  if (proposal.proposalType !== 'field_assignment') return false;
  if (!attribute || attribute.isClaim === true || attribute.isCompositionAttribute === true) return false;
  if (proposal.contradictingEvidenceIds && proposal.contradictingEvidenceIds.length > 0) return false;
  return proposal.confidence >= calibrated.fieldAssignment.reviewAbove;
}

/**
 * Validate every reviewable proposal in a run.
 *
 * `reviewable_abstention`, `primary_product_type`, and `category_page`
 * proposals carry no attribute value and are not claim-scoped; they pass.
 * `configuration_gap` proposals are advisory and pass.
 */
export function validateProposalSafety(
  proposals: ClassificationProposal[],
  context: ProposalSafetyContext,
): ProposalSafetyReport {
  const findings: ProposalSafetyFinding[] = [];

  for (const proposal of proposals) {
    // story: e05s02 — no invented IDs for category_page (verified catalog)
    if (proposal.proposalType === 'category_page') {
      if (context.verifiedPageIds && context.verifiedPageIds.size > 0) {
        const pv = proposal.proposedValue as Record<string, unknown> | null | undefined;
        const pageId = pv && typeof pv === 'object' && typeof (pv as Record<string, unknown>).pageId === 'string'
          ? String((pv as Record<string, unknown>).pageId)
          : (typeof proposal.targetId === 'string' && proposal.targetId ? proposal.targetId : null);
        if (pageId && !context.verifiedPageIds.has(pageId)) {
          findings.push({
            proposalId: proposal.id,
            code: 'page_unverified',
            message: `Category page "${pageId}" is not in the verified page catalog — invented page IDs are never promoted (ADR 0012).`,
          });
        }
      }
      continue;
    }
    if (proposal.proposalType !== 'field_assignment') continue;

    const attribute = context.attributes.find(candidate => candidate.id === proposal.targetId);
    if (!attribute) {
      // No attribute configuration: nothing to enforce for unknown attributes.
      continue;
    }

    const isClaim = attribute.isClaim === true;
    const isComposition = attribute.isCompositionAttribute === true;

    if (isClaim || isComposition) {
      // Contradictory or insufficient direct evidence withholds the proposal:
      // a claim/composition can never proceed through an unresolved conflict
      // (issue #17 H). Contradictions are never resolved by source order or
      // confidence.
      if (proposal.contradictingEvidenceIds && proposal.contradictingEvidenceIds.length > 0) {
        findings.push({
          proposalId: proposal.id,
          code: isClaim ? 'claim_contradicting_evidence' : 'composition_contradicting_evidence',
          message: `${attribute.name} (${attribute.id}) has ${proposal.contradictingEvidenceIds.length} contradicting evidence record(s). ${isClaim ? 'Claims' : 'Composition'} cannot proceed through a conflict.`,
        });
        continue;
      }
      const evidenceFinding = validateDirectEvidence(proposal, attribute, context);
      if (evidenceFinding) {
        findings.push(evidenceFinding);
        continue;
      }
      if (proposal.isBulkAcceptable === true) {
        findings.push({
          proposalId: proposal.id,
          code: isClaim ? 'bulk_accept_claim' : 'bulk_accept_composition',
          message: `${attribute.name} (${attribute.id}) is a ${isClaim ? 'claim' : 'composition'} attribute and can never be bulk-acceptable; it requires manual review.`,
        });
      }
    }

    // Value-shape validation (controlled membership, measured units).
    // Cardinality is enforced by the proposal builder (single truncation) and
    // delimiter policy by the shared serializer.
    const shapeFinding = validateSerializableValue(proposal.proposedValue, attribute);
    if (!shapeFinding.ok) {
      findings.push({ proposalId: proposal.id, code: shapeFinding.code as SafetyFindingCode, message: shapeFinding.message });
    }
  }

  return { ok: findings.length === 0, findings };
}
