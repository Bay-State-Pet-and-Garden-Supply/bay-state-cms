import type { AttributeMappingConfig, ClassificationProposal, ProductAttributeConfig } from '../shared/types';
import type { SerializationConfigV2 } from '../shared/schemas/classification';
import { pageNameFromPageValue } from '../shared/proposal-display';
import { resolveAlias } from './controlled-value-identity';
import { isSilentNarrowing } from './attribute-grounding-guards';
import { deterministicStringify } from '../git/deterministic-json';
import { resolveWebsiteClassification, type BundleView } from './product-classification';
import { isBrandPageProposal, isCanonicalClassificationAttributeId, isProtectedCatalogField, isProtectedTargetId, protectedTargetRefusal } from './classification-ownership';

/** Return the reviewed correction when present, including an explicit null. */
export function getEffectiveProposalValue(proposal: ClassificationProposal): unknown {
  return proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
}

/** Return the reviewed target when present; otherwise retain the immutable target. */
export function getEffectiveProposalTargetId(proposal: ClassificationProposal): string | null {
  return proposal.hasRevisedTargetId ? proposal.revisedTargetId ?? null : proposal.targetId;
}

/** Extract a stable Product Type ID from either supported proposal value shape. */
export function getProductTypeIdFromValue(value: unknown): string | null {
  if (value && typeof value === 'object' && 'productTypeId' in value) {
    const productTypeId = (value as { productTypeId?: unknown }).productTypeId;
    return typeof productTypeId === 'string' && productTypeId.length > 0 ? productTypeId : null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Extract the canonical Category ID from a pair proposal value shape.
 * Returns null for legacy type-only values (historical reads, not new authority).
 */
export function getCategoryIdFromValue(value: unknown): string | null {
  if (value && typeof value === 'object' && 'categoryId' in value) {
    const categoryId = (value as { categoryId?: unknown }).categoryId;
    return typeof categoryId === 'string' && categoryId.length > 0 ? categoryId : null;
  }
  return null;
}
/**
 * Resolve the one effective Primary Product Type identity for every consumer.
 *
 * Presence is authoritative, including an explicit null target. Historical
 * one-sided decisions remain compatible, while conflicting paired decisions
 * resolve deterministically to the reviewed target.
 */
export function getEffectivePrimaryProductTypeId(
  proposal: ClassificationProposal,
): string | null {
  if (proposal.hasRevisedTargetId === true) {
    return typeof proposal.revisedTargetId === 'string' && proposal.revisedTargetId.length > 0
      ? proposal.revisedTargetId
      : null;
  }
  if (proposal.hasRevisedValue === true) {
    return getProductTypeIdFromValue(proposal.revisedValue);
  }
  return typeof proposal.targetId === 'string' && proposal.targetId.length > 0
    ? proposal.targetId
    : getProductTypeIdFromValue(proposal.proposedValue);
}

/**
 * Resolve the one effective canonical Category identity for every consumer.
 * Mirrors getEffectivePrimaryProductTypeId: presence is authoritative
 * (explicit clear wins); legacy type-only proposals carry no category.
 */
export function getEffectiveClassificationCategoryId(
  proposal: ClassificationProposal,
): string | null {
  if (proposal.hasRevisedValue === true) {
    return getCategoryIdFromValue(proposal.revisedValue);
  }
  return getCategoryIdFromValue(proposal.proposedValue);
}

/**
 * Resolve the one effective canonical pair for every consumer: the effective
 * type id plus the effective category id. Either member may be null
 * (unresolved); callers gate on completeness through resolveClassificationResult.
 */
export function getEffectiveClassificationPair(
  proposal: ClassificationProposal,
): { categoryId: string | null; productTypeId: string | null } {
  return {
    categoryId: getEffectiveClassificationCategoryId(proposal),
    productTypeId: getEffectivePrimaryProductTypeId(proposal),
  };
}

type MeasuredValueParseResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

function parseMeasuredValue(
  value: unknown,
  canonicalUnit: string | null | undefined,
): MeasuredValueParseResult {
  const unit = canonicalUnit?.trim();
  if (!unit) return { ok: false, message: 'Measured value has no configured canonical unit.' };

  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const match = value.trim().match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(.*)$/);
    if (!match) {
      return { ok: false, message: `Measured value "${value}" is not a finite measured number.` };
    }
    const suppliedUnit = match[2]!.trim();
    if (suppliedUnit && suppliedUnit.toLowerCase() !== unit.toLowerCase()) {
      return { ok: false, message: `Measured value "${value}" does not use the configured unit "${unit}".` };
    }
    numeric = Number(match[1]);
  } else {
    return { ok: false, message: `Measured value "${String(value)}" is not a finite measured number.` };
  }

  if (!Number.isFinite(numeric)) {
    return { ok: false, message: `Measured value "${String(value)}" is not a finite measured number.` };
  }
  return { ok: true, value: numeric };
}

