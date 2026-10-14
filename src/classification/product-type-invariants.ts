/**
 * Product Type Invariant Attribute Resolver (pure module).
 *
 * Resolves deterministic attribute proposals directly from the Effective
 * Product Type's `invariantAttributes` map (e.g. `dog-food-dry` implies
 * `species: "Dog"` and `food-form: "Dry Food"`).
 *
 * Invariant proposals:
 * - Execute BEFORE the variable-field processing loop.
 * - Require ZERO LLM / model calls.
 * - Build proposals via `buildFieldAssignmentProposal` with `confidence: 1.0`.
 * - Attach first-class provenance `derivation: { kind: 'product_type_invariant', productTypeId, productTypeSource }`.
 * - Reuse `buildEvidenceTargetPacket` to detect semantic contradictions.
 * - Maintain `isBulkAcceptable: false` in Phase 1 (safety invariant: 100% derivation certainty is not 100% upstream premise truth).
 * - Exclude resolved invariant targets from `remainingGatedTargets` so they never hit matchers or LLMs.
 */
import type { ClassificationProposal, ProductTypeConfig } from '../shared/schemas/classification';
import type { ClassificationEvidence } from '../shared/types';
import type { ResolvedTarget } from './curation-target-resolver';
import { buildEvidenceTargetPacket } from './evidence-targeting';
import { buildFieldAssignmentProposal } from './curation-target-proposal';

export interface GatedProductFieldTarget {
  target: ResolvedTarget;
  cardinality: 'single' | 'multiple';
}

export interface ResolveInvariantsInput {
  effectiveTypeId: string | null;
  effectiveTypeSource: 'reviewed' | 'none';
  gatedTargets: GatedProductFieldTarget[];
  productTypes: ProductTypeConfig[];
  evidence: ClassificationEvidence[];
  runId: string;
  sku: string;
  snapshotHash?: string | null;
}

export interface ResolveInvariantsResult {
  invariantProposals: ClassificationProposal[];
  remainingGatedTargets: GatedProductFieldTarget[];
}

export function resolveProductTypeInvariants(input: ResolveInvariantsInput): ResolveInvariantsResult {
  const { effectiveTypeId, effectiveTypeSource, gatedTargets, productTypes, evidence, runId, sku, snapshotHash } = input;

  if (!effectiveTypeId || productTypes.length === 0 || gatedTargets.length === 0) {
    return {
      invariantProposals: [],
      remainingGatedTargets: gatedTargets,
    };
  }

  const productType = productTypes.find(t => t.id === effectiveTypeId);
  const invariantMap = productType?.invariantAttributes;
  if (!invariantMap || Object.keys(invariantMap).length === 0) {
    return {
      invariantProposals: [],
      remainingGatedTargets: gatedTargets,
    };
  }

  const invariantProposals: ClassificationProposal[] = [];
  const resolvedTargetIds = new Set<string>();

  for (const [attrId, invariantVal] of Object.entries(invariantMap)) {
    const gatedEntry = gatedTargets.find(
      g => (g.target.attribute?.id ?? g.target.config.attributeId) === attrId,
    );
    if (!gatedEntry) {
      // Attribute is not in the enabled applicable targets set (e.g. target disabled or not in profile)
      continue;
    }

    const { target, cardinality } = gatedEntry;
    const attribute = target.attribute;

    // Reuse buildEvidenceTargetPacket with invariant value as proposedValue
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: attrId,
      sourceField: target.config.catalogField,
      selectionMode: cardinality,
      proposedValue: invariantVal,
      aliases: attribute?.valueAliases ?? [],
    });

    const proposal = buildFieldAssignmentProposal({
      runId,
      sku,
      attributeId: target.attribute?.id ?? target.config.attributeId ?? target.config.id,
      value: invariantVal,
      confidence: 1.0,
      isMultiple: cardinality === 'multiple',
      derivation: {
        kind: 'product_type_invariant',
        productTypeId: effectiveTypeId,
        productTypeSource: effectiveTypeSource,
      },
      isBulkAcceptable: false, // Phase 1 safety invariant
      evidenceIds: packet.evidenceIds,
      supportingEvidenceIds: packet.supportingEvidenceIds,
      contradictingEvidenceIds: packet.contradictingEvidenceIds,
      snapshotHash: snapshotHash ?? null,
    });

    invariantProposals.push(proposal);
    resolvedTargetIds.add(target.config.id);
  }

  const remainingGatedTargets = gatedTargets.filter(g => !resolvedTargetIds.has(g.target.config.id));

  return {
    invariantProposals,
    remainingGatedTargets,
  };
}
