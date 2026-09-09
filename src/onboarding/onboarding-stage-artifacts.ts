/**
 * Slice 5a — explicit immutable-format target interpretation/serialization.
 *
 * Sourcing decision route IDs (e.g. `distributor_record_to_extraction`) are
 * STABLE IDs and are never rewritten. Only the interpreted runtime target
 * stage moves through the canonical adapter; recorded bytes stay byte-identical.
 * `SourcingDecisionV2Schema` target vocabulary is validated under its original
 * (v1) version, then mapped to canonical runtime stage.
 */
import { toCanonicalStage, V2_TO_V1 } from '../shared/onboarding-stage-vocabulary';

/** Interpret a recorded v1 decision target as canonical runtime stage. */
export function interpretDecisionTarget(recordedTarget: unknown): string {
  return toCanonicalStage(recordedTarget);
}

/** Serialize a canonical runtime target back to the recorded v1 format. */
export function serializeDecisionTarget(canonical: unknown): string {
  const c = toCanonicalStage(canonical);
  return V2_TO_V1[c];
}

/** Route IDs are stable identifiers — never stage-renamed. */
export function isStableRouteId(route: unknown): boolean {
  return (
    route === 'distributor_record_to_extraction' ||
    route === 'evidence_to_discovery' ||
    route === 'fallback_to_discovery' ||
    route === 'degraded_fallback_to_discovery' ||
    route === 'needs_input_conflict' ||
    route === 'retry_provider_errors' ||
    route === 'bundle_to_curation'
  );
}
