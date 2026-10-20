/**
 * TypeSafe closed-set official-page selection (issue #364).
 *
 * Replaces the legacy free-text manufacturer-URL selector (`selectWithLlm`
 * in `sitemap-matcher.ts`). A fixed set of retrieval-supplied URL candidates
 * becomes a closed TypeSafe Choice over caller-assigned candidate IDs plus
 * explicit `no_match` / `insufficient_evidence` abstentions; the code maps the
 * returned ID back to the exact original URL. Out-of-set IDs, arbitrary URLs,
 * substring parsing, and correlation-invalid answers can never persist a
 * selection — they surface as named unresolved outcomes.
 *
 * Separated judgments (acceptance: retrieval rank ≠ model probability ≠
 * verification outcome):
 * - retrieval rank: token-overlap ratio computed by the retrieval layer —
 *   recorded, never a model claim;
 * - model probability: Choice `selectedProbability`/`confidence` returned by
 *   TypeSafe, thresholded at {@link SITEMAP_SINGLE_CHOICE_MIN_PROBABILITY}
 *   (0.50, shared with page/attribute/product-type decisions) — never a boost;
 * - verification outcome: the existing page-verifier/identity flow still
 *   authorizes auto-selection and confirmation — a high probability alone
 *   never authorizes anything.
 *
 * Operation registration: `sitemap_selection` (prompt/rules v2, params
 * temperature 0.0); pin `jev-1.13.0`; limits (32Q/255opt/32k state/64k req);
 * bounded transport (single retry via `executeSystemOne`); no chat fallback.
 * Cap: at most 10 retrieval-supplied candidates (the real retrieval bound);
 * larger sets fail closed as `candidate_limit_exceeded` — first-N clipping
 * is forbidden. State budget shrinks to the same 10 records so criteria and
 * metadata always agree.
 * Audit: every attempted call persists start/terminal provenance to the
 * `discovery_model_calls` table (bound to the caller's discovery run) and
 * also returns the same snapshots on the result's `selectionAudit`
 * (success/failed/policy_denied/unavailable/unknown_option_key/
 * correlation_invalid/low_probability), never raw bodies or credentials. The
 * `classification_model_calls` table cannot hold discovery-run ids
 * (`run_id REFERENCES classification_runs(id)`), so the selector keeps its
 * durable audit in the discovery-scoped table instead of that table — never
 * by inventing classification-run parent rows. Calls without a discovery
 * run fail closed pre-transport (no orphan audit rows, no success-looking
 * result-only paths).
 * Guards: live disablement + ownership (`assertHeld`) before every attempt,
 * frozen-policy intactness, evaluated-pin + returned-model identity check.
 *
 * Unresolved outcomes retain safe candidates for operator inspection:
 * `no_match`, `insufficient_evidence`, `provider_disabled`, `transport_failed`,
 * `candidate_limit_exceeded` (limit-abstention for >10 candidates —
 * first-N clipping is forbidden), `out_of_set_answer`, `unknown_option_key`,
 * `correlation_invalid`, `low_model_probability`, plus deterministic
 * `coverage_gap` when retrieval itself produced nothing to judge.
 * A missing correct URL (coverage failure) is
 * `no_match`/`coverage_gap`-shaped accounting on the *supplied* set — never a
 * model success on an unseen option.
 */

import { randomUUID } from 'node:crypto';
import {
  dispatchSystemOne,
  TYPESAFE_EVALUATED_MODEL,
  assertSystemOneModelMatch,
  assertSystemOneModelPin,
  SYSTEMONE_MAX_QUESTIONS,
  SYSTEMONE_MAX_CHOICE_OPTIONS,
  SYSTEMONE_MAX_STATE_BYTES,
  type SystemOneDispatchResult,
} from '../ai/systemone-transport';
import { assertConnectionEnabledForDispatch } from '../ai/provider-connections';
import {
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
  type ModelCallContext,
} from '../classification/model-operation-registry';
import {
  assertModelPolicyIntact,
  ModelPolicyDeniedError,
  type ModelPolicyView,
  type ModelRoute,
} from '../classification/model-policy-gateway';
import {
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
  protectedSystemOneDispatchOptions,
  requireChoiceAnswer,
  buildChoiceJudgmentDerivation,
  resolveDecisionRouteForOperation,
  asEffectivePolicyView,
  fitStateToBudget,
} from '../classification/systemone-decision-core';
import type { ProposalDerivation } from '../shared/schemas/classification';
import type { ProviderConnection } from '../ai/provider-connections';
import { hashCanonicalJson } from '../shared/stable-id';
import {
  insertDiscoveryModelCallStart,
  completeDiscoveryModelCall,
  insertDiscoveryModelCallTerminal,
} from '../db/repositories/discovery-model-call-repo';

// ─── Versioned identity ──────────────────────────────────────────────────────

export const SITEMAP_SELECTION_VERSION = 'jev-sitemap-selection-v2';
export const SITEMAP_SELECTION_QUESTION_ID = 'sitemap_selection';
export const SITEMAP_SELECTION_OPERATION = 'sitemap_selection' as const;

export const SITEMAP_NO_MATCH_KEY = 'no_match';
export const SITEMAP_INSUFFICIENT_EVIDENCE_KEY = 'insufficient_evidence';

/** Selection floor shared with page/attribute/product-type single choices. */
export const SITEMAP_SINGLE_CHOICE_MIN_PROBABILITY = SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY;

