/**
 * bay-state-v4 Release Compiler — deterministic bundle → ClassificationConfigBundleV2.
 * Pure, no I/O, byte-identical output for identical input.
 * See docs/plans/classification-v4-activation-and-settings-revamp-plan.md (B.P4.1/B.P4.2) for projection rules.
 */

import {
  ClassificationConfigBundleV2Schema,
  type AttributeMappingConfigV2,
  type AttributeProfileConfigV2,
  type ClassificationBundleOriginV2,
  type ClassificationConfigBundleV2,
  type ClassificationManifestV2,
  type CurationTargetConfigV2,
  type GuidanceConfigV2,
  type ProductAttributeConfigV2,
} from '../shared/schemas/classification';
import { computeClassificationBundleHash } from './config-validation';
import { DEFAULT_LOCAL_VISION_MODEL } from '../shared/vision-model-defaults';
import type { PageAssignmentPolicyV2, TaxonomyReleaseBundleV4, TaxonomyReleaseBundleV5, V4HierarchyNode, V5HierarchyNode } from './release-validation';

/** The revisions that engage the release-compiler runtime path. */
export const V4_TAXONOMY_REVISION = 'bay-state-v4';
export const V5_TAXONOMY_REVISION = 'bay-state-v5';

/** Compiled projection attributes are computed, never human-curated. */
const COMPILED_PROJECTION_ATTRIBUTE_IDS = new Set(['canonical-category-id', 'canonical-breadcrumb']);

/** Runtime view of a compiled release: taxonomy payload + advisory metadata. */
export interface CompiledReleaseBundle extends ClassificationConfigBundleV2 {
  /** Immutable release revision this config was compiled from. */
  readonly taxonomyRevision: string;
  /**
   * Advisory page-assignment rules (NOT injected into assignment candidates or
   * prompts in P4). Surfaced read-only in UI and carried inside snapshots.
   */
  readonly pageAssignmentPolicyAdvisory: PageAssignmentPolicyV2;
}

/** Conservative ML feature policy — identical to the bay-state seed defaults. */
const disabledFeature = () => ({
  state: 'disabled' as const,
  qualificationReceiptDigest: null,
  activatedBy: null,
  activatedAt: null,
});

