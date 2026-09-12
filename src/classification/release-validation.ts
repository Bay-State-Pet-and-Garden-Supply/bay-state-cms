/**
 * Taxonomy Release Validation (P2 — hard gate for the immutable release).
 *
 * The taxonomy release under `src/classification/releases/<releaseId>/` is a
 * set-in-stone artifact: a broken release must be IMPOSSIBLE to load. This
 * module is the deterministic gate. `validateTaxonomyRelease` returns a
 * structured report; `loadTaxonomyRelease` / `assertReleaseValid` fail closed
 * (throw `ReleaseValidationError`, code `release_invalid`) whenever any
 * `error`-severity finding exists.
 *
 * The runtime loader is NOT switched to the release yet (that is the next
 * phase, P3). This module is purely additive so the workspace v2 bundle
 * loader and every existing consumer keep working unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  AttributesFileV2Schema,
  AttributeProfilesFileV2Schema,
  AttributeMappingsFileV2Schema,
  AttributeProfileAttributeV2Schema,
  DepartmentsFileV2Schema,
  GuidanceFileV2Schema,
  ProductTypesFileV2Schema,
  Sha256HexSchema,
  StrictIsoDateTimeStringSchema,
  ClassificationSlugSchema,
  ClassificationBundleOriginV2Schema,
  type AttributeProfileConfigV2,
  type ClassificationBundleOriginV2,
  type DepartmentConfigV2,
  type GuidanceConfigV2,
  type ProductAttributeConfigV2,
  type AttributeMappingConfigV2,
  type ProductTypeConfigV2,
} from '../shared/schemas/classification';

// ─── Release manifest (release-specific, not ClassificationManifestV2) ────────

export const TaxonomyReleaseManifestSchema = z.object({
  releaseId: ClassificationSlugSchema,
  revision: z.string().min(1),
  createdAt: StrictIsoDateTimeStringSchema,
  schemaVersion: z.literal(2),
  compatibilityVersion: z.literal(2),
  lifecycle: z.literal('release'),
  sourceBaseline: z.string().min(1),
  fileVersions: z.record(z.string(), Sha256HexSchema),
  counts: z.object({
    productTypes: z.number().int(),
    attributes: z.number().int(),
    attributeProfiles: z.number().int(),
    departments: z.number().int(),
    mappings: z.number().int(),
    guidance: z.number().int(),
  }),
}).strict();
export type TaxonomyReleaseManifest = z.infer<typeof TaxonomyReleaseManifestSchema>;

/** Page-assignment policy file (release-specific shape). */
export const PageAssignmentPolicyV2Schema = z.object({
  schemaVersion: z.literal(1),
  maxPagesPerProduct: z.number().int().positive(),
  preferSpecificOverShopAll: z.boolean(),
  crossSpeciesBlocked: z.boolean(),
  allowedSpecies: z.array(z.string()).min(1),
  notes: z.string().nullable().optional(),
}).strict();
export type PageAssignmentPolicyV2 = z.infer<typeof PageAssignmentPolicyV2Schema>;

// ─── v4 canonical-hierarchy release schemas ─────────────────────────────────────

/**
 * v4 hierarchy node (bay-state-v4). SEMANTICALLY RAGGED depth (ChatGPT v4
 * review): L1 department roots (parentId null, classifiable false), browse
 * nodes (species/dimension: dog, cat, pet-health-wellness) and family nodes
 * (dog-food, cat-food, wild-bird, fish) — all classifiable false — plus 74
 * classifiable leaf nodes (73 migrated v3 types plus native fish-food).
 */
export const V4HierarchyNodeSchema = z.object({
  id: ClassificationSlugSchema,
  label: z.string().min(1),
  parentId: ClassificationSlugSchema.nullable(),
  classifiable: z.boolean(),
  facetProfileId: ClassificationSlugSchema.nullable(),
  departmentId: ClassificationSlugSchema,
  legacyTypeIds: z.array(ClassificationSlugSchema),
  derivation: z.enum(['department', 'group', 'family', 'type_1to1', 'type_native']),
  scope: z.object({ animalDomain: ClassificationSlugSchema }).strict().nullable().optional(),
}).strict();
export type V4HierarchyNode = z.infer<typeof V4HierarchyNodeSchema>;

export const V4HierarchySchema = z.object({
  schemaVersion: z.literal(2),
  bundleOrigin: ClassificationBundleOriginV2Schema,
  entries: z.array(V4HierarchyNodeSchema),
}).strict();

/**
 * v5 canonical taxonomy hierarchy node.
 * Adds `invariantAttributes` on classifiable leaf nodes.
 */
export const V5HierarchyNodeSchema = z.object({
  id: ClassificationSlugSchema,
  label: z.string().min(1),
  parentId: ClassificationSlugSchema.nullable(),
  classifiable: z.boolean(),
  facetProfileId: ClassificationSlugSchema.nullable(),
  departmentId: ClassificationSlugSchema,
  legacyTypeIds: z.array(ClassificationSlugSchema),
  derivation: z.enum(['department', 'group', 'family', 'type_1to1', 'type_native']),
  scope: z.object({ animalDomain: ClassificationSlugSchema }).strict().nullable().optional(),
  invariantAttributes: z
    .record(ClassificationSlugSchema, z.union([z.string(), z.array(z.string()).nonempty()]))
    .optional()
    .default(() => ({})),
}).strict();
export type V5HierarchyNode = z.infer<typeof V5HierarchyNodeSchema>;

export const V5HierarchySchema = z.object({
  schemaVersion: z.literal(2),
  bundleOrigin: ClassificationBundleOriginV2Schema,
  entries: z.array(V5HierarchyNodeSchema),
}).strict();

/** v4 shared facet profile (deduplicated from v3 attribute profiles by
 *  behavioral fingerprint; carries provenance + blast radius). */
export const V4FacetProfileSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  attributes: z.array(AttributeProfileAttributeV2Schema),
  sourceV3ProfileIds: z.array(ClassificationSlugSchema),
  canonicalNodeIds: z.array(ClassificationSlugSchema),
  behaviorFingerprint: z.string().min(8),
}).strict();
export type V4FacetProfile = z.infer<typeof V4FacetProfileSchema>;

export const V4FacetProfilesSchema = z.object({
  schemaVersion: z.literal(2),
  bundleOrigin: ClassificationBundleOriginV2Schema,
  entries: z.array(V4FacetProfileSchema),
}).strict();

/** v4 legacy-mapping entry — discriminated on `kind`. */
export const V4TypeMigrationEntrySchema = z.object({
  id: ClassificationSlugSchema,
  kind: z.literal('type_migration'),
  v3TypeId: ClassificationSlugSchema,
  targetNodeId: ClassificationSlugSchema,
  disposition: z.enum([
    'preserve_as_node',
    'merge',
    'split',
    'alias',
    'retire_to_attribute',
    'manual_review',
  ]),
  rationale: z.string().min(1),
}).strict();
export type V4TypeMigrationEntry = z.infer<typeof V4TypeMigrationEntrySchema>;

export const V4ProfileMapEntrySchema = z.object({
  id: ClassificationSlugSchema,
  kind: z.literal('profile_map'),
  v3ProfileId: ClassificationSlugSchema,
  v4ProfileId: ClassificationSlugSchema,
  v3Fingerprint: z.string().min(8),
  v4Fingerprint: z.string().min(8),
  equivalent: z.boolean(),
}).strict();
export type V4ProfileMapEntry = z.infer<typeof V4ProfileMapEntrySchema>;

export const V4LegacyMappingSchema = z.discriminatedUnion('kind', [
  V4TypeMigrationEntrySchema,
  V4ProfileMapEntrySchema,
]);
export type V4LegacyMapping = z.infer<typeof V4LegacyMappingSchema>;

export const V4LegacyMappingsSchema = z.object({
  schemaVersion: z.literal(2),
  bundleOrigin: ClassificationBundleOriginV2Schema,
  entries: z.array(V4LegacyMappingSchema),
}).strict();

/** v4 ShopSite page projection roles. */
export const V4PageRoleEnum = z.enum([
  'canonical_leaf',
  'canonical_browse',
  'shop_all_aggregate',
  'merchandising',
  'navigation',
  'needs_review',
]);
export type V4PageRole = z.infer<typeof V4PageRoleEnum>;

export const V4PageProjectionSchema = z.object({
  pageName: z.string().min(1),
  role: V4PageRoleEnum,
  nodeId: ClassificationSlugSchema.nullable(),
  childPages: z.array(z.string()),
  facetProfileId: ClassificationSlugSchema.nullable(),
  productCount: z.number().int().nonnegative(),
}).strict();
export type V4PageProjection = z.infer<typeof V4PageProjectionSchema>;

export const V4ShopsiteProjectionSchema = z.object({
  schemaVersion: z.literal(2),
  bundleOrigin: ClassificationBundleOriginV2Schema,
  entries: z.array(V4PageProjectionSchema),
}).strict();

/** v4 release manifest (schemaVersion 3 — the hybrid hierarchy release). */
export const V4ManifestSchema = z.object({
  releaseId: ClassificationSlugSchema,
  revision: ClassificationSlugSchema,
  createdAt: StrictIsoDateTimeStringSchema,
  schemaVersion: z.literal(3),
  compatibilityVersion: z.literal(3),
  lifecycle: z.literal('release'),
  sourceBaseline: z.string().min(1),
  fileVersions: z.record(z.string(), Sha256HexSchema),
  counts: z.object({
    nodes: z.number().int(),
    departments: z.number().int(),
    types: z.number().int(),
    nativeLeaves: z.number().int().nonnegative(),
    attributes: z.number().int(),
    facetProfiles: z.number().int(),
    pages: z.number().int(),
    mappings: z.number().int(),
  }),
  notes: z.array(z.string()).default([]),
}).strict();
export type V4Manifest = z.infer<typeof V4ManifestSchema>;

// ─── Report / error types ──────────────────────────────────────────────────────

export interface ReleaseValidationFinding {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ReleaseValidationReport {
  ok: boolean;
  findings: ReleaseValidationFinding[];
  counts: {
    productTypes: number;
    attributes: number;
    attributeProfiles: number;
    departments: number;
    mappings: number;
  };
  /** Shared-profile blast radius (v4): each profile with >1 consuming node. */
  profileBlastRadii: Array<{ profileId: string; nodeCount: number; nodeIds: string[] }>;
}

export class ReleaseValidationError extends Error {
  readonly code = 'release_invalid' as const;
  readonly report: ReleaseValidationReport;

