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

// ─── Tier 0 / Tier 1 network shape (recorded decision, #236 + #237) ───────
// Tier 0 (implemented): host-side broker fetch with in-container analysis.
// Page bytes travel host → container on stdin as broker-approved captures;
// the container has no egress of its own (`network none`, deny all) and
// returns typed observations on stdout. The host never parses page bytes.
// Tier 1 (implemented, #237): a render container reusing the existing
// rendered-page stack whose ONLY egress is the validating forward proxy
// (`render-proxy.ts`, host-side, broker-validated per request) on the
// isolated render network. Direct container egress is denied at container
// level (proven by the Tier 1 denial suite). See docs/plans/browser-investigation-design.md

export const INVESTIGATION_NETWORK_SHAPE = {
  tier0: {
    implemented: true as const,
    fetchLocation: 'host_broker' as const,
    analysisLocation: 'container' as const,
    containerNetwork: 'none' as const,
    containerEgress: 'deny_all' as const,
  },
  tier1: {
    implemented: true as const,
    egress: 'proxy_only' as const,
    note: 'render container on the isolated render network; sole egress is the validating forward proxy (#237)',
  },
} as const;

/** Tier 1 rendered investigation runs in the render container (proxy-only egress). */
export const TIER1_RENDER_CONTAINER_STATUS =
  'active: render container on the isolated render network with proxy-only egress to the validating forward proxy (#237)' as const;

/** Pinned image for the Tier 1 render container (posture-pinned, like the Tier 0 image). */
export const RENDER_CONTAINER_IMAGE = 'baystate/investigation-render:1' as const;

/**
 * Isolated Docker network for the Tier 1 render container. Created with
 * `--internal` (no external route): the container's sole network path is
 * the validating forward proxy, reached as a peer on this network. The
 * proxy itself is host-side and validates every request through the
 * broker policy before forwarding.
 */
export const RENDER_CONTAINER_NETWORK = 'binv-render-only' as const;

/** Container path of the Tier 1 render-worker entrypoint (baked into the pinned render image, run under bun). */
export const RENDER_WORKER_CONTAINER_ENTRYPOINT =
  '/app/src/onboarding/browser-investigation/render-worker.ts' as const;

/** Posture spec for one Tier 1 render-container run. */
export interface RenderContainerSpec {
  image: string;
  /** Must be 'proxy-only': the container lives on the isolated render network. */
  networkMode: string;
  /** Docker network name. Must be the isolated render network. */
  networkName: string;
  /** Validating forward proxy URL (http, credential-free). The sole egress. */
  proxyUrl: string;
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
  /**
   * Environment passed into the container. Must be exactly the proxy
   * declaration (proxy vars + empty NO_PROXY) — no secrets, no extras.
   */
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

/** Container path of the Tier 0 analyzer entrypoint (baked into the pinned image). */
const TIER0_ANALYZER_CONTAINER_ENTRYPOINT = '/app/tier0-analyzer-cli.mjs' as const;
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
  // Stable machine code read by the service error mapper (never by static name).
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
// fallow-ignore-next-line unused-export -- default runner + containment tests
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
// fallow-ignore-next-line unused-export -- containment tests + future runner
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

/**
 * Translate the posture spec to `docker run` argv for one Tier 0 analysis.
 * Same deny-by-default flags as {@link containerSpecToDockerArgs}, plus
 * `-i` (captures arrive on stdin; observations leave on stdout) and the
 * analyzer entrypoint as the container command. No proxy variables, no
 * extra mounts, no network beyond `none`: Tier 0 analysis never renders,
 * so it carries no proxy affordance at all.
 */
// fallow-ignore-next-line unused-export -- container runner + tests
export function tier0AnalysisDockerArgs(spec: InvestigationContainerSpec): string[] {
  const base = containerSpecToDockerArgs(spec);
  // base = ['run', '--rm', ...flags, image]; insert '-i' after 'run' and
  // append the analyzer command after the image.
  const [run, ...rest] = base;
  return [run!, '-i', ...rest, 'node', TIER0_ANALYZER_CONTAINER_ENTRYPOINT];
}

// ─── Tier 1 render-container posture (proxy-only egress, #237) ───────────

/**
 * Build the investigation-only render-container spec for one run. Fresh
 * state per run: the caller supplies a unique runId used as the container
 * name suffix, plus the validating-forward-proxy URL that is the
 * container's sole egress.
 */
// fallow-ignore-next-line unused-export -- render runner + tests
export function buildRenderContainerSpec(
  runId: string,
  proxyUrl: string,
  overrides?: ContainerLimitOverrides,
): RenderContainerSpec {
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new IsolationError('runId required to scope fresh container state');
  }
  assertRenderProxyUrl(proxyUrl);
  return {
    image: RENDER_CONTAINER_IMAGE,
    networkMode: 'proxy-only',
    networkName: RENDER_CONTAINER_NETWORK,
    proxyUrl,
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
    env: renderProxyEnv(proxyUrl),
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
 * The exact proxy declaration: standard proxy vars plus the worker-stack
 * proxy knob (the Crawlee stack reads `BAYSTATE_CMS_WORKER_PROXY_URLS`,
 * not the standard vars) plus an empty NO_PROXY (nothing bypasses the
 * proxy). Credential-free by construction (asserted at build).
 */
function renderProxyEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    BAYSTATE_CMS_WORKER_PROXY_URLS: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  };
}

