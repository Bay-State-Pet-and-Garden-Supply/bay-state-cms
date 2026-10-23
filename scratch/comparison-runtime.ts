import type { Database } from 'bun:sqlite';

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, copyFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { createRuntimeActivationContext, loadRuntimeConfigAuthority, type RuntimeConfigAuthority } from '../src/classification/config-loader';
import { captureModelPolicySnapshot, type ModelPolicySnapshot } from '../src/onboarding/model-policy-snapshot';
import { QualificationRunSchema, type QualificationRun } from '../src/shared/schemas/qualification-run';

export interface QualificationRuntimeValidation {
  run: QualificationRun;
  authority: RuntimeConfigAuthority;
  modelPolicy: ModelPolicySnapshot;
  workspacePath: string;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Runtime artifact escapes private evaluation root');
}

async function resolvePrivateFile(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) throw new Error('Runtime artifact path must be relative');
  const candidate = resolve(root, relativePath);
  assertContained(root, candidate);
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Runtime artifact must be a regular non-symlink file');
  const actual = await realpath(candidate);
  assertContained(root, actual);
  return actual;
}

function hasSecretMaterial(value: unknown, key = ''): boolean {
  if (/(?:secret|password|token|api.?key|private.?key)/i.test(key)) return true;
  if (Array.isArray(value)) return value.some(item => hasSecretMaterial(item));
  if (value && typeof value === 'object') return Object.entries(value).some(([child, item]) => hasSecretMaterial(item, child));
  return false;
}

export async function readQualificationFreeze(path: string): Promise<QualificationRun> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const parsed = QualificationRunSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid qualification freeze: ${parsed.error.message}`);
  if (hasSecretMaterial(parsed.data.runtimeRecords) || hasSecretMaterial(parsed.data.credentialReferences)) throw new Error('Qualification freeze contains secret material');
  return parsed.data;
}

export async function validateQualificationRuntime(
  freezePath: string,
  privateRoot: string,
  workspacePath: string,
  db?: Database,
): Promise<QualificationRuntimeValidation> {
  const root = await realpath(privateRoot);
  const workspace = await realpath(workspacePath);
  assertContained(root, workspace);
  const freezeFile = await realpath(freezePath.startsWith('/') ? freezePath : resolve(root, freezePath));
  assertContained(root, freezeFile);
  const run = await readQualificationFreeze(freezeFile);
  for (const artifact of run.artifacts) {
    if (artifact.role === 'source_response' && run.mode !== 'controlled_replay') throw new Error('Live operational runtime cannot import replay source artifacts');
    if (artifact.role === 'workspace' || artifact.role === 'catalog' || artifact.role === 'config' || artifact.role === 'activation') {
      // Authority inputs must be present under the supplied private root, never discovered from a store.
    }
    const file = await resolvePrivateFile(root, artifact.path);
    const bytes = await readFile(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) throw new Error(`Runtime artifact hash mismatch: ${artifact.path}`);
    try {
      if (hasSecretMaterial(JSON.parse(bytes.toString('utf8')))) throw new Error(`Secret material in runtime artifact: ${artifact.path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Secret material')) throw error;
      // Binary and non-JSON source artifacts are bound by their declared digest.
    }
  }
  const authority = loadRuntimeConfigAuthority(workspace, createRuntimeActivationContext(workspace, run.workspaceId, db));
  if (authority.kind !== 'v2') throw new Error('Qualification runtime requires committed v2 authority');
  const policySnapshot = captureModelPolicySnapshot(workspace, undefined, run.workspaceId);
  if (policySnapshot.state !== 'configured') throw new Error(`Model policy unavailable: ${policySnapshot.reason}`);
  return { run, authority, modelPolicy: policySnapshot, workspacePath: workspace };
}

export async function materializeQualificationRuntime(
  freezePath: string,
  privateRoot: string,
  workspacePath: string,
  destinationRoot: string,
  db?: Database,
): Promise<QualificationRuntimeValidation> {
  const root = await realpath(privateRoot);
  const checked = await validateQualificationRuntime(freezePath, privateRoot, workspacePath, db);
  const destination = resolve(destinationRoot);
  assertContained(root, destination);
  const parentReal = await realpath(dirname(destination));
  assertContained(root, parentReal);
  const stage = resolve(parentReal, `.${basename(destination)}-${randomUUID()}`);
  const workspaceRelative = relative(root, await realpath(workspacePath));
  try {
    await mkdir(stage, { recursive: false });
    for (const artifact of checked.run.artifacts) {
      const source = await resolvePrivateFile(root, artifact.path);
      const target = resolve(stage, artifact.path);
      assertContained(stage, target);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    }
    const stagedWorkspace = resolve(stage, workspaceRelative);
    assertContained(stage, stagedWorkspace);
    await mkdir(dirname(stagedWorkspace), { recursive: true });
    if ((await lstat(destination).catch(() => null)) !== null) throw new Error('Disposable destination already exists');
    await rename(stage, destination);
    return await validateQualificationRuntime(freezePath, privateRoot, resolve(destination, workspaceRelative), db);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if ((await lstat(destination).catch(() => null)) !== null) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