  constructor(message: string, report: ReleaseValidationReport) {
    super(message);
    this.name = 'ReleaseValidationError';
    this.report = report;
  }
}

// ─── Structured release bundle ─────────────────────────────────────────────────

export interface TaxonomyReleaseBundle {
  manifest: TaxonomyReleaseManifest;
  departments: DepartmentConfigV2[];
  productTypes: ProductTypeConfigV2[];
  attributes: ProductAttributeConfigV2[];
  attributeProfiles: AttributeProfileConfigV2[];
  exportMappings: AttributeMappingConfigV2[];
  guidance: GuidanceConfigV2[];
  pageAssignmentPolicy: PageAssignmentPolicyV2;
}

// ─── v4 structured release bundle ───────────────────────────────────────────────

export interface TaxonomyReleaseBundleV4 {
  manifest: V4Manifest;
  hierarchy: V4HierarchyNode[];
  facetProfiles: V4FacetProfile[];
  legacyMappings: V4LegacyMapping[];
  attributes: ProductAttributeConfigV2[];
  exportMappings: AttributeMappingConfigV2[];
  pageProjections: V4PageProjection[];
  guidance: GuidanceConfigV2[];
  pageAssignmentPolicy: PageAssignmentPolicyV2;
}

// ─── v5 structured release bundle ───────────────────────────────────────────────

export interface TaxonomyReleaseBundleV5 {
  manifest: V4Manifest;
  hierarchy: V5HierarchyNode[];
  facetProfiles: V4FacetProfile[];
  legacyMappings: V4LegacyMapping[];
  attributes: ProductAttributeConfigV2[];
  exportMappings: AttributeMappingConfigV2[];
  pageProjections: V4PageProjection[];
  guidance: GuidanceConfigV2[];
  pageAssignmentPolicy: PageAssignmentPolicyV2;
}

// ─── Path helpers ──────────────────────────────────────────────────────────────

/**
 * True when a value is a valid taxonomy release id / revision / department id:
 * lowercase kebab-case (letters, digits, single hyphens), e.g. `bay-state-v3`.
 * Used to validate `activeTaxonomyRevision`-style identifiers before they are
 * resolved to a directory (path-traversal guard at the loader boundary).
 */
export function isValidReleaseId(id: string): boolean {
  return SLUG_RELEASE_ID_RE.test(id);
}

/**
 * Resolve a release directory name or absolute path under src/classification/releases.
 * Relative release ids are resolved inside the releases root and must NOT escape
 * it (`../` traversal is rejected). Absolute paths (temp copies used by tests,
 * or an explicit checked-in path) pass through unchanged.
 */
export function resolveReleaseDir(releaseDir: string): string {
  if (path.isAbsolute(releaseDir)) return releaseDir;
  const releasesRoot = path.resolve(__dirname, 'releases');
  const dir = path.resolve(releasesRoot, releaseDir);
  const relative = path.relative(releasesRoot, dir);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Release directory "${releaseDir}" resolves outside the releases root.`);
  }
  return dir;
}

const RELEASE_FILES = [
  'manifest.json',
  'departments.json',
  'product-types.json',
  'attributes.json',
  'attribute-profiles.json',
  'export-mappings.json',
  'guidance.json',
  'page-assignment-policy.json',
] as const;

function sha256OfFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ─── P2 disposition codification helpers ──────────────────────────────────────

/**
 * P2 rule b — exported ⇔ proposer fail-closed rule.
 *
 * An attribute whose exportDisposition.kind is 'shopsite' MUST have at least
 * one proposer, where a proposer is either:
 *  - facet/profile membership (≥1 profile lists the attribute), or
 *  - `isUniversal === true` (universal attributes flow through the
 *    universal-tier proposers regardless of Product Type).
 *
 * Rationale (plan section B.P2.1 / D): an EXPORTED attribute nobody proposes
 * is dead weight and masks coverage gaps. Promoting one of the retired
 * `not_exported` attributes to `shopsite` without granting profile membership
 * in the SAME release therefore fails closed — reactivation can never
 * half-happen. Committed releases stay valid because every mapped-but-
 * profile-less attribute (`brand`, `product-type`, and the two canonical
 * compiled projections) carries `isUniversal: true`.
 */
function assertExportedAttributesHaveProposers(
  fail: (code: string, message: string) => void,
  attributes: Array<{ id: string; isUniversal?: boolean; exportDisposition?: { kind: string } | undefined }>,
  profileMembershipIds: ReadonlySet<string>,
): void {
  for (const attr of attributes) {
    if (attr.exportDisposition?.kind !== 'shopsite') continue;
    if (profileMembershipIds.has(attr.id)) continue;
    if (attr.isUniversal === true) continue; // universal tier proposes it regardless of type
    fail(
      'exported_attribute_without_profile_membership',
      `Attribute "${attr.id}" has a shopsite exportDisposition but no facet-profile membership and is not universal. Grant ≥1 profile membership in this release (or declare it universal) so the exported field has a proposer.`,
    );
  }
}

/** Attribute ids currently declared `not_exported` AND absent from every profile. */
function currentlyRetiredAttributeIds(
  attributes: Array<{ id: string; exportDisposition?: { kind: string } | undefined }>,
  profileMembershipIds: ReadonlySet<string>,
): string[] {
  return attributes
    .filter(a => a.exportDisposition?.kind === 'not_exported' && !profileMembershipIds.has(a.id))
    .map(a => a.id)
    .sort();
}

/**
 * P2 rule c — advisory `retire_candidate` findings (NEVER blocks).
 *
 * A `not_exported`, profile-less attribute that was ALREADY not_exported and
 * profile-less in the manifest's `sourceBaseline` release has now been retired
 * for >1 consecutive release; it is flagged as an advisory retirement
 * candidate in the validation report. Missing/unreadable baseline data yields
 * no finding at all — the check is best-effort by design.
 */
function collectRetireCandidateWarnings(
  dir: string,
  sourceBaseline: string | undefined,
  currentRetiredIds: readonly string[],
): ReleaseValidationFinding[] {
  if (!sourceBaseline || currentRetiredIds.length === 0) return [];
  try {
    const baselineDir = path.resolve(path.dirname(dir), sourceBaseline);
    const attributesFile = path.join(baselineDir, 'attributes.json');
    // Profile file name differs per release generation (v3/v5+: attribute-
    // profiles.json, v4: facet-profiles.json) — detect what the baseline has.
    const profilesFile = ['facet-profiles.json', 'attribute-profiles.json']
      .map(name => path.join(baselineDir, name))
      .find(candidate => fs.existsSync(candidate));
    if (!fs.existsSync(attributesFile) || !profilesFile) return [];
    const baselineAttrs = JSON.parse(fs.readFileSync(attributesFile, 'utf8')) as { entries?: unknown };
    const baselineProfiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')) as { entries?: unknown };
    if (!Array.isArray(baselineAttrs.entries) || !Array.isArray(baselineProfiles.entries)) return [];
    const baselineMembership = new Set<string>();
    for (const profile of baselineProfiles.entries) {
      const attrs = (profile as { attributes?: unknown } | null)?.attributes;
      if (!Array.isArray(attrs)) continue;
      for (const a of attrs) {
        const id = (a as { attributeId?: unknown } | null)?.attributeId;
        if (typeof id === 'string') baselineMembership.add(id);
      }
    }
    const alreadyRetired = new Set<string>();
    for (const entry of baselineAttrs.entries) {
      const a = entry as { id?: unknown; exportDisposition?: { kind?: unknown } } | null;
      if (typeof a?.id !== 'string') continue;
      if (a.exportDisposition?.kind !== 'not_exported') continue;
      if (!baselineMembership.has(a.id)) alreadyRetired.add(a.id);
    }
    return currentRetiredIds
      .filter(id => alreadyRetired.has(id))
      .map(id => ({
        code: 'retire_candidate',
        message: `Attribute "${id}" is not_exported and absent from every profile here and in baseline release "${sourceBaseline}" (>1 consecutive release). Advisory only — review for formal retirement; ids are never deleted.`,
        severity: 'warning' as const,
      }));
  } catch {
    return []; // advisory check must never block validation
  }
}

const SLUG_RELEASE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ─── Validator ─────────────────────────────────────────────────────────────────

/**
 * Validate a taxonomy release directory. Returns a report; never throws for
 * validation problems (callers use `loadTaxonomyRelease`/`assertReleaseValid`
 * to fail closed on `error` findings). Every rule violation is an `error`.
 */
export function validateTaxonomyRelease(releaseDir: string): ReleaseValidationReport {
  const findings: ReleaseValidationFinding[] = [];
  const dir = resolveReleaseDir(releaseDir);

  const fail = (code: string, message: string) => {
    findings.push({ code, message, severity: 'error' });
  };

  // ── Read + parse every file (missing/malformed = error) ──────────────────
  const rawFiles: Record<string, unknown> = {};
  for (const fileName of RELEASE_FILES) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) {
      fail('missing_release_file', `${fileName} is missing from the release.`);
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      fail('release_file_read_error', `Cannot read ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      rawFiles[fileName] = JSON.parse(text);
    } catch (err) {
      fail('release_file_parse_error', `${fileName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Manifest ─────────────────────────────────────────────────────────────
  const manifestParsed = rawFiles['manifest.json']
    ? TaxonomyReleaseManifestSchema.safeParse(rawFiles['manifest.json'])
    : null;
  if (rawFiles['manifest.json'] && !manifestParsed?.success) {
    fail('invalid_release_manifest', `manifest.json failed schema validation: ${z.prettifyError(manifestParsed!.error)}`);
  }
  const manifest = manifestParsed?.success ? manifestParsed.data : null;

  // ── Envelope parsing through shared V2 schemas ───────────────────────────
  const parseEnvelope = <T extends { entries: unknown[]; bundleOrigin: unknown }>(
    fileName: string,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  ): T | null => {
    if (!(fileName in rawFiles)) return null;
    const parsed = schema.safeParse(rawFiles[fileName]);
    if (!parsed.success) {
      fail('invalid_release_file', `${fileName} failed v2 schema validation.`);
      return null;
    }
    return parsed.data;
  };

  const departments = parseEnvelope('departments.json', DepartmentsFileV2Schema)?.entries ?? [];
  const productTypes = parseEnvelope('product-types.json', ProductTypesFileV2Schema)?.entries ?? [];
  const attributes = parseEnvelope('attributes.json', AttributesFileV2Schema)?.entries ?? [];
  const profiles = parseEnvelope('attribute-profiles.json', AttributeProfilesFileV2Schema)?.entries ?? [];
  const mappings = parseEnvelope('export-mappings.json', AttributeMappingsFileV2Schema)?.entries ?? [];
  const guidance = parseEnvelope('guidance.json', GuidanceFileV2Schema)?.entries ?? [];
  const pagePolicyParsed = rawFiles['page-assignment-policy.json']
    ? PageAssignmentPolicyV2Schema.safeParse(rawFiles['page-assignment-policy.json'])
    : null;
  if (rawFiles['page-assignment-policy.json'] && !pagePolicyParsed?.success) {
    fail('invalid_page_assignment_policy', 'page-assignment-policy.json failed schema validation.');
  }
  const pagePolicy = pagePolicyParsed?.success ? pagePolicyParsed.data : null;

  // ── File hash verification against manifest.fileVersions ────────────────
  if (manifest) {
    for (const [fileName, expectedHash] of Object.entries(manifest.fileVersions)) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) {
        fail('manifest_hash_missing_file', `manifest.fileVersions references ${fileName} which is missing.`);
        continue;
      }
      const actualHash = sha256OfFile(filePath);
      if (actualHash !== expectedHash) {
        fail('manifest_hash_mismatch', `${fileName} sha256 (${actualHash.slice(0, 12)}…) does not match manifest (${expectedHash.slice(0, 12)}…).`);
      }
    }
  }

  // ── Rule 1: unique product-type ids + format ─────────────────────────────
  {
    const seen = new Set<string>();
    for (const pt of productTypes) {
      if (!SLUG_RELEASE_ID_RE.test(pt.id)) {
        fail('invalid_product_type_id_format', `Product type id "${pt.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seen.has(pt.id)) {
        fail('duplicate_product_type_id', `Duplicate product type id "${pt.id}".`);
      }
      seen.add(pt.id);
    }
  }

  // ── Rule 2: unique attribute ids + format ────────────────────────────────
  {
    const seen = new Set<string>();
    for (const attr of attributes) {
      if (!SLUG_RELEASE_ID_RE.test(attr.id)) {
        fail('invalid_attribute_id_format', `Attribute id "${attr.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seen.has(attr.id)) {
        fail('duplicate_attribute_id', `Duplicate attribute id "${attr.id}".`);
      }
      seen.add(attr.id);
    }
  }

  // ── Rule 3: departments are unique, well-formed, and every product type's
  //    departmentId resolves ────────────────────────────────────────────────
  {
    const departmentIds = new Set(departments.map(d => d.id));
    // FIX 4: department ids must be unique and match the kebab-case release-id format.
    const seenDepartments = new Set<string>();
    for (const dept of departments) {
      if (!SLUG_RELEASE_ID_RE.test(dept.id)) {
        fail('invalid_department_id_format', `Department id "${dept.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seenDepartments.has(dept.id)) {
        fail('duplicate_department_id', `Duplicate department id "${dept.id}".`);
      }
      seenDepartments.add(dept.id);
    }
    for (const pt of productTypes) {
      if (pt.departmentId === undefined) {
        fail('missing_department_id', `Product type "${pt.id}" has no departmentId.`);
      } else if (!departmentIds.has(pt.departmentId)) {
        fail('unknown_department_id', `Product type "${pt.id}" references unknown department "${pt.departmentId}".`);
      }
    }
    // Departments' typeIds must match product-type departmentId membership.
    for (const dept of departments) {
      for (const typeId of dept.typeIds) {
        const pt = productTypes.find(p => p.id === typeId);
        if (!pt) {
          fail('department_unknown_type', `Department "${dept.id}" lists type "${typeId}" which does not exist.`);
        } else if (pt.departmentId !== dept.id) {
          fail('department_type_mismatch', `Department "${dept.id}" lists type "${typeId}" but the type declares departmentId "${pt.departmentId}".`);
        }
      }
    }
    // Reverse: every product type must appear in its department's typeIds.
    const deptTypeIds = new Map<string, string[]>();
    for (const dept of departments) deptTypeIds.set(dept.id, dept.typeIds);
    for (const pt of productTypes) {
      if (pt.departmentId === undefined) continue;
      const listed = deptTypeIds.get(pt.departmentId) ?? [];
      if (!listed.includes(pt.id)) {
        fail('department_type_not_listed', `Product type "${pt.id}" declares department "${pt.departmentId}" but is not listed in that department's typeIds.`);
      }
    }
  }

  // ── Rule 4: every product type has EXACTLY ONE profile (bijection) ───────
  {
    const typeIds = new Set(productTypes.map(pt => pt.id));
    const profileTypeIds = new Set<string>();
    const seenProfileTypes = new Set<string>();
    for (const profile of profiles) {
      if (profileTypeIds.has(profile.productTypeId)) {
        fail('duplicate_profile_for_type', `Product type "${profile.productTypeId}" has more than one attribute profile.`);
      }
      profileTypeIds.add(profile.productTypeId);
      seenProfileTypes.add(profile.productTypeId);
      if (!typeIds.has(profile.productTypeId)) {
        fail('orphan_profile', `Attribute profile "${profile.id}" references unknown product type "${profile.productTypeId}".`);
      }
    }
    for (const pt of productTypes) {
      if (!seenProfileTypes.has(pt.id)) {
        fail('missing_profile_for_type', `Product type "${pt.id}" has no attribute profile.`);
      }
    }
    // Also enforce the type's attributeProfileId points at an existing profile.
    const profileIds = new Set(profiles.map(p => p.id));
    for (const pt of productTypes) {
      if (pt.attributeProfileId !== null && pt.attributeProfileId !== undefined && !profileIds.has(pt.attributeProfileId)) {
        fail('missing_profile_pointer', `Product type "${pt.id}" points at unknown profile "${pt.attributeProfileId}".`);
      }
    }
  }

  // ── Rule 5: every profile attributeId exists in attributes.json ─────────
  {
    const attributeIds = new Set(attributes.map(a => a.id));
    for (const profile of profiles) {
      for (const pa of profile.attributes) {
        if (!attributeIds.has(pa.attributeId)) {
          fail('profile_unknown_attribute', `Profile "${profile.id}" references unknown attribute "${pa.attributeId}".`);
        }
      }
    }
  }

  // ── Rule 6: controlled allowedValues unique; valueAliases resolve ────────
  {
    for (const attr of attributes) {
      if (attr.valueMode !== 'controlled') continue;
      const seen = new Set<string>();
      for (const value of attr.allowedValues) {
        if (seen.has(value)) {
          fail('duplicate_allowed_value', `Attribute "${attr.id}" has duplicate allowed value "${value}".`);
        }
        seen.add(value);
      }
      for (const alias of attr.valueAliases) {
        if (!seen.has(alias.mapsTo)) {
          fail('unresolved_value_alias', `Attribute "${attr.id}" alias "${alias.alias}" maps to unknown value "${alias.mapsTo}".`);
        }
      }
    }
  }

  // ── Rule 7: measured attributes have canonicalUnit ───────────────────────
  {
    for (const attr of attributes) {
      if (attr.valueMode === 'measured' && (!attr.canonicalUnit || attr.canonicalUnit.trim().length === 0)) {
        fail('measured_attribute_missing_unit', `Measured attribute "${attr.id}" has no canonicalUnit.`);
      }
    }
  }

  // ── Rule 8: mappings reference known attributes; every attribute has an
  //    exportDisposition ────────────────────────────────────────────────────
  {
    const attributeIds = new Set(attributes.map(a => a.id));
    for (const mapping of mappings) {
      if (!attributeIds.has(mapping.attributeId)) {
        fail('mapping_unknown_attribute', `Export mapping "${mapping.id}" references unknown attribute "${mapping.attributeId}".`);
      }
    }
    for (const attr of attributes) {
      if (attr.exportDisposition === undefined) {
        fail('attribute_missing_export_disposition', `Attribute "${attr.id}" has no exportDisposition.`);
      } else if (attr.exportDisposition.kind === 'shopsite' && attr.exportDisposition.catalogField.trim().length === 0) {
        fail('attribute_empty_export_field', `Attribute "${attr.id}" has a shopsite disposition with an empty catalogField.`);
      }
    }
    // Mapped attributes must carry a shopsite disposition (not not_exported).
    const mappedAttributeIds = new Set(mappings.map(m => m.attributeId));
    for (const attr of attributes) {
      if (mappedAttributeIds.has(attr.id) && attr.exportDisposition?.kind === 'not_exported') {
        fail('mapped_attribute_not_exported', `Attribute "${attr.id}" has an export mapping but disposition "not_exported".`);
      }
    }
  }

  // ── Rule 8b (FIX 2): export duality SET-EQUALITY invariant ──────────────
  // export-mappings.json must equal EXACTLY the projection of attributes whose
  // exportDisposition.kind === 'shopsite' onto (attributeId, catalogField):
  //   ExpectedMappings = { (a.id, a.exportDisposition.catalogField) | a.kind == 'shopsite' }
  //   ActualMappings   = { (m.attributeId, m.catalogField) | m in exportMappings }
  //   ActualMappings == ExpectedMappings
  {
    const expectedByAttribute = new Map<string, string>();
    for (const attr of attributes) {
      if (attr.exportDisposition?.kind === 'shopsite') {
        expectedByAttribute.set(attr.id, attr.exportDisposition.catalogField);
      }
    }

    const actualByAttribute = new Map<string, string[]>();
    for (const mapping of mappings) {
      const existing = actualByAttribute.get(mapping.attributeId) ?? [];
      existing.push(mapping.catalogField);
      actualByAttribute.set(mapping.attributeId, existing);
    }

    // Every shopsite-disposition attribute must have EXACTLY ONE mapping with
    // the SAME catalogField.
    for (const [attributeId, expectedField] of expectedByAttribute) {
      const actualFields = actualByAttribute.get(attributeId);
      if (!actualFields || actualFields.length === 0) {
        fail('export_mapping_missing', `Attribute "${attributeId}" has a shopsite exportDisposition but no export mapping.`);
      } else if (actualFields.length > 1) {
        fail('duplicate_export_mapping', `Attribute "${attributeId}" has ${actualFields.length} export mappings; exactly one is required.`);
      } else if (actualFields[0] !== expectedField) {
        fail('export_mapping_mismatch', `Attribute "${attributeId}" maps to "${actualFields[0]}" but exportDisposition declares "${expectedField}".`);
      }
    }

    // Every mapping must correspond to a shopsite-disposition attribute with a
    // matching catalogField; not_exported/unknown attributes must have ZERO
    // mappings (forbidden).
    for (const [attributeId, actualFields] of actualByAttribute) {
      const attr = attributes.find(a => a.id === attributeId);
      if (!attr) continue; // unknown attributes already flagged by mapping_unknown_attribute
      if (attr.exportDisposition?.kind !== 'shopsite') {
        fail('export_mapping_forbidden', `Attribute "${attributeId}" has ${actualFields.length} export mapping(s) but disposition is "${attr.exportDisposition?.kind ?? 'missing'}".`);
        continue;
      }
      for (const field of actualFields) {
        if (field !== attr.exportDisposition.catalogField) {
          fail('export_mapping_mismatch', `Attribute "${attributeId}" maps to "${field}" but exportDisposition declares "${attr.exportDisposition.catalogField}".`);
        }
      }
    }
  }

  // ── Rule 8c (P2 disposition codification): exported ⇔ proposer ──────────
  // An exported attribute must have at least one proposer (facet/profile
  // membership, or the universal tier). See assertExportedAttributesHaveProposers.
  {
    const profiledAttributeIds = new Set<string>();
    for (const profile of profiles) {
      for (const pa of profile.attributes) profiledAttributeIds.add(pa.attributeId);
    }
    assertExportedAttributesHaveProposers(fail, attributes, profiledAttributeIds);
  }

  // ── Rule 8d (P2 rule c): retire_candidate advisories vs sourceBaseline ───
  {
    const profiledAttributeIds = new Set<string>();
    for (const profile of profiles) {
      for (const pa of profile.attributes) profiledAttributeIds.add(pa.attributeId);
    }
    const retiredNow = currentlyRetiredAttributeIds(attributes, profiledAttributeIds);
    findings.push(
      ...collectRetireCandidateWarnings(dir, manifest?.sourceBaseline, retiredNow),
    );
  }

  // ── Rule 9: guidance ids unique; structured refs known where applicable ──
  {
    const seen = new Set<string>();
    for (const g of guidance) {
      if (seen.has(g.id)) {
        fail('duplicate_guidance_id', `Duplicate guidance id "${g.id}".`);
      }
      seen.add(g.id);
      // Known reference-shaped keys in guidance.structured must resolve.
      const structured = (g.structured ?? {}) as Record<string, unknown>;
      if (typeof structured.productTypeIds === 'string') {
        fail('guidance_invalid_type_ref', `Guidance "${g.id}" productTypeIds must be an array.`);
      } else if (Array.isArray(structured.productTypeIds)) {
        const knownTypes = new Set(productTypes.map(pt => pt.id));
        for (const ref of structured.productTypeIds) {
          if (typeof ref === 'string' && !knownTypes.has(ref)) {
            fail('guidance_unknown_type_ref', `Guidance "${g.id}" references unknown product type "${ref}".`);
          }
        }
      }
      if (typeof structured.departmentIds === 'string') {
        fail('guidance_invalid_department_ref', `Guidance "${g.id}" departmentIds must be an array.`);
      } else if (Array.isArray(structured.departmentIds)) {
        const knownDepts = new Set(departments.map(d => d.id));
        for (const ref of structured.departmentIds) {
          if (typeof ref === 'string' && !knownDepts.has(ref)) {
            fail('guidance_unknown_department_ref', `Guidance "${g.id}" references unknown department "${ref}".`);
          }
        }
      }
    }
  }

  // ── Rule 10: page-assignment-policy ──────────────────────────────────────
  {
    if (pagePolicy) {
      if (!Number.isInteger(pagePolicy.maxPagesPerProduct) || pagePolicy.maxPagesPerProduct <= 0) {
        fail('invalid_max_pages', `page-assignment-policy maxPagesPerProduct must be a positive integer.`);
      }
      if (!Array.isArray(pagePolicy.allowedSpecies) || pagePolicy.allowedSpecies.length === 0) {
        fail('invalid_allowed_species', `page-assignment-policy allowedSpecies must be a non-empty array of strings.`);
      }
    }
  }

  // ── Rule 11: manifest counts match actual file contents ──────────────────
  {
    if (manifest) {
      const actual: Record<string, number> = {
        productTypes: productTypes.length,
        attributes: attributes.length,
        attributeProfiles: profiles.length,
        departments: departments.length,
        mappings: mappings.length,
        guidance: guidance.length,
      };
      const expected = manifest.counts;
      for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
        const exp = expected[key as keyof typeof expected];
        if (exp === undefined || exp !== actual[key]) {
          fail('manifest_count_mismatch', `manifest.counts.${key} is ${exp ?? 'missing'}, but the release contains ${actual[key]}.`);
        }
      }
    }
  }

  // ── Rule 12: manifest identity (releaseId/revision present; release origin) ──
  {
    if (manifest && (!manifest.releaseId || !manifest.revision)) {
      fail('invalid_release_manifest', 'manifest.json must include releaseId and revision.');
    }
    // FIX 5: release identity binding — releaseId and revision must match the
    // kebab-case id format, and the manifest releaseId must equal the basename
    // of the release directory being validated (an activeTaxonomyRevision must
    // resolve to exactly one immutable release).
    if (manifest) {
      if (!isValidReleaseId(manifest.releaseId)) {
        fail('invalid_release_id_format', `manifest.releaseId "${manifest.releaseId}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (!isValidReleaseId(manifest.revision)) {
        fail('invalid_release_id_format', `manifest.revision "${manifest.revision}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      const dirBasename = path.basename(dir);
      if (manifest.releaseId !== dirBasename) {
        fail('release_id_mismatch', `manifest.releaseId "${manifest.releaseId}" does not match the release directory basename "${dirBasename}".`);
      }
    }
    // Envelope origin consistency: every focused file must declare the same
    // release bundle origin, matching the manifest releaseId when present.
    const originOf = (fileName: string): ClassificationBundleOriginV2 | null => {
      const raw = rawFiles[fileName];
      if (!raw || typeof raw !== 'object') return null;
      const origin = (raw as Record<string, unknown>).bundleOrigin;
      if (!origin) return null;
      const parsed = ClassificationBundleOriginV2Schema.safeParse(origin);
      return parsed.success ? parsed.data : null;
    };
    const envelopeOrigins = [
      originOf('departments.json'),
      originOf('product-types.json'),
      originOf('attributes.json'),
      originOf('attribute-profiles.json'),
      originOf('export-mappings.json'),
      originOf('guidance.json'),
    ].filter((o): o is ClassificationBundleOriginV2 => o !== null);
    if (envelopeOrigins.length > 0) {
      const firstOriginJson = JSON.stringify(envelopeOrigins[0]);
      for (const origin of envelopeOrigins) {
        if (JSON.stringify(origin) !== firstOriginJson) {
          fail('inconsistent_release_origin', 'Focused release files declare inconsistent bundle origins.');
          break;
        }
        if (origin.kind !== 'release') {
          fail('non_release_origin', `Focused file declares bundleOrigin.kind "${origin.kind}"; a taxonomy release must use kind "release".`);
          break;
        }
      }
      if (manifest && envelopeOrigins[0].kind === 'release' && envelopeOrigins[0].releaseId !== manifest.releaseId) {
        fail('release_origin_mismatch', `Focused files declare releaseId "${envelopeOrigins[0].releaseId}" but manifest declares "${manifest.releaseId}".`);
      }
    }
  }

  return {
    ok: findings.every(f => f.severity !== 'error'),
    findings,
    counts: {
      productTypes: productTypes.length,
      attributes: attributes.length,
      attributeProfiles: profiles.length,
      departments: departments.length,
      mappings: mappings.length,
    },
    profileBlastRadii: [],
  };
}

// ─── Fail-closed loaders ───────────────────────────────────────────────────────

/**
 * Parse a validated taxonomy release into a structured bundle. THROWS
 * `ReleaseValidationError` (code `release_invalid`) when the release has any
 * `error`-severity finding.
 */
export function loadTaxonomyRelease(releaseDir: string): TaxonomyReleaseBundle {
  const report = validateTaxonomyRelease(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }

  const dir = resolveReleaseDir(releaseDir);
  const read = (fileName: string) => JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));

  const manifest = TaxonomyReleaseManifestSchema.parse(read('manifest.json'));
  const departments = DepartmentsFileV2Schema.parse(read('departments.json')).entries;
  const productTypes = ProductTypesFileV2Schema.parse(read('product-types.json')).entries;
  const attributes = AttributesFileV2Schema.parse(read('attributes.json')).entries;
  const attributeProfiles = AttributeProfilesFileV2Schema.parse(read('attribute-profiles.json')).entries;
  const exportMappings = AttributeMappingsFileV2Schema.parse(read('export-mappings.json')).entries;
  const guidance = GuidanceFileV2Schema.parse(read('guidance.json')).entries;
  const pageAssignmentPolicy = PageAssignmentPolicyV2Schema.parse(read('page-assignment-policy.json'));

  return {
    manifest,
    departments,
    productTypes,
    attributes,
    attributeProfiles,
    exportMappings,
    guidance,
    pageAssignmentPolicy,
  };
}

