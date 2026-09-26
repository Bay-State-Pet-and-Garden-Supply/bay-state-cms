/**
 * Shared LLM fallback ranker for curation target proposals.
 *
 * When deterministic matching (keyword scoring, alias resolution) produces
 * no confident results, the ranker makes a single candidate-constrained
 * LLM call to pick the best option(s) from the allowed set.
 *
 * The LLM prompt is constrained so the model can only return exact values
 * from the supplied option list — no hallucination of new options.
 *
 * Uses `category_classification` task routing for all target kinds
 * to avoid widening task-routing scope in this refactor.
 */
import { getLlmConfigForTask, callLlmForTaskWithProvenance, defaultProtectedOperationForTask } from '../onboarding/llm-client';
import type { LlmTask } from '../db/repositories/llm-task-config-repo';
import {
  ModelPolicyDeniedError,
  redactTransportText,
  type ModelPolicyView,
  type ProtectedOperation,
} from './model-policy-gateway';
import type { ModelCallContext } from './model-operation-registry';
import { MODEL_CALL_STATUS } from './model-operation-registry';
import { recordTerminalPreflight } from '../db/repositories/classification-model-call-repo';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { HeartbeatLostError } from './heartbeat-errors';

/**
 * Ungrounded model picks below this confidence are abstentions, never
 * proposals: the ranker only runs after deterministic keyword matching
 * failed, so a low-confidence guess has no evidence behind it (epic #46
 * review round — "Poultry Feed" for a beehive feeder at the 0.35 floor).
 */
export const LLM_PROPOSE_MIN_CONFIDENCE = 0.5;

/**
 * Minimum spread between the top-ranked candidate and the runner-up for an
 * ungrounded model pick to be proposed (epic #46 review round, Package C).
 * When the model returns per-candidate scores and the top is barely ahead
 * of the second option, the "winner" is noise — abstain instead. Absent
 * scores skip this gate entirely.
 */
export const LLM_PROPOSE_MARGIN_MIN = 0.1;

export interface LlmRankOptionsParams {
  /** Human-readable label for the target kind (e.g. "product type", "flavor", "category page") */
  targetLabel: string;
  /** Allowed option values (strings the LLM may choose from) */
  options: Array<{ value: string; label: string }>;
  /** Single or multiple selection */
  selectionMode: 'single' | 'multiple';
  /** Normalized evidence text for context */
  evidenceText: string;
  /** Max values to select (default: 1 for single, 5 for multiple) */
  maxValues?: number;
  /**
   * LLM task name for configuration routing.
   * Defaults to 'category_classification' for backward compatibility.
   * When set, uses the specific task config for model/provider selection.
   */
  task?: string;
  /**
   * Frozen classification model-policy view (issue #17 item A). Required for
   * protected ranking operations; missing policy denies the call.
   */
  modelPolicy?: ModelPolicyView | null;
  /** Protected operation; defaults from the task name. */
  protectedOperation?: ProtectedOperation;
  /** Durable model-call audit context (issue #17 work item E). */
  modelCall?: ModelCallContext | null;
  /** Runtime snapshot the call is bound to (plan compatibility). */
  snapshot?: RuntimeClassificationSnapshot | null;
  /**
   * Optional ownership assertion injected by the cohort freeze executor (PR4
   * re-review fix, P1-1). When present, the ranker invokes it IMMEDIATELY
   * BEFORE every durable terminal-preflight row and immediately BEFORE and
   * AFTER every awaited transport call — a rejected assertion (the cohort
   * run's claim was lost to a reclaiming sibling) throws
   * `HeartbeatLostError` and the ranker aborts with NO further side effects
   * (no preflight rows, no retry, no returned values). The seam is also
   * threaded into the audited transport (`callLlmForTaskWithProvenance`,
   * src/onboarding/llm-client.ts) via the options object, so the transport
   * re-asserts ownership immediately before its `started` model-call row
   * insert and before every terminal `classification_model_calls` update —
   * a stale owner never begins new audit provenance and never terminalizes
   * an in-flight row. Absent in legacy/non-cohort invocations — zero
   * behavior change.
   */
  assertHeld?: () => void;
}

