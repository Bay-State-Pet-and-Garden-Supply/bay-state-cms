// Browser Investigation workspace operator flow (T5).
//
// Evidence-rich, workspace-scoped describe helpers for the domain Profile
// Workspace: representative selection with visible holdout coverage and
// budgets, Investigate Domain / Investigate Drift-Failure entries,
// evidence-rich results, and separate Validate Proposal, Apply to Draft,
// and Discard actions — with no automatic activation or release affordance
// anywhere.
//
// Pure except for injected readers (no DB imports): Vitest-safe. This
// module computes NO health verdict and NO gate — reviewed health stays
// the single definition in domain-version-health.ts /
// profile-activation-gate.ts. Coverage gaps reported here are selection
// guidance, never activation criteria.

import {
  describeInvestigationBudget,
  type InvestigationBudget,
  type InvestigationRecord,
  type InvestigationUsage,
} from '../../shared/schemas/browser-investigation';
import {
  extractionPolicyOfSelectors,
  hashPolicyContent,
  hashProposal,
} from '../../shared/schemas/browser-investigation-policy';
import { compileInvestigationResult } from './compiler';
import { investigatedUrlsOf, suggestHoldoutCoverage, type HoldoutCoverageSuggestion } from './holdouts';
import type { ProposalValidation } from './validate';

/** Actual usage/cost, or explicit unavailable — costs are never fabricated. */
export interface InvestigationCostSummary {
  modelCalls: number | null;
  pagesVisited: number | null;
  readsPerformed: number | null;
  durationMs: number | null;
  costUsd: number | null;
  costBasis: 'billed' | 'estimated' | 'unavailable';
  /** Operator display: actual billed/estimated cost, or explicit unavailable. */
  costDisplay: string;
}

export function describeInvestigationCost(usage: InvestigationUsage | null): InvestigationCostSummary {
  const basis = usage?.costBasis ?? 'unavailable';
  const costUsd = typeof usage?.costUsd === 'number' ? usage.costUsd : null;
  return {
    modelCalls: usage?.modelCalls ?? null,
    pagesVisited: usage?.pagesVisited ?? null,
    readsPerformed: usage?.readsPerformed ?? null,
    durationMs: usage?.durationMs ?? null,
    costUsd,
    costBasis: basis,
    costDisplay:
      costUsd == null
        ? 'unavailable'
        : basis === 'billed'
          ? `$${costUsd} (billed)`
          : basis === 'estimated'
            ? `$${costUsd} (estimated)`
            : `$${costUsd} (basis unreported)`,
  };
}

function modelDisplay(model: InvestigationRecord['requestedModel']): string {
  if (!model) return 'unreported';
  const parts = [model.provider, model.model ?? model.requested ?? model.actual].filter(Boolean);
  return parts.length > 0 ? parts.join('/') : 'unreported';
}

export interface InvestigationEvidenceSummary {
  investigationId: string;
  domain: string;
  mode: InvestigationRecord['mode'];
  status: InvestigationRecord['status'];
  provider: InvestigationRecord['provider'];
  requestedModel: string;
  actualModel: string;
  platform: string;
  evidenceLinks: string[];
  structures: Array<{ id: string; sampleUrls: string[]; description?: string; platformSource?: string }>;
  fieldRecommendations: Array<{ field: string; sources: string[]; structureId?: string; evidenceRef?: string }>;
  identity: { productIdentity: string[]; variantIdentity: string[]; optionAxes: string[] } | null;
  gaps: string[];
  codeAdapterNeeded: { capability: string; reason: string } | null;
  renderedBrowser: { required: boolean; reason: string | null };
  usage: InvestigationCostSummary;
  failure: { code: string; detail: string | null } | null;
  /** Operator knownContext key names only — workspace-private values never leave the workspace tables. */
  knownContextKeys: string[];
  driftBaseline: unknown | null;
}

/**
 * Evidence-rich operator summary of one investigation: platform and
 * structure evidence, field recommendations, identity support, gaps,
 * provider/model, actual usage/cost or explicit unavailable, and stable
 * failure codes.
 */
type EvidenceResult = NonNullable<InvestigationRecord['result']>;

function evidenceStructures(result: EvidenceResult | null | undefined): InvestigationEvidenceSummary['structures'] {
  return (result?.structures ?? []).map((s) => ({
    id: s.id,
    sampleUrls: [...(s.sampleUrls ?? [])],
    ...(s.description ? { description: s.description } : {}),
    ...(s.platformSource ? { platformSource: s.platformSource } : {}),
  }));
}