/**
 * Serialize an attribute value into a catalog field string using the mapping's
 * serialization config. This is the ONE serializer shared by preview
 * (draft projection), onboarding promotion, and catalog application.
 *
 * Supports both the legacy v1 shape ({ format, separator, prefix, suffix })
 * and the strict v2 shapes ({ kind: 'scalar' | 'delimited' | 'measured' }).
 *
 * - Explicit clears (null/undefined) produce a true empty string, bypassing
 *   prefix/suffix so the catalog field becomes "" rather than e.g. "Size: ".
 * - `measured` requires a finite number with either no unit or the captured
 *   canonical unit, then appends that unit with the configured separator.
 * - `delimited` joins with the field-specific delimiter. The `reject` escape
 *   policy throws when a value contains the delimiter (fail closed); the
 *   `backslash` policy escapes it.
 */
export function serializeAttributeValue(
  value: unknown,
  serialization: AttributeMappingConfig['serialization'] | SerializationConfigV2,
): string {
  // Explicit clears (null/undefined) bypass prefix/suffix so the catalog
  // field becomes a true empty string rather than e.g. "Size: " or " lb".
  if (value === null || value === undefined) {
    return '';
  }

  const shape = serialization as unknown as {
    kind?: string;
    format?: string;
    separator?: string;
    delimiter?: string;
    escapePolicy?: string;
    prefix?: string;
    suffix?: string;
    unit?: string;
    valueUnitSeparator?: string;
  };
  const prefix = shape.prefix ?? '';
  const suffix = shape.suffix ?? '';
  const kind = shape.kind;
  const format = shape.format;

  let core: string;

  if (kind === 'measured' || format === 'measured') {
    const unit = shape.unit?.trim() ?? '';
    const valueUnitSeparator = shape.valueUnitSeparator ?? ' ';
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = parseMeasuredValue(raw, unit);
    if (!parsed.ok) throw new Error(parsed.message);
    core = `${parsed.value}${unit ? `${valueUnitSeparator}${unit}` : ''}`;
  } else if (kind === 'delimited' || format === 'delimited') {
    const delimiter = shape.delimiter ?? shape.separator ?? ', ';
    const escapePolicy = shape.escapePolicy ?? 'reject';
    const values = Array.isArray(value) ? value.map(item => String(item)) : [String(value)];
    if (escapePolicy === 'backslash') {
      core = values.map(item => item.split(delimiter).join(`\\${delimiter}`)).join(delimiter);
    } else {
      for (const item of values) {
        if (item.includes(delimiter)) {
          throw new Error(`Value "${item}" contains delimiter "${delimiter}" and escapePolicy is "reject".`);
        }
      }
      core = values.join(delimiter);
    }
  } else {
    const separator = shape.separator ?? shape.delimiter ?? ', ';
    if (Array.isArray(value)) {
      core = value.map(item => String(item)).join(separator);
    } else if (typeof value === 'string') {
      core = value;
    } else {
      core = String(value);
    }
  }

  return `${prefix}${core}${suffix}`;
}

/**
 * Validate a proposed value against its attribute shape: controlled
 * membership, measured units, and explicit-clear semantics. Delimiter policy
 * is enforced inside serializeAttributeValue (it throws on violation).
 */
export type SerializableValueValidation =
  | { ok: true }
  | { ok: false; code: 'controlled_membership' | 'measured_unit'; message: string };