/** The proxy URL is the container's sole egress: http(s), credential-free, no query/fragment. */
function assertRenderProxyUrl(proxyUrl: string): void {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new IsolationError('render proxy URL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IsolationError('render proxy URL must be http(s)');
  }
  if (url.username || url.password) {
    throw new IsolationError('render proxy URL must not carry credentials');
  }
  if (url.search || url.hash) {
    throw new IsolationError('render proxy URL must carry no query or fragment');
  }
}

/**
 * Fail-closed posture assertion for the render container. Proxy-only
 * egress means: the isolated render network (never host/bridge/none
 * drift), the pinned render image, the exact proxy env (nothing else,
 * nothing secret), and the same sandbox/limits/teardown discipline as
 * Tier 0. Any deviation throws.
 */
// fallow-ignore-next-line unused-export -- render runner + tests
export function assertRenderContainerPosture(spec: RenderContainerSpec): void {
  assertRenderNetwork(spec);
  assertRenderProxyDeclaration(spec);
  assertRenderSandbox(spec);
}

/** Isolated render network, pinned render image, fresh per-run state, deterministic teardown. */
function assertRenderNetwork(spec: RenderContainerSpec): void {
  if (spec.networkMode !== 'proxy-only') {
    throw new IsolationError(`container posture violation: networkMode must be 'proxy-only', got '${spec.networkMode}'`);
  }
  if (spec.networkName !== RENDER_CONTAINER_NETWORK) {
    throw new IsolationError(
      `container posture violation: network must be the isolated render network ${RENDER_CONTAINER_NETWORK}`,
    );
  }
  if (spec.image !== RENDER_CONTAINER_IMAGE) {
    throw new IsolationError(`container posture violation: image must be the pinned render image ${RENDER_CONTAINER_IMAGE}`);
  }
  if (!spec.runId) throw new IsolationError('container posture violation: per-run fresh state requires a runId');
  if (spec.teardown !== 'always-remove') {
    throw new IsolationError('container posture violation: deterministic teardown (always-remove) required');
  }
}

/** The env is exactly the credential-free proxy declaration (nothing else, nothing secret). */
function assertRenderProxyDeclaration(spec: RenderContainerSpec): void {
  assertRenderProxyUrl(spec.proxyUrl);
  const expectedEnv = renderProxyEnv(spec.proxyUrl);
  const keys = Object.keys(spec.env).sort();
  const expectedKeys = Object.keys(expectedEnv).sort();
  if (keys.length !== expectedKeys.length || !keys.every((k, i) => k === expectedKeys[i])) {
    throw new IsolationError('container posture violation: render container env must be exactly the proxy declaration');
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (expectedEnv[key] !== value) {
      throw new IsolationError('container posture violation: render container proxy env mismatch');
    }
  }
  assertNoSecretEnv(spec.env);
}

/** Same sandbox/limits discipline as Tier 0: non-root, dropped caps, read-only root, bounded tmpfs, no mounts. */
function assertRenderSandbox(spec: RenderContainerSpec): void {
  assertRenderIdentity(spec);
  assertRenderFilesystem(spec);
  assertRenderLimits(spec);
  if (spec.browserArgs.includes('--no-sandbox')) {
    throw new IsolationError('container posture violation: browser sandbox must be retained (no --no-sandbox workarounds)');
  }
}

