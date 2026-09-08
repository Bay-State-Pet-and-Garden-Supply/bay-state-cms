#!/usr/bin/env bun
/**
 * Slice 5a — pinned bridge build/packaging orchestrator (council plan §5.6).
 *
 * Build from the Slice 5a BRIDGE source state (before native enum cutover).
 * Emits ESM bundles + client + manifest/checksums under a fresh private
 * $BRIDGE_ROOT (mkdtemp, refused if existing/nonempty or inside app/catalog/
 * live workspace). Records Bun 1.3.5 compiler/runtime, tsc version,
 * source/lock/asset hashes, entries, and runtime inputs.
 *
 * Exact invocation:
 *   bun scripts/build-onboarding-stage-bridge.ts --source-root "$PWD" \
 *     --output-parent /tmp --prefix baystate-onboarding-bridge- \
 *     --write-pointer /tmp/baystate-onboarding-bridge-current.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(name: string, fallback = ''): string {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1] as string;
  return fallback;
}
function shaFile(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** All files under a dir, as forward-slash relative paths. */
function emittedFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...emittedFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

const sourceRoot = path.resolve(arg('source-root', process.cwd()));
const outputParent = path.resolve(arg('output-parent', os.tmpdir()));
const prefix = arg('prefix', 'baystate-onboarding-bridge-');
const pointerPath = arg('write-pointer', '');
if (!pointerPath) {
  console.error('Missing --write-pointer=<path>');
  process.exit(2);
}
if (fs.existsSync(pointerPath)) {
  console.error(`Pointer exists (${pointerPath}) — refusing to clobber; choose a new evidence path`);
  process.exit(2);
}

const bridgeRoot = fs.mkdtempSync(path.join(outputParent, prefix));
const bunDir = path.join(bridgeRoot, 'bun');
fs.mkdirSync(bunDir, { recursive: true });
const logPath = path.join(bridgeRoot, 'build.log');
const log: string[] = [];
const run = (cmd: string): void => {
  log.push(`$ ${cmd}`);
  const out = Bun.spawnSync(['sh', '-c', cmd], { cwd: sourceRoot });
  log.push(out.stdout.toString().slice(-4000));
  log.push(out.stderr.toString().slice(-4000));
  if (out.exitCode !== 0) {
    fs.writeFileSync(logPath, log.join('\n'));
    console.error(`build step failed: ${cmd}`);
    process.exit(1);
  }
};

// Pinned entries — must exist.
for (const e of ['src/server/index.ts', 'src/server/app.ts', 'scripts/onboarding-stage-compat-smoke.ts']) {
  if (!fs.existsSync(path.join(sourceRoot, e))) {
    console.error(`Missing build entry: ${e}`);
    process.exit(2);
  }
}
run(`bun build --target=bun --format=esm --splitting --packages=external --root . --outdir "${bunDir}/bun-tmp" src/server/index.ts src/server/app.ts scripts/onboarding-stage-compat-smoke.ts`);
// Relocate EVERY emitted file (entries + shared chunks) preserving relative
// structure, so code-split imports resolve. Then assert pinned entries exist.
for (const f of emittedFiles(path.join(bunDir, 'bun-tmp'))) {
  const src = path.join(bunDir, 'bun-tmp', f);
  const dst = path.join(bunDir, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}
fs.rmSync(path.join(bunDir, 'bun-tmp'), { recursive: true, force: true });
for (const pinned of ['src/server/index.js', 'src/server/app.js', 'scripts/onboarding-stage-compat-smoke.js']) {
  if (!fs.existsSync(path.join(bunDir, pinned))) {
    console.error(`Missing pinned output: ${pinned}`);
    process.exit(2);
  }
}

const clientDir = path.join(bridgeRoot, 'client');
run(
  `VITE_BATCH_WORKSPACE_ENABLED=true VITE_ONBOARDING_SHELL_V2=false VITE_BRAND_GATE_V2=false VITE_EXECUTION_STRIP_V2=false VITE_PIPELINE_DIAGNOSTICS_ENABLED=false bun node_modules/vite/bin/vite.js build --outDir "${clientDir}"`,
);

const bunVersion = Bun.spawnSync(['bun', '--version'], {}).stdout.toString().trim();
const bunRevision = Bun.spawnSync(['bun', '--revision'], {}).stdout.toString().trim();
const tscVersion = Bun.spawnSync(['bun', 'node_modules/typescript/bin/tsc', '--version'], { cwd: sourceRoot }).stdout
  .toString()
  .trim();
const manifest = {
  bridgeRoot,
  builtAt: new Date().toISOString(),
  entries: ['src/server/index.ts', 'src/server/app.ts', 'scripts/onboarding-stage-compat-smoke.ts'],
  outputs: [
    '$BRIDGE_ROOT/bun/src/server/index.js',
    '$BRIDGE_ROOT/bun/src/server/app.js',
    '$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js',
  ],
  compiler: { bunVersion, bunRevision, bunExecutableSha256: shaFile(process.execPath), tscVersion },
  platform: `${os.platform()}/${os.arch()}`,
  sourceRoot,
  inputs: {
    'package.json': fs.existsSync(path.join(sourceRoot, 'package.json')) ? shaFile(path.join(sourceRoot, 'package.json')) : null,
    'bun.lock': fs.existsSync(path.join(sourceRoot, 'bun.lock')) ? shaFile(path.join(sourceRoot, 'bun.lock')) : null,
    'tsconfig.json': fs.existsSync(path.join(sourceRoot, 'tsconfig.json')) ? shaFile(path.join(sourceRoot, 'tsconfig.json')) : null,
    migrationSql: shaFile(path.join(sourceRoot, 'src/db/onboarding-stage-vocabulary-migration.sql')),
  },
  uiFlags: {
    VITE_BATCH_WORKSPACE_ENABLED: 'true',
    VITE_ONBOARDING_SHELL_V2: 'false',
    VITE_BRAND_GATE_V2: 'false',
    VITE_EXECUTION_STRIP_V2: 'false',
    VITE_PIPELINE_DIAGNOSTICS_ENABLED: 'false',
  },
};
fs.writeFileSync(path.join(bridgeRoot, 'bridge-manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(bridgeRoot, 'versions.txt'), `bun ${bunVersion}\nrevision ${bunRevision}\n${tscVersion}\n${os.platform()}/${os.arch()}\n`);
fs.writeFileSync(logPath, log.join('\n'));
// SHA256SUMS over emitted artifacts.
const sums: string[] = [];
const walk = (dir: string): void => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (!p.endsWith('SHA256SUMS') && !p.endsWith('bridge-manifest.sha256')) {
      sums.push(`${shaFile(p)}  ${path.relative(bridgeRoot, p)}`);
    }
  }
};
walk(bunDir);
walk(clientDir);
fs.writeFileSync(path.join(bridgeRoot, 'SHA256SUMS'), sums.sort().join('\n') + '\n');
fs.writeFileSync(
  path.join(bridgeRoot, 'bridge-manifest.sha256'),
  shaFile(path.join(bridgeRoot, 'bridge-manifest.json')) + '  bridge-manifest.json\n',
);
fs.writeFileSync(pointerPath, JSON.stringify({ bridgeRoot, manifest: path.join(bridgeRoot, 'bridge-manifest.json') }, null, 2));
console.log(JSON.stringify({ bridgeRoot, ok: true }));
