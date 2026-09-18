// Browser Investigation proposal apply path (T2).
//
// Publishes a compilable Extraction Policy Proposal as a SANITIZED INACTIVE
// shared profile draft with blockers preserved. Saving never implies
// validation success, approval, health, activation, release, or image
// attestation:
//
// - only `proposal` compiler outcomes are appliable; `requires_code_adapter`
//   and `unresolved` outcomes fail closed with `unappliable_proposal` and
//   create no version;
// - the shared draft carries ONLY policy-derived selectors, the shared
//   extraction-policy content, opaque evidence pointers, and content hashes.
//   Workspace-private prompts (knownContext), raw observation text, model
//   metadata prose, and free-form strategy strings never leave the
//   workspace-scoped investigation tables;
// - the active profile pointer is never touched (this module has no
//   active-pointer writer — asserted by the governance suite);
// - `validationSummary.imageRuleOk` is always false here: image review stays
//   an explicit version-bound operator attestation elsewhere;
// - immutable binding: the proposal's investigation/run/input/result hashes
//   must match the stored investigation, or the apply is rejected as stale.
//
// Pure except for its injected dependencies (investigation store, proposal
// store, validation store, version creator), so governance is Vitest-exercisable with memory
// doubles. The SQLite adapters live in `store.ts` / the investigation repo.

import {
  FIELD_TO_SELECTOR_SLOT,
  hashPolicyContent,
  hashProposal,
  isCoreSelectorSlot,
  type CompileOutcome,
  type ExtractionPolicyProposal,
} from '../../shared/schemas/browser-investigation-policy';
import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';
import { hashCanonicalJson } from '../../shared/stable-id';
import type { CreateVersionInput } from '../../db/repositories/profile-version-repo';
import { compileInvestigationResult } from './compiler';
import type { ProposalValidation, ValidationStore } from './validate';
import {
  InvestigationServiceError,
  requireScopedInvestigation,
  type InvestigationStore,
} from './service';

export { InvestigationServiceError };

function fail(
  code:
    | 'invalid_input'
    | 'invalid_transition'
    | 'not_found'
    | 'workspace_mismatch'
    | 'unappliable_proposal'
    | 'already_applied'
    | 'stale_proposal'
    | 'validation_untrusted',
  message: string,
): never {
  throw new InvestigationServiceError(code, `${code}: ${message}`);
}

/** Persisted immutable proposal reference + apply history for one investigation. */
export interface StoredProposal {
  proposalJson: string | null;
  proposalHash: string | null;
  appliedVersionId: string | null;
  appliedAt: string | null;
  applyActor: string | null;
}

export interface ProposalStore {
  getProposal(workspaceId: string, investigationId: string): StoredProposal | null;
  saveProposal(workspaceId: string, investigationId: string, proposalJson: string, proposalHash: string): void;
  markApplied(workspaceId: string, investigationId: string, versionId: string, actor: string, appliedAt: string): void;
}

/** Memory ProposalStore for tests and dry runs. */
export function createMemoryProposalStore(): ProposalStore {
  const rows = new Map<string, StoredProposal>();
  const blank = (): StoredProposal => ({
    proposalJson: null,
    proposalHash: null,
    appliedVersionId: null,
    appliedAt: null,
    applyActor: null,
  });
  return {
    getProposal: (workspaceId, investigationId) =>
      rows.get(`${workspaceId}::${investigationId}`) ?? null,
    saveProposal: (workspaceId, investigationId, proposalJson, proposalHash) => {
      const current = rows.get(`${workspaceId}::${investigationId}`) ?? blank();
      rows.set(`${workspaceId}::${investigationId}`, { ...current, proposalJson, proposalHash });
    },
    markApplied: (workspaceId, investigationId, versionId, actor, appliedAt) => {
      const current = rows.get(`${workspaceId}::${investigationId}`) ?? blank();
      rows.set(`${workspaceId}::${investigationId}`, {
        ...current,
        appliedVersionId: versionId,
        appliedAt,
        applyActor: actor,
      });
    },
  };
}

/** Minimal version-creation contract. The production adapter is `createVersion`
 * from the profile-version repository — notably NOT `createAndActivateVersion`
 * and never `setActiveVersion`: applied drafts stay inactive. The input shape
 * is shared with the repository so the two cannot drift. */
export interface DraftVersionCreator {
  createVersion(input: CreateVersionInput): { id: string; domain: string; version: number };
}

