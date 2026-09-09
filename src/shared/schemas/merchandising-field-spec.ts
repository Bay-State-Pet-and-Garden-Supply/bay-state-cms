import { z } from 'zod';
import type { FieldRegistryEntry } from './field-registry';
import type {
  ClassificationConfig,
  ClassificationConfigBundleV2,
  AttributeMappingConfig,
  AttributeMappingConfigV2,
  CurationTargetConfig,
  CurationTargetConfigV2,
  SerializationConfig,
  SerializationConfigV2,
  ValueMode,
  Cardinality,
  ExportDispositionV2,
} from './classification';

// ── Read Slices ─────────────────────────────────────────────────────────────

export type ReadSliceUnavailableReason = 'not_loaded' | 'source_failed' | 'invalid_payload';

export const ReadSliceUnavailableReasonSchema = z.enum([
  'not_loaded',
  'source_failed',
  'invalid_payload',
]);

export type ReadSlice<T> =
  | { readonly status: 'available'; readonly data: readonly T[] }
  | { readonly status: 'unavailable'; readonly reason: ReadSliceUnavailableReason };

export type SingleReadSlice<T> =
  | { readonly status: 'available'; readonly data: T }
  | { readonly status: 'unavailable'; readonly reason: ReadSliceUnavailableReason };

// ── Registry Metadata (Browser-Safe Projection) ─────────────────────────────

