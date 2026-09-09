import { getDb } from '../db/connection';
import { listRegistry } from '../db/repositories/field-registry-repo';
import { listVerifiedPageOptions } from '../db/repositories/page-repo';
import {
  CurationTargetConfigSchema,
  type ClassificationConfig,
  type CurationTargetConfig,
  type ProductAttributeConfig,
} from '../shared/schemas/classification';
import { canonicalForm } from './controlled-value-identity';

import { composeMerchandisingFieldSpecs } from './merchandising-field-spec';
import { projectCurationFieldCandidates } from './merchandising-field-spec-projections';
import type {
  FieldObservations,
  RegistryMetadata,
  ProductFieldCurationCandidate,
} from '../shared/schemas/merchandising-field-spec';

export type { ProductFieldCurationCandidate };

export interface CurationTargetOption {
  value: string;
  label: string;
}

export interface CurationTargetCandidates {
  productTypes: CurationTargetOption[];
  productFields: ProductFieldCurationCandidate[];
  pages: CurationTargetOption[];
}

function toClassificationSlug(input: string, fallback = 'target'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const safe = slug || fallback;
  return /^[a-z]/.test(safe) ? safe : `${fallback}-${safe}`;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = canonicalForm(String(raw ?? ''));
    if (!value) continue;
    // Deduplicate by canonical form; keep the first occurrence's exact bytes
    // (canonical config already stores the NFC/trimmed representation).
    if (!seen.has(value)) seen.set(value, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}


export function listCatalogFieldOptions(catalogField: string, limit = 250): string[] {
  if (!/^[a-zA-Z0-9_]+$/.test(catalogField)) return [];

  let rows: Array<{ custom_fields: string | null }>;
  try {
    rows = getDb()
      .query('SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != ?')
      .all('') as Array<{ custom_fields: string | null }>;
  } catch {
    return [];
  }

  const values: string[] = [];
  for (const row of rows) {
    if (!row.custom_fields) continue;
    try {
      const customFields = JSON.parse(String(row.custom_fields)) as Record<string, unknown>;
      const raw = customFields[catalogField];
      if (Array.isArray(raw)) {
        for (const value of raw) values.push(String(value));
      } else if (raw !== null && raw !== undefined) {
        values.push(String(raw));
      }
    } catch {
      // Skip malformed product_index rows without failing curation settings.
    }
  }

  // ShopSite multi-select ProductFields serialize multiple selections with a
  // pipe delimiter (e.g. "Dog|Food"). Split these into individual options
  // so managers see discrete values in the curation dropdown.
  const split: string[] = [];
  for (const value of values) {
    if (value.includes('|')) {
      split.push(...value.split('|').map(v => canonicalForm(v)).filter(Boolean));
    } else {
      split.push(canonicalForm(value));
    }
  }

  return uniqueSorted(split).slice(0, limit);
}

/**
 * Discovers every custom ProductField key present in product_index.custom_fields.
 * This complements `field_registry` which may be incomplete for stores where
 * only a subset of fields were captured during sync.
 */
function listDistinctCustomFieldKeys(): string[] {
  const rows = getDb()
    .query("SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != '' AND custom_fields != '{}'")
    .all() as Array<{ custom_fields: string | null }>;

  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.custom_fields) continue;
    try {
      const customFields = JSON.parse(String(row.custom_fields)) as Record<string, unknown>;
      for (const key of Object.keys(customFields)) {
        if (key.startsWith('ProductField')) keys.add(key);
      }
    } catch {
      // Skip malformed rows.
    }
  }
  return [...keys].sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
    return numA - numB || a.localeCompare(b);
  });
}

