// Tier 0 container runner (#236): start / run / teardown around the posture argv.
//
// The runner launches one real container per analysis from the audited
// posture spec (`tier0AnalysisDockerArgs`: `--rm`, `--network=none`,
// stdin attached) and executes the Tier 0 analyzer inside it. Page bytes
// arrive only as broker-approved captures piped on stdin; typed
// observations return on stdout as a versioned envelope.
//
// Fail-closed throughout: a missing image or unreachable runtime reports
// `isolation_unavailable` (with the image-build hint) and never falls back
// to host-side analysis — the harness owns that decision, this runner only
// reports stable codes. Teardown (`docker rm -f` on the deterministic
// container name) is idempotent best-effort and never throws, so it cannot
// mask the run outcome on success, failure, timeout, or cancellation.
//
// Test seam: production constructs `DockerTier0ContainerRunner` with no
// arguments (pinned image). Tests may pass `imageOverride` to point at a
// prebuilt equivalent (built from docker/investigation-browser/Dockerfile);
// the posture is still asserted on the pinned spec first, and the override
// only swaps the final image token. The in-process analyzer double used by
// deterministic suites lives in the test file, explicitly labeled.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';
import {
  assertContainerPosture,
  containerNameForRun,
  tier0AnalysisDockerArgs,
  type InvestigationContainerSpec,
} from './isolation';

const execFileAsync = promisify(execFile);

/** Budget caps the analyzer enforces (subset of the run budget, by value). */
interface Tier0AnalysisBudgetCaps {
  maxSelectorLength: number;
  maxSelectorMatches: number;
  maxObservationBytesPerOperation: number;
  maxJsonNodesVisited: number;
  maxJsonPointerDepth: number;
  maxResponseBytesPerResponse: number;
  maxReads: number;
}

export function tier0BudgetCapsOf(budget: InvestigationBudget): Tier0AnalysisBudgetCaps {
  return {
    maxSelectorLength: budget.maxSelectorLength,
    maxSelectorMatches: budget.maxSelectorMatches,
    maxObservationBytesPerOperation: budget.maxObservationBytesPerOperation,
    maxJsonNodesVisited: budget.maxJsonNodesVisited,
    maxJsonPointerDepth: budget.maxJsonPointerDepth,
    maxResponseBytesPerResponse: budget.maxResponseBytesPerResponse,
    maxReads: budget.maxReads,
  };
}

/** One broker-approved capture handed to the container (opaque bytes, never re-fetched). */
export interface Tier0AnalysisCapture {
  pageIndex: number;
  /** Raw capture bytes, base64. Produced by the host broker only. */
  bodyBase64: string;
  contentType: string;
  pageUrl: string;
  artifactHash: string;
  artifactRef: string;
  responseRef: string;
}

export interface Tier0AnalysisRequest {
  investigationId: string;
  budget: Tier0AnalysisBudgetCaps;
  captures: Tier0AnalysisCapture[];
}

export interface Tier0AnalysisObservation {
  kind: string;
  sourceUrl: string;
  artifactHash: string;
  detail?: string;
  incomplete: boolean;
  artifactRef: string;
}

/** Provenance for one identifier field from Tier 0 static identity (#233). */
interface Tier0IdentityField {
  field: string;
  sources: string[];
  evidenceRef: string;
}

/**
 * Tier 0 static identity (#233): product/variant identity and option-axis
 * requirements derived deterministically in-container from the same
 * broker-approved captures. Requirement strings use the variant-resolver
 * vocabulary for the unchanged compiler gate; `conflicts` defers ambiguous
 * identifiers downstream instead of resolving them.
 */
interface Tier0IdentityResult {
  productIdentity: string[];
  variantIdentity: string[];
  optionAxes: string[];
  fields: Tier0IdentityField[];
  conflicts: string[];
  contributingArtifacts: string[];
}

export interface Tier0AnalysisResult {
  observations: Tier0AnalysisObservation[];
  gaps: string[];
  platformSignals: string[];
  domSignals: { title: boolean; meta: boolean; jsonLd: boolean; images: boolean };
  readsPerformed: number;
  identity: Tier0IdentityResult;
}

type ContainerRunnerCode =
  | 'isolation_unavailable'
  | 'timeout'
  | 'provider_error'
  | 'cancelled'
  | 'budget_exhausted';

export class ContainerRunnerError extends Error {
  readonly code: ContainerRunnerCode;
  constructor(code: ContainerRunnerCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ContainerRunnerError';
    this.code = code;
  }
}

