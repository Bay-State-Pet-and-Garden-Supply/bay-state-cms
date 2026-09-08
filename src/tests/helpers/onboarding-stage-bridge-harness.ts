/**
 * Slice 5a — spawned-artifact harness orchestration (Bun-only helper, NOT a
 * separately collected suite). Spawns the EMITTED bridge child
 * (`$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js`) with the
 * pinned §5.6 argv/env, enforces fixture-root safety, timeouts, redacted env,
 * and copies the redacted proof bundle to `$BRIDGE_ROOT/rehearsals/<case-id>/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface BridgeSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  report: Record<string, unknown> | null;
  artifactPath: string;
  artifactSha256: string | null;
}

export function freshFixtureRoot(prefix = 'baystate-onboarding-bridge-case-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function shaFile(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Freshly constructed child env — never inherits operator secrets. */
export function bridgeChildEnv(fixtureRoot: string, token: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: path.join(fixtureRoot, 'home'),
    TMPDIR: path.join(fixtureRoot, 'tmp'),
    ONBOARDING_COMPAT_FIXTURE_ROOT: fixtureRoot,
    PATH: '/usr/bin:/bin',
    BAYSTATE_CMS_API_TOKEN: token,
  };
}

export async function spawnBridgeChild(opts: {
  bridgeRoot: string;
  bunExe: string;
  fixtureRoot: string;
  dbPath: string;
  workspacePath: string;
  expectedStorageVersion: 2;
  timeoutMs?: number;
}): Promise<BridgeSpawnResult> {
  const entry = path.join(opts.bridgeRoot, 'bun/scripts/onboarding-stage-compat-smoke.js');
  if (!fs.existsSync(entry)) throw new Error(`missing bridge entry: ${entry}`);
  const manifest = path.join(opts.bridgeRoot, 'bridge-manifest.json');
  if (!fs.existsSync(manifest)) throw new Error('missing bridge manifest — refusing to rebuild native code as bridge');
  const reportPath = path.join(opts.fixtureRoot, 'bridge-result.json');
  const token = crypto.randomBytes(16).toString('hex');
  const env = bridgeChildEnv(opts.fixtureRoot, token);
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const argv = [
    entry,
    '--fixture-root', opts.fixtureRoot,
    '--db', opts.dbPath,
    '--workspace', opts.workspacePath,
    '--scenario', 'migrated-edited-v2',
    '--expected-storage-version', String(opts.expectedStorageVersion),
    '--manifest', manifest,
    '--report', reportPath,
  ];
  const proc = Bun.spawn([opts.bunExe, ...argv], {
    cwd: opts.fixtureRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  let report: Record<string, unknown> | null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    report = null;
  }
  // Copy redacted proof bundle (token never written).
  const caseId = path.basename(opts.fixtureRoot);
  const dest = path.join(opts.bridgeRoot, 'rehearsals', caseId);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'proof.json'),
    JSON.stringify({ argv: [opts.bunExe, ...argv], exitCode, report, artifactPath: entry }, null, 2),
  );
  return { exitCode, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), report, artifactPath: entry, artifactSha256: shaFile(entry) };
}
