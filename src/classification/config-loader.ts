import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  AttributeMappingsFileV2Schema,
  AttributeProfilesFileV2Schema,
  AttributesFileV2Schema,
  BrandConfigV2Schema,
  BrandsFileV2Schema,
  ClassificationConfigBundleV2Schema,
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  CurationTargetConfigV2Schema,
  CurationTargetsFileV2Schema,
  DataSharingConfigV2Schema,
  DataSharingFileV2Schema,
  GuidanceFileV2Schema,
  ModelPolicyConfigV2Schema,
  ModelPolicyFileV2Schema,
  ProductTypesFileV2Schema,
  type ClassificationConfig,
  type ClassificationConfigBundleV2,
  type ClassificationFocusedFileName,
} from '../shared/schemas/classification';
import { canonicalJsonFileString, hashCanonicalJson } from '../shared/stable-id';
import {
  LegacyClassificationConfigV1Schema,
  type LegacyClassificationConfigV1,
} from './config-migrate-v1';
import {
  createCatalogEvidenceVerifier,
  readLiveCatalogFields,
} from './catalog-evidence';
import { listVerifiedPageOptions } from '../db/repositories/page-repo';
import {
  validateClassificationConfigBundle,
  type CatalogEvidenceVerifier,
  type ClassificationConfigValidationOptions,
} from './config-validation';
import { assertTaxonomyMutable } from './taxonomy-freeze';
import { readWorkspaceState, DEFAULT_TAXONOMY_REVISION } from './workspace-state';
import {
  V4_TAXONOMY_REVISION,
  V5_TAXONOMY_REVISION,
  compileTaxonomyReleaseV4,
  compileTaxonomyReleaseV5,
} from './release-compiler';
import { loadTaxonomyReleaseV4, loadTaxonomyReleaseV5 } from './release-validation';
import {
  buildV4ShadowDiffSummary,
  isTaxonomyV4ShadowEnabled,
  recordV4ShadowObservation,
} from './release-shadow';

const CLASSIFICATION_DIR = 'classification';

export type ClassificationConfigLoadErrorCode =
  | 'not_configured'
  | 'missing_file'
  | 'read_error'
  | 'write_error'
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_config'
  | 'hash_mismatch';

export class ClassificationConfigLoadError extends Error {
  constructor(
    readonly code: ClassificationConfigLoadErrorCode,
    message: string,
    readonly filePath: string | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ClassificationConfigLoadError';
  }
}

export class ClassificationConfigNotConfiguredError extends ClassificationConfigLoadError {
  constructor(workspacePath: string) {
    super(
      'not_configured',
      `No classification configuration is present under ${path.join(workspacePath, 'store', CLASSIFICATION_DIR)}.`,
      null,
    );
    this.name = 'ClassificationConfigNotConfiguredError';
  }
}

export function classificationDir(workspacePath: string): string {
  return path.join(workspacePath, 'store', CLASSIFICATION_DIR);
}

interface CheckedDirectory {
  path: string;
  realPath: string;
}

interface ReadFileResult {
  path: string;
  bytes: Uint8Array;
  text: string;
  value: unknown;
}

function fsErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}

