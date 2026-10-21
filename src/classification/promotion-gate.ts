/**
 * Promotion Gate (issue #30 PR11, DECISION-A).
 *
 * Deterministic, read-only validation that runs PER-ITEM before draft work.
 * Each item is authorized only by its own current terminal classification
 * run, currentness receipt, reviewed classification, and accepted proposals.
 * Parent cohort status and sibling outcomes are not release authority.
 *
 * The pure gate consumes caller-loaded item-local state and never queries.
 *
 * The gate consumes the PR9-review dependency semantics (PR9 C4,
 * DECISION-B): universal-attribute proposals carry NO product-type dependency
 * row, so a PRESENT `execution_product_type` / `reviewed_product_type` row is
 * a truthful type-dependence claim — a proposal whose dependency target no
 * longer equals the item's current effective type is STALE. Decision-level
 * staleness (a superseded `classification_proposal_decisions` row) is ALREADY
 * filtered by `getAcceptedProposals` (`d.superseded_at IS NULL`) and is NOT
 * duplicated here.
 *
 * Legacy items without a current classification run have no executable
 * authority; they must be reclassified before a local CMS draft can be made.
 */
import { CohortSemanticValidationSchema } from '../shared/schemas/onboarding';
import type { CurationData } from '../shared/schemas/onboarding';
import type { ClassificationProposal } from '../shared/types';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';
import type { CohortRun } from '../shared/schemas/cohorts';
import { hashCanonicalJson } from '../shared/stable-id';
import { getEffectiveClassificationPair } from './assignment-projection';
import { getPageIdentityId } from '../shared/proposal-display';
import { getReviewedClassificationPair } from './effective-curation-type';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';

export type PromotionGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'classification_authority_missing'
        | 'semantic_validation_unavailable'
        | 'semantic_validation_blocked'
        | 'run_not_completed'
        | 'workspace_mismatch'
        | 'reviewed_product_type_required'
        | 'stale_proposal'
        | 'stale_page_assignment';
      reason: string;
    };

/** One dependency row as consumed by the gate (kind + target + stamped hash). */
export interface PromotionGateDependencyRow {
  dependencyKind: string;
  dependencyTargetId: string | null;
  /**
   * PR12 C2: the stamped `dependency_value_hash`. Optional — rows without a
   * stamped hash (direct/synthetic callers) keep the pre-PR12 target-only
   * staleness check for that row; the production caller always supplies it.
   */
  dependencyValueHash?: string | null;
}

export interface PromotionGateInput {
  workspaceId: string;
  itemId: string;
  productSku: string;
  /** The item's committed curation data (null for legacy items). */
  curationData: CurationData | null;
  /** The validated active classification run (null when the item has no run pointer). */
  activeRun: ClassificationRunRow | null;
  /** The parent cohort run when the active run is a cohort child; null otherwise. */
  parentRun: CohortRun | null;
  /** The item's current effective Product Type id (null = no type exists). */
  effectiveTypeId: string | null;
  /** Accepted proposals of the item's active run (decision-level staleness already filtered). */
  acceptedProposals: ClassificationProposal[];
  /**
   * Dependency lookup; the caller loads `classification_proposal_dependencies` rows.
   */
  dependencyLookup: (proposalId: string) => PromotionGateDependencyRow[];
  /**
   * Current item-local authority hashes. Absent means target-only staleness.
   */
  currentAuthorityHashes?: { execution?: string | null; reviewed?: string | null };
  /**
   * e09 B3 (P11): the CURRENT verified Page identities of the active Page
   * import, loaded by the caller. When provided, every accepted
   * `category_page` proposal must resolve into this set — a missing,
   * deleted, foreign-import, or name-only identity refuses the item
   * fail-closed BEFORE any draft write. Absent = synthetic callers keep the
   * prior behavior; legacy items (no run pointer) never reach this check.
   */
  verifiedPageIds?: ReadonlySet<string>;
}

