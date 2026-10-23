import { hashCanonicalJson } from '../shared/stable-id';
import type {
  AcceptedItemEvidence,
  ItemChecklistEvaluation,
  ListingCompletenessException,
  ListingCompletenessStandard,
  ListingRequirement,
} from '../shared/schemas/item-evidence';

export interface ItemAssetRightsBinding {
  localPath: string;
  sourceUrl: string;
  assetId?: string;
  factId: string;
  approvalId: string;
  rightsAuthorityHash: string;
}

export interface ItemChecklistInput {
  nonWaivableFields?: string[];
  allowMissingEvidence?: boolean;
  assetRightsBindings?: ItemAssetRightsBinding[];
  workspaceId: string;
  itemId: string;
  sku: string;
  classification: { categoryId: string; productTypeId: string } | null;
  listing: Record<string, unknown> | null;
  evidence: AcceptedItemEvidence | null;
  standard: ListingCompletenessStandard | null;
  exceptions: ListingCompletenessException[];
  inputHash: string | null;
  listingHash: string | null;
  classificationHash: string | null;
}

function valueStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(valueStrings);
  return [];
}

const NON_WAIVABLE_KINDS = new Set(['identity', 'image_rights', 'safety', 'classification']);
const NON_WAIVABLE_FIELDS = new Set(['sku', 'upc', 'variant', 'variant_key', 'category', 'category_id', 'product_type', 'product_type_id', 'image_rights', 'safety']);
const NON_WAIVABLE_FIELD_PATTERN = /identity|(^|[^a-z])(sku|upc|gtin|variant|category|product.?type|safety|rights|licen[cs]e)([^a-z]|$)/i;
function isNonWaivable(requirement: ListingRequirement, input: ItemChecklistInput): boolean {
  return NON_WAIVABLE_KINDS.has(requirement.kind) ||
    NON_WAIVABLE_FIELDS.has(requirement.field.toLocaleLowerCase()) ||
    NON_WAIVABLE_FIELD_PATTERN.test(requirement.field) ||
    input.nonWaivableFields?.includes(requirement.field) === true;
}

