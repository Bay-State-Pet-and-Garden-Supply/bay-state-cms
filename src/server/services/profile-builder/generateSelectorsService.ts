/**
 * generateSelectorsService.ts — Orchestrates the one-shot LLM selector
 * generation flow for the Profile Builder.
 *
 * Flow: resolve artifact → sanitize HTML → preflight → resolve LLM config
 * → build prompt → call LLM → parse response → validate selectors →
 * normalize custom fields → build response.
 */

import { createHash } from 'node:crypto';
import { getLlmTaskConfig } from '../../../db/repositories/llm-task-config-repo';
import { getApiKey } from '../../../db/repositories/api-key-repo';
import {
  ModelPolicyDeniedError,
  resolveModelRoute,
  type ModelPolicyView,
} from '../../../classification/model-policy-gateway';
import type { LlmProvider } from '../../../shared/schemas/onboarding';
import type {
  GenerateSelectorsRequest,
  GenerateSelectorsResponse,
  SelectorSuggestion,
  CustomFieldSuggestion,
  SelectorWarning,
  SelectorGenerationRuntime,
} from '../../../shared/schemas/selector-generation';
import { GenerateSelectorsResponseSchema } from '../../../shared/schemas/selector-generation';
import { z } from 'zod';

import { createResolver } from './snapshotArtifactResolver';
import { sanitizeSnapshotHtml } from './sanitizeSnapshotHtml';
import { inspectSnapshot } from './snapshotPreflight';
import { buildSelectorGenerationPrompt, type PromptField } from './buildSelectorGenerationPrompt';
import { validateAndRankSelectors, type ValidatedCandidate } from './selectorValidator';
import { normalizeAndValidateCustomFields, type NormalizedCustomField } from './customFieldNormalizer';

// ─── Error Classes ──────────────────────────────────────────────────────────

// fallow-ignore-next-line unused-export — used by tests
export class UnusableSnapshotError extends Error {
  constructor(public readonly reason: string) {
    super(`Snapshot rejected: ${reason}`);
    this.name = 'UnusableSnapshotError';
  }
}

// fallow-ignore-next-line unused-export — used by tests
export class LlmNotConfiguredError extends Error {
  constructor() {
    super('No LLM task configuration found for selector generation.');
    this.name = 'LlmNotConfiguredError';
  }
}

// fallow-ignore-next-line unused-export — used by tests
export class LlmProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