/**
 * Assert a taxonomy release is valid. THROWS `ReleaseValidationError` on any
 * `error`-severity finding; otherwise returns the validation report.
 */
export function assertReleaseValid(releaseDir: string): ReleaseValidationReport {
  const report = validateTaxonomyRelease(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }
  return report;
}

// ─── v4 validator ───────────────────────────────────────────────────────────────

/** v4 release files (differs from v3: hierarchy replaces departments/product-types). */
const V4_RELEASE_FILES = [
  'manifest.json',
  'hierarchy.json',
  'facet-profiles.json',
  'legacy-mappings.json',
  'attributes.json',
  'shopsite-projection.json',
  'export-mappings.json',
  'guidance.json',
  'page-assignment-policy.json',
] as const;

/**
 * Parse a v4 envelope file through a V4 schema; null when the file is missing
 * or fails schema validation (the caller adds the finding once).
 */
function computeEffectiveFacetDescriptor(
  attr: ProductAttributeConfigV2 | undefined,
  cardinality: string,
  facetOrder: number,
): string {
  const kind = attr?.exportDisposition?.kind;
  const valueMode = attr?.valueMode ?? 'freeText';
  const controlType = valueMode === 'measured' ? 'range' : valueMode === 'controlled' ? 'select' : 'text';
  return JSON.stringify({
    attributeId: attr?.id ?? 'UNKNOWN',
    facetEnabled: kind === 'shopsite',
    searchIndexable: kind === 'shopsite',
    facetOrder,
    valueSortMode: 'alphabetical',
    displayLabel: attr?.name ?? 'UNKNOWN',
    controlType,
    facetSelection: cardinality === 'multiple' ? 'multi' : 'single',
    multiValueOperator: 'or',
  });
}