export interface RegistryMetadata {
  readonly xmlField: string;
  readonly label: string | null;
  readonly kind: 'core' | 'system' | 'custom' | string;
  readonly dataType: FieldRegistryEntry['dataType'] | string;
  readonly editable?: boolean;
  readonly required?: boolean;
  readonly uiGroup?: string | null;
  readonly sampleValuesJson?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export const RegistryMetadataSchema = z.object({
  xmlField: z.string().min(1),
  label: z.string().nullable(),
  kind: z.string(),
  dataType: z.string(),
  editable: z.boolean().optional().default(true),
  required: z.boolean().optional().default(false),
  uiGroup: z.string().nullable().optional().default(null),
  sampleValuesJson: z.string().nullable().optional().default(null),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// ── Mapping Reference ───────────────────────────────────────────────────────

export interface MappingReference {
  readonly id?: string;
  readonly attributeId: string;
  readonly catalogField: string;
  readonly isStale?: boolean;
}

export const MappingReferenceSchema = z.object({
  id: z.string().optional(),
  attributeId: z.string().min(1),
  catalogField: z.string().min(1),
  isStale: z.boolean().optional().default(false),
});

// ── Observations ────────────────────────────────────────────────────────────

export interface CatalogFieldStatsObservation {
  readonly nonEmptyCount: number;
  readonly distinctCount: number;
  readonly sampleValues: readonly string[];
  readonly topValues: readonly { readonly value: string; readonly frequency: number }[];
}

export const CatalogFieldStatsObservationSchema = z.object({
  nonEmptyCount: z.number().int().nonnegative(),
  distinctCount: z.number().int().nonnegative(),
  sampleValues: z.array(z.string()),
  topValues: z.array(
    z.object({
      value: z.string(),
      frequency: z.number().int().nonnegative(),
    }),
  ),
});

export interface FieldObservations {
  readonly liveOptions: ReadSlice<string>;
  readonly catalogStats?: SingleReadSlice<CatalogFieldStatsObservation> | null;
}

// ── Seam Input Contracts ───────────────────────────────────────────────────

export type ConfigurationReadInput =
  | {
      readonly status: 'complete';
      readonly config: ClassificationConfig | ClassificationConfigBundleV2;
    }
  | {
      readonly status: 'references_only';
      readonly mappings: ReadSlice<MappingReference>;
      readonly targets: ReadSlice<CurationTargetConfig | CurationTargetConfigV2>;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: ReadSliceUnavailableReason;
    };

export interface MerchandisingFieldSpecInput {
  readonly configuration: ConfigurationReadInput;
  readonly registry: ReadSlice<RegistryMetadata>;
  readonly discoveredCatalogFields?: readonly string[];
  readonly observations?: Readonly<Record<string, FieldObservations>>;
}

// ── Diagnostics ────────────────────────────────────────────────────────────

export type MerchandisingFieldDiagnosticCode =
  | 'source_unavailable'
  | 'missing_registry_entry'
  | 'missing_attribute'
  | 'unmapped_attribute'
  | 'ambiguous_mapping'
  | 'inconsistent_target_reference'
  | 'malformed_sample_json'
  | 'invalid_configured_identity';

export interface MerchandisingFieldDiagnostic {
  readonly code: MerchandisingFieldDiagnosticCode;
  readonly message: string;
  readonly catalogField?: string;
  readonly attributeId?: string;
  readonly mappingId?: string;
  readonly profileId?: string;
  readonly targetId?: string;
}

// ── Composed Read-Model Contracts ──────────────────────────────────────────

export interface MerchandisingFieldDisplay {
  readonly label: string;
  readonly isFallbackLabel: boolean;
  readonly kind: 'core' | 'system' | 'custom' | string | null;
  readonly dataType: FieldRegistryEntry['dataType'] | string | null;
  readonly editable: boolean | null;
  readonly required: boolean | null;
  readonly uiGroup: string | null;
  readonly rawRegistryEntry: RegistryMetadata | null;
  readonly registryStatus: 'available' | 'missing' | 'unavailable';
}

export interface MerchandisingFieldConfiguredAttribute {
  readonly attributeId: string;
  readonly name: string;
  readonly description: string | null;
  readonly valueMode: ValueMode;
  readonly canonicalUnit: string | null;
  readonly allowedValues: readonly string[];
  readonly canonicalOptions: readonly { readonly value: string; readonly label: string }[];
  readonly valueAliases: readonly { readonly alias: string; readonly mapsTo: string }[];
  readonly exportDisposition?: ExportDispositionV2;
  readonly status: 'valid' | 'invalid_identity' | 'missing_definition' | 'unavailable';
}

export interface MerchandisingFieldProfileContext {
  readonly profileId: string;
  readonly productTypeId: string;
  readonly required: boolean;
  readonly cardinality: Cardinality;
  readonly applicabilityConditions: readonly unknown[];
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly confidenceThresholds: Readonly<Record<string, number>>;
  readonly valueAliases: readonly { readonly alias: string; readonly mapsTo: string }[];
}

export type ProfileContextLookup =
  | { readonly status: 'found'; readonly context: MerchandisingFieldProfileContext }
  | { readonly status: 'not_in_profile' }
  | { readonly status: 'profile_missing' }
  | { readonly status: 'ambiguous'; readonly matches: readonly MerchandisingFieldProfileContext[] }
  | { readonly status: 'unavailable'; readonly reason: string };

export type SerializationAvailability =
  | { readonly status: 'available'; readonly value: SerializationConfig | SerializationConfigV2 }
  | { readonly status: 'unknown' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface MerchandisingFieldBinding {
  readonly mappingId?: string;
  readonly attributeId: string;
  readonly originalMapping: MappingReference | AttributeMappingConfig | AttributeMappingConfigV2;
  readonly isStale: boolean;
  readonly serialization: SerializationAvailability;
  readonly configured: MerchandisingFieldConfiguredAttribute | null;
  readonly profileContexts: readonly MerchandisingFieldProfileContext[];
}

export type TargetAssociationReason = 'direct_catalog_field' | 'mapped_attribute';

export interface MerchandisingFieldTargetAssociation {
  readonly target: CurationTargetConfig | CurationTargetConfigV2;
  readonly associationReasons: readonly TargetAssociationReason[];
}

export interface MerchandisingFieldObserved {
  readonly liveOptions: ReadSlice<string>;
  readonly parsedRegistrySamples: readonly string[];
  readonly rawCatalogStats: SingleReadSlice<CatalogFieldStatsObservation> | null;
  readonly inferredDisplayValueMode: 'controlled' | 'freeText' | 'measured' | 'unknown';
}

export type MerchandisingFieldMappingStatus = 'none' | 'unique' | 'ambiguous' | 'unavailable';

export type FieldOrigin = 'registry' | 'discovered' | 'mapping' | 'target';

export interface MerchandisingFieldSpec {
  readonly catalogField: string;
  readonly origins: readonly FieldOrigin[];
  readonly mappingStatus: MerchandisingFieldMappingStatus;
  readonly display: MerchandisingFieldDisplay;
  readonly bindings: readonly MerchandisingFieldBinding[];
  readonly targets: readonly MerchandisingFieldTargetAssociation[];
  readonly observed: MerchandisingFieldObserved;
  readonly diagnostics: readonly MerchandisingFieldDiagnostic[];
}

export interface UnmappedAttributeDefinition {
  readonly attributeId: string;
  readonly name: string;
  readonly valueMode: ValueMode;
  readonly exportDisposition?: ExportDispositionV2;
  readonly reason: 'intentionally_not_exported' | 'mapping_missing' | 'mappings_unavailable';
  readonly profileContexts: readonly MerchandisingFieldProfileContext[];
}

export interface MerchandisingFieldProvenance {
  readonly configurationKind: 'complete' | 'references_only' | 'unavailable';
  readonly sourceAvailability: {
    readonly configuration: 'available' | 'unavailable';
    readonly registry: 'available' | 'unavailable';
    readonly observations: 'available' | 'unavailable';
  };
  readonly knownProfileIds?: readonly string[];
}

export interface MerchandisingFieldReadModel {
  readonly fieldSpecs: readonly MerchandisingFieldSpec[];
  readonly provenance: MerchandisingFieldProvenance;
  readonly unmappedAttributes: readonly UnmappedAttributeDefinition[];
  readonly diagnostics: readonly MerchandisingFieldDiagnostic[];
}

// ── Shared Compatibility DTOs ──────────────────────────────────────────────

export interface CatalogFieldSummary {
  xmlField: string;
  label: string;
  kind: 'core' | 'system' | 'custom';
  dataType: FieldRegistryEntry['dataType'];
  uiGroup: string | null;
  nonEmptyCount: number;
  distinctCount: number;
  inferredValueMode: 'controlled' | 'freeText' | 'measured' | 'unknown';
  mappedAttributeId: string | null;
  isCurationTarget: boolean;
  isStale: boolean;
  warning: string | null;
}

export const CatalogFieldSummarySchema = z.object({
  xmlField: z.string(),
  label: z.string(),
  kind: z.enum(['core', 'system', 'custom']),
  dataType: z.enum(['string', 'number', 'boolean', 'html', 'image', 'list', 'raw_xml']),
  uiGroup: z.string().nullable(),
  nonEmptyCount: z.number(),
  distinctCount: z.number(),
  inferredValueMode: z.enum(['controlled', 'freeText', 'measured', 'unknown']),
  mappedAttributeId: z.string().nullable(),
  isCurationTarget: z.boolean(),
  isStale: z.boolean(),
  warning: z.string().nullable(),
});

export interface ProductFieldCurationCandidate {
  catalogField: string;
  label: string;
  dataType: string;
  values: string[];
  target: CurationTargetConfig | CurationTargetConfigV2 | null;
  attributeId: string | null;
}

export const ProductFieldCurationCandidateSchema = z.object({
  catalogField: z.string(),
  label: z.string(),
  dataType: z.string(),
  values: z.array(z.string()),
  target: z.unknown().nullable(),
  attributeId: z.string().nullable(),
});
