import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { GitClient } from '../../git/git-client';
import {
  activateBundle,
  previewCandidate,
} from '../../classification/config-store';
import {
  getClassificationPolicySettings,
  previewClassificationPolicy,
  applyClassificationPolicy,
  ClassificationPolicyServiceError,
} from '../../classification/classification-policy-service';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { sha256Hex } from '../../shared/stable-id';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { writeWorkspaceState } from '../../classification/workspace-state';
import { V5_TAXONOMY_REVISION } from '../../classification/release-compiler';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { VerifiedActivationContext } from '../../classification/config-loader';

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

describe('classification policy service (issue #296)', () => {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), `policy-service-${workspaceId.slice(0, 8)}`));
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

    // Seed test connections in DB
    upsertProviderConnection({
      id: 'conn-ollama',
      label: 'Local Ollama',
      transport: 'ollama-native',
      baseUrl: 'http://127.0.0.1:11434',
      trustZone: 'this_device',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'qwen2.5:7b', name: 'Qwen 2.5 7B' }, { id: 'qwen2.5:14b', name: 'Qwen 2.5 14B' }],
    } as any);

    upsertProviderConnection({
      id: 'conn-openai',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      trustZone: 'cloud',
      credential: 'sk-test-secret',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }],
    } as any);

    upsertProviderConnection({
      id: 'conn-typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'ts-test-secret',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as any);

    const git = new GitClient(root);
    git.init();
    fs.writeFileSync(path.join(root, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
    runGit(root, ['add', '--', 'store/manifest.json']);
    runGit(root, ['commit', '-m', 'seed catalog manifest']);

    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const preview = previewCandidate(candidate.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
    const activation = await activateBundle(preview.hash!, null, {
      workspacePath: root,
      workspaceId,
      activationContext: activationContext(),
      catalogEvidenceHash: EVIDENCE_HASH,
    });
    baseBundleHash = activation.hash;
    writeWorkspaceState(root, { activeTaxonomyRevision: V5_TAXONOMY_REVISION, updatedAt: new Date().toISOString() });
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads classification policy settings with the three stages and effective routes', () => {
    const settings = getClassificationPolicySettings(root, workspaceId);

    expect(settings.migrationRequired).toBe(false);
    expect(settings.bundleHash).toBe(baseBundleHash);
    expect(settings.stages).toHaveLength(3);

    const stageIds = settings.stages.map(s => s.id);
    expect(stageIds).toContain('primary_product_type_proposal');
    expect(stageIds).toContain('product_attribute_proposals');
    expect(stageIds).toContain('category_page_proposals');

    const ppt = settings.stages.find(s => s.id === 'primary_product_type_proposal')!;
    expect(ppt.isInherited).toBe(true);
    expect(ppt.effectiveProvider).toBe('ollama');

    // Available connections list
    const connectionIds = settings.availableConnections.map(c => c.id);
    expect(connectionIds).toContain('conn-ollama');
    expect(connectionIds).toContain('conn-openai');
    expect(connectionIds).toContain('conn-typesafe');

    // TypeSafe SystemOne is supported for primary_product_type_proposal (#297) and product_attribute_proposals (#298), and unwired for category_page_proposals (#299)
    const typeSafe = settings.availableConnections.find(c => c.id === 'conn-typesafe')!;
    expect(typeSafe.stageSupport.primary_product_type_proposal.supported).toBe(true);
    expect(typeSafe.stageSupport.product_attribute_proposals.supported).toBe(true);
    expect(typeSafe.stageSupport.category_page_proposals.supported).toBe(false);
    expect(typeSafe.stageSupport.category_page_proposals.reason).toContain('not yet available');
  });

  it('previews a valid policy update and flags cloud data-sharing requirements', () => {
    const preview = previewClassificationPolicy(root, {
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        primary_product_type_proposal: {
          connectionId: 'conn-openai',
          model: 'gpt-4o-mini',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'local_only',
    });

    expect(preview.valid).toBe(false);
    expect(preview.validationErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('requires textDataSharing to be cloud_allowed'),
    ]));

    // Now preview with cloud_allowed text data sharing
    const validPreview = previewClassificationPolicy(root, {
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        primary_product_type_proposal: {
          connectionId: 'conn-openai',
          model: 'gpt-4o-mini',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'cloud_allowed',
    });

    expect(validPreview.valid).toBe(true);
    expect(validPreview.previewToken).toBeDefined();
    expect(validPreview.dataSharingEffects.length).toBeGreaterThan(0);
  });

  it('allows preview for primary_product_type_proposal with TypeSafe Jev and rejects unwired stages', () => {
    // Valid preview for primary_product_type_proposal with Jev
    const validJevPreview = previewClassificationPolicy(root, {
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        primary_product_type_proposal: {
          connectionId: 'conn-typesafe',
          model: 'jev-1.13.0',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'cloud_allowed',
    });

    expect(validJevPreview.valid).toBe(true);
    expect(validJevPreview.previewToken).toBeDefined();

    // Valid preview for product_attribute_proposals with Jev (#298)
    const validAttrJevPreview = previewClassificationPolicy(root, {
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        product_attribute_proposals: {
          connectionId: 'conn-typesafe',
          model: 'jev-1.13.0',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'cloud_allowed',
    });

    expect(validAttrJevPreview.valid).toBe(true);
    expect(validAttrJevPreview.previewToken).toBeDefined();

    // Rejects unwired stage (category_page_proposals)
    const unwiredPreview = previewClassificationPolicy(root, {
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        category_page_proposals: {
          connectionId: 'conn-typesafe',
          model: 'jev-1.13.0',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'cloud_allowed',
    });

    expect(unwiredPreview.valid).toBe(false);
    expect(unwiredPreview.validationErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('TypeSafe Jev typed-judgment adapter is not yet available for stage "Category Pages"'),
    ]));
  });

  it('applies policy changes under CAS and rejects stale preview tokens', async () => {
    // 1. Generate valid preview
    const preview = previewClassificationPolicy(root, {
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        product_attribute_proposals: {
          connectionId: 'conn-ollama',
          model: 'qwen2.5:14b',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'local_only',
    });

    expect(preview.valid).toBe(true);
    const token = preview.previewToken!;

    // 2. Apply valid preview
    const result = await applyClassificationPolicy(root, workspaceId, {
      previewToken: token,
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        product_attribute_proposals: {
          connectionId: 'conn-ollama',
          model: 'qwen2.5:14b',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'local_only',
    });

    expect(result.success).toBe(true);
    expect(result.bundleHash).not.toBe(baseBundleHash);

    // 3. Stale token attempt with old baseBundleHash must be rejected
    await expect(applyClassificationPolicy(root, workspaceId, {
      previewToken: token,
      expectedBaseBundleHash: baseBundleHash,
      stageOverrides: {
        product_attribute_proposals: {
          connectionId: 'conn-ollama',
          model: 'qwen2.5:14b',
          fallbackConnectionId: null,
          fallbackModel: null,
        },
      },
      textDataSharing: 'local_only',
    })).rejects.toThrow(ClassificationPolicyServiceError);
  });
});