/** Recompute the v3-side fingerprint from immutable sibling release inputs. */
function computeV3ProfileFingerprint(
  profile: AttributeProfileConfigV2,
  attributes: ProductAttributeConfigV2[],
): string {
  const parts = profile.attributes
    .map(attribute => {
      const attr = attributes.find(candidate => candidate.id === attribute.attributeId);
      const behavior = attr
        ? JSON.stringify({
            valueMode: attr.valueMode,
            canonicalUnit: attr.canonicalUnit ?? null,
            allowedValues: [...(attr.allowedValues ?? [])].sort(),
            valueAliases: [...(attr.valueAliases ?? [])].sort(),
            isUniversal: attr.isUniversal ?? false,
            isClaim: attr.isClaim ?? false,
            isCompositionAttribute: attr.isCompositionAttribute ?? false,
            visualEvidenceEligibility: attr.visualEvidenceEligibility ?? null,
            group: attr.group ?? null,
            exportKind: attr.exportDisposition?.kind ?? null,
            exportField: attr.exportDisposition?.kind === 'shopsite' ? attr.exportDisposition.catalogField : null,
          })
        : 'MISSING';
      const facetOrder = profile.attributes.findIndex(candidate => candidate.attributeId === attribute.attributeId);
      const facet = computeEffectiveFacetDescriptor(attr, attribute.cardinality, facetOrder);
      return `${attribute.attributeId}|req:${attribute.required ? 1 : 0}|card:${attribute.cardinality ?? 'single'}|${behavior}|facet:${facet}`;
    })
    .sort()
    .join(';');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 24);
}

function parseV4Envelope<T extends { entries: unknown[]; bundleOrigin: unknown }>(
  raw: unknown,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  fileName: string,
  findings: ReleaseValidationFinding[],
): T | null {
  if (raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    findings.push({
      code: 'invalid_v4_release_file',
      message: `${fileName} failed v4 schema validation.`,
      severity: 'error',
    });
    return null;
  }
  return parsed.data;
}

/** True when `childId` is a descendant of (or equal to) `ancestorId`. */
function isDescendantOf(
  childId: string,
  ancestorId: string,
  nodeById: Map<string, { id: string; parentId: string | null }>,
): boolean {
  let cursor: { id: string; parentId: string | null } | undefined = nodeById.get(childId);
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor.id)) return false; // cycle rule reports it
    visited.add(cursor.id);
    if (cursor.id === ancestorId) return true;
    cursor = cursor.parentId ? nodeById.get(cursor.parentId) : undefined;
  }
  return false;
}

