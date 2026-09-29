import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import {
  activateBundle,
  ConfigStoreConflictError,
  ConfigStoreError,
  previewCandidate,
  updateClassificationPolicy,
} from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { sha256Hex } from '../../shared/stable-id';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { VerifiedActivationContext } from '../../classification/config-loader';
import type { ModelPolicyConfigV2, DataSharingConfigV2 } from '../../shared/schemas/classification';

const REVIEWED_FIELDS = [
  'ProductField16', 'ProductField17', 'ProductField18', 'ProductField19',
  'ProductField20', 'ProductField21', 'ProductField22', 'ProductField23',
  'ProductField24', 'ProductField25', 'ProductField26', 'ProductField27',
  'ProductField28', 'ProductField29', 'ProductField30', 'ProductField32',
  'ProductField4', 'ProductField8',
];
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

describe('classification policy writer (issue #296)', () => {
  let root: string;
  let workspaceId: string;
  let baseBundleHash: string;

  const activationContext = (): VerifiedActivationContext => ({
    catalogFields: REVIEWED_FIELDS,
    verifiedPageIds: ['page-1', 'page-2'],
    verifyCatalogEvidence: (input) => ({
      verified: input.catalogEvidenceHash === EVIDENCE_HASH && input.sourceCatalogCommit === runGit(root, ['rev-parse', 'HEAD']),
      reason: 'test verifier binds evidence hash',
    }),
  });

  beforeAll(async () => {
    setTaxonomyFreezeForTests(false);
    workspaceId = randomUUID();
    root = fs.mkdtempSync(path.join(os.tmpdir(), `policy-writer-${workspaceId.slice(0, 8)}`));
    fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });

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

    const git = new GitClient(root);
    git.init();
    fs.writeFileSync(path.join(root, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
    runGit(root, ['add', '--', 'store/manifest.json']);
    runGit(root, ['commit', '-m', 'seed catalog manifest']);

    // Activate initial candidate bundle so activeDir has full v2 setup
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const preview = previewCandidate(candidate.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
    const activation = await activateBundle(preview.hash!, null, {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      catalogEvidenceHash: EVIDENCE_HASH,
    });
    baseBundleHash = activation.hash;
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('updates model policy and data sharing under CAS with exact allowlist commit', async () => {
    const classDir = path.join(root, 'store', 'classification');
    const productTypesBefore = fs.readFileSync(path.join(classDir, 'product-types.json'), 'utf-8');

    const manifestBefore = JSON.parse(fs.readFileSync(path.join(classDir, 'manifest.json'), 'utf-8'));
    const ptHashBefore = manifestBefore.fileVersions['product-types.json'];

    const newPolicy: ModelPolicyConfigV2 = {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5:7b',
      providerLocalities: { ollama: 'local', openai: 'cloud' },
      stageOverrides: {
        primary_product_type_proposal: {
          provider: 'ollama',
          model: 'qwen2.5:14b',
          fallbackProvider: null,
          fallbackModel: null,
        },
      },
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: manifestBefore.fileVersions ? {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      } : {} as any,
    };

    const newDataSharing: DataSharingConfigV2 = {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 45,
    };

    const result = await updateClassificationPolicy({
      workspacePath: root,
      workspaceId,
      expectedBaseBundleHash: baseBundleHash,
      modelPolicy: newPolicy,
      dataSharing: newDataSharing,
    });

    expect(result.bundleHash).not.toBe(baseBundleHash);
    expect(result.commitHash).not.toBeNull();

    // Verify commit touched ONLY allowlisted files
    const commitFiles = runGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', result.commitHash!]).split('\n');
    expect(commitFiles.sort()).toEqual([
      'store/classification/data-sharing.json',
      'store/classification/manifest.json',
      'store/classification/model-policies.json',
    ].sort());

    // Verify taxonomy files are untouched and hashes match
    const productTypesAfter = fs.readFileSync(path.join(classDir, 'product-types.json'), 'utf-8');
    expect(productTypesAfter).toBe(productTypesBefore);

    const manifestAfter = JSON.parse(fs.readFileSync(path.join(classDir, 'manifest.json'), 'utf-8'));
    expect(manifestAfter.fileVersions['product-types.json']).toBe(ptHashBefore);
    expect(manifestAfter.bundleHash).toBe(result.bundleHash);

    // Update baseBundleHash for subsequent tests
    baseBundleHash = result.bundleHash;
  });

  it('rejects stale base bundle hash with ConfigStoreConflictError without committing', async () => {
    const newPolicy: ModelPolicyConfigV2 = {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5:7b',
      providerLocalities: { ollama: 'local' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    };
    const newDataSharing: DataSharingConfigV2 = {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    };

    const staleHash = '0'.repeat(64);
    await expect(updateClassificationPolicy({
      workspacePath: root,
      workspaceId,
      expectedBaseBundleHash: staleHash,
      modelPolicy: newPolicy,
      dataSharing: newDataSharing,
    })).rejects.toThrow(ConfigStoreConflictError);
  });

  it('isolates commit from dirty workspace and unstaged files', async () => {
    const classDir = path.join(root, 'store', 'classification');

    // Create an untracked file outside classification
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'hello');
    // Modify an existing classification file without staging it
    const ptPath = path.join(classDir, 'product-types.json');
    const origPtContent = fs.readFileSync(ptPath, 'utf-8');
    fs.writeFileSync(ptPath, origPtContent + '\n// dirty comment\n');

    const newPolicy: ModelPolicyConfigV2 = {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5:7b',
      providerLocalities: { ollama: 'local' },
      stageOverrides: {
        category_page_proposals: {
          provider: 'ollama',
          model: 'qwen2.5:7b',
          fallbackProvider: null,
          fallbackModel: null,
        },
      },
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    };
    const newDataSharing: DataSharingConfigV2 = {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 30,
    };

    const result = await updateClassificationPolicy({
      workspacePath: root,
      workspaceId,
      expectedBaseBundleHash: baseBundleHash,
      modelPolicy: newPolicy,
      dataSharing: newDataSharing,
    });

    // The commit should only include the allowlisted files
    const commitFiles = runGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', result.commitHash!]).split('\n');
    expect(commitFiles.sort()).toEqual([
      'store/classification/data-sharing.json',
      'store/classification/manifest.json',
      'store/classification/model-policies.json',
    ].sort());

    // The unrelated file should still be untracked
    const status = runGit(root, ['status', '--porcelain']);
    expect(status).toContain('unrelated.txt');
    expect(status).toContain('store/classification/product-types.json');

    // Clean up dirty edits
    fs.rmSync(path.join(root, 'unrelated.txt'));
    fs.writeFileSync(ptPath, origPtContent);
    baseBundleHash = result.bundleHash;
  });

  it('aborts and restores files if repository index has pre-staged out-of-scope files', async () => {
    fs.writeFileSync(path.join(root, 'prestaged.txt'), 'prestaged content');
    runGit(root, ['add', 'prestaged.txt']);

    const classDir = path.join(root, 'store', 'classification');
    const policyBefore = fs.readFileSync(path.join(classDir, 'model-policies.json'), 'utf-8');

    const newPolicy: ModelPolicyConfigV2 = {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5:32b',
      providerLocalities: { ollama: 'local' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    };
    const newDataSharing: DataSharingConfigV2 = {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 30,
    };

    await expect(updateClassificationPolicy({
      workspacePath: root,
      workspaceId,
      expectedBaseBundleHash: baseBundleHash,
      modelPolicy: newPolicy,
      dataSharing: newDataSharing,
    })).rejects.toThrow(expect.objectContaining({ code: 'pre_staged_paths' }));

    // Policy file on disk should be completely restored
    const policyAfter = fs.readFileSync(path.join(classDir, 'model-policies.json'), 'utf-8');
    expect(policyAfter).toBe(policyBefore);

    // Clean up
    runGit(root, ['reset', 'HEAD', 'prestaged.txt']);
    fs.rmSync(path.join(root, 'prestaged.txt'));
  });
});
