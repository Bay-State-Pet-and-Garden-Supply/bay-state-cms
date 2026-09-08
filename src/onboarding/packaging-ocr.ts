/**
 * Shared packaging OCR module.
 *
 * Runs VLM OCR on a product's primary packaging image once, before
 * classification. Extracts structured attributes into PackagingOcrData
 * and persists them on ExtractionData so both the curator (title synthesis)
 * and the classification pipeline (evidence extraction) consume the same
 * data without duplicate VLM calls.
 *
 * Images are expected to be remote URLs at this point (extraction stores
 * them as URLs). We fetch them in-memory — no local download required.
 */

import { getVlmConfig, callVlm, callVlmWithDispatcher, type VlmConfig } from './vlm-client';
import * as nodePath from 'node:path';
import { isLoopbackBaseUrl, redactImageUrl, redactTransportText } from '../classification/model-policy-gateway';
import { getOcrStageFlags } from '../classification/ocr-stage-flags';
import { isPrivateLanHost } from '../ai/provider-connections';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import {
  OCR_FAILURE_REASON_MESSAGES,
  isTransientOcrFailure,
  type OcrFailureReason,
} from './ocr-failure-reasons';
import {
  buildCircuitBreakerKey,
  checkCircuit,
  recordSuccess,
  recordTransportFailure,
} from './vlm-circuit-breaker';
import {
  computePromptHashes,
  MODEL_CALL_STATUS,
  COST_BASIS,
  type ModelCallContext,
} from '../classification/model-operation-registry';
import { HeartbeatLostError } from '../classification/heartbeat-errors';
import {
  assertModelPlanCompatible,
  getModelExecutionPlanEntry,
} from '../classification/runtime-snapshot';
import {
  insertModelCallStart,
  completeModelCall,
  recordTerminalPreflight,
} from '../db/repositories/classification-model-call-repo';
import { PackagingOcrDataSchema } from '../shared/schemas/onboarding';
import type { PackagingOcrData } from '../shared/schemas/onboarding';
import { sha256Hex } from '../shared/stable-id';

// ─── Prompt ────────────────────────────────────────────────────────────────────

/**
 * Comprehensive VLM prompt for packaging image analysis.
 * Asks for structured JSON with per-field confidence.
 *
 * Prompt version history:
 * - v1 (original): bare field list; VLMs used flavorVariety as a generic
 *   variety/scent/line-name slot on non-food products (e.g. "Ammonia Locker"
 *   for paper litter, "VEGGIE" for chew toys).
 * - v2 (2026-08-24): explicit per-field semantics. flavorVariety is
 *   EDIBLE-products-only; scents/odor-control claims/formula names belong in
 *   "claims" (or null). productForm/lifeStage tightened likewise. Field set
 *   unchanged (PackagingOcrDataSchema is frozen-shape).
 */
export const PACKAGING_OCR_PROMPT = `Analyze this product packaging image for a retail catalog.

Return ONLY valid JSON. Do not wrap in markdown. Do not guess. Use null or [] when not visible.
If a field does not apply to this product type, return null or [] — an empty field is correct and preferred over a guess.
Separate printed text from visual inference.

Field definitions (apply strictly):
"flavorVariety": the named flavor OR recipe ONLY for EDIBLE products (foods, treats, chews intended to be eaten). Examples: "Chicken Recipe", "Duck Stew", "Peanut Butter". For NON-edible products (litter, toys, grooming, tools), this MUST be null — scent notes, odor-control claims (e.g. "Ammonia Locker", "Odor-Eliminating Carbon", "Beef Scent") and formula names are NOT flavors; put marketing claim phrases like these into "claims" instead.
"productForm": the physical form of the product itself (e.g. "dry kibble", "wet food", "plush toy", "clumping litter", "shampoo"). Not the product category, not marketing wording.
"packagingType": primary container package form (e.g. "Bag", "Can", "Box", "Tray", "Pouch", "Bottle", "Jar", "Pail", "Tub", "Individual"). Null when absent.
"npkRatio": for lawn/plant fertilizer only, the N-P-K nutrient numbers printed on the package (e.g. "10-10-10", "24-0-11"). Null when absent.
"lifeStage": life-stage wording printed on the package only (e.g. "puppy", "adult", "senior", "kitten"). Null when absent.
"upc": transcribe the exact UPC/GTIN barcode digits printed on the package (EAN-13/UPC-A, 8-14 digits, digits only after stripping check-spacing). Use null when no barcode is visible or legible. Transcribe ONLY what is printed — never infer from brand or size text.
"brand": the brand name exactly as printed on the package.

{
  "productName": string | null,
  "brand": string | null,
  "species": string[],
  "upc": string | null,
  "flavorVariety": string | null,
  "color": string | null,
  "material": string | null,
  "size": string | null,
  "weight": string | null,
  "count": string | null,
  "lifeStage": string | null,
  "breedSize": string | null,
  "productForm": string | null,
  "packagingType": string | null,
  "npkRatio": string | null,
  "healthConcernFunction": string[],
  "dietaryLabels": string[],
  "ingredients": string[],
  "ingredientKeywords": string[],
  "claims": string[],
  "visibleTextLines": string[],
  "confidenceByField": { [fieldName: string]: number }
}`;

// ─── Image loading ─────────────────────────────────────────────────────────────

/**
 * Determine whether a string is an HTTP(S) URL.
 */
function isRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Structured image-load outcome so every load failure carries a coded reason
 * (P1-T1). `base64` is null exactly when `failure` is present.
 */
interface ImageLoadOutcome {
  base64: string | null;
  failure?: {
    reasonCode: OcrFailureReason;
    /** Pre-redacted detail (no raw URL/host interpolation). */
    message: string;
    httpStatus?: number;
  };
}

/**
 * FIX-I round 3: textual/SVG payloads must never reach the VLM transports
 * labeled image/jpeg. Sniff the first ~512 bytes as ASCII: HTML/SVG markup
 * (after leading whitespace) is rejected as a coded image-load failure.
 *
 * Round-3 review fixup: a recognized RASTER magic signature short-circuits
 * the scan. Valid PNG (tEXt/iTXt) or JPEG (COM/APP) metadata may legitimately
 * embed "<svg"/"<html" strings within the first 512 bytes; signature-first
 * ordering means markup scanning only ever applies to payloads that are not
 * already identified as a known raster format.
 */
const MARKUP_SNIFF_BYTES = 512;
const MARKUP_REJECTION_MESSAGE = 'Payload is not a raster image (HTML/SVG markup detected).';

/** True when the buffer begins with a known raster-image magic signature. */
export function hasRasterMagicSignature(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    // JPEG needs only 3 bytes but every other accepted signature needs more;
    // check JPEG explicitly before the length floor.
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    );
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true; // JPEG
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return true; // PNG
  const sig6 = buffer.toString('latin1', 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return true; // GIF
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return true; // WebP
  return false;
}

