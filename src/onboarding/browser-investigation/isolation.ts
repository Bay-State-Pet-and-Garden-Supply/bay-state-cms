// Browser Investigation isolation boundary (T3).
//
// Investigation-only container posture for the local browser harness.
// Missing isolation fails closed (`isolation_unavailable`) — it never
// degrades to an unrestricted browser and never affects normal extraction.
//
// Posture (all enforced by `assertContainerPosture` before dispatch):
// - no host networking, no privileged mode, no Docker socket, no
//   credentials / host-profile / unrelated host mounts;
// - non-root user, all Linux capabilities dropped, no-new-privileges,
//   browser + container sandboxes retained (no `--no-sandbox` workarounds);
// - read-only root filesystem with narrow bounded tmpfs exceptions;
// - explicit CPU / memory / process limits;
// - fresh state per run with deterministic teardown (always-remove).
//
// Pure except for the injectable Docker probe / runner, so posture and
// gating are Vitest-exercisable without a daemon.

export const INVESTIGATION_CONTAINER_IMAGE = 'baystate/investigation-browser:1' as const;
/** Container user is a numeric non-root uid:gid (`65532:65532`); never `root`. */

export interface InvestigationContainerSpec {
  image: string;
  /** Must be 'none': the container has no direct outbound route. */
  networkMode: string;
  privileged: boolean;
  capDrop: string[];
  capAdd: string[];
  securityOpt: string[];
  /** Non-root `uid:gid`. */
  user: string;
  readOnlyRootFilesystem: boolean;
  /** Narrow bounded writable exceptions only (no host mounts). */
  tmpfs: Record<string, string>;
  /** Host bind mounts. Must always be empty. */
  mounts: string[];
  /** Environment passed into the container. Must carry no secrets. */
  env: Record<string, string>;
  cpus: number;
  memory: string;
  pidsLimit: number;
  /** Browser flags. Must retain the sandbox (never `--no-sandbox`). */
  browserArgs: string[];
  /** Fresh per-run identifier (container name suffix). */
  runId: string;
  /** Teardown policy. Always 'always-remove'. */
  teardown: string;
}

export class IsolationError extends Error {
  // fallow-ignore-next-line unused-class-member
  readonly code = 'isolation_unavailable' as const;
  constructor(message: string) {
    super(`isolation_unavailable: ${message}`);
    this.name = 'IsolationError';
  }
}

export interface ContainerLimitOverrides {
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
}

/**
 * Build the investigation-only container spec for one run. Fresh state per
 * run: the caller supplies a unique runId used as the container name suffix.
 */
export function buildInvestigationContainerSpec(
  runId: string,
  overrides?: ContainerLimitOverrides,
): InvestigationContainerSpec {
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new IsolationError('runId required to scope fresh container state');
  }
  return {
    image: INVESTIGATION_CONTAINER_IMAGE,
    networkMode: 'none',
    privileged: false,
    capDrop: ['ALL'],
    capAdd: [],
    securityOpt: ['no-new-privileges'],
    user: '65532:65532',
    readOnlyRootFilesystem: true,
    tmpfs: {
      '/tmp': 'size=256m,mode=1777',
      '/home/browser': 'size=256m,mode=700',
      '/dev/shm': 'size=512m,mode=1777',
    },
    mounts: [],
    env: {},
    cpus: overrides?.cpus ?? 2,
    memory: overrides?.memory ?? '2g',
    pidsLimit: overrides?.pidsLimit ?? 256,
    browserArgs: [
      '--headless=new',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    runId,
    teardown: 'always-remove',
  };
}

/**
 * Fail-closed posture assertion. Any deviation — host networking,
 * privileged mode, socket/credential mounts, root user, retained
 * capabilities, missing no-new-privileges, writable root, unbounded tmpfs,
 * missing limits, sandbox disabled, secret-bearing env — throws.
 */
export function assertContainerPosture(spec: InvestigationContainerSpec): void {
  assertContainerNetwork(spec);
  assertContainerIdentity(spec);
  assertContainerFilesystem(spec);
  assertContainerLimits(spec);
  assertContainerRuntime(spec);
}

function violation(reason: string): never {
  throw new IsolationError(`container posture violation: ${reason}`);
}

/** No host networking, no privileged mode: the container has no outbound route. */
function assertContainerNetwork(spec: InvestigationContainerSpec): void {
  if (spec.networkMode !== 'none') violation(`networkMode must be 'none', got '${spec.networkMode}'`);
  if (spec.privileged) violation('privileged mode forbidden');
}

