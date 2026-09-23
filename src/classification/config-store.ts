// fallow-ignore-file unused-export

/**
 * Sole configuration mutation seam.
 *
 * `previewCandidate` stages a validated preview bundle; `activateBundle`
 * compare-and-swaps the active directory under an in-process serial queue and
 * an OS-level advisory lock, then transactionally updates the derived SQLite
 * cache and commits only `store/classification/**` in the nested catalog Git
 * repository. Any failure after the atomic rename restores the prior active
 * directory and rolls the cache back. This module never stages or commits
 * anything outside `store/classification/**` and never touches `.gitignore`,
 * exports, `.shopsite-cms/`, brand mappings, or product JSON files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lockfile from 'proper-lockfile';
import {
  ClassificationBundleOriginV2Schema,
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  DataSharingConfigV2Schema,
  DataSharingFileV2Schema,
  ModelPolicyConfigV2Schema,
  ModelPolicyFileV2Schema,
  type ClassificationBundleOriginV2,
  type ClassificationConfigBundleV2,
  type ClassificationManifestV2,
  type DataSharingConfigV2,
  type ModelPolicyConfigV2,
} from '../shared/schemas/classification';
import { canonicalJsonFileString, sha256Hex } from '../shared/stable-id';
import {
  computeClassificationBundleHash,
  validateClassificationConfigBundle,
  type ClassificationConfigFinding,
  type ClassificationConfigValidationReport,
} from './config-validation';
import { buildFocusedFiles } from './config-generator';
import {
  classificationDir,
  hasClassificationConfig,
  loadActiveClassificationConfigBundleV2,
  type VerifiedActivationContext,
} from './config-loader';
import {
  captureConfigCacheState,
  restoreConfigCacheState,
  syncConfigToCache,
  syncPolicyToCache,
  upsertConfigSnapshot,
  type ConfigCacheState,
} from '../db/repositories/classification-config-repo';
import { assertTaxonomyMutable } from './taxonomy-freeze';

export class ConfigStoreError extends Error {
  constructor(
    message: string,
    readonly code = 'config_store_error',
  ) {
    super(message);
    this.name = 'ConfigStoreError';
  }
}

/** Compare-and-swap precondition failure — caller must refresh and retry. */
export class ConfigStoreConflictError extends ConfigStoreError {
  constructor(message: string) {
    super(message, 'config_store_conflict');
    this.name = 'ConfigStoreConflictError';
  }
}

export interface ConfigStorePreviewResult {
  /** Content-address of the staged preview bundle, or null when invalid. */
  hash: string | null;
  report: ClassificationConfigValidationReport;
}

export interface PreviewCandidateOptions {
  /**
   * Canonical catalog-evidence artifact content (Milestone 7). Written into
   * the staging directory as catalog-evidence.json so the activation commit
   * contains it alongside the manifest and focused files.
   */
  catalogEvidence?: string;
}

export interface ActivateBundleOptions {
  workspacePath: string;
  workspaceId: string;
  /** Required for active-mode validation (catalog fields + evidence verifier). */
  activationContext: VerifiedActivationContext;
  /** Overrides the staging manifest's source commit when provided. */
  sourceCatalogCommit?: string;
  /** Overrides the staging manifest's evidence hash when provided. */
  catalogEvidenceHash?: string;
  /** Non-preview revision identifier for the active manifest. */
  activeRevision?: string;
  gitMessage?: string;
  /** When false, the Git commit step is skipped (used by focused tests). */
  gitEnabled?: boolean;
}

export interface ActivationResult {
  hash: string;
  commitHash: string | null;
  /** SQLite snapshot row id created for this activation. */
  snapshotId: string;
}

// ─── In-process serial queue ───────────────────────────────────────────────────

let activationChain: Promise<unknown> = Promise.resolve();

function enqueueActivation<T>(task: () => Promise<T>): Promise<T> {
  const run = activationChain.then(task, task);
  activationChain = run.then(() => undefined, () => undefined);
  return run;
}

