// fallow-ignore-file unused-export

import { z } from 'zod';
import { ExtractionDataSchema, StrictVariantSelectionStrategySchema } from './onboarding';
import { VariantSelectionReceiptSchema, VariantMatrixSchema, NormalizedVariantCandidateSchema } from './variant-resolution';


// ─── Network capture artifact (relocated from product-intelligence/assets/schema.ts, ADR-0030 PR 1.3) ───

/** A #29-style captured network response (JSON body only, no raw payloads). */
export const NetworkCaptureArtifactSchema = z.object({
  url: z.string().url(),
  status: z.number().int().nullish(),
  responseContentType: z.string().nullish(),
  jsonBody: z.unknown().nullish(),
});
export type NetworkCaptureArtifact = z.infer<typeof NetworkCaptureArtifactSchema>;


// ─── Capabilities ──────────────────────────────────────────────────────────────

export const WorkerCapabilitiesSchema = z.object({
  playwright: z.boolean().default(true),
  crawlee: z.boolean().default(false),
  stagehand: z.boolean().default(false),
  /** Camoufox anti-detect browser backend availability. */
  camoufox: z.boolean().default(false),
});

export type WorkerCapabilities = z.infer<typeof WorkerCapabilitiesSchema>;

// ─── Health ────────────────────────────────────────────────────────────────────

export const WorkerHealthResponseSchema = z.object({
  ok: z.boolean(),
  capabilities: WorkerCapabilitiesSchema,
  version: z.string().default('0.1.0'),
});

export type WorkerHealthResponse = z.infer<typeof WorkerHealthResponseSchema>;

// ─── Artifact Reference ────────────────────────────────────────────────────────

export const ArtifactRefSchema = z.object({
  type: z.enum(['html', 'html_min', 'screenshot', 'image_candidates', 'validation_results']),
  path: z.string(),
  sizeBytes: z.number().int().optional(),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ─── Snapshot ──────────────────────────────────────────────────────────────────

/** PI-11: a single deterministic page interaction (no natural-language automation). */
export const InteractionActionSchema = z.object({
  type: z.enum(['click_selector', 'select_option', 'open_accordion', 'dismiss_cookie']),
  /** CSS selector for click_selector / select_option / open_accordion. */
  selector: z.string().max(500).optional(),
  /** Exact option label for select_option (matched case-insensitively). */
  optionLabel: z.string().max(200).optional(),
  /** Max milliseconds to wait after the action before re-capture. */
  settleMs: z.number().int().min(0).max(10_000).default(1_000),
});
export type InteractionAction = z.infer<typeof InteractionActionSchema>;

export const SnapshotRequestSchema = z.object({
  url: z.string().url(),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
  captureScreenshot: z.boolean().default(true),
  /** PI-11: capture product-relevant XHR/fetch/GraphQL JSON responses. */
  captureNetwork: z.boolean().optional(),
  /** PI-11: one bounded deterministic interaction before re-capture. */
  interaction: InteractionActionSchema.nullable().optional(),
  /**
   * P0-1 (round 2): allowed source domains for the run. When present and
   * non-empty, navigation (initial + redirect hops), rendered sub-resources,
   * and captured network responses are restricted to these domains
   * (exact or subdomain-suffix match, case-insensitive).
   */
  sourcesAllowlist: z.array(z.string()).optional(),
});

export type SnapshotRequest = z.infer<typeof SnapshotRequestSchema>;

export const SnapshotResponseSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  htmlRef: z.string().nullable().default(null),
  screenshotRef: z.string().nullable().default(null),
  jsonLd: z.array(z.record(z.string(), z.unknown())).default(() => []),
  embeddedProductData: z.array(z.record(z.string(), z.unknown())).default(() => []),
  imageCandidates: z.array(z.string()).default(() => []),
  pageStructureSignals: z.array(z.string()).default(() => []),
  warnings: z.array(z.string()).default(() => []),
  /** PI-11: product-relevant captured network responses (XHR/fetch/GraphQL JSON). */
  networkResponses: z.array(NetworkCaptureArtifactSchema).optional(),
  /** Deterministic interaction result, when an interaction was requested. */
  interaction: z
    .object({
      action: InteractionActionSchema,
      performed: z.boolean(),
      /** Final URL after the action (variant selectors rewrite URLs). */
      finalUrl: z.string(),
      selectedOptions: z.array(z.string()).default(() => []),
      warnings: z.array(z.string()).default(() => []),
    })
    .nullable()
    .optional(),
  /** Artifact ref for the combined network capture payload (retention). */
  networkRef: z.string().nullable().optional(),
});