/** Non-root, dropped capabilities, no-new-privileges. */
function assertContainerIdentity(spec: InvestigationContainerSpec): void {
  if (!spec.capDrop.includes('ALL')) violation('all Linux capabilities must be dropped');
  if (spec.capAdd.length > 0) violation('no Linux capabilities may be added');
  if (!spec.securityOpt.includes('no-new-privileges')) violation('no-new-privileges required');
  if (!spec.user || spec.user === 'root' || spec.user === '0' || spec.user === '0:0') {
    violation('non-root user required');
  }
}

/** Read-only root, narrow bounded tmpfs, no host mounts, no secret env. */
function assertContainerFilesystem(spec: InvestigationContainerSpec): void {
  if (!spec.readOnlyRootFilesystem) violation('read-only root filesystem required');
  assertTmpfsBounds(spec.tmpfs);
  assertNoHostMounts(spec.mounts);
  assertNoSecretEnv(spec.env);
}

/** Narrow bounded tmpfs exceptions only (never a broad host mount). */
function assertTmpfsBounds(tmpfs: Record<string, string>): void {
  const mounts = Object.entries(tmpfs);
  if (mounts.length === 0) violation('bounded tmpfs scratch required');
  if (mounts.length > 8) violation('tmpfs exceptions must stay narrow');
  let totalMb = 0;
  for (const [path, opts] of mounts) {
    if (!path.startsWith('/')) violation(`tmpfs mount must be absolute: ${path}`);
    const sizeMb = parseTmpfsSizeMb(opts);
    if (sizeMb === null) violation(`tmpfs mount must be size-bounded: ${path}`);
    if (sizeMb > MAX_SINGLE_TMPFS_MB) violation(`tmpfs mount exceeds ${MAX_SINGLE_TMPFS_MB}m: ${path}`);
    totalMb += sizeMb;
  }
  if (totalMb > MAX_TOTAL_TMPFS_MB) {
    violation(`total tmpfs scratch exceeds ${MAX_TOTAL_TMPFS_MB}m`);
  }
}

/** Parse the `size=<n>m` component of a tmpfs option string (null when absent). */
function parseTmpfsSizeMb(opts: string): number | null {
  const match = /size=(\d+)m/i.exec(opts);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** No host bind mounts: no socket, credentials, or host profiles. */
function assertNoHostMounts(mounts: string[]): void {
  if (mounts.length === 0) return;
  if (mounts.join(' ').includes('docker.sock')) violation('Docker socket mount forbidden');
  violation('host bind mounts forbidden (no socket, credentials, or profiles)');
}

/** Container env must carry no secrets (no keys/tokens/passwords). */
function assertNoSecretEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (/key|token|secret|password|credential|api[_-]?key/i.test(`${key}=${value}`)) {
      violation('container env must carry no secrets');
    }
  }
}

/** Explicit non-unlimited CPU, memory, and process limits. */
function assertContainerLimits(spec: InvestigationContainerSpec): void {
  if (!(spec.cpus > 0) || spec.cpus > 16) violation('explicit CPU limit required (0 < cpus <= 16)');
  if (!/^\d+[mg]$/i.test(spec.memory)) violation('explicit memory limit required (e.g. 2g)');
  if (!(spec.pidsLimit > 0) || spec.pidsLimit > 4096) violation('explicit process limit required');
}

/** Pinned image, retained sandboxes, fresh per-run state, deterministic teardown. */
function assertContainerRuntime(spec: InvestigationContainerSpec): void {
  // The image is pinned: a substitute image has not passed the posture audit
  // this spec encodes, so it fails closed rather than running unreviewed code.
  if (spec.image !== INVESTIGATION_CONTAINER_IMAGE) {
    violation(`image must be the pinned investigation image ${INVESTIGATION_CONTAINER_IMAGE}`);
  }
  if (spec.browserArgs.includes('--no-sandbox')) {
    violation('browser sandbox must be retained (no --no-sandbox workarounds)');
  }
  if (!spec.runId) violation('per-run fresh state requires a runId');
  if (spec.teardown !== 'always-remove') violation('deterministic teardown (always-remove) required');
}

/** Maximum total writable tmpfs scratch per run (narrow by construction). */
const MAX_TOTAL_TMPFS_MB = 2048;
/** Maximum writable scratch per tmpfs mount. */
const MAX_SINGLE_TMPFS_MB = 1024;

