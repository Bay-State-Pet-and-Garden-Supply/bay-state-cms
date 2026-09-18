// Tier 1 render-container runner (#237): start / run / teardown around the render posture argv.
//
// The runner launches one real render container per run from the audited
// render posture spec (`renderContainerDockerArgs`: `--rm`, isolated render
// network, proxy-only env, stdin attached) and executes the render worker
// inside it. The worker reuses the existing rendered-page stack; its sole
// egress is the validating forward proxy whose URL the spec carries. The
// render task arrives on stdin; typed rendered observations return on
// stdout as a versioned envelope.
//
// Fail-closed throughout: a missing image, an unreachable runtime, or an
// unreachable render network reports `isolation_unavailable` (with the
// image-build hint) and never falls back to host-side rendering — the
// harness owns that decision (gap, not silent Tier 0), this runner only
// reports stable codes. Teardown (`docker rm -f` on the deterministic
// container name) is idempotent best-effort and never throws.
//
// Test seam: production constructs `DockerRenderContainerRunner` with no
// arguments (pinned image). Tests inject a double explicitly; the
// deterministic suites stay daemon-free and the double is labeled at the
// call site.
//
// Network-surface note for the containment audit: this module only spawns
// the container runtime CLI (no sockets of its own) — same standing as
// `container-runner.ts`.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';
import {
  assertRenderContainerPosture,
  containerNameForRun,
  renderContainerDockerArgs,
  type RenderContainerSpec,
} from './isolation';

const execFileAsync = promisify(execFile);

/** One page the render worker should load through the validating proxy. */
interface Tier1RenderPage {
  pageIndex: number;
  url: string;
  /** Host-retained broker-capture artifact ref for the same URL (evidence anchor). */
  artifactRef: string;
}

interface Tier1RenderRequest {
  investigationId: string;
  /** Exact-match approved hosts baked into the in-container guard (broker scope mirror). */
  approvedHosts: string[];
  pages: Tier1RenderPage[];
  maxReads: number;
  maxObservationBytesPerOperation: number;
}

export interface Tier1RenderedObservation {
  kind: string;
  sourceUrl: string;
  /** SHA-256 of the rendered snapshot bytes seen in-container (full hash only). */
  artifactHash: string;
  detail?: string;
  incomplete: boolean;
  /** Host artifact ref anchoring this observation to retained evidence. */
  artifactRef: string;
  pageIndex: number;
}

interface Tier1RenderResult {
  observations: Tier1RenderedObservation[];
  gaps: string[];
  readsPerformed: number;
}

export function tier1RenderRequestOf(
  investigationId: string,
  approvedHosts: string[],
  pages: Tier1RenderPage[],
  budget: InvestigationBudget,
): Tier1RenderRequest {
  return {
    investigationId,
    approvedHosts: [...approvedHosts].sort(),
    pages: pages.map((p) => ({ ...p })),
    maxReads: budget.maxReads,
    maxObservationBytesPerOperation: budget.maxObservationBytesPerOperation,
  };
}

type RenderRunnerCode =
  | 'isolation_unavailable'
  | 'timeout'
  | 'provider_error'
  | 'budget_exhausted';

export class RenderRunnerError extends Error {
  readonly code: RenderRunnerCode;
  constructor(code: RenderRunnerCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RenderRunnerError';
    this.code = code;
  }
}

/** Start / run / teardown for one Tier 1 render container. */
export interface Tier1RenderRunner {
  /** Verify posture + image availability. Throws isolation_unavailable when missing. */
  start(spec: RenderContainerSpec): Promise<void>;
  /**
   * Execute the render worker in a fresh container. Kill paths (timeout,
   * envelope overflow) remove the container before reporting; every other
   * exit stays the caller's duty via `teardown` (the harness isolated run).
   */
  runRender(
    spec: RenderContainerSpec,
    request: Tier1RenderRequest,
    opts?: { timeoutMs?: number },
  ): Promise<Tier1RenderResult>;
  /** Remove the run container. Idempotent best-effort; never throws. */
  teardown(runId: string): Promise<void>;
}

const DEFAULT_RENDER_TIMEOUT_MS = 120_000;
/** Stdout ceiling for the typed-observation envelope (observations are byte-capped upstream). */
const MAX_RENDER_ENVELOPE_BYTES = 16 * 1024 * 1024;

// fallow-ignore-next-line unused-export — harness + tests
export class DockerRenderContainerRunner implements Tier1RenderRunner {
  async start(spec: RenderContainerSpec): Promise<void> {
    assertRenderContainerPosture(spec);
    try {
      await execFileAsync('docker', ['image', 'inspect', spec.image], { timeout: 15_000 });
    } catch {
      throw new RenderRunnerError(
        'isolation_unavailable',
        'isolation_unavailable: render image unavailable ' +
          '(build with: docker build -t baystate/investigation-render:1 ' +
          '-f docker/investigation-render/Dockerfile .)',
      );
    }
  }