function looksLikeTextualMarkup(buffer: Buffer): boolean {
  // Signature-first ordering: known raster formats are never markup, no
  // matter what their early metadata chunks happen to contain.
  if (hasRasterMagicSignature(buffer)) return false;
  const head = buffer.subarray(0, MARKUP_SNIFF_BYTES).toString('latin1').toLowerCase();
  const trimmed = head.replace(/^\s+/, '');
  return trimmed.includes('<svg') || trimmed.includes('<!doctype html') || trimmed.includes('<html');
}

/**
 * Fetch a remote image and return its base64-encoded contents with a coded
 * failure classification.
 * `fetchFn` defaults to the global fetch (onboarding pipeline unchanged);
 * PI callers may pass a policy-gateway-bound fetch (P0-1).
 */
async function fetchRemoteImageOutcome(url: string, fetchFn: NetworkFetch = fetch): Promise<ImageLoadOutcome> {
  try {
    const response = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BaystateCMS/1.0)',
        Accept: 'image/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`[PackagingOcr] HTTP ${response.status} fetching remote image: ${redactImageUrl(url)}`);
      return {
        base64: null,
        failure: {
          reasonCode: 'image_http_error',
          message: `Image fetch returned HTTP ${response.status}.`,
          httpStatus: response.status,
        },
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    // FIX-I round 3: case-insensitive — servers may emit "image/SVG+xml",
    // "Text/HTML", etc.
    if (contentType.toLowerCase().includes('svg')) {
      console.warn(`[PackagingOcr] Skipping SVG image: ${redactImageUrl(url)}`);
      return {
        base64: null,
        failure: { reasonCode: 'image_svg_unsupported', message: 'Remote image is SVG; unsupported for OCR.' },
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (looksLikeTextualMarkup(buffer)) {
      console.warn(`[PackagingOcr] Rejecting non-raster image payload (HTML/SVG markup detected): ${redactImageUrl(url)}`);
      return {
        base64: null,
        failure: { reasonCode: 'image_svg_unsupported', message: MARKUP_REJECTION_MESSAGE },
      };
    }

    // Skip tiny files (likely icons/spacers)
    if (buffer.length < 1024) {
      console.warn(`[PackagingOcr] Image too small (${buffer.length}b), skipping: ${redactImageUrl(url)}`);
      return {
        base64: null,
        failure: { reasonCode: 'image_too_small', message: `Image too small (${buffer.length} bytes) to run OCR.` },
      };
    }

    return { base64: buffer.toString('base64') };
  } catch (err: any) {
    console.warn(`[PackagingOcr] Failed to fetch remote image ${redactImageUrl(url)}: ${redactTransportText(err.message)}`);
    return {
      base64: null,
      failure: {
        reasonCode: 'image_fetch_failed',
        message: `Image fetch failed before an HTTP response: ${redactTransportText(err.message)}`,
      },
    };
  }
}

/**
 * Load a product image as base64 WITH a coded failure classification,
 * supporting both local paths and remote URLs. Priority and fallback order
 * are identical to `loadProductImageAsBase64` (which wraps this).
 */
async function loadImageWithReason(
  imageUrl: string,
  workspacePath?: string,
  imageLocalPath?: string | null,
  fetchFn: NetworkFetch = fetch,
): Promise<ImageLoadOutcome> {
  const readLocalFile = async (resolved: string, workspaceRoot: string): Promise<ImageLoadOutcome | null> => {
    try {
      const fs = await import('fs');
      if (!fs.existsSync(resolved)) return null;
      // FIX-A round 2: filesystem-REAL containment. The lexical prefix check in
      // resolveWorkspaceContainedPath cannot see symlinks, so re-resolve BOTH
      // the candidate and the workspace root to their true paths and require
      // the candidate to live under the real root — an interior symlink
      // pointing outside the workspace is rejected here.
      let candidateReal: string;
      let workspaceReal: string;
      try {
        candidateReal = fs.realpathSync(resolved);
        workspaceReal = fs.realpathSync(workspaceRoot);
      } catch {
        return null; // unresolvable path ⇒ treat as missing
      }
      if (candidateReal !== workspaceReal && !candidateReal.startsWith(workspaceReal + nodePath.sep)) {
        console.warn(`[PackagingOcr] Local image path escapes the workspace after symlink resolution; refusing.`);
        return null;
      }
      const buffer = fs.readFileSync(resolved);
      if (looksLikeTextualMarkup(buffer)) {
        console.warn(`[PackagingOcr] Local image is not a raster payload (HTML/SVG markup detected): ${resolved}`);
        return {
          base64: null,
          failure: { reasonCode: 'image_svg_unsupported', message: MARKUP_REJECTION_MESSAGE },
        };
      }
      if (buffer.length >= 1024) {
        return { base64: buffer.toString('base64') };
      }
      console.warn(`[PackagingOcr] Local image too small (${buffer.length}b): ${resolved}`);
      return {
        base64: null,
        failure: { reasonCode: 'image_too_small', message: `Local image too small (${buffer.length} bytes) to run OCR.` },
      };
    } catch {
      // Fall through to next strategy
    }
    return null;
  };

  // Try local path first (for items where images were downloaded).
  // Containment: absolute candidates are rejected outright and relative
  // candidates must resolve INSIDE workspacePath (`..` traversal ⇒ treated
  // as missing; the loader continues to the next strategy with its coded
  // failure taxonomy intact).
  if (imageLocalPath && workspacePath) {
    const resolved = resolveWorkspaceContainedPath(workspacePath, imageLocalPath);
    if (resolved) {
      const local = await readLocalFile(resolved, workspacePath);
      if (local) return local;
    }
  }

  // Try resolving the image URL as a local path if it's not a remote URL
  if (!isRemoteUrl(imageUrl) && workspacePath) {
    const resolved = resolveWorkspaceContainedPath(workspacePath, imageUrl);
    if (resolved) {
      const local = await readLocalFile(resolved, workspacePath);
      if (local) return local;
    }
  }

  // Remote URL — fetch in-memory
  if (isRemoteUrl(imageUrl)) {
    return fetchRemoteImageOutcome(imageUrl, fetchFn);
  }

  return {
    base64: null,
    failure: { reasonCode: 'no_image', message: OCR_FAILURE_REASON_MESSAGES.no_image },
  };
}

/**
 * Load a product image as base64, supporting both local paths and remote URLs.
 *
 * Priority:
 * 1. If `imageLocalPath` is provided and the file exists on disk, read it.
 * 2. If `imageUrl` is an HTTP(S) URL, fetch it in-memory.
 * 3. Otherwise return null.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function loadProductImageAsBase64(
  imageUrl: string,
  workspacePath?: string,
  imageLocalPath?: string | null,
  fetchFn: NetworkFetch = fetch,
): Promise<string | null> {
  const outcome = await loadImageWithReason(imageUrl, workspacePath, imageLocalPath, fetchFn);
  return outcome.base64;
}

// ─── Parser ─────────────────────────────────────────────────────────────────────

/**
 * Attempt to extract a JSON object from the VLM response text.
 * Tries, in order:
 * 1. Raw JSON.parse
 * 2. Strip markdown code fences
 * 3. Find the first { ... } block surrounded by prose
 */
export function parseJsonFromVlmResponse(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null;

  const trimmed = raw.trim();

  // 1. Raw parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to next strategy
  }

  // 2. Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue
    }
  }

  // 3. Find the first { ... } object
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const candidate = trimmed.slice(braceStart, braceEnd + 1);
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Give up
    }
  }

  return null;
}

