/**
 * Profile builder — draft/API payload mapping utilities.
 *
 * Pure functions that convert between:
 *   - ExtractorProfile (from API)
 *   - ProfileDraft (UI state)
 *   - Save/Validate/Test API payloads
 *
 * No React or DOM dependencies — safe for isolated testing.
 */

import type { ExtractorProfile } from '../../../shared/schemas/onboarding';
import type {
  ValidateRequest,
  VariantSelectionStrategy,
} from '../../../shared/schemas/extraction-worker';
import type {
  SaveExtractorProfilePayload,
  TestExtractorProfileRequest,
} from '../../onboarding-api';
import type {
  ProfileDraft,
  ValidationSample,
} from './profileBuilderTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert an empty string to null; pass null through. */
function emptyToNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  return v.trim() === '' ? null : v;
}

/** Remove entries with empty-string values. */
function omitEmptyValues(rec: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v && v.trim()) {
      result[k] = v.trim();
    }
  }
  return result;
}

// ─── Create empty draft ───────────────────────────────────────────────────────

/**
 * Create an empty ProfileDraft with optional initial values.
 */
export function createEmptyDraft(args?: {
  domain?: string;
  productUrl?: string;
  runtime?: 'static' | 'rendered';
}): ProfileDraft {
  return {
    domain: args?.domain ?? '',
    runtime: args?.runtime ?? 'rendered',
    productUrl: args?.productUrl ?? '',
    titleSelector: null,
    titleOptionalSelectors: [],
    brandSelector: null,
    descriptionSelector: null,
    imagesSelector: null,
    priceSelector: null,
    customSelectors: {},
    sitemapProductUrlPattern: null,
    shopifyJSONPath: false,
    variantSelectionStrategy: null,
    customSelectorMetadata: {},
  };
}

// ─── Profile → Draft ──────────────────────────────────────────────────────────

/**
 * Hydrate a ProfileDraft from an existing ExtractorProfile.
 * Sets productUrl to empty — the operator must enter a URL.
 */
export function profileToDraft(profile: ExtractorProfile): ProfileDraft {
  return {
    domain: profile.domain,
    runtime: profile.runtime ?? 'rendered',
    productUrl: '',
    titleSelector: profile.titleSelector,
    titleOptionalSelectors: profile.titleOptionalSelectors ?? [],
    brandSelector: profile.brandSelector,
    descriptionSelector: profile.descriptionSelector,
    imagesSelector: profile.imagesSelector,
    priceSelector: profile.priceSelector,
    customSelectors: profile.customSelectors ?? {},
    sitemapProductUrlPattern: profile.sitemapProductUrlPattern,
    shopifyJSONPath: profile.shopifyJSONPath ?? false,
    variantSelectionStrategy: profile.variantSelectionStrategy,
    customSelectorMetadata: profile.customSelectorMetadata ?? {},
  };
}

// ─── Draft → Save Payload ─────────────────────────────────────────────────────

/**
 * Core selector fields shared by the save payload and the version payload.
 *
 * Both payloads project the same draft selectors with the same
 * empty-to-null / filter-Boolean rules; only `customSelectors` handling
 * differs per payload (save omits when empty, version keeps the filtered
 * map). Shared here so the two projections cannot drift.
 */
function draftCoreSelectorFields(draft: ProfileDraft) {
  return {
    titleSelector: emptyToNull(draft.titleSelector),
    titleOptionalSelectors: draft.titleOptionalSelectors.filter(Boolean),
    brandSelector: emptyToNull(draft.brandSelector),
    descriptionSelector: emptyToNull(draft.descriptionSelector),
    imagesSelector: emptyToNull(draft.imagesSelector),
    priceSelector: emptyToNull(draft.priceSelector),
    sitemapProductUrlPattern: emptyToNull(draft.sitemapProductUrlPattern),
    shopifyJSONPath: draft.shopifyJSONPath,
    variantSelectionStrategy: draft.variantSelectionStrategy,
    customSelectorMetadata: draft.customSelectorMetadata,
  };
}

/**
 * Convert a draft into the payload for `saveExtractorProfile`.
 *
 * Rules:
 *   - Empty core selectors → null (so upsertProfile treats them as "set to null")
 *   - Empty custom selectors → omitted
 *   - titleOptionalSelectors → filtered to non-empty strings
 */
export function draftToSavePayload(draft: ProfileDraft): SaveExtractorProfilePayload {
  return {
    domain: draft.domain,
    runtime: draft.runtime,
    ...draftCoreSelectorFields(draft),
    customSelectors: Object.keys(omitEmptyValues(draft.customSelectors)).length > 0
      ? omitEmptyValues(draft.customSelectors)
      : undefined,
  };
}

// ─── Draft → Validate Payload ─────────────────────────────────────────────────