// ─── Verified workspace/store directory helpers ────────────────────────────────

interface VerifiedDirectory {
  path: string;
  realPath: string;
}

function verifiedWorkspaceRoot(workspacePath: string): VerifiedDirectory {
  const absolutePath = path.resolve(workspacePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    throw new ConfigStoreError(`Unable to inspect workspace root ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ConfigStoreError(`Workspace root must be a real directory: ${absolutePath}`);
  }
  return { path: absolutePath, realPath: fs.realpathSync.native(absolutePath) };
}

function verifiedStoreDirectory(workspacePath: string): VerifiedDirectory {
  const workspace = verifiedWorkspaceRoot(workspacePath);
  const storePath = path.join(workspace.path, 'store');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(storePath);
  } catch {
    throw new ConfigStoreError(`Workspace store directory is missing: ${storePath}`, 'store_directory_missing');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ConfigStoreError(`Workspace store must be a real directory: ${storePath}`);
  }
  const storeReal = fs.realpathSync.native(storePath);
  if (path.dirname(storeReal) !== workspace.realPath) {
    throw new ConfigStoreError(`Workspace store directory escapes its verified parent: ${storePath}`);
  }
  return { path: storePath, realPath: storeReal };
}

function stagingDirFor(storePath: string, hash: string): string {
  return path.join(storePath, `.classification-staging-${hash}`);
}

// ─── Strict manifest reads ─────────────────────────────────────────────────────

function readRawManifestJson(dir: string): unknown {
  const manifestPath = path.join(dir, 'manifest.json');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch (error) {
    throw new ConfigStoreError(`Classification manifest is missing at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConfigStoreError(`Classification manifest is not a real regular file: ${manifestPath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new ConfigStoreError(`Unable to read classification manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`, 'invalid_manifest');
  }
}

function readStrictManifestFromDirectory(dir: string): ClassificationManifestV2 {
  const value = readRawManifestJson(dir);
  const parsed = ClassificationManifestV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigStoreError(`Classification manifest is not a valid v2 manifest: ${path.join(dir, 'manifest.json')}`, 'invalid_manifest');
  }
  return parsed.data;
}

/**
 * SHA-256 of the currently active v2 bundle, or null when no v2 bundle is
 * active (absent configuration or the transitional v1 runtime bundle). A
 * corrupt or preview-lifecycle manifest at the active path fails closed.
 */
export function getActiveHash(workspacePath: string): string | null {
  if (!hasClassificationConfig(workspacePath)) return null;
  const raw = readRawManifestJson(classificationDir(workspacePath)) as Record<string, unknown>;
  if (raw?.schemaVersion === 1) {
    // Transitional v1 runtime bundle: no v2 identity to return.
    return null;
  }
  const manifest = readStrictManifestFromDirectory(classificationDir(workspacePath));
  if (manifest.lifecycle !== 'active') {
    throw new ConfigStoreError('The classification manifest at the active path is not lifecycle-active.', 'invalid_active_manifest');
  }
  return manifest.bundleHash;
}

// ─── Staging ───────────────────────────────────────────────────────────────────

function writeStagingDirectory(
  storePath: string,
  bundle: ClassificationConfigBundleV2,
  focusedFiles: Record<string, string>,
  catalogEvidence?: string,
): string {
  const stagingPath = stagingDirFor(storePath, bundle.manifest.bundleHash);
  if (fs.existsSync(stagingPath)) {
    const entries = new Set(fs.readdirSync(stagingPath));
    const complete = entries.has('manifest.json')
      && ClassificationFocusedFileNames.every(fileName => entries.has(fileName))
      && (catalogEvidence === undefined || entries.has('catalog-evidence.json'));
    if (!complete) {
      throw new ConfigStoreError(`Staging directory exists but is incomplete: ${stagingPath}`, 'incomplete_staging');
    }
    return stagingPath;
  }
  fs.mkdirSync(stagingPath);
  const files: Record<string, string> = {
    'manifest.json': canonicalJsonFileString(bundle.manifest),
    ...focusedFiles,
    ...(catalogEvidence !== undefined ? { 'catalog-evidence.json': catalogEvidence } : {}),
  };
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(stagingPath, fileName);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeFileSync(descriptor, content, 'utf-8');
      fs.fsyncSync(descriptor);
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  }
  const dirDescriptor = fs.openSync(stagingPath, 'r');
  try {
    fs.fsyncSync(dirDescriptor);
  } finally {
    fs.closeSync(dirDescriptor);
  }
  return stagingPath;
}

/**
 * Validate a preview bundle, verify its manifest is content-consistent, and
 * write the complete sibling staging directory (including the optional
 * catalog-evidence.json artifact). Never activates.
 */
export function previewCandidate(
  bundle: ClassificationConfigBundleV2,
  workspacePath: string,
  options: PreviewCandidateOptions = {},
): ConfigStorePreviewResult {
  const structural = validateClassificationConfigBundle(bundle, { mode: 'preview' });
  if (!structural.valid || !structural.config) return { hash: null, report: structural };

  const validBundle = structural.config;
  const focusedFiles = buildFocusedFiles(validBundle);
  const computedVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const versionsMatch = ClassificationFocusedFileNames.every(
    fileName => validBundle.manifest.fileVersions[fileName] === computedVersions[fileName],
  );
  const expectedBundleHash = computeClassificationBundleHash(validBundle.manifest);
  const hashMatches = validBundle.manifest.bundleHash === expectedBundleHash;
  if (!versionsMatch || !hashMatches) {
    const finding: ClassificationConfigFinding = {
      severity: 'error',
      code: 'candidate_inconsistent',
      path: '$.manifest',
      message: versionsMatch
        ? 'manifest.bundleHash does not match the declared manifest content.'
        : 'manifest.fileVersions do not match the generated focused-file bytes.',
    };
    return { hash: null, report: { valid: false, findings: [finding] } };
  }

  const report = validateClassificationConfigBundle(validBundle, {
    mode: 'preview',
    focusedFileContents: focusedFiles,
  });
  if (report.valid && report.config) {
    const store = verifiedStoreDirectory(workspacePath);
    writeStagingDirectory(store.path, validBundle, focusedFiles, options.catalogEvidence);
    return { hash: validBundle.manifest.bundleHash, report };
  }
  return { hash: null, report };
}

// ─── OS-level advisory lock ────────────────────────────────────────────────────

function configLockTarget(workspacePath: string): string {
  return path.join(workspacePath, '.shopsite-cms', 'locks', 'classification-config.lock');
}

/**
 * Acquire the cross-process advisory lock. `proper-lockfile` uses an atomic
 * mkdir strategy (equivalent to flock semantics) that works on every platform;
 * it performs PID/staleness detection and bounded retries. Returns a release
 * function.
 */
async function acquireConfigLock(workspacePath: string): Promise<() => Promise<void>> {
  const lockTarget = configLockTarget(workspacePath);
  fs.mkdirSync(path.dirname(lockTarget), { recursive: true });
  try {
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 60_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 25, maxTimeout: 300 },
    });
    return release;
  } catch (error) {
    throw new ConfigStoreError(
      `Unable to acquire the classification configuration lock: ${error instanceof Error ? error.message : String(error)}`,
      'config_lock_busy',
    );
  }
}

// ─── Scoped Git commit ─────────────────────────────────────────────────────────

interface GitRunResult {
  stdout: string;
  status: number;
}

function runGit(workspacePath: string, args: string[]): GitRunResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), status: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      stdout: String(err.stdout ?? err.stderr ?? '').trim(),
      status: err.status ?? 1,
    };
  }
}

function readGitHead(workspacePath: string): string | null {
  const result = runGit(workspacePath, ['rev-parse', 'HEAD']);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function assertNoPreStagedPaths(workspacePath: string): void {
  const result = runGit(workspacePath, ['diff', '--cached', '--name-only']);
  if (result.status !== 0) {
    throw new ConfigStoreError(`Unable to inspect the nested repository index: ${result.stdout}`, 'git_inspection_failed');
  }
  if (result.stdout) {
    throw new ConfigStoreError(
      `Refusing to activate: the nested repository already has staged paths outside this activation.\n${result.stdout}`,
      'pre_staged_paths',
    );
  }
}

/**
 * Scoped Git commit of `store/classification/**` in the nested catalog
 * repository. Exported so the field-mapping editor can commit its scoped
 * writes through the same narrow path (never anything outside that scope).
 */
export function commitClassificationScope(workspacePath: string, message: string): string {
  const gitDir = path.join(workspacePath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new ConfigStoreError('Nested catalog Git repository is missing; cannot commit an activation.', 'git_missing');
  }
  assertNoPreStagedPaths(workspacePath);

  const addResult = runGit(workspacePath, ['add', '--', 'store/classification']);
  if (addResult.status !== 0) {
    throw new ConfigStoreError(`git add failed: ${addResult.stdout}`, 'git_add_failed');
  }
  const stagedResult = runGit(workspacePath, ['diff', '--cached', '--name-only']);
  const stagedPaths = stagedResult.stdout.split('\n').filter(Boolean);
  const outOfScope = stagedPaths.filter(stagedPath => !stagedPath.startsWith('store/classification/'));
  if (outOfScope.length > 0) {
    runGit(workspacePath, ['reset', '--', ...outOfScope]);
    throw new ConfigStoreError(
      `git staged paths outside store/classification/**:\n${outOfScope.join('\n')}`,
      'git_out_of_scope',
    );
  }
  if (stagedPaths.length === 0) {
    runGit(workspacePath, ['reset', '--', 'store/classification']);
    throw new ConfigStoreError('git add staged no classification paths; nothing to commit.', 'git_nothing_staged');
  }

  const commitResult = runGit(workspacePath, ['commit', '-m', message]);
  if (commitResult.status !== 0) {
    runGit(workspacePath, ['reset', '--', 'store/classification']);
    throw new ConfigStoreError(`git commit failed: ${commitResult.stdout}`, 'git_commit_failed');
  }
  const head = runGit(workspacePath, ['rev-parse', 'HEAD']);
  if (head.status !== 0 || !head.stdout) {
    throw new ConfigStoreError('git commit succeeded but HEAD could not be read.', 'git_head_failed');
  }
  return head.stdout;
}

// ─── Activation ────────────────────────────────────────────────────────────────

const PREVIEW_LIKE_REVISION = /preview|draft|migrated/i;

function buildActiveManifest(
  staged: ClassificationManifestV2,
  options: ActivateBundleOptions,
  gitHead: string | null,
): ClassificationManifestV2 {
  if (staged.lifecycle !== 'preview') {
    throw new ConfigStoreError('Only preview-lifecycle bundles can be activated.', 'activation_not_preview');
  }
  if (staged.migrationProvenance.kind !== 'reviewed_generation') {
    throw new ConfigStoreError('Migrated candidates cannot be activated; a reviewed generator must produce a clean candidate first.', 'activation_migrated_origin');
  }
  if (staged.hasUnresolvedSafetyFindings) {
    throw new ConfigStoreError('A candidate with unresolved safety findings cannot be activated.', 'activation_unresolved_safety');
  }
  const sourceCatalogCommit = options.sourceCatalogCommit
    ?? staged.sourceCatalogCommit
    ?? gitHead;
  if (!sourceCatalogCommit || !/^[a-f0-9]{40,64}$/.test(sourceCatalogCommit)) {
    throw new ConfigStoreError('Activation requires an attested lowercase catalog commit hash (40–64 hex).', 'activation_commit_required');
  }
  const catalogEvidenceHash = options.catalogEvidenceHash ?? staged.catalogEvidenceHash;
  if (!catalogEvidenceHash || !/^[a-f0-9]{64}$/.test(catalogEvidenceHash)) {
    throw new ConfigStoreError('Activation requires a catalog-evidence SHA-256 (from the deterministic catalog evidence artifact).', 'activation_evidence_required');
  }
  const activeRevision = options.activeRevision
    ?? (PREVIEW_LIKE_REVISION.test(staged.activeRevision) ? 'bay-state-v2' : staged.activeRevision);
  const manifestWithoutHash: Omit<ClassificationManifestV2, 'bundleHash'> = {
    ...staged,
    activeRevision,
    lifecycle: 'active',
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' },
    sourceCatalogCommit,
    catalogEvidenceHash,
  };
  return ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
}

async function performActivation(stagingHash: string, expectedActiveHash: string | null, options: ActivateBundleOptions): Promise<ActivationResult> {
  const { workspacePath, workspaceId, activationContext } = options;
  if (!activationContext.catalogFields || !activationContext.verifyCatalogEvidence) {
    throw new ConfigStoreError('Activation requires an activation context with the attested Catalog Field set and a catalog-evidence verifier.', 'activation_context_required');
  }

  const store = verifiedStoreDirectory(workspacePath);
  const stagingPath = stagingDirFor(store.path, stagingHash);
  const activeDir = path.join(store.path, 'classification');
  const backupDir = path.join(store.path, `.classification-backup-${Date.now()}`);

  if (!fs.existsSync(stagingPath)) {
    throw new ConfigStoreError(`Staging bundle ${stagingHash} was not previewed; run previewCandidate first.`, 'staging_missing');
  }

  const release = await acquireConfigLock(workspacePath);
  let cacheState: ConfigCacheState | null = null;
  let cacheUpdated = false;
  try {
    const currentHash = getActiveHash(workspacePath);
    if (currentHash !== expectedActiveHash) {
      throw new ConfigStoreConflictError(
        `Expected active hash ${expectedActiveHash ?? '<none>'}, found ${currentHash ?? '<none>'}.`,
      );
    }

    const stagedManifest = readStrictManifestFromDirectory(stagingPath);
    const gitHead = options.gitEnabled === false ? null : readGitHead(workspacePath);
    const activeManifest = buildActiveManifest(stagedManifest, options, gitHead);

    // Pre-swap evidence gates (nothing has been mutated yet; a failure here
    // leaves the prior active directory and staging intact).
    if (activeManifest.catalogEvidenceHash) {
      const stagedArtifactPath = path.join(stagingPath, 'catalog-evidence.json');
      let artifactHash: string | null = null;
      try {
        artifactHash = sha256Hex(fs.readFileSync(stagedArtifactPath));
      } catch {
        // read failure → null → mismatch below.
      }
      if (!artifactHash || artifactHash !== activeManifest.catalogEvidenceHash) {
        throw new ConfigStoreError(
          `Staged catalog-evidence.json does not match the activation evidence hash ${activeManifest.catalogEvidenceHash}.`,
          'activation_evidence_artifact_mismatch',
        );
      }
    }
    if (activationContext.verifyCatalogEvidenceTree) {
      const treeCheck = await activationContext.verifyCatalogEvidenceTree(activeManifest.catalogEvidenceHash ?? '');
      if (!treeCheck.verified) {
        throw new ConfigStoreError(
          `Catalog evidence tree verification failed before activation: ${treeCheck.reason ?? 'unknown reason'}`,
          'activation_evidence_tree_drift',
        );
      }
    }

    // Rewrite the staging manifest to the active variant before the atomic swap
    // so the active directory is internally consistent from the first instant.
    const manifestPath = path.join(stagingPath, 'manifest.json');
    fs.writeFileSync(manifestPath, canonicalJsonFileString(activeManifest), 'utf-8');

    const hadActive = fs.existsSync(activeDir);
    if (hadActive) fs.renameSync(activeDir, backupDir);
    try {
      fs.renameSync(stagingPath, activeDir);
    } catch (error) {
      if (hadActive) {
        try { fs.renameSync(backupDir, activeDir); } catch { /* restore failure is fatal below */ }
      }
      throw new ConfigStoreError(`Unable to atomically activate the staging directory: ${error instanceof Error ? error.message : String(error)}`, 'activate_rename_failed');
    }

    try {
      // Validate the newly active bundle under the fail-closed active contract.
      const activeBundle = loadActiveClassificationConfigBundleV2(workspacePath, activationContext);

      // Transactional derived-cache update.
      cacheState = captureConfigCacheState(workspaceId);
      // The v1-shaped mirror tables (classification_attribute_mappings etc.)
      // feed promotion and curation reads (getCachedAttributeMappings,
      // getCachedProductTypes); without this sync they retain stale pre-v2
      // rows and v2 activations silently mis-write fields at promotion.
      syncConfigToCache(workspaceId, activeBundle as unknown as Parameters<typeof syncConfigToCache>[1]);
      // Snapshot last so classification_config_files content hashes match the
      // committed canonical file bytes (syncConfigToCache stores compact-JSON
      // hashes; the snapshot upsert stores file-byte hashes).
      const snapshot = upsertConfigSnapshot(workspaceId, activeBundle, activeManifest.sourceCatalogCommit);
      cacheUpdated = true;

      // Scoped Git commit last; failure here restores everything.
      const commitHash = options.gitEnabled === false
        ? null
        : commitClassificationScope(workspacePath, options.gitMessage ?? `Activate classification configuration ${activeManifest.bundleHash}`);

      // Remove the backup; the swap is final.
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      return { hash: activeManifest.bundleHash, commitHash, snapshotId: snapshot.id };
    } catch (error) {
      // Rollback: restore the prior active directory and the cache.
      try { fs.rmSync(activeDir, { recursive: true, force: true }); } catch { /* best effort */ }
      if (hadActive) {
        try { fs.renameSync(backupDir, activeDir); } catch { /* best effort */ }
      }
      if (cacheUpdated && cacheState) {
        try { restoreConfigCacheState(workspaceId, cacheState, activeManifest.bundleHash); } catch { /* best effort */ }
      }
      if (error instanceof ConfigStoreError) throw error;
      throw new ConfigStoreError(`Activation failed after the atomic swap and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await release();
  }
}

/**
 * Compare-and-swap activation. Only activates the previewed staging bundle when
 * the current active hash equals `expectedActiveHash`. Serialized in-process
 * and across processes; a failed post-swap step restores the prior bundle.
 */
export function activateBundle(
  stagingHash: string,
  expectedActiveHash: string | null,
  options: ActivateBundleOptions,
): Promise<ActivationResult> {
  // P0 taxonomy freeze: activation replaces the active taxonomy directory and
  // must fail closed until a new immutable taxonomy release is deployed.
  assertTaxonomyMutable('bundle activation');
  return enqueueActivation(() => performActivation(stagingHash, expectedActiveHash, options));
}

// ─── Scoped Policy Writer (Issue #296 / ADR 0033) ──────────────────────────────

export interface UpdateClassificationPolicyOptions {
  workspacePath: string;
  workspaceId: string;
  expectedBaseBundleHash: string;
  modelPolicy: ModelPolicyConfigV2;
  dataSharing: DataSharingConfigV2;
  gitMessage?: string;
  gitEnabled?: boolean;
}

export interface UpdateClassificationPolicyResult {
  bundleHash: string;
  commitHash: string | null;
  updatedAt: string;
}

const POLICY_ALLOWLIST = [
  'store/classification/model-policies.json',
  'store/classification/data-sharing.json',
  'store/classification/manifest.json',
] as const;

/**
 * Narrowly scoped writer for classification model-policy and data-sharing documents.
 * Operates under the cross-process advisory lock and CAS validation.
 * Commits ONLY the allowlisted files to the scoped catalog Git workflow.
 * Fails closed and rolls back on any error.
 */
export async function updateClassificationPolicy(
  options: UpdateClassificationPolicyOptions,
): Promise<UpdateClassificationPolicyResult> {
  const { workspacePath, workspaceId, expectedBaseBundleHash, modelPolicy, dataSharing } = options;

  const store = verifiedStoreDirectory(workspacePath);
  const activeDir = path.join(store.path, 'classification');

  if (!fs.existsSync(activeDir)) {
    throw new ConfigStoreError('Classification configuration directory does not exist or has not been initialized.', 'classification_not_configured');
  }

  const releaseLock = await acquireConfigLock(workspacePath);

  try {
    const currentManifest = readStrictManifestFromDirectory(activeDir);
    if (currentManifest.schemaVersion !== 2 || currentManifest.compatibilityVersion !== 2) {
      throw new ConfigStoreError('Model policy updates require a v2 classification workspace. Migration required.', 'v1_migration_required');
    }

    if (currentManifest.bundleHash !== expectedBaseBundleHash) {
      throw new ConfigStoreConflictError(
        `Configuration has changed since preview (expected ${expectedBaseBundleHash}, found ${currentManifest.bundleHash}). Please refresh.`,
      );
    }

    // Preserve existing bundleOrigin from model-policies.json or default
    let origin: ClassificationBundleOriginV2 = { kind: 'reviewed_generation' };
    const policyPath = path.join(activeDir, 'model-policies.json');
    if (fs.existsSync(policyPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
        const parsedOrigin = ClassificationBundleOriginV2Schema.safeParse(raw.bundleOrigin);
        if (parsedOrigin.success) origin = parsedOrigin.data;
      } catch {
        // fallback
      }
    }

    // Validate inputs against schemas
    const parsedModelPolicy = ModelPolicyConfigV2Schema.parse(modelPolicy);
    const parsedDataSharing = DataSharingConfigV2Schema.parse(dataSharing);

    const modelPolicyFile = ModelPolicyFileV2Schema.parse({
      schemaVersion: 2,
      bundleOrigin: origin,
      policy: parsedModelPolicy,
    });
    const dataSharingFile = DataSharingFileV2Schema.parse({
      schemaVersion: 2,
      bundleOrigin: origin,
      policy: parsedDataSharing,
    });

    const modelPolicyContent = canonicalJsonFileString(modelPolicyFile);
    const dataSharingContent = canonicalJsonFileString(dataSharingFile);

    const modelPolicyHash = sha256Hex(modelPolicyContent);
    const dataSharingHash = sha256Hex(dataSharingContent);

    const updatedFileVersions = {
      ...currentManifest.fileVersions,
      'model-policies.json': modelPolicyHash,
      'data-sharing.json': dataSharingHash,
    };

    const updatedAt = new Date().toISOString();
    const manifestWithoutHash = {
      schemaVersion: 2 as const,
      compatibilityVersion: 2 as const,
      createdAt: currentManifest.createdAt,
      updatedAt,
      activeRevision: currentManifest.activeRevision,
      lifecycle: currentManifest.lifecycle,
      hasUnresolvedSafetyFindings: currentManifest.hasUnresolvedSafetyFindings,
      migrationProvenance: currentManifest.migrationProvenance,
      sourceCatalogCommit: currentManifest.sourceCatalogCommit,
      catalogEvidenceHash: currentManifest.catalogEvidenceHash,
      fileVersions: updatedFileVersions,
    };
    const newBundleHash = computeClassificationBundleHash(manifestWithoutHash);
    const updatedManifest = ClassificationManifestV2Schema.parse({
      ...manifestWithoutHash,
      bundleHash: newBundleHash,
    });
    const manifestContent = canonicalJsonFileString(updatedManifest);

    // Read previous disk contents for transactional rollback
    const prevModelPolicy = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf-8') : null;
    const prevDataSharing = fs.existsSync(path.join(activeDir, 'data-sharing.json'))
      ? fs.readFileSync(path.join(activeDir, 'data-sharing.json'), 'utf-8')
      : null;
    const prevManifest = fs.readFileSync(path.join(activeDir, 'manifest.json'), 'utf-8');

    // Pre-flight git index check: ensure NO files outside POLICY_ALLOWLIST are already staged
    if (options.gitEnabled !== false) {
      const prestagedResult = runGit(workspacePath, ['diff', '--cached', '--name-only']);
      if (prestagedResult.status !== 0) {
        throw new ConfigStoreError(`Unable to inspect repository index: ${prestagedResult.stdout}`, 'git_inspection_failed');
      }
      const prestagedPaths = prestagedResult.stdout.split('\n').filter(Boolean);
      const prestagedOutOfScope = prestagedPaths.filter(p => !POLICY_ALLOWLIST.includes(p as any));
      if (prestagedOutOfScope.length > 0) {
        throw new ConfigStoreError(
          `Refusing to commit policy: repository index already contains unrelated staged files:\n${prestagedOutOfScope.join('\n')}`,
          'pre_staged_paths',
        );
      }
    }

    // Write the files to disk
    fs.writeFileSync(policyPath, modelPolicyContent, 'utf-8');
    fs.writeFileSync(path.join(activeDir, 'data-sharing.json'), dataSharingContent, 'utf-8');
    fs.writeFileSync(path.join(activeDir, 'manifest.json'), manifestContent, 'utf-8');

    let commitHash: string | null = null;
    if (options.gitEnabled !== false) {
      try {
        const addResult = runGit(workspacePath, ['add', '--', ...POLICY_ALLOWLIST]);
        if (addResult.status !== 0) {
          throw new ConfigStoreError(`git add failed: ${addResult.stdout}`, 'git_add_failed');
        }

        const stagedResult = runGit(workspacePath, ['diff', '--cached', '--name-only']);
        const stagedPaths = stagedResult.stdout.split('\n').filter(Boolean);
        const outOfScope = stagedPaths.filter(p => !POLICY_ALLOWLIST.includes(p as any));
        if (outOfScope.length > 0) {
          runGit(workspacePath, ['reset', '--', ...stagedPaths]);
          throw new ConfigStoreError(`git staged paths outside policy allowlist:\n${outOfScope.join('\n')}`, 'git_out_of_scope');
        }

        const msg = options.gitMessage ?? `Update classification model policy and data sharing (${newBundleHash.slice(0, 8)})`;
        const commitResult = runGit(workspacePath, ['commit', '-m', msg, '--', ...POLICY_ALLOWLIST]);
        if (commitResult.status !== 0) {
          runGit(workspacePath, ['reset', '--', ...POLICY_ALLOWLIST]);
          throw new ConfigStoreError(`git commit failed: ${commitResult.stdout}`, 'git_commit_failed');
        }
        commitHash = readGitHead(workspacePath);
      } catch (err) {
        // Rollback disk files to exact previous contents
        if (prevModelPolicy !== null) fs.writeFileSync(policyPath, prevModelPolicy, 'utf-8');
        else fs.rmSync(policyPath, { force: true });

        if (prevDataSharing !== null) fs.writeFileSync(path.join(activeDir, 'data-sharing.json'), prevDataSharing, 'utf-8');
        else fs.rmSync(path.join(activeDir, 'data-sharing.json'), { force: true });

        fs.writeFileSync(path.join(activeDir, 'manifest.json'), prevManifest, 'utf-8');
        throw err;
      }
    }

    // Update SQLite cache
    try {
      syncPolicyToCache(workspaceId, parsedModelPolicy, parsedDataSharing);
    } catch {
      // Best-effort cache update
    }

    return {
      bundleHash: newBundleHash,
      commitHash,
      updatedAt,
    };
  } finally {
    await releaseLock();
  }
}

