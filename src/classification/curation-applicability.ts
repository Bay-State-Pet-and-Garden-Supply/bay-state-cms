import type {
  ClassificationConfig,
  CurationTargetConfig,
  AttributeMappingConfig,
  ProductAttributeConfig,
  ProductTypeConfig,
  AttributeProfileConfig,
} from '../shared/schemas/classification';
import { isUniversalAttribute } from './applicability-evaluator';
import { listCatalogFieldOptions } from './curation-targets';

export interface ProductTypeApplicabilityInfo {
  productTypeId: string;
  productTypeName: string;
  profileId: string;
  required: boolean;
  cardinality: 'single' | 'multiple';
  conditional: boolean;
  applicabilityConditions: unknown[];
}

export type CurationApplicabilityScope = 'universal' | 'profiled' | 'unused' | 'unmapped';

export interface CurationApplicabilitySummary {
  catalogField: string;
  targetId: string | null;
  attributeId: string | null;
  attributeName: string | null;
  valueMode: ProductAttributeConfig['valueMode'] | null;
  canonicalUnit: string | null;
  allowedValuesCount: number;
  historicalValues: string[];
  scope: CurationApplicabilityScope;
  productTypes: ProductTypeApplicabilityInfo[];
}

export type CurationHealthFindingCode =
  | 'target_unused_by_profiles'
  | 'profile_attribute_unmapped'
  | 'product_type_profile_missing'
  | 'profile_attribute_unknown';

export interface CurationHealthFinding {
  code: CurationHealthFindingCode;
  message: string;
  severity: 'warning' | 'error';
  details?: Record<string, unknown>;
}

export interface CurationApplicabilityReport {
  applicability: CurationApplicabilitySummary[];
  findings: CurationHealthFinding[];
}

/**
 * Derives the pure curation applicability matrix and health findings from classification config.
 */
