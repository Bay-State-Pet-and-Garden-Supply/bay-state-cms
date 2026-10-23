/**
 * Minimal test-only seam for issue #366 behavioral assertions.
 * Re-exports the aggregate + record shapes the suite needs without
 * reaching into service internals.
 */
import type { ListingEvidenceClaim } from '../../../shared/schemas/onboarding';

export function aggregateStatusForTest(
  records: ListingEvidenceClaim[],
  overflow: boolean,
): 'passed' | 'blocked' | 'unavailable' {
  if (overflow) return 'unavailable';
  if (records.length === 0) return 'passed';
  let hasUnavailable = false;
  let hasInsufficient = false;
  for (const record of records) {
    if (!record.material) continue;
    if (record.verdict === 'contradicted') return 'blocked';
    if (record.verdict === 'unavailable' || record.verdict === 'stale') hasUnavailable = true;
    if (record.verdict === 'insufficient') hasInsufficient = true;
  }
  if (hasUnavailable) return 'unavailable';
  if (hasInsufficient) return 'blocked';
  return 'passed';
}

export function buildRecord(overrides: Partial<ListingEvidenceClaim> & { field: ListingEvidenceClaim['field']; text: string; verdict: ListingEvidenceClaim['verdict'] }): ListingEvidenceClaim {
  return {
    id: 'claim_01',
    span: [0, overrides.text.length],
    claimHash: 'a'.repeat(64),
    material: true,
    producer: 'deterministic',
    evidenceConsidered: [],
    modelCallId: null,
    reason: 'test',
    ...overrides,
  };
}
