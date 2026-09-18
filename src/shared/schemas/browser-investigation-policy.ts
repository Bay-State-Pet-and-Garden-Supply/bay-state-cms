// Browser-Assisted Extraction Investigation — T2 deterministic policy contract.
//
// Versioned, provider-neutral compiler surface. The compiler (T2) turns the
// versioned typed investigation result into an Extraction Policy Proposal —
// per-field source order plus minimal selector exceptions, with product and
// Source-Page Variant identity requirements — or into `requires_code_adapter`
// / typed unresolved gaps. Arbitrary generated programs are never persisted
// for later execution: only the allowlisted primitives below may appear in a
// proposal, and selectors are bounded validated data, not code.
//
// This module is pure (Zod + canonical JSON only): no DB, no network, no
// provider SDK imports. Safe for Vitest and for the production worker.

import { z } from 'zod';
import { hashCanonicalJson } from '../stable-id';

/** Version of the Extraction Policy Proposal envelope. */
export const EXTRACTION_POLICY_VERSION = 1 as const;

/**
 * Extraction fields a proposal may cover, in canonical display order
 * (user story 11: title, brand, description, price, images, SKU, GTIN,
 * variants, availability).
 */
export const POLICY_FIELDS = [
  'title',
  'brand',
  'description',
  'price',
  'images',
  'sku',
  'gtin',
  'variants',
  'availability',
] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];

export const PolicyFieldSchema = z.enum(POLICY_FIELDS);

/**
 * Supported versioned extraction primitives — the ONLY source kinds the
 * deterministic compiler may emit into a proposal. Each maps to an existing
 * deterministic runtime capability:
 *
 * - `shopify_product_json`: Shopify public product JSON adapter
 *   (`fetchShopifyProductJson` / `shopifyProductUrl` in the ladder platforms
 *   module; Shopify-first vertical slice).
 * - `json_ld`: JSON-LD structured-data layer of the page extractor.
 * - `microdata`: microdata layer of the page extractor.
 * - `meta`: meta/OG tag layer of the page extractor.
 * - `embedded_state`: embedded app-state parsers (Next/Nuxt hydration state,
 *   WooCommerce embedded Store API payloads) in the ladder platforms module.
 * - `selector`: a validated CSS selector exception against the page DOM.
 *
 * Anything else observed during investigation (click flows, arbitrary JS or
 * Python, POST-only APIs, novel platform representations without a coded
 * adapter) is reported as an unresolved gap or `requires_code_adapter` —
 * never persisted as executable policy.
 */
export const SUPPORTED_POLICY_SOURCES = [
  'shopify_product_json',
  'json_ld',
  'microdata',
  'meta',
  'embedded_state',
  'selector',
] as const;
export type SupportedPolicySource = (typeof SUPPORTED_POLICY_SOURCES)[number];

export const SupportedPolicySourceSchema = z.enum(SUPPORTED_POLICY_SOURCES);

export function isSupportedPolicySource(value: string): value is SupportedPolicySource {
  return (SUPPORTED_POLICY_SOURCES as readonly string[]).includes(value);
}

/** Maximum selector-exception length (bounded data, matching the T3 grammar cap). */
export const MAX_POLICY_SELECTOR_LENGTH = 512;
/** Maximum selector exceptions per proposal: at most one per field. */
export const MAX_POLICY_SELECTOR_EXCEPTIONS = POLICY_FIELDS.length;

/**
 * Substrings/patterns that disqualify a proposed selector. Selectors are
 * read-only element queries — never scripts, URLs, style directives, or
 * template expressions. Case-insensitive entries are matched lowered.
 */
const FORBIDDEN_SELECTOR_SUBSTRINGS = [
  '<',
  '`',
  '${',
  '{{',
  '}}',
  'javascript:',
  'expression(',
  'url(',
  '-moz-binding',
  'behavior:',
  '@',
  ';',
  '!',
  '\\',
] as const;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate a proposed selector exception. Returns the trimmed selector on
 * success; executable-looking or unbounded input is rejected with a stable
 * operator-safe reason (the raw input is never echoed back).
 */
export function validatePolicySelector(
  raw: unknown,
): { ok: true; selector: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'selector_not_a_string' };
  const selector = raw.trim();
  if (!selector) return { ok: false, reason: 'selector_empty' };
  if (selector.length > MAX_POLICY_SELECTOR_LENGTH) return { ok: false, reason: 'selector_too_long' };
  if (CONTROL_CHAR_RE.test(selector)) return { ok: false, reason: 'selector_control_characters' };
  const lowered = selector.toLowerCase();
  for (const forbidden of FORBIDDEN_SELECTOR_SUBSTRINGS) {
    if (lowered.includes(forbidden)) return { ok: false, reason: 'selector_executable_pattern' };
  }
  return { ok: true, selector };
}

/**
 * One inspected page structure (visual template) within the investigated
 * domain. Shared by the typed result (transport) and the compiled proposal:
 * the compiler preserves declared structures verbatim, so both sides carry
 * the identical wire shape.
 */
