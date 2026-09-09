import type {
  ProductAttributeConfig,
  ProductAttributeConfigV2,
  AttributeProfileConfig,
  AttributeProfileConfigV2,
  AttributeMappingConfig,
  AttributeMappingConfigV2,
  CurationTargetConfig,
  CurationTargetConfigV2,
} from '../shared/schemas/classification';
import type {
  MerchandisingFieldSpecInput,
  MerchandisingFieldReadModel,
  MerchandisingFieldSpec,
  MerchandisingFieldDisplay,
  MerchandisingFieldBinding,
  MerchandisingFieldTargetAssociation,
  MerchandisingFieldObserved,
  MerchandisingFieldConfiguredAttribute,
  MerchandisingFieldProfileContext,
  MerchandisingFieldDiagnostic,
  ProfileContextLookup,
  RegistryMetadata,
  MappingReference,
  FieldOrigin,
  UnmappedAttributeDefinition,
  TargetAssociationReason,
  MerchandisingFieldMappingStatus,
} from '../shared/schemas/merchandising-field-spec';
import {
  canonicalForm,
  canonicalOptions,
  findCanonicalCollisions,
  validateCanonicalValue,
} from './controlled-value-identity';
import { inferValueMode } from './merchandising-field-spec-projections';

function cloneValue<T>(val: T): T {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(cloneValue) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(val)) {
    copy[key] = cloneValue((val as Record<string, unknown>)[key]);
  }
  return copy as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as unknown as T;
  }
  for (const key of Object.keys(value)) {
    const prop = (value as Record<string, unknown>)[key];
    if (prop !== null && typeof prop === 'object') {
      deepFreeze(prop);
    }
  }
  return Object.freeze(value);
}

function parseRegistrySampleValues(sampleValuesJson: string | null | undefined): {
  samples: string[];
  malformed: boolean;
} {
  if (!sampleValuesJson) return { samples: [], malformed: false };
  try {
    const parsed = JSON.parse(sampleValuesJson);
    if (!Array.isArray(parsed)) return { samples: [], malformed: true };
    const result: string[] = [];
    for (const v of parsed) {
      const str = String(v);
      if (str.includes('|')) {
        result.push(...str.split('|').map(s => canonicalForm(s)).filter(Boolean));
      } else {
        const can = canonicalForm(str);
        if (can) result.push(can);
      }
    }
    return { samples: result, malformed: false };
  } catch {
    return { samples: [], malformed: true };
  }
}

