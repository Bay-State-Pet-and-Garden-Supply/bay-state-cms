import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { resolve } from 'path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const root = resolve(import.meta.dirname, '..');

// Generate or read a per-dev API token for mutating request security
const tokenPath = join(root, '.baystate-cms-dev-token');
let apiToken: string;
try {
  if (existsSync(tokenPath)) {
    apiToken = readFileSync(tokenPath, 'utf-8').trim();
  } else {
    apiToken = randomBytes(32).toString('hex');
    try { mkdirSync(join(root, '.baystate-cms-dev-token-dir'), { recursive: true }); } catch { /* dir exists */ }
    writeFileSync(tokenPath, apiToken, { mode: 0o600 });
  }
} catch {
  apiToken = randomBytes(32).toString('hex');
}

// Generate a shared worker token used by both the Bun server and the worker process
const workerToken = randomBytes(32).toString('hex');

const env = {
  ...process.env,
  NODE_ENV: 'development',
  BAYSTATE_CMS_API_TOKEN: apiToken,
  BAYSTATE_CMS_WORKER_TOKEN: workerToken,
  HOST: '127.0.0.1',
};

// Start API server with watch mode so it reloads on code changes
const server = spawn('bun', ['--watch', 'src/server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env,
});

// Start extraction worker (Node.js sidecar for Playwright, snapshots, validation)
const worker = spawn(
  'node',
  [
    '--import', './preload/crawlee-storage.mjs',
    '--import', 'tsx',
    '--watch',
    'src/extraction-worker/server.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      BAYSTATE_CMS_WORKER_HOST: '127.0.0.1',
      BAYSTATE_CMS_WORKER_PORT: '3032',
      BAYSTATE_CMS_WORKER_TOKEN: workerToken,
    },
  },
);

// Start Vite dev server - bind to 127.0.0.1 for security
const vite = spawn(
  'bunx',
  ['vite', '--host', '127.0.0.1'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_BAYSTATE_CMS_API_TOKEN: apiToken,
      BAYSTATE_CMS_WORKER_TOKEN: workerToken,
    },
  },
);

console.log(`Bay State CMS dev mode started.`);
console.log(`API token: ${apiToken}`);
console.log(`Server bound to 127.0.0.1:${process.env.PORT ?? '3030'}`);
console.log(`Worker bound to 127.0.0.1:3032`);
console.log(`Worker token: ${workerToken}`);
console.log(`Vite bound to 127.0.0.1:5173`);

process.on('SIGINT', () => {
  server.kill();
  vite.kill();
  worker.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.kill();
  vite.kill();
  worker.kill();
  process.exit(0);
});
