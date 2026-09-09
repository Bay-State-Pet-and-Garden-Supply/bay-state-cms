/**
 * Slice 4-SERVER — versioned, sanitized, BOUNDED live-activity envelope
 * (council plan §4.2 + §4.3).
 *
 * Display contract ONLY. The envelope carries allowlisted facts (event type,
 * canonical stage, unchanged stage status, item ID, vetted reason code) plus
 * a fixed-template summary of at most 160 display characters. It never
 * carries raw error strings, product evidence, URLs, tokens, HTML, model
 * prompts, cookies, or logs. Timestamps are deliberately absent: the UI
 * labels "Received at …" from its own receipt clock, never from event data.
 *
 * Unknown, malformed, or oversized frames are dropped (or summarized
 * generically with a safe-refetch trigger) — never rendered, never counted.
 */
import * as z from 'zod';
import { STAGE_ORDER_V1, STAGE_ORDER_V2, V1_TO_V2, V2_TO_V1, type StageV1, type StageV2 } from '../onboarding-stage-vocabulary';

/** Wire schema version for the v2 live-activity envelope. */
export const LIVE_ACTIVITY_SCHEMA_VERSION = 1 as const;
/** Stage vocabulary version carried by v2 envelopes (canonical v2 values). */
export const LIVE_ACTIVITY_VOCABULARY_VERSION = 2 as const;

/** Maximum display characters for a rendered activity summary. */
export const LIVE_ACTIVITY_MAX_SUMMARY_CHARS = 160;
/** Maximum accepted SSE wire frame, UTF-8 bytes. Larger frames are dropped. */
export const LIVE_ACTIVITY_MAX_FRAME_BYTES = 16 * 1024;

/**
 * Unchanged StageStatus spellings allowed on the wire (byte-identical to
 * StageStatusEnum). Duplicated literally — NOT imported from
 * shared/schemas/onboarding.ts — so this module stays collectible under
 * Vitest despite the pre-existing named-zod chain breakage there. Exact
 * parity is asserted by the Bun suite onboarding-sse-versioning.test.ts.
 */
export const LIVE_ACTIVITY_STAGE_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'needs_input',
  'skipped',
] as const;

/** Named live event types. `welcome`/`ping` are connection frames, never activity. */
export const LIVE_ACTIVITY_EVENT_TYPES = [
  'item:status',
  'batch:progress',
  'batch:complete',
  'batch:error',
] as const;

export type LiveActivityEventType = (typeof LIVE_ACTIVITY_EVENT_TYPES)[number];

export const LiveActivityEventTypeEnum = z.enum(LIVE_ACTIVITY_EVENT_TYPES);

/** Connection frames: transport connectivity, NOT worker activity. */
export const LIVE_CONNECTION_FRAME_TYPES = ['welcome', 'ping'] as const;

export type LiveConnectionFrameType = (typeof LIVE_CONNECTION_FRAME_TYPES)[number];

/**
 * Vetted reason codes — the ONLY machine-readable causes a v2 envelope may
 * carry. Raw error strings are mapped to one of these (or dropped), never
 * forwarded.
 */
export const LIVE_ACTIVITY_REASON_CODES = [
  'advanced',
  'claimed',
  'retry_queued',
  'failed',
  'conflict_found',
  'profile_blocked',
  'family_barrier',
  'domain_released',
  'reviewed',
  'approval_recorded',
  'export_drafts_created',
  'batch_completed',
  'other',
] as const;

export type LiveActivityReasonCode = (typeof LIVE_ACTIVITY_REASON_CODES)[number];

export const LiveActivityReasonCodeEnum = z.enum(LIVE_ACTIVITY_REASON_CODES);

/** Canonical v2 stage value (or absent — never invented). */
const CanonicalStageField = z
  .enum(['route_sources', 'find_product_page', 'collect_details', 'prepare_listing', 'review_listings', 'create_drafts'])
  .optional();

/** Unchanged StageStatus value (spelling preserved, never renamed). Absent when unknown. */
const LiveStageStatusField = z.enum(LIVE_ACTIVITY_STAGE_STATUSES).optional();
/**
 * v2 live-activity envelope. Strict: unknown keys are rejected, never
 * silently kept.
 */
