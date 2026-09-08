/**
 * Cohort decision authority — pure shared prompt-input vocabulary (Slice 1).
 *
 * The small leaf legitimately shared by the title/Page hash modules, the
 * coordinated title/Page prompt paths, the frozen sibling/group views, and
 * the pure product-type resolver: title/Page truncation + normalization, the
 * source-provenance slice/accessor, and the Execution Product Type display
 * authority. No lease, no output persistence, no config loading, no
 * orchestration — it imports only shared schemas.
 *
 * Relocated verbatim from `src/onboarding/cohort-title-hash.ts` and
 * `src/onboarding/cohort-page-hash.ts` (Slice 1); those modules re-export
 * every moved symbol as a temporary forwarder (deleted in Slice 6). Hash
 * bytes are unchanged: same inputs, same truncation, same serialization.
 */
import type {
  CohortRun,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../shared/schemas/cohorts';

// ─── Execution Product Type display authority ────────────────────────────────

export interface ExecutionTypeTitleAuthority {
  /** The frozen Execution Product Type id (null when abstained/conflicted). */
  id: string | null;
  /** The frozen product-type option's label for `id` (null when no matching option). */
  label: string | null;
  /** The frozen resolution confidence (0..1; null when unresolved). */
  confidence: number | null;
  /** The frozen resolution outcome marker (coherent | … | abstained; null when unresolved). */
  outcome: string | null;
}

/** The frozen member-snapshot slice the label lookup needs (structural — keeps
 *  the hash module decoupled from the full runtime snapshot). */
export type ExecutionTypeLabelSource = {
  productTypes: ReadonlyArray<{ id: string; name: string }>;
} | null;

/**
 * Build the canonical Execution Product Type title authority from the frozen
 * run row and (optionally) the ordinal-0 member's frozen runtime snapshot
 * (the label is the product-type option's name matched by id; null when the
 * run has no type id or the snapshot has no matching option).
 */
export function titleExecutionTypeAuthorityFromRun(
  run: CohortRun,
  memberSnapshot?: ExecutionTypeLabelSource | null,
): ExecutionTypeTitleAuthority {
  const id = run.executionProductTypeId;
  return {
    id,
    label:
      id && memberSnapshot
        ? (memberSnapshot.productTypes.find(pt => pt.id === id)?.name ?? null)
        : null,
    confidence: run.productTypeConfidence,
    outcome: run.productTypeOutcome,
  };
}

// ─── Source-provenance identity slice ────────────────────────────────────────

/**
 * Milestone E source-provenance identity slice (shared by T/P hashes and the
 * product-type resolver). Field names MUST match the V2 member schema fields
 * Worker A adds to ExecutionEvidenceProjectionV2 in src/shared/schemas/cohorts.ts:
 * itemSourceType, extractionSourceType, extractionMethod, sourcingGenerationId,
 * acceptedEvidenceAttemptIds, acceptedProviderIds, distributorEvidenceHash (plus the
 * existing V1 sourceUrl/extractionSourceUrl). The accessor is tolerant: V1
 * members (no source-type fields) normalize to official_page provenance.
 */
export interface SourceProvenanceSlice {
  itemSourceType: 'official_page' | 'distributor_record';
  sourceUrl: string | null;
  extractionSourceType: 'official_page' | 'distributor_record';
  extractionSourceUrl: string | null;
  extractionMethod: string | null;
  sourcingGenerationId: string | null;
  acceptedEvidenceAttemptIds: string[];
  providerIds: string[];
  distributorEvidenceHash: string | null;
}

/**
 * Tolerant source-provenance accessor. Reads the V2 provenance fields when
 * present; normalizes V1 members (distributor routing did not exist when V1
 * was written) to official-page provenance. Arrays are sorted so the
 * canonical JSON is order-insensitive.
 */
export function sourceProvenanceFromMember(
  member: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
): SourceProvenanceSlice {
  // V2 members carry the provenance fields; V1 members (distributor routing
  // did not exist when V1 was written) normalize to official_page.
  const v2 = 'itemSourceType' in member;
  const m = member as ExecutionEvidenceProjectionMemberV2;
  return {
    itemSourceType: v2 ? m.itemSourceType : 'official_page',
    sourceUrl: member.sourceUrl ?? null,
    extractionSourceType: v2 ? m.extractionSourceType : 'official_page',
    extractionSourceUrl: member.extractionSourceUrl ?? null,
    // Matches normalizeExecutionEvidenceProjectionMemberV1's official-page
    // normalization (extractionMethod: '') so V1 and normalized-V2 hash
    // identically (V1 compatibility contract).
    extractionMethod: v2 ? m.extractionMethod : '',
    sourcingGenerationId: v2 ? m.sourcingGenerationId : null,
    acceptedEvidenceAttemptIds: v2 ? [...m.acceptedEvidenceAttemptIds].sort() : [],
    // V2 names the provider set `acceptedProviderIds` (cohorts.ts); V1 has
    // no provider set and normalizes empty.
    providerIds: v2 ? [...m.acceptedProviderIds].sort() : [],
    distributorEvidenceHash: v2 ? m.distributorEvidenceHash : null,
  };
}

// ─── Title truncation / normalization ────────────────────────────────────────

/**
 * Prompt-normalized truncation limits for title authority strings — the SAME
 * cutoffs the coordinated prompt renders (brand signals 200 chars, all other
 * title signals 500). `titleAuthorityFromProjectionMember` and the
 * coordinator's signals-ON mapping share these, so the hashed authority
 * equals the prompted authority by construction.
 */
export const TITLE_AUTHORITY_TRUNCATION = {
  brandMaxChars: 200,
  signalMaxChars: 500,
} as const;

/** Truncate a title-authority string to `maxChars` (null-safe). */
export function normalizeTitleAuthorityString(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

// ─── Page truncation / normalization ─────────────────────────────────────────

/**
 * Prompt-normalized truncation limits for Page authority strings — the SAME
 * cutoffs the v2 coordinated Page prompt renders (name/webTitle 500, brand
 * 200, description 1500). `pageAuthorityFromProjectionMember` and the
 * prompt's per-member rendering share these, so the hashed authority equals
 * the prompted authority by construction.
 */
export const PAGE_AUTHORITY_TRUNCATION = {
  name: 500,
  webTitle: 500,
  brand: 200,
  description: 1500,
} as const;

/** Truncate a Page authority string to `maxChars` (null-safe). */
export function normalizePageAuthorityString(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
