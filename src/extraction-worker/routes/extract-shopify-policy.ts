/**
 * Shopify endpoint-backed extraction-policy execution (T4 browser
 * investigation).
 *
 * A profile carrying extractionPolicy content (platform `shopify`,
 * per-field source order) executes the Shopify `.js` endpoint through the
 * EXISTING normalized matcher (matchVariantMatrix) — no second matcher —
 * and binds per-field values by policy source order. Conflicting or absent
 * identifiers fail closed to ambiguity. Legacy profiles (no policy) never
 * enter this path.
 *
 * Lives beside the trusted profile runner (not inside it) so the legacy
 * runner file stays a small diff. The runner's deterministic helpers
 * arrive via an explicit `helpers` seam (injected by `doStaticExtract`),
 * so this module never imports the runner file: the dependency edge is
 * one-way, the policy path is independently testable, and no import
 * cycle can form.
 */

import * as cheerio from 'cheerio';
import {
  computeIdentityMatrixHash,
  VariantSelectionReceiptSchema,
  type NormalizedVariantCandidate,
} from '../../shared/schemas/variant-resolution';
import {
  matchVariantMatrix,
  normalizeGtin,
  normalizeSkuMpn,
  parseShopifyMatrix,
  parseVariantMatrix,
  verifyOperatorSelectionReceipt,
} from '../../onboarding/variant-resolver';
import { shopifyProductUrl } from '../../onboarding/extraction-ladder/platforms';
import { buildVariantProvenance } from '../../onboarding/selected-variant-materializer';
import {
  ExtractionPolicyContentSchema,
  type ExtractionPolicyContent,
  type PolicyField,
  type SupportedPolicySource,
} from '../../shared/schemas/browser-investigation-policy';
import type { ExtractionData } from '../../shared/schemas/onboarding';
import type {
  ExtractRequest,
  VariantFailureCode,
} from '../../shared/schemas/extraction-worker';

/** Injected worker-transport seam (provided by the trusted profile runner). */
interface PolicyTransportDeps {
  lookupFn?: (hostname: string, options: { all: true }) => Promise<Array<{ address: string }>>;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Provenance detail for one accepted field (mirrors the runner carrier). */
interface PolicyFieldProvenanceDetail {
  method: string;
  sourcePath: string;
}

/** Deterministic runner helpers injected by `doStaticExtract` (no import cycle). */
interface PolicyHelperFns {
  safeProfileFetch(
    url: string,
    signal: AbortSignal,
    allowedSourceDomains: string[],
    deps: PolicyTransportDeps,
  ): Promise<Response>;
  evaluateSelectorCheerio(
    $: cheerio.CheerioAPI,
    selector: string | null | undefined,
    jsonLd: Record<string, unknown> | null,
    metaTags: Record<string, string>,
  ): string | null;
  collectImagesCheerio(
    $: cheerio.CheerioAPI,
    imagesSelector: string | null | undefined,
    jsonLd: Record<string, unknown> | null,
    metaTags: Record<string, string>,
    baseUrl: string,
  ): string[];
  buildExtractionData(
    fields: {
      title: string;
      brand: string | null;
      description: string | null;
      price: string | null;
      primaryImage: string | null;
      additionalImages: string[];
      provenance: Record<string, string>;
    },
    sourceUrl: string,
    expectedName: string | undefined,
  ): ExtractionData;
  buildFailedResult(request: ExtractRequest, warnings: string[]): { data: ExtractionData; warnings: string[] };
  buildFieldProvenanceDetails(
    provenance: Record<string, string>,
    origins: Record<string, string | null>,
  ): Record<string, PolicyFieldProvenanceDetail>;
  retainProfileSource(sourceUrl: string, html: string): { sourceContentHash: string; sourceArtifactId: string | null };
  cleanAndDeduplicateImages(urls: string[], baseUrl?: string): string[];
  resolveUrl(src: string, baseUrl: string): string | null;
  extractJsonLdFromCheerio($: cheerio.CheerioAPI): Record<string, unknown> | null;
  extractMetaTagsFromCheerio($: cheerio.CheerioAPI): Record<string, string>;
  extractMicrodataFromCheerio($: cheerio.CheerioAPI): Record<string, string>;
  fetchShopifyJsText(
    jsUrl: string,
    finalUrl: string,
    allowedSourceDomains: string[],
    deps: PolicyTransportDeps,
  ): Promise<{ text: string | null; attempted: boolean; failure: string | null; message: string }>;
}

// ─── Shopify policy execution (T4 browser investigation) ───────────────────
// A profile carrying extractionPolicy content (platform `shopify`, per-field
// source order) executes the Shopify `.js` endpoint through the EXISTING
// normalized matcher (matchVariantMatrix) — no second matcher — and binds
// per-field values by policy source order. Conflicting or absent
// identifiers fail closed to ambiguity. Legacy profiles (no policy) never
// enter this path and keep current semantics exactly.

/** Parsed Shopify policy content, or null for legacy / non-Shopify profiles. */
// fallow-ignore-next-line unused-export — trusted profile runner dispatch
export function shopifyPolicyOf(profile: ExtractRequest['profile']): ExtractionPolicyContent | null {
  const raw = (profile as { extractionPolicy?: unknown }).extractionPolicy;
  if (!raw) return null;
  const parsed = ExtractionPolicyContentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const policy = parsed.data;
  if (policy.platform !== 'shopify') return null;
  if (!policy.fields.some((f) => f.sources.includes('shopify_product_json'))) return null;
  return policy;
}

interface ShopifyPolicyEvidence {
  matrix: NonNullable<ReturnType<typeof parseVariantMatrix>>;
  matrixSource: 'shopify_js' | 'embedded';
  matrixSourceUrl: string | null;
  parentProductId: string | null;
  productTitle: string | null;
  productVendor: string | null;
  productDescription: string | null;
  productImages: string[];
}

function stripPolicyHtml(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 2000) : null;
}

