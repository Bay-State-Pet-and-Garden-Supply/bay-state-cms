// T4 (#228) — non-waivable blind-holdout gate for investigation-derived policies.
//
// An investigation-derived version requires passed production-worker
// validation AND at least one passing blind holdout. The
// confirmation-count waiver excuses only the confirmation count — never
// validation or holdout independence. Legacy (non-derived) versions are
// unaffected. Pure `evaluateGate` assertions (vitest, no DB).

import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../../onboarding/profile-activation-gate';

function healthyBase() {
  return {
    requiredResults: [
      { field: 'title', success: true },
      { field: 'title', success: true },
      { field: 'title', success: true },
    ],
    wrongProduct: false,
    wrongVariant: false,
    waiver: false,
    confirmedCount: 3,
    imageRuleOk: true as const,
  };
}

describe('non-waivable blind-holdout gate (T4)', () => {
  it('legacy versions are unaffected by the investigation bar', () => {
    expect(evaluateGate(healthyBase()).allowed).toBe(true);
  });

  it('blocks investigation-derived versions without passed validation', () => {
    const r = evaluateGate({ ...healthyBase(), investigationDerived: true, policyValidationStatus: 'failed', holdoutPassedCount: 2 });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('validation_not_passed');
  });

  it('blocks investigation-derived versions with missing validation', () => {
    const r = evaluateGate({ ...healthyBase(), investigationDerived: true, holdoutPassedCount: 2 });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('validation_not_passed');
  });

  it('blocks passed validation without a passing blind holdout', () => {
    const r = evaluateGate({ ...healthyBase(), investigationDerived: true, policyValidationStatus: 'passed', holdoutPassedCount: 0 });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('missing_blind_holdout');
  });

  it('allows passed validation with a passing blind holdout', () => {
    const r = evaluateGate({ ...healthyBase(), investigationDerived: true, policyValidationStatus: 'passed', holdoutPassedCount: 1 });
    expect(r.allowed).toBe(true);
  });

  it('the confirmation-count waiver cannot waive validation or holdouts', () => {
    const r = evaluateGate({
      ...healthyBase(),
      waiver: true,
      confirmedCount: 1,
      investigationDerived: true,
      policyValidationStatus: 'incomplete',
      holdoutPassedCount: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('validation_not_passed');
    const holdout = evaluateGate({
      ...healthyBase(),
      waiver: true,
      confirmedCount: 1,
      investigationDerived: true,
      policyValidationStatus: 'passed',
      holdoutPassedCount: 0,
    });
    expect(holdout.allowed).toBe(false);
    expect(holdout.blockReason).toBe('missing_blind_holdout');
  });
});
