import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { GitClient } from '../../git/git-client';
import {
  activateBundle,
  previewCandidate,
} from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { sha256Hex } from '../../shared/stable-id';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { writeWorkspaceState } from '../../classification/workspace-state';
import { V5_TAXONOMY_REVISION } from '../../classification/release-compiler';
import classificationRoutes from '../../server/routes/classification-routes';
import { timingSafeCompare } from '../../shared/timing-safe';
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

describe('classification policy routes (issue #296)', () => {
  let root: string;
  let workspaceId: string;
  let baseBundleHash: string;
  let app: Hono;
  const TEST_TOKEN = 'test-fake-token-296';

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
    root = fs.mkdtempSync(path.join(os.tmpdir(), `policy-routes-${workspaceId.slice(0, 8)}`));
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
      models: [{ id: 'qwen2.5:7b', name: 'Qwen 2.5 7B' }],
    } as any);

    upsertProviderConnection({
      id: 'conn-openai',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      trustZone: 'cloud',
      credential: 'sk-test-fake-credential',
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
      credential: 'ts-test-fake-credential',
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

    // Build test app with auth middleware replicating server/app.ts
    app = new Hono();
    app.use('/api/*', async (c, next) => {
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        await next();
        return;
      }
      const auth = c.req.header('Authorization') ?? '';
      if (!timingSafeCompare(auth, `Bearer ${TEST_TOKEN}`)) {
        return c.json({ error: 'Unauthorized. Provide a valid API token via Authorization: Bearer header.' }, 401);
      }
      await next();
    });
    app.route('/api', classificationRoutes);
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/classification/settings/policy returns policy configuration', async () => {
    const res = await app.request('/api/classification/settings/policy');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.settings).toBeDefined();
    expect(body.settings.migrationRequired).toBe(false);
    expect(body.settings.bundleHash).toBe(baseBundleHash);
    expect(body.settings.stages).toHaveLength(3);

    const ppt = body.settings.stages.find((s: any) => s.id === 'primary_product_type_proposal');
    expect(ppt).toBeDefined();
    expect(ppt.effectiveProvider).toBe('ollama');
  });

  it('POST /api/classification/settings/policy/preview enforces token authentication', async () => {
    // Missing auth header
    const unauthedRes = await app.request('/api/classification/settings/policy/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {},
      }),
    });
    expect(unauthedRes.status).toBe(401);

    // Wrong auth header
    const badAuthRes = await app.request('/api/classification/settings/policy/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {},
      }),
    });
    expect(badAuthRes.status).toBe(401);

    // Correct auth header
    const authedRes = await app.request('/api/classification/settings/policy/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {},
      }),
    });
    expect(authedRes.status).toBe(200);
    const body = await authedRes.json() as any;
    expect(body.preview).toBeDefined();
    expect(body.preview.valid).toBe(true);
    expect(body.preview.previewToken).toBeDefined();
  });

  it('POST /api/classification/settings/policy/preview rejects unwired TypeSafe adapter', async () => {
    const res = await app.request('/api/classification/settings/policy/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
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
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.preview.valid).toBe(false);
    expect(body.preview.validationErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('TypeSafe Jev typed-judgment adapter is not yet available for stage "Category Pages"'),
    ]));
  });

  it('POST /api/classification/settings/policy/apply enforces authentication and applies valid preview', async () => {
    // 1. Get valid preview
    const previewRes = await app.request('/api/classification/settings/policy/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {
          category_page_proposals: {
            connectionId: 'conn-ollama',
            model: 'qwen2.5:7b',
            fallbackConnectionId: null,
            fallbackModel: null,
          },
        },
        textDataSharing: 'local_only',
      }),
    });
    const previewBody = await previewRes.json() as any;
    const token = previewBody.preview.previewToken;

    // 2. Unauthenticated apply must fail with 401
    const unauthedApply = await app.request('/api/classification/settings/policy/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewToken: token,
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {
          category_page_proposals: {
            connectionId: 'conn-ollama',
            model: 'qwen2.5:7b',
            fallbackConnectionId: null,
            fallbackModel: null,
          },
        },
        textDataSharing: 'local_only',
      }),
    });
    expect(unauthedApply.status).toBe(401);

    // 3. Authenticated apply succeeds
    const authedApply = await app.request('/api/classification/settings/policy/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        previewToken: token,
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {
          category_page_proposals: {
            connectionId: 'conn-ollama',
            model: 'qwen2.5:7b',
            fallbackConnectionId: null,
            fallbackModel: null,
          },
        },
        textDataSharing: 'local_only',
      }),
    });
    expect(authedApply.status).toBe(200);
    const applyBody = await authedApply.json() as any;
    expect(applyBody.result.success).toBe(true);
    expect(applyBody.result.bundleHash).not.toBe(baseBundleHash);

    // 4. Stale apply attempt with same old previewToken fails with 400 (re-preview detects hash mismatch)
    const staleApply = await app.request('/api/classification/settings/policy/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        previewToken: token,
        expectedBaseBundleHash: baseBundleHash,
        stageOverrides: {
          category_page_proposals: {
            connectionId: 'conn-ollama',
            model: 'qwen2.5:7b',
            fallbackConnectionId: null,
            fallbackModel: null,
          },
        },
        textDataSharing: 'local_only',
      }),
    });
    expect(staleApply.status).toBe(400); // re-preview detects configuration hash changed
    const staleBody = await staleApply.json() as any;
    expect(staleBody.error).toContain('Configuration has changed');
  });
});