/**
 * #234 server-authoritative apply: the client-submitted validation/holdout
 * shape was removed from the apply contract. Any `validation` value — and
 * any smuggled top-level `status` / `holdouts` / holdout-identity /
 * `policyHash` / `validationRef` / `validationHash` credential — is rejected
 * as `validation_untrusted` rather than trusted, so blind-holdout
 * independence stays something neither the operator nor the model can
 * self-attest. The trusted validation below is loaded from the persisted
 * server-generated validation record and bound by investigation, proposal,
 * policy, and validation hashes before anything is copied into the version.
 */
export type TrustedApplyValidationStatus = 'passed' | 'failed' | 'incomplete' | 'not_run';

export interface TrustedApplyValidation {
  status: TrustedApplyValidationStatus;
  blockers: string[];
  holdouts?: { passed: number; required: number; sampleIds: string[] };
  validationId?: string;
  validationHash?: string;
}

const CLIENT_VALIDATION_CREDENTIAL_KEYS = [
  'validation',
  'status',
  'validationStatus',
  'holdouts',
  'holdoutPassedCount',
  'holdoutSampleIds',
  'sampleIds',
  'policyHash',
  'validationRef',
  'validationHash',
  'validationId',
] as const;

/**
 * Reject client-submitted validation credentials. The apply options contract
 * is `{ workspaceId, investigationId, actor, now? }` — any validation-like
 * key present with a non-undefined value is a self-attestation attempt.
 */
function rejectClientValidationCredentials(options: Record<string, unknown>): void {
  if (options.validation !== undefined) {
    fail(
      'validation_untrusted',
      'client-submitted validation is not trusted: apply resolves the persisted server-generated validation record',
    );
  }
  for (const key of CLIENT_VALIDATION_CREDENTIAL_KEYS) {
    if (key === 'validation') continue;
    if (options[key] !== undefined) {
      fail(
        'validation_untrusted',
        `client-submitted ${key} is not trusted: apply resolves the persisted server-generated validation record`,
      );
    }
  }
}

function notRunValidation(): TrustedApplyValidation {
  return { status: 'not_run', blockers: [] };
}

function hashPersistedValidationBody(parsed: ProposalValidation): string {
  return hashCanonicalJson({
    investigationId: parsed.investigationId,
    domain: parsed.domain,
    status: parsed.status,
    proposalHash: parsed.proposalHash,
    policyHash: parsed.policyHash,
    baselineVersionId: parsed.baselineVersionId,
    samples: parsed.samples,
    holdouts: parsed.holdouts,
    blockers: parsed.blockers,
  });
}

function parsePersistedValidation(storedJson: string): ProposalValidation {
  try {
    return JSON.parse(storedJson) as ProposalValidation;
  } catch {
    fail('validation_untrusted', 'persisted validation record is not parseable');
  }
}

/**
 * Load the persisted server-generated validation record and bind it by
 * investigation, proposal, policy, and validation hashes. Returns a
 * `not_run` validation when no record exists (blocked draft, never a
 * success claim). Tamper or binding failures reject before any version is
 * created: integrity mismatches fail as `validation_untrusted`,
 * proposal/policy drift fails as `stale_proposal` (never silently
 * inherited).
 */
function loadTrustedValidation(args: {
  validations: ValidationStore;
  workspaceId: string;
  record: InvestigationRecord;
  proposalHash: string;
  policyHash: string;
}): TrustedApplyValidation {
  const { validations, workspaceId, record, proposalHash, policyHash } = args;
  const stored = validations.getValidation(workspaceId, record.id);
  if (!stored?.validationJson) return notRunValidation();
  const parsed = parsePersistedValidation(stored.validationJson);
  if (!stored.validationHash || parsed.validationHash !== stored.validationHash) {
    fail('validation_untrusted', 'persisted validation hash does not match the stored validation reference');
  }
  if (!stored.policyHash || parsed.policyHash !== stored.policyHash) {
    fail('validation_untrusted', 'persisted validation policy binding does not match the stored validation reference');
  }
  if (hashPersistedValidationBody(parsed) !== stored.validationHash) {
    fail('validation_untrusted', 'persisted validation content does not match its validation hash');
  }
  const expectedValidationId = `vval_${stored.validationHash.slice(0, 16)}`;
  if (parsed.validationId !== expectedValidationId) {
    fail('validation_untrusted', 'persisted validation id does not match its validation hash');
  }
  if (parsed.investigationId !== record.id) {
    fail('validation_untrusted', 'persisted validation belongs to a different investigation');
  }
  if (parsed.domain !== record.domain) {
    fail('validation_untrusted', 'persisted validation belongs to a different domain');
  }
  if (parsed.proposalHash !== proposalHash) {
    fail('stale_proposal', 'persisted validation was computed against a different proposal');
  }
  if (parsed.policyHash !== policyHash || stored.policyHash !== policyHash) {
    fail('stale_proposal', 'validation was computed against different policy content');
  }
  if (parsed.status === 'unappliable') {
    fail('stale_proposal', 'persisted validation is unappliable and cannot authorize a draft');
  }
  return {
    status: parsed.status,
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    ...(parsed.holdouts
      ? {
          holdouts: {
            required: parsed.holdouts.required,
            passed: parsed.holdouts.passed,
            sampleIds: parsed.holdouts.sampleIds,
          },
        }
      : {}),
    validationId: parsed.validationId,
    validationHash: parsed.validationHash,
  };
}

