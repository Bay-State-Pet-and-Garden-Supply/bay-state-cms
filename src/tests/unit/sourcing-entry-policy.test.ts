import { describe, it, expect } from 'vitest';
import {
  SOURCING_ENTRY_POLICY_VERSION,
  deriveSourcingEntryStage,
  isCurrentSourcingEntryPolicy,
  isObserveMode,
  isManualMode,
  isAutomaticMode,
} from '../../onboarding/sourcing/entry-policy';
import type { SourcingFlags } from '../../onboarding/flags';

function flags(partial: Partial<SourcingFlags>): SourcingFlags {
  return {
    sourcingEngineEnabled: true,
    mode: 'automatic',
    effectiveEnabled: true,
    reason: 'default_on',
    ...partial,
  };
}

describe('Sourcing entry policy', () => {
  it('exports the current entry-policy version as 1', () => {
    expect(SOURCING_ENTRY_POLICY_VERSION).toBe(1);
  });

  describe('deriveSourcingEntryStage', () => {
    it('routes to route_sources when effectively enabled in automatic mode', () => {
      expect(deriveSourcingEntryStage(flags({ effectiveEnabled: true }))).toBe('route_sources');
    });

    it('routes to route_sources in manual mode', () => {
      expect(deriveSourcingEntryStage(flags({ mode: 'manual' }))).toBe('route_sources');
    });

    it('routes to find_product_page in observe mode (imports are never claimed by Sourcing)', () => {
      expect(deriveSourcingEntryStage(flags({ mode: 'observe' }))).toBe('find_product_page');
    });

    it('routes to find_product_page when disabled (regardless of raw switch)', () => {
      expect(
        deriveSourcingEntryStage(flags({ sourcingEngineEnabled: false, effectiveEnabled: false })),
      ).toBe('find_product_page');
      // Invalid mode: declared available but fail-closed effective state.
      expect(
        deriveSourcingEntryStage(flags({ mode: null, effectiveEnabled: false })),
      ).toBe('find_product_page');
    });

    it('only returns pipeline-stage entry values', () => {
      const stage = deriveSourcingEntryStage(flags({ effectiveEnabled: true }));
      expect(['route_sources', 'find_product_page']).toContain(stage);
    });
  });

  describe('isCurrentSourcingEntryPolicy', () => {
    it('accepts exactly the current version', () => {
      expect(isCurrentSourcingEntryPolicy(1)).toBe(true);
    });

    it('rejects legacy/unknown versions', () => {
      expect(isCurrentSourcingEntryPolicy(0)).toBe(false);
      expect(isCurrentSourcingEntryPolicy(2)).toBe(false);
      expect(isCurrentSourcingEntryPolicy(null)).toBe(false);
      expect(isCurrentSourcingEntryPolicy(undefined)).toBe(false);
      expect(isCurrentSourcingEntryPolicy('1')).toBe(false);
      expect(isCurrentSourcingEntryPolicy(1.5)).toBe(false);
    });
  });

  describe('mode predicates', () => {
    it('isObserveMode requires effective enabled + observe mode', () => {
      expect(isObserveMode(flags({ mode: 'observe' }))).toBe(true);
      expect(isObserveMode(flags({ mode: 'automatic' }))).toBe(false);
      expect(isObserveMode(flags({ mode: 'observe', effectiveEnabled: false }))).toBe(false);
      expect(isObserveMode(flags({ mode: null, effectiveEnabled: false }))).toBe(false);
    });

    it('isManualMode requires effective enabled + manual mode', () => {
      expect(isManualMode(flags({ mode: 'manual' }))).toBe(true);
      expect(isManualMode(flags({ mode: 'observe' }))).toBe(false);
      expect(isManualMode(flags({ mode: 'manual', effectiveEnabled: false }))).toBe(false);
    });

    it('isAutomaticMode requires effective enabled + automatic mode', () => {
      expect(isAutomaticMode(flags({ mode: 'automatic' }))).toBe(true);
      expect(isAutomaticMode(flags({ mode: 'manual' }))).toBe(false);
      expect(isAutomaticMode(flags({ mode: 'automatic', effectiveEnabled: false }))).toBe(false);
      expect(isAutomaticMode(flags({ mode: null, effectiveEnabled: false }))).toBe(false);
    });

    it('exactly one mode predicate is true for any effective-enabled state', () => {
      for (const mode of ['observe', 'manual', 'automatic'] as const) {
        const f = flags({ mode });
        const matches = [isObserveMode(f), isManualMode(f), isAutomaticMode(f)].filter(Boolean);
        expect(matches).toHaveLength(1);
      }
    });
  });
});