  async runRender(
    spec: RenderContainerSpec,
    request: Tier1RenderRequest,
    opts?: { timeoutMs?: number },
  ): Promise<Tier1RenderResult> {
    assertRenderContainerPosture(spec);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    const payload = JSON.stringify({
      investigationId: request.investigationId,
      approvedHosts: request.approvedHosts,
      pages: request.pages,
      maxReads: request.maxReads,
      maxObservationBytesPerOperation: request.maxObservationBytesPerOperation,
    });
    return new Promise<Tier1RenderResult>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const child = spawn('docker', renderContainerDockerArgs(spec), { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutOverflow = false;
      let stderrTail = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Kill is best-effort; the close handler reports the timeout.
        }
      }, Math.max(1, timeoutMs));
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        fail(
          new RenderRunnerError(
            'isolation_unavailable',
            `isolation_unavailable: container runtime unreachable (${String((err as { code?: string }).code ?? 'spawn_failed')})`,
          ),
        );
      });
      child.stdout.on('data', (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buf.length;
        if (stdoutBytes > MAX_RENDER_ENVELOPE_BYTES) {
          stdoutOverflow = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Best-effort; close handler reports the failure.
          }
          return;
        }
        stdout.push(buf);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-500);
      });
      child.on('close', (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (signal === 'SIGKILL') {
          void removeRenderContainer(spec.runId).then(() => {
            if (stdoutOverflow) {
              reject(
                new RenderRunnerError('provider_error', 'provider_error: render envelope exceeded its ceiling'),
              );
              return;
            }
            reject(new RenderRunnerError('timeout', 'timeout: Tier 1 render container exceeded its time budget'));
          });
          return;
        }
        if (code !== 0) {
          reject(
            new RenderRunnerError(
              'provider_error',
              `provider_error: render worker exited ${code ?? 'unknown'} (${stderrTail.trim().slice(0, 200) || 'no detail'})`,
            ),
          );
          return;
        }
        try {
          resolve(parseRenderEnvelope(Buffer.concat(stdout).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
      try {
        child.stdin.write(payload);
        child.stdin.end();
      } catch (err) {
        clearTimeout(timer);
        fail(
          new RenderRunnerError(
            'provider_error',
            `provider_error: failed to hand the render task to the container (${failureCodeOf(err)})`,
          ),
        );
      }
    });
  }

  async teardown(runId: string): Promise<void> {
    await removeRenderContainer(runId);
  }
}

/** Idempotent best-effort removal. Missing names are fine; never throws. */
async function removeRenderContainer(runId: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', '-f', containerNameForRun(runId)], { timeout: 15_000 });
  } catch {
    // Never throws: teardown cannot mask the run outcome.
  }
}

function failureCodeOf(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && code ? code : 'write_failed';
}

interface RenderEnvelope {
  ok?: unknown;
  version?: unknown;
  result?: unknown;
  code?: unknown;
  detail?: unknown;
}

/** Decode the container stdout as an envelope object (fail closed on any deviation). */
function readRenderEnvelope(text: string): RenderEnvelope {
  try {
    const envelope: unknown = JSON.parse(text.trim());
    if (envelope && typeof envelope === 'object') return envelope as RenderEnvelope;
  } catch {
    // Fall through to the malformed-envelope failure below.
  }
  throw new RenderRunnerError('provider_error', 'provider_error: render container returned a malformed envelope');
}

/** Map a refused (`ok: false`) envelope to its stable runner error. */
function refusedRenderEnvelopeError(env: RenderEnvelope): RenderRunnerError {
  const code = env.code === 'budget_exhausted' ? 'budget_exhausted' : 'provider_error';
  const detail = typeof env.detail === 'string' && env.detail ? env.detail.slice(0, 200) : 'render refused';
  return new RenderRunnerError(code, `${code}: ${detail}`);
}

function isRenderedObservation(value: unknown): value is Tier1RenderedObservation {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.kind === 'string' &&
    typeof o.sourceUrl === 'string' &&
    typeof o.artifactHash === 'string' &&
    typeof o.artifactRef === 'string' &&
    typeof o.incomplete === 'boolean' &&
    typeof o.pageIndex === 'number'
  );
}

/** Narrow an accepted envelope payload to the typed result (fail closed). */
function coerceRenderResult(raw: unknown): Tier1RenderResult {
  const result = raw as Tier1RenderResult | null;
  const wellFormed =
    !!result &&
    typeof result === 'object' &&
    Array.isArray(result.observations) &&
    result.observations.every(isRenderedObservation) &&
    Array.isArray(result.gaps) &&
    typeof result.readsPerformed === 'number';
  if (!wellFormed) {
    throw new RenderRunnerError('provider_error', 'provider_error: render container returned a malformed result');
  }
  return result as Tier1RenderResult;
}

/** Parse + minimally validate the container envelope (fail closed on any deviation). */
function parseRenderEnvelope(text: string): Tier1RenderResult {
  const env = readRenderEnvelope(text);
  if (env.version !== 1) {
    throw new RenderRunnerError('provider_error', 'provider_error: render container returned an unsupported envelope version');
  }
  if (env.ok !== true) throw refusedRenderEnvelopeError(env);
  return coerceRenderResult(env.result);
}
