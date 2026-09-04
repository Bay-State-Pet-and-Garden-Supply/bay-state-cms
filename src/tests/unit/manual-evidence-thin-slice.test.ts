// Ticket #103 (parent #101) — thin manual-evidence slice, pure unit lane (vitest).
// Test-first: helpers for profile-blocked detection, identity derivation,
// eligibility, and Needs Attention mapping for the manual-evidence route.
import { describe, test, expect } from 'vitest';
import {
  isManualEvidenceProfileBlockedError,
  deriveManualEvidenceIdentityStatus,
  isManualEvidenceEligible,
  resolveManualEvidenceDomain,
} from '../../onboarding/manual-evidence-eligibility';
import {
  getAttentionActions,
  getAttentionActionConsequence,
  getAttentionActionLabel,
  getAttentionConsequence,
} from '../../client/components/onboarding/attention/attention-logic';

describe('profile-blocked detection (fail-closed signature)', () => {
  test('matches the worker missing-profile signature', () => {
    expect(isManualEvidenceProfileBlockedError('No extractor profile for butcherspup.example.com')).toBe(true);
  });

  test('rejects other failure shapes, empty, and null', () => {
    expect(isManualEvidenceProfileBlockedError('HTTP 500 from brand site')).toBe(false);
    expect(isManualEvidenceProfileBlockedError('')).toBe(false);
    expect(isManualEvidenceProfileBlockedError(null)).toBe(false);
    expect(isManualEvidenceProfileBlockedError(undefined)).toBe(false);
  });
});

describe('manual identity derivation (never exact)', () => {
  test('family reference attached → parent_product_only', () => {
    expect(deriveManualEvidenceIdentityStatus(true)).toBe('parent_product_only');
  });

  test('no reference → insufficient_evidence', () => {
    expect(deriveManualEvidenceIdentityStatus(false)).toBe('insufficient_evidence');
  });
});

describe('manual-evidence eligibility (extraction/failed only)', () => {
  test('profile-blocked extraction failure is eligible', () => {
    expect(
      isManualEvidenceEligible({
        stage: 'extraction',
        stageStatus: 'failed',
        errorMessage: 'No extractor profile for butcherspup.example.com',
        familyPageOnlyConfirmed: false,
      }),
    ).toBe(true);
  });

  test('non-profile failure requires explicit family-page-only triage', () => {
    expect(
      isManualEvidenceEligible({
        stage: 'extraction',
        stageStatus: 'failed',
        errorMessage: 'HTTP timeout',
        familyPageOnlyConfirmed: false,
      }),
    ).toBe(false);
    expect(
      isManualEvidenceEligible({
        stage: 'extraction',
        stageStatus: 'failed',
        errorMessage: 'HTTP timeout',
        familyPageOnlyConfirmed: true,
      }),
    ).toBe(true);
  });

  test('sourcing, discovery, and never-attempted items are never eligible', () => {
    expect(
      isManualEvidenceEligible({ stage: 'sourcing', stageStatus: 'failed', errorMessage: 'No extractor profile for x.example', familyPageOnlyConfirmed: false }),
    ).toBe(false);
    expect(
      isManualEvidenceEligible({ stage: 'discovery', stageStatus: 'failed', errorMessage: 'No extractor profile for x.example', familyPageOnlyConfirmed: false }),
    ).toBe(false);
    expect(
      isManualEvidenceEligible({ stage: 'extraction', stageStatus: 'pending', errorMessage: null, familyPageOnlyConfirmed: false }),
    ).toBe(false);
    expect(
      isManualEvidenceEligible({ stage: 'extraction', stageStatus: 'completed', errorMessage: null, familyPageOnlyConfirmed: false }),
    ).toBe(false);
  });
});

describe('manual-evidence domain resolution (profile re-check)', () => {
  test('prefers the item source URL host', () => {
    expect(
      resolveManualEvidenceDomain(
        { sourceUrl: 'https://shop.butcherspup.example.com/family', errorMessage: 'No extractor profile for butcherspup.example.com' },
        null,
      ),
    ).toBe('shop.butcherspup.example.com');
  });

  test('falls back to the family reference host, then the error token', () => {
    expect(
      resolveManualEvidenceDomain({ sourceUrl: null, errorMessage: 'HTTP timeout' }, 'https://butcherspup.example.com/family-treats'),
    ).toBe('butcherspup.example.com');
    expect(
      resolveManualEvidenceDomain({ sourceUrl: null, errorMessage: 'No extractor profile for butcherspup.example.com' }, null),
    ).toBe('butcherspup.example.com');
  });

  test('returns null when no domain can be resolved', () => {
    expect(resolveManualEvidenceDomain({ sourceUrl: null, errorMessage: 'HTTP timeout' }, null)).toBe(null);
  });
});

describe('Needs Attention mapping for manual-evidence-eligible items', () => {
  test('manual reason offers the explicit manual action first', () => {
    expect(getAttentionActions('manual_evidence_available')).toEqual(['enter_manual_evidence']);
  });

  test('manual action and reason carry reference-only copy', () => {
    expect(getAttentionActionLabel('enter_manual_evidence')).toMatch(/manual/i);
    expect(getAttentionActionConsequence('enter_manual_evidence')).toMatch(/attestation/i);
    expect(getAttentionConsequence('manual_evidence_available')).toMatch(/reference only/i);
  });
});
