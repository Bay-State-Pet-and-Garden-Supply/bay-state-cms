/**
 * Slice 4-SERVER — live-activity envelope/schema tests (Vitest, pure).
 *
 * Bounds, allowlists, and frame classification: 160-char summaries, 16KiB
 * UTF-8 frames, closed reason codes, v1→v2 stage mapping, and
 * dropped-or-generic verdicts for unknown/malformed/oversized frames.
 * No DB, no network, no worker.
 */
import { describe, it, expect } from 'vitest';
import {
  LIVE_ACTIVITY_MAX_FRAME_BYTES,
  LIVE_ACTIVITY_MAX_SUMMARY_CHARS,
  LiveActivityEnvelopeSchema,
  coerceLiveActivityFrame,
  isConnectionFrame,
  isFrameWithinBudget,
  isLiveActivityEvent,
  toCanonicalLiveStage,
  toStoredLiveStage,
  utf8ByteLength,
} from '../../shared/schemas/onboarding-live-activity';

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    stageVocabularyVersion: 2,
    event: 'item:status',
    batchId: 'batch-1',
    itemId: 'item-1',
    stage: 'prepare_listing',
    stageStatus: 'in_progress',
    summary: 'An item moved to its next stage.',
    reasonCode: 'advanced',
    ...overrides,
  };
}

describe('live-activity envelope', () => {
  it('accepts a valid v2 envelope', () => {
    expect(LiveActivityEnvelopeSchema.safeParse(validEnvelope()).success).toBe(true);
  });

  it('accepts a missing stage (never invented)', () => {
    const { stage: _dropped, ...rest } = validEnvelope();
    void _dropped;
    const parsed = LiveActivityEnvelopeSchema.safeParse(rest);
    expect(parsed.success).toBe(true);
  });

  it('rejects v1 stage spellings in a v2 envelope', () => {
    expect(LiveActivityEnvelopeSchema.safeParse(validEnvelope({ stage: 'curation' })).success).toBe(false);
    expect(LiveActivityEnvelopeSchema.safeParse(validEnvelope({ stage: 'sourcing' })).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      LiveActivityEnvelopeSchema.safeParse(validEnvelope({ error: 'boom', evidence: [1] })).success,
    ).toBe(false);
  });

  it('rejects summaries over 160 display characters', () => {
    expect(
      LiveActivityEnvelopeSchema.safeParse(validEnvelope({ summary: 'x'.repeat(LIVE_ACTIVITY_MAX_SUMMARY_CHARS + 1) }))
        .success,
    ).toBe(false);
    expect(
      LiveActivityEnvelopeSchema.safeParse(validEnvelope({ summary: 'x'.repeat(LIVE_ACTIVITY_MAX_SUMMARY_CHARS) }))
        .success,
    ).toBe(true);
  });

  it('rejects unknown event types and reason codes', () => {
    expect(LiveActivityEnvelopeSchema.safeParse(validEnvelope({ event: 'item:deleted' })).success).toBe(false);
    expect(LiveActivityEnvelopeSchema.safeParse(validEnvelope({ reasonCode: 'exploded' })).success).toBe(false);
  });
});

describe('frame budgets (UTF-8 byte length)', () => {
  it('measures multi-byte characters as multi-byte', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('🤖')).toBe(4);
  });

  it('accepts exactly 16KiB and rejects 16KiB+1', () => {
    expect(isFrameWithinBudget(LIVE_ACTIVITY_MAX_FRAME_BYTES)).toBe(true);
    expect(isFrameWithinBudget(LIVE_ACTIVITY_MAX_FRAME_BYTES + 1)).toBe(false);
    expect(isFrameWithinBudget(-1)).toBe(false);
  });
});

