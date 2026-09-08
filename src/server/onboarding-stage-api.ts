/**
 * Slice 5a — version-aware transport boundary serializers (D1 bridge).
 *
 * Default/unversioned means legacy v1. Opt-in `stageVocabularyVersion=2`
 * selects canonical v2 on inventoried stage-bearing routes. Unknown versions,
 * mixed representations, and Step 0 are rejected before any action.
 */
import {
  parseV2StageInput,
  toCanonicalStage,
  toStoredStage,
  V2_TO_V1,
  STEP_ZERO_VIEW_ID,
} from '../shared/onboarding-stage-vocabulary';

export type StageVocabularyVersion = 1 | 2;

export function parseStageVocabularyVersion(raw: unknown): StageVocabularyVersion {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (n === 1) return 1;
  if (n === 2) return 2;
  throw new Error(`invalid_version: unsupported stageVocabularyVersion ${String(raw)}`);
}

/** Normalize inbound stage input under an explicit version. */
export function parseStageInput(value: unknown, version: StageVocabularyVersion): string {
  if (value === STEP_ZERO_VIEW_ID) throw new Error('step_zero_not_a_stage: brand-setup is a view, not a stage');
  if (version === 2) return parseV2StageInput(value);
  return toStoredStage(value);
}

/** Serialize a canonical stage for a given wire version. */
export function serializeStage(canonical: unknown, version: StageVocabularyVersion): string {
  const c = toCanonicalStage(canonical);
  if (version === 2) return c;
  return V2_TO_V1[c];
}

/** Serialize a stage→count distribution map under an explicit version. */
export function serializeDistribution(
  canonicalCounts: Record<string, number>,
  version: StageVocabularyVersion,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [stage, count] of Object.entries(canonicalCounts)) {
    out[serializeStage(stage, version)] = count;
  }
  return out;
}