/**
 * Fetch the Shopify `.js` endpoint (preferred, richer evidence) through the
 * same safe transport as the legacy gate; fall back to embedded matrix
 * evidence already on the page. Returns null only when neither source
 * yields variant evidence.
 */
async function fetchShopifyPolicyEvidence(
  html: string,
  finalUrl: string,
  allowedSourceDomains: string[],
  deps: PolicyTransportDeps,
  warnings: string[],
  helpers: PolicyHelperFns,
): Promise<ShopifyPolicyEvidence | null> {
  const jsUrl = shopifyProductUrlOrNull(finalUrl);
  if (jsUrl) {
    const fetched = await helpers.fetchShopifyJsText(jsUrl, finalUrl, allowedSourceDomains, deps);
    if (fetched.failure) warnings.push(`Shopify policy endpoint ${fetched.failure}: ${fetched.message}`);
    const fromEndpoint = fetched.text ? evidenceFromEndpointText(fetched.text, finalUrl, jsUrl) : null;
    if (fromEndpoint) return fromEndpoint;
  }
  return embeddedPolicyEvidence(html, finalUrl, warnings);
}

function shopifyProductUrlOrNull(finalUrl: string): string | null {
  try {
    return shopifyProductUrl(finalUrl);
  } catch {
    return null;
  }
}

/** Parse endpoint text into policy evidence (null when the payload is unusable). */
function evidenceFromEndpointText(
  jsText: string,
  finalUrl: string,
  jsUrl: string,
): ShopifyPolicyEvidence | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload.title !== 'string' || !Array.isArray(payload.variants)) return null;
  const matrix = parseShopifyMatrix(jsText, finalUrl);
  if (!matrix || matrix.candidates.length === 0) return null;
  return {
    matrix,
    matrixSource: 'shopify_js',
    matrixSourceUrl: jsUrl,
    parentProductId: payload.id != null ? String(payload.id) : null,
    productTitle: payload.title,
    productVendor: typeof payload.vendor === 'string' ? payload.vendor : null,
    productDescription: stripPolicyHtml(typeof payload.body_html === 'string' ? payload.body_html : null),
    productImages: endpointImageUrls(payload.images),
  };
}

/**
 * Image URLs from the endpoint payload. The public Shopify product endpoint
 * returns a plain string array; richer payloads (embedded productJSON) carry
 * `{ src }` objects — accept both, never invent an entry.
 */
function endpointImageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: unknown) => (typeof entry === 'string' ? entry : (entry as { src?: unknown } | null)?.src))
    .filter((src): src is string => typeof src === 'string' && src.trim().length > 0);
}

/** Same-platform embedded evidence already on the page (fallback with a warning). */
function embeddedPolicyEvidence(
  html: string,
  finalUrl: string,
  warnings: string[],
): ShopifyPolicyEvidence | null {
  const embedded = parseVariantMatrix(html, finalUrl);
  if (!embedded || embedded.candidates.length === 0) return null;
  warnings.push('Shopify policy fell back to embedded variant evidence');
  return {
    matrix: embedded,
    matrixSource: 'embedded',
    matrixSourceUrl: null,
    parentProductId: null,
    productTitle: null,
    productVendor: null,
    productDescription: null,
    productImages: [],
  };
}

