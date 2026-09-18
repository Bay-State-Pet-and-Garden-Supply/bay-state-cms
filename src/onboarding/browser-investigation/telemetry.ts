// Browser Investigation runtime telemetry (T6).
//
// Operator-visible telemetry DERIVED from persisted investigation state at
// query time — never a checked-in ledger, never fabricated. Every metric is
// either an exact derivation from the stored record/validation or an
// explicit unavailable marker: missing usage is reported as unavailable
// (never zero), and rate-derived estimates stay distinct from billed cost.
//
// Privacy: the view carries lifecycle, provider/domain, mode, duration,
// sample counts, run identity, usage/cost, recommended strategy,
// rendered-browser need, gap counts, validation outcomes, and
// wrong-product / wrong-variant signals. It never carries keys, full
// sensitive prompts, uncontrolled page content, or workspace-private
// knownContext VALUES (key names only, matching the workspace evidence
// view). Observation detail text and artifact bytes never leave the
// workspace tables through this view.
//
// Pure (no DB, no network, no provider imports): Vitest-safe.

import type {
  InvestigationRecord,
} from '../../shared/schemas/browser-investigation';
import type { ProposalValidation } from './validate';
import { describeInvestigationCost, describeInvestigationModel } from './workspace';

export interface InvestigationTelemetryUsage {
  modelCalls: number | null;
  pagesVisited: number | null;
  readsPerformed: number | null;
  durationMs: number | null;
  costUsd: number | null;
  costBasis: 'billed' | 'estimated' | 'unavailable';
  costDisplay: string;
}

export interface InvestigationTelemetryValidation {
  status: ProposalValidation['status'];
  representativeTotal: number;
  representativePassed: number;
  holdoutsRequired: number;
  holdoutsPassed: number;
  holdoutSampleIds: string[];
  blockerCount: number;
  blockers: string[];
}

export interface InvestigationIdentitySignals {
  wrongProduct: number;
  wrongVariant: number;
  ambiguous: number;
  noMatch: number;
  matched: number;
}

export interface InvestigationTelemetry {
  investigationId: string;
  domain: string;
  mode: InvestigationRecord['mode'];
  status: InvestigationRecord['status'];
  provider: InvestigationRecord['provider'];
  runId: string;
  requestedModel: string;
  actualModel: string;
  /** Wall-clock run duration (completedAt - startedAt) or usage duration fallback; null when underivable. */
  durationMs: number | null;
  sampleCounts: { requested: number; investigated: number };
  usage: InvestigationTelemetryUsage;
  /** Display-only strategy label (bounded, truncated); the compiler never branches on it. */
  recommendedStrategy: string | null;
  renderedBrowser: { required: boolean; reason: string | null };
  gapCounts: { resultGaps: number; compileGaps: number | null };
  validation: InvestigationTelemetryValidation | null;
  identitySignals: InvestigationIdentitySignals | null;
  failure: { code: string; detail: string | null } | null;
  /** Operator knownContext key names only — values never leave workspace tables. */
  knownContextKeys: string[];
}

function costDisplayOf(usage: InvestigationRecord['usage']): Pick<InvestigationTelemetryUsage, 'costUsd' | 'costBasis' | 'costDisplay'> {
  const summarized = describeInvestigationCost(usage);
  return { costUsd: summarized.costUsd, costBasis: summarized.costBasis, costDisplay: summarized.costDisplay };
}

function durationOf(record: InvestigationRecord): number | null {
  if (record.startedAt && record.completedAt) {
    const ms = Date.parse(record.completedAt) - Date.parse(record.startedAt);
    if (Number.isSafeInteger(ms) && ms >= 0) return ms;
  }
  return record.usage?.durationMs ?? null;
}

function strategyOf(record: InvestigationRecord): string | null {
  const raw = record.result?.recommendedStrategy;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Display label only, bounded: never full prompts or page content.
  return raw.trim().slice(0, 200);
}

function validationOf(validation: ProposalValidation | null): InvestigationTelemetryValidation | null {
  if (!validation) return null;
  const reps = validation.samples.filter((s) => s.role === 'representative');
  return {
    status: validation.status,
    representativeTotal: reps.length,
    representativePassed: reps.filter((s) => s.status === 'pass').length,
    holdoutsRequired: validation.holdouts.required,
    holdoutsPassed: validation.holdouts.passed,
    holdoutSampleIds: [...validation.holdouts.sampleIds],
    blockerCount: validation.blockers.length,
    blockers: [...validation.blockers],
  };
}

function identitySignalsOf(validation: ProposalValidation | null): InvestigationIdentitySignals | null {
  if (!validation) return null;
  const signals: InvestigationIdentitySignals = { wrongProduct: 0, wrongVariant: 0, ambiguous: 0, noMatch: 0, matched: 0 };
  for (const sample of validation.samples) {
    switch (sample.identityOutcome) {
      case 'wrong_product': signals.wrongProduct += 1; break;
      case 'wrong_variant': signals.wrongVariant += 1; break;
      case 'ambiguous': signals.ambiguous += 1; break;
      case 'no_match': signals.noMatch += 1; break;
      case 'match': signals.matched += 1; break;
      default: break;
    }
  }
  return signals;
}

/**
 * Derive operator-visible telemetry for one investigation from persisted
 * state. Never fabricates cost, never leaks knownContext values, prompts,
 * keys, or page content.
 */
export function describeInvestigationTelemetry(
  record: InvestigationRecord,
  validation: ProposalValidation | null = null,
): InvestigationTelemetry {
  const usage = record.usage;
  const cost = costDisplayOf(usage);
  return {
    investigationId: record.id,
    domain: record.domain,
    mode: record.mode,
    status: record.status,
    provider: record.provider,
    runId: record.runId,
    requestedModel: describeInvestigationModel(record.requestedModel),
    actualModel: describeInvestigationModel(record.actualModel),
    durationMs: durationOf(record),
    sampleCounts: {
      requested: record.inputSnapshot.sampleUrls.length,
      investigated: record.result?.observations.length ?? 0,
    },
    usage: {
      modelCalls: usage?.modelCalls ?? null,
      pagesVisited: usage?.pagesVisited ?? null,
      readsPerformed: usage?.readsPerformed ?? null,
      durationMs: usage?.durationMs ?? null,
      ...cost,
    },
    recommendedStrategy: strategyOf(record),
    renderedBrowser: {
      required: record.result?.renderedBrowserRequired ?? false,
      reason: record.result?.renderedBrowserReason ?? null,
    },
    gapCounts: {
      resultGaps: record.result?.gaps.length ?? 0,
      compileGaps: null,
    },
    validation: validationOf(validation),
    identitySignals: identitySignalsOf(validation),
    failure: record.failureCode ? { code: record.failureCode, detail: record.failureDetail } : null,
    knownContextKeys: Object.keys(record.inputSnapshot.knownContext ?? {}).sort(),
  };
}

/**
 * Attach the compiler gap count to a telemetry view without re-deriving
 * anything else. Keeps the compile seam out of the base derivation so the
 * telemetry module never imports the compiler's outcome types at runtime
 * (type-only usage keeps the module boundary clean for the isolation audit).
 */
export function withCompileGapCount(
  telemetry: InvestigationTelemetry,
  compileGapCount: number | null,
): InvestigationTelemetry {
  return { ...telemetry, gapCounts: { ...telemetry.gapCounts, compileGaps: compileGapCount } };
}