/**
 * Convert a draft + samples into a `ValidateRequest`.
 *
 * Intentionally flattens both core AND custom selectors into
 * `profileDraft.selectors` because the validation endpoint
 * evaluates a `Record<string, string | null>` against each sample.
 * Custom selectors are not passed as a separate field here.
 */
export function draftToValidatePayload(
  draft: ProfileDraft,
  samples: ValidationSample[],
) {
  // Return type is intentionally loose — the ValidateRequest schema
  // fills in defaults for missing ProfileProposalDraft fields at runtime.
  return {
    profileDraft: {
      domain: draft.domain,
      urlPatterns: [] as string[],
      pageStructureSignals: [] as string[],
      runtime: draft.runtime,
      selectors: {
        titleSelector: draft.titleSelector,
        brandSelector: draft.brandSelector,
        descriptionSelector: draft.descriptionSelector,
        imagesSelector: draft.imagesSelector,
        priceSelector: draft.priceSelector,
        ...draft.customSelectors,
      },
      titleOptionalSelectors: draft.titleOptionalSelectors,
      imageRules: {} as Record<string, unknown>,
      variantSelectionStrategy: draft.variantSelectionStrategy as VariantSelectionStrategy | null,
      warnings: [] as string[],
    },
    samples: samples.map((sample) => ({
      url: sample.url,
      confirmed: sample.confirmed,
      expectedName: sample.expectedName,
      spreadsheetHints: {} as Record<string, string>,
    })),
  };
}

// ─── Draft → Version Payload ─────────────────────────────────────────────────

/**
 * Complete executable configuration snapshot for one profile version row.
 *
 * The version row is the source of truth for validation AND activation:
 * `profileFromVersion` rebuilds the executable profile from `selectors`,
 * so this payload must carry the COMPLETE configuration — core selectors
 * plus custom selectors, variant strategy, runtime, and supporting
 * settings. Saving only core selectors here while writing custom/variant
 * config to the legacy profile would let activation wipe them.
 */
export interface VersionPayload {
  domain: string;
  selectors: Record<string, unknown>;
  runtime: 'static' | 'rendered';
  validationSummary: { imageRuleOk: boolean; rowCount?: number };
}

/**
 * Convert a draft into the body for `POST /api/profile-versions`.
 *
 * `imagePreviewsReviewed` is the version-bound explicit image-review
 * attestation: the operator confirms they reviewed the image previews for
 * the confirmed samples. It is the ONLY writer of
 * `validationSummary.imageRuleOk` on the save path — default false stays
 * blocked at the activation gate, never fabricated by matrix runs.
 */
export function draftToVersionPayload(
  draft: ProfileDraft,
  imagePreviewsReviewed: boolean,
  opts?: { sampleCount?: number },
): VersionPayload {
  return {
    domain: draft.domain,
    selectors: {
      ...draftCoreSelectorFields(draft),
      customSelectors: omitEmptyValues(draft.customSelectors),
      customSelectorMetadata: draft.customSelectorMetadata ?? {},
    },
    runtime: draft.runtime,
    validationSummary: {
      imageRuleOk: imagePreviewsReviewed === true,
      ...(opts?.sampleCount !== undefined ? { rowCount: opts.sampleCount } : {}),
    },
  };
}

// ─── Draft → Test Payload ─────────────────────────────────────────────────────

/**
 * Convert a draft into the payload for `testExtractorProfile`.
 */
export function draftToTestPayload(draft: ProfileDraft): TestExtractorProfileRequest {
  return {
    url: draft.productUrl,
    titleSelector: draft.titleSelector,
    titleOptionalSelectors: draft.titleOptionalSelectors,
    brandSelector: draft.brandSelector,
    descriptionSelector: draft.descriptionSelector,
    imagesSelector: draft.imagesSelector,
    priceSelector: draft.priceSelector,
    shopifyJSONPath: draft.shopifyJSONPath,
    customSelectors: draft.customSelectors,
  };
}

// ─── Draft → Flat Selector Map ────────────────────────────────────────────────

/**
 * Get a flat `Record<string, string | null>` of all selectors in the
 * draft, including both core and custom fields.
 */
export function draftToSelectorMap(draft: ProfileDraft): Record<string, string | null> {
  return {
    titleSelector: draft.titleSelector,
    brandSelector: draft.brandSelector,
    descriptionSelector: draft.descriptionSelector,
    imagesSelector: draft.imagesSelector,
    priceSelector: draft.priceSelector,
    ...Object.fromEntries(
      Object.entries(draft.customSelectors).map(([k, v]) => [k, v || null]),
    ),
  };
}

// ─── Test helpers (exported for direct use in reducer/evaluation) ─────────

export { emptyToNull, omitEmptyValues };