export function composeMerchandisingFieldSpecs(
  input: MerchandisingFieldSpecInput,
): MerchandisingFieldReadModel {
  const diagnostics: MerchandisingFieldDiagnostic[] = [];

  // Extract profiles early for provenance and lookups
  let profilesList: Array<AttributeProfileConfig | AttributeProfileConfigV2> = [];
  if (input.configuration.status === 'complete') {
    profilesList = input.configuration.config.attributeProfiles ?? [];
  }

  // 1. Source availability & provenance
  const configKind = input.configuration.status;
  const provenance = {
    configurationKind: configKind,
    sourceAvailability: {
      configuration: input.configuration.status === 'unavailable' ? ('unavailable' as const) : ('available' as const),
      registry: input.registry.status === 'unavailable' ? ('unavailable' as const) : ('available' as const),
      observations: input.observations ? ('available' as const) : ('unavailable' as const),
    },
    knownProfileIds: profilesList.map(p => p.id),
  };

  if (input.configuration.status === 'unavailable') {
    diagnostics.push({
      code: 'source_unavailable',
      message: `Configuration source unavailable: ${input.configuration.reason}`,
    });
  }
  if (input.registry.status === 'unavailable') {
    diagnostics.push({
      code: 'source_unavailable',
      message: `Registry source unavailable: ${input.registry.reason}`,
    });
  }

  // 2. Build index maps from registry
  const registryEntries = input.registry.status === 'available' ? input.registry.data : [];
  const registryByField = new Map<string, RegistryMetadata>();
  for (const entry of registryEntries) {
    if (!registryByField.has(entry.xmlField)) {
      registryByField.set(entry.xmlField, entry);
    }
  }

  // 3. Extract mappings, targets, attributes, profiles from config input
  let allMappings: Array<MappingReference | AttributeMappingConfig | AttributeMappingConfigV2> = [];
  let allTargets: Array<CurationTargetConfig | CurationTargetConfigV2> = [];
  const attributesMap = new Map<string, ProductAttributeConfig | ProductAttributeConfigV2>();

  if (input.configuration.status === 'complete') {
    const config = input.configuration.config;
    allMappings = config.attributeMappings ?? [];
    allTargets = config.curationTargets ?? [];
    for (const attr of config.attributes ?? []) {
      attributesMap.set(attr.id, attr);
    }
  } else if (input.configuration.status === 'references_only') {
    if (input.configuration.mappings.status === 'available') {
      allMappings = [...input.configuration.mappings.data];
    } else {
      diagnostics.push({
        code: 'source_unavailable',
        message: `Attribute mappings slice unavailable: ${input.configuration.mappings.reason}`,
      });
    }
    if (input.configuration.targets.status === 'available') {
      allTargets = [...input.configuration.targets.data];
    } else {
      diagnostics.push({
        code: 'source_unavailable',
        message: `Curation targets slice unavailable: ${input.configuration.targets.reason}`,
      });
    }
  }

  // Group mappings by catalogField (preserving order)
  const mappingsByField = new Map<string, Array<MappingReference | AttributeMappingConfig | AttributeMappingConfigV2>>();
  for (const m of allMappings) {
    const existing = mappingsByField.get(m.catalogField);
    if (existing) {
      existing.push(m);
    } else {
      mappingsByField.set(m.catalogField, [m]);
    }
  }

  // Group targets: direct product_field targets and mapped targets
  const directTargetsByField = new Map<string, Array<CurationTargetConfig | CurationTargetConfigV2>>();
  const targetsByAttributeId = new Map<string, Array<CurationTargetConfig | CurationTargetConfigV2>>();
  for (const t of allTargets) {
    if (t.kind === 'product_field') {
      if (t.catalogField) {
        const existing = directTargetsByField.get(t.catalogField);
        if (existing) {
          existing.push(t);
        } else {
          directTargetsByField.set(t.catalogField, [t]);
        }
      }
      if (t.attributeId) {
        const existing = targetsByAttributeId.get(t.attributeId);
        if (existing) {
          existing.push(t);
        } else {
          targetsByAttributeId.set(t.attributeId, [t]);
        }
      }
    }
  }

  // 4. Construct Field Universe (preserving deterministic ordering)
  const fieldOrder: string[] = [];
  const seenFields = new Set<string>();

  for (const entry of registryEntries) {
    if (!seenFields.has(entry.xmlField)) {
      seenFields.add(entry.xmlField);
      fieldOrder.push(entry.xmlField);
    }
  }

  for (const disc of input.discoveredCatalogFields ?? []) {
    if (!seenFields.has(disc)) {
      seenFields.add(disc);
      fieldOrder.push(disc);
    }
  }

  for (const m of allMappings) {
    if (!seenFields.has(m.catalogField)) {
      seenFields.add(m.catalogField);
      fieldOrder.push(m.catalogField);
    }
  }

  for (const t of allTargets) {
    if (t.kind === 'product_field' && t.catalogField && !seenFields.has(t.catalogField)) {
      seenFields.add(t.catalogField);
      fieldOrder.push(t.catalogField);
    }
  }

  const discoveredSet = new Set(input.discoveredCatalogFields ?? []);

  // 5. Compose each MerchandisingFieldSpec
  const fieldSpecs: MerchandisingFieldSpec[] = [];

  for (const catalogField of fieldOrder) {
    const fieldDiagnostics: MerchandisingFieldDiagnostic[] = [];

    // Determine origins
    const origins: FieldOrigin[] = [];
    if (registryByField.has(catalogField)) origins.push('registry');
    if (discoveredSet.has(catalogField)) origins.push('discovered');
    if (mappingsByField.has(catalogField)) origins.push('mapping');
    if (directTargetsByField.has(catalogField)) origins.push('target');

    // Display
    const regEntry = registryByField.get(catalogField) ?? null;
    let display: MerchandisingFieldDisplay;
    if (input.registry.status === 'unavailable') {
      display = {
        label: catalogField,
        isFallbackLabel: true,
        kind: null,
        dataType: null,
        editable: null,
        required: null,
        uiGroup: null,
        rawRegistryEntry: null,
        registryStatus: 'unavailable',
      };
    } else if (regEntry) {
      const hasLabel = Boolean(regEntry.label && regEntry.label.trim().length > 0);
      display = {
        label: hasLabel ? regEntry.label! : catalogField,
        isFallbackLabel: !hasLabel || regEntry.label === catalogField,
        kind: regEntry.kind,
        dataType: regEntry.dataType,
        editable: regEntry.editable ?? true,
        required: regEntry.required ?? false,
        uiGroup: regEntry.uiGroup ?? null,
        rawRegistryEntry: cloneValue(regEntry),
        registryStatus: 'available',
      };
    } else {
      display = {
        label: catalogField,
        isFallbackLabel: true,
        kind: null,
        dataType: null,
        editable: null,
        required: null,
        uiGroup: null,
        rawRegistryEntry: null,
        registryStatus: 'missing',
      };
      fieldDiagnostics.push({
        code: 'missing_registry_entry',
        message: `Field ${catalogField} not present in registry`,
        catalogField,
      });
    }

    // Bindings
    const fieldMappings = mappingsByField.get(catalogField) ?? [];
    if (fieldMappings.length > 1) {
      const diag: MerchandisingFieldDiagnostic = {
        code: 'ambiguous_mapping',
        message: `Multiple mappings found for field ${catalogField}`,
        catalogField,
      };
      fieldDiagnostics.push(diag);
      diagnostics.push(diag);
    }

    let mappingStatus: MerchandisingFieldMappingStatus;
    if (input.configuration.status === 'unavailable') {
      mappingStatus = 'unavailable';
    } else if (
      input.configuration.status === 'references_only' &&
      input.configuration.mappings.status === 'unavailable'
    ) {
      mappingStatus = 'unavailable';
    } else if (fieldMappings.length === 0) {
      mappingStatus = 'none';
    } else if (fieldMappings.length === 1) {
      mappingStatus = 'unique';
    } else {
      mappingStatus = 'ambiguous';
    }

    const bindings: MerchandisingFieldBinding[] = [];

    for (const m of fieldMappings) {
      let configured: MerchandisingFieldConfiguredAttribute | null = null;
      const profileContexts: MerchandisingFieldProfileContext[] = [];

      let serialization: MerchandisingFieldBinding['serialization'] = { status: 'unknown' };
      if ('serialization' in m && m.serialization) {
        serialization = {
          status: 'available',
          value: cloneValue(m.serialization),
        };
      }

      if (input.configuration.status === 'complete') {
        const attr = attributesMap.get(m.attributeId);
        if (!attr) {
          const diag: MerchandisingFieldDiagnostic = {
            code: 'missing_attribute',
            message: `Mapped attribute ${m.attributeId} not found in configuration`,
            catalogField,
            attributeId: m.attributeId,
            mappingId: m.id,
          };
          fieldDiagnostics.push(diag);
          diagnostics.push(diag);
        } else {
          // Check configured values validity
          let isValid = true;
          if (attr.valueMode === 'controlled') {
            for (const val of attr.allowedValues ?? []) {
              const check = validateCanonicalValue(val);
              if (!check.ok) {
                isValid = false;
                break;
              }
            }
            if (isValid && findCanonicalCollisions(attr.allowedValues ?? []).length > 0) {
              isValid = false;
            }
          }

          if (!isValid) {
            const diag: MerchandisingFieldDiagnostic = {
              code: 'invalid_configured_identity',
              message: `Configured allowed values for attribute ${attr.id} contain collisions or non-canonical values`,
              catalogField,
              attributeId: attr.id,
            };
            fieldDiagnostics.push(diag);
            diagnostics.push(diag);

            configured = {
              attributeId: attr.id,
              name: attr.name,
              description: attr.description ?? null,
              valueMode: attr.valueMode,
              canonicalUnit: attr.canonicalUnit ?? null,
              allowedValues: [...(attr.allowedValues ?? [])],
              canonicalOptions: [],
              valueAliases: cloneValue(attr.valueAliases ?? []),
              exportDisposition: cloneValue('exportDisposition' in attr ? attr.exportDisposition : undefined),
              status: 'invalid_identity',
            };
          } else {
            configured = {
              attributeId: attr.id,
              name: attr.name,
              description: attr.description ?? null,
              valueMode: attr.valueMode,
              canonicalUnit: attr.canonicalUnit ?? null,
              allowedValues: [...(attr.allowedValues ?? [])],
              canonicalOptions: attr.valueMode === 'controlled' ? canonicalOptions(attr.allowedValues ?? []) : [],
              valueAliases: cloneValue(attr.valueAliases ?? []),
              exportDisposition: cloneValue('exportDisposition' in attr ? attr.exportDisposition : undefined),
              status: 'valid',
            };
          }

          // Profile Contexts
          for (const prof of profilesList) {
            const profAttr = prof.attributes.find(a => a.attributeId === attr.id);
            if (profAttr) {
              profileContexts.push({
                profileId: prof.id,
                productTypeId: prof.productTypeId,
                required: profAttr.required,
                cardinality: profAttr.cardinality,
                applicabilityConditions: cloneValue(profAttr.applicabilityConditions ?? []),
                constraints: cloneValue(profAttr.constraints ?? {}),
                confidenceThresholds: cloneValue(profAttr.confidenceThresholds ?? {}),
                valueAliases: cloneValue(profAttr.valueAliases ?? []),
              });
            }
          }
        }
      }

      bindings.push({
        mappingId: m.id,
        attributeId: m.attributeId,
        originalMapping: cloneValue(m),
        isStale: m.isStale ?? false,
        serialization,
        configured,
        profileContexts,
      });
    }

    // Targets association
    // Collect all matching targets preserving source order
    const matchedTargets: MerchandisingFieldTargetAssociation[] = [];
    const directTargets = directTargetsByField.get(catalogField) ?? [];
    const primaryMapping = bindings[0] ?? null;
    const mappedTargets = primaryMapping ? (targetsByAttributeId.get(primaryMapping.attributeId) ?? []) : [];

    // Order from allTargets
    for (const t of allTargets) {
      if (t.kind !== 'product_field') continue;
      const reasons: TargetAssociationReason[] = [];
      const isDirect = directTargets.includes(t);
      const isMapped = mappedTargets.includes(t);

      if (isDirect) reasons.push('direct_catalog_field');
      if (isMapped) reasons.push('mapped_attribute');

      if (reasons.length > 0) {
        matchedTargets.push({
          target: cloneValue(t),
          associationReasons: reasons,
        });

        // Check for inconsistent target reference
        if (isDirect && t.attributeId && primaryMapping && t.attributeId !== primaryMapping.attributeId) {
          const diag: MerchandisingFieldDiagnostic = {
            code: 'inconsistent_target_reference',
            message: `Target ${t.id} references attribute ${t.attributeId} which contradicts mapping attribute ${primaryMapping.attributeId}`,
            catalogField,
            attributeId: t.attributeId,
            targetId: t.id,
            mappingId: primaryMapping.mappingId,
          };
          fieldDiagnostics.push(diag);
          diagnostics.push(diag);
        }
      }
    }

    // Observations
    const obs = input.observations?.[catalogField];
    const liveOptions = obs?.liveOptions ?? { status: 'unavailable' as const, reason: 'not_loaded' as const };
    const rawCatalogStats = obs?.catalogStats ?? null;

    const sampleResult = parseRegistrySampleValues(regEntry?.sampleValuesJson);
    if (sampleResult.malformed) {
      const diag: MerchandisingFieldDiagnostic = {
        code: 'malformed_sample_json',
        message: `Malformed sampleValuesJson for field ${catalogField}`,
        catalogField,
      };
      fieldDiagnostics.push(diag);
      diagnostics.push(diag);
    }

    const inferredDisplayValueMode =
      rawCatalogStats && rawCatalogStats.status === 'available'
        ? inferValueMode(rawCatalogStats.data)
        : 'unknown';

    const observed: MerchandisingFieldObserved = {
      liveOptions: liveOptions.status === 'available' ? { status: 'available', data: [...liveOptions.data] } : cloneValue(liveOptions),
      parsedRegistrySamples: sampleResult.samples,
      rawCatalogStats: rawCatalogStats && rawCatalogStats.status === 'available'
        ? {
            status: 'available',
            data: {
              nonEmptyCount: rawCatalogStats.data.nonEmptyCount,
              distinctCount: rawCatalogStats.data.distinctCount,
              sampleValues: [...rawCatalogStats.data.sampleValues],
              topValues: rawCatalogStats.data.topValues.map(tv => ({ ...tv })),
            },
          }
        : rawCatalogStats ? cloneValue(rawCatalogStats) : rawCatalogStats,
      inferredDisplayValueMode,
    };

    fieldSpecs.push({
      catalogField,
      origins,
      mappingStatus,
      display,
      bindings,
      targets: matchedTargets,
      observed,
      diagnostics: fieldDiagnostics,
    });
  }

  // 6. Unmapped attributes
  const unmappedAttributes: UnmappedAttributeDefinition[] = [];
  if (input.configuration.status === 'complete') {
    const mappedAttrIds = new Set(allMappings.map(m => m.attributeId));
    for (const attr of attributesMap.values()) {
      if (!mappedAttrIds.has(attr.id)) {
        const exportDisp = 'exportDisposition' in attr ? attr.exportDisposition : undefined;
        const profileContexts: MerchandisingFieldProfileContext[] = [];
        for (const prof of profilesList) {
          const profAttr = prof.attributes.find(a => a.attributeId === attr.id);
          if (profAttr) {
            profileContexts.push({
              profileId: prof.id,
              productTypeId: prof.productTypeId,
              required: profAttr.required,
              cardinality: profAttr.cardinality,
              applicabilityConditions: cloneValue(profAttr.applicabilityConditions ?? []),
              constraints: cloneValue(profAttr.constraints ?? {}),
              confidenceThresholds: cloneValue(profAttr.confidenceThresholds ?? {}),
              valueAliases: cloneValue(profAttr.valueAliases ?? []),
            });
          }
        }

        if (exportDisp && exportDisp.kind === 'not_exported') {
          unmappedAttributes.push({
            attributeId: attr.id,
            name: attr.name,
            valueMode: attr.valueMode,
            exportDisposition: cloneValue(exportDisp),
            reason: 'intentionally_not_exported',
            profileContexts,
          });
        } else {
          diagnostics.push({
            code: 'unmapped_attribute',
            message: `Attribute ${attr.id} has no catalog field mapping`,
            attributeId: attr.id,
          });
          unmappedAttributes.push({
            attributeId: attr.id,
            name: attr.name,
            valueMode: attr.valueMode,
            exportDisposition: cloneValue(exportDisp),
            reason: 'mapping_missing',
            profileContexts,
          });
        }
      }
    }
  }

  const model: MerchandisingFieldReadModel = {
    fieldSpecs,
    provenance,
    unmappedAttributes,
    diagnostics,
  };

  return deepFreeze(model);
}

