/**
 * Ticket #125 — strategy-collection activation gate (Decision 8).
 *
 * One pure gate function, three consumers (read model, worker dispatch,
 * UI affordances via the serialized decision). Pure: no SQL, no capture,
 * no connector construction, no network, no mutations. All facts are
 * already-loaded inputs; the gate only orders them.
 *
 * Ordered evaluation:
 *   flags/mode → approval/binding (existing pin wins; corrupt pins never
 *   fall through) → usability → entry-policy v1 for the new path
 *   (protected rows → compatibility) → no-replay/scheduling.
 *
 * All blocker facts are kept (an early capability failure must not
 * manufacture another state).
 */

export type ActivationPath = 'approved_strategy' | 'compatibility' | 'blocked';

export type ActivationReadiness =
  | 'ready'
  | 'ready_partial'
  | 'awaiting_approval'
  | 'setup_attention'
  | 'underway'
  | 'unknown'
  | 'unavailable';

export type ActivationRequirement = 'none' | 'fresh_capture' | 'pinned_resume' | 'explicit_retry';

export interface ActivationSourceUsability {
  kind: 'official_page' | 'distributor_record';
  /** Stable typed ref: domain (lowercased) or distributor id. */
  ref: string;
  domain?: string;
  distributorId?: string;
  usable: boolean;
  /** Bounded, non-secret reason code (never credentials/raw errors). */
  reason: string;
}

export interface StrategyCollectionActivationFacts {
  /** Capability flags (already loaded via getSourcingFlags). */
  flags: { effectiveEnabled: boolean; mode: 'observe' | 'manual' | 'automatic' | null };
  /** Item prerequisites. */
  hasUsableIdentifier: boolean;
  /** Current entry-policy marker (v1 = current; v0/absent = protected). */
  entryPolicyCurrent: boolean;
  /** Scheduling/ownership state. */
  scheduling: {
    /** Eligible Stage 1 work under existing scheduling rules. */
    eligible: boolean;
    /** Claimed by another worker/run (must not double-dispatch). */
    claimedElsewhere: boolean;
    /** Batch released for execution. */
    batchReleased: boolean;
  };
  /** Generation/binding/history state. */
  generation: {
    /** No generation row yet (fresh work). */
    isFresh: boolean;
    /** Generation already finalized with a terminal outcome (no replay). */
    hasTerminalOutcome: boolean;
    /** Evidence exists but no binding (pre-builder/uncertain history). */
    hasEvidenceWithoutBinding: boolean;
    /** Captured binding present. */
    hasBinding: boolean;
    /** Binding row corrupt/unparseable. */
    bindingInvalid: boolean;
    /** Binding is retired history (v1 legacy_advisory). */
    bindingRetired: boolean;
    /** Binding mode. */
    bindingMode: 'approved' | 'query_all' | 'legacy_advisory' | null;
    /** Binding brand matches the item's current brand. */
    bindingBrandMatches: boolean;
    /** Binding revision (approved pins). */
    bindingRevision: number | null;
  };
  /** Exact current approval (null = never approved). */
  approval: {
    present: boolean;
    revision: number;
    normalizedBrand: string;
    /** Item's current normalized brand matches the approval brand. */
    brandMatches: boolean;
  } | null;
  /** Per-source usability (derived beside the gate; no network probes). */
  sources: ActivationSourceUsability[];
  /** Collection already underway for this generation. */
  collectionUnderway: boolean;
}

export interface StrategyCollectionActivationDecision {
  path: ActivationPath;
  readiness: ActivationReadiness;
  /** Collection can run within a boundary (approved or compat). */
  canCollect: boolean;
  /** May execute right now (scheduling + holds clear). */
  canExecuteNow: boolean;
  /** Effective approved revision (null on compatibility/blocked). */
  effectiveRevision: number | null;
  /** Bounded, non-secret reasons (real causes, ordered by eval stage). */
  reasons: string[];
  /** What the caller must do before collection. */
  requires: ActivationRequirement;
  /** Approved-path source boundary (empty unless path is approved_strategy). */
  effectiveSources: Array<{ kind: 'official_page' | 'distributor_record'; ref: string }>;
  /** Per-source availability (also feeds buildStrategies-adjacent views). */
  sourceAvailability: ActivationSourceUsability[];
}