describe('stage mapping', () => {
  it('maps all six v1 stages to canonical v2', () => {
    expect(toCanonicalLiveStage('sourcing')).toBe('route_sources');
    expect(toCanonicalLiveStage('discovery')).toBe('find_product_page');
    expect(toCanonicalLiveStage('extraction')).toBe('collect_details');
    expect(toCanonicalLiveStage('curation')).toBe('prepare_listing');
    expect(toCanonicalLiveStage('review')).toBe('review_listings');
    expect(toCanonicalLiveStage('promotion')).toBe('create_drafts');
  });

  it('Slice 5b native: accepts canonical v2 input by identity (worker emits v2)', () => {
    expect(toCanonicalLiveStage('route_sources')).toBe('route_sources');
    expect(toCanonicalLiveStage('find_product_page')).toBe('find_product_page');
    expect(toCanonicalLiveStage('collect_details')).toBe('collect_details');
    expect(toCanonicalLiveStage('prepare_listing')).toBe('prepare_listing');
    expect(toCanonicalLiveStage('review_listings')).toBe('review_listings');
    expect(toCanonicalLiveStage('create_drafts')).toBe('create_drafts');
    expect(toStoredLiveStage('prepare_listing')).toBe('curation');
    expect(toStoredLiveStage('curation')).toBe('curation');
    expect(toStoredLiveStage('nonsense')).toBeNull();
  });

  it('returns null for unknown/non-string stages (caller drops, never invents)', () => {
    expect(toCanonicalLiveStage('nonsense')).toBeNull();
    expect(toCanonicalLiveStage('Curation')).toBeNull();
    expect(toCanonicalLiveStage(null)).toBeNull();
    expect(toCanonicalLiveStage(undefined)).toBeNull();
    expect(toCanonicalLiveStage(42)).toBeNull();
  });
});

describe('event classification', () => {
  it('types welcome/ping as connection frames, never activity', () => {
    expect(isConnectionFrame('welcome')).toBe(true);
    expect(isConnectionFrame('ping')).toBe(true);
    expect(isConnectionFrame('item:status')).toBe(false);
    expect(isLiveActivityEvent('item:status')).toBe(true);
    expect(isLiveActivityEvent('batch:progress')).toBe(true);
    expect(isLiveActivityEvent('batch:complete')).toBe(true);
    expect(isLiveActivityEvent('batch:error')).toBe(true);
    expect(isLiveActivityEvent('welcome')).toBe(false);
    expect(isLiveActivityEvent('ping')).toBe(false);
    expect(isLiveActivityEvent('item:deleted')).toBe(false);
  });
});

describe('frame coercion', () => {
  it('passes a valid v2 frame through', () => {
    const result = coerceLiveActivityFrame('item:status', JSON.stringify(validEnvelope()));
    expect(result.dropped).toBe(false);
    expect(result.envelope?.summary).toBe('An item moved to its next stage.');
    expect(result.refetchSuggested).toBe(false);
  });

  it('drops connection frames without refetch', () => {
    for (const frame of ['welcome', 'ping']) {
      const result = coerceLiveActivityFrame(frame, '{"frame":"welcome"}');
      expect(result.dropped).toBe(true);
      expect(result.refetchSuggested).toBe(false);
      expect(result.envelope).toBeNull();
    }
  });

  it('drops unknown event types WITH refetch (projection may have moved)', () => {
    const result = coerceLiveActivityFrame('item:teleported', JSON.stringify(validEnvelope()));
    expect(result.dropped).toBe(true);
    expect(result.refetchSuggested).toBe(true);
  });

  it('drops oversized frames WITH refetch (UTF-8 measured)', () => {
    const big = 'é'.repeat(Math.ceil((LIVE_ACTIVITY_MAX_FRAME_BYTES + 8) / 2));
    expect(utf8ByteLength(big)).toBeGreaterThan(LIVE_ACTIVITY_MAX_FRAME_BYTES);
    const result = coerceLiveActivityFrame('item:status', big);
    expect(result.dropped).toBe(true);
    expect(result.refetchSuggested).toBe(true);
  });

  it('drops malformed JSON without refetch', () => {
    const result = coerceLiveActivityFrame('item:status', 'not-json{{{');
    expect(result.dropped).toBe(true);
    expect(result.refetchSuggested).toBe(false);
  });

  it('drops schema-invalid envelopes WITH refetch', () => {
    const result = coerceLiveActivityFrame('item:status', JSON.stringify(validEnvelope({ stage: 'curation' })));
    expect(result.dropped).toBe(true);
    expect(result.refetchSuggested).toBe(true);
  });

  it('never throws on hostile input', () => {
    expect(() => coerceLiveActivityFrame(null as never, null as never).dropped).not.toThrow();
    const result = coerceLiveActivityFrame(null as never, null as never);
    expect(result.dropped).toBe(true);
  });
});
