// Browser Investigation real thin-slice pilot (#239).
//
// Opt-in end-to-end proof on a REAL Shopify domain through the REAL stack:
// explicit request → containerized local-harness investigation → deterministic
// compilation → production-worker representative + truly blind holdout
// validation → governed inactive draft. The evidence record distinguishes
// performed steps from non-claims (activation/release/attestation are always
// explicit false — a draft delivery proves draft delivery, nothing more).
//
// NEVER part of deterministic CI. Runs only when ALL hold:
// - `BAYSTATE_CMS_BROWSER_INVESTIGATION_PILOT` is exactly "1" (explicit opt-in);
// - `CI` is unset (refuses in CI even with the flag);
// - investigation isolation is available (explicit
//   `BAYSTATE_INVESTIGATION_ISOLATION=ready` plus a reachable isolated
//   runtime — checked through an injected probe so unit tests never touch Docker);
// - the operator supplies an explicit domain plus 1–5 public http(s)
//   representative URLs and 1–5 public http(s) blind-holdout URLs (all
//   in-domain, holdouts distinct from representatives), plus trusted expected
//   identities for every validation sample.
//
// Blindness: holdout URLs never enter the investigation input (sampleUrls,
// knownContext, model policy). Validation enforces the rest (artifacts,
// failure context, reports, metadata) via the existing holdout gate — an
// exposed holdout fails the pilot closed, honestly.
//
// Pure except for injected dependencies (no DB, no network, no provider
// imports): Vitest-safe. The production CLI
// (`scripts/browser-investigation-pilot.ts`) injects the real isolation probe,
// the real service call (local harness default), the production worker runner
// (runProfileExtraction), and memory stores with a capturing version creator
// (no production DB writes, no activation path). Tests inject fakes. The
// Vitest suite for this module is a contract test of gates/orchestration —
// NOT the acceptance proof. The acceptance proof is one recorded opt-in run
// (docs/plans/browser-investigation-pilot.md).

import {
  applyProposalToDraft,
  compileProposalForInvestigation,
  createMemoryProposalStore,
  type ProposalStore,
} from './apply';
import {
  createMemoryValidationStore,
  validateProposal,
  type PolicyWorkerRunner,
  type ProposalValidation,
  type ValidationExpectedIdentity,
  type ValidationSampleInput,
  type ValidationStore,
} from './validate';
import { normalizeHoldoutUrl } from './holdouts';
import { describeInvestigationWorkspace } from './workspace';
import { describeInvestigationTelemetry } from './telemetry';
import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';
import type { InvestigationStore } from './service';

export const PILOT_ENV_FLAG = 'BAYSTATE_CMS_BROWSER_INVESTIGATION_PILOT' as const;
const PILOT_SCHEMA_VERSION = 1 as const;
const MAX_SAMPLE_URLS = 5;

// ─── Gate ──────────────────────────────────────────────────────────────────

interface PilotGateOptions {
  domain: string | null;
  representativeUrls: string[];
  holdoutUrls: string[];
  /** Trusted expected identity per validation URL (representatives + holdouts). */
  expectedByUrl: Record<string, ValidationExpectedIdentity | undefined>;
  workspaceId?: string | null;
  actor?: string | null;
}

interface PilotGatedInput {
  domain: string;
  representativeUrls: string[];
  holdoutUrls: string[];
  workspaceId: string;
  actor: string;
}

type PilotGate = ({ ok: true } & PilotGatedInput) | { ok: false; reason: string };

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

/**
 * Canonical sample identity for comparison and expected-identity keys. The
 * repo's holdout canonicalisation (trailing slashes stripped, trimmed) is the
 * single definition, so a slash variant can neither bypass nor false-trigger
 * the "holdout must be distinct from every representative" gate.
 */
function canonicalUrl(raw: string): string {
  return normalizeHoldoutUrl(raw);
}

function sampleInDomain(raw: string, domain: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // Dot-boundary match only (never a substring match): a lookalike domain is
  // outside the investigation scope.
  return host === domain || host.endsWith(`.${domain}`);
}

function workspaceFor(domain: string, requested: string | null | undefined): string {
  const explicit = (requested ?? '').trim();
  if (explicit) return explicit;
  const slug = domain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'domain';
  return `ws-pilot-${slug}`;
}