export function getMerchandisingFieldSpec(
  model: MerchandisingFieldReadModel,
  catalogField: string,
): MerchandisingFieldSpec | null {
  for (const spec of model.fieldSpecs) {
    if (spec.catalogField === catalogField) {
      return spec;
    }
  }
  return null;
}

export function listMerchandisingFieldSpecsForAttribute(
  model: MerchandisingFieldReadModel,
  attributeId: string,
): readonly MerchandisingFieldSpec[] {
  const result: MerchandisingFieldSpec[] = [];
  for (const spec of model.fieldSpecs) {
    const hasBinding = spec.bindings.some(b => b.attributeId === attributeId);
    const hasTarget = spec.targets.some(t => t.target.attributeId === attributeId);
    if (hasBinding || hasTarget) {
      result.push(spec);
    }
  }
  return result;
}

function contextsEqual(a: MerchandisingFieldProfileContext, b: MerchandisingFieldProfileContext): boolean {
  return (
    a.profileId === b.profileId &&
    a.productTypeId === b.productTypeId &&
    a.required === b.required &&
    a.cardinality === b.cardinality &&
    JSON.stringify(a.applicabilityConditions) === JSON.stringify(b.applicabilityConditions) &&
    JSON.stringify(a.constraints) === JSON.stringify(b.constraints) &&
    JSON.stringify(a.confidenceThresholds) === JSON.stringify(b.confidenceThresholds) &&
    JSON.stringify(a.valueAliases) === JSON.stringify(b.valueAliases)
  );
}