export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;

// ─── Generate Selector (Paste-Element) ───────────────────────────────────────

export const GenerateSelectorRequestSchema = z.object({
  /** Full page HTML (used to check selector uniqueness across the page). */
  html: z.string().min(1),
  /** The outerHTML of the element the user selected/copied from DevTools. */
  outerHTML: z.string().min(1),
});
export type GenerateSelectorRequest = z.infer<typeof GenerateSelectorRequestSchema>;

export const GenerateSelectorResponseSchema = z.object({
  selector: z.string(),
  stability: z.enum(['high', 'medium', 'low']),
  extractedText: z.string().nullable().default(null),
  extractedImages: z.array(z.string()).default(() => []),
  matchCount: z.number().int(),
  warnings: z.array(z.string()).default(() => []),
});
export type GenerateSelectorResponse = z.infer<typeof GenerateSelectorResponseSchema>;

// ─── Pick Element (Visual Picker) — DEPRECATED AND REMOVED ───────────────────
// The visual element picker feature has been removed due to reliability issues.
// PickElementRequestSchema, PickElementResponseSchema, and their associated
// types (PickElementRequest, PickElementResponse) were previously defined here.
// The paste-HTML generate-selector feature remains available.

// ─── Profile Proposal ──────────────────────────────────────────────────────────

export const SpreadsheetHintSchema = z.record(z.string(), z.string());

export type SpreadsheetHint = z.infer<typeof SpreadsheetHintSchema>;

export { StrictVariantSelectionStrategySchema };
export type { StrictVariantSelectionStrategy } from './onboarding';
export const VariantSelectionStrategySchema = z.object({
  containerSelector: z.string().nullable().default(null),
  optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).default('unknown'),
  detectedOptions: z.array(z.string()).default(() => []),
  optionFields: z.array(z.string()).default(() => []),
});
export type VariantSelectionStrategy = z.infer<typeof VariantSelectionStrategySchema>;

export const ProposalSeedSampleSchema = z.object({
  url: z.string().url(),
  expectedName: z.string().optional(),
  upc: z.string().optional(),
  spreadsheetHints: SpreadsheetHintSchema.default(() => ({})),
});

export type ProposalSeedSample = z.infer<typeof ProposalSeedSampleSchema>;

export const ProfileProposalRequestSchema = z.object({
  domain: z.string().min(1),
  seedSamples: z.array(ProposalSeedSampleSchema).min(1),
  allowLlm: z.boolean().default(false),
});

export type ProfileProposalRequest = z.infer<typeof ProfileProposalRequestSchema>;

export const ProfileProposalDraftSchema = z.object({
  domain: z.string(),
  urlPatterns: z.array(z.string()).default(() => []),
  pageStructureSignals: z.array(z.string()).default(() => []),
  runtime: z.enum(['static', 'rendered']).default('static'),
  selectors: z.record(z.string(), z.string().nullable()).default(() => ({})),
  titleOptionalSelectors: z.array(z.string()).default(() => []),
  imageRules: z.record(z.string(), z.unknown()).default(() => ({})),
  variantSelectionStrategy: VariantSelectionStrategySchema.nullable().default(null),
  warnings: z.array(z.string()).default(() => []),
});

export type ProfileProposalDraft = z.infer<typeof ProfileProposalDraftSchema>;

export const ProfileProposalResponseSchema = z.object({
  proposal: ProfileProposalDraftSchema,
  sampleArtifacts: z.array(z.string()).default(() => []),
});

