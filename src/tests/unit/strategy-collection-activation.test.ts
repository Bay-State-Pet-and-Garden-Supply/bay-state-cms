/**
 * Ticket #125 — activation gate truth table (Decision 8).
 *
 * Pure gate: no DB, no network. Covers the ordered evaluation, the
 * compatibility disposition (never a global block of unapproved rows),
 * the corrupt-pin fail-closed rule, zero-vs-partial usability, modes,
 * brand/generation mismatches, and the copy ladder.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateStrategyCollectionActivation,
  deriveSourceUsability,
  activationCopy,
  ACTIVATION_READY_EXPLANATION,
  type StrategyCollectionActivationFacts,
} from '../../onboarding/strategy-collection-activation';

function base(): StrategyCollectionActivationFacts {
  return {
    flags: { effectiveEnabled: true, mode: 'automatic' },
    hasUsableIdentifier: true,
    entryPolicyCurrent: true,
    scheduling: { eligible: true, claimedElsewhere: false, batchReleased: true },
    generation: {
      isFresh: true,
      hasTerminalOutcome: false,
      hasEvidenceWithoutBinding: false,
      hasBinding: false,
      bindingInvalid: false,
      bindingRetired: false,
      bindingMode: null,
      bindingBrandMatches: true,
      bindingRevision: null,
    },
    approval: null,
    sources: [
      { kind: 'distributor_record', ref: 'phillips', distributorId: 'phillips', usable: true, reason: 'Available' },
      { kind: 'distributor_record', ref: 'bci', distributorId: 'bci', usable: true, reason: 'Available' },
    ],
    collectionUnderway: false,
  };
}

describe('activation gate: capability stage', () => {
  it('disabled flags block with the real cause', () => {
    const f = base();
    f.flags = { effectiveEnabled: false, mode: null };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.readiness).toBe('unavailable');
    expect(d.reasons).toContain('Collection disabled');
    expect(d.canCollect).toBe(false);
  });

  it('observe mode blocks without manufacturing another state', () => {
    const f = base();
    f.flags = { effectiveEnabled: true, mode: 'observe' };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.reasons).toContain('Observe mode — collection not scheduled');
  });

  it('manual mode keeps the real cause in reasons on the approved path', () => {
    const f = base();
    f.flags = { effectiveEnabled: true, mode: 'manual' };
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('approved_strategy');
    expect(d.requires).toBe('fresh_capture');
    expect(d.canExecuteNow).toBe(false);
    expect(d.reasons).toContain('Manual mode — operator action required');
  });

  it('unknown mode is Loading, never readiness success or failure (F6)', () => {
    // flags.mode null (unparseable/absent): the gate reports unknown and
    // the copy ladder renders Loading — unknown data is never an empty
    // approved plan and never readiness success.
    const f = base();
    f.flags = { effectiveEnabled: true, mode: null };
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.readiness).toBe('unknown');
    expect(d.canCollect).toBe(false);
    expect(d.reasons).toContain('Collection mode unknown');
    expect(activationCopy(d)).toBe('Loading collection readiness…');
  });

  it('disabled flags with unknown mode stay unavailable with the real cause (F6)', () => {
    const f = base();
    f.flags = { effectiveEnabled: false, mode: null };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.readiness).toBe('unavailable');
    expect(d.reasons).toContain('Collection disabled');
    expect(activationCopy(d)).toBe('Collection disabled');
  });
});

describe('activation gate: approval/binding stage', () => {
  it('corrupt pins fail closed and never fall through', () => {
    const f = base();
    f.generation.hasBinding = true;
    f.generation.bindingInvalid = true;
    f.approval = { present: true, revision: 2, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.requires).toBe('explicit_retry');
  });

  it('retired bindings require explicit retry', () => {
    const f = base();
    f.generation.hasBinding = true;
    f.generation.bindingRetired = true;
    f.generation.bindingMode = 'legacy_advisory';
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.requires).toBe('explicit_retry');
  });

  it('evidence without binding is uncertain history, never stamped', () => {
    const f = base();
    f.generation.hasEvidenceWithoutBinding = true;
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.requires).toBe('explicit_retry');
  });

  it('query-all pins stay query-all even after a later approval', () => {
    const f = base();
    f.generation.hasBinding = true;
    f.generation.bindingMode = 'query_all';
    f.approval = { present: true, revision: 3, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('compatibility');
    expect(d.effectiveRevision).toBeNull();
    expect(d.requires).toBe('pinned_resume');
  });

  it('pin/brand mismatch prohibits resume until explicit retry', () => {
    const f = base();
    f.generation.hasBinding = true;
    f.generation.bindingMode = 'approved';
    f.generation.bindingRevision = 1;
    f.generation.bindingBrandMatches = false;
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('blocked');
    expect(d.requires).toBe('explicit_retry');
  });
});

describe('activation gate: approved path and usability', () => {
  it('approved pin with all usable sources is ready with pinned resume', () => {
    const f = base();
    f.generation.isFresh = false;
    f.generation.hasBinding = true;
    f.generation.bindingMode = 'approved';
    f.generation.bindingRevision = 2;
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('approved_strategy');
    expect(d.readiness).toBe('ready');
    expect(d.canCollect).toBe(true);
    expect(d.canExecuteNow).toBe(true);
    expect(d.effectiveRevision).toBe(2);
    expect(d.requires).toBe('pinned_resume');
    expect(activationCopy(d)).toBe('Ready · 2 sources available');
  });

  it('fresh work with live approval captures fresh, partial when a leg is down', () => {
    const f = base();
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    f.sources = [
      { kind: 'distributor_record', ref: 'phillips', distributorId: 'phillips', usable: true, reason: 'Available' },
      { kind: 'official_page', ref: 'acana.com', domain: 'acana.com', usable: false, reason: 'Website profile needs setup' },
    ];
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('approved_strategy');
    expect(d.readiness).toBe('ready_partial');
    expect(d.requires).toBe('fresh_capture');
    expect(activationCopy(d)).toBe('Ready — partial · 1 source available; website needs setup');
  });

  it('zero usable sources on an approved boundary is setup attention, never a fallback', () => {
    const f = base();
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    f.sources = [
      { kind: 'distributor_record', ref: 'phillips', distributorId: 'phillips', usable: false, reason: 'Distributor connection not enabled' },
    ];
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('approved_strategy');
    expect(d.readiness).toBe('setup_attention');
    expect(d.canCollect).toBe(false);
    expect(activationCopy(d)).toBe('Setup attention · No usable sources');
  });

  it('zero-identifier items park inside the approved boundary (activation-blocker rule)', () => {
    const f = base();
    f.hasUsableIdentifier = false;
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('approved_strategy');
    expect(d.readiness).toBe('setup_attention');
    expect(d.canCollect).toBe(false);
    expect(d.reasons).toContain('Item has no UPC/GTIN for distributor lookup');
  });

  it('fresh unapproved work is compatibility/awaiting, never approved readiness', () => {
    const d = evaluateStrategyCollectionActivation(base());
    expect(d.path).toBe('compatibility');
    expect(d.readiness).toBe('awaiting_approval');
    expect(d.canCollect).toBe(false);
    expect(activationCopy(d)).toBe('Awaiting approval');
  });

  it('protected marker-v0 rows get a compatibility disposition, not a global block', () => {
    const f = base();
    f.entryPolicyCurrent = false;
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('compatibility');
    expect(d.requires).toBe('explicit_retry');
  });

  it('protected marker-v0 rows with zero usable sources stay compatibility (F11)', () => {
    // Ordering edge: usability (Stage 3) precedes entry-policy (Stage 4).
    // A marker-v0 row with a live approval but no usable source must not
    // claim approved_strategy/setup_attention — it is compatibility
    // history with the exact Stage 4 disposition.
    const f = base();
    f.entryPolicyCurrent = false;
    f.approval = { present: true, revision: 1, normalizedBrand: 'acana', brandMatches: true };
    f.sources = [
      { kind: 'distributor_record', ref: 'phillips', distributorId: 'phillips', usable: false, reason: 'Distributor connection not enabled' },
    ];
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('compatibility');
    expect(d.readiness).toBe('unknown');
    expect(d.requires).toBe('explicit_retry');
    expect(d.canCollect).toBe(false);
    expect(d.effectiveRevision).toBeNull();
    expect(d.reasons).toContain('Legacy item excluded from strategy routing');
  });

  it('terminal outcomes never replay', () => {
    const f = base();
    f.generation.hasTerminalOutcome = true;
    f.generation.hasBinding = true;
    f.generation.bindingMode = 'approved';
    f.generation.bindingRevision = 1;
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.canCollect).toBe(false);
    expect(d.canExecuteNow).toBe(false);
  });
});

describe('activation gate: pins win over later approvals', () => {
  it('revision-1 pin resumes after a revision-2 approval without recapture', () => {
    const f = base();
    f.generation.isFresh = false;
    f.generation.hasBinding = true;
    f.generation.bindingMode = 'approved';
    f.generation.bindingRevision = 1;
    f.approval = { present: true, revision: 2, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.path).toBe('approved_strategy');
    expect(d.effectiveRevision).toBe(1);
    expect(d.requires).toBe('pinned_resume');
  });

  it('a new retry without a pin captures the latest approval fresh', () => {
    const f = base();
    f.approval = { present: true, revision: 2, normalizedBrand: 'acana', brandMatches: true };
    const d = evaluateStrategyCollectionActivation(f);
    expect(d.effectiveRevision).toBe(2);
    expect(d.requires).toBe('fresh_capture');
  });
});

describe('activation gate: source usability derivation', () => {
  it('enabled connection alone is insufficient (support + secret + profile)', () => {
    const sources = [
      { kind: 'distributor_record' as const, distributorId: 'phillips' },
      { kind: 'distributor_record' as const, distributorId: 'mystery' },
      { kind: 'distributor_record' as const, distributorId: 'secretless' },
      { kind: 'official_page' as const, domain: 'Acana.COM' },
    ];
    const out = deriveSourceUsability({
      sources,
      enabledDistributorIds: new Set(['phillips', 'mystery', 'secretless']),
      supportedDistributorIds: new Set(['phillips', 'secretless']),
      distributorsRequiringSecret: new Set(['secretless']),
      distributorsWithSecret: new Set(),
      healthyOfficialDomains: new Set(),
    });
    expect(out.find((s) => s.ref === 'phillips')?.usable).toBe(true);
    expect(out.find((s) => s.ref === 'mystery')?.reason).toBe('Distributor connector not supported');
    expect(out.find((s) => s.ref === 'secretless')?.reason).toBe('Distributor credentials missing');
    expect(out.find((s) => s.ref === 'acana.com')?.reason).toBe('Website profile needs setup');
  });

  it('remediation invariant: distributor reasons never demand domain/profile work (F3)', () => {
    // Operator remediation mapping (pinned wording): distributor reasons
    // name the connection/secret surface, never domain/profile setup —
    // only the official_page reason may send the operator to the Profile
    // Builder. This keeps setup attention actionable and prevents a
    // distributor-only brand from ever reading as a domain problem.
    const out = deriveSourceUsability({
      sources: [
        { kind: 'distributor_record' as const, distributorId: 'disabled_conn' },
        { kind: 'distributor_record' as const, distributorId: 'mystery' },
        { kind: 'distributor_record' as const, distributorId: 'secretless' },
        { kind: 'official_page' as const, domain: 'Acme.com' },
      ],
      enabledDistributorIds: new Set(['mystery', 'secretless']),
      supportedDistributorIds: new Set(['disabled_conn', 'secretless']),
      distributorsRequiringSecret: new Set(['secretless']),
      distributorsWithSecret: new Set(),
      healthyOfficialDomains: new Set(),
    });
    const byRef = new Map(out.map((s) => [s.ref, s]));
    expect(byRef.get('disabled_conn')?.reason).toBe('Distributor connection not enabled');
    expect(byRef.get('mystery')?.reason).toBe('Distributor connector not supported');
    expect(byRef.get('secretless')?.reason).toBe('Distributor credentials missing');
    expect(byRef.get('acme.com')?.reason).toBe('Website profile needs setup');
    for (const s of out) {
      if (s.kind === 'distributor_record') {
        expect(s.reason).not.toMatch(/domain|profile/i);
      } else {
        expect(s.reason).not.toMatch(/distributor|credential|connection/i);
      }
    }
  });
});

describe('activation gate: copy ladder', () => {
  it('every readiness has exact copy; Ready carries the persistent explanation', () => {
    expect(ACTIVATION_READY_EXPLANATION).toMatch(/does not guarantee a match/);
    const f = base();
    f.generation.hasBinding = true;
    f.generation.bindingMode = 'approved';
    f.generation.bindingRevision = 7;
    f.collectionUnderway = true;
    const d = evaluateStrategyCollectionActivation(f);
    expect(activationCopy(d)).toBe('Underway · Collecting approved revision 7');
  });
});