function sortedById<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Deterministic catalog-field order: numeric suffix first, then field name. */
function compareCatalogFields(a: string, b: string): number {
  const numA = /^ProductField(\d+)$/.exec(a);
  const numB = /^ProductField(\d+)$/.exec(b);
  if (numA && numB) return Number(numA[1]) - Number(numB[1]);
  if (numA) return -1;
  if (numB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compileReleaseInternal(
  bundle: TaxonomyReleaseBundleV4 | TaxonomyReleaseBundleV5,
  extractInvariants: (node: V4HierarchyNode | V5HierarchyNode) => Record<string, string | string[]>,
): CompiledReleaseBundle {
  const facetProfileById = new Map(bundle.facetProfiles.map(profile => [profile.id, profile]));

  // ── Classifiable nodes → Product Types (+ per-node Attribute Profiles) ──
  const classifiableNodes = (bundle.hierarchy as Array<V4HierarchyNode | V5HierarchyNode>)
    .filter(node => node.classifiable)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodeById = new Map(bundle.hierarchy.map(node => [node.id, node]));
  // Issue #350: approved Category per type = nearest non-classifiable
  // ancestor (family/group/department chain). Non-classifiable nodes become
  // the canonical Category entries below.
  const categoryIdFor = (node: V4HierarchyNode | V5HierarchyNode): string => {
    let cursor: V4HierarchyNode | V5HierarchyNode | undefined = node;
    while (cursor?.parentId) {
      const parent = nodeById.get(cursor.parentId);
      if (!parent) break;
      if (!parent.classifiable) return parent.id;
      cursor = parent;
    }
    throw new Error(`Hierarchy node "${node.id}" has no non-classifiable ancestor Category.`);
  };
  const productTypes = classifiableNodes.map(node => ({
    id: node.id,
    name: node.label,
    description: 'description' in node && typeof node.description === 'string' ? node.description : null,
    attributeProfileId: `profile-${node.id}`,
    oldIdAliases: [...node.legacyTypeIds],
    departmentId: node.departmentId,
    categoryId: categoryIdFor(node),
    invariantAttributes: extractInvariants(node),
  }));
  const categories = [...nodeById.values()]
    .filter(node => !node.classifiable)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(node => ({
      id: node.id,
      name: node.label,
      description: 'description' in node && typeof node.description === 'string' ? node.description : null,
      oldIdAliases: [...node.legacyTypeIds],
    }));

  const attributeProfiles: AttributeProfileConfigV2[] = classifiableNodes.map(node => {
    if (!node.facetProfileId) {
      throw new Error(`Classifiable hierarchy node "${node.id}" has no facetProfileId.`);
    }
    const shared = facetProfileById.get(node.facetProfileId);
    if (!shared) {
      throw new Error(`Hierarchy node "${node.id}" references unknown facet profile "${node.facetProfileId}".`);
    }
    return {
      id: `profile-${node.id}`,
      productTypeId: node.id,
      name: shared.name,
      attributes: shared.attributes.map(attribute => ({ ...attribute })),
      oldIdAliases: [...shared.sourceV3ProfileIds],
    };
  });

  // ── Attributes + export mappings: pass through (sorted) ─────────────────
  const attributes: ProductAttributeConfigV2[] = sortedById(bundle.attributes).map(
    attribute => structuredCopyAttribute(attribute),
  );
  const attributeMappings: AttributeMappingConfigV2[] = sortedById(bundle.exportMappings).map(mapping => ({
    ...mapping,
  }));

  // ── Derived curation targets (seed conventions; deterministic order) ─────
  const exportedByField = new Map<string, { attributeId: string; label: string }>();
  for (const attribute of attributes) {
    if (attribute.exportDisposition?.kind !== 'shopsite') continue;
    if (COMPILED_PROJECTION_ATTRIBUTE_IDS.has(attribute.id)) continue;
    exportedByField.set(attribute.exportDisposition.catalogField, {
      attributeId: attribute.id,
      label: attribute.name,
    });
  }
  const curationTargets: CurationTargetConfigV2[] = [
    {
      id: 'primary-product-type',
      kind: 'product_type',
      label: 'Primary Product Type',
      enabled: true,
      mandatory: false,
      selectionMode: 'single',
      attributeId: null,
      catalogField: null,
      optionSource: 'configured',
      required: true,
      sortOrder: 0,
    },
    ...[...exportedByField.entries()]
      .sort(([fieldA], [fieldB]) => compareCatalogFields(fieldA, fieldB))
      .map(([catalogField, entry], index) => ({
        id: `${entry.attributeId}-target`,
        kind: 'product_field' as const,
        label: entry.label,
        enabled: true,
        mandatory: false,
        selectionMode: 'single' as const,
        attributeId: entry.attributeId,
        catalogField,
        optionSource: 'configured' as const,
        required: false,
        sortOrder: 10 + index,
      })),
    {
      id: 'store-pages',
      kind: 'page',
      label: 'Category Pages',
      enabled: true,
      mandatory: false,
      selectionMode: 'multiple',
      attributeId: null,
      catalogField: null,
      optionSource: 'live_store',
      required: false,
      sortOrder: 30,
    },
  ];

  // ── Store-local / default lanes (see module docblock) ────────────────────
  const brands: CompiledReleaseBundle['brands'] = [];
  const guidance: GuidanceConfigV2[] = bundle.guidance.map(entry => ({ ...entry }));
  const modelPolicy: CompiledReleaseBundle['modelPolicy'] = {
    defaultProvider: 'ollama',
    defaultModel: DEFAULT_LOCAL_VISION_MODEL,
    providerLocalities: { ollama: 'local' },
    stageOverrides: {},
    imageDataSharing: 'local_only',
    textDataSharing: 'local_only',
    mlFeatures: {
      productionRetrieval: disabledFeature(),
      pageReranking: disabledFeature(),
      confidenceCalibration: disabledFeature(),
      productionEmbeddings: disabledFeature(),
    },
  };
  const dataSharing: CompiledReleaseBundle['dataSharing'] = {
    imagePolicy: 'local_only',
    textPolicy: 'local_only',
    sensitiveDataFiltering: true,
    retentionDays: 90,
  };

  // ── Manifest (v2 active) + pure-taxonomy bundleHash ──────────────────────
  const bundleOrigin: ClassificationBundleOriginV2 = {
    kind: 'release',
    releaseId: bundle.manifest.releaseId,
    createdAt: bundle.manifest.createdAt,
  };
  const manifestWithoutHash: Omit<ClassificationManifestV2, 'bundleHash'> = {
    schemaVersion: 2,
    compatibilityVersion: 2,
    createdAt: bundle.manifest.createdAt,
    updatedAt: bundle.manifest.createdAt,
    activeRevision: bundle.manifest.revision,
    lifecycle: 'active',
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: {
      kind: 'release',
      releaseId: bundle.manifest.releaseId,
      createdAt: bundle.manifest.createdAt,
    },
    sourceCatalogCommit: null,
    catalogEvidenceHash: null,
    fileVersions: { ...bundle.manifest.fileVersions },
  };

  const candidate = {
    manifest: {
      ...manifestWithoutHash,
      bundleHash: computeClassificationBundleHash(manifestWithoutHash),
    },
    bundleOrigin,
    productTypes,
    categories,
    attributes,
    attributeProfiles,
    attributeMappings,
    curationTargets,
    brands,
    guidance,
    modelPolicy,
    dataSharing,
  };

  // Fail closed BEFORE returning: a compiled bundle that violates the strict
  // v2 contract must never reach the runtime (compile-time self-check).
  const parsed = ClassificationConfigBundleV2Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Compiled bay-state-v4 release failed the v2 bundle schema: ${
        parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      }`,
    );
  }

  return Object.freeze({
    ...(parsed.data as ClassificationConfigBundleV2),
    taxonomyRevision: bundle.manifest.revision,
    pageAssignmentPolicyAdvisory: { ...bundle.pageAssignmentPolicy },
  }) as CompiledReleaseBundle;
}

/**
 * Compile a validated V4 release bundle into the runtime config authority shape.
 * V4 sets invariantAttributes to {} for all product types.
 */
export function compileTaxonomyReleaseV4(bundle: TaxonomyReleaseBundleV4): CompiledReleaseBundle {
  return compileReleaseInternal(bundle, () => ({}));
}

/**
 * Compile a validated V5 release bundle into the runtime config authority shape.
 * V5 extracts invariantAttributes defined on hierarchy nodes.
 */
export function compileTaxonomyReleaseV5(bundle: TaxonomyReleaseBundleV5): CompiledReleaseBundle {
  return compileReleaseInternal(bundle, node => ({ ...((node as V5HierarchyNode).invariantAttributes ?? {}) }));
}

/**
 * Dispatch compilation for V4 or V5 taxonomy release bundle.
 */
export function compileTaxonomyRelease(
  bundle: TaxonomyReleaseBundleV4 | TaxonomyReleaseBundleV5,
): CompiledReleaseBundle {
  if (bundle.manifest.revision === V5_TAXONOMY_REVISION || 'invariantAttributes' in (bundle.hierarchy[0] ?? {})) {
    return compileTaxonomyReleaseV5(bundle as TaxonomyReleaseBundleV5);
  }
  return compileTaxonomyReleaseV4(bundle as TaxonomyReleaseBundleV4);
}

/** Shallow structural copy that preserves the exact v2 attribute shape. */
function structuredCopyAttribute(attribute: ProductAttributeConfigV2): ProductAttributeConfigV2 {
  return {
    ...attribute,
    allowedValues: [...attribute.allowedValues],
    valueAliases: attribute.valueAliases.map(alias => ({ ...alias })),
    evidencePolicy: { ...attribute.evidencePolicy, allowedSources: [...attribute.evidencePolicy.allowedSources] },
    oldIdAliases: [...attribute.oldIdAliases],
    exportDisposition: attribute.exportDisposition
      ? ({ ...attribute.exportDisposition } as ProductAttributeConfigV2['exportDisposition'])
      : undefined,
  };
}

// ─── Canonical page-projection resolution (B.P4.2) ───────────────────────────

export interface CanonicalPageProjection {
  canonicalCategoryId: string;
  canonicalBreadcrumb: string;
}

/**
 * Resolve PF13/PF14 compiled-projection VALUES for one verified Category Page.
 * Deterministic join: verified page name → ratified projection role →
 * hierarchy node → root-to-leaf breadcrumb. Returns null whenever ANY join is
 * missing (unratified page, non-canonical role, dangling node) — the caller
 * omits the attributes, never guesses them (plan B.P4.2).
 *
 * NOTE: consuming these values in proposals/drafts is deliberately NOT wired
 * in P4 (outside the phase's touched files); this is the pure capability the
 * proposal seam will call.
 */
export function resolveCanonicalPageProjections(
  bundle: TaxonomyReleaseBundleV4 | TaxonomyReleaseBundleV5,
  verifiedPageName: string,
): CanonicalPageProjection | null {
  const projection = bundle.pageProjections.find(page => page.pageName === verifiedPageName);
  if (!projection || projection.role !== 'canonical_leaf' || !projection.nodeId) return null;
  const node = bundle.hierarchy.find(candidate => candidate.id === projection.nodeId);
  if (!node || !node.classifiable) return null;

  const chain: string[] = [];
  let cursor = node as (typeof node) | undefined;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor.id)) return null; // cycle guard: omit, never guess
    visited.add(cursor.id);
    chain.unshift(cursor.label);
    cursor = cursor.parentId
      ? bundle.hierarchy.find(candidate => candidate.id === cursor?.parentId)
      : undefined;
  }
  return {
    canonicalCategoryId: node.id,
    canonicalBreadcrumb: chain.join(' > '),
  };
}