/** Maximum candidates: the real retrieval bound (matcher top-10 slice).
 * Anything above fails closed as `candidate_limit_exceeded` — first-N
 * clipping is forbidden. */
export const SITEMAP_MAX_ORDINARY_CANDIDATES = 10;

/**
 * Host of a candidate URL, lowercased without port/trailing dot. Unparseable
 * URLs yield null (never treated as approved).
 */
export function candidateUrlHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Whether a candidate URL's host is authorized by the frozen approved-domain
 * list (exact match or subdomain; case-insensitive). An empty approved list
 * authorizes nothing — fail closed, never open.
 */
export function isApprovedCandidateDomain(url: string, approvedDomains: readonly string[]): boolean {
  const host = candidateUrlHost(url);
  if (!host) return false;
  for (const raw of approvedDomains) {
    const dom = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!dom) continue;
    if (host === dom || host.endsWith(`.${dom}`)) return true;
  }
  return false;
}

// ─── Public types ────────────────────────────────────────────────────────────

/** One retrieval-supplied candidate the judgment set is closed over. */
export interface SitemapSelectionCandidate {
  /** Stable caller-assigned ID (`cand_0` …); the ONLY thing the model may return. */
  id: string;
  /** Exact original URL — mapped from the ID, never from model text. */
  url: string;
  /** Retrieval rank signal (token-overlap ratio); recorded, not judged. */
  retrievalRank: number;
  /** Cached retrieval metadata (title / enriched UPC+SKU); display only. */
  title?: string | null;
  upc?: string | null;
  sku?: string | null;
}

export interface SitemapSelectionInputMeta {
  /** Original Register Name (spreadsheet row; never synthesized). */
  registerName: string;
  /** Consolidated hint when available (may equal the register name). */
  consolidatedName?: string | null;
  /** SKU/UPC evidence. */
  upc?: string | null;
  sku?: string | null;
  /** Evidenced brand/package clues (variant tokens, brand hint). */
  brandHint?: string | null;
  variantTokens?: string[];
  /** Frozen approved domains for this run (never live re-read). */
  approvedDomains: string[];
}

/** Terminal outcome of one closed-set selection. */
export type SitemapSelectionOutcomeCode =
  | 'selected'
  | 'verified_unique_identity'
  | 'no_match'
  | 'insufficient_evidence'
  | 'coverage_gap'
  | 'provider_disabled'
  | 'transport_failed'
  | 'candidate_limit_exceeded'
  | 'out_of_set_answer'
  | 'unknown_option_key'
  | 'correlation_invalid'
  | 'low_model_probability';

export interface SitemapSelectionResult {
  outcome: SitemapSelectionOutcomeCode;
  /** Present ONLY for `selected`: exact supplied URL mapped from the chosen ID. */
  selectedUrl: string | null;
  selectedCandidateId: string | null;
  /** Retrieval rank of the chosen candidate (echo of the supplied rank). */
  retrievalRank: number | null;
  /** TypeSafe Choice P(choice) — separate from verification. */
  selectedProbability: number | null;
  vendorConfidence: number | null;
  probabilityBasis: 'choice_probability' | null;
  candidateProbabilities: Record<string, number>;
  /**
   * Complete Choice distribution keyed by criterion ID (candidate ids PLUS
   * `no_match` / `insufficient_evidence`), retained for calibration
   * analysis. Null on deterministic/no-call paths (no judgment made).
   */
  fullDistribution: Record<string, number> | null;
  /** Safe candidates retained for operator inspection on unresolved outcomes. */
  safeCandidates: SitemapSelectionCandidate[];
  /** Stable audit ids for the path (start + terminal row ids). */
  modelCallIds: string[];
  /** Per-path audit evidence (start/terminal rows); provenance lives here, not the run table. */
  selectionAudit: SitemapSelectionAuditRow[];
  abstentionCode: string | null;
  abstentionReason: string | null;
  derivation?: ProposalDerivation;
}

interface SitemapSelectionRouteOk {
  kind: 'ok';
  route: ModelRoute;
  jevConn: ProviderConnection;
  effectivePolicy: ModelPolicyView;
}

interface SitemapSelectionRouteFailed {
  kind: 'failed';
  result: SitemapSelectionResult;
}

const now = (): string => new Date().toISOString();

/**
 * Selection audit rows (issue #364).
 *
 * The closed-set selector is onboarding-owned: production callers bind it to
 * a discovery-run id (a real `onboarding_discovery_runs` row), which is used
 * as the durable `discovery_model_calls.run_id` binding. The shared
 * `classification_model_calls` table cannot hold those ids (`run_id
 * REFERENCES classification_runs(id)`), so durability lives in the
 * discovery-scoped table. The same snapshots are ALSO returned on the
 * result's `selectionAudit` for downstream provenance reads.
 *
 * Durability rule: when `input.runId` is caller-supplied (a real discovery
 * run), every attempted path persists start/terminal rows to
 * `discovery_model_calls`. The ad-hoc `sitemap-selection:…` fallback id
 * carries no parent run row, so those paths stay result-only.
 */
