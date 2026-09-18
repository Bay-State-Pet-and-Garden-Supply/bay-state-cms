// Browser Investigation opt-in live smoke (T6).
//
// A live investigation against a real public page is NEVER part of
// deterministic CI. It runs only when ALL of these hold:
//
// - `BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE` is exactly "1" (explicit opt-in);
// - `CI` is unset (refuse in CI even when the opt-in flag is present);
// - investigation isolation is available (explicit
//   `BAYSTATE_INVESTIGATION_ISOLATION=ready` plus a reachable isolated
//   runtime — checked through an injected probe so unit tests never touch Docker);
// - the operator supplies an explicit domain plus 1–5 public http(s) sample URLs.
//
// The smoke report records ONLY what was actually performed: isolation
// verification, the bounded investigation steps the harness executed, and
// explicit `activationPerformed: false` / `releasePerformed: false` /
// `attestationPerformed: false`. No approvals, activations, releases, or
// image attestations are ever inferred — a draft delivery proves draft
// delivery, nothing more.
//
// Pure except for injected dependencies (no DB, no network, no provider
// imports): Vitest-safe. The production CLI (`scripts/
// browser-investigation-live-smoke.ts`) injects the real isolation probe;
// tests inject fakes.

export const LIVE_SMOKE_ENV_FLAG = 'BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE' as const;
const LIVE_SMOKE_SCHEMA_VERSION = 1 as const;

export interface LiveSmokeGateOptions {
  domain: string | null;
  sampleUrls: string[];
  /** Explicit model/config reference (never a secret value): e.g. `local:qwen2.5vl:latest`. */
  modelRef?: string | null;
}

export type LiveSmokeGate =
  | { ok: true; domain: string; sampleUrls: string[] }
  | { ok: false; reason: string };

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const NON_PUBLIC_HOSTS = ['localhost'];
const NON_PUBLIC_SUFFIXES = ['.local', '.localhost'];
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isNonPublicHost(host: string): boolean {
  if (!host || NON_PUBLIC_HOSTS.includes(host)) return true;
  if (NON_PUBLIC_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // Live smoke never targets literal IPs: hostnames only. Stricter than
  // the investigation service (which allowlists public IPs) and branch-free.
  return IPV4_RE.test(host);
}

function isPublicHttpUrl(raw: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url || url.username || url.password) return false;
  return !isNonPublicHost(url.hostname.toLowerCase().replace(/\.$/, ''));
}

function canonicalDomain(raw: string | null): string {
  return (raw ?? '').toLowerCase().replace(/^www\./, '').trim();
}

function sampleInDomain(raw: string, domain: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // Dot-boundary match only: exact host or a true subdomain.
  // Substring matching would admit evil-shop.example.com for
  // shop.example.com, weakening the isolation scope.
  return host === domain || host.endsWith(`.${domain}`);
}

function checkModelRef(options: LiveSmokeGateOptions, env: Record<string, string | undefined>): LiveSmokeGate {
  const modelRef = (options.modelRef ?? env.BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE_MODEL ?? '').trim();
  if (!modelRef) {
    return { ok: false, reason: 'refused: explicit model credentials/config required (supply --model or BAYSTATE_CMS_BROWSER_INVESTIGATION_LIVE_SMOKE_MODEL)' };
  }
  if (/key|token|secret|password/i.test(modelRef)) {
    return { ok: false, reason: 'refused: model ref must name configuration, never carry secret material' };
  }
  return { ok: true, domain: '', sampleUrls: [] };
}

function checkSampleUrls(domain: string, sampleUrls: string[]): LiveSmokeGate {
  if (!Array.isArray(sampleUrls) || sampleUrls.length === 0 || sampleUrls.length > 5) {
    return { ok: false, reason: 'refused: supply 1–5 explicit sample URLs' };
  }
  for (const url of sampleUrls) {
    if (!isPublicHttpUrl(url)) return { ok: false, reason: `refused: sample URL is not a public http(s) URL: ${url.slice(0, 120)}` };
    if (!sampleInDomain(url, domain)) return { ok: false, reason: `refused: sample URL ${url.slice(0, 120)} is outside domain ${domain}` };
  }
  return { ok: true, domain, sampleUrls: [...sampleUrls] };
}

/**
 * Fail-closed gate for the opt-in live smoke. Refuses when the explicit
 * opt-in flag is absent, when running under CI, when isolation is
 * unavailable, when model credentials/config are not explicitly supplied,
 * or when the operator has not supplied an explicit public domain +
 * sample URLs. Never throws.
 */