export type ProfileProposalResponse = z.infer<typeof ProfileProposalResponseSchema>;

// ─── Validation ────────────────────────────────────────────────────────────────

export const ValidationSampleSchema = z.object({
  url: z.string().url(),
  confirmed: z.boolean().default(false),
  expectedName: z.string().optional(),
  upc: z.string().optional(),
  spreadsheetHints: SpreadsheetHintSchema.default(() => ({})),
});

export type ValidationSample = z.infer<typeof ValidationSampleSchema>;

export const ValidateRequestSchema = z.object({
  profileDraft: ProfileProposalDraftSchema,
  samples: z.array(ValidationSampleSchema).min(1),
});

export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const ValidationSampleResultSchema = z.object({
  sampleUrl: z.string(),
  confirmed: z.boolean(),
  fieldResults: z.record(z.string(), z.object({
    status: z.enum(['pass', 'warning', 'fail']),
    extractedValue: z.string().nullable().default(null),
    warnings: z.array(z.string()).default(() => []),
  })),
  imageResults: z.object({
    primaryImageMatch: z.boolean(),
    candidateCount: z.number().int(),
    warnings: z.array(z.string()).default(() => []),
  }),
  variantResult: z.object({
    selected: z.boolean(),
    variantTitle: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    containerSelector: z.string().nullable().default(null),
    optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).nullable().default(null),
    detectedOptions: z.array(z.string()).default(() => []),
    optionFields: z.array(z.string()).default(() => []),
    strategyValid: z.boolean().default(false),
  }).nullable().default(null),
});

export type ValidationSampleResult = z.infer<typeof ValidationSampleResultSchema>;

export const ValidateResponseSchema = z.object({
  summary: z.object({
    sampleCount: z.number().int(),
    confirmedSampleCount: z.number().int(),
    passingSamples: z.number().int(),
    failingSamples: z.number().int(),
    variantSamplesPassing: z.number().int().default(0),
  }),
  results: z.array(ValidationSampleResultSchema).default(() => []),
});

export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

// ─── Trusted Profile Runner Extract ────────────────────────────────────────────

export const VariantSelectionInputSchema = z.object({
  resolutionId: z.string().min(1).max(256),
  identityMatrixHash: z.string().regex(/^[a-f0-9]{64}$/),
  variantKey: z.string().min(1).max(256),
});
export type VariantSelectionInput = z.infer<typeof VariantSelectionInputSchema>;

export const VariantFailureCodeSchema = z.enum([
  'variant_selection_required',
  'variant_selection_stale',
  'variant_matrix_invalid',
]);
export type VariantFailureCode = z.infer<typeof VariantFailureCodeSchema>;

export const ExtractRequestSchema = z.object({
  profileId: z.string(),
  profileVersion: z.number().int(),
  sourceUrl: z.string().url(),
  expected: z.object({
    name: z.string(),
    brandHint: z.string().nullable().default(null),
    upc: z.string().optional(),
    /** Trusted source SKU for variant-identity matching (T4, optional). */
    sku: z.string().optional(),
    /** Exact known platform variant ID for identity matching (T4, optional). */
    platformVariantId: z.string().optional(),
    spreadsheetHints: SpreadsheetHintSchema.default(() => ({})),
    price: z.string().nullable().default(null),
  }),
  /** Optional variant selection receipt forwarded from job-queue for stale-safe extraction (M4). */
  variantSelection: VariantSelectionInputSchema.optional(),
  profile: z.object({
    runtime: z.enum(['static', 'rendered']).default('rendered'),
    selectors: z.record(z.string(), z.string().nullable()).default(() => ({})),
    titleOptionalSelectors: z.array(z.string()).default(() => []),
    customSelectors: z.record(z.string(), z.string()).default(() => ({})),
    imageRules: z.record(z.string(), z.unknown()).default(() => ({})),
    variantSelectionStrategy: z.union([StrictVariantSelectionStrategySchema, VariantSelectionStrategySchema]).nullable().default(null),
    /**
     * Shared extraction-policy content (T4 browser investigation). When
     * present and Shopify-backed, the worker executes the policy's
     * per-field source order through the Shopify endpoint adapter.
     * Absent (legacy profiles) keeps current selector semantics exactly.
     */
    extractionPolicy: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Worker-side source-domain allowlist for this profile execution. When
     * non-empty, every destination (initial fetch, every redirect hop, and
     * every rendered sub-resource) must be an exact or subdomain-suffix match
     * of one of these domains IN ADDITION to the SSRF floor. Derived from the
     * profile's approved domain (and, for Pi runs, the run policy's
     * allowedSourceDomains). */
    allowedSourceDomains: z.array(z.string().min(1).max(256)).max(64).default([]),
  }),
});

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const MatrixDecisionSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'no_match', 'unsupported', 'too_many_variants', 'stale_selection']),
  selectedVariantKey: z.string().nullable(),
  reasonCodes: z.array(z.string()),
});
export type MatrixDecision = z.infer<typeof MatrixDecisionSchema>;