function reason(value: string): string {
  return value.length <= 160 ? value : value.slice(0, 160);
}

export function evaluateStrategyCollectionActivation(
  facts: StrategyCollectionActivationFacts,
): StrategyCollectionActivationDecision {
  const reasons: string[] = [];
  const usable = facts.sources.filter((s) => s.usable);
  const availability = facts.sources.map((s) => ({ ...s, reason: reason(s.reason) }));
  const effectiveSources = usable.map((s) => ({ kind: s.kind, ref: s.ref }));

  const blocked = (
    readiness: ActivationReadiness,
    extraReasons: string[],
    requires: ActivationRequirement = 'none',
  ): StrategyCollectionActivationDecision => ({
    path: 'blocked',
    readiness,
    canCollect: false,
    canExecuteNow: false,
    effectiveRevision: null,
    reasons: [...reasons, ...extraReasons].map(reason),
    requires,
    effectiveSources: [],
    sourceAvailability: availability,
  });

  // ── Stage 1: flags/mode (capability). Real cause, kept always. ──
  if (!facts.flags.effectiveEnabled) {
    reasons.push('Collection disabled');
    return blocked('unavailable', []);
  }
  if (facts.flags.mode === 'observe') {
    reasons.push('Observe mode — collection not scheduled');
    return blocked('unavailable', []);
  }
  if (facts.flags.mode === null) {
    reasons.push('Collection mode unknown');
    return blocked('unknown', []);
  }
  if (facts.flags.mode === 'manual') {
    reasons.push('Manual mode — operator action required');
  }

  // ── Stage 2: approval/binding. An existing pin wins; a corrupt pin never
  // falls through to another boundary. ──
  const gen = facts.generation;
  if (gen.bindingInvalid) {
    reasons.push('Strategy binding is invalid for this generation');
    return blocked('setup_attention', [], 'explicit_retry');
  }
  if (gen.bindingRetired) {
    reasons.push('Generation used retired brand routing settings');
    return blocked('setup_attention', [], 'explicit_retry');
  }
  if (gen.hasEvidenceWithoutBinding && !gen.hasBinding) {
    // Pre-builder/uncertain history: never stamp retrospectively.
    reasons.push('Generation has evidence without a strategy binding');
    return blocked('setup_attention', [], 'explicit_retry');
  }
  if (gen.hasBinding && gen.bindingMode === 'query_all') {
    // Query-all pins stay query-all even after a later approval (B1.1).
    reasons.push('Generation bound to query-all routing');
    return {
      path: 'compatibility',
      readiness: facts.collectionUnderway ? 'underway' : 'ready',
      canCollect: true,
      canExecuteNow: facts.scheduling.eligible && facts.scheduling.batchReleased && !facts.scheduling.claimedElsewhere,
      effectiveRevision: null,
      reasons: reasons.map(reason),
      requires: 'pinned_resume',
      effectiveSources: [],
      sourceAvailability: availability,
    };
  }
  if (gen.hasBinding && gen.bindingMode === 'legacy_advisory') {
    reasons.push('Generation used retired brand routing settings');
    return blocked('setup_attention', [], 'explicit_retry');
  }

  const hasApprovedPin =
    gen.hasBinding && gen.bindingMode === 'approved' && gen.bindingRevision !== null;
  if (hasApprovedPin && !gen.bindingBrandMatches) {
    // Pin/brand mismatch: prohibit resuming until explicit new-generation retry.
    reasons.push('Strategy binding brand does not match the item brand');
    return blocked('setup_attention', [], 'explicit_retry');
  }

  const approval = facts.approval;
  const liveApproval = approval !== null && approval.present && approval.brandMatches;

  // ── Stage 3: usability (no network probes; facts already loaded). ──
  if ((hasApprovedPin || liveApproval) && usable.length === 0) {
    // Ticket #125 (F11): entry-policy precedes usability. A protected
    // marker-v0 row with a live approval and zero usable sources is
    // compatibility history, never an approved_strategy claim — mirroring
    // the Stage 4 disposition exactly (no execution either way:
    // canCollect is false on both branches).
    if (!facts.entryPolicyCurrent) {
      reasons.push('Legacy item excluded from strategy routing');
      return {
        path: 'compatibility',
        readiness: 'unknown',
        canCollect: false,
        canExecuteNow: false,
        effectiveRevision: null,
        reasons: reasons.map(reason),
        requires: 'explicit_retry',
        effectiveSources: [],
        sourceAvailability: availability,
      };
    }
    const rev = hasApprovedPin ? gen.bindingRevision : (approval?.revision ?? null);
    reasons.push(
      rev !== null
        ? `Approved strategy revision ${rev} has no usable sources`
        : 'Approved strategy has no usable sources',
    );
    return {
      path: 'approved_strategy',
      readiness: 'setup_attention',
      canCollect: false,
      canExecuteNow: false,
      effectiveRevision: rev,
      reasons: reasons.map(reason),
      requires: 'none',
      effectiveSources: [],
      sourceAvailability: availability,
    };
  }

  // ── Stage 4: entry-policy v1 for the NEW path (protected rows → compat). ──
  if (!facts.entryPolicyCurrent) {
    reasons.push('Legacy item excluded from strategy routing');
    return {
      path: 'compatibility',
      readiness: 'unknown',
      canCollect: false,
      canExecuteNow: false,
      effectiveRevision: null,
      reasons: reasons.map(reason),
      requires: 'explicit_retry',
      effectiveSources: [],
      sourceAvailability: availability,
    };
  }

  // ── Stage 5: no-replay/scheduling. ──
  if (gen.hasTerminalOutcome) {
    reasons.push('Collection already completed for this generation');
    return {
      path: hasApprovedPin ? 'approved_strategy' : 'compatibility',
      readiness: 'underway',
      canCollect: false,
      canExecuteNow: false,
      effectiveRevision: hasApprovedPin ? gen.bindingRevision : null,
      reasons: reasons.map(reason),
      requires: 'none',
      effectiveSources: hasApprovedPin ? effectiveSources : [],
      sourceAvailability: availability,
    };
  }
  if (facts.scheduling.claimedElsewhere) {
    reasons.push('Work claimed by another run');
    return blocked('underway', []);
  }
  if (!facts.scheduling.eligible || !facts.scheduling.batchReleased) {
    reasons.push('Work not scheduled for collection');
    return blocked('unknown', []);
  }
  if (!facts.hasUsableIdentifier && (hasApprovedPin || liveApproval)) {
    // ACTIVATION-BLOCKER RULE: zero-identifier paths never leak outside an
    // approved boundary — park visibly inside it instead of falling through
    // to an unapproved fallback.
    reasons.push('Item has no UPC/GTIN for distributor lookup');
    return {
      path: 'approved_strategy',
      readiness: 'setup_attention',
      canCollect: false,
      canExecuteNow: false,
      effectiveRevision: hasApprovedPin ? gen.bindingRevision : (approval?.revision ?? null),
      reasons: reasons.map(reason),
      requires: 'none',
      effectiveSources: [],
      sourceAvailability: availability,
    };
  }

  // ── Approved path (pin wins; else fresh work with explicit live approval). ──
  if (hasApprovedPin) {
    const partial = usable.length < facts.sources.length;
    return {
      path: 'approved_strategy',
      readiness: facts.collectionUnderway ? 'underway' : partial ? 'ready_partial' : 'ready',
      canCollect: true,
      canExecuteNow: facts.flags.mode === 'automatic',
      effectiveRevision: gen.bindingRevision,
      reasons: reasons.map(reason),
      requires: 'pinned_resume',
      effectiveSources,
      sourceAvailability: availability,
    };
  }
  if (liveApproval) {
    const partial = usable.length < facts.sources.length;
    return {
      path: 'approved_strategy',
      readiness: facts.collectionUnderway ? 'underway' : partial ? 'ready_partial' : 'ready',
      canCollect: true,
      canExecuteNow: facts.flags.mode === 'automatic',
      effectiveRevision: approval.revision,
      reasons: reasons.map(reason),
      requires: 'fresh_capture',
      effectiveSources,
      sourceAvailability: availability,
    };
  }

  // Fresh unapproved work keeps B1.1 query-all compatibility (never an
  // approved readiness claim).
  reasons.push('Awaiting strategy approval');
  return {
    path: 'compatibility',
    readiness: 'awaiting_approval',
    canCollect: false,
    canExecuteNow: false,
    effectiveRevision: null,
    reasons: reasons.map(reason),
    requires: 'none',
    effectiveSources: [],
    sourceAvailability: availability,
  };
}