export const LiveActivityEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(LIVE_ACTIVITY_SCHEMA_VERSION),
    stageVocabularyVersion: z.literal(LIVE_ACTIVITY_VOCABULARY_VERSION),
    event: LiveActivityEventTypeEnum,
    batchId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128).optional(),
    /** Canonical v2 stage. Absent when the source event carries none. */
    stage: CanonicalStageField,
    stageStatus: LiveStageStatusField,
    /** Fixed-template summary, at most 160 display characters. */
    summary: z.string().min(1).max(LIVE_ACTIVITY_MAX_SUMMARY_CHARS),
    reasonCode: LiveActivityReasonCodeEnum.optional(),
    /** When true the UI must refetch server counts (displays a gap marker). */
    refetchSuggested: z.boolean().optional(),
  })
  .strict();

export type LiveActivityEnvelope = z.infer<typeof LiveActivityEnvelopeSchema>;

/** Raw SSE wire frame before classification (what the EventSource delivers). */
export const LiveActivityFrameSchema = z
  .object({
    event: z.string().min(1).max(64),
    data: z.string().max(LIVE_ACTIVITY_MAX_FRAME_BYTES * 4),
  })
  .strict();

export type LiveActivityFrame = z.infer<typeof LiveActivityFrameSchema>;

/** UTF-8 byte length (multi-byte aware — never String.length for budgets). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** True when the raw wire frame fits the accepted budget. */
export function isFrameWithinBudget(frameBytes: number): boolean {
  return Number.isInteger(frameBytes) && frameBytes >= 0 && frameBytes <= LIVE_ACTIVITY_MAX_FRAME_BYTES;
}

/**
 * Map a pipeline stage literal to its canonical v2 value (Slice 5b native:
 * accepts either spelling — the worker emits canonical v2, stored v1 rows
 * still normalize). Unknown values return null (caller drops or
 * genericizes — never invents).
 */
export function toCanonicalLiveStage(value: unknown): StageV2 | null {
  if (typeof value !== 'string') return null;
  if ((STAGE_ORDER_V2 as readonly string[]).includes(value)) return value as StageV2;
  return (V1_TO_V2 as Readonly<Record<string, StageV2>>)[value] ?? null;
}

/**
 * Map a pipeline stage literal to its legacy v1 wire spelling (either
 * input spelling accepted; unknown returns null so v1 serialization can
 * leave non-stage payloads byte-identical).
 */
export function toStoredLiveStage(value: unknown): StageV1 | null {
  if (typeof value !== 'string') return null;
  if ((STAGE_ORDER_V1 as readonly string[]).includes(value)) return value as StageV1;
  return (V2_TO_V1 as Readonly<Record<string, StageV1>>)[value] ?? null;
}
/** Connection frame classification: transport-only, never work activity. */
export function isConnectionFrame(eventType: string): eventType is LiveConnectionFrameType {
  return (LIVE_CONNECTION_FRAME_TYPES as readonly string[]).includes(eventType);
}

/** Live activity classification: exactly the four named event types. */
export function isLiveActivityEvent(eventType: string): eventType is LiveActivityEventType {
  return (LIVE_ACTIVITY_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface CoercedLiveActivity {
  /** Parsed v2 envelope, or null when the frame was dropped. */
  envelope: LiveActivityEnvelope | null;
  /** True when the frame was dropped (malformed/oversized/unknown). */
  dropped: boolean;
  /** True when the UI should refetch server counts after this frame. */
  refetchSuggested: boolean;
}

/**
 * Classify + validate one raw SSE frame for display.
 * Returns the parsed envelope, or a dropped verdict with refetch guidance.
 * Never throws on hostile input.
 */
export function coerceLiveActivityFrame(rawEvent: string, rawData: string): CoercedLiveActivity {
  const dropped = { envelope: null, dropped: true, refetchSuggested: false } as const;
  if (typeof rawEvent !== 'string' || typeof rawData !== 'string') return { ...dropped };
  if (isConnectionFrame(rawEvent)) {
    // Connection frames are transport state, not displayable activity.
    return { envelope: null, dropped: true, refetchSuggested: false };
  }
  if (!isLiveActivityEvent(rawEvent)) {
    // Unknown event types are dropped but trigger a safe refetch — the
    // projection may have moved without us.
    return { envelope: null, dropped: true, refetchSuggested: true };
  }
  if (!isFrameWithinBudget(utf8ByteLength(rawData))) {
    return { envelope: null, dropped: true, refetchSuggested: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return { envelope: null, dropped: true, refetchSuggested: false };
  }
  const result = LiveActivityEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return { envelope: null, dropped: true, refetchSuggested: true };
  }
  return { envelope: result.data, dropped: false, refetchSuggested: result.data.refetchSuggested ?? false };
}