export function getExplicitCurationTargets(config: ClassificationConfig): CurationTargetConfig[] {
  return [...(config.curationTargets ?? [])]
    .filter(target => target.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

// fallow-ignore-next-line unused-export — used by tests
export function hasExplicitCurationTargets(config: ClassificationConfig): boolean {
  return (config.curationTargets ?? []).length > 0;
}

export function resolveAttributeAllowedValues(
  config: ClassificationConfig,
  attribute: ProductAttributeConfig,
  target: CurationTargetConfig | null,
  limit = 250,
): string[] {
  if (attribute.valueMode !== 'controlled') {
    return [];
  }
  const values = [...attribute.allowedValues];
  if (target?.optionSource === 'live_store' && target.catalogField) {
    values.push(...listCatalogFieldOptions(target.catalogField, limit));
  }
  return uniqueSorted(values).slice(0, limit);
}

export function listCurationTargetCandidates(
  workspaceId: string,
  config: ClassificationConfig,
): CurationTargetCandidates {
  const productTypes = config.productTypes.map(type => ({ value: type.id, label: type.name }));
  // Page candidates are ONLY pages synced from the actual ShopSite database:
  // verified exported_guid identities from the ACTIVE page import. Provisional
  // name-only rows (ProductOnPages fragment scan) are review context and never
  // curation candidates. Distinct GUIDs may share a display name, so collapse
  // name duplicates to a single picker option.
  const seenPageNames = new Set<string>();
  const pages = listVerifiedPageOptions(workspaceId)
    .filter(page => {
      if (seenPageNames.has(page.name)) return false;
      seenPageNames.add(page.name);
      return true;
    })
    .map(page => ({ value: page.name, label: page.name }));
  const rawRegistry = listRegistry(workspaceId);
  const registry: RegistryMetadata[] = rawRegistry.map(entry => ({
    xmlField: entry.xmlField,
    label: entry.label,
    kind: entry.kind,
    dataType: entry.dataType,
    editable: entry.editable,
    required: entry.required,
    uiGroup: entry.uiGroup,
    sampleValuesJson: entry.sampleValuesJson,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));

  // Build a set of fields already covered by the registry so we can discover
  // fields that exist in the live catalog but were never registered during sync.
  const registryFieldNames = new Set(
    registry
      .filter(entry => entry.kind === 'custom' || entry.xmlField.startsWith('ProductField'))
      .map(entry => entry.xmlField),
  );
  const discoveredFieldNames = listDistinctCustomFieldKeys()
    .filter(key => !registryFieldNames.has(key));

  const candidateFields = [
    ...registry.filter(entry => entry.kind === 'custom' || entry.xmlField.startsWith('ProductField')).map(e => e.xmlField),
    ...discoveredFieldNames,
  ];

  const observations: Record<string, FieldObservations> = {};
  for (const fieldName of candidateFields) {
    const mapping = config.attributeMappings.find(m => m.catalogField === fieldName);
    const attribute = mapping ? config.attributes.find(a => a.id === mapping.attributeId) : null;
    const isControlled = attribute ? attribute.valueMode === 'controlled' : true;
    const liveValues = isControlled ? listCatalogFieldOptions(fieldName) : [];
    observations[fieldName] = {
      liveOptions: { status: 'available', data: liveValues },
    };
  }

  const model = composeMerchandisingFieldSpecs({
    configuration: { status: 'complete', config },
    registry: { status: 'available', data: registry },
    discoveredCatalogFields: discoveredFieldNames,
    observations,
  });

  const productFields = projectCurationFieldCandidates(model);

  return { productTypes, productFields, pages };
}

export function applyCurationTargetsToConfig(
  config: ClassificationConfig,
  rawTargets: unknown[],
  workspaceId: string,
): ClassificationConfig {
  const registry = listRegistry(workspaceId);
  const now = new Date().toISOString();

  const normalizedTargets = rawTargets.map((raw, index) => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<CurationTargetConfig>;
    const kind = input.kind ?? 'product_field';
    const fallbackId = kind === 'page'
      ? 'category-pages'
      : kind === 'product_type'
        ? 'primary-product-type'
        : toClassificationSlug(`target-${input.catalogField ?? input.label ?? index}`, 'target');
    const fallbackLabel = kind === 'page'
      ? 'Category Pages'
      : kind === 'product_type'
        ? 'Product Type'
        : String(input.label ?? input.catalogField ?? `Field ${index + 1}`);
    const parsed = CurationTargetConfigSchema.parse({
      ...input,
      id: input.id ?? fallbackId,
      label: input.label ?? fallbackLabel,
      kind,
      sortOrder: input.sortOrder ?? index,
    });

    if (parsed.kind === 'page') {
      return {
        ...parsed,
        catalogField: null,
        attributeId: null,
        optionSource: 'live_store' as const,
      };
    }
    if (parsed.kind === 'product_type') {
      return {
        ...parsed,
        catalogField: null,
        attributeId: null,
        optionSource: 'configured' as const,
        selectionMode: 'single' as const,
      };
    }

    if (!parsed.catalogField) {
      throw new Error(`Product-field curation target "${parsed.label}" is missing catalogField.`);
    }

    // Issue #31 D5: a Curation Target may REFERENCE an existing Attribute
    // Mapping; it may never CREATE one. Targets are manager-facing
    // enablement/option-source decisions, and mapping identity is owned by
    // the mapping editor / preview-activate workflow. A target that names an
    // attribute without a mapping (or a field with no mapping) fails closed
    // instead of silently synthesizing attribute + mapping rows.
    const registryEntry = registry.find(entry => entry.xmlField === parsed.catalogField);
    const label = parsed.label || registryEntry?.label || parsed.catalogField;
    const attributeId = resolveMappedAttributeId(config, parsed, label);
    const targetAttribute = config.attributes.find(a => a.id === attributeId);
    let optionSource = parsed.optionSource;
    if (targetAttribute && targetAttribute.valueMode !== 'controlled') {
      if (input.optionSource === 'live_store') {
        throw new Error(
          `Curation target "${label}" (${parsed.catalogField}) cannot use optionSource 'live_store' because attribute "${targetAttribute.name}" has valueMode '${targetAttribute.valueMode}'.`,
        );
      }
      optionSource = 'configured';
    }

    return {
      ...parsed,
      label,
      attributeId,
      catalogField: parsed.catalogField,
      optionSource,
    };
  });

  return {
    ...config,
    manifest: {
      ...config.manifest,
      updatedAt: now,
      fileVersions: {
        ...(config.manifest.fileVersions ?? {}),
        'curation-targets.json': now,
      },
    },
    curationTargets: normalizedTargets,
  };
}

/**
 * Resolve the attribute a product-field curation target references, requiring
 * an EXISTING attribute mapping (issue #31 D5). A target may reference a
 * mapping by attributeId or by catalogField, but the two must agree: the
 * attribute's mapping field must equal the target's catalogField. No mapping
 * is ever created here.
 */
function resolveMappedAttributeId(
  config: ClassificationConfig,
  target: CurationTargetConfig,
  label: string,
): string {
  const catalogField = target.catalogField as string;
  if (target.attributeId) {
    const mappingByAttribute = config.attributeMappings.find(mapping => mapping.attributeId === target.attributeId);
    if (!mappingByAttribute) {
      throw new Error(
        `Product-field curation target "${label}" references attribute "${target.attributeId}", which has no existing attribute mapping. ` +
          'Curation targets may reference existing mappings but may not create them; configure the mapping in the mapping editor first.',
      );
    }
    if (mappingByAttribute.catalogField !== catalogField) {
      throw new Error(
        `Product-field curation target "${label}" names catalog field "${catalogField}" but attribute "${target.attributeId}" is mapped to "${mappingByAttribute.catalogField}".`,
      );
    }
    return target.attributeId;
  }
  const mappingByField = config.attributeMappings.find(mapping => mapping.catalogField === catalogField);
  if (!mappingByField) {
    throw new Error(
      `Product-field curation target "${label}" references catalog field "${catalogField}", which has no existing attribute mapping. ` +
        'Curation targets may reference existing mappings but may not create them; configure the mapping in the mapping editor first.',
    );
  }
  return mappingByField.attributeId;
}