/** Start / run / teardown for one Tier 0 analysis container. */
export interface Tier0ContainerRunner {
  /** Verify posture + image availability. Throws isolation_unavailable when missing. */
  start(spec: InvestigationContainerSpec): Promise<void>;
  /**
   * Execute the analyzer in a fresh container. Kill paths (timeout,
   * envelope overflow) remove the container before reporting; every other
   * exit stays the caller's duty via `teardown` (the harness isolated run).
   * Operator cancellation propagates as rejection through the caller, whose
   * finally still tears down. Pass `#244` AbortSignal via opts: abort
   * terminates the child process, removes the container, and surfaces the
   * stable `cancelled` code.
   */
  runAnalysis(
    spec: InvestigationContainerSpec,
    request: Tier0AnalysisRequest,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Tier0AnalysisResult>;
  /** Remove the run container. Idempotent best-effort; never throws. */
  teardown(runId: string): Promise<void>;
}

const DEFAULT_RUN_TIMEOUT_MS = 60_000;
/** Stdout ceiling for the typed-observation envelope (observations are byte-capped upstream). */
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

interface DockerTier0RunnerOptions {
  /** Test-only prebuilt image (same /app entrypoints). Production never sets this. */
  imageOverride?: string;
}

// harness + tests
export class DockerTier0ContainerRunner implements Tier0ContainerRunner {
  constructor(private readonly opts: DockerTier0RunnerOptions = {}) {}

  private imageFor(spec: InvestigationContainerSpec): string {
    return this.opts.imageOverride ?? spec.image;
  }

  /** Posture argv with the (possibly test-overridden) image token. */
  private dockerArgs(spec: InvestigationContainerSpec): string[] {
    const argv = tier0AnalysisDockerArgs(spec);
    const image = this.imageFor(spec);
    if (image !== spec.image) {
      // Test-only token swap, applied after the posture assertion on the
      // pinned spec: the flags stay identical, only the image token changes.
      argv[argv.length - 3] = image;
    }
    return argv;
  }

  async start(spec: InvestigationContainerSpec): Promise<void> {
    assertContainerPosture(spec);
    try {
      await execFileAsync('docker', ['image', 'inspect', this.imageFor(spec)], { timeout: 15_000 });
    } catch {
      throw new ContainerRunnerError(
        'isolation_unavailable',
        'isolation_unavailable: investigation image unavailable ' +
          '(build with: docker build -t baystate/investigation-browser:1 ' +
          '-f docker/investigation-browser/Dockerfile .)',
      );
    }
  }

  async runAnalysis(
    spec: InvestigationContainerSpec,
    request: Tier0AnalysisRequest,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Tier0AnalysisResult> {
    assertContainerPosture(spec);
    if (opts?.signal?.aborted) {
      throw new ContainerRunnerError('cancelled', 'cancelled: Tier 0 container analysis aborted before start');
    }
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const payload = JSON.stringify({
      investigationId: request.investigationId,
      budget: request.budget,
      captures: request.captures,
    });
    return new Promise<Tier0AnalysisResult>((resolve, reject) => {
      let settled = false;
      const abortSignal = opts?.signal;
      let aborted = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        reject(err);
      };
      const onAbort = (): void => {
        aborted = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Kill is best-effort; the close handler reports the cancellation.
        }
      };
      const child = spawn('docker', this.dockerArgs(spec), { stdio: ['pipe', 'pipe', 'pipe'] });
      if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
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
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        fail(
          new ContainerRunnerError(
            'isolation_unavailable',
            `isolation_unavailable: container runtime unreachable (${String(err && (err as { code?: string }).code ? (err as { code?: string }).code : 'spawn_failed')})`,
          ),
        );
      });
      child.stdout.on('data', (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buf.length;
        if (stdoutBytes > MAX_ENVELOPE_BYTES) {
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
      child.on('close', (code: number | null, exitSignal: string | null) => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        if (exitSignal === 'SIGKILL') {
          // Killing the client does not reliably reap the container, so
          // remove it here before reporting: every exit path tears down.
          // (The harness-level isolated-run finally remains the backstop.)
          void removeContainer(spec.runId).then(() => {
              if (aborted || opts?.signal?.aborted) {
                reject(
                  new ContainerRunnerError('cancelled', 'cancelled: Tier 0 container analysis aborted by operator'),
                );
                return;
              }
              if (stdoutOverflow) {
                reject(
                  new ContainerRunnerError('provider_error', 'provider_error: analysis envelope exceeded its ceiling'),
                );
                return;
              }
              reject(new ContainerRunnerError('timeout', 'timeout: Tier 0 container analysis exceeded its time budget'));
            });
          return;
        }
        if (code !== 0) {
          reject(
            new ContainerRunnerError(
              'provider_error',
              `provider_error: container analysis exited ${code ?? 'unknown'} (${stderrTail.trim().slice(0, 200) || 'no detail'})`,
            ),
          );
          return;
        }
        try {
          resolve(parseAnalysisEnvelope(Buffer.concat(stdout).toString('utf8')));
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
          new ContainerRunnerError(
            'provider_error',
            `provider_error: failed to hand captures to the container (${failureCodeOf(err)})`,
          ),
        );
      }
    });
  }