/**
 * Coerce a raw parsed object into a valid PackagingOcrData.
 * Normalizes arrays, clamps confidence values, and defaults unknown fields.
 */
export function coercePackagingOcrData(
  raw: Record<string, unknown>,
  metadata?: {
    imageSourceUrl?: string | null;
    imageLocalPath?: string | null;
    model?: string | null;
    parser?: string | null;
    rawResponseExcerpt?: string | null;
  } | null,
): PackagingOcrData | null {
  // Normalize scalar values that should be arrays
  const normalizeArray = (val: unknown): string[] => {
    // FIX-D review round 2: placeholder entries ("NULL", "NONE", "NA", …)
    // are VLM non-answers — dropped from arrays exactly like normalizeString
    // drops them from scalars, so a placeholder-only array can never count
    // as OCR content downstream.
    const isPlaceholder = (s: string): boolean => /^(null|none|n\/a|na|unknown|n\.a\.)$/i.test(s.trim());
    if (Array.isArray(val)) return val.map(String).map(s => s.trim()).filter(Boolean).filter(s => !isPlaceholder(s));
    if (typeof val === 'string' && val.trim() && !isPlaceholder(val)) return [val.trim()];
    return [];
  };

  const normalizeString = (val: unknown): string | null => {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      // Placeholder strings ("null", "none", "N/A", "unknown", …) are VLM
      // non-answers, not data — persist them as null instead of literal junk.
      if (!trimmed || /^(null|none|n\/a|na|unknown|n\.a\.)$/i.test(trimmed)) return null;
      return trimmed;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    return null;
  };

  // Round-5: barcode digits only; a valid UPC/GTIN is 8-14 digits after
  // stripping spaces/hyphens (EAN-13/UPC-A check-spacing). Anything else
  // is not a trustworthy barcode transcription and stays null.
  const normalizeBarcode = (val: unknown): string | null => {
    const raw = normalizeString(val);
    if (raw === null) return null;
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : null;
  };

  // Clamp confidence values
  const normalizeConfidence = (val: unknown): number | null => {
    const n = typeof val === 'number' ? val : Number(val);
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(1, n));
  };

  const confidenceByField: Record<string, number> = {};
  if (raw.confidenceByField && typeof raw.confidenceByField === 'object') {
    for (const [key, val] of Object.entries(raw.confidenceByField)) {
      const clamped = normalizeConfidence(val);
      if (clamped !== null) confidenceByField[key] = clamped;
    }
  }

  const candidate = {
    productName: normalizeString(raw.productName),
    brand: normalizeString(raw.brand),
    species: normalizeArray(raw.species),
    upc: normalizeBarcode(raw.upc),
    flavorVariety: normalizeString(raw.flavorVariety),
    color: normalizeString(raw.color),
    material: normalizeString(raw.material),
    size: normalizeString(raw.size),
    weight: normalizeString(raw.weight),
    count: normalizeString(raw.count),
    lifeStage: normalizeString(raw.lifeStage),
    breedSize: normalizeString(raw.breedSize),
    productForm: normalizeString(raw.productForm),
    packagingType: normalizeString(raw.packagingType),
    npkRatio: normalizeString(raw.npkRatio),
    guaranteedAnalysis: raw.guaranteedAnalysis && typeof raw.guaranteedAnalysis === 'object' && !Array.isArray(raw.guaranteedAnalysis)
      ? Object.fromEntries(
          Object.entries(raw.guaranteedAnalysis as Record<string, unknown>)
            .map(([k, v]) => [k, normalizeString(v)])
            .filter((entry): entry is [string, string] => entry[1] !== null)
        )
      : {},
    healthConcernFunction: normalizeArray(raw.healthConcernFunction),
    dietaryLabels: normalizeArray(raw.dietaryLabels),
    ingredients: normalizeArray(raw.ingredients),
    ingredientKeywords: normalizeArray(raw.ingredientKeywords),
    claims: normalizeArray(raw.claims),
    visibleTextLines: normalizeArray(raw.visibleTextLines),
    confidenceByField,
    metadata: metadata ?? null,
  };

  const result = PackagingOcrDataSchema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }

  console.warn(`[PackagingOcr] Schema validation failed: ${result.error.message}`);
  return null;
}

// ─── Main entry point ──────────────────────────────────────────────────────────


/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ExtractPackagingOcrParams {
  /** The primary image URL or relative path from extraction data. */
  imageUrl: string;
  /** Workspace path for resolving local image paths. */
  workspacePath?: string;
  /** Optional local path override (if image was downloaded). */
  imageLocalPath?: string | null;
  /** Original source URL for metadata. */
  imageSourceUrl?: string | null;
  /** SKU / UPC for logging. */
  sku?: string | null;
  /**
   * P0-1 (round 2): injected fetch for the remote image loader. Product
   * Intelligence binds this to the policy gateway's gatewayFetch; the
   * onboarding pipeline keeps the default global fetch.
   */
  fetchFn?: NetworkFetch;
  /**
   * Round-4: injected transport for the VLM MODEL call, separately gated
   * from the image download. Product Intelligence binds this to the
   * gateway's buildModelFetch (checkModelEndpoint authority — local
   * loopback models allowed under any data-sharing policy; remote models
   * must match the modelRoute). Defaults to fetchFn for the onboarding
   * pipeline, which historically passed one transport for both.
   */
  modelFetchFn?: NetworkFetch;
  /** Durable model-call audit context (issue #17 E): when present, the local
   *  VLM transport is audited with a classification_model_calls row
   *  (started → terminal on every path) so run-bound local VLM output is
   *  fully observable and its callId flows into the OCR evidence metadata. */
  modelCall?: ModelCallContext | null;
  /** Runtime snapshot the call is bound to (plan compatibility). */
  snapshot?: import('../classification/runtime-snapshot').RuntimeClassificationSnapshot | null;
  /**
   * Frozen local VLM route from the run snapshot plan entry. When provided
   * (run-bound), the transport uses ONLY this base URL/model — never mutable
   * `ollama_vlm` settings — and locality is resolved from the ACTUAL URL used
   * (loopback ⇒ local; non-loopback ⇒ deny before transport).
   */
  frozenVlmRoute?: { baseUrl: string; model: string } | null;
  /** Frozen model-policy digest bound to the snapshot (for the audit row). */
  modelPolicyDigest?: string | null;
  /**
   * P3-T1 evaluation-harness seam: explicit local-VLM route used INSTEAD of
   * `getVlmConfig()` on the legacy (non-run-bound) path. Only honored when
   * no runtime snapshot is present — run-bound calls always bind to their
   * frozen plan entry. Used by the ocr-eval harness to point the real OCR
   * core at each candidate model without mutating stored settings.
   */
  vlmConfigOverride?: VlmConfig | null;
  /**
   * Ownership assertion for run-bound cohort OCR (PR3 hardening C). When
   * provided, it is invoked IMMEDIATELY BEFORE every terminal model-call
   * update (`completeModelCall` / `markTerminal`) — a rejected assertion
   * (the cohort run's lease was lost to a reclaiming sibling mid-flight)
   * throws `HeartbeatLostError` and that terminal update is SKIPPED, so a
   * stale owner never writes `classification_model_calls` state after
   * ownership moves. Absent in legacy (non-run-bound) calls — zero behavior
   * change.
   */
  assertHeld?: () => void;
}

