/**
 * Slice 4-SERVER — allowlisted v2 SSE serializer (council plan §4.2 + §4.3).
 *
 * Translates internal onboarding events into per-subscriber wire payloads:
 * - v1: byte-identical legacy envelope (`{event, data: JSON(event)}`).
 * - v2: versioned, sanitized, bounded `LiveActivityEnvelope`.
 *
 * Fixed text templates only. Raw error strings, product evidence, URLs
 * (with or without credentials), tokens, HTML, model prompts, cookies, and
 * console logs NEVER reach the wire — causes map to vetted reason codes or
 * the event is dropped. `welcome`/`ping` are typed connection frames, never
 * work activity. Named event types are unchanged across versions.
 */
import type { OnboardingEvent } from '../onboarding/sse-emitter';
import {
  LIVE_ACTIVITY_MAX_SUMMARY_CHARS,
  LIVE_ACTIVITY_STAGE_STATUSES,
  toCanonicalLiveStage,
  toStoredLiveStage,
  type LiveActivityEnvelope,
  type LiveActivityReasonCode,
} from '../shared/schemas/onboarding-live-activity';

export const SSE_VOCABULARY_VERSION_1 = 1 as const;
export const SSE_VOCABULARY_VERSION_2 = 2 as const;

export type SseVocabularyVersion = 1 | 2;

/** URL parameter selecting the SSE representation (EventSource has no headers). */
export const SSE_VERSION_PARAM = 'stageVocabularyVersion';

/**
 * Parse the requested SSE vocabulary version BEFORE any stream opens.
 * Absent/unversioned means legacy v1. Anything other than "1"/"2" rejects.
 */
export function parseSseVocabularyVersion(
  raw: string | null | undefined,
): { version: SseVocabularyVersion } | { error: 'invalid_version' } {
  if (raw === null || raw === undefined || raw === '') return { version: 1 };
  if (raw === '1') return { version: 1 };
  if (raw === '2') return { version: 2 };
  return { error: 'invalid_version' };
}

export interface SerializedSseFrame {
  event: string;
  data: string;
}

/**
 * v1 serialization: legacy envelope with the stage field normalized to the
 * v1 spelling (Slice 5b native: internal events carry canonical v2; legacy
 * subscribers keep receiving v1 vocabulary. Non-stage payloads and every
 * other byte stay identical legacy passthrough).
 */
export function serializeSseV1(event: OnboardingEvent): SerializedSseFrame {
  const data = isRecord(event.data) ? { ...event.data } : event.data;
  if (isRecord(data) && typeof data.stage === 'string') {
    const v1 = toStoredLiveStage(data.stage);
    if (v1 !== null) (data as Record<string, unknown>).stage = v1;
    // Non-stage string: leave byte-identical passthrough.
  }
  return { event: event.type, data: JSON.stringify({ ...event, data }) };
}

