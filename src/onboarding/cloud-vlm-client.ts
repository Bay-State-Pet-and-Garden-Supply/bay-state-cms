/**
 * Cloud-based VLM OCR client for packaging images.
 *
 * Provides a cloud fallback for packaging OCR when the local VLM is
 * unavailable or produces low-confidence results. Uses an OpenAI-compatible
 * /chat/completions endpoint with image content support.
 *
 * This is gated by data-sharing policy — only fires when
 * `dataSharing.imagePolicy === 'cloud_allowed'`.
 */
import { getLlmConfigForTask, type LlmConfig } from './llm-client';
import {
  assertModelPolicyIntact,
  redactImageUrl,
  redactTransportText,
  type ModelPolicyView,
} from '../classification/model-policy-gateway';
import {
  computePromptHashes,
  MODEL_CALL_STATUS,
  COST_BASIS,
  type ModelCallContext,
} from '../classification/model-operation-registry';
import { assertModelPlanCompatible } from '../classification/runtime-snapshot';
import {
  insertModelCallStart,
  completeModelCall,
  insertTerminalModelCall,
} from '../db/repositories/classification-model-call-repo';
import { PACKAGING_OCR_PROMPT, parseJsonFromVlmResponse, coercePackagingOcrData } from './packaging-ocr';
import type { PackagingOcrData } from '../shared/schemas/onboarding';
import { sha256Hex } from '../shared/stable-id';
import type { LlmTask } from '../db/repositories/llm-task-config-repo';
import { DeterministicNetworkGate } from './image-verification/network-gate';

const vlmImageGate = new DeterministicNetworkGate();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CloudVlmParams {
  /** The primary product image URL */
  imageUrl: string;
  /** Provider/model override (defaults to llm_task_configs or fallback) */
  task?: string;
  /** Frozen classification model-policy view (issue #17 item A). */
  modelPolicy?: ModelPolicyView | null;
  /** Durable model-call audit context (issue #17 work item E). */
  modelCall?: ModelCallContext | null;
  /** Runtime snapshot the call is bound to (plan compatibility). */
  snapshot?: import('../classification/runtime-snapshot').RuntimeClassificationSnapshot | null;
}

// ─── Image Fetching ───────────────────────────────────────────────────────────

/**
 * Fetch a remote image, validate size, and return base64 + MIME type.
 * Logged URLs are redacted (query strings can carry signed credentials).
 * Throws an `ImageFetchAbortError` on abort/timeout so the caller can record
 * a durable `cancelled` terminal row (never a misleading `failed`); other
 * failures return null.
 */
class ImageFetchAbortError extends Error {
  constructor(message = 'Image fetch aborted') {
    super(message);
    this.name = 'ImageFetchAbortError';
  }
}

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  const logUrl = redactImageUrl(url);
  try {
    const response = await vlmImageGate.fetch(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BaystateCMS/1.0)',
          Accept: 'image/*',
        },
        signal: AbortSignal.timeout(30_000),
      },
      {
        allowedContentTypes: ['image/', 'application/octet-stream'],
        maxResponseBytes: 25 * 1024 * 1024,
      },
    );

    if (!response.ok) {
      console.warn(`[CloudVlm] HTTP ${response.status} fetching image: ${logUrl}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';

    // Skip SVGs and other non-raster formats
    if (contentType.includes('svg')) {
      console.warn(`[CloudVlm] Skipping SVG image: ${logUrl}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Skip tiny files (likely icons/spacers)
    if (buffer.length < 1024) {
      console.warn(`[CloudVlm] Image too small (${buffer.length}b), skipping: ${logUrl}`);
      return null;
    }

    return { base64: buffer.toString('base64'), mimeType: contentType };
  } catch (err: any) {
    const isAbort =
      err?.name === 'AbortError' ||
      err?.name === 'TimeoutError' ||
      String(err?.message ?? '').toLowerCase().includes('abort');
    if (isAbort) {
      console.warn(`[CloudVlm] Image fetch aborted: ${logUrl}`);
      throw new ImageFetchAbortError();
    }
    console.warn(`[CloudVlm] Failed to fetch image ${logUrl}: ${redactTransportText(err.message)}`);
    return null;
  }
}