export interface SitemapSelectionAuditRow {
  id: string;
  runId: string;
  operation: typeof SITEMAP_SELECTION_OPERATION;
  attempt: number;
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  locality: string | null;
  snapshotHash: string;
  modelPolicyDigest: string;
  promptTemplateVersion: string;
  ruleVersion: string;
  promptHash: string;
  status: 'started' | 'success' | 'failed' | 'policy_denied' | 'unavailable';
  errorMessage: string | null;
  typedResultMetadata: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

function auditRow(input: {
  runId: string;
  ctx: ModelCallContext;
  route: { provider: string | null; model: string | null; locality: string | null };
  effectivePolicyDigest: string;
  promptHash: string;
  resolvedModel?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  status: SitemapSelectionAuditRow['status'];
  errorMessage?: string | null;
  typedResultMetadata?: Record<string, unknown> | null;
}): SitemapSelectionAuditRow {
  const startedAt = input.startedAt ?? now();
  return {
    id: randomUUID(),
    runId: input.runId,
    operation: SITEMAP_SELECTION_OPERATION,
    attempt: input.ctx.attempt,
    provider: input.route.provider,
    model: input.route.model,
    requestedModel: input.route.model,
    resolvedModel: input.resolvedModel ?? null,
    locality: input.route.locality,
    snapshotHash: input.ctx.snapshotHash,
    modelPolicyDigest: input.effectivePolicyDigest,
    promptTemplateVersion: input.ctx.promptTemplateVersion,
    ruleVersion: input.ctx.ruleVersion,
    promptHash: input.promptHash,
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    typedResultMetadata: input.typedResultMetadata ?? null,
    startedAt,
    endedAt: input.endedAt ?? (input.status === 'started' ? null : startedAt),
    durationMs: input.durationMs ?? (input.status === 'started' ? null : 0),
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
  };
}

function terminalAuditRow(input: {
  runId: string;
  ctx: ModelCallContext;
  route: { provider: string | null; model: string | null; locality: string | null };
  effectivePolicyDigest: string;
  promptHash: string;
  status: 'policy_denied' | 'unavailable' | 'failed';
  errorMessage: string;
  typedResultMetadata?: Record<string, unknown> | null;
}): SitemapSelectionAuditRow {
  return auditRow({ ...input, status: input.status });
}

function emptyResult(
  outcome: SitemapSelectionOutcomeCode,
  candidates: SitemapSelectionCandidate[],
  code: string | null,
  reason: string | null,
  auditRows: SitemapSelectionAuditRow[] = [],
): SitemapSelectionResult {
  return {
    outcome,
    selectedUrl: null,
    selectedCandidateId: null,
    retrievalRank: null,
    selectedProbability: null,
    vendorConfidence: null,
    probabilityBasis: null,
    candidateProbabilities: {},
    fullDistribution: null,
    safeCandidates: candidates,
    // One durable row per attempt: start/terminal snapshots share one call id.
    modelCallIds: auditRows.length > 0 ? [auditRows[0].id] : [],
    selectionAudit: auditRows,
    abstentionCode: code,
    abstentionReason: reason,
  };
}


function resolveRoute(
  effectivePolicy: ModelPolicyView | null,
  operation: 'sitemap_selection',
): SitemapSelectionRouteOk | SitemapSelectionRouteFailed | { kind: 'unavailable'; reason: string } {
  const normalized = asEffectivePolicyView(effectivePolicy);
  if (!normalized) {
    return { kind: 'unavailable', reason: 'No frozen model policy for sitemap selection — deterministic retrieval only.' };
  }
  try {
    const decision = resolveDecisionRouteForOperation(normalized, operation);
    const route = decision.route;
    const rawConn = decision.conn;
    const isConnObject = rawConn !== null && typeof rawConn === 'object' && 'id' in rawConn;
    const conn: ProviderConnection = isConnObject
      ? (rawConn as ProviderConnection)
      : {
          id: route.provider,
          label: 'TypeSafe Jev',
          transport: 'systemone',
          baseUrl: route.baseUrl,
          trustZone: 'cloud',
          credential: route.apiKey,
          enabled: true,
        };
    return { kind: 'ok', route, jevConn: conn, effectivePolicy: normalized };
  } catch (err: unknown) {
    if (err instanceof ModelPolicyDeniedError) {
      throw err;
    }
    throw err;
  }
}

/**
 * Build the closed Choice: one criterion per supplied candidate ID (the URL
 * is described; the KEY is the candidate ID) plus explicit no_match /
 * insufficient_evidence abstentions. The model must return a key; the URL is
 * mapped code-side from the key, never parsed from model text.
 */
export function buildSitemapSelectionQuestion(
  candidates: SitemapSelectionCandidate[],
): { questionId: string; instructions: string; criteria: Record<string, string> } {
  const criteria: Record<string, string> = {};
  for (const cand of candidates) {
    const label = cand.title ? `${cand.url} (Indexed title: ${cand.title.slice(0, 160)})` : cand.url;
    criteria[cand.id] = `This supplied candidate is the exact official product page: ${label}`;
  }
  criteria[SITEMAP_NO_MATCH_KEY] =
    'None of the supplied candidate URLs is the exact official product page for the registered item.';
  criteria[SITEMAP_INSUFFICIENT_EVIDENCE_KEY] =
    'The supplied product evidence is insufficient, ambiguous, or lacks essential product details to determine the exact official page with confidence.';
  const instructions =
    `Select the single supplied candidate that is the exact official product page for the registered item, ` +
    `using ONLY the supplied candidate list. Return exactly one of the candidate IDs listed in the criteria ` +
    `(for example "${candidates[0]?.id ?? 'cand_0'}"). If none of the supplied candidates is the exact official ` +
    `product page, select "${SITEMAP_NO_MATCH_KEY}". If the supplied evidence does not provide enough ` +
    `information to determine the exact page with confidence, select "${SITEMAP_INSUFFICIENT_EVIDENCE_KEY}". ` +
    `Never invent, construct, alter, or return a URL — the answer must be one of the listed candidate IDs exactly.`;
  return { questionId: SITEMAP_SELECTION_QUESTION_ID, instructions, criteria };
}

function buildSitemapSelectionState(
  meta: SitemapSelectionInputMeta,
  candidates: SitemapSelectionCandidate[],
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    registerName: meta.registerName.slice(0, 500),
    consolidatedName: (meta.consolidatedName ?? meta.registerName).slice(0, 500),
    upc: meta.upc ?? null,
    sku: meta.sku ?? null,
    brandHint: meta.brandHint ?? null,
    variantTokens: (meta.variantTokens ?? []).slice(0, 8),
    approvedDomains: meta.approvedDomains.slice(0, 8),
    evidenceCount: candidates.length,
    candidateRecords: candidates.map(c => ({
      id: c.id,
      url: c.url.slice(0, 500),
      title: c.title?.slice(0, 200) ?? null,
      upc: c.upc ?? null,
      sku: c.sku ?? null,
      retrievalRank: c.retrievalRank,
    })),
  };
  // Honor the 32k state budget like every other decision boundary: drop
  // titles first, then shrink to the retrieval bound (10 candidate
  // records). The shrink callbacks read through the untyped state record
  // with guarded narrowing (no inline-cast member access). Criteria always
  // carry all IDs, so the candidate set stays judgeable — a set that still
  // exceeds the state budget after shrinking fails closed at dispatch
  // (transport_failed), never as silent truncation.
  fitStateToBudget(state, s => {
    if (s.candidateRecords !== undefined && Array.isArray(s.candidateRecords)) {
      for (const r of s.candidateRecords) {
        if (r !== null && typeof r === 'object' && 'title' in r) {
          const rec = r as { title?: unknown };
          rec.title = null;
        }
      }
    }
  });
  fitStateToBudget(state, s => {
    if (Array.isArray(s.candidateRecords)) {
      s.candidateRecords = s.candidateRecords.slice(0, SITEMAP_MAX_ORDINARY_CANDIDATES);
    }
  });
  return state;
}
/**
 * Closed-set TypeSafe selection over retrieval-supplied candidates.
 *
 * Contract:
 * - `candidates` is the complete judgment set (≤10 variant-aware deduped URLs
 *   from retrieval). The model chooses among `candidate.id` values (+ the two
 *   abstention keys); the returned ID maps to the exact original URL.
 * - Returns `verified_unique_identity` WITHOUT any model call when the caller
 *   proves a unique exact identity deterministically (see `skipReason`).
 * - Single-candidate sets pass through as ordinary verification work — no
 *   choice call is issued for them either (still `verified_unique_identity`
 *   so the caller runs normal verification, not a judgment).
 * - Every other unresolved outcome retains `safeCandidates` for inspection.
 *
 * @param input.candidates  closed judgment set (empty ⇒ `coverage_gap`, no call)
 * @param input.skipReason  when non-null, bypass the model call entirely and
 *                          report a deterministic outcome with no call IDs
 */
