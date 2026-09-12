/**
 * Ticket #125 — server-owned collection projection (Decision 2).
 *
 * Derives per-item collection readiness from ALREADY-LOADED chunk facts
 * through the pure activation gate — following the preparation-read
 * pattern (pure mapping, zero new SQL; the caller owns bulk loading).
 * The client consumes the serialized decision and formats it; it never
 * recomputes authority.
 */
import {
  evaluateStrategyCollectionActivation,
  activationCopy,
  ACTIVATION_READY_EXPLANATION,
  type StrategyCollectionActivationDecision,
  type ActivationSourceUsability,
} from './strategy-collection-activation';

/** Per-item facts — all sourced from the already-loaded chunk. */
export interface CollectionItemFacts {
  itemId: string;
  /** Normalized brand key (null = missing brand). */
  normalizedBrand: string | null;
  /** Current entry-policy marker. */
  entryPolicyCurrent: boolean;
  /** UPC usable as a lookup identifier. */
  hasUsableIdentifier: boolean;
  /** Stage-1 scheduling state. */
  scheduling: {
    eligible: boolean;
    claimedElsewhere: boolean;
    batchReleased: boolean;
  };
  /** Generation/binding state (null = no generation yet). */
  generation: {
    isFresh: boolean;
    hasTerminalOutcome: boolean;
    hasEvidenceWithoutBinding: boolean;
    hasBinding: boolean;
    bindingInvalid: boolean;
    bindingRetired: boolean;
    bindingMode: 'approved' | 'query_all' | 'legacy_advisory' | null;
    bindingBrandMatches: boolean;
    bindingRevision: number | null;
  } | null;
  /** Exact current approval for the item brand (null = never approved). */
  approval: {
    present: boolean;
    revision: number;
    normalizedBrand: string;
    brandMatches: boolean;
  } | null;
  /** Candidate sources: pinned boundary when bound, else live approval. */
  sources: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  /** Per-source usability aligned with the candidate sources. */
  usability: ActivationSourceUsability[];
  collectionUnderway: boolean;
}

/** Shared chunk context (loaded once per chunk, never per item). */
export interface CollectionSharedContext {
  flags: { effectiveEnabled: boolean; mode: 'observe' | 'manual' | 'automatic' | null };
}

export interface CollectionReadinessView {
  itemId: string;
  decision: StrategyCollectionActivationDecision;
  /** Exact copy-ladder label (textual, never color-only). */
  label: string;
  /** Persistent explanation for Ready states (null otherwise). */
  explanation: string | null;
  /** Strategy column text, e.g. "Phillips + BCI" or "Suggested sources". */
  strategyLabel: string;
}

export function strategySourcesLabel(
  sources: ReadonlyArray<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>,
): string {
  if (sources.length === 0) return 'Suggested sources';
  return sources
    .map((s) => (s.kind === 'official_page' ? 'Official website' : (s.distributorId ?? 'Distributor')))
    .join(' + ');
}

function toDecision(facts: CollectionItemFacts, shared: CollectionSharedContext): StrategyCollectionActivationDecision {
  // No generation yet: fresh work. An explicit live approval authorizes a
  // fresh capture; otherwise B1.1 query-all compatibility.
  const generation = facts.generation ?? {
    isFresh: true,
    hasTerminalOutcome: false,
    hasEvidenceWithoutBinding: false,
    hasBinding: false,
    bindingInvalid: false,
    bindingRetired: false,
    bindingMode: null,
    bindingBrandMatches: true,
    bindingRevision: null,
  };
  return evaluateStrategyCollectionActivation({
    flags: shared.flags,
    hasUsableIdentifier: facts.hasUsableIdentifier,
    entryPolicyCurrent: facts.entryPolicyCurrent,
    scheduling: facts.scheduling,
    generation,
    approval: facts.approval,
    sources: facts.usability,
    collectionUnderway: facts.collectionUnderway,
  });
}

/**
 * Pure: map already-loaded facts to serializable per-item views.
 * Zero SQL. Unknown inputs (null generation handled above) never read as
 * approved readiness — the gate returns compatibility/awaiting.
 */
export function deriveCollectionForItems(
  entries: CollectionItemFacts[],
  shared: CollectionSharedContext,
): Map<string, CollectionReadinessView> {
  const out = new Map<string, CollectionReadinessView>();
  for (const facts of entries) {
    const decision = toDecision(facts, shared);
    const ready = decision.readiness === 'ready' || decision.readiness === 'ready_partial';
    out.set(facts.itemId, {
      itemId: facts.itemId,
      decision,
      label: activationCopy(decision),
      explanation: ready ? ACTIVATION_READY_EXPLANATION : null,
      strategyLabel: strategySourcesLabel(facts.sources),
    });
  }
  return out;
}
