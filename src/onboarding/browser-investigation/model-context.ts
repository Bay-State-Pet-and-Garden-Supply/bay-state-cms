// Tier 1 bounded model reasoning over redacted observations (#237).
//
// One bounded model call maps broker-mediated Tier 0 observations to
// identity-requirement guidance. Three properties are enforced HERE, at
// context construction, not by prompt discipline:
//
// 1. Holdout blindness by construction: the builder signature accepts NO
//    holdout material — no failure context, no reports, no metadata, no
//    knownContext VALUES (key names only), no page bodies. The caller
//    supplies the reserved-holdout exclusion list explicitly; every context
//    string is probed for every excluded URL/artifact and the build fails
//    closed with `holdout_exposed` on any match.
// 2. Redaction by construction: observations carry kind/sourceUrl/bounded
//    detail/artifact hash only. Raw page bodies, keys, and knownContext
//    values have no field to travel in — the input type cannot express them.
// 3. Advisory-only output: reasoning may propose display strategy prose and
//    additional gaps. It can NEVER set identity requirements, field
//    recommendations, structures, or platform — those stay Tier 0
//    deterministic, so the compiler gate is unchanged and a compromised or
//    confused model cannot select executables.
//
// Budgets are enforced around the single call (`reasonWithBudget` charges
// input bytes pre-dispatch and output tokens/result bytes post-hoc through
// the run ledger; overruns fail closed with `budget_exhausted`). The call
// races the remaining time budget (`timeout`). Output shape violations fail
// with `provider_error`. No images are ever attached to a reasoning call.
//
// Pure except for the injected reasoner (no DB, no network, no provider
// imports): Vitest-safe.

import { createHash } from 'node:crypto';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';
import { BudgetLedger } from './budgets';

/** One Tier 0 observation, redacted for model visibility (no bodies, no keys). */
export interface RedactedObservation {
  kind: string;
  sourceUrl: string;
  artifactHash: string;
  detail?: string;
  incomplete: boolean;
}

/** A reserved blind holdout the model must never see (URL + optional artifact). */
export interface Tier1ExcludedHoldout {
  url: string;
  artifactRef?: string | null;
}

export interface Tier1ModelContextInput {
  investigationId: string;
  domain: string;
  observations: RedactedObservation[];
  evidenceRefs: string[];
  /** Tier 0 gaps (capture + analysis). Failure detail is NOT an input — it stays out by construction. */
  analysisGaps: string[];
  /** Operator knownContext KEY names only. Values have no field here. */
  knownContextKeys: string[];
  /** Reserved blind holdouts. Required: blindness needs the list (empty when none reserved). */
  excludedHoldouts: Tier1ExcludedHoldout[];
  budget: InvestigationBudget;
}

export interface Tier1ModelContext {
  version: 1;
  investigationId: string;
  domain: string;
  observations: RedactedObservation[];
  evidenceRefs: string[];
  analysisGaps: string[];
  knownContextKeys: string[];
  /** Hash of the canonical exclusion list the context was probed against (auditable). */
  exclusionCommitment: string;
  /** UTF-8 bytes of the serialized model input (pre-charged to the ledger by the caller). */
  inputBytes: number;
}

export type ModelContextCode = 'holdout_exposed' | 'budget_exhausted' | 'invalid_input';

export class ModelContextError extends Error {
  readonly code: ModelContextCode;
  constructor(code: ModelContextCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ModelContextError';
    this.code = code;
  }
}