function checkedWorkspaceRoot(workspacePath: string): CheckedDirectory {
  const absolutePath = path.resolve(workspacePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ClassificationConfigLoadError(
        'read_error',
        `Workspace root must be a real directory: ${absolutePath}`,
        absolutePath,
      );
    }
    return { path: absolutePath, realPath: fs.realpathSync.native(absolutePath) };
  } catch (error) {
    if (error instanceof ClassificationConfigLoadError) throw error;
    throw new ClassificationConfigLoadError(
      'read_error',
      `Unable to inspect workspace root ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }
}

/** Inspect one direct child without ever following a symlinked component. */
function checkedChildDirectory(parent: CheckedDirectory, name: string): CheckedDirectory | null {
  const childPath = path.join(parent.path, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(childPath);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw new ClassificationConfigLoadError(
      'read_error',
      `Unable to inspect directory component ${childPath}: ${error instanceof Error ? error.message : String(error)}`,
      childPath,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ClassificationConfigLoadError(
      'read_error',
      `Directory component must be a real directory: ${childPath}`,
      childPath,
    );
  }
  try {
    const realPath = fs.realpathSync.native(childPath);
    if (path.dirname(realPath) !== parent.realPath) {
      throw new ClassificationConfigLoadError(
        'read_error',
        `Directory component escapes its verified parent: ${childPath}`,
        childPath,
      );
    }
    return { path: childPath, realPath };
  } catch (error) {
    if (error instanceof ClassificationConfigLoadError) throw error;
    throw new ClassificationConfigLoadError(
      'read_error',
      `Unable to resolve directory component ${childPath}: ${error instanceof Error ? error.message : String(error)}`,
      childPath,
    );
  }
}

export function checkedClassificationDirectory(workspacePath: string): CheckedDirectory {
  const workspace = checkedWorkspaceRoot(workspacePath);
  const store = checkedChildDirectory(workspace, 'store');
  if (!store) throw new ClassificationConfigNotConfiguredError(workspacePath);
  const dir = checkedChildDirectory(store, CLASSIFICATION_DIR);
  if (!dir) throw new ClassificationConfigNotConfiguredError(workspacePath);
  return dir;
}

function createCheckedChildDirectory(parent: CheckedDirectory, name: string): CheckedDirectory {
  const existing = checkedChildDirectory(parent, name);
  if (existing) return existing;
  const childPath = path.join(parent.path, name);
  try {
    // Never use recursive mkdir: every ancestor has already been verified as a
    // real contained directory, and this creates exactly one direct child.
    fs.mkdirSync(childPath);
  } catch (error) {
    throw new ClassificationConfigLoadError(
      'write_error',
      `Unable to create classification directory component ${childPath}: ${error instanceof Error ? error.message : String(error)}`,
      childPath,
    );
  }
  const created = checkedChildDirectory(parent, name);
  if (!created) {
    throw new ClassificationConfigLoadError(
      'write_error',
      `Classification directory component was not created: ${childPath}`,
      childPath,
    );
  }
  return created;
}

export function checkedClassificationDirectoryForWrite(workspacePath: string): CheckedDirectory {
  const workspace = checkedWorkspaceRoot(workspacePath);
  const store = createCheckedChildDirectory(workspace, 'store');
  return createCheckedChildDirectory(store, CLASSIFICATION_DIR);
}

function decodeUtf8Strict(bytes: Uint8Array, filePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ClassificationConfigLoadError(
      'invalid_json',
      `Classification file is not valid UTF-8: ${filePath}`,
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Open a contained regular file once, reject final-component symlinks with
 * O_NOFOLLOW where the platform supports it, fstat the opened descriptor, and
 * hash/parse the same bytes. Node has no openat API, so directory replacement
 * cannot be made impossible here; the realpath/lstat/open/fstat checks minimize
 * that transitional risk until the atomic config store owns a locked directory.
 */
function readRequiredFile(dir: CheckedDirectory, fileName: string): ReadFileResult {
  if (path.basename(fileName) !== fileName) {
    throw new ClassificationConfigLoadError('read_error', `Invalid classification filename: ${fileName}`, dir.path);
  }
  const filePath = path.join(dir.path, fileName);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir.path)) {
    throw new ClassificationConfigLoadError('read_error', `Classification file escapes its directory: ${filePath}`, filePath);
  }

  let descriptor: number | null = null;
  try {
    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      throw new ClassificationConfigLoadError(
        'read_error',
        `Classification path is not a real regular file: ${filePath}`,
        filePath,
      );
    }
    const realPath = fs.realpathSync.native(filePath);
    if (path.dirname(realPath) !== dir.realPath) {
      throw new ClassificationConfigLoadError(
        'read_error',
        `Classification file escapes its directory: ${filePath}`,
        filePath,
      );
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) {
      throw new ClassificationConfigLoadError(
        'read_error',
        `Opened classification path is not a regular file: ${filePath}`,
        filePath,
      );
    }
    const buffer = fs.readFileSync(descriptor);
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const text = decodeUtf8Strict(bytes, filePath);
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ClassificationConfigLoadError(
        'invalid_json',
        `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        filePath,
      );
    }
    return { path: filePath, bytes, text, value };
  } catch (error) {
    if (error instanceof ClassificationConfigLoadError) throw error;
    const code = fsErrorCode(error);
    throw new ClassificationConfigLoadError(
      code === 'ENOENT' ? 'missing_file' : 'read_error',
      `${code === 'ENOENT' ? 'Required classification file is missing' : 'Unable to read classification file'} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* original read result/error wins */ }
    }
  }
}

function readManifest(workspacePath: string): { dir: CheckedDirectory; file: ReadFileResult } {
  const dir = checkedClassificationDirectory(workspacePath);
  try {
    const entries = fs.readdirSync(dir.path);
    if (!entries.includes('manifest.json')) {
      if (entries.length === 0) throw new ClassificationConfigNotConfiguredError(workspacePath);
      throw new ClassificationConfigLoadError(
        'missing_file',
        `Classification directory contains files but has no manifest.json: ${dir.path}`,
        path.join(dir.path, 'manifest.json'),
      );
    }
  } catch (error) {
    if (error instanceof ClassificationConfigLoadError) throw error;
    throw new ClassificationConfigLoadError(
      'read_error',
      `Unable to list classification directory ${dir.path}: ${error instanceof Error ? error.message : String(error)}`,
      dir.path,
    );
  }
  return { dir, file: readRequiredFile(dir, 'manifest.json') };
}

function manifestVersion(value: unknown, manifestPath: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClassificationConfigLoadError('invalid_config', 'Classification manifest must be an object.', manifestPath);
  }
  const version = (value as Record<string, unknown>).schemaVersion;
  if (!Number.isInteger(version)) {
    throw new ClassificationConfigLoadError('invalid_config', 'Classification manifest schemaVersion must be an integer.', manifestPath);
  }
  return Number(version);
}

function loadLegacyV1FromManifest(
  workspacePath: string,
  manifest: ReturnType<typeof readManifest>,
): LegacyClassificationConfigV1 {
  const files = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, readRequiredFile(manifest.dir, fileName).value]),
  ) as Record<ClassificationFocusedFileName, unknown>;
  const candidate = {
    manifest: manifest.file.value,
    productTypes: files['product-types.json'],
    attributes: files['attributes.json'],
    attributeProfiles: files['attribute-profiles.json'],
    attributeMappings: files['mappings.json'],
    curationTargets: files['curation-targets.json'],
    brands: files['brands.json'],
    guidance: files['guidance.json'],
    modelPolicy: files['model-policies.json'],
    dataSharing: files['data-sharing.json'],
  };
  const parsed = LegacyClassificationConfigV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      `Legacy v1 classification configuration is invalid under ${classificationDir(workspacePath)}.`,
      manifest.file.path,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** Migration-only reader for the complete legacy bare-file bundle. */
export function loadLegacyV1ConfigForMigration(workspacePath: string): LegacyClassificationConfigV1 {
  const manifest = readManifest(workspacePath);
  const version = manifestVersion(manifest.file.value, manifest.file.path);
  if (version !== 1) {
    throw new ClassificationConfigLoadError(
      'unsupported_version',
      `Expected a legacy v1 classification manifest, found schemaVersion ${version}.`,
      manifest.file.path,
    );
  }
  return loadLegacyV1FromManifest(workspacePath, manifest);
}

/**
 * Explicit temporary runtime path. The canonical catalog is still v1 until the
 * atomic store and native-v2 runtime milestones land; naming this boundary
 * prevents it from being mistaken for the long-term active contract.
 */
export function loadStrictLegacyV1RuntimeConfig(workspacePath: string): ClassificationConfig {
  return loadLegacyV1ConfigForMigration(workspacePath) as ClassificationConfig;
}

function parseEnvelope<T>(
  file: ReadFileResult,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } },
): T {
  const parsed = schema.safeParse(file.value);
  if (!parsed.success) {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      `Invalid v2 classification file ${file.path}.`,
      file.path,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export type LoadClassificationConfigBundleV2Options =
  Omit<ClassificationConfigValidationOptions, 'focusedFileContents' | 'mode'>;

/**
 * Verified activation context required by the active loader. Milestone 3
 * supplies the catalog-evidence verifier backed by the committed evidence
 * artifact; until then active loading fails closed without it.
 */
export interface VerifiedActivationContext {
  /** Attested live Catalog Field set from a product export/field registry. */
  catalogFields: Iterable<string>;
  /** Stable IDs from an active, verified Page import. */
  verifiedPageIds?: Iterable<string>;
  /** Qualification receipts already verified by the benchmark subsystem. */
  verifiedQualificationReceiptDigests?: Iterable<string>;
  /**
   * Binds manifest.catalogEvidenceHash to the attested field set and source
   * catalog commit. When omitted, active validation fails closed.
   */
  verifyCatalogEvidence?: CatalogEvidenceVerifier;
  /**
   * Activation-time tree integrity gate: re-scans the workspace and verifies
   * the catalog tree still matches the evidence artifact hash. When present,
   * the config-store runs it before the atomic swap (Milestone 7).
   */
  verifyCatalogEvidenceTree?: (expectedArtifactHash: string) => Promise<{ verified: boolean; reason?: string }>;
}

function loadClassificationConfigBundleV2Internal(
  workspacePath: string,
  mode: 'preview' | 'active',
  options: LoadClassificationConfigBundleV2Options,
): ClassificationConfigBundleV2 {
  const manifest = readManifest(workspacePath);
  const version = manifestVersion(manifest.file.value, manifest.file.path);
  if (version !== 2) {
    throw new ClassificationConfigLoadError(
      'unsupported_version',
      `Expected classification schemaVersion 2, found ${version}.`,
      manifest.file.path,
    );
  }
  const manifestParsed = ClassificationManifestV2Schema.safeParse(manifest.file.value);
  if (!manifestParsed.success) {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      'Invalid v2 classification manifest.',
      manifest.file.path,
      manifestParsed.error.issues,
    );
  }
  if (mode === 'preview' && manifestParsed.data.lifecycle === 'active') {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      'A lifecycle-active bundle cannot be returned by the preview loader; use loadActiveClassificationConfigBundleV2 with a verified activation context.',
      manifest.file.path,
      ['active_bundle_preview_load'],
    );
  }
  if (mode === 'active' && manifestParsed.data.lifecycle !== 'active') {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      'Only lifecycle-active bundles can be loaded by the active loader.',
      manifest.file.path,
      ['active_lifecycle_required'],
    );
  }

  const raw = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, readRequiredFile(manifest.dir, fileName)]),
  ) as Record<ClassificationFocusedFileName, ReadFileResult>;

  const productTypesFile = parseEnvelope(raw['product-types.json'], ProductTypesFileV2Schema);
  const attributesFile = parseEnvelope(raw['attributes.json'], AttributesFileV2Schema);
  const attributeProfilesFile = parseEnvelope(raw['attribute-profiles.json'], AttributeProfilesFileV2Schema);
  const attributeMappingsFile = parseEnvelope(raw['mappings.json'], AttributeMappingsFileV2Schema);
  const curationTargetsFile = parseEnvelope(raw['curation-targets.json'], CurationTargetsFileV2Schema);
  const brandsFile = parseEnvelope(raw['brands.json'], BrandsFileV2Schema);
  const guidanceFile = parseEnvelope(raw['guidance.json'], GuidanceFileV2Schema);
  const modelPolicyFile = parseEnvelope(raw['model-policies.json'], ModelPolicyFileV2Schema);
  const dataSharingFile = parseEnvelope(raw['data-sharing.json'], DataSharingFileV2Schema);
  const envelopes = [
    productTypesFile,
    attributesFile,
    attributeProfilesFile,
    attributeMappingsFile,
    curationTargetsFile,
    brandsFile,
    guidanceFile,
    modelPolicyFile,
    dataSharingFile,
  ];
  const originHashes = new Set(envelopes.map(envelope => hashCanonicalJson(envelope.bundleOrigin)));
  if (originHashes.size !== 1) {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      'Focused classification files declare inconsistent bundle origins.',
      manifest.file.path,
      ['focused_file_origin_mismatch'],
    );
  }

  const structurallyParsed = ClassificationConfigBundleV2Schema.safeParse({
    manifest: manifestParsed.data,
    bundleOrigin: productTypesFile.bundleOrigin,
    productTypes: productTypesFile.entries,
    attributes: attributesFile.entries,
    attributeProfiles: attributeProfilesFile.entries,
    attributeMappings: attributeMappingsFile.entries,
    curationTargets: curationTargetsFile.entries,
    brands: brandsFile.entries,
    guidance: guidanceFile.entries,
    modelPolicy: modelPolicyFile.policy,
    dataSharing: dataSharingFile.policy,
  });
  if (!structurallyParsed.success) {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      'The v2 classification bundle is structurally invalid.',
      manifest.file.path,
      structurallyParsed.error.issues,
    );
  }

  const report = validateClassificationConfigBundle(structurallyParsed.data, {
    ...options,
    mode,
    focusedFileContents: Object.fromEntries(
      ClassificationFocusedFileNames.map(fileName => [fileName, raw[fileName].bytes]),
    ),
  });
  // An enabled Page target without a verified Page catalog is a NOT-READY
  // condition, not a corrupt bundle: the run-start readiness gate (issue #17 L)
  // blocks run creation, while configuration UI/readiness can still load and
  // report the finding. All other error findings remain fatal.
  const toleratedNotReady = (finding: { severity: string; code: string }) =>
    finding.code === 'verified_page_catalog_required';
  const fatalFindings = report.findings.filter(
    finding => finding.severity === 'error' && !toleratedNotReady(finding),
  );
  if (fatalFindings.length > 0) {
    const hashFailure = report.findings.some(finding => (
      finding.code === 'file_hash_mismatch' || finding.code === 'bundle_hash_mismatch'
    ));
    throw new ClassificationConfigLoadError(
      hashFailure ? 'hash_mismatch' : 'invalid_config',
      `The v2 classification bundle failed ${hashFailure ? 'integrity' : 'semantic'} validation.`,
      manifest.file.path,
      report.findings,
    );
  }
  // When the only error findings were tolerated not-ready conditions the
  // validation report carries no `config`; the structurally parsed bundle is
  // authoritative in that case.
  return report.config ?? structurallyParsed.data;
}

/**
 * Preview loader. Never returns a lifecycle-active bundle; an on-disk active
 * bundle fails closed here instead of being inspected as a preview.
 */
export function loadClassificationConfigBundleV2Preview(
  workspacePath: string,
  options: LoadClassificationConfigBundleV2Options = {},
): ClassificationConfigBundleV2 {
  return loadClassificationConfigBundleV2Internal(workspacePath, 'preview', options);
}

/**
 * Active loader. Requires the caller-supplied verified activation context;
 * active loading without catalog/evidence/Page/receipt verification fails
 * closed. The catalog-evidence binding verifier is supplied by Milestone 3.
 */
export function loadActiveClassificationConfigBundleV2(
  workspacePath: string,
  activationContext: VerifiedActivationContext,
): ClassificationConfigBundleV2 {
  return loadClassificationConfigBundleV2Internal(workspacePath, 'active', {
    catalogFields: activationContext.catalogFields,
    verifiedPageIds: activationContext.verifiedPageIds,
    verifiedQualificationReceiptDigests: activationContext.verifiedQualificationReceiptDigests,
    verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
  });
}

/**
 * Current legacy runtime API. V1 remains explicit transitional compatibility;
 * v2 is refused here so native safety/provenance/ML/serialization semantics
 * cannot be silently adapted away before Milestones 4–5.
 * Deletable after last v1/v3 workspace migration; see docs/audits/gen1-retirement-record.md.
 */
export function loadClassificationConfig(workspacePath: string): ClassificationConfig {
  const manifest = readManifest(workspacePath);
  const version = manifestVersion(manifest.file.value, manifest.file.path);
  if (version === 1) return loadLegacyV1FromManifest(workspacePath, manifest) as ClassificationConfig;
  if (version === 2) {
    throw new ClassificationConfigLoadError(
      'unsupported_version',
      'V2 configuration is not available through the legacy runtime adapter; use the native v2 snapshot path.',
      manifest.file.path,
    );
  }
  throw new ClassificationConfigLoadError(
    'unsupported_version',
    `Unsupported classification schemaVersion ${version}.`,
    manifest.file.path,
  );
}

// ─── Runtime config authority (Milestone 7) ───────────────────────────────────

/**
 * P4 (plan B.P4.1): read the workspace's active-taxonomy pin. Returns null
 * when no state.json exists. A malformed state file fails closed (the pin is
 * the ONLY sanctioned release reference, so a corrupt one must never be
 * silently ignored in favor of a stale workspace bundle).
 */
function readActiveRevisionPin(workspacePath: string): string | null {
  return readWorkspaceState(workspacePath)?.activeTaxonomyRevision ?? null;
}

/** Compile the pinned release (bay-state-v4 or bay-state-v5) into the runtime authority. Fail closed on validation failure. Store-local concerns (brands, modelPolicy, dataSharing, curationTargets) overlay after hashing so bundleHash stays pure-taxonomy. */
function loadPinnedReleaseAuthority(workspacePath: string, pinnedRevision: string): RuntimeConfigAuthority {
  const compiled =
    pinnedRevision === V5_TAXONOMY_REVISION
      ? compileTaxonomyReleaseV5(loadTaxonomyReleaseV5('bay-state-v5'))
      : compileTaxonomyReleaseV4(loadTaxonomyReleaseV4('bay-state-v4'));

  if (compiled.taxonomyRevision !== pinnedRevision) {
    throw new ClassificationConfigLoadError(
      'unsupported_version',
      `Workspace pins "${pinnedRevision}" but the compiled release is "${compiled.taxonomyRevision}".`,
      path.join(classificationDir(workspacePath), 'state.json'),
    );
  }
  let brands = compiled.brands;
  let modelPolicy = compiled.modelPolicy;
  let dataSharing = compiled.dataSharing;
  let curationTargets = compiled.curationTargets;

  try {
    const manifest = readManifest(workspacePath);
    const version = manifestVersion(manifest.file.value, manifest.file.path);
    if (version === 1) {
      const legacy = loadLegacyV1ConfigForMigration(workspacePath);
      if (Array.isArray(legacy.brands) && legacy.brands.length > 0) {
        brands = legacy.brands as typeof compiled.brands;
      }
      if (legacy.modelPolicy) {
        const parsed = ModelPolicyConfigV2Schema.safeParse(legacy.modelPolicy);
        if (parsed.success) modelPolicy = parsed.data;
      }
      if (legacy.dataSharing) {
        const parsed = DataSharingConfigV2Schema.safeParse(legacy.dataSharing);
        if (parsed.success) dataSharing = parsed.data;
      }
      if (Array.isArray(legacy.curationTargets) && legacy.curationTargets.length > 0) {
        const parsed = z.array(CurationTargetConfigV2Schema).safeParse(legacy.curationTargets);
        if (parsed.success) curationTargets = parsed.data;
      }
    } else if (version === 2) {
      const dir = manifest.dir;
      if (fs.existsSync(path.join(dir.path, 'brands.json'))) {
        try {
          const raw = readRequiredFile(dir, 'brands.json');
          const env = BrandsFileV2Schema.safeParse(raw.value);
          if (env.success && env.data.entries.length > 0) {
            brands = env.data.entries;
          } else {
            const bare = z.array(BrandConfigV2Schema).safeParse(raw.value);
            if (bare.success && bare.data.length > 0) brands = bare.data;
          }
        } catch { /* keep compiled default */ }
      }
      if (fs.existsSync(path.join(dir.path, 'model-policies.json'))) {
        try {
          const raw = readRequiredFile(dir, 'model-policies.json');
          const env = ModelPolicyFileV2Schema.safeParse(raw.value);
          if (env.success) {
            modelPolicy = env.data.policy;
          } else {
            const bare = ModelPolicyConfigV2Schema.safeParse(raw.value);
            if (bare.success) modelPolicy = bare.data;
          }
        } catch { /* keep compiled default */ }
      }
      if (fs.existsSync(path.join(dir.path, 'data-sharing.json'))) {
        try {
          const raw = readRequiredFile(dir, 'data-sharing.json');
          const env = DataSharingFileV2Schema.safeParse(raw.value);
          if (env.success) {
            dataSharing = env.data.policy;
          } else {
            const bare = DataSharingConfigV2Schema.safeParse(raw.value);
            if (bare.success) dataSharing = bare.data;
          }
        } catch { /* keep compiled default */ }
      }
      if (fs.existsSync(path.join(dir.path, 'curation-targets.json'))) {
        try {
          const raw = readRequiredFile(dir, 'curation-targets.json');
          const env = CurationTargetsFileV2Schema.safeParse(raw.value);
          if (env.success && env.data.entries.length > 0) {
            curationTargets = env.data.entries;
          } else {
            const bare = z.array(CurationTargetConfigV2Schema).safeParse(raw.value);
            if (bare.success && bare.data.length > 0) curationTargets = bare.data;
          }
        } catch { /* keep compiled default */ }
      }
    }
  } catch {
    // No legacy workspace bundle or manifest: keep release defaults.
  }
  return { kind: 'v2', bundle: Object.freeze({ ...compiled, brands, modelPolicy, dataSharing, curationTargets }) };
}

/** Observe V4 delta when shadow flag is on and pin is not bay-state-v4. Never alters authority; failures swallowed. */
function observeV4ShadowIfEnabled(
  workspacePath: string,
  pinnedRevision: string | null,
  authority: RuntimeConfigAuthority,
): void {
  if (!isTaxonomyV4ShadowEnabled() || pinnedRevision === V4_TAXONOMY_REVISION || pinnedRevision === V5_TAXONOMY_REVISION) return;
  try {
    const fields = authority.kind === 'v2' ? authority.bundle : authority.config;
    const active = {
      productTypeIds: fields.productTypes.map(type => type.id),
      attributeIds: fields.attributes.map(attribute => attribute.id),
      mappings: fields.attributeMappings.map(mapping => ({
        attributeId: mapping.attributeId,
        catalogField: mapping.catalogField,
      })),
    };
    const v4Bundle = loadTaxonomyReleaseV4(V4_TAXONOMY_REVISION);
    const summary = buildV4ShadowDiffSummary(active, v4Bundle, pinnedRevision, new Date().toISOString());
    recordV4ShadowObservation(workspacePath, summary);
  } catch (error) {
    console.warn('[ConfigLoader] v4 shadow observation skipped:', error instanceof Error ? error.message : error);
  }
}

/**
 * The authoritative runtime configuration: strict v1 transitional bundles are
 * consumed as-is; the ACTIVE v2 bundle is consumed through the verified active
 * loader. V2 is the authority whenever an active v2 activation exists.
 */
export type RuntimeConfigAuthority =
  | { kind: 'v1'; config: ClassificationConfig }
  | { kind: 'v2'; bundle: ClassificationConfigBundleV2 };

/**
 * Load the authoritative runtime configuration. Pin == v4/v5 → compiled release; else legacy bundle. Shadow observes when enabled.
 */
export function loadRuntimeConfigAuthority(
  workspacePath: string,
  activationContext?: VerifiedActivationContext,
): RuntimeConfigAuthority {
  const pinnedRevision = readActiveRevisionPin(workspacePath);
  if (
    pinnedRevision !== null &&
    pinnedRevision !== DEFAULT_TAXONOMY_REVISION &&
    pinnedRevision !== V4_TAXONOMY_REVISION &&
    pinnedRevision !== V5_TAXONOMY_REVISION
  ) {
    throw new ClassificationConfigLoadError(
      'unsupported_version',
      `Workspace classification state pins unknown taxonomy revision "${pinnedRevision}". Supported: ${DEFAULT_TAXONOMY_REVISION}, ${V4_TAXONOMY_REVISION}, ${V5_TAXONOMY_REVISION} (or no pin).`,
      path.join(classificationDir(workspacePath), 'state.json'),
    );
  }
  if (pinnedRevision === V4_TAXONOMY_REVISION || pinnedRevision === V5_TAXONOMY_REVISION) {
    const authority = loadPinnedReleaseAuthority(workspacePath, pinnedRevision);
    return authority;
  }
  const authority = loadLegacyRuntimeAuthority(workspacePath, activationContext);
  observeV4ShadowIfEnabled(workspacePath, pinnedRevision, authority);
  return authority;
}

/** Byte-identical HEAD behavior: v1 transitional bundle or verified-active v2. */
function loadLegacyRuntimeAuthority(
  workspacePath: string,
  activationContext?: VerifiedActivationContext,
): RuntimeConfigAuthority {
  const manifest = readManifest(workspacePath);
  const version = manifestVersion(manifest.file.value, manifest.file.path);
  if (version === 1) {
    return { kind: 'v1', config: loadLegacyV1FromManifest(workspacePath, manifest) as ClassificationConfig };
  }
  if (version === 2) {
    if (!activationContext) {
      throw new ClassificationConfigLoadError(
        'invalid_config',
        'Active v2 configuration requires a verified activation context (catalog fields and catalog-evidence verifier).',
        manifest.file.path,
        ['v2_runtime_context_required'],
      );
    }
    return { kind: 'v2', bundle: loadActiveClassificationConfigBundleV2(workspacePath, activationContext) };
  }
  throw new ClassificationConfigLoadError(
    'unsupported_version',
    `Unsupported classification schemaVersion ${version}.`,
    manifest.file.path,
  );
}

/**
 * Build the verified activation context for a workspace from live sources:
 * the field-registry xmlFields as the attested Catalog Field set, the
 * catalog-evidence verifier bound to the committed artifact, and the verified
 * Page IDs from the active import (stable identities only — name-only rows
 * never enter). `workspaceId` is REQUIRED so Page identity is never inferred
 * from a path; a caller without a workspace ID must pass the empty-string
 * sentinel to omit verifiedPageIds (fail closed for any enabled Page target).
 * Cheap enough for every runtime load; the full tree re-scan gate is added by
 * the activation caller through `verifyCatalogEvidenceTree`.
 */
export function createRuntimeActivationContext(workspacePath: string, workspaceId: string): VerifiedActivationContext {
  return {
    catalogFields: readLiveCatalogFields(workspacePath, workspaceId),
    verifyCatalogEvidence: createCatalogEvidenceVerifier(workspacePath, workspaceId),
    ...(workspaceId ? { verifiedPageIds: listVerifiedPageOptions(workspaceId).map(page => page.id) } : {}),
  };
}

/**
 * Read-only runtime config view: v1 config as-is, or the ACTIVE v2 bundle
 * (typed as the legacy shape for callers that only read common fields).
 * Prefer `loadRuntimeConfigAuthority` when the authority kind matters.
 * `workspaceId` is required for the verified Page context when the active
 * bundle enables Page assignment.
 */
export function loadRuntimeConfig(workspacePath: string, workspaceId: string): ClassificationConfig {
  const authority = loadRuntimeConfigAuthority(
    workspacePath,
    createRuntimeActivationContext(workspacePath, workspaceId),
  );
  return authority.kind === 'v2' ? (authority.bundle as unknown as ClassificationConfig) : authority.config;
}

/**
 * Transitional legacy writer retained until Milestone 3 replaces production
 * writes with the locked, atomic config store. It validates a complete v1
 * bundle, rejects symlinked/non-regular paths, and is intentionally not the
 * long-term activation API.
 */
export function saveClassificationConfig(workspacePath: string, config: ClassificationConfig): void {
  // P0 taxonomy freeze: the legacy direct writer mutates the live taxonomy
  // directory and must fail closed until a new immutable taxonomy release is
  // deployed.
  assertTaxonomyMutable('config save');

  const parsed = LegacyClassificationConfigV1Schema.safeParse(config);
  if (!parsed.success) {
    throw new ClassificationConfigLoadError(
      'invalid_config',
      'Refusing to write an incomplete or invalid legacy v1 classification bundle.',
      path.join(classificationDir(workspacePath), 'manifest.json'),
      parsed.error.issues,
    );
  }
  const checkedDir = checkedClassificationDirectoryForWrite(workspacePath);
  const dir = checkedDir.path;
  const files: Record<string, unknown> = {
    'manifest.json': parsed.data.manifest,
    'product-types.json': parsed.data.productTypes,
    'attributes.json': parsed.data.attributes,
    'attribute-profiles.json': parsed.data.attributeProfiles,
    'mappings.json': parsed.data.attributeMappings,
    'curation-targets.json': parsed.data.curationTargets,
    'brands.json': parsed.data.brands,
    'guidance.json': parsed.data.guidance,
    'model-policies.json': parsed.data.modelPolicy,
    'data-sharing.json': parsed.data.dataSharing,
  };
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (const [fileName, value] of Object.entries(files)) {
    // Re-validate every descendant component immediately before every write.
    // This cannot remove the platform's lack-of-openat race, but it prevents a
    // pre-existing or between-file intermediate symlink from ever being used.
    const currentDir = checkedClassificationDirectory(workspacePath);
    if (currentDir.realPath !== checkedDir.realPath) {
      throw new ClassificationConfigLoadError(
        'write_error',
        `Classification directory identity changed during write: ${dir}`,
        dir,
      );
    }
    const filePath = path.join(currentDir.path, fileName);
    let descriptor: number | null = null;
    try {
      // O_NOFOLLOW rejects a final-component symlink at open time where supported.
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      );
      const openedStat = fs.fstatSync(descriptor);
      if (!openedStat.isFile()) {
        throw new ClassificationConfigLoadError(
          'write_error',
          `Opened classification path is not a regular file: ${filePath}`,
          filePath,
        );
      }
      fs.writeFileSync(descriptor, canonicalJsonFileString(value), 'utf8');
    } catch (error) {
      if (error instanceof ClassificationConfigLoadError) throw error;
      throw new ClassificationConfigLoadError(
        'write_error',
        `Unable to write classification file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        filePath,
      );
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* original write result/error wins */ }
      }
    }
  }
}