export async function selectOfficialPageWithTypesafe(input: {
  candidates: SitemapSelectionCandidate[];
  meta: SitemapSelectionInputMeta;
  modelPolicy?: ModelPolicyView | null;
  runId?: string | null;
  itemId?: string | null;
  assertHeld?: () => void;
  /** Frozen request hash from the owning discovery run; empty string when absent (verify step requires it when call ids exist). */
  snapshotHash?: string | null;
  skipReason?: 'verified_unique_identity' | 'single_candidate_verify' | null;
}): Promise<SitemapSelectionResult> {
  const { meta, assertHeld } = input;
  const suppliedCandidates = input.candidates;
  const snapshotHash = input.snapshotHash ?? '';
  // Fail closed when no discovery run binds the attempt: an unbound
  // selection would leave orphan audit rows (no durable parent run), so a
  // model call is never issued. Deterministic bypasses below stay
  // result-only (no audit rows exist for them either way).
  const durableRunId = input.runId ?? null;
  const runId = durableRunId ?? 'unbound';

  // Empty retrieval set: coverage failure, never a model call on unseen options.
  if (suppliedCandidates.length === 0) {
    return {
      ...emptyResult(
        'coverage_gap',
        [],
        'coverage_gap',
        'coverage_gap: retrieval supplied no candidates — a missing correct URL is a retrieval coverage failure, never model output.',
      ),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'coverage_gap'),
    };
  }

  // Domain-authority gate (issue #374 live-dev finding): runs BEFORE the
  // deterministic bypasses so no path — bypass, judgment, or verification
  // handoff — can authorize an off-domain URL. Candidates whose host is
  // outside the frozen approved domains are never judged: the model must
  // not choose an unauthorized domain at any probability, and a caller
  // assertion of "verified identity" over an unauthorized host is refused
  // rather than passed through. When NONE are authorized, abstain as
  // insufficient_evidence without a model call; the unauthorized
  // candidates are retained as safeCandidates for inspection. A mixed set
  // proceeds with ONLY the authorized subset (the unauthorized remainder
  // stays visible in safeCandidates, never in the judgment set).
  const authorized = suppliedCandidates.filter(c => isApprovedCandidateDomain(c.url, input.meta.approvedDomains));
  const offDomain = suppliedCandidates.filter(c => !isApprovedCandidateDomain(c.url, input.meta.approvedDomains));

  // All-supplied-off-domain: abstain without a model call (including
  // bypass-claimed identity — authority beats assertion); the full
  // supplied set stays inspectable as safe candidates.
  if (authorized.length === 0) {
    return {
      ...emptyResult(
        'insufficient_evidence',
        suppliedCandidates,
        'insufficient_evidence',
        `insufficient_evidence: none of the ${suppliedCandidates.length} supplied candidate(s) fall under the frozen approved domains (${input.meta.approvedDomains.join(', ') || 'none'}) — choosing an unauthorized domain is forbidden regardless of probability.`,
      ),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'insufficient_evidence'),
    };
  }
  // Judgment set from here on: ONLY the authorized subset. The off-domain
  // remainder is appended to every downstream safeCandidates list (never
  // judged, always inspectable). `candidates` below is the judged set by
  // construction; `offDomain` rides along for retention.
  const candidates = authorized;

  // Deterministic exact-identity / single-candidate path: no model call.
  // Operates on the authorized subset only (see gate above).
  if (input.skipReason === 'verified_unique_identity' || input.skipReason === 'single_candidate_verify') {
    return {
      ...emptyResult(
        'verified_unique_identity',
        [...candidates, ...offDomain],
        input.skipReason,
        input.skipReason === 'verified_unique_identity'
          ? 'verified_unique_identity: deterministic exact identity — no selection call needed.'
          : 'single_candidate_verify: one retrieval candidate — ordinary verification, no choice call.',
      ),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, input.skipReason),
    };
  }

  // Over-limit set: explicit abstention, first-N clipping forbidden.
  if (candidates.length > SITEMAP_MAX_ORDINARY_CANDIDATES) {
    return {
      ...emptyResult(
        'candidate_limit_exceeded',
        [...candidates, ...offDomain],
        'candidate_limit_exceeded',
        `candidate_limit_exceeded: ${candidates.length} candidates exceed maximum Choice capacity of ${SITEMAP_MAX_ORDINARY_CANDIDATES}. First-N clipping is forbidden.`,
      ),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'candidate_limit_exceeded'),
    };
  }
  // No run ⇒ no transport: fail closed before any audit row or dispatch.
  if (!durableRunId) {
    return {
      ...emptyResult(
        'transport_failed',
        [...candidates, ...offDomain],
        'transport_failed',
        'transport_failed: sitemap selection requires a discovery-run binding — unbound attempts never transport.',
      ),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'transport_failed'),
    };
  }

  const ctx: ModelCallContext = {
    runId,
    snapshotHash,
    stage: null,
    operation: SITEMAP_SELECTION_OPERATION,
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[SITEMAP_SELECTION_OPERATION],
    ruleVersion: RULE_VERSIONS[SITEMAP_SELECTION_OPERATION],
  };

  // Frozen-policy route resolution. Null policy ⇒ explicit-disabled semantics:
  // deterministic retrieval only, no transport, no chat fallback.
  let routed: SitemapSelectionRouteOk;
  try {
    const r: SitemapSelectionRouteOk | SitemapSelectionRouteFailed | { kind: 'unavailable'; reason: string } =
      resolveRoute(input.modelPolicy ?? null, SITEMAP_SELECTION_OPERATION);
    if (r.kind === 'unavailable') {
      const promptHash = hashCanonicalJson({ unavailable: SITEMAP_SELECTION_OPERATION });
      const row = terminalAuditRow({
        runId, ctx,
        route: { provider: null, model: null, locality: null },
        effectivePolicyDigest: '',
        promptHash,
        status: 'unavailable',
        errorMessage: r.reason,
        typedResultMetadata: { questionId: SITEMAP_SELECTION_QUESTION_ID, abstentionCode: 'provider_disabled' },
      });
      if (durableRunId) {
        row.id = insertDiscoveryModelCallTerminal({
          runId: durableRunId,
          operation: SITEMAP_SELECTION_OPERATION,
          attempt: ctx.attempt,
          provider: null,
          model: null,
          locality: null,
          snapshotHash,
          modelPolicyDigest: '',
          promptTemplateVersion: ctx.promptTemplateVersion,
          ruleVersion: ctx.ruleVersion,
          promptHash,
          status: 'unavailable',
          errorMessage: r.reason,
          typedResultMetadata: { questionId: SITEMAP_SELECTION_QUESTION_ID, abstentionCode: 'provider_disabled' },
        });
      }
      return {
        ...emptyResult('provider_disabled', [...candidates, ...offDomain], 'provider_disabled', r.reason, [row]),
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'provider_disabled'),
      };
    }
    if (r.kind !== 'ok') {
      // The `unavailable` kind returns above; any other non-ok union member
      // is a route failure that carries its own terminal result.
      const failed = r as SitemapSelectionRouteFailed;
      return failed.result;
    }
    routed = r;
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) {
      assertHeld?.();
      const promptHash = hashCanonicalJson({ denied: SITEMAP_SELECTION_OPERATION });
      const row = terminalAuditRow({
        runId, ctx,
        route: { provider: err.provider ?? null, model: null, locality: null },
        effectivePolicyDigest: (asEffectivePolicyView(input.modelPolicy)?.policyDigest) ?? '',
        promptHash,
        status: 'policy_denied',
        errorMessage: err.message,
        typedResultMetadata: { questionId: SITEMAP_SELECTION_QUESTION_ID, abstentionCode: 'policy_denied' },
      });
      if (durableRunId) {
        row.id = insertDiscoveryModelCallTerminal({
          runId: durableRunId,
          operation: SITEMAP_SELECTION_OPERATION,
          attempt: ctx.attempt,
          provider: err.provider ?? null,
          model: null,
          locality: null,
          snapshotHash,
          modelPolicyDigest: (asEffectivePolicyView(input.modelPolicy)?.policyDigest) ?? '',
          promptTemplateVersion: ctx.promptTemplateVersion,
          ruleVersion: ctx.ruleVersion,
          promptHash,
          status: 'policy_denied',
          errorMessage: err.message,
          typedResultMetadata: { questionId: SITEMAP_SELECTION_QUESTION_ID, abstentionCode: 'policy_denied' },
        });
      }
      return {
        ...emptyResult('provider_disabled', [...candidates, ...offDomain], 'policy_denied', `Model policy denied: ${err.message}`, [row]),
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'policy_denied'),
      };
    }
    throw err;
  }

  const { route, jevConn, effectivePolicy } = routed;
  assertModelPolicyIntact(effectivePolicy);

  const questionPlan = buildSitemapSelectionQuestion(candidates);
  const state = buildSitemapSelectionState(meta, candidates);
  const request = {
    model: route.model || TYPESAFE_EVALUATED_MODEL,
    state,
    questions: {
      [questionPlan.questionId]: {
        type: 'choice' as const,
        instructions: questionPlan.instructions,
        criteria: questionPlan.criteria,
      },
    },
  };

  // Guard the ownership lease before the audit start row: a superseded
  // worker never opens audit provenance for a stale owner. A rejected
  // assertion throws `HeartbeatLostError` (provider_disabled downstream).
  try {
    assertHeld?.();
  } catch (err) {
    const row = terminalAuditRow({
      runId, ctx,
      route: { provider: route.provider, model: route.model, locality: route.locality },
      effectivePolicyDigest: effectivePolicy.policyDigest,
      promptHash: hashCanonicalJson({ denied: SITEMAP_SELECTION_OPERATION }),
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      typedResultMetadata: { questionId: SITEMAP_SELECTION_QUESTION_ID, abstentionCode: 'provider_disabled' },
    });
    if (durableRunId) {
      row.id = insertDiscoveryModelCallTerminal({
        runId: durableRunId,
        operation: SITEMAP_SELECTION_OPERATION,
        attempt: ctx.attempt,
        provider: route.provider,
        model: route.model,
        locality: route.locality,
        snapshotHash,
        modelPolicyDigest: effectivePolicy.policyDigest,
        promptTemplateVersion: ctx.promptTemplateVersion,
        ruleVersion: ctx.ruleVersion,
        promptHash: hashCanonicalJson({ denied: SITEMAP_SELECTION_OPERATION }),
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        typedResultMetadata: { questionId: SITEMAP_SELECTION_QUESTION_ID, abstentionCode: 'provider_disabled' },
      });
    }
    return {
      ...emptyResult('provider_disabled', [...candidates, ...offDomain], 'provider_disabled',
        `provider_disabled: sitemap-selection ownership lost before dispatch: ${err instanceof Error ? err.message : String(err)}`, [row]),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, 'provider_disabled'),
    };
  }
  const promptHash = hashCanonicalJson(request);
  const startRow = auditRow({
    runId, ctx,
    route: { provider: route.provider, model: route.model, locality: route.locality },
    effectivePolicyDigest: effectivePolicy.policyDigest,
    promptHash,
    status: 'started',
  });
  let callId: string | null = null;
  if (durableRunId) {
    callId = insertDiscoveryModelCallStart({
      runId: durableRunId,
      operation: SITEMAP_SELECTION_OPERATION,
      attempt: ctx.attempt,
      provider: route.provider,
      model: route.model,
      locality: route.locality,
      snapshotHash,
      modelPolicyDigest: effectivePolicy.policyDigest,
      promptTemplateVersion: ctx.promptTemplateVersion,
      ruleVersion: ctx.ruleVersion,
      promptHash,
    });
    startRow.id = callId;
  }

  const startedAt = Date.now();
  const failClosed = (outcome: SitemapSelectionOutcomeCode, code: string, reason: string): SitemapSelectionResult => {
    const endedAt = now();
    const durationMs = Date.now() - startedAt;
    const row = auditRow({
      runId, ctx,
      route: { provider: route.provider, model: route.model, locality: route.locality },
      effectivePolicyDigest: effectivePolicy.policyDigest,
      promptHash,
      resolvedModel: route.model,
      startedAt: startRow.startedAt,
      endedAt,
      durationMs,
      status: 'failed',
      errorMessage: reason,
      typedResultMetadata: { questionId: questionPlan.questionId, abstentionCode: code },
    });
    if (callId) {
      // One durable row per attempt: complete the start row (no second insert).
      completeDiscoveryModelCall(callId, {
        status: 'failed',
        endedAt,
        durationMs,
        errorMessage: reason,
        resolvedModel: route.model,
        typedResultMetadata: { questionId: questionPlan.questionId, abstentionCode: code },
      });
      row.id = callId;
    }
    return {
      ...emptyResult(outcome, candidates, code, reason, [startRow, row]),
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, null, null, code),
    };
  };

  let dispatchResult: SystemOneDispatchResult;
  try {
    assertHeld?.();
    assertSystemOneModelPin(request.model, jevConn.id);
    assertConnectionEnabledForDispatch(jevConn, request.model);
    dispatchResult = await dispatchSystemOne(
      jevConn,
      request,
      protectedSystemOneDispatchOptions(jevConn, request.model, assertHeld),
    );
    assertHeld?.();
    assertSystemOneModelMatch(request.model, dispatchResult.returnedModel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // terminal state — complete it as failed (ownership_lost) and rethrow
    // so the stale worker stops. The selection is discarded; only the
    // terminal audit survives.
    if (err instanceof Error && /Heartbeat|heartbeat|lease lost|claim lost/i.test(err.message)) {
      if (callId) {
        completeDiscoveryModelCall(callId, {
          status: 'failed',
          endedAt: now(),
          durationMs: Date.now() - startedAt,
          errorMessage: `ownership_lost: ${err.message}`,
        });
      }
      throw err;
    }
    // A Choice the transport rejects (unknown option, incomplete
    // distribution, question mismatch — never transport at all) is a
    // malformed answer, not a silent non-selection: it fails closed as
    // correlation_invalid with the transport's wording preserved, and safe
    // candidates are retained either way.
    if (/unknown option|incomplete Choice distribution|do not match the request|Type mismatches|argmax|non-finite or out-of-range/i.test(message)) {
      return failClosed('correlation_invalid', 'correlation_invalid',
        `correlation_invalid: TypeSafe answer could not be correlated to the sitemap-selection question: ${message}`);
    }
    // Live disablement surfaces as provider_disabled; every other failure
    // (timeout, 5xx, budget) is transport_failed. Neither can become a
    // selection — safe candidates are retained either way.
    const disabled = /disabled|unavailable|ownership/i.test(message);
    const outcome: SitemapSelectionOutcomeCode = disabled ? 'provider_disabled' : 'transport_failed';
    return failClosed(outcome, outcome, `${outcome}: TypeSafe sitemap-selection dispatch failed: ${message}`);
  }

  // Interpret the answer. Correlation-invalid, unknown-key, and out-of-set
  // answers fail closed with safe-candidate retention — never substring
  // parsing, never persistence of an unlisted URL.
  try {
    const answer = requireChoiceAnswer(dispatchResult.answers, questionPlan.questionId);
    const choiceKey = answer.choice;
    const selectedProbability = answer.probabilities[choiceKey] ?? 0;
    const vendorConfidence = answer.confidence;
    const candidateProbabilities: Record<string, number> = {};
    const answerProbabilities: Record<string, unknown> = answer.probabilities;
    for (const c of candidates) {
      const keyProb: unknown = answerProbabilities[c.id];
      if (typeof keyProb === 'number') candidateProbabilities[c.url] = keyProb;
    }
    // Full distribution (criterion-id keyed, abstention keys included) for
    // calibration analysis — candidateProbabilities above is the
    // URL-keyed candidate subset.
    const fullDistribution: Record<string, number> = {};
    for (const [key, value] of Object.entries(answerProbabilities)) {
      if (typeof value === 'number') fullDistribution[key] = value;
    }
    const endRow = (input: {
      status: 'success' | 'failed';
      errorMessage?: string | null;
      typedResultMetadata?: Record<string, unknown> | null;
    }): SitemapSelectionAuditRow => {
      const row = auditRow({
        runId, ctx,
        route: { provider: route.provider, model: route.model, locality: route.locality },
        effectivePolicyDigest: effectivePolicy.policyDigest,
        promptHash,
        resolvedModel: dispatchResult.returnedModel,
        promptTokens: dispatchResult.usage.inputTokens,
        completionTokens: dispatchResult.usage.outputTokens,
        startedAt: startRow.startedAt,
        endedAt: now(),
        durationMs: Date.now() - startedAt,
        status: input.status,
        errorMessage: input.errorMessage,
        typedResultMetadata: input.typedResultMetadata,
      });
      if (callId) {
        // One durable row per attempt: complete the start row with real usage/duration.
        const terminalEndedAt = row.endedAt ?? now();
        completeDiscoveryModelCall(callId, {
          status: input.status,
          endedAt: terminalEndedAt,
          durationMs: row.durationMs,
          promptTokens: dispatchResult.usage.inputTokens,
          completionTokens: dispatchResult.usage.outputTokens,
          errorMessage: input.errorMessage ?? null,
          resolvedModel: dispatchResult.returnedModel,
          typedResultMetadata: input.typedResultMetadata ?? null,
        });
        row.id = callId;
      }
      return row;
    };
    const isCandidateKey = candidates.some(c => c.id === choiceKey);
    const knownCriterion = choiceKey === SITEMAP_NO_MATCH_KEY
      || choiceKey === SITEMAP_INSUFFICIENT_EVIDENCE_KEY
      || isCandidateKey;
    if (!knownCriterion) {
      // Unknown key (not a candidate, not a known abstention).
      assertHeld?.();
      const row = endRow({
        status: 'failed',
        errorMessage: `Selected choice key "${choiceKey}" is not a known candidate or abstention.`,
        typedResultMetadata: {
          questionId: questionPlan.questionId,
          choice: choiceKey,
          abstentionCode: 'unknown_option_key',
        },
      });
      return {
        ...emptyResult('unknown_option_key', [...candidates, ...offDomain], 'unknown_option_key',
          `unknown_option_key: Selected choice key "${choiceKey}" could not be mapped to a known candidate or abstention.`, [startRow, row]),
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        candidateProbabilities,
        fullDistribution,
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, selectedProbability, vendorConfidence, 'unknown_option_key'),
      };
    }

    if (choiceKey === SITEMAP_NO_MATCH_KEY) {
      assertHeld?.();
      const row = endRow({
        status: 'success',
        typedResultMetadata: {
          questionId: questionPlan.questionId,
          choice: choiceKey,
          abstentionCode: 'no_match',
          selectedProbability,
          vendorConfidence,
          basis: 'choice_probability',
        },
      });
      return {
        ...emptyResult('no_match', [...candidates, ...offDomain], 'no_match',
          'no_match: No supplied candidate is the exact official product page.', [startRow, row]),
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        candidateProbabilities,
        fullDistribution,
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, selectedProbability, vendorConfidence, 'no_match'),
      };
    }

    if (choiceKey === SITEMAP_INSUFFICIENT_EVIDENCE_KEY) {
      assertHeld?.();
      const row = endRow({
        status: 'success',
        typedResultMetadata: {
          questionId: questionPlan.questionId,
          choice: choiceKey,
          abstentionCode: 'insufficient_evidence',
          selectedProbability,
          vendorConfidence,
          basis: 'choice_probability',
        },
      });
      return {
        ...emptyResult('insufficient_evidence', [...candidates, ...offDomain], 'insufficient_evidence',
          'insufficient_evidence: Product evidence is insufficient to determine the exact official page.', [startRow, row]),
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        candidateProbabilities,
        fullDistribution,
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, selectedProbability, vendorConfidence, 'insufficient_evidence'),
      };
    }

    // Candidate key: ID→URL mapping only. A key that is neither a supplied
    // candidate ID nor a known abstention is an out-of-set answer.
    const chosen = candidates.find(c => c.id === choiceKey);
    if (!chosen) {
      assertHeld?.();
      const row = endRow({
        status: 'failed',
        errorMessage: `Selected choice key "${choiceKey}" is outside the supplied candidate set.`,
        typedResultMetadata: {
          questionId: questionPlan.questionId,
          choice: choiceKey,
          abstentionCode: 'out_of_set_answer',
        },
      });
      return {
        ...emptyResult('out_of_set_answer', [...candidates, ...offDomain], 'out_of_set_answer',
          `out_of_set_answer: Selected choice key "${choiceKey}" is outside the supplied candidate set — no URL persisted.`, [startRow, row]),
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        candidateProbabilities,
        fullDistribution,
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, selectedProbability, vendorConfidence, 'out_of_set_answer'),
      };
    }

    // Low-confidence choice is an unresolved outcome, not a selection.
    if (selectedProbability < SITEMAP_SINGLE_CHOICE_MIN_PROBABILITY) {
      assertHeld?.();
      const row = endRow({
        status: 'success',
        typedResultMetadata: {
          questionId: questionPlan.questionId,
          choice: choiceKey,
          abstentionCode: 'low_model_probability',
          selectedProbability,
          vendorConfidence,
          basis: 'choice_probability',
        },
      });
      return {
        ...emptyResult('low_model_probability', [...candidates, ...offDomain], 'insufficient_evidence',
          `insufficient_evidence: Selected candidate probability ${selectedProbability.toFixed(3)} is below required threshold ${SITEMAP_SINGLE_CHOICE_MIN_PROBABILITY.toFixed(2)}.`, [startRow, row]),
        outcome: 'low_model_probability',
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        candidateProbabilities,
        fullDistribution,
        derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, selectedProbability, vendorConfidence, 'insufficient_evidence'),
      };
    }

    assertHeld?.();
    const row = endRow({
      status: 'success',
      typedResultMetadata: {
        questionId: questionPlan.questionId,
        choice: choiceKey,
        canonicalId: chosen.id,
        resolvedId: chosen.id,
        selectedProbability,
        vendorConfidence,
        basis: 'choice_probability',
      },
    });
    return {
      outcome: 'selected',
      selectedUrl: chosen.url,
      selectedCandidateId: chosen.id,
      retrievalRank: chosen.retrievalRank,
      selectedProbability,
      vendorConfidence,
      probabilityBasis: 'choice_probability',
      candidateProbabilities,
      fullDistribution,
      safeCandidates: [...candidates, ...offDomain],
      modelCallIds: [row.id],
      selectionAudit: [startRow, row],
      abstentionCode: null,
      abstentionReason: null,
      derivation: buildChoiceJudgmentDerivation(SITEMAP_SELECTION_QUESTION_ID, selectedProbability, vendorConfidence),
    };
  } catch (err) {
    // Same guarantee on the interpret path: post-response ownership loss
    // terminalizes the started row (ownership_lost) and rethrows — the
    // answer is never trusted past a lost lease.
    if (err instanceof Error && /Heartbeat|heartbeat|lease lost|claim lost/i.test(err.message)) {
      if (callId) {
        completeDiscoveryModelCall(callId, {
          status: 'failed',
          endedAt: now(),
          durationMs: Date.now() - startedAt,
          errorMessage: `ownership_lost: ${err.message}`,
        });
      }
      throw err;
    }
    // requireChoiceAnswer correlation failures (missing/extra answers) and
    // any other interpretation failure: correlation_invalid, no persistence.
    const message = err instanceof Error ? err.message : String(err);
    return failClosed('correlation_invalid', 'correlation_invalid',
      `correlation_invalid: TypeSafe answer could not be correlated to the sitemap-selection question: ${message}`);
  }
}

/** Re-exported bounds for observability/tests (mirrors the transport caps). */
export const SITEMAP_SELECTION_BOUNDS = {
  maxQuestions: SYSTEMONE_MAX_QUESTIONS,
  maxChoiceOptions: SYSTEMONE_MAX_CHOICE_OPTIONS,
  maxStateBytes: SYSTEMONE_MAX_STATE_BYTES,
  evaluatedModel: TYPESAFE_EVALUATED_MODEL,
} as const;