export function validateSerializableValue(
  value: unknown,
  attribute?: (
    Pick<
      ProductAttributeConfig,
      'id' | 'valueMode' | 'allowedValues' | 'valueAliases'
    >
    & Partial<Pick<ProductAttributeConfig, 'canonicalUnit'>>
  ) | null,
): SerializableValueValidation {
  // Explicit clears are always legal.
  if (value === null || value === undefined) return { ok: true };

  const values = Array.isArray(value) ? value : [value];

  if (attribute?.valueMode === 'controlled' && values.length > 0 && (attribute.allowedValues?.length ?? 0) === 0) {
    return {
      ok: false,
      code: 'controlled_membership',
      message: `Attribute "${attribute.id}" has no configured controlled values.`,
    };
  }
  if (attribute?.valueMode === 'controlled' && (attribute.allowedValues?.length ?? 0) > 0) {
    for (const item of values) {
      const str = String(item);
      // Exact canonical membership OR an alias that resolves to an exact
      // allowed ID. An unknown/near-match value is never serialized as a
      // controlled value (fail closed).
      const allowed = attribute.allowedValues.includes(str);
      const aliasTarget = allowed
        ? str
        : resolveAlias(str, attribute.valueAliases ?? [], attribute.allowedValues);
      if (aliasTarget === null) {
        return {
          ok: false,
          code: 'controlled_membership',
          message: `Value "${str}" is not in the controlled value list for attribute "${attribute.id}".`,
        };
      }
    }
  }

  if (attribute?.valueMode === 'measured') {
    if (values.length === 0) {
      return {
        ok: false,
        code: 'measured_unit',
        message: `Attribute "${attribute.id}" has no measured value.`,
      };
    }
    for (const item of values) {
      const parsed = parseMeasuredValue(item, attribute.canonicalUnit);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'measured_unit',
          message: `${parsed.message} Attribute "${attribute.id}".`,
        };
      }
    }
  }

  return { ok: true };
}

/** Captured value/mapping authority and verified page display names. */
export interface AssignmentProjectionAuthority {
  attributes?: ProductAttributeConfig[];
  frozenMappings?: AttributeMappingConfig[];
  verifiedPageNames?: ReadonlyMap<string, string>;
  categories?: BundleView['categories'];
  productTypes?: BundleView['productTypes'];
}

/**
 * Interpret reviewed classification changes once for preview and both local
 * draft owners. Explicit no-target corrections produce no assignment; explicit
 * null values clear fields or remove the original verified taxonomy page.
 * `skipped` contains refusals, not successful partial application: mutation
 * owners must refuse the entire projection before persisting if it is nonempty.
 * Pending callers may use this same interpretation only as a separate,
 * visibly provisional supplement, never as approved application authority.
 */
