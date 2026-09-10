import { callLlmForTask } from '../../onboarding/llm-client';
import { generateProductFieldAuditReport } from './catalog-insight-service';
import { findExactSkusWithFieldValue, type CatalogProposal } from './product-field-refactor-service';
import { replaceAiProposalsForField } from '../../db/repositories/catalog-health-proposal-repo';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import {
  validateAiProposalResponse,
  type AiProposalDiagnostic,
  type AiProposalErrorCode,
} from './ai-proposal-validator';

/**
 * Thrown when the requested field is not a valid, registered, editable
 * ProductField. Carries a stable code for the route to map to a 4xx.
 */
export class ProposalFieldScopeError extends Error {
  constructor(
    readonly code: 'invalid_field_pattern' | 'unknown_field' | 'non_editable_field',
    message: string,
  ) {
    super(message);
    this.name = 'ProposalFieldScopeError';
  }
}

/**
 * Thrown when the AI response fails structural validation. Persist nothing;
 * prior proposals are preserved. Diagnostics are redacted and bounded.
 */
export class AiProposalValidationError extends Error {
  constructor(
    readonly diagnostics: AiProposalDiagnostic[],
    readonly errorCode: AiProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiProposalValidationError';
  }
}

/**
 * Validate the field by pattern and against the workspace field registry;
 * require editable ProductField scope before any model call or mutation.
 */
export function resolveProposalFieldScope(workspaceId: string, field: string): void {
  if (!/^ProductField\d+$/.test(field)) {
    throw new ProposalFieldScopeError(
      'invalid_field_pattern',
      `Invalid custom field name "${field}". Field must match ^ProductField\\d+$`,
    );
  }
  const registry = listRegistry(workspaceId);
  const entry = registry.find((r) => r.xmlField === field);
  if (!entry) {
    throw new ProposalFieldScopeError(
      'unknown_field',
      `Field "${field}" is not registered in this workspace's field registry.`,
    );
  }
  if (!entry.editable) {
    throw new ProposalFieldScopeError(
      'non_editable_field',
      `Field "${field}" is not editable; AI proposals cannot be generated for it.`,
    );
  }
}

export interface GenerateAiProposalsResult {
  /** Persisted proposal rows (source 'ai', status 'proposed'). */
  proposals: CatalogProposal[];
  /** Bounded per-candidate report (accepted kind/staging + rejections). */
  diagnostics: AiProposalDiagnostic[];
}

export interface GenerateAiProposalsDeps {
  /**
   * Injectable model caller for deterministic tests (fake responses only).
   * Defaults to the general `callLlmForTask('product_field_refactor', ...)`
   * path, which audits through `ai_model_calls` with the real workspace id.
   */
  callLlm?: (prompt: string, systemPrompt: string) => Promise<string | null>;
}

/**
 * Generate AI-assisted suggestions for a ProductField and store them as proposals.
 *
 * Flow (epic #42, #39):
 *   1. Field scope validation (pattern + registry + editable) before any work.
 *   2. Audit snapshot BEFORE the model call provides the exact observed-value
 *      membership set used to validate `oldValue`.
 *   3. Strict JSON requested from the model; the response is parsed and
 *      validated server-side (structural failures are all-or-nothing).
 *   4. Accepted candidates get server-derived affected SKUs (never model SKU
 *      lists) and are persisted in ONE transaction that replaces only prior
 *      AI `proposed` rows for this workspace/field.
 *
 * NOTE: the current `callLlmForTask` client has no structured-output
 * transport, so JSON mode is always used and server-side validation is the
 * enforcement boundary (AI SDK structured output arrives with the #40
 * executor).
 */