/**
 * Structured OCR attempt result (P1-T1).
 *
 * - `ok: true`  → parsed + validated OCR data bound to the downloaded bytes.
 * - `ok: false` → exactly one coded failure from the OcrFailureReason
 *   taxonomy, with a PRE-REDACTED human-readable message (never a raw URL),
 *   the HTTP status when the failure was transport-level, and the durable
 *   audit callId when a started row exists. A failure NEVER throws across
 *   the pipeline boundary (contract-violation guards excepted).
 */
export type PackagingOcrAttempt =
  | { ok: true; data: PackagingOcrData & { contentHash: string | null }; attempts: number }
  | {
      ok: false;
      reasonCode: OcrFailureReason;
      redactedMessage: string;
      httpStatus?: number;
      callId?: string | null;
      attempts: number;
    };

// ─── Repetition-tail mitigation (P3-T2) ─────────────────────────────────────

/** Frequency penalty applied to the single repetition-retry attempt. */
export const REPETITION_RETRY_FREQUENCY_PENALTY = 0.3;

/** Texts shorter than this never trigger the repetition heuristic. */
const REPETITION_MIN_TAIL_CHARS = 60;

/** Maximum token n-gram length probed by the repetition heuristic. */
const REPETITION_MAX_NGRAM = 12;

/** Consecutive repeats of one n-gram that count as a repetition tail. */
const REPETITION_REPEAT_COUNT = 3;

/**
 * Consecutive repeats required when the repeated unit is a SINGLE token.
 * Post-review fixup (P3-T2): legitimately repeated printed lines can place
 * two or three identical consecutive words on a label (e.g. "boom boom boom"
 * or an ingredient echo), so a lone token must repeat ≥6 times before the
 * heuristic fires. Multi-token units (n≥2) keep the stricter structural
 * signal at 3 consecutive repeats — an n-gram phrase repeating 3× in a row
 * is essentially never legitimate printed text.
 */
const REPETITION_SINGLE_TOKEN_REPEAT_COUNT = 6;

/**
 * Detect a degenerate "repetition tail" in a VLM response: within the last
 * ~200 characters, some token n-gram repeats consecutively — multi-token
 * n-grams at ≥3 repeats, single tokens at ≥6 repeats (see
 * REPETITION_SINGLE_TOKEN_REPEAT_COUNT for why they differ). Short texts
 * never trigger.
 * Pure function — unit-tested in src/tests/unit/packaging-ocr-repetition.test.ts.
 */
export function detectRepetitionTail(text: string): boolean {
  if (!text || text.trim().length < REPETITION_MIN_TAIL_CHARS) return false;
  const tail = text.slice(-200);
  const tokens = tail.split(/\s+/).filter(Boolean);
  if (tokens.length < REPETITION_REPEAT_COUNT) return false;
  const maxN = Math.max(1, Math.min(REPETITION_MAX_NGRAM, Math.floor(tokens.length / REPETITION_REPEAT_COUNT)));
  for (let n = maxN; n >= 1; n--) {
    const repeatsNeeded = n === 1 ? REPETITION_SINGLE_TOKEN_REPEAT_COUNT : REPETITION_REPEAT_COUNT;
    for (let i = 0; i + repeatsNeeded * n <= tokens.length; i++) {
      let allEqual = true;
      for (let k = 1; k < repeatsNeeded && allEqual; k++) {
        for (let j = 0; j < n; j++) {
          if (tokens[i + j] !== tokens[i + k * n + j]) {
            allEqual = false;
            break;
          }
        }
      }
      if (allEqual) return true;
    }
  }
  return false;
}

/**
 * Classify a thrown VLM transport error into the failure taxonomy,
 * preserving the existing AbortError/TimeoutError handling (callVlm wraps
 * AbortSignal timeouts into a "timed out" message). Messages are redacted
 * before being embedded in results or audit rows.
 */
function classifyVlmError(err: unknown): {
  reasonCode: OcrFailureReason;
  redactedMessage: string;
  httpStatus?: number;
} {
  const errorName = err instanceof Error ? err.name : '';
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redactTransportText(rawMessage);

  if (errorName === 'AbortError' || errorName === 'TimeoutError' || /\btimed out\b/i.test(message)) {
    return { reasonCode: 'timeout', redactedMessage: message };
  }
  if (/empty response/i.test(message)) {
    return { reasonCode: 'empty_response', redactedMessage: message };
  }
  const redirectStatus = message.match(/HTTP redirect \((\d{3})\)/);
  if (redirectStatus) {
    return { reasonCode: 'http_error', redactedMessage: message, httpStatus: Number(redirectStatus[1]) };
  }
  const statusMatch = message.match(/VLM request failed:\s*(\d{3})/);
  if (statusMatch) {
    return { reasonCode: 'http_error', redactedMessage: message, httpStatus: Number(statusMatch[1]) };
  }
  return { reasonCode: 'transport_error', redactedMessage: message };
}

/**
 * Run one structured packaging-OCR attempt and return a coded result.
 *
 * This is the single core entry point for all packaging OCR. It:
 * 1. Resolves the VLM route (frozen run-bound route or legacy settings)
 * 2. Checks the circuit breaker (BEFORE any started audit row)
 * 3. Loads the image (local path or remote URL)
 * 4. Calls the local VLM with a comprehensive JSON prompt (bounded retry
 *    around the TRANSPORT ONLY when the packaging-OCR retry flag is enabled
 *    (BAYSTATE_CMS_OCR_RETRIES_ENABLED via getOcrStageFlags)
 * 5. Parses and validates the response
 *
 * Failure contract: every terminal path emits exactly one reason code and
 * never throws across the pipeline boundary. Run-bound calls still write
 * insertModelCallStart before any transport and a terminal audit row on
 * every path (exactly once, even across retries).
 */