/** Policy field → profile selector slot (core columns, else namespaced custom keys). */
const POLICY_FIELD_SELECTOR_SLOT: Record<PolicyField, string> = {
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

function policySelectorFor(field: PolicyField, profile: ExtractRequest['profile']): string | null {
  const slot = POLICY_FIELD_SELECTOR_SLOT[field];
  const core = (profile.selectors as Record<string, string | null> | undefined)?.[slot];
  if (core) return core;
  return profile.customSelectors?.[slot] ?? null;
}

interface PolicyReadContext {
  evidence: ShopifyPolicyEvidence;
  selected: NormalizedVariantCandidate;
  helpers: PolicyHelperFns;
  $: cheerio.CheerioAPI;
  jsonLd: Record<string, unknown> | null;
  metaTags: Record<string, string>;
  microdata: Record<string, string>;
  profile: ExtractRequest['profile'];
  finalUrl: string;
}

type PolicyFieldValue = string | string[] | null;

function selectedIdentifier(ctx: PolicyReadContext, kind: 'sku' | 'gtin'): string | null {
  const found = ctx.selected.identifiers.find((i) => i.kind === kind);
  return found ? found.value : null;
}

function jsonLdImageUrls(
  raw: unknown,
  finalUrl: string,
  resolve: (src: string, baseUrl: string) => string | null,
): string[] {
  const list: string[] = [];
  const push = (u: unknown): void => {
    if (typeof u !== 'string') return;
    const res = resolve(u, finalUrl);
    if (res) list.push(res);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) push(typeof item === 'object' ? (item as { url?: unknown })?.url : item);
  } else if (typeof raw === 'object' && raw !== null) {
    push((raw as { url?: unknown }).url);
  } else {
    push(raw);
  }
  return list;
}

/** Read one policy field from the Shopify endpoint payload + selected variant. */
function readShopifyPolicyField(field: PolicyField, ctx: PolicyReadContext): PolicyFieldValue {
  if (field === 'images') return selectedImageList(ctx);
  if (field === 'variants') return selectedVariantLabel(ctx);
  return readShopifyScalarField(field, ctx);
}

function readShopifyScalarField(
  field: Exclude<PolicyField, 'images' | 'variants'>,
  ctx: PolicyReadContext,
): PolicyFieldValue {
  switch (field) {
    case 'title':
      return ctx.evidence.productTitle;
    case 'brand':
      return ctx.evidence.productVendor;
    case 'description':
      return ctx.evidence.productDescription;
    case 'price':
      return ctx.selected.price;
    case 'sku':
      return selectedIdentifier(ctx, 'sku');
    case 'gtin':
      return selectedIdentifier(ctx, 'gtin');
    case 'availability':
      return ctx.selected.available ? 'in_stock' : 'out_of_stock';
  }
}

function selectedImageList(ctx: PolicyReadContext): string[] {
  const primary = ctx.selected.images.find((i) => i.role === 'primary')?.url;
  const gallery = ctx.selected.images.filter((i) => i.role !== 'primary').map((i) => i.url);
  return [primary, ...gallery, ...ctx.evidence.productImages].filter((u): u is string => !!u);
}

function selectedVariantLabel(ctx: PolicyReadContext): string {
  const opts = ctx.selected.options.map((o) => o.value).filter(Boolean);
  return opts.length > 0 ? opts.join(' / ') : ctx.selected.title;
}

/** Read one policy field through a profile selector exception. */
function readSelectorPolicyField(field: PolicyField, ctx: PolicyReadContext): PolicyFieldValue {
  const slot = policySelectorFor(field, ctx.profile);
  if (!slot) return null;
  if (field === 'images') {
    return ctx.helpers.collectImagesCheerio(ctx.$, slot, ctx.jsonLd, ctx.metaTags, ctx.finalUrl);
  }
  return ctx.helpers.evaluateSelectorCheerio(ctx.$, slot, ctx.jsonLd, ctx.metaTags);
}

/** Read one policy field from JSON-LD structured data. */
function readJsonLdPolicyField(field: PolicyField, ctx: PolicyReadContext): PolicyFieldValue {
  if (!ctx.jsonLd) return null;
  const j = ctx.jsonLd as Record<string, unknown>;
  switch (field) {
    case 'title':
      return typeof j.name === 'string' ? j.name : null;
    case 'brand':
      return jsonLdBrandName(j.brand);
    case 'description':
      return typeof j.description === 'string' ? j.description : null;
    case 'price':
      return jsonLdOfferPrice(j.offers);
    case 'images':
      return jsonLdImageUrls(j.image, ctx.finalUrl, ctx.helpers.resolveUrl);
    default:
      return null;
  }
}

