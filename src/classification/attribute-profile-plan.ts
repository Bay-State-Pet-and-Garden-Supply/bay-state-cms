/**
 * Frozen Attribute Profile interpretation (ADR 0041, issue #359).
 *
 * A Type-keyed profile is pair-equivalent only after checking the captured
 * one-Category-per-Type mapping. Null/explicit-empty profiles are valid;
 * missing declarations/references and invalid pairs never mean "all fields".
 * Proposal stages and reviewed readiness consume this same interpretation.
 * Value/evidence validation stays with the existing proposal/review owners;
 * each entry retains its captured requiredness, cardinality and constraints.
 */
import type { AttributeProfileAttribute, ProductAttributeConfig } from '../shared/schemas/classification';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import type { ReviewedFact } from './reviewed-facts';
import { evaluateConditions, isUniversalAttribute, type AttributeApplicability } from './applicability-evaluator';
import { isApprovedClassificationPair } from './product-classification';
import { isProtectedCatalogField, isProtectedTargetId } from './classification-ownership';

export interface AttributeProfilePlanEntry {
  attribute: ProductAttributeConfig;
  rule: AttributeProfileAttribute | null;
  applicability: AttributeApplicability;
  required: boolean;
  cardinality: 'single' | 'multiple';
}

export interface AttributeProfilePlan {
  status: 'ready' | 'unresolved' | 'configuration_gap';
  reason: string | null;
  profileId: string | null;
  entries: AttributeProfilePlanEntry[];
}

function resolveProfile(
  snapshot: RuntimeClassificationSnapshot,
  pair: { categoryId: string | null; productTypeId: string | null },
): Omit<AttributeProfilePlan, 'entries'> & { rules: AttributeProfileAttribute[] } {
  const gap = (reason: string) => ({ status: 'configuration_gap' as const, reason, profileId: null, rules: [] });
  const seenTypes = new Set<string>();
  for (const type of snapshot.productTypes) {
    const categoryId = (type as { categoryId?: string | null }).categoryId;
    if (seenTypes.has(type.id) || !categoryId || !snapshot.categories.some(category => category.id === categoryId)) {
      return gap(`Frozen Product Type "${type.id}" does not have exactly one approved Category mapping.`);
    }
    seenTypes.add(type.id);
  }
  if (!pair.categoryId || !pair.productTypeId) {
    return { status: 'unresolved', reason: 'No complete own-SKU Product Classification (reviewed or provisional); Category + Product Type are required to select an Attribute Profile.', profileId: null, rules: [] };
  }
  if (!isApprovedClassificationPair({ categoryId: pair.categoryId, productTypeId: pair.productTypeId }, snapshot)) {
    return gap(`Product Classification "${pair.categoryId}" + "${pair.productTypeId}" is not an approved pair in the frozen configuration.`);
  }
  const type = snapshot.productTypes.find(candidate => candidate.id === pair.productTypeId)!;
  const declared = (type as { attributeProfileId?: string | null }).attributeProfileId;
  if (declared === null) return { status: 'ready', reason: null, profileId: null, rules: [] };
  if (typeof declared !== 'string' || declared.length === 0) return gap(`Frozen Product Type "${type.id}" has no declared Attribute Profile configuration (null is an explicit empty profile).`);
  const profiles = snapshot.attributeProfiles.filter(profile => profile.id === declared);
  if (profiles.length !== 1 || !Array.isArray(profiles[0]!.attributes)) {
    return gap(`Frozen Product Type "${type.id}" declares missing or invalid Attribute Profile "${declared}".`);
  }
  const rules = profiles[0]!.attributes;
  const seenAttributes = new Set<string>();
  for (const rule of rules) {
    if (seenAttributes.has(rule.attributeId)
      || snapshot.attributes.filter(attribute => attribute.id === rule.attributeId).length !== 1
      || typeof rule.required !== 'boolean'
      || (rule.cardinality !== 'single' && rule.cardinality !== 'multiple')
      || !Array.isArray(rule.applicabilityConditions)) {
      return gap(`Frozen Attribute Profile "${declared}" has an invalid or missing attribute rule for "${rule.attributeId}".`);
    }
    seenAttributes.add(rule.attributeId);
  }
  return { status: 'ready', reason: null, profileId: declared, rules };
}