export function getMerchandisingFieldProfileContext(
  model: MerchandisingFieldReadModel,
  query: { readonly attributeId: string; readonly profileId: string },
): ProfileContextLookup {
  if (model.provenance.configurationKind !== 'complete') {
    return {
      status: 'unavailable',
      reason: 'Configuration or profile definitions not loaded in complete mode',
    };
  }

  // 1. Determine if the profile exists in the complete configuration
  const knownProfileIds = new Set<string>(model.provenance.knownProfileIds ?? []);
  if (knownProfileIds.size === 0) {
    for (const spec of model.fieldSpecs) {
      for (const binding of spec.bindings) {
        for (const ctx of binding.profileContexts) {
          knownProfileIds.add(ctx.profileId);
        }
      }
    }
    for (const unmapped of model.unmappedAttributes) {
      for (const ctx of unmapped.profileContexts) {
        knownProfileIds.add(ctx.profileId);
      }
    }
  }

  if (!knownProfileIds.has(query.profileId)) {
    return { status: 'profile_missing' };
  }

  // 2. Collect candidate profile contexts for this attribute from mapped bindings and unmapped attributes
  const candidateMatches: MerchandisingFieldProfileContext[] = [];

  for (const spec of model.fieldSpecs) {
    for (const binding of spec.bindings) {
      if (binding.attributeId === query.attributeId) {
        for (const ctx of binding.profileContexts) {
          if (ctx.profileId === query.profileId) {
            candidateMatches.push(ctx);
          }
        }
      }
    }
  }

  for (const unmapped of model.unmappedAttributes) {
    if (unmapped.attributeId === query.attributeId) {
      for (const ctx of unmapped.profileContexts) {
        if (ctx.profileId === query.profileId) {
          candidateMatches.push(ctx);
        }
      }
    }
  }

  // 3. Deduplicate identical contexts (e.g. multiple mappings for the same attribute)
  const uniqueMatches: MerchandisingFieldProfileContext[] = [];
  for (const match of candidateMatches) {
    if (!uniqueMatches.some(existing => contextsEqual(existing, match))) {
      uniqueMatches.push(match);
    }
  }

  if (uniqueMatches.length === 1) {
    return { status: 'found', context: uniqueMatches[0] };
  }
  if (uniqueMatches.length > 1) {
    return { status: 'ambiguous', matches: uniqueMatches };
  }

  return { status: 'not_in_profile' };
}