export interface LlmRankResult {
  values: string[];
  confidence: number;
  /** Durable model-call IDs that produced this ranking (issue #17 E). */
  modelCallIds?: string[];
}

/**
 * Call the LLM to rank/choose from a constrained set of allowed options.
 *
 * Returns null when:
 * - No LLM config is available for 'category_classification'
 * - The LLM response cannot be parsed
 * - No valid option values are returned
 * - The evidence text is too short (< 8 chars)
 */
export async function llmRankOptions(params: LlmRankOptionsParams): Promise<LlmRankResult | null> {
  const { targetLabel, options, selectionMode, evidenceText, maxValues, assertHeld } = params;
  const taskName = params.task ?? 'category_classification';

  if (options.length === 0 || evidenceText.trim().length < 8) return null;

  let operation: ProtectedOperation | null;
  let llmConfig: import('../onboarding/llm-client').LlmConfig | null;
  try {
    operation =
      params.protectedOperation ??
      defaultProtectedOperationForTask(taskName as LlmTask);

    // Protected ranking operation with no frozen policy context: deterministic
    // abstain, but still observable — a durable `unavailable` terminal row so
    // the attempted call never silently disappears from provenance.
    if (operation && params.modelPolicy === undefined) {
      // Ownership assertion BEFORE the durable preflight row: a stale owner
      // must not write a terminal model-call row after the claim moved.
      assertHeld?.();
      recordTerminalPreflight(
        params.modelCall,
        '',
        MODEL_CALL_STATUS.unavailable,
        'No frozen model policy for protected ranking operation.',
      );
      return null;
    }

    llmConfig = getLlmConfigForTask(taskName as any, {
      allowFallback: true,
      modelPolicy: params.modelPolicy,
      ...(operation ? { protectedOperation: operation } : {}),
    });
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) {
      // Ownership assertion BEFORE the durable policy-denied row (a stale
      // owner must not write it); the denial itself is then recorded.
      assertHeld?.();
      recordTerminalPreflight(
        params.modelCall,
        params.modelPolicy?.policyDigest ?? '',
        MODEL_CALL_STATUS.policyDenied,
        `Model policy denied protected ranking operation (${err.code}).`,
      );
      if (params.modelPolicy === undefined) return null;
    }
    throw err;
  }
  if (!llmConfig) {
    // Ownership assertion BEFORE the durable `unavailable` row (a stale owner
    // must not write it).
    assertHeld?.();
    recordTerminalPreflight(
      params.modelCall,
      params.modelPolicy?.policyDigest ?? '',
      MODEL_CALL_STATUS.unavailable,
      'No LLM config available for the protected ranking operation.',
    );
    return null;
  }

  const maxVals = maxValues ?? (selectionMode === 'multiple' ? Math.min(5, options.length) : 1);
  const optionList = options.slice(0, 150).map(o => o.label);
  const selectionDesc = selectionMode === 'multiple' ? `up to ${maxVals}` : 'one';

  const prompt = `Choose ${selectionDesc} value(s) for the product field "${targetLabel}" from the allowed options only.

Allowed options:
${JSON.stringify(optionList)}

Product evidence:
${evidenceText.slice(0, 3000)}

Return ONLY valid JSON in this exact shape: {"values":["exact allowed option"],"scores":[0.0],"confidence":0.0}. The optional "scores" array (same order and length as values, 0..1, higher = better fit) helps us judge how much better the top pick is than the alternatives. If none fit, return {"values":[],"confidence":0}. Do not invent options.`;

  try {
    const auditedCall = params.modelCall
      ? { modelCall: params.modelCall, snapshot: params.snapshot }
      : {};
    // Ownership assertion IMMEDIATELY BEFORE the awaited transport call: a
    // stale owner must never START a new transport (no new side effects begin
    // after ownership loss).
    assertHeld?.();
    const response = await callLlmForTaskWithProvenance(
      taskName as any,
      prompt,
      'You are a strict catalog classifier. You only return exact values from the allowed options.',
      {
        allowFallback: true,
        modelPolicy: params.modelPolicy,
        ...(operation ? { protectedOperation: operation } : {}),
        ...auditedCall,
        // PR4 P1-1: thread the caller's ownership assertion INTO the audited
        // transport so it re-asserts before its own durable audit writes.
        assertHeld,
      },
    );
    // Ownership assertion IMMEDIATELY AFTER the transport returns and BEFORE
    // any further write/retry: a sibling reclaim mid-transport is caught
    // here (the transport itself is deliberately untouched).
    assertHeld?.();

    if (!response) return null;

    // Parse JSON response with repair for common formatting issues
    let parsed = parseRankerResponse(response.content);

    // Retry only when parsing failed. A valid empty values array is an
    // intentional abstention and must not be turned into an invented match.
    const influencingCallIds: string[] = [];
    if (response?.callId) influencingCallIds.push(response.callId);
    if (!parsed) {
      try {
        // The retry is a distinct attempt (the first response is embedded in
        // the retry prompt, so BOTH calls influenced the final proposal) and
        // must carry its own attempt number.
        const retryAttempt = (params.modelCall?.attempt ?? 0) + 1;
        const retryModelCall = params.modelCall
          ? { ...params.modelCall, attempt: retryAttempt }
          : undefined;
        // Ownership assertion before the retry transport (no new side effect
        // after ownership loss) and again after it returns (before the retry
        // output is accepted).
        assertHeld?.();
        const retryResponse = await callLlmForTaskWithProvenance(
          taskName as any,
          `The previous response was not valid JSON. Fix the JSON format:\n\n${response.content.slice(0, 1000)}\n\nReturn ONLY valid JSON in this exact shape: {"values":["exact allowed option"],"scores":[0.0],"confidence":0.0} (scores optional). If none fit, return {"values":[],"confidence":0}. Do not invent options.`,
          'You are a precise JSON fixer. Return only valid JSON matching the requested shape.',
          {
            allowFallback: true,
            modelPolicy: params.modelPolicy,
            ...(operation ? { protectedOperation: operation } : {}),
            ...(retryModelCall && params.snapshot
              ? { modelCall: retryModelCall, snapshot: params.snapshot }
              : {}),
            // PR4 P1-1: the retry transport re-asserts ownership before its
            // own durable audit writes exactly like the primary call.
            assertHeld,
          },
        );
        assertHeld?.();
        if (retryResponse) {
          parsed = parseRankerResponse(retryResponse.content);
          if (retryResponse.callId) influencingCallIds.push(retryResponse.callId);
        }
      } catch (err) {
        // Ownership loss during the retry is NEVER swallowed into an abstain.
        if (err instanceof HeartbeatLostError) throw err;
        // Retry also failed - fall through to null return below
      }
    }

    if (!parsed || !parsed.values || parsed.values.length === 0) return null;

    // Normalize returned values against allowed options
    const values = parsed.values
      .map((raw: unknown) => normalizeToOptions(raw, optionList))
      .filter((v: string | null): v is string => v != null)
      .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i) // deduplicate
      .slice(0, maxVals);

    if (values.length === 0) return null;

    const confidence = Math.max(0.35, Math.min(0.85, parsed.confidence ?? 0.55));
    // PR (epic #46 review round): a model pick with NO keyword grounding is
    // only proposed when the model's own confidence clears the propose gate
    // (0.5) AND the margin gate (Package C). This path is only reached when
    // deterministic keyword matching already failed, so the pick rests
    // entirely on the model's judgment — a weak guess (e.g. "Poultry Feed"
    // for a beehive feeder at the 0.35 floor) is noise, not a decision.
    // Below the gates the ranker abstains and the stage emits a reviewable
    // abstention with a clear reason instead of a garbage accept/reject row.
    // (The 0.35 floor remains the documented `abstainBelow` calibration;
    // these gates are stricter honesty rules for ungrounded model output.)
    if (confidence < LLM_PROPOSE_MIN_CONFIDENCE) return null;

    // Margin gate (Package C): when per-candidate scores came back, the top
    // raw score must lead the runner-up by a meaningful spread — otherwise
    // the pick is a coin flip. Computed over the RAW scores (the single-mode
    // slice would otherwise hide the runner-up). Malformed scores (wrong
    // length vs values, non-numeric entries) FAIL CLOSED to abstention — a
    // model that cannot report a reliable ranking signal gets no proposal
    // (review round 2, MEDIUM-3: fail-closed for ambiguous ranking output).
    if (Array.isArray(parsed.scores) && Array.isArray(parsed.values)) {
      const clamped = parsed.scores
        .map(s => (typeof s === 'number' ? Math.max(0, Math.min(1, s)) : null))
        .filter((s): s is number => s !== null);
      const scoresMalformed =
        parsed.scores.length !== parsed.values.length || clamped.length !== parsed.scores.length;
      if (scoresMalformed) return null;
      if (clamped.length >= 2) {
        const sorted = [...clamped].sort((a, b) => b - a);
        const margin = sorted[0] - sorted[1];
        if (margin < LLM_PROPOSE_MARGIN_MIN) return null;
      }
    }

    // Link EVERY call that influenced the accepted parse (the primary call and
    // any retry whose response was embedded in the accepted output).
    return { values, confidence, modelCallIds: influencingCallIds };
  } catch (err: any) {
    // Ownership-loss exceptions must NOT be converted into an 'LLM unavailable
    // -> abstain' outcome: a stale owner aborts with NO further side effects,
    // and the cohort freeze propagates the HeartbeatLostError.
    if (err instanceof HeartbeatLostError) throw err;
    console.warn(`[CurationTargetRanker] LLM ranking failed for "${targetLabel}": ${redactTransportText(err.message)}`);
    return null;
  }
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