export function resolveAttributeProfilePlan(
  snapshot: RuntimeClassificationSnapshot | undefined,
  pair: { categoryId: string | null; productTypeId: string | null },
  reviewedFacts: readonly ReviewedFact[] = snapshot?.reviewedFacts ?? [],
): AttributeProfilePlan {
  if (!snapshot) {
    return { status: 'configuration_gap', reason: 'Frozen runtime snapshot is required for Attribute Profile planning; restart classification with captured configuration.', profileId: null, entries: [] };
  }
  if (snapshot.configAuthorityKind !== 'v2') {
    return { status: 'configuration_gap', reason: 'Frozen canonical Category and Attribute Profile authority is missing; reclassify under approved configuration.', profileId: null, entries: [] };
  }
  const facts = reviewedFacts.filter(fact => fact.productSku === snapshot.productSku && fact.workspaceId === snapshot.workspaceId);
  const { rules, ...profile } = resolveProfile(snapshot, pair);
  const rulesById = new Map(rules.map(rule => [rule.attributeId, rule]));
  const entries = snapshot.attributes.map(attribute => {
    const rule = rulesById.get(attribute.id) ?? null;
    const targets = snapshot.curationTargets.filter(target =>
      target.kind === 'product_field' && target.attributeId === attribute.id && (target.enabled || target.mandatory),
    );
    const bindings = snapshot.attributeMappings.filter(candidate => candidate.attributeId === attribute.id);
    const mapping = bindings[0];
    const protectedOutput = isProtectedTargetId(attribute.id, snapshot.attributeMappings)
      || (mapping !== undefined && (mapping.isStale || isProtectedCatalogField(mapping.catalogField, attribute.id, snapshot.attributeMappings)))
      || targets.some(target => target.catalogField && isProtectedCatalogField(target.catalogField, attribute.id, snapshot.attributeMappings));
    const required = rule?.required === true || targets.some(target => target.required);
    let applicability: AttributeApplicability;
    if (protectedOutput) {
      applicability = required
        ? { attributeId: attribute.id, state: 'unknown', reason: 'Required Classification Attribute has a protected or unverified output binding.' }
        : { attributeId: attribute.id, state: 'not_applicable', reason: 'Protected or unverified output is not a Classification Attribute.' };
    } else if (targets.length > 0 && (bindings.length !== 1 || !mapping?.catalogField
      || targets.some(target => target.catalogField && target.catalogField !== mapping.catalogField))) {
      applicability = { attributeId: attribute.id, state: 'unknown', reason: `Frozen Classification Attribute "${attribute.id}" has no unique current field binding consistent with its configured target.` };
    } else if (profile.status === 'configuration_gap') {
      applicability = { attributeId: attribute.id, state: 'unknown', reason: profile.reason! };
    } else if (!isUniversalAttribute(attribute) && profile.status !== 'ready') {
      applicability = { attributeId: attribute.id, state: 'unknown', reason: profile.reason! };
    } else if (!isUniversalAttribute(attribute) && !rule) {
      applicability = { attributeId: attribute.id, state: 'not_applicable', reason: `Attribute is not in the Product Classification profile (${pair.productTypeId}).` };
    } else {
      // Universal ownership is independent of a complete pair, but a broken
      // selected profile remains a configuration gap for every output.
      const state = evaluateConditions(rule?.applicabilityConditions ?? [], facts);
      applicability = {
        attributeId: attribute.id, state,
        ...(state === 'unknown' ? { reason: 'Applicability condition cannot be decided from accepted/reviewed facts.' }
          : state === 'not_applicable' ? { reason: 'Applicability condition is not satisfied by accepted/reviewed facts.' } : {}),
      };
    }
    return {
      attribute, rule, applicability,
      required,
      cardinality: rule?.cardinality ?? targets[0]?.selectionMode ?? 'single',
    };
  });
  return { ...profile, entries };
}
