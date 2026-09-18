// Browser Investigation representative validation (T4).
//
// Executes a compiled Extraction Policy Proposal through the production
// worker path on frozen representative samples plus separately reserved
// blind holdouts, with trusted expected identities and artifact
// references. Wrong-product and wrong-variant outcomes are recorded
// explicitly — never as missing titles — and fed through the existing
// matrix evidence path (field + identity cells under the proposal hash),
// never a second health definition.
//
// Read-only governance: validation creates no versions, activates nothing,
// releases nothing, attests no image review, and writes no trusted
// extraction output. The worker is an injected seam (`PolicyWorkerRunner`);
// the production route injects the profile runner, tests inject a fake.
// The investigation provider seam is never touched here.

import { hashCanonicalJson } from '../../shared/stable-id';
import { findExposedHoldouts, normalizeHoldoutUrl } from './holdouts';
import { hasTrustedIdentifier, hasTrustedParentProductId } from './trusted-identity';
import { ExtractorProfileSchema } from '../../shared/schemas/onboarding';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import {
  hashPolicyContent,
  hashProposal,
  type CompileOutcome,
  type ExtractionPolicyProposal,
  type PolicyField,
} from '../../shared/schemas/browser-investigation-policy';
import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';
import { runMatrix, type MatrixCell } from '../profile-test-matrix';
import { compileInvestigationResult } from './compiler';
import { InvestigationServiceError, requireScopedInvestigation, type InvestigationStore } from './service';
import { sanitizedDraftSelectors, type ProposalStore } from './apply';

function fail(
  code:
    | 'invalid_input'
    | 'invalid_transition'
    | 'not_found'
    | 'workspace_mismatch'
    | 'holdout_exposed'
    | 'reserved_holdout_dropped'
    | 'untrusted_expectation',
  message: string,
): never {
  throw new InvestigationServiceError(code, `${code}: ${message}`);
}

/** Trusted expected identity for one validation sample (operator-supplied, frozen). */
// public validation contract (route + tests)
export interface ValidationExpectedIdentity {
  name: string;
  brandHint?: string | null;
  price?: string | null;
  /** Trusted product GTIN (rides the worker UPC slot — never the SKU slot). */
  gtin?: string | null;
  /** Trusted source SKU for variant-identity matching. */
  sku?: string | null;
  /** Exact known platform variant ID for identity matching. */
  platformVariantId?: string | null;
  /** Exact expected variant identity (worker matrix variantKey). */
  variantKey?: string | null;
  /** Exact expected parent product ID (e.g. the Shopify product id). */
  productId?: string | null;
}

// public validation contract (route + tests)
export interface ValidationSampleInput {
  url: string;
  role: 'representative' | 'holdout';
  expected: ValidationExpectedIdentity;
  artifactRef?: string | null;
}

// public validation contract (route + tests)
export interface PolicyWorkerResult {
  ok: boolean;
  data?: {
    title?: string | null;
    brand?: string | null;
    description?: string | null;
    price?: string | null;
    primaryImage?: string | null;
    additionalImages?: string[];
    customFields?: Record<string, string>;
    fieldProvenance?: Record<string, string>;
  } | null;
  error?: string;
  failureCode?: string | null;
  matrixDecision?: {
    status: string;
    selectedVariantKey: string | null;
    matchedBy?: string;
    reasonCodes?: string[];
  } | null;
  selectedReceipt?: { selectedVariantKey?: string } | null;
  parentProductId?: string | null;
  sourceContentHash?: string | null;
  /**
   * #241 affirmative single-variant signal: the worker variant matrix with
   * exactly one candidate proves the page is single-variant. Forwarded from
   * the extraction worker (which binds single-variant evidence directly);
   * absence of this signal never satisfies the variant bar.
   */
  variantMatrix?: { candidates?: Array<{ variantKey: string }> } | null;
  /** Bounded candidates subset (worker evidence preservation). */
  candidates?: Array<{ variantKey: string }> | null;
}