function truncateSummary(value: string): string {
  if (value.length <= LIVE_ACTIVITY_MAX_SUMMARY_CHARS) return value;
  return value.slice(0, LIVE_ACTIVITY_MAX_SUMMARY_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Map an internal event payload to a vetted reason code.
 * Reads ONLY allowlisted keys (status/route/action); free-form text such as
 * `error`/`message` is never forwarded, only classified.
 */
function classifyReasonCode(event: OnboardingEvent): LiveActivityReasonCode {
  const data = isRecord(event.data) ? event.data : {};
  const status = readString(data, 'status');
  const route = readString(data, 'route');
  const action = readString(data, 'action');
  const haystack = `${status ?? ''} ${route ?? ''} ${action ?? ''}`.toLowerCase();
  if (/\bfailed\b|\berror\b/.test(haystack)) return 'failed';
  if (/profile_blocked|profile-required|no_healthy_profile/.test(haystack)) return 'profile_blocked';
  if (/conflict|needs_input/.test(haystack)) return 'conflict_found';
  if (/family_barrier|waiting_on_family|on_family_hold/.test(haystack)) return 'family_barrier';
  if (/domain_release|domain_released/.test(haystack)) return 'domain_released';
  if (/reviewed/.test(haystack)) return 'reviewed';
  if (/approv/.test(haystack)) return 'approval_recorded';
  if (/export/.test(haystack)) return 'export_drafts_created';
  if (/distributor_record_to_extraction/.test(haystack)) return 'advanced';
  if (/complet/.test(haystack)) return 'advanced';
  if (/claim|in_progress/.test(haystack)) return 'claimed';
  if (/retr/.test(haystack)) return 'retry_queued';
  return 'other';
}

/** Fixed display template per event type — no interpolated payload text. */
function templateSummary(eventType: OnboardingEvent['type'], reason: LiveActivityReasonCode): string {
  switch (eventType) {
    case 'item:status':
      switch (reason) {
        case 'failed':
          return 'An item needs attention after processing did not complete.';
        case 'conflict_found':
          return 'An item needs a decision to resolve conflicting evidence.';
        case 'profile_blocked':
          return 'An item is waiting for a healthy extractor profile.';
        case 'family_barrier':
          return 'An item is waiting on its family group.';
        case 'advanced':
          return 'An item moved to its next stage.';
        case 'claimed':
          return 'Processing started for an item.';
        case 'retry_queued':
          return 'An item was queued to try again.';
        case 'reviewed':
          return 'An item was reviewed.';
        case 'approval_recorded':
          return 'Approval was recorded for an item.';
        case 'export_drafts_created':
          return 'Export drafts were created for an item.';
        case 'domain_released':
          return 'A domain release unblocked waiting items.';
        default:
          return 'An item changed status.';
      }
    case 'batch:progress':
      return 'Batch progress counts changed.';
    case 'batch:complete':
      return 'Batch processing finished.';
    case 'batch:error':
      return 'Batch processing reported an error.';
  }
}

/**
 * v2 serialization: sanitized bounded envelope, or null when the event must
 * be dropped (unknown stage that cannot be mapped, malformed payload).
 * Missing stage stays absent — never invented.
 */
export function serializeSseV2(event: OnboardingEvent): SerializedSseFrame | null {
  if (!isRecord(event.data)) return null;
  const data = event.data;
  const rawStage = readString(data, 'stage');
  const rawStatus = readString(data, 'stageStatus') ?? readString(data, 'status');
  const stage = rawStage === null ? undefined : (toCanonicalLiveStage(rawStage) ?? undefined);
  // A present-but-unmappable stage means we cannot describe this event
  // truthfully in v2 vocabulary: drop it (counts still refresh by polling).
  if (rawStage !== null && stage === undefined) return null;
  // stageStatus is allowlisted: only unchanged StageStatus spellings ride the
  // wire. Absent/invalid values (including attacker-controlled free text via
  // the legacy `status` fallback key) are omitted — the vetted reasonCode
  // still classifies the event, so the frame stays truthful.
  const stageStatus = (
    rawStatus !== null &&
    (LIVE_ACTIVITY_STAGE_STATUSES as readonly string[]).includes(rawStatus)
      ? rawStatus
      : undefined
  ) as LiveActivityEnvelope['stageStatus'];
  const reasonCode = classifyReasonCode(event);
  const envelope: LiveActivityEnvelope = {
    schemaVersion: 1,
    stageVocabularyVersion: 2,
    event: event.type,
    batchId: event.batchId,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(stage ? { stage } : {}),
    ...(stageStatus ? { stageStatus } : {}),
    summary: truncateSummary(templateSummary(event.type, reasonCode)),
    reasonCode,
  };
  return { event: event.type, data: JSON.stringify(envelope) };
}

/** v2 connection frame: typed transport state, never work activity. */
export function serializeSseV2ConnectionFrame(
  kind: 'welcome' | 'ping',
  batchId: string,
): SerializedSseFrame {
  return {
    event: kind,
    data: JSON.stringify({ frame: kind, batchId }),
  };
}

/** v1 connection frames: byte-identical legacy shapes. */
export function serializeSseV1Welcome(batchId: string): SerializedSseFrame {
  return { event: 'welcome', data: JSON.stringify({ message: 'SSE connection established', batchId }) };
}

export function serializeSseV1Ping(nowIso: string): SerializedSseFrame {
  return { event: 'ping', data: JSON.stringify({ time: nowIso }) };
}