function valuePresent(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

function applicable(requirement: ListingRequirement, facts: AcceptedItemEvidence['facts']): boolean | null {
  const condition = requirement.applicableWhen;
  if (!condition) return true;
  const matches = facts.filter(fact => fact.field === condition.attributeId);
  if (matches.length === 0) return null;
  const values = new Set(matches.map(fact => fact.value.trim().toLocaleLowerCase()));
  if (values.size !== 1) return null;
  return condition.values.some(value => values.has(value.trim().toLocaleLowerCase()));
}

function requirementDependencyHash(
  requirement: ListingRequirement,
  input: ItemChecklistInput,
  applicableState: boolean | null,
): string {
  const listingValue = input.listing?.[requirement.field];
  const mediaPaths = valueStrings(listingValue);
  const relevantBindings = input.assetRightsBindings?.filter(binding => mediaPaths.includes(binding.localPath)) ?? [];
  const boundFactIds = new Set(relevantBindings.flatMap(binding => binding.factId ? [binding.factId] : []));
  const relevantFacts = input.evidence?.facts.filter(fact =>
    fact.field === requirement.field || fact.field === requirement.id ||
    (requirement.applicableWhen && fact.field === requirement.applicableWhen.attributeId) ||
    boundFactIds.has(fact.id),
  ) ?? [];
  const relevantObservationIds = new Set(relevantFacts.map(fact => fact.observationId));
  const sourceAuthorities = input.evidence?.observations.filter(observation => relevantObservationIds.has(observation.id))
    .map(({ id, sourceRole, authorityHash }) => ({ id, sourceRole, authorityHash })) ?? null;
  const bindingDependencies = relevantBindings.map(({ localPath, sourceUrl, assetId, factId, approvalId, rightsAuthorityHash }) =>
    ({ localPath, sourceUrl, assetId: assetId ?? null, factId, approvalId, rightsAuthorityHash }),
  );
  return hashCanonicalJson({
    requirement: {
      id: requirement.id, field: requirement.field, kind: requirement.kind,
      required: requirement.required, exceptionEligible: requirement.exceptionEligible,
      allowedSourceRoles: [...requirement.allowedSourceRoles].sort(),
      applicableWhen: requirement.applicableWhen
        ? { attributeId: requirement.applicableWhen.attributeId, values: [...requirement.applicableWhen.values].sort() }
        : null,
      applicableState,
    },
    classification: input.classification,
    classificationHash: input.classificationHash,
    inputHash: input.inputHash,
    sku: input.sku,
    listingValue: valuePresent(listingValue) ? listingValue : null,
    facts: relevantFacts.map(fact => ({ id: fact.id, field: fact.field, valueHash: fact.valueHash, observationId: fact.observationId })),
    identity: input.evidence?.observations.map(observation => observation.identity) ?? null,
    sourceAuthorities,
    bindingDependencies,
  });
}
function identityMatches(
  field: string,
  value: unknown,
  input: ItemChecklistInput,
  evidence: AcceptedItemEvidence,
): boolean {
  if (!valuePresent(value) || evidence.observations.length === 0 ||
      evidence.observations.some(observation => observation.identity.outcome !== 'confirmed')) return false;
  const candidate = String(value).trim().toLocaleLowerCase();
  if (/variant/i.test(field)) {
    const variants = evidence.observations.map(observation => observation.identity.variantKey);
    return variants.every(variant => variant !== null && variant.trim().toLocaleLowerCase() === candidate);
  }
  return candidate === input.itemId.toLocaleLowerCase() || candidate === input.sku.toLocaleLowerCase();
}

function hasRightsForValue(
  value: unknown,
  supported: AcceptedItemEvidence['facts'],
  input: ItemChecklistInput,
): boolean {
  const paths = valueStrings(value);
  if (paths.length === 0) return false;
  return paths.every(path => supported.some(fact =>
    fact.rights !== null && String(fact.value).trim().toLocaleLowerCase() === path.toLocaleLowerCase(),
  ) || input.assetRightsBindings?.some(binding => {
    if (binding.localPath !== path || !binding.sourceUrl.trim() || !binding.factId.trim() ||
      !binding.approvalId.trim() || !/^[a-f0-9]{64}$/i.test(binding.rightsAuthorityHash) ||
      (binding.assetId !== undefined && !binding.assetId.trim())) return false;
    try {
      const source = new URL(binding.sourceUrl);
      return (source.protocol === 'http:' || source.protocol === 'https:') && !source.username && !source.password;
    } catch {
      return false;
    }
  }) === true);
}

export function evaluateItemChecklist(input: ItemChecklistInput): ItemChecklistEvaluation {
  const standard = input.standard;
  const evidence = input.evidence;
  const base = {
    inputHash: input.inputHash,
    evidenceHash: evidence?.evidenceHash ?? null,
    standardHash: standard?.standardHash ?? null,
    classificationHash: input.classificationHash,
    listingHash: input.listingHash,
  };
  const bootstrap = evidence === null && input.allowMissingEvidence === true;
  const scopeMismatch = !standard || (!evidence && !bootstrap) ||
    (bootstrap && (!input.listing || !input.inputHash || !input.listingHash || !input.classificationHash)) ||
    (evidence && (evidence.workspaceId !== input.workspaceId || evidence.itemId !== input.itemId || evidence.sku !== input.sku ||
      evidence.inputHash !== input.inputHash)) ||
    standard.categoryId !== input.classification?.categoryId ||
    standard.productTypeId !== input.classification?.productTypeId;
  if (scopeMismatch) {
    return {
      ...base,
      status: 'unavailable',
      requirements: standard?.requirements.map(requirement => ({
        requirementId: requirement.id, field: requirement.field, label: requirement.label,
        required: requirement.required, exceptionEligible: requirement.exceptionEligible,
        state: 'unavailable' as const, factIds: [], dependencyHash: null, exceptionId: null,
        reason: 'Current listing, accepted evidence, canonical classification, or matching approved standard is unavailable.',
      })) ?? [],
      reasons: ['A current listing, accepted evidence, canonical classification, or matching approved completeness standard is unavailable.'],
    };
  }
  if (!evidence) {
    const reason = 'Current accepted evidence is unavailable; acquire item-specific evidence before evaluating this requirement.';
    return {
      ...base,
      status: bootstrap ? 'needs_attention' : 'unavailable',
      requirements: standard.requirements.map(requirement => {
        const hard = isNonWaivable(requirement, input);
        const required = hard || requirement.required;
        return {
          requirementId: requirement.id, field: requirement.field, label: requirement.label,
          required, exceptionEligible: !hard && requirement.exceptionEligible,
          state: requirement.applicableWhen ? 'unavailable' as const : required ? 'missing' as const : 'unavailable' as const,
          factIds: [], dependencyHash: null, exceptionId: null, reason,
        };
      }),
      reasons: [reason],
    };
  }
  if (!input.classification || !input.listing || !input.inputHash || !input.listingHash || !input.classificationHash) {
    return {
      ...base, status: 'unavailable',
      requirements: standard.requirements.map(requirement => ({
        requirementId: requirement.id, field: requirement.field, label: requirement.label,
        required: requirement.required, exceptionEligible: requirement.exceptionEligible,
        state: 'unavailable' as const, factIds: [], dependencyHash: null, exceptionId: null,
        reason: 'Current listing, accepted evidence, canonical classification, or matching approved standard is unavailable.',
      })),
      reasons: ['A current listing, accepted evidence, canonical classification, or matching approved completeness standard is unavailable.'],
    };
  }

  if (evidence.observations.length === 0 || evidence.observations.some(observation => observation.identity.outcome !== 'confirmed')) {
    const identityReason = 'Exact item and variant identity is not currently confirmed.';
    return {
      ...base,
      status: 'stale',
      requirements: standard.requirements.map(requirement => ({
        requirementId: requirement.id, field: requirement.field, label: requirement.label,
        required: requirement.required || isNonWaivable(requirement, input),
        exceptionEligible: false, state: 'stale' as const, factIds: [], dependencyHash: null,
        exceptionId: null, reason: identityReason,
      })),
      reasons: [identityReason],
    };
  }

  const requirements = standard.requirements.map(requirement => {
    const applies = applicable(requirement, evidence.facts);
    const hard = isNonWaivable(requirement, input);
    const required = hard || requirement.required;
    const exceptionEligible = !hard && requirement.exceptionEligible;
    const identityRequired = requirement.kind === 'identity' || /identity|sku|upc|gtin|variant/i.test(requirement.field);
    const rightsRequired = requirement.kind === 'image_rights' || /rights|licen[cs]e/i.test(requirement.field);
    const dep = requirementDependencyHash(requirement, input, applies);
    const facts = evidence.facts.filter(fact => fact.field === requirement.field || fact.field === requirement.id);
    const listing = input.listing as Record<string, unknown>;
    const value = listing[requirement.field];
    const supported = facts.filter(fact => {
      const observation = evidence.observations.find(candidate => candidate.id === fact.observationId);
      if (!observation || !requirement.allowedSourceRoles.includes(observation.sourceRole)) return false;
      return valuePresent(value) && String(fact.value).trim().toLocaleLowerCase() === String(value).trim().toLocaleLowerCase();
    });
    const conflicted = new Set(facts.map(fact => fact.valueHash)).size > 1;
    let state: ItemChecklistEvaluation['requirements'][number]['state'];
    let reason: string | null = null;
    let exceptionId: string | null = null;

    if (applies === null) {
      state = 'unavailable';
      reason = 'Conditional applicability cannot be determined from current accepted facts.';
    } else if (!applies && !hard) {
      state = 'not_applicable';
    } else if (!applies) {
      state = 'missing';
      reason = `${requirement.label} is a non-waivable requirement and cannot be made inapplicable by policy.`;
    } else if (conflicted) {
      state = 'conflicted';
      reason = `Accepted evidence conflicts for ${requirement.label}.`;
    } else if (rightsRequired && !hasRightsForValue(value, supported, input)) {
      state = 'missing';
      reason = 'Required image or content rights approval is not present in accepted evidence.';
    } else if (rightsRequired) {
      state = 'satisfied';
    } else if (identityRequired && identityMatches(requirement.field, value, input, evidence)) {
      state = 'satisfied';
    } else if (identityRequired) {
      state = 'stale';
      reason = 'Exact item and variant identity is not currently confirmed for this listing value.';
    } else if (requirement.kind === 'classification' &&
      (!input.classification || !input.classification.categoryId.trim() || !input.classification.productTypeId.trim())) {
      state = 'missing';
      reason = 'Canonical Category and Product Type are both required.';
    } else if (valuePresent(value) && (supported.length > 0 || requirement.kind === 'classification')) {
      state = 'satisfied';
    } else {
      const decision = input.exceptions.filter(exception =>
        exception.workspaceId === input.workspaceId && exception.itemId === input.itemId &&
        exception.sku === input.sku && exception.requirementId === requirement.id,
      ).sort((a, b) => b.revision - a.revision)[0];
      const currentApproval = decision?.decision === 'approved' && decision.standardId === standard.id &&
        decision.standardHash === standard.standardHash && decision.classificationHash === input.classificationHash &&
        decision.inputHash === input.inputHash && decision.dependencyHash === dep;
      if (currentApproval && decision && required && exceptionEligible) {
        state = 'excepted';
        exceptionId = decision.id;
      } else {
        const staleApproval = decision?.decision === 'approved' && !currentApproval;
        state = staleApproval ? 'stale' : 'missing';
        reason = staleApproval
          ? 'The omission approval is stale; review this requirement again.'
          : `Required ${requirement.label} is not supported by current accepted evidence.`;
        if (decision?.decision === 'approved') exceptionId = decision.id;
      }
    }
    return { requirementId: requirement.id, field: requirement.field, label: requirement.label,
      required, exceptionEligible, state,
      factIds: [...new Set([
        ...supported.map(fact => fact.id),
        ...(hasRightsForValue(value, supported, input)
          ? (input.assetRightsBindings ?? []).filter(binding => valueStrings(value).includes(binding.localPath))
            .flatMap(binding => binding.factId ? [binding.factId] : [])
          : []),
      ])], dependencyHash: dep, exceptionId, reason };
  });
  const reasons = requirements.flatMap(requirement => requirement.required && !['satisfied', 'not_applicable', 'excepted'].includes(requirement.state)
    ? [requirement.reason ?? `${requirement.label} is ${requirement.state}.`] : []);
  const status = requirements.some(requirement => requirement.state === 'unavailable') ? 'unavailable'
    : requirements.some(requirement => requirement.state === 'stale') ? 'stale'
      : reasons.length > 0 ? 'needs_attention' : 'ready';
  return { ...base, status, requirements, reasons };
}