function scopedRecord(
  investigations: InvestigationStore,
  workspaceId: string,
  investigationId: string,
): InvestigationRecord {
  // Single definition in the lifecycle service (T4): apply and validation
  // resolve the same record through one scoping contract.
  return requireScopedInvestigation(investigations, workspaceId, investigationId);
}

function compileForRecord(
  record: InvestigationRecord,
  now?: Date,
): { outcome: CompileOutcome; proposalHashFor: (proposal: ExtractionPolicyProposal) => string } {
  if (record.status !== 'completed') {
    fail('invalid_transition', `only completed investigations can be compiled (is ${record.status})`);
  }
  if (!record.result) fail('invalid_transition', 'investigation has no typed result to compile');
  if (!record.resultHash) fail('invalid_input', 'investigation result binding is missing');
  const outcome = compileInvestigationResult(record.result, {
    domain: record.domain,
    investigationId: record.id,
    runId: record.runId,
    inputHash: record.inputHash,
    resultHash: record.resultHash,
    now,
  });
  return { outcome, proposalHashFor: (proposal) => hashProposal(proposal) };
}

/**
 * Read path: compile the stored investigation result and persist the
 * immutable proposal reference (first write wins; later reads return the
 * stored hash when it still binds). Creates no versions.
 */
export async function compileProposalForInvestigation(
  deps: { investigations: InvestigationStore; proposals: ProposalStore },
  workspaceId: string,
  investigationId: string,
  now?: Date,
): Promise<CompileOutcome> {
  const record = scopedRecord(deps.investigations, workspaceId, investigationId);
  const { outcome } = compileForRecord(record, now);
  if (outcome.status === 'proposal') {
    const proposalHash = hashProposal(outcome.proposal);
    const stored = deps.proposals.getProposal(workspaceId, investigationId);
    if (!stored || !stored.proposalHash) {
      deps.proposals.saveProposal(workspaceId, investigationId, JSON.stringify(outcome.proposal), proposalHash);
    }
  }
  return outcome;
}

/**
 * Sanitized shared-draft selectors derived ONLY from the compiled proposal.
 * Core fields land in core selector columns; identifier/variant/availability
 * exceptions land in namespaced custom-selector keys. The shared
 * `extractionPolicy` carries policy content WITHOUT opaque evidence
 * pointers (those stay workspace-scoped on the proposal artifact).
 *
 * Exported for validation (T4): the Validate Proposal action executes the
 * same sanitized content through the production worker before any draft
 * exists, so validation and apply can never diverge on what "the proposal"
 * means.
 */
export function sanitizedDraftSelectors(proposal: ExtractionPolicyProposal): Record<string, unknown> {
  const core: Record<string, string | null> = {
    titleSelector: null,
    priceSelector: null,
    descriptionSelector: null,
    brandSelector: null,
    imagesSelector: null,
  };
  const custom: Record<string, string> = {};
  const metadata: Record<string, unknown> = {};
  for (const field of proposal.fields) {
    if (!field.selector) continue;
    const slot = FIELD_TO_SELECTOR_SLOT[field.field];
    if (isCoreSelectorSlot(slot)) {
      core[slot] = field.selector;
    } else {
      custom[slot] = field.selector;
    }
    metadata[slot] = { source: 'browser-investigation', investigationId: proposal.investigationId, field: field.field };
  }
  return {
    ...core,
    titleOptionalSelectors: [],
    customSelectors: custom,
    sitemapProductUrlPattern: null,
    shopifyJSONPath: proposal.fields.some((f) => f.sources.includes('shopify_product_json')),
    variantSelectionStrategy: null,
    customSelectorMetadata: metadata,
    extractionPolicy: {
      version: proposal.version,
      platform: proposal.platform,
      structures: proposal.structures.map((s) => ({
        id: s.id,
        sampleUrls: s.sampleUrls,
        ...(s.description ? { description: s.description } : {}),
        ...(s.platformSource ? { platformSource: s.platformSource } : {}),
      })),
      fields: proposal.fields.map((f) => ({
        field: f.field,
        sources: f.sources,
        ...(f.selector ? { selector: f.selector } : {}),
      })),
      identity: proposal.identity,
      // Round-trips the binding hash input: omitting it would fail a fresh
      // rendered draft's own binding check with no edit (spec BLOCK fix).
      renderedBrowserRequired: proposal.renderedBrowserRequired,
    },
  };
}