/** Deterministic species hint from a page name's leading tokens. */
function pageSpeciesHint(pageName: string): string | null {
  const norm = pageName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/^caged bird|^wild bird|\bbird\b/.test(norm)) return 'wild_bird';
  if (/^dog\b/.test(norm)) return 'dog';
  if (/^cat\b/.test(norm)) return 'cat';
  if (/^fish\b/.test(norm)) return 'fish';
  if (/^horse\b/.test(norm)) return 'horse';
  return null;
}

/** Nearest declared scope (walking ancestors). */
function effectiveScopeOf(
  nodeId: string,
  nodeById: Map<string, { id: string; parentId: string | null; scope?: { animalDomain?: string } | null }>,
): string | null {
  let cursor = nodeById.get(nodeId);
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor.id)) return null; // cycle rule reports it
    visited.add(cursor.id);
    if (cursor.scope?.animalDomain) return cursor.scope.animalDomain;
    cursor = cursor.parentId ? nodeById.get(cursor.parentId) : undefined;
  }
  return null;
}

export interface CanonicalHierarchyReleaseCoreResult<TNode extends V4HierarchyNode | V5HierarchyNode> {
  report: ReleaseValidationReport;
  parsed: {
    manifest: V4Manifest | null;
    hierarchy: TNode[];
    facetProfiles: V4FacetProfile[];
    legacyMappings: V4LegacyMapping[];
    attributes: ProductAttributeConfigV2[];
    exportMappings: AttributeMappingConfigV2[];
    pageProjections: V4PageProjection[];
    guidance: GuidanceConfigV2[];
    pagePolicy: PageAssignmentPolicyV2 | null;
  };
}

/**
 * Shared validation core for canonical hierarchy releases (v4, v5, etc.).
 * Verifies file presence, manifest schema, sha256 file hashes, node uniqueness,
 * parent references, root structure (exactly 10 roots), reachability / DFS cycle protection,
 * classifiable profile relationships, profile references/provenance/fingerprints,
 * legacy migration bijection & completeness, ShopSite page projections & species scope,
 * manifest counts & directory identity, export duality, proposer coverage, and species safety.
 */