const SEMANTIC_BLOCKED_DEFAULT = 'A hard semantic validation finding blocks this item.';

function firstFindingMessage(semanticValidation: Record<string, unknown>): string {
  const findings = semanticValidation.findings;
  if (Array.isArray(findings) && findings.length > 0) {
    const first = findings[0] as { message?: unknown } | null | undefined;
    if (first && typeof first.message === 'string' && first.message.length > 0) {
      return first.message;
    }
  }
  return SEMANTIC_BLOCKED_DEFAULT;
}

/**
 * REVIEWED-FIRST — the item's reviewed canonical classification is its only
 * catalog/Promotion type authority (ADR 0041). Execution Product Type values
 * can drive first-pass Curation but never substitute for a missing reviewed
 * type. Legacy `primary_product_type` proposals remain history-only.
 *
 * PRESENCE vs VALUE (PR11 review R3): an in-run accepted `product_classification`
 * decision is authoritative BY PRESENCE — including an explicit null target
 * (a reviewer clearing the type canonicalizes to `hasRevisedTargetId: true,
 * revisedTargetId: null`). An explicit clear therefore SUPPRESSES the frozen
 * snapshot fallback: the old reviewed authority must never be resurrected;
 * the resolver returns null and the gate refuses
 * `reviewed_product_type_required`. The snapshot fact is consulted ONLY when
 * no in-run accepted type decision exists at all.
 */
export function resolvePromotionEffectiveTypeId(
  _parentRun: CohortRun | null,
  acceptedProposals: ClassificationProposal[],
  snapshot?: RuntimeClassificationSnapshot | null,
): string | null {
  return resolvePromotionEffectiveClassification(_parentRun, acceptedProposals, snapshot).productTypeId;
}

/**
 * The item's CURRENT effective canonical pair (issue #350, ADR 0041):
 * reviewed-first pair authority with the same presence-vs-value semantics.
 * Accepts the `product_classification` kind ONLY (legacy
 * `primary_product_type` is history-only). An explicit clear of either
 * member suppresses the frozen fallback for that member.
 */
export function resolvePromotionEffectiveClassification(
  _parentRun: CohortRun | null,
  acceptedProposals: ClassificationProposal[],
  snapshot?: RuntimeClassificationSnapshot | null,
): { categoryId: string | null; productTypeId: string | null } {
  let inRunReviewedDecisionPresent = false;
  let reviewedPair: { categoryId: string | null; productTypeId: string | null } = { categoryId: null, productTypeId: null };
  for (const proposal of acceptedProposals) {
    // ADR 0041: legacy `primary_product_type` rows are history-only.
    if (proposal.proposalType !== 'product_classification') continue;
    inRunReviewedDecisionPresent = true;
    reviewedPair = getEffectiveClassificationPair(proposal);
    break;
  }
  if (!inRunReviewedDecisionPresent) {
    const reviewed = getReviewedClassificationPair(snapshot ?? undefined);
    return { categoryId: reviewed.categoryId, productTypeId: reviewed.productTypeId };
  }
  return reviewedPair;
}

/**
 * PR12 C1 (issue #30): recompute the CURRENT execution-kind authority
 * value-hash. Mirrors the stamped shapes in `insertProposalDependency` /
 * the cohort freeze stamping (classification-cohort-run-repo.ts / the
 * cohort-curator member commit): `hashCanonicalJson({executionProductTypeId,
 * productTypeConfidence})`. Returns null when the execution type id is null
 * — a null authority can never match a stamped (non-null) dependency value
 * hash, so a null result means "any stamped hash is stale".
 */
export function computeExecutionAuthorityHash(
  executionProductTypeId: string | null,
  productTypeConfidence: number | null,
): string | null {
  if (executionProductTypeId === null) return null;
  return hashCanonicalJson({ executionProductTypeId, productTypeConfidence });
}