/**
 * Presence check that preserves typed errors: only a truly absent manifest is
 * "not configured"; symlinked/non-regular paths and filesystem failures throw
 * ClassificationConfigLoadError instead of being collapsed to absence.
 */
export function hasClassificationConfig(workspacePath: string): boolean {
  const dir = checkedClassificationDirectory(workspacePath);
  const manifestPath = path.join(dir.path, 'manifest.json');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch (error) {
    // Only the exact absent manifest under verified real workspace/store/
    // classification directories is "not configured".
    if (fsErrorCode(error) === 'ENOENT') return false;
    throw new ClassificationConfigLoadError(
      'read_error',
      `Unable to inspect classification manifest presence at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      manifestPath,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ClassificationConfigLoadError(
      'read_error',
      `Classification manifest is not a real regular file: ${manifestPath}`,
      manifestPath,
    );
  }
  try {
    const realPath = fs.realpathSync.native(manifestPath);
    if (path.dirname(realPath) !== dir.realPath) {
      throw new ClassificationConfigLoadError(
        'read_error',
        `Classification manifest escapes its verified directory: ${manifestPath}`,
        manifestPath,
      );
    }
  } catch (error) {
    if (error instanceof ClassificationConfigLoadError) throw error;
    throw new ClassificationConfigLoadError(
      'read_error',
      `Unable to resolve classification manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      manifestPath,
    );
  }
  return true;
}