function jsonLdBrandName(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  const name = (raw as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : null;
}

function jsonLdOfferPrice(offers: unknown): string | null {
  const first = Array.isArray(offers) ? offers[0] : (offers as { price?: unknown } | undefined);
  return first?.price != null ? String(first.price) : null;
}

/** Microdata itemprops backing scalar policy fields (images handled separately). */
const MICRODATA_FIELD_PROPS = { title: 'name', brand: 'brand', description: 'description', price: 'price' } as const;

/** Read one policy field from microdata. */
function readMicrodataPolicyField(field: PolicyField, ctx: PolicyReadContext): PolicyFieldValue {
  if (field === 'images') return microdataImages(ctx);
  const prop = (MICRODATA_FIELD_PROPS as Record<string, string>)[field];
  if (!prop) return null;
  return ctx.microdata[prop] ?? null;
}

function microdataImages(ctx: PolicyReadContext): string[] {
  if (!ctx.microdata.image) return [];
  const resolved = ctx.helpers.resolveUrl(ctx.microdata.image, ctx.finalUrl);
  return resolved ? [resolved] : [];
}

/** Meta keys backing scalar policy fields (images handled separately). */
const META_FIELD_KEYS: Readonly<Record<string, string[]>> = {
  title: ['og:title', 'page:title'],
  description: ['og:description', 'description'],
  price: ['product:price:amount'],
};

/** Read one policy field from meta tags. */
function readMetaPolicyField(field: PolicyField, ctx: PolicyReadContext): PolicyFieldValue {
  if (field === 'images') return metaImages(ctx);
  const keys = META_FIELD_KEYS[field] ?? [];
  for (const key of keys) {
    if (ctx.metaTags[key]) return ctx.metaTags[key];
  }
  return null;
}

function metaImages(ctx: PolicyReadContext): string[] {
  if (!ctx.metaTags['og:image']) return [];
  const resolved = ctx.helpers.resolveUrl(ctx.metaTags['og:image'], ctx.finalUrl);
  return resolved ? [resolved] : [];
}

/** Read one policy field from one supported source. Unavailable → null (next source). */
function readPolicyField(
  field: PolicyField,
  source: SupportedPolicySource,
  ctx: PolicyReadContext,
): PolicyFieldValue {
  switch (source) {
    case 'shopify_product_json':
      return readShopifyPolicyField(field, ctx);
    case 'selector':
      return readSelectorPolicyField(field, ctx);
    case 'json_ld':
      return readJsonLdPolicyField(field, ctx);
    case 'microdata':
      return readMicrodataPolicyField(field, ctx);
    case 'meta':
      return readMetaPolicyField(field, ctx);
    case 'embedded_state':
      return null;
  }
}

function policyFieldProvenance(source: SupportedPolicySource): string {
  switch (source) {
    case 'shopify_product_json':
      return 'shopify_product_json';
    case 'selector':
      return 'profile-selector';
    case 'json_ld':
      return 'json-ld';
    case 'microdata':
      return 'microdata';
    case 'meta':
      return 'meta';
    case 'embedded_state':
      return 'embedded-state';
  }
}

function policyFieldOrigin(source: SupportedPolicySource, field: PolicyField, ctx: PolicyReadContext): string {
  switch (source) {
    case 'shopify_product_json':
      return ctx.evidence.matrixSourceUrl ?? 'shopify:embedded';
    case 'selector':
      return policySelectorFor(field, ctx.profile) ?? `profile:${POLICY_FIELD_SELECTOR_SLOT[field]}`;
    case 'json_ld':
      return `json-ld:Product.${field}`;
    case 'microdata':
      return `microdata:Product.${field}`;
    case 'meta':
      return `meta:${field}`;
    case 'embedded_state':
      return 'embedded-state:unavailable';
  }
}

function isNonEmptyValue(value: PolicyFieldValue): value is string | string[] {
  if (value === null) return false;
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
}

/**
 * Execute a Shopify extraction policy: endpoint-backed evidence, the
 * existing normalized matcher for identity, per-field source order for
 * values. Returns the same carrier shape as `doStaticExtract`.
 */
type PolicyIdentityResolution =
  | {
      ok: true;
      decision: ReturnType<typeof matchVariantMatrix> | null;
      selected: NormalizedVariantCandidate;
      origin: 'automatic' | 'operator' | 'single';
    }
  | { ok: false; decision: ReturnType<typeof matchVariantMatrix>; code: VariantFailureCode; note: string };

type OperatorSelectionInput = { resolutionId: string; identityMatrixHash: string; variantKey: string };

/** Stringify a trusted expected input (empty/absent → null). */
function expectedText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function policyMatchInputOf(request: ExtractRequest): {
  gtin: string | null;
  sku: string | null;
  mpn: null;
  platformVariantId: string | null;
  name: string;
  brandHint: string | null;
  price: string | null;
  variantTokens: undefined;
} {
  const expected = request.expected as ExtractRequest['expected'] & { sku?: string | null; platformVariantId?: string | null };
  return {
    gtin: expectedText(expected?.upc),
    sku: expectedText(expected?.sku),
    mpn: null,
    platformVariantId: expectedText(expected?.platformVariantId),
    name: typeof expected?.name === 'string' ? expected.name : '',
    brandHint: expectedText(expected?.brandHint),
    price: expectedText(expected?.price),
    variantTokens: undefined,
  };
}

function operatorSelectionOf(request: ExtractRequest): OperatorSelectionInput | undefined {
  return (request as unknown as { variantSelection?: OperatorSelectionInput }).variantSelection;
}

/** Verify an operator receipt against the live policy matrix (stale-safe, M4). */
function verifyPolicyOperatorSelection(
  matrix: ShopifyPolicyEvidence['matrix'],
  receiptInput: OperatorSelectionInput,
): PolicyIdentityResolution {
  const verified = verifyOperatorSelectionReceipt(matrix, receiptInput);
  if (!verified.ok && verified.kind === 'stale') {
    return {
      ok: false,
      decision: {
        status: 'stale_selection',
        selectedVariantKey: null,
        reasonCodes: ['stale_selection'],
        matchedBy: 'none',
        diagnostics: ['stale operator selection for policy matrix'],
        rankedKeys: [],
      },
      code: 'variant_selection_stale',
      note: 'Shopify policy operator selection is stale',
    };
  }
  if (!verified.ok) {
    return {
      ok: false,
      decision: {
        status: 'no_match',
        selectedVariantKey: null,
        reasonCodes: ['stale_selection'],
        matchedBy: 'none',
        diagnostics: ['operator-selected variantKey not in policy matrix'],
        rankedKeys: [],
      },
      code: 'variant_selection_stale',
      note: 'Shopify policy operator selection not in matrix',
    };
  }
  const cand = verified.candidate;
  return {
    ok: true,
    decision: {
      status: 'resolved',
      selectedVariantKey: cand.variantKey,
      reasonCodes: ['operator_selected'],
      matchedBy: 'sku',
      diagnostics: ['operator selection verified'],
      rankedKeys: [cand.variantKey],
    },
    selected: cand,
    origin: 'operator',
  };
}

/** Match policy evidence through the EXISTING normalized matcher — no second matcher. */
function matchPolicyEvidence(
  request: ExtractRequest,
  evidence: ShopifyPolicyEvidence,
): PolicyIdentityResolution {
  const matched = matchVariantMatrix(evidence.matrix, policyMatchInputOf(request) as never);
  if (matched.status !== 'resolved' || !matched.selectedVariantKey) {
    return {
      ok: false,
      decision: matched,
      code: 'variant_selection_required',
      note: `Shopify policy identity ${matched.status}: operator decision required`,
    };
  }
  const selected = evidence.matrix.candidates.find((c) => c.variantKey === matched.selectedVariantKey) ?? null;
  if (!selected) {
    return { ok: false, decision: matched, code: 'variant_selection_required', note: 'Shopify policy resolved no variant candidate' };
  }
  return { ok: true, decision: matched, selected, origin: 'automatic' };
}

/**
 * Resolve policy identity: single-variant evidence binds directly,
 * operator receipts verify stale-safe, otherwise the normalized matcher
 * decides. Conflicting or absent identifiers fail closed.
 */
function resolvePolicyIdentity(
  request: ExtractRequest,
  evidence: ShopifyPolicyEvidence,
  warnings: string[],
): PolicyIdentityResolution {
  if (evidence.matrix.candidates.length === 1) {
    return resolveSinglePolicyCandidate(request, evidence.matrix.candidates[0], warnings);
  }
  const receiptInput = operatorSelectionOf(request);
  if (receiptInput) return verifyPolicyOperatorSelection(evidence.matrix, receiptInput);
  return matchPolicyEvidence(request, evidence);
}

/**
 * Bind single-variant evidence — unless a supplied trusted identifier
 * contradicts the only candidate, which fails closed (a conflicting
 * identifier must never silently bind, even with no alternative).
 */
function resolveSinglePolicyCandidate(
  request: ExtractRequest,
  only: NormalizedVariantCandidate,
  warnings: string[],
): PolicyIdentityResolution {
  const contradiction = singleCandidateContradiction(only, policyMatchInputOf(request));
  if (contradiction) {
    return {
      ok: false,
      decision: {
        status: 'ambiguous',
        selectedVariantKey: null,
        reasonCodes: ['inconsistent_identifiers_single_variant'],
        matchedBy: 'none',
        diagnostics: [contradiction],
        rankedKeys: [only.variantKey],
      },
      code: 'variant_selection_required',
      note: `Shopify policy single variant contradicts trusted identifiers: operator decision required`,
    };
  }
  warnings.push('Shopify policy: single variant in evidence');
  return { ok: true, decision: null, selected: only, origin: 'single' };
}

/** Normalize a trusted GTIN for single-candidate comparison (null when unparseable). */
function normalizeShopifyGtin(raw: string): string | null {
  try {
    return normalizeGtin(raw);
  } catch {
    return null;
  }
}

/** Normalize a trusted SKU for single-candidate comparison (null when blank). */
function normalizeShopifySku(raw: string): string | null {
  return normalizeSkuMpn(raw);
}

/** GTIN contradiction against the single candidate (null when consistent). */
function contradictingSingleGtin(
  candidate: NormalizedVariantCandidate,
  gtin: string | null,
): string | null {
  if (!gtin) return null;
  const norm = normalizeShopifyGtin(gtin);
  if (norm && !candidate.identifiers.some((i) => i.kind === 'gtin' && i.normalizedValue === norm)) {
    return `single variant contradicts trusted GTIN ${norm}`;
  }
  return null;
}

/** SKU contradiction against the single candidate (null when consistent). */
function contradictingSingleSku(
  candidate: NormalizedVariantCandidate,
  sku: string | null,
): string | null {
  if (!sku) return null;
  const norm = normalizeShopifySku(sku);
  if (norm && !candidate.identifiers.some((i) => i.kind === 'sku' && i.normalizedValue === norm)) {
    return `single variant contradicts trusted SKU ${norm}`;
  }
  return null;
}

/** Platform-ID contradiction against the single candidate (null when consistent). */
function contradictingSinglePlatformId(
  candidate: NormalizedVariantCandidate,
  platformVariantId: string | null,
): string | null {
  if (!platformVariantId) return null;
  const norm = platformVariantId.trim().toLowerCase();
  if (norm && (candidate.platformId ?? '').trim().toLowerCase() !== norm) {
    return `single variant contradicts known platform variant ID ${norm}`;
  }
  return null;
}

/** Trusted identifier supplied for the single candidate that matches none of its identifiers. */
function singleCandidateContradiction(
  candidate: NormalizedVariantCandidate,
  input: { gtin: string | null; sku: string | null; platformVariantId: string | null },
): string | null {
  return (
    contradictingSingleGtin(candidate, input.gtin) ??
    contradictingSingleSku(candidate, input.sku) ??
    contradictingSinglePlatformId(candidate, input.platformVariantId)
  );
}

interface BoundPolicyFields {
  values: Map<PolicyField, string | string[]>;
  provenance: Record<string, string>;
  origins: Record<string, string | null>;
}

function bindOnePolicyField(
  entry: ExtractionPolicyContent['fields'][number],
  ctx: PolicyReadContext,
  bound: BoundPolicyFields,
  warnings: string[],
): void {
  for (const source of entry.sources) {
    const value = readPolicyField(entry.field, source, ctx);
    if (!isNonEmptyValue(value)) continue;
    bound.values.set(entry.field, Array.isArray(value) ? [...value] : value.trim());
    bound.provenance[entry.field] = policyFieldProvenance(source);
    bound.origins[entry.field] = policyFieldOrigin(source, entry.field, ctx);
    if (entry.evidenceRef) bound.origins[`${entry.field}#evidence`] = entry.evidenceRef;
    return;
  }
  warnings.push(`Shopify policy field '${entry.field}' has no supported source value`);
}

/** Bind every policy field by source order over the selected variant. */
function bindPolicyFieldValues(
  policy: ExtractionPolicyContent,
  ctx: PolicyReadContext,
  warnings: string[],
): BoundPolicyFields {
  const bound: BoundPolicyFields = { values: new Map(), provenance: {}, origins: {} };
  for (const entry of policy.fields) bindOnePolicyField(entry, ctx, bound, warnings);
  return bound;
}

const POLICY_IDENTIFIER_FIELDS = ['sku', 'gtin', 'variants', 'availability'] as const;

/** Identifier/merchandising fields ride custom-field carriers with declared provenance. */
function buildPolicyCustomFields(
  values: Map<PolicyField, string | string[]>,
  provenance: Record<string, string>,
  origins: Record<string, string | null>,
  ctx: PolicyReadContext,
): Record<string, string> {
  const customFields: Record<string, string> = {};
  for (const name of POLICY_IDENTIFIER_FIELDS) {
    const value = values.get(name);
    if (typeof value !== 'string' || !value) continue;
    customFields[name] = value;
    provenance[`custom.${name}`] = provenance[name] ?? 'shopify_product_json';
    origins[`custom.${name}`] = origins[name] ?? policyFieldOrigin('shopify_product_json', name, ctx);
  }
  return customFields;
}

function policyFailedResult(
  request: ExtractRequest,
  warnings: string[],
  helpers: PolicyHelperFns,
  decision: ReturnType<typeof matchVariantMatrix> | null,
  matrix: ShopifyPolicyEvidence['matrix'] | null,
  failureCode: VariantFailureCode,
  note: string,
): Record<string, unknown> {
  const failed = helpers.buildFailedResult(request, [...warnings, note]);
  const extAny = failed as unknown as Record<string, unknown>;
  const identityMatrixHash = safeIdentityMatrixHash(matrix);
  if (decision) {
    const withMatrix = { ...decision } as Record<string, unknown>;
    if (matrix?.candidates) withMatrix.candidates = matrix.candidates;
    if (matrix) withMatrix.matrix = matrix;
    if (identityMatrixHash) withMatrix.identityMatrixHash = identityMatrixHash;
    extAny.matrixDecision = withMatrix;
    extAny.matrix = matrix;
    extAny.variantMatrix = matrix;
    extAny.candidates = matrix?.candidates ?? [];
    extAny.identityMatrixHash = identityMatrixHash;
  }
  extAny.failureCode = failureCode;
  return extAny;
}

function safeIdentityMatrixHash(matrix: ShopifyPolicyEvidence['matrix'] | null): string | null {
  try {
    return matrix ? computeIdentityMatrixHash(matrix) : null;
  } catch {
    return null;
  }
}

function buildPolicyReceipt(
  evidence: ShopifyPolicyEvidence,
  decision: ReturnType<typeof matchVariantMatrix>,
  selected: NormalizedVariantCandidate,
  origin: 'automatic' | 'operator' | 'single',
  receiptInput: OperatorSelectionInput | undefined,
  identityMatrixHash: string | null,
): Record<string, unknown> | null {
  const candidate = {
    resolutionId: receiptInput?.resolutionId ?? `auto-${Date.now()}`,
    identityMatrixHash: identityMatrixHash ?? '0'.repeat(64),
    parserVersion: evidence.matrix.parserVersion ?? 1,
    selectedVariantKey: selected.variantKey,
    decisionOrigin: origin === 'single' ? 'automatic' : origin,
    selectedDeepLink: selected.deepLink,
    matchedBy: (decision as { matchedBy?: string } | null)?.matchedBy ?? 'unknown',
    evidencePaths: selected.identifiers.map((i) => i.sourcePath),
    createdAt: new Date().toISOString(),
  };
  const parsed = VariantSelectionReceiptSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as unknown as Record<string, unknown>) : null;
}

