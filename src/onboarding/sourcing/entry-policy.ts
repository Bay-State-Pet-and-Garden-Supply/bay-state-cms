/**
 * Sourcing entry-policy utilities (ADR 0014 Amendment A).
 *
 * The durable entry-policy version gates which onboarding items the Sourcing
 * engine may automatically claim, look up, or observe. Items created before
 * Amendment A (including the 148 stranded `sourcing/pending` rows) are policy
 * version 0 and remain operator-controlled via the Continue-to-Discovery
 * action; only post-amendment imports are written with the current version.
 *
 * This module is pure: no DB access, no environment access, no fetch.
 */

import type { PipelineStage } from '../../shared/schemas/onboarding';
import type { SourcingFlags } from '../flags';

/**
 * Current entry-policy version. Imports pass this explicitly; an omitted or
 * different version fails closed to legacy/0 behavior.
 */
export const SOURCING_ENTRY_POLICY_VERSION = 1;

/** Entry stages the sourcing capability can produce. */
export type SourcingEntryStage = Extract<PipelineStage, 'route_sources' | 'find_product_page'>;

/**
 * Derive the entry stage for a new import from the effective sourcing flags.
 * Effective-enabled + non-observe mode → `sourcing`; observe mode, disabled,
 * or invalid state → `discovery`.
 *
 * Observe mode never claims Sourcing (buildAutoStages excludes it), so
 * observe-mode imports enter Discovery and the processDiscovery hook observes
 * marker-v1 rows instead (Milestone C).
 */
export function deriveSourcingEntryStage(flags: SourcingFlags): SourcingEntryStage {
  if (!flags.effectiveEnabled) return 'find_product_page';
  if (isObserveMode(flags)) return 'find_product_page';
  return 'route_sources';
}

/** True when the given version is the current sourcing entry-policy version. */
export function isCurrentSourcingEntryPolicy(version: unknown): boolean {
  return version === SOURCING_ENTRY_POLICY_VERSION;
}

/** True when sourcing is effectively enabled AND in observe mode. */
export function isObserveMode(flags: SourcingFlags): boolean {
  return flags.effectiveEnabled && flags.mode === 'observe';
}

/** True when sourcing is effectively enabled AND in manual mode. */
export function isManualMode(flags: SourcingFlags): boolean {
  return flags.effectiveEnabled && flags.mode === 'manual';
}

/** True when sourcing is effectively enabled AND in automatic mode. */
export function isAutomaticMode(flags: SourcingFlags): boolean {
  return flags.effectiveEnabled && flags.mode === 'automatic';
}