/** Opt-in, CI refusal, and isolation availability (all fail closed). */
function checkRunGates(
  env: Record<string, string | undefined>,
  isolation: { available: boolean; reason: string },
): string | null {
  if (env[PILOT_ENV_FLAG] !== '1') {
    return `refused: set ${PILOT_ENV_FLAG}=1 explicitly to run the pilot`;
  }
  if (env.CI === '1' || env.CI === 'true') return 'refused: pilot never runs under CI';
  if (!isolation.available) return `refused: isolation unavailable (${isolation.reason})`;
  return null;
}

/** Explicit domain plus in-domain, public, duplicate-free sample URL lists. */
function checkSampleSet(urls: string[], domain: string, role: string): string | null {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_SAMPLE_URLS) {
    return `refused: supply 1–${MAX_SAMPLE_URLS} explicit ${role} URLs`;
  }
  const seen = new Set<string>();
  for (const url of urls) {
    const trimmed = canonicalUrl(url);
    if (!trimmed || seen.has(trimmed)) return `refused: duplicate ${role} URL: ${trimmed.slice(0, 120)}`;
    seen.add(trimmed);
    if (!isPublicHttpUrl(trimmed)) return `refused: ${role} URL is not a public http(s) URL: ${trimmed.slice(0, 120)}`;
    if (!sampleInDomain(trimmed, domain)) {
      return `refused: ${role} URL ${trimmed.slice(0, 120)} is outside domain ${domain}`;
    }
  }
  return null;
}

function firstDuplicateHoldout(representativeUrls: string[], holdoutUrls: string[]): string | null {
  const representatives = new Set(representativeUrls);
  return holdoutUrls.find((url) => representatives.has(url)) ?? null;
}

/** Trusted identifier that can prove variant identity (a name alone cannot). */
function hasTrustedIdentifier(expected: ValidationExpectedIdentity): boolean {
  return (
    !!expected.gtin?.trim() ||
    !!expected.sku?.trim() ||
    !!expected.platformVariantId?.trim() ||
    !!expected.variantKey?.trim()
  );
}

/** One sample's trusted-expectation problems (name, identifier, product anchor). */
function expectedProblemsFor(url: string, expected: ValidationExpectedIdentity | undefined): string[] {
  const shown = url.slice(0, 120);
  if (!expected || !expected.name || !expected.name.trim()) {
    return [`refused: trusted expected identity with a product name is required for ${shown}`];
  }
  const problems: string[] = [];
  if (!hasTrustedIdentifier(expected)) {
    problems.push(
      `refused: trusted identifier (gtin, sku, platformVariantId, or variantKey) is required for ${shown} — ` +
        'names alone cannot prove variant identity',
    );
  }
  if (!expected.productId?.trim()) {
    problems.push(
      `refused: trusted parent productId is required for ${shown} — the worker must prove product identity`,
    );
  }
  return problems;
}

function firstExpectedProblem(
  urls: string[],
  expectedByUrl: Record<string, ValidationExpectedIdentity | undefined>,
): string | null {
  for (const url of urls) {
    const problems = expectedProblemsFor(url, expectedByUrl[canonicalUrl(url)]);
    if (problems.length > 0) return problems[0]!;
  }
  return null;
}

/**
 * Fail-closed gate for the opt-in pilot. Refuses when the explicit opt-in
 * flag is absent, under CI, when isolation is unavailable, or when the
 * operator has not supplied an explicit public domain + distinct in-domain
 * representatives and blind holdouts with trusted expected identities.
 * Never throws.
 */
export function evaluatePilotGates(
  env: Record<string, string | undefined>,
  isolation: { available: boolean; reason: string },
  options: PilotGateOptions,
): PilotGate {
  const runProblem = checkRunGates(env, isolation);
  if (runProblem) return { ok: false, reason: runProblem };
  const domain = canonicalDomain(options.domain);
  if (!domain) return { ok: false, reason: 'refused: an explicit domain is required' };
  const representativeUrls = options.representativeUrls.map(canonicalUrl);
  const holdoutUrls = options.holdoutUrls.map(canonicalUrl);
  const problem =
    checkSampleSet(representativeUrls, domain, 'representative') ??
    checkSampleSet(holdoutUrls, domain, 'holdout') ??
    duplicateHoldoutProblem(representativeUrls, holdoutUrls) ??
    firstExpectedProblem([...representativeUrls, ...holdoutUrls], options.expectedByUrl ?? {});
  if (problem) return { ok: false, reason: problem };
  return {
    ok: true,
    domain,
    representativeUrls,
    holdoutUrls,
    workspaceId: workspaceFor(domain, options.workspaceId),
    actor: (options.actor ?? '').trim() || 'operator-pilot',
  };
}