function evidenceFieldRecommendations(result: EvidenceResult | null | undefined): InvestigationEvidenceSummary['fieldRecommendations'] {
  return (result?.fieldRecommendations ?? []).map((r) => ({
    field: r.field,
    sources: [...r.sources],
    ...(r.structureId ? { structureId: r.structureId } : {}),
    ...(r.evidenceRef ? { evidenceRef: r.evidenceRef } : {}),
  }));
}

function evidenceIdentity(result: EvidenceResult | null | undefined): InvestigationEvidenceSummary['identity'] {
  const identity = result?.identityRequirements;
  return identity
    ? {
        productIdentity: [...identity.productIdentity],
        variantIdentity: [...identity.variantIdentity],
        optionAxes: [...(identity.optionAxes ?? [])],
      }
    : null;
}

function evidenceDriftBaseline(record: InvestigationRecord): unknown | null {
  if (record.mode !== 'drift_repair') return null;
  return (record.inputSnapshot.knownContext as Record<string, unknown> | undefined)?.driftRepair ?? null;
}

export function describeInvestigationEvidence(record: InvestigationRecord): InvestigationEvidenceSummary {
  const result = record.result;
  return {
    investigationId: record.id,
    domain: record.domain,
    mode: record.mode,
    status: record.status,
    provider: record.provider,
    requestedModel: modelDisplay(record.requestedModel),
    actualModel: modelDisplay(record.actualModel),
    platform: result?.platform ?? 'unknown',
    evidenceLinks: [...(result?.evidenceRefs ?? [])],
    structures: evidenceStructures(result),
    fieldRecommendations: evidenceFieldRecommendations(result),
    identity: evidenceIdentity(result),
    gaps: [...(result?.gaps ?? [])],
    codeAdapterNeeded: result?.codeAdapterNeeded
      ? { capability: result.codeAdapterNeeded.capability, reason: result.codeAdapterNeeded.reason }
      : null,
    renderedBrowser: {
      required: result?.renderedBrowserRequired ?? false,
      reason: result?.renderedBrowserReason ?? null,
    },
    usage: describeInvestigationCost(record.usage),
    failure: record.failureCode ? { code: record.failureCode, detail: record.failureDetail } : null,
    knownContextKeys: Object.keys(record.inputSnapshot.knownContext ?? {}).sort(),
    driftBaseline: evidenceDriftBaseline(record),
  };
}

export interface HoldoutCoverageView {
  /** Hard activation minimum: exactly one passing holdout (shared gate owns this). */
  required: number;
  passed: number;
  /** Holdouts reserved by prior validations: every one must run. */
  reserved: string[];
  suggestion: HoldoutCoverageSuggestion;
  validationStatus: ProposalValidation['status'] | 'not_run';
}

/** Visible holdout coverage: reserved set, passing count, preference, and gaps. */
export function describeHoldoutCoverage(args: {
  record: InvestigationRecord;
  reservedUrls: string[];
  corpusUrls: string[];
  validation: ProposalValidation | null;
}): HoldoutCoverageView {
  const structures = (args.record.result?.structures ?? []).map((s) => ({ id: s.id, sampleUrls: [...(s.sampleUrls ?? [])] }));
  return {
    required: 1,
    passed: args.validation?.holdouts.passed ?? 0,
    reserved: [...args.reservedUrls],
    suggestion: suggestHoldoutCoverage({
      structures,
      corpusUrls: args.corpusUrls,
      // Same investigated definition the exposure check enforces: samples
      // plus observed source URLs, so coverage never suggests an exposed URL.
      investigatedUrls: investigatedUrlsOf(args.record),
      reservedUrls: args.reservedUrls,
    }),
    validationStatus: args.validation?.status ?? 'not_run',
  };
}

export type WorkspaceProposalView =
  | {
      available: true;
      status: 'proposal' | 'requires_code_adapter' | 'unresolved';
      proposalHash: string | null;
      policyHash: string | null;
      platform: string;
      structuresCount: number;
      fieldsCount: number;
      gaps: string[];
      capability: string | null;
    }
  | { available: false; reason: string };

