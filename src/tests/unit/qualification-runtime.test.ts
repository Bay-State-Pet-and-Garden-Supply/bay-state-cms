import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readQualificationFreeze, validateQualificationRuntime } from '../../../scratch/comparison-runtime';
import { QualificationRunSchema } from '../../shared/schemas/qualification-run';

const digest = 'a'.repeat(64);
function freeze(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'controlled-test',
    workspaceId: 'workspace-original',
    authorizationId: 'authorization-1',
    authorizedArms: ['baseline', 'candidate'],
    mode: 'controlled_replay',
    population: { split_payload_paths: { development: ['dev.json'], holdout: ['holdout.json'] } },
    codePins: { baseline: { repository: 'cms', revision: 'abc' }, candidate: { repository: 'cms', revision: 'def' } },
    authorizationUsdMicros: 3_000_000,
    artifacts: [{ path: 'authority.json', sha256: digest, role: 'config' }],
    limits: { maxItems: 8, maxRuntimeMs: 60_000, maxSourceArtifacts: 20, maxResponseBytes: 1_000_000, maxModelCalls: 0 },
    credentialReferences: [{ name: 'test-provider', environmentKey: 'TEST_PROVIDER_KEY' }],
    billingReferences: [],
    identity: { workspaceId: 'workspace-original', catalogCommit: 'catalog-1', configRelease: 'release-1', activationEvidenceId: 'activation-1', routingHash: digest, sharingHash: digest, modelPolicyHash: digest, domainStrategyHash: digest, profileHash: digest, catalogHash: digest, configHash: digest },
    runtimeRecords: [],
    ...overrides,
  };
}

const tempRoots: string[] = [];
async function tempRoot(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'qualification-runtime-')); tempRoots.push(path); return path; }
afterEach(async () => { await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('qualification runtime freeze', () => {
  it('accepts explicit split paths, bounded authorization, and credential references without values', () => {
    expect(QualificationRunSchema.safeParse(freeze()).success).toBe(true);
    expect(QualificationRunSchema.safeParse(freeze({ authorizationUsdMicros: 3_000_001 })).success).toBe(false);
    expect(QualificationRunSchema.safeParse(freeze({ identity: { ...freeze().identity, workspaceId: 'remapped' } })).success).toBe(false);
  });

  it('refuses copied config when activation evidence cannot resolve through normal authority', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(root, 'authority.json'), '{}');
    const snapshot = join(root, 'freeze.json');
    await writeFile(snapshot, JSON.stringify(freeze()));
    await expect(validateQualificationRuntime(snapshot, root, workspace)).rejects.toThrow();
  });

  it('rejects secret-bearing, path-escaping, and hash-mismatched snapshots', async () => {
    const root = await tempRoot();
    const secretSnapshot = join(root, 'secret.json');
    await writeFile(secretSnapshot, JSON.stringify(freeze({ runtimeRecords: [{ table: 'workspace', row: { id: 'x', api_key: 'secret' } }] })));
    await expect(readQualificationFreeze(secretSnapshot)).rejects.toThrow();
    const escaped = join(root, 'escape.json');
    await writeFile(escaped, JSON.stringify(freeze({ artifacts: [{ path: '../outside', sha256: digest, role: 'config' }] })));
    await expect(validateQualificationRuntime(escaped, root, root)).rejects.toThrow();
  });
});
