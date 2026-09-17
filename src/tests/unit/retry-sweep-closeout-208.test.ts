// Issue #208 — retry sweep + observability close-out tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: gates, release eligibility, extraction evidence — never internals):
// every mechanism domain carries a per-domain observability record, the
// selected-retry sweep admits only eligible items (mirroring the #198
// route codes) with every ineligible item carrying a reason, the
// previously completed / in-review / skipped cohorts verify untouched
// against the live observed counts, and the parent close-out note states
// what unblocked what plus what remains. No network, no DB.
import { describe, it, expect } from 'vitest';
import {
  CLOSEOUT_208_DOMAINS,
  CLOSEOUT_NOTE_208,
  DOMAIN_LEDGER_208,
  LEDGER_208_TOTAL_ITEMS,
  LEDGER_208_TOTAL_LLM_TOKENS,
  LIVE_SNAPSHOT_208,
  SCOPE_RECONCILIATION_208,
  ledger208ByDomain,
  sweepEligibility208,
  verifyUntouched208,
  type IneligibleCohort208,
  type SweepMechanism208,
} from '../../onboarding/brand-hub/retry-sweep-closeout-208';

const MECHANISMS: readonly SweepMechanism208[] = [
  'static_structured_profile',
  'single_ai_draft',
  'full_ai_draft',
  'shopify_minimal_profile',
  'static_validation_followup',
  'distributor_manual_blocked',
];

describe('issue #208 per-domain ledger (acceptance: mechanism, evidence, activation, cost, failure codes)', () => {
  it('covers exactly the 14 mechanism domains with no overlap', () => {
    expect(new Set(CLOSEOUT_208_DOMAINS).size).toBe(14);
    expect(DOMAIN_LEDGER_208).toHaveLength(14);
    for (const d of [
      'bonide.com',
      'www.nylabone.com',
      'www.bluebuffalo.com',
      'discovernutrisource.com',
      'openfarmpet.com',
      'snifsnax.com',
      'jollypets.com',
      'www.wondercide.com',
      'horsemenspride.com',
      'bil-jac.com',
      'northstatesind.com',
      'yeowww.com',
      'chickensouppets.com',
      'multipet.com',
    ]) {
      expect(ledger208ByDomain(d), `missing ledger record for ${d}`).toBeDefined();
    }
  });

  it('every record states a taxonomy mechanism, validation evidence, activation basis, cost, and failure codes', () => {
    for (const r of DOMAIN_LEDGER_208) {
      expect(MECHANISMS).toContain(r.mechanism);
      expect(r.ticket.length).toBeGreaterThan(0);
      expect(r.validationEvidence.length).toBeGreaterThan(40);
      expect(r.activationConfirmations).toBeGreaterThanOrEqual(0);
      expect(typeof r.activationWaiver).toBe('boolean');
      // Cost is always recorded (story 13) — zero where no metered
      // generation ran, distinguishing hand drafts from LLM spend.
      expect(r.llmTokens).toBeGreaterThanOrEqual(0);
      expect(r.costNote.length).toBeGreaterThan(20);
      expect(r.releasePath.length).toBeGreaterThan(20);
    }
  });

  it('ticket-scoped items sum to 70 (5+5+7+53+0) with walled domains at zero', () => {
    const total = DOMAIN_LEDGER_208.reduce((n, r) => n + r.items, 0);
    expect(total).toBe(70);
    // The ledger totals are consumed here so the closeout record — not a
    // recomputation — is the single source for the headline counts.
    expect(LEDGER_208_TOTAL_ITEMS).toBe(total);
    for (const d of ['bil-jac.com', 'northstatesind.com', 'yeowww.com', 'chickensouppets.com', 'multipet.com']) {
      expect(ledger208ByDomain(d)!.items).toBe(0);
    }
  });

  it('metered LLM spend is zero across the scale-up (every draft hand-authored)', () => {
    const totalTokens = DOMAIN_LEDGER_208.reduce((n, r) => n + r.llmTokens, 0);
    expect(totalTokens).toBe(0);
    expect(LEDGER_208_TOTAL_LLM_TOKENS).toBe(totalTokens);
  });

  it('profile mechanisms satisfy the confirmation rule on evidence with no waivers', () => {
    for (const r of DOMAIN_LEDGER_208.filter((e) =>
      ['static_structured_profile', 'single_ai_draft', 'full_ai_draft', 'shopify_minimal_profile'].includes(e.mechanism),
    )) {
      expect(r.activationConfirmations).toBeGreaterThanOrEqual(3);
      expect(r.activationWaiver).toBe(false);
    }
  });

  it('records the observed failure codes: clean nulls plus fail-closed variant gates, never a bare title-only pass', () => {
    const bonide = ledger208ByDomain('bonide.com')!;
    expect(bonide.failureCodesSeen).toContain('variant_selection_required');
    const shopify = DOMAIN_LEDGER_208.filter((r) => r.mechanism === 'shopify_minimal_profile');
    expect(shopify).toHaveLength(6);
    for (const r of shopify) expect(r.failureCodesSeen).toContain(null);
  });
});