/** Pure compilability preview (no persistence): what Validate/Apply would compile. */
function describeProposalPreview(record: InvestigationRecord): WorkspaceProposalView {
  if (record.status !== 'completed') return { available: false, reason: `investigation is ${record.status}; no proposal to preview` };
  if (!record.result || !record.resultHash) return { available: false, reason: 'investigation has no typed result to compile' };
  const outcome = compileInvestigationResult(record.result, {
    domain: record.domain,
    investigationId: record.id,
    runId: record.runId,
    inputHash: record.inputHash,
    resultHash: record.resultHash,
  });
  if (outcome.status === 'proposal') {
    const proposal = outcome.proposal;
    return {
      available: true,
      status: 'proposal',
      proposalHash: hashProposal(proposal),
      policyHash: hashPolicyContent({
        platform: proposal.platform,
        structures: proposal.structures,
        fields: proposal.fields,
        identity: proposal.identity,
        renderedBrowserRequired: proposal.renderedBrowserRequired,
      }),
      platform: proposal.platform,
      structuresCount: proposal.structures.length,
      fieldsCount: proposal.fields.length,
      gaps: outcome.gaps.map((g) => `${g.kind}:${g.field ?? 'general'}`),
      capability: null,
    };
  }
  if (outcome.status === 'requires_code_adapter') {
    return {
      available: true,
      status: 'requires_code_adapter',
      proposalHash: null,
      policyHash: null,
      platform: 'unknown',
      structuresCount: 0,
      fieldsCount: 0,
      gaps: [],
      capability: outcome.codeAdapterRequest.capability,
    };
  }
  return {
    available: true,
    status: 'unresolved',
    proposalHash: null,
    policyHash: null,
    platform: 'unknown',
    structuresCount: 0,
    fieldsCount: 0,
    gaps: outcome.gaps.map((g) => `${g.kind}:${g.field ?? 'general'}`),
    capability: null,
  };
}

export interface WorkspaceAction {
  allowed: boolean;
  reason: string;
}

export interface InvestigationWorkspaceView {
  investigation: Pick<InvestigationRecord, 'id' | 'domain' | 'mode' | 'status' | 'provider'>;
  representatives: { confirmed: string[]; investigated: string[] };
  holdouts: HoldoutCoverageView;
  budgets: Array<{ key: string; label: string; value: string }>;
  evidence: InvestigationEvidenceSummary;
  proposal: WorkspaceProposalView;
  validation: ProposalValidation | null;
  actions: {
    validate: WorkspaceAction;
    apply: WorkspaceAction;
    discard: WorkspaceAction;
    /** The investigation flow offers no automatic activation — governed activation stays authoritative. */
    automaticActivation: false;
    /** The investigation flow offers no automatic release — governed release stays authoritative. */
    automaticRelease: false;
  };
  /** Health verdicts come from the shared evaluator only; this view computes no gate. */
  healthVerdict: 'see shared domain-version-health evaluator; this view computes no gate';
}

/**
 * The Profile Workspace operator view for one investigation: representative
 * selection with visible holdout coverage and budgets, evidence-rich
 * results, and separate Validate Proposal / Apply to Draft / Discard
 * actions. Read-only: no versions, no activation, no release, no image
 * attestation.
 */
export function describeInvestigationWorkspace(args: {
  record: InvestigationRecord;
  budget: InvestigationBudget;
  representatives: string[];
  corpusUrls: string[];
  reservedUrls: string[];
  validation: ProposalValidation | null;
}): InvestigationWorkspaceView {
  const { record } = args;
  const proposal = describeProposalPreview(record);
  const canValidate = record.status === 'completed' && !!record.result && !!record.resultHash;
  const applyBlocked =
    !canValidate
      ? `only completed investigations can be applied (is ${record.status})`
      : proposal.available && proposal.status !== 'proposal'
        ? `unappliable:${proposal.status} — compilable proposals only; blocked drafts for failed validation still apply on the apply action`
        : null;
  const terminal = record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled';
  return {
    investigation: { id: record.id, domain: record.domain, mode: record.mode, status: record.status, provider: record.provider },
    representatives: { confirmed: [...args.representatives], investigated: [...(record.inputSnapshot.sampleUrls ?? [])] },
    holdouts: describeHoldoutCoverage({ record, reservedUrls: args.reservedUrls, corpusUrls: args.corpusUrls, validation: args.validation }),
    budgets: describeInvestigationBudget(args.budget),
    evidence: describeInvestigationEvidence(record),
    proposal,
    validation: args.validation,
    actions: {
      validate: canValidate
        ? { allowed: true, reason: 'completed investigation with a typed result' }
        : { allowed: false, reason: `only completed investigations can be validated (is ${record.status})` },
      apply:
        applyBlocked != null
          ? { allowed: false, reason: applyBlocked }
          : { allowed: true, reason: 'compilable proposal; publishes a sanitized inactive shared draft with blockers preserved' },
      discard: terminal
        ? { allowed: true, reason: 'terminal investigations can be discarded; active versions, health, and items stay untouched' }
        : { allowed: false, reason: `only terminal investigations can be discarded (is ${record.status})` },
      automaticActivation: false,
      automaticRelease: false,
    },
    healthVerdict: 'see shared domain-version-health evaluator; this view computes no gate',
  };
}

