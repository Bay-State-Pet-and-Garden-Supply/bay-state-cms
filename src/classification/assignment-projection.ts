import type { AttributeMappingConfig, ClassificationProposal, ProductAttributeConfig } from '../shared/types';
import type { SerializationConfigV2 } from '../shared/schemas/classification';
import { pageNameFromPageValue } from '../shared/proposal-display';
import { resolveAlias } from './controlled-value-identity';

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
 * - `measured` validates that the value is a finite number and appends the
 *   unit with the configured separator.
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
    const unit = shape.unit ?? '';
    const valueUnitSeparator = shape.valueUnitSeparator ?? ' ';
    const raw = Array.isArray(value) ? value[0] : value;
    let numeric: number;
    if (typeof raw === 'number') {
      numeric = raw;
    } else {
      const stripped = String(raw).replace(/[^\d.-]/g, '');
      if (stripped === '' || stripped === '-' || stripped === '.' || stripped === '-.') {
        throw new Error(`Measured value "${String(raw)}" is not a finite number.`);
      }
      numeric = Number(stripped);
    }
    if (!Number.isFinite(numeric)) {
      throw new Error(`Measured value "${String(raw)}" is not a finite number.`);
    }
    core = `${numeric}${unit ? `${valueUnitSeparator}${unit}` : ''}`;
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
  attribute?: Pick<
    ProductAttributeConfig,
    'id' | 'valueMode' | 'allowedValues' | 'valueAliases'
  > | null,
): SerializableValueValidation {
  // Explicit clears are always legal.
  if (value === null || value === undefined) return { ok: true };

  const values = Array.isArray(value) ? value : [value];

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
    for (const item of values) {
      let numeric: number;
      if (typeof item === 'number') {
        numeric = item;
      } else {
        const stripped = String(item).replace(/[^\d.-]/g, '');
        if (stripped === '' || stripped === '-' || stripped === '.' || stripped === '-.') {
          return {
            ok: false,
            code: 'measured_unit',
            message: `Value "${String(item)}" is not a finite measured number for attribute "${attribute.id}".`,
          };
        }
        numeric = Number(stripped);
      }
      if (!Number.isFinite(numeric)) {
        return {
          ok: false,
          code: 'measured_unit',
          message: `Value "${String(item)}" is not a finite measured number for attribute "${attribute.id}".`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Project the effect of accepted proposals against current product state.
 * Produces three views:
 * - fields: per-catalog-field diff showing current, proposed, overwrite, no-op
 * - pages: existing vs proposed page additions
 * - skipped: proposals that could not be mapped
 *
 * When `verifiedPageIds` is provided (a Set of page_index row IDs from the
 * active verified import), category_page proposals whose identity is not
 * verified are skipped with a visible reason — name-only data is never
 * serializable. When it is absent/null the caller opts out of verification
 * (legacy preview contexts); production serialization always passes it.
 */
export function buildAssignmentProjection(
  acceptedProposals: ClassificationProposal[],
  currentCustomFields: Record<string, string>,
  currentPageNames: string[],
  mappings: AttributeMappingConfig[],
  verifiedPageIds?: Set<string> | null,
): {
  fields: Array<{
    catalogField: string;
    currentValue: string | null;
    proposedValue: string | null;
    isOverwrite: boolean;
    isNoOp: boolean;
  }>;
  pages: {
    existing: string[];
    proposed: string[];
  };
  skipped: Array<{
    proposalId: string;
    targetId: string | null;
    reason: string;
  }>;
} {
  const fields: Array<{
    catalogField: string;
    currentValue: string | null;
    proposedValue: string | null;
    isOverwrite: boolean;
    isNoOp: boolean;
  }> = [];
  const proposedPages: string[] = [];
  const skipped: Array<{
    proposalId: string;
    targetId: string | null;
    reason: string;
  }> = [];
  const seenFields = new Set<string>();

  for (const proposal of acceptedProposals) {
    if (proposal.proposalType === 'field_assignment') {
      // Effective reviewed target/value win over the immutable prediction.
      const targetId = getEffectiveProposalTargetId(proposal);
      if (!targetId) {
        skipped.push({ proposalId: proposal.id, targetId: null, reason: 'No attribute target' });
        continue;
      }
      const mapping = mappings.find(m => m.attributeId === targetId);
      if (!mapping) {
        skipped.push({ proposalId: proposal.id, targetId, reason: 'No attribute mapping found' });
        continue;
      }
      if (mapping.isStale) {
        skipped.push({ proposalId: proposal.id, targetId, reason: 'Attribute mapping is stale' });
        continue;
      }
      if (!mapping.catalogField) {
        skipped.push({ proposalId: proposal.id, targetId, reason: 'No catalog field in mapping' });
        continue;
      }

      const currentValue = currentCustomFields[mapping.catalogField] ?? null;
      const proposedValue = serializeAttributeValue(getEffectiveProposalValue(proposal), mapping.serialization);
      const isNoOp = currentValue === proposedValue;
      const isOverwrite = currentValue !== null && !isNoOp;

      if (seenFields.has(mapping.catalogField)) continue;
      seenFields.add(mapping.catalogField);

      fields.push({ catalogField: mapping.catalogField, currentValue, proposedValue, isOverwrite, isNoOp });
    } else if (proposal.proposalType === 'category_page') {
      const targetId = getEffectiveProposalTargetId(proposal);
      if (!targetId) {
        skipped.push({ proposalId: proposal.id, targetId: null, reason: 'No page target' });
        continue;
      }
      const pv = getEffectiveProposalValue(proposal) as Record<string, unknown> | undefined;
      // Display name comes from the value only — never the Page ID (the
      // target is the stable identity for new proposals).
      const pageName = pageNameFromPageValue(pv);
      const pageId = pv?.pageId ? String(pv.pageId) : null;
      if (verifiedPageIds) {
        // Fail closed: without a verified identity in the active import the
        // page assignment cannot be serialized.
        if (!pageId || !verifiedPageIds.has(pageId)) {
          skipped.push({ proposalId: proposal.id, targetId, reason: 'Page identity unverified' });
          continue;
        }
      }
      if (!pageName) {
        // A verified page without a display name is a visible skip; the Page
        // ID must never be emitted as a page name.
        skipped.push({ proposalId: proposal.id, targetId, reason: 'Page display name missing' });
        continue;
      }
      if (!currentPageNames.includes(pageName) && !proposedPages.includes(pageName)) {
        proposedPages.push(pageName);
      } else {
        skipped.push({ proposalId: proposal.id, targetId, reason: 'Page already assigned' });
      }
    }
  }

  return { fields, pages: { existing: currentPageNames, proposed: proposedPages }, skipped };
}