export interface ApplyProposalResult {
  appliedVersionId: string;
  proposalHash: string;
  policyHash: string;
  blockers: string[];
}

type ProposalOutcome = Extract<CompileOutcome, { status: 'proposal' }>;

/**
 * Resolve the appliable proposal for a stored investigation: workspace-
 * scoped load, compilation, appliability gate, and immutable binding
 * checks (result binding plus already-recorded proposal state).
 */
function resolveAppliableProposal(
  deps: { investigations: InvestigationStore; proposals: ProposalStore },
  workspaceId: string,
  investigationId: string,
  now?: Date,
): { record: InvestigationRecord; proposal: ProposalOutcome['proposal']; gaps: ProposalOutcome['gaps']; stored: StoredProposal | null } {
  const record = scopedRecord(deps.investigations, workspaceId, investigationId);
  const { outcome } = compileForRecord(record, now);
  if (outcome.status !== 'proposal') {
    const reason =
      outcome.status === 'requires_code_adapter'
        ? `requires_code_adapter(${outcome.codeAdapterRequest.capability})`
        : `unresolved(${(outcome.gaps ?? []).map((g) => g.kind).slice(0, 4).join(',')})`;
    fail('unappliable_proposal', `investigation ${record.id} is not appliable: ${reason}`);
  }
  checkProposalBinding(record, outcome.proposal);
  const stored = deps.proposals.getProposal(workspaceId, investigationId);
  checkStoredProposalState(record, outcome.proposal, stored);
  return { record, proposal: outcome.proposal, gaps: outcome.gaps ?? [], stored };
}

/** Recorded proposal state: at most one apply per investigation, and the recorded hash must bind. */
function checkStoredProposalState(
  record: InvestigationRecord,
  proposal: ProposalOutcome['proposal'],
  stored: StoredProposal | null,
): void {
  if (stored?.appliedVersionId) fail('already_applied', `investigation ${record.id} already applied as ${stored.appliedVersionId}`);
  if (stored?.proposalHash && stored.proposalHash !== hashProposal(proposal)) {
    fail('stale_proposal', 'a different proposal is already recorded for this investigation');
  }
}

/** Immutable binding: the compiled proposal must still describe the stored result. */
function checkProposalBinding(record: InvestigationRecord, proposal: ProposalOutcome['proposal']): void {
  if (proposal.resultHash !== record.resultHash || proposal.inputHash !== record.inputHash) {
    fail('stale_proposal', 'compiled proposal no longer binds the stored investigation result');
  }
}

/** Coverage gaps plus trusted validation state become preserved draft blockers — never waived. */
function buildDraftBlockers(gaps: ProposalOutcome['gaps'], validation: TrustedApplyValidation): string[] {
  return [
    ...gaps.map((g) => `gap:${g.kind}:${g.field ?? 'general'}`),
    ...validation.blockers,
    ...(validation.status === 'passed' ? [] : [`validation:${validation.status}`]),
  ];
}

/**
 * Blocked-draft validation summary: binding hashes plus preserved blockers,
 * never an image grant. Every field here is server-derived: the trusted
 * validation was loaded from the persisted record and bound by
 * investigation/proposal/policy/validation hashes before this ran, so the
 * version preserves the trusted result instead of a client claim.
 */
function draftValidationSummary(args: {
  record: InvestigationRecord;
  proposalHash: string;
  policyHash: string;
  blockers: string[];
  validation: TrustedApplyValidation;
  actor: string;
  appliedAt: string;
}): Record<string, unknown> {
  const { record, proposalHash, policyHash, blockers, validation, actor, appliedAt } = args;
  return {
    imageRuleOk: false,
    investigationDerived: true,
    investigationId: record.id,
    proposalHash,
    policyHash,
    validationStatus: validation.status,
    blockers,
    ...(validation.validationId ? { validationRef: validation.validationId } : {}),
    ...(validation.validationHash ? { validationHash: validation.validationHash } : {}),
    // Blind-holdout evidence for the non-waivable health bar (server-bound).
    holdoutPassedCount: validation.holdouts?.passed ?? 0,
    ...(validation.holdouts
      ? { holdouts: { required: validation.holdouts.required, passed: validation.holdouts.passed, sampleIds: validation.holdouts.sampleIds } }
      : {}),
    appliedAt,
    appliedBy: actor,
  };
}