/** Canonical exclusion commitment: sorted normalized URLs + artifact refs, hashed. */
export function exclusionCommitmentOf(excluded: Tier1ExcludedHoldout[]): string {
  const canonical = excluded
    .map((h) => `${normalizeUrl(h.url)}|${(h.artifactRef ?? '').trim().toLowerCase()}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Every model-visible string in the context: observations, refs, gaps, keys, domain. */
function contextStrings(ctx: {
  domain: string;
  observations: RedactedObservation[];
  evidenceRefs: string[];
  analysisGaps: string[];
  knownContextKeys: string[];
}): string[] {
  const out: string[] = [ctx.domain];
  for (const o of ctx.observations) {
    out.push(o.sourceUrl, o.artifactHash, o.detail ?? '', o.kind);
  }
  out.push(...ctx.evidenceRefs, ...ctx.analysisGaps, ...ctx.knownContextKeys);
  return out.filter((s) => s.length > 0);
}

/**
 * Probe every context string for every excluded holdout (raw + canonical
 * URL forms, artifact ref). First match fails closed — exposure asks the
 * operator for a replacement holdout, never a quiet scrub.
 */
/** Every literal form of one reserved holdout that must never appear in context. */
function holdoutProbes(holdout: Tier1ExcludedHoldout): Array<{ needle: string; message: string }> {
  const url = holdout.url.trim();
  const canonical = normalizeUrl(holdout.url);
  const artifactRaw = holdout.artifactRef?.trim();
  const probes: Array<{ needle: string; message: string }> = [];
  if (url) {
    probes.push({ needle: url, message: `model context contains reserved holdout URL ${truncate(url)}` });
    if (canonical !== url) {
      probes.push({ needle: canonical, message: `model context contains reserved holdout URL ${truncate(url)}` });
    }
  }
  if (artifactRaw) {
    probes.push({
      needle: artifactRaw.toLowerCase(),
      message: 'model context contains a reserved holdout artifact',
    });
  }
  return probes;
}

/** First context string carrying a probe needle (case-insensitive), or null. */
function firstHoldoutExposure(
  contextStrings: string[],
  probes: Array<{ needle: string; message: string }>,
): { message: string } | null {
  for (const text of contextStrings) {
    const haystack = text.toLowerCase();
    for (const probe of probes) {
      if (haystack.includes(probe.needle.toLowerCase())) return { message: probe.message };
    }
  }
  return null;
}

function assertHoldoutBlind(contextStrings: string[], excluded: Tier1ExcludedHoldout[]): void {
  for (const holdout of excluded) {
    const exposure = firstHoldoutExposure(contextStrings, holdoutProbes(holdout));
    if (exposure) throw new ModelContextError('holdout_exposed', `holdout_exposed: ${exposure.message}`);
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function redactObservation(
  observation: RedactedObservation,
  maxObservationBytes: number,
): RedactedObservation {
  const detail = observation.detail ?? '';
  const bytes = Buffer.byteLength(detail, 'utf8');
  const clipped = bytes > maxObservationBytes
    ? Buffer.from(detail, 'utf8').subarray(0, maxObservationBytes).toString('utf8')
    : detail;
  return {
    kind: observation.kind.slice(0, 120),
    sourceUrl: observation.sourceUrl,
    artifactHash: observation.artifactHash,
    ...(clipped ? { detail: clipped } : {}),
    incomplete: observation.incomplete || bytes > maxObservationBytes,
  };
}

/**
 * Build the bounded model context. Fails closed on holdout exposure,
 * malformed input, or per-call input overrun — before any model dispatch.
 */
export function buildTier1ModelContext(input: Tier1ModelContextInput): Tier1ModelContext {
  if (!input.investigationId?.trim()) throw new ModelContextError('invalid_input', 'invalid_input: investigationId required');
  if (!input.domain?.trim()) throw new ModelContextError('invalid_input', 'invalid_input: domain required');
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new ModelContextError('invalid_input', 'invalid_input: model reasoning needs at least one observation');
  }
  if (input.observations.length > 50) {
    throw new ModelContextError('invalid_input', 'invalid_input: observation count exceeds the result envelope');
  }
  const observations = input.observations.map((o) =>
    redactObservation(o, input.budget.maxObservationBytesPerOperation),
  );
  const evidenceRefs = input.evidenceRefs.slice(0, 50);
  const analysisGaps = input.analysisGaps.slice(0, 50).map((g) => g.slice(0, 1000));
  const knownContextKeys = [...new Set(input.knownContextKeys)].sort().slice(0, 64);
  assertHoldoutBlind(
    contextStrings({ domain: input.domain, observations, evidenceRefs, analysisGaps, knownContextKeys }),
    input.excludedHoldouts,
  );
  const exclusionCommitment = exclusionCommitmentOf(input.excludedHoldouts);
  const inputBytes = Buffer.byteLength(
    JSON.stringify({ investigationId: input.investigationId, domain: input.domain, observations, evidenceRefs, analysisGaps, knownContextKeys, exclusionCommitment }),
    'utf8',
  );
  if (inputBytes > input.budget.maxModelInputBytesPerCall) {
    throw new ModelContextError(
      'budget_exhausted',
      `budget_exhausted: model input of ${inputBytes} B exceeds per-call cap of ${input.budget.maxModelInputBytesPerCall} B`,
    );
  }
  return {
    version: 1,
    investigationId: input.investigationId,
    domain: input.domain,
    observations,
    evidenceRefs,
    analysisGaps,
    knownContextKeys,
    exclusionCommitment,
    inputBytes,
  };
}

// ─── Reasoner seam + one bounded call ─────────────────────────────────────

/**
 * Advisory-only reasoning result. Strategy prose is display-only (the
 * compiler never branches on it); gaps merge into the result gap list.
 * There is deliberately NO channel for identity, fields, structures, or
 * platform — a model cannot select executables through this seam.
 */
export interface Tier1ModelReasoning {
  /** Display-only strategy label/prose (bounded, truncated). */
  strategy?: string;
  /** Additional gaps the model noticed (bounded count + length, validated). */
  gaps?: string[];
  /** Model-reported output tokens (charged to the ledger; overruns fail closed). */
  outputTokens: number;
  /** Identity of the acting model (reported truthfully in usage). */
  model: { provider: string; model: string };
}

/** One bounded reasoning call over a pre-built context. Injected (tests) or operator-configured. */
export interface Tier1ModelReasoner {
  reason(context: Tier1ModelContext): Promise<Tier1ModelReasoning>;
}

export type ReasonCallCode = 'budget_exhausted' | 'timeout' | 'provider_error';

export class ReasonCallError extends Error {
  readonly code: ReasonCallCode;
  constructor(code: ReasonCallCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ReasonCallError';
    this.code = code;
  }
}

const MAX_REASONING_GAPS = 10;
const MAX_STRATEGY_CHARS = 2000;

/**
 * Execute the single bounded Tier 1 reasoning call: pre-charge input bytes,
 * race the remaining time budget, validate + charge the advisory output.
 * Any failure is a stable code — the harness records a gap, never a silent
 * Tier 0-only downgrade without saying so.
 */
export async function reasonWithBudget(
  reasoner: Tier1ModelReasoner,
  context: Tier1ModelContext,
  ledger: BudgetLedger,
  budget: InvestigationBudget,
  opts?: { timeoutMs?: number },
): Promise<{ strategy: string | null; gaps: string[]; model: { provider: string; model: string }; outputTokens: number }> {
  if (budget.maxModelCalls < 1) {
    throw new ReasonCallError('budget_exhausted', 'budget_exhausted: model calls are not budgeted for this run');
  }
  try {
    ledger.chargeModelInput(context.inputBytes);
  } catch {
    throw new ReasonCallError(
      'budget_exhausted',
      'budget_exhausted: cumulative model input would exceed budget',
    );
  }
  const timeoutMs = Math.max(1, opts?.timeoutMs ?? budget.timeoutMs);
  let reasoning: Tier1ModelReasoning;
  try {
    reasoning = await withTimeout(reasoner.reason(context), timeoutMs);
  } catch (err) {
    if (err instanceof ReasonCallError) throw err;
    throw new ReasonCallError('provider_error', `provider_error: model reasoning failed (${reasonFailureOf(err)})`);
  }
  const validated = validateReasoning(reasoning);
  const resultBytes = Buffer.byteLength(JSON.stringify({ strategy: validated.strategy, gaps: validated.gaps }), 'utf8');
  try {
    ledger.chargeModelOutput(validated.outputTokens, resultBytes);
  } catch {
    throw new ReasonCallError('budget_exhausted', 'budget_exhausted: model output would exceed budget');
  }
  return { ...validated, model: reasoning.model };
}

/** Non-empty string, or null (model metadata fields are optional). */
function trimmedOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/** Reject a reasoning result that hides its acting model identity. */
function assertReasoningModel(model: { provider?: unknown; model?: unknown } | undefined): void {
  const identified = !!model && typeof model.provider === 'string' && !!model.provider && typeof model.model === 'string' && !!model.model;
  if (!identified) {
    throw new ReasonCallError('provider_error', 'provider_error: model reasoning hides its identity');
  }
}

/** Output-token count must be a non-negative safe integer (never coerced). */
function assertOutputTokens(outputTokens: unknown): number {
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) {
    throw new ReasonCallError('provider_error', 'provider_error: model reported an invalid output-token count');
  }
  return outputTokens as number;
}

/** Bounded advisory gap list (trimmed, dedupe-free, hard-capped). */
function boundedGaps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0)
    .slice(0, MAX_REASONING_GAPS)
    .map((gap) => gap.trim().slice(0, 1000));
}

function validateReasoning(
  reasoning: Tier1ModelReasoning,
): { strategy: string | null; gaps: string[]; outputTokens: number } {
  if (!reasoning || typeof reasoning !== 'object') {
    throw new ReasonCallError('provider_error', 'provider_error: model returned a malformed reasoning result');
  }
  assertReasoningModel((reasoning as { model?: { provider?: unknown; model?: unknown } }).model);
  const outputTokens = assertOutputTokens((reasoning as { outputTokens?: unknown }).outputTokens);
  const strategy = trimmedOrNull(reasoning.strategy);
  return {
    strategy: strategy ? strategy.slice(0, MAX_STRATEGY_CHARS) : null,
    gaps: boundedGaps(reasoning.gaps),
    outputTokens,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ReasonCallError('timeout', 'timeout: model reasoning exceeded its time budget'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function reasonFailureOf(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
