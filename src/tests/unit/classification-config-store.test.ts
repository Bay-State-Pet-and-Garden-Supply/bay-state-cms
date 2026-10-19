import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import {
  activateBundle,
  ConfigStoreConflictError,
  ConfigStoreError,
  getActiveHash,
  previewCandidate,
} from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import {
  getActiveConfigHash,
  getCachedProductTypes,
} from '../../db/repositories/classification-config-repo';
import { sha256Hex } from '../../shared/stable-id';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { VerifiedActivationContext } from '../../classification/config-loader';

const REVIEWED_FIELDS = [
  'ProductField1', 'ProductField16', 'ProductField17', 'ProductField18', 'ProductField19',
  'ProductField20', 'ProductField21', 'ProductField22', 'ProductField23',
  'ProductField24', 'ProductField25', 'ProductField26', 'ProductField27',
  'ProductField28', 'ProductField29', 'ProductField30', 'ProductField32',
  'ProductField4', 'ProductField8',
];
/** Fixed artifact content staged by previewSeed; its digest is EVIDENCE_HASH. */
const ARTIFACT_CONTENT = JSON.stringify({
  schemaVersion: 1,
  sourceTreeHash: 'm7'.repeat(32),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: REVIEWED_FIELDS.length, xmlFields: [...REVIEWED_FIELDS].sort() },
  fields: [],
  pages: [],
});
const EVIDENCE_HASH = sha256Hex(ARTIFACT_CONTENT);
const LOCK_TARGET_REL = path.join('.shopsite-cms', 'locks', 'classification-config.lock');

function evidenceWithFields(fields: string[]): CatalogEvidence {
  return {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: fields.length, xmlFields: [...fields].sort() },
    fields: [...fields].sort().map(xmlField => ({
      xmlField,
      recordCount: 1,
      nonEmptyCount: 1,
      distinctValueCount: 1,
      distinctValueHash: '0'.repeat(64),
      delimiterEvidence: [],
    })),
    pages: [],
  };
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