function duplicateHoldoutProblem(representativeUrls: string[], holdoutUrls: string[]): string | null {
  const duplicate = firstDuplicateHoldout(representativeUrls, holdoutUrls);
  if (!duplicate) return null;
  return (
    `refused: holdout ${duplicate.slice(0, 120)} is also a representative — ` +
    'a blind holdout must be distinct from every investigation input'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `expected identities are not valid JSON: ${messageOf(err)}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'expected identities must be a JSON object keyed by URL' };
  return { ok: true, value: parsed };
}

/** One `{ url: identity }` entry → a keyed identity, or the reason it is unusable. */
function expectedEntry(
  url: string,
  identity: unknown,
): { ok: true; value: [string, ValidationExpectedIdentity] } | { ok: false; reason: string } {
  if (!isPlainObject(identity)) {
    return { ok: false, reason: `expected identity for ${url.slice(0, 120)} must be an object` };
  }
  return { ok: true, value: [canonicalUrl(url), identity as unknown as ValidationExpectedIdentity] };
}

/**
 * Parse the operator-supplied expected-identity map (`{ "<url>": {...} }`).
 * Pure and total: the caller decides how to report a refusal, so this stays
 * usable by both the CLI and tests.
 */
export function parseExpectedIdentities(
  raw: string,
): { ok: true; value: Record<string, ValidationExpectedIdentity> } | { ok: false; reason: string } {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const entries = Object.entries(parsed.value);
  if (entries.length === 0) return { ok: false, reason: 'expected identities object is empty' };
  const value: Record<string, ValidationExpectedIdentity> = {};
  for (const [url, identity] of entries) {
    const entry = expectedEntry(url, identity);
    if (!entry.ok) return entry;
    value[entry.value[0]] = entry.value[1];
  }
  return { ok: true, value };
}

// ─── CLI contract ──────────────────────────────────────────────────────────

interface PilotCliInput {
  domain: string | null;
  representativeUrls: string[];
  holdoutUrls: string[];
  expectedJsonPath: string | null;
  workspaceId: string | null;
  actor: string | null;
}

const PILOT_URL_FLAGS: Readonly<Record<string, 'representativeUrls' | 'holdoutUrls'>> = {
  '--rep-url': 'representativeUrls',
  '--representative-url': 'representativeUrls',
  '--holdout-url': 'holdoutUrls',
};

const PILOT_VALUE_FLAGS: Readonly<Record<string, 'domain' | 'expectedJsonPath' | 'workspaceId' | 'actor'>> = {
  '--domain': 'domain',
  '--expected-json': 'expectedJsonPath',
  '--workspace': 'workspaceId',
  '--actor': 'actor',
};

/**
 * Parse the pilot CLI argv. Unknown flags, missing values, and a missing
 * `--expected-json` are refusals (never guessed defaults), so the script
 * stays a thin shell over the same contract the tests exercise.
 */
export function parsePilotArgv(
  argv: readonly string[],
): { ok: true; value: PilotCliInput } | { ok: false; reason: string } {
  const cli: PilotCliInput = {
    domain: null,
    representativeUrls: [],
    holdoutUrls: [],
    expectedJsonPath: null,
    workspaceId: null,
    actor: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const refusal = applyPilotFlag(cli, argv[i]!, argv[i + 1]);
    if (refusal) return { ok: false, reason: refusal };
  }
  if (!cli.expectedJsonPath) return { ok: false, reason: 'missing required --expected-json <path>' };
  return { ok: true, value: cli };
}

function applyPilotFlag(
  cli: PilotCliInput,
  flag: string,
  value: string | undefined,
): string | null {
  if (value == null || value.startsWith('--')) return `missing value for ${flag}`;
  const urlKey = PILOT_URL_FLAGS[flag];
  if (urlKey) {
    cli[urlKey].push(value);
    return null;
  }
  const valueKey = PILOT_VALUE_FLAGS[flag];
  if (valueKey) {
    cli[valueKey] = value;
    return null;
  }
  return `unknown argument: ${flag}`;
}

// ─── Report ────────────────────────────────────────────────────────────────

interface PilotReport {
  schemaVersion: number;
  domain: string;
  workspaceId: string;
  representativeUrls: string[];
  /** Reserved blind holdouts: validated, never sent to the investigator. */
  holdoutUrls: string[];
  investigationId: string;
  runId: string;
  provider: string;
  actingModel: { provider: string; model: string };
  modelCalls: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  isolation: { verified: boolean; detail: string };
  stepsPerformed: string[];
  proposalHash: string | null;
  policyHash: string | null;
  validation: {
    status: string;
    holdoutsRequired: number;
    holdoutsPassed: number;
    holdoutSampleIds: string[];
    blockers: string[];
  } | null;
  draft: {
    appliedVersionId: string;
    inactive: true;
    imageRuleOk: false;
    blockers: string[];
  } | null;
  usage: {
    pagesVisited: number | null;
    readsPerformed: number | null;
    durationMs: number | null;
    modelCalls: number;
  };
  activationPerformed: false;
  releasePerformed: false;
  attestationPerformed: false;
  passed: boolean;
  failureCode: string | null;
  notes: string[];
}

interface PilotStores {
  proposals?: ProposalStore;
  validations?: ValidationStore;
}

export interface PilotDeps extends PilotGateOptions {
  env: Record<string, string | undefined>;
  checkIsolation: () => Promise<{ available: boolean; reason: string }>;
  /**
   * Explicit investigation step, owned by the caller. The production CLI
   * runs the real containerized local harness through the lifecycle
   * service (representatives only — holdouts never enter the input). Must
   * not activate/release/attest.
   */
  investigate: (input: {
    workspaceId: string;
    domain: string;
    representativeUrls: string[];
  }) => Promise<InvestigationRecord>;
  runner: PolicyWorkerRunner;
  createVersion: (input: Record<string, unknown>) => { id: string; domain: string; version: number };
  stores?: PilotStores;
  now?: () => string;
}

interface PilotOutcome {
  exitCode: 0 | 1 | 2;
  report: PilotReport | null;
  reason?: string;
}

/** Accumulated pilot state: everything performed so far, nothing inferred. */
interface PilotState {
  steps: string[];
  notes: string[];
  investigation: InvestigationRecord | null;
  validation: ProposalValidation | null;
  appliedVersionId: string | null;
  draftBlockers: string[];
}

function freshState(): PilotState {
  return {
    steps: ['isolation_verified'],
    notes: [],
    investigation: null,
    validation: null,
    appliedVersionId: null,
    draftBlockers: [],
  };
}

function elapsedMs(startedAt: string, endedAt: string): number {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : 0;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 120);
}

/** Non-empty string, else the fallback (model metadata fields are optional). */
function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

/** Truthful acting-model identity: counted model metadata or explicit unreported. */
function actingModelOf(record: InvestigationRecord | null): { provider: string; model: string } {
  const actual = (record?.actualModel ?? null) as { provider?: unknown; model?: unknown } | null;
  return {
    provider: textOr(actual?.provider, textOr(record?.provider, 'unknown')),
    model: textOr(actual?.model, 'unreported'),
  };
}

/** Usage block: every field is what the run reported, or explicit null. */
function usageOf(record: InvestigationRecord | null): PilotReport['usage'] {
  return {
    pagesVisited: record?.usage?.pagesVisited ?? null,
    readsPerformed: record?.usage?.readsPerformed ?? null,
    durationMs: record?.usage?.durationMs ?? null,
    modelCalls: record?.usage?.modelCalls ?? 0,
  };
}

/** Binding hashes of the validation actually persisted for this run. */
function bindingOf(validation: ProposalValidation | null): { proposalHash: string | null; policyHash: string | null } {
  if (!validation) return { proposalHash: null, policyHash: null };
  return { proposalHash: validation.proposalHash || null, policyHash: validation.policyHash || null };
}

/** The governed draft as captured, or null when no draft was created. */
function draftOf(state: PilotState): PilotReport['draft'] {
  if (state.appliedVersionId === null) return null;
  return {
    appliedVersionId: state.appliedVersionId,
    inactive: true,
    imageRuleOk: false,
    blockers: state.draftBlockers,
  };
}

function validationSummaryOf(validation: ProposalValidation | null): PilotReport['validation'] {
  if (!validation) return null;
  return {
    status: validation.status,
    holdoutsRequired: validation.holdouts.required,
    holdoutsPassed: validation.holdouts.passed,
    holdoutSampleIds: validation.holdouts.sampleIds,
    blockers: validation.blockers,
  };
}

interface ReportContext {
  gate: PilotGatedInput;
  isolationReason: string;
  startedAt: string;
  endedAt: string;
}

function buildReport(
  ctx: ReportContext,
  state: PilotState,
  passed: boolean,
  failureCode: string | null,
): PilotReport {
  const record = state.investigation;
  const binding = bindingOf(state.validation);
  return {
    schemaVersion: PILOT_SCHEMA_VERSION,
    domain: ctx.gate.domain,
    workspaceId: ctx.gate.workspaceId,
    representativeUrls: ctx.gate.representativeUrls,
    holdoutUrls: ctx.gate.holdoutUrls,
    investigationId: textOr(record?.id, 'none'),
    runId: textOr(record?.runId, 'none'),
    provider: textOr(record?.provider, 'local_browser_harness'),
    actingModel: actingModelOf(record),
    modelCalls: record?.usage?.modelCalls ?? 0,
    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    durationMs: elapsedMs(ctx.startedAt, ctx.endedAt),
    isolation: { verified: true, detail: ctx.isolationReason.slice(0, 300) },
    stepsPerformed: state.steps,
    proposalHash: binding.proposalHash,
    policyHash: binding.policyHash,
    validation: validationSummaryOf(state.validation),
    draft: draftOf(state),
    usage: usageOf(record),
    activationPerformed: false,
    releasePerformed: false,
    attestationPerformed: false,
    passed,
    failureCode,
    notes: state.notes,
  };
}

// ─── Steps ─────────────────────────────────────────────────────────────────

type Step<T> = { ok: true; value: T } | { ok: false; failureCode: string };

/** A read-only investigation store view over one record (pilot is in-memory). */
function recordView(record: InvestigationRecord, workspaceId: string): InvestigationStore {
  const scoped = (id: string, ws: string): boolean => ws === workspaceId && id === record.id;
  return {
    insert: () => record,
    find: (ws, id) => (scoped(id, ws) ? record : null),
    list: () => [record],
    findActive: () => null,
    existsInOtherWorkspace: () => false,
    update: () => record,
  };
}

function toValidationSamples(
  representativeUrls: string[],
  holdoutUrls: string[],
  expectedByUrl: Record<string, ValidationExpectedIdentity | undefined>,
): ValidationSampleInput[] {
  const sampleFor = (url: string, role: 'representative' | 'holdout'): ValidationSampleInput => ({
    url: canonicalUrl(url),
    role,
    expected: expectedByUrl[canonicalUrl(url)]!,
  });
  return [
    ...representativeUrls.map((url) => sampleFor(url, 'representative')),
    ...holdoutUrls.map((url) => sampleFor(url, 'holdout')),
  ];
}

/**
 * The captured version input proves governed-draft shape: no active pointer,
 * no release/attestation claim, no image grant. Anything else fails the
 * pilot closed rather than claiming a governed draft.
 */
function governedDraftStep(captured: Record<string, unknown> | undefined): Step<string[]> {
  const summary = (captured?.validationSummary ?? {}) as { imageRuleOk?: unknown; blockers?: unknown };
  if (!captured || summary.imageRuleOk !== false) {
    return { ok: false, failureCode: 'pilot_draft_not_governed:captured draft is not an inactive un-attested draft' };
  }
  const claims = ['active', 'released', 'attested'].filter((key) => key in captured);
  if (claims.length > 0) {
    return {
      ok: false,
      failureCode: `pilot_draft_not_governed:captured draft claims ${claims.join('/')}`,
    };
  }
  return { ok: true, value: Array.isArray(summary.blockers) ? (summary.blockers as string[]) : [] };
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/**
 * Mutable accumulator for one pilot run: performed steps, notes, and the
 * artifacts each step produced. Nothing here is inferred — every field is
 * written by the step that actually performed the work.
 */
interface RunContext {
  deps: PilotDeps;
  gate: PilotGatedInput;
  isolationReason: string;
  startedAt: string;
  state: PilotState;
  proposals: ProposalStore;
  validations: ValidationStore;
}

function nowIsoOf(ctx: RunContext): string {
  return (ctx.deps.now ?? (() => new Date().toISOString()))();
}

function finish(ctx: RunContext, passed: boolean, failureCode: string | null): PilotOutcome {
  if (passed) {
    ctx.state.notes.push('no activation, release, or image attestation was performed or claimed');
  }
  return {
    exitCode: passed ? 0 : 1,
    report: buildReport(
      {
        gate: ctx.gate,
        isolationReason: ctx.isolationReason,
        startedAt: ctx.startedAt,
        endedAt: nowIsoOf(ctx),
      },
      ctx.state,
      passed,
      failureCode,
    ),
  };
}

/** Explicit investigation → completed typed result (or a reported failure). */
async function investigateStep(ctx: RunContext): Promise<Step<InvestigationRecord>> {
  let record: InvestigationRecord;
  try {
    record = await ctx.deps.investigate({
      workspaceId: ctx.gate.workspaceId,
      domain: ctx.gate.domain,
      representativeUrls: ctx.gate.representativeUrls,
    });
  } catch (err) {
    return { ok: false, failureCode: `pilot_investigation_failed:${messageOf(err)}` };
  }
  ctx.state.investigation = record;
  if (record.status !== 'completed' || !record.result) {
    const detail = String(record.failureCode ?? 'no_result').slice(0, 80);
    return { ok: false, failureCode: `pilot_investigation_not_completed:${record.status}:${detail}` };
  }
  ctx.state.steps.push('investigation_completed');
  return { ok: true, value: record };
}

/** Deterministic compilation through the existing gate (a refusal is a failure). */
async function compileStep(ctx: RunContext, record: InvestigationRecord): Promise<Step<null>> {
  const outcome = await compileProposalForInvestigation(
    { investigations: recordView(record, ctx.gate.workspaceId), proposals: ctx.proposals },
    ctx.gate.workspaceId,
    record.id,
  );
  if (outcome.status === 'proposal') return { ok: true, value: null };
  const detail =
    outcome.status === 'requires_code_adapter'
      ? `requires_code_adapter:${outcome.codeAdapterRequest.capability}`
      : `unresolved:${(outcome.gaps ?? []).map((g) => g.kind).slice(0, 4).join(',')}`;
  return { ok: false, failureCode: `pilot_compile_refused:${detail.slice(0, 120)}` };
}

/** Representative + truly blind holdout validation through the injected worker. */
async function validateStep(ctx: RunContext, record: InvestigationRecord): Promise<Step<ProposalValidation>> {
  let validation: ProposalValidation;
  try {
    validation = await validateProposal(
      {
        investigations: recordView(record, ctx.gate.workspaceId),
        proposals: ctx.proposals,
        validations: ctx.validations,
        runner: ctx.deps.runner,
      },
      {
        workspaceId: ctx.gate.workspaceId,
        investigationId: record.id,
        samples: toValidationSamples(ctx.gate.representativeUrls, ctx.gate.holdoutUrls, ctx.deps.expectedByUrl),
      },
    );
  } catch (err) {
    return { ok: false, failureCode: `pilot_validation_failed:${messageOf(err)}` };
  }
  ctx.state.validation = validation;
  ctx.state.steps.push(`validation_${validation.status}`);
  if (validation.status !== 'passed') {
    const blocker = validation.blockers[0]?.slice(0, 80) ?? 'blocked';
    return { ok: false, failureCode: `pilot_validation_not_passed:${validation.status}:${blocker}` };
  }
  return { ok: true, value: validation };
}

/** Server-authoritative apply: the persisted validation record is what binds. */
async function applyStep(ctx: RunContext, record: InvestigationRecord): Promise<Step<string>> {
  const captured: Array<Record<string, unknown>> = [];
  let appliedVersionId: string;
  try {
    const applied = await applyProposalToDraft(
      {
        investigations: recordView(record, ctx.gate.workspaceId),
        proposals: ctx.proposals,
        validations: ctx.validations,
        createVersion: (input) => {
          captured.push(input as unknown as Record<string, unknown>);
          const made = ctx.deps.createVersion(input as unknown as Record<string, unknown>);
          return { id: made.id, domain: made.domain, version: made.version };
        },
      },
      { workspaceId: ctx.gate.workspaceId, investigationId: record.id, actor: ctx.gate.actor },
    );
    appliedVersionId = applied.appliedVersionId;
    ctx.state.draftBlockers = applied.blockers;
  } catch (err) {
    return { ok: false, failureCode: `pilot_apply_failed:${messageOf(err)}` };
  }
  const governed = governedDraftStep(captured[0]);
  if (!governed.ok) return governed;
  ctx.state.draftBlockers = governed.value;
  ctx.state.appliedVersionId = appliedVersionId;
  ctx.state.steps.push('draft_applied');
  return { ok: true, value: appliedVersionId };
}

/** Read-only derived operator views recorded as notes (never new claims). */
function noteVisibleViews(ctx: RunContext): void {
  const { investigation, validation } = ctx.state;
  if (!investigation || !validation) return;
  const workspace = describeInvestigationWorkspace({
    record: investigation,
    budget: investigation.budget,
    representatives: ctx.gate.representativeUrls,
    corpusUrls: [...ctx.gate.representativeUrls, ...ctx.gate.holdoutUrls],
    reservedUrls: validation.holdouts.sampleIds,
    validation,
  });
  const telemetry = describeInvestigationTelemetry(investigation, validation);
  ctx.state.notes.push(
    `draft ${ctx.state.appliedVersionId} is inactive with imageRuleOk false; ` +
      `blockers preserved (${ctx.state.draftBlockers.length})`,
  );
  ctx.state.notes.push(
    `workspace proposal ${workspace.proposal.available ? 'available' : 'unavailable'}; ` +
      `automatic activation ${workspace.actions.automaticActivation ? 'PRESENT (forbidden)' : 'absent'}; ` +
      `telemetry validation ${telemetry.validation?.status ?? 'missing'}`,
  );
}

/** Run the steps in order, failing closed at the first refusal. */
async function runSteps(ctx: RunContext): Promise<PilotOutcome> {
  const investigation = await investigateStep(ctx);
  if (!investigation.ok) return finish(ctx, false, investigation.failureCode);
  const compile = await compileStep(ctx, investigation.value);
  if (!compile.ok) return finish(ctx, false, compile.failureCode);
  ctx.state.steps.push('proposal_compiled');
  const validation = await validateStep(ctx, investigation.value);
  if (!validation.ok) return finish(ctx, false, validation.failureCode);
  const applied = await applyStep(ctx, investigation.value);
  if (!applied.ok) return finish(ctx, false, applied.failureCode);
  noteVisibleViews(ctx);
  return finish(ctx, true, null);
}

/**
 * Run the opt-in pilot through injected dependencies. Gate refusals
 * (exit 2) never touch the harness. A completed pilot (exit 0/1) records
 * only performed steps plus explicit non-performance of activation,
 * release, and attestation.
 */
export async function runPilot(deps: PilotDeps): Promise<PilotOutcome> {
  const startedAt = (deps.now ?? (() => new Date().toISOString()))();
  const isolation = await deps
    .checkIsolation()
    .catch(() => ({ available: false, reason: 'isolation probe threw' }));
  const gate = evaluatePilotGates(deps.env, isolation, {
    domain: deps.domain,
    representativeUrls: deps.representativeUrls,
    holdoutUrls: deps.holdoutUrls,
    expectedByUrl: deps.expectedByUrl,
    ...(deps.workspaceId ? { workspaceId: deps.workspaceId } : {}),
    ...(deps.actor ? { actor: deps.actor } : {}),
  });
  if (!gate.ok) return { exitCode: 2, report: null, reason: gate.reason };
  return runSteps({
    deps,
    gate,
    isolationReason: isolation.reason,
    startedAt,
    state: freshState(),
    proposals: deps.stores?.proposals ?? createMemoryProposalStore(),
    validations: deps.stores?.validations ?? createMemoryValidationStore(),
  });
}