export async function generateAiProposals(
  workspaceId: string,
  field: string,
  deps: GenerateAiProposalsDeps = {},
): Promise<GenerateAiProposalsResult> {
  // 1. Field scope (pattern + registered + editable).
  resolveProposalFieldScope(workspaceId, field);

  // 2. Snapshot audit evidence BEFORE the model call.
  const report = generateProductFieldAuditReport(workspaceId, field);
  const observedValues = new Set(report.values.map((v) => v.value));
  
  // Prepare a clean list of values for the prompt
  // Sort values: suspicious ones first, then lower frequency ones
  const valuesForPrompt = report.values.map(v => {
    const isSuspicious = report.suspiciousValues.some(sv => sv.value === v.value);
    const suspiciousReasons = report.suspiciousValues.find(sv => sv.value === v.value)?.reasons || [];
    return {
      value: v.value,
      frequency: v.frequency,
      isSuspicious,
      suspiciousReasons,
    };
  });

  // Limit value count to avoid huge context window issues
  const truncatedValues = valuesForPrompt.slice(0, 100);

  const systemPrompt = `You are a professional ecommerce catalog data architect and the Bay State CMS Store Manager AI Assistant.
Your task is to analyze product attribute values, identify formatting issues, casing duplicates, typos, taxonomy drift, and semantic duplicates, and suggest canonical replacements.
Return ONLY valid JSON matching this schema:
{
  "proposals": [
    {
      "oldValue": "existing value in catalog",
      "newValue": "suggested canonical value",
      "reason": "explanation of change (e.g. 'casing normalization', 'semantic grouping of Feline/Cat', 'typo correction')",
      "confidence": 0.95
    }
  ]
}`;

  const prompt = `Analyze the custom field "${field}" (labeled "${report.label}") in our store catalog.
Here is the list of unique values (up to 100 values, showing frequencies and any system-flagged issues):
${JSON.stringify(truncatedValues, null, 2)}

Provide renaming suggestions for formatting, casing, spelling corrections, or category consolidation. 
DO NOT propose changes where the oldValue and newValue are identical. 
Confidence should be a decimal between 0.1 and 0.99 (depending on how sure you are).`;

  const callModel =
    deps.callLlm ??
    ((prompt: string, systemPrompt: string) =>
      callLlmForTask('product_field_refactor', prompt, systemPrompt, {
        allowFallback: true,
        // Real workspace identity so the general callLlmForTask path creates
        // and terminalizes an ai_model_calls row for this workspace (epic
        // #42, #37).
        workspaceId,
      }));

  const response = await callModel(prompt, systemPrompt);

  if (!response) {
    throw new Error('No response from AI model config.');
  }

  // 3. Parse + validate the WHOLE response before any mutation.
  const outcome = validateAiProposalResponse(response, {
    workspaceId,
    field,
    observedValues,
    fieldRegistered: true, // verified above
    fieldEditable: true, // verified above
    source: 'ai',
  });
  if (!outcome.ok) {
    // Structural failure: persist nothing, keep prior proposals.
    throw new AiProposalValidationError(
      outcome.diagnostics,
      outcome.code,
      `AI proposal response rejected (${outcome.code}); no proposals were persisted.`,
    );
  }

  // 4. Compute affected SKUs server-side from the current workspace product
  //    index using EXACT value matching (oldValue was already required to
  //    exactly match an observed value). Candidates with no affected products
  //    are safe-skipped, matching the legacy behavior. normalizationKind/
  //    safeToStage are diagnostic-only (no DB column).
  const accepted = outcome.candidates
    .map((candidate) => ({
      oldValue: candidate.oldValue,
      newValue: candidate.newValue,
      reason: candidate.reason,
      confidence: candidate.confidence,
      affectedSkus: findExactSkusWithFieldValue(field, candidate.oldValue),
    }))
    .filter((c) => c.affectedSkus.length > 0);

  // 5. ONE transaction: replace prior AI proposed rows + insert accepted
  //    candidates. Any throw rolls back; prior proposals are preserved.
  const proposals = replaceAiProposalsForField(workspaceId, field, accepted);
  return { proposals, diagnostics: outcome.diagnostics };
}