interface RawRankerResponse {
  values?: unknown[];
  value?: unknown;
  pages?: unknown[];
  confidence?: number;
  /** Per-candidate scores aligned with values (0..1, higher = better fit). */
  scores?: unknown;
}

/**
 * Parse the LLM JSON response with tolerance for alternative response shapes.
 * Handles `{ values: [...] }`, `{ value: "..." }`, and `{ pages: [...] }` shapes.
 */
function parseRankerResponse(raw: string): RawRankerResponse | null {
  // Clean up common issues
  let cleaned = raw.trim();

  // Remove markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*|```\s*$/gi, '').trim();

  // Try to find JSON object in the response
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned) as RawRankerResponse;

    // Normalize various response shapes
    let values: unknown[] = [];

    if (Array.isArray(parsed.values)) {
      values = parsed.values;
    } else if (parsed.value !== undefined) {
      values = [parsed.value];
    } else if (Array.isArray(parsed.pages)) {
      values = parsed.pages;
    }

    return {
      values,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.55,
      scores: Array.isArray(parsed.scores)
        ? parsed.scores
            .map(s => (typeof s === 'number' ? Math.max(0, Math.min(1, s)) : null))
            .filter((s): s is number => s !== null)
        : undefined,
    };
  } catch {
    // Try to extract a value from free-text response
    return null;
  }
}

/**
 * Normalize a candidate value against the allowed options list (case-insensitive).
 */
function normalizeToOptions(candidate: unknown, options: string[]): string | null {
  const raw = String(candidate ?? '').trim();
  if (!raw) return null;
  return options.find(o => o.toLowerCase() === raw.toLowerCase()) ?? null;
}