describe('classification config-store', () => {
  let root: string;
  let workspaceId: string;
  let initialCommit: string;

  const activationContext = (): VerifiedActivationContext => ({
    catalogFields: REVIEWED_FIELDS,
    // The reviewed seed enables the verified Page target, so the active
    // activation context must attest the verified Page identities.
    verifiedPageIds: ['page-1', 'page-2'],
    // Binds the evidence hash to the current pre-activation catalog HEAD.
    verifyCatalogEvidence: (input) => ({
      verified: input.catalogEvidenceHash === EVIDENCE_HASH && input.sourceCatalogCommit === runGit(root, ['rev-parse', 'HEAD']),
      reason: 'test verifier binds the fixed evidence hash to the pre-activation commit',
    }),
  });

  beforeAll(() => {
    // P0 taxonomy freeze: this suite exercises activation, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    workspaceId = randomUUID();
    root = fs.mkdtempSync(path.join(os.tmpdir(), `config-store-${workspaceId.slice(0, 8)}`));
    fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });
    fs.mkdirSync(path.join(root, 'products'), { recursive: true });

    const dbPath = path.join(root, '.shopsite-cms', 'app.db');
    initDb(dbPath);
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'test',
      workspacePath: root,
      gitPath: path.join(root, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    // Nested catalog Git repository with an initial commit so HEAD exists.
    const git = new GitClient(root);
    git.init();
    fs.writeFileSync(path.join(root, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
    runGit(root, ['add', '--', 'store/manifest.json']);
    runGit(root, ['commit', '-m', 'seed catalog manifest']);
    initialCommit = runGit(root, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function previewSeed(): { hash: string } {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const result = previewCandidate(candidate.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
    if (!result.hash) {
      throw new Error(`preview failed: ${result.report.findings.map(finding => finding.code).join(', ')}`);
    }
    return { hash: result.hash };
  }

  /** Preview a distinct candidate (unique revision → unique staging hash). */
  function previewDistinct(revision: string, artifact: string = ARTIFACT_CONTENT): { candidate: ReturnType<typeof generateCandidate>; hash: string } {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    candidate.bundle.manifest.activeRevision = revision;
    candidate.bundle.manifest.bundleHash = computeClassificationBundleHash(candidate.bundle.manifest);
    const result = previewCandidate(candidate.bundle, root, { catalogEvidence: artifact });
    if (!result.hash) {
      throw new Error(`preview failed: ${result.report.findings.map(finding => finding.code).join(', ')}`);
    }
    return { candidate, hash: result.hash };
  }

  it('previews a valid candidate into a sibling staging directory without touching the active path', () => {
    const { hash } = previewSeed();
    const staging = path.join(root, 'store', `.classification-staging-${hash}`);
    expect(fs.existsSync(staging)).toBe(true);
    expect(fs.existsSync(path.join(staging, 'manifest.json'))).toBe(true);
    for (const name of ['product-types.json', 'attributes.json', 'mappings.json']) {
      expect(fs.existsSync(path.join(staging, name))).toBe(true);
    }
    // The active path is untouched.
    expect(fs.existsSync(path.join(root, 'store', 'classification', 'manifest.json'))).toBe(false);
    expect(getActiveHash(root)).toBeNull();
  });

  it('rejects an invalid preview without writing a staging directory', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const broken = {
      ...candidate.bundle,
      curationTargets: candidate.bundle.curationTargets.filter(target => target.kind !== 'product_type'),
    };
    const result = previewCandidate(broken, root);
    expect(result.hash).toBeNull();
    expect(result.report.valid).toBe(false);
    const codes = result.report.findings.map(finding => finding.code);
    expect(codes).toContain('product_type_target_required');
  });

  it('compare-and-swap rejects a wrong expected active hash', async () => {
    const { hash } = previewSeed();
    await expect(activateBundle(hash, '0'.repeat(64), {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      catalogEvidenceHash: EVIDENCE_HASH,
    })).rejects.toBeInstanceOf(ConfigStoreConflictError);
  });

  it('activates a previewed bundle atomically, updates the cache, and commits only store/classification/**', async () => {
    const { hash } = previewSeed();
    const result = await activateBundle(hash, null, {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      catalogEvidenceHash: EVIDENCE_HASH,
    });

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.commitHash).toMatch(/^[a-f0-9]{40}$/);

    // Active directory contains the full bundle; staging is consumed.
    const activeDir = path.join(root, 'store', 'classification');
    const activeManifest = JSON.parse(fs.readFileSync(path.join(activeDir, 'manifest.json'), 'utf-8'));
    expect(activeManifest.lifecycle).toBe('active');
    expect(activeManifest.sourceCatalogCommit).toBe(initialCommit);
    expect(activeManifest.catalogEvidenceHash).toBe(EVIDENCE_HASH);
    expect(activeManifest.bundleHash).toBe(result.hash);
    expect(fs.existsSync(path.join(root, 'store', `.classification-staging-${hash}`))).toBe(false);

    // Active hash reflects the new bundle.
    expect(getActiveHash(root)).toBe(result.hash);

    // Derived SQLite cache is consistent with the committed bundle.
    expect(getActiveConfigHash(workspaceId)).toBe(result.hash);
    const manifestRow = getDb().query(
      "SELECT content_hash, schema_version FROM classification_config_files WHERE workspace_id = ? AND file_name = 'manifest.json'",
    ).get(workspaceId) as { content_hash: string; schema_version: number };
    expect(manifestRow.schema_version).toBe(2);
    // The cached manifest content hash equals the committed manifest file bytes.
    const activeManifestBytes = fs.readFileSync(path.join(activeDir, 'manifest.json'));
    const { sha256Hex } = await import('../../shared/stable-id');
    expect(manifestRow.content_hash).toBe(sha256Hex(activeManifestBytes));
    const snapshotRows = getDb().query(
      'SELECT snapshot_hash FROM classification_config_snapshots WHERE workspace_id = ?',
    ).all(workspaceId) as Array<{ snapshot_hash: string }>;
    expect(snapshotRows.map(row => row.snapshot_hash)).toContain(result.hash);

    // Git commit is scoped to store/classification/** exactly.
    const committedFiles = runGit(root, ['show', '--name-only', '--pretty=format:', '--no-renames', 'HEAD'])
      .split('\n').filter(Boolean);
    expect(committedFiles.length).toBeGreaterThan(0);
    for (const file of committedFiles) {
      expect(file.startsWith('store/classification/')).toBe(true);
    }
    // The lock is released after activation.
    expect(fs.existsSync(`${path.join(root, LOCK_TARGET_REL)}.lock`)).toBe(false);
  });

  it('leaves unrelated nested-repository dirt untouched and unstaged', async () => {
    fs.writeFileSync(path.join(root, 'brand-domain-mappings.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(root, 'exports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'exports', 'sample.txt'), 'x', 'utf-8');

    const { hash } = previewSeed();
    await activateBundle(hash, getActiveHash(root), {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      catalogEvidenceHash: EVIDENCE_HASH,
    });

    const status = runGit(root, ['status', '--short']);
    expect(status).toContain('?? brand-domain-mappings.json');
    expect(status).toContain('?? exports/');
    expect(runGit(root, ['diff', '--cached', '--name-only'])).toBe('');
    const allCommits = runGit(root, ['log', '--all', '--name-only', '--pretty=format:']);
    expect(allCommits).not.toContain('brand-domain-mappings.json');
  });

  it('serializes concurrent activations so exactly one succeeds and the other receives a conflict', async () => {
    const candidateA = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const candidateB = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    // Make B a distinct candidate so its staging hash differs from A's.
    candidateB.bundle.manifest.activeRevision = 'bay-state-v2-b';
    candidateB.bundle.manifest.bundleHash = computeClassificationBundleHash(candidateB.bundle.manifest);

    const previewA = previewCandidate(candidateA.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
    const previewB = previewCandidate(candidateB.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
    expect(previewA.hash).not.toBe(previewB.hash);

    const currentActive = getActiveHash(root)!;
    const results = await Promise.allSettled([
      activateBundle(previewA.hash!, currentActive, {
        workspacePath: root,
        workspaceId,
        activationContext: activationContext(),
        catalogEvidenceHash: EVIDENCE_HASH,
      }),
      activateBundle(previewB.hash!, currentActive, {
        workspacePath: root,
        workspaceId,
        activationContext: activationContext(),
        catalogEvidenceHash: EVIDENCE_HASH,
      }),
    ]);

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ConfigStoreConflictError);
    }
    expect(getActiveHash(root)).not.toBeNull();
  });

  it('rolls back the active directory and cache when the Git commit fails', async () => {
    const { hash: firstHash } = previewSeed();
    await activateBundle(firstHash, getActiveHash(root), {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      catalogEvidenceHash: EVIDENCE_HASH,
    });
    const activeBefore = getActiveHash(root)!;

    // Prepare a second candidate and force the commit to fail with a hook.
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const preview = previewCandidate(candidate.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
    expect(preview.hash).not.toBeNull();

    const hooksDir = path.join(root, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    try {
      await expect(activateBundle(preview.hash!, activeBefore, {
        workspacePath: root,
        workspaceId,
        activationContext: activationContext(),
        catalogEvidenceHash: EVIDENCE_HASH,
      })).rejects.toBeInstanceOf(ConfigStoreError);
    } finally {
      fs.rmSync(hook, { force: true });
    }

    // Prior active directory restored; staging consumed; cache rolled back.
    expect(getActiveHash(root)).toBe(activeBefore);
    expect(getActiveConfigHash(workspaceId)).toBe(activeBefore);
    const activeManifest = JSON.parse(fs.readFileSync(path.join(root, 'store', 'classification', 'manifest.json'), 'utf-8'));
    expect(activeManifest.bundleHash).toBe(activeBefore);
    expect(fs.existsSync(path.join(root, 'store', `.classification-staging-${preview.hash}`))).toBe(false);
    // No stray backup remains.
    const storeEntries = fs.readdirSync(path.join(root, 'store')).filter(name => name.startsWith('.classification-backup-'));
    expect(storeEntries).toEqual([]);
    // The index is clean after rollback.
    expect(runGit(root, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('rejects activation of a migrated-v1-origin candidate (activation_migrated_origin)', async () => {
    // Preview a candidate whose manifest claims migrated_v1 provenance (the
    // generator always emits reviewed_generation). Preview accepts it; the
    // activation seam must fail closed until a reviewed generator replaces it.
    const { hash } = previewDistinct('migrated-origin-preview');
    const stagingManifest = path.join(root, 'store', `.classification-staging-${hash}`, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(stagingManifest, 'utf-8'));
    expect(manifest.migrationProvenance.kind).toBe('reviewed_generation');
    manifest.migrationProvenance = { kind: 'migrated_v1', sourceSchemaVersion: 1, sourceConfigHash: 'b'.repeat(64), migratedAt: '2026-08-01T00:00:00.000Z', findingCount: 1, errorCount: 1, findingsDigest: 'a'.repeat(64) };
    manifest.bundleHash = computeClassificationBundleHash(manifest);
    fs.writeFileSync(stagingManifest, JSON.stringify(manifest, null, 2), 'utf-8');

    await expect(
      activateBundle(hash, getActiveHash(root), {
        workspacePath: root,
        workspaceId,
        activationContext: activationContext(),
        catalogEvidenceHash: EVIDENCE_HASH,
      }),
    ).rejects.toThrow(/activation_migrated_origin|Migrated candidates cannot be activated/);
  });

  it('keeps the cache usable for current runtime consumers after activation', () => {
    expect(getCachedProductTypes(workspaceId)).toBeDefined();
    expect(getActiveConfigHash(workspaceId)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preview writes catalog-evidence.json into the staging directory when provided', () => {
    const artifact = JSON.stringify({ schemaVersion: 1, sourceTreeHash: 'probe'.repeat(8) });
    const { hash } = previewDistinct('bay-state-v2-artifact-write', artifact);
    const staged = path.join(root, 'store', `.classification-staging-${hash}`, 'catalog-evidence.json');
    expect(fs.readFileSync(staged, 'utf-8')).toBe(artifact);
  });

  it('rejects activation when the staged catalog-evidence.json hash does not match the activation evidence hash', async () => {
    const artifact = JSON.stringify({ schemaVersion: 1, sourceTreeHash: 'mismatch'.repeat(8) });
    const { hash } = previewDistinct('bay-state-v2-artifact-mismatch', artifact);
    const activeBefore = getActiveHash(root);
    const headBefore = runGit(root, ['rev-parse', 'HEAD']);
    await expect(activateBundle(hash, activeBefore, {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      // Deliberately different from the staged artifact bytes.
      catalogEvidenceHash: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'activation_evidence_artifact_mismatch' });
    // Nothing changed: the active path and HEAD are untouched, staging survives.
    expect(getActiveHash(root)).toBe(activeBefore);
    expect(runGit(root, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(fs.existsSync(path.join(root, 'store', `.classification-staging-${hash}`))).toBe(true);
  });

  it('runs the activation-time tree integrity gate and fails closed on tree drift', async () => {
    const artifact = JSON.stringify({ schemaVersion: 1, sourceTreeHash: 'drift'.repeat(8) });
    const { hash } = previewDistinct('bay-state-v2-tree-drift', artifact);
    const activeBefore = getActiveHash(root);
    const headBefore = runGit(root, ['rev-parse', 'HEAD']);

    // The staged artifact binds (its own digest is passed), so the artifact
    // gate passes; the tree gate then reports drift and blocks activation.
    const contextWithTreeGate: VerifiedActivationContext = {
      ...activationContext(),
      verifyCatalogEvidenceTree: async () => ({
        verified: false,
        reason: 'Catalog tree drifted (injected).',
      }),
    };
    await expect(activateBundle(hash, activeBefore, {
      workspacePath: root,
      workspaceId,
      activationContext: contextWithTreeGate,
      catalogEvidenceHash: sha256Hex(artifact),
    })).rejects.toMatchObject({ code: 'activation_evidence_tree_drift' });
    expect(getActiveHash(root)).toBe(activeBefore);
    expect(runGit(root, ['rev-parse', 'HEAD'])).toBe(headBefore);
  });

  it('passes the tree gate when the re-scan matches and the staged artifact binds', async () => {
    // Use the harness artifact (its digest equals EVIDENCE_HASH) so the fake
    // verifier and the artifact gate agree; only the tree gate is exercised.
    const { hash } = previewDistinct('bay-state-v2-tree-bound', ARTIFACT_CONTENT);
    const contextWithTreeGate: VerifiedActivationContext = {
      ...activationContext(),
      verifyCatalogEvidenceTree: async expectedHash => ({
        verified: expectedHash === EVIDENCE_HASH,
        reason: 'tree gate probe',
      }),
    };
    const active = await activateBundle(hash, getActiveHash(root), {
      workspacePath: root,
      workspaceId,
      activationContext: contextWithTreeGate,
      catalogEvidenceHash: EVIDENCE_HASH,
    });
    // The committed active directory contains catalog-evidence.json and the
    // manifest references its hash.
    const activeManifest = JSON.parse(fs.readFileSync(path.join(root, 'store', 'classification', 'manifest.json'), 'utf-8'));
    expect(activeManifest.catalogEvidenceHash).toBe(EVIDENCE_HASH);
    expect(fs.readFileSync(path.join(root, 'store', 'classification', 'catalog-evidence.json'), 'utf-8')).toBe(ARTIFACT_CONTENT);
    expect(active.hash).toBe(activeManifest.bundleHash);
    // The committed tree contains every focused file plus the artifact.
    const treeFiles = runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    const classificationFiles = treeFiles.filter(file => file.startsWith('store/classification/'));
    expect(classificationFiles).toContain('store/classification/catalog-evidence.json');
    expect(classificationFiles).toContain('store/classification/manifest.json');
    expect(classificationFiles).toContain('store/classification/product-types.json');
    expect(classificationFiles).toContain('store/classification/categories.json');
    expect(classificationFiles).toContain('store/classification/attributes.json');
    expect(classificationFiles).toContain('store/classification/attribute-profiles.json');
    expect(classificationFiles).toContain('store/classification/mappings.json');
    expect(classificationFiles).toContain('store/classification/curation-targets.json');
    expect(classificationFiles).toContain('store/classification/brands.json');
    expect(classificationFiles).toContain('store/classification/guidance.json');
    expect(classificationFiles).toContain('store/classification/model-policies.json');
    expect(classificationFiles).toContain('store/classification/data-sharing.json');
    expect(classificationFiles).toHaveLength(12);
  });
});