/**
 * PR12 C1 (issue #30): recompute the CURRENT reviewed-kind authority
 * value-hash. Mirrors the stamped shape `hashCanonicalJson({reviewedProductTypeId})`.
 * Returns null when the reviewed type id is null.
 */
export function computeReviewedAuthorityHash(reviewedTypeId: string | null): string | null {
  if (reviewedTypeId === null) return null;
  return hashCanonicalJson({ reviewedProductTypeId: reviewedTypeId });
}

/**
 * Fail-closed promotion validation over item-local state. Returns the FIRST
 * refusal (semantic → run currentness → stale-proposal), or `{ ok: true }`.
 */
export function validatePromotionGate(input: PromotionGateInput): PromotionGateResult {
  const {
    workspaceId,
    itemId,
    productSku,
    curationData,
    activeRun,
    effectiveTypeId,
    acceptedProposals,
    dependencyLookup,
    currentAuthorityHashes,
  } = input;

  // Historical items without one need reclassification; they cannot bypass
  // pair/profile readiness by taking the legacy promotion path.
  if (!curationData || !curationData.classificationRunId) {
    return {
      ok: false,
      code: 'classification_authority_missing',
      reason: `Item ${itemId} (SKU ${productSku}) has no current classification run authority; reclassify before promotion.`,
    };
  }
  // A present run pointer that failed ownership validation is never trusted.
  if (!activeRun) {
    return {
      ok: false,
      code: 'semantic_validation_unavailable',
      reason: `Classification run pointer ${curationData.classificationRunId} did not resolve to a validated run for item ${itemId} (workspace ${workspaceId}); promotion blocked.`,
    };
  }

  // The item's own terminal classification run is the release authority.
  if (activeRun.workspaceId !== workspaceId || activeRun.onboardingItemId !== itemId ||
      activeRun.productSku !== productSku || activeRun.id !== curationData.classificationRunId) {
    return {
      ok: false,
      code: 'workspace_mismatch',
      reason: `Classification run ${activeRun.id} is not bound to item ${itemId}, SKU ${productSku}, and workspace ${workspaceId}.`,
    };
  }
  if (activeRun.status !== 'completed' && activeRun.status !== 'completed_with_abstentions') {
    return {
      ok: false,
      code: 'run_not_completed',
      reason:
        `Classification run ${activeRun.id} has status "${activeRun.status}" for item ${itemId} ` +
        `(SKU ${productSku}); only completed runs can promote.`,
    };
  }
  // Item-local semantic blockers remain binding. Missing cohort summaries
  // are not authority: a sibling or parent run cannot decide this item.
  const semanticValidation = curationData.semanticValidation;
  if (semanticValidation !== undefined && semanticValidation !== null) {
    const parsedSemantic = CohortSemanticValidationSchema.safeParse(semanticValidation);
    if (!parsedSemantic.success) {
      return {
        ok: false,
        code: 'semantic_validation_unavailable',
        reason: `Committed item semantic validation is malformed for item ${itemId} (SKU ${productSku}); promotion blocked.`,
      };
    }
    if (parsedSemantic.data.status === 'blocked') {
      return {
        ok: false,
        code: 'semantic_validation_blocked',
        reason: firstFindingMessage(semanticValidation as Record<string, unknown>),
      };
    }
  }

  // Reviewed Product Type is the catalog authority. Execution type never
  // substitutes for a missing reviewed decision (ADR 0041).
  if (effectiveTypeId === null) {
    return {
      ok: false,
      code: 'reviewed_product_type_required',
      reason: `Item ${itemId} (SKU ${productSku}) has no Reviewed Product Type and cannot promote.`,
    };
  }

  // 4. Stale proposals: an accepted proposal whose type-dependency target no
  //    longer matches the item's current effective type is STALE (PR9 C4
  //    semantics — universal attributes carry no dependency row and are never
  //    stale by this rule). A present dependency against a MISSING effective
  //    type is itself stale (the dependency claims a type that does not exist).
  for (const proposal of acceptedProposals) {
    for (const dep of dependencyLookup(proposal.id)) {
      if (
        dep.dependencyKind !== 'execution_product_type' &&
        dep.dependencyKind !== 'reviewed_product_type'
      ) {
        continue;
      }
      if (dep.dependencyTargetId !== effectiveTypeId) {
        return {
          ok: false,
          code: 'stale_proposal',
          reason:
            `Accepted proposal ${proposal.id} (SKU ${productSku}) carries a ${dep.dependencyKind} dependency targeting ` +
            `${dep.dependencyTargetId ?? '<none>'}, but the item's current effective type is ` +
            `${effectiveTypeId ?? '<none>'}; the proposal is stale and cannot promote.`,
        };
      }
      // PR12 C2 (DECISION-A): the stamped value hash is the truthful
      // staleness key — a proposal whose dependency value hash no longer
      // matches the CURRENT authority hash (recomputed from the SAME
      // authority inputs the target check uses) is STALE even when the
      // target id still matches (e.g. a parent confidence drift under the
      // same execution type id, or a re-resolved reviewed authority).
      // Folded into `stale_proposal` (one code — the reason distinguishes
      // target-vs-hash, DECISION-A). Both the target check and the hash
      // check must hold; a null expected hash means any stamped hash is
      // stale (a null authority can never match a stamped hash).
      const hashKind =
        dep.dependencyKind === 'execution_product_type' ? 'execution' : 'reviewed';
      const expectedHash = currentAuthorityHashes?.[hashKind];
      if (expectedHash !== undefined && dep.dependencyValueHash !== expectedHash) {
        return {
          ok: false,
          code: 'stale_proposal',
          reason:
            `Accepted proposal ${proposal.id} (SKU ${productSku}) carries a ${dep.dependencyKind} dependency whose value hash ` +
            `${dep.dependencyValueHash ?? '<none>'} does not match the current authority hash ` +
            `${expectedHash ?? '<none>'} (${hashKind}); the proposal is stale and cannot promote.`,
        };
      }
    }
  }

  // 5. e09 B3 (P11): Category Page currentness against the ACTIVE verified
  //    import — the last fail-closed check before any draft write.
  const pageCurrentness = assertPagesCurrentForImport(input);
  if (pageCurrentness) return pageCurrentness;

  return { ok: true };
}