/** Attach matrix carriers, receipt, and parent identity to a policy success. */
function attachPolicyCarriers(
  extAny: Record<string, unknown>,
  args: {
    evidence: ShopifyPolicyEvidence;
    decision: ReturnType<typeof matchVariantMatrix> | null;
    selected: NormalizedVariantCandidate;
    origin: 'automatic' | 'operator' | 'single';
    receiptInput: OperatorSelectionInput | undefined;
  },
): void {
  const { evidence, decision, selected, origin, receiptInput } = args;
  const identityMatrixHash = safeIdentityMatrixHash(evidence.matrix);
  if (decision) {
    const withMatrix = { ...(decision as unknown as Record<string, unknown>) };
    withMatrix.candidates = evidence.matrix.candidates;
    withMatrix.matrix = evidence.matrix;
    if (identityMatrixHash) withMatrix.identityMatrixHash = identityMatrixHash;
    extAny.matrixDecision = withMatrix;
    const receipt = buildPolicyReceipt(evidence, decision, selected, origin, receiptInput, identityMatrixHash);
    if (receipt) extAny.selectedReceipt = receipt;
  }
  extAny.matrix = evidence.matrix;
  extAny.variantMatrix = evidence.matrix;
  extAny.candidates = evidence.matrix.candidates;
  extAny.identityMatrixHash = identityMatrixHash;
  if (evidence.parentProductId) extAny.parentProductId = evidence.parentProductId;
}