/** Content hashes carried into the draft: observation artifact hashes only (self-validating, safe to share). */
function draftArtifactHashes(record: InvestigationRecord): string[] {
  return [...new Set((record.result?.observations ?? []).map((o) => o.artifactHash))].sort();
}

/** Draft runtime follows the investigation's rendered-browser finding (static unless rendering was required). */
function draftRuntime(record: InvestigationRecord): string {
  return (record.result?.renderedBrowserRequired ?? false) ? 'rendered' : 'static';
}

/** Assemble the sanitized inactive-draft version input (no active pointer, no image grant). */
function buildDraftVersionInput(args: {
  record: InvestigationRecord;
  proposal: ProposalOutcome['proposal'];
  proposalHash: string;
  policyHash: string;
  blockers: string[];
  validation: TrustedApplyValidation;
  actor: string;
  appliedAt: string;
}): Parameters<DraftVersionCreator['createVersion']>[0] {
  const { record, proposal, proposalHash, policyHash, blockers, validation, actor, appliedAt } = args;
  return {
    domain: record.domain,
    selectors: sanitizedDraftSelectors(proposal),
    runtime: draftRuntime(record),
    sampleIds: [],
    artifactHashes: draftArtifactHashes(record),
    validationSummary: draftValidationSummary({ record, proposalHash, policyHash, blockers, validation, actor, appliedAt }),
    provenance: {
      provider: 'browser-investigation',
      model: record.actualModel?.model ?? record.requestedModel?.model ?? 'unreported',
      configId: record.id,
    },
    approver: actor,
    reason: `browser-investigation-apply:${record.id}`,
  };
}

/**
 * Apply a compilable proposal as an inactive blocked draft (#234
 * server-authoritative).
 *
 * The persisted server-generated validation record is loaded and bound by
 * investigation, proposal, policy, and validation hashes before anything is
 * copied into the version. Client-submitted validation status and holdout
 * counts/identities are rejected as `validation_untrusted` rather than
 * trusted. Failed or incomplete trusted validation still applies — blockers
 * are preserved, never waived — and unappliable outcomes are rejected
 * without creating a version. No active pointer, no image grant.
 */
export async function applyProposalToDraft(
  deps: {
    investigations: InvestigationStore;
    proposals: ProposalStore;
    validations: ValidationStore;
    createVersion: DraftVersionCreator['createVersion'];
  },
  options: {
    workspaceId: string;
    investigationId: string;
    actor: string;
    now?: Date;
    /**
     * Removed (#234): client-submitted validation credentials are rejected
     * as `validation_untrusted`. Retained in the type surface only so old
     * callers fail closed at runtime instead of silently downgrading to
     * `not_run`. Honest callers omit it entirely.
     */
    validation?: unknown;
  },
): Promise<ApplyProposalResult> {
  rejectClientValidationCredentials(options as Record<string, unknown>);
  const actor = options.actor?.trim();
  if (!actor) fail('invalid_input', 'apply actor required');
  const { record, proposal, gaps, stored } = resolveAppliableProposal(
    deps,
    options.workspaceId,
    options.investigationId,
    options.now,
  );
  const proposalHash = hashProposal(proposal);
  const policyHash = hashPolicyContent({
    platform: proposal.platform,
    structures: proposal.structures,
    fields: proposal.fields,
    identity: proposal.identity,
    renderedBrowserRequired: proposal.renderedBrowserRequired,
  });
  const validation = loadTrustedValidation({
    validations: deps.validations,
    workspaceId: options.workspaceId,
    record,
    proposalHash,
    policyHash,
  });
  const blockers = buildDraftBlockers(gaps, validation);
  const appliedAt = (options.now ?? new Date()).toISOString();
  const created = deps.createVersion(
    buildDraftVersionInput({ record, proposal, proposalHash, policyHash, blockers, validation, actor, appliedAt }),
  );
  if (!stored || !stored.proposalHash) {
    deps.proposals.saveProposal(options.workspaceId, options.investigationId, JSON.stringify(proposal), proposalHash);
  }
  deps.proposals.markApplied(options.workspaceId, options.investigationId, created.id, actor, appliedAt);
  return { appliedVersionId: created.id, proposalHash, policyHash, blockers };
}