/**
 * e09 B3 (P11): recompute Category Page assignment currentness against the
 * ACTIVE verified import. An accepted `category_page` proposal whose stable
 * identity is absent from `verifiedPageIds` (deleted page, foreign import,
 * or a name-only proposal with no verifiable identity) refuses the item —
 * defense-in-depth BEFORE any product draft / `product_pages` /
 * `ProductOnPages` write. Reached only with current classification authority
 * and a verified page set.
 */
function assertPagesCurrentForImport(input: PromotionGateInput): PromotionGateResult | null {
  if (!input.verifiedPageIds) return null;
  // P11 fail-closed by design: ANY accepted category_page proposal that does
  // not resolve into the active verified import blocks promotion — including
  // optional secondaries and a stale half of an evidenced dual-species
  // co-primary pair. The draft serializer's visible non-blocking skip for
  // unverified secondary pages applies only POST-gate; the gate itself never
  // lets an item through with an unresolved accepted assignment.
  for (const proposal of input.acceptedProposals) {
    if (proposal.proposalType !== 'category_page') continue;
    const identity = getPageIdentityId(proposal);
    if (!identity || !input.verifiedPageIds.has(identity)) {
      return {
        ok: false,
        code: 'stale_page_assignment',
        reason:
          `Accepted Category Page assignment for item ${input.itemId} (SKU ${input.productSku}) does not resolve ` +
          `into the active verified Page import${identity ? ` (Page ${identity})` : ' (name-only, no verifiable identity)'}; ` +
          'promotion blocked before any draft write (P11).',
      };
    }
  }
  return null;
}