/** Assemble the extraction result from bound policy values (variant-authoritative). */
function assemblePolicyData(
  request: ExtractRequest,
  bound: BoundPolicyFields,
  ctx: PolicyReadContext,
  finalUrl: string,
  sourceUrl: string,
  expectedName: string | undefined,
): ExtractionData {
  const imageValues = bound.values.get('images');
  const imageList = Array.isArray(imageValues) ? imageValues : [];
  const cleanImages = ctx.helpers.cleanAndDeduplicateImages(imageList, finalUrl);
  const customFields = buildPolicyCustomFields(bound.values, bound.provenance, bound.origins, ctx);
  const data = ctx.helpers.buildExtractionData(
    {
      title: bound.values.get('title') as string,
      brand: (bound.values.get('brand') as string | undefined) ?? null,
      description: (bound.values.get('description') as string | undefined) ?? null,
      price: (bound.values.get('price') as string | undefined) ?? null,
      primaryImage: cleanImages[0] ?? null,
      additionalImages: cleanImages.slice(1, 17),
      provenance: {
        ...bound.provenance,
        title: bound.provenance.title ?? 'shopify_product_json',
        sourceUrl: 'request',
        profileRuntime: 'static',
      },
    },
    sourceUrl,
    expectedName,
  );
  if (Object.keys(customFields).length > 0) data.customFields = customFields;
  const existingVp =
    (data as unknown as { variantProvenance?: Record<string, string> }).variantProvenance ?? {};
  const variantProvenance = buildVariantProvenance(ctx.selected, existingVp);
  markShopifyMatrixSource(data, variantProvenance, ctx.evidence);
  (data as unknown as { variantProvenance?: Record<string, string> }).variantProvenance = variantProvenance;
  return data;
}