/**
 * Deterministic container name for a run. Shared by argv construction and
 * teardown so explicit removal targets the same container `--rm` reaps.
 */
// fallow-ignore-next-line unused-export — default runner + containment tests
export function containerNameForRun(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!cleaned) throw new IsolationError('runId required to scope fresh container state');
  return `binv-${cleaned}`;
}

/**
 * Translate the posture spec to `docker run` argv. The argv is the auditable
 * artifact: containment tests assert the denial flags here AND exercise them
 * against a live daemon when one is available.
 */
// fallow-ignore-next-line unused-export — containment tests + future runner
export function containerSpecToDockerArgs(spec: InvestigationContainerSpec): string[] {
  assertContainerPosture(spec);
  const args = [
    'run',
    '--rm',
    `--name=${containerNameForRun(spec.runId)}`,
    `--network=${spec.networkMode}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--user=${spec.user}`,
    '--read-only',
  ];
  for (const [path, opts] of Object.entries(spec.tmpfs)) args.push(`--tmpfs=${path}:${opts}`);
  args.push(`--cpus=${spec.cpus}`, `--memory=${spec.memory}`, `--pids-limit=${spec.pidsLimit}`);
  for (const [key, value] of Object.entries(spec.env)) args.push(`--env=${key}=${value}`);
  args.push(spec.image);
  return args;
}

// ─── Availability gating ──────────────────────────────────────────────────

export interface IsolationProbe {
  /** True when an isolated Docker runtime is reachable. Never throws. */
  dockerReachable(): Promise<boolean>;
}

export interface IsolationStatus {
  available: boolean;
  reason: string;
}

/**
 * Required configuration + reachable runtime, or unavailable. The harness
 * consults this before dispatch and fails closed when isolation is missing.
 *
 * Explicit enablement (`BAYSTATE_INVESTIGATION_ISOLATION=ready`) is required
 * configuration: even a reachable daemon does not authorize investigation
 * runs on its own. Tests inject a fake probe; the default env-gated probe
 * never spawns a subprocess when enablement is absent.
 */
export async function checkIsolationAvailable(probe?: IsolationProbe): Promise<IsolationStatus> {
  if (process.env.BAYSTATE_INVESTIGATION_ISOLATION !== 'ready') {
    return { available: false, reason: 'investigation isolation not enabled (BAYSTATE_INVESTIGATION_ISOLATION!=ready)' };
  }
  let reachable: boolean;
  try {
    reachable = probe ? await probe.dockerReachable() : await defaultDockerProbe();
  } catch {
    reachable = false;
  }
  if (!reachable) return { available: false, reason: 'isolated Docker runtime unreachable' };
  return { available: true, reason: 'isolated Docker runtime reachable' };
}

async function defaultDockerProbe(): Promise<boolean> {
  try {
    const bun = (globalThis as { Bun?: { spawn: (cmd: string[], opts?: unknown) => { exited: Promise<number> } } }).Bun;
    if (!bun) return false;
    const proc = bun.spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// ─── Serialization + deterministic teardown ───────────────────────────────
// One local browser investigation at a time (design-doc run budget).

let slotHeld = false;

/** Acquire the single local-investigation slot. Returns false when busy. */
// fallow-ignore-next-line unused-export — harness + tests
export function tryAcquireInvestigationSlot(): boolean {
  if (slotHeld) return false;
  slotHeld = true;
  return true;
}

// fallow-ignore-next-line unused-export — harness + tests
export function releaseInvestigationSlot(): void {
  slotHeld = false;
}

// fallow-ignore-next-line unused-export — tests
export function isInvestigationSlotHeld(): boolean {
  return slotHeld;
}

export interface ContainerRunner {
  /** Remove the run container. Must be idempotent and never throw. */
  teardown(runId: string): Promise<void>;
}

/**
 * Run `fn` with guaranteed deterministic teardown: the run container is
 * removed on success, failure, timeout, AND cancellation. Teardown failures
 * are swallowed (idempotent best-effort) so they cannot mask the run outcome.
 */
// fallow-ignore-next-line unused-export — harness + tests
export async function withIsolatedRun<T>(
  runId: string,
  runner: ContainerRunner,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    try {
      await runner.teardown(runId);
    } catch {
      // Deterministic teardown is best-effort idempotent; never mask outcome.
    }
  }
}