// ─── Cloud VLM Call ───────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible vision API to extract packaging text from an image.
 *
 * Sends the PACKAGING_OCR_PROMPT with the image inline (image_url content type).
 * Uses the standard /chat/completions endpoint with a model that supports vision.
 *
 * Provider resolution:
 * 1. If `task` is provided, uses `getLlmConfigForTask(task)` (e.g. 'classification_evidence_extraction')
 * 2. Falls back to generic `getLlmConfig()` (default LLM provider)
 *
 * Returns parsed PackagingOcrData or null on failure.
 */
export async function extractPackagingOcrFromCloud(
  params: CloudVlmParams,
): Promise<PackagingOcrData | null> {
  const { imageUrl, task } = params;

  if (!imageUrl) {
    console.warn('[CloudVlm] No image URL provided.');
    return null;
  }

  // 0a. Fail closed on snapshot-plan compatibility BEFORE any config
  //     resolution or transport: a run-bound cloud VLM call WITHOUT a
  //     compatible frozen plan — or without an audit context at all — never
  //     proceeds (issue #17 pass 4c). Only non-run-bound callers (no
  //     snapshot) may take the legacy/no-plan path.
  if (params.snapshot) {
    assertModelPlanCompatible(params.snapshot, 'evidence_extraction', params.modelCall);
    if (!params.modelCall) {
      throw new Error(
        'Run-bound cloud VLM call without a model-call audit context (no compatible frozen plan).',
      );
    }
  } else if (params.modelCall) {
    // A supplied context without a snapshot cannot be validated: fail closed.
    throw new Error('Cloud VLM call supplied a model-call audit context without a runtime snapshot.');
  }

  // 0. Resolve the vision route through the frozen policy BEFORE any
  //    transport. `requiresImage` enforces imageDataSharing at the route
  //    layer (issue #17 pass 1c): under `imageDataSharing: 'local_only'`
  //    a non-local provider is denied before the image is downloaded, so an
  //    image never leaves the machine for an unauthorized call. Omitting the
  //    policy throws policy_absent — also fail closed before any fetch.
  let config: LlmConfig | null;
  try {
    config = getLlmConfigForTask((task ?? 'classification_evidence_extraction') as LlmTask, {
      allowFallback: false,
      modelPolicy: params.modelPolicy,
      protectedOperation: 'evidence_extraction',
      requiresImage: true,
    });
  } catch (err: any) {
    if (params.modelCall) {
      insertTerminalModelCall({
        runId: params.modelCall.runId,
        stageName: params.modelCall.stage,
        operation: params.modelCall.operation,
        attempt: params.modelCall.attempt,
        provider: null,
        model: null,
        locality: null,
        snapshotHash: params.modelCall.snapshotHash,
        modelPolicyDigest: params.modelPolicy?.policyDigest ?? '',
        promptTemplateVersion: params.modelCall.promptTemplateVersion,
        ruleVersion: params.modelCall.ruleVersion,
        systemPromptHash: '',
        userPromptHash: '',
        status: MODEL_CALL_STATUS.policyDenied,
        errorMessage: `Model policy denied cloud VLM (${err?.code ?? 'error'})`,
        costBasis: COST_BASIS.unknown,
      });
    }
    if (err?.code === 'policy_absent') {
      console.warn('[CloudVlm] No model policy context for cloud VLM; no image fetched.');
    } else {
      console.warn(
        `[CloudVlm] Model policy denied cloud VLM (${err?.code ?? 'error'}); no image fetched.`,
      );
    }
    return null;
  }

  if (!config) {
    console.warn('[CloudVlm] No LLM config available for cloud VLM call; no image fetched.');
    if (params.modelCall) {
      insertTerminalModelCall({
        runId: params.modelCall.runId,
        stageName: params.modelCall.stage,
        operation: params.modelCall.operation,
        attempt: params.modelCall.attempt,
        provider: null,
        model: null,
        locality: null,
        snapshotHash: params.modelCall.snapshotHash,
        modelPolicyDigest: params.modelPolicy?.policyDigest ?? '',
        promptTemplateVersion: params.modelCall.promptTemplateVersion,
        ruleVersion: params.modelCall.ruleVersion,
        systemPromptHash: '',
        userPromptHash: '',
        status: MODEL_CALL_STATUS.unavailable,
        errorMessage: 'No LLM config available for cloud VLM call.',
        costBasis: COST_BASIS.unknown,
      });
    }
    return null;
  }

  // Durable audit: insert the `started` row BEFORE any transport (image fetch
  // + vision call). If the row cannot be persisted, no transport happens
  // (fail-closed invariant, issue #17 E).
  const modelCall = params.modelCall ?? null;
  let callId: string | null = null;
  if (modelCall) {
    const hashes = computePromptHashes(PACKAGING_OCR_PROMPT, '');
    // A failed start insert MUST abort (parity with the audited LLM wrapper):
    // without a durable start row there is no provenance, and the image must
    // never be fetched for an unaudited call.
    callId = insertModelCallStart({
      runId: modelCall.runId,
      stageName: modelCall.stage,
      operation: modelCall.operation,
      attempt: modelCall.attempt,
      provider: config.provider,
      model: config.model,
      locality: params.modelPolicy?.providerLocalities[config.provider] ?? null,
      snapshotHash: modelCall.snapshotHash,
      modelPolicyDigest: params.modelPolicy?.policyDigest ?? '',
      promptTemplateVersion: modelCall.promptTemplateVersion,
      ruleVersion: modelCall.ruleVersion,
      systemPromptHash: hashes.systemPromptHash,
      userPromptHash: hashes.userPromptHash,
    });
  }

  const startedAt = Date.now();
  const completeTerminal = (status: typeof MODEL_CALL_STATUS[keyof typeof MODEL_CALL_STATUS], errorMessage?: string, durationMs?: number, promptTokens?: number | null, completionTokens?: number | null): boolean => {
    if (callId) {
      return completeModelCall(callId, {
        status,
        durationMs: durationMs ?? Date.now() - startedAt,
        errorMessage,
        promptTokens: promptTokens ?? null,
        completionTokens: completionTokens ?? null,
        estimatedCostUsd: (params.modelPolicy?.providerLocalities[config.provider] ?? null) === 'local' ? 0 : null,
        costBasis: (params.modelPolicy?.providerLocalities[config.provider] ?? null) === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
    }
    return true;
  };

  // Terminalization guard: any error after the start row MUST leave a durable
  // terminal row (never a stranded `started`).
  let terminalWritten = false;
  const markTerminal = (status: typeof MODEL_CALL_STATUS[keyof typeof MODEL_CALL_STATUS], errorMessage?: string, durationMs?: number, promptTokens?: number | null, completionTokens?: number | null): boolean => {
    terminalWritten = true;
    return completeTerminal(status, errorMessage, durationMs, promptTokens, completionTokens);
  };


  // 1. Get the image as base64 (image transport was already authorized by
  //    the policy route resolution above). An aborted image fetch is a
  //    cancellation — never a misleading `failed` row.
  let imageData: { base64: string; mimeType: string } | null;
  try {
    imageData = await fetchImageAsBase64(imageUrl);
  } catch (err: any) {
    const isAbort = err instanceof ImageFetchAbortError;
    markTerminal(
      isAbort ? MODEL_CALL_STATUS.cancelled : MODEL_CALL_STATUS.failed,
      isAbort
        ? `Image fetch aborted: ${redactImageUrl(imageUrl)}`
        : `Could not load image: ${redactTransportText(err?.message ?? String(err))}`,
    );
    console.warn(
      `[CloudVlm] ${isAbort ? 'Cancelled' : 'Failed'} image fetch: ${redactImageUrl(imageUrl)} — ${redactTransportText(err?.message ?? String(err))}`,
    );
    return null;
  }
  if (!imageData) {
    markTerminal(MODEL_CALL_STATUS.failed, `Could not load image: ${redactImageUrl(imageUrl)}`);
    console.warn(`[CloudVlm] Could not load image: ${redactImageUrl(imageUrl)}`);
    return null;
  }

  // 3. Build the OpenAI-compatible vision request
  //    The image is sent as an image_url content part alongside the text prompt.
  const dataUrl = `data:${imageData.mimeType};base64,${imageData.base64}`;

  const body = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PACKAGING_OCR_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
  };

  // 4. Call the API — re-assert the frozen policy at the transport boundary
  //    (issue #17 pass 1b): policy tampering or route drift denies the call.
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.provider === 'ollama' ? 120_000 : 60_000;

  console.log(`[CloudVlm] Calling ${config.provider}:${config.model} for packaging OCR`);

  try {
    if (params.modelPolicy) {
      assertModelPolicyIntact(params.modelPolicy);
      // Re-resolve the protected route from the frozen policy and compare it
      // against the config about to be used.
      const fresh = getLlmConfigForTask((task ?? 'classification_evidence_extraction') as LlmTask, {
        allowFallback: false,
        modelPolicy: params.modelPolicy,
        protectedOperation: 'evidence_extraction',
        requiresImage: true,
      });
      if (
        !fresh ||
        fresh.provider !== config.provider ||
        fresh.model !== config.model ||
        fresh.baseUrl !== config.baseUrl
      ) {
        throw new Error('Cloud VLM route drifted from the frozen model policy');
      }
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      const isAbort =
        (err?.name === 'AbortError' || err?.name === 'TimeoutError') ||
        String(err?.message ?? '').toLowerCase().includes('abort');
      markTerminal(
        isAbort ? MODEL_CALL_STATUS.cancelled : MODEL_CALL_STATUS.failed,
        redactTransportText(err?.message ?? String(err)),
      );
      console.warn(`[CloudVlm] ${isAbort ? 'Cancelled' : 'Failed'} cloud VLM transport: ${redactTransportText(err?.message ?? String(err))}`);
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const reason = `[CloudVlm] API request failed (${config.provider}): ${response.status} - ${redactTransportText(errorText)}`;
      markTerminal(MODEL_CALL_STATUS.failed, reason);
      console.warn(reason);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const rawContent = data?.choices?.[0]?.message?.content;
    if (!rawContent) {
      markTerminal(MODEL_CALL_STATUS.failed, 'Cloud VLM API returned empty response.');
      console.warn('[CloudVlm] API returned empty response.');
      return null;
    }

    const responseExcerpt = rawContent.slice(0, 200);

    // 5. Parse the response using the same utilities as local OCR
    const parsed = parseJsonFromVlmResponse(rawContent);
    if (!parsed) {
      markTerminal(MODEL_CALL_STATUS.failed, 'Could not parse JSON from cloud VLM response.');
      console.warn('[CloudVlm] Could not parse JSON from response.');
      return null;
    }

    // 6. Coerce to the standard PackagingOcrData shape
    const metadata = {
      // P2 redaction pass: strip credentials/query from the persisted ref.
      imageSourceUrl: imageUrl ? redactImageUrl(imageUrl) : null,
      imageSourceDigest: imageUrl ? sha256Hex(imageUrl) : null,
      imageLocalPath: null,
      model: `${config.provider}:${config.model}`,
      extractedAt: new Date().toISOString(),
      parser: 'cloud-vlm-client.ts',
      rawResponseExcerpt: responseExcerpt,
      ...(callId ? { modelCallIds: [callId] } : {}),
    };

    const result = coercePackagingOcrData(parsed, metadata);
    if (!result) {
      markTerminal(MODEL_CALL_STATUS.failed, 'Schema coercion failed for cloud OCR response.');
      console.warn('[CloudVlm] Schema coercion failed for cloud OCR response.');
      return null;
    }

    // Success: terminal row (with usage tokens when present) must be durable
    // before the result is returned. A failed terminal update discards the
    // output — the model result must never be returned without durable
    // provenance.
    const promptTokens = data.usage?.prompt_tokens ?? null;
    const completionTokens = data.usage?.completion_tokens ?? null;
    const terminalDurable = markTerminal(MODEL_CALL_STATUS.success, undefined, undefined, promptTokens, completionTokens);
    if (!terminalDurable) {
      console.error(`[CloudVlm] Model call ${callId ?? '?'} terminal update failed; discarding OCR output.`);
      return null;
    }

    const fieldCount = Object.entries(result).filter(
      ([k, v]) => k !== 'metadata' && k !== 'confidenceByField' && v !== null && !(Array.isArray(v) && v.length === 0),
    ).length;

    console.log(
      `[CloudVlm] ✓ OCR complete: ${fieldCount} fields populated ` +
      `(productName="${result.productName ?? 'N/A'}", species=[${result.species.join(', ')}])`,
    );

    return result;
  } catch (err: any) {
    // Outer terminalization: any error that did not already write a terminal
    // row leaves a durable `failed` row; never a stranded `started`.
    if (!terminalWritten) {
      try {
        markTerminal(MODEL_CALL_STATUS.failed, redactTransportText(err?.message ?? String(err)));
      } catch (terminalErr: any) {
        console.error('[CloudVlm] Failed to terminalize call row after error:', redactTransportText(terminalErr?.message ?? String(terminalErr)));
      }
    }
    console.warn(`[CloudVlm] Cloud VLM call failed: ${redactTransportText(err?.message ?? String(err))}`);
    return null;
  }
}