export function buildAssignmentProjection(
  acceptedProposals: ClassificationProposal[],
  currentCustomFields: Record<string, string>,
  currentPageNames: string[],
  mappings: AttributeMappingConfig[],
  verifiedPageIds?: Set<string> | null,
  authority: AssignmentProjectionAuthority = {},
) {
  const fields: Array<{
    catalogField: string;
    currentValue: string | null;
    proposedValue: string;
    isOverwrite: boolean;
    isNoOp: boolean;
  }> = [];
  const additions: Array<{ pageId: string; pageName: string }> = [];
  const removals: Array<{ pageId: string; pageName: string }> = [];
  const skipped: Array<{ proposalId: string; targetId: string | null; reason: string }> = [];
  const classificationProposals = acceptedProposals.filter(proposal => proposal.proposalType === 'product_classification');
  if (classificationProposals.length > 1) {
    for (const proposal of classificationProposals) {
      skipped.push({ proposalId: proposal.id, targetId: getEffectiveProposalTargetId(proposal),
        reason: 'Multiple accepted Product Classification proposals are ambiguous; review one canonical pair.' });
    }
  } else if (classificationProposals.length === 1) {
    const proposal = classificationProposals[0];
    const targetId = getEffectiveProposalTargetId(proposal);
    const refuse = (reason: string) => skipped.push({ proposalId: proposal.id, targetId, reason });
    if (proposal.isStale) {
      refuse('Proposal is stale; re-review before applying');
    } else if (!authority.categories || !authority.productTypes) {
      refuse('Frozen Category and Product Type authority is unavailable');
    } else {
      const pair = getEffectiveClassificationPair(proposal);
      if (!pair.categoryId || !pair.productTypeId) {
        refuse('Canonical Category + Product Type pair is incomplete');
      } else {
        const resolution = resolveWebsiteClassification(
          { categoryId: pair.categoryId, productTypeId: pair.productTypeId },
          { categories: authority.categories, productTypes: authority.productTypes },
        );
        if (resolution.status !== 'resolved') {
          refuse(`${resolution.code}: ${resolution.reason}`);
        } else {
          const pairFields = [
            { catalogField: 'ProductField24', proposedValue: resolution.values.category },
            { catalogField: 'ProductField25', proposedValue: resolution.values.productType },
          ];
          for (const field of pairFields) {
            if (isProtectedCatalogField(field.catalogField, null, mappings)) {
              refuse(`protected_target_refused: Core classification role "${field.catalogField}" is not approved.`);
              break;
            }
          }
          if (skipped.length === 0) for (const field of pairFields) {
            const currentValue = currentCustomFields[field.catalogField] ?? null;
            fields.push({ ...field, currentValue, isOverwrite: currentValue !== null && currentValue !== field.proposedValue,
              isNoOp: currentValue === field.proposedValue });
          }
        }
      }
    }
  }

  for (const proposal of acceptedProposals) {
    const targetId = getEffectiveProposalTargetId(proposal);
    const refuse = (reason: string) => skipped.push({ proposalId: proposal.id, targetId, reason });
    if (proposal.proposalType !== 'field_assignment' && proposal.proposalType !== 'category_page') continue;
    if (proposal.isStale) {
      refuse('Proposal is stale; re-review before applying');
      continue;
    }
    if (proposal.proposalType === 'field_assignment'
      && (isCanonicalClassificationAttributeId(proposal.targetId) || isCanonicalClassificationAttributeId(targetId))) {
      refuse('Core Category and Product Type fields require one accepted Product Classification pair proposal');
      continue;
    }
    if (proposal.proposalType === 'field_assignment') {
      // Both immutable and corrected identities must belong to classification.
      // A protected original cannot be laundered through a permitted correction.
      const targets = [...new Set([proposal.targetId, targetId].filter((id): id is string => !!id))];
      let invalid = false;
      for (const id of targets) {
        if (isProtectedTargetId(id, mappings)) {
          const refusal = protectedTargetRefusal(id);
          refuse(`${refusal.code}: ${refusal.reason}`);
          invalid = true;
          break;
        }
        const matches = mappings.filter(m => m.attributeId === id);
        const mapping = matches[0];
        if (matches.length !== 1 || !mapping?.catalogField || mapping.isStale) {
          refuse('Missing, ambiguous, empty or stale attribute mapping');
          invalid = true;
          break;
        }
        if (isProtectedCatalogField(mapping.catalogField, id, mappings)) {
          const refusal = protectedTargetRefusal(mapping.catalogField);
          refuse(`${refusal.code}: ${refusal.reason}`);
          invalid = true;
          break;
        }
        if (authority.frozenMappings) {
          const frozen = authority.frozenMappings.filter(m => m.attributeId === id);
          if (frozen.length !== 1 || frozen[0].isStale
            || frozen[0].catalogField !== mapping.catalogField
            || deterministicStringify(frozen[0].serialization) !== deterministicStringify(mapping.serialization)) {
            refuse('Mapping changed since classification (mapping_changed). Re-review under the current mapping.');
            invalid = true;
            break;
          }
        }
      }
      if (invalid) continue;
      if (!targetId) {
        if (!proposal.hasRevisedTargetId) refuse('No attribute target');
        continue;
      }
      const mapping = mappings.find(m => m.attributeId === targetId)!;
      const attribute = authority.attributes?.find(a => a.id === targetId);
      if (authority.attributes && !attribute) {
        refuse('Attribute is absent from captured configuration');
        continue;
      }
      let value = getEffectiveProposalValue(proposal);
      if (value === undefined || (value !== null && (Array.isArray(value) ? value : [value])
        .some(item => typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean'))) {
        refuse('Attribute value has an invalid serialization shape');
        continue;
      }
      const validation = validateSerializableValue(value, attribute);
      if (!validation.ok) {
        refuse(validation.message);
        continue;
      }
      if (attribute?.valueMode === 'controlled' && value !== null) {
        const canonicalize = (item: unknown) => attribute.allowedValues.includes(String(item))
          ? String(item) : resolveAlias(String(item), attribute.valueAliases ?? [], attribute.allowedValues) ?? String(item);
        value = Array.isArray(value) ? value.map(canonicalize) : canonicalize(value);
      }
      let proposedValue: string;
      try {
        proposedValue = serializeAttributeValue(value, mapping.serialization);
      } catch (error) {
        refuse(error instanceof Error ? error.message : String(error));
        continue;
      }
      const currentValue = currentCustomFields[mapping.catalogField] ?? null;
      if (!proposal.hasRevisedValue && isSilentNarrowing(currentValue, proposedValue)) {
        refuse('No-narrowing guard: intentional reduction requires an explicit reviewed value');
        continue;
      }
      const previous = fields.find(field => field.catalogField === mapping.catalogField);
      if (previous) {
        if (previous.proposedValue !== proposedValue) refuse('Conflicting accepted assignments address the same catalog field');
        continue;
      }
      fields.push({
        catalogField: mapping.catalogField,
        currentValue,
        proposedValue,
        isOverwrite: currentValue !== null && currentValue !== proposedValue,
        isNoOp: currentValue === proposedValue,
      });
      continue;
    }

    const value = getEffectiveProposalValue(proposal);
    const removal = proposal.hasRevisedValue === true && value === null;
    // Protect both original and corrected page identities/names, including
    // the verified name so a forged label cannot disguise a Brand page.
    const pageValues = [proposal.proposedValue, ...(removal ? [] : [value])];
    let protectedPage = [proposal.targetId, targetId].some(id =>
      !!id && (isBrandPageProposal(id) || isBrandPageProposal(authority.verifiedPageNames?.get(id))));
    for (const pageValue of pageValues) {
      const pageId = pageValue && typeof pageValue === 'object' && 'pageId' in pageValue
        ? String(pageValue.pageId) : null;
      if (isBrandPageProposal(pageNameFromPageValue(pageValue))
        || isBrandPageProposal(pageId ? authority.verifiedPageNames?.get(pageId) : null)) protectedPage = true;
    }
    if (protectedPage) {
      const refusal = protectedTargetRefusal(targetId ?? proposal.targetId);
      refuse(`${refusal.code}: ${refusal.reason}`);
      continue;
    }
    if (!removal && !targetId) {
      if (!proposal.hasRevisedTargetId) refuse('No page target');
      continue;
    }
    if (removal && targetId !== null && targetId !== proposal.targetId) {
      refuse('Page removal must address the original assignment, not a different revised target');
      continue;
    }
    const pageValue = removal ? proposal.proposedValue : value;
    const pageId = pageValue && typeof pageValue === 'object' && 'pageId' in pageValue
      && typeof pageValue.pageId === 'string' ? pageValue.pageId : null;
    const identityTarget = removal ? proposal.targetId : targetId;
    if (!pageId || pageId !== identityTarget || !verifiedPageIds?.has(pageId)) {
      refuse('Page identity unverified or inconsistent with the reviewed target');
      continue;
    }
    const pageName = authority.verifiedPageNames
      ? authority.verifiedPageNames.get(pageId) : pageNameFromPageValue(pageValue);
    if (!pageName) {
      refuse('Verified page display name missing');
      continue;
    }
    if (isBrandPageProposal(pageName)) {
      const refusal = protectedTargetRefusal(identityTarget);
      refuse(`${refusal.code}: ${refusal.reason}`);
      continue;
    }
    const changes = removal ? removals : additions;
    const opposite = removal ? additions : removals;
    if (opposite.some(page => page.pageId === pageId || page.pageName === pageName)) {
      refuse('Conflicting accepted page addition and removal');
      continue;
    }
    if (!changes.some(page => page.pageId === pageId)) changes.push({ pageId, pageName });
  }

  const removed = removals.map(page => page.pageName);
  const proposed = additions.map(page => page.pageName).filter(name => !currentPageNames.includes(name));
  const final = currentPageNames.filter(name => !removed.includes(name));
  for (const page of additions) if (!final.includes(page.pageName)) final.push(page.pageName);
  return { fields, pages: { existing: currentPageNames, proposed, removed, additions, removals, final }, skipped };
}