export function validateCanonicalHierarchyReleaseCore<TNode extends V4HierarchyNode | V5HierarchyNode>(
  releaseDir: string,
  hierarchySchema: { safeParse(v: unknown): { success: true; data: { entries: TNode[]; bundleOrigin: unknown } } | { success: false; error?: any } },
): CanonicalHierarchyReleaseCoreResult<TNode> {
  const findings: ReleaseValidationFinding[] = [];
  const dir = resolveReleaseDir(releaseDir);
  const report: ReleaseValidationReport = {
    ok: false,
    findings,
    counts: { productTypes: 0, attributes: 0, attributeProfiles: 0, departments: 0, mappings: 0 },
    profileBlastRadii: [],
  };

  const fail = (code: string, message: string) => {
    findings.push({ code, message, severity: 'error' });
  };

  // ── Read + parse every file (missing/malformed = error) ─────────────
  const rawFiles: Record<string, unknown> = {};
  for (const fileName of V4_RELEASE_FILES) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) {
      fail('missing_release_file', `${fileName} is missing from the v4 release.`);
      continue;
    }
    try {
      rawFiles[fileName] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      fail('release_file_parse_error', `${fileName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Manifest ─────────────────────────────────────────────────────────────
  const manifestParsed = rawFiles['manifest.json']
    ? V4ManifestSchema.safeParse(rawFiles['manifest.json'])
    : null;
  if (rawFiles['manifest.json'] && !manifestParsed?.success) {
    fail('invalid_v4_manifest', `manifest.json failed v4 schema validation: ${z.prettifyError(manifestParsed!.error)}`);
  }
  const manifest = manifestParsed?.success ? manifestParsed.data : null;

  // ── Envelope parsing ──────────────────────────────────────────────────────
  const hierarchy = parseV4Envelope(rawFiles['hierarchy.json'], hierarchySchema, 'hierarchy.json', findings)?.entries ?? [];
  const facetProfiles = parseV4Envelope(rawFiles['facet-profiles.json'], V4FacetProfilesSchema, 'facet-profiles.json', findings)?.entries ?? [];
  const legacyMappings = parseV4Envelope(rawFiles['legacy-mappings.json'], V4LegacyMappingsSchema, 'legacy-mappings.json', findings)?.entries ?? [];
  const attributes = parseV4Envelope(rawFiles['attributes.json'], AttributesFileV2Schema, 'attributes.json', findings)?.entries ?? [];
  const exportMappings = parseV4Envelope(rawFiles['export-mappings.json'], AttributeMappingsFileV2Schema, 'export-mappings.json', findings)?.entries ?? [];
  const pageProjections = parseV4Envelope(rawFiles['shopsite-projection.json'], V4ShopsiteProjectionSchema, 'shopsite-projection.json', findings)?.entries ?? [];
  const guidance = parseV4Envelope(rawFiles['guidance.json'], GuidanceFileV2Schema, 'guidance.json', findings)?.entries ?? [];
  const pagePolicyParsed = rawFiles['page-assignment-policy.json']
    ? PageAssignmentPolicyV2Schema.safeParse(rawFiles['page-assignment-policy.json'])
    : null;
  if (rawFiles['page-assignment-policy.json'] && !pagePolicyParsed?.success) {
    fail('invalid_page_assignment_policy', 'page-assignment-policy.json failed schema validation.');
  }
  const pagePolicy = pagePolicyParsed?.success ? pagePolicyParsed.data : null;

  // ── File hash verification against manifest.fileVersions ────────────────
  if (manifest) {
    for (const [fileName, expectedHash] of Object.entries(manifest.fileVersions)) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) {
        fail('manifest_hash_missing_file', `manifest.fileVersions references ${fileName} which is missing.`);
        continue;
      }
      const actualHash = sha256OfFile(filePath);
      if (actualHash !== expectedHash) {
        fail('manifest_hash_mismatch', `${fileName} sha256 (${actualHash.slice(0, 12)}…) does not match manifest (${expectedHash.slice(0, 12)}…).`);
      }
    }
  }

  // ── Rule 1: node ids unique + kebab-case format ──────────────────────────
  {
    const seen = new Set<string>();
    for (const node of hierarchy) {
      if (!SLUG_RELEASE_ID_RE.test(node.id)) {
        fail('invalid_node_id_format', `Hierarchy node id "${node.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seen.has(node.id)) {
        fail('duplicate_node_id', `Duplicate hierarchy node id "${node.id}".`);
      }
      seen.add(node.id);
    }
  }

  // ── Rule 2: parentId references; roots exist; exactly 10 roots ───────────
  const nodeById = new Map<string, TNode>();
  for (const node of hierarchy) nodeById.set(node.id, node);

  {
    const roots = hierarchy.filter(n => n.parentId === null);
    if (roots.length !== 10) {
      fail('invalid_root_count', `Expected exactly 10 department roots (parentId null), found ${roots.length}.`);
    }
    for (const node of hierarchy) {
      if (node.parentId === null) continue;
      if (node.parentId === node.id) {
        fail('self_parent_node', `Hierarchy node "${node.id}" has parentId pointing at itself.`);
        continue;
      }
      if (!nodeById.has(node.parentId)) {
        fail('unknown_parent_node', `Hierarchy node "${node.id}" references unknown parent "${node.parentId}".`);
      }
    }
  }

  // ── Rule 3: no cycles (DFS from roots); every node reachable ─────────────
  {
    const visited = new Set<string>();
    const stack: string[] = [];
    for (const root of hierarchy.filter(n => n.parentId === null)) {
      stack.push(root.id);
    }
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const child of hierarchy.filter(n => n.parentId === id)) {
        stack.push(child.id);
      }
    }
    if (visited.size !== hierarchy.length) {
      const unreachable = hierarchy.filter(n => !visited.has(n.id)).map(n => n.id);
      // A cycle would leave every node on the cycle unreachable from the roots.
      fail('hierarchy_cycle_or_unreachable', `${hierarchy.length - visited.size} node(s) are not reachable from the roots (cycle or dangling): ${unreachable.join(', ')}`);
    }
  }

  // ── Rule 4: classifiable → facetProfileId exists; non-classifiable → null ─
  const facetProfileById = new Map<string, V4FacetProfile>();
  for (const profile of facetProfiles) facetProfileById.set(profile.id, profile);

  {
    for (const node of hierarchy) {
      if (node.classifiable) {
        if (!node.facetProfileId || !facetProfileById.has(node.facetProfileId)) {
          fail('classifiable_node_missing_profile', `Classifiable node "${node.id}" has missing/unknown facetProfileId "${node.facetProfileId ?? '(none)'}".`);
        }
      } else if (node.facetProfileId !== null) {
        fail('non_classifiable_node_has_profile', `Non-classifiable node "${node.id}" must have facetProfileId null, got "${node.facetProfileId}".`);
      }
    }
  }

  // ── Rule 5: facet profiles — unique ids, attribute refs resolve, no dupes ─
  {
    const attributeIds = new Set(attributes.map(a => a.id));
    const seenProfileIds = new Set<string>();
    for (const profile of facetProfiles) {
      if (seenProfileIds.has(profile.id)) {
        fail('duplicate_facet_profile_id', `Duplicate facet profile id "${profile.id}".`);
      }
      seenProfileIds.add(profile.id);
      const seenAttrIds = new Set<string>();
      for (const attr of profile.attributes) {
        if (!attributeIds.has(attr.attributeId)) {
          fail('facet_profile_unknown_attribute', `Facet profile "${profile.id}" references unknown attribute "${attr.attributeId}".`);
        }
        if (seenAttrIds.has(attr.attributeId)) {
          fail('facet_profile_duplicate_attribute', `Facet profile "${profile.id}" lists attribute "${attr.attributeId}" more than once.`);
        }
        seenAttrIds.add(attr.attributeId);
      }
    }
  }

  // ── Rule 5b: profile provenance + blast radius (ChatGPT v4 review fix #13) ──
  {
    const _profileIds = new Set(facetProfiles.map(p => p.id));
    const leafNodes = hierarchy.filter(n => n.classifiable);
    const leafByProfile = new Map<string, string[]>();
    for (const leaf of leafNodes) {
      if (!leaf.facetProfileId) continue;
      const arr = leafByProfile.get(leaf.facetProfileId) ?? [];
      arr.push(leaf.id);
      leafByProfile.set(leaf.facetProfileId, arr);
    }
    for (const profile of facetProfiles) {
      if (!profile.sourceV3ProfileIds || profile.sourceV3ProfileIds.length === 0) {
        fail('profile_missing_provenance', `Facet profile "${profile.id}" has no sourceV3ProfileIds.`);
      }
      if (!profile.behaviorFingerprint || profile.behaviorFingerprint.length < 8) {
        fail('profile_missing_fingerprint', `Facet profile "${profile.id}" has no behaviorFingerprint.`);
      }
      for (const v3Id of profile.sourceV3ProfileIds) {
        if (!/^[a-z0-9-]+$/.test(v3Id)) {
          fail('profile_provenance_invalid', `Facet profile "${profile.id}" has invalid sourceV3ProfileId "${v3Id}".`);
        }
      }
      // Provenance must match the hierarchy: the canonicalNodeIds recorded on
      // the profile must equal the leaves actually referencing it.
      const recorded = [...(profile.canonicalNodeIds ?? [])].sort();
      const actual = [...(leafByProfile.get(profile.id) ?? [])].sort();
      if (JSON.stringify(recorded) !== JSON.stringify(actual)) {
        fail('profile_node_ids_mismatch', `Facet profile "${profile.id}" canonicalNodeIds do not match the leaves referencing it (recorded ${recorded.join(',')}, actual ${actual.join(',')}).`);
      }
    }
    // Blast radius (report only, not an error): shared profiles with >1 node.
    for (const profile of facetProfiles) {
      const count = (leafByProfile.get(profile.id) ?? []).length;
      if (count > 1) {
        report.profileBlastRadii.push({
          profileId: profile.id,
          nodeCount: count,
          nodeIds: (leafByProfile.get(profile.id) ?? []).sort(),
        });
      }
    }
  }

  // ── Rule 5c: profile_map behavioral equivalence (ChatGPT v4 review fix #12) ──
  {
    const profileById = new Map(facetProfiles.map(p => [p.id, p]));
    const seenProfileMaps = new Set<string>();
    for (const mapping of legacyMappings.filter(m => m.kind === 'profile_map')) {
      if (seenProfileMaps.has(mapping.v3ProfileId)) {
        fail('duplicate_profile_map', `v3 profile "${mapping.v3ProfileId}" has more than one profile_map entry.`);
      }
      seenProfileMaps.add(mapping.v3ProfileId);
      const v4Profile = profileById.get(mapping.v4ProfileId);
      if (!v4Profile) {
        fail('profile_map_unknown_target', `profile_map for "${mapping.v3ProfileId}" references unknown v4 profile "${mapping.v4ProfileId}".`);
        continue;
      }
      if (mapping.v3Fingerprint !== mapping.v4Fingerprint) {
        fail('profile_behavior_mismatch', `profile_map "${mapping.v3ProfileId}"→"${mapping.v4ProfileId}" fingerprints differ (${mapping.v3Fingerprint} vs ${mapping.v4Fingerprint}).`);
      }
      if (mapping.equivalent !== true) {
        fail('profile_behavior_mismatch', `profile_map "${mapping.v3ProfileId}"→"${mapping.v4ProfileId}" declares equivalent:false.`);
      }
      if (v4Profile.behaviorFingerprint !== mapping.v4Fingerprint) {
        fail('profile_fingerprint_inconsistent', `profile_map "${mapping.v3ProfileId}" v4Fingerprint does not match the target profile's behaviorFingerprint.`);
      }
      if (!v4Profile.sourceV3ProfileIds.includes(mapping.v3ProfileId)) {
        fail('profile_map_provenance_missing', `profile_map "${mapping.v3ProfileId}"→"${mapping.v4ProfileId}" but the v4 profile does not list it in sourceV3ProfileIds.`);
      }
    }
    // Every v3 profile must have a profile_map entry (bijection on the v3 side).
    const v3DirForProfiles = path.resolve(path.dirname(dir), 'bay-state-v3');
    const v3ProfilesFile = path.join(v3DirForProfiles, 'attribute-profiles.json');
    if (fs.existsSync(v3ProfilesFile)) {
      try {
        const parsed = AttributeProfilesFileV2Schema.safeParse(JSON.parse(fs.readFileSync(v3ProfilesFile, 'utf8')));
        if (parsed.success) {
          const v3ProfileIds = parsed.data.entries.map(e => e.id);
          for (const v3Id of v3ProfileIds) {
            if (!seenProfileMaps.has(v3Id)) {
              fail('profile_map_missing', `v3 profile "${v3Id}" has no profile_map entry.`);
            }
          }
        }
      } catch { /* already reported by Rule 6 */ }
    }
  }

  // ── Rule 5d: independently recompute v3 profile fingerprints ────────────
  {
    const v3DirForProfiles = path.resolve(path.dirname(dir), 'bay-state-v3');
    const v3ProfilesFile = path.join(v3DirForProfiles, 'attribute-profiles.json');
    const v3AttributesFile = path.join(v3DirForProfiles, 'attributes.json');
    if (!fs.existsSync(v3ProfilesFile) || !fs.existsSync(v3AttributesFile)) {
      fail('v3_profile_fingerprint_source_missing', 'Cannot independently recompute profile fingerprints: v3 attributes.json or attribute-profiles.json is missing.');
    } else {
      try {
        const parsedProfiles = AttributeProfilesFileV2Schema.safeParse(JSON.parse(fs.readFileSync(v3ProfilesFile, 'utf8')));
        const parsedAttributes = AttributesFileV2Schema.safeParse(JSON.parse(fs.readFileSync(v3AttributesFile, 'utf8')));
        if (!parsedProfiles.success || !parsedAttributes.success) {
          fail('v3_profile_fingerprint_source_invalid', 'Cannot independently recompute profile fingerprints: v3 source files failed schema validation.');
        } else {
          const mappingsByV3Id = new Map(
            legacyMappings.filter(m => m.kind === 'profile_map').map(m => [m.v3ProfileId, m]),
          );
          for (const profile of parsedProfiles.data.entries) {
            const mapping = mappingsByV3Id.get(profile.id);
            if (!mapping) continue; // Rule 5c reports the missing map.
            const recomputed = computeV3ProfileFingerprint(profile, parsedAttributes.data.entries);
            if (mapping.v3Fingerprint !== recomputed) {
              fail('profile_v3_fingerprint_untrusted', `profile_map "${profile.id}" v3Fingerprint does not match independently recomputed source behavior (${mapping.v3Fingerprint} vs ${recomputed}).`);
            }
          }
        }
      } catch (err) {
        fail('v3_profile_fingerprint_source_read_error', `Cannot independently recompute profile fingerprints: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Rule 6: leaf bijection with v3 product-types.json ────────────────────
  {
    const leafNodes = hierarchy.filter(n => n.classifiable);
    const migratedLeaves = leafNodes.filter(n => n.derivation !== 'type_native');
    for (const leaf of migratedLeaves) {
      if (!leaf.legacyTypeIds || leaf.legacyTypeIds.length === 0) {
        fail('leaf_node_no_legacy_type', `Classifiable node "${leaf.id}" has no legacyTypeIds.`);
      }
    }
    for (const leaf of leafNodes.filter(n => n.derivation === 'type_native')) {
      if (leaf.legacyTypeIds && leaf.legacyTypeIds.length > 0) {
        fail('native_leaf_has_legacy_type', `v4-native node "${leaf.id}" must not carry legacyTypeIds.`);
      }
    }

    // Resolve the v3 release sibling directory (releaseDir/../bay-state-v3).
    const v3Dir = path.resolve(path.dirname(dir), 'bay-state-v3');
    const v3ProductTypesFile = path.join(v3Dir, 'product-types.json');
    if (!fs.existsSync(v3ProductTypesFile)) {
      fail('v3_baseline_missing', `Cannot verify leaf bijection: v3 product-types.json not found at ${v3ProductTypesFile}.`);
    } else {
      let v3TypeIds: string[] = [];
      try {
        const v3Parsed = ProductTypesFileV2Schema.safeParse(JSON.parse(fs.readFileSync(v3ProductTypesFile, 'utf8')));
        if (!v3Parsed.success) {
          fail('v3_baseline_invalid', `v3 product-types.json failed schema validation.`);
        } else {
          v3TypeIds = v3Parsed.data.entries.map(e => e.id);
        }
      } catch (err) {
        fail('v3_baseline_read_error', `Cannot read v3 product-types.json: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (v3TypeIds.length > 0) {
        const leafTypeIdCounts = new Map<string, number>();
        const unknownLeafTypes: string[] = [];
        for (const leaf of leafNodes) {
          for (const typeId of leaf.legacyTypeIds) {
            if (!v3TypeIds.includes(typeId)) unknownLeafTypes.push(`${leaf.id}:${typeId}`);
            leafTypeIdCounts.set(typeId, (leafTypeIdCounts.get(typeId) ?? 0) + 1);
          }
        }
        if (unknownLeafTypes.length > 0) {
          fail('leaf_legacy_type_unknown', `Leaf legacyTypeIds reference types not in v3: ${unknownLeafTypes.join(', ')}`);
        }
        const duplicatedTypes = [...leafTypeIdCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
        if (duplicatedTypes.length > 0) {
          fail('leaf_type_not_bijective', `v3 types appear in more than one leaf's legacyTypeIds: ${duplicatedTypes.join(', ')}`);
        }
        const missingTypes = v3TypeIds.filter(id => !leafTypeIdCounts.has(id));
        if (missingTypes.length > 0) {
          fail('leaf_type_missing', `${missingTypes.length} v3 type(s) are not represented by any classifiable leaf: ${missingTypes.join(', ')}`);
        }
      }
    }
  }

  // ── Rule 7: legacy-mappings type_migration completeness ──────────────────
  {
    const migrations = legacyMappings.filter(m => m.kind === 'type_migration');
    const v3Dir = path.resolve(path.dirname(dir), 'bay-state-v3');
    const v3ProductTypesFile = path.join(v3Dir, 'product-types.json');
    let v3TypeIds: string[] = [];
    if (fs.existsSync(v3ProductTypesFile)) {
      try {
        const parsed = ProductTypesFileV2Schema.safeParse(JSON.parse(fs.readFileSync(v3ProductTypesFile, 'utf8')));
        if (parsed.success) v3TypeIds = parsed.data.entries.map(e => e.id);
      } catch { /* already reported by Rule 6 */ }
    }
    if (v3TypeIds.length > 0) {
      const migrated = new Map<string, V4TypeMigrationEntry>();
      for (const migration of migrations) {
        if (migrated.has(migration.v3TypeId)) {
          fail('duplicate_type_migration', `v3 type "${migration.v3TypeId}" has more than one type_migration entry.`);
        }
        migrated.set(migration.v3TypeId, migration);
        if (!nodeById.has(migration.targetNodeId)) {
          fail('type_migration_unknown_target', `type_migration for "${migration.v3TypeId}" targets unknown node "${migration.targetNodeId}".`);
        }
        const target = nodeById.get(migration.targetNodeId);
        if (target && !target.classifiable) {
          fail('type_migration_target_not_classifiable', `type_migration for "${migration.v3TypeId}" targets non-classifiable node "${migration.targetNodeId}".`);
        }
      }
      const missing = v3TypeIds.filter(id => !migrated.has(id));
      if (missing.length > 0) {
        fail('type_migration_missing', `${missing.length} v3 type(s) have no type_migration entry: ${missing.join(', ')}`);
      }
    }
  }

  // ── Rule 8: shopsite-projection invariants ───────────────────────────────
  {
    const seenPageNames = new Set<string>();
    const nodeIdToLeafPage = new Map<string, string>();
    for (const page of pageProjections) {
      if (seenPageNames.has(page.pageName)) {
        fail('duplicate_page_projection', `Duplicate page projection "${page.pageName}".`);
      }
      seenPageNames.add(page.pageName);

      if (page.role === 'canonical_leaf') {
        if (!page.nodeId) {
          fail('canonical_leaf_missing_node', `Canonical leaf page "${page.pageName}" has no nodeId.`);
        } else {
          const node = nodeById.get(page.nodeId);
          if (!node) {
            fail('canonical_leaf_unknown_node', `Canonical leaf page "${page.pageName}" references unknown node "${page.nodeId}".`);
          } else if (!node.classifiable) {
            fail('canonical_leaf_node_not_classifiable', `Canonical leaf page "${page.pageName}" references non-classifiable node "${page.nodeId}".`);
          } else {
            const pageSpecies = pageSpeciesHint(page.pageName);
            const nodeScope = effectiveScopeOf(node.id, nodeById);
            if (pageSpecies && nodeScope && pageSpecies !== nodeScope && nodeScope !== 'wild_bird') {
              fail('page_scope_mismatch', `Page "${page.pageName}" is ${pageSpecies}-scoped but maps to node "${page.nodeId}" (scope ${nodeScope}).`);
            }
            if (pageSpecies === 'wild_bird' && !isDescendantOf(node.id, 'wild-bird', nodeById)) {
              fail('page_scope_mismatch', `Wild-bird page "${page.pageName}" maps to "${page.nodeId}" outside the wild-bird family.`);
            }
          }
          if (nodeIdToLeafPage.has(page.nodeId)) {
            fail('duplicate_canonical_node_page', `Canonical node "${page.nodeId}" is projected by both "${nodeIdToLeafPage.get(page.nodeId)}" and "${page.pageName}".`);
          }
          nodeIdToLeafPage.set(page.nodeId, page.pageName);
        }
        if (page.facetProfileId && !facetProfileById.has(page.facetProfileId)) {
          fail('page_unknown_facet_profile', `Canonical leaf page "${page.pageName}" references unknown facet profile "${page.facetProfileId}".`);
        }
      }
    }
    const unresolvedPages = pageProjections.filter(page => page.role === 'needs_review');
    if (unresolvedPages.length > 0) {
      fail('page_projection_needs_review', `${unresolvedPages.length} page projection(s) remain needs_review: ${unresolvedPages.map(page => page.pageName).join(', ')}.`);
    }
  }

  // ── Rule 9: manifest counts + identity ───────────────────────────────────
  {
    if (manifest) {
      const actual = {
        nodes: hierarchy.length,
        departments: hierarchy.filter(n => n.parentId === null).length,
        types: hierarchy.filter(n => n.classifiable).length,
        nativeLeaves: hierarchy.filter(n => n.classifiable && n.derivation === 'type_native').length,
        attributes: attributes.length,
        facetProfiles: facetProfiles.length,
        pages: pageProjections.length,
        mappings: exportMappings.length,
      };
      for (const [key, exp] of Object.entries(manifest.counts)) {
        const act = actual[key as keyof typeof actual];
        if (exp !== act) {
          fail('manifest_count_mismatch', `manifest.counts.${key} is ${exp}, but the release contains ${act}.`);
        }
      }
      if (!isValidReleaseId(manifest.releaseId)) {
        fail('invalid_release_id_format', `manifest.releaseId "${manifest.releaseId}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (!isValidReleaseId(manifest.revision)) {
        fail('invalid_release_id_format', `manifest.revision "${manifest.revision}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      const dirBasename = path.basename(dir);
      if (manifest.releaseId !== dirBasename) {
        fail('release_id_mismatch', `manifest.releaseId "${manifest.releaseId}" does not match the release directory basename "${dirBasename}".`);
      }
      if (manifest.revision !== manifest.releaseId) {
        fail('revision_mismatch', `manifest.revision "${manifest.revision}" does not equal manifest.releaseId "${manifest.releaseId}".`);
      }
    }
  }

  // ── Rule A (reuse v3 checks): attributes ids + export duality ────────────
  {
    const seenAttrIds = new Set<string>();
    for (const attr of attributes) {
      if (!SLUG_RELEASE_ID_RE.test(attr.id)) {
        fail('invalid_attribute_id_format', `Attribute id "${attr.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seenAttrIds.has(attr.id)) {
        fail('duplicate_attribute_id', `Duplicate attribute id "${attr.id}".`);
      }
      seenAttrIds.add(attr.id);
      if (attr.exportDisposition === undefined) {
        fail('attribute_missing_export_disposition', `Attribute "${attr.id}" has no exportDisposition.`);
      } else if (attr.exportDisposition.kind === 'shopsite' && attr.exportDisposition.catalogField.trim().length === 0) {
        fail('attribute_empty_export_field', `Attribute "${attr.id}" has a shopsite disposition with an empty catalogField.`);
      }

      if (attr.valueMode === 'controlled') {
        const seenValues = new Set<string>();
        for (const value of attr.allowedValues) {
          if (seenValues.has(value)) {
            fail('duplicate_allowed_value', `Attribute "${attr.id}" has duplicate allowed value "${value}".`);
          }
          seenValues.add(value);
        }
        for (const alias of attr.valueAliases) {
          if (!seenValues.has(alias.mapsTo)) {
            fail('unresolved_value_alias', `Attribute "${attr.id}" alias "${alias.alias}" maps to unknown value "${alias.mapsTo}".`);
          }
        }
      }

      if (attr.valueMode === 'measured' && (!attr.canonicalUnit || attr.canonicalUnit.trim().length === 0)) {
        fail('measured_attribute_missing_unit', `Measured attribute "${attr.id}" has no canonicalUnit.`);
      }
    }

    const expectedByAttribute = new Map<string, string>();
    for (const attr of attributes) {
      if (attr.exportDisposition?.kind === 'shopsite') {
        expectedByAttribute.set(attr.id, attr.exportDisposition.catalogField);
      }
    }
    const actualByAttribute = new Map<string, string[]>();
    for (const mapping of exportMappings) {
      const existing = actualByAttribute.get(mapping.attributeId) ?? [];
      existing.push(mapping.catalogField);
      actualByAttribute.set(mapping.attributeId, existing);
    }
    for (const [attributeId, expectedField] of expectedByAttribute) {
      const actualFields = actualByAttribute.get(attributeId);
      if (!actualFields || actualFields.length === 0) {
        fail('export_mapping_missing', `Attribute "${attributeId}" has a shopsite exportDisposition but no export mapping.`);
      } else if (actualFields.length > 1) {
        fail('duplicate_export_mapping', `Attribute "${attributeId}" has ${actualFields.length} export mappings; exactly one is required.`);
      } else if (actualFields[0] !== expectedField) {
        fail('export_mapping_mismatch', `Attribute "${attributeId}" maps to "${actualFields[0]}" but exportDisposition declares "${expectedField}".`);
      }
    }
    for (const [attributeId, actualFields] of actualByAttribute) {
      const attr = attributes.find(a => a.id === attributeId);
      if (!attr) continue;
      if (attr.exportDisposition?.kind !== 'shopsite') {
        fail('export_mapping_forbidden', `Attribute "${attributeId}" has ${actualFields.length} export mapping(s) but disposition is "${attr.exportDisposition?.kind ?? 'missing'}".`);
        continue;
      }
      for (const field of actualFields) {
        if (field !== attr.exportDisposition.catalogField) {
          fail('export_mapping_mismatch', `Attribute "${attributeId}" maps to "${field}" but exportDisposition declares "${attr.exportDisposition.catalogField}".`);
        }
      }
    }
  }

  // ── Rule A2 (P2 disposition codification): exported ⇔ proposer ──────────
  {
    const profiledAttributeIds = new Set<string>();
    for (const profile of facetProfiles) {
      for (const pa of profile.attributes) profiledAttributeIds.add(pa.attributeId);
    }
    assertExportedAttributesHaveProposers(fail, attributes, profiledAttributeIds);

    const retiredNow = currentlyRetiredAttributeIds(attributes, profiledAttributeIds);
    findings.push(
      ...collectRetireCandidateWarnings(dir, manifest?.sourceBaseline, retiredNow),
    );
  }

  // ── Rule 10: species-safety cross-check ──────────────────────────────────
  {
    const dogGroup = hierarchy.find(n => n.id === 'dog');
    const catGroup = hierarchy.find(n => n.id === 'cat');
    if (dogGroup && catGroup) {
      const dogTypes = new Set(dogGroup.legacyTypeIds);
      const catTypes = new Set(catGroup.legacyTypeIds);
      const overlap = [...dogTypes].filter(id => catTypes.has(id));
      if (overlap.length > 0) {
        fail('species_safety_overlap', `Dog and cat groups share legacy types: ${overlap.join(', ')}.`);
      }
    }
  }

  // ── Rule 10b: scope inheritance safety (ChatGPT fix-phase review #4) ────
  {
    const nodeByIdMap = new Map(hierarchy.map(n => [n.id, n]));
    const declaredScope = (n: TNode | undefined): string | null => n?.scope?.animalDomain ?? null;
    const effectiveScope = (n: TNode | undefined): string | null => {
      let cursor: TNode | undefined = n;
      const visited = new Set<string>();
      while (cursor) {
        if (visited.has(cursor.id)) return null; // cycle rule reports it
        visited.add(cursor.id);
        const s = declaredScope(cursor);
        if (s) return s;
        cursor = cursor.parentId ? nodeByIdMap.get(cursor.parentId) : undefined;
      }
      return null;
    };
    for (const node of hierarchy) {
      const own = declaredScope(node);
      const ancestorScope = node.parentId ? effectiveScope(nodeByIdMap.get(node.parentId)!) : null;
      const inherited = own ?? ancestorScope;
      if (own && ancestorScope && own !== ancestorScope) {
        fail('scope_conflict', `Node "${node.id}" declares scope ${own} but inherits ${ancestorScope} from its ancestor.`);
      }
      if (node.classifiable && inherited === 'dog' && !isDescendantOf(node.id, 'dog', nodeByIdMap)) {
        fail('scope_escape', `Classifiable node "${node.id}" inherits dog scope but is not a descendant of dog.`);
      }
      if (node.classifiable && inherited === 'cat' && !isDescendantOf(node.id, 'cat', nodeByIdMap)) {
        fail('scope_escape', `Classifiable node "${node.id}" inherits cat scope but is not a descendant of cat.`);
      }
    }
    const deer = hierarchy.find(n => n.id === 'deer-wildlife-feed');
    if (deer && isDescendantOf('deer-wildlife-feed', 'wild-bird', nodeByIdMap)) {
      fail('scope_escape', 'deer-wildlife-feed must not be a descendant of the wild-bird family (wildlife is a separate partition).');
    }
    const fishFood = hierarchy.find(n => n.id === 'fish-food');
    if (fishFood && !isDescendantOf('fish-food', 'fish', nodeByIdMap)) {
      fail('scope_escape', 'fish-food must be a descendant of the fish browse node.');
    }
  }

  // ── Rule B: guidance ids unique; page-assignment-policy validity ─────────
  {
    const seenGuidanceIds = new Set<string>();
    const knownNodeIds = new Set(hierarchy.map(n => n.id));
    const knownDeptIds = new Set(hierarchy.filter(n => n.parentId === null).map(n => n.id));
    for (const g of guidance) {
      if (seenGuidanceIds.has(g.id)) {
        fail('duplicate_guidance_id', `Duplicate guidance id "${g.id}".`);
      }
      seenGuidanceIds.add(g.id);

      const structured = (g.structured ?? {}) as Record<string, unknown>;
      if (typeof structured.productTypeIds === 'string') {
        fail('guidance_invalid_type_ref', `Guidance "${g.id}" productTypeIds must be an array.`);
      } else if (Array.isArray(structured.productTypeIds)) {
        for (const ref of structured.productTypeIds) {
          if (typeof ref === 'string' && !knownNodeIds.has(ref)) {
            fail('guidance_unknown_type_ref', `Guidance "${g.id}" references unknown product type "${ref}".`);
          }
        }
      }
      if (typeof structured.departmentIds === 'string') {
        fail('guidance_invalid_department_ref', `Guidance "${g.id}" departmentIds must be an array.`);
      } else if (Array.isArray(structured.departmentIds)) {
        for (const ref of structured.departmentIds) {
          if (typeof ref === 'string' && !knownDeptIds.has(ref)) {
            fail('guidance_unknown_department_ref', `Guidance "${g.id}" references unknown department "${ref}".`);
          }
        }
      }
    }
    if (pagePolicy) {
      if (!Number.isInteger(pagePolicy.maxPagesPerProduct) || pagePolicy.maxPagesPerProduct <= 0) {
        fail('invalid_max_pages', 'page-assignment-policy maxPagesPerProduct must be a positive integer.');
      }
      if (!Array.isArray(pagePolicy.allowedSpecies) || pagePolicy.allowedSpecies.length === 0) {
        fail('invalid_allowed_species', 'page-assignment-policy allowedSpecies must be a non-empty array of strings.');
      }
    }
  }

  // ── Rule B2: envelope origin consistency ────────────────────────────────
  {
    const originOf = (fileName: string): ClassificationBundleOriginV2 | null => {
      const raw = rawFiles[fileName];
      if (!raw || typeof raw !== 'object') return null;
      const origin = (raw as Record<string, unknown>).bundleOrigin;
      if (!origin) return null;
      const parsed = ClassificationBundleOriginV2Schema.safeParse(origin);
      return parsed.success ? parsed.data : null;
    };
    const envelopeOrigins = [
      originOf('hierarchy.json'),
      originOf('facet-profiles.json'),
      originOf('legacy-mappings.json'),
      originOf('attributes.json'),
      originOf('shopsite-projection.json'),
      originOf('export-mappings.json'),
      originOf('guidance.json'),
    ].filter((o): o is ClassificationBundleOriginV2 => o !== null);
    if (envelopeOrigins.length > 0) {
      const firstOriginJson = JSON.stringify(envelopeOrigins[0]);
      for (const origin of envelopeOrigins) {
        if (JSON.stringify(origin) !== firstOriginJson) {
          fail('inconsistent_release_origin', 'Focused release files declare inconsistent bundle origins.');
          break;
        }
        if (origin.kind !== 'release') {
          fail('non_release_origin', `Focused file declares bundleOrigin.kind "${origin.kind}"; a taxonomy release must use kind "release".`);
          break;
        }
      }
      if (manifest && envelopeOrigins[0].kind === 'release' && envelopeOrigins[0].releaseId !== manifest.releaseId) {
        fail('release_origin_mismatch', `Focused files declare releaseId "${envelopeOrigins[0].releaseId}" but manifest declares "${manifest.releaseId}".`);
      }
    }
  }

  report.ok = findings.every(f => f.severity !== 'error');
  report.counts = {
    productTypes: hierarchy.filter(n => n.classifiable).length,
    attributes: attributes.length,
    attributeProfiles: facetProfiles.length,
    departments: hierarchy.filter(n => n.parentId === null).length,
    mappings: exportMappings.length,
  };

  return {
    report,
    parsed: {
      manifest,
      hierarchy,
      facetProfiles,
      legacyMappings,
      attributes,
      exportMappings,
      pageProjections,
      guidance,
      pagePolicy,
    },
  };
}

/**
 * Validate a v4 canonical-hierarchy release directory.
 */
export function validateTaxonomyReleaseV4(releaseDir: string): ReleaseValidationReport {
  const { report } = validateCanonicalHierarchyReleaseCore(releaseDir, V4HierarchySchema);
  return report;
}

/**
 * Parse a validated v4 release into a structured bundle. THROWS
 * `ReleaseValidationError` (code `release_invalid`) when the release has any
 * `error`-severity finding.
 */
export function loadTaxonomyReleaseV4(releaseDir: string): TaxonomyReleaseBundleV4 {
  const report = validateTaxonomyReleaseV4(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release v4 "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }

  const dir = resolveReleaseDir(releaseDir);
  const read = (fileName: string) => JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));

  return {
    manifest: V4ManifestSchema.parse(read('manifest.json')),
    hierarchy: V4HierarchySchema.parse(read('hierarchy.json')).entries,
    facetProfiles: V4FacetProfilesSchema.parse(read('facet-profiles.json')).entries,
    legacyMappings: V4LegacyMappingsSchema.parse(read('legacy-mappings.json')).entries,
    attributes: AttributesFileV2Schema.parse(read('attributes.json')).entries,
    exportMappings: AttributeMappingsFileV2Schema.parse(read('export-mappings.json')).entries,
    pageProjections: V4ShopsiteProjectionSchema.parse(read('shopsite-projection.json')).entries,
    guidance: GuidanceFileV2Schema.parse(read('guidance.json')).entries,
    pageAssignmentPolicy: PageAssignmentPolicyV2Schema.parse(read('page-assignment-policy.json')),
  };
}

/**
 * Assert a v4 release is valid. THROWS `ReleaseValidationError` on any
 * `error`-severity finding; otherwise returns the validation report.
 */
export function assertReleaseValidV4(releaseDir: string): ReleaseValidationReport {
  const report = validateTaxonomyReleaseV4(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release v4 "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }
  return report;
}

/**
 * Validate a v5 release bundle directory.
 * Preserves all canonical hierarchy validation rules from the core validator, while
 * strictly validating `invariantAttributes` on leaf nodes:
 * 1. Non-classifiable nodes must not define non-empty `invariantAttributes`.
 * 2. Invariants must reference known attributes.
 * 3. Invariants must be applicable to the node's facet profile (or universal).
 * 4. Invariants must match single vs array cardinality shapes.
 * 5. Invariants on controlled attributes must only use allowedValues.
 */
export function validateTaxonomyReleaseV5(releaseDir: string): ReleaseValidationReport {
  const { report, parsed } = validateCanonicalHierarchyReleaseCore(releaseDir, V5HierarchySchema);
  const fail = (code: string, message: string) => {
    report.findings.push({ code, message, severity: 'error' });
    report.ok = false;
  };

  const { hierarchy, facetProfiles, attributes } = parsed;
  const attributeById = new Map(attributes.map(a => [a.id, a]));
  const profileById = new Map(facetProfiles.map(p => [p.id, p]));

  for (const node of hierarchy) {
    const invAttrs = node.invariantAttributes ?? {};
    const invEntries = Object.entries(invAttrs);

    // Rule 1: Non-classifiable nodes must not define non-empty invariantAttributes
    if (!node.classifiable) {
      if (invEntries.length > 0) {
        fail(
          'invariant_attributes_on_non_classifiable_node',
          `Non-classifiable node "${node.id}" must not have invariantAttributes (found: ${Object.keys(invAttrs).join(', ')}). Invariants are only permitted on classifiable leaf nodes.`,
        );
      }
      continue;
    }

    if (invEntries.length === 0) continue;

    const profile = node.facetProfileId ? profileById.get(node.facetProfileId) : undefined;
    for (const [attrId, rawVal] of invEntries) {
      const attr = attributeById.get(attrId);
      if (!attr) {
        fail('unknown_invariant_attribute', `Hierarchy node "${node.id}" defines invariant for unknown attribute "${attrId}".`);
        continue;
      }

      const isUniversal = attr.isUniversal === true;
      const profileAttr = profile?.attributes.find(a => a.attributeId === attrId);

      if (!isUniversal && !profileAttr) {
        fail(
          'invariant_attribute_not_applicable',
          `Attribute "${attrId}" is an invariant for node "${node.id}" but is not in facet profile "${node.facetProfileId}" or universal.`,
        );
      }

      const cardinality = profileAttr?.cardinality ?? 'single';
      if (cardinality === 'single' && Array.isArray(rawVal)) {
        fail('invariant_cardinality_mismatch', `Single-cardinality attribute "${attrId}" on node "${node.id}" cannot have an array invariant value.`);
      } else if (cardinality === 'multiple' && !Array.isArray(rawVal)) {
        fail('invariant_cardinality_mismatch', `Multiple-cardinality attribute "${attrId}" on node "${node.id}" requires a non-empty array invariant value.`);
      }

      if (attr.valueMode === 'controlled') {
        const valuesToCheck = Array.isArray(rawVal) ? rawVal : [rawVal];
        for (const val of valuesToCheck) {
          if (!attr.allowedValues.includes(String(val))) {
            fail(
              'invalid_invariant_controlled_value',
              `Invariant value "${val}" on node "${node.id}" is not in allowedValues for controlled attribute "${attrId}".`,
            );
          }
        }
      }
    }
  }

  return report;
}

/**
 * Parse a validated v5 release into a structured bundle.
 */
export function loadTaxonomyReleaseV5(releaseDir: string): TaxonomyReleaseBundleV5 {
  const report = validateTaxonomyReleaseV5(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release v5 "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }

  const dir = resolveReleaseDir(releaseDir);
  const read = (fileName: string) => JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));

  return {
    manifest: V4ManifestSchema.parse(read('manifest.json')),
    hierarchy: V5HierarchySchema.parse(read('hierarchy.json')).entries,
    facetProfiles: V4FacetProfilesSchema.parse(read('facet-profiles.json')).entries,
    legacyMappings: V4LegacyMappingsSchema.parse(read('legacy-mappings.json')).entries,
    attributes: AttributesFileV2Schema.parse(read('attributes.json')).entries,
    exportMappings: AttributeMappingsFileV2Schema.parse(read('export-mappings.json')).entries,
    pageProjections: V4ShopsiteProjectionSchema.parse(read('shopsite-projection.json')).entries,
    guidance: GuidanceFileV2Schema.parse(read('guidance.json')).entries,
    pageAssignmentPolicy: PageAssignmentPolicyV2Schema.parse(read('page-assignment-policy.json')),
  };
}

/**
 * Assert a v5 release is valid.
 */
export function assertReleaseValidV5(releaseDir: string): ReleaseValidationReport {
  const report = validateTaxonomyReleaseV5(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release v5 "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }
  return report;
}