export const PolicyStructureSchema = z.object({
  id: z.string().min(1).max(64),
  sampleUrls: z.array(z.string().url()).max(5),
  description: z.string().max(1000).optional(),
  /** Extraction representation observed (e.g. `shopify_product_json`). Free text: transport only. */
  platformSource: z.string().min(1).max(120).optional(),
});
export type InvestigationStructure = z.infer<typeof PolicyStructureSchema>;
export type ProposalStructure = z.infer<typeof PolicyStructureSchema>;

/**
 * One per-field source recommendation from the typed investigation result.
 * `sources` is transport: arbitrary strings the compiler allowlists against
 * SUPPORTED_POLICY_SOURCES. Unknown entries become typed unresolved gaps —
 * schema validation must NOT reject them, or the compiler could never report
 * unsupported primitives honestly.
 */
export const FieldRecommendationSchema = z.object({
  field: PolicyFieldSchema,
  sources: z.array(z.string().min(1).max(120)).min(1).max(6),
  selector: z.string().min(1).max(MAX_POLICY_SELECTOR_LENGTH).optional(),
  evidenceRef: z.string().min(1).max(500).optional(),
  structureId: z.string().min(1).max(64).optional(),
});
export type FieldRecommendation = z.infer<typeof FieldRecommendationSchema>;

/**
 * Product and Source-Page Variant identity requirements. Ordered preference
 * lists using the variant-resolver vocabulary (`gtin_exact` outranks weaker
 * identifiers; fuzzy name similarity alone never resolves identity). Data,
 * not executable logic — the production matcher stays authoritative.
 */
export const PolicyIdentitySchema = z.object({
  productIdentity: z.array(z.string().min(1).max(64)).min(1).max(6),
  variantIdentity: z.array(z.string().min(1).max(64)).min(1).max(8),
  optionAxes: z.array(z.string().min(1).max(64)).max(8).default([]),
});
export type PolicyIdentity = z.infer<typeof PolicyIdentitySchema>;

/** Typed declaration that investigation succeeded as evidence but needs a coded runtime adapter. */
export const CodeAdapterNeedSchema = z.object({
  capability: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
});
export type CodeAdapterNeed = z.infer<typeof CodeAdapterNeedSchema>;

/** One compiled per-field policy entry: ordered supported sources plus an optional selector exception. */
export const FieldPolicySchema = z.object({
  field: PolicyFieldSchema,
  sources: z.array(SupportedPolicySourceSchema).min(1).max(6),
  selector: z.string().min(1).max(MAX_POLICY_SELECTOR_LENGTH).optional(),
  evidenceRef: z.string().min(1).max(500).optional(),
});
export type FieldPolicy = z.infer<typeof FieldPolicySchema>;

export const InvestigationPlatformSchema = z.enum([
  'shopify',
  'woocommerce',
  'nextjs',
  'nuxt',
  'generic',
  'custom',
  'unknown',
]);
export type InvestigationPlatform = z.infer<typeof InvestigationPlatformSchema>;

/**
 * Extraction Policy Proposal: the compilable, reviewable, version-bound
 * output of the deterministic compiler. Carries immutable investigation
 * binding (investigationId/runId/inputHash/resultHash) so stale or replayed
 * applications are rejected at apply time.
 */
export const ExtractionPolicyProposalSchema = z.object({
  version: z.literal(EXTRACTION_POLICY_VERSION),
  domain: z.string().min(1).max(253),
  investigationId: z.string().min(1),
  runId: z.string().min(1),
  inputHash: z.string().min(8),
  resultHash: z.string().min(8),
  platform: InvestigationPlatformSchema,
  structures: z.array(PolicyStructureSchema).min(1).max(8),
  fields: z.array(FieldPolicySchema).min(1).max(POLICY_FIELDS.length),
  identity: PolicyIdentitySchema,
  renderedBrowserRequired: z.boolean(),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(50).default([]),
  compiledAt: z.string().min(1),
});
export type ExtractionPolicyProposal = z.infer<typeof ExtractionPolicyProposalSchema>;

/** Typed unresolved gap. Details are compiler-templated from stable codes and field names only. */
export const UnresolvedGapSchema = z.object({
  kind: z.enum([
    'unsupported_primitive',
    'missing_field_evidence',
    'missing_identity',
    'incompatible_structures',
    'selector_missing',
    'selector_rejected',
  ]),
  field: PolicyFieldSchema.optional(),
  detail: z.string().min(1).max(500),
  evidenceRef: z.string().min(1).max(500).optional(),
});
export type UnresolvedGap = z.infer<typeof UnresolvedGapSchema>;

/** Typed `requires_code_adapter` outcome: evidence succeeded, no supported runtime primitive exists. */
export const CodeAdapterRequestSchema = z.object({
  summary: z.string().min(1).max(500),
  capability: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(50).default([]),
  structureIds: z.array(z.string().min(1).max(64)).max(8).default([]),
});
export type CodeAdapterRequest = z.infer<typeof CodeAdapterRequestSchema>;