function markShopifyMatrixSource(
  data: ExtractionData,
  variantProvenance: Record<string, string>,
  evidence: ShopifyPolicyEvidence,
): void {
  if (evidence.matrixSource !== 'shopify_js' || !evidence.matrixSourceUrl) return;
  (data as unknown as { fieldProvenance?: Record<string, string> }).fieldProvenance = {
    ...(data.fieldProvenance ?? {}),
    variantMatrix: 'shopify_js',
  };
  variantProvenance.matrixSource = 'shopify_js';
}

// fallow-ignore-next-line unused-export — trusted profile runner dispatch
export async function doShopifyPolicyExtract(args: {
  request: ExtractRequest;
  policy: ExtractionPolicyContent;
  html: string;
  finalUrl: string;
  allowedSourceDomains: string[];
  deps: PolicyTransportDeps;
  helpers: PolicyHelperFns;
  warnings: string[];
}): Promise<{
  data: ExtractionData;
  warnings: string[];
  sourceContentHash?: string | null;
  sourceArtifactId?: string | null;
  fieldProvenanceDetails?: Record<string, PolicyFieldProvenanceDetail>;
}> {
  const { request, policy, html, finalUrl, allowedSourceDomains, deps, helpers, warnings } = args;
  const { sourceUrl, expected } = request;

  const evidence = await fetchShopifyPolicyEvidence(html, finalUrl, allowedSourceDomains, deps, warnings, helpers);
  if (!evidence) {
    return policyFailedResult(request, warnings, helpers, null, null, 'variant_selection_required', 'Shopify policy found no variant evidence') as never;
  }

  // Identity through the EXISTING normalized matcher — no second matcher.
  // Trusted source inputs: UPC in the GTIN slot (never conflated with the
  // SKU slot), explicit SKU, exact known platform variant ID.
  const resolved = resolvePolicyIdentity(request, evidence, warnings);
  if (!resolved.ok) {
    return policyFailedResult(request, warnings, helpers, resolved.decision, evidence.matrix, resolved.code, resolved.note) as never;
  }
  const { decision, selected, origin } = resolved;

  // Per-field source order over the bound variant.
  const $ = cheerio.load(html);
  const ctx: PolicyReadContext = {
    evidence,
    selected,
    $,
    jsonLd: helpers.extractJsonLdFromCheerio($),
    metaTags: helpers.extractMetaTagsFromCheerio($),
    microdata: helpers.extractMicrodataFromCheerio($),
    profile: request.profile,
    helpers,
    finalUrl,
  };
  const bound = bindPolicyFieldValues(policy, ctx, warnings);
  const title = bound.values.get('title');
  if (typeof title !== 'string' || !title) {
    warnings.push('Shopify policy produced no title — returning ok: false');
    return policyFailedResult(request, warnings, helpers, decision, evidence.matrix, 'variant_selection_required', 'Shopify policy title missing') as never;
  }
  const data = assemblePolicyData(request, bound, ctx, finalUrl, sourceUrl, expected?.name);
  const retained = helpers.retainProfileSource(finalUrl, html);
  const extAny = {
    data,
    warnings,
    sourceContentHash: retained.sourceContentHash,
    sourceArtifactId: retained.sourceArtifactId,
    fieldProvenanceDetails: helpers.buildFieldProvenanceDetails(bound.provenance, bound.origins),
  } as unknown as Record<string, unknown>;
  attachPolicyCarriers(extAny, { evidence, decision, selected, origin, receiptInput: operatorSelectionOf(request) });
  return extAny as never;
}
