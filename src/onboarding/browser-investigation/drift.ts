// Browser Investigation drift repair proposal (T6).
//
// Compares the frozen last-healthy baseline policy content with a freshly
// compiled Extraction Policy Proposal and returns the smallest supported
// deterministic change — field-level source-order / selector diffs only.
// No provider calls, no automatic reruns, no auto-promotion: the result is
// a reviewable proposal that must still travel the same compile → validate
// → human-review → governed-activation path as any other proposal.
//
// Pure (no DB, no network, no provider imports): Vitest-safe. The service
// never calls this automatically; only the explicit drift-proposal route
// (and operator tooling) invokes it with an already-compiled outcome.

import {
  POLICY_FIELDS,
  hashPolicyContent,
  type CompileOutcome,
  type ExtractionPolicyProposal,
  type PolicyField,
} from '../../shared/schemas/browser-investigation-policy';
import { hashCanonicalJson } from '../../shared/stable-id';

export type DriftFieldChangeKind =
  | 'added'
  | 'removed'
  | 'source_order'
  | 'selector_added'
  | 'selector_removed'
  | 'selector_changed';

export interface DriftFieldChange {
  field: PolicyField;
  change: DriftFieldChangeKind;
  beforeSources: string[] | null;
  afterSources: string[] | null;
  beforeSelector: string | null;
  afterSelector: string | null;
}

export type DriftRepairStatus =
  | 'no_change'
  | 'minimal_change'
  | 'full_replacement'
  | 'unrepairable';

export interface DriftRepairProposal {
  status: DriftRepairStatus;
  changedFields: DriftFieldChange[];
  unchangedFields: PolicyField[];
  /** Non-field policy drift (structures, identity, renderedBrowserRequired) — field diffs alone miss these. */
  nonFieldChanges: string[];
  affectedFields: string[];
  failureCodes: string[];
  baselinePolicyHash: string | null;
  proposalPolicyHash: string;
  gaps: string[];
  blockers: string[];
  /** Drift repairs always require production-worker validation + human review. */
  requiresValidation: true;
  /** No automatic recursive re-investigation: an operator starts the next run explicitly. */
  automaticRerun: false;
  /** No auto-promotion: activation stays governed elsewhere. */
  automaticPromotion: false;
  reason: string;
}

export interface ProposeDriftRepairInput {
  baselinePolicy: unknown;
  outcome: CompileOutcome;
  affectedFields?: string[];
  failureCodes?: string[];
}