/**
 * Source-usability derivation beside the gate (Decision 8). Enabled
 * connection alone is insufficient — the engine also checks registry
 * support + required secrets + healthy official profiles. Pure.
 */
export function deriveSourceUsability(params: {
  sources: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  enabledDistributorIds: ReadonlySet<string>;
  supportedDistributorIds: ReadonlySet<string>;
  distributorsRequiringSecret: ReadonlySet<string>;
  distributorsWithSecret: ReadonlySet<string>;
  healthyOfficialDomains: ReadonlySet<string>;
}): ActivationSourceUsability[] {
  return params.sources.map((s) => {
    if (s.kind === 'distributor_record') {
      const id = s.distributorId ?? '';
      if (!params.enabledDistributorIds.has(id)) {
        return { kind: s.kind, ref: id, distributorId: id, usable: false, reason: 'Distributor connection not enabled' };
      }
      if (!params.supportedDistributorIds.has(id)) {
        return { kind: s.kind, ref: id, distributorId: id, usable: false, reason: 'Distributor connector not supported' };
      }
      if (params.distributorsRequiringSecret.has(id) && !params.distributorsWithSecret.has(id)) {
        return { kind: s.kind, ref: id, distributorId: id, usable: false, reason: 'Distributor credentials missing' };
      }
      return { kind: s.kind, ref: id, distributorId: id, usable: true, reason: 'Available' };
    }
    const domain = (s.domain ?? '').toLowerCase();
    if (!params.healthyOfficialDomains.has(domain)) {
      return { kind: s.kind, ref: domain, domain, usable: false, reason: 'Website profile needs setup' };
    }
    return { kind: s.kind, ref: domain, domain, usable: true, reason: 'Available' };
  });
}