/** Non-root, dropped capabilities, no-new-privileges. */
function assertRenderIdentity(spec: RenderContainerSpec): void {
  if (spec.privileged) throw new IsolationError('container posture violation: privileged mode forbidden');
  if (!spec.capDrop.includes('ALL')) throw new IsolationError('container posture violation: all Linux capabilities must be dropped');
  if (spec.capAdd.length > 0) throw new IsolationError('container posture violation: no Linux capabilities may be added');
  if (!spec.securityOpt.includes('no-new-privileges')) {
    throw new IsolationError('container posture violation: no-new-privileges required');
  }
  if (!spec.user || spec.user === 'root' || spec.user === '0' || spec.user === '0:0') {
    throw new IsolationError('container posture violation: non-root user required');
  }
}

/** Read-only root, narrow bounded tmpfs, no host mounts. */
function assertRenderFilesystem(spec: RenderContainerSpec): void {
  if (!spec.readOnlyRootFilesystem) throw new IsolationError('container posture violation: read-only root filesystem required');
  assertTmpfsBounds(spec.tmpfs);
  assertNoHostMounts(spec.mounts);
}

/** Explicit non-unlimited CPU, memory, and process limits. */
function assertRenderLimits(spec: RenderContainerSpec): void {
  if (!(spec.cpus > 0) || spec.cpus > 16) throw new IsolationError('container posture violation: explicit CPU limit required (0 < cpus <= 16)');
  if (!/^\d+[mg]$/i.test(spec.memory)) throw new IsolationError('container posture violation: explicit memory limit required (e.g. 2g)');
  if (!(spec.pidsLimit > 0) || spec.pidsLimit > 4096) {
    throw new IsolationError('container posture violation: explicit process limit required');
  }
}

/**
 * Translate the render posture spec to `docker run` argv. The argv is the
 * auditable artifact: Tier 1 tests assert the proxy-only flags here AND
 * exercise them against a live daemon (direct egress denied at container
 * level, proxy channel open). `-i` carries the render task on stdin;
 * typed observations leave on stdout.
 */
// fallow-ignore-next-line unused-export -- render runner + tests
export function renderContainerDockerArgs(spec: RenderContainerSpec): string[] {
  assertRenderContainerPosture(spec);
  const args = [
    'run',
    '-i',
    '--rm',
    `--name=${containerNameForRun(spec.runId)}`,
    `--network=${spec.networkName}`,
    // The ONLY host route: the validating forward proxy via the
    // host-gateway alias (the proxy URL advertises host.docker.internal).
    // No other extra hosts, no host networking — direct egress stays denied.
    '--add-host=host.docker.internal:host-gateway',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--user=${spec.user}`,
    '--read-only',
  ];
  for (const [path, opts] of Object.entries(spec.tmpfs)) args.push(`--tmpfs=${path}:${opts}`);
  args.push(`--cpus=${spec.cpus}`, `--memory=${spec.memory}`, `--pids-limit=${spec.pidsLimit}`);
  for (const [key, value] of Object.entries(spec.env)) args.push(`--env=${key}=${value}`);
  // Bun runs the TypeScript worker directly (no build step); the image
  // pre-installs production deps + headless Chromium (see
  // docker/investigation-render/Dockerfile).
  args.push(spec.image, 'bun', RENDER_WORKER_CONTAINER_ENTRYPOINT);
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
// fallow-ignore-next-line unused-export -- harness + tests
export function tryAcquireInvestigationSlot(): boolean {
  if (slotHeld) return false;
  slotHeld = true;
  return true;
}

// fallow-ignore-next-line unused-export -- harness + tests
export function releaseInvestigationSlot(): void {
  slotHeld = false;
}

// fallow-ignore-next-line unused-export -- tests
export function isInvestigationSlotHeld(): boolean {
  return slotHeld;
}

/** Teardown-only seam: full runners extend it structurally. */
interface ContainerRunner {
  /** Remove the run container. Must be idempotent and never throw. */
  teardown(runId: string): Promise<void>;
}

/**
 * Run `fn` with guaranteed deterministic teardown: the run container is
 * removed on success, failure, timeout, AND cancellation. Teardown failures
 * are swallowed (idempotent best-effort) so they cannot mask the run outcome.
 */
// fallow-ignore-next-line unused-export -- harness + tests
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