interface BaselineField {
  sources: string[];
  selector: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function baselineFieldsOf(baselinePolicy: unknown): Map<string, BaselineField> | null {
  if (!isRecord(baselinePolicy)) return null;
  const rawFields = (baselinePolicy as { fields?: unknown }).fields;
  if (!Array.isArray(rawFields)) return null;
  const out = new Map<string, BaselineField>();
  for (const entry of rawFields) {
    if (!isRecord(entry)) continue;
    const field = entry.field;
    if (typeof field !== 'string' || !(POLICY_FIELDS as readonly string[]).includes(field)) continue;
    const sources = Array.isArray(entry.sources)
      ? entry.sources.filter((s): s is string => typeof s === 'string')
      : [];
    const selector = typeof entry.selector === 'string' ? entry.selector : null;
    out.set(field, { sources, selector });
  }
  return out;
}

function baselinePlatformOf(baselinePolicy: unknown): string | null {
  if (!isRecord(baselinePolicy)) return null;
  const platform = (baselinePolicy as { platform?: unknown }).platform;
  return typeof platform === 'string' ? platform : null;
}

function sameSources(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function presenceDiff(
  field: PolicyField,
  before: BaselineField | undefined,
  after: { sources: string[]; selector?: string } | undefined,
): DriftFieldChange | 'present' | null {
  if (!before && !after) return null;
  if (!before && after) {
    return {
      field,
      change: 'added',
      beforeSources: null,
      afterSources: [...after.sources],
      beforeSelector: null,
      afterSelector: after.selector ?? null,
    };
  }
  if (before && !after) {
    return {
      field,
      change: 'removed',
      beforeSources: [...before.sources],
      afterSources: null,
      beforeSelector: before.selector,
      afterSelector: null,
    };
  }
  return 'present';
}

function selectorChangeOf(beforeSelector: string | null, afterSelector: string | null): DriftFieldChange['change'] {
  if (beforeSelector == null) return 'selector_added';
  if (afterSelector == null) return 'selector_removed';
  return 'selector_changed';
}

function diffOneField(
  field: PolicyField,
  before: BaselineField | undefined,
  after: { sources: string[]; selector?: string } | undefined,
): DriftFieldChange | null {
  const presence = presenceDiff(field, before, after);
  if (presence !== 'present') return presence;
  const b = before!;
  const a = after!;
  const afterSelector = a.selector ?? null;
  if (!sameSources(b.sources, a.sources)) {
    return {
      field,
      change: 'source_order',
      beforeSources: [...b.sources],
      afterSources: [...a.sources],
      beforeSelector: b.selector,
      afterSelector,
    };
  }
  if (b.selector === afterSelector) return null;
  return {
    field,
    change: selectorChangeOf(b.selector, afterSelector),
    beforeSources: [...b.sources],
    afterSources: [...a.sources],
    beforeSelector: b.selector,
    afterSelector,
  };
}

function policyHashOfProposal(proposal: ExtractionPolicyProposal): string {
  return hashPolicyContent({
    platform: proposal.platform,
    structures: proposal.structures,
    fields: proposal.fields,
    identity: proposal.identity,
    renderedBrowserRequired: proposal.renderedBrowserRequired,
  });
}

/** Non-field policy drift invisible to per-field diffs: structures, identity, rendered-browser need. */
function nonFieldDriftOf(baselinePolicy: unknown, proposal: ExtractionPolicyProposal): string[] {
  if (!isRecord(baselinePolicy)) return [];
  const baseline = baselinePolicy as { structures?: unknown; identity?: unknown; renderedBrowserRequired?: unknown };
  const drift: string[] = [];
  if (hashCanonicalJson(baseline.structures ?? []) !== hashCanonicalJson(proposal.structures)) drift.push('structures');
  if (hashCanonicalJson(baseline.identity ?? {}) !== hashCanonicalJson(proposal.identity)) drift.push('identity');
  if ((baseline.renderedBrowserRequired === true) !== proposal.renderedBrowserRequired) drift.push('renderedBrowserRequired');
  return drift;
}

function baselineHashOf(baselinePolicy: unknown): string | null {
  if (!isRecord(baselinePolicy)) return null;
  try {
    const policy = baselinePolicy as {
      platform?: unknown;
      structures?: unknown;
      fields?: unknown;
      identity?: unknown;
      renderedBrowserRequired?: unknown;
    };
    return hashPolicyContent({
      platform: typeof policy.platform === 'string' ? policy.platform : 'unknown',
      structures: policy.structures ?? [],
      fields: policy.fields ?? [],
      identity: policy.identity ?? {},
      renderedBrowserRequired: policy.renderedBrowserRequired === true,
    });
  } catch {
    return null;
  }
}

function boundedList(values: string[] | undefined, limit: number): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort().slice(0, limit);
}

interface RepairContext {
  affectedFields: string[];
  failureCodes: string[];
  baselinePolicyHash: string | null;
}

function repairContextOf(input: ProposeDriftRepairInput): RepairContext {
  return {
    affectedFields: boundedList(input.affectedFields, 20),
    failureCodes: boundedList(input.failureCodes, 20),
    baselinePolicyHash: baselineHashOf(input.baselinePolicy),
  };
}

function unrepairableRepair(
  input: ProposeDriftRepairInput,
  ctx: RepairContext,
  outcome: Extract<CompileOutcome, { status: 'requires_code_adapter' | 'unresolved' }>,
): DriftRepairProposal {
  const detail =
    outcome.status === 'requires_code_adapter'
      ? `requires_code_adapter(${outcome.codeAdapterRequest.capability})`
      : `unresolved(${(outcome.gaps ?? []).map((g) => g.kind).slice(0, 4).join(',')})`;
  return {
    status: 'unrepairable',
    changedFields: [],
    unchangedFields: [],
    nonFieldChanges: [],
    affectedFields: ctx.affectedFields,
    failureCodes: ctx.failureCodes,
    baselinePolicyHash: ctx.baselinePolicyHash,
    proposalPolicyHash: '',
    gaps: outcome.status === 'unresolved' ? outcome.gaps.map((g) => `${g.kind}:${g.field ?? 'general'}`) : [],
    blockers: [`unrepairable:${detail}`, 'validation:requires_code_adapter_or_unresolved'],
    requiresValidation: true,
    automaticRerun: false,
    automaticPromotion: false,
    reason: `fresh investigation is ${detail}: no supported deterministic change to propose; manual adapter work required`,
  };
}

function missingBaselineRepair(
  ctx: RepairContext,
  proposal: ExtractionPolicyProposal,
  proposalPolicyHash: string,
  gaps: string[],
): DriftRepairProposal {
  return {
    status: 'full_replacement',
    changedFields: proposal.fields.map((f) => ({
      field: f.field,
      change: 'added' as const,
      beforeSources: null,
      afterSources: [...f.sources],
      beforeSelector: null,
      afterSelector: f.selector ?? null,
    })),
    unchangedFields: [],
    nonFieldChanges: [],
    affectedFields: ctx.affectedFields,
    failureCodes: ctx.failureCodes,
    baselinePolicyHash: ctx.baselinePolicyHash,
    proposalPolicyHash,
    gaps,
    blockers: ['baseline_missing:legacy pre-policy version; full proposal review required', 'validation:not_run'],
    requiresValidation: true,
    automaticRerun: false,
    automaticPromotion: false,
    reason: 'no frozen policy baseline to diff against (legacy pre-policy version): full proposal review required',
  };
}

function platformShiftRepair(
  ctx: RepairContext,
  proposal: ExtractionPolicyProposal,
  baselineFields: Map<string, BaselineField>,
  baselinePlatform: string,
  proposalPolicyHash: string,
  gaps: string[],
): DriftRepairProposal {
  return {
    status: 'full_replacement',
    changedFields: proposal.fields.map((f) => {
      const before = baselineFields.get(f.field);
      return (
        diffOneField(f.field, before, { sources: [...f.sources], ...(f.selector ? { selector: f.selector } : {}) }) ?? {
          field: f.field,
          change: 'source_order' as const,
          beforeSources: before ? [...before.sources] : null,
          afterSources: [...f.sources],
          beforeSelector: before?.selector ?? null,
          afterSelector: f.selector ?? null,
        }
      );
    }),
    unchangedFields: [],
    nonFieldChanges: [],
    affectedFields: ctx.affectedFields,
    failureCodes: ctx.failureCodes,
    baselinePolicyHash: ctx.baselinePolicyHash,
    proposalPolicyHash,
    gaps,
    blockers: [`platform_changed:${baselinePlatform}->${proposal.platform}`, 'validation:not_run'],
    requiresValidation: true,
    automaticRerun: false,
    automaticPromotion: false,
    reason: `platform changed from ${baselinePlatform} to ${proposal.platform}: smallest-change diff does not apply; full proposal review required`,
  };
}

function fieldDiffRepair(
  ctx: RepairContext,
  proposal: ExtractionPolicyProposal,
  baselineFields: Map<string, BaselineField>,
  baselinePolicy: unknown,
  proposalPolicyHash: string,
  gaps: string[],
): DriftRepairProposal {
  const afterByField = new Map(proposal.fields.map((f) => [f.field, f]));
  const changedFields: DriftFieldChange[] = [];
  const unchangedFields: PolicyField[] = [];
  for (const field of POLICY_FIELDS) {
    const diff = diffOneField(field, baselineFields.get(field), afterByField.get(field));
    if (diff) changedFields.push(diff);
    else if (afterByField.has(field) || baselineFields.has(field)) unchangedFields.push(field);
  }
  const nonFieldChanges = nonFieldDriftOf(baselinePolicy, proposal);
  if (changedFields.length === 0 && nonFieldChanges.length === 0) {
    return {
      status: 'no_change',
      changedFields,
      unchangedFields,
      nonFieldChanges,
      affectedFields: ctx.affectedFields,
      failureCodes: ctx.failureCodes,
      baselinePolicyHash: ctx.baselinePolicyHash,
      proposalPolicyHash,
      gaps,
      blockers: ['validation:not_run'],
      requiresValidation: true,
      automaticRerun: false,
      automaticPromotion: false,
      reason: 'fresh proposal matches the frozen baseline field-for-field: no policy change to propose; failures need a new investigation, not a silent rerun',
    };
  }
  if (changedFields.length === 0) {
    return {
      status: 'minimal_change',
      changedFields,
      unchangedFields,
      nonFieldChanges,
      affectedFields: ctx.affectedFields,
      failureCodes: ctx.failureCodes,
      baselinePolicyHash: ctx.baselinePolicyHash,
      proposalPolicyHash,
      gaps,
      blockers: nonFieldChanges.map((n) => `non_field_drift:${n}`).concat(['validation:not_run']),
      requiresValidation: true,
      automaticRerun: false,
      automaticPromotion: false,
      reason: `non-field policy drift (${nonFieldChanges.join(', ')}) with identical field sources; review structures/identity before validation`,
    };
  }
  const changedNames = changedFields.map((c) => `${c.field}:${c.change}`).join(', ');
  return {
    status: 'minimal_change',
    changedFields,
    unchangedFields,
    nonFieldChanges,
    affectedFields: ctx.affectedFields,
    failureCodes: ctx.failureCodes,
    baselinePolicyHash: ctx.baselinePolicyHash,
    proposalPolicyHash,
    gaps,
    blockers: gaps.map((g) => `gap:${g}`).concat(nonFieldChanges.map((n) => `non_field_drift:${n}`), ['validation:not_run']),
    requiresValidation: true,
    automaticRerun: false,
    automaticPromotion: false,
    reason: `smallest supported change touches ${changedFields.length} field(s) (${changedNames}); all other baseline fields preserved`,
  };
}

/**
 * Propose the smallest supported deterministic change from the frozen
 * last-healthy baseline to a freshly compiled proposal. The caller supplies
 * an already-compiled outcome — this function never invokes the provider,
 * never reruns an investigation, and never promotes anything.
 */
export function proposeDriftRepair(input: ProposeDriftRepairInput): DriftRepairProposal {
  const ctx = repairContextOf(input);
  const outcome = input.outcome;
  if (outcome.status !== 'proposal') return unrepairableRepair(input, ctx, outcome);
  const proposal = outcome.proposal;
  const proposalPolicyHash = policyHashOfProposal(proposal);
  const baselineFields = baselineFieldsOf(input.baselinePolicy);
  const gaps = (outcome.gaps ?? []).map((g) => `${g.kind}:${g.field ?? 'general'}`);
  if (!baselineFields) return missingBaselineRepair(ctx, proposal, proposalPolicyHash, gaps);
  const baselinePlatform = baselinePlatformOf(input.baselinePolicy);
  if (baselinePlatform != null && baselinePlatform !== proposal.platform) {
    return platformShiftRepair(ctx, proposal, baselineFields, baselinePlatform, proposalPolicyHash, gaps);
  }
  return fieldDiffRepair(ctx, proposal, baselineFields, input.baselinePolicy, proposalPolicyHash, gaps);
}
