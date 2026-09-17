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
// store, version creator), so governance is Vitest-exercisable with memory
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
import type { CreateVersionInput } from '../../db/repositories/profile-version-repo';
import { compileInvestigationResult } from './compiler';
import {
  InvestigationServiceError,
  type InvestigationStore,
} from './service';

export { InvestigationServiceError };

function fail(
  code: 'invalid_input' | 'invalid_transition' | 'not_found' | 'workspace_mismatch' | 'unappliable_proposal' | 'already_applied' | 'stale_proposal',
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

export interface ApplyValidationInput {
  status: 'passed' | 'failed' | 'incomplete' | 'not_run';
  /** Operator-supplied blockers (bounded strings, preserved verbatim). */
  blockers?: string[];
  validationRef?: string;
}

const ApplyValidationInputStatuses = ['passed', 'failed', 'incomplete', 'not_run'] as const;

function parseValidationInput(raw: unknown): ApplyValidationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'not_run' };
  const input = raw as Record<string, unknown>;
  const status = ApplyValidationInputStatuses.includes(input.status as never)
    ? (input.status as ApplyValidationInput['status'])
    : 'not_run';
  const blockers = Array.isArray(input.blockers)
    ? input.blockers.filter((b): b is string => typeof b === 'string' && b.trim().length > 0).map((b) => b.trim().slice(0, 500)).slice(0, 50)
    : [];
  const validationRef =
    typeof input.validationRef === 'string' && input.validationRef.trim()
      ? input.validationRef.trim().slice(0, 500)
      : undefined;
  return { status, blockers, ...(validationRef ? { validationRef } : {}) };
}

function scopedRecord(
  investigations: InvestigationStore,
  workspaceId: string,
  investigationId: string,
): InvestigationRecord {
  if (!workspaceId || !workspaceId.trim()) fail('invalid_input', 'workspaceId required');
  const found = investigations.find(workspaceId, investigationId);
  if (found) return found;
  if (investigations.existsInOtherWorkspace(workspaceId, investigationId)) {
    fail('workspace_mismatch', 'investigation belongs to another workspace');
  }
  fail('not_found', `investigation ${investigationId} not found`);
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
 */
function sanitizedDraftSelectors(proposal: ExtractionPolicyProposal): Record<string, unknown> {
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

/** Coverage gaps plus validation state become preserved draft blockers — never waived. */
function buildDraftBlockers(gaps: ProposalOutcome['gaps'], validation: ApplyValidationInput): string[] {
  return [
    ...gaps.map((g) => `gap:${g.kind}:${g.field ?? 'general'}`),
    ...(validation.blockers ?? []),
    ...(validation.status === 'passed' ? [] : [`validation:${validation.status}`]),
  ];
}

/** Blocked-draft validation summary: binding hashes plus preserved blockers, never an image grant. */
function draftValidationSummary(args: {
  record: InvestigationRecord;
  proposalHash: string;
  policyHash: string;
  blockers: string[];
  validation: ApplyValidationInput;
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
    ...(validation.validationRef ? { validationRef: validation.validationRef } : {}),
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
  validation: ApplyValidationInput;
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
 * Apply a compilable proposal as an inactive blocked draft. Accepts failed or
 * incomplete validation — blockers are preserved, never waived — and rejects
 * unappliable outcomes without creating a version.
 */
export async function applyProposalToDraft(
  deps: { investigations: InvestigationStore; proposals: ProposalStore; createVersion: DraftVersionCreator['createVersion'] },
  options: { workspaceId: string; investigationId: string; actor: string; validation?: unknown; now?: Date },
): Promise<ApplyProposalResult> {
  const actor = options.actor?.trim();
  if (!actor) fail('invalid_input', 'apply actor required');
  const { record, proposal, gaps, stored } = resolveAppliableProposal(
    deps,
    options.workspaceId,
    options.investigationId,
    options.now,
  );
  const validation = parseValidationInput(options.validation);
  const blockers = buildDraftBlockers(gaps, validation);
  const proposalHash = hashProposal(proposal);
  const policyHash = hashPolicyContent({
    platform: proposal.platform,
    structures: proposal.structures,
    fields: proposal.fields,
    identity: proposal.identity,
    renderedBrowserRequired: proposal.renderedBrowserRequired,
  });
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