export function deriveCurationApplicability(config: ClassificationConfig): CurationApplicabilityReport {
  const attributeMap = new Map<string, ProductAttributeConfig>(
    config.attributes.map(attr => [attr.id, attr]),
  );

  const profileMap = new Map<string, AttributeProfileConfig>(
    config.attributeProfiles.map(prof => [prof.id, prof]),
  );

  const mappingByCatalogField = new Map<string, AttributeMappingConfig>();
  const mappingByAttributeId = new Map<string, AttributeMappingConfig>();
  for (const mapping of config.attributeMappings) {
    mappingByCatalogField.set(mapping.catalogField, mapping);
    mappingByAttributeId.set(mapping.attributeId, mapping);
  }

  const curationTargets = config.curationTargets ?? [];
  const targetByCatalogField = new Map<string, CurationTargetConfig>();
  for (const target of curationTargets) {
    if (target.kind === 'product_field' && target.catalogField) {
      targetByCatalogField.set(target.catalogField, target);
    }
  }

  const findings: CurationHealthFinding[] = [];

  // Check 1: product_type_profile_missing
  for (const productType of config.productTypes) {
    if (productType.attributeProfileId) {
      const profile = profileMap.get(productType.attributeProfileId);
      if (!profile) {
        findings.push({
          code: 'product_type_profile_missing',
          severity: 'error',
          message: `Product Type "${productType.name}" (${productType.id}) references profile "${productType.attributeProfileId}", which does not exist.`,
          details: { productTypeId: productType.id, profileId: productType.attributeProfileId },
        });
      }
    }
  }

  // Check 2: profile_attribute_unknown & profile_attribute_unmapped
  for (const profile of config.attributeProfiles) {
    for (const entry of profile.attributes) {
      const attr = attributeMap.get(entry.attributeId);
      if (!attr) {
        findings.push({
          code: 'profile_attribute_unknown',
          severity: 'error',
          message: `Attribute Profile "${profile.name}" (${profile.id}) references unknown attribute "${entry.attributeId}".`,
          details: { profileId: profile.id, attributeId: entry.attributeId },
        });
        continue;
      }

      if (!isUniversalAttribute(attr)) {
        const mapping = mappingByAttributeId.get(entry.attributeId);
        if (!mapping) {
          findings.push({
            code: 'profile_attribute_unmapped',
            severity: 'warning',
            message: `Profile "${profile.name}" (${profile.id}) requires attribute "${attr.name}" (${attr.id}), but it has no Catalog Field mapping.`,
            details: { profileId: profile.id, attributeId: entry.attributeId },
          });
        }
      }
    }
  }

  // Gather all unique catalog fields from targets and mappings
  const catalogFields = new Set<string>();
  for (const target of curationTargets) {
    if (target.kind === 'product_field' && target.catalogField) {
      catalogFields.add(target.catalogField);
    }
  }
  for (const mapping of config.attributeMappings) {
    catalogFields.add(mapping.catalogField);
  }

  // Sort catalog fields logically (ProductField1, ProductField2... or alphabetical)
  const sortedCatalogFields = Array.from(catalogFields).sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ''), 10);
    const numB = parseInt(b.replace(/\D/g, ''), 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.localeCompare(b);
  });

  const applicability: CurationApplicabilitySummary[] = [];

  for (const catalogField of sortedCatalogFields) {
    const target = targetByCatalogField.get(catalogField) ?? null;
    const mapping = mappingByCatalogField.get(catalogField) ?? null;
    const attributeId = target?.attributeId ?? mapping?.attributeId ?? null;
    const attribute = attributeId ? (attributeMap.get(attributeId) ?? null) : null;
    const attributeName = attribute?.name ?? null;
    const historicalValues = listCatalogFieldOptions(catalogField, 10);

    if (!mapping || !attribute) {
      applicability.push({
        catalogField,
        targetId: target?.id ?? null,
        attributeId,
        attributeName,
        valueMode: null,
        canonicalUnit: null,
        allowedValuesCount: 0,
        historicalValues,
        scope: 'unmapped',
        productTypes: [],
      });
      continue;
    }

    const valueMode = attribute.valueMode ?? null;
    const canonicalUnit = attribute.canonicalUnit ?? null;
    const allowedValuesCount = attribute.allowedValues?.length ?? 0;

    if (isUniversalAttribute(attribute)) {
      applicability.push({
        catalogField,
        targetId: target?.id ?? null,
        attributeId: attribute.id,
        attributeName: attribute.name,
        valueMode,
        canonicalUnit,
        allowedValuesCount,
        historicalValues,
        scope: 'universal',
        productTypes: [],
      });
      continue;
    }

    // Determine which product types include this attribute in their profile
    const matchingProductTypes: ProductTypeApplicabilityInfo[] = [];

    for (const productType of config.productTypes) {
      if (!productType.attributeProfileId) continue;
      const profile = profileMap.get(productType.attributeProfileId);
      if (!profile) continue; // missing profile handled by health finding

      const profileAttr = profile.attributes.find(a => a.attributeId === attribute.id);
      if (profileAttr) {
        matchingProductTypes.push({
          productTypeId: productType.id,
          productTypeName: productType.name,
          profileId: profile.id,
          required: profileAttr.required ?? false,
          cardinality: profileAttr.cardinality ?? 'single',
          conditional: Array.isArray(profileAttr.applicabilityConditions) && profileAttr.applicabilityConditions.length > 0,
          applicabilityConditions: profileAttr.applicabilityConditions ?? [],
        });
      }
    }

    let scope: CurationApplicabilityScope;
    if (matchingProductTypes.length > 0) {
      scope = 'profiled';
    } else {
      scope = 'unused';
      if (target?.enabled) {
        findings.push({
          code: 'target_unused_by_profiles',
          severity: 'warning',
          message: `Global curation target "${target.label}" (${catalogField}) maps to attribute "${attribute.name}", which is used by 0 Product Type profiles.`,
          details: { catalogField, targetId: target.id, attributeId: attribute.id },
        });
      }
    }

    applicability.push({
      catalogField,
      targetId: target?.id ?? null,
      attributeId: attribute.id,
      attributeName: attribute.name,
      valueMode,
      canonicalUnit,
      allowedValuesCount,
      historicalValues,
      scope,
      productTypes: matchingProductTypes,
    });
  }

  return { applicability, findings };
}