// ─── Drift/failure entry ────────────────────────────────────────────────────
// The Investigate Drift/Failure entry pre-attaches the frozen last-healthy
// baseline so repair starts from evidence rather than rediscovery: the
// last-healthy policy content, artifact hashes, the failing extraction with
// per-sample provenance and failure codes, and the affected fields.

export interface DriftBaselineVersion {
  id: string;
  selectors: unknown;
  artifactHashes: string[];
}

export interface DriftMatrixCell {
  field: string;
  provenance: string;
  success: boolean;
  failureReason: string | null;
}

export interface DriftMatrixRow {
  sampleId: string;
  sampleUrl: string;
  cells: DriftMatrixCell[];
}

export interface DriftMatrix {
  rows: DriftMatrixRow[];
}

export type DriftRepairContext =
  | { available: false; reason: string }
  | {
      available: true;
      lastHealthyVersionId: string;
      /** Shared extraction-policy content, or null for legacy pre-policy versions. */
      policy: Record<string, unknown> | null;
      artifactHashes: string[];
      failingSamples: Array<{
        sampleId: string;
        sampleUrl: string;
        affectedFields: string[];
        failureCodes: string[];
        provenance: string[];
      }>;
      failureCodes: string[];
      affectedFields: string[];
    };

/**
 * Build the drift-repair entry context from the frozen last-healthy
 * baseline (active version) plus current matrix failures. Injected readers
 * keep this pure and Vitest-exercisable; the route adapter supplies the
 * repository reads. Never throws: missing evidence yields an explicit
 * unavailable marker, never fabricated context.
 */
export function buildDriftRepairContext(
  domain: string,
  deps: { activeVersion: DriftBaselineVersion | null; matrix: DriftMatrix | null },
): DriftRepairContext {
  void domain;
  if (!deps.activeVersion) {
    return { available: false, reason: 'no_active_version:domain has no active profile version to repair from' };
  }
  const failingSamples: Extract<DriftRepairContext, { available: true }>['failingSamples'] = [];
  for (const row of deps.matrix?.rows ?? []) {
    const failing = row.cells.filter((c) => !c.success);
    if (failing.length === 0) continue;
    failingSamples.push({
      sampleId: row.sampleId,
      sampleUrl: row.sampleUrl,
      affectedFields: [...new Set(failing.map((c) => c.field))].sort(),
      failureCodes: [...new Set(failing.map((c) => c.failureReason ?? 'unspecified_failure'))].sort(),
      provenance: [...new Set(failing.map((c) => c.provenance))].sort(),
    });
  }
  return {
    available: true,
    lastHealthyVersionId: deps.activeVersion.id,
    policy: extractionPolicyOfSelectors(deps.activeVersion.selectors),
    artifactHashes: [...deps.activeVersion.artifactHashes],
    failingSamples,
    failureCodes: [...new Set(failingSamples.flatMap((s) => s.failureCodes))].sort(),
    affectedFields: [...new Set(failingSamples.flatMap((s) => s.affectedFields))].sort(),
  };
}

/**
 * Attach server-built drift context to an investigation launch. The
 * `driftRepair` key is server-owned: caller-supplied values are replaced so
 * baseline evidence cannot be spoofed through the launch payload.
 */
export function attachDriftRepairContext(
  knownContext: Record<string, unknown> | undefined,
  driftContext: DriftRepairContext,
): Record<string, unknown> {
  return { ...(knownContext ?? {}), driftRepair: driftContext };
}