/** Injected production-worker seam: compiled draft profile + sample → extraction outcome. */
// public validation contract (route + tests)
export interface PolicyWorkerRunner {
  run(input: {
    profile: ExtractorProfile;
    sampleUrl: string;
    expected: {
      name: string;
      brandHint?: string | null;
      price?: string | null;
      upc?: string;
      sku?: string;
      platformVariantId?: string;
    };
  }): Promise<PolicyWorkerResult>;
}

// public validation contract (route + tests)
export type ValidationSampleStatus = 'pass' | 'fail' | 'incomplete';
// public validation contract (route + tests)
export type IdentityOutcome =
  | 'match'
  | 'wrong_product'
  | 'wrong_variant'
  | 'ambiguous'
  | 'no_match'
  | 'error'
  | 'unevaluated';

// public validation contract (route + tests)
export interface ValidationSampleResult {
  url: string;
  role: 'representative' | 'holdout';
  status: ValidationSampleStatus;
  identityOutcome: IdentityOutcome;
  selectedVariantKey: string | null;
  parentProductId: string | null;
  fieldResults: Array<{ field: string; present: boolean; provenance?: string }>;
  failureReasons: string[];
  artifactHash: string;
}

// public validation contract (route + tests)
export type ProposalValidationStatus = 'passed' | 'failed' | 'incomplete' | 'unappliable';

// public validation contract (route + tests)
export interface ProposalValidation {
  validationId: string;
  investigationId: string;
  domain: string;
  status: ProposalValidationStatus;
  proposalHash: string;
  policyHash: string;
  baselineVersionId: string | null;
  samples: ValidationSampleResult[];
  holdouts: { required: number; passed: number; sampleIds: string[] };
  blockers: string[];
  validatedAt: string;
  validationHash: string;
}

/** Persisted immutable validation reference for one investigation. */
// public validation contract (store + tests)
export interface StoredValidation {
  validationJson: string | null;
  validationHash: string | null;
  policyHash: string | null;
  validatedAt: string | null;
}

// public validation contract (store + tests)
export interface ValidationStore {
  getValidation(workspaceId: string, investigationId: string): StoredValidation | null;
  saveValidation(
    workspaceId: string,
    investigationId: string,
    validationJson: string,
    validationHash: string,
    policyHash: string,
    validatedAt: string,
  ): void;
}

/** Memory ValidationStore for tests and dry runs. */
export function createMemoryValidationStore(): ValidationStore {
  const rows = new Map<string, StoredValidation>();
  const key = (workspaceId: string, investigationId: string): string => `${workspaceId}::${investigationId}`;
  return {
    getValidation: (workspaceId, investigationId) => rows.get(key(workspaceId, investigationId)) ?? null,
    saveValidation: (workspaceId, investigationId, validationJson, validationHash, policyHash, validatedAt) => {
      rows.set(key(workspaceId, investigationId), { validationJson, validationHash, policyHash, validatedAt });
    },
  };
}

// public validation contract (route + tests)
export interface ValidateProposalOptions {
  workspaceId: string;
  investigationId: string;
  samples: ValidationSampleInput[];
  baselineVersionId?: string | null;
  now?: Date;
}

/**
 * The executable draft profile for a compiled proposal: the SAME sanitized
 * content the apply path persists, so validation executes exactly what a
 * later Apply to Draft would publish (policy content included).
 */