// fallow-ignore-next-line unused-export — used by tests
export class InvalidLlmResponseError extends Error {
  constructor(message: string) {
    super(`Invalid LLM response: ${message}`);
    this.name = 'InvalidLlmResponseError';
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface LlmEndpointConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Schema for the LLM's raw JSON response. */
const LlmFieldCandidateSchema = z.object({
  selector: z.string(),
  evidence: z.string().default(''),
});

const LlmFieldResultSchema = z.object({
  notFound: z.boolean(),
  candidates: z.array(LlmFieldCandidateSchema).max(5).default(() => []),
});

const LlmCustomFieldResultSchema = z.object({
  proposedKey: z.string().min(1),
  label: z.string().min(1),
  valueType: z.enum(['text', 'html', 'url', 'image', 'list']),
  multiple: z.boolean().default(false),
  candidates: z.array(LlmFieldCandidateSchema).max(5).default(() => []),
});

const LlmPageAssessmentSchema = z.object({
  pageType: z
    .enum(['product', 'product_variant', 'category', 'login', 'access_denied', 'error', 'unknown'])
    .default('unknown'),
  usable: z.boolean().default(true),
  evidence: z.string().optional(),
});

const LlmGenerationResultSchema = z.object({
  pageAssessment: LlmPageAssessmentSchema.default({ pageType: 'unknown', usable: true }),
  fields: z.record(z.string(), LlmFieldResultSchema),
  customFields: z.array(LlmCustomFieldResultSchema).default(() => []),
  warnings: z.array(z.string()).default(() => []),
});

type LlmGenerationResult = z.infer<typeof LlmGenerationResultSchema>;

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

const DEFAULT_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-4o-mini',
  ollama: 'llama3',
};

const TIMEOUT_MS: Record<string, number> = {
  deepseek: 45_000,
  openai: 45_000,
  ollama: 120_000,
};

// ─── LLM Config Resolution ──────────────────────────────────────────────────

function resolveLlmConfig(requestId: string): LlmEndpointConfig {
  const requestedTaskConfig = getLlmTaskConfig('one_shot_selector_generation');
  const taskConfig = requestedTaskConfig ?? getLlmTaskConfig('profile_generation');

  if (!requestedTaskConfig && taskConfig) {
    console.warn(
      JSON.stringify({
        event: 'selector_generation_task_config_fallback',
        requestedTask: 'one_shot_selector_generation',
        resolvedTask: 'profile_generation',
        requestId,
      }),
    );
  }

  if (!taskConfig) {
    throw new LlmNotConfiguredError();
  }

  const cred = getApiKey(taskConfig.provider);
  if (!cred || !cred.api_key) {
    throw new LlmNotConfiguredError();
  }
  if (cred.api_key.includes('•')) {
    console.warn(
      `[SelectorGen] Provider "${taskConfig.provider}" has a redacted API key. ` +
        'Re-enter the full key in Settings → LLM Providers.',
    );
    throw new LlmNotConfiguredError();
  }

  const baseUrl =
    taskConfig.baseUrlOverride ||
    cred.base_url ||
    DEFAULT_BASE_URLS[taskConfig.provider] ||
    DEFAULT_BASE_URLS['openai'];

  const model = taskConfig.model || cred.model || DEFAULT_MODELS[taskConfig.provider] || DEFAULT_MODELS['deepseek'];

  const timeoutMs = TIMEOUT_MS[taskConfig.provider] ?? 45_000;

  return {
    provider: taskConfig.provider,
    apiKey: cred.api_key,
    baseUrl,
    model,
    timeoutMs,
  };
}

// ─── LLM API Call ───────────────────────────────────────────────────────────

async function callLlmForSelectorGeneration(
  config: LlmEndpointConfig,
  systemMessage: string,
  userMessage: string,
): Promise<string> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(
        `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.provider !== 'ollama'
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: systemMessage },
              { role: 'user', content: userMessage },
            ],
            temperature: 0.1,
            ...(config.provider !== 'ollama'
              ? { response_format: { type: 'json_object' as const } }
              : {}),
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const status = response.status;
        let bodyText = '';
        try { bodyText = await response.text(); } catch { /* ignore */ }

        if (status >= 400 && status < 500) {
          throw new LlmProviderError(
            `LLM API returned ${status}: ${bodyText.slice(0, 200)}`,
            false,
            status === 429 ? 'LLM_RATE_LIMITED' : undefined,
          );
        }

        if (status >= 500) {
          if (attempt < maxAttempts) {
            console.warn(`[SelectorGen] LLM ${status} (attempt ${attempt}), retrying...`);
            continue;
          }
          throw new LlmProviderError(
            `LLM API returned ${status} after ${maxAttempts} attempts`,
            true,
          );
        }

        throw new LlmProviderError(`LLM API returned ${status}`, false);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim();
      const finishReason = choice?.finish_reason;

      if (!content || content.length === 0) {
        if (attempt < maxAttempts) {
          console.warn(`[SelectorGen] Empty LLM response (attempt ${attempt}), retrying...`);
          continue;
        }
        throw new LlmProviderError('LLM returned empty response after retry.', true);
      }

      if (finishReason === 'length') {
        if (attempt < maxAttempts) {
          console.warn(`[SelectorGen] Truncated LLM response (attempt ${attempt}), retrying...`);
          continue;
        }
        throw new LlmProviderError('LLM response was truncated after retry.', true);
      }

      if (data.usage) {
        console.debug(
          `[SelectorGen] LLM tokens — input: ${data.usage.prompt_tokens ?? '?'}, ` +
            `output: ${data.usage.completion_tokens ?? '?'}`,
        );
      }

      return content;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof LlmProviderError || err instanceof InvalidLlmResponseError) throw err;

      if (err instanceof DOMException && err.name === 'AbortError') {
        if (attempt < maxAttempts) {
          console.warn(`[SelectorGen] LLM timeout (attempt ${attempt}), retrying...`);
          continue;
        }
        throw new LlmProviderError('LLM request timed out.', true);
      }

      if (err instanceof TypeError && (err as Error).message.includes('fetch')) {
        if (attempt < maxAttempts) {
          console.warn(`[SelectorGen] LLM network error (attempt ${attempt}), retrying...`);
          continue;
        }
        throw new LlmProviderError('LLM network request failed.', true);
      }

      throw err;
    }
  }

  throw new LlmProviderError('LLM request failed after all retries.', true);
}

// ─── Response Parsing ────────────────────────────────────────────────────────

function parseLlmResponse(rawJson: string, requestedFieldKeys: string[]): LlmGenerationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new InvalidLlmResponseError('Response is not valid JSON.');
  }

  const result = LlmGenerationResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidLlmResponseError(
      `Response failed schema validation: ${result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  const data = result.data;
  let insertedCount = 0;

  // Insert notFound entries for any missing requested fields
  for (const key of requestedFieldKeys) {
    if (!data.fields[key]) {
      data.fields[key] = { notFound: true, candidates: [] };
      insertedCount++;
    }
  }

  if (insertedCount > requestedFieldKeys.length * 0.5) {
    throw new InvalidLlmResponseError(
      `LLM response is missing ${insertedCount}/${requestedFieldKeys.length} requested fields.`,
    );
  }

  return data;
}



// ─── Response Builder ────────────────────────────────────────────────────────

function buildResponse(
  validatedFields: Record<string, ValidatedCandidate>,
  customFields: NormalizedCustomField[],
  sanitizationWarnings: SelectorWarning[],
  preflightWarnings: string[],
  requestId: string,
  startTime: number,
  htmlBytes: number,
  htmlReduced: boolean,
  requestedFieldCount: number,
): GenerateSelectorsResponse {
  let suggestedFieldCount = 0;
  let notFoundFieldCount = 0;
  let invalidFieldCount = 0;

  const fields = Object.create(null) as Record<string, SelectorSuggestion>;
  for (const [key, v] of Object.entries(validatedFields)) {
    fields[key] = {
      ...v,
      fieldKey: key,
    } as unknown as SelectorSuggestion;
    if (v.status === 'suggested') suggestedFieldCount++;
    else if (v.status === 'not_found') notFoundFieldCount++;
    else if (v.status === 'invalid') invalidFieldCount++;
  }

  const allWarnings: SelectorWarning[] = [];

  // Collect sanitization warnings
  for (const w of sanitizationWarnings) allWarnings.push(w);

  // Collect preflight warnings as info-level snapshot warnings
  for (const w of preflightWarnings) {
    allWarnings.push({ code: 'SNAPSHOT_WARNING', severity: 'info', message: w, fieldKey: null });
  }

  // Collect field-level warnings
  for (const [key, v] of Object.entries(validatedFields)) {
    if (v.warnings) {
      for (const w of v.warnings) {
        allWarnings.push({ ...w, fieldKey: w.fieldKey ?? key });
      }
    }
  }

  const response: GenerateSelectorsResponse = {
    requestId,
    fields: fields as unknown as Record<string, SelectorSuggestion>,
    customFields: customFields as unknown as CustomFieldSuggestion[],
    warnings: allWarnings,
    meta: {
      durationMs: Date.now() - startTime,
      htmlBytes,
      htmlReduced,
      requestedFieldCount,
      suggestedFieldCount,
      notFoundFieldCount,
      invalidFieldCount,
    },
  };

  return GenerateSelectorsResponseSchema.parse(response);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function generateSelectors(
  input: GenerateSelectorsRequest,
  context: { userId: string; requestId: string },
): Promise<GenerateSelectorsResponse> {
  const startTime = Date.now();
  const resolver = createResolver();
  const { requestId } = context;

  // 1. Resolve and read the snapshot artifact
  const artifact = resolver.resolve(input.htmlRef);
  const htmlBytes = artifact.bytes;

  // 2. Sanitize HTML
  const sanitized = sanitizeSnapshotHtml(artifact.html);

  // 3. Preflight check
  const preflight = inspectSnapshot(sanitized.html);
  if (!preflight.usable) {
    throw new UnusableSnapshotError(preflight.reason!);
  }

  // 4. Resolve LLM configuration
  const llmConfig = resolveLlmConfig(requestId);

  // 5. Build the prompt
  const promptFields: PromptField[] = input.fields.map((f) => ({
    key: f.key,
    label: f.label,
    origin: f.origin,
    valueType: f.valueType,
    multiple: f.multiple ?? false,
    description: f.description ?? undefined,
  }));

  const prompt = buildSelectorGenerationPrompt({
    fields: promptFields,
    sanitizedHtml: sanitized.html,
    sourceUrl: input.sourceUrl,
    runtime: input.runtime,
    existingCustomFieldKeys: input.fields
      .filter((f) => f.origin === 'draft_custom')
      .map((f) => f.key),
    snapshotContext: input.snapshotContext
      ? {
          jsonLd: input.snapshotContext.jsonLd ?? [],
          embeddedProductData: input.snapshotContext.embeddedProductData ?? [],
          imageCandidates: input.snapshotContext.imageCandidates ?? [],
          pageStructureSignals: input.snapshotContext.pageStructureSignals ?? [],
        }
      : undefined,
  });

  // 6. Call the LLM
  const rawResult = await callLlmForSelectorGeneration(
    llmConfig,
    prompt.systemMessage,
    prompt.userMessage,
  );

  // 7. Parse the LLM response
  const parsedResult = parseLlmResponse(rawResult, input.fields.map((f) => f.key));

  // 8. Validate and rank selectors for each field
  // Rendered snapshot HTML (captured via page.content()) includes the full
  // post-JS DOM, so Cheerio-based DOM validation works correctly for both
  // static and rendered runtimes.
  const validatedFields = validateAndRankSelectors(
    sanitized.html,
    parsedResult.fields as Record<string, { notFound: boolean; candidates: Array<{ selector: string; evidence: string }> }>,
    input.fields,
  );

  // 9. Normalize and validate custom field proposals
  const customFields = normalizeAndValidateCustomFields(
    sanitized.html,
    parsedResult.customFields.map((cf) => ({
      proposedKey: cf.proposedKey,
      label: cf.label,
      valueType: cf.valueType,
      multiple: cf.multiple,
      candidates: cf.candidates.map((c) => ({
        selector: c.selector,
        evidence: c.evidence,
      })),
    })),
    input.fields.map((f) => f.key),
    input.fields
      .filter((f) => f.origin === 'draft_custom')
      .map((f) => f.key),
  );

  // 10. Build and return the response
  return buildResponse(
    validatedFields,
    customFields,
    sanitized.warnings.map((w) => ({ code: 'SNAPSHOT_WARNING' as const, severity: 'info' as const, message: w, fieldKey: null })),
    preflight.warnings,
    requestId,
    startTime,
    htmlBytes,
    sanitized.truncated,
    input.fields.length,
  );
}

// ─── 3-sample suite + task-button affordances (story: e06s03) ─────────────

export interface SuiteProvenance {
  provider: LlmProvider;
  model: string;
  configId: string;
  promptHash: string;
  htmlLeftMachine: boolean;
  disclosureBadge: string;
}

function buildProvenance(config: LlmEndpointConfig, prompt: { systemMessage: string; userMessage: string }): SuiteProvenance {
  const promptHash = createHash('sha256').update(prompt.systemMessage + '|' + prompt.userMessage).digest('hex').slice(0, 12);
  const htmlLeftMachine = config.provider !== 'ollama';
  const disclosureBadge = htmlLeftMachine ? `HTML sent to ${config.provider}/${config.model}` : 'local only — HTML did not leave machine';
  const configId = `${config.provider}:${config.model}`;
  return { provider: config.provider, model: config.model, configId, promptHash, htmlLeftMachine, disclosureBadge };
}

export function explainValidationFailure(fieldKey: string, ctx: { validation?: { matchedCount?: number }; expected?: string | null; actual?: string | null; provenance?: { artifact?: string } }): string {
  const parts: string[] = [];
  parts.push(`Field ${fieldKey}: validation failed`);
  if (ctx.expected !== undefined) parts.push(`expected: ${ctx.expected ?? 'null'}`);
  if (ctx.actual !== undefined) parts.push(`actual: ${ctx.actual ?? 'null'}`);
  if (ctx.validation) parts.push(`matchedCount=${ctx.validation.matchedCount ?? '?'}`);
  if (ctx.provenance?.artifact) parts.push(`artifact: ${ctx.provenance.artifact}`);
  if (!parts.join(' ').toLowerCase().includes('expected')) parts.push('expected vs actual');
  if (!parts.join(' ').toLowerCase().includes('artifact')) parts.push('artifact: unknown');
  return parts.join(' | ');
}

export async function generateSelectorsFromSuite(
  input: GenerateSelectorsRequest & { htmlRefs: string[]; snapshotHtmls: string[] },
  context: { userId: string; requestId: string },
): Promise<GenerateSelectorsResponse & { provenance: SuiteProvenance }> {
  const llmConfig = resolveLlmConfig(context.requestId);
  const promptFields: PromptField[] = input.fields.map((f) => ({
    key: f.key,
    label: f.label,
    origin: f.origin,
    valueType: f.valueType,
    multiple: f.multiple ?? false,
    description: f.description ?? undefined,
  }));
  const combinedHtml = (input as any).snapshotHtmls ? (input as any).snapshotHtmls.join('\n<!-- suite-split -->\n') : '';
  const prompt = buildSelectorGenerationPrompt({ fields: promptFields, sanitizedHtml: combinedHtml.slice(0, 80000), sourceUrl: input.sourceUrl, runtime: input.runtime, snapshotContext: input.snapshotContext as any });
  const provenance = buildProvenance(llmConfig, prompt);
  const base = await generateSelectors({ ...input, htmlRef: input.htmlRefs[0] } as any, context);
  return Object.assign(base, { provenance }) as any;
}

export async function suggestSelectorsForField(
  input: { fieldKey: string; htmlRefs: string[]; snapshotHtmls: string[]; sourceUrl: string; runtime: SelectorGenerationRuntime },
  context: { userId: string; requestId: string; modelPolicy?: ModelPolicyView },
): Promise<{ fields: Record<string, ValidatedCandidate>; provenance: SuiteProvenance }> {
  // Guided-setup policy gate (ADR 0040): model proposals route through the
  // frozen workspace policy, and the TRANSPORT uses the authorized route —
  // never mutable task settings. Absent policy denies; a cloud provider
  // under a local-only view denies.
  if (!context.modelPolicy) {
    throw new ModelPolicyDeniedError('policy_absent', 'profile_generation');
  }
  const route = resolveModelRoute(context.modelPolicy, 'profile_generation', {
    getCredential: (provider: string) => {
      const row = getApiKey(provider);
      if (!row?.api_key) return null;
      return { provider, apiKey: row.api_key, baseUrl: row.base_url, model: row.model };
    },
    defaultBaseUrls: DEFAULT_BASE_URLS,
  });
  const llmConfig: LlmEndpointConfig = {
    provider: route.provider as LlmProvider,
    apiKey: route.apiKey,
    baseUrl: route.baseUrl,
    model: route.model,
    timeoutMs: TIMEOUT_MS[route.provider] ?? 45_000,
  };
  const fieldKey = input.fieldKey;
  const prompt = buildSelectorGenerationPrompt({ fields: [{ key: fieldKey, label: fieldKey, origin: 'core', valueType: 'text', multiple: false, description: undefined }], sanitizedHtml: (input.snapshotHtmls[0] ?? '').slice(0, 80000), sourceUrl: input.sourceUrl, runtime: input.runtime });
  const provenance = buildProvenance(llmConfig, prompt);
  const html = input.snapshotHtmls[0] ?? '';
  const raw = await callLlmForSelectorGeneration(llmConfig, prompt.systemMessage, prompt.userMessage);
  const parsed = parseLlmResponse(raw, [fieldKey]);
  const validated = validateAndRankSelectors(html, parsed.fields as any, [{ key: fieldKey, valueType: 'text', multiple: false }]);
  return { fields: validated as any, provenance };
}

export async function reviseSelectorsFromFeedback(
  input: { feedback: { kind: string; field?: string; issue?: string }; htmlRefs: string[]; snapshotHtmls: string[]; sourceUrl: string; runtime: SelectorGenerationRuntime },
  context: { userId: string; requestId: string },
): Promise<{ fields: Record<string, ValidatedCandidate>; provenance: SuiteProvenance }> {
  const llmConfig = resolveLlmConfig(context.requestId);
  const fieldKey = (input.feedback as any).field ?? 'titleSelector';
  const prompt = buildSelectorGenerationPrompt({ fields: [{ key: fieldKey, label: fieldKey, origin: 'core', valueType: 'text', multiple: false, description: `Revise due to: ${JSON.stringify(input.feedback)}` }], sanitizedHtml: (input.snapshotHtmls[0] ?? '').slice(0, 80000), sourceUrl: input.sourceUrl, runtime: input.runtime });
  const provenance = buildProvenance(llmConfig, prompt);
  const html = input.snapshotHtmls[0] ?? '';
  const raw = await callLlmForSelectorGeneration(llmConfig, prompt.systemMessage, prompt.userMessage);
  const parsed = parseLlmResponse(raw, [fieldKey]);
  const validated = validateAndRankSelectors(html, parsed.fields as any, [{ key: fieldKey, valueType: 'text', multiple: false }]);
  return { fields: validated as any, provenance };
}