export function evaluateLiveSmokeGates(
  env: Record<string, string | undefined>,
  isolation: { available: boolean; reason: string },
  options: LiveSmokeGateOptions,
): LiveSmokeGate {
  if (env[LIVE_SMOKE_ENV_FLAG] !== '1') {
    return { ok: false, reason: `refused: set ${LIVE_SMOKE_ENV_FLAG}=1 explicitly to run the live smoke` };
  }
  if (env.CI === '1' || env.CI === 'true') {
    return { ok: false, reason: 'refused: live smoke never runs under CI' };
  }
  if (!isolation.available) {
    return { ok: false, reason: `refused: isolation unavailable (${isolation.reason})` };
  }
  const modelGate = checkModelRef(options, env);
  if (!modelGate.ok) return modelGate;
  const domain = canonicalDomain(options.domain);
  if (!domain) return { ok: false, reason: 'refused: an explicit domain is required' };
  return checkSampleUrls(domain, options.sampleUrls);
}

export interface LiveSmokeReport {
  schemaVersion: number;
  domain: string;
  sampleUrls: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  isolation: { verified: boolean; detail: string };
  stepsPerformed: string[];
  activationPerformed: false;
  releasePerformed: false;
  attestationPerformed: false;
  passed: boolean;
  failureCode: string | null;
  notes: string[];
}

export interface LiveSmokeDeps {
  env: Record<string, string | undefined>;
  checkIsolation: () => Promise<{ available: boolean; reason: string }>;
  /** Bounded live investigation performed by the caller-owned harness. Must not activate/release/attest. */
  performLiveInvestigation: (input: { domain: string; sampleUrls: string[] }) => Promise<{ steps: string[]; notes?: string[] }>;
  now?: () => string;
}

export interface LiveSmokeOutcome {
  exitCode: 0 | 1 | 2;
  report: LiveSmokeReport | null;
  reason?: string;
}

function elapsedMs(startedAt: string, endedAt: string): number {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : 0;
}

function baseSmokeReport(args: {
  domain: string;
  sampleUrls: string[];
  startedAt: string;
  endedAt: string;
  isolationDetail: string;
}): Omit<LiveSmokeReport, 'stepsPerformed' | 'passed' | 'failureCode' | 'notes'> {
  return {
    schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
    domain: args.domain,
    sampleUrls: args.sampleUrls,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationMs: elapsedMs(args.startedAt, args.endedAt),
    isolation: { verified: true, detail: args.isolationDetail.slice(0, 300) },
    activationPerformed: false,
    releasePerformed: false,
    attestationPerformed: false,
  };
}

/**
 * Run the opt-in live smoke through injected dependencies. Gate refusals
 * (exit 2) never touch the harness. A completed smoke (exit 0/1) records
 * only performed steps plus explicit non-performance of activation,
 * release, and attestation.
 */
export async function runLiveSmoke(deps: LiveSmokeDeps & LiveSmokeGateOptions): Promise<LiveSmokeOutcome> {
  const startedAt = (deps.now ?? (() => new Date().toISOString()))();
  const isolation = await deps.checkIsolation().catch(() => ({ available: false, reason: 'isolation probe threw' }));
  const gate = evaluateLiveSmokeGates(deps.env, isolation, { domain: deps.domain, sampleUrls: deps.sampleUrls, modelRef: deps.modelRef ?? null });
  if (!gate.ok) return { exitCode: 2, report: null, reason: gate.reason };
  try {
    const performed = await deps.performLiveInvestigation({ domain: gate.domain, sampleUrls: gate.sampleUrls });
    const endedAt = (deps.now ?? (() => new Date().toISOString()))();
    return {
      exitCode: 0,
      report: {
        ...baseSmokeReport({ domain: gate.domain, sampleUrls: gate.sampleUrls, startedAt, endedAt, isolationDetail: isolation.reason }),
        stepsPerformed: performed.steps.slice(0, 20).map((s) => s.slice(0, 300)),
        passed: true,
        failureCode: null,
        notes: (performed.notes ?? []).slice(0, 10).map((n) => n.slice(0, 300)),
      },
    };
  } catch (err) {
    const endedAt = (deps.now ?? (() => new Date().toISOString()))();
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      report: {
        ...baseSmokeReport({ domain: gate.domain, sampleUrls: gate.sampleUrls, startedAt, endedAt, isolationDetail: isolation.reason }),
        stepsPerformed: ['isolation_verified'],
        passed: false,
        failureCode: message.slice(0, 120) || 'live_smoke_failed',
        notes: [],
      },
    };
  }
}