function draftProfileFromProposal(domain: string, proposal: ExtractionPolicyProposal): ExtractorProfile {
  return ExtractorProfileSchema.parse({
    ...sanitizedDraftSelectors(proposal),
    id: `draft-${proposal.investigationId}`,
    domain,
    runtime: proposal.renderedBrowserRequired ? 'rendered' : 'static',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function assertSampleUrl(raw: unknown): string {
  if (typeof raw !== 'string') fail('invalid_input', 'sample URL must be a string');
  let url: URL;
  try {
    url = new URL(raw as string);
  } catch {
    fail('invalid_input', `invalid sample URL ${String(raw)}`);
  }
  if (url!.protocol !== 'http:' && url!.protocol !== 'https:') {
    fail('invalid_input', `sample URL must be http(s): ${String(raw)}`);
  }
  return (raw as string).trim();
}

function assertOneSampleInput(sample: ValidationSampleInput): void {
  if (!sample || (sample.role !== 'representative' && sample.role !== 'holdout')) {
    fail('invalid_input', 'each sample needs a representative/holdout role');
  }
  assertSampleUrl(sample.url);
  if (!sample.expected || !sample.expected.name || !sample.expected.name.trim()) {
    fail('invalid_input', `sample ${sample.url} needs an expected product name`);
  }
  // #241 fail closed at the validation boundary: a name alone never proves
  // identity. Rejected before any worker call, so no validation record is
  // created for the rejected sample set. Shares the trusted-identity rule
  // with the pilot gate (see trusted-identity.ts).
  if (!hasTrustedIdentifier(sample.expected)) {
    fail(
      'untrusted_expectation',
      `sample ${sample.url} lacks a trusted identifier (gtin, sku, platformVariantId, or variantKey) — ` +
        'names alone cannot prove variant identity',
    );
  }
  if (!hasTrustedParentProductId(sample.expected)) {
    fail(
      'untrusted_expectation',
      `sample ${sample.url} lacks a trusted parent productId — the worker must prove product identity`,
    );
  }
}

function assertSampleInputs(samples: ValidationSampleInput[]): void {
  if (!Array.isArray(samples) || samples.length === 0) {
    fail('invalid_input', 'at least one validation sample required');
  }
  for (const sample of samples) assertOneSampleInput(sample);
}

/**
 * Blindness check across ALL investigator-visible inputs (T5): sample
 * URLs, captured artifacts, failure context, reports, and metadata — not
 * just the investigation sample list. An exposed sample loses holdout
 * status for that proposal: it becomes tuning evidence (re-supplied as a
 * representative) and must be replaced by a fresh holdout. Fails closed
 * before any worker call.
 */
function assertHoldoutBlindness(record: InvestigationRecord, samples: ValidationSampleInput[]): void {
  const exposures = findExposedHoldouts(
    record,
    samples.filter((s) => s.role === 'holdout').map((s) => ({
      url: s.url,
      ...(s.artifactRef ? { artifactRef: s.artifactRef } : {}),
    })),
  );
  const exposed = exposures[0];
  if (exposed) {
    fail(
      'holdout_exposed',
      `holdout ${exposed.url} exposed via ${exposed.via} (${exposed.detail}) and must be replaced; ` +
        'exposed samples become tuning evidence — re-supply as representatives, never as holdouts',
    );
  }
}

/**
 * No-drop rule (T5): every holdout reserved by a prior validation must run
 * again — including holdouts declared by an unappliable run. A failing
 * reserved holdout is never dropped to recover a pass: replace only
 * exposed holdouts (as tuning evidence with a fresh holdout), or discard
 * the investigation and start over. Fails closed before any worker call.
 * URL identity is canonical (slash variants neither bypass nor false-trigger).
 */
function assertReservedHoldoutsRun(prior: ProposalValidation | null, samples: ValidationSampleInput[]): void {
  const reserved = prior?.holdouts.sampleIds ?? [];
  if (reserved.length === 0) return;
  const holdouts = new Set(samples.filter((s) => s.role === 'holdout').map((s) => normalizeHoldoutUrl(s.url)));
  const dropped = reserved.find((url) => !holdouts.has(normalizeHoldoutUrl(url)));
  if (dropped) fail('reserved_holdout_dropped', `reserved holdout ${dropped} was dropped; every reserved holdout must run`);
}

/** Load the prior validation reference and enforce the no-drop rule (one line at the call site). */
function assertReservationIntact(
  deps: { investigations: InvestigationStore; validations: ValidationStore },
  workspaceId: string,
  investigationId: string,
  samples: ValidationSampleInput[],
): void {
  assertReservedHoldoutsRun(getProposalValidation({ investigations: deps.investigations, validations: deps.validations }, workspaceId, investigationId), samples);
}

type PolicyWorkerData = NonNullable<PolicyWorkerResult['data']>;

/** Per-field presence readers over a worker result (table-driven, no branching). */
const FIELD_PRESENT_READERS: Readonly<Record<PolicyField, (data: PolicyWorkerData) => boolean>> = {
  title: (data) => !!data.title?.trim(),
  brand: (data) => !!data.brand?.trim(),
  description: (data) => !!data.description?.trim(),
  price: (data) => !!data.price?.trim(),
  images: (data) => !!data.primaryImage || (data.additionalImages ?? []).length > 0,
  sku: (data) => !!data.customFields?.sku?.trim(),
  gtin: (data) => !!data.customFields?.gtin?.trim(),
  variants: (data) => !!data.customFields?.variants?.trim(),
  availability: (data) => !!data.customFields?.availability?.trim(),
};

function fieldPresent(field: PolicyField, data: PolicyWorkerData): boolean {
  return FIELD_PRESENT_READERS[field](data);
}

interface IdentityClassification {
  outcome: IdentityOutcome;
  reasons: string[];
  selectedKey: string | null;
  parentId: string | null;
}

function selectedIdentityOf(result: PolicyWorkerResult): { selectedKey: string | null; parentId: string | null } {
  return {
    selectedKey: result.matrixDecision?.selectedVariantKey ?? result.selectedReceipt?.selectedVariantKey ?? null,
    parentId: result.parentProductId ?? null,
  };
}

/** Worker-level failure (ambiguous / no match / transport): fail closed, never wrong_*. */
function classifyWorkerFailure(result: PolicyWorkerResult): IdentityClassification {
  const { selectedKey, parentId } = selectedIdentityOf(result);
  const status = result.matrixDecision?.status ?? 'error';
  const outcome: IdentityOutcome = status === 'ambiguous' ? 'ambiguous' : status === 'no_match' ? 'no_match' : 'error';
  return {
    outcome,
    reasons: [`identity_${outcome}:${result.failureCode ?? result.error ?? 'worker_failed'}`.slice(0, 300)],
    selectedKey,
    parentId,
  };
}

/** Exactly one candidate with a non-empty string key yields that key; anything else yields null. */
function soleCandidateKey(candidates: unknown): string | null {
  if (!Array.isArray(candidates)) return null;
  if (candidates.length !== 1) return null;
  const key = (candidates[0] as { variantKey?: unknown } | null | undefined)?.variantKey;
  if (typeof key !== 'string') return null;
  if (key.length === 0) return null;
  return key;
}

/**
 * Affirmative single-variant signal (#241): the worker variant matrix with
 * exactly one candidate proves the page is single-variant. Only this
 * positive signal satisfies the variant bar without a resolved selected
 * key — absence of variant data never satisfies it.
 */
function singleVariantKeyOf(result: PolicyWorkerResult): string | null {
  return soleCandidateKey(result.variantMatrix?.candidates) ?? soleCandidateKey(result.candidates);
}

/** Variant identity against the frozen expectation: exact key or trusted-identifier resolution. */
function checkVariantIdentity(
  expected: ValidationExpectedIdentity,
  selectedKey: string | null,
  parentId: string | null,
  result: PolicyWorkerResult,
): IdentityClassification | null {
  // #241: the variant bar is satisfied without a resolved key only by an
  // affirmative single-variant signal. Anything else fails closed.
  const effectiveKey = selectedKey ?? singleVariantKeyOf(result);
  if (expected.variantKey) {
    if (!effectiveKey) {
      return {
        outcome: 'ambiguous',
        reasons: ['identity_unresolved:expected variant identity did not resolve'],
        selectedKey,
        parentId,
      };
    }
    if (effectiveKey !== expected.variantKey) {
      return {
        outcome: 'wrong_variant',
        reasons: [`wrong_variant:expected ${expected.variantKey} resolved ${effectiveKey}`],
        selectedKey: effectiveKey,
        parentId,
      };
    }
    return null;
  }
  if ((expected.gtin || expected.sku || expected.platformVariantId) && !effectiveKey) {
    return {
      outcome: 'ambiguous',
      reasons: ['identity_unresolved:trusted identifiers did not resolve'],
      selectedKey,
      parentId,
    };
  }
  return null;
}

/** Product identity against the frozen expectation: contradicting parents and GTINs fail. */
function checkProductIdentity(
  expected: ValidationExpectedIdentity,
  result: PolicyWorkerResult,
  selectedKey: string | null,
  parentId: string | null,
): IdentityClassification | null {
  if (expected.productId && !parentId) {
    return {
      outcome: 'error',
      reasons: ['product_unverified:worker reported no parent product identity'],
      selectedKey,
      parentId,
    };
  }
  if (expected.productId && parentId !== expected.productId) {
    return {
      outcome: 'wrong_product',
      reasons: [`wrong_product:expected product ${expected.productId} extracted ${parentId}`],
      selectedKey,
      parentId,
    };
  }
  if (expected.gtin) {
    const extractedGtin = result.data?.customFields?.gtin?.replace(/\D/g, '') || null;
    if (extractedGtin && extractedGtin !== expected.gtin.replace(/\D/g, '')) {
      return {
        outcome: 'wrong_product',
        reasons: [`wrong_product:expected GTIN ${expected.gtin} extracted ${extractedGtin}`],
        selectedKey,
        parentId,
      };
    }
  }
  return null;
}

/**
 * #241 test seam: production path always gates untrusted expectations via
 * assertOneSampleInput first; this stays exported so parity tests can prove
 * the fail-closed 'unevaluated' shape for classification with nothing to
 * compare (never 'match', never wrong_*).
 */
export function classifyIdentity(sample: ValidationSampleInput, result: PolicyWorkerResult): IdentityClassification {
  if (!result.ok) return classifyWorkerFailure(result);
  const { selectedKey, parentId } = selectedIdentityOf(result);
  // #241 fail closed: a sample is never recorded as 'match' unless the
  // product-identity comparison actually executed against the frozen
  // expectation. Without a trusted parent product ID plus a trusted
  // identifier there is nothing to compare — return the honest
  // non-match outcome 'unevaluated' (never 'match', never wrong_*).
  if (!sample.expected.productId?.trim() || !hasTrustedIdentifier(sample.expected)) {
    return {
      outcome: 'unevaluated',
      reasons: ['identity_unevaluated:no trusted expectation compared'],
      selectedKey,
      parentId,
    };
  }
  return (
    checkVariantIdentity(sample.expected, selectedKey, parentId, result) ??
    checkProductIdentity(sample.expected, result, selectedKey, parentId) ?? {
      outcome: 'match' as const,
      reasons: [],
      // #241 single-variant match: persist the effective variant key used
      // for the comparison (the affirmative single-variant signal when no
      // key resolved) so identityCellFor records the real variant key.
      selectedKey: selectedKey ?? singleVariantKeyOf(result),
      parentId,
    }
  );
}

function runnerExpectedOf(expected: ValidationExpectedIdentity): {
  name: string;
  brandHint?: string | null;
  price?: string | null;
  upc?: string;
  sku?: string;
  platformVariantId?: string;
} {
  return {
    name: expected.name,
    ...(expected.brandHint ? { brandHint: expected.brandHint } : {}),
    ...(expected.price ? { price: expected.price } : {}),
    ...(expected.gtin ? { upc: expected.gtin } : {}),
    ...(expected.sku ? { sku: expected.sku } : {}),
    ...(expected.platformVariantId ? { platformVariantId: expected.platformVariantId } : {}),
  };
}

function incompleteSampleResult(sample: ValidationSampleInput, detail: string): ValidationSampleResult {
  return {
    url: sample.url,
    role: sample.role,
    status: 'incomplete',
    identityOutcome: 'error',
    selectedVariantKey: null,
    parentProductId: null,
    fieldResults: [],
    failureReasons: [`runner_error:${detail.slice(0, 200)}`],
    artifactHash: sample.artifactRef ?? 'no-hash',
  };
}

function evaluateSampleResult(
  sample: ValidationSampleInput,
  policyFields: readonly PolicyField[],
  result: PolicyWorkerResult,
): ValidationSampleResult {
  const identity = classifyIdentity(sample, result);
  const fieldResults = policyFields.map((field) => ({
    field,
    present: result.ok && !!result.data ? fieldPresent(field, result.data) : false,
    ...(result.data?.fieldProvenance?.[field] ? { provenance: result.data.fieldProvenance[field] } : {}),
  }));
  const failureReasons = [...identity.reasons];
  for (const fr of fieldResults) {
    if (!fr.present) failureReasons.push(`field_missing:${fr.field}`);
  }
  return {
    url: sample.url,
    role: sample.role,
    status: failureReasons.length === 0 ? 'pass' : 'fail',
    identityOutcome: identity.outcome,
    selectedVariantKey: identity.selectedKey,
    parentProductId: identity.parentId,
    fieldResults,
    failureReasons,
    artifactHash: result.sourceContentHash ?? sample.artifactRef ?? 'no-hash',
  };
}

async function runValidationSample(
  runner: PolicyWorkerRunner,
  profile: ExtractorProfile,
  policyFields: readonly PolicyField[],
  sample: ValidationSampleInput,
): Promise<ValidationSampleResult> {
  try {
    const result = await runner.run({ profile, sampleUrl: sample.url, expected: runnerExpectedOf(sample.expected) });
    return evaluateSampleResult(sample, policyFields, result);
  } catch (err) {
    return incompleteSampleResult(sample, err instanceof Error ? err.message : String(err));
  }
}

function identityCellFor(sample: ValidationSampleInput, result: ValidationSampleResult): MatrixCell {
  const expectedIdentity =
    sample.expected.variantKey ?? sample.expected.gtin ?? sample.expected.sku ?? sample.expected.platformVariantId ?? '';
  return {
    field: 'identity',
    extracted: result.selectedVariantKey ?? result.parentProductId ?? result.status,
    expected: expectedIdentity,
    provenance: 'browser-investigation-validation',
    artifactHash: result.artifactHash,
    success: result.status === 'pass',
    failureReason: result.failureReasons.find((r) => r.startsWith('wrong_') || r.startsWith('identity_')) ?? null,
  };
}

function fieldCellsFor(result: ValidationSampleResult): MatrixCell[] {
  return result.fieldResults.map((fr) => ({
    field: fr.field,
    extracted: fr.present ? 'present' : null,
    expected: '',
    provenance: fr.provenance ?? 'browser-investigation-validation',
    artifactHash: result.artifactHash,
    success: fr.present,
    failureReason: fr.present ? null : `field_missing:${fr.field}`,
  }));
}

function sampleCells(sample: ValidationSampleInput, result: ValidationSampleResult): MatrixCell[] {
  return [identityCellFor(sample, result), ...fieldCellsFor(result)];
}

function hashValidationBody(body: Omit<ProposalValidation, 'validationId' | 'validatedAt' | 'validationHash'>): string {
  return hashCanonicalJson(body);
}

interface CompiledValidationTarget {
  proposal: Extract<ReturnType<typeof compileInvestigationResult>, { status: 'proposal' }>['proposal'];
  proposalHash: string;
  policyHash: string;
  profile: ExtractorProfile;
  policyFields: readonly PolicyField[];
}

/** Load, compile, freeze, and persist the proposal reference (no worker calls). */
function compileTargetForValidation(
  deps: { investigations: InvestigationStore; proposals: ProposalStore },
  record: InvestigationRecord,
  workspaceId: string,
  outcome: Extract<CompileOutcome, { status: 'proposal' }>,
): CompiledValidationTarget {
  const proposal = outcome.proposal;
  const proposalHash = hashProposal(proposal);
  const policyHash = hashPolicyContent({
    platform: proposal.platform,
    structures: proposal.structures,
    fields: proposal.fields,
    identity: proposal.identity,
    renderedBrowserRequired: proposal.renderedBrowserRequired,
  });
  const stored = deps.proposals.getProposal(workspaceId, record.id);
  if (!stored || !stored.proposalHash) {
    deps.proposals.saveProposal(workspaceId, record.id, JSON.stringify(proposal), proposalHash);
  }
  return {
    proposal,
    proposalHash,
    policyHash,
    profile: draftProfileFromProposal(record.domain, proposal),
    policyFields: proposal.fields.map((f) => f.field),
  };
}

async function runAllValidationSamples(
  runner: PolicyWorkerRunner,
  target: CompiledValidationTarget,
  samples: ValidationSampleInput[],
): Promise<ValidationSampleResult[]> {
  const results: ValidationSampleResult[] = [];
  for (const sample of samples) {
    results.push(await runValidationSample(runner, target.profile, target.policyFields, sample));
  }
  return results;
}

function computeValidationBlockers(record: InvestigationRecord, results: ValidationSampleResult[]): string[] {
  const investigated = new Set((record.inputSnapshot.sampleUrls ?? []).map((u) => u.trim()));
  const validatedReps = new Set(results.filter((r) => r.role === 'representative').map((r) => r.url.trim()));
  const blockers: string[] = [];
  for (const url of investigated) {
    if (!validatedReps.has(url)) blockers.push(`representative_missing:${url}`);
  }
  const holdoutResults = results.filter((r) => r.role === 'holdout');
  if (holdoutResults.length === 0) {
    blockers.push('missing_holdout:at least one blind holdout must be reserved and run');
  } else if (!holdoutResults.some((r) => r.status === 'pass')) {
    blockers.push('holdout_failed:no blind holdout passed');
  }
  return blockers;
}

function computeValidationStatus(results: ValidationSampleResult[], blockers: string[]): ProposalValidationStatus {
  const hardFail =
    results.some((r) => r.status === 'fail') ||
    blockers.some((b) => b.startsWith('representative_missing') || b.startsWith('holdout_failed'));
  if (hardFail) return 'failed';
  if (results.some((r) => r.status === 'incomplete') || blockers.length > 0) return 'incomplete';
  return 'passed';
}

async function writeValidationMatrix(
  domain: string,
  proposalHash: string,
  samples: ValidationSampleInput[],
  results: ValidationSampleResult[],
): Promise<void> {
  await runMatrix({
    domain,
    draftVersion: proposalHash,
    samples: samples.map((s) => ({ id: s.url, url: s.url, expectedTitle: s.expected.name })),
    runner: async (matrixSample) => {
      const idx = samples.findIndex((s) => s.url === matrixSample.url);
      const result = results[idx];
      return {
        extractedTitle: null,
        provenance: 'browser-investigation-validation',
        artifactHash: result.artifactHash,
        success: result.status === 'pass',
        failureReason: result.failureReasons[0] ?? null,
        cells: sampleCells(samples[idx], result),
      };
    },
  });
}

function persistValidation(
  validations: ValidationStore,
  workspaceId: string,
  investigationId: string,
  body: Omit<ProposalValidation, 'validationId' | 'validatedAt' | 'validationHash'>,
  validatedAt: string,
): ProposalValidation {
  const validationHash = hashValidationBody(body);
  const validation: ProposalValidation = { ...body, validationId: `vval_${validationHash.slice(0, 16)}`, validatedAt, validationHash };
  validations.saveValidation(workspaceId, investigationId, JSON.stringify(validation), validationHash, body.policyHash, validatedAt);
  return validation;
}

function unappliableValidation(
  record: InvestigationRecord,
  status: 'requires_code_adapter' | 'unresolved',
  detail: string,
  samples: ValidationSampleInput[],
  baselineVersionId: string | null,
): Omit<ProposalValidation, 'validationId' | 'validatedAt' | 'validationHash'> {
  return {
    investigationId: record.id,
    domain: record.domain,
    status: 'unappliable',
    proposalHash: '',
    policyHash: '',
    baselineVersionId,
    samples: [],
    holdouts: {
      required: 1,
      passed: 0,
      sampleIds: samples.filter((s) => s.role === 'holdout').map((s) => s.url),
    },
    blockers: [`unappliable:${status}(${detail})`],
  };
}

function describeUnappliable(outcome: { status: string; codeAdapterRequest?: { capability: string }; gaps?: Array<{ kind: string }> }): { status: 'requires_code_adapter' | 'unresolved'; detail: string } {
  if (outcome.status === 'requires_code_adapter') {
    return { status: 'requires_code_adapter', detail: outcome.codeAdapterRequest?.capability ?? 'unknown' };
  }
  return { status: 'unresolved', detail: (outcome.gaps ?? []).map((g) => g.kind).slice(0, 4).join(',') };
}

/**
 * Validate a compiled proposal through the production worker path.
 *
 * Freezes proposal content, sample roles, trusted expected identities, the
 * baseline version, and artifact references; executes every representative
 * plus every reserved holdout (no dropping); persists the validation
 * reference for the apply path. Never creates versions.
 */
export async function validateProposal(
  deps: {
    investigations: InvestigationStore;
    proposals: ProposalStore;
    validations: ValidationStore;
    runner: PolicyWorkerRunner;
  },
  options: ValidateProposalOptions,
): Promise<ProposalValidation> {
  const record = requireScopedInvestigation(deps.investigations, options.workspaceId, options.investigationId);
  if (record.status !== 'completed') {
    fail('invalid_transition', `only completed investigations can be validated (is ${record.status})`);
  }
  if (!record.result || !record.resultHash) fail('invalid_transition', 'investigation has no typed result to validate');
  assertSampleInputs(options.samples);
  assertHoldoutBlindness(record, options.samples);
  assertReservationIntact(deps, options.workspaceId, record.id, options.samples);
  const validatedAt = (options.now ?? new Date()).toISOString();
  const baselineVersionId = options.baselineVersionId ?? null;

  const rawOutcome = compileInvestigationResult(record.result, {
    domain: record.domain,
    investigationId: record.id,
    runId: record.runId,
    inputHash: record.inputHash,
    resultHash: record.resultHash,
  });
  if (rawOutcome.status !== 'proposal') {
    const described = describeUnappliable(rawOutcome);
    return persistValidation(deps.validations, options.workspaceId, record.id,
      unappliableValidation(record, described.status, described.detail, options.samples, baselineVersionId),
      validatedAt);
  }
  const target = compileTargetForValidation(
    { investigations: deps.investigations, proposals: deps.proposals },
    record,
    options.workspaceId,
    rawOutcome,
  );
  const results = await runAllValidationSamples(deps.runner, target, options.samples);
  const blockers = computeValidationBlockers(record, results);
  const holdoutResults = results.filter((r) => r.role === 'holdout');
  await writeValidationMatrix(record.domain, target.proposalHash, options.samples, results);
  return persistValidation(deps.validations, options.workspaceId, record.id, {
    investigationId: record.id,
    domain: record.domain,
    status: computeValidationStatus(results, blockers),
    proposalHash: target.proposalHash,
    policyHash: target.policyHash,
    baselineVersionId,
    samples: results,
    holdouts: {
      required: 1,
      passed: holdoutResults.filter((r) => r.status === 'pass').length,
      sampleIds: holdoutResults.map((r) => r.url),
    },
    blockers,
  }, validatedAt);
}

/** Read the persisted validation reference for an investigation (workspace-scoped). */
export function getProposalValidation(
  deps: { investigations: InvestigationStore; validations: ValidationStore },
  workspaceId: string,
  investigationId: string,
): ProposalValidation | null {
  requireScopedInvestigation(deps.investigations, workspaceId, investigationId);
  const stored = deps.validations.getValidation(workspaceId, investigationId);
  if (!stored?.validationJson) return null;
  try {
    return JSON.parse(stored.validationJson) as ProposalValidation;
  } catch {
    return null;
  }
}