/**
 * Copy ladder (Decision 6, exact). Textual, never color-only.
 */
export function activationCopy(decision: StrategyCollectionActivationDecision): string {
  const n = decision.sourceAvailability.filter((s) => s.usable).length;
  switch (decision.readiness) {
    case 'ready':
      return `Ready · ${n} source${n === 1 ? '' : 's'} available`;
    case 'ready_partial': {
      const needsSetup = decision.sourceAvailability
        .filter((s) => !s.usable && s.kind === 'official_page')
        .map((s) => s.ref)
        .join(', ');
      return needsSetup
        ? `Ready — partial · ${n} source${n === 1 ? '' : 's'} available; website needs setup`
        : `Ready — partial · ${n} source${n === 1 ? '' : 's'} available`;
    }
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'setup_attention':
      return 'Setup attention · No usable sources';
    case 'unknown':
      return decision.reasons.includes('Collection mode unknown')
        ? 'Loading collection readiness…'
        : 'Collection readiness unavailable · Retry';
    case 'unavailable':
      return decision.reasons[0] ?? 'Collection unavailable';
    case 'underway': {
      const rev = decision.effectiveRevision !== null ? ` approved revision ${decision.effectiveRevision}` : '';
      return `Underway · Collecting${rev}`;
    }
  }
}

export const ACTIVATION_READY_EXPLANATION =
  'Ready means collection can run. It does not guarantee a match, collected evidence, or sufficient listing information.';
