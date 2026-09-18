// T1 (#225) — Browser Investigation schema contract (Vitest, pure).
//
// Pins the workspace-scoped persistence contract: modes, lifecycle states,
// failure codes, budget defaults/bounds, domain normalization, and the
// untrusted-result envelope. No DB, no network, no provider imports.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INVESTIGATION_BUDGET,
  INVESTIGATION_RESULT_VERSION,
  InvestigationBudgetSchema,
  InvestigationFailureCodeSchema,
  InvestigationModeSchema,
  InvestigationRecordSchema,
  InvestigationRequestInputSchema,
  InvestigationResultSchema,
  isTerminalInvestigationStatus,
  normalizeInvestigationDomain,
  resolveInvestigationBudget,
} from '../../shared/schemas/browser-investigation';
import { canonicalJsonStringify } from '../../shared/stable-id';

describe('browser investigation schema contract', () => {
  it('accepts the two lifecycle modes only', () => {
    expect(InvestigationModeSchema.safeParse('domain_onboarding').success).toBe(true);
    expect(InvestigationModeSchema.safeParse('drift_repair').success).toBe(true);
    expect(InvestigationModeSchema.safeParse('per_sku_extract').success).toBe(false);
  });

  it('marks queued/running active and completed/failed/cancelled/discarded terminal', () => {
    expect(isTerminalInvestigationStatus('queued')).toBe(false);
    expect(isTerminalInvestigationStatus('running')).toBe(false);
    for (const s of ['completed', 'failed', 'cancelled', 'discarded'] as const) {
      expect(isTerminalInvestigationStatus(s)).toBe(true);
    }
  });

  it('applies the agreed default budget (5 pages, 20 reads, 8 calls, 10 min)', () => {
    const budget = resolveInvestigationBudget();
    expect(budget).toMatchObject({
      maxPages: 5,
      maxReads: 20,
      maxModelCalls: 8,
      timeoutMs: 10 * 60 * 1000,
    });
    expect(DEFAULT_INVESTIGATION_BUDGET).toMatchObject({ maxPages: 5, maxReads: 20, maxModelCalls: 8 });
  });

  it('bounds budgets above the agreed caps', () => {
    expect(InvestigationBudgetSchema.safeParse({ maxPages: 6 }).success).toBe(false);
    expect(InvestigationBudgetSchema.safeParse({ maxReads: 21 }).success).toBe(false);
    expect(InvestigationBudgetSchema.safeParse({ maxModelCalls: 9 }).success).toBe(false);
    expect(InvestigationBudgetSchema.safeParse({ timeoutMs: 11 * 60 * 1000 }).success).toBe(false);
  });

  it('bounds sample URLs to 1–5 representative pages', () => {
    const base = { domain: 'example.com', mode: 'domain_onboarding' as const };
    expect(
      InvestigationRequestInputSchema.safeParse({ ...base, sampleUrls: [] }).success,
    ).toBe(false);
    expect(
      InvestigationRequestInputSchema.safeParse({
        ...base,
        sampleUrls: ['https://example.com/1', 'https://example.com/2', 'https://example.com/3', 'https://example.com/4', 'https://example.com/5', 'https://example.com/6'],
      }).success,
    ).toBe(false);
    expect(
      InvestigationRequestInputSchema.safeParse({ ...base, sampleUrls: ['https://example.com/1'] }).success,
    ).toBe(true);
  });

  it('normalizes domains like the profile seam (lowercase, strip www)', () => {
    expect(normalizeInvestigationDomain('WWW.Example.COM ')).toBe('example.com');
    expect(normalizeInvestigationDomain('shop.example.com')).toBe('shop.example.com');
  });

  it('keeps failure codes operator-safe and stable', () => {
    for (const code of [
      'invalid_input',
      'budget_exhausted',
      'timeout',
      'provider_error',
      'malformed_result',
      'evidence_missing',
      'cancelled',
      'replay_rejected',
      'stale_completion',
      'isolation_unavailable',
      'cloud_disabled',
      'workspace_mismatch',
    ]) {
      expect(InvestigationFailureCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('requires a versioned untrusted result with at least one observation', () => {
    expect(
      InvestigationResultSchema.safeParse({ version: 999, summary: 'x', observations: [] }).success,
    ).toBe(false);
    const ok = InvestigationResultSchema.safeParse({
      version: INVESTIGATION_RESULT_VERSION,
      summary: 'fixture',
      observations: [
        { kind: 'k', sourceUrl: 'https://example.com/p', artifactHash: 'abcdef1234567890', incomplete: false },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('produces stable canonical JSON for input-hash binding', () => {
    const a = canonicalJsonStringify({ b: 1, a: [1, 2, { d: 4, c: 3 }] });
    const b = canonicalJsonStringify({ a: [1, 2, { c: 3, d: 4 }], b: 1 });
    expect(a).toBe(b);
  });

  it('requires the full persistence envelope on records', () => {
    const parsed = InvestigationRecordSchema.safeParse({ id: 'x' });
    expect(parsed.success).toBe(false);
  });
});