export const ExtractResponseSchema = z.object({
  ok: z.boolean(),
  extractionData: ExtractionDataSchema.optional(),
  fieldProvenance: z.record(z.string(), z.string()).default(() => ({})),
  /** Exact method/path for each returned field; unlike fieldProvenance's
   * legacy method labels this retains selector/structured-data paths. */
  fieldProvenanceDetails: z.record(z.string(), z.object({ method: z.string(), sourcePath: z.string() })).default(() => ({})),
  profileRuntime: z.enum(['static', 'rendered']),
  profileId: z.string(),
  profileVersion: z.number().int(),
  /** Hash of the exact bytes executed by the profile runner, when retained. */
  sourceContentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  sourceArtifactId: z.string().min(1).nullable().default(null),
  warnings: z.array(z.string()).default(() => []),
  /** Variant matrix decision when variant resolution was evaluated (M4). */
  matrixDecision: MatrixDecisionSchema.nullable().optional(),
  /** Selected variant receipt when extraction was variant-scoped (M4). */
  selectedReceipt: VariantSelectionReceiptSchema.nullable().optional(),
  /** Structured variant failure code for job-queue gate (M4). */
  failureCode: VariantFailureCodeSchema.nullable().optional(),
  /** Canonical variant matrix for durable evidence (additive, bounded). */
  variantMatrix: VariantMatrixSchema.nullable().optional(),
  /** Identity hash of canonical matrix (sha256 64hex). */
  identityMatrixHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  /** Bounded candidates subset (max 250) for evidence preservation. */
  candidates: z.array(NormalizedVariantCandidateSchema).max(250).nullable().optional(),
  /** Parent product ID for Shopify policy extractions (T4 browser investigation
   * product-identity verification). Absent for legacy paths. */
  parentProductId: z.string().min(1).nullable().optional(),
});

export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

// ─── Job Queue Payloads ────────────────────────────────────────────────────────

export const WorkerJobTypeEnum = z.enum([
  'profile_tooling_propose',
  'profile_tooling_validate',
]);

export type WorkerJobType = z.infer<typeof WorkerJobTypeEnum>;

export const WorkerJobStatusEnum = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
]);

export type WorkerJobStatus = z.infer<typeof WorkerJobStatusEnum>;

export const WorkerJobPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('profile_tooling_propose'),
    payload: ProfileProposalRequestSchema,
  }),
  z.object({
    type: z.literal('profile_tooling_validate'),
    payload: ValidateRequestSchema,
  }),
]);

export type WorkerJobPayload = z.infer<typeof WorkerJobPayloadSchema>;

export const WorkerJobResultSchema = z.object({
  jobId: z.string(),
  status: WorkerJobStatusEnum,
  progress: z.number().min(0).max(1).default(0),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  artifactRefs: z.array(z.string()).default(() => []),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export type WorkerJobResult = z.infer<typeof WorkerJobResultSchema>;