export async function runPackagingOcrAttempt(
  params: ExtractPackagingOcrParams,
): Promise<PackagingOcrAttempt> {
  const { imageUrl, workspacePath, imageLocalPath, imageSourceUrl, sku, fetchFn, modelFetchFn } = params;

  const auditCtx = params.modelCall ?? null;
  const runBound = Boolean(params.snapshot);

  /** Coded failure constructor — every terminal path funnels through here. */
  const fail = (
    reasonCode: OcrFailureReason,
    redactedMessage: string,
    opts?: { httpStatus?: number; callId?: string | null },
    attempts = 0,
  ): PackagingOcrAttempt => ({
    ok: false,
    reasonCode,
    redactedMessage,
    ...(opts?.httpStatus !== undefined ? { httpStatus: opts.httpStatus } : {}),
    ...(opts?.callId ? { callId: opts.callId } : {}),
    attempts,
  });

  // Boundary-level parity with the cloud VLM transport: a supplied audit
  // context WITHOUT a runtime snapshot cannot be validated against a frozen
  // plan — fail closed before any config resolution or transport. Correctness
  // of the exported single transport entry point cannot depend on every
  // caller passing both arguments.
  if (!runBound && auditCtx) {
    throw new Error(
      'Local VLM call supplied a model-call audit context without a runtime snapshot.',
    );
  }

  // Resolve the local VLM route. Run-bound calls MUST use the frozen route
  // captured in the snapshot plan (never mutable `ollama_vlm` settings) and
  // MUST pass plan compatibility. A run-bound call without a frozen route or
  // with a non-loopback frozen URL is denied BEFORE any transport (image
  // fetch or model call) and recorded as `policy_denied` — never a false
  // 'local' success row.
  let vlmConfig: VlmConfig | null;
  let routeLocality: 'local' | 'trusted_lan' | 'cloud' | null = null;
  if (runBound) {
    if (!auditCtx) {
      throw new Error(
        'Run-bound local VLM call without a model-call audit context (no compatible frozen plan).',
      );
    }
    // The single transport entry point must bind to the snapshot itself:
    // assert plan compatibility (schema-v2, digests, entry, versions,
    // context) BEFORE any transport, then derive the route and the audit
    // digest from the frozen plan entry — caller-supplied route/digest
    // values are never trusted for run-bound calls.
    assertModelPlanCompatible(params.snapshot, 'evidence_extraction', auditCtx);
    const planEntry = getModelExecutionPlanEntry(params.snapshot, 'evidence_extraction');
    const planDigest = params.snapshot?.modelExecutionPlan?.digest ?? '';
    const frozen = planEntry?.localVlmBaseUrl
      ? { baseUrl: planEntry.localVlmBaseUrl, model: planEntry.localVlmModel ?? '' }
      : null;
    if (!frozen || !frozen.model) {
      recordTerminalPreflight(
        auditCtx,
        planDigest,
        MODEL_CALL_STATUS.policyDenied,
        'Local VLM route denied: no frozen local VLM route in the run snapshot plan.',
      );
      return fail('policy_denied', 'Local VLM route denied: no frozen local VLM route in the run snapshot plan.');
    }
    // A caller-supplied route that disagrees with the frozen plan entry is a
    // tampering signal — deny rather than trust the caller.
    const supplied = params.frozenVlmRoute ?? null;
    if (supplied && (supplied.baseUrl !== frozen.baseUrl || supplied.model !== frozen.model)) {
      recordTerminalPreflight(
        auditCtx,
        planDigest,
        MODEL_CALL_STATUS.policyDenied,
        'Local VLM route denied: supplied route does not match the frozen plan entry.',
      );
      return fail('policy_denied', 'Local VLM route denied: supplied route does not match the frozen plan entry.');
    }
    let isPermittedEndpoint = false;
    if (isLoopbackBaseUrl(frozen.baseUrl)) {
      isPermittedEndpoint = true;
      routeLocality = 'local';
    } else {
      let isLan = false;
      try {
        const host = new URL(frozen.baseUrl).hostname;
        isLan = isPrivateLanHost(host);
      } catch {
        isLan = false;
      }
      if (isLan) {
        if (
          params.snapshot?.modelPolicy?.imageDataSharing === 'trusted_lan_allowed' ||
          params.snapshot?.modelPolicy?.imageDataSharing === 'cloud_allowed'
        ) {
          isPermittedEndpoint = true;
          routeLocality = 'trusted_lan';
        }
      } else {
        if (params.snapshot?.modelPolicy?.imageDataSharing === 'cloud_allowed') {
          isPermittedEndpoint = true;
          routeLocality = 'cloud';
        }
      }
    }
    if (!isPermittedEndpoint) {
      const reason = `Local VLM route denied: frozen base URL ${redactImageUrl(frozen.baseUrl)} is not permitted under imageDataSharing policy "${params.snapshot?.modelPolicy?.imageDataSharing}".`;
      recordTerminalPreflight(
        auditCtx,
        planDigest,
        MODEL_CALL_STATUS.policyDenied,
        reason,
      );
      return fail('policy_denied', reason);
    }

    const normalizeUrl = (u: string) => u.replace(/\/+$/, '');
    const activeVlm = params.vlmConfigOverride ?? getVlmConfig();
    const matchingConfig =
      activeVlm && normalizeUrl(activeVlm.baseUrl) === normalizeUrl(frozen.baseUrl)
        ? activeVlm
        : null;

    let transport: 'openai-compatible' | 'ollama-native' =
      matchingConfig?.transport ??
      (frozen.baseUrl.includes('/v1') || frozen.baseUrl.includes('api.openai.com') ? 'openai-compatible' : 'ollama-native');
    let credential = matchingConfig?.credential;

    if (!credential) {
      try {
        const fullRouting = getFullAiRoutingConfig();
        for (const conn of Object.values(fullRouting.connections)) {
          if (normalizeUrl(conn.baseUrl) === normalizeUrl(frozen.baseUrl) && conn.credential) {
            credential = conn.credential;
            if (conn.transport) transport = conn.transport;
            break;
          }
        }
      } catch {
        // AI routing config lookup is best-effort
      }
    }

    vlmConfig = {
      baseUrl: frozen.baseUrl,
      model: frozen.model,
      enabled: true,
      transport,
      ...(credential ? { credential } : {}),
    };
  } else {
    vlmConfig = params.vlmConfigOverride ?? getVlmConfig();
    if (!vlmConfig?.enabled) {
      console.log(`[PackagingOcr] VLM not enabled — skipping OCR for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
      return fail('not_configured', OCR_FAILURE_REASON_MESSAGES.not_configured);
    }
    if (isLoopbackBaseUrl(vlmConfig.baseUrl)) {
      routeLocality = 'local';
    } else {
      try {
        routeLocality = isPrivateLanHost(new URL(vlmConfig.baseUrl).hostname) ? 'trusted_lan' : 'cloud';
      } catch {
        routeLocality = null;
      }
    }
  }

  // P3-T2 greedy-decoding default: OCR attempts send temperature 0 (less
  // hallucination/prattle than sampled decoding) unless the caller's
  // VlmConfig.options explicitly overrides it.
  if (vlmConfig.options?.temperature === undefined) {
    vlmConfig = { ...vlmConfig, options: { ...vlmConfig.options, temperature: 0 } };
  }

  // P1-T2 circuit breaker — checked BEFORE insertModelCallStart so an open
  // circuit yields a coded `circuit_open` result with NO started audit row.
  // Keyed by baseUrl|model so frozen run-bound routes get their own bucket.
  // A granted half-open probe that exits early on a non-transport failure
  // (e.g. image load) self-heals via the probe lease in the breaker.
  const breakerKey = buildCircuitBreakerKey(vlmConfig.baseUrl, vlmConfig.model);
  const circuit = checkCircuit(breakerKey);
  if (!circuit.allowed) {
    const message = `${OCR_FAILURE_REASON_MESSAGES.circuit_open} (state=${circuit.state}, route=${redactImageUrl(vlmConfig.baseUrl)}|${vlmConfig.model}).`;
    console.warn(`[PackagingOcr] Circuit breaker open — skipping OCR for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
    return fail('circuit_open', message);
  }

  // Durable audit for run-bound local VLM calls (issue #17 E): insert the
  // `started` row BEFORE any transport (image fetch + model call) so the
  // model is never invoked without provenance. Without a durable start row
  // the model is never invoked.
  let callId: string | null = null;
  if (auditCtx) {
    const hashes = computePromptHashes(PACKAGING_OCR_PROMPT, '');
    const provider =
      vlmConfig?.transport === 'openai-compatible' || vlmConfig?.baseUrl?.includes('openai')
        ? 'openai'
        : 'ollama';
    callId = insertModelCallStart({
      runId: auditCtx.runId,
      stageName: auditCtx.stage,
      operation: auditCtx.operation,
      attempt: auditCtx.attempt,
      provider,
      model: vlmConfig?.model ?? 'unknown',
      locality: routeLocality ?? null,
      snapshotHash: auditCtx.snapshotHash,
      modelPolicyDigest: params.snapshot?.modelExecutionPlan?.digest ?? params.modelPolicyDigest ?? '',
      promptTemplateVersion: auditCtx.promptTemplateVersion,
      ruleVersion: auditCtx.ruleVersion,
      systemPromptHash: hashes.systemPromptHash,
      userPromptHash: hashes.userPromptHash,
    });
  }

  // Load the image (P1-T1: coded classification for every load failure)
  const imageOutcome = await loadImageWithReason(imageUrl, workspacePath, imageLocalPath, fetchFn);
  if (!imageOutcome.base64 || imageOutcome.failure) {
    const failure = imageOutcome.failure ?? {
      reasonCode: 'no_image' as OcrFailureReason,
      message: OCR_FAILURE_REASON_MESSAGES.no_image,
    };
    console.warn(`[PackagingOcr] Could not load image for OCR (${failure.reasonCode}): ${redactImageUrl(imageUrl ?? '')}`);
    if (callId) {
      // PR3 hardening C: assert ownership before the terminal update.
      params.assertHeld?.();
      completeModelCall(callId, {
        status: MODEL_CALL_STATUS.failed,
        durationMs: 0,
        errorMessage: failure.message,
        estimatedCostUsd: routeLocality === 'local' ? 0 : null,
        costBasis: routeLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
    }
    return fail(failure.reasonCode, failure.message, { httpStatus: failure.httpStatus, callId });
  }
  const base64Image = imageOutcome.base64;

  // Round-4: byte-hash binding — the SHA-256 of the EXACT downloaded bytes.
  // OCR facts are bound to this hash so image A's facts can never authorize
  // identity while image B is being inspected.
  const contentHash = sha256Hex(Buffer.from(base64Image, 'base64'));

  const startedAt = Date.now();
  let terminalWritten = false;
  const markTerminal = (
    status: typeof MODEL_CALL_STATUS[keyof typeof MODEL_CALL_STATUS],
    errorMessage?: string,
  ): boolean => {
    if (!callId) return true;
    // PR3 hardening C: assert ownership immediately before EVERY terminal
    // model-call update — a rejected assertion throws `HeartbeatLostError`
    // and the update is skipped (no stale-owner write after a reclaim).
    params.assertHeld?.();
    terminalWritten = true;
    return completeModelCall(callId, {
      status,
      durationMs: Date.now() - startedAt,
      errorMessage,
      estimatedCostUsd: routeLocality === 'local' ? 0 : null,
      costBasis: routeLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
    });
  };

  // Call VLM
  console.log(`[PackagingOcr] Running OCR on ${sku ?? redactImageUrl(imageUrl ?? '')} using ${vlmConfig.model}`);
  // Bounded retry around the TRANSPORT ONLY (P1-T1). Parse,
  // coercion, and image failures are never retried. The durable audit
  // terminal write happens ONCE after the loop resolves so a retried
  // transient failure never produces a second audit row.
  // Post-review fixup 7a: the gate consults `getOcrStageFlags()` (which
  // re-reads BAYSTATE_CMS_OCR_RETRIES_ENABLED per call, preserving env
  // behavior) instead of the raw env — enabling in-memory overrides without
  // a redeploy. No import cycle: ocr-stage-flags.ts imports nothing from
  // src/onboarding.
  const retriesEnabled = getOcrStageFlags().packagingOcrRetriesEnabled;
  const maxTransportAttempts = retriesEnabled ? 2 : 1;
  let transportAttempts = 0;
  let rawResponse: string | null = null;
  let executedVlmTarget: { connectionId: string; modelId: string } | null = null;
  while (transportAttempts < maxTransportAttempts) {
    transportAttempts += 1;
    try {
      if (!runBound && !modelFetchFn && !fetchFn) {
        // Live OCR through the AI Compute visionOcr dispatcher: executes the
        // configured fallback and enforces the image data-sharing policy.
        // Frozen (run-bound) and gateway-bound (Product Intelligence) calls
        // keep the exact-endpoint direct invocation below.
        // Post-review fixup 6: sampling options (greedy temperature 0)
        // thread through into the dispatcher request body instead of being
        // silently dropped as dispatcher-owned.
        const dispatched = await callVlmWithDispatcher(PACKAGING_OCR_PROMPT, base64Image, vlmConfig.options);
        rawResponse = dispatched.content;
        executedVlmTarget = dispatched.executedTarget;
      } else {
        rawResponse = await callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig, modelFetchFn ?? fetchFn);
      }
      recordSuccess(breakerKey);
      break;
    } catch (err: any) {
      const classified = classifyVlmError(err);
      // Only TRANSIENT transport-class failures feed the circuit breaker —
      // parse, coercion, and DETERMINISTIC response errors must never deny
      // a route. `isTransientOcrFailure` gates on the coded reason AND the
      // HTTP status: timeout/transport_error are always transient;
      // http_error counts only for 429/5xx. Deterministic 400/404/3xx
      // anti-SSRF failures therefore neither trip the breaker nor get retried.
      if (isTransientOcrFailure(classified.reasonCode, classified.httpStatus)) {
        recordTransportFailure(breakerKey);
      }
      if (
        retriesEnabled &&
        transportAttempts < maxTransportAttempts &&
        isTransientOcrFailure(classified.reasonCode, classified.httpStatus)
      ) {
        console.warn(
          `[PackagingOcr] Transient VLM failure (${classified.reasonCode}); retrying ` +
          `attempt ${transportAttempts + 1}/${maxTransportAttempts} for ${sku ?? redactImageUrl(imageUrl ?? '')}`,
        );
        continue;
      }
      if (!terminalWritten && callId) {
        try {
          markTerminal(MODEL_CALL_STATUS.failed, classified.redactedMessage);
        } catch (terminalErr) {
          // PR3 hardening C: ownership loss MUST propagate out of this
          // attempt so a stale owner stops processing further images/cloud
          // legs and writes no further started rows.
          if (terminalErr instanceof HeartbeatLostError) throw terminalErr;
          // best-effort; the primary warning still uses the redacted reason
        }
      }
      console.warn(`[PackagingOcr] VLM call failed for ${sku ?? redactImageUrl(imageUrl ?? '')}: ${classified.redactedMessage}`);
      return fail(classified.reasonCode, classified.redactedMessage, { httpStatus: classified.httpStatus, callId }, transportAttempts);
    }
  }

  // P3-T2 hallucination mitigation: when the response ends in a degenerate
  // repetition tail AND retries are enabled (packagingOcrRetriesEnabled),
  // retry ONCE with a frequency penalty. Success-with-retry is recorded via
  // an additive parser metadata note (`retried_repetition`) and the raised
  // attempts count — no schema change.
  let retriedRepetition = false;
  if (
    retriesEnabled &&
    rawResponse &&
    detectRepetitionTail(rawResponse)
  ) {
    // Post-review fixup 3: retain the ORIGINAL response — a penalized retry
    // that throws or returns unparseable text must not discard a first
    // response we can still try to parse; we fall back to it.
    transportAttempts += 1;
    console.warn(`[PackagingOcr] Repetition tail detected; retrying once with frequency_penalty=${REPETITION_RETRY_FREQUENCY_PENALTY} for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
    const penaltyConfig: VlmConfig = {
      ...vlmConfig,
      options: { ...vlmConfig.options, temperature: 0, frequencyPenalty: REPETITION_RETRY_FREQUENCY_PENALTY },
    };
    try {
      let retryResponse: string;
      if (executedVlmTarget) {
        // Dispatcher path: the retry is a fresh sampled call through the
        // same dispatcher, now carrying the greedy + penalty options.
        const dispatched = await callVlmWithDispatcher(PACKAGING_OCR_PROMPT, base64Image, penaltyConfig.options);
        executedVlmTarget = dispatched.executedTarget;
        retryResponse = dispatched.content;
      } else {
        retryResponse = await callVlm(PACKAGING_OCR_PROMPT, base64Image, penaltyConfig, modelFetchFn ?? fetchFn);
      }
      if (retryResponse.length >= 3 && parseJsonFromVlmResponse(retryResponse)) {
        rawResponse = retryResponse;
        retriedRepetition = true;
      } else {
        // Retry returned empty/unparseable garbage — keep rawResponse as-is
        // and let the normal parser decide (it falls through to the original).
        console.warn(`[PackagingOcr] Repetition retry returned an unparseable response; using the original response for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
      }
    } catch (err: any) {
      if (err instanceof HeartbeatLostError) throw err;
      const classified = classifyVlmError(err);
      // Transport failure on the penalized retry is NOT terminal — fall
      // back to the original response rather than failing the item.
      console.warn(`[PackagingOcr] Repetition retry failed for ${sku ?? redactImageUrl(imageUrl ?? '')}: ${classified.redactedMessage}; using the original response`);
    }
  }

  if (!rawResponse || rawResponse.length < 3) {
    if (callId) markTerminal(MODEL_CALL_STATUS.failed, 'Empty or too-short response from local VLM.');
    console.warn(`[PackagingOcr] Empty or too-short response from VLM for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
    return fail('empty_response', OCR_FAILURE_REASON_MESSAGES.empty_response, { callId }, transportAttempts);
  }

  // Parse
  const responseExcerpt = rawResponse.slice(0, 200);
  const parsed = parseJsonFromVlmResponse(rawResponse);
  if (!parsed) {
    if (callId) markTerminal(MODEL_CALL_STATUS.failed, 'Could not parse JSON from local VLM response.');
    console.warn(`[PackagingOcr] Could not parse JSON from VLM response for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
    return fail('unparseable_json', OCR_FAILURE_REASON_MESSAGES.unparseable_json, { callId }, transportAttempts);
  }

  // Coerce and validate
  // P2 redaction pass: the persisted metadata never carries raw credentials,
  // query strings, or signed-URL payloads. `imageSourceUrl` keeps a bounded,
  // stripped reference for debugging; `imageSourceDigest` preserves exact
  // provenance correlation via SHA-256 of the raw value. Non-string values
  // are passed through UNCHANGED so the schema still fails closed on them.
  const rawSourceRef = imageSourceUrl ?? imageUrl;
  const metadata = {
    imageSourceUrl: typeof rawSourceRef === 'string' ? redactImageUrl(rawSourceRef) : rawSourceRef ?? null,
    imageSourceDigest: typeof rawSourceRef === 'string' ? sha256Hex(rawSourceRef) : null,
    imageLocalPath: imageLocalPath ?? null,
    model: executedVlmTarget ? `${executedVlmTarget.connectionId}:${executedVlmTarget.modelId}` : vlmConfig.model,
    extractedAt: new Date().toISOString(),
    // P3-T2: additive note when a repetition-tail retry produced this data.
    parser: retriedRepetition ? 'packaging-ocr.ts (retried_repetition)' : 'packaging-ocr.ts',
    rawResponseExcerpt: responseExcerpt,
    ...(callId ? { modelCallIds: [callId] } : {}),
  };

  const result = coercePackagingOcrData(parsed, metadata);
  if (!result) {
    if (callId) markTerminal(MODEL_CALL_STATUS.failed, 'Schema coercion failed for local VLM response.');
    console.warn(`[PackagingOcr] Schema coercion failed for ${sku ?? redactImageUrl(imageUrl ?? '')}`);
    return fail('schema_coercion_failed', OCR_FAILURE_REASON_MESSAGES.schema_coercion_failed, { callId }, transportAttempts);
  }

  // Success: the terminal row must be durable before the result is returned.
  if (callId) {
    const terminalDurable = markTerminal(MODEL_CALL_STATUS.success);
    if (!terminalDurable) {
      console.error(`[PackagingOcr] Local VLM call ${callId} terminal update failed; discarding OCR output.`);
      return fail('audit_terminal_write_failed', OCR_FAILURE_REASON_MESSAGES.audit_terminal_write_failed, { callId }, transportAttempts);
    }
  }

  const fieldCount = Object.entries(result).filter(
    ([k, v]) => k !== 'metadata' && k !== 'confidenceByField' && v !== null && !(Array.isArray(v) && v.length === 0),
  ).length;

  console.log(
    `[PackagingOcr] ✓ OCR complete for ${sku ?? redactImageUrl(imageUrl ?? '')}: ${fieldCount} fields populated ` +
    `(productName="${result.productName ?? 'N/A'}", species=[${result.species.join(', ')}], ` +
    `form="${result.productForm ?? 'N/A'}", labels=[${result.dietaryLabels.join(', ')}])`,
  );

  return { ok: true, data: { ...result, contentHash }, attempts: transportAttempts };
}

/**
 * Legacy single-result adapter (P1-T1): exact same signature as before the
 * structured-attempt refactor, so ALL existing callers compile unchanged and
 * still receive `null` on any failure. New callers should use
 * `runPackagingOcrAttempt` for the coded failure taxonomy.
 */
export async function extractPackagingOcr(
  params: ExtractPackagingOcrParams,
): Promise<(PackagingOcrData & { contentHash: string | null }) | null> {
  const result = await runPackagingOcrAttempt(params);
  return result.ok ? result.data : null;
}

// ─── OCR result merging (multi-image support) ────────────────────────────────

/**
 * Merge multiple PackagingOcrData results from different images of the same
 * product into a single combined result.
 *
 * Strategy:
 * - **Scalar fields** (productName, brand, flavorVariety, etc.): Highest-confidence
 *   wins (uses confidenceByField; falls back to first non-null when no confidence data).
 * - **Array fields** (ingredients, claims, dietaryLabels, species, etc.):
 *   Unioned across all results, deduplicated, preserving order.
 * - **confidenceByField**: Per-field, the maximum confidence wins.
 * - **metadata**: Keeps the primary image's metadata.
 */
export function mergeOcrResults(results: PackagingOcrData[]): PackagingOcrData {
  if (results.length === 0) throw new Error('Cannot merge empty OCR results');
  if (results.length === 1) return results[0];

  const merged: Record<string, any> = {};

  // Scalar fields — highest-confidence wins
  // For each scalar field, check all results' confidenceByField,
  // pick the value from the result with the highest confidence.
  // Falls back to first-non-null when no confidence data exists.
  const scalarFields: Array<keyof PackagingOcrData> = [
    // FIX-C review round 2: `upc` participates like every other scalar —
    // without it, two UPC-only image results merged to an all-null object
    // and callers discarded a successful barcode transcription.
    'productName', 'brand', 'upc', 'flavorVariety', 'color', 'material',
    'size', 'weight', 'count', 'lifeStage', 'breedSize', 'productForm',
  ];
  for (const field of scalarFields) {
    let bestVal: unknown = null;
    let bestConf = -1;
    for (const r of results) {
      const val = r[field];
      if (val === null || val === undefined) continue;
      const conf = r.confidenceByField?.[field] ?? -1;
      if (conf > bestConf || (conf === -1 && bestVal === null)) {
        bestVal = val;
        bestConf = conf;
      }
    }
    merged[field] = bestVal ?? null;
  }

  // Array fields — union, deduplicated
  const arrayFields: Array<keyof PackagingOcrData> = [
    'species', 'healthConcernFunction', 'dietaryLabels',
    'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
  ];
  for (const field of arrayFields) {
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const r of results) {
      const arr = r[field];
      if (Array.isArray(arr)) {
        for (const val of arr) {
          if (val && !seen.has(val.toLowerCase())) {
            seen.add(val.toLowerCase());
            combined.push(val);
          }
        }
      }
    }
    merged[field] = combined;
  }

  // confidenceByField — take max per field
  const mergedConfidence: Record<string, number> = {};
  for (const r of results) {
    if (r.confidenceByField) {
      for (const [field, conf] of Object.entries(r.confidenceByField)) {
        if (conf !== null && conf !== undefined) {
          mergedConfidence[field] = Math.max(mergedConfidence[field] ?? 0, conf);
        }
      }
    }
  }
  merged.confidenceByField = mergedConfidence;

  // metadata — keep the primary image's metadata, but UNION the durable
  // model-call IDs across ALL images' results so every influencing call is
  // traceable from the merged OCR evidence (issue #17 pass 4c). A call that
  // supplied a value selected by the merge must never be dropped.
  const callIdUnion = new Set<string>();
  for (const r of results) {
    const ids = (r.metadata as { modelCallIds?: string[] } | null)?.modelCallIds ?? [];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (id && typeof id === 'string') callIdUnion.add(id);
      }
    }
  }
  const mergedMetadata = results[0].metadata
    ? { ...results[0].metadata }
    : (callIdUnion.size > 0 ? {} : null);
  if (callIdUnion.size > 0 && mergedMetadata) {
    (mergedMetadata as { modelCallIds?: string[] }).modelCallIds = [...callIdUnion];
  }
  merged.metadata = mergedMetadata;

  // Byte-hash binding must survive the merge: callers bind OCR facts to
  // `contentHash` (the SHA-256 of the downloaded primary-image bytes), so a
  // multi-image merge carries the PRIMARY image's hash forward instead of
  // silently dropping it.
  merged.contentHash = (results[0] as any).contentHash ?? null;

  return merged as PackagingOcrData;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a candidate local image path STRICTLY inside the workspace.
 *
 * Containment rules (FIX-A review round 2):
 * - ABSOLUTE candidates are rejected OUTRIGHT (POSIX leading `/` and Windows
 *   drive prefixes): production writers only ever store URLs or relative
 *   paths, so an absolute candidate is never legitimate and must never be
 *   resolved-and-accepted.
 * - Relative candidates are joined onto the resolved workspace root and
 *   normalized; any result escaping the root (`..` traversal) returns null.
 * - Symlink escape is handled by the CALLER's realpath re-check
 *   (readLocalFile), which resolves both the candidate and the workspace
 *   root to their filesystem-real paths before reading.
 *
 * Returns the lexically-contained absolute path, or null when the candidate
 * is empty/absolute/escaping (callers treat null as "candidate missing" and
 * continue to the next load strategy).
 */
function resolveWorkspaceContainedPath(workspacePath: string, candidate: string): string | null {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (!trimmed) return null;
  if (nodePath.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  const base = nodePath.resolve(workspacePath);
  const resolved = nodePath.resolve(base, trimmed);
  if (resolved !== base && !resolved.startsWith(base + nodePath.sep)) return null;
  return resolved;
}