describe('issue #208 selected-retry sweep (acceptance: eligible retried, ineligible listed with reasons)', () => {
  const eligibleBase = {
    stage: 'collect_details',
    stageStatus: 'failed',
    ownWorkspace: true,
    hasActiveManualEvidence: false,
    urlVerdict: 'confirmed_clean' as const,
  };

  it('admits only failed-extraction + own workspace + no manual evidence + validated-clean URL', () => {
    const res = sweepEligibility208(eligibleBase);
    expect(res.eligible).toBe(true);
    expect(res.reason.startsWith('eligible')).toBe(true);
  });

  it('refuses foreign-workspace items before any other check (route 404)', () => {
    const res = sweepEligibility208({ ...eligibleBase, ownWorkspace: false });
    expect(res.eligible).toBe(false);
    expect(res.reason.startsWith('foreign_workspace')).toBe(true);
  });

  it('refuses manual-evidence-active items with withdraw-first precedence (route 409 exact code)', () => {
    const res = sweepEligibility208({ ...eligibleBase, hasActiveManualEvidence: true });
    expect(res.eligible).toBe(false);
    expect(res.reason.startsWith('manual_evidence_active_retry_rejected')).toBe(true);
  });

  it('refuses non-extraction stages and non-failed statuses with the route codes', () => {
    expect(sweepEligibility208({ ...eligibleBase, stage: 'route_sources' }).reason.startsWith('retry_ineligible_stage')).toBe(true);
    expect(sweepEligibility208({ ...eligibleBase, stageStatus: 'pending' }).reason.startsWith('retry_ineligible_status')).toBe(true);
    for (const bad of [
      { ...eligibleBase, stage: 'route_sources' },
      { ...eligibleBase, stageStatus: 'pending' },
    ]) {
      expect(sweepEligibility208(bad).eligible).toBe(false);
    }
  });

  it('holds variant-blocked, unvalidated, and discontinued URLs out of the sweep', () => {
    expect(sweepEligibility208({ ...eligibleBase, urlVerdict: 'variant_blocked' }).reason.startsWith('variant_resolution_required')).toBe(true);
    expect(sweepEligibility208({ ...eligibleBase, urlVerdict: 'unvalidated_url' }).reason.startsWith('unvalidated_url')).toBe(true);
    // Discontinued reuses #204's verbatim mechanism code (fidelity-tested against selectiveReleaseEligibility204).
    expect(sweepEligibility208({ ...eligibleBase, urlVerdict: 'discontinued' }).reason.startsWith('wrong_product')).toBe(true);
  });

  it('live snapshot: zero eligible, zero retried — 130 items all ineligible-with-reason, none silently skipped', () => {
    expect(LIVE_SNAPSHOT_208.eligible).toBe(0);
    expect(LIVE_SNAPSHOT_208.retried).toBe(0);
    const accounted =
      LIVE_SNAPSHOT_208.routeSourcesPending +
      LIVE_SNAPSHOT_208.reviewNeedsInput +
      LIVE_SNAPSHOT_208.reviewSkipped +
      LIVE_SNAPSHOT_208.draftsCompleted;
    expect(accounted).toBe(LIVE_SNAPSHOT_208.totalItems);
    expect(LIVE_SNAPSHOT_208.totalItems).toBe(130);
    // Typed through the ineligible-cohort record so every cohort carries
    // its refusal reason (acceptance: listed, not silently skipped).
    const ineligible: readonly IneligibleCohort208[] = LIVE_SNAPSHOT_208.ineligibleList;
    for (const entry of ineligible) {
      expect(entry.cohort.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.count).toBeGreaterThan(0);
    }
  });
});

describe('issue #208 backlog scope (acceptance: no item silently skipped)', () => {
  it('reconciles the 89 pending rows: 86 #197-inventory items plus 3 out-of-scope Kong rows', () => {
    expect(SCOPE_RECONCILIATION_208).toContain('86');
    expect(SCOPE_RECONCILIATION_208).toContain('Kong');
    expect(LIVE_SNAPSHOT_208.routeSourcesPending).toBe(89);
    // 34 #199 + 35 #207-as-written + 5 #204 + 5 #205 + 7 #206 = 86; +3 Kong = 89.
    expect(34 + 35 + 5 + 5 + 7 + 3).toBe(89);
  });
});

describe('issue #208 untouched cohorts (acceptance: completed / in-review / skipped verified untouched)', () => {
  it('verifies the live observed counts 28 / 8 / 5 with no drift', () => {
    expect(verifyUntouched208({ completed: 28, inReview: 8, skipped: 5 })).toEqual([]);
  });

  it('fails loudly on any drift instead of silently passing', () => {
    expect(verifyUntouched208({ completed: 27, inReview: 8, skipped: 5 }).length).toBeGreaterThan(0);
    expect(verifyUntouched208({ completed: 28, inReview: 9, skipped: 5 }).length).toBeGreaterThan(0);
    expect(verifyUntouched208({ completed: 28, inReview: 8, skipped: 4 }).length).toBeGreaterThan(0);
  });
});

describe('issue #208 parent close-out note (acceptance: what unblocked what, what remains)', () => {
  it('names every mechanism outcome and the remaining operator work', () => {
    for (const token of ['Bonide', 'Nylabone', 'Blue Buffalo', 'Shopify', 'walled', 'Nutrisource', 'operator']) {
      expect(CLOSEOUT_NOTE_208, `close-out note missing "${token}"`).toContain(token);
    }
    expect(CLOSEOUT_NOTE_208.length).toBeGreaterThan(400);
  });
});