  async teardown(runId: string): Promise<void> {
    await removeContainer(runId);
  }
}

/** Idempotent best-effort removal. Missing names are fine; never throws. */
async function removeContainer(runId: string): Promise<void> {
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

interface AnalysisEnvelope {
  ok?: unknown;
  version?: unknown;
  result?: unknown;
  code?: unknown;
  detail?: unknown;
}

/** Decode the container stdout as an envelope object (fail closed on any deviation). */
function readEnvelope(text: string): AnalysisEnvelope {
  try {
    const envelope: unknown = JSON.parse(text.trim());
    if (envelope && typeof envelope === 'object') return envelope as AnalysisEnvelope;
  } catch {
    // Fall through to the malformed-envelope failure below.
  }
  throw new ContainerRunnerError('provider_error', 'provider_error: container returned a malformed envelope');
}

/** Map a refused (`ok: false`) envelope to its stable runner error. */
function refusedEnvelopeError(env: AnalysisEnvelope): ContainerRunnerError {
  const code = env.code === 'budget_exhausted' ? 'budget_exhausted' : 'provider_error';
  const detail = typeof env.detail === 'string' && env.detail ? env.detail.slice(0, 200) : 'analysis refused';
  return new ContainerRunnerError(code, `${code}: ${detail}`);
}

/** Narrow an accepted envelope payload to the typed result (fail closed). */
/** Shape check for the Tier 0 identity block (fail closed on deviation). */
function isTier0IdentityResult(value: unknown): value is Tier0IdentityResult {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  if (
    !Array.isArray(identity.productIdentity) ||
    !Array.isArray(identity.variantIdentity) ||
    !Array.isArray(identity.optionAxes) ||
    !Array.isArray(identity.conflicts) ||
    !Array.isArray(identity.contributingArtifacts) ||
    !Array.isArray(identity.fields)
  ) {
    return false;
  }
  return (identity.fields as unknown[]).every(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as { field?: unknown }).field === 'string' &&
      Array.isArray((entry as { sources?: unknown }).sources) &&
      typeof (entry as { evidenceRef?: unknown }).evidenceRef === 'string',
  );
}

/** Array-of-anything check (observation/gap/signal lists). */
function isArrayField(value: unknown): boolean {
  return Array.isArray(value);
}

/** Object-shaped check (domSignals carrier). */
function isObjectField(value: unknown): boolean {
  return !!value && typeof value === 'object';
}

/** Envelope-result field shape table: every field the runner consumes. */
const ENVELOPE_RESULT_SHAPES: ReadonlyArray<readonly [keyof Tier0AnalysisResult, (value: unknown) => boolean]> = [
  ['observations', isArrayField],
  ['gaps', isArrayField],
  ['platformSignals', isArrayField],
  ['domSignals', isObjectField],
  ['readsPerformed', (value) => typeof value === 'number'],
  ['identity', (value) => isTier0IdentityResult(value)],
];

function coerceEnvelopeResult(raw: unknown): Tier0AnalysisResult {
  const result = raw as Tier0AnalysisResult | null;
  const malformed = !result || typeof result !== 'object'
    ? ['observations'] // non-object payload: report the first required shape
    : ENVELOPE_RESULT_SHAPES.filter(([key, check]) => !check(result[key])).map(([key]) => key);
  if (malformed.length > 0) {
    throw new ContainerRunnerError('provider_error', 'provider_error: container returned a malformed result');
  }
  return result as Tier0AnalysisResult;
}

/** Parse + minimally validate the container envelope (fail closed on any deviation). */
function parseAnalysisEnvelope(text: string): Tier0AnalysisResult {
  const env = readEnvelope(text);
  if (env.version !== 1) {
    throw new ContainerRunnerError('provider_error', 'provider_error: container returned an unsupported envelope version');
  }
  if (env.ok !== true) throw refusedEnvelopeError(env);
  return coerceEnvelopeResult(env.result);
}