/**
 * Deterministic compiler outcome. Only `proposal` is appliable to a draft;
 * `requires_code_adapter` and `unresolved` stay unappliable and preserve
 * their reasons as blockers. `gaps` on a proposal are non-fatal coverage
 * gaps the apply path preserves as draft blockers.
 */
export const CompileOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('proposal'),
    proposal: ExtractionPolicyProposalSchema,
    gaps: z.array(UnresolvedGapSchema).default([]),
    warnings: z.array(z.string().min(1).max(500)).default([]),
  }),
  z.object({
    status: z.literal('requires_code_adapter'),
    codeAdapterRequest: CodeAdapterRequestSchema,
  }),
  z.object({
    status: z.literal('unresolved'),
    gaps: z.array(UnresolvedGapSchema).min(1).max(50),
  }),
]);
export type CompileOutcome = z.infer<typeof CompileOutcomeSchema>;

/**
 * Stored extraction-policy content: the executable subset of a proposal
 * persisted on a profile version (T2 `sanitizedDraftSelectors`). Carries
 * NO investigation binding (ids/hashes live on the proposal artifact and
 * the version's validationSummary) — this is what the production worker
 * executes (T4 Shopify slice). Derived by pick so content and proposal
 * can never drift on the shared executable shape.
 */
export const ExtractionPolicyContentSchema = ExtractionPolicyProposalSchema.pick({
  version: true,
  platform: true,
  structures: true,
  fields: true,
  identity: true,
  renderedBrowserRequired: true,
});
export type ExtractionPolicyContent = z.infer<typeof ExtractionPolicyContentSchema>;

/**
 * Hash of the POLICY CONTENT only (platform, structures, fields, identity,
 * rendered-browser need) — the drift-comparison identity. Editing any policy
 * content changes this hash and invalidates prior validation bound to it.
 * Investigation binding (ids/hashes/timestamps) is deliberately excluded so
 * the same learned policy re-derived in a later run hashes identically.
 */
export function hashPolicyContent(policy: {
  platform: string;
  structures: unknown;
  fields: unknown;
  identity: unknown;
  renderedBrowserRequired: boolean;
}): string {
  return hashCanonicalJson({
    platform: policy.platform,
    structures: policy.structures,
    fields: policy.fields,
    identity: policy.identity,
    renderedBrowserRequired: policy.renderedBrowserRequired,
  });
}

/**
 * Hash of the full proposal artifact, including its immutable investigation
 * binding. `compiledAt` is informational only and excluded: compilation is
 * deterministic, so the same result compiled at different times must hash
 * identically (otherwise a stored proposal could never re-bind at apply).
 */
export function hashProposal(proposal: ExtractionPolicyProposal): string {
  const { compiledAt: _compiledAt, ...bound } = proposal;
  void _compiledAt;
  return hashCanonicalJson(bound);
}

/** Plain JSON-domain record check (no class instances, arrays, or exotic prototypes). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read the shared extraction-policy content from version selectors (forward-compatible: legacy rows lack it). */
export function extractionPolicyOfSelectors(selectors: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(selectors)) return null;
  const policy = selectors.extractionPolicy;
  return isPlainRecord(policy) ? policy : null;
}

/**
 * Immutable version binding for policy content. Versions whose
 * validationSummary carries a `policyHash` must still carry the identical
 * policy content — any edit invalidates the prior validation (fail closed).
 * Legacy versions without a `policyHash` keep current semantics (true).
 */
export function isPolicyBindingIntact(selectors: unknown, validationSummary: unknown): boolean {
  if (!isPlainRecord(validationSummary)) return true;
  const expected = validationSummary.policyHash;
  if (expected === undefined || expected === null) return true;
  if (typeof expected !== 'string' || !expected) return false;
  try {
    const policy = extractionPolicyOfSelectors(selectors);
    const actual = hashPolicyContent({
      platform: typeof policy?.platform === 'string' ? policy.platform : 'unknown',
      structures: policy?.structures ?? [],
      fields: policy?.fields ?? [],
      identity: policy?.identity ?? {},
      renderedBrowserRequired: policy?.renderedBrowserRequired === true,
    });
    return actual === expected;
  } catch {
    return false;
  }
}

/**
 * Proposal field → profile selector slot. Core product fields map to core
 * selector columns; identifier/variant/availability fields map to namespaced
 * custom-selector keys so they can never clobber a core slot.
 */
export const FIELD_TO_SELECTOR_SLOT: Readonly<Record<PolicyField, string>> = {
  title: 'titleSelector',
  price: 'priceSelector',
  description: 'descriptionSelector',
  brand: 'brandSelector',
  images: 'imagesSelector',
  sku: 'skuSelector',
  gtin: 'gtinSelector',
  variants: 'variantsSelector',
  availability: 'availabilitySelector',
};

const CORE_SELECTOR_SLOTS = new Set(['titleSelector', 'priceSelector', 'descriptionSelector', 'brandSelector', 'imagesSelector']);

export function isCoreSelectorSlot(slot: string): boolean {
  return CORE_SELECTOR_SLOTS.has(slot);
}
