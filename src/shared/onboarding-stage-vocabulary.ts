/**
 * Canonical onboarding stage vocabulary authority (Slice 1, council plan §4.2).
 *
 * PURE module: no imports from src/db, src/onboarding, or src/server.
 * The client must obtain stage order from here — never from DB repositories.
 *
 * - v1 (legacy storage/wire): sourcing, discovery, extraction, curation, review, promotion.
 * - v2 (canonical runtime, owner-approved): route_sources, find_product_page,
 *   collect_details, prepare_listing, review_listings, create_drafts.
 *
 * Stage 1 is neutral source triage/routing ("Check source options"): the
 * official product URL is the main flow and a qualified distributor record is
 * an alternate fast path — NOT a compulsory supplier-first step and NOT a
 * worker scheduling change. Step 0 ("brand-setup" / "Brand setup") is a VIEW,
 * never a stage, and is rejected by every stage parser below.
 */
// NOTE: namespace import (not `import { z }`) — vite-node cannot resolve
// zod v4's named `z` export under Vitest (pre-existing repo-wide breakage:
// every suite importing zod-by-name fails at collect, e.g.
// generate-selectors-schemas.test.ts). The namespace form works in both
// Bun and Vitest. Do not "harmonize" this back without fixing the env issue.
import * as z from 'zod';

/** Storage/wire vocabulary version still present in persisted rows (pre-rename). */
export const STAGE_VOCABULARY_VERSION_V1 = 1 as const;
/** Canonical vocabulary version used by v2 reads and (after the sanctioned
 * migration) runtime/storage. */
export const STAGE_VOCABULARY_VERSION_V2 = 2 as const;

export const StageV1Enum = z.enum([
  'sourcing',
  'discovery',
  'extraction',
  'curation',
  'review',
  'promotion',
]);
export type StageV1 = z.infer<typeof StageV1Enum>;

export const StageV2Enum = z.enum([
  'route_sources',
  'find_product_page',
  'collect_details',
  'prepare_listing',
  'review_listings',
  'create_drafts',
]);
export type StageV2 = z.infer<typeof StageV2Enum>;

/** Explicit execution order — never alphabetical. */
export const STAGE_ORDER_V1: readonly StageV1[] = Object.freeze([
  'sourcing',
  'discovery',
  'extraction',
  'curation',
  'review',
  'promotion',
]);

/** Explicit execution order — never alphabetical. Same positions as v1. */
export const STAGE_ORDER_V2: readonly StageV2[] = Object.freeze([
  'route_sources',
  'find_product_page',
  'collect_details',
  'prepare_listing',
  'review_listings',
  'create_drafts',
]);

/** One-to-one in both directions. */
export const V1_TO_V2: Readonly<Record<StageV1, StageV2>> = Object.freeze({
  sourcing: 'route_sources',
  discovery: 'find_product_page',
  extraction: 'collect_details',
  curation: 'prepare_listing',
  review: 'review_listings',
  promotion: 'create_drafts',
});

/** One-to-one in both directions. */
export const V2_TO_V1: Readonly<Record<StageV2, StageV1>> = Object.freeze({
  route_sources: 'sourcing',
  find_product_page: 'discovery',
  collect_details: 'extraction',
  prepare_listing: 'curation',
  review_listings: 'review',
  create_drafts: 'promotion',
});

export const STAGE_V2_LABELS: Readonly<Record<StageV2, string>> = Object.freeze({
  route_sources: 'Check source options',
  find_product_page: 'Find product page',
  collect_details: 'Collect details',
  prepare_listing: 'Prepare listing',
  review_listings: 'Review listings',
  create_drafts: 'Create drafts',
});

/**
 * Step 0 view identifier. Excluded from every stage enum, order array, and
 * count matrix. Stage parsers reject it explicitly.
 */
export const STEP_ZERO_VIEW_ID = 'brand-setup' as const;
export const STEP_ZERO_LABEL = 'Brand setup' as const;

export class StageVocabularyError extends Error {
  constructor(
    message: string,
    public readonly code: 'unknown_stage' | 'mixed_version' | 'step_zero_not_a_stage' | 'invalid_version',
  ) {
    super(message);
    this.name = 'StageVocabularyError';
  }
}

export function isStageV1String(value: unknown): value is StageV1 {
  return typeof value === 'string' && (STAGE_ORDER_V1 as readonly string[]).includes(value);
}

export function isStageV2String(value: unknown): value is StageV2 {
  return typeof value === 'string' && (STAGE_ORDER_V2 as readonly string[]).includes(value);
}

export function isStepZeroView(value: unknown): boolean {
  return value === STEP_ZERO_VIEW_ID;
}

/** v1 stored literal → canonical v2. Rejects Step 0, unknown, and v2 input. */
export function toCanonicalStage(value: unknown): StageV2 {
  if (isStepZeroView(value)) {
    throw new StageVocabularyError(
      `'brand-setup' is a preparation view, not an execution stage`,
      'step_zero_not_a_stage',
    );
  }
  if (isStageV2String(value)) return value;
  if (isStageV1String(value)) return V1_TO_V2[value];
  throw new StageVocabularyError(`Unknown pipeline stage: ${String(value)}`, 'unknown_stage');
}

/** Canonical v2 → v1 stored literal (storage remains v1 until the sanctioned
 * migration; this is the version-aware write/read alias, not the rename). */
export function toStoredStage(value: unknown): StageV1 {
  if (isStepZeroView(value)) {
    throw new StageVocabularyError(
      `'brand-setup' is a preparation view, not an execution stage`,
      'step_zero_not_a_stage',
    );
  }
  if (isStageV1String(value)) return value;
  if (isStageV2String(value)) return V2_TO_V1[value];
  throw new StageVocabularyError(`Unknown pipeline stage: ${String(value)}`, 'unknown_stage');
}

/**
 * Strict v2-only stage parser for v2 endpoint input. v1 values are rejected
 * with `invalid_version` (never silently accepted); Step 0 with
 * `step_zero_not_a_stage`; anything else with `unknown_stage`.
 */
export function parseV2StageInput(value: unknown): StageV2 {
  if (isStepZeroView(value)) {
    throw new StageVocabularyError(
      `'brand-setup' is a preparation view, not an execution stage`,
      'step_zero_not_a_stage',
    );
  }
  if (isStageV2String(value)) return value;
  if (isStageV1String(value)) {
    throw new StageVocabularyError(
      `Legacy stage '${value}' requires an explicitly v1 representation; this v2 input accepts only canonical values`,
      'invalid_version',
    );
  }
  throw new StageVocabularyError(`Unknown pipeline stage: ${String(value)}`, 'unknown_stage');
}

/** Zero-based position in the explicit execution order. */
export function stageV2Index(stage: StageV2): number {
  return STAGE_ORDER_V2.indexOf(stage);
}

/** Assert a full six-entry bijection (order-sensitive). Used by tests and the
 * migration gate; fails closed on any drift. */
export function assertStageBijection(): void {
  if (STAGE_ORDER_V1.length !== 6 || STAGE_ORDER_V2.length !== 6) {
    throw new StageVocabularyError('Stage orders must each contain exactly six entries', 'unknown_stage');
  }
  const seenV2 = new Set<string>();
  for (let i = 0; i < 6; i += 1) {
    const v1 = STAGE_ORDER_V1[i];
    const v2 = STAGE_ORDER_V2[i];
    if (V1_TO_V2[v1] !== v2 || V2_TO_V1[v2] !== v1 || seenV2.has(v2)) {
      throw new StageVocabularyError(`Stage bijection broken at position ${i}`, 'unknown_stage');
    }
    seenV2.add(v2);
  }
}
